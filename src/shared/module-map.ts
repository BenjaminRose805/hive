/**
 * Module map system — resolves file paths to module ownership.
 * Reads .hive/modules.json and provides lookup + validation.
 *
 * Design: decision/module-map-schema by atlas (Phase 3).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { HIVE_DIR } from "./paths.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface ModuleDefinition {
  owner: string;
  files: string[];
  description?: string;
}

export interface ModuleMapConfig {
  version: 1;
  unassigned_owner: string;
  shared: string[];
  modules: Record<string, ModuleDefinition>;
}

export type LookupResult =
  | { kind: "owned"; module: string; owner: string; pattern: string }
  | { kind: "shared"; pattern: string }
  | { kind: "unassigned"; fallback_owner: string };

// ── Glob matching (mirrors hooks/check-scope.mjs) ─────────────────────

/**
 * Convert a glob pattern to a RegExp.
 * Supports **, *, ? patterns. No brace expansion.
 */
export function globToRegex(pattern: string): RegExp {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex metacharacters (except * and ?)
    .replace(/\*\*/g, "{{GLOBSTAR}}")       // Placeholder for **
    .replace(/\*/g, "[^/]*")                // * matches anything except /
    .replace(/\?/g, "[^/]")                 // ? matches single char except /
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");    // ** matches everything including /
  return new RegExp(`^${regex}$`);
}

// ── Compiled cache for hot-path usage ─────────────────────────────────

interface CompiledModule {
  name: string;
  owner: string;
  patterns: { glob: string; regex: RegExp }[];
}

interface CompiledMap {
  sharedPatterns: { glob: string; regex: RegExp }[];
  modules: CompiledModule[];
  unassigned_owner: string;
}

let compiledCache: { path: string; mtime: number; compiled: CompiledMap } | null = null;

function compileModuleMap(config: ModuleMapConfig): CompiledMap {
  return {
    sharedPatterns: config.shared.map((g) => ({ glob: g, regex: globToRegex(g) })),
    modules: Object.entries(config.modules).map(([name, def]) => ({
      name,
      owner: def.owner,
      patterns: def.files.map((g) => ({ glob: g, regex: globToRegex(g) })),
    })),
    unassigned_owner: config.unassigned_owner,
  };
}

function getCompiled(config: ModuleMapConfig, modulesPath: string): CompiledMap {
  let mtime = 0;
  try {
    const stat = Bun.file(modulesPath);
    // Use lastModified if available — falls back to 0 (always recompile)
    mtime = stat.lastModified ?? 0;
  } catch {
    // File stat failed — recompile
  }

  if (compiledCache && compiledCache.path === modulesPath && compiledCache.mtime === mtime) {
    return compiledCache.compiled;
  }

  const compiled = compileModuleMap(config);
  compiledCache = { path: modulesPath, mtime, compiled };
  return compiled;
}

// ── Validation ─────────────────────────────────────────────────────────

const MODULE_NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate the module map config structure.
 * Returns an array of errors (empty = valid).
 */
export function validateModuleMapStructure(config: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!config || typeof config !== "object") {
    errors.push({ field: "root", message: "Config must be a non-null object" });
    return errors;
  }

  const c = config as Record<string, unknown>;

  if (c.version !== 1) {
    errors.push({ field: "version", message: "version must equal 1" });
  }

  if (typeof c.unassigned_owner !== "string" || c.unassigned_owner.length === 0) {
    errors.push({ field: "unassigned_owner", message: "unassigned_owner must be a non-empty string" });
  }

  if (!Array.isArray(c.shared)) {
    errors.push({ field: "shared", message: "shared must be an array of strings" });
  } else {
    for (let i = 0; i < c.shared.length; i++) {
      if (typeof c.shared[i] !== "string") {
        errors.push({ field: `shared[${i}]`, message: "shared entries must be strings" });
      }
    }
  }

  if (!c.modules || typeof c.modules !== "object" || Array.isArray(c.modules)) {
    errors.push({ field: "modules", message: "modules must be a non-empty object" });
    return errors;
  }

  const modules = c.modules as Record<string, unknown>;
  if (Object.keys(modules).length === 0) {
    errors.push({ field: "modules", message: "modules must be a non-empty object" });
    return errors;
  }

  for (const [name, def] of Object.entries(modules)) {
    if (!MODULE_NAME_RE.test(name)) {
      errors.push({
        field: `modules.${name}`,
        message: `Module name must match /^[a-z][a-z0-9-]*$/ (kebab-case, starts with letter), got: "${name}"`,
      });
    }

    if (!def || typeof def !== "object") {
      errors.push({ field: `modules.${name}`, message: "Module definition must be an object" });
      continue;
    }

    const d = def as Record<string, unknown>;
    if (typeof d.owner !== "string" || d.owner.length === 0) {
      errors.push({ field: `modules.${name}.owner`, message: "owner must be a non-empty string" });
    }

    if (!Array.isArray(d.files) || d.files.length === 0) {
      errors.push({ field: `modules.${name}.files`, message: "files must be a non-empty string array" });
    } else {
      for (let i = 0; i < d.files.length; i++) {
        if (typeof d.files[i] !== "string") {
          errors.push({ field: `modules.${name}.files[${i}]`, message: "file patterns must be strings" });
        }
      }
    }
  }

  return errors;
}

export interface OverlapError {
  moduleA: string;
  moduleB: string;
  overlappingFiles: string[];
}

/**
 * Detect overlapping file patterns between modules by expanding globs against the filesystem.
 * Returns overlap errors (empty = no overlaps).
 */
export function detectOverlaps(config: ModuleMapConfig, projectRoot?: string): OverlapError[] {
  const root = projectRoot ?? HIVE_DIR;
  const errors: OverlapError[] = [];

  // Expand each module's patterns to actual file sets
  const moduleFiles = new Map<string, Set<string>>();

  for (const [name, def] of Object.entries(config.modules)) {
    const files = new Set<string>();
    for (const pattern of def.files) {
      try {
        const glob = new Bun.Glob(pattern);
        for (const match of glob.scanSync({ cwd: root, onlyFiles: true })) {
          files.add(match);
        }
      } catch {
        // Pattern expansion failed — skip (validation catches structural issues)
      }
    }
    moduleFiles.set(name, files);
  }

  // Check each pair for intersection
  const names = [...moduleFiles.keys()];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = moduleFiles.get(names[i])!;
      const b = moduleFiles.get(names[j])!;
      const overlap: string[] = [];
      for (const f of a) {
        if (b.has(f)) overlap.push(f);
      }
      if (overlap.length > 0) {
        errors.push({
          moduleA: names[i],
          moduleB: names[j],
          overlappingFiles: overlap.slice(0, 20), // Cap for readability
        });
      }
    }
  }

  // Warn about shared/module overlap (not an error, but worth noting)
  const sharedFiles = new Set<string>();
  for (const pattern of config.shared) {
    try {
      const glob = new Bun.Glob(pattern);
      for (const match of glob.scanSync({ cwd: root, onlyFiles: true })) {
        sharedFiles.add(match);
      }
    } catch {
      // skip
    }
  }
  for (const [name, files] of moduleFiles) {
    const overlap: string[] = [];
    for (const f of files) {
      if (sharedFiles.has(f)) overlap.push(f);
    }
    if (overlap.length > 0) {
      console.warn(
        `[module-map] Warning: shared patterns overlap with module "${name}": ${overlap.slice(0, 5).join(", ")}${overlap.length > 5 ? ` (+${overlap.length - 5} more)` : ""}. Shared takes precedence at lookup time.`,
      );
    }
  }

  return errors;
}

// ── Loading ────────────────────────────────────────────────────────────

/**
 * Load and validate .hive/modules.json.
 * Throws with details on any validation failure.
 */
export function loadModuleMap(projectRoot?: string): ModuleMapConfig {
  const root = projectRoot ?? HIVE_DIR;
  const modulesPath = join(root, ".hive", "modules.json");

  if (!existsSync(modulesPath)) {
    throw new Error(`Module map not found: ${modulesPath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(modulesPath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse ${modulesPath}: ${err}`);
  }

  const structErrors = validateModuleMapStructure(raw);
  if (structErrors.length > 0) {
    const details = structErrors.map((e) => `  ${e.field}: ${e.message}`).join("\n");
    throw new Error(`Invalid module map:\n${details}`);
  }

  const config = raw as ModuleMapConfig;

  const overlapErrors = detectOverlaps(config, root);
  if (overlapErrors.length > 0) {
    const details = overlapErrors
      .map(
        (e) =>
          `  ${e.moduleA} ↔ ${e.moduleB}: ${e.overlappingFiles.slice(0, 5).join(", ")}${e.overlappingFiles.length > 5 ? ` (+${e.overlappingFiles.length - 5} more)` : ""}`,
      )
      .join("\n");
    throw new Error(`Module map has overlapping patterns:\n${details}`);
  }

  return config;
}

// ── Lookup ─────────────────────────────────────────────────────────────

/**
 * Normalize a file path to a relative path from the project root.
 */
function normalizePath(filePath: string, projectRoot: string): string {
  // Strip leading ./
  let p = filePath.replace(/^\.\//, "");
  // If absolute, make relative
  if (isAbsolute(p)) {
    p = relative(projectRoot, p);
  }
  return p;
}

/**
 * Resolve file ownership for a given path.
 *
 * Algorithm (from atlas's spec):
 * 1. Normalize path to relative from project root
 * 2. Check shared patterns first — if match, return shared
 * 3. Iterate modules in declaration order, test each pattern
 * 4. Exactly one match → return owned
 * 5. Multiple matches → first match wins (log warning)
 * 6. No match → return unassigned
 */
export function resolveFileOwnership(
  relPath: string,
  config: ModuleMapConfig,
  projectRoot?: string,
): LookupResult {
  const root = projectRoot ?? HIVE_DIR;
  const modulesPath = join(root, ".hive", "modules.json");
  const compiled = getCompiled(config, modulesPath);
  const normalized = normalizePath(relPath, root);

  // 1. Check shared patterns
  for (const sp of compiled.sharedPatterns) {
    if (sp.regex.test(normalized)) {
      return { kind: "shared", pattern: sp.glob };
    }
  }

  // 2. Check modules in declaration order
  for (const mod of compiled.modules) {
    for (const pat of mod.patterns) {
      if (pat.regex.test(normalized)) {
        return {
          kind: "owned",
          module: mod.name,
          owner: mod.owner,
          pattern: pat.glob,
        };
      }
    }
  }

  // 3. No match — unassigned
  return { kind: "unassigned", fallback_owner: compiled.unassigned_owner };
}

// ── Convenience exports ────────────────────────────────────────────────

/**
 * Get all modules owned by a specific agent.
 */
export function getModulesForOwner(
  owner: string,
  config: ModuleMapConfig,
): { name: string; def: ModuleDefinition }[] {
  return Object.entries(config.modules)
    .filter(([, def]) => def.owner === owner)
    .map(([name, def]) => ({ name, def }));
}

/**
 * Get a flat list of all file patterns for an owner (useful for scope generation).
 */
export function getScopePatternsForOwner(owner: string, config: ModuleMapConfig): string[] {
  return Object.values(config.modules)
    .filter((def) => def.owner === owner)
    .flatMap((def) => def.files);
}

/**
 * List all modules with their owners (for CLI display).
 */
export function listModules(config: ModuleMapConfig): { name: string; owner: string; files: string[]; description?: string }[] {
  return Object.entries(config.modules).map(([name, def]) => ({
    name,
    owner: def.owner,
    files: def.files,
    description: def.description,
  }));
}

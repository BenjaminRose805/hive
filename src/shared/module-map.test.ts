import { describe, expect, test } from "bun:test";
import {
  globToRegex,
  resolveFileOwnership,
  validateModuleMapStructure,
  getModulesForOwner,
  getScopePatternsForOwner,
  listModules,
  type ModuleMapConfig,
} from "./module-map.ts";

// ── Test fixtures ──────────────────────────────────────────────────────

const VALID_CONFIG: ModuleMapConfig = {
  version: 1,
  unassigned_owner: "monarch",
  shared: ["package.json", "tsconfig.json", "bun.lock", ".hive/**", ".omc/**", "node_modules/**", "*.md"],
  modules: {
    "gateway-routing": {
      owner: "gatekeeper",
      files: ["src/gateway/**"],
      description: "Gateway routing",
    },
    "mind-daemon": {
      owner: "synaptic",
      files: ["src/mind/**"],
    },
    "config-gen": {
      owner: "cartographer",
      files: ["src/gen-config.ts"],
    },
    "shared-utils": {
      owner: "monarch",
      files: ["src/shared/**"],
    },
    cli: {
      owner: "cartographer",
      files: ["bin/**"],
    },
    hooks: {
      owner: "helmsman",
      files: ["hooks/**"],
    },
    "tool-config": {
      owner: "cartographer",
      files: ["config/tools/**", "config/tool-profiles/**"],
    },
    cicd: {
      owner: "pipeline",
      files: [".github/**", "Dockerfile", "docker-compose*.yml"],
    },
  },
};

// ── globToRegex ────────────────────────────────────────────────────────

describe("globToRegex", () => {
  test("** matches nested paths", () => {
    const re = globToRegex("src/gateway/**");
    expect(re.test("src/gateway/router.ts")).toBe(true);
    expect(re.test("src/gateway/deep/nested/file.ts")).toBe(true);
    expect(re.test("src/mind/daemon.ts")).toBe(false);
  });

  test("* matches single segment", () => {
    const re = globToRegex("*.md");
    expect(re.test("README.md")).toBe(true);
    expect(re.test("docs/README.md")).toBe(false);
  });

  test("? matches single character", () => {
    const re = globToRegex("file?.ts");
    expect(re.test("file1.ts")).toBe(true);
    expect(re.test("fileAB.ts")).toBe(false);
  });

  test("exact file match", () => {
    const re = globToRegex("src/gen-config.ts");
    expect(re.test("src/gen-config.ts")).toBe(true);
    expect(re.test("src/gen-config.tsx")).toBe(false);
    expect(re.test("other/gen-config.ts")).toBe(false);
  });

  test("docker-compose*.yml matches variants", () => {
    const re = globToRegex("docker-compose*.yml");
    expect(re.test("docker-compose.yml")).toBe(true);
    expect(re.test("docker-compose.dev.yml")).toBe(true);
    expect(re.test("docker-compose.prod.yml")).toBe(true);
    expect(re.test("Dockerfile")).toBe(false);
  });

  test("Dockerfile exact match", () => {
    const re = globToRegex("Dockerfile");
    expect(re.test("Dockerfile")).toBe(true);
    expect(re.test("Dockerfile.dev")).toBe(false);
  });
});

// ── validateModuleMapStructure ─────────────────────────────────────────

describe("validateModuleMapStructure", () => {
  test("valid config has no errors", () => {
    expect(validateModuleMapStructure(VALID_CONFIG)).toEqual([]);
  });

  test("rejects null", () => {
    const errors = validateModuleMapStructure(null);
    expect(errors.length).toBe(1);
    expect(errors[0].field).toBe("root");
  });

  test("rejects wrong version", () => {
    const errors = validateModuleMapStructure({ ...VALID_CONFIG, version: 2 });
    expect(errors.some((e) => e.field === "version")).toBe(true);
  });

  test("rejects empty unassigned_owner", () => {
    const errors = validateModuleMapStructure({ ...VALID_CONFIG, unassigned_owner: "" });
    expect(errors.some((e) => e.field === "unassigned_owner")).toBe(true);
  });

  test("rejects non-array shared", () => {
    const errors = validateModuleMapStructure({ ...VALID_CONFIG, shared: "not-array" });
    expect(errors.some((e) => e.field === "shared")).toBe(true);
  });

  test("rejects empty modules", () => {
    const errors = validateModuleMapStructure({ ...VALID_CONFIG, modules: {} });
    expect(errors.some((e) => e.field === "modules")).toBe(true);
  });

  test("rejects invalid module name (uppercase)", () => {
    const config = {
      ...VALID_CONFIG,
      modules: { InvalidName: { owner: "test", files: ["src/**"] } },
    };
    const errors = validateModuleMapStructure(config);
    expect(errors.some((e) => e.field === "modules.InvalidName")).toBe(true);
  });

  test("rejects module name starting with number", () => {
    const config = {
      ...VALID_CONFIG,
      modules: { "1bad": { owner: "test", files: ["src/**"] } },
    };
    const errors = validateModuleMapStructure(config);
    expect(errors.some((e) => e.field === "modules.1bad")).toBe(true);
  });

  test("rejects module with empty files", () => {
    const config = {
      ...VALID_CONFIG,
      modules: { valid: { owner: "test", files: [] } },
    };
    const errors = validateModuleMapStructure(config);
    expect(errors.some((e) => e.field === "modules.valid.files")).toBe(true);
  });

  test("rejects module without owner", () => {
    const config = {
      ...VALID_CONFIG,
      modules: { valid: { owner: "", files: ["src/**"] } },
    };
    const errors = validateModuleMapStructure(config);
    expect(errors.some((e) => e.field === "modules.valid.owner")).toBe(true);
  });
});

// ── resolveFileOwnership ──────────────────────────────────────────────

describe("resolveFileOwnership", () => {
  test("shared files matched first", () => {
    const result = resolveFileOwnership("package.json", VALID_CONFIG);
    expect(result).toEqual({ kind: "shared", pattern: "package.json" });
  });

  test("shared glob patterns work", () => {
    const result = resolveFileOwnership(".hive/scope/test.json", VALID_CONFIG);
    expect(result).toEqual({ kind: "shared", pattern: ".hive/**" });
  });

  test("*.md matches top-level markdown", () => {
    const result = resolveFileOwnership("README.md", VALID_CONFIG);
    expect(result).toEqual({ kind: "shared", pattern: "*.md" });
  });

  test("owned file resolves to correct module", () => {
    const result = resolveFileOwnership("src/gateway/router.ts", VALID_CONFIG);
    expect(result).toEqual({
      kind: "owned",
      module: "gateway-routing",
      owner: "gatekeeper",
      pattern: "src/gateway/**",
    });
  });

  test("deeply nested owned file resolves", () => {
    const result = resolveFileOwnership("src/mind/deep/nested/file.ts", VALID_CONFIG);
    expect(result).toEqual({
      kind: "owned",
      module: "mind-daemon",
      owner: "synaptic",
      pattern: "src/mind/**",
    });
  });

  test("exact file pattern matches", () => {
    const result = resolveFileOwnership("src/gen-config.ts", VALID_CONFIG);
    expect(result).toEqual({
      kind: "owned",
      module: "config-gen",
      owner: "cartographer",
      pattern: "src/gen-config.ts",
    });
  });

  test("multi-pattern module resolves from any pattern", () => {
    const r1 = resolveFileOwnership("config/tools/mcp.json", VALID_CONFIG);
    expect(r1.kind).toBe("owned");
    if (r1.kind === "owned") {
      expect(r1.module).toBe("tool-config");
      expect(r1.owner).toBe("cartographer");
    }

    const r2 = resolveFileOwnership("config/tool-profiles/reviewer.json", VALID_CONFIG);
    expect(r2.kind).toBe("owned");
    if (r2.kind === "owned") {
      expect(r2.module).toBe("tool-config");
    }
  });

  test("unmatched file returns unassigned", () => {
    const result = resolveFileOwnership("random/unknown/file.ts", VALID_CONFIG);
    expect(result).toEqual({ kind: "unassigned", fallback_owner: "monarch" });
  });

  test("normalizes leading ./", () => {
    const result = resolveFileOwnership("./src/gateway/router.ts", VALID_CONFIG);
    expect(result.kind).toBe("owned");
    if (result.kind === "owned") {
      expect(result.module).toBe("gateway-routing");
    }
  });

  test("Dockerfile matches cicd module", () => {
    const result = resolveFileOwnership("Dockerfile", VALID_CONFIG);
    expect(result).toEqual({
      kind: "owned",
      module: "cicd",
      owner: "pipeline",
      pattern: "Dockerfile",
    });
  });

  test("docker-compose.dev.yml matches cicd module", () => {
    const result = resolveFileOwnership("docker-compose.dev.yml", VALID_CONFIG);
    expect(result).toEqual({
      kind: "owned",
      module: "cicd",
      owner: "pipeline",
      pattern: "docker-compose*.yml",
    });
  });

  test("every file resolves to exactly one result", () => {
    const testPaths = [
      "package.json",
      "src/gateway/router.ts",
      "src/mind/daemon.ts",
      "src/gen-config.ts",
      "bin/hive.ts",
      "hooks/check-scope.mjs",
      "config/tools/mcp.json",
      ".github/workflows/ci.yml",
      "Dockerfile",
      "totally/unknown.ts",
    ];
    for (const p of testPaths) {
      const result = resolveFileOwnership(p, VALID_CONFIG);
      expect(["owned", "shared", "unassigned"]).toContain(result.kind);
    }
  });
});

// ── Convenience functions ──────────────────────────────────────────────

describe("getModulesForOwner", () => {
  test("returns correct modules for cartographer", () => {
    const mods = getModulesForOwner("cartographer", VALID_CONFIG);
    const names = mods.map((m) => m.name).sort();
    expect(names).toEqual(["cli", "config-gen", "tool-config"]);
  });

  test("returns empty for unknown owner", () => {
    expect(getModulesForOwner("nobody", VALID_CONFIG)).toEqual([]);
  });
});

describe("getScopePatternsForOwner", () => {
  test("returns all patterns for cartographer", () => {
    const patterns = getScopePatternsForOwner("cartographer", VALID_CONFIG);
    expect(patterns).toContain("src/gen-config.ts");
    expect(patterns).toContain("bin/**");
    expect(patterns).toContain("config/tools/**");
    expect(patterns).toContain("config/tool-profiles/**");
  });
});

describe("listModules", () => {
  test("lists all modules", () => {
    const mods = listModules(VALID_CONFIG);
    expect(mods.length).toBe(Object.keys(VALID_CONFIG.modules).length);
    expect(mods[0]).toHaveProperty("name");
    expect(mods[0]).toHaveProperty("owner");
    expect(mods[0]).toHaveProperty("files");
  });
});

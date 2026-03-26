/**
 * fs-utils.ts — Shared filesystem utility functions for hive-mind CLI and daemon.
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function readJSONFile<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    if (!raw || raw.trim() === "") return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Write-rename atomicity: write to .tmp-{uuid}.json, then rename to final path */
export async function atomicWrite(dir: string, filename: string, data: unknown): Promise<void> {
  ensureDir(dir);
  const tmpName = `.tmp-${crypto.randomUUID()}.json`;
  const tmpPath = join(dir, tmpName);
  const finalPath = join(dir, filename);
  await Bun.write(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, finalPath);
}

/**
 * src/mind/contracts.ts — Public API contract for the mind module.
 *
 * All types, interfaces, and functions intended for external consumption
 * MUST be re-exported here. Other modules should import from this file.
 */

// Mind types
export type {
  MindEntry,
  ReaderEntry,
  ReaderRegistry,
  InboxMessage,
  InboxPriority,
  WatchEntry,
  WatchStatus,
  DeltaFile,
  DeltaAction,
  ChangelogEntry,
  DaemonPid,
  CliError,
} from "./mind-types.ts";
export { PRIORITY_ORDER } from "./mind-types.ts";

// Filesystem utilities
export { atomicWrite, ensureDir, readJSONFile } from "./fs-utils.ts";

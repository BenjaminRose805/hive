/**
 * mind-types.ts — Shared type definitions for the Hive Mind system
 */

// ---------------------------------------------------------------------------
// Canonical Mind Entries (stored in contracts/ and decisions/)
// ---------------------------------------------------------------------------

export interface MindEntry {
  author: string;
  version: number;
  content: unknown;
  rationale?: string; // decisions only
  updated: string; // ISO-8601
  tags: string[];
  retracted?: boolean;
  retracted_at?: string;
  retracted_by?: string;
}

// ---------------------------------------------------------------------------
// Reader Registry (stored in readers/)
// ---------------------------------------------------------------------------

export interface ReaderEntry {
  agent: string;
  read_version: number;
  read_at: string; // ISO-8601
}

export interface ReaderRegistry {
  topic: string;
  type: string; // "contracts" | "decisions"
  version: number;
  readers: ReaderEntry[];
}

// ---------------------------------------------------------------------------
// Inbox Messages (stored in inbox/{agent}/)
// ---------------------------------------------------------------------------

export type InboxPriority = "info" | "alert" | "response" | "critical";

export interface InboxMessage {
  id: string;
  from: string;
  type: string; // "mind-update" | "watch-resolved" | "nudge" | "question" | "review-request" | "info" | "conflict"
  priority: InboxPriority;
  topic?: string;
  content: string;
  old_version?: number;
  new_version?: number;
  read: boolean;
  timestamp: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// Watch Entries (stored in watches/{agent}.json)
// ---------------------------------------------------------------------------

export type WatchStatus = "waiting" | "resolved";

export interface WatchEntry {
  topic: string;
  type: string; // "contract" | "decision"
  status: WatchStatus;
  since: string; // ISO-8601
  default_action: string;
  expect_from?: string;
  resolved_at?: string;
}

// ---------------------------------------------------------------------------
// Delta Files (written to pending/)
// ---------------------------------------------------------------------------

export type DeltaAction = "publish" | "update" | "retract" | "register-reader" | "register-watch";

export interface DeltaFile {
  agent: string;
  action: DeltaAction;
  target_type: string; // "contract" | "decision"
  target_topic: string;
  version_expecting?: number;
  content?: unknown;
  tags?: string[];
  breaking?: boolean;
  // For register-reader
  reader?: {
    read_version: number;
  };
  // For register-watch
  watch?: WatchEntry;
}

// ---------------------------------------------------------------------------
// Changelog (append-only in changelog/{date}.jsonl)
// ---------------------------------------------------------------------------

export interface ChangelogEntry {
  timestamp: string; // ISO-8601
  agent: string;
  action: DeltaAction;
  type: string;
  topic: string;
  version: number;
  breaking: boolean;
}

// ---------------------------------------------------------------------------
// Daemon PID file
// ---------------------------------------------------------------------------

export interface DaemonPid {
  pid: number;
  started: string; // ISO-8601
  lastActive: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// CLI Error Output
// ---------------------------------------------------------------------------

export interface CliError {
  error: string;
  code: number;
  detail: string;
}

// ---------------------------------------------------------------------------
// Priority ordering for inbox sorting
// ---------------------------------------------------------------------------

export const PRIORITY_ORDER: Record<InboxPriority, number> = {
  critical: 0,
  alert: 1,
  response: 2,
  info: 3,
};

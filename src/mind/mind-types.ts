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
// Delta Files (written to pending/)
// ---------------------------------------------------------------------------

export type DeltaAction = "publish" | "update" | "retract" | "task-create" | "task-transition";

export interface DeltaFile {
  agent: string;
  action: DeltaAction;
  target_type: string; // "contract" | "decision"
  target_topic: string;
  version_expecting?: number;
  content?: unknown;
  tags?: string[];
  breaking?: boolean;
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
// Task Contract System
// ---------------------------------------------------------------------------

/** Lifecycle phases in strict sequential order */
export const TASK_PHASES = [
  "ASSIGNED",
  "ACCEPTED",
  "IN_PROGRESS",
  "REVIEW",
  "VERIFY",
  "COMPLETE",
  "FAILED",
] as const;

export type TaskPhase = (typeof TASK_PHASES)[number];

/** Terminal phases — no further transitions allowed */
export const TERMINAL_PHASES: ReadonlySet<TaskPhase> = new Set(["COMPLETE", "FAILED"]);

/** Phase ordering index for enforcement */
export const PHASE_ORDER: Record<TaskPhase, number> = {
  ASSIGNED: 0,
  ACCEPTED: 1,
  IN_PROGRESS: 2,
  REVIEW: 3,
  VERIFY: 4,
  COMPLETE: 5,
  FAILED: 5, // FAILED is terminal at the same level as COMPLETE
};

/** Process item check status */
export type ProcessItemStatus = "PASS" | "FAIL" | "N/A" | "PENDING";

/** A single process check required before completion */
export interface ProcessItem {
  name: string;
  status: ProcessItemStatus;
  detail?: string;
  updated?: string; // ISO-8601
}

/** The core task contract — source of truth for task state */
export interface TaskContract {
  id: string;
  title: string;
  description: string;
  assignee: string;
  phase: TaskPhase;
  acceptance: string[]; // acceptance criteria
  process: ProcessItem[]; // required process checks
  files?: string[]; // scoped files
  dependencies?: string[]; // task IDs this depends on
  budget?: number;
  stage?: string; // pipeline stage: IMPLEMENT, REVIEW, VERIFY
  created: string; // ISO-8601
  updated: string; // ISO-8601
  history: TaskTransition[];
}

/** Record of a phase transition */
export interface TaskTransition {
  from: TaskPhase;
  to: TaskPhase;
  agent: string;
  timestamp: string; // ISO-8601
  reason?: string;
}

// ---------------------------------------------------------------------------
// Task Delta Actions (for daemon processing)
// ---------------------------------------------------------------------------

export type TaskDeltaAction = "task-create" | "task-transition";

export interface TaskCreateDelta {
  action: "task-create";
  agent: string;
  task: Omit<TaskContract, "history" | "created" | "updated">;
}

export interface TaskTransitionDelta {
  action: "task-transition";
  agent: string;
  task_id: string;
  to_phase: TaskPhase;
  reason?: string;
  process_updates?: ProcessItem[];
}

export type TaskDelta = TaskCreateDelta | TaskTransitionDelta;

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

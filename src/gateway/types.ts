/**
 * Shared types for Hive Phase 2: Auto-Threading + Selective Routing
 */

export enum MessageType {
  TASK_ASSIGN = 'TASK_ASSIGN',
  STATUS = 'STATUS',
  QUESTION = 'QUESTION',
  ANSWER = 'ANSWER',
  COMPLETE = 'COMPLETE',
  HEARTBEAT = 'HEARTBEAT',
  INTEGRATE = 'INTEGRATE',
  ESCALATE = 'ESCALATE',
  CONTRACT_UPDATE = 'CONTRACT_UPDATE',
}

export interface ParsedHeader {
  type: MessageType
  sender: string
  target?: string
  taskId?: string
  status?: string
}

export interface ParsedBody {
  agents?: string[]
  branch?: string
  description?: string
  scope?: string
  dependencies?: string
  files?: string
}

export interface RoutingDecision {
  deliver: boolean
  reason: string
}


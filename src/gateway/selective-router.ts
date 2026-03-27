import type { MessageType, ParsedHeader, RoutingDecision } from "./types.ts";

export interface WorkerInfo {
  workerId: string;
  channelId: string;
  role?: string;
  domain?: string;
}

export function shouldDeliver(
  parsed: ParsedHeader | null,
  worker: WorkerInfo,
  rawContent: string,
  bodyAgents?: string[],
): RoutingDecision {
  // Unparsable message — broadcast for backward compatibility
  if (parsed === null) {
    return { deliver: true, reason: "unparsable — broadcast fallback" };
  }

  const contentLower = rawContent.toLowerCase();

  // Broadcast keywords — check before type-based rules
  if (contentLower.includes("all-workers") || contentLower.includes("all-agents")) {
    return { deliver: true, reason: "broadcast keyword" };
  }

  // Direct @mention — check before type-based rules
  if (contentLower.includes(`@${worker.workerId.toLowerCase()}`)) {
    return { deliver: true, reason: `direct @mention of ${worker.workerId}` };
  }

  const isCoordinator = worker.role === "manager";

  switch (parsed.type) {
    case "TASK_ASSIGN" as MessageType:
      return parsed.target === worker.workerId
        ? { deliver: true, reason: `TASK_ASSIGN targeted to ${worker.workerId}` }
        : {
            deliver: false,
            reason: `TASK_ASSIGN targeted to ${parsed.target}, not ${worker.workerId}`,
          };

    case "ANSWER" as MessageType:
      return parsed.target === worker.workerId
        ? { deliver: true, reason: `ANSWER targeted to ${worker.workerId}` }
        : { deliver: false, reason: `ANSWER targeted to ${parsed.target}, not ${worker.workerId}` };

    case "QUESTION" as MessageType:
      return isCoordinator
        ? { deliver: true, reason: "QUESTION routed to manager" }
        : { deliver: false, reason: "QUESTION is manager-only" };

    case "STATUS" as MessageType:
      return isCoordinator
        ? { deliver: true, reason: "STATUS routed to manager" }
        : { deliver: false, reason: "STATUS is manager-only" };

    case "HEARTBEAT" as MessageType:
      return isCoordinator
        ? { deliver: true, reason: "HEARTBEAT routed to manager" }
        : { deliver: false, reason: "HEARTBEAT is manager-only" };

    case "COMPLETE" as MessageType:
      return isCoordinator
        ? { deliver: true, reason: "COMPLETE routed to manager" }
        : { deliver: false, reason: "COMPLETE is manager-only" };

    case "INTEGRATE" as MessageType:
      if (bodyAgents?.includes(worker.workerId)) {
        return { deliver: true, reason: `INTEGRATE includes ${worker.workerId} in agents list` };
      }
      return { deliver: false, reason: `INTEGRATE does not include ${worker.workerId}` };

    case "ESCALATE" as MessageType:
      return { deliver: true, reason: "ESCALATE broadcast to all workers and manager" };

    case "CONTRACT_UPDATE" as MessageType:
      return parsed.target === worker.workerId
        ? { deliver: true, reason: `CONTRACT_UPDATE targeted to ${worker.workerId}` }
        : {
            deliver: false,
            reason: `CONTRACT_UPDATE targeted to ${parsed.target}, not ${worker.workerId}`,
          };

    default:
      return { deliver: true, reason: `unknown message type: ${parsed.type}` };
  }
}

export function isSpokesperson(worker: WorkerInfo): boolean {
  return worker.role === "product";
}

export function findSpokesperson(workers: WorkerInfo[]): WorkerInfo | undefined {
  return workers.find((w) => w.role === "product");
}

export function shouldDeliverHumanMessage(
  worker: WorkerInfo,
  isChannelOwner: boolean,
  isConversationMember: boolean,
): RoutingDecision {
  if (isSpokesperson(worker)) {
    return { deliver: true, reason: "spokesperson receives all human messages" };
  }
  if (isChannelOwner) {
    return { deliver: true, reason: "human DM to agent channel" };
  }
  if (isConversationMember) {
    return { deliver: true, reason: "human message in conversation channel" };
  }
  return { deliver: false, reason: "human messages route through spokesperson" };
}

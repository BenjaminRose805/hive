export interface WorkerInfo {
  workerId: string;
  channelId: string;
  role?: string;
  domain?: string;
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
): { deliver: boolean; reason: string } {
  if (isSpokesperson(worker)) {
    return { deliver: true, reason: "spokesperson receives all human messages" };
  }
  if (isChannelOwner) {
    return { deliver: true, reason: "human DM to agent channel" };
  }
  return { deliver: false, reason: "human messages route through spokesperson" };
}

import { MessageType, type ParsedBody, type ParsedHeader } from "./types.ts";

/**
 * Parse the first line of a protocol message into a structured header.
 * Returns null for unparsable messages.
 */
export function parseHeader(content: string): ParsedHeader | null {
  const firstLine = content.split("\n")[0];
  if (!firstLine) return null;

  const fields = firstLine.split("|").map((f) => f.trim());
  if (fields.length < 2) return null;

  const typeStr = fields[0];
  if (!Object.values(MessageType).includes(typeStr as MessageType)) return null;

  const type = typeStr as MessageType;
  const field2 = fields[1];

  // TASK_ASSIGN and ANSWER: field 2 is the TARGET agent (manager sends these)
  // All other types: field 2 is the SENDER
  const isManagerDirected =
    type === MessageType.TASK_ASSIGN ||
    type === MessageType.ANSWER ||
    type === MessageType.CONTRACT_UPDATE;

  const header: ParsedHeader = {
    type,
    // TASK_ASSIGN, ANSWER, CONTRACT_UPDATE are coordinator-directed messages.
    // The sender is always the coordinator role (conventionally named 'manager').
    // If the coordinator agent is renamed, this string becomes cosmetic only —
    // routing uses the target field (field 2), not the sender field.
    sender: isManagerDirected ? "manager" : field2,
  };

  if (isManagerDirected) {
    header.target = field2;
  }

  // field 3 is taskId (absent for HEARTBEAT and INTEGRATE)
  if (fields.length >= 3 && type !== MessageType.HEARTBEAT && type !== MessageType.INTEGRATE) {
    header.taskId = fields[2];
  }

  // field 4 is status (STATUS messages only)
  if (fields.length >= 4 && type === MessageType.STATUS) {
    header.status = fields[3];
  }

  return header;
}

/**
 * Parse body lines (everything after the first line) as Key: value pairs.
 */
export function parseBody(content: string): ParsedBody {
  const lines = content.split("\n").slice(1);
  const body: ParsedBody = {};

  for (const line of lines) {
    const colonIdx = line.indexOf(": ");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 2).trim();

    switch (key) {
      case "Branch":
        body.branch = value;
        break;
      case "Description":
        body.description = value;
        break;
      case "Agents":
        body.agents = value.split(",").map((a) => a.trim());
        break;
      case "Scope":
        body.scope = value;
        break;
      case "Dependencies":
        body.dependencies = value;
        break;
      case "Files":
        body.files = value;
        break;
    }
  }

  return body;
}

/**
 * Convenience: extract the Agents list from a message body, or empty array.
 */
export function extractAgentsList(content: string): string[] {
  return parseBody(content).agents ?? [];
}

/**
 * src/gateway/contracts.ts — Public API contract for the gateway module.
 *
 * All types, interfaces, and functions intended for external consumption
 * MUST be re-exported here. Other modules should import from this file.
 */

// Types
export { MessageType } from "./types.ts";
export type { ParsedHeader, ParsedBody, RoutingDecision } from "./types.ts";

// Protocol parser
export { parseHeader, parseBody, extractAgentsList } from "./protocol-parser.ts";

// Selective router
export type { WorkerInfo } from "./selective-router.ts";
export { shouldDeliver } from "./selective-router.ts";

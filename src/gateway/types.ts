/**
 * Shared types for Hive gateway routing
 */

export interface RoutingDecision {
  deliver: boolean;
  reason: string;
}

/**
 * MODULE A — 9Router Integration and Service Manager
 * Revision 17 — Public API
 */

export { NineRouterService, createNineRouterService } from "./service-manager.js"
export type { NineRouterServiceConfig } from "./service-manager.js"

export type {
  RuntimeStatus,
  EnsureResult,
  ShutdownResult,
  CoordinatorResult,
  LockOutcome,
  HealthOutcome,
  CleanupOutcome,
  LeaseRecord,
  LeaseState,
  OwnershipState,
} from "./types.js"

export { CONSTANTS } from "./types.js"

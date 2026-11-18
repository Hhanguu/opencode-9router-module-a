/**
 * MODULE A — 9Router Integration and Service Manager
 * Revision 17 — Core Types
 * 
 * Canonical type definitions from MODULE_A_DESIGN.md §3, §5.2, §5.3, §5.6
 */

/**
 * Service state machine (§5.1)
 */
export type RuntimeStatus = "UNKNOWN" | "STOPPED" | "STARTING" | "RUNNING" | "DEGRADED"

/**
 * Constants — single source of truth (MODULE_A_DESIGN §5.0)
 */
export const CONSTANTS = {
  STALE_MS: 60_000,
  LOCK_TIMEOUT_MS: 10_000,
  TRY_LOCK_TIMEOUT_MS: 500,
  HEALTH_MAX_ATTEMPTS: 5,
  HEALTH_PROBE_TIMEOUT_MS: 1_500,
  HEALTH_INTERVAL_MS: 2_000,
  HEALTH_DEADLINE_MS: 10_000,
  COORDINATOR_DEADLINE_MS: 15_000,
  CLEANUP_MAX_ATTEMPTS: 3,
  CLEANUP_BACKOFF_MS: [250, 1000, 4000] as const,
} as const

/**
 * LockOutcome — R17 canonical (§5.3.2)
 */
export type LockOutcome =
  | { status: "acquired"; record: LeaseRecord; token: string; acquiredAtMs: number }
  | { status: "acquired_post_deadline"; record: LeaseRecord; token: string | null }
  | { status: "acquired_token_failed"; record: LeaseRecord; cleanup: CleanupOutcome; error: unknown }
  | { status: "timeout"; error: unknown }
  | { status: "aborted"; error: unknown }
  | { status: "rejected"; error: unknown }

/**
 * HealthOutcome — R17 canonical (§5.3.2)
 */
export type HealthOutcome =
  | { status: "ready"; health: "Ready" | "KeyRejected"; attempts: number }
  | { status: "exhausted"; attempts: number; lastError: unknown }
  | { status: "aborted"; attempts: number; lastError: unknown }

/**
 * Resolution type
 */
export type Resolution = "rendezvous" | "deadline"

/**
 * Late flag
 */
export type LateFlag = "none" | "pending"

/**
 * CanonicalUnavailable — §5.3.2
 */
export type CanonicalUnavailable =
  | { status: "canonical_unavailable"; record: LeaseRecord }
  | { status: "illegal_outcome_in_rendezvous"; record: LeaseRecord }

/**
 * CoordinatorResult — R17 canonical (§5.3.2)
 */
export type CoordinatorResult =
  | { kind: "health"; health: HealthOutcome; resolvedBy: Resolution; late?: LateFlag }
  | { kind: "health_with_lease"; lease: Lease; token: string; resolvedBy: Resolution }
  | { kind: "lock"; lease: Lease; token: string; resolvedBy: Resolution }
  | { kind: "both_rejected"; lock: LockOutcome; health: HealthOutcome; resolvedBy: "rendezvous" }
  | {
      kind: "ownership_error"
      lock: LockOutcome | CanonicalUnavailable
      health: HealthOutcome | null
      resolvedBy: Resolution
    }
  | { kind: "deadline"; late: LateFlag; resolvedBy: "deadline" }

/**
 * EnsureResult — public API (§3)
 */
export type EnsureResult =
  | { kind: "running"; owner: boolean }
  | { kind: "already_running"; owner: false }
  | { kind: "adopted"; owner: false }
  | { kind: "started"; owner: true }
  | { kind: "deadline" }
  | { kind: "start_timeout" }
  | { kind: "ownership_error"; cleanup: CleanupOutcome }
  | { kind: "port_conflict" }
  | { kind: "docker_missing" }

/**
 * ShutdownResult — public API (§3, §5.4)
 */
export type ShutdownResult =
  | { kind: "released" }
  | { kind: "not_owner" }
  | { kind: "foreign_owner" }
  | { kind: "cleanup_pending"; attempts: number }
  | { kind: "cleanup_failed"; recordPath: string; attempts: number }
  | { kind: "cleanup_failed_unpersisted"; attempts: number; code: string }

/**
 * CleanupOutcome — R17 cleanup classification (§5.6)
 */
export type CleanupOutcome =
  | { status: "released" }
  | { status: "foreign"; token: string }
  | { status: "reclaimed" }
  | {
      status: "unconfirmed"
      recovery: "persisted" | "failed"
      attempts: number
      lastError: unknown
    }

/**
 * LeaseRecord — registry handle (§5.3.8)
 */
export interface LeaseRecord {
  id: string
  lease: Lease
  token: string | null
  state: LeaseState
  origin: "coordinator" | "adopt"
  runId: number | null
  acquiredAt: number
  disposedAt: number | null
  disposeReason: string | null
  releaseCount: number
  markToken(token: string): void
  markTokenFailed(error: unknown): void
}

/**
 * LeaseState — registry state machine (§5.3.8, §5.3.13)
 */
export type LeaseState =
  | "LEASE_ACQUIRED_TOKEN_PENDING"
  | "LEASE_TOKEN_KNOWN"
  | "LEASE_TOKEN_FAILED"
  | "LEASE_DISPOSING"
  | "LEASE_RELEASED"
  | "LEASE_FOREIGN"
  | "LEASE_RECLAIMED"
  | "CLEANUP_PENDING"
  | "CLEANUP_FAILED"
  | "CLEANUP_FAILED_UNPERSISTED"

/**
 * Lease — Flock.Lease interface (verified from flock.ts:63-66)
 */
export interface Lease {
  release(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

/**
 * OwnershipState — in-memory ownership belief (§5.2)
 */
export interface OwnershipState {
  owned: boolean
  instanceID: string | null
  token: string | null
  lease: Lease | null
  lockDir: string | null
  startedAt: number | null
}

/**
 * DiagnosticOwnerRecord — immutable per-token record (§4.3)
 */
export interface DiagnosticOwnerRecord {
  schemaVersion: 1
  instanceID: string
  token: string
  pid: number
  hostname: string
  dockerProject: string
  baseURL: string
  startedAt: string
}

/**
 * CleanupRecoveryRecord — persisted recovery record (§4.4)
 */
export interface CleanupRecoveryRecord {
  schemaVersion: 1
  key: string
  lockDir: string
  token: string | null
  pid: number
  hostname: string
  acquiredAt: string
  attempts: number
  reason: "shutdown" | "token_read_failed" | "ownership_commit_failed" | "late_lease"
  lastError: string
  lastCode: string
  createdAt: string
}

/**
 * Channel — R10 two-field protocol (§5.3.12)
 */
export interface Channel<T> {
  published: T | null
  publishedAt: number | null
  consumed: T | null
  consumedAt: number | null
  duplicateCallbacks: number
  conflictingPublications: number
  conflictingCallbacks: number
}

/**
 * Phase — coordinator phase (§5.3.3)
 */
export type Phase = "IDLE" | "RUNNING" | "ABANDONED"

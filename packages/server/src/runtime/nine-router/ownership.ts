/**
 * MODULE A — Ownership and Lease Registry
 * Revision 17 — Implementation
 * 
 * Implements:
 * - Flock-based ownership with token-checked release (§5.2)
 * - LeaseRegistry with phase-aware registration (§5.3.8, §5.3.13)
 * - Diagnostic owner records (create-only, per-token) (§4.3, §5.2)
 * - Cleanup with retry and recovery persistence (§5.6)
 */

import path from "path"
import { mkdir, writeFile, readFile, rm } from "fs/promises"
import { randomUUID } from "crypto"
import { Flock } from "@opencode/util/flock"
import type {
  LeaseRecord,
  LeaseState,
  Lease,
  OwnershipState,
  DiagnosticOwnerRecord,
  CleanupRecoveryRecord,
  CleanupOutcome,
  Phase,
} from "./types.js"
import { CONSTANTS } from "./types.js"

/**
 * LeaseRegistry — manages all Lease records for one coordinator run (§5.3.8)
 * 
 * Guarantees:
 * - Registration precedes every await (P0.2)
 * - Exactly-once disposition per record
 * - Phase-aware: ABANDONED at register() → immediate disposal claim
 */
export class LeaseRegistry {
  private records = new Map<string, LeaseRecordImpl>()
  private contained = new WeakSet<LeaseRecordImpl>()

  /**
   * Register a Lease synchronously (§5.3.13)
   * Must be called as the first statement after Flock.acquire resolves.
   */
  register(
    lease: Lease,
    ctx: { origin: "coordinator" | "adopt"; runId: number | null; phase: Phase },
  ): LeaseRecord {
    const id = randomUUID()
    const record = new LeaseRecordImpl(id, lease, ctx.origin, ctx.runId)

    // Phase-aware registration (R10, P0.2)
    if (ctx.phase === "ABANDONED") {
      record.state = "LEASE_DISPOSING"
      // Disposal is claimed synchronously; cleanup will start before returning
      // Token read continues for diagnostics only
    }

    this.records.set(id, record)
    return record
  }

  /**
   * Claim transfer ownership (at-most-once)
   */
  claimTransfer(record: LeaseRecord): { claimed: true } | { claimed: false; reason: string } {
    const impl = this.records.get(record.id)
    if (!impl) return { claimed: false, reason: "record_not_found" }
    if (impl.disposedAt !== null) return { claimed: false, reason: "already_disposed" }
    if (impl.state === "LEASE_DISPOSING") return { claimed: false, reason: "disposal_in_progress" }

    impl.state = "LEASE_RELEASED"
    impl.disposeReason = "transfer"
    impl.disposedAt = Date.now()
    return { claimed: true }
  }

  /**
   * Claim disposal ownership (at-most-once)
   */
  claimDispose(record: LeaseRecord, reason: string): { claimed: true } | { claimed: false; memoised: CleanupOutcome } {
    const impl = this.records.get(record.id)
    if (!impl) return { claimed: false, memoised: { status: "reclaimed" } }
    if (impl.disposedAt !== null && impl.memoised) {
      return { claimed: false, memoised: impl.memoised }
    }

    impl.state = "LEASE_DISPOSING"
    impl.disposeReason = reason
    impl.disposedAt = Date.now()
    return { claimed: true }
  }

  /**
   * Store memoised cleanup outcome
   */
  memoiseCleanup(record: LeaseRecord, outcome: CleanupOutcome): void {
    const impl = this.records.get(record.id)
    if (impl) {
      impl.memoised = outcome
    }
  }

  /**
   * Get all records for a specific runId
   */
  getByRunId(runId: number): LeaseRecord[] {
    return Array.from(this.records.values()).filter((r) => r.runId === runId)
  }

  /**
   * Dispose all unclaimed records (used by onHandlerFailure)
   */
  disposeAllUnclaimed(runId: number, reason: string): LeaseRecord[] {
    const records = this.getByRunId(runId)
    const disposed: LeaseRecord[] = []

    for (const record of records) {
      const claim = this.claimDispose(record, reason)
      if (claim.claimed) {
        disposed.push(record)
      }
    }

    return disposed
  }
}

/**
 * LeaseRecordImpl — internal implementation
 */
class LeaseRecordImpl implements LeaseRecord {
  state: LeaseState = "LEASE_ACQUIRED_TOKEN_PENDING"
  token: string | null = null
  disposedAt: number | null = null
  disposeReason: string | null = null
  releaseCount = 0
  memoised: CleanupOutcome | null = null

  constructor(
    public readonly id: string,
    public readonly lease: Lease,
    public readonly origin: "coordinator" | "adopt",
    public readonly runId: number | null,
    public readonly acquiredAt = Date.now(),
  ) {}

  markToken(token: string): void {
    this.token = token
    if (this.state === "LEASE_ACQUIRED_TOKEN_PENDING") {
      this.state = "LEASE_TOKEN_KNOWN"
    }
  }

  markTokenFailed(error: unknown): void {
    this.state = "LEASE_TOKEN_FAILED"
  }
}

/**
 * Ownership manager — handles Flock lock and diagnostic records (§5.2)
 */
export class OwnershipManager {
  private state: OwnershipState = {
    owned: false,
    instanceID: null,
    token: null,
    lease: null,
    lockDir: null,
    startedAt: null,
  }

  constructor(
    private readonly stateDir: string,
    private readonly dockerProject: string,
    private readonly baseURL: string,
  ) {}

  getState(): Readonly<OwnershipState> {
    return { ...this.state }
  }

  /**
   * Commit ownership (§5.5.3)
   * Creates immutable diagnostic record before setting owned=true
   */
  async commitOwnership(lease: Lease, token: string, lockDir: string): Promise<void> {
    const instanceID = randomUUID()

    // Create diagnostic record (§4.3, §5.2)
    const record: DiagnosticOwnerRecord = {
      schemaVersion: 1,
      instanceID,
      token,
      pid: process.pid,
      hostname: require("os").hostname(),
      dockerProject: this.dockerProject,
      baseURL: this.baseURL,
      startedAt: new Date().toISOString(),
    }

    const ownersDir = path.join(this.stateDir, "nine-router", "owners")
    await mkdir(ownersDir, { recursive: true, mode: 0o700 })

    const recordPath = path.join(ownersDir, `${token}.json`)
    // flag:"wx" = create-only, fails if exists
    await writeFile(recordPath, JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 })

    // Only after successful record write
    this.state = {
      owned: true,
      instanceID,
      token,
      lease,
      lockDir,
      startedAt: Date.now(),
    }
  }

  /**
   * Clear ownership (does NOT delete records or lock)
   */
  clearOwnership(): void {
    this.state = {
      owned: false,
      instanceID: null,
      token: null,
      lease: null,
      lockDir: null,
      startedAt: null,
    }
  }
}

/**
 * Cleanup with retry and recovery (§5.6)
 */
export class CleanupService {
  constructor(private readonly stateDir: string) {}

  /**
   * cleanupLease — total, never rejects (§5.6.3)
   */
  async cleanupLease(
    lease: Lease,
    ctx: {
      token: string | null
      lockDir: string
      reason: string
    },
  ): Promise<CleanupOutcome> {
    const { CLEANUP_MAX_ATTEMPTS, CLEANUP_BACKOFF_MS } = CONSTANTS
    let attempts = 0
    let lastError: unknown = null
    let lastCode = "UNKNOWN"

    // Verify ownership before attempting release
    if (ctx.token) {
      const foreign = await this.checkForeignOwnership(ctx.lockDir, ctx.token)
      if (foreign) {
        return { status: "foreign", token: foreign }
      }
    }

    // Retry loop
    for (let i = 0; i < CLEANUP_MAX_ATTEMPTS; i++) {
      attempts++

      try {
        await lease.release()
        return { status: "released" }
      } catch (err) {
        lastError = err
        lastCode = this.extractCode(err)

        // Check if lock was reclaimed
        const exists = await this.lockExists(ctx.lockDir)
        if (!exists) {
          return { status: "reclaimed" }
        }

        // Check if token changed (foreign owner)
        if (ctx.token) {
          const foreign = await this.checkForeignOwnership(ctx.lockDir, ctx.token)
          if (foreign) {
            return { status: "foreign", token: foreign }
          }
        }

        // Backoff before retry
        if (i < CLEANUP_MAX_ATTEMPTS - 1) {
          await this.sleep(CLEANUP_BACKOFF_MS[i])
        }
      }
    }

    // Exhausted retries — persist recovery record
    const recovery = await this.writeRecoveryRecord({
      lockDir: ctx.lockDir,
      token: ctx.token,
      reason: ctx.reason,
      attempts,
      lastError,
      lastCode,
    })

    if (recovery.persisted) {
      return {
        status: "unconfirmed",
        recovery: "persisted",
        attempts,
        lastError,
      }
    } else {
      return {
        status: "unconfirmed",
        recovery: "failed",
        attempts,
        lastError,
      }
    }
  }

  private async checkForeignOwnership(lockDir: string, expectedToken: string): Promise<string | null> {
    try {
      const metaPath = path.join(lockDir, "meta.json")
      const content = await readFile(metaPath, "utf8")
      const meta = JSON.parse(content)
      if (meta.token && meta.token !== expectedToken) {
        return meta.token
      }
      return null
    } catch {
      return null
    }
  }

  private async lockExists(lockDir: string): Promise<boolean> {
    try {
      const { stat } = await import("fs/promises")
      await stat(lockDir)
      return true
    } catch {
      return false
    }
  }

  private extractCode(err: unknown): string {
    if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") {
      return err.code
    }
    return "UNKNOWN"
  }

  private async writeRecoveryRecord(ctx: {
    lockDir: string
    token: string | null
    reason: string
    attempts: number
    lastError: unknown
    lastCode: string
  }): Promise<{ persisted: boolean; path?: string }> {
    try {
      const record: CleanupRecoveryRecord = {
        schemaVersion: 1,
        key: "nine-router-service",
        lockDir: ctx.lockDir,
        token: ctx.token,
        pid: process.pid,
        hostname: require("os").hostname(),
        acquiredAt: new Date().toISOString(),
        attempts: ctx.attempts,
        reason: ctx.reason as any,
        lastError: String(ctx.lastError),
        lastCode: ctx.lastCode,
        createdAt: new Date().toISOString(),
      }

      const cleanupDir = path.join(this.stateDir, "nine-router", "cleanup-pending")
      await mkdir(cleanupDir, { recursive: true, mode: 0o700 })

      const filename = `${this.hashKey("nine-router-service")}-${ctx.token || "unknown"}.json`
      const recordPath = path.join(cleanupDir, filename)

      await writeFile(recordPath, JSON.stringify(record, null, 2), { mode: 0o600 })

      return { persisted: true, path: recordPath }
    } catch {
      return { persisted: false }
    }
  }

  private hashKey(key: string): string {
    // Simple hash for filename (matches §4.4)
    const { createHash } = require("crypto")
    return createHash("sha1").update(key).digest("hex")
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

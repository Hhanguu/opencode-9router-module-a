/**
 * MODULE A — Acquisition Coordinator
 * Revision 17 — Implementation
 * 
 * Implements the canonical R17 coordinator algorithm (§5.3):
 * - Two concurrent branches: lockBranch + healthBranch
 * - Per-branch handlers (no Promise.allSettled)
 * - Publication/consumption two-field protocol (R10)
 * - Canonical-gated side effects (R12)
 * - Phase-aware LeaseRegistry (R10)
 * - Deadline adjudication
 * 
 * Three return paths (§5.3.1):
 * 1. Both published before deadline → rendezvous
 * 2. Deadline + token known → transfer lock
 * 3. Deadline + no token → dispose at deadline
 */

import { Flock } from "@opencode/util/flock"
import type {
  CoordinatorResult,
  LockOutcome,
  HealthOutcome,
  Channel,
  Phase,
  LeaseRecord,
  Lease,
  CleanupOutcome,
} from "./types.js"
import { CONSTANTS } from "./types.js"
import { LeaseRegistry, CleanupService } from "./ownership.js"
import { healthBranch, readLockToken } from "./health.js"

/**
 * AcquisitionCoordinator — R17 canonical (§5.3)
 */
export class AcquisitionCoordinator {
  private phase: Phase = "IDLE"
  private runId: number = 0
  private returned = false

  // Two-field protocol per channel (R10, §5.3.12)
  private lockChannel: Channel<LockOutcome> = this.createChannel()
  private healthChannel: Channel<HealthOutcome> = this.createChannel()

  // Abort controllers
  private abortLock = new AbortController()
  private abortHealth = new AbortController()

  // Side-effect latches (R12, §5.3.15)
  private abortedHealth = false
  private abortedLock = false
  private duplicateAborts = 0

  // Result signal
  private resultSignal: {
    promise: Promise<CoordinatorResult>
    resolve: (result: CoordinatorResult) => void
  }

  // Commitment guards
  private committed = false
  private commitInProgress = false
  private commitReentrySuppressed = 0

  // Timer
  private timer: NodeJS.Timeout | undefined

  // Dependencies
  private readonly leases: LeaseRegistry
  private readonly cleanup: CleanupService

  constructor(
    private readonly baseURL: string,
    private readonly lockKey: string,
    private readonly lockDir: string,
    private readonly stateDir: string,
  ) {
    this.leases = new LeaseRegistry()
    this.cleanup = new CleanupService(stateDir)

    // Create result signal
    let resolve: (result: CoordinatorResult) => void
    const promise = new Promise<CoordinatorResult>((res) => {
      resolve = res
    })
    this.resultSignal = { promise, resolve: resolve! }
  }

  /**
   * run() — single entry point (§5.3.3)
   */
  async run(): Promise<CoordinatorResult> {
    if (this.phase !== "IDLE") {
      throw new Error("CoordinatorAlreadyRun")
    }

    this.phase = "RUNNING"
    this.runId = Date.now()

    // (a) Start both branches
    const lockP = this.lockBranch()
    const healthP = healthBranch(this.baseURL, this.abortHealth.signal, () => {})

    // (b) Attach per-branch handlers
    const lockHandled = lockP.then(
      (o) => this.onLockSettled(o),
      (e) => this.onLockSettled({ status: "rejected", error: e }),
    )

    const healthHandled = healthP.then(
      (o) => this.onHealthSettled(o),
      (e) => this.onHealthSettled({ status: "aborted", attempts: 0, lastError: e }),
    )

    // Handler defects must not hang run()
    void lockHandled.catch((err) => this.onHandlerFailure("lock", err))
    void healthHandled.catch((err) => this.onHandlerFailure("health", err))

    // (c) Arm deadline
    this.timer = setTimeout(() => this.onDeadline(), CONSTANTS.COORDINATOR_DEADLINE_MS)

    // (d) Await result
    const result = await this.resultSignal.promise

    if (this.timer) clearTimeout(this.timer)
    this.returned = true

    return result
  }

  /**
   * lockBranch — R17 canonical (§5.3.4)
   */
  private async lockBranch(): Promise<LockOutcome> {
    let lease: Lease

    try {
      lease = await Flock.acquire(this.lockKey, {
        signal: this.abortLock.signal,
        staleMs: CONSTANTS.STALE_MS,
        timeoutMs: CONSTANTS.LOCK_TIMEOUT_MS,
        baseDelayMs: 100,
        maxDelayMs: 500,
        dir: this.lockDir,
      })
    } catch (err) {
      if (this.abortLock.signal.aborted) {
        return { status: "aborted", error: err }
      }
      if (this.isFlockTimeout(err)) {
        return { status: "timeout", error: err }
      }
      return { status: "rejected", error: err }
    }

    // STEP 1: REGISTER (§5.3.4)
    const phaseAtRegister = this.phase
    const rec = this.leases.register(lease, {
      origin: "coordinator",
      runId: this.runId,
      phase: phaseAtRegister,
    })

    // STEP 1b: Post-deadline registration
    if (phaseAtRegister !== "RUNNING") {
      this.diagnoseTokenInBackground(rec)
      const outcome: LockOutcome = {
        status: "acquired_post_deadline",
        record: rec,
        token: rec.token,
      }
      return this.publishLockOutcome(outcome)
    }

    // STEP 2: Token read
    let token: string | null = null
    let tokenError: unknown = null

    try {
      token = await readLockToken(this.lockDir)
      rec.markToken(token)
    } catch (err) {
      tokenError = err
      rec.markTokenFailed(err)
    }

    if (tokenError !== null) {
      const cleanup = await this.disposeRecord(rec, "token_read_failed")
      const outcome: LockOutcome = {
        status: "acquired_token_failed",
        record: rec,
        cleanup,
        error: tokenError,
      }
      return this.publishLockOutcome(outcome)
    }

    // STEP 3: Publish + side effect
    const outcome: LockOutcome = {
      status: "acquired",
      record: rec,
      token: token!,
      acquiredAtMs: Date.now(),
    }

    const canonical = this.publishLockOutcome(outcome)
    this.abortHealthFor(canonical) // Gated by canonical status
    return canonical
  }

  /**
   * onLockSettled — handler (§5.3.6)
   */
  private async onLockSettled(outcome: LockOutcome): Promise<void> {
    const canonical = this.consumeLockOutcome(outcome)
    if (!canonical) return // Duplicate or conflict

    // Late lease handling
    if (this.phase === "ABANDONED" && canonical.status === "acquired_post_deadline") {
      // Disposal already claimed in register()
      return
    }

    // Try commit if health is also published
    if (this.healthChannel.published) {
      await this.tryCommitResult()
    }
  }

  /**
   * onHealthSettled — handler (§5.3.7)
   */
  private async onHealthSettled(outcome: HealthOutcome): Promise<void> {
    const canonical = this.consumeHealthOutcome(outcome)
    if (!canonical) return

    // Try commit if lock is also published
    if (this.lockChannel.published) {
      await this.tryCommitResult()
    }
  }

  /**
   * tryCommitResult — rendezvous (§5.3.7)
   */
  private async tryCommitResult(): Promise<void> {
    if (this.commitInProgress) {
      this.commitReentrySuppressed++
      return
    }
    if (this.committed) return

    this.commitInProgress = true
    this.committed = true

    const lock = this.lockChannel.published!
    const health = this.healthChannel.published!

    // Classification logic (§5.3.7)
    const result = this.classifyResult(lock, health, "rendezvous")
    this.resultSignal.resolve(result)
  }

  /**
   * onDeadline — adjudicator (§5.3.9)
   */
  private onDeadline(): void {
    this.phase = "ABANDONED"
    this.abortLock.abort()
    this.abortHealth.abort()

    if (this.committed) return

    this.committed = true
    const result = this.adjudicate()
    this.resultSignal.resolve(result)
  }

  /**
   * adjudicate — deadline path (§5.3.9)
   */
  private adjudicate(): CoordinatorResult {
    const lock = this.lockChannel.published
    const health = this.healthChannel.published

    if (lock && health) {
      return this.classifyResult(lock, health, "deadline")
    }

    // Dispose all unclaimed leases
    const records = this.leases.getByRunId(this.runId)
    for (const rec of records) {
      const claim = this.leases.claimDispose(rec, "deadline_escrow")
      if (claim.claimed) {
        void this.disposeRecord(rec, "deadline_escrow")
      }
    }

    return { kind: "deadline", late: "pending", resolvedBy: "deadline" }
  }

  /**
   * classifyResult — outcome classification (§5.3.7)
   */
  private classifyResult(lock: LockOutcome, health: HealthOutcome, resolvedBy: Resolution): CoordinatorResult {
    // Health ready + lock acquired
    if (health.status === "ready" && lock.status === "acquired") {
      const claim = this.leases.claimTransfer(lock.record)
      if (claim.claimed) {
        return {
          kind: "health_with_lease",
          lease: lock.record.lease,
          token: lock.token,
          resolvedBy,
        }
      } else {
        // Transfer failed - dispose and return ownership_error
        void this.disposeRecord(lock.record, "ownership_commit_failed")
        return {
          kind: "ownership_error",
          lock: { status: "canonical_unavailable", record: lock.record },
          health,
          resolvedBy,
        }
      }
    }

    // Health ready (no lease or lease not acquired)
    if (health.status === "ready") {
      return { kind: "health", health, resolvedBy }
    }

    // Lock acquired, health failed
    if (lock.status === "acquired") {
      const claim = this.leases.claimTransfer(lock.record)
      if (claim.claimed) {
        return {
          kind: "lock",
          lease: lock.record.lease,
          token: lock.token,
          resolvedBy,
        }
      }
    }

    // Both rejected
    if (
      (lock.status === "timeout" || lock.status === "rejected") &&
      (health.status === "exhausted" || health.status === "aborted")
    ) {
      return { kind: "both_rejected", lock, health, resolvedBy: "rendezvous" }
    }

    // Fallback
    return { kind: "deadline", late: "none", resolvedBy }
  }

  /**
   * Publication/consumption protocol (R10, §5.3.12)
   */
  private publishLockOutcome(outcome: LockOutcome): LockOutcome {
    if (this.lockChannel.published) {
      this.lockChannel.conflictingPublications++
      void this.containConflictingOutcome(outcome)
      return this.lockChannel.published
    }

    this.lockChannel.published = outcome
    this.lockChannel.publishedAt = Date.now()
    return outcome
  }

  private consumeLockOutcome(outcome: LockOutcome): LockOutcome | null {
    if (this.lockChannel.consumed) {
      if (this.lockChannel.consumed === outcome) {
        this.lockChannel.duplicateCallbacks++
        return null
      } else {
        this.lockChannel.conflictingCallbacks++
        void this.containConflictingOutcome(outcome)
        return null
      }
    }

    const canonical = this.lockChannel.published
    if (!canonical) {
      // Handler-first publication
      this.lockChannel.published = outcome
      this.lockChannel.publishedAt = Date.now()
    } else if (canonical !== outcome) {
      this.lockChannel.conflictingCallbacks++
      void this.containConflictingOutcome(outcome)
      return null
    }

    this.lockChannel.consumed = canonical || outcome
    this.lockChannel.consumedAt = Date.now()
    return this.lockChannel.consumed
  }

  private publishHealthOutcome(outcome: HealthOutcome): HealthOutcome {
    if (this.healthChannel.published) {
      this.healthChannel.conflictingPublications++
      return this.healthChannel.published
    }

    this.healthChannel.published = outcome
    this.healthChannel.publishedAt = Date.now()
    return outcome
  }

  private consumeHealthOutcome(outcome: HealthOutcome): HealthOutcome | null {
    if (this.healthChannel.consumed) {
      if (this.healthChannel.consumed === outcome) {
        this.healthChannel.duplicateCallbacks++
        return null
      } else {
        this.healthChannel.conflictingCallbacks++
        return null
      }
    }

    const canonical = this.healthChannel.published
    if (!canonical) {
      this.healthChannel.published = outcome
      this.healthChannel.publishedAt = Date.now()
    } else if (canonical !== outcome) {
      this.healthChannel.conflictingCallbacks++
      return null
    }

    this.healthChannel.consumed = canonical || outcome
    this.healthChannel.consumedAt = Date.now()
    return this.healthChannel.consumed
  }

  /**
   * Canonical-gated abort helpers (R12, §5.3.15)
   */
  private abortHealthFor(canonical: LockOutcome): void {
    if (this.abortedHealth) {
      this.duplicateAborts++
      return
    }

    // Whitelist: only "acquired" status triggers abort
    if (canonical.status !== "acquired") {
      return
    }

    this.abortedHealth = true
    this.abortHealth.abort()
  }

  private abortLockFor(canonical: HealthOutcome): void {
    if (this.abortedLock) {
      this.duplicateAborts++
      return
    }

    // Whitelist: only "ready" status triggers abort
    if (canonical.status !== "ready") {
      return
    }

    this.abortedLock = true
    this.abortLock.abort()
  }

  /**
   * Containment (R11, §5.3.14)
   */
  private async containConflictingOutcome(outcome: LockOutcome): Promise<void> {
    if (outcome.status === "acquired" || outcome.status === "acquired_post_deadline") {
      const claim = this.leases.claimDispose(outcome.record, "conflicting_publication")
      if (claim.claimed) {
        await this.disposeRecord(outcome.record, "conflicting_publication")
      }
    }
  }

  /**
   * disposeRecord — single cleanup path
   */
  private async disposeRecord(record: LeaseRecord, reason: string): Promise<CleanupOutcome> {
    const outcome = await this.cleanup.cleanupLease(record.lease, {
      token: record.token,
      lockDir: this.lockDir,
      reason,
    })

    this.leases.memoiseCleanup(record, outcome)
    record.releaseCount++
    return outcome
  }

  /**
   * onHandlerFailure — containment (§5.3.14)
   */
  private onHandlerFailure(where: string, err: unknown): void {
    console.error(`INTERNAL_DISPOSITION_ERROR in ${where}:`, err)

    if (!this.committed) {
      this.phase = "ABANDONED"
      const records = this.leases.disposeAllUnclaimed(this.runId, "handler_failure")
      for (const rec of records) {
        void this.disposeRecord(rec, "handler_failure")
      }
      this.committed = true
      this.resultSignal.resolve({ kind: "deadline", late: "pending", resolvedBy: "deadline" })
    }
  }

  /**
   * Helpers
   */
  private diagnoseTokenInBackground(rec: LeaseRecord): void {
    void (async () => {
      try {
        const token = await readLockToken(this.lockDir)
        rec.markToken(token)
      } catch (err) {
        rec.markTokenFailed(err)
      }
    })()
  }

  private isFlockTimeout(err: unknown): boolean {
    return err instanceof Error && err.message.includes("Timed out waiting for lock")
  }

  private createChannel<T>(): Channel<T> {
    return {
      published: null,
      publishedAt: null,
      consumed: null,
      consumedAt: null,
      duplicateCallbacks: 0,
      conflictingPublications: 0,
      conflictingCallbacks: 0,
    }
  }
}

type Resolution = "rendezvous" | "deadline"

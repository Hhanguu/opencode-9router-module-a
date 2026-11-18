/**
 * MODULE A — 9Router Service Manager
 * Revision 17 — Implementation
 * 
 * Public API (§3):
 * - status(): RuntimeStatus
 * - ensure(): EnsureResult
 * - shutdown(): ShutdownResult
 * 
 * Integration points (§6):
 * - Lazy init via handler layer
 * - Finalizer registration for shutdown
 * - Single-flight ensure() with mutex
 */

import path from "path"
import { Flock } from "@opencode/util/flock"
import type {
  RuntimeStatus,
  EnsureResult,
  ShutdownResult,
  OwnershipState,
  Lease,
} from "./types.js"
import { CONSTANTS } from "./types.js"
import { OwnershipManager, CleanupService } from "./ownership.js"
import { AcquisitionCoordinator } from "./coordinator.js"
import {
  checkDockerAvailable,
  checkPortConflict,
  composeUp,
  composeStop,
  isContainerRunning,
  type ComposeConfig,
} from "./compose.js"

/**
 * NineRouterService configuration
 */
export interface NineRouterServiceConfig {
  stateDir: string
  port?: number
  dockerProject?: string
  composeFile?: string
  startMode?: "lazy" | "eager"
}

/**
 * NineRouterService — public service interface (§3)
 */
export class NineRouterService {
  private state: RuntimeStatus = "UNKNOWN"
  private ownership: OwnershipManager
  private cleanup: CleanupService
  private composeConfig: ComposeConfig

  // Single-flight ensure
  private ensureMutex: Promise<EnsureResult> | null = null
  private ensureCount = 0

  // Config
  private readonly stateDir: string
  private readonly lockKey = "nine-router-service"
  private readonly lockDir: string
  private readonly baseURL: string

  constructor(config: NineRouterServiceConfig) {
    this.stateDir = config.stateDir
    this.lockDir = path.join(this.stateDir, "locks")

    const port = config.port ?? 20128
    const dockerProject = config.dockerProject ?? "9router"
    const composeFile = config.composeFile ?? path.join(__dirname, "../../../../../docker-compose.yml")

    this.baseURL = `http://127.0.0.1:${port}`
    this.composeConfig = {
      project: dockerProject,
      composeFile,
      baseURL: this.baseURL,
      port,
    }

    this.ownership = new OwnershipManager(this.stateDir, dockerProject, this.baseURL)
    this.cleanup = new CleanupService(this.stateDir)

    // Initialize Flock global
    Flock.setGlobal({ state: this.stateDir })
  }

  /**
   * Get current status (§3)
   */
  status(): RuntimeStatus {
    return this.state
  }

  /**
   * Ensure 9router is running (§3, §5.3)
   * Single-flight, idempotent
   */
  async ensure(): Promise<EnsureResult> {
    // Single-flight guard
    if (this.ensureMutex) {
      return this.ensureMutex
    }

    this.ensureCount++
    const ensurePromise = this.ensureImpl()
    this.ensureMutex = ensurePromise

    try {
      return await ensurePromise
    } finally {
      this.ensureMutex = null
    }
  }

  /**
   * Shutdown 9router if we own it (§3, §5.4)
   */
  async shutdown(): Promise<ShutdownResult> {
    const ownershipState = this.ownership.getState()

    if (!ownershipState.owned) {
      return { kind: "not_owner" }
    }

    if (!ownershipState.lease || !ownershipState.token || !ownershipState.lockDir) {
      return { kind: "not_owner" }
    }

    // Stop container with verify-then-act
    const stopResult = await composeStop(this.composeConfig, {
      lockToken: ownershipState.token,
      lockDir: ownershipState.lockDir,
    })

    if (!stopResult.success) {
      console.warn("Failed to stop container:", stopResult.error)
    }

    // Release lock with cleanup
    const cleanupResult = await this.cleanup.cleanupLease(ownershipState.lease, {
      token: ownershipState.token,
      lockDir: ownershipState.lockDir,
      reason: "shutdown",
    })

    this.ownership.clearOwnership()
    this.state = "STOPPED"

    // Map cleanup result to shutdown result
    if (cleanupResult.status === "released") {
      return { kind: "released" }
    }

    if (cleanupResult.status === "foreign") {
      return { kind: "foreign_owner" }
    }

    if (cleanupResult.status === "reclaimed") {
      return { kind: "released" }
    }

    if (cleanupResult.status === "unconfirmed") {
      if (cleanupResult.recovery === "persisted") {
        return {
          kind: "cleanup_pending",
          attempts: cleanupResult.attempts,
        }
      } else {
        return {
          kind: "cleanup_failed_unpersisted",
          attempts: cleanupResult.attempts,
          code: "RECORD_WRITE_FAILED",
        }
      }
    }

    return { kind: "not_owner" }
  }

  /**
   * Implementation of ensure() (§5.3)
   */
  private async ensureImpl(): Promise<EnsureResult> {
    this.state = "STARTING"

    // 1. Check Docker availability
    const dockerAvailable = await checkDockerAvailable()
    if (!dockerAvailable) {
      this.state = "STOPPED"
      return { kind: "docker_missing" }
    }

    // 2. Check port conflict
    const portCheck = await checkPortConflict(this.composeConfig.port, this.baseURL)
    if (portCheck.conflict && portCheck.is9router) {
      // 9router already running, try to adopt
      this.state = "RUNNING"
      return { kind: "already_running", owner: false }
    }

    if (portCheck.conflict && !portCheck.is9router) {
      this.state = "DEGRADED"
      return { kind: "port_conflict" }
    }

    // 3. Run acquisition coordinator
    const coordinator = new AcquisitionCoordinator(
      this.baseURL,
      this.lockKey,
      this.lockDir,
      this.stateDir,
    )

    let coordinatorResult
    try {
      coordinatorResult = await coordinator.run()
    } catch (err) {
      this.state = "DEGRADED"
      return { kind: "deadline" }
    }

    // 4. Handle coordinator result
    return this.handleCoordinatorResult(coordinatorResult)
  }

  /**
   * Handle coordinator result and start container if needed
   */
  private async handleCoordinatorResult(result: any): Promise<EnsureResult> {
    // Lock acquired, need to start
    if (result.kind === "lock") {
      const lease: Lease = result.lease
      const token: string = result.token

      // Commit ownership
      try {
        await this.ownership.commitOwnership(lease, token, this.lockDir)
      } catch (err) {
        // Record write failed
        const cleanupResult = await this.cleanup.cleanupLease(lease, {
          token,
          lockDir: this.lockDir,
          reason: "ownership_commit_failed",
        })

        this.state = "DEGRADED"
        return { kind: "ownership_error", cleanup: cleanupResult }
      }

      // Start container
      const startResult = await composeUp(this.composeConfig, {
        lockToken: token,
        lockDir: this.lockDir,
      })

      if (!startResult.success) {
        this.state = "DEGRADED"
        return { kind: "start_timeout" }
      }

      // Wait for health check
      const healthy = await this.waitForHealth(10_000)
      if (healthy) {
        this.state = "RUNNING"
        return { kind: "started", owner: true }
      } else {
        this.state = "DEGRADED"
        return { kind: "start_timeout" }
      }
    }

    // Health ready, no lock needed
    if (result.kind === "health") {
      this.state = "RUNNING"
      return { kind: "running", owner: false }
    }

    // Health ready + lock acquired
    if (result.kind === "health_with_lease") {
      const lease: Lease = result.lease
      const token: string = result.token

      try {
        await this.ownership.commitOwnership(lease, token, this.lockDir)
        this.state = "RUNNING"
        return { kind: "adopted", owner: false }
      } catch (err) {
        const cleanupResult = await this.cleanup.cleanupLease(lease, {
          token,
          lockDir: this.lockDir,
          reason: "ownership_commit_failed",
        })

        this.state = "RUNNING"
        return { kind: "running", owner: false }
      }
    }

    // Both rejected
    if (result.kind === "both_rejected") {
      this.state = "DEGRADED"
      return { kind: "deadline" }
    }

    // Deadline
    if (result.kind === "deadline") {
      this.state = "DEGRADED"
      return { kind: "deadline" }
    }

    // Ownership error
    if (result.kind === "ownership_error") {
      this.state = "DEGRADED"
      if (result.lock && typeof result.lock === "object" && "cleanup" in result.lock) {
        return { kind: "ownership_error", cleanup: result.lock.cleanup as any }
      }
      return { kind: "deadline" }
    }

    // Fallback
    this.state = "DEGRADED"
    return { kind: "deadline" }
  }

  /**
   * Wait for health check with timeout
   */
  private async waitForHealth(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    const interval = 500

    while (Date.now() < deadline) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 1000)

        const response = await fetch(`${this.baseURL}/v1/models`, {
          signal: controller.signal,
        })

        clearTimeout(timeout)

        if (response.ok) {
          const data = await response.json()
          if (data && typeof data === "object" && "data" in data) {
            return true
          }
        }
      } catch {
        // Continue trying
      }

      await new Promise((resolve) => setTimeout(resolve, interval))
    }

    return false
  }
}

/**
 * Factory function for Effect integration
 */
export function createNineRouterService(config: NineRouterServiceConfig): NineRouterService {
  return new NineRouterService(config)
}

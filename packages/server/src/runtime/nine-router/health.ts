/**
 * MODULE A — Health Probe and State Machine
 * Revision 17 — Implementation
 * 
 * Implements:
 * - Bounded health polling with two independent bounds (§5.3.5)
 * - State classification (Ready/KeyRejected/Stopped)
 * - Abort-aware polling loop
 */

import type { HealthOutcome } from "./types.js"
import { CONSTANTS } from "./types.js"

export interface HealthProbeResult {
  status: "Ready" | "KeyRejected" | "Stopped"
}

/**
 * Health probe — bounded polling (§5.3.5)
 * 
 * Two independent bounds:
 * 1. HEALTH_MAX_ATTEMPTS — clock-independent
 * 2. HEALTH_DEADLINE_MS — wall budget
 */
export async function healthBranch(
  baseURL: string,
  signal: AbortSignal,
  onAbort: () => void,
): Promise<HealthOutcome> {
  const { HEALTH_MAX_ATTEMPTS, HEALTH_DEADLINE_MS, HEALTH_PROBE_TIMEOUT_MS, HEALTH_INTERVAL_MS } = CONSTANTS

  const deadlineAt = Date.now() + HEALTH_DEADLINE_MS
  let attempts = 0
  let lastError: unknown

  while (attempts < HEALTH_MAX_ATTEMPTS) {
    // Check abort signal
    if (signal.aborted) {
      return { status: "aborted", attempts, lastError }
    }

    // Check wall budget
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) break

    attempts++
    const budget = Math.min(HEALTH_PROBE_TIMEOUT_MS, remaining)

    try {
      const result = await probeHealth(baseURL, budget, signal)
      if (result.status === "Ready" || result.status === "KeyRejected") {
        return { status: "ready", health: result.status, attempts }
      }
    } catch (err) {
      if (signal.aborted) {
        return { status: "aborted", attempts, lastError: err }
      }
      lastError = err
    }

    // Sleep with abort check
    const nap = Math.min(HEALTH_INTERVAL_MS, deadlineAt - Date.now())
    if (nap > 0) {
      try {
        await sleepAbortable(nap, signal)
      } catch (err) {
        if (signal.aborted) {
          return { status: "aborted", attempts, lastError: err }
        }
        lastError = err
      }
    }
  }

  return { status: "exhausted", attempts, lastError }
}

/**
 * Probe /v1/models endpoint (§5.3.5, Q5)
 * No authentication required for readiness check
 */
async function probeHealth(baseURL: string, timeoutMs: number, signal: AbortSignal): Promise<HealthProbeResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  // Combine signals
  const abortHandler = () => controller.abort()
  signal.addEventListener("abort", abortHandler)

  try {
    const response = await fetch(`${baseURL}/v1/models`, {
      method: "GET",
      signal: controller.signal,
    })

    if (response.ok) {
      const data = await response.json()
      // Check for valid models response
      if (data && typeof data === "object" && "data" in data && Array.isArray(data.data)) {
        return { status: "Ready" }
      }
    }

    // 401/403 means service is up but key is missing/invalid
    if (response.status === 401 || response.status === 403) {
      return { status: "KeyRejected" }
    }

    // Other non-200 responses
    return { status: "Stopped" }
  } catch (err) {
    // Connection refused, timeout, etc.
    return { status: "Stopped" }
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener("abort", abortHandler)
  }
}

/**
 * Sleep with abort support
 */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Aborted"))
      return
    }

    let timer: NodeJS.Timeout | undefined

    const done = () => {
      signal.removeEventListener("abort", abort)
      resolve()
    }

    const abort = () => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(new Error("Aborted"))
    }

    signal.addEventListener("abort", abort, { once: true })
    timer = setTimeout(done, ms)
  })
}

/**
 * Read lock token from meta.json (§5.3.4)
 */
export async function readLockToken(lockDir: string): Promise<string> {
  const { readFile } = await import("fs/promises")
  const metaPath = require("path").join(lockDir, "meta.json")
  const content = await readFile(metaPath, "utf8")
  const meta = JSON.parse(content)

  if (!meta || typeof meta !== "object" || typeof meta.token !== "string") {
    throw new Error("Invalid meta.json: missing token")
  }

  return meta.token
}

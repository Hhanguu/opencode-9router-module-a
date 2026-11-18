/**
 * MODULE A — Unit Tests
 * Basic smoke tests for core components
 */

import { describe, test, expect } from "bun:test"
import { LeaseRegistry, CleanupService } from "../ownership.js"
import type { Lease } from "../types.js"

describe("LeaseRegistry", () => {
  test("registers a lease and returns a record", () => {
    const registry = new LeaseRegistry()
    const mockLease: Lease = {
      async release() {},
      async [Symbol.asyncDispose]() {},
    }

    const record = registry.register(mockLease, {
      origin: "coordinator",
      runId: 1,
      phase: "RUNNING",
    })

    expect(record).toBeDefined()
    expect(record.id).toBeDefined()
    expect(record.lease).toBe(mockLease)
    expect(record.state).toBe("LEASE_ACQUIRED_TOKEN_PENDING")
    expect(record.origin).toBe("coordinator")
  })

  test("phase-aware registration in ABANDONED phase", () => {
    const registry = new LeaseRegistry()
    const mockLease: Lease = {
      async release() {},
      async [Symbol.asyncDispose]() {},
    }

    const record = registry.register(mockLease, {
      origin: "coordinator",
      runId: 1,
      phase: "ABANDONED",
    })

    expect(record.state).toBe("LEASE_DISPOSING")
  })

  test("claimTransfer succeeds once, fails on retry", () => {
    const registry = new LeaseRegistry()
    const mockLease: Lease = {
      async release() {},
      async [Symbol.asyncDispose]() {},
    }

    const record = registry.register(mockLease, {
      origin: "coordinator",
      runId: 1,
      phase: "RUNNING",
    })

    // First claim succeeds
    const claim1 = registry.claimTransfer(record)
    expect(claim1.claimed).toBe(true)

    // Second claim fails
    const claim2 = registry.claimTransfer(record)
    expect(claim2.claimed).toBe(false)
  })

  test("claimDispose succeeds once, returns memoised outcome on retry", () => {
    const registry = new LeaseRegistry()
    const mockLease: Lease = {
      async release() {},
      async [Symbol.asyncDispose]() {},
    }

    const record = registry.register(mockLease, {
      origin: "coordinator",
      runId: 1,
      phase: "RUNNING",
    })

    // First claim succeeds
    const claim1 = registry.claimDispose(record, "test_reason")
    expect(claim1.claimed).toBe(true)

    // Memoise outcome
    const outcome = { status: "released" as const }
    registry.memoiseCleanup(record, outcome)

    // Second claim returns memoised
    const claim2 = registry.claimDispose(record, "test_reason")
    expect(claim2.claimed).toBe(false)
    expect("memoised" in claim2 && claim2.memoised).toEqual(outcome)
  })

  test("markToken updates state", () => {
    const registry = new LeaseRegistry()
    const mockLease: Lease = {
      async release() {},
      async [Symbol.asyncDispose]() {},
    }

    const record = registry.register(mockLease, {
      origin: "coordinator",
      runId: 1,
      phase: "RUNNING",
    })

    expect(record.token).toBeNull()
    expect(record.state).toBe("LEASE_ACQUIRED_TOKEN_PENDING")

    record.markToken("test-token-123")

    expect(record.token).toBe("test-token-123")
    expect(record.state).toBe("LEASE_TOKEN_KNOWN")
  })

  test("markTokenFailed updates state", () => {
    const registry = new LeaseRegistry()
    const mockLease: Lease = {
      async release() {},
      async [Symbol.asyncDispose]() {},
    }

    const record = registry.register(mockLease, {
      origin: "coordinator",
      runId: 1,
      phase: "RUNNING",
    })

    record.markTokenFailed(new Error("Token read failed"))

    expect(record.state).toBe("LEASE_TOKEN_FAILED")
  })
})

describe("CleanupService", () => {
  test("constructs without error", () => {
    const cleanup = new CleanupService("/tmp/test-state")
    expect(cleanup).toBeDefined()
  })
})

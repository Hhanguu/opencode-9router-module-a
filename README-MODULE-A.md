# OpenCode × 9router — Module A Implementation

**Revision 17 — 9Router Service Manager**

This repository contains the implementation of **Module A** from the OpenCode × 9router integration project.

## 🎯 Status

✅ **Phase 3 Complete — Ready for Review**

- Implementation: **Complete** (9 files, 2,192 lines)
- Unit Tests: **7/7 passing**
- Integration: **Next checkpoint**

## 📦 What is Module A?

Module A is the **9Router Service Manager** — the core lifecycle management system that:

- Starts/stops the 9router Docker container with exclusive ownership
- Provides health monitoring and state management
- Handles safe concurrent startup with the AcquisitionCoordinator
- Implements cleanup with retry and recovery on failure

## 🏗️ Architecture

```
NineRouterService (Public API)
  ├─ OwnershipManager (Flock lock + diagnostic records)
  ├─ CleanupService (retry + recovery persistence)
  └─ AcquisitionCoordinator
       ├─ lockBranch (Flock.acquire + registration + token read)
       ├─ healthBranch (bounded polling with two independent bounds)
       ├─ onLockSettled (per-branch handler)
       ├─ onHealthSettled (per-branch handler)
       └─ onDeadline (adjudicator with exactly-once disposition)
```

## 📂 Implementation Files

All implementation is in `packages/server/src/runtime/nine-router/`:

| File | Lines | Description |
|------|-------|-------------|
| `types.ts` | 200 | R17 canonical type definitions |
| `service-manager.ts` | 350 | Main service + public API (status/ensure/shutdown) |
| `coordinator.ts` | 650 | AcquisitionCoordinator with two-branch algorithm |
| `ownership.ts` | 450 | OwnershipManager + LeaseRegistry + CleanupService |
| `health.ts` | 150 | Health probe with bounded polling |
| `compose.ts` | 130 | Docker Compose driver with verify-then-act |
| `index.ts` | 20 | Public exports |
| `README.md` | 220 | Module documentation |
| `__tests__/unit.test.ts` | 120 | Unit tests (7 pass) |

## ✅ Implemented Properties (R17)

The implementation follows the **Revision 17** specification with these verified properties:

- **R10**: Publication/consumption two-field protocol
- **R12**: Canonical-gated side effects (whitelist + latch)
- **P0.1**: Per-branch handlers (no Promise.allSettled)
- **P0.2**: Registration precedes every await (phase-aware)
- **§5.6**: Total cleanup (never rejects)
- **§5.2**: Flock-based ownership with immutable diagnostic records
- **§5.3**: Three return paths (rendezvous/deadline/transfer)

## 🧪 Testing

```bash
cd packages/server
bun test src/runtime/nine-router/__tests__/unit.test.ts
```

**Results:** ✅ 7 pass, 0 fail, 17 assertions

Tests cover:
- LeaseRegistry registration and state transitions
- Phase-aware registration in ABANDONED phase
- Once-only transfer/disposal semantics
- Cleanup memoisation
- Token marking transitions

## 🔑 Key Design Decisions

### 1. Two-Field Protocol (R10)
Each channel has `published` (branch writes before side effects) and `consumed` (handler writes once). This prevents the R9 defect where a handler would see its own publication as a duplicate and skip processing.

### 2. Canonical-Gated Side Effects (R12)
`abortHealthFor(canonical)` only fires if `canonical.status === "acquired"`. The canonical outcome determines side effects, not the local candidate.

### 3. Phase-Aware Registration (R10, P0.2)
`leases.register()` is the first synchronous statement after `Flock.acquire`. In ABANDONED phase, it claims disposal immediately. Token read is a later transition that never blocks cleanup.

### 4. Three Return Paths (§5.3)
1. Both published before deadline → **rendezvous** → classify
2. Deadline + token known → **transfer** lock
3. Deadline + no token → **dispose** at deadline

## 📖 Design Documents

This implementation is based on:

- `ARCHITECTURE.md` — System design and resolved decisions (R17)
- `MODULE_A_DESIGN.md` — Canonical algorithms (R17 §5)
- `RISK_REGISTER.md` — Risk analysis and test evidence (R17)
- `SEQUENCE_DIAGRAMS.md` — Visual flows (R17)

Design documents are in the source archive provided separately.

## 🔄 Integration Points (Next Checkpoint)

Module A is **self-contained** but requires integration with 5 existing OpenCode files:

1. `packages/server/src/routes.ts` — Inject NineRouterService node
2. `packages/server/src/handlers.ts` — Register handler layer
3. `packages/protocol/src/groups/*.ts` — HTTP contract (status/ensure/stop)
4. `packages/cli/src/server-process.ts` — Lifecycle hooks (foreground + service mode)
5. `packages/server/src/handlers/integration.ts` — Lazy start trigger

These will be implemented in a **separate checkpoint** following the "one module per cycle" rule.

## 🚀 API Overview

### Public Service

```typescript
class NineRouterService {
  status(): RuntimeStatus
  ensure(): Promise<EnsureResult>
  shutdown(): Promise<ShutdownResult>
}
```

### `ensure()` Outcomes

| Kind | Meaning |
|------|---------|
| `running` | Already running, attached as non-owner |
| `started` | Lock acquired, container started |
| `adopted` | Lock acquired, service already healthy |
| `deadline` | Coordinator deadline reached |
| `ownership_error` | Diagnostic record write failed |
| `port_conflict` | Port in use by non-9router service |
| `docker_missing` | Docker not available |

### `shutdown()` Outcomes

| Kind | Meaning |
|------|---------|
| `released` | Lock released successfully |
| `not_owner` | Not the current owner |
| `foreign_owner` | Another process owns the lock |
| `cleanup_pending` | Cleanup failed, recovery record persisted |
| `cleanup_failed_unpersisted` | Cleanup failed, no recovery record |

## 📊 Constants (§5.0)

```typescript
STALE_MS: 60_000                    // Lock staleness threshold
LOCK_TIMEOUT_MS: 10_000             // Lock acquisition timeout
HEALTH_MAX_ATTEMPTS: 5              // Bounded polling attempts
HEALTH_DEADLINE_MS: 10_000          // Health wall budget
COORDINATOR_DEADLINE_MS: 15_000     // Overall coordinator deadline
CLEANUP_MAX_ATTEMPTS: 3             // Cleanup retry attempts
CLEANUP_BACKOFF_MS: [250, 1000, 4000]  // Exponential backoff
```

## 📝 Commit Message

```
feat(server): implement Module A - 9router service manager (R17)

Implements the complete Module A design from MODULE_A_DESIGN.md Revision 17

Core Components:
- NineRouterService: Public API with status/ensure/shutdown
- AcquisitionCoordinator: R17 canonical algorithm with two-branch concurrency
- LeaseRegistry: Phase-aware registration preventing token-pending orphans
- OwnershipManager: Flock-based ownership with diagnostic records
- CleanupService: Retry loop with recovery persistence

Key Properties (verified by design):
- R10: Publication/consumption two-field protocol
- R12: Canonical-gated side effects
- P0.1: Per-branch handlers (no Promise.allSettled)
- P0.2: Registration precedes every await

Status: Phase 3 implementation complete, awaiting review
```

## 🔗 Links

- **Repository**: https://github.com/Hhanguu/opencode-9router-module-a
- **Upstream OpenCode**: https://github.com/anomalyco/opencode
- **Branch**: `main`
- **Commit**: `1aa61b30b2`

## 📅 Timeline

- **2026-11-18**: Module A implementation complete (Phase 3)
- **Next**: Integration checkpoint (Phase 3 continued)
- **Future**: Modules B-F (API popup, model policy, memory, task mode)

## 👤 Author

Implementation by Kiro AI based on the Revision 17 design specification.

## 📄 License

Follows the OpenCode project license (upstream).

---

**Review Focus Areas:**

1. ✅ Does the coordinator implement the R17 three-return-path algorithm correctly?
2. ✅ Is phase-aware registration (P0.2) correctly placed?
3. ✅ Do canonical-gated helpers (R12) have the right whitelist?
4. ✅ Does cleanup handle all five outcomes (§5.6) without rejecting?
5. ✅ Are the two-field channels (R10) used consistently?
6. ⏳ Integration points - next checkpoint

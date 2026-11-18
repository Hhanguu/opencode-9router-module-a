# Module A — 9Router Service Manager

**Revision 17 — Implementation**

Phase 3 deliverable implementing the design from `MODULE_A_DESIGN.md` R17.

## Overview

Module A provides lifecycle management for the 9router service with:

- **Flock-based ownership** with token-checked release (§5.2)
- **Concurrent acquisition coordinator** with two branches (§5.3)
- **Phase-aware LeaseRegistry** preventing token-pending orphans (§5.3.8, §5.3.13)
- **Cleanup with retry and recovery** persistence (§5.6)
- **Canonical-gated side effects** preventing conflicting-outcome processing (R12)
- **Publication/consumption two-field protocol** (R10)

## Architecture

```
NineRouterService
  ├─ OwnershipManager (Flock lock + diagnostic records)
  ├─ CleanupService (retry + recovery persistence)
  └─ AcquisitionCoordinator
       ├─ lockBranch (Flock.acquire + registration + token read)
       ├─ healthBranch (bounded polling)
       ├─ onLockSettled (per-branch handler)
       ├─ onHealthSettled (per-branch handler)
       └─ onDeadline (adjudicator)
```

## API

### `NineRouterService`

```typescript
class NineRouterService {
  status(): RuntimeStatus
  ensure(): Promise<EnsureResult>
  shutdown(): Promise<ShutdownResult>
}
```

### `ensure()` — Outcomes

| Kind | Meaning |
|------|---------|
| `running` | Already running, attached as non-owner |
| `already_running` | 9router listening, adopted without lock |
| `adopted` | Lock acquired, service already healthy |
| `started` | Lock acquired, container started successfully |
| `deadline` | Coordinator deadline reached |
| `start_timeout` | Container failed to become healthy |
| `ownership_error` | Diagnostic record write failed |
| `port_conflict` | Port in use by non-9router service |
| `docker_missing` | Docker not available |

### `shutdown()` — Outcomes

| Kind | Meaning |
|------|---------|
| `released` | Lock released successfully |
| `not_owner` | Not the current owner |
| `foreign_owner` | Another process owns the lock |
| `cleanup_pending` | Cleanup failed, recovery record persisted |
| `cleanup_failed` | Cleanup failed, recovery record persisted |
| `cleanup_failed_unpersisted` | Cleanup failed, no recovery record |

## File Structure

```
packages/server/src/runtime/nine-router/
├── index.ts              # Public API exports
├── types.ts              # Type definitions from R17 spec
├── service-manager.ts    # Main service + ensure() implementation
├── coordinator.ts        # AcquisitionCoordinator (§5.3)
├── ownership.ts          # OwnershipManager + LeaseRegistry + CleanupService
├── health.ts             # Health probe with bounded polling
├── compose.ts            # Docker Compose driver
└── __tests__/
    └── unit.test.ts      # Unit tests
```

## Constants (§5.0)

```typescript
STALE_MS: 60_000
LOCK_TIMEOUT_MS: 10_000
TRY_LOCK_TIMEOUT_MS: 500
HEALTH_MAX_ATTEMPTS: 5
HEALTH_PROBE_TIMEOUT_MS: 1_500
HEALTH_INTERVAL_MS: 2_000
HEALTH_DEADLINE_MS: 10_000
COORDINATOR_DEADLINE_MS: 15_000
CLEANUP_MAX_ATTEMPTS: 3
CLEANUP_BACKOFF_MS: [250, 1000, 4000]
```

## State Machine (§5.1)

```
UNKNOWN ──probe──▶ STOPPED ──ensure──▶ STARTING ──ready──▶ RUNNING
   ▲                  ▲                    │                  │
   │                  │                    │ fail             │ health fail
   └──────────────────┴────────────────────┘                  ▼
                        ◀──────── DEGRADED ◀─────────────── DEGRADED
```

## Coordinator Algorithm (§5.3)

1. **Start both branches** concurrently
2. **Attach per-branch handlers** (no Promise.allSettled)
3. **Arm deadline** (15s)
4. **Three return paths:**
   - Both published before deadline → rendezvous → classify
   - Deadline + token known → transfer lock
   - Deadline + no token → dispose at deadline

## Safety Properties

### R10 — Publication/Consumption Separation

- `published` — written by branch before side effects
- `consumed` — written by handler at first invocation
- Handlers process `published`, never their argument directly

### R12 — Canonical-Gated Side Effects

- `abortHealthFor(canonical)` — only if `canonical.status === "acquired"`
- `abortLockFor(canonical)` — only if `canonical.status === "ready"`
- Conflicting outcomes are contained, never processed

### P0.2 — Registration Precedes Every Await

- `leases.register()` is the first synchronous statement after `Flock.acquire`
- Phase-aware: ABANDONED at register() → immediate disposal claim
- Token read is a later transition, never blocks cleanup

## Testing

Run unit tests:

```bash
cd packages/server
bun test src/runtime/nine-router/__tests__/unit.test.ts
```

## Integration Points (§6)

Module A touches 5 existing files (implementation in Module A checkpoint):

1. `packages/server/src/routes.ts` — inject service node
2. `packages/server/src/handlers.ts` — register handler layer
3. `packages/protocol/src/groups/*.ts` — HTTP contract
4. `packages/cli/src/server-process.ts` — lifecycle hooks
5. `packages/server/src/handlers/integration.ts` — lazy start trigger

## References

- `ARCHITECTURE.md` — System design (R17)
- `MODULE_A_DESIGN.md` — Canonical algorithms (R17 §5)
- `RISK_REGISTER.md` — Risk analysis and test evidence (R17)
- `SEQUENCE_DIAGRAMS.md` — Visual flows (R17)

## Status

**Phase 3 — Implementation complete, awaiting review**

- [x] Core types (types.ts)
- [x] Ownership and LeaseRegistry (ownership.ts)
- [x] Health probe (health.ts)
- [x] AcquisitionCoordinator (coordinator.ts)
- [x] Docker Compose driver (compose.ts)
- [x] NineRouterService (service-manager.ts)
- [x] Unit tests
- [ ] Integration with server routes (next checkpoint)
- [ ] Protocol definitions (next checkpoint)
- [ ] Handler layer (next checkpoint)
- [ ] Integration tests
- [ ] Full test matrix (T1-T83)

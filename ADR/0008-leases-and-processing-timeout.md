# ADR 0008 — Job/conversation leases and orchestrator deadline

**Status:** Accepted (Phase 2A)  
**Date:** 2026-08-26

## Context

Workers must not hold a database transaction open during LLM or Graph I/O. Two workers must not run the same conversation state machine. A crashed worker must not block a job forever.

## Decision

- `ORCHESTRATOR_DEADLINE_MS = 45_000` — hard abort of orchestrator work; no mutation commit after abort.
- `LEASE_TTL_MS = 75_000` (deadline + 30s margin). Applied to inbound job locks, outbound job locks, and conversation leases.
- No heartbeat in Phase 2A. A second worker may steal a lease only after `lock_expires_at` / `lease_expires_at`.
- Each attempt uses a unique `lease_token`. A static `workerId` cannot re-enter an unexpired lease.
- Mutations `UPDATE … WHERE lease_token = $attempt AND lock_version = $v`; zero rows discards in-memory results. Planning is side-effect-free. AbortSignal cancels AI/Graph work at the deadline.

## Consequences

Legitimate processing must finish before the deadline. Hung workers become claimable after TTL.

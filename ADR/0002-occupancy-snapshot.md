# ADR 0002 — Appointment occupancy snapshot

**Status:** Accepted (Phase 1)  
**Date:** 2026-08-26

## Context

Availability and double-booking must agree. Service duration and buffers can change after an appointment is created. If occupancy is always derived from the current catalog, historical bookings and the GiST constraint would silently move.

## Decision

Persist four timestamps on `appointments`: `start_at`, `end_at`, `occupied_start_at`, `occupied_end_at`. Compute occupied bounds at create/reschedule from the service rules then in force. `SchedulingService` and `EXCLUDE USING gist (... tstzrange(occupied_start_at, occupied_end_at, '[)'))` both use the stored occupied interval.

Catalog updates do not rewrite existing appointment occupancy.

## Consequences

- Reschedule recalculates occupancy for the new slot only.
- Reporting “duration” for old visits uses `end_at - start_at`, not the current service row.

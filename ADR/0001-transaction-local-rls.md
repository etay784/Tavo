# ADR 0001 — Transaction-local tenant setting for RLS

**Status:** Accepted (Phase 1)  
**Date:** 2026-08-26

## Context

RLS policies need a trusted tenant id. Node and PgBouncer pool connections across requests. A session-level `SET app.tenant_id` can leak from Tenant A to Tenant B on connection reuse.

## Decision

Set tenant context with `SET LOCAL` (or `set_config('app.tenant_id', $1, true)` — third argument `is_local = true`) as the first statement of each transaction that touches tenant data. Do not use session-level `SET` for `app.tenant_id`.

Prisma (or the driver) must run this in the same interactive transaction as subsequent queries.

## Consequences

- Every tenant-scoped repository operation runs inside a transaction, including reads.
- Tests must use pooling and prove no leak.
- Slightly more `BEGIN`/`COMMIT` than a naïve connection-per-request with session SET.

## Alternatives rejected

- Session `SET` + `RESET` in `finally`: easy to skip on errors/timeouts; still races if `RESET` is missed.
- Passing tenant only in `WHERE` without RLS: weaker defense in depth.
- Separate database per tenant: out of scope for Phase 1.

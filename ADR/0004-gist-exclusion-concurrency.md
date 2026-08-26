# ADR 0004 — GiST exclusion is the concurrency authority

**Status:** Accepted (Phase 1)  
**Date:** 2026-08-26

## Context

Check-then-insert races cause double booking. Advisory locks can serialize calendars but are easy to apply inconsistently (wrong lock key, forgotten path, statement vs transaction).

## Decision

Do not use advisory locks in Phase 1. Require:

```sql
EXCLUDE USING gist (
  tenant_id WITH =,
  staff_id WITH =,
  tstzrange(occupied_start_at, occupied_end_at, '[)') WITH &&
)
WHERE (status = 'CONFIRMED');
```

with `btree_gist` in a versioned migration. Map `23P01` to `SLOT_NO_LONGER_AVAILABLE`.

## Consequences

Exactly one overlapping `CONFIRMED` insert/update per tenant+staff occupied range can commit. Application pre-checks are UX only.

# ADR 0003 — Database roles and FORCE ROW LEVEL SECURITY

**Status:** Accepted (Phase 1)  
**Date:** 2026-08-26

## Context

Table owners bypass RLS unless `FORCE ROW LEVEL SECURITY` is set. A role with `BYPASSRLS` ignores policies. If the application login owned tables or had `BYPASSRLS`, RLS would not protect against application bugs.

## Decision

- `tavo_migrator` owns protected tables and has `BYPASSRLS` for migrations and seeds.
- `tavo_app` is the only runtime login: not owner, `NOBYPASSRLS`.
- `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` on all protected tables.

## Consequences

Runtime connections must `set_config('app.tenant_id', …, true)` in-transaction or they see no tenant rows. Migrator credentials are operational secrets, not application config.

# ADR 0007 — SECURITY DEFINER routing for WhatsApp workers

**Status:** Accepted (Phase 2A)  
**Date:** 2026-08-26

## Context

Inbound webhooks and global workers must discover `tenant_id` and claim jobs. Tenant tables use `FORCE ROW LEVEL SECURITY`. `tavo_app` must not receive `BYPASSRLS`, so ordinary `SELECT` cannot scan queues.

## Decision

- Schema `tavo_routing` holds privileged helper functions only (no tenant business tables).
- Functions are `SECURITY DEFINER`, owner `tavo_migrator`, `SET search_path = pg_catalog`.
- Every table and function referenced in those bodies is **schema-qualified** (`public.*`, `tavo_routing.*`, `pg_catalog.*`).
- `REVOKE CREATE` on `public` and `tavo_routing` from `PUBLIC` and `tavo_app`.
- `GRANT EXECUTE` on the four helpers only to `tavo_app`. Return types are routing ids only.
- After resolve/claim, runtime uses `set_config('app.tenant_id', …, true)` and normal RLS.

Helpers: `resolve_whatsapp_integration`, `claim_next_inbound_job`, `claim_next_outbound_job`, `insert_system_security_event`.

## Consequences

Tests must prove `tavo_app` cannot create objects that change definer resolution and cannot read arbitrary tenant rows via the helpers.

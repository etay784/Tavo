# ADR 0011 — One conversation per tenant customer

**Status:** Accepted (Phase 2A)  
**Date:** 2026-08-26

## Context

Two simultaneous first WhatsApp messages must not create two active state machines.

## Decision

`UNIQUE (tenant_id, customer_id)` on `conversations` and `INSERT … ON CONFLICT DO UPDATE RETURNING`. That row is the only active thread (including `IDLE`). Serialization leases attach only after this UPSERT.

## Consequences

Historical threads are not split per visit in Phase 2A. Slot offers expire independently of the conversation row.

# ADR 0009 — Booking command keys and WhatsApp outbox

**Status:** Accepted (Phase 2A)  
**Date:** 2026-08-26

## Context

GiST exclusion is occupancy authority, not webhook retry semantics. Graph sends can fail ambiguously. Customer WhatsApp ids are PII.

## Decision

- `booking_commands.command_key` unique per tenant, derived from inbound event id + operation (`create:` / `reschedule:` / `cancel:`). Replay returns the stored appointment.
- Outbox statuses: `PENDING`, `SENT`, `FAILED`, `AMBIGUOUS`. Never blindly resend `AMBIGUOUS`. Never auto-clear `AMBIGUOUS` using conversation, recipient, or time.
- Outbox stores `customer_id` and `integration_id`, not plaintext `to_wa_id`. Decrypt the customer phone under RLS immediately before send.

## Consequences

Crash after a successful booking commit and before `PROCESSED` is safe. Operators reconcile `AMBIGUOUS` rows.

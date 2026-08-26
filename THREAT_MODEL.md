# Threat model — Phase 1

**Status:** Approved for Phase 1  
**Method:** Asset / threat / mitigation / test. Later-phase threats are listed so they are not forgotten; they are not in Phase 1 test scope unless noted.

## 1. Assets

- Tenant scheduling data (staff, services, hours, appointments)
- Customer PII (phone ciphertext, names)
- HMAC and encryption keys
- Internal API credentials and tenant bindings
- Audit trail integrity
- Calendar exclusivity (no double booking)

## 2. Phase 1 threats

### T1 — Cross-tenant read (IDOR / BOLA)

**Threat:** Caller guesses a UUID belonging to another tenant.  
**Mitigation:** `TrustedTenantContext`; every query `tenant_id = context`; RLS with transaction-local `SET LOCAL`; composite FKs.  
**Test:** Tenant A requests Tenant B appointment/staff/customer IDs → not found / denied; no payload leak.

### T2 — Cross-tenant write via foreign keys

**Threat:** Tenant A creates an appointment with Tenant B’s `staff_id` / `service_id` / `customer_id` / `location_id`.  
**Mitigation:** Composite FKs `(tenant_id, fk) → parent(tenant_id, id)`; application refuses before insert.  
**Test:** Direct SQL and repository tests; insert must fail at the database.

### T3 — Caller-chosen tenant

**Threat:** Header/body `tenant_id` switches isolation.  
**Mitigation:** Tenant only from server-side credential binding; ignore/reject tenant selectors on normal requests.  
**Test:** Authenticated as A, send B’s UUID in body/header; still operates as A; cannot read B.

### T4 — RLS context leak on pooled connections

**Threat:** `SET app.tenant_id` remains on a connection; next checkout is another tenant.  
**Mitigation:** `set_config(..., is_local=true)` / `SET LOCAL` only, same transaction as queries; never session SET for tenant.  
**Test:** Pooled sequential and concurrent transactions (`SECURITY.md`).

### T4b — Application role bypasses RLS

**Threat:** `tavo_app` owns tables or has `BYPASSRLS`.  
**Mitigation:** Separate `tavo_migrator` (owner, `BYPASSRLS`); `tavo_app` is neither; `FORCE ROW LEVEL SECURITY`.  
**Test:** Catalog assertions on owner, `rolbypassrls`, `relforcerowsecurity`.

### T5 — Double booking race

**Threat:** Two concurrent creates for the same staff occupied range.  
**Mitigation:** GiST exclusion is the concurrency authority (no advisory locks). Occupancy snapshot columns. Loser maps to `SLOT_NO_LONGER_AVAILABLE`.  
**Test:** Two concurrent inserts; exactly one success; `23P01` on the loser.

### T6 — Occupancy drift

**Threat:** Service duration/buffer change alters historical overlap semantics.  
**Mitigation:** Persist `occupied_start_at` / `occupied_end_at`; engine and constraint use only those columns.  
**Test:** Update service buffers; old appointment occupied range unchanged; new bookings use new buffers.

### T7 — Prisma-only “security”

**Threat:** Invariants exist only in application code and are dropped on a raw SQL path.  
**Mitigation:** SQL migrations for FKs, exclusion, RLS, grants; Prisma is not the authority.  
**Test:** Invariants hold when inserting via SQL as `tavo_app` (within RLS).

### T8 — Audit tampering

**Threat:** App bug or attacker with DB creds updates/deletes audit rows.  
**Mitigation:** Runtime role cannot `UPDATE`/`DELETE`/`TRUNCATE` `audit_events`.  
**Test:** Those statements fail as `tavo_app`. (Table owner/migrator still can; protect those credentials.)

### T9 — Phone PII exposure

**Threat:** Plaintext phones in DB, logs, or unsalted hashes (rainbow tables).  
**Mitigation:** Encrypted field + `phone_encryption_key_version`; keyed HMAC + `phone_lookup_key_version`; lookup against all HMAC keyring versions during rotation; redaction; keys outside DB.  
**Test:** Schema has no plaintext phone column; lookup tests use HMAC including a write-version bump; logger fixture.

### T10 — Credential theft / stuffing (internal key)

**Threat:** Stolen harness key.  
**Mitigation:** Secrets manager later; Phase 1: env, rotation procedure in runbook stub; rate limit when HTTP exists; one tenant per key limits blast radius.  
**Test:** Invalid key 401; key A cannot access tenant B (binding).

### T11 — SQL injection

**Threat:** String-built SQL with IDs.  
**Mitigation:** Prisma parameterized queries; `$executeRaw` only with parameters; `SET LOCAL` uses bound UUID validated as UUID before interpolation (prefer parameterized `set_config('app.tenant_id', $1, true)`).  
**Test:** Malicious strings in name fields stored, not executed.

### T12 — Supply chain / license

**Threat:** Disallowed license or malicious package.  
**Mitigation:** Allowlist, CI license + vuln scan, no unknown snippets.  
**Test:** CI job.

### T13 — Card data / WhatsApp Web / LLM tools

**Threat:** Accidental scope creep.  
**Mitigation:** Phase 1 schema and packages omit them; review PRs against spec §77.  
**Test:** Schema grep; package absence.

## 3. Documented, deferred (not Phase 1 implementation)

| ID | Threat | When |
| --- | --- | --- |
| T20 | Meta webhook spoofing / replay | WhatsApp phase |
| T21 | Payment webhook spoofing, amount tamper, browser `/success` | Payments phase |
| T22 | Prompt injection, tool argument forgery, LLM data leak | AI phase |
| T23 | CSRF / XSS / session theft | Dashboard phase |
| T24 | LLM cost abuse | AI phase |
| T25 | SSRF, malicious media | WhatsApp media |
| T26 | Backup leakage, insider migrator abuse | Production ops |

Mitigations for deferred items remain as specified in `AI_Receptionist_Product_Specification.md` (signed webhooks, hosted checkout, capability-limited tools, CSP, etc.).

## 4. Residual risk

- Migrator/owner role can bypass RLS and mutate audit tables; production access must be tightly controlled.
- Application-level encryption quality depends on key handling in `packages/security`.
- Phase 1 internal credentials are powerful within one tenant; treat like service accounts.

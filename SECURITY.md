# Security — Phase 1

**Status:** Approved for Phase 1 implementation  
**Complements:** `ARCHITECTURE.md`, `DATA_MODEL.md`, `THREAT_MODEL.md`

## 1. Trust boundaries

| Input | Trust |
| --- | --- |
| HTTP body, query, path, headers | Untrusted |
| Internal API credential | Authenticates caller; tenant comes from **server-side binding** |
| Domain arguments after auth | Still validated; IDs are not proof of tenancy |
| `pg` client | Not an authorization mechanism |
| PostgreSQL constraints / RLS / grants | Authority for isolation and occupancy |

## 2. Authentication and tenant binding

- Map API key → `tenant_id` **server-side**.
- The caller must not choose `tenant_id` via a normal field or header.
- Failed credentials: 401, no tenant context, no `set_config`.

Missing-in-tenant objects: **404** (reduce IDOR oracle).

## 3. Database roles and RLS bypass

| Role | Owns protected tables | `BYPASSRLS` | Used by |
| --- | --- | --- | --- |
| `tavo_migrator` | yes | yes | Migrations, seeds, admin SQL |
| `tavo_app` | **no** | **no** | API, domain, runtime tests |

Protected tables: `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`.

`tavo_app` therefore cannot skip RLS by owning the table or by a role attribute. Only `tavo_migrator` (and superuser) may bypass policies, and that role is not the application connection string.

Tests must assert:

- `tavo_app.rolbypassrls` is false
- protected `relowner` is not `tavo_app`
- `relrowsecurity` and `relforcerowsecurity` are true
- `tavo_app` query without tenant setting returns no tenant rows
- `tavo_app` cannot `UPDATE`/`DELETE` `audit_events`

## 4. RLS and connection pooling

```text
BEGIN
SELECT set_config('app.tenant_id', $tenant_uuid, true);  -- transaction-local
-- queries
COMMIT | ROLLBACK
```

**Forbidden:** session `SET app.tenant_id` on pooled connections.

Tests: sequential pool reuse across tenants; concurrent connections; query without `set_config`.

## 5. Isolation beyond RLS

- Composite foreign keys
- CHECK constraints on appointment instants
- GiST exclusion (final concurrency authority; no advisory locks)
- Runtime role is not table owner and has no `BYPASSRLS`

Concurrent overlapping `CONFIRMED` appointments: one success; loser → `SLOT_NO_LONGER_AVAILABLE`.

## 6. Phone numbers (PII)

- Normalize, then **keyed HMAC-SHA256** (not unsalted hash).
- Store `phone_lookup_hash`, `phone_lookup_key_version`, `phone_encrypted`, `phone_encryption_key_version`.
- Separate keyrings for HMAC vs encryption.

**HMAC key rotation (documented; no Phase 1 rotator service):**

1. Add the new HMAC key to the keyring; keep the old key.
2. Switch the *write* version to the new key. New customers get the new version.
3. Lookup hashes the normalized phone with **all keyring versions** and `OR`s those `(version, hash)` pairs in the query (or equivalent). Existing rows remain findable.
4. Optional later backfill updates rows to the new version; then remove the old key from the keyring.

Encryption rotation: decrypt with the row version; encrypt writes with current encryption write version. Keep old encryption keys until re-encrypt.

## 7. Secrets and environments

No secrets in git. Local keys in ignored `.env`. Production later: managed secrets + KMS.

## 8. Logging and audit

Structured logs with redaction. Mutations insert `audit_events` in the same transaction when practical. No phones, tokens, or keys in logs or audit metadata.

## 9. HTTP harness

Zod on every route. Credential rate-limit (in-process is acceptable in Phase 1). Machine-only; dashboard headers later.

## 10. Cards, WhatsApp, LLM

Zero card fields. No WhatsApp Web. No LLM client.

## 11. License and CI

Allowlist: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, PostgreSQL.

CI blocking production vulnerability severity: **high** (`npm audit --omit=dev --audit-level=high`). Moderate findings should be reviewed but do not fail the build.

Secret scanning: **gitleaks CLI 8.30.1** (MIT). Do not use `gitleaks/gitleaks-action` (not allowlisted).

Generate `THIRD_PARTY_NOTICES.md` with `npm run notices` after dependency changes. CycloneDX SBOM is produced in CI (`npm run sbom`).

## 12. Required security tests

| Test | Layer |
| --- | --- |
| Tenant A cannot read Tenant B | App + DB |
| Tenant A cannot create/mutate using Tenant B FKs | Composite FK |
| Caller cannot select tenant via field/header | App |
| Pooled connections do not leak `app.tenant_id` | DB + driver |
| Concurrent overlapping `CONFIRMED` | Exclusion `23P01` |
| `tavo_app` no `BYPASSRLS`, not owner, FORCE RLS | Catalog |
| `tavo_app` cannot update/delete `audit_events` | Grants |
| HMAC lookup + key versions | Unit + schema |
| No PAN/CVV columns | Schema grep |
| Logs redacted | Unit |

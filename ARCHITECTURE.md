# Architecture — Phase 1

**Status:** Approved for Phase 1 implementation  
**Product source of truth:** `AI_Receptionist_Product_Specification.md`  
**This document:** Engineering decisions for the deterministic booking core

Phase 1 builds a multi-tenant scheduling and appointment engine that is fully testable without WhatsApp, payments, an LLM, or a business dashboard. Those integrations are out of scope until Phase 1 invariants pass.

## 1. Central principle

The AI is the language interface, not the authority. Availability, prices, customer identity, tenant identity, and authorization live in deterministic backend code and PostgreSQL constraints. Phase 1 has no AI in the request path.

## 2. Scope

**In scope**

- TypeScript monorepo, strict mode, license-compliant dependencies
- PostgreSQL schema and explicit SQL migrations (`btree_gist`, GiST exclusion, composite FKs, CHECK constraints, RLS, `FORCE ROW LEVEL SECURITY`, role grants)
- Tenant, location, staff, services, eligibility, working hours, breaks, time off, customers, appointments
- Occupancy snapshots; scheduling engine and exclusion constraint share the same occupied range
- Domain services: scheduling, appointments, customers
- Internal HTTP harness only after the domain/database core is implemented and tested
- Audit log (append-only at database privilege level)
- Encrypted phone + keyed HMAC lookup with key versions

**Out of scope**

- WhatsApp Business Platform / Cloud API and all unofficial WhatsApp automation
- Payment providers, hosted checkout, holds-for-payment, usage billing ledger
- LLM providers, `AIOrchestrator`, tool-calling
- Business dashboard (Next.js), managed IdP / MFA for owners
- Human handoff product, waitlist, analytics, multi-tenant self-serve onboarding
- Advisory locks (not used; GiST exclusion is the concurrency authority)
- A phone-key rotation *service* (schema and lookup behavior support rotation; no background rotator in Phase 1)

## 3. Layering

```text
HTTP harness (apps/api)          — added after domain/DB tests pass
        ↓
Domain services (packages/domain)
        ↓
Repositories (packages/database) — node-postgres in a transaction
        ↓
PostgreSQL                       — composite FKs, CHECKs, GiST exclusion, RLS, grants
```

| Layer | Package | May do | Must not do |
| --- | --- | --- | --- |
| HTTP harness | `apps/api` | Authenticate credential, bind tenant, validate with Zod, map errors | Encode scheduling rules; accept caller-chosen `tenant_id` |
| Domain | `packages/domain` | Availability, booking state machine, map exclusion failures | Import Meta, payment, or LLM SDKs; take advisory locks |
| Persistence | `packages/database` | SQL migrations, `pg` repositories | Treat an ORM schema as the source of exclusion/RLS/grants |
| Security | `packages/security` | Phone HMAC/encrypt, key versions, redacting logger | Store KMS/HMAC keys in Postgres |
| Shared | `packages/shared` | IDs, money minor units, clock, error types | Depend on Fastify or `pg` |

**Data-access choice (Phase 1):** `pg` (node-postgres, MIT). The product spec suggested Prisma; Phase 1 keeps a single SQL source of truth for RLS, `FORCE ROW LEVEL SECURITY`, exclusion constraints, and grants. An ORM may be introduced later as a client only, never as the authority for those objects.

Provider adapter packages (`whatsapp`, `payments`, `ai`) are not created in Phase 1.

## 4. Trusted tenant context

Tenant identity is a **server-side property of the authenticated caller**, not a request parameter.

- Each internal API credential is bound to exactly one `tenant_id` in secrets/env.
- Authentication succeeds → `TrustedTenantContext` is constructed in process memory.
- Normal request bodies, query strings, path params, and headers **must not** select `tenant_id`.
- Domain methods take `TrustedTenantContext` as a required argument.

## 5. Database roles

| Role | Purpose | Ownership | `BYPASSRLS` |
| --- | --- | --- | --- |
| Superuser (local/CI bootstrap only) | Create roles, run bootstrap | n/a | yes (superuser) |
| `tavo_migrator` | DDL, grants, seeds, admin data fixes | **Owns** tenant tables | **yes** — required to migrate/seed without request-scoped `SET LOCAL` |
| `tavo_app` | Runtime DML used by the API and domain | **Must not** own protected tables | **Must not** |

`tavo_app` must never be table owner and must never have `BYPASSRLS`. Protected tables use `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` so a future accidental owner still cannot skip policies unless they also have `BYPASSRLS`.

Role passwords are **not** in SQL migrations or the migrator. Production credentials are provisioned in the secret manager. `tavo_migrator` is never an application login. Ephemeral tests use local trust authentication (`ephemeral-pg.ts`), not shared passwords.

See `SECURITY.md` and `ADR/0003-database-roles-and-force-rls.md`.

## 5b. Versioned SQL migrations

`packages/database/sql/*.sql` is authoritative. `applyMigrations` records each filename in `schema_migrations` and runs a file only if it is not already stamped. A database that already has the Phase 1 `appointments` table is treated as having `000`–`002` applied (stamped without replay) so later files such as `003_schema_migrations.sql` can be applied in place. `schema_migrations` is owned by `tavo_migrator` and is not granted to `tavo_app`.

## 6. Transaction-local RLS (connection pooling)

Use `select set_config('app.tenant_id', $1, true)` (`is_local = true`) as the first statement of each transaction that touches tenant data. Equivalent: `SET LOCAL`.

**Forbidden:** session-level `SET app.tenant_id` on pooled connections.

Prefer parameterized `set_config` over interpolating UUIDs into `SET LOCAL`.

## 7. Occupancy snapshot

Each appointment stores `start_at`, `end_at`, `occupied_start_at`, `occupied_end_at`. The engine and GiST constraint both use `tstzrange(occupied_start_at, occupied_end_at, '[)')`. Catalog duration/buffer edits do not rewrite historical occupancy.

CHECK constraints (see `DATA_MODEL.md`):

- `start_at < end_at`
- `occupied_start_at < occupied_end_at`
- `occupied_start_at <= start_at`
- `occupied_end_at >= end_at`

## 8. Double-booking

The **GiST exclusion constraint is the final concurrency authority**. Do not use advisory locks unless a later measured need appears.

```sql
EXCLUDE USING gist (
  tenant_id WITH =,
  staff_id WITH =,
  tstzrange(occupied_start_at, occupied_end_at, '[)') WITH &&
)
WHERE (status = 'CONFIRMED');
```

`btree_gist` is created in a version-controlled migration.

Concurrent inserts/updates of overlapping `CONFIRMED` rows for the same tenant and staff: exactly one transaction commits. The loser fails with PostgreSQL exclusion_violation (`23P01`) and is mapped to domain error `SLOT_NO_LONGER_AVAILABLE`.

The domain may still pre-check working hours and existing busy intervals to produce clearer errors for non-race cases. That check is not the concurrency control.

Create and reschedule (not only availability search) enforce the same booking rules before insert/update:

- `start_at` is on the business civil-time slot grid (`slot_granularity_minutes` in `businesses.timezone`; seconds must be zero). Off-grid times such as 09:07 are rejected.
- `start_at` is at least `min_advance_minutes` from now and strictly before now + `booking_horizon_days` (same 24×60-minute day length as search).
- Occupancy must fit remaining free time after working hours, breaks, time off, and other `CONFIRMED` occupancy.
- Staff and service must be active.
- Staff must currently offer the service (`staff_services.active`). **Eligibility policy:** this check runs on both create and reschedule. Existing `CONFIRMED` appointments are not auto-cancelled if eligibility is later revoked.

`setWorkingHours` is a tenant-scoped UPSERT on `(tenant_id, staff_id, day_of_week)`.

New customers are created with `INSERT ... ON CONFLICT (tenant_id, phone_lookup_key_version, phone_lookup_hash) DO UPDATE` so concurrent first bookings for the same phone share one row.

Catalog mutations (staff, service, staff-service assignment, working hours, breaks, time off) and appointment create/reschedule/cancel write `audit_events` in the same transaction.

## 9. Request path (after harness exists)

```text
Client
  → Fastify + Zod
  → Authenticate credential (no tenant field)
  → Bind TrustedTenantContext from server-side mapping
  → BEGIN
  → set_config('app.tenant_id', tenantId, true)
  → Domain service
  → INSERT/UPDATE (composite FKs + CHECKs + exclusion)
  → INSERT audit_events
  → COMMIT
```

Until that harness exists, tests call domain services and repositories directly.

## 10. Repository structure

```text
/
  ARCHITECTURE.md
  SECURITY.md
  DATA_MODEL.md
  THREAT_MODEL.md
  LICENSE_POLICY.md
  ADR/
  apps/api
  packages/database    SQL migrations + pg repositories
  packages/domain
  packages/security
  packages/shared
```

## 11. Implementation order

1. Monorepo, TypeScript strict, license CI (no HTTP routes)
2. SQL migrations (extensions, roles, tables, FKs, CHECKs, GiST, RLS, FORCE RLS, grants)
3. Database invariant and security tests
4. `packages/security` (HMAC/encrypt, key versions, logger)
5. Domain scheduling and appointments
6. API harness last: credential → tenant bind

## 12. Related documents

- `DATA_MODEL.md`, `SECURITY.md`, `THREAT_MODEL.md`
- `ADR/0001-transaction-local-rls.md`
- `ADR/0002-occupancy-snapshot.md`
- `ADR/0003-database-roles-and-force-rls.md`
- `ADR/0005-phone-hmac-rotation.md`
- `ADR/0006-pin-github-actions.md`
- `AI_Receptionist_Product_Specification.md`

## 13. Phase 2A (WhatsApp + FakeAI)

See `ADR/0007`–`ADR/0012`. Runtime uses `tavo_routing` SECURITY DEFINER helpers (`search_path = pg_catalog`, schema-qualified names) to resolve integrations and claim jobs, then `tavo_app` + transaction-local RLS. No real LLM provider (`ADR/0012` deferred). `tavo_app` has no `BYPASSRLS` and no `CREATE` on `public` or `tavo_routing`.

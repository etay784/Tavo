# Data model — Phase 1

**Status:** Approved for Phase 1 implementation  
**Database:** PostgreSQL  
**Access:** SQL migrations are authoritative. The application uses `pg` inside transactions with transaction-local tenant context.

Money is stored as integer minor units (e.g. ILS agorot). Timestamps are `timestamptz` (UTC instants). Tenant timezone is metadata for interpreting civil working hours.

## 1. Tenant root

### `businesses`

The tenant. `id` is the trusted `tenant_id`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | Tenant key |
| `name` | `text` | |
| `timezone` | `text` | IANA TZ, e.g. `Asia/Jerusalem` |
| `currency` | `char(3)` | Phase 1: `ILS` |
| `booking_horizon_days` | `int` | Default 28 |
| `min_advance_minutes` | `int` | Default 0 |
| `slot_granularity_minutes` | `int` | Default 15 |
| `created_at` / `updated_at` | `timestamptz` | |

RLS on `businesses` uses `id = current tenant`, not a `tenant_id` column.

## 2. Tenant-aware (composite) foreign keys

Every tenant-owned child table has `PRIMARY KEY (id)` and `UNIQUE (tenant_id, id)`. References:

```text
FOREIGN KEY (tenant_id, <entity>_id) REFERENCES <parent> (tenant_id, id)
```

This applies to locations, staff, services, staff_services, working_hours, breaks, time_off, customers, and appointments (including optional location). Tests must prove Tenant A cannot insert or update using Tenant B’s `staff_id`, `service_id`, `customer_id`, or `location_id`.

## 3. Tables in Phase 1

### Catalog and calendar

`locations`, `staff_members`, `services` (duration, `price_minor`, unused deposit columns, buffers), `staff_services`, `working_hours` (`day_of_week` 0 = Sunday … 6 = Saturday, civil `start_time`/`end_time` in the **business** timezone), `breaks`, `time_off`.

Working-hours civil times are interpreted in `businesses.timezone` unless a later location override exists. The engine converts each calendar date to UTC instants. `UNIQUE (tenant_id, staff_id, day_of_week)` is updated in place by `setWorkingHours` (UPSERT).

### Eligibility (`staff_services`)

Create and reschedule require an **active** `staff_services` row for that staff and service, plus active staff and service rows. Revoking eligibility (inactive row or missing assignment) causes later create/reschedule to fail. Existing `CONFIRMED` appointments are not rewritten or cancelled by that change.

### `schema_migrations`

Filename primary key, `applied_at`. Not tenant-scoped. Owned by `tavo_migrator`; no DML grants to `tavo_app`. SQL files under `packages/database/sql/` remain the schema source of truth.

### `customers`

| Column | Notes |
| --- | --- |
| `phone_encrypted` | Application-level ciphertext |
| `phone_encryption_key_version` | Encryption key version (decrypts `phone_encrypted`) |
| `phone_lookup_hash` | Keyed HMAC of the normalized phone (not unsalted hash) |
| `phone_lookup_key_version` | HMAC key version that produced the lookup value |
| `name`, `last_seen_at` | |

`UNIQUE (tenant_id, phone_lookup_key_version, phone_lookup_hash)`. First-seen customers are created with `INSERT ... ON CONFLICT` on that key so concurrent bookings for the same unseen phone share one row.

**HMAC rotation (Phase 1 behavior, no rotator service):**

- Keys live in secrets as a versioned keyring (`version → key`). Current write version is configured separately for encryption and for HMAC.
- **Writes** always HMAC and encrypt with the *current* write versions and store those versions on the row.
- **Reads** compute the HMAC for **every HMAC key version present in the configured keyring** and match `(phone_lookup_key_version, phone_lookup_hash)` against any of them. That allows lookup during a migration window without a background job.
- A future job *may* re-HMAC rows to the newest version and drop old keyring entries; that job is not implemented in Phase 1.
- Encryption decrypt uses the row’s `phone_encryption_key_version` against the encryption keyring (old keys remain until all rows are re-encrypted).

### `appointments`

| Column | Notes |
| --- | --- |
| `customer_id`, `staff_id`, `service_id` | Composite FKs with `tenant_id` |
| `location_id` | Optional composite FK |
| `start_at`, `end_at` | Customer-facing service interval (UTC) |
| `occupied_start_at`, `occupied_end_at` | Occupancy snapshot (UTC) |
| `status` | Phase 1: `CONFIRMED`, `CANCELLED` |
| `source` | `HARNESS`, `INTERNAL`, `SEED` |

Occupancy is computed at create/reschedule from then-current service duration and buffers. Later catalog edits must not change stored occupancy.

**CHECK constraints (required):**

```sql
CHECK (start_at < end_at)
CHECK (occupied_start_at < occupied_end_at)
CHECK (occupied_start_at <= start_at)
CHECK (occupied_end_at >= end_at)
```

Phase 1 occupying status: `CONFIRMED` only.

### Not in Phase 1 schema

`appointment_holds`, `payment_sessions`, `usage_events`, `conversations`, `messages`.

### `audit_events`

Append-only for `tavo_app`: `SELECT` + `INSERT` only. No `updated_at`.

## 4. Extensions and exclusion constraint

Version-controlled SQL (applied in filename order):

```text
packages/database/sql/000_roles.sql
packages/database/sql/001_btree_gist.sql
packages/database/sql/002_schema.sql
```

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
```

**Concurrency authority** (must match this shape):

```sql
ALTER TABLE appointments
  ADD CONSTRAINT appointments_occupied_excl
  EXCLUDE USING gist (
    tenant_id WITH =,
    staff_id WITH =,
    tstzrange(occupied_start_at, occupied_end_at, '[)') WITH &&
  )
  WHERE (status = 'CONFIRMED');
```

No advisory locks. Exclusion failure → `SLOT_NO_LONGER_AVAILABLE`.

## 5. Row Level Security

`ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` on all protected tables (`businesses` and every tenant-owned table including `audit_events`).

Policies compare `tenant_id` (or `businesses.id`) to `NULLIF(current_setting('app.tenant_id', true), '')::uuid`.

Tenant context is transaction-local (`set_config(..., true)` / `SET LOCAL`). See `SECURITY.md`.

## 6. Roles and grants

| Role | Purpose |
| --- | --- |
| `tavo_migrator` | Owns tables; `BYPASSRLS`; DDL and seeds |
| `tavo_app` | Runtime; **not** owner; **no** `BYPASSRLS` |

On `audit_events`: `GRANT SELECT, INSERT` to `tavo_app`; no `UPDATE`/`DELETE`/`TRUNCATE`.

## 7. Indexes (minimum)

- `(tenant_id, id)` unique on children
- GiST exclusion on appointments
- Customers: `(tenant_id, phone_lookup_key_version, phone_lookup_hash)`
- Appointments: `(tenant_id, staff_id, occupied_start_at)`

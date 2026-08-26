-- Phase 1 schema. Authoritative. Requires 000_roles.sql and 001_btree_gist.sql.
-- Tables are owned by tavo_migrator. Runtime DML uses tavo_app (no BYPASSRLS).

CREATE TYPE appointment_status AS ENUM ('CONFIRMED', 'CANCELLED');
CREATE TYPE appointment_source AS ENUM ('HARNESS', 'INTERNAL', 'SEED');

CREATE TABLE businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  timezone text NOT NULL,
  currency char(3) NOT NULL DEFAULT 'ILS',
  booking_horizon_days integer NOT NULL DEFAULT 28 CHECK (booking_horizon_days > 0),
  min_advance_minutes integer NOT NULL DEFAULT 0 CHECK (min_advance_minutes >= 0),
  slot_granularity_minutes integer NOT NULL DEFAULT 15 CHECK (slot_granularity_minutes > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  name text NOT NULL,
  timezone text,
  address_optional text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE staff_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  location_id uuid,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);

CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  name text NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  price_minor integer NOT NULL CHECK (price_minor >= 0),
  deposit_required boolean NOT NULL DEFAULT false,
  deposit_minor integer NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0),
  buffer_before_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_before_minutes >= 0),
  buffer_after_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_after_minutes >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE staff_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  staff_id uuid NOT NULL,
  service_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, staff_id, service_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff_members (tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES services (tenant_id, id)
);

CREATE TABLE working_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  staff_id uuid NOT NULL,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_time < end_time),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, staff_id, day_of_week),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff_members (tenant_id, id)
);

CREATE TABLE breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  staff_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  recurrence_or_rule_optional text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff_members (tenant_id, id)
);

CREATE TABLE time_off (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  staff_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason_optional text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff_members (tenant_id, id)
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  phone_encrypted text NOT NULL,
  phone_encryption_key_version integer NOT NULL,
  phone_lookup_hash text NOT NULL,
  phone_lookup_key_version integer NOT NULL,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, phone_lookup_key_version, phone_lookup_hash)
);

CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  customer_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  service_id uuid NOT NULL,
  location_id uuid,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  occupied_start_at timestamptz NOT NULL,
  occupied_end_at timestamptz NOT NULL,
  status appointment_status NOT NULL,
  source appointment_source NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff_members (tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES services (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  CONSTRAINT appointments_start_before_end CHECK (start_at < end_at),
  CONSTRAINT appointments_occupied_order CHECK (occupied_start_at < occupied_end_at),
  CONSTRAINT appointments_occupied_covers_start CHECK (occupied_start_at <= start_at),
  CONSTRAINT appointments_occupied_covers_end CHECK (occupied_end_at >= end_at)
);

ALTER TABLE appointments
  ADD CONSTRAINT appointments_occupied_excl
  EXCLUDE USING gist (
    tenant_id WITH =,
    staff_id WITH =,
    tstzrange(occupied_start_at, occupied_end_at, '[)') WITH &&
  )
  WHERE (status = 'CONFIRMED');

CREATE INDEX appointments_staff_occupied_idx
  ON appointments (tenant_id, staff_id, occupied_start_at);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_tenant_created_idx ON audit_events (tenant_id, created_at);

-- Ownership: migrator, never tavo_app
ALTER TABLE businesses OWNER TO tavo_migrator;
ALTER TABLE locations OWNER TO tavo_migrator;
ALTER TABLE staff_members OWNER TO tavo_migrator;
ALTER TABLE services OWNER TO tavo_migrator;
ALTER TABLE staff_services OWNER TO tavo_migrator;
ALTER TABLE working_hours OWNER TO tavo_migrator;
ALTER TABLE breaks OWNER TO tavo_migrator;
ALTER TABLE time_off OWNER TO tavo_migrator;
ALTER TABLE customers OWNER TO tavo_migrator;
ALTER TABLE appointments OWNER TO tavo_migrator;
ALTER TABLE audit_events OWNER TO tavo_migrator;
ALTER TYPE appointment_status OWNER TO tavo_migrator;
ALTER TYPE appointment_source OWNER TO tavo_migrator;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO tavo_migrator, tavo_app;
GRANT USAGE ON TYPE appointment_status TO tavo_app;
GRANT USAGE ON TYPE appointment_source TO tavo_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  businesses, locations, staff_members, services, staff_services,
  working_hours, breaks, time_off, customers, appointments
  TO tavo_app;

GRANT SELECT, INSERT ON audit_events TO tavo_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM tavo_app;

-- RLS
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_members FORCE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE services FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_services FORCE ROW LEVEL SECURITY;
ALTER TABLE working_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE working_hours FORCE ROW LEVEL SECURITY;
ALTER TABLE breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE breaks FORCE ROW LEVEL SECURITY;
ALTER TABLE time_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_off FORCE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY businesses_isolation ON businesses
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY locations_isolation ON locations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY staff_members_isolation ON staff_members
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY services_isolation ON services
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY staff_services_isolation ON staff_services
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY working_hours_isolation ON working_hours
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY breaks_isolation ON breaks
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY time_off_isolation ON time_off
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY customers_isolation ON customers
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY appointments_isolation ON appointments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY audit_events_isolation ON audit_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Phase 2B owner schedule: extra appointment sources, multiple weekday ranges, date exceptions.
-- New enum values are not referenced in this file (PostgreSQL transaction restriction).

ALTER TYPE public.appointment_source ADD VALUE IF NOT EXISTS 'MANUAL';
ALTER TYPE public.appointment_source ADD VALUE IF NOT EXISTS 'PHONE';
ALTER TYPE public.appointment_source ADD VALUE IF NOT EXISTS 'WALK_IN';
ALTER TYPE public.appointment_source ADD VALUE IF NOT EXISTS 'BLOCKED';

ALTER TABLE public.working_hours
  DROP CONSTRAINT IF EXISTS working_hours_tenant_id_staff_id_day_of_week_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'working_hours_range_excl'
  ) THEN
    ALTER TABLE public.working_hours
      ADD CONSTRAINT working_hours_range_excl
      EXCLUDE USING gist (
        tenant_id WITH =,
        staff_id WITH =,
        day_of_week WITH =,
        tsrange(
          ('2000-01-02'::date + start_time),
          ('2000-01-02'::date + end_time),
          '[)'
        ) WITH &&
      );
  END IF;
END $$;

CREATE TABLE public.staff_schedule_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.businesses (id),
  staff_id uuid NOT NULL,
  civil_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('CLOSED', 'OPEN')),
  start_time time,
  end_time time,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES public.staff_members (tenant_id, id),
  CONSTRAINT staff_schedule_exceptions_shape_chk CHECK (
    (kind = 'CLOSED' AND start_time IS NULL AND end_time IS NULL)
    OR
    (kind = 'OPEN' AND start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time)
  )
);

CREATE UNIQUE INDEX staff_schedule_exceptions_closed_uniq
  ON public.staff_schedule_exceptions (tenant_id, staff_id, civil_date)
  WHERE kind = 'CLOSED';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_schedule_exceptions_open_excl'
  ) THEN
    ALTER TABLE public.staff_schedule_exceptions
      ADD CONSTRAINT staff_schedule_exceptions_open_excl
      EXCLUDE USING gist (
        tenant_id WITH =,
        staff_id WITH =,
        civil_date WITH =,
        tsrange(
          (civil_date + start_time),
          (civil_date + end_time),
          '[)'
        ) WITH &&
      )
      WHERE (kind = 'OPEN');
  END IF;
END $$;

ALTER TABLE public.staff_schedule_exceptions OWNER TO tavo_migrator;
ALTER TABLE public.staff_schedule_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_schedule_exceptions FORCE ROW LEVEL SECURITY;

CREATE POLICY staff_schedule_exceptions_isolation ON public.staff_schedule_exceptions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE public.staff_schedule_exceptions FROM PUBLIC;
REVOKE ALL ON TABLE public.staff_schedule_exceptions FROM tavo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_schedule_exceptions TO tavo_app;

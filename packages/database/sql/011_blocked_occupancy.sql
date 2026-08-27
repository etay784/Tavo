-- Blocked occupancy uses the same appointments GiST exclusion as customer bookings.
-- Enum values MANUAL/PHONE/WALK_IN/BLOCKED were added in 010 and are visible here.

ALTER TABLE public.appointments
  ALTER COLUMN customer_id DROP NOT NULL;

ALTER TABLE public.appointments
  ALTER COLUMN service_id DROP NOT NULL;

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS internal_note text;

ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_blocked_shape_chk;

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_blocked_shape_chk CHECK (
    (
      source = 'BLOCKED'
      AND customer_id IS NULL
      AND service_id IS NULL
    )
    OR
    (
      source <> 'BLOCKED'
      AND customer_id IS NOT NULL
      AND service_id IS NOT NULL
    )
  );

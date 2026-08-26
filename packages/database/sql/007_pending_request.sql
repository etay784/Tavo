-- Allowlisted structured pending request for multi-turn clarification (not chat logs).

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS pending_request jsonb;

ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_pending_request_allowlist;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_pending_request_allowlist
  CHECK (
    pending_request IS NULL
    OR (
      jsonb_typeof(pending_request) = 'object'
      AND NOT pending_request ?| ARRAY[
        'tenant_id', 'customer_id', 'phone', 'ciphertext', 'appointment_id', 'id'
      ]
      AND (
        pending_request
        - ARRAY[
          'civil_date',
          'weekday',
          'relative_when',
          'time_window',
          'time_exact',
          'time_from',
          'time_to',
          'staff_name'
        ]
      ) = '{}'::jsonb
    )
  );

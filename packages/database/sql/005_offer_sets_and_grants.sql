-- Phase 2A review follow-up. Idempotent relative to a fresh 004 plus this file.

ALTER TABLE public.offered_slots
  ADD COLUMN IF NOT EXISTS offer_set_id uuid;

UPDATE public.offered_slots SET offer_set_id = gen_random_uuid() WHERE offer_set_id IS NULL;

ALTER TABLE public.offered_slots
  ALTER COLUMN offer_set_id SET NOT NULL;

ALTER TABLE public.offered_slots
  DROP CONSTRAINT IF EXISTS offered_slots_tenant_id_conversation_id_ordinal_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'offered_slots_offer_set_ordinal_key'
  ) THEN
    ALTER TABLE public.offered_slots
      ADD CONSTRAINT offered_slots_offer_set_ordinal_key UNIQUE (tenant_id, offer_set_id, ordinal);
  END IF;
END $$;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS current_offer_set_id uuid,
  ADD COLUMN IF NOT EXISTS pending_appointment_id uuid,
  ADD COLUMN IF NOT EXISTS lease_token text;

ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_pending_appointment_fk;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_pending_appointment_fk'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_pending_appointment_fk
      FOREIGN KEY (tenant_id, pending_appointment_id) REFERENCES public.appointments (tenant_id, id);
  END IF;
END $$;

ALTER TABLE public.whatsapp_outbound_messages
  ADD COLUMN IF NOT EXISTS retry_class text;

ALTER TABLE public.whatsapp_outbound_messages
  DROP CONSTRAINT IF EXISTS outbound_retry_class_chk;

ALTER TABLE public.whatsapp_outbound_messages
  ADD CONSTRAINT outbound_retry_class_chk
  CHECK (retry_class IS NULL OR retry_class IN ('TRANSIENT'));

ALTER TYPE conversation_state ADD VALUE IF NOT EXISTS 'AWAITING_RESCHEDULE_APPOINTMENT';

REVOKE ALL ON TABLE public.whatsapp_integrations FROM tavo_app;
REVOKE ALL ON TABLE public.conversations FROM tavo_app;
REVOKE ALL ON TABLE public.whatsapp_inbound_events FROM tavo_app;
REVOKE ALL ON TABLE public.whatsapp_outbound_messages FROM tavo_app;
REVOKE ALL ON TABLE public.messages FROM tavo_app;
REVOKE ALL ON TABLE public.offered_slots FROM tavo_app;
REVOKE ALL ON TABLE public.booking_commands FROM tavo_app;

GRANT SELECT ON public.whatsapp_integrations TO tavo_app;
GRANT SELECT, INSERT, UPDATE ON public.conversations TO tavo_app;
GRANT SELECT, INSERT, UPDATE ON public.whatsapp_inbound_events TO tavo_app;
GRANT SELECT, INSERT, UPDATE ON public.whatsapp_outbound_messages TO tavo_app;
GRANT SELECT, INSERT ON public.messages TO tavo_app;
GRANT SELECT, INSERT, UPDATE ON public.offered_slots TO tavo_app;
GRANT SELECT, INSERT ON public.booking_commands TO tavo_app;

CREATE OR REPLACE FUNCTION tavo_routing.claim_next_inbound_job(p_worker_id text)
RETURNS TABLE(job_id uuid, tenant_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR pg_catalog.length(p_worker_id) > 200 THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT e.id
    FROM public.whatsapp_inbound_events AS e
    WHERE e.event_kind = 'message_text'
      AND e.status <> 'DEAD'
      AND (
        (
          e.status IN ('RECEIVED', 'FAILED')
          AND e.attempt_count < 8
          AND e.next_attempt_at <= pg_catalog.now()
          AND (e.lock_expires_at IS NULL OR e.lock_expires_at < pg_catalog.now())
        )
        OR (
          e.status = 'PROCESSING'
          AND e.lock_expires_at IS NOT NULL
          AND e.lock_expires_at < pg_catalog.now()
        )
      )
    ORDER BY e.wa_timestamp ASC NULLS LAST, e.provider_message_id ASC
    FOR UPDATE OF e SKIP LOCKED
    LIMIT 1
  ),
  upd AS (
    UPDATE public.whatsapp_inbound_events AS e
    SET
      status = CASE
        WHEN e.status = 'PROCESSING' AND e.attempt_count >= 8 THEN 'DEAD'::public.inbound_event_status
        ELSE 'PROCESSING'::public.inbound_event_status
      END,
      locked_by = CASE
        WHEN e.status = 'PROCESSING' AND e.attempt_count >= 8 THEN NULL
        ELSE p_worker_id
      END,
      locked_at = CASE
        WHEN e.status = 'PROCESSING' AND e.attempt_count >= 8 THEN NULL
        ELSE pg_catalog.now()
      END,
      lock_expires_at = CASE
        WHEN e.status = 'PROCESSING' AND e.attempt_count >= 8 THEN NULL
        ELSE pg_catalog.now() + '75 seconds'::pg_catalog.interval
      END,
      last_error = CASE
        WHEN e.status = 'PROCESSING' AND e.attempt_count >= 8 THEN 'stranded processing terminalized'
        ELSE e.last_error
      END,
      attempt_count = CASE
        WHEN e.status = 'PROCESSING' AND e.attempt_count >= 8 THEN e.attempt_count
        ELSE e.attempt_count + 1
      END
    FROM picked
    WHERE e.id = picked.id
    RETURNING e.id, e.tenant_id, e.status
  )
  SELECT upd.id, upd.tenant_id FROM upd WHERE upd.status = 'PROCESSING';
END;
$$;

CREATE OR REPLACE FUNCTION tavo_routing.claim_next_outbound_job(p_worker_id text)
RETURNS TABLE(outbox_id uuid, tenant_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR pg_catalog.length(p_worker_id) > 200 THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT o.id
    FROM public.whatsapp_outbound_messages AS o
    WHERE o.status = 'PENDING'
      AND o.next_attempt_at <= pg_catalog.now()
      AND (o.lock_expires_at IS NULL OR o.lock_expires_at < pg_catalog.now())
    ORDER BY o.created_at ASC
    FOR UPDATE OF o SKIP LOCKED
    LIMIT 1
  ),
  upd AS (
    UPDATE public.whatsapp_outbound_messages AS o
    SET
      status = CASE
        WHEN o.attempt_count >= 8 THEN 'FAILED'::public.outbound_message_status
        ELSE o.status
      END,
      locked_by = CASE WHEN o.attempt_count >= 8 THEN NULL ELSE p_worker_id END,
      locked_at = CASE WHEN o.attempt_count >= 8 THEN NULL ELSE pg_catalog.now() END,
      lock_expires_at = CASE
        WHEN o.attempt_count >= 8 THEN NULL
        ELSE pg_catalog.now() + '75 seconds'::pg_catalog.interval
      END,
      last_error = CASE
        WHEN o.attempt_count >= 8 THEN 'stranded pending terminalized'
        ELSE o.last_error
      END,
      attempt_count = CASE WHEN o.attempt_count >= 8 THEN o.attempt_count ELSE o.attempt_count + 1 END,
      updated_at = pg_catalog.now()
    FROM picked
    WHERE o.id = picked.id
    RETURNING o.id, o.tenant_id, o.status
  )
  SELECT upd.id, upd.tenant_id FROM upd WHERE upd.status = 'PENDING';
END;
$$;

ALTER FUNCTION tavo_routing.claim_next_inbound_job(text) OWNER TO tavo_migrator;
ALTER FUNCTION tavo_routing.claim_next_outbound_job(text) OWNER TO tavo_migrator;
GRANT EXECUTE ON FUNCTION tavo_routing.claim_next_inbound_job(text) TO tavo_app;
GRANT EXECUTE ON FUNCTION tavo_routing.claim_next_outbound_job(text) TO tavo_app;

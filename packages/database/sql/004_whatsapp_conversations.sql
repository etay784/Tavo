-- Phase 2A: WhatsApp routing, conversations, jobs, outbox.
-- SECURITY DEFINER helpers live in tavo_routing with search_path = pg_catalog
-- and schema-qualified names only.

ALTER TYPE appointment_source ADD VALUE IF NOT EXISTS 'WHATSAPP';

CREATE TYPE inbound_event_status AS ENUM (
  'RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED', 'DEAD'
);
CREATE TYPE inbound_event_kind AS ENUM ('message_text', 'status', 'unknown');
CREATE TYPE outbound_message_status AS ENUM ('PENDING', 'SENT', 'FAILED', 'AMBIGUOUS');
CREATE TYPE conversation_state AS ENUM (
  'IDLE',
  'AWAITING_SERVICE',
  'OFFERING_SLOTS',
  'AWAITING_BOOK_CONFIRM',
  'AWAITING_CANCEL_CONFIRM',
  'AWAITING_RESCHEDULE_SLOT'
);
CREATE TYPE booking_command_operation AS ENUM ('CREATE', 'RESCHEDULE', 'CANCEL');
CREATE TYPE message_direction AS ENUM ('INBOUND', 'OUTBOUND');

CREATE SCHEMA tavo_routing;
ALTER SCHEMA tavo_routing OWNER TO tavo_migrator;
REVOKE ALL ON SCHEMA tavo_routing FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM tavo_app;
REVOKE CREATE ON SCHEMA tavo_routing FROM PUBLIC;
REVOKE CREATE ON SCHEMA tavo_routing FROM tavo_app;
GRANT USAGE ON SCHEMA tavo_routing TO tavo_app;
GRANT USAGE ON SCHEMA public TO tavo_migrator, tavo_app;
GRANT CREATE ON SCHEMA public TO tavo_migrator;
GRANT CREATE ON SCHEMA tavo_routing TO tavo_migrator;

CREATE TABLE whatsapp_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  phone_number_id text NOT NULL,
  waba_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id),
  UNIQUE (phone_number_id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  customer_id uuid NOT NULL,
  state conversation_state NOT NULL DEFAULT 'IDLE',
  service_id uuid,
  pending_appointment_id uuid,
  current_offer_set_id uuid,
  lease_token text,
  clarify_count integer NOT NULL DEFAULT 0 CHECK (clarify_count >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  lock_version integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, customer_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES services (tenant_id, id)
);

CREATE TABLE whatsapp_inbound_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  conversation_id uuid,
  integration_id uuid NOT NULL,
  provider_message_id text NOT NULL,
  event_kind inbound_event_kind NOT NULL,
  status inbound_event_status NOT NULL DEFAULT 'RECEIVED',
  wa_timestamp timestamptz,
  payload_sha256 text NOT NULL,
  sender_encrypted text,
  sender_encryption_key_version integer,
  text_encrypted text,
  text_encryption_key_version integer,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  lock_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_message_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES whatsapp_integrations (tenant_id, id)
);

CREATE TABLE whatsapp_outbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  customer_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  caused_by_inbound_event_id uuid,
  status outbound_message_status NOT NULL DEFAULT 'PENDING',
  body_encrypted text NOT NULL,
  message_encryption_key_version integer NOT NULL,
  provider_message_id text,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  lock_expires_at timestamptz,
  last_error text,
  retry_class text CHECK (retry_class IS NULL OR retry_class IN ('TRANSIENT')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES whatsapp_integrations (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id),
  FOREIGN KEY (tenant_id, caused_by_inbound_event_id) REFERENCES whatsapp_inbound_events (tenant_id, id)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  conversation_id uuid NOT NULL,
  direction message_direction NOT NULL,
  body_encrypted text NOT NULL,
  message_encryption_key_version integer NOT NULL,
  inbound_event_id uuid,
  outbound_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id),
  FOREIGN KEY (tenant_id, inbound_event_id) REFERENCES whatsapp_inbound_events (tenant_id, id),
  FOREIGN KEY (tenant_id, outbound_id) REFERENCES whatsapp_outbound_messages (tenant_id, id)
);

CREATE TABLE offered_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  conversation_id uuid NOT NULL,
  offer_set_id uuid NOT NULL,
  slot_ref text NOT NULL,
  staff_id uuid NOT NULL,
  service_id uuid NOT NULL,
  start_at timestamptz NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by_inbound_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, slot_ref),
  UNIQUE (tenant_id, offer_set_id, ordinal),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff_members (tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES services (tenant_id, id),
  FOREIGN KEY (tenant_id, consumed_by_inbound_event_id) REFERENCES whatsapp_inbound_events (tenant_id, id)
);

CREATE TABLE booking_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses (id),
  command_key text NOT NULL,
  operation booking_command_operation NOT NULL,
  inbound_event_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, command_key),
  FOREIGN KEY (tenant_id, inbound_event_id) REFERENCES whatsapp_inbound_events (tenant_id, id),
  FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments (tenant_id, id)
);

CREATE TABLE system_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE whatsapp_integrations OWNER TO tavo_migrator;
ALTER TABLE conversations OWNER TO tavo_migrator;
ALTER TABLE whatsapp_inbound_events OWNER TO tavo_migrator;
ALTER TABLE whatsapp_outbound_messages OWNER TO tavo_migrator;
ALTER TABLE messages OWNER TO tavo_migrator;
ALTER TABLE offered_slots OWNER TO tavo_migrator;
ALTER TABLE booking_commands OWNER TO tavo_migrator;
ALTER TABLE system_security_events OWNER TO tavo_migrator;
ALTER TYPE inbound_event_status OWNER TO tavo_migrator;
ALTER TYPE inbound_event_kind OWNER TO tavo_migrator;
ALTER TYPE outbound_message_status OWNER TO tavo_migrator;
ALTER TYPE conversation_state OWNER TO tavo_migrator;
ALTER TYPE booking_command_operation OWNER TO tavo_migrator;
ALTER TYPE message_direction OWNER TO tavo_migrator;

GRANT USAGE ON TYPE inbound_event_status TO tavo_app;
GRANT USAGE ON TYPE inbound_event_kind TO tavo_app;
GRANT USAGE ON TYPE outbound_message_status TO tavo_app;
GRANT USAGE ON TYPE conversation_state TO tavo_app;
GRANT USAGE ON TYPE booking_command_operation TO tavo_app;
GRANT USAGE ON TYPE message_direction TO tavo_app;

GRANT SELECT, INSERT, UPDATE ON public.whatsapp_integrations TO tavo_app;
GRANT SELECT, INSERT, UPDATE ON public.conversations TO tavo_app;
GRANT SELECT, INSERT, UPDATE ON public.whatsapp_inbound_events TO tavo_app;
GRANT SELECT, INSERT, UPDATE ON public.whatsapp_outbound_messages TO tavo_app;
GRANT SELECT, INSERT ON public.messages TO tavo_app;
GRANT SELECT, INSERT, UPDATE ON public.offered_slots TO tavo_app;
GRANT SELECT, INSERT ON public.booking_commands TO tavo_app;

REVOKE ALL ON TABLE system_security_events FROM PUBLIC;
REVOKE ALL ON TABLE system_security_events FROM tavo_app;

ALTER TABLE whatsapp_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_integrations FORCE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_inbound_events FORCE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_outbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_outbound_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
ALTER TABLE offered_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE offered_slots FORCE ROW LEVEL SECURITY;
ALTER TABLE booking_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_commands FORCE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_integrations_isolation ON whatsapp_integrations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY conversations_isolation ON conversations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY whatsapp_inbound_events_isolation ON whatsapp_inbound_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY whatsapp_outbound_messages_isolation ON whatsapp_outbound_messages
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY messages_isolation ON messages
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY offered_slots_isolation ON offered_slots
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY booking_commands_isolation ON booking_commands
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION tavo_routing.resolve_whatsapp_integration(p_phone_number_id text)
RETURNS TABLE(tenant_id uuid, integration_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_phone_number_id IS NULL OR btrim(p_phone_number_id) = '' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT i.tenant_id, i.id
  FROM public.whatsapp_integrations AS i
  WHERE i.phone_number_id = p_phone_number_id
    AND i.status = 'active';
END;
$$;

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
      AND e.attempt_count < 8
      AND (
        (
          e.status IN ('RECEIVED', 'FAILED')
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
  )
  UPDATE public.whatsapp_inbound_events AS e
  SET
    status = 'PROCESSING',
    locked_by = p_worker_id,
    locked_at = pg_catalog.now(),
    lock_expires_at = pg_catalog.now() + '75 seconds'::pg_catalog.interval,
    attempt_count = e.attempt_count + 1
  FROM picked
  WHERE e.id = picked.id
  RETURNING e.id, e.tenant_id;
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
      AND o.attempt_count < 8
      AND o.next_attempt_at <= pg_catalog.now()
      AND (o.lock_expires_at IS NULL OR o.lock_expires_at < pg_catalog.now())
    ORDER BY o.created_at ASC
    FOR UPDATE OF o SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.whatsapp_outbound_messages AS o
  SET
    locked_by = p_worker_id,
    locked_at = pg_catalog.now(),
    lock_expires_at = pg_catalog.now() + '75 seconds'::pg_catalog.interval,
    attempt_count = o.attempt_count + 1
  FROM picked
  WHERE o.id = picked.id
  RETURNING o.id, o.tenant_id;
END;
$$;

CREATE OR REPLACE FUNCTION tavo_routing.insert_system_security_event(p_type text, p_details jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  k text;
  details jsonb;
BEGIN
  IF p_type IS NULL OR p_type NOT IN (
    'webhook.signature_rejected',
    'webhook.unknown_phone_number_id',
    'webhook.malformed_envelope'
  ) THEN
    RAISE EXCEPTION 'invalid system security event type';
  END IF;
  details := COALESCE(p_details, '{}'::jsonb);
  IF jsonb_typeof(details) <> 'object' THEN
    RAISE EXCEPTION 'invalid system security event details';
  END IF;
  FOR k IN SELECT jsonb_object_keys(details)
  LOOP
    IF k NOT IN ('reason', 'phone_number_id_hmac', 'schema') THEN
      RAISE EXCEPTION 'invalid system security event key';
    END IF;
  END LOOP;
  INSERT INTO public.system_security_events (event_type, details)
  VALUES (p_type, details);
END;
$$;

ALTER FUNCTION tavo_routing.resolve_whatsapp_integration(text) OWNER TO tavo_migrator;
ALTER FUNCTION tavo_routing.claim_next_inbound_job(text) OWNER TO tavo_migrator;
ALTER FUNCTION tavo_routing.claim_next_outbound_job(text) OWNER TO tavo_migrator;
ALTER FUNCTION tavo_routing.insert_system_security_event(text, jsonb) OWNER TO tavo_migrator;

REVOKE ALL ON FUNCTION tavo_routing.resolve_whatsapp_integration(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION tavo_routing.claim_next_inbound_job(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION tavo_routing.claim_next_outbound_job(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION tavo_routing.insert_system_security_event(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tavo_routing.resolve_whatsapp_integration(text) TO tavo_app;
GRANT EXECUTE ON FUNCTION tavo_routing.claim_next_inbound_job(text) TO tavo_app;
GRANT EXECUTE ON FUNCTION tavo_routing.claim_next_outbound_job(text) TO tavo_app;
GRANT EXECUTE ON FUNCTION tavo_routing.insert_system_security_event(text, jsonb) TO tavo_app;

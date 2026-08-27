-- Phase 2B: Silent Router relationship state. A customers row is not BUSINESS_VERIFIED.

CREATE TABLE public.conversation_routing (
  tenant_id uuid NOT NULL REFERENCES public.businesses (id),
  conversation_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  routing_state text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (routing_state IN ('UNKNOWN', 'BUSINESS_VERIFIED', 'PERSONAL_EXCLUDED', 'HUMAN_ONLY')),
  state_source text NOT NULL DEFAULT 'DETERMINISTIC'
    CHECK (state_source IN ('OWNER', 'DETERMINISTIC', 'SYSTEM')),
  owner_locked boolean NOT NULL DEFAULT false,
  evidence_codes text[] NOT NULL DEFAULT '{}',
  classifier_invoked_at timestamptz,
  classifier_label text
    CHECK (classifier_label IS NULL OR classifier_label IN ('BUSINESS', 'UNKNOWN')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES public.conversations (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES public.customers (tenant_id, id),
  CONSTRAINT conversation_routing_owner_states_chk CHECK (
    (
      routing_state IN ('PERSONAL_EXCLUDED', 'HUMAN_ONLY')
      AND state_source = 'OWNER'
      AND owner_locked
    )
    OR routing_state IN ('UNKNOWN', 'BUSINESS_VERIFIED')
  ),
  CONSTRAINT conversation_routing_owner_lock_chk CHECK (
    (NOT owner_locked) OR state_source = 'OWNER'
  )
);

ALTER TABLE public.conversation_routing OWNER TO tavo_migrator;

ALTER TABLE public.conversation_routing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_routing FORCE ROW LEVEL SECURITY;

CREATE POLICY conversation_routing_isolation ON public.conversation_routing
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE public.conversation_routing FROM PUBLIC;
REVOKE ALL ON TABLE public.conversation_routing FROM tavo_app;
GRANT SELECT, INSERT, UPDATE ON public.conversation_routing TO tavo_app;

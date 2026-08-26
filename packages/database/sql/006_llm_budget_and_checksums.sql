-- Durable LLM budgets and migration checksums.

ALTER TABLE public.schema_migrations
  ADD COLUMN IF NOT EXISTS checksum text;

CREATE TABLE public.llm_budget_windows (
  tenant_id uuid NOT NULL REFERENCES public.businesses (id),
  subject_key text NOT NULL,
  window_kind text NOT NULL CHECK (window_kind IN ('sender_minute', 'tenant_hour')),
  window_start timestamptz NOT NULL,
  hit_count integer NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  PRIMARY KEY (tenant_id, subject_key, window_kind, window_start)
);

ALTER TABLE public.llm_budget_windows OWNER TO tavo_migrator;
ALTER TABLE public.llm_budget_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.llm_budget_windows FORCE ROW LEVEL SECURITY;

CREATE POLICY llm_budget_windows_isolation ON public.llm_budget_windows
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.llm_budget_windows TO tavo_app;

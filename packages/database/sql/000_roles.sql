-- Privileged migrator vs runtime app. No passwords in this file.
-- Production: create these roles (or equivalent) and set passwords via the secret manager.
-- Tests: ephemeral PostgreSQL uses local trust authentication (see ephemeral-pg.ts).
-- tavo_migrator is never an application login.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tavo_migrator') THEN
    CREATE ROLE tavo_migrator LOGIN BYPASSRLS NOSUPERUSER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tavo_app') THEN
    CREATE ROLE tavo_app LOGIN NOBYPASSRLS NOSUPERUSER;
  END IF;
END $$;

ALTER ROLE tavo_migrator WITH LOGIN BYPASSRLS;
ALTER ROLE tavo_app WITH LOGIN NOBYPASSRLS;

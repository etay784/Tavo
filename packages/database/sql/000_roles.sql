-- Migration/admin role vs runtime application role.
-- Must run as a superuser. tavo_app must never own tables and must never have BYPASSRLS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tavo_migrator') THEN
    CREATE ROLE tavo_migrator LOGIN PASSWORD 'migrator-secret' BYPASSRLS NOSUPERUSER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tavo_app') THEN
    CREATE ROLE tavo_app LOGIN PASSWORD 'app-secret' NOBYPASSRLS NOSUPERUSER;
  END IF;
END $$;

ALTER ROLE tavo_migrator WITH LOGIN BYPASSRLS;
ALTER ROLE tavo_app WITH LOGIN NOBYPASSRLS;

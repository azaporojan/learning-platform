-- =============================================================================
-- Learning Platform — create the production database + dedicated app role
-- =============================================================================
-- Target : the shared PostgreSQL server managed by Dokploy
--          (project "Infrastructure" → service "postgres",
--           container/app name common-stuff-postgres-vmlpfq, external port 5455).
-- Run as : the `postgres` superuser, e.g.
--
--   # on the VPS (or via Dokploy → Infrastructure → postgres → Terminal tab)
--   docker exec -i $(docker ps -qf name=common-stuff-postgres-vmlpfq) \
--     psql -U postgres -v ON_ERROR_STOP=1 -v app_password='REPLACE_ME' -f - < scripts/sql/create-database.sql
--
--   # or from your machine through the exposed port
--   psql "host=<vps-host> port=5455 user=postgres dbname=postgres" \
--     -v ON_ERROR_STOP=1 -v app_password='REPLACE_ME' -f scripts/sql/create-database.sql
--
-- The password is passed as a psql variable (-v app_password=...) so it never
-- lands in git. Use the same value for DB_PASSWORD in the Dokploy application.
-- Safe to re-run: every statement is guarded / idempotent.
-- The server applies its own SQL migrations (server/db/migrations) on start —
-- no tables are created here.
-- =============================================================================

\set ON_ERROR_STOP on

-- 1. Dedicated login role (least privilege: no superuser, cannot create DBs/roles).
SELECT format('CREATE ROLE learning_platform LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'learning_platform')
\gexec

-- Re-runs: make sure the password matches the value configured in Dokploy.
ALTER ROLE learning_platform WITH LOGIN PASSWORD :'app_password';

-- 2. Database owned by that role.
SELECT 'CREATE DATABASE learning_platform OWNER learning_platform ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'learning_platform')
\gexec

REVOKE ALL ON DATABASE learning_platform FROM PUBLIC;
GRANT  ALL PRIVILEGES ON DATABASE learning_platform TO learning_platform;

-- 3. Inside the new database: the app role owns the public schema so the
--    migration runner can create tables, indexes, triggers and schema_migrations.
\connect learning_platform

ALTER SCHEMA public OWNER TO learning_platform;
GRANT ALL ON SCHEMA public TO learning_platform;

-- 4. Optional: let the existing read-only inspection role (PostgreSQL MCP
--    connector) read this database too, including tables created later.
--    Comment these four lines out if the mcp_readonly role does not exist.
GRANT CONNECT ON DATABASE learning_platform TO mcp_readonly;
GRANT USAGE ON SCHEMA public TO mcp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE learning_platform IN SCHEMA public GRANT SELECT ON TABLES TO mcp_readonly;

-- 5. Verify
SELECT d.datname, pg_catalog.pg_get_userbyid(d.datdba) AS owner, pg_encoding_to_char(d.encoding) AS encoding
FROM pg_database d WHERE d.datname = 'learning_platform';

SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin
FROM pg_roles WHERE rolname = 'learning_platform';

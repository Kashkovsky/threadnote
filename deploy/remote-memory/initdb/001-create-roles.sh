#!/bin/sh
set -eu

: "${THREADNOTE_REMOTE_MIGRATOR_PASSWORD:?set THREADNOTE_REMOTE_MIGRATOR_PASSWORD}"
: "${THREADNOTE_REMOTE_RUNTIME_PASSWORD:?set THREADNOTE_REMOTE_RUNTIME_PASSWORD}"

# These fixed role names deliberately are not configurable. Only passwords are
# passed as psql variables, so no environment value is interpreted as SQL.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 <<'SQL'
\getenv migrator_password THREADNOTE_REMOTE_MIGRATOR_PASSWORD
\getenv runtime_password THREADNOTE_REMOTE_RUNTIME_PASSWORD

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
  'threadnote_remote_migrator', :'migrator_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'threadnote_remote_migrator') \gexec

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
  'threadnote_remote_runtime', :'runtime_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'threadnote_remote_runtime') \gexec

ALTER ROLE threadnote_remote_migrator
  WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'migrator_password';
ALTER ROLE threadnote_remote_runtime
  WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'runtime_password';

GRANT CONNECT ON DATABASE threadnote_remote TO threadnote_remote_migrator, threadnote_remote_runtime;
GRANT CREATE ON DATABASE threadnote_remote TO threadnote_remote_migrator;

CREATE SCHEMA IF NOT EXISTS remote_memory AUTHORIZATION threadnote_remote_migrator;
ALTER SCHEMA remote_memory OWNER TO threadnote_remote_migrator;
REVOKE ALL ON SCHEMA remote_memory FROM PUBLIC;
REVOKE CREATE ON SCHEMA remote_memory FROM threadnote_remote_runtime;
GRANT USAGE ON SCHEMA remote_memory TO threadnote_remote_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE threadnote_remote_migrator IN SCHEMA remote_memory
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE threadnote_remote_migrator IN SCHEMA remote_memory
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
SQL

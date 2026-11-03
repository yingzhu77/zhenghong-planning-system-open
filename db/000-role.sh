#!/bin/sh
set -eu

: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"

# psql reads the password directly from the environment. It is never interpolated
# into shell/SQL text or placed in the command-line argument list.
psql --username "${POSTGRES_USER:-postgres}" --dbname "${POSTGRES_DB:-postgres}" \
  --set=ON_ERROR_STOP=1 <<'SQL'
\getenv app_db_password APP_DB_PASSWORD
SELECT 'CREATE ROLE app_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
\gexec
SELECT format('ALTER ROLE app_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', :'app_db_password')
\gexec
SQL

-- Server-only authentication state. Never expose app_private through the data API.
BEGIN;

CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;
GRANT USAGE ON SCHEMA app_private TO app_runtime;

CREATE TABLE IF NOT EXISTS app_private.auth_users (
    user_id text PRIMARY KEY,
    email text NOT NULL,
    password_hash text NOT NULL,
    disabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_users_email_lower_key
    ON app_private.auth_users (lower(email));

CREATE TABLE IF NOT EXISTS app_private.sessions (
    token_hash text PRIMARY KEY,
    user_id text NOT NULL REFERENCES app_private.auth_users(user_id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON app_private.sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON app_private.sessions(expires_at);

CREATE TABLE IF NOT EXISTS app_private.auth_challenges (
    id text PRIMARY KEY,
    email text NOT NULL,
    purpose text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_challenges_email_purpose_idx
    ON app_private.auth_challenges(lower(email), purpose);
CREATE INDEX IF NOT EXISTS auth_challenges_expires_at_idx
    ON app_private.auth_challenges(expires_at);

CREATE TABLE IF NOT EXISTS app_private.login_attempts (
    key text PRIMARY KEY,
    failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
    locked_until timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON app_private.auth_users,
    app_private.sessions, app_private.auth_challenges, app_private.login_attempts
    TO app_runtime;

COMMIT;

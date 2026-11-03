-- Only controlled account provisioning opts users into first-login changes.
-- Existing users remain compatible; this migration contains no account data.
BEGIN;

ALTER TABLE app_private.auth_users
    ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

COMMIT;

-- Formatting accompanies immutable coordination content. Existing sources keep
-- their original plain-text identity; no reports, reviews or accounts are moved.
BEGIN;
ALTER TABLE public.coordination_tasks ADD COLUMN IF NOT EXISTS rich_text jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(rich_text) = 'object');
-- The original INSERT guard and RLS still resolve active project reporters and
-- set their names. app_runtime retains SELECT/INSERT only: no source editing.
COMMIT;

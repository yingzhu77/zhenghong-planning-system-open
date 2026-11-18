BEGIN;

-- The application only returns the current assignee's draft. The existing
-- room write lock also serializes feedback saves with official publication.
ALTER TABLE app_private.weekly_collaboration_drafts
 ADD COLUMN IF NOT EXISTS followup_feedback jsonb NOT NULL DEFAULT '{}'
 CHECK(jsonb_typeof(followup_feedback)='object');

COMMIT;

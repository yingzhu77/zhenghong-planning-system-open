-- Additive, repeatable upgrade for existing installations. Historical business
-- strings, report versions, account bindings and project policies are unchanged.
BEGIN;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS rich_text jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rich_text) = 'object');
ALTER TABLE public.leader_reviews ADD COLUMN IF NOT EXISTS rich_text jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rich_text) = 'object');
ALTER TABLE public.leader_notes ADD COLUMN IF NOT EXISTS rich_text jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rich_text) = 'object');
ALTER TABLE public.milestones ADD COLUMN IF NOT EXISTS rich_text jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rich_text) = 'object');

-- Formatting a note is the same existing capability as editing its text. The
-- API permits only a note entry in the milestone formatting field map.
CREATE OR REPLACE FUNCTION app_private.guard_milestone_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF current_user <> 'app_runtime' THEN RETURN NEW; END IF;
    IF NOT app_private.has_approved_role(ARRAY['ops','president']) THEN
        IF NOT app_private.has_approved_role(ARRAY['pm'])
           OR NOT app_private.can_read_project(OLD.project_id)
           OR (to_jsonb(NEW) - ARRAY['forecast_date','note','rich_text','updated_at'])
              IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['forecast_date','note','rich_text','updated_at']) THEN
            RAISE EXCEPTION 'PM may update only forecast_date and note' USING ERRCODE = '42501';
        END IF;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_milestone_update() FROM PUBLIC;
COMMIT;

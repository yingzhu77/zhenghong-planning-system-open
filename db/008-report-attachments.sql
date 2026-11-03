-- Report attachments stay private until a real report references them.
-- The link is append-only so a later report revision cannot break history.
BEGIN;
CREATE TABLE IF NOT EXISTS public.report_attachments (
    id uuid PRIMARY KEY,
    project_id text NOT NULL REFERENCES public.projects(id),
    period text NOT NULL CHECK (length(btrim(period)) BETWEEN 1 AND 100),
    line text NOT NULL CHECK (length(btrim(line)) BETWEEN 1 AND 100),
    owner_id text NOT NULL REFERENCES public.profiles(user_id),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
    mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/gif','image/webp','application/pdf',
        'application/msword','application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
    size integer NOT NULL CHECK (size BETWEEN 1 AND 8388608),
    storage_key text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (storage_key ~ ('^report-attachments/' || id::text || '\.(jpg|png|gif|webp|pdf|doc|docx|xls|xlsx)$'))
);
CREATE INDEX IF NOT EXISTS report_attachments_owner_scope ON public.report_attachments(owner_id,project_id,period,line);
CREATE TABLE IF NOT EXISTS public.report_attachment_links (
    report_id bigint NOT NULL REFERENCES public.reports(id),
    attachment_id uuid NOT NULL REFERENCES public.report_attachments(id),
    project_id text NOT NULL REFERENCES public.projects(id),
    first_used_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (report_id,attachment_id)
);
CREATE INDEX IF NOT EXISTS report_attachment_links_attachment ON public.report_attachment_links(attachment_id);
ALTER TABLE public.report_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_attachment_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.report_attachments,public.report_attachment_links FROM PUBLIC,app_runtime;
GRANT SELECT,INSERT ON public.report_attachments TO app_runtime;
GRANT SELECT ON public.report_attachment_links TO app_runtime;

DROP POLICY IF EXISTS report_attachment_links_read ON public.report_attachment_links;
CREATE POLICY report_attachment_links_read ON public.report_attachment_links FOR SELECT TO app_runtime
    USING (EXISTS (SELECT 1 FROM public.reports r WHERE r.id=report_id AND r.project_id=report_attachment_links.project_id));
DROP POLICY IF EXISTS report_attachments_read ON public.report_attachments;
CREATE POLICY report_attachments_read ON public.report_attachments FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id) AND (
      (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))
      OR EXISTS (SELECT 1 FROM public.report_attachment_links l WHERE l.attachment_id=report_attachments.id)
    ));
DROP POLICY IF EXISTS report_attachments_insert ON public.report_attachments;
CREATE POLICY report_attachments_insert ON public.report_attachments FOR INSERT TO app_runtime
    WITH CHECK (owner_id=auth.uid() AND app_private.can_write_report(project_id,line,owner_id));

-- PostgreSQL row locks need UPDATE privilege. Keep the immutable attachment
-- table read/insert-only and expose a narrow owner-scoped lock instead.
CREATE OR REPLACE FUNCTION app_private.lock_report_attachments(attachment_ids uuid[])
RETURNS TABLE(id uuid,project_id text,period text,line text,owner_id text,size integer)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT a.id,a.project_id,a.period,a.line,a.owner_id,a.size
      FROM public.report_attachments a WHERE a.id=ANY(attachment_ids)
        AND a.owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm'])
        AND app_private.can_read_project(a.project_id) FOR SHARE;
$$;
REVOKE ALL ON FUNCTION app_private.lock_report_attachments(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.lock_report_attachments(uuid[]) TO app_runtime;

-- Quotas include every unreferenced file owned by this reporter, even if a
-- previous project assignment was later revoked. One owner lock serializes
-- uploads and discards without counting immutable submitted history.
CREATE OR REPLACE FUNCTION app_private.lock_report_attachment_draft_usage()
RETURNS TABLE(draft_count bigint,draft_bytes bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    IF NOT app_private.has_approved_role(ARRAY['pm']) THEN
        RAISE EXCEPTION 'Only approved reporters may reserve draft attachment storage' USING ERRCODE='42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('report-attachment-drafts:' || auth.uid(),0));
    RETURN QUERY SELECT count(*),COALESCE(sum(a.size),0)
      FROM public.report_attachments a WHERE a.owner_id=auth.uid()
        AND NOT EXISTS(SELECT 1 FROM public.report_attachment_links l WHERE l.attachment_id=a.id);
END;
$$;
REVOKE ALL ON FUNCTION app_private.lock_report_attachment_draft_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.lock_report_attachment_draft_usage() TO app_runtime;

CREATE OR REPLACE FUNCTION app_private.discard_report_attachment(target_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate public.report_attachments%ROWTYPE;
BEGIN
    IF NOT app_private.has_approved_role(ARRAY['pm']) THEN
        RAISE EXCEPTION 'Only approved reporters may discard draft attachments' USING ERRCODE='42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('report-attachment-drafts:' || auth.uid(),0));
    SELECT a.* INTO candidate FROM public.report_attachments a
      WHERE a.id=target_id AND a.owner_id=auth.uid() AND app_private.can_read_project(a.project_id) FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF EXISTS(SELECT 1 FROM public.report_attachment_links l WHERE l.attachment_id=target_id) THEN
        RAISE EXCEPTION 'Report attachment already has a submitted reference' USING ERRCODE='P0001';
    END IF;
    DELETE FROM public.report_attachments WHERE id=target_id;
    RETURN candidate.storage_key;
END;
$$;
REVOKE ALL ON FUNCTION app_private.discard_report_attachment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.discard_report_attachment(uuid) TO app_runtime;

-- Fixed-scope recovery releases quota from revoked projects without providing
-- an API for browsing those projects or deleting any submitted history.
CREATE OR REPLACE FUNCTION app_private.discard_inaccessible_report_drafts()
RETURNS TABLE(attachment_id uuid,storage_key text,freed_size integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate public.report_attachments%ROWTYPE;
BEGIN
    IF NOT app_private.has_approved_role(ARRAY['pm']) THEN
        RAISE EXCEPTION 'Only approved reporters may discard inaccessible drafts' USING ERRCODE='42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('report-attachment-drafts:' || auth.uid(),0));
    FOR candidate IN SELECT a.* FROM public.report_attachments a
      WHERE a.owner_id=auth.uid() AND NOT app_private.can_read_project(a.project_id)
        AND NOT EXISTS(SELECT 1 FROM public.report_attachment_links l WHERE l.attachment_id=a.id)
      ORDER BY a.id FOR UPDATE
    LOOP
        -- A waiting row lock may have allowed a report to commit its reference;
        -- recheck both eligibility predicates after the exclusive lock is held.
        IF NOT app_private.can_read_project(candidate.project_id)
           AND NOT EXISTS(SELECT 1 FROM public.report_attachment_links l WHERE l.attachment_id=candidate.id) THEN
            DELETE FROM public.report_attachments a WHERE a.id=candidate.id;
            attachment_id := candidate.id; storage_key := candidate.storage_key; freed_size := candidate.size;
            RETURN NEXT;
        END IF;
    END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION app_private.discard_inaccessible_report_drafts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.discard_inaccessible_report_drafts() TO app_runtime;

CREATE OR REPLACE FUNCTION app_private.bind_report_attachments()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ids uuid[]; actual_count integer; total_bytes bigint;
BEGIN
    IF NEW.biz IS NULL OR NOT (NEW.biz ? 'attachments') THEN RETURN NEW; END IF;
    IF jsonb_typeof(NEW.biz->'attachments') IS DISTINCT FROM 'array'
       OR jsonb_array_length(NEW.biz->'attachments') > 20 THEN
        RAISE EXCEPTION 'Report attachment list is invalid or exceeds 20 files' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.biz->'attachments') item
        WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
          OR (item #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
        RAISE EXCEPTION 'Report attachment identifier is invalid' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(array_agg(item::uuid),'{}'::uuid[]) INTO ids
      FROM jsonb_array_elements_text(NEW.biz->'attachments') item;
    IF cardinality(ids) <> (SELECT count(DISTINCT item) FROM unnest(ids) item) THEN
        RAISE EXCEPTION 'Repeated report attachment identifier' USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM public.report_attachments a WHERE a.id=ANY(ids) FOR SHARE;
    SELECT count(*),COALESCE(sum(size),0) INTO actual_count,total_bytes
      FROM public.report_attachments a WHERE a.id=ANY(ids) AND a.project_id=NEW.project_id
        AND a.period=NEW.period AND a.line=NEW.line AND a.owner_id=NEW.author_id;
    IF actual_count <> cardinality(ids) THEN
        RAISE EXCEPTION 'Report attachment is missing or belongs to another report scope' USING ERRCODE='42501';
    END IF;
    IF total_bytes > 41943040 THEN
        RAISE EXCEPTION 'Report attachments exceed 40 MiB' USING ERRCODE='23514';
    END IF;
    INSERT INTO public.report_attachment_links(report_id,attachment_id,project_id)
      SELECT NEW.id,item,NEW.project_id FROM unnest(ids) item ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.bind_report_attachments() FROM PUBLIC,app_runtime;
DROP TRIGGER IF EXISTS bind_report_attachments ON public.reports;
CREATE TRIGGER bind_report_attachments AFTER INSERT OR UPDATE ON public.reports
    FOR EACH ROW EXECUTE FUNCTION app_private.bind_report_attachments();
COMMIT;

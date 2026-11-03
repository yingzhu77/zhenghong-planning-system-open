-- New project-level shared documents only. Existing drawings, reports and files are untouched.
BEGIN;
CREATE TABLE IF NOT EXISTS public.project_library_documents (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES public.project_library_documents(id) DEFERRABLE INITIALLY DEFERRED,
  project_id text NOT NULL REFERENCES public.projects(id),
  category text NOT NULL DEFAULT '其他' CHECK(length(category) BETWEEN 1 AND 80),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 255),
  mime text NOT NULL CHECK(mime IN ('application/pdf','image/png','image/jpeg')),
  size integer NOT NULL CHECK(size BETWEEN 1 AND 8388608),
  version integer NOT NULL CHECK(version BETWEEN 1 AND 9999),
  storage_key text NOT NULL UNIQUE CHECK(storage_key ~ '^project-library/[a-f0-9-]{36}\.(pdf|png|jpg)$'),
  uploaded_by text NOT NULL REFERENCES public.profiles(user_id),
  uploaded_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  withdrawn_by text REFERENCES public.profiles(user_id),
  UNIQUE(document_id,version)
);
CREATE INDEX IF NOT EXISTS project_library_documents_project ON public.project_library_documents(project_id,created_at DESC);
CREATE TABLE IF NOT EXISTS public.project_library_events (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES public.projects(id),
  document_id uuid REFERENCES public.project_library_documents(id),
  actor_id text NOT NULL REFERENCES public.profiles(user_id),
  action text NOT NULL CHECK(action IN ('upload','withdraw','preview','download','original_download','password_changed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_library_events_project ON public.project_library_events(project_id,created_at DESC);
CREATE TABLE IF NOT EXISTS app_private.project_library_passwords (
  project_id text PRIMARY KEY REFERENCES public.projects(id),
  password_hash text NOT NULL,
  revision uuid NOT NULL,
  updated_by text NOT NULL REFERENCES public.profiles(user_id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON app_private.project_library_passwords FROM PUBLIC,app_runtime;
ALTER TABLE public.project_library_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_library_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_library_documents,public.project_library_events FROM PUBLIC,app_runtime;
GRANT SELECT,INSERT,UPDATE ON public.project_library_documents TO app_runtime;
GRANT SELECT,INSERT ON public.project_library_events TO app_runtime;
DROP POLICY IF EXISTS library_documents_read ON public.project_library_documents;
CREATE POLICY library_documents_read ON public.project_library_documents FOR SELECT TO app_runtime USING(app_private.can_read_project(project_id));
DROP POLICY IF EXISTS library_documents_insert ON public.project_library_documents;
CREATE POLICY library_documents_insert ON public.project_library_documents FOR INSERT TO app_runtime WITH CHECK(app_private.can_read_project(project_id) AND uploaded_by=auth.uid());
DROP POLICY IF EXISTS library_documents_withdraw ON public.project_library_documents;
CREATE POLICY library_documents_withdraw ON public.project_library_documents FOR UPDATE TO app_runtime
 USING(app_private.can_read_project(project_id) AND (uploaded_by=auth.uid() OR app_private.has_approved_role(ARRAY['ops'])))
 WITH CHECK(app_private.can_read_project(project_id) AND (uploaded_by=auth.uid() OR app_private.has_approved_role(ARRAY['ops'])));
DROP POLICY IF EXISTS library_events_read ON public.project_library_events;
CREATE POLICY library_events_read ON public.project_library_events FOR SELECT TO app_runtime
 USING(app_private.can_read_project(project_id) AND (actor_id=auth.uid() OR app_private.has_approved_role(ARRAY['ops'])));
DROP POLICY IF EXISTS library_events_insert ON public.project_library_events;
CREATE POLICY library_events_insert ON public.project_library_events FOR INSERT TO app_runtime WITH CHECK(app_private.can_read_project(project_id) AND actor_id=auth.uid());

CREATE OR REPLACE FUNCTION app_private.guard_library_document()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor public.profiles%ROWTYPE; family public.project_library_documents%ROWTYPE; last_version integer;
BEGIN
 SELECT * INTO actor FROM public.profiles WHERE user_id=auth.uid();
 IF actor.status IS DISTINCT FROM 'approved' OR NOT app_private.can_read_project(NEW.project_id) THEN
  RAISE EXCEPTION 'Project library access denied' USING ERRCODE='42501';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.uploaded_by<>auth.uid() OR NEW.withdrawn_at IS NOT NULL OR NEW.withdrawn_by IS NOT NULL THEN
   RAISE EXCEPTION 'Invalid document owner or withdrawal' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('project-library:'||NEW.document_id::text,0));
  IF NEW.document_id=NEW.id THEN
   IF NEW.version<>1 THEN RAISE EXCEPTION 'Initial version must be one' USING ERRCODE='23514'; END IF;
  ELSE
   SELECT * INTO family FROM public.project_library_documents WHERE id=NEW.document_id;
   IF NOT FOUND OR family.document_id<>family.id OR family.project_id<>NEW.project_id THEN
    RAISE EXCEPTION 'Document family not accessible' USING ERRCODE='42501';
   END IF;
   SELECT max(version) INTO last_version FROM public.project_library_documents WHERE document_id=NEW.document_id;
   IF NEW.version<>last_version+1 THEN RAISE EXCEPTION 'Document version changed' USING ERRCODE='40001'; END IF;
  END IF;
  NEW.uploaded_name:=actor.name; NEW.created_at:=now();
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR (OLD.uploaded_by<>auth.uid() AND actor.role<>'ops')
   OR OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL
   OR (to_jsonb(NEW)-ARRAY['withdrawn_at','withdrawn_by']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['withdrawn_at','withdrawn_by']) THEN
  RAISE EXCEPTION 'Only the uploader or operator may withdraw an unchanged document' USING ERRCODE='42501';
 END IF;
 NEW.withdrawn_at:=now(); NEW.withdrawn_by:=auth.uid(); RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_library_document() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_library_document ON public.project_library_documents;
CREATE TRIGGER guard_library_document BEFORE INSERT OR UPDATE OR DELETE ON public.project_library_documents FOR EACH ROW EXECUTE FUNCTION app_private.guard_library_document();

CREATE OR REPLACE FUNCTION app_private.library_password(p_project text)
RETURNS TABLE(password_hash text,revision uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app_private.can_read_project(p_project) THEN RAISE EXCEPTION 'Project library access denied' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT s.password_hash,s.revision FROM app_private.project_library_passwords s WHERE s.project_id=p_project;
END;
$$;
CREATE OR REPLACE FUNCTION app_private.set_library_password(p_project text,p_hash text,p_revision uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app_private.has_approved_role(ARRAY['ops']) OR NOT app_private.can_read_project(p_project) THEN
  RAISE EXCEPTION 'Only an operator may manage project download passwords' USING ERRCODE='42501';
 END IF;
 IF p_hash !~ '^scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$' OR p_revision IS NULL THEN
  RAISE EXCEPTION 'Invalid library password hash' USING ERRCODE='23514';
 END IF;
 INSERT INTO app_private.project_library_passwords(project_id,password_hash,revision,updated_by)
 VALUES(p_project,p_hash,p_revision,auth.uid())
 ON CONFLICT(project_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,revision=EXCLUDED.revision,updated_by=auth.uid(),updated_at=now();
END;
$$;
REVOKE ALL ON FUNCTION app_private.library_password(text),app_private.set_library_password(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.library_password(text),app_private.set_library_password(text,text,uuid) TO app_runtime;
COMMIT;

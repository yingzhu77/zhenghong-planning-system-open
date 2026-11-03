-- Personal AI text memory. Existing reports, local drafts and credentials are
-- neither imported nor modified. Empty bodies are revisioned deletion markers.
BEGIN;
CREATE OR REPLACE FUNCTION app_private.can_use_planning_ai_memory(pid text,module text,members text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT app_private.can_write_report(pid,module,auth.uid())
   AND COALESCE(array_length(members,1),0)>0 AND pid=ANY(members)
   AND NOT EXISTS(SELECT 1 FROM unnest(members) member WHERE member IS NULL OR member='' OR NOT app_private.can_read_project(member));
$$;
REVOKE ALL ON FUNCTION app_private.can_use_planning_ai_memory(text,text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.can_use_planning_ai_memory(text,text,text[]) TO app_runtime;

CREATE TABLE IF NOT EXISTS app_private.planning_ai_conversations (
 owner_id text NOT NULL REFERENCES public.profiles(user_id),
 project_id text NOT NULL REFERENCES public.projects(id),
 line text NOT NULL,
 report_scope_id text NOT NULL DEFAULT '',
 scope_project_ids text[] NOT NULL,
 scope_key text NOT NULL CHECK(scope_key~'^[0-9a-f]{64}$'),
 period_start date NOT NULL,
 messages jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(messages)='array' AND jsonb_array_length(messages)<=50 AND length(messages::text)<=120000),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>=1),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,project_id,line,scope_key,period_start)
);
CREATE TABLE IF NOT EXISTS app_private.planning_ai_preferences (
 owner_id text NOT NULL REFERENCES public.profiles(user_id),
 project_id text NOT NULL REFERENCES public.projects(id),
 line text NOT NULL,
 report_scope_id text NOT NULL DEFAULT '',
 scope_project_ids text[] NOT NULL,
 scope_key text NOT NULL CHECK(scope_key~'^[0-9a-f]{64}$'),
 content text NOT NULL DEFAULT '' CHECK(length(content)<=1500),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>=1),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,project_id,line,scope_key)
);
ALTER TABLE app_private.planning_ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.planning_ai_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.planning_ai_conversations,app_private.planning_ai_preferences FROM PUBLIC,app_runtime;
GRANT SELECT,INSERT,UPDATE ON app_private.planning_ai_conversations,app_private.planning_ai_preferences TO app_runtime;
DROP POLICY IF EXISTS planning_ai_conversations_owner ON app_private.planning_ai_conversations;
CREATE POLICY planning_ai_conversations_owner ON app_private.planning_ai_conversations TO app_runtime
 USING(owner_id=auth.uid() AND app_private.can_use_planning_ai_memory(project_id,line,scope_project_ids))
 WITH CHECK(owner_id=auth.uid() AND app_private.can_use_planning_ai_memory(project_id,line,scope_project_ids));
DROP POLICY IF EXISTS planning_ai_preferences_owner ON app_private.planning_ai_preferences;
CREATE POLICY planning_ai_preferences_owner ON app_private.planning_ai_preferences TO app_runtime
 USING(owner_id=auth.uid() AND app_private.can_use_planning_ai_memory(project_id,line,scope_project_ids))
 WITH CHECK(owner_id=auth.uid() AND app_private.can_use_planning_ai_memory(project_id,line,scope_project_ids));

CREATE OR REPLACE FUNCTION app_private.guard_planning_ai_memory()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE entry jsonb; content text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI记忆内容请通过清除操作删除' USING ERRCODE='42501'; END IF;
 IF NEW.owner_id IS DISTINCT FROM auth.uid() OR NOT app_private.can_use_planning_ai_memory(NEW.project_id,NEW.line,NEW.scope_project_ids) THEN
  RAISE EXCEPTION 'AI memory scope denied' USING ERRCODE='42501';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['messages','content','revision','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['messages','content','revision','updated_at']) THEN
   RAISE EXCEPTION 'AI记忆归属不可修改' USING ERRCODE='42501';
  END IF;
  IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'AI记忆版本已变化' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'AI记忆初始版本不正确' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_TABLE_NAME='planning_ai_conversations' THEN
  IF jsonb_typeof(NEW.messages) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.messages)>50 OR length(NEW.messages::text)>120000 THEN
   RAISE EXCEPTION 'AI对话记录过长，请分段保留' USING ERRCODE='23514';
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(NEW.messages) LOOP
   IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR entry-ARRAY['role','content']<>'{}'::jsonb
     OR COALESCE(entry->>'role','') NOT IN ('user','assistant') OR jsonb_typeof(entry->'content') IS DISTINCT FROM 'string'
     OR btrim(entry->>'content')='' OR length(entry->>'content')>12000 THEN
    RAISE EXCEPTION 'AI对话仅支持用户与助手的文字记录' USING ERRCODE='23514';
   END IF;
  END LOOP;
  content:=NEW.messages::text;
 ELSE
  content:=NEW.content;
  IF length(content)>1500 THEN RAISE EXCEPTION '个人写法记忆不可超过1500字' USING ERRCODE='23514'; END IF;
 END IF;
 IF content~'sk-[A-Za-z0-9_-]{16,160}|-----BEGIN (OPENSSH |RSA |EC )?PRIVATE KEY-----' THEN
  RAISE EXCEPTION '记忆内容包含疑似密钥，请移除后再保存' USING ERRCODE='23514';
 END IF;
 NEW.updated_at:=now();RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_planning_ai_memory() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_planning_ai_memory ON app_private.planning_ai_conversations;
CREATE TRIGGER guard_planning_ai_memory BEFORE INSERT OR UPDATE OR DELETE ON app_private.planning_ai_conversations FOR EACH ROW EXECUTE FUNCTION app_private.guard_planning_ai_memory();
DROP TRIGGER IF EXISTS guard_planning_ai_memory ON app_private.planning_ai_preferences;
CREATE TRIGGER guard_planning_ai_memory BEFORE INSERT OR UPDATE OR DELETE ON app_private.planning_ai_preferences FOR EACH ROW EXECUTE FUNCTION app_private.guard_planning_ai_memory();
COMMIT;

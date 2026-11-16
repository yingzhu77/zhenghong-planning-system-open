BEGIN;

ALTER TABLE app_private.weekly_collaboration_operations DROP CONSTRAINT IF EXISTS weekly_collaboration_operations_kind_check;
ALTER TABLE app_private.weekly_collaboration_operations ADD CONSTRAINT weekly_collaboration_operations_kind_check
 CHECK(kind IN ('designate','items','edit','publish','withdraw'));

CREATE TABLE IF NOT EXISTS app_private.weekly_collaboration_withdrawals (
 report_id bigint PRIMARY KEY,
 project_id text NOT NULL,
 line text NOT NULL,
 week date NOT NULL,
 operation_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 actor_id text NOT NULL REFERENCES public.profiles(user_id),
 report_snapshot jsonb NOT NULL CHECK(jsonb_typeof(report_snapshot)='object'),
 withdrawn_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(project_id,line,week,revision),
 FOREIGN KEY(project_id,line,week,operation_id)
  REFERENCES app_private.weekly_collaboration_operations(project_id,line,week,operation_id)
);

CREATE TABLE IF NOT EXISTS app_private.weekly_collaboration_withdrawal_attachments (
 report_id bigint NOT NULL REFERENCES app_private.weekly_collaboration_withdrawals(report_id),
 attachment_id uuid NOT NULL REFERENCES public.report_attachments(id),
 project_id text NOT NULL REFERENCES public.projects(id),
 first_used_at timestamptz NOT NULL,
 PRIMARY KEY(report_id,attachment_id)
);
CREATE INDEX IF NOT EXISTS weekly_withdrawal_attachments_attachment
 ON app_private.weekly_collaboration_withdrawal_attachments(attachment_id);

REVOKE ALL ON app_private.weekly_collaboration_withdrawals,
 app_private.weekly_collaboration_withdrawal_attachments FROM PUBLIC,app_runtime;

CREATE OR REPLACE FUNCTION app_private.owner_has_withdrawn_report_attachment(target_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM app_private.weekly_collaboration_withdrawal_attachments l
  JOIN public.report_attachments a ON a.id=l.attachment_id
  WHERE l.attachment_id=target_id AND a.owner_id=auth.uid());
$$;

-- Withdrawn submissions do not consume draft quota, and their files remain
-- protected just like files referenced by a report that is still visible.
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
   AND NOT EXISTS(SELECT 1 FROM public.report_attachment_links l WHERE l.attachment_id=a.id)
   AND NOT app_private.owner_has_withdrawn_report_attachment(a.id);
END;
$$;

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
 IF EXISTS(SELECT 1 FROM public.report_attachment_links l WHERE l.attachment_id=target_id)
  OR app_private.owner_has_withdrawn_report_attachment(target_id) THEN
  RAISE EXCEPTION 'Report attachment already has a submitted reference' USING ERRCODE='P0001';
 END IF;
 DELETE FROM public.report_attachments WHERE id=target_id;
 RETURN candidate.storage_key;
END;
$$;

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
  WHERE a.owner_id=auth.uid()
   AND NOT (CASE WHEN a.report_scope_id IS NULL THEN app_private.can_read_project(a.project_id)
     ELSE app_private.can_read_report_scope(a.scope_project_ids) END)
   AND NOT EXISTS(SELECT 1 FROM public.report_attachment_links l WHERE l.attachment_id=a.id)
   AND NOT app_private.owner_has_withdrawn_report_attachment(a.id)
  ORDER BY a.id FOR UPDATE
 LOOP
  -- A report can commit while cleanup waits for the attachment row lock.
  IF NOT (CASE WHEN candidate.report_scope_id IS NULL THEN app_private.can_read_project(candidate.project_id)
    ELSE app_private.can_read_report_scope(candidate.scope_project_ids) END)
   AND NOT EXISTS(SELECT 1 FROM public.report_attachment_links l WHERE l.attachment_id=candidate.id)
   AND NOT app_private.owner_has_withdrawn_report_attachment(candidate.id) THEN
   DELETE FROM public.report_attachments a WHERE a.id=candidate.id;
   attachment_id := candidate.id; storage_key := candidate.storage_key; freed_size := candidate.size;
   RETURN NEXT;
  END IF;
 END LOOP;
END;
$$;

-- Publishing once locks the confirmed plan, even while the weekly report is
-- back in its draft state or after a different weekly revision is submitted.
CREATE OR REPLACE FUNCTION app_private.withdrawn_report_references_monthly_plan(plan_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM app_private.weekly_collaboration_withdrawals w WHERE
   w.report_snapshot->'biz'->>'monthly_plan_id'=plan_id::text
   OR w.report_snapshot->'biz'->'monthly_plan_ids'?plan_id::text
   OR w.report_snapshot->'history' @> jsonb_build_array(jsonb_build_object('data',jsonb_build_object('biz',jsonb_build_object('monthly_plan_id',plan_id::text))))
   OR w.report_snapshot->'history' @> jsonb_build_array(jsonb_build_object('data',jsonb_build_object('biz',jsonb_build_object('monthly_plan_ids',jsonb_build_array(plan_id::text))))));
$$;
REVOKE ALL ON FUNCTION app_private.withdrawn_report_references_monthly_plan(uuid) FROM PUBLIC,app_runtime;

CREATE OR REPLACE FUNCTION app_private.monthly_plan_is_referenced(plan_id uuid,pid text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.reports r WHERE r.biz->>'monthly_plan_id'=plan_id::text OR r.biz->'monthly_plan_ids'?plan_id::text
 OR r.history @> jsonb_build_array(jsonb_build_object('data',jsonb_build_object('biz',jsonb_build_object('monthly_plan_id',plan_id::text))))
 OR r.history @> jsonb_build_array(jsonb_build_object('data',jsonb_build_object('biz',jsonb_build_object('monthly_plan_ids',jsonb_build_array(plan_id::text))))))
 OR app_private.withdrawn_report_references_monthly_plan(plan_id)
 OR EXISTS(SELECT 1 FROM public.completion_requests c WHERE left(c.source_key,length('monthly:'||pid||':'||plan_id::text||':'))='monthly:'||pid||':'||plan_id::text||':'
 OR c.source_snapshot->>'monthly_plan_id'=plan_id::text);
$$;

CREATE OR REPLACE FUNCTION app_private.withdraw_monthly_plan(pid text,module text,target_month date,expected_plan_id uuid,scope_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected public.monthly_plans%ROWTYPE; configured app_private.report_scopes%ROWTYPE; original jsonb; prefix text;
BEGIN
 IF scope_id IS NULL THEN
  IF NOT app_private.can_confirm_monthly_scope(pid,module) THEN RAISE EXCEPTION '仅可撤回本人获授权专业的月计划' USING ERRCODE='42501'; END IF;
 ELSE
  SELECT * INTO configured FROM app_private.report_scopes WHERE id=scope_id FOR SHARE;
  IF NOT FOUND OR NOT app_private.can_confirm_scoped_monthly_plan(pid,module,scope_id) THEN RAISE EXCEPTION '统一月计划撤回需要本人专业及全部成员授权' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('monthly-scope-plan:'||jsonb_build_array(scope_id,to_char(target_month,'YYYY-MM-DD'))::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('monthly-plan:'||jsonb_build_array(pid,module,to_char(target_month,'YYYY-MM-DD'))::text,0));
 SELECT * INTO selected FROM public.monthly_plans p WHERE p.project_id=pid AND p.line=module AND p.plan_month=target_month
   AND p.report_scope_id IS NOT DISTINCT FROM scope_id AND p.id=expected_plan_id FOR UPDATE;
 IF NOT FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.monthly_plans p WHERE p.project_id=pid AND p.line=module AND p.plan_month=target_month AND p.confirmed_by=auth.uid()) THEN
   SELECT a.snapshot INTO original FROM app_private.monthly_plan_withdrawals a WHERE a.plan_id=expected_plan_id
     AND a.project_id=pid AND a.line=module AND a.plan_month=target_month AND a.withdrawn_by=auth.uid()
     AND (a.snapshot->>'report_scope_id') IS NOT DISTINCT FROM scope_id;
   IF FOUND AND (scope_id IS NULL OR app_private.can_confirm_scoped_monthly_plan(pid,module,scope_id)
      AND original->'scope_project_ids'=to_jsonb(configured.project_ids)) THEN RETURN original; END IF;
  END IF;
  RAISE EXCEPTION '月计划确认版已变化，请刷新后重新操作' USING ERRCODE='P0002';
 END IF;
 IF selected.confirmed_by IS DISTINCT FROM auth.uid() OR (CASE WHEN scope_id IS NULL
   THEN NOT app_private.can_confirm_monthly_scope(pid,module)
   ELSE NOT app_private.can_confirm_scoped_monthly_plan(pid,module,scope_id) OR selected.scope_project_ids IS DISTINCT FROM configured.project_ids END) THEN
  RAISE EXCEPTION '仅原确认人可以撤回本人当前获授权的月计划' USING ERRCODE='42501'; END IF;
 IF app_private.withdrawn_report_references_monthly_plan(selected.id)
  OR EXISTS(SELECT 1 FROM public.reports r WHERE r.biz->>'monthly_plan_id'=selected.id::text OR r.biz->'monthly_plan_ids'?selected.id::text
   OR r.history @> jsonb_build_array(jsonb_build_object('data',jsonb_build_object('biz',jsonb_build_object('monthly_plan_id',selected.id::text))))
   OR r.history @> jsonb_build_array(jsonb_build_object('data',jsonb_build_object('biz',jsonb_build_object('monthly_plan_ids',jsonb_build_array(selected.id::text)))))) THEN
  RAISE EXCEPTION '该月计划已有周报或历史周报引用，不能撤回；原填报记录已保留' USING ERRCODE='23514',DETAIL='monthly_plan_in_use'; END IF;
 prefix:='monthly:'||pid||':'||selected.id::text||':';
 IF EXISTS(SELECT 1 FROM public.completion_requests c WHERE left(c.source_key,length(prefix))=prefix OR c.source_snapshot->>'monthly_plan_id'=selected.id::text) THEN
  RAISE EXCEPTION '该月计划已有完成或延期申报记录，不能撤回；原申报及审核记录已保留' USING ERRCODE='23514',DETAIL='monthly_plan_in_use'; END IF;
 original:=to_jsonb(selected);
 INSERT INTO app_private.monthly_plan_withdrawals(plan_id,project_id,line,plan_month,withdrawn_by,snapshot) VALUES(selected.id,pid,module,target_month,auth.uid(),original);
 DELETE FROM public.monthly_plans WHERE id=selected.id;RETURN original;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.weekly_withdrawal_info(pid text,module text,scope_id text,target_week date)
RETURNS TABLE(can_withdraw boolean,withdrawn_revision integer,withdrawn_attachment_ids jsonb,withdraw_blocked boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT current_week.published AND NOT dependencies.blocked,
  archive.revision,
  COALESCE((
    SELECT jsonb_agg(item.id ORDER BY item.position)
    FROM jsonb_array_elements_text(COALESCE(archive.report_snapshot->'biz'->'attachments','[]'::jsonb))
     WITH ORDINALITY AS item(id,position)
    JOIN app_private.weekly_collaboration_withdrawal_attachments link
     ON link.report_id=archive.report_id AND link.attachment_id::text=item.id
  ),'[]'::jsonb),
  current_week.published AND dependencies.blocked
 FROM app_private.weekly_collaboration_drafts d
 CROSS JOIN LATERAL (
  SELECT d.published_report_id IS NOT NULL AND d.week=date_trunc('week',now() AT TIME ZONE 'Asia/Shanghai')::date AS published
 ) current_week
 CROSS JOIN LATERAL (
  SELECT EXISTS(SELECT 1 FROM public.completion_requests c WHERE c.report_id=d.published_report_id)
   OR EXISTS(SELECT 1 FROM app_private.hongfang_weekly_drafts p WHERE p.published_report_id=d.published_report_id) AS blocked
 ) dependencies
 LEFT JOIN LATERAL (
  SELECT w.report_id,w.revision,w.report_snapshot
  FROM app_private.weekly_collaboration_withdrawals w
  WHERE (w.project_id,w.line,w.week,w.actor_id)=(d.project_id,d.line,d.week,d.submitter_id)
  ORDER BY w.revision DESC LIMIT 1
 ) archive ON d.published_report_id IS NULL
 WHERE (d.project_id,d.line,d.week)=(pid,module,target_week)
  AND d.report_scope_id IS NOT DISTINCT FROM scope_id AND d.submitter_id=auth.uid()
  AND app_private.weekly_collaboration_room_access(auth.uid(),pid,module,scope_id,target_week)='member';
$$;

CREATE OR REPLACE FUNCTION app_private.withdraw_weekly_collaboration_report(
 pid text,module text,scope_id text,target_week date,target_report_id bigint,expected_revision integer,withdraw_operation uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected app_private.weekly_collaboration_drafts%ROWTYPE;
 original public.reports%ROWTYPE;
BEGIN
 PERFORM app_private.lock_weekly_collaboration_write(pid,module,target_week);
 SELECT d.* INTO selected FROM app_private.weekly_collaboration_drafts d
  WHERE (d.project_id,d.line,d.week)=(pid,module,target_week) FOR UPDATE;
 IF NOT FOUND OR selected.submitter_id IS DISTINCT FROM auth.uid()
  OR selected.report_scope_id IS DISTINCT FROM scope_id
  OR app_private.weekly_collaboration_room_access(auth.uid(),pid,module,scope_id,target_week) IS DISTINCT FROM 'member' THEN
  RAISE EXCEPTION '仅本周指定提交负责人可撤回周报' USING ERRCODE='P4403';
 END IF;
 IF selected.week<>date_trunc('week',now() AT TIME ZONE 'Asia/Shanghai')::date
  OR selected.revision IS DISTINCT FROM expected_revision OR selected.published_report_id IS NULL
  OR selected.published_report_id IS DISTINCT FROM target_report_id OR NOT EXISTS (
   SELECT 1 FROM app_private.weekly_collaboration_operations o
   WHERE (o.project_id,o.line,o.week,o.operation_id)=(pid,module,target_week,withdraw_operation)
    AND o.actor_id=selected.submitter_id AND o.kind='withdraw' AND o.revision=selected.revision+1
  ) THEN
  RAISE EXCEPTION '周报周期、版本或提交状态已变化，请刷新后核对' USING ERRCODE='P4401';
 END IF;

 -- Lock the report before checking dependent rows. Concurrent references
 -- require a key share lock and cannot be created between check and removal.
 SELECT r.* INTO original FROM public.reports r WHERE r.id=target_report_id FOR UPDATE;
 IF NOT FOUND OR (original.project_id,original.line,original.author_id)
  IS DISTINCT FROM (pid,module,selected.submitter_id) OR original.report_scope_id IS DISTINCT FROM scope_id
  OR app_private.weekly_collaboration_existing_report_week(original.period,original.submitted_at) IS DISTINCT FROM target_week
  OR original.biz->'weekly_collaboration' IS DISTINCT FROM
    jsonb_build_object('week',to_char(target_week,'YYYY-MM-DD'),'revision',selected.published_revision) THEN
  RAISE EXCEPTION '已提交周报版本或归属已变化，请刷新后核对' USING ERRCODE='P4401';
 END IF;
 IF EXISTS(SELECT 1 FROM public.completion_requests c WHERE c.report_id=target_report_id)
  OR EXISTS(SELECT 1 FROM app_private.hongfang_weekly_drafts d WHERE d.published_report_id=target_report_id) THEN
  RAISE EXCEPTION '该周报已有申报记录或历史试点关联，暂不能撤回' USING ERRCODE='P4402';
 END IF;

 INSERT INTO app_private.weekly_collaboration_withdrawals
  (report_id,project_id,line,week,operation_id,revision,actor_id,report_snapshot)
 VALUES(target_report_id,pid,module,target_week,withdraw_operation,selected.revision+1,selected.submitter_id,to_jsonb(original));
 INSERT INTO app_private.weekly_collaboration_withdrawal_attachments(report_id,attachment_id,project_id,first_used_at)
 SELECT l.report_id,l.attachment_id,l.project_id,l.first_used_at
  FROM public.report_attachment_links l WHERE l.report_id=target_report_id;
 UPDATE app_private.weekly_collaboration_drafts d
  SET published_report_id=NULL,published_revision=NULL,revision=selected.revision+1
  WHERE (d.project_id,d.line,d.week)=(pid,module,target_week);
 DELETE FROM public.report_attachment_links WHERE report_id=target_report_id;
 DELETE FROM public.reports WHERE id=target_report_id;
END;
$$;

REVOKE ALL ON FUNCTION app_private.owner_has_withdrawn_report_attachment(uuid),
 app_private.weekly_withdrawal_info(text,text,text,date),
 app_private.withdraw_weekly_collaboration_report(text,text,text,date,bigint,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.owner_has_withdrawn_report_attachment(uuid),
 app_private.weekly_withdrawal_info(text,text,text,date),
 app_private.withdraw_weekly_collaboration_report(text,text,text,date,bigint,integer,uuid) TO app_runtime;

COMMIT;

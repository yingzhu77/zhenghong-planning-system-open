-- Reopen unused confirmations without changing published reports or approvals.
-- Archived originals remain private; runtime retains SELECT/INSERT only.
BEGIN;
CREATE TABLE IF NOT EXISTS app_private.monthly_plan_withdrawals (
    plan_id uuid PRIMARY KEY,
    project_id text NOT NULL,
    line text NOT NULL,
    plan_month date NOT NULL,
    withdrawn_by text NOT NULL REFERENCES public.profiles(user_id),
    withdrawn_at timestamptz NOT NULL DEFAULT now(),
    withdrawal_txid bigint NOT NULL DEFAULT txid_current(),
    snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object')
);
REVOKE ALL ON app_private.monthly_plan_withdrawals FROM PUBLIC,app_runtime;

CREATE OR REPLACE FUNCTION app_private.guard_monthly_plan()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor public.profiles%ROWTYPE; item jsonb; ids text[]:='{}';
BEGIN
    IF TG_OP='DELETE' THEN
        IF current_user<>'app_runtime' AND EXISTS(
            SELECT 1 FROM app_private.monthly_plan_withdrawals a WHERE a.plan_id=OLD.id
            AND a.withdrawn_by=auth.uid() AND a.withdrawal_txid=txid_current() AND a.snapshot=to_jsonb(OLD)) THEN RETURN OLD; END IF;
        RAISE EXCEPTION '月度计划只允许通过撤回确认操作移入历史记录' USING ERRCODE='42501';
    END IF;
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION '月度计划确认后不可修改或删除' USING ERRCODE='42501'; END IF;
    SELECT * INTO actor FROM public.profiles WHERE user_id=auth.uid();
    IF actor.status IS DISTINCT FROM 'approved' OR actor.role<>'pm'
      OR NOT app_private.can_write_report(NEW.project_id,NEW.line,auth.uid())
      OR NOT app_private.can_confirm_monthly_scope(NEW.project_id,NEW.line) THEN
        RAISE EXCEPTION 'Monthly plan confirmation denied' USING ERRCODE='42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('monthly-plan:'||jsonb_build_array(NEW.project_id,NEW.line,to_char(NEW.plan_month,'YYYY-MM-DD'))::text,0));
    IF jsonb_typeof(NEW.items) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.items)>500 THEN
        RAISE EXCEPTION '月度计划须为最多500项的列表' USING ERRCODE='23514';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(NEW.items) LOOP
        IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR (item->>'source_id') IS NULL
          OR (item->>'source_id')!~'^[A-Za-z0-9_-]{1,200}$' OR (item->>'source_id')=ANY(ids)
          OR jsonb_typeof(item->'mod') IS DISTINCT FROM 'string'
          OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string' OR btrim(item->>'name')=''
          OR jsonb_typeof(item->'due') IS DISTINCT FROM 'string'
          OR (item-ARRAY['source_id','mod','name','due'])<>'{}'::jsonb THEN
            RAISE EXCEPTION '月度计划事项标识或左三列内容不正确' USING ERRCODE='23514';
        END IF;
        ids:=array_append(ids,item->>'source_id');
    END LOOP;
    NEW.confirmed_by:=auth.uid(); NEW.confirmed_name:=actor.name; NEW.confirmed_at:=now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.withdraw_monthly_plan(pid text,module text,target_month date,expected_plan_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected public.monthly_plans%ROWTYPE; original jsonb; prefix text;
BEGIN
    IF NOT app_private.can_confirm_monthly_scope(pid,module) THEN
        RAISE EXCEPTION '仅可撤回本人获授权专业的月计划' USING ERRCODE='42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('monthly-plan:'||jsonb_build_array(pid,module,to_char(target_month,'YYYY-MM-DD'))::text,0));
    IF NOT app_private.can_confirm_monthly_scope(pid,module) THEN
        RAISE EXCEPTION '月计划撤回权限已变化，请刷新后重新操作' USING ERRCODE='42501';
    END IF;
    SELECT * INTO selected FROM public.monthly_plans p
      WHERE p.project_id=pid AND p.line=module AND p.plan_month=target_month AND p.id=expected_plan_id FOR UPDATE;
    IF NOT FOUND THEN
        -- A lost HTTP response can be retried with the same original ID. A
        -- different active confirmation must never be withdrawn by that retry.
        IF NOT EXISTS(SELECT 1 FROM public.monthly_plans p WHERE p.project_id=pid AND p.line=module AND p.plan_month=target_month) THEN
            SELECT a.snapshot INTO original FROM app_private.monthly_plan_withdrawals a WHERE a.plan_id=expected_plan_id
              AND a.project_id=pid AND a.line=module AND a.plan_month=target_month AND a.withdrawn_by=auth.uid();
            IF FOUND THEN RETURN original; END IF;
        END IF;
        RAISE EXCEPTION '月计划确认版已变化，请刷新后重新操作' USING ERRCODE='P0002';
    END IF;
    IF NOT app_private.can_confirm_monthly_scope(pid,module) OR selected.confirmed_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION '仅原确认人可以撤回本人的月计划' USING ERRCODE='42501';
    END IF;
    -- Separate statements after the row lock see concurrent submissions that
    -- finished while this transaction was waiting for the same plan.
    IF EXISTS(SELECT 1 FROM public.reports r WHERE r.biz->>'monthly_plan_id'=selected.id::text
      OR r.history @> jsonb_build_array(jsonb_build_object('data',jsonb_build_object('biz',jsonb_build_object('monthly_plan_id',selected.id::text))))) THEN
        RAISE EXCEPTION '该月计划已有周报或历史周报引用，不能撤回；原填报记录已保留' USING ERRCODE='23514',DETAIL='monthly_plan_in_use';
    END IF;
    prefix:='monthly:'||pid||':'||selected.id::text||':';
    IF EXISTS(SELECT 1 FROM public.completion_requests c WHERE left(c.source_key,length(prefix))=prefix
      OR c.source_snapshot->>'monthly_plan_id'=selected.id::text) THEN
        RAISE EXCEPTION '该月计划已有完成或延期申报记录，不能撤回；原申报及审核记录已保留' USING ERRCODE='23514',DETAIL='monthly_plan_in_use';
    END IF;
    original:=to_jsonb(selected);
    INSERT INTO app_private.monthly_plan_withdrawals(plan_id,project_id,line,plan_month,withdrawn_by,snapshot)
      VALUES(selected.id,pid,module,target_month,auth.uid(),original);
    DELETE FROM public.monthly_plans WHERE id=selected.id;
    RETURN original;
END;
$$;
REVOKE ALL ON FUNCTION app_private.withdraw_monthly_plan(text,text,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.withdraw_monthly_plan(text,text,date,uuid) TO app_runtime;

-- An application lookup alone cannot close the race between a completion
-- request and withdrawal. Hold the source row until the request commits.
CREATE OR REPLACE FUNCTION app_private.guard_monthly_completion_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    IF array_length(string_to_array(NEW.source_key,':'),1)<>4 OR split_part(NEW.source_key,':',2)<>NEW.project_id THEN
        RAISE EXCEPTION '月度计划申报来源与项目不匹配' USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM public.monthly_plans p WHERE p.id::text=split_part(NEW.source_key,':',3)
      AND p.project_id=NEW.project_id AND p.confirmed_by=NEW.owner_id
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.items) i WHERE i->>'source_id'=split_part(NEW.source_key,':',4)) FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION '月度计划确认版或事项已变化，请刷新后重新申报' USING ERRCODE='23514'; END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_monthly_completion_source() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_monthly_completion_source ON public.completion_requests;
CREATE TRIGGER guard_monthly_completion_source BEFORE INSERT OR UPDATE ON public.completion_requests
    FOR EACH ROW WHEN(split_part(NEW.source_key,':',1)='monthly') EXECUTE FUNCTION app_private.guard_monthly_completion_source();
COMMIT;

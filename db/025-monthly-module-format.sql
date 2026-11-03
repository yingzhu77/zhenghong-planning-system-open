-- Preserve module formatting alongside the already locked name formatting.
-- CREATE OR REPLACE retains the existing function owner and grants; no business rows change.
CREATE OR REPLACE FUNCTION app_private.monthly_items_unchanged(
    proposed jsonb,baseline jsonb,proposed_rich jsonb,baseline_rich jsonb,baseline_prefix text,strict_ids boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE i integer; left_item jsonb; right_item jsonb; total integer;
BEGIN
    IF jsonb_typeof(proposed) IS DISTINCT FROM 'array' OR jsonb_typeof(baseline) IS DISTINCT FROM 'array'
      OR jsonb_array_length(proposed)<>jsonb_array_length(baseline) THEN RETURN false; END IF;
    total:=jsonb_array_length(baseline); IF total=0 THEN RETURN true; END IF;
    FOR i IN 0..total-1 LOOP
        left_item:=proposed->i; right_item:=baseline->i;
        IF jsonb_typeof(left_item) IS DISTINCT FROM 'object' OR jsonb_typeof(right_item) IS DISTINCT FROM 'object'
          OR COALESCE(left_item->>'mod','') IS DISTINCT FROM COALESCE(right_item->>'mod','')
          OR COALESCE(left_item->>'name','') IS DISTINCT FROM COALESCE(right_item->>'name','')
          OR COALESCE(left_item->>'due','') IS DISTINCT FROM COALESCE(right_item->>'due','')
          OR ((strict_ids OR COALESCE(right_item->>'source_id','')<>'') AND left_item->>'source_id' IS DISTINCT FROM right_item->>'source_id')
          OR app_private.monthly_name_runs(left_item->>'mod',proposed_rich->'fields'->('biz.items.'||i||'.mod'))
            IS DISTINCT FROM app_private.monthly_name_runs(right_item->>'mod',baseline_rich->'fields'->(baseline_prefix||'.'||i||'.mod'))
          OR app_private.monthly_name_runs(left_item->>'name',proposed_rich->'fields'->('biz.items.'||i||'.name'))
            IS DISTINCT FROM app_private.monthly_name_runs(right_item->>'name',baseline_rich->'fields'->(baseline_prefix||'.'||i||'.name')) THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
END;
$$;

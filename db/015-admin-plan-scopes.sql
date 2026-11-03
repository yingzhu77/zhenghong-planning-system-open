-- Display grouping never changes project identity or access. Baseline scope is
-- explicit: legacy `line` values are preserved and are not guessed into modules.
BEGIN;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS display_group text;
ALTER TABLE public.milestones ADD COLUMN IF NOT EXISTS discipline text;
ALTER TABLE public.milestones ADD COLUMN IF NOT EXISTS biz_line text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.projects'::regclass AND conname='projects_display_group_valid') THEN
    ALTER TABLE public.projects ADD CONSTRAINT projects_display_group_valid
      CHECK (display_group IS NULL OR (length(display_group) BETWEEN 1 AND 100 AND display_group=btrim(display_group)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.milestones'::regclass AND conname='milestones_discipline_valid') THEN
    ALTER TABLE public.milestones ADD CONSTRAINT milestones_discipline_valid
      CHECK (discipline IS NULL OR discipline=ANY(ARRAY['开发报建','设计','工程','成本','招采','营销','商管运营','客服','财务']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.milestones'::regclass AND conname='milestones_biz_line_valid') THEN
    ALTER TABLE public.milestones ADD CONSTRAINT milestones_biz_line_valid
      CHECK (biz_line IS NULL OR biz_line=ANY(ARRAY['土建工程（东地块）','土建工程（西地块）','机电工程','精装工程',
        '幕墙设计+工程','景观设计+工程','开发','建筑结构设计','机电设计','精装设计','成本','招采']));
  END IF;
END $$;
COMMIT;

-- Planning system database schema. No business records or account credentials.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. 迁移替代：auth.uid()
-- ---------------------------------------------------------------------------
-- WorkBuddy 平台在每条请求前用 SET LOCAL 注入当前用户身份，auth.uid() 读取该值。
-- 自建部署时用同样的机制实现即可：应用在事务/会话内执行
--     SELECT set_config('request.jwt.claim.sub', '<当前用户ID>', true);
-- 自托管服务端验证会话后，在事务内设置 app.current_user_id。
-- 不读取旧平台 JWT GUC；客户端请求不能指定数据库身份。
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '');
$$;

-- ---------------------------------------------------------------------------
-- 1. projects  项目主表（住宅 + 商业）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.projects (
    id            text        NOT NULL,
    name          text        NOT NULL,
    sort_order    integer     NOT NULL DEFAULT 0,
    active        boolean     NOT NULL DEFAULT true,
    created_at    timestamp with time zone NOT NULL DEFAULT now(),
    camera_url    text,
    biz_meta      jsonb,
    project_type  text        DEFAULT 'res'::text,
    CONSTRAINT projects_pkey PRIMARY KEY (id)
);

-- ---------------------------------------------------------------------------
-- 2. profiles  业务用户档案（注意：这不是完整认证账号表，见 README 第 3 节）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
    user_id     text        NOT NULL DEFAULT auth.uid(),
    name        text        NOT NULL DEFAULT ''::text,
    role        text        NOT NULL DEFAULT 'pm'::text,
    project_id  text,
    status      text        NOT NULL DEFAULT 'pending'::text,
    created_at  timestamp with time zone NOT NULL DEFAULT now(),
    biz_line    text,
    discipline  text,
    CONSTRAINT profiles_pkey PRIMARY KEY (user_id),
    CONSTRAINT profiles_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);

-- ---------------------------------------------------------------------------
-- 3. project_members  项目成员关系（多对多）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_members (
    user_id          text        NOT NULL,
    project_id       text        NOT NULL,
    role_in_project  text        NOT NULL DEFAULT 'pm'::text,
    created_at       timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT project_members_pkey PRIMARY KEY (user_id, project_id),
    CONSTRAINT project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);

-- ---------------------------------------------------------------------------
-- 4. org  组织架构 / 专业条线字典
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.org (
    id          bigint  NOT NULL GENERATED ALWAYS AS IDENTITY,
    name        text    NOT NULL,
    dept        text,
    title       text,
    org_level   integer NOT NULL DEFAULT 3,
    sort_order  integer NOT NULL DEFAULT 0,
    CONSTRAINT org_pkey PRIMARY KEY (id),
    CONSTRAINT org_name_key UNIQUE (name)
);

-- ---------------------------------------------------------------------------
-- 5. plan_versions  计划版本（基线版本登记）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.plan_versions (
    id              bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
    project_id      text   NOT NULL,
    version_name    text   NOT NULL,
    effective_date  date,
    note            text,
    created_at      timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT plan_versions_pkey PRIMARY KEY (id),
    CONSTRAINT plan_versions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id),
    CONSTRAINT plan_versions_project_id_version_name_key UNIQUE (project_id, version_name)
);

-- ---------------------------------------------------------------------------
-- 6. plan_changes  计划变更记录（版本间节点日期差异）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.plan_changes (
    id          bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
    project_id  text   NOT NULL,
    from_version text,
    to_version  text,
    node_name   text   NOT NULL,
    old_date    date,
    new_date    date,
    delta_days  integer,
    reason      text,
    created_at  timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT plan_changes_pkey PRIMARY KEY (id),
    CONSTRAINT plan_changes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);

-- ---------------------------------------------------------------------------
-- 7. milestones  全景计划节点（核心业务表，18 列）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.milestones (
    id             bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
    project_id     text   NOT NULL,
    name           text   NOT NULL,
    plan_date      date,
    forecast_date  date,
    done           boolean NOT NULL DEFAULT false,
    sort_order     integer NOT NULL DEFAULT 0,
    updated_at     timestamp with time zone NOT NULL DEFAULT now(),
    key_name       text,
    level          text,
    is_key         boolean NOT NULL DEFAULT false,
    standard       text,
    owner_dept     text,
    owner_name     text,
    source         text   NOT NULL DEFAULT 'manual'::text,
    plan_version   text,
    note           text,
    line           text,
    rich_text      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rich_text) = 'object'),
    CONSTRAINT milestones_pkey PRIMARY KEY (id),
    CONSTRAINT milestones_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id),
    CONSTRAINT milestones_project_id_name_key UNIQUE (project_id, name)
);

-- ---------------------------------------------------------------------------
-- 8. reports  周度直报（PM 填报主表，31 列，含大量 jsonb 数组）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reports (
    id              bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
    project_id      text   NOT NULL,
    period          text   NOT NULL,
    author_id       text   NOT NULL DEFAULT auth.uid(),
    author_name     text,
    status          text   NOT NULL DEFAULT '正常'::text,
    change_text     text,
    dev_text        text,
    dev_level       text,
    dev_impact      text,
    coord           text,
    decision        text,
    next_items      jsonb  NOT NULL DEFAULT '[]'::jsonb,
    commit_items    jsonb  NOT NULL DEFAULT '[]'::jsonb,
    history         jsonb  NOT NULL DEFAULT '[]'::jsonb,
    locked          boolean NOT NULL DEFAULT true,
    submitted_at    timestamp with time zone NOT NULL DEFAULT now(),
    updated_at      timestamp with time zone NOT NULL DEFAULT now(),
    node_name       text,
    node_plan       date,
    node_forecast   date,
    impact          text DEFAULT '无明显影响'::text,
    node_items      jsonb  NOT NULL DEFAULT '[]'::jsonb,
    speed_items     jsonb  NOT NULL DEFAULT '[]'::jsonb,
    effect_items    jsonb  NOT NULL DEFAULT '[]'::jsonb,
    coord_items     jsonb  NOT NULL DEFAULT '[]'::jsonb,
    self_speed      text,
    self_effect     text,
    projection      text,
    line            text   NOT NULL DEFAULT '综合'::text,
    biz             jsonb,
    rich_text       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rich_text) = 'object'),
    CONSTRAINT reports_pkey PRIMARY KEY (id),
    CONSTRAINT reports_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id),
    CONSTRAINT reports_project_period_line_key UNIQUE (project_id, period, line)
);

-- ---------------------------------------------------------------------------
-- 9. leader_reviews  领导（总裁）评价
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.leader_reviews (
    id           uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id   text NOT NULL,
    period       text NOT NULL,
    kind         text NOT NULL DEFAULT 'ceo'::text,
    speed        text,
    effect       text,
    rating       text,
    note         text,
    author_name  text,
    author_role  text,
    created_at   timestamp with time zone NOT NULL DEFAULT now(),
    updated_at   timestamp with time zone NOT NULL DEFAULT now(),
    rich_text    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rich_text) = 'object'),
    CONSTRAINT leader_reviews_pkey PRIMARY KEY (id),
    CONSTRAINT leader_reviews_project_id_period_kind_key UNIQUE (project_id, period, kind)
);

-- ---------------------------------------------------------------------------
-- 10. leader_notes  领导批示 / 交办事项
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.leader_notes (
    id           uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id   text NOT NULL,
    period       text NOT NULL,
    kind         text NOT NULL DEFAULT 'ceo_brief'::text,
    what         text NOT NULL,
    due          text,
    author_name  text,
    created_at   timestamp with time zone NOT NULL DEFAULT now(),
    rich_text    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rich_text) = 'object'),
    CONSTRAINT leader_notes_pkey PRIMARY KEY (id)
);

-- ---------------------------------------------------------------------------
-- 11. project_master  项目主数据（键值对 jsonb 承载，业务侧自定义字段较多）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_master (
    project_id  text NOT NULL,
    fields      jsonb NOT NULL DEFAULT '{}'::jsonb,
    note        text,
    updated_by  text,
    updated_at  timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT project_master_pkey PRIMARY KEY (project_id)
);

-- ---------------------------------------------------------------------------
-- 12. project_phases  项目分期 / 业态指标
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_phases (
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id      text NOT NULL,
    name            text NOT NULL,
    area            text,
    gfa             text,
    units_total     integer,
    units_launched  integer,
    units_sold      integer,
    avg_price       text,
    value           text,
    plan_handover   text,
    sort_order      integer DEFAULT 0,
    updated_at      timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT project_phases_pkey PRIMARY KEY (id)
);

-- ---------------------------------------------------------------------------
-- 13. project_drawings  项目图纸 / 附件索引（原文件存于对象存储，见 README 第 4 节）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_drawings (
    id           uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id   text NOT NULL,
    kind         text NOT NULL DEFAULT '总图'::text,
    name         text NOT NULL,
    path         text,
    url          text,
    uploaded_by  text,
    sort_order   integer DEFAULT 0,
    created_at   timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT project_drawings_pkey PRIMARY KEY (id)
);

-- ---------------------------------------------------------------------------
-- 14. 索引
-- ---------------------------------------------------------------------------
-- 注：本库中 PK/UNIQUE 约束自带的索引已在上面约束定义中创建；
--     实测 pg_indexes 中除这些约束索引外，没有任何业务自建索引。
--     下面对高频查询列补充建议索引（★ 为迁移新增建议，线上原库没有）：
--
-- ★ CREATE INDEX ON public.milestones (project_id, sort_order);
-- ★ CREATE INDEX ON public.reports    (project_id, period);
-- ★ CREATE INDEX ON public.reports    (author_id);
-- ★ CREATE INDEX ON public.project_members (project_id);

COMMIT;

-- =============================================================================
-- 附录 A：线上实测的约束清单（原文，便于核对）
-- =============================================================================
-- leader_notes      PK (id)
-- leader_reviews    PK (id) ; UNIQUE (project_id, period, kind)
-- milestones        PK (id) ; FK project_id -> projects(id) ; UNIQUE (project_id, name)
-- org               PK (id) ; UNIQUE (name)
-- plan_changes      PK (id) ; FK project_id -> projects(id)
-- plan_versions     PK (id) ; FK project_id -> projects(id) ; UNIQUE (project_id, version_name)
-- profiles          PK (user_id) ; FK project_id -> projects(id)
-- project_drawings  PK (id)
-- project_master    PK (project_id)
-- project_members   PK (user_id, project_id) ; FK project_id -> projects(id)
-- project_phases    PK (id)
-- projects          PK (id)
-- reports           PK (id) ; FK project_id -> projects(id) ; UNIQUE (project_id, period, line)

-- =============================================================================
-- 附录 B：线上实测的序列状态（IDENTITY 列）
-- =============================================================================
--   milestones_id_seq     last_value = 184
--   org_id_seq            last_value = 14
--   plan_changes_id_seq   last_value = (从未使用 / null)
--   plan_versions_id_seq  last_value = 11
--   reports_id_seq        last_value = 12
-- 导入数据后请执行：SELECT setval('milestones_id_seq', (SELECT MAX(id) FROM milestones));
-- 其余同理。

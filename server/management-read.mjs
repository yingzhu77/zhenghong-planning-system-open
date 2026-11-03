import { getProfile, withIdentity } from './database.mjs';
import { HttpError } from './errors.mjs';

const forbidden = () => { throw new HttpError(403, '当前账号没有管理查看权限', 'management_read_forbidden'); };
const invalid = () => { throw new HttpError(400, '管理查看请求格式不正确', 'invalid_management_read'); };
const views = new Set(['projects', 'coordination', 'completions', 'meetings', 'archive']);

export function hasManagementRead(profile) {
  return profile?.status === 'approved' && (profile.role === 'viewer' || profile.role === 'pm' && profile.management_viewer === true);
}

// Internal server helper only. Neither the GUC name nor its value comes from a
// request, and SET LOCAL is automatically removed when withIdentity completes.
export function withManagementRead(pool, user, callback, { required = false } = {}) {
  return withIdentity(pool, user.id, async client => {
    const profile = await getProfile(client, user.id);
    if (hasManagementRead(profile)) await client.query("SELECT set_config('app.management_read','on',true)");
    else if (required) forbidden();
    return callback(client, profile);
  });
}

function readRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !['view', 'project_id', 'limit', 'cursor'].includes(key)) || !views.has(request.view)) invalid();
  const project = request.project_id ?? '';
  if (typeof project !== 'string' || project.length > 200 || /[\u0000-\u001f\u007f]/.test(project) || project !== project.trim()) invalid();
  const limit = request.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) invalid();
  let cursor;
  if (request.cursor !== undefined) {
    if (typeof request.cursor !== 'string' || request.cursor.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(request.cursor)) invalid();
    try { cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString()); } catch { invalid(); }
    if (!cursor || Object.keys(cursor).sort().join(',') !== 'created_at,key,project_id,view'
      || cursor.view !== request.view || cursor.project_id !== project || typeof cursor.created_at !== 'string'
      || !Number.isFinite(Date.parse(cursor.created_at)) || typeof cursor.key !== 'string' || !cursor.key
      || cursor.key.length > 500 || /[\u0000-\u001f\u007f]/.test(cursor.key)) invalid();
  }
  if (cursor && ['projects', 'archive'].includes(request.view)) invalid();
  return { view: request.view, project_id: project, limit, cursor };
}

const coordinationSql = `
  SELECT t.created_at,'independent:'||t.id::text AS sort_key,t.project_id,ARRAY[t.project_id] AS scope_project_ids,
    jsonb_build_object('id',t.id,'project_id',t.project_id,'source_project_id',t.project_id,
      'scope_project_ids',ARRAY[t.project_id],'source_type','independent_coordination',
      'source_key','coord:'||t.project_id||':'||t.id::text,'title','独立协调申请',
      'what',t.what,'rich_text',t.rich_text,'due',COALESCE(t.due::text,''),
      'author_name',t.author_name,'owner_name',t.owner_name,'created_at',t.created_at) AS data
  FROM public.coordination_tasks t
  UNION ALL
  SELECT r.submitted_at,'report:'||r.id::text||':'||part.kind||':'||part.ordinality::text,
    mapped.project_id,scope.ids,
    jsonb_build_object('id','report:'||r.id::text||':'||part.kind||':'||part.ordinality::text,
      'project_id',mapped.project_id,'source_project_id',r.project_id,'scope_project_ids',scope.ids,
      'source_type','report_'||part.kind,'source_key',CASE
        WHEN COALESCE(NULLIF(part.item->>'source_id',''),part.item->>'id','') ~ '^[A-Za-z0-9_-]{1,200}$'
        THEN 'coord:'||r.project_id||':'||r.id::text||':'||part.kind||':'||COALESCE(NULLIF(part.item->>'source_id',''),part.item->>'id') END,
      'report_id',r.id::text,'period',r.period,'title',CASE WHEN part.kind='coord' THEN '报告协调事项' ELSE '报告移交事项' END,
      'what',part.item->>'what','due',COALESCE(NULLIF(part.item->>'by',''),part.item->>'due',''),
      'owner_name',COALESCE(CASE WHEN part.kind='coord' THEN part.item->>'who' ELSE part.item->>'to' END,''),'author_name',r.author_name,
      'rich_text',CASE WHEN format.delta IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('v',1,'fields',jsonb_build_object('what',format.delta)) END,
      'mapping_status',CASE WHEN mapped.project_id IS NULL THEN 'unspecified' ELSE 'explicit' END,
      'created_at',r.submitted_at) AS data
  FROM public.reports r
  CROSS JOIN LATERAL (
    SELECT 'coord' AS kind,a.value AS item,a.ordinality FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.coord_items)='array' THEN r.coord_items ELSE '[]'::jsonb END) WITH ORDINALITY a
    UNION ALL
    SELECT 'handover',a.value,a.ordinality FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.biz->'handover')='array' THEN r.biz->'handover' ELSE '[]'::jsonb END) WITH ORDINALITY a
  ) part
  CROSS JOIN LATERAL (SELECT CASE WHEN cardinality(r.scope_project_ids)>0 THEN r.scope_project_ids ELSE ARRAY[r.project_id] END AS ids) scope
  CROSS JOIN LATERAL (SELECT CASE
    WHEN NULLIF(part.item->>'project_id','') IS NOT NULL THEN
      CASE WHEN part.item->>'project_id'=ANY(scope.ids) THEN part.item->>'project_id' END
    WHEN cardinality(scope.ids)=1 THEN scope.ids[1] END AS project_id) mapped
  CROSS JOIN LATERAL (SELECT COALESCE(
    r.rich_text->'fields'->((CASE WHEN part.kind='coord' THEN 'coord_items.' ELSE 'biz.handover.' END)||(part.ordinality-1)::text||'.what'),
    part.item->'rich_text'->'fields'->'what') AS delta) format
  WHERE app_private.report_week_start(r.period,r.submitted_at)=date_trunc('week',now() AT TIME ZONE 'Asia/Shanghai')::date
    AND jsonb_typeof(part.item)='object' AND btrim(COALESCE(part.item->>'what',''))<>''`;

const completionSql = `SELECT r.created_at,r.id::text AS sort_key,r.project_id,ARRAY[r.project_id] AS scope_project_ids,
  jsonb_build_object('id',r.id,'project_id',r.project_id,'source_key',r.source_key,'source_version',r.source_version,
    'kind',r.kind,'source_id',r.source_id,'report_id',r.report_id,'title',r.title,'what',r.what,'due',r.due,
    'source_snapshot',r.source_snapshot,'owner_id',r.owner_id,'owner_name',r.owner_name,
    'request_type',r.request_type,'requested_due',r.requested_due,'effective_due',r.effective_due,
    'completion_date',r.completion_date,'completion_note',r.completion_note,'status',r.status,
    'review_note',r.review_note,'rich_text',r.rich_text,'reviewer_name',r.reviewer_name,'reviewed_at',r.reviewed_at,
    'approved_at',r.approved_at,'history',r.history,'created_at',r.created_at,'updated_at',r.updated_at,
    'can_review',false,'snapshot_only',true,'data_basis','request_snapshot') AS data
  FROM public.completion_requests r`;

const meetingsSql = `SELECT t.created_at,t.id::text AS sort_key,t.project_id,ARRAY[t.project_id] AS scope_project_ids,
  jsonb_build_object('id',t.id,'project_id',t.project_id,'title',t.title,'what',t.what,'progress',t.progress,
    'due',t.due,'status',t.status,'rich_text',t.rich_text,'owner_name',t.owner_name,'meeting_kind',t.meeting_kind,
    'proposer_name',t.proposer_name,'proposer_role',t.proposer_role,'completed_at',t.completed_at,
    'created_at',t.created_at,'updated_at',t.updated_at,'history',t.history,'read_only',true) AS data
  FROM public.reporter_tasks t`;

async function archive(client, projectId) {
  if (!projectId) return { project_master: [], project_phases: [], project_drawings: [], milestones: [] };
  const master = (await client.query('SELECT project_id,fields,note,updated_at FROM public.project_master WHERE project_id=$1', [projectId])).rows;
  const phases = (await client.query(`SELECT id,project_id,name,area,gfa,units_total,units_launched,units_sold,
    avg_price,value,plan_handover,sort_order FROM public.project_phases WHERE project_id=$1 ORDER BY sort_order,id`, [projectId])).rows;
  const drawings = (await client.query(`SELECT id,project_id,kind,name,path,url,uploaded_by,sort_order,created_at
    FROM public.project_drawings WHERE project_id=$1 ORDER BY sort_order,id`, [projectId])).rows;
  const milestones = (await client.query(`SELECT id::text AS id,project_id,name,line,level,is_key,plan_date,
    forecast_date,done,note,rich_text,discipline,biz_line FROM public.milestones WHERE project_id=$1 ORDER BY sort_order,id`, [projectId])).rows;
  return { project_master: master, project_phases: phases, project_drawings: drawings, milestones };
}

export async function managementRead(pool, user, request = {}) {
  const filters = readRequest(request);
  return withManagementRead(pool, user, async client => {
    const projects = (await client.query(`SELECT id,name,COALESCE(project_type,'res') AS project_type,
      COALESCE(display_group,name) AS display_group FROM public.projects ORDER BY sort_order,id`)).rows;
    if (filters.project_id && !projects.some(project => project.id === filters.project_id)) forbidden();
    const result = { projects, project_id: filters.project_id || '', rows: [], has_more: false, next_cursor: null, read_only: true };
    if (filters.view === 'projects') return result;
    if (filters.view === 'archive') {
      result.project_id = filters.project_id || projects[0]?.id || '';
      result.archive = await archive(client, result.project_id);
      return result;
    }
    const source = { coordination: coordinationSql, completions: completionSql, meetings: meetingsSql }[filters.view];
    const values = [filters.project_id], conditions = ["($1::text='' OR project_id=$1 OR (project_id IS NULL AND $1=ANY(scope_project_ids)))"];
    if (filters.cursor) {
      values.push(filters.cursor.created_at, filters.cursor.key);
      conditions.push('(created_at,sort_key COLLATE "C")<($2::timestamptz,$3::text COLLATE "C")');
    }
    values.push(filters.limit + 1);
    const found = (await client.query(`WITH items AS (${source})
      SELECT data,created_at::text AS sort_at,sort_key FROM items WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC,sort_key COLLATE "C" DESC LIMIT $${values.length}`, values)).rows;
    result.has_more = found.length > filters.limit;
    const page = result.has_more ? found.slice(0, filters.limit) : found;
    const names = new Map(projects.map(project => [project.id, project.name]));
    result.rows = page.map(row => ({ ...row.data, project_name: names.get(row.data.project_id) || '未指定项目', read_only: true }));
    if (result.has_more) {
      const last = page.at(-1);
      result.next_cursor = Buffer.from(JSON.stringify({ view: filters.view, project_id: filters.project_id,
        created_at: last.sort_at, key: last.sort_key })).toString('base64url');
    }
    if (filters.view === 'coordination') result.report_period_basis = 'current_shanghai_week';
    if (filters.view === 'completions') result.data_basis = 'request_snapshot';
    return result;
  }, { required: true });
}

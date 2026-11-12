import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createWeeklyCollaboration} from '../server/weekly-collaboration.mjs';
import {getProfile,lockWeeklyCollaborationWrite,reportWeekStart,withIdentity} from '../server/database.mjs';
import {HttpError} from '../server/errors.mjs';

// The reviewed roster stays outside source control. This job uses the existing
// operator and project/profession checks, and never replaces a configured week.
export async function enableWeeklyCollaboration(pool, config, {
  today = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date())
} = {}) {
  if (config?.kind !== 'role-derived-weekly-collaboration-bindings'
    || typeof config.operator_id !== 'string' || !config.operator_id
    || !Array.isArray(config.bindings) || !config.bindings.length
    || reportWeekStart(config.first_week) !== config.first_week) throw new Error('Invalid reviewed collaboration bindings');
  const week = reportWeekStart(today), keys = new Set();
  if (!week || week < config.first_week) throw new Error('Current week precedes reviewed bindings');
  for (const binding of config.bindings) {
    if (![binding.project_id,binding.line,binding.submitter_id].every(value=>typeof value==='string' && value.trim()===value && value.length>0)
      || binding.line==='综合' || binding.report_scope_id != null && typeof binding.report_scope_id!=='string') throw new Error('Invalid project/profession binding');
    const key=JSON.stringify([binding.project_id,binding.line]);
    if(keys.has(key))throw new Error('Duplicate project/profession binding');
    keys.add(key);
  }
  const service=createWeeklyCollaboration(pool), user={id:config.operator_id}, records=[];
  for (const binding of config.bindings) {
    const scope={week,project_id:binding.project_id,line:binding.line,report_scope_id:binding.report_scope_id??null};
    try {
      const result=await withIdentity(pool,user.id,async client=>{
        if(!(await client.query('SELECT app_private.weekly_collaboration_operator() AS allowed')).rows[0].allowed)
          throw new HttpError(403,'维护主体不再具有协同设置权限');
        await lockWeeklyCollaborationWrite(client,scope.project_id,scope.line,week);
        const values=[scope.project_id,scope.line,week];
        const before=(await client.query('SELECT submitter_id FROM app_private.weekly_collaboration_drafts WHERE project_id=$1 AND line=$2 AND week=$3::date',values)).rows[0];
        if(before)return 'preserved';
        if(!(await client.query('SELECT app_private.weekly_collaboration_eligible($1,$2,$3,$4) AS allowed',
          [binding.submitter_id,scope.project_id,scope.line,scope.report_scope_id])).rows[0].allowed)
          throw new HttpError(403,'负责人当前没有该项目专业权限，未自动替换人员');
        if((await client.query(`SELECT 1 FROM public.reports WHERE project_id=$1 AND line=$2
          AND app_private.weekly_collaboration_existing_report_week(period,submitted_at)=$3::date AND author_id=$4`,[...values,binding.submitter_id])).rows.length)
          throw new HttpError(409,'负责人本周已有个人周报，保留原记录');
        await client.query(`INSERT INTO app_private.weekly_collaboration_drafts(project_id,line,week,report_scope_id,submitter_id,configured_by)
          VALUES($1,$2,$3::date,$4,$5,$6)`,[...values,scope.report_scope_id,binding.submitter_id,user.id]);
        const profile=await getProfile(client,user.id);
        await client.query(`INSERT INTO app_private.weekly_collaboration_operations
          (project_id,line,week,operation_id,actor_id,actor_name,kind,revision,payload_hash)
          VALUES($1,$2,$3::date,$4,$5,$6,'designate',1,$7)`,[...values,randomUUID(),user.id,profile.name,
          createHash('sha256').update(JSON.stringify([binding.submitter_id])).digest('hex')]);
        return 'enabled';
      });
      const after=await service.settings(user,scope);
      records.push({...scope,result,submitter_id:after.submitter_id,status:after.status});
    } catch (error) {
      // An unavailable owner or existing personal report must remain visible as
      // a conflict, not silently choose someone else or rewrite their report.
      records.push({...scope,result:'blocked',status:error.status??500,code:error.code??'weekly_enable_failed',message:error.message});
    }
  }
  return {week,timezone:'Asia/Shanghai',enabled:records.filter(row=>row.result==='enabled').length,
    preserved:records.filter(row=>row.result==='preserved').length,blocked:records.filter(row=>row.result==='blocked').length,records};
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  let input='';for await(const part of process.stdin)input+=part;
  const config=JSON.parse(input);input='';
  const {default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
  try {
    const result=await enableWeeklyCollaboration(pool,config);
    process.stdout.write(JSON.stringify(result)+'\n');
    if(result.blocked)process.exitCode=2;
  } finally {await pool.end();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{
  console.error(JSON.stringify({phase:'weekly_enable',code:error.code??error.name,message:error.message}));process.exitCode=1;
});

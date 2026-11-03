import { HttpError } from './errors.mjs';

const COMMON_BUSINESS_MODULES = Object.freeze([
  '土建工程（东地块）', '土建工程（西地块）', '机电工程', '精装工程',
  '幕墙设计+工程', '景观设计+工程', '开发', '建筑结构设计', '机电设计', '精装设计', '成本', '招采'
]);
export const BUSINESS_MODULES = Object.freeze([...COMMON_BUSINESS_MODULES, '设计部']);
// Vocabulary is shared, but the additional department exists only in 弘坊.
// An absent project keeps legacy callers within the original twelve modules.
export function businessModulesForProject(projectId) {
  return projectId === 'hf' ? BUSINESS_MODULES : COMMON_BUSINESS_MODULES;
}

// This is an explicit account grant. Empty, unknown and whitespace-padded
// values never become a wildcard, and '*' is never a stored report module.
export function hasAllBusinessModules(profile) {
  return profile?.biz_line === '*';
}
export function canUseBusinessModule(profile, line, projectId) {
  return businessModulesForProject(projectId).includes(line) && (hasAllBusinessModules(profile) || profile?.biz_line === line ||
    projectId==='hf'&&line==='设计部'&&Array.isArray(profile?.business_module_grants)&&profile.business_module_grants.some(grant=>grant.project_id===projectId&&grant.line===line));
}
export function businessModulesForProfile(profile,projectId){return businessModulesForProject(projectId).filter(line=>canUseBusinessModule(profile,line,projectId));}

// Project-scoped RLS also lets a legitimate source reviewer load the target's
// extra module. Never make the primary field or an inferred wildcard wider.
export async function withBusinessModuleGrants(client,profiles,projectId){
  if(projectId!=='hf'||!profiles.length||profiles.every(profile=>!profile||Array.isArray(profile.business_module_grants)))return profiles;
  const ids=[...new Set(profiles.filter(Boolean).map(profile=>profile.user_id))];
  if(!ids.length)return profiles;
  const grants=(await client.query("SELECT user_id,project_id,line FROM public.commercial_module_grants WHERE project_id='hf' AND line='设计部' AND user_id=ANY($1::text[])",[ids])).rows;
  return profiles.map(profile=>profile?{...profile,business_module_grants:grants.filter(grant=>grant.user_id===profile.user_id).map(({project_id,line})=>({project_id,line}))}:profile);
}
export function resolveWritableBusinessLine(profile, requestedLine, projectId) {
  const available=businessModulesForProfile(profile,projectId);
  if (!hasAllBusinessModules(profile) && !available.length) {
    throw new HttpError(400, '请先由运营管理员指定商业模块', 'commercial_module_unassigned');
  }
  const line = requestedLine === undefined && !hasAllBusinessModules(profile) ? (available.includes(profile.biz_line)?profile.biz_line:available.length===1?available[0]:undefined) : requestedLine;
  if (line === undefined) throw new HttpError(400, '请选择本次填报的商业模块', 'commercial_module_required');
  if (!canUseBusinessModule(profile, line, projectId)) throw new HttpError(403, '只能填报本人获授权的实际商业模块', 'commercial_module_forbidden');
  return line;
}

import { HttpError } from './errors.mjs';

export const RESIDENTIAL_DISCIPLINES = Object.freeze([
  '开发报建', '设计', '工程', '成本', '招采', '营销', '商管运营', '客服', '财务'
]);
const SHENZHEN_DISCIPLINES = Object.freeze([...RESIDENTIAL_DISCIPLINES, '良安田项目']);

// A project catalog does not grant a user write access. Until an owner is
// explicitly authorized, the extra profession remains a pending import row.
export function residentialDisciplinesForProject(projectId) {
  return ['szzz', 'szgy'].includes(projectId) ? SHENZHEN_DISCIPLINES : RESIDENTIAL_DISCIPLINES;
}

// 综合 remains a legacy/report-scope identity. New independent residential
// reports use the caller's assigned discipline; project RLS is checked separately.
export function canUseResidentialLine(profile, line) {
  return line === '综合' || RESIDENTIAL_DISCIPLINES.includes(line) && profile?.discipline === line;
}
export function resolveWritableResidentialLine(profile, requested) {
  const line = requested ?? (RESIDENTIAL_DISCIPLINES.includes(profile?.discipline) ? profile.discipline : '综合');
  if (!canUseResidentialLine(profile, line)) throw new HttpError(403, '只能填报本人获授权的住宅专业', 'residential_discipline_forbidden');
  return line;
}

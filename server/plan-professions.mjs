import { BUSINESS_MODULES } from './commercial-modules.mjs';
import { residentialDisciplinesForProject } from './report-lines.mjs';

const aliases = new Map([
  ['开发', '开发报建'], ['开发报批', '开发报建'], ['报建', '开发报建'],
  ['采购', '招采'], ['招标采购', '招采'], ['良安田', '良安田项目']
]);
const businessAliases = new Map([
  ['土建-东地块', '土建工程（东地块）'], ['土建东地块', '土建工程（东地块）'],
  ['土建-西地块', '土建工程（西地块）'], ['土建西地块', '土建工程（西地块）'],
  ['东地块土建', '土建工程（东地块）'], ['西地块土建', '土建工程（西地块）'],
  ['机电施工', '机电工程'], ['精装施工', '精装工程'], ['幕墙施工', '幕墙设计+工程'],
  ['景观', '景观设计+工程'], ['景观工程', '景观设计+工程'], ['景观设计', '景观设计+工程'],
  ['幕墙', '幕墙设计+工程'], ['幕墙工程', '幕墙设计+工程'], ['幕墙设计', '幕墙设计+工程'],
  ['机电', '机电工程'], ['精装', '精装工程'], ['开发报建', '开发'], ['开发报批', '开发'],
  ['采购', '招采'], ['招标采购', '招采']
]);
const clean = value => String(value ?? '').replace(/[\s\u3000]/g, '')
  .replace(/[—–－_]/g, '-')
  .replace(/[（(]\d+[）)]$/, '').replace(/(?:专业|月度工作计划|月工作计划|工作计划|月度计划|计划会)$/g, '');

// Only explicit, maintained synonyms are automatic. Similar words and a
// reporter's name never establish a professional/account assignment.
export function planProfession(value, type, projectId) {
  const hint = clean(value), choices = type === 'com' ? BUSINESS_MODULES : residentialDisciplinesForProject(projectId);
  const exact = choices.find(line => clean(line) === hint);
  if (exact) return { line: exact, basis: 'exact' };
  const line = (type === 'com' ? businessAliases : aliases).get(hint);
  return line && choices.includes(line) ? { line, basis: 'alias' } : null;
}

export function workbookProfessionHint(sheet, module) {
  const label = String(sheet ?? '').trim();
  // A named professional worksheet owns its work categories (e.g. 专项计划,
  // 一标段). Preserve that category as mod, not as the account profession.
  if (planProfession(label, 'res') || planProfession(label, 'com')) return label;
  return String(module ?? '').trim() || label;
}

// Unregistered design summaries are not professional grants. Registered
// worksheet professions retain their own scope and never get split by content.
export function suggestPlanProfession(row, type) {
  if (planProfession(row.source?.sheet || row.line_hint,type)) return null;
  if (type !== 'com' || !/^(?:设计部|设计管理部|设计管理|设计)$/.test(clean(row.source?.sheet || row.line_hint))) return null;
  const content=String(row.name || '')+'\n'+String(row.standard || ''),candidates=[];
  if (/精装|室内.*(?:图|样板)|公区.*(?:图纸|施工图)/.test(content)) candidates.push('精装设计');
  if (/景观|园林/.test(content)) candidates.push('景观设计+工程');
  if (/机电|风系统/.test(content)) candidates.push('机电设计');
  if (/建筑|结构/.test(content)) candidates.push('建筑结构设计');
  const distinct=[...new Set(candidates)];if(distinct.length!==1)return null;
  return {line:distinct[0],reason:'根据设计汇总表该行的工作内容建议'+distinct[0]+'，请核对后集中确认'};
}

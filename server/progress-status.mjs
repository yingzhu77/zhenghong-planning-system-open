const dateText = String.raw`(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|(?:\d{4}年)?\d{1,2}月\d{1,2}[日号])`;
const outcome = '完成|完工|办结|移交|验收通过|交圈|封顶|定标';
const endState = new RegExp('^(?:已|已经)?(?:(?:于)?(' + dateText + '))?(?:已)?(?:全部|全面|整体|均|按要求)?(?:已)?(' + outcome + ')$');
const datedOutcome = new RegExp('^(?:全部|全面|整体)?(' + outcome + ')(?:日期|时间)?(?:为|于|在|[:：])?(' + dateText + ')$');
const namedDate = new RegExp('^(?:实际)?(?:完成|完工|办结|移交|验收)(?:日期|时间)(?:为|是|[:：])?(' + dateText + ')$');
const wholeSubject = /^(?:本项(?:工作|任务|计划)?|本事项|本节点|该事项|该项(?:工作|任务|计划)?|该节点|此项(?:工作|任务)?|本期任务)/;
const remaining = /(?:未|还没|没有|不具备)(?:全部|完全|能|达到)?(?:完(?:成|工)|办结|移交|交付|交圈|通过|验收|封顶|定标|签|提交|安装|施工|复核|收尾)|(?:部分|基本|接近|临近|预计|计划(?:于|在|下周|本月底|完成)|拟于|拟在|争取|力争|将于|待|还需|仍需|剩余|尚需|尚差|暂缓|暂停|未开始|无进展|施工中|推进中|进行中|办理中|正在|已启动|已进场)/;
const planned = /(?:预计|拟于|拟在|将于|争取|力争|之前|日前|月底前|前完成)/;

function calendarDate(year, month, day) {
  const value = [year, String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
  const date = new Date(value + 'T00:00:00Z');
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number(year) > 0
    && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
}

export function validProgressDate(value, latest) {
  return typeof value === 'string' && value === calendarDate(...value.split('-')) && Boolean(value) && value <= latest;
}

export function progressDateStatus(completedOn, effectiveDue) {
  return !validProgressDate(effectiveDue, '9999-12-31') ? 'completed_without_deadline' : completedOn <= effectiveDue ? 'on_time' : 'late';
}

function explicitDate(text, reportedOn) {
  const parts = text?.match(/\d+/g) ?? [];
  if (parts.length === 3) {
    const date = calendarDate(...parts);
    return date && date <= reportedOn ? date : '';
  }
  if (parts.length !== 2) return '';
  const year = Number(reportedOn.slice(0, 4));
  const date = [year, year - 1].map(candidate => calendarDate(candidate, ...parts)).find(value => value && value <= reportedOn);
  // Month/day shorthand is usable for recent work, including the year boundary.
  return date && Date.parse(reportedOn) - Date.parse(date) <= 62 * 86400000 ? date : '';
}

function compact(value) { return String(value ?? '').normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]+/g, ''); }

export function recognizeProgress({ subject, progress, blocker, effectiveDue, reportedOn }) {
  const feedback = compact(progress);
  if (!feedback) return { status: 'not_reported' };
  const clauses = String(progress).normalize('NFKC').split(/[\n。;；,，!！]+/).map(compact).filter(Boolean);
  const containsRemaining = (text) => remaining.test(text) || [...text.matchAll(/(\d+(?:\.\d+)?)%/g)].some(match => Number(match[1]) < 100);
  if (containsRemaining(feedback) || containsRemaining(compact(blocker))) return { status: 'incomplete' };
  const title = compact(subject), dates = new Set();
  let completed = false, invalidDate = false;
  for (const clause of clauses) {
    let claim = clause.replace(wholeSubject, '');
    if (title && claim.startsWith(title)) claim = claim.slice(title.length);
    const end = endState.exec(claim), dated = datedOutcome.exec(claim), labeled = namedDate.exec(claim);
    // A target or a month/day in a subtask sentence is not a completion claim.
    if (!planned.test(clause) && (end || dated || /^(?:已完成)?100%$/.test(claim))) completed = true;
    const text = end?.[1] || dated?.[2] || labeled?.[1];
    if (text) {
      const date = explicitDate(text, reportedOn);
      if (date) dates.add(date); else invalidDate = true;
    }
  }
  if (!completed) return { status: 'unclear' };
  if (invalidDate || dates.size > 1) return { status: 'unclear' };
  if (!dates.size) return { status: 'awaiting_date' };
  const [completedOn] = dates;
  return { status: progressDateStatus(completedOn, effectiveDue), completedOn };
}

const sourceId = value => typeof value === 'string' && /^[\w-]{1,200}$/.test(value);
const rows = value => Array.isArray(value) ? value.filter(row => row && typeof row === 'object') : [];

export function reportProgressEntries(report) {
  const {biz, project_id:projectId, author_id:authorId, id:reportId} = report;
  const entries = [];
  for (const item of rows(biz?.items)) {
    if (!sourceId(item.source_id) || !item.name?.trim?.()) continue;
    const planId = Array.isArray(biz.monthly_plan_ids) && biz.monthly_plan_ids.includes(item.monthly_plan_id)
      ? item.monthly_plan_id : biz.monthly_plan_id;
    const key = planId ? `monthly:${projectId}:${planId}:${item.source_id}` : `plan:${projectId}:${reportId}:items:${item.source_id}`;
    entries.push({key, ownerId:authorId, subject:item.name, progress:item.prog, blocker:item.blocker, effectiveDue:item.due});
  }
  for (const node of rows(biz?.nodes)) {
    if (!node.name?.trim?.()) continue;
    const key = /^[1-9]\d*$/.test(String(node.milestone_id))
      ? `milestone:${node.project_id || projectId}:${node.milestone_id}`
      : sourceId(node.source_id) ? `plan:${projectId}:${reportId}:nodes:${node.source_id}` : '';
    if (key) entries.push({key, ownerId:authorId, subject:node.name, progress:node.prog, blocker:node.blocker, effectiveDue:node.forecast || node.plan});
  }
  for (const row of rows(biz?.followups)) {
    if (typeof row.source_key === 'string' && (/^(?:coord|meeting|leader):/).test(row.source_key))
      entries.push({key:row.source_key, ownerId:row.owner_id || authorId, subject:row.what, progress:row.progress, effectiveDue:row.effective_due || row.due});
  }
  return entries.filter(entry => entry.ownerId && typeof entry.progress === 'string');
}

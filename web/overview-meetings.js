/* The overview and the independent meeting page share reporter_tasks records. */
(function (global) {
  'use strict';
  var cfg, S, uid, session, epoch = 0, serial = 0;
  var people = Object.create(null), loading = Object.create(null), errors = Object.create(null), drafts = Object.create(null), scopes = [];
  function configure(options) {
    if (uid !== options.S.uid || session !== options.S.session) {
      uid = options.S.uid; session = options.S.session; epoch++;
      people = Object.create(null); loading = Object.create(null); errors = Object.create(null); drafts = Object.create(null); scopes = []; serial = 0;
    }
    cfg = options; S = options.S;
  }
  function esc(value) { return cfg.esc(value == null ? '' : value); }
  function operator() { return S && S.profile && S.profile.role === 'ops'; }
  function allowed(pid) { return S && S.profile && ['ops', 'president', 'pzo'].indexOf(S.profile.role) >= 0 && (S.projects || []).some(function (p) { return p.id === pid; }); }
  function canMaintain(task) { return operator() || task && task.meeting_kind === 'requirement' && task.proposer_id === S.uid; }
  function presentationAction(task) { return cfg.presentationAction ? cfg.presentationAction(task) : ''; }
  function roleText(role) { return role === 'president' ? '总裁' : role === 'pzo' ? '项目总' : '未记录提出身份'; }
  function ownerCandidates(pid) { return (people[pid] || []).filter(function (person) { return person.role === 'pm'; }); }
  function proposerText(task) { return esc(roleText(task.proposer_role) + (task.proposer_name ? ' · ' + task.proposer_name : '')); }
  function copy(row) { return cfg.richCopy ? cfg.richCopy(row, Object.assign({}, row)) : Object.assign({}, row); }
  function scopeFor(pid, line, commercial, knownLines) {
    var key = JSON.stringify([pid, line == null ? null : line, !!commercial]), found = -1;
    scopes.some(function (scope, index) { if (scope.key === key) { found = index; return true; } return false; });
    if (found < 0) { found = scopes.length; scopes.push({ key: key, pid: pid, line: line, commercial: !!commercial }); }
    scopes[found].knownLines = knownLines || [];
    return found;
  }
  async function loadPeople(pid) {
    if (!allowed(pid) || loading[pid]) return;
    var active = cfg, generation = epoch;
    loading[pid] = true; delete errors[pid];
    try {
      var result = await active.loadPeople(pid);
      if (generation !== epoch) return;
      if (!result || result.error || !Array.isArray(result.data)) throw new Error(result && result.error && result.error.message || '承办人读取失败，请重试');
      people[pid] = result.data;
    } catch (error) { if (generation === epoch) errors[pid] = error.message || '承办人读取失败，请重试'; }
    finally { if (generation === epoch) { loading[pid] = false; active.render(); } }
  }
  function personLine(person, scope) { return person ? (scope.commercial ? person.biz_line || '' : person.discipline || '综合 / 未指定专业') : ''; }
  function inScope(task, scope) {
    if (task.project_id !== scope.pid) return false;
    var owner = (people[scope.pid] || []).filter(function (person) { return person.user_id === task.owner_id; })[0];
    var line = personLine(owner, scope);
    return scope.line == null ? !line || scope.knownLines.indexOf(line) < 0 : line === scope.line;
  }
  function dateFor(task) {
    return global.CompletionReview && global.CompletionReview.effectiveDue
      ? global.CompletionReview.effectiveDue('meeting:' + task.project_id + ':' + task.id, task.due, task.owner_id) : task.due;
  }
  function cell(label, value) { return '<td data-label="' + esc(label) + '">' + value + '</td>'; }
  function rich(row, field, fallback) { return cfg.richItem ? cfg.richItem(row, field, fallback) : esc(row[field] || fallback || ''); }
  function residentialScope(projects) {
    var ids = (projects || []).filter(function (project) { return project && project.project_type !== 'com' && allowed(project.id); }).map(function (project) { return project.id; });
    var key = JSON.stringify(['residential', ids]), index = -1;
    scopes.some(function (scope, i) { if (scope.key === key) { index = i; return true; } return false; });
    if (index < 0) { index = scopes.length; scopes.push({key:key,residential:true,projectIds:ids}); }
    return index;
  }
  function arrangementScopeAllowed(scope) { return scope && scope.residential && scope.projectIds.length && scope.projectIds.every(allowed); }
  function projectName(pid) { var project = (S.projects || []).filter(function (row) { return row.id === pid; })[0]; return project && project.name || pid; }
  function disciplines(pid) {
    var result = (cfg.disciplines || []).filter(function (line) { return typeof line === 'string' && line.trim(); }).slice();
    ownerCandidates(pid).forEach(function (person) { var line = String(person.discipline || '').trim(); if (line && result.indexOf(line) < 0) result.push(line); });
    return result.sort(function (a,b) { return a.localeCompare(b,'zh-CN'); });
  }
  function arrangementDraftRow(draft, number) {
    var scope = scopes[draft.scope], disabled = draft.busy ? ' disabled' : '', list = disciplines(draft.project_id);
    var candidates = ownerCandidates(draft.project_id).filter(function (person) { return draft.discipline ? person.discipline === draft.discipline : !!draft.id; });
    var proposers = (people[draft.project_id] || []).filter(function (person) { return ['president','pzo'].indexOf(person.role) >= 0; });
    var project = draft.id || scope.projectIds.length === 1 ? esc(projectName(draft.project_id)) : '<select id="overview_meeting_project_' + number + '" aria-label="工作安排实际项目" onchange="OverviewMeetings.selectArrangement(' + number + ',\'project_id\',this.value)"' + disabled + '><option value="">选择实际项目</option>'
      + scope.projectIds.map(function (pid) { return '<option value="' + esc(pid) + '"' + (pid === draft.project_id ? ' selected' : '') + '>' + esc(projectName(pid)) + '</option>'; }).join('') + '</select>';
    var proposer = !operator() ? esc(roleText(S.profile.role) + ' · ' + (S.profile.name || '本人')) : '<select id="overview_meeting_proposer_' + number + '" aria-label="工作安排提出领导" onchange="OverviewMeetings.change(' + number + ',\'proposer_id\',this.value)"' + disabled + '><option value="">选择实际提出领导</option>'
      + (draft.proposer_id && !proposers.some(function (person) { return person.user_id === draft.proposer_id; }) ? '<option value="' + esc(draft.proposer_id) + '" selected>' + esc(draft.proposer_name || '原提出领导（名单待核对）') + '</option>' : '')
      + proposers.map(function (person) { return '<option value="' + esc(person.user_id) + '"' + (person.user_id === draft.proposer_id ? ' selected' : '') + '>' + esc(roleText(person.role) + ' · ' + person.name) + '</option>'; }).join('') + '</select>';
    return '<tr class="overview-meeting-draft" data-meeting-draft="' + number + '">'
      + cell('实际项目', project) + cell('提出领导', proposer)
      + cell('具体专业', '<select id="overview_meeting_discipline_' + number + '" aria-label="工作安排专业" onchange="OverviewMeetings.selectArrangement(' + number + ',\'discipline\',this.value)"' + disabled + (!draft.project_id ? ' disabled' : '') + '><option value="">选择具体专业</option>'
        + list.map(function (line) { return '<option value="' + esc(line) + '"' + (line === draft.discipline ? ' selected' : '') + '>' + esc(line) + '</option>'; }).join('') + '</select>'
        + (draft.project_id && people[draft.project_id] && !list.length ? '<p class="muted">本项目暂无已明确专业的有效责任人，请联系运营核对原人员及项目授权。</p>' : ''))
      + cell('责任人', '<select id="overview_meeting_owner_' + number + '" aria-label="工作安排责任人" onchange="OverviewMeetings.change(' + number + ',\'owner_id\',this.value)"' + disabled + (!draft.discipline && !draft.id ? ' disabled' : '') + '><option value="">选择一名责任人</option>'
        + (draft.id && draft.owner_id && !candidates.some(function (person) { return person.user_id === draft.owner_id; }) ? '<option value="' + esc(draft.owner_id) + '" selected>' + esc(draft.owner_name || '原责任人（需核对）') + '</option>' : '')
        + candidates.map(function (person) { return '<option value="' + esc(person.user_id) + '"' + (person.user_id === draft.owner_id ? ' selected' : '') + '>' + esc(person.name) + '</option>'; }).join('') + '</select>'
        + (draft.discipline && people[draft.project_id] && !candidates.length ? '<p class="muted">该专业暂无本项目有效责任人，请联系运营核对原人员及项目授权。</p>' : ''))
      + cell('安排内容', '<textarea id="overview_meeting_what_' + number + '" data-rich rows="3" maxlength="10000" aria-label="领导工作安排内容" oninput="OverviewMeetings.change(' + number + ',\'what\',this.value)"' + disabled + '>' + esc(draft.what) + '</textarea>')
      + cell('完成时间', '<input id="overview_meeting_due_' + number + '" type="date" aria-label="工作安排完成时间" value="' + esc(draft.due || '') + '" onchange="OverviewMeetings.change(' + number + ',\'due\',this.value)"' + (!draft.id ? ' required' : '') + disabled + '>')
      + cell('操作', '<div class="overview-meeting-actions"><button type="button" class="btn primary sm" onclick="OverviewMeetings.save(' + number + ')"' + disabled + '>' + (draft.busy ? '保存中…' : '保存安排') + '</button><button type="button" class="btn ghost sm" onclick="OverviewMeetings.cancel(' + number + ')"' + disabled + '>取消</button></div>'
        + (draft.error ? '<p class="overview-meeting-error" role="alert">' + esc(draft.error) + '</p>' : '')) + '</tr>';
  }
  function residentialHtml(projects, line) {
    var index = residentialScope(projects), scope = scopes[index];
    scope.filterLine = line || '';
    if (!arrangementScopeAllowed(scope)) return '';
    scope.projectIds.forEach(function (pid) { if (!people[pid] && !loading[pid] && !errors[pid]) Promise.resolve().then(function () { return loadPeople(pid); }); });
    var rows = [];
    (S.reporterTasks || []).forEach(function (task, taskIndex) {
      if (task.meeting_kind !== 'requirement' || scope.projectIds.indexOf(task.project_id) < 0) return;
      var owner = ownerCandidates(task.project_id).filter(function (person) { return person.user_id === task.owner_id; })[0];
      if(line && (!people[task.project_id] || (owner && owner.discipline || '__unassigned__')!==line))return;
      var draft = Object.keys(drafts).filter(function (number) { return drafts[number].id === task.id; })[0];
      if (draft) { if (drafts[draft].scope === index) rows.push(arrangementDraftRow(drafts[draft],draft)); return; }
      rows.push('<tr data-arrangement-id="' + esc(task.id) + '">' + cell('实际项目', esc(projectName(task.project_id))) + cell('提出领导', proposerText(task))
        + cell('具体专业', esc(owner && owner.discipline || '未明确专业')) + cell('责任人', esc(task.owner_name || '未记录'))
        + cell('安排内容', '<div>' + rich(task,'what') + '</div><div class="overview-meta">进展：' + rich(task,'progress','尚未反馈') + '</div>')
        + cell('完成时间', esc(dateFor(task) || '未设置（原记录）')) + cell('操作', (canMaintain(task) ? '<button type="button" class="btn ghost sm" onclick="OverviewMeetings.editResidential(' + index + ',' + taskIndex + ')"' + (!people[task.project_id] ? ' disabled' : '') + '>维护</button>' : '只读')+presentationAction(task)) + '</tr>');
    });
    Object.keys(drafts).forEach(function (number) { var draft = drafts[number]; if (draft.scope === index && draft.arrangement && !draft.id) rows.push(arrangementDraftRow(draft,number)); });
    return '<section class="overview-meetings overview-leader-arrangements" data-leader-arrangement-projects="' + esc(scope.projectIds.join(',')) + '"><div class="overview-meeting-heading"><h3>领导工作安排</h3><button type="button" class="btn sm" onclick="OverviewMeetings.add(' + index + ')">新增工作安排</button></div>'
      + '<p class="muted">审阅后选择实际项目、具体专业和一名责任人，填写工作安排及完成时间；承办人沿原工作台反馈和申报。</p>'
      + scope.projectIds.map(function (pid) { return errors[pid] ? '<p class="overview-meeting-error" role="alert">' + esc(projectName(pid) + '：' + errors[pid]) + ' <button type="button" class="btn sm" onclick="OverviewMeetings.retryProject(\'' + esc(pid) + '\')">重读项目人员</button></p>' : !people[pid] ? '<p class="muted" role="status">正在读取' + esc(projectName(pid)) + '人员…</p>' : ''; }).join('')
      + '<div class="overview-table-scroll"><table class="overview-data-table overview-meeting-table" data-section="leader-arrangements"><thead><tr>'
      + ['实际项目','提出领导','具体专业','责任人','安排内容','完成时间','操作'].map(function (title) { return '<th scope="col">' + title + '</th>'; }).join('') + '</tr></thead><tbody>'
      + (rows.length ? rows.join('') : '<tr><td colspan="7" class="overview-cell-empty">暂无领导工作安排。</td></tr>') + '</tbody></table></div></section>';
  }
  function draftRow(draft, number) {
    var candidates = ownerCandidates(draft.project_id), disabled = draft.busy ? ' disabled' : '';
    var proposers = (people[draft.project_id] || []).filter(function (person) { return person.role === 'president' || person.role === 'pzo'; });
    return '<tr class="overview-meeting-draft" data-meeting-draft="' + number + '">'
      + cell('序号', draft.id ? '修改' : '新增')
      + cell('提出人', draft.leaderNote ? esc((draft.kind === 'pzo_note' ? '项目总安排' : '总裁交代') + ' · 原领导记录') : operator() ? '<select id="overview_meeting_proposer_' + number + '" aria-label="会议要求提出人" onchange="OverviewMeetings.change(' + number + ',\'proposer_id\',this.value)"' + disabled + '><option value="">选择总裁／项目总</option>'
        + proposers.map(function (person) { return '<option value="' + esc(person.user_id) + '"' + (person.user_id === draft.proposer_id ? ' selected' : '') + '>' + esc(roleText(person.role) + ' · ' + person.name) + '</option>'; }).join('') + '</select>' : esc(roleText(S.profile.role) + ' · ' + (S.profile.name || '本人')))
      + cell('责任人', '<select id="overview_meeting_owner_' + number + '" aria-label="会议事项责任人" onchange="OverviewMeetings.change(' + number + ',\'owner_id\',this.value)"' + disabled + '><option value="">选择责任人</option>'
        + (draft.owner_id && !candidates.some(function (person) { return person.user_id === draft.owner_id; }) ? '<option value="' + esc(draft.owner_id) + '" selected>' + esc(draft.owner_name || '原承办人（需重新核对）') + '</option>' : '')
        + candidates.map(function (person) { return '<option value="' + esc(person.user_id) + '"' + (person.user_id === draft.owner_id ? ' selected' : '') + '>' + esc(person.name + (person.biz_line || person.discipline ? '（' + (person.biz_line || person.discipline) + '）' : '')) + '</option>'; }).join('') + '</select>')
      + cell('具体事项', draft.leaderNote ? rich(draft, 'what') + '<div class="muted">原记录及审批编号保留，仅补充责任人</div>' : '<textarea id="overview_meeting_what_' + number + '" data-rich rows="3" maxlength="10000" aria-label="会议要求具体事项" oninput="OverviewMeetings.change(' + number + ',\'what\',this.value)"' + disabled + '>' + esc(draft.what) + '</textarea>')
      + cell('完成时间', draft.leaderNote ? esc(draft.due || '未设置') : '<input id="overview_meeting_due_' + number + '" type="date" aria-label="会议事项完成时间" value="' + esc(draft.due) + '" onchange="OverviewMeetings.change(' + number + ',\'due\',this.value)"' + disabled + '>')
      + cell('操作', '<div class="overview-meeting-actions"><button type="button" class="btn primary sm" onclick="OverviewMeetings.save(' + number + ')"' + disabled + '>' + (draft.busy ? '保存中…' : '保存') + '</button><button type="button" class="btn ghost sm" onclick="OverviewMeetings.cancel(' + number + ')"' + disabled + '>取消</button></div>'
        + (draft.error ? '<p class="overview-meeting-error" role="alert">' + esc(draft.error) + '</p>' : '')) + '</tr>';
  }
  function html(pid, line, commercial, knownLines) {
    if (!allowed(pid)) return '';
    var scopeIndex = scopeFor(pid, line, commercial, knownLines), scope = scopes[scopeIndex];
    if (!people[pid] && !loading[pid] && !errors[pid]) Promise.resolve().then(function () { return loadPeople(pid); });
    var rows = [];
    if (people[pid]) (S.reporterTasks || []).forEach(function (task, index) {
      if (task.meeting_kind !== 'requirement' || !inScope(task, scope)) return;
      rows.push('<tr>' + cell('序号', String(rows.length + 1)) + cell('提出人', proposerText(task)) + cell('责任人', esc(task.owner_name || '未记录'))
        + cell('具体事项', '<b>' + esc(task.title || '会议要求事项') + '</b><div>' + rich(task, 'what') + '</div><div class="overview-meta">进展：' + rich(task, 'progress', '尚未反馈') + '</div>')
        + cell('完成时间', esc(dateFor(task) || '未设置'))
        + cell('操作', (canMaintain(task) ? '<button type="button" class="btn ghost sm" onclick="OverviewMeetings.edit(' + scopeIndex + ',' + index + ')">维护</button>' : '只读')+presentationAction(task)) + '</tr>');
    });
    Object.keys(drafts).forEach(function (number) { if (drafts[number].scope === scopeIndex && !drafts[number].leaderNote) rows.push(draftRow(drafts[number], number)); });
    return '<section class="overview-meetings" data-meeting-project="' + esc(pid) + '"><div class="overview-meeting-heading"><h4>会议要求事项</h4><button type="button" class="btn sm" onclick="OverviewMeetings.add(' + scopeIndex + ')"' + (!people[pid] ? ' disabled' : '') + '>新增事项</button></div>'
      + (errors[pid] ? '<p class="overview-meeting-error" role="alert">' + esc(errors[pid]) + ' <button type="button" class="btn sm" onclick="OverviewMeetings.retry(' + scopeIndex + ')">重试</button></p>' : '')
      + (!people[pid] ? '<p class="muted" role="status">' + (errors[pid] ? '本项目承办人尚未读取。' : '正在读取本项目承办人…') + '</p>' : '')
      + '<div class="overview-table-scroll"><table class="overview-data-table overview-meeting-table" data-section="meetings"><colgroup><col class="overview-col-seq"><col class="overview-col-module"><col class="overview-col-module"><col class="overview-col-content"><col class="overview-col-date"><col class="overview-col-actions"></colgroup><thead><tr><th scope="col">序号</th><th scope="col">提出人（总裁／项目总）</th><th scope="col">责任人</th><th scope="col">事项</th><th scope="col">完成时间</th><th scope="col">操作</th></tr></thead><tbody>'
      + (rows.length ? rows.join('') : '<tr><td colspan="6" class="overview-cell-empty">暂无会议要求事项。</td></tr>') + '</tbody></table></div></section>';
  }
  function add(scopeIndex) {
    var scope = scopes[scopeIndex];
    if (scope && scope.residential) {
      if (!arrangementScopeAllowed(scope)) return;
      var entry = ++serial;
      drafts[entry] = {scope:scopeIndex,arrangement:true,project_id:scope.projectIds.length === 1 ? scope.projectIds[0] : '',discipline:scope.filterLine==='__unassigned__'?'':scope.filterLine || '',owner_id:'',proposer_id:operator() ? '' : S.uid,meeting_kind:'requirement',title:'领导工作安排',what:'',due:'',status:'open',progress:'',busy:false};
      cfg.render(); return entry;
    }
    if (!scope || !allowed(scope.pid) || !people[scope.pid]) return;
    var number = ++serial;
    drafts[number] = { scope: scopeIndex, project_id: scope.pid, owner_id: '', proposer_id: operator() ? '' : S.uid, meeting_kind: 'requirement', title: '会议要求事项', what: '', due: '', status: 'open', progress: '', busy: false };
    cfg.render(); return number;
  }
  function edit(scopeIndex, taskIndex) {
    var scope = scopes[scopeIndex], task = (S.reporterTasks || [])[taskIndex];
    if (!scope || !task || !allowed(scope.pid) || !inScope(task, scope) || task.meeting_kind !== 'requirement' || !canMaintain(task)) return;
    var existing = Object.keys(drafts).filter(function (number) { return drafts[number].id === task.id; })[0];
    if (existing) return Number(existing);
    var number = ++serial;
    drafts[number] = Object.assign(copy(task), { scope: scopeIndex, busy: false }); cfg.render(); return number;
  }
  function editResidential(scopeIndex, taskIndex) {
    var scope = scopes[scopeIndex], task = (S.reporterTasks || [])[taskIndex];
    if (!arrangementScopeAllowed(scope) || !task || scope.projectIds.indexOf(task.project_id) < 0 || task.meeting_kind !== 'requirement' || !canMaintain(task) || !people[task.project_id]) return;
    var existing = Object.keys(drafts).filter(function (number) { return drafts[number].id === task.id; })[0];
    if (existing) return Number(existing);
    var owner = ownerCandidates(task.project_id).filter(function (person) { return person.user_id === task.owner_id; })[0], number = ++serial;
    drafts[number] = Object.assign(copy(task), {scope:scopeIndex,arrangement:true,discipline:owner && owner.discipline || '',busy:false});
    cfg.render(); return number;
  }
  function change(number, field, value) {
    var draft = drafts[number];
    if (!draft || draft.busy) return;
    if (draft.arrangement) {
      var scope = scopes[draft.scope];
      if (!arrangementScopeAllowed(scope) || ['project_id','discipline','owner_id','what','due','proposer_id'].indexOf(field) < 0) return;
      value = String(value == null ? '' : value);
      if (field === 'project_id') {
        if (draft.id || value && scope.projectIds.indexOf(value) < 0) return;
        if (draft.project_id !== value) { draft.project_id = value; draft.discipline = ''; draft.owner_id = ''; if (operator()) draft.proposer_id = ''; }
        delete draft.error; return;
      }
      if (!allowed(draft.project_id) && field !== 'what' && field !== 'due') return;
      if (field === 'discipline') {
        if (value && disciplines(draft.project_id).indexOf(value) < 0) return;
        if (draft.discipline !== value) { draft.discipline = value; draft.owner_id = ''; }
        delete draft.error; return;
      }
    } else if (!allowed(draft.project_id) || ['owner_id','what','due','proposer_id'].indexOf(field) < 0) return;
    if (draft.leaderNote && field !== 'owner_id') return;
    draft[field] = String(value == null ? '' : value); delete draft.error;
  }
  function capture(skipSelectors) {
    Object.keys(drafts).forEach(function (number) {
      (skipSelectors ? ['owner','what','due','proposer'] : ['project','discipline','owner','what','due','proposer']).forEach(function (field) {
        var input = global.document && global.document.getElementById('overview_meeting_' + field + '_' + number);
        if (input) change(number, field === 'project' ? 'project_id' : field === 'owner' ? 'owner_id' : field === 'proposer' ? 'proposer_id' : field, input.value);
      });
    });
  }
  function selectArrangement(number, field, value) {
    if (field !== 'project_id' && field !== 'discipline') return;
    if (cfg.flush) cfg.flush(); capture(true); change(number,field,value); cfg.render();
  }
  function cancel(number) { if (drafts[number] && !drafts[number].busy) { delete drafts[number]; cfg.render(); } }
  async function save(number) {
    var draft = drafts[number];
    if (!draft || draft.busy) return;
    if (cfg.flush) cfg.flush(); capture();
    if (draft.arrangement && !draft.project_id) return cfg.toast('请选择原实际项目', 'err');
    if (!allowed(draft.project_id)) return;
    if (draft.arrangement && !draft.id && !draft.discipline) return cfg.toast('请选择具体专业', 'err');
    if (draft.arrangement && draft.discipline && !ownerCandidates(draft.project_id).some(function (person) { return person.user_id === draft.owner_id && person.discipline === draft.discipline; })) return cfg.toast('请从所选专业中明确选择一名有效责任人', 'err');
    if (!draft.what.trim()) return cfg.toast('请填写具体事项', 'err');
    if (draft.arrangement && !draft.id && !draft.due) return cfg.toast('请选择工作安排完成时间', 'err');
    if (!ownerCandidates(draft.project_id).some(function (person) { return person.user_id === draft.owner_id; })) return cfg.toast('请从本项目名单选择一名有效填报人', 'err');
    if (!draft.leaderNote && operator() && !(people[draft.project_id] || []).some(function (person) { return person.user_id === draft.proposer_id && ['president', 'pzo'].indexOf(person.role) >= 0; })
      && !(draft.id && (S.reporterTasks || []).some(function (task) { return task.id === draft.id && task.proposer_id === draft.proposer_id; }))) return cfg.toast('请选择实际提出要求的总裁／项目总', 'err');
    var payload = { project_id: draft.project_id, owner_id: draft.owner_id, proposer_id: operator() ? draft.proposer_id : S.uid, meeting_kind: 'requirement', title: draft.title || '会议要求事项', what: draft.what.trim(), due: draft.due || '', status: draft.status || 'open', progress: draft.progress || '' };
    if (cfg.richCopy) payload = cfg.richCopy(draft, payload, { what: 'what', progress: 'progress' });
    if (draft.id) { payload.id = draft.id; payload.expected_revision = draft.revision; }
    if (draft.leaderNote) payload = { id: draft.id, project_id: draft.project_id, owner_id: draft.owner_id, expected_owner_id: draft.expectedOwnerId };
    else if (cfg.richCollect) payload = cfg.richCollect(payload);
    var generation = epoch, active = cfg;
    draft.busy = true; delete draft.error; active.render();
    try {
      var result = await active.request(draft.leaderNote ? '/api/leader-notes/assign' : '/api/reporter-tasks/save', payload);
      if (generation !== epoch) return;
      if (!result || result.error || !result.data || !result.data.id) {
        var error = result && result.error || {}, conflict = error.status === 409 || error.code === 'revision_conflict' || error.code === 'conflict';
        throw new Error(conflict ? '事项已被其他页面更新，请刷新数据后重新编辑；当前输入保留。' : error.message || '保存结果未能确认，请刷新列表核对后再操作。');
      }
      if(active.onSaved && !draft.leaderNote)active.onSaved(result.data);
      var found = false;
      if (draft.leaderNote) S.leaderNotes = (S.leaderNotes || []).map(function (note) { return note.id === result.data.id ? result.data : note; });
      else {
        S.reporterTasks = (S.reporterTasks || []).map(function (task) { if (task.id === result.data.id) { found = true; return result.data; } return task; });
        if (!found) S.reporterTasks.push(result.data);
      }
      delete drafts[number]; active.toast(draft.arrangement ? '领导工作安排已保存，承办人可在工作台办理' : '会议要求已保存，承办人可在工作台办理');
      try { if (active.reloadTasks) await active.reloadTasks(); }
      catch (_) { if (generation === epoch) active.toast('事项已保存，列表刷新失败，请手动刷新数据。', 'err'); }
    } catch (error) {
      if (generation === epoch) { draft.error = error.message || '保存失败，请检查网络后重试。'; active.toast(draft.error, 'err'); }
    } finally { if (generation === epoch) { draft.busy = false; active.render(); } }
  }
  function binding(id) {
    var match = /^overview_meeting_what_(\d+)$/.exec(id), owner = match && drafts[match[1]];
    if (!owner) return null;
    return { get: function () { return owner._rich && owner._rich.what || (global.ZHRichText && global.ZHRichText.doc(owner, 'what')); },
      set: function (doc) { owner._rich = owner._rich || {}; owner._rich.what = doc; if (global.ZHRichText) owner.what = global.ZHRichText.text(doc); } };
  }
  function editLegacy(pid, noteIndex) {
    var note = (S.leaderNotes || [])[noteIndex];
    if (!operator() || !allowed(pid) || !note || note.project_id !== pid || !people[pid]) return;
    var found = Object.keys(drafts).filter(function (number) { return drafts[number].leaderNote && drafts[number].id === note.id; })[0];
    if (found) return Number(found);
    var number = ++serial;
    drafts[number] = Object.assign(copy(note), { leaderNote: true, expectedOwnerId: note.owner_id || null, scope: scopeFor(pid, null, false, []), busy: false });
    cfg.render(); return number;
  }
  function legacyHtml(pid) {
    if (!allowed(pid)) return '';
    var list = (S.leaderNotes || []).map(function (note, index) { return { note: note, index: index }; }).filter(function (entry) { return entry.note.project_id === pid && entry.note.what; });
    if (!list.length) return '';
    if (!people[pid] && !loading[pid] && !errors[pid]) Promise.resolve().then(function () { return loadPeople(pid); });
    return '<section class="overview-meetings overview-legacy-leaders"><h4>原领导要求记录与责任人核对</h4><p class="muted">原记录及审批来源保持；未明确责任人的记录由运营核实后分派。</p>'
      + (errors[pid] ? '<p class="overview-meeting-error" role="alert">' + esc(errors[pid]) + ' <button type="button" class="btn sm" onclick="OverviewMeetings.retryProject(\'' + esc(pid) + '\')">重读项目人员</button></p>' : '')
      + '<div class="overview-table-scroll"><table class="overview-data-table"><thead><tr><th>序号</th><th>原提出身份</th><th>责任人</th><th>事项</th><th>完成时间</th><th>操作</th></tr></thead><tbody>'
      + list.map(function (entry, index) {
        var note = entry.note, number = Object.keys(drafts).filter(function (key) { return drafts[key].leaderNote && drafts[key].id === note.id; })[0];
        if (number) return draftRow(drafts[number], number);
        return '<tr>' + cell('序号', String(index + 1)) + cell('原提出身份', esc(note.kind === 'pzo_note' ? '项目总安排' : '总裁交代') + '<div class="muted">原录入：' + esc(note.author_name || '未记录') + '</div>')
          + cell('责任人', esc(note.owner_name || '待运营核实')) + cell('事项', rich(note, 'what') + '<div class="muted">' + esc(note.period || '') + '</div>') + cell('完成时间', esc(note.due || '未设置'))
          + cell('操作', operator() ? '<button type="button" class="btn ghost sm" onclick="OverviewMeetings.editLegacy(\'' + esc(pid) + '\',' + entry.index + ')"' + (!people[pid] ? ' disabled' : '') + '>核对责任人</button>' : '只读') + '</tr>';
      }).join('') + '</tbody></table></div></section>';
  }
  function unassignedHtml(pid, commercial, knownLines) {
    if (!allowed(pid)) return '';
    var number = scopeFor(pid, null, commercial, knownLines), scope = scopes[number];
    if (!people[pid]) return html(pid, null, commercial, knownLines);
    if (!(S.reporterTasks || []).some(function(task){return task.meeting_kind === 'requirement' && inScope(task, scope);})) return '';
    return '<div class="overview-unassigned-meetings"><h4>未明确专业的会议要求</h4>' + html(pid, null, commercial, knownLines) + '</div>';
  }
  global.OverviewMeetings = { configure: configure, html: html, residentialHtml:residentialHtml, editResidential:editResidential, selectArrangement:selectArrangement, add: add, edit: edit, change: change, capture: capture, save: save, cancel: cancel,
    retry: function (scopeIndex) { var scope = scopes[scopeIndex]; if (scope) return loadPeople(scope.pid); }, retryProject: loadPeople, binding: binding, legacyHtml: legacyHtml, editLegacy: editLegacy, unassignedHtml: unassignedHtml };
})(window);

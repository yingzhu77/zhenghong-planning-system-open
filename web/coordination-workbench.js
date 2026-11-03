/* Independent coordination requests; report drafts and history are separate. */
(function (global) {
  'use strict';
  var cfg, S, identity, sessionIdentity, epoch = 0;
  var states = Object.create(null);
  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (part) {
      var value = Math.floor(Math.random() * 16); return (part === 'x' ? value : value & 3 | 8).toString(16);
    });
  }
  function freshDraft() { return { id: uuid(), owner_id: '', what: '', due: '', busy: false, error: '' }; }
  function state(pid) {
    return states[pid] || (states[pid] = { draft: freshDraft(), people: [], peopleReady: false, peopleError: '', peopleRevision: 0, peoplePending: null,
      ready: false, error: '', revision: 0, pending: null });
  }
  function configure(options) {
    if (identity !== options.S.uid || sessionIdentity !== options.S.session) {
      if (identity != null) options.S.coordinationTasks = [];
      epoch++; states = Object.create(null); identity = options.S.uid; sessionIdentity = options.S.session;
    }
    cfg = options; S = options.S;
  }
  function allowed(pid) { return !!(S && S.uid && S.profile && S.profile.role === 'pm' && pid && (S.projects || []).some(function (project) { return project.id === pid; })); }
  function esc(value) { return cfg.esc(value == null ? '' : value); }
  function current(pid, generation, view) { return generation === epoch && allowed(pid) && S.pmProject === pid && S.view === view; }
  function check(result, label) {
    if (!result || result.error) {
      var detail = result && result.error || {}, error = new Error(detail.message || label);
      error.code = detail.code; error.conflict = detail.status === 409 || detail.code === 'coordination_conflict' || /conflict/.test(detail.code || ''); throw error;
    }
    return result.data;
  }
  function mergeRows(pid, rows) {
    var found = Object.create(null), output = [];
    (pid ? (S.coordinationTasks || []).filter(function (row) { return row.project_id !== pid; }).concat(rows) : rows).forEach(function (row) {
      if (row && !found[row.id]) { found[row.id] = true; output.push(row); }
    });
    S.coordinationTasks = output;
  }
  async function loadList(pid, force) {
    var entry = state(pid || '*');
    if (!force && entry.ready) return { data: S.coordinationTasks || [], error: null };
    if (!force && entry.pending) return entry.pending;
    var revision = ++entry.revision, generation = epoch, active = cfg;
    function live() { return generation === epoch && revision === entry.revision; }
    entry.error = '';
    var task = (async function () {
      try {
        var rows = check(await active.request('/api/coordination-tasks/list', pid ? { project_id: pid } : {}), '协调事项读取失败，请重试');
        if (!live()) return { data: null, error: { code: 'stale_coordination', message: '协调事项读取条件已变化' } };
        if (!Array.isArray(rows)) throw new Error('协调事项列表读取结果不完整，请重试');
        mergeRows(pid, rows); entry.ready = true;
        return { data: S.coordinationTasks, error: null };
      } catch (error) {
        if (live()) entry.error = error.message || '协调事项读取失败，请重试';
        return { data: null, error: { message: error.message || '协调事项读取失败，请重试' } };
      } finally { if (live()) entry.pending = null; }
    })();
    entry.pending = task; return task;
  }
  async function loadPeople(pid, force) {
    var entry = state(pid);
    if (!force && entry.peopleReady) return { data: entry.people, error: null };
    if (!force && entry.peoplePending) return entry.peoplePending;
    var revision = ++entry.peopleRevision, generation = epoch, active = cfg;
    function live() { return generation === epoch && revision === entry.peopleRevision; }
    entry.peopleError = '';
    var task = (async function () {
      try {
        var response = active.loadPeople ? await active.loadPeople(pid) : await active.request('/api/project-people/list', { project_id: pid });
        var people = check(response, '本项目承办人读取失败，请重试');
        if (!live()) return { data: null, error: { code: 'stale_coordination', message: '承办人读取条件已变化' } };
        if (!Array.isArray(people)) throw new Error('承办人名单读取结果不完整，请重试');
        entry.people = people.filter(function (person) { return person.role === 'pm'; }); entry.peopleReady = true;
        return { data: entry.people, error: null };
      } catch (error) {
        if (live()) entry.peopleError = error.message || '本项目承办人读取失败，请重试';
        return { data: null, error: { message: error.message || '本项目承办人读取失败，请重试' } };
      } finally { if (live()) entry.peoplePending = null; }
    })();
    entry.peoplePending = task; return task;
  }
  async function load(projectId, force) {
    var pid = typeof projectId === 'string' ? projectId : '', target = pid || S && S.pmProject;
    if (!allowed(target)) return { data: null, error: { message: '请先选择有权填报的项目' } };
    var results = await Promise.all([loadList(pid, force), loadPeople(target, force)]);
    return results[0].error ? results[0] : results[1].error ? { data: results[0].data, error: results[1].error } : results[0];
  }
  function inputId(pid, field) { return 'coordination_' + field + '_' + encodeURIComponent(pid); }
  function binding(id) {
    var match = /^coordination_what_(.+)$/.exec(id), pid;
    if (!match) return null;
    try { pid = decodeURIComponent(match[1]); } catch (_) { return null; }
    if (!allowed(pid)) return null;
    var draft = state(pid).draft, generation = epoch, uid = S.uid, session = S.session, view = S.view, line = S.pmLine;
    function live() { return generation === epoch && uid === S.uid && session === S.session && S.pmProject === pid
      && view === S.view && line === S.pmLine && allowed(pid) && state(pid).draft === draft; }
    return { get: function () { return live() && global.ZHRichText ? global.ZHRichText.doc(draft, 'what') : null; },
      set: function (doc) {
        if (!live() || draft.busy) return;
        draft._rich = draft._rich || {}; draft._rich.what = doc;
        if (global.ZHRichText) change(pid, 'what', global.ZHRichText.text(doc));
      } };
  }
  function change(pid, field, value) {
    if (!allowed(pid) || !['owner_id', 'what', 'due'].includes(field)) return;
    var draft = state(pid).draft; if (draft.busy) return;
    var next = String(value == null ? '' : value);
    if(draft[field]!==next){draft[field] = next;draft.error = '';}
  }
  function capture(projectId) {
    var pid = projectId || S && S.pmProject; if (!allowed(pid)) return;
    if(state(pid).draft.resetPending)return;
    ['owner_id', 'what', 'due'].forEach(function (field) {
      var input = global.document && global.document.getElementById(inputId(pid, field));
      if (input) change(pid, field, input.value);
    });
  }
  function validDate(value) {
    var date = new Date(value + 'T00:00:00Z');
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000') && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  async function create(pid) {
    pid = pid || S && S.pmProject; if (!allowed(pid)) return;
    var entry = state(pid), draft = entry.draft; if (draft.busy) return;
    if (cfg.flush) cfg.flush(); capture(pid);
    if (!draft.what.trim()) { draft.error = '请填写具体协调事项'; cfg.render(); return; }
    if (!entry.peopleReady || entry.peopleError || !entry.people.some(function (person) { return person.user_id === draft.owner_id; })) {
      draft.error = '请从本项目有效填报人名单选择一名承办人'; cfg.render(); return;
    }
    if (draft.due && !validDate(draft.due)) { draft.error = '请填写有效的最晚日期，或留空待确定'; cfg.render(); return; }
    var payload = { id: draft.id, project_id: pid, owner_id: draft.owner_id, what: draft.what.trim(), due: draft.due || '' };
    if (cfg.richCopy) payload = cfg.richCopy(draft, payload, { what: 'what' });
    if (cfg.richCollect) payload = cfg.richCollect(payload);
    var generation = epoch, view = S.view, active = cfg;
    draft.busy = true; draft.error = ''; active.render();
    try {
      var row = check(await active.request('/api/coordination-tasks/create', payload), '发起结果未能确认，请刷新列表核对后重试');
      if (generation !== epoch) return;
      if (!row || row.id !== payload.id || row.project_id !== pid || row.author_id !== S.uid) throw new Error('发起结果未能确认，请刷新列表核对后重试；当前输入保留');
      [entry, state('*')].forEach(function (scope) { scope.revision++; scope.pending = null; scope.ready = false; });
      mergeRows(pid, (S.coordinationTasks || []).filter(function (item) { return item.project_id === pid && item.id !== row.id; }).concat([row]));
      entry.draft = freshDraft(); entry.draft.resetPending = true;
      if (current(pid, generation, view) && active.toast) active.toast('协调事项已发起，承办人可在工作台办理');
      try { if (active.afterCreated) await active.afterCreated(row); }
      catch (_) { if (current(pid, generation, view) && active.toast) active.toast('协调事项已发起，关联列表刷新失败，请手动刷新；无需再次发起', 'err'); }
    } catch (error) {
      if (generation === epoch) draft.error = error.conflict ? (error.message || '申请标识或内容冲突') + '；请先刷新列表核对，当前输入保留' : error.message || '协调事项发起失败，请重试';
    } finally {
      if (generation === epoch) { draft.busy = false; if (current(pid, generation, view)) active.render(); }
    }
  }
  async function refresh(pid) {
    pid = pid || S && S.pmProject; if (!allowed(pid)) return;
    if (cfg.flush) cfg.flush(); capture(pid);
    var generation = epoch, view = S.view, entry = state(pid);
    if(entry.refreshing)return;
    if (entry.pending || entry.peoplePending) return load(pid);
    var active=cfg;entry.refreshing=!!active.refreshTasks;
    var task = active.refreshTasks?active.refreshTasks(pid):load(pid, true); active.render();
    if(active.refreshTasks){
      try{var refreshed=await task;if(refreshed===false || refreshed && refreshed.error)throw new Error(refreshed && refreshed.error && refreshed.error.message || '协调事项读取失败，请重试');}
      catch(error){if(generation===epoch)entry.error=error.message || '协调事项读取失败，请重试';}
      entry.refreshing=false;
      if(current(pid,generation,view))active.render();return;
    }
    var result = await task; if (current(pid, generation, view)) cfg.render(); return result;
  }
  function invalidate(pid) {
    var entries = pid ? [state(pid), state('*')] : Object.keys(states).map(function (key) { return states[key]; });
    entries.forEach(function (entry) { entry.revision++; entry.ready = false; entry.pending = null; entry.peopleRevision++; entry.peopleReady = false; entry.peoplePending = null; });
  }
  function seed(projectId, rows, people) {
    if (!allowed(projectId)) return;
    var entry = state(projectId);
    if (Array.isArray(rows)) { entry.ready = true; entry.error = ''; }
    if (Array.isArray(people)) { entry.people = people.filter(function (person) { return person.role === 'pm'; }); entry.peopleReady = true; entry.peopleError = ''; }
  }
  function reset(){epoch++;states=Object.create(null);identity=null;sessionIdentity=null;}
  function render(options) {
    var pid = typeof options === 'string' ? options : options && options.project_id || S && S.pmProject;
    if (!allowed(pid)) return '';
    var entry = state(pid), draft = entry.draft, disabled = draft.busy ? ' disabled' : '';
    draft.resetPending = false;
    var peopleDisabled = disabled || !entry.peopleReady || entry.peopleError ? ' disabled' : '';
    var rows = (S.coordinationTasks || []).filter(function (row) { return row.project_id === pid && row.author_id === S.uid; });
    var clickPid = esc(JSON.stringify(pid));
    return '<section class="card coordination-workbench" data-coordination-project="' + esc(pid) + '"><div class="cardhd"><h3>协调申请</h3><button type="button" class="btn" onclick="CoordinationWorkbench.refresh(' + clickPid + ')"' + (entry.pending || entry.peoplePending || entry.refreshing ? ' disabled' : '') + '>刷新协调事项</button></div>'
      + '<p class="muted">选择本项目承办人直接发起。事项会送到承办人的工作台，由你确认完成与延期申请。</p>'
      + (entry.error || state('*').error ? '<p class="completion-error" role="alert">' + esc(entry.error || state('*').error) + '；已加载记录保留。</p>' : '')
      + (entry.peopleError ? '<p class="completion-error" role="alert">' + esc(entry.peopleError) + '</p>' : '')
      + '<div class="completion-filters"><label>承办人<select id="' + esc(inputId(pid, 'owner_id')) + '" onchange="CoordinationWorkbench.change(' + clickPid + ',\'owner_id\',this.value)"' + peopleDisabled + '><option value="">选择实名承办人</option>'
      + (draft.owner_id && !entry.people.some(function (person) { return person.user_id === draft.owner_id; }) ? '<option value="' + esc(draft.owner_id) + '" selected>原选择待重新核对</option>' : '')
      + entry.people.map(function (person) { return '<option value="' + esc(person.user_id) + '"' + (person.user_id === draft.owner_id ? ' selected' : '') + '>' + esc(person.name + (person.biz_line || person.discipline ? '（' + (person.biz_line || person.discipline) + '）' : '')) + '</option>'; }).join('') + '</select></label>'
      + '<label>最晚日期<input id="' + esc(inputId(pid, 'due')) + '" type="date" value="' + esc(draft.due) + '" onchange="CoordinationWorkbench.change(' + clickPid + ',\'due\',this.value)"' + disabled + '></label></div>'
      + '<label>具体事项<textarea id="' + esc(inputId(pid, 'what')) + '" data-rich rows="3" maxlength="10000" oninput="CoordinationWorkbench.change(' + clickPid + ',\'what\',this.value)"' + disabled + '>' + esc(draft.what) + '</textarea></label>'
      + (draft.error ? '<p class="completion-error" role="alert">' + esc(draft.error) + '</p>' : '')
      + '<div class="actions"><button type="button" class="btn primary" onclick="CoordinationWorkbench.create(' + clickPid + ')"' + (disabled || !entry.peopleReady || entry.peopleError ? ' disabled' : '') + '>' + (draft.busy ? '正在发起…' : '发起协调') + '</button><span class="muted">未填写最晚日期的事项，完成时无法自动判定按时或延期。</span></div>'
      + '<h4>本人发起的协调事项</h4>' + (rows.length ? '<div class="tablewrap"><table class="plan-form-table"><thead><tr><th>承办人</th><th>具体事项</th><th>最晚日期</th><th>办理状态</th></tr></thead><tbody>' + rows.map(function (row) {
        var status = global.CompletionReview && global.CompletionReview.badge ? global.CompletionReview.badge(row.source_key, row.owner_id) : '等待承办人办理';
        return '<tr><td>' + esc(row.owner_name || '未记录承办人') + '</td><td style="white-space:pre-wrap">' + (cfg.richItem ? cfg.richItem(row, 'what') : esc(row.what || '')) + '</td><td>' + esc(row.due || '未设置') + '</td><td>' + status + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">当前项目暂无本人发起的协调事项。</div>') + '</section>';
  }
  global.CoordinationWorkbench = { configure: configure, load: load, render: render, html: render, binding: binding, change: change, capture: capture, create: create, refresh: refresh, invalidate: invalidate, seed: seed, reset: reset };
})(window);

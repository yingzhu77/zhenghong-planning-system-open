/* Operator-assigned meeting work and period-specific follow-up snapshots. */
(function (global) {
  'use strict';
  var cfg, S, identity, sessionIdentity, editing = null, originalProposerId = null, busy = false, refreshing = false, dataIssue = '';
  var peopleCache = Object.create(null), peopleErrors = Object.create(null), peopleLoading = '', peopleEpoch = 0;
  var INVALID_ROWS = '部分同步事项记录格式异常，无法完整展示，待核对原记录后再保存。';
  var STATUS = { open: '待处理', in_progress: '推进中', completed: '已完成' };
  function configure(options) {
    if (identity !== options.S.uid || sessionIdentity !== options.S.session) {
      editing = null; originalProposerId = null; busy = false; refreshing = false; dataIssue = ''; identity = options.S.uid; sessionIdentity = options.S.session;
      peopleCache = Object.create(null); peopleErrors = Object.create(null); peopleLoading = ''; peopleEpoch++;
    }
    cfg = options; S = options.S;
  }
  function esc(value) { return cfg.esc(value == null ? '' : value); }
  function copy(row) { return cfg.richCopy(row, Object.assign({}, row)); }
  function isOperator() { return S.profile && S.profile.role === 'ops'; }
  function meetingKind(row) { return row && (row.meeting_kind === 'requirement' || row.meeting_kind === 'special') ? row.meeting_kind : 'legacy'; }
  function kindText(row) { return { requirement: '会议要求事项', special: '专项会议决议事项', legacy: '原会议事项（待分类）' }[meetingKind(row)]; }
  function displayTitle(row) { return String(row && row.title || '同步事项').replace(/^原会议事项（待分类）(?= · |$)/, '历史会议待办'); }
  function pendingCategory(row) { return row.source_type === 'meeting' ? '会议事项要求' : '他人协调我的事项'; }
  function pendingRow(row) { return row && ['meeting','coord'].includes(row.source_type) && !String(row.source_key || '').startsWith('leader:'); }
  function pendingProposer(row) {
    if (row.source_type === 'meeting') {
      var task = (S.reporterTasks || []).filter(function(item){return 'meeting:'+item.project_id+':'+item.id === row.source_key;})[0];
      if (task) return proposerText(task);
    }
    if (row.source_type === 'leader') {
      var note = (S.leaderNotes || []).filter(function(item){return 'leader:'+item.project_id+':'+item.id === row.source_key;})[0];
      if (note) return (note.kind === 'pzo_note' ? '项目总' : '总裁') + (note.author_name ? ' · ' + note.author_name : '');
    }
    return row.source_author || '未记录提出人';
  }
  function personalKindText(row) { return meetingKind(row)==='legacy'?'历史会议待办':kindText(row); }
  function proposerText(row) { return (row.proposer_role === 'president' ? '总裁' : row.proposer_role === 'pzo' ? '项目总' : '未记录提出身份') + (row.proposer_name ? ' · ' + row.proposer_name : ''); }
  function dueFor(key, due, owner) { return global.CompletionReview && global.CompletionReview.effectiveDue ? global.CompletionReview.effectiveDue(key, due, owner) : due; }
  function state(value) { return Object.prototype.hasOwnProperty.call(STATUS, value) ? value : 'open'; }
  function approvalMode() { return !!(global.CompletionReview && global.CompletionReview.approved); }
  function isApproved(key) { return approvalMode() && global.CompletionReview.approved(key, S.uid); }
  function reviewAction(key) { return approvalMode() ? global.CompletionReview.actionHtml(key, { owner_id: S.uid }) : ''; }
  function statusText(value) { return approvalMode() && value === 'completed' ? '本人反馈完成' : STATUS[state(value)]; }
  function validRow(row) {
    return !!(row && typeof row === 'object' && !Array.isArray(row) && typeof row.source_key === 'string' && row.source_key.trim()
      && typeof row.what === 'string' && typeof row.progress === 'string' && Object.prototype.hasOwnProperty.call(STATUS, row.status));
  }
  function inspectRows(value) {
    if (!Array.isArray(value)) return { rows: [], issue: true };
    var rows = value.filter(validRow);
    return { rows: rows, issue: rows.length !== value.length };
  }
  function validationError() {
    if (inspectRows(S.followupRows || []).issue) dataIssue = INVALID_ROWS;
    if (currentWeek() && (S.followupRows || []).some(function(row){return row && row.meeting_conflict;})) return '会议进展已在其他入口更新，请先核对冲突并选择要保留的进展；草稿保留。';
    return dataIssue;
  }
  function mine(report) { return report.author_id ? report.author_id === S.uid : !!(S.profile && report.author_name === S.profile.name); }
  function scopeProjectIds() {
    return typeof cfg.scopeProjectIds === 'function' ? cfg.scopeProjectIds() : [S.pmProject];
  }
  function inScope(projectId) { return scopeProjectIds().indexOf(projectId) >= 0; }
  function reportScopeId() { return S.pmScopeId || S.pmReportScope && S.pmReportScope.id || ''; }
  function professionalScope() { return !!(S.pmReportScope && S.pmReportScope.reporting_mode === 'professional'); }
  function personalProjectIds(pid) {
    return pid === S.pmProject && reportScopeId() && !(cfg.isCommercial && cfg.isCommercial()) ? scopeProjectIds() : [pid];
  }
  function personalProjectLabel(pid) {
    if (personalProjectIds(S.pmProject).length < 2) return '';
    var project = (S.projects || []).filter(function (row) { return row.id === pid; })[0];
    return '<div class="muted">实际项目：' + esc(project && project.name || pid) + '</div>';
  }
  function hitMe(value) {
    var text = String(value || '').trim(), name = S.profile && S.profile.name || '', line = S.profile && S.profile.biz_line || '';
    var lines = cfg.myBizLines?cfg.myBizLines():line === '*' ? (cfg.bizLines || []) : (line ? [line] : []);
    return !!(text && ((name.length >= 2 && text.indexOf(name) >= 0) || lines.some(function (module) { return text.indexOf(module) >= 0; })));
  }
  function periodDate(period, reference) {
    var week = cfg.weekNo(period), ref = new Date(reference || Date.now());
    if (!Number.isFinite(ref.getTime())) ref = new Date();
    if (!week) return ref.getTime();
    var candidates = [ref.getFullYear() - 1, ref.getFullYear(), ref.getFullYear() + 1].map(function (year) {
      var jan4 = new Date(year, 0, 4);
      jan4.setDate(jan4.getDate() - ((jan4.getDay() || 7) - 1) + (week - 1) * 7);
      return jan4.getTime();
    });
    return candidates.sort(function (a, b) { return Math.abs(a - ref.getTime()) - Math.abs(b - ref.getTime()); })[0];
  }
  function selectedDate() { return periodDate(S.pmPeriod || cfg.currentPeriod(), S.pmReport && (S.pmReport.submitted_at || S.pmReport.created_at)); }
  function currentWeek() {
    var reference=S.pmReport && (S.pmReport.submitted_at || S.pmReport.created_at);
    return global.PlanningWindows ? global.PlanningWindows.samePeriod(S.pmPeriod || cfg.currentPeriod(),cfg.currentPeriod(),reference)
      : selectedDate()===periodDate(cfg.currentPeriod());
  }
  function sourceDate(row) { return periodDate(row.period, row.submitted_at || row.created_at || row.updated_at); }
  function toPeriod(date) {
    var local = new Date(date);
    if (!Number.isFinite(local.getTime())) return '';
    var d = new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate())), day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    return '第' + Math.ceil((((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / 86400000) + 1) / 7) + '周';
  }
  function hash(text) {
    var h = 2166136261;
    for (var i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }
  function richSource(source, row) { return cfg.richCopy(source, row, { what: 'what', progress: 'progress' }); }
  function sources() {
    var selected = selectedDate(), out = [];
    (S.reports || []).forEach(function (r) {
      if (!inScope(r.project_id) || mine(r) || sourceDate(r) > selected) return;
      [['coord', r.coord_items || []], ['handover', r.biz && r.biz.handover || []]].forEach(function (group) {
        group[1].forEach(function (item) {
          if (!item || !String(item.what || '').trim()) return;
          var target = group[0] === 'coord' ? item.who : item.to;
          var hasPersonId = Object.prototype.hasOwnProperty.call(item, 'who_id');
          if (hasPersonId ? item.who_id !== S.uid : !hitMe(target) && !hitMe(item.what)) return;
          var itemId = item.source_id || item.id;
          var base = r.project_id + ':' + r.id + ':' + group[0] + ':';
          var sourceId = itemId ? String(itemId) : 'legacy-' + hash([target || '', item.what, item.by || item.due || ''].join('\n'));
          out.push(richSource(item, { project_id:item.project_id || r.project_id, source_key: 'coord:' + base + sourceId, source_type: 'coord', source_id: sourceId,
            title: group[0] === 'handover' ? '他人工作面移交' : '他人需求事项', what: item.what, due: item.by || item.due || '',
            source_period: r.period || '', source_author: r.author_name || '', status: 'open', progress: '' }));
        });
      });
    });
    (S.reporterTasks || []).forEach(function (task) {
      if (!inScope(task.project_id) || (task.owner_id && task.owner_id !== S.uid)) return;
      var period = task.period || toPeriod(task.created_at), origin = Object.assign({}, task, { period: period });
      if (sourceDate(origin) > selected) return;
      var completedDate = task.completed_at || (task.status === 'completed' ? task.updated_at : '');
      if (!approvalMode() && task.status === 'completed' && completedDate && periodDate(toPeriod(completedDate), completedDate) < selected) return;
      out.push(richSource(task, { project_id:task.project_id, source_key: 'meeting:' + task.project_id + ':' + task.id, source_type: 'meeting', source_id: String(task.id),
        title: kindText(task) + (task.title && task.title !== kindText(task) ? ' · ' + task.title : ''), what: task.what || '', due: task.due || '', source_period: period,
        source_author: task.owner_name || task.author_name || (S.profile && S.profile.name) || '',
        source_revision: task.revision, source_updated_at: task.updated_at || '', status: state(task.status), progress: task.progress || '' }));
    });
    (S.coordinationTasks || []).forEach(function (task) {
      if (!inScope(task.project_id) || task.owner_id !== S.uid) return;
      out.push(richSource(task, { project_id:task.project_id, source_key: task.source_key || 'coord:' + task.project_id + ':' + task.id, source_type: 'coord', source_id: String(task.id),
        independent: true, title: '协调事项', what: task.what || '', due: task.due || '', source_period: '',
        source_author: task.author_name || '', status: 'open', progress: '' }));
    });
    return approvalMode() ? out.filter(function (row) { return !isApproved(row.source_key); }) : out;
  }
  function feedback() {
    var selected = selectedDate(), latest = Object.create(null), commercial = cfg.isCommercial && cfg.isCommercial();
    (S.reports || []).filter(function (r) {
      return r.project_id === S.pmProject && (r.report_scope_id || '') === reportScopeId() && mine(r) && (!(commercial || professionalScope()) || (r.line || '综合') === S.pmLine)
        && sourceDate(r) < selected && r.biz && Object.prototype.hasOwnProperty.call(r.biz, 'followups');
    }).sort(function (a, b) { return sourceDate(a) - sourceDate(b) || String(a.updated_at || '').localeCompare(String(b.updated_at || '')); })
      .forEach(function (r) {
        var checked = inspectRows(r.biz.followups);
        if (checked.issue) dataIssue = INVALID_ROWS;
        checked.rows.filter(pendingRow).forEach(function (row) {
          var saved = copy(row);
          Object.defineProperty(saved, '_feedbackSavedAt', { value: new Date(r.updated_at || r.submitted_at || r.created_at || '').getTime() });
          Object.defineProperty(saved, '_feedbackPeriod', { value: r.period });
          latest[row.source_key] = saved;
        });
      });
    return latest;
  }
  function merge(previous, keepCompleted) {
    var current = sources(), byKey = Object.create(null), taken = Object.create(null), output = [], retired = Object.create(null);
    (S.reporterTasks || []).forEach(function (task) {
      var completed = task.completed_at || task.updated_at;
      if (!approvalMode() && inScope(task.project_id) && task.status === 'completed' && completed && periodDate(toPeriod(completed), completed) < selectedDate()) {
        retired['meeting:' + task.project_id + ':' + task.id] = true;
      }
    });
    current.forEach(function (row) { byKey[row.source_key] = row; });
    Object.keys(previous).forEach(function (key) {
      var old = previous[key], source = byKey[key];
      if (source) taken[source.source_key] = true;
      if (isApproved(key)) return;
      var reopened = old.status === 'completed' && old.source_type === 'meeting' && source && source.status !== 'completed'
        && (Number.isSafeInteger(old.source_revision) && Number.isSafeInteger(source.source_revision)
          ? source.source_revision > old.source_revision
          : source.source_updated_at && Number.isFinite(old._feedbackSavedAt) && new Date(source.source_updated_at).getTime() > old._feedbackSavedAt);
      if (retired[key] || (!approvalMode() && old.status === 'completed' && !reopened && !(keepCompleted && keepCompleted[key]))) return;
      var row = copy(reopened ? source : old);
      if (reopened) {
        row.source_reopened = true;
        row.previous_completed_period = old._feedbackPeriod || old.source_period || '';
        row.previous_completed_progress = old.progress || '';
      }
      row.status = state(row.status);
      if (source) {
        if (source.source_type === 'meeting' && source.status === 'completed') row.status = 'completed';
        row.source_updated = source.what !== row.what || source.due !== row.due || source.title !== row.title;
        row.source_missing = false;
      } else { row.source_updated = true; row.source_missing = true; }
      output.push(row);
    });
    current.forEach(function (row) { if (!taken[row.source_key] && !previous[row.source_key]) output.push(row); });
    return output;
  }
  function prepare() {
    dataIssue = '';
    var biz = S.pmReport && S.pmReport.biz;
    if (biz && Object.prototype.hasOwnProperty.call(biz, 'followups')) {
      var checked = inspectRows(biz.followups);
      if (checked.issue) dataIssue = INVALID_ROWS;
      S.followupRows = checked.rows.map(copy);
    } else S.followupRows = merge(feedback(), false);
    if(!dataIssue)syncMeetingRows(false);
    prepareCoordination();
    return S.followupRows;
  }
  function prepareCoordination() {
    var known = new Set((S.followupRows || []).map(function (row) { return row.source_key; }));
    sources().filter(function (row) { return (currentWeek() || row.independent) && !known.has(row.source_key); }).forEach(function (row) { S.followupRows.push(copy(row)); });
  }
  function progressDoc(row) { return global.ZHRichText && global.ZHRichText.doc(row,'progress'); }
  function sameFeedback(a,b) {
    return !!a && !!b && a.progress===b.progress && state(a.status)===state(b.status)
      && JSON.stringify(progressDoc(a))===JSON.stringify(progressDoc(b));
  }
  function withFeedback(source,feedback) {
    var row=copy(source); row.progress=feedback.progress;row.status=state(feedback.status);
    row._rich=Object.assign({},row._rich || {});delete row._rich.progress;
    if(row.rich_text && row.rich_text.fields){row.rich_text={v:1,fields:Object.assign({},row.rich_text.fields)};delete row.rich_text.fields.progress;}
    return cfg.richCopy(feedback,row,{progress:'progress'});
  }
  // Current tasks are live; submitted reports and older periods stay snapshots.
  function syncMeetingRows(preserveDraft) {
    if(dataIssue || !currentWeek())return;
    var live=Object.create(null),snapshot=Object.create(null),seen=Object.create(null);
    sources().filter(function(row){return row.source_type==='meeting';}).forEach(function(row){live[row.source_key]=row;});
    var savedRows=S.pmReport && S.pmReport.biz && S.pmReport.biz.followups;
    (Array.isArray(savedRows)?savedRows:[]).forEach(function(row){if(row && row.source_key)snapshot[row.source_key]=row;});
    S.followupRows=inspectRows(S.followupRows || []).rows.map(function(old){
      var source=live[old.source_key];if(!source)return old;seen[old.source_key]=true;
      var local=old.source_revision===source.source_revision || preserveDraft && !sameFeedback(old,snapshot[old.source_key])
        || !Number.isSafeInteger(old.source_revision) && !!old.progress;
      if(local && old.source_revision!==source.source_revision && !sameFeedback(old,source)){
        var conflict=copy(old);conflict.meeting_conflict=true;return conflict;
      }
      var row=local?withFeedback(source,old):copy(source);delete row.meeting_conflict;return row;
    });
    Object.keys(live).forEach(function(key){if(!seen[key])S.followupRows.push(copy(live[key]));});
  }
  function resolveMeeting(index,keepDraft) {
    if(!currentWeek())return;
    if(cfg.flush)cfg.flush();capture();
    var old=(S.followupRows || [])[index],source=old && sources().filter(function(row){return row.source_key===old.source_key;})[0];
    if(!old || !source || source.source_type!=='meeting')return;
    S.followupRows[index]=keepDraft?withFeedback(source,old):copy(source);
    if(cfg.saveDraft)cfg.saveDraft(true);cfg.render();
  }
  function syncSavedTask(task,baseline,scope) {
    if(!task || !currentWeek() || !inScope(task.project_id) || task.owner_id!==S.uid)return false;
    if(scope && (scope.project!==S.pmProject || scope.period!==S.pmPeriod || scope.line!==S.pmLine || (scope.reportScope || '')!==reportScopeId()))return false;
    var source=sources().filter(function(row){return row.source_key==='meeting:'+task.project_id+':'+task.id;})[0];
    if(!source)return false;
    var found=false,conflict=false;S.followupRows=(S.followupRows || []).map(function(row){
      if(row.source_key!==source.source_key)return row;found=true;
      if(scope && !sameFeedback(row,baseline) && !sameFeedback(row,source)){conflict=true;var retained=copy(row);retained.meeting_conflict=true;return retained;}
      return copy(source);
    });
    if(!found)S.followupRows.push(copy(source));
    if(cfg.saveDraft)cfg.saveDraft(true);return conflict?'conflict':true;
  }
  function read(id, fallback) {
    var el = global.document && global.document.getElementById(id);
    return el ? String(el.value == null ? '' : el.value) : fallback;
  }
  function capture() {
    var current = S.followupRows || [];
    if (!Array.isArray(current)) { dataIssue = INVALID_ROWS; current = []; }
    current.forEach(function (row, index) {
      if (!validRow(row)) { dataIssue = INVALID_ROWS; return; }
      row.progress = read('followup_progress_' + index, row.progress || '');
      row.status = state(read('followup_status_' + index, row.status));
    });
    if (editing) {
      if (isOperator()) {
        editing.title = read('meeting_title', editing.title || '');
        editing.what = read('meeting_what', editing.what || '');
        editing.due = read('meeting_due', editing.due || '');
        editing.owner_id = read('meeting_owner', editing.owner_id || '');
        editing.meeting_kind = read('meeting_kind', editing.meeting_kind || 'special');
        editing.proposer_id = read('meeting_proposer', editing.proposer_id || '');
      }
      editing.status = state(read('meeting_status', editing.status));
      editing.progress = read('meeting_progress', editing.progress || '');
    }
  }
  function rows() { capture(); return inspectRows(S.followupRows || []).rows.map(copy); }
  async function refreshSources() {
    if (refreshing) return;
    if (cfg.flush) cfg.flush(); capture();
    if (cfg.saveDraft) cfg.saveDraft();
    var active = cfg, uid = S.uid, session = S.session, pid = S.pmProject, period = S.pmPeriod, line = S.pmLine, scopeId=reportScopeId();
    function sameSession() { return identity === uid && S.uid === uid && S.session === session; }
    function sameScope() { return sameSession() && S.pmProject === pid && S.pmPeriod === period && S.pmLine === line && reportScopeId()===scopeId; }
    refreshing = true; active.render();
    try {
      var result = await active.reloadSources();
      if (!sameScope()) return;
      if (result === false || (result && result.error)) throw new Error(result && result.error && result.error.message || '部分来源读取失败，请重试');
      if (active.flush) active.flush(); capture();
      var previous = feedback(), keepCompleted = Object.create(null);
      inspectRows(S.followupRows || []).rows.forEach(function (row) { previous[row.source_key] = row; keepCompleted[row.source_key] = true; });
      /* Only the selected editable period changes; saved reports remain untouched. */
      S.followupRows = merge(previous, keepCompleted);
      syncMeetingRows(true);
      if (active.saveDraft) active.saveDraft();
      active.toast('已更新可同步来源，已填写的进展保留');
    } catch (error) {
      if (sameScope()) {
        if (active.flush) active.flush(); capture();
        if (active.saveDraft) active.saveDraft();
        active.toast('同步来源更新失败：' + (error.message || '请检查网络后重试') + '；已填写内容保留。', 'err');
      }
    } finally {
      if (sameSession()) refreshing = false;
      if (sameScope()) active.render();
    }
  }
  function options(value) {
    return Object.keys(STATUS).map(function (key) { return '<option value="' + key + '"' + (key === state(value) ? ' selected' : '') + '>' + statusText(key) + '</option>'; }).join('');
  }
  function origin(row) {
    var label = row.source_type === 'meeting' ? '会议决议' : row.source_type === 'leader' ? '领导安排' : '他人需求';
    var project = (S.projects || []).filter(function(p){return p.id===row.project_id;})[0];
    return esc(label + (row.project_id ? ' · '+(project && project.name || row.project_id) : '') + ' · ' + (row.source_author || '未记录提出人') + (row.source_period ? ' · ' + row.source_period : ''));
  }
  function reopenedHtml(row) {
    return row.source_reopened ? '<p class="reporter-source-note">会议事项已重新打开；前次' + esc(row.previous_completed_period || '')
      + '完成反馈：' + esc(row.previous_completed_progress || '未填写') + '</p>' : '';
  }
  function openFeedback(key) {
    if (typeof cfg.openFeedback === 'function') return cfg.openFeedback(key);
    if (global.App && typeof global.App.view === 'function') return global.App.view('form');
  }
  function feedbackLink(key) {
    return '<button type="button" class="btn ghost sm reporter-feedback-link" onclick="' + esc('ReporterTasks.openFeedback('+JSON.stringify(key)+')') + '">填写本期反馈</button>';
  }
  function formHtml() {
    validationError();
    S.followupRows = inspectRows(S.followupRows || []).rows;
    var visible=S.followupRows.map(function(row,index){return {row:row,index:index};}).filter(function(entry){return pendingRow(entry.row);});
    return '<section class="card reporter-followups"><div class="cardhd"><h3>四、待处理事项清单</h3>'
      + '<button type="button" class="btn" onclick="ReporterTasks.refreshSources()"' + (refreshing ? ' disabled' : '') + '>' + (refreshing ? '更新中…' : '更新待办事项') + '</button></div>'
      + (dataIssue ? '<p class="reporter-source-note" role="alert">' + esc(dataIssue) + '</p>' : '')
      + '<div class="tablewrap reporter-followup-scroll"><table class="reporter-followup-table"><thead><tr><th>类别</th><th>提出人</th><th>事项内容</th><th>完成时间</th><th>本期进展</th></tr></thead><tbody>'
      + (visible.length ? visible.map(function (entry) {
        var row=entry.row,index=entry.index;
        var effectiveDue=dueFor(row.source_key,row.due,S.uid);
        return '<tr data-followup-key="'+esc(row.source_key)+'" data-followup-index="'+index+'"><td data-label="类别"><b>' + esc(pendingCategory(row)) + '</b></td>'
          + '<td data-label="提出人">'+esc(pendingProposer(row))+'<div class="muted">'+origin(row)+'</div></td>'
          + '<td data-label="事项内容">' + cfg.richItem(row, 'what', '未填写事项内容') + reopenedHtml(row)
          + (row.source_updated ? '<p class="reporter-source-note">来源已更新' + (row.source_missing ? '或已移除' : '') + '，保留此前事项与反馈供核对。</p>' : '') + '</td>'
          + '<td data-label="完成时间">' + esc(effectiveDue || '未设置') + (effectiveDue && effectiveDue!==row.due?'<div class="muted">原期限：'+esc(row.due || '未设置')+'</div>':'') + '</td>'
          + '<td data-label="本期进展"><label class="reporter-followup-status">处理状态<select id="followup_status_' + index + '" aria-label="同步事项处理状态">' + options(row.status) + '</select></label>'
          + '<textarea id="followup_progress_' + index + '" data-rich rows="2" aria-label="同步事项本期进展" placeholder="填写本期进展、结果或待协调内容">' + esc(row.progress) + '</textarea>'
          + (row.meeting_conflict ? '<div class="reporter-source-note" role="alert">其他入口已有更新，本机输入保留。<div class="reporter-conflict-actions"><button type="button" class="btn ghost sm" onclick="ReporterTasks.resolveMeeting('+index+',false)">采用最新进展</button><button type="button" class="btn ghost sm" onclick="ReporterTasks.resolveMeeting('+index+',true)">保留本机进展</button></div></div>' : '')
          + '<div class="reporter-followup-actions">'+reviewAction(row.source_key)+'</div></td>'
          + '</tr>';
      }).join('') : '<tr><td colspan="5" class="empty">' + (dataIssue ? '待办事项未能完整读取，请核对原记录。' : '本期暂无待处理事项。') + '</td></tr>') + '</tbody></table></div></section>';
  }
  function meetingForm(pid) {
    if (!editing || editing.project_id !== pid) return '';
    if (busy) return '<div class="reporter-meeting-form" role="status" aria-live="polite"><b>' + esc(editing.title) + '</b><p class="muted">正在保存会议事项…</p></div>';
    var operator = isOperator(), candidates = peopleCache[pid] || [];
    var fields = operator
      ? '<label>事项类别<select id="meeting_kind" onchange="ReporterTasks.setKind(this.value)">' + ['requirement', 'special'].concat(editing.id && meetingKind(editing) === 'legacy' ? ['legacy'] : []).map(function(kind){return '<option value="'+kind+'"'+(meetingKind(editing)===kind?' selected':'')+'>'+kindText({meeting_kind:kind})+'</option>';}).join('') + '</select></label>'
        + (meetingKind(editing) === 'requirement' ? '<label>实际提出人<select id="meeting_proposer"><option value="">选择总裁／项目总</option>'
          + (originalProposerId && !candidates.some(function(p){return p.user_id===originalProposerId && ['president','pzo'].indexOf(p.role)>=0;}) ? '<option value="'+esc(originalProposerId)+'"'+(editing.proposer_id===originalProposerId?' selected':'')+'>'+esc(proposerText(editing)+'（原提出人）')+'</option>' : '')
          + candidates.filter(function(p){return p.role==='president' || p.role==='pzo';}).map(function(p){return '<option value="'+esc(p.user_id)+'"'+(p.user_id===editing.proposer_id?' selected':'')+'>'+esc((p.role==='president'?'总裁':'项目总')+' · '+p.name)+'</option>';}).join('')+'</select></label>' : '')
        + '<label>承办人<select id="meeting_owner"' + (peopleLoading === pid ? ' disabled' : '') + '><option value="">选择本项目填报人</option>'
        + (editing.owner_id && !candidates.some(function (person) { return person.user_id === editing.owner_id; }) ? '<option value="' + esc(editing.owner_id) + '" selected>' + esc(editing.owner_name || '原承办人') + '</option>' : '')
        + candidates.filter(function (person) { return person.role === 'pm'; }).map(function (person) { return '<option value="' + esc(person.user_id) + '"' + (person.user_id === editing.owner_id ? ' selected' : '') + '>'
          + esc(person.name + (person.biz_line || person.discipline ? '（' + (person.biz_line || person.discipline) + '）' : '')) + '</option>'; }).join('') + '</select></label>'
        + (peopleLoading === pid ? '<p class="muted" role="status">正在读取本项目承办人…</p>' : '')
        + (peopleErrors[pid] ? '<p class="reporter-source-note" role="alert">' + esc(peopleErrors[pid]) + ' <button type="button" class="btn" onclick="ReporterTasks.retryPeople()">重试</button></p>' : '')
        + '<label>事项标题<input id="meeting_title" maxlength="200" value="' + esc(editing.title) + '" placeholder="填写会议主题或事项标题"></label>'
        + '<label>事项内容<textarea id="meeting_what" data-rich rows="3" placeholder="填写会议决议及交付要求">' + esc(editing.what) + '</textarea></label>'
        + '<label>最晚时间<input id="meeting_due" type="date" value="' + esc(editing.due) + '"></label>'
      : '<div class="reporter-meeting-source"><b>' + esc(editing.title) + '</b><div>' + cfg.richItem(editing, 'what') + '</div><p class="muted">运营分派 · 最晚时间：'
        + esc(dueFor('meeting:' + pid + ':' + editing.id, editing.due, editing.owner_id) || '未设置') + '</p></div>';
    return '<div class="reporter-meeting-form"><h4>' + (operator ? (editing.id ? '维护' : '新增') + kindText(editing) : '更新会议事项进展') + '</h4>'
      + fields
      + (!operator ? '<label>处理状态<select id="meeting_status">' + ['open', 'in_progress'].concat(editing.status === 'completed' ? ['completed'] : []).map(function (key) { return '<option value="' + key + '"' + (key === editing.status ? ' selected' : '') + (key === 'completed' ? ' disabled' : '') + '>' + statusText(key) + '</option>'; }).join('') + '</select></label>'
        + '<label>当前进展<textarea id="meeting_progress" data-rich rows="2" placeholder="填写当前进展、结果或待解决问题">' + esc(editing.progress) + '</textarea></label>' : '<p class="muted">承办人负责更新进展，并逐项申请完成或延期；改派会保留原承办历史。</p>')
      + '<div class="reporter-meeting-actions"><button type="button" class="btn primary" onclick="ReporterTasks.save()"' + (busy ? ' disabled' : '') + '>' + (busy ? '保存中…' : '保存会议事项') + '</button>'
      + '<button type="button" class="btn" onclick="ReporterTasks.cancel()"' + (busy ? ' disabled' : '') + '>取消</button></div></div>';
  }
  function personalTasks(pid, kind) {
    var projects = personalProjectIds(pid);
    return (S.reporterTasks || []).map(function (row, index) { return { row: row, index: index }; }).filter(function (entry) {
      return projects.indexOf(entry.row.project_id) >= 0 && entry.row.owner_id === S.uid && meetingKind(entry.row) === kind;
    }).sort(function (a, b) { return (a.row.status === 'completed') - (b.row.status === 'completed') || String(a.row.due || '9999').localeCompare(String(b.row.due || '9999')); });
  }
  function currentFeedback(key, live) {
    var saved=(S.followupRows || []).filter(function(row){return row && row.source_key===key;})[0];
    if(saved)return saved;
    if(currentWeek())return live;
    return {progress:'',status:'open'};
  }
  function taskRow(entry, requirement) {
    var row = entry.row, key = 'meeting:' + row.project_id + ':' + row.id, feedback=currentFeedback(key,row), approved=isApproved(key);
    return '<tr data-meeting-key="'+esc(key)+'">' + (requirement ? '<td data-label="提出人">' + esc(proposerText(row)) + '</td>' : '<td data-label="类型／模块">' + esc(personalKindText(row)) + '</td>')
      + '<td data-label="事项内容"><b>' + esc(row.title || personalKindText(row)) + '</b>' + personalProjectLabel(row.project_id) + '<div>' + cfg.richItem(row, 'what') + '</div></td>'
      + '<td data-label="完成时间">' + esc(dueFor(key, row.due, row.owner_id) || '未设置') + '</td><td data-label="本期进展">' + cfg.richItem(feedback, 'progress', '本期未填写')
      + '<div class="reporter-feedback-state">' + (approved ? '已审核完成' : feedback.meeting_conflict?'进展待核对':statusText(feedback.status)) + '</div></td><td data-label="事项申报"><div class="reporter-row-actions">'
      + (!approved?feedbackLink(key):'') + reviewAction(key) + '</div></td></tr>';
  }
  function taskTable(list, requirement, empty) {
    return '<div class="tablewrap"><table class="pm-assignment-table reporter-personal-task-table"><thead><tr><th>' + (requirement ? '提出人' : '类型／模块') + '</th><th>事项内容</th><th>完成时间</th><th>本期进展</th><th>事项申报</th></tr></thead><tbody>'
      + (list.length ? list.map(function(entry){return taskRow(entry,requirement);}).join('') : '<tr><td colspan="5" class="empty">'+esc(empty)+'</td></tr>') + '</tbody></table></div>';
  }
  function requirementsHtml(pid) {
    var list = personalTasks(pid, 'requirement'), projects = personalProjectIds(pid);
    var leaders = (S.leaderNotes || []).filter(function(note){return projects.indexOf(note.project_id)>=0 && note.owner_id===S.uid && String(note.what || '').trim() && sourceDate(note)<=selectedDate();});
    var unassigned = (S.leaderNotes || []).filter(function(note){return projects.indexOf(note.project_id)>=0 && !note.owner_id && String(note.what || '').trim();});
    var legacyRows=leaders.map(function(note){
      var key='leader:'+note.project_id+':'+note.id, saved=currentFeedback(key,{progress:'',status:'open'});
      return '<tr><td data-label="提出人">'+esc(note.kind==='pzo_note'?'项目总安排（原记录）':'总裁交代（原记录）')+'</td><td data-label="事项内容">'+personalProjectLabel(note.project_id)+cfg.richItem(note,'what')+'<div class="muted">'+esc(note.period || '')+'</div></td>'
        +'<td data-label="完成时间">'+esc(dueFor(key,note.due,S.uid) || '未设置')+'</td><td data-label="本期进展">'+cfg.richItem(saved,'progress','本期未填写')+'<div class="reporter-feedback-state">'+(isApproved(key)?'已审核完成':statusText(saved.status))+'</div></td>'
        +'<td data-label="事项申报">'+(!isApproved(key)?feedbackLink(key):'')+reviewAction(key)+'</td></tr>';
    }).join('');
    var table = taskTable(list, true, leaders.length ? '' : '暂无分派给本人的会议要求事项。');
    if(legacyRows)table=table.replace('</tbody>',legacyRows+'</tbody>').replace('<tr><td colspan="5" class="empty"></td></tr>','');
    return '<section class="card reporter-meetings reporter-requirements"><div class="cardhd"><h3>会议要求事项<span class="chip">'+(list.length+leaders.length)+' 项</span></h3></div>'
      + '<p class="muted">本期进展从“本期填报→同步事项”读取；需要办结或调整期限时在此申报，由运营审核。</p>'
      +table
      +(unassigned.length?'<details class="reporter-unassigned-leaders"><summary>原领导记录（未明确责任人，保留核对） '+unassigned.length+' 条</summary><p class="muted">以下原记录保持项目范围可见，待运营核实责任人，不自动作为本人的新任务。</p>'
        +unassigned.map(function(note){return '<article><b>'+esc(note.kind==='pzo_note'?'项目总安排':'总裁交代')+'</b>'+personalProjectLabel(note.project_id)+'<div>'+cfg.richItem(note,'what')+'</div><p class="muted">'+esc(note.period || '')+' · '+esc(note.due || '未设完成时间')+'</p></article>';}).join('')+'</details>':'')+'</section>';
  }
  function workbenchHtml(pid) {
    var list=personalTasks(pid,'special'),legacy=personalTasks(pid,'legacy');
    return '<section class="card reporter-meetings reporter-special-meetings"><div class="cardhd"><h3>专项会议决议事项<span class="chip">'+list.length+' 项</span></h3></div>'
      +'<p class="muted">本期进展从“本期填报→同步事项”读取；在此申请完成或延期，无需重复填写进展。</p>'
      +taskTable(list,false,'暂无分派给本人的专项会议决议事项。')+'</section>'
      +(legacy.length?'<section class="card reporter-meetings reporter-legacy-meetings"><div class="cardhd"><h3>历史会议待办<span class="chip">'+legacy.length+' 项</span></h3></div><p class="muted">这里是此前分派给你的会议事项，请继续按原要求办理。进展在本期填报统一填写，完成或需要延期时在此申报；事项类别由运营核对，不影响办理。</p>'+taskTable(legacy,false,'暂无历史会议待办。')+'</section>':'');
  }
  function pendingHtml(pid) {
    var projects=personalProjectIds(pid), count=0, body='';
    function add(category,cells,key){count++;body+='<tr'+(key?' data-meeting-key="'+esc(key)+'"':'')+'><td data-label="类别">'+esc(category)+'</td>'+cells+'</tr>';}
    sources().filter(function(row){return projects.indexOf(row.project_id)>=0;}).forEach(function(row){
      var key=row.source_key, feedback=currentFeedback(key,row);
      add(pendingCategory(row),'<td data-label="提出人">'+esc(pendingProposer(row))+'</td><td data-label="事项内容">'+personalProjectLabel(row.project_id)+cfg.richItem(row,'what')+'</td>'
        +'<td data-label="完成时间">'+esc(dueFor(key,row.due,S.uid) || '未设置')+'</td><td data-label="本期进展">'+cfg.richItem(feedback,'progress','本期未填写')+'</td>'
        +'<td data-label="事项申报">'+feedbackLink(key)+reviewAction(key)+'</td>',key);
    });
    return '<section class="card reporter-pending"><div class="cardhd"><h3>待处理事项清单<span class="chip">'+count+' 项</span></h3></div><div class="tablewrap"><table class="pm-assignment-table reporter-personal-task-table"><thead><tr><th>类别</th><th>提出人</th><th>事项内容</th><th>完成时间</th><th>本期进展</th><th>事项申报</th></tr></thead><tbody>'+(body || '<tr><td colspan="6" class="empty">暂无待处理事项。</td></tr>')+'</tbody></table></div>'
      +'</section>';
  }
  function renderAdmin() {
    if (!isOperator()) return '<div class="card empty">仅运营可维护会议事项。</div>';
    var projects = S.projects || [], pid = S.meetingAdminProject, kind=S.meetingAdminKind || 'special';
    if (!projects.some(function (p) { return p.id === pid; })) pid = S.meetingAdminProject = projects[0] && projects[0].id || '';
    var list = (S.reporterTasks || []).map(function (row, index) { return { row: row, index: index }; }).filter(function (item) { return item.row.project_id === pid && meetingKind(item.row)===kind; });
    return '<section class="card reporter-meetings reporter-meetings-admin"><div class="cardhd"><h3>会议事项维护</h3><div class="reporter-admin-controls"><select aria-label="会议事项项目" onchange="ReporterTasks.filterProject(this.value)"' + (busy || editing ? ' disabled' : '') + '>'
      + projects.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === pid ? ' selected' : '') + '>' + esc(p.name || p.id) + '</option>'; }).join('') + '</select>'
      + '<select aria-label="会议事项类别" onchange="ReporterTasks.filterKind(this.value)"'+(busy || editing?' disabled':'')+'>'+['requirement','special','legacy'].map(function(value){return '<option value="'+value+'"'+(kind===value?' selected':'')+'>'+kindText({meeting_kind:value})+'</option>';}).join('')+'</select>'
      + '<button type="button" class="btn primary" onclick="ReporterTasks.edit()"' + (busy || !pid ? ' disabled' : '') + '>录入'+esc(kindText({meeting_kind:kind==='legacy'?'special':kind}))+'</button></div></div>'
      + '<p class="muted">按项目记录会议决议，为每项指定一名承办人；承办人更新进展并提交完成或延期申请，运营在事项审核中逐条处理。</p>' + meetingForm(pid)
      + (list.length ? '<div class="tablewrap"><table><thead><tr><th>会议事项</th><th>提出人</th><th>责任人</th><th>完成时间</th><th>当前进展</th><th>操作</th></tr></thead><tbody>' + list.map(function (entry) {
        var row = entry.row; return '<tr><td><b>' + esc(row.title) + '</b><div>' + cfg.richItem(row, 'what') + '</div></td><td>'+esc(meetingKind(row)==='requirement'?proposerText(row):'运营录入')+'</td><td>' + esc(row.owner_name || '未记录') + '</td><td>'
          + esc(dueFor('meeting:' + pid + ':' + row.id, row.due, row.owner_id) || '—') + '</td><td>' + cfg.richItem(row, 'progress', '尚未反馈进展') + '</td><td><button type="button" class="btn" onclick="ReporterTasks.edit(' + entry.index + ')"' + (busy ? ' disabled' : '') + '>维护事项</button></td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">本项目暂无会议事项。</div>') + '</section>';
  }
  function filterProject(pid) {
    if (busy || editing || !(S.projects || []).some(function (p) { return p.id === pid; })) return;
    S.meetingAdminProject = pid; cfg.render();
  }
  function filterKind(kind) {
    if (busy || editing || ['requirement', 'special', 'legacy'].indexOf(kind) < 0) return;
    S.meetingAdminKind = kind; cfg.render();
  }
  function setKind(kind) {
    if (!isOperator() || !editing || busy || ['requirement', 'special', 'legacy'].indexOf(kind) < 0) return;
    if (cfg.flush) cfg.flush(); capture(); editing.meeting_kind = kind; cfg.render();
  }
  function retryPeople() { return loadPeople(editing && editing.project_id || S.meetingAdminProject); }
  async function loadPeople(pid) {
    if (!isOperator() || !pid || typeof cfg.loadPeople !== 'function') return;
    var uid = S.uid, session = S.session, epoch = ++peopleEpoch, active = cfg;
    peopleLoading = pid; delete peopleErrors[pid]; cfg.render();
    try {
      var result = await active.loadPeople(pid);
      if (epoch !== peopleEpoch || S.uid !== uid || S.session !== session) return;
      if (!result || result.error || !Array.isArray(result.data)) throw new Error(result && result.error && result.error.message || '承办人读取失败，请重试');
      peopleCache[pid] = result.data;
    } catch (error) { if (epoch === peopleEpoch && S.uid === uid && S.session === session) peopleErrors[pid] = error.message || '承办人读取失败，请重试'; }
    finally { if (epoch === peopleEpoch && S.uid === uid && S.session === session) { if (active.flush) active.flush(); capture(); peopleLoading = ''; active.render(); } }
  }
  function edit(index) {
    if (busy) return;
    if (cfg.flush) cfg.flush(); capture();
    var source = index === undefined ? null : (S.reporterTasks || [])[index];
    if (index !== undefined && !source || !source && !isOperator()) return;
    editing = source ? copy(source) : { project_id: S.meetingAdminProject || (S.projects || [])[0] && S.projects[0].id, owner_id: '', meeting_kind: S.meetingAdminKind === 'requirement' ? 'requirement' : 'special', proposer_id: '', title: '', what: '', due: '', status: 'open', progress: '' };
    originalProposerId = source && meetingKind(source) === 'requirement' ? source.proposer_id || null : null;
    if(source && !isOperator() && currentWeek()){
      var feedback=(S.followupRows || []).filter(function(row){return row.source_key==='meeting:'+source.project_id+':'+source.id && row.source_revision===source.revision && !row.meeting_conflict;})[0];
      if(feedback){editing=withFeedback(editing,feedback);editing.status=feedback.status==='completed'?'in_progress':state(feedback.status);}
    }
    cfg.render();
    var loading = isOperator() ? loadPeople(editing.project_id) : null;
    var field = global.document && global.document.getElementById('meeting_title'); if (field && field.focus) field.focus();
    return loading;
  }
  function cancel() { if (busy) return; editing = null; originalProposerId = null; cfg.render(); }
  async function save() {
    if (!editing || busy) return;
    if (cfg.flush) cfg.flush(); capture();
    if (isOperator() && (!editing.title.trim() || !editing.what.trim())) return cfg.toast('请填写事项标题和内容', 'err');
    if (isOperator() && (!editing.owner_id || peopleLoading === editing.project_id || !(peopleCache[editing.project_id] || []).some(function (p) { return p.user_id === editing.owner_id && p.role === 'pm'; }))) return cfg.toast('请从本项目名单选择一名承办人', 'err');
    if (isOperator() && meetingKind(editing) === 'requirement' && !(editing.id && originalProposerId && editing.proposer_id===originalProposerId)
      && !(peopleCache[editing.project_id] || []).some(function(p){return p.user_id===editing.proposer_id && ['president','pzo'].indexOf(p.role)>=0;})) return cfg.toast('请选择实际提出要求的总裁／项目总', 'err');
    var payload = isOperator()
      ? cfg.richCopy(editing, { project_id: editing.project_id, owner_id: editing.owner_id, meeting_kind: meetingKind(editing), proposer_id: meetingKind(editing)==='requirement'?editing.proposer_id:null, title: editing.title.trim(), what: editing.what.trim(), due: editing.due || '', status: state(editing.status), progress: editing.progress.trim() }, { what: 'what', progress: 'progress' })
      : cfg.richCopy(editing, { project_id: editing.project_id, status: state(editing.status), progress: editing.progress.trim() }, { progress: 'progress' });
    if (editing.id) { payload.id = editing.id; payload.expected_revision = editing.revision; }
    payload = cfg.richCollect(payload);
    var savingUid = S.uid, savingSession = S.session, active = cfg;
    var savingScope={project:S.pmProject,period:S.pmPeriod,line:S.pmLine,reportScope:reportScopeId()};
    var baseline=(S.followupRows || []).filter(function(row){return row.source_key==='meeting:'+editing.project_id+':'+editing.id;})[0];
    baseline=baseline?JSON.parse(JSON.stringify(copy(baseline))):null;
    function sameSession() { return identity === savingUid && S.uid === savingUid && S.session === savingSession; }
    busy = true; cfg.render();
    try {
      var result = await active.request('/api/reporter-tasks/save', payload);
      if (!sameSession()) return;
      if (result.error) {
        var conflict = result.error.status === 409 || result.error.code === 'conflict' || result.error.code === 'revision_conflict';
        active.toast(conflict ? '事项已被其他页面更新，请刷新数据后重新编辑；当前输入仍保留。' : '保存失败：' + (result.error.message || '请检查网络后重试'), 'err');
        return;
      }
      if(active.flush)active.flush();capture();
      editing = null;
      originalProposerId = null;
      if (result.data) {
        var found = false;
        S.reporterTasks = (S.reporterTasks || []).map(function (row) { if (row.id === result.data.id) { found = true; return result.data; } return row; });
        if (!found) S.reporterTasks.push(result.data);
      }
      var synced=result.data && syncSavedTask(result.data,baseline,savingScope);
      active.toast(synced==='conflict'?'会议进展已保存；等待期间的新输入已保留，请到本期填报核对进展冲突。':synced?'会议进展已保存，并同步本周填报草稿；历史周报保持原快照。':'会议事项已保存');
      try { await active.reloadTasks(); } catch (_) { active.toast('事项已保存，列表刷新失败，请手动刷新数据', 'err'); }
    } catch (error) {
      if (sameSession()) active.toast('保存失败：' + (error.message || '无法连接服务器，请重试'), 'err');
    } finally {
      if (sameSession()) { busy = false; active.render(); }
    }
  }
  function binding(id) {
    var owner, key, match = /^followup_progress_(\d+)$/.exec(id);
    if (match) { owner = (S.followupRows || [])[Number(match[1])]; key = 'progress'; }
    else if (id === 'meeting_what' || id === 'meeting_progress') { owner = editing; key = id.slice('meeting_'.length); }
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return null;
    return { get: function () { return owner._rich && owner._rich[key] || (global.ZHRichText && global.ZHRichText.doc(owner, key)); },
      set: function (doc) { owner._rich = owner._rich || {}; owner._rich[key] = doc; if (global.ZHRichText) owner[key] = global.ZHRichText.text(doc); } };
  }
  function snapshotHtml(report) {
    var biz = report && report.biz;
    if (!biz || !Object.prototype.hasOwnProperty.call(biz, 'followups')) return '';
    var checked = inspectRows(biz.followups), list = checked.rows;
    if (!list.length && !checked.issue) return '';
    if (global.ZHRichText) global.ZHRichText.attach(report);
    return '<section class="reporter-followup-snapshot"><h4>同步事项</h4>' + (approvalMode() ? '<p class="muted">以下为当期本人反馈；完成审核以当前审核记录为准。</p>' : '') + (checked.issue ? '<p class="reporter-source-note" role="alert">' + esc(INVALID_ROWS) + '</p>' : '') + list.map(function (row) {
      return '<article class="reporter-followup"><b>' + esc(row.title || '同步事项') + '</b><p class="muted">' + origin(row) + '</p><div>' + cfg.richItem(row, 'what') + '</div>'
        + reopenedHtml(row) + '<p>最晚时间：' + esc(row.due || '未设置') + ' · ' + STATUS[state(row.status)] + '</p><div>本期进展：' + cfg.richItem(row, 'progress', '未填写') + '</div></article>';
    }).join('') + '</section>';
  }
  global.ReporterTasks = { configure: configure, pendingHtml:pendingHtml, displayTitle:displayTitle, feedbackFor:currentFeedback, openFeedback:openFeedback, workbenchHtml: workbenchHtml, requirementsHtml: requirementsHtml, renderAdmin: renderAdmin, filterProject: filterProject, filterKind: filterKind, setKind: setKind, loadPeople: loadPeople, retryPeople: retryPeople, formHtml: formHtml, prepare: prepare, capture: capture,
    rows: rows, prepareCoordination: prepareCoordination, syncMeetingRows:syncMeetingRows, syncSavedTask:syncSavedTask, resolveMeeting:resolveMeeting, sourceItems:function(){return sources().map(copy);}, snapshotHtml: snapshotHtml, binding: binding, edit: edit, save: save, cancel: cancel, refreshSources: refreshSources, validationError: validationError };
})(window);

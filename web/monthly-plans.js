/* Confirmed month plans are scoped by commercial module or residential discipline. */
(function (global) {
  'use strict';
  var cfg, S, identity, sessionIdentity, drafts = new Map(), views = new Map(), busy = new Map(), conflicts = new Map(),
    draftReadErrors = new Map(), draftSnapshots = new Map(), recoveringWithdrawals = new Set(), references = new Map(), referenceConflicts = new Map(), lastDraftError = '', serial = 0, editorContext;
  function configure(options) {
    if (identity !== options.S.uid || sessionIdentity !== options.S.session) {
      drafts.clear(); views.clear(); busy.clear(); conflicts.clear(); draftReadErrors.clear(); draftSnapshots.clear(); recoveringWithdrawals.clear(); references.clear(); referenceConflicts.clear(); lastDraftError = ''; editorContext = null;
    }
    cfg = options; S = options.S; identity = S.uid; sessionIdentity = S.session;
  }
  function esc(value) { return cfg.esc(value == null ? '' : value); }
  function memberKey(ids) { return JSON.stringify((ids || []).map(String).slice().sort()); }
  function reportScope() { return S.pmReportScope || null; }
  function professionalScope() { return !!(reportScope() && reportScope().reporting_mode === 'professional'); }
  function planLine() { return reportScope() ? (S.profile || {}).discipline : S.pmLine; }
  function planOwner(plan) { return plan && (plan.owner_id || plan.confirmed_by); }
  function ownPlan(plan) { return planOwner(plan) === S.uid; }
  function matchingScope(plan) {
    var selected = reportScope();
    return selected ? plan.report_scope_id === selected.id && memberKey(plan.scope_project_ids) === memberKey(selected.project_ids)
      : !plan.report_scope_id;
  }
  function enabled() {
    var project = (S.projects || []).filter(function (p) { return p.id === S.pmProject; })[0];
    var selected = reportScope();
    if (selected) return !!(project && project.project_type !== 'com' && (professionalScope() ? S.pmLine === planLine() : S.pmLine === '综合')
      && residentialLines.includes(planLine()) && global.ReportScopes && global.ReportScopes.allowed(selected, S.projects)
      && global.ReportScopes.active(selected, S.pmPeriod, S.pmReport && (S.pmReport.submitted_at || S.pmReport.created_at)));
    return !!(project && S.pmLine && (project.project_type === 'com' || !S.pmReportScope && S.pmLine !== '综合' && S.pmLine === (S.profile || {}).discipline));
  }
  function canConfirm() {
    var profile = S.profile || {};
    var project=(S.projects || []).filter(function(p){return p.id===S.pmProject;})[0];
    return enabled() && profile.role === 'pm' && (project.project_type==='com' ? cfg.canUseBusinessLine?cfg.canUseBusinessLine(S.pmLine,S.pmProject):profile.biz_line === '*' || profile.biz_line === S.pmLine : profile.discipline === planLine());
  }
  function monthOf(date) { return /^\d{4}-(0[1-9]|1[0-2])/.test(String(date || '')) ? String(date).slice(0, 7) : ''; }
  function shiftMonth(value, count) {
    if (!monthOf(value)) return '';
    var parts = value.split('-'), date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1 + count, 1));
    return String(date.getUTCFullYear()).padStart(4, '0') + '-' + String(date.getUTCMonth() + 1).padStart(2, '0');
  }
  function month() {
    var windows = global.PlanningWindows, report = S.pmReport || {}, reference = report.submitted_at || report.created_at;
    var window = cfg.weekWindow && cfg.weekWindow(S.pmPeriod, reference);
    return monthOf(window && window.start || windows && windows.periodStart(S.pmPeriod, reference || windows.todayShanghai()));
  }
  function scope() { var selected = reportScope(); return JSON.stringify([S.uid, S.pmProject, S.pmLine, S.pmPeriod, month()]
    .concat(selected ? [planLine(), selected.id, memberKey(selected.project_ids)] : [])); }
  function draftKey(target) { var selected = reportScope(); return JSON.stringify([S.uid, S.pmProject, planLine(), target]
    .concat(selected ? [selected.id, memberKey(selected.project_ids)] : [])); }
  function nextMonth() { return shiftMonth(month(), 1); }
  function selectedMonth() { return views.get(draftKey(month())) === 'next' ? nextMonth() : month(); }
  function planFor(target) {
    return (S.monthlyPlans || []).filter(function (plan) {
      return plan.project_id === S.pmProject && plan.line === planLine() && monthOf(plan.plan_month) === target && matchingScope(plan) && ownPlan(plan);
    })[0] || null;
  }
  function current() { return enabled() ? planFor(month()) : null; }
  function currentScopePlans() {
    if (!reportScope() || !enabled()) return [];
    var saved = S.pmReport && S.pmReport.biz && S.pmReport.biz.monthly_plan_ids;
    var plans = (S.monthlyPlans || []).filter(function (plan) { return plan.project_id === S.pmProject && (!professionalScope() || plan.line === planLine())
      && (Array.isArray(saved) && saved.length ? saved.includes(plan.id) : !professionalScope() || ownPlan(plan))
      && matchingScope(plan) && monthOf(plan.plan_month) === month(); });
    if (Array.isArray(saved) && saved.length) return saved.map(function (id) { return plans.find(function (plan) { return plan.id === id; }); }).filter(Boolean);
    return plans.slice().sort(function (a, b) { return residentialLines.indexOf(a.line) - residentialLines.indexOf(b.line) || String(a.id).localeCompare(String(b.id)); });
  }
  function scopedLegacyReport() {
    return !!(reportScope() && S.pmReport && !(S.pmReport.biz && Array.isArray(S.pmReport.biz.monthly_plan_ids) && S.pmReport.biz.monthly_plan_ids.length));
  }
  function legacyReport() {
    if (reportScope()) return scopedLegacyReport() ? S.pmReport : null;
    var report = S.pmReport;
    return current() && report && report.project_id === S.pmProject && report.line === S.pmLine
      && !(report.biz && report.biz.monthly_plan_id) ? report : null;
  }
  function needsRefresh(target) { return referenceConflicts.has(draftKey(target || month())) || conflicts.has(draftKey(target || month())) && !planFor(target || month()); }
  function locked() { return reportScope() ? !scopedLegacyReport() && (!!currentScopePlans().length || !!(S.pmReport && S.pmReport.biz && S.pmReport.biz.monthly_plan_ids && S.pmReport.biz.monthly_plan_ids.length)) : !!current() || needsRefresh(); }
  function metadata() {
    if(referenceConflicts.has(draftKey(month())))return {};
    if (reportScope()) {
      if (scopedLegacyReport()) return {};
      var savedIds = S.pmReport && S.pmReport.biz && S.pmReport.biz.monthly_plan_ids;
      if (Array.isArray(savedIds) && savedIds.length) return {monthly_plan_ids:savedIds.slice()};
      var plans = currentScopePlans();
      return plans.length ? { monthly_plan_ids: plans.map(function (plan) { return plan.id; }) } : {};
    }
    var plan = current();
    return plan && !legacyReport() ? { monthly_plan_id: plan.id, monthly_plan_month: monthOf(plan.plan_month) } : {};
  }
  function copy(source, target, mapping) { return cfg.richCopy ? cfg.richCopy(source, target, mapping) : target; }
  function planItem(plan, item, index) {
    var row = { source_id: item.source_id, mod: item.mod || '', name: item.name || '', due: item.due || '' };
    if (plan.report_scope_id) row.monthly_plan_id = plan.id;
    if (item.project_id) row.project_id = item.project_id;
    return copy(plan, row,
      { mod: 'items.' + index + '.mod', name: 'items.' + index + '.name' });
  }
  function rowFingerprint(item) {
    return JSON.stringify([item.monthly_plan_id || '', item.project_id || '', item.source_id || '', item.mod || '', item.name || '', item.due || '', item.prog || '', item.blocker || '', item._rich || null]);
  }
  function itemKey(item) { return item.monthly_plan_id ? JSON.stringify([item.monthly_plan_id, item.source_id || '']) : item.source_id; }
  function referenceToken(plans) { return JSON.stringify(plans.map(function(plan){return plan.id;}).slice().sort()); }
  function planReferences() { var result={},key=draftKey(month());if(references.has(key))result[key]=references.get(key);return result; }
  function referenceChanged(plans) {
    var key=draftKey(month()),token=referenceToken(plans),previous=references.get(key),saved=S.draft;
    if(referenceConflicts.has(key))return true;
    var newerWithoutReference=!previous && S.draftRestored && saved && saved.ts!=null && Number.isFinite(Number(saved.ts)) && plans.some(function(plan){return Date.parse(plan.confirmed_at || '')>Number(saved.ts);})
      && (S.bizItems || []).some(function(item){return item.name || item.prog || item.blocker;});
    if(previous && previous!==token || newerWithoutReference){referenceConflicts.set(key,token);return true;}
    references.set(key,token);return false;
  }
  function acceptUpdated() {
    var key=draftKey(month());if(!referenceConflicts.has(key) || !enabled())return;
    flush();var plans=reportScope()?currentScopePlans():current()?[current()]:[];if(!plans.length)return;
    preserveUnmatched(S.bizItems || [],[]);S.bizItems=[];references.set(key,referenceToken(plans));referenceConflicts.delete(key);apply();
    if(cfg.saveFormDraft && !cfg.saveFormDraft(true))cfg.toast('原输入已保留在当前页面，请先复制或保存本机草稿。','err');
    cfg.render();
  }
  function preserveUnmatched(items, baseline) {
    var ids = new Set(baseline.map(itemKey).filter(Boolean));
    var originals = new Set(baseline.map(rowFingerprint)), retained = Array.isArray(S.monthlyUnmatchedItems) ? S.monthlyUnmatchedItems : [];
    var seen = new Set(retained.map(rowFingerprint));
    items.forEach(function (item) {
      if (item.source_id && ids.has(itemKey(item)) || originals.has(rowFingerprint(item))) return;
      if (![item.mod, item.name, item.due, item.prog, item.blocker].some(function (value) { return String(value || '').trim(); })) return;
      var row = copy(item, JSON.parse(JSON.stringify(item))), key = rowFingerprint(row);
      if (!seen.has(key)) { retained.push(row); seen.add(key); }
    });
    S.monthlyUnmatchedItems = retained;
  }
  function apply() {
    if (reportScope()) {
      if (!enabled() || scopedLegacyReport()) return false;
      var plans = currentScopePlans(), savedIds = S.pmReport && S.pmReport.biz && S.pmReport.biz.monthly_plan_ids;
      if (!plans.length || Array.isArray(savedIds) && savedIds.length !== plans.length) return false;
      if(referenceChanged(plans))return false;
      var baseline = plans.flatMap(function (plan) { return (plan.items || []).map(function (item, index) { return planItem(plan, item, index); }); });
      var previous = S.bizItems || [], feedback = new Map(previous.map(function (row) { return [itemKey(row), row]; }));
      preserveUnmatched(previous, baseline);
      S.bizItems = baseline.map(function (row) { var saved = feedback.get(itemKey(row)) || {};
        row.prog = saved.prog || ''; row.blocker = saved.blocker || ''; return copy(saved, row, {prog:'prog', blocker:'blocker'}); });
      return true;
    }
    var plan = current(), legacy = legacyReport();
    if (!plan) return false;
    if(!legacy && referenceChanged([plan]))return false;
    var baseline = legacy ? legacy.biz && legacy.biz.items || [] : plan.items || [], feedback = new Map(), previous = S.bizItems || [];
    previous.forEach(function (item) { if (item.source_id) feedback.set(itemKey(item), item); });
    preserveUnmatched(previous, baseline);
    S.bizItems = baseline.map(function (item, index) {
      var row = legacy ? copy(legacy, { source_id: item.source_id, mod: item.mod || '', name: item.name || '', due: item.due || '' },
        { mod: 'biz.items.' + index + '.mod', name: 'biz.items.' + index + '.name' }) : planItem(plan, item, index);
      var saved = feedback.get(itemKey(item)) || (legacy ? item : {});
      row.prog = saved.prog || ''; row.blocker = saved.blocker || '';
      if (legacy && saved === item) return copy(legacy, row,
        { prog: 'biz.items.' + index + '.prog', blocker: 'biz.items.' + index + '.blocker' });
      return copy(saved, row, { prog: 'prog', blocker: 'blocker' });
    });
    return true;
  }
  function prepare() {
    if(!enabled())return false;
    var key=draftKey(month()),saved=S.draft && S.draft.monthlyPlanReferences;
    if(saved && typeof saved[key]==='string')references.set(key,saved[key]);
    return apply();
  }
  function storageKey(key) { return 'zh_monthly_plan_draft_v1_' + encodeURIComponent(key); }
  function rememberDraft(key, rows, raw) { draftSnapshots.set(key,{rows:JSON.stringify(rows),raw:raw});return rows; }
  function readDraft(key) {
    try {
      var raw = global.localStorage.getItem(storageKey(key));
      if (!raw) return rememberDraft(key,[{ mod: '', name: '', due: '' }],raw);
      var saved = JSON.parse(raw);
      if (!saved || saved.v !== 1 || JSON.stringify(saved.scope) !== key || !Array.isArray(saved.items)
        || saved.items.some(function (row) { return !row || typeof row !== 'object' || ['mod', 'name', 'due'].some(function (field) { return typeof row[field] !== 'string'; }); }))
        throw new Error('下月本机草稿格式无法读取。');
      return rememberDraft(key,saved.items,raw);
    } catch (error) {
      lastDraftError = '下月本机草稿读取失败，原存储内容未覆盖；请复制当前输入并刷新页面重试。';
      draftReadErrors.set(key, lastDraftError);
      return [{ mod: '', name: '', due: '' }];
    }
  }
  function draftRows(target) {
    var key = draftKey(target);
    if (!drafts.has(key)) drafts.set(key, readDraft(key));
    return drafts.get(key);
  }
  function nextRows() { return draftRows(nextMonth()); }
  function aiClone(value) { return JSON.parse(JSON.stringify(value)); }
  function aiRows(target) { return target === month() && !reportScope() ? S.bizItems || [] : drafts.has(draftKey(target)) ? drafts.get(draftKey(target)) : readDraft(draftKey(target)); }
  function aiSnapshot(target) {
    var key = draftKey(target), raw = global.localStorage.getItem(storageKey(key));
    if (draftReadErrors.has(key)) throw new Error(draftReadErrors.get(key));
    return JSON.stringify([scope(), target, aiRows(target), raw]);
  }
  function aiContext() {
    if (!canConfirm() || (S.profile || {}).status !== 'approved') return [];
    capture();
    return [month(), nextMonth()].filter(function(target) { return target && !planFor(target) && !needsRefresh(target) && !busy.has(draftKey(target)); }).map(function(target) {
      return {month:target, items:aiRows(target).filter(function(row) { return row.name || row.mod || row.due || row.prog; }).map(function(row) {
        return {mod:String(row.mod || ''), name:String(row.name || ''), due:String(row.due || ''), progress:String(row.prog || '')};
      }), signature:aiSnapshot(target)};
    });
  }
  function aiApply(context, candidate) {
    var target = candidate && candidate.month, before = (context.monthly_plans || []).find(function(plan) { return plan.month === target; });
    var current = aiContext().find(function(plan) { return plan.month === target; });
    if (!before || !current || before.signature !== current.signature) throw new Error('月计划已修改、已确认或范围变化，请重新整理；原草稿已保留。');
    if (!Array.isArray(candidate.items) || !candidate.items.length || candidate.items.length > 200) throw new Error('没有可加入的月计划事项。');
    var rows = aiRows(target), original = aiClone(rows), next = aiClone(rows), seen = new Set(), added = 0;
    function itemKey(row) { return JSON.stringify([String(row.mod || '').trim(), String(row.name || '').trim(), row.due || '']); }
    rows.forEach(function(row) { if (row.name) seen.add(itemKey(row)); });
    candidate.items.forEach(function(item) {
      if (!item || ['mod','name','due','progress'].some(function(field) { return typeof item[field] !== 'string'; })
        || !item.name.trim() || item.name.length > 10000 || item.mod.length > 200 || item.progress.length > 6000) throw new Error('月计划内容不完整，请重新整理。');
      if (item.due && (!/^\d{4}-\d{2}-\d{2}$/.test(item.due) || !Number.isFinite(Date.parse(item.due+'T12:00:00Z')) || new Date(item.due+'T12:00:00Z').toISOString().slice(0,10) !== item.due)) throw new Error('完成时间无效，请先核对。');
      var key = itemKey(item); if (seen.has(key)) return; seen.add(key);
      next.push({source_id:stableId(), mod:item.mod, name:item.name, due:item.due, prog:item.progress, blocker:''}); added++;
    });
    if (!added) return {count:0, message:'这些事项已在月计划草稿中，未重复添加。'};
    next = next.filter(function(row) { return row.name || row.mod || row.due || row.prog || row.blocker || row._rich && Object.keys(row._rich).some(function(field){return (row._rich[field].ops || []).some(function(op){return typeof op.insert==='string' && op.insert.trim();});}); });
    if(next.length > 500) throw new Error('月计划合计超过500项，请分批核对后再加入。');
    var raw = global.localStorage.getItem(storageKey(draftKey(target))), normal = target === month() && !reportScope(), hadDraft=drafts.has(draftKey(target));
    function assign(value) { if (normal) S.bizItems = aiClone(value); else drafts.set(draftKey(target), aiClone(value)); }
    editorContext = null;
    try {
      assign(next);
      if (normal) { if (!cfg.saveFormDraft || !cfg.saveFormDraft(false,true)) throw new Error('本机草稿保存失败。'); }
      else {var savedRaw=JSON.stringify({v:1, scope:JSON.parse(draftKey(target)), items:next, ts:new Date().toISOString()});global.localStorage.setItem(storageKey(draftKey(target)),savedRaw);rememberDraft(draftKey(target),next,savedRaw);}
    } catch (error) {
      assign(original);
      if(!normal && !hadDraft){drafts.delete(draftKey(target));draftSnapshots.delete(draftKey(target));}
      throw new Error('月计划草稿保存失败，原输入已保留。'+(error.message || ''));
    }
    views.set(draftKey(month()), target === nextMonth() ? 'next' : 'current');
    return {count:added, message:'已加入 '+added+' 项到 '+target+' 月计划本机草稿，原输入保留；尚未确认月计划或提交周报。',
      transaction:{kind:'monthly_plan', scope:scope(), month:target, before:original, beforeRaw:raw, hadDraft:hadDraft, after:aiSnapshot(target)}};
  }
  function aiUndo(transaction) {
    var target = transaction && transaction.month, current = aiContext().find(function(plan) { return plan.month === target; });
    if (!transaction || transaction.kind !== 'monthly_plan' || transaction.scope !== scope() || !current || current.signature !== transaction.after) throw new Error('月计划已有后续修改、已确认或范围变化，不能直接撤销。');
    var normal = target === month() && !reportScope(), after = aiClone(aiRows(target));
    editorContext = null;
    if (normal) S.bizItems = aiClone(transaction.before); else drafts.set(draftKey(target), aiClone(transaction.before));
    try {
      if (normal) { if (!cfg.saveFormDraft || !cfg.saveFormDraft(false,true)) throw new Error('本机草稿保存失败。'); }
      else if (transaction.beforeRaw == null) global.localStorage.removeItem(storageKey(draftKey(target)));
      else global.localStorage.setItem(storageKey(draftKey(target)), transaction.beforeRaw);
      if(!normal)rememberDraft(draftKey(target),transaction.before,transaction.beforeRaw);
      if(!normal && !transaction.hadDraft){drafts.delete(draftKey(target));draftSnapshots.delete(draftKey(target));}
    } catch (error) {
      if (normal) S.bizItems = after; else drafts.set(draftKey(target), after);
      throw new Error('撤销保存失败，当前草稿保留。');
    }
    return {message:'已撤销这次月计划新增，未确认或提交计划。'};
  }
  function aiView(target) {
    if(!enabled() || ![month(),nextMonth()].includes(target))return;
    views.set(draftKey(month()), target===nextMonth()?'next':'current');cfg.render();
  }
  function editorMonth() { return reportScope() ? selectedMonth() : nextMonth(); }
  function saveDraft() {
    if (!cfg || !S || !S.uid) return true;
    capture(); lastDraftError = '';
    try {
      drafts.forEach(function (items, key) {
        var parsed = JSON.parse(key);
        if (parsed[0] !== S.uid) return;
        if (draftReadErrors.has(key)) throw new Error(draftReadErrors.get(key));
        var previous=draftSnapshots.get(key);
        if(previous && previous.rows===JSON.stringify(items))return;
        var raw=global.localStorage.getItem(storageKey(key));
        if(previous ? raw!==previous.raw : raw!=null)throw new Error('其他窗口已修改月计划草稿，原存储未覆盖；请先保留当前输入并重新读取。');
        var nextRaw=JSON.stringify({ v: 1, scope: parsed, items: items, ts: new Date().toISOString() });
        global.localStorage.setItem(storageKey(key),nextRaw);rememberDraft(key,items,nextRaw);
      });
      return true;
    } catch (error) {
      lastDraftError = error && error.message || '下月本机草稿保存失败。';
      return false;
    }
  }
  function draftError() { return lastDraftError; }
  function discardDraft(target, expectedRaw) {
    var key = draftKey(target);
    try {
      if(global.localStorage.getItem(storageKey(key))!==expectedRaw){drafts.delete(key);draftReadErrors.delete(key);draftSnapshots.delete(key);return;}
      global.localStorage.removeItem(storageKey(key));drafts.delete(key);draftReadErrors.delete(key);draftSnapshots.delete(key);
    }
    catch (error) { lastDraftError = '月计划已确认，但旧本机草稿清理失败；以确认版为准。'; cfg.toast(lastDraftError, 'err'); }
  }
  function capture() {
    if (!cfg || !global.document || !editorContext || editorContext.scope !== scope() || editorContext.session !== S.session
      || selectedMonth() !== editorContext.month || planFor(editorContext.month)) return;
    draftRows(editorContext.month).forEach(function (row, index) {
      ['mod', 'name', 'due'].forEach(function (field) {
        var input = global.document.getElementById('monthly_next_' + field + '_' + index);
        if (input) row[field] = String(input.value || '');
      });
    });
  }
  function flush() { if (cfg.flush) cfg.flush(); capture(); }
  function binding(id) {
    var match = /^monthly_next_(mod|name)_(\d+)$/.exec(id);
    if (!match || !enabled() || !editorContext || selectedMonth() !== editorContext.month
      || editorContext.scope !== scope() || editorContext.session !== S.session) return null;
    var field = match[1], index = Number(match[2]), row = draftRows(editorContext.month)[index], context = editorContext;
    if (!row) return null;
    return { get: function () { return global.ZHRichText && global.ZHRichText.doc(row, field); }, set: function (doc) {
      if (editorContext !== context || context.scope !== scope() || context.session !== S.session
        || !canConfirm() || selectedMonth() !== context.month || planFor(context.month) || needsRefresh(context.month)
        || busy.has(draftKey(context.month)) || draftRows(context.month)[index] !== row) return;
      row[field] = global.ZHRichText.text(doc); row._rich = row._rich || {}; row._rich[field] = doc;
    } };
  }
  function select(which) {
    flush(); views.set(draftKey(month()), which === 'next' ? 'next' : 'current'); cfg.render();
  }
  function edit(index, field, value) {
    if (!editorContext || editorContext.scope !== scope() || editorContext.session !== S.session || selectedMonth() !== editorContext.month) return;
    var target = editorContext.month;
    if (!canConfirm() || planFor(target) || needsRefresh(target) || busy.has(draftKey(target)) || !['mod', 'name', 'due'].includes(field)) return;
    var row = draftRows(target)[index]; if (row) row[field] = String(value || '');
  }
  function addNext() {
    var target = editorMonth();
    if (!canConfirm() || planFor(target) || needsRefresh(target) || busy.has(draftKey(target))) return;
    flush(); draftRows(target).push({ mod: '', name: '', due: '' }); cfg.render();
  }
  function removeNext(index) {
    var target = editorMonth();
    if (!canConfirm() || planFor(target) || needsRefresh(target) || busy.has(draftKey(target))) return;
    flush(); draftRows(target).splice(index, 1); cfg.render();
  }
  function stableId() {
    return global.crypto && global.crypto.randomUUID ? global.crypto.randomUUID()
      : 'monthly_' + Date.now().toString(36) + '_' + (++serial) + '_' + Math.random().toString(36).slice(2);
  }
  function payloadRows(rows) {
    var result = [], invalid = false;
    rows.forEach(function (row, index) {
      var name = String(row.name || '').trim(), mod = String(row.mod || '').trim(), due = row.due || '';
      if (!name && !mod && !due) return;
      if (!name) { invalid = true; cfg.toast('请填写第' + (index + 1) + '项的事项。', 'err'); return; }
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(row.source_id || '')) row.source_id = stableId();
      var item = {source_id:row.source_id, mod:mod, name:name, due:due};
      if (reportScope() && row.project_id) item.project_id = row.project_id;
      result.push(copy(row, item, { mod: 'mod', name: 'name' }));
    });
    return invalid ? null : result;
  }
  function sameConfirmation(plan,payload) {
    function items(rows){return (rows || []).map(function(row){return [row.source_id || '',row.mod || '',row.name || '',row.due || '',row.project_id || ''];});}
    function formatting(rich){var fields=rich && rich.fields || {};return Object.keys(fields).sort().map(function(key){return [key,(fields[key].ops || []).map(function(op){return [op.insert,!!(op.attributes && op.attributes.bold),op.attributes && op.attributes.color || ''];})];});}
    return ownPlan(plan) && JSON.stringify(items(plan.items))===JSON.stringify(items(payload.items)) && JSON.stringify(formatting(plan.rich_text))===JSON.stringify(formatting(payload.rich_text));
  }
  function stillHere(token) { return identity === token.uid && sessionIdentity === token.session && S.uid === token.uid && S.session === token.session && scope() === token.scope; }
  async function reloadConfirmed(token, target) {
    if (!cfg.loadData) return false;
    await cfg.loadData(['monthlyPlans', 'completions'], true);
    if (!stillHere(token)) return false;
    flush();
    if (!planFor(target)) return false;
    conflicts.delete(token.key);
    if (target === month()) apply();
    return true;
  }
  async function resolveConflict(token, target) {
    conflicts.set(token.key, true);
    try {
      if (await reloadConfirmed(token, target)) {
        cfg.toast(target + '月计划已确认，已读取确认版。', 'success'); return true;
      }
    } catch (error) { /* The server already confirmed this scope; keep the local input until rereading succeeds. */ }
    if (stillHere(token)) { flush(); cfg.toast('该月计划已经确认，暂未能读取确认版；原输入已保留，请点击重新读取。', 'err'); }
    return false;
  }
  async function confirm(which) {
    if (!canConfirm()) return false;
    flush();
    var target = which === 'next' ? nextMonth() : month(), key = draftKey(target);
    if (!target || busy.has(key) || planFor(target)) return false;
    if (needsRefresh(target)) {
      var readToken = { uid: S.uid, session: S.session, scope: scope(), key: key };
      busy.set(key, readToken); cfg.render();
      try { return await resolveConflict(readToken, target); }
      finally {
        if (busy.get(key) === readToken) busy.delete(key);
        if (stillHere(readToken)) cfg.render();
      }
    }
    var items = payloadRows(reportScope() ? draftRows(target) : which === 'next' ? nextRows() : S.bizItems || []);
    if (!items) return false;
    if (!items.length) { cfg.toast('请先填写月计划事项。', 'err'); return false; }
    var payload = { project_id: S.pmProject, line: planLine(), month: target, items: items };
    if (reportScope()) payload.report_scope_id = reportScope().id;
    if (cfg.richCollect) payload = cfg.richCollect(payload);
    var token = { uid: S.uid, session: S.session, scope: scope(), key: key };
    try{token.draftRaw=global.localStorage.getItem(storageKey(key));token.draftRawReadable=true;}catch(error){token.draftRawReadable=false;}
    busy.set(key, token); cfg.render();
    try {
      var result = await cfg.request('/api/monthly-plans/confirm', payload);
      if (!stillHere(token)) return false;
      flush();
      if (!result || result.error || !result.data) {
        if (result && result.error && result.error.code === 'monthly_plan_confirmed') return await resolveConflict(token, target);
        cfg.toast(result && result.error && result.error.message || '月计划确认失败，请稍后重试。', 'err'); return false;
      }
      var plan = result.data;
      S.monthlyPlans = (S.monthlyPlans || []).filter(function (row) { return row.id !== plan.id; }).concat([plan]);
      if(target===month()){references.set(draftKey(target),referenceToken(reportScope()?currentScopePlans():[plan]));referenceConflicts.delete(draftKey(target));}
      if (target === month()) apply();
      if(sameConfirmation(plan,payload) && token.draftRawReadable)discardDraft(target,token.draftRaw);
      try { await reloadConfirmed(token, target); } catch (error) { if (stillHere(token)) flush(); }
      if (!stillHere(token)) return false;
      if (!planFor(target)) S.monthlyPlans = (S.monthlyPlans || []).concat([plan]);
      if (target === month()) apply();
      cfg.toast(target + '月计划已确认；之后每周填写进展和卡点。', 'success');
      return true;
    } catch (error) {
      if (stillHere(token)) flush();
      if (stillHere(token) && error && error.code === 'monthly_plan_confirmed') return await resolveConflict(token, target);
      if (stillHere(token)) cfg.toast(error && error.message || '月计划确认失败，请稍后重试。', 'err');
      return false;
    } finally {
      if (busy.get(key) === token) busy.delete(key);
      if (stillHere(token)) cfg.render();
    }
  }
  function confirmCurrent() { return confirm('current'); }
  function confirmNext() { return confirm('next'); }
  function canWithdraw(plan) { return !!(plan && canConfirm() && ownPlan(plan)); }
  function withdrawButton(plan, which) {
    if (!canWithdraw(plan)) return '';
    return '<button type="button" class="btn sm" onclick="MonthlyPlans.withdraw' + (which === 'next' ? 'Next' : 'Current') + '()"'
      + (busy.has(draftKey(monthOf(plan.plan_month))) ? ' disabled' : '') + '>撤回确认并修改</button>';
  }
  async function withdraw(which) {
    var target = which === 'next' ? nextMonth() : month(), plan = planFor(target), key = draftKey(target);
    if (!canWithdraw(plan) || busy.has(key)) return false;
    flush();
    if (!global.confirm('撤回 ' + target + ' 月计划确认并恢复为可编辑草稿？修改后需要重新确认。已有周报或申报引用的计划不能撤回。')) return false;
    var token = { uid: S.uid, session: S.session, scope: scope(), key: key };
    var rawBefore=null,hadDraft=drafts.has(key),draftBefore=hadDraft?JSON.parse(JSON.stringify(drafts.get(key))):null,originalRows=[];
    try{rawBefore=global.localStorage.getItem(storageKey(key));}catch(error){cfg.toast('原本机草稿读取失败，尚未撤回；请先保留原文。','err');return false;}
    if(hadDraft)originalRows=draftBefore;else if(rawBefore!=null)originalRows=readDraft(key);
    var hasOriginal=originalRows.some(function(row){return row.name || row.mod || row.due;});
    function restoreOriginal(){
      if(!stillHere(token))return;
      if(hadDraft)drafts.set(key,draftBefore);else drafts.delete(key);
      try{if(rawBefore==null)global.localStorage.removeItem(storageKey(key));else global.localStorage.setItem(storageKey(key),rawBefore);}
      catch(error){cfg.toast('原草稿仍在当前页面，恢复本机保存失败，请先复制原内容。','err');}
      if(hadDraft)rememberDraft(key,draftBefore,rawBefore);else draftSnapshots.delete(key);
      recoveringWithdrawals.delete(key);
    }
    // Keep a recovery copy before sending the request: an interrupted response
    // must not strand the original next-month input after a successful withdrawal.
    if (which === 'next' || reportScope()) {
      recoveringWithdrawals.add(key); drafts.set(key,hasOriginal?originalRows:(plan.items || []).map(function(item,index){return planItem(plan,item,index);}));
      if (!saveDraft()) { restoreOriginal(); cfg.toast('本机恢复草稿未能保存，尚未撤回；请先复制计划内容后重试。','err'); return false; }
    }
    if (which !== 'next' && cfg.saveFormDraft && !cfg.saveFormDraft(true)) {
      restoreOriginal();
      cfg.toast('本机恢复草稿未能保存，尚未撤回；请先复制当前填报内容后重试。','err'); return false;
    }
    busy.set(key,token); cfg.render();
    try {
      var payload={project_id:S.pmProject,line:planLine(),month:target,expected_plan_id:plan.id};
      if(reportScope())payload.report_scope_id=reportScope().id;
      var result = await cfg.request('/api/monthly-plans/withdraw',payload);
      if (!stillHere(token)) return false;
      flush();
      if (!result || result.error || !result.data || !result.data.withdrawn || result.data.plan.id !== plan.id) {
        if(hasOriginal || result && result.error && ['monthly_plan_in_use','monthly_plan_forbidden','invalid_monthly_plan','monthly_plan_changed'].includes(result.error.code))restoreOriginal();
        if(result && result.error && result.error.code==='monthly_plan_changed' && cfg.loadData)await cfg.loadData(['monthlyPlans','completions'],true);
        if(stillHere(token))cfg.toast(result && result.error && result.error.code && result.error.message || '撤回结果暂未确认，原内容已保留；请重新读取或重试。','err');
        return false;
      }
      S.monthlyPlans=(S.monthlyPlans || []).filter(function(row){return row.id!==plan.id;});
      references.delete(key);referenceConflicts.delete(key);
      conflicts.delete(key); draftReadErrors.delete(key); recoveringWithdrawals.delete(key);
      if(hasOriginal && (which==='next' || reportScope()) && cfg.saveFormDraft){preserveUnmatched(originalRows,[]);drafts.set(key,(plan.items || []).map(function(item,index){return planItem(plan,item,index);}));}
      if(which!=='next' && !reportScope() && !S.bizItems.length)S.bizItems=(plan.items || []).map(function(item,index){return planItem(plan,item,index);});
      if(reportScope())apply();
      var saved=cfg.saveFormDraft ? cfg.saveFormDraft(true) : saveDraft();
      if(!saved && hasOriginal)restoreOriginal();
      cfg.toast(saved ? target+' 月计划确认已撤回，原内容已恢复为草稿；修改后请重新确认。' : '确认已撤回，原内容仍在当前页面；本机草稿保存失败，请先复制内容。',saved?'success':'err');
      return true;
    } catch(error) {
      if(hasOriginal)restoreOriginal();
      if(stillHere(token))cfg.toast('撤回结果暂未确认，原内容已保留；请重新读取或重试。','err');
      return false;
    } finally {
      if(busy.get(key)===token)busy.delete(key);
      if(stillHere(token))cfg.render();
    }
  }
  function withdrawCurrent() { return withdraw('current'); }
  function withdrawNext() { return withdraw('next'); }
  function toolbarHtml() {
    if (!enabled()) return '';
    var plan = current(), legacy = legacyReport(), next = selectedMonth() === nextMonth(), working = busy.has(draftKey(month()));
    var selected = reportScope(), savedIds = S.pmReport && S.pmReport.biz && S.pmReport.biz.monthly_plan_ids;
    var incomplete = selected && Array.isArray(savedIds) && savedIds.length && currentScopePlans().length !== savedIds.length;
    return '<div class="monthly-plan-toolbar">'
      + '<div class="actions"><button type="button" aria-pressed="'+(!next)+'" class="btn' + (!next ? ' primary' : '') + '" onclick="MonthlyPlans.select(\'current\')">本月 ' + esc(month()) + '</button>'
      + '<button type="button" aria-pressed="'+next+'" class="btn' + (next ? ' primary' : '') + '" onclick="MonthlyPlans.select(\'next\')">准备下月 ' + esc(nextMonth()) + '</button>'
      + (!selected && !plan && canConfirm() ? '<button type="button" class="btn primary" onclick="MonthlyPlans.confirmCurrent()"' + (working ? ' disabled' : '') + '>' + (needsRefresh() ? working ? '读取中…' : '重新读取本月确认版' : working ? '确认中…' : '确认本月计划') + '</button>' : '')
      + (!next ? withdrawButton(plan,'current') : '')
      + '</div><p class="muted">' + (selected ? '本专业：'+esc(planLine())+(professionalScope()?'。本专业独立编制月计划和提报本周进展。':'。各专业分别编制月计划，本周综合报告仍共用原入口。') : '')
      + (plan ? legacy ? '既有周报快照，计划列保持原样；每周填写进展和卡点。' : esc(month()) + ' 月计划已确认 · ' + esc(plan.confirmed_by_name || plan.confirmed_name || '') + (plan.confirmed_at ? ' · ' + esc(plan.confirmed_at) : '') : needsRefresh() ? '该月计划已经确认，确认版尚未读到；原输入已保留，请重新读取。' : esc(month()) + ' 月计划尚未确认，确认前可编辑。') + '</p>'
      + (selected ? '<p class="muted">月底可汇报本月完成情况，同时准备下月计划；切换只改变计划编制区，不覆盖下方'+(professionalScope()?'本专业':'综合')+'进展和本机草稿。'
        + (scopedLegacyReport() ? '本周已有报告保持原计划快照，确认月计划不会自动改绑。' : S.pmReport ? '已提交'+(professionalScope()?'本专业':'综合')+'报告保留原计划范围，后确认的专业计划不会改写该期报告。' : '')+'</p>' : '')
      + (incomplete ? '<p class="notice warn" role="alert">本周引用的专业月计划尚未完整读取，原进展已保留；请刷新确认权限后再提交。</p>' : '')
      + (referenceConflicts.has(draftKey(month()))?'<p class="notice warn" role="alert">月计划版本已更新，当前原草稿及反馈保留，尚未绑定新计划。请核对后读取最新计划。<button type="button" class="btn" onclick="MonthlyPlans.acceptUpdated()">保留原草稿并读取最新计划</button></p>':'')
      + retainedDraftHtml(selectedMonth(),planFor(selectedMonth())) + unmatchedHtml() + '</div>';
  }
  function itemName(record, path, fallback) { return cfg.richItem ? cfg.richItem(record, path, fallback) : esc(fallback); }
  function retainedDraftHtml(target, plan) {
    if(!plan)return '';
    var key=draftKey(target),raw=null;
    try{raw=global.localStorage.getItem(storageKey(key));}catch(error){return '<p class="notice warn">本机原月计划草稿读取失败，原数据未清除，请保留原文核对。</p>';}
    if(!drafts.has(key) && raw==null)return '';
    var rows=drafts.has(key)?drafts.get(key):readDraft(key);
    if(!rows.some(function(row){return row.name || row.mod || row.due;}))return '';
    return '<details class="monthly-unmatched-items"><summary>'+esc(target)+' 本机未提交的原月计划草稿（只读保留）</summary><p class="muted">服务器已有确认计划，以下原输入保留供核对，不会自动合并或覆盖。</p>'
      +rows.map(function(row){return '<article><b>'+itemName(row,'mod',row.mod || '未填写模块')+'</b><div>'+itemName(row,'name',row.name || '未填写事项')+'</div><span>'+esc(row.due || '未设日期')+'</span></article>';}).join('')
      +(raw!=null?'<details><summary>原草稿备份</summary><textarea readonly rows="6" aria-label="原月计划草稿备份">'+esc(raw)+'</textarea></details>':'')+'</details>';
  }
  function unmatchedHtml() {
    var rows = Array.isArray(S.monthlyUnmatchedItems) ? S.monthlyUnmatchedItems : [];
    return rows.length ? '<aside class="monthly-unmatched-items"><h4>未匹配的原草稿，已保留供核对</h4><p class="muted">月计划内容或版本有变化时，原事项及进展保留在这里，不会自动填入新事项；请核对后在当前计划中填写反馈。</p>' + rows.map(function (row) {
      return '<article><b>' + itemName(row, 'name', row.name || '未填写事项') + '</b><div class="muted">原模块：' + esc(row.mod || '未填写')
        + ' · 完成时间：' + esc(row.due || '未填写') + '</div><div>进展：' + itemName(row, 'prog', row.prog || '未填写')
        + '</div><div>卡点：' + itemName(row, 'blocker', row.blocker || '未填写') + '</div></article>';
    }).join('') + '</aside>' : '';
  }
  function plannerHtml() {
    if (!enabled()) return '';
    var target = selectedMonth(), next = target === nextMonth();
    var ownPlan = planFor(target), savedIds = S.pmReport && S.pmReport.biz && S.pmReport.biz.monthly_plan_ids;
    var visibleInReport = ownPlan && (!S.pmReport || Array.isArray(savedIds) && savedIds.includes(ownPlan.id));
    if (!next && (!reportScope() || visibleInReport)) return '';
    var plan = planFor(target), working = busy.has(draftKey(target)), awaiting = needsRefresh(target), editable = !plan && !awaiting && canConfirm() && !working;
    var rows = plan ? plan.items || [] : draftRows(target);
    editorContext = { scope: scope(), session: S.session, month:target };
    return '<section class="card plan-form-section monthly-next-plan" data-plan-month="'+esc(target)+'" data-plan-line="'+esc(planLine())+'" data-plan-scope="'+esc(reportScope() && reportScope().id || '')+'"><div class="cardhd"><h3>' + esc(target) + (next ? ' 下月计划' : ' 本月专业计划')
      + (reportScope() ? ' · '+esc(planLine()) : '')+'</h3><div class="actions"><span>' + (plan ? '已确认，固定列不可修改' : '待确认') + '</span>' + withdrawButton(plan,next?'next':'current') + '</div></div>'
      + '<div class="cardbody">' + (draftReadErrors.has(draftKey(target)) ? '<p class="muted" role="alert">' + esc(draftReadErrors.get(draftKey(target))) + '</p>' : '')
      + '<div class="tablewrap"><table class="plan-form-table"><thead><tr><th>模块</th><th>事项</th><th>完成时间</th>' + (!plan ? '<th>操作</th>' : '') + '</tr></thead><tbody>'
      + rows.map(function (row, index) {
        if (plan) return '<tr><td data-label="模块">' + itemName(plan, 'items.' + index + '.mod', row.mod) + '</td><td data-label="事项">' + itemName(plan, 'items.' + index + '.name', row.name) + '</td><td data-label="完成时间">' + esc(row.due || '未设置') + '</td></tr>';
        return '<tr><td data-label="模块"><input data-rich id="monthly_next_mod_' + index + '" aria-label="第' + (index + 1) + '项模块" value="' + esc(row.mod) + '" oninput="MonthlyPlans.edit(' + index + ',\'mod\',this.value)"' + (!editable ? ' disabled' : '') + '></td>'
          + '<td data-label="事项"><textarea data-rich id="monthly_next_name_' + index + '" aria-label="第' + (index + 1) + '项事项" rows="2" oninput="MonthlyPlans.edit(' + index + ',\'name\',this.value)"' + (!editable ? ' disabled' : '') + '>' + esc(row.name) + '</textarea></td>'
          + '<td data-label="完成时间"><input type="date" id="monthly_next_due_' + index + '" aria-label="第' + (index + 1) + '项完成时间" value="' + esc(row.due) + '" oninput="MonthlyPlans.edit(' + index + ',\'due\',this.value)"' + (!editable ? ' disabled' : '') + '></td>'
          + '<td data-label="操作"><button type="button" class="btn" onclick="MonthlyPlans.removeNext(' + index + ')"' + (!editable ? ' disabled' : '') + '>删除</button></td></tr>';
      }).join('') + '</tbody></table></div>'
      + (!plan && canConfirm() ? '<div class="actions">' + (!awaiting ? '<button type="button" class="btn" onclick="MonthlyPlans.addNext()"' + (working ? ' disabled' : '') + '>添加事项</button>' : '<p class="muted">该月计划已经确认，原输入已保留，请重新读取确认版。</p>')
        + '<button type="button" class="btn primary" onclick="MonthlyPlans.confirm'+(next?'Next':'Current')+'()"' + (working ? ' disabled' : '') + '>' + (awaiting ? working ? '读取中…' : '重新读取'+(next?'下':'本')+'月确认版' : working ? '确认中…' : '确认'+(next?'下':'本')+'月计划') + '</button></div>' : '')
      + '</div></section>';
  }
  function sourceKey(plan, item) { return 'monthly:' + plan.project_id + ':' + plan.id + ':' + item.source_id; }
  // Read-only rows for confirmed plans without this week's report. They are
  // never saved as submitted reports or counted as a person's submission.
  var residentialLines = ['开发报建','设计','工程','成本','招采','营销','商管运营','客服','财务'];
  function residentialLine(report, people) {
    if (report.line && report.line !== '综合') return report.line;
    var author = !report.report_scope_id && (people || []).find(function(person) { return person.user_id === report.author_id; });
    return author && author.discipline || '__unassigned__';
  }
  // A view over saved rows: filtering never changes reports, item identities or rich-text indices.
  function residentialReports(reports, line, people, plans) {
    if (!line) return (reports || []).slice();
    return (reports || []).map(function(report) {
      var base = residentialLine(report, people), matches = base === line, found = false;
      function selected(rows) {
        return (rows || []).filter(function(item) {
          var refs = report.biz && report.biz.monthly_plan_ids;
          var plan = item && item.monthly_plan_id && Array.isArray(refs) && refs.includes(item.monthly_plan_id)
            && (plans || []).find(function (entry) { return entry.id === item.monthly_plan_id && entry.report_scope_id === report.report_scope_id
              && memberKey(entry.scope_project_ids) === memberKey(report.scope_project_ids); });
          var own = plan ? plan.line : item && item.monthly_plan_id ? '__unassigned__' : item && (item.discipline || (residentialLines.indexOf(item.mod) >= 0 ? item.mod : ''));
          var keep = (own || base) === line;
          found = found || keep; return keep;
        });
      }
      var copy = Object.assign({}, report), biz = Object.assign({}, report.biz);
      ['items','handover','followups'].forEach(function(key) { if (Array.isArray(biz[key])) biz[key] = selected(biz[key]); });
      ['coord_items','node_items','speed_items','effect_items','commit_items'].forEach(function(key) {
        if (Array.isArray(copy[key])) copy[key] = selected(copy[key]);
      });
      if (!matches) {
        ['coord','change_text','dev_text','projection','impact','decision','node_name','node_plan','node_forecast','self_speed','self_effect'].forEach(function(key) { copy[key] = ''; });
        copy.next_items = []; biz.attachments = [];
      }
      copy.biz = biz;
      if (global.ZHRichText) global.ZHRichText.copy(report, copy);
      return matches || found ? copy : null;
    }).filter(Boolean);
  }
  function projectReports(options) {
    var reports=(options.reports || []).slice();
    if(options.includeUnsubmitted===false)return reports;
    (options.plans || []).forEach(function(plan){
      var scoped = !!plan.report_scope_id;
      if(!(options.projectIds || []).includes(plan.project_id) || monthOf(plan.plan_month)!==options.month
        || scoped && (plan.report_scope_id !== options.scope_id || !(plan.scope_project_ids || []).length
          || !(plan.scope_project_ids || []).every(function (id) { return (options.projectIds || []).includes(id); }))
        || !scoped && options.scope_id || options.line && plan.line!==options.line || reports.some(function(report){
          if(scoped)return report.report_scope_id===plan.report_scope_id && (report.biz && (report.biz.monthly_plan_id===plan.id || (report.biz.monthly_plan_ids || []).includes(plan.id)));
          return !report.report_scope_id && report.project_id===plan.project_id && report.line===plan.line && report.author_id===planOwner(plan);
        }))return;
      var fields={};Object.entries(plan.rich_text && plan.rich_text.fields || {}).forEach(function(pair){fields['biz.'+pair[0]]=pair[1];});
      var row={project_id:plan.project_id,line:plan.line,author_id:planOwner(plan),author_name:plan.owner_name || plan.confirmed_name,
        _monthly_preview:true,biz:{monthly_plan_id:plan.id,items:(plan.items || []).map(function(item){return Object.assign({},item,{prog:''});})},rich_text:{v:1,fields:fields}};
      if(scoped){row.report_scope_id=plan.report_scope_id;row.scope_project_ids=(plan.scope_project_ids || []).slice();}
      if(global.ZHRichText)global.ZHRichText.attach(row);
      reports.push(row);
    });
    return reports;
  }
  function actionHtml(item) {
    if(referenceConflicts.has(draftKey(month())))return '';
    var plan = current(), review = global.CompletionReview, legacy = legacyReport();
    if (legacy && item && item.source_id && review)
      return review.actionHtml('plan:' + legacy.project_id + ':' + legacy.id + ':items:' + item.source_id,
        { owner_id: legacy.author_id || S.uid, readOnly: !!legacy.author_id && legacy.author_id !== S.uid });
    if (reportScope()) plan = currentScopePlans().find(function (entry) { return item && entry.id === item.monthly_plan_id; });
    if(!plan && !reportScope() && item && item.source_id){var readable=(S.monthlyPlans || []).filter(function(entry){return entry.project_id===S.pmProject && entry.line===planLine() && monthOf(entry.plan_month)===month() && matchingScope(entry)
      && (entry.items || []).some(function(row){return row.source_id===item.source_id && sameConfirmedItem(row,item);});});if(readable.length===1)plan=readable[0];}
    return plan && item && item.source_id && review ? review.actionHtml(sourceKey(plan, item), { owner_id: planOwner(plan) || S.uid, readOnly: !!planOwner(plan) && !ownPlan(plan) }) : '';
  }
  function reportMonth(report) {
    var explicit = report.biz && monthOf(report.biz.monthly_plan_month), windows = global.PlanningWindows;
    return explicit || monthOf(windows && windows.periodStart(report.period, report.submitted_at || report.created_at));
  }
  function reportStart(report) {
    return global.PlanningWindows && global.PlanningWindows.periodStart(report.period, report.submitted_at || report.created_at) || '';
  }
  function sameConfirmedItem(entry, item) {
    return entry.source_id === item.source_id && ['mod', 'name', 'due'].every(function (field) {
      return String(entry[field] || '').trim() === String(item[field] || '').trim();
    });
  }
  // A projection only: never write derived nodes back over historical report nodes or drafts.
  function coreRows(options) {
    options = options || {};
    var windows = global.PlanningWindows, range = options.window;
    if (!windows || !range) return [];
    var cutoff = options.weekStart || range.start, rows = [];
    (S.monthlyPlans || []).forEach(function (plan) {
      if (plan.project_id !== options.projectId || options.line != null && plan.line !== options.line) return;
      if (options.personal && !ownPlan(plan)) return;
      if (options.personal && professionalScope() && !matchingScope(plan)) return;
      (plan.items || []).forEach(function (item, index) {
        var due = String(item.due || '').slice(0, 10);
        if (!item.source_id || !/^\d{4}-\d{2}-\d{2}$/.test(due) || due < range.start || due >= range.exclusiveEnd) return;
        var matches = (S.reports || []).filter(function (report) {
          var start = reportStart(report);
          return report.project_id === plan.project_id && report.line === plan.line && report.biz && report.author_id === planOwner(plan)
            && (plan.report_scope_id ? report.report_scope_id === plan.report_scope_id && Array.isArray(report.biz.monthly_plan_ids) && report.biz.monthly_plan_ids.includes(plan.id)
              : !report.report_scope_id && (report.biz.monthly_plan_id === plan.id || !report.biz.monthly_plan_id && reportMonth(report) === monthOf(plan.plan_month)))
            && start && start <= cutoff;
        }).sort(function (a, b) {
          return reportStart(b).localeCompare(reportStart(a)) || String(b.updated_at || b.submitted_at || '').localeCompare(String(a.updated_at || a.submitted_at || ''));
        });
        var latest = null, current = null;
        matches.forEach(function (report) {
          var entries = report.biz.items || [], at = entries.findIndex(function (entry) {
            return entry.source_id === item.source_id && (plan.report_scope_id ? entry.monthly_plan_id === plan.id : report.biz.monthly_plan_id === plan.id || sameConfirmedItem(entry, item));
          });
          if (at < 0) return;
          var entry = { item: entries[at], record: report, prefix: 'biz.items.' + at + '.', period: report.period, legacy: !plan.report_scope_id && !report.biz.monthly_plan_id };
          if (!latest) latest = entry;
          if (!current && reportStart(report) === cutoff) current = entry;
        });
        // Read compatible legacy feedback without rebinding its report, approval source or draft.
        if (options.personal && plan.project_id === S.pmProject && plan.line === S.pmLine
            && currentPlanId() === plan.id) {
          var live = (S.bizItems || []).filter(function (entry) { return entry.source_id === item.source_id && (!plan.report_scope_id || entry.monthly_plan_id === plan.id); })[0];
          var legacy = legacyReport();
          if (live && (!legacy || reportMonth(legacy) === monthOf(plan.plan_month) && sameConfirmedItem(live, item)))
            current = { item: live, record: live, prefix: '', period: S.pmPeriod, draft: true, legacy: !!legacy };
        }
        rows.push({ plan: plan, item: item, index: index, current: current, previous: !current && latest || null });
      });
    });
    return rows.sort(function (a, b) { return String(a.item.due).localeCompare(String(b.item.due))
      || String(a.plan.line).localeCompare(String(b.plan.line), 'zh-CN') || sourceKey(a.plan, a.item).localeCompare(sourceKey(b.plan, b.item)); });
  }
  function currentPlanId() {
    var plan = current();
    return plan ? plan.id : null;
  }
  function coreHtml(options) {
    var rows = coreRows(options), plans = (S.monthlyPlans || []).filter(function (plan) {
      return plan.project_id === options.projectId && (options.line == null || plan.line === options.line) && (!options.personal || ownPlan(plan))
        && (!options.personal || !professionalScope() || matchingScope(plan));
    });
    return '<p class="muted">从已确认月计划按完成时间自动汇总；进展和卡点与下方当周反馈共用，不需重复填写。</p>'
      + '<div class="' + (options.personal ? 'tablewrap' : 'overview-table-scroll') + '"><table class="' + (options.personal ? 'plan-form-table' : 'overview-data-table') + '"' + (options.personal ? '' : ' data-section="nodes"') + '><thead><tr><th>模块</th><th>节点事项</th><th>计划完成时间</th><th>当周进展</th><th>遇到卡点</th></tr></thead><tbody>'
        + (rows.length ? rows.map(function (row) {
          var feedback = row.current, previous = row.previous;
          var progress = feedback && feedback.item.prog ? itemName(feedback.record, feedback.prefix + 'prog', feedback.item.prog) : '本周未反馈';
          if (previous && (previous.item.prog || previous.item.blocker)) progress += '<div class="muted">最近历史反馈（' + esc(previous.period) + '）：'
            + (previous.item.prog ? itemName(previous.record, previous.prefix + 'prog', previous.item.prog) : '未填写进展')
            + (previous.item.blocker ? '；卡点：' + itemName(previous.record, previous.prefix + 'blocker', previous.item.blocker) : '') + '</div>';
          return '<tr><td data-label="模块">' + esc(row.plan.line) + (row.item.mod ? ' / ' + itemName(row.plan, 'items.' + row.index + '.mod', row.item.mod) : '')
            + '</td><td data-label="节点事项">' + itemName(row.plan, 'items.' + row.index + '.name', row.item.name)
            + '<div class="muted">' + esc(monthOf(row.plan.plan_month)) + ' 已确认月计划</div></td><td data-label="计划完成时间">' + esc(row.item.due)
            + '</td><td data-label="当周进展">' + progress + (feedback && feedback.legacy ? '<div class="muted">沿用既有周报反馈，原报告及审批关联保留</div>' : '')
            + (feedback && feedback.draft ? '<div class="muted">本页反馈，修改后需提交同步管理端</div>' : '')
            + '</td><td data-label="遇到卡点">' + (feedback ? feedback.item.blocker ? itemName(feedback.record, feedback.prefix + 'blocker', feedback.item.blocker) : '未填写卡点' : '本周未反馈') + '</td></tr>';
        }).join('') : '<tr><td colspan="5" class="empty">' + (plans.length ? '本窗口暂无到期的已确认月计划事项。' : '该模块暂无已确认月计划，未确认内容不作为自动汇总来源。') + '</td></tr>') + '</tbody></table></div>';
  }
  function personalCoreOptions() {
    var windows = global.PlanningWindows, report = S.pmReport || {};
    return { projectId: S.pmProject, line: S.pmLine, personal: true,
      window: windows && windows.windowFor(windows.periodStart(S.pmPeriod, report.submitted_at || report.created_at), 'week') };
  }
  function personalCoreHtml() { return referenceConflicts.has(draftKey(month()))?'<p class="notice warn">月计划版本已更新，请先保留原草稿并读取最新计划，再填写当前计划反馈。</p>':coreHtml(personalCoreOptions()); }
  function refreshCore() {
    var target = global.document && global.document.getElementById('monthly-core-summary');
    if (!enabled() || !target) return;
    if (cfg.flush) cfg.flush();
    target.innerHTML = personalCoreHtml();
  }
  function scopedReports(allOwners) {
    return (S.reports || []).filter(function (report) { return report.project_id === S.pmProject && report.line === S.pmLine && (allOwners || report.author_id === S.uid)
      && (!professionalScope() || report.report_scope_id === reportScope().id); })
      .slice().sort(function (a, b) { return reportStart(b).localeCompare(reportStart(a)) || String(b.updated_at || b.submitted_at || '').localeCompare(String(a.updated_at || a.submitted_at || '')); });
  }
  function statusHtml(key, owner) {
    var review = global.CompletionReview, row = cfg.completionFor ? cfg.completionFor(key, owner)
      : review && review.completionFor ? review.completionFor(key, owner) : null;
    var status = row && (row.source_access_lost ? 'source_access_lost' : row.source_missing ? 'source_missing' : row.source_changed ? 'source_changed' : row.effective_status || row.status);
    var unreadable = !row && owner && owner !== S.uid;
    var label = !row ? unreadable ? '原确认人的审核状态当前不可读' : '未申报' : status === 'approved' && row.request_type !== 'extension' ? '已审核完成'
      : status === 'pending' ? '申报中' : { rejected: '申报已退回', withdrawn: '申报已撤回', reopened: '已重开',
        source_changed: '来源变化，待核对', source_missing: '来源移除，待核对', source_access_lost: '权限变化，待核对' }[status] || '未完成';
    var completed = row && status === 'approved' && row.request_type !== 'extension';
    var category = row && row.completion_category === 'late' ? '延期完成' : row && row.completion_category === 'on_time' ? '按时完成' : '无法判定';
    return '<div>' + esc(label) + '</div>' + (completed ? '<div class="muted">实际完成：' + esc(row.completion_date || '未记录') + ' · ' + esc(category) + '</div>' : '')
      + (review && !unreadable ? review.actionHtml(key, { owner_id: owner || S.uid, readOnly: owner && owner !== S.uid }) : '');
  }
  function previousHtml() {
    if (!enabled()) return '';
    var previous = shiftMonth(selectedMonth(), -1), plan = planFor(previous), rows = [];
    if(!plan){var readable=(S.monthlyPlans || []).filter(function(entry){return entry.project_id===S.pmProject && entry.line===planLine() && monthOf(entry.plan_month)===previous && matchingScope(entry);});if(readable.length===1)plan=readable[0];}
    var reports = scopedReports(!!plan && !ownPlan(plan));
    if (plan) {
      rows = (plan.items || []).map(function (item, index) {
        var latest = null;
        reports.some(function (report) {
          if (!report.biz || (plan.report_scope_id ? !Array.isArray(report.biz.monthly_plan_ids) || !report.biz.monthly_plan_ids.includes(plan.id) : report.biz.monthly_plan_id !== plan.id)) return false;
          var match = (report.biz.items || []).filter(function (entry) { return entry.source_id === item.source_id && (!plan.report_scope_id || entry.monthly_plan_id === plan.id); })[0];
          if (match) { latest = { report: report, item: match }; return true; }
          return false;
        });
        return { item: item, record: plan, path: 'items.' + index + '.name', key: sourceKey(plan, item), owner: planOwner(plan),
          feedback: latest && latest.item, feedbackRecord: latest && latest.report, feedbackIndex: latest && latest.report.biz.items.indexOf(latest.item) };
      });
    } else {
      reports.filter(function (report) { return reportMonth(report) === previous; }).forEach(function (report) {
        (report.biz && Array.isArray(report.biz.items) ? report.biz.items : []).forEach(function (item, index) {
          if (!String(item.name || '').trim()) return;
          rows.push({ item: item, record: report, path: 'biz.items.' + index + '.name', owner: report.author_id,
            key: item.source_id ? 'plan:' + report.project_id + ':' + report.id + ':items:' + item.source_id : '',
            feedback: item, feedbackRecord: report, feedbackIndex: index });
        });
      });
    }
    return '<section class="card plan-form-section monthly-previous-plan"><div class="cardhd"><h3>' + esc(previous) + ' 上月计划完成情况</h3></div><div class="cardbody">'
      + '<p class="muted">' + (plan ? '按已确认月计划与当前审核结果展示。' : '历史周报汇总，未单独确认月计划；按周报来源分别列示。') + '</p>'
      + (rows.length ? '<div class="tablewrap"><table class="plan-form-table"><thead><tr><th>模块</th><th>事项</th><th>计划完成时间</th><th>完成状态</th><th>最近进展</th><th>遇到卡点</th></tr></thead><tbody>'
        + rows.map(function (row) {
          var item = row.item, feedback = row.feedback, record = row.feedbackRecord, prefix = 'biz.items.' + row.feedbackIndex + '.';
          return '<tr><td data-label="模块">' + itemName(row.record, row.path.replace(/\.name$/, '.mod'), item.mod) + '</td><td data-label="事项">' + itemName(row.record, row.path, item.name) + '</td>'
            + '<td data-label="计划完成时间">' + esc(item.due || '未设置') + '</td><td data-label="完成状态">' + (row.key ? statusHtml(row.key, row.owner) : '未建立稳定来源，待核对') + '</td>'
            + '<td data-label="最近进展">' + (feedback && feedback.prog ? itemName(record, prefix + 'prog', feedback.prog) : '未反馈') + (record ? '<div class="muted">' + esc(record.period || '') + '</div>' : '') + '</td>'
            + '<td data-label="遇到卡点">' + (feedback && feedback.blocker ? itemName(record, prefix + 'blocker', feedback.blocker) : '未反馈') + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="muted">该月暂无已确认计划或可见历史填报。</p>')
      + '</div></section>';
  }
  global.MonthlyPlans = { configure: configure, prepare: prepare, apply: apply, current: current, locked: locked, needsRefresh: needsRefresh, metadata: metadata,
    aiContext:aiContext, aiApply:aiApply, aiUndo:aiUndo, aiView:aiView,
    month: month, selectedMonth: selectedMonth, toolbarHtml: toolbarHtml, introHtml: toolbarHtml, plannerHtml: plannerHtml, previousHtml: previousHtml, planReferences:planReferences, acceptUpdated:acceptUpdated,
    capture: capture, binding: binding, saveDraft: saveDraft, draftError: draftError, select: select, edit: edit, addNext: addNext, removeNext: removeNext, confirmCurrent: confirmCurrent, confirmNext: confirmNext, withdrawCurrent: withdrawCurrent, withdrawNext: withdrawNext,
    sourceKey: sourceKey, actionHtml: actionHtml, projectReports: projectReports, residentialReports: residentialReports, residentialLine: residentialLine, coreRows: coreRows, coreHtml: coreHtml,
    personalCoreHtml: personalCoreHtml, refreshCore: refreshCore };
})(window);

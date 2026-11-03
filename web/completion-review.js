/* Completion is a server-reviewed record per source and owner. */
(function (global) {
  'use strict';
  var cfg, S, identity, sessionIdentity, modal = null, nextToken = 1, links = new Map(), tokens = new Map();
  var queueFilters = { project_id: '', kind: '', status: '' };
  var queryBusy = false, pageBusy = false, queueError = '', pendingQuery = null, queueContext = null, queueEpoch = 0;
  var initiated = null, initiatedEpoch = 0;
  var LABEL = { pending: '待审核', approved: '已审核销项', rejected: '已退回', withdrawn: '已撤回', reopened: '已重开',
    source_changed: '来源已变化', source_missing: '来源已移除', source_access_lost: '来源权限已变化', none: '未申请审核' };
  var KIND = { leader: '领导安排', meeting: '会议事项', coord: '协调／移交', milestone: '计划节点', plan: '填报计划' };
  function resetInitiated() {
    initiatedEpoch++;
    initiated = { rows: [], meta: {}, query: { project_id: '', status: 'all' }, pendingQuery: null, ready: false, busy: false, error: '', context: null, pending: null };
  }
  function configure(options) {
    if (identity !== options.S.uid || sessionIdentity !== options.S.session) {
      modal = null; links.clear(); tokens.clear(); queueFilters = { project_id: '', kind: '', status: '' };
      queryBusy = false; pageBusy = false; queueError = ''; pendingQuery = null; queueContext = null; queueEpoch++;
      resetInitiated();
      identity = options.S.uid; sessionIdentity = options.S.session;
    }
    cfg = options; S = options.S;
    if (initiated && initiated.busy && !sameContext(initiated.context)) {
      initiatedEpoch++; initiated.busy = false; initiated.pending = null; initiated.pendingQuery = null; initiated.context = null;
    }
    if ((queryBusy || pageBusy) && queueContext && !sameContext(queueContext)) {
      queryBusy = false; pageBusy = false; pendingQuery = null; queueContext = null; queueEpoch++;
    }
    if (modal && !sameContext(modal.context)) modal = null;
  }
  function esc(value) { return cfg.esc(value == null ? '' : value); }
  function richField(row, field, fallback) {
    if (cfg.richItem) return cfg.richItem(row, field, fallback);
    return global.ZHRichText ? global.ZHRichText.field(row, field, fallback) : esc(row[field] || fallback || '');
  }
  function copyRich(source, target, mapping) {
    return cfg.richCopy ? cfg.richCopy(source, target, mapping) : global.ZHRichText ? global.ZHRichText.copy(source, target, mapping) : target;
  }
  function noteFormatting(m, field, value) {
    var row = {}; row[field] = value; copyRich(m, row, Object.fromEntries([[field, field]]));
    if (cfg.richCollect) return cfg.richCollect(row).rich_text;
    return global.ZHRichText ? global.ZHRichText.collect(row).rich_text : {};
  }
  function role() { return S.profile && S.profile.role; }
  function context() { return { uid: S.uid, session: S.session, project: S.pmProject, period: S.pmPeriod, view: S.view,
    filterProject: S.filters && S.filters.project }; }
  function sameContext(c) { return c && c.uid === S.uid && c.session === S.session && c.project === S.pmProject && c.period === S.pmPeriod
    && c.view === S.view && c.filterProject === (S.filters && S.filters.project); }
  function active(m) { return modal === m && sameContext(m.context); }
  function snapshot(row) { return row && row.source_snapshot || row || {}; }
  function sourceWhat(source, row) {
    var record = source && typeof source.what === 'string' ? source : row || {};
    return global.ZHRichText ? global.ZHRichText.field(record, 'what') : esc(record.what || '');
  }
  function effective(row) {
    if (!row) return 'none';
    if (row.source_access_lost) return 'source_access_lost';
    if (row.source_missing) return 'source_missing';
    if (row.source_changed) return 'source_changed';
    return row.effective_status || row.status || 'none';
  }
  function isExtension(row) { return row && row.request_type === 'extension'; }
  function canReview(row) {
    return !!row && (role() === 'ops' ? row.can_review !== false : role() === 'pm' && row.can_review === true && row.review_authority === 'initiator');
  }
  function isCoordination(key) { return typeof key === 'string' && (/^coord:[^:]+:[^:]+:coord:/.test(key) || /^coord:[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)); }
  function reviewerName(key, row) { return row && row.review_authority === 'initiator' || isCoordination(key) ? '协调发起人' : '运营'; }
  function combinedRows() {
    var rows = new Map();
    (S.completions || []).concat(initiated && initiated.ready ? initiated.rows : []).forEach(function (row) {
      if (!row) return;
      var previous = rows.get(row.id);
      if (!previous || Number(row.revision || 0) >= Number(previous.revision || 0)) rows.set(row.id, row);
    });
    return Array.from(rows.values());
  }
  function sourceRows(key, owner) {
    if (!S) return null;
    var uid = owner || S.uid;
    return combinedRows().filter(function (row) { return row && row.source_key === key && row.owner_id === uid; });
  }
  function completionRow(key, owner) { return (sourceRows(key, owner) || []).filter(function (row) { return !isExtension(row); })[0] || null; }
  function find(key, owner, id) {
    var rows = sourceRows(key, owner) || [];
    if (id) return rows.filter(function (row) { return row.id === id; })[0] || null;
    return rows.filter(function (row) { return row.status === 'pending'; })[0] || completionRow(key, owner) || rows[0] || null;
  }
  function effectiveDue(key, fallback, owner) {
    var row = (sourceRows(key, owner) || []).filter(function (item) { return item.effective_due && !item.source_changed && !item.source_missing && !item.source_access_lost; })[0];
    return row && row.effective_due || fallback || '';
  }
  function approved(key, owner) { return effective(completionRow(key, owner)) === 'approved'; }
  function completionFor(key, owner) {
    var row = completionRow(key, owner);
    return row ? Object.assign({}, row, {effective_status: effective(row)}) : null;
  }
  function badge(key, owner) { return cfg ? badgeRow(find(key, owner)) : ''; }
  function badgeRow(row) {
    var status = effective(row), cls = Object.prototype.hasOwnProperty.call(LABEL, status) ? status : 'none';
    var label = isExtension(row) && ['pending', 'approved', 'rejected', 'withdrawn'].includes(status)
      ? { pending: '延期待审核', approved: '延期已批准', rejected: '延期已退回', withdrawn: '延期已撤回' }[status] : LABEL[status] || '审核状态待核对';
    return '<span class="completion-badge completion-' + cls + '">' + esc(label) + '</span>';
  }
  function stash(readOnly) {
    if (role() !== 'pm' || readOnly) return;
    if (cfg.flush) cfg.flush();
    if (global.ReporterTasks) global.ReporterTasks.capture();
    if (cfg.saveDraft) cfg.saveDraft();
  }
  function register(key, options) {
    var opts = options || {}, owner = opts.owner_id || S.uid, cacheKey = JSON.stringify([key, owner, !!opts.readOnly, opts.id || '', !!opts.initiated]);
    if (links.has(cacheKey)) return links.get(cacheKey);
    var token = nextToken++;
    links.set(cacheKey, token); tokens.set(token, { key: key, options: { owner_id: owner, readOnly: !!opts.readOnly, id: opts.id, initiated: !!opts.initiated } });
    return token;
  }
  function actionHtml(key, options) {
    if (!cfg) return '';
    var opts = options || {}, row = find(key, opts.owner_id), owner = opts.owner_id || S.uid;
    var readonly = !!opts.readOnly || !(role() === 'pm' && owner === S.uid || canReview(row));
    var html = badgeRow(row);
    if (readonly && !row) return html;
    if (role() === 'ops' && !row) return html;
    var token = register(key, { owner_id: opts.owner_id, readOnly: readonly });
    var label = opts.label || (readonly ? '查看审核' : canReview(row) && row.status === 'pending' ? '审核' : role() === 'ops' ? '查看详情'
      : !row || isExtension(row) && row.status !== 'pending' || ['rejected', 'withdrawn', 'reopened'].includes(row.status) ? '完成／延期申报' : '查看申请');
    return '<span class="completion-actions">' + html + '<button type="button" class="btn completion-action" onclick="CompletionReview.openKey(' + token + ')">' + esc(label) + '</button></span>';
  }
  function read(id, fallback) { var el = global.document && global.document.getElementById(id); return el ? String(el.value || '') : fallback; }
  function capture(m) {
    if (global.ZHRichEditor) global.ZHRichEditor.flush();
    m.completion_date = read('completion_date', m.completion_date || '');
    m.completion_note = read('completion_note', m.completion_note || '');
    m.review_note = read('completion_review_note', m.review_note || '');
    m.request_type = read('completion_request_type', m.request_type || 'completion');
    m.requested_due = read('completion_requested_due', m.requested_due || '');
  }
  function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function check(result) {
    if (!result || result.error) {
      var detail = result && result.error || {}, e = new Error(detail.message || '服务器未返回有效结果');
      e.conflict = detail.status === 409 || /conflict|changed|stale/.test(detail.code || '') || detail.code === '40001';
      e.forbidden = detail.status === 403 || ['completion_forbidden', 'source_forbidden', 'coordination_forbidden'].includes(detail.code); throw e;
    }
    return result.data;
  }
  function message(error) { return error.conflict ? '事项或审核记录已变化，请刷新核对后重试；当前填写内容保留。' : (error.message || '无法连接服务器，请重试'); }
  async function open(key, options) {
    var opts = options || {}, row = find(key, opts.owner_id, opts.id), owner = opts.owner_id || S.uid;
    var readonly = !!opts.readOnly || !(role() === 'pm' && owner === S.uid || canReview(row));
    stash(readonly);
    var m = { key: key, owner_id: owner, readOnly: readonly, row: row, record_id: opts.id, initiated: !!opts.initiated,
      preview: row && snapshot(row), loading: false, busy: false, error: '', context: context(),
      completion_date: row && row.completion_date || today(), completion_note: isExtension(row) && row.status === 'approved' ? '' : row && row.completion_note || '', review_note: '',
      request_type: isExtension(row) && row.status !== 'approved' ? 'extension' : 'completion', requested_due: row && row.requested_due || '' };
    modal = m;
    if (row && !(isExtension(row) && row.status === 'approved')) copyRich(row, m, { completion_note: 'completion_note' });
    if (role() !== 'pm' || owner !== S.uid || readonly || (row && row.status === 'approved' && !isExtension(row))) { cfg.render(); return; }
    m.loading = true; cfg.render();
    try {
      var preview = check(await cfg.request('/api/completions/preview', { source_key: key }));
      if (!active(m)) return;
      if (!preview || !preview.source_version) throw new Error('事项来源资料不完整，请刷新后重试');
      m.preview = preview;
    } catch (error) { if (active(m)) m.error = message(error); }
    finally { if (active(m)) { m.loading = false; cfg.render(); } }
  }
  function openKey(token) { var link = tokens.get(token); if (link) return open(link.key, link.options); }
  function close() { if (modal && modal.busy) return; modal = null; cfg.render(); }
  function updateLocal(row) {
    if (!row || !row.id) return;
    var found = false;
    S.completions = (S.completions || []).map(function (item) { if (item.id === row.id) { found = true; return row; } return item; });
    if (!found && (role() !== 'pm' || row.owner_id === S.uid)) S.completions.push(row);
    if (initiated) initiated.rows = initiated.rows.map(function (item) { return item.id === row.id ? row : item; });
  }
  async function refresh() {
    var m = modal; if (!m || m.busy || m.loading) return;
    capture(m); stash(m.readOnly); m.loading = true; m.error = ''; cfg.render();
    try {
      var loaded;
      if (m.initiated || role() === 'pm' && m.owner_id !== S.uid) {
        var refreshed = await cfg.request('/api/completions/list', { review_scope: 'initiated', id: m.record_id || m.row && m.row.id });
        var rows = check(refreshed);
        if (!active(m)) return;
        if (!Array.isArray(rows) || !rows.length) { m.readOnly = true; throw new Error('当前已无此协调事项的发起审核权限，请刷新列表核对'); }
        updateLocal(rows[0]); loaded = true;
      } else loaded = await cfg.loadData(['completions'], true);
      if (!active(m)) return;
      if (loaded === false || loaded && loaded.error) throw new Error('审核记录读取失败，请重试');
      m.row = find(m.key, m.owner_id, m.record_id);
      if (role() === 'pm' && m.owner_id === S.uid && !m.readOnly && (!m.row || m.row.status !== 'approved' || isExtension(m.row))) {
        var preview = check(await cfg.request('/api/completions/preview', { source_key: m.key }));
        if (!active(m)) return;
        if (!preview || !preview.source_version) throw new Error('事项来源资料不完整，请重试');
        m.preview = preview;
      } else m.preview = m.row && snapshot(m.row);
    } catch (error) { if (active(m)) { if (error.forbidden) m.readOnly = true; m.error = message(error); } }
    finally { if (active(m)) { m.loading = false; cfg.render(); } }
  }
  async function mutate(url, payload, success) {
    var m = modal; if (!m || m.busy || m.loading) return;
    m.busy = true; m.error = ''; cfg.render();
    try {
      var data = check(await cfg.request(url, payload));
      if (!active(m)) return;
      if (!data || typeof data !== 'object' || Array.isArray(data) || !data.id || !Number.isSafeInteger(data.revision) || data.revision < 1 || !Object.prototype.hasOwnProperty.call(LABEL, data.status)) throw new Error('保存结果不完整，请刷新核对；当前填写内容保留。');
      updateLocal(data); m.row = data || find(m.key, m.owner_id); m.record_id = data.id; m.preview = m.row && snapshot(m.row);
      cfg.toast(success);
      try {
        var loaded = cfg.afterSaved ? await cfg.afterSaved(data) : await cfg.loadData(['completions'], true);
        if (loaded === false || loaded && loaded.error) throw new Error();
        if (active(m)) m.row = find(m.key, m.owner_id, m.record_id) || m.row;
      } catch (_) { if (active(m)) cfg.toast('操作已保存，审核列表刷新失败，请手动刷新数据', 'err'); }
    } catch (error) { if (active(m)) { if (error.forbidden) m.readOnly = true; m.error = message(error); cfg.toast(m.error, 'err'); } }
    finally { if (active(m)) { m.busy = false; cfg.render(); } }
  }
  async function requestCompletion() {
    var m = modal;
    if (!m || m.busy || m.loading || m.readOnly || role() !== 'pm' || m.owner_id !== S.uid) return;
    capture(m); stash(false);
    if (m.row && (m.row.status === 'pending' || m.row.status === 'approved' && !isExtension(m.row))) return cfg.toast('当前申请尚不可重复提交，请先核对审核状态', 'err');
    if (!m.preview || !m.preview.source_version) return cfg.toast('请先刷新并核对事项来源', 'err');
    if (m.request_type === 'extension') {
      var requested = new Date(m.requested_due + 'T00:00:00Z'), due = m.preview.effective_due || m.preview.due || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(m.requested_due) || !Number.isFinite(requested.getTime()) || requested.toISOString().slice(0, 10) !== m.requested_due) return cfg.toast('请填写有效的申请延期日期', 'err');
      if (due && m.requested_due <= due) return cfg.toast('申请延期日期须晚于当前执行截止时间', 'err');
      if (!m.completion_note.trim()) return cfg.toast('请填写延期原因，供' + reviewerName(m.key, m.row) + '审核', 'err');
      return mutate('/api/completions/request', { source_key: m.key, source_version: m.preview.source_version, request_type: 'extension', requested_due: m.requested_due, completion_note: m.completion_note.trim(), rich_text: noteFormatting(m, 'completion_note', m.completion_note.trim()) }, '延期申请已提交，' + reviewerName(m.key, m.row) + '审核通过后生效；事项继续办理');
    }
    var date = new Date(m.completion_date + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.completion_date) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== m.completion_date) return cfg.toast('请填写有效的实际完成日期', 'err');
    if (!m.completion_note.trim()) return cfg.toast('请填写完成说明，供' + reviewerName(m.key, m.row) + '逐条审核', 'err');
    var payload = { source_key: m.key, source_version: m.preview.source_version, completion_date: m.completion_date, completion_note: m.completion_note.trim(), rich_text: noteFormatting(m, 'completion_note', m.completion_note.trim()) };
    var prior = completionRow(m.key, m.owner_id);
    if (prior) payload.expected_revision = prior.revision;
    return mutate('/api/completions/request', payload, '完成申请已提交；' + reviewerName(m.key, m.row) + '审核通过前继续滚动');
  }
  async function review(decision) {
    var m = modal;
    if (!m || m.busy || m.loading || m.readOnly || !canReview(m.row) || !['approve', 'reject', 'reopen'].includes(decision)) return;
    capture(m);
    if (decision === 'approve' && ['source_changed', 'source_missing', 'source_access_lost'].includes(effective(m.row))) return cfg.toast('事项来源尚未核对，暂不能通过审核', 'err');
    if (decision !== 'approve' && !m.review_note.trim()) return cfg.toast(decision === 'reject' ? '请填写退回原因' : '请填写重新打开原因', 'err');
    return mutate('/api/completions/review', { id: m.row.id, expected_revision: m.row.revision, decision: decision, note: m.review_note.trim(), rich_text: noteFormatting(m, 'review_note', m.review_note.trim()) },
      decision === 'approve' ? isExtension(m.row) ? '延期已批准，执行截止时间已更新，事项继续办理' : '已审核通过并销项' : decision === 'reject' ? '已退回，事项继续滚动' : '已重新打开，事项继续滚动');
  }
  function changeType(value) {
    var m = modal; if (!m || m.busy || m.loading) return;
    capture(m); m.request_type = value === 'extension' ? 'extension' : 'completion'; cfg.render();
  }
  function completionCategory(m) {
    var due = m.preview ? m.preview.effective_due != null ? m.preview.effective_due : m.preview.due : m.row && (m.row.deadline_at_request != null ? m.row.deadline_at_request : m.row.effective_due != null ? m.row.effective_due : m.row.due);
    return !validCalendarDate(due) || !validCalendarDate(m.completion_date) ? '无法判定' : m.completion_date > due ? '延期完成' : '按时完成';
  }
  function validCalendarDate(value) { var date = new Date(value + 'T00:00:00Z'); return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000') && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }
  function categoryLabel(row) { return row.completion_category === 'late' ? '延期完成' : row.completion_category === 'on_time' ? '按时完成' : '无法判定'; }
  function dateChanged() { var m = modal; if (!m || m.busy || m.loading) return; capture(m); cfg.render(); }
  function detail(m) {
    var row = m.row, source = m.preview || row && snapshot(row) || {};
    return '<div class="completion-detail"><h4>' + esc(source.title || row && row.title || '事项资料') + '</h4><div class="completion-source-content">' + sourceWhat(source, row) + '</div>'
      + '<p class="muted">' + esc(KIND[source.kind || row && row.kind] || '工作事项') + ' · 原计划日期：' + esc(source.original_due || source.due || row && row.due || '未设置')
      + ' · 执行截止：' + esc(source.effective_due || row && row.effective_due || source.due || row && row.due || '未设置') + '</p>'
      + (row ? '<p>承办人：' + esc(row.owner_name || row.owner_id) + '　' + badgeRow(row) + '</p>'
        + (isExtension(row) ? '<p>申请延期至：' + esc(row.requested_due || '未填写') + '</p><p class="completion-source-content">延期原因：' : '<p>实际完成日期：' + esc(row.completion_date || '未填写')
          + (row.completion_category ? ' · ' + categoryLabel(row) : '') + '</p><p class="completion-source-content">完成说明：') + richField(row, 'completion_note', '未填写') + '</p>'
        + (row.review_note ? '<p class="completion-source-content">审核说明：' + richField(row, 'review_note') + '</p>' : '')
        + (row.reviewer_name ? '<p class="muted">审核人：' + esc(row.reviewer_name) + (row.reviewed_at ? ' · ' + esc(row.reviewed_at) : '') + '</p>' : '') : '')
      + (row && (row.source_changed || row.source_missing || row.source_access_lost || ['source_changed', 'source_missing', 'source_access_lost'].includes(effective(row)))
        ? '<p class="completion-warning">事项来源已变化、移除或访问权限调整，原申请资料保留供核对；当前不按已审核销项处理。</p>' : '') + '</div>';
  }
  function overlayHtml() {
    var m = modal; if (!m) return '';
    var row = m.row, own = role() === 'pm' && m.owner_id === S.uid && !m.readOnly, reviewer = canReview(row) && !m.readOnly;
    var form = '';
    if (!m.loading && !m.busy) {
      if (own && (!row || !['pending', 'approved'].includes(row.status) || isExtension(row) && row.status === 'approved')) {
        var extension = m.request_type === 'extension';
        form = '<div class="completion-request-form"><label>申报类型<select id="completion_request_type" onchange="CompletionReview.changeType(this.value)"><option value="completion"' + (!extension ? ' selected' : '') + '>完成申报（按时／延期完成）</option><option value="extension"' + (extension ? ' selected' : '') + '>申请延期</option></select></label>'
          + (extension ? '<label>申请延期至<input id="completion_requested_due" type="date" value="' + esc(m.requested_due) + '"></label><p class="muted">延期由' + reviewerName(m.key, row) + '审核后生效，保留原计划日期与审批记录。</p>'
            : '<label>实际完成日期<input id="completion_date" type="date" value="' + esc(m.completion_date) + '" onchange="CompletionReview.dateChanged()"></label><p class="completion-category">申报类别：<b>' + completionCategory(m) + '</b><span class="muted">按执行截止时间自动判断</span></p>')
          + '<label>' + (extension ? '延期原因' : '完成说明') + '<textarea id="completion_note" data-rich rows="4" maxlength="10000" placeholder="' + (extension ? '说明延期原因及新的完成安排' : '说明完成结果及可核验依据') + '">' + esc(m.completion_note) + '</textarea></label>'
          + '<button type="button" class="btn primary" onclick="CompletionReview.request()"' + (!m.preview || !m.preview.source_version ? ' disabled' : '') + '>' + (extension ? '提交延期申请' : '提交完成申请') + '</button></div>';
      }
      if (own && row && row.status === 'pending') form += '<p class="completion-warning">' + (isExtension(row) ? '延期申请待审核，原执行截止时间继续有效；批准后更新期限，事项继续办理。' : '申请待审核，事项继续滚动；审核通过后销项。') + '</p>';
      if (own && row && !isExtension(row) && row.status === 'approved' && effective(row) !== 'approved') form += '<p class="completion-warning">请联系' + (isCoordination(m.key) ? '协调发起人' : '管理员') + '核对并重新打开原审核记录，再提交新的完成申请。</p>';
      if (reviewer && row && ['pending', 'approved'].includes(row.status) && !(isExtension(row) && row.status === 'approved')) {
        form += '<label>审核说明<textarea id="completion_review_note" data-rich rows="3" maxlength="10000" placeholder="退回或重新打开必须填写原因">' + esc(m.review_note) + '</textarea></label><div class="completion-review-actions">';
        if (row.status === 'pending') form += '<button type="button" class="btn primary" onclick="CompletionReview.review(\'approve\')"' + (['source_changed', 'source_missing', 'source_access_lost'].includes(effective(row)) ? ' disabled' : '') + '>审核通过</button><button type="button" class="btn" onclick="CompletionReview.review(\'reject\')">退回</button>';
        else if (!isExtension(row)) form += '<button type="button" class="btn" onclick="CompletionReview.review(\'reopen\')">重新打开事项</button>';
        form += '</div>';
      }
    }
    return '<div class="completion-overlay"><section class="completion-dialog" role="dialog" aria-modal="true" aria-labelledby="completion-dialog-title"><div class="completion-dialog-head"><h3 id="completion-dialog-title">事项申报与审核</h3>'
      + '<button type="button" class="btn" aria-label="关闭审核详情" onclick="CompletionReview.close()"' + (m.busy ? ' disabled' : '') + '>关闭</button></div>'
      + detail(m) + (m.error ? '<p class="completion-error" role="alert">' + esc(m.error) + '</p>' : '')
      + (m.loading || m.busy ? '<p role="status" aria-live="polite">' + (m.loading ? '正在读取事项资料…' : '正在保存，请稍候…') + '</p>' : form)
      + '<button type="button" class="btn completion-refresh" onclick="CompletionReview.refresh()"' + (m.busy || m.loading ? ' disabled' : '') + '>刷新核对资料</button></section></div>';
  }
  function currentQuery() {
    return S.completionQuery || { project_id: queueFilters.project_id || '', status: role() === 'ops' ? 'pending' : queueFilters.status || '' };
  }
  async function setFilter(field, value) {
    if (!Object.prototype.hasOwnProperty.call(queueFilters, field)) return;
    if (queryBusy || pageBusy) return;
    stash(false);
    if (field === 'kind') { queueFilters.kind = String(value || ''); cfg.render(); return; }
    var before = Object.assign({}, currentQuery()), query = { project_id: before.project_id || '', status: before.status || '' };
    query[field] = String(value || '');
    var activeCfg = cfg, stamp = context(), epoch = ++queueEpoch;
    function live() { return epoch === queueEpoch && sameContext(stamp); }
    queryBusy = true; queueError = ''; pendingQuery = query; queueContext = stamp; activeCfg.render();
    try {
      if (!activeCfg.queryCompletions) throw new Error('审核查询暂不可用，请刷新页面');
      var result = await activeCfg.queryCompletions(query);
      if (!live()) return;
      if (result === false || result && result.error) throw new Error(result && result.error && result.error.message || '审核记录读取失败，请重试');
      S.completionQuery = query; queueFilters.project_id = query.project_id; queueFilters.status = query.status;
    } catch (error) {
      if (live()) { S.completionQuery = before; queueError = error.message || '审核记录读取失败，请重试'; activeCfg.toast(queueError, 'err'); }
    } finally {
      if (live()) { queryBusy = false; pendingQuery = null; queueContext = null; activeCfg.render(); }
    }
  }
  async function loadMore() {
    if (queryBusy || pageBusy || !S.completionMeta || !S.completionMeta.has_more) return;
    stash(false);
    var activeCfg = cfg, stamp = context(), query = JSON.stringify(currentQuery()), epoch = ++queueEpoch;
    function live() { return epoch === queueEpoch && sameContext(stamp) && query === JSON.stringify(currentQuery()); }
    pageBusy = true; queueError = ''; queueContext = stamp; activeCfg.render();
    try {
      if (!activeCfg.loadMoreCompletions) throw new Error('后续审核记录暂不可用，请刷新页面');
      var result = await activeCfg.loadMoreCompletions();
      if (!live()) return;
      if (result === false || result && result.error) throw new Error(result && result.error && result.error.message || '后续审核记录读取失败，请重试');
    } catch (error) { if (live()) { queueError = error.message || '后续审核记录读取失败，请重试'; activeCfg.toast(queueError, 'err'); } }
    finally { if (live()) { pageBusy = false; queueContext = null; activeCfg.render(); } }
  }
  function filterOptions(values, selected, all) {
    return '<option value="">' + esc(all) + '</option>' + values.map(function (entry) { return '<option value="' + esc(entry[0]) + '"' + (entry[0] === selected ? ' selected' : '') + '>' + esc(entry[1]) + '</option>'; }).join('');
  }
  function invalidateInitiated() {
    if (!initiated) return;
    initiatedEpoch++; initiated.ready = false; initiated.busy = false; initiated.pending = null; initiated.pendingQuery = null; initiated.context = null; initiated.error = '';
  }
  async function loadInitiated(force, more, desired) {
    if (role() !== 'pm') return { data: null, error: { message: '仅协调发起人可读取此审核栏' } };
    if (!initiated) resetInitiated();
    if (initiated.busy && initiated.pending) return initiated.pending;
    var query = Object.assign({}, desired || initiated.query), sameQuery = JSON.stringify(query) === JSON.stringify(initiated.query);
    if (!more && !force && initiated.ready && sameQuery) return { data: initiated.rows, meta: initiated.meta, error: null };
    if (more && (!initiated.ready || !initiated.meta.has_more)) return { data: initiated.rows, meta: initiated.meta, error: null };
    var epoch = ++initiatedEpoch, stamp = context(), state = initiated, activeCfg = cfg;
    function live() { return initiated === state && epoch === initiatedEpoch && sameContext(stamp) && role() === 'pm'; }
    var payload = { review_scope: 'initiated', status: query.status || 'all', limit: 100 };
    if (query.project_id) payload.project_id = query.project_id;
    if (more) payload.cursor = state.meta.next_cursor;
    state.busy = true; state.error = ''; state.pendingQuery = query; state.context = stamp;
    var task = (async function () {
      try {
        var response = await activeCfg.request('/api/completions/list', payload), rows = check(response);
        if (!live()) return { data: null, error: { code: 'stale_initiated', message: '当前身份或页面已变化，请重新读取协调审核栏' } };
        if (!Array.isArray(rows)) throw new Error('协调审核列表读取结果不完整，请重试');
        var meta = response.meta || {}, unique = new Map();
        if (meta.has_more && !meta.next_cursor) throw new Error('协调审核列表缺少后续页标识，请刷新重试');
        (more ? state.rows : []).concat(rows).forEach(function (row) {
          var old = unique.get(row.id);
          if (!old || Number(row.revision || 0) >= Number(old.revision || 0)) unique.set(row.id, row);
        });
        state.rows = Array.from(unique.values()); state.query = query; state.meta = meta; state.ready = true;
        return { data: state.rows, meta: meta, error: null };
      } catch (error) {
        if (live()) state.error = error.message || '协调审核列表读取失败，请重试';
        return { data: null, error: { message: error.message || '协调审核列表读取失败，请重试' } };
      } finally {
        if (live()) { state.busy = false; state.pending = null; state.pendingQuery = null; state.context = null; }
      }
    })();
    state.pending = task;
    return task;
  }
  async function queryInitiated(force, more, query) {
    if (role() !== 'pm') return;
    stash(false);
    var stamp = context(), task = loadInitiated(force, more, query);
    cfg.render();
    var result = await task;
    if (sameContext(stamp)) cfg.render();
    return result;
  }
  function filterInitiated(field, value) {
    if (!initiated || initiated.busy || !['project_id', 'status'].includes(field)) return;
    var query = Object.assign({}, initiated.query);
    query[field] = String(value || (field === 'status' ? 'all' : ''));
    return queryInitiated(true, false, query);
  }
  function refreshInitiated() { return queryInitiated(true, false); }
  function moreInitiated() { return queryInitiated(false, true); }
  function renderInitiatedQueue() {
    if (role() !== 'pm') return '';
    if (!initiated) resetInitiated();
    var query = initiated.pendingQuery || initiated.query, more = !!initiated.meta.has_more, disabled = initiated.busy ? ' disabled' : '';
    var rows = initiated.rows.filter(function (row) { return row && row.kind === 'coord' && isCoordination(row.source_key)
      && (!query.project_id || row.project_id === query.project_id) && (!query.status || query.status === 'all' || row.status === query.status); });
    return '<section class="card completion-queue completion-initiated"><div class="cardhd"><h3>我发起的协调事项审核<span class="chip">已加载 ' + rows.length + ' 条</span></h3>'
      + '<button type="button" class="btn" onclick="CompletionReview.refreshInitiated()"' + disabled + '>刷新发起事项</button></div>'
      + '<p class="muted">由原协调事项的发起人审核承办人的完成与延期申请。审核通过才销项；延期批准后事项继续办理。</p><div class="completion-filters">'
      + '<label>项目<select onchange="CompletionReview.filterInitiated(\'project_id\',this.value)"' + disabled + '>' + filterOptions((S.projects || []).map(function (project) { return [project.id, project.name || project.id]; }), query.project_id, '全部项目') + '</select></label>'
      + '<label>审核状态<select onchange="CompletionReview.filterInitiated(\'status\',this.value)"' + disabled + '>' + filterOptions(['pending', 'approved', 'rejected', 'withdrawn', 'reopened'].map(function (status) { return [status, LABEL[status]]; }), query.status === 'all' ? '' : query.status, '全部状态') + '</select></label></div>'
      + (initiated.error ? '<p class="completion-error" role="alert">' + esc(initiated.error) + '；已加载记录保留。</p>' : '')
      + (initiated.busy ? '<p role="status">正在读取发起协调事项的审核记录…</p>' : '')
      + (rows.length ? '<div class="tablewrap"><table><thead><tr><th>协调事项与来源</th><th>承办人</th><th>申报类别／日期</th><th>状态</th><th>操作</th></tr></thead><tbody>' + rows.map(function (row) {
        var source = snapshot(row), token = register(row.source_key, { owner_id: row.owner_id, id: row.id, initiated: true, readOnly: !canReview(row) && row.owner_id !== S.uid });
        return '<tr><td><b>' + esc(source.title || row.title || '协调事项') + '</b><div class="completion-source-content">' + sourceWhat(source, row) + '</div>'
          + '<small class="muted">' + esc(source.due || row.due || '未设最晚时间') + '</small></td><td>' + esc(row.owner_name || row.owner_id) + '</td><td>'
          + (isExtension(row) ? '申请延期' : categoryLabel(row)) + '<div>' + esc(isExtension(row) ? row.requested_due || '—' : row.completion_date || '—') + '</div></td><td>' + badgeRow(row)
          + '</td><td><button type="button" class="btn" onclick="CompletionReview.openKey(' + token + ')">' + (canReview(row) && row.status === 'pending' ? '审核' : '查看') + '</button></td></tr>';
      }).join('') + '</tbody></table></div>' : !initiated.busy ? '<div class="empty">' + (initiated.ready ? '当前查询没有发起协调事项的审核申请。' : '尚未读取发起协调事项审核，请点击刷新。') + '</div>' : '')
      + '<div class="completion-pagination"><p class="muted">已加载 ' + rows.length + ' 条协调审核记录。' + (more ? '还有后续记录，以上仅为已加载部分。' : initiated.ready ? '当前查询已读取完毕。' : '') + '</p>'
      + (more ? '<button type="button" class="btn" onclick="CompletionReview.moreInitiated()"' + disabled + '>加载更多协调审核记录</button>' : '') + '</div></section>';
  }
  function renderQueue(options) {
    var opts = options || {};
    if (opts.review_scope === 'initiated') return renderInitiatedQueue();
    var all = opts.scope === 'all' && role() !== 'pm', readonly = !['pm', 'ops'].includes(role());
    var unique = new Map();
    (S.completions || []).forEach(function (row) {
      if (!row || typeof row !== 'object') return;
      var id = String(row.id || row.source_key + '|' + row.owner_id), old = unique.get(id);
      if (!old || Number(row.revision || 0) >= Number(old.revision || 0)) unique.set(id, row);
    });
    var query = pendingQuery || currentQuery(), filters = Object.assign({}, queueFilters, query, opts.filters || {});
    if (opts.project_id) filters.project_id = opts.project_id;
    var ids = Array.isArray(S.completionQueueIds) ? new Set(S.completionQueueIds.map(String)) : null;
    var allowed = Array.from(unique.values()).filter(function (row) { return (all || row.owner_id === S.uid) && (!ids || ids.has(String(row.id)))
      && (!filters.project_id || row.project_id === filters.project_id) && (!filters.status || row.status === filters.status); });
    var selected = allowed.filter(function (row) { return !filters.kind || (row.kind || snapshot(row).kind) === filters.kind; });
    var projects = S.projects || [], more = !!(S.completionMeta && S.completionMeta.has_more), disabled = queryBusy || pageBusy ? ' disabled' : '';
    return '<section class="card completion-queue"><div class="cardhd"><h3>' + (all ? '事项完成与延期审核' : '我的事项申请') + '<span class="chip">已加载匹配 ' + selected.length + ' 项</span></h3></div>'
      + '<p class="muted">按事项与承办人逐条审核。完成申请通过才销项；延期批准仅更新执行截止时间，事项继续办理。</p><div class="completion-filters">'
      + '<label>项目<select onchange="CompletionReview.filter(\'project_id\',this.value)"' + disabled + '>' + filterOptions(projects.map(function (p) { return [p.id, p.name || p.id]; }), filters.project_id, '全部项目') + '</select></label>'
      + '<label>事项类型（已加载范围）<select onchange="CompletionReview.filter(\'kind\',this.value)"' + disabled + '>' + filterOptions(Object.keys(KIND).map(function (k) { return [k, KIND[k]]; }), filters.kind, '全部类型') + '</select></label>'
      + '<label>审核状态<select onchange="CompletionReview.filter(\'status\',this.value)"' + disabled + '>' + filterOptions(['pending', 'approved', 'rejected', 'withdrawn', 'reopened'].map(function (k) { return [k, LABEL[k]]; }), filters.status, '全部状态') + '</select></label></div>'
      + (queueError ? '<p class="completion-error" role="alert">' + esc(queueError) + '；已加载记录保留。</p>' : '')
      + (queryBusy ? '<p role="status">正在按筛选条件读取审核记录…</p>' : selected.length ? '<div class="tablewrap"><table><thead><tr><th>事项与来源</th><th>承办人</th><th>申报类别／日期</th><th>审核状态</th><th>操作</th></tr></thead><tbody>' + selected.map(function (row) {
        var source = snapshot(row), token = register(row.source_key, { owner_id: row.owner_id, readOnly: readonly || role() === 'ops' && !canReview(row), id: row.id });
        return '<tr><td><b>' + esc(source.title || row.title || '工作事项') + '</b><div class="completion-source-content">' + sourceWhat(source, row) + '</div>'
          + '<small class="muted">' + esc(KIND[source.kind || row.kind] || '工作事项') + ' · ' + esc(source.due || row.due || '未设最晚时间') + '</small></td><td>' + esc(row.owner_name || row.owner_id) + '</td>'
          + '<td><span class="completion-request-kind">' + (isExtension(row) ? '申请延期' : row.completion_category ? categoryLabel(row) : '完成申请')
          + '</span><div>' + esc(isExtension(row) ? row.requested_due || '—' : row.completion_date || '—') + '</div></td><td>' + badgeRow(row) + '</td><td><button type="button" class="btn" onclick="CompletionReview.openKey(' + token + ')">' + (canReview(row) && row.status === 'pending' ? '审核' : '查看') + '</button></td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">' + (more ? '已加载范围内没有完成申请命中当前条件；后续记录尚未读取，可继续加载。' : '已加载范围内没有完成申请命中当前条件。') + '</div>')
      + '<div class="completion-pagination"><p class="muted">已加载 ' + allowed.length + ' 条审核记录' + (filters.kind ? '，当前类型匹配 ' + selected.length + ' 条' : '') + '。'
      + (more ? '还有后续记录，以上仅为已加载部分。' : S.completionMeta ? '当前查询已读取完毕。' : '') + '</p>'
      + (more ? '<button type="button" class="btn" onclick="CompletionReview.loadMore()"' + disabled + '>' + (pageBusy ? '正在加载…' : '加载更多审核记录') + '</button>' : '') + '</div></section>';
  }
  function snapshotsHtml(report) {
    if (!report) return '';
    var followups = report.biz && report.biz.followups;
    var keys = new Set((Array.isArray(followups) ? followups : []).filter(function (r) { return r && typeof r.source_key === 'string'; }).map(function (r) { return r.source_key; }));
    if(report.biz && report.biz.monthly_plan_id)(report.biz.items || []).forEach(function(item){
      if(item && item.source_id)keys.add('monthly:'+report.project_id+':'+report.biz.monthly_plan_id+':'+item.source_id);
    });
    var rows = (S.completions || []).filter(function (row) { return row && ((String(snapshot(row).report_id || row.report_id || '') === String(report.id) && (snapshot(row).report_id || row.report_id))
      || (row.owner_id === report.author_id && keys.has(row.source_key))); });
    if (!rows.length) return '';
    return '<section class="completion-readonly"><h4>当前完成审核状态</h4><p class="muted">以下为当前审核记录，原填报历史内容保留。</p>' + rows.map(function (row) {
      var source = snapshot(row);
      return '<article><b>' + esc(source.title || row.title || '工作事项') + '</b> ' + badgeRow(row) + '<div class="completion-source-content">' + sourceWhat(source, row) + '</div><p>承办人：' + esc(row.owner_name || row.owner_id) + (isExtension(row) ? ' · 申请延期至：' + esc(row.requested_due || '未填写') : ' · 实际完成：' + esc(row.completion_date || '未填写')) + '</p>'
        + '<p class="completion-source-content">' + richField(row, 'completion_note') + '</p>' + (row.review_note ? '<p class="completion-source-content">审核说明：' + richField(row, 'review_note') + '</p>' : '') + '</article>';
    }).join('') + '</section>';
  }
  function binding(id) {
    var m = modal, field = id === 'completion_note' ? 'completion_note' : id === 'completion_review_note' ? 'review_note' : null;
    if (!field || !m || !active(m)) return null;
    function editable() {
      if (!active(m) || m.busy || m.loading || m.readOnly) return false;
      if (field === 'review_note') return canReview(m.row) && ['pending', 'approved'].includes(m.row.status) && !(isExtension(m.row) && m.row.status === 'approved');
      return role() === 'pm' && m.owner_id === S.uid && (!m.row || !['pending', 'approved'].includes(m.row.status) || isExtension(m.row) && m.row.status === 'approved');
    }
    if (!editable()) return null;
    return { get: function () { return global.ZHRichText && global.ZHRichText.doc(m, field); },
      set: function (doc) { if (!editable() || !global.ZHRichText) return; m._rich = m._rich || {}; m._rich[field] = doc; m[field] = global.ZHRichText.text(doc); } };
  }
  global.CompletionReview = { configure: configure, binding: binding, badge: badge, actionHtml: actionHtml, approved: approved, completionFor: completionFor, effectiveDue: effectiveDue, renderQueue: renderQueue,
    loadInitiated: loadInitiated, renderInitiatedQueue: renderInitiatedQueue, filterInitiated: filterInitiated, moreInitiated: moreInitiated, refreshInitiated: refreshInitiated, invalidateInitiated: invalidateInitiated,
    snapshotsHtml: snapshotsHtml, overlayHtml: overlayHtml, open: open, openKey: openKey, close: close, refresh: refresh,
    request: requestCompletion, review: review, changeType: changeType, dateChanged: dateChanged, filter: setFilter, loadMore: loadMore };
})(window);

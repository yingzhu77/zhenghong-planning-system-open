/* Read-only baseline projection. Monthly plans and legacy handwritten rows are never baseline sources. */
(function (global) {
  'use strict';
  var cfg, S, identity, session, filters = Object.create(null);
  function configure(options) {
    if (identity !== options.S.uid || session !== options.S.session) filters = Object.create(null);
    cfg = options; S = options.S; identity = S.uid; session = S.session;
  }
  function esc(value) { return cfg.esc(value == null ? '' : String(value)); }
  function owns(value, key) { return Object.prototype.hasOwnProperty.call(value || {}, key); }
  function date(value) { return typeof value === 'string' ? value.slice(0, 10) : ''; }
  function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && global.PlanningWindows.addDays(value, 0) === value;
  }
  function ids(options) { return (options.projectIds || [options.projectId]).filter(function (id) { return id != null; }).map(String); }
  function filterKey(options) { return JSON.stringify([ids(options), options.commercial !== false, options.line, options.discipline, !!options.personal, !!options.unassignedOnly]); }
  function keyOnly(options) {
    if (owns(options, 'keyOnly')) return !!options.keyOnly;
    return options.commercial === false ? true : filters[filterKey(options)] === 'key';
  }
  function reportStart(report) {
    return global.PlanningWindows.periodStart(report.period, report.submitted_at || report.created_at);
  }
  function nodeEntries(report) {
    if (report.biz && Array.isArray(report.biz.nodes)) return { nodes: report.biz.nodes, path: 'biz.nodes.' };
    return { nodes: Array.isArray(report.node_items) ? report.node_items : [], path: 'node_items.' };
  }
  function feedbackKey(projectId, milestoneId) { return JSON.stringify([String(projectId), String(milestoneId)]); }
  function compareFeedback(a, b) { return b.start.localeCompare(a.start)
    || String(b.record.updated_at || b.record.submitted_at || '').localeCompare(String(a.record.updated_at || a.record.submitted_at || ''))
    || String(a.record.id).localeCompare(String(b.record.id)); }
  // Rebuilt for each projection so edits, drafts and permission-driven reloads never reuse old feedback.
  function feedbackIndex(options, milestones) {
    var cutoff = options.weekStart || options.window.start, found = new Map();
    var needed = new Set(milestones.map(function (row) { return feedbackKey(row.project_id, row.id); }));
    (options.reports || S.reports || []).forEach(function (report) {
      var start = reportStart(report);
      if (!start || start > cutoff) return;
      var entries = nodeEntries(report);
      entries.nodes.forEach(function (node, index) {
        if (!node || node.milestone_id == null) return;
        var key = feedbackKey(node.project_id || report.project_id, node.milestone_id);
        if (!needed.has(key)) return;
        var match = found.get(key);
        if (!match) { match = { current: null, latest: null }; found.set(key, match); }
        var entry = { node: node, record: report, path: entries.path + index + '.', period: report.period, start: start };
        if (!match.latest || compareFeedback(entry, match.latest) < 0) match.latest = entry;
        if (start === cutoff && (!match.current || compareFeedback(entry, match.current) < 0)) match.current = entry;
      });
    });
    if (global.PlanningWindows.periodStart(S.pmPeriod, S.pmReport && (S.pmReport.submitted_at || S.pmReport.created_at)) === cutoff) {
      var liveKeys = new Set();
      (S.bizNodes || []).forEach(function (node) {
        if (!node || node.milestone_id == null) return;
        var key = feedbackKey(node.project_id || S.pmProject, node.milestone_id);
        if (!needed.has(key) || liveKeys.has(key)) return;
        liveKeys.add(key);
        var match = found.get(key);
        if (!match) { match = { current: null, latest: null }; found.set(key, match); }
        match.current = { node: node, record: node, path: '', period: S.pmPeriod, start: cutoff, draft: !!S.draftRestored || !S.pmReport };
      });
    }
    return found;
  }
  function feedbackFor(milestone, index) {
    var match = index.get(feedbackKey(milestone.project_id, milestone.id));
    return { current: match && match.current || null, previous: match && !match.current && match.latest || null };
  }
  function coreState(options) {
    options = options || {};
    var read = options.baselineState || (cfg.baselineState ? cfg.baselineState() : { ready: true }), windows = global.PlanningWindows;
    if (read && read.error) return { status: 'error', message: '项目基准节点读取失败：' + read.error, rows: [] };
    if (!read || !read.ready) return { status: 'loading', message: '项目基准节点正在读取，请稍后刷新。', rows: [] };
    if (!windows || !options.window || !validDate(options.window.start) || !validDate(options.window.exclusiveEnd))
      return { status: 'window', message: '当前周期无法确定有效时间窗，请重新选择周期后刷新。', rows: [] };
    var projectIds = ids(options), commercial = options.commercial !== false;
    var projectRows = (S.milestones || []).filter(function (row) { return row && projectIds.indexOf(String(row.project_id)) >= 0; });
    if (!projectRows.length) return { status: 'not-imported', message: '尚未导入项目基准节点', rows: [] };
    var selected = commercial ? options.line : options.discipline;
    var scoped = projectRows.filter(function (row) {
      var scope = windows.scopeOf(row, commercial);
      if (options.unassignedOnly || options.line === null && commercial) return !scope;
      if (!scope) return !!options.includeUnassigned;
      return !!options.allScopes || !!selected && scope === selected;
    });
    if (!scoped.length) return { status: 'no-scope', message: options.unassignedOnly ? '暂无未分配模块的项目基准节点。'
      : '当前' + (commercial ? '商业模块' : '专业') + '暂无明确匹配的项目基准节点。', rows: [] };
    var missing = scoped.filter(function (row) { return !validDate(date(row.plan_date)); }).length;
    var due = scoped.filter(function (row) { var plan = date(row.plan_date); return validDate(plan) && plan >= options.window.start && plan < options.window.exclusiveEnd; });
    var filtered = due.filter(function (row) { return !keyOnly(options) || !!row.is_key; });
    if (!filtered.length) return { status: due.length ? 'no-key' : missing === scoped.length ? 'missing-date' : 'no-window', missingDate: missing,
      message: due.length ? '当前窗口暂无关键基准节点，可切换为全部节点。'
        : missing === scoped.length ? '当前范围的项目基准节点尚未填写有效计划日期，不能纳入当前窗口。'
        : '当前' + (options.personal ? '周窗' : '滚动月窗') + '暂无到期的项目基准节点。', rows: [] };
    var feedbackBySource = options.personal ? feedbackIndex(options, filtered) : null;
    var rows = filtered.slice().sort(function (a, b) { return date(a.plan_date).localeCompare(date(b.plan_date))
      || String(a.project_id).localeCompare(String(b.project_id)) || (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(a.id).localeCompare(String(b.id)); })
      .map(function (milestone) { var feedback = options.personal ? feedbackFor(milestone, feedbackBySource) : {current:null,previous:null}; return { milestone: milestone,
        sourceKey: 'milestone:' + milestone.project_id + ':' + milestone.id, current: feedback.current, previous: feedback.previous }; });
    return { status: 'ready', rows: rows, missingDate: missing };
  }
  function coreRows(options) { return coreState(options).rows; }
  function field(record, path, fallback) { return cfg.richItem ? cfg.richItem(record, path, fallback) : esc(String(path).split('.').reduce(function (row, key) { return row == null ? null : row[key]; }, record) || fallback || ''); }
  function feedbackText(entry, key) {
    var actual = key === 'prog' && !owns(entry.node, 'prog') && owns(entry.node, 'reason') ? 'reason' : key;
    return entry.node[actual] == null || entry.node[actual] === '' ? '<span class="muted">原反馈留空</span>' : field(entry.record, entry.path + actual);
  }
  function feedbackHtml(row, key) {
    if (row.current) return feedbackText(row.current, key) + '<div class="muted">节点反馈 · ' + esc(row.current.period)
      + (row.current.draft ? ' · 本机草稿' : ' · 原记录') + '</div>';
    var html = '<span class="muted">本周未提供节点反馈</span>';
    if (row.previous) html += '<details><summary>原节点历史反馈（' + esc(row.previous.period) + '）</summary>' + feedbackText(row.previous, key) + '</details>';
    return html;
  }
  function projectName(id) { var project = (S.projects || []).filter(function (row) { return String(row.id) === String(id); })[0]; return project && project.name || id; }
  function coreHtml(options) {
    options = options || {};
    var result = coreState(options), personal = !!options.personal, commercial = options.commercial !== false;
    var filter = commercial && options.filterControl !== false ? '<label class="muted">节点范围 <select aria-label="核心基准节点范围" data-scope="' + esc(filterKey(options))
      + '" onchange="BaselineCore.setKeyOnly(this.value,this.dataset.scope)"><option value="all"' + (!keyOnly(options) ? ' selected' : '')
      + '>全部节点</option><option value="key"' + (keyOnly(options) ? ' selected' : '') + '>仅关键节点</option></select></label>' : '';
    var note = '';
    if (result.status !== 'ready') return filter + note + '<p class="' + (result.status === 'error' ? 'notice warn' : 'empty')
      + '" role="status" data-baseline-status="' + esc(result.status) + '">' + esc(result.message) + '</p>'
      + (result.missingDate && result.status !== 'missing-date' ? '<p class="muted">另有 ' + result.missingDate + ' 个当前范围节点缺有效计划日期，未计入到期窗口。</p>' : '');
    var body = result.rows.map(function (row) {
      var m = row.milestone;
      var supplement = !personal && (m.standard || m.note) ? '<details><summary>基准补充信息</summary>'
        + (m.standard ? '<div class="muted">完成标准：' + field(m, 'standard') + '</div>' : '')
        + (m.note ? '<div class="muted">节点说明（原保存）：' + field(m, 'note') + '</div>' : '') + '</details>' : '';
      return '<tr data-source-key="' + esc(row.sourceKey) + '" data-source-project-id="' + esc(m.project_id) + '"><td data-label="实际项目／模块">'
        + esc(projectName(m.project_id)) + '<div class="muted">' + esc(global.PlanningWindows.scopeOf(m, commercial) || '未分配')
        + '</div></td><td data-label="基准节点">' + field(m, 'name') + (m.is_key ? ' <span class="chip key">关键</span>' : '')
        + (m.done ? '<div class="muted">基准已标记完成</div>' : '') + (personal && m.standard ? '<div class="muted">完成标准：' + field(m, 'standard') + '</div>' : '') + supplement
        + '</td><td data-label="原计划完成日">' + esc(date(m.plan_date)) + '</td><td data-label="预计完成日（原保存）">' + esc(date(m.forecast_date) || '未填写')
        + '</td>' + (personal ? '<td data-label="节点说明（原保存）">' + (m.note ? field(m, 'note') : '<span class="muted">未填写节点说明</span>')
          + '</td><td data-label="当周节点进展">' + feedbackHtml(row, 'prog') + '</td><td data-label="当周节点卡点">' + feedbackHtml(row, 'blocker') + '</td>' : '') + '</tr>';
    }).join('');
    return filter + note + (result.missingDate ? '<p class="muted">另有 ' + result.missingDate + ' 个当前范围节点缺有效计划日期，未计入到期窗口。</p>' : '')
      + '<div class="' + (personal ? 'tablewrap' : 'overview-table-scroll') + '"><table class="' + (personal ? 'plan-form-table' : 'overview-data-table')
      + '" data-section="nodes"><thead><tr><th>实际项目<br>模块／专业</th><th>基准节点</th><th>原计划完成日</th><th>预计完成日<br><small>原保存</small></th>'
      + (personal ? '<th>节点说明<br><small>原保存</small></th><th>当周节点进展</th><th>当周节点卡点</th>' : '') + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }
  function personalOptions(options) {
    options = options || {};
    var report = S.pmReport || {}, start = global.PlanningWindows.periodStart(S.pmPeriod, report.submitted_at || report.created_at);
    return Object.assign({ projectId: S.pmProject, line: S.pmLine, commercial: true, personal: true,
      window: global.PlanningWindows.windowFor(start, 'week') }, options);
  }
  function personalCoreHtml(options) { return coreHtml(personalOptions(options)); }
  function setKeyOnly(value, scope) {
    if (value !== 'all' && value !== 'key') return;
    if (cfg.flush) cfg.flush();
    filters[scope] = value;
    if (cfg.render) cfg.render();
  }
  global.BaselineCore = { configure: configure, coreState: coreState, coreRows: coreRows, coreHtml: coreHtml,
    personalCoreHtml: personalCoreHtml, personalOptions: personalOptions, setKeyOnly: setKeyOnly };
})(window);

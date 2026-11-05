/* Current plan inventory. Every visible aggregate and export uses one server-filtered result. */
(function (global) {
  'use strict';
  var cfg, S, identity, sessionIdentity, filters, data = null, dataKey = '', catalog = null;
  var generation = 0, busy = false, error = '', pending = null;
  var RISK = { severe: '严重偏差', attention: '关注', slight: '轻微偏差', normal: '无预计延期', insufficient: '日期不足', overdue: '当前逾期', completed: '已完成', unknown: '无法判断' };
  var DATE = { all: '全部计划日期', week: '本周', month: '本月', next30: '未来30天', custom: '自定义' };
  function today() {
    var found = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).forEach(function (part) { found[part.type] = part.value; });
    return found.year + '-' + found.month + '-' + found.day;
  }
  function defaults() { return { display_group: '', project_id: '', discipline: '', key_only: false, level: '', completion: 'all', risk: 'all', date_mode: 'all', start: '', end: '' }; }
  function configure(options) {
    var changed = identity !== options.S.uid || sessionIdentity !== options.S.session;
    cfg = options; S = options.S;
    if (changed || !filters) {
      identity = S.uid; sessionIdentity = S.session; filters = defaults(); catalog = null; invalidate();
    }
  }
  function esc(value) { return cfg.esc(value == null ? '' : value); }
  function allowed() { return !!(S && S.profile && ['ops', 'president', 'pzo'].includes(S.profile.role)); }
  function query() {
    var result = { kind: 'all', completion: filters.completion, risk: filters.risk, date_mode: filters.date_mode, key_only: filters.key_only };
    ['display_group', 'project_id', 'discipline', 'level'].forEach(function (name) { if (filters[name]) result[name] = filters[name]; });
    if (filters.date_mode === 'custom') { result.start = filters.start; result.end = filters.end; }
    return result;
  }
  function key() { return JSON.stringify(query()); }
  function validDay(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) === '0000') return false;
    var date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function validation() {
    if (filters.date_mode === 'custom' && (!validDay(filters.start) || !validDay(filters.end) || filters.start > filters.end)) return '请填写有效的计划起止日期，开始日期不可晚于结束日期。';
    return '';
  }
  function invalidate() { generation++; data = null; dataKey = ''; busy = false; pending = null; error = ''; }
  async function load(force) {
    if (!allowed()) return { data: null, error: { message: '仅获授权管理角色可查看项目计划统计。' } };
    var wanted = key(), problem = validation();
    if (problem) { error = problem; return { data: null, error: { message: problem } }; }
    if (!force && busy && pending && pending.key === wanted) return pending.promise;
    if (!force && data && dataKey === wanted) return { data: data, error: null };
    var epoch = ++generation, uid = S.uid, session = S.session, request = query(), activeCfg = cfg;
    function live() { return epoch === generation && S.uid === uid && S.session === session && allowed() && key() === wanted; }
    busy = true; error = '';
    var promise = (async function () {
      try {
        var result = await activeCfg.request('/api/project-plan-statistics', request);
        if (!live()) return { data: null, error: { message: '统计条件或登录状态已变化，请重新查询。', code: 'stale_statistics' } };
        if (!result || result.error) throw new Error(result && result.error && result.error.message || '项目计划统计读取失败，请重试。');
        var value = result.data;
        if (!value || !Array.isArray(value.rows) || !Array.isArray(value.projects) || !value.totals || !value.options || !value.filters) throw new Error('项目计划统计结果不完整，请刷新重试。');
        data = value; dataKey = wanted; catalog = value.options; return { data: value, error: null };
      } catch (err) {
        if (live()) error = err.message || '项目计划统计读取失败，请重试。';
        return { data: null, error: { message: err.message || '项目计划统计读取失败，请重试。' } };
      } finally { if (live()) { busy = false; pending = null; } }
    })();
    pending = { key: wanted, promise: promise }; return promise;
  }
  async function refresh() {
    if (!allowed()) return;
    var uid = S.uid, session = S.session, view = S.view, task = load(true);
    cfg.render();
    var result = await task;
    if (S.uid === uid && S.session === session && S.view === view && allowed()) cfg.render();
    return result;
  }
  function setFilter(field, value) {
    if (!allowed() || !Object.prototype.hasOwnProperty.call(filters, field)) return;
    generation++; busy = false; pending = null; error = '';
    filters[field] = field === 'key_only' ? value === true || value === 'true' : String(value || '');
    if (field === 'display_group') filters.project_id = '';
    if (field === 'date_mode' && value === 'custom' && !filters.start && !filters.end) filters.start = filters.end = today();
    if (['start', 'end'].includes(field) || field === 'date_mode' && value === 'custom') { cfg.render(); return; }
    return refresh();
  }
  function reset() { if (!allowed()) return; filters = defaults(); return refresh(); }
  function optionHtml(entries, selected, all) {
    return (all == null ? '' : '<option value="">' + esc(all) + '</option>') + entries.map(function (item) {
      return '<option value="' + esc(item[0]) + '"' + (String(item[0]) === String(selected) ? ' selected' : '') + '>' + esc(item[1]) + '</option>';
    }).join('');
  }
  function select(field, label, entries, all) {
    return '<label>' + esc(label) + '<select aria-label="' + esc(label) + '" onchange="ProjectPlanStatistics.filter(\'' + field + '\',this.value)">' + optionHtml(entries, filters[field], all) + '</select></label>';
  }
  function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
  function rate(value) { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)).toFixed(1).replace(/\.0$/, '') + '%' : '—'; }
  function due(value) { return value || '日期不足'; }
  function projectType(row) {
    return row.project_type === 'com' ? '商业' : row.project_type === 'res' ? '住宅' : '';
  }
  function completion(row) { return row.completed ? row.completion_basis === 'legacy' ? '历史完成标记' : '有效审核完成' : '未完成'; }
  function timeliness(row) { return !row.completed ? '—' : row.on_time === true ? '按时完成' : row.on_time === false ? '延期完成' : '无法判断按时性'; }
  function riskName(row) {
    if (row.completed) return '已完成';
    return RISK[row.risk] || '无法判断';
  }
  function deviation(row) { return row.completed ? '—' : typeof row.deviation === 'number' ? row.deviation > 0 ? '+' + row.deviation + '天' : row.deviation < 0 ? row.deviation + '天' : '0天' : '无法判断'; }
  function filtersHtml() {
    var menus = catalog || {};
    var projects = (menus.projects || []).filter(function (p) { return !filters.display_group || (p.display_group || p.name) === filters.display_group; });
    return '<div class="project-statistics-filters">'
      + select('display_group', '项目展示组', (menus.groups || []).map(function (g) { return [g, g]; }), '全部展示组')
      + select('project_id', '实际项目／分期', projects.map(function (p) { return [p.id, p.name || p.id]; }), '全部实际项目')
      + select('discipline', '专业 / 模块', (menus.disciplines || []).map(function (v) { return [v, v]; }), '全部专业 / 模块')
      + select('key_only', '节点范围', [['false', '全部'], ['true', '仅关键节点']], null)
      + ((menus.levels || []).length ? select('level', '层级', menus.levels.map(function (v) { return [v, v]; }), '全部层级') : '')
      + select('completion', '完成状态', [['all', '全部状态'], ['completed', '已完成'], ['incomplete', '未完成']], null)
      + select('risk', '风险／数据', [['all', '全部'], ['severe', '严重偏差（≥15天）'], ['attention', '关注（5–14天）'], ['slight', '轻微偏差（1–4天）'], ['normal', '无预计延期'], ['insufficient', '日期不足'], ['overdue', '当前逾期']], null)
      + select('date_mode', '原计划完成日', Object.keys(DATE).map(function (v) { return [v, DATE[v]]; }), null)
      + (filters.date_mode === 'custom' ? '<label>计划开始日<input type="date" value="' + esc(filters.start) + '" onchange="ProjectPlanStatistics.filter(\'start\',this.value)"></label><label>计划结束日<input type="date" value="' + esc(filters.end) + '" onchange="ProjectPlanStatistics.filter(\'end\',this.value)"></label>' : '')
      + '<div class="project-statistics-query"><button type="button" class="btn primary" onclick="ProjectPlanStatistics.refresh()"' + (busy ? ' disabled' : '') + '>查询</button><button type="button" class="btn" onclick="ProjectPlanStatistics.reset()">重置</button></div></div>';
  }
  function totalsHtml(totals) {
    var measures = [['total', '基准节点总量'], ['completed', '已完成节点'], ['incomplete', '未完成'], ['overdue', '当前逾期'], ['forecast_delayed', '预计延期'], ['due_next30', '未来30天到期'], ['insufficient', '日期不足']];
    return '<div class="project-statistics-totals">' + measures.map(function (item) { return '<div><span>' + item[1] + '</span><strong>' + count(totals[item[0]]) + '</strong></div>'; }).join('') + '</div>'
      + '<div class="project-statistics-rates"><p><b title="按节点数量计算，不代表工程实体进度">节点完成比例 ' + rate(totals.completion_rate) + '</b><span>' + count(totals.completed) + ' / ' + count(totals.total) + ' 个基准节点</span></p>'
      + '<p><b title="仅使用真实完成日和可核验截止日计算">按时完成 ' + (totals.timeliness_covered ? rate(count(totals.on_time) / totals.timeliness_covered * 100) : '—') + '</b><span>可核验 ' + count(totals.timeliness_covered) + ' 项 · 无法判断按时性 ' + count(totals.timeliness_unknown) + ' 项</span></p></div>';
  }
  function projectsHtml(projects) {
    return '<section class="project-statistics-comparison"><h4 title="逾期、预计延期及日期不足可相互重叠">项目对比</h4>'
      + (projects.length ? '<div class="tablewrap" tabindex="0" aria-label="项目对比表，可横向滚动"><table><thead><tr><th>项目展示组</th><th>实际项目／分期</th><th>完成比例</th><th>完成／总量</th><th>当前逾期</th><th>日期不足</th></tr></thead><tbody>'
        + projects.map(function (project) { var width = typeof project.completion_rate === 'number' && Number.isFinite(project.completion_rate) ? Math.max(0, Math.min(100, project.completion_rate)) : 0;
          return '<tr><td>' + esc(project.display_group || project.name) + '</td><td>' + esc(project.name) + (projectType(project) ? '<small>' + projectType(project) + '</small>' : '') + '</td><td><div class="project-statistics-bar"><span aria-hidden="true"><i style="width:' + width + '%"></i></span><b>' + rate(project.completion_rate) + '</b></div></td><td>' + count(project.completed) + ' / ' + count(project.total) + '</td><td>' + count(project.overdue) + '</td><td>' + count(project.insufficient) + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="empty">当前筛选没有计划记录。</div>') + '</section>';
  }
  function rowsHtml(rows) {
    var heads = ['项目／分期', '专业 / 模块／层级', '基准节点', '原计划日', '有效截止日', '预计完成日', '预计偏差', '完成状态', '实际完成日', '按时性', '风险／数据'];
    return '<section class="project-statistics-details"><h4>计划明细 <span class="muted">' + rows.length + ' 项</span></h4><p class="muted project-statistics-scrollhint">横向滚动查看全部列</p><div class="tablewrap" tabindex="0" aria-label="计划明细表，可横向滚动"><table><thead><tr>' + heads.map(function (head) { return '<th>' + head + '</th>'; }).join('') + '</tr></thead><tbody>'
      + (rows.length ? rows.map(function (row) {
        return '<tr><td><strong>' + esc(row.project_name) + '</strong><small>' + esc([projectType(row), row.display_group].filter(Boolean).join(' · ')) + '</small></td><td>' + esc(row.discipline || row.module || '未归属') + (row.module && row.module !== row.discipline ? '<small>' + esc(row.module) + '</small>' : '') + (row.level ? '<small>' + esc(row.level) + '</small>' : '') + '</td><td class="project-statistics-title">' + esc(row.title) + (row.is_key ? '<small>关键节点</small>' : '') + '</td>'
          + '<td>' + esc(due(row.plan_due)) + '</td><td>' + esc(due(row.effective_due)) + (row.extension_approved ? '<small>已批准延期</small>' : '') + '</td>'
          + '<td>' + esc(row.completed ? '—' : due(row.forecast_due)) + '</td><td>' + esc(deviation(row)) + '</td>'
          + '<td>' + completion(row) + '</td><td>' + esc(row.completion_date || '—') + '</td><td>' + timeliness(row) + '</td><td><span class="project-statistics-risk risk-' + esc(row.completed ? 'completed' : row.risk || 'unknown') + '">' + esc(riskName(row)) + '</span>' + (row.overdue && !row.completed ? '<small class="project-statistics-overdue">当前逾期</small>' : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="' + heads.length + '" class="empty">当前筛选没有计划记录。</td></tr>') + '</tbody></table></div></section>';
  }
  function pageHtml() {
    if (!allowed()) return '<section class="card"><div class="empty">仅获授权管理角色可查看项目计划统计。</div></section>';
    var current = data && dataKey === key() ? data : null;
    var html = '<section class="card project-plan-statistics"><div class="cardhd"><h3>项目计划统计</h3><button type="button" class="btn" onclick="ProjectPlanStatistics.exportCsv()"' + (!current || busy || error ? ' disabled' : '') + '>导出当前明细</button></div>'
      + filtersHtml();
    if (error) html += '<p class="project-statistics-error" role="alert">' + esc(error) + '</p>';
    if (busy) html += '<p role="status" aria-live="polite">正在汇总授权项目范围内的计划…</p>';
    if (current && !error) {
      html += '<p class="project-statistics-scope">当前状态：<b>' + esc(current.today) + '</b> · ' + count(current.totals.group_count) + ' 个展示组 / ' + count(current.totals.project_count) + ' 个实际项目／分期 · 原计划日：' + esc(DATE[filters.date_mode] || '')
        + (filters.date_mode === 'custom' ? ' ' + esc(filters.start) + ' 至 ' + esc(filters.end) : '') + '</p>'
        + totalsHtml(current.totals) + projectsHtml(current.projects) + rowsHtml(current.rows);
    } else if (!busy && !error) html += '<div class="empty">点击查询读取当前计划统计。</div>';
    return html + '</section>';
  }
  function csvCell(value) {
    var text = String(value == null ? '' : value);
    // Quoting alone does not prevent spreadsheet formula execution.
    if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function csvText() {
    var current = data && dataKey === key() && !busy && !error ? data : null;
    if (!current || !allowed()) return '';
    var heads = ['盘点日期', '统计来源', '项目展示组', '实际项目／分期', '项目ID', '专业／商业模块', '层级', '事项名称', '来源ID', '来源键', '关键节点', '原计划日', '有效截止日', '批准延期', '预计完成日', '预计偏差天数', '完成状态', '实际完成日', '按时性', '风险／数据', '当前逾期', '未来30天到期', '日期不足'];
    var lines = [heads.map(csvCell).join(',')];
    current.rows.forEach(function (row) {
      lines.push([current.today, (projectType(row) || '项目') + '基准节点', row.display_group, row.project_name, row.project_id, row.discipline || row.module, row.level, row.title, row.source_id, row.source_key, row.is_key ? '是' : '否', row.plan_due, row.effective_due, row.extension_approved ? '是' : '否', row.forecast_due, row.completed || row.deviation == null ? '' : row.deviation, completion(row), row.completion_date, timeliness(row), riskName(row), row.overdue ? '是' : '否', row.due_next30 ? '是' : '否', row.insufficient ? '是' : '否'].map(csvCell).join(','));
    });
    return '\uFEFF' + lines.join('\r\n');
  }
  function exportCsv() {
    var text = csvText();
    if (!text) { if (cfg.toast) cfg.toast('请先查询当前筛选条件后再导出。', 'err'); return false; }
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8;' }), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = '项目计划统计_' + (data.today || today()) + '.csv';
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 0); return true;
  }
  global.ProjectPlanStatistics = { configure: configure, pageHtml: pageHtml, load: load, refresh: refresh, filter: setFilter, reset: reset, invalidate: invalidate, exportCsv: exportCsv, csvText: csvText };
})(window);

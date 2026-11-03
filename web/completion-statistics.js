/* Employee counts are aggregated by the server over the complete scope. */
(function (global) {
  'use strict';
  var cfg, S, identity, sessionIdentity, generation = 0, data = null, dataKey = '', catalog = null;
  var filters = null, busy = false, error = '', pending = null;
  var COUNT = ['completed', 'on_time', 'late', 'undetermined', 'pending', 'extension_requested', 'extension_approved'];
  var HEAD = ['已审完成', '按时完成', '延期完成', '无法判定', '完成待审', '延期申请', '延期批准'];

  function shanghaiToday() {
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    var found = {};
    parts.forEach(function (part) { found[part.type] = part.value; });
    return found.year + '-' + found.month + '-' + found.day;
  }
  function iso(day) { return day.toISOString().slice(0, 10); }
  function period(mode) {
    var today = new Date(shanghaiToday() + 'T00:00:00Z'), start, end;
    if (mode === 'month') {
      start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
    } else {
      start = new Date(today); start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
      end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
    }
    return { start: iso(start), end: iso(end) };
  }
  function defaults() { return Object.assign({ project_id: '', owner_id: '', discipline: '', kind: '' }, period('week')); }
  function configure(options) {
    var changed = identity !== options.S.uid || sessionIdentity !== options.S.session;
    cfg = options; S = options.S;
    if (changed) {
      identity = S.uid; sessionIdentity = S.session; generation++;
      filters = defaults(); data = null; dataKey = ''; catalog = null; busy = false; error = ''; pending = null;
    }
  }
  function esc(value) { return cfg.esc(value == null ? '' : value); }
  function allowed() { return !!(S && S.profile && S.profile.role === 'ops'); }
  function query() {
    var result = { start: filters.start, end: filters.end };
    ['project_id', 'owner_id', 'discipline', 'kind'].forEach(function (key) { if (filters[key]) result[key] = filters[key]; });
    return result;
  }
  function key() { return JSON.stringify(query()); }
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && iso(date) === value;
  }
  async function load(force) {
    if (!allowed()) return { data: null, error: { message: '仅运营可查看员工事项完成统计。' } };
    var wanted = key();
    if (!force && busy && pending && pending.key === wanted) return pending.promise;
    if (!force && data && dataKey === wanted) return { data: data, error: null };
    if (!validDate(filters.start) || !validDate(filters.end) || filters.start > filters.end) {
      error = '请填写有效的起止日期，开始日期不可晚于结束日期。';
      return { data: null, error: { message: error } };
    }
    var epoch = ++generation, uid = S.uid, session = S.session, request = query(), activeCfg = cfg;
    function live() { return epoch === generation && S.uid === uid && S.session === session && allowed() && key() === wanted; }
    busy = true; error = '';
    var promise = (async function () {
      try {
        var result = await activeCfg.request('/api/completions/statistics', request);
        if (!live()) return { data: null, error: { message: '统计条件已变化，请重新查询。', code: 'stale_statistics' } };
        if (!result || result.error) throw new Error(result && result.error && result.error.message || '员工统计读取失败，请重试。');
        var value = result.data;
        if (!value || !Array.isArray(value.employees) || !value.totals || !value.filters || !value.range) throw new Error('员工统计结果不完整，请刷新重试。');
        data = value; dataKey = wanted; catalog = value.filters; return { data: value, error: null };
      } catch (err) {
        if (live()) error = err.message || '员工统计读取失败，请重试。';
        return { data: null, error: { message: err.message || '员工统计读取失败，请重试。' } };
      } finally {
        if (live()) { busy = false; pending = null; }
      }
    })();
    pending = { key: wanted, promise: promise };
    return promise;
  }
  async function refresh() {
    if (!allowed()) return;
    var uid = S.uid, session = S.session, view = S.view, task = load(true);
    cfg.render();
    var result = await task;
    if (S.uid === uid && S.session === session && S.view === view && allowed()) cfg.render();
    return result;
  }
  function invalidate() {
    generation++; data = null; dataKey = ''; busy = false; pending = null; error = '';
  }
  function setFilter(field, value) {
    if (!allowed() || !Object.prototype.hasOwnProperty.call(filters, field)) return;
    generation++; busy = false; pending = null; error = '';
    filters[field] = String(value || '');
    if (field === 'start' || field === 'end') { cfg.render(); return; }
    return refresh();
  }
  function setPeriod(mode) {
    if (!allowed() || !['week', 'month'].includes(mode)) return;
    Object.assign(filters, period(mode)); return refresh();
  }
  function options(entries, selected, label) {
    var seen = entries.some(function (entry) { return String(entry[0]) === selected; });
    return '<option value="">' + esc(label) + '</option>'
      + (selected && !seen ? '<option value="' + esc(selected) + '" selected>' + esc(selected) + '</option>' : '')
      + entries.map(function (entry) { return '<option value="' + esc(entry[0]) + '"' + (String(entry[0]) === selected ? ' selected' : '') + '>' + esc(entry[1]) + '</option>'; }).join('');
  }
  function select(field, label, values, all) {
    return '<label>' + label + '<select onchange="CompletionStatistics.filter(\'' + field + '\',this.value)">' + options(values, filters[field], all) + '</select></label>';
  }
  function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
  function cells(counts) { return COUNT.map(function (field) { return '<td>' + count(counts && counts[field]) + '</td>'; }).join(''); }
  function categoryDetails(employee) {
    var counts = employee.counts || {}, categories = employee.categories || [];
    return '<details class="completion-statistics-details"><summary>按类别查看</summary><div class="completion-statistics-detailbody">'
      + '<p class="muted">退回 ' + count(counts.rejected) + ' · 撤回 ' + count(counts.withdrawn) + ' · 重新打开 ' + count(counts.reopened)
      + ' · 来源待核实 ' + count(counts.source_changed) + ' · 延期待审 ' + count(counts.extension_pending) + '</p>'
      + (categories.length ? '<div class="tablewrap"><table><thead><tr><th>事项类别</th>' + HEAD.map(function (head) { return '<th>' + head + '</th>'; }).join('')
        + '</tr></thead><tbody>' + categories.map(function (category) { return '<tr><td>' + esc(category.label || category.kind) + '</td>' + cells(category.counts) + '</tr>'; }).join('')
        + '</tbody></table></div>' : '<p class="muted">所选范围内暂无申报记录。</p>') + '</div></details>';
  }
  function pageHtml() {
    if (!allowed()) return '<section class="card"><div class="empty">仅运营可查看员工事项完成统计。</div></section>';
    if (!filters) filters = defaults();
    var wanted = key();
    var current = data && dataKey === wanted ? data : null, menus = catalog || {}, totals = current && current.totals;
    var html = '<section class="card completion-statistics"><div class="cardhd"><h3>员工事项完成统计</h3><button type="button" class="btn" onclick="CompletionStatistics.refresh()"' + (busy ? ' disabled' : '') + '>刷新统计</button></div>'
      + '<p class="muted completion-statistics-explain">按实际完成日期归入所选区间，审核通过且来源仍有效的事项计入已审完成。协调事项由发起人审核，其他事项按原审核权限办理。按申请时保存的执行截止时间区分按时／延期；无有效截止日期单列无法判定。延期批准单独统计，事项继续办理。</p>'
      + '<div class="completion-statistics-period"><button type="button" class="btn" onclick="CompletionStatistics.period(\'week\')">本周</button><button type="button" class="btn" onclick="CompletionStatistics.period(\'month\')">本月</button><span class="muted">北京时间，含起止日</span></div>'
      + '<div class="completion-statistics-filters">'
      + '<label>开始日期<input type="date" value="' + esc(filters.start) + '" onchange="CompletionStatistics.filter(\'start\',this.value)"></label>'
      + '<label>结束日期<input type="date" value="' + esc(filters.end) + '" onchange="CompletionStatistics.filter(\'end\',this.value)"></label>'
      + select('project_id', '项目', (menus.projects || S.projects || []).map(function (p) { return [p.id, p.name || p.id]; }), '全部项目')
      + select('owner_id', '员工', (menus.employees || []).map(function (p) { return [p.user_id, p.name || p.user_id]; }), '全部员工')
      + select('discipline', '专业／模块', (menus.disciplines || []).map(function (name) { return [name, name]; }), '全部专业／模块')
      + select('kind', '事项类别', (menus.kinds || []).map(function (kind) { return [kind.id, kind.name]; }), '全部类别')
      + '<button type="button" class="btn primary" onclick="CompletionStatistics.refresh()"' + (busy ? ' disabled' : '') + '>查询</button></div>';
    if (error) html += '<p class="completion-statistics-error" role="alert">' + esc(error) + '</p>';
    if (busy) html += '<p role="status" aria-live="polite">正在汇总完整授权范围内的员工事项…</p>';
    if (current) {
      html += '<p class="completion-statistics-range">统计区间：<b>' + esc(current.range.start) + ' 至 ' + esc(current.range.end) + '</b> · ' + current.employees.length + ' 名员工（含零完成）</p>'
        + '<div class="completion-statistics-totals">' + [['completed', '已审完成'], ['on_time', '按时完成'], ['late', '延期完成'], ['undetermined', '无法判定']].map(function (item) {
          return '<div><span>' + item[1] + '</span><strong>' + count(totals[item[0]]) + '</strong></div>';
        }).join('') + '</div>'
        + '<div class="tablewrap completion-statistics-table"><table><thead><tr><th>员工</th><th>专业／模块</th>'
        + HEAD.map(function (head) { return '<th>' + head + '</th>'; }).join('') + '<th>类别明细</th></tr></thead><tbody>'
        + (current.employees.length ? current.employees.map(function (employee) {
          return '<tr><td>' + esc(employee.name || employee.user_id) + '</td><td>' + esc(employee.discipline || employee.biz_line || '—') + '</td>'
            + cells(employee.counts) + '<td>' + categoryDetails(employee) + '</td></tr>';
        }).join('') : '<tr><td colspan="10" class="empty">当前筛选下没有有效员工。</td></tr>') + '</tbody></table></div>'
        + '<p class="muted completion-statistics-footnote">数量来自服务端完整集合，按事项来源与承办人去重。延期申请／批准按申请日期归期；完成待审、退回、撤回、重开及来源待核实均不计入已审完成。历史审批继续保留。</p>';
    } else if (!busy && !error) html += '<div class="empty">请选择日期并点击查询。</div>';
    return html + '</section>';
  }
  global.CompletionStatistics = { configure: configure, pageHtml: pageHtml, load: load, invalidate: invalidate, refresh: refresh, filter: setFilter, period: setPeriod };
})(window);

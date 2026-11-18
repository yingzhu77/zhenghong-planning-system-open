/* Employee counts are aggregated by the server over the complete scope. */
(function (global) {
  'use strict';
  var cfg, S, identity, sessionIdentity, generation = 0, data = null, dataKey = '', catalog = null;
  var filters = null, busy = false, error = '', pending = null;
  var organization = null, search = '', openDivisions = new Set();
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
      organization = null; search = ''; openDivisions = new Set();
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
  function cells(counts) { return COUNT.map(function (field,index) {
    return '<td data-label="' + HEAD[index] + '">' + count(counts && counts[field]) + '</td>';
  }).join(''); }
  function directoryOrder(a,b) { return (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity) || 0; }
  function organizationLabel(person) {
    return [person.division, person.team===person.division?'':person.team, person.title].filter(Boolean).join(' · ');
  }
  function organizationSelected(division,team) {
    return division===undefined ? !organization : organization?.[0]===division && organization[1]===team;
  }
  function organizationTree(current) {
    if (!cfg.organizationTree) return '';
    return cfg.organizationTree([...(catalog?.employees || current.employees)].sort(directoryOrder),{
      idPrefix:'completionStatisticsTeams', label:'统计组织', open:openDivisions, selected:organizationSelected,
      filter:'CompletionStatistics.selectOrganization',toggle:'CompletionStatistics.toggleOrganization'
    });
  }
  function refreshResults(panel) {
    if (dataKey!==key() || !data || !panel) return;
    panel.querySelector('[data-statistics-results]').innerHTML = resultsHtml(data);
    panel.querySelectorAll('[data-organization-filter]').forEach(function(button){
      button.setAttribute('aria-pressed',String(organizationSelected(button.dataset.division,button.dataset.team)));
    });
  }
  function selectOrganization(button) {
    if (!allowed()) return;
    var {division,team}=button.dataset;
    organization=division===undefined ? null : [division,team];
    refreshResults(button.closest('.completion-statistics'));
  }
  function toggleOrganization(button) {
    if (!allowed()) return;
    var expanded=button.getAttribute('aria-expanded')==='false';
    if (expanded) openDivisions.add(button.dataset.division);
    else openDivisions.delete(button.dataset.division);
    button.setAttribute('aria-expanded',String(expanded));
    global.document.getElementById(button.getAttribute('aria-controls')).hidden=!expanded;
  }
  function searchName(input) {
    if (!allowed() || search===input.value) return;
    search=input.value;
    refreshResults(input.closest('.completion-statistics'));
  }
  function categoryDetails(employee) {
    var counts = employee.counts || {}, categories = employee.categories || [];
    return '<details class="completion-statistics-details"><summary>按类别查看</summary><div class="completion-statistics-detailbody">'
      + '<p class="muted">退回 ' + count(counts.rejected) + ' · 撤回 ' + count(counts.withdrawn) + ' · 重新打开 ' + count(counts.reopened)
      + ' · 来源待核实 ' + count(counts.source_changed) + ' · 延期待审 ' + count(counts.extension_pending) + '</p>'
      + (categories.length ? '<div class="completion-statistics-categories">' + categories.map(function (category) {
        return '<section><b>' + esc(category.label || category.kind) + '</b><dl>'
          + COUNT.map(function(field,index){return '<div><dt>'+HEAD[index]+'</dt><dd>'+count(category.counts?.[field])+'</dd></div>';}).join('')
          + '</dl></section>';
      }).join('') + '</div>' : '<p class="muted">所选范围内暂无申报记录。</p>') + '</div></details>';
  }
  function resultsHtml(current) {
    var needle=search.trim().toLocaleLowerCase();
    var employees=current.employees.filter(function(person){
      return (!organization || (person.division || '')===organization[0] && (!organization[1] || person.team===organization[1]))
        && (!needle || String(person.name || '').toLocaleLowerCase().includes(needle));
    }).sort(directoryOrder);
    var metrics=[['completed','已审完成'],['on_time','按时完成'],['late','延期完成'],['undetermined','无法判定']];
    var scopeLabel=organization ? [organization[0] || '未归类',organization[1]].filter(Boolean).join('／') : '全部人员';
    return '<p class="completion-statistics-range" role="status"><b>' + esc(current.range.start) + ' 至 ' + esc(current.range.end)
      + '</b> · ' + esc(scopeLabel) + (needle ? ' · 姓名包含“' + esc(search.trim()) + '”' : '')
      + ' · ' + employees.length + ' 名员工（含零完成）</p>'
      + '<div class="completion-statistics-totals">' + metrics.map(function (item) {
        var total=organization || needle ? employees.reduce(function(sum,person){return sum+count(person.counts?.[item[0]]);},0) : count(current.totals[item[0]]);
        return '<div><span>' + item[1] + '</span><strong>' + total + '</strong></div>';
      }).join('') + '</div>'
      + '<div class="tablewrap completion-statistics-table"><table><thead><tr><th scope="col">员工</th><th scope="col">专业／模块</th>'
      + HEAD.map(function (head) { return '<th scope="col">' + head + '</th>'; }).join('') + '<th scope="col">类别明细</th></tr></thead><tbody>'
      + (employees.length ? employees.map(function (person) {
        return '<tr data-statistics-employee="' + esc(person.user_id) + '"><td><b>' + esc(person.name || person.user_id) + '</b>'
          + '<small>' + esc(organizationLabel(person) || '未归类') + '</small></td>'
          + '<td data-label="专业／模块">' + esc(person.discipline || person.biz_line || '—') + '</td>'
          + cells(person.counts) + '<td>' + categoryDetails(person) + '</td></tr>';
      }).join('') : '<tr><td colspan="10" class="empty">当前筛选下没有符合条件的员工。</td></tr>') + '</tbody></table></div>'
      + '<p class="muted completion-statistics-footnote">延期申请和批准按申请日期统计。完成待审、退回、撤回、重开及来源待核实均不计入已审完成。</p>';
  }
  function pageHtml() {
    if (!allowed()) return '<section class="card"><div class="empty">仅运营可查看员工事项完成统计。</div></section>';
    if (!filters) filters = defaults();
    var wanted = key();
    var current = data && dataKey === wanted ? data : null, menus = catalog || {};
    var html = '<section class="card completion-statistics"><div class="cardhd"><h3>员工事项完成统计</h3><button type="button" class="btn" onclick="CompletionStatistics.refresh()"' + (busy ? ' disabled' : '') + '>刷新统计</button></div>'
      + '<details class="notice completion-statistics-explain"><summary>统计口径</summary><p>按实际完成日期归入所选区间，审核通过且来源仍有效的事项计入已审完成。协调事项由发起人审核，其他事项按原审核权限办理。按申请时保存的执行截止时间区分按时／延期；无有效截止日期单列无法判定。延期批准单独统计，事项继续办理。</p></details>'
      + '<div class="completion-statistics-period"><button type="button" class="btn" onclick="CompletionStatistics.period(\'week\')">本周</button><button type="button" class="btn" onclick="CompletionStatistics.period(\'month\')">本月</button><span class="muted">北京时间，含起止日</span></div>'
      + '<div class="completion-statistics-filters">'
      + '<label>开始日期<input type="date" value="' + esc(filters.start) + '" onchange="CompletionStatistics.filter(\'start\',this.value)"></label>'
      + '<label>结束日期<input type="date" value="' + esc(filters.end) + '" onchange="CompletionStatistics.filter(\'end\',this.value)"></label>'
      + select('project_id', '项目', (menus.projects || S.projects || []).map(function (p) { return [p.id, p.name || p.id]; }), '全部项目')
      + select('owner_id', '员工', (menus.employees || []).map(function (p) { return [p.user_id, [p.name || p.user_id,organizationLabel(p)].filter(Boolean).join(' · ')]; }), '全部员工')
      + select('discipline', '专业／模块', (menus.disciplines || []).map(function (name) { return [name, name]; }), '全部专业／模块')
      + select('kind', '事项类别', (menus.kinds || []).map(function (kind) { return [kind.id, kind.name]; }), '全部类别')
      + '<button type="button" class="btn primary" onclick="CompletionStatistics.refresh()"' + (busy ? ' disabled' : '') + '>查询</button></div>';
    if (error) html += '<p class="completion-statistics-error" role="alert">' + esc(error) + '</p>';
    if (busy) html += '<p role="status" aria-live="polite">正在汇总完整授权范围内的员工事项…</p>';
    if (current) {
      html += '<div class="member-directory-layout completion-statistics-layout">' + organizationTree(current)
        + '<div class="completion-statistics-main"><label class="completion-statistics-search" for="completionStatisticsSearch">搜索姓名'
        + '<input type="search" id="completionStatisticsSearch" placeholder="输入全名或部分姓名" value="' + esc(search)
        + '" oninput="if(!event.isComposing)CompletionStatistics.searchName(this)" oncompositionend="CompletionStatistics.searchName(this)"></label>'
        + '<div data-statistics-results>' + resultsHtml(current) + '</div></div></div>';
    } else if (!busy && !error) html += '<div class="empty">请选择日期并点击查询。</div>';
    return html + '</section>';
  }
  global.CompletionStatistics = { configure: configure, pageHtml: pageHtml, load: load, invalidate: invalidate, refresh: refresh, filter: setFilter, period: setPeriod,
    selectOrganization:selectOrganization,toggleOrganization:toggleOrganization,searchName:searchName };
})(window);

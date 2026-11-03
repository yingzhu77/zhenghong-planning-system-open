/* Read submitted reports beside the form without replacing its DOM or draft. */
(function (global) {
  'use strict';
  var cfg, dialog, context, rows = [], selectedPeriod = '', selectedReport = '', serial = 0, previousFocus, previousOverflow;
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function current() { return cfg && cfg.getContext(); }
  function valid() { var now = current(); return dialog && now && now.canRead && context.key === now.key; }
  function periodKey(period, reference) { return global.PlanningWindows.periodStart(period, reference) || period; }
  function rowPeriod(row) { return periodKey(row.period, row.submitted_at); }
  function close() {
    serial++;
    if (!dialog) return;
    var old = dialog; dialog = null;
    old.close(); old.remove(); rows = []; context = null;
    document.body.style.overflow = previousOverflow;
    if (previousFocus && previousFocus.isConnected) previousFocus.focus({preventScroll:true});
    previousFocus = null;
  }
  function refresh() { if (dialog && !valid()) close(); }
  function configure(options) { cfg = options; refresh(); }
  function message(text, error) {
    var status = dialog.querySelector('.report-reference-status');
    status.textContent = text; status.setAttribute('role', error ? 'alert' : 'status');
    status.classList.toggle('is-error', !!error);
  }
  function candidates() { return rows.filter(function (row) { return rowPeriod(row) === selectedPeriod; }); }
  function option(select, value, label) { var node = el('option', '', label); node.value = value; select.appendChild(node); }
  function content() {
    var target = dialog.querySelector('.report-reference-content'), report = candidates().filter(function (row) { return String(row.id) === selectedReport; })[0];
    target.scrollTop = 0;
    if (!report) { target.replaceChildren(el('p', 'empty', '所选周期暂无其他人的已提交填报。')); return; }
    // Rich attachment helpers may decorate a snapshot. Never decorate the host's report or draft.
    target.innerHTML = cfg.snapshotHtml(JSON.parse(JSON.stringify(report)));
  }
  function reports() {
    var list = candidates(), select = dialog.querySelector('[name="report"]');
    select.replaceChildren();
    list.forEach(function (row) {
      var project = context.projectIds.length > 1 ? ' · ' + cfg.projectName(row.project_id) : '';
      option(select, String(row.id), (row.line || '综合') + ' · ' + (row.author_name || '未记录姓名') + project);
    });
    if (!list.some(function (row) { return String(row.id) === selectedReport; })) selectedReport = list.length ? String(list[0].id) : '';
    if (!list.length) option(select, '', '暂无已提交填报');
    select.value = selectedReport; select.disabled = !list.length;
    message('已提交 ' + list.length + ' 份' + (context.truncated ? '；记录较多，当前仅显示已加载范围。' : ''));
    content();
  }
  function periods() {
    var select = dialog.querySelector('[name="period"]'), choices = new Map();
    choices.set(periodKey(context.period, context.reference), context.period);
    rows.forEach(function (row) { if (!choices.has(rowPeriod(row))) choices.set(rowPeriod(row), row.period); });
    if (!choices.has(selectedPeriod)) selectedPeriod = periodKey(context.period, context.reference);
    select.replaceChildren();
    Array.from(choices.keys()).sort().reverse().forEach(function (key) { option(select, key, choices.get(key) + (choices.get(key) === key ? '' : ' · ' + key)); });
    select.value = selectedPeriod; select.disabled = false;
    reports();
  }
  async function load() {
    if (!valid()) return refresh();
    var token = ++serial, captured = context;
    rows = [];
    dialog.querySelectorAll('select, [data-refresh]').forEach(function (node) { node.disabled = true; });
    dialog.querySelector('.report-reference-content').replaceChildren();
    message('正在读取已提交填报…');
    try {
      var result = await cfg.loadReports(captured);
      if (token !== serial || !valid()) return refresh();
      rows = result.rows.filter(function (row) {
        var projects = global.ReportScopes.reportProjects(row);
        return row.submitted_at && row.author_id && row.author_id !== captured.uid
          && projects.some(function (pid) { return captured.projectIds.indexOf(pid) >= 0; })
          && global.ReportScopes.readable(row, captured.readableProjects);
      }).sort(function (a, b) { return String(a.line || '').localeCompare(String(b.line || ''), 'zh-CN') || String(a.author_name || '').localeCompare(String(b.author_name || ''), 'zh-CN'); });
      context.truncated = result.truncated;
      periods();
    } catch (error) {
      if (token !== serial || !valid()) return refresh();
      message(error.message || '读取失败，请重试。', true);
    } finally {
      if (token === serial && valid()) dialog.querySelector('[data-refresh]').disabled = false;
    }
  }
  function open() {
    close();
    var now = current();
    if (!now || !now.canRead) return;
    context = JSON.parse(JSON.stringify(now)); selectedPeriod = periodKey(context.period, context.reference); selectedReport = '';
    previousFocus = document.activeElement; previousOverflow = document.body.style.overflow;
    dialog = el('dialog', 'report-reference'); dialog.setAttribute('aria-labelledby', 'report-reference-title');
    var header = el('header', 'report-reference-header'), titles = el('div');
    titles.appendChild(el('h2', '', '查看其他专业填报')); titles.firstChild.id = 'report-reference-title';
    titles.appendChild(el('p', '', context.projectName + ' · 已提交结果'));
    var back = el('button', 'btn primary', '返回填报'); back.type = 'button'; back.onclick = close;
    header.append(titles, back);
    var toolbar = el('div', 'report-reference-toolbar');
    [['period', '查看周期'], ['report', '专业 / 填报人']].forEach(function (spec) {
      var label = el('label', '', spec[1]), select = el('select'); select.name = spec[0];
      select.onchange = function () {
        if (!valid()) return refresh();
        if (spec[0] === 'period') { selectedPeriod = select.value; selectedReport = ''; reports(); }
        else { selectedReport = select.value; content(); }
      };
      label.appendChild(select); toolbar.appendChild(label);
    });
    var reload = el('button', 'btn ghost', '刷新结果'); reload.type = 'button'; reload.dataset.refresh = ''; reload.onclick = load;
    toolbar.appendChild(reload);
    var status = el('p', 'report-reference-status'); status.setAttribute('aria-live', 'polite');
    dialog.append(header, toolbar, status, el('div', 'report-reference-content'));
    dialog.addEventListener('cancel', function (event) { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', function (event) {
      if (event.key !== 'Tab') return;
      var controls = Array.from(dialog.querySelectorAll('button:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]')).filter(function(node){return node.getClientRects().length;});
      var first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    dialog.addEventListener('click', function (event) {
      if (event.target !== dialog) return;
      var rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });
    document.body.appendChild(dialog); dialog.showModal(); document.body.style.overflow = 'hidden'; back.focus(); load();
  }
  global.ReportReference = {configure:configure, open:open, close:close, refresh:refresh};
})(window);

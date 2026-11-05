/* 填报人项目资料：只读视图，不改变原项目档案或附件权限。 */
(function (global) {
  'use strict';

  var TABS = [
    { key: 'plan', title: '项目总图' }, { key: 'basic', title: '基本资料' },
    { key: 'planning', title: '规划指标' }, { key: 'products', title: '产品构成' },
    { key: 'areas', title: '产品面积占比' }, { key: 'units', title: '户型比' },
    { key: 'standards', title: '产品建设标准' }
  ];
  var PHASE_COLS = [
    ['name', '分期名称'], ['area', '用地（㎡）'], ['gfa', '建面（㎡）'],
    ['units_total', '总套数'], ['units_launched', '已推'], ['units_sold', '已售'],
    ['avg_price', '均价（元/㎡）'], ['value', '货值（万元）'], ['plan_handover', '计划交付']
  ];

  function number(value, integer) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
    var n = Number(value);
    return isFinite(n) && n >= 0 && (!integer || Math.floor(n) === n) ? n : null;
  }
  function totalOf(rows, key) {
    if (!rows.length) return null;
    var total = 0;
    for (var i = 0; i < rows.length; i++) {
      var n = number(rows[i][key], true);
      if (n === null) return null;
      total += n;
    }
    return total;
  }
  function fileUrl(drawing,pid) {
    var url = typeof drawing.url === 'string' ? drawing.url : '';
    if(url.indexOf('/api/scheme-previews/')===0)return new RegExp('^/api/scheme-previews/'+String(pid).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/[a-f0-9]{64}\\.webp$').test(url)?url:'';
    if (/^https?:\/\//i.test(url) || /^\/api\/files\/drawings\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(url)) return url;
    if (/^drawings\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(drawing.path || '')) return '/api/files/' + drawing.path;
    return '';
  }

  function render(context) {
    var knowledge=context.fields && context.fields.scheme_catalog;
    if(global.ZHProjectKnowledge && global.ZHProjectKnowledge.valid(knowledge) && (!context.tab || context.tab==='knowledge'))return global.ZHProjectKnowledge.render(context);
    var h = context.helpers, esc = h.esc, fields = context.fields || {};
    var phases = context.phases || [], drawings = context.drawings || [];
    var milestones = context.milestones || [], projects = context.projects || [];
    var active = TABS.some(function (tab) { return tab.key === context.tab; }) ? context.tab : 'plan';

    function empty(text) { return '<div class="reporter-archive-empty">' + esc(text) + '</div>'; }
    function value(v) { return v === null || v === undefined || v === '' ? '—' : esc(v); }
    function card(title, body, hint) {
      return '<section class="card reporter-archive-section"><div class="cardhd"><h3>' + esc(title) + '</h3>'
        + (hint ? '<span class="hint">' + esc(hint) + '</span>' : '') + '</div>' + body + '</section>';
    }
    function details(title, body) {
      return '<details class="card reporter-archive-details"><summary>' + esc(title) + '</summary>' + body + '</details>';
    }
    function fieldTable(specs) {
      return '<table class="kv reporter-archive-fields"><tbody>' + specs.map(function (spec) {
        var content=spec[0]==='fitout' && global.ZHRichText ? global.ZHRichText.field(fields,spec[0],'—') : value(fields[spec[0]]);
        return '<tr><th scope="row">' + esc(spec[1]) + '</th><td>' + content + '</td></tr>';
      }).join('') + '</tbody></table>';
    }
    function drawingCards(list, large) {
      if (!list.length) return empty('尚未登记相关图纸。');
      return '<div class="reporter-archive-files' + (large ? ' reporter-archive-files-large' : '') + '">' + list.map(function (d) {
        var url = fileUrl(d,context.pid), name = d.name || '未命名附件', schemePreview=url.indexOf('/api/scheme-previews/')===0;
        var extension = String(d.path || url).split(/[?#]/)[0];
        var pdf = /\.pdf$/i.test(extension) || /\.pdf$/i.test(name);
        var image = !pdf && /\.(?:png|jpe?g|gif|webp|avif)$/i.test(extension);
        var preview = !url ? empty('附件暂不可打开，请联系管理员核对链接。')
          : schemePreview ? '<div class="reporter-archive-preview"><img src="'+esc(url)+'" alt="'+esc(name)+'关键区域" loading="lazy" decoding="async"></div>'
          : image ? '<a class="reporter-archive-preview" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" aria-label="打开' + esc(name) + '">'
            + '<img src="' + esc(url) + '" alt="' + esc(name) + '" loading="lazy" decoding="async"></a>'
          : '<div class="reporter-archive-document"><span>' + (pdf ? 'PDF 图纸' : '附件链接') + '</span>'
            + '<a class="btn ghost sm" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + (pdf ? '打开 PDF 文档' : '打开附件链接') + '</a></div>';
        return '<article class="reporter-archive-file">' + preview + '<div class="reporter-archive-caption"><b>' + esc(name) + '</b>'
          + '<span class="muted">' + esc(d.uploaded_by || '—') + '　' + esc(h.sd(d.created_at)) + '</span></div></article>';
      }).join('') + '</div>';
    }
    function relatedDrawings(kind) { return drawings.filter(function (d) { return d.kind === kind; }); }
    function phaseTable() {
      if (!phases.length) return empty('暂无分期与销售套数资料。');
      var total = totalOf(phases, 'units_total'), launched = totalOf(phases, 'units_launched'), sold = totalOf(phases, 'units_sold');
      var rate = launched > 0 && sold !== null && sold <= launched ? Math.round(sold / launched * 1000) / 10 + '%' : '—';
      return '<div class="tablewrap"><table><thead><tr>' + PHASE_COLS.map(function (col) { return '<th scope="col">' + esc(col[1]) + '</th>'; }).join('')
        + '</tr></thead><tbody>' + phases.map(function (phase) {
          return '<tr>' + PHASE_COLS.map(function (col) { return '<td>' + value(phase[col[0]]) + '</td>'; }).join('') + '</tr>';
        }).join('') + '<tr class="reporter-archive-total"><th scope="row">合计 / 去化率</th><td>—</td><td>—</td><td>' + value(total) + '</td><td>' + value(launched)
        + '</td><td>' + value(sold) + '</td><td colspan="3">' + value(rate) + (rate === '—' ? '' : '（已售 / 已推）') + '</td></tr></tbody></table></div>'
        + '<p class="hint">套数合计需各分期数据完整；去化率按已售套数 / 已推套数计算。</p>';
    }
    function milestoneTable() {
      if (!milestones.length) return empty('暂无节点计划。');
      return '<div class="tablewrap"><table><thead><tr><th>节点</th><th>条线</th><th>层级</th><th>计划</th><th>预计</th><th>偏差</th><th>状态</th></tr></thead><tbody>'
        + milestones.map(function (m) {
          var delay = m.done ? null : h.dayDiff(m.forecast_date, m.plan_date), light = m.done ? 'gray' : h.lightOf(delay);
          return '<tr><td>' + h.richItem(m, 'name') + (m.is_key ? ' <span class="chip key">关键</span>' : '') + '</td><td>' + value(m.line) + '</td><td>'
            + value(m.level) + '</td><td>' + esc(h.sd(m.plan_date)) + '</td><td>' + (m.done ? '已完成' : esc(h.sd(m.forecast_date))) + '</td><td>'
            + (m.done ? '—' : h.devTxt(delay)) + '</td><td><span class="dot d-' + light + '"></span>'
            + (m.done ? '已完成' : delay === null ? '日期不足' : delay >= 15 ? '异常' : delay >= 5 ? '关注' : delay > 0 ? '轻微偏差' : '正常') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    /* 产品面积须有单独登记的总面积；户型套数可以核对完整分期总套数。
       明细之和必须与分母一致，缺项、负值或未登记分母均不生成百分比。 */
    function ratioTable(rows, key, denominator, label, integer) {
      if (!Array.isArray(rows) || !rows.length) return empty('尚未登记' + label + '明细。');
      var total = 0, valid = denominator !== null && denominator > 0;
      rows.forEach(function (row) {
        var n = number(row && row[key], integer);
        if (!row || typeof row.name !== 'string' || !row.name.trim() || n === null) valid = false;
        else total += n;
      });
      valid = valid && Math.abs(total - denominator) < (integer ? 0.5 : 0.01);
      return '<div class="tablewrap"><table><thead><tr><th>' + esc(label) + '</th><th>' + (integer ? '套数' : '面积（㎡）') + '</th><th>占比</th></tr></thead><tbody>'
        + rows.map(function (row) {
          var n = number(row && row[key], integer), ratio = valid ? Math.round(n / denominator * 1000) / 10 : null;
          return '<tr><td>' + value(row && row.name) + '</td><td>' + value(n) + '</td><td>' + (ratio === null ? '待核对' : ratio + '%')
            + (ratio === null ? '' : '<span class="reporter-archive-ratio" aria-hidden="true"><span style="width:' + ratio + '%"></span></span>') + '</td></tr>';
        }).join('') + '</tbody></table></div><p class="hint">' + (valid ? ('按完整登记明细 / 总' + (integer ? '套数' : '面积') + ' ' + denominator + (integer ? ' 套' : ' ㎡') + ' 计算。')
          : '明细或总量尚未完整登记，或两者合计不一致，暂不计算占比。') + '</p>';
    }

    var body = '';
    if (active === 'plan') {
      var plans = drawings.filter(function (d) { return String(d.kind || '').indexOf('项目总图') === 0; });
      var presale = [], adjusted = [], unversioned = [];
      plans.forEach(function (d) {
        var label = String(d.name || '') + ' ' + String(d.kind || ''), pre = /预售/.test(label), adj = /调整/.test(label);
        if (pre && !adj) presale.push(d); else if (adj && !pre) adjusted.push(d); else unversioned.push(d);
      });
      body = '<div class="reporter-archive-plan-columns">' + card('项目总图展示（预售版）', drawingCards(presale, true))
        + card('项目总图展示（调整版）', drawingCards(adjusted, true)) + '</div>';
      if (unversioned.length) body += card('原有总图资料', drawingCards(unversioned, false), '版本尚未标注，保留原资料供查看');
      var other = drawings.filter(function (d) { return plans.indexOf(d) < 0; });
      if (other.length) body += details('其他图纸与附件（' + other.length + '）', drawingCards(other, false));
    } else if (active === 'basic') {
      body = card('基本资料', fieldTable([['city', '所在城市'], ['owner_company', '开发主体'], ['open_date', '预计首次开盘'],
        ['handover_date', '预计首批交付'], ['land_cost', '土地款（万元）'], ['target_cost', '目标总成本（万元）'], ['target_price', '整盘均价（元/㎡）']]));
      body += details('原有分期与销售资料', phaseTable()) + details('节点计划（' + milestones.length + '）', milestoneTable());
    } else if (active === 'planning') {
      body = card('规划指标', fieldTable([['area', '用地面积（㎡）'], ['gfa', '总建筑面积（㎡）'], ['plot_gfa', '计容建筑面积（㎡）'],
        ['far', '容积率'], ['floors', '楼栋 / 层数'], ['parking', '车位（个）']]));
      body += details('分期规划与销售资料', phaseTable());
    } else if (active === 'products') {
      body = card('产品构成', fieldTable([['mix', '业态构成'], ['floors', '楼栋 / 层数'], ['parking', '车位（个）']]));
      if (Array.isArray(fields.products) && fields.products.length) body += card('已登记产品明细', ratioTable(fields.products, 'area', number(fields.product_area_total), '产品', false));
      body += details('分期与销售套数', phaseTable());
    } else if (active === 'areas') {
      body = card('产品面积占比', ratioTable(fields.products, 'area', number(fields.product_area_total), '产品面积', false), '按已登记的产品面积明细与总面积核对');
      body += card('项目面积资料', fieldTable([['gfa', '总建筑面积（㎡）'], ['plot_gfa', '计容建筑面积（㎡）']]));
    } else if (active === 'units') {
      var units = number(fields.unit_types_total, true);
      if (units === null) units = totalOf(phases, 'units_total');
      body = card('户型比', ratioTable(fields.unit_types, 'units', units, '户型', true), '按已登记的户型套数核对项目总套数');
      body += card('户型图', drawingCards(relatedDrawings('户型图'), false));
      body += details('分期与销售套数', phaseTable());
    } else if (active === 'standards') {
      body = card('产品建设标准', fieldTable([['fitout', '装修 / 交付标准']]));
      if (relatedDrawings('其他').length) body += details('其他图纸与附件', drawingCards(relatedDrawings('其他'), false));
    }

    return (knowledge && global.ZHProjectKnowledge && !global.ZHProjectKnowledge.valid(knowledge)?'<div class="notice warn" role="status">方案资料暂无法读取，已显示原档案。请联系资料维护人员。</div>':'')
      +(global.ZHProjectKnowledge && global.ZHProjectKnowledge.valid(knowledge)?'<div class="pk-legacy-link"><button type="button" class="btn ghost sm" onclick="ZHProjectKnowledge.home()">← 返回方案资料中心</button></div>':'')+'<div class="reporter-archive"><div class="card reporter-archive-toolbar"><div class="reporter-archive-project"><label for="reporterArchiveProject">项目</label>'
      + '<select id="reporterArchiveProject" class="no-print" onchange="App.masterPick(this.value)">' + projects.map(function (project) {
        return '<option value="' + esc(project.id) + '"' + (project.id === context.pid ? ' selected' : '') + '>' + esc(project.name) + '</option>';
      }).join('') + '</select><b class="reporter-archive-print-project">' + esc((projects.filter(function (p) { return p.id === context.pid; })[0] || {}).name || '') + '</b></div>'
      + '<span class="hint">只读：由运营管理员统一维护</span>'
      + (typeof fields.current_version === 'string' && fields.current_version.trim() ? '<span class="reporter-archive-version">当前项目版本：' + esc(fields.current_version) + '</span>' : '') + '</div>'
      + '<nav class="reporter-archive-tabs no-print" aria-label="项目资料分类">' + TABS.map(function (tab) {
        return '<button type="button" class="' + (active === tab.key ? 'on' : '') + '" aria-current="' + (active === tab.key ? 'page' : 'false')
          + '" onclick="App.reporterArchiveTab(\'' + tab.key + '\')">' + esc(tab.title) + '</button>';
      }).join('') + '</nav><div class="reporter-archive-content">' + body + '</div></div>';
  }

  global.ZHReporterArchive = { render: render };
})(window);

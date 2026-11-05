/* Read-only grouping and same-screen image comparison. Original records keep their project IDs. */
(function (global) {
  'use strict';
  var cfg, S, identity, session, scopes = [], byKey = Object.create(null);
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function configure(options) {
    if (identity !== options.S.uid || session !== options.S.session) {
      scopes = []; byKey = Object.create(null); identity = options.S.uid; session = options.S.session;
    }
    cfg = options; S = options.S;
  }
  function esc(value) { return cfg.esc(value == null ? '' : String(value)); }
  function allowedProjects(projects) {
    return (projects || []).filter(function (p) { return p && (S.projects || []).some(function (known) { return known.id === p.id; }); });
  }
  function projectReports(project, reports) { return (reports || []).filter(function (r) { return r.project_id === project.id; }); }
  function label(project) { return '<span class="overview-source-project">' + esc(project.name || project.id) + '</span>'; }
  function sourceSection(project, html) {
    return html ? '<section class="overview-source-section" data-source-project-id="' + esc(project.id) + '"><h5>' + label(project) + '</h5>' + html + '</section>' : '';
  }
  // Baseline rows already identify their actual project. Other overview tables
  // keep the original added source column and sequence numbering.
  function mergeTables(parts, empty, baselineNodes) {
    var template = '', rows = [], states = [], hasSourceColumn = false;
    parts.forEach(function (part) {
      var match = /<table\b[^>]*>[\s\S]*?<tbody>([\s\S]*?)<\/tbody><\/table>/.exec(part.html || '');
      if (!match) {
        if (baselineNodes && part.html) states.push(sourceSection(part.project, part.html));
        return;
      }
      var body = match[1];
      var ownSource = /<col class="overview-col-source">/.test(part.html) || baselineNodes && /<td\b[^>]*data-label="实际项目／模块"/.test(body);
      if (!template) { template = part.html; hasSourceColumn = ownSource; }
      if (/^<tr><td class="overview-cell-empty"/.test(body)) return;
      rows.push(ownSource ? body : body.replace(/<tr>/g, '<tr data-source-project-id="' + esc(part.project.id) + '"><td class="overview-cell-source" data-label="实际子项目／分期">' + label(part.project) + '</td>'));
    });
    if (!rows.length && !template) return states.join('') || '<span class="overview-empty">' + esc(empty) + '</span>';
    var number = 0;
    if (!hasSourceColumn) template = template.replace('<colgroup>', '<colgroup><col class="overview-col-source">')
      .replace('<thead><tr>', '<thead><tr><th scope="col">实际子项目／分期</th>')
      .replace(/(<td class="overview-cell-empty" colspan=")(\d+)(")/,function(_match,before,count,after){return before+(Number(count)+1)+after;});
    if (!rows.length) return template + states.join('');
    return template.replace(/<tbody>[\s\S]*?<\/tbody>/, '<tbody>' + rows.join('').replace(/(<td class="overview-cell-seq"[^>]*>)\d+(<\/td>)/g, function (_all, before, after) { return before + (++number) + after; }) + '</tbody>') + states.join('');
  }
  function orderedLines(projects, reports) {
    var lines = [], groups = Object.create(null);
    projects.forEach(function (p) {
      var found = cfg.residentialGroups(p.id, projectReports(p, reports));
      groups[p.id] = found;
      Object.keys(found).forEach(function (line) { if (lines.indexOf(line) < 0) lines.push(line); });
    });
    lines.sort(function (a, b) {
      var ai = cfg.disciplines.indexOf(a), bi = cfg.disciplines.indexOf(b);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.localeCompare(b, 'zh-CN');
    });
    return { lines: lines, groups: groups };
  }
  function reportMembers(report) {
    return report && report.report_scope_id && Array.isArray(report.scope_project_ids) ? report.scope_project_ids.map(String) : [String(report.project_id)];
  }
  function readableReport(report) {
    var known = (S.projects || []).map(function (p) { return String(p.id); });
    return reportMembers(report).every(function (id) { return known.indexOf(id) >= 0; });
  }
  function scopeSection(scope, report) {
    var members = (scope.project_ids || []).map(String), rows = report ? [report] : [];
    var memberProjects = (S.projects || []).filter(function (p) { return members.indexOf(String(p.id)) >= 0; });
    var knownLines = orderedLines(memberProjects, []).lines;
    var meetings = memberProjects.map(function (project) {
      return sourceSection(project, knownLines.map(function (line) {
        return cfg.notesHtml(project.id, line, knownLines);
      }).join(''));
    }).join('');
    var meta = report ? '<div class="overview-report-meta" data-report-id="' + esc(report.id) + '">' + esc(report.author_name || '未记录填报人')
      + ' · 住宅统一综合填报' + cfg.reportHistoryButton(report) + '</div>' : '<p class="overview-empty">本期尚未提交统一填报。</p>';
    return '<section class="overview-scope-report" data-report-scope-id="' + esc(scope.id) + '"><h3>' + esc(scope.name) + ' · 统一填报</h3>'
      + meta + '<div class="overview-report-grid overview-report-sections">'
      + '<section class="overview-core-nodes"><h4>一、滚动月核心节点计划</h4>' + cfg.nodeHtml(rows, scope.anchor_project_id, null, false, members) + '</section>'
      + '<section class="overview-monthly-plans"><h4>二、当月计划填报</h4>' + cfg.planHtml(rows, scope.anchor_project_id, null, false,
        {scope_id:scope.id,projectIds:members,line:S.overviewUI.discipline || ''}) + '</section>'
      + meetings
      + '<section class="overview-coordination"><h4>三、需要协调</h4>' + cfg.coordHtml(rows, scope.anchor_project_id, null, false) + '</section>'
      + '<section class="overview-other"><h4>四、其他事项</h4>' + cfg.otherHtml(rows, scope.anchor_project_id, null, false) + '</section></div>'
      + (report ? cfg.legacyHtml(report) : '') + '</section>';
  }
  function professionalScopeSection(scope, rows) {
    var members=(scope.project_ids || []).map(String),selected=S.overviewUI.discipline || '';
    if(selected && global.MonthlyPlans)rows=global.MonthlyPlans.residentialReports(rows,selected,S.members,S.monthlyPlans);
    var meta=rows.map(function(report){return '<div class="overview-report-meta" data-report-id="'+esc(report.id)+'">'
      +esc(report.line || '综合')+' · '+esc(report.author_name || '未记录填报人')+cfg.reportHistoryButton(report)+'</div>';}).join('')
      || '<p class="overview-empty">所选周期暂无已提交专业填报。</p>';
    return '<section class="overview-scope-report" data-report-scope-id="'+esc(scope.id)+'"><h3>'+esc(scope.name)+' · 各专业填报</h3>'
      +meta
      +'<div class="overview-report-grid overview-report-sections">'
      +'<section class="overview-core-nodes"><h4>一、滚动月核心节点计划</h4>'+cfg.nodeHtml(rows,scope.anchor_project_id,null,false,members)+'</section>'
      +'<section class="overview-monthly-plans"><h4>二、当月计划填报</h4>'+cfg.planHtml(rows,scope.anchor_project_id,null,false,
        {scope_id:scope.id,projectIds:members,line:selected})+'</section>'
      +'<section class="overview-coordination"><h4>三、需要协调</h4>'+cfg.coordHtml(rows,scope.anchor_project_id,null,false)+'</section>'
      +'<section class="overview-other"><h4>四、其他事项</h4>'+cfg.otherHtml(rows,scope.anchor_project_id,null,false)+'</section></div>'
      +rows.map(function(report){return cfg.legacyHtml(report);}).join('')+'</section>';
  }
  function residentialSection(group, projects, reports) {
    function table(method, empty) {
      if(method==='planHtml'){
        var ids=projects.map(function(project){return project.id;});
        return cfg.planHtml(projects.flatMap(function(project){return projectReports(project,reports);}),projects[0].id,null,false,{projectIds:ids,line:S.overviewUI.discipline || ''});
      }
      return mergeTables(projects.map(function(project){return {project:project,
        html:cfg[method](projectReports(project,reports),project.id,null,false,[project.id])};}),empty,method==='nodeHtml');
    }
    var meta=reports.map(function(report){var project=projects.filter(function(p){return p.id===report.project_id;})[0];
      return '<div class="overview-report-meta" data-report-id="'+esc(report.id)+'">'+label(project)+' · '+esc(report.author_name || '未记录填报人')+' · '+esc(report.line || '综合')+cfg.reportHistoryButton(report)+'</div>';
    }).join('') || '<p class="overview-empty">所选周期暂无已提交填报。</p>';
    var selected=S.overviewUI.discipline;
    return '<section class="overview-residential-report"><h3>'+esc(group.name)+' · '+esc(selected?(selected==='__unassigned__'?'未归专业':selected)+'计划填报':'计划填报')+'</h3>'+meta
      +'<div class="overview-report-grid overview-report-sections">'
      +'<section class="overview-core-nodes"><h4>一、滚动月核心节点计划</h4>'+table('nodeHtml','暂无核心节点')+'</section>'
      +'<section class="overview-monthly-plans"><h4>二、当月计划填报</h4>'+table('planHtml','暂无当月计划')+'</section>'
      +'<section class="overview-coordination"><h4>三、需要协调</h4>'+table('coordHtml','暂无协调事项')+'</section>'
      +'<section class="overview-other"><h4>四、其他事项</h4>'+table('otherHtml','暂无其他事项')+'</section></div>'
      +projects.map(function(project){return projectReports(project,reports).map(function(report){return sourceSection(project,cfg.legacyHtml(report));}).join('');}).join('')+'</section>';
  }
  function residential(group, reports, initial) {
    var projects = allowedProjects(group.projects), ids = projects.map(function (p) { return p.id; });
    reports = (reports || []).filter(function (r) { return ids.indexOf(r.project_id) >= 0 && readableReport(r); });
    if (!projects.length) return '';
    var allReports = reports, configured = [], covered = Object.create(null);
    (S.reportScopes || []).forEach(function (scope) {
      if (!global.ReportScopes || !global.ReportScopes.allowed(scope, projects) || !global.ReportScopes.active(scope, cfg.currentPeriod())) return;
      if (!global.ReportScopes.forProject([scope], scope.anchor_project_id, cfg.currentPeriod(), null, projects, reports)) return;
      configured.push(scope);
    });
    reports.filter(function (r) { return !!r.report_scope_id; }).forEach(function (report) {
      if (configured.some(function (scope) { return scope.id === report.report_scope_id; })) return;
      var members = reportMembers(report);
      if (!members.every(function (id) { return ids.indexOf(id) >= 0; })) return;
      configured.push({id: report.report_scope_id, name: group.name, anchor_project_id: report.project_id, project_ids: members});
    });
    var unified = configured.map(function (scope) {
      (scope.project_ids || []).forEach(function (id) { covered[String(id)] = true; });
      var scoped=reports.filter(function(r){return r.report_scope_id===scope.id;});
      if(scope.reporting_mode==='professional'){
        var historic=reports.filter(function(r){return !r.report_scope_id && (scope.project_ids || []).indexOf(r.project_id)>=0;});
        return professionalScopeSection(scope,scoped)+(historic.length?'<details class="overview-legacy-project-reports"><summary>原分期报告 · 历史参考</summary>'
          +residentialSection(group,projects.filter(function(p){return (scope.project_ids || []).indexOf(p.id)>=0;}),historic)+'</details>':'');
      }
      return scopeSection(scope,scoped[0] || null);
    }).join('');
    var legacyProjects = projects.filter(function (p) { return !covered[String(p.id)]; });
    reports = reports.filter(function (r) { return !r.report_scope_id; });
    var knownLines = orderedLines(projects, reports).lines;
    var key = 'group:' + (group.report_scope_id || group.name);
    var content = unified + (legacyProjects.length ? residentialSection(group,legacyProjects,reports) : '');
    if (!(cfg.isHistorical && cfg.isHistorical()) && global.OverviewMeetings && global.OverviewMeetings.residentialHtml) content += global.OverviewMeetings.residentialHtml(projects,S.overviewUI.discipline);
    content += projects.map(function (p) {
      var notes = (covered[String(p.id)]?[]:knownLines).map(function(line){return cfg.notesHtml(p.id,line,knownLines);}).join('')+cfg.notesHtml(p.id, null, knownLines);
      return sourceSection(p, notes);
    }).join('');
    var sidebar = projects.map(function (p) { return sourceSection(p, cfg.drawingHtml(p.id) + cfg.filesHtml(projectReports(p, reports), false)); }).join('')
      + configured.map(function (scope) { var rows = allReports.filter(function (r) { return r.report_scope_id === scope.id; }); return rows.length ? '<section class="overview-source-section"><h5>' + esc(scope.name) + ' · 统一填报附件</h5>' + cfg.filesHtml(rows, false) + '</section>' : ''; }).join('');
    return '<details class="card overview-project overview-display-group" data-project-group="' + esc(group.name) + '"' + cfg.foldAttrs('project', key, '', initial || S.overviewUI.project === group.name) + '>'
      + '<summary class="overview-project-head"><span class="overview-project-name">' + esc(group.name) + '</span><span class="muted">住宅 · ' + projects.length + ' 个实际子项目 · 本期 ' + allReports.length + ' 份已提交填报</span>' + cfg.foldHint() + '</summary>'
      + '<div class="overview-project-tools">' + projects.map(function (p) { return '<span>' + label(p) + ' ' + cfg.projectDetailButton(p.id) + '</span>'; }).join('') + '</div>'
      + layout({ key: key, projects: projects, reports: allReports, content: content, sidebar: sidebar }) + '</details>';
  }
  function drawingUrl(drawing) {
    var crop=typeof drawing.url==='string' && /^\/api\/scheme-previews\/([A-Za-z0-9_-][A-Za-z0-9_.-]*)\/[a-f0-9]{64}\.webp$/.exec(drawing.url);
    if(crop)return crop[1]===String(drawing.project_id)?drawing.url:'';
    return typeof drawing.url === 'string' && (/^https?:\/\//i.test(drawing.url) || /^\/api\/files\/drawings\/[A-Za-z0-9_./-]+$/.test(drawing.url)) ? drawing.url
      : /^drawings\/[A-Za-z0-9_./-]+$/.test(drawing.path || '') ? '/api/files/' + drawing.path : '';
  }
  function isSchemeExcerpt(row){return !!(row && String(row.url || '').indexOf('/api/scheme-previews/')===0);}
  function pictures(projects, reports) {
    projects = allowedProjects(projects);
    var result = [], used = Object.create(null), metadata = Object.create(null);
    (S.reportAttachments || []).forEach(function (row) { if (row && UUID.test(row.id)) metadata[row.id] = row; });
    projects.forEach(function (project) {
      (S.drawings || []).filter(function (d) { return d.project_id === project.id && String(d.kind || '').indexOf('项目总图') === 0; }).forEach(function (drawing) {
        var url = drawingUrl(drawing), name = drawing.name || '项目总图';
        if (!url || !/\.(?:png|jpe?g|gif|webp|avif)$/i.test(String(drawing.path || url).split(/[?#]/)[0]) && !/\.(?:png|jpe?g|gif|webp|avif)$/i.test(name)) return;
        var key = project.id + ':' + url;
        if (used[key]) return; used[key] = true;
        result.push({ key: key, url: url, name: name, projectId: project.id, projectName: project.name, kind: '项目总图' });
      });
      (reports || []).filter(function (report) { return readableReport(report) && reportMembers(report).indexOf(String(project.id)) >= 0; }).forEach(function (report) {
        var refs = report.biz && report.biz.attachments;
        (Array.isArray(refs) ? refs : []).forEach(function (id) {
          var row = metadata[id], key = project.id + ':' + id;
          if (!row || row.project_id !== project.id || String(row.report_scope_id || '') !== String(report.report_scope_id || '') || row.inline !== true || !/^image\/(?:png|jpeg|gif|webp)$/i.test(row.mime || '') || used[key]) return;
          used[key] = true;
          result.push({ key: key, url: '/api/report-attachments/' + id, name: row.name || '本期图片', projectId: project.id, projectName: project.name, kind: '本期图片' });
        });
      });
    });
    return result;
  }
  function scopeFor(options) {
    var key = JSON.stringify([S.view, cfg.currentPeriod(), options.key]), index = byKey[key];
    if (index == null) { index = scopes.length; scopes.push({ key: key, open: false, width: 60, zoom: 100, selected: '', mobile: 'text' }); byKey[key] = index; }
    var scope = scopes[index]; scope.images = pictures(options.projects, options.reports);
    if (!scope.images.some(function (row) { return row.key === scope.selected; })) scope.selected = scope.images[0] && scope.images[0].key || '';
    if (!scope.images.length) scope.open = false;
    return index;
  }
  function imageLabel(image) { return [image.projectName || image.projectId, image.kind, image.name].join(' · '); }
  function layout(options) {
    var index = scopeFor(options), scope = scopes[index], images = scope.images, selected = images.filter(function (row) { return row.key === scope.selected; })[0];
    return '<section class="admin-plan-reading' + (scope.open ? ' is-comparing' : '') + '" data-admin-compare="' + index + '" data-mobile-pane="' + scope.mobile + '" style="--admin-plan-width:' + scope.width + '%">'
      + '<div class="admin-compare-controls no-print"><button type="button" class="btn ghost sm" data-compare-toggle aria-expanded="' + scope.open + '" onclick="AdminPlanOverview.toggle(' + index + ')"' + (images.length ? '' : ' disabled') + '>' + (scope.open ? '关闭图文对照' : '图文对照') + '</button>'
      + '<label class="admin-compare-width">计划宽度 <output>' + scope.width + '%</output><input type="range" min="35" max="75" value="' + scope.width + '" aria-label="计划栏宽度百分比" oninput="AdminPlanOverview.resize(' + index + ',this.value)"></label>'
      + '<div class="admin-compare-mobile-switch"><button type="button" class="btn ghost sm" data-mobile-switch="text" aria-pressed="' + (scope.mobile === 'text') + '" onclick="AdminPlanOverview.mobile(' + index + ',\'text\')">看计划</button><button type="button" class="btn ghost sm" data-mobile-switch="image" aria-pressed="' + (scope.mobile === 'image') + '" onclick="AdminPlanOverview.mobile(' + index + ',\'image\')">看图片</button></div></div>'
      + '<div class="overview-project-layout admin-reading-layout"><div class="overview-project-content admin-reading-content">' + options.content + '</div><div class="overview-side-stack admin-reading-original">' + options.sidebar + '</div>'
      + '<aside class="admin-compare-pane" aria-label="图片对照"><label class="admin-compare-select">选择图片<select aria-label="对照图片" onchange="AdminPlanOverview.select(' + index + ',this.value)">'
      + images.map(function (row, i) { return '<option value="' + i + '"' + (row.key === scope.selected ? ' selected' : '') + '>' + esc(imageLabel(row)) + '</option>'; }).join('') + '</select></label>'
      + '<div class="admin-compare-file">' + (selected ? esc(imageLabel(selected)) : '暂无图片') + '</div><div class="admin-compare-image-tools"><button type="button" class="btn ghost sm" aria-label="缩小图片" onclick="AdminPlanOverview.zoom(' + index + ',-25)">−</button><output data-compare-zoom>' + scope.zoom + '%</output><button type="button" class="btn ghost sm" aria-label="放大图片" onclick="AdminPlanOverview.zoom(' + index + ',25)">＋</button><button type="button" class="btn ghost sm" onclick="AdminPlanOverview.fit(' + index + ')">适合宽度</button>'
      + '<a class="btn ghost sm" data-compare-open href="' + esc(selected && selected.url || '#') + '" target="_blank" rel="noopener noreferrer">'+(isSchemeExcerpt(selected)?'查看关键图':'原入口打开')+'</a><a class="btn ghost sm" data-compare-download href="' + esc(selected && selected.url || '#') + '" download="' + esc(selected && selected.name || '') + '" target="_blank" rel="noopener noreferrer">'+(isSchemeExcerpt(selected)?'保存关键图':'下载')+'</a></div>'
      + '<p class="admin-compare-hint">放大后可拖动图片，也可使用滚动条。</p><div class="admin-compare-viewport" tabindex="0" aria-label="可滚动的对照图片" onpointerdown="AdminPlanOverview.dragStart(' + index + ',event)" onpointermove="AdminPlanOverview.dragMove(' + index + ',event)" onpointerup="AdminPlanOverview.dragEnd(' + index + ',event)" onpointercancel="AdminPlanOverview.dragEnd(' + index + ',event)">'
      + (selected ? '<img data-compare-image src="' + esc(selected.url) + '" alt="' + esc(imageLabel(selected)) + '" draggable="false" loading="lazy" style="width:' + scope.zoom + '%" onerror="AdminPlanOverview.imageError(' + index + ')">' : '')
      + '<p data-compare-error role="status" hidden>图片暂时无法加载，可使用原入口打开或下载。</p></div></aside></div></section>';
  }
  function element(index) { return global.document && global.document.querySelector('[data-admin-compare="' + Number(index) + '"]'); }
  function toggle(index) {
    var scope = scopes[index], el = element(index); if (!scope || !el || !scope.images.length) return;
    scope.open = !scope.open; el.classList.toggle('is-comparing', scope.open);
    var button = el.querySelector('[data-compare-toggle]'); button.setAttribute('aria-expanded', String(scope.open)); button.textContent = scope.open ? '关闭图文对照' : '图文对照';
  }
  function resize(index, value) {
    var scope = scopes[index], el = element(index), size = Number(value); if (!scope || !el || !Number.isFinite(size)) return;
    scope.width = Math.max(35, Math.min(75, size)); el.style.setProperty('--admin-plan-width', scope.width + '%'); el.querySelector('.admin-compare-width output').textContent = scope.width + '%';
  }
  function mobile(index, pane) {
    var scope = scopes[index], el = element(index); if (!scope || !el || ['text', 'image'].indexOf(pane) < 0) return;
    scope.mobile = pane; el.setAttribute('data-mobile-pane', pane);
    Array.prototype.forEach.call(el.querySelectorAll('[data-mobile-switch]'), function (button) { button.setAttribute('aria-pressed', String(button.getAttribute('data-mobile-switch') === pane)); });
  }
  function select(index, value) {
    var scope = scopes[index], el = element(index), selected = scope && scope.images[Number(value)]; if (!scope || !el || !selected) return;
    scope.selected = selected.key; scope.zoom = 100;
    var image = el.querySelector('[data-compare-image]');
    image.src = selected.url; image.alt = imageLabel(selected); image.style.width = '100%'; image.hidden = false;
    el.querySelector('[data-compare-error]').hidden = true;
    el.querySelector('.admin-compare-file').textContent = imageLabel(selected);
    var openLink=el.querySelector('[data-compare-open]');openLink.href = selected.url;openLink.textContent=isSchemeExcerpt(selected)?'查看关键图':'原入口打开';
    var download = el.querySelector('[data-compare-download]'); download.href = selected.url; download.download = selected.name;download.textContent=isSchemeExcerpt(selected)?'保存关键图':'下载';
    el.querySelector('[data-compare-zoom]').textContent = '100%';
    var viewport = el.querySelector('.admin-compare-viewport'); viewport.scrollLeft = 0; viewport.scrollTop = 0;
  }
  function applyZoom(index) {
    var scope = scopes[index], el = element(index); if (!scope || !el) return;
    var image = el.querySelector('[data-compare-image]'); if (image) image.style.width = scope.zoom + '%';
    el.querySelector('[data-compare-zoom]').textContent = scope.zoom + '%';
  }
  function zoom(index, amount) { var scope = scopes[index]; if (!scope || !Number.isFinite(amount)) return; scope.zoom = Math.max(50, Math.min(400, scope.zoom + amount)); applyZoom(index); }
  function fit(index) { var scope = scopes[index]; if (!scope) return; scope.zoom = 100; applyZoom(index); }
  function imageError(index) { var el = element(index); if (el) { el.querySelector('[data-compare-error]').hidden = false; } }
  function dragStart(index, event) {
    var scope = scopes[index]; if (!scope || !scope.open || event.button !== 0) return;
    var el = event.currentTarget; scope.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
    if (el.setPointerCapture) el.setPointerCapture(event.pointerId); el.classList.add('is-dragging'); event.preventDefault();
  }
  function dragMove(index, event) {
    var scope = scopes[index], drag = scope && scope.drag; if (!drag || drag.id !== event.pointerId) return;
    event.currentTarget.scrollLeft = drag.left + drag.x - event.clientX; event.currentTarget.scrollTop = drag.top + drag.y - event.clientY;
  }
  function dragEnd(index, event) {
    var scope = scopes[index]; if (!scope || !scope.drag || scope.drag.id !== event.pointerId) return;
    scope.drag = null; event.currentTarget.classList.remove('is-dragging');
    if (event.currentTarget.releasePointerCapture && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  global.AdminPlanOverview = { configure: configure, residential: residential, layout: layout, pictures: pictures,
    toggle: toggle, resize: resize, mobile: mobile, select: select, zoom: zoom, fit: fit, imageError: imageError,
    dragStart: dragStart, dragMove: dragMove, dragEnd: dragEnd };
})(window);

/* Stable residential reporting identities. Project records and legacy drafts stay untouched. */
(function (global) {
  'use strict';
  function ids(scope) { return Array.isArray(scope && scope.project_ids) ? scope.project_ids.map(String) : []; }
  function allowed(scope, projects) {
    var members = ids(scope), known = (projects || []).map(function (p) { return String(p.id); });
    return !!(scope && scope.id && scope.anchor_project_id && members.length && members.indexOf(String(scope.anchor_project_id)) >= 0)
      && members.every(function (id) { return known.indexOf(id) >= 0; });
  }
  function start(period, reference) {
    return global.PlanningWindows ? global.PlanningWindows.periodStart(period, reference) : /^\d{4}-\d{2}-\d{2}$/.test(period || '') ? period : '';
  }
  function professional(scope) { return !!scope && scope.reporting_mode === 'professional'; }
  function active(scope, period, reference) {
    var week = start(period, reference);
    if (professional(scope)) return !!week;
    if (!week || !scope || (scope.blocked_weeks || []).indexOf(week) >= 0) return false;
    if ((!scope.period_week || scope.period_week === week) && (scope.blocked_by_legacy === true || scope.active_for_period === false)) return false;
    return !!scope.effective_week && week >= scope.effective_week;
  }
  function forProject(rows, pid, period, reference, projects, reports) {
    return (rows || []).filter(function (scope) {
      return ids(scope).indexOf(String(pid)) >= 0 && allowed(scope, projects) && active(scope, period, reference)
        && (professional(scope) || !(reports || []).some(function (report) { return !report.report_scope_id && ids(scope).indexOf(String(report.project_id)) >= 0 && samePeriod(report, period, reference); }));
    })[0] || null;
  }
  function byId(rows, id, projects) {
    return (rows || []).filter(function (scope) { return String(scope.id) === String(id) && allowed(scope, projects); })[0] || null;
  }
  function projects(list, rows, period, reference, reports) {
    var result = [], used = Object.create(null);
    (list || []).forEach(function (project) {
      var scope = forProject(rows, project.id, period, reference, list, reports);
      if (!scope) { result.push(project); return; }
      if (used[scope.id]) return;
      used[scope.id] = true;
      var anchor = list.filter(function (p) { return String(p.id) === String(scope.anchor_project_id); })[0];
      result.push(Object.assign({}, anchor, {name: scope.name || anchor.name, report_scope_id: scope.id, scope_project_ids: ids(scope)}));
    });
    return result;
  }
  function samePeriod(report, period, reference) {
    return global.PlanningWindows ? global.PlanningWindows.samePeriod(report.period, period, report.submitted_at || report.created_at, reference) : report.period === period;
  }
  function findReport(reports, scope, period, reference, line, ownerId) {
    return (reports || []).filter(function (report) {
      return !!scope && report.report_scope_id === scope.id && samePeriod(report, period, reference)
        && (line === undefined ? !professional(scope) : (report.line || '综合') === line)
        && (!professional(scope) || ownerId == null || report.author_id === ownerId);
    })[0] || null;
  }
  function reportProjects(report) {
    return report && report.report_scope_id && Array.isArray(report.scope_project_ids) ? report.scope_project_ids.map(String) : report && report.project_id != null ? [String(report.project_id)] : [];
  }
  function matchesProject(report, pid) { return reportProjects(report).indexOf(String(pid)) >= 0; }
  function readable(report, list) {
    var members = reportProjects(report), known = (list || []).map(function (p) { return String(p.id); });
    return members.length > 0 && members.every(function (id) { return known.indexOf(id) >= 0; });
  }
  function draftKey(uid, scope, period, reference, line) {
    var week = start(period, reference);
    if (professional(scope)) return week && line && line !== '综合'
      ? 'zh_professional_scope_draft_' + String(uid || 'anon') + '_' + scope.id + '_' + encodeURIComponent(line) + '_' + week : '';
    return scope && week ? 'zh_scope_draft_' + String(uid || 'anon') + '_' + scope.id + '_' + week : '';
  }
  function legacyDrafts(storage, uid, scope, period, weekNo, line) {
    var week = start(period), explicitWeek = typeof weekNo === 'function' ? weekNo(period) : weekNo;
    var wn = explicitWeek ? ['', String(explicitWeek)] : /第\s*(\d+)\s*周/.exec(period || '');
    if (!wn && week) {
      var d = new Date(week + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
      wn = ['', String(Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7))];
    }
    if (!storage || !scope || !wn) return [];
    var result = [];
    ids(scope).forEach(function (pid) {
      var key = 'zh_draft_' + String(uid || 'anon') + '_' + pid + '_' + Number(wn[1]), raw;
      try { raw = storage.getItem(key); } catch (error) { return; }
      if (raw == null) return;
      var draft = null, issue = ''; try { draft = JSON.parse(raw); } catch (error) { issue = '原草稿格式无法识别，请保留原文核对'; }
      result.push({key: key, project_id: pid, ts: draft && draft.ts || null, draft: draft, raw: raw, error: issue});
    });
    if (professional(scope) && week) {
      var groupKey = 'zh_scope_draft_' + String(uid || 'anon') + '_' + scope.id + '_' + week, groupRaw;
      try { groupRaw = storage.getItem(groupKey); } catch (error) { groupRaw = null; }
      if (groupRaw != null) {
        var groupDraft = null, groupIssue = '';
        try { groupDraft = JSON.parse(groupRaw); } catch (error) { groupIssue = '原草稿格式无法识别，请保留原文核对'; }
        result.push({key:groupKey,project_id:scope.anchor_project_id,label:(scope.name || '合并项目') + ' 原综合',
          ts:groupDraft && groupDraft.ts || null,draft:groupDraft,raw:groupRaw,error:groupIssue});
      }
      if (uid && typeof line === 'string' && line && line !== '综合') {
        var currentMonth = week.slice(0,7), date = new Date(week + 'T12:00:00Z');
        date.setUTCMonth(date.getUTCMonth()+1,1);
        var nextMonth = date.toISOString().slice(0,7);
        ids(scope).forEach(function(pid) {
          [currentMonth,nextMonth].forEach(function(month) {
            var identity = JSON.stringify([uid,pid,line,month]);
            var key = 'zh_monthly_plan_draft_v1_' + encodeURIComponent(identity), raw;
            try { raw = storage.getItem(key); } catch(error) { return; }
            if (raw == null) return;
            var saved = null, draft = null, issue = '';
            try {
              saved = JSON.parse(raw);
              if (!saved || saved.v !== 1 || JSON.stringify(saved.scope) !== identity || !Array.isArray(saved.items)) throw new Error('invalid_old_month_draft');
              draft = {bizItems:saved.items};
            } catch(error) { issue = '原月计划草稿格式无法识别，请保留原文核对'; }
            result.push({key:key,project_id:pid,line:line,plan_month:month,ts:saved && saved.ts || null,draft:draft,raw:raw,error:issue});
          });
        });
      }
    }
    return result;
  }
  function groupProjects(list, rows, period, reference, reports) {
    var result = [], used = Object.create(null);
    (list || []).forEach(function (project) {
      var scope = forProject(rows, project.id, period, reference, list, reports);
      if (!scope || used[scope.id]) return;
      used[scope.id] = true;
      result.push({name: scope.name || project.name, report_scope_id: scope.id,
        projects: (list || []).filter(function (p) { return ids(scope).indexOf(String(p.id)) >= 0; })});
    });
    var rest = (list || []).filter(function (p) { return !forProject(rows, p.id, period, reference, list, reports); });
    return result.concat(global.PlanningWindows ? global.PlanningWindows.groupProjects(rest) : rest.map(function (p) { return {name: p.display_group || p.name, projects: [p]}; }));
  }
  function legacyDraftHtml(row, options) {
    options = options || {};
    var esc = options.esc || function (value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); };
    var rich = options.richItem || function (record, key) { return esc(record && record[key] || ''); };
    var draft = row && row.draft, raw = row && row.raw != null ? row.raw : JSON.stringify(draft, null, 2) || '';
    var original = '<details class="legacy-draft-original"><summary>原始草稿备份（可选中复制）</summary><textarea readonly rows="8" aria-label="原始草稿备份" style="width:100%;font-family:monospace">' + esc(raw) + '</textarea></details>';
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return '<p class="notice err">原稿格式无法识别，原文仍保留，可展开备份核对。</p>' + original;
    function rows(value) { return Array.isArray(value) ? value.filter(function (item) { return item && typeof item === 'object' && !Array.isArray(item); }) : []; }
    function content(item, key) { return rich(item, key, '未填写'); }
    function table(title, headers, items, cells) {
      return items.length ? '<section class="legacy-draft-section"><h3>' + esc(title) + '</h3><div class="tablewrap"><table><thead><tr>'
        + headers.map(function (heading) { return '<th>' + esc(heading) + '</th>'; }).join('') + '</tr></thead><tbody>'
        + items.map(function (item) { return '<tr>' + cells(item).map(function (value, index) { return '<td data-label="' + esc(headers[index]) + '">' + value + '</td>'; }).join('') + '</tr>'; }).join('')
        + '</tbody></table></div></section>' : '';
    }
    var nodes = Array.isArray(draft.bizNodes) ? rows(draft.bizNodes) : rows(draft.nodeRows).concat(rows(draft.myRows));
    nodes = nodes.filter(function (item) { return item.name || item.prog || item.reason; });
    var html = '<p class="notice">' + esc(options.projectName || row.project_id || '原项目') + ' · 本机草稿（未提交，只读核对）</p>'
      + (row.ts && options.formatTime ? '<p class="muted">原稿保存时间：' + esc(options.formatTime(row.ts)) + '</p>' : '');
    html += table('原核心节点记录', ['节点', '原计划完成时间', '原预计完成时间', '原稿进展'], nodes, function (item) {
      return [content(item,'name'), esc(item.plan || '未设置'), esc(item.forecast || '未设置'), content(item,Object.prototype.hasOwnProperty.call(item,'prog') ? 'prog' : 'reason')];
    });
    html += table(row.plan_month ? row.plan_month + ' 原月计划事项' : '当月计划事项', ['模块或类别', '事项内容', '完成时间', '原稿进展', '遇到卡点'], rows(draft.bizItems).filter(function (item) { return item.name || item.prog || item.blocker; }), function (item) {
      return [item.mod ? content(item,'mod') : '未指定', content(item,'name'), esc(item.due || '未设置'), content(item,'prog'), content(item,'blocker')];
    });
    html += table('需要协调', ['协调对象', '协调内容', '最晚时间'], rows(draft.coordRows).filter(function (item) { return item.who || item.what; }), function (item) {
      return [esc(item.who || '未指定'), content(item,'what'), esc(item.by || '未设置')];
    });
    html += table('原移交事项', ['移交内容', '移交对象', '完成时间'], rows(draft.bizHand).filter(function (item) { return item.what; }), function (item) {
      return [content(item,'what'), esc(item.to || '未指定'), esc(item.due || '未设置')];
    });
    var statuses = {open:'未完成',in_progress:'办理中',completed:'已完成',blocked:'遇到阻碍'};
    html += table('同步事项', ['事项来源', '事项内容', '完成时间', '原稿进展', '处理状态'], rows(draft.followupRows), function (item) {
      return [esc(item.title || '原同步事项'), content(item,'what'), esc(item.due || '未设置'), content(item,'progress'), esc(statuses[item.status] || '原状态待核对')];
    });
    var form = {change:draft.change,risk:draft.risk,impact:draft.impact,projection:draft.projection,_rich:{}}, fields = draft.richFields || {};
    [['change','change_text'],['risk','dev_text'],['projection','projection']].forEach(function (pair) { if (fields[pair[1]]) form._rich[pair[0]] = fields[pair[1]]; });
    [['本周变化','change'],['风险说明','risk'],['影响','impact'],['原判断与对策','projection']].forEach(function (pair) {
      if (form[pair[1]]) html += '<section><h3>' + esc(pair[0]) + '</h3><div>' + content(form,pair[1]) + '</div></section>';
    });
    var next = rows((Array.isArray(draft.next) ? draft.next : []).map(function (text, index) { return {text:text,_rich:{text:fields['next_' + index]}}; })).filter(function (item) { return item.text; });
    html += table('下周必须完成', ['原稿内容'], next, function (item) { return [content(item,'text')]; });
    html += table('提速对策', ['对策', '预计成效'], rows(draft.speedRows).filter(function (item) { return item.act || item.gain; }), function (item) { return [content(item,'act'),content(item,'gain')]; });
    html += table('效果保障', ['对策', '目标'], rows(draft.effectRows).filter(function (item) { return item.act || item.target; }), function (item) { return [content(item,'act'),content(item,'target')]; });
    var attachments = Array.isArray(draft.attachmentIds) ? draft.attachmentIds : [];
    if (attachments.length) html += '<section><h3>原稿附件引用</h3><p class="muted">保留原引用；打开时仍由系统核对原附件权限，未重新归入统一报告。</p><ul>' + attachments.map(function (id, index) {
      var valid = typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      return '<li>' + (valid ? '<a href="/api/report-attachments/' + esc(id) + '" target="_blank" rel="noopener noreferrer">打开原稿附件 ' + (index + 1) + '</a>' : '原稿附件 ' + (index + 1) + ' 引用待核对') + '</li>';
    }).join('') + '</ul></section>';
    return html + original;
  }
  function history(reports, scope, pid) {
    var members = scope ? ids(scope) : [String(pid)];
    return (reports || []).filter(function (report) {
      return report.report_scope_id ? !!scope && report.report_scope_id === scope.id : members.indexOf(String(report.project_id)) >= 0;
    });
  }
  global.ReportScopes = {ids: ids, allowed: allowed, professional: professional, active: active, forProject: forProject, byId: byId, projects: projects,
    findReport: findReport, reportProjects: reportProjects, matchesProject: matchesProject, readable: readable,
    draftKey: draftKey, legacyDrafts: legacyDrafts, groupProjects: groupProjects, legacyDraftHtml: legacyDraftHtml, history: history};
})(window);

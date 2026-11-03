/* Calendar windows and explicit baseline scope shared by the report and overview. */
(function (global) {
  'use strict';
  var DAY = 86400000;
  function iso(date) { return date.toISOString().slice(0, 10); }
  function parse(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) === '0000') return null;
    var date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && iso(date) === value ? date : null;
  }
  function todayShanghai(value) {
    var date = value == null ? new Date() : new Date(value);
    return Number.isFinite(date.getTime()) ? iso(new Date(date.getTime() + 8 * 3600000)) : '';
  }
  function addDays(value, count) {
    var date = parse(value);
    return date && Number.isInteger(count) ? iso(new Date(date.getTime() + count * DAY)) : '';
  }
  function monday(value) {
    var date = parse(value);
    return date ? addDays(value, 1 - (date.getUTCDay() || 7)) : '';
  }
  function addMonth(value) {
    var date = parse(value);
    if (!date) return '';
    var year = date.getUTCFullYear(), month = date.getUTCMonth();
    var last = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
    return iso(new Date(Date.UTC(year, month + 1, Math.min(last, date.getUTCDate()))));
  }
  function windowFor(start, mode) {
    if (!parse(start) || !['week', 'month'].includes(mode)) return null;
    var end = mode === 'week' ? addDays(start, 7) : addMonth(start);
    return { start: start, end: addDays(end, -1), exclusiveEnd: end };
  }
  function weekNumber(value) {
    var date = parse(value);
    if (!date) return null;
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    return Math.ceil(((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
  }
  function periodStart(period, reference) {
    if (typeof period !== 'string') return '';
    // New labels can carry the actual calendar year. Legacy MM.DD labels need
    // the report timestamp (or the current Shanghai date for a selected form).
    var explicit = /(\d{4})[-./](\d{2})[-./](\d{2})/.exec(period);
    if (explicit) {
      var full = explicit[1] + '-' + explicit[2] + '-' + explicit[3];
      return parse(full) ? monday(full) : '';
    }
    var short = /[（(]\s*(\d{1,2})[./](\d{1,2})\s*[–—~～至-]/.exec(period);
    var ref = typeof reference === 'string' && parse(reference) ? reference : todayShanghai(reference);
    if (!ref) return '';
    var year = Number(ref.slice(0, 4)), candidates = [], wn = /第\s*(\d+)\s*周/.exec(period);
    if(!short){
      if(!wn || Number(wn[1])<1 || Number(wn[1])>53)return '';
      for(var offset=-2;offset<=2;offset++){
        var first=String(year+offset).padStart(4,'0')+'-01-04';
        var start=addDays(monday(first),(Number(wn[1])-1)*7);
        if(weekNumber(start)===Number(wn[1]))candidates.push(start);
      }
      candidates.sort(function(a,b){return Math.abs(parse(a)-parse(ref))-Math.abs(parse(b)-parse(ref));});
      return candidates[0] || '';
    }
    for (var offset = -2; offset <= 2; offset++) {
      var value = String(year + offset).padStart(4, '0') + '-' + String(short[1]).padStart(2, '0') + '-' + String(short[2]).padStart(2, '0');
      var date = parse(value);
      if (date && date.getUTCDay() === 1 && (!wn || weekNumber(value) === Number(wn[1]))) candidates.push(value);
    }
    candidates.sort(function (a, b) { return Math.abs(parse(a) - parse(ref)) - Math.abs(parse(b) - parse(ref)); });
    return candidates[0] || '';
  }
  function samePeriod(a, b, aReference, bReference) {
    var first = periodStart(a, aReference), second = periodStart(b, bReference);
    return !!first && first === second;
  }
  function scopeOf(row, commercial) {
    var value = row && row[commercial ? 'biz_line' : 'discipline'];
    return typeof value === 'string' ? value.trim() : '';
  }
  function scopedMilestones(rows, options) {
    options = options || {};
    var selected = options.commercial ? options.bizLine : options.discipline;
    return (rows || []).filter(function (row) {
      if (!row || String(row.project_id) !== String(options.projectId) || options.keyOnly !== false && !row.is_key) return false;
      var date = typeof row.plan_date === 'string' ? row.plan_date.slice(0, 10) : '';
      if (!parse(date) || !options.window || date < options.window.start || date >= options.window.exclusiveEnd) return false;
      var scope = scopeOf(row, options.commercial);
      if (!scope) return !!options.includeUnassigned;
      return !!options.allScopes || !!selected && scope === selected;
    }).slice().sort(function (a, b) {
      return String(a.plan_date).localeCompare(String(b.plan_date)) || (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(a.id).localeCompare(String(b.id));
    });
  }
  function nodeFromMilestone(row) {
    return { milestone_id: row.id, name: row.name || '', plan: String(row.plan_date || '').slice(0, 10),
      forecast: String(row.forecast_date || '').slice(0, 10), prog: '', is_key: !!row.is_key, custom: false };
  }
  function prefillNodes(existing, baselines, options) {
    options = options || {};
    var rows = Array.isArray(existing) ? existing.slice() : [], used = Object.create(null);
    rows.forEach(function (row) { if (row && row.milestone_id != null) used[String(row.milestone_id)] = true; });
    var additions = [];
    (baselines || []).forEach(function (row) {
      if (!row || row.id == null || used[String(row.id)]) return;
      used[String(row.id)] = true; additions.push(nodeFromMilestone(row));
    });
    return { rows: options.submitted || options.edited ? rows : rows.concat(additions), additions: additions };
  }
  function groupProjects(projects) {
    var groups = [], byName = Object.create(null);
    (projects || []).forEach(function (project) {
      if (!project) return;
      var name = typeof project.display_group === 'string' && project.display_group.trim() || project.name || String(project.id);
      if (!byName[name]) { byName[name] = { name: name, projects: [] }; groups.push(byName[name]); }
      byName[name].projects.push(project);
    });
    return groups;
  }
  global.PlanningWindows = { todayShanghai: todayShanghai, addDays: addDays, monday: monday, addMonth: addMonth,
    windowFor: windowFor, periodStart: periodStart, samePeriod: samePeriod, scopedMilestones: scopedMilestones,
    scopeOf: scopeOf, nodeFromMilestone: nodeFromMilestone, prefillNodes: prefillNodes, groupProjects: groupProjects };
})(window);

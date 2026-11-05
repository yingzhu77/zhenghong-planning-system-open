/* 正弘 · 项目周度经营直报 —— V3.0
   设计原则：计划是「引导值」，不是判决值。
   系统负责把该想的事推到项目经理面前，项目经理负责回答「偏了多少、为什么、怎么追、怎么保」。 */
(function () {
  'use strict';

  var CFG = {
    /* 管理员由服务端离线开通；浏览器配置不授予账号权限。 */
    adminEmails: [],

    /* 会话空闲超时（小时）：超过该时长无操作自动退出登录 */
    sessionIdleHours: 12,

    /* 同一邮箱连续登录失败次数上限（客户端防护，仅作威慑） */
    loginFailLimit: 5
  };

  var rootEl = document.getElementById('root');
  if (!window.WorkBuddyCloud || !window.WorkBuddyCloud.createWorkBuddyCloud) {
    rootEl.innerHTML = '<div class="boot">云服务组件加载失败，请刷新页面重试；若仍不行请联系系统管理员。</div>';
    return;
  }
  var cloud = window.WorkBuddyCloud.createWorkBuddyCloud();
  var db = cloud.database;
  function assetUrl(name) { return window.PlanningBoot && window.PlanningBoot.assets[name] || name; }

  /* ================= 常量 ================= */

  var ROLE_LABEL = { pm: '提报人', ops: '管理员', president: '总裁', pzo: '项目总', viewer: '查看人' };
  var IMPACTS = ['无明显影响', '工期/节点', '开盘/销售', '现金流/回款', '成本', '交付/客户', '多项经营影响'];
  var NO_IMPACT = '无明显影响';
  var SPEED = ['领跑', '达标', '滞后'];
  var EFFECT = ['优秀', '良好', '待改善'];
  /* ---- 商业项目（弘坊类）专用口径 ----
     模块＝弘坊周例会的专业汇报口径（东西地块土建／机电工程／精装工程／幕墙和景观／开发／
     建筑结构设计／机电设计／精装设计／成本／招采），每个模块各填一条报告；
     普通住宅按管理员指定专业填报；原综合及统一范围保留原入口。 */
  var LINE_ALL = '综合';
  function residentialReportLine(pid,period) {
    var scope=reportScopeFor(pid,period), discipline=(S.profile || {}).discipline;
    if(scope)return scope.reporting_mode==='professional'?(DISCIPLINES.indexOf(discipline)>=0?discipline:''):LINE_ALL;
    var legacy=(S.reports || []).some(function(r){return r.project_id===pid && (r.line || LINE_ALL)===LINE_ALL && r.author_id===S.uid
      && (window.PlanningWindows?window.PlanningWindows.samePeriod(r.period,period,r.submitted_at || r.created_at):r.period===period);});
    return legacy || DISCIPLINES.indexOf(discipline)<0?LINE_ALL:discipline;
  }
  var BIZ_LINES = ['土建工程（东地块）', '土建工程（西地块）', '机电工程', '精装工程', '幕墙设计+工程', '景观设计+工程',
    '开发', '建筑结构设计', '机电设计', '精装设计', '成本', '招采', '设计部'];
  function businessLinesForProject(pid) {
    return BIZ_LINES.filter(function(line){return line!=='设计部' || pid==='hf';});
  }
  function businessLinesForProjects(projects) {
    return BIZ_LINES.filter(function(line){return (projects || []).some(function(project){return businessLinesForProject(project.id).indexOf(line)>=0;});});
  }
  function myBizLines(pid) {
    pid=pid===undefined?S.pmProject:pid;
    var line = S.profile && S.profile.biz_line, lines=businessLinesForProject(pid),selected=lines.indexOf(line)>=0?[line]:[];
    if(line==='*')return lines;
    var state=dataState && dataState.businessModuleGrants;
    if(pid==='hf' && S.profile && S.profile.role==='pm' && S.profile.status==='approved' && (!state || state.ready && !state.error)
      && myProjects().some(function(project){return project.id===pid && project.project_type==='com';})){
      (S.businessModuleGrants || []).forEach(function(grant){if(grant.user_id===S.uid && grant.project_id===pid && grant.line==='设计部' && !selected.includes(grant.line))selected.push(grant.line);});
    }
    return selected;
  }
  function selectedBizLine(pid) {
    var lines = myBizLines(pid);
    if(dataState && dataState.businessModuleGrants && dataState.businessModuleGrants.error && S.pmLine==='设计部' && (pid===undefined?S.pmProject:pid)==='hf')return S.pmLine;
    return lines.indexOf(S.pmLine) >= 0 ? S.pmLine : lines[0] || '';
  }
  function canReportBizLine(line,pid) { return myBizLines(pid).indexOf(line) >= 0; }
  function myBizLineLabel(pid) {
    return S.profile && S.profile.biz_line === '*' ? '全部商业模块（测试）' : myBizLines(pid).join('、') || '待管理员分配';
  }
  /* ---- 专业条线字典（组织口径，与上面的弘坊填报模块是两套，各管一段）----
     用途：「我的条线」按此把节点切给各专业；弘坊仍按上面的 BIZ_LINES 分模块填报。
     节点归属存在 milestones.line，人员归属存在 profiles.discipline。
     要增删条线（如把「商管运营」拆成招商/商管），只改这一处即可。 */
  var DISCIPLINES = ['开发报建', '设计', '工程', '成本', '招采', '营销', '商管运营', '客服', '财务'];
  /* 项目主数据窗口：设计数据与经营指标的字段表（值存 project_master.fields，jsonb） */
  var MASTER_FIELDS = [
    { k: 'city', t: '所在城市' },
    { k: 'area', t: '用地面积（㎡）' },
    { k: 'gfa', t: '总建筑面积（㎡）' },
    { k: 'plot_gfa', t: '计容建筑面积（㎡）' },
    { k: 'far', t: '容积率' },
    { k: 'mix', t: '业态构成' },
    { k: 'floors', t: '楼栋 / 层数' },
    { k: 'parking', t: '车位（个）' },
    { k: 'fitout', t: '装修 / 交付标准' },
    { k: 'open_date', t: '预计首次开盘' },
    { k: 'handover_date', t: '预计首批交付' },
    { k: 'land_cost', t: '土地款（万元）' },
    { k: 'target_cost', t: '目标总成本（万元）' },
    { k: 'target_price', t: '整盘均价（元/㎡）' },
    { k: 'owner_company', t: '开发主体' }
  ];
  /* 图纸分类：项目总图 / 分期图 / 户型图 / 其他 */
  var DRAWING_KINDS = ['项目总图', '分期图', '户型图', '其他'];
  /* 分期与销售套数表头（存 project_phases） */
  var PHASE_COLS = [
    { k: 'name', t: '分期名称', w: '15%' },
    { k: 'area', t: '用地（㎡）', w: '10%' },
    { k: 'gfa', t: '建面（㎡）', w: '10%' },
    { k: 'units_total', t: '总套数', w: '9%' },
    { k: 'units_launched', t: '已推', w: '8%' },
    { k: 'units_sold', t: '已售', w: '8%' },
    { k: 'avg_price', t: '均价（元/㎡）', w: '12%' },
    { k: 'value', t: '货值（万元）', w: '11%' },
    { k: 'plan_handover', t: '计划交付', w: '12%' }
  ];
  /* 事项完成情况：与月度计划会的「计划完成情况」同口径 */
  var ITEM_STATUS = ['已完成', '按计划推进', '滞后', '未启动'];
  /* 开业倒计时口径：开业目标日由项目 biz_meta.open_date 提供 */
  var IMPACTS_BIZ = ['无明显影响', '开业时点', '租金收入', '成本', '工程品质', '多项经营影响'];
  /* 效果未评价时独立展示，避免把缺失值算作待改善。 */
  var NO_EFFECT = '未评价';
  /* 组织层级字典（原为散落在 orgOptions 里的内联对象，集中于此便于维护） */
  var ORG_LEVELS = { 1: '决策层', 2: '管理层', 3: '专业条线', 4: '外部' };
  var VIEW_TITLE = {
    form: ['本期经营直报', '计划是引导值，不是判决值；本期研判哪些节点由你选、由你判断'],
    mine: ['我的项目', '项目总览与节点基线：切换项目、查看基线、进入填报'],
    center: ['个人中心', '你的个人工作台：进展统计、待办优先级、专项汇总一屏看清'],
    base: ['节点基线', '公司计划作为引导值；本周预计由项目经理更新'],
    history: ['历史直报', '本项目历次填报存档，按周期倒序'],
    board: ['运营汇总', '全部项目周度经营直报汇总'],
    dual: ['经营双维', '速度（做得快）× 效果（做得好）两个维度的项目分布与经营对策'],
    nodes: ['节点偏差总表', '关键节点「计划引导值 vs 本周预计」偏差一览'],
    coord: ['协调与支持需求', '按协调对象聚合，谁该出手一目了然'],
    pres: ['报总裁浏览版', '各项目实时关键信息、需要协调与决策事项，一屏看完'],
    members: ['成员管理', '审批成员、分配项目（可一人多项目）'],
    mline: ['我的条线', '查看负责节点及原计划，按实际完成或延期需求逐项申报'],
    lineAdm: ['节点归属维护', '给每条节点指定专业条线与责任人，条线视图才能算得出来'],
    master: ['项目主数据', '节点计划 / 项目总图 / 分期图 / 设计数据 / 销售套数，一处看全']
  };

  /* ================= 工具 ================= */

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  /* 2026-10-15：醒目标记——**加粗**、==标红==
     用户在填报框里选中文字点工具条即可插入；展示端（汇总/卡片/个人中心/打印）统一渲染成样式。
     rich() 先转义再替换，只认这两种固定标记，不引入任意 HTML，无 XSS 风险。 */
  var MK_B = /\*\*([^*\n]+)\*\*/g, MK_R = /==([^=\n]+)==/g;
  function rich(s) {
    return esc(s).replace(MK_B, '<b>$1</b>').replace(MK_R, '<span class="mk-red">$1</span>');
  }
  function richItem(record, path, fallback) {
    if (window.ZHRichText) return window.ZHRichText.field(record, path, fallback);
    var v = String(path).split('.').reduce(function (o,k) { return o == null ? null : o[k]; },record);
    return rich(v == null || v === '' ? (fallback || '') : v);
  }
  function richCopy(source,target,mapping) { return window.ZHRichText ? window.ZHRichText.copy(source,target,mapping) : target; }
  function richCollect(row) { return window.ZHRichText ? window.ZHRichText.collect(JSON.parse(JSON.stringify(row))) : row; }
  // Merge only the working copy. Saved reports and their history stay untouched until submission.
  function mergePlanProgress(row) {
    if (!row || !row.blocker) return row;
    var model = window.ZHRichText, progress = String(row.prog || ''), blocker = String(row.blocker);
    if (model) {
      var first = model.doc(row, 'prog') || model.legacy(progress), last = model.doc(row, 'blocker') || model.legacy(blocker);
      row._rich = Object.assign({}, row._rich, { prog: model.normalize({ops: first.ops.concat(progress ? [{insert:'\n遇到卡点：'}] : [{insert:'遇到卡点：'}], last.ops)}) });
      delete row._rich.blocker;
    }
    row.prog = progress + (progress ? '\n' : '') + '遇到卡点：' + blocker; row.blocker = '';
    return row;
  }
  function attachRich(rows) { if(window.ZHRichText) (rows || []).forEach(window.ZHRichText.attach); }
  function richBinding(id) {
    var modules = [window.AdminPlans, window.MonthlyPlans, window.CoordinationWorkbench, window.CompletionReview, window.ZHAdminArchive];
    for (var i = 0; i < modules.length; i++) {
      var binding = modules[i] && modules[i].binding && modules[i].binding(id);
      if (binding) return binding;
    }
    var reporterBinding = window.ReporterTasks && window.ReporterTasks.binding(id);
    if (reporterBinding) return reporterBinding;
    var meetingBinding=window.OverviewMeetings && window.OverviewMeetings.binding(id);
    if(meetingBinding)return meetingBinding;
    var owner, key, m;
    var roots = {f_change:'change_text',f_risk:'dev_text',f_projection:'projection'};
    if(roots[id]) {owner=S.formRich || (S.formRich={});key=roots[id];}
    else if((m=/^nx-(\d+)$/.exec(id))) {owner=S.formRich || (S.formRich={});key='next_'+m[1];}
    else {
      var specs=[['my_nm_',S.myRows,'name'],['my_rs_',S.myRows,'reason'],['nd_rs_',S.nodeRows,'reason'],['co_what_',S.coordRows,'what'],['sp_act_',S.speedRows,'act'],['ef_act_',S.effectRows,'act'],['bn_pg_',S.bizNodes,'prog'],['bi_mod_',S.bizItems,'mod'],['bi_nm_',S.bizItems,'name'],['bi_pg_',S.bizItems,'prog'],['bi_blocker_',S.bizItems,'blocker'],['bh_what_',S.bizHand,'what']];
      specs.some(function(spec){if(id.indexOf(spec[0])===0){owner=(spec[1] || [])[Number(id.slice(spec[0].length))];key=spec[2];return true;}});
      if(!owner && (m=/^(ceonote_|pzonote_)(.+)$/.exec(id))) {
        var kind=m[1]==='ceonote_'?'ceo':'pzo', draftKey=kind+':'+m[2];
        S.reviewRichDrafts=S.reviewRichDrafts || {};
        var review=reviewOf(m[2],kind);
        owner=S.reviewRichDrafts[draftKey] || (S.reviewRichDrafts[draftKey]=richCopy(review || {},{note:review && review.note || ''})); key='note';
      }
      if(!owner && (m=/^(cbw_|pzw_)(.+)_(\d+)$/.exec(id))) {owner=briefDraftRows(m[2],m[1]==='cbw_'?'ceo_brief':'pzo_note')[Number(m[3])];key='what';}
      if(!owner && (m=/^ml_note_(.+)$/.exec(id))) {owner=S.milestones.filter(function(row){return String(row.id)===m[1];})[0];key='note';}
    }
    if(!owner || !key) return null;
    return {get:function(){return owner._rich && owner._rich[key] || (window.ZHRichText && window.ZHRichText.doc(owner,key));},set:function(doc){owner._rich=owner._rich || {};owner._rich[key]=doc;if(/^(ceonote_|pzonote_)/.test(id) && window.ZHRichText)owner.note=window.ZHRichText.text(doc);}};
  }
  function richInputRow(row,id,key) {
    var link=richBinding(id), doc=link && link.get();
    if(doc) {row._rich=row._rich || {};row._rich[key]=doc;}
    return richCollect(row);
  }
  /* A narrow text edit replaces its formatting paths while retaining unrelated fields. */
  function richPartialUpdate(previous, patch, replacedPaths) {
    var result=richCollect(patch), fields=Object.assign({},previous.rich_text && previous.rich_text.fields || {});
    Object.keys(fields).forEach(function(path){
      if(replacedPaths.some(function(prefix){return path === prefix || path.indexOf(prefix+'.') === 0;}))delete fields[path];
    });
    result.rich_text={v:1,fields:Object.assign(fields,result.rich_text && result.rich_text.fields || {})};
    return result;
  }
  function stripMark(s) { return String(s == null ? '' : s).replace(MK_B, '$1').replace(MK_R, '$1'); }
  function val(id) { var e = document.getElementById(id); return e ? String(e.value == null ? '' : e.value).trim() : ''; }
  function pick(name) { var e = document.querySelector('input[name="' + name + '"]:checked'); return e ? e.value : null; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isoWeek(d) {
    var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    var day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    var ys = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil((((t - ys) / 86400000) + 1) / 7);
  }
  function weekRange(d) {
    var t = new Date(d), day = t.getDay() || 7;
    var mon = new Date(t); mon.setDate(t.getDate() - day + 1);
    var sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    function f(x) { return pad2(x.getMonth() + 1) + '.' + pad2(x.getDate()); }
    return f(mon) + '–' + f(sun);
  }
  function calendarToday() {return window.PlanningWindows?new Date(window.PlanningWindows.todayShanghai()+'T12:00:00'):new Date();}
  function currentPeriod() { var n = calendarToday(); return '第' + isoWeek(n) + '周（' + weekRange(n) + '）'; }
  function weekNo(p) { var m = /第\s*(\d+)\s*周/.exec(p || ''); return m ? Number(m[1]) : null; }
  function todayISO() { var d = calendarToday(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function addDays(iso, n) {
    if (!iso) return '';
    var d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    if (isNaN(d.getTime())) return '';
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function dayDiff(a, b) {
    if (!a || !b) return null;
    var aa=String(a).slice(0,10),bb=String(b).slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(aa) || !/^\d{4}-\d{2}-\d{2}$/.test(bb))return null;
    var A = new Date(aa + 'T00:00:00Z'), B = new Date(bb + 'T00:00:00Z');
    if(!Number.isFinite(+A) || !Number.isFinite(+B) || A.toISOString().slice(0,10)!==aa || B.toISOString().slice(0,10)!==bb)return null;
    return Math.round((A - B) / 86400000);
  }
  function lightOf(d) { return d === null || d === undefined ? 'gray' : d >= 15 ? 'red' : d > 0 ? 'yellow' : 'green'; }
  function deviationStatus(d,done) { return done?'已完成':d===null || d===undefined?'日期不足':d>=15?'异常':d>=5?'关注':d>0?'轻微偏差':'正常'; }
  function devCellHtml(d) {
    var L = d === null ? 'gray' : lightOf(d);
    return '<span class="dot d-' + L + '"></span>' + (d === null ? '<span class="muted">日期不足</span>' : (d > 0 ? '+' + d + ' 天' : d < 0 ? d + ' 天' : '按计划'));
  }
  function sd(x) { return x ? String(x).slice(0, 10) : '—'; }
  function devTxt(d) {
    if (d === null || d === undefined) return '<span class="muted">日期不足</span>';
    if (d > 0) return '<span style="color:#b91c1c;font-weight:600">+' + d + ' 天</span>';
    if (d < 0) return '<span style="color:#047857">' + d + ' 天</span>';
    return '<span class="muted">按计划</span>';
  }
  /* 状态徽标：改用 CSS 圆点渲染，避免 emoji 在部分 Windows 环境显示不一致 */
  function badge(s) {
    var c = s === '正常' ? 'green' : s === '关注' ? 'yellow' : s === '异常' ? 'red' : 'gray';
    return '<span class="badge ' + c + '"><i class="bico"></i>' + esc(s) + '</span>';
  }
  function speedPill(v) {
    if (!v) return '<span class="muted">未评价</span>';
    var c = v === '领跑' ? 'green' : v === '达标' ? 'blue' : 'amber';
    return '<span class="badge ' + c + '">' + esc(v) + '</span>';
  }
  function effectPill(v) {
    if (!v || v === NO_EFFECT) return '<span class="badge gray">未评价</span>';
    var c = v === '优秀' ? 'green' : v === '良好' ? 'blue' : 'amber';
    return '<span class="badge ' + c + '">' + esc(v) + '</span>';
  }
  function fmtTime(t) {
    if (!t) return '—';
    var d = new Date(t);
    if (isNaN(d.getTime())) return String(t).slice(0, 16).replace('T', ' ');
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function toast(msg, kind) {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div'); el.id = 'toast';
      el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:34px;z-index:99;padding:12px 22px;border-radius:8px;font-size:13px;box-shadow:0 8px 24px rgba(15,23,42,.18);max-width:80vw;text-align:center;line-height:1.6';
      document.body.appendChild(el);
    }
    el.style.background = kind === 'err' ? '#fee2e2' : kind === 'warn' ? '#fef3c7' : '#ecfdf5';
    el.style.color = kind === 'err' ? '#991b1b' : kind === 'warn' ? '#92400e' : '#065f46';
    el.textContent = msg; el.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.style.display = 'none'; }, 3600);
  }
  function rowsOf(id) { return Array.prototype.slice.call(document.querySelectorAll('#' + id + ' [data-row]')); }
  /* 取值：元素不存在时回退到给定值（供草稿保存时复用内存里的旧值） */
  function valIf(id, fallback) {
    var e = document.getElementById(id);
    if (!e) return fallback == null ? '' : fallback;
    return String(e.value == null ? '' : e.value).trim();
  }
  function plain(s) { return String(s == null ? '' : s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }
  function stamp() {
    var d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  /* ================= 弹窗（替代 window.prompt，避免被浏览器拦截 / 明文暴露） ================= */

  function closeModal() { var m = document.getElementById('zh_modal'); if (m && m.parentNode) m.parentNode.removeChild(m); }
  function renderModal(title, bodyHtml, onMount) {
    closeModal();
    var wrap = document.createElement('div');
    wrap.id = 'zh_modal'; wrap.className = 'modalmask';
    wrap.innerHTML = '<div class="modalbox"><div class="modalhd"><b>' + esc(title) + '</b>'
      + '<button type="button" class="modalx" data-close="1">✕</button></div>'
      + '<div class="modalbd">' + bodyHtml + '</div></div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) closeModal(); });
    var x = wrap.querySelector('[data-close]'); if (x) x.addEventListener('click', closeModal);
    if (onMount) onMount(wrap);
  }
  function modalMsg(wrap, text, kind) {
    var m = wrap.querySelector('#fp_msg'); if (!m) return;
    m.className = 'authmsg ' + (kind || ''); m.textContent = text || '';
  }

  /* ================= 账号安全辅助 ================= */

  /* 账号密码：6 至 128 个字符，不限制字符组合。 */
  function pwdIssue(p) {
    if (typeof p !== 'string' || p.length < 6 || p.length > 128) return '密码须为 6 至 128 个字符，可使用纯数字';
    return null;
  }
  function failKey(email) { return 'zh_loginfail_' + String(email || '').toLowerCase(); }
  function failState(email) {
    try { return JSON.parse(localStorage.getItem(failKey(email)) || '{}') || {}; } catch (e) { return {}; }
  }
  function failBump(email) {
    var s = failState(email); s.n = (s.n || 0) + 1; s.t = Date.now();
    try { localStorage.setItem(failKey(email), JSON.stringify(s)); } catch (e) {}
  }
  function failClear(email) { try { localStorage.removeItem(failKey(email)); } catch (e) {} }
  /* 返回剩余锁定分钟数，0 表示未锁定 */
  function failBlockMin(email) {
    var s = failState(email), now = Date.now(), win = 15 * 60000;
    if (!s.n || !s.t || now - s.t > win) return 0;
    if (s.n < CFG.loginFailLimit) return 0;
    return Math.max(1, Math.ceil((win - (now - s.t)) / 60000));
  }

  /* 运营管理员白名单校验：未配置名单时保持原有行为，保证向后兼容 */
  function isAdminEmail(email) {
    var list = (CFG.adminEmails || []).map(function (s) { return String(s).toLowerCase().trim(); }).filter(Boolean);
    if (!list.length) return true;
    return list.indexOf(String(email || '').toLowerCase().trim()) >= 0;
  }
  /* 当前登录邮箱（注册/建档阶段的判定依据） */
  function sessionEmail() {
    var s = S.session || {};
    var u = s.user || s;
    return (u && u.email) || '';
  }

  /* ================= 草稿（本地暂存，防止误刷新丢失填报内容） ================= */

  var draftAutosaveTimer = null;
  function pmDraftScope() {
    return JSON.stringify([dataEpoch,S.uid,S.pmProject,S.pmPeriod,S.pmLine || '',S.pmScopeId || '',S.view]);
  }
  function canCapturePMDraft() {
    return !S.pmScopeTransition && (S.pmRenderedScope === undefined || S.pmRenderedScope === pmDraftScope());
  }
  function markPMRenderedScope() {
    if (S.profile && S.profile.role === 'pm' && (S.view === 'form' || S.view === 'center')) S.pmRenderedScope = pmDraftScope();
  }
  async function changePMScope(update, prepare, force) {
    if (attachmentBusy()) return;
    snapDraft();
    if ((S.view === 'form' || S.view === 'center') && canCapturePMDraft() && !saveDraft(S.view === 'center')) return;
    clearTimeout(draftAutosaveTimer);
    var token = {uid:S.uid,session:S.session,epoch:dataEpoch};
    if (S.pmRenderedScope === undefined) S.pmRenderedScope = pmDraftScope();
    S.pmScopeTransition = token;
    /* Remove the former scope's inputs before changing any model keys. */
    render('<div class="boot" role="status" aria-live="polite">正在加载填报页面…</div>');
    update();
    try { return await showPage(prepare !== false, force, token); }
    finally {
      if (S.pmScopeTransition === token) {
        S.pmScopeTransition = null;
        if (S.uid === token.uid && S.session === token.session && dataEpoch === token.epoch) {
          render('<div class="card"><div class="notice err" role="alert">页面未能完整加载，原范围的本机草稿已保留。请重试读取当前页面。</div><button type="button" class="btn" onclick="App.reload()">重新加载</button></div>');
        }
      }
    }
  }

  function draftKey() {
    if (S.pmReportScope && window.ReportScopes) return window.ReportScopes.draftKey(S.uid,S.pmReportScope,S.pmPeriod,null,S.pmLine);
    /* 商业项目按模块分别暂存，避免切换模块时草稿互相覆盖 */
    var ln = (S.pmProject && isCom(S.pmProject)) ? '_' + String(S.pmLine || '') : '';
    return 'zh_draft_' + (S.uid || 'anon') + '_' + (S.pmProject || '') + ln + '_' + (weekNo(S.pmPeriod) || '0');
  }
  /* force=true：允许在「个人中心」写草稿（只给工作面移交登记用；
     避免进个人中心就凭空生成一份草稿，导致回填报页时弹假的「已恢复草稿」提示） */
  function saveDraft(force, skipMonthly) {
    if (!canCapturePMDraft()) return false;
    if (!S.uid || !S.pmProject) return false;
    if (!draftKey()) return false;
    if (!force && S.view !== 'form') return false;
    var prev = S.draft || {};
    var prevNext = Array.isArray(prev.next) ? prev.next : [];
    try {
      if(!skipMonthly && window.MonthlyPlans && !window.MonthlyPlans.saveDraft())throw new Error('下月计划草稿保存失败');
      var payload = {
        nodeRows: S.nodeRows, myRows: S.myRows, coordRows: S.coordRows,
        speedRows: S.speedRows, effectRows: S.effectRows,
        richFields: S.formRich && S.formRich._rich || {},
        line: S.pmLine || LINE_ALL,
        bizNodes: S.bizNodes || [], bizItems: S.bizItems || [], bizHand: S.bizHand || [],
        planningAIEntries:window.PlanningAIDraft?window.PlanningAIDraft.entries(S.bizItems || [],S.planningAIEntries || []):S.planningAIEntries || [],
        monthlyUnmatchedItems:S.monthlyUnmatchedItems || [],
        followupRows: S.followupRows || [], attachmentIds: S.attachmentIds || [],
        change: valIf('f_change', prev.change),
        risk: valIf('f_risk', prev.risk),
        impact: valIf('f_impact', prev.impact),
        projection: valIf('f_projection', prev.projection),
        speed: pick('sp') || prev.speed || null,
        effect: pick('ef') || prev.effect || null,
        next: [valIf('nx-0', prevNext[0]), valIf('nx-1', prevNext[1]), valIf('nx-2', prevNext[2])]
      };
      if(window.MonthlyPlans && window.MonthlyPlans.planReferences){var monthlyReferences=window.MonthlyPlans.planReferences();if(Object.keys(monthlyReferences).length)payload.monthlyPlanReferences=monthlyReferences;}
      /* 内容没变就不写：否则每次进个人中心都会刷新草稿时间戳 */
      var rawPrev = null;
      try { rawPrev = localStorage.getItem(draftKey()); } catch (e2) {}
      if (rawPrev) {
        try {
          var pd = JSON.parse(rawPrev);
          if (pd) { var savedTime=pd.ts; delete pd.ts; if (JSON.stringify(pd) === JSON.stringify(payload)) {setDraftStatus('本机草稿已保存（未提交） · '+fmtTime(savedTime),'saved');return true;} }
        } catch (e2) { /* 旧格式草稿，直接覆盖 */ }
      }
      payload.ts = Date.now();
      localStorage.setItem(draftKey(), JSON.stringify(payload));
      S.draft = payload;
      setDraftStatus('本机草稿已保存（未提交） · '+fmtTime(payload.ts),'saved');
      return true;
    } catch (e) { setDraftStatus('本机草稿保存失败，请提交或复制内容后再离开。','error');return false; }
  }
  function setDraftStatus(message,kind) {
    var element=document.getElementById('planDraftStatus');
    if(element){element.textContent=message;element.setAttribute('data-state',kind || 'unsaved');}
  }
  function loadDraft() {
    if (!S.uid || !S.pmProject) return null;
    if (!draftKey()) return null;
    try {
      var raw = localStorage.getItem(draftKey());
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || !d.ts) return null;
      /* 超过 30 天的草稿自动作废 */
      if (Date.now() - d.ts > 30 * 86400000) { localStorage.removeItem(draftKey()); return null; }
      return d;
    } catch (e) { return null; }
  }
  function clearDraft() { try { var key=draftKey();if(key)localStorage.removeItem(key); } catch (e) {} }

  /* ================= 导出 ================= */

  function csvCell(v) {
    return '"' + String(v == null ? '' : v).replace(/\r?\n/g, ' ').replace(/"/g, '""') + '"';
  }
  function exportTable(filename, headers, rows) {
    try {
      var lines = [headers.map(csvCell).join(',')];
      rows.forEach(function (r) { lines.push(r.map(csvCell).join(',')); });
      /* Excel 需要 BOM 才能正确识别 UTF-8 中文 */
      var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      toast('已导出 ' + rows.length + ' 行，可直接用 Excel 打开');
    } catch (e) {
      toast('导出失败：当前浏览器不支持本地下载', 'err');
    }
  }
  function devText(d) { return d === null || d === undefined ? '日期不足' : (d > 0 ? '+' + d + ' 天' : d < 0 ? d + ' 天' : '按计划'); }

  /* ================= 状态 ================= */

  var S = {
    session: null, uid: null, profile: null,
    projects: [], reportScopes: [], milestones: [], reports: [], members: [], orgList: [], pms: [], businessModuleGrants: [], versions: [],
    reviews: [], leaderNotes: [], coordinationTasks: [], monthlyPlans: [], monthlySummaries: [], monthlyUnmatchedItems: [], briefDrafts: {},
    /* 项目主数据：master=设计数据与经营指标 / phases=分期与销售套数 / drawings=项目图纸 */
    master: [], phases: [], drawings: [],
    /* 运营端「节点归属维护」的本地编辑缓冲：{ milestoneId: { line, owner_dept, owner_name, is_key } } */
    lineEdits: {},
    /* 「我的条线」页当前项目与条线筛选 */
    mlProject: '', mlLine: '',
    view: 'form',
    /* 汇总口径：res=住宅汇总 / com=商业汇总（由左侧导航决定，见 renderShell） */
    ptype: 'res',
    filters: { project: '', status: '', impact: '' },
    overviewUI: { project: '', line: '', discipline: '', open: {} },
    authTab: 'pwd', roleChoice: 'pm', obProjects: [], obLine: '',
    pmProject: null, pmPeriod: currentPeriod(), pmReport: null, pmLine: null,
    nodeRows: [], myRows: [], coordRows: [], speedRows: [], effectRows: [],
    bizNodes: [], bizItems: [], bizHand: [],
    dualMode: 'speed',
    draft: null, draftRestored: false, loadErrors: []
  };
  var pendingOtp = null;

  function isReviewer() { return !!S.profile && (S.profile.role === 'ops' || S.profile.role === 'president'); }
  /* 项目总（pzo）：只看「报项目总浏览版」，可写批示与评价，不能改任何填报数据 */
  function isPzo() { return !!S.profile && S.profile.role === 'pzo'; }
  function isPresident() { return !!S.profile && S.profile.role === 'president'; }
  /* 总裁评价/交代由总裁或运营管理员写，项目总评价/批示由项目总或运营管理员写；
     author_role 按真实角色留痕，避免代填被误认为本人。 */
  function canWriteCeo() { return !!S.profile && (S.profile.role === 'president' || S.profile.role === 'ops'); }
  function canWritePzo() { return !!S.profile && (S.profile.role === 'pzo' || S.profile.role === 'ops'); }
  function projName(pid) { var p = S.projects.filter(function (x) { return x.id === pid; })[0]; return p ? p.name : (pid || '—'); }

  /* ================= 商业项目辅助 ================= */

  function projOf(pid) { return S.projects.filter(function (x) { return x.id === pid; })[0] || null; }
  function ptype(pid) { var p = projOf(pid); return (p && p.project_type) || 'res'; }
  function isCom(pid) { return ptype(pid) === 'com'; }
  function comMeta(pid) { var p = projOf(pid); return (p && p.biz_meta) || {}; }
  /* 距开业天数：正数表示距开业还有多少天，负数表示已过目标日 */
  function daysToOpen(pid) {
    var d = comMeta(pid).open_date;
    return d ? dayDiff(d, todayISO()) : null;
  }
  function bizOf(r) { return (r && r.biz) || {}; }
  /* ① 本月核心节点计划 */
  function nodesOf(r) { var b = bizOf(r); return Array.isArray(b.nodes) ? b.nodes : []; }
  /* ② 当月计划填报（模块 / 事项 / 完成时间 / 当前进展） */
  function itemsOf(r) { var b = bizOf(r); return Array.isArray(b.items) ? b.items : []; }
  /* ④ 工作面移交事项 */
  function handoverOf(r) { var b = bizOf(r); return Array.isArray(b.handover) ? b.handover : []; }
  /* 事项是否已过完成时间：自由填写，系统只按日期做提示，不强制状态
     （当前进展里已写明完成的，不再标红） */
  function itemOverdue(x) {
    if (!x || !x.due || String(x.due).slice(0, 10) >= todayISO()) return false;
    return !isCompletedProgress(x.prog);
  }
  function isCompletedProgress(value) {
    var progress = stripMark(value);
    if (/未完成|尚未完成|未完工|未移交|未交圈|未验收|未通过|未签|未定标|未封顶|未办结/.test(progress)) return false;
    return /已完成|已完工|已移交|已交圈|已验收|已通过|已签|已定标|已封顶|已办结|^(?:完成|完工|办结)$/.test(progress.trim());
  }
  /* 当月（自然月）内到期 */
  function inThisMonth(d) { return !!(d && String(d).slice(0, 7) === todayISO().slice(0, 7)); }
  /* 某项目本期各模块的报告（商业项目按 line 一行一条） */
  function weekReportsOf(pid) {
    var wn = weekNo(currentPeriod());
    return S.reports.filter(function (r) { return r.project_id === pid && weekNo(r.period) === wn; });
  }
  function lineReport(pid, period, line) {
    return S.reports.filter(function (r) {
      return r.project_id === pid && r.period === period && (r.line || LINE_ALL) === line && r.author_id === S.uid;
    })[0] || null;
  }
  /* 商业项目：本期已报模块数 / 未报模块 */
  function lineStat(pid) {
    var rs = weekReportsOf(pid), done = {};
    rs.forEach(function (r) { done[r.line || LINE_ALL] = r; });
    var lines=businessLinesForProject(pid),missing = lines.filter(function (l) { return !done[l]; });
    return { done: done, reported: lines.length - missing.length, total: lines.length, missing: missing };
  }
  /* 某模块本期的事项统计（数量 + 已过完成时间数） */
  function itemStat(r) {
    var it = itemsOf(r);
    return { total: it.length, overdue: it.filter(itemOverdue).length };
  }
  /* 节点基线的候选列表（供「本月核心节点计划」下拉/联想使用） */
  function bizNodeOptions(pid) {
    var scope=isCom(pid)?S.pmLine:S.profile && S.profile.discipline;
    return msOf(pid).filter(function(m){return !window.PlanningWindows || !!scope && window.PlanningWindows.scopeOf(m,isCom(pid))===scope;}).slice().sort(function (a, b) {
      return String(a.plan_date || '9999').localeCompare(String(b.plan_date || '9999'));
    });
  }
  /* 商业项目：把本期各模块的填报聚合成一张摘要（总裁浏览版 / 运营汇总共用） */
  function comSummary(pid) {
    var rs = weekReportsOf(pid), st = lineStat(pid);
    var items = [], nodes = [], hand = [], coords = [];
    rs.forEach(function (r) {
      var ln = r.line || LINE_ALL;
      itemsOf(r).forEach(function (x) { if (x && (x.name || '').trim()) items.push({ line: ln, author: r.author_name, x: x }); });
      nodesOf(r).forEach(function (x) { if (x && (x.name || '').trim()) nodes.push({ line: ln, author: r.author_name, x: x }); });
      handoverOf(r).forEach(function (x) { if (x && (x.what || '').trim()) hand.push({ line: ln, author: r.author_name, x: x }); });
      (r.coord_items || []).forEach(function (c) {
        if (c && (c.who || c.what)) coords.push(richCopy(c,{ who: c.who, what: c.what, by: c.by, line: ln, pid: pid }));
      });
    });
    var overdue = items.filter(function (o) { return itemOverdue(o.x); });
    var handOverdue = hand.filter(function (o) { return o.x.due && String(o.x.due).slice(0, 10) < todayISO(); });
    return {
      rs: rs, st: st, items: items, nodes: nodes, hand: hand, coords: coords,
      overdue: overdue, handOverdue: handOverdue,
      authors: rs.map(function (r) { return { line: r.line || LINE_ALL, name: r.author_name, at: r.updated_at || r.submitted_at }; })
    };
  }
  /* 一行摘要：把一组事项渲染成 · 列表 */
  function listBrief(arr, render, maxN) {
    if (!arr.length) return '<span class="muted">—</span>';
    var n = maxN || 4;
    return arr.slice(0, n).map(function (o, i) { return '· ' + render(o, i); }).join('<br>')
      + (arr.length > n ? '<br><span class="muted">…共 ' + arr.length + ' 项</span>' : '');
  }
  /* 开业倒计时（醒目块） */
  function countdownHtml(pid) {
    var meta = comMeta(pid), d = daysToOpen(pid);
    if (d === null) {
      return '<div class="cdwrap"><div class="cdnum"><b>—</b></div>'
        + '<div class="cdtxt"><b>未设置开业目标日</b><span>请联系运营管理员核对项目开业目标日</span></div></div>';
    }
    var past = d < 0;
    return '<div class="cdwrap' + (past ? ' past' : '') + '">'
      + '<div class="cdnum"><b>' + Math.abs(d) + '</b><span>天</span></div>'
      + '<div class="cdtxt"><b>' + (past ? '开业目标日已过 ' + Math.abs(d) + ' 天' : '距 ' + esc(meta.open_date) + ' 正式开业') + '</b></div></div>';
  }

  function msOf(pid) {
    return S.milestones.filter(function (m) { return m.project_id === pid; })
      .sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
  }
  function myProjects() {
    if (!S.profile) return [];
    if (isReviewer()) return S.projects;
    var ids = {};
    S.pms.forEach(function (m) { if (m.user_id === S.uid) ids[m.project_id] = true; });
    S.projects.forEach(function (p) { if (p.id === S.profile.project_id) ids[p.id] = true; });
    return S.projects.filter(function (p) { return ids[p.id]; });
  }
  function reportScopeFor(pid,period) {
    return window.ReportScopes?window.ReportScopes.forProject(S.reportScopes,pid,period || S.pmPeriod || currentPeriod(),null,myProjects(),S.reports):null;
  }
  function pmScopeProjectIds() { return S.pmReportScope?S.pmReportScope.project_ids.slice():[S.pmProject]; }
  function professionalPMScope() { return !!(S.pmReportScope && S.pmReportScope.reporting_mode==='professional'); }
  function reportingProjects() {
    return window.ReportScopes?window.ReportScopes.projects(myProjects(),S.reportScopes,S.pmPeriod || currentPeriod(),null,S.reports):myProjects();
  }
  function reportScopeName(pid) { var scope=reportScopeFor(pid);return scope?scope.name:projName(pid); }
  function reportInPeriod(report,period) {
    if(!report)return false;
    if(window.PlanningWindows){
      var stored=window.PlanningWindows.periodStart(report.period,report.scope_week || report.submitted_at || report.created_at);
      var selected=window.PlanningWindows.periodStart(period);
      if(stored && selected)return stored===selected;
    }
    return report.period===period;
  }
  function reportItemProjectId(report,item) {
    if(!report.report_scope_id)return report.project_id;
    var pid=item && item.project_id,members=report.scope_project_ids || [];
    return pid && members.indexOf(pid)>=0?pid:'';
  }
  function reportItemSourceHtml(report,item) {
    if(!report.report_scope_id)return '';
    var pid=reportItemProjectId(report,item);
    return '<div class="overview-meta" data-source-project="'+esc(pid)+'">'+esc(pid?'实际项目：'+projName(pid):'统一范围事项（原记录未明确实际项目）')+'</div>';
  }
  function reportScopeTitle(report) {
    var scope=(S.reportScopes || []).filter(function(row){return row.id===report.report_scope_id;})[0];
    return report.report_scope_id?(scope && scope.name || '统一住宅范围'):projName(report.project_id);
  }
  function pmHistoryReports() {
    var scope=S.pmReportScope || (S.reportScopes || []).filter(function(row){return row.project_ids.indexOf(S.pmProject)>=0;})[0];
    return window.ReportScopes?window.ReportScopes.history(S.reports,scope,S.pmProject):S.reports.filter(function(r){return r.project_id===S.pmProject;});
  }
  function legacyScopeDraftTitle(row) {
    return row.plan_month?projName(row.project_id)+' · '+row.plan_month+' '+row.line+' 月计划':row.label || projName(row.project_id);
  }
  function legacyScopeDraftsHtml() {
    if(!S.pmReportScope || !window.ReportScopes)return '';
    var drafts=window.ReportScopes.legacyDrafts(localStorage,S.uid,S.pmReportScope,S.pmPeriod,weekNo,S.pmLine);
    var professional=professionalPMScope(), oldReports=professional?pmHistoryReports().filter(function(report){return !report.report_scope_id || (report.line || LINE_ALL)===LINE_ALL;}):[];
    return '<p class="notice">'+esc(S.pmReportScope.name)+(professional?'：统一项目入口，各专业分别提报自己的事项。当前专业：'+esc(S.pmLine || '待管理员分配')+'；原分期数据和历史记录保留。':'：本期统一一份综合报告，由同一填报人更新。原三个项目、节点和事项来源保留。')+'</p>'
      +(S.pmLegacyReportConflict?'<p class="notice err" role="alert">本专业该周期已有原项目报告，不能自动改为合并项目或覆盖原作者。请先在原历史记录中核对，当前新草稿独立保留。</p>':'')
      +(drafts.length?'<details class="notice"><summary>发现 '+drafts.length+' 份'+(professional?'旧':'原地块')+'本机草稿（独立保留）</summary><p>请逐份核对原稿，组稿不会自动拼接或覆盖它们。</p>'
        +drafts.map(function(row){return '<button type="button" class="btn ghost sm" onclick="App.showLegacyScopeDraft(\''+esc(row.key)+'\')">核对 '+esc(legacyScopeDraftTitle(row))+' 原稿'+(row.ts?' · '+esc(fmtTime(row.ts)):'')+'</button>';}).join('')+'</details>':'')
      +(oldReports.length?'<details class="notice merged-scope-history"><summary>原项目与综合填报 '+oldReports.length+' 份（只读核对）</summary><p>原报告的项目、作者和内容保持，新的专业填报不会自动合并或覆盖它们。</p>'
        +oldReports.map(function(report){return '<button type="button" class="btn ghost sm" onclick="App.showReportHistory('+Number(report.id)+')">'+esc(reportScopeTitle(report))+' · '+esc(report.period)+' · '+esc(report.line || LINE_ALL)+' · '+esc(report.author_name || '原填报人')+'</button>';}).join('')+'</details>':'');
  }
  /* ===== 专业条线（组织口径）与项目主数据 读取工具 ===== */

  function myDisc() { return (S.profile && S.profile.discipline) || ''; }
  /* 「我的条线」可见范围：
     项目经理（未设条线）＝ 我参与项目的全部节点；专业条线成员 ＝ 我参与项目中本专业的节点。
     可见项目 = project_members 里我参与的 + profiles.project_id 指向的（运营/总裁为全部）。 */
  function lineMilestones() {
    var ids = {};
    myProjects().forEach(function (p) { ids[p.id] = true; });
    var disc = myDisc();
    return S.milestones.filter(function (m) {
      if (!ids[m.project_id]) return false;
      if (!disc) return true;
      return (m.line || '') === disc;
    }).sort(function (a, b) {
      return String(a.plan_date || '9999').localeCompare(String(b.plan_date || '9999'));
    });
  }
  /* 节点分桶：已逾期 / 未来 30 天到期 / 本周期关键节点 / 其余在办 / 已完成
     判定用「预计完成日」优先、缺省用计划日，与节点偏差总表同一口径 */
  function lineBuckets(list) {
    var t = todayISO(), d30 = addDays(t, 30);
    var out = { overdue: [], soon: [], key: [], rest: [], done: [] };
    list.forEach(function (m) {
      if (m.done) { out.done.push(m); return; }
      var pd = m.plan_date ? String(m.plan_date).slice(0, 10) : '';
      var fd = m.forecast_date ? String(m.forecast_date).slice(0, 10) : '';
      var eff = fd || pd;
      if (eff && eff < t) { out.overdue.push(m); return; }
      if (eff && eff <= d30) { out.soon.push(m); return; }
      if (m.is_key) { out.key.push(m); return; }
      out.rest.push(m);
    });
    return out;
  }

  /* ---- 项目主数据 ---- */
  function masterOf(pid) { return S.master.filter(function (x) { return x.project_id === pid; })[0] || null; }
  function masterFields(pid) { var r = masterOf(pid); return (r && r.fields) || {}; }
  function phasesOf(pid) {
    return S.phases.filter(function (x) { return x.project_id === pid; })
      .sort(function (a, b) { return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0); });
  }
  function drawingsOf(pid, kind) {
    return S.drawings.filter(function (x) { return x.project_id === pid && (!kind || x.kind === kind); })
      .sort(function (a, b) { return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0); });
  }
  /* 分期汇总：销售合计与去化率（只计有值的行，避免把空行算成 0） */
  function phaseSum(pid) {
    var s = { total: 0, launched: 0, sold: 0, hasSold: false, rate: null };
    phasesOf(pid).forEach(function (p) {
      if (Number(p.units_total)) s.total += Number(p.units_total);
      if (Number(p.units_launched)) s.launched += Number(p.units_launched);
      if (Number(p.units_sold)) { s.sold += Number(p.units_sold); s.hasSold = true; }
    });
    s.rate = s.launched ? Math.round(s.sold / s.launched * 1000) / 10 : null;
    return s;
  }

  function latestReport(pid) {
    return S.reports.filter(function (r) { return window.ReportScopes?window.ReportScopes.matchesProject(r,pid):r.project_id === pid; })
      .sort(function (a, b) { return (weekNo(b.period) || 0) - (weekNo(a.period) || 0) || new Date(b.submitted_at) - new Date(a.submitted_at); })[0] || null;
  }
  function myProfessionalScopeReport(report,pid) {
    var scope=S.profile && S.profile.role==='pm' && reportScopeFor(pid,S.pmPeriod || currentPeriod());
    return !scope || scope.reporting_mode!=='professional' || report.author_id===S.uid
      && report.report_scope_id===scope.id && report.line===S.profile.discipline;
  }
  /* 最大偏差：同时计入「节点基线」与「经理本期自选节点」，
     避免出现「灯号显示正常、研判节点却写着 +30 天」的自相矛盾 */
  function maxDelay(pid, report) {
    var values = [];
    msOf(pid).forEach(function (m) { if (!m.done && m.forecast_date && m.plan_date) values.push(dayDiff(m.forecast_date, m.plan_date)); });
    var r = arguments.length > 1 ? report : latestReport(pid);
    if (r) pickedNodes(r).forEach(function (n) { if (n.d !== null && n.d !== undefined) values.push(n.d); });
    values = values.filter(function (d) { return isFinite(d); });
    return values.length ? Math.max.apply(Math, values) : 0;
  }
  function suggestStatus(pid) { var d = maxDelay(pid); return d >= 15 ? '异常' : d >= 5 ? '关注' : '正常'; }
  function speedOfDelay(d) { return d >= 5 ? '滞后' : d <= -5 ? '领跑' : '达标'; }
  function suggestSpeed(pid) { return speedOfDelay(maxDelay(pid)); }
  function statusOf(pid) {
    var r = latestReport(pid);
    if (!r) return '未填报';
    return suggestStatus(pid);
  }
  function submittedThisWeek(pid) {
    var scope=S.profile && S.profile.role==='pm' && reportScopeFor(pid,S.pmPeriod || currentPeriod());
    if(scope && scope.reporting_mode==='professional')return (S.reports || []).some(function(report){
      return myProfessionalScopeReport(report,pid) && reportInPeriod(report,S.pmPeriod || currentPeriod());
    });
    var r = latestReport(pid);
    if (!r) return false;
    return weekNo(r.period) === weekNo(currentPeriod());
  }
  function nextKey(pid) {
    var t = todayISO();
    var open = msOf(pid).filter(function (m) { return !m.done && m.plan_date; });
    /* 由近向远：先取已逾期中最早期的，否则取未来最近的 */
    open.sort(function (a, b) { return String(a.plan_date).localeCompare(String(b.plan_date)); });
    if (!open.length) return msOf(pid).filter(function (m) { return !m.done; })[0] || null;
    var over = open.filter(function (m) { return m.plan_date < t; });
    return over.length ? over[0] : open[0];
  }
  function pmOf(pid) {
    var ids = {};
    S.pms.forEach(function (m) { if (m.project_id === pid) ids[m.user_id] = true; });
    S.members.forEach(function (m) { if (m.project_id === pid) ids[m.user_id] = true; });
    var names = S.members.filter(function (m) { return ids[m.user_id]; }).map(function (m) { return m.name || '未填姓名'; });
    return names.length ? names.join('、') : '未指派';
  }
  /* 项目经理本期自己选的研判节点（含自定义），带偏差 */
  function pickedNodes(r) {
    if (!r) return [];
    return (r.node_items || []).filter(function (n) { return n && n.name; }).map(function (n) {
      return richCopy(n,{
        name: n.name, plan: n.plan || '', forecast: n.forecast || '',
        d: (n.plan && n.forecast) ? dayDiff(n.forecast, n.plan) : null,
        custom: !!n.custom, reason: n.reason || '', source_id:n.source_id, project_id:n.project_id
      });
    }).sort(function (a, b) { return (b.d === null ? -999 : b.d) - (a.d === null ? -999 : a.d); });
  }
  function pickedCell(r, pid) {
    var list = pickedNodes(r);
    if (!list.length) {
      var nk = nextKey(pid), d = nk ? dayDiff(nk.forecast_date, nk.plan_date) : null;
      return '<span class="muted">' + (r ? '本期未选节点' : '尚未填报') + '</span>'
        + (nk ? '<div class="muted" style="margin-top:4px">参考下一节点：' + esc(nk.name) + ' ' + devTxt(d) + '</div>' : '');
    }
    return list.slice(0, 3).map(function (n) {
      return '<div style="margin-bottom:5px"><b>' + richItem(n,'name') + '</b>' + (n.custom ? ' <span class="chip">自定</span>' : '')
        + '<div class="muted">' + esc(sd(n.plan)) + ' → ' + esc(sd(n.forecast)) + ' ' + devTxt(n.d) + '</div></div>';
    }).join('') + (list.length > 3 ? '<div class="muted">另有 ' + (list.length - 3) + ' 项…</div>' : '');
  }

  /* ================= 登录 ================= */

  /* keepScroll=true 时保持页面滚动位置，避免「增删一行就跳回顶部」 */
  function render(html, keepScroll) {
    var y = keepScroll ? (window.pageYOffset || (document.documentElement && document.documentElement.scrollTop) || 0) : 0;
    rootEl.innerHTML = html;
    if (window.ZHRichEditor) window.ZHRichEditor.mount(rootEl,richBinding);
    if (window.PlanningAI) window.PlanningAI.refresh();
    if (window.ReportReference) window.ReportReference.refresh();
    if (window.MeetingController) window.MeetingController.refresh();
    if(S.view==='form' && S.draft && S.draft.ts)setDraftStatus('本机草稿已保存（未提交） · '+fmtTime(S.draft.ts),'saved');
    /* 2026-10-15：自动长高文本域——重渲染（增删行/切节点/切周期）后按内容撑开已有文字 */
    growAll();
    if (keepScroll && y > 0) {
      if (window.requestAnimationFrame) window.requestAnimationFrame(function () { window.scrollTo(0, y); });
      else window.scrollTo(0, y);
    }
  }
  /* data-grow 文本域按内容自适应高度（输入时由 App.grow 逐个调用） */
  function growOne(t) { if(t.hidden)return; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
  function growAll() {
    if (!rootEl || !rootEl.querySelectorAll) return;
    var ts = Array.from(rootEl.querySelectorAll('textarea[data-grow]')).filter(function(t){return !t.hidden;});
    ts.forEach(function(t){t.style.height='auto';});
    var heights=ts.map(function(t){return t.scrollHeight;});
    ts.forEach(function(t,i){t.style.height=heights[i]+'px';});
  }

  function setMsg(msg, cls) { var e = document.getElementById('msg'); if (e) { e.className = 'authmsg ' + (cls || ''); e.textContent = msg || ''; } }
  function tabBtn(id, text, on) { return '<button type="button" class="' + (on === id ? 'on' : '') + '" onclick="App.authTab(\'' + id + '\')">' + text + '</button>'; }

  /* 登录/建档页卡片顶部品牌区（磨砂卡片 + 透明 LOGO） */
  function authBackground() {
    return '<picture class="auth-background" aria-hidden="true">'
      + '<source type="image/avif" media="(max-width:900px)" srcset="' + assetUrl('login-bg-mobile.avif') + '">'
      + '<source type="image/avif" media="(min-width:901px)" srcset="' + assetUrl('login-bg-desktop.avif') + '">'
      + '<source type="image/webp" media="(max-width:900px)" srcset="' + assetUrl('login-bg-mobile.webp') + '">'
      + '<img src="' + assetUrl('login-bg-desktop.webp') + '" alt="" fetchpriority="high" decoding="async"></picture>';
  }

  function authBrand() {
    return '<div class="ac-brand"><img src="' + assetUrl('logo.png') + '" alt="正弘置业 ZHENGHONG PROPERTY">'
      + '<div class="ac-name">工程建设数字化服务平台</div></div>';
  }

  function renderLogin(msg, cls) {
    var t = S.authTab;
    var initial = rootEl.querySelector && rootEl.querySelector('[data-initial-login]');
    if (initial && t === 'pwd' && !msg) {
      initial.removeAttribute('data-initial-login');
      var existingForm = document.getElementById('authForm');
      existingForm.removeAttribute('onsubmit');
      existingForm.addEventListener('submit', onAuthSubmit);
      return;
    }
    var needPwd = (t === 'pwd' || t === 'reg');
    var needCode = (t === 'otp' || t === 'reg');
    var html = '<div class="authpage planning-auth">' + authBackground() + '<div class="authcard">' + authBrand()
      + '<div class="authtabs">' + tabBtn('pwd', '密码登录', t) + tabBtn('otp', '验证码登录', t) + tabBtn('reg', '注册', t) + '</div>'
      + '<form id="authForm"><div class="afields">'
      + '<div class="authrow"><label for="email">邮箱</label><input id="email" type="email" placeholder="请输入邮箱" autocomplete="username"></div>';
    if (needPwd) html += '<div class="authrow"><label for="password">密码</label><input id="password" type="password" placeholder="' + (t === 'reg' ? '6 至 128 个字符，可使用纯数字' : '请输入密码') + '" autocomplete="' + (t === 'reg' ? 'new-password' : 'current-password') + '"></div>';
    if (needCode) html += '<div class="authrow' + (t === 'reg' ? ' full' : '') + '"><label for="code">邮箱验证码</label><div class="codrow"><input id="code" inputmode="numeric" placeholder="6 位验证码" autocomplete="one-time-code"><button type="button" class="btn ghost" id="sendBtn" onclick="App.sendCode()">获取验证码</button></div></div>';
    html += '<div class="authrow full"><button class="btn primary" style="width:100%" type="submit">' + (t === 'reg' ? '注册并登录' : '登录') + '</button></div>'
      + '</div><div id="msg" role="status" aria-live="polite" class="authmsg ' + (cls || '') + '">' + esc(msg || '') + '</div></form>';
    if (t === 'pwd') html += '<div class="auth-assist"><button type="button" class="btn link" onclick="App.forgot()">忘记密码</button></div>';
    if (t === 'reg') html += '<div class="authfoot">自助注册为提报人（普通账号），需管理员审核并分配项目。管理员、总裁、项目总为特殊账号，不提供自助注册。</div>';
    html += '</div></div>';
    render(html);
    var f = document.getElementById('authForm');
    if (f) f.addEventListener('submit', onAuthSubmit);
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    var passwordInput = document.getElementById('password');
    var t = S.authTab, email = val('email'), pwd = passwordInput ? String(passwordInput.value || '') : '', code = val('code');
    if (!email) return setMsg('请填写邮箱', 'err');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setMsg('邮箱格式不正确，请检查', 'err');
    if (t === 'pwd') { if (!pwd) return setMsg('请填写密码', 'err'); return doPasswordLogin(email, pwd); }
    if (t === 'otp') { if (!code) return setMsg('请填写验证码', 'err'); return doOtp(email, code); }
    var pi = pwdIssue(pwd); if (pi) return setMsg(pi, 'err');
    if (!code) return setMsg('请填写验证码', 'err');
    return doSignup(email, pwd, code);
  }

  function countdown(btn, sec) {
    var n = sec; btn.disabled = true; btn.textContent = n + 's 后重发';
    var timer = setInterval(function () {
      n--;
      if (n <= 0) { clearInterval(timer); btn.disabled = false; btn.textContent = '获取验证码'; }
      else btn.textContent = n + 's 后重发';
    }, 1000);
  }
  function uidFrom(o) {
    if (!o) return null;
    var u = o.user || o;
    return u.id || u.uid || u.userId || u.sub || o.userId || null;
  }
  function bindSession(data) {
    var next = (data && data.session) ? data.session : data;
    if(S.session!==next && window.PasswordChange)window.PasswordChange.close();
    S.session=next; S.uid=uidFrom(S.session);
  }
  async function resolveUid() {
    var u = uidFrom(S.session); if (u) return u;
    try { var g = await cloud.auth.getUser(); return uidFrom(g && g.data); } catch (e) { return null; }
  }
  async function doPasswordLogin(email, password) {
    var lock = failBlockMin(email);
    if (lock) return setMsg('连续登录失败次数过多，请在 ' + lock + ' 分钟后重试，或使用「忘记密码」重置。', 'err');
    setMsg('登录中…');
    var r;
    try { r = await cloud.auth.signInWithPassword({ email: email, password: password }); }
    catch (e) { r = { error: { message: String((e && e.message) || '网络异常') } }; }
    if (!r || r.error) {
      failBump(email);
      var left = CFG.loginFailLimit - (failState(email).n || 0);
      return setMsg('邮箱或密码不正确，请重试。' + (left > 0 && left <= 2 ? '（再失败 ' + left + ' 次将暂时锁定）' : ''), 'err');
    }
    failClear(email);
    bindSession(r.data); await afterLogin();
  }
  async function doOtp(email, token) {
    if (!pendingOtp || pendingOtp.email !== email) return setMsg('请先获取该邮箱的验证码', 'err');
    setMsg('验证中…');
    var r = await cloud.auth.verifyOtp({ email: pendingOtp.email, verificationId: pendingOtp.verificationId, isExistingUser: pendingOtp.isExistingUser, token: token });
    if (r.error) return setMsg(r.error.message || '验证码不正确', 'err');
    pendingOtp = null; bindSession(r.data); await afterLogin();
  }
  async function doSignup(email, password, token) {
    if (!pendingOtp || pendingOtp.email !== email) return setMsg('请先获取该邮箱的验证码', 'err');
    if (pendingOtp.isExistingUser) return setMsg('该邮箱已注册，请切换到「密码登录」或「验证码登录」。', 'err');
    setMsg('注册中…');
    var r = await cloud.auth.verifyOtp({ email: pendingOtp.email, verificationId: pendingOtp.verificationId, isExistingUser: false, token: token, password: password });
    if (r.error) return setMsg(r.error.message || '注册失败', 'err');
    pendingOtp = null; bindSession(r.data); await afterLogin();
  }

  /* ================= 登录后 ================= */

  async function afterLogin() {
    render('<div class="boot">正在加载数据…</div>');
    resetPageData();
    var epoch = dataEpoch;
    if (!S.uid) S.uid = await resolveUid();
    if (!S.uid) return renderFail('无法识别当前账号身份，请退出后重新登录。');
    if(S.session && S.session.user && S.session.user.must_change_password){
      var passwordSession=S.session;
      S.profile=null;
      render('<div class="boot">请先设置新的登录密码…</div>');
      try{
        if(!window.PlanningBoot || !window.PlanningBoot.ensurePasswordChange)throw new Error('改密组件未就绪');
        await window.PlanningBoot.ensurePasswordChange();
        if(epoch!==dataEpoch || S.session!==passwordSession)return;
        window.PasswordChange.show({session:passwordSession,
          isCurrent:function(){return epoch===dataEpoch && S.session===passwordSession;},
          onSuccess:async function(nextSession){
            if(epoch!==dataEpoch || S.session!==passwordSession)return;
            bindSession(nextSession);await afterLogin();
          },
          onLogout:async function(){
            var result=await cloud.auth.signOut();
            if(result && result.error)throw new Error(result.error.message || '退出失败');
            if(S.session===passwordSession){
              window.PasswordChange.close();bindSession(null);S.profile=null;resetPageData();renderLogin('已退出登录');
            }
          }});
      }catch(error){
        if(epoch===dataEpoch && S.session===passwordSession)renderFail('修改密码页面加载失败，请刷新重试或退出后重新登录。');
      }
      return;
    }
    var sessionProfile = S.session && S.session.user && S.session.user.profile;
    var r = sessionProfile ? { data: [sessionProfile] } : await db.from('profiles').select('*').eq('user_id', S.uid).limit(1);
    if (epoch !== dataEpoch) return;
    if (r.error) return renderFail('读取账号信息失败：' + (r.error.message || '未知错误'));
    S.profile = (r.data || [])[0] || null;
    if (!S.profile) return renderOnboarding();
    if(S.profile.role==='viewer' && S.profile.status!=='approved')return renderFail('查看人账号尚未通过审核，请联系管理员。');
    if(isPzo()){
      var projectsReady=await loadData(['projects','pms']);
      if(epoch!==dataEpoch)return;
      if(!projectsReady)return renderFail('负责项目读取失败，请刷新重试。');
      if(!myProjects().length)return renderFail('当前尚未分配负责项目，请联系管理员。');
    }
    S.view = S.profile.role === 'viewer' ? 'managementCoord' : S.profile.role === 'pm' ? 'form' : isPzo() && myProjects().some(function(p){return isCom(p.id);}) ? 'presCom' : 'pres';
    if(S.profile.role==='viewer')return showPage();
    if (window.PlanningBoot) {
      try { await Promise.all([loadPageData(), window.PlanningBoot.ensureEditor(), S.profile.role === 'pm' && window.PlanningBoot.ensureReporter ? window.PlanningBoot.ensureReporter() : Promise.resolve(),
        window.PlanningBoot.ensureWorkflow ? window.PlanningBoot.ensureWorkflow(true) : Promise.resolve(),
        window.PlanningBoot.ensureMonthlyPlans && ['pm','ops','president','pzo'].indexOf(S.profile.role)>=0 ? window.PlanningBoot.ensureMonthlyPlans() : Promise.resolve(),
        window.PlanningBoot.ensureOverview && isPlanningManager() ? window.PlanningBoot.ensureOverview() : Promise.resolve()]); }
      catch (error) { return renderFail('编辑组件加载失败，请刷新重试。'); }
    } else await loadPageData();
    if (epoch !== dataEpoch) return;
    [S.reports, S.milestones, S.reviews, S.leaderNotes].forEach(attachRich);
    if (S.profile.role === 'pm' && !myProjects().length) return renderWaiting();
    if (S.profile.role === 'pm') {
      S.pmProject = S.pmProject || (myProjects()[0] && myProjects()[0].id);
      await preparePM();
      S.view = 'form';
    }
    renderShell();
  }

  function renderFail(msg) {
    render('<div class="authpage">' + authBackground() + '<div class="authcard">' + authBrand() + '<h1>出了点问题</h1>'
      + '<div class="notice err">' + esc(msg) + '</div>'
      + '<button class="btn primary" onclick="App.logout()">退出登录</button></div></div>');
  }

  function reporterSourceId() {
    return window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : 'item-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }
  function reporterSummary(items) {
    var text = items.map(function (x) {return x.name.trim() + (String(x.prog || '').trim() ? '：' + x.prog.trim() : '');}).join('\n');
    if (!window.ZHRichText) return {text:text};
    var rt=window.ZHRichText,ops=[];
    items.forEach(function(x,i){
      if(i)ops.push({insert:'\n'});
      ['name','prog'].forEach(function(key){
        var value=String(x[key] || '').trim();if(!value)return;
        if(key==='prog')ops.push({insert:'：'});
        var doc=rt.fit(x._rich && x._rich[key] || rt.doc(x,key),value) || rt.legacy(value);
        ops=ops.concat(doc.ops);
      });
    });
    var doc={ops:ops};return {text:rt.text(doc),doc:doc};
  }
  async function reporterRequest(url, body) {
    try {
      var response = await fetch(url, body===undefined?{method:'GET',credentials:'same-origin'}:{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      var result = await response.json();
      if (!response.ok && !result.error) result.error = {message:'请求失败（HTTP ' + response.status + '）'};
      return result;
    } catch (error) { return {error:{message:'无法连接服务器，请检查网络后重试。'}}; }
  }
  var planningAITransactions=new Map();
  function meetingContext() {
    var allowed=!!(S.uid && S.profile && S.profile.status==='approved' && ['ops','president','pzo'].indexOf(S.profile.role)>=0),target=null;
    if(allowed && isManagerOverview()){
      var commercial=S.ptype==='com',projects=overviewProjects(commercial);
      if(commercial && S.overviewUI.line)projects=projects.filter(function(project){return businessLinesForProject(project.id).indexOf(S.overviewUI.line)>=0;});
      if(!commercial && S.overviewUI.project){var group=overviewProjectGroups().find(function(row){return row.name===S.overviewUI.project;});projects=group?group.projects:[];}
      if(projects.length)target={kind:'report',type:commercial?'com':'res',projectIds:projects.map(function(project){return String(project.id);}),
        period:window.PlanningWindows.periodStart(overviewPeriod()),line:commercial?S.overviewUI.line || '':S.overviewUI.discipline || '',section:'all'};
    }
    var readable=allowed?detailProjects():[];
    return {allowed:allowed,uid:S.uid,identity:JSON.stringify([S.uid,dataEpoch]),target:target,projects:readable,
      projectProfessions:readable.map(function(project){return {project_id:String(project.id),lines:project.project_type==='com'?businessLinesForProject(project.id):DISCIPLINES.concat('__unassigned__')};})};
  }
  function reportReferenceContext() {
    return {key:JSON.stringify([S.uid,dataEpoch,S.pmProject,S.pmPeriod,S.pmLine,S.pmScopeId || '',S.view]),
      canRead:!!(S.uid && S.profile && S.profile.role==='pm' && S.profile.status==='approved' && S.view==='form' && S.pmProject),
      uid:S.uid,projectIds:pmScopeProjectIds().map(String),readableProjects:S.projects.map(function(p){return {id:p.id};}),
      projectName:S.pmReportScope && S.pmReportScope.name || projName(S.pmProject),period:S.pmPeriod,
      reference:S.pmReport && S.pmReport.submitted_at || todayISO()};
  }
  async function loadReferenceReports(context) {
    var results=await Promise.all(context.projectIds.map(function(pid){
      return reporterRequest('/api/db',{table:'reports',operation:'select',
        columns:'id,project_id,period,author_id,author_name,line,submitted_at,updated_at,report_scope_id,scope_project_ids,scope_week,biz,rich_text,node_items,change_text,dev_text,dev_level,dev_impact,impact,projection,speed_items,effect_items,next_items,commit_items,coord_items,coord,decision,node_name,node_plan,node_forecast,self_speed,self_effect',
        filters:[{column:'project_id',value:pid}],order:[{column:'submitted_at',ascending:false}],limit:5000});
    }));
    var rows=[],seen=new Set();
    results.forEach(function(result){
      if(result.error)throw new Error(result.error.message || '已提交填报读取失败，请重试。');
      result.data.forEach(function(row){if(!seen.has(row.id)){seen.add(row.id);rows.push(row);}});
    });
    return {rows:rows,truncated:results.some(function(result){return result.data.length===5000;})};
  }
  function planningAIContext() {
    var editable=!!(S.uid && S.profile && S.profile.role==='pm' && S.profile.status==='approved'
      && S.view==='form' && S.pmProject && canCapturePMDraft() && !S.submittingReport
      && !S.pmLegacyReportConflict && (!professionalPMScope() || DISCIPLINES.indexOf(S.pmLine)>=0)
      && (!isCom(S.pmProject) || canReportBizLine(S.pmLine)));
    var identity=JSON.stringify([S.uid || '',dataEpoch]);
    var monthly=[],monthlyError='',weeklyRaw;
    if(editable && window.MonthlyPlans && window.MonthlyPlans.aiContext){
      try{monthly=window.MonthlyPlans.aiContext();weeklyRaw=localStorage.getItem(draftKey());}
      catch(error){monthlyError=error.message || '月计划本机草稿无法读取，请保留原输入后重试。';}
    }
    return {identityKey:identity,key:JSON.stringify([identity,S.pmProject,S.pmPeriod,S.pmLine,S.pmScopeId || '',S.view]),
      project_id:S.pmProject,period:S.pmPeriod,line:S.pmLine || LINE_ALL,report_scope_id:S.pmScopeId || undefined,
      projectName:S.pmReportScope && S.pmReportScope.name || projName(S.pmProject),lineLabel:S.pmLine===LINE_ALL?'住宅综合':S.pmLine,periodLabel:S.pmPeriod,
      canEdit:editable,items:window.PlanningAIDraft?window.PlanningAIDraft.items(S.bizItems):[],
      monthly_plans:monthly,monthly_error:monthlyError,weeklyDraftRaw:weeklyRaw,
      applied:window.PlanningAIDraft?window.PlanningAIDraft.entries(S.bizItems || [],S.planningAIEntries || []):[]};
  }
  function planningAIFile(file, signal) {
    return new Promise(function(resolve,reject){
      var reader=new FileReader();
      function cancel(){reader.abort();reject(new DOMException('已停止整理','AbortError'));}
      function cleanup(){if(signal)signal.removeEventListener('abort',cancel);}
      reader.onload=function(){cleanup();resolve({name:file.name,data_base64:String(reader.result).split(',')[1]});};
      reader.onerror=function(){cleanup();reject(new Error('附件读取失败，请重新选择文件。'));};
      reader.onabort=function(){cleanup();reject(new DOMException('已停止整理','AbortError'));};
      if(signal && signal.aborted)return cancel();
      if(signal)signal.addEventListener('abort',cancel,{once:true});
      reader.readAsDataURL(file);
    });
  }
  async function planningAIRequest(request) {
    var context=request.context, now=planningAIContext();
    if(!now.canEdit || now.key!==context.key || now.identityKey!==context.identityKey)throw new Error('填报范围已变化，请重新打开 AI 助手。');
    var files=[];
    for(var i=0;i<request.files.length;i++)files.push(await planningAIFile(request.files[i],request.signal));
    var response=await fetch('/api/planning-ai/chat',{method:'POST',credentials:'same-origin',signal:request.signal,
      headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:context.project_id,period:context.period,line:context.line,
        report_scope_id:context.report_scope_id,items:context.items.map(function(item){return {id:item.id,title:item.title,progress:item.progress};}),
        monthly_plans:(context.monthly_plans || []).map(function(plan){return {month:plan.month,items:plan.items};}),
        applied:(context.applied || []).map(function(entry){return {id:entry.id,entry_id:entry.entry_id,text:entry.text};}),messages:request.messages,files:files})});
    var result=await response.json();
    if(!response.ok || result.error)throw new Error(result.error && result.error.message || 'AI 整理失败，请稍后重试。');
    return result.data;
  }
  async function planningAIMemoryRequest(action,body,context,signal) {
    var now=planningAIContext();
    if(!now.canEdit || now.identityKey!==context.identityKey)throw new Error('登录或填报权限已变化，请重新打开 AI 助手。');
    if(['load','conversation','preference'].indexOf(action)<0)throw new Error('记忆操作无效。');
    var response=await fetch('/api/planning-ai/memory/'+action,{method:'POST',credentials:'same-origin',signal:signal,
      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    var result=await response.json();
    if(!response.ok || result.error){var error=new Error(result.error && result.error.message || '对话与记忆请求失败，请重试。');error.code=result.error && result.error.code;error.status=response.status;throw error;}
    return result.data;
  }
  async function refreshAIMonthlyPermission(context){
    await planningAIMemoryRequest('load',{project_id:context.project_id,period:context.period,line:context.line,report_scope_id:context.report_scope_id},context);
    var result=await reporterRequest('/api/monthly-plans/list',{});
    if(!result || result.error || !Array.isArray(result.data))throw new Error(result && result.error && result.error.message || '月计划确认状态未能重新核对，请重试；原草稿保留。');
    var now=planningAIContext();
    if(!now.canEdit || now.key!==context.key || now.identityKey!==context.identityKey)throw new Error('填报范围已变化，请重新整理。');
    S.monthlyPlans=result.data;
  }
  async function planningAIApply(request) {
    var monthly=request.draft && request.draft.monthly_plan, result;
    snapDraft(monthly && monthly.items && monthly.items.length ? true : undefined);
    if(monthly && monthly.items && monthly.items.length){
      await refreshAIMonthlyPermission(request.context);snapDraft(true);
      var now=planningAIContext();
      if(now.weeklyDraftRaw!==request.context.weeklyDraftRaw)throw new Error('本机草稿已被其他窗口修改，请重新读取并整理；没有覆盖原输入。');
      result=window.MonthlyPlans.aiApply(request.context,monthly);
    }else result=window.PlanningAIDraft.apply({context:request.context,current:planningAIContext(),draft:request.draft,
      rows:S.bizItems,entries:S.planningAIEntries || (S.planningAIEntries=[]),richText:window.ZHRichText,save:saveDraft});
    var receipt=result.transaction?'receipt-'+Date.now()+'-'+Math.random().toString(36).slice(2):'';
    if(result.transaction && result.transaction.kind==='monthly_plan' && !S.pmReportScope && result.transaction.month===window.MonthlyPlans.month())result.transaction.weeklyDraftRaw=localStorage.getItem(draftKey());
    if(receipt){if(planningAITransactions.size>=10)planningAITransactions.delete(planningAITransactions.keys().next().value);planningAITransactions.set(receipt,result.transaction);}
    renderShell(true);
    if(result.transaction && result.transaction.kind==='monthly_plan'){
      var normalized=window.MonthlyPlans.aiContext().find(function(plan){return plan.month===result.transaction.month;});
      if(normalized)result.transaction.after=normalized.signature;
    }
    return {message:result.message,count:result.count,receipt_id:receipt};
  }
  async function planningAIUndo(request){
    var transaction=planningAITransactions.get(request.receipt_id),result;
    snapDraft(transaction && transaction.kind==='monthly_plan' ? true : undefined);
    if(transaction && transaction.kind==='monthly_plan'){
      var context=planningAIContext();await refreshAIMonthlyPermission(context);snapDraft(true);
      if(Object.prototype.hasOwnProperty.call(transaction,'weeklyDraftRaw') && localStorage.getItem(draftKey())!==transaction.weeklyDraftRaw)throw new Error('其他窗口已修改草稿，不能直接撤销；原输入保留。');
      result=window.MonthlyPlans.aiUndo(transaction);
    }else result=window.PlanningAIDraft.undo({current:planningAIContext(),rows:S.bizItems,entries:S.planningAIEntries || [],transaction:transaction,save:saveDraft});
    planningAITransactions.delete(request.receipt_id);renderShell(true);return result;
  }
  function configureReporter() {
    if(window.MeetingController)window.MeetingController.configure({getContext:meetingContext,displayUrl:assetUrl('meeting-display.html'),notify:toast});
    if(window.ReportReference)window.ReportReference.configure({getContext:reportReferenceContext,loadReports:loadReferenceReports,
      projectName:projName,snapshotHtml:function(report){return reportSnapshotHtml(report,{reference:true});}});
    if(window.PlanningAI)window.PlanningAI.configure({getContext:planningAIContext,request:planningAIRequest,memoryRequest:planningAIMemoryRequest,onApply:planningAIApply,onUndo:planningAIUndo,onViewDraft:function(options){if(options && options.month && window.MonthlyPlans)window.MonthlyPlans.aiView(options.month);var target=options && options.month && document.querySelector('[data-plan-month="'+options.month+'"]') || document.querySelector('[data-rich-editor-for="bi_pg_0"]') || document.getElementById('bi_pg_0');if(target)target.scrollIntoView({behavior:'smooth',block:'center'});},notify:toast});
    if(window.BaselineCore)window.BaselineCore.configure({S:S,esc:esc,richItem:richItem,weekWindow:reportWindow,
      baselineState:function(){return dataState.milestones || {};},render:function(){renderShell(true);},flush:snapDraft});
    if(window.ManagementReader)window.ManagementReader.configure({S:S,esc:esc,richItem:richItem,request:reporterRequest,
      render:function(){renderShell(true);},toast:toast,canRead:canReadManagement,
      archiveHelpers:{esc:esc,richItem:richItem,sd:sd,dayDiff:dayDiff,lightOf:lightOf,devTxt:devTxt}});
    if(window.ProjectLibrary)window.ProjectLibrary.configure({S:S,esc:esc,request:reporterRequest,render:function(){renderShell(true);},toast:toast,
      readOnly:function(){return S.view==='managementLibrary' || S.profile && S.profile.role==='viewer';},
      projectId:function(){return S.view==='managementLibrary' && canReadManagement() && window.ManagementReader ? window.ManagementReader.projectId('managementLibrary') : S.view==='library' ? S.libraryProject : null;}});
    if(window.MonthlyPlans)window.MonthlyPlans.configure({S:S,esc:esc,request:reporterRequest,render:function(){renderShell(true);},toast:toast,
      canUseBusinessLine:canReportBizLine,
      flush:snapDraft,saveFormDraft:saveDraft,richCopy:richCopy,richItem:richItem,richCollect:richCollect,loadData:loadData,
      weekWindow:reportWindow,completionFor:function(key,owner){return window.CompletionReview?window.CompletionReview.completionFor(key,owner):null;}});
    if(window.AdminPlans)window.AdminPlans.configure({S:S,esc:esc,request:reporterRequest,render:function(){renderShell(true);},toast:toast,
      richCopy:richCopy,richItem:richItem,richCollect:richCollect,
      flush:function(){if(window.ZHRichEditor)window.ZHRichEditor.flush();},
      refresh:async function(){return loadData(['monthlyPlans','completions'],true);}});
    if(window.CoordinationWorkbench){
      window.CoordinationWorkbench.configure({S:S,esc:esc,request:reporterRequest,render:function(){renderShell(true);},toast:toast,
        richCopy:richCopy,richCollect:richCollect,richItem:richItem,flush:function(){if(window.ZHRichEditor)window.ZHRichEditor.flush();},
        refreshTasks:async function(){snapDraft();return loadData(['coordinationTasks','projectPeople','completions'],true);},
        loadPeople:async function(pid){
          if(pid===S.pmProject){var ok=await loadData(['projectPeople']);return ok?{data:S.projectPeople,error:null}:{error:{message:'本项目承办人读取失败，请刷新数据'}};}
          return reporterRequest('/api/project-people/list',{project_id:pid});
        },afterCreated:async function(){
          snapDraft();invalidateData(['coordinationTasks']);
          if(!await loadData(['coordinationTasks','completions']))throw new Error('协调事项状态读取失败');
          if(window.ReporterTasks && window.ReporterTasks.prepareCoordination)window.ReporterTasks.prepareCoordination();
          if(window.CompletionReview && window.CompletionReview.loadInitiated)await window.CompletionReview.loadInitiated(true);
        }});
      var peopleState=dataState.projectPeople,coordState=dataState.coordinationTasks;
      window.CoordinationWorkbench.seed(S.pmProject,coordState && coordState.ready?S.coordinationTasks:null,
        peopleState && peopleState.ready && peopleState.scope===S.pmProject?S.projectPeople:null);
    }
    if (window.OverviewMeetings) window.OverviewMeetings.configure({S:S,esc:esc,request:reporterRequest,disciplines:DISCIPLINES,
      loadPeople:function(pid){return reporterRequest('/api/project-people/list',{project_id:pid});},
      reloadTasks:async function(){if(!await loadData(['reporterTasks','leaderNotes'],true))throw new Error('会议事项读取失败');},
      render:function(){renderShell(true);},toast:toast,richItem:richItem,richCopy:richCopy,richCollect:richCollect,flush:snapDraft,
      presentationAction:function(task){return window.MeetingController?window.MeetingController.savedAction(task):'';},
      onSaved:function(task){if(window.MeetingController)window.MeetingController.onSaved(task);}});
    if (window.CompletionStatistics) window.CompletionStatistics.configure({S:S,esc:esc,request:reporterRequest,
      render:function(){renderShell(true);},toast:toast});
    if (window.ProjectPlanStatistics) window.ProjectPlanStatistics.configure({S:S,esc:esc,request:reporterRequest,
      render:function(){renderShell(true);},toast:toast});
    if(window.AdminPlanOverview)window.AdminPlanOverview.configure({S:S,esc:esc,disciplines:DISCIPLINES,currentPeriod:overviewPeriod,isHistorical:overviewHistorical,
      residentialGroups:overviewResidentialGroups,nodeHtml:overviewNodeHtml,planHtml:overviewPlanHtml,coordHtml:overviewCoordHtml,
      otherHtml:overviewOtherHtml,notesHtml:overviewNotesHtml,legacyHtml:overviewLegacyHtml,reportHistoryButton:reportHistoryButton,
      foldAttrs:overviewFoldAttrs,foldHint:overviewFoldHint,projectDetailButton:projectDetailButton,drawingHtml:overviewDrawingHtml,filesHtml:overviewReportFilesHtml,
      unassignedHtml:function(pid,commercial){var rows=window.PlanningWindows?window.PlanningWindows.scopedMilestones(S.milestones,{projectId:pid,commercial:commercial,
        window:reportWindow(overviewPeriod(),null,'month'),includeUnassigned:true,keyOnly:!commercial}).filter(function(m){return !window.PlanningWindows.scopeOf(m,commercial);}):[];
        return rows.length?overviewNodeHtml([],pid,null,commercial):'';}});
    if (window.CompletionReview) window.CompletionReview.configure({S:S,esc:esc,request:reporterRequest,loadData:loadData,
      richItem:richItem,richCopy:richCopy,richCollect:richCollect,
      render:function(){renderShell(true);},toast:toast,flush:snapDraft,saveDraft:saveDraft,
      queryCompletions:queryCompletions,loadMoreCompletions:loadMoreCompletions,
      afterSaved:async function(row){return loadData(row.kind==='milestone'?['milestones','completions']:['completions'],true);}});
    if (window.ReportAttachments) window.ReportAttachments.configure({S:S,esc:esc,render:function(){renderShell(true);},toast:toast,flush:snapDraft,saveDraft:saveDraft,
      canEditScope:function(){return !S.pmScopeTransition && canCapturePMDraft() && (!isCom(S.pmProject) || canReportBizLine(S.pmLine));}});
    if (window.ReporterTasks) window.ReporterTasks.configure({S:S,esc:esc,bizLines:businessLinesForProject(S.pmProject),myBizLines:myBizLines,scopeProjectIds:pmScopeProjectIds,isCommercial:function(){return isCom(S.pmProject);},richItem:richItem,richCopy:richCopy,richCollect:richCollect,weekNo:weekNo,currentPeriod:currentPeriod,
      toast:toast,render:function(){renderShell(true);},reloadTasks:async function(){if(!await loadData(['reporterTasks','completions'],true))throw new Error('会议事项列表读取失败');},request:reporterRequest,
      reloadSources:async function(){if(!await loadData(['leaderNotes','reports','reporterTasks','coordinationTasks','completions'],true))throw new Error('同步来源读取失败，请重试');},
      loadPeople:function(pid){return reporterRequest('/api/project-people/list',{project_id:pid});},
      saveDraft:saveDraft,flush:snapDraft,openFeedback:function(key){return App.openFollowup(key);}});
  }
  function attachmentBusy() {
    if (S.pmScopeTransition) { toast('正在切换填报页面，请稍候。','err'); return true; }
    if (window.ReportAttachments && window.ReportAttachments.isUploading()) { toast('附件正在处理中，请完成后再切换或提交。','err'); return true; }
    return false;
  }
  function completionQuery() {
    if (!S.completionQuery) S.completionQuery = {status:S.profile && S.profile.role==='ops'?'pending':''};
    return S.completionQuery;
  }
  function completionSourceKeys() {
    if (!S.profile) return [];
    var pm=S.profile.role==='pm';
    var reports=pm?S.reports:S.view==='detail' && (!S.detailTab || ['report','history'].indexOf(S.detailTab)>=0)
      ? (S.reports || []).filter(function(r){return (window.ReportScopes?window.ReportScopes.matchesProject(r,S.detailPid):r.project_id===S.detailPid) && reportInPeriod(r,S.detailPeriod || currentPeriod());}) : [];
    var keys = [], add=function(key){if(key && keys.indexOf(key)<0)keys.push(key);};
    if(pm){
      (S.milestones || []).forEach(function(m){add('milestone:'+m.project_id+':'+m.id);});
      (S.leaderNotes || []).forEach(function(n){add('leader:'+n.project_id+':'+n.id);});
      (S.reporterTasks || []).forEach(function(t){add('meeting:'+t.project_id+':'+t.id);});
    }
    if(pm || S.view==='coord')(S.coordinationTasks || []).forEach(function(task){add(task.source_key || 'coord:'+task.project_id+':'+task.id);});
    if(pm)(S.monthlyPlans || []).filter(function(plan){return (plan.owner_id || plan.confirmed_by)===S.uid;}).forEach(function(plan){
      (plan.items || []).forEach(function(item){if(item && item.source_id)add('monthly:'+plan.project_id+':'+plan.id+':'+item.source_id);});
    });
    completionReportKeys(reports,add,pm);
    return keys.sort();
  }
  function completionReportKeys(reports,add,ownOnly) {
    (reports || []).forEach(function(r){
      (r.biz && Array.isArray(r.biz.followups)?r.biz.followups:[]).forEach(function(item){if(item)add(item.source_key);});
      [['coord',r.coord_items],['handover',r.biz && r.biz.handover]].forEach(function(group){
        (Array.isArray(group[1])?group[1]:[]).forEach(function(item){
          if(item && (item.source_id || item.id))add('coord:'+r.project_id+':'+r.id+':'+group[0]+':'+(item.source_id || item.id));
        });
      });
      if(!ownOnly || r.author_id===S.uid) ['nodes','items'].forEach(function(group){
        (r.biz && Array.isArray(r.biz[group])?r.biz[group]:[]).forEach(function(item){if(item && item.source_id){
          var planId=group==='items' && item.monthly_plan_id && Array.isArray(r.biz.monthly_plan_ids) && r.biz.monthly_plan_ids.includes(item.monthly_plan_id)
            ? item.monthly_plan_id : group==='items' && r.biz.monthly_plan_id;
          add(planId?'monthly:'+r.project_id+':'+planId+':'+item.source_id:'plan:'+r.project_id+':'+r.id+':'+group+':'+item.source_id);
        }});
      });
    });
  }
  async function readCompletionKeys(keys) {
    var all=[];
    for(var start=0;start<keys.length;start+=250){
      var cursor=null;
      do {
        var body={source_keys:keys.slice(start,start+250),limit:500};if(cursor)body.cursor=cursor;
        var result=await reporterRequest('/api/completions/list',body);
        if(result.error)return result;
        all=all.concat(result.data || []);
        var next=result.meta && result.meta.has_more?result.meta.next_cursor:null;
        if(result.meta && result.meta.has_more && (!next || next===cursor))return {error:{message:'审核状态分页响应无效，请重试'}};
        cursor=next;
      } while(cursor);
    }
    return {data:all};
  }
  async function refreshMilestoneCompletions(rows) {
    var keys=rows.map(function(m){return 'milestone:'+m.project_id+':'+m.id;});
    (S.completions || []).forEach(function(row){if(keys.indexOf(row.source_key)>=0){row.source_changed=true;row.effective_status='source_changed';}});
    return loadData(['completions'],true);
  }
  function milestoneSaveIdentity() {
    var uid=S.uid,session=S.session,epoch=dataEpoch;
    return function(){return uid===S.uid && session===S.session && epoch===dataEpoch;};
  }
  function uniqueCompletions(rows) {
    var map=Object.create(null);
    rows.forEach(function(row){if(row && row.id && (!map[row.id] || Number(row.revision)>=Number(map[row.id].revision)))map[row.id]=row;});
    return Object.keys(map).map(function(id){return map[id];});
  }
  async function fetchCompletionData() {
    var query=Object.assign({limit:100},completionQuery());
    if(!query.status){if(S.profile.role==='ops')query.status='all';else delete query.status;}if(!query.project_id)delete query.project_id;
    var result=await reporterRequest('/api/completions/list',query);
    if(result.error)return result;
    var main=result.data || [], all=main.slice(), keys=completionSourceKeys();
    var sides=await readCompletionKeys(keys);if(sides.error)return sides;all=all.concat(sides.data);
    return {data:uniqueCompletions(all),meta:result.meta || {},queueIds:main.map(function(row){return row.id;})};
  }
  async function queryCompletions(query) {
    var uid=S.uid,session=S.session,epoch=dataEpoch,previous=S.completionQuery;
    S.completionQuery={project_id:query.project_id || '',status:query.status || ''};
    var selected=JSON.stringify(S.completionQuery), ok=await loadData(['completions'],true);
    if(uid!==S.uid || session!==S.session || epoch!==dataEpoch || selected!==JSON.stringify(S.completionQuery))return false;
    if(!ok)S.completionQuery=previous;
    return ok;
  }
  async function loadMoreCompletions() {
    var meta=S.completionMeta || {};if(!meta.has_more || !meta.next_cursor)return true;
    var uid=S.uid,session=S.session,epoch=dataEpoch,query=Object.assign({limit:100},completionQuery()),selected=JSON.stringify(query),cursor=meta.next_cursor;
    if(!query.status){if(S.profile.role==='ops')query.status='all';else delete query.status;}if(!query.project_id)delete query.project_id;
    query.cursor=cursor;var result=await reporterRequest('/api/completions/list',query);
    if(uid!==S.uid || session!==S.session || epoch!==dataEpoch || selected!==JSON.stringify(Object.assign({limit:100},completionQuery())) || (S.completionMeta || {}).next_cursor!==cursor)return false;
    if(result.error)throw new Error(result.error.message || '审核记录读取失败');
    S.completions=uniqueCompletions((S.completions || []).concat(result.data || []));
    S.completionQueueIds=Array.from(new Set((S.completionQueueIds || []).concat((result.data || []).map(function(row){return row.id;}))));
    S.completionMeta=result.meta || {};return true;
  }
  function reportAttachmentScope() {
    if(S.profile && S.profile.role==='pm' && S.view==='form'){
      var pid=S.pmProject || (myProjects()[0] || {}).id;
      var line=isCom(pid)?selectedBizLine(pid):residentialReportLine(pid,S.pmPeriod || currentPeriod());
      if(!pid || !line)return {ids:[]};
      var scope=reportScopeFor(pid,S.pmPeriod);
      var stored=scope && window.ReportScopes?window.ReportScopes.findReport(S.reports,scope,S.pmPeriod || currentPeriod(),null,line,S.uid):null;
      return Object.assign({project_id:scope?scope.anchor_project_id:pid,period:stored?stored.period:S.pmPeriod || currentPeriod(),line:line},scope?{report_scope_id:scope.id}:{});
    }
    if(isManagerOverview())return {report_ids:overviewReports(S.view!=='pres').map(function(r){return String(r.id);}).sort()};
    var reports=(S.reports || []).filter(function(r){
      return S.view==='detail'?(window.ReportScopes?window.ReportScopes.matchesProject(r,S.detailPid):r.project_id===S.detailPid) && reportInPeriod(r,S.detailPeriod || currentPeriod()):pmHistoryReports().indexOf(r)>=0;
    });
    return {report_ids:reports.map(function(r){return String(r.id);}).sort()};
  }
  async function fetchReportAttachmentData(requestedScope) {
    var scope=requestedScope || reportAttachmentScope();
    if(scope.ids && !scope.ids.length || scope.report_ids && !scope.report_ids.length)return {data:[]};
    if(!scope.report_ids)return reporterRequest('/api/report-attachments/list',scope);
    var rows=[];
    for(var start=0;start<scope.report_ids.length;start+=100){
      var result=await reporterRequest('/api/report-attachments/list',{report_ids:scope.report_ids.slice(start,start+100)});
      if(result.error)return result;rows=rows.concat(result.data || []);
    }
    return {data:rows.filter(function(row,i,all){return all.findIndex(function(item){return item.id===row.id;})===i;})};
  }

  /* Per-session table snapshots. The server still authorizes every request;
     nothing here persists private business data across page loads or accounts. */
  var dataSources = {
    projects: ['projects', '项目', 'sort_order'],
    reportScopes: ['@reportScopes', '统一填报范围'],
    milestones: ['milestones', '节点基线', 'sort_order'],
    reports: ['reports', '填报记录', 'submitted_at', false],
    members: ['profiles', '成员', 'created_at'],
    pms: ['project_members', '项目成员'],
    orgList: ['org', '组织', 'sort_order'],
    versions: ['plan_versions', '计划版本', 'created_at'],
    reviews: ['leader_reviews', '领导评价', 'updated_at', false],
    leaderNotes: ['leader_notes', '领导交代', 'created_at', false],
    master: ['project_master', '项目主数据'],
    phases: ['project_phases', '项目分期', 'sort_order'],
    drawings: ['project_drawings', '项目图纸', 'sort_order'],
    reporterTasks: ['@reporterTasks', '会议跟踪事项'],
    coordinationTasks: ['@coordinationTasks', '独立协调事项'],
    monthlyPlans: ['@monthlyPlans', '月度确认计划'],
    monthlySummaries: ['@monthlySummaries', '月度完成情况汇总'],
    projectPeople: ['@projectPeople', '项目协调人员'],
    businessModuleGrants: ['@businessModuleGrants', '附加商业专业授权'],
    completions: ['@completions', '完成审核'],
    nodeStatistics: ['@nodeStatistics', '节点有效审核状态'],
    reportAttachments: ['@reportAttachments', '填报附件']
  };
  var dataState = {}, dataEpoch = 0, pageNavigation = 0;

  function resetPageData() {
    if(window.MeetingController)window.MeetingController.stop();
    if(window.ReportReference)window.ReportReference.close();
    if(window.PlanningAI)window.PlanningAI.reset();
    planningAITransactions.clear();S.planningAIEntries=[];
    if(window.ManagementReader)window.ManagementReader.reset();
    if(window.CoordinationWorkbench)window.CoordinationWorkbench.reset();
    if(window.ZHAdminArchive && window.ZHAdminArchive.reset)window.ZHAdminArchive.reset();
    dataEpoch++; pageNavigation++; dataState = {};
    Object.keys(dataSources).forEach(function (key) { S[key] = []; });
    S.loadErrors = []; S.pmReport = null; S.pmProject = null; S.pmLine = null; S.pmReportScope=null; S.pmScopeId=null; S.pmLegacyReportConflict=null; S.pmScopeTransition = null; delete S.pmRenderedScope;
    clearTimeout(draftAutosaveTimer);
    S.briefDrafts = {}; S.reviewRichDrafts = {}; S.formRich = {}; S.lineEdits = {};
    S.overviewUI = { project: '', line: '', discipline: '', open: {} };
    S.followupRows = []; S.monthlyUnmatchedItems=[];S.meetingDraft = null; S.mlineDraft = {}; S.reporterArchiveTab = 'knowledge'; S.submittingReport = null;
    S.attachmentIds = []; S.completionQuery = null; S.completionMeta = {}; S.completionQueueIds = [];
  }
  function pageDataKeys() {
    var navs = planningNavItems(), current = navs.filter(function (item) { return item.k === S.view; })[0];
    if (!current && S.view !== 'detail') {
      current = navs.filter(function (item) { return item.k === 'board'; })[0] || navs[0];
      S.view = current.k;
    }
    if(S.profile.role==='viewer' || isManagementReadView(S.view))return [];
    var common = ['projects','reportScopes'];
    if (!isPlanningManager()) common = common.concat(['pms', 'reports']);
    if(S.profile.role==='pm')common.push('businessModuleGrants');
    else if(isPzo())common.push('pms');
    var pages = {
      form: ['pms', 'reports', 'milestones', 'orgList', 'projectPeople', 'leaderNotes', 'reporterTasks', 'coordinationTasks', 'monthlyPlans', 'completions', 'reportAttachments'],
      mine: ['pms', 'reports', 'milestones', 'reviews'],
      center: ['pms', 'reports', 'reviews', 'leaderNotes', 'orgList', 'projectPeople', 'milestones', 'reporterTasks', 'coordinationTasks', 'monthlyPlans', 'completions'],
      coordination: ['pms','reports','projectPeople','coordinationTasks','completions'],
      library: ['pms'],
      mline: ['pms', 'milestones', 'completions'], history: ['reports', 'coordinationTasks', 'monthlyPlans', 'completions', 'reportAttachments'],
      completion: ['completions'],
      meetings: ['reporterTasks'],
      board: ['members', 'pms', 'milestones', 'reports', 'reviews'],
      dual: ['members', 'pms', 'milestones', 'reports', 'reviews'],
      nodes: ['milestones', 'versions', 'nodeStatistics'], coord: ['reports','coordinationTasks','completions'],
      pres: ['members', 'pms', 'milestones', 'reports', 'monthlyPlans', 'monthlySummaries', 'leaderNotes', 'reporterTasks', 'drawings', 'reportAttachments'],
      presCom: ['members', 'pms', 'milestones', 'reports', 'monthlyPlans', 'monthlySummaries', 'leaderNotes', 'reporterTasks', 'drawings', 'reportAttachments'],
      presPzo: ['members', 'pms', 'milestones', 'reports', 'monthlyPlans', 'monthlySummaries', 'leaderNotes', 'reporterTasks', 'drawings', 'reportAttachments'],
      adminPlans: ['monthlyPlans'],
      master: ['milestones', 'master', 'phases', 'drawings'],
      lineAdm: ['milestones'], members: ['members', 'pms', 'businessModuleGrants']
    };
    var needed = current ? pages[current.v] || [] : ['reports'];
    if (S.profile.role==='ops' && ['pres','presCom','presPzo'].indexOf(current && current.v)>=0) needed=needed.concat(['reporterTasks']);
    if (S.view === 'detail') {
      if (S.detailTab === 'review') needed = needed.concat(['reviews', 'leaderNotes']);
      if (S.detailTab === 'data' && !isPzo()) needed = needed.concat(pages.master);
      if (!S.detailTab || ['report','history'].indexOf(S.detailTab)>=0) needed = needed.concat(['completions','reportAttachments']);
    }
    return common.concat(needed).filter(function (key, i, all) { return all.indexOf(key) === i; });
  }
  function invalidateData(keys) {
    if(window.ProjectPlanStatistics && keys.some(function(key){return ['reports','milestones','monthlyPlans','completions','members','pms','projects'].indexOf(key)>=0;}))window.ProjectPlanStatistics.invalidate();
    if(window.CoordinationWorkbench && keys.some(function(key){return ['coordinationTasks','members','pms','projects'].indexOf(key)>=0;}))window.CoordinationWorkbench.invalidate();
    if(window.CompletionStatistics && keys.some(function(key){return ['reports','milestones','leaderNotes','reporterTasks','completions','members','pms','projects'].indexOf(key)>=0;}))window.CompletionStatistics.invalidate();
    if(window.CompletionReview && window.CompletionReview.invalidateInitiated && keys.some(function(key){return ['reports','coordinationTasks','completions','members','pms','projects'].indexOf(key)>=0;}))window.CompletionReview.invalidateInitiated();
    var affected=keys.slice();
    if(keys.some(function(key){return ['reports','milestones','leaderNotes','reporterTasks','coordinationTasks','monthlyPlans'].indexOf(key)>=0;}))affected.push('completions');
    if(keys.indexOf('reports')>=0)affected.push('reportAttachments');
    if(keys.some(function(key){return ['milestones','completions','members','pms','projects'].indexOf(key)>=0;}))affected.push('nodeStatistics');
    if(keys.some(function(key){return ['reports','pms','projects'].indexOf(key)>=0;}))affected.push('reportScopes');
    if(keys.some(function(key){return ['members','pms','projects'].indexOf(key)>=0;}))affected.push('projectPeople');
    if(keys.some(function(key){return ['members','pms','projects','monthlyPlans'].indexOf(key)>=0;}))affected.push('monthlySummaries');
    if(keys.some(function(key){return ['members','pms','projects'].indexOf(key)>=0;}))affected.push('businessModuleGrants');
    affected.filter(function(key,i,all){return all.indexOf(key)===i;}).forEach(function (key) {
      var state = dataState[key] || (dataState[key] = { revision: 0 });
      state.revision++; state.ready = false; state.error = null;
    });
  }
  async function loadDataKey(key) {
    var state = dataState[key] || (dataState[key] = { revision: 0 });
    var scope = key === 'reportAttachments' ? JSON.stringify(reportAttachmentScope())
      : key === 'completions' ? JSON.stringify([completionQuery(),completionSourceKeys()])
      : key === 'nodeStatistics' ? (S.view==='nodesCom'?'com':'res')
      : key === 'monthlySummaries' ? overviewSummaryMonth()
      : key === 'projectPeople' ? S.pmProject || (myProjects()[0] || {}).id || '' : '';
    if (state.scope !== scope) { state.scope = scope; state.ready = false; state.revision++; }
    if (state.ready) return;
    var revision = state.revision, epoch = dataEpoch;
    if (!state.pending) {
      state.pendingRevision = revision;
      state.pending = (async function () {
        var spec = dataSources[key], result;
        try {
          if (key === 'reportScopes') result=await reporterRequest('/api/report-scopes/list',{});
          else if (key === 'reporterTasks') result = S.profile && ['pm','ops','president','pzo'].indexOf(S.profile.role)>=0 ? await reporterRequest('/api/reporter-tasks/list', {}) : {data: []};
          else if(key==='coordinationTasks')result=await reporterRequest('/api/coordination-tasks/list',{});
          else if(key==='monthlyPlans')result=await reporterRequest('/api/monthly-plans/list',{});
          else if(key==='businessModuleGrants'){
            result=S.profile && ['pm','ops'].includes(S.profile.role)?await reporterRequest('/api/commercial-module-grants'):{data:[]};
            if(result && !result.error && (!Array.isArray(result.data) || result.data.some(function(row){return !row || typeof row.user_id!=='string' || row.project_id!=='hf' || row.line!=='设计部';})))throw new Error('附加商业专业授权返回不完整，请刷新重试');
          }
          else if(key==='monthlySummaries'){
            if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(scope))throw new Error('查看月份无法确定，请重新选择周期');
            result=await reporterRequest('/api/monthly-summaries?month='+encodeURIComponent(scope));
            if(result && !result.error && (!Array.isArray(result.data) || result.data.some(function(row){return !row || row.month!==scope || !Array.isArray(row.items);})))throw new Error('月度汇总返回范围不完整，请刷新重试');
          }
          else if(key==='nodeStatistics'){
            result=await reporterRequest('/api/project-plan-statistics',{kind:scope,date_mode:'all',key_only:false});
            if(!result)throw new Error('节点有效审核状态读取失败，请刷新重试');
            if(!result.error){
              if(!result.data || result.data.source!==scope+'_baseline' || !result.data.filters || result.data.filters.kind!==scope || !Array.isArray(result.data.rows) || result.data.rows.some(function(row){return !row || typeof row.source_key!=='string' || typeof row.completed!=='boolean';}))throw new Error('节点有效审核状态读取不完整，请刷新重试');
              result={data:result.data.rows};
            }
          }
          else if (key === 'projectPeople') result = scope ? await reporterRequest('/api/project-people/list', {project_id:scope}) : {data:[]};
          else if (key === 'completions') result = await fetchCompletionData();
          else if (key === 'reportAttachments') result = await fetchReportAttachmentData();
          else {
            var query = db.from(spec[0]).select('*');
            if (spec[2]) query = query.order(spec[2], { ascending: spec[3] !== false });
            result = await query;
          }
        } catch (error) { result = { error: { message: error && error.message || '读取异常' } }; }
        if (epoch !== dataEpoch || revision !== state.revision) return;
        state.error = result && result.error ? result.error.message || '读取失败' : null;
        if (state.error) return;
        S[key] = result.data || [];
        if(key==='completions'){S.completionMeta=result.meta || {};S.completionQueueIds=result.queueIds || [];}
        if (key === 'orgList') S[key] = S[key].map(function (item) {
          item.level = item.level != null ? item.level : item.org_level; return item;
        }).sort(function (a, b) { return (Number(a.level) || 9) - (Number(b.level) || 9) || (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0); });
        if (['reports', 'milestones', 'reviews', 'leaderNotes', 'reporterTasks'].indexOf(key) >= 0) attachRich(S[key]);
        state.ready = true;
      })();
    }
    var pending = state.pending;
    var pendingRevision = state.pendingRevision;
    await pending;
    if (state.pending === pending) state.pending = null;
    // A save invalidated a read already in flight. Its stale result was ignored;
    // all waiters share the new read instead of restoring the old snapshot.
    if (epoch === dataEpoch && pendingRevision !== state.revision) return loadDataKey(key);
  }
  async function loadData(keys, force) {
    if (force) invalidateData(keys);
    var epoch = dataEpoch;
    await Promise.all(keys.filter(function(key){return ['completions','reportAttachments','projectPeople'].indexOf(key)<0;}).map(loadDataKey));
    await Promise.all(keys.filter(function(key){return ['completions','reportAttachments','projectPeople'].indexOf(key)>=0;}).map(loadDataKey));
    if (epoch !== dataEpoch) return false;
    var visible = S.profile ? pageDataKeys() : keys;
    S.loadErrors = visible.filter(function (key) { return dataState[key] && dataState[key].error; })
      .map(function (key) { return dataSources[key][1] + '：' + dataState[key].error; });
    return !keys.some(function (key) { return dataState[key] && dataState[key].error; });
  }
  function loadPageData(force) {
    if (force && !isManagementReadView(S.view) && !(S.profile && S.profile.role==='viewer')) invalidateData(Object.keys(dataState));
    return loadData(pageDataKeys());
  }
  async function showPage(prepare, force, transition) {
    var navigation = ++pageNavigation, epoch = dataEpoch;
    try {
      await Promise.all([loadPageData(force),S.profile && (S.profile.role === 'pm' || S.view === 'meetings' || S.view === 'master' || S.view === 'detail' && S.detailTab === 'data') && window.PlanningBoot && window.PlanningBoot.ensureReporter
        ? window.PlanningBoot.ensureReporter(S.view === 'master' || S.view === 'detail' && S.detailTab === 'data' ? 'master' : S.view)
        : window.PlanningBoot && window.PlanningBoot.ensureReporter && S.view==='detail' && (!S.detailTab || ['report','history'].indexOf(S.detailTab)>=0)
          ? window.PlanningBoot.ensureReporter('history') : Promise.resolve(),
        window.PlanningBoot && window.PlanningBoot.ensureWorkflow && (S.profile && S.profile.role === 'pm' || isManagerOverview() || S.view === 'completion' || S.view === 'coord' || S.view === 'detail' && (!S.detailTab || ['report','history'].indexOf(S.detailTab)>=0))
          ? window.PlanningBoot.ensureWorkflow(S.profile && S.profile.role==='pm' || isManagerOverview() || S.view==='detail') : Promise.resolve(),
        window.PlanningBoot && window.PlanningBoot.ensureAdmin && isPlanningManager() && !isPzo() && (S.view==='master' || S.view==='detail' && S.detailTab==='data')
          ? window.PlanningBoot.ensureAdmin() : Promise.resolve(),
        window.PlanningBoot && window.PlanningBoot.ensureOverview && isManagerOverview()
          ? window.PlanningBoot.ensureOverview() : Promise.resolve(),
        window.PlanningBoot && window.PlanningBoot.ensureStatistics && S.view==='completionStats'
          ? window.PlanningBoot.ensureStatistics() : Promise.resolve(),
        window.PlanningBoot && window.PlanningBoot.ensureProjectPlanStatistics && S.view==='projectPlanStats'
          ? window.PlanningBoot.ensureProjectPlanStatistics() : Promise.resolve(),
        window.PlanningBoot && window.PlanningBoot.ensureCoordination && S.profile && S.profile.role==='pm' && S.view==='coordination'
          ? window.PlanningBoot.ensureCoordination() : Promise.resolve(),
        window.PlanningBoot && window.PlanningBoot.ensureMonthlyPlans && (S.profile && S.profile.role==='pm' && S.view==='form' || isManagerOverview())
          ? window.PlanningBoot.ensureMonthlyPlans() : Promise.resolve(),
        window.PlanningBoot && window.PlanningBoot.ensureAdminPlans && S.profile && S.profile.role==='ops' && S.view==='adminPlans'
          ? window.PlanningBoot.ensureAdminPlans() : Promise.resolve(),
        window.PlanningBoot && window.PlanningBoot.ensureProjectLibrary && (S.view==='library' || S.view==='managementLibrary') ? window.PlanningBoot.ensureProjectLibrary() : Promise.resolve(),
        window.PlanningBoot && window.PlanningBoot.ensureManagementReader && isManagementReadView(S.view) ? window.PlanningBoot.ensureManagementReader() : Promise.resolve(),
        window.PlanningBoot && window.PlanningBoot.ensureReporter && S.view==='managementArchive' ? window.PlanningBoot.ensureReporter('master') : Promise.resolve()]);
    } catch(error) { toast('页面组件加载失败，请刷新重试。','err'); return; }
    if (navigation !== pageNavigation || epoch !== dataEpoch || !S.profile) return;
    configureReporter();
    if(isManagementReadView(S.view) && window.ManagementReader)await window.ManagementReader.load(S.view,{force:!!force});
    if(S.view==='completionStats' && window.CompletionStatistics)await window.CompletionStatistics.load();
    if(S.view==='projectPlanStats' && window.ProjectPlanStatistics)await window.ProjectPlanStatistics.load();
    if(S.view==='adminPlans' && window.AdminPlans){var adminSeed=S.adminPlanSeed;S.adminPlanSeed=null;await window.AdminPlans.load(adminSeed,!!force);}
    if (navigation !== pageNavigation || epoch !== dataEpoch || !S.profile) return;
    if (prepare) await preparePM();
    if(S.profile.role==='pm' && ['form','center','coordination'].indexOf(S.view)>=0)await loadData(['projectPeople']);
    if(S.profile.role==='pm' && S.view==='coordination' && window.CompletionReview && window.CompletionReview.loadInitiated)await window.CompletionReview.loadInitiated();
    if (navigation !== pageNavigation || epoch !== dataEpoch || !S.profile) return;
    if (transition && S.pmScopeTransition === transition) S.pmScopeTransition = null;
    markPMRenderedScope();
    renderShell();
    return true;
  }

  /* ================= 建档 ================= */

  /* 四类账号沿用 pm/ops/president/pzo；在线注册仅创建待审核的普通提报人。 */
  async function renderOnboarding(msg, cls) {
    S.roleChoice = 'pm';
    render('<div class="authpage planning-auth">' + authBackground() + '<div class="authcard wide">' + authBrand()
      + '<h1>完善账号信息</h1>'
      + '<div class="sub">' + esc(S.session && S.session.user && S.session.user.email ? '当前账号：' + S.session.user.email : '这是你第一次登录，请先完成账号信息。') + '</div>'
      + '<div class="f2"><div><label for="obName">姓名</label><input id="obName" placeholder="请填写真实姓名，将显示在填报记录中"></div>'
      + '<div><label>账号角色</label><input value="提报人（普通账号）" readonly></div></div>'
      + '<div class="notice" style="margin-top:18px">提交姓名后，账号进入待审核状态。请联系管理员审核并分配负责项目；住宅与商业是项目类型，按获授权项目显示相应填报表单。专业条线和商业模块沿用管理员分配，不可自行授权。</div>'
      + '<button class="btn primary" style="width:100%;margin-top:20px" onclick="App.onboardSubmit()">提交</button>'
      + '<div id="msg" class="authmsg ' + (cls || '') + '">' + esc(msg || '') + '</div>'
      + '<div class="authfoot"><button type="button" class="btn link" onclick="App.logout()">使用其他账号登录</button></div>'
      + '</div></div>');
  }

  function renderWaiting() {
    render('<div class="authpage">' + authBackground() + '<div class="authcard">' + authBrand() + '<h1>等待审核</h1>'
      + '<div class="notice warn">你的提报人账号已登记，正在等待管理员审核并分配项目、专业条线和商业模块。<br>审核通过后，按获授权的住宅或商业项目进入相应表单。如需调整负责项目，请联系管理员。</div>'
      + '<button class="btn ghost" onclick="App.logout()">退出登录</button></div></div>');
  }

  /* ================= 项目经理端 ================= */

  async function preparePM(forcePeriod) {
    S.planningAIEntries=[];
    S.monthlyUnmatchedItems=[];
    var pid = S.pmProject || (myProjects()[0] && myProjects()[0].id);
    var period = forcePeriod || S.pmPeriod || currentPeriod();
    S.pmPeriod = period;
    S.pmReportScope=reportScopeFor(pid,period);
    S.pmScopeId=S.pmReportScope?S.pmReportScope.id:null;
    S.pmLegacyReportConflict=null;
    if(S.pmReportScope)pid=S.pmReportScope.anchor_project_id;
    S.pmProject = pid;
    var wn = weekNo(period);
    var mine = S.reports.filter(function (r) { return r.project_id === pid && r.author_id === S.uid; });
    if (isCom(pid)) {
      /* 原主专业与显式附加授权分别保留；空值不授予填报权限。 */
      S.pmLine = selectedBizLine();
      S.pmReport = lineReport(pid, period, S.pmLine);
    } else {
      S.pmLine = residentialReportLine(pid,period);
      S.pmReport = S.pmReportScope && window.ReportScopes?window.ReportScopes.findReport(S.reports,S.pmReportScope,period,null,S.pmLine,S.uid):mine.filter(function (r) {
        return (window.PlanningWindows?window.PlanningWindows.samePeriod(r.period,period,r.submitted_at || r.created_at):r.period===period) && (r.line || LINE_ALL) === S.pmLine;
      })[0] || null;
      if(professionalPMScope())S.pmLegacyReportConflict=mine.find(function(report){return !report.report_scope_id && (report.line || LINE_ALL)===S.pmLine && reportInPeriod(report,period);}) || null;
    }
    if(S.pmReportScope && S.pmReport)S.pmPeriod=S.pmReport.period;
    configureReporter();
    S.formRich=richCopy(S.pmReport || {},{});
    if(window.ZHRichText && S.pmReport) (S.pmReport.next_items || []).forEach(function(_,i){var d=window.ZHRichText.doc(S.pmReport,'next_items.'+i);if(d){S.formRich._rich=S.formRich._rich || {};S.formRich._rich['next_'+i]=d;}});
    buildNodeRows();
    buildEditRows();
    buildBizRows();
    if (window.ReporterTasks) window.ReporterTasks.prepare();
    if (window.ReportAttachments) window.ReportAttachments.prepare();
    restoreDraft();
    if(window.ReporterTasks && window.ReporterTasks.syncMeetingRows)window.ReporterTasks.syncMeetingRows(true);
    prepareWindowNodes();
    if(window.MonthlyPlans)window.MonthlyPlans.prepare();
  }

  function reportWindow(period,reference,mode) {
    var windows=window.PlanningWindows;
    return windows && windows.windowFor(windows.periodStart(period,reference),mode || 'week');
  }
  function personalWindowNodes() {
    return window.PlanningWindows?(professionalPMScope()?pmScopeProjectIds():[S.pmProject]).flatMap(function(pid){return window.PlanningWindows.scopedMilestones(S.milestones,{projectId:pid,
      commercial:isCom(pid),discipline:S.profile && S.profile.discipline,bizLine:S.pmLine,
      window:reportWindow(S.pmPeriod,S.pmReport && (S.pmReport.submitted_at || S.pmReport.created_at),'week')});}):[];
  }
  function prepareWindowNodes() {
    S.pendingBaselineNodes=[];
    // Baseline core is a read-only projection. Saved nodes remain historic data.
  }

  /* 商业项目：本期计划事项表（与月度计划会同口径） */
  /* 商业项目：本月核心节点计划 / 当月计划填报 / 工作面移交 */
  function buildBizRows() {
    var b = bizOf(S.pmReport);
    function clean(v, k) {
      return Array.isArray(v) ? v.filter(function (x) { return x && String(x[k] || '').trim(); })
        .map(function (x) { return richCopy(x,Object.assign({}, x)); }) : [];
    }
    var nodes = clean(b.nodes, 'name'), items = clean(b.items, 'name'), hand = clean(b.handover, 'what');
    if (!isCom(S.pmProject) && !Array.isArray(b.nodes)) {
      nodes = (S.pmReport && S.pmReport.node_items || []).map(function (n) {
        return richCopy(n, {name:n.name, plan:n.plan || '', forecast:n.forecast || '', prog:n.reason || '', is_key:!!n.key, custom:!!n.custom}, {name:'name',prog:'reason'});
      });
      if (S.pmReport && S.pmReport.change_text) items = [richCopy(S.pmReport, {mod:LINE_ALL,name:'本期工作进展',prog:S.pmReport.change_text}, {prog:'change_text'})];
    }
    S.bizNodes = nodes;
    S.bizItems = items.length ? items : [{}, {}];
    S.bizHand = hand;
  }

  /* 本期未提交、或本地草稿比已提交版本更新时，恢复暂存内容 */
  function restoreDraft() {
    S.draft = null; S.draftRestored = false;
    var d = loadDraft();
    if (!d) return;
    var rt = S.pmReport ? new Date(S.pmReport.updated_at || S.pmReport.submitted_at || 0).getTime() : 0;
    if (S.pmReport && !(d.ts > rt)) return;   /* 已提交且草稿更旧，不覆盖服务器版本 */
    if (Array.isArray(d.nodeRows) && d.nodeRows.length) S.nodeRows = d.nodeRows;
    if (Array.isArray(d.myRows)) S.myRows = d.myRows;
    if (Array.isArray(d.coordRows) && d.coordRows.length) S.coordRows = d.coordRows;
    if (Array.isArray(d.speedRows) && d.speedRows.length) S.speedRows = d.speedRows;
    if (Array.isArray(d.effectRows) && d.effectRows.length) S.effectRows = d.effectRows;
    if (Array.isArray(d.bizNodes)) S.bizNodes = d.bizNodes;
    if (Array.isArray(d.bizItems) && d.bizItems.length) S.bizItems = d.bizItems;
    if (Array.isArray(d.planningAIEntries)) S.planningAIEntries = d.planningAIEntries;
    if (Array.isArray(d.bizHand)) S.bizHand = d.bizHand;
    if(Array.isArray(d.monthlyUnmatchedItems))S.monthlyUnmatchedItems=d.monthlyUnmatchedItems;
    if (Array.isArray(d.followupRows)) S.followupRows = d.followupRows;
    if (Array.isArray(d.attachmentIds)) S.attachmentIds = d.attachmentIds;
    if (!isCom(S.pmProject) && !Array.isArray(d.bizNodes) && Array.isArray(d.nodeRows)) S.bizNodes = d.nodeRows.concat(d.myRows || []).map(function (n) {return richCopy(n,{name:n.name || '',plan:n.plan || '',forecast:n.forecast || '',prog:n.reason || '',custom:!!n.custom},{prog:'reason',name:'name'});});
    if(d.richFields) S.formRich={_rich:d.richFields};
    S.draft = d;
    S.draftRestored = true;
  }

  /* 本期需研判节点由项目经理自己选：只恢复他上期选过的行，不再由系统罗列 */
  function buildNodeRows() {
    var cur = S.pmReport, rows = [], mine = [];
    if (cur && Array.isArray(cur.node_items)) {
      cur.node_items.forEach(function (n) {
        if (!n || !n.name) return;
        if (n.custom) { mine.push(richCopy(n,{ name: n.name, plan: n.plan || '', forecast: n.forecast || '', reason: n.reason || '' })); return; }
        rows.push(richCopy(n,{ name: n.name, key_name: n.key || '', level: '', is_key: false, plan: n.plan || '',
          forecast: n.forecast || '', reason: n.reason || '', standard: '', mid: null }));
      });
    }
    /* 用节点基线补齐展示属性（关键标记、完成标准、计划引导值） */
    rows.forEach(function (r) {
      var m = msOf(S.pmProject).filter(function (x) { return x.name === r.name; })[0];
      if (!m) return;
      r.key_name = r.key_name || m.key_name || '';
      r.level = m.level || ''; r.is_key = !!m.is_key;
      r.standard = m.standard || ''; r.mid = m.id;
      if (!r.plan) r.plan = sd(m.plan_date);
    });
    /* 新一期：给两行空白选择行，引导他自己挑；已有填报则原样恢复 */
    if (!rows.length && !mine.length) rows = [{}, {}];
    S.nodeRows = rows;
    S.myRows = mine;
  }
  function pickedNames(exceptIdx) {
    var used = {};
    S.nodeRows.forEach(function (r, i) { if (i !== exceptIdx && r.name) used[r.name] = true; });
    return used;
  }
  function buildEditRows() {
    var cur = S.pmReport;
    function arr(v) { return Array.isArray(v) ? v : []; }
    var sp = arr(cur && cur.speed_items), ef = arr(cur && cur.effect_items), co = arr(cur && cur.coord_items);
    /* 提速对策 / 效果保障 已并入「三、风险、影响与对策」，每期各一条；老数据多条自动合并 */
    function fold(items, key) {
      var out = { act: '' }; out[key] = '';
      items.forEach(function (x) {
        if (!x) return;
        var a = String(x.act || '').trim(), b = String(x[key] || '').trim();
        if (a) out.act = out.act ? out.act + '；' + a : a;
        if (b) out[key] = out[key] ? out[key] + '；' + b : b;
      });
      if(window.ZHRichText) ['act',key].forEach(function(field){
        var ops=[];
        items.forEach(function(x){var v=String(x && x[field] || '').trim();if(!v)return;var d=window.ZHRichText.fit(window.ZHRichText.doc(x,field),v) || window.ZHRichText.legacy(v);if(ops.length)ops.push({insert:'；'});ops=ops.concat(d.ops);});
        if(ops.length){out[field]=window.ZHRichText.text({ops:ops});out._rich=out._rich || {};out._rich[field]={ops:ops};}
      });
      return out;
    }
    S.speedRows = [fold(sp, 'gain')];
    S.effectRows = [fold(ef, 'target')];
    S.coordRows = co.length ? co.map(function (row) { return richCopy(row,Object.assign({}, row)); }) : [{}, {}];
    while (S.coordRows.length < 2) S.coordRows.push({});
  }

  function snapDraft(captureOnly) {
    if(window.CoordinationWorkbench)window.CoordinationWorkbench.capture();
    if (!canCapturePMDraft()) return;
    if(window.ZHRichEditor) window.ZHRichEditor.flush();
    if (window.ReporterTasks) window.ReporterTasks.capture();
    if (window.ReportAttachments) window.ReportAttachments.capture();
    S.nodeRows.forEach(function (r, i) {
      var sel = document.getElementById('nd_pk_' + i);
      var fc = document.getElementById('nd_fc_' + i), rs = document.getElementById('nd_rs_' + i);
      if (sel) r.name = sel.value;
      if (fc) r.forecast = fc.value;
      if (rs) r.reason = rs.value;
    });
    S.myRows.forEach(function (r, i) {
      var nm = document.getElementById('my_nm_' + i), pl = document.getElementById('my_pl_' + i);
      var fc = document.getElementById('my_fc_' + i), rs = document.getElementById('my_rs_' + i);
      if (nm) r.name = nm.value; if (pl) r.plan = pl.value;
      if (fc) r.forecast = fc.value; if (rs) r.reason = rs.value;
    });
    S.coordRows.forEach(function (r, i) {
      var w = document.getElementById('co_who_' + i), t = document.getElementById('co_what_' + i), b = document.getElementById('co_by_' + i);
      if (w) {var changed=r.who!==w.value;r.who=w.value;var person=(S.projectPeople || []).filter(function(p){return p.name===r.who;})[0];if(person)r.who_id=person.user_id;else if(changed)delete r.who_id;} if (t) r.what = t.value; if (b) r.by = b.value;
    });
    S.speedRows.forEach(function (r, i) {
      var a = document.getElementById('sp_act_' + i), g = document.getElementById('sp_gain_' + i);
      if (a) r.act = a.value; if (g) r.gain = g.value;
    });
    S.effectRows.forEach(function (r, i) {
      var a = document.getElementById('ef_act_' + i), g = document.getElementById('ef_target_' + i);
      if (a) r.act = a.value; if (g) r.target = g.value;
    });
    /* 商业：本月核心节点计划 + 当月计划填报 + 工作面移交 */
    (S.bizNodes || []).forEach(function (r, i) {
      var nm = document.getElementById('bn_nm_' + i), pl = document.getElementById('bn_pl_' + i), pg = document.getElementById('bn_pg_' + i);
      if (nm && r.name!==nm.value) {r.name = nm.value;delete r.milestone_id;} if (pl) r.plan = pl.value; if (pg) r.prog = pg.value;
    });
    (S.bizItems || []).forEach(function (r, i) {
      var m = document.getElementById('bi_mod_' + i), nm = document.getElementById('bi_nm_' + i);
      var du = document.getElementById('bi_due_' + i), pg = document.getElementById('bi_pg_' + i);
      if (m) r.mod = m.value; if (nm) r.name = nm.value; if (du) r.due = du.value; if (pg) r.prog = pg.value;
      var blocker=document.getElementById('bi_blocker_'+i);if(blocker)r.blocker=blocker.value;
    });
    (S.bizHand || []).forEach(function (r, i) {
      var w = document.getElementById('bh_what_' + i), t = document.getElementById('bh_to_' + i), du = document.getElementById('bh_due_' + i);
      if (w) r.what = w.value; if (t) r.to = t.value; if (du) r.due = du.value;
    });
    /* 增删行会重绘整页，先把正文一起暂存，防止新输入被已提交内容覆盖。 */
    if(captureOnly!==true)saveDraft();
  }

  /* 下拉里给出本项目节点基线（带计划引导值）；used 里的节点不再重复出现 */
  function nodeListOptions(selected, used, emptyLabel) {
    var opts = ['<option value="">' + esc(emptyLabel) + '</option>'];
    msOf(S.pmProject).slice().sort(function (a, b) {
      return String(a.plan_date || '').localeCompare(String(b.plan_date || ''));
    }).forEach(function (m) {
      if (used && used[m.name]) return;
      var label = (m.is_key ? '★ ' : '') + m.name + '（计划 ' + sd(m.plan_date) + '）' + (m.done ? ' · 已完成' : '');
      opts.push('<option value="' + esc(m.name) + '"' + (selected === m.name ? ' selected' : '') + '>' + esc(label) + '</option>');
    });
    return opts.join('');
  }
  /* 研判行：排除其他行已选（同一行自己可回显） */
  function nodeOptions(selected, selfIdx) { return nodeListOptions(selected, pickedNames(selfIdx), '请选择关键节点…'); }
  function orgOptions(selected) {
    var opts = ['<option value="">选择协调对象</option>'];
    var people=S.projectPeople || [];
    if(selected && !people.some(function(person){return person.name===selected;}))opts.push('<option value="'+esc(selected)+'" selected>'+esc(selected)+'（原记录）</option>');
    people.forEach(function (o) {
      var detail=o.discipline || o.biz_line || ROLE_LABEL[o.role] || '';
      opts.push('<option value="' + esc(o.name) + '"' + (selected === o.name ? ' selected' : '') + '>' + esc(o.name) + (detail ? '（' + esc(detail) + '）' : '') + '</option>');
    });
    return opts.join('');
  }

  /* 填报页只调整布局；字段、提交动作和项目/模块授权沿用原逻辑。 */
  function planFormContext(pid, cur, moduleHtml, commercial) {
    var projects = reportingProjects();
    var project = !commercial && projects.length > 1
      ? '<select id="planProject" aria-label="当前填报项目" onchange="App.switchProject(this.value)">'
        + projects.map(function (p) { return '<option value="' + esc(p.id) + '"' + (pid === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select>'
      : '<b>' + esc(reportScopeName(pid)) + '</b>';
    return '<section class="plan-context" aria-label="本期填报信息">'
      + '<div class="plan-context-project"><span class="plan-context-label">填报项目</span>' + project
      + '<span class="chip ' + (commercial ? 'biz' : '') + '">' + (commercial ? '商业项目' : '住宅项目') + '</span></div>'
      + '<div class="plan-context-item"><span class="plan-context-label">' + (commercial ? '填报人（固定）' : '填报人') + '</span><b>' + esc((S.profile && S.profile.name) || '本人') + '</b></div>'
      + '<div class="plan-context-item plan-context-module">' + moduleHtml + '</div>'
      + '<div class="plan-form-status"><span class="badge ' + (cur ? 'green' : 'yellow') + '">' + (cur ? '本期已提交' : '本期未提交') + '</span>'
      + (cur ? '<span class="plan-context-updated">最近提交 ' + esc(fmtTime(cur.updated_at || cur.submitted_at)) + '</span>' : '') + '</div>'
      + '</section>';
  }

  function planFormActions(cur, commercial) {
    var allowed = (!commercial || canReportBizLine(S.pmLine)) && !(dataState.reportScopes && dataState.reportScopes.error)
      && !S.pmLegacyReportConflict && (!professionalPMScope() || DISCIPLINES.indexOf(S.pmLine)>=0)
      && (!cur || !cur.author_id || cur.author_id===S.uid);
    return '<footer class="plan-form-actions" aria-label="填报保存与提交">'
      + '<div class="plan-draft-note" id="planDraftStatus" role="status">本机草稿仅保存在当前浏览器；提交后才保存到服务器。</div>'
      + '<div class="plan-action-buttons"><button type="button" class="btn ghost" onclick="App.saveDraftNow()">保存本机草稿</button>'
      + '<button type="button" class="btn primary" onclick="App.submitReport()"' + (allowed ? '' : ' disabled') + '>'
      + (!allowed ? (S.pmLegacyReportConflict?'请先核对原专业记录':cur && cur.author_id!==S.uid?'由原填报人更新':'填报范围尚未就绪') : commercial ? (cur ? '重新提交（' + esc(S.pmLine) + '）' : '提交本模块直报') : (cur ? '重新提交本期直报' : '提交本期直报'))
      + '</button></div></footer>';
  }

  function viewPMForm() {
    return viewPMFormBiz();
  }

  /* 商业项目保留本月节点、当月计划与协调事项三块原有口径。 */
  function viewPMFormBiz() {
    var pid = S.pmProject, cur = S.pmReport, commercial = isCom(pid);
    if (commercial) S.pmLine = selectedBizLine();
    var dOpen = daysToOpen(pid);
    function dstr(v) { return v ? String(v).slice(0, 10) : ''; }
    var baseNodes = commercial ? [] : bizNodeOptions(pid);
    var dlNodes = '<datalist id="bn_list">' + baseNodes.map(function (m) {
      return '<option value="' + esc(m.name) + '">' + (m.is_key ? '★ ' : '') + esc(m.level || '')
        + (m.plan_date ? ' · 计划 ' + esc(sd(m.plan_date)) : '') + '</option>';
    }).join('') + '</datalist>';
    var dlMods = '';
    var nodeRows = (S.bizNodes || []).map(function (r, i) {
      var past = r.plan && dstr(r.plan) < todayISO();
      return '<tr data-row><td data-label="节点"><input id="bn_nm_' + i + '" list="bn_list" value="' + esc(r.name || '') + '" placeholder="从基线里选，或填写节点名称" onchange="App.bizNodeCalc(' + i + ')">'
        + (r.is_key ? '<div style="margin-top:5px"><span class="chip key">关键节点</span></div>' : '') + '</td>'
        + '<td data-label="计划完成时间"><input type="date" aria-label="节点计划完成时间" id="bn_pl_' + i + '" value="' + esc(dstr(r.plan)) + '"></td>'
        + '<td data-label="当前进展 / 本月安排"><textarea rows="1" data-grow data-rich id="bn_pg_' + i + '" oninput="App.grow(this)" placeholder="当前进展 / 本月安排">' + esc(r.prog || '') + '</textarea></td>'
        + '<td data-label="操作" class="opdel">' + (past ? '<span class="badge red">已过计划日</span>' : '')
        + '<button type="button" class="rowdel" title="移除这一行" onclick="App.delBizNode(' + i + ')">✕</button></td></tr>';
    }).join('');
    if (!nodeRows) nodeRows = '<tr><td colspan="4" class="empty">添加本月最关键的 2–3 个节点，填写计划完成时间与当前进展。</td></tr>';
    var monthLocked=window.MonthlyPlans && window.MonthlyPlans.locked();
    var itemRows = (S.bizItems || []).map(function (r, i) {
      mergePlanProgress(r);
      return '<tr data-row><td data-label="模块">'+(monthLocked?richItem(r,'mod'):'<input data-rich id="bi_mod_'+i+'" value="'+esc(r.mod || '')+'" placeholder="模块或工作类别">')+'</td>'
        +'<td data-label="事项">'+(monthLocked?richItem(r,'name'):'<textarea rows="2" data-grow data-rich id="bi_nm_'+i+'" oninput="App.grow(this)" placeholder="事项：可交付的结果">'+esc(r.name || '')+'</textarea>')+'</td>'
        +'<td data-label="完成时间">'+(monthLocked?esc(sd(r.due)):'<input type="date" aria-label="事项完成时间" id="bi_due_'+i+'" value="'+esc(dstr(r.due))+'">')+'</td>'
        +'<td data-label="当周进展"><textarea rows="2" data-grow data-rich id="bi_pg_'+i+'" oninput="App.grow(this)" placeholder="填写本周进展、结果或遇到的问题">'+esc(r.prog || '')+'</textarea>'
        +'<div class="plan-item-actions">'+planItemActionHtml(r)+'</div>'
        +(!monthLocked?'<button type="button" class="rowdel" title="移除这一行" onclick="App.delBizItem('+i+')">✕</button>':'')+'</td></tr>';
    }).join('');
    if(!itemRows)itemRows='<tr><td colspan="4" class="empty">添加本月计划事项。确认后计划列固定。</td></tr>';
    var coordHtml = S.coordRows.map(function (r, i) {
      return '<div class="nextitem plan-coord-row" data-row><select id="co_who_' + i + '" aria-label="协调对象">' + orgOptions(r.who) + '</select>'
        + '<textarea rows="1" data-grow data-rich id="co_what_' + i + '" oninput="App.grow(this)" placeholder="需要对方做什么">' + esc(r.what || '') + '</textarea>'
        + '<input type="date" aria-label="协调最晚时间" id="co_by_' + i + '" value="' + esc(dstr(r.by)) + '"></div>';
    }).join('');
    var dueList = [];
    (S.bizNodes || []).forEach(function (r) {
      if (!(r.name || '').trim() || !r.plan) return;
      if (inThisMonth(r.plan) || dstr(r.plan) < todayISO()) dueList.push({ kind: '节点', mod: '', name: r.name, due: r.plan, prog: r.prog || '' });
    });
    (S.bizItems || []).forEach(function (r) {
      if (!(r.name || '').trim() || !r.due) return;
      if (inThisMonth(r.due) || dstr(r.due) < todayISO()) dueList.push({ kind: '事项', mod: r.mod || S.pmLine || '', name: r.name, due: r.due, prog: r.prog || '' });
    });
    dueList.sort(function (a, b) { return String(a.due).localeCompare(String(b.due)); });
    var myItems = (S.bizItems || []).filter(function (r) { return (r.name || '').trim(); });
    var myNodes = (S.bizNodes || []).filter(function (r) { return (r.name || '').trim(); });
    var coreSection = window.BaselineCore
      ? '<div id="baseline-core-summary">' + window.BaselineCore.personalCoreHtml({commercial:commercial,projectIds:pmScopeProjectIds(),discipline:myDisc(),allScopes:!!S.pmReportScope && !professionalPMScope()}) + '</div>'
        + (myNodes.length ? '<details><summary>原手填节点与草稿（保留，不参与自动汇总）</summary><div class="tablewrap"><table class="plan-form-table"><thead><tr><th>节点</th><th>计划完成时间</th><th>原记录进展</th></tr></thead><tbody>'
          + myNodes.map(function(n){return '<tr><td>'+richItem(n,'name')+'</td><td>'+esc(sd(n.plan))+'</td><td>'+richItem(n,'prog')+'</td></tr>';}).join('')+'</tbody></table></div></details>' : '')
      : '<p class="notice err" role="alert">项目基准节点组件读取失败，请刷新重试。</p>';
    var odNum = myItems.filter(itemOverdue).length;
    var myItem = itemStat(cur);
    var projectLines=myBizLines(S.pmProject);
    var myLnFixed = (S.profile && S.profile.biz_line && projectLines.indexOf(S.profile.biz_line) >= 0) ? S.profile.biz_line : '';
    var allTestLines = S.profile && S.profile.biz_line === '*';
    var lineSwitch = projectLines.map(function (l) { return '<option value="' + esc(l) + '"' + (S.pmLine === l ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('');
    var grantError=dataState.businessModuleGrants && dataState.businessModuleGrants.error;
    var moduleHtml = !commercial ? '<span class="plan-context-label">住宅专业</span><b>'+esc(S.pmLine===LINE_ALL?'住宅综合':S.pmLine)+'</b>' : grantError && S.pmLine==='设计部'
      ? '<span class="plan-context-label">当前商业专业</span><b>'+esc(S.pmLine)+'</b><span class="muted" role="alert">附加专业授权读取失败，原草稿保留；请刷新后再提交。</span>'
      : allTestLines || projectLines.length>1 ? '<label class="plan-context-label" for="planBizLine">'+(allTestLines?'测试账号 · 可切换商业模块':'我的商业专业')+'</label><select id="planBizLine" onchange="App.pmLineSet(this.value)">' + lineSwitch + '</select>' : myLnFixed
      ? '<span class="plan-context-label">我的模块（固定 · 管理员指定）</span><b>' + esc(myLnFixed) + '</b>'
      : projectLines.length===1?'<span class="plan-context-label">我的商业专业</span><b>'+esc(projectLines[0])+'</b>'
      : '<span class="plan-context-label">我的商业模块</span><b>待管理员分配</b><span class="muted" role="status">可保存本机草稿；分配前不能提交或上传附件。</span>';
    var sameWeekOther = S.reports.filter(function (r) {
      return r.project_id === pid && weekNo(r.period) === weekNo(S.pmPeriod || currentPeriod()) && (r.line || LINE_ALL) !== S.pmLine;
    });

    return (commercial ? '' : dlNodes) + dlMods + '<div class="workgrid onecol plan-form report3-compact-form" data-shared-rich-editor><div class="colmain">'
      + planFormContext(pid, cur, moduleHtml, commercial)
      + '<div class="planning-ai-entry"><button type="button" class="btn primary" onclick="App.openPlanningAI()">AI 填报助手</button></div>'
      + legacyScopeDraftsHtml()
      + '<details class="plan-help"><summary>项目快览</summary><div class="plan-help-content">'
      + '<div class="plan-quick-stats">' + (commercial ? '<span>开业目标日 <b>' + esc(comMeta(pid).open_date || '未设置') + '</b></span><span>距开业 <b>' + (dOpen !== null ? (dOpen >= 0 ? dOpen + ' 天' : '已过 ' + Math.abs(dOpen) + ' 天') : '—') + '</b></span>' : '<span>住宅专业 <b>'+esc(S.pmLine===LINE_ALL?'住宅综合':S.pmLine)+'</b></span>')
      + '<span>本周基准节点 <b>'+(window.BaselineCore?window.BaselineCore.coreRows({projectId:pid,projectIds:pmScopeProjectIds(),allScopes:!!S.pmReportScope && !professionalPMScope(),commercial:commercial,line:S.pmLine,discipline:myDisc(),window:reportWindow(S.pmPeriod,cur && (cur.submitted_at || cur.created_at),'week')}).length:0)+' 项</b></span><span>当月计划事项 <b>' + myItems.length + ' 项</b></span>'
      + '<span>已过完成时间 <b>' + odNum + ' 项</b></span><span>本月到期（含已过期） <b>' + dueList.length + ' 项</b></span><span>本期已提交事项 <b>' + (myItem.total ? myItem.total + ' 项' : '—') + '</b></span></div>'
      + (dueList.length ? '<p class="muted">' + dueList.slice(0, 5).map(function (x) { return richItem(x, 'name') + '（' + esc(sd(x.due)) + '）'; }).join('、') + '</p>' : '')
      + (!commercial && cur && (cur.dev_text || cur.next_items && cur.next_items.length) ? '<details><summary>既有住宅补充记录</summary><div class="revision-content">'+riskCell(cur)+nextCell(cur)+'</div></details>' : '')
      + (commercial && sameWeekOther.length ? '<p class="muted">本期其它模块已报：' + sameWeekOther.map(function (r) { return esc(r.line || '综合'); }).join('、') + '</p>' : '') + '</div></details>'

      + '<section class="card plan-form-section"><div class="cardhd plan-section-head"><h3>一、本周核心节点计划</h3><span class="plan-section-note">'+esc((function(){var w=reportWindow(S.pmPeriod,cur && (cur.submitted_at || cur.created_at),'week');return w?w.start+' 至 '+w.end:'所选报告周';})())+'</span></div>'
      + coreSection + '</section>'
      + '<section class="card plan-form-section"><div class="cardhd plan-section-head"><h3>二、当月计划填报</h3><button type="button" class="btn ghost sm" onclick="App.openReportReference()">查看其他专业填报</button></div>'
      + (window.MonthlyPlans?window.MonthlyPlans.toolbarHtml():'')
      + (window.MonthlyPlans && S.pmReportScope?window.MonthlyPlans.plannerHtml():'')
      + (S.pmReportScope?'<h4 class="subh">'+(professionalPMScope()?'本周专业进展 · '+esc(S.pmLine):'本周综合进展 · 保留原统一填报')+'</h4>':'')
      + '<div class="tablewrap"><table class="plan-form-table report3-monthly-table"><thead><tr><th>模块</th><th>事项</th><th>完成时间</th><th>当周进展</th></tr></thead><tbody>' + itemRows + '</tbody></table></div>'
      + (!monthLocked?'<div class="plan-row-actions"><button type="button" class="btn ghost sm" onclick="App.addBizItem()">＋ 增加事项</button></div>':'')+'</section>'
      + (window.MonthlyPlans && !S.pmReportScope?window.MonthlyPlans.plannerHtml():'')
      + '<section class="card plan-form-section"><div class="cardhd plan-section-head"><h3>三、需要协调事项</h3></div>' + coordHtml
      + '<div class="plan-row-actions"><button type="button" class="btn ghost sm" onclick="App.addCoord()">＋ 增加一行</button></div></section>'
      + (window.ReporterTasks ? window.ReporterTasks.formHtml() : '')
      + (window.ReportAttachments ? window.ReportAttachments.formHtml() : '')
      + planFormActions(cur, commercial) + '</div></div>';
  }

  function viewMyProjects() {
    var list = reportingProjects();
    if (!list.length) return '<div class="card"><div class="empty">尚未分配项目，请联系运营管理员。</div></div>';
    var rows = list.map(function (p) {
      var nk = nextKey(p.id), d = nk ? dayDiff(nk.forecast_date, nk.plan_date) : null;
      var r = latestReport(p.id);
      /* 商业项目：不显示单一节点，改显示模块填报进度与开业倒计时 */
      if (isCom(p.id)) {
        var ls2 = lineStat(p.id), dOpen2 = daysToOpen(p.id), lines = myBizLines(p.id);
        var myReps = lines.map(function(line){return lineReport(p.id, S.pmPeriod, line);}).filter(Boolean), myRep = myReps[0];
        var mySt = myReps.length ? myReps.reduce(function(total,report){var st=itemStat(report);total.total+=st.total;total.overdue+=st.overdue;return total;},{total:0,overdue:0}) : null;
        return '<tr>'
          + '<td><b>' + esc(p.name) + '</b> <span class="chip biz">商业</span>'
          + '<div class="muted" style="margin-top:3px">我的模块：' + esc(myBizLineLabel(p.id)) + '</div></td>'
          + '<td>' + (ls2.reported + ' / ' + ls2.total + ' 模块已报' + (ls2.missing.length ? '<div class="muted" style="margin-top:3px">未报：' + esc(ls2.missing.join('、')) + '</div>' : '')) + '</td>'
          + '<td class="muted">' + (dOpen2 !== null ? (dOpen2 >= 0 ? dOpen2 + ' 天' : '已过 ' + Math.abs(dOpen2) + ' 天') : '—') + '</td>'
          + '<td>' + (mySt ? (mySt.total ? mySt.total + ' 项事项' + (mySt.overdue ? '（已过完成时间 ' + mySt.overdue + '）' : '') : '已报') : '<span class="muted">本模块未报</span>') + '</td>'
          + '<td>' + badge(statusOf(p.id)) + '</td>'
          + '<td>' + '<span class="muted">开业倒计时</span><br>' + (dOpen2 !== null ? (dOpen2 >= 0 ? dOpen2 + ' 天' : '已过 ' + Math.abs(dOpen2) + ' 天') : '—') + '</td>'
          + '<td>' + (myRep ? '<span class="badge green">已填报' + (lines.length > 1 ? ' ' + myReps.length + ' / ' + lines.length + ' 模块' : '') + '</span>' : '<span class="badge yellow">未填报</span>') + '</td>'
          + '<td>' + projectDetailButton(p.id) + '<button class="btn ghost sm" onclick="App.fillProject(\'' + esc(p.id) + '\')">去填报</button></td>'
          + '</tr>';
      }
      return '<tr>'
        + '<td><b>' + esc(p.name) + '</b></td>'
        + '<td>' + (nk ? richItem(nk, 'name') + (nk.is_key ? ' <span class="chip key">关键</span>' : '') : '<span class="muted">计划节点已全部完成</span>') + '</td>'
        + '<td class="muted">' + (nk ? esc(sd(nk.plan_date)) : '—') + '</td>'
        + '<td>' + (nk ? esc(sd(nk.forecast_date)) + ' ' + devTxt(d) : '—') + '</td>'
        + '<td>' + badge(statusOf(p.id)) + '</td>'
        + '<td>' + speedPill(dualAssessment(p.id).speed) + ' ' + effectPill(dualAssessment(p.id).effect) + '</td>'
        + '<td>' + (submittedThisWeek(p.id) ? '<span class="badge green">已填报</span>' : '<span class="badge yellow">未填报</span>') + '</td>'
        + '<td>' + projectDetailButton(p.id) + '<button class="btn ghost sm" onclick="App.fillProject(\'' + esc(p.id) + '\')">去填报</button></td>'
        + '</tr>';
    }).join('');
    return '<div class="card"><div class="cardhd"><h2 style="margin:0">我的项目</h2>'
      + '<span class="hint" style="margin:0">共 ' + list.length + ' 个项目 · 本期已填报 ' + list.filter(function (p) { return submittedThisWeek(p.id); }).length + ' 个</span></div>'
      + '<div class="tablewrap"><table><thead><tr><th style="width:15%">项目</th><th style="width:22%">下一个关键节点 / 模块进度</th><th style="width:10%">计划（引导）</th>'
      + '<th style="width:16%">本周预计 / 偏差 / 事项</th><th style="width:8%">状态</th><th style="width:14%">经营双维 / 开业</th><th style="width:8%">本期</th><th></th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div></div>'
      + '<div class="card" style="padding:14px 20px"><div class="muted">下面是本项目（<b>' + esc(projName(S.pmProject)) + '</b>）的节点基线：计划日期是<b>引导值</b>，'
      + '此处只读查看，预计时间维护与完成申报请到工作台“条线节点”。切换项目即可查看其他项目基线。</div><button class="btn ghost sm" onclick="App.view(\'mline\')">到工作台办理节点</button></div>'
      + baseCard(S.pmProject, true)
      + '<div class="card"><h3>说明</h3><div class="muted">基线只用于「提醒该想什么」。计划本身可以调整，但每一次调整都应当在周报里说明原因——这才是训练。</div></div>';
  }

  /* 节点基线卡片：PM 端并入「我的项目」页，也可单独作为一页 */
  function baseCard(pid, withSwap) {
    /* 按完成时间由近向远排序，无计划日期的排最后 */
    var ms = msOf(pid).slice().sort(function (a, b) {
      return String(a.plan_date || '9999-12-31').localeCompare(String(b.plan_date || '9999-12-31'));
    });
    if (!ms.length) return '<div class="card"><div class="empty">该项目的节点基线尚未导入。</div></div>';
    var rows = ms.map(function (m) {
      var d = m.done ? null : dayDiff(m.forecast_date, m.plan_date);
      var L = m.done ? 'gray' : lightOf(d);
      return '<tr>'
        + '<td><b>' + richItem(m, 'name') + '</b>' + (m.is_key ? ' <span class="chip key">关键节点</span>' : '') + '</td>'
        + '<td>' + (m.key_name ? '<span class="chip">' + esc(m.key_name) + '</span>' : '') + esc(m.level || '') + '</td>'
        + '<td class="muted">' + esc(m.standard || '—') + '</td>'
        + '<td class="muted">' + esc(m.owner_dept || '—') + '</td>'
        + '<td class="muted">' + esc(sd(m.plan_date)) + '</td>'
        + '<td>' + (m.done ? '<span class="badge gray">已完成</span>' : '<span class="muted">'+esc(sd(m.forecast_date))+'</span>') + '</td>'
        + '<td><span class="dot d-' + L + '"></span>' + (m.done ? '—' : devText(d)) + '</td>'
        + '</tr>';
    }).join('');
    var swap = '';
    if (withSwap) {
      var mp = reportingProjects();
      if (mp.length > 1) {
        swap = '<div style="max-width:340px;margin-bottom:12px"><label>切换项目查看基线</label>'
          + '<select onchange="App.switchProject(this.value)">'
          + mp.map(function (p) { return '<option value="' + esc(p.id) + '"' + (pid === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('')
          + '</select></div>';
      }
    }
    return '<div class="card"><div class="cardhd"><h2 style="margin:0">节点基线 · ' + esc(projName(pid)) + '</h2>'
      + '<span class="hint" style="margin:0">计划日期来自公司计划；此处只读，进度与报审统一在工作台办理</span></div>'
      + swap
      + '<div class="tablewrap"><table><thead><tr><th style="width:24%">节点</th><th style="width:12%">层级</th><th style="width:20%">完成标准</th>'
      + '<th style="width:10%">主责部门</th><th style="width:10%">计划（引导）</th><th style="width:14%">本周预计</th><th style="width:9%">较计划</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div></div>';
  }

  function viewBase() {
    return baseCard(S.pmProject, true)
      + '<div class="card"><h3>说明</h3><div class="muted">基线只用于「提醒该想什么」。计划本身可以调整，但每一次调整都应当在周报里说明原因——这才是训练。</div></div>';
  }

  /* ============ 个人中心（项目经理个人工作台）============
     把填报卡第四部分「个人工作专项汇总」从"填完才看得到"变成随时能看的一块屏，
     并把待处理事项按优先级排出来：
       ① 开业倒计时（商业项目）
       ② 事项进展状态数据统计
       ③ 待处理事项的优先级（P0 紧急 / P1 高 / P2 中 / P3 低 / 已办结）
       ④ 当月到期、月度计划、工作面移交、其他专业需协调
     数据源＝「我提交过的报告」（author_id = 我）；本地草稿不进这里，避免与填报页口径打架 */

  /* 事项状态：商业事项保持自由填写，状态由「当前进展」文本 + 完成时间推断。
     顺序关键——写明完成的，即使已过完成时间也算办结 */
  var STATE_TXT = { done: '已完成', doing: '推进中', overdue: '已过完成时间', todo: '未启动' };
  /* 归属判断：优先 author_id（正常数据都有）；极少数历史数据 id 缺失时退化为姓名比对 */
  function isMyReport(r) {
    if (!r) return false;
    if (r.author_id) return r.author_id === S.uid;
    return !!(S.profile && r.author_name && r.author_name === S.profile.name);
  }
  /* 一条外部需求是否指向我：协调对象／移交接收方里出现我的姓名，或出现我负责的模块名 */
  function hitMe(txt,pid) {
    var t = String(txt || '').trim();
    if (!t) return false;
    var n = (S.profile && S.profile.name) || '';
    if (n.length >= 2 && t.indexOf(n) >= 0) return true;
    return myBizLines(pid).some(function(line){return t.indexOf(line) >= 0;});
  }
  /* 别人提报的、指向我的需求：来源＝本期本项目其他人的填报（协调事项 + 工作面移交）
     命中我的进 mine（待我响应），其余进 other（本期还有哪些跨专业需求，供周例会参考） */
  function needsFromOthers(pid) {
    var mine = [], other = [], wn = weekNo(S.pmPeriod || currentPeriod());
    S.reports.forEach(function (r) {
      if (r.project_id !== pid || weekNo(r.period) !== wn || isMyReport(r)) return;
      var ln = r.line || LINE_ALL, from = r.author_name || '—';
      (r.coord_items || []).forEach(function (c) {
        if (!c || (!c.who && !c.what)) return;
        var key=c.source_id?'coord:'+pid+':'+r.id+':coord:'+c.source_id:'';
        var e = richDisplayCopy(c, { type: '协调', line: ln, from: from, target: c.who || '未指定', what: c.what || '', by: effectiveItemDue(key,c.by || ''),source_key:key });
        e.for_me=Object.prototype.hasOwnProperty.call(c,'who_id')?c.who_id===S.uid:hitMe(c.who,pid) || hitMe(c.what,pid);(e.for_me ? mine : other).push(e);
      });
      handoverOf(r).forEach(function (h) {
        if (!h || !String(h.what || '').trim()) return;
        var key=h.source_id?'coord:'+pid+':'+r.id+':handover:'+h.source_id:'';
        var e = richDisplayCopy(h, { type: '移交', line: ln, from: from, target: h.to || '未指定', what: h.what, by: effectiveItemDue(key,h.due || ''),source_key:key });
        e.for_me=hitMe(h.to,pid) || hitMe(h.what,pid);(e.for_me ? mine : other).push(e);
      });
    });
    return { mine: mine, other: other };
  }
  /* Display projections keep source formatting rather than matching equal text. */
  function richDisplayCopy(source, target, fields) {
    if (window.ZHRichText) window.ZHRichText.copy(source, target, fields);
    return target;
  }
  function needTable(list, emptyTxt) {
    if (!list.length) return '<div class="empty">' + esc(emptyTxt) + '</div>';
    return '<div class="tablewrap"><table><thead><tr>'
      + '<th style="width:8%">类型</th><th style="width:11%">提出人</th><th style="width:13%">提出模块</th>'
      + '<th style="width:34%">需求内容</th><th style="width:17%">指向</th><th class="pm-col-date">最晚时间</th><th class="pm-col-action">事项申报</th>'
      + '</tr></thead><tbody>' + list.map(function (e) {
        return '<tr><td>' + esc(e.type) + '</td><td>' + esc(e.from) + '</td><td>' + esc(e.line) + '</td>'
          + '<td><b>' + richItem(e, 'what', e.what || '—') + '</b></td><td>' + esc(e.target) + '</td>'
          + '<td class="muted pm-col-date">' + esc(e.by ? sd(e.by) : '—') + '</td><td class="pm-col-action">' + (e.for_me?itemAction(e.source_key):'<span class="muted">供参考</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function itemState(x) {
    if (!x) return 'todo';
    if(x.source_key && window.CompletionReview){
      if(window.CompletionReview.approved(x.source_key,S.uid))return 'done';
      return x.due && String(x.due).slice(0,10)<todayISO()?'overdue':String(x.prog || '').trim()?'doing':'todo';
    }
    var p = String(x.prog || '');
    if (isCompletedProgress(p)) return 'done';
    if (itemOverdue(x)) return 'overdue';
    return p.trim() ? 'doing' : 'todo';
  }
  function statePill(s) {
    var cls = s === 'done' ? 'green' : s === 'overdue' ? 'red' : s === 'doing' ? 'blue' : 'gray';
    return '<span class="badge ' + cls + '"><i class="bico"></i>' + (STATE_TXT[s] || '—') + '</span>';
  }
  /* 待处理优先级：P0 已过完成时间（立刻处理）／P1 未来 3 天内（高）／
     P2 未来 4~14 天（中）／P3 更远或未填时间（低）；已办结单列 */
  var PRIO_TXT = { P0: 'P0 紧急', P1: 'P1 高', P2: 'P2 中', P3: 'P3 低', DONE: '已办结' };
  function prioOf(x) {
    if (itemState(x) === 'done') return 'DONE';
    var due = (x && x.due) ? String(x.due).slice(0, 10) : '';
    if (!due) return 'P3';
    if (due < todayISO()) return 'P0';
    if (due <= addDays(todayISO(), 3)) return 'P1';
    if (due <= addDays(todayISO(), 14)) return 'P2';
    return 'P3';
  }
  function prioTag(p) {
    var cls = p === 'P0' ? 'red' : p === 'P1' ? 'yellow' : p === 'P2' ? 'blue' : 'gray';
    return '<span class="badge ' + cls + '">' + (PRIO_TXT[p] || p) + '</span>';
  }
  function planSourceKey(report,group,item) {
    if(!report || report.author_id!==S.uid || isCom(report.project_id) && !canReportBizLine(report.line,report.project_id))return '';
    if(group==='items' && item.monthly_plan_id && report.biz && Array.isArray(report.biz.monthly_plan_ids)
      && report.biz.monthly_plan_ids.includes(item.monthly_plan_id) && item.source_id)return 'monthly:'+report.project_id+':'+item.monthly_plan_id+':'+item.source_id;
    if(group==='items' && report.biz && report.biz.monthly_plan_id && item.source_id)return 'monthly:'+report.project_id+':'+report.biz.monthly_plan_id+':'+item.source_id;
    var baseline=group==='nodes' && msOf(report.project_id).filter(function(m){return item.milestone_id!=null?String(m.id)===String(item.milestone_id):!item.source_id && m.name===item.name;})[0];
    var stored=group==='nodes' && !item.source_id?nodesOf(report).filter(function(n){return n.name===item.name;})[0]:item;
    return baseline?'milestone:'+report.project_id+':'+baseline.id:stored && stored.source_id?'plan:'+report.project_id+':'+report.id+':'+group+':'+stored.source_id:'';
  }
  function effectiveItemDue(key,due) {
    return window.CompletionReview && window.CompletionReview.effectiveDue?window.CompletionReview.effectiveDue(key,due,S.uid):due;
  }
  function itemAction(key) {
    return key && window.CompletionReview?window.CompletionReview.actionHtml(key):'<span class="muted">原记录需重新提交后申报</span>';
  }
  function planItemActionHtml(item) {
    if(window.MonthlyPlans){var monthlyAction=window.MonthlyPlans.actionHtml(item);if(monthlyAction)return monthlyAction;if(window.MonthlyPlans.locked())return '<span class="muted">请先重新读取确认版，再申报完成或延期。</span>';}
    var report=S.pmReport, saved=report && itemsOf(report).some(function(row){return row.source_id && row.source_id===item.source_id;});
    return saved?itemAction(planSourceKey(report,'items',item)):'<span class="muted">请先提交本期填报，再申报完成或延期。</span>';
  }
  function criticalWorkItems(pid) {
    var rows=window.ReporterTasks && window.ReporterTasks.sourceItems?window.ReporterTasks.sourceItems():[],feedback=Object.create(null);
    var projects=pid===S.pmProject && S.pmReportScope && !isCom(pid)?pmScopeProjectIds():[pid];
    (S.followupRows || []).forEach(function(row){if(row && row.source_key)feedback[row.source_key]=row;});
    return rows.filter(function(row){return row && ['meeting','coord'].indexOf(row.source_type)>=0 && row.source_key && projects.indexOf(row.project_id || row.source_key.split(':')[1])>=0;}).map(function(row){
      var source=window.ReporterTasks.feedbackFor?window.ReporterTasks.feedbackFor(row.source_key,row):(feedback[row.source_key] || row);
      var item=richDisplayCopy(row,{source_key:row.source_key,kind:window.ReporterTasks.displayTitle?window.ReporterTasks.displayTitle(row):(row.title || '同步事项'),name:row.what || '',
        prog:String(source.progress || ''),period:S.pmPeriod,line:row.source_author || '',due:effectiveItemDue(row.source_key,row.due || '')},{name:'what'});
      return richDisplayCopy(source,item,{prog:'progress'});
    });
  }
  function pmPriorityGroups(items,empty) {
    var grouped={};
    items.forEach(function(item){var p=prioOf(item);(grouped[p] || (grouped[p]=[])).push(item);});
    if(!items.length)return '<div class="empty">'+esc(empty || '暂无待处理事项。')+'</div>';
    return ['P0','P1','P2','P3','DONE'].filter(function(p){return grouped[p];}).map(function(p){
      var rows=grouped[p].sort(function(a,b){return String(a.due || '9999').localeCompare(String(b.due || '9999'));});
      return '<details class="pm-priority-group" data-priority="'+p+'"'+(p!=='DONE'?' open':'')+'><summary>'+prioTag(p)+'<span>'+rows.length+' 项</span></summary>'
        +'<div class="tablewrap"><table class="pm-assignment-table"><thead><tr><th>类型／模块</th><th>事项内容</th><th class="pm-col-date">完成时间</th><th>当前进展</th><th>状态</th><th class="pm-col-action">事项申报</th></tr></thead><tbody>'
        +rows.map(function(e){return '<tr><td>'+esc(e.kind || e.mod || '计划事项')+(e.line?'<div class="muted">'+esc(e.line)+'</div>':'')+'</td><td><b>'+richItem(e,'name')+'</b>'+(e.period?'<div class="muted">'+esc(e.period)+'</div>':'')+'</td>'
          +'<td class="pm-col-date">'+esc(sd(e.due))+'</td><td>'+richItem(e,'prog',e.prog || '—')+'</td><td>'+statePill(itemState(e))+'</td><td class="pm-col-action">'+itemAction(e.source_key)+'</td></tr>';}).join('')
        +'</tbody></table></div></details>';
    }).join('');
  }
  function personalPriorityCard(pid) {
    var items=criticalWorkItems(pid);
    return '<details class="card personal-priority-summary"><summary>按到期查看同一批待办 <span class="chip">'+items.length+' 项</span></summary>'
      +pmPriorityGroups(items,'暂无会议、领导交办或他人需求等待办理。')+'</details>';
  }
  function ownCoordinationHtml(pid) {
    var groups=[['coord','本人发起的协调事项'],['handover','本人登记的移交事项']];
    return groups.map(function(group){var rows=[];
      (S.reports || []).filter(function(r){return r.project_id===pid && r.author_id===S.uid && myProfessionalScopeReport(r,pid) && (!isCom(pid) || canReportBizLine(r.line,pid));}).forEach(function(r){
        var items=group[0]==='coord'?r.coord_items:handoverOf(r);
        (items || []).forEach(function(x){if(!x || !String(x.what || '').trim())return;
          var key=x.source_id?'coord:'+pid+':'+r.id+':'+group[0]+':'+x.source_id:'';
          if(r.period!==S.pmPeriod && key && window.CompletionReview && window.CompletionReview.approved(key,S.uid))return;
          rows.push('<tr><td>'+richItem(x,'what')+'<div class="muted">'+esc(r.period)+'</div></td><td>'+esc(x.who || x.to || '未指定')+'</td><td class="pm-col-date">'+esc(sd(effectiveItemDue(key,x.by || x.due)))+'</td><td class="pm-col-action">'+(group[0]==='coord'?'<span class="muted">承办人申报后，由本人审核确认</span>':itemAction(key))+'</td></tr>');
        });
      });
      return rows.length?'<section class="card"><div class="cardhd"><h3>'+group[1]+'</h3></div><div class="tablewrap"><table class="pm-assignment-table"><thead><tr><th>事项内容</th><th>协调／接收人</th><th class="pm-col-date">最晚时间</th><th class="pm-col-action">事项申报</th></tr></thead><tbody>'+rows.join('')+'</tbody></table></div></section>':'';
    }).join('')+(window.CompletionReview && window.CompletionReview.renderInitiatedQueue?window.CompletionReview.renderInitiatedQueue({project_id:pid}):'');
  }
  /* 我的商业台账：把我提交过的节点与事项摊平成条目，并按周期分组 */
  function myBizLedger(pid) {
    var rs = S.reports.filter(function (r) { return r.project_id === pid && isMyReport(r); })
      .sort(function (a, b) { return (weekNo(b.period) || 0) - (weekNo(a.period) || 0); });
    var byPeriod = {};
    rs.forEach(function (r) {
      var ln = r.line || LINE_ALL, key = r.period;
      if (!byPeriod[key]) {
        byPeriod[key] = { period: key, wn: weekNo(key) || 0, at: r.submitted_at || r.updated_at, lines: [], o: { nodes: [], items: [], hand: [], coords: [] } };
      }
      var g = byPeriod[key];
      if (g.lines.indexOf(ln) < 0) g.lines.push(ln);
      nodesOf(r).forEach(function (x) {
        if (x && (x.name || '').trim()) {var key=planSourceKey(r,'nodes',x);g.o.nodes.push(richDisplayCopy(x, { kind: '节点', line: ln, name: x.name, due: effectiveItemDue(key,x.plan || ''), prog: x.prog || '', isKey: !!x.is_key,source_key:key,period:r.period }));}
      });
      itemsOf(r).forEach(function (x) {
        if (x && (x.name || '').trim()) {var key=planSourceKey(r,'items',x);g.o.items.push(richDisplayCopy(x, { kind: x.mod || '事项', line: ln, name: x.name, due: effectiveItemDue(key,x.due || ''), prog: x.prog || '', isKey: false,source_key:key,period:r.period }));}
      });
      handoverOf(r).forEach(function (x) {
        if (x && (x.what || '').trim()) g.o.hand.push(richDisplayCopy(x, { line: ln, what: x.what, to: x.to || '', due: x.due || '' }));
      });
      (r.coord_items || []).forEach(function (c) {
        if (c && (c.who || c.what)) g.o.coords.push(richDisplayCopy(c, { line: ln, who: c.who || '未指定', what: c.what || '', by: c.by || '' }));
      });
    });
    var periods = Object.keys(byPeriod).sort(function (a, b) { return byPeriod[b].wn - byPeriod[a].wn; });
    return { rs: rs, periods: periods, byPeriod: byPeriod };
  }
  /* 个人中心页头：项目 / 我的模块 / 切换 / 去填报 */
  function pmCenterHead(pid, hint) {
    var mp = reportingProjects();
    var myLn = myBizLineLabel();
    var sw = mp.length > 1
      ? '<div><label>切换项目</label><select onchange="App.switchProject(this.value)">' + mp.map(function (p) {
          return '<option value="' + esc(p.id) + '"' + (pid === p.id ? ' selected' : '') + '>' + esc(p.name) + (isCom(p.id) ? '（商业）' : '（住宅）') + '</option>';
        }).join('') + '</select></div>'
      : '';
    return '<div class="card"><div class="cardhd">'
      + '<h3>我的工作台：<b>' + esc(S.profile.name || '') + '</b>'
      + (isCom(pid) ? ' <span class="chip biz">商业项目</span>' : ' <span class="chip">住宅项目</span>')
      + (isCom(pid) && myLn ? ' <span class="chip">我的模块：' + esc(myLn) + '</span>' : '') + '</h3>'
      + '<button class="btn primary sm" onclick="App.view(\'form\')">去填报</button></div>'
      + (sw ? '<div class="f2" style="margin-top:12px">' + sw + '<div></div></div>' : '')
      + '</div>';
  }
  function reporterMeetingCard(pid) {
    return window.ReporterTasks && window.ReporterTasks.workbenchHtml
      ? window.ReporterTasks.workbenchHtml(pid) : '';
  }
  function reporterNodeSectionHtml(pid) {
    if(!window.CompletionReview || !S.profile || S.profile.role!=='pm')return '';
    var rows=[],used=Object.create(null);
    var reports=(S.reports || []).filter(function(r){return r.project_id===pid && r.author_id===S.uid && myProfessionalScopeReport(r,pid) && (!isCom(pid) || canReportBizLine(r.line,pid));})
      .sort(function(a,b){return String(b.updated_at || b.submitted_at || '').localeCompare(String(a.updated_at || a.submitted_at || ''));});
    reports.forEach(function(report){nodesOf(report).forEach(function(item,index){
        if(!item || !String(item.name || '').trim())return;
        var key=planSourceKey(report,'nodes',item);
        if(key.indexOf('milestone:')===0 || key && (used[key] || window.CompletionReview.approved(key,S.uid)))return;
        if(key)used[key]=true;
        var row=richCopy(report,Object.assign({},item),{name:'biz.nodes.'+index+'.name',prog:'biz.nodes.'+index+'.prog'});
        rows.push({key:key,item:row,period:report.period || '',report:report});
    });});
    if(!rows.length)return '';
    return '<section class="card reporter-plan-section" data-plan-section="nodes"><div class="cardhd"><h3>自主节点计划</h3><span class="chip">待办理 '+rows.length+' 项</span></div>'
        +'<div class="tablewrap"><table class="plan-form-table pm-assignment-table"><thead><tr><th>模块</th><th>事项内容</th><th class="pm-col-date">完成时间</th><th>进展</th><th class="pm-col-action">事项申报</th></tr></thead><tbody>'
        +rows.map(function(entry){var item=entry.item;return '<tr data-source-key="'+esc(entry.key)+'"><td data-label="模块">'+richItem(item,'mod',entry.report && entry.report.line || '')+'</td><td data-label="事项内容">'+richItem(item,'name')+'<div class="muted">'+esc(entry.period)+'</div></td>'
          +'<td data-label="完成时间" class="pm-col-date">'+esc(sd(effectiveItemDue(entry.key,item.due || item.plan)))+'</td><td data-label="进展">'
          +'<div class="muted">原报告反馈</div>'+richItem(item,'prog','未反馈')+'</td><td data-label="事项申报" class="pm-col-action">'+itemAction(entry.key)
          +(!entry.key && entry.report?'<button type="button" class="btn ghost sm" onclick="App.fillProject('+esc(JSON.stringify(pid))+','+esc(JSON.stringify(entry.period))+','+esc(JSON.stringify(entry.report.line || LINE_ALL))+')">打开原填报</button>':'')+'</td></tr>';}).join('')
        +'</tbody></table></div></section>';
  }
  /* 个人中心（商业项目 / 弘坊类） */
  function viewPMCenter() {
    var pid = S.pmProject;
    if (!pid) return '<div class="card"><div class="empty">尚未分配项目，请联系运营管理员。</div></div>';
    if (!isCom(pid)) return viewPMCenterRes(pid);

    var per = S.pmPeriod, meta = comMeta(pid), dOpen = daysToOpen(pid);
    var led = myBizLedger(pid);
    var cur = led.byPeriod[per] || null;
    var fb = !cur && led.periods.length ? led.byPeriod[led.periods[0]] : null;
    var v = cur || fb;
    var isFb = !cur && !!fb;

    var all = v ? v.o.items.concat(v.o.nodes) : [];
    var stat = { total: all.length, done: 0, doing: 0, overdue: 0, todo: 0 };
    all.forEach(function (e) { var s = itemState(e); stat[s] = (stat[s] || 0) + 1; });
    var week7 = all.filter(function (e) { return itemState(e) !== 'done' && e.due && String(e.due).slice(0, 10) <= addDays(todayISO(), 7); });

    /* 按优先级分组，组内按完成时间升序 */
    var groups = {};
    all.forEach(function (e) { var p = prioOf(e); (groups[p] = groups[p] || []).push(e); });
    ['P0', 'P1', 'P2', 'P3', 'DONE'].forEach(function (p) {
      if (groups[p]) groups[p].sort(function (a, b) { return String(a.due || '9999').localeCompare(String(b.due || '9999')); });
    });
    var prioBody = all.length ? all.slice().sort(function (a, b) {
      var oa = ['P0', 'P1', 'P2', 'P3', 'DONE'].indexOf(prioOf(a)), ob = ['P0', 'P1', 'P2', 'P3', 'DONE'].indexOf(prioOf(b));
      return oa - ob || String(a.due || '9999').localeCompare(String(b.due || '9999'));
    }).map(function (e) {
      var st = itemState(e);
      return '<tr' + (st === 'overdue' ? ' class="rowhot"' : '') + '>'
        + '<td>' + prioTag(prioOf(e)) + '</td>'
        + '<td>' + esc(e.kind) + (e.isKey ? ' <span class="chip key">★</span>' : '') + '</td>'
        + '<td>' + esc(e.line || '—') + '</td>'
        + '<td><b>' + richItem(e, 'name') + '</b></td>'
        + '<td class="muted">' + esc(e.due ? sd(e.due) : '—') + '</td>'
        + '<td>' + richItem(e, 'prog', e.prog || '—') + '</td>'
        + '<td>' + statePill(st) + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="empty">' + (v ? '本期还没有登记节点与事项。' : '还没有提交记录——先去「本期填报」提交一次，这里就会自动汇总。') + '</td></tr>';

    /* 工作面移交 / 协调：coords 只用于 KPI 数量统计（明细录入在下方「发起协调」，他人指向我的在主栏） */
    var hand = v ? v.o.hand : [], coords = v ? v.o.coords : [];

    /* 近期台账：按周期倒序，看我最近几期的事项量与办结情况 */
    var ledBody = led.periods.length ? led.periods.slice(0, 6).map(function (k) {
      var g = led.byPeriod[k], arr = g.o.items.concat(g.o.nodes);
      var done = 0, od = 0;
      arr.forEach(function (e) { var s = itemState(e); if (s === 'done') done++; if (s === 'overdue') od++; });
      var isCur = k === per;
      return '<tr><td><b>' + esc(k) + '</b>' + (isCur ? ' <span class="chip">本期</span>' : '') + '</td>'
        + '<td>' + esc(g.lines.join('、')) + '</td>'
        + '<td>' + arr.length + ' 项</td>'
        + '<td>' + done + ' 项</td>'
        + '<td>' + (od ? '<b class="red">' + od + ' 项</b>' : '0 项') + '</td>'
        + '<td class="muted">' + esc(fmtTime(g.at)) + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="empty">暂无提交记录。</td></tr>';

    var p0 = (groups.P0 || []).length, p1 = (groups.P1 || []).length;
    /* 别人提报的、指向我的需求 */
    var need = needsFromOthers(pid);

    /* 工作面移交登记（2026-10-13 从填报页第四部分搬来，这里成为唯一录入入口）：
       行绑定 S.bizHand，与填报页共用同一份草稿（id 沿用 bh_*，snapDraft 自动识别）；
       保存时只改本期本模块报告的 biz.handover，不动其它字段 */
    var myLine = S.pmLine || LINE_ALL;
    var handEditRows = (S.bizHand || []).map(function (r, i) {
      return '<tr data-row>'
        + '<td><input id="bh_what_' + i + '" value="' + esc(r.what || '') + '" placeholder="移交内容（工作面 / 资料 / 责任）" onchange="App.handTouch()"></td>'
        + '<td><input id="bh_to_' + i + '" value="' + esc(r.to || '') + '" placeholder="接收模块 / 接收人" onchange="App.handTouch()"></td>'
        + '<td><input type="date" id="bh_due_' + i + '" value="' + esc(r.due ? String(r.due).slice(0, 10) : '') + '" onchange="App.handTouch()"></td>'
        + '<td class="opdel"><button type="button" class="rowdel" title="移除这一行" onclick="App.delBizHand(' + i + ')">✕</button></td>'
        + '</tr>';
    }).join('');
    if (!handEditRows) {
      handEditRows = '<tr><td colspan="4" class="empty">还没有登记——点下方「＋ 增加移交事项」，'
        + '如：土建移交精装、机电移交精装、景观移交商管等。</td></tr>';
    }
    var handMine = (S.bizHand || []).filter(function (r) { return (r.what || '').trim(); }).length;
    var handOther = hand.filter(function (h) { return (h.line || LINE_ALL) !== myLine; });

    /* 发起协调（2026-10-14 新增）：行绑定 S.coordRows，与填报页第三部分共用同一份草稿与数据源 */
    var coordRows = (S.coordRows || []).map(function (r, i) {
      return '<tr data-row>'
        + '<td><select id="co_who_' + i + '" style="width:100%">' + orgOptions(r.who) + '</select></td>'
        + '<td><input id="co_what_' + i + '" value="' + esc(r.what || '') + '" placeholder="需要他做什么" onchange="App.coordTouch()"></td>'
        + '<td><input type="date" id="co_by_' + i + '" value="' + esc(r.by ? String(r.by).slice(0, 10) : '') + '" onchange="App.coordTouch()"></td>'
        + '<td class="opdel"><button type="button" class="rowdel" title="移除这一行" onclick="App.delCoord(' + i + ')">✕</button></td>'
        + '</tr>';
    }).join('');
    if (!coordRows) {
      coordRows = '<tr><td colspan="4" class="empty">还没有发起——点下方「＋ 增加协调」，'
        + '如：精装 → 幕墙，确认封样时间。</td></tr>';
    }
    var coordMine = (S.coordRows || []).filter(function (r) { return (r.who || '').trim() || (r.what || '').trim(); }).length;

    return pmCenterHead(pid, '这里是你名下所有已提交工作的个人台账：开业倒计时与进展统计、按优先级排列的待处理事项、跨专业需求，一屏看清。')
      + '<div class="workgrid onecol personal-overview"><div class="colmain">'

      /* 倒计时 + KPI */
      + '<div class="card">'
      + countdownHtml(pid)
      + '<h4 class="subh">事项进展状态统计<span class="chip">' + (isFb ? '最近一期 · ' + esc(v.period) : esc(per)) + '</span></h4>'
      + (isFb ? '<div class="notice warn" style="margin:0 0 12px">本期（' + esc(per) + '）你还没有提交记录，以下统计取自最近一期 ' + esc(v.period) + '。</div>' : '')
      + '<div class="kpis">'
      + '<div class="kpi"><b>' + stat.total + '</b><span>台账条目</span></div>'
      + '<div class="kpi green"><b>' + stat.done + '</b><span>已完成</span></div>'
      + '<div class="kpi blue"><b>' + stat.doing + '</b><span>推进中</span></div>'
      + '<div class="kpi red"><b>' + stat.overdue + '</b><span>已过完成时间</span></div>'
      + '<div class="kpi"><b>' + stat.todo + '</b><span>未启动</span></div>'
      + '<div class="kpi amber"><b>' + week7.length + '</b><span>未来 7 天到期</span></div>'
      + '</div>'
      + '</div>'

      /* 总裁交代 + 项目总评价（领导端录入，此处只读展示） */
      + leaderPmCard(pid, false)

      + reporterNodeSectionHtml(pid)

      + (window.ReporterTasks && window.ReporterTasks.pendingHtml?window.ReporterTasks.pendingHtml(pid,need.mine):'')

      + (window.CompletionReview?window.CompletionReview.renderQueue({project_id:pid}):'')


      /* 2026-10-14：右栏整体取消（工作面移交登记 / 发起协调 / 我的近期台账）——
         用户确认整个右栏与个人直报页重复、没有保留意义；页面改单栏铺满（workgrid onecol）。
         原「工作面移交 / 发起协调」录入入口随之移除，saveHand/saveCoord 等函数保留但暂无入口。 */
      + '</div></div>';
  }
  /* 个人中心（住宅项目）：保留住宅研判口径，按商业工作台的单栏顺序展示。 */
  function viewPMCenterRes(pid) {
    var per = S.pmPeriod;
    var rs = S.reports.filter(function (r) { return r.project_id === pid && isMyReport(r) && myProfessionalScopeReport(r,pid); })
      .sort(function (a, b) { return (weekNo(b.period) || 0) - (weekNo(a.period) || 0); });
    var cur = rs.filter(function (r) { return r.period === per; })[0] || rs[0] || null;
    var isFb = !!cur && cur.period !== per;
    var nodes = cur ? pickedNodes(cur) : [];
    var nx = cur ? (cur.next_items || []).filter(Boolean) : [];
    var co = cur ? (cur.coord_items || []).filter(function (x) { return x.who || x.what; }) : [];
    var lag = nodes.filter(function (n) { return n.d !== null && n.d >= 5; });
    var big = nodes.filter(function (n) { return n.d !== null && n.d >= 15; });
    var mx = nodes.reduce(function (a, n) { return Math.max(a, n.d === null ? -999 : n.d); }, 0);
    var need = needsFromOthers(pid);
    /* 优先级按偏差分层：P0 ≥15 天 / P1 5~14 天 / P2 1~4 天 / P3 按计划或提前 */
    function pOf(d) { return d >= 15 ? 'P0' : d >= 5 ? 'P1' : d > 0 ? 'P2' : 'P3'; }
    var sorted = nodes.slice().sort(function (a, b) { return (b.d === null ? -999 : b.d) - (a.d === null ? -999 : a.d); });
    var nodeBody = sorted.length ? sorted.map(function (n) {
      var d = n.d === null ? 0 : n.d;
      return '<tr' + (d >= 15 ? ' class="rowhot"' : '') + '>'
        + '<td>' + prioTag(pOf(d)) + '</td>'
        + '<td><b>' + richItem(n, 'name') + '</b>' + (n.custom ? ' <span class="chip">自定</span>' : '') + '</td>'
        + '<td class="muted">' + esc(sd(n.plan)) + '</td><td>' + esc(sd(n.forecast)) + '</td>'
        + '<td>' + devTxt(n.d) + '</td><td>' + richItem(n, 'reason', n.reason || '—') + '</td><td class="pm-col-action">'+itemAction(planSourceKey(cur,'nodes',n))+'</td></tr>';
    }).join('') : '<tr><td colspan="7" class="empty">本期未选研判节点。</td></tr>';
    var planItems = cur ? itemsOf(cur).filter(function (item) { return item && String(item.name || '').trim(); }) : [];
    var planBody = planItems.slice().sort(function (a, b) {
      return ['P0', 'P1', 'P2', 'P3', 'DONE'].indexOf(prioOf(a)) - ['P0', 'P1', 'P2', 'P3', 'DONE'].indexOf(prioOf(b))
        || String(a.due || '9999').localeCompare(String(b.due || '9999'));
    }).map(function (item) {
      return '<tr><td>' + prioTag(prioOf(item)) + '</td><td>' + richItem(item,'mod','综合') + '</td>'
        + '<td><b>' + richItem(item, 'name') + '</b></td><td>' + esc(sd(item.due)) + '</td>'
        + '<td>' + richItem(item, 'prog', item.prog || '—') + '</td><td>' + statePill(itemState(item)) + '</td></tr>';
    }).join('');

    return pmCenterHead(pid, '查看本项目的工作进展、他人需求、会议跟踪和待处理节点；住宅节点继续按计划与预计时间研判偏差。')
      + '<div class="workgrid onecol reporter-workbench personal-overview"><div class="colmain">'
      + '<div class="card">'
      + '<h4 class="subh">工作进展统计<span class="chip">' + (cur ? esc(cur.period) : '尚未填报') + '</span></h4>'
      + (isFb ? '<div class="notice warn" style="margin:0 0 12px">本期（' + esc(per) + '）你还没有提交记录，以下取自最近一期 ' + esc(cur.period) + '。</div>' : '')
      + '<div class="kpis">'
      + '<div class="kpi"><b>' + nodes.length + '</b><span>研判节点</span></div>'
      + '<div class="kpi red"><b>' + big.length + '</b><span>偏差 ≥15 天</span></div>'
      + '<div class="kpi amber"><b>' + lag.length + '</b><span>滞后节点</span></div>'
      + '<div class="kpi' + (mx >= 15 ? ' red' : mx > 0 ? ' amber' : ' green') + '"><b>' + (mx > 0 ? '+' + mx : '0') + '</b><span>最大偏差（天）</span></div>'
      + '<div class="kpi blue"><b>' + nx.length + '</b><span>下周重点</span></div>'
      + '<div class="kpi"><b>' + co.length + '</b><span>协调需求</span></div>'
      + (planItems.length ? '<div class="kpi blue"><b>' + planItems.length + '</b><span>当期计划事项</span></div>' : '')
      + '</div></div>'

      /* 总裁交代 + 总裁评价（总裁端录入，此处只读展示） */
      + leaderPmCard(pid, true)

      + reporterNodeSectionHtml(pid)

      + (window.ReporterTasks && window.ReporterTasks.pendingHtml?window.ReporterTasks.pendingHtml(pid,need.mine):'')

      + '<div class="card">'
      + '<div class="cardhd"><h3>研判节点与偏差（按优先级）</h3>'
      + '</div>'
      + '<div class="tablewrap"><table><thead><tr><th style="width:9%">优先级</th><th style="width:24%">节点</th>'
      + '<th style="width:12%">计划（引导）</th><th style="width:13%">本周预计</th><th style="width:12%">较计划</th><th style="width:30%">偏差原因 / 对策</th><th class="pm-col-action">事项申报</th>'
      + '</tr></thead><tbody>' + nodeBody + '</tbody></table></div></div>'
      + (window.CompletionReview?window.CompletionReview.renderQueue({project_id:pid}):'')

      + '</div></div>';
  }

  function reportHistoryButton(r) {
    return '<div class="muted">'+esc(r.report_scope_id?'统一范围报告':projName(r.project_id)+' · 原项目报告')+'</div><div style="margin-top:7px"><button class="btn ghost sm" onclick="App.showReportHistory(' + Number(r.id) + ')">查看内容与版本（'
      + ((Array.isArray(r.history) ? r.history.length : 0) + 1) + '）</button></div>';
  }
  function reportSnapshotHtml(r, options) {
    if (window.ZHRichText) window.ZHRichText.attach(r);
    function section(title, content) { return '<h4 class="subh">' + title + '</h4><div class="revision-content">' + (content || '<span class="muted">未填写</span>') + '</div>'; }
    function list(items, describe) { return (items || []).map(function (x) { return '<div>· ' + describe(x) + '</div>'; }).join(''); }
    var html = '<div class="hint">填报人：' + esc(r.author_name || '—') + ' · ' + esc(r.line || LINE_ALL)
      + ' · 保存时间：' + esc(fmtTime(r.updated_at || r.submitted_at)) + '</div>';
    if(r.report_scope_id)html+='<p class="notice" data-report-scope="'+esc(r.report_scope_id)+'">统一范围报告：'+esc(reportScopeTitle(r))+' · 成员项目：'
      +esc((r.scope_project_ids || []).map(projName).join('、'))+'。本页显示原保存的整组内容，各事项按原记录标明来源。</p>';
    if (isCom(r.project_id) || bizOf(r).form_version === 2) {
      html += section('本月核心节点', list(nodesOf(r), function (n) {
        return richItem(n, 'name') + reportItemSourceHtml(r,n) + ' · 计划：' + esc(sd(n.plan)) + '<br>进展：' + richItem(n, 'prog', n.prog || '未填写');
      }));
      html += section('当月计划事项', options && options.reference
        ? '<table class="report-reference-table"><thead><tr><th>模块</th><th>事项</th><th>完成时间</th><th>当周进展</th></tr></thead><tbody>'+itemsOf(r).map(function(x){
          return '<tr><td data-label="模块">'+richItem(x,'mod')+'</td><td data-label="事项">'+richItem(x,'name')+reportItemSourceHtml(r,x)+'</td>'
            +'<td data-label="完成时间">'+esc(sd(x.due))+'</td><td data-label="当周进展">'+richItem(x,'prog',x.prog || '未填写')+(x.blocker?'<br>遇到卡点：'+richItem(x,'blocker'):'')+'</td></tr>';
        }).join('')+'</tbody></table>'
        : list(itemsOf(r), function (x) {
        return richItem(x, 'name') + reportItemSourceHtml(r,x) + ' · ' + richItem(x,'mod') + ' · 完成时间：' + esc(sd(x.due)) + '<br>进展：' + richItem(x, 'prog', x.prog || '未填写')+(x.blocker?'<br>遇到卡点：'+richItem(x,'blocker'):'');
      }));
      html += section('工作面移交', list(handoverOf(r), function (x) { return richItem(x, 'what') + reportItemSourceHtml(r,x) + ' → ' + esc(x.to || '未指定') + ' · ' + esc(sd(x.due)); }));
      if(!isCom(r.project_id)){
        var legacyNodes=pickedNodes(r);
        if(legacyNodes.length)html+=section('既有研判节点',list(legacyNodes,function(n){return richItem(n,'name')+reportItemSourceHtml(r,n)+' · '+esc(sd(n.plan))+' → '+esc(sd(n.forecast))+' · '+esc(devText(n.d))+'<br>'+richItem(n,'reason');}));
        html+=overviewLegacyHtml(r);
      }
    } else {
      html += section('本期研判节点', list(pickedNodes(r), function (n) {
        return richItem(n, 'name') + reportItemSourceHtml(r,n) + ' · ' + esc(sd(n.plan)) + ' → ' + esc(sd(n.forecast)) + ' · ' + esc(devText(n.d)) + '<br>' + richItem(n, 'reason');
      }));
      html += section('本周实质性变化', richItem(r, 'change_text'));
      html += section('风险、影响与对策', riskCell(r));
      html += section('提速对策', list(r.speed_items, function (x) { return richItem(x, 'act') + (x.gain ? '（' + richItem(x, 'gain') + '）' : ''); }));
      html += section('效果保障', list(r.effect_items, function (x) { return richItem(x, 'act') + (x.target ? '（' + richItem(x, 'target') + '）' : ''); }));
      html += section('下周必须完成', nextCell(r));
    }
    var coords = (r.coord_items || []).filter(function (x) {
      return x && [x.who, x.what, x.by].some(function (value) { return String(value || '').trim(); });
    });
    html += section('需要协调', list(coords, function (x) { return esc(x.who || '未指定') + '：' + richItem(x, 'what') + reportItemSourceHtml(r,x) + ' · 最晚 ' + esc(sd(x.by)); }) || richItem(r, 'coord'));
    if (window.ReporterTasks) html += window.ReporterTasks.snapshotHtml(r);
    if (window.CompletionReview) html += window.CompletionReview.snapshotsHtml(r);
    if (window.ReportAttachments) html += window.ReportAttachments.snapshotHtml(r, {linksOnly:!!(options && options.reference)});
    return html;
  }
  function reportHistoryHtml(r) {
    var versions = (Array.isArray(r.history) ? r.history : []).filter(function (entry) { return entry && entry.data; });
    var html = '<p class="hint">每次重新提交会保存修改前的版本；下方按最新到最早排列。已保存的历史版本只读。</p>'
      + '<details class="revision" open><summary>当前版本</summary>' + reportSnapshotHtml(r) + '</details>';
    for (var i = versions.length - 1; i >= 0; i--) {
      var version = versions[i], author = S.members.filter(function (member) { return member.user_id === version.by; })[0];
      html += '<details class="revision"><summary>历史版本 ' + (i + 1) + (i === 0 ? ' · 最早留存内容' : '') + '</summary>'
        + '<div class="hint">替换时间：' + esc(fmtTime(version.at)) + ' · 修改人：' + esc(author ? author.name : version.by || '—') + '</div>'
        + reportSnapshotHtml(version.data) + '</details>';
    }
    return html;
  }

  function viewPMHistory() {
    var pid = S.pmProject;
    var com = isCom(pid);
    var mine = pmHistoryReports()
      .sort(function (a, b) { return (weekNo(b.period) || 0) - (weekNo(a.period) || 0); });
    if (!mine.length) return '<div class="card"><div class="empty">本项目还没有提交记录。</div></div>';

    /* 商业项目：按模块看历史，列的是商业那五块的实际内容 */
    if (com) {
      var crows = mine.map(function (r) {
        var st = itemStat(r), nd = nodesOf(r), hd = handoverOf(r);
        var co = (r.coord_items || []).filter(function (x) { return x.who || x.what; });
        return '<tr><td><b>' + esc(r.period) + '</b>' + reportHistoryButton(r) + '</td>'
          + '<td>' + esc(r.line || LINE_ALL) + '<div class="muted" style="margin-top:3px">' + esc(r.author_name || '') + '</div></td>'
          + '<td>' + badge(r.status) + '</td>'
          + '<td>' + (nd.length ? nd.map(function (x) { return '· ' + richItem(x, 'name') + (x.plan ? '（' + esc(sd(x.plan)) + '）' : ''); }).join('<br>') : '<span class="muted">—</span>') + '</td>'
          + '<td>' + (st.total ? st.total + ' 项' + (st.overdue ? '<div class="red" style="margin-top:3px">已过完成时间 ' + st.overdue + ' 项</div>' : '') : '<span class="muted">—</span>') + '</td>'
          + '<td>' + (co.length ? co.map(function (x) { return esc(x.who || '未指定'); }).join('、') : '<span class="muted">—</span>') + '</td>'
          + '<td>' + (hd.length ? hd.map(function (x) { return '· ' + richItem(x, 'what') + (x.to ? ' → ' + esc(x.to) : ''); }).join('<br>') : '<span class="muted">—</span>') + '</td>'
          + '<td class="muted">' + esc(fmtTime(r.submitted_at)) + '</td></tr>';
      }).join('');
      return '<div class="card"><div class="cardhd"><h2 style="margin:0">历史直报 · ' + esc(projName(pid)) + ' <span class="chip biz">商业</span></h2>'
        + '<span class="hint" style="margin:0">共 ' + mine.length + ' 期 · 按模块展示已保存内容</span></div>'
        + '<div class="tablewrap"><table><thead><tr><th style="width:9%">周期</th><th style="width:11%">模块</th>'
        + '<th style="width:6%">状态</th><th style="width:20%">本月核心节点</th><th style="width:11%">当月计划事项</th>'
        + '<th style="width:10%">需要协调</th><th style="width:20%">工作面移交</th><th style="width:8%">提交时间</th></tr></thead>'
        + '<tbody>' + crows + '</tbody></table></div></div>';
    }

    return '<div class="card"><div class="cardhd"><h2 style="margin:0">历史直报 · ' + esc(projName(pid)) + '</h2>'
      + '<span class="hint" style="margin:0">共 ' + mine.length + ' 期 · 重新提交会保留修改前版本</span></div>'
      + '<div class="tablewrap"><table><thead><tr><th style="width:9%">周期</th><th style="width:6%">状态</th>'
      + '<th style="width:10%">提交时双维记录</th><th style="width:15%">本周变化</th><th style="width:16%">风险 / 偏差与影响</th>'
      + '<th style="width:14%">下周必须完成</th><th style="width:15%">对策（快 / 好）</th><th style="width:8%">协调对象</th><th style="width:7%">提交时间</th></tr></thead><tbody>'
      + mine.map(function (r) {
          var sp = (r.speed_items || []).filter(function (x) { return x.act; });
          var ef = (r.effect_items || []).filter(function (x) { return x.act; });
          var co = (r.coord_items || []).filter(function (x) { return x.who || x.what; });
          return '<tr><td><b>' + esc(r.period) + '</b>' + reportHistoryButton(r) + '</td>'
            + '<td>' + badge(r.status) + '</td>'
            + '<td>' + speedPill(r.self_speed) + '<br>' + effectPill(r.self_effect) + '</td>'
            + '<td>' + richItem(r, 'change_text', r.change_text || '—') + '</td>'
            + '<td>' + riskCell(r) + '</td>'
            + '<td>' + nextCell(r) + '</td>'
            + '<td>' + (sp.length ? '<b>快：</b>' + sp.map(function (x) { return richItem(x, 'act'); }).join('；') + '<br>' : '')
            + (ef.length ? '<b>好：</b>' + ef.map(function (x) { return richItem(x, 'act'); }).join('；') : (sp.length ? '' : '—')) + '</td>'
            + '<td>' + (co.length ? co.map(function (x) { return esc(x.who || '—'); }).join('、') : '—') + '</td>'
            + '<td class="muted">' + esc(fmtTime(r.submitted_at)) + '</td></tr>';
        }).join('')
      + '</tbody></table></div></div>';
  }

  /* ================= 运营 / 总裁端 ================= */

  function filteredProjects() {
    var f = S.filters;
    return S.projects.filter(function (p) {
      /* 汇总口径：住宅汇总只看住宅，商业汇总只看商业（总裁浏览版不受此限） */
      if (S.ptype && ptype(p.id) !== S.ptype) return false;
      if (f.project && p.id !== f.project) return false;
      var st = statusOf(p.id);
      if (f.status && st !== f.status) return false;
      if (f.impact) {
        var lr = latestReport(p.id);
        if ((lr ? (lr.impact || NO_IMPACT) : NO_IMPACT) !== f.impact) return false;
      }
      return true;
    });
  }
  function allCoord() {
    var out = [];
    S.reports.forEach(function (r) {
      if (!reportInPeriod(r,currentPeriod())) return;
      (r.coord_items || []).forEach(function (c) {
        if (c && (c.who || c.what)) out.push(richDisplayCopy(c, { pid: reportItemProjectId(r,c), who: c.who || '未指定', what: c.what || '', by: c.by || '', period: r.period }));
      });
      if ((!r.coord_items || !r.coord_items.length) && r.coord && r.coord !== '无') {
        out.push(richDisplayCopy(r, { pid: reportItemProjectId(r,null), who: '未指定', what: r.coord, by: '', period: r.period }, { what: 'coord' }));
      }
      /* 商业项目：把「工作面移交事项」也提到协调总表，周例会上一并看 */
      handoverOf(r).forEach(function (x) {
        if (x && (x.what || '').trim()) {
          out.push({ pid: reportItemProjectId(r,x), who: (x.to || '').trim() || '（' + (r.line || '综合') + '）未指定接收方',
            what: '工作面移交：' + x.what.trim(), whatHtml: '工作面移交：' + richItem(x, 'what'), by: x.due || '', period: r.period });
        }
      });
      /* 商业项目：已过完成时间的事项，提示需要推动 */
      itemsOf(r).forEach(function (x) {
        if (x && (x.name || '').trim() && itemOverdue(x)) {
          out.push({ pid: reportItemProjectId(r,x), who: '（' + (r.line || '综合') + '）本模块推动',
            what: '已过完成时间：' + x.name.trim() + (x.prog ? '（' + x.prog.trim() + '）' : ''),
            whatHtml: '已过完成时间：' + richItem(x, 'name') + (x.prog ? '（' + richItem(x, 'prog') + '）' : ''), by: x.due || '', period: r.period });
        }
      });
    });
    return out;
  }

  /* 风险 / 偏差与影响：正文 + 影响类型 + 影响量级
     （影响量级 projection 此前只在个别视图出现，导致「填了看不到」） */
  function riskCell(r) {
    if (!r) return '<span class="muted">—</span>';
    var html = richItem(r, 'dev_text', r.dev_text || '—');
    if (r.impact && r.impact !== NO_IMPACT) html += '<br><span class="chip">' + esc(r.impact) + '</span>';
    if (r.projection) html += '<div class="muted" style="margin-top:4px">量级：' + richItem(r, 'projection') + '</div>';
    return html;
  }

  /* 下周必须完成：本期填报的核心承诺，原先写入数据库后从未在界面展示 */
  function nextCell(r) {
    if (!r) return '<span class="muted">尚未填报</span>';
    var nx = (r.next_items || []).map(function (text, index) { return { text: text, index: index }; }).filter(function (item) { return !!item.text; });
    if (!nx.length) return '<span class="muted">未填写</span>';
    return nx.map(function (item, i) { return '<div style="margin-bottom:4px">' + (i + 1) + '. ' + richItem(r, 'next_items.' + item.index, item.text) + '</div>'; }).join('');
  }

  /* 上周承诺 → 本期兑现对照：只把两栏并排放好供周例会核对，不做自动判定 */
  function promiseCard() {
    var curW = weekNo(currentPeriod());
    var items = [];
    /* 只对照本次汇总口径内的项目（住宅汇总不掺商业项目） */
    detailProjects().filter(function (p) { return ptype(p.id) === S.ptype; }).forEach(function (p) {
      var prev = S.reports.filter(function (r) { return r.project_id === p.id && (weekNo(r.period) || 0) < curW; })
        .sort(function (a, b) { return (weekNo(b.period) || 0) - (weekNo(a.period) || 0); })[0];
      if (!prev || !(prev.next_items || []).filter(Boolean).length) return;
      var cur = S.reports.filter(function (r) { return r.project_id === p.id && weekNo(r.period) === curW; })[0] || null;
      items.push({ p: p, prev: prev, cur: cur });
    });
    if (!items.length) return '';
    var rows = items.map(function (x) {
      return '<tr>'
        + '<td><b>' + esc(x.p.name) + '</b><div class="muted" style="margin-top:3px">' + esc(x.prev.period) + '</div></td>'
        + '<td>' + nextCell(x.prev) + '</td>'
        + '<td>' + (x.cur ? richItem(x.cur, 'change_text', x.cur.change_text || '—') : '<span class="muted">本期尚未填报</span>') + '</td>'
        + '</tr>';
    }).join('');
    return '<div class="card"><div class="cardhd"><h3 style="margin:0">上周承诺 → 本期兑现对照</h3>'
      + '<span class="hint" style="margin:0">左栏为各项目上期填写的「下周必须完成」，请对照本期「实质变化」核对兑现情况</span></div>'
      + '<div class="tablewrap"><table><thead><tr>'
      + '<th style="width:16%">项目 / 期次</th><th style="width:36%">上期承诺</th><th>本期实质变化</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }

  function viewBoard() {
    /* 汇总口径：res=住宅汇总 / com=商业汇总（由左侧导航切换），两套 KPI 与表头 */
    var com = S.ptype === 'com';
    var all = S.projects.filter(function (p) { return (ptype(p.id) === 'com') === com; });
    var co = allCoord().filter(function (x) { return isCom(x.pid) === com; }).length;

    var list = filteredProjects().slice().sort(function (x, y) {
      if (com) return all.indexOf(x) - all.indexOf(y);   /* 商业按项目排序位固定，不跳位 */
      var dx = nextKey(x.id) ? dayDiff(nextKey(x.id).forecast_date, nextKey(x.id).plan_date) : -999;
      var dy = nextKey(y.id) ? dayDiff(nextKey(y.id).forecast_date, nextKey(y.id).plan_date) : -999;
      return dy - dx;
    });
    var projOpts = all.map(function (p) {
      return '<option value="' + esc(p.id) + '" ' + (S.filters.project === p.id ? 'selected' : '') + '>' + esc(p.name) + '</option>';
    }).join('');

    var cards, filters, thead;
    if (com) {
      var totItems = 0, overdueN = 0, handN = 0, unready = 0, openDays = all.length ? daysToOpen(all[0].id) : null;
      all.forEach(function (p) {
        var cs = comSummary(p.id);
        totItems += cs.items.length; overdueN += cs.overdue.length; handN += cs.hand.length;
        if (cs.st.missing.length) unready++;
      });
      cards = '<div class="stat s-blue"><div class="muted">商业项目</div><div class="n">' + all.length + '</div></div>'
        + '<div class="stat"><div class="muted">距正式开业（天）</div><div class="n">' + (openDays !== null ? openDays : '—') + '</div></div>'
        + '<div class="stat s-amber"><div class="muted">模块填报未齐的项目</div><div class="n amber">' + unready + '</div></div>'
        + '<div class="stat"><div class="muted">当月计划事项</div><div class="n">' + totItems + '</div></div>'
        + '<div class="stat s-red"><div class="muted">已过完成时间</div><div class="n red">' + overdueN + '</div></div>'
        + '<div class="stat"><div class="muted">待协调 / 工作面移交</div><div class="n">' + (co + handN) + '</div></div>';
      filters = '<div><label>项目</label><select onchange="App.filter(\'project\',this.value)"><option value="">全部商业项目</option>' + projOpts + '</select></div>'
        + '<div><label>状态</label><select onchange="App.filter(\'status\',this.value)">'
        + ['', '正常', '关注', '异常', '未填报'].map(function (s) { return '<option value="' + s + '" ' + (S.filters.status === s ? 'selected' : '') + '>' + (s || '全部状态') + '</option>'; }).join('')
        + '</select></div>';
      thead = '<th style="width:11%">项目 / 模块进度</th><th style="width:15%">本月核心节点</th><th style="width:6%">状态</th><th style="width:7%">开业倒计时</th>'
        + '<th style="width:13%">当月计划事项</th><th style="width:15%">已过完成时间的事项</th><th style="width:13%">工作面移交</th><th style="width:9%">协调对象</th><th style="width:7%">本期</th>';
    } else {
      var ab = all.filter(function (p) { return statusOf(p.id) === '异常'; }).length;
      var at = all.filter(function (p) { return statusOf(p.id) === '关注'; }).length;
      var nf = all.filter(function (p) { return !submittedThisWeek(p.id); }).length;
      var dueSoon = 0;
      all.forEach(function (p) {
        msOf(p.id).forEach(function (m) {
          if (!m.done && m.is_key && m.plan_date && m.plan_date >= todayISO() && m.plan_date <= addDays(todayISO(), 30)) dueSoon++;
        });
      });
      cards = '<div class="stat s-blue"><div class="muted">住宅项目</div><div class="n">' + all.length + '</div></div>'
        + '<div class="stat s-red"><div class="muted">异常</div><div class="n red">' + ab + '</div></div>'
        + '<div class="stat s-amber"><div class="muted">需关注</div><div class="n amber">' + at + '</div></div>'
        + '<div class="stat"><div class="muted">本期未填报</div><div class="n">' + nf + '</div></div>'
        + '<div class="stat"><div class="muted">协调与支持需求</div><div class="n">' + co + '</div></div>'
        + '<div class="stat"><div class="muted">30 天内到期关键节点</div><div class="n">' + dueSoon + '</div></div>';
      filters = '<div><label>项目</label><select onchange="App.filter(\'project\',this.value)"><option value="">全部住宅项目</option>' + projOpts + '</select></div>'
        + '<div><label>状态</label><select onchange="App.filter(\'status\',this.value)">'
        + ['', '正常', '关注', '异常', '未填报'].map(function (s) { return '<option value="' + s + '" ' + (S.filters.status === s ? 'selected' : '') + '>' + (s || '全部状态') + '</option>'; }).join('')
        + '</select></div>'
        + '<div><label>经营影响</label><select onchange="App.filter(\'impact\',this.value)">'
        + ['', NO_IMPACT].concat(IMPACTS.slice(1)).map(function (s) { return '<option value="' + esc(s) + '" ' + (S.filters.impact === s ? 'selected' : '') + '>' + (s || '全部影响类型') + '</option>'; }).join('')
        + '</select></div>';
      thead = '<th style="width:11%">项目 / 项目经理</th><th style="width:16%">本期研判节点（项目经理自选）</th><th style="width:6%">状态</th><th style="width:7%">经营双维</th>'
        + '<th style="width:14%">本周变化</th><th style="width:16%">风险 / 偏差与影响</th><th style="width:14%">下周必须完成</th><th style="width:9%">协调对象</th><th style="width:7%">本期</th>';
    }

    return '<div class="cards">' + cards + '</div>'

      + '<div class="card"><div class="filters">' + filters
      + '<div class="no-print actions"><button class="btn ghost" onclick="App.exportBoard()">导出 Excel</button>'
      + '<button class="btn ghost" onclick="App.printPage()">打印 / PDF</button>'
      + '<button class="btn ghost" onclick="App.clearFilter()">重置筛选</button></div></div></div>'

      + (com ? '' : promiseCard())

      + '<div class="card pad0"><div class="tablewrap"><table><thead><tr>'
      + thead
      + '</tr></thead><tbody>'
      + (list.length ? list.map(function (p) {
          var r = latestReport(p.id);
          var coNames = r && (r.coord_items || []).length ? (r.coord_items || []).filter(function (c) { return c.who; }).map(function (c) { return esc(c.who); }).join('、') : (r && r.coord && r.coord !== '无' ? '见详情' : '—');
          /* 商业项目：一行显示各模块聚合后的概览（距开业 + 本月核心节点 + 当月事项） */
          if (isCom(p.id)) {
            var cs = comSummary(p.id), dOpen = daysToOpen(p.id);
            var nodeTxt = cs.nodes.length
              ? listBrief(cs.nodes, function (o) {
                  return esc(o.line) + '｜' + richItem(o.x, 'name') + (o.x.plan ? '<span class="muted">（' + esc(sd(o.x.plan)) + '）</span>' : '');
                }, 3)
              : '<span class="muted">本期尚无核心节点</span>';
            var coordTxt = cs.coords.length
              ? cs.coords.slice(0, 3).map(function (c) { return esc(c.who || '未指定'); }).join('、') + (cs.coords.length > 3 ? ' 等 ' + cs.coords.length + ' 项' : '')
              : '—';
            var handTxt = cs.hand.length
              ? listBrief(cs.hand, function (o) { return esc(o.line) + '｜' + richItem(o.x, 'what') + (o.x.to ? ' → ' + esc(o.x.to) : ''); }, 2)
              : '<span class="muted">—</span>';
            return '<tr>'
              + '<td><b>' + esc(p.name) + '</b> <span class="chip biz">商业</span>' + projectDetailButton(p.id)
              + '<div class="muted" style="margin-top:4px">' + (dOpen !== null ? '距开业 ' + dOpen + ' 天' : '开业目标未设') + ' · 模块 ' + cs.st.reported + '/' + cs.st.total + '</div></td>'
              + '<td>' + nodeTxt + '</td>'
              + '<td>' + badge(statusOf(p.id)) + '</td>'
              + '<td>' + '<span class="muted">商业：倒计时</span><br>' + (dOpen !== null ? (dOpen >= 0 ? dOpen + ' 天' : '已过 ' + Math.abs(dOpen) + ' 天') : '—') + '</td>'
              + '<td>' + (cs.items.length
                ? '当月事项 ' + cs.items.length + ' 项' + (cs.overdue.length ? ' <b class="red">已过完成时间 ' + cs.overdue.length + '</b>' : '')
                : '<span class="muted">尚未填报</span>') + '</td>'
              + '<td>' + listBrief(cs.overdue, function (o) {
                  return esc(o.line) + '｜' + richItem(o.x, 'name') + '<span class="muted">（' + esc(sd(o.x.due)) + '）</span>';
                }, 3) + '</td>'
              + '<td>' + handTxt + '</td>'
              + '<td>' + coordTxt + '</td>'
              + '<td>' + (cs.st.missing.length ? '<span class="badge yellow">未报 ' + cs.st.missing.length + ' 模块</span>' : '<span class="badge green">已报齐</span>') + '</td>'
              + '</tr>';
          }
          return '<tr>'
            + '<td><b>' + esc(p.name) + '</b>' + projectDetailButton(p.id) + '<div class="muted" style="margin-top:4px">' + esc(pmOf(p.id)) + '</div></td>'
            + '<td>' + pickedCell(r, p.id) + '</td>'
            + '<td>' + badge(statusOf(p.id)) + '</td>'
            + '<td>' + speedPill(dualAssessment(p.id).speed) + '<br>' + effectPill(dualAssessment(p.id).effect) + '</td>'
            + '<td>' + (r ? richItem(r, 'change_text') : '<span class="muted">尚未填报</span>') + '</td>'
            + '<td>' + riskCell(r) + '</td>'
            + '<td>' + nextCell(r) + '</td>'
            + '<td>' + coNames + '</td>'
            + '<td>' + (submittedThisWeek(p.id) ? '<span class="badge green">已填报</span>' : '<span class="badge yellow">未填报</span>') + '</td>'
            + '</tr>';
        }).join('') : '<tr><td colspan="9" class="empty">没有符合筛选条件的项目。</td></tr>')
      + '</tbody></table></div></div>';
  }

  /* ============ 领导评价与交代 ============
     leader_reviews：总裁评价（kind=ceo，速度/效果/评语）与项目总评价（kind=pzo，评级/评语）
     leader_notes：总裁交代（kind=ceo_brief）与项目总批示（kind=pzo_note），按项目×周期存行 */

  function reviewOf(pid, kind) {
    var per = currentPeriod();
    return (S.reviews || []).filter(function (r) {
      return r.project_id === pid && r.kind === kind && r.period === per;
    })[0] || null;
  }
  function dualAssessment(pid) {
    var review = reviewOf(pid, 'ceo');
    return {
      speed: (review && review.speed) || suggestSpeed(pid),
      effect: (review && review.effect) || NO_EFFECT
    };
  }
  function briefsOf(pid, kind) {
    var per = currentPeriod();
    return (S.leaderNotes || []).filter(function (n) {
      return n.project_id === pid && n.kind === kind && n.period === per;
    });
  }
  function leaderMeta(rv) {
    return '<span class="muted">评价人：' + esc(rv.author_name || '—') + (rv.author_role ? '（' + esc(rv.author_role) + '）' : '')
      + ' · ' + esc(fmtTime(rv.updated_at || rv.created_at)) + '</span>';
  }
  function briefDraftKey(pid, kind) { return S.uid + ':' + currentPeriod() + ':' + pid + ':' + kind; }
  function briefDraftRows(pid, kind) {
    var key = briefDraftKey(pid, kind);
    if (!S.briefDrafts[key]) S.briefDrafts[key] = briefsOf(pid, kind).map(function (n) {
      return richCopy(n,{ id:n.id, what: n.what, due: n.due || '' });
    });
    return S.briefDrafts[key];
  }
  function captureBriefDrafts() {
    if(window.ZHRichEditor) window.ZHRichEditor.flush();
    S.projects.forEach(function (p) {
      ['ceo_brief', 'pzo_note'].forEach(function (kind) {
        var rows = S.briefDrafts[briefDraftKey(p.id, kind)];
        var pfx = kind === 'ceo_brief' ? 'cb' : 'pz';
        (rows || []).forEach(function (row, i) {
          row.what = valIf(pfx + 'w_' + p.id + '_' + i, row.what);
          row.due = valIf(pfx + 'd_' + p.id + '_' + i, row.due);
        });
      });
    });
  }
  function editBriefRow(pid, kind, removeIndex) {
    var rows = briefDraftRows(pid, kind);
    captureBriefDrafts();
    if (removeIndex === undefined) rows.push({ what: '', due: '' });
    else rows.splice(removeIndex, 1);
    renderShell(true);
  }
  async function saveBriefDraft(pid, kind) {
    var rows = briefDraftRows(pid, kind);
    captureBriefDrafts();
    rows = rows.filter(function (row) { return String(row.what || '').trim(); });
    var result = await replaceLeaderNotes(pid, currentPeriod(), kind, rows);
    if (result.error) return toast('保存失败：' + (result.error.message || ''), 'err');
    delete S.briefDrafts[briefDraftKey(pid, kind)];
    toast((kind === 'ceo_brief' ? '总裁交代' : '项目总批示') + '已保存：本期 ' + rows.length + ' 条');
    await reloadLeader();
  }

  /* 评价与交代保存后并行刷新对应快照，不重读无关页面。 */
  async function reloadLeader(savedReviewKey) {
    await loadData(['reviews', 'leaderNotes'], true);
    if (!dataState.reviews.error && savedReviewKey && S.reviewRichDrafts) delete S.reviewRichDrafts[savedReviewKey];
    renderShell(true);
  }
  async function replaceLeaderNotes(pid, period, kind, items) {
    try {
      var response = await fetch('/api/leader-notes/replace', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: pid, period: period, kind: kind, items: items.map(function(row){return richCollect(row);}) })
      });
      var result = await response.json();
      if (!response.ok && !result.error) return { error: { message: '保存失败（HTTP ' + response.status + '）' } };
      return result;
    } catch (e) {
      return { error: { message: '无法连接服务器，请检查网络后重试。' } };
    }
  }

  /* 总裁交代 / 项目总批示行：已存在行 + 本地新增空行；输入按 id 在保存时统一读取 */
  function briefRowsHtml(pid, kind, editable, includeRow) {
    var isCeo = kind === 'ceo_brief';
    var list = editable ? briefDraftRows(pid, kind) : briefsOf(pid, kind);
    var pfx = isCeo ? 'cb' : 'pz';
    var rows = [];
    list.forEach(function (n, i) {
      if (includeRow && !includeRow(n)) return;
      rows.push(richDisplayCopy(n, { id: n.id, what: n.what, due: n.due || '', rowIndex: i, inId: pfx + 'w_' + pid + '_' + i, dueId: pfx + 'd_' + pid + '_' + i }));
    });
    if (!rows.length) return '<div class="empty">暂无内容。</div>';
    return '<div class="tablewrap"><table><thead><tr>'
      + '<th style="width:64%">' + (isCeo ? '本周需关注的工作' : '批示内容') + '</th>'
      + '<th style="width:24%">' + (isCeo ? '最晚时间（可空）' : '最晚时间（可空）') + '</th><th style="width:60px"></th>'
      + '</tr></thead><tbody>'
      + rows.map(function (r, i) {
          if (!editable) return '<tr><td>' + richItem(r, 'what') + '</td><td>' + esc(r.due || '—') + '</td><td></td></tr>';
          return '<tr><td><input id="' + r.inId + '" data-rich value="' + esc(r.what) + '" placeholder="' + (isCeo ? '例：消防验收提前与消防部门对接' : '例：招商节奏按周盯') + '"></td>'
            + '<td><input type="date" id="' + r.dueId + '" value="' + esc(r.due) + '" aria-label="最晚时间"></td>'
            + '<td><button class="btn ghost sm" onclick="App.' + (isCeo ? 'delCeoBriefRow' : 'delPzoNoteRow') + '(\'' + esc(pid) + '\',' + r.rowIndex + ')">×</button></td></tr>';
        }).join('')
      + '</tbody></table></div>';
  }

  /* 总裁评价块：总裁可写，其他人只读 */
  function ceoReviewHtml(pid) {
    var rv = reviewOf(pid, 'ceo');
    if (!canWriteCeo()) {
      if (!rv) return '<div class="empty">总裁本期尚未评价。</div>';
      return '<div class="mini"><div><span>速度</span><b>' + esc(rv.speed || '—') + '</b></div>'
        + '<div><span>效果</span><b>' + esc(rv.effect || '—') + '</b></div>'
        + (rv.note ? '<div><span>评语</span><b>' + richItem(rv, 'note') + '</b></div>' : '')
        + '</div>' + '<div class="hint" style="margin-top:8px">' + leaderMeta(rv) + '</div>';
    }
    var reviewDraft = S.reviewRichDrafts && S.reviewRichDrafts['ceo:'+pid];
    var sp = (rv && rv.speed) || '', ef = (rv && rv.effect) || '', note = reviewDraft ? reviewDraft.note : (rv && rv.note) || '';
    /* 2026-10-14：横向布局——速度/效果并排一行，评语与保存按钮同行，压缩纵向高度 */
    return '<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center">'
      + '<div style="display:flex;align-items:center;gap:8px"><span class="muted" style="font-size:12.5px">速度</span>'
      + '<div class="statuspick">' + SPEED.map(function (s) {
          return '<label><input type="radio" name="ceosp_' + esc(pid) + '" value="' + s + '"' + (sp === s ? ' checked' : '') + '><span>' + s + '</span></label>';
        }).join('') + '</div></div>'
      + '<div style="display:flex;align-items:center;gap:8px"><span class="muted" style="font-size:12.5px">效果</span>'
      + '<div class="statuspick">' + EFFECT.map(function (s) {
          return '<label><input type="radio" name="ceoef_' + esc(pid) + '" value="' + s + '"' + (ef === s ? ' checked' : '') + '><span>' + s + '</span></label>';
        }).join('') + '</div></div>'
      + '</div>'
      + '<div style="display:flex;gap:10px;align-items:flex-start;margin-top:10px;flex-wrap:wrap">'
      + '<textarea id="ceonote_' + esc(pid) + '" data-rich style="flex:1;min-width:220px;width:auto;min-height:56px" placeholder="评语（可空）：对项目本期的一句话判断或要求">' + esc(note) + '</textarea>'
      + '<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-start">'
      + '<button class="btn primary sm" onclick="App.saveCeoReview(\'' + esc(pid) + '\')">保存总裁评价</button>'
      + (rv ? '<span class="hint" style="margin:0">' + leaderMeta(rv) + '</span>' : '')
      + '</div></div>';
  }

  /* 项目总评价块：项目总可写，其他人只读（商业项目） */
  var PZO_RATINGS = ['好', '中', '需改进'];
  function pzoReviewHtml(pid) {
    var rv = reviewOf(pid, 'pzo');
    if (!canWritePzo()) {
      if (!rv) return '<div class="empty">项目总本期尚未评价。</div>';
      return '<div class="mini"><div><span>评级</span><b>' + esc(rv.rating || '—') + '</b></div>'
        + (rv.note ? '<div><span>评语</span><b>' + richItem(rv, 'note') + '</b></div>' : '')
        + '</div>' + '<div class="hint" style="margin-top:8px">' + leaderMeta(rv) + '</div>';
    }
    var reviewDraft = S.reviewRichDrafts && S.reviewRichDrafts['pzo:'+pid];
    var rt = (rv && rv.rating) || '', note = reviewDraft ? reviewDraft.note : (rv && rv.note) || '';
    /* 2026-10-14：横向布局，与总裁评价一致 */
    return '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="muted" style="font-size:12.5px">评级</span>'
      + '<div class="statuspick">' + PZO_RATINGS.map(function (s) {
          return '<label><input type="radio" name="pzor_' + esc(pid) + '" value="' + s + '"' + (rt === s ? ' checked' : '') + '><span>' + s + '</span></label>';
        }).join('') + '</div></div>'
      + '<div style="display:flex;gap:10px;align-items:flex-start;margin-top:10px;flex-wrap:wrap">'
      + '<textarea id="pzonote_' + esc(pid) + '" data-rich style="flex:1;min-width:220px;width:auto;min-height:56px" placeholder="评语（可空）">' + esc(note) + '</textarea>'
      + '<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-start">'
      + '<button class="btn primary sm" onclick="App.savePzoReview(\'' + esc(pid) + '\')">保存项目总评价</button>'
      + (rv ? '<span class="hint" style="margin:0">' + leaderMeta(rv) + '</span>' : '')
      + '</div></div>';
  }

  /* 交代/批示区（含操作行），editable 决定是否出现「增加/保存」按钮 */
  function briefSectionInner(pid, kind, editable) {
    var isCeo = kind === 'ceo_brief';
    var title = isCeo ? '总裁交代 · 本周需关注的工作' : '项目总批示';
    var list = briefsOf(pid, kind);
    var head = '<h4 class="subh">' + title + '<span class="chip">' + list.length + ' 条</span></h4>';
    var ops = editable
      ? '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
        + '<button class="btn ghost sm" onclick="App.' + (isCeo ? 'addCeoBrief' : 'addPzoNote') + '(\'' + esc(pid) + '\')">＋ 增加一条</button>'
        + '<button class="btn primary sm" onclick="App.' + (isCeo ? 'saveCeoBriefs' : 'savePzoNotes') + '(\'' + esc(pid) + '\')">保存</button>'
        + '</div>'
      : '';
    return head + briefRowsHtml(pid, kind, editable) + ops
      + (editable ? '<div class="hint" style="margin-top:9px">增删与修改在点击保存后一起生效，项目经理可在个人中心查看。</div>' : '');
  }
  function leaderBriefSection(pid, kind, editable) {
    return '<div class="card">' + briefSectionInner(pid, kind, editable) + '</div>';
  }

  /* PM 个人中心的「总裁交代」只读卡：住宅另显示总裁评价，商业另显示项目总评价 + 项目总安排 */
  function leaderPmCard(pid, isRes) {
    var requirements=window.ReporterTasks && window.ReporterTasks.requirementsHtml?window.ReporterTasks.requirementsHtml(pid):'';
    var parts=[];
    var rv = isRes ? reviewOf(pid, 'ceo') : reviewOf(pid, 'pzo');
    if (rv) {
      parts.push(isRes
        ? '<h4 class="subh">总裁评价</h4><div class="mini"><div><span>速度</span><b>' + esc(rv.speed || '—') + '</b></div>'
          + '<div><span>效果</span><b>' + esc(rv.effect || '—') + '</b></div>'
          + (rv.note ? '<div><span>评语</span><b>' + richItem(rv, 'note') + '</b></div>' : '') + '</div>'
        : '<h4 class="subh">项目总评价</h4><div class="mini"><div><span>评级</span><b>' + esc(rv.rating || '—') + '</b></div>'
          + (rv.note ? '<div><span>评语</span><b>' + richItem(rv, 'note') + '</b></div>' : '') + '</div>');
    }
    return (parts.length?'<div class="card">'+parts.join('')+'</div>':'');
  }

  /* ============ 报总裁浏览版 ============ */

  function coordBrief(r) {
    var co = ((r && r.coord_items) || []).filter(function (c) { return c && (c.who || c.what); });
    if (!co.length) return '<span class="muted">本期无需协调</span>';
    return co.map(function (c) {
      return '· ' + esc(c.who || '未指定') + '：' + richItem(c, 'what') + (c.by ? '<span class="muted">（最晚 ' + esc(c.by) + '）</span>' : '');
    }).join('<br>');
  }
  function decisionItems() {
    var top = {};
    /* 兼容 level / org_level 两种字段名，避免决策层识别失效导致「需总裁决策」漏报 */
    (S.orgList || []).forEach(function (o) {
      var lvl = (o.level != null ? o.level : o.org_level);
      if (Number(lvl) === 1) top[o.name] = true;
    });
    var out = [];
    S.reports.forEach(function (r) {
      if (weekNo(r.period) !== weekNo(currentPeriod())) return;
      var co = (r.coord_items || []).filter(function (c) { return c && (c.who || c.what); });
      co.forEach(function (c) {
        out.push(richDisplayCopy(c, { pid: r.project_id, who: c.who || '未指定', what: c.what || '', by: c.by || '', top: !!top[c.who] }));
      });
      if (!co.length && r.coord && r.coord !== '无') {
        out.push(richDisplayCopy(r, { pid: r.project_id, who: '未指定', what: r.coord, by: '', top: false }, { what: 'coord' }));
      }
      /* 商业项目：事项级需协调事项（自由文本，不计入「决策层」判定） */
      itemsOf(r).forEach(function (x) {
        if (x && (x.coord || '').trim()) {
          out.push({ pid: r.project_id, who: '（' + (r.line || '综合') + '）未指定对象',
            what: x.name + '：' + x.coord.trim(), whatHtml: richItem(x, 'name') + '：' + richItem(x, 'coord'), by: x.plan || '', top: false });
        }
      });
    });
    return out.sort(function (a, b) { return (b.top ? 1 : 0) - (a.top ? 1 : 0); });
  }

  /* 商业项目领导卡（2026-10-15 抽取共用）：报总裁浏览版「商业项目一览」与报项目总浏览版同口径。
     多专业提报汇总 + 开业倒计时 + 项目总评价/批示（仅项目总可写）+ 总裁交代（总裁/运营可写） */
  function bizLeaderCard(p) {
    function fact(k, v) { return '<div class="pfact"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }
    var cs = comSummary(p.id), meta = comMeta(p.id), dOpen = daysToOpen(p.id);
    var nodeTxt = cs.nodes.length
      ? listBrief(cs.nodes, function (o) {
          return esc(o.line) + '｜' + richItem(o.x, 'name') + (o.x.plan ? '<span class="muted">（' + esc(sd(o.x.plan)) + '）</span>' : '')
            + (o.x.prog ? '<br><span class="muted">进展：' + richItem(o.x, 'prog') + '</span>' : '');
        }, 4)
      : '<span class="muted">本期未填写核心节点</span>';
    var itemTxt = cs.items.length
      ? '当月事项 ' + cs.items.length + ' 项' + (cs.overdue.length ? '，<b class="red">已过完成时间 ' + cs.overdue.length + ' 项</b>' : '')
        + '<br>' + cs.overdue.slice(0, 3).map(function (o) {
            return '<span class="muted">· ' + esc(o.line) + '｜' + richItem(o.x, 'name') + (o.x.due ? '（' + esc(sd(o.x.due)) + '）' : '') + '</span>';
          }).join('<br>')
      : '<span class="muted">本期尚无计划事项</span>';
    var handTxt = cs.hand.length
      ? listBrief(cs.hand, function (o) {
          return esc(o.line) + '｜' + richItem(o.x, 'what') + (o.x.to ? ' → ' + esc(o.x.to) : '') + (o.x.due ? '<span class="muted">（' + esc(sd(o.x.due)) + '）</span>' : '');
        }, 3)
      : '<span class="muted">—</span>';
    var coordTxt = cs.coords.length
      ? cs.coords.slice(0, 4).map(function (c) { return esc(c.who) + '：' + richItem(c, 'what') + (c.by ? '（' + esc(c.by) + '）' : ''); }).join('；')
        + (cs.coords.length > 4 ? ' 等 ' + cs.coords.length + ' 项' : '')
      : '<span class="muted">—</span>';

    return '<div class="pcard biz" style="margin-bottom:16px">'
      + '<div class="phd"><div><b>' + esc(p.name) + '</b> <span class="chip biz">商业</span>'
      + '<div class="sub">' + esc(meta.open_date || '') + ' 目标开业　模块填报 ' + cs.st.reported + '/' + cs.st.total + '</div></div>'
      + '<div class="pills">' + badge(statusOf(p.id))
      + (cs.st.missing.length ? '<span class="badge yellow">未报 ' + cs.st.missing.length + ' 个模块</span>' : '<span class="badge green">全部模块已报</span>')
      + '</div></div>'
      + '<div class="cdwrap"><div class="cdnum"><b>' + (dOpen !== null ? Math.abs(dOpen) : '—') + '</b><span>天</span></div>'
      + '<div class="cdtxt"><b>' + (dOpen === null ? '开业目标日未设置'
        : dOpen >= 0 ? '距 ' + esc(meta.open_date) + ' 正式开业' : '开业目标日已过 ' + Math.abs(dOpen) + ' 天') + '</b>'
      + '<span>' + (meta.mall_area ? '商业 ' + esc(meta.mall_area) : '') + (meta.units ? ' · ' + esc(meta.units) : '')
      + (meta.invest ? ' · 投资 ' + esc(meta.invest) : '') + '</span></div></div>'
      + fact('一、本月核心节点计划', nodeTxt)
      + fact('二、当月计划事项', itemTxt)
      + fact('三、需要协调', coordTxt)
      + fact('四、工作面移交', handTxt)
      + '<h4 class="subh">项目总评价</h4>' + pzoReviewHtml(p.id)
      + briefSectionInner(p.id, 'pzo_note', canWritePzo())
      + (canWriteCeo() || briefsOf(p.id, 'ceo_brief').length
        ? briefSectionInner(p.id, 'ceo_brief', canWriteCeo())
        : '')
      + '</div>';
  }

  function isManagerOverview() {
    return isPlanningManager() && ['pres','presCom','presPzo'].indexOf(S.view)>=0;
  }
  function overviewPeriod() { return S.overviewUI.period || currentPeriod(); }
  function overviewHistorical() {
    return !!(window.PlanningWindows && !window.PlanningWindows.samePeriod(overviewPeriod(),currentPeriod()));
  }
  function overviewPeriods() {
    var choices=new Map(), windows=window.PlanningWindows;
    function add(period,reference){var start=windows?windows.periodStart(period,reference):period;if(start && !choices.has(start))choices.set(start,period);}
    add(currentPeriod());
    (S.reports || []).forEach(function(report){add(report.period,report.submitted_at || report.created_at);});
    var start=windows && windows.periodStart(currentPeriod());
    if(start)for(var i=1;i<=12;i++){var week=windows.addDays(start,-i*7);add(week);}
    return Array.from(choices,function(entry){return {id:entry[0],label:entry[1]===entry[0]?entry[0]+' 起':entry[1]+' · '+entry[0]};}).sort(function(a,b){return b.id.localeCompare(a.id);});
  }
  function overviewReports(commercial) {
    var reports=(S.reports || []).filter(function(r){
      return isCom(r.project_id)===commercial && (window.PlanningWindows?window.PlanningWindows.samePeriod(r.period,overviewPeriod(),r.submitted_at || r.created_at):r.period===overviewPeriod());
    }).sort(function(a,b){return String(a.author_name || '').localeCompare(String(b.author_name || ''),'zh-CN') || Number(a.id)-Number(b.id);});
    return !commercial && window.MonthlyPlans?window.MonthlyPlans.residentialReports(reports,S.overviewUI.discipline,S.members,S.monthlyPlans):reports;
  }
  function overviewEmpty(text) { return '<span class="overview-empty">'+esc(text || '本期未填写')+'</span>'; }
  function overviewList(rows, renderRow, empty) {
    var valid=Array.isArray(rows)?rows.filter(function(row){return row && typeof row==='object' && !Array.isArray(row);}):[];
    return valid.length?'<ul class="overview-list">'+valid.map(function(row){return '<li>'+renderRow(row)+'</li>';}).join('')+'</ul>':overviewEmpty(empty);
  }
  function overviewTable(section, columns, rows, empty) {
    return '<div class="overview-table-scroll"><table class="overview-data-table" data-section="'+section+'"><colgroup>'
      +columns.map(function(c){return '<col class="overview-col-'+c[1]+'">';}).join('')+'</colgroup><thead><tr>'
      +columns.map(function(c){return '<th scope="col">'+esc(c[0])+'</th>';}).join('')+'</tr></thead><tbody>'
      +(rows.length?rows.map(function(row){return '<tr>'+columns.map(function(c,i){return '<td class="overview-cell-'+c[1]+'" data-label="'+esc(c[0])+'">'+row[i]+'</td>';}).join('')+'</tr>';}).join('')
        :'<tr><td class="overview-cell-empty" colspan="'+columns.length+'">'+overviewEmpty(empty)+'</td></tr>')+'</tbody></table></div>';
  }
  function overviewRowSource(r,show) { return show?'<span class="overview-meta">填报人：'+esc(r.author_name || '未记录填报人')+' · '+esc(r.line || LINE_ALL)+'</span>':''; }
  function overviewNodeHtml(reports,pid,line,commercial,projectIds) {
    if(!window.BaselineCore)return '<p class="notice err" role="alert">项目基准节点组件读取失败，请刷新重试。</p>';
    var discipline=!commercial && S.overviewUI.discipline || line,selected=!commercial && !!S.overviewUI.discipline;
    return window.BaselineCore.coreHtml({projectId:pid,projectIds:projectIds,commercial:commercial,line:line,bizLine:line,discipline:discipline,allScopes:!!projectIds && !selected,
      unassignedOnly:commercial && line===null || selected && discipline==='__unassigned__',includeUnassigned:!!projectIds && !selected,period:overviewPeriod(),window:reportWindow(overviewPeriod(),null,'month')});
  }
  function overviewActualSource(report,item) {
    var pid=item && item.project_id || (!report.report_scope_id?report.project_id:'');
    if(!pid)return '<span class="overview-source-project">统一范围 · 未明确子项目</span>';
    return '<span class="overview-source-project">'+esc(projName(pid))+'</span>';
  }
  function overviewPlanHtml(reports,_pid,_line,commercial,scopeOptions) {
    if(typeof commercial==='boolean' && window.MonthlyPlans && window.MonthlyPlans.projectReports){
      var start=window.PlanningWindows.periodStart(overviewPeriod());
      var selectedScope=scopeOptions && !Array.isArray(scopeOptions)?scopeOptions:null;
      reports=window.MonthlyPlans.projectReports({plans:S.monthlyPlans,reports:reports,projectIds:selectedScope?selectedScope.projectIds:[_pid],
        scope_id:selectedScope && selectedScope.scope_id,line:selectedScope?selectedScope.line:commercial?_line:S.overviewUI.discipline,month:start && start.slice(0,7),includeUnsubmitted:!overviewHistorical()});
    }
    var withSource=commercial===false;
    var rows=[];
    reports.forEach(function(r){itemsOf(r).filter(function(item){return item && typeof item==='object' && !Array.isArray(item);}).forEach(function(item){
      rows.push((withSource?[overviewActualSource(r,item)]:[]).concat([String(rows.length+1),richItem(item,'mod',r.line || LINE_ALL),richItem(item,'name','未命名计划事项')+overviewRowSource(r,reports.length>1),
        esc(sd(item.due)),(item.prog?richItem(item,'prog'):overviewEmpty(r._monthly_preview?'月计划已确认，本周尚未提交':'未填写'))+(item.blocker?'<div class="plan-blocker"><b>遇到卡点：</b>'+richItem(item,'blocker')+'</div>':'')]));
    });});
    return overviewTable('plans',(withSource?[['实际项目／分期','source']]:[]).concat([['序号','seq'],['模块或类别','module'],['事项内容','content'],['完成时间','date'],['完成情况及本周计划','progress']]),
      rows,'暂无当月计划');
  }
  function overviewCoordHtml(reports,_pid,_line,commercial) {
    var withSource=commercial===false;
    var rows=[];
    reports.forEach(function(r){
      var coords=(Array.isArray(r.coord_items)?r.coord_items:[]).filter(function(row){return row && (row.who || row.what);});
      coords.forEach(function(row){rows.push((withSource?[overviewActualSource(r,row)]:[]).concat([String(rows.length+1),esc(row.who || '未指定对象'),richItem(row,'what')+overviewRowSource(r,reports.length>1),esc(sd(row.by))]));});
      if(!coords.length && r.coord && r.coord!=='无')rows.push((withSource?[overviewActualSource(r)]:[]).concat([String(rows.length+1),'—',richItem(r,'coord')+overviewRowSource(r,reports.length>1),'—']));
    });
    return overviewTable('coord',(withSource?[['实际项目／分期','source']]:[]).concat([['序号','seq'],['协调对象','module'],['需协调事项','content'],['最晚时间','date']]),rows,'暂无协调事项');
  }
  function overviewOtherHtml(reports,_pid,_line,commercial) {
    var withSource=commercial===false;
    var rows=[];
    reports.forEach(function(r){var follow=r.biz && r.biz.followups;
      if(follow && !Array.isArray(follow))rows.push((withSource?[overviewActualSource(r)]:[]).concat([String(rows.length+1),'待核对',overviewEmpty('同步记录格式待核对'),esc(r.author_name || ''),'—',overviewEmpty('请核对原报告')]));
      (Array.isArray(follow)?follow:[]).filter(function(row){return row && typeof row==='object' && !Array.isArray(row);}).forEach(function(row){
      rows.push((withSource?[overviewActualSource(r,row)]:[]).concat([String(rows.length+1),esc(row.title || '同步事项'),richItem(row,'what')
        +'<span class="overview-meta">'+esc((row.source_author || '')+(row.source_period?' · '+row.source_period:''))+'</span>',esc(r.author_name || '未记录'),
        esc(sd(row.due))+(row.effective_due && row.effective_due!==row.due?'<span class="overview-meta">执行期限 '+esc(sd(row.effective_due))+'</span>':''),
        (row.progress?richItem(row,'progress'):overviewEmpty('未填写'))+'<span class="overview-meta">'+esc({open:'待处理',in_progress:'推进中',completed:'本人反馈完成（以运营审核为准）'}[row.status] || '状态未记录')+'</span>']));
    });});
    return overviewTable('other',(withSource?[['实际项目／分期','source']]:[]).concat([['序号','seq'],['事项类别','module'],['其他事项','content'],['填报人','module'],['原计划时间','date'],['汇报进展及反馈状态','progress']]),rows,'暂无其他事项');
  }
  function overviewLegacyHtml(r) {
    if(isCom(r.project_id) || ![r.change_text,r.dev_text,r.projection,r.impact].some(Boolean)
      && !(r.next_items || []).length && !(r.speed_items || []).length && !(r.effect_items || []).length)return '';
    return '<details class="overview-legacy"><summary>既有住宅补充记录</summary>'
      +(r.change_text?'<h5>本周实质变化</h5><div>'+richItem(r,'change_text')+'</div>':'')
      +(r.dev_text || r.projection || r.impact?'<h5>风险、影响与对策</h5>'+riskCell(r):'')
      +((r.speed_items || []).length?'<h5>提速对策</h5>'+overviewList(r.speed_items,function(x){return richItem(x,'act')+(x.gain?' · '+richItem(x,'gain'):'');}):'')
      +((r.effect_items || []).length?'<h5>效果保障</h5>'+overviewList(r.effect_items,function(x){return richItem(x,'act')+(x.target?' · '+richItem(x,'target'):'');}):'')
      +((r.next_items || []).length?'<h5>下周必须完成</h5>'+nextCell(r):'')+'</details>';
  }
  function overviewAttachmentHtml(r) {
    var refs=r.biz && r.biz.attachments;
    if(!refs || Array.isArray(refs) && !refs.length)return overviewEmpty('暂无附件资料');
    return window.ReportAttachments?window.ReportAttachments.snapshotHtml(r):'<span class="overview-empty">附件组件尚未就绪，请刷新重试。</span>';
  }
  function overviewReportHtml(value,pid,line,commercial,knownLines,skipMeetings) {
    var reports=Array.isArray(value)?value:[value];
    pid=pid || reports[0] && reports[0].project_id;
    return '<div class="overview-report">'+reports.map(function(r){return '<div class="overview-report-meta" data-report-id="'+esc(r.id)+'">'+esc(r.author_name || '未记录填报人')
      +' · '+esc(r.line || LINE_ALL)+(r.updated_at || r.submitted_at?' · '+esc(fmtTime(r.updated_at || r.submitted_at)):'')
      +reportHistoryButton(r)+'</div>';}).join('')+'<div class="overview-report-grid overview-report-sections">'
      +'<section class="overview-core-nodes"><h4>一、滚动月核心节点计划</h4>'+overviewNodeHtml(reports,pid,line,commercial)+'</section>'
      +'<section class="overview-monthly-plans"><h4>二、当月计划填报</h4>'+overviewPlanHtml(reports,pid,line,commercial)+'</section>'
      +(!skipMeetings && !overviewHistorical() && window.OverviewMeetings?window.OverviewMeetings.html(pid,line,commercial,knownLines || (commercial?businessLinesForProject(pid):DISCIPLINES)):'')
      +'<section class="overview-coordination"><h4>三、需要协调</h4>'+overviewCoordHtml(reports)+'</section>'
      +'<section class="overview-other"><h4>四、其他事项</h4>'+overviewOtherHtml(reports)+'</section></div>'
      +reports.map(function(r){var legacy=overviewLegacyHtml(r);return legacy?overviewRowSource(r,reports.length>1)+legacy:'';}).join('')+'</div>';
  }
  function overviewDiscipline(r) {
    if(window.MonthlyPlans)return window.MonthlyPlans.residentialLine(r,S.members);
    var author=(S.members || []).filter(function(m){return r.author_id?m.user_id===r.author_id:m.name===r.author_name;})[0];
    return author && author.discipline || (r.line && r.line!==LINE_ALL?r.line:'综合 / 未指定专业');
  }
  function overviewArrangeButtons(pid,line) {
    if(!canWriteCeo() && !canWritePzo())return '';
    return '<p class="muted no-print">'+(isCom(pid)?'新会议要求请在计划总览的“会议要求事项”表新增并指定责任人':'新工作安排请在本页“领导工作安排”区选择专业、责任人及完成时间')+'；此处仅维护既有记录。</p>';
  }
  function overviewBriefLine(row) {
    var match=/^【([^】]+)】/.exec(String(row.what || '').trim());
    return match?match[1]:'';
  }
  function overviewNotesHtml(pid,line,knownLines) {
    var selected=!isCom(pid) && S.overviewUI.discipline;
    if(selected && (selected==='__unassigned__'?line!==null:line!==selected))return '';
    if(overviewHistorical()) {
      var saved=(S.leaderNotes || []).filter(function(note){var prefix=overviewBriefLine(note);return note.project_id===pid
        && window.PlanningWindows.samePeriod(note.period,overviewPeriod(),note.created_at)
        && (line===null?knownLines.indexOf(prefix)<0:prefix===line);});
      return saved.length?'<section class="overview-note-kind"><h4>当期保存的工作要求</h4>'+saved.map(function(note){return '<div>'+richItem(note,'what')+' · '+esc(note.due || '未设完成时间')+'</div>';}).join('')+'</section>':'';
    }
    if(S.profile.role==='ops')return '';
    var unclassified=line===null;
    function includeRow(row){var prefix=overviewBriefLine(row);return unclassified?knownLines.indexOf(prefix)<0:prefix===line;}
    var content=['ceo_brief','pzo_note'].map(function(kind){
      var editable=kind==='ceo_brief'?canWriteCeo():canWritePzo(),list=editable?briefDraftRows(pid,kind):briefsOf(pid,kind);
      if(!list.some(includeRow) && !(editable && briefsOf(pid,kind).some(includeRow)))return '';
      var title=kind==='ceo_brief'?'既有总裁工作要求':'既有项目总工作要求';
      return '<section class="overview-note-kind" data-note-kind="'+kind+'"><h4>'+title+'</h4>'+briefRowsHtml(pid,kind,editable,includeRow)
        +(editable?'<div class="overview-arrange-actions"><button type="button" class="btn sm" onclick="'+esc('App.'+(kind==='ceo_brief'?'saveCeoBriefs':'savePzoNotes')+'('+JSON.stringify(pid)+')')+'">保存本项目'+title+'</button></div>':'')+'</section>';
    }).join('');
    if(!content)return '';
    return '<section class="'+(unclassified?'overview-project-notes':'overview-profession-notes')+'"'+(unclassified?'':' data-profession="'+esc(line)+'"')+'>'
      +(unclassified?'<h3>项目级及未归专业的既有工作要求</h3><p class="muted">保留未标记专业或使用其他专业名称的既有记录。</p>':'')+overviewArrangeButtons(pid,line)
      +content+'</section>';
  }
  function overviewResidentialGroups(pid,rows) {
    var groups=Object.create(null),assigned=Object.create(null);
    rows.forEach(function(r){var line=overviewDiscipline(r);(groups[line] || (groups[line]=[])).push(r);});
    (S.pms || []).forEach(function(m){if(m.project_id===pid)assigned[m.user_id]=true;});
    (S.members || []).forEach(function(m){
      if(m.role!=='pm' || m.status!=='approved' || !(m.project_id===pid || assigned[m.user_id]))return;
      var line=m.discipline || '综合 / 未指定专业';
      if(!groups[line])groups[line]=[];
    });
    msOf(pid).forEach(function(m){if(m.discipline && !groups[m.discipline])groups[m.discipline]=[];});
    return groups;
  }
  function overviewDrawingHtml(pid) {
    var list=drawingsOf(pid).filter(function(d){return String(d.kind || '').indexOf('项目总图')===0;});
    return '<aside class="overview-project-drawing"><h3>项目总图</h3>'+(list.length?list.map(function(d){
      var url=typeof d.url==='string' && (/^https?:\/\//i.test(d.url) || /^\/api\/files\/drawings\/[A-Za-z0-9_./-]+$/.test(d.url))?d.url
        : /^drawings\/[A-Za-z0-9_./-]+$/.test(d.path || '')?'/api/files/'+d.path:'';
      var name=d.name || '项目总图',ext=String(d.path || url).split(/[?#]/)[0],image=/\.(?:png|jpe?g|gif|webp|avif)$/i.test(ext) || /\.(?:png|jpe?g|gif|webp|avif)$/i.test(name);
      return '<figure>'+(url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+(image?'<img src="'+esc(url)+'" alt="'+esc(name)+'" width="320" height="220" loading="lazy" decoding="async">':'<span class="overview-drawing-file">打开'+esc(/\.pdf$/i.test(ext)?'PDF总图':'总图资料')+'</span>')+'</a>':overviewEmpty('总图链接待核对'))
        +'<figcaption>'+esc(name)+'</figcaption></figure>';
    }).join(''):overviewEmpty('尚未登记项目总图'))+'</aside>';
  }
  function overviewFoldKey(kind,pid,line) { return JSON.stringify([kind,pid,line || '']); }
  function overviewReportFilesHtml(rows,commercial) {
    var reports=rows.filter(function(r){return !commercial || !S.overviewUI.line || r.line===S.overviewUI.line;});
    return '<aside class="overview-report-files"><h3>本期填报附件</h3>'+reports.map(function(r){
      var refs=r.biz && r.biz.attachments;
      if(!Array.isArray(refs) || !refs.length)return '';
      return '<section data-report-id="'+esc(r.id)+'"><h4>'+esc(r.author_name || '填报人')+' · '+esc(commercial?r.line || LINE_ALL:overviewDiscipline(r))+'</h4>'+overviewAttachmentHtml(r)+'</section>';
    }).join('')+(reports.some(function(r){return r.biz && Array.isArray(r.biz.attachments) && r.biz.attachments.length;})?'':overviewEmpty('本期暂无附件'))+'</aside>';
  }
  function overviewFoldAttrs(kind,pid,line,initial) {
    var key=overviewFoldKey(kind,pid,line),open=S.overviewUI.open;
    if(!Object.prototype.hasOwnProperty.call(open,key))open[key]=!!initial;
    return ' data-overview-fold="'+esc(key)+'"'+(open[key]?' open':'')
      +' ontoggle="'+esc('App.overviewToggle('+JSON.stringify(key)+',this.open)')+'"';
  }
  function overviewFoldHint() { return '<span class="overview-fold-hint" aria-hidden="true"><span class="when-closed">展开</span><span class="when-open">收起</span></span>'; }
  function overviewFilterHtml(commercial) {
    var selected=commercial?S.overviewUI.line:S.overviewUI.project;
    var choices=commercial?businessLinesForProjects(overviewProjects(true)).map(function(line){return {id:line,name:line};}):overviewProjectGroups().map(function(group){return {id:group.name,name:group.name};});
    var selectedPeriod=window.PlanningWindows?window.PlanningWindows.periodStart(overviewPeriod()):overviewPeriod();
    return '<div class="overview-filter no-print"><label for="overviewPeriod">查看周期</label><select id="overviewPeriod" onchange="App.overviewPeriod(this.value)">'
      +overviewPeriods().map(function(period){return '<option value="'+esc(period.id)+'"'+(selectedPeriod===period.id?' selected':'')+'>'+esc(period.label)+'</option>';}).join('')+'</select></div>'
      +'<div class="overview-filter no-print"><label for="overviewFilter">'+(commercial?'筛选专业':'筛选项目')+'</label>'
      +'<select id="overviewFilter" onchange="App.overviewFilter(this.value)"><option value="">'+(commercial?'全部专业':'全部住宅项目')+'</option>'
      +choices.map(function(item){return '<option value="'+esc(item.id)+'"'+(selected===item.id?' selected':'')+'>'+esc(item.name)+'</option>';}).join('')+'</select></div>'
      +(!commercial?'<div class="overview-filter no-print"><label for="overviewDiscipline">筛选专业</label><select id="overviewDiscipline" onchange="App.overviewDiscipline(this.value)"><option value="">全部专业</option>'+overviewDisciplineChoices().map(function(line){return '<option value="'+esc(line)+'"'+(S.overviewUI.discipline===line?' selected':'')+'>'+esc(line==='__unassigned__'?'未归专业':line)+'</option>';}).join('')+'</select></div>':'')
      +'<div class="overview-expand-actions no-print"><button type="button" class="btn ghost sm" onclick="App.overviewExpandAll(true)">展开全部</button><button type="button" class="btn ghost sm" onclick="App.overviewExpandAll(false)">收起全部</button></div>';
  }
  function overviewDisciplineChoices() {
    var groups=overviewProjectGroups().filter(function(group){return !S.overviewUI.project || group.name===S.overviewUI.project;}),ids=[];
    groups.forEach(function(group){group.projects.forEach(function(project){ids.push(project.id);});});
    var lines=[];
    function add(line){if(line && line!=='综合' && line!=='综合 / 未指定专业' && line!=='__unassigned__' && lines.indexOf(line)<0)lines.push(line);}
    ids.forEach(function(pid){Object.keys(overviewResidentialGroups(pid,S.reports.filter(function(r){return r.project_id===pid;}))).forEach(add);});
    (S.monthlyPlans || []).forEach(function(plan){if(ids.indexOf(plan.project_id)>=0)add(plan.line);});
    lines.sort(function(a,b){var ai=DISCIPLINES.indexOf(a),bi=DISCIPLINES.indexOf(b);return (ai<0?999:ai)-(bi<0?999:bi) || a.localeCompare(b,'zh-CN');});
    return lines.concat('__unassigned__');
  }
  function overviewProjects(commercial) {
    return (isPzo()?myProjects():S.projects).filter(function(p){return isCom(p.id)===commercial;}).sort(function(a,b){return (a.sort_order || 0)-(b.sort_order || 0);});
  }
  function overviewProjectGroups(){
    var projects=overviewProjects(false);
    return window.ReportScopes?window.ReportScopes.groupProjects(projects,S.reportScopes,overviewPeriod(),null,S.reports):window.PlanningWindows?window.PlanningWindows.groupProjects(projects):projects.map(function(p){return {name:p.name,projects:[p]};});
  }
  function overviewProjectHtml(p,rows,commercial,initial) {
    var content='',knownLines=[];
    if(commercial){
      knownLines=businessLinesForProject(p.id);
      var firstLine=knownLines.filter(function(line){return rows.some(function(r){return r.line===line;});})[0] || knownLines[0];
      content=knownLines.filter(function(line){return !S.overviewUI.line || S.overviewUI.line===line;}).map(function(line){var reports=rows.filter(function(r){return r.line===line;});
        return '<details class="overview-module'+(reports.length?'':' is-empty')+'" data-module="'+esc(line)+'"'+overviewFoldAttrs('profession',p.id,line,line===firstLine || S.overviewUI.line===line)+'><summary><span class="overview-profession-name">'+esc(line)+'</span><span class="overview-report-count">'+reports.length+' 份填报</span>'+overviewFoldHint()+'</summary>'
          +'<div class="overview-profession-body">'+overviewReportHtml(reports,p.id,line,true,knownLines)+overviewNotesHtml(p.id,line,knownLines)+'</div></details>';
      }).join('');
      var legacy=rows.filter(function(r){return knownLines.indexOf(r.line)<0;});
      if(legacy.length && !S.overviewUI.line)content+='<details class="overview-module overview-legacy-module"'+overviewFoldAttrs('profession',p.id,'__legacy',false)+'><summary><span class="overview-profession-name">其他既有模块记录</span><span class="overview-report-count">'+legacy.length+' 份填报</span>'+overviewFoldHint()+'</summary><div class="overview-profession-body">'+legacy.map(function(r){return overviewReportHtml(r,p.id,null,true,knownLines,true);}).join('')+'</div></details>';
    }else{
      var groups=overviewResidentialGroups(p.id,rows);
      knownLines=Object.keys(groups).sort(function(a,b){var ai=DISCIPLINES.indexOf(a),bi=DISCIPLINES.indexOf(b);return (ai<0?999:ai)-(bi<0?999:bi) || a.localeCompare(b,'zh-CN');});
      var firstProfession=knownLines.filter(function(line){return groups[line].length;})[0] || knownLines[0];
      content=knownLines.map(function(line){
        return '<details class="overview-profession'+(groups[line].length?'':' is-empty')+'" data-discipline="'+esc(line)+'"'+overviewFoldAttrs('profession',p.id,line,line===firstProfession)+'><summary><span class="overview-profession-name">'+esc(line)+'</span><span class="overview-report-count">'+groups[line].length+' 份填报</span>'+overviewFoldHint()+'</summary>'
          +'<div class="overview-profession-body">'+overviewReportHtml(groups[line],p.id,line,false,knownLines,true)+overviewNotesHtml(p.id,line,knownLines)+'</div></details>';
      }).join('') || '<div class="overview-no-report">'+overviewEmpty('本期暂无已提交填报。')+'</div>';
    }
    var notes=overviewNotesHtml(p.id,null,knownLines)
      +(commercial && !overviewHistorical() && !S.overviewUI.line && window.OverviewMeetings && window.OverviewMeetings.unassignedHtml?window.OverviewMeetings.unassignedHtml(p.id,commercial,knownLines):'');
    var unassigned=window.PlanningWindows?window.PlanningWindows.scopedMilestones(S.milestones,{projectId:p.id,commercial:commercial,
      window:reportWindow(currentPeriod(),null,'month'),includeUnassigned:true,keyOnly:!commercial}).filter(function(m){return !window.PlanningWindows.scopeOf(m,commercial);}):[];
    if(commercial && unassigned.length && !S.overviewUI.line)content+='<section class="overview-unassigned"><h3>待分配专业的基准节点</h3><p class="muted">未分配节点不预填到个人报告；请在节点归属维护中指定专业或商业模块。</p>'+overviewNodeHtml([],p.id,null,commercial)+'</section>';
    if(!commercial && window.OverviewMeetings && window.OverviewMeetings.residentialHtml)content+=window.OverviewMeetings.residentialHtml([p]);
    return '<details class="card overview-project" data-project-id="'+esc(p.id)+'"'+overviewFoldAttrs('project',p.id,'',initial || commercial)+'><summary class="overview-project-head"><span class="overview-project-name">'+esc(p.name)+'</span>'
      +'<span class="muted">'+(commercial?'商业 · '+(S.overviewUI.line || knownLines.length+' 个专业模块'):'住宅 · 分专业填报')+' · 本期 '+rows.length+' 份填报</span>'+overviewFoldHint()+'</summary>'
      +'<div class="overview-project-tools">'+projectDetailButton(p.id)+'</div>'
      +(window.AdminPlanOverview?window.AdminPlanOverview.layout({key:'project:'+p.id,projects:[p],reports:rows,content:content+notes,sidebar:overviewDrawingHtml(p.id)+overviewReportFilesHtml(rows,commercial)}):'<div class="overview-project-layout"><div class="overview-project-content">'+content
      +notes+'</div><div class="overview-side-stack">'+overviewDrawingHtml(p.id)+overviewReportFilesHtml(rows,commercial)+'</div></div>')+'</details>';
  }
  function viewPlanOverview(commercial) {
    var list=overviewProjects(commercial),reports=overviewReports(commercial);
    if(commercial && S.overviewUI.line)list=list.filter(function(project){return businessLinesForProject(project.id).indexOf(S.overviewUI.line)>=0;});
    if(!commercial && S.overviewUI.project && !overviewProjectGroups().some(function(g){return g.name===S.overviewUI.project;}))S.overviewUI.project='';
    if(!commercial && S.overviewUI.project){var selectedGroup=overviewProjectGroups().filter(function(g){return g.name===S.overviewUI.project;})[0];list=selectedGroup?selectedGroup.projects:[];}
    var visibleReports=reports.filter(function(r){return list.some(function(p){return p.id===r.project_id;}) && (!commercial || !S.overviewUI.line || r.line===S.overviewUI.line);});
    var range=reportWindow(overviewPeriod(),null,'month');
    var displayGroups=!commercial && window.ReportScopes?window.ReportScopes.groupProjects(list,S.reportScopes,overviewPeriod(),null,S.reports):window.PlanningWindows?window.PlanningWindows.groupProjects(list):list.map(function(p){return {name:p.name,projects:[p]};});
    return '<div class="plan-overview" data-project-type="'+(commercial?'com':'res')+'"><div class="overview-context"><span>'+esc(overviewPeriod())+(range?' · 基准窗口 '+range.start+' 至 '+range.end:'')+'</span><span>'+list.length+' 个子项目 · '+visibleReports.length+' 份所选周期填报</span></div>'
      +(S.profile.role==='ops'?'<div class="actions" style="margin-bottom:12px"><button type="button" class="btn primary" onclick="App.openAdminPlans('+(commercial?'true':'false')+')">批量导入计划</button><span class="muted">AI 识别整份项目月计划，分专业预览后一次导入</span></div>':'')
      +(overviewHistorical()?'<p class="notice overview-history-note">往期填报只读，内容按当期保存记录展示；基准节点为当前保留数据按所选周期筛选。</p>':'')
      +(!commercial?'<p class="muted overview-group-count">'+displayGroups.length+' 个展示组 · '+list.length+' 个实际子项目；统一范围报告只计一次，节点、事项及原历史可追溯实际项目。</p>':'')
      +overviewMonthlySummariesHtml(list,commercial)
      +((!commercial && window.AdminPlanOverview?displayGroups.map(function(g,i){return window.AdminPlanOverview.residential(g,reports,i===0);}):list.map(function(p,i){return overviewProjectHtml(p,reports.filter(function(r){return r.project_id===p.id;}),commercial,i===0);})).join('') || '<div class="card empty">暂无'+(commercial?'商业':'住宅')+'项目。</div>')+'</div>';
  }
  function viewPres() { return viewPlanOverview(false); }
  function viewPresCom() { return viewPlanOverview(true); }
  function viewPresPzo() { return viewPlanOverview(true); }

  function overviewSummaryMonth(){
    var value=window.PlanningWindows?window.PlanningWindows.periodStart(overviewPeriod()):overviewPeriod();
    return /^\d{4}-\d{2}-\d{2}$/.test(value || '')?value.slice(0,7):'';
  }
  function overviewMonthlySummariesHtml(projects,commercial){
    var state=dataState.monthlySummaries,month=overviewSummaryMonth();
    if(!state && !window.MonthlySummaries)return '';
    var content=state && state.error?'<p class="notice err" role="alert">月度汇总读取失败：'+esc(state.error)+'</p>'
      : !state || !state.ready || state.scope!==month?'<p class="muted" role="status">正在读取所选月份的月度汇总…</p>'
      : !window.MonthlySummaries?'<p class="notice err" role="alert">月度汇总组件未加载，请刷新重试。</p>'
      : window.MonthlySummaries.html(S.monthlySummaries,{projects:projects,projectIds:projects.map(function(project){return project.id;}),month:month,line:commercial?S.overviewUI.line:S.overviewUI.discipline});
    return '<section class="card monthly-summary-section" data-summary-month="'+esc(month)+'"><div class="cardbody"><h3>本月计划完成情况（月度汇总） · '+esc(month)+'</h3><p class="muted">独立保存的月度完成情况，不计作周报提交，也不代表完成审核通过。</p>'+content+'</div></section>';
  }

  /* ============ 我的条线（专业条线视图） ============ */

  function canEditMaster() { return !!S.profile && (S.profile.role === 'ops' || S.profile.role === 'president'); }

  /* 三段式「本周期必盯」小卡：只列前 6 条，其余引导看下表 */
  function lineStrip(title, arr, cls, hint) {
    var head = '<div class="cardhd"><h3>' + title + '<span class="chip">' + arr.length + '</span></h3>'
      + (hint ? '<span class="hint" style="margin:0">' + hint + '</span>' : '') + '</div>';
    if (!arr.length) return '<div class="plan-line-strip">' + head + '<div class="hint" style="margin:0">暂无</div></div>';
    return '<div class="plan-line-strip">' + head + '<div class="mini">' + arr.slice(0, 6).map(function (m) {
      return '<div><span>' + richItem(m, 'name') + '</span><b class="' + cls + '">'
        + esc(sd(m.forecast_date || m.plan_date)) + '</b></div>';
    }).join('') + (arr.length > 6 ? '<div class="hint" style="margin:0">另 ' + (arr.length - 6) + ' 项见下表</div>' : '') + '</div></div>';
  }

  function reporterNodeDate(m, mode) {
    return String((mode === 'plan' ? m.plan_date : effectiveItemDue('milestone:'+m.project_id+':'+m.id,m.forecast_date || m.plan_date)) || '').slice(0, 10);
  }
  function reporterNodeCompare(mode) {
    return function (a, b) {
      return (reporterNodeDate(a, mode) || '9999').localeCompare(reporterNodeDate(b, mode) || '9999')
        || (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)
        || String(a.id).localeCompare(String(b.id), 'zh-CN', { numeric: true });
    };
  }
  /* 只按名称提供阅读分组，不能据此推定真实的前置依赖或阻塞。 */
  var REPORTER_STAGES = [
    { label: '前期与报建', match: /拿地|土地|立项|用地|规划许可|工程规划|报建|施工许可|开工证/ },
    { label: '方案与设计', match: /设计|方案|施工图|图审|审图|勘察/ },
    { label: '招采与准备', match: /招标|招采|定标|采购|招募|清单|合同|封样|定板|备料/ },
    { label: '建设施工', match: /开工|进场|土方|桩基|基础|地下|结构|封顶|安装|机电|装修|精装|幕墙|景观|施工|管网|道路/ },
    { label: '营销与销售', match: /预售|首开|开盘|示范区|样板|营销|销售|推售|取证|认筹|招商|签约|落位/ },
    { label: '竣备与交付／开业', match: /竣工|备案|验收|交付|交房|开业|试营业|移交|交接|大产证/ },
    { label: '运营维护', match: /运营|维保|维修|巡检|物业|客诉|收缴|收租/ },
    { label: '待归类', match: null }
  ];
  function reporterStageIndex(m) {
    var name = plain(m.name || '');
    /* 终点节点优先，避免“主体结构验收”等名称被施工词命中。 */
    if (REPORTER_STAGES[5].match.test(name)) return 5;
    if (REPORTER_STAGES[4].match.test(name)) return 4;
    for (var i = 0; i < REPORTER_STAGES.length - 1; i++) {
      if (REPORTER_STAGES[i].match.test(name)) return i;
    }
    return REPORTER_STAGES.length - 1;
  }
  function reporterFlowProject(project, nodes, mode) {
    if (!nodes.length) return '';
    var stages = REPORTER_STAGES.map(function (stage) { return { label: stage.label, lanes: {}, count: 0 }; });
    nodes.forEach(function (m) {
      var stage = stages[reporterStageIndex(m)], lane = m.line || '未指定条线';
      (stage.lanes[lane] = stage.lanes[lane] || []).push(m); stage.count++;
    });
    function nodeHtml(m) {
      return '<li class="reporter-flow-node' + (m.done ? ' is-done' : '') + '" data-milestone="' + esc(m.id) + '">'
        + '<div class="reporter-flow-node-name">' + richItem(m, 'name')
        + (m.is_key ? ' <span class="chip key">关键</span>' : '') + '</div>'
        + '<div class="reporter-flow-dates"><span>计划 ' + esc(sd(m.plan_date)) + '</span><span>预计 ' + esc(sd(m.forecast_date)) + '</span></div>'
        + (m.done ? '<span class="badge gray">已完成</span>' : '<div>'
          + (m.plan_date && m.forecast_date ? devTxt(dayDiff(m.forecast_date, m.plan_date)) : '<span class="muted">计划或预计时间待完善</span>') + '</div>')
        + '</li>';
    }
    return '<section class="reporter-flow-project" data-project="' + esc(project.id) + '">'
      + '<h4>' + esc(project.name) + '<span class="chip">' + nodes.length + ' 个节点</span></h4>'
      + '<div class="reporter-flow-stages">' + stages.filter(function (stage) { return stage.count; }).map(function (stage) {
        return '<section class="reporter-flow-stage"><div class="reporter-flow-stage-head"><b>' + esc(stage.label) + '</b>'
          + '<span>' + stage.count + ' 项</span></div><div class="reporter-flow-lanes">'
          + Object.keys(stage.lanes).map(function (lane) {
            var laneNodes = stage.lanes[lane].sort(reporterNodeCompare(mode));
            var open = laneNodes.filter(function (m) { return !m.done; }), done = laneNodes.filter(function (m) { return m.done; });
            return '<div class="reporter-flow-lane"><h5>' + esc(lane) + '</h5>'
              + (open.length ? '<ul>' + open.map(nodeHtml).join('') + '</ul>' : '<div class="muted">本条线本阶段节点均已完成</div>')
              + (done.length ? '<details class="reporter-flow-done"><summary>已完成 ' + done.length + ' 项</summary><ul>' + done.map(nodeHtml).join('') + '</ul></details>' : '')
              + '</div>';
          }).join('') + '</div></section>';
      }).join('') + '</div></section>';
  }
  function viewMyLine() {
    var disc = myDisc(), projects = myProjects();
    var projectFilter = S.filters.mlineP || '', mode = S.filters.mlineSort === 'plan' ? 'plan' : 'due';
    if (projectFilter && !projects.some(function (p) { return p.id === projectFilter; })) projectFilter = '';
    var list = lineMilestones().filter(function (m) { return !projectFilter || m.project_id === projectFilter; }).sort(reporterNodeCompare(mode));
    var b = lineBuckets(list), byProject = {};
    list.forEach(function (m) { (byProject[m.project_id] = byProject[m.project_id] || []).push(m); });
    var visibleProjects = projects.filter(function (p) { return !!byProject[p.id]; });
    function options() {
      return '<option value="">全部负责项目</option>' + projects.map(function (p) {
        return '<option value="' + esc(p.id) + '"' + (projectFilter === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      }).join('');
    }
    var head = '<div class="card"><div class="cardhd"><h2 style="margin:0">我的条线：<b>'
      + esc(disc || '项目全专业（项目经理视角）') + '</b></h2>'
      + '<span class="hint" style="margin:0">'
      + (disc ? '只看本专业的节点' : '未设置专业条线，按项目经理视角显示我负责项目的全部节点')
      + '　|　参与项目 ' + visibleProjects.length + ' 个　|　节点 ' + list.length + ' 条</span></div>'
      + '<div class="reporter-line-filters no-print"><div><label for="reporter-line-project">筛选项目</label>'
      + '<select id="reporter-line-project" onchange="App.mlineFilter(\'mlineP\',this.value)">' + options() + '</select></div>'
      + '<div><label for="reporter-line-sort">项目内节点排序</label><select id="reporter-line-sort" onchange="App.mlineFilter(\'mlineSort\',this.value)">'
      + '<option value="due"' + (mode === 'due' ? ' selected' : '') + '>到期时间：预计优先，未填用计划</option>'
      + '<option value="plan"' + (mode === 'plan' ? ' selected' : '') + '>计划完成时间</option></select></div></div>'
      + '<div class="plan-line-grid">'
      + lineStrip('已逾期未完成', b.overdue, 'red', '预计时间优先，未填用计划时间')
      + lineStrip('未来 30 天到期', b.soon, 'amber', '按当前筛选范围显示')
      + lineStrip('关键节点（未到期）', b.key, '', '带关键标记、尚未到期')
      + '</div></div>';
    function rowHtml(m) {
      var d = m.done ? null : dayDiff(m.forecast_date, m.plan_date), L = m.done ? 'gray' : lightOf(d);
      return '<tr data-milestone="'+m.id+'"><td>' + richItem(m, 'name') + (m.is_key ? ' <span class="chip key">关键</span>' : '') + '</td>'
        + '<td class="muted">' + esc(m.line || '—') + '</td><td class="muted">' + esc(m.level || '—') + '</td>'
        + '<td class="muted">' + esc(sd(m.plan_date)) + '</td>'
        + '<td class="muted">' + esc(sd(m.forecast_date)) + '</td>'
        + '<td>' + (m.done ? '<span class="badge gray">已完成</span>' : devTxt(d)) + '</td>'
        + '<td><span class="dot d-' + L + '"></span>' + deviationStatus(d,m.done) + '</td>'
        + '<td class="muted">' + esc(m.standard || '—') + '</td>'
        + '<td>' + (m.note?'<div class="muted personal-node-note">'+richItem(m,'note')+'</div>':'')
        + (window.CompletionReview ? window.CompletionReview.actionHtml('milestone:'+m.project_id+':'+m.id) : '<span class="muted">申报组件尚未就绪，请刷新重试</span>') + '</td></tr>';
    }
    var tables = visibleProjects.map(function (p) {
      return '<section class="reporter-node-project" data-project="' + esc(p.id) + '"><h4>' + esc(p.name)
        + '<span class="chip">' + byProject[p.id].length + ' 条</span></h4><div class="tablewrap"><table><thead><tr>'
        + '<th style="width:20%">节点</th><th style="width:7%">条线</th><th style="width:7%">层级</th>'
        + '<th style="width:9%">计划</th><th style="width:11%">预计完成</th><th style="width:7%">偏差</th>'
        + '<th style="width:8%">灯号</th><th style="width:14%">完成标准</th><th>完成／延期申报</th></tr></thead>'
        + '<tbody>' + byProject[p.id].map(rowHtml).join('') + '</tbody></table></div></section>';
    }).join('');
    return '<div class="reporter-workbench personal-nodes">' + head
      + '<div class="card"><div class="cardhd"><h3>我负责的节点<span class="chip">' + list.length + ' 条</span></h3>'
      + '<span class="hint" style="margin:0">按项目分组，组内按' + (mode === 'plan' ? '计划完成时间' : '到期时间（预计优先，未填用计划）') + '由近到远；未填时间排最后。统计、偏差与灯号使用已保存数据。</span></div>'
      + (disc ? '' : '<div class="hint" style="margin-bottom:10px">你还没有被指定专业条线，现在看到的是负责项目全部专业的节点。运营管理员可在「成员管理」中指定条线。</div>')
      + '<p class="notice">节点无需每周重复填写；到实际完成或需要延期时，在对应节点申报。原计划、预计时间及历史说明保留展示。</p>'
      + (tables || '<div class="empty">当前筛选范围没有节点，请核对项目筛选与节点归属。</div>')
      + '</div>'
      + '</div>';
  }

  /* ============ 运营端：节点归属维护（条线视图的地基） ============ */

  var OWNER_DEPTS = ['项目部', '设计部', '前期部', '投资开发部', '成本部', '招采部', '营销部', '财务部',
    '商管公司', '招商部', '工程客服部'];

  function viewLineAdmin() {
    var pfilter = S.filters.lineP || '', lfilter = S.filters.lineL || '';
    var list = S.milestones.filter(function (m) {
      if (pfilter && m.project_id !== pfilter) return false;
      if (lfilter && (m.line || '') !== lfilter) return false;
      return true;
    }).sort(function (a, b) {
      return String(projName(a.project_id)).localeCompare(String(projName(b.project_id)))
        || (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
    });
    var noLine = S.milestones.filter(function (m) { return !m.line; }).length;
    var discCount = {};
    DISCIPLINES.forEach(function (l) { discCount[l] = 0; });
    S.milestones.forEach(function (m) { if (m.line && discCount[m.line] !== undefined) discCount[m.line]++; });

    var rows = list.map(function (m) {
      return '<tr>'
        + '<td><b>' + esc(projName(m.project_id)) + '</b></td>'
        + '<td>' + richItem(m, 'name') + '</td>'
        + '<td class="muted">' + esc(m.level || '—') + '</td>'
        + '<td class="muted">' + esc(sd(m.plan_date)) + '</td>'
        + '<td><select id="ln_scope_'+m.id+'" aria-label="自动提取归属">'+['<option value="">待分配</option>'].concat((isCom(m.project_id)?businessLinesForProject(m.project_id):DISCIPLINES).map(function(scope){return '<option value="'+esc(scope)+'"'+((isCom(m.project_id)?m.biz_line:m.discipline)===scope?' selected':'')+'>'+esc(scope)+'</option>';})).join('')+'</select></td>'
        + '<td><select id="ln_line_' + m.id + '" style="width:118px">'
        + ['<option value="">未归口</option>'].concat((m.line && DISCIPLINES.indexOf(m.line)<0?[m.line]:[]).concat(DISCIPLINES).map(function (l) {
          return '<option value="' + esc(l) + '"' + ((m.line || '') === l ? ' selected' : '') + '>' + esc(l) + '</option>';
        })).join('') + '</select></td>'
        + '<td><select id="ln_dept_' + m.id + '" style="width:118px">'
        + ['<option value="">未指定</option>'].concat((m.owner_dept && OWNER_DEPTS.indexOf(m.owner_dept)<0?[m.owner_dept]:[]).concat(OWNER_DEPTS).map(function (dp) {
          return '<option value="' + esc(dp) + '"' + ((m.owner_dept || '') === dp ? ' selected' : '') + '>' + esc(dp) + '</option>';
        })).join('') + '</select></td>'
        + '<td><input type="text" id="ln_own_' + m.id + '" value="' + esc(m.owner_name || '')
        + '" placeholder="姓名" style="width:86px"></td>'
        + '<td style="text-align:center"><input type="checkbox" id="ln_key_' + m.id + '"' + (m.is_key ? ' checked' : '') + '></td>'
        + '</tr>';
    }).join('');

    return '<div class="card"><div class="cardhd"><h2 style="margin:0">节点归属维护</h2>'
      + '<span class="hint" style="margin:0">自动提取归属用于总览和本周报告；原条线与责任人资料保留</span></div>'
      + '<div class="cards" style="margin-bottom:14px">'
      + '<div class="stat s-blue"><div class="muted">节点总数</div><div class="n">' + S.milestones.length + '</div></div>'
      + DISCIPLINES.slice(0, 4).map(function (l) {
        return '<div class="stat"><div class="muted">' + esc(l) + '</div><div class="n">' + discCount[l] + '</div></div>';
      }).join('')
      + '<div class="stat ' + (noLine ? 's-red' : '') + '"><div class="muted">未归口</div><div class="n">' + noLine + '</div></div>'
      + '</div>'
      + '<div class="filters" style="margin-bottom:14px">'
      + '<div><label>项目</label><select onchange="App.filter(\'lineP\',this.value)"><option value="">全部项目</option>'
      + S.projects.map(function (p) {
        return '<option value="' + esc(p.id) + '"' + (pfilter === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      }).join('') + '</select></div>'
      + '<div><label>专业条线</label><select onchange="App.filter(\'lineL\',this.value)"><option value="">全部条线</option>'
      + DISCIPLINES.map(function (l) {
        return '<option value="' + esc(l) + '"' + (lfilter === l ? ' selected' : '') + '>' + esc(l) + '（' + discCount[l] + '）</option>';
      }).join('') + '</select></div>'
      + '<div class="no-print actions"><button class="btn primary" onclick="App.lineSaveAll()">保存全部改动</button>'
      + '<button class="btn ghost" onclick="App.clearFilter()">重置筛选</button></div>'
      + '</div>'
      + '<div class="hint" style="margin-bottom:10px">自动提取按明确住宅专业或商业模块匹配，待分配节点仅在管理总览提示。只有改动过的行会写入；已提交报告及历史保持原快照。</div>'
      + '<div class="tablewrap"><table><thead><tr>'
      + '<th style="width:12%">项目</th><th style="width:26%">节点</th><th style="width:9%">层级</th><th style="width:10%">计划</th>'
      + '<th>自动提取归属</th><th style="width:12%">原专业条线</th><th style="width:12%">责任部门</th><th style="width:10%">责任人</th><th style="width:6%">关键</th>'
      + '</tr></thead><tbody>'
      + (rows || '<tr><td colspan="8" class="empty">当前筛选条件下没有节点。</td></tr>')
      + '</tbody></table></div></div>';
  }

  /* ============ 项目主数据窗口 ============ */

  function captureAdminArchive() {
    if(window.ZHAdminArchive && window.ZHAdminArchive.capture)window.ZHAdminArchive.capture();
  }
  function adminArchiveContext(pid,projects) {
    var uid=S.uid,session=S.session,epoch=dataEpoch;
    function current(){return uid===S.uid && session===S.session && epoch===dataEpoch;}
    function authorized(target){
      if(!current())throw new Error('账号已切换，请重新打开当前项目资料。');
      if(target!==pid || !canEditMaster() || !myProjects().some(function(p){return p.id===pid;}))throw new Error('当前账号不能维护该项目资料。');
    }
    async function saveRow(table,key,row,id,remove){
      authorized(pid);
      var query=db.from(table),primary=table==='project_master'?'project_id':'id';
      if(remove)query=query.delete().eq('id',id).eq('project_id',pid);
      else if(table==='project_master')query=query.upsert(row,{onConflict:'project_id'});
      else if(id!==undefined && id!==null)query=query.update(row).eq('id',id).eq('project_id',pid);
      else query=query.insert(row);
      var result=await query.select();authorized(pid);
      if(result.error)throw new Error(result.error.message || '保存失败，请重试。');
      if(!result.data || !result.data.length)throw new Error('保存未完成，请核对当前项目权限。');
      var saved=result.data[0];
      if(remove)S[key]=(S[key] || []).filter(function(item){return String(item.id)!==String(id) || item.project_id!==pid;});
      else result.data.forEach(function(value){S[key]=(S[key] || []).filter(function(item){return String(item[primary])!==String(value[primary]);}).concat([value]);});
      var ok=await loadData([key],true);authorized(pid);
      if(!ok)toast('资料已保存，列表读取失败；当前已保存内容保留，可稍后刷新。','warn');
      return saved;
    }
    return {identity:String(uid)+'|'+epoch,projects:projects,pid:pid,tab:S.reporterArchiveTab,editable:canEditMaster(),
      catalogs:projects.map(function(p){return {project_id:p.id,name:p.name,catalog:masterFields(p.id).scheme_catalog};}),
      fields:masterFields(pid),phases:phasesOf(pid),drawings:drawingsOf(pid),milestones:msOf(pid),
      helpers:{esc:esc,richItem:richItem,sd:sd,dayDiff:dayDiff,lightOf:lightOf,devTxt:devTxt},
      saveFields:async function(patch,target){
        authorized(target);
        var latest=await db.from('project_master').select('fields').eq('project_id',pid).limit(1);authorized(target);
        if(latest.error)throw new Error(latest.error.message || '读取最新项目资料失败，请重试。');
        var serverFields=latest.data && latest.data[0] && latest.data[0].fields || {};
        return saveRow('project_master','master',{project_id:pid,fields:window.ZHAdminArchive.mergeFields(serverFields,patch),
          updated_by:S.profile.name || '',updated_at:new Date().toISOString()});
      },
      savePhase:async function(row,target){
        authorized(target);var value={project_id:pid};PHASE_COLS.forEach(function(col){if(Object.prototype.hasOwnProperty.call(row,col.k))value[col.k]=row[col.k];});
        if(Object.prototype.hasOwnProperty.call(row,'sort_order'))value.sort_order=row.sort_order;
        return saveRow('project_phases','phases',value,row.id);
      },
      deletePhase:async function(id,target){authorized(target);return saveRow('project_phases','phases',null,id,true);},
      uploadDrawing:async function(input,target){
        authorized(target);if(DRAWING_KINDS.indexOf(input.kind)<0)throw new Error('不支持的图纸分类。');
        var row={project_id:pid,kind:input.kind,name:input.name || input.file && input.file.name || input.kind,
          uploaded_by:S.profile.name || '',sort_order:drawingsOf(pid,input.kind).length};
        if(input.file){
          if(!input.file.size || input.file.size>8*1024*1024)throw new Error('单份图纸需大于0且不超过8MB。');
          var storage=cloud.storage;if(!storage)throw new Error('上传组件尚未就绪，请刷新后重试。');
          var ext=(String(input.file.name).match(/\.[A-Za-z0-9]+$/) || ['.png'])[0].toLowerCase();
          row.path=storage.sharedPath(uid,'drawings/'+pid+'/dr_'+Date.now()+'_'+Math.random().toString(36).slice(2,9)+ext);
          var api=storage.from('runtime'),uploaded=await api.upload(row.path,input.file,{contentType:input.file.type || 'application/octet-stream',upsert:false});authorized(target);
          if(uploaded && uploaded.error)throw new Error(uploaded.error.message || '图纸上传失败。');
          var pub=api.getPublicUrl(row.path);row.url=pub && pub.data && pub.data.publicUrl || pub && pub.publicUrl || '';
        }else{
          if(typeof input.url!=='string' || !/^https?:\/\//i.test(input.url))throw new Error('图纸链接需以http://或https://开头。');
          row.url=input.url;
        }
        return saveRow('project_drawings','drawings',row);
      },
      deleteDrawing:async function(id,target){authorized(target);return saveRow('project_drawings','drawings',null,id,true);},
      onChanged:async function(){if(current()){captureBriefDrafts();renderShell(true);}}
    };
  }
  function viewCoordinationPage() {
    var pid=S.pmProject,projects=myProjects();
    if(!pid)return '<div class="card empty">尚未分配项目。</div>';
    return '<div class="workgrid onecol"><div class="colmain"><section class="card"><div class="cardhd"><h3>协调申请 · '+esc(projName(pid))+'</h3>'
      +(projects.length>1?'<label>切换项目 <select aria-label="协调申请项目" onchange="App.switchProject(this.value)">'+projects.map(function(p){return '<option value="'+esc(p.id)+'"'+(p.id===pid?' selected':'')+'>'+esc(p.name)+'</option>';}).join('')+'</select></label>':'')+'</div></section>'
      +(window.CoordinationWorkbench?window.CoordinationWorkbench.render(pid):'<p class="muted">正在加载协调申请…</p>')+ownCoordinationHtml(pid)+'</div></div>';
  }
  function viewProjectLibrary() {
    var list=detailProjects(),pid=S.libraryProject;
    if(!list.some(function(p){return p.id===pid;}))pid=list[0] && list[0].id;
    S.libraryProject=pid;
    if(!pid)return '<div class="card empty">没有可访问的项目。</div>';
    return '<section class="card"><div class="cardhd"><label for="library-project">项目资料共享</label><select id="library-project" onchange="App.libraryProject(this.value)">'+list.map(function(p){return '<option value="'+esc(p.id)+'"'+(p.id===pid?' selected':'')+'>'+esc(p.name)+'</option>';}).join('')+'</select></div></section>'
      +(window.ProjectLibrary?window.ProjectLibrary.html(pid):'<div class="card empty">正在加载资料共享…</div>');
  }
  function viewMaster(fixedPid) {
    if (S.profile && S.profile.role === 'pm' && window.ZHReporterArchive) {
      var reporterProjects = myProjects(), reporterPid = fixedPid || S.masterPid || S.pmProject;
      if (!reporterProjects.some(function (p) {return p.id === reporterPid;})) reporterPid = reporterProjects[0] && reporterProjects[0].id;
      S.masterPid = reporterPid;
      return window.ZHReporterArchive.render({projects:reporterProjects,pid:reporterPid,tab:S.reporterArchiveTab,
        identity:String(S.uid || '')+'|'+dataEpoch,
        catalogs:reporterProjects.map(function(p){return {project_id:p.id,name:p.name,catalog:masterFields(p.id).scheme_catalog};}),
        fields:masterFields(reporterPid),phases:phasesOf(reporterPid),drawings:drawingsOf(reporterPid),milestones:msOf(reporterPid),
        helpers:{esc:esc,richItem:richItem,sd:sd,dayDiff:dayDiff,lightOf:lightOf,devTxt:devTxt}});
    }
    var list = fixedPid && isPzo() ? detailProjects() : myProjects();
    if (!list.length) return '<div class="card"><div class="empty">没有可查看的项目。</div></div>';
    var chosenPid=fixedPid || S.masterPid;
    var pid = (chosenPid && list.filter(function (p) { return p.id === chosenPid; }).length) ? chosenPid : list[0].id;
    S.masterPid = pid;
    var canEdit = canEditMaster();
    if(isPlanningManager() && window.ZHAdminArchive)return window.ZHAdminArchive.render(adminArchiveContext(pid,list));
    if(window.ZHReporterArchive && window.ZHProjectKnowledge && window.ZHProjectKnowledge.valid(masterFields(pid).scheme_catalog))return window.ZHReporterArchive.render(adminArchiveContext(pid,list));
    var mf = masterFields(pid), ph = phasesOf(pid), ps = phaseSum(pid);

    var pjSel = '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
      + '<div><label>项目</label><select onchange="App.masterPick(this.value)">'
      + list.map(function (p) {
        return '<option value="' + esc(p.id) + '"' + (p.id === pid ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      }).join('') + '</select></div>'
      + '<span class="hint" style="margin:0">' + (canEdit ? '运营可编辑并保存' : '只读：由运营管理员统一维护') + '</span></div>';
    if(fixedPid)pjSel='<span class="muted">'+(canEdit?'按现有权限维护项目档案':'项目档案只读')+'</span>';

    /* ① 设计数据 */
    var fieldRows = MASTER_FIELDS.map(function (x) {
      var v = mf[x.k] || '';
      return '<tr><td class="muted" style="width:32%">' + esc(x.t) + '</td><td>'
        + (canEdit ? '<input type="text" id="mf_' + x.k + '" value="' + esc(v) + '" style="width:100%" placeholder="—">'
          : '<b>' + esc(v || '—') + '</b>')
        + '</td></tr>';
    }).join('');

    /* ② 分期与销售套数 */
    function phaseRow(key, p) {
      return '<tr>' + PHASE_COLS.map(function (c) {
        var v = p && p[c.k] != null ? p[c.k] : '';
        return '<td>' + (canEdit
          ? '<input type="text" id="ph_' + c.k + '_' + key + '" value="' + esc(v) + '" style="width:100%">'
          : esc(v === '' ? '—' : v)) + '</td>';
      }).join('')
        + (canEdit ? '<td>' + (p ? '<button class="btn ghost sm" onclick="App.phaseDel(\'' + String(p.id) + '\',\'' + esc(pid) + '\')">删除</button>' : '') + '</td>' : '')
        + '</tr>';
    }
    var phaseRows = ph.map(function (p) { return phaseRow(String(p.id), p); }).join('');
    if (canEdit) phaseRows += phaseRow('new', null);
    var sumRow = '<tr style="background:#F5F7FA"><td><b>合计 / 去化率</b></td><td>—</td><td>—</td>'
      + '<td><b>' + (ps.total || '—') + '</b></td><td><b>' + (ps.launched || '—') + '</b></td>'
      + '<td><b>' + (ps.sold || '—') + '</b></td>'
      + '<td colspan="2"><b>' + (ps.rate == null ? '未推售' : ps.rate + '%') + '</b>'
      + (ps.rate == null ? '' : '（已售 / 已推）') + '</td>'
      + '<td colspan="' + (canEdit ? 2 : 1) + '"></td></tr>';

    /* ③ 项目图纸与附件：只对明确的图片链接生成缩略图。 */
    var drawingCards = DRAWING_KINDS.map(function (kind, ki) {
      var arr = drawingsOf(pid, kind);
      var items = arr.map(function (d) {
        var src = d.url || '';
        var isPdf = /\.pdf(?:[?#]|$)/i.test(d.path || src) || /\.pdf$/i.test(d.name || '');
        var isImage = !isPdf && /\.(?:png|jpe?g|gif|webp)(?:[?#]|$)/i.test(d.path || src);
        return '<div style="border:0.5px solid #D3D1C7;border-radius:10px;padding:8px;background:#FFFFFF">'
          + (src
            ? (isImage ? '<a href="' + esc(src) + '" target="_blank" rel="noopener"><img src="' + esc(src) + '" alt="' + esc(d.name)
              + '" style="width:100%;height:148px;object-fit:cover;border-radius:6px;display:block"></a>'
              : '<div style="height:148px;display:flex;align-items:center;justify-content:center"><a class="btn ghost sm" href="' + esc(src)
                + '" target="_blank" rel="noopener">' + (isPdf ? '打开 PDF 文档' : '打开附件链接') + '</a></div>')
            : '<div class="hint" style="margin:0;height:148px;display:flex;align-items:center;justify-content:center">无预览</div>')
          + '<div style="margin-top:6px;font-size:12.5px;color:#1F2937">' + esc(d.name) + '</div>'
          + '<div style="font-size:11.5px;color:#6B7280">' + esc(d.uploaded_by || '—') + '　' + esc(sd(d.created_at)) + '</div>'
          + (canEdit ? '<button class="btn ghost sm" style="margin-top:6px" onclick="App.drawDel(\'' + String(d.id) + '\',\'' + esc(pid) + '\')">删除</button>' : '')
          + '</div>';
      }).join('');
      var tools = canEdit
        ? '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
          + '<input type="file" id="dw_file_' + ki + '" accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,image/png,image/jpeg,image/gif,image/webp,application/pdf" style="font-size:12.5px;max-width:230px">'
          + '<button class="btn primary sm" onclick="App.drawUpload(\'' + esc(pid) + '\',' + ki + ')">上传</button>'
          + '<input type="text" id="dw_name_' + ki + '" placeholder="名称（可空）" style="width:130px">'
          + '<input type="text" id="dw_url_' + ki + '" placeholder="或粘贴图片 / 云盘链接" style="width:210px">'
          + '<button class="btn ghost sm" onclick="App.drawLinkAdd(\'' + esc(pid) + '\',' + ki + ')">登记链接</button>'
          + '</div>'
        : '';
      return '<div class="card"><div class="cardhd"><h3>' + esc(kind) + '<span class="chip">' + arr.length + ' 张</span></h3></div>'
        + (items ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px">' + items + '</div>'
          : '<div class="hint" style="margin:0">尚未上传。</div>')
        + tools + '</div>';
    }).join('');

    /* ④ 节点计划（自动引用节点表） */
    var msRows = msOf(pid).map(function (m) {
      var d = m.done ? null : dayDiff(m.forecast_date, m.plan_date);
      var L = m.done ? 'gray' : lightOf(d);
      return '<tr><td>' + richItem(m, 'name') + (m.is_key ? ' <span class="chip key">关键</span>' : '') + '</td>'
        + '<td class="muted">' + esc(m.line || '—') + '</td>'
        + '<td class="muted">' + esc(m.level || '') + '</td>'
        + '<td class="muted">' + esc(sd(m.plan_date)) + '</td>'
        + '<td>' + (m.done ? '<span class="badge gray">已完成</span>' : esc(sd(m.forecast_date))) + '</td>'
        + '<td>' + (m.done ? '—' : devTxt(d)) + '</td>'
        + '<td><span class="dot d-' + L + '"></span>'
        + deviationStatus(d,m.done) + '</td></tr>';
    }).join('');

    return '<div class="card"><div class="cardhd"><h2 style="margin:0">项目主数据</h2></div>' + pjSel + '</div>'

      + '<div class="card"><div class="cardhd"><h3>设计数据</h3>'
      + '<span class="hint" style="margin:0">指标口径由运营统一维护，各专业只读</span></div>'
      + '<div class="tablewrap"><table><tbody>' + fieldRows + '</tbody></table></div>'
      + (canEdit ? '<div style="margin-top:12px"><button class="btn primary sm" onclick="App.masterSave(\'' + esc(pid) + '\')">保存设计数据</button></div>' : '')
      + '</div>'

      + '<div class="card"><div class="cardhd"><h3>分期与销售套数<span class="chip">' + ph.length + ' 期</span></h3>'
      + '<span class="hint" style="margin:0">按分期录入，合计与去化率自动计算</span></div>'
      + '<div class="tablewrap"><table><thead><tr>'
      + PHASE_COLS.map(function (c) { return '<th style="width:' + c.w + '">' + esc(c.t) + '</th>'; }).join('')
      + (canEdit ? '<th style="width:70px"></th>' : '') + '</tr></thead><tbody>'
      + (phaseRows || '<tr><td colspan="' + PHASE_COLS.length + '" class="empty">暂无分期数据。</td></tr>')
      + sumRow + '</tbody></table></div>'
      + (canEdit ? '<div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
        + '<button class="btn primary sm" onclick="App.phasesSave(\'' + esc(pid) + '\')">保存分期与销售套数</button>'
        + '<span class="hint" style="margin:0">最后一行留空即为新增分期，填了分期名称才会写入</span></div>' : '')
      + '</div>'

      + '<div class="card"><div class="cardhd"><h3>节点计划<span class="chip">' + msOf(pid).length + ' 条</span></h3>'
      + '<span class="hint" style="margin:0">直接引用节点表，不另行录入；预计时间由各条线在「我的条线」更新</span></div>'
      + '<div class="tablewrap"><table><thead><tr><th style="width:32%">节点</th><th style="width:10%">条线</th>'
      + '<th style="width:12%">层级</th><th style="width:12%">计划</th><th style="width:13%">预计</th>'
      + '<th style="width:10%">偏差</th><th style="width:9%">灯号</th></tr></thead><tbody>'
      + (msRows || '<tr><td colspan="7" class="empty">暂无节点。</td></tr>') + '</tbody></table></div></div>'

      + '<div class="card"><div class="cardhd"><h3>图纸：项目总图 / 分期图 / 户型图</h3>'
      + '<span class="hint" style="margin:0">支持 PNG、JPEG、GIF、WebP、PDF，单份不超过 8MB；文件保存在本系统，仅有项目权限的已审核账号可查看；更大文件请登记链接</span></div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px">' + drawingCards + '</div></div>';
  }

  function viewDual() {
    var list = S.projects.filter(function (p) { return ptype(p.id) === S.ptype; }).slice().sort(function (a, b) {
      var sa = dualAssessment(a.id).speed, sb = dualAssessment(b.id).speed;
      return SPEED.indexOf(sb) - SPEED.indexOf(sa);
    });
    var grid = {};
    /* 效果以本期领导评价为准，尚未评价时单列。 */
    var effectRows = EFFECT.concat([NO_EFFECT]);
    effectRows.forEach(function (e) { grid[e] = { 领跑: [], 达标: [], 滞后: [] }; });
    list.forEach(function (p) {
      var assessment = dualAssessment(p.id);
      var sp = assessment.speed;
      var ef = assessment.effect;
      if (!grid[ef]) grid[ef] = { 领跑: [], 达标: [], 滞后: [] };
      if (!grid[ef][sp]) grid[ef][sp] = [];
      grid[ef][sp].push(p);
    });

    var matrix = effectRows.map(function (e) {
      return '<tr><td class="mxlabel">' + effectPill(e) + '</td>'
        + SPEED.map(function (s) {
            var cell = (grid[e] && grid[e][s]) || [];
            return '<td class="mxcell"><div class="mxtitle">' + cell.length + ' 个</div>'
              + cell.map(function (p) {
                  var lv = statusOf(p.id);
                  return '<span class="mxchip ' + (lv === '异常' ? 'red' : lv === '关注' ? 'amber' : 'green') + '" onclick="App.jumpProject(\'' + esc(p.id) + '\')">' + esc(p.name) + '</span>';
                }).join('') + '</td>';
          }).join('') + '</tr>';
    }).join('');

    var rows = list.map(function (p) {
      var r = latestReport(p.id);
      var assessment = dualAssessment(p.id);
      var sp = (r && r.speed_items || []).filter(function (x) { return x.act; });
      var ef = (r && r.effect_items || []).filter(function (x) { return x.act; });
      var nk = nextKey(p.id);
      var d = nk ? dayDiff(nk.forecast_date, nk.plan_date) : null;
      return '<tr>'
        + '<td><b>' + esc(p.name) + '</b><div class="muted" style="margin-top:3px">' + esc(pmOf(p.id)) + '</div></td>'
        + '<td>' + badge(statusOf(p.id)) + '</td>'
        + '<td>' + (nk ? richItem(nk, 'name') + '<br>' + devTxt(d) : '—') + '</td>'
        + '<td>' + speedPill(assessment.speed) + '</td>'
        + '<td>' + effectPill(assessment.effect) + '</td>'
        + '<td>' + (sp.length ? sp.map(function (x) { return '· ' + richItem(x, 'act') + (x.gain ? '（' + richItem(x, 'gain') + '）' : ''); }).join('<br>') : '<span class="muted">—</span>') + '</td>'
        + '<td>' + (ef.length ? ef.map(function (x) { return '· ' + richItem(x, 'act') + (x.target ? '（' + richItem(x, 'target') + '）' : ''); }).join('<br>') : '<span class="muted">—</span>') + '</td>'
        + '</tr>';
    }).join('');

    return '<div class="card">'
      + '<div class="cardhd"><h2 style="margin:0">经营双维矩阵</h2>'
      + '<span class="hint" style="margin:0">纵向＝做得好不好，横向＝做得快不快；点项目名可跳转</span></div>'
      + '<div class="tablewrap"><table class="dualmatrix"><thead><tr><th style="width:110px"></th>'
      + SPEED.map(function (s) { return '<th>' + s + '</th>'; }).join('') + '</tr></thead><tbody>' + matrix + '</tbody></table></div>'
      + '<div class="notice" style="margin:14px 0 0">矩阵按本期总裁评价展示；未评价的项目单独列出。速度尚未评价时，按节点偏差自动判断。</div>'
      + '</div>'

      + '<div class="card">'
      + '<div class="cardhd"><h2 style="margin:0">各项目经营对策</h2><span class="hint" style="margin:0">提速对策与效果保障成对出现</span></div>'
      + '<div class="tablewrap"><table><thead><tr><th style="width:13%">项目</th><th style="width:7%">状态</th><th style="width:16%">下一节点 / 偏差</th>'
      + '<th style="width:7%">速度</th><th style="width:7%">效果</th><th style="width:25%">⚡ 提速对策</th><th style="width:25%">🛡 效果保障</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div></div>';
  }

  function nodeDetailData() {
    var state=dataState.nodeStatistics,kind=S.view==='nodesCom'?'com':'res';
    if(!state || !state.ready || state.error || state.scope!==kind)return null;
    var list = detailProjects().filter(function (p) { return ptype(p.id) === S.ptype; });
    if (S.filters.project) list = list.filter(function (p) { return p.id === S.filters.project; });
    var rows = [],valid=true,statuses=Object.create(null);
    (S.nodeStatistics || []).forEach(function(row){statuses[row.source_key]=row;});
    list.forEach(function (p) {
      msOf(p.id).forEach(function (m) {
        var status=statuses['milestone:'+p.id+':'+m.id];
        if(!status){valid=false;return;}
        rows.push({p:p,m:Object.assign({},m,{name:status.title,done:status.completed,plan_date:status.plan_due,forecast_date:status.forecast_due}),d:status.deviation});
      });
    });
    rows.sort(function (a, b) {
      var da = a.d === null ? -999 : a.d, dbb = b.d === null ? -999 : b.d;
      if (dbb !== da) return dbb - da;
      return String(a.m.plan_date || '').localeCompare(String(b.m.plan_date || ''));
    });
    var onlyKey = S.filters.status === 'key';
    if (onlyKey) rows = rows.filter(function (r) { return r.m.is_key; });
    return valid?{projects:list,rows:rows}:null;
  }
  function viewNodes() {
    var data=nodeDetailData();
    if(!data)return '<div class="card notice err" role="alert">节点有效审核状态尚未读取或未匹配，请刷新数据后重试；当前不显示完成判断或导出。</div>';
    var list=data.projects,rows=data.rows;

    var body = rows.map(function (r) {
      var L = r.m.done ? 'gray' : lightOf(r.d);
      return '<tr>'
        + '<td><b>' + esc(r.p.name) + '</b></td>'
        + '<td>' + esc(r.m.name) + (r.m.is_key ? ' <span class="chip key">关键</span>' : '') + '</td>'
        + '<td class="muted">' + esc(r.m.level || '') + '</td>'
        + '<td class="muted">' + esc(sd(r.m.plan_date)) + '</td>'
        + '<td>' + (r.m.done ? '<span class="badge gray">已完成</span>' : esc(sd(r.m.forecast_date))) + '</td>'
        + '<td>' + (r.m.done ? '—' : devTxt(r.d)) + '</td>'
        + '<td><span class="dot d-' + L + '"></span>' + deviationStatus(r.d,r.m.done) + '</td>'
        + '</tr>';
    }).join('');

    var verRows = S.versions.filter(function (v) { return list.some(function(p){return p.id===v.project_id;}); }).map(function (v) {
      return '<tr><td><b>' + esc(projName(v.project_id)) + '</b></td><td>' + esc(v.version_name) + '</td>'
        + '<td class="muted">' + esc(sd(v.effective_date)) + '</td><td class="muted">' + esc(v.note || '—') + '</td></tr>';
    }).join('');
    var com = S.ptype === 'com';

    return '<div class="card"><div class="cardhd"><h2 style="margin:0">' + (com ? '商业基准节点明细' : '住宅节点偏差') + '</h2>'
      + '<span class="hint" style="margin:0">' + (com ? '商业基准节点；完成状态与项目计划统计采用同一有效审核口径，月计划保留在本期填报第二部分' : '按较计划引导值的偏差排序；完成状态与项目计划统计采用同一有效审核口径') + '</span></div>'
      + '<div class="filters" style="margin-bottom:14px">'
      + '<div><label>项目</label><select onchange="App.filter(\'project\',this.value)"><option value="">' + (com ? '全部商业项目' : '全部住宅项目') + '</option>'
      + detailProjects().filter(function (p) { return ptype(p.id) === S.ptype; })
          .map(function (p) { return '<option value="' + esc(p.id) + '" ' + (S.filters.project === p.id ? 'selected' : '') + '>' + esc(p.name) + '</option>'; }).join('')
      + '</select></div>'
      + '<div><label>范围</label><select onchange="App.filter(\'status\',this.value)">'
      + '<option value="">全部节点</option><option value="key" ' + (S.filters.status === 'key' ? 'selected' : '') + '>只看关键节点</option></select></div>'
      + '<div class="no-print actions"><button class="btn ghost" onclick="App.exportNodes()">导出 Excel</button>'
      + '<button class="btn ghost" onclick="App.clearFilter()">重置</button></div></div>'
      + '<div class="tablewrap"><table><thead><tr><th style="width:13%">项目</th><th style="width:26%">节点</th><th style="width:9%">层级</th>'
      + '<th style="width:10%">计划（引导）</th><th style="width:11%">本周预计</th><th style="width:10%">较计划</th><th style="width:9%">灯号</th></tr></thead>'
      + '<tbody>' + (rows.length ? body : '<tr><td colspan="7" class="empty">没有节点。</td></tr>') + '</tbody></table></div></div>'

      + '<div class="card"><div class="cardhd"><h3>计划版本台账</h3><span class="hint" style="margin:0">每次计划更新都应被记录，节点被推后必须解释</span></div>'
      + '<div class="tablewrap"><table><thead><tr><th style="width:20%">项目</th><th style="width:16%">版本</th><th style="width:14%">生效日期</th><th>说明</th></tr></thead>'
      + '<tbody>' + (verRows || '<tr><td colspan="4" class="empty">暂无计划版本记录。</td></tr>') + '</tbody></table></div></div>';
  }

  function viewCoord() {
    var co = allCoord();
    var byWho = {};
    co.forEach(function (c) { (byWho[c.who] = byWho[c.who] || []).push(c); });
    var who = Object.keys(byWho).sort(function (a, b) { return byWho[b].length - byWho[a].length; });

    var body = who.map(function (w) {
      var items = byWho[w];
      return '<tr><td><b>' + esc(w) + '</b><div class="muted" style="margin-top:3px">' + items.length + ' 项</div></td>'
        + '<td>' + items.map(function (c) {
            return '<div style="margin-bottom:6px">· <b>' + esc(c.pid?projName(c.pid):'统一范围事项（原记录未明确实际项目）') + '</b>：' + (c.whatHtml || richItem(c, 'what')) + (c.by ? '<span class="muted">（最晚 ' + esc(c.by) + '）</span>' : '') + '</div>';
          }).join('') + '</td></tr>';
    }).join('');

    var direct=(S.coordinationTasks || []).filter(function(row){return !S.filters.project || row.project_id===S.filters.project;});
    var directHtml='<section class="card"><div class="cardhd"><h3>独立协调事项<span class="chip">'+direct.length+' 项</span></h3></div><p class="muted">发起人直接提出，承办人办理，完成与延期由发起人确认；此处只读查看。</p>'
      +'<div class="tablewrap"><table><thead><tr><th>项目</th><th>发起人</th><th>承办人</th><th>具体事项</th><th>最晚日期</th><th>申报状态</th></tr></thead><tbody>'
      +(direct.length?direct.map(function(row){return '<tr><td>'+esc(projName(row.project_id))+'</td><td>'+esc(row.author_name || '')+'</td><td>'+esc(row.owner_name || '')+'</td><td style="white-space:pre-wrap">'+richItem(row,'what')+'</td><td>'+esc(sd(row.due))+'</td><td>'
        +(window.CompletionReview?window.CompletionReview.actionHtml(row.source_key || 'coord:'+row.project_id+':'+row.id,{owner_id:row.owner_id,readOnly:true}):'<span class="muted">等待承办人申报</span>')+'</td></tr>';}).join(''):'<tr><td colspan="6" class="empty">暂无独立协调事项。</td></tr>')+'</tbody></table></div></section>';
    return directHtml+'<div class="card"><div class="cardhd"><h2 style="margin:0">周报中的协调与支持需求</h2>'
      + '<span class="hint" style="margin:0">本期共 ' + co.length + ' 项 · 按对象聚合</span></div>'
      + '<div class="hint" style="margin-bottom:12px">项目经理只填自己解决不了的事；同一对象被多人求助，说明这是共性堵点。</div>'
      + '<div class="tablewrap"><table><thead><tr><th style="width:20%">协调对象</th><th>事项</th></tr></thead>'
      + '<tbody>' + (body || '<tr><td colspan="2" class="empty">本期暂无协调需求。</td></tr>') + '</tbody></table></div></div>'
      + '<div class="card"><h3>说明</h3><div class="muted">协调对象来自公司组织通讯录，可精确到决策层 / 管理层 / 专业条线。总裁端只需要关注落在「决策层」的事项。</div></div>';
  }

  function viewMembers() {
    var rows = S.members.map(function (m) {
      var mine = S.pms.filter(function (x) { return x.user_id === m.user_id; }).map(function (x) { return x.project_id; });
      if (m.project_id && mine.indexOf(m.project_id) < 0) mine.push(m.project_id);
      var chips = mine.map(function (pid) {
        return '<span class="pchip">' + esc(projName(pid)) + '<b onclick="App.memberUnassign(\'' + esc(m.user_id) + '\',\'' + esc(pid) + '\')">×</b></span>';
      }).join('');
      var rest = S.projects.filter(function (p) { return mine.indexOf(p.id) < 0; });
      var addSel = rest.length
        ? '<select onchange="App.memberAssign(\'' + esc(m.user_id) + '\',this.value)" style="width:150px;margin-top:6px"><option value="">＋ 添加项目</option>'
          + rest.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'; }).join('') + '</select>'
        : '';
      var isPending = m.status !== 'approved' || (m.role === 'pm' && !mine.length);
      var hasCom = mine.filter(function (pid) { return isCom(pid); }).length > 0;
      var lineCell = hasCom
        ? '<select onchange="App.memberSet(\'' + esc(m.user_id) + '\',\'biz_line\',this.value)">'
          + ['<option value="">未指定模块</option>', '<option value="*"' + (m.biz_line === '*' ? ' selected' : '') + '>全部商业模块（测试）</option>'].concat(businessLinesForProjects(S.projects.filter(function(p){return mine.indexOf(p.id)>=0 && isCom(p.id);})).map(function (l) {
              return '<option value="' + esc(l) + '"' + (m.biz_line === l ? ' selected' : '') + '>' + esc(l) + '</option>';
            })).join('') + '</select>'
        : '<span class="muted">—</span>';
      var extras=(S.businessModuleGrants || []).filter(function(grant){return grant.user_id===m.user_id && grant.project_id==='hf' && grant.line==='设计部' && mine.includes(grant.project_id);});
      if(extras.length)lineCell+='<div class="muted">附加专业：'+extras.map(function(grant){return esc(grant.line)+'（'+esc(projName(grant.project_id))+'）';}).join('、')+'</div>';
      /* 专业条线（组织口径）：指定后该成员在「我的条线」只看本专业的节点 */
      var discCell = m.role === 'pm'
        ? '<select onchange="App.memberSet(\'' + esc(m.user_id) + '\',\'discipline\',this.value)">'
          + ['<option value="">未指定条线</option>'].concat(DISCIPLINES.map(function (l) {
              return '<option value="' + esc(l) + '"' + (m.discipline === l ? ' selected' : '') + '>' + esc(l) + '</option>';
            })).join('') + '</select>'
        : '<span class="muted">—</span>';
      return '<tr>'
        + '<td><b>' + esc(m.name || '未填写姓名') + '</b>' + (isPending ? ' <span class="badge yellow">待处理</span>' : '') + '</td>'
        + '<td><select onchange="App.memberSet(\'' + esc(m.user_id) + '\',\'role\',this.value)">'
        + ['pm', 'ops', 'president', 'pzo', 'viewer'].map(function (r) { return '<option value="' + r + '" ' + (m.role === r ? 'selected' : '') + '>' + ROLE_LABEL[r] + '</option>'; }).join('')
        + '</select></td>'
        + '<td>' + (m.role === 'pm' ? (chips || '<span class="muted">未分配</span>') + addSel : m.role==='viewer'?'<span class="muted">全部项目（只读）</span>':'<span class="muted">全部项目（汇总端）</span>') + '</td>'
        + '<td>' + discCell + '</td>'
        + '<td>' + lineCell + '</td>'
        + '<td>' + (m.role==='pm'?'<label><input type="checkbox" '+(m.management_viewer?'checked ':'')+'onchange="App.memberSet(\''+esc(m.user_id)+'\',\'management_viewer\',this.checked)">全项目只读</label>':m.role==='viewer'?'<span class="muted">全部项目只读</span>':'<span class="muted">—</span>') + '</td>'
        + '<td><select onchange="App.memberSet(\'' + esc(m.user_id) + '\',\'status\',this.value)">'
        + ['pending', 'approved'].map(function (s) { return '<option value="' + s + '" ' + (m.status === s ? 'selected' : '') + '>' + (s === 'approved' ? '已通过' : '待审核') + '</option>'; }).join('')
        + '</select></td>'
        + '<td class="muted">' + esc(fmtTime(m.created_at)) + '</td></tr>';
    }).join('');

    return '<div class="card"><h2>成员管理</h2>'
      + '<div class="notice"><b>账号角色</b>：提报人、管理员、总裁、项目总、查看人。查看人仅可查看全部项目的事项管理与项目资料；提报人可另外授权全项目只读，原填报职责不变。自助注册固定为「待审核」的提报人，角色与只读权限由管理员授权。<br>'
      + '<b>项目类型</b>：住宅与商业共用提报人角色，按获授权项目显示相应表单。商业项目（弘坊）沿用已分配的专业模块，各人填报自己获授权的部分。<br>'
      + '<b>特殊账号权限</b>：管理员管理项目和成员；总裁查看计划总览并记录总裁交代；项目总查看商业计划总览并记录项目总安排。历史评价保留只读，具体操作沿用现有权限，特殊账号均不能修改他人的原始提报。<br>'
      + '<b>专业条线</b>：指定后该成员在工作台只看本专业的节点；未指定时，按原项目范围查看全部节点。</div>'
      + '<div class="tablewrap"><table><thead><tr><th style="width:12%">姓名</th><th style="width:11%">账号角色</th><th style="width:22%">负责项目</th>'
      + '<th style="width:13%">专业条线</th>'
      + '<th style="width:15%">填报模块（商业项目）</th>'
      + '<th>管理查看权限</th>'
      + '<th style="width:11%">审核状态</th><th style="width:12%">加入时间</th></tr></thead>'
      + '<tbody>' + (rows || '<tr><td colspan="8" class="empty">暂无成员。</td></tr>') + '</tbody></table></div></div>';
  }

  /* ================= 外壳 ================= */

  /* 报告周期下拉：近 12 周 + 本项目已填报过的历史周期。
     原为自由文本输入，一旦写错格式（如漏掉括号）weekNo() 取不到值，
     该期数据就会脱离主流程，故改为下拉选择。 */
  function periodList() {
    var set = {};
    for (var i = 0; i < 12; i++) {
      var d = calendarToday(); d.setDate(d.getDate() - i * 7);
      set['第' + isoWeek(d) + '周（' + weekRange(d) + '）'] = true;
    }
    pmHistoryReports().forEach(function (r) { if (r.period) set[r.period] = true; });
    var list = Object.keys(set).sort(function (a, b) { return (weekNo(b) || 0) - (weekNo(a) || 0); });
    if (S.pmPeriod && list.indexOf(S.pmPeriod) < 0) list.unshift(S.pmPeriod);
    return list;
  }
  function periodOptionsHtml() {
    return periodList().map(function (p) {
      return '<option value="' + esc(p) + '"' + (S.pmPeriod === p ? ' selected' : '') + '>' + esc(p) + '</option>';
    }).join('');
  }

  /* 运营端左侧导航：汇总按「住宅 / 商业」分成两组，其余为协同与配置
     k=导航键（唯一）· v=视图 · pt=该页只看哪类项目 · g=分组标题（空则该页归入上一分组） */
  function opsNav() {
    return [
      { k: 'pres', v: 'pres', label: '报总裁浏览版（住宅）', pt: 'res', title: '报总裁浏览版 · 住宅项目', sub: '住宅项目一览；住宅项目卡下方可直接填写总裁评价与总裁交代' },
      { g: '住宅汇总', k: 'board', v: 'board', label: '运营汇总', pt: 'res', title: '住宅项目 · 运营汇总', sub: '住宅项目周度经营全景，异常与关注优先' },
      { k: 'dual', v: 'dual', label: '经营双维', pt: 'res', title: '住宅项目 · 经营双维', sub: '纵向＝做得好不好，横向＝做得快不快' },
      { k: 'nodes', v: 'nodes', label: '节点偏差总表', pt: 'res', title: '住宅项目 · 节点偏差总表', sub: '全部关键节点计划与实际对比，含计划版本台账' },
      { g: '商业汇总', k: 'boardCom', v: 'board', label: '弘坊汇总', pt: 'com', title: '商业项目 · 弘坊汇总', sub: '各模块当期工作、过期事项、工作面移交与协调需求' },
      { k: 'nodesCom', v: 'nodes', label: '节点偏差总表', pt: 'com', title: '商业项目 · 节点偏差总表', sub: '弘坊开业倒排节点的计划与实际对比' },
      { k: 'presCom', v: 'presCom', label: '报总裁浏览版（商业）', pt: 'com', title: '报总裁浏览版 · 商业项目一览', sub: '弘坊各专业当期填报一览（多专业提报）；总裁可写总裁交代' },
      { k: 'presPzo', v: 'presPzo', label: '报项目总浏览版', pt: 'com', title: '商业项目 · 报项目总浏览版', sub: '弘坊各专业当期填报一览，供项目总评价与批示' },
      { g: '协同与配置', k: 'coord', v: 'coord', label: '协调与支持', pt: '', title: '协调与支持', sub: '按协调对象聚合，供周例会直接使用' },
      { k:'completion',v:'completion',label:'事项审核',pt:'',title:'事项审核',sub:'逐条核对完成和延期申请及历史记录' },
      { k:'meetings',v:'meetings',label:'会议事项',pt:'',title:'会议事项',sub:'运营录入、分派会议事项，承办人维护进展' },
      { k:'completionStats',v:'completionStats',label:'员工完成统计',pt:'',title:'员工完成统计',sub:'按实际完成日期统计当前有效的已审核完成事项' },
      { k: 'master', v: 'master', label: '项目主数据', pt: '', title: '项目主数据', sub: '节点计划 / 项目总图 / 分期图 / 设计数据 / 销售套数，一处看全' },
      { k: 'lineAdm', v: 'lineAdm', label: '节点归属维护', pt: '', title: '节点归属维护', sub: '维护节点自动提取的住宅专业与商业模块归属' },
      { k: 'members', v: 'members', label: '成员管理', pt: '', title: '成员管理', sub: '审核成员、分配负责项目与填报模块' }
    ];
  }

  function planningNavItems() {
    var role=S.profile.role, items;
    if(role==='viewer')return managementNavItems();
    if(role==='pzo'){
      var assignedProjects=myProjects();
      items=[{k:'pres',v:'pres',pt:'res',label:'住宅计划总览',group:'overview'},
        {k:'presCom',v:'presCom',pt:'com',label:'商业计划总览',group:'overview'}].filter(function(item){
          return !assignedProjects.length || assignedProjects.some(function(p){return (isCom(p.id)?'com':'res')===item.pt;});
        });
    }
    else if(role==='president') items=[
      {k:'pres',v:'pres',pt:'res',label:'住宅计划总览',group:'overview'},
      {k:'presCom',v:'presCom',pt:'com',label:'商业计划总览',group:'overview'}];
    else if(isReviewer()) items=opsNav().filter(function(item){return ['board','boardCom','presPzo','dual','nodes','nodesCom'].indexOf(item.k)<0;}).map(function(item){
      var groups={pres:'overview',presCom:'overview',coord:'collaboration',completion:'collaboration',completionStats:'analysis',meetings:'collaboration',master:'projects',lineAdm:'settings',members:'settings'};
      var labels={pres:'住宅计划总览',presCom:'商业计划总览',master:'项目档案',members:'成员与权限',lineAdm:'节点归属设置',coord:'协调需求',completion:'完成与延期审核',meetings:'会议管理'};
      return Object.assign({},item,{group:groups[item.k],label:labels[item.k] || item.label});
    });
    else items=[{k:'center',v:'center',label:'个人概览',group:'work'},
      {k:'mline',v:'mline',label:'条线节点',group:'work'},
      {k:'coordination',v:'coordination',label:'协调申请',group:'work'},
      {k:'form',v:'form',label:'本期填报',group:'form'},
      {k:'master',v:'master',label:'项目档案',group:'projects'},
      {k:'history',v:'history',label:'历史记录',group:'history'}];
    if(isPlanningManager()){
      var analysisIndex=items.findIndex(function(item){return item.group==='analysis';});
      items.splice(analysisIndex<0?items.length:analysisIndex,0,{k:'projectPlanStats',v:'projectPlanStats',label:'项目计划统计',title:'项目计划统计',group:'analysis'});
    }
    if(role==='ops')items.splice(items.findIndex(function(item){return item.k==='presCom';})+1,0,{k:'adminPlans',v:'adminPlans',label:'批量导入计划',title:'代填与批量导入计划',group:'overview'});
    items.push({k:'library',v:'library',label:'资料共享',group:'projects'});
    if(role==='pm' && canReadManagement())items=items.concat(managementNavItems());
    return items;
  }
  function canReadManagement() { return !!(S.profile && S.profile.status==='approved' && (S.profile.role==='viewer' || S.profile.role==='pm' && S.profile.management_viewer===true)); }
  function managementNavItems() { return [
    {k:'managementCoord',v:'managementCoord',label:'协调需求（只读）',group:'collaboration'},
    {k:'managementCompletion',v:'managementCompletion',label:'完成与延期记录',group:'collaboration'},
    {k:'managementMeetings',v:'managementMeetings',label:'会议事项（只读）',group:'collaboration'},
    {k:'managementArchive',v:'managementArchive',label:'全项目档案（只读）',group:'projects'},
    {k:'managementLibrary',v:'managementLibrary',label:'全项目资料共享（只读）',group:'projects'}]; }
  function isManagementReadView(view) { return canReadManagement() && managementNavItems().some(function(item){return item.k===view;}); }
  function isPlanningManager() { return isReviewer() || isPzo(); }
  function planningGroups(items) {
    var labels={work:'工作台',form:'本期填报',projects:'项目资料',history:'历史记录',overview:'计划总览',analysis:'统计分析',collaboration:'事项管理',settings:'系统设置'};
    var order=S.profile.role==='viewer'?['collaboration','projects']:isPlanningManager()?['overview','analysis','collaboration','projects','settings']:['work','form','collaboration','projects','history'];
    return order.filter(function(key){return items.some(function(item){return item.group===key;});}).map(function(key){return {key:key,label:labels[key]};});
  }
  function detailProjects() {
    return myProjects();
  }
  function projectDetailButton(pid) {
    return '<button type="button" class="btn link sm project-detail-link" onclick="App.openProjectDetail(\''+esc(pid)+'\')">查看详情</button>';
  }
  function detailLeaderReadOnly(pid,period,reviewsOnly) {
    var reviews=S.reviews.filter(function(row){return row.project_id===pid && row.period===period;});
    var notes=S.leaderNotes.filter(function(row){return row.project_id===pid && row.period===period;});
    var reviewsHtml=reviews.map(function(row){return '<section class="plan-leader-record"><h3>'+(row.kind==='pzo'?'项目总评价':'总裁评价')+'</h3><div class="mini">'
      +(row.speed?'<div><span>速度</span><b>'+esc(row.speed)+'</b></div>':'')
      +(row.effect?'<div><span>效果</span><b>'+esc(row.effect)+'</b></div>':'')
      +(row.rating?'<div><span>评级</span><b>'+esc(row.rating)+'</b></div>':'')
      +(row.note?'<div><span>评语</span><div>'+richItem(row,'note')+'</div></div>':'')+'</div><p class="muted">'+leaderMeta(row)+'</p></section>';}).join('');
    var notesHtml=notes.map(function(row){return '<article class="plan-leader-record"><h3>'+(row.kind==='pzo_note'?'项目总批示':'总裁交代')+'</h3><div>'+richItem(row,'what')+'</div><p class="muted">'+esc(row.due?'最晚 '+row.due:'未设最晚时间')+' · '+esc(row.author_name || '')+'</p></article>';}).join('');
    return reviewsHtml+(reviewsOnly?'':notesHtml) || '<div class="empty">该周期暂无领导评价与交代。</div>';
  }
  function detailLeaderEditable(pid) {
    var hasReviews=S.reviews.some(function(row){return row.project_id===pid && row.period===currentPeriod();});
    var html=hasReviews?'<details class="plan-leader-history"><summary>已保存评价（只读）</summary>'+detailLeaderReadOnly(pid,currentPeriod(),true)+'</details>':'';
    html+=overviewArrangeButtons(pid,null);
    ['ceo','pzo'].forEach(function(kind){
      var can=kind==='ceo'?canWriteCeo():canWritePzo(), noteKind=kind==='ceo'?'ceo_brief':'pzo_note';
      var rows=can?briefDraftRows(pid,noteKind):briefsOf(pid,noteKind);
      if(!rows.length && !briefsOf(pid,noteKind).length)return;
      html+='<section class="plan-leader-record"><h3>'+(kind==='ceo'?'既有总裁交代':'既有项目总安排')+'</h3>'+briefRowsHtml(pid,noteKind,can)
        +(can?'<div class="actions no-print"><button class="btn primary sm" onclick="App.'+(kind==='ceo'?'saveCeoBriefs':'savePzoNotes')+'(\''+esc(pid)+'\')">保存既有'+(kind==='ceo'?'交代':'批示')+'</button></div>':'')+'</section>';
    });
    return html;
  }
  function viewProjectDetail() {
    var projects=detailProjects(), project=projects.filter(function(p){return p.id===S.detailPid;})[0];
    if(!project)return '<div class="card empty">该项目不在当前可查看范围内。</div>';
    var all=S.reports.filter(function(row){return window.ReportScopes?window.ReportScopes.matchesProject(row,project.id):row.project_id===project.id;});
    var period=S.detailPeriod || (!isPlanningManager() && S.pmPeriod) || currentPeriod();
    var periods=[currentPeriod()]; all.forEach(function(row){if(periods.indexOf(row.period)<0)periods.push(row.period);});
    if(periods.indexOf(period)<0)periods.push(period);
    var rows=all.filter(function(row){return reportInPeriod(row,period);});
    var tab=S.detailTab || 'report';
    var tabs=[['report','本期内容'],['review','评价与交代'],['history','历史版本']];
    if(!isPzo())tabs.push(['data','项目资料']);
    if(isPzo() && tab==='data')tab='report';
    var content='';
    if(tab==='review')content='<div class="card"><div class="cardhd"><h2>评价与交代</h2><span class="chip">'+esc(period)+'</span></div>'
      +(isPlanningManager() && period===currentPeriod()?detailLeaderEditable(project.id):detailLeaderReadOnly(project.id,period))+'</div>';
    else if(tab==='history')content=rows.length?rows.map(function(row){return '<section class="card"><h2>'+esc(row.period)+' · '+esc(row.line || LINE_ALL)+'</h2>'+reportHistoryHtml(row)+'</section>';}).join(''):'<div class="card empty">所选周期暂无已提交记录。</div>';
    else if(tab==='data')content=viewMaster(project.id);
    else content=rows.length?rows.map(function(row){return '<article class="card project-report" data-report-id="'+esc(row.id)+'"><div class="cardhd"><h2>'+esc(row.line || LINE_ALL)+'</h2><span class="muted">'+esc(row.author_name || '')+' · '+esc(fmtTime(row.updated_at || row.submitted_at))+'</span></div>'+reportSnapshotHtml(row)+'</article>';}).join(''):'<div class="card empty">所选周期暂无已提交记录。</div>';
    return '<div class="project-detail" data-project-id="'+esc(project.id)+'"><section class="card project-detail-head"><div><span class="chip">'+(isCom(project.id)?'商业':'住宅')+'</span><h2>'+esc(project.name)+'</h2></div><div class="project-detail-controls no-print"><label for="detailPeriod">查看周期</label><select id="detailPeriod" onchange="App.detailPeriod(this.value)">'+periods.map(function(p){return '<option value="'+esc(p)+'"'+(period===p?' selected':'')+'>'+esc(p)+'</option>';}).join('')+'</select>'
      +(!isPlanningManager()?'<button class="btn primary" onclick="App.fillProject(\''+esc(project.id)+'\',\''+esc(period)+'\')">填写该周期</button>':'')+'</div></section>'
      +'<nav class="project-detail-tabs no-print" aria-label="项目详情">'+tabs.map(function(t){return '<button type="button" class="'+(tab===t[0]?'on':'')+'" aria-selected="'+String(tab===t[0])+'" onclick="App.detailTab(\''+t[0]+'\')">'+t[1]+'</button>';}).join('')+'</nav>'+content+'</div>';
  }
  function renderShell(keepScroll) {
    if(window.AdminPlans)window.AdminPlans.capture();
    if(window.MonthlyPlans)window.MonthlyPlans.capture();
    if(window.CoordinationWorkbench)window.CoordinationWorkbench.capture();
    if(window.OverviewMeetings)window.OverviewMeetings.capture();
    configureReporter();
    var rev=isPlanningManager(), navs=planningNavItems(), groups=planningGroups(navs);
    var valid=navs.map(function(t){return t.k;});
    if(valid.indexOf(S.view)<0 && S.view!=='detail')S.view=valid.indexOf('board')>=0?'board':valid[0];
    var current=navs.filter(function(t){return t.k===S.view;})[0];
    var group=current?current.group:(rev?'overview':'projects');
    var groupInfo=groups.filter(function(t){return t.key===group;})[0] || groups[0];
    S.ptype=current && current.pt || (S.view==='detail' && isCom(S.detailPid)?'com':'res');
    var body='', view=current && current.v, managementRead=isManagementReadView(S.view);
    if(S.profile.role==='viewer' && !managementRead)body='<div class="card empty">没有管理查看权限，请联系管理员。</div>';
    else if(managementRead)body=window.ManagementReader?window.ManagementReader.html(S.view):'<div class="card empty">正在加载只读资料…</div>';
    else if(S.view==='detail')body=viewProjectDetail();
    else if(view==='presPzo')body=viewPresPzo();
    else if(rev){
      if(view==='pres')body=viewPres();else if(view==='presCom')body=viewPresCom();else if(view==='board')body=viewBoard();
      else if(view==='adminPlans')body=window.AdminPlans?window.AdminPlans.pageHtml():'<div class="card empty">正在加载计划导入组件…</div>';
      else if(view==='dual')body=viewDual();else if(view==='nodes')body=viewNodes();else if(view==='coord')body=viewCoord();
      else if(view==='completion')body=window.CompletionReview?window.CompletionReview.renderQueue({scope:'all'}):'<div class="card empty">正在加载审核组件…</div>';
      else if(view==='meetings')body=window.ReporterTasks?window.ReporterTasks.renderAdmin():'<div class="card empty">正在加载会议事项…</div>';
      else if(view==='completionStats')body=window.CompletionStatistics?window.CompletionStatistics.pageHtml():'<div class="card empty">正在加载员工统计…</div>';
      else if(view==='projectPlanStats')body=window.ProjectPlanStatistics?window.ProjectPlanStatistics.pageHtml():'<div class="card empty">正在加载项目计划统计…</div>';
      else if(view==='lineAdm')body=viewLineAdmin();else if(view==='library')body=viewProjectLibrary();else if(view==='master')body=viewMaster();else body=viewMembers();
    }else{
      if(view==='center')body=viewPMCenter();else if(view==='coordination')body=viewCoordinationPage();else if(view==='history')body=viewPMHistory()+(window.CompletionReview?window.CompletionReview.renderQueue({project_id:S.pmProject}):'');
      else if(view==='mline')body=viewMyLine();else if(view==='library')body=viewProjectLibrary();else if(view==='master')body=viewMaster();else body=viewPMForm();
    }
    if(S.loadErrors && S.loadErrors.length)body='<div class="notice err">部分数据加载失败：'+esc(S.loadErrors.join('；'))+'。请刷新数据重试。</div>'+body;
    var title=S.view==='detail'?'项目详情':S.view==='form'?'本期填报':current && (current.title || (VIEW_TITLE[current.v] || [current.label])[0]) || groupInfo.label;
    var primary=groups.map(function(t){var children=navs.filter(function(item){return item.group===t.key;});
      return '<div class="planning-nav-group"><button type="button" class="planning-primary-trigger '+(t.key===group?'on':'')+'" aria-current="'+(t.key===group?'page':'false')+'"'+(children.length>1?' aria-haspopup="true" aria-expanded="false"':'')+' onclick="App.navGroup(this,\''+t.key+'\','+children.length+')">'+t.label+'</button>'
        +(children.length>1?'<div class="planning-dropdown" aria-label="'+t.label+'子菜单">'+children.map(function(item){return '<button type="button" class="'+(S.view===item.k?'on':'')+'" onclick="App.view(\''+item.k+'\')">'+item.label+'</button>';}).join('')+'</div>':'')+'</div>';}).join('');
    var secondary='';
    var context=S.view==='form'?'':S.view==='detail'?esc(projName(S.detailPid)):rev?esc(currentPeriod()):esc(reportScopeName(S.pmProject));
    var detailOptions=detailProjects();
    var right=(rev?(isManagerOverview()?overviewFilterHtml(S.ptype==='com'):'<select class="planning-project-jump" aria-label="打开项目详情" onchange="if(this.value)App.openProjectDetail(this.value)"><option value="">查看项目详情</option>'+detailOptions.map(function(p){return '<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>';}).join('')+'</select>'):'')
      +(!rev && !managementRead && S.view!=='detail'?'<div class="tb-field"><label for="pmPeriod">报告周期</label><select id="pmPeriod" onchange="App.period(this.value)">'+periodOptionsHtml()+'</select></div>':'')
      +(isManagerOverview()?'<button type="button" class="btn primary sm" onclick="App.startMeeting()">开启会议投影</button>':'')
      +'<button class="btn ghost sm" onclick="App.printPage()">打印 / PDF</button><button class="btn ghost sm" onclick="App.reload()">刷新数据</button>';
    markPMRenderedScope();
    render('<div class="app planning-shell'+(rev?' manager-shell':'')+'"><header class="planning-header"><a class="planning-brand" href="#" onclick="return false"><img src="' + assetUrl('logo.png') + '" alt="正弘置业"><b>工程建设数字化服务平台</b></a>'
      +'<nav class="planning-mainnav" aria-label="主导航">'+primary+'</nav>'+(!rev?'<div class="planning-header-tools">'+right+'</div>':'')+'<div class="planning-identity"><span class="nm">'+esc(S.profile.name || '')+'</span><span class="rl">'+esc(ROLE_LABEL[S.profile.role] || '')+'</span><button type="button" onclick="App.logout()">退出登录</button></div></header>'
      +secondary+'<div class="work">'+(rev?'<header class="topbar"><div class="tb-main"></div><div class="tb-right">'+right+'</div></header>':'')+'<main>'+(rev?'<div id="meeting-controller-mount"></div>':'')+body+'</main></div></div>'
      +(!managementRead && window.CompletionReview?window.CompletionReview.overlayHtml():''),keepScroll);
  }

  /* ================= 对外动作 ================= */

  var App = {
    startMeeting:async function(){
      var context=meetingContext();if(!context.allowed || !context.target)return toast('请先选择有权查看的计划总览。','err');
      if(window.MeetingController && window.MeetingController.active())return window.MeetingController.start(null);
      captureBriefDrafts();if(window.OverviewMeetings)window.OverviewMeetings.capture(true);
      var popup=window.open('about:blank','_blank','popup,width=1440,height=900');
      if(!popup)return toast('投影窗口未能打开，请允许此网站弹出窗口后重试。','err');
      popup.document.title='正在开启会议投影';
      try{
        if(window.PlanningBoot && window.PlanningBoot.ensureMeetingController)await window.PlanningBoot.ensureMeetingController();
        if(context.identity!==meetingContext().identity || !meetingContext().allowed){popup.close();return;}
        if(!window.MeetingController)throw new Error('投影组件读取失败，请重试。');
        configureReporter();window.MeetingController.start(popup);
      }catch(error){popup.close();toast(error.message || '投影组件读取失败，请重试。','err');}
    },
    navGroup:function(button,group,count){
      if(count<2)return App.section(group);
      var parent=button.parentElement,open=!parent.classList.contains('is-open');
      document.querySelectorAll('.planning-nav-group.is-open').forEach(function(el){el.classList.remove('is-open');var trigger=el.querySelector('.planning-primary-trigger');if(trigger)trigger.setAttribute('aria-expanded','false');});
      parent.classList.toggle('is-open',open);button.setAttribute('aria-expanded',String(open));
    },
    overviewToggle:function(key,open){
      if(!isManagerOverview() || !Object.prototype.hasOwnProperty.call(S.overviewUI.open,key))return;
      S.overviewUI.open[key]=!!open;
    },
    overviewFilter:function(value){
      if(!isManagerOverview())return;
      var commercial=S.ptype==='com';
      if(value && (commercial?businessLinesForProjects(overviewProjects(true)).indexOf(value)<0:!overviewProjectGroups().some(function(g){return g.name===value;})))return;
      captureBriefDrafts();
      S.overviewUI[commercial?'line':'project']=value;
      if(!commercial)S.overviewUI.discipline='';
      if(!commercial && value)S.overviewUI.open[overviewFoldKey('project','group:'+value,'')]=true;
      if(value)overviewProjects(commercial).forEach(function(p){
        if(!commercial && (p.display_group || p.name)!==value)return;
        S.overviewUI.open[overviewFoldKey('project',p.id,'')]=true;
        if(commercial)S.overviewUI.open[overviewFoldKey('profession',p.id,value)]=true;
      });
      renderShell(true);
    },
    overviewDiscipline:function(value){
      if(!isManagerOverview() || S.ptype==='com' || value && overviewDisciplineChoices().indexOf(value)<0)return;
      captureBriefDrafts();S.overviewUI.discipline=value;renderShell(true);
    },
    overviewPeriod:async function(value){
      if(!isManagerOverview() || !overviewPeriods().some(function(period){return period.id===value;}))return;
      captureBriefDrafts();S.overviewUI.period=value;S.overviewUI.open={};return showPage(false);
    },
    overviewExpandAll:function(open){
      if(!isManagerOverview())return;
      Array.prototype.forEach.call(rootEl.querySelectorAll('.plan-overview details[data-overview-fold]'),function(el){
        var key=el.getAttribute('data-overview-fold');S.overviewUI.open[key]=!!open;el.open=!!open;
      });
    },
    overviewArrange:function(pid,line,kind){
      if(!isManagerOverview() || !detailProjects().some(function(p){return p.id===pid;}))return;
      if(kind==='ceo_brief'?!canWriteCeo():kind!=='pzo_note' || !canWritePzo())return toast('无权维护该类安排。','err');
      if(isCom(pid) && businessLinesForProject(pid).indexOf(line)<0)return;
      captureBriefDrafts();
      var rows=briefDraftRows(pid,kind),prefix='【'+String(line || '综合')+'】',index=rows.length;
      for(var i=0;i<rows.length;i++)if(String(rows[i].what || '').trim()===prefix){index=i;break;}
      if(index===rows.length)rows.push({what:prefix,due:''});
      S.overviewUI.open[overviewFoldKey('project',pid,'')]=true;
      S.overviewUI.open[overviewFoldKey('profession',pid,line)]=true;
      renderShell(true);
      var input=document.getElementById((kind==='ceo_brief'?'cbw_':'pzw_')+pid+'_'+index),editor=input && input.nextElementSibling && input.nextElementSibling.querySelector('.ql-editor');
      if(editor)editor.focus();else if(input && input.focus)input.focus();
    },
    section: async function(group) {
      if (attachmentBusy()) return;
      var items=planningNavItems().filter(function(item){return item.group===group;});
      if(!items.length)return;
      var preferred=group==='overview'?'pres':group==='projects' && !isReviewer()?'master':null;
      var target=items.filter(function(item){return item.k===preferred;})[0] || items[0];
      await App.view(target.k);
    },
    openProjectDetail: async function(pid) {
      if(S.profile && S.profile.role==='viewer')return;
      if (attachmentBusy()) return;
      if(!detailProjects().some(function(p){return p.id===pid;}))return toast('无权查看该项目','err');
      if(S.profile.role==='pm')return changePMScope(function(){S.detailPid=pid;S.detailPeriod=S.pmPeriod;S.detailTab='report';S.view='detail';},false);
      captureAdminArchive();captureBriefDrafts();
      if(!isPlanningManager()){snapDraft();saveDraft();}
      S.detailPid=pid;S.detailPeriod=!isPlanningManager()?S.pmPeriod:currentPeriod();S.detailTab='report';S.view='detail';await showPage();
    },
    detailTab: async function(tab) {
      if(['report','review','history','data'].indexOf(tab)<0)return;
      captureAdminArchive();captureBriefDrafts();S.detailTab=tab;await showPage();
    },
    detailPeriod: async function(period) {captureAdminArchive();captureBriefDrafts();S.detailPeriod=String(period);await showPage();},
    fillProject: async function(pid,period,line) {
      if (attachmentBusy()) return;
      if(S.profile.role!=='pm' || !myProjects().some(function(p){return p.id===pid;}))return;
      if(isCom(pid) && line!==undefined && !canReportBizLine(line,pid))return toast('该商业模块尚未授权，请联系管理员分配。','err');
      return changePMScope(function(){S.pmProject=pid;if(period)S.pmPeriod=String(period);if(isCom(pid) && line!==undefined)S.pmLine=line;S.view='form';});
    },
    showReportHistory: async function (id) {
      var requestToken={};S.reportHistoryRequest=requestToken;
      var report = S.reports.filter(function (r) { return String(r.id) === String(id); })[0];
      if (!report) return toast('未找到该填报记录，请刷新数据后重试', 'err');
      var uid=S.uid,session=S.session,epoch=dataEpoch,navigation=pageNavigation,keys=[];
      completionReportKeys([report],function(key){if(keys.indexOf(key)<0)keys.push(key);},false);
      try {
        var result=await Promise.all([
          window.PlanningBoot && window.PlanningBoot.ensureReporter?window.PlanningBoot.ensureReporter('history'):Promise.resolve(),
          window.PlanningBoot && window.PlanningBoot.ensureWorkflow?window.PlanningBoot.ensureWorkflow(true):Promise.resolve(),
          fetchReportAttachmentData({report_ids:[String(report.id)]}),readCompletionKeys(keys)]);
        if(uid!==S.uid || session!==S.session || epoch!==dataEpoch || navigation!==pageNavigation || S.reportHistoryRequest!==requestToken)return;
        if(result[2].error || result[3].error)throw new Error((result[2].error || result[3].error).message);
        S.reportAttachments=(S.reportAttachments || []).filter(function(row){return !result[2].data.some(function(item){return item.id===row.id;});}).concat(result[2].data);
        S.completions=uniqueCompletions((S.completions || []).concat(result[3].data));configureReporter();
      } catch(error) {if(S.reportHistoryRequest===requestToken && uid===S.uid && session===S.session && epoch===dataEpoch && navigation===pageNavigation)toast('版本资料读取失败：'+(error.message || '请重试'),'err');return;}
      renderModal(reportScopeTitle(report) + ' · ' + report.period + ' · 版本记录', reportHistoryHtml(report), function (wrap) {
        wrap.querySelector('.modalbox').style.maxWidth = '900px';
      });
    },
    grow: function (t) { growOne(t); if(t && /^bi_(pg|blocker)_/.test(t.id || '') && window.MonthlyPlans)window.MonthlyPlans.refreshCore(); },
    libraryProject: function (pid) {
      if(!detailProjects().some(function(p){return p.id===pid;}))return;
      S.libraryProject=pid;renderShell(true);
    },
    authTab: function (t) { S.authTab = t; renderLogin(); },
    role: function (r) { S.roleChoice = r; renderOnboarding(); },
    obToggle: function (pid) {
      var i = S.obProjects.indexOf(pid);
      if (i >= 0) S.obProjects.splice(i, 1); else S.obProjects.push(pid);
      renderOnboarding();
    },
    obLine: function (v) { S.obLine = v; },
    openAdminPlans: async function (commercial) {
      if(!S.profile || S.profile.role!=='ops')return;
      var list=overviewProjects(!!commercial),selected=null;
      if(!commercial && S.overviewUI.project){var group=overviewProjectGroups().find(function(row){return row.name===S.overviewUI.project;});list=group?group.projects:[];}
      var groups=!commercial && window.ReportScopes?window.ReportScopes.groupProjects(list,S.reportScopes,overviewPeriod(),null,S.reports):list.map(function(project){return {projects:[project]};});
      if(groups.length===1)selected=groups[0].projects[0];
      S.adminPlanSeed={type:commercial?'com':'res',mode:'excel',project_id:selected && selected.id || '',month:(window.PlanningWindows && window.PlanningWindows.periodStart(overviewPeriod()) || '').slice(0,7)};
      return App.view('adminPlans');
    },
    view: async function (v) {
      if (attachmentBusy()) return;
      if(S.profile && S.profile.role==='viewer' && !planningNavItems().some(function(item){return item.k===v;}))return;
      if (S.view === 'mline' && App.mlineCapture) App.mlineCapture();
      if (S.profile && S.profile.role === 'pm') return changePMScope(function(){S.view=v;},v==='form' || v==='center' || v==='coordination');
      if(window.AdminPlans)window.AdminPlans.capture();
      captureAdminArchive();captureBriefDrafts();
      if (!isReviewer() && S.profile.role!=='viewer') { snapDraft(); saveDraft(); }
      S.view = v;
      /* 个人中心（center）也要 preparePM：工作面移交登记已搬到那里，
         必须先按「当前项目 + 当前模块」载入 bizHand，否则会拿着空数据去保存 */
      await showPage(v === 'form' || v === 'center');
    },
    openFollowup: async function (key) {
      if (!S.profile || S.profile.role !== 'pm' || attachmentBusy()) return;
      await App.view('form');
      if (S.view !== 'form') return;
      var row=Array.from(document.querySelectorAll('[data-followup-key]')).find(function(element){return element.getAttribute('data-followup-key')===String(key);});
      if (!row) return toast('本期暂无这条同步事项，请刷新数据后重试','warn');
      row.scrollIntoView({behavior:'smooth',block:'center'});
      var editor=row.querySelector('.ql-editor') || row.querySelector('textarea');
      if (editor) {
        if(editor.scrollIntoView)editor.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'});
        editor.focus({preventScroll:true});
      }
    },
    period: async function (p) {
      if (attachmentBusy()) return;
      return changePMScope(function(){S.pmPeriod=String(p || '').trim() || currentPeriod();});
    },
    switchProject: async function (pid) {
      if (attachmentBusy()) return;
      return changePMScope(function(){S.pmProject=pid;});
    },
    showLegacyScopeDraft: function(identifier) {
      if(!S.pmReportScope || !window.ReportScopes)return;
      var row=window.ReportScopes.legacyDrafts(localStorage,S.uid,S.pmReportScope,S.pmPeriod,weekNo,S.pmLine).filter(function(d){return d.key===identifier || d.project_id===identifier;})[0];
      if(!row)return toast('原稿已不存在，请重新核对本机草稿','warn');
      var title=legacyScopeDraftTitle(row);
      renderModal(title+' · '+(professionalPMScope()?'原本机草稿':'原地块本机草稿')+'（只读核对）',window.ReportScopes.legacyDraftHtml(row,{esc:esc,richItem:richItem,projectName:title,formatTime:fmtTime}),function(){});
    },
    filter: function (k, v) { S.filters[k] = v; renderShell(true); },
    clearFilter: function () { S.filters = { project: '', status: '', impact: '' }; renderShell(true); },

    reload: async function () {
      if (attachmentBusy()) return;
      if(isManagementReadView(S.view)){await showPage(false,true);if(S.view==='managementLibrary' && window.ProjectLibrary)await window.ProjectLibrary.reload();return;}
      if(S.view==='library' && window.ProjectLibrary){await window.ProjectLibrary.reload();return;}
      if (S.profile && S.profile.role === 'pm') {
        if(S.view==='mline' && App.mlineCapture)App.mlineCapture();
        if(!await changePMScope(function(){},true,true))return;
        return toast(S.loadErrors && S.loadErrors.length?'刷新完成，但仍有部分数据未能加载':'已刷新为最新数据',S.loadErrors && S.loadErrors.length?'err':undefined);
      }
      captureAdminArchive();captureBriefDrafts();
      if (S.profile && S.profile.role === 'pm') { snapDraft(); saveDraft(); if(S.view==='mline' && App.mlineCapture)App.mlineCapture(); }
      if (!await showPage(!isReviewer(), true)) return;
      toast(S.loadErrors && S.loadErrors.length ? '刷新完成，但仍有部分数据未能加载' : '已刷新为最新数据',
        S.loadErrors && S.loadErrors.length ? 'err' : undefined);
    },

    printPage: function () { try { window.print(); } catch (e) { toast('当前环境不支持打印', 'err'); } },

    /* 运营汇总导出（与页面同一套筛选条件） */
    exportBoard: function () {
      var com = S.ptype === 'com';
      var list = filteredProjects().slice().sort(function (x, y) {
        var dx = nextKey(x.id) ? dayDiff(nextKey(x.id).forecast_date, nextKey(x.id).plan_date) : -999;
        var dy = nextKey(y.id) ? dayDiff(nextKey(y.id).forecast_date, nextKey(y.id).plan_date) : -999;
        return dy - dx;
      });
      if (!list.length) return toast('当前筛选条件下没有可导出的项目', 'err');

      /* 商业汇总导出：一行 = 一个模块一期的填报 */
      if (com) {
        var crows = [];
        list.forEach(function (p) {
          var dOpen = daysToOpen(p.id);
          comSummary(p.id).rs.forEach(function (r) {
            var it = itemsOf(r), nd = nodesOf(r), hd = handoverOf(r);
            var od = it.filter(itemOverdue);
            crows.push([
              p.name, r.line || '综合', r.author_name || '', statusOf(p.id),
              dOpen !== null ? dOpen + ' 天' : '',
              nd.map(function (x) { return x.name + (x.plan ? '（' + sd(x.plan) + '）' : '') + (x.prog ? '：' + x.prog : ''); }).join('；'),
              it.map(function (x) { return x.name + (x.due ? '（' + sd(x.due) + '）' : '') + (x.prog ? '：' + x.prog : ''); }).join('；'),
              od.map(function (x) { return x.name + '（' + sd(x.due) + '）'; }).join('；'),
              hd.map(function (x) { return x.what + (x.to ? '→' + x.to : '') + (x.due ? '（' + sd(x.due) + '）' : ''); }).join('；'),
              (r.coord_items || []).filter(function (c) { return c.who || c.what; })
                .map(function (c) { return (c.who || '未指定') + '：' + c.what + (c.by ? '（最晚 ' + c.by + '）' : ''); }).join('；'),
              it.filter(function (x) { return (x.coord || '').trim(); })
                .map(function (x) { return x.name + '：' + x.coord; }).join('；'),
              comSummary(p.id).st.missing.length ? '未报 ' + comSummary(p.id).st.missing.length + ' 模块' : '已报齐',
              r ? fmtTime(r.updated_at || r.submitted_at) : ''
            ]);
          });
        });
        if (!crows.length) return toast('商业项目本期尚无填报，无可导出内容', 'err');
        return exportTable('正弘周度直报_商业汇总_' + stamp() + '.csv', [
          '项目', '模块', '填报人', '状态', '开业倒计时',
          '本月核心节点', '当月计划事项', '已过完成时间的事项', '工作面移交',
          '协调与支持需求', '事项级需协调', '模块进度', '更新时间'
        ], crows);
      }

      var rows = list.map(function (p) {
        var r = latestReport(p.id), nk = nextKey(p.id);
        var d = nk ? dayDiff(nk.forecast_date, nk.plan_date) : null;
        var co = r && (r.coord_items || []).length
          ? (r.coord_items || []).filter(function (c) { return c.who || c.what; })
              .map(function (c) { return (c.who || '未指定') + (c.what ? '：' + c.what : '') + (c.by ? '（最晚 ' + c.by + '）' : ''); }).join('；')
          : (r && r.coord && r.coord !== '无' ? plain(r.coord) : '');
        return [
          p.name, pmOf(p.id), statusOf(p.id),
          dualAssessment(p.id).speed, dualAssessment(p.id).effect,
          nk ? nk.name : '', nk ? sd(nk.plan_date) : '', nk ? sd(nk.forecast_date) : '', devText(d),
          pickedNodes(r).map(function (n) { return n.name + ' ' + sd(n.plan) + '→' + sd(n.forecast) + ' ' + devText(n.d); }).join('；'),
          r ? plain(r.change_text) : '',
          r ? plain(r.dev_text) : '',
          r ? (r.impact || '') : '',
          r ? plain(r.projection) : '',
          (r && (r.next_items || []).length ? r.next_items.join('；') : ''),
          co,
          submittedThisWeek(p.id) ? '已填报' : '未填报',
          r ? fmtTime(r.updated_at || r.submitted_at) : ''
        ];
      });
      exportTable('正弘周度直报_运营汇总_' + stamp() + '.csv', [
        '项目', '项目经理', '状态', '速度（领导评价优先）', '效果（领导评价）',
        '下一关键节点', '计划（引导）', '本周预计', '较计划',
        '本期研判节点', '本周变化', '风险/偏差', '经营影响', '影响量级',
        '下周必须完成', '协调与支持需求', '本期填报', '更新时间'
      ], rows);
    },

    /* 节点偏差总表导出（与左侧导航同口径） */
    exportNodes: function () {
      var data=nodeDetailData();
      if(!data)return toast('节点有效审核状态尚未读取或未匹配，请刷新后再导出','err');
      var rows = data.rows.map(function(row){
          var p=row.p,m=row.m,d=row.d;
          var L = deviationStatus(d,m.done);
          return [p.name, m.name, m.is_key ? '关键节点' : '', m.level || '', m.standard || '', m.owner_dept || '',
            sd(m.plan_date), m.done ? '（已完成）' : sd(m.forecast_date), m.done ? '—' : devText(d), L];
      });
      if (!rows.length) return toast('当前筛选条件下没有可导出的节点', 'err');
      rows.sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])) || String(a[6]).localeCompare(String(b[6])); });
      exportTable('正弘周度直报_节点偏差总表_' + stamp() + '.csv',
        ['项目', '节点', '关键标记', '层级', '完成标准', '主责部门', '计划（引导）', '本周预计', '较计划', '灯号'], rows);
    },

    saveDraftNow: function () { snapDraft(); var saved=saveDraft();toast(saved?'本机草稿已保存，尚未提交服务器':'本机草稿保存失败，请复制内容或提交',saved?undefined:'err'); },
    openPlanningAI: async function () {
      clearTimeout(draftAutosaveTimer);
      snapDraft();
      if(!planningAIContext().canEdit)return toast('当前页面不能填报，请先选择本人已授权的项目和模块。','err');
      try {
        if(window.PlanningBoot && window.PlanningBoot.ensurePlanningAI)await window.PlanningBoot.ensurePlanningAI();
        if(!window.PlanningAI || !window.PlanningAIDraft)throw new Error('AI 组件未能加载，请刷新重试。');
        configureReporter();window.PlanningAI.open();
      } catch(error){toast(error.message || 'AI 组件加载失败，请重试。','err');}
    },

    openReportReference: async function () {
      snapDraft();
      var context=reportReferenceContext();
      if(!context.canRead)return;
      try {
        if(window.PlanningBoot && window.PlanningBoot.ensureReportReference)await window.PlanningBoot.ensureReportReference();
        if(context.key!==reportReferenceContext().key)return;
        if(!window.ReportReference)throw new Error('查看组件未能加载，请重试。');
        configureReporter();window.ReportReference.open();
      } catch(error){toast(error.message || '读取组件失败，请重试。','err');}
    },

    logout: async function () {
      if (attachmentBusy()) return;
      if(window.PasswordChange)window.PasswordChange.close();
      resetPageData();
      try { await cloud.auth.signOut(); } catch (e) {}
      S.session = null; S.uid = null; S.profile = null;
      S.projects = []; S.milestones = []; S.reports = []; S.members = []; S.pms = []; S.orgList = []; S.versions = [];
      S.master = []; S.phases = []; S.drawings = []; S.lineEdits = {};
      S.reviews = []; S.leaderNotes = []; S.briefDrafts = {}; S.formRich={}; S.reviewRichDrafts={};
      renderLogin('已退出登录');
    },

    sendCode: async function () {
      var email = val('email');
      if (!email) return setMsg('请先填写邮箱', 'err');
      var btn = document.getElementById('sendBtn');
      btn.disabled = true; btn.textContent = '发送中…';
      var r = await cloud.auth.sendOtp({ email: email, purpose: S.authTab === 'reg' ? 'register' : 'login' });
      if (r.error) { btn.disabled = false; btn.textContent = '获取验证码'; return setMsg(r.error.message || '验证码发送失败', 'err'); }
      pendingOtp = { email: email, verificationId: r.data.verificationId, isExistingUser: r.data.isExistingUser };
      setMsg('验证码已发送，请查收邮箱', 'ok');
      countdown(btn, 60);
    },

    closeModal: function () { closeModal(); },

    /* 重置密码：凭邮箱验证码设置新密码，验证码由服务端校验。 */
    forgot: async function () {
      var email = val('email');
      if (!email) return setMsg('请先填写邮箱', 'err');
      var started = null;    /* resetPasswordForEmail 的返回句柄，持有 updateUser */

      renderModal('重置密码', ''
        + '<div class="notice" style="margin-bottom:16px">获取并填写该邮箱收到的验证码，然后设置新密码。验证码只用于本次密码重置。</div>'
        + '<div class="authrow"><label>邮箱</label><input id="fp_email" value="' + esc(email) + '" readonly></div>'
        + '<div class="authrow"><label>邮箱验证码</label><div class="codrow">'
        + '<input id="fp_code" inputmode="numeric" placeholder="6 位验证码" autocomplete="one-time-code">'
        + '<button type="button" class="btn ghost" id="fp_send">获取验证码</button></div></div>'
        + '<div class="authrow"><label>新密码</label><input id="fp_new" type="password" placeholder="6 至 128 个字符，可使用纯数字" autocomplete="new-password"></div>'
        + '<div class="authrow"><label>确认新密码</label><input id="fp_new2" type="password" placeholder="再次输入新密码" autocomplete="new-password"></div>'
        + '<div id="fp_msg" class="authmsg"></div>'
        + '<button class="btn primary" style="width:100%" id="fp_go">确认重置密码</button>',
        function (w) {
          var sendBtn = w.querySelector('#fp_send');
          sendBtn.addEventListener('click', async function () {
            var em = String(w.querySelector('#fp_email').value || '').trim();
            sendBtn.disabled = true; sendBtn.textContent = '发送中…';
            modalMsg(w, '正在发送验证码…');
            var r = await cloud.auth.resetPasswordForEmail(em);
            if (r.error) {
              sendBtn.disabled = false; sendBtn.textContent = '获取验证码';
              return modalMsg(w, r.error.message || '验证码发送失败', 'err');
            }
            started = r;
            modalMsg(w, '验证码已发送至邮箱', 'ok');
            countdown(sendBtn, 60);
          });

          var goBtn = w.querySelector('#fp_go');
          goBtn.addEventListener('click', async function () {
            var code = String(w.querySelector('#fp_code').value || '').trim();
            var np = String(w.querySelector('#fp_new').value || '');
            var np2 = String(w.querySelector('#fp_new2').value || '');
            if (!started) return modalMsg(w, '请先点击「获取验证码」', 'err');
            if (!code) return modalMsg(w, '请填写邮箱收到的验证码', 'err');
            var pi = pwdIssue(np); if (pi) return modalMsg(w, pi, 'err');
            if (np !== np2) return modalMsg(w, '两次输入的新密码不一致', 'err');
            goBtn.disabled = true; goBtn.textContent = '重置中…';
            modalMsg(w, '正在重置…');
            var done = await started.data.updateUser({ nonce: code, password: np });
            if (done.error) {
              goBtn.disabled = false; goBtn.textContent = '确认重置密码';
              return modalMsg(w, done.error.message || '重置失败，请确认验证码是否正确或已过期', 'err');
            }
            closeModal();
            failClear(email);
            setMsg('密码已重置，请用新密码登录', 'ok');
          });
        });
    },

    onboardSubmit: async function () {
      var name = val('obName');
      if (!name) return setMsg('请填写姓名', 'err');
      var row = { name: name, role: 'pm', status: 'pending' };
      setMsg('提交中…');
      var r = await db.from('profiles').insert(row).select();
      if (r.error) return setMsg('创建失败：' + (r.error.message || ''), 'err');
      if (!r.data || !r.data.length) return setMsg('创建被拒绝，请联系管理员核对账号状态。自助建档仅支持待审核的提报人账号。', 'err');
      S.profile = r.data[0];
      renderWaiting();
    },

    addNodeRow: function () {
      snapDraft();
      S.nodeRows.push({});
      renderShell(true);
      saveDraft();
    },

    nodePick: function (i) {
      snapDraft();
      var r = S.nodeRows[i] || (S.nodeRows[i] = {});
      var m = msOf(S.pmProject).filter(function (x) { return x.name === r.name; })[0];
      r.key_name = (m && m.key_name) || '';
      r.level = (m && m.level) || '';
      r.is_key = !!(m && m.is_key);
      r.standard = (m && m.standard) || '';
      r.mid = m ? m.id : null;
      r.plan = m ? sd(m.plan_date) : '';
      r.forecast = sd(m && m.forecast_date) || r.forecast || '';
      renderShell(true);
      saveDraft();
    },

    delNode: function (i) {
      snapDraft();
      var row = S.nodeRows[i] || {};
      if (row.name && !window.confirm('确认移除节点「' + row.name + '」这一行？')) return;
      S.nodeRows.splice(i, 1);
      if (!S.nodeRows.length) S.nodeRows.push({});
      renderShell(true);
      saveDraft();
    },

    addMyNode: function () { snapDraft(); S.myRows.push({}); renderShell(true); saveDraft(); },

    /* ---- 商业项目：条线切换与计划事项增删 ---- */
    pmLineSet: async function (v) {
      if (attachmentBusy()) return;
      if (!S.profile || S.profile.role !== 'pm' || !isCom(S.pmProject)
        || !myProjects().some(function(p){return p.id===S.pmProject;}) || !canReportBizLine(v,S.pmProject)) return toast('当前账号不能切换该商业模块，请联系管理员。', 'err');
      if (S.pmLine === v) return;
      return changePMScope(function(){S.pmLine=v;});
    },

    /* ---- 商业项目：① 本月核心节点计划 ---- */
    addBizNode: function () {
      snapDraft();
      S.bizNodes = S.bizNodes || [];
      S.bizNodes.push({});
      renderShell(true);
      saveDraft();
    },

    bizNodeCalc: function (i) {
      snapDraft();
      var r = S.bizNodes[i] || (S.bizNodes[i] = {});
      var choices = bizNodeOptions(S.pmProject).filter(function (x) { return x.name === (r.name || '').trim(); });
      var m=choices.length===1?choices[0]:null;
      if(m)r.milestone_id=m.id;else delete r.milestone_id;
      r.is_key = !!(m && m.is_key);
      if (m && !r.plan && m.plan_date) r.plan = sd(m.plan_date);
      renderShell(true);
      saveDraft();
    },

    addWindowNodes:function(){
      if(!window.PlanningWindows || S.profile.role!=='pm')return;
      snapDraft();
      S.bizNodes=window.PlanningWindows.prefillNodes(S.bizNodes,personalWindowNodes(),{}).rows;
      S.pendingBaselineNodes=[];saveDraft();renderShell(true);
    },

    delBizNode: function (i) {
      snapDraft();
      var row = S.bizNodes[i] || {};
      if (row.name && !window.confirm('确认移除节点「' + row.name + '」？')) return;
      S.bizNodes.splice(i, 1);
      renderShell(true);
      saveDraft();
    },

    /* ---- 商业项目：② 当月计划填报 ---- */
    addBizItem: function () {
      if(window.MonthlyPlans && window.MonthlyPlans.locked())return toast('月度计划已确认，只能更新当周进展和卡点。','err');
      snapDraft();
      S.bizItems.push({});
      renderShell(true);
      saveDraft();
    },

    delBizItem: function (i) {
      if(window.MonthlyPlans && window.MonthlyPlans.locked())return toast('月度计划已确认，不可删除计划事项。','err');
      snapDraft();
      var row = S.bizItems[i] || {};
      if (row.name && !window.confirm('确认移除事项「' + row.name + '」？')) return;
      S.bizItems.splice(i, 1);
      if (!S.bizItems.length) S.bizItems.push({});
      renderShell(true);
      saveDraft();
    },

    /* ---- 工作面移交登记（2026-10-13 由填报页第四部分搬到个人中心） ---- */
    addBizHand: function () {
      snapDraft();
      S.bizHand = S.bizHand || [];
      S.bizHand.push({});
      renderShell(true);
      saveDraft(true);
    },

    delBizHand: function (i) {
      snapDraft();
      var row = S.bizHand[i] || {};
      if (row.what && !window.confirm('确认移除移交事项「' + row.what + '」？')) return;
      S.bizHand.splice(i, 1);
      renderShell(true);
      saveDraft(true);
    },

    /* 移交登记行改动后就地存草稿（个人中心的输入不会触发全局自动存草稿，那里只管填报页） */
    handTouch: function () { snapDraft(); saveDraft(true); },

    /* 个人中心「保存移交登记」：只把 biz.handover 写回本期本模块的报告行，
       不动本次已提交的其它字段（节点 / 事项 / 协调），也不新建报告行 */
    saveHand: async function () {
      snapDraft();
      var pid = S.pmProject;
      if (!pid) return toast('未选择项目', 'err');
      if (!isCom(pid)) return toast('仅商业项目（弘坊）支持工作面移交登记', 'err');
      if (!canReportBizLine(S.pmLine)) { saveDraft(true); return toast('商业模块尚未授权，草稿已保留，请联系管理员分配。', 'err'); }
      var line = S.pmLine || LINE_ALL;
      var hand = (S.bizHand || []).filter(function (x) { return (x.what || '').trim(); }).map(function (x) {
        return richCopy(x,{ source_id:x.source_id || reporterSourceId(), what: x.what.trim(), to: (x.to || '').trim(), due: x.due || '' });
      });
      var find = await db.from('reports').select('id,biz,rich_text')
        .eq('project_id', pid).eq('period', S.pmPeriod).eq('line', line).limit(1);
      if (find.error) return toast('读取失败：' + (find.error.message || ''), 'err');
      var row = find.data && find.data[0];
      if (!row) {
        saveDraft(true);
        return toast('本期「' + line + '」还没提交过；登记已随草稿暂存，请到「本期填报」提交一次即写入台账', 'warn');
      }
      var biz = Object.assign({}, row.biz || {}, { handover: hand });
      var patch = richPartialUpdate(row,{ biz: biz, updated_at: new Date().toISOString() },['biz.handover']);
      var upd = await db.from('reports').update(patch)
        .eq('id', row.id).select();
      if (upd.error) return toast('保存失败：' + (upd.error.message || ''), 'err');
      if (!upd.data || !upd.data.length) return toast('无权限修改该条记录', 'err');
      toast('移交登记已保存：' + line + ' · 本期 ' + hand.length + ' 项');
      await loadData(['reports'], true);
      await preparePM(S.pmPeriod);
      renderShell(true);
    },

    delMyNode: function (i) {
      snapDraft();
      var row = S.myRows[i] || {};
      if (row.name && !window.confirm('确认移除自定义节点「' + row.name + '」这一行？')) return;
      S.myRows.splice(i, 1);
      renderShell(true);
      saveDraft();
    },

    myCalc: function (i) {
      var r = S.myRows[i] || {};
      var nm = val('my_nm_' + i), pl = val('my_pl_' + i), fc = val('my_fc_' + i);
      if (nm) r.name = nm; if (pl) r.plan = pl; if (fc) r.forecast = fc;
      var d = (r.plan && r.forecast) ? dayDiff(r.forecast, r.plan) : null;
      var el = document.getElementById('my_dv_' + i);
      if (el) el.innerHTML = devCellHtml(d);
    },

    nodeCalc: function (i) {
      var r = S.nodeRows[i] || {};
      var fc = val('nd_fc_' + i);
      if (fc) r.forecast = fc;
      var d = (r.plan && fc) ? dayDiff(fc, r.plan) : null;
      var el = document.getElementById('nd_dv_' + i);
      if (el) el.innerHTML = devCellHtml(d);
    },

    addCoord: function () { snapDraft(); S.coordRows.push({}); renderShell(true); saveDraft(true); },

    delCoord: function (i) {
      snapDraft();
      var row = S.coordRows[i] || {};
      if ((row.what || row.who) && !window.confirm('确认移除这条协调「' + (row.what || row.who) + '」？')) return;
      S.coordRows.splice(i, 1);
      renderShell(true);
      saveDraft(true);
    },

    /* 协调行改动后就地存草稿（个人中心的输入不触发全局自动存草稿，那里只管填报页） */
    coordTouch: function () { snapDraft(); saveDraft(true); },

    /* 个人中心「保存协调」：只把 coord_items（含运营端摘要 coord）写回本期本模块的报告行，
       不动已提交的其它字段；保存后指向谁，谁的个人中心「他人向我提出的需求」立即可见 */
    saveCoord: async function () {
      snapDraft();
      var pid = S.pmProject;
      if (!pid) return toast('未选择项目', 'err');
      if (!isCom(pid)) return toast('仅商业项目（弘坊）支持发起协调', 'err');
      if (!canReportBizLine(S.pmLine)) { saveDraft(true); return toast('商业模块尚未授权，草稿已保留，请联系管理员分配。', 'err'); }
      var line = S.pmLine || LINE_ALL;
      var coords = (S.coordRows || []).filter(function (x) { return (x.who || '').trim() || (x.what || '').trim(); }).map(function (x) {
        return richCopy(x,{ source_id:x.source_id || reporterSourceId(), who: (x.who || '').trim(), ...(x.who_id?{who_id:x.who_id}:{}), what: (x.what || '').trim(), by: x.by || '' });
      });
      var find = await db.from('reports').select('id,coord,coord_items,biz,rich_text')
        .eq('project_id', pid).eq('period', S.pmPeriod).eq('line', line).limit(1);
      if (find.error) return toast('读取失败：' + (find.error.message || ''), 'err');
      var row = find.data && find.data[0];
      if (!row) {
        saveDraft(true);
        return toast('本期「' + line + '」还没提交过；协调已随草稿暂存，请到「本期填报」提交一次即写入台账', 'warn');
      }
      var coordTxt = coords.length ? coords.map(function (c) { return (c.who || '') + (c.what ? '：' + c.what : ''); }).join('\n') : '无';
      var patch = richPartialUpdate(row,{ coord_items: coords, coord: coordTxt, updated_at: new Date().toISOString() },['coord_items','coord']);
      var upd = await db.from('reports').update(patch)
        .eq('id', row.id).select();
      if (upd.error) return toast('保存失败：' + (upd.error.message || ''), 'err');
      if (!upd.data || !upd.data.length) return toast('无权限修改该条记录', 'err');
      toast('协调已保存：' + line + ' · 本期 ' + coords.length + ' 项，对方个人中心立即可见');
      await loadData(['reports'], true);
      await preparePM(S.pmPeriod);
      renderShell(true);
    },

    /* ============ 领导评价与交代 ============
       对应领导与运营管理员可写；读取范围由服务端项目权限限定。 */

    saveCeoReview: async function () { return toast('评价录入已取消，历史评价保留只读。','warn'); },
    savePzoReview: async function () { return toast('评价录入已取消，历史评价保留只读。','warn'); },

    addCeoBrief: function (pid) { if (!canWriteCeo()) return toast('仅总裁或运营管理员可维护总裁交代', 'err'); editBriefRow(pid, 'ceo_brief'); },
    addPzoNote: function (pid) { if (!canWritePzo()) return toast('仅项目总或运营管理员可写批示', 'err'); editBriefRow(pid, 'pzo_note'); },

    delCeoBriefRow: async function (pid, i) {
      if (!canWriteCeo()) return toast('仅总裁或运营管理员可维护总裁交代', 'err');
      editBriefRow(pid, 'ceo_brief', i);
    },

    delPzoNoteRow: async function (pid, i) {
      if (!canWritePzo()) return toast('仅项目总或运营管理员可写批示', 'err');
      editBriefRow(pid, 'pzo_note', i);
    },

    saveCeoBriefs: async function (pid) {
      if (!canWriteCeo()) return toast('仅总裁或运营管理员可维护总裁交代', 'err');
      await saveBriefDraft(pid, 'ceo_brief');
    },

    savePzoNotes: async function (pid) {
      if (!canWritePzo()) return toast('仅项目总或运营管理员可写批示', 'err');
      await saveBriefDraft(pid, 'pzo_note');
    },

    msSet: async function (id, value) {
      var sameIdentity=milestoneSaveIdentity();
      var m = null;
      S.milestones.forEach(function (x) { if (Number(x.id) === Number(id)) m = x; });
      if (!m) return;
      /* 函数级权限拦截：运营可改全部项目；项目经理只能改自己负责项目的节点 */
      if (S.profile && S.profile.role !== 'ops') {
        var own = myProjects().filter(function (p) { return p.id === m.project_id; }).length > 0;
        if (!own) return toast('无权修改该项目节点', 'err');
      }
      var r = await db.from('milestones').update({ forecast_date: value, updated_at: new Date().toISOString() }).eq('id', m.id).select();
      if(!sameIdentity())return;
      if (r.error) return toast('保存失败：' + (r.error.message || ''), 'err');
      if (!r.data || !r.data.length) return toast('无权修改该项目节点', 'err');
      m.forecast_date = value;
      await refreshMilestoneCompletions([m]);
      if(!sameIdentity())return;
      toast('已保存');
      renderShell(true);
    },

    /* ===== 我的条线：就地更新预计完成时间与卡点说明（窄更新，不动计划引导值） ===== */
    mlineCapture: function () {
      if(window.ZHRichEditor) window.ZHRichEditor.flush();
      S.mlineDraft = S.mlineDraft || {};
      lineMilestones().forEach(function (m) {
        var fc = document.getElementById('ml_fc_' + m.id), nt = document.getElementById('ml_note_' + m.id);
        if (!fc && !nt) return;
        var vFc = fc ? String(fc.value || '').trim() : String(m.forecast_date || '').slice(0, 10);
        var vNt = nt ? String(nt.value || '').trim() : String(m.note || '');
        var oFc = m.forecast_date ? String(m.forecast_date).slice(0, 10) : '', oNt = m.note || '';
        var draft = richInputRow({forecast_date:vFc || null,note:vNt}, 'ml_note_' + m.id, 'note');
        var fields = Object.assign({}, m.rich_text && m.rich_text.fields || {}), previousDoc = fields.note;
        delete fields.note;
        draft.rich_text = {v:1,fields:Object.assign(fields,draft.rich_text && draft.rich_text.fields || {})};
        var formatChanged = false;
        if (window.ZHRichText) {
          var oldDoc = window.ZHRichText.fit(previousDoc,oNt) || window.ZHRichText.legacy(oNt);
          var newDoc = window.ZHRichText.fit(draft.rich_text.fields.note,vNt) || window.ZHRichText.legacy(vNt);
          formatChanged = JSON.stringify(oldDoc) !== JSON.stringify(newDoc);
        }
        if (vFc === oFc && vNt === oNt && !formatChanged) delete S.mlineDraft[m.id];
        else S.mlineDraft[m.id] = draft;
      });
    },
    mlineFilter: function (key, value) {
      if (key !== 'mlineP' && key !== 'mlineSort') return;
      if (key === 'mlineP' && value && !myProjects().some(function (p) { return p.id === value; })) return;
      App.mlineCapture();
      S.filters[key] = value;
      renderShell(true);
    },
    mlineSave: async function () {
      var sameIdentity=milestoneSaveIdentity();
      App.mlineCapture();
      var list = lineMilestones(), changed = [];
      list.forEach(function (m) {
        var draft = S.mlineDraft && S.mlineDraft[m.id];
        if (draft) changed.push({m:m,patch:Object.assign({},draft,{updated_at:new Date().toISOString()})});
      });
      if (!changed.length) return toast('没有改动需要保存');

      var bad = 0, saved=[];
      for (var i = 0; i < changed.length; i++) {
        if(!sameIdentity())return;
        var c = changed[i];
        var r = await db.from('milestones')
          .update(c.patch)
          .eq('id', c.m.id).select();
        if(!sameIdentity())return;
        if (!r || r.error || !r.data || !r.data.length) { bad++; continue; }
        c.m.forecast_date = c.patch.forecast_date; c.m.note = c.patch.note; c.m.rich_text=c.patch.rich_text;
        delete S.mlineDraft[c.m.id];
        attachRich([c.m]);
        saved.push(c.m);
      }
      if(saved.length)await refreshMilestoneCompletions(saved);
      if(!sameIdentity())return;
      toast(bad ? ('已保存 ' + (changed.length - bad) + ' 条，' + bad + ' 条失败或无权限') : ('已保存 ' + changed.length + ' 条节点进展'), bad ? 'err' : undefined);
      renderShell(true);
    },

    /* ===== 运营端：节点归属批量保存（只写改动过的行） ===== */
    lineSaveAll: async function () {
      var sameIdentity=milestoneSaveIdentity();
      if (!canEditMaster()) return toast('仅运营管理员 / 总裁可维护节点归属', 'err');
      var pending = [];
      S.milestones.forEach(function (m) {
        var ls = document.getElementById('ln_line_' + m.id);
        if (!ls) return;
        var ds = document.getElementById('ln_dept_' + m.id);
        var ow = document.getElementById('ln_own_' + m.id);
        var ky = document.getElementById('ln_key_' + m.id);
        var scope=document.getElementById('ln_scope_'+m.id),scopeKey=isCom(m.project_id)?'biz_line':'discipline';
        var scopeValue=scope?scope.value || null:m[scopeKey] || null;
        var nl = ls.value || '';
        var nd = ds ? (ds.value || '') : (m.owner_dept || '');
        var no = ow ? String(ow.value || '').trim() : (m.owner_name || '');
        var nk = ky ? !!ky.checked : !!m.is_key;
        if (nl === (m.line || '') && nd === (m.owner_dept || '') && no === (m.owner_name || '') && nk === !!m.is_key && scopeValue===(m[scopeKey] || null)) return;
        var patch={};
        if(nl!==(m.line || ''))patch.line=nl || null;
        if(nd!==(m.owner_dept || ''))patch.owner_dept=nd || null;
        if(no!==(m.owner_name || ''))patch.owner_name=no || null;
        if(nk!==!!m.is_key)patch.is_key=nk;
        if(scopeValue!==(m[scopeKey] || null))patch[scopeKey]=scopeValue;
        pending.push({m:m,patch:patch});
      });
      if (!pending.length) return toast('没有改动需要保存');

      var bad = 0, saved=[];
      for (var i = 0; i < pending.length; i++) {
        if(!sameIdentity())return;
        var c = pending[i];
        var patch=Object.assign({},c.patch,{updated_at:new Date().toISOString()});
        var r = await db.from('milestones').update(patch).eq('id', c.m.id).select();
        if(!sameIdentity())return;
        if (!r || r.error || !r.data || !r.data.length) { bad++; continue; }
        Object.assign(c.m,c.patch);
        saved.push(c.m);
      }
      if(saved.length)await refreshMilestoneCompletions(saved);
      if(!sameIdentity())return;
      toast(bad ? ('已保存 ' + (pending.length - bad) + ' 条，' + bad + ' 条失败') : ('已保存 ' + pending.length + ' 条节点归属'), bad ? 'err' : undefined);
      renderShell(true);
    },

    /* ===== 项目主数据 ===== */
    masterPick: function (pid) { captureAdminArchive();S.masterPid = pid;if(masterFields(pid).scheme_catalog)S.reporterArchiveTab='knowledge';renderShell(true); },
    reporterArchiveTab: function (tab) { captureAdminArchive();S.reporterArchiveTab = tab; renderShell(true); },

    masterSave: async function (pid) {
      if (!canEditMaster()) return toast('仅运营管理员 / 总裁可维护项目主数据', 'err');
      var fields = Object.assign({}, masterFields(pid));
      MASTER_FIELDS.forEach(function (x) {
        var el = document.getElementById('mf_' + x.k);
        if (el) fields[x.k] = String(el.value || '').trim();
      });
      var r = await db.from('project_master').upsert({
        project_id: pid, fields: fields,
        updated_by: (S.profile && S.profile.name) || '', updated_at: new Date().toISOString()
      }, { onConflict: 'project_id' }).select();
      if (r && r.error) return toast('保存失败：' + (r.error.message || ''), 'err');
      toast('设计数据已保存');
      await loadData(['master'], true);
      renderShell(true);
    },

    phaseDel: async function (id, pid) {
      if (!canEditMaster()) return toast('仅运营管理员 / 总裁可维护项目分期', 'err');
      if (!id) return;
      var r = await db.from('project_phases').delete().eq('id', id);
      if (r && r.error) return toast('删除失败：' + (r.error.message || ''), 'err');
      toast('已删除该分期');
      await loadData(['phases'], true);
      renderShell(true);
    },

    phasesSave: async function (pid) {
      if (!canEditMaster()) return toast('仅运营管理员 / 总裁可维护项目分期', 'err');
      var existing = phasesOf(pid);
      var jobs = [];
      function readRow(key) {
        var o = { project_id: pid }, any = false;
        PHASE_COLS.forEach(function (c) {
          var el = document.getElementById('ph_' + c.k + '_' + key);
          var v = el ? String(el.value || '').trim() : '';
          if (v) any = true;
          if (c.k === 'units_total' || c.k === 'units_launched' || c.k === 'units_sold') o[c.k] = v === '' ? null : (Number(v) || 0);
          else o[c.k] = v || null;
        });
        o.updated_at = new Date().toISOString();
        return any ? o : null;
      }
      existing.forEach(function (p, i) {
        var o = readRow(String(p.id));
        if (!o) return;
        o.sort_order = i;
        jobs.push({ type: 'u', id: p.id, o: o });
      });
      var nw = readRow('new');
      if (nw) { nw.sort_order = existing.length; jobs.push({ type: 'i', o: nw }); }
      if (!jobs.length) return toast('没有可保存的分期数据', 'err');

      var bad = 0;
      for (var i = 0; i < jobs.length; i++) {
        var r = jobs[i].type === 'u'
          ? await db.from('project_phases').update(jobs[i].o).eq('id', jobs[i].id)
          : await db.from('project_phases').insert(jobs[i].o);
        if (r && r.error) bad++;
      }
      toast(bad ? ('保存完成，' + bad + ' 行失败') : '分期与销售套数已保存', bad ? 'err' : undefined);
      await loadData(['phases'], true);
      renderShell(true);
    },

    /* 图纸上传：兼容客户端将项目路径交给本系统附件接口，服务端校验访问权限。 */
    drawUpload: async function (pid, ki) {
      if (!canEditMaster()) return toast('仅运营管理员 / 总裁可上传图纸', 'err');
      var kind = DRAWING_KINDS[ki] || '其他';
      var el = document.getElementById('dw_file_' + ki);
      var file = el && el.files && el.files[0];
      if (!file) return toast('请先选择要上传的文件', 'err');
      if (file.size > 8 * 1024 * 1024) return toast('单份文件请控制在 8MB 以内；更大的图纸请用「登记链接」方式', 'err');

      var ext = (String(file.name).match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase() || '.png';
      var key = 'dr_' + pid + '_' + Date.now() + ext;
      var url = '', path = '';
      try {
        var st = cloud.storage;
        path = st.sharedPath(S.uid, 'drawings/' + pid + '/' + key);
        var api = st.from('runtime');
        var up = await api.upload(path, file, { contentType: file.type || 'image/png', upsert: true });
        if (up && up.error) throw new Error(up.error.message || '上传失败');
        try {
          var pub = api.getPublicUrl(path);
          url = (pub && pub.data && pub.data.publicUrl) || (pub && pub.publicUrl) || '';
        } catch (e2) { url = ''; }
      } catch (e) {
        return toast('上传失败：' + ((e && e.message) || e) + '。可改用右侧「登记链接」粘贴图片或云盘地址。', 'err');
      }

      var r = await db.from('project_drawings').insert({
        project_id: pid, kind: kind, name: file.name, path: path, url: url,
        uploaded_by: (S.profile && S.profile.name) || '', sort_order: drawingsOf(pid, kind).length
      });
      if (r && r.error) return toast('文件已上传，但登记失败：' + (r.error.message || ''), 'err');
      toast(url ? ('已上传到「' + kind + '」') : '已上传，但未取到访问地址，请改用登记链接方式', url ? undefined : 'err');
      await loadData(['drawings'], true);
      renderShell(true);
    },

    drawLinkAdd: async function (pid, ki) {
      if (!canEditMaster()) return toast('仅运营管理员 / 总裁可维护图纸', 'err');
      var kind = DRAWING_KINDS[ki] || '其他';
      var nm = val('dw_name_' + ki), u = val('dw_url_' + ki);
      if (!u) return toast('请先粘贴图纸链接', 'err');
      if (!/^https?:\/\//i.test(u)) return toast('链接需以 http:// 或 https:// 开头', 'err');
      var r = await db.from('project_drawings').insert({
        project_id: pid, kind: kind, name: nm || (kind + '（链接）'), url: u,
        uploaded_by: (S.profile && S.profile.name) || '', sort_order: drawingsOf(pid, kind).length
      });
      if (r && r.error) return toast('登记失败：' + (r.error.message || ''), 'err');
      toast('已登记到「' + kind + '」');
      await loadData(['drawings'], true);
      renderShell(true);
    },

    drawDel: async function (id, pid) {
      if (!canEditMaster()) return toast('仅运营管理员 / 总裁可维护图纸', 'err');
      var r = await db.from('project_drawings').delete().eq('id', id);
      if (r && r.error) return toast('删除失败：' + (r.error.message || ''), 'err');
      toast('已删除');
      await loadData(['drawings'], true);
      renderShell(true);
    },

    submitReport: async function () {
      if (attachmentBusy()) return;
      var pid = S.pmProject;
      if (!pid) return toast('未选择项目', 'err');
      if (S.submittingReport) return;
      var saveUid=S.uid,saveSession=S.session,saveEpoch=dataEpoch,savePeriod=S.pmPeriod,saveLine=S.pmLine,saveKey=draftKey(),saveNavigation=pageNavigation;
      function sameSession(){return S.uid===saveUid && S.session===saveSession && dataEpoch===saveEpoch;}
      snapDraft();
      var com = isCom(pid), prior = S.pmReport || {};
      if(dataState.reportScopes && dataState.reportScopes.error)return toast('统一填报范围读取失败，请刷新后重试；本机草稿保留。','err');
      if(professionalPMScope() && DISCIPLINES.indexOf(S.pmLine)<0)return toast('当前账号尚未分配住宅专业，请联系管理员；原草稿保留。','err');
      if(S.pmLegacyReportConflict){saveDraft(true);return toast('本专业该周期已有原项目报告，请核对原历史记录；当前草稿独立保留，不自动覆盖。','err');}
      if (com && !canReportBizLine(S.pmLine)) { saveDraft(true); return toast('商业模块尚未授权，请联系管理员分配；现有本机草稿保留。', 'err'); }
      if(window.MonthlyPlans && window.MonthlyPlans.needsRefresh())return toast('月度计划已被确认，请先重新读取确认版，再提交本周反馈。','err');
      if(window.MonthlyPlans)window.MonthlyPlans.apply();
      if (window.ReporterTasks && window.ReporterTasks.validationError()) return toast(window.ReporterTasks.validationError(), 'err');
      if (window.ReportAttachments && window.ReportAttachments.validationError()) return toast(window.ReportAttachments.validationError(), 'err');
      var nodes = (S.bizNodes || []).filter(function (x) { return (x.name || '').trim(); });
      var items = (S.bizItems || []).filter(function (x) { return (x.name || '').trim(); });
      var hand = (S.bizHand || []).filter(function (x) { return (x.what || '').trim(); });
      var coords = S.coordRows.filter(function (x) { return (x.who || '').trim() || (x.what || '').trim(); });
      nodes.concat(items,hand,coords).forEach(function (x) { if (!x.source_id) x.source_id = reporterSourceId(); });
      saveDraft();
      var followups = window.ReporterTasks ? window.ReporterTasks.rows() : S.followupRows || [];
      var attachmentIds=window.ReportAttachments?window.ReportAttachments.ids():S.attachmentIds || [];
      if (!nodes.length && !items.length && !hand.length && !coords.length && !followups.length && !attachmentIds.length) {
        return toast('本期还没有任何内容，请至少填写一个核心节点、一条计划事项或一项协调需求', 'err');
      }
      var nodeItems = nodes.map(function (x) {
        var old = (prior.node_items || []).filter(function (n) {return n.name === x.name;})[0] || {};
        return richCopy(x,{project_id:x.project_id,milestone_id:x.milestone_id,name:x.name.trim(),key:x.is_key ? x.name.trim() : old.key || '',plan:x.plan || '',
          forecast:com ? '' : x.forecast || old.forecast || '',reason:(x.prog || '').trim(),custom:com || !!x.custom || !!old.custom},{name:'name',reason:'prog'});
      });
      var firstDev = nodeItems.filter(function (n) {return n.plan && n.forecast && dayDiff(n.forecast,n.plan)>0;})[0];
      var firstNode = firstDev || nodeItems[0], md = maxDelay(pid,{node_items:nodeItems});
      var spSelf = speedOfDelay(md);
      var summary = reporterSummary(items);
      var row = {
        project_id:pid,period:S.pmPeriod,line:S.pmLine || LINE_ALL,
        author_name:S.profile.name,status:com ? suggestStatus(pid) : spSelf === '滞后' ? md>=15 ? '异常' : '关注' : '正常',
        change_text:com ? '' : summary.text || prior.change_text || '',dev_text:com ? '无' : prior.dev_text || '无',
        node_name:firstNode ? firstNode.name : '',node_plan:firstNode && firstNode.plan || null,node_forecast:firstNode && firstNode.forecast || null,
        impact:com ? NO_IMPACT : prior.impact || NO_IMPACT,projection:com ? '' : prior.projection || '',
        coord:coords.length ? coords.map(function (c) {return (c.who || '') + (c.what ? '：' + c.what : '');}).join('\n') : '无',
        next_items:com ? [] : prior.next_items || [],node_items:nodeItems,
        speed_items:com ? [] : prior.speed_items || [],effect_items:com ? [] : prior.effect_items || [],
        coord_items:coords,self_speed:com ? null : spSelf,self_effect:com ? null : prior.self_effect || null,
        biz:Object.assign({},prior.biz || {},window.MonthlyPlans?window.MonthlyPlans.metadata():{},{form_version:2,
          nodes:nodes.map(function (x) {if(!x.source_id)x.source_id=reporterSourceId();return richCopy(x,{project_id:x.project_id,milestone_id:x.milestone_id,source_id:x.source_id,name:x.name.trim(),plan:x.plan || '',forecast:com ? '' : x.forecast || '',prog:(x.prog || '').trim(),is_key:!!x.is_key,custom:!!x.custom});}),
          items:items.map(function (x) {if(!x.source_id)x.source_id=reporterSourceId();return richCopy(x,{project_id:x.project_id,monthly_plan_id:x.monthly_plan_id,source_id:x.source_id,mod:(x.mod || '').trim(),name:x.name.trim(),due:x.due || '',prog:(x.prog || '').trim(),blocker:(x.blocker || '').trim()});}),
          handover:hand.map(function (x) {return richCopy(x,{project_id:x.project_id,source_id:x.source_id || reporterSourceId(),what:x.what.trim(),to:(x.to || '').trim(),due:x.due || ''});}),
          followups:followups,attachments:attachmentIds}),
        updated_at:new Date().toISOString()
      };
      if(S.pmReportScope)row.report_scope_id=S.pmReportScope.id;
      row._rich=Object.assign({},S.formRich && S.formRich._rich || {});
      if(!com && summary.doc && summary.text)row._rich.change_text=summary.doc;
      Object.keys(row._rich).forEach(function(key){if(key.indexOf('next_')===0)delete row._rich[key];});
      if(firstNode && firstNode._rich && firstNode._rich.name)row._rich.node_name=firstNode._rich.name;
      row=richCollect(row);
      // Preserve residential legacy formatting and fields that the new form does not edit.
      if(!com && prior.rich_text && prior.rich_text.fields) { row.rich_text=row.rich_text || {v:1,fields:{}}; Object.keys(prior.rich_text.fields).forEach(function(path){
        if(/^(dev_text|projection|next_items\.|speed_items\.|effect_items\.)/.test(path))row.rich_text.fields[path]=prior.rich_text.fields[path];
      }); }
      var saveToken={};S.submittingReport=saveToken;
      try {
      if (S.pmReport) {
        var chk = await db.from('reports').select('updated_at,author_name').eq('project_id',pid).eq('period',S.pmPeriod).eq('line',row.line).eq('author_id',S.uid).limit(1);
        if(!sameSession())return;
        if (chk.error) return toast('提交前核对版本失败，请刷新数据后重试。', 'err');
        if(chk.data && chk.data[0]) {
          var remote=new Date(chk.data[0].updated_at || 0).getTime(),local=new Date(prior.updated_at || prior.submitted_at || 0).getTime();
          if(remote && local && remote>local+1000 && !window.confirm('本期数据已被更新，继续提交将覆盖最新版本。是否继续？'))return;
        }
      }
        var result=await db.from('reports').upsert(row,{onConflict:'project_id,period,line,author_id'}).select();
        if(!sameSession())return;
        if(result.error)return toast('提交失败：'+(result.error.message || ''),'err');
        if(!result.data || !result.data.length)return toast('提交被拒绝，请确认账号与项目授权。','err');
        try{localStorage.removeItem(saveKey);}catch(error){}toast('本期直报已保存（'+row.line+'）');
        invalidateData(['reporterTasks','completions','reportAttachments']);
        await loadData(['reports','reporterTasks','completions','reportAttachments'],true);
        if(!sameSession() || S.pmProject!==pid || S.pmPeriod!==savePeriod || S.pmLine!==saveLine || pageNavigation!==saveNavigation)return;
        await preparePM();S.view='history';await showPage();
      } finally { if(S.submittingReport===saveToken)S.submittingReport=null; }
    },

    memberSet: async function (uid, field, value) {
      /* 函数级权限拦截：总裁为只读浏览，成员管理仅限运营管理员 */
      if (!S.profile || S.profile.role !== 'ops') return toast('无权限：成员管理仅限管理员', 'err');
      if(field==='management_viewer' && typeof value!=='boolean')return;
      var memberActor=S.uid,memberSession=S.session;
      function sameMemberSession(){return S.uid===memberActor && S.session===memberSession && S.profile && S.profile.role==='ops';}
      if (field === 'role') {
        var target = S.members.filter(function (x) { return x.user_id === uid; })[0];
        var opsCount = S.members.filter(function (x) { return x.role === 'ops'; }).length;
        if (target && target.role === 'ops' && value !== 'ops' && opsCount <= 1) {
          return toast('不能取消最后一位管理员，请先指定新的管理员', 'err');
        }
        if (target && target.role !== 'ops' && value === 'ops') {
          if (!window.confirm('确认将「' + (target.name || '该成员') + '」提升为管理员？\n管理员可管理全部项目与成员，请谨慎授权。')) return;
        }
        if (target && target.role === 'ops' && value !== 'ops') {
          if (!window.confirm('确认将「' + (target.name || '该成员') + '」的角色调整为「' + (ROLE_LABEL[value] || value) + '」？')) return;
        }
      }
      var patch = {}; patch[field] = value === '' ? null : value;
      var r = await db.from('profiles').update(patch).eq('user_id', uid).select();
      if(!sameMemberSession())return;
      if (r.error) return toast('保存失败：' + (r.error.message || ''), 'err');
      if (!r.data || !r.data.length) return toast('无权修改该成员', 'err');
      S.members.forEach(function (m) { if (m.user_id === uid) m[field] = patch[field]; });
      toast('已保存'); await loadData(['members'], true); if(sameMemberSession())renderShell();
    },

    memberAssign: async function (uid, pid) {
      if (!S.profile || S.profile.role !== 'ops') return toast('无权限：成员管理仅限管理员', 'err');
      if (!pid) return;
      var r = await db.from('project_members').insert({ user_id: uid, project_id: pid, role_in_project: 'pm' });
      if (r.error) return toast('分配失败：' + (r.error.message || ''), 'err');
      toast('已分配项目'); await loadData(['pms'], true); renderShell();
    },

    memberUnassign: async function (uid, pid) {
      if (!S.profile || S.profile.role !== 'ops') return toast('无权限：成员管理仅限管理员', 'err');
      var mrow = S.members.filter(function (x) { return x.user_id === uid; })[0] || {};
      if (!window.confirm('确认移除「' + (mrow.name || '该成员') + '」与项目「' + projName(pid) + '」的关联？\n移除后该成员将无法再填报此项目。')) return;
      var r = await db.from('project_members').delete().eq('user_id', uid).eq('project_id', pid);
      if (r.error) return toast('移除失败：' + (r.error.message || ''), 'err');
      var m = S.members.filter(function (x) { return x.user_id === uid; })[0];
      if (m && m.project_id === pid) await db.from('profiles').update({ project_id: null }).eq('user_id', uid);
      toast('已移除'); await loadData(['members', 'pms'], true); renderShell();
    },

    jumpProject: async function (pid) {
      if (S.profile.role === 'president') { S.view = 'pres'; }
      else {
        S.filters.project = pid;
        /* 跳到对应口径的汇总页：住宅→运营汇总，商业→弘坊汇总 */
        S.view = isCom(pid) ? 'boardCom' : 'board';
      }
      await showPage();
    }
  };

  window.App = App;

  /* ================= 会话空闲超时 ================= */

  var idleTimer = null, lastAct = Date.now();
  function touchActivity() { lastAct = Date.now(); }
  function startIdleWatch() {
    ['mousedown', 'keydown', 'touchstart', 'scroll'].forEach(function (ev) {
      document.addEventListener(ev, touchActivity, true);
    });
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = setInterval(function () {
      if (!S.uid || !S.profile) return;
      if (Date.now() - lastAct < CFG.sessionIdleHours * 3600000) return;
      clearInterval(idleTimer); idleTimer = null;
      try { cloud.auth.signOut(); } catch (e) {}
      S.session = null; S.uid = null; S.profile = null;
      resetPageData();
      renderLogin('长时间未操作，已自动退出登录，请重新登录');
    }, 60000);
  }

  /* ================= 草稿自动保存 ================= */

  function bindDraftAutosave() {
    function schedule(ms) {
      if (S.view !== 'form' || isReviewer() || !S.uid || !canCapturePMDraft()) return;
      clearTimeout(draftAutosaveTimer);
      var scope=pmDraftScope(), session=S.session;
      draftAutosaveTimer = setTimeout(function () {
        if(S.view!=='form' || S.session!==session || pmDraftScope()!==scope || !canCapturePMDraft())return;
        snapDraft();saveDraft();
      }, ms);
    }
    document.addEventListener('input', function (event) { if(event.target.closest && event.target.closest('.planning-ai-dialog'))return;schedule(1400); }, true);
    document.addEventListener('change', function (event) { if(event.target.closest && event.target.closest('.planning-ai-dialog'))return;schedule(700); }, true);
    window.addEventListener('beforeunload', function (event) {
      if (S.view === 'form' && !isReviewer()) { snapDraft(); saveDraft(); }
      if(window.ReportAttachments && window.ReportAttachments.isUploading()){event.preventDefault();event.returnValue='';}
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && S.view === 'form' && !isReviewer()) { snapDraft(); saveDraft(); }
    });
  }

  /* ================= 启动 ================= */

  (async function boot() {
    try {
    /* 会话空闲超时 + 草稿自动保存：一次绑定，全局生效 */
    try { startIdleWatch(); bindDraftAutosave(); } catch (e) { /* 非致命 */ }

    try {
      cloud.auth.onAuthStateChange(function (event) {
        if (event === 'SIGNED_OUT' && (S.session || S.profile)) {
          if(window.PasswordChange)window.PasswordChange.close();
          S.session = null; S.uid = null; S.profile = null;
          resetPageData();
          renderLogin('登录已失效，请重新登录');
        }
      });
    } catch (e) { /* 非致命 */ }

    var sess = null;
    try { var r = await (window.PlanningBoot ? window.PlanningBoot.session : cloud.auth.getSession()); if (r && !r.error) sess = r.data; } catch (e) {}
    if (!sess) { renderLogin(); return; }
    bindSession(sess);
    if (!S.session || !S.uid) { S.session = null; S.uid = null; renderLogin(); return; }
    await afterLogin();
    } finally {
      if (window.PlanningBoot) window.PlanningBoot.complete();
    }
  })();

})();

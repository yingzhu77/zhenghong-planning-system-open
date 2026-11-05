/* 渲染冒烟测试：桩化云端 SDK 与 DOM，真实跑 app.js 的每个视图，断言不抛错且关键文案在位
   用法：node tests/frontend-render.mjs */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const REPORTER_TASKS = fs.readFileSync(path.join(__dirname, '..', 'web', 'reporter-tasks.js'), 'utf8');
const COMPLETION_REVIEW = fs.readFileSync(path.join(__dirname, '..', 'web', 'completion-review.js'), 'utf8');
const REPORT_ATTACHMENTS = fs.readFileSync(path.join(__dirname, '..', 'web', 'report-attachments.js'), 'utf8');
const REPORTER_ARCHIVE = fs.readFileSync(path.join(__dirname, '..', 'web', 'reporter-archive.js'), 'utf8');
const ADMIN_ARCHIVE = fs.readFileSync(path.join(__dirname, '..', 'web', 'admin-archive.js'), 'utf8');
const PLANNING_WINDOWS = fs.readFileSync(path.join(__dirname, '..', 'web', 'planning-windows.js'), 'utf8');
const BASELINE_CORE = fs.readFileSync(path.join(__dirname, '..', 'web', 'baseline-core.js'), 'utf8');
const OVERVIEW_MEETINGS = fs.readFileSync(path.join(__dirname, '..', 'web', 'overview-meetings.js'), 'utf8');
const COMPLETION_STATISTICS = fs.readFileSync(path.join(__dirname, '..', 'web', 'completion-statistics.js'), 'utf8');
const COORDINATION_WORKBENCH = fs.readFileSync(path.join(__dirname, '..', 'web', 'coordination-workbench.js'), 'utf8');
const MONTHLY_PLANS = fs.readFileSync(path.join(__dirname, '..', 'web', 'monthly-plans.js'), 'utf8');
const MONTHLY_SUMMARIES = fs.readFileSync(path.join(__dirname, '..', 'web', 'monthly-summaries.js'), 'utf8');
const PROJECT_PLAN_STATISTICS = fs.readFileSync(path.join(__dirname, '..', 'web', 'project-plan-statistics.js'), 'utf8');
const ADMIN_PLAN_OVERVIEW = fs.readFileSync(path.join(__dirname, '..', 'web', 'admin-plan-overview.js'), 'utf8');

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil((((t - ys) / 86400000) + 1) / 7);
}
function weekRange(d) {
  const t = new Date(d), day = t.getDay() || 7;
  const mon = new Date(t); mon.setDate(t.getDate() - day + 1);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const f = x => pad2(x.getMonth() + 1) + '.' + pad2(x.getDate());
  return f(mon) + '–' + f(sun);
}
const SHANGHAI_TODAY = new Date(new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) + 'T12:00:00');
const PERIOD = '第' + isoWeek(SHANGHAI_TODAY) + '周（' + weekRange(SHANGHAI_TODAY) + '）';

function makeEl(id) {
  const e = {
    id: id || '', innerHTML: '', value: '', textContent: '', className: '', disabled: false,
    style: {}, dataset: {}, children: [],
    setAttribute(k, v) { this.dataset['a_' + k] = v; },
    getAttribute(k) { return this.dataset['a_' + k]; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() { }, removeEventListener() { },
    querySelector() { return null; }, querySelectorAll() { return []; },
    focus() { }, click() { }
  };
  return e;
}

const DB = {
  projects: [
    { id: 'p1', name: '示例住宅一号', display_group: '示例住宅组一', sort_order: 1, camera_url: '主入口塔吊|https://cam.example.com/p1\n地下室|https://cam.example.com/p1b' },
    { id: 'p2', name: '示例住宅二号', display_group: '示例住宅组二', sort_order: 2, camera_url: '' },
    {
      id: 'p3', name: '示例商业项目', sort_order: 3, camera_url: '', project_type: 'com',
      biz_meta: { open_date: '2027-09-30', gfa: '45万㎡', invest: '68.5亿', brand_target: 700, first_store: '≥35%' }
    }
  ],
  milestones: [
    { id: 1, project_id: 'p1', name: '主体结构封顶', level: '一级节点', is_key: true, key_name: '主体封顶', plan_date: '2027-05-10', forecast_date: '2027-05-25', done: false, sort_order: 1, standard: '全部单体封顶', owner_dept: '工程部', line: '工程', discipline: '工程' },
    { id: 2, project_id: 'p1', name: '竣工备案', level: '一级节点', is_key: true, key_name: '竣工备案', plan_date: '2028-04-20', forecast_date: '2028-04-20', done: false, sort_order: 0, standard: '', owner_dept: '', line: '开发报建', discipline: '开发' },
    { id: 3, project_id: 'p2', name: '项目正式开工', level: '一级节点', is_key: true, key_name: '正式开工', plan_date: '2026-11-20', forecast_date: '2026-11-20', done: false, sort_order: 1, standard: '', owner_dept: '', line: '工程' },
    { id: 4, project_id: 'p3', name: '东地块地上主体结构封顶', level: '一级节点', is_key: true, key_name: '主体封顶(东)', plan_date: '2026-02-17', forecast_date: '2026-03-10', done: false, sort_order: 1, standard: '东地块全部单体封顶', owner_dept: '项目部', line: '工程', biz_line: '土建工程（东地块）' },
    { id: 5, project_id: 'p3', name: '正式开业', level: '一级节点', is_key: true, key_name: '正式开业', plan_date: '2027-09-30', forecast_date: '', done: false, sort_order: 2, standard: '示例商业项目正式开门营业', owner_dept: '商管公司', line: '商管运营' }
  ],
  reports: [
    {
      id: 'r1', project_id: 'p1', period: PERIOD, status: '关注', author_id: 'u-pm', author_name: '示例住宅经理',
      change_text: '15号楼封顶完成，==幕墙样板通过验收==，**进度可控**', dev_text: '幕墙分包招标延后', impact: '工期/节点',
      projection: '若再延 10 天，示范区开放受影响',
      node_items: [
        { name: '主体结构封顶', key: '主体封顶', plan: '2027-05-10', forecast: '2027-05-25', reason: '外架拆除冲突' },
        { name: '幕墙分包进场', plan: '2026-12-20', forecast: '2027-01-05', reason: '定标延后', custom: true }
      ],
      speed_items: [{ act: '增加一个作业面，夜间倒班', gain: '预计追回 8 天' }],
      effect_items: [{ act: '幕墙样板先行，工序移交联合验收', target: '品质一次成型' }],
      coord_items: [{ who: '招采负责人', what: '幕墙分包定标', by: '2026-11-30' }],
      next_items: ['完成幕墙定标', '完成 16 号楼封顶'],
      self_speed: '滞后', self_effect: '良好',
      submitted_at: new Date().toISOString(), updated_at: new Date().toISOString()
    },
    {
      id: 'r3a', project_id: 'p3', period: PERIOD, line: '土建工程（东地块）', status: '关注', author_id: 'u-pm2', author_name: '示例土建负责人',
      change_text: '东地块 1# 楼龙骨安装完成 50%', dev_text: '西地块材料封样未完成', impact: '工程品质',
      projection: '若封样再延 15 天，西地块幕墙进场推后，开业时点风险 1 个月',
      node_items: [{ name: '东地块地上主体结构封顶', key: '主体封顶(东)', plan: '2026-02-17', forecast: '2026-03-10', reason: '春节期间劳动力不足' }],
      speed_items: [{ act: '增加一个作业面并夜间倒班', gain: '预计追回 10 天' }],
      effect_items: [{ act: '封样定板先行，样板引路', target: '工程品质' }],
      coord_items: [{ who: '招采负责人', what: '幕墙材料定标', by: '2026-11-30' }],
      next_items: ['完成西地块封样', '完成 1# 楼龙骨安装'],
      self_speed: '滞后', self_effect: '达标',
      biz: {
        nodes: [
          { name: '东地块地上主体结构封顶', plan: '2026-02-17', prog: '已封顶，==屋面临近完成==', is_key: true },
          { name: '西地块地下结构封顶', plan: '2026-10-25', prog: '西区土方完成 80%', is_key: false }
        ],
        items: [
          { mod: '土建工程（东地块）', name: '景观-西地块定标配合', due: '2026-10-15', prog: '成本 10/10 清标，按计划推进' },
          { mod: '土建工程（东地块）', name: '幕墙材料封样', due: '2026-10-10', prog: '示例供应商调整铝型材合同，卡在招采' }
        ],
        handover: [{ what: '西地块地下室土建工作面', to: '机电安装', due: '2026-11-15' }],
        followups: [{ source_key: 'meeting:p3:anonymous-task', source_type: 'meeting', title: '会议要求', what: '样板反馈事项', due: '2026-10-26', progress: '样板已核对，待运营审核', status: 'completed' }]
      },
      submitted_at: new Date().toISOString(), updated_at: new Date().toISOString()
    },
    {
      id: 'r3b', project_id: 'p3', period: PERIOD, line: '成本', status: '正常', author_id: 'u-pm3', author_name: '示例成本负责人',
      change_text: '本期新签 12 个品牌，累计签约 128 个', dev_text: '无', impact: '招商签约',
      projection: '按当前节奏，开业期签约率可达 90%',
      node_items: [], speed_items: [{ act: '增加招商团队并组织路演', gain: '预计追回 5 天' }],
      effect_items: [{ act: '首店优先落位，一店一策', target: '开业效果' }],
      coord_items: [{ who: '示例土建负责人', what: '确认西地块土建工作面移交时间', by: '2026-10-20' }],
      next_items: ['完成主力店签约'],
      self_speed: '达标', self_effect: '达标',
      biz: {
        nodes: [{ name: '西地块地下结构封顶', plan: '2026-10-25', prog: '清单已出，待定标', is_key: false }],
        items: [{ mod: '成本', name: '西地块总包清单编制', due: '2026-10-20', prog: '已出 80%' }],
        handover: [{ what: '西地块成本清单移交', to: '土建工程（东地块）', due: '2026-10-25' }]
      },
      submitted_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }
  ],
  profiles: [],
  project_members: [],
  org: [
    { id: 1, name: '招采负责人', level: 1, sort_order: 1, dept: '招采' },
    { id: 2, name: '成本专员', level: 3, sort_order: 2, dept: '成本' }
  ],
  plan_versions: [{ id: 1, project_id: 'p1', version_name: 'V10月版', effective_date: '2026-10-01', note: '示例住宅改按封顶预售口径' }],
  /* 项目主数据窗口（2026-10-14 新增） */
  project_master: [
    { project_id: 'p1', fields: { city: '示例城市', area: '120000', gfa: '380000', plot_gfa: '300000', far: '2.5', fitout: '精装交付' }, updated_by: '示例管理员', updated_at: '2026-10-14' }
  ],
  project_phases: [
    { id: 'ph1', project_id: 'p1', name: '一期', area: '60000', gfa: '190000', units_total: 800, units_launched: 500, units_sold: 320, avg_price: '18000', value: '220000', plan_handover: '2028-06-30', sort_order: 1 }
  ],
  project_drawings: [
    { id: 'dw1', project_id: 'p1', kind: '项目总图', name: '示例住宅总图', url: 'https://img.example.com/z1.png', uploaded_by: '示例管理员', sort_order: 0 },
    { id: 'dw2', project_id: 'p1', kind: '分期图', name: '一期二期分期示意', url: 'https://img.example.com/z2.png', uploaded_by: '示例管理员', sort_order: 0 }
  ]
};

function run(role, options = {}) {
  DB.profiles = role === 'ops'
    ? [{ user_id: 'u-ops', name: '示例管理员', role: 'ops', status: 'approved' },
       { user_id: 'u-pm', name: '示例住宅经理', role: 'pm', status: 'approved', project_id: 'p1' },
       { user_id: 'u-pm2', name: '示例土建负责人', role: 'pm', status: 'approved', project_id: 'p3', biz_line: '土建工程（东地块）', discipline: '工程' }]
    : role === 'president'
      ? [{ user_id: 'u-boss', name: '总裁', role: 'president', status: 'approved' },
         { user_id: 'u-pm', name: '示例住宅经理', role: 'pm', status: 'approved', project_id: 'p1' },
         { user_id: 'u-pm2', name: '示例土建负责人', role: 'pm', status: 'approved', project_id: 'p3', biz_line: '土建工程（东地块）', discipline: '工程' }]
      : role === 'pzo'
        ? [{ user_id: 'u-pzo', name: '项目总', role: 'pzo', status: 'approved', project_id: options.pzoResidential ? 'p1' : 'p3' }]
      : role === 'pm-com'
        ? [{ user_id: 'u-pm2', name: '示例土建负责人', role: 'pm', status: 'approved', project_id: 'p3', biz_line: '土建工程（东地块）', discipline: '工程' }]
        : [{ user_id: 'u-pm', name: '示例住宅经理', role: 'pm', status: 'approved', project_id: 'p1' }];
  if (options.profileMissing) DB.profiles = [];
  if (options.pmDiscipline && role === 'pm') DB.profiles[0].discipline = options.pmDiscipline;
  DB.project_members = role === 'pzo'
    ? [{ user_id: 'u-pzo', project_id: options.pzoResidential ? 'p1' : 'p3', role_in_project: 'pzo' }]
    : role === 'pm-com'
    ? [{ user_id: 'u-pm2', project_id: 'p3', role_in_project: 'pm' }]
    : [{ user_id: 'u-pm', project_id: 'p1', role_in_project: 'pm' }];

  const root = makeEl('root');
  const body = makeEl('body');
  const inputs = new Map();
  const drafts = new Map();
  const writes = [];
  const reads = [], requests = [];
  const passwordGate = {shown: [], loads: 0, closes: 0};
  let authListener = null, logoutCount = 0;
  const uid = role === 'ops' ? 'u-ops' : role === 'president' ? 'u-boss' : role === 'pzo' ? 'u-pzo' : role === 'pm-com' ? 'u-pm2' : 'u-pm';
  const initialSession = {user: {id: uid, ...(options.mustChangePassword ? {must_change_password: true} : {})}};

  const document = {
    getElementById: id => (id === 'root' ? root : inputs.get(id) || null),
    createElement: () => makeEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() { }, removeEventListener() { },
    body, documentElement: body
  };
  function chain(table) {
    reads.push(table);
    const rows = table === 'milestones' ? (DB[table] || []).concat([
      {id: 9001, project_id: 'p1', name: '当周住宅基准节点', is_key: true, discipline: '工程', line: '工程',
        plan_date: sandbox.PlanningWindows.addDays(sandbox.PlanningWindows.periodStart(PERIOD), 3), forecast_date: '2027-05-25', note: '住宅基准原说明'},
      {id: 9002, project_id: 'p3', name: '当周商业基准节点', is_key: false, biz_line: '土建工程（东地块）', line: '工程',
        plan_date: sandbox.PlanningWindows.addDays(sandbox.PlanningWindows.periodStart(PERIOD), 3), forecast_date: '2027-05-25', note: '商业基准原说明'}
    ]) : DB[table] || [];
    let insertedRows;
    const obj = {
      select() { return obj; }, eq() { return obj; }, order() { return obj; }, limit() { return obj; },
      insert(row) { writes.push({ table, operation: 'insert', row }); insertedRows = [{ user_id: uid, ...row }]; return obj; },
      update() { return Promise.resolve({ data: [rows[0] || {}], error: null }); },
      delete() { return Promise.resolve({ data: [rows[0] || {}], error: null }); },
      upsert() { return Promise.resolve({ data: [rows[0] || {}], error: null }); },
      then(res) { return Promise.resolve({ data: insertedRows || rows, error: null }).then(res); }
    };
    return obj;
  }
  const sandbox = {
    console, setTimeout, clearTimeout,
    localStorage: {getItem: key => drafts.get(key) || null, setItem: (key, value) => drafts.set(key, String(value)), removeItem: key => drafts.delete(key)},
    fetch: async (url, init) => {
      requests.push(url);
      if (url === '/api/project-people/list') {
        const projectId = JSON.parse(init.body).project_id;
        const people = DB.profiles.filter(person => person.status === 'approved' &&
          (['ops', 'president'].includes(person.role) || person.project_id === projectId ||
           DB.project_members.some(member => member.user_id === person.user_id && member.project_id === projectId)))
          .map(({user_id, name, role, discipline, biz_line}) => ({user_id, name, role, discipline, biz_line}));
        return {ok: true, json: async () => ({data: people, error: null})};
      }
      if (url === '/api/completions/statistics') {
        const query = JSON.parse(init.body), employees = DB.profiles.filter(person => person.status === 'approved')
          .map(person => ({...person, counts: {}, categories: []}));
        return {ok: true, json: async () => ({data: {range: {start: query.start, end: query.end}, totals: {}, employees,
          filters: {projects: DB.projects, employees, disciplines: [], kinds: []}}, error: null})};
      }
      if (url === '/api/project-plan-statistics') {
        const filters = JSON.parse(init.body), projects = DB.projects.filter(project => role !== 'pzo'
          || DB.project_members.some(member => member.user_id === uid && member.project_id === project.id));
        return {ok: true, json: async () => ({data: {today: SHANGHAI_TODAY.toISOString().slice(0, 10), source: filters.kind === 'all' ? 'all_baseline' : filters.kind === 'com' ? 'com_baseline' : 'res_baseline',
          filters, options: {projects, groups: projects.map(project => project.display_group || project.name), disciplines: [], levels: []}, rows: [], projects: [],
          totals: {total: 0, completed: 0, incomplete: 0, group_count: 0, project_count: 0}}, error: null})};
      }
      if(url.startsWith('/api/monthly-summaries?month=') || url==='/api/commercial-module-grants')return {ok:true,json:async()=>({data:[]})};
      const tables = { '/api/report-scopes/list': 'report_scopes', '/api/monthly-plans/list': 'monthly_plans',
        '/api/reporter-tasks/list': 'reporter_tasks', '/api/coordination-tasks/list': 'coordination_tasks', '/api/completions/list': 'completion_requests',
        '/api/report-attachments/list': 'report_attachments' };
      if (!tables[url]) throw new Error('Unexpected request in anonymous render fixture: ' + url);
      return { ok: true, json: async () => ({ data: DB[tables[url]] || [], has_more: false, next_cursor: null }) };
    },
    addEventListener() { }, removeEventListener() { },
    document,
    WorkBuddyCloud: {
      createWorkBuddyCloud: () => ({
        database: { from: chain },
        auth: {
          getSession: () => Promise.resolve({ data: { session: initialSession } }),
          getUser: () => Promise.resolve({ data: { id: uid } }),
          onAuthStateChange: callback => { authListener = callback; },
          signOut: async () => {
            logoutCount++;
            if (options.signOutError) return {error: {message: '匿名测试退出失败'}};
            if (options.emitSignOut && authListener) authListener('SIGNED_OUT');
            return {error: null};
          }
        }
      })
    }
  };
  if (options.mustChangePassword) {
    sandbox.PlanningBoot = {assets: {}, session: Promise.resolve({data: {session: initialSession}}), complete() {},
      ensurePasswordChange: async () => { passwordGate.loads++; },
      ensureEditor: async () => {}, ensureWorkflow: async () => {}, ensureReporter: async () => {}, ensureCoordination: async () => {}};
    sandbox.PasswordChange = {show: configuration => {passwordGate.shown.push(configuration); return true;},
      close: () => {passwordGate.closes++;}};
  }
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(REPORTER_TASKS, sandbox, { filename: 'reporter-tasks.js' });
  vm.runInContext(COMPLETION_REVIEW, sandbox, { filename: 'completion-review.js' });
  vm.runInContext(REPORT_ATTACHMENTS, sandbox, { filename: 'report-attachments.js' });
  vm.runInContext(REPORTER_ARCHIVE, sandbox, { filename: 'reporter-archive.js' });
  vm.runInContext(ADMIN_ARCHIVE, sandbox, { filename: 'admin-archive.js' });
  vm.runInContext(PLANNING_WINDOWS, sandbox, { filename: 'planning-windows.js' });
  vm.runInContext(BASELINE_CORE, sandbox, { filename: 'baseline-core.js' });
  vm.runInContext(OVERVIEW_MEETINGS, sandbox, { filename: 'overview-meetings.js' });
  vm.runInContext(COMPLETION_STATISTICS, sandbox, { filename: 'completion-statistics.js' });
  vm.runInContext(COORDINATION_WORKBENCH, sandbox, { filename: 'coordination-workbench.js' });
  vm.runInContext(MONTHLY_PLANS, sandbox, { filename: 'monthly-plans.js' });
  vm.runInContext(MONTHLY_SUMMARIES, sandbox, { filename: 'monthly-summaries.js' });
  vm.runInContext(PROJECT_PLAN_STATISTICS, sandbox, { filename: 'project-plan-statistics.js' });
  vm.runInContext(ADMIN_PLAN_OVERVIEW, sandbox, { filename: 'admin-plan-overview.js' });
  vm.runInContext(SRC, sandbox, { filename: 'app.js' });
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (!sandbox.App) return reject(new Error('App 未挂载'));
      resolve({ App: sandbox.App, OverviewMeetings: sandbox.OverviewMeetings, root, inputs, writes, reads, requests, passwordGate, auth: {get logoutCount() {return logoutCount;}} });
    }, 60);
  });
}

const failures = [];
function ok(cond, msg) { if (!cond) failures.push(msg); }
function has(html, s) { return String(html).indexOf(s) >= 0; }
function nav(html, label = '主导航') {
  if (label === '子导航') {
    return nav(html).match(/<div class="planning-nav-group"><button\b[^>]*class="planning-primary-trigger on"[^>]*>[^<]*<\/button><div class="planning-dropdown"[^>]*>([\s\S]*?)<\/div><\/div>/)?.[1] || '';
  }
  return String(html).match(new RegExp('<nav\\b[^>]*aria-label="' + label + '"[^>]*>([\\s\\S]*?)</nav>'))?.[1] || '';
}
function main(html) { return String(html).match(/<main>([\s\S]*?)<\/main>/)?.[1] || ''; }
function hasOverviewAction(html, kind) {
  return new RegExp('App\\.overviewArrange\\([^>]*&quot;' + kind + '&quot;\\)').test(main(html));
}
function hasMeetingAssignment(html, commercial) {
  return has(main(html), 'OverviewMeetings.add(') && has(main(html), commercial ? '会议要求事项' : '领导工作安排');
}
function navLabels(html, labels, label = '主导航') {
  const section = nav(html, label);
  const pattern = label === '主导航'
    ? /<button\b[^>]*class="planning-primary-trigger[^\"]*"[^>]*>([^<]*)<\/button>/g
    : /<button\b[^>]*>([^<]*)<\/button>/g;
  const actual = [...section.matchAll(pattern)].map(match => match[1]);
  return actual.length === labels.length && labels.every(text => actual.includes(text));
}
function noCameraUi(html, context) {
  ok(!/视频监控|现场监控|项目监控配置|camcfg_|App\.(?:camEmbed|saveCam)|cam\.example\.com|主入口塔吊/.test(String(html)), context + '仍显示监控入口、配置或存量监控链接');
}
function noReporterPageHeading(html, context) {
  ok(!/<header\b[^>]*class="topbar"|<h1\b/.test(main(html)), context + '仍显示重复的页面标题或项目名');
}
function identityRole(html) { return String(html).match(/<span class="rl">([^<]*)<\/span>/)?.[1] || ''; }

(async () => {
  /* 初始密码会话先改密；尚无 profile 时退出和迟到的成功回调也不能恢复旧身份。 */
  {
    const first = await run('ops', {mustChangePassword: true});
    const gate = first.passwordGate.shown[0];
    ok(first.passwordGate.loads === 1 && first.passwordGate.shown.length === 1 && gate?.isCurrent(), '初始密码会话未进入唯一改密入口');
    ok(has(first.root.innerHTML, '请先设置新的登录密码') && !nav(first.root.innerHTML) && !has(first.root.innerHTML, '示例住宅一号'), '改密前不应显示任何业务页面');
    ok(first.reads.length === 0 && first.requests.length === 0, '改密前不应请求 profile、数据库表或业务接口');
    if (gate) {
      await gate.onSuccess({user: {id: 'u-ops', must_change_password: false}});
      ok(navLabels(first.root.innerHTML, ['计划总览', '统计分析', '事项管理', '项目资料', '系统设置']) && first.reads.includes('projects'), '改密成功的新会话未继续原管理员页面');
      const readsAfterSuccess = first.reads.length;
      ok(!gate.isCurrent(), '成功后旧改密会话仍有效');
      await gate.onSuccess({user: {id: 'u-ops', must_change_password: false}});
      ok(first.reads.length === readsAfterSuccess, '迟到的重复改密成功回调不应重新载入业务');
    }
    const logoutOptions = {mustChangePassword: true, signOutError: true, emitSignOut: true};
    const signingOut = await run('pm-com', logoutOptions), logoutGate = signingOut.passwordGate.shown[0];
    if (logoutGate) {
      let failed = false;
      try { await logoutGate.onLogout(); } catch (error) { failed = true; }
      ok(failed && logoutGate.isCurrent(), '退出请求失败时应保留强制改密会话');
      logoutOptions.signOutError = false;
      await logoutGate.onLogout();
      const loggedOutHtml = signingOut.root.innerHTML;
      ok(signingOut.auth.logoutCount === 2 && !logoutGate.isCurrent() && has(loggedOutHtml, 'id="authForm"') && !nav(loggedOutHtml), '尚无 profile 的改密账号退出后应清理身份并显示登录页');
      await logoutGate.onSuccess({user: {id: 'u-pm2', must_change_password: false}});
      ok(signingOut.root.innerHTML === loggedOutHtml && signingOut.reads.length === 0 && signingOut.requests.length === 0, '退出后迟到的改密结果不能恢复旧账号或读取业务');
    } else ok(false, '提报人初始密码会话缺少改密入口');
    console.log('First-login password gate render OK');
  }

  /* ---------- 运营 / 总裁端 ---------- */
  {
    const originalReports = DB.reports, originalNotes = DB.leader_notes;
    DB.reports = [...originalReports,
      { ...originalReports.find(r => r.id === 'r3a'), id: 'r3-extra', author_id: 'u-pm-extra', author_name: '示例同专业提报人' },
      { ...originalReports.find(r => r.id === 'r3a'), id: 'r3-legacy', line: '土建工程', author_name: '示例旧土建填报人',
        biz: {nodes: [], items: [{mod: '土建工程', name: '既有未分地块土建计划', due: '2026-10-15', prog: '保留原记录'}], handover: []} }
    ];
    DB.leader_notes = [
      { id: 'note-profession', project_id: 'p3', period: PERIOD, kind: 'ceo_brief', what: '【土建工程（东地块）】专业会议要求', due: '' },
      { id: 'note-other', project_id: 'p3', period: PERIOD, kind: 'ceo_brief', what: '【成本】其他专业要求', due: '' },
      { id: 'note-legacy', project_id: 'p3', period: PERIOD, kind: 'ceo_brief', what: '旧版未归专业的会议要求', due: '' },
      { id: 'note-unknown', project_id: 'p3', period: PERIOD, kind: 'ceo_brief', what: '【既有旧专业】未迁移会议要求', due: '' }
    ];
    const { App, OverviewMeetings, root, requests } = await run('ops');
    let html = root.innerHTML;
    ok(identityRole(html) === '管理员', 'ops 账号展示身份应为管理员');
    ok(navLabels(html, ['计划总览', '统计分析', '事项管理', '项目资料', '系统设置']), '运营主导航应为已确认五组入口');
    ok(navLabels(html, ['住宅计划总览', '商业计划总览', '批量导入计划'], '子导航'), '管理员计划总览应包含住宅、商业总览和批量导入计划');
    ok(has(main(html), 'App.openAdminPlans(false)'), '管理员住宅总览应提供批量导入计划入口');
    noReporterPageHeading(html, '运营计划总览');
    ok(has(html, 'id="overviewFilter"') && has(html, '筛选项目') && !has(html, 'planning-project-jump'), '仅住宅计划总览应以项目筛选替换顶部详情跳转');
    await App.section('analysis'); html = root.innerHTML;
    ok(navLabels(html, ['项目计划统计', '员工完成统计'], '子导航') && !has(html, '住宅节点偏差') && !has(html, '商业基准节点明细'), '统计分析应只保留项目计划统计与员工完成统计');
    ok(requests.includes('/api/project-plan-statistics') && has(main(html), '基准节点总量') && has(main(html), '全部展示组') && !has(main(html), '商业确认月计划'), '项目计划统计应调用独立接口并保留商住基准统计与筛选');
    ok(has(html, 'planning-project-jump') && has(html, '查看项目详情'), '统计分析应保留原详情跳转');
    await App.section('projects'); html = root.innerHTML;
    ok(navLabels(html, ['项目档案', '资料共享'], '子导航') && has(main(html), 'admin-archive'), '项目资料应提供项目档案和已有资料共享入口');
    noCameraUi(html, '运营项目资料');
    await App.section('settings'); html = root.innerHTML;
    ok(navLabels(html, ['节点归属设置', '成员与权限'], '子导航') && has(main(html), 'App.lineSaveAll'), '系统设置应归集节点归属及原成员权限入口');
    await App.view('members'); html = root.innerHTML;
    ok(has(main(html), 'App.memberSet'), '成员与权限入口未通向原成员管理');

    await App.view('pres'); html = root.innerHTML;
    ok(has(main(html), '示例住宅一号') && has(main(html), '示例住宅二号') && !has(main(html), '示例商业项目'), '住宅计划总览项目范围不正确');
    ok(has(main(html), 'overview-project-layout') && has(main(html), 'overview-project-drawing'), '住宅总览缺少横向项目分区或右侧总图');
    ok(has(html, '当周住宅基准节点') && has(html, '住宅基准原说明'), '住宅总览丢失当前窗口基准节点或原说明');
    ok(has(html, '既有住宅补充记录') && has(html, '提速对策') && has(html, '效果保障'), '住宅总览丢失已有补充记录');
    ok(has(html, '<span class="mk-red">幕墙样板通过验收</span>') && has(html, '<b>进度可控</b>'), '住宅总览未保留长文本标红/加粗');
    ok(has(main(html), "App.openProjectDetail('p1')") && has(main(html), "App.openProjectDetail('p2')"), '住宅项目缺少实际详情入口');
    ok(has(main(html), '领导工作安排') && has(main(html), '新增工作安排') && has(main(html), 'OverviewMeetings.add(')
      && !hasOverviewAction(html, 'ceo_brief') && !hasOverviewAction(html, 'pzo_note'), '运营总览应复用单人会议分派入口，避免重复写入领导交代');
    ok(!has(html, 'App.saveCeoReview') && !has(html, 'App.savePzoReview'), '计划总览仍暴露评价录入');
    ok(has(html, '示例住宅总图') && has(html, 'https://img.example.com/z1.png'), '住宅总览缺少已有总图');
    ok(/<details\b[^>]*class="card overview-project overview-display-group"/.test(main(html)) && has(html, '筛选专业')
      && has(main(html), 'overview-residential-report'), '住宅总览应按展示组折叠并提供专业筛选的统一计划页');
    App.overviewFilter('示例住宅组二'); html = root.innerHTML;
    ok(has(main(html), '示例住宅二号') && !has(main(html), '示例住宅一号'), '住宅项目筛选未缩小页面范围');
    ok(/<details\b[^>]*data-project-group="示例住宅组二"[^>]*\sopen(?:\s|>)/.test(main(html)), '筛选住宅展示组后应自动展开');
    App.overviewFilter(''); html = root.innerHTML;
    noCameraUi(html, '运营住宅计划总览');

    await App.view('presCom'); html = root.innerHTML;
    ok(has(main(html), '示例商业项目') && !has(main(html), '示例住宅二号'), '商业计划总览混入住宅项目');
    ok((main(html).match(/data-module="/g) || []).length === 12, '商业总览应显示十二个专业模块');
    ok(has(main(html), 'data-module="土建工程（东地块）"') && has(main(html), 'data-module="土建工程（西地块）"') && has(main(html), 'data-module="开发"'), '商业总览应分别显示东、西土建及开发模块');
    const legacyProfession = main(html).match(/<details class="overview-module overview-legacy-module"[^>]*>([\s\S]*?)<\/details>/)?.[1] || '';
    ok(has(legacyProfession, '既有未分地块土建计划') && has(legacyProfession, '保留原记录') && has(legacyProfession, "App.showReportHistory("), '旧土建报告及版本入口应保留在既有模块记录');
    ok(!has(legacyProfession, 'App.overviewArrange'), '旧土建模块仅保留只读报告，不增加新模块安排入口');
    ok(has(html, '筛选专业') && !has(html, 'planning-project-jump') && has(html, 'App.overviewExpandAll(true)') && has(html, 'App.overviewExpandAll(false)'), '商业总览应提供专业筛选及批量展开收起');
    ok(has(html, '当周商业基准节点') && has(html, '当月计划填报') && has(html, '幕墙材料封样'), '商业总览丢失当前窗口基准节点或计划事项');
    ok(has(html, '四、其他事项') && has(html, '样板反馈事项') && has(html, '样板已核对，待运营审核')
      && has(html, '本人反馈完成（以运营审核为准）') && !has(html, '四、工作面移交') && !has(html, 'class="overview-sync"'), '第四部分应显示当期同步反馈且不重复，不能把本人反馈当审核通过');
    ok(DB.reports.find(r => r.id === 'r3a').biz.handover[0].what === '西地块地下室土建工作面', '取消总览移交表不应改写原移交数据');
    ok(['nodes', 'plans', 'coord', 'other'].every(section => new RegExp('<table\\b[^>]*data-section="' + section + '"').test(main(html))), '会议总览四部分应分别展开横向表格');
    // A module now contains a nested historical-node disclosure; match its balanced boundary.
    const moduleStart = main(html).search(/<details class="overview-module[^"]*" data-module="土建工程（东地块）"/);
    const moduleHtml = main(html).slice(moduleStart);
    let moduleDepth = 0, moduleEnd = 0;
    for (const tag of moduleHtml.matchAll(/<details\b[^>]*>|<\/details>/g)) {
      moduleDepth += tag[0].startsWith('</') ? -1 : 1;
      if (!moduleDepth) { moduleEnd = tag.index + tag[0].length; break; }
    }
    const sameProfession = moduleStart >= 0 ? moduleHtml.slice(0, moduleEnd) : '';
    ok(['nodes', 'plans', 'coord', 'other'].every(section => (sameProfession.match(new RegExp('<table\\b[^>]*data-section="' + section + '"', 'g')) || []).length === 1), '同专业多人填报应合并为四部分各一张表');
    const mergedPlans = sameProfession.match(/<table\b[^>]*data-section="plans"[^>]*>([\s\S]*?)<\/table>/)?.[1] || '';
    ok(has(mergedPlans, '填报人：示例土建负责人') && has(mergedPlans, '填报人：示例同专业提报人'), '专业合并计划表未标明各行的填报来源');
    ok((sameProfession.match(/App\.showReportHistory\(/g) || []).length === 2 && has(sameProfession, 'data-report-id="r3a"') && has(sameProfession, 'data-report-id="r3-extra"'), '专业合并后应保留每份报告的版本入口');
    ok(['序号', '类别', '事项内容', '完成时间', '完成情况及本周计划'].every(label => has(main(html), label)), '当月计划表缺少样表字段映射');
    ok(has(html, '成本 10/10 清标，按计划推进') && has(html, '示例供应商调整铝型材合同，卡在招采'), '会议计划表未完整保留原进展正文');
    ok(!has(sameProfession.match(/<section class="overview-core-nodes">([\s\S]*?)<\/section>/)?.[1], '屋面临近完成')
      && has(sameProfession, '商业基准原说明'), '商业基准区不得混入旧手填节点反馈，原基准说明应保留');
    ok(has(html, 'OverviewMeetings.add(') && has(html, '会议要求事项')
      && !hasOverviewAction(html, 'pzo_note') && !hasOverviewAction(html, 'ceo_brief') && !has(html, 'App.saveCeoBriefs'), '运营商业总览应以会议表分派，既有领导要求保留只读');
    ok(!has(html, 'data-note-kind="pzo_note"') && !has(html, 'App.savePzoNotes'), '尚无项目总工作要求时不应显示空表或保存入口');
    ok(has(html, '暂无当月计划') && has(html, '暂无其他事项') && has(html, '本期暂无附件') && has(html, 'overview-report-files'), '未报模块的空表或右侧无附件状态未明确展示');
    ok(!has(html, 'App.saveCeoReview') && !has(html, 'App.savePzoReview'), '商业计划总览仍暴露评价录入');
    ok((sameProfession.match(/class="overview-meetings"/g) || []).length === 1, '同专业多位填报人不应重复生成会议要求表');
    for (const note of DB.leader_notes) ok(!has(main(html), note.what), '旧领导记录不应重新混入当前会议待办：' + note.id);
    await App.openProjectDetail('p3'); await App.detailTab('review');
    for (const note of DB.leader_notes) ok((main(root.innerHTML).split(note.what).length - 1) === 1, '原领导记录在项目详情遗漏或重复：' + note.id);
    await App.view('presCom'); html = root.innerHTML;
    const noteInputIds = [...main(html).matchAll(/<input\b[^>]*id="((?:cbw|pzw)_p3_\d+)"/g)].map(match => match[1]);
    ok(noteInputIds.length === 0, '既有领导要求只读区不应保留可写输入');
    await new Promise(resolve => setImmediate(resolve));
    const meetingScope = Number(sameProfession.match(/OverviewMeetings\.add\((\d+)\)/)?.[1]);
    const meetingDraft = OverviewMeetings.add(meetingScope);
    OverviewMeetings.change(meetingDraft, 'owner_id', 'u-pm2');
    OverviewMeetings.change(meetingDraft, 'what', '筛选前未保存的实名会议要求');
    App.overviewFilter('成本'); html = root.innerHTML;
    ok((main(html).match(/data-module="/g) || []).length === 1 && has(main(html), 'data-module="成本"') && !has(main(html), 'data-module="土建工程（东地块）"'), '商业专业筛选应只展示选中模块');
    ok(/<details\b[^>]*data-module="成本"[^>]*\sopen(?:\s|>)/.test(main(html)), '筛选商业专业后应自动展开');
    App.overviewFilter('土建工程（东地块）'); html = root.innerHTML;
    ok(has(main(html), '筛选前未保存的实名会议要求'), '筛选后返回原专业丢失未保存会议要求');
    App.overviewToggle(JSON.stringify(['profession', 'p3', '土建工程（东地块）']), false);
    App.overviewFilter(''); html = root.innerHTML;
    ok(!/<details\b[^>]*data-module="土建工程（东地块）"[^>]*\sopen(?:\s|>)/.test(main(html)), '重渲后应保留用户收起的专业状态');
    ok(DB.leader_notes.some(note => note.what === '【成本】其他专业要求') && DB.leader_notes.some(note => note.what === '旧版未归专业的会议要求'), '筛选及折叠不应改写其他专业或项目级原工作记录');

    for (const removed of ['board', 'boardCom', 'presPzo', 'dual', 'cams']) {
      await App.view(removed); html = root.innerHTML;
      ok(navLabels(html, ['住宅计划总览', '商业计划总览', '批量导入计划'], '子导航') && has(main(html), 'data-project-type="res"'), '已撤销入口 ' + removed + ' 应回落住宅计划总览并保留管理员导入入口');
      noCameraUi(html, '运营访问已撤销入口 ' + removed);
    }

    await App.view('coord'); html = root.innerHTML;
    ok(has(html, '工作站面移交') || has(html, '工作面移交'), '协调总表未纳入商业工作面移交');
    ok(navLabels(html, ['协调需求', '完成与延期审核', '会议管理'], '子导航'), '事项管理缺少协调、完成延期审核或会议入口');
    await App.view('completion'); html = root.innerHTML;
    ok(has(main(html), '事项完成与延期审核') && has(main(html), '已加载范围内没有完成申请命中当前条件'), '运营事项审核页未使用真实审核列表与分页范围提示');
    await App.view('meetings'); html = root.innerHTML;
    ok(has(main(html), '会议') && has(main(html), '承办人') && has(main(html), 'ReporterTasks.'), '运营会议页缺少实际分派入口');
    await App.view('completionStats'); html = root.innerHTML;
    ok(requests.includes('/api/completions/statistics') && has(main(html), '员工事项完成统计') && has(main(html), '示例住宅经理')
      && has(main(html), '按实际完成日期') && has(main(html), '含零完成'), '员工统计页未调用独立聚合接口或未显示零完成实名员工及日期口径');

    await App.view('members'); html = root.innerHTML;
    noCameraUi(html, '运营成员权限');
    const roleOptions = new Map([...main(html).matchAll(/<option value="(pm|ops|president|pzo)"[^>]*>([^<]+)<\/option>/g)].map(match => [match[1], match[2]]));
    ok(roleOptions.size === 4 && roleOptions.get('pm') === '提报人' && roleOptions.get('ops') === '管理员' && roleOptions.get('president') === '总裁' && roleOptions.get('pzo') === '项目总', '成员角色应保持原四个值并显示统一名称');
    /* 2026-10-14：成员管理新增「专业条线」列 */
    ok(has(html, '专业条线') && has(html, 'App.memberSet') && has(html, '未指定条线'), '成员管理缺少专业条线列');

    /* 自动提取需要结构化归属；运营维护入口与旧条线字段分别保留。 */
    await App.view('lineAdm'); html = root.innerHTML;
    ok(has(html, 'App.lineSaveAll') && has(html, 'ln_line_1') && has(html, 'ln_scope_1') && has(html, '自动提取归属'), '运营节点归属维护应包含明确的自动提取专业字段并保留旧条线');
    await App.view('master'); html = root.innerHTML;
    ok(has(html, 'admin-archive') && has(html, '项目总图'), '管理员项目档案未复用七类结构');
    ok(has(html, '示例住宅总图') && has(html, 'https://img.example.com/z1.png'), '项目档案缺少已保存总图');
    ok(has(html, 'ZHAdminArchive.saveFields') && has(html, 'admin-archive-drawing-editor'), '项目档案缺少原权限内维护入口');
    noReporterPageHeading(html, '运营项目档案');
    for (const v of ['projectPlanStats', 'coord', 'master']) { await App.view(v); ok(root.innerHTML.length > 500, '运营端视图 ' + v + ' 渲染为空'); }
    await App.view('projectPlanStats');
    ok(has(main(root.innerHTML), '示例商业项目') && has(main(root.innerHTML), '示例住宅二号'), '合并项目统计的项目筛选应同时包含住宅和商业');
    for (const removed of ['nodes', 'nodesCom']) {
      await App.view(removed);
      ok(has(main(root.innerHTML), 'data-project-type="res"') && !has(main(root.innerHTML), '商业基准节点明细') && !has(main(root.innerHTML), '住宅节点偏差'), '撤销的节点明细入口应回落计划总览');
    }
    DB.reports = originalReports;
    if (originalNotes === undefined) delete DB.leader_notes; else DB.leader_notes = originalNotes;
    console.log('OPS render OK');
  }

  /* ---------- 总裁端（三栏导航） ---------- */
  {
    const { App, root } = await run('president');
    let html = root.innerHTML;
    ok(identityRole(html) === '总裁', 'president 展示身份应保持总裁');
    const n = nav(html);
    ok(navLabels(html, ['计划总览', '统计分析', '项目资料']), '总裁应显示已授权的阅读及统计导航子集');
    ok(navLabels(html, ['住宅计划总览', '商业计划总览'], '子导航'), '总裁应看到住宅和商业两类计划总览');
    ok(!has(n, '批量导入计划') && !has(main(html), 'App.openAdminPlans'), '总裁只读导航和正文不能泄漏管理员代填导入入口');
    ok(!has(n, '系统设置') && !has(n, '事项管理') && !has(n, '员工完成统计'), '总裁导航混入运营维护或员工统计入口');
    ok(has(main(html), '示例住宅一号') && has(main(html), '领导工作安排') && has(main(html), '新增工作安排'), '总裁住宅总览缺少项目或本人工作安排入口');
    ok(!has(html, 'App.saveCeoReview') && !has(html, 'App.savePzoReview') && !has(html, 'App.savePzoNotes') && !hasOverviewAction(html, 'pzo_note'), '总裁总览暴露已取消评价或项目总写入入口');
    noReporterPageHeading(html, '总裁计划总览');
    for (const removed of ['board', 'coord', 'master', 'cams', 'nodes', 'nodesCom', 'adminPlans']) {
      await App.view(removed); html = root.innerHTML;
      ok(navLabels(html, ['住宅计划总览', '商业计划总览'], '子导航') && has(main(html), 'data-project-type="res"'), '总裁撤销入口应回落住宅计划总览');
      ok(!has(main(html), 'App.memberSet') && !has(main(html), 'ZHAdminArchive.saveFields'), '总裁撤销入口扩大管理权限');
      noCameraUi(html, '总裁访问已撤销入口');
    }
    await App.view('projectPlanStats'); html = root.innerHTML;
    ok(has(main(html), '项目计划统计') && has(main(html), 'ProjectPlanStatistics.exportCsv') && !has(main(html), 'App.memberSet') && !has(main(html), 'App.lineSaveAll') && !has(main(html), 'ZHAdminArchive.saveFields'), '总裁应可只读查看并导出合并统计，不扩大维护职责');
    console.log('President render OK');
  }

  /* ---------- 项目经理端 ---------- */
  {
    const { App, root } = await run('pm');
    let html = root.innerHTML;
    ok(identityRole(html) === '提报人' && DB.profiles[0].role === 'pm', '住宅场景账号应使用统一提报人身份和原 pm 角色');
    const n = nav(html);
    ok(navLabels(html, ['工作台', '本期填报', '项目资料', '历史记录']), 'PM 主导航应为四个整合入口');
    ok(!has(nav(html), '批量导入计划') && !has(main(html), 'App.openAdminPlans'), '住宅提报人不能看到管理员代填导入入口');
    ok(!has(n, '节点基线'), 'PM 导航仍残留独立「节点基线」页签');
    ok(!has(n, '成员权限') && !has(n, '项目分析'), 'PM 主导航混入管理入口');
    noReporterPageHeading(html, '住宅填报');
    ok(has(main(html), '五、附件资料') && has(main(html), 'id="report-attachment-upload"'), '住宅填报缺少第五附件上传区');

    /* 基准按明确专业只读展示；既有手填节点保留在原记录区。 */
    ok(has(html, '一、本周核心节点计划') && has(html, 'id="baseline-core-summary"') && has(html, 'data-baseline-status="no-scope"'), '住宅未分配专业时应显示明确基准范围状态');
    const unassignedOptions = html.match(/<datalist id="bn_list">([\s\S]*?)<\/datalist>/)?.[1] || '';
    ok(!has(unassignedOptions, '<option'), '未指定专业的填报人不应按旧line或姓名猜测节点候选归属');
    ok(!has(html, 'App.addBizNode()') && !has(html, 'id="bn_nm_') && has(html, '原手填节点与草稿（保留，不参与自动汇总）') && has(html, '幕墙分包进场'), '住宅旧节点应保留只读原文，不重新成为手工基准录入');
    ok(has(html, '二、当月计划填报') && has(html, 'bi_mod_0') && has(html, 'bi_nm_0') && has(html, 'bi_due_0') && has(html, 'bi_pg_0'), '住宅计划事项缺少模块、事项、完成时间或进展字段');
    ok(has(html, '既有住宅补充记录') && has(html, '幕墙分包招标延后') && has(html, '若再延 10 天') && has(html, '完成幕墙定标') && has(html, '15号楼封顶完成'), '住宅新结构未保留风险、影响、下周承诺或工作进展旧记录');
    ok(!has(html, '四、经营对策'), '第四项经营对策未删除');
    ok(has(html, '三、需要协调事项') && has(html, 'co_who_0') && has(html, '四、待处理事项清单') && has(html, 'ReporterTasks.refreshSources()'), '住宅四段结构缺少协调输入或真实待办模块');
    /* 2026-10-15h：快捷下拉全部撤除；醒目标记改为「空白点击区」（淡红块＝标红、灰粗块＝加粗） */
    ok(!has(html, 'co_quick_res') && !has(html, 'App.coordQuick'), '住宅填报页协调快捷下拉应已撤除');
    ok(!has(html, 'id="bn_pg_0"') && /<textarea\b(?=[^>]*data-rich)(?=[^>]*id="bi_pg_0")/.test(html)
      && /<textarea\b(?=[^>]*data-rich)(?=[^>]*id="co_what_0")/.test(html), '住宅原节点应只读，计划事项及协调内容保留真实富文本绑定');
    ok(has(html, 'data-shared-rich-editor') && has(html, 'data-rich id="bi_mod_0"'), '住宅填报页未挂载共享格式编辑区和字段绑定');
    /* 2026-10-14：填报页右栏并入页头、经营双维自评取消 */
    ok(!has(html, '经营双维自评'), '住宅填报页仍残留经营双维自评');
    ok(!has(html, 'class="rail"'), '住宅填报页仍渲染右栏');
    ok(has(html, 'workgrid onecol'), '住宅填报页未切换单栏');
    ok(has(html, '提交本期直报') && has(html, 'plan-form-actions') && has(html, '本周基准节点 <b>0 项</b>') && has(html, '当月计划事项 <b>1 项</b>'), '住宅填报缺少提交操作或未分配专业的项目快览统计不符');

    await App.view('mine'); html = root.innerHTML;
    ok(!has(nav(html), '项目列表') && has(main(html), '我的工作台'), '已撤销项目列表入口应回落工作台');
    ok(!has(main(html), '节点基线 · 示例住宅一号'), '住宅工作台仍重复内嵌已撤节点基线展示');
    noReporterPageHeading(html, '住宅撤销项目列表入口');
    ok(!has(main(html), 'App.msSet('), '项目资料基线应只读，不能重复编辑工作台的预计完成时间');
    noCameraUi(html, '住宅 PM 已撤项目列表');

    await App.view('history'); ok(root.innerHTML.length > 300, '历史直报渲染为空');
    noReporterPageHeading(root.innerHTML, '住宅历史记录');

    /* 个人中心（住宅）：研判节点偏差 + 下周重点 + 协调 */
    await App.view('center'); html = root.innerHTML;
    noReporterPageHeading(html, '住宅个人概览');
    ok(navLabels(html, ['条线节点', '个人概览', '协调申请'], '子导航'), 'PM 工作台未保留条线节点、个人概览和协调申请');
    ok(has(html, '我的工作台'), '住宅个人中心标题缺失');
    ok(has(html, '工作进展统计'), '住宅个人中心缺少进展统计');
    ok(has(html, '研判节点与偏差（按优先级）'), '住宅个人中心缺少优先级节点表');
    ok(has(html, 'P0 紧急'), '住宅个人中心未按偏差分级出 P0');
    ok(has(html, '幕墙分包进场'), '住宅个人中心未列出我的研判节点');
    ok(!has(main(html), '下周必须完成') && !has(main(html), '我的近期台账') && has(main(html), 'workgrid onecol'), '住宅个人中心未按需求取消右栏并改单栏');
    ok(!has(html, '距 2027-09-30'), '住宅个人中心误显示商业开业倒计时');
    ok(has(html, '待处理事项清单') && has(html, '暂无待处理事项。'), '住宅个人中心应显示统一待办的明确空状态');

    /* 2026-10-14 新增：我的条线（住宅 PM 未设条线 → 项目经理视角看全部节点） */
    await App.view('mline'); html = root.innerHTML;
    noReporterPageHeading(html, '住宅条线节点');
    ok(has(main(html), '我的条线：') && has(main(html), '项目全专业（项目经理视角）') && has(main(html), 'id="reporter-line-project"'), '住宅条线节点应保留正文的本人视角和项目筛选');
    ok(has(html, '已逾期未完成') && has(html, '未来 30 天到期') && has(html, '关键节点（未到期）'), '我的条线缺少三段必盯清单');
    ok(has(html, '我负责的节点') && has(html, 'data-milestone="1"') && !has(html, 'ml_fc_1') && !has(html, 'ml_note_1'), '我的条线应保留节点原文和来源，不重复提供已撤直接编辑入口');
    ok(!has(html, '专业流水线') && !has(html, 'reporter-flow-stages'), '我的条线仍显示已撤销的专业流水线');
    const nodeRows = main(html).slice(main(html).indexOf('我负责的节点'));
    ok(nodeRows.indexOf('主体结构封顶') >= 0 && nodeRows.indexOf('主体结构封顶') < nodeRows.indexOf('竣工备案'), '保留的节点表未按完成时间由近向远排序');
    ok(has(html, '全部单体封顶') && has(html, '开发报建'), '我的条线未显示完成标准与条线');
    ok(!has(html, 'App.mlineSave') && has(html, '完成／延期申报'), '我的条线应沿用完成延期审核，不重新直接保存基准日期');
    ok(has(main(html), 'CompletionReview.openKey('), '条线节点缺少申请完成或查看审核入口');
    ok(has(html, '未设置专业条线'), '我的条线未提示未指定条线');

    /* 2026-10-14 新增：项目主数据（PM 只读） */
    await App.view('master'); html = root.innerHTML;
    noReporterPageHeading(html, '住宅项目档案');
    ok(has(html, '项目总图') && has(html, '规划指标') && has(html, '产品建设标准'), 'PM 项目档案缺少七类资料入口');
    ok(has(html, '只读：由运营管理员统一维护'), 'PM 项目主数据未标注只读');
    ok(has(html, '示例住宅总图'), 'PM 项目档案未显示已保存总图');
    App.reporterArchiveTab('basic'); html = root.innerHTML;
    ok(has(html, '18000') && has(html, '一期'), 'PM 基本资料未保留分期销售数据');
    ok(!has(html, 'App.masterSave'), 'PM 端不应出现主数据保存按钮');
    noCameraUi(html, '住宅 PM 项目档案');
    await App.view('cams'); html = root.innerHTML;
    noCameraUi(html, '住宅 PM 访问已撤销的监控页');
    ok(has(main(html), '我的工作台') && has(main(html), '住宅项目') && has(main(html), '幕墙分包进场'), '住宅 PM 访问已撤销的监控页应回落本人的个人概览');
    ok(navLabels(html, ['工作台', '本期填报', '项目资料', '历史记录']), '撤销监控入口影响了住宅 PM 四项主导航');
    console.log('PM render OK');
  }

  /* 只读核心节点只按明确专业归属，原line或手填报告不代替基准范围。 */
  {
    const assigned = await run('pm', {pmDiscipline: '工程'});
    const core = assigned.root.innerHTML.match(/<div id="baseline-core-summary">([\s\S]*?)<\/section>/)?.[1] || '';
    ok(has(core, '当周住宅基准节点') && !has(core, '竣工备案') && !has(core, '当周商业基准节点') && !has(core, '项目正式开工'), '住宅基准未按同项目且明确专业归属隔离');
  }

  /* ---------- 项目经理端（商业项目·示例商业项目：按条线填报） ---------- */
  {
    const originalTasks = DB.reporter_tasks;
    DB.reporter_tasks = [{id: 'a1111111-1111-4111-8111-111111111111', project_id: 'p3', owner_id: 'u-pm2', owner_name: '示例土建负责人',
      title: '专项会议要求', what: '**实名会议重点**', due: '2020-01-01', status: 'in_progress', progress: '会议推进中', revision: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()}];
    const { App, root } = await run('pm-com');
    let html = root.innerHTML;
    ok(identityRole(html) === '提报人' && DB.profiles[0].role === 'pm', '商业场景账号应使用统一提报人身份和原 pm 角色');
    const formHtml = html;   /* 商业填报页快照（供 DUMP 用） */
    ok(navLabels(html, ['工作台', '本期填报', '项目资料', '历史记录']), '商业 PM 主导航应保留四个整合入口');
    ok(!has(nav(html), '批量导入计划') && !has(main(html), 'App.openAdminPlans'), '商业提报人不能看到管理员代填导入入口');
    noCameraUi(html, '商业 PM 填报页');
    noReporterPageHeading(html, '商业填报');
    ok(has(main(html), '五、附件资料') && has(main(html), 'id="report-attachment-upload"'), '商业填报缺少第五附件上传区');
    ok(has(html, '商业项目'), '商业填报页缺少商业标识');
    /* 2026-10-15：模块固定显示（管理员指定），不再出现模块/项目下拉 */
    ok(has(html, '填报人（固定）') && has(html, '我的模块（固定 · 管理员指定）'), '商业填报页缺少固定人名/模块');
    ok(has(html, '土建工程（东地块）'), '商业填报页未显示管理员指定模块');
    ok(!has(html, 'App.pmLineSet') && !has(html, '切换项目'), '商业填报页仍存在项目/模块下拉（应已固定）');
    ok(has(html, '一、本周核心节点计划'), '商业填报页缺少报告周核心节点计划');
    ok(has(html, 'id="baseline-core-summary"') && !has(html, 'id="bn_list"') && !has(html, 'App.addBizNode()')
      && !has(html, 'id="bn_nm_') && has(html, '当周商业基准节点'), '商业核心节点应只读投影独立基准，不能继续使用月计划或手工节点作为基准');
    ok(has(html, '二、当月计划填报'), '商业填报页缺少当月计划填报表');
    ok(has(html, '景观-西地块定标配合') && has(html, '幕墙材料封样'), '商业填报页未回显已填事项');
    /* 2026-10-15h：快捷下拉（模块/节点/协调对象）已按用户要求全部撤除 */
    ok(!has(html, 'bi_quick_mod') && !has(html, 'bn_quick_pick') && !has(html, 'co_quick_biz')
      && !has(html, 'App.bizQuickMod') && !has(html, 'App.bizNodeQuick'), '商业填报页快捷下拉应已全部撤除');
    ok(has(html, 'data-shared-rich-editor') && has(html, 'data-rich id="bi_mod_0"'), '商业填报页未挂载共享格式编辑区和字段绑定');
    ok(has(html, '东地块地上主体结构封顶'), '商业填报页未回显本月核心节点');
    ok(has(html, 'bi_mod_0') && has(html, 'bi_due_0') && has(html, 'bi_pg_0'), '商业事项表缺少模块/完成时间/当前进展字段');
    ok(has(html, '三、需要协调事项'), '商业填报页缺少需要协调事项');
    /* 2026-10-13：第四部分「个人工作专项汇总」整体取消（汇总在个人中心，移交登记搬去个人中心） */
    ok(!has(html, '四、个人工作专项汇总'), '商业填报页仍残留第四部分（个人工作专项汇总）');
    ok(!has(html, '4-3 工作面移交事项'), '商业填报页仍残留第四部分的移交汇总卡');
    ok(!has(html, '到「个人中心」登记'), '商业填报页仍残留指向个人中心登记的说明');
    ok(!has(html, '招商进展') && !has(html, '开业倒排'), '商业填报页仍残留招商相关模块');
    /* 2026-10-14：商业填报页右栏并入页头 */
    ok(!has(html, 'class="rail"'), '商业填报页仍渲染右栏');
    ok(has(html, 'workgrid onecol'), '商业填报页未切换单栏');
    ok(has(html, '提交本模块直报') || has(html, '重新提交（'), '商业页头未合并提交按钮');
    ok(has(html, '本月到期（含已过期）'), '商业页头未合并快览统计');
    ok(has(html, '开业目标日 <b>2027-09-30</b>') && has(html, '距开业 <b>'), '商业填报页折叠快览缺少开业目标日与倒计时');
    ok(!has(html, '一·补充：你自己认为重要的节点'), '商业页误用住宅版卡片');

    await App.view('mine'); html = root.innerHTML;
    noReporterPageHeading(html, '商业已撤项目列表入口');
    ok(!has(main(html), 'App.msSet('), '商业项目资料基线仍可重复编辑');
    noCameraUi(html, '商业 PM 已撤项目列表入口');
    ok(!has(nav(html), '项目列表') && has(main(html), '我的工作台') && has(main(html), '事项进展状态统计'), '商业旧项目列表入口未回落本人工作台');
    await App.view('form'); html = root.innerHTML;
    ok(has(main(html), '土建工程（东地块）') && has(main(html), 'bi_nm_0'), '商业当前填报入口未保留本人模块与事项');

    await App.view('history'); html = root.innerHTML;
    noReporterPageHeading(html, '商业历史记录');
    ok(has(html, '土建工程（东地块）') && has(html, '成本'), '历史直报未按模块分行展示');
    ok(has(html, '工作面移交'), '历史直报缺少工作面移交列');

    /* 2026-10-14 新增：我的条线按本人专业条线过滤（示例土建负责人 = 工程） */
    await App.view('mline'); html = root.innerHTML;
    noReporterPageHeading(html, '商业条线节点');
    ok(has(main(html), '我的条线：') && has(main(html), 'id="reporter-line-project"') && has(main(html), '工程'), '商业条线应保留正文项目筛选和本人专业范围');
    ok(has(html, '只看本专业的节点'), '商业 PM 我的条线未标注条线口径');
    ok(has(html, '东地块地上主体结构封顶'), '我的条线未列出本专业节点');
    ok(!has(html, '正式开业'), '我的条线混入其它条线（商管运营）的节点');

    /* 个人中心（商业）：倒计时 + 状态统计 + 优先级 + 四块（移交为可登记卡） */
    await App.view('center'); html = root.innerHTML;
    noReporterPageHeading(html, '商业个人概览');
    ok(has(html, '我的工作台') && has(html, '示例土建负责人'), '商业个人中心标题缺失');
    ok(has(html, '距 2027-09-30'), '商业个人中心缺少开业倒计时');
    ok(has(html, '事项进展状态统计'), '商业个人中心缺少状态统计');
    ok(has(html, '待处理事项清单') && has(html, '类别') && has(html, '提出人') && has(html, '事项申报'), '商业个人中心缺少统一待办列和事项申报入口');
    ok(has(html, '2020-01-01') && has(html, '完成／延期申报'), '商业待办应保留原到期时间和逐项申报，不因取消优先级重复表丢失办理入口');
    const pendingWork = main(html).slice(main(html).indexOf('<h3>待处理事项'));
    ok(has(pendingWork, '<b>实名会议重点</b>') && has(pendingWork, '会议推进中') && has(pendingWork, '确认西地块土建工作面移交时间'), '商业待处理事项应显示实名会议与他人需求并保留格式和进展');
    ok(!has(pendingWork, '幕墙材料封样') && !has(pendingWork, '景观-西地块定标配合') && !has(pendingWork, '东地块地上主体结构封顶'), '商业待处理事项不应重复汇总月度计划和基准节点');
    ok(!has(html, '当月到期事项') && !has(html, '月度计划事项') && !has(html, '其他专业需协调'), '商业个人中心右栏仍残留三块只读汇总卡');
    /* 2026-10-14：右栏整体取消（移交登记 / 发起协调 / 近期台账），页面单栏铺满 */
    ok(!has(html, '工作面移交登记') && !has(html, '保存移交登记'), '商业个人中心右栏仍残留移交登记卡');
    ok(!has(html, '<aside') && !has(html, '保存协调') && has(html,'我的事项申请'), '商业个人中心应保留本人申请并撤销旧右栏录入卡');
    ok(!has(html, '我的近期台账'), '商业个人中心右栏仍残留近期台账');
    ok(!has(html, 'bh_what_0'), '商业个人中心右栏仍残留移交登记行');
    ok(!has(html, 'class="rail"'), '商业个人中心仍渲染右栏容器');
    ok(has(html, 'workgrid onecol'), '商业个人中心未切换单栏布局');
    /* 只统计「我」提交的内容：他人模块（示例成本负责人/成本）的事项不应出现 */
    ok(!has(html, '西地块总包清单编制'), '商业个人中心混入了他人提交的事项');
    /* 别人提报的、指向我的需求（协调对象=我的姓名 / 移交接收方=我的模块） */
    ok(has(html, '他人协调我的事项'), '商业个人中心缺少统一待办中的他人协调类别');
    ok(has(html, '确认西地块土建工作面移交时间'), '商业个人中心未显示指向我的协调需求');
    ok(has(html, '西地块成本清单移交'), '商业个人中心未显示移交给我的工作面');
    /* 两类个人待办替代旧领导分区，原记录另由详情读取。 */
    ok(!has(html, '总裁交代 · 本周需关注的工作') && has(html, '会议事项要求'), '商业个人中心应按会议要求分类，不重新引入旧总裁交代分区');
    ok(!has(html, '项目总安排 · 本周工作安排') && has(html, '他人协调我的事项'), '商业个人中心应按他人协调分类，不重新引入旧项目总安排分区');
    await App.view('coordination');
    ok(has(main(root.innerHTML), '我发起的协调事项审核') && has(main(root.innerHTML), '协调申请'), '发起协调及审核应继续在独立协调申请入口办理');
    await App.view('center'); html = root.innerHTML;
    noCameraUi(html, '商业 PM 工作台');
    const centerHtml = html;
    await App.view('cams'); html = root.innerHTML;
    noCameraUi(html, '商业 PM 访问已撤销的监控页');
    ok(has(main(html), '我的工作台') && has(main(html), '示例土建负责人') && has(main(html), '实名会议重点') && !has(main(html), '西地块总包清单编制'), '商业 PM 访问已撤销的监控页应回落本人的个人概览，保留本人关键事项且不混入他人台账');
    ok(navLabels(html, ['工作台', '本期填报', '项目资料', '历史记录']), '撤销监控入口影响了商业 PM 四项主导航');
    await App.openProjectDetail('p3'); await App.detailTab('history'); html = root.innerHTML;
    ok(has(main(html), '幕墙材料封样') && has(main(html), '景观-西地块定标配合') && has(main(html), '示例供应商调整铝型材合同，卡在招采'), '工作台收敛后月度计划正文和进展仍应完整保留在项目历史');
    ok(has(main(html), '<span class="mk-red">屋面临近完成</span>'), '旧手填节点的标红反馈仍应完整保留在原报告历史');
    /* 可选：把商业填报页与个人中心的 HTML 落盘，用浏览器看版式（DUMP=1 node work/render_test.js） */
    if (process.env.DUMP) {
      const wrap = h => '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'
        + '<link rel="stylesheet" href="../styles.css"></head><body style="padding:18px">'
        + '<div id="root">' + h + '</div></body></html>';
      fs.writeFileSync(path.join(__dirname, '_dump_form.html'), wrap(formHtml));
      fs.writeFileSync(path.join(__dirname, '_dump.html'), wrap(centerHtml));
      console.log('DUMPED -> work/_dump_form.html, work/_dump.html');
    }
    if (originalTasks === undefined) delete DB.reporter_tasks; else DB.reporter_tasks = originalTasks;
    console.log('PM 商业 render OK');
  }

  /* 仅负责商业的项目总只显示商业总览，详情不新增填报、主数据或总裁写入能力。 */
  {
    const originalNotes = DB.leader_notes;
    DB.leader_notes = [{id: 'pzo-commercial-existing', project_id: 'p3', period: PERIOD, kind: 'pzo_note', what: '已保存商业项目总安排'}];
    const { App, root } = await run('pzo');
    let html = root.innerHTML;
    ok(identityRole(html) === '项目总', 'pzo 展示身份应保持项目总');
    ok(navLabels(html, ['计划总览', '统计分析', '项目资料']) && !nav(html, '子导航'), '项目总应保留商业总览并提供已授权只读统计导航');
    ok(!has(nav(html), '批量导入计划') && !has(main(html), 'App.openAdminPlans'), '商业项目总不能看到管理员代填导入入口');
    noCameraUi(html, '项目总总览');
    ok(has(main(html), '示例商业项目') && !has(main(html), '示例住宅一号') && !has(main(html), '示例住宅二号'), '商业项目总浏览正文应仅含本人负责的商业项目');
    ok(hasMeetingAssignment(html, true) && !hasOverviewAction(html, 'ceo_brief') && !has(main(html), 'App.saveCeoBriefs') && !has(main(html), 'App.savePzoReview'), '项目总只能在会议安排入口记录本人要求，不能录入评价或总裁交代');
    const beforeDenied = html;
    await App.openProjectDetail('p1');
    ok(root.innerHTML === beforeDenied, '项目总不应从新详情入口打开住宅项目');
    await App.openProjectDetail('p3'); await App.detailTab('review'); html = root.innerHTML;
    ok(has(main(html), 'App.savePzoNotes') && !has(main(html), 'App.saveCeoBriefs') && !has(main(html), 'App.savePzoReview'), '项目总详情应只保留原权限内安排录入');
    ok(!has(nav(html, '项目详情'), '项目资料') && !has(main(html), 'App.fillProject'), '项目总详情不应新增项目资料或填报入口');
    await App.detailTab('data');
    ok(!has(main(root.innerHTML), 'App.masterSave') && !has(main(root.innerHTML), '设计数据'), '项目总强制切换资料页应保持原可见范围');
    await App.view('members');
    ok(!has(main(root.innerHTML), 'App.memberSet') && hasMeetingAssignment(root.innerHTML, true), '项目总越权访问成员页未回落商业计划总览');
    await App.view('cams');
    ok(navLabels(root.innerHTML, ['计划总览', '统计分析', '项目资料']) && hasMeetingAssignment(root.innerHTML, true), '项目总访问已撤销的监控页应保持商业计划总览');
    noCameraUi(root.innerHTML, '项目总访问已撤销的监控页');
    await App.view('projectPlanStats'); html = root.innerHTML;
    ok(has(main(html), '项目计划统计') && !has(main(html), 'App.memberSet') && !has(main(html), 'ReporterTasks.save'), '项目总应可只读查看新增统计，不增加维护入口');
    ok(has(main(html), '示例商业项目') && !has(main(html), '示例住宅一号') && !has(main(html), 'App.lineSaveAll'), '商业项目总的合并统计仍限本人项目且不暴露维护');
    console.log('PZO render OK');
    if (originalNotes === undefined) delete DB.leader_notes; else DB.leader_notes = originalNotes;
  }

  /* 负责住宅的项目总使用同一项目分配范围，不再被固定为商业入口。 */
  {
    const originalNotes = DB.leader_notes;
    DB.leader_notes = [{id: 'pzo-residential-existing', project_id: 'p1', period: PERIOD, kind: 'pzo_note', what: '已保存住宅项目总安排'}];
    const { App, root } = await run('pzo', {pzoResidential: true});
    let html = root.innerHTML;
    ok(identityRole(html) === '项目总' && navLabels(html, ['计划总览', '统计分析', '项目资料']) && !nav(html, '子导航'), '住宅项目总应保留身份、住宅总览及授权只读统计入口');
    ok(!has(nav(html), '批量导入计划') && !has(main(html), 'App.openAdminPlans'), '住宅项目总不能看到管理员代填导入入口');
    ok(has(main(html), 'data-project-type="res"') && has(main(html), '示例住宅一号') && has(main(html), '幕墙样板通过验收') && !has(main(html), '示例住宅二号') && !has(main(html), '示例商业项目'), '住宅项目总只应看到本人负责的住宅项目及本期填报');
    ok(has(html, '筛选项目') && hasMeetingAssignment(html, false) && !hasOverviewAction(html, 'ceo_brief') && !has(main(html), 'App.saveCeoBriefs') && !has(main(html), 'App.savePzoReview'), '住宅项目总应使用住宅筛选且只可维护本人工作安排');
    const beforeDenied = html;
    await App.openProjectDetail('p3');
    ok(root.innerHTML === beforeDenied, '住宅项目总不应打开未负责的商业项目');
    await App.view('presCom'); html = root.innerHTML;
    ok(has(main(html), 'data-project-type="res"') && !has(main(html), '示例商业项目'), '住宅项目总直接访问商业入口应回落本人住宅总览');
    await App.openProjectDetail('p1'); await App.detailTab('review'); html = root.innerHTML;
    ok(has(main(html), 'App.savePzoNotes') && !has(main(html), 'App.saveCeoBriefs') && !has(main(html), 'App.saveCeoReview') && !has(main(html), 'App.savePzoReview') && !has(main(html), 'App.fillProject'), '住宅项目总详情只应保留项目总安排，不增加总裁、评价或填报能力');
    console.log('Residential PZO render OK');
    if (originalNotes === undefined) delete DB.leader_notes; else DB.leader_notes = originalNotes;
  }

  /* 身份改名不授予注册者管理权限，普通首次建档仍只能创建待审核 pm。 */
  {
    const { App, root, inputs, writes } = await run('pm', { profileMissing: true });
    ok(has(root.innerHTML, 'value="提报人（普通账号）" readonly') && has(root.innerHTML, 'App.onboardSubmit'), '普通首次建档应固定提报人身份');
    ok(!has(root.innerHTML, 'App.role(') && !has(root.innerHTML, 'App.obToggle(') && !has(root.innerHTML, 'App.obLine('), '普通首次建档不应允许自选特殊角色、项目或商业授权');
    App.role('ops');
    ok(has(root.innerHTML, 'value="提报人（普通账号）" readonly'), '直接选择特殊身份后建档页应仍固定提报人');
    const nameInput = makeEl('obName'); nameInput.value = '待审核测试提报人'; inputs.set('obName', nameInput);
    await App.onboardSubmit();
    const registration = writes.find(write => write.table === 'profiles' && write.operation === 'insert');
    ok(registration?.row.role === 'pm' && registration.row.status === 'pending' && registration.row.name === '待审核测试提报人', '普通建档提交必须保持 pm + pending');
    ok(registration && Object.keys(registration.row).sort().join(',') === 'name,role,status', '普通建档不应写入自选项目、专业条线、商业模块或审核授权');
    ok(has(root.innerHTML, '等待审核') && !nav(root.innerHTML) && !has(root.innerHTML, 'App.submitReport'), '普通建档后应停留等待审核，不能进入提报或管理导航');
    console.log('Submitter onboarding render OK');
  }

  /* 新详情必须按所选完整周期显示，领导记录不混入本期，权限仍由现有项目范围限制。 */
  {
    const previousDate = new Date(SHANGHAI_TODAY); previousDate.setDate(previousDate.getDate() - 7);
    const previousPeriod = '第' + isoWeek(previousDate) + '周（' + weekRange(previousDate) + '）';
    const originalReports = DB.reports;
    DB.reports = [...originalReports, {
      ...originalReports[0], id: 'r-history', period: previousPeriod,
      change_text: '历史周期正文 **历史加粗**', node_items: [],
      history: [{ at: '2026-01-09T00:00:00Z', by: 'u-pm', data: {
        ...originalReports[0], period: previousPeriod, change_text: '历史版本原文', node_items: []
      } }]
    }];
    DB.leader_reviews = [
      { project_id: 'p1', period: PERIOD, kind: 'ceo', speed: '达标', effect: '良好', note: '本期领导评语', author_name: '总裁' },
      { project_id: 'p1', period: previousPeriod, kind: 'ceo', speed: '领跑', effect: '良好', note: '**历史领导评语**', author_name: '总裁' }
    ];
    DB.leader_notes = [
      { project_id: 'p1', period: PERIOD, kind: 'ceo_brief', what: '本期领导交代', author_name: '总裁' },
      { project_id: 'p1', period: previousPeriod, kind: 'ceo_brief', what: '==历史领导交代==', author_name: '总裁' },
      { project_id: 'p3', period: PERIOD, kind: 'ceo_brief', what: '既有商业总裁交代', author_name: '总裁' }
    ];
    try {
      const { App, root } = await run('pm');
      await App.openProjectDetail('p1');
      let html = root.innerHTML;
      ok(has(main(html), 'data-project-id="p1"') && has(main(html), '幕墙样板通过验收'), 'PM 项目详情未显示当前项目本期正文');
      ok(has(main(html), '<span class="mk-red">幕墙样板通过验收</span>') && has(main(html), '<b>进度可控</b>'), '项目详情丢失住宅正文格式');
      ok(has(main(html), '幕墙分包进场') && has(main(html), '外架拆除冲突'), '只读基准替换总览后，原研判节点及说明仍应完整保留在项目详情');
      const beforeDenied = html;
      await App.openProjectDetail('p3');
      ok(root.innerHTML === beforeDenied, 'PM 新详情入口不应访问成员范围外项目');
      await App.detailPeriod(previousPeriod); html = root.innerHTML;
      ok(has(main(html), '<b>历史加粗</b>') && !has(main(html), '幕墙样板通过验收'), '详情正文未按所选周期隔离');
      ok(has(main(html), "App.fillProject('p1','" + previousPeriod + "')") && has(main(html), '填写该周期'), '历史详情填写入口未传递所选周期');
      await App.detailTab('review'); html = root.innerHTML;
      ok(has(main(html), '<b>历史领导评语</b>') && has(main(html), '<span class="mk-red">历史领导交代</span>'), '历史周期详情缺少对应领导记录或格式');
      ok(!has(main(html), '本期领导评语') && !has(main(html), '本期领导交代'), '历史详情混入本期领导记录');
      ok(!has(main(html), 'App.saveCeoReview') && !has(main(html), 'App.saveCeoBriefs'), 'PM 详情出现领导记录写入入口');
      await App.detailTab('history'); html = root.innerHTML;
      ok(has(main(html), '历史版本原文') && has(main(html), '历史版本 1'), '项目详情未保留版本原文');
      ok(!has(main(html), '幕墙样板通过验收') && !has(main(html), '<b>进度可控</b>'), '历史版本页混入其他周期正文');
      await App.detailTab('data'); html = root.innerHTML;
      ok(has(main(html), '示例住宅总图') && !has(main(html), 'App.masterSave'), 'PM 详情资料未保持项目资料和只读约束');
      await App.fillProject('p1', previousPeriod); html = root.innerHTML;
      ok(has(main(html), 'aria-label="本期填报信息"') && has(html, '<option value="' + previousPeriod + '" selected>'), '从历史详情填写时未保持所选周期');
      ok(has(main(html), '历史周期正文 **历史加粗**') && !has(main(html), '幕墙样板通过验收'), '从历史详情填写时未回填该周期内容');
      ok(has(main(html), '本期已提交') && has(main(html), '重新提交本期直报'), '历史周期已提交状态或更新入口丢失');

      const ops = await run('ops');
      await ops.App.openProjectDetail('p1'); await ops.App.detailTab('review');
      ok(has(main(ops.root.innerHTML), 'App.saveCeoBriefs') && !has(main(ops.root.innerHTML), 'App.saveCeoReview'), '运营本期详情应保留交代并取消评价录入');
      await ops.App.detailPeriod(previousPeriod); html = ops.root.innerHTML;
      ok(has(main(html), '历史领导评语') && !has(main(html), 'App.saveCeoReview') && !has(main(html), 'App.saveCeoBriefs'), '运营历史详情应按周期只读');

      const president = await run('president');
      await president.App.openProjectDetail('p3'); await president.App.detailTab('review'); html = president.root.innerHTML;
      ok(has(main(html), 'App.saveCeoBriefs') && !has(main(html), 'App.savePzoNotes') && !has(main(html), 'App.saveCeoReview') && !has(main(html), 'App.savePzoReview'), '总裁商业详情应仅保留总裁交代写入');
    } finally {
      DB.reports = originalReports;
      delete DB.leader_reviews;
      delete DB.leader_notes;
    }
    console.log('Project detail render OK');
  }

  ok(DB.projects[0].camera_url === '主入口塔吊|https://cam.example.com/p1\n地下室|https://cam.example.com/p1b', '撤销监控展示不应改写存量项目监控数据');
  if (failures.length) { console.error('FAILED ' + failures.length + ':\n- ' + failures.join('\n- ')); process.exit(1); }
  console.log('ALL RENDER TESTS PASSED');
})().catch(e => { console.error('ERROR', e); process.exit(1); });

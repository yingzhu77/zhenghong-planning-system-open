import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {chromium,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

function fixture(){const context={};context.window=context;vm.createContext(context);for(const file of ['planning-windows.js','rich-text.js','monthly-plans.js','monthly-summaries.js','meeting-view.js'])vm.runInContext(readFileSync(new URL('../web/'+file,import.meta.url),'utf8'),context);return context;}
const summary=(extra={})=>({id:'summary-one',project_id:'project-a',month:'2026-10',line:'设计部',owner_id:'anonymous-owner',owner_name:'匿名提报人',items:[{source_id:'one',mod:'设计',name:'月度事项<script>',due:'2026-11-05',progress:'完成说明<iframe>\n保留原文'}],...extra});

test('monthly summaries preserve source text and filter exact month, project, profession and complete merged scopes without mutating reports',()=>{
  const f=fixture(),rows=[summary(),summary({id:'other-month',month:'2026-11'}),summary({id:'other-line',line:'机电设计'}),summary({id:'scope',report_scope_id:'scope-one',scope_project_ids:['project-a','project-b']}),summary({id:'missing-scope',report_scope_id:'scope-two'})],before=JSON.stringify(rows);
  const options={projectIds:['project-a'],projects:[{id:'project-a',name:'匿名项目'}],month:'2026-10',line:'设计部'};
  assert.deepEqual(Array.from(f.MonthlySummaries.select(rows,options),row=>row.id),['summary-one']);
  assert.deepEqual(Array.from(f.MonthlySummaries.select(rows,{...options,projectIds:['project-a','project-b'],scopeId:'scope-one'}),row=>row.id),['scope']);
  const html=f.MonthlySummaries.html(rows,options);assert.match(html,/月度事项&lt;script&gt;/);assert.match(html,/完成说明&lt;iframe&gt;<br>保留原文/);assert.match(html,/data-label="月度完成情况"><div class="monthly-summary-narrative"/);assert.doesNotMatch(html,/<script|<iframe|<input|<textarea|contenteditable|onclick=/);assert.equal(JSON.stringify(rows),before);
});

test('numbered monthly narratives align explicit items and remove workbook gaps without splitting dates, decimals, equipment or parentheses',()=>{
 const f=fixture(),source=' 1、负二层完成50%，2区完成100%（10月15日）\t\t2、B1层施工完成30%\n（3-2、4-1、4-2）      3、屋面主干线完成（4、6、7、9号楼）\n完成标准：施工完成';
 const html=f.MonthlySummaries.narrative(source);assert.equal((html.match(/class="monthly-summary-number"/g)||[]).length,3);for(const label of ['1、','2、','3、'])assert.ok(html.includes('>'+label+'</span>'));
 for(const text of ['50%，2区完成100%（10月15日）','（3-2、4-1、4-2）','（4、6、7、9号楼）'])assert.ok(html.includes(text));assert.match(html,/class="monthly-summary-note">完成标准：施工完成/);assert.doesNotMatch(html,/\t| {3}/);
 const plain='合同1.5万元，计划2026-10-30完成，10.15复核，尺寸1．5米，设备1-KT-5、1-KT-1（4、6、7、9号楼）';assert.doesNotMatch(f.MonthlySummaries.narrative(plain),/monthly-summary-number/);assert.ok(f.MonthlySummaries.narrative(plain).includes(plain));
 assert.match(f.MonthlySummaries.narrative('(1) 第一项； (2) 第二项'),/>\(2\)<\/span>/);assert.equal(source.includes('\t\t'),true);
});

test('actual Edge monthly summary gives narrative columns more space and aligns wrapped numbered items at desktop and mobile sizes',async t=>{
 const f=fixture(),name='1、设备房管线施工完成50%，二区完成100%（10月15日）         2、地下室通风区域施工完成30%\n（3-2、4-1、4-2）       3、首层公区施工完成（10月15日）       4、水电井施工完成20%（水电井10月10号前移交）\n5、风机及隔油设备安装（28/12台）        6、屋面主管线施工完成（4、6、7、9号楼）\n完成标准：施工完成',progress='1、设备房完成20%，二区完成100%   2、完成\n3、完成       4、管井施工及楼样板\n5、设备到货待就位，隔油设备已就位\n6、6-9号楼安装施工';
 const rows=[summary({items:[{source_id:'numbered-source',mod:'东区',name,due:'2026-10-30',progress},{source_id:'plain-source',mod:'西区',name:'供配电： 1、区域配电安装完成；     2、主干线施工完成。',due:'2026-10-20',progress:'1、区域桥架已完成      2、余项待复核'}]})],before=JSON.stringify(rows);
 const html=f.MonthlySummaries.html(rows,{projectIds:['project-a'],projects:[{id:'project-a',name:'匿名商业项目'}],month:'2026-10',line:'设计部',projection:true}),css=readFileSync(new URL('../web/meeting-mode.css',import.meta.url),'utf8');
 const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<!doctype html><html lang="zh-CN"><style>'+css+'</style><body class="meeting-display"><main><section class="meeting-section"><h2>本月计划完成情况（月度汇总）</h2>'+html+'</section></main></body></html>');
 const table=page.locator('.monthly-summary-table'),row=table.locator('tbody tr').first(),artifacts=path.resolve('.local/admin-batch-withdrawal-20261102');await mkdir(artifacts,{recursive:true});
 for(const width of [1920,1440,390]){
  await page.setViewportSize({width,height:width===390?844:1080});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  const body=row.locator('td[data-label="事项"]'),numbers=body.locator('.monthly-summary-number');await expect(numbers).toHaveText(['1、','2、','3、','4、','5、','6、']);
  const positions=await numbers.evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().left));assert.ok(Math.max(...positions)-Math.min(...positions)<1);
  assert.equal((await body.innerText()).replace(/\s/g,''),name.replace(/\s/g,''));assert.equal((await row.locator('td[data-label="月度完成情况"]').innerText()).replace(/\s/g,''),progress.replace(/\s/g,''));
  const dimensions=await table.locator('th').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width));
  if(width>700){assert.ok(dimensions[1]+dimensions[3]>dimensions[0]+dimensions[2]);assert.equal(await row.locator('td').evaluateAll(nodes=>nodes.every(node=>getComputedStyle(node).textAlign==='left'&&getComputedStyle(node).verticalAlign==='top')),true);}
  await page.screenshot({path:path.join(artifacts,'summary-readable-'+width+'.png'),fullPage:true});
 }
 await page.setViewportSize({width:1920,height:1080});const initial=await table.locator('th').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width));
 const longer='样板区外立面和屋面采光区域施工；分项加工已完成，部分区域正在安装支撑，剩余区域在防水核验后安排安装，后续材料按原排期进场；已完成的节点保持原记录，现场安装随工作面移交继续推进。';
 const adaptive=[summary({items:[{source_id:'adaptive-one',mod:'样板区外立面及采光区域施工（施工单位甲）',name:'施工\n完成标准：完成结构安装',due:'2026-10-30',progress:longer},{source_id:'adaptive-two',mod:'材料封样',name:'封样\n完成标准：按原标准',due:'2026-10-20',progress:longer+longer}]})];
 await page.locator('.meeting-section').evaluate((node,html)=>node.innerHTML=html,f.MonthlySummaries.html(adaptive,{projectIds:['project-a'],month:'2026-10',projection:true}));
 const changed=await table.locator('th').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width));assert.ok(changed[3]>initial[3],'long completion narratives receive more width');assert.ok(changed[1]<initial[1],'short work descriptions release their former width');assert.ok(changed[1]>changed[2],'the short description still has room to read its completion standard');
 await page.screenshot({path:path.join(artifacts,'summary-content-adaptive-1920.png'),fullPage:true});
 assert.equal(JSON.stringify(rows),before);assert.deepEqual(errors,[]);
});

test('projection shows monthly completion as an independent block and does not turn it into a weekly report or completed approval',()=>{
  const f=fixture(),model={target:f.MeetingView.target({type:'com',projectIds:['project-a'],period:'2026-10-26',line:'设计部',section:'all'}),projects:[{id:'project-a',name:'匿名商业'}],reports:[],plans:[],nodes:[],drawings:[],attachments:[],monthlySummaries:[summary(),summary({id:'other-line',line:'机电设计',items:[{name:'其他专业内容'}]})],readAt:'10:00'},before=JSON.stringify(model);
  const html=f.MeetingView.html(model);assert.match(html,/本月计划完成情况（月度汇总）/);assert.match(html,/data-projection-section="summaries"/);assert.match(html,/月度事项&lt;script&gt;/);assert.doesNotMatch(html,/其他专业内容|读取于|基准节点|不计作周报提交/);assert.equal(model.reports.length,0);assert.equal(JSON.stringify(model),before);
  model.target.section='plans';assert.doesNotMatch(f.MeetingView.html(model),/data-projection-section="summaries"/);
  model.target.section='summaries';model.monthlySummaries=[];model.monthlySummaryError='连接失败<detail>';const failed=f.MeetingView.html(model);assert.match(failed,/月度汇总读取失败：连接失败&lt;detail&gt;/);assert.doesNotMatch(failed,/月度事项/);
});

test('commercial projection displays confirmed current-month plans without a weekly report and keeps profession/history boundaries',()=>{
 const f=fixture(),period=f.PlanningWindows.todayShanghai(),month=period.slice(0,7),plan={id:'confirmed-commercial',project_id:'project-a',line:'机电工程',owner_id:'anonymous-owner',owner_name:'匿名提报人',plan_month:month+'-01',items:[{source_id:'confirmed-source',mod:'设备',name:'未报周进展的商业确认事项',due:month+'-28'}],rich_text:{v:1,fields:{'items.0.name':{ops:[{insert:'未报周进展的商业确认事项',attributes:{bold:true}}]}}}};
 const model={target:f.MeetingView.target({type:'com',projectIds:['project-a'],period,line:'机电工程',section:'plans'}),projects:[{id:'project-a',name:'匿名商业'}],reports:[],plans:[plan,{...plan,id:'other-profession',line:'招采',items:[{name:'另一专业不应展示'}]}],nodes:[],drawings:[],attachments:[],readAt:'10:00'},before=JSON.stringify(plan);
 const html=f.MeetingView.html(model);assert.match(html,/<strong>未报周进展的商业确认事项<\/strong>/);assert.match(html,/本周尚未提交/);assert.equal(model.reports.length,0);assert.doesNotMatch(html,/另一专业不应展示|读取于|基准节点/);
 const date=new Date(period+'T00:00:00Z');date.setUTCMonth(date.getUTCMonth()-1);model.target.period=date.toISOString().slice(0,10);assert.doesNotMatch(f.MeetingView.html(model),/未报周进展的商业确认事项/);assert.equal(JSON.stringify(plan),before);
});

test('monthly meeting selects adjacent real months and reads complete confirmed plans with the existing project, profession and merged-scope boundaries',async()=>{
 const f=fixture(),selection={type:'com',projectIds:['project-a'],period:'2026-11-02',line:'设计部',section:'monthly'};
 assert.equal(f.MeetingView.target(selection).summaryMonth,'2026-10');assert.equal(f.MeetingView.target({...selection,period:'2027-01-04'}).summaryMonth,'2026-12');
 assert.throws(()=>f.MeetingView.target({...selection,summaryMonth:'2026-13'}),/选择无效/);
 const plan={id:'next-plan',project_id:'project-a',plan_month:'2026-11-01',line:'设计部',owner_id:'anonymous-owner',owner_name:'匿名提报人',items:[{source_id:'next-source',mod:'材料',name:'完整的十一月已确认计划',due:'2026-11-28'}],rich_text:{v:1,fields:{'items.0.name':{ops:[{insert:'完整的十一月已确认计划',attributes:{bold:true}}]}}}};
 const plans=[plan,{...plan}, {...plan,id:'other-line',line:'机电工程',items:[{name:'不显示其他专业'}]}, {...plan,id:'future',plan_month:'2026-12-01',items:[{name:'不显示十二月计划'}]}, {...plan,id:'partial-scope',report_scope_id:'merged-scope',scope_project_ids:['project-a','project-b'],items:[{name:'不显示部分授权范围'}]}],requests=[];
 f.fetch=async(url,options)=>{
  const query=options.body?JSON.parse(options.body):null;requests.push({url,query});let data=[];
  if(url==='/api/auth/session')data={session:{user:{id:'anonymous-admin'}}};
  if(query?.table==='profiles')data=[{role:'ops',status:'approved'}];
  if(query?.table==='projects')data=[{id:'project-a',name:'匿名商业',project_type:'com'}];
  if(query?.table==='reports')data=[{id:'existing-week',project_id:'project-a',period:'2026-11-02',submitted_at:'2026-11-03T02:00:00Z',line:'设计部',author_id:'anonymous-owner',biz:{monthly_plan_id:'next-plan',items:[{name:'周报只含部分事项'}]}}];
  if(url==='/api/monthly-plans/list')data=plans;
  if(url.startsWith('/api/monthly-summaries?'))data=[summary({month:new URL(url,'https://anonymous.test').searchParams.get('month')})];
  return {ok:true,json:async()=>({data})};
 };
 const model=await f.MeetingView.read('anonymous-admin',selection),before=JSON.stringify(model),html=f.MeetingView.html(model);
 assert.ok(requests.some(request=>request.url==='/api/monthly-summaries?month=2026-10'));assert.ok(requests.every(request=>!request.query?.operation || request.query.operation==='select'));
 assert.match(html,/2026年10月工作总结/);assert.match(html,/2026年11月工作计划/);assert.match(html,/<strong>完整的十一月已确认计划<\/strong>/);
 assert.equal((html.match(/<strong>完整的十一月已确认计划<\/strong>/g)||[]).length,1);assert.doesNotMatch(html,/不显示其他专业|不显示十二月计划|不显示部分授权范围|周报只含部分事项|读取于|基准节点/);assert.equal(JSON.stringify(model),before);
 const scoped={...plan,id:'scoped',report_scope_id:'merged-scope',scope_project_ids:['project-a','project-b'],items:[{project_id:'project-b',mod:'一期',name:'子项目乙的已确认事项',due:'2026-11-28'}]};const merged=f.MeetingView.html({...model,target:{...model.target,projectIds:['project-a','project-b']},projects:[...model.projects,{id:'project-b',name:'匿名二期'}],plans:[scoped]});assert.match(merged,/<caption>匿名二期<small>匿名提报人 · 设计部 · 已确认<\/small>/);assert.match(merged,/子项目乙的已确认事项/);
 const historical=f.MeetingView.html({...model,target:f.MeetingView.target({...selection,period:'2026-10-26',section:'all'}),reports:[]});assert.doesNotMatch(historical,/完整的十一月已确认计划/);
 await f.MeetingView.read('anonymous-admin',{...selection,summaryMonth:'2026-09'});assert.ok(requests.some(request=>request.url==='/api/monthly-summaries?month=2026-09'));
});

test('attention notices use unresolved source evidence and valid overdue dates without changing feedback or asserting completion',()=>{
 const f=fixture(),options={referenceDate:'2026-11-01'};
 for(const progress of ['无风险，未延期，已完成','没有延期；阻碍已解决；风险已经消除','卡点已全部解决，已完成100%','已排除风险，未发生延误'])assert.deepEqual(Array.from(f.MonthlySummaries.attention({progress,due:'2026-10-20'},options)),[],progress);
 for(const progress of ['材料未到位','无风险但设备尚未完成','风险已解决，但安装仍然滞后','完成50%','已完成50%']){
  const item={progress,due:'2026-10-20'},before=JSON.stringify(item),reasons=Array.from(f.MonthlySummaries.attention(item,options));assert.ok(reasons.length,progress);assert.match(reasons.join('；'),/未到位|未完成|滞后|计划完成日/);assert.equal(JSON.stringify(item),before);
 }
 assert.equal(f.MonthlySummaries.attention({progress:'完成50%',due:'2026-12-20'},options).length,0);assert.equal(f.MonthlySummaries.attention({progress:'完成50%',due:'2026-02-30'},options).length,0);assert.equal(f.MonthlySummaries.attention({progress:'',due:'2026-10-20'},options).length,0);
 assert.equal(f.MonthlySummaries.attention({blocker:'现场卡点已全部解决。'},options).length,0);assert.equal(f.MonthlySummaries.attention({blocker:'无风险但材料未到位'},options).length,1);
 assert.match(f.MonthlySummaries.attentionHtml({progress:'延期<detail>'},options),/延期&lt;detail&gt;/);assert.doesNotMatch(f.MonthlySummaries.attentionHtml({progress:'延期'},options),/审核|审批|已完成/);
 assert.match(f.MonthlySummaries.attentionHtml({progress:'延期<detail>'},options),/title="依据：延期&lt;detail&gt;"/);assert.match(f.MonthlySummaries.attentionHtml({progress:'完成50%',due:'2026-10-20'},options),/计划日已过/);
});

test('actual Edge monthly meeting keeps both months visible, fits dates and shares width according to content, then stacks on narrow screens',async t=>{
 const f=fixture(),module='山丘草帽钢结构、贝壳采光顶立面钢结构及玻璃盒子钢结构（施工单位甲）',plans=[{id:'plan',project_id:'project-a',plan_month:'2026-11-01',line:'设计部',owner_name:'匿名提报人',items:[{mod:module,name:'钢结构施工',due:'2026-11-30'},{mod:'材料封样',name:'完成材料封样',due:'2026-11-20'}]}];
 const model={target:f.MeetingView.target({type:'com',projectIds:['project-a'],period:'2026-11-02',line:'设计部',section:'monthly'}),projects:[{id:'project-a',name:'匿名商业'}],reports:[],plans,nodes:[],drawings:[],attachments:[],monthlySummaries:[summary({items:[{source_id:'one',mod:'东区',name:'设备安装及调试\n完成标准：完成安装验收',due:'2026-10-30',progress:'1、材料未到位，安装完成50%；2、设备等待移交'},{source_id:'two',mod:'西区',name:'钢结构施工',due:'2026-10-20',progress:'没有延期，风险已解决，已完成'}]})]},before=JSON.stringify(model),css=readFileSync(new URL('../web/meeting-mode.css',import.meta.url),'utf8');
 const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.setContent('<!doctype html><html lang="zh-CN"><style>'+css+'</style><body class="meeting-display"><main>'+f.MeetingView.html(model)+'</main></body></html>');
 const artifacts=path.resolve('.local/admin-ui-20261105');await mkdir(artifacts,{recursive:true});
 for(const width of [1920,1440,1200,900,390]){
  await page.setViewportSize({width,height:width===390?844:1080});const panes=await page.locator('.meeting-month-grid>.meeting-section').evaluateAll(nodes=>nodes.map(node=>({x:node.offsetLeft,y:node.offsetTop,width:node.getBoundingClientRect().width})));
  if(width>=1200){assert.equal(panes[0].y,panes[1].y);assert.ok(panes[1].x>panes[0].x);}else assert.ok(panes[1].y>panes[0].y);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  if(width>700){assert.equal(await page.locator('td[data-label="完成时间"]').evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth+1)),true,'date text fits at '+width);}
  await page.screenshot({path:path.join(artifacts,'monthly-meeting-'+width+'.png'),fullPage:true});
 }
 await expect(page.locator('.meeting-attention')).toHaveCount(1);await expect(page.locator('[data-projection-section="monthly-plans"]')).toContainText(module);assert.equal(JSON.stringify(model),before);
 await page.setViewportSize({width:1440,height:1080});const table=page.locator('[data-projection-section="monthly-plans"] table'),dimensions=await table.locator('th').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width));assert.ok(dimensions[0]>dimensions[1],'a long module gets more room than its short item');assert.ok(dimensions[3]<dimensions[0],'empty progress releases room to source content');
 await page.locator('body').evaluate(node=>node.style.setProperty('--meeting-font','30px'));assert.equal(await page.locator('td[data-label="完成时间"]').evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth+1)),true,'larger projected text still fits dates');assert.deepEqual(errors,[]);
 const base=[{mod:module,name:'施工',due:'2026-11-30',progress:''}],placeholder=[{...base[0],progress:'本周未提交'}];assert.deepEqual(Array.from(f.MonthlySummaries.columnWidths(base)),Array.from(f.MonthlySummaries.columnWidths(placeholder)));assert.equal(f.MonthlySummaries.columnWidths(base,{sequence:true,source:true}).length,6);
});

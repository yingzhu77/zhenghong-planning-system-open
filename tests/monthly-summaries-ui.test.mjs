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
  const html=f.MeetingView.html(model);assert.match(html,/本月计划完成情况（月度汇总）/);assert.match(html,/data-projection-section="summaries"/);assert.match(html,/月度事项&lt;script&gt;/);assert.doesNotMatch(html,/其他专业内容/);assert.match(html,/0 份所选周期已提交报告/);assert.match(html,/不计作周报提交，也不代表完成审核通过/);assert.equal(JSON.stringify(model),before);
  model.target.section='plans';assert.doesNotMatch(f.MeetingView.html(model),/data-projection-section="summaries"/);
  model.target.section='summaries';model.monthlySummaries=[];model.monthlySummaryError='连接失败<detail>';const failed=f.MeetingView.html(model);assert.match(failed,/月度汇总读取失败：连接失败&lt;detail&gt;/);assert.doesNotMatch(failed,/月度事项/);
});

test('commercial projection displays confirmed current-month plans without a weekly report and keeps profession/history boundaries',()=>{
 const f=fixture(),period=f.PlanningWindows.todayShanghai(),month=period.slice(0,7),plan={id:'confirmed-commercial',project_id:'project-a',line:'机电工程',owner_id:'anonymous-owner',owner_name:'匿名提报人',plan_month:month+'-01',items:[{source_id:'confirmed-source',mod:'设备',name:'未报周进展的商业确认事项',due:month+'-28'}],rich_text:{v:1,fields:{'items.0.name':{ops:[{insert:'未报周进展的商业确认事项',attributes:{bold:true}}]}}}};
 const model={target:f.MeetingView.target({type:'com',projectIds:['project-a'],period,line:'机电工程',section:'plans'}),projects:[{id:'project-a',name:'匿名商业'}],reports:[],plans:[plan,{...plan,id:'other-profession',line:'招采',items:[{name:'另一专业不应展示'}]}],nodes:[],drawings:[],attachments:[],readAt:'10:00'},before=JSON.stringify(plan);
 const html=f.MeetingView.html(model);assert.match(html,/<strong>未报周进展的商业确认事项<\/strong>/);assert.match(html,/本周尚未提交/);assert.match(html,/0 份所选周期已提交报告/);assert.doesNotMatch(html,/另一专业不应展示/);
 const date=new Date(period+'T00:00:00Z');date.setUTCMonth(date.getUTCMonth()-1);model.target.period=date.toISOString().slice(0,10);assert.doesNotMatch(f.MeetingView.html(model),/未报周进展的商业确认事项/);assert.equal(JSON.stringify(plan),before);
});

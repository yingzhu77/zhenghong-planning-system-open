import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const appSource=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
const planningSource=await readFile(new URL('../web/planning-windows.js',import.meta.url),'utf8');
function harness(role='ops'){
 const exports=[],context={console,setTimeout:()=>0,clearTimeout(){},addEventListener(){},removeEventListener(){},
  document:{getElementById:()=>({innerHTML:''}),querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},removeEventListener(){}},
  WorkBuddyCloud:{createWorkBuddyCloud:()=>({auth:{},database:{}})}};
 context.window=context;context.__exports=exports;vm.createContext(context);vm.runInContext(planningSource,context);
 const boundary=appSource.indexOf('  (async function boot() {');assert.ok(boundary>0);
 vm.runInContext(appSource.slice(0,boundary)+'\nwindow.__admin={S,App,dataState,dayDiff,lightOf,deviationStatus,devText,planningNavItems,planningGroups,viewNodes};\nexportTable=function(filename,headers,rows){window.__exports.push({filename,headers,rows});};\n})();',context);
 const api=context.__admin,S=api.S;S.uid='anonymous-admin';S.session={};S.profile={user_id:S.uid,role,status:'approved'};
 S.projects=[{id:'res-one',name:'匿名住宅一期',display_group:'匿名住宅组',project_type:'res'},
  {id:'res-two',name:'匿名住宅二期',display_group:'匿名住宅组',project_type:'res'},
  {id:'com-one',name:'匿名商业',project_type:'com'}];
 S.pms=[];S.milestones=[];S.versions=[];S.ptype='res';S.view='nodes';S.filters={project:'',status:''};
 return {api,S,exports,dataState:api.dataState};
}
const plain=value=>JSON.parse(JSON.stringify(value));

test('missing or invalid node dates stay unknown and a small positive deviation is explicit',()=>{
 const {api}=harness();
 for(const [forecast,plan] of [['','2026-10-22'],['2026-10-22',''],['2026-02-30','2026-02-20'],['not-a-date','2026-10-22']]){
  assert.equal(api.dayDiff(forecast,plan),null);
  assert.equal(api.lightOf(api.dayDiff(forecast,plan)),'gray');
  assert.equal(api.deviationStatus(api.dayDiff(forecast,plan),false),'日期不足');
  assert.equal(api.devText(api.dayDiff(forecast,plan)),'日期不足');
 }
 for(const days of [1,2,3,4]){assert.equal(api.lightOf(days),'yellow');assert.equal(api.deviationStatus(days,false),'轻微偏差');}
 assert.equal(api.dayDiff('2026-10-25','2026-10-22'),3);
 assert.equal(api.dayDiff('2026-10-22T10:00:00Z','2026-10-22'),0);
 assert.equal(api.deviationStatus(5,false),'关注');assert.equal(api.deviationStatus(15,false),'异常');
 assert.equal(api.deviationStatus(null,true),'已完成');assert.equal(api.deviationStatus(-1,false),'正常');
});

test('node detail and export share date-insufficient, slight-deviation and completion labels and filters',()=>{
 const {api,S,exports,dataState}=harness();
 S.milestones=[
  {id:1,project_id:'res-one',name:'缺预计日期节点',plan_date:'2026-10-21',forecast_date:'',is_key:true},
  {id:2,project_id:'res-one',name:'缺计划日期节点',plan_date:'',forecast_date:'2026-10-25',is_key:true},
  {id:3,project_id:'res-one',name:'轻微偏差节点',plan_date:'2026-10-22',forecast_date:'2026-10-25',is_key:true},
  {id:4,project_id:'res-one',name:'按计划节点',plan_date:'2026-10-22',forecast_date:'2026-10-22',is_key:true},
  {id:5,project_id:'res-one',name:'历史完成节点',plan_date:'2026-10-21',forecast_date:'',done:true,is_key:true},
  {id:6,project_id:'res-two',name:'非关键二期节点',plan_date:'2026-10-22',forecast_date:'2026-11-10',is_key:false},
  {id:7,project_id:'com-one',name:'商业基准不能混入住宅',plan_date:'2026-10-22',forecast_date:'2026-11-10',is_key:true}
 ];
 // Authoritative API projection, independent of the raw milestone done field.
 S.nodeStatistics=[
  {source_key:'milestone:res-one:1',title:'缺预计日期节点',plan_due:'2026-10-21',forecast_due:'',completed:false,deviation:null,completion_basis:'none'},
  {source_key:'milestone:res-one:2',title:'缺计划日期节点',plan_due:'',forecast_due:'2026-10-25',completed:false,deviation:null,completion_basis:'none'},
  {source_key:'milestone:res-one:3',title:'轻微偏差节点',plan_due:'2026-10-22',forecast_due:'2026-10-25',completed:false,deviation:3,completion_basis:'none'},
  {source_key:'milestone:res-one:4',title:'按计划节点',plan_due:'2026-10-22',forecast_due:'2026-10-22',completed:false,deviation:0,completion_basis:'none'},
  {source_key:'milestone:res-one:5',title:'历史完成节点',plan_due:'2026-10-21',forecast_due:'',completed:true,deviation:null,completion_basis:'legacy'},
  {source_key:'milestone:res-two:6',title:'非关键二期节点',plan_due:'2026-10-22',forecast_due:'2026-11-10',completed:false,deviation:19,completion_basis:'none'}
 ];
 dataState.nodeStatistics={ready:true,scope:'res',error:null};
 let html=api.viewNodes();api.App.exportNodes();
 const rows=plain(exports[0].rows),htmlRows=html.match(/<tr>[\s\S]*?<\/tr>/g);
 const rowFor=name=>htmlRows.find(row=>row.includes(name));
 for(const name of ['缺预计日期节点','缺计划日期节点']){
  assert.match(rowFor(name),/日期不足/);assert.match(rowFor(name),/d-gray/);assert.doesNotMatch(rowFor(name),/按计划|正常/);
  const row=rows.find(row=>row[1]===name);assert.equal(row[8],'日期不足');assert.equal(row[9],'日期不足');
 }
 assert.match(rowFor('轻微偏差节点'),/轻微偏差/);assert.match(rowFor('轻微偏差节点'),/d-yellow/);
 assert.equal(rows.find(row=>row[1]==='轻微偏差节点')[8],'+3 天');assert.equal(rows.find(row=>row[1]==='轻微偏差节点')[9],'轻微偏差');
 assert.equal(rows.find(row=>row[1]==='历史完成节点')[9],'已完成');assert.doesNotMatch(rowFor('历史完成节点'),/日期不足/);
 assert.doesNotMatch(html,/商业基准不能混入住宅/);assert.ok(!rows.some(row=>row[1]==='商业基准不能混入住宅'));
 S.filters={project:'res-one',status:'key'};html=api.viewNodes();api.App.exportNodes();
 assert.doesNotMatch(html,/非关键二期节点/);assert.ok(!plain(exports[1].rows).some(row=>row[1]==='非关键二期节点'));
 assert.equal(exports[1].rows.length,5);
});

test('operations navigation follows the five confirmed groups and keeps employee statistics apart from maintenance',()=>{
 const {api}=harness(),items=plain(api.planningNavItems()),groups=plain(api.planningGroups(items));
 assert.deepEqual(groups.map(group=>group.label),['计划总览','统计分析','事项管理','项目资料','系统设置']);
 assert.deepEqual(items.filter(item=>item.group==='analysis').map(item=>item.k),['projectPlanStats','completionStats']);
 assert.deepEqual(items.filter(item=>item.group==='collaboration').map(item=>item.k),['coord','completion','meetings']);
 assert.deepEqual(items.filter(item=>item.group==='projects').map(item=>item.k),['master','library']);
 assert.deepEqual(items.filter(item=>item.group==='settings').map(item=>item.k),['lineAdm','members']);
 assert.ok(!items.some(item=>['board','boardCom','presPzo','dual','nodes','nodesCom'].includes(item.k)));
});

test('president and project chief gain read-only analysis while existing maintenance stays limited',()=>{
 for(const role of ['president','pzo']){
  const {api,S,exports,dataState}=harness(role);
  if(role==='pzo'){S.profile.project_id='res-one';S.pms=[{user_id:S.uid,project_id:'res-one'}];}
  const items=plain(api.planningNavItems()),keys=items.map(item=>item.k);
  assert.deepEqual(items.filter(item=>item.group==='analysis').map(item=>item.k),['projectPlanStats']);
  assert.ok(!keys.some(key=>['nodes','nodesCom'].includes(key)));
  assert.ok(!items.some(item=>['settings','collaboration'].includes(item.group)));
  assert.ok(!keys.some(key=>['completionStats','meetings','members','lineAdm','completion','master'].includes(key)));
  S.milestones=[{id:1,project_id:'res-one',name:'授权住宅节点',plan_date:'2026-10-22',forecast_date:''},
   {id:2,project_id:'res-two',name:'未授权住宅节点',plan_date:'2026-10-22',forecast_date:''}];
  S.nodeStatistics=[{source_key:'milestone:res-one:1',title:'授权住宅节点',plan_due:'2026-10-22',forecast_due:'',completed:false,deviation:null,completion_basis:'none'}];
  if(role==='president')S.nodeStatistics.push({source_key:'milestone:res-two:2',title:'未授权住宅节点',plan_due:'2026-10-22',forecast_due:'',completed:false,deviation:null,completion_basis:'none'});
  dataState.nodeStatistics={ready:true,scope:'res',error:null};
  const html=api.viewNodes();api.App.exportNodes();
  assert.match(html,/授权住宅节点/);assert.doesNotMatch(html,/App\.lineSaveAll|App\.memberSet|App\.msSet|ZHAdminArchive\.saveFields/);
  if(role==='pzo'){assert.doesNotMatch(html,/未授权住宅节点/);assert.ok(!plain(exports[0].rows).some(row=>row[1]==='未授权住宅节点'));}
 }
});

test('reporter navigation preserves the existing personal work, reporting, files and history routes',()=>{
 const {api}=harness('pm'),items=plain(api.planningNavItems());
 assert.deepEqual(plain(api.planningGroups(items)).map(group=>group.label),['工作台','本期填报','项目资料','历史记录']);
 assert.deepEqual(items.map(item=>item.k),['center','mline','coordination','form','master','history','library']);
 assert.ok(!items.some(item=>['projectPlanStats','nodes','nodesCom','completionStats','members','lineAdm'].includes(item.k)));
});

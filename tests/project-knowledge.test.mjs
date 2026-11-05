import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script=fs.readFileSync(new URL('../web/project-knowledge.js',import.meta.url),'utf8');
function fixture(){const document={getElementById:()=>null,querySelectorAll:()=>[]};const window={document};vm.runInNewContext(script,{window,document});return window.ZHProjectKnowledge;}
function catalog(patch={}){return {version:1,source:{name:'匿名建筑方案.pdf',url:'/api/files/drawings/p1/source.pdf'},scope:'一期',edition:'测试版',kind:'住宅方案',summary:'匿名说明',plan_page:1,pages:[{page:1,text:'总建筑面积 1000 平方米'}],facts:[{label:'总建筑面积',value:'1000',unit:'㎡',page:1,group:'建筑规模',highlight:true,audiences:['成本与招采']}],issues:[],...patch};}
function context(patch={}){return {identity:'user-a|1',pid:'p1',projects:[{id:'p1',name:'匿名项目'}],fields:{scheme_catalog:catalog()},...patch};}

test('knowledge hub only indexes projects supplied by the authorized scope',()=>{
 const api=fixture(),html=api.render(context({catalogs:[{project_id:'p1',name:'有权项目',catalog:catalog()},{project_id:'p2',name:'不得泄露的项目',catalog:catalog({summary:'不得泄露的说明'})}]}));
 assert.match(html,/有权项目/);assert.doesNotMatch(html,/不得泄露|drawings\/p2/);
});
test('facts distinguish units and original scope, link to exact authenticated PDF page',()=>{
 const html=fixture().render(context());assert.match(html,/1000<small>㎡/);assert.match(html,/一期/);assert.match(html,/\/api\/files\/drawings\/p1\/source\.pdf#page=1/);
 assert.match(html,/项目速览/);assert.match(html,/指标与专题/);assert.match(html,/原文检索/);assert.match(html,/版本与待核对/);
});
test('project source links cannot cross project boundaries, inject schemes or contain traversal',()=>{
 const api=fixture();
 for(const url of ['https://example.invalid/source.pdf','javascript:alert(1)','/api/files/drawings/p2/source.pdf','/api/files/drawings/p1/../secret.pdf','/api/files/drawings/p1/source.pdf?x=1'])assert.equal(api.safeFile(url,'p1'),'');
 assert.equal(api.safeFile('/api/files/drawings/p1/source.pdf','p1'),'/api/files/drawings/p1/source.pdf');
 const html=api.render(context({fields:{scheme_catalog:catalog({source:{name:'unsafe',url:'javascript:alert(1)'}})}}));assert.doesNotMatch(html,/href="javascript:/);
});
test('malicious source names, extracted values and notes render as text',()=>{
 const bad='<img src=x onerror=alert(1)>';
 const html=fixture().render(context({fields:{scheme_catalog:catalog({source:{name:bad,url:'/api/files/drawings/p1/source.pdf'},summary:bad,facts:[{label:bad,value:bad,unit:bad,page:1,group:bad,highlight:true}]})}}));
 assert.doesNotMatch(html,/<img src=x|onerror="/);assert.match(html,/&lt;img/);
});
test('search accepts common area aliases and multiple terms without treating unknown data as zero',()=>{
 const api=fixture();assert.equal(api.searchMatches('总建筑面积 5000 ㎡','总建面'),true);assert.equal(api.searchMatches('计容建筑面积 3000 ㎡','计容建面 3000'),true);assert.equal(api.searchMatches('地下机动车停车位 100','地下 100'),true);assert.equal(api.searchMatches('建筑面积 500','停车位'),false);
 const html=api.render(context({fields:{scheme_catalog:catalog({facts:[{label:'未知指标',value:null,unit:'㎡',page:1,group:'建筑规模',highlight:true}]})}}));assert.match(html,/未载明/);
});
test('unregistered sources, invalid page numbers and missing versions do not produce misleading citations',()=>{
 const html=fixture().render(context({fields:{scheme_catalog:catalog({facts:[{label:'面积',value:5,page:99,group:'建筑规模',highlight:true}]})}}));assert.doesNotMatch(html,/#page=99/);assert.match(html,/来源待登记/);
 assert.equal(fixture().valid({version:1,facts:[],pages:[]}),false);
});

test('full-text filters use cited pages and do not count hidden fact results',()=>{
 const api=fixture(),ctx=context({fields:{scheme_catalog:catalog({pages:[{page:1,text:'海绵城市设计'},{page:2,text:'海绵城市另一专题'}],facts:[{label:'海绵设施',value:'说明',page:1,group:'景观与海绵',audiences:['设计管理']}]})}});
 api.render(ctx);api.set('view','text');api.set('query','海绵');api.set('group','景观与海绵');api.set('audience','设计管理');
 const html=api.render(ctx);assert.match(html,/1 个原文页面/);assert.match(html,/海绵城市设计/);assert.doesNotMatch(html,/海绵城市另一专题|1 项资料/);
 api.set('audience','其他用途');assert.match(api.render(ctx),/没有找到匹配内容/);
});

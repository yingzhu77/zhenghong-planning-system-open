import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';

const script=fs.readFileSync(new URL('../web/project-knowledge.js',import.meta.url),'utf8');
const preview='/api/scheme-previews/p1/'+ 'a'.repeat(64)+'.webp';
function fixture(){const document={getElementById:()=>null,querySelectorAll:()=>[]};const window={document};vm.runInNewContext(script,{window,document});return window.ZHProjectKnowledge;}
function catalog(patch={}){return {version:1,source:{name:'匿名建筑方案.pdf',url:'/api/files/drawings/p1/source.pdf'},scope:'一期',edition:'测试版',kind:'住宅方案',summary:'匿名说明',plan_page:1,pages:[{page:1,text:'总建筑面积 1000 平方米'}],facts:[{label:'总建筑面积',value:'1000',unit:'㎡',page:1,group:'建筑规模',highlight:true,audiences:['成本与招采']}],issues:[],...patch};}
function context(patch={}){return {identity:'user-a|1',pid:'p1',projects:[{id:'p1',name:'匿名项目'}],fields:{scheme_catalog:catalog()},...patch};}

test('knowledge hub only indexes projects supplied by the authorized scope',()=>{
 const api=fixture(),html=api.render(context({catalogs:[{project_id:'p1',name:'有权项目',catalog:catalog()},{project_id:'p2',name:'不得泄露的项目',catalog:catalog({summary:'不得泄露的说明'})}]}));
 assert.match(html,/有权项目/);assert.doesNotMatch(html,/不得泄露|drawings\/p2/);
});
test('facts retain units, scope and physical source pages without complete document links',()=>{
 const html=fixture().render(context());assert.match(html,/1000<small>㎡/);assert.match(html,/一期/);assert.match(html,/<span class="pk-source">原文第 1 页<\/span>/);
 assert.match(html,/项目速览/);assert.match(html,/指标与专题/);assert.match(html,/版本与待核对/);assert.doesNotMatch(html,/原文检索|source\.pdf#|\/api\/files\/|<a\b|download=/);
});
test('only the registered same-project crop endpoint can produce an image source',()=>{
 const api=fixture();
 for(const url of ['https://example.invalid/source.pdf','javascript:alert(1)','/api/files/drawings/p1/preview.png',preview.replace('/p1/','/p2/'),preview+'?page=2',preview.replace('a'.repeat(64),'../secret'),preview.replace('.webp','.pdf')])assert.equal(api.safePreview(url,'p1'),'');
 assert.equal(api.safePreview(preview,'p1'),preview);
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

test('excerpt filters preserve topic and audience while legacy text view cannot expose full pages',()=>{
 const api=fixture(),ctx=context({fields:{scheme_catalog:catalog({pages:[{page:1,text:'未公开整页海绵城市设计'},{page:2,text:'未公开整页海绵城市另一专题'}],facts:[{label:'海绵设施',value:'说明',page:1,group:'景观与海绵',audiences:['设计管理']}]})}});
 api.render(ctx);api.set('view','text');api.set('query','海绵');api.set('group','景观与海绵');api.set('audience','设计管理');
 const html=api.render(ctx);assert.match(html,/1 项结果/);assert.match(html,/海绵设施/);assert.doesNotMatch(html,/未公开整页|个原文页面|打开原文/);
 api.set('audience','其他用途');assert.match(api.render(ctx),/没有找到匹配的关键摘录/);
 api.set('group','');api.set('audience','');api.set('query','未公开整页');assert.match(api.render(ctx),/0 项结果/);assert.doesNotMatch(api.render(ctx),/未公开整页海绵城市设计/);
});

test('persisted catalog entry shapes are checked before any view renders',()=>{
 const api=fixture();
 for(const patch of [{facts:[null]},{facts:[{label:'面积',audiences:'设计管理'}]},
   {pages:[null]},{pages:[{page:1,text:{unexpected:true}}]},
   {issues:[null]},{issues:[{title:'待核对',pages:'1'}]}]){
  const c=catalog(patch);assert.equal(api.valid(c),false);assert.doesNotThrow(()=>api.render(context({fields:{scheme_catalog:c}})));
 }
});

test('page labels reject markup and non-positive or non-integer values',()=>{
 const api=fixture();
 for(const page of ['<b data-review>page</b>',0,-1,1.5,'1e2','01',true,Number.MAX_SAFE_INTEGER+1]){
  const c=catalog({pages:[{page,text:'匿名搜索内容'}]});assert.equal(api.valid(c),false);
  const html=api.render(context({fields:{scheme_catalog:c}}));assert.doesNotMatch(html,/<b data-review>|#page=/);
 }
});

test('physical PDF page numbers remain correct for sparse indexes and canonical numeric strings',()=>{
 const api=fixture(),c=catalog({plan_page:'8',pages:[{page:'8',text:'海绵城市设计'}],
  facts:[{label:'海绵设施',value:'说明',page:8,group:'景观',audiences:['设计管理'],highlight:true}]});
 const ctx=context({fields:{scheme_catalog:c}});assert.equal(api.valid(c),true);
 assert.match(api.render(ctx),/原文第 8 页/);assert.doesNotMatch(api.render(ctx),/source\.pdf#page=/);
 api.set('view','text');api.set('query','海绵');api.set('audience','设计管理');
 const html=api.render(ctx);assert.match(html,/原文第 8 页/);assert.match(html,/1 项结果/);assert.doesNotMatch(html,/PDF 第|个原文页面/);
});

test('approved crop is shown without an original-page link; legacy whole-page preview fails closed',()=>{
 const api=fixture(),html=api.render(context({fields:{scheme_catalog:catalog({plan_page:null,preview})}}));
 assert.ok(html.includes('src="'+preview+'"'));assert.doesNotMatch(html,/#page=NaN|href="#page=|<a\b|download=/);
 const legacy=api.render(context({fields:{scheme_catalog:catalog({preview:'/api/files/drawings/p1/preview.png'})}}));assert.match(legacy,/关键总图待整理/);assert.doesNotMatch(legacy,/<img\b|\/api\/files\//);
});

test('public catalog with no page text retains citation coverage and searches summaries and differences',()=>{
 const api=fixture(),ctx=context({fields:{scheme_catalog:catalog({pages:[],page_count:26,plan_page:8,preview,summary:'保留养老设施方案概要',facts:[{label:'设施',value:'养老设施',page:8,highlight:true}],issues:[{title:'版本差异',detail:'养老设施方案尚需协调',pages:[8]}]})}}),before=JSON.stringify(ctx);
 assert.match(api.render(ctx),/原文第 8 页/);assert.match(api.render(ctx),/覆盖 26 页索引/);api.set('query','养老设施');const html=api.render(ctx);assert.match(html,/3 项结果/);assert.match(html,/方案概要/);assert.match(html,/版本差异/);assert.doesNotMatch(html,/<a\b|\/api\/files\//);assert.equal(JSON.stringify(ctx),before);
});

test('sparse public page numbers preserve physical citations without guessing unregistered pages',()=>{
 const api=fixture(),c=catalog({pages:[],page_count:2,page_numbers:[3,8],plan_page:8,facts:[
  {label:'已登记的第八页摘录',value:'关键指标',page:8,highlight:true},
  {label:'未登记来源的摘录',value:'另一指标',page:9,highlight:true}
 ]}),ctx=context({fields:{scheme_catalog:c}}),before=JSON.stringify(ctx);
 assert.equal(api.valid(c),true);const html=api.render(ctx);assert.match(html,/<span class="pk-source">原文第 8 页<\/span>/);assert.match(html,/来源待登记/);assert.doesNotMatch(html,/原文第 9 页|<a\b|\/api\/files\/|整页文字/);assert.match(html,/覆盖 2 页索引/);assert.equal(JSON.stringify(ctx),before);
 for(const page_numbers of [[0],[1.5],['8'],[{}],'3,8'])assert.equal(api.valid({...c,page_numbers}),false);
});

test('invalid catalog visibly falls back to the original archive without changing stored data',()=>{
 const document={getElementById:()=>null,querySelectorAll:()=>[]},window={document},env={window,document};
 vm.runInNewContext(script,env);vm.runInNewContext(fs.readFileSync(new URL('../web/reporter-archive.js',import.meta.url),'utf8'),env);
 const c=catalog({facts:[null]}),before=JSON.stringify(c),ctx=context({tab:'knowledge',fields:{scheme_catalog:c},helpers:{esc:String,sd:String,richItem:()=>'',dayDiff:()=>0,lightOf:()=>'',devTxt:()=>''}});
 const html=window.ZHReporterArchive.render(ctx);
 assert.match(html,/方案资料暂无法读取，已显示原档案/);assert.match(html,/项目总图|基本资料/);
 assert.equal(JSON.stringify(c),before);
});

test('legacy archive shows a same-project crop without a link and retains ordinary independent drawings',()=>{
 const document={getElementById:()=>null,querySelectorAll:()=>[]},window={document},env={window,document};
 vm.runInNewContext(script,env);vm.runInNewContext(fs.readFileSync(new URL('../web/reporter-archive.js',import.meta.url),'utf8'),env);
 const ordinary='/api/files/drawings/p1/ordinary.png',html=window.ZHReporterArchive.render(context({tab:'plan',fields:{},helpers:{esc:String,sd:String},drawings:[
  {kind:'项目总图',name:'方案总图.pdf',url:preview,path:'drawings/p1/private.pdf'},
  {kind:'项目总图',name:'其他项目的裁剪',url:preview.replace('/p1/','/p2/'),path:'drawings/p1/private.pdf'},
  {kind:'其他',name:'独立普通图纸.png',url:ordinary}
 ]}));
 assert.ok(html.includes('src="'+preview+'"'));assert.ok(!html.includes('href="'+preview+'"'));assert.doesNotMatch(html,/src="[^\"]*\/p2\/|private\.pdf/);assert.ok(html.includes('href="'+ordinary+'"'));assert.match(html,/独立普通图纸/);
});

test('actual Edge excerpt-only hub shows the approved crop, excludes source requests and remains readable at desktop and mobile',async t=>{
 const {default:sharp}=await import('sharp'),drawing=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="520"><rect width="900" height="520" fill="#e8efe8"/><path d="M70 60H830V460H70Z" fill="#f8faf7" stroke="#96aba4" stroke-width="12"/><path d="M110 250H790M440 100V420" stroke="#d5ddd8" stroke-width="38"/><g fill="#9ebfc4" stroke="#5f8a93" stroke-width="3"><rect x="150" y="110" width="190" height="80"/><rect x="530" y="110" width="190" height="80"/><rect x="150" y="320" width="190" height="80"/><rect x="530" y="320" width="190" height="80"/></g><g fill="#b9cda9"><circle cx="380" cy="170" r="26"/><circle cx="500" cy="350" r="26"/></g></svg>')).webp().toBuffer();
 const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());const page=await browser.newPage(),errors=[],requested=[],missingPreview=preview.replace('a'.repeat(64),'b'.repeat(64));page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{const url=new URL(route.request().url());requested.push(url.pathname);return route.fulfill(url.pathname===missingPreview?{status:404,contentType:'text/plain',body:'not found'}:url.pathname===preview?{status:200,contentType:'image/webp',body:drawing}:{status:200,contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'});});
 await page.goto('http://scheme-preview.test/');for(const name of ['styles.css','planning-ui.css','project-knowledge.css'])await page.addStyleTag({content:fs.readFileSync(new URL('../web/'+name,import.meta.url),'utf8')});await page.addStyleTag({content:'body{margin:0;padding:24px;background:#f3f6fa}button,input,select{font-family:inherit}@media(max-width:650px){body{padding:12px}}'});await page.addScriptTag({content:script});
 const ctx=context({fields:{scheme_catalog:catalog({pages:[{page:1,text:'整页原文禁止回显的文字'}],page_count:26,preview,summary:'匿名住宅与配套设施方案概要，保留不同版本的适用范围。',facts:[
  {label:'总建筑面积',value:'1000',unit:'㎡',page:1,group:'建筑规模',highlight:true,audiences:['设计管理']},
  {label:'机动车停车位',value:'120',unit:'个',page:8,group:'停车与交通',highlight:true,audiences:['设计管理']},
  {label:'养老设施',value:'已摘录配套设施范围',page:9,group:'公共配套',highlight:true,audiences:['设计管理']}
 ],issues:[{title:'实施版与报建版范围待核对',detail:'两版本配套设施口径分别保留。',pages:[8,9]}]})}});
 await page.evaluate(ctx=>{window.fixtureContext=ctx;window.App={reporterArchiveTab(){},masterPick(){}};document.getElementById('root').innerHTML=ZHProjectKnowledge.render(ctx);},ctx);
 await expect(page.locator('.pk-plan img')).toBeVisible();assert.equal(await page.locator('.pk-plan img').evaluate(image=>image.complete && image.naturalWidth>0),true);await expect(page.getByRole('button',{name:'原文检索',exact:true})).toHaveCount(0);await expect(page.locator('.project-knowledge a')).toHaveCount(0);
 const artifacts=path.resolve('.local/scheme-protection-20261105/ui');fs.mkdirSync(artifacts,{recursive:true});
 for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(artifacts,'excerpt-hub-'+width+'.png'),fullPage:true});}
 await page.locator('#pk-query').fill('停车位');await expect(page.locator('.pk-result')).toHaveCount(1);await expect(page.locator('.pk-result')).toContainText('120');await expect(page.locator('.pk-result')).toContainText('原文第 8 页');
 await page.evaluate(()=>ZHProjectKnowledge.set('view','text'));await expect(page.locator('.pk-result')).toHaveCount(1);await page.locator('#pk-query').fill('整页原文禁止回显');await expect(page.locator('#pk-content')).toContainText('0 项结果');await expect(page.locator('#pk-content')).not.toContainText('整页原文禁止回显的文字');
 await page.setViewportSize({width:1440,height:1000});await page.evaluate(missing=>{window.fixtureContext.fields.scheme_catalog.preview=missing;ZHProjectKnowledge.set('view','overview');document.getElementById('root').innerHTML=ZHProjectKnowledge.render(window.fixtureContext);},missingPreview);await expect(page.locator('[data-pk-preview-error]')).toBeVisible();await expect(page.locator('[data-pk-preview-error]')).toHaveText('关键总图暂无法读取，请刷新重试');await expect(page.locator('.pk-plan img')).toBeHidden();await expect(page.locator('.pk-plan')).toContainText('原文第 1 页');await expect(page.getByRole('heading',{name:'总图关键区域',exact:true})).toBeVisible();assert.ok(requested.includes(missingPreview));await page.screenshot({path:path.join(artifacts,'excerpt-preview-unavailable-1440.png'),fullPage:true});
 await page.evaluate(()=>{window.fixtureContext.fields.scheme_catalog.preview='/api/files/drawings/p1/whole-page.png';ZHProjectKnowledge.set('view','overview');document.getElementById('root').innerHTML=ZHProjectKnowledge.render(window.fixtureContext);});await expect(page.locator('.pk-plan img')).toHaveCount(0);await expect(page.locator('.pk-plan')).toContainText('关键总图待整理');
 assert.deepEqual(requested.filter(url=>url.startsWith('/api/files/')),[]);assert.deepEqual(errors,[]);
});

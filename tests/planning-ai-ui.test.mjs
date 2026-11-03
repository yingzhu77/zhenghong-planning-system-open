import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';

const source=fs.readFileSync(new URL('../web/planning-ai.js',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../web/planning-ai.css',import.meta.url),'utf8');
const artifacts=process.env.PLANNING_AI_ARTIFACT_DIR||path.join(os.tmpdir(),'planning-ai-ui');
async function fixture(browser,viewport={width:1440,height:1000}) {
  const page=await browser.newPage({viewport});
  await page.route('**/*',route=>route.abort('blockedbyclient'));
  await page.setContent('<button id="entry">AI 帮我整理</button><textarea id="original">原草稿文字</textarea>');
  await page.addStyleTag({content:css});await page.addScriptTag({content:source});
  await page.evaluate(()=>{
    window.ctx={key:'user/project-a/module-a/week-a',identityKey:'user/session-a',canEdit:true,projectName:'示例项目',lineLabel:'机电工程',periodLabel:'第44周（10.26—11.01）',items:[{id:'monthly:a',title:'机房设备安装',progress:'原有进展',signature:'immutable-a'},{id:'monthly:b',title:'室外管网联调',progress:'',signature:'immutable-b'}]};
    window.calls=[];window.applies=[];window.notes=[];window.mode='ok';
    PlanningAI.configure({getContext:()=>ctx,notify:message=>notes.push(message),request:async payload=>{
      calls.push({context:payload.context,messages:payload.messages,files:payload.files.map(f=>({name:f.name,size:f.size}))});
      if(mode==='fail')throw new Error('连接超时，请重试。');
      if(mode==='pending')return new Promise((resolve,reject)=>{window.resolveAI=resolve;payload.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});
      return {reply:'已整理出2条进展，原有文字会保留。',draft:{items:[{id:'monthly:a',progress:'设备已就位，等待试运行。',sources:['现场周例会记录.pdf 第2页']},{id:'monthly:b',progress:'材料待到场，需协调确认到货时间。',sources:['现场周例会记录.pdf 第3页']}]}};
    },onApply:async payload=>{applies.push(payload);return {message:'已填入本周草稿，尚未提交。'};}});
    document.querySelector('#entry').onclick=()=>PlanningAI.open();
  });
  return page;
}

test('large chat uploads, previews, confirms only one draft write and preserves request snapshot',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await fixture(browser);await expect(page.locator('dialog')).toHaveCount(0);
    await page.locator('#entry').click();await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('示例项目 · 机电工程 · 第44周（10.26—11.01）')).toBeVisible();
    await expect(page.locator('.planning-ai-input')).toBeFocused();
    await page.locator('.planning-ai-input').fill('帮我整理附件，保留原文');
    await page.locator('.planning-ai-picker').setInputFiles({name:'现场周例会记录.pdf',mimeType:'application/pdf',buffer:Buffer.from('anonymous test attachment')});
    await expect(page.locator('.planning-ai-selected')).toContainText('现场周例会记录.pdf');
    await page.getByRole('button',{name:'收起 AI 填报助手'}).click();await page.locator('#entry').click();
    await expect(page.locator('.planning-ai-input')).toHaveValue('帮我整理附件，保留原文');
    await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(page.getByRole('button',{name:'确认保存到本周草稿',exact:true})).toBeVisible();
    await expect(page.locator('.planning-ai-message.is-user .planning-ai-file')).toContainText('已上传');
    assert.equal(await page.evaluate(()=>applies.length),0);
    assert.equal(await page.locator('#original').inputValue(),'原草稿文字');
    assert.equal(await page.evaluate(()=>calls[0].files[0].name),'现场周例会记录.pdf');
    await page.evaluate(()=>ctx.items[0].progress='用户后来输入的内容');
    await page.getByRole('button',{name:'确认保存到本周草稿',exact:true}).click();
    await expect(page.locator('.planning-ai-receipt')).toContainText('尚未提交');
    assert.equal(await page.evaluate(()=>applies[0].context.items[0].progress),'原有进展');
    assert.equal(await page.evaluate(()=>applies[0].context.items[0].signature),'immutable-a');
    await expect(page.getByRole('button',{name:'确认保存到本周草稿',exact:true})).toHaveCount(0);
    await page.locator('.planning-ai-input').fill('第二条删掉');await page.locator('.planning-ai-input').press('Control+Enter');
    await expect(page.locator('.planning-ai-message.is-assistant')).toHaveCount(2);
    const history=JSON.parse(await page.evaluate(()=>calls[1].messages.find(m=>m.role==='assistant').content));
    assert.match(history.reply,/已整理出2条进展，原有文字会保留。/);
    assert.equal(history.draft.items[1].id,'monthly:b');assert.match(history.draft.items[1].progress,/材料待到场/);
    await expect(page.getByRole('button',{name:'确认保存到本周草稿',exact:true})).toHaveCount(1);
    fs.mkdirSync(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'desktop-chat.png')});
    await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.locator('#entry')).toBeFocused();
    await page.close();
  } finally {await browser.close();}
});
test('plain confirmation saves the visible candidate without a provider request and offers explicit receipt and undo',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await fixture(browser);await page.locator('#entry').click();
    await page.evaluate(()=>PlanningAI.configure({getContext:()=>ctx,request:async()=>{calls.push({});return {reply:'请核对两条新增进展。',draft:{items:[{id:'monthly:a',progress:'设备就位。',sources:['用户输入']}]}};},onApply:async payload=>{applies.push(payload);return {message:'已保存到本周草稿，尚未提交。',receipt_id:'receipt-test'};},onUndo:async()=>({message:'已撤销这次保存，未提交周报。'})}));
    await page.locator('.planning-ai-input').fill('整理设备就位');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(page.locator('.planning-ai-preview-status')).toContainText('尚未保存');
    await page.locator('.planning-ai-input').fill('确认保存');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(page.locator('.planning-ai-receipt')).toContainText('已保存');assert.equal(await page.evaluate(()=>calls.length),1);assert.equal(await page.evaluate(()=>applies.length),1);
    await expect(page.getByRole('button',{name:'查看本周草稿',exact:true})).toBeVisible();
    await page.locator('.planning-ai-input').fill('撤销这次保存');await page.locator('.planning-ai-input').press('Control+Enter');
    await expect(page.locator('.planning-ai-receipt')).toContainText('已撤销');assert.equal(await page.evaluate(()=>calls.length),1);
    await page.locator('.planning-ai-input').fill('确认保存');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('没有待保存');assert.equal(await page.evaluate(()=>applies.length),1);
  }finally{await browser.close();}
});

test('an empty weekly list can preview all monthly plan rows and only append through explicit confirmation',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await fixture(browser,{width:390,height:844});
    await page.evaluate(()=>{
      ctx={...ctx,items:[],monthly_plans:[{month:'2026-10',items:[]}],monthlySignatures:{'2026-10':'month-before'}};
      window.monthRows=Array.from({length:13},(_,index)=>({mod:index<7?'景观一标段':'景观二标段',name:'第'+(index+1)+'项景观工作',due:index===12?'':'2026-10-30',progress:index===0?'完成47项':'',sources:['匿名计划.xlsx · 景观 D'+(index+3)]}));
      PlanningAI.configure({getContext:()=>ctx,request:async payload=>{calls.push(payload);return {reply:'已按表内10月标题提取13项，请核对后加入草稿。',draft:{items:[],monthly_plan:{month:'2026-10',items:monthRows}}};},onApply:async payload=>{applies.push(payload);return {receipt_id:'month-receipt'};}});
    });
    await page.locator('#entry').click();await expect(page.locator('.planning-ai-welcome')).toContainText('当前没有事项也可从附件');
    await page.locator('.planning-ai-picker').setInputFiles({name:'匿名月计划.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('anonymous UI file only')});
    await page.getByRole('button',{name:'发送',exact:true}).click();
    const fill=page.getByRole('button',{name:'确认加入2026-10月计划草稿',exact:true});await expect(fill).toBeVisible();
    await expect(page.locator('.planning-ai-preview-item')).toHaveCount(13);
    await expect(page.locator('.planning-ai-preview')).toContainText('保留已有输入');await expect(page.locator('.planning-ai-preview')).toContainText('未提交填报');
    await expect(page.locator('.planning-ai-preview-item').first()).toContainText('模块：景观一标段 · 完成时间：2026-10-30');
    await expect(page.locator('.planning-ai-preview-item').first()).toContainText('完成47项');
    await expect(page.locator('.planning-ai-preview-item').last()).toContainText('未设置，请核对');
    await expect(page.locator('.planning-ai-preview-item').last()).toContainText('景观 D15');
    assert.match(await page.evaluate(()=>calls[0].messages[0].content),/月计划草稿候选/);
    assert.equal(await page.evaluate(()=>applies.length),0);assert.equal(await page.locator('#original').inputValue(),'原草稿文字');
    const metrics=await page.getByRole('dialog').evaluate(d=>({overflow:d.scrollWidth>d.clientWidth,right:d.getBoundingClientRect().right,width:innerWidth}));
    assert.equal(metrics.overflow,false);assert.ok(metrics.right<=metrics.width+1);
    await fill.scrollIntoViewIfNeeded();fs.mkdirSync(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'mobile-month-plan-preview.png')});
    await page.evaluate(()=>ctx.monthlySignatures['2026-10']='month-after');await fill.click();
    await expect(page.locator('.planning-ai-receipt')).toContainText('已追加到2026-10月计划草稿，尚未确认或提交');
    assert.equal(await page.evaluate(()=>applies.length),1);assert.equal(await page.evaluate(()=>applies[0].context.monthlySignatures['2026-10']),'month-before');
    assert.deepEqual(await page.evaluate(()=>applies[0].draft.monthly_plan.items),await page.evaluate(()=>monthRows));
    await expect(fill).toHaveCount(0);await page.close();
  }finally{await browser.close();}
});

test('monthly candidates retain dialogue facts, replace older actions, confirm by chat and offer month draft receipt and undo',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await fixture(browser);
    await page.evaluate(()=>{
      ctx={...ctx,items:[],monthly_plans:[{month:'2026-11',items:[]}],monthlySignatures:{'2026-11':'month-draft'}};window.undos=[];window.views=[];
      PlanningAI.configure({getContext:()=>ctx,request:async payload=>{calls.push(payload);return {reply:calls.length===1?'已提取月计划。':'已保留原表标准。',draft:{items:[],monthly_plan:{month:'2026-11',items:[{mod:'一标段',name:calls.length===1?'完成材料定样':'完成材料定样并汇报',due:'2026-11-20',progress:'等待封样',sources:['匿名景观.xlsx D5']}]}}};},onApply:async payload=>{applies.push(payload);return {receipt_id:'month-receipt',message:'已保存到2026-11月计划草稿，尚未确认或提交。'};},onViewDraft:request=>views.push(request),onUndo:async request=>{undos.push(request);return {message:'已撤销月计划草稿追加，未提交。'};}});
    });
    await page.locator('#entry').click();await page.locator('.planning-ai-input').fill('提取下月景观计划');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(page.getByRole('button',{name:'确认加入2026-11月计划草稿',exact:true})).toBeVisible();await page.evaluate(()=>window.oldMonthFill=document.querySelector('.planning-ai-actions .planning-ai-primary'));
    await page.locator('.planning-ai-input').fill('保留标准并补充汇报');await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.locator('.planning-ai-message.is-assistant')).toHaveCount(2);
    const history=JSON.parse(await page.evaluate(()=>calls[1].messages.find(m=>m.role==='assistant').content));assert.equal(history.draft.monthly_plan.month,'2026-11');assert.equal(history.draft.monthly_plan.items[0].name,'完成材料定样');
    await expect(page.getByText('此草稿已被后续回复替代，不能再填入。')).toBeVisible();await page.evaluate(()=>oldMonthFill.click());assert.equal(await page.evaluate(()=>applies.length),0);
    await page.locator('.planning-ai-input').fill('确认加入2026-11月计划草稿');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(page.locator('.planning-ai-receipt')).toContainText('尚未确认或提交');assert.equal(await page.evaluate(()=>calls.length),2);assert.equal(await page.evaluate(()=>applies.length),1);
    assert.equal(await page.evaluate(()=>applies[0].draft.monthly_plan.items[0].name),'完成材料定样并汇报');
    await page.getByRole('button',{name:'查看2026-11月计划草稿',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();assert.deepEqual(await page.evaluate(()=>views),[{month:'2026-11'}]);
    await page.locator('#entry').click();await page.getByRole('button',{name:'撤销这次保存',exact:true}).click();await expect(page.locator('.planning-ai-receipt')).toContainText('已撤销');assert.deepEqual(await page.evaluate(()=>undos),[{receipt_id:'month-receipt'}]);
    await page.locator('.planning-ai-input').fill('确认保存');await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.getByRole('alert')).toContainText('没有待保存');assert.equal(await page.evaluate(()=>applies.length),1);
    await page.close();
  }finally{await browser.close();}
});

test('monthly previews cannot reuse stale scope actions or late model replies',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await fixture(browser);await page.evaluate(()=>{ctx={...ctx,items:[],monthly_plans:[{month:'2026-10',items:[]}]};mode='pending';});
    await page.locator('#entry').click();await page.locator('.planning-ai-input').fill('提取月计划');await page.getByRole('button',{name:'发送',exact:true}).click();
    await page.evaluate(()=>{window.monthReply={reply:'旧项目月计划',draft:{items:[],monthly_plan:{month:'2026-10',items:[{mod:'景观',name:'旧范围任务',due:'2026-10-30',progress:'',sources:['匿名表D3']}]}}};ctx={...ctx,key:'user/project-b/module-a/week-a'};PlanningAI.refresh();resolveAI(monthReply);});
    await expect(page.getByText('旧项目月计划')).toHaveCount(0);assert.equal(await page.evaluate(()=>applies.length),0);
    await page.evaluate(()=>{mode='pending';});await page.locator('.planning-ai-input').fill('提取此项目计划');await page.getByRole('button',{name:'发送',exact:true}).click();await page.evaluate(()=>resolveAI(monthReply));
    await expect(page.getByRole('button',{name:'确认加入2026-10月计划草稿',exact:true})).toBeVisible();await page.evaluate(()=>{window.staleMonthlyButton=document.querySelector('.planning-ai-actions .planning-ai-primary');ctx={...ctx,canEdit:false};});
    await page.evaluate(()=>staleMonthlyButton.click());assert.equal(await page.evaluate(()=>applies.length),0);await page.evaluate(()=>PlanningAI.refresh());await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.close();
  }finally{await browser.close();}
});
test('server query cards show exact scope, counts, dates and read-only historical content',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await fixture(browser);
    await page.evaluate(()=>PlanningAI.configure({getContext:()=>ctx,request:async()=>({reply:'已查询到本人记录。',draft:{items:[]},records:{kind:'history',scope:'当前项目模块',as_of:'2026-10-27',total:1,shown:1,has_more:false,basis:'本人已提交周报',reports:[{period:'第43周',project_name:'示例项目',line:'机电',change:'匿名历史正文',items:[{name:'设备安装',progress:'上周完成50%'}],source:'周报1'}]}})}));
    await page.locator('#entry').click();await page.locator('.planning-ai-input').fill('查上周周报');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(page.locator('.planning-ai-records')).toContainText('当前项目模块 · 截至 2026-10-27');
    await page.getByText('第43周 · 示例项目 · 机电',{exact:true}).click();
    await expect(page.locator('.planning-ai-records')).toContainText('上周完成50%');
    await expect(page.getByRole('button',{name:'确认保存到本周草稿',exact:true})).toHaveCount(0);
  }finally{await browser.close();}
});

test('an unreadable monthly draft is visible while existing weekly progress remains usable',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await fixture(browser);await page.evaluate(()=>{ctx={...ctx,monthly_plans:[],monthly_error:'本机月计划草稿读取失败，原内容保留，请先核对。'};});
    await page.locator('#entry').click();await expect(page.getByRole('alert')).toContainText('本机月计划草稿读取失败');
    await page.locator('.planning-ai-input').fill('整理已有事项本周进展');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(page.getByRole('button',{name:'确认保存到本周草稿',exact:true})).toBeEnabled();
    await expect(page.getByRole('alert')).toContainText('原内容保留');assert.equal(await page.evaluate(()=>applies.length),0);
    await page.close();
  }finally{await browser.close();}
});

test('month shortcut makes the selected project capability explicit and image candidates require source review without auto-saving',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const page=await fixture(browser);await page.evaluate(()=>{ctx.monthly_plans=[{month:'2026-10',items:[]}];ctx.items=[];PlanningAI.configure({getContext:()=>ctx,request:async packet=>{calls.push({messages:packet.messages});return {reply:'已识别图片计划，请对照原图。',monthly_review:{kind:'image',source_rows:1,proposed_rows:1,note:'图片文字需本人核对，尚未写入。'},draft:{items:[],monthly_plan:{month:'2026-10',items:[{mod:'景观',name:'材料封样完成',due:'2026-10-30',progress:'',sources:['现场计划.png · 图片']}]}}};},onApply:async packet=>{applies.push(packet);return {message:'已加入本机草稿，未确认或提交。'};}});});
  await page.locator('#entry').click();await expect(page.getByText(/当前项目已就绪/)).toBeVisible();await page.locator('.planning-ai-input').fill('保留我的补充说明');await page.getByRole('button',{name:'提取2026-10月计划',exact:true}).click();assert.equal(await page.evaluate(()=>calls.length),0);assert.match(await page.locator('.planning-ai-input').inputValue(),/^保留我的补充说明\n.*2026-10/);const once=await page.locator('.planning-ai-input').inputValue();await page.getByRole('button',{name:'提取2026-10月计划',exact:true}).click();await expect(page.locator('.planning-ai-input')).toHaveValue(once);
  await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.getByText('图片识别 · 请对照原图核对 · 1 项候选')).toBeVisible();await expect(page.getByRole('button',{name:'确认加入2026-10月计划草稿',exact:true})).toBeVisible();assert.equal(await page.evaluate(()=>applies.length),0);
 }finally{await browser.close();}
});

test('chat retry, cancel, scope switches and identity changes cannot reuse stale replies',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await fixture(browser);await page.locator('#entry').click();
    await page.evaluate(()=>mode='fail');await page.locator('.planning-ai-input').fill('帮我整理');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('连接超时');
    await page.evaluate(()=>mode='ok');await page.getByRole('button',{name:'重试',exact:true}).click();
    await expect(page.locator('.planning-ai-message.is-assistant')).toHaveCount(1);await expect(page.locator('.planning-ai-message.is-user')).toHaveCount(1);
    await page.evaluate(()=>mode='pending');await page.locator('.planning-ai-input').fill('继续整理');await page.getByRole('button',{name:'发送',exact:true}).click();
    await page.getByRole('button',{name:'取消整理',exact:true}).click();await expect(page.getByRole('alert')).toContainText('本次整理已取消');
    await page.locator('.planning-ai-input').fill('不要带到下个项目');
    await page.evaluate(()=>{ctx={...ctx,key:'user/project-b/module-a/week-a',projectName:'另一个项目'};PlanningAI.refresh();});
    await expect(page.locator('.planning-ai-input')).toHaveValue('');await expect(page.locator('.planning-ai-message')).toHaveCount(0);
    await page.evaluate(()=>{ctx={...ctx,key:'user/project-a/module-a/week-a',projectName:'示例项目'};PlanningAI.refresh();});
    await expect(page.locator('.planning-ai-input')).toHaveValue('不要带到下个项目');
    await page.locator('.planning-ai-input').fill('旧请求');await page.getByRole('button',{name:'发送',exact:true}).click();
    await page.evaluate(()=>{window.oldResolve=resolveAI;ctx={...ctx,key:'user/project-b/module-a/week-a'};PlanningAI.refresh();oldResolve({reply:'旧范围回复',draft:{items:[{id:'monthly:a',progress:'不应出现'}]}});});
    await expect(page.getByText('旧范围回复')).toHaveCount(0);await expect(page.locator('.planning-ai-message')).toHaveCount(0);
    await page.evaluate(()=>{ctx={...ctx,identityKey:'other-user/session-b'};PlanningAI.refresh();});
    await expect(page.locator('.planning-ai-input')).toHaveValue('');
    await page.evaluate(()=>{ctx={...ctx,canEdit:false};PlanningAI.refresh();});await expect(page.getByRole('dialog')).not.toBeVisible();
    assert.equal(await page.evaluate(()=>applies.length),0);await page.close();
  } finally {await browser.close();}
});

test('chat rejects invalid attachments, renders model text safely and fits mobile',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await fixture(browser,{width:390,height:844});await page.locator('#entry').click();
    await page.locator('.planning-ai-picker').setInputFiles({name:'旧版材料.doc',mimeType:'application/msword',buffer:Buffer.from('anonymous')});
    await expect(page.getByRole('alert')).toContainText('请使用 PDF、docx、xlsx 或图片');
    await expect(page.locator('.planning-ai-selected')).toHaveCount(0);
    await page.evaluate(()=>{mode='pending';});await page.locator('.planning-ai-input').fill('整理现场记录');await page.getByRole('button',{name:'发送',exact:true}).click();
    await page.evaluate(()=>resolveAI({reply:'<img src=x onerror="window.unsafe=true">',draft:{items:[{id:'monthly:a',progress:'<script>window.unsafe=true</script>',sources:['<b>附件第一页</b>']}]}}));
    await expect(page.locator('.planning-ai-content').last()).toContainText('<img');
    assert.equal(await page.locator('.planning-ai-message img,.planning-ai-message script').count(),0);assert.equal(await page.evaluate(()=>!!window.unsafe),false);
    const metrics=await page.getByRole('dialog').evaluate(d=>{const r=d.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:d.scrollWidth>d.clientWidth};});
    assert.ok(metrics.left>=0&&metrics.right<=metrics.width+1&&metrics.top>=0&&metrics.bottom<=metrics.height+1);assert.equal(metrics.overflow,false);
    await page.getByRole('button',{name:'确认保存到本周草稿',exact:true}).scrollIntoViewIfNeeded();
    fs.mkdirSync(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'mobile-chat.png')});await page.close();
  } finally {await browser.close();}
});

test('an empty draft in a newer reply cancels the older fill action',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await fixture(browser);await page.locator('#entry').click();
    await page.locator('.planning-ai-input').fill('帮我整理');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(page.getByRole('button',{name:'确认保存到本周草稿',exact:true})).toHaveCount(1);
    await page.evaluate(()=>{mode='pending';window.oldFill=document.querySelector('.planning-ai-actions .planning-ai-primary');});
    await page.locator('.planning-ai-input').fill('不要填了，取消草稿');await page.getByRole('button',{name:'发送',exact:true}).click();
    await page.evaluate(()=>resolveAI({reply:'已取消这份草稿。',draft:{items:[]}}));
    await expect(page.locator('.planning-ai-message.is-assistant')).toHaveCount(2);
    await expect(page.getByRole('button',{name:'确认保存到本周草稿',exact:true})).toHaveCount(0);
    await expect(page.getByText('此草稿已被后续回复替代，不能再填入。')).toBeVisible();
    await page.evaluate(()=>oldFill.click());assert.equal(await page.evaluate(()=>applies.length),0);
    await page.close();
  } finally {await browser.close();}
});

test('full large draft context is preserved and a new conversation recovers from explicit size limits',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await fixture(browser);await page.locator('#entry').click();
    await page.locator('.planning-ai-picker').setInputFiles({name:'现场记录.pdf',mimeType:'application/pdf',buffer:Buffer.from('anonymous')});
    await page.evaluate(()=>{mode='pending';window.largeReply='原文'.repeat(3200);window.largeDraft={items:[{id:'monthly:a',progress:'设备进展'.repeat(550),sources:['现场记录.pdf 第1页']},{id:'monthly:b',progress:'材料到货'.repeat(500),sources:['现场记录.pdf 第2页']}]};});
    await page.locator('.planning-ai-input').fill('整理这两条');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(page.getByRole('button',{name:'新对话',exact:true})).toBeDisabled();
    await page.evaluate(()=>resolveAI({reply:largeReply,draft:largeDraft}));
    await expect(page.getByRole('button',{name:'确认保存到本周草稿',exact:true})).toBeVisible();
    await page.locator('.planning-ai-input').fill('第二条删掉，第一条保留原文');await page.getByRole('button',{name:'发送',exact:true}).click();
    const full=await page.evaluate(()=>calls[1].messages[1].content);
    assert.equal(full,await page.evaluate(()=>JSON.stringify({reply:largeReply,draft:largeDraft})));
    assert.ok(full.length>6000&&full.length<=12000);
    await page.evaluate(()=>resolveAI({reply:'长回复'.repeat(4000),draft:largeDraft}));
    await expect(page.locator('.planning-ai-message.is-assistant')).toHaveCount(2);
    await page.locator('.planning-ai-input').fill('请继续保留原文');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('上一轮内容较多');
    assert.equal(await page.evaluate(()=>calls.length),2);
    await expect(page.locator('.planning-ai-input')).toHaveValue('请继续保留原文');
    await page.getByRole('button',{name:'新对话',exact:true}).click();
    await expect(page.locator('.planning-ai-message')).toHaveCount(0);await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.planning-ai-input')).toHaveValue('请继续保留原文');await expect(page.locator('.planning-ai-selected')).toContainText('现场记录.pdf');
    assert.equal(await page.locator('#original').inputValue(),'原草稿文字');assert.equal(await page.evaluate(()=>applies.length),0);
    await page.evaluate(()=>mode='ok');await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.locator('.planning-ai-message.is-assistant')).toHaveCount(1);
    assert.equal(await page.evaluate(()=>calls[2].messages.length),1);assert.equal(await page.evaluate(()=>calls[2].files[0].name),'现场记录.pdf');
    await page.close();
  } finally {await browser.close();}
});

test('the twenty-message boundary never silently drops older context',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await fixture(browser);await page.locator('#entry').click();
    for(let index=0;index<10;index++) {
      await page.locator('.planning-ai-input').fill('第'+(index+1)+'次整理');await page.getByRole('button',{name:'发送',exact:true}).click();
      await expect(page.locator('.planning-ai-message.is-assistant')).toHaveCount(index+1);
    }
    await page.locator('.planning-ai-input').fill('下一次整理');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('已达到20条消息');
    assert.equal(await page.evaluate(()=>calls.length),10);
    await expect(page.locator('.planning-ai-input')).toHaveValue('下一次整理');
    assert.equal(await page.evaluate(()=>calls[9].messages[0].content),'第1次整理');
    await page.getByRole('button',{name:'新对话',exact:true}).click();await expect(page.locator('.planning-ai-message')).toHaveCount(0);
    await page.close();
  } finally {await browser.close();}
});

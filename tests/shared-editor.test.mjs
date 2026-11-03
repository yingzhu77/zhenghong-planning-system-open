import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium, expect} from '@playwright/test';

const web = new URL('../web/', import.meta.url);
async function mount(page) {
  for (const name of ['vendor/quill/quill.core.css','styles.css','planning-ui.css','selection-format.css']) await page.addStyleTag({content:fs.readFileSync(new URL(name,web),'utf8')});
  for (const name of ['vendor/quill/quill.js','rich-text.js','rich-editor.js']) await page.addScriptTag({content:fs.readFileSync(new URL(name,web),'utf8')});
  await page.evaluate(() => {
    window.documents = {};
    window.ZHRichEditor.mount(document.body,id => ({get:() => window.documents[id],set:value => {window.documents[id]=value;}}));
  });
}

test('personal selection toolbar follows the chosen field, preserves formatting and leaves manager controls independent', async () => {
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1200,height:900}});
    await page.setContent('<div class="planning-shell"><section data-shared-rich-editor><div data-shared-rich-toolbar></div><textarea data-rich id="first" aria-label="第一行进展">第一行原文</textarea><textarea data-rich id="second" aria-label="第二行进展">第二行原文</textarea><input id="date" type="date"></section></div><div class="planning-shell manager-shell"><textarea data-rich id="admin">管理端原文</textarea></div>');
    await mount(page);
    const tools=page.getByRole('toolbar',{name:'所选文字格式'});
    await expect(tools).toBeHidden();
    await expect(page.locator('[data-shared-rich-toolbar] button')).toHaveCount(0);
    await expect(page.locator('[data-rich-editor-for="first"] .rich-toolbar')).toHaveCount(0);
    await expect(page.locator('[data-rich-editor-for="admin"] .rich-toolbar button')).toHaveCount(3);
    const first=page.locator('[data-rich-editor-for="first"] .ql-editor'),second=page.locator('[data-rich-editor-for="second"] .ql-editor');
    await first.click(); await expect(tools).toBeHidden(); await first.press('Control+A');
    await expect(tools).toBeVisible();
    await tools.getByRole('button',{name:'加粗',exact:true}).click();
    await expect(first.locator('strong')).toHaveText('第一行原文');
    await second.click(); await second.press('Control+A');
    await tools.getByRole('button',{name:'标红',exact:true}).click();
    await expect(second.locator('span')).toHaveText('第二行原文');
    await expect(first.locator('strong')).toHaveText('第一行原文');
    await tools.getByRole('button',{name:'清除格式',exact:true}).click();
    await expect(second.locator('[style*="color"]')).toHaveCount(0);
    await page.locator('#date').focus(); await expect(tools).toBeHidden();
    const docs=await page.evaluate(() => {window.ZHRichEditor.flush();return window.documents;});
    assert.equal(docs.first.ops[0].attributes.bold,true);
    assert.equal(docs.second.ops[0].insert,'第二行原文');
    assert.equal(docs.admin.ops[0].insert,'管理端原文');
    assert.equal(await page.locator('#first').inputValue(),'第一行原文');
    assert.equal(await page.locator('#second').inputValue(),'第二行原文');
    const admin=page.locator('[data-rich-editor-for="admin"] .ql-editor');
    await admin.click(); await admin.press('Control+A');
    await page.locator('[data-rich-editor-for="admin"]').getByRole('button',{name:'加粗',exact:true}).click();
    await expect(admin.locator('strong')).toHaveText('管理端原文'); await expect(tools).toBeHidden();
    await page.evaluate(() => {document.querySelector('[data-shared-rich-editor]').remove();window.ZHRichEditor.flush();});
    await expect(tools).toBeHidden();
  } finally {await browser.close();}
});

test('large forms mount in one layout batch while retaining text, formatting and disabled fields', async () => {
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1200,height:900}});
    await page.setContent('<div class="planning-shell"><main>'+Array.from({length:80},(_,i)=>
      '<textarea data-rich id="row_'+i+'"'+(i===1?' readonly':i===2?' disabled':'')+'>正文'+i+'\n第二行</textarea>').join('')+'</main></div>');
    for (const name of ['vendor/quill/quill.core.css','styles.css','planning-ui.css','selection-format.css']) await page.addStyleTag({content:fs.readFileSync(new URL(name,web),'utf8')});
    for (const name of ['vendor/quill/quill.js','rich-text.js','rich-editor.js']) await page.addScriptTag({content:fs.readFileSync(new URL(name,web),'utf8')});
    const client=await page.context().newCDPSession(page);
    await client.send('Performance.enable');
    const before=await client.send('Performance.getMetrics');
    await page.evaluate(() => {
      window.documents={};
      for(let i=0;i<80;i++)window.documents['row_'+i]={ops:[{insert:'正文'+i,attributes:{bold:true,color:'#d81e06'}},{insert:'\n第二行'}]};
      window.binding=id=>({get:()=>window.documents[id],set:doc=>{window.documents[id]=doc;}});
      window.ZHRichEditor.mount(document.body,window.binding);
      document.body.getBoundingClientRect();
    });
    const after=await client.send('Performance.getMetrics');
    const layouts=metrics=>metrics.metrics.find(metric=>metric.name==='LayoutCount').value;
    assert.ok(layouts(after)-layouts(before)<8,'mounting 80 fields must not force layout for each editor');
    await expect(page.locator('.ql-editor')).toHaveCount(80);
    await expect(page.locator('[data-rich-editor-for="row_0"] strong')).toHaveText('正文0');
    await expect(page.locator('[data-rich-editor-for="row_0"] strong')).toHaveCSS('color','rgb(216, 30, 6)');
    for(const id of ['row_1','row_2']) await expect(page.locator('[data-rich-editor-for="'+id+'"] .ql-editor')).toHaveAttribute('contenteditable','false');
    await page.locator('[data-rich-editor-for="row_79"] .ql-editor').fill('末行新输入\n继续填写');
    await page.evaluate(()=>{window.ZHRichEditor.flush();window.ZHRichEditor.mount(document.body,window.binding);});
    await expect(page.locator('.ql-editor')).toHaveCount(80);
    assert.equal(await page.locator('#row_79').inputValue(),'末行新输入\n继续填写');
    assert.equal(await page.locator('#row_0').inputValue(),'正文0\n第二行');
    const saved=await page.evaluate(()=>window.documents);
    assert.equal(saved.row_0.ops[0].attributes.bold,true);
    assert.equal(saved.row_0.ops[0].attributes.color,'#d81e06');
    assert.equal(saved.row_79.ops.map(op=>op.insert).join(''),'末行新输入\n继续填写');
  } finally {await browser.close();}
});

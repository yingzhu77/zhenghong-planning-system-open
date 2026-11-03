import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {chromium,expect} from '@playwright/test';
const web=new URL('../web/',import.meta.url);
const artifacts=process.env.PERSONAL4_RICH_ARTIFACT_DIR || path.join(os.tmpdir(),'personal4-rich-artifacts');

test('selection formatting stays near text on desktop and mobile, survives composition and cannot target replaced fields',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});fs.mkdirSync(artifacts,{recursive:true});
 const errors=[];
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<div id="root"><div class="planning-shell"><main style="max-width:1100px;margin:40px auto;padding:20px"><h2>本期填报</h2><label>当周进展<textarea id="progress" data-rich aria-label="当周进展">原进展需要保留格式</textarea></label><label>遇到卡点<textarea id="blocker" data-rich aria-label="遇到卡点">材料确认卡点</textarea></label><label>同步进展<textarea id="followup" data-rich aria-label="同步进展">原同步事项进展</textarea></label><input type="date" id="due"></main></div></div>');
  for(const name of ['vendor/quill/quill.core.css','styles.css','planning-ui.css','selection-format.css'])await page.addStyleTag({content:fs.readFileSync(new URL(name,web),'utf8')});
  for(const name of ['vendor/quill/quill.js','rich-text.js','rich-editor.js'])await page.addScriptTag({content:fs.readFileSync(new URL(name,web),'utf8')});
  await page.evaluate(()=>{
   window.docs={};window.saved={source_id:'original-source',otherDraft:{source_id:'unmatched-draft'},attachment:'original-attachment',approval:'original-approval'};
   window.binding=id=>({get:()=>window.docs[id],set:doc=>{window.docs[id]=doc;}});
   window.ZHRichEditor.mount(document.getElementById('root'),window.binding);
  });
  const tools=page.getByRole('toolbar',{name:'所选文字格式'}),progress=page.locator('[data-rich-editor-for="progress"] .ql-editor');
  await expect(page.locator('.planning-shell .rich-toolbar')).toHaveCount(0);
  await progress.click();await progress.press('Control+A');await expect(tools).toBeVisible();
  await tools.getByRole('button',{name:'加粗',exact:true}).click();await expect(progress.locator('strong')).toHaveText('原进展需要保留格式');
  let geometry=await tools.boundingBox(),editor=await progress.boundingBox();
  assert.ok(geometry.x>=8&&geometry.x+geometry.width<=1440-8);assert.ok(Math.abs(geometry.y-editor.y)<150);
  await page.screenshot({path:path.join(artifacts,'selection-format-desktop.png'),fullPage:true});
  await progress.press('Alt+F10');await expect(tools.getByRole('button',{name:'加粗',exact:true})).toBeFocused();
  await tools.getByRole('button',{name:'加粗',exact:true}).press('Escape');await expect(tools).toBeHidden();
  await page.setViewportSize({width:390,height:844});
  const blocker=page.locator('[data-rich-editor-for="blocker"] .ql-editor');
  await blocker.click();await blocker.press('Control+A');await tools.getByRole('button',{name:'标红',exact:true}).click();
  await expect(blocker.locator('span')).toHaveText('材料确认卡点');geometry=await tools.boundingBox();
  assert.ok(geometry.x>=7&&geometry.x+geometry.width<=390-7);assert.ok(geometry.y>=7&&geometry.y+geometry.height<=844-7);
  await page.screenshot({path:path.join(artifacts,'selection-format-mobile.png'),fullPage:true});
  await page.evaluate(()=>{const q=window.Quill.find(document.querySelector('[data-rich-editor-for="blocker"] .rich-surface'));q.setSelection(q.getLength()-1,0,'user');});
  await blocker.dispatchEvent('compositionstart');await expect(tools).toBeHidden();
  await page.evaluate(()=>{const q=window.Quill.find(document.querySelector('[data-rich-editor-for="blocker"] .rich-surface'));q.insertText(q.getLength()-1,'中文补充','user');});
  await expect(tools).toBeHidden();
  await blocker.dispatchEvent('compositionend');
  await expect(page.locator('#blocker')).toHaveValue('材料确认卡点中文补充');
  await page.locator('#due').focus();await expect(tools).toBeHidden();
  const snapshot=await page.evaluate(()=>{window.ZHRichEditor.flush();return JSON.stringify({docs:window.docs,saved:window.saved});});
  await page.evaluate(()=>{
   window.oldEditor=document.querySelector('[data-rich-editor-for="blocker"] .ql-editor');window.oldQuill=window.Quill.find(window.oldEditor.parentElement);
   const value=document.getElementById('blocker').value,main=document.querySelector('main');
   main.innerHTML='<h2>重新打开当前填报</h2><textarea data-rich id="blocker" aria-label="遇到卡点"></textarea>';document.getElementById('blocker').value=value;
   window.ZHRichEditor.mount(document.getElementById('root'),window.binding);
   window.oldEditor.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));window.oldQuill.insertText(0,'过期输入','user');
  });
  await expect(tools).toBeHidden();
  const again=page.locator('[data-rich-editor-for="blocker"] .ql-editor');await expect(again).toContainText('材料确认卡点中文补充');
  await again.click();await again.press('Control+A');await tools.getByRole('button',{name:'清除格式',exact:true}).click();
  await expect(again.locator('[style*="color"]')).toHaveCount(0);
  const final=await page.evaluate(()=>{window.ZHRichEditor.flush();return {docs:window.docs,saved:window.saved,hidden:document.getElementById('blocker').value};});
  assert.equal(final.hidden,'材料确认卡点中文补充');assert.equal(final.docs.progress.ops[0].attributes.bold,true);
  assert.deepEqual(final.saved,JSON.parse(snapshot).saved);assert.equal(final.docs.followup.ops[0].insert,'原同步事项进展');assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(artifacts,'selection-format-result.json'),JSON.stringify({desktop:true,mobile:true,composition:true,replacedFieldProtected:true,originalIdentifiersRetained:true,errors,businessWrites:0},null,2));
 }finally{await browser.close();}
});

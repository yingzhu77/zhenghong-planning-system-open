import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';

test('two actual projection windows isolate profession choices and drafts, restore the current controller selection and resize real table text',async t=>{
  const period='2026-10-26',projects=[{id:'hf',name:'匿名新部门项目',project_type:'com'},{id:'other-com',name:'匿名其他商业',project_type:'com'}],reads=[],writes=[];
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://anonymous.test');
      function json(data,status=200){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({data}));}
      if(url.pathname==='/api/auth/session')return json({session:{user:{id:'anonymous-admin'}}});
      if(url.pathname==='/api/monthly-plans/list')return json([]);
      if(url.pathname==='/api/monthly-summaries'){reads.push(url.pathname);return json([{id:'summary',project_id:'hf',month:url.searchParams.get('month'),line:'设计部',owner_name:'匿名提报人',items:[{source_id:'summary-item',mod:'设计',name:'独立月度事项',due:'2026-10-31',progress:'月度完成情况原文'}]}]);}
      if(url.pathname==='/api/db'){
        let body='';for await(const part of req)body+=part;const query=JSON.parse(body),pid=query.filters?.find(filter=>filter.column==='project_id' || filter.column==='id')?.value;reads.push(query.table);if(query.operation!=='select')writes.push(query);
        if(query.table==='profiles')return json([{user_id:'anonymous-admin',role:'ops',status:'approved'}]);
        if(query.table==='projects')return json(projects.filter(project=>project.id===pid));
        if(query.table==='reports')return json(['机电工程','设计部','精装设计'].filter(line=>pid==='hf'||line!=='设计部').map((line,index)=>({id:pid+'-'+index,project_id:pid,line,author_id:'anonymous-owner-'+index,author_name:'匿名提报人',period,submitted_at:period+'T01:00:00Z',biz:{items:[{name:pid+' '+line+'原月计划',mod:line,due:'2026-10-31',prog:'保留周进展原文'}]}})));
        return json([]);
      }
      if(req.url==='/'){
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end('<!doctype html><html><head><link rel="stylesheet" href="meeting-mode.css"><script src="planning-windows.js"></script><script src="rich-text.js"></script><script src="monthly-summaries.js"></script><script src="meeting-view.js"></script><script src="meeting-controller.js"></script></head><body><button id="open">开启投影</button><textarea id="private-draft"></textarea><div id="meeting-controller-mount"></div></body></html>');
      }
      const file=url.pathname.slice(1);if(!/^[a-z-]+\.(?:js|css|html)$/.test(file)){res.writeHead(404);return res.end();}
      const bytes=await readFile(new URL('../web/'+file,import.meta.url));res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8'});res.end(bytes);
    }catch(error){res.writeHead(500);res.end('anonymous fixture failure');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();}));
  const origin='http://127.0.0.1:'+server.address().port,browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];context.on('page',child=>child.on('pageerror',error=>errors.push(error.message)));page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
  await page.evaluate(({period,projects})=>{
    window.selection={allowed:true,uid:'anonymous-admin',identity:'anonymous-session',projects,projectProfessions:[{project_id:'hf',lines:['机电工程','设计部','精装设计']},{project_id:'other-com',lines:['机电工程','精装设计']}],target:{kind:'report',type:'com',projectIds:['hf'],period,line:'机电工程',section:'all'}};
    MeetingController.configure({getContext:()=>window.selection,displayUrl:'/meeting-display.html',notify:message=>{throw new Error(message);}});document.getElementById('open').onclick=()=>MeetingController.start(window.open('about:blank','projection-test'));
  },{period,projects});
  await page.locator('#private-draft').fill('管理员尚未保存的原草稿');const popup=page.waitForEvent('popup');await page.locator('#open').click();const display=await popup;
  await expect(display.locator('#meeting-screen')).toContainText('hf 机电工程原月计划');await expect(display.locator('#meeting-profession')).toHaveValue('机电工程');
  const cell=display.locator('td[data-label="事项"]').first(),before=await cell.evaluate(node=>parseFloat(getComputedStyle(node).fontSize)),zoom=await display.evaluate(()=>({scale:visualViewport.scale,dpr:devicePixelRatio}));
  await display.locator('#meeting-font-more').click();assert.ok(await cell.evaluate(node=>parseFloat(getComputedStyle(node).fontSize))>before);await display.locator('#meeting-font-less').click();assert.equal(await cell.evaluate(node=>parseFloat(getComputedStyle(node).fontSize)),before);assert.deepEqual(await display.evaluate(()=>({scale:visualViewport.scale,dpr:devicePixelRatio})),zoom);assert.equal(await cell.evaluate(node=>getComputedStyle(node).textAlign),'left');
  await display.locator('#meeting-profession').selectOption('设计部');await expect(display.locator('#meeting-screen')).toContainText('hf 设计部原月计划');await expect(display.locator('#meeting-screen')).toContainText('月度完成情况原文');await expect(page.locator('.meeting-control')).toContainText('已暂停跟随');assert.equal(await page.evaluate(()=>selection.target.line),'机电工程');await expect(page.locator('#private-draft')).toHaveValue('管理员尚未保存的原草稿');
  assert.equal(await display.locator('td[data-label="月度完成情况"]').evaluate(node=>getComputedStyle(node).textAlign),'left');
  const artifacts=process.env.MEETING_ARTIFACT_DIR || path.join(os.tmpdir(),'planning-meeting-display-ui');await mkdir(artifacts,{recursive:true});await display.screenshot({path:path.join(artifacts,'profession-and-month-summary-desktop.png'),fullPage:true});
  await page.evaluate(()=>{selection.target.line='精装设计';MeetingController.refresh();});await expect(display.locator('#meeting-screen')).toContainText('hf 设计部原月计划');await page.locator('[data-meeting-toggle]').click();await expect(display.locator('#meeting-screen')).toContainText('hf 精装设计原月计划');await expect(display.locator('#meeting-profession')).toHaveValue('精装设计');
  await page.evaluate(()=>{selection.target.projectIds=['other-com'];selection.target.line='机电工程';MeetingController.refresh();});await expect(display.locator('#meeting-screen')).toContainText('other-com 机电工程原月计划');await expect(display.locator('#meeting-profession option[value="设计部"]')).toHaveCount(0);
  await display.evaluate(()=>opener.postMessage({app:'planning-meeting-v1',id:location.hash.slice(1),type:'profession',line:'设计部'},location.origin));await expect(display.locator('#meeting-screen')).toContainText('other-com 机电工程原月计划');assert.equal(await page.evaluate(()=>selection.target.projectIds[0]),'other-com');
  await display.locator('#meeting-fullscreen').click();await expect.poll(()=>display.evaluate(()=>!!document.fullscreenElement)).toBe(true);await expect(display.locator('#meeting-screen')).toContainText('other-com 机电工程原月计划');await display.locator('#meeting-fullscreen').click();await expect.poll(()=>display.evaluate(()=>!!document.fullscreenElement)).toBe(false);
  await display.setViewportSize({width:390,height:844});assert.equal(await display.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true);await expect(display.locator('#meeting-fullscreen')).toBeVisible();await display.screenshot({path:path.join(artifacts,'profession-projection-mobile.png'),fullPage:true});assert.deepEqual(writes,[]);assert.ok(reads.includes('/api/monthly-summaries'));assert.deepEqual(errors,[]);
});

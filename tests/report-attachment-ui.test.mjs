import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/report-attachments.js', import.meta.url), 'utf8');
const MiB = 1024 * 1024;
const id = n => '10000000-0000-4000-8000-' + String(n).padStart(12, '0');
function meta(n, extra = {}) {
  return { id:id(n), name:'匿名图片' + n + '.png', mime:'image/png', size:1024, inline:true,
    owner_id:'owner', project_id:'project-a', period:'第43周', line:'综合', referenced:false, ...extra };
}
function file(name, size = 1024, type = 'image/png') { return { name, size, type }; }
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function harness(options = {}) {
  const calls = [], messages = [], drafts = [], confirmations = [], events = {}, bodyChildren = [];
  let paints = 0, captures = 0, focusCount = 0;
  const closeButton = { focus() { focusCount++; } };
  const previous = { focus() { focusCount++; } };
  const document = {
    activeElement:previous,
    body:{ appendChild(el) { bodyChildren.push(el); } },
    addEventListener(type, handler) { events[type] = handler; },
    removeEventListener(type) { delete events[type]; },
    createElement() {
      const element = { innerHTML:'', className:'', addEventListener(type, handler) { element[type] = handler; },
        querySelector() { return closeButton; }, querySelectorAll() { return [closeButton]; },
        remove() { const at = bodyChildren.indexOf(element); if (at >= 0) bodyChildren.splice(at, 1); } };
      return element;
    }
  };
  const sandbox = { console, document, confirm(text) { confirmations.push(text); return options.confirm !== false; } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename:'report-attachments.js' });
  const S = { uid:'owner', session:{ token:'anonymous-test-session' }, profile:{ role:'pm', status:'approved' },
    pmProject:'project-a', pmPeriod:'第43周', pmLine:'综合', pmReport:null, reportAttachments:[], attachmentIds:[], formNote:'保留其他表单内容' };
  const cfg = {
    S, esc:value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;' }[c])),
    render() { paints++; }, toast(text, kind) { messages.push({ text, kind }); },
    flush() { captures++; if (options.flush) options.flush(S); },
    saveDraft() { drafts.push(JSON.parse(JSON.stringify({ attachments:S.attachmentIds, note:S.formNote }))); },
    async fetch(url, request) {
      calls.push({ url, request });
      if (options.fetch) return options.fetch(url, request, calls.length);
      if (url === '/api/report-attachments/discard') return {ok:true,status:200,json:async () => ({data:{id:JSON.parse(request.body).id,discarded:true},error:null})};
      const n = calls.length, name = new URL('http://anonymous.local' + url).searchParams.get('filename');
      return { ok:true, status:200, json:async () => ({ data:meta(n, { name, size:request.body.size, mime:request.body.type || 'application/pdf', inline:/image|pdf/.test(request.body.type) }), error:null }) };
    }
  };
  const api = sandbox.ReportAttachments;
  api.configure(cfg);
  return { api, S, cfg, sandbox, calls, messages, drafts, confirmations, events, bodyChildren,
    paints:() => paints, captures:() => captures, focusCount:() => focusCount };
}

test('module authorization callback hides upload and prevents direct attachment writes in an unassigned scope', async () => {
  const h = harness(); h.cfg.canEditScope = () => false; h.S.profile.biz_line = null; h.S.pmLine = '';
  h.api.configure(h.cfg);
  assert.doesNotMatch(h.api.formHtml(), /id="report-attachment-upload"/);
  await h.api.upload({files: [file('未授权.png')], value: 'selected'});
  assert.equal(h.calls.length, 0); assert.equal(h.drafts.length, 0);
  h.S.reportAttachments = [meta(1, {line: ''})]; h.api.toggle(id(1), true);
  assert.deepEqual(Array.from(h.S.attachmentIds), []);
});

test('wildcard account uploads use the actual module and an authorization change ignores an older upload reply', async () => {
  const pending = deferred();
  const h = harness({fetch: () => pending.promise});
  h.S.profile.biz_line = '*'; h.S.pmLine = '机电设计'; h.cfg.canEditScope = () => h.S.profile.biz_line === '*' && h.S.pmLine === '机电设计';
  h.api.configure(h.cfg);
  const uploading = h.api.upload({files: [file('匿名设计.pdf', 1234, 'application/pdf')], value: 'selected'});
  const url = new URL('http://anonymous.local' + h.calls[0].url);
  assert.equal(url.searchParams.get('line'), '机电设计'); assert.notEqual(url.searchParams.get('line'), '*');
  h.S.profile.biz_line = null; h.api.configure(h.cfg);
  pending.resolve({ok: true, status: 200, json: async () => ({data: meta(1, {line: '机电设计', name: '匿名设计.pdf', mime: 'application/pdf', size: 1234})})});
  await uploading;
  assert.deepEqual(Array.from(h.S.attachmentIds), []); assert.equal(h.S.reportAttachments.length, 0); assert.equal(h.drafts.length, 0);
  assert.equal(h.api.isUploading(), false); assert.doesNotMatch(h.api.formHtml(), /上传成功|id="report-attachment-upload"/);
});

test('attachment form lists selected files and only current owner drafts with lazy images and safe Office downloads', () => {
  const h = harness();
  h.S.reportAttachments = [meta(1), meta(2,{name:'匿名方案.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',inline:false}),
    meta(3,{owner_id:'another'}), meta(4,{period:'第42周'}), meta(5,{project_id:'project-b'}), meta(6,{line:'设计'})];
  h.S.pmReport = { biz:{attachments:[id(1)]} };
  h.api.prepare();
  const html = h.api.formHtml();
  assert.match(html, /五、附件资料/); assert.match(html, /multiple accept="[^"]*\.docx[^"]*\.xlsx/);
  assert.match(html, /loading="lazy" decoding="async"/); assert.match(html, /width="96" height="72"/);
  assert.match(html, /下载Word/); assert.match(html, /已上传但未选入本期的文件（1 件）/);
  assert.doesNotMatch(html, new RegExp(id(3) + '|' + id(4) + '|' + id(5) + '|' + id(6)));
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  h.api.ids().push(id(2));
  assert.deepEqual(Array.from(h.api.ids()), [id(1)]);
  assert.deepEqual(h.S.pmReport.biz.attachments,[id(1)]);
});

test('selection removal and restoration preserve uploaded metadata and historical report references', () => {
  const h = harness();
  h.S.reportAttachments = [meta(1),meta(2,{owner_id:'another'})]; h.S.pmReport = {biz:{attachments:[id(1)]}};
  h.api.prepare(); h.api.toggle(id(1),false);
  assert.equal(h.api.ids().length,0); assert.equal(h.S.reportAttachments.length,2);
  assert.deepEqual(h.S.pmReport.biz.attachments,[id(1)]);
  h.api.toggle(id(1),true);
  assert.deepEqual(Array.from(h.api.ids()),[id(1)]);
  h.api.toggle(id(2),true);
  assert.deepEqual(Array.from(h.api.ids()),[id(1)]); assert.equal(h.calls.length,0);
  assert.match(h.messages.at(-1).text,/当前本人填报范围/);
  assert.deepEqual(h.drafts.map(d => d.attachments.length),[0,1]);
});

test('persisted attachment references reject malformed, duplicate, missing and oversized selection data', () => {
  const h = harness();
  assert.match(h.api.formHtml(), /当前选入 0 \/ 20 件 · 0 MiB \/ 40 MiB/);
  h.S.attachmentIds = {bad:true}; assert.match(h.api.validationError(),/格式异常/);
  h.S.attachmentIds = ['../unsafe']; assert.match(h.api.validationError(),/格式异常/);
  h.S.attachmentIds = [id(1),id(1)]; assert.match(h.api.validationError(),/重复/);
  h.S.attachmentIds = [id(1)]; assert.match(h.api.validationError(),/尚未加载/);
  h.S.reportAttachments = [meta(1,{owner_id:'another'})]; assert.match(h.api.validationError(),/不属于当前本人/);
  h.S.reportAttachments = [meta(1,{size:41*MiB})]; assert.match(h.api.validationError(),/40 MiB/);
  h.S.attachmentIds = Array.from({length:21},(_,i) => id(i+1)); assert.match(h.api.validationError(),/20 件/);
});

test('multiple uploads send raw files sequentially, skip invalid files and preserve successful UUID-only drafts', async () => {
  let inFlight = 0, maximum = 0;
  const h = harness({ async fetch(url, request, n) {
    inFlight++; maximum = Math.max(maximum,inFlight);
    await Promise.resolve(); inFlight--;
    return {ok:true,status:200,json:async () => ({data:meta(n,{name:request.body.name,size:request.body.size,mime:request.body.type || 'application/pdf',inline:/image|pdf/.test(request.body.type)})})};
  } });
  const a = file('匿名图片.png'), b = file('匿名资料.pdf',2048,''), input = {value:'fakepath',files:[a,file('不可用.svg'),b,file('超大.docx',9*MiB)]};
  await h.api.upload(input);
  assert.equal(input.value,''); assert.equal(maximum,1); assert.equal(h.calls.length,2);
  assert.equal(h.calls[0].request.body,a); assert.equal(h.calls[1].request.body,b);
  assert.equal(h.calls[1].request.headers['Content-Type'],'application/octet-stream');
  assert.match(h.calls[0].url,/project_id=project-a/); assert.match(h.calls[0].url,/period=%E7%AC%AC43%E5%91%A8/);
  assert.deepEqual(Array.from(h.api.ids()),[id(1),id(2)]); assert.equal(h.api.validationError(),'');
  const html = h.api.formHtml(); assert.match(html,/不支持此文件格式/); assert.match(html,/单件文件不能超过/);
  assert.match(html,/上传成功，已选入本期/); assert.equal(h.S.formNote,'保留其他表单内容');
  assert.ok(h.drafts.every(d => d.attachments.every(value => typeof value === 'string')));
  assert.doesNotMatch(JSON.stringify(h.drafts),/fakepath|base64|"files"|"type"|"size"/);
  assert.ok(h.captures() > 0); assert.ok(h.paints() > 0);
});

test('partial upload failure retains successes and captures other report edits made during an active upload', async () => {
  const pending = deferred(); let draftInput = '上传时继续输入';
  const h = harness({flush(S) {S.formNote = draftInput;},async fetch(url,request,n) {
    if (n===1) await pending.promise;
    if (n===2) throw new Error('网络连接已中断，请重试');
    return {ok:true,status:200,json:async () => ({data:meta(n,{name:request.body.name,size:request.body.size})})};
  }});
  const uploading = h.api.upload({files:[file('第一张.png'),file('第二张.png'),file('第三张.png')]});
  assert.equal(h.api.isUploading(),true); assert.match(h.api.validationError(),/正在处理/);
  draftInput = '异步等待中输入的最后版本'; pending.resolve(); await uploading;
  assert.equal(h.api.isUploading(),false); assert.deepEqual(Array.from(h.api.ids()),[id(1),id(3)]);
  assert.equal(h.S.formNote,'异步等待中输入的最后版本'); assert.equal(h.drafts.at(-1).note,h.S.formNote);
  assert.match(h.api.formHtml(),/第二张.png：网络连接已中断，请重试/);
});

test('upload scope and session switches cannot select late responses into a different report or account', async () => {
  for (const change of ['scope','account','session']) {
    const pending = deferred();
    const h = harness({fetch:() => pending.promise});
    const uploading = h.api.upload({files:[file('迟到响应.png')]});
    if(change==='scope') h.S.pmProject = 'project-b';
    else if(change==='account') h.S.uid = 'second-owner';
    else h.S.session = {token:'another-anonymous-session'};
    h.S.attachmentIds = []; h.S.reportAttachments = []; h.api.configure(h.cfg);
    pending.resolve({ok:true,status:200,json:async () => ({data:meta(1)})}); await uploading;
    assert.equal(h.S.reportAttachments.length,0,change); assert.equal(h.api.ids().length,0,change);
    assert.equal(h.api.isUploading(),false,change); assert.equal(h.drafts.length,0,change);
    assert.doesNotMatch(h.api.formHtml(),/迟到响应|上传成功/);
  }
});

test('selected quotas block a whole over-limit batch and removed drafts do not permanently consume selection capacity', async () => {
  const h = harness({fetch:async (url,request) => ({ok:true,status:200,json:async () => ({data:meta(26,{name:request.body.name,size:request.body.size})})})});
  h.S.reportAttachments = Array.from({length:25},(_,i) => meta(i+1));
  h.S.attachmentIds = Array.from({length:20},(_,i) => id(i+1));
  await h.api.upload({files:[file('本批超额.png')]});
  assert.equal(h.calls.length,0); assert.match(h.messages.at(-1).text,/20 件或 40 MiB/);
  h.api.toggle(id(20),false);
  await h.api.upload({files:[file('解除选入后上传.png')]});
  assert.equal(h.calls.length,1);
  assert.equal(h.api.ids().length,20); assert.ok(h.api.ids().includes(id(26)));
  const total = harness();
  total.S.reportAttachments = Array.from({length:5},(_,i) => meta(i+1,{size:8*MiB})); total.S.attachmentIds = total.S.reportAttachments.map(row=>row.id);
  await total.api.upload({files:[file('总量超额.pdf')]}); assert.equal(total.calls.length,0);
});

test('expired upload permissions stop the batch without retrying every remaining file', async () => {
  const h = harness({fetch:async () => ({ok:false,status:403,json:async () => ({error:{message:'当前项目权限已更新，请刷新数据'}})})});
  await h.api.upload({files:[file('第一个.png'),file('第二个.png')]});
  assert.equal(h.calls.length,1); assert.equal(h.api.ids().length,0); assert.equal(h.api.isUploading(),false);
  assert.match(h.api.formHtml(),/当前项目权限已更新/);
});

test('leadership and historical snapshots stay read only, escape filenames and reconstruct restricted URLs', async () => {
  const h = harness();
  h.S.profile.role = 'president'; h.S.reportAttachments = [meta(1,{name:'<script>匿名.png',url:'https://untrusted.invalid/secret'}),meta(2,{name:'匿名表格.xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',inline:false})];
  const html = h.api.snapshotHtml({biz:{attachments:[id(1),id(2)]}});
  assert.match(html,/&lt;script&gt;匿名.png/); assert.match(html,/下载Excel/);
  assert.doesNotMatch(html,/untrusted|<script>|checkbox|onchange|选择文件上传/);
  assert.match(html,new RegExp('/api/report-attachments/'+id(1)));
  await h.api.upload({files:[file('非填报人.png')]}); assert.equal(h.calls.length,0);
  assert.match(h.api.snapshotHtml({biz:{attachments:['../bad',id(1)]}}),/格式异常/);
});

test('image and PDF previews use an isolated modal without repainting the report; Office files use downloads', () => {
  const h = harness();
  h.S.reportAttachments = [meta(1),meta(2,{name:'匿名PDF.pdf',mime:'application/pdf'}),meta(3,{name:'匿名Word.doc',mime:'application/msword',inline:false})];
  h.api.preview(id(1));
  assert.equal(h.bodyChildren.length,1); assert.match(h.bodyChildren[0].innerHTML,/<img src="\/api\/report-attachments\//);
  assert.match(h.bodyChildren[0].innerHTML,/role="dialog" aria-modal="true"/); assert.equal(h.paints(),0);
  h.events.keydown({key:'Escape'}); assert.equal(h.bodyChildren.length,0);
  h.api.preview(id(2)); assert.match(h.bodyChildren[0].innerHTML,/<iframe src="\/api\/report-attachments\//);
  h.api.closePreview(); h.api.preview(id(3)); assert.equal(h.bodyChildren.length,0); assert.ok(h.focusCount()>0);
});

test('only unselected, unreferenced owner drafts expose physical discard while submitted snapshots remain untouched', async () => {
  const h = harness();
  h.S.reportAttachments = [meta(1),meta(2),meta(3,{referenced:true}),meta(4,{referenced:undefined}),meta(5,{owner_id:'another'})];
  h.S.attachmentIds = [id(1)];
  const html = h.api.formHtml();
  assert.match(html,new RegExp("ReportAttachments.discard\\('" + id(2) + "'\\)"));
  assert.equal((html.match(/onclick="ReportAttachments.discard/g)||[]).length,1);
  const history = h.api.snapshotHtml({biz:{attachments:[id(1),id(2),id(3)]}});
  assert.doesNotMatch(history,/ReportAttachments.discard|删除未提交文件/);
  await h.api.discard(id(1)); await h.api.discard(id(3)); await h.api.discard(id(4)); await h.api.discard(id(5));
  assert.equal(h.calls.length,0); assert.equal(h.confirmations.length,0);
});

test('discard requires explicit confirmation and updates only a confirmed unused draft without deleting historical references', async () => {
  const cancelled = harness({confirm:false}); cancelled.S.reportAttachments = [meta(1)];
  await cancelled.api.discard(id(1));
  assert.equal(cancelled.confirmations.length,1); assert.equal(cancelled.calls.length,0); assert.equal(cancelled.S.reportAttachments.length,1);
  assert.match(cancelled.confirmations[0],/永久删除.*删除后无法恢复/);
  const h = harness(); h.S.reportAttachments = [meta(1),meta(2,{referenced:true})]; h.S.attachmentIds = [id(2)];
  h.S.pmReport = {biz:{attachments:[id(2)]}};
  await h.api.discard(id(1));
  assert.equal(h.calls.length,1); assert.equal(h.calls[0].url,'/api/report-attachments/discard');
  assert.equal(h.calls[0].request.credentials,'same-origin'); assert.equal(h.calls[0].request.headers['Content-Type'],'application/json');
  assert.deepEqual(JSON.parse(h.calls[0].request.body),{id:id(1)});
  assert.deepEqual(h.S.reportAttachments.map(row=>row.id),[id(2)]); assert.deepEqual(Array.from(h.api.ids()),[id(2)]);
  assert.deepEqual(h.S.pmReport.biz.attachments,[id(2)]); assert.equal(h.drafts.length,1);
  assert.match(h.api.formHtml(),/未提交文件已删除/);
});

test('discard is scoped, blocks duplicate operations and retains failed or late responses safely', async () => {
  const pending = deferred();
  const h = harness({fetch:() => pending.promise}); h.S.reportAttachments = [meta(1)];
  const deleting = h.api.discard(id(1));
  assert.equal(h.api.isUploading(),true); assert.match(h.api.validationError(),/正在处理/);
  assert.match(h.api.formHtml(),/正在删除未提交文件/);
  await h.api.discard(id(1)); await h.api.upload({files:[file('不能并行.png')]});
  assert.equal(h.calls.length,1); assert.equal(h.confirmations.length,1);
  pending.resolve({ok:false,status:409,json:async () => ({error:{message:'附件已用于提交，不能删除'}})}); await deleting;
  assert.equal(h.S.reportAttachments.length,1); assert.equal(h.drafts.length,0); assert.equal(h.api.isUploading(),false);
  assert.match(h.api.formHtml(),/附件已用于提交，不能删除/);
  for (const change of ['scope','account','session']) {
    const waiting = deferred(), late = harness({fetch:() => waiting.promise}); late.S.reportAttachments = [meta(1)];
    const action = late.api.discard(id(1));
    if(change==='scope') late.S.pmProject = 'project-b'; else if(change==='account') late.S.uid = 'next-owner'; else late.S.session = {};
    late.api.configure(late.cfg);
    waiting.resolve({ok:true,status:200,json:async () => ({data:{id:id(1),discarded:true}})}); await action;
    assert.equal(late.S.reportAttachments.length,1,change); assert.equal(late.drafts.length,0,change); assert.equal(late.api.isUploading(),false,change);
  }
});

test('draft inventory errors guide deletion of unused files and stop the remaining upload batch', async () => {
  const h = harness({fetch:async () => ({ok:false,status:409,json:async () => ({error:{code:'draft_storage_limit',message:'未提交草稿库存已满'}})})});
  await h.api.upload({files:[file('第一个.png'),file('第二个.png')]});
  assert.equal(h.calls.length,1); assert.equal(h.api.ids().length,0);
  assert.match(h.api.formHtml(),/删除不再需要的未提交文件后重试/);
  assert.match(h.api.formHtml(),/可切换之前上传的项目／周期清理/);
  assert.match(h.api.formHtml(),/100 件、合计 200 MiB/);
});

function quotaFailure() {
  return {ok:false,status:409,json:async () => ({error:{code:'draft_storage_limit',message:'未提交草稿库存已满'}})};
}

test('inaccessible draft cleanup appears only after quota failure and requires explicit bounded confirmation', async () => {
  const untouched = harness();
  assert.doesNotMatch(untouched.api.formHtml(),/清理已撤销项目的未提交草稿/);
  await untouched.api.discardInaccessible(); assert.equal(untouched.calls.length,0); assert.equal(untouched.confirmations.length,0);
  const cancelled = harness({confirm:false,fetch:async () => quotaFailure()});
  await cancelled.api.upload({files:[file('触发库存.png')]});
  assert.match(cancelled.api.formHtml(),/onclick="ReportAttachments.discardInaccessible\(\)"/);
  await cancelled.api.discardInaccessible(); assert.equal(cancelled.calls.length,1);
  assert.match(cancelled.confirmations[0],/本人.*已撤销项目读取权限.*从未用于提交/);
  assert.match(cancelled.confirmations[0],/已提交附件、历史记录和当前可访问项目的文件不会删除/);
});

test('inaccessible cleanup reports counts only, keeps current metadata and selected IDs, and saves ongoing form input', async () => {
  let input = '清理前填写';
  const h = harness({flush(S) {S.formNote=input;},fetch:async url => url === '/api/report-attachments/discard-inaccessible'
    ? {ok:true,status:200,json:async () => ({data:{discarded_count:3,freed_bytes:2*MiB,private_name:'不应显示的文件名'}})} : quotaFailure()});
  h.S.reportAttachments = [meta(1,{referenced:true}),meta(2)]; h.S.attachmentIds = [id(1)];
  const beforeMetadata = h.S.reportAttachments;
  await h.api.upload({files:[file('触发库存.png')]});
  input = '清理过程中继续保留的表单内容';
  await h.api.discardInaccessible();
  assert.equal(h.calls[1].url,'/api/report-attachments/discard-inaccessible');
  assert.equal(h.calls[1].request.method,'POST'); assert.equal(h.calls[1].request.credentials,'same-origin');
  assert.deepEqual(JSON.parse(h.calls[1].request.body),{});
  assert.equal(h.S.reportAttachments,beforeMetadata); assert.deepEqual(Array.from(h.api.ids()),[id(1)]);
  assert.equal(h.drafts.at(-1).note,input); assert.equal(h.S.formNote,input);
  const html = h.api.formHtml(); assert.match(html,/已清理 3 件未提交文件，释放 2 MiB/);
  assert.doesNotMatch(html,/不应显示的文件名|onclick="ReportAttachments.discardInaccessible/);
});

test('inaccessible cleanup locks other operations, retains failures for retry and ignores late scope/account/session results', async () => {
  const pending = deferred();
  const h = harness({fetch:async url => url === '/api/report-attachments/discard-inaccessible' ? pending.promise : quotaFailure()});
  await h.api.upload({files:[file('触发库存.png')]});
  const cleanup = h.api.discardInaccessible();
  assert.equal(h.api.isUploading(),true); assert.match(h.api.formHtml(),/正在清理已撤销项目/);
  await h.api.discardInaccessible(); await h.api.upload({files:[file('不并发.png')]});
  assert.equal(h.calls.length,2); assert.equal(h.confirmations.length,1);
  pending.resolve({ok:false,status:500,json:async () => ({error:{message:'暂时无法清理，请重试'}})}); await cleanup;
  assert.equal(h.api.isUploading(),false); assert.equal(h.drafts.length,0);
  assert.match(h.api.formHtml(),/暂时无法清理，请重试/); assert.match(h.api.formHtml(),/onclick="ReportAttachments.discardInaccessible/);
  for (const change of ['scope','account','session']) {
    const waiting = deferred();
    const late = harness({fetch:async url => url === '/api/report-attachments/discard-inaccessible' ? waiting.promise : quotaFailure()});
    late.S.reportAttachments = [meta(1)];
    await late.api.upload({files:[file('触发库存.png')]});
    const action = late.api.discardInaccessible();
    if(change==='scope') late.S.pmProject='another'; else if(change==='account') late.S.uid='another'; else late.S.session={};
    late.api.configure(late.cfg);
    waiting.resolve({ok:true,status:200,json:async () => ({data:{discarded_count:2,freed_bytes:1024}})}); await action;
    assert.equal(late.S.reportAttachments.length,1,change); assert.equal(late.drafts.length,0,change);
    assert.doesNotMatch(late.api.formHtml(),/已清理 2 件|onclick="ReportAttachments.discardInaccessible/);
  }
});

test('inaccessible cleanup rejects incomplete server acknowledgements without mutating the current report', async () => {
  const h = harness({fetch:async url => url === '/api/report-attachments/discard-inaccessible'
    ? {ok:true,status:200,json:async () => ({data:{discarded_count:'2',freed_bytes:1024}})} : quotaFailure()});
  h.S.reportAttachments=[meta(1)]; h.S.attachmentIds=[id(1)];
  await h.api.upload({files:[file('触发库存.png')]}); await h.api.discardInaccessible();
  assert.equal(h.S.reportAttachments.length,1); assert.deepEqual(Array.from(h.api.ids()),[id(1)]); assert.equal(h.drafts.length,0);
  assert.match(h.api.formHtml(),/服务器未确认清理结果/); assert.match(h.api.formHtml(),/onclick="ReportAttachments.discardInaccessible/);
});

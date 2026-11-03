import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { decodePlanningAIFiles, extractPlanningAIFiles } from '../server/planning-ai-files.mjs';
import { planningAIChat, loadPlanningAIConfig, validatePlanningAIOutput, validateImageMonthExtraction, monthlyPlanIntent } from '../server/planning-ai.mjs';
import { confirmMonthlyPlan } from '../server/monthly-plans.mjs';
import { makeAdminPlanWorkbook, adminPlanSheet, adminPlanRow, adminPlanInline, excelDateSerial } from './helpers/admin-plan-workbook.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const user = { id: 'demo-pm-res' }, key = 'sk-anonymous-local-test-key-123456';
const input = () => ({ project_id: 'demo-res', line: '综合', period: '2026-10-26', items: [{ id: 'monthly:demo-a', title: '设备安装', progress: '保留原文' }], messages: [{ role: 'user', content: '设备已就位，整理为本周进展' }], files: [] });
const result = () => ({ reply: '已整理，可填入本周草稿。', draft: { items: [{ id: 'monthly:demo-a', progress: '设备已就位。', sources: ['用户输入'] }] } });
const status = code => error => error.status === code;
function response(value = result(), status = 200) {
  return new Response(status === 200 ? JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }) : 'private upstream detail', { status });
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(items) {
  const locals = [], central = []; let offset = 0;
  for (const [name, value] of items) {
    const bytes = Buffer.from(value), rawName = Buffer.from(name), local = Buffer.alloc(30), entry = Buffer.alloc(46), crc = crc32(bytes);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(rawName.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(rawName.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, rawName, bytes); central.push(entry, rawName); offset += 30 + rawName.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function office(kind, mainXml, additions = []) {
  const word = kind === 'word', main = word ? 'word/document.xml' : 'xl/workbook.xml';
  return zip([
    ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/' + main + '" ContentType="application/vnd.openxmlformats-officedocument.' + (word ? 'wordprocessingml.document' : 'spreadsheetml.sheet') + '.main+xml"/></Types>'],
    ['_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="' + main + '"/></Relationships>'],
    [main, mainXml], ...additions
  ]);
}
const file = (name, buffer) => ({ name, data_base64: buffer.toString('base64') });

test('AI附件在隔离worker中提取PDF页码、Word正文、Excel真实关联及图片，拒绝损坏格式', async () => {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText('Equipment ready', { x: 30, y: 40, font, size: 12 });
  const word = office('word', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>设备已就位 &lt;原文&gt;</w:t></w:r></w:p></w:body></w:document>');
  const excel = office('excel', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="安装进展" sheetId="7" r:id="r2"/></sheets></workbook>', [
    ['xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet7.xml"/></Relationships>'],
    ['xl/sharedStrings.xml', '<sst><si><t>等待试运行</t></si></sst>'],
    ['xl/worksheets/sheet7.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><f>1+1</f><v>2</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>设备</t></is></c><c r="B2"><v>45000</v></c><c r="C2"><v>3</v></c></row></sheetData></worksheet>']
  ]);
  const extracted = await extractPlanningAIFiles(decodePlanningAIFiles([file('记录.pdf', Buffer.from(await doc.save())), file('记录.docx', word), file('台账.xlsx', excel), file('现场.png', png)]));
  assert.deepEqual(extracted.sources, ['记录.pdf · 第1页', '记录.docx · 正文', '台账.xlsx · 工作表安装进展', '现场.png · 图片']);
  const text = extracted.parts.filter(part => part.type === 'input_text').map(part => part.text).join('\n');
  assert.match(text, /Equipment ready/); assert.match(text, /设备已就位 <原文>/); assert.match(text, /A1：等待试运行\tC1：2/);
  assert.match(text, /A2：设备\tB2：45000\tC2：3/); assert.match(text, /日期序列数字/);
  assert.equal(extracted.parts.at(-1).type, 'input_image'); assert.match(extracted.parts.at(-1).image_url, /^data:image\/png;base64,/);
  await assert.rejects(extractPlanningAIFiles(decodePlanningAIFiles([file('假.pdf', Buffer.from('not a PDF'))])), status(400));
  const blank = await PDFDocument.create(); blank.addPage();
  await assert.rejects(extractPlanningAIFiles(decodePlanningAIFiles([file('扫描.pdf', Buffer.from(await blank.save()))])), /另存为图片/);
});

test('AI附件配额、旧Office、宏包、字数/页数和取消均明确失败，不悄悄截断', async () => {
  assert.throws(() => decodePlanningAIFiles(Array.from({ length: 5 }, () => file('a.png', png))), status(400));
  assert.throws(() => decodePlanningAIFiles([file('../a.png', png)]), status(400));
  assert.throws(() => decodePlanningAIFiles([file('a.doc', png)]), /另存/);
  assert.throws(() => decodePlanningAIFiles([{ name: 'a.png', data_base64: 'AAAA===' }]), status(400));
  assert.throws(() => decodePlanningAIFiles([file('a.pdf', Buffer.alloc(8 * 1024 * 1024 + 1))]), status(400));
  assert.throws(() => decodePlanningAIFiles([file('a.pdf', Buffer.alloc(7 * 1024 * 1024)), file('b.pdf', Buffer.alloc(7 * 1024 * 1024))]), status(413));
  const macro = office('word', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>', [['word/vbaProject.bin', 'macro']]);
  await assert.rejects(extractPlanningAIFiles(decodePlanningAIFiles([file('宏.docx', macro)])), /宏/);
  const long = office('word', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + '字'.repeat(60001) + '</w:t></w:r></w:p></w:body></w:document>');
  await assert.rejects(extractPlanningAIFiles(decodePlanningAIFiles([file('长.docx', long)])), /6万字/);
  const doc = await PDFDocument.create(); for (let i = 0; i < 31; i++) doc.addPage();
  await assert.rejects(extractPlanningAIFiles(decodePlanningAIFiles([file('多页.pdf', Buffer.from(await doc.save()))])), /30页/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractPlanningAIFiles([{ name: 'a.png', buffer: png }], { signal: controller.signal }), status(499));
  await assert.rejects(extractPlanningAIFiles([{ name: 'a.png', buffer: png }], { timeoutMs: 1 }), status(408));
});

test('AI输出拒绝未知事项、重复、非法来源及任何固定字段写入', () => {
  assert.deepEqual(validatePlanningAIOutput(result(), input().items, ['用户输入']), result());
  for (const change of [
    value => { value.draft.items[0].id = 'other-project-item'; },
    value => { value.draft.items.push(value.draft.items[0]); },
    value => { value.draft.items[0].sources = ['附件第99页']; },
    value => { value.draft.items[0].due = '2099-01-01'; },
    value => { value.draft.items[0].progress = ''; }
  ]) { const value = result(); change(value); assert.throws(() => validatePlanningAIOutput(value, input().items, ['用户输入']), status(502)); }
});

test('AI实际RLS授权、独立配置、provider请求/错误及权限撤销，整个流程不写业务库', async t => {
  const db = await initializedDatabase(), pool = testPool(db), admin = testPool(db, null);
  t.after(() => db.close()); await seedDemo(admin);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'planning-ai-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'provider.json');
  await writeFile(configPath, JSON.stringify({ enabled: true, api_key: key, model: 'deepseek-flash' }), { mode: 0o600 });
  const snapshot = async () => (await admin.query("SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS data FROM public.reports r")).rows[0].data;
  const before = await snapshot(); let requests = 0;
  await assert.rejects(loadPlanningAIConfig(), error => error.code === 'ai_not_configured');
  const fetchImpl = async (url, options) => {
    requests++; assert.equal(url, 'https://api.deepseek.com/responses'); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); assert.equal(body.model, 'deepseek-flash'); assert.equal(body.stream, false); assert.equal(body.tools, undefined); assert.ok(!options.body.includes(key));
    assert.equal(body.temperature, 0); assert.match(body.instructions, /每一轮都必须返回一个完整JSON对象/); assert.match(body.instructions, /JSON格式示例/);
    assert.match(options.body, /保留原文/); assert.equal(body.text.format.type, 'json_schema');
    return response();
  };
  assert.deepEqual(await planningAIChat(pool, user, input(), { configPath, fetchImpl }), result());
  assert.equal(requests, 1); assert.deepEqual(await snapshot(), before);
  for (const [actor, data] of [[{ id: 'demo-ops' }, input()], [{ id: 'demo-pm-com' }, input()], [user, { ...input(), line: '机电工程' }]]) {
    await assert.rejects(planningAIChat(pool, actor, data, { configPath, fetchImpl }), status(403));
  }
  assert.equal(requests, 1);
  await assert.rejects(planningAIChat(pool, user, input(), { configPath: path.join(dir, 'missing'), fetchImpl }), error => error.code === 'ai_config_invalid' && !error.message.includes(dir));
  assert.equal(requests, 1);
  for (const httpStatus of [401, 402, 403, 429, 500]) {
    await assert.rejects(planningAIChat(pool, user, input(), { configPath, fetchImpl: async () => response(null, httpStatus) }), error => error.status === 502 && !error.message.includes('private upstream'));
  }
  await assert.rejects(planningAIChat(pool, user, input(), { configPath, fetchImpl: async () => new Response(key) }), error => error.code === 'ai_output_invalid' && !error.message.includes(key));
  await assert.rejects(planningAIChat(pool, user, input(), { configPath, fetchImpl: async () => new Response(JSON.stringify({ status: 'incomplete', output: [] })) }), error => error.code === 'ai_output_incomplete');
  await assert.rejects(planningAIChat(pool, user, input(), { configPath, fetchImpl: async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '已保留第一条。\n草稿预览：\n[]' }] }] })) }), error => error.code === 'ai_output_invalid');
  await assert.rejects(planningAIChat(pool, user, input(), { configPath, fetchImpl: async () => new Response('x'.repeat(256 * 1024 + 1)) }), error => error.code === 'ai_output_invalid');
  await assert.rejects(planningAIChat(pool, user, input(), { configPath, timeoutMs: 1, fetchImpl: async (url, options) => new Promise((resolve, reject) => {
    if (options.signal.aborted) reject(options.signal.reason);
    else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) }), error => error.code === 'ai_timeout');
  await assert.rejects(planningAIChat(pool, user, input(), { configPath, fetchImpl: async () => { throw new Error('private URL and token'); } }), error => error.code === 'ai_network_failed' && !error.message.includes('token'));
  let release, started; const start = new Promise(resolve => { started = resolve; });
  const ongoing = planningAIChat(pool, user, input(), { configPath, fetchImpl: async () => { started(); await new Promise(resolve => { release = resolve; }); return response(); } });
  await start;
  await assert.rejects(planningAIChat(pool, user, input(), { configPath, fetchImpl }), error => error.code === 'ai_busy');
  release(); await ongoing;
  await assert.rejects(planningAIChat(pool, user, input(), { configPath, fetchImpl: async () => { await admin.query("UPDATE public.profiles SET status='pending' WHERE user_id=$1", [user.id]); return response(); } }), status(403));
  await admin.query("UPDATE public.profiles SET status='approved' WHERE user_id=$1", [user.id]);
  assert.deepEqual(await snapshot(), before);
  await writeFile(configPath, JSON.stringify({ enabled: false }));
  await assert.rejects(loadPlanningAIConfig(configPath), error => error.code === 'ai_disabled');
});

function monthlyFixture() {
  const caption = (n, month) => adminPlanRow(n, [adminPlanInline('A'+n, '2026年'+month+'月份工作计划——项目部（示例专业）')]);
  const heading = n => adminPlanRow(n, [['B','事项'],['C','分项'],['D','完成标准'],['E','计划完成时间'],['F','主责人'],['G','当前工作进展与下步工作计划']].map(([col, text]) => adminPlanInline(col+n, text)));
  const date = (ref, value) => '<c r="'+ref+'" s="1"><v>'+excelDateSerial(value)+'</v></c>';
  return makeAdminPlanWorkbook([{name:'示例计划', xml:adminPlanSheet([
    caption(1,10), heading(2),
    adminPlanRow(3,[adminPlanInline('B3','示例区域'),adminPlanInline('C3','一标段'),'<c r="D3" t="s"><v>0</v></c>',date('E3','2026-10-15'),adminPlanInline('F3','匿名工作责任人'),adminPlanInline('G3','已完成47项')]),
    adminPlanRow(4,['<c r="A4" s="0"/>','<c r="B4" s="0"/>','<c r="C4" s="0"/>','<c r="D4" t="s"><v>1</v></c>',date('E4','2026-11-30')]),
    caption(8,11),heading(9),adminPlanRow(10,[adminPlanInline('B10','示例区域'),adminPlanInline('C10','二标段'),'<c r="D10" t="s"><v>2</v></c>',date('E10','2026-11-20')])
  ],['A1:G1','A8:G8','B3:B4','C3:C4'])}],{
    shared:'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>原始基准点移交完成</t></si><si><t>第二项真实工作 &lt;原文&gt;</t></si><si><t>十一月专属工作</t></si></sst>',
    styles:'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>'
  });
}

test('Excel自闭合空格不吞掉后续共享文字；月计划复用真实月份、合并分项和样式日期证据', async () => {
  const buffer=monthlyFixture(),files=decodePlanningAIFiles([file('示例11月计划.xlsx',buffer)]);
  const raw=await extractPlanningAIFiles(files),body=raw.parts.map(part=>part.text || '').join('\n');
  assert.match(body,/D4：第二项真实工作 <原文>/);assert.doesNotMatch(body,/A4：1(?:\t|\n)/);
  const extracted=await extractPlanningAIFiles(files,{months:['2026-10','2026-11']});
  assert.equal(extracted.monthlyRows.length,3);
  const october=extracted.monthlyRows.filter(row=>row.month==='2026-10');
  assert.deepEqual(october.map(row=>row.name),['原始基准点移交完成','第二项真实工作 <原文>']);
  assert.deepEqual(october.map(row=>row.due),['2026-10-15','2026-11-30']);
  assert.ok(october.every(row=>row.mod==='示例区域 / 一标段'));
  assert.equal(extracted.monthlyRows.find(row=>row.month==='2026-11').name,'十一月专属工作');
});

test('文字新月计划只接受本人明确内容与等价中文日期，旧进展和月计划不能混写', () => {
  const proposed=()=>({reply:'请核对月计划。',draft:{items:[],monthly_plan:{month:'2026-11',items:[{source_row_id:'',mod:'工程',name:'设备验收',due:'2026-11-20',progress:'',sources:['用户输入']}]}}});
  const monthly=content=>({plans:[{month:'2026-11',editable:true}],rows:[],messages:[{role:'user',content}]});
  for(const date of ['2026年11月20日','11月20日','2026/11/20','2026-11-20']){
    const value=proposed();assert.equal(validatePlanningAIOutput(value,[],['用户输入'],[],monthly('11月工程计划：设备验收，'+date+'完成')).draft.monthly_plan.items[0].due,'2026-11-20');
  }
  assert.throws(()=>validatePlanningAIOutput(proposed(),[],['用户输入'],[],monthly('工程设备验收，2025年11月20日完成')),status(502));
  assert.throws(()=>validatePlanningAIOutput(proposed(),[],['用户输入'],[],monthly('工程设备验收，日期待定')),status(502));
  const invented=proposed();invented.draft.monthly_plan.items[0].name='未提供的事项';assert.throws(()=>validatePlanningAIOutput(invented,[],['用户输入'],[],monthly('工程设备验收，11月20日完成')),status(502));
  const locked=monthly('工程设备验收，11月20日完成');locked.plans[0].editable=false;assert.throws(()=>validatePlanningAIOutput(proposed(),[],['用户输入'],[],locked),error=>error.code==='ai_monthly_plan_locked');
  const mixed=proposed();mixed.draft.items=[{id:'monthly:a',progress:'完成',sources:['用户输入']}];assert.throws(()=>validatePlanningAIOutput(mixed,[{id:'monthly:a'}],['用户输入'],[],monthly('工程设备验收，11月20日完成')),status(502));
});

test('附件已明确的其他专业不能写入本人月稿，景观表中的设计分类仍保留为景观工作', () => {
  const source='匿名计划.xlsx · 工作表景观';
  const monthly={line:'景观设计+工程',plans:[{month:'2026-11',editable:true}],messages:[],rows:[{row_id:'f0:2026-11:s0:r3',month:'2026-11',line_hint:'景观',mod:'设计',name:'公园专项汇报',standard:'',due:'2026-11-20',source}]};
  const draft=()=>({reply:'请核对本人景观月计划。',draft:{items:[],monthly_plan:{month:'2026-11',items:[{source_row_id:monthly.rows[0].row_id,mod:'',name:'',due:'',progress:'',sources:[source]}]}}});
  const accepted=validatePlanningAIOutput(draft(),[],[source],[],monthly);assert.equal(accepted.draft.monthly_plan.items[0].mod,'设计');
  monthly.rows[0].line_hint='机电';assert.throws(()=>validatePlanningAIOutput(draft(),[],[source],[],monthly),status(502));
  monthly.rows[0].line_hint='一标段';assert.equal(validatePlanningAIOutput(draft(),[],[source],[],monthly).draft.monthly_plan.items[0].name,'公园专项汇报');
  monthly.rows[0].due='';monthly.rows[0].due_note='公区10月20日；商业11月30日';
  const multiple=validatePlanningAIOutput(draft(),[],[source],[],monthly).draft.monthly_plan.items[0];assert.equal(multiple.due,'');assert.equal(multiple.name,'公园专项汇报\n原表完成时间：公区10月20日；商业11月30日');
});

test('空事项可整理附件到未确认月计划候选，返回前复查本人权限与确认锁，整个AI请求不写计划', async t => {
  const db=await initializedDatabase(),pool=testPool(db),admin=testPool(db,null);t.after(()=>db.close());await seedDemo(admin);
  const dir=await mkdtemp(path.join(os.tmpdir(),'planning-ai-monthly-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const configPath=path.join(dir,'provider.json');await writeFile(configPath,JSON.stringify({enabled:true,api_key:key,model:'deepseek-flash'}),{mode:0o600});
  const actor={id:'demo-pm-com'},request={project_id:'demo-com',line:'土建工程（东地块）',period:'2026-10-26',items:[],monthly_plans:[{month:'2026-10',items:[]},{month:'2026-11',items:[]}],messages:[{role:'user',content:'请阅读附件并整理，需要核对的地方请提示。'}],files:[file('示例11月计划.xlsx',monthlyFixture())]};
  const snapshot=async()=>(await admin.query("SELECT jsonb_build_object('plans',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.monthly_plans p),'reports',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.reports r)) AS data")).rows[0].data;
  const before=await snapshot();let calls=0;
  const reply=async(url,options)=>{
    calls++;const body=JSON.parse(options.body),context=JSON.parse(body.input[0].content);
    assert.match(body.instructions,/不要求items预先有事项/);assert.ok(context.monthly_plans.every(plan=>plan.editable));
    const rows=context.monthly_source_rows.filter(row=>row.month==='2026-10');assert.equal(rows.length,2);
    return response({reply:'已整理10月两项，第二项完成日期跨月，请核对后保存月草稿。',draft:{items:[],monthly_plan:{month:'2026-10',items:rows.map(row=>({source_row_id:row.row_id,mod:'',name:'',due:'',progress:'',sources:[row.source]}))}}});
  };
  const result=await planningAIChat(pool,actor,request,{configPath,fetchImpl:reply});
  assert.equal(result.draft.items.length,0);assert.deepEqual(result.draft.monthly_plan.items.map(row=>row.due),['2026-10-15','2026-11-30']);
  assert.ok(result.draft.monthly_plan.items.every(row=>!Object.hasOwn(row,'source_row_id')));assert.deepEqual(await snapshot(),before);
  const stale=async(url,options)=>{const result=await reply(url,options);await confirmMonthlyPlan(pool,actor,{project_id:request.project_id,line:request.line,month:'2026-10',items:[{mod:'原模块',name:'另一端刚确认的正式计划',due:'2026-10-31'}]});return result;};
  await assert.rejects(planningAIChat(pool,actor,request,{configPath,fetchImpl:stale}),error=>error.code==='ai_monthly_plan_locked');
  const count=(await admin.query("SELECT count(*)::int AS n FROM public.monthly_plans WHERE project_id='demo-com' AND plan_month='2026-10-01'")).rows[0].n;assert.equal(count,1);
  const noScope={...request,project_id:'demo-res'};await assert.rejects(planningAIChat(pool,actor,noScope,{configPath,fetchImpl:reply}),status(403));
  const wrongMonth={...request,monthly_plans:[{month:'2027-01',items:[]}]};await assert.rejects(planningAIChat(pool,actor,wrongMonth,{configPath,fetchImpl:reply}),error=>error.code==='ai_month_invalid');
  assert.equal(calls,2);
});

test('图片月计划事实必须来自本轮图片，任务清楚才可形成候选，原日期与正文月份不能编造',()=>{
 const source='匿名10月工作表.png · 图片';
 const facts=()=>({month:'2026-10',rows:[{source,line_hint:'',due_note:'',mod:'一标段',name:'完成材料封样',due:'2026-11-30',progress:'待封样',uncertain:false}],questions:[]});
 assert.equal(validateImageMonthExtraction(facts(),[source],'2026-10').rows[0].due,'2026-11-30');
 for(const change of [v=>v.rows[0].source='历史图片 · 图片',v=>v.month='2026-11',v=>v.rows[0].due='2026-02-30',v=>v.rows[0].name='',v=>v.rows[0].source_row_id='forged-cell']){
  const value=facts();change(value);assert.throws(()=>validateImageMonthExtraction(value,[source],'2026-10'),error=>error.code==='ai_image_plan_invalid');
 }
 assert.equal(monthlyPlanIntent('识别一下图片内容，并填报10月份工作计划'),true);
 assert.equal(monthlyPlanIntent('按照表格的事项填进当月计划'),true);
 assert.equal(monthlyPlanIntent('只整理已有事项本周进展'),false);
});

test('明确月计划从Excel零模型回填、图片单次视觉提取，旧client和确认锁给确切原因而非加载项目',async t=>{
 const db=await initializedDatabase(),pool=testPool(db),admin=testPool(db,null);t.after(()=>db.close());await seedDemo(admin);
 const dir=await mkdtemp(path.join(os.tmpdir(),'planning-image-month-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const configPath=path.join(dir,'provider.json');await writeFile(configPath,JSON.stringify({enabled:true,api_key:key,model:'deepseek-flash'}),{mode:0o600});
 const actor={id:'demo-pm-com'},request={project_id:'demo-com',line:'土建工程（东地块）',period:'2026-10-26',items:[],monthly_plans:[{month:'2026-10',items:[]},{month:'2026-11',items:[]}],messages:[{role:'assistant',content:'旧历史：事项为空，请先加载项目。'},{role:'user',content:'将表中10月份工作计划完整提取到本月草稿'}],files:[file('示例11月计划.xlsx',monthlyFixture())]};
 const before=(await admin.query('SELECT count(*)::int n FROM public.monthly_plans')).rows[0].n;let calls=0;
 const noProvider=()=>{calls++;throw new Error('structured source needs no model');};
 const excel=await planningAIChat(pool,actor,request,{configPath,fetchImpl:noProvider});
 assert.equal(calls,0);assert.equal(excel.draft.monthly_plan.items.length,2);assert.equal(excel.draft.monthly_plan.items[0].progress,'已完成47项');assert.equal(excel.draft.monthly_plan.items[1].due,'2026-11-30');assert.equal(excel.monthly_review.kind,'workbook');assert.doesNotMatch(excel.reply,/请先加载/);
 const legacy={...request};delete legacy.monthly_plans;
 await assert.rejects(planningAIChat(pool,actor,legacy,{configPath,fetchImpl:noProvider}),error=>error.code==='ai_client_update_required'&&/保存本机草稿.*刷新/.test(error.message));assert.equal(calls,0);
 await assert.rejects(planningAIChat(pool,actor,{...request,monthly_plans:[]},{configPath,fetchImpl:noProvider}),error=>error.code==='ai_monthly_context_missing');
 await assert.rejects(planningAIChat(pool,actor,{...request,messages:[{role:'user',content:'识别附件2027年10月份工作计划'}]},{configPath,fetchImpl:noProvider}),error=>error.code==='ai_month_invalid');assert.equal(calls,0);
 const source='匿名10月工作表.png · 图片',image={...request,files:[file('匿名10月工作表.png',png)],messages:[request.messages[0],{role:'user',content:'识别一下图片内容，并填报10月份工作计划'}]};
 const vision=async(url,options)=>{calls++;const body=JSON.parse(options.body);assert.equal(body.text.format.name,'planning_image_month_facts');assert.equal(body.input[0].content.filter(part=>part.type==='input_image').length,1);assert.ok(!JSON.stringify(body).includes('旧历史：'));return response({month:'2026-10',rows:[{source,line_hint:'',due_note:'',mod:'一标段',name:'完成材料封样',due:'2026-11-30',progress:'待封样',uncertain:false}],questions:[]});};
 const result=await planningAIChat(pool,actor,image,{configPath,fetchImpl:vision});assert.equal(calls,1);assert.equal(result.draft.monthly_plan.items[0].name,'完成材料封样');assert.equal(result.monthly_review.kind,'image');assert.match(result.monthly_review.note,/不是Excel单元格验证/);
 const unclear=await planningAIChat(pool,actor,image,{configPath,fetchImpl:async()=>response({month:'2026-10',rows:[{source,line_hint:'',due_note:'',mod:'一标段',name:'材料文字不清',due:'',progress:'',uncertain:true}],questions:['事项关键文字看不清，请补原文']})});assert.equal(unclear.draft.monthly_plan.items.length,0);assert.match(unclear.reply,/看不清/);
 assert.equal((await admin.query('SELECT count(*)::int n FROM public.monthly_plans')).rows[0].n,before);
 await assert.rejects(planningAIChat(pool,actor,image,{configPath,fetchImpl:async(...args)=>{const value=await vision(...args);await confirmMonthlyPlan(pool,actor,{project_id:request.project_id,line:request.line,month:'2026-10',items:[{mod:'原模块',name:'另一端确认',due:'2026-10-31'}]});return value;}}),error=>error.code==='ai_monthly_plan_locked');
 await assert.rejects(planningAIChat(pool,actor,{...image,monthly_plans:[]},{configPath,fetchImpl:noProvider}),error=>error.code==='ai_monthly_plan_locked'&&/已确认/.test(error.message));
});

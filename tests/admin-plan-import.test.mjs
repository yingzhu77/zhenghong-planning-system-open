import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAdminPlanImport, parseAdminPlanWorkbookBundle, ADMIN_PLAN_IMPORT_LIMITS, validateAdminPlanImportSize } from '../server/admin-plan-import.mjs';
import { readAdminPlanWorkbook } from '../server/admin-plan-import-xlsx.mjs';
import { detectAttachmentType, readOfficeParts, MAX_ATTACHMENT_BYTES } from '../server/attachment-types.mjs';

import { makeAdminPlanWorkbook as workbook, adminPlanSheet as sheet, adminPlanRow as row, adminPlanInline as inline, adminPlanNumber as number, adminPlanTitle as title, adminPlanHeaders as headers, excelDateSerial as serial, simpleAdminPlanSheet as simple } from './helpers/admin-plan-workbook.mjs';

const options = { name: '匿名月计划.xlsx', month: '2026-11' };

test('管理员Excel独立支持300MiB，忽略未使用图片的展开体积但保留原附件及XML安全边界', async () => {
  assert.equal(ADMIN_PLAN_IMPORT_LIMITS.fileBytes, 300 * 1024 * 1024);
  assert.equal(MAX_ATTACHMENT_BYTES, 8 * 1024 * 1024);
  assert.doesNotThrow(() => validateAdminPlanImportSize(ADMIN_PLAN_IMPORT_LIMITS.fileBytes));
  for (const size of [0, -1, NaN, ADMIN_PLAN_IMPORT_LIMITS.fileBytes + 1])
    assert.throws(() => validateAdminPlanImportSize(size), error => error.code === 'admin_plan_import_size');
  // A modest anonymous fixture crosses both old raw and expanded ZIP limits;
  // exact 300MiB boundaries above require no giant allocation.
  const bytes = workbook([{ name: '工程', xml: simple() }], { extra: [['xl/media/image1.png', Buffer.alloc(25 * 1024 * 1024)]] });
  assert.throws(() => detectAttachmentType(bytes, options.name), /8MiB/);
  assert.throws(() => readOfficeParts(bytes, '.xlsx'), /展开后过大/);
  const parsed = await parseAdminPlanImport(bytes, options);
  assert.equal(parsed.rows.length, 1); assert.equal(parsed.rows[0].name, '示例安装');
  const xml = workbook([{ name: '工程', xml: simple() }], { extra: [['xl/oversized.xml', Buffer.alloc(16 * 1024 * 1024 + 1, 32)]] });
  await assert.rejects(parseAdminPlanImport(xml, options), /展开后过大/);
  const macro = workbook([{ name: '工程', xml: simple() }], { extra: [['xl/media/vbaProject.png', Buffer.from('ignored media must not hide macro names')]] });
  await assert.rejects(parseAdminPlanImport(macro, options), /宏或加密/);
});

test('planned dates cannot be replaced by a later actual-completion column, and next-month coordination text is not an actual date',async()=>{
 const bytes=workbook([{name:'开发',xml:sheet([
  title(1,'2026年10月份'),row(2,[inline('A2','事项'),inline('B2','序号'),inline('C2','事项'),inline('D2','完成标准'),inline('E2','计划完成时间'),inline('F2','主责人'),inline('G2','完成时间'),inline('H2','完成情况')]),
  row(3,[number('B3',1),inline('C3','待完成的原始计划'),inline('D3','通过核对'),number('E3',serial('2026-10-25')),inline('H3','未完成')]),
  row(4,[number('B4',2),inline('C4','已有实际完成日的事项'),number('E4',serial('2026-10-15')),number('G4',serial('2026-10-18')),inline('H4','已完成，仍需人工核对')]),
  title(6,'2026年11月份'),row(7,[inline('A7','事项'),inline('B7','序号'),inline('C7','事项'),inline('D7','完成标准'),inline('E7','计划完成时间'),inline('F7','主责人'),inline('G7','需协调配合')]),
  row(8,[number('B8',1),inline('C8','下月原工作'),inline('E8','2026-11-25'),inline('G8','需其他专业配合')])
 ])}]);
 const bundle=await parseAdminPlanWorkbookBundle(bytes,{...options,month:'2026-10'}),[current,next]=bundle.batches;
 assert.deepEqual(current.rows.map(row=>row.due),['2026-10-25','2026-10-15']);assert.equal(current.rows[0].source_refs.due_cell,'s0!E3');assert.equal(current.rows[0].actual_due,'');
 assert.equal(current.rows[1].actual_due,'2026-10-18');assert.equal(current.rows[1].source_refs.actual_due_cell,'s0!G4');assert.equal(current.rows[1].progress,'已完成，仍需人工核对');
 assert.equal(next.rows[0].due,'2026-11-25');assert.equal(next.rows[0].actual_due,'');assert.equal(next.rows[0].actual_due_note,'');assert.equal(next.rows[0].progress,'');
 const reverse=workbook([{name:'工程',xml:sheet([title(1),row(2,[inline('C2','事项'),inline('D2','实际完成时间'),inline('E2','计划完成时间'),inline('F2','完成情况')]),row(3,[inline('C3','两类日期次序不同'),inline('D3','2026-11-28'),inline('E3','2026-11-20'),inline('F3','原完成情况')])])}]);
 const parsed=await parseAdminPlanImport(reverse,options);assert.equal(parsed.rows[0].due,'2026-11-20');assert.equal(parsed.rows[0].actual_due,'2026-11-28');
});

test('one upload previews this month/results and next month separately, retaining original progress cells instead of treating standards as achievements',async()=>{
 const head=(r,progress)=>row(r,[inline('A'+r,'模块'),inline('B'+r,'序号'),inline('C'+r,'事项'),inline('D'+r,'完成标准'),inline('E'+r,'计划完成时间'),inline('F'+r,progress),inline('H'+r,'主责人')]);
 const bytes=workbook([{name:'工程',xml:sheet([
  title(1,'2026年09月份'),head(2,'完成情况'),row(3,[number('B3',1),inline('C3','九月历史不能默认导入'),inline('E3','2026-11-30'),inline('F3','旧数据')]),
  title(5,'2026年10月份'),head(6,'工作完成情况'),row(7,[number('B7',1),inline('C7','十月具体任务'),inline('D7','目标验收标准'),inline('E7','2026-11-30'),inline('F7','只完成一部分，不代表已审核')]),
  title(9,'2026年11月份'),head(10,'实际完成情况'),row(11,[number('B11',1),inline('C11','十一月具体任务'),inline('D11','下月目标'),inline('E11','2026-10-31'),inline('F11','原表下月栏仍有原始备注')])
 ])}]);
 const bundle=await parseAdminPlanWorkbookBundle(bytes,{name:'匿名十一月会.xlsx',month:'2026-10'});
 assert.deepEqual(bundle.months,['2026-10','2026-11']);assert.equal(bundle.batches.length,2);assert.equal(bundle.unassigned_regions.length,0);
 const [oct,nov]=bundle.batches;assert.deepEqual(oct.rows.map(r=>r.name),['十月具体任务']);assert.deepEqual(nov.rows.map(r=>r.name),['十一月具体任务']);
 assert.equal(oct.rows[0].month,'2026-10');assert.equal(oct.rows[0].due,'2026-11-30');assert.equal(oct.rows[0].standard,'目标验收标准');assert.equal(oct.rows[0].progress,'只完成一部分，不代表已审核');assert.deepEqual(oct.rows[0].source_refs.progress_cells,['s0!F7']);
 assert.equal(nov.rows[0].due,'2026-10-31');assert.equal(nov.rows[0].progress,'原表下月栏仍有原始备注');assert.ok(oct.rows[0].progress_doc.ops.length);
});

test('completion header synonyms use only physical merged anchors and blank source month stays unassigned',async()=>{
 const names=['完成情况','计划完成情况','当前工作进展与下步工作计划','当前工作进展与下一步工作计划'];
 for(const caption of names){
  const bytes=workbook([{name:'工程',xml:sheet([title(1),row(2,[inline('B2','序号'),inline('C2','事项'),inline('D2','完成标准'),inline('E2','计划完成时间'),inline('G2',caption)]),
   row(3,[number('B3',1),inline('C3','合并进展甲'),inline('D3','验收标准不是实际完成'),inline('G3','实际原文')]),row(4,[number('B4',2),inline('C4','合并进展乙')]),row(5,[number('B5',3),inline('C5','合并之外空进展')])],['G3:G4'])}]);
  const parsed=await parseAdminPlanImport(bytes,{...options,evidence:true});assert.deepEqual(parsed.rows.map(r=>r.progress),['实际原文','实际原文','']);assert.deepEqual(parsed.rows[1].source_refs.progress_cells,['s0!G3']);
 }
 const noMonth=workbook([{name:'工程',xml:sheet([headers(1),row(2,[inline('C2','没有正文月份的任务'),inline('E2','2026-11-25')])])}]);
 const bundle=await parseAdminPlanWorkbookBundle(noMonth,{...options,name:'明确11月文件名.xlsx'});assert.ok(bundle.batches.every(batch=>batch.rows.length===0));assert.equal(bundle.unassigned_regions.length,1);assert.equal(bundle.unassigned_regions[0].month,null);
});

test('adjacent month bundle crosses the year using explicit body month, while cached/error result cells are never evaluated or invented',async()=>{
 const head=r=>row(r,[inline('C'+r,'事项'),inline('D'+r,'完成标准'),inline('E'+r,'计划完成时间'),inline('G'+r,'完成情况')]);
 const bytes=workbook([{name:'工程',xml:sheet([title(1,'12月份'),head(2),row(3,[inline('C3','十二月任务'),'<c r="G3"><f>REMOTE()</f></c>']),title(5,'1月份'),head(6),row(7,[inline('C7','次年一月任务'),'<c r="G7" t="e"><v>#REF!</v></c>'])])}]);
 const bundle=await parseAdminPlanWorkbookBundle(bytes,{...options,month:'2026-12'});assert.deepEqual(bundle.months,['2026-12','2027-01']);
 assert.ok(bundle.batches.every(batch=>JSON.stringify(batch.sheets[0].month_blocks.map(block=>block.month))===JSON.stringify(bundle.months)));
 assert.equal(bundle.batches[0].rows[0].name,'十二月任务');assert.equal(bundle.batches[1].rows[0].name,'次年一月任务');
 assert.ok(bundle.batches.every(batch=>batch.rows[0].progress===''&&batch.rows[0].warnings.some(w=>w.code==='progress_formula_unavailable')));
});

test('按每张工作表的明确月份块取计划，保留来源且跳过隐藏、汇总、空事项和历史', async () => {
  const grid = sheet([
    title(1, '2026年10月份'), headers(2), row(3, [number('B3', 1), inline('C3', '十月历史事项')]),
    row(4, [number('B4', 2), inline('C4', '编制11月份工作计划')]),
    title(5), headers(6),
    row(7, [inline('A7', '专业模块甲'), number('B7', 1), inline('C7', '十一月事项甲'), inline('D7', '验收完成'), number('E7', serial('2026-11-30')), inline('H7', '示例甲')]),
    row(8, [number('B8', 2), inline('C8', '十一月事项乙'), inline('E8', '2026/11/15'), inline('H8', '示例乙')]),
    row(9, [number('B9', 3), number('E9', serial('2026-11-20')), inline('H9', '空事项人员')]),
    row(10, [number('B10', 4), inline('C10', '合并范围之外事项'), inline('E10', '11月25日')]),
    row(11, [number('B11', 5), inline('C11', '隐藏行不导入')], ' hidden="1"'),
    row(12, [number('B12', 6), inline('C12', '12月份工作计划编制'), inline('E12', '11月29日')]),
    title(13, '2026年12月份'), headers(14), row(15, [number('B15', 1), inline('C15', '十二月事项')])
  ], ['A5:H5', 'A7:A9']);
  const bytes = workbook([{ name: '工程', xml: grid }, { name: '签字版计划汇总', xml: simple() }, { name: '备选项', state: 'hidden', xml: simple() }]);
  const actual = await parseAdminPlanImport(bytes, options);
  assert.deepEqual(actual.rows.map(item => item.name), ['十一月事项甲', '十一月事项乙', '合并范围之外事项', '12月份工作计划编制']);
  assert.deepEqual(actual.rows.map(item => item.mod), ['专业模块甲', '专业模块甲', '工程', '工程']);
  assert.deepEqual(actual.rows.map(item => item.due), ['2026-11-30', '2026-11-15', '2026-11-25', '2026-11-29']);
  assert.deepEqual(actual.rows[0].source, { sheet: '工程', row: 7, cell: 'C7' });
  assert.equal(actual.rows[0].standard, '验收完成'); assert.equal(actual.rows[0].reporter_hint, '示例甲');
  assert.equal(actual.ignored_empty, 1); assert.equal(actual.sheets[1].reason, 'auxiliary'); assert.equal(actual.sheets[2].reason, 'hidden');
  assert.deepEqual(actual.sheets[0].month_blocks.map(block => block.month), ['2026-10', '2026-11', '2026-12']);
  assert.equal(actual.rows[2].warnings[0].code, 'reporter_missing'); assert.match(actual.source.sha256, /^[a-f0-9]{64}$/);
});

test('sharedStrings和inline富文本仅解码实体一次，保留加粗标红并不生成HTML', async () => {
  const shared = '<sst><si><r><rPr><b/><color rgb="FFFF0000"/></rPr><t>  &lt;设备&gt;</t></r><r><t>&amp;lt; &#x4E2D; &quot;检查&quot; &#38;lt; &#x26;quot;  </t></r></si></sst>';
  const styles = '<styleSheet><fonts><font/><font><b/><color rgb="FFFF0000"/></font></fonts><cellXfs><xf fontId="0"/><xf fontId="1"/></cellXfs></styleSheet>';
  const bytes = workbook([{ name: '设计', xml: sheet([title(1), headers(2), row(3, [inline('A3', '设计', ' s="1"'), number('B3', 1), '<c r="C3" t="s"><v>0</v></c>', inline('E3', '2026-11-30'), inline('H3', '001测试甲')])]) }], { shared, styles });
  const actual = await parseAdminPlanImport(bytes, options), item = actual.rows[0];
  assert.equal(item.name, '<设备>&lt; 中 "检查" &lt; &quot;'); assert.equal(item.reporter_hint, '001测试甲');
  assert.deepEqual(item.name_doc, { ops: [{ insert: '<设备>', attributes: { bold: true, color: '#d81e06' } }, { insert: '&lt; 中 "检查" &lt; &quot;' }] });
  assert.deepEqual(item.mod_doc, { ops: [{ insert: '设计', attributes: { bold: true, color: '#d81e06' } }] });
  assert.equal(JSON.stringify(item).includes('<script>'), false);
});

test('兼容1904日期系统，公式仅读缓存，无缓存及无效日期明确提示', async () => {
  const bytes = workbook([{ name: '成本', xml: sheet([title(1), headers(2),
    row(3, [number('B3', 1), inline('C3', '缓存日期'), number('E3', serial('2026-11-30', true), 'DATE(2026,11,30)')]),
    row(4, [number('B4', 2), inline('C4', '无缓存日期'), '<c r="E4"><f>REMOTE()</f></c>']),
    row(5, [number('B5', 3), inline('C5', '错误日期'), inline('E5', '2026-11-31')]),
    row(6, [number('B6', 4), '<c r="C6" t="s"><f>REMOTE()</f></c>'])
  ]) }], { date1904: true });
  const actual = await parseAdminPlanImport(bytes, options);
  assert.equal(actual.rows.length, 3); assert.equal(actual.rows[0].due, '2026-11-30');
  assert.ok(actual.rows[0].warnings.some(warning => warning.code === 'formula_cached_only'));
  assert.equal(actual.rows[1].due, ''); assert.ok(actual.rows[1].warnings.some(warning => warning.code === 'formula_no_cache'));
  assert.equal(actual.rows[2].due, ''); assert.equal(actual.ignored_empty, 1);
  assert.ok(actual.warnings.some(warning => warning.code === 'formula_no_cache'));
  const leap = workbook([{ name: '工程', xml: sheet([title(1), headers(2), row(3, [inline('C3', '虚构闰日'), number('E3', 60)])]) }]);
  assert.equal((await parseAdminPlanImport(leap, options)).rows[0].due, '');
});

test('只按显式月份读取，缺少年份提示；选表不跳过隐藏限制', async () => {
  const bytes = workbook([{ name: '工程', xml: simple() }, { name: '成本', xml: simple() }, { name: '隐藏', state: 'veryHidden', xml: simple() }]);
  const selected = await parseAdminPlanImport(bytes, { ...options, sheets: ['成本', '隐藏'] });
  assert.equal(selected.rows.length, 1); assert.equal(selected.rows[0].source.sheet, '成本'); assert.equal(selected.sheets[2].reason, 'hidden');
  assert.equal((await parseAdminPlanImport(bytes, { ...options, month: '2026-10' })).rows.length, 0);
  await assert.rejects(parseAdminPlanImport(bytes, { ...options, sheets: ['不存在'] }), error => error.code === 'admin_plan_import_sheets');
  const noYear = workbook([{ name: '工程', xml: sheet([title(1, '11月份'), headers(2), row(3, [inline('C3', '无年份事项')])]) }]);
  assert.ok((await parseAdminPlanImport(noYear, options)).warnings.some(warning => warning.code === 'year_from_selection'));
});

test('安全边界拒绝DTD、宏包、重叠合并、畸形XML及超额结构，错误不泄露原始内容', async () => {
  const badXml = workbook([{ name: '工程', xml: '<!DOCTYPE worksheet [<!ENTITY secret "private-payload">]>' + simple() }]);
  await assert.rejects(parseAdminPlanImport(badXml, options), error => error.status === 400 && !error.message.includes('private-payload'));
  const macro = workbook([{ name: '工程', xml: simple() }], { extra: [['xl/vbaProject.bin', 'anonymous']] });
  await assert.rejects(parseAdminPlanImport(macro, options), error => error.status === 400);
  const overlap = workbook([{ name: '工程', xml: sheet([title(1), headers(2)], ['A3:A5', 'A4:B4']) }]);
  await assert.rejects(parseAdminPlanImport(overlap, options), /重叠合并/);
  const broken = workbook([{ name: '工程', xml: simple().replace('</worksheet>', '<private-payload>') }]);
  await assert.rejects(parseAdminPlanImport(broken, options), error => error.status === 400 && !error.message.includes('private-payload'));
  assert.throws(() => readAdminPlanWorkbook(workbook([{ name: '工程', xml: simple() }]), options, { ...ADMIN_PLAN_IMPORT_LIMITS, cells: 2 }), error => error.code === 'admin_plan_import_limit');
  const hugeMerge = workbook([{ name: '工程', xml: sheet([title(1), headers(2)], ['A3:A999999']) }]);
  await assert.rejects(parseAdminPlanImport(hugeMerge, options), error => error.code === 'admin_plan_import_limit');
});

test('worker入口限制类型、月份、文件大小并支持取消和超时', async () => {
  const bytes = workbook([{ name: '工程', xml: simple() }]), controller = new AbortController(); controller.abort();
  await assert.rejects(parseAdminPlanImport(bytes, { ...options, signal: controller.signal }), error => error.status === 499);
  await assert.rejects(parseAdminPlanImport(bytes, { ...options, timeoutMs: 1 }), error => error.status === 408);
  await assert.rejects(parseAdminPlanImport(bytes, { ...options, month: '2026-13' }), error => error.code === 'admin_plan_import_month');
  await assert.rejects(parseAdminPlanImport(bytes, { ...options, name: '旧表.xls' }), error => error.code === 'admin_plan_import_type');
  assert.throws(() => validateAdminPlanImportSize(ADMIN_PLAN_IMPORT_LIMITS.fileBytes + 1), error => error.code === 'admin_plan_import_size');
  const pending = new AbortController(), promise = parseAdminPlanImport(bytes, { ...options, signal: pending.signal }); pending.abort();
  await assert.rejects(promise, error => error.status === 499);
});

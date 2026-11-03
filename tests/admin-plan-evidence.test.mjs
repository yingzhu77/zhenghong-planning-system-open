import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAdminPlanEvidence, parseAdminPlanImport } from '../server/admin-plan-import.mjs';
import { makeAdminPlanWorkbook as workbook, adminPlanSheet as sheet, adminPlanRow as row, adminPlanInline as cell,
  adminPlanNumber as number, adminPlanTitle as title, adminPlanHeaders as headers, excelDateSerial as serial } from './helpers/admin-plan-workbook.mjs';

const options = { month: '2026-11', name: 'anonymous-evidence.xlsx' };
const item = (r, name, extra = []) => row(r, [number('B' + r, r), cell('C' + r, name), number('E' + r, serial('2026-11-25')), cell('H' + r, '匿名负责人'), ...extra]);

test('AI证据只包含所选月可见区域，历史、未来、隐藏和辅助表的正文不外发', async () => {
  const bytes = workbook([
    { name: '工程', xml: sheet([title(1, '2026年10月份'), headers(2), item(3, '历史私有正文'),
      title(5), headers(6), item(7, '本月可核对事项'), item(8, '隐藏行正文').replace('<row r="8"', '<row r="8" hidden="1"'),
      item(9, '编制12月份工作计划'), title(11, '2026年12月份'), headers(12), item(13, '未来私有正文')]) },
    { name: '仅十月', xml: sheet([title(1, '2026年10月份'), headers(2), item(3, '仅历史表的私有正文')]) },
    { name: '隐藏专业', state: 'hidden', xml: sheet([title(1), headers(2), item(3, '隐藏表正文')]) },
    { name: '签字版计划汇总', xml: sheet([title(1), headers(2), item(3, '辅助汇总正文')]) }
  ]);
  const parsed = await parseAdminPlanEvidence(bytes, options), raw = JSON.stringify(parsed.evidence);
  assert.equal(parsed.evidence.v, 1); assert.equal(parsed.evidence.month, '2026-11');
  assert.equal(parsed.evidence.regions.length, 1); assert.equal(parsed.evidence.regions[0].kind, 'strict_month_block');
  for (const forbidden of ['历史私有正文', '未来私有正文', '隐藏行正文', '仅历史表的私有正文', '隐藏表正文', '辅助汇总正文']) assert.equal(raw.includes(forbidden), false, forbidden);
  assert.match(raw, /本月可核对事项/); assert.match(raw, /编制12月份工作计划/);
  assert.deepEqual(parsed.evidence.rows, parsed.rows); assert.equal(parsed.rows.length, 2);
  const ordinary = await parseAdminPlanImport(bytes, options); assert.equal(Object.hasOwn(ordinary, 'evidence'), false);
  assert.deepEqual(parsed.rows.map(r => [r.name, r.due]), ordinary.rows.map(r => [r.name, r.due]));
});

test('明确标注其他月份的异形表不能伪装成无月份fallback区域', async () => {
  const bytes = workbook([{ name: '异形专业', xml: sheet([
    row(1, [cell('A1', '2026年10月')]), row(2, [cell('B2', '计划工作')]), row(3, [cell('B3', '明确属于十月的私有事项')])
  ]) }]);
  const parsed = await parseAdminPlanEvidence(bytes, options);
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.evidence.regions.length, 0);
  assert.equal(JSON.stringify(parsed.evidence).includes('明确属于十月的私有事项'), false);
});

test('无月份异形表保留未知状态；只有实际日期或日期格式数值可成为日期证据', async () => {
  const styles = '<styleSheet><fonts><font/></fonts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';
  const bytes = workbook([{ name: '待确认专业', xml: sheet([
    row(1, [cell('A1', '项目待安排工作')]), row(2, [cell('A2', '设备安装'), number('B2', 4), '<c r="C2" s="1"><v>' + serial('2026-11-25') + '</v></c>', cell('D2', '2026-11-26')])
  ]) }], { styles });
  const parsed = await parseAdminPlanEvidence(bytes, options), region = parsed.evidence.regions[0];
  assert.equal(parsed.rows.length, 0); assert.equal(region.kind, 'unverified_region'); assert.equal(region.month, null); assert.equal(region.month_cell, null);
  assert.equal(region.cells.find(c => c.cell === 'B2').date, '');
  assert.equal(region.cells.find(c => c.cell === 'C2').date, '2026-11-25'); assert.equal(region.cells.find(c => c.cell === 'D2').date, '2026-11-26');
  for (const source of region.cells) { assert.equal(source.id, region.sheet_id + '!' + source.cell); assert.ok(source.row >= region.bounds.start_row && source.row <= region.bounds.end_row); }
});

test('严格事项引用真实合并锚点并保留原富文本；不执行公式且错误单元格标为无效', async () => {
  const styles = '<styleSheet><fonts><font/><font><b/><color rgb="FFFF0000"/></font></fonts><cellXfs><xf fontId="0"/><xf fontId="1"/></cellXfs></styleSheet>';
  const bytes = workbook([{ name: '工程', xml: sheet([title(1), headers(2),
    item(3, '本月第一项', [cell('A3', '合并专业', ' s="1"')]), item(4, '本月第二项'),
    row(5, ['<c r="C5"><f>NETWORK()</f></c>']), row(6, ['<c r="J6" t="e"><f>ERROR()</f><v>#SPILL!</v></c>'])
  ], ['A3:A4']) }], { styles });
  const parsed = await parseAdminPlanEvidence(bytes, options), region = parsed.evidence.regions[0];
  assert.equal(parsed.rows.length, 2); assert.deepEqual(parsed.rows[1].source_refs.mod_cells, ['s0!A3']);
  const module = region.cells.find(c => c.cell === 'A3'); assert.equal(module.merge_anchor, 'A3');
  assert.deepEqual(module.doc.ops, [{ insert: '合并专业', attributes: { bold: true, color: '#d81e06' } }]);
  assert.equal(region.cells.some(c => c.cell === 'A4'), false); assert.equal(region.cells.some(c => c.cell === 'C5'), false);
  const invalid = region.cells.find(c => c.cell === 'J6'); assert.equal(invalid.invalid, true); assert.equal(invalid.date, '');
  for (const r of parsed.rows) {
    const refs = [...r.source_refs.name_cells, ...r.source_refs.standard_cells, ...r.source_refs.mod_cells, r.source_refs.due_cell].filter(Boolean);
    assert.ok(refs.every(id => region.cells.some(c => c.id === id)));
  }
});

test('可见事项的合并锚点位于隐藏行时拒绝证据，不静默泄露隐藏来源', async () => {
  const bytes = workbook([{ name: '工程', xml: sheet([title(1), headers(2),
    row(3, [cell('A3', '隐藏模块')], ' hidden="1"'), item(4, '可见事项')], ['A3:A4']) }]);
  await assert.rejects(parseAdminPlanEvidence(bytes, options), error => error.code === 'admin_plan_evidence_boundary');
});

test('公式错误值只能作为无效源单元格展示，不能进入严格计划事实', async () => {
  const bytes = workbook([{ name: '工程', xml: sheet([title(1), headers(2), row(3, [number('B3', 1),
    '<c r="C3" t="e"><f>ERROR()</f><v>#SPILL!</v></c>', cell('E3', '2026-11-25'), cell('H3', '匿名负责人')])]) }]);
  const parsed = await parseAdminPlanEvidence(bytes, options);
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.evidence.regions[0].cells.find(c => c.cell === 'C3').invalid, true);
  assert.ok(parsed.warnings.some(warning => /formula|invalid|error/.test(warning.code)));
});

test('重复月份表头缺少详情列名时只继承同表一致布局，不带入历史任务或冲突列', async () => {
  const repeatedHeaders = n => row(n, [cell('A' + n, '事项'), cell('B' + n, '序号'), cell('C' + n, '事项'), cell('D' + n, '完成标准'), cell('E' + n, '计划完成时间'), cell('H' + n, '主责人')]);
  const bytes = workbook([{ name: '设计', xml: sheet([
    title(1, '2026年10月份'), repeatedHeaders(2), item(3, '历史任务不得带入'), title(5),
    row(6, [cell('A6', '事项'), cell('B6', '序号')]),
    row(7, [cell('A7', '专项计划'), number('B7', 1), cell('C7', '本月真正任务'), cell('D7', '本月交付标准'), cell('E7', '2026-11-25')])
  ]) }]);
  const parsed = await parseAdminPlanEvidence(bytes, options);
  assert.equal(parsed.rows.length, 1); assert.equal(parsed.rows[0].name, '本月真正任务');
  assert.equal(parsed.rows[0].standard, '本月交付标准'); assert.equal(parsed.rows[0].line_hint, '设计');
  assert.equal(parsed.rows[0].due, '2026-11-25'); assert.equal(parsed.evidence.regions[0].structured, true);
  assert.ok(parsed.warnings.some(w => w.code === 'headers_inherited'));
  assert.equal(JSON.stringify(parsed.evidence).includes('历史任务不得带入'), false);
  const conflicting = workbook([{ name: '设计', xml: sheet([
    title(1, '2026年10月份'), repeatedHeaders(2), title(5), row(6, [cell('A6', '事项'), cell('B6', '序号'), cell('E6', '完成标准')]),
    row(7, [number('B7', 1), cell('C7', '不能按旧布局解释'), cell('E7', '新标准')])
  ]) }]);
  const rejected = await parseAdminPlanEvidence(conflicting, options);
  assert.equal(rejected.rows.length, 0); assert.equal(rejected.warnings.some(w => w.code === 'headers_inherited'), false);
});

test('事项分项标准型以逐行标准为任务，真实合并分组作模块且不无限前向填充', async () => {
  const bytes = workbook([{ name: '景观', xml: sheet([
    title(1), row(2, [cell('A2', '序号'), cell('B2', '事项'), cell('C2', '分项'), cell('D2', '完成标准'), cell('E2', '计划完成时间'), cell('F2', '主责人')]),
    row(3, [number('A3', 1), cell('B3', '匿名东区'), cell('C3', '一标段'), cell('D3', '基准点移交完成'), cell('E3', '11月15日前')]),
    row(4, [cell('D4', '材料定样完成'), cell('E4', '11月20日前')]),
    row(5, [cell('D5', '单独策划完成'), cell('E5', '11月下旬')]),
    row(6, [number('A6', 2), cell('B6', '设计'), cell('D6', '排版图完成'), cell('E6', '2026-11-30')])
  ], ['B3:B5', 'C3:C4']) }]);
  const parsed = await parseAdminPlanEvidence(bytes, options);
  assert.deepEqual(parsed.rows.map(r => r.name), ['基准点移交完成', '材料定样完成', '单独策划完成', '排版图完成']);
  assert.deepEqual(parsed.rows.map(r => r.mod), ['匿名东区 / 一标段', '匿名东区 / 一标段', '匿名东区', '设计']);
  assert.ok(parsed.rows.every(r => r.line_hint === '景观' && r.standard === ''));
  assert.deepEqual(parsed.rows.map(r => r.due), ['2026-11-15', '2026-11-20', '', '2026-11-30']);
  assert.deepEqual(parsed.rows[1].source_refs.mod_cells, ['s0!B3', 's0!C3']);
  assert.deepEqual(parsed.rows[2].source_refs.mod_cells, ['s0!B3']);
  assert.deepEqual(parsed.rows[1].source_refs.name_cells, ['s0!D4']);
});

test('合并事项列的可选子项为空仍保留真实部位和交付；独立重复列与继承部位不能造行', async()=>{
 const merged=workbook([{name:'幕墙施工',xml:sheet([
  title(1),row(2,[cell('A2','序号'),cell('B2','事项'),cell('D2','完成标准'),cell('E2','计划完成时间')]),
  row(3,[number('A3',1),cell('B3','匿名展馆'),cell('C3','外立面'),cell('D3','进场施工'),cell('E3','2026-11-25')]),
  row(4,[number('A4',2),cell('B4','匿名美术馆'),cell('D4','样板材料到场50%'),cell('E4','2026-11-30')]),
  row(5,[cell('D5','只有继承部位，不凭此造事项')])
 ],['B2:C2','B4:B5'])}]);
 const parsed=await parseAdminPlanEvidence(merged,options);
 assert.equal(parsed.rows.length,2);assert.equal(parsed.rows[1].name,'匿名美术馆');assert.equal(parsed.rows[1].standard,'样板材料到场50%');
 assert.deepEqual(parsed.rows[1].source_refs.name_cells,['s0!B4']);assert.equal(parsed.rows[1].line_hint,'幕墙施工');
 const separate=workbook([{name:'工程',xml:sheet([title(1),row(2,[cell('A2','事项'),cell('B2','序号'),cell('C2','事项'),cell('D2','完成标准'),cell('E2','计划完成时间')]),
  row(3,[cell('A3','分类'),number('B3',1),cell('D3','单有标准不视为任务')])])}]);
 assert.equal((await parseAdminPlanEvidence(separate,options)).rows.length,0);
});

test('一格多日期和文字工期保留原文，空日期与原文工期都不伪造单一截止日',async()=>{
 const raw='1、2026/11/10；2、2026/11/20；',bytes=workbook([{name:'精装设计',xml:sheet([title(1),headers(2),
  row(3,[number('B3',1),cell('C3','公区设计两子项'),cell('E3',raw)]),
  row(4,[number('B4',2),cell('C4','暂缓事项')]),
  row(5,[number('B5',3),cell('C5','单日期事项'),cell('E5','2026-11-25')])])}]);
 const {rows}=await parseAdminPlanEvidence(bytes,options);
 assert.equal(rows[0].due,'');assert.equal(rows[0].due_note,raw);assert.equal(rows[0].source_refs.due_cell,'s0!E3');
 assert.ok(rows[0].warnings.some(w=>w.code==='due_raw_preserved'));
 assert.equal(rows[1].due,'');assert.equal(rows[1].due_note,'');assert.equal(rows[2].due,'2026-11-25');assert.equal(rows[2].due_note,'');
});

// Anonymous OOXML fixtures deliberately cover structural edge cases. No real
// business workbook, uploaded person or source plan is checked into the repo.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(items) {
  const locals = [], central = []; let offset = 0;
  for (const [name, value] of items) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), rawName = Buffer.from(name), local = Buffer.alloc(30), entry = Buffer.alloc(46), crc = crc32(bytes);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(rawName.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(rawName.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, rawName, bytes); central.push(entry, rawName); offset += 30 + rawName.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (ref, text, more = '') => '<c r="' + ref + '" t="inlineStr"' + more + '><is><t xml:space="preserve">' + esc(text) + '</t></is></c>';
const number = (ref, value, formula = '') => '<c r="' + ref + '">' + (formula ? '<f>' + esc(formula) + '</f>' : '') + '<v>' + value + '</v></c>';
const row = (n, cells, more = '') => '<row r="' + n + '"' + more + '>' + cells.join('') + '</row>';
const title = (n, month = '2026年11月份') => row(n, [inline('A' + n, month + '工作计划——示例专业')]);
const headers = n => row(n, [inline('A' + n, '模块'), inline('B' + n, '序号'), inline('C' + n, '事项'), inline('D' + n, '完成标准'), inline('E' + n, '计划完成时间'), inline('F' + n, '实际完成时间'), inline('H' + n, '主责人')]);
const serial = (iso, date1904 = false) => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30)) / 86400000);
function sheet(rows, merges = []) {
  return '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rows.join('') + '</sheetData>'
    + (merges.length ? '<mergeCells>' + merges.map(ref => '<mergeCell ref="' + ref + '"/>').join('') + '</mergeCells>' : '') + '</worksheet>';
}
function workbook(sheets, { shared = '', styles = '', date1904 = false, extra = [] } = {}) {
  return zip([
    ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'],
    ['_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="' + Number(date1904) + '"/><sheets>' + sheets.map((s, i) => '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="s' + i + '"' + (s.state ? ' state="' + s.state + '"' : '') + '/>').join('') + '</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => '<Relationship Id="s' + i + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + i + '.xml"/>').join('') + '</Relationships>'],
    ...sheets.map((s, i) => ['xl/worksheets/sheet' + i + '.xml', s.xml]),
    ...(shared ? [['xl/sharedStrings.xml', shared]] : []), ...(styles ? [['xl/styles.xml', styles]] : []), ...extra
  ]);
}
const simple = () => sheet([title(1), headers(2), row(3, [inline('A3', '工程'), number('B3', 1), inline('C3', '示例安装'), number('E3', serial('2026-11-30')), inline('H3', '示例甲')])]);

export { workbook as makeAdminPlanWorkbook, sheet as adminPlanSheet, row as adminPlanRow, inline as adminPlanInline, number as adminPlanNumber, title as adminPlanTitle, headers as adminPlanHeaders, serial as excelDateSerial, simple as simpleAdminPlanSheet };

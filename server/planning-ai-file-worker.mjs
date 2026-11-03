import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { detectAttachmentType, readZip, xmlText } from './attachment-types.mjs';
import { readAdminPlanWorkbook } from './admin-plan-import-xlsx.mjs';

const { limits } = workerData;
let totalChars = 0;
const parts = [], sources = [], imageSources = [];
const monthlyRows = [];
function addText(source, text) {
  text = text.replace(/\u0000/g, '').trim();
  if (!text) return;
  totalChars += text.length;
  if (totalChars > limits.textChars) throw new Error('附件文字合计超过6万字，请分批或精简后上传');
  sources.push(source); parts.push({ type: 'input_text', text: '[' + source + ']\n' + text });
}
function rawXml(bytes) {
  // Validate encoding/entities with the existing attachment reader first. Strip
  // actual markup before decoding entities so escaped tags remain literal text.
  xmlText(bytes);
  return new TextDecoder(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8', { fatal: true }).decode(bytes);
}
function plain(xml) {
  const value = xml.replace(/<[^>]*>/g, '');
  return value ? xmlText(Buffer.from(value)) : '';
}
function nodes(xml, tag) {
  const pattern = new RegExp('<(?:[\\w.-]+:)?' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?' + tag + '\\s*>', 'g');
  return Array.from(xml.matchAll(pattern), match => match[1]);
}
async function pdf(file) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(file.buffer), verbosity: 0, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, enableXfa: false, stopAtErrors: true });
  try {
    const doc = await task.promise;
    if (doc.numPages > limits.pdfPages) throw new Error('PDF最多30页，请拆分后上传');
    const before = totalChars;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      try {
        const { items } = await page.getTextContent();
        const text = items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join('');
        if (!text.trim()) throw new Error('PDF含无法读取文字的扫描页，请将该页另存为图片上传');
        addText(file.name + ' · 第' + i + '页', text);
      } finally { page.cleanup(); }
    }
    if (totalChars === before) throw new Error('PDF没有可读取文字，请转为图片上传');
  } finally { await task.destroy(); }
}
function office(file, ext, fileIndex) {
  const zip = readZip(file.buffer);
  if (ext === '.docx') {
    const document = rawXml(zip.get('word/document.xml'));
    const paragraphs = nodes(document, 'p').map(paragraph => nodes(paragraph, 't').map(plain).join('')).join('\n');
    if (!paragraphs.trim()) throw new Error('Word正文没有可读取文字，内嵌图片请另存后上传');
    addText(file.name + ' · 正文', '（以下仅为Word正文文字，内嵌图片、页眉页脚和批注未读取）\n' + paragraphs);
    return;
  }
  const shared = zip.has('xl/sharedstrings.xml') ? nodes(rawXml(zip.get('xl/sharedstrings.xml')), 'si').map(item => nodes(item, 't').map(plain).join('')) : [];
  const workbook = rawXml(zip.get('xl/workbook.xml'));
  if (!zip.has('xl/_rels/workbook.xml.rels')) throw new Error('Excel工作表关联缺失，请重新导出');
  const attrs = tag => Object.fromEntries(Array.from(tag.matchAll(/\b([\w:]+)\s*=\s*(['"])(.*?)\2/g), match => [match[1], plain(match[3])]));
  const relations = new Map(Array.from(rawXml(zip.get('xl/_rels/workbook.xml.rels')).matchAll(/<(?:[\w.-]+:)?Relationship\b[^>]*>/g), match => { const a = attrs(match[0]); return [a.Id, a]; }));
  const sheets = Array.from(workbook.matchAll(/<(?:[\w.-]+:)?sheet\b[^>]*>/g), match => {
    const a = attrs(match[0]), relation = relations.get(a['r:id']);
    if (!relation || relation.TargetMode || !/\/worksheet$/.test(relation.Type || '') || !relation.Target || /[\\\u0000]/.test(relation.Target)) throw new Error('Excel工作表关联异常，请重新导出');
    let target;
    try { target = decodeURIComponent(relation.Target); } catch { throw new Error('Excel工作表路径异常，请重新导出'); }
    const key = path.posix.normalize(target.startsWith('/') ? target.slice(1) : 'xl/' + target).toLowerCase();
    if (!key.startsWith('xl/worksheets/') || !key.endsWith('.xml') || !zip.has(key)) throw new Error('Excel工作表内容缺失，请重新导出');
    return { key, name: a.name };
  });
  if (sheets.length > 20) throw new Error('Excel最多20个工作表，请精简后上传');
  let extracted = false;
  sheets.forEach((sheet, index) => {
    const xml = rawXml(zip.get(sheet.key));
    const rows = nodes(xml, 'row').map(row => Array.from(row.matchAll(/<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c\s*>)/g), match => {
      const type = /\bt=(['"])(.*?)\1/.exec(match[1])?.[2];
      const cellBody = match[2] || '';
      const value = nodes(cellBody, 'v')[0];
      const address = /\br=(['"])(.*?)\1/.exec(match[1])?.[2];
      const label = /^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address || '') ? address : '未标注坐标';
      let cached;
      if (match[2] === undefined) return label + '：';
      if (type === 's') { const n = Number(value); if (!Number.isInteger(n) || n < 0 || n >= shared.length) throw new Error('Excel共享文字索引损坏，请重新导出'); cached = shared[n]; }
      else if (type === 'inlineStr') cached = nodes(cellBody, 't').map(plain).join('');
      // Formulae are never evaluated. Cached raw values retain their actual
      // cell coordinates so sparse rows cannot shift into another column.
      else cached = value === undefined ? '' : plain(value);
      return label + '：' + cached;
    }).join('\t')).join('\n');
    if (rows.trim()) { extracted = true; addText(file.name + ' · 工作表' + (sheet.name || index + 1), '（以下为单元格缓存原值，未计算公式；日期序列数字和未缓存公式需人工核对）\n' + rows); }
  });
  if (!extracted) throw new Error('Excel没有可读取单元格，请检查文件内容');
  for (const month of workerData.months || []) {
    const parsed = readAdminPlanWorkbook(file.buffer, { name: file.name, month }, undefined, { evidence: true });
    for (const row of parsed.rows) {
      const region=parsed.evidence.regions.find(region=>region.id===row.region_id);
      const firstTask=Math.min(...parsed.rows.filter(item=>item.region_id===row.region_id).map(item=>item.source_row));
      const heading=region?.cells.find(cell=>cell.row<firstTask&&cell.text.length<50&&/当前.*进展|本期进展|当周进展|工作进展/.test(cell.text));
      let progressCell=heading&&region.cells.find(cell=>cell.row===row.source_row&&cell.column===heading.column);
      if(heading&&!progressCell){const merge=region.merges.find(merge=>merge.first.row<=row.source_row&&merge.last.row>=row.source_row&&merge.first.col===heading.column&&merge.last.col===heading.column);if(merge)progressCell=region.cells.find(cell=>cell.row===merge.first.row&&cell.column===heading.column);}
      monthlyRows.push({
      row_id: 'f' + fileIndex + ':' + month + ':' + row.id, month,
      mod: row.mod, name: row.name, standard: row.standard, due: row.due, due_note:row.due_note || '',
      progress:progressCell?.text || '',
      line_hint: row.line_hint,
      source: file.name + ' · 工作表' + row.source.sheet,
      source_row: row.source.row, warnings: row.warnings
    });}
  }
}
try {
  for (const [fileIndex, input] of workerData.files.entries()) {
    const file = { ...input, buffer: Buffer.from(input.buffer) };
    const detected = detectAttachmentType(file.buffer, file.name);
    if (detected.type.startsWith('image/')) {
      const source = file.name + ' · 图片'; sources.push(source);imageSources.push(source);
      parts.push({ type: 'input_text', text: '[' + source + ']' }, { type: 'input_image', image_url: 'data:' + detected.type + ';base64,' + file.buffer.toString('base64'), detail: 'high' });
    } else if (detected.ext === '.pdf') await pdf(file);
    else office(file, detected.ext, fileIndex);
  }
  parentPort.postMessage({ parts, sources, ...(imageSources.length?{imageSources}:{}), ...(workerData.months?.length ? { monthlyRows } : {}) });
} catch (error) {
  const known = error.status || /^(?:附件文字|PDF|Word|Excel)/.test(error.message);
  parentPort.postMessage({ error: known ? error.message : '附件解析失败，可能加密、损坏或格式不受支持，请重新导出' });
}

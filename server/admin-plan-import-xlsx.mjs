import path from 'node:path';
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { readOfficeParts, xmlText } from './attachment-types.mjs';
import { HttpError } from './errors.mjs';
import { ADMIN_PLAN_IMPORT_LIMITS, ADMIN_PLAN_EVIDENCE_LIMITS, validateAdminPlanImportOptions } from './admin-plan-import.mjs';
import { workbookProfessionHint } from './plan-professions.mjs';

const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const fail = (message, code = 'admin_plan_import_parse') => { throw new HttpError(400, message, code); };
const requireValue = (ok, message = 'Excel工作簿结构不正确，请重新另存后上传') => { if (!ok) fail(message); };
const normalized = value => String(value ?? '').replace(/[\s\u3000：:（）()]/g, '');
const auxiliary = /签字|汇总|总平图|图纸|上线节点|备选|reserved/i;
const parser = new XMLParser({
  ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false,
  trimValues: false, processEntities: false, maxNestedTags: 32,
  isArray: tag => ['sheet', 'Relationship', 'si', 'r', 'row', 'c', 'mergeCell', 'xf', 'font', 'numFmt'].includes(tag)
});

function readXml(bytes) {
  // xmlText decodes entities, so its return value must NOT be parsed as XML.
  // Parse original markup, then decode only extracted leaf values once.
  xmlText(bytes);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  return parser.parse(new TextDecoder(encoding, { fatal: true }).decode(bytes), true);
}
function leaf(value) {
  const raw = typeof value === 'object' && value !== null ? value['#text'] ?? '' : value ?? '';
  // Decode one XML reference at a time in a single pass. Chained replacements
  // would turn &#38;lt; into '<', although its literal cell text is '&lt;'.
  return String(raw).replace(/&(?:quot|apos|lt|gt|amp|#(?:[xX][\da-fA-F]+|\d+));/g, entity => {
    if (entity[1] !== '#') return { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' }[entity];
    const hex = entity[2].toLowerCase() === 'x', code = hex ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    requireValue(code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff), 'Excel包含不正确的文字编码');
    return String.fromCodePoint(code);
  });
}
function child(node, name) {
  if (!node || typeof node !== 'object') return undefined;
  const key = Object.keys(node).find(key => key === name || key.endsWith(':' + name));
  return key === undefined ? undefined : node[key];
}
function attr(node, name) {
  const key = node && Object.keys(node).find(key => key === '@_' + name || key.startsWith('@_') && key.endsWith(':' + name));
  return key ? leaf(node[key]) : '';
}
function root(doc, name) {
  const value = child(doc, name);
  requireValue(value && typeof value === 'object');
  return value;
}
function coordinate(ref) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref);
  requireValue(match, 'Excel存在不正确的单元格坐标');
  let col = 0;
  for (const char of match[1]) col = col * 26 + char.charCodeAt(0) - 64;
  return { row: Number(match[2]), col };
}
function columnName(col) {
  let name = '';
  while (col) { col--; name = String.fromCharCode(65 + col % 26) + name; col = Math.floor(col / 26); }
  return name;
}
function relationTarget(base, target) {
  requireValue(target && !/[\\\u0000?#]/.test(target) && !/^[a-z][a-z\d+.-]*:/i.test(target), 'Excel包含不支持的工作表引用');
  const resolved = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(base), target));
  requireValue(!resolved.startsWith('../') && !resolved.includes(':') && !resolved.startsWith('/'), 'Excel包含越界的工作表引用');
  return resolved.toLowerCase();
}
function relationships(entries, base) {
  const file = path.posix.join(path.posix.dirname(base), '_rels', path.posix.basename(base) + '.rels');
  const bytes = entries.get(file.toLowerCase());
  if (!bytes) return new Map();
  const map = new Map();
  for (const relation of array(child(root(readXml(bytes), 'Relationships'), 'Relationship'))) {
    const id = attr(relation, 'Id'), type = attr(relation, 'Type');
    requireValue(id && !map.has(id));
    // Never resolve URLs, hyperlinks or external workbook relationships.
    if (attr(relation, 'TargetMode').toLowerCase() === 'external') continue;
    map.set(id, { type, target: relationTarget(base, attr(relation, 'Target')) });
  }
  return map;
}
function fontAttributes(font) {
  const attrs = {};
  const bold = child(font, 'b');
  if (bold !== undefined && !['0', 'false'].includes(attr(bold, 'val'))) attrs.bold = true;
  const color = child(font, 'color'), rgb = attr(color, 'rgb').slice(-6).toLowerCase(), indexed = attr(color, 'indexed');
  if (/^[\da-f]{6}$/.test(rgb) && parseInt(rgb.slice(0, 2), 16) >= 128 && parseInt(rgb.slice(2, 4), 16) <= 100 && parseInt(rgb.slice(4), 16) <= 100 || ['2', '10'].includes(indexed)) attrs.color = '#d81e06';
  return attrs;
}
function richString(node, fallback = {}) {
  const runs = array(child(node, 'r'));
  if (!runs.length) return [{ insert: leaf(child(node, 't')), ...(Object.keys(fallback).length ? { attributes: fallback } : {}) }];
  return runs.map(run => {
    const properties = child(run, 'rPr'), attributes = { ...fallback, ...fontAttributes(properties) };
    if (child(properties, 'b') !== undefined && ['0', 'false'].includes(attr(child(properties, 'b'), 'val'))) delete attributes.bold;
    if (child(properties, 'color') !== undefined && !fontAttributes(properties).color) delete attributes.color;
    return { insert: leaf(child(run, 't')), ...(Object.keys(attributes).length ? { attributes } : {}) };
  });
}
function trimOps(ops) {
  const copy = ops.filter(op => op.insert).map(op => ({ ...op }));
  while (copy.length) { copy[0].insert = copy[0].insert.trimStart(); if (copy[0].insert) break; copy.shift(); }
  while (copy.length) { copy.at(-1).insert = copy.at(-1).insert.trimEnd(); if (copy.at(-1).insert) break; copy.pop(); }
  return copy;
}
function styledCell(cell, shared, styles, limits, accounting, dateStyles) {
  const type = attr(cell, 't'), style = Number(attr(cell, 's') || 0), fallback = styles[style] || {};
  const value = child(cell, 'v'), formula = child(cell, 'f') !== undefined;
  let ops;
  if (formula && value === undefined) ops = [{ insert: '' }];
  else if (type === 's') {
    const index = Number(leaf(value));
    requireValue(Number.isSafeInteger(index) && index >= 0 && shared[index], 'Excel共享文字引用不正确');
    ops = shared[index].map(op => ({ ...op, ...(Object.keys(fallback).length || op.attributes ? { attributes: { ...fallback, ...op.attributes } } : {}) }));
  } else if (type === 'inlineStr') ops = richString(child(cell, 'is'), fallback);
  else ops = [{ insert: leaf(value), ...(Object.keys(fallback).length ? { attributes: fallback } : {}) }];
  const text = ops.map(op => op.insert).join('');
  if (text.length > limits.cellChars || (accounting.chars += text.length) > limits.textChars) fail('Excel文字内容过长，请拆分后上传', 'admin_plan_import_limit');
  return { text, ops, type, formula, dateFormatted: dateStyles.has(style), missingFormulaResult: formula && value === undefined };
}
function worksheet(bytes, shared, styles, limits, accounting, dateStyles) {
  const sheet = root(readXml(bytes), 'worksheet'), rows = new Map(), cells = new Map(), rowHidden = new Set(), merges = [];
  const data = child(sheet, 'sheetData');
  for (const rowNode of array(child(data, 'row'))) {
    const row = Number(attr(rowNode, 'r'));
    requireValue(Number.isSafeInteger(row) && row > 0 && !rows.has(row), 'Excel行坐标重复或不正确');
    if (++accounting.rows > limits.rows) fail('Excel有效行数过多，请拆分后上传', 'admin_plan_import_limit');
    if (['1', 'true'].includes(attr(rowNode, 'hidden'))) rowHidden.add(row);
    const rowCells = new Map(); rows.set(row, rowCells);
    for (const cell of array(child(rowNode, 'c'))) {
      const ref = attr(cell, 'r'), at = coordinate(ref);
      requireValue(at.row === row && !rowCells.has(at.col), 'Excel单元格坐标重复或不正确');
      if (at.col > limits.columns || ++accounting.cells > limits.cells) fail('Excel单元格数量或列数过多，请拆分后上传', 'admin_plan_import_limit');
      const parsed = styledCell(cell, shared, styles, limits, accounting, dateStyles);
      rowCells.set(at.col, parsed); cells.set(ref, parsed);
    }
  }
  const merged = new Map(); let covered = 0;
  for (const node of array(child(child(sheet, 'mergeCells'), 'mergeCell'))) {
    if (merges.length >= limits.merges) fail('Excel合并区域过多，请拆分后上传', 'admin_plan_import_limit');
    const refs = attr(node, 'ref').split(':');
    requireValue(refs.length === 2, 'Excel合并范围不正确');
    const first = coordinate(refs[0]), last = coordinate(refs[1]);
    requireValue(first.row <= last.row && first.col <= last.col, 'Excel合并范围不正确');
    if (last.col > limits.columns || (covered += (last.row - first.row + 1) * (last.col - first.col + 1)) > limits.mergedCells)
      fail('Excel合并区域过大，请拆分后上传', 'admin_plan_import_limit');
    merges.push({ first, last });
    for (let r = first.row; r <= last.row; r++) for (let c = first.col; c <= last.col; c++) {
      const key = r + ':' + c;
      requireValue(!merged.has(key), 'Excel存在重叠合并区域，请修正后上传');
      merged.set(key, refs[0]);
    }
  }
  const at = (row, col) => {
    const ref = merged.get(row + ':' + col);
    return ref ? cells.get(ref) : rows.get(row)?.get(col);
  };
  return { rows, rowHidden, merges, at };
}
function monthAnchor(text, target) {
  const match = /^\s*(?:(\d{4}|\d{2})\s*年\s*)?(1[0-2]|0?[1-9])\s*月(?:份)?\s*(?:月度)?(?:工作)?计划/.exec(text);
  if (!match) return null;
  const year = match[1] ? Number(match[1]) + (match[1].length === 2 ? 2000 : 0) : Number(target.slice(0, 4));
  return { month: year + '-' + match[2].padStart(2, '0'), explicitYear: Boolean(match[1]) };
}
function evidenceMonthAnchor(text, target) {
  const plan = monthAnchor(text, target);
  if (plan) return plan;
  // Bare month headings still bound the source: an October-only sheet must
  // never become unverified November content simply because it lacks “计划”.
  const match = /^\s*(?:(\d{4}|\d{2})\s*年\s*)?(1[0-2]|0?[1-9])\s*月(?:份)?\s*$/.exec(text);
  if (!match) return null;
  const year = match[1] ? Number(match[1]) + (match[1].length === 2 ? 2000 : 0) : Number(target.slice(0, 4));
  return { month: year + '-' + match[2].padStart(2, '0'), explicitYear: Boolean(match[1]) };
}
function headerFields(grid, row) {
    const found = { row, nameCols: [] };
    let plannedDue, actualDue; const genericDates=[];
    const cols = new Set([...grid.rows.get(row).keys(), ...(grid.rows.get(row - 1)?.keys() || [])]);
    for(const merge of grid.merges)if(merge.first.row===row&&merge.last.row===row)for(let col=merge.first.col;col<=merge.last.col;col++)cols.add(col);
    for (const col of cols) {
      const text = normalized(grid.at(row, col)?.text), previous = normalized(grid.at(row - 1, col)?.text);
      if (/^(?:事项|事项内容|工作事项|计划内容|工作内容|任务内容)$/.test(text)) found.nameCols.push(col);
      if (/^(?:模块|专业|类别|工作类别|事项类别|模块或类别)$/.test(text)) found.mod = col;
      if (/^(?:分项|子项|工作分项)$/.test(text)) found.part = col;
      if (/^(?:完成标准|交付标准|完成目标|目标)$/.test(text)) found.standard = col;
      if (/^(?:(?:工作|计划|实际)?完成情况|本期进展|当周进展|当前工作进展(?:与下(?:一)?步工作计划)?)$/.test(text)) found.progress = col;
      if (/^(?:计划完成时间|计划完成日期|原计划完成时间|原计划完成日期|截止时间|截止日期|最晚完成时间)$/.test(text)
          || /^(?:计划|计划时间|计划日期)$/.test(text) && /完成时间|完成日期/.test(previous)) plannedDue=col;
      else if (/^(?:实际完成时间|实际完成日期|实际)$/.test(text) && (text!=='实际' || /完成时间|完成日期/.test(previous))) actualDue=col;
      else if (/^(?:完成时间|完成日期)$/.test(text)) genericDates.push(col);
      if (/^(?:主责人|责任人|负责人|责任人员|提报人|填报人)$/.test(text)) found.reporter = col;
      if (/^(?:序号|编号)$/.test(text)) found.sequence = col;
    }
    found.nameCols.sort((a, b) => a - b);
    if(plannedDue){found.due=plannedDue;found.actualDue=actualDue || genericDates.find(col=>col!==plannedDue);}
    else{if(genericDates.length===1)found.due=genericDates[0];if(actualDue)found.actualDue=actualDue;}
    if(found.nameCols.length>1 && grid.merges.some(m=>m.first.row===row&&m.last.row===row&&m.first.col===found.nameCols[0]&&m.last.col===found.nameCols.at(-1)))found.nameFallback=found.nameCols[0];
    return found;
}
function completeHeaders(found) {
  if (!found.nameCols.length || !found.due && !found.reporter && !found.standard) return null;
  const out = { ...found, name: found.nameCols.at(-1) };
  if (found.part && found.standard) {
    // “事项 / 分项 / 完成标准” uses the first columns as merged work
    // groups; the per-row deliverable is in 完成标准, not the group name.
    out.context = found.nameCols.at(-1); out.mod = found.part;
    out.name = found.standard; delete out.standard;
  } else if (!out.mod && found.nameCols.length > 1) out.mod = found.nameCols[0];
  out.score = 1 + Boolean(found.due) + Boolean(found.reporter) + Boolean(found.standard);
  return out;
}
function findHeaders(grid, start, end) {
  let best;
  const considered = [...grid.rows.keys()].filter(row => row > start && row < end && !grid.rowHidden.has(row)).sort((a, b) => a - b).slice(0, 8);
  for (const row of considered) {
    const fields = headerFields(grid, row); let found = completeHeaders(fields);
    if (fields.nameCols.length && fields.sequence) {
      // Some monthly templates leave the repeated detail-column captions blank.
      // Reuse only the latest explicit layout on this sheet, and only when the
      // remaining captions agree at the same coordinates. No prior data flows.
      const priorRows = [...grid.rows.keys()].filter(r => r < start && !grid.rowHidden.has(r)).sort((a, b) => b - a);
      const previous = priorRows.map(r => headerFields(grid, r)).find(v => completeHeaders(v));
      const keys = ['mod', 'part', 'due', 'reporter', 'standard', 'sequence', 'progress', 'actualDue'];
      if (previous && fields.nameCols.every(col => previous.nameCols.includes(col))
          && keys.every(key => !fields[key] || fields[key] === previous[key])) {
        const inherited = completeHeaders({ ...previous, ...fields, row, nameCols: previous.nameCols, inherited_from: previous.row });
        if(inherited && previous.actualDue && !fields.actualDue && normalized(grid.at(row,previous.actualDue)?.text))delete inherited.actualDue;
        if (inherited && (!found || inherited.score > found.score)) found = inherited;
      }
    }
    if (found && (!best || found.score >= best.score)) best = found;
  }
  return best;
}
function validDate(year, month, day) {
  const value = String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  const date = new Date(value + 'T00:00:00Z');
  return year >= 1900 && year <= 9999 && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
}
function dueDate(cell, month, date1904) {
  if (!cell?.text.trim() || cell.missingFormulaResult || cell.type === 'e') return '';
  const text = cell.text.trim();
  if (/^(?:n)?$/.test(cell.type) && /^\d+(?:\.\d+)?$/.test(text)) {
    const serial = Math.floor(Number(text));
    if (!date1904 && serial === 60 || !Number.isSafeInteger(serial) || serial < 0 || serial > 2958465) return '';
    const days = date1904 ? serial : serial < 60 ? serial + 1 : serial;
    const date = new Date(Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30) + days * 86400000);
    return Number.isFinite(date.getTime()) ? validDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()) : '';
  }
  let match = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})(?:日)?(?:前)?(?:T00:00:00(?:\.000)?Z?)?$/.exec(text);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[-/月.](\d{1,2})(?:日)?(?:前)?$/.exec(text);
  return match ? validDate(Number(month.slice(0, 4)), Number(match[1]), Number(match[2])) : '';
}
function lineHint(sheet, mod) {
  return workbookProfessionHint(sheet, mod);
}

function physicalRef(grid, row, col) {
  if (!col) return null;
  const merged = grid.merges.find(range => row >= range.first.row && row <= range.last.row && col >= range.first.col && col <= range.last.col);
  return columnName(merged ? merged.first.col : col) + (merged ? merged.first.row : row);
}
function evidenceRegion(grid, sheetId, sheetName, anchor, end, targetMonth, date1904, budget) {
  const visible = [...grid.rows].filter(([row]) => !grid.rowHidden.has(row) && row >= (anchor?.row || 1) && row < end);
  const nonempty = visible.filter(([, cells]) => [...cells.values()].some(cell => cell.text.trim()));
  if (!nonempty.length) return null;
  if (++budget.regions > ADMIN_PLAN_EVIDENCE_LIMITS.regions) fail('月份区块过多，请按月份或工作表拆分后使用AI', 'admin_plan_evidence_limit');
  const startRow = Math.min(...nonempty.map(([row]) => row)), endRow = Math.max(...nonempty.map(([row]) => row));
  const headers = anchor && findHeaders(grid, anchor.row, end), cells = [];
  for (const [row, columns] of nonempty) for (const [column, cell] of columns) {
    if (!cell.text.trim()) continue;
    if (++budget.cells > ADMIN_PLAN_EVIDENCE_LIMITS.cells || (budget.chars += cell.text.length) > ADMIN_PLAN_EVIDENCE_LIMITS.textChars)
      fail('本次AI识别内容过多，请按月份或工作表拆分；原文件与已有计划未改变', 'admin_plan_evidence_limit');
    const ref = columnName(column) + row, textDate = cell.type !== '' && cell.type !== 'n';
    const date = cell.dateFormatted || headers?.due === column || headers?.actualDue === column || textDate ? dueDate(cell, targetMonth, date1904) : '';
    const merged = grid.merges.find(range => row >= range.first.row && row <= range.last.row && column >= range.first.col && column <= range.last.col);
    cells.push({ id: sheetId + '!' + ref, cell: ref, row, column, text: cell.text.trim(), date,
      doc: { ops: trimOps(cell.ops) }, formula_cached: cell.formula && !cell.missingFormulaResult,
      invalid: cell.type === 'e' || cell.missingFormulaResult,
      ...(merged ? { merge_anchor: columnName(merged.first.col) + merged.first.row } : {}) });
  }
  return { id: sheetId + ':' + startRow + '-' + endRow, sheet_id: sheetId, sheet: sheetName,
    month: anchor ? targetMonth : null, month_cell: anchor?.cell || null,
    kind: anchor ? 'strict_month_block' : 'unverified_region', structured: Boolean(headers),
    bounds: { start_row: startRow, end_row: endRow, start_col: Math.min(...cells.map(cell => cell.column)), end_col: Math.max(...cells.map(cell => cell.column)) },
    merges: grid.merges.filter(range => range.last.row >= startRow && range.first.row <= endRow), cells };
}

// This adapter reads OOXML values only. It does not execute formulas, render
// media, visit links, infer identities, or mutate any plan.
export function readAdminPlanWorkbook(buffer, options, limits = ADMIN_PLAN_IMPORT_LIMITS, { evidence: includeEvidence = false } = {}) {
  const request = validateAdminPlanImportOptions(options), name = request.name;
  requireValue(Buffer.isBuffer(buffer) && buffer.length && buffer.length <= limits.fileBytes, 'Excel文件为空或超过300MiB');
  // Pictures are not plan cells. Leave their compressed bytes untouched while
  // retaining the existing XML expansion, row, cell and text protections.
  const entries = readOfficeParts(buffer, '.xlsx', {
    maxEntries: 16384,
    ignoreContent: name => /^(?:xl\/media\/[^/]+|docprops\/thumbnail)\.(?:png|jpe?g|gif|bmp|tiff?|emf|wmf|svg|webp|ico|heic|avif)$/.test(name)
  }), rootRelationships = relationships(entries, '');
  const office = [...rootRelationships.values()].find(relation => relation.type.endsWith('/officeDocument'));
  requireValue(office && entries.has(office.target), 'Excel缺少工作簿引用');
  const workbook = root(readXml(entries.get(office.target)), 'workbook'), relations = relationships(entries, office.target);
  const sheets = array(child(child(workbook, 'sheets'), 'sheet'));
  if (sheets.length > limits.sheets) fail('Excel工作表过多，请拆分后上传', 'admin_plan_import_limit');
  const accounting = { rows: 0, cells: 0, chars: 0 }, sharedRelation = [...relations.values()].find(relation => relation.type.endsWith('/sharedStrings'));
  const sharedBytes = entries.get(sharedRelation?.target || 'xl/sharedstrings.xml');
  const shared = sharedBytes ? array(child(root(readXml(sharedBytes), 'sst'), 'si')).map(node => richString(node)) : [];
  if (shared.length > limits.cells || shared.reduce((sum, ops) => sum + ops.reduce((n, op) => n + op.insert.length, 0), 0) > limits.textChars)
    fail('Excel共享文字过多，请拆分后上传', 'admin_plan_import_limit');
  const styleRelation = [...relations.values()].find(relation => relation.type.endsWith('/styles'));
  const styleBytes = entries.get(styleRelation?.target || 'xl/styles.xml');
  let styles = []; const dateStyles = new Set();
  if (styleBytes) {
    const style = root(readXml(styleBytes), 'styleSheet'), fonts = array(child(child(style, 'fonts'), 'font')).map(fontAttributes);
    const formats = new Map(array(child(child(style, 'numFmts'), 'numFmt')).map(node => [Number(attr(node, 'numFmtId')), attr(node, 'formatCode')]));
    styles = array(child(child(style, 'cellXfs'), 'xf')).map((xf, index) => {
      const formatId = Number(attr(xf, 'numFmtId') || 0), format = (formats.get(formatId) || '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
      if (formatId >= 14 && formatId <= 22 || formatId >= 27 && formatId <= 36 || formatId >= 50 && formatId <= 58 || /y|m[^;]*d|d[^;]*m/i.test(format)) dateStyles.add(index);
      return fonts[Number(attr(xf, 'fontId') || 0)] || {};
    });
  }
  const date1904 = ['1', 'true'].includes(attr(child(workbook, 'workbookPr'), 'date1904'));
  const result = { month: request.month, source: { name, sha256: createHash('sha256').update(buffer).digest('hex') }, sheets: [], rows: [], warnings: [], ignored_empty: 0 };
  const evidence = includeEvidence ? { v: 1, source: result.source, month: request.month, sheets: [], regions: [], rows: result.rows, warnings: result.warnings } : null;
  const evidenceBudget = { regions: 0, cells: 0, chars: 0 };
  const selected = request.sheets && new Set(request.sheets), seenSheets = new Set();
  for (const [sheetIndex, node] of sheets.entries()) {
    const sheetId = 's' + sheetIndex;
    const sheetName = attr(node, 'name'), state = attr(node, 'state') || 'visible';
    requireValue(sheetName && !seenSheets.has(sheetName), 'Excel工作表名称为空或重复'); seenSheets.add(sheetName);
    const info = { name: sheetName, state, status: 'skipped', reason: '', rows: 0, ignored_empty: 0, month_blocks: [] };
    result.sheets.push(info);
    if (state !== 'visible') { info.reason = 'hidden'; continue; }
    if (selected && !selected.has(sheetName)) { info.reason = 'not_selected'; continue; }
    if (!selected && auxiliary.test(sheetName)) { info.reason = 'auxiliary'; continue; }
    const relation = relations.get(attr(node, 'id'));
    requireValue(relation?.type.endsWith('/worksheet') && entries.has(relation.target), 'Excel工作表引用缺失或无效');
    const grid = worksheet(entries.get(relation.target), shared, styles, limits, accounting, dateStyles), anchors = [];
    for (const [row, cells] of [...grid.rows].sort((a, b) => a[0] - b[0])) {
      if (grid.rowHidden.has(row)) continue;
      const nonempty = [...cells].filter(([, cell]) => cell.text.trim());
      // Titles start in the first column or span a horizontal merged heading.
      // A task mentioning another month's work plan must not split the block.
      if (nonempty.length > 3 || nonempty.some(([, cell]) => /^\d+(?:\.\d+)?$/.test(cell.text.trim()))) continue;
      const candidate = nonempty.filter(([col]) => col === 1 || col <= 3 && grid.merges.some(merge => merge.first.row === row && merge.first.col === col && merge.last.col - col >= 2))
        .map(([col, cell]) => { const found = (includeEvidence ? evidenceMonthAnchor : monthAnchor)(cell.text, request.month); return found ? { ...found, cell: columnName(col) + row } : null; }).find(Boolean);
      if (candidate) anchors.push({ ...candidate, row });
    }
    const matches = anchors.filter(anchor => anchor.month === request.month);
    info.month_blocks = anchors.map(anchor => ({ month: anchor.month, row: anchor.row, explicit_year: anchor.explicitYear }));
    if (evidence) {
      evidence.sheets.push({ id: sheetId, name: sheetName, state });
      // A known historical month is never offered as an unverified fallback.
      const regions = anchors.length ? matches.map(anchor => evidenceRegion(grid, sheetId, sheetName, anchor, anchors.find(next => next.row > anchor.row)?.row ?? Infinity, request.month, date1904, evidenceBudget))
        : [evidenceRegion(grid, sheetId, sheetName, null, Infinity, request.month, date1904, evidenceBudget)];
      evidence.regions.push(...regions.filter(Boolean));
    }
    if (!matches.length) { info.reason = 'month_not_found'; continue; }
    info.status = 'parsed';
    for (const anchor of matches) {
      const end = anchors.find(next => next.row > anchor.row)?.row ?? Infinity, headers = findHeaders(grid, anchor.row, end);
      if (!headers) { result.warnings.push({ code: 'headers_not_found', message: '月份区块未识别到事项及计划列，已跳过', source: { sheet: sheetName, row: anchor.row, cell: 'A' + anchor.row } }); continue; }
      if (headers.inherited_from) result.warnings.push({ code: 'headers_inherited', message: '重复表头部分为空，按同表前一组一致列位置识别，请核对事项与日期', source: { sheet: sheetName, row: headers.row, cell: columnName(headers.name) + headers.row } });
      if (!anchor.explicitYear) result.warnings.push({ code: 'year_from_selection', message: '月份标题未注明年份，按所选年份解析，请核对', source: { sheet: sheetName, row: anchor.row, cell: 'A' + anchor.row } });
      for (const row of [...grid.rows.keys()].filter(row => row > headers.row && row < end).sort((a, b) => a - b)) {
        if (grid.rowHidden.has(row)) continue;
        const standardCell = grid.at(row, headers.standard), moduleCell = grid.at(row, headers.mod);
        let nameColumn=headers.name,itemCell=grid.at(row,nameColumn);
        // A horizontally merged 事项 caption may contain a location and an
        // optional subitem. A physical location + deliverable is still a task
        // when the subitem is blank; separate duplicate captions do not qualify.
        if(!itemCell?.text.trim()&&headers.nameFallback&&standardCell?.text.trim()&&grid.rows.get(row)?.get(headers.nameFallback)?.text.trim()){
          nameColumn=headers.nameFallback;itemCell=grid.at(row,nameColumn);
        }
        const itemName = itemCell?.text.trim() || '', source = { sheet: sheetName, row, cell: columnName(nameColumn) + row };
        if (!itemName || itemCell.missingFormulaResult || itemCell.type === 'e') {
          info.ignored_empty++; result.ignored_empty++;
          if (itemCell?.missingFormulaResult) result.warnings.push({ code: 'formula_no_cache', message: '事项公式没有缓存结果，未导入该行', source });
          if (itemCell?.type === 'e') result.warnings.push({ code: 'formula_error', message: '事项单元格为Excel错误结果，请修复来源；该行未作为计划导入', source });
          continue;
        }
        if (headers.sequence) {
          const sequence = grid.at(row, headers.sequence)?.text.trim();
          if (sequence && !/^\d+(?:\.\d+)?$/.test(sequence)) { result.warnings.push({ code: 'non_item_row', message: '非事项序号行已跳过，请核对来源', source }); continue; }
        }
        const contextCell = grid.at(row, headers.context);
        const moduleParts = [contextCell, moduleCell].filter((cell, index, parts) => cell?.text.trim() && parts.findIndex(p => p?.text.trim() === cell.text.trim()) === index);
        const mod = moduleParts.map(cell => cell.text.trim()).join(' / ') || lineHint(sheetName, ''), nameOps = trimOps(itemCell.ops);
        const modOps = moduleParts.length ? moduleParts.flatMap((cell, i) => [...(i ? [{ insert: ' / ' }] : []), ...trimOps(cell.ops)]) : [{ insert: mod }];
        const dueCell = grid.at(row, headers.due), actualDueCell=grid.at(row,headers.actualDue), reporter = grid.at(row, headers.reporter), progressCell = grid.at(row, headers.progress), due = dueDate(dueCell, request.month, date1904), warnings = [];
        const actual_due=dueDate(actualDueCell,request.month,date1904),actual_due_note=!actual_due && actualDueCell?.type!=='e' && !actualDueCell?.missingFormulaResult?actualDueCell?.text.trim() || '':'';
        const progress = progressCell?.type === 'e' || progressCell?.missingFormulaResult ? '' : progressCell?.text.trim() || '';
        const due_note = !due && dueCell?.type !== 'e' && !dueCell?.missingFormulaResult ? dueCell?.text.trim() || '' : '';
        if (!due) warnings.push(due_note
          ? { code: 'due_raw_preserved', message: '原表完成时间含多日期或文字说明，已保留原文；不强制归成一个截止日，可留空导入' }
          : { code: 'due_missing_or_invalid', message: '原表未设置可用完成日期，可留空导入，后续再补充' });
        if (!reporter?.text.trim()) warnings.push({ code: 'reporter_missing', message: '负责人为空，需要按专业或手动分配' });
        if ([itemCell, dueCell, actualDueCell, reporter, standardCell, moduleCell, contextCell, progressCell].some(cell => cell?.formula)) warnings.push({ code: 'formula_cached_only', message: '公式仅使用文件缓存结果，未重新计算，请核对' });
        if (progressCell?.missingFormulaResult || progressCell?.type === 'e') warnings.push({ code: 'progress_formula_unavailable', message: '原表完成情况公式没有可用缓存结果，未补造进展，请核对来源' });
        if (dueCell?.missingFormulaResult || dueCell?.type === 'e') warnings.push({ code: 'formula_no_cache', message: '完成时间公式没有可用缓存结果，请补充' });
        if (due && due.slice(0, 7) !== request.month) warnings.push({ code: 'due_outside_month', message: '完成时间不在所选月份，请核对' });
        const parsedRow = { month: request.month, mod, name: itemName, due, due_note, actual_due, actual_due_note, progress, progress_doc: { ops: progress ? trimOps(progressCell.ops) : [] }, reporter_hint: reporter?.text.trim() || '', line_hint: lineHint(sheetName, moduleCell?.text.trim() || ''),
          standard: standardCell?.text.trim() || '', name_doc: { ops: nameOps }, mod_doc: { ops: modOps }, source, warnings };
        if (evidence) {
          const region = evidence.regions.find(region => region.sheet_id === sheetId && row >= region.bounds.start_row && row <= region.bounds.end_row);
          const ref = col => { const cell = physicalRef(grid, row, col); return cell ? sheetId + '!' + cell : null; };
          Object.assign(parsedRow, { id: sheetId + ':r' + row, region_id: region.id, source_row: row,
            source_refs: { name_cells: [ref(nameColumn)], standard_cells: headers.standard && standardCell?.text.trim() ? [ref(headers.standard)] : [],
              mod_cells: [...new Set([headers.context && contextCell?.text.trim() ? ref(headers.context) : null, headers.mod && moduleCell?.text.trim() ? ref(headers.mod) : null].filter(Boolean))], progress_cells: progress ? [ref(headers.progress)] : [], due_cell: dueCell?.text.trim() ? ref(headers.due) : null, actual_due_cell:actualDueCell?.text.trim()?ref(headers.actualDue):null } });
          const visibleCells = new Set(region.cells.map(cell => cell.id));
          const refs = [...parsedRow.source_refs.name_cells, ...parsedRow.source_refs.standard_cells, ...parsedRow.source_refs.mod_cells, ...parsedRow.source_refs.progress_cells, parsedRow.source_refs.due_cell,parsedRow.source_refs.actual_due_cell].filter(Boolean);
          if (refs.some(id => !visibleCells.has(id))) fail('合并内容跨越月份或隐藏区域，请调整来源表后重新识别；已有计划未改变', 'admin_plan_evidence_boundary');
        }
        result.rows.push(parsedRow);
        info.rows++;
        if (result.rows.length > limits.items) fail('可导入事项超过2000项，请按专业或工作表拆分', 'admin_plan_import_limit');
      }
    }
  }
  if (selected && [...selected].some(sheet => !seenSheets.has(sheet))) fail('选择的工作表不存在，请重新解析', 'admin_plan_import_sheets');
  if (!result.rows.length) result.warnings.push({ code: 'no_plan_rows', message: '未识别到所选月份的有效事项；请检查月份标题、事项列及工作表选择' });
  if (evidence) result.evidence = evidence;
  return result;
}

// A meeting workbook normally holds this month's plan/results and next month's
// plan. Keep the two source blocks separate; deadlines never choose a block.
export function readAdminPlanWorkbookBundle(buffer, options, limits = ADMIN_PLAN_IMPORT_LIMITS) {
  const request=validateAdminPlanImportOptions(options), next=new Date(request.month+'-01T00:00:00Z');
  next.setUTCMonth(next.getUTCMonth()+1);
  const months=[request.month,next.toISOString().slice(0,7)];
  const batches=months.map(month=>readAdminPlanWorkbook(buffer,{...request,month},limits,{evidence:true}));
  // Unspecified years use one meeting reference year. At Dec/Jan only the
  // adjacent January belongs to the next year; do not relabel December merely
  // because the second bounded parse uses January's year as its target.
  const contextualMonth=block=>block.explicit_year?block.month:months.find(month=>month.slice(5)===block.month.slice(5))||request.month.slice(0,4)+block.month.slice(4);
  for(const batch of batches)for(const sheet of batch.sheets)for(const block of sheet.month_blocks)block.month=contextualMonth(block);
  const unassigned=new Map();
  for(const batch of batches)for(const region of batch.evidence.regions)if(region.kind==='unverified_region')unassigned.set(region.id,region);
  return {month:request.month,next_month:months[1],months,source:batches[0].source,batches,unassigned_regions:[...unassigned.values()]};
}

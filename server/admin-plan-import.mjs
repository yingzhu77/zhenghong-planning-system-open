import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { HttpError } from './errors.mjs';

export const ADMIN_PLAN_IMPORT_LIMITS = Object.freeze({
  fileBytes: 300 * 1024 * 1024, sheets: 64, cells: 100000,
  rows: 15000, columns: 256, merges: 10000, mergedCells: 200000,
  items: 2000, textChars: 1000000, cellChars: 20000
});
export const ADMIN_PLAN_EVIDENCE_LIMITS = Object.freeze({ regions: 128, cells: 12000, textChars: 180000 });

export function validateAdminPlanImportSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > ADMIN_PLAN_IMPORT_LIMITS.fileBytes)
    throw new HttpError(400, 'Excel文件为空或超过300MiB，请精简后上传', 'admin_plan_import_size');
}

export function validateAdminPlanImportOptions({ name = '月度计划.xlsx', month, sheets } = {}) {
  if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(name) || path.extname(name).toLowerCase() !== '.xlsx')
    throw new HttpError(400, '请上传Excel .xlsx文件，旧版文件请先另存为.xlsx', 'admin_plan_import_type');
  if (typeof month !== 'string' || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new HttpError(400, '请选择有效的计划月份', 'admin_plan_import_month');
  if (sheets !== undefined && (!Array.isArray(sheets) || !sheets.length || sheets.length > ADMIN_PLAN_IMPORT_LIMITS.sheets
      || sheets.some(sheet => typeof sheet !== 'string' || !sheet || sheet.length > 100 || /[\u0000-\u001f\u007f]/.test(sheet)) || new Set(sheets).size !== sheets.length))
    throw new HttpError(400, '选择的工作表不正确', 'admin_plan_import_sheets');
  return { name, month, ...(sheets === undefined ? {} : { sheets }) };
}

// Uploaded workbooks are transient. Parsing has no database, filesystem or AI
// side effects, and runs outside the HTTP event loop with bounded memory/time.
export async function parseAdminPlanWorkbook(buffer, { signal, timeoutMs = 30000, evidence = false, includeNext = false, ...options } = {}) {
  const request = validateAdminPlanImportOptions(options);
  if (!(Buffer.isBuffer(buffer) || buffer instanceof Uint8Array))
    throw new HttpError(400, '请选择Excel文件', 'admin_plan_import_size');
  validateAdminPlanImportSize(buffer.length);
  if (signal?.aborted) throw new HttpError(499, '已取消解析，原计划未改变', 'admin_plan_import_cancelled');
  const worker = new Worker(new URL('./admin-plan-import-worker.mjs', import.meta.url), {
    workerData: { buffer, options: request, limits: ADMIN_PLAN_IMPORT_LIMITS, evidence: evidence === true, includeNext: includeNext === true },
    execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')),
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 }, stdout: true, stderr: true
  });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new HttpError(499, '已取消解析，原计划未改变', 'admin_plan_import_cancelled'));
    const timer = setTimeout(() => finish(new HttpError(408, 'Excel解析超时，请缩小文件后重试', 'admin_plan_import_timeout')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    worker.once('message', result => result.error
      ? finish(new HttpError(400, result.error.message, result.error.code)) : finish(null, result));
    worker.once('error', () => finish(new HttpError(400, 'Excel解析失败，请重新导出后上传', 'admin_plan_import_parse')));
    worker.once('exit', () => { if (!settled) finish(new HttpError(400, 'Excel解析提前结束，请精简后重试', 'admin_plan_import_parse')); });
  });
}

export const parseAdminPlanImport = parseAdminPlanWorkbook;
export const parseAdminPlanEvidence = (buffer, options) => parseAdminPlanWorkbook(buffer, { ...options, evidence: true });
export const parseAdminPlanWorkbookBundle = (buffer, options) => parseAdminPlanWorkbook(buffer, { ...options, includeNext: true, evidence: true });

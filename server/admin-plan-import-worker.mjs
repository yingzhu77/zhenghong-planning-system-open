import { parentPort, workerData } from 'node:worker_threads';
import { readAdminPlanWorkbook, readAdminPlanWorkbookBundle } from './admin-plan-import-xlsx.mjs';
import { HttpError } from './errors.mjs';

try {
  const read=workerData.includeNext ? readAdminPlanWorkbookBundle : readAdminPlanWorkbook;
  // Worker data is already cloned; retain its backing store instead of copying
  // another 300MiB just to expose the Buffer read methods.
  const bytes = workerData.buffer;
  parentPort.postMessage(read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), workerData.options, workerData.limits, { evidence: workerData.evidence === true }));
} catch (error) {
  // Parser diagnostics can contain uploaded XML. Return only our bounded,
  // deliberate messages; never echo dependency errors or workbook fragments.
  parentPort.postMessage({ error: error instanceof HttpError
    ? { message: error.message, code: error.code }
    : { message: 'Excel内容无法读取，请重新另存为.xlsx后上传', code: 'admin_plan_import_parse' } });
}

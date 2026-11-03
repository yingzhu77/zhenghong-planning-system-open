import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { HttpError } from './errors.mjs';
import { MAX_ATTACHMENT_BYTES } from './attachment-types.mjs';

export const AI_FILE_LIMITS = Object.freeze({ count: 4, fileBytes: MAX_ATTACHMENT_BYTES, totalBytes: 12 * 1024 * 1024, textChars: 60000, pdfPages: 30 });

export function decodePlanningAIFiles(files = []) {
  if (!Array.isArray(files) || files.length > AI_FILE_LIMITS.count) throw new HttpError(400, '每次最多上传4份附件', 'ai_attachment_limit');
  let size = 0;
  return files.map(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).some(key => !['name', 'data_base64'].includes(key)) || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(file.name)) throw new HttpError(400, 'AI附件名称不正确', 'ai_attachment_invalid');
    if (!['.pdf', '.docx', '.xlsx', '.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(path.extname(file.name).toLowerCase())) throw new HttpError(400, 'AI附件支持PDF、Word(.docx)、Excel(.xlsx)和静态图片；旧版Office请先另存', 'ai_attachment_type');
    const encoded = file.data_base64;
    if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(AI_FILE_LIMITS.fileBytes / 3) * 4 || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new HttpError(400, '附件编码不正确或单份超过8MiB', 'ai_attachment_invalid');
    const buffer = Buffer.from(encoded, 'base64');
    if (!buffer.length || buffer.length > AI_FILE_LIMITS.fileBytes || buffer.toString('base64') !== encoded) throw new HttpError(400, '附件编码不正确或单份超过8MiB', 'ai_attachment_invalid');
    size += buffer.length;
    if (size > AI_FILE_LIMITS.totalBytes) throw new HttpError(413, 'AI附件合计不能超过12MiB', 'ai_attachment_limit');
    return { name: file.name, buffer };
  });
}

// Parsing untrusted PDF/Office data runs off the HTTP event loop and is killed
// on timeout/abort; no file is persisted and no parser receives a file URL.
export async function extractPlanningAIFiles(files, { signal, timeoutMs = 10000, months = [] } = {}) {
  if (!files.length) return { parts: [], sources: [] };
  if (signal?.aborted) throw new HttpError(499, '已取消整理，原输入保留', 'ai_cancelled');
  const worker = new Worker(new URL('./planning-ai-file-worker.mjs', import.meta.url), {
    workerData: { files, limits: AI_FILE_LIMITS, months }, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    stdout: true, stderr: true
  });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate();
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(new HttpError(499, '已取消整理，原输入保留', 'ai_cancelled'));
    const timer = setTimeout(() => finish(new HttpError(408, '附件解析超时，请缩小文件后重试', 'ai_attachment_timeout')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    worker.once('message', result => result.error ? finish(new HttpError(400, result.error, 'ai_attachment_parse')) : finish(null, result));
    worker.once('error', () => finish(new HttpError(400, '附件解析失败，请重新导出后上传', 'ai_attachment_parse')));
    worker.once('exit', () => { if (!settled) finish(new HttpError(400, '附件解析提前结束，请缩小文件后重试', 'ai_attachment_parse')); });
  });
}

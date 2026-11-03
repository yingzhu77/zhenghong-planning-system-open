import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { HttpError } from './errors.mjs';
import { getProfile, withIdentity } from './database.mjs';
import { withManagementRead } from './management-read.mjs';

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export function storagePath(value) {
  if (typeof value !== 'string' || value.length > 400 || value.includes('\\') || value.includes('\0')) throw new HttpError(400, '文件路径不正确');
  const parts = value.split('/');
  if (parts.length !== 3 || parts[0] !== 'drawings' || !parts.every((p) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(p)) || parts.some((p) => p === '..' || p === '.')) throw new HttpError(400, '文件路径不正确');
  return { relative: parts.join('/'), projectId: parts[1] };
}
export function imageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { type: 'image/png', ext: '.png' };
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return { type: 'image/jpeg', ext: '.jpg' };
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return { type: 'image/gif', ext: '.gif' };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return { type: 'image/webp', ext: '.webp' };
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString() === '%PDF-') return { type: 'application/pdf', ext: '.pdf' };
  throw new HttpError(400, '仅支持PNG、JPEG、GIF、WebP或PDF文件');
}

// The small, bounded upload has only two fields. Parse as bytes to preserve image
// data; never use filenames from the multipart headers as filesystem paths.
export function parseUpload(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  const boundary = match?.[1] || match?.[2];
  if (!boundary || boundary.length > 70 || /[\r\n]/.test(boundary)) throw new HttpError(400, '上传格式不正确');
  const marker = Buffer.from('--' + boundary), result = {};
  let at = buffer.indexOf(marker), parts = 0;
  if (at !== 0) throw new HttpError(400, '上传内容不完整');
  while (at >= 0) {
    let start = at + marker.length;
    if (buffer.subarray(start, start + 2).toString() === '--') break;
    if (buffer.subarray(start, start + 2).toString() !== '\r\n') throw new HttpError(400, '上传分隔符不正确');
    start += 2;
    const endHeaders = buffer.indexOf(Buffer.from('\r\n\r\n'), start);
    if (endHeaders < 0 || endHeaders - start > 8192) throw new HttpError(400, '上传字段头不正确');
    const header = buffer.subarray(start, endHeaders).toString('utf8');
    const name = /(?:^|;)\s*name="([^"]+)"/.exec(header.match(/content-disposition:([^\r\n]+)/i)?.[1] || '')?.[1];
    const next = buffer.indexOf(Buffer.from('\r\n--' + boundary), endHeaders + 4);
    if (next < 0) throw new HttpError(400, '上传内容不完整');
    const value = buffer.subarray(endHeaders + 4, next);
    if (!['path', 'file'].includes(name) || result[name] !== undefined || ++parts > 2) throw new HttpError(400, '上传字段不正确');
    if (name === 'path') {
      if (value.length > 400) throw new HttpError(400, '文件路径过长');
      result.path = value.toString('utf8');
    } else result.file = value;
    at = next + 2;
  }
  if (!result.path || !result.file?.length) throw new HttpError(400, '缺少上传文件或路径');
  if (result.file.length > MAX_FILE_BYTES) throw new HttpError(413, '单个文件不能超过8MB');
  return result;
}

export async function saveUpload(pool, user, uploadDir, body, contentType) {
  const parsed = parseUpload(body, contentType), key = storagePath(parsed.path), detected = imageType(parsed.file);
  const suffix = path.extname(key.relative).toLowerCase();
  if (!(detected.ext === '.jpg' ? ['.jpg', '.jpeg'] : [detected.ext]).includes(suffix)) throw new HttpError(400, '文件扩展名与实际格式不一致');
  await withIdentity(pool, user.id, async (client) => {
    const profile = await getProfile(client, user.id);
    if (profile?.status !== 'approved' || !['ops', 'president'].includes(profile.role)) throw new HttpError(403, '仅运营管理员或总裁可上传图纸');
    if (!(await client.query('SELECT id FROM public.projects WHERE id=$1', [key.projectId])).rows.length) throw new HttpError(403, '无权访问此项目');
  });
  const absolute = path.join(uploadDir, ...key.relative.split('/'));
  await mkdir(path.dirname(absolute), { recursive: true });
  try { await writeFile(absolute, parsed.file, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') throw new HttpError(409, '文件已存在，请重新选择后上传'); throw error; }
  return { path: key.relative, url: '/api/files/' + key.relative.split('/').map(encodeURIComponent).join('/') };
}

export async function loadFile(pool, user, uploadDir, name) {
  const key = storagePath(name);
  await withManagementRead(pool, user, async (client) => {
    if (!(await client.query('SELECT id FROM public.project_drawings WHERE project_id=$1 AND path=$2', [key.projectId, key.relative])).rows.length) throw new HttpError(404, '文件不存在或无权访问');
  });
  let buffer;
  try { buffer = await readFile(path.join(uploadDir, ...key.relative.split('/'))); }
  catch (error) { if (error.code === 'ENOENT') throw new HttpError(404, '文件不存在'); throw error; }
  return { buffer, type: imageType(buffer).type, name: path.basename(key.relative) };
}

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getProfile, withIdentity } from './database.mjs';
import { HttpError } from './errors.mjs';
import { detectAttachmentType, MAX_ATTACHMENT_BYTES } from './attachment-types.mjs';
import { resolveWritableBusinessLine } from './commercial-modules.mjs';
import { resolveReportScope } from './report-scopes.mjs';

export const MAX_REPORT_ATTACHMENTS = 20;
export const MAX_REPORT_ATTACHMENT_BYTES = 40 * 1024 * 1024;
export const MAX_DRAFT_ATTACHMENTS = 100;
export const MAX_DRAFT_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const columns = 'a.id,a.project_id,a.period,a.line,a.owner_id,a.name,a.mime,a.size,a.created_at,a.report_scope_id,a.scope_project_ids,a.scope_week,EXISTS(SELECT 1 FROM public.report_attachment_links ref_link WHERE ref_link.attachment_id=a.id) AS referenced';
const inline = mime => mime.startsWith('image/') || mime === 'application/pdf';
function metadata(row) { return { ...row, referenced: !!row.referenced, url: '/api/report-attachments/' + row.id, inline: inline(row.mime) }; }
function storagePath(uploadDir, id, key) {
  if (!/^report-attachments\/[0-9a-f-]{36}\.(?:jpg|png|gif|webp|pdf|docx?|xlsx?)$/.test(key) || !key.startsWith('report-attachments/' + id + '.')) throw new HttpError(500, '附件存储记录不正确', 'attachment_storage_invalid');
  return path.join(uploadDir, key);
}
function text(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, label + '格式不正确');
  return value;
}
function identifier(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw new HttpError(400, '附件标识不正确');
  return value.toLowerCase();
}
function identifiers(value, limit = 200) {
  if (!Array.isArray(value) || value.length > limit) throw new HttpError(400, '附件列表数量或格式不正确');
  const result = value.map(identifier);
  if (new Set(result).size !== result.length) throw new HttpError(400, '附件列表不能重复');
  return result;
}
function reportIdentifier(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'number' && !Number.isSafeInteger(value))
    || !/^[1-9]\d{0,18}$/.test(String(value)) || BigInt(value) > 9223372036854775807n) throw new HttpError(400, '报告标识不正确');
  return String(value);
}
async function approvedProfile(client, userId,projectId) {
  const profile = await getProfile(client, userId,{project_id:projectId});
  if (profile?.status !== 'approved' || !['pm','ops','president','pzo'].includes(profile.role)) throw new HttpError(403, '账号无权访问填报附件');
  return profile;
}
async function requireProject(client, pid) {
  const project = (await client.query('SELECT id,project_type FROM public.projects WHERE id=$1', [pid])).rows[0];
  if (!project) throw new HttpError(403, '未分配此项目或无权访问');
  return project;
}

// The raw body is one file, not a multipart bundle. Browser MIME is deliberately
// ignored; accepted formats come from the file's bytes and its display name.
export async function uploadReportAttachment(pool, user, uploadDir, input, body, contentType) {
  if (!object(input) || Object.keys(input).some(key => !['project_id','period','line','filename','report_scope_id'].includes(key))) throw new HttpError(400, '附件上传信息不正确');
  const pid = text(input.project_id, '项目', 200), period = text(input.period, '填报周期', 100), line = text(input.line, '填报模块', 100);
  const name = text(input.filename, '文件名', 255);
  if (/[\\/]/.test(name)) throw new HttpError(400, '文件名不可包含路径');
  if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, '请选择非空附件');
  if (body.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, '单份附件不能超过 8MiB');
  const id = randomUUID();
  let absolute, created = false;
  try {
    return await withIdentity(pool, user.id, async client => {
      const profile = await approvedProfile(client, user.id,pid);
      if (profile.role !== 'pm') throw new HttpError(403, '仅填报人可上传本人的报告附件');
      const project = await requireProject(client, pid);
      if (project.project_type === 'com') resolveWritableBusinessLine(profile, line, pid);
      const allowed = (await client.query('SELECT app_private.can_write_report($1,$2,$3) AS allowed', [pid,line,user.id])).rows[0]?.allowed;
      if (!allowed) throw new HttpError(403, '只能上传本人获授权项目和填报模块的附件');
      const scopeRow = { project_id: pid, line, ...(input.report_scope_id ? { report_scope_id: text(input.report_scope_id,'填报范围',200) } : {}) };
      if (input.report_scope_id) {
        const professional = (await client.query("SELECT COALESCE(to_jsonb(s)->>'reporting_mode','comprehensive') AS mode FROM app_private.report_scopes s WHERE id=$1", [scopeRow.report_scope_id])).rows[0]?.mode === 'professional';
        // Comprehensive scopes historically permit another authorized person
        // to keep an unreferenced attachment draft. Their report remains owned
        // by its original author. Professional scopes use the exact report.
        const existing = professional ? (await client.query('SELECT * FROM public.reports WHERE project_id=$1 AND period=$2 AND line=$3 AND author_id=$4', [pid,period,line,user.id])).rows[0] : null;
        if (existing && existing.author_id !== user.id) throw new HttpError(403, '只能上传本人报告的附件');
        await resolveReportScope(client,user,scopeRow,existing,period,pid);
      }
      const usage = (await client.query('SELECT * FROM app_private.lock_report_attachment_draft_usage()')).rows[0];
      if (Number(usage.draft_count) + 1 > MAX_DRAFT_ATTACHMENTS || Number(usage.draft_bytes) + body.length > MAX_DRAFT_ATTACHMENT_BYTES) throw new HttpError(413, '本人草稿附件已达100件或200MiB上限，请先清理未提交的附件', 'draft_storage_limit');
      const detected = detectAttachmentType(body, name);
      const storageKey = 'report-attachments/' + id + detected.ext;
      absolute = path.join(uploadDir, 'report-attachments', id + detected.ext);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, body, { flag: 'wx', mode: 0o600 }); created = true;
      const saved = (await client.query('INSERT INTO public.report_attachments(id,project_id,period,line,owner_id,name,mime,size,storage_key,report_scope_id,scope_project_ids,scope_week) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,project_id,period,line,owner_id,name,mime,size,created_at,report_scope_id,scope_project_ids,scope_week',
        [id,pid,period,line,user.id,name,detected.type,body.length,storageKey,scopeRow.report_scope_id || null,scopeRow.scope_project_ids || null,scopeRow.scope_week || null])).rows[0];
      return metadata(saved);
    });
  } catch (error) {
    if (created) {
      try { await unlink(absolute); }
      catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          const failure = new HttpError(500, '附件登记失败且临时文件清理失败，请联系管理员', 'attachment_cleanup_failed');
          failure.cause = error; failure.cleanupCause = cleanupError; throw failure;
        }
      }
    }
    throw error;
  }
}

export async function loadReportAttachment(pool, user, uploadDir, inputId, options = {}) {
  const id = identifier(inputId);
  const row = await withIdentity(pool, user.id, async client => {
    await approvedProfile(client, user.id);
    return (await client.query('SELECT ' + columns + ',a.storage_key FROM public.report_attachments a WHERE a.id=$1', [id])).rows[0];
  });
  if (!row) throw new HttpError(404, '附件不存在或无权访问');
  try {
    const result = { type: row.mime, name: row.name, inline: inline(row.mime), size: row.size };
    const absolute = storagePath(uploadDir,id,row.storage_key);
    if (options.stream) {
      const file = await open(absolute, 'r');
      return { ...result, stream: file.createReadStream() };
    }
    return { ...result, buffer: await readFile(absolute) };
  }
  catch (error) { if (error.code === 'ENOENT') throw new HttpError(404, '附件文件不存在'); throw error; }
}

export async function discardReportAttachment(pool, user, uploadDir, input) {
  if (!object(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input,'id')) throw new HttpError(400, '草稿附件丢弃请求不正确');
  const id = identifier(input.id);
  let key;
  try {
    key = await withIdentity(pool,user.id,async client => {
      const profile = await approvedProfile(client,user.id);
      if (profile.role !== 'pm') throw new HttpError(403, '仅填报人可丢弃本人的草稿附件');
      const result = (await client.query('SELECT app_private.discard_report_attachment($1::uuid) AS storage_key',[id])).rows[0]?.storage_key;
      if (!result) throw new HttpError(404, '草稿附件不存在或无权清理');
      // Validate the persisted key while the transaction can still roll back.
      storagePath(uploadDir,id,result);
      return result;
    });
  } catch (error) {
    if (error.code === 'P0001' && error.message === 'Report attachment already has a submitted reference') throw new HttpError(409, '该附件已被已提交或历史报告引用，不能删除', 'attachment_referenced');
    throw error;
  }
  // Metadata deletion commits before unlink. A concurrent report can therefore
  // never bind a file that this code is about to remove.
  try { await unlink(storagePath(uploadDir,id,key)); }
  catch (error) {
    if (error.code !== 'ENOENT') {
      const failure = new HttpError(500, '草稿记录已移除，但文件清理失败，请联系管理员', 'attachment_cleanup_failed');
      failure.cause = error; failure.cleanupPhase = 'discard-file'; failure.attachmentId = id;
      throw failure;
    }
  }
  return { id, discarded: true };
}

export async function discardInaccessibleReportDrafts(pool, user, uploadDir) {
  const rows = await withIdentity(pool,user.id,async client => {
    const profile = await approvedProfile(client,user.id);
    if (profile.role !== 'pm') throw new HttpError(403, '仅填报人可清理本人的失去权限草稿');
    const found = (await client.query('SELECT * FROM app_private.discard_inaccessible_report_drafts()')).rows;
    for (const row of found) storagePath(uploadDir,row.attachment_id,row.storage_key);
    return found;
  });
  const result = { discarded_count: rows.length, freed_bytes: rows.reduce((sum,row)=>sum+row.freed_size,0) };
  const failures = [];
  for (const row of rows) {
    try { await unlink(storagePath(uploadDir,row.attachment_id,row.storage_key)); }
    catch (error) {
      if (error.code !== 'ENOENT') failures.push({ attachmentId: row.attachment_id, code: error.code || error.name });
    }
  }
  if (failures.length) {
    const error = new HttpError(500, '草稿额度已释放，但部分文件清理失败，请联系管理员', 'attachment_cleanup_failed');
    error.cleanupPhase = 'discard-inaccessible-files'; error.cleanupFailures = failures;
    error.attachmentId = failures[0].attachmentId; error.cause = { code: failures[0].code };
    error.discardedCount = result.discarded_count; error.freedBytes = result.freed_bytes;
    throw error;
  }
  return result;
}

export async function listReportAttachments(pool, user, input = {}) {
  if (!object(input) || Object.keys(input).some(key => !['project_id','period','line','report_id','report_ids','ids','limit','offset','report_scope_id'].includes(key))) throw new HttpError(400, '附件查询不正确');
  const request = {};
  for (const [key,label,limit] of [['project_id','项目',200],['period','填报周期',100],['line','填报模块',100]]) if (input[key] !== undefined) request[key] = text(input[key],label,limit);
  if (input.report_scope_id !== undefined) request.report_scope_id = text(input.report_scope_id,'填报范围',200);
  if (input.ids !== undefined) request.ids = identifiers(input.ids);
  if (input.report_id !== undefined) request.report_ids = [reportIdentifier(input.report_id)];
  if (input.report_ids !== undefined) {
    if (request.report_ids || !Array.isArray(input.report_ids) || input.report_ids.length > 100) throw new HttpError(400, '报告列表不正确');
    request.report_ids = [...new Set(input.report_ids.map(reportIdentifier))];
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500)) throw new HttpError(400, '附件分页数量须为1至500');
  if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.limit === undefined)) throw new HttpError(400, '附件分页位置不正确');
  if (!request.project_id && !request.ids && !request.report_ids) throw new HttpError(400, '请按项目、报告或附件标识查询');
  return withIdentity(pool, user.id, async client => {
    await approvedProfile(client, user.id);
    if (request.project_id) await requireProject(client, request.project_id);
    if (request.ids?.length === 0 || request.report_ids?.length === 0) return [];
    const values = [], conditions = [], param = value => { values.push(value); return '$' + values.length; };
    if (request.report_scope_id) conditions.push('a.report_scope_id=' + param(request.report_scope_id));
    else if (request.project_id && !request.ids && !request.report_ids) conditions.push('a.report_scope_id IS NULL');
    for (const key of ['project_id','period','line']) if (request[key] !== undefined) conditions.push('a.' + key + '=' + param(request[key]));
    if (request.ids) conditions.push('a.id=ANY(' + param(request.ids) + '::uuid[])');
    if (request.report_ids) conditions.push('EXISTS(SELECT 1 FROM public.report_attachment_links l WHERE l.attachment_id=a.id AND l.report_id=ANY(' + param(request.report_ids) + '::bigint[]))');
    let sql = 'SELECT ' + columns + ' FROM public.report_attachments a WHERE ' + conditions.join(' AND ') + ' ORDER BY a.created_at,a.id';
    if (input.limit !== undefined) sql += ' LIMIT ' + param(input.limit) + ' OFFSET ' + param(input.offset || 0);
    return (await client.query(sql, values)).rows.map(metadata);
  });
}

// Call on the same client/transaction immediately before reports INSERT/UPDATE.
// The AFTER trigger binds only references that actually commit with a report.
export async function validateReportAttachmentReferences(client, userId, profile, row, existing) {
  const biz = row.biz === undefined ? existing?.biz : row.biz;
  if (!biz || !Object.hasOwn(biz, 'attachments')) return [];
  const ids = identifiers(biz.attachments, MAX_REPORT_ATTACHMENTS);
  const pid = existing?.project_id || row.project_id, period = existing?.period || row.period, line = existing?.line || row.line;
  if (profile?.status !== 'approved' || profile.role !== 'pm' || (existing && existing.author_id !== userId)) throw new HttpError(403, '只能引用本人填报附件');
  if (!(await client.query('SELECT app_private.can_write_report($1,$2,$3) AS allowed', [pid,line,userId])).rows[0]?.allowed) throw new HttpError(403, '只能引用本人获授权项目和填报模块的附件');
  const report = { ...existing, ...row }, projects = report.scope_project_ids || [pid];
  if (report.report_scope_id && !(await client.query('SELECT app_private.can_read_report_scope($1::text[]) AS allowed',[projects])).rows[0]?.allowed) throw new HttpError(403,'统一报告附件需要全部成员项目原授权');
  const rows = ids.length ? (await client.query('SELECT * FROM app_private.lock_report_attachments($1::uuid[])', [ids])).rows : [];
  const scopes = ids.length ? (await client.query('SELECT id,report_scope_id,scope_project_ids FROM public.report_attachments WHERE id=ANY($1::uuid[])',[ids])).rows : [];
  if (rows.length !== ids.length || scopes.length !== ids.length || rows.some(attachment => attachment.owner_id !== userId || !projects.includes(attachment.project_id) || attachment.period !== period || attachment.line !== line || (scopes.find(item=>item.id===attachment.id)?.report_scope_id || null) !== (report.report_scope_id || null))) throw new HttpError(403, '附件不存在或不属于本人本项目、本周期和本模块');
  if (rows.reduce((sum, attachment) => sum + attachment.size, 0) > MAX_REPORT_ATTACHMENT_BYTES) throw new HttpError(400, '本期附件合计不能超过 40MiB');
  if (row.biz !== undefined) row.biz = { ...row.biz, attachments: ids };
  return ids;
}

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { HttpError } from './errors.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/.test(value) && value !== '.' && value !== '..';
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const unavailable = () => new HttpError(503, '方案资料保护配置不可用，请联系管理员', 'scheme_protection_unavailable');
const forbidden = () => new HttpError(403, '方案原件受保护，仅提供关键资料摘录', 'scheme_original_protected');
const registryFile = uploadDir => path.join(uploadDir, 'scheme-protection', 'registry.json');

function drawingPath(value, projectId) {
  if (typeof value !== 'string') return '';
  let relative = value;
  if (/^https?:\/\//i.test(value)) {
    try { relative = new URL(value).pathname; } catch { return ''; }
  }
  if (relative.startsWith('/api/files/')) relative = relative.slice('/api/files/'.length).split(/[?#]/)[0];
  const parts = relative.split('/');
  return parts.length === 3 && parts[0] === 'drawings' && parts[1] === projectId
    && parts.every(identifier) ? parts.join('/') : '';
}

export async function readSchemeRegistry(uploadDir) {
  if (!uploadDir) return { version: 1, projects: [] };
  let value;
  try { value = JSON.parse(await readFile(registryFile(uploadDir), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, projects: [] }; throw unavailable(); }
  if (!object(value) || value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > 5000) throw unavailable();
  const seen = new Set();
  for (const project of value.projects) {
    if (!object(project) || !identifier(project.project_id) || seen.has(project.project_id)
      || !Array.isArray(project.protected_paths) || !project.protected_paths.length || project.protected_paths.length > 100
      || project.protected_paths.some(name => drawingPath(name, project.project_id) !== name)
      || new Set(project.protected_paths).size !== project.protected_paths.length) throw unavailable();
    seen.add(project.project_id);
    const preview = project.preview;
    if (preview != null && (!object(preview) || !sha256(preview.sha256)
      || preview.path !== 'scheme-previews/' + project.project_id + '/' + preview.sha256 + '.webp'
      || !Number.isSafeInteger(preview.width) || preview.width < 1 || preview.width > 20000
      || !Number.isSafeInteger(preview.height) || preview.height < 1 || preview.height > 20000
      || !Number.isSafeInteger(preview.source_page) || preview.source_page < 1)) throw unavailable();
  }
  return value;
}

function registered(registry, projectId) { return registry.projects.find(project => project.project_id === projectId); }
function catalogPaths(catalog, projectId) {
  if (!object(catalog)) return [];
  return [drawingPath(catalog.source?.url, projectId), drawingPath(catalog.preview, projectId)].filter(Boolean);
}
function previewUrl(project) { return project?.preview ? '/api/' + project.preview.path : ''; }
function pick(value, keys) { return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])); }

export function publicSchemeCatalog(catalog, project) {
  if (!object(catalog)) return null;
  const pageNumbers = [...new Set((Array.isArray(catalog.pages) ? catalog.pages : []).map(page => Number(page?.page))
    .filter(number => Number.isSafeInteger(number) && number > 0))];
  return {
    ...pick(catalog, ['version', 'kind', 'scope', 'edition', 'summary', 'plan_page']),
    source: { name: typeof catalog.source?.name === 'string' ? catalog.source.name : '' },
    facts: Array.isArray(catalog.facts) ? catalog.facts.filter(object).map(fact => pick(fact,
      ['label', 'value', 'unit', 'page', 'group', 'highlight', 'audiences', 'scope', 'note', 'status'])) : [],
    issues: Array.isArray(catalog.issues) ? catalog.issues.filter(object).map(issue => pick(issue, ['title', 'detail', 'pages'])) : [],
    pages: [],
    page_numbers: pageNumbers,
    page_count: Array.isArray(catalog.pages) ? catalog.pages.length : Number.isSafeInteger(catalog.page_count) && catalog.page_count >= 0 ? catalog.page_count : 0,
    preview: previewUrl(project),
    protected: true
  };
}

// Called inside the existing identity transaction. Requested columns are
// projected only afterwards so selecting just fields/path cannot evade policy.
export async function sanitizeSchemeRows(client, table, rows, { uploadDir } = {}) {
  if (!['project_master', 'project_drawings'].includes(table) || !rows.length) return rows;
  const registry = await readSchemeRegistry(uploadDir);
  if (table === 'project_master') return rows.map(row => {
    if (!object(row.fields) || !Object.hasOwn(row.fields, 'scheme_catalog')) return row;
    return { ...row, fields: { ...row.fields, scheme_catalog: publicSchemeCatalog(row.fields.scheme_catalog, registered(registry, row.project_id)) } };
  });
  const ids = [...new Set(rows.map(row => row.project_id))];
  const masters = (await client.query('SELECT project_id,fields FROM public.project_master WHERE project_id=ANY($1::text[])', [ids])).rows;
  return rows.flatMap(row => {
    const catalog = masters.find(master => master.project_id === row.project_id)?.fields?.scheme_catalog;
    const project = registered(registry, row.project_id), names = new Set([...(project?.protected_paths || []), ...catalogPaths(catalog, row.project_id)]);
    const protectedName = [drawingPath(row.path, row.project_id), drawingPath(row.url, row.project_id)].find(name => name && names.has(name));
    if (!protectedName) return [row];
    if (/\.pdf$/i.test(protectedName) || protectedName === drawingPath(catalog?.source?.url, row.project_id)) return [];
    return [{ ...row, name: '方案总图关键区域.webp', path: '', url: previewUrl(project), scheme_protected: true }];
  });
}

export async function assertSchemeFileReadable(client, uploadDir, relative) {
  const projectId = relative.split('/')[1], registry = await readSchemeRegistry(uploadDir);
  if (registered(registry, projectId)?.protected_paths.includes(relative)) throw forbidden();
  const master = (await client.query('SELECT fields FROM public.project_master WHERE project_id=$1', [projectId])).rows[0];
  if (catalogPaths(master?.fields?.scheme_catalog, projectId).includes(relative)) throw forbidden();
}

export function assertUnsealedFile(buffer) {
  if (buffer.subarray(0, 8).toString('ascii') === 'ZHSCM001') throw forbidden();
}

export async function loadSchemePreview(client, uploadDir, projectId, digest) {
  if (!identifier(projectId) || !sha256(digest)) throw new HttpError(404, '关键区域预览不存在或无权访问');
  if (!(await client.query('SELECT id FROM public.projects WHERE id=$1', [projectId])).rows.length) throw new HttpError(404, '关键区域预览不存在或无权访问');
  const project = registered(await readSchemeRegistry(uploadDir), projectId);
  if (!project?.preview || project.preview.sha256 !== digest) throw new HttpError(404, '关键区域预览不存在或无权访问');
  let buffer;
  try { buffer = await readFile(path.join(uploadDir, ...project.preview.path.split('/'))); }
  catch (error) { if (error.code === 'ENOENT') throw new HttpError(503, '关键区域预览尚未准备完成', 'scheme_preview_unavailable'); throw error; }
  if (createHash('sha256').update(buffer).digest('hex') !== digest || buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
    || buffer.subarray(8, 12).toString('ascii') !== 'WEBP') throw new HttpError(503, '关键区域预览校验失败', 'scheme_preview_unavailable');
  return { buffer, type: 'image/webp' };
}

// The browser reads a public projection. Never let saving that projection
// replace the retained full index, or introduce an unchecked index via /db.
function lockedMasterQuery(buildQuery, filters) {
  const lookup = buildQuery({ table: 'project_master', operation: 'select', columns: 'project_id,fields', filters });
  // This query guards the whole mutation, which itself has no SELECT limit.
  return { text: lookup.text.replace(/ LIMIT \$\d+$/, '') + ' FOR UPDATE', values: lookup.values.slice(0, -1) };
}

export async function preserveSchemeMaster(client, request, buildQuery) {
  if (request.table !== 'project_master' || (request.operation || 'select') === 'select') return request;
  if (request.operation === 'delete') {
    const existing = (await client.query(lockedMasterQuery(buildQuery, request.filters))).rows;
    if (existing.some(row => object(row.fields) && row.fields.scheme_catalog != null)) throw new HttpError(409, '含方案索引的项目档案不能直接删除', 'scheme_catalog_retained');
    return request;
  }
  const values = Array.isArray(request.values) ? request.values : [request.values], preserved = [];
  for (const row of values) {
    const changingFields = Object.hasOwn(row, 'fields'), movingProject = request.operation === 'update' && Object.hasOwn(row, 'project_id');
    if (!changingFields && !movingProject) { preserved.push(row); continue; }
    if (changingFields && !object(row.fields)) throw new HttpError(400, '项目档案字段须为对象');
    const filters = request.operation === 'update' ? request.filters : [{ column: 'project_id', value: row.project_id }];
    const existing = (await client.query(lockedMasterQuery(buildQuery, filters))).rows;
    const protectedRows = existing.filter(value => object(value.fields) && value.fields.scheme_catalog != null);
    if (movingProject && protectedRows.some(value => value.project_id !== row.project_id)) throw new HttpError(409, '含方案索引的档案不能变更项目归属', 'scheme_catalog_project_locked');
    if (!changingFields) { preserved.push(row); continue; }
    if (protectedRows.length && existing.length !== 1) throw new HttpError(400, '含方案索引的档案请逐个项目保存');
    if (!protectedRows.length && Object.hasOwn(row.fields, 'scheme_catalog')) throw new HttpError(403, '方案索引须通过受控资料交接导入', 'scheme_catalog_controlled');
    preserved.push(protectedRows.length ? { ...row, fields: { ...row.fields, scheme_catalog: protectedRows[0].fields.scheme_catalog } } : row);
  }
  return { ...request, values: Array.isArray(request.values) ? preserved : preserved[0] };
}

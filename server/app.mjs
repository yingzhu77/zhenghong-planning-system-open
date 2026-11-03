import express from 'express';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAuth, createOriginCheck } from './auth.mjs';
import { executeDatabase, replaceLeaderNotes } from './database.mjs';
import { listReporterTasks, saveReporterTask, listProjectPeople, assignLeaderRequirement } from './reporter-tasks.mjs';
import { listProjectLibrary, setLibraryPassword, unlockProjectLibrary, uploadProjectDocument, withdrawProjectDocument, loadProjectDocument, MAX_LIBRARY_BYTES } from './project-library.mjs';
import { listCoordinationTasks, createCoordinationTask } from './coordination-tasks.mjs';
import { listMonthlyPlans, confirmMonthlyPlan, withdrawMonthlyPlan } from './monthly-plans.mjs';
import {listAdminPlanBatches,withdrawAdminPlanBatch} from './admin-plan-batches.mjs';
import { assertAdminPlanOperator, getAdminPlanContext, previewAdminPlanRows, saveAdminMonthlyPlans } from './admin-monthly-plans.mjs';
import { ADMIN_PLAN_IMPORT_LIMITS, parseAdminPlanImport, parseAdminPlanEvidence, parseAdminPlanWorkbookBundle } from './admin-plan-import.mjs';
import { listMonthlyPlanSummaries } from './monthly-plan-summaries.mjs';
import { listCommercialModuleGrants, saveCommercialModuleGrant } from './commercial-module-grants.mjs';
import { startAdminPlanAI, chatAdminPlanAI, getAdminPlanAISession, reviseAdminPlanAI, confirmAdminPlanAI, closeAdminPlanAI } from './admin-plan-ai.mjs';
import { listCompletions, previewCompletion, requestCompletion, reviewCompletion, withdrawCompletion } from './completions.mjs';
import { completionStatistics } from './completion-statistics.mjs';
import { projectPlanStatistics } from './project-plan-statistics.mjs';
import { listReportScopes } from './report-scopes.mjs';
import { managementRead } from './management-read.mjs';
import { uploadReportAttachment, listReportAttachments, loadReportAttachment, discardReportAttachment, discardInaccessibleReportDrafts } from './report-attachments.mjs';
import { pipeline } from 'node:stream/promises';
import { loadFile, MAX_FILE_BYTES, saveUpload } from './files.mjs';
import { HttpError, publicError } from './errors.mjs';
import { webAssets } from './web-assets.mjs';
import { readOnlyGate, readOnlyHtml } from './read-only.mjs';
import { planningAIChat } from './planning-ai.mjs';
import { loadPlanningAIMemory, savePlanningAIConversation, savePlanningAIPreference } from './planning-ai-memory.mjs';

// PostgreSQL DATE is a calendar day, not an instant. The driver's default local
// Date conversion shifts it when JSON serializes in UTC (e.g. Shanghai -1 day).
pg.types.setTypeParser(1082, (value) => value);

const root = fileURLToPath(new URL('../', import.meta.url));
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
export function environmentConfig(env = process.env) {
  const proxy = env.TRUST_PROXY || 'false';
  return {
    publicOrigin: env.APP_ORIGIN || env.PUBLIC_ORIGIN || '',
    readOnly: env.APP_READ_ONLY === 'true',
    readOnlyTarget: env.READ_ONLY_TARGET || '',
    planningAIConfigPath: env.PLANNING_DEEPSEEK_CONFIG || '',
    additionalOrigins: env.APP_ADDITIONAL_ORIGINS || '',
    cookieSecure: env.COOKIE_SECURE === 'true',
    sessionHours: Number(env.SESSION_IDLE_HOURS) || 12,
    authCodeSecret: env.AUTH_CODE_SECRET || env.SESSION_SECRET,
    uploadDir: path.resolve(env.UPLOAD_DIR || path.join(root, 'data', 'uploads')),
    trustProxy: proxy === 'false' ? false : /^\d+$/.test(proxy) ? Number(proxy) : proxy,
    smtp: { host: env.SMTP_HOST, port: Number(env.SMTP_PORT) || 587, secure: env.SMTP_SECURE === 'true', user: env.SMTP_USER, pass: env.SMTP_PASSWORD, from: env.SMTP_FROM }
  };
}

export function createApp({ pool, config = {}, webRoot = path.join(root, 'web') }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? false);
  const originAllowed = createOriginCheck(config);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    // The existing UI uses inline handlers; scripts/resources stay same-origin.
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; frame-src https: http:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && !originAllowed(req))) return next(new HttpError(403, '请从系统页面发起操作', 'origin_mismatch'));
      // Browser sessions cannot be used by cross-origin form posts or requests
      // that suppress the origin header. Non-cookie CLI login remains possible.
      if (req.headers.cookie && !req.headers.origin) return next(new HttpError(403, '请求缺少来源信息', 'origin_required'));
    }
    next();
  });
  app.use('/api', readOnlyGate(config));
  app.get('/api/health', asyncRoute(async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ data: { status: 'ok' }, error: null });
  }));
  const auth = createAuth({ pool, config });
  app.use('/api/auth', auth.router);
  for (const [route, handler] of [['load', loadPlanningAIMemory], ['conversation', savePlanningAIConversation], ['preference', savePlanningAIPreference]]) {
    app.post('/api/planning-ai/memory/' + route, auth.requireUser, express.json({limit:'256kb'}), asyncRoute(async(req,res)=>{
      res.json({data:await handler(pool,req.user,req.body),error:null});
    }));
  }
  app.post('/api/planning-ai/chat', auth.requireUser, attachmentBudget, express.json({limit:'18mb'}), asyncRoute(async(req,res)=>{
    const sessionHash=req.sessionTokenHash, userId=req.user.id, controller=new AbortController();
    const disconnect=()=>{if(!res.writableEnded)controller.abort();};
    res.once('close',disconnect);
    try {
      const result=await planningAIChat(pool,req.user,req.body,{configPath:config.planningAIConfigPath,signal:controller.signal,
        ...(config.planningAIFetch?{fetchImpl:config.planningAIFetch}:{})});
      if(controller.signal.aborted)return;
      delete req._zhSessionPromise; // Re-read a session that may have been revoked during a model request.
      if(!await auth.getSession(req,res) || req.user.id!==userId || req.sessionTokenHash!==sessionHash)throw new HttpError(401,'会话已失效，请重新登录。','ai_session_expired');
      if(req.user.must_change_password)throw new HttpError(403,'首次登录请先修改初始密码','PASSWORD_CHANGE_REQUIRED');
      res.json({data:result,error:null});
    } finally {res.off('close',disconnect);}
  }));
  app.post('/api/db', auth.requireUser, express.json({ limit: '2mb' }), asyncRoute(async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, '请求格式不正确');
    const rows = await executeDatabase(pool, req.user, req.body);
    res.json({ data: rows, error: null });
  }));
  app.post('/api/leader-notes/replace', auth.requireUser, express.json({ limit: '1mb' }), asyncRoute(async (req, res) => {
    const rows = await replaceLeaderNotes(pool, req.user, req.body || {});
    res.json({ data: rows, error: null });
  }));
  app.post('/api/report-scopes/list', auth.requireUser, express.json({limit:'16kb'}), asyncRoute(async(req,res)=>{
    res.json({data:await listReportScopes(pool,req.user,req.body || {}),error:null});
  }));
  app.post('/api/management-read', auth.requireUser, express.json({ limit: '16kb' }), asyncRoute(async (req, res) => {
    res.json({ data: await managementRead(pool, req.user, req.body ?? {}), error: null });
  }));
  app.post('/api/reporter-tasks/list', auth.requireUser, express.json({ limit: '16kb' }), asyncRoute(async (req, res) => {
    res.json({ data: await listReporterTasks(pool, req.user, req.body ?? {}), error: null });
  }));
  app.post('/api/project-people/list', auth.requireUser, express.json({ limit: '16kb' }), asyncRoute(async (req, res) => {
    res.json({ data: await listProjectPeople(pool, req.user, req.body ?? {}), error: null });
  }));
  app.post('/api/reporter-tasks/save', auth.requireUser, express.json({ limit: '1mb' }), asyncRoute(async (req, res) => {
    res.json({ data: await saveReporterTask(pool, req.user, req.body), error: null });
  }));
  app.post('/api/leader-notes/assign', auth.requireUser, express.json({limit:'16kb'}), asyncRoute(async(req,res)=>{
    res.json({data:await assignLeaderRequirement(pool,req.user,req.body ?? {}),error:null});
  }));
  for (const [route, handler] of [['list', listCoordinationTasks], ['create', createCoordinationTask]]) {
    app.post('/api/coordination-tasks/' + route, auth.requireUser, express.json({ limit: '32kb' }), asyncRoute(async (req, res) => {
      res.json({ data: await handler(pool, req.user, req.body ?? {}), error: null });
    }));
  }
  for (const [route, handler] of [['list', listMonthlyPlans], ['confirm', confirmMonthlyPlan], ['withdraw', withdrawMonthlyPlan]]) {
    app.post('/api/monthly-plans/' + route, auth.requireUser, express.json({ limit: '1mb' }), asyncRoute(async (req, res) => {
      res.json({ data: await handler(pool, req.user, req.body ?? {}), error: null });
    }));
  }
  const adminPlanOperator = (req, res, next) => {
    assertAdminPlanOperator(pool, req.user).then(() => next(), next);
  };
  app.get('/api/admin-plans/context', auth.requireUser, adminPlanOperator, asyncRoute(async (req, res) => {
    res.json({ data: await getAdminPlanContext(pool, req.user, req.query), error: null });
  }));
  app.get('/api/admin-plans/batches', auth.requireUser, adminPlanOperator, asyncRoute(async (req, res) => {
    res.json({data:await listAdminPlanBatches(pool,req.user,req.query),error:null});
  }));
  app.post('/api/admin-plans/withdraw-batch', auth.requireUser, adminPlanOperator, express.json({limit:'4kb'}), asyncRoute(async (req, res) => {
    res.json({data:await withdrawAdminPlanBatch(pool,req.user,req.body??{}),error:null});
  }));
  for (const [route, handler] of [['preview', previewAdminPlanRows], ['save', saveAdminMonthlyPlans]]) {
    app.post('/api/admin-plans/' + route, auth.requireUser, adminPlanOperator, express.json({ limit: '2mb' }), asyncRoute(async (req, res) => {
      res.json({ data: await handler(pool, req.user, req.body ?? {}), error: null });
    }));
  }
  const adminPlanFileEncoding = (req, res, next) => {
    const encoding = req.get('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') return next(new HttpError(415, '请直接上传未压缩的 Excel 文件', 'admin_plan_import_encoding'));
    next();
  };
  let receivingAdminPlan = false;
  function adminPlanUploadBudget(req, res, next) {
    if (Number(req.get('content-length')) > ADMIN_PLAN_IMPORT_LIMITS.fileBytes)
      return next(new HttpError(413, 'Excel 文件不能超过 300 MB', 'admin_plan_import_size'));
    if (receivingAdminPlan) return next(new HttpError(429, '正在接收或解析另一份 Excel，请稍后重试；原计划未改变', 'admin_plan_import_busy'));
    receivingAdminPlan = true;
    const release = () => { receivingAdminPlan = false; res.off('finish', release); res.off('close', release); };
    res.once('finish', release); res.once('close', release); next();
  }
  function adminPlanAIRequest(req, res) {
    const userId = req.user.id, sessionHash = req.sessionTokenHash, controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnect);
    const revalidateSession = async () => {
      delete req._zhSessionPromise;
      if (!await auth.getSession(req, res) || req.user.id !== userId || req.sessionTokenHash !== sessionHash)
        throw new HttpError(401, '会话已失效，请重新登录', 'admin_plan_ai_session_expired');
      if (req.user.must_change_password) throw new HttpError(403, '首次登录请先修改初始密码', 'PASSWORD_CHANGE_REQUIRED');
      await assertAdminPlanOperator(pool, req.user);
    };
    return { options: { configPath: config.planningAIConfigPath, sessionKey: sessionHash, signal: controller.signal, revalidateSession,
      ...(config.planningAIFetch ? { fetchImpl: config.planningAIFetch } : {}) },
      cleanup: () => res.off('close', disconnect) };
  }
  app.post('/api/admin-plans/ai/upload', auth.requireUser, adminPlanOperator, adminPlanFileEncoding, adminPlanUploadBudget, attachmentBudget,
    express.raw({ type: () => true, limit: ADMIN_PLAN_IMPORT_LIMITS.fileBytes, inflate: false }), asyncRoute(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || Object.keys(req.query).some(key => !['project_id', 'report_scope_id', 'month', 'name'].includes(key)))
        throw new HttpError(400, '请选择项目、月份和 Excel 文件', 'admin_plan_ai_invalid');
      const request = adminPlanAIRequest(req, res);
      try {
        const parsed = await parseAdminPlanEvidence(req.body, { name: req.query.name || '月度计划.xlsx', month: req.query.month, signal: request.options.signal });
        const data = await startAdminPlanAI(pool, req.user, { project_id: req.query.project_id,
          ...(req.query.report_scope_id ? { report_scope_id: req.query.report_scope_id } : {}), month: req.query.month, evidence: parsed.evidence }, request.options);
        if (request.options.signal.aborted) return;
        await request.options.revalidateSession();
        res.json({ data, error: null });
      } finally { request.cleanup(); }
    }));
  for (const [route, handler] of [['chat', chatAdminPlanAI], ['session', getAdminPlanAISession], ['revise', reviseAdminPlanAI], ['confirm', confirmAdminPlanAI], ['close', closeAdminPlanAI]]) {
    app.post('/api/admin-plans/ai/' + route, auth.requireUser, adminPlanOperator, express.json({ limit: '1mb' }), asyncRoute(async (req, res) => {
      const request = adminPlanAIRequest(req, res);
      try {
        const data = await handler(pool, req.user, req.body ?? {}, request.options);
        if (request.options.signal.aborted) return;
        await request.options.revalidateSession();
        res.json({ data, error: null });
      } finally { request.cleanup(); }
    }));
  }
  app.post('/api/admin-plans/import', auth.requireUser, adminPlanOperator, adminPlanFileEncoding, adminPlanUploadBudget, attachmentBudget,
    express.raw({ type: () => true, limit: ADMIN_PLAN_IMPORT_LIMITS.fileBytes, inflate: false }), asyncRoute(async (req, res) => {
      if (!Buffer.isBuffer(req.body)) throw new HttpError(400, '请选择 Excel 文件');
      const userId = req.user.id, sessionHash = req.sessionTokenHash, controller = new AbortController();
      const disconnect = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnect);
      try {
        if(Object.keys(req.query).some(key=>!['project_id','report_scope_id','month','include_next','name'].includes(key)) || req.query.include_next!==undefined && req.query.include_next!=='1')throw new HttpError(400,'导入月份范围不正确','admin_plan_import_month');
        const parse=req.query.include_next==='1'?parseAdminPlanWorkbookBundle:parseAdminPlanImport;
        const parsed = await parse(req.body, { month: req.query.month, ...(req.query.name===undefined?{}:{name:req.query.name}), signal: controller.signal });
        if (controller.signal.aborted) return;
        delete req._zhSessionPromise;
        if (!await auth.getSession(req, res) || req.user.id !== userId || req.sessionTokenHash !== sessionHash)
          throw new HttpError(401, '会话已失效，请重新登录', 'admin_plan_session_expired');
        if (req.user.must_change_password) throw new HttpError(403, '首次登录请先修改初始密码', 'PASSWORD_CHANGE_REQUIRED');
        const scope={project_id:req.query.project_id,...(req.query.report_scope_id===undefined?{}:{report_scope_id:req.query.report_scope_id})};
        if(Array.isArray(parsed.batches)){
          const batches=[];for(const batch of parsed.batches)batches.push({...batch,...await previewAdminPlanRows(pool,req.user,{...scope,month:batch.month,rows:batch.rows})});
          if(controller.signal.aborted)return;
          res.json({data:{...parsed,batches},error:null});
        }else{
          const preview = await previewAdminPlanRows(pool, req.user, { ...scope, month:req.query.month, rows: parsed.rows });
          res.json({ data: { ...parsed, ...preview }, error: null });
        }
      } finally { res.off('close', disconnect); }
    }));
  app.get('/api/monthly-summaries',auth.requireUser,asyncRoute(async(req,res)=>{
    res.set('Cache-Control','no-store');res.json({data:await listMonthlyPlanSummaries(pool,req.user,req.query),error:null});
  }));
  app.get('/api/commercial-module-grants',auth.requireUser,asyncRoute(async(req,res)=>{
    res.set('Cache-Control','no-store');res.json({data:await listCommercialModuleGrants(pool,req.user),error:null});
  }));
  app.post('/api/commercial-module-grants',auth.requireUser,adminPlanOperator,express.json({limit:'64kb'}),asyncRoute(async(req,res)=>{
    res.json({data:await saveCommercialModuleGrant(pool,req.user,req.body ?? {}),error:null});
  }));
  app.post('/api/completions/list', auth.requireUser, express.json({ limit: '64kb' }), asyncRoute(async (req, res) => {
    const rows = await listCompletions(pool, req.user, req.body || {});
    res.json({ data: rows, meta: rows.meta, error: null });
  }));
  app.post('/api/completions/statistics', auth.requireUser, express.json({limit:'16kb'}), asyncRoute(async(req,res)=>{
    res.json({data:await completionStatistics(pool,req.user,req.body ?? {}),error:null});
  }));
  app.post('/api/project-plan-statistics', auth.requireUser, express.json({limit:'16kb'}), asyncRoute(async(req,res)=>{
    res.json({data:await projectPlanStatistics(pool,req.user,req.body ?? {}),error:null});
  }));
  for (const [route, handler] of [['preview', previewCompletion], ['request', requestCompletion], ['review', reviewCompletion], ['withdraw', withdrawCompletion]]) {
    app.post('/api/completions/' + route, auth.requireUser, express.json({ limit: '64kb' }), asyncRoute(async (req, res) => {
      res.json({ data: await handler(pool, req.user, req.body || {}), error: null });
    }));
  }
  let receivingAttachments = 0;
  function attachmentBudget(req, res, next) {
    if (receivingAttachments >= 2) return next(new HttpError(429, '正在接收其他附件，请稍后重试', 'attachment_busy'));
    receivingAttachments++;
    let released = false;
    const release = () => { if (!released) { released = true; receivingAttachments--; } };
    res.once('finish', release); res.once('close', release); next();
  }
  app.post('/api/report-attachments/upload', auth.requireUser, attachmentBudget,
    express.raw({ type: () => true, limit: MAX_FILE_BYTES }), asyncRoute(async (req, res) => {
      if (!Buffer.isBuffer(req.body)) throw new HttpError(400, '请选择附件文件');
      res.json({ data: await uploadReportAttachment(pool, req.user, config.uploadDir || path.join(root, 'data', 'uploads'), req.query, req.body, req.headers['content-type']), error: null });
    }));
  app.post('/api/report-attachments/list', auth.requireUser, express.json({ limit: '64kb' }), asyncRoute(async (req, res) => {
    res.json({ data: await listReportAttachments(pool, req.user, req.body || {}), error: null });
  }));
  app.post('/api/report-attachments/discard', auth.requireUser, express.json({ limit: '16kb' }), asyncRoute(async (req, res) => {
    res.json({ data: await discardReportAttachment(pool, req.user, config.uploadDir || path.join(root,'data','uploads'), req.body || {}), error: null });
  }));
  app.post('/api/report-attachments/discard-inaccessible', auth.requireUser, express.json({ limit: '16kb' }), asyncRoute(async (req, res) => {
    if (!req.body || typeof req.body!=='object' || Array.isArray(req.body) || Object.keys(req.body).length) throw new HttpError(400, '清理请求格式不正确');
    res.json({ data: await discardInaccessibleReportDrafts(pool, req.user, config.uploadDir || path.join(root,'data','uploads')), error: null });
  }));
  app.get('/api/report-attachments/:id', auth.requireUser, asyncRoute(async (req, res) => {
    const file = await loadReportAttachment(pool, req.user, config.uploadDir || path.join(root, 'data', 'uploads'), req.params.id, { stream: true });
    res.set('Content-Disposition', (file.inline ? 'inline' : 'attachment') + '; filename="attachment"; filename*=UTF-8\'\'' + encodeURIComponent(file.name));
    res.type(file.type);
    if (file.size != null) res.set('Content-Length', String(file.size));
    if (file.inline) res.set({ 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'self'" });
    if (file.stream) await pipeline(file.stream, res);
    else res.send(file.buffer);
  }));
  const uploadDir = path.resolve(config.uploadDir || path.join(root, 'data', 'uploads'));
  for(const [route,handler] of [['list',listProjectLibrary],['password',setLibraryPassword],['unlock',unlockProjectLibrary],['withdraw',withdrawProjectDocument]]){
    app.post('/api/project-library/'+route,auth.requireUser,express.json({limit:'16kb'}),asyncRoute(async(req,res)=>{
      res.json({data:await handler(pool,req.user,req.body ?? {},req.sessionTokenHash),error:null});
    }));
  }
  app.post('/api/project-library/upload',auth.requireUser,attachmentBudget,express.raw({type:()=>true,limit:MAX_LIBRARY_BYTES}),asyncRoute(async(req,res)=>{
    if(!Buffer.isBuffer(req.body))throw new HttpError(400,'请选择共享资料文件');
    res.json({data:await uploadProjectDocument(pool,req.user,uploadDir,req.query,req.body),error:null});
  }));
  app.get('/api/project-library/:id',auth.requireUser,asyncRoute(async(req,res)=>{
    const file=await loadProjectDocument(pool,req.user,uploadDir,req.params.id,{sessionKey:req.sessionTokenHash,original:req.query.original==='1',inline:req.query.inline==='1'});
    res.set('Content-Disposition',(file.inline?'inline':'attachment')+'; filename="document"; filename*=UTF-8\'\''+encodeURIComponent(file.name));
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    if(file.inline)res.set({'X-Frame-Options':'SAMEORIGIN','Content-Security-Policy':"default-src 'none'; sandbox; frame-ancestors 'self'"});
    res.type(file.type).send(file.buffer);
  }));
  app.post('/api/files/upload', auth.requireUser, express.raw({ type: 'multipart/form-data', limit: MAX_FILE_BYTES + 16384 }), asyncRoute(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, '请使用文件上传格式');
    const saved = await saveUpload(pool, req.user, uploadDir, req.body, req.headers['content-type']);
    res.json({ data: saved, error: null });
  }));
  app.get(/^\/api\/files\/(.+)$/, auth.requireUser, asyncRoute(async (req, res) => {
    const file = await loadFile(pool, req.user, uploadDir, req.params[0]);
    res.set('Content-Disposition', 'inline; filename="' + file.name + '"');
    res.type(file.type).send(file.buffer);
  }));
  app.use('/api', (req, res) => res.status(404).json({ data: null, error: { code: 'not_found', message: '接口不存在' } }));
  const assets = webAssets(webRoot);
  app.get(['/', '/index.html'], (req, res) => {
    res.set('Cache-Control', 'no-cache, max-age=0, must-revalidate').type('html').send(readOnlyHtml(assets.html, config));
  });
  app.get(/^\/assets\//, (req, res, next) => {
    const asset = assets.responses.get(req.path);
    if (!asset) return next();
    res.set('Cache-Control', 'public, max-age=31536000, immutable').type(path.extname(asset.name)).send(asset.body);
  });
  app.use(express.static(webRoot, { dotfiles: 'deny', index: false, fallthrough: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, max-age=0') }));
  app.use((req, res) => res.status(404).send('Not found'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const result = publicError(error);
    if (result.status >= 500) console.error('[request failed]', { code: error.code || error.name, route: req.path,
      ...(error.code==='attachment_cleanup_failed'?{phase:error.cleanupPhase || 'upload-file',attachmentId:error.attachmentId || null,
        cleanupCode:error.cleanupCause?.code || error.cause?.code || null,cleanupFailures:error.cleanupFailures || []}:{}) });
    res.status(result.status).json({ data: null, error: result.error });
  });
  return app;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('请设置 DATABASE_URL');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 10000, statement_timeout: 15000 });
  const config = environmentConfig();
  const role = (await pool.query('SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  if (!role || role.rolsuper || role.rolbypassrls || role.rolname !== 'app_runtime') throw new Error('API必须使用受限 app_runtime 数据库角色');
  const app = createApp({ pool, config });
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, '0.0.0.0', () => console.log(`正弘周报独立版已启动，端口 ${port}`));
  const stop = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error('启动失败：' + error.message); process.exitCode = 1; });

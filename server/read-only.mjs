import express from 'express';

// Explicit read routes: new mutation endpoints stay closed on a frozen instance.
const reads = new Set([
  '/auth/login', '/auth/logout', '/report-scopes/list', '/management-read',
  '/reporter-tasks/list', '/project-people/list', '/coordination-tasks/list',
  '/monthly-plans/list', '/completions/list', '/completions/statistics',
  '/completions/preview', '/project-plan-statistics', '/report-attachments/list',
  '/project-library/list', '/project-library/unlock'
]);
export function readOnlyGate(config) {
  if (!config.readOnly) return (req, res, next) => next();
  const json = express.json({ limit: '2mb' });
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const route = req.path.toLowerCase().replace(/\/+$/, '');
    if (req.method === 'POST' && reads.has(route)) return next();
    const deny = () => res.status(403).json({ data: null, error: {
      code: 'INSTANCE_READ_ONLY', message: '本站已转为只读，请到北京入口办理填报、审核和上传。'
    } });
    if (req.method === 'POST' && route === '/db') return json(req, res, error => {
      if (error) return next(error);
      return (!req.body?.operation || req.body.operation === 'select') ? next() : deny();
    });
    deny();
  };
}
export function readOnlyHtml(html, config) {
  if (!config.readOnly) return html;
  const target = new URL(config.readOnlyTarget);
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('只读站点需配置可信HTTPS迁移入口');
  const href = target.href.replace(/[&"<>']/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;', "'": '&#39;' }[c]));
  return html.replace(/<body([^>]*)>/i, '<body$1><aside style="position:relative;z-index:2147483647;padding:10px;text-align:center;background:#fff3cd;color:#533f03">本站为迁移前只读记录，仅可查看和下载。填报、审核和上传请使用 <a href="' + href + '" target="_blank" rel="noopener">北京入口</a>。未提交草稿仍在原浏览器中，请先保全。</aside>');
}

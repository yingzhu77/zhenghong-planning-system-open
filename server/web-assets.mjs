import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const files = ['logo.png', 'login-bg-desktop.avif', 'login-bg-mobile.avif', 'login-bg-desktop.webp', 'login-bg-mobile.webp',
  'styles.css', 'planning-ui.css', 'cloud-compat.js', 'login-boot.js', 'app.js', 'password-change.js', 'password-change.css',
  'rich-text.js', 'rich-editor.js', 'selection-format.css', 'vendor/quill/quill.js', 'vendor/quill/quill.core.css',
  'reporter-tasks.js', 'reporter-archive.js', 'reporter-workbench.css', 'reporter-tasks.css', 'reporter-archive.css',
  'admin-archive.js', 'admin-archive.css', 'planning-windows.js', 'report-scopes.js', 'baseline-core.js', 'overview-meetings.js', 'completion-statistics.js', 'completion-statistics.css',
  'monthly-plans.js', 'monthly-summaries.js', 'completion-review.js', 'completion-review.css', 'coordination-workbench.js', 'report-attachments.js', 'report-attachments.css',
  'report3-layout.css','personal-report4.css','project-library.js','project-library.css',
  'project-plan-statistics.js','project-plan-statistics.css','admin-plan-overview.js','admin-plan-overview.css','admin-plans.js','admin-plans.css',
  'management-reader.js','management-reader.css','planning-ai.js','planning-ai-draft.js','planning-ai-memory.js','planning-ai.css',
  'report-reference.js','report-reference.css','meeting-view.js','meeting-controller.js','meeting-display.js','meeting-display.html','meeting-mode.css'];

// The public asset list is fixed. URLs identify the bytes actually served,
// including the versioned image references inside CSS.
export function webAssets(webRoot) {
  const manifest = {}, responses = new Map();
  function prepare(name) {
    if (manifest[name]) return manifest[name];
    let body = readFileSync(path.join(webRoot, name));
    if (name.endsWith('.html')) {
      body = Buffer.from(body.toString('utf8').replace(/(src|href)="([^"]+)"/g,
        (match, attribute, resource) => files.includes(resource) ? `${attribute}="${prepare(resource)}"` : match));
    }
    if (name.endsWith('.css')) {
      body = Buffer.from(body.toString('utf8').replace(/url\(['"]?(login-bg-(?:desktop|mobile)\.webp)['"]?\)/g,
        (_, image) => `url('${prepare(image)}')`));
    }
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
    const url = `/assets/${hash}/${name}`;
    manifest[name] = url;
    responses.set(url, { body, name });
    return url;
  }
  files.forEach(prepare);
  const html = readFileSync(path.join(webRoot, 'index.html'), 'utf8')
    .replace(/(src|href|srcset)="([^"]+)"/g, (match, attribute, name) => manifest[name] ? `${attribute}="${manifest[name]}"` : match)
    // Keep the canonical styles together with the form: the first paint must
    // not wait for extra cross-region stylesheet round trips. HTML revalidates
    // by ETag, so repeat visits reuse this body when the release is unchanged.
    .replace('__PAGE_STYLES__', () => ['styles.css', 'planning-ui.css','report3-layout.css','personal-report4.css'].map(name => responses.get(manifest[name]).body.toString('utf8')).join('\n'))
    .replace('__ASSET_MANIFEST__', JSON.stringify(manifest));
  return { html, responses };
}

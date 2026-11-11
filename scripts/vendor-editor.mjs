import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const source = new URL('../node_modules/quill/', import.meta.url);
const target = new URL('../web/vendor/quill/', import.meta.url);
const metadata = JSON.parse(await readFile(new URL('package.json', source), 'utf8'));
if (metadata.version !== '2.0.3') throw new Error('Unexpected editor version; review and update the pinned vendor assets together');
await mkdir(target, { recursive: true });
for (const name of ['quill.js', 'quill.core.css']) await copyFile(new URL('dist/' + name, source), new URL(name, target));
await copyFile(new URL('LICENSE', source), new URL('LICENSE.txt', target));
console.log('Local editor assets synchronized: Quill ' + metadata.version);

const root = new URL('../', import.meta.url);
const collaborationLicenses = await Promise.all(['yjs', 'y-quill', 'lib0', 'isomorphic.js'].map(async name => {
  const license = await readFile(new URL('node_modules/' + name + '/LICENSE', root), 'utf8');
  return name + '\n' + license.trim().replaceAll('*/', '* /');
}));
await build({
  stdin: {
    contents: "export * as Y from 'yjs'; export { QuillBinding } from 'y-quill';",
    resolveDir: fileURLToPath(root)
  },
  bundle: true,
  format: 'iife',
  globalName: 'PlanningCollaborationVendor',
  minify: true,
  legalComments: 'eof',
  footer: { js: '/*\n' + collaborationLicenses.join('\n\n') + '\n*/' },
  outfile: fileURLToPath(new URL('web/vendor/weekly-collaboration.js', root))
});
console.log('Local collaboration assets synchronized');

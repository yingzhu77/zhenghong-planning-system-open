import { copyFile, mkdir, readFile } from 'node:fs/promises';
const source = new URL('../node_modules/quill/', import.meta.url);
const target = new URL('../web/vendor/quill/', import.meta.url);
const metadata = JSON.parse(await readFile(new URL('package.json', source), 'utf8'));
if (metadata.version !== '2.0.3') throw new Error('Unexpected editor version; review and update the pinned vendor assets together');
await mkdir(target, { recursive: true });
for (const name of ['quill.js', 'quill.core.css']) await copyFile(new URL('dist/' + name, source), new URL(name, target));
await copyFile(new URL('LICENSE', source), new URL('LICENSE.txt', target));
console.log('Local editor assets synchronized: Quill ' + metadata.version);

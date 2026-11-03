import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const rules = readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/);
const allowed = new Set(rules.filter(line => line.startsWith('!/') && !line.endsWith('/')).map(line => line.slice(2)));
const paths = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8', windowsHide: true
}).split('\0').filter(Boolean))];
const issues = [];
const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['api-key', /\bsk-[A-Za-z0-9_-]{32,}/],
  ['npm-token', /(?:_authToken|NODE_AUTH_TOKEN)\s*[=:]\s*["']?[A-Za-z0-9_-]{24,}/],
];
for (const name of paths) {
  if (!allowed.has(name)) issues.push({ path: name, kind: 'outside-exact-allowlist' });
  if (/(?:^|\/)(?:\.local|\.private|backups|source-data|secrets|uploads)(?:\/|$)/.test(name)
      || /\.(?:pem|key|dump|sqlite3?|db|xlsx?|csv|zip|gz)$/i.test(name)
      || /(?:^|\/)\.env(?:$|\.)/.test(name) && name !== '.env.example') {
    issues.push({ path: name, kind: 'private-material-path' });
  }
  const absolute = path.join(root, name);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    issues.push({ path: name, kind: 'not-a-regular-file' });
    continue;
  }
  if (/\.(?:png|jpg|jpeg|webp|avif|gif|ico)$/i.test(name)) continue;
  const lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [kind, pattern] of patterns) if (pattern.test(line)) issues.push({ path: name, line: index + 1, kind });
  });
}
if (issues.length) {
  console.error(JSON.stringify({ status: 'rejected', issues }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: 'passed', checkedFiles: paths.length, warning: 'Pattern checks do not replace content review.' }));
}

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/setup-env.mjs [--output PATH]\nCreates a new .env; never overwrites an existing file.');
  process.exit(0);
}
if (args.length && (args.length !== 2 || args[0] !== '--output')) {
  console.error('Use --help for usage.');
  process.exit(1);
}
const destination = args.length ? resolve(args[1]) : resolve(root, '.env');
const secret = () => randomBytes(32).toString('hex');
const content = `# Generated locally; do not commit or publish.\nCOMPOSE_PROJECT_NAME=planning-system\nAPP_IMAGE=planning-system-api:local\nPOSTGRES_DB=planning\nPOSTGRES_PASSWORD=${secret()}\nAPP_DB_PASSWORD=${secret()}\nSESSION_SECRET=${secret()}\nAPP_PORT=8080\nBIND_ADDRESS=127.0.0.1\nAPP_ORIGIN=http://localhost:8080\nCOOKIE_SECURE=false\nTRUST_PROXY=false\nSESSION_IDLE_HOURS=12\nUPLOADS_VOLUME=planning-system_uploads\nSMTP_HOST=\nSMTP_PORT=587\nSMTP_SECURE=false\nSMTP_USER=\nSMTP_PASSWORD=\nSMTP_FROM=\n`;
try {
  writeFileSync(destination, content, { flag: 'wx', mode: 0o600 });
  console.log(`Created ${destination}; credentials are not printed.`);
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'File already exists; no credentials were changed.' : error.message);
  process.exitCode = 1;
}

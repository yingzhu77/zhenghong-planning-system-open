import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, compose, config, checksum, dbCommand } from '../deploy/lib.mjs';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/backup.mjs [NEW_BACKUP_DIRECTORY]\nBriefly stops the API, dumps the running database and uploads, then restarts the API. Existing backup directories are never overwritten.');
  process.exit(0);
}
if (process.argv.length > 3) {
  console.error('Use --help for usage.');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = resolve(process.argv[2] || resolve(root, 'backups', stamp));
let restartApi = false;
try {
  const resolved = config();
  const database = resolved.services.db.environment.POSTGRES_DB;
  const running = compose(['ps', '--status', 'running', '--services'], { capture: true }).trim().split(/\r?\n/);
  if (!running.includes('db')) throw new Error('Database service is not running. Start it before taking a backup.');
  mkdirSync(resolve(destination, '..'), { recursive: true });
  mkdirSync(destination, { mode: 0o700 });
  if (running.includes('api')) {
    restartApi = true;
    compose(['stop', '-t', '30', 'api']);
  }
  const dump = resolve(destination, 'database.dump');
  const uploads = resolve(destination, 'uploads.tar.gz');
  dbCommand(database, 'pg_dump', ['--format=custom', '--no-owner'], { outputFile: dump });
  compose(['exec', '-T', 'db', 'pg_restore', '--list'], { inputFile: dump, capture: true });
  compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'api', '-czf', '-', '-C', '/app/uploads', '.'], { outputFile: uploads });
  const files = {};
  for (const name of ['database.dump', 'uploads.tar.gz']) {
    const path = resolve(destination, name);
    files[name] = { bytes: statSync(path).size, sha256: await checksum(path) };
  }
  const manifest = {
    format: 'zhenghong-backup-v1',
    createdAt: new Date().toISOString(),
    database,
    databaseImage: resolved.services.db.image,
    uploadsVolume: resolved.volumes.uploads.name,
    applicationWasStopped: restartApi,
    databaseVersion: dbCommand(database, 'psql', ['-At', '-c', 'SHOW server_version;'], { capture: true }).trim(),
    files,
  };
  writeFileSync(resolve(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`Backup complete: ${destination}`);
} catch (error) {
  console.error(`Backup failed: ${error.message}\nIncomplete files, if any, remain at ${destination}; no complete manifest is written on failure.`);
  process.exitCode = 1;
} finally {
  if (restartApi) {
    try { compose(['start', 'api']); }
    catch (error) { console.error(`Restart API manually: ${error.message}`); process.exitCode = 1; }
  }
}

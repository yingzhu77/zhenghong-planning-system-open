import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, docker, compose, config, checksum, dbCommand } from '../deploy/lib.mjs';

if (process.argv.includes('--help') || process.argv.length < 3) {
  console.log('Usage: node scripts/restore.mjs BACKUP_DIRECTORY [NEW_DATABASE_NAME]\nChecks SHA256, then restores to a NEW database and a NEW uploads volume. Never overwrites the active database or uploads. Prints the configuration changes needed to switch.');
  process.exit(process.argv.includes('--help') ? 0 : 1);
}
if (process.argv.length > 4) {
  console.error('Use --help for usage.');
  process.exit(1);
}

try {
  const directory = resolve(process.argv[2]);
  const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'zhenghong-backup-v1') throw new Error('Unsupported or incomplete backup manifest.');
  for (const name of ['database.dump', 'uploads.tar.gz']) {
    const file = resolve(directory, name);
    const expected = manifest.files?.[name];
    if (!expected || statSync(file).size !== expected.bytes || await checksum(file) !== expected.sha256) {
      throw new Error(`${name}: SHA256 or size mismatch. Nothing was restored.`);
    }
  }
  const resolved = config();
  const sourceDatabase = resolved.services.db.environment.POSTGRES_DB;
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17);
  const newDatabase = process.argv[3] || `zhweekly_restore_${stamp}`;
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(newDatabase)) throw new Error('Use a lowercase database identifier, at most 63 characters.');
  if (newDatabase === sourceDatabase) throw new Error('The active database cannot be a restore target. Choose a NEW database name.');
  const newVolume = `${resolved.name}_uploads_restore_${stamp}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(newVolume)) throw new Error('Invalid Compose project name for a restore volume.');
  const exists = dbCommand('postgres', 'psql', ['-At', '-c', `SELECT 1 FROM pg_database WHERE datname = '${newDatabase}';`], { capture: true }).trim();
  if (exists) throw new Error(`Database ${newDatabase} already exists; nothing will be overwritten.`);
  const volumes = docker(['volume', 'ls', '--format', '{{.Name}}'], { capture: true }).trim().split(/\r?\n/);
  if (volumes.includes(newVolume)) throw new Error(`Volume ${newVolume} already exists; nothing will be overwritten.`);
  const dump = resolve(directory, 'database.dump');
  const uploads = resolve(directory, 'uploads.tar.gz');
  // pg_restore --list does not connect or modify a database.
  compose(['exec', '-T', 'db', 'pg_restore', '--list'], { inputFile: dump, capture: true });
  const members = compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'api', '-tzf', '-'], { inputFile: uploads, capture: true });
  for (const member of members.trim().split(/\r?\n/)) {
    if (!member || member.startsWith('/') || member.includes('\\') || member.split('/').includes('..')) throw new Error('Unsafe archive path. Nothing was restored.');
  }
  const listing = compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'api', '-tvzf', '-'], { inputFile: uploads, capture: true });
  if (listing.trim().split(/\r?\n/).some(line => !['-', 'd'].includes(line[0]))) throw new Error('Backup contains links or special files; only regular files and directories are supported.');
  dbCommand('postgres', 'psql', ['-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE "${newDatabase}" TEMPLATE template0;`]);
  console.log(`Restoring database ${newDatabase}...`);
  dbCommand(newDatabase, 'pg_restore', ['--no-owner', '--exit-on-error', '--single-transaction'], { inputFile: dump });
  dbCommand('postgres', 'psql', ['-v', 'ON_ERROR_STOP=1', '-c', `REVOKE CONNECT ON DATABASE "${newDatabase}" FROM PUBLIC; GRANT CONNECT ON DATABASE "${newDatabase}" TO app_runtime;`]);
  docker(['volume', 'create', newVolume], { capture: true });
  compose(['run', '--rm', '--no-deps', '-T', '--user', '0:0', '--volume', `${newVolume}:/restore`, '--entrypoint', 'sh', 'api', '-c', 'tar -xzf - -C /restore && chown -R 1000:1000 /restore'], { inputFile: uploads });
  const note = {
    restoredAt: new Date().toISOString(),
    backup: directory,
    previousDatabase: sourceDatabase,
    previousUploadsVolume: resolved.volumes.uploads.name,
    POSTGRES_DB: newDatabase,
    UPLOADS_VOLUME: newVolume,
  };
  const notePath = resolve(root, `restore-${stamp}-switch.json`);
  writeFileSync(notePath, `${JSON.stringify(note, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`Restore complete; the running API still uses its original database and uploads.\nTo switch, edit .env:\nPOSTGRES_DB=${newDatabase}\nUPLOADS_VOLUME=${newVolume}\nThen run: docker compose up -d --force-recreate\nVerify login, reports and attachments. Rollback uses the previous two values recorded in ${notePath}.\nNo old database or volume was deleted.`);
} catch (error) {
  console.error(`Restore failed: ${error.message}\nThe active database and uploads were not replaced. Any new partial restore is retained for inspection.`);
  process.exitCode = 1;
}

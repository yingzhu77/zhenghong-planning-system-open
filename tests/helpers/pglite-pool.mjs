import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

// Current API fixtures use the latest schema. Migration-specific checks can
// explicitly select an older baseline without weakening normal test coverage.
export async function initializedDatabase({ through = 35 } = {}) {
  const db = new PGlite();
  await db.exec('CREATE ROLE app_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS');
  for (const name of ['001-schema.sql', '002-import.sql', '003-security.sql', '004-auth.sql',
    '005-rich-text.sql', '006-reporter-tasks.sql', '007-completion-review.sql', '008-report-attachments.sql', '009-commercial-test-access.sql',
    '010-first-password-change.sql', '011-project-manager-scope.sql', '012-commercial-module-split.sql',
    '013-operator-meetings.sql', '014-completion-extensions.sql', '015-admin-plan-scopes.sql', '016-coordination-origin-review.sql',
    '017-independent-coordination.sql', '018-monthly-plans.sql',
    '019-meeting-categories.sql', '020-project-library.sql', '021-report-scopes.sql',
    '022-coordination-rich-text.sql', '023-completion-rich-text.sql', '024-management-viewers.sql', '025-monthly-module-format.sql', '026-residential-monthly-plans.sql', '027-monthly-plan-withdrawal.sql', '028-planning-ai-memory.sql', '029-scoped-residential-monthly-plans.sql', '030-merged-professional-reporting.sql', '031-admin-individual-monthly-plans.sql', '032-hongfang-design-department.sql', '033-monthly-plan-summaries.sql', '035-admin-monthly-batch-withdrawal.sql']) {
    if (Number(name.slice(0, 3)) > through) break;
    await db.exec(await readFile(new URL('../../db/' + name, import.meta.url), 'utf8'));
  }
  return db;
}

// PGlite provides one Postgres connection. Serialize borrowers and SET ROLE for
// every borrowed connection to exercise the same RLS role as production pg.Pool.
export function testPool(db, role = 'app_runtime') {
  let tail = Promise.resolve();
  return {
    async connect() {
      const previous = tail;
      let unlock;
      tail = new Promise((resolve) => { unlock = resolve; });
      await previous;
      try { await db.exec(role ? 'SET ROLE ' + role : 'RESET ROLE'); }
      catch (error) { unlock(); throw error; }
      let released = false;
      return {
        query(q, values) { return db.query(typeof q === 'string' ? q : q.text, typeof q === 'string' ? values : q.values); },
        release() { if (!released) { released = true; unlock(); } }
      };
    },
    async query(q, values) {
      const client = await this.connect();
      try { return await client.query(q, values); } finally { client.release(); }
    },
    async end() { await tail; }
  };
}

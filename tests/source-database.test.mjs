import test from 'node:test';
import assert from 'node:assert/strict';
import { initializedDatabase } from './helpers/pglite-pool.mjs';

test('source initialization creates the complete empty schema without business data or accounts', async (t) => {
  const db = await initializedDatabase();
  t.after(() => db.close());
  const expected = ['projects', 'profiles', 'project_members', 'org', 'plan_versions',
    'plan_changes', 'milestones', 'reports', 'leader_reviews', 'leader_notes',
    'project_master', 'project_phases', 'project_drawings', 'reporter_tasks',
    'completion_requests', 'report_attachments', 'report_attachment_links', 'coordination_tasks', 'monthly_plans',
    'project_library_documents', 'project_library_events', 'commercial_module_grants', 'monthly_plan_summaries'].sort();
  const tables = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
  assert.deepEqual(tables.rows.map(row => row.table_name), expected);
  for (const table of expected) {
    assert.equal((await db.query(`SELECT count(*)::integer AS n FROM public.${table}`)).rows[0].n, 0, table);
  }
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM app_private.auth_users')).rows[0].n, 0);
  const roles = await db.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='app_runtime'");
  assert.deepEqual(roles.rows, [{ rolsuper: false, rolbypassrls: false }]);
  await db.exec('SET ROLE app_runtime');
  assert.equal((await db.query('SELECT * FROM public.projects')).rows.length, 0);
  await assert.rejects(db.exec('CREATE ROLE source_test_forbidden'), /permission denied|CREATEROLE/);
});

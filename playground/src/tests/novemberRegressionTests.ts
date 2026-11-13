import type { CapacitorSqlitePlugin } from '../../../src/definitions.js';
import { assertEqual, assertFail, assertOk, skipTest, type TestCase } from '../helpers/testRunner.js';

export function buildNovemberRegressionTests(api: CapacitorSqlitePlugin): TestCase[] {
  const withDatabase = (suffix: string, fn: (database: string) => Promise<void>) => async () => {
    const database = `suite_november_${suffix}`;
    assertOk(await api.open({ database }), 'open');
    try {
      await fn(database);
    } finally {
      assertOk(await api.close({ database }), 'close');
    }
  };
  return [
    ...['execute', 'runBatch', 'runMany', 'migration'].map((method): TestCase => ({
      id: `november-guard-${method}`,
      group: 'Regression',
      name: `${method} rejects transaction control behind a CR comment before writing`,
      fn: withDatabase(`guard_${method}`, async (database) => {
        assertOk(await api.execute({ database, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t(v)'] }), 'setup');
        const hidden = '-- c\r\u200b\ufeff-- c\nEND';
        const statements = ['INSERT INTO t VALUES(1)', hidden, 'INSERT INTO missing_table VALUES(1)'];
        const version = assertOk(await api.getSchemaVersion({ database }), 'version').version + 1;
        const result = method === 'execute'
          ? await api.execute({ database, statements })
          : method === 'runBatch'
            ? await api.runBatch({ database, set: statements.map((statement) => ({ statement })) })
            : method === 'runMany'
              ? await api.runMany({ database, statement: hidden, values: [[]] })
              : await api.open({ database, migrations: [{ version, statements: [statements[0]] }, { version: version + 1, statements: [hidden] }] });
        assertFail(result, 'guard', method === 'migration' ? 'MIGRATION_FAILED' : 'INVALID_PARAMS');
        assertEqual(assertOk(await api.query<{ n: number }>({ database, statement: 'SELECT count(*) AS n FROM t' }), 'count').rows[0].n, 0, 'no write committed');
      }),
    })),
    {
      id: 'november-cr-comment', group: 'Regression', name: 'CR inside a line comment does not create statements or binds',
      fn: withDatabase('comment', async (database) => {
        const result = assertOk(await api.query<{ v: number }>({ database, statement: 'SELECT ? AS v -- c\r; SELECT ? @ignored', values: [7] }), 'query');
        assertEqual(result.rows[0].v, 7, 'one real parameter');
      }),
    },
    {
      id: 'november-conflict-column', group: 'Regression', name: 'A conflict column does not suppress the inserted row ID',
      fn: withDatabase('conflict', async (database) => {
        assertOk(await api.execute({ database, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t(id INTEGER PRIMARY KEY, conflict)'] }), 'setup');
        const result = assertOk(await api.run({ database, statement: 'INSERT INTO t(conflict) VALUES(?)', values: [9] }), 'insert');
        assertEqual(result.lastInsertId, 1, 'row ID');
      }),
    },
    {
      id: 'november-migration-preflight', group: 'Regression', name: 'Invalid later migration is rejected before the first version commits',
      fn: withDatabase('preflight', async (database) => {
        assertOk(await api.execute({ database, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t(v)'] }), 'setup');
        const current = assertOk(await api.getSchemaVersion({ database }), 'version').version;
        assertFail(await api.open({ database, migrations: [
          { version: current + 1, statements: ['INSERT INTO t VALUES(1)'] },
          { version: current + 2, statements: ['INSERT INTO t VALUES(2); INSERT INTO t VALUES(3)'] },
        ] }), 'invalid migration', 'MIGRATION_FAILED');
        assertEqual(assertOk(await api.getSchemaVersion({ database }), 'version').version, current, 'unchanged version');
        assertEqual(assertOk(await api.query<{ n: number }>({ database, statement: 'SELECT count(*) AS n FROM t' }), 'count').rows[0].n, 0, 'no partial migration');
      }),
    },
    ...[false, true].map((fail): TestCase => ({
      id: `november-rebuild-${fail}`, group: 'Regression', name: `Safe table rebuild preserves child data and restores FK enforcement (failure=${fail})`,
      fn: withDatabase(`rebuild_${fail}`, async (database) => {
        assertOk(await api.execute({ database, statements: [
          'DROP TABLE IF EXISTS child', 'DROP TABLE IF EXISTS parent_new', 'DROP TABLE IF EXISTS parent',
          'CREATE TABLE parent(id INTEGER PRIMARY KEY)',
          'CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id REFERENCES parent(id) ON DELETE CASCADE)',
          'INSERT INTO parent VALUES(1)', 'INSERT INTO child VALUES(1,1)',
        ] }), 'setup');
        const version = assertOk(await api.getSchemaVersion({ database }), 'version').version + 1;
        assertOk(await api.execute({ database, transaction: false, statements: ['PRAGMA foreign_keys=OFF'] }), 'disable FK');
        try {
          const result = await api.open({ database, migrations: [{ version, statements: [
            'CREATE TABLE parent_new(id INTEGER PRIMARY KEY, extra TEXT)',
            'INSERT INTO parent_new(id) SELECT id FROM parent', 'DROP TABLE parent',
            'ALTER TABLE parent_new RENAME TO parent', ...(fail ? ['INSERT INTO missing_table VALUES(1)'] : []),
          ] }] });
          if (fail) assertFail(result, 'failed rebuild', 'MIGRATION_FAILED');
          else assertOk(result, 'rebuild');
          assertEqual(assertOk(await api.query({ database, statement: 'PRAGMA foreign_key_check' }), 'FK check').rows.length, 0, 'no FK violations');
        } finally {
          assertOk(await api.execute({ database, transaction: false, statements: ['PRAGMA foreign_keys=ON'] }), 'restore FK');
        }
        assertEqual(assertOk(await api.query<{ n: number }>({ database, statement: 'SELECT count(*) AS n FROM child' }), 'child').rows[0].n, 1, 'child survives');
        assertFail(await api.run({ database, statement: 'INSERT INTO child VALUES(2,999)' }), 'FK enforced');
      }),
    })),
    ...[true, false].map((transaction): TestCase => ({
      id: `november-returning-${transaction}`, group: 'Regression', name: `All run methods drain RETURNING (transaction=${transaction})`,
      fn: withDatabase(`returning_${transaction}`, async (database) => {
        const version = assertOk(await api.getVersion({ database }), 'SQLite version').version.split('.').map(Number);
        if (version[0] < 3 || (version[0] === 3 && version[1] < 35)) skipTest('SQLite RETURNING requires 3.35+');
        assertOk(await api.execute({ database, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t(id INTEGER PRIMARY KEY, v UNIQUE)'] }), 'setup');
        assertEqual(assertOk(await api.run({ database, statement: 'INSERT INTO t VALUES(1,10),(2,20) RETURNING id' }), 'run').changes, 2, 'insert changes');
        assertEqual(assertOk(await api.run({ database, statement: 'UPDATE t SET v=v+1 RETURNING id' }), 'update').changes, 2, 'update changes');
        assertEqual(assertOk(await api.runBatch({ database, transaction, set: [{ statement: 'DELETE FROM t RETURNING id' }] }), 'batch').changes, 2, 'delete changes');
        for (const returnResults of [false, true]) {
          assertOk(await api.execute({ database, statements: ['DELETE FROM t'] }), 'clear');
          const many = assertOk(await api.runMany({ database, transaction, returnResults, statement: 'INSERT INTO t VALUES(?,?) RETURNING id', values: [[1,10],[2,20]] }), 'many');
          assertEqual(many.changes, 2, 'many changes');
          if (returnResults) assertEqual(many.results?.length, 2, 'per item results');
        }
      }),
    })),
  ];
}

import type { CapacitorSqlitePlugin } from '../../../src/definitions.js';
import { assertEqual, assertFail, assertOk, type TestCase } from '../helpers/testRunner.js';

// These cases preserve the data/state failures from the 2026-10-29 audit across every backend.
export function buildAuditRegressionTests(api: CapacitorSqlitePlugin): TestCase[] {
  const withDatabase = (suffix: string, fn: (database: string) => Promise<void>) => async () => {
    const database = `suite_audit3_${suffix}`;
    assertOk(await api.open({ database }), 'open');
    try {
      await fn(database);
    } finally {
      assertOk(await api.close({ database }), 'close');
    }
  };
  return [
    ...['query', 'migration'].map((method): TestCase => ({
      id: `audit3-rowid-error-${method}`,
      group: 'Regression',
      name: `Failed ${method} refreshes connection rowid metadata`,
      fn: withDatabase(`rowid_error_${method}`, async (database) => {
        assertOk(
          await api.execute({
            database,
            statements: [
              'DROP TABLE IF EXISTS ordinary',
              'DROP TABLE IF EXISTS no_rowid',
              'CREATE TABLE ordinary(v INTEGER UNIQUE)',
              'CREATE TABLE no_rowid(id TEXT PRIMARY KEY) WITHOUT ROWID',
            ],
          }),
          'setup',
        );
        const version = assertOk(await api.getSchemaVersion({ database }), 'schema version').version + 1;
        const failed =
          method === 'query'
            ? await api.query({ database, statement: 'INSERT OR FAIL INTO ordinary VALUES (1), (1) RETURNING rowid' })
            : await api.open({
                database,
                migrations: [
                  {
                    version,
                    statements: ['INSERT INTO ordinary VALUES (1)', 'INSERT INTO nonexistent_audit_table VALUES (1)'],
                  },
                ],
              });
        assertFail(failed, 'failure after attempted insert');
        const inserted = assertOk(
          await api.run({ database, statement: "INSERT INTO no_rowid VALUES ('key')" }),
          'insert without rowid',
        );
        assertEqual(inserted.lastInsertId, 0, 'no stale rowid after failed query/migration');
      }),
    })),
    ...['execute', 'runBatch', 'runMany', 'migration'].map((method): TestCase => ({
      id: `audit3-managed-${method}`,
      group: 'Regression',
      name: `${method} rejects inner COMMIT before changing data`,
      fn: withDatabase(`managed_${method}`, async (database) => {
        assertOk(
          await api.execute({ database, statements: ['DROP TABLE IF EXISTS atomic_t', 'CREATE TABLE atomic_t(v)'] }),
          'setup',
        );
        const statements = [
          'INSERT INTO atomic_t VALUES (1)',
          'COMMIT',
          'INSERT INTO nonexistent_audit_table VALUES (1)',
        ];
        const result =
          method === 'execute'
            ? await api.execute({ database, statements })
            : method === 'runBatch'
              ? await api.runBatch({ database, set: statements.map((statement) => ({ statement })) })
              : method === 'runMany'
                ? await api.runMany({ database, statement: 'COMMIT', values: [[]] })
                : await api.open({ database, migrations: [{ version: 1, statements }] });
        assertFail(
          result,
          'transaction boundary rejected',
          method === 'migration' ? 'MIGRATION_FAILED' : 'INVALID_PARAMS',
        );
        assertEqual(
          assertOk(
            await api.query<{ n: number }>({ database, statement: 'SELECT COUNT(*) AS n FROM atomic_t' }),
            'unchanged',
          ).rows[0].n,
          0,
          'no early commit',
        );
      }),
    })),
    {
      id: 'audit3-cte',
      group: 'Regression',
      name: 'Incomplete CTE returns an error without crashing',
      fn: withDatabase('cte', async (database) => {
        for (const statement of ['WITH x ', 'WITH x /* end */', 'WITH RECURSIVE x\n']) {
          assertFail(await api.query({ database, statement }), 'incomplete CTE');
        }
        assertEqual(
          assertOk(await api.query<{ n: number }>({ database, statement: 'SELECT 1 AS n' }), 'still usable').rows[0].n,
          1,
          'connection remains usable',
        );
      }),
    },
    ...['execute', 'run', 'query', 'runBatch', 'runMany', 'migration'].map((method): TestCase => ({
      id: `audit3-unicode-${method}`,
      group: 'Regression',
      name: `${method} preserves the statement boundary after a combining mark`,
      fn: withDatabase(`unicode_${method}`, async (database) => {
        assertOk(
          await api.execute({
            database,
            statements: ['DROP TABLE IF EXISTS guard_t', 'CREATE TABLE guard_t(v)', 'INSERT INTO guard_t VALUES (1)'],
          }),
          'setup',
        );
        // SQLite sees a complete string and an alias; Swift Character used to merge the closing quote with the accent.
        const statement = "SELECT 'a'\u0301; DELETE FROM guard_t";
        const result =
          method === 'execute'
            ? await api.execute({ database, statements: [statement] })
            : method === 'run'
              ? await api.run({ database, statement })
              : method === 'query'
                ? await api.query({ database, statement })
                : method === 'runBatch'
                  ? await api.runBatch({ database, set: [{ statement }] })
                  : method === 'runMany'
                    ? await api.runMany({ database, statement, values: [[]] })
                    : await api.open({ database, migrations: [{ version: 1, statements: [statement] }] });
        assertFail(result, 'second statement rejected', method === 'migration' ? 'MIGRATION_FAILED' : 'INVALID_PARAMS');
        assertEqual(
          assertOk(
            await api.query<{ n: number }>({ database, statement: 'SELECT COUNT(*) AS n FROM guard_t' }),
            'unchanged',
          ).rows[0].n,
          1,
          'second statement never executes',
        );
      }),
    })),
    ...[true, false].map((transaction): TestCase => ({
      id: `audit3-schema-${transaction}`,
      group: 'Regression',
      name: `Batch prepares schema-dependent SQL in order (transaction=${transaction})`,
      fn: withDatabase(`schema_${transaction}`, async (database) => {
        assertOk(await api.execute({ database, statements: ['DROP TABLE IF EXISTS dependent'] }), 'reset');
        assertOk(
          await api.runBatch({
            database,
            transaction,
            set: [
              { statement: 'CREATE TABLE dependent(v INTEGER)' },
              { statement: 'INSERT INTO dependent VALUES (?)', values: [1] },
              { statement: 'ALTER TABLE dependent ADD COLUMN note TEXT' },
              { statement: 'UPDATE dependent SET note=?', values: ['saved'] },
            ],
          }),
          'dependent batch',
        );
        assertEqual(
          assertOk(await api.query<{ note: string }>({ database, statement: 'SELECT note FROM dependent' }), 'read')
            .rows[0].note,
          'saved',
          'new column updated',
        );
      }),
    })),
    {
      id: 'audit3-prepare-effects',
      group: 'Regression',
      name: 'Failed transactional batch does not disable foreign keys during prepare',
      fn: withDatabase('prepare_effects', async (database) => {
        assertFail(
          await api.runBatch({
            database,
            set: [
              { statement: 'PRAGMA foreign_keys=OFF' },
              { statement: 'INSERT INTO nonexistent_audit_table VALUES (1)' },
            ],
          }),
          'batch fails',
        );
        assertEqual(
          assertOk(
            await api.query<{ foreign_keys: number }>({ database, statement: 'PRAGMA foreign_keys' }),
            'foreign keys',
          ).rows[0].foreign_keys,
          1,
          'foreign keys stay enabled',
        );
      }),
    },
    {
      id: 'audit3-transaction-state',
      group: 'Regression',
      name: 'Raw transaction statements agree with transaction methods',
      fn: withDatabase('transaction_state', async (database) => {
        assertOk(await api.execute({ database, statements: ['BEGIN'], transaction: false }), 'raw begin');
        assertOk(await api.rollbackTransaction({ database }), 'API rollback');
        assertOk(await api.beginTransaction({ database }), 'API begin');
        assertOk(await api.run({ database, statement: 'COMMIT' }), 'raw commit');
        assertOk(await api.beginTransaction({ database }), 'begin after raw commit');
        assertOk(await api.rollbackTransaction({ database }), 'cleanup');
      }),
    },
    ...[true, false].map((transaction): TestCase => ({
      id: `audit3-rowid-${transaction}`,
      group: 'Regression',
      name: `Failed execute refreshes rowid metadata (transaction=${transaction})`,
      fn: withDatabase(`rowid_${transaction}`, async (database) => {
        assertOk(
          await api.execute({
            database,
            statements: [
              'DROP TABLE IF EXISTS ordinary',
              'DROP TABLE IF EXISTS no_rowid',
              'CREATE TABLE ordinary(v)',
              'CREATE TABLE no_rowid(id TEXT PRIMARY KEY) WITHOUT ROWID',
            ],
          }),
          'setup',
        );
        assertFail(
          await api.execute({
            database,
            transaction,
            statements: ['INSERT INTO ordinary VALUES (1)', 'INSERT INTO nonexistent_audit_table VALUES (1)'],
          }),
          'partial failure',
        );
        const inserted = assertOk(
          await api.run({ database, statement: "INSERT INTO no_rowid VALUES ('key')" }),
          'insert without rowid',
        );
        assertEqual(inserted.lastInsertId, 0, 'no unrelated rowid');
      }),
    })),
    {
      id: 'audit3-identifiers',
      group: 'Regression',
      name: 'Unicode CTE and dollar-containing column names stay valid SQL',
      fn: withDatabase('identifiers', async (database) => {
        const result = assertOk(
          await api.query<{ n: number }>({
            database,
            statement: 'WITH český AS (SELECT ? AS n) SELECT n FROM český',
            values: [7],
          }),
          'Unicode CTE',
        );
        assertEqual(result.rows[0].n, 7, 'Unicode CTE result');
        assertOk(
          await api.execute({
            database,
            statements: ['DROP TABLE IF EXISTS dollars', 'CREATE TABLE dollars(a$b INTEGER)'],
          }),
          'setup',
        );
        assertOk(
          await api.run({ database, statement: 'INSERT INTO dollars(a$b) VALUES (?)', values: [9] }),
          'dollar insert',
        );
        assertEqual(
          assertOk(
            await api.query<{ n: number }>({ database, statement: 'SELECT a$b AS n FROM dollars' }),
            'dollar select',
          ).rows[0].n,
          9,
          'dollar identifier result',
        );
      }),
    },
    ...[true, false].map((transaction): TestCase => ({
      id: `audit3-many-counter-${transaction}`,
      group: 'Regression',
      name: `Repeated runMany reports only its own writes (transaction=${transaction})`,
      fn: withDatabase(`counter_${transaction}`, async (database) => {
        // A persistent database enables Android WAL and its separate reader/writer connections.
        assertOk(
          await api.execute({
            database,
            statements: [
              'DROP TABLE IF EXISTS counters',
              'CREATE TABLE counters(v)',
              'INSERT INTO counters VALUES (0), (1), (2)',
            ],
          }),
          'seed',
        );
        for (let index = 0; index < 2; index++) {
          const result = assertOk(
            await api.runMany({
              database,
              statement: 'INSERT INTO counters VALUES (?)',
              values: [[3], [4]],
              transaction,
              returnResults: true,
            }),
            'runMany',
          );
          assertEqual(result.changes, 2, 'aggregate changes');
          assertEqual(
            result.results?.reduce((total, item) => total + item.changes, 0),
            2,
            'item changes',
          );
        }
      }),
    })),
  ];
}

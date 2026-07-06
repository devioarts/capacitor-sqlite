const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  assertSingleSqlStatement,
  hasMultipleSqlStatements,
  isInsertStatement,
  sqlStatementType,
} = require('../build/test-p0/sql.js');

test('allows a single statement with optional trailing semicolons and comments', () => {
  assert.equal(hasMultipleSqlStatements('SELECT 1'), false);
  assert.equal(hasMultipleSqlStatements('SELECT 1;'), false);
  assert.equal(hasMultipleSqlStatements('SELECT 1; ; -- done'), false);
  assert.equal(hasMultipleSqlStatements("SELECT ';' AS semi; /* done */"), false);
});

test('ignores semicolons inside strings, quoted identifiers, and comments', () => {
  assert.equal(hasMultipleSqlStatements("SELECT 'a; b'"), false);
  assert.equal(hasMultipleSqlStatements('SELECT "weird; name" FROM t'), false);
  assert.equal(hasMultipleSqlStatements('SELECT [semi;name] FROM t'), false);
  assert.equal(hasMultipleSqlStatements('SELECT 1 /* ; */'), false);
  assert.equal(hasMultipleSqlStatements('SELECT 1 -- ;\n'), false);
});

test('rejects multiple statements after a real semicolon', () => {
  assert.equal(hasMultipleSqlStatements('SELECT 1; SELECT 2'), true);
  assert.equal(hasMultipleSqlStatements('CREATE TABLE a(id); CREATE TABLE b(id)'), true);
  assert.throws(
    () => assertSingleSqlStatement('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)', 'statement'),
    /exactly one SQL statement/,
  );
});

test('treats a trigger BEGIN...END body as a single statement', () => {
  assert.equal(
    hasMultipleSqlStatements(
      'CREATE TRIGGER trg_count AFTER INSERT ON items BEGIN UPDATE item_count SET n = n + 1; END',
    ),
    false,
  );
  assert.equal(
    hasMultipleSqlStatements(
      'CREATE TRIGGER trg_multi AFTER INSERT ON t BEGIN UPDATE a SET x = 1; UPDATE b SET y = 2; END',
    ),
    false,
  );
  assert.equal(
    hasMultipleSqlStatements("CREATE TRIGGER trg_case BEFORE UPDATE ON t BEGIN SELECT CASE WHEN NEW.x > 0 THEN 1 ELSE 0 END; END"),
    false,
  );
  // Must not throw — this is exactly one SQL statement despite the internal semicolons.
  assertSingleSqlStatement(
    'CREATE TRIGGER trg_count AFTER INSERT ON items BEGIN UPDATE item_count SET n = n + 1; END',
    'statement',
  );
});

test('still rejects a genuine second statement after a trigger body', () => {
  assert.equal(
    hasMultipleSqlStatements(
      'CREATE TRIGGER trg_count AFTER INSERT ON items BEGIN UPDATE item_count SET n = n + 1; END; SELECT 1',
    ),
    true,
  );
});

test('does not mistake identifiers containing BEGIN/END/CASE as keywords', () => {
  // begin_date/end_date/usecase must be read as whole identifiers, not as BEGIN/END/CASE
  // followed by leftover characters — a naive substring check would misfire here.
  assert.equal(
    hasMultipleSqlStatements('CREATE TABLE t (begin_date TEXT, end_date TEXT, usecase TEXT, casefile TEXT)'),
    false,
  );
  assert.equal(
    hasMultipleSqlStatements("INSERT INTO t (begin_date, end_date, usecase) VALUES ('a', 'b', 'c')"),
    false,
  );
  assert.equal(
    hasMultipleSqlStatements(
      'CREATE TRIGGER trg AFTER INSERT ON t BEGIN INSERT INTO log (usecase_note) VALUES (NEW.usecase); END',
    ),
    false,
  );
  // A real trailing statement after such identifiers must still be detected.
  assert.equal(
    hasMultipleSqlStatements('CREATE TABLE t (begin_date TEXT, end_date TEXT); SELECT 1'),
    true,
  );
});

test('a leading BEGIN (transaction) does not mask a following statement', () => {
  // A leading BEGIN is a transaction statement, not a trigger-body opener.
  assert.equal(hasMultipleSqlStatements('BEGIN; DROP TABLE t'), true);
  assert.equal(hasMultipleSqlStatements('BEGIN TRANSACTION; DROP TABLE t; COMMIT'), true);
  assert.equal(hasMultipleSqlStatements('/* lead */ BEGIN; DROP TABLE t'), true);
  // Standalone transaction statements stay single.
  assert.equal(hasMultipleSqlStatements('BEGIN'), false);
  assert.equal(hasMultipleSqlStatements('BEGIN TRANSACTION;'), false);
  // Trigger bodies (BEGIN not at statement start) keep working.
  assert.equal(
    hasMultipleSqlStatements('CREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE a SET x = 1; UPDATE b SET y = 2; END'),
    false,
  );
});

test('handles a trigger with a WHEN clause and nested CASE expressions', () => {
  assert.equal(
    hasMultipleSqlStatements(
      'CREATE TRIGGER trg_when AFTER UPDATE ON t WHEN NEW.balance < 0 BEGIN INSERT INTO log VALUES (NEW.id); END',
    ),
    false,
  );
  assert.equal(
    hasMultipleSqlStatements(
      "CREATE TRIGGER trg_nested AFTER INSERT ON t BEGIN INSERT INTO log VALUES (CASE WHEN NEW.a THEN (CASE WHEN NEW.b THEN 1 ELSE 2 END) ELSE 3 END); END",
    ),
    false,
  );
});

test('classifies statements after leading comments and CTEs', () => {
  assert.equal(sqlStatementType('/* lead */ INSERT INTO t VALUES (1)'), 'INSERT');
  assert.equal(sqlStatementType('-- lead\nREPLACE INTO t VALUES (1)'), 'REPLACE');
  assert.equal(sqlStatementType('WITH cte AS (SELECT 1) INSERT INTO t SELECT * FROM cte'), 'INSERT');
  assert.equal(
    sqlStatementType(
      'WITH RECURSIVE cte(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cte WHERE x < 2) SELECT * FROM cte',
    ),
    'SELECT',
  );
  assert.equal(
    sqlStatementType('WITH one AS NOT MATERIALIZED (SELECT 1), two AS (SELECT 2) UPDATE t SET v = 1'),
    'UPDATE',
  );
});

test('detects insert-like statements after comments and CTEs', () => {
  assert.equal(isInsertStatement('/* lead */ INSERT INTO t VALUES (1)'), true);
  assert.equal(isInsertStatement('WITH cte AS (SELECT 1) INSERT INTO t SELECT * FROM cte'), true);
  assert.equal(isInsertStatement('WITH cte AS (SELECT 1) SELECT * FROM cte'), false);
});

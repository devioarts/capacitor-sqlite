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

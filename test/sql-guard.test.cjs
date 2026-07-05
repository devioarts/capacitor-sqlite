const assert = require('node:assert/strict');
const { test } = require('node:test');

const { hasMultipleSqlStatements, assertSingleSqlStatement } = require('../build/test-p0/sql.js');

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

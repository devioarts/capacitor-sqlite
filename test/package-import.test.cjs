const assert = require('node:assert/strict');
const { test } = require('node:test');

test('the published root export loads in plain Node ESM without a bundler', async () => {
  // Import by package name so this checks exports.import and emitted relative paths together.
  const { CapacitorSqlite } = await import('@devioarts/capacitor-sqlite');
  assert.equal(typeof CapacitorSqlite.query, 'function');
  assert.equal(typeof CapacitorSqlite.runMany, 'function');
});

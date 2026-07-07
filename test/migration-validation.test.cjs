const assert = require('node:assert/strict');
const test = require('node:test');

const {
  findDuplicateMigrationVersion,
  isValidMigrationVersion,
  MAX_MIGRATION_VERSION,
} = require('../build/test-p2/migrations.js');

test('findDuplicateMigrationVersion returns null for unique versions', () => {
  assert.equal(findDuplicateMigrationVersion([{ version: 1 }, { version: 3 }, { version: 2 }]), null);
});

test('findDuplicateMigrationVersion reports duplicate version and later index', () => {
  assert.deepEqual(findDuplicateMigrationVersion([{ version: 1 }, { version: 2 }, { version: 1 }]), {
    version: 1,
    index: 2,
  });
});

test('MAX_MIGRATION_VERSION matches the 32-bit signed ceiling shared by every backend', () => {
  assert.equal(MAX_MIGRATION_VERSION, 2147483647);
});

test('isValidMigrationVersion accepts 1 and MAX_MIGRATION_VERSION', () => {
  assert.equal(isValidMigrationVersion(1), true);
  assert.equal(isValidMigrationVersion(MAX_MIGRATION_VERSION), true);
});

test('isValidMigrationVersion rejects a version one above the 32-bit ceiling', () => {
  // This is the exact value that used to silently wrap via `| 0` when written to
  // `PRAGMA user_version` on Web/Electron before validateMigrations() gained this check.
  assert.equal(isValidMigrationVersion(MAX_MIGRATION_VERSION + 1), false);
});

test('isValidMigrationVersion rejects non-positive, non-integer, and non-finite values', () => {
  assert.equal(isValidMigrationVersion(0), false);
  assert.equal(isValidMigrationVersion(-1), false);
  assert.equal(isValidMigrationVersion(1.5), false);
  assert.equal(isValidMigrationVersion(NaN), false);
  assert.equal(isValidMigrationVersion(Infinity), false);
  assert.equal(isValidMigrationVersion(Number.MAX_SAFE_INTEGER), false);
  assert.equal(isValidMigrationVersion('1'), false);
});

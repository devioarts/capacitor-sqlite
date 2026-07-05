const assert = require('node:assert/strict');
const test = require('node:test');

const { findDuplicateMigrationVersion } = require('../build/test-p2/migrations.js');

test('findDuplicateMigrationVersion returns null for unique versions', () => {
  assert.equal(findDuplicateMigrationVersion([{ version: 1 }, { version: 3 }, { version: 2 }]), null);
});

test('findDuplicateMigrationVersion reports duplicate version and later index', () => {
  assert.deepEqual(findDuplicateMigrationVersion([{ version: 1 }, { version: 2 }, { version: 1 }]), {
    version: 1,
    index: 2,
  });
});

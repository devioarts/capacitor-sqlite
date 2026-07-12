// Exercises the real worker_threads boundary used by CapacitorSqlite.dispose()
// (electron/src/index.ts) and worker.ts, independent of Electron itself — index.ts
// requires the real `electron` module (app.getPath) to build workerData.paths, which
// is not available in a plain Node test process, so this drives electron/dist/worker.cjs.js
// directly with fake paths instead of instantiating CapacitorSqlite.
//
// Covers: a worker started, used, and terminated (the core of dispose()) leaves no
// dangling process/handle, and a second worker can be spawned afterwards (the "safe to
// call again later; a fresh worker is spawned on demand" contract in dispose()'s doc
// comment). Requires `npm run build:electron` to have produced electron/dist/worker.cjs.js.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const workerFile = path.join(__dirname, '..', 'electron', 'dist', 'worker.cjs.js');
const settingsFile = path.join(__dirname, '..', 'electron', 'dist', 'plugin-settings.js');
const publicPluginFile = path.join(__dirname, '..', 'dist', 'plugin.cjs.js');

function withTempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capsqlite-worker-lifecycle-'));
  return { root, paths: { userData: root, temp: root } };
}

function spawnWorker(paths) {
  return new Worker(workerFile, { workerData: { paths } });
}

let nextId = 1;
function request(worker, method, options) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message.id !== id) return;
      worker.off('message', onMessage);
      resolve(message.result);
    };
    worker.on('message', onMessage);
    worker.once('error', reject);
    worker.postMessage({ id, method, options });
  });
}

test(
  'Electron plugin metadata exposes every public SQL method, including runMany',
  { skip: !fs.existsSync(settingsFile) },
  () => {
    const { pluginSettings } = require(settingsFile);
    const expected = ['run', 'runBatch', 'runMany', 'query'];
    for (const method of expected) {
      assert.equal(pluginSettings.pluginMethods.includes(method), true, `${method} missing from pluginSettings`);
    }
  },
);

test(
  'runMany remains correct with an Electron registry generated before runMany existed',
  { skip: !fs.existsSync(publicPluginFile) },
  async () => {
    const originalCapacitor = globalThis.Capacitor;
    const originalCustomPlatform = globalThis.CapacitorCustomPlatform;
    const calls = [];
    const ok = (data = {}) => ({ success: true, data });
    globalThis.CapacitorCustomPlatform = {
      name: 'electron',
      plugins: {
        CapacitorSqlite: {
          runMany: async () => {
            throw new Error('CapacitorSqlite.runMany() is not implemented on electron');
          },
          runBatch: async (options) => {
            calls.push(['runBatch', options.set.length]);
            return ok({ changes: options.set.length, lastInsertId: 0 });
          },
          beginTransaction: async () => ok(),
          commitTransaction: async () => ok(),
          rollbackTransaction: async () => ok(),
          run: async (options) => ok({ changes: 1, lastInsertId: Number(options.values[0]) }),
        },
      },
    };

    try {
      delete require.cache[require.resolve(publicPluginFile)];
      const { CapacitorSqlite } = require(publicPluginFile);
      const aggregate = await CapacitorSqlite.runMany({
        database: 'compat',
        statement: 'INSERT INTO t VALUES (?)',
        values: [[1], [2]],
      });
      assert.equal(aggregate.success, true);
      assert.equal(aggregate.data.changes, 2);
      assert.deepEqual(calls, [['runBatch', 2]]);

      const detailed = await CapacitorSqlite.runMany({
        database: 'compat',
        statement: 'INSERT INTO t VALUES (?)',
        values: [[3], [4]],
        returnResults: true,
      });
      assert.equal(detailed.success, true);
      assert.deepEqual(
        detailed.data.results.map((item) => item.lastInsertId),
        [3, 4],
      );

      const invalid = await CapacitorSqlite.runMany({
        database: 'compat',
        statement: 'INSERT INTO t VALUES (?)',
        values: [[1], [2, 3]],
        transaction: false,
      });
      assert.equal(invalid.success, false);
      assert.equal(invalid.error.code, 'INVALID_PARAMS');
      assert.deepEqual(calls, [['runBatch', 2]], 'prevalidation prevented a partial fallback write');
    } finally {
      if (originalCustomPlatform === undefined) delete globalThis.CapacitorCustomPlatform;
      else globalThis.CapacitorCustomPlatform = originalCustomPlatform;
      if (originalCapacitor === undefined) delete globalThis.Capacitor;
      else globalThis.Capacitor = originalCapacitor;
    }
  },
);

test(
  'a worker can be used and cleanly terminated (dispose() core mechanism)',
  { skip: !fs.existsSync(workerFile) },
  async () => {
    const temporary = withTempPaths();
    const worker = spawnWorker(temporary.paths);
    try {
      const database = 'lifecycle_test';
      const open = await request(worker, 'open', { database });
      assert.equal(open.success, true, `open failed: ${JSON.stringify(open)}`);

      const exec = await request(worker, 'execute', {
        database,
        statements: ['CREATE TABLE t (v INTEGER)', 'INSERT INTO t VALUES (1)'],
      });
      assert.equal(exec.success, true, `execute failed: ${JSON.stringify(exec)}`);

      const close = await request(worker, 'close', { database });
      assert.equal(close.success, true, `close failed: ${JSON.stringify(close)}`);
    } finally {
      const exitCode = await worker.terminate();
      assert.equal(typeof exitCode, 'number');
      fs.rmSync(temporary.root, { recursive: true, force: true });
    }
  },
);

test(
  'a fresh worker can be spawned again after a previous one was terminated',
  { skip: !fs.existsSync(workerFile) },
  async () => {
    const temporary = withTempPaths();
    const first = spawnWorker(temporary.paths);
    await request(first, 'isAvailable', undefined);
    await first.terminate();

    // dispose() nulls out the cached worker so the next request lazily spawns a new one —
    // simulate that here by just constructing a second Worker against the same paths.
    const second = spawnWorker(temporary.paths);
    try {
      const result = await request(second, 'isAvailable', undefined);
      assert.equal(result.success, true, `isAvailable failed on respawned worker: ${JSON.stringify(result)}`);
    } finally {
      await second.terminate();
      fs.rmSync(temporary.root, { recursive: true, force: true });
    }
  },
);

test(
  'graceful shutdown rolls back transactions, closes handles, and keeps the worker responsive',
  { skip: !fs.existsSync(workerFile) },
  async () => {
    const temporary = withTempPaths();
    const worker = spawnWorker(temporary.paths);
    const database = 'graceful_shutdown_test';
    try {
      assert.equal((await request(worker, 'open', { database })).success, true);
      assert.equal(
        (await request(worker, 'execute', { database, statements: ['CREATE TABLE t (v INTEGER)'] })).success,
        true,
      );
      assert.equal((await request(worker, 'beginTransaction', { database })).success, true);
      assert.equal(
        (await request(worker, 'run', { database, statement: 'INSERT INTO t VALUES (?)', values: [1] })).success,
        true,
      );

      const shutdown = await request(worker, '__shutdown', undefined);
      assert.equal(shutdown.success, true, `shutdown failed: ${JSON.stringify(shutdown)}`);

      const state = await request(worker, 'isOpen', { database });
      assert.equal(state.success, true);
      assert.equal(state.data.open, false, 'shutdown must clear the open-database registry');

      const query = await request(worker, 'query', { database, statement: 'SELECT * FROM t', values: [] });
      assert.equal(query.success, false, 'closed handles must not remain usable');
      assert.equal(query.error.code, 'DB_NOT_OPEN');
    } finally {
      await worker.terminate();
      fs.rmSync(temporary.root, { recursive: true, force: true });
    }
  },
);

test(
  'compact query worker path preserves columns, values, NULLs, and BLOBs',
  { skip: !fs.existsSync(workerFile) },
  async () => {
    const temporary = withTempPaths();
    const worker = spawnWorker(temporary.paths);
    const database = 'compact_query_test';
    try {
      assert.equal((await request(worker, 'open', { database })).success, true);
      assert.equal(
        (
          await request(worker, 'execute', {
            database,
            statements: ['CREATE TABLE t (id INTEGER, v TEXT, b BLOB)'],
          })
        ).success,
        true,
      );
      assert.equal(
        (
          await request(worker, 'run', {
            database,
            statement: 'INSERT INTO t VALUES (?, ?, ?)',
            values: [1, null, Uint8Array.from([0, 128, 255])],
          })
        ).success,
        true,
      );

      const result = await request(worker, '__queryCompact', {
        database,
        statement: 'SELECT id, v, b FROM t',
        values: [],
      });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.deepEqual(result.data.compactRows.columns, ['id', 'v', 'b']);
      assert.equal(result.data.compactRows.values.length, 1);
      assert.deepEqual(result.data.compactRows.values[0].slice(0, 2), [1, null]);
      assert.deepEqual(result.data.compactRows.values[0][2], Uint8Array.from([0, 128, 255]));
    } finally {
      await worker.terminate();
      fs.rmSync(temporary.root, { recursive: true, force: true });
    }
  },
);

test(
  'runMany reuses one SQL shape and optionally returns every row id',
  { skip: !fs.existsSync(workerFile) },
  async () => {
    const temporary = withTempPaths();
    const worker = spawnWorker(temporary.paths);
    const database = 'run_many_test';
    try {
      assert.equal((await request(worker, 'open', { database })).success, true);
      assert.equal(
        (
          await request(worker, 'execute', {
            database,
            statements: ['CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)'],
          })
        ).success,
        true,
      );
      const result = await request(worker, 'runMany', {
        database,
        statement: 'INSERT INTO t (v) VALUES (?)',
        values: [['a'], ['b'], ['c']],
        returnResults: true,
      });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.data.changes, 3);
      assert.equal(result.data.lastInsertId, 0);
      assert.deepEqual(
        result.data.results.map((item) => item.lastInsertId),
        [1, 2, 3],
      );
    } finally {
      await worker.terminate();
      fs.rmSync(temporary.root, { recursive: true, force: true });
    }
  },
);

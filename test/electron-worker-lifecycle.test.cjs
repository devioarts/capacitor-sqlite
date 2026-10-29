// Exercises the real worker boundary and main-process dispose() implementation.
// Electron's app.getPath() is stubbed; SQL, worker queues, and shutdown are real.
// Requires `npm run build` to produce both public and Electron bundles.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const vm = require('node:vm');

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
      worker.off('error', reject);
      resolve(message.result);
    };
    worker.on('message', onMessage);
    worker.once('error', reject);
    worker.postMessage({ id, method, options });
  });
}

test('dispose drains queued writes, is idempotent, rolls back and allows a fresh worker', async () => {
  const temporary = withTempPaths();
  const module = { exports: {} };
  const pluginFile = path.join(__dirname, '..', 'electron', 'dist', 'plugin.cjs.js');
  vm.runInNewContext(
    fs.readFileSync(pluginFile, 'utf8'),
    {
      module,
      exports: module.exports,
      __dirname: path.dirname(pluginFile),
      process,
      console,
      require: (id) => (id === 'electron' ? { app: { getPath: (name) => temporary.paths[name] } } : require(id)),
    },
    { filename: pluginFile },
  );
  const api = new module.exports.CapacitorSqlite();
  const database = 'graceful_dispose';
  try {
    assert.equal((await api.open({ database })).success, true);
    assert.equal((await api.execute({ database, statements: ['CREATE TABLE t(v INTEGER)'] })).success, true);
    const writes = Array.from({ length: 32 }, (_, i) =>
      api.run({ database, statement: 'INSERT INTO t VALUES (?)', values: [i] }),
    );
    const stopping = Promise.all([api.dispose(), api.dispose()]);
    for (const result of await Promise.all(writes)) assert.equal(result.success, true);
    await stopping;
    assert.equal((await api.open({ database })).success, true);
    assert.equal((await api.query({ database, statement: 'SELECT COUNT(*) AS n FROM t' })).data.rows[0].n, 32);
    assert.equal((await api.beginTransaction({ database })).success, true);
    assert.equal((await api.run({ database, statement: 'INSERT INTO t VALUES (999)' })).success, true);
    await api.dispose();
    assert.equal((await api.open({ database })).success, true);
    assert.equal((await api.query({ database, statement: 'SELECT COUNT(*) AS n FROM t' })).data.rows[0].n, 32);
  } finally {
    await api.dispose();
    await api.dispose();
    fs.rmSync(temporary.root, { recursive: true, force: true });
  }
});

test('both worker query paths recover transaction state after RETURNING rolls back', async () => {
  const temporary = withTempPaths();
  const worker = spawnWorker(temporary.paths);
  const database = ':memory:';
  const call = (method, options = {}) => request(worker, method, { database, ...options });
  try {
    assert.equal((await call('open')).success, true);
    assert.equal(
      (await call('execute', { statements: ['CREATE TABLE t(v INTEGER UNIQUE)', 'INSERT INTO t VALUES (1)'] })).success,
      true,
    );
    for (const method of ['query', '__queryCompact']) {
      assert.equal((await call('beginTransaction')).success, true);
      assert.equal((await call('run', { statement: 'INSERT INTO t VALUES (2)' })).success, true);
      assert.equal(
        (await call(method, { statement: 'INSERT OR ROLLBACK INTO t VALUES (1) RETURNING v' })).success,
        false,
      );
      assert.equal((await call('beginTransaction')).success, true);
      assert.equal((await call('rollbackTransaction')).success, true);
      assert.deepEqual((await call('query', { statement: 'SELECT v FROM t' })).data.rows, [{ v: 1 }]);
    }
  } finally {
    await request(worker, '__shutdown');
    await worker.terminate();
    fs.rmSync(temporary.root, { recursive: true, force: true });
  }
});

test('cache databases are isolated by app and keep a stable location across restarts', async () => {
  const temporary = withTempPaths();
  const appA = { userData: path.join(temporary.root, 'app-a'), temp: temporary.root };
  const appB = { userData: path.join(temporary.root, 'app-b'), temp: temporary.root };
  const workers = [spawnWorker(appA), spawnWorker(appB)];
  const database = 'same_name';
  try {
    for (const [index, worker] of workers.entries()) {
      assert.equal((await request(worker, 'open', { database, directory: 'cache' })).success, true);
      assert.equal(
        (
          await request(worker, 'execute', {
            database,
            statements: ['CREATE TABLE t(v INTEGER)', `INSERT INTO t VALUES (${index})`],
          })
        ).success,
        true,
      );
    }
    await request(workers[0], '__shutdown');
    await workers[0].terminate();
    workers[0] = spawnWorker(appA);
    assert.equal((await request(workers[0], 'open', { database, directory: 'cache' })).success, true);
    for (const [index, worker] of workers.entries()) {
      const result = await request(worker, 'query', { database, statement: 'SELECT v FROM t' });
      assert.deepEqual(result.data.rows, [{ v: index }]);
    }
  } finally {
    for (const worker of workers) {
      await request(worker, '__shutdown');
      await worker.terminate();
    }
    fs.rmSync(temporary.root, { recursive: true, force: true });
  }
});

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

test('large rowids do not turn committed writes into failures or poison later writes', async () => {
  const temporary = withTempPaths();
  const worker = spawnWorker(temporary.paths);
  const database = ':memory:';
  const call = (method, options = {}) => request(worker, method, { database, ...options });
  const ok = (result) => {
    assert.equal(result.success, true, JSON.stringify(result));
    return result.data;
  };
  try {
    ok(await call('open'));
    ok(await call('execute', { statements: ['CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER DEFAULT 0)'] }));
    for (const id of ['9007199254740992', '9007199254740993']) {
      const result = ok(await call('run', { statement: 'INSERT INTO t(id) VALUES (?)', values: [id] }));
      assert.equal(result.changes, 1);
      // Consecutive 64-bit ids can round to the same Number but must still count as distinct inserts.
      assert.equal(result.lastInsertId, Number(id));
    }
    ok(await call('execute', { statements: ['INSERT INTO t(id) VALUES (9007199254740994)'] }));
    ok(await call('runBatch', { set: [{ statement: 'INSERT INTO t(id) VALUES (?)', values: ['9007199254740995'] }] }));
    ok(await call('runMany', { statement: 'INSERT INTO t(id) VALUES (?)', values: [['9007199254740996']] }));
    const many = ok(
      await call('runMany', {
        statement: 'INSERT INTO t(id) VALUES (?)',
        values: [['9007199254740997'], ['9007199254740998']],
        returnResults: true,
      }),
    );
    assert.deepEqual(
      many.results.map((item) => item.lastInsertId),
      [Number('9007199254740997'), Number('9007199254740998')],
    );
    const update = ok(await call('run', { statement: 'UPDATE t SET v = 1' }));
    assert.equal(update.changes, 7);
    assert.equal(update.lastInsertId, 0);
    const rows = ok(await call('query', { statement: 'SELECT id, v FROM t ORDER BY id' })).rows;
    assert.deepEqual(
      rows.map((row) => row.id),
      [
        '9007199254740992',
        '9007199254740993',
        '9007199254740994',
        '9007199254740995',
        '9007199254740996',
        '9007199254740997',
        '9007199254740998',
      ],
    );
    assert.equal(
      rows.every((row) => row.v === 1),
      true,
    );
  } finally {
    await request(worker, '__shutdown');
    await worker.terminate();
    fs.rmSync(temporary.root, { recursive: true, force: true });
  }
});

test('batch preparation follows schema changes and preserves atomic and autocommit behavior', async () => {
  const temporary = withTempPaths();
  const worker = spawnWorker(temporary.paths);
  const database = ':memory:';
  const call = (method, options = {}) => request(worker, method, { database, ...options });
  try {
    assert.equal((await call('open')).success, true);
    const batch = await call('runBatch', {
      set: [
        { statement: 'CREATE TABLE t(v INTEGER)' },
        { statement: 'INSERT INTO t(v) VALUES (?)', values: [1] },
        { statement: 'ALTER TABLE t ADD COLUMN label TEXT' },
        { statement: 'INSERT INTO t(v, label) VALUES (?, ?)', values: [2, 'new column'] },
        { statement: 'INSERT INTO t(v) VALUES (?)', values: [3] },
      ],
    });
    assert.equal(batch.success, true, JSON.stringify(batch));
    assert.equal(batch.data.changes, 3);
    assert.deepEqual((await call('query', { statement: 'SELECT * FROM t ORDER BY v' })).data.rows, [
      { v: 1, label: null },
      { v: 2, label: 'new column' },
      { v: 3, label: null },
    ]);
    const invalidValues = await call('runBatch', {
      transaction: false,
      set: [
        { statement: 'INSERT INTO t(v) VALUES (?)', values: [99] },
        { statement: 'INSERT INTO t(v) VALUES (?)', values: [100, 101] },
      ],
    });
    assert.equal(invalidValues.success, false);
    assert.equal(invalidValues.error.code, 'INVALID_PARAMS');
    assert.equal((await call('query', { statement: 'SELECT count(*) AS n FROM t' })).data.rows[0].n, 3);
    for (const transaction of [true, false]) {
      const result = await call('runBatch', {
        transaction,
        set: [
          { statement: 'CREATE TABLE dependent(v INTEGER)' },
          { statement: 'INSERT INTO dependent VALUES (?)', values: [7] },
          { statement: 'INSERT INTO missing_table VALUES (1)' },
        ],
      });
      assert.equal(result.success, false);
      assert.match(result.error.message, /set\[2\]/);
      const table = await call('query', {
        statement: "SELECT count(*) AS n FROM sqlite_master WHERE name = 'dependent'",
      });
      assert.equal(table.data.rows[0].n, transaction ? 0 : 1);
      if (!transaction)
        assert.deepEqual((await call('query', { statement: 'SELECT * FROM dependent' })).data.rows, [{ v: 7 }]);
    }
  } finally {
    await request(worker, '__shutdown');
    await worker.terminate();
    fs.rmSync(temporary.root, { recursive: true, force: true });
  }
});

test('batch PRAGMA preparation respects transaction boundaries and repeated execution order', async () => {
  const temporary = withTempPaths();
  const worker = spawnWorker(temporary.paths);
  const database = ':memory:';
  const call = (method, options = {}) => request(worker, method, { database, ...options });
  const foreignKeys = async () => (await call('query', { statement: 'PRAGMA foreign_keys' })).data.rows[0].foreign_keys;
  try {
    assert.equal((await call('open')).success, true);
    assert.equal(await foreignKeys(), 1);
    const failed = await call('runBatch', {
      set: [{ statement: 'PRAGMA foreign_keys = OFF' }, { statement: 'INSERT INTO missing_table VALUES (1)' }],
    });
    assert.equal(failed.success, false);
    assert.equal(await foreignKeys(), 1, 'prepare must not disable foreign keys before BEGIN');
    const ordered = await call('runBatch', {
      transaction: false,
      set: [
        { statement: 'PRAGMA foreign_keys = OFF' },
        { statement: 'PRAGMA foreign_keys = ON' },
        { statement: 'PRAGMA foreign_keys = OFF' },
      ],
    });
    assert.equal(ordered.success, true, JSON.stringify(ordered));
    assert.equal(await foreignKeys(), 0, 'a repeated PRAGMA must take effect at its own execution position');
  } finally {
    await request(worker, '__shutdown');
    await worker.terminate();
    fs.rmSync(temporary.root, { recursive: true, force: true });
  }
});

test('transaction methods follow actual SQLite state after raw SQL boundaries', async () => {
  const temporary = withTempPaths();
  const worker = spawnWorker(temporary.paths);
  const database = ':memory:';
  const call = (method, options = {}) => request(worker, method, { database, ...options });
  try {
    assert.equal((await call('open')).success, true);
    assert.equal((await call('execute', { statements: ['CREATE TABLE t(v)'] })).success, true);
    assert.equal((await call('execute', { statements: ['BEGIN'], transaction: false })).success, true);
    assert.equal((await call('run', { statement: 'INSERT INTO t VALUES (1)' })).success, true);
    assert.equal((await call('rollbackTransaction')).success, true, 'rollback sees BEGIN without an intervening query');
    assert.deepEqual((await call('query', { statement: 'SELECT * FROM t' })).data.rows, []);
    assert.equal((await call('beginTransaction')).success, true);
    assert.equal((await call('run', { statement: 'COMMIT' })).success, true);
    assert.equal((await call('beginTransaction')).success, true, 'raw COMMIT does not leave a stale active flag');
    assert.equal((await call('rollbackTransaction')).success, true);
  } finally {
    await request(worker, '__shutdown');
    await worker.terminate();
    fs.rmSync(temporary.root, { recursive: true, force: true });
  }
});

test('main-process query returns INVALID_PARAMS for null or missing options without rejecting', async () => {
  const temporary = withTempPaths();
  const module = { exports: {} };
  const pluginFile = path.join(__dirname, '..', 'electron', 'dist', 'plugin.cjs.js');
  vm.runInNewContext(
    fs.readFileSync(pluginFile, 'utf8'),
    {
      module,
      exports: module.exports,
      __dirname: path.dirname(pluginFile),
      process,
      console,
      require: (id) => (id === 'electron' ? { app: { getPath: (name) => temporary.paths[name] } } : require(id)),
    },
    { filename: pluginFile },
  );
  const api = new module.exports.CapacitorSqlite();
  try {
    for (const options of [null, undefined]) {
      const result = await api.query(options);
      assert.equal(result.success, false);
      assert.equal(result.error.code, 'INVALID_PARAMS');
    }
  } finally {
    await api.dispose();
    fs.rmSync(temporary.root, { recursive: true, force: true });
  }
});

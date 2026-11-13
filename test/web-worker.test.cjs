const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const ts = require('typescript');

const root = path.join(__dirname, '..');

test('web exec replies omit SQL and BLOB binds while preserving rows and metadata', async () => {
  const { default: init } = await import(
    pathToFileURL(path.join(root, 'node_modules/@sqlite.org/sqlite-wasm/dist/node.mjs'))
  );
  const sqlite = await init();
  let ready;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  let reply;
  const context = vm.createContext({
    sqlite3InitModule: async () => sqlite,
    postMessage: (message) => {
      reply = structuredClone(message);
      if (message.type === 'sqlite3-api') ready();
    },
  });
  const source = fs
    .readFileSync(path.join(root, 'dist/esm/web-worker.js'), 'utf8')
    .replace(/^import .*sqlite-wasm';\n/, '');
  vm.runInContext(source, context);
  await started;
  const send = (type, args, dbId) => context.onmessage({ data: { type, args, dbId, messageId: 'test' } });
  send('open', { filename: ':memory:' });
  const dbId = reply.dbId;
  try {
    send('exec', { sql: 'CREATE TABLE t(v)' }, dbId);
    send(
      'exec',
      { sql: 'INSERT INTO t VALUES (?)', bind: [new Uint8Array(1024 * 1024)], countChanges: 64, lastInsertRowId: true },
      dbId,
    );
    assert.equal(reply.result.changeCount, 1n);
    assert.equal(Number(reply.result.lastInsertRowId), 1);
    assert.equal(reply.inTransaction, false);
    assert.equal('sql' in reply.result, false);
    assert.equal('bind' in reply.result, false);
    send('exec', { sql: 'SELECT length(v) AS n FROM t', returnValue: 'resultRows' }, dbId);
    assert.equal(reply.result.resultRows[0].n, 1024 * 1024);
    assert.deepEqual(Object.keys(reply.result), ['resultRows']);
  } finally {
    send('close', {}, dbId);
  }
});

test(
  'worker errors reject pending calls, invalidate handles and permit an explicit reopen',
  { timeout: 5000 },
  async () => {
    const { sqlite3Worker1Promiser } = await import(
      pathToFileURL(path.join(root, 'node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs'))
    );
    const workers = [];
    let autoReady = true;
    class Worker extends EventTarget {
      constructor() {
        super();
        workers.push(this);
        if (autoReady) queueMicrotask(() => this.onmessage({ data: { type: 'sqlite3-api', result: 'worker1-ready' } }));
      }
      postMessage(message) {
        if (this.hold) return;
        queueMicrotask(() =>
          this.onmessage({
            data: {
              type: message.type,
              messageId: message.messageId,
              dbId: message.dbId ?? 'db#1',
              result: message.type === 'exec' ? { resultRows: [{ n: 1 }] } : {},
            },
          }),
        );
      }
      terminate() {
        this.terminated = true;
      }
    }
    const module = { exports: {} };
    const source = ts.transpileModule(
      fs
        .readFileSync(path.join(root, 'src/web.ts'), 'utf8')
        .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(root, 'src/web.ts')).href)),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    vm.runInNewContext(source, {
      module,
      exports: module.exports,
      Worker,
      URL,
      setTimeout,
      clearTimeout,
      require: (id) => {
        if (id === '@capacitor/core') return { WebPlugin: class {} };
        if (id === '@sqlite.org/sqlite-wasm') return { sqlite3Worker1Promiser };
        if (id === './sql.js') return require('../build/test-p0/sql.js');
        if (id === './migrations.js') return require('../build/test-p2/migrations.js');
        throw new Error(`Unexpected dependency: ${id}`);
      },
    });
    const api = new module.exports.CapacitorSqliteWeb();
    for (const event of ['error', 'messageerror']) {
      assert.equal((await api.open({ database: ':memory:' })).success, true);
      assert.equal((await api.open({ database: 'other' })).success, true);
      const worker = workers.at(-1);
      worker.hold = true;
      const requests = [':memory:', 'other'].map((database) => api.query({ database, statement: 'SELECT 1' }));
      await new Promise(setImmediate);
      worker.dispatchEvent(new Event(event));
      const results = await Promise.all(requests);
      assert(results.every((result) => !result.success && /outcome is unknown/.test(result.error.message)));
      assert.equal(worker.terminated, true);
      assert.equal((await api.isOpen({ database: ':memory:' })).data.open, false);
      assert.equal((await api.query({ database: ':memory:', statement: 'SELECT 1' })).error.code, 'DB_NOT_OPEN');
    }
    assert.equal((await api.open({ database: ':memory:' })).success, true);
    assert.equal(workers.length, 3);
    assert.equal((await api.query({ database: ':memory:', statement: 'SELECT 1' })).data.rows[0].n, 1);
    assert.equal((await api.close({ database: ':memory:' })).success, true);
    workers.at(-1).dispatchEvent(new Event('error'));
    autoReady = false;
    const opening = api.open({ database: ':memory:' });
    await new Promise(setImmediate);
    workers.at(-1).dispatchEvent(new Event('error'));
    assert.equal((await opening).success, false);
    autoReady = true;
    assert.equal((await api.open({ database: ':memory:' })).success, true);
    assert.equal(workers.length, 5);
    assert.equal((await api.close({ database: ':memory:' })).success, true);
  },
);

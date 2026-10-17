const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const publicPluginFile = path.join(__dirname, '..', 'dist', 'plugin.cjs.js');

for (const platform of ['ios', 'android']) {
  test(`${platform} query validates before transport and preserves special column values`, async () => {
    let calls = 0;
    const native = {
      query: async (options) => {
        calls++;
        return { success: true, data: { compactRows: { columns: ['__proto__'], values: [[options.values[0]]] } } };
      },
    };
    const core = {
      Capacitor: { getPlatform: () => platform, isNativePlatform: () => true },
      registerPlugin: () => native,
      WebPlugin: class {},
    };
    const module = { exports: {} };
    const context = vm.createContext({
      module,
      exports: module.exports,
      Uint8Array,
      TextDecoder,
      atob,
      btoa,
      require: (id) => (id === '@capacitor/core' ? core : require(id)),
    });
    vm.runInContext(fs.readFileSync(publicPluginFile, 'utf8'), context, { filename: publicPluginFile });
    const api = module.exports.CapacitorSqlite;
    const rowPrototype = vm.runInContext('Object.prototype', context);
    for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const result = await api.query({ database: ':memory:', statement: 'SELECT ?', values: [value] });
      assert.equal(result.success, false);
      assert.equal(result.error.code, 'INVALID_PARAMS');
    }
    assert.equal(calls, 0);
    for (const value of [7, null, 'text64:YmxvYjY0OmxpdGVyYWw=', 'blob64:AP8=']) {
      const result = await api.query({ database: ':memory:', statement: 'SELECT ?', values: [value] });
      assert.equal(result.success, true);
      const row = result.data.rows[0];
      assert.equal(Object.getPrototypeOf(row), rowPrototype);
      assert.equal(Object.hasOwn(row, '__proto__'), true);
      if (value === 'blob64:AP8=') assert.deepEqual(row.__proto__, Uint8Array.from([0, 255]));
      else assert.equal(row.__proto__, value === 'text64:YmxvYjY0OmxpdGVyYWw=' ? 'blob64:literal' : value);
    }
    assert.equal(calls, 4);
  });
}

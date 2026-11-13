const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('iOS suite runner reads the socket for its simulator without requiring an active inspector process', () => {
  const source = fs.readFileSync(path.join(__dirname, 'suite', 'run-ios-cdp.mjs'), 'utf8');
  const start = source.indexOf('function findWebInspectorSocket(');
  const end = source.indexOf('\nfunction withTimeout(', start);
  assert(start >= 0 && end > start);
  let socket = '/private/var/tmp/test/com.apple.webinspectord_sim.socket\n';
  const context = vm.createContext({
    sh: (command, args) => {
      assert.equal(command, 'xcrun');
      assert.equal(JSON.stringify(args), '["simctl","getenv","target-simulator","RWI_LISTEN_SOCKET"]');
      return socket;
    },
  });
  vm.runInContext(source.slice(start, end), context);
  assert.equal(context.findWebInspectorSocket('target-simulator'), socket.trim());
  socket = '';
  assert.throws(() => context.findWebInspectorSocket('target-simulator'), /socket is not available/);
});

test('iOS suite runner reports rejected benchmarks and clears stale results/errors', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'suite', 'run-ios-cdp.mjs'), 'utf8');
  const start = source.indexOf('async function runAsync(');
  const end = source.indexOf('\nasync function main()', start);
  assert(start >= 0 && end > start);
  const context = vm.createContext({ window: {}, TIMEOUT_MS: 1000, POLL_INTERVAL_MS: 1, setTimeout });
  // Appium parses JSON object strings before returning inspector results.
  let connections = 0;
  let executions = 0;
  const execute = async (expression) => {
    executions++;
    const result = vm.runInContext(expression, context);
    return typeof result === 'string' && result.startsWith('{') ? JSON.parse(result) : result;
  };
  context.withTimeout = (promise) => promise;
  context.PER_CALL_TIMEOUT_MS = 1000;
  context.withPage = async (_socket, _version, fn) => {
    connections++;
    return fn({ execute });
  };
  vm.runInContext(source.slice(start, end), context);

  const run = (expression) => context.runAsync('', '', expression, '__probe');
  assert.equal(JSON.stringify(await run('Promise.resolve([{ id: "ok" }])')), '[{"id":"ok"}]');
  await assert.rejects(run('Promise.reject(new Error("intentional stress failure"))'), /intentional stress failure/);
  assert.equal(JSON.stringify(await run('Promise.resolve([])')), '[]');
  assert.equal(connections, 3, 'one connection per run, including all polls');
  assert(executions >= 6, 'each run starts the job and reads its result');
});

test('iOS suite runner waits for the inspector socket after a cold launch', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'suite', 'run-ios-cdp.mjs'), 'utf8');
  const start = source.indexOf('async function main()');
  const end = source.indexOf('\nmain()', start);
  assert(start >= 0 && end > start);
  let attempts = 0;
  let inspected = false;
  const context = vm.createContext({
    console: { log() {} },
    skipSuite: true,
    runStress: false,
    runDiagnostics: false,
    findBootedSimulator: () => 'simulator',
    findSimulatorOsVersion: () => '27.0',
    findWebInspectorSocket: () => {
      if (++attempts < 3) throw new Error('socket not ready');
      return 'socket';
    },
    evalOnce: async (socket) => {
      assert.equal(socket, 'socket');
      inspected = true;
      return 'object';
    },
    setTimeout: (fn) => setImmediate(fn),
  });
  vm.runInContext(source.slice(start, end), context);
  await context.main();
  assert.equal(attempts, 3);
  assert.equal(inspected, true);
});

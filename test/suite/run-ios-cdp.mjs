#!/usr/bin/env node
// CLI runner for the shared playground test suite, executed against a real iOS
// Simulator by talking WebKit's Remote Web Inspector protocol directly to the
// app's WKWebView (via the `appium-remote-debugger` library, which Appium
// itself uses under the hood) — no full Appium server/session required.
//
// Prerequisites: an iOS Simulator is booted, and the playground debug build
// (with the CLI hook from src/cliHook.ts) is installed and launched.
// See package.json's "test:suite:ios" script, which does all of this.
//
// Usage: node test/suite/run-ios-cdp.mjs [--stress|--stress-only|--diagnostics|--diagnostics-only] [--timeout-ms=900000]

import { execFileSync } from 'node:child_process';

// appium-remote-debugger defaults its shared @appium/support logger to
// 'verbose' when used outside a full Appium session; quiet it down here.
const { logger: appiumSupportLogger } = await import('@appium/support');
appiumSupportLogger.log.level = 'warn';

// Match capacitor.config.ts; the old example ID attached to a different/missing app on clean builds.
const BUNDLE_ID = 'com.devioarts.pg.cap';
const PER_CALL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 1_500;
const stressOnly = process.argv.includes('--stress-only');
const runStress = stressOnly || process.argv.includes('--stress');
const diagnosticsOnly = process.argv.includes('--diagnostics-only');
const runDiagnostics = diagnosticsOnly || process.argv.includes('--diagnostics');
const skipSuite = stressOnly || diagnosticsOnly;
const DEFAULT_TIMEOUT_MS = runStress ? 900_000 : 180_000;
const TIMEOUT_MS = Number(process.argv.find((a) => a.startsWith('--timeout-ms='))?.split('=')[1] ?? DEFAULT_TIMEOUT_MS);

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

function findBootedSimulator() {
  const out = sh('xcrun', ['simctl', 'list', 'devices', 'booted']);
  const match = out.match(/\(([0-9A-F-]{36})\)\s*\(Booted\)/i);
  if (!match) throw new Error('No booted iOS Simulator found. Boot one with `xcrun simctl boot <name>`.');
  return match[1];
}

function findSimulatorOsVersion(udid) {
  const out = sh('xcrun', ['simctl', 'list', 'devices']);
  const lines = out.split('\n');
  let currentOs = null;
  for (const line of lines) {
    const header = line.match(/-- (iOS [\d.]+) --/);
    if (header) currentOs = header[1].replace('iOS ', '');
    if (line.includes(udid)) return currentOs;
  }
  return null;
}

function findWebInspectorSocket(udid) {
  // The launchd socket exists even when the on-demand inspector process is stopped.
  const socketPath = sh('xcrun', ['simctl', 'getenv', udid, 'RWI_LISTEN_SOCKET']).trim();
  if (!socketPath) throw new Error(`Web Inspector socket is not available for simulator ${udid}`);
  return socketPath;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms)),
  ]);
}

const quietLog = {
  debug() {},
  info() {},
  warn() {},
  error(...args) {
    console.error(...args);
  },
};

async function withPage(socketPath, platformVersion, fn) {
  const { RemoteDebugger } = await import('appium-remote-debugger');
  const rd = new RemoteDebugger({ bundleId: BUNDLE_ID, isSafari: false, socketPath, platformVersion, log: quietLog });
  try {
    await withTimeout(rd.connect(15_000), PER_CALL_TIMEOUT_MS, 'connect');
    const pages = await withTimeout(rd.selectApp(null, 20), PER_CALL_TIMEOUT_MS, 'selectApp');
    const page = pages.find((p) => p.bundleId === BUNDLE_ID) ?? pages[0];
    if (!page) {
      throw new Error(`No inspectable page found for bundle '${BUNDLE_ID}'. Is the app running in the foreground?`);
    }
    await withTimeout(
      rd.selectPage(page.id.split('.')[0], Number(page.id.split('.')[1])),
      PER_CALL_TIMEOUT_MS,
      'selectPage',
    );
    return await fn(rd);
  } finally {
    await rd.disconnect().catch(() => undefined);
  }
}

function evalOnce(socketPath, platformVersion, expression) {
  return withPage(socketPath, platformVersion, (rd) =>
    withTimeout(rd.execute(expression), PER_CALL_TIMEOUT_MS, 'execute'),
  );
}

async function runAsync(socketPath, platformVersion, expression, resultVar) {
  // Reconnecting during the load races Web Inspector page initialization.
  return withPage(socketPath, platformVersion, async (rd) => {
    const evaluate = (script) => withTimeout(rd.execute(script), PER_CALL_TIMEOUT_MS, 'execute');
    const errorVar = `${resultVar}Error`;
    // The remote debugger's result decoder rejects bare booleans/undefined, so
    // every evaluated expression here must resolve to a string or object.
    await evaluate(
      `
      window.${resultVar} = null;
      window.${errorVar} = null;
      Promise.resolve(${expression})
        .then((r) => { window.${resultVar} = JSON.stringify(r); })
        .catch((err) => {
          window.${errorVar} = String(err && (err.stack || err.message) || err);
        });
      'started';
    `,
    );
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      // Always wrap in an object: a bare `null`/string/boolean result trips up
      // the remote debugger's response decoder (it calls Object.hasOwn on it).
      // Note: rd.execute() already JSON-parses string results that look like
      // valid JSON, so `wrapped` here is already a plain object, not a string.
      const wrapped = await evaluate(`JSON.stringify({ v: window.${resultVar}, error: window.${errorVar} })`);
      if (wrapped.error) throw new Error(wrapped.error);
      const inner = wrapped.v;
      if (inner !== null) return JSON.parse(inner);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`Timed out waiting for ${resultVar}`);
  });
}

async function main() {
  const udid = findBootedSimulator();
  const platformVersion = findSimulatorOsVersion(udid);
  console.log(`Using booted simulator ${udid} (iOS ${platformVersion})`);

  let socketPath;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      socketPath = findWebInspectorSocket(udid);
      break;
    } catch (error) {
      if (attempt === 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  console.log(`Found Web Inspector socket: ${socketPath}`);

  let ready = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    ready = await evalOnce(socketPath, platformVersion, 'typeof window.__capSuite');
    if (ready === 'object') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (ready !== 'object') {
    throw new Error('window.__capSuite is not present — is this a build with src/cliHook.ts included?');
  }

  let report;
  if (!skipSuite) {
    console.log('Running suite tests against the real iOS (Swift/SQLite) backend...\n');
    report = await runAsync(socketPath, platformVersion, 'window.__capSuite.runAll()', '__capSuiteResult');
    for (const f of report.failures) {
      console.log(`✗ [${f.group}] ${f.name} — ${f.message}`);
    }
    console.log(
      `\n${report.passed}/${report.total} passed${report.skipped > 0 ? `, ${report.skipped} skipped` : ''}${report.failed > 0 ? `, ${report.failed} failed` : ''}`,
    );
  }

  if (runStress) {
    console.log('\nRunning stress benchmarks...\n');
    const results = await runAsync(socketPath, platformVersion, 'window.__capSuite.runStress()', '__capStressResult');
    for (const r of results) {
      const parts = [`${r.durationMs}ms`];
      if (r.throughput) parts.push(r.throughput);
      if (r.detail) parts.push(r.detail);
      console.log(`${r.name}: ${parts.join(' — ')}`);
    }
  }

  if (runDiagnostics) {
    console.log('\nRunning layer diagnostics...\n');
    const results = await runAsync(
      socketPath,
      platformVersion,
      'window.__capSuite.runDiagnostics()',
      '__capDiagnosticsResult',
    );
    for (const r of results) {
      const parts = [`${r.durationMs}ms`];
      if (r.throughput) parts.push(r.throughput);
      if (r.detail) parts.push(r.detail);
      console.log(`${r.id} ${r.name}: ${parts.join(' — ')}`);
    }
  }

  if (report?.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('CLI runner crashed:', err);
  process.exitCode = 1;
});

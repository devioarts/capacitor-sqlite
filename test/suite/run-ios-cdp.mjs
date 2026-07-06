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
// Each call below opens a fresh Remote Web Inspector connection rather than
// holding one connection open for the whole run: the RPC channel has been
// observed to occasionally stop responding mid-poll on a long-lived
// connection, while short-lived connect → evaluate → disconnect round trips
// have been reliable in testing.
//
// Usage: node test/suite/run-ios-cdp.mjs [--stress] [--timeout-ms=180000]

import { execFileSync } from 'node:child_process';

// appium-remote-debugger defaults its shared @appium/support logger to
// 'verbose' when used outside a full Appium session; quiet it down here.
const { logger: appiumSupportLogger } = await import('@appium/support');
appiumSupportLogger.log.level = 'warn';

const BUNDLE_ID = 'com.devioarts.example.sqlite';
const TIMEOUT_MS = Number(process.argv.find((a) => a.startsWith('--timeout-ms='))?.split('=')[1] ?? 180_000);
const PER_CALL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 1_500;
const runStress = process.argv.includes('--stress');

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
  // webinspectord_sim runs one process per booted simulator; its open file list
  // includes both a reference to the simulator's own data directory (to identify
  // which simulator it belongs to) and the unix socket it's listening on.
  const out = sh('lsof', ['-c', 'webinspectord']);
  const lines = out.split('\n');
  let currentPid = null;
  let matchedPid = null;
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === 'COMMAND') continue;
    const pid = cols[1];
    if (pid !== currentPid) {
      currentPid = pid;
      matchedPid = null;
    }
    if (line.includes(`Devices/${udid}/`)) {
      matchedPid = pid;
    }
    if (matchedPid === pid && line.includes('webinspectord_sim.socket')) {
      const socketMatch = line.match(/(\/private\/var\/tmp\/[^\s]+webinspectord_sim\.socket)/);
      if (socketMatch) return socketMatch[1];
    }
  }
  throw new Error(
    `Could not find the com.apple.webinspectord_sim.socket for simulator ${udid}. Is it booted and running an app?`,
  );
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms)),
  ]);
}

const quietLog = { debug() {}, info() {}, warn() {}, error(...args) { console.error(...args); } };

async function evalOnce(socketPath, platformVersion, expression) {
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
    return await withTimeout(rd.execute(expression), PER_CALL_TIMEOUT_MS, 'execute');
  } finally {
    await rd.disconnect().catch(() => undefined);
  }
}

async function runAsync(socketPath, platformVersion, expression, resultVar) {
  // The remote debugger's result decoder rejects bare booleans/undefined, so
  // every evaluated expression here must resolve to a string or object.
  await evalOnce(
    socketPath,
    platformVersion,
    `
      window.${resultVar} = undefined;
      (${expression}).then((r) => { window.${resultVar} = JSON.stringify(r); });
      'started';
    `,
  );
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Always wrap in an object: a bare `null`/string/boolean result trips up
    // the remote debugger's response decoder (it calls Object.hasOwn on it).
    // Note: rd.execute() already JSON-parses string results that look like
    // valid JSON, so `wrapped` here is already a plain object, not a string.
    const wrapped = await evalOnce(socketPath, platformVersion, `JSON.stringify({ v: window.${resultVar} ?? null })`);
    const inner = wrapped.v;
    if (inner !== null) return JSON.parse(inner);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for ${resultVar}`);
}

async function main() {
  const udid = findBootedSimulator();
  const platformVersion = findSimulatorOsVersion(udid);
  console.log(`Using booted simulator ${udid} (iOS ${platformVersion})`);

  const socketPath = findWebInspectorSocket(udid);
  console.log(`Found Web Inspector socket: ${socketPath}`);

  const ready = await evalOnce(socketPath, platformVersion, 'typeof window.__capSuite');
  if (ready !== 'object') {
    throw new Error("window.__capSuite is not present — is this a build with src/cliHook.ts included?");
  }

  console.log('Running suite tests against the real iOS (Swift/SQLite) backend...\n');
  const report = await runAsync(socketPath, platformVersion, 'window.__capSuite.runAll()', '__capSuiteResult');
  for (const f of report.failures) {
    console.log(`✗ [${f.group}] ${f.name} — ${f.message}`);
  }
  console.log(`\n${report.passed}/${report.total} passed${report.failed > 0 ? `, ${report.failed} failed` : ''}`);

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

  if (report.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('CLI runner crashed:', err);
  process.exitCode = 1;
});

#!/usr/bin/env node
// CLI runner for the shared playground test suite, executed against a real
// Android device/emulator by remote-debugging the app's WebView over Chrome
// DevTools Protocol (adb port-forward + Runtime.evaluate) — no Appium needed.
//
// Prerequisites: an Android emulator/device is running, and the playground
// debug APK (with the CLI hook from src/cliHook.ts) is installed and launched.
// See package.json's "test:suite:android" script, which does all of this.
//
// Usage: node test/suite/run-android-cdp.mjs [--stress] [--timeout-ms=180000]

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_ID = 'com.devioarts.capacitor.sqlite';
const FORWARD_PORT = 9333;
const TIMEOUT_MS = Number(process.argv.find((a) => a.startsWith('--timeout-ms='))?.split('=')[1] ?? 180_000);
const runStress = process.argv.includes('--stress');

function findAdb() {
  const candidates = [
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
    path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    'adb',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'adb' || existsSync(candidate)) return candidate;
  }
  throw new Error('adb not found — set ANDROID_HOME or install Android platform-tools');
}

function adb(adbPath, args) {
  return execFileSync(adbPath, args, { encoding: 'utf8' });
}

async function retry(fn, { attempts = 20, delayMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

function findWebviewSocket(adbPath) {
  const out = adb(adbPath, ['shell', 'cat', '/proc/net/unix']);
  const match = out
    .split('\n')
    .map((line) => line.match(/@(webview_devtools_remote_\d+)/)?.[1])
    .find(Boolean);
  if (!match) {
    throw new Error(
      `No webview_devtools_remote_* socket found for a running app. Is ${APP_ID} installed and in the foreground?`,
    );
  }
  return match;
}

async function fetchPages(port) {
  const res = await fetch(`http://localhost:${port}/json`);
  return res.json();
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP evaluate timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true, timeout: TIMEOUT_MS },
        }),
      );
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.result?.exceptionDetails) {
        reject(new Error(`Page threw: ${JSON.stringify(msg.result.exceptionDetails)}`));
        return;
      }
      resolve(msg.result?.result?.value);
    });
    ws.addEventListener('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main() {
  const adbPath = findAdb();
  console.log('Waiting for the app to attach a WebView debug socket...');
  const socket = await retry(() => findWebviewSocket(adbPath));
  console.log(`Found WebView debug socket: ${socket}`);

  adb(adbPath, ['forward', `tcp:${FORWARD_PORT}`, `localabstract:${socket}`]);
  console.log(`Forwarded tcp:${FORWARD_PORT} → ${socket}`);

  const page = await retry(async () => {
    const pages = await fetchPages(FORWARD_PORT);
    const found = pages.find((p) => p.type === 'page') ?? pages[0];
    if (!found) throw new Error('No inspectable pages found via CDP');
    return found;
  });

  const ready = await retry(async () => {
    const value = await evaluate(page.webSocketDebuggerUrl, 'typeof window.__capSuite');
    if (value !== 'object') throw new Error('window.__capSuite not yet defined');
    return value;
  });
  if (ready !== 'object') {
    throw new Error("window.__capSuite is not present — is this a build with src/cliHook.ts included?");
  }

  console.log('Running suite tests against the real Android (Kotlin/SQLite) backend...\n');
  const report = await evaluate(page.webSocketDebuggerUrl, 'window.__capSuite.runAll()');
  for (const f of report.failures) {
    console.log(`✗ [${f.group}] ${f.name} — ${f.message}`);
  }
  console.log(`\n${report.passed}/${report.total} passed${report.failed > 0 ? `, ${report.failed} failed` : ''}`);

  if (runStress) {
    console.log('\nRunning stress benchmarks...\n');
    const results = await evaluate(page.webSocketDebuggerUrl, 'window.__capSuite.runStress()');
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

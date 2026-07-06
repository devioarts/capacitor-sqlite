#!/usr/bin/env node
// CLI runner for the shared playground test suite, executed against the real
// browser Web backend (sqlite-wasm + OPFS) through Chrome DevTools Protocol.
//
// It starts the playground Vite dev server with the existing COOP/COEP headers,
// launches a temporary Chrome/Chromium profile, then calls window.__capSuite.
//
// Usage: node test/suite/run-web-cdp.mjs [--stress] [--timeout-ms=900000]

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const PER_CALL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 1_500;
const runStress = process.argv.includes('--stress');
const DEFAULT_TIMEOUT_MS = runStress ? 900_000 : 300_000;
const TIMEOUT_MS = Number(process.argv.find((a) => a.startsWith('--timeout-ms='))?.split('=')[1] ?? DEFAULT_TIMEOUT_MS);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'google-chrome',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes('/') ? existsSync(candidate) : true) return candidate;
  }
  throw new Error('Chrome/Chromium not found. Set CHROME_BIN to a compatible browser executable.');
}

function spawnLogged(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (process.env.DEBUG_CDP_RUNNER) process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    if (process.env.DEBUG_CDP_RUNNER) process.stderr.write(chunk);
  });
  return child;
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function removeTempDir(dir) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 9) throw err;
      await delay(250);
    }
  }
}

async function waitForUrl(url, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastErr = new Error(`${label} returned HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await delay(500);
  }
  throw lastErr ?? new Error(`Timed out waiting for ${label}`);
}

async function fetchJson(url, options) {
  const res = await waitForUrl(url, url);
  return res.json(options);
}

async function openCdpPage(cdpPort, url) {
  const encoded = encodeURIComponent(url);
  let res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encoded}`, { method: 'PUT' });
  if (!res.ok) {
    res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encoded}`);
  }
  if (!res.ok) throw new Error(`Could not open browser page: HTTP ${res.status}`);
  return res.json();
}

function evaluate(wsUrl, expression, { timeoutMs = PER_CALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP evaluate timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs },
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

async function retry(fn, { attempts = 60, delayMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await delay(delayMs);
    }
  }
  throw lastErr;
}

async function runAsync(wsUrl, expression, resultVar) {
  const errorVar = `${resultVar}Error`;
  await evaluate(
    wsUrl,
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
    const state = await evaluate(wsUrl, `JSON.stringify({ result: window.${resultVar}, error: window.${errorVar} })`);
    const parsed = JSON.parse(state);
    if (parsed.error) throw new Error(parsed.error);
    if (parsed.result !== null) return JSON.parse(parsed.result);
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${resultVar} after ${TIMEOUT_MS}ms`);
}

async function main() {
  const root = path.resolve(new URL('../..', import.meta.url).pathname);
  const playground = path.join(root, 'playground');
  const vitePort = await freePort();
  const cdpPort = await freePort();
  const profileDir = mkdtempSync(path.join(tmpdir(), 'capacitor-sqlite-web-cdp-'));
  const chrome = findChrome();
  const url = `http://127.0.0.1:${vitePort}/`;

  const vite = spawnLogged(
    'npm',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
    { cwd: playground },
  );
  const browser = spawnLogged(chrome, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    url,
  ]);

  try {
    await waitForUrl(url, 'Vite playground');
    await waitForUrl(`http://127.0.0.1:${cdpPort}/json/version`, 'Chrome DevTools');
    const page = await openCdpPage(cdpPort, url);

    await retry(async () => {
      const ready = await evaluate(page.webSocketDebuggerUrl, 'typeof window.__capSuite');
      if (ready !== 'object') throw new Error('window.__capSuite not yet defined');
      return ready;
    });

    const isolated = await evaluate(
      page.webSocketDebuggerUrl,
      'JSON.stringify({ isolated: crossOriginIsolated, opfs: !!navigator.storage?.getDirectory })',
    );
    const webCaps = JSON.parse(isolated);
    if (!webCaps.isolated || !webCaps.opfs) {
      throw new Error(`Web OPFS prerequisites missing: ${JSON.stringify(webCaps)}`);
    }

    console.log('Running suite tests against the real Web (sqlite-wasm/OPFS) backend...\n');
    const report = await runAsync(page.webSocketDebuggerUrl, 'window.__capSuite.runAll()', '__capWebSuiteReport');
    for (const f of report.failures) {
      console.log(`✗ [${f.group}] ${f.name} — ${f.message}`);
    }
    console.log(`\n${report.passed}/${report.total} passed${report.failed > 0 ? `, ${report.failed} failed` : ''}`);

    if (runStress) {
      console.log('\nRunning stress benchmarks...\n');
      const results = await runAsync(page.webSocketDebuggerUrl, 'window.__capSuite.runStress()', '__capWebSuiteStress');
      for (const r of results) {
        const parts = [`${r.durationMs}ms`];
        if (r.throughput) parts.push(r.throughput);
        if (r.detail) parts.push(r.detail);
        console.log(`${r.name}: ${parts.join(' — ')}`);
      }
    }

    if (report.failed > 0) process.exitCode = 1;
  } finally {
    await Promise.all([stopChild(vite), stopChild(browser)]);
    await removeTempDir(profileDir);
  }
}

main().catch((err) => {
  console.error('CLI runner crashed:', err);
  process.exitCode = 1;
});

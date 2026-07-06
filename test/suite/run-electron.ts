// CLI runner for the shared playground test suite, executed directly against the
// Electron (node:sqlite) backend — no Electron process, no browser required.
//
// Usage: npm run test:suite:electron [-- --stress]

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ElectronSqliteBackend } from '../../electron/src/backend.js';
import { runTestCase, type TestResult } from '../../playground/src/helpers/testRunner.js';
import { buildStressBenchmarks } from '../../playground/src/tests/stressBenchmarks.js';
import { buildSuiteTests } from '../../playground/src/tests/suiteTests.js';

async function main(): Promise<void> {
  const runStress = process.argv.includes('--stress');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'capacitor-sqlite-electron-cli-'));
  const backend = new ElectronSqliteBackend({ userData: scratch, temp: scratch });

  try {
    const tests = buildSuiteTests(backend);
    console.log(`Running ${tests.length} suite tests against the Electron (node:sqlite) backend...\n`);

    const results: TestResult[] = [];
    for (const tc of tests) {
      const r = await runTestCase(tc);
      results.push(r);
      if (!r.pass) {
        console.log(`✗ [${tc.group}] ${tc.name} (${r.durationMs}ms) — ${r.message}`);
      }
    }
    const passed = results.filter((r) => r.pass).length;
    const failed = results.length - passed;
    console.log(`\n${passed}/${results.length} passed${failed > 0 ? `, ${failed} failed` : ''}`);

    if (runStress) {
      console.log('\nRunning stress benchmarks...\n');
      for (const b of buildStressBenchmarks(backend)) {
        const r = await b.run();
        const parts = [`${r.durationMs}ms`];
        if (r.throughput) parts.push(r.throughput);
        if (r.detail) parts.push(r.detail);
        console.log(`${b.name}: ${parts.join(' — ')}`);
      }
    }

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('CLI runner crashed:', err);
  process.exitCode = 1;
});

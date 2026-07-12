// CLI runner for the shared playground test suite, executed directly against the
// Electron (node:sqlite) backend — no Electron process, no browser required.
//
// Usage: npm run test:suite:electron [-- --stress|--stress-only|--diagnostics|--diagnostics-only]

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ElectronSqliteBackend } from '../../electron/src/backend.js';
import { runTestCase, type TestResult } from '../../playground/src/helpers/testRunner.js';
import { buildDiagnosticBenchmarks } from '../../playground/src/tests/diagnosticBenchmarks.js';
import { buildStressBenchmarks } from '../../playground/src/tests/stressBenchmarks.js';
import { buildSuiteTests } from '../../playground/src/tests/suiteTests.js';

async function main(): Promise<void> {
  const stressOnly = process.argv.includes('--stress-only');
  const runStress = stressOnly || process.argv.includes('--stress');
  const diagnosticsOnly = process.argv.includes('--diagnostics-only');
  const runDiagnostics = diagnosticsOnly || process.argv.includes('--diagnostics');
  const skipSuite = stressOnly || diagnosticsOnly;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'capacitor-sqlite-electron-cli-'));
  const backend = new ElectronSqliteBackend({ userData: scratch, temp: scratch });

  try {
    const results: TestResult[] = [];
    if (!skipSuite) {
      const tests = buildSuiteTests(backend);
      console.log(`Running ${tests.length} suite tests against the Electron (node:sqlite) backend...\n`);
      for (const tc of tests) {
        const r = await runTestCase(tc);
        results.push(r);
        if (!r.pass) {
          console.log(`✗ [${tc.group}] ${tc.name} (${r.durationMs}ms) — ${r.message}`);
        }
      }
      const passed = results.filter((r) => r.pass && !r.skipped).length;
      const skipped = results.filter((r) => r.skipped).length;
      const failed = results.filter((r) => !r.pass).length;
      console.log(
        `\n${passed}/${results.length} passed${skipped > 0 ? `, ${skipped} skipped` : ''}${failed > 0 ? `, ${failed} failed` : ''}`,
      );
    }

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

    if (runDiagnostics) {
      console.log('\nRunning layer diagnostics against the backend directly...\n');
      for (const b of buildDiagnosticBenchmarks(backend)) {
        const r = await b.run();
        const parts = [`${r.durationMs}ms`];
        if (r.throughput) parts.push(r.throughput);
        if (r.detail) parts.push(r.detail);
        console.log(`${b.id} ${b.name}: ${parts.join(' — ')}`);
      }
    }

    if (results.some((r) => !r.pass)) {
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

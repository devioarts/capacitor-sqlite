// Exposes the shared test suite / stress benchmarks on `window` so an external
// CLI driver (remote-debugging a real iOS/Android WebView) can trigger a run
// and read back structured results — without any UI interaction.
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite';
import { runTestCase } from './helpers/testRunner.ts';
import { buildDiagnosticBenchmarks } from './tests/diagnosticBenchmarks.ts';
import { buildStressBenchmarks } from './tests/stressBenchmarks.ts';
import { buildSuiteTests } from './tests/suiteTests.ts';

export interface CliSuiteFailure {
  id: string;
  group: string;
  name: string;
  message: string;
}

export interface CliSuiteReport {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: CliSuiteFailure[];
}

export interface CliBenchmarkResult {
  id: string;
  name: string;
  durationMs: number;
  throughput?: string;
  detail?: string;
}

declare global {
  interface Window {
    __capSuite?: {
      runAll: () => Promise<CliSuiteReport>;
      runStress: () => Promise<CliBenchmarkResult[]>;
      runDiagnostics: () => Promise<CliBenchmarkResult[]>;
    };
  }
}

window.__capSuite = {
  async runAll(): Promise<CliSuiteReport> {
    const tests = buildSuiteTests(CapacitorSqlite);
    const results = [];
    for (const tc of tests) {
      results.push(await runTestCase(tc));
    }
    const failures = results.filter((r) => !r.pass);
    const skipped = results.filter((r) => r.skipped);
    return {
      total: results.length,
      passed: results.length - failures.length - skipped.length,
      failed: failures.length,
      skipped: skipped.length,
      failures: failures.map((r) => ({ id: r.id, group: r.group, name: r.name, message: r.message })),
    };
  },

  async runStress(): Promise<CliBenchmarkResult[]> {
    const benchmarks = buildStressBenchmarks(CapacitorSqlite);
    const out: CliBenchmarkResult[] = [];
    for (const b of benchmarks) {
      const r = await b.run();
      out.push({ id: b.id, name: b.name, durationMs: r.durationMs, throughput: r.throughput, detail: r.detail });
    }
    return out;
  },

  async runDiagnostics(): Promise<CliBenchmarkResult[]> {
    const benchmarks = buildDiagnosticBenchmarks(CapacitorSqlite);
    const out: CliBenchmarkResult[] = [];
    for (const b of benchmarks) {
      const r = await b.run();
      out.push({ id: b.id, name: b.name, durationMs: r.durationMs, throughput: r.throughput, detail: r.detail });
    }
    return out;
  },
};

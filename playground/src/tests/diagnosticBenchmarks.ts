import type { CapacitorSqlitePlugin } from '../../../src/definitions.js';
import { decodeElectronCompactRows, encodeNativeBridgeValues } from '../../../src/bridge-values.js';
import type { Benchmark } from './stressBenchmarks.js';

interface LatencyStats {
  totalMs: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
}

type TimedBatchResult = {
  changes: number;
  lastInsertId: number;
  timings?: Record<string, number>;
};

type QueryPlanRow = {
  detail?: string;
  'selectid'?: number;
  order?: number;
  from?: number;
};

const DIAG_DB = 'diagnostic_perf';
const SERIAL_CALLS = 200;
const BRIDGE_CONCURRENCY = 1_000;
const CORE_ROWS = 10_000;
const MATERIALIZED_ROWS = 100_000;
const LARGE_BYTES = 1024 * 1024;

function mustSucceed<T>(
  result: { success: true; data: T } | { success: false; error: { code: string; message: string } },
  label: string,
): T {
  if (!result.success) throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
  return result.data;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const totalMs = samples.reduce((sum, value) => sum + value, 0);
  return {
    totalMs,
    averageMs: totalMs / Math.max(samples.length, 1),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

function ms(value: number): string {
  if (value >= 100) return value.toFixed(1);
  if (value >= 10) return value.toFixed(2);
  return value.toFixed(3);
}

function statsDetail(stats: LatencyStats): string {
  return `avg ${ms(stats.averageMs)}ms · p50 ${ms(stats.p50Ms)}ms · p95 ${ms(stats.p95Ms)}ms · p99 ${ms(stats.p99Ms)}ms · min/max ${ms(stats.minMs)}/${ms(stats.maxMs)}ms`;
}

function rateLabel(count: number, durationMs: number): string {
  return `${Math.round((count / Math.max(durationMs, 0.001)) * 1000).toLocaleString()} ops/s`;
}

function timingBreakdown(timings: Record<string, number> | undefined): string {
  if (!timings) return 'native timing breakdown unsupported on this platform';
  const keys = [
    'pluginGetArrayMs',
    'bridgeDecodeMs',
    'queueWaitMs',
    'dbParseMs',
    'dbValidatePrepareMs',
    'dbPrepareUniqueMs',
    'dbPrevalidateMs',
    'dbBeginMs',
    'dbExecuteLoopMs',
    'dbResetMs',
    'dbClearBindingsMs',
    'dbBindValuesMs',
    'dbStepMs',
    'dbCommitMs',
    'dbTotalMs',
    'nativeTotalMs',
  ];
  return keys
    .filter((key) => typeof timings[key] === 'number')
    .map((key) => `${key.replace(/Ms$/, '')} ${ms(timings[key])}ms`)
    .join(' · ');
}

function reportedMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

async function measureSerial(iterations: number, operation: (index: number) => Promise<unknown>): Promise<LatencyStats> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await operation(i);
    samples.push(performance.now() - start);
  }
  return summarize(samples);
}

async function measureConcurrent(iterations: number, operation: (index: number) => Promise<unknown>): Promise<LatencyStats> {
  const starts = new Array<number>(iterations);
  const samples = await Promise.all(
    Array.from({ length: iterations }, async (_, index) => {
      starts[index] = performance.now();
      await operation(index);
      return performance.now() - starts[index];
    }),
  );
  return summarize(samples);
}

async function measureConcurrentWall(
  iterations: number,
  operation: (index: number) => Promise<unknown>,
): Promise<{ wallMs: number; stats: LatencyStats }> {
  const wallStart = performance.now();
  const stats = await measureConcurrent(iterations, operation);
  return { wallMs: performance.now() - wallStart, stats };
}

function planDetail(rows: QueryPlanRow[]): string {
  return rows
    .map((row) => row.detail ?? JSON.stringify(row))
    .join(' | ');
}

export function buildDiagnosticBenchmarks(CapacitorSqlite: CapacitorSqlitePlugin): Benchmark[] {
  const silentClose = async (): Promise<void> => {
    await CapacitorSqlite.close({ database: DIAG_DB });
  };

  const openFresh = async (statements: string[]): Promise<void> => {
    await silentClose();
    mustSucceed(await CapacitorSqlite.open({ database: DIAG_DB }), 'diagnostic open');
    mustSucceed(await CapacitorSqlite.execute({ database: DIAG_DB, statements }), 'diagnostic setup');
  };

  const latencyResult = (stats: LatencyStats, count: number) => ({
    durationMs: reportedMs(stats.totalMs),
    throughput: rateLabel(count, stats.totalMs),
    detail: statsDetail(stats),
  });

  return [
    {
      id: 'd-01',
      name: `JS Promise baseline — ${SERIAL_CALLS.toLocaleString()} sequential awaits`,
      description: 'No plugin and no SQLite. Measures timer/Promise overhead of the benchmark harness itself.',
      run: async () => {
        const stats = await measureSerial(SERIAL_CALLS, async () => Promise.resolve());
        return latencyResult(stats, SERIAL_CALLS);
      },
    },
    {
      id: 'd-02',
      name: `Platform call — ${SERIAL_CALLS.toLocaleString()} sequential getPluginPlatform()`,
      description: 'Small request/response through platform dispatch. On native this is a direct plugin method without this plugin\'s SQLite executor.',
      run: async () => {
        for (let i = 0; i < 10; i++) mustSucceed(await CapacitorSqlite.getPluginPlatform(), 'getPluginPlatform warmup');
        const stats = await measureSerial(SERIAL_CALLS, async () => {
          mustSucceed(await CapacitorSqlite.getPluginPlatform(), 'getPluginPlatform');
        });
        return latencyResult(stats, SERIAL_CALLS);
      },
    },
    {
      id: 'd-03',
      name: `Queued registry call — ${SERIAL_CALLS.toLocaleString()} sequential isOpen()`,
      description: 'Adds the plugin SQLite queue/registry path but performs no SQL. Compare directly with d-02.',
      run: async () => {
        await openFresh(['CREATE TABLE IF NOT EXISTS marker (v INTEGER)']);
        const stats = await measureSerial(SERIAL_CALLS, async () => {
          const result = mustSucceed(await CapacitorSqlite.isOpen({ database: DIAG_DB }), 'isOpen');
          if (!result.open) throw new Error('diagnostic database unexpectedly closed');
        });
        await silentClose();
        return latencyResult(stats, SERIAL_CALLS);
      },
    },
    {
      id: 'd-04',
      name: `Minimal query — ${SERIAL_CALLS.toLocaleString()} sequential SELECT 1`,
      description: 'Bridge + plugin queue + prepare/step + one scalar row + response conversion.',
      run: async () => {
        await openFresh(['CREATE TABLE IF NOT EXISTS marker (v INTEGER)']);
        const stats = await measureSerial(SERIAL_CALLS, async () => {
          const result = mustSucceed(
            await CapacitorSqlite.query<{ v: number }>({ database: DIAG_DB, statement: 'SELECT 1 AS v' }),
            'SELECT 1',
          );
          if (result.rows[0]?.v !== 1) throw new Error('SELECT 1 returned an invalid value');
        });
        await silentClose();
        return latencyResult(stats, SERIAL_CALLS);
      },
    },
    {
      id: 'd-05',
      name: `Transactional write — ${SERIAL_CALLS.toLocaleString()} sequential run()`,
      description: 'One persistent transaction removes per-row durable commit cost. Compare d-03/d-04 to isolate write wrapper overhead.',
      run: async () => {
        await openFresh(['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)']);
        mustSucceed(await CapacitorSqlite.beginTransaction({ database: DIAG_DB }), 'begin');
        const stats = await measureSerial(SERIAL_CALLS, async (index) => {
          mustSucceed(
            await CapacitorSqlite.run({ database: DIAG_DB, statement: 'INSERT INTO t VALUES (?)', values: [index] }),
            'transactional insert',
          );
        });
        mustSucceed(await CapacitorSqlite.rollbackTransaction({ database: DIAG_DB }), 'rollback');
        await silentClose();
        return latencyResult(stats, SERIAL_CALLS);
      },
    },
    {
      id: 'd-06',
      name: `Autocommit write — ${SERIAL_CALLS.toLocaleString()} sequential run()`,
      description: 'Same write without an outer transaction. d-06 minus d-05 estimates durable commit/framework transaction cost.',
      run: async () => {
        await openFresh(['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)']);
        const stats = await measureSerial(SERIAL_CALLS, async (index) => {
          mustSucceed(
            await CapacitorSqlite.run({ database: DIAG_DB, statement: 'INSERT INTO t VALUES (?)', values: [index] }),
            'autocommit insert',
          );
        });
        await silentClose();
        return latencyResult(stats, SERIAL_CALLS);
      },
    },
    {
      id: 'd-07',
      name: `Concurrent platform calls — ${BRIDGE_CONCURRENCY.toLocaleString()} getPluginPlatform()`,
      description: 'Pipeline/queue throughput plus individual completion latency distribution. Compare with sequential d-02.',
      run: async () => {
        const wallStart = performance.now();
        const stats = await measureConcurrent(BRIDGE_CONCURRENCY, async () => {
          mustSucceed(await CapacitorSqlite.getPluginPlatform(), 'concurrent getPluginPlatform');
        });
        const wallMs = performance.now() - wallStart;
        return {
          durationMs: reportedMs(wallMs),
          throughput: rateLabel(BRIDGE_CONCURRENCY, wallMs),
          detail: `completion latency: ${statsDetail(stats)}`,
        };
      },
    },
    {
      id: 'd-08',
      name: `One-statement SQLite workload — ${CORE_ROWS.toLocaleString()} recursive INSERT rows`,
      description: 'One public call and one SQL statement generate all rows inside SQLite. Approximates SQLite core + one bridge response.',
      run: async () => {
        await openFresh(['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)']);
        const start = performance.now();
        const result = mustSucceed(
          await CapacitorSqlite.run({
            database: DIAG_DB,
            statement: `WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM c WHERE x < ${CORE_ROWS}) INSERT INTO t SELECT x FROM c`,
          }),
          'recursive insert',
        );
        const durationMs = performance.now() - start;
        const count = mustSucceed(
          await CapacitorSqlite.query<{ n: number }>({ database: DIAG_DB, statement: 'SELECT COUNT(*) AS n FROM t' }),
          'recursive count',
        );
        if (count.rows[0]?.n !== CORE_ROWS) throw new Error(`recursive insert created ${count.rows[0]?.n} rows`);
        await silentClose();
        return {
          durationMs: reportedMs(durationMs),
          throughput: rateLabel(CORE_ROWS, durationMs),
          detail: `${result.changes.toLocaleString()} reported changes · one JS→plugin→SQLite→JS call`,
        };
      },
    },
    {
      id: 'd-09',
      name: `Batch wrapper — runBatch(${CORE_ROWS.toLocaleString()})`,
      description: 'One bridge call carrying 10k statement/value objects. Compare with d-08 to expose payload parsing, validation and per-item wrapper cost.',
      run: async () => {
        await openFresh(['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)']);
        const set = Array.from({ length: CORE_ROWS }, (_, index) => ({
          statement: 'INSERT INTO t VALUES (?)',
          values: [index],
        }));
        const start = performance.now();
        const result = mustSucceed(await CapacitorSqlite.runBatch({ database: DIAG_DB, set }), 'diagnostic batch');
        const durationMs = performance.now() - start;
        if (result.changes < CORE_ROWS) throw new Error(`batch reported ${result.changes} changes`);
        await silentClose();
        return {
          durationMs: reportedMs(durationMs),
          throughput: rateLabel(CORE_ROWS, durationMs),
          detail: 'includes input serialization, whole-batch validation, native loop and commit',
        };
      },
    },
    {
      id: 'd-10',
      name: 'TEXT input serialization — 1 MB write only',
      description: 'Times JS payload preparation, bridge/worker transfer, native binding and SQLite write; readback is excluded.',
      run: async () => {
        await openFresh(['DROP TABLE IF EXISTS payload', 'CREATE TABLE payload (v TEXT)']);
        const value = 'x'.repeat(LARGE_BYTES);
        const start = performance.now();
        mustSucceed(
          await CapacitorSqlite.run({ database: DIAG_DB, statement: 'INSERT INTO payload VALUES (?)', values: [value] }),
          'TEXT input',
        );
        const durationMs = performance.now() - start;
        await silentClose();
        return { durationMs: reportedMs(durationMs), detail: `${LARGE_BYTES.toLocaleString()} UTF-8 bytes sent` };
      },
    },
    {
      id: 'd-11',
      name: 'TEXT output serialization — 1 MB read only',
      description: 'Seeds outside the timer, then measures SQLite row extraction, response serialization/transfer and JS decoding.',
      run: async () => {
        await openFresh(['DROP TABLE IF EXISTS payload', 'CREATE TABLE payload (v TEXT)']);
        const value = 'y'.repeat(LARGE_BYTES);
        mustSucceed(
          await CapacitorSqlite.run({ database: DIAG_DB, statement: 'INSERT INTO payload VALUES (?)', values: [value] }),
          'TEXT output seed',
        );
        const start = performance.now();
        const result = mustSucceed(
          await CapacitorSqlite.query<{ v: string }>({ database: DIAG_DB, statement: 'SELECT v FROM payload' }),
          'TEXT output',
        );
        const durationMs = performance.now() - start;
        if (result.rows[0]?.v !== value) throw new Error('TEXT output mismatch');
        await silentClose();
        return { durationMs: reportedMs(durationMs), detail: `${LARGE_BYTES.toLocaleString()} UTF-8 bytes received` };
      },
    },
    {
      id: 'd-12',
      name: 'BLOB input serialization — 1 MB write only',
      description: 'Measures tagged-base64 decoding on Android/iOS or structured clone on Web/Electron, separately from readback.',
      run: async () => {
        await openFresh(['DROP TABLE IF EXISTS payload', 'CREATE TABLE payload (v BLOB)']);
        const value = new Uint8Array(LARGE_BYTES).fill(0xa5);
        const start = performance.now();
        mustSucceed(
          await CapacitorSqlite.run({ database: DIAG_DB, statement: 'INSERT INTO payload VALUES (?)', values: [value] }),
          'BLOB input',
        );
        const durationMs = performance.now() - start;
        await silentClose();
        return { durationMs: reportedMs(durationMs), detail: `${LARGE_BYTES.toLocaleString()} binary bytes sent` };
      },
    },
    {
      id: 'd-13',
      name: 'BLOB output serialization — 1 MB read only',
      description: 'Seeds outside the timer, then measures row extraction, platform-specific BLOB encoding/transfer and JS Uint8Array reconstruction.',
      run: async () => {
        await openFresh(['DROP TABLE IF EXISTS payload', 'CREATE TABLE payload (v BLOB)']);
        const value = new Uint8Array(LARGE_BYTES).fill(0x5a);
        mustSucceed(
          await CapacitorSqlite.run({ database: DIAG_DB, statement: 'INSERT INTO payload VALUES (?)', values: [value] }),
          'BLOB output seed',
        );
        const start = performance.now();
        const result = mustSucceed(
          await CapacitorSqlite.query<{ v: Uint8Array }>({ database: DIAG_DB, statement: 'SELECT v FROM payload' }),
          'BLOB output',
        );
        const durationMs = performance.now() - start;
        const output = result.rows[0]?.v;
        if (!(output instanceof Uint8Array) || output.length !== value.length) throw new Error('BLOB output mismatch');
        await silentClose();
        return { durationMs: reportedMs(durationMs), detail: `${LARGE_BYTES.toLocaleString()} binary bytes received` };
      },
    },
    {
      id: 'd-14',
      name: `Result materialization — ${MATERIALIZED_ROWS.toLocaleString()} rows × 2 columns`,
      description: 'Seeds outside the timer. Measures SQLite scan plus native/WASM row objects, serialization/clone and final JS allocation.',
      run: async () => {
        await openFresh(['DROP TABLE IF EXISTS rows_t', 'CREATE TABLE rows_t (id INTEGER, v TEXT)']);
        const set = Array.from({ length: MATERIALIZED_ROWS }, (_, index) => ({
          statement: 'INSERT INTO rows_t VALUES (?, ?)',
          values: [index, `row-${index}`],
        }));
        mustSucceed(await CapacitorSqlite.runBatch({ database: DIAG_DB, set }), 'materialization seed');
        const start = performance.now();
        const result = mustSucceed(
          await CapacitorSqlite.query<{ id: number; v: string }>({ database: DIAG_DB, statement: 'SELECT id, v FROM rows_t' }),
          'materialization query',
        );
        const durationMs = performance.now() - start;
        if (result.rows.length !== MATERIALIZED_ROWS) throw new Error(`materialized ${result.rows.length} rows`);
        await silentClose();
        return {
          durationMs: reportedMs(durationMs),
          throughput: rateLabel(MATERIALIZED_ROWS, durationMs),
          detail: `${result.rows.length.toLocaleString()} JS row objects returned`,
        };
      },
    },
    {
      id: 'd-15',
      name: `Repeated-statement transport — runMany(${CORE_ROWS.toLocaleString()})`,
      description: 'Sends one SQL string plus 10k value arrays. Compare with d-09 to isolate repeated SQL/object transport and parsing overhead.',
      run: async () => {
        await openFresh(['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)']);
        const values = Array.from({ length: CORE_ROWS }, (_, index) => [index]);
        const start = performance.now();
        const result = mustSucceed(await CapacitorSqlite.runMany({
          database: DIAG_DB,
          statement: 'INSERT INTO t VALUES (?)',
          values,
        }), 'diagnostic runMany');
        const durationMs = performance.now() - start;
        if (result.changes < CORE_ROWS) throw new Error(`runMany reported ${result.changes} changes`);
        await silentClose();
        return {
          durationMs: reportedMs(durationMs),
          throughput: rateLabel(CORE_ROWS, durationMs),
          detail: 'one SQL string, one public call, whole-input validation and a backend repeated-statement loop',
        };
      },
    },
    {
      id: 'd-16',
      name: `Pure JS row reconstruction — ${MATERIALIZED_ROWS.toLocaleString()} rows × 2 columns`,
      description: 'No plugin and no SQLite. Reconstructs public row objects from the internal compact representation; compare with d-14.',
      run: async () => {
        const compactRows = {
          columns: ['id', 'v'],
          values: Array.from({ length: MATERIALIZED_ROWS }, (_, index) => [index, `row-${index}`]),
        };
        const start = performance.now();
        const rows = decodeElectronCompactRows({ compactRows });
        const durationMs = performance.now() - start;
        if (rows.length !== MATERIALIZED_ROWS || rows[MATERIALIZED_ROWS - 1]?.id !== MATERIALIZED_ROWS - 1) {
          throw new Error('pure JS row reconstruction mismatch');
        }
        return {
          durationMs: reportedMs(durationMs),
          throughput: rateLabel(MATERIALIZED_ROWS, durationMs),
          detail: 'JS allocation only; d-14 minus this noisy baseline estimates scan + bridge/worker transport',
        };
      },
    },
    {
      id: 'd-17',
      name: 'Pure JS native BLOB envelope — 1 MB encode only',
      description: 'No plugin and no SQLite. Measures the tagged-base64 preparation used only by Android/iOS; compare with d-12.',
      run: async () => {
        const value = new Uint8Array(LARGE_BYTES).fill(0xa5);
        const start = performance.now();
        const encoded = encodeNativeBridgeValues([value]);
        const durationMs = performance.now() - start;
        const payload = encoded?.[0] as Record<string, unknown>;
        const base64 = payload?.__capacitorSqliteBlobBase64;
        if (typeof base64 !== 'string' || base64.length === 0) throw new Error('BLOB envelope encoding failed');
        return {
          durationMs: reportedMs(durationMs),
          detail: `${LARGE_BYTES.toLocaleString()} input bytes → ${base64.length.toLocaleString()} base64 characters`,
        };
      },
    },
    {
      id: 'd-18',
      name: `Pure JS batch payload serialization — ${CORE_ROWS.toLocaleString()} items`,
      description: 'No plugin and no SQLite. JSON-serializes equivalent runBatch and runMany request shapes to quantify repeated SQL/object overhead.',
      run: async () => {
        const statement = 'INSERT INTO t VALUES (?)';
        const valueSets = Array.from({ length: CORE_ROWS }, (_, index) => [index]);
        const batch = { database: DIAG_DB, set: valueSets.map((values) => ({ statement, values })) };
        const many = { database: DIAG_DB, statement, values: valueSets };
        const batchStart = performance.now();
        const batchJson = JSON.stringify(batch);
        const batchMs = performance.now() - batchStart;
        const manyStart = performance.now();
        const manyJson = JSON.stringify(many);
        const manyMs = performance.now() - manyStart;
        return {
          durationMs: reportedMs(batchMs + manyMs),
          detail: `runBatch ${ms(batchMs)}ms/${batchJson.length.toLocaleString()} chars · runMany ${ms(manyMs)}ms/${manyJson.length.toLocaleString()} chars`,
        };
      },
    },
    {
      id: 'd-19',
      name: `Native runBatch breakdown — ${CORE_ROWS.toLocaleString()} items`,
      description: 'Android/iOS-only native timing breakdown for getArray/decode/queue/parse/prepare/execute/commit. Compares where runBatch differs by platform.',
      run: async () => {
        await openFresh(['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)']);
        const set = Array.from({ length: CORE_ROWS }, (_, index) => ({
          statement: 'INSERT INTO t VALUES (?)',
          values: [index],
        }));
        const start = performance.now();
        const result = mustSucceed(await CapacitorSqlite.runBatch({
          database: DIAG_DB,
          set,
          __diagnostics: true,
        } as Parameters<typeof CapacitorSqlite.runBatch>[0] & { __diagnostics: true }), 'diagnostic batch breakdown') as TimedBatchResult;
        const durationMs = performance.now() - start;
        if (result.changes < CORE_ROWS) throw new Error(`batch breakdown reported ${result.changes} changes`);
        await silentClose();
        return {
          durationMs: reportedMs(durationMs),
          throughput: rateLabel(CORE_ROWS, durationMs),
          detail: timingBreakdown(result.timings),
        };
      },
    },
    {
      id: 'd-20',
      name: `Concurrent write fan-out — ${CORE_ROWS.toLocaleString()} run() calls`,
      description: 'Same shape as the full-load concurrent write case, but reports wall time plus individual Promise completion latency percentiles.',
      run: async () => {
        await openFresh(['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)']);
        const { wallMs, stats } = await measureConcurrentWall(CORE_ROWS, async (index) => {
          mustSucceed(
            await CapacitorSqlite.run({
              database: DIAG_DB,
              statement: 'INSERT INTO t VALUES (?, ?)',
              values: [index, `cw-${index}`],
            }),
            `concurrent write ${index}`,
          );
        });
        const count = mustSucceed(
          await CapacitorSqlite.query<{ n: number }>({ database: DIAG_DB, statement: 'SELECT COUNT(*) AS n FROM t' }),
          'concurrent write count',
        );
        if (count.rows[0]?.n !== CORE_ROWS) throw new Error(`concurrent writes inserted ${count.rows[0]?.n}`);
        await silentClose();
        return {
          durationMs: reportedMs(wallMs),
          throughput: rateLabel(CORE_ROWS, wallMs),
          detail: `completion latency: ${statsDetail(stats)}`,
        };
      },
    },
    {
      id: 'd-21',
      name: `Concurrent transactional write fan-out — ${CORE_ROWS.toLocaleString()} run() calls`,
      description: 'Fires the same Promise fan-out inside one manual transaction. d-20 minus d-21 estimates autocommit/durable-write cost under fan-out.',
      run: async () => {
        await openFresh(['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)']);
        mustSucceed(await CapacitorSqlite.beginTransaction({ database: DIAG_DB }), 'begin concurrent transaction');
        const { wallMs, stats } = await measureConcurrentWall(CORE_ROWS, async (index) => {
          mustSucceed(
            await CapacitorSqlite.run({
              database: DIAG_DB,
              statement: 'INSERT INTO t VALUES (?, ?)',
              values: [index, `ctx-${index}`],
            }),
            `concurrent transactional write ${index}`,
          );
        });
        mustSucceed(await CapacitorSqlite.rollbackTransaction({ database: DIAG_DB }), 'rollback concurrent transaction');
        await silentClose();
        return {
          durationMs: reportedMs(wallMs),
          throughput: rateLabel(CORE_ROWS, wallMs),
          detail: `completion latency: ${statsDetail(stats)}`,
        };
      },
    },
    {
      id: 'd-22',
      name: `Mixed concurrent breakdown — ${CORE_ROWS.toLocaleString()} ops`,
      description: 'Runs 5k writes and 5k COUNT reads concurrently and reports separate completion latency distributions for writes and reads.',
      run: async () => {
        const perSide = CORE_ROWS / 2;
        await openFresh(['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)']);
        mustSucceed(await CapacitorSqlite.runBatch({
          database: DIAG_DB,
          set: Array.from({ length: 10 }, (_, index) => ({
            statement: 'INSERT INTO t VALUES (?, ?)',
            values: [index, `seed-${index}`],
          })),
        }), 'mixed seed');

        const writeStarts = new Array<number>(perSide);
        const readStarts = new Array<number>(perSide);
        const wallStart = performance.now();
        const writes = Array.from({ length: perSide }, async (_, index) => {
          writeStarts[index] = performance.now();
          mustSucceed(
            await CapacitorSqlite.run({
              database: DIAG_DB,
              statement: 'INSERT INTO t VALUES (?, ?)',
              values: [1000 + index, `mix-${index}`],
            }),
            `mixed write ${index}`,
          );
          return performance.now() - writeStarts[index];
        });
        const reads = Array.from({ length: perSide }, async (_, index) => {
          readStarts[index] = performance.now();
          const result = mustSucceed(
            await CapacitorSqlite.query<{ n: number }>({ database: DIAG_DB, statement: 'SELECT COUNT(*) AS n FROM t' }),
            `mixed read ${index}`,
          );
          if (typeof result.rows[0]?.n !== 'number') throw new Error('mixed read did not return a count');
          return performance.now() - readStarts[index];
        });
        const [writeSamples, readSamples] = await Promise.all([Promise.all(writes), Promise.all(reads)]);
        const wallMs = performance.now() - wallStart;
        await silentClose();
        return {
          durationMs: reportedMs(wallMs),
          throughput: rateLabel(CORE_ROWS, wallMs),
          detail: `writes: ${statsDetail(summarize(writeSamples))} · reads: ${statsDetail(summarize(readSamples))}`,
        };
      },
    },
    {
      id: 'd-23',
      name: `Filtered query no-index plan — ${MATERIALIZED_ROWS.toLocaleString()} rows`,
      description: 'Seeds 100k rows, captures EXPLAIN QUERY PLAN, then times the current WHERE+ORDER BY+LIMIT query without an index.',
      run: async () => {
        await openFresh(['DROP TABLE IF EXISTS filter_t', 'CREATE TABLE filter_t (id INTEGER, v TEXT)']);
        mustSucceed(await CapacitorSqlite.runBatch({
          database: DIAG_DB,
          set: Array.from({ length: MATERIALIZED_ROWS }, (_, index) => ({
            statement: 'INSERT INTO filter_t VALUES (?, ?)',
            values: [index, `row-${index}`],
          })),
        }), 'filtered seed');
        const threshold = Math.floor(MATERIALIZED_ROWS / 2);
        const plan = mustSucceed(
          await CapacitorSqlite.query<QueryPlanRow>({
            database: DIAG_DB,
            statement: 'EXPLAIN QUERY PLAN SELECT id, v FROM filter_t WHERE id > ? ORDER BY id DESC LIMIT 100',
            values: [threshold],
          }),
          'filtered no-index plan',
        );
        const start = performance.now();
        const result = mustSucceed(
          await CapacitorSqlite.query<{ id: number; v: string }>({
            database: DIAG_DB,
            statement: 'SELECT id, v FROM filter_t WHERE id > ? ORDER BY id DESC LIMIT 100',
            values: [threshold],
          }),
          'filtered no-index query',
        );
        const durationMs = performance.now() - start;
        if (result.rows.length !== 100) throw new Error(`filtered no-index returned ${result.rows.length}`);
        await silentClose();
        return {
          durationMs: reportedMs(durationMs),
          throughput: rateLabel(MATERIALIZED_ROWS, durationMs),
          detail: `${result.rows.length} rows returned · plan: ${planDetail(plan.rows)}`,
        };
      },
    },
    {
      id: 'd-24',
      name: `Filtered query indexed plan — ${MATERIALIZED_ROWS.toLocaleString()} rows`,
      description: 'Same WHERE+ORDER BY+LIMIT query after adding an index on id. Separates SQLite scan/sort cost from bridge/result overhead.',
      run: async () => {
        await openFresh(['DROP TABLE IF EXISTS filter_t', 'CREATE TABLE filter_t (id INTEGER, v TEXT)']);
        mustSucceed(await CapacitorSqlite.runBatch({
          database: DIAG_DB,
          set: Array.from({ length: MATERIALIZED_ROWS }, (_, index) => ({
            statement: 'INSERT INTO filter_t VALUES (?, ?)',
            values: [index, `row-${index}`],
          })),
        }), 'filtered indexed seed');
        mustSucceed(await CapacitorSqlite.execute({
          database: DIAG_DB,
          statements: ['CREATE INDEX idx_filter_t_id ON filter_t(id)'],
        }), 'filtered index');
        const threshold = Math.floor(MATERIALIZED_ROWS / 2);
        const plan = mustSucceed(
          await CapacitorSqlite.query<QueryPlanRow>({
            database: DIAG_DB,
            statement: 'EXPLAIN QUERY PLAN SELECT id, v FROM filter_t WHERE id > ? ORDER BY id DESC LIMIT 100',
            values: [threshold],
          }),
          'filtered indexed plan',
        );
        const start = performance.now();
        const result = mustSucceed(
          await CapacitorSqlite.query<{ id: number; v: string }>({
            database: DIAG_DB,
            statement: 'SELECT id, v FROM filter_t WHERE id > ? ORDER BY id DESC LIMIT 100',
            values: [threshold],
          }),
          'filtered indexed query',
        );
        const durationMs = performance.now() - start;
        if (result.rows.length !== 100) throw new Error(`filtered indexed returned ${result.rows.length}`);
        await silentClose();
        return {
          durationMs: reportedMs(durationMs),
          throughput: rateLabel(MATERIALIZED_ROWS, durationMs),
          detail: `${result.rows.length} rows returned · plan: ${planDetail(plan.rows)}`,
        };
      },
    },
  ];
}

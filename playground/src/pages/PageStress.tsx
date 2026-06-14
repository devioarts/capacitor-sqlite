import React, { useState, useCallback } from 'react';
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite';
import { Button } from '../components/Button.tsx';
import { useLogger } from '../components/Logger.tsx';
import { silentClose } from '../helpers/testRunner.ts';

// ── types ─────────────────────────────────────────────────────────────────────

interface StressResult {
  id: string;
  name: string;
  status: 'idle' | 'running' | 'done' | 'error';
  durationMs?: number;
  throughput?: string; // e.g. "500 rows/s"
  detail?: string;    // breakdown or error message
}

// ── helpers ───────────────────────────────────────────────────────────────────

function ms(start: number) { return Date.now() - start; }

function rateLabel(count: number, durationMs: number) {
  const perSec = Math.round((count / durationMs) * 1000);
  return `${perSec.toLocaleString()} ops/s`;
}

function randomText(len: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function randomBlob(bytes: number): Uint8Array {
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  return arr;
}

const DB_STRESS = 'stress_main';

// ── individual benchmark fns ──────────────────────────────────────────────────

async function benchSequentialRun(rows: number): Promise<{ durationMs: number; throughput: string }> {
  await silentClose(DB_STRESS);
  await CapacitorSqlite.open({ database: DB_STRESS });
  await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)'] });
  const start = Date.now();
  for (let i = 0; i < rows; i++) {
    await CapacitorSqlite.run({ database: DB_STRESS, statement: 'INSERT INTO t VALUES (?,?)', values: [i, `row${i}`] });
  }
  const d = ms(start);
  await silentClose(DB_STRESS);
  return { durationMs: d, throughput: rateLabel(rows, d) };
}

async function benchRunBatch(rows: number): Promise<{ durationMs: number; throughput: string }> {
  await silentClose(DB_STRESS);
  await CapacitorSqlite.open({ database: DB_STRESS });
  await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)'] });
  const set = Array.from({ length: rows }, (_, i) => ({
    statement: 'INSERT INTO t VALUES (?,?)',
    values: [i, `row${i}`] as [number, string],
  }));
  const start = Date.now();
  await CapacitorSqlite.runBatch({ database: DB_STRESS, set });
  const d = ms(start);
  await silentClose(DB_STRESS);
  return { durationMs: d, throughput: rateLabel(rows, d) };
}

async function benchManualTransaction(rows: number): Promise<{ durationMs: number; throughput: string }> {
  await silentClose(DB_STRESS);
  await CapacitorSqlite.open({ database: DB_STRESS });
  await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)'] });
  await CapacitorSqlite.beginTransaction({ database: DB_STRESS });
  const start = Date.now();
  for (let i = 0; i < rows; i++) {
    await CapacitorSqlite.run({ database: DB_STRESS, statement: 'INSERT INTO t VALUES (?,?)', values: [i, `row${i}`] });
  }
  await CapacitorSqlite.commitTransaction({ database: DB_STRESS });
  const d = ms(start);
  await silentClose(DB_STRESS);
  return { durationMs: d, throughput: rateLabel(rows, d) };
}

async function benchConcurrentWrites(concurrency: number): Promise<{ durationMs: number; throughput: string }> {
  await silentClose(DB_STRESS);
  await CapacitorSqlite.open({ database: DB_STRESS });
  await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)'] });
  const start = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, (_, i) =>
      CapacitorSqlite.run({ database: DB_STRESS, statement: 'INSERT INTO t VALUES (?,?)', values: [i, `c${i}`] })
    )
  );
  const d = ms(start);
  await silentClose(DB_STRESS);
  return { durationMs: d, throughput: rateLabel(concurrency, d) };
}

async function benchMixedConcurrent(ops: number): Promise<{ durationMs: number; throughput: string; detail: string }> {
  await silentClose(DB_STRESS);
  await CapacitorSqlite.open({ database: DB_STRESS });
  await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)'] });
  // Pre-insert some rows for reads to consume
  for (let i = 0; i < 10; i++) {
    await CapacitorSqlite.run({ database: DB_STRESS, statement: 'INSERT INTO t VALUES (?,?)', values: [i, `seed${i}`] });
  }
  const start = Date.now();
  const writes = Array.from({ length: ops }, (_, i) =>
    CapacitorSqlite.run({ database: DB_STRESS, statement: 'INSERT INTO t VALUES (?,?)', values: [1000 + i, `w${i}`] })
  );
  const reads = Array.from({ length: ops }, () =>
    CapacitorSqlite.query({ database: DB_STRESS, statement: 'SELECT COUNT(*) AS n FROM t' })
  );
  const [wRes, rRes] = await Promise.all([Promise.all(writes), Promise.all(reads)]);
  const d = ms(start);
  const wOk = wRes.filter((r) => r.success).length;
  const rOk = rRes.filter((r) => r.success).length;
  await silentClose(DB_STRESS);
  return {
    durationMs: d,
    throughput: rateLabel(ops * 2, d),
    detail: `${wOk}/${ops} writes ok, ${rOk}/${ops} reads ok`,
  };
}

async function benchLargeTableScan(rows: number): Promise<{ durationMs: number; throughput: string; detail: string }> {
  await silentClose(DB_STRESS);
  await CapacitorSqlite.open({ database: DB_STRESS });
  await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)'] });
  const set = Array.from({ length: rows }, (_, i) => ({
    statement: 'INSERT INTO t VALUES (?,?)',
    values: [i, `row${i}`] as [number, string],
  }));
  await CapacitorSqlite.runBatch({ database: DB_STRESS, set });
  const start = Date.now();
  const r = await CapacitorSqlite.query({ database: DB_STRESS, statement: 'SELECT * FROM t' });
  const d = ms(start);
  const returned = r.success ? r.data.rows.length : 0;
  await silentClose(DB_STRESS);
  return { durationMs: d, throughput: rateLabel(rows, d), detail: `${returned.toLocaleString()} rows returned` };
}

async function benchFilteredQuery(rows: number): Promise<{ durationMs: number; throughput: string; detail: string }> {
  await silentClose(DB_STRESS);
  await CapacitorSqlite.open({ database: DB_STRESS });
  await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)'] });
  const set = Array.from({ length: rows }, (_, i) => ({
    statement: 'INSERT INTO t VALUES (?,?)',
    values: [i, `row${i}`] as [number, string],
  }));
  await CapacitorSqlite.runBatch({ database: DB_STRESS, set });
  const start = Date.now();
  // Filter + sort + limit — exercises full index-less scan
  const r = await CapacitorSqlite.query({
    database: DB_STRESS,
    statement: 'SELECT id, v FROM t WHERE id > ? ORDER BY id DESC LIMIT 100',
    values: [Math.floor(rows / 2)],
  });
  const d = ms(start);
  const returned = r.success ? r.data.rows.length : 0;
  await silentClose(DB_STRESS);
  return { durationMs: d, throughput: rateLabel(rows, d), detail: `${returned} rows returned` };
}

async function benchLargeText(sizeKb: number): Promise<{ durationMs: number; detail: string }> {
  const text = randomText(sizeKb * 1024);
  await silentClose(DB_STRESS);
  await CapacitorSqlite.open({ database: DB_STRESS });
  await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
  const writeStart = Date.now();
  await CapacitorSqlite.run({ database: DB_STRESS, statement: 'INSERT INTO t VALUES (?)', values: [text] });
  const writeMs = ms(writeStart);
  const readStart = Date.now();
  const r = await CapacitorSqlite.query({ database: DB_STRESS, statement: 'SELECT v FROM t' });
  const readMs = ms(readStart);
  const roundTrip = writeMs + readMs;
  const returned = r.success ? (r.data.rows[0] as { v: string }).v.length : 0;
  await silentClose(DB_STRESS);
  return {
    durationMs: roundTrip,
    detail: `write ${writeMs}ms, read ${readMs}ms, ${returned.toLocaleString()} chars`,
  };
}

async function benchLargeBlob(sizeKb: number): Promise<{ durationMs: number; detail: string }> {
  const blob = randomBlob(sizeKb * 1024);
  await silentClose(DB_STRESS);
  await CapacitorSqlite.open({ database: DB_STRESS });
  await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v BLOB)'] });
  const writeStart = Date.now();
  await CapacitorSqlite.run({ database: DB_STRESS, statement: 'INSERT INTO t VALUES (?)', values: [blob] });
  const writeMs = ms(writeStart);
  const readStart = Date.now();
  const r = await CapacitorSqlite.query({ database: DB_STRESS, statement: 'SELECT v FROM t' });
  const readMs = ms(readStart);
  const roundTrip = writeMs + readMs;
  const returned = r.success ? ((r.data.rows[0] as { v: unknown }).v instanceof Uint8Array ? (r.data.rows[0] as { v: Uint8Array }).v.length : -1) : -1;
  await silentClose(DB_STRESS);
  return {
    durationMs: roundTrip,
    detail: `write ${writeMs}ms, read ${readMs}ms, ${returned < 0 ? 'BAD TYPE' : `${returned.toLocaleString()} bytes`}`,
  };
}

const DB_A = 'stress_a';
const DB_B = 'stress_b';

async function benchMultiDbConcurrent(rowsEach: number): Promise<{ durationMs: number; throughput: string; detail: string }> {
  await silentClose(DB_A); await silentClose(DB_B);
  await CapacitorSqlite.open({ database: DB_A });
  await CapacitorSqlite.open({ database: DB_B });
  await CapacitorSqlite.execute({ database: DB_A, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER)'] });
  await CapacitorSqlite.execute({ database: DB_B, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER)'] });
  const start = Date.now();
  await Promise.all([
    ...Array.from({ length: rowsEach }, (_, i) =>
      CapacitorSqlite.run({ database: DB_A, statement: 'INSERT INTO t VALUES (?)', values: [i] })
    ),
    ...Array.from({ length: rowsEach }, (_, i) =>
      CapacitorSqlite.run({ database: DB_B, statement: 'INSERT INTO t VALUES (?)', values: [i] })
    ),
  ]);
  const d = ms(start);
  const qa = await CapacitorSqlite.query({ database: DB_A, statement: 'SELECT COUNT(*) AS n FROM t' });
  const qb = await CapacitorSqlite.query({ database: DB_B, statement: 'SELECT COUNT(*) AS n FROM t' });
  const na = qa.success ? (qa.data.rows[0] as { n: number }).n : -1;
  const nb = qb.success ? (qb.data.rows[0] as { n: number }).n : -1;
  await silentClose(DB_A); await silentClose(DB_B);
  return {
    durationMs: d,
    throughput: rateLabel(rowsEach * 2, d),
    detail: `DB-A: ${na} rows, DB-B: ${nb} rows`,
  };
}

// ── benchmark definitions ─────────────────────────────────────────────────────

interface Benchmark {
  id: string;
  name: string;
  description: string;
  run: () => Promise<{ durationMs: number; throughput?: string; detail?: string }>;
}

const BENCHMARKS: Benchmark[] = [
  {
    id: 's-01',
    name: 'Sequential run() — 500 rows',
    description: 'Inserts 500 rows one at a time via run(). Measures raw serial throughput.',
    run: () => benchSequentialRun(500),
  },
  {
    id: 's-02',
    name: 'runBatch() — 500 rows',
    description: 'Inserts 500 rows in a single runBatch() call. Shows batch overhead vs serial.',
    run: () => benchRunBatch(500),
  },
  {
    id: 's-03',
    name: 'Manual transaction — 500 rows',
    description: 'Inserts 500 rows inside beginTransaction()/commitTransaction(). Fastest write pattern.',
    run: () => benchManualTransaction(500),
  },
  {
    id: 's-04',
    name: 'Concurrent writes — 50 ops',
    description: 'Fires 50 INSERT calls simultaneously via Promise.all. Exercises the native queue.',
    run: () => benchConcurrentWrites(50),
  },
  {
    id: 's-05',
    name: 'Mixed concurrent read+write — 50+50',
    description: 'Fires 50 INSERTs and 50 SELECT COUNT(*) simultaneously. Tests read/write concurrency.',
    run: () => benchMixedConcurrent(50),
  },
  {
    id: 's-06',
    name: 'Large table scan — 5 000 rows',
    description: 'Inserts 5 000 rows then SELECT * — measures read throughput for large result sets.',
    run: () => benchLargeTableScan(5000),
  },
  {
    id: 's-07',
    name: 'Filtered query — 5 000 rows, WHERE+ORDER BY+LIMIT',
    description: 'Full-scan filter + sort + limit on 5 000 rows. Measures query planner overhead.',
    run: () => benchFilteredQuery(5000),
  },
  {
    id: 's-08',
    name: 'Large text — 50 KB write+read',
    description: 'Inserts and reads back a 50 KB TEXT value. Shows serialization overhead.',
    run: () => benchLargeText(50),
  },
  {
    id: 's-09',
    name: 'Large BLOB — 50 KB Uint8Array write+read',
    description: 'Inserts and reads back a 50 KB Uint8Array. Tests base64 encode/decode overhead.',
    run: () => benchLargeBlob(50),
  },
  {
    id: 's-10',
    name: 'Multi-DB concurrent — 2 DBs × 100 rows',
    description: 'Simultaneously inserts 100 rows into each of 2 open databases. Tests multi-DB isolation under load.',
    run: () => benchMultiDbConcurrent(100),
  },
];

// ── component ─────────────────────────────────────────────────────────────────

export const PageStress: React.FC = () => {
  const log = useLogger();
  const [results, setResults] = useState<Record<string, StressResult>>({});
  const [running, setRunning] = useState(false);

  const update = useCallback((id: string, patch: Partial<StressResult>) => {
    setResults((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { id, name: '', status: 'idle' }), ...patch } }));
  }, []);

  const runBench = useCallback(async (bench: Benchmark) => {
    update(bench.id, { id: bench.id, name: bench.name, status: 'running' });
    log.info('stress', `▶ ${bench.name}`);
    try {
      const r = await bench.run();
      update(bench.id, {
        status: 'done',
        durationMs: r.durationMs,
        throughput: r.throughput,
        detail: r.detail,
      });
      log.info('stress', `✓ ${bench.name} — ${r.durationMs}ms${r.throughput ? ` (${r.throughput})` : ''}${r.detail ? ` — ${r.detail}` : ''}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      update(bench.id, { status: 'error', detail: msg });
      log.error('stress', `✗ ${bench.name} — ${msg}`);
    }
  }, [update, log]);

  const runAll = useCallback(async () => {
    setRunning(true);
    for (const bench of BENCHMARKS) {
      await runBench(bench);
    }
    setRunning(false);
    log.info('stress', 'All benchmarks complete.');
  }, [runBench, log]);

  const runSingle = useCallback(async (bench: Benchmark) => {
    setRunning(true);
    await runBench(bench);
    setRunning(false);
  }, [runBench]);

  const clearResults = useCallback(() => setResults({}), []);

  const statusIcon = (r?: StressResult) => {
    if (!r || r.status === 'idle') return <span className="text-slate-300">○</span>;
    if (r.status === 'running') return <span className="animate-pulse text-indigo-500">…</span>;
    if (r.status === 'done')  return <span className="text-emerald-600">✓</span>;
    return <span className="text-red-600">✗</span>;
  };

  const rowColor = (r?: StressResult) => {
    if (!r || r.status === 'idle') return 'bg-slate-50';
    if (r.status === 'running') return 'bg-indigo-50';
    if (r.status === 'done')   return 'bg-emerald-50';
    return 'bg-red-50';
  };

  return (
    <div className="space-y-4">
      {/* Header / controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="green" onClick={runAll} disabled={running}>
          {running ? 'Running…' : `Run all ${BENCHMARKS.length} benchmarks`}
        </Button>
        <Button type="neutral" onClick={clearResults} disabled={running}>Clear</Button>
        <span className="text-xs text-slate-400">Each benchmark creates and drops its own database.</span>
      </div>

      {/* Table */}
      <div className="space-y-1">
        {BENCHMARKS.map((bench) => {
          const r = results[bench.id];
          return (
            <div
              key={bench.id}
              className={`flex items-start gap-2 px-3 py-2 rounded text-sm ${rowColor(r)}`}
            >
              {/* Status icon */}
              <span className="w-5 text-center flex-shrink-0 mt-0.5">{statusIcon(r)}</span>

              {/* Name + description */}
              <div className="flex-1 min-w-0">
                <div className="font-medium text-slate-800 leading-snug">{bench.name}</div>
                <div className="text-xs text-slate-500 mt-0.5">{bench.description}</div>

                {/* Metrics row */}
                {r && r.status === 'done' && (
                  <div className="flex flex-wrap gap-3 mt-1">
                    <span className="text-xs font-semibold text-slate-700">{r.durationMs?.toLocaleString()} ms</span>
                    {r.throughput && (
                      <span className="text-xs text-indigo-700 font-semibold">{r.throughput}</span>
                    )}
                    {r.detail && (
                      <span className="text-xs text-slate-500">{r.detail}</span>
                    )}
                  </div>
                )}
                {r && r.status === 'error' && (
                  <div className="text-xs text-red-600 mt-1 truncate">{r.detail}</div>
                )}
              </div>

              {/* Run button */}
              <button
                onClick={() => runSingle(bench)}
                disabled={running}
                className="text-xs text-indigo-600 hover:underline flex-shrink-0 disabled:opacity-40 mt-0.5"
              >
                run
              </button>
            </div>
          );
        })}
      </div>

      {/* Aggregate summary when all done */}
      {Object.keys(results).length === BENCHMARKS.length && !running && (() => {
        const done = BENCHMARKS.map((b) => results[b.id]).filter((r) => r?.status === 'done');
        const errors = BENCHMARKS.map((b) => results[b.id]).filter((r) => r?.status === 'error');
        const totalMs = done.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
        return (
          <div className="text-sm text-slate-600 border-t pt-3">
            <span className="font-semibold">{done.length}/{BENCHMARKS.length} benchmarks passed</span>
            {errors.length > 0 && <span className="text-red-600 ml-2">({errors.length} errors)</span>}
            <span className="ml-3 text-slate-400">total time: {(totalMs / 1000).toFixed(2)}s</span>
          </div>
        );
      })()}
    </div>
  );
};

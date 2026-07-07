import type { CapacitorSqlitePlugin } from '../../../src/definitions.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function ms(start: number) { return Date.now() - start; }

function rateLabel(count: number, durationMs: number) {
  if (durationMs <= 0) return 'too fast to measure';
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
const WRITE_ROWS = 10_000;
const CONCURRENT_WRITES = 10_000;
const MIXED_OPS_PER_SIDE = 5_000;
const SCAN_ROWS = 100_000;
const LARGE_VALUE_KB = 1_024;
const MULTI_DB_ROWS_EACH = 10_000;
const TRIGGER_ROWS = 10_000;

// ── benchmark definitions ─────────────────────────────────────────────────────

export interface Benchmark {
  id: string;
  name: string;
  description: string;
  run: () => Promise<{ durationMs: number; throughput?: string; detail?: string }>;
}

export function buildStressBenchmarks(CapacitorSqlite: CapacitorSqlitePlugin): Benchmark[] {
  const silentClose = (database: string): Promise<void> =>
    CapacitorSqlite.close({ database }).then(
      () => undefined,
      () => undefined,
    );

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
    const setA = Array.from({ length: rowsEach }, (_, i) => ({ statement: 'INSERT INTO t VALUES (?)', values: [i] }));
    const setB = Array.from({ length: rowsEach }, (_, i) => ({ statement: 'INSERT INTO t VALUES (?)', values: [i] }));
    const start = Date.now();
    await Promise.all([
      CapacitorSqlite.runBatch({ database: DB_A, set: setA }),
      CapacitorSqlite.runBatch({ database: DB_B, set: setB }),
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

  async function benchTriggerOverhead(rows: number): Promise<{ durationMs: number; throughput: string }> {
    await silentClose(DB_STRESS);
    await CapacitorSqlite.open({ database: DB_STRESS });
    await CapacitorSqlite.execute({ database: DB_STRESS, statements: [
      'DROP TABLE IF EXISTS t', 'DROP TABLE IF EXISTS t_log', 'DROP TRIGGER IF EXISTS trg_stress_log',
      'CREATE TABLE t (id INTEGER, v TEXT)',
      'CREATE TABLE t_log (id INTEGER, tier TEXT)',
      "CREATE TRIGGER trg_stress_log AFTER INSERT ON t BEGIN INSERT INTO t_log VALUES (NEW.id, CASE WHEN NEW.id % 2 = 0 THEN 'even' ELSE 'odd' END); END",
    ] });
    const start = Date.now();
    for (let i = 0; i < rows; i++) {
      await CapacitorSqlite.run({ database: DB_STRESS, statement: 'INSERT INTO t VALUES (?,?)', values: [i, `row${i}`] });
    }
    const d = ms(start);
    await silentClose(DB_STRESS);
    return { durationMs: d, throughput: rateLabel(rows, d) };
  }

  return [
    {
      id: 's-01',
      name: 'Sequential run() — 10 000 rows',
      description: 'Inserts 10 000 rows one at a time via run(). Measures bridge-heavy serial throughput.',
      run: () => benchSequentialRun(WRITE_ROWS),
    },
    {
      id: 's-02',
      name: 'runBatch() — 10 000 rows',
      description: 'Inserts 10 000 rows in a single runBatch() call. Shows batch overhead vs serial.',
      run: () => benchRunBatch(WRITE_ROWS),
    },
    {
      id: 's-03',
      name: 'Manual transaction — 10 000 rows',
      description: 'Inserts 10 000 rows inside beginTransaction()/commitTransaction(). Fastest run() write pattern.',
      run: () => benchManualTransaction(WRITE_ROWS),
    },
    {
      id: 's-04',
      name: 'Concurrent writes — 10 000 ops',
      description: 'Fires 10 000 INSERT calls simultaneously via Promise.all. Exercises queueing under bridge pressure.',
      run: () => benchConcurrentWrites(CONCURRENT_WRITES),
    },
    {
      id: 's-05',
      name: 'Mixed concurrent read+write — 5 000+5 000',
      description: 'Fires 5 000 INSERTs and 5 000 SELECT COUNT(*) simultaneously. Tests read/write concurrency.',
      run: () => benchMixedConcurrent(MIXED_OPS_PER_SIDE),
    },
    {
      id: 's-06',
      name: 'Large table scan — 100 000 rows',
      description: 'Inserts 100 000 rows then SELECT * — measures read throughput for large result sets.',
      run: () => benchLargeTableScan(SCAN_ROWS),
    },
    {
      id: 's-07',
      name: 'Filtered query — 100 000 rows, WHERE+ORDER BY+LIMIT',
      description: 'Full-scan filter + sort + limit on 100 000 rows. Measures query planner overhead.',
      run: () => benchFilteredQuery(SCAN_ROWS),
    },
    {
      id: 's-08',
      name: 'Large text — 1 MB write+read',
      description: 'Inserts and reads back a 1 MB TEXT value. Shows serialization overhead.',
      run: () => benchLargeText(LARGE_VALUE_KB),
    },
    {
      id: 's-09',
      name: 'Large BLOB — 1 MB Uint8Array write+read',
      description: 'Inserts and reads back a 1 MB Uint8Array. Tests binary bridge overhead.',
      run: () => benchLargeBlob(LARGE_VALUE_KB),
    },
    {
      id: 's-10',
      name: 'Multi-DB concurrent — 2 DBs × 10 000 rows',
      description: 'Simultaneously runBatch() inserts 10 000 rows into each of 2 open databases. Tests multi-DB isolation under load.',
      run: () => benchMultiDbConcurrent(MULTI_DB_ROWS_EACH),
    },
    {
      id: 's-11',
      name: 'Trigger overhead — 10 000 rows through AFTER INSERT trigger',
      description: 'Inserts 10 000 rows into a table with an AFTER INSERT trigger (CASE expression body) firing on each insert. Compare against s-01 to see trigger overhead.',
      run: () => benchTriggerOverhead(TRIGGER_ROWS),
    },
  ];
}

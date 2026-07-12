import type { CapacitorSqlitePlugin } from '../../../src/definitions.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function ms(start: number) { return Date.now() - start; }

function rateLabel(count: number, durationMs: number) {
  if (durationMs <= 0) return 'too fast to measure';
  const perSec = Math.round((count / durationMs) * 1000);
  return `${perSec.toLocaleString()} ops/s`;
}

function mustSucceed<T>(
  result: { success: true; data: T } | { success: false; error: { code: string; message: string } },
  label: string,
): T {
  if (!result.success) throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
  return result.data;
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
    mustSucceed(await CapacitorSqlite.open({ database: DB_STRESS }), 'open');
    mustSucceed(await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)'] }), 'setup');
    const start = Date.now();
    for (let i = 0; i < rows; i++) {
      mustSucceed(await CapacitorSqlite.run({ database: DB_STRESS, statement: 'INSERT INTO t VALUES (?,?)', values: [i, `row${i}`] }), `insert ${i}`);
    }
    const d = ms(start);
    const count = mustSucceed(
      await CapacitorSqlite.query({ database: DB_STRESS, statement: 'SELECT COUNT(*) AS n FROM t' }),
      'sequential count',
    );
    if ((count.rows[0] as { n: number }).n !== rows) throw new Error('sequential row count mismatch');
    await silentClose(DB_STRESS);
    return { durationMs: d, throughput: rateLabel(rows, d) };
  }

  async function benchRunBatch(rows: number): Promise<{ durationMs: number; throughput: string }> {
    await silentClose(DB_STRESS);
    mustSucceed(await CapacitorSqlite.open({ database: DB_STRESS }), 'open');
    mustSucceed(await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)'] }), 'setup');
    const set = Array.from({ length: rows }, (_, i) => ({
      statement: 'INSERT INTO t VALUES (?,?)',
      values: [i, `row${i}`] as [number, string],
    }));
    const start = Date.now();
    const batch = mustSucceed(await CapacitorSqlite.runBatch({ database: DB_STRESS, set }), 'runBatch');
    if (batch.changes < rows) throw new Error(`runBatch changed ${batch.changes}, expected at least ${rows}`);
    const d = ms(start);
    await silentClose(DB_STRESS);
    return { durationMs: d, throughput: rateLabel(rows, d) };
  }

  async function benchRunMany(rows: number): Promise<{ durationMs: number; throughput: string }> {
    await silentClose(DB_STRESS);
    mustSucceed(await CapacitorSqlite.open({ database: DB_STRESS }), 'open');
    mustSucceed(await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)'] }), 'setup');
    const values = Array.from({ length: rows }, (_, i) => [i, `row${i}`] as [number, string]);
    const start = Date.now();
    const many = mustSucceed(await CapacitorSqlite.runMany({
      database: DB_STRESS,
      statement: 'INSERT INTO t VALUES (?,?)',
      values,
    }), 'runMany');
    if (many.changes < rows) throw new Error(`runMany changed ${many.changes}, expected at least ${rows}`);
    const d = ms(start);
    await silentClose(DB_STRESS);
    return { durationMs: d, throughput: rateLabel(rows, d) };
  }

  async function benchManualTransaction(rows: number): Promise<{ durationMs: number; throughput: string }> {
    await silentClose(DB_STRESS);
    mustSucceed(await CapacitorSqlite.open({ database: DB_STRESS }), 'open');
    mustSucceed(await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)'] }), 'setup');
    mustSucceed(await CapacitorSqlite.beginTransaction({ database: DB_STRESS }), 'begin');
    const start = Date.now();
    for (let i = 0; i < rows; i++) {
      mustSucceed(await CapacitorSqlite.run({ database: DB_STRESS, statement: 'INSERT INTO t VALUES (?,?)', values: [i, `row${i}`] }), `insert ${i}`);
    }
    mustSucceed(await CapacitorSqlite.commitTransaction({ database: DB_STRESS }), 'commit');
    const d = ms(start);
    const count = mustSucceed(
      await CapacitorSqlite.query({ database: DB_STRESS, statement: 'SELECT COUNT(*) AS n FROM t' }),
      'transaction count',
    );
    if ((count.rows[0] as { n: number }).n !== rows) throw new Error('manual transaction row count mismatch');
    await silentClose(DB_STRESS);
    return { durationMs: d, throughput: rateLabel(rows, d) };
  }

  async function benchConcurrentWrites(concurrency: number): Promise<{ durationMs: number; throughput: string }> {
    await silentClose(DB_STRESS);
    mustSucceed(await CapacitorSqlite.open({ database: DB_STRESS }), 'open');
    mustSucceed(await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)'] }), 'setup');
    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        CapacitorSqlite.run({ database: DB_STRESS, statement: 'INSERT INTO t VALUES (?,?)', values: [i, `c${i}`] })
      )
    );
    results.forEach((result, index) => mustSucceed(result, `concurrent insert ${index}`));
    const d = ms(start);
    await silentClose(DB_STRESS);
    return { durationMs: d, throughput: rateLabel(concurrency, d) };
  }

  async function benchMixedConcurrent(ops: number): Promise<{ durationMs: number; throughput: string; detail: string }> {
    await silentClose(DB_STRESS);
    mustSucceed(await CapacitorSqlite.open({ database: DB_STRESS }), 'open');
    mustSucceed(await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)'] }), 'setup');
    // Pre-insert some rows for reads to consume
    for (let i = 0; i < 10; i++) {
      mustSucceed(await CapacitorSqlite.run({ database: DB_STRESS, statement: 'INSERT INTO t VALUES (?,?)', values: [i, `seed${i}`] }), `seed ${i}`);
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
    if (wOk !== ops || rOk !== ops) throw new Error(`mixed benchmark failures: writes ${wOk}/${ops}, reads ${rOk}/${ops}`);
    await silentClose(DB_STRESS);
    return {
      durationMs: d,
      throughput: rateLabel(ops * 2, d),
      detail: `${wOk}/${ops} writes ok, ${rOk}/${ops} reads ok`,
    };
  }

  async function benchLargeTableScan(rows: number): Promise<{ durationMs: number; throughput: string; detail: string }> {
    await silentClose(DB_STRESS);
    mustSucceed(await CapacitorSqlite.open({ database: DB_STRESS }), 'open');
    mustSucceed(await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)'] }), 'setup');
    const set = Array.from({ length: rows }, (_, i) => ({
      statement: 'INSERT INTO t VALUES (?,?)',
      values: [i, `row${i}`] as [number, string],
    }));
    mustSucceed(await CapacitorSqlite.runBatch({ database: DB_STRESS, set }), 'seed batch');
    const start = Date.now();
    const r = await CapacitorSqlite.query({ database: DB_STRESS, statement: 'SELECT * FROM t' });
    const d = ms(start);
    const returned = r.success ? r.data.rows.length : 0;
    if (!r.success) throw new Error(`scan failed [${r.error.code}]: ${r.error.message}`);
    if (returned !== rows) throw new Error(`scan returned ${returned}, expected ${rows}`);
    await silentClose(DB_STRESS);
    return { durationMs: d, throughput: rateLabel(rows, d), detail: `${returned.toLocaleString()} rows returned` };
  }

  async function benchFilteredQuery(rows: number): Promise<{ durationMs: number; throughput: string; detail: string }> {
    await silentClose(DB_STRESS);
    mustSucceed(await CapacitorSqlite.open({ database: DB_STRESS }), 'open');
    mustSucceed(await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)'] }), 'setup');
    const set = Array.from({ length: rows }, (_, i) => ({
      statement: 'INSERT INTO t VALUES (?,?)',
      values: [i, `row${i}`] as [number, string],
    }));
    mustSucceed(await CapacitorSqlite.runBatch({ database: DB_STRESS, set }), 'seed batch');
    const start = Date.now();
    // Filter + sort + limit — exercises full index-less scan
    const r = await CapacitorSqlite.query({
      database: DB_STRESS,
      statement: 'SELECT id, v FROM t WHERE id > ? ORDER BY id DESC LIMIT 100',
      values: [Math.floor(rows / 2)],
    });
    const d = ms(start);
    const returned = r.success ? r.data.rows.length : 0;
    if (!r.success) throw new Error(`filtered query failed [${r.error.code}]: ${r.error.message}`);
    if (returned !== 100) throw new Error(`filtered query returned ${returned}, expected 100`);
    await silentClose(DB_STRESS);
    return { durationMs: d, throughput: rateLabel(rows, d), detail: `${returned} rows returned` };
  }

  async function benchLargeText(sizeKb: number): Promise<{ durationMs: number; detail: string }> {
    const text = randomText(sizeKb * 1024);
    await silentClose(DB_STRESS);
    mustSucceed(await CapacitorSqlite.open({ database: DB_STRESS }), 'open');
    mustSucceed(await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] }), 'setup');
    const writeStart = Date.now();
    mustSucceed(await CapacitorSqlite.run({ database: DB_STRESS, statement: 'INSERT INTO t VALUES (?)', values: [text] }), 'large text write');
    const writeMs = ms(writeStart);
    const readStart = Date.now();
    const r = await CapacitorSqlite.query({ database: DB_STRESS, statement: 'SELECT v FROM t' });
    const readMs = ms(readStart);
    const roundTrip = writeMs + readMs;
    const returned = r.success ? (r.data.rows[0] as { v: string }).v.length : 0;
    if (!r.success) throw new Error(`large text read failed [${r.error.code}]: ${r.error.message}`);
    if ((r.data.rows[0] as { v: string }).v !== text) throw new Error('large text round-trip mismatch');
    await silentClose(DB_STRESS);
    return {
      durationMs: roundTrip,
      detail: `write ${writeMs}ms, read ${readMs}ms, ${returned.toLocaleString()} chars`,
    };
  }

  async function benchLargeBlob(sizeKb: number): Promise<{ durationMs: number; detail: string }> {
    const blob = randomBlob(sizeKb * 1024);
    await silentClose(DB_STRESS);
    mustSucceed(await CapacitorSqlite.open({ database: DB_STRESS }), 'open');
    mustSucceed(await CapacitorSqlite.execute({ database: DB_STRESS, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v BLOB)'] }), 'setup');
    const writeStart = Date.now();
    mustSucceed(await CapacitorSqlite.run({ database: DB_STRESS, statement: 'INSERT INTO t VALUES (?)', values: [blob] }), 'large BLOB write');
    const writeMs = ms(writeStart);
    const readStart = Date.now();
    const r = await CapacitorSqlite.query({ database: DB_STRESS, statement: 'SELECT v FROM t' });
    const readMs = ms(readStart);
    const roundTrip = writeMs + readMs;
    const returned = r.success ? ((r.data.rows[0] as { v: unknown }).v instanceof Uint8Array ? (r.data.rows[0] as { v: Uint8Array }).v.length : -1) : -1;
    if (!r.success) throw new Error(`large BLOB read failed [${r.error.code}]: ${r.error.message}`);
    const roundTripped = (r.data.rows[0] as { v: unknown }).v;
    if (!(roundTripped instanceof Uint8Array) || roundTripped.length !== blob.length) throw new Error('large BLOB type/length mismatch');
    for (let i = 0; i < blob.length; i++) {
      if (roundTripped[i] !== blob[i]) throw new Error(`large BLOB mismatch at byte ${i}`);
    }
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
    mustSucceed(await CapacitorSqlite.open({ database: DB_A }), 'open DB-A');
    mustSucceed(await CapacitorSqlite.open({ database: DB_B }), 'open DB-B');
    mustSucceed(await CapacitorSqlite.execute({ database: DB_A, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER)'] }), 'setup DB-A');
    mustSucceed(await CapacitorSqlite.execute({ database: DB_B, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER)'] }), 'setup DB-B');
    const setA = Array.from({ length: rowsEach }, (_, i) => ({ statement: 'INSERT INTO t VALUES (?)', values: [i] }));
    const setB = Array.from({ length: rowsEach }, (_, i) => ({ statement: 'INSERT INTO t VALUES (?)', values: [i] }));
    const start = Date.now();
    const batches = await Promise.all([
      CapacitorSqlite.runBatch({ database: DB_A, set: setA }),
      CapacitorSqlite.runBatch({ database: DB_B, set: setB }),
    ]);
    batches.forEach((result, index) => mustSucceed(result, `multi-DB batch ${index}`));
    const d = ms(start);
    const qa = await CapacitorSqlite.query({ database: DB_A, statement: 'SELECT COUNT(*) AS n FROM t' });
    const qb = await CapacitorSqlite.query({ database: DB_B, statement: 'SELECT COUNT(*) AS n FROM t' });
    const na = qa.success ? (qa.data.rows[0] as { n: number }).n : -1;
    const nb = qb.success ? (qb.data.rows[0] as { n: number }).n : -1;
    if (na !== rowsEach || nb !== rowsEach) throw new Error(`multi-DB row mismatch: A=${na}, B=${nb}, expected ${rowsEach}`);
    await silentClose(DB_A); await silentClose(DB_B);
    return {
      durationMs: d,
      throughput: rateLabel(rowsEach * 2, d),
      detail: `DB-A: ${na} rows, DB-B: ${nb} rows`,
    };
  }

  async function benchTriggerOverhead(rows: number): Promise<{ durationMs: number; throughput: string }> {
    await silentClose(DB_STRESS);
    mustSucceed(await CapacitorSqlite.open({ database: DB_STRESS }), 'open');
    mustSucceed(await CapacitorSqlite.execute({ database: DB_STRESS, statements: [
      'DROP TABLE IF EXISTS t', 'DROP TABLE IF EXISTS t_log', 'DROP TRIGGER IF EXISTS trg_stress_log',
      'CREATE TABLE t (id INTEGER, v TEXT)',
      'CREATE TABLE t_log (id INTEGER, tier TEXT)',
      "CREATE TRIGGER trg_stress_log AFTER INSERT ON t BEGIN INSERT INTO t_log VALUES (NEW.id, CASE WHEN NEW.id % 2 = 0 THEN 'even' ELSE 'odd' END); END",
    ] }), 'trigger setup');
    const start = Date.now();
    for (let i = 0; i < rows; i++) {
      mustSucceed(await CapacitorSqlite.run({ database: DB_STRESS, statement: 'INSERT INTO t VALUES (?,?)', values: [i, `row${i}`] }), `trigger insert ${i}`);
    }
    const d = ms(start);
    const count = mustSucceed(await CapacitorSqlite.query({ database: DB_STRESS, statement: 'SELECT COUNT(*) AS n FROM t_log' }), 'trigger count');
    if ((count.rows[0] as { n: number }).n !== rows) throw new Error('trigger did not fire for every inserted row');
    await silentClose(DB_STRESS);
    return { durationMs: d, throughput: rateLabel(rows, d) };
  }

  return [
    {
      id: 's-01',
      name: 'Sequential run() — 10 000 rows',
      description: 'Inserts 10 000 rows one at a time via awaited run(). Measures the real end-to-end serial API cost.',
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
      name: 'runMany() — 10 000 rows',
      description: 'Inserts 10 000 rows with one repeated SQL string and many value sets. Compare directly with runBatch().',
      run: () => benchRunMany(WRITE_ROWS),
    },
    {
      id: 's-04',
      name: 'Manual transaction — 10 000 awaited rows',
      description: 'Inserts 10 000 individually awaited rows inside beginTransaction()/commitTransaction(). Separates commit cost from per-call latency.',
      run: () => benchManualTransaction(WRITE_ROWS),
    },
    {
      id: 's-05',
      name: 'Concurrent writes — 10 000 ops',
      description: 'Fires 10 000 INSERT calls simultaneously via Promise.all. Measures pipelined end-to-end queue throughput.',
      run: () => benchConcurrentWrites(CONCURRENT_WRITES),
    },
    {
      id: 's-06',
      name: 'Mixed concurrent read+write — 5 000+5 000',
      description: 'Fires 5 000 INSERTs and 5 000 SELECT COUNT(*) calls simultaneously. Tests sustained read/write concurrency.',
      run: () => benchMixedConcurrent(MIXED_OPS_PER_SIDE),
    },
    {
      id: 's-07',
      name: 'Large table scan — 100 000 rows',
      description: 'Inserts 100 000 rows then SELECT * — measures read throughput for large result sets.',
      run: () => benchLargeTableScan(SCAN_ROWS),
    },
    {
      id: 's-08',
      name: 'Filtered query — 100 000 rows, WHERE+ORDER BY+LIMIT',
      description: 'Full-scan filter + sort + limit on 100 000 rows. Measures query planner overhead.',
      run: () => benchFilteredQuery(SCAN_ROWS),
    },
    {
      id: 's-09',
      name: 'Large text — 1 MB write+read',
      description: 'Inserts and reads back a 1 MB TEXT value. Shows serialization overhead.',
      run: () => benchLargeText(LARGE_VALUE_KB),
    },
    {
      id: 's-10',
      name: 'Large BLOB — 1 MB Uint8Array write+read',
      description: 'Inserts and reads back a 1 MB Uint8Array. Tests binary bridge overhead.',
      run: () => benchLargeBlob(LARGE_VALUE_KB),
    },
    {
      id: 's-11',
      name: 'Multi-DB concurrent — 2 DBs × 10 000 rows',
      description: 'Simultaneously runBatch() inserts 10 000 rows into each of 2 open databases. Tests multi-DB isolation under load.',
      run: () => benchMultiDbConcurrent(MULTI_DB_ROWS_EACH),
    },
    {
      id: 's-12',
      name: 'Trigger overhead — 10 000 awaited rows',
      description: 'Inserts 10 000 individually awaited rows through an AFTER INSERT trigger. Compare with s-01 to expose actual trigger overhead.',
      run: () => benchTriggerOverhead(WRITE_ROWS),
    },
  ];
}

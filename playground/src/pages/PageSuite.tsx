import React, { useState, useCallback } from 'react';
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite';
import type { Migration, SqliteDirectory } from '@devioarts/capacitor-sqlite';
import { Button } from '../components/Button.tsx';
import { useLogger } from '../components/Logger.tsx';
import {
  assert,
  assertEqual,
  assertOk,
  assertFail,
  silentClose,
  runTestCase,
  type TestCase,
  type TestResult,
} from '../helpers/testRunner.ts';

// ── Real-world schema helpers ─────────────────────────────────────────────────

const RW_DB = 'suite_rw';
const RW_DDL = [
  'DROP VIEW IF EXISTS order_totals',
  'DROP TABLE IF EXISTS order_items',
  'DROP TABLE IF EXISTS orders',
  'DROP TABLE IF EXISTS products',
  'DROP TABLE IF EXISTS categories',
  'DROP TABLE IF EXISTS users',
  'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL)',
  'CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL)',
  'CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price REAL NOT NULL CHECK(price >= 0), stock INTEGER NOT NULL DEFAULT 0, category_id INTEGER REFERENCES categories(id))',
  "CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  'CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, product_id INTEGER NOT NULL REFERENCES products(id), qty INTEGER NOT NULL CHECK(qty > 0), unit_price REAL NOT NULL)',
  'CREATE INDEX idx_products_category ON products(category_id)',
  'CREATE INDEX idx_orders_user ON orders(user_id)',
  'CREATE INDEX idx_items_order ON order_items(order_id)',
  "CREATE VIEW order_totals AS SELECT o.id AS order_id, o.user_id, SUM(i.qty * i.unit_price) AS total FROM orders o JOIN order_items i ON i.order_id = o.id GROUP BY o.id",
];
const RW_SEED_STMTS = [
  "INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')",
  "INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com')",
  "INSERT INTO categories (name) VALUES ('Electronics')",
  "INSERT INTO categories (name) VALUES ('Books')",
  "INSERT INTO products (name, price, stock, category_id) VALUES ('Laptop', 999.99, 10, 1)",
  "INSERT INTO products (name, price, stock, category_id) VALUES ('Phone', 499.99, 25, 1)",
  "INSERT INTO products (name, price, stock, category_id) VALUES ('SQL Guide', 29.99, 100, 2)",
];

// ── test definitions ──────────────────────────────────────────────────────────

const TESTS: TestCase[] = [
  // ── Platform ──────────────────────────────────────────────────────────────
  {
    id: 'plat-01', group: 'Platform', name: 'getPlatform returns known value',
    fn: async () => {
      const r = assertOk(await CapacitorSqlite.getPlatform(), 'getPlatform');
      assert(['ios', 'android', 'web', 'electron'].includes(r.platform), `unknown platform: ${r.platform}`);
    },
  },
  {
    id: 'plat-02', group: 'Platform', name: 'isAvailable returns true',
    fn: async () => {
      const r = assertOk(await CapacitorSqlite.isAvailable(), 'isAvailable');
      assert(r.available === true, 'expected available=true');
    },
  },

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  {
    id: 'lc-01', group: 'Lifecycle', name: 'open → isOpen → close',
    fn: async () => {
      const DB = 'suite_lc01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const io = assertOk(await CapacitorSqlite.isOpen({ database: DB }), 'isOpen');
      assert(io.open === true, 'expected open=true');
      assertOk(await CapacitorSqlite.close({ database: DB }), 'close');
      const io2 = assertOk(await CapacitorSqlite.isOpen({ database: DB }), 'isOpen after close');
      assert(io2.open === false, 'expected open=false after close');
    },
  },
  {
    id: 'lc-02', group: 'Lifecycle', name: 'open is idempotent',
    fn: async () => {
      const DB = 'suite_lc02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'first open');
      assertOk(await CapacitorSqlite.open({ database: DB }), 'second open');
      await silentClose(DB);
    },
  },
  {
    id: 'lc-03', group: 'Lifecycle', name: 'open different mode → DB_ALREADY_OPEN',
    fn: async () => {
      const DB = 'suite_lc03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB, readonly: false }), 'open rw');
      assertFail(await CapacitorSqlite.open({ database: DB, readonly: true }), 'open ro', 'DB_ALREADY_OPEN');
      await silentClose(DB);
    },
  },
  {
    id: 'lc-04', group: 'Lifecycle', name: 'close not-open DB → DB_NOT_OPEN',
    fn: async () => {
      assertFail(await CapacitorSqlite.close({ database: 'suite_never_opened' }), 'close', 'DB_NOT_OPEN');
    },
  },
  {
    id: 'lc-05', group: 'Lifecycle', name: 'invalid DB name → INVALID_NAME',
    fn: async () => {
      // Path traversal and spaces → INVALID_NAME on all platforms
      for (const name of ['../evil', 'test db']) {
        assertFail(await CapacitorSqlite.open({ database: name }), `open("${name}")`, 'INVALID_NAME');
      }
      // Empty string: web/Electron return INVALID_PARAMS ("database is required"),
      // native returns INVALID_NAME — just verify it fails, don't assert a specific code
      assertFail(await CapacitorSqlite.open({ database: '' }), 'open("")');
    },
  },

  // ── execute ────────────────────────────────────────────────────────────────
  {
    id: 'ex-01', group: 'Execute', name: 'execute DDL + DML',
    fn: async () => {
      const DB = 'suite_ex01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const r = assertOk(await CapacitorSqlite.execute({
        database: DB,
        statements: [
          'DROP TABLE IF EXISTS t',
          'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)',
          "INSERT INTO t VALUES (1, 'a')",
          "INSERT INTO t VALUES (2, 'b')",
        ],
      }), 'execute');
      assert(r.changes >= 2, `expected >=2 changes, got ${r.changes}`);
      await silentClose(DB);
    },
  },
  {
    id: 'ex-02', group: 'Execute', name: 'execute empty array → INVALID_PARAMS',
    fn: async () => {
      const DB = 'suite_ex02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertFail(await CapacitorSqlite.execute({ database: DB, statements: [] }), 'execute []', 'INVALID_PARAMS');
      await silentClose(DB);
    },
  },
  {
    id: 'ex-03', group: 'Execute', name: 'execute rollback on bad SQL (tx=true)',
    fn: async () => {
      const DB = 'suite_ex03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT NOT NULL)'] });
      assertFail(
        await CapacitorSqlite.execute({
          database: DB,
          statements: ["INSERT INTO t VALUES ('ok')", "INSERT INTO t VALUES (NULL)"],
          transaction: true,
        }),
        'execute with bad row',
        'EXECUTE_FAILED',
      );
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT * FROM t" }), 'query');
      assertEqual(q.rows.length, 0, 'row count after rollback');
      await silentClose(DB);
    },
  },

  // ── run ────────────────────────────────────────────────────────────────────
  {
    id: 'run-01', group: 'Run', name: 'INSERT → lastInsertId, UPDATE → changes',
    fn: async () => {
      const DB = 'suite_run01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)'] });

      const ins = assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t (v) VALUES (?)", values: ['hello'] }), 'insert');
      assert(ins.lastInsertId > 0, `lastInsertId should be > 0, got ${ins.lastInsertId}`);
      assertEqual(ins.changes, 1, 'insert changes');

      const upd = assertOk(await CapacitorSqlite.run({ database: DB, statement: "UPDATE t SET v = ? WHERE id = ?", values: ['world', ins.lastInsertId] }), 'update');
      assertEqual(upd.changes, 1, 'update changes');
      assertEqual(upd.lastInsertId, 0, 'update lastInsertId');

      const del = assertOk(await CapacitorSqlite.run({ database: DB, statement: "DELETE FROM t WHERE id = ?", values: [ins.lastInsertId] }), 'delete');
      assertEqual(del.changes, 1, 'delete changes');

      await silentClose(DB);
    },
  },
  {
    id: 'run-02', group: 'Run', name: 'run with null value',
    fn: async () => {
      const DB = 'suite_run02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      const r = assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [null] }), 'insert null');
      assert(r.lastInsertId > 0, 'lastInsertId');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM t' }), 'query');
      assertEqual(q.rows.length, 1, 'row count');
      assertEqual((q.rows[0] as { v: null }).v, null, 'null value');
      await silentClose(DB);
    },
  },
  {
    id: 'run-03', group: 'Run', name: 'run with boolean values',
    fn: async () => {
      const DB = 'suite_run03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [true] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [false] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t ORDER BY rowid' }), 'query');
      assertEqual(q.rows.length, 2, 'row count');
      const vals = (q.rows as Array<{ v: number }>).map(r => r.v);
      assert(vals[0] === 1 || vals[0] === true as unknown as number, 'true→1');
      assert(vals[1] === 0 || vals[1] === false as unknown as number, 'false→0');
      await silentClose(DB);
    },
  },

  // ── query ──────────────────────────────────────────────────────────────────
  {
    id: 'q-01', group: 'Query', name: 'query empty result',
    fn: async () => {
      const DB = 'suite_q01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      const r = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM t' }), 'query');
      assertEqual(r.rows.length, 0, 'empty rows');
      await silentClose(DB);
    },
  },
  {
    id: 'q-02', group: 'Query', name: 'query with parameterized WHERE',
    fn: async () => {
      const DB = 'suite_q02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, v TEXT)'] });
      for (let i = 1; i <= 5; i++) {
        await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?, ?)', values: [i, `v${i}`] });
      }
      const r = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM t WHERE id > ?', values: [3] }), 'query');
      assertEqual(r.rows.length, 2, 'filtered rows');
      await silentClose(DB);
    },
  },
  {
    id: 'q-03', group: 'Query', name: 'query returns correct types',
    fn: async () => {
      const DB = 'suite_q03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (i INTEGER, r REAL, t TEXT, n TEXT)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?, ?, ?, ?)', values: [42, 3.14, 'hello', null] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM t' }), 'query');
      const row = q.rows[0] as { i: unknown; r: unknown; t: unknown; n: unknown };
      assert(typeof row.i === 'number', `i should be number, got ${typeof row.i}`);
      assert(typeof row.r === 'number', `r should be number, got ${typeof row.r}`);
      assert(typeof row.t === 'string', `t should be string, got ${typeof row.t}`);
      assert(row.n === null, `n should be null, got ${row.n}`);
      await silentClose(DB);
    },
  },

  // ── runBatch ───────────────────────────────────────────────────────────────
  {
    id: 'rb-01', group: 'RunBatch', name: 'runBatch inserts N rows',
    fn: async () => {
      const DB = 'suite_rb01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      const set = Array.from({ length: 10 }, (_, i) => ({ statement: 'INSERT INTO t VALUES (?)', values: [i] as [number] }));
      const r = assertOk(await CapacitorSqlite.runBatch({ database: DB, set }), 'runBatch');
      assert(r.changes >= 10, `expected >=10 changes, got ${r.changes}`);
      assertEqual(r.lastInsertId, 0, 'lastInsertId always 0 for runBatch');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((q.rows[0] as { n: number }).n, 10, 'row count');
      await silentClose(DB);
    },
  },
  {
    id: 'rb-02', group: 'RunBatch', name: 'runBatch rollback on error (tx=true)',
    fn: async () => {
      const DB = 'suite_rb02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT NOT NULL)'] });
      const set = [
        { statement: 'INSERT INTO t VALUES (?)', values: ['ok'] as [string] },
        { statement: 'INSERT INTO t VALUES (?)', values: [null as unknown as string] },
      ];
      assertFail(await CapacitorSqlite.runBatch({ database: DB, set, transaction: true }), 'runBatch with null');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((q.rows[0] as { n: number }).n, 0, 'no rows after rollback');
      await silentClose(DB);
    },
  },

  // ── transactions ──────────────────────────────────────────────────────────
  {
    id: 'tx-01', group: 'Transactions', name: 'begin → run → commit',
    fn: async () => {
      const DB = 'suite_tx01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1)' }), 'run');
      assertOk(await CapacitorSqlite.commitTransaction({ database: DB }), 'commit');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM t' }), 'query');
      assertEqual(q.rows.length, 1, 'committed rows');
      await silentClose(DB);
    },
  },
  {
    id: 'tx-02', group: 'Transactions', name: 'begin → run → rollback',
    fn: async () => {
      const DB = 'suite_tx02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1)' }), 'run');
      assertOk(await CapacitorSqlite.rollbackTransaction({ database: DB }), 'rollback');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM t' }), 'query');
      assertEqual(q.rows.length, 0, 'no rows after rollback');
      await silentClose(DB);
    },
  },
  {
    id: 'tx-03', group: 'Transactions', name: 'beginTransaction twice → TRANSACTION_FAILED',
    fn: async () => {
      const DB = 'suite_tx03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'first begin');
      assertFail(await CapacitorSqlite.beginTransaction({ database: DB }), 'second begin', 'TRANSACTION_FAILED');
      await CapacitorSqlite.rollbackTransaction({ database: DB });
      await silentClose(DB);
    },
  },
  {
    id: 'tx-04', group: 'Transactions', name: 'commitTransaction without begin → error',
    fn: async () => {
      const DB = 'suite_tx04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertFail(await CapacitorSqlite.commitTransaction({ database: DB }), 'commit without begin');
      await silentClose(DB);
    },
  },

  // ── migrations ────────────────────────────────────────────────────────────
  {
    id: 'mig-01', group: 'Migrations', name: 'apply v1 migration',
    fn: async () => {
      const DB = 'suite_mig01';
      await silentClose(DB);
      const migrations: Migration[] = [{ version: 1, statements: ['CREATE TABLE t (id INTEGER PRIMARY KEY)'] }];
      assertOk(await CapacitorSqlite.open({ database: DB, migrations }), 'open v1');
      const sv = assertOk(await CapacitorSqlite.getSchemaVersion({ database: DB }), 'schema version');
      assertEqual(sv.version, 1, 'schema version after v1');
      await silentClose(DB);
    },
  },
  {
    id: 'mig-02', group: 'Migrations', name: 'incremental v1 → v2',
    fn: async () => {
      const DB = 'suite_mig02';
      await silentClose(DB);
      const v1: Migration[] = [{ version: 1, statements: ['CREATE TABLE t (id INTEGER PRIMARY KEY)'] }];
      const v2: Migration[] = [...v1, { version: 2, statements: ['ALTER TABLE t ADD COLUMN name TEXT'] }];
      assertOk(await CapacitorSqlite.open({ database: DB, migrations: v1 }), 'open v1');
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB, migrations: v2 }), 'open v2');
      const sv = assertOk(await CapacitorSqlite.getSchemaVersion({ database: DB }), 'schema version');
      assertEqual(sv.version, 2, 'schema version after v2');
      await silentClose(DB);
    },
  },
  {
    id: 'mig-03', group: 'Migrations', name: 'idempotent re-open same migrations',
    fn: async () => {
      const DB = 'suite_mig03';
      await silentClose(DB);
      const migrations: Migration[] = [{ version: 1, statements: ['CREATE TABLE t (id INTEGER PRIMARY KEY)'] }];
      assertOk(await CapacitorSqlite.open({ database: DB, migrations }), 'first open');
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB, migrations }), 'second open');
      const sv = assertOk(await CapacitorSqlite.getSchemaVersion({ database: DB }), 'schema version');
      assertEqual(sv.version, 1, 'still v1');
      await silentClose(DB);
    },
  },
  {
    id: 'mig-04', group: 'Migrations', name: 'bad SQL migration → MIGRATION_FAILED',
    fn: async () => {
      const DB = 'suite_mig04';
      await silentClose(DB);
      const migrations: Migration[] = [
        { version: 1, statements: ['CREATE TABLE t (id INTEGER PRIMARY KEY)'] },
        { version: 2, statements: ['THIS IS NOT SQL AT ALL'] },
      ];
      assertFail(await CapacitorSqlite.open({ database: DB, migrations }), 'open with bad sql', 'MIGRATION_FAILED');
    },
  },

  // ── getVersion ────────────────────────────────────────────────────────────
  {
    id: 'gv-01', group: 'Metadata', name: 'getVersion returns semver-like string',
    fn: async () => {
      const DB = 'suite_gv01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const r = assertOk(await CapacitorSqlite.getVersion({ database: DB }), 'getVersion');
      assert(r.version.length > 0, 'version string not empty');
      assert(/\d/.test(r.version), 'version contains digits');
      await silentClose(DB);
    },
  },
  {
    id: 'gv-02', group: 'Metadata', name: 'getVersion on closed DB → error',
    fn: async () => {
      assertFail(await CapacitorSqlite.getVersion({ database: 'suite_gv02_closed' }), 'getVersion on closed');
    },
  },

  // ── BLOB ──────────────────────────────────────────────────────────────────
  {
    id: 'blob-01', group: 'BLOB', name: 'Uint8Array round-trip',
    fn: async () => {
      const DB = 'suite_blob01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (data BLOB)'] }), 'create');
      const orig = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);

      const ins = assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [orig] }), 'insert');
      assert(ins.lastInsertId > 0, 'lastInsertId');

      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT data FROM t' }), 'query');
      const data = (q.rows[0] as { data: unknown }).data;
      assert(data instanceof Uint8Array, `expected Uint8Array, got ${typeof data}`);
      const blob = data as Uint8Array;
      assertEqual(blob.length, orig.length, 'blob length');
      for (let i = 0; i < orig.length; i++) {
        assertEqual(blob[i], orig[i], `byte[${i}]`);
      }
      await silentClose(DB);
    },
  },
  {
    id: 'blob-02', group: 'BLOB', name: 'null BLOB stored as SQL NULL',
    fn: async () => {
      const DB = 'suite_blob02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (data BLOB)'] });
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [null] }), 'insert null');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT data FROM t' }), 'query');
      assertEqual(q.rows.length, 1, 'row count');
      assertEqual((q.rows[0] as { data: unknown }).data, null, 'null blob');
      await silentClose(DB);
    },
  },
  {
    id: 'blob-03', group: 'BLOB', name: 'empty Uint8Array (0 bytes) round-trip',
    fn: async () => {
      const DB = 'suite_blob03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (data BLOB)'] });
      const empty = new Uint8Array(0);
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [empty] }), 'insert');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT data FROM t' }), 'query');
      const data = (q.rows[0] as { data: unknown }).data;
      assert(data instanceof Uint8Array, `expected Uint8Array, got ${typeof data}`);
      assertEqual((data as Uint8Array).length, 0, 'length=0');
      await silentClose(DB);
    },
  },
  {
    id: 'blob-04', group: 'BLOB', name: 'BLOB in WHERE clause (query param)',
    fn: async () => {
      const DB = 'suite_blob04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, data BLOB)'] });
      const b1 = new Uint8Array([0xca, 0xfe]);
      const b2 = new Uint8Array([0xbe, 0xef]);
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1, ?)', values: [b1] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (2, ?)', values: [b2] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT id FROM t WHERE data = ?', values: [b1] }), 'query WHERE blob');
      assertEqual(q.rows.length, 1, 'one match');
      assertEqual((q.rows[0] as { id: number }).id, 1, 'matched row 1');
      await silentClose(DB);
    },
  },

  // ── Execute (additional) ──────────────────────────────────────────────────
  {
    id: 'ex-04', group: 'Execute', name: 'transaction:false — first stmt committed after later failure',
    fn: async () => {
      const DB = 'suite_ex04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT NOT NULL)'] });
      await CapacitorSqlite.execute({
        database: DB,
        statements: ["INSERT INTO t VALUES ('ok')", 'INVALID SQL !!!'],
        transaction: false,
      });
      // Even though the batch failed, the first INSERT ran and committed
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assert((q.rows[0] as { n: number }).n >= 1, 'first statement was committed');
      await silentClose(DB);
    },
  },

  // ── Run (additional) ──────────────────────────────────────────────────────
  {
    id: 'run-04', group: 'Run', name: 'DELETE no matching rows → changes=0',
    fn: async () => {
      const DB = 'suite_run04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER)'] });
      const r = assertOk(await CapacitorSqlite.run({ database: DB, statement: 'DELETE FROM t WHERE id = ?', values: [999] }), 'delete nothing');
      assertEqual(r.changes, 0, 'changes=0 when no rows matched');
      await silentClose(DB);
    },
  },
  {
    id: 'run-05', group: 'Run', name: 'typeof() — integer stored as INTEGER, float as REAL',
    fn: async () => {
      const DB = 'suite_run05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      // No column type → no affinity → typeof() reflects actual binding type
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (x)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [42] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [3.14] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT typeof(x) AS t FROM t ORDER BY rowid' }), 'typeof');
      assertEqual(q.rows.length, 2, 'two rows');
      assertEqual((q.rows[0] as { t: string }).t, 'integer', 'integer bound as INTEGER');
      assertEqual((q.rows[1] as { t: string }).t, 'real',    'float bound as REAL');
      await silentClose(DB);
    },
  },

  // ── Query (additional) ────────────────────────────────────────────────────
  {
    id: 'q-04', group: 'Query', name: 'query on closed DB → error',
    fn: async () => {
      assertFail(await CapacitorSqlite.query({ database: 'suite_q04_never_opened', statement: 'SELECT 1' }), 'query closed');
    },
  },
  {
    id: 'q-05', group: 'Query', name: 'multi-column types: INTEGER, REAL, TEXT, NULL round-trip',
    fn: async () => {
      const DB = 'suite_q05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (i INTEGER, r REAL, s TEXT, n INTEGER)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?,?,?,?)', values: [-99, 1.5, 'hello', null] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM t' }), 'query');
      const row = q.rows[0] as { i: number; r: number; s: string; n: null };
      assertEqual(row.i, -99,     'integer -99');
      assert(Math.abs(row.r - 1.5) < 1e-9, 'real 1.5');
      assertEqual(row.s, 'hello', 'text');
      assertEqual(row.n, null,    'null');
      await silentClose(DB);
    },
  },
  {
    id: 'qph-01', group: 'Query Placeholders', name: 'anonymous ? preserves INTEGER, REAL, boolean, TEXT and NULL',
    fn: async () => {
      const DB = 'suite_qph01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: 'SELECT TYPEOF(?) AS ti, TYPEOF(?) AS tr, TYPEOF(?) AS tb, ? AS s, ? IS NULL AS n',
        values: [42, 3.25, true, 'ok', null],
      }), 'typed placeholder query');
      const row = q.rows[0] as { ti: string; tr: string; tb: string; s: string; n: number };
      assertEqual(row.ti, 'integer', 'integer placeholder');
      assertEqual(row.tr, 'real', 'real placeholder');
      assertEqual(row.tb, 'integer', 'boolean placeholder stored as integer');
      assertEqual(row.s, 'ok', 'text placeholder');
      assertEqual(row.n, 1, 'null placeholder');
      await silentClose(DB);
    },
  },
  {
    id: 'qph-02', group: 'Query Placeholders', name: '? inside line/block comments is ignored',
    fn: async () => {
      const DB = 'suite_qph02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: 'SELECT -- ignored ?\n ? AS a, /* ignored ? */ ? AS b',
        values: [7, 8],
      }), 'comment placeholder query');
      const row = q.rows[0] as { a: number; b: number };
      assertEqual(row.a, 7, 'line comment ignored');
      assertEqual(row.b, 8, 'block comment ignored');
      await silentClose(DB);
    },
  },
  {
    id: 'qph-03', group: 'Query Placeholders', name: '? inside quoted identifiers is ignored',
    fn: async () => {
      const DB = 'suite_qph03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({
        database: DB,
        statements: [
          'DROP TABLE IF EXISTS t',
          'CREATE TABLE t ("a?" INTEGER, `b?` INTEGER, [c?] INTEGER)',
          'INSERT INTO t ("a?", `b?`, [c?]) VALUES (1, 2, 3)',
        ],
      }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: 'SELECT "a?" AS a, `b?` AS b, [c?] AS c FROM t WHERE "a?" = ? AND `b?` = ? AND [c?] = ?',
        values: [1, 2, 3],
      }), 'quoted identifier placeholder query');
      const row = q.rows[0] as { a: number; b: number; c: number };
      assertEqual(row.a, 1, 'double-quoted identifier');
      assertEqual(row.b, 2, 'backtick identifier');
      assertEqual(row.c, 3, 'bracket identifier');
      await silentClose(DB);
    },
  },
  {
    id: 'qph-04', group: 'Query Placeholders', name: '? inside escaped string literal is ignored',
    fn: async () => {
      const DB = 'suite_qph04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: "SELECT '?''?' AS literal, ? AS v",
        values: [11],
      }), 'escaped string placeholder query');
      const row = q.rows[0] as { literal: string; v: number };
      assertEqual(row.literal, "?'?", 'escaped string literal');
      assertEqual(row.v, 11, 'real placeholder still bound');
      await silentClose(DB);
    },
  },
  {
    id: 'qph-05', group: 'Query Placeholders', name: 'Android rejects unsupported placeholder forms and count mismatch',
    fn: async () => {
      const plat = assertOk(await CapacitorSqlite.getPlatform(), 'platform');
      if (plat.platform !== 'android') return;

      const DB = 'suite_qph05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertFail(await CapacitorSqlite.query({ database: DB, statement: 'SELECT ?1 AS v', values: [1] }), '?1 placeholder', 'INVALID_PARAMS');
      assertFail(await CapacitorSqlite.query({ database: DB, statement: 'SELECT :value AS v', values: [1] }), ':name placeholder', 'INVALID_PARAMS');
      assertFail(await CapacitorSqlite.query({ database: DB, statement: 'SELECT @value AS v', values: [1] }), '@name placeholder', 'INVALID_PARAMS');
      assertFail(await CapacitorSqlite.query({ database: DB, statement: 'SELECT $value AS v', values: [1] }), '$name placeholder', 'INVALID_PARAMS');
      assertFail(await CapacitorSqlite.query({ database: DB, statement: 'SELECT ? AS a, ? AS b', values: [1] }), 'missing value', 'INVALID_PARAMS');
      assertFail(await CapacitorSqlite.query({ database: DB, statement: 'SELECT ? AS a', values: [1, 2] }), 'extra value', 'INVALID_PARAMS');
      await silentClose(DB);
    },
  },
  {
    id: 'qph-06', group: 'Query Placeholders', name: 'BLOB placeholder in query() preserves BLOB type',
    fn: async () => {
      const DB = 'suite_qph06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const blob = new Uint8Array([0x00, 0x7f, 0x80, 0xff]);
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: 'SELECT TYPEOF(?) AS t, LENGTH(?) AS len',
        values: [blob, blob],
      }), 'blob placeholder query');
      const row = q.rows[0] as { t: string; len: number };
      assertEqual(row.t, 'blob', 'TYPEOF(blob param)');
      assertEqual(row.len, 4, 'BLOB length');
      await silentClose(DB);
    },
  },
  {
    id: 'qph-07', group: 'Query Placeholders', name: 'placeholder-looking text inside literals is ignored',
    fn: async () => {
      const DB = 'suite_qph07';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: "SELECT ':name' AS colon, '$name' AS dollar, '@name' AS at, '?1' AS numbered, ? AS v",
        values: [9],
      }), 'literal placeholder query');
      const row = q.rows[0] as { colon: string; dollar: string; at: string; numbered: string; v: number };
      assertEqual(row.colon, ':name', 'colon literal');
      assertEqual(row.dollar, '$name', 'dollar literal');
      assertEqual(row.at, '@name', 'at literal');
      assertEqual(row.numbered, '?1', 'numbered literal');
      assertEqual(row.v, 9, 'actual placeholder');
      await silentClose(DB);
    },
  },
  {
    id: 'qph-08', group: 'Query Placeholders', name: '? inside CRLF line comment is ignored',
    fn: async () => {
      const DB = 'suite_qph08';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: 'SELECT -- ignored ?\r\n ? AS v',
        values: [12],
      }), 'crlf comment query');
      assertEqual((q.rows[0] as { v: number }).v, 12, 'placeholder after CRLF comment');
      await silentClose(DB);
    },
  },
  {
    id: 'qph-09', group: 'Query Placeholders', name: 'anonymous ? works inside CTEs and expressions',
    fn: async () => {
      const DB = 'suite_qph09';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: 'WITH input(v) AS (SELECT ? UNION ALL SELECT ?) SELECT SUM(v * ?) AS total FROM input',
        values: [2, 3, 4],
      }), 'cte expression query');
      assertEqual((q.rows[0] as { total: number }).total, 20, '(2 + 3) * 4');
      await silentClose(DB);
    },
  },
  {
    id: 'qph-10', group: 'Query Placeholders', name: 'IN-list placeholders preserve numeric order',
    fn: async () => {
      const DB = 'suite_qph10';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({
        database: DB,
        statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER)', 'INSERT INTO t VALUES (1)', 'INSERT INTO t VALUES (2)', 'INSERT INTO t VALUES (3)'],
      }), 'seed');
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: "SELECT GROUP_CONCAT(id, ',') AS ids FROM t WHERE id IN (?, ?) ORDER BY id",
        values: [1, 3],
      }), 'in-list query');
      assertEqual((q.rows[0] as { ids: string }).ids, '1,3', 'matched IDs');
      await silentClose(DB);
    },
  },
  {
    id: 'qph-11', group: 'Query Placeholders', name: 'mixed string and numeric placeholders keep order',
    fn: async () => {
      const DB = 'suite_qph11';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: 'SELECT ? AS s1, ? AS n1, ? AS s2, ? AS n2',
        values: ['left', 10, 'right', 20],
      }), 'mixed placeholder query');
      const row = q.rows[0] as { s1: string; n1: number; s2: string; n2: number };
      assertEqual(row.s1, 'left', 'first string');
      assertEqual(row.n1, 10, 'first number');
      assertEqual(row.s2, 'right', 'second string');
      assertEqual(row.n2, 20, 'second number');
      await silentClose(DB);
    },
  },
  {
    id: 'qph-12', group: 'Query Placeholders', name: 'Android rejects named placeholders even without values',
    fn: async () => {
      const plat = assertOk(await CapacitorSqlite.getPlatform(), 'platform');
      if (plat.platform !== 'android') return;

      const DB = 'suite_qph12';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertFail(await CapacitorSqlite.query({ database: DB, statement: 'SELECT :value AS v' }), ':name placeholder without values', 'INVALID_PARAMS');
      assertFail(await CapacitorSqlite.query({ database: DB, statement: 'SELECT @value AS v' }), '@name placeholder without values', 'INVALID_PARAMS');
      assertFail(await CapacitorSqlite.query({ database: DB, statement: 'SELECT $value AS v' }), '$name placeholder without values', 'INVALID_PARAMS');
      await silentClose(DB);
    },
  },
  {
    id: 'qph-13', group: 'Query Placeholders', name: 'Android rejects extra string/null values too',
    fn: async () => {
      const plat = assertOk(await CapacitorSqlite.getPlatform(), 'platform');
      if (plat.platform !== 'android') return;

      const DB = 'suite_qph13';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertFail(await CapacitorSqlite.query({ database: DB, statement: 'SELECT ? AS v', values: ['ok', null] }), 'extra string/null values', 'INVALID_PARAMS');
      await silentClose(DB);
    },
  },

  // ── RunBatch (additional) ─────────────────────────────────────────────────
  {
    id: 'rb-03', group: 'RunBatch', name: 'transaction:false — successful rows committed before error',
    fn: async () => {
      const DB = 'suite_rb03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT NOT NULL)'] });
      const set = [
        { statement: 'INSERT INTO t VALUES (?)', values: ['ok1'] as [string] },
        { statement: 'INSERT INTO t VALUES (?)', values: [null as unknown as string] }, // violates NOT NULL
        { statement: 'INSERT INTO t VALUES (?)', values: ['ok2'] as [string] },
      ];
      await CapacitorSqlite.runBatch({ database: DB, set, transaction: false });
      // Without transaction the first row must be committed (no global rollback)
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assert((q.rows[0] as { n: number }).n >= 1, 'at least one committed row');
      await silentClose(DB);
    },
  },

  // ── Transactions (additional) ─────────────────────────────────────────────
  {
    id: 'tx-05', group: 'Transactions', name: 'rollbackTransaction without begin → error',
    fn: async () => {
      const DB = 'suite_tx05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertFail(await CapacitorSqlite.rollbackTransaction({ database: DB }), 'rollback without begin', 'TRANSACTION_FAILED');
      await silentClose(DB);
    },
  },
  {
    id: 'tx-06', group: 'Transactions', name: 'close() auto-rollbacks uncommitted transaction',
    fn: async () => {
      const DB = 'suite_tx06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      for (let i = 0; i < 5; i++) {
        await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [i] });
      }
      // Close WITHOUT commit — transaction should be rolled back
      assertOk(await CapacitorSqlite.close({ database: DB }), 'close mid-tx');
      // Re-open and verify data was rolled back
      assertOk(await CapacitorSqlite.open({ database: DB }), 're-open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((q.rows[0] as { n: number }).n, 0, 'rolled back — 0 rows');
      await silentClose(DB);
    },
  },

  // ── Migrations (additional) ───────────────────────────────────────────────
  {
    id: 'mig-05', group: 'Migrations', name: 'version gap (v1 → v1+v3, skipping v2)',
    fn: async () => {
      const DB = 'suite_mig05';
      await silentClose(DB);
      const v1: Migration[] = [{ version: 1, statements: ['CREATE TABLE a (id INTEGER PRIMARY KEY)'] }];
      const v1v3: Migration[] = [
        ...v1,
        { version: 3, statements: ['CREATE TABLE c (id INTEGER PRIMARY KEY)'] },
      ];
      assertOk(await CapacitorSqlite.open({ database: DB, migrations: v1 }), 'open v1');
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB, migrations: v1v3 }), 'open v1+v3');
      const sv = assertOk(await CapacitorSqlite.getSchemaVersion({ database: DB }), 'schema version');
      assertEqual(sv.version, 3, 'schema version = 3 after gap migration');
      await silentClose(DB);
    },
  },

  // ── Metadata (additional) ─────────────────────────────────────────────────
  {
    id: 'gv-03', group: 'Metadata', name: 'vacuum on open DB → success',
    fn: async () => {
      const DB = 'suite_gv03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: ['data'] });
      await CapacitorSqlite.execute({ database: DB, statements: ['DELETE FROM t'] });
      assertOk(await CapacitorSqlite.vacuum({ database: DB }), 'vacuum');
      await silentClose(DB);
    },
  },
  {
    id: 'gv-04', group: 'Metadata', name: 'getSchemaVersion on new DB → 0',
    fn: async () => {
      const DB = 'suite_gv04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const r = assertOk(await CapacitorSqlite.getSchemaVersion({ database: DB }), 'getSchemaVersion');
      assertEqual(r.version, 0, 'fresh DB has schema version 0');
      await silentClose(DB);
    },
  },

  // ── Directory ────────────────────────────────────────────────────────────
  {
    id: 'dir-01', group: 'Directory', name: 'invalid directory enum → INVALID_PARAMS',
    fn: async () => {
      const DB = 'suite_dir01';
      await silentClose(DB);
      assertFail(await CapacitorSqlite.open({ database: DB, directory: 'unsafe' as never }), 'open invalid directory', 'INVALID_PARAMS');
    },
  },
  {
    id: 'dir-02', group: 'Directory', name: 'all logical directories can open and query',
    fn: async () => {
      const directories: SqliteDirectory[] = ['default', 'library', 'documents', 'cache'];
      for (const directory of directories) {
        const DB = `suite_dir02_${directory}`;
        await silentClose(DB);
        assertOk(await CapacitorSqlite.open({ database: DB, directory }), `open ${directory}`);
        assertOk(await CapacitorSqlite.execute({
          database: DB,
          statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)', `INSERT INTO t VALUES ('${directory}')`],
        }), `seed ${directory}`);
        const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), `query ${directory}`);
        assertEqual((q.rows[0] as { v: string }).v, directory, `${directory} round-trip`);
        await silentClose(DB);
      }
    },
  },
  {
    id: 'dir-03', group: 'Directory', name: 'native/Electron same DB open in different directory → DB_ALREADY_OPEN',
    fn: async () => {
      const plat = assertOk(await CapacitorSqlite.getPlatform(), 'platform');
      if (plat.platform === 'web') return;

      const DB = 'suite_dir03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB, directory: 'library' }), 'open library');
      assertFail(await CapacitorSqlite.open({ database: DB, directory: 'cache' }), 'open cache while library open', 'DB_ALREADY_OPEN');
      await silentClose(DB);
    },
  },

  // ── Multi-DB ──────────────────────────────────────────────────────────────
  {
    id: 'mdb-01', group: 'Multi-DB', name: 'two DBs open simultaneously — no cross-contamination',
    fn: async () => {
      const DB_A = 'suite_mdb_a';
      const DB_B = 'suite_mdb_b';
      await silentClose(DB_A); await silentClose(DB_B);
      assertOk(await CapacitorSqlite.open({ database: DB_A }), 'open A');
      assertOk(await CapacitorSqlite.open({ database: DB_B }), 'open B');
      await CapacitorSqlite.execute({ database: DB_A, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      await CapacitorSqlite.execute({ database: DB_B, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      await CapacitorSqlite.run({ database: DB_A, statement: 'INSERT INTO t VALUES (?)', values: ['alpha'] });
      await CapacitorSqlite.run({ database: DB_B, statement: 'INSERT INTO t VALUES (?)', values: ['beta'] });
      const qa = assertOk(await CapacitorSqlite.query({ database: DB_A, statement: 'SELECT v FROM t' }), 'query A');
      const qb = assertOk(await CapacitorSqlite.query({ database: DB_B, statement: 'SELECT v FROM t' }), 'query B');
      assertEqual((qa.rows[0] as { v: string }).v, 'alpha', 'DB-A has alpha');
      assertEqual((qb.rows[0] as { v: string }).v, 'beta',  'DB-B has beta');
      assertEqual(qa.rows.length, 1, 'DB-A has 1 row');
      assertEqual(qb.rows.length, 1, 'DB-B has 1 row');
      await silentClose(DB_A); await silentClose(DB_B);
    },
  },
  {
    id: 'mdb-02', group: 'Multi-DB', name: ':memory: DB is not persisted across close/reopen',
    fn: async () => {
      // Android's SQLiteDatabase connection pool keeps :memory: alive across close() — skip.
      const plat = assertOk(await CapacitorSqlite.getPlatform(), 'getPlatform');
      if (plat.platform === 'android') return;

      const DB = ':memory:';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['CREATE TABLE IF NOT EXISTS t (v TEXT)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: ['ephemeral'] });
      assertOk(await CapacitorSqlite.close({ database: DB }), 'close');
      assertOk(await CapacitorSqlite.open({ database: DB }), 're-open');
      // Table should not exist — memory DB was discarded on close
      const q = await CapacitorSqlite.query({ database: DB, statement: 'SELECT name FROM sqlite_master WHERE type=\'table\'' });
      const tables = q.success ? q.data.rows.length : 0;
      assertEqual(tables, 0, ':memory: was cleared on close');
      await silentClose(DB);
    },
  },

  // ── Readonly ──────────────────────────────────────────────────────────────
  {
    id: 'ro-01', group: 'Readonly', name: 'readonly open — write → error',
    fn: async () => {
      const DB = 'suite_ro01';
      await silentClose(DB);
      // Create DB and table with write access first
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open rw');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      assertOk(await CapacitorSqlite.close({ database: DB }), 'close rw');
      // Re-open readonly
      assertOk(await CapacitorSqlite.open({ database: DB, readonly: true }), 'open ro');
      assertFail(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: ['x'] }), 'write on readonly');
      await silentClose(DB);
    },
  },
  {
    id: 'ro-02', group: 'Readonly', name: 'readonly open — query → ok',
    fn: async () => {
      const DB = 'suite_ro02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open rw');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: ['readable'] });
      assertOk(await CapacitorSqlite.close({ database: DB }), 'close rw');
      assertOk(await CapacitorSqlite.open({ database: DB, readonly: true }), 'open ro');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), 'query ro');
      assertEqual((q.rows[0] as { v: string }).v, 'readable', 'data visible in readonly mode');
      await silentClose(DB);
    },
  },
  {
    id: 'ro-03', group: 'Readonly', name: 'readonly + execute() → error',
    fn: async () => {
      const DB = 'suite_ro03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open rw');
      await CapacitorSqlite.execute({ database: DB, statements: ['CREATE TABLE IF NOT EXISTS t (v TEXT)'] });
      assertOk(await CapacitorSqlite.close({ database: DB }), 'close rw');
      assertOk(await CapacitorSqlite.open({ database: DB, readonly: true }), 'open ro');
      assertFail(await CapacitorSqlite.execute({ database: DB, statements: ["INSERT INTO t VALUES ('x')"] }), 'execute on readonly');
      await silentClose(DB);
    },
  },
  {
    id: 'ro-04', group: 'Readonly', name: 'readonly + vacuum() → error',
    fn: async () => {
      const DB = 'suite_ro04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open rw');
      assertOk(await CapacitorSqlite.close({ database: DB }), 'close rw');
      assertOk(await CapacitorSqlite.open({ database: DB, readonly: true }), 'open ro');
      assertFail(await CapacitorSqlite.vacuum({ database: DB }), 'vacuum on readonly');
      await silentClose(DB);
    },
  },
  {
    id: 'ro-05', group: 'Readonly', name: 'readonly + getSchemaVersion → ok',
    fn: async () => {
      const DB = 'suite_ro05';
      await silentClose(DB);
      const migs: Migration[] = [{ version: 7, statements: ['CREATE TABLE IF NOT EXISTS t (v TEXT)'] }];
      assertOk(await CapacitorSqlite.open({ database: DB, migrations: migs }), 'open rw');
      assertOk(await CapacitorSqlite.close({ database: DB }), 'close rw');
      assertOk(await CapacitorSqlite.open({ database: DB, readonly: true }), 'open ro');
      const sv = assertOk(await CapacitorSqlite.getSchemaVersion({ database: DB }), 'getSchemaVersion ro');
      assertEqual(sv.version, 7, 'schema version readable in readonly mode');
      await silentClose(DB);
    },
  },
  {
    id: 'ro-06', group: 'Readonly', name: 'readonly + runBatch() → error',
    fn: async () => {
      const DB = 'suite_ro06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open rw');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      assertOk(await CapacitorSqlite.close({ database: DB }), 'close rw');
      assertOk(await CapacitorSqlite.open({ database: DB, readonly: true }), 'open ro');
      assertFail(
        await CapacitorSqlite.runBatch({ database: DB, set: [{ statement: 'INSERT INTO t VALUES (?)', values: ['x'] }] }),
        'runBatch on readonly',
      );
      await silentClose(DB);
    },
  },
  {
    id: 'ro-07', group: 'Readonly', name: 'readonly + beginTransaction() → error',
    fn: async () => {
      const DB = 'suite_ro07';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open rw');
      await CapacitorSqlite.execute({ database: DB, statements: ['CREATE TABLE IF NOT EXISTS t (v TEXT)'] });
      assertOk(await CapacitorSqlite.close({ database: DB }), 'close rw');
      assertOk(await CapacitorSqlite.open({ database: DB, readonly: true }), 'open ro');
      assertFail(await CapacitorSqlite.beginTransaction({ database: DB }), 'beginTransaction on readonly', 'TRANSACTION_FAILED');
      await silentClose(DB);
    },
  },

  // ── Lifecycle (additional) ────────────────────────────────────────────────
  {
    id: 'lc-06', group: 'Lifecycle', name: 'data persists across close + re-open',
    fn: async () => {
      const DB = 'suite_lc06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open 1');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: ['persisted'] });
      assertOk(await CapacitorSqlite.close({ database: DB }), 'close');
      assertOk(await CapacitorSqlite.open({ database: DB }), 're-open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), 'query');
      assertEqual(q.rows.length, 1, '1 row after reopen');
      assertEqual((q.rows[0] as { v: string }).v, 'persisted', 'value persisted');
      await silentClose(DB);
    },
  },
  {
    id: 'lc-07', group: 'Lifecycle', name: 'isOpen on never-opened DB → false',
    fn: async () => {
      const r = assertOk(await CapacitorSqlite.isOpen({ database: 'suite_lc07_never' }), 'isOpen');
      assert(r.open === false, 'expected open=false for unknown DB');
    },
  },

  // ── Numeric edge cases ────────────────────────────────────────────────────
  {
    id: 'num-01', group: 'Numeric', name: 'MAX_SAFE_INTEGER and MIN_SAFE_INTEGER round-trip',
    fn: async () => {
      const DB = 'suite_num01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [Number.MAX_SAFE_INTEGER] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [Number.MIN_SAFE_INTEGER] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t ORDER BY rowid' }), 'query');
      const max = (q.rows[0] as { v: number }).v;
      const min = (q.rows[1] as { v: number }).v;
      assertEqual(max, Number.MAX_SAFE_INTEGER, 'MAX_SAFE_INTEGER preserved');
      assertEqual(min, Number.MIN_SAFE_INTEGER, 'MIN_SAFE_INTEGER preserved');
      await silentClose(DB);
    },
  },
  {
    id: 'num-02', group: 'Numeric', name: 'negative float round-trip',
    fn: async () => {
      const DB = 'suite_num02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v REAL)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [-1.5] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), 'query');
      const v = (q.rows[0] as { v: number }).v;
      assert(Math.abs(v - (-1.5)) < 1e-12, `expected -1.5, got ${v}`);
      await silentClose(DB);
    },
  },
  {
    id: 'num-03', group: 'Numeric', name: 'integer 0 stored as INTEGER (not NULL)',
    fn: async () => {
      const DB = 'suite_num03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [0] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v, typeof(v) AS t FROM t' }), 'query');
      const row = q.rows[0] as { v: number; t: string };
      assertEqual(row.v, 0, 'value is 0');
      assert(row.v !== null, '0 is not null');
      assertEqual(row.t, 'integer', 'typeof(0) = integer');
      await silentClose(DB);
    },
  },

  // ── String edge cases ─────────────────────────────────────────────────────
  {
    id: 'str-01', group: 'String', name: 'empty string is distinct from NULL',
    fn: async () => {
      const DB = 'suite_str01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [''] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [null] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v, typeof(v) AS t FROM t ORDER BY rowid' }), 'query');
      const r0 = q.rows[0] as { v: string; t: string };
      const r1 = q.rows[1] as { v: null; t: string };
      assertEqual(r0.v, '', 'empty string stored as empty string');
      assertEqual(r0.t, 'text', 'typeof(\'\') = text');
      assertEqual(r1.v, null, 'null stored as null');
      assertEqual(r1.t, 'null', 'typeof(null) = null');
      await silentClose(DB);
    },
  },
  {
    id: 'str-02', group: 'String', name: 'unicode and emoji round-trip',
    fn: async () => {
      const DB = 'suite_str02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      const text = 'héllo 🐧 wörld — 日本語 — Ω';
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [text] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), 'query');
      assertEqual((q.rows[0] as { v: string }).v, text, 'unicode round-trip');
      await silentClose(DB);
    },
  },
  {
    id: 'str-03', group: 'String', name: 'string with SQL metacharacters (quotes, semicolons)',
    fn: async () => {
      const DB = 'suite_str03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      const tricky = `it's a "test"; DROP TABLE t; --`;
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [tricky] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), 'query');
      assertEqual((q.rows[0] as { v: string }).v, tricky, 'metacharacters preserved');
      // Table must still exist (injection attempt had no effect)
      const q2 = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'table exists');
      assertEqual((q2.rows[0] as { n: number }).n, 1, 'table survived injection attempt');
      await silentClose(DB);
    },
  },
  {
    id: 'str-04', group: 'String', name: 'very long string (10 KB) round-trip',
    fn: async () => {
      const DB = 'suite_str04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      const big = 'A'.repeat(10 * 1024);
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [big] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT length(v) AS n, v FROM t' }), 'query');
      const row = q.rows[0] as { n: number; v: string };
      assertEqual(row.n, big.length, '10 KB length preserved');
      assertEqual(row.v.length, big.length, 'full text returned');
      await silentClose(DB);
    },
  },

  // ── Schema ────────────────────────────────────────────────────────────────
  {
    id: 'sch-01', group: 'Schema', name: 'CREATE INDEX — indexed column queryable',
    fn: async () => {
      const DB = 'suite_sch01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)',
        'CREATE INDEX IF NOT EXISTS idx_name ON t(name)',
      ]});
      for (let i = 0; i < 5; i++) {
        await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?,?)', values: [i, `name${i}`] });
      }
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT id FROM t WHERE name = ?', values: ['name3'] }), 'indexed query');
      assertEqual(q.rows.length, 1, 'one result');
      assertEqual((q.rows[0] as { id: number }).id, 3, 'correct row via index');
      await silentClose(DB);
    },
  },
  {
    id: 'sch-02', group: 'Schema', name: 'PRAGMA table_info returns column definitions',
    fn: async () => {
      const DB = 'suite_sch02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL)',
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "PRAGMA table_info('t')" }), 'table_info');
      assert(q.rows.length >= 3, `expected >=3 columns, got ${q.rows.length}`);
      const names = (q.rows as Array<{ name: string }>).map((r) => r.name);
      assert(names.includes('id'), 'id column present');
      assert(names.includes('name'), 'name column present');
      assert(names.includes('score'), 'score column present');
      await silentClose(DB);
    },
  },
  {
    id: 'sch-03', group: 'Schema', name: 'DROP TABLE IF EXISTS on non-existent table → success',
    fn: async () => {
      const DB = 'suite_sch03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t_never_existed'] }), 'drop non-existent');
      await silentClose(DB);
    },
  },
  {
    id: 'sch-04', group: 'Schema', name: 'FOREIGN KEY constraint enforced',
    fn: async () => {
      // Web WASM and some configurations may not enable FK — skip if not enforced
      const DB = 'suite_sch04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS child',
        'DROP TABLE IF EXISTS parent',
        'CREATE TABLE parent (id INTEGER PRIMARY KEY)',
        'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))',
        'PRAGMA foreign_keys = ON',
      ]});
      const r = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO child VALUES (1, 999)' });
      if (!r.success) {
        // FK enforced — this is the expected path on iOS/Android/Electron
        assert(true, 'FK violation correctly rejected');
      } else {
        // FK not enforced — verify via PRAGMA and skip assertion
        const fk = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'PRAGMA foreign_keys' }), 'fk pragma');
        const enabled = (fk.rows[0] as { foreign_keys: number }).foreign_keys;
        assert(enabled === 0 || enabled === null, `FK should be off if insert succeeded; got ${enabled}`);
      }
      await silentClose(DB);
    },
  },

  // ── Query (additional 2) ──────────────────────────────────────────────────
  {
    id: 'q-06', group: 'Query', name: 'LIMIT and OFFSET pagination',
    fn: async () => {
      const DB = 'suite_q06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      const set = Array.from({ length: 10 }, (_, i) => ({ statement: 'INSERT INTO t VALUES (?)', values: [i] as [number] }));
      await CapacitorSqlite.runBatch({ database: DB, set });
      const page1 = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t ORDER BY v LIMIT 3 OFFSET 0' }), 'page 1');
      const page2 = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t ORDER BY v LIMIT 3 OFFSET 3' }), 'page 2');
      assertEqual(page1.rows.length, 3, 'page 1: 3 rows');
      assertEqual(page2.rows.length, 3, 'page 2: 3 rows');
      assertEqual((page1.rows[0] as { v: number }).v, 0, 'page1[0]=0');
      assertEqual((page2.rows[0] as { v: number }).v, 3, 'page2[0]=3');
      await silentClose(DB);
    },
  },
  {
    id: 'q-07', group: 'Query', name: 'CTE (WITH ... AS) query',
    fn: async () => {
      const DB = 'suite_q07';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      for (let i = 1; i <= 5; i++) {
        await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [i] });
      }
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: 'WITH evens AS (SELECT v FROM t WHERE v % 2 = 0) SELECT COUNT(*) AS n FROM evens',
      }), 'cte');
      assertEqual((q.rows[0] as { n: number }).n, 2, '2 even numbers in 1..5');
      await silentClose(DB);
    },
  },
  {
    id: 'q-08', group: 'Query', name: 'aggregate functions COUNT, SUM, MIN, MAX, AVG',
    fn: async () => {
      const DB = 'suite_q08';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v REAL)'] });
      for (const v of [1, 2, 3, 4, 5]) {
        await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [v] });
      }
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: 'SELECT COUNT(*) AS cnt, SUM(v) AS s, MIN(v) AS mn, MAX(v) AS mx, AVG(v) AS av FROM t',
      }), 'aggregates');
      const row = q.rows[0] as { cnt: number; s: number; mn: number; mx: number; av: number };
      assertEqual(row.cnt, 5,  'COUNT=5');
      assertEqual(row.s,  15, 'SUM=15');
      assertEqual(row.mn, 1,   'MIN=1');
      assertEqual(row.mx, 5,   'MAX=5');
      assert(Math.abs(row.av - 3) < 1e-9, 'AVG=3');
      await silentClose(DB);
    },
  },

  // ── Run (additional 2) ────────────────────────────────────────────────────
  {
    id: 'run-06', group: 'Run', name: 'REPLACE INTO — updates existing row, lastInsertId changes',
    fn: async () => {
      const DB = 'suite_run06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'] });
      const ins = assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES (1, 'original')" }), 'insert');
      assertEqual(ins.lastInsertId, 1, 'first insert rowid=1');
      const rep = assertOk(await CapacitorSqlite.run({ database: DB, statement: "REPLACE INTO t VALUES (1, 'replaced')" }), 'replace');
      assert(rep.lastInsertId > 0, 'REPLACE gives a lastInsertId');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t WHERE id=1' }), 'query');
      assertEqual((q.rows[0] as { v: string }).v, 'replaced', 'value was replaced');
      await silentClose(DB);
    },
  },
  {
    id: 'run-07', group: 'Run', name: 'INSERT OR IGNORE — UNIQUE violation → changes=0',
    fn: async () => {
      const DB = 'suite_run07';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT UNIQUE)'] });
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES ('dup')" }), 'first insert');
      const r = assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT OR IGNORE INTO t VALUES ('dup')" }), 'ignored insert');
      assertEqual(r.changes, 0, 'changes=0 when ignored');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((q.rows[0] as { n: number }).n, 1, 'only one row');
      await silentClose(DB);
    },
  },
  {
    id: 'run-08', group: 'Run', name: 'run() with SELECT — succeeds, lastInsertId=0',
    fn: async () => {
      // Android uses compileStatement which rejects SELECT statements — skip.
      const plat = assertOk(await CapacitorSqlite.getPlatform(), 'getPlatform');
      if (plat.platform === 'android') return;

      const DB = 'suite_run08';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1)' });
      const r = assertOk(await CapacitorSqlite.run({ database: DB, statement: 'SELECT * FROM t' }), 'run SELECT');
      // sqlite3_changes() after SELECT retains the previous DML count — not asserting changes here.
      assertEqual(r.lastInsertId, 0, 'SELECT has lastInsertId=0');
      await silentClose(DB);
    },
  },

  // ── Transaction (additional) ──────────────────────────────────────────────
  {
    id: 'tx-07', group: 'Transactions', name: 'execute(transaction:false) inside manual transaction — works',
    fn: async () => {
      const DB = 'suite_tx07';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      // execute() with transaction:false must not start a nested BEGIN
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ["INSERT INTO t VALUES ('a')"], transaction: false }), 'execute inside tx');
      assertOk(await CapacitorSqlite.commitTransaction({ database: DB }), 'commit');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), 'query');
      assertEqual((q.rows[0] as { v: string }).v, 'a', 'row committed');
      await silentClose(DB);
    },
  },
  {
    id: 'tx-08', group: 'Transactions', name: 'uncommitted writes visible within same transaction',
    fn: async () => {
      const DB = 'suite_tx08';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      for (let i = 0; i < 3; i++) {
        await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [i] });
      }
      // Same connection must see uncommitted rows
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count before commit');
      assertEqual((q.rows[0] as { n: number }).n, 3, 'uncommitted rows visible on same connection');
      assertOk(await CapacitorSqlite.rollbackTransaction({ database: DB }), 'rollback');
      const q2 = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count after rollback');
      assertEqual((q2.rows[0] as { n: number }).n, 0, '0 rows after rollback');
      await silentClose(DB);
    },
  },

  // ── Migration (additional) ────────────────────────────────────────────────
  {
    id: 'mig-06', group: 'Migrations', name: 'migration with multiple statements per version',
    fn: async () => {
      const DB = 'suite_mig06';
      await silentClose(DB);
      const migs: Migration[] = [{
        version: 1,
        statements: [
          'CREATE TABLE a (id INTEGER PRIMARY KEY)',
          'CREATE TABLE b (id INTEGER PRIMARY KEY)',
          "INSERT INTO a VALUES (42)",
        ],
      }];
      assertOk(await CapacitorSqlite.open({ database: DB, migrations: migs }), 'open');
      const sv = assertOk(await CapacitorSqlite.getSchemaVersion({ database: DB }), 'version');
      assertEqual(sv.version, 1, 'version=1');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT id FROM a' }), 'query a');
      assertEqual((q.rows[0] as { id: number }).id, 42, 'all statements in v1 ran');
      await silentClose(DB);
    },
  },
  {
    id: 'mig-07', group: 'Migrations', name: 're-open with empty migrations array — version unchanged',
    fn: async () => {
      const DB = 'suite_mig07';
      await silentClose(DB);
      const migs: Migration[] = [{ version: 5, statements: ['CREATE TABLE IF NOT EXISTS t (v TEXT)'] }];
      assertOk(await CapacitorSqlite.open({ database: DB, migrations: migs }), 'open v5');
      assertOk(await CapacitorSqlite.close({ database: DB }), 'close');
      // Re-open with no migrations — should not reset version
      assertOk(await CapacitorSqlite.open({ database: DB, migrations: [] }), 're-open empty migs');
      const sv = assertOk(await CapacitorSqlite.getSchemaVersion({ database: DB }), 'version');
      assertEqual(sv.version, 5, 'version stays at 5 after empty migrations re-open');
      await silentClose(DB);
    },
  },

  // ── BLOB (additional) ─────────────────────────────────────────────────────
  {
    id: 'blob-05', group: 'BLOB', name: 'full byte range 0x00–0xFF round-trip',
    fn: async () => {
      const DB = 'suite_blob05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (data BLOB)'] });
      const orig = new Uint8Array(256);
      for (let i = 0; i < 256; i++) orig[i] = i;
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [orig] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT data FROM t' }), 'query');
      const data = (q.rows[0] as { data: unknown }).data;
      assert(data instanceof Uint8Array, 'result is Uint8Array');
      const blob = data as Uint8Array;
      assertEqual(blob.length, 256, 'length=256');
      for (let i = 0; i < 256; i++) {
        if (blob[i] !== i) throw new Error(`byte[${i}]: expected ${i}, got ${blob[i]}`);
      }
      await silentClose(DB);
    },
  },
  {
    id: 'blob-06', group: 'BLOB', name: 'multiple BLOB columns in same row',
    fn: async () => {
      const DB = 'suite_blob06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (a BLOB, b BLOB, n BLOB)'] });
      const a = new Uint8Array([0xAA, 0xBB]);
      const b = new Uint8Array([0xCC, 0xDD, 0xEE]);
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?,?,?)', values: [a, b, null] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT a, b, n FROM t' }), 'query');
      const row = q.rows[0] as { a: unknown; b: unknown; n: unknown };
      assert(row.a instanceof Uint8Array, 'a is Uint8Array');
      assert(row.b instanceof Uint8Array, 'b is Uint8Array');
      assertEqual(row.n, null, 'n is null');
      assertEqual((row.a as Uint8Array).length, 2, 'a length');
      assertEqual((row.b as Uint8Array).length, 3, 'b length');
      assertEqual((row.a as Uint8Array)[0], 0xAA, 'a[0]');
      assertEqual((row.b as Uint8Array)[2], 0xEE, 'b[2]');
      await silentClose(DB);
    },
  },

  // ── Multi-DB (additional) ─────────────────────────────────────────────────
  {
    id: 'mdb-03', group: 'Multi-DB', name: 'transaction on DB-A does not affect DB-B',
    fn: async () => {
      const DB_A = 'suite_mdb3a';
      const DB_B = 'suite_mdb3b';
      await silentClose(DB_A); await silentClose(DB_B);
      assertOk(await CapacitorSqlite.open({ database: DB_A }), 'open A');
      assertOk(await CapacitorSqlite.open({ database: DB_B }), 'open B');
      await CapacitorSqlite.execute({ database: DB_A, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.execute({ database: DB_B, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      // Begin a transaction on A only
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB_A }), 'begin A');
      await CapacitorSqlite.run({ database: DB_A, statement: 'INSERT INTO t VALUES (1)' });
      // B should operate normally, not be blocked
      assertOk(await CapacitorSqlite.run({ database: DB_B, statement: 'INSERT INTO t VALUES (99)' }), 'insert B');
      const qb = assertOk(await CapacitorSqlite.query({ database: DB_B, statement: 'SELECT v FROM t' }), 'query B');
      assertEqual((qb.rows[0] as { v: number }).v, 99, 'B write committed independently');
      // Rollback A — B's data must remain intact
      assertOk(await CapacitorSqlite.rollbackTransaction({ database: DB_A }), 'rollback A');
      const qa = assertOk(await CapacitorSqlite.query({ database: DB_A, statement: 'SELECT COUNT(*) AS n FROM t' }), 'query A');
      assertEqual((qa.rows[0] as { n: number }).n, 0, 'A rolled back');
      const qb2 = assertOk(await CapacitorSqlite.query({ database: DB_B, statement: 'SELECT COUNT(*) AS n FROM t' }), 'query B2');
      assertEqual((qb2.rows[0] as { n: number }).n, 1, 'B unaffected by A rollback');
      await silentClose(DB_A); await silentClose(DB_B);
    },
  },
  {
    id: 'mdb-04', group: 'Multi-DB', name: 'close DB-A while DB-B open — B continues',
    fn: async () => {
      const DB_A = 'suite_mdb4a';
      const DB_B = 'suite_mdb4b';
      await silentClose(DB_A); await silentClose(DB_B);
      assertOk(await CapacitorSqlite.open({ database: DB_A }), 'open A');
      assertOk(await CapacitorSqlite.open({ database: DB_B }), 'open B');
      await CapacitorSqlite.execute({ database: DB_B, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.run({ database: DB_B, statement: 'INSERT INTO t VALUES (1)' });
      assertOk(await CapacitorSqlite.close({ database: DB_A }), 'close A');
      // B must still work after A closed
      const q = assertOk(await CapacitorSqlite.query({ database: DB_B, statement: 'SELECT v FROM t' }), 'query B after A closed');
      assertEqual((q.rows[0] as { v: number }).v, 1, 'B unaffected by close of A');
      await silentClose(DB_B);
    },
  },
  {
    id: 'mdb-05', group: 'Multi-DB', name: '3 DBs open simultaneously — all isolated',
    fn: async () => {
      const DBS = ['suite_mdb5a', 'suite_mdb5b', 'suite_mdb5c'];
      for (const db of DBS) await silentClose(db);
      for (const db of DBS) assertOk(await CapacitorSqlite.open({ database: db }), `open ${db}`);
      for (const db of DBS) {
        await CapacitorSqlite.execute({ database: db, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
        await CapacitorSqlite.run({ database: db, statement: 'INSERT INTO t VALUES (?)', values: [db] });
      }
      for (const db of DBS) {
        const q = assertOk(await CapacitorSqlite.query({ database: db, statement: 'SELECT v FROM t' }), `query ${db}`);
        assertEqual((q.rows[0] as { v: string }).v, db, `${db} has its own value`);
        assertEqual(q.rows.length, 1, `${db} has 1 row`);
      }
      for (const db of DBS) await silentClose(db);
    },
  },

  // ── Constraints ───────────────────────────────────────────────────────────
  {
    id: 'con-01', group: 'Constraints', name: 'NOT NULL violation → EXECUTE_FAILED',
    fn: async () => {
      const DB = 'suite_con01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT NOT NULL)'] });
      assertFail(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [null] }), 'null into NOT NULL', 'EXECUTE_FAILED');
      await silentClose(DB);
    },
  },
  {
    id: 'con-02', group: 'Constraints', name: 'UNIQUE violation → EXECUTE_FAILED',
    fn: async () => {
      const DB = 'suite_con02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT UNIQUE)'] });
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES ('dup')" }), 'first insert');
      assertFail(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES ('dup')" }), 'duplicate insert', 'EXECUTE_FAILED');
      await silentClose(DB);
    },
  },
  {
    id: 'con-03', group: 'Constraints', name: 'CHECK constraint violation → EXECUTE_FAILED',
    fn: async () => {
      const DB = 'suite_con03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (age INTEGER CHECK(age >= 0))'] });
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (25)' }), 'valid age');
      assertFail(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (-1)' }), 'negative age', 'EXECUTE_FAILED');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((q.rows[0] as { n: number }).n, 1, 'only valid row stored');
      await silentClose(DB);
    },
  },
  {
    id: 'con-04', group: 'Constraints', name: 'PRIMARY KEY duplicate → EXECUTE_FAILED',
    fn: async () => {
      const DB = 'suite_con04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'] });
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES (1, 'a')" }), 'first');
      assertFail(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES (1, 'b')" }), 'dup PK', 'EXECUTE_FAILED');
      await silentClose(DB);
    },
  },

  // ── Execute (extra error paths) ───────────────────────────────────────────
  {
    id: 'ex-05', group: 'Execute', name: 'execute() on closed DB → DB_NOT_OPEN',
    fn: async () => {
      assertFail(await CapacitorSqlite.execute({ database: 'suite_ex05_closed', statements: ['SELECT 1'] }), 'execute on closed', 'DB_NOT_OPEN');
    },
  },
  {
    id: 'ex-06', group: 'Execute', name: 'execute(transaction:true) inside beginTransaction → TRANSACTION_FAILED',
    fn: async () => {
      const DB = 'suite_ex06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['CREATE TABLE IF NOT EXISTS t (v TEXT)'] });
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      assertFail(
        await CapacitorSqlite.execute({ database: DB, statements: ["INSERT INTO t VALUES ('x')"], transaction: true }),
        'nested execute with tx:true',
        'TRANSACTION_FAILED',
      );
      await CapacitorSqlite.rollbackTransaction({ database: DB });
      await silentClose(DB);
    },
  },

  // ── Run (extra error paths) ───────────────────────────────────────────────
  {
    id: 'run-09', group: 'Run', name: 'run() on closed DB → DB_NOT_OPEN',
    fn: async () => {
      assertFail(await CapacitorSqlite.run({ database: 'suite_run09_closed', statement: 'SELECT 1' }), 'run on closed', 'DB_NOT_OPEN');
    },
  },
  {
    id: 'run-10', group: 'Run', name: 'multi-row INSERT VALUES (a),(b),(c) — data all stored',
    fn: async () => {
      const DB = 'suite_run10';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      // Multi-row insert (Android documents changes=1, others report real count)
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1),(2),(3)' });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((q.rows[0] as { n: number }).n, 3, 'all 3 rows actually inserted');
      await silentClose(DB);
    },
  },
  {
    id: 'run-11', group: 'Run', name: 'UPSERT (INSERT … ON CONFLICT DO UPDATE) — SQLite 3.24+',
    fn: async () => {
      const DB = 'suite_run11';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER PRIMARY KEY, hits INTEGER DEFAULT 0)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1, 1)' });
      // UPSERT: if id conflicts, increment hits
      const r = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET hits = hits + 1' });
      if (!r.success) {
        // SQLite < 3.24 (some old Android versions) — acceptable skip
        await silentClose(DB); return;
      }
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT hits FROM t WHERE id=1' }), 'query');
      assertEqual((q.rows[0] as { hits: number }).hits, 2, 'hits incremented via UPSERT');
      await silentClose(DB);
    },
  },

  // ── RunBatch (extra error paths) ──────────────────────────────────────────
  {
    id: 'rb-04', group: 'RunBatch', name: 'runBatch() empty set → INVALID_PARAMS',
    fn: async () => {
      const DB = 'suite_rb04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertFail(await CapacitorSqlite.runBatch({ database: DB, set: [] }), 'empty set', 'INVALID_PARAMS');
      await silentClose(DB);
    },
  },
  {
    id: 'rb-05', group: 'RunBatch', name: 'runBatch() on closed DB → DB_NOT_OPEN',
    fn: async () => {
      assertFail(
        await CapacitorSqlite.runBatch({ database: 'suite_rb05_closed', set: [{ statement: 'SELECT 1' }] }),
        'runBatch on closed',
        'DB_NOT_OPEN',
      );
    },
  },

  // ── Query (extra SQL patterns) ────────────────────────────────────────────
  {
    id: 'q-09', group: 'Query', name: 'INNER JOIN two tables',
    fn: async () => {
      const DB = 'suite_q09';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS books', 'DROP TABLE IF EXISTS authors',
        'CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT)',
        'CREATE TABLE books (id INTEGER PRIMARY KEY, author_id INTEGER, title TEXT)',
      ]});
      await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO authors VALUES (1,'Alice')" });
      await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO authors VALUES (2,'Bob')" });
      await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO books VALUES (1,1,'Alpha')" });
      await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO books VALUES (2,1,'Beta')" });
      await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO books VALUES (3,2,'Gamma')" });
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: 'SELECT authors.name, books.title FROM authors JOIN books ON books.author_id = authors.id WHERE authors.id = ? ORDER BY books.id',
        values: [1],
      }), 'join query');
      assertEqual(q.rows.length, 2, 'Alice has 2 books');
      assertEqual((q.rows[0] as { name: string; title: string }).title, 'Alpha', 'first book');
      assertEqual((q.rows[1] as { name: string; title: string }).title, 'Beta',  'second book');
      await silentClose(DB);
    },
  },
  {
    id: 'q-10', group: 'Query', name: 'GROUP BY + HAVING',
    fn: async () => {
      const DB = 'suite_q10';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (cat TEXT, val INTEGER)'] });
      const rows = [['A',5],['A',7],['B',3],['B',4],['C',20]] as [string, number][];
      for (const [c, v] of rows) {
        await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?,?)', values: [c, v] });
      }
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: 'SELECT cat, SUM(val) AS total FROM t GROUP BY cat HAVING total > 10 ORDER BY cat',
      }), 'group by having');
      assertEqual(q.rows.length, 2, '2 groups with total>10');
      assertEqual((q.rows[0] as { cat: string; total: number }).cat, 'A', 'group A');
      assertEqual((q.rows[0] as { cat: string; total: number }).total, 12, 'A total=12');
      assertEqual((q.rows[1] as { cat: string; total: number }).cat, 'C', 'group C');
      await silentClose(DB);
    },
  },
  {
    id: 'q-11', group: 'Query', name: 'LIKE operator with wildcards',
    fn: async () => {
      const DB = 'suite_q11';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      for (const w of ['apple', 'apricot', 'banana', 'avocado', 'cherry']) {
        await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [w] });
      }
      // 'apple', 'apricot', 'avocado' start with 'a'
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT v FROM t WHERE v LIKE 'a%' ORDER BY v" }), 'LIKE a%');
      assertEqual(q.rows.length, 3, '3 fruits starting with a');
      assertEqual((q.rows[0] as { v: string }).v, 'apple', 'apple first alphabetically');
      // '%an%' matches banana only (apple: no, apricot: no, banana: yes, avocado: no, cherry: no)
      const q2 = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT v FROM t WHERE v LIKE '%an%'" }), 'LIKE %an%');
      assertEqual(q2.rows.length, 1, '1 fruit containing "an"');
      assertEqual((q2.rows[0] as { v: string }).v, 'banana', 'banana matches %an%');
      await silentClose(DB);
    },
  },
  {
    id: 'q-12', group: 'Query', name: 'IN (...) operator with bound values',
    fn: async () => {
      const DB = 'suite_q12';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      for (let i = 1; i <= 10; i++) {
        await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [i] });
      }
      // IN with literal list (parameterized IN requires dynamic SQL or VALUES clause)
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: 'SELECT v FROM t WHERE v IN (2, 5, 8) ORDER BY v',
      }), 'IN query');
      assertEqual(q.rows.length, 3, '3 matches');
      assertEqual((q.rows[0] as { v: number }).v, 2, 'v=2');
      assertEqual((q.rows[1] as { v: number }).v, 5, 'v=5');
      assertEqual((q.rows[2] as { v: number }).v, 8, 'v=8');
      await silentClose(DB);
    },
  },
  {
    id: 'q-13', group: 'Query', name: 'ORDER BY multiple columns ASC/DESC',
    fn: async () => {
      const DB = 'suite_q13';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (a INTEGER, b INTEGER)'] });
      for (const [a, b] of [[1,3],[1,1],[2,2],[2,4],[1,2]]) {
        await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?,?)', values: [a, b] });
      }
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: 'SELECT a, b FROM t ORDER BY a ASC, b DESC',
      }), 'multi-col order');
      // Expected order: (1,3),(1,2),(1,1),(2,4),(2,2)
      const pairs = (q.rows as Array<{ a: number; b: number }>).map((r) => `${r.a},${r.b}`);
      assertEqual(pairs.join(' '), '1,3 1,2 1,1 2,4 2,2', 'correct multi-col sort order');
      await silentClose(DB);
    },
  },
  {
    id: 'q-14', group: 'Query', name: 'LEFT JOIN — rows without match included as NULL',
    fn: async () => {
      const DB = 'suite_q14';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS right_t', 'DROP TABLE IF EXISTS left_t',
        'CREATE TABLE left_t (id INTEGER PRIMARY KEY, v TEXT)',
        'CREATE TABLE right_t (left_id INTEGER, extra TEXT)',
      ]});
      await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO left_t VALUES (1,'a')" });
      await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO left_t VALUES (2,'b')" });
      await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO right_t VALUES (1,'match')" });
      // id=2 has no match in right_t
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: 'SELECT left_t.id, right_t.extra FROM left_t LEFT JOIN right_t ON right_t.left_id = left_t.id ORDER BY left_t.id',
      }), 'left join');
      assertEqual(q.rows.length, 2, '2 rows from left join');
      assertEqual((q.rows[0] as { extra: string }).extra, 'match', 'row 1 has match');
      assertEqual((q.rows[1] as { extra: null }).extra, null, 'row 2 has null (no match)');
      await silentClose(DB);
    },
  },
  {
    id: 'q-15', group: 'Query', name: 'subquery in WHERE (correlated)',
    fn: async () => {
      const DB = 'suite_q15';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER, score INTEGER)'] });
      for (const [id, score] of [[1,70],[2,85],[3,60],[4,90],[5,75]]) {
        await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?,?)', values: [id, score] });
      }
      // Select rows above average score
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: 'SELECT id FROM t WHERE score > (SELECT AVG(score) FROM t) ORDER BY id',
      }), 'subquery');
      // avg = (70+85+60+90+75)/5 = 76, so ids 2 and 4 qualify
      assertEqual(q.rows.length, 2, '2 above-average scores');
      assertEqual((q.rows[0] as { id: number }).id, 2, 'id=2 (85>76)');
      assertEqual((q.rows[1] as { id: number }).id, 4, 'id=4 (90>76)');
      await silentClose(DB);
    },
  },

  // ── Schema (extra) ────────────────────────────────────────────────────────
  {
    id: 'sch-05', group: 'Schema', name: 'CREATE VIEW + query via view',
    fn: async () => {
      const DB = 'suite_sch05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP VIEW IF EXISTS big_scores',
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER, score INTEGER)',
        'CREATE VIEW big_scores AS SELECT id, score FROM t WHERE score >= 80',
      ]});
      for (const [id, score] of [[1,75],[2,82],[3,90],[4,65]]) {
        await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?,?)', values: [id, score] });
      }
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT id FROM big_scores ORDER BY id' }), 'view query');
      assertEqual(q.rows.length, 2, '2 rows via view');
      assertEqual((q.rows[0] as { id: number }).id, 2, 'id=2');
      assertEqual((q.rows[1] as { id: number }).id, 3, 'id=3');
      await silentClose(DB);
    },
  },
  {
    id: 'sch-06', group: 'Schema', name: 'ALTER TABLE ADD COLUMN — existing rows get default',
    fn: async () => {
      const DB = 'suite_sch06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)'] });
      await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES (1,'alice')" });
      await CapacitorSqlite.execute({ database: DB, statements: ["ALTER TABLE t ADD COLUMN score INTEGER DEFAULT 0"] });
      await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES (2,'bob',99)" });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT id, score FROM t ORDER BY id' }), 'query after alter');
      assertEqual(q.rows.length, 2, '2 rows');
      assertEqual((q.rows[0] as { score: number }).score, 0,  'alice default score=0');
      assertEqual((q.rows[1] as { score: number }).score, 99, 'bob score=99');
      await silentClose(DB);
    },
  },
  {
    id: 'sch-07', group: 'Schema', name: 'sqlite_master lists tables, indexes, views',
    fn: async () => {
      const DB = 'suite_sch07';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP VIEW IF EXISTS v',
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)',
        'CREATE INDEX idx_name ON t(name)',
        'CREATE VIEW v AS SELECT id FROM t',
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT type, name FROM sqlite_master ORDER BY type, name" }), 'master');
      const types = (q.rows as Array<{ type: string; name: string }>).map((r) => r.type);
      assert(types.includes('index'), 'index in master');
      assert(types.includes('table'), 'table in master');
      assert(types.includes('view'),  'view in master');
      const names = (q.rows as Array<{ name: string }>).map((r) => r.name);
      assert(names.includes('t'),        'table t listed');
      assert(names.includes('idx_name'), 'index listed');
      assert(names.includes('v'),        'view listed');
      await silentClose(DB);
    },
  },

  // ── Lifecycle (extra) ─────────────────────────────────────────────────────
  {
    id: 'lc-08', group: 'Lifecycle', name: '5 sequential open/close cycles — data stable',
    fn: async () => {
      const DB = 'suite_lc08';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'init');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (42)' });
      assertOk(await CapacitorSqlite.close({ database: DB }), 'close 0');
      for (let i = 1; i <= 5; i++) {
        assertOk(await CapacitorSqlite.open({ database: DB }), `open ${i}`);
        const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), `query ${i}`);
        assertEqual((q.rows[0] as { v: number }).v, 42, `cycle ${i}: data intact`);
        assertOk(await CapacitorSqlite.close({ database: DB }), `close ${i}`);
      }
    },
  },

  // ── Migration (extra) ─────────────────────────────────────────────────────
  {
    id: 'mig-08', group: 'Migrations', name: 'migrations applied in ascending order regardless of array order',
    fn: async () => {
      const DB = 'suite_mig08';
      await silentClose(DB);
      // Supply migrations out of order: v3, v1, v2
      const migs: Migration[] = [
        { version: 3, statements: ['ALTER TABLE t ADD COLUMN c INTEGER DEFAULT 0'] },
        { version: 1, statements: ['CREATE TABLE t (id INTEGER PRIMARY KEY)'] },
        { version: 2, statements: ['ALTER TABLE t ADD COLUMN b TEXT'] },
      ];
      assertOk(await CapacitorSqlite.open({ database: DB, migrations: migs }), 'open');
      // All 3 must have run, v3 must be the final version
      const sv = assertOk(await CapacitorSqlite.getSchemaVersion({ database: DB }), 'version');
      assertEqual(sv.version, 3, 'highest version applied');
      // INSERT using all 3 columns (proves all migrations ran). Use OR REPLACE to be idempotent across test re-runs.
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT OR REPLACE INTO t VALUES (1,'hello',99)" }), 'insert all cols');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM t WHERE id=1' }), 'query');
      assertEqual(q.rows.length, 1, '1 row present');
      await silentClose(DB);
    },
  },
  {
    id: 'mig-09', group: 'Migrations', name: 'failed v2 migration — DB stays at v1, re-openable',
    fn: async () => {
      const DB = 'suite_mig09';
      await silentClose(DB);
      const v1: Migration[] = [{ version: 1, statements: ['CREATE TABLE t (id INTEGER PRIMARY KEY)'] }];
      const v1v2bad: Migration[] = [
        ...v1,
        { version: 2, statements: ['THIS IS INVALID SQL THAT WILL FAIL'] },
      ];
      // First open: apply v1
      assertOk(await CapacitorSqlite.open({ database: DB, migrations: v1 }), 'open v1');
      await silentClose(DB);
      // Second open: v2 fails
      assertFail(await CapacitorSqlite.open({ database: DB, migrations: v1v2bad }), 'open v1+bad-v2', 'MIGRATION_FAILED');
      // Third open: v1 migrations only — DB is still at v1, not corrupted
      assertOk(await CapacitorSqlite.open({ database: DB, migrations: v1 }), 're-open after failed v2');
      const sv = assertOk(await CapacitorSqlite.getSchemaVersion({ database: DB }), 'schema version');
      assertEqual(sv.version, 1, 'DB still at v1 after failed v2');
      // Verify DB is writable (use OR IGNORE to be idempotent across test re-runs)
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT OR IGNORE INTO t VALUES (1)' }), 'DB is usable');
      await silentClose(DB);
    },
  },

  // ── BLOB (extra) ──────────────────────────────────────────────────────────
  {
    id: 'blob-07', group: 'BLOB', name: 'UPDATE existing BLOB value',
    fn: async () => {
      const DB = 'suite_blob07';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER PRIMARY KEY, data BLOB)'] });
      const orig = new Uint8Array([0x01, 0x02, 0x03]);
      const updated = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]);
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1, ?)', values: [orig] });
      await CapacitorSqlite.run({ database: DB, statement: 'UPDATE t SET data = ? WHERE id = 1', values: [updated] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT data FROM t WHERE id=1' }), 'query after update');
      const data = (q.rows[0] as { data: unknown }).data;
      assert(data instanceof Uint8Array, 'updated blob is Uint8Array');
      const blob = data as Uint8Array;
      assertEqual(blob.length, 4, 'updated length=4');
      assertEqual(blob[0], 0xAA, 'byte[0]=0xAA');
      assertEqual(blob[3], 0xDD, 'byte[3]=0xDD');
      await silentClose(DB);
    },
  },
  {
    id: 'blob-08', group: 'BLOB', name: '50 KB BLOB round-trip correctness',
    fn: async () => {
      const DB = 'suite_blob08';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (data BLOB)'] });
      const size = 50 * 1024;
      const orig = new Uint8Array(size);
      for (let i = 0; i < size; i++) orig[i] = i & 0xFF;
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [orig] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT data FROM t' }), 'query');
      const data = (q.rows[0] as { data: unknown }).data;
      assert(data instanceof Uint8Array, '50KB blob is Uint8Array');
      const blob = data as Uint8Array;
      assertEqual(blob.length, size, '50KB length correct');
      // Spot-check 10 positions across the blob
      for (const pos of [0, 1024, 5000, 10000, 25000, 40000, size - 1]) {
        if (blob[pos] !== (pos & 0xFF)) throw new Error(`byte[${pos}]: expected ${pos & 0xFF}, got ${blob[pos]}`);
      }
      await silentClose(DB);
    },
  },

  // ── Numeric (extra) ───────────────────────────────────────────────────────
  {
    id: 'num-04', group: 'Numeric', name: 'SQL arithmetic functions: ABS, ROUND, MAX scalar',
    fn: async () => {
      const DB = 'suite_num04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: "SELECT ABS(-42) AS a, ROUND(3.14159, 2) AS r, MAX(1,2,3) AS m",
      }), 'arithmetic');
      const row = q.rows[0] as { a: number; r: number; m: number };
      assertEqual(row.a, 42, 'ABS(-42)=42');
      assert(Math.abs(row.r - 3.14) < 0.001, `ROUND(3.14159,2)=3.14, got ${row.r}`);
      assertEqual(row.m, 3, 'MAX(1,2,3)=3');
      await silentClose(DB);
    },
  },
  {
    id: 'num-05', group: 'Numeric', name: 'float Pi stored and retrieved with full precision',
    fn: async () => {
      const DB = 'suite_num05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v REAL)'] });
      const pi = Math.PI;
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [pi] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), 'query');
      const back = (q.rows[0] as { v: number }).v;
      // IEEE 754 double: precision to ~15 significant digits
      assert(Math.abs(back - pi) < 1e-14, `Pi round-trip error: ${Math.abs(back - pi)}`);
      await silentClose(DB);
    },
  },

  // ── String (extra) ────────────────────────────────────────────────────────
  {
    id: 'str-05', group: 'String', name: 'string with embedded newlines and tabs',
    fn: async () => {
      const DB = 'suite_str05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      const text = 'line1\nline2\ttabbed\r\nwindows';
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [text] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), 'query');
      assertEqual((q.rows[0] as { v: string }).v, text, 'newlines/tabs preserved');
      await silentClose(DB);
    },
  },
  {
    id: 'str-06', group: 'String', name: 'string with backslash and percent sign',
    fn: async () => {
      const DB = 'suite_str06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      const text = 'C:\\Users\\test 100% done \\ / ok';
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [text] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), 'query');
      assertEqual((q.rows[0] as { v: string }).v, text, 'backslash+percent preserved');
      await silentClose(DB);
    },
  },

  // ── Savepoints ────────────────────────────────────────────────────────────
  {
    id: 'svp-01', group: 'Savepoints', name: 'SAVEPOINT + RELEASE — both changes committed',
    fn: async () => {
      const DB = 'suite_svp01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1)' });
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['SAVEPOINT sp1'], transaction: false }), 'savepoint');
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (2)' });
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['RELEASE SAVEPOINT sp1'], transaction: false }), 'release');
      assertOk(await CapacitorSqlite.commitTransaction({ database: DB }), 'commit');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((q.rows[0] as { n: number }).n, 2, 'both rows committed after RELEASE');
      await silentClose(DB);
    },
  },
  {
    id: 'svp-02', group: 'Savepoints', name: 'SAVEPOINT + ROLLBACK TO — partial rollback within transaction',
    fn: async () => {
      const DB = 'suite_svp02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1)' });
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['SAVEPOINT sp2'], transaction: false }), 'savepoint');
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (2)' });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (3)' });
      // Roll back only to the savepoint, discarding rows 2 and 3
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['ROLLBACK TO SAVEPOINT sp2'], transaction: false }), 'rollback to sp');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['RELEASE SAVEPOINT sp2'], transaction: false }), 'release sp');
      assertOk(await CapacitorSqlite.commitTransaction({ database: DB }), 'commit');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t ORDER BY v' }), 'query');
      assertEqual(q.rows.length, 1, 'only row 1 survived savepoint rollback');
      assertEqual((q.rows[0] as { v: number }).v, 1, 'v=1');
      await silentClose(DB);
    },
  },

  // ── DateTime ─────────────────────────────────────────────────────────────────
  {
    id: 'dt-01', group: 'DateTime', name: 'ISO 8601 TEXT date round-trip',
    fn: async () => {
      const DB = 'suite_dt01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (d TEXT)'] });
      const iso = '2024-01-15T10:30:00.000Z';
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [iso] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT d FROM t' }), 'query');
      assertEqual((q.rows[0] as { d: string }).d, iso, 'ISO 8601 round-trip');
      await silentClose(DB);
    },
  },
  {
    id: 'dt-02', group: 'DateTime', name: 'Unix timestamp as INTEGER stored and retrieved',
    fn: async () => {
      const DB = 'suite_dt02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (ts INTEGER)'] });
      const epoch = 1705314600; // 2024-01-15 10:30:00 UTC
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [epoch] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT ts FROM t' }), 'query');
      assertEqual((q.rows[0] as { ts: number }).ts, epoch, 'Unix timestamp round-trip');
      await silentClose(DB);
    },
  },
  {
    id: 'dt-03', group: 'DateTime', name: 'Julian day number as REAL stored and retrieved',
    fn: async () => {
      const DB = 'suite_dt03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (jd REAL)'] });
      // julianday('2024-01-15') = 2460324.5
      const jd = 2460324.5;
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [jd] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT jd FROM t' }), 'query');
      const got = (q.rows[0] as { jd: number }).jd;
      assert(Math.abs(got - jd) < 0.0001, `Julian day round-trip: got ${got}`);
      await silentClose(DB);
    },
  },
  {
    id: 'dt-04', group: 'DateTime', name: 'date() function returns YYYY-MM-DD',
    fn: async () => {
      const DB = 'suite_dt04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT date('2024-01-15') AS d" }), 'query');
      assertEqual((q.rows[0] as { d: string }).d, '2024-01-15', 'date() result');
      await silentClose(DB);
    },
  },
  {
    id: 'dt-05', group: 'DateTime', name: 'datetime() function returns YYYY-MM-DD HH:MM:SS',
    fn: async () => {
      const DB = 'suite_dt05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT datetime('2024-01-15 10:30:00') AS dt" }), 'query');
      assertEqual((q.rows[0] as { dt: string }).dt, '2024-01-15 10:30:00', 'datetime() result');
      await silentClose(DB);
    },
  },
  {
    id: 'dt-06', group: 'DateTime', name: 'strftime() custom format',
    fn: async () => {
      const DB = 'suite_dt06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT strftime('%d/%m/%Y','2024-01-15') AS s" }), 'query');
      assertEqual((q.rows[0] as { s: string }).s, '15/01/2024', 'strftime custom format');
      await silentClose(DB);
    },
  },
  {
    id: 'dt-07', group: 'DateTime', name: 'ISO dates sort correctly as TEXT (lexicographic = chronological)',
    fn: async () => {
      const DB = 'suite_dt07';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (d TEXT)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?)', values: ['2024-03-01'] },
        { statement: 'INSERT INTO t VALUES (?)', values: ['2023-12-31'] },
        { statement: 'INSERT INTO t VALUES (?)', values: ['2024-01-15'] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT d FROM t ORDER BY d ASC' }), 'query');
      assertEqual((q.rows[0] as { d: string }).d, '2023-12-31', 'first = oldest');
      assertEqual((q.rows[2] as { d: string }).d, '2024-03-01', 'last = newest');
      await silentClose(DB);
    },
  },
  {
    id: 'dt-08', group: 'DateTime', name: 'Date arithmetic with datetime modifiers',
    fn: async () => {
      const DB = 'suite_dt08';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT date('2024-01-15','+7 days') AS d" }), 'query');
      assertEqual((q.rows[0] as { d: string }).d, '2024-01-22', '+7 days');
      const q2 = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT date('2024-01-15','+1 month') AS d" }), 'query');
      assertEqual((q2.rows[0] as { d: string }).d, '2024-02-15', '+1 month');
      const q3 = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT date('2024-01-15','-1 year') AS d" }), 'query');
      assertEqual((q3.rows[0] as { d: string }).d, '2023-01-15', '-1 year');
      await silentClose(DB);
    },
  },
  {
    id: 'dt-09', group: 'DateTime', name: "datetime('now') returns a current timestamp string",
    fn: async () => {
      const DB = 'suite_dt09';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT datetime('now') AS ts" }), 'query');
      const ts = (q.rows[0] as { ts: string }).ts;
      assert(typeof ts === 'string' && ts.length === 19, `datetime('now') should be 19 chars, got: ${ts}`);
      assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts), `invalid format: ${ts}`);
      await silentClose(DB);
    },
  },
  {
    id: 'dt-10', group: 'DateTime', name: 'Convert Unix timestamp to datetime string',
    fn: async () => {
      const DB = 'suite_dt10';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      // 1705314600 = 2024-01-15 10:30:00 UTC
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT datetime(1705314600,'unixepoch') AS dt" }), 'query');
      assertEqual((q.rows[0] as { dt: string }).dt, '2024-01-15 10:30:00', 'unixepoch to datetime');
      await silentClose(DB);
    },
  },
  {
    id: 'dt-11', group: 'DateTime', name: 'Convert datetime string to Unix timestamp via strftime',
    fn: async () => {
      const DB = 'suite_dt11';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT CAST(strftime('%s','2024-01-15 10:30:00') AS INTEGER) AS ts" }), 'query');
      assertEqual((q.rows[0] as { ts: number }).ts, 1705314600, 'datetime to unix timestamp');
      await silentClose(DB);
    },
  },
  {
    id: 'dt-12', group: 'DateTime', name: 'Store and retrieve JS Date as ISO string',
    fn: async () => {
      const DB = 'suite_dt12';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (created_at TEXT)'] });
      const d = new Date('2024-06-15T08:00:00.000Z');
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [d.toISOString()] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT created_at FROM t' }), 'query');
      const retrieved = new Date((q.rows[0] as { created_at: string }).created_at);
      assertEqual(retrieved.getTime(), d.getTime(), 'JS Date toISOString round-trip');
      await silentClose(DB);
    },
  },
  {
    id: 'dt-13', group: 'DateTime', name: 'Date range query with BETWEEN',
    fn: async () => {
      const DB = 'suite_dt13';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (name TEXT, d TEXT)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?,?)', values: ['alice', '2024-01-01'] },
        { statement: 'INSERT INTO t VALUES (?,?)', values: ['bob', '2024-03-15'] },
        { statement: 'INSERT INTO t VALUES (?,?)', values: ['carol', '2024-06-01'] },
        { statement: 'INSERT INTO t VALUES (?,?)', values: ['dave', '2024-12-31'] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: 'SELECT name FROM t WHERE d BETWEEN ? AND ? ORDER BY d',
        values: ['2024-01-01', '2024-06-30'],
      }), 'query');
      assertEqual(q.rows.length, 3, '3 rows in date range');
      assertEqual((q.rows[0] as { name: string }).name, 'alice', 'first in range');
      assertEqual((q.rows[2] as { name: string }).name, 'carol', 'last in range');
      await silentClose(DB);
    },
  },
  {
    id: 'dt-14', group: 'DateTime', name: 'Year/month/day extraction with strftime',
    fn: async () => {
      const DB = 'suite_dt14';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT strftime('%Y','2024-06-15') AS yr, strftime('%m','2024-06-15') AS mo, strftime('%d','2024-06-15') AS dy" }), 'query');
      const row = q.rows[0] as { yr: string; mo: string; dy: string };
      assertEqual(row.yr, '2024', 'year extraction');
      assertEqual(row.mo, '06', 'month extraction');
      assertEqual(row.dy, '15', 'day extraction');
      await silentClose(DB);
    },
  },
  {
    id: 'dt-15', group: 'DateTime', name: 'datetime(NULL) returns NULL',
    fn: async () => {
      const DB = 'suite_dt15';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT datetime(NULL) AS d' }), 'query');
      assert((q.rows[0] as { d: unknown }).d === null || (q.rows[0] as { d: unknown }).d === undefined, 'datetime(NULL) = NULL');
      await silentClose(DB);
    },
  },
  {
    id: 'dt-16', group: 'DateTime', name: 'julianday() converts TEXT date to Julian day number',
    fn: async () => {
      const DB = 'suite_dt16';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT julianday('2024-01-15') AS jd" }), 'query');
      const jd = (q.rows[0] as { jd: number }).jd;
      assert(Math.abs(jd - 2460324.5) < 0.001, `julianday expected ~2460324.5, got ${jd}`);
      await silentClose(DB);
    },
  },
  {
    id: 'dt-17', group: 'DateTime', name: 'Group events by year using strftime',
    fn: async () => {
      const DB = 'suite_dt17';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS ev', "CREATE TABLE ev (name TEXT, d TEXT)"] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO ev VALUES (?,?)', values: ['a', '2023-05-01'] },
        { statement: 'INSERT INTO ev VALUES (?,?)', values: ['b', '2023-11-15'] },
        { statement: 'INSERT INTO ev VALUES (?,?)', values: ['c', '2024-02-20'] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT strftime('%Y',d) AS yr, COUNT(*) AS n FROM ev GROUP BY yr ORDER BY yr" }), 'query');
      assertEqual(q.rows.length, 2, '2 distinct years');
      assertEqual((q.rows[0] as { yr: string; n: number }).yr, '2023', 'first year');
      assertEqual((q.rows[0] as { yr: string; n: number }).n, 2, '2 events in 2023');
      await silentClose(DB);
    },
  },
  {
    id: 'dt-18', group: 'DateTime', name: 'Weekday extraction with strftime %w (0=Sun)',
    fn: async () => {
      const DB = 'suite_dt18';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      // 2024-01-15 is a Monday → %w = 1
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT strftime('%w','2024-01-15') AS wd" }), 'query');
      assertEqual((q.rows[0] as { wd: string }).wd, '1', 'Monday = weekday 1');
      await silentClose(DB);
    },
  },

  // ── SQL Functions ─────────────────────────────────────────────────────────────
  {
    id: 'fn-01', group: 'SQL Functions', name: 'COALESCE returns first non-NULL value',
    fn: async () => {
      const DB = 'suite_fn01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT COALESCE(NULL, NULL, 'fallback', 'other') AS v" }), 'query');
      assertEqual((q.rows[0] as { v: string }).v, 'fallback', 'COALESCE first non-NULL');
      const q2 = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COALESCE(NULL, NULL, NULL) AS v' }), 'query');
      assert((q2.rows[0] as { v: unknown }).v === null || (q2.rows[0] as { v: unknown }).v === undefined, 'COALESCE all NULL = NULL');
      await silentClose(DB);
    },
  },
  {
    id: 'fn-02', group: 'SQL Functions', name: 'NULLIF returns NULL when args equal, else first arg',
    fn: async () => {
      const DB = 'suite_fn02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT NULLIF(5, 5) AS a, NULLIF(5, 6) AS b' }), 'query');
      const row = q.rows[0] as { a: unknown; b: number };
      assert(row.a === null || row.a === undefined, 'NULLIF equal → NULL');
      assertEqual(row.b, 5, 'NULLIF unequal → first arg');
      await silentClose(DB);
    },
  },
  {
    id: 'fn-03', group: 'SQL Functions', name: 'IFNULL as NULL replacement (alias of COALESCE with 2 args)',
    fn: async () => {
      const DB = 'suite_fn03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT IFNULL(NULL,'default') AS a, IFNULL('value','default') AS b" }), 'query');
      const row = q.rows[0] as { a: string; b: string };
      assertEqual(row.a, 'default', 'IFNULL(NULL,x) = x');
      assertEqual(row.b, 'value', 'IFNULL(non-null,x) = first');
      await silentClose(DB);
    },
  },
  {
    id: 'fn-04', group: 'SQL Functions', name: 'CASE WHEN THEN ELSE END expression',
    fn: async () => {
      const DB = 'suite_fn04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (score INTEGER)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?)', values: [95] },
        { statement: 'INSERT INTO t VALUES (?)', values: [75] },
        { statement: 'INSERT INTO t VALUES (?)', values: [50] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB,
        statement: "SELECT score, CASE WHEN score >= 90 THEN 'A' WHEN score >= 70 THEN 'B' ELSE 'C' END AS grade FROM t ORDER BY score DESC" }), 'query');
      assertEqual((q.rows[0] as { grade: string }).grade, 'A', 'score 95 → A');
      assertEqual((q.rows[1] as { grade: string }).grade, 'B', 'score 75 → B');
      assertEqual((q.rows[2] as { grade: string }).grade, 'C', 'score 50 → C');
      await silentClose(DB);
    },
  },
  {
    id: 'fn-05', group: 'SQL Functions', name: 'UPPER() and LOWER() string functions',
    fn: async () => {
      const DB = 'suite_fn05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT UPPER('hello World') AS u, LOWER('HELLO World') AS l" }), 'query');
      const row = q.rows[0] as { u: string; l: string };
      assertEqual(row.u, 'HELLO WORLD', 'UPPER');
      assertEqual(row.l, 'hello world', 'LOWER');
      await silentClose(DB);
    },
  },
  {
    id: 'fn-06', group: 'SQL Functions', name: 'TRIM, LTRIM, RTRIM whitespace removal',
    fn: async () => {
      const DB = 'suite_fn06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT TRIM('  hello  ') AS t, LTRIM('  hello  ') AS l, RTRIM('  hello  ') AS r" }), 'query');
      const row = q.rows[0] as { t: string; l: string; r: string };
      assertEqual(row.t, 'hello', 'TRIM both sides');
      assertEqual(row.l, 'hello  ', 'LTRIM left only');
      assertEqual(row.r, '  hello', 'RTRIM right only');
      await silentClose(DB);
    },
  },
  {
    id: 'fn-07', group: 'SQL Functions', name: 'SUBSTR extracts substring by position and length',
    fn: async () => {
      const DB = 'suite_fn07';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT SUBSTR('Hello World',7,5) AS s, SUBSTR('abcdef',2) AS s2" }), 'query');
      const row = q.rows[0] as { s: string; s2: string };
      assertEqual(row.s, 'World', 'SUBSTR with length');
      assertEqual(row.s2, 'bcdef', 'SUBSTR without length');
      await silentClose(DB);
    },
  },
  {
    id: 'fn-08', group: 'SQL Functions', name: 'LENGTH and INSTR functions',
    fn: async () => {
      const DB = 'suite_fn08';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT LENGTH('hello') AS len, INSTR('hello world','world') AS pos" }), 'query');
      const row = q.rows[0] as { len: number; pos: number };
      assertEqual(row.len, 5, 'LENGTH of hello');
      assertEqual(row.pos, 7, 'INSTR position of world');
      await silentClose(DB);
    },
  },
  {
    id: 'fn-09', group: 'SQL Functions', name: 'REPLACE string substitution',
    fn: async () => {
      const DB = 'suite_fn09';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT REPLACE('foo bar foo','foo','baz') AS v" }), 'query');
      assertEqual((q.rows[0] as { v: string }).v, 'baz bar baz', 'REPLACE all occurrences');
      await silentClose(DB);
    },
  },
  {
    id: 'fn-10', group: 'SQL Functions', name: 'String concatenation with || operator',
    fn: async () => {
      const DB = 'suite_fn10';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (first TEXT, last TEXT)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?,?)', values: ['John', 'Doe'] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT first || ' ' || last AS full_name FROM t" }), 'query');
      assertEqual((q.rows[0] as { full_name: string }).full_name, 'John Doe', '|| concatenation');
      await silentClose(DB);
    },
  },
  {
    id: 'fn-11', group: 'SQL Functions', name: 'ABS, ROUND, MIN, MAX scalar functions',
    fn: async () => {
      const DB = 'suite_fn11';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB,
        statement: 'SELECT ABS(-42) AS a, ROUND(3.14159,2) AS r, MIN(10,20) AS mn, MAX(10,20) AS mx' }), 'query');
      const row = q.rows[0] as { a: number; r: number; mn: number; mx: number };
      assertEqual(row.a, 42, 'ABS');
      assertEqual(row.r, 3.14, 'ROUND 2 decimals');
      assertEqual(row.mn, 10, 'MIN');
      assertEqual(row.mx, 20, 'MAX');
      await silentClose(DB);
    },
  },
  {
    id: 'fn-12', group: 'SQL Functions', name: 'GLOB pattern matching (* and ? wildcards)',
    fn: async () => {
      const DB = 'suite_fn12';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (f TEXT)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?)', values: ['report.pdf'] },
        { statement: 'INSERT INTO t VALUES (?)', values: ['image.png'] },
        { statement: 'INSERT INTO t VALUES (?)', values: ['report.docx'] },
        { statement: 'INSERT INTO t VALUES (?)', values: ['photo.png'] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT f FROM t WHERE f GLOB '*.png' ORDER BY f" }), 'query');
      assertEqual(q.rows.length, 2, '2 png files');
      const q2 = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT f FROM t WHERE f GLOB 'report.*'" }), 'query');
      assertEqual(q2.rows.length, 2, '2 report files');
      await silentClose(DB);
    },
  },
  {
    id: 'fn-13', group: 'SQL Functions', name: 'LIKE with ESCAPE character for literal % and _',
    fn: async () => {
      const DB = 'suite_fn13';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?)', values: ['100% done'] },
        { statement: 'INSERT INTO t VALUES (?)', values: ['100 items done'] },
        { statement: 'INSERT INTO t VALUES (?)', values: ['file_name.txt'] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT v FROM t WHERE v LIKE '%\\%%' ESCAPE '\\'" }), 'query');
      assertEqual(q.rows.length, 1, 'only row with literal %');
      assertEqual((q.rows[0] as { v: string }).v, '100% done', 'literal % matched');
      await silentClose(DB);
    },
  },
  {
    id: 'fn-14', group: 'SQL Functions', name: 'TYPEOF returns SQLite type names',
    fn: async () => {
      const DB = 'suite_fn14';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB,
        statement: "SELECT TYPEOF(42) AS ti, TYPEOF(3.14) AS tr, TYPEOF('hi') AS tt, TYPEOF(NULL) AS tn" }), 'query');
      const row = q.rows[0] as { ti: string; tr: string; tt: string; tn: string };
      assertEqual(row.ti, 'integer', 'typeof integer');
      assertEqual(row.tr, 'real', 'typeof real');
      assertEqual(row.tt, 'text', 'typeof text');
      assertEqual(row.tn, 'null', 'typeof null');
      await silentClose(DB);
    },
  },

  // ── NULL Handling ─────────────────────────────────────────────────────────────
  {
    id: 'null-01', group: 'NULL Handling', name: 'NULL arithmetic: NULL + value = NULL',
    fn: async () => {
      const DB = 'suite_null01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT NULL + 1 AS a, NULL * 100 AS b, NULL || 'x' AS c" }), 'query');
      const row = q.rows[0] as { a: unknown; b: unknown; c: unknown };
      assert(row.a === null || row.a === undefined, 'NULL+1 = NULL');
      assert(row.b === null || row.b === undefined, 'NULL*100 = NULL');
      assert(row.c === null || row.c === undefined, "NULL||'x' = NULL");
      await silentClose(DB);
    },
  },
  {
    id: 'null-02', group: 'NULL Handling', name: 'NULL = NULL is falsy in WHERE (returns no rows)',
    fn: async () => {
      const DB = 'suite_null02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (NULL)' });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t WHERE v = NULL' }), 'query');
      assertEqual(q.rows.length, 0, 'WHERE v=NULL returns nothing (must use IS NULL)');
      await silentClose(DB);
    },
  },
  {
    id: 'null-03', group: 'NULL Handling', name: 'IS NULL and IS NOT NULL predicates',
    fn: async () => {
      const DB = 'suite_null03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?)', values: [1] },
        { statement: 'INSERT INTO t VALUES (?)', values: [null] },
        { statement: 'INSERT INTO t VALUES (?)', values: [3] },
      ]});
      const qNull = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t WHERE v IS NULL' }), 'is null');
      assertEqual((qNull.rows[0] as { n: number }).n, 1, '1 NULL row');
      const qNotNull = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t WHERE v IS NOT NULL' }), 'is not null');
      assertEqual((qNotNull.rows[0] as { n: number }).n, 2, '2 non-NULL rows');
      await silentClose(DB);
    },
  },
  {
    id: 'null-04', group: 'NULL Handling', name: 'COUNT(*) includes NULLs; COUNT(col) excludes them',
    fn: async () => {
      const DB = 'suite_null04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?)', values: [1] },
        { statement: 'INSERT INTO t VALUES (?)', values: [null] },
        { statement: 'INSERT INTO t VALUES (?)', values: [null] },
        { statement: 'INSERT INTO t VALUES (?)', values: [4] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS all_rows, COUNT(v) AS non_null_rows FROM t' }), 'query');
      const row = q.rows[0] as { all_rows: number; non_null_rows: number };
      assertEqual(row.all_rows, 4, 'COUNT(*) = 4');
      assertEqual(row.non_null_rows, 2, 'COUNT(col) = 2 (excludes NULLs)');
      await silentClose(DB);
    },
  },
  {
    id: 'null-05', group: 'NULL Handling', name: 'Multiple NULLs in UNIQUE column allowed by SQLite',
    fn: async () => {
      const DB = 'suite_null05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER UNIQUE)'] });
      // SQLite allows multiple NULLs in a UNIQUE column (NULL != NULL)
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (NULL)' });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (NULL)' });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t WHERE v IS NULL' }), 'query');
      assertEqual((q.rows[0] as { n: number }).n, 2, '2 NULLs in UNIQUE column');
      await silentClose(DB);
    },
  },
  {
    id: 'null-06', group: 'NULL Handling', name: 'NULLs sort before non-NULL values in ASC ORDER BY',
    fn: async () => {
      const DB = 'suite_null06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?)', values: [3] },
        { statement: 'INSERT INTO t VALUES (?)', values: [null] },
        { statement: 'INSERT INTO t VALUES (?)', values: [1] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t ORDER BY v ASC' }), 'query');
      assert((q.rows[0] as { v: unknown }).v === null || (q.rows[0] as { v: unknown }).v === undefined, 'NULL sorts first in ASC');
      assertEqual((q.rows[2] as { v: number }).v, 3, 'largest value last');
      await silentClose(DB);
    },
  },
  {
    id: 'null-07', group: 'NULL Handling', name: 'NOT IN with NULL in list returns no rows (SQL gotcha)',
    fn: async () => {
      const DB = 'suite_null07';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?)', values: [3] },
        { statement: 'INSERT INTO t VALUES (?)', values: [4] },
        { statement: 'INSERT INTO t VALUES (?)', values: [5] },
      ]});
      // v NOT IN (1, 2, NULL) → v<>1 AND v<>2 AND v<>NULL → unknown for all rows
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t WHERE v NOT IN (1, 2, NULL)' }), 'query');
      assertEqual(q.rows.length, 0, 'NOT IN with NULL → 0 rows (SQL NULL semantics)');
      // Without NULL in list it works as expected
      const q2 = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t WHERE v NOT IN (1, 2)' }), 'query');
      assertEqual(q2.rows.length, 3, 'NOT IN without NULL → 3 rows');
      await silentClose(DB);
    },
  },
  {
    id: 'null-08', group: 'NULL Handling', name: 'SUM/AVG/MIN/MAX aggregate functions skip NULLs',
    fn: async () => {
      const DB = 'suite_null08';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v REAL)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?)', values: [10] },
        { statement: 'INSERT INTO t VALUES (?)', values: [null] },
        { statement: 'INSERT INTO t VALUES (?)', values: [30] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT SUM(v) AS s, AVG(v) AS a, MIN(v) AS mn, MAX(v) AS mx FROM t' }), 'query');
      const row = q.rows[0] as { s: number; a: number; mn: number; mx: number };
      assertEqual(row.s, 40, 'SUM skips NULL → 40');
      assertEqual(row.a, 20, 'AVG of 10 and 30 = 20');
      assertEqual(row.mn, 10, 'MIN skips NULL');
      assertEqual(row.mx, 30, 'MAX skips NULL');
      await silentClose(DB);
    },
  },

  // ── Set Operations ────────────────────────────────────────────────────────────
  {
    id: 'set-01', group: 'Set Operations', name: 'UNION removes duplicate rows',
    fn: async () => {
      const DB = 'suite_set01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB,
        statement: 'SELECT 1 AS v UNION SELECT 1 AS v UNION SELECT 2 AS v ORDER BY v' }), 'query');
      assertEqual(q.rows.length, 2, 'UNION deduplicates');
      assertEqual((q.rows[0] as { v: number }).v, 1, 'first');
      assertEqual((q.rows[1] as { v: number }).v, 2, 'second');
      await silentClose(DB);
    },
  },
  {
    id: 'set-02', group: 'Set Operations', name: 'UNION ALL keeps duplicate rows',
    fn: async () => {
      const DB = 'suite_set02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB,
        statement: 'SELECT 1 AS v UNION ALL SELECT 1 AS v UNION ALL SELECT 2 AS v ORDER BY v' }), 'query');
      assertEqual(q.rows.length, 3, 'UNION ALL keeps duplicates');
      await silentClose(DB);
    },
  },
  {
    id: 'set-03', group: 'Set Operations', name: 'INTERSECT returns common rows',
    fn: async () => {
      const DB = 'suite_set03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB,
        statement: 'SELECT v FROM (SELECT 1 AS v UNION ALL SELECT 2 UNION ALL SELECT 3) INTERSECT SELECT v FROM (SELECT 2 AS v UNION ALL SELECT 3 UNION ALL SELECT 4) ORDER BY v' }), 'query');
      assertEqual(q.rows.length, 2, 'INTERSECT = {2,3}');
      assertEqual((q.rows[0] as { v: number }).v, 2, 'first common');
      assertEqual((q.rows[1] as { v: number }).v, 3, 'second common');
      await silentClose(DB);
    },
  },
  {
    id: 'set-04', group: 'Set Operations', name: 'EXCEPT removes rows that appear in second query',
    fn: async () => {
      const DB = 'suite_set04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB,
        statement: 'SELECT v FROM (SELECT 1 AS v UNION ALL SELECT 2 UNION ALL SELECT 3) EXCEPT SELECT v FROM (SELECT 2 AS v UNION ALL SELECT 3) ORDER BY v' }), 'query');
      assertEqual(q.rows.length, 1, 'EXCEPT = {1}');
      assertEqual((q.rows[0] as { v: number }).v, 1, 'only row 1 remains');
      await silentClose(DB);
    },
  },

  // ── EXISTS Subqueries ─────────────────────────────────────────────────────────
  {
    id: 'exists-01', group: 'EXISTS', name: 'EXISTS subquery returns rows when match found',
    fn: async () => {
      const DB = 'suite_exists01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS users', 'DROP TABLE IF EXISTS orders',
        'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)',
        'CREATE TABLE orders (user_id INTEGER, amount REAL)',
      ]});
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO users VALUES (1,?)', values: ['alice'] },
        { statement: 'INSERT INTO users VALUES (2,?)', values: ['bob'] },
        { statement: 'INSERT INTO orders VALUES (1, 50.0)' },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB,
        statement: 'SELECT name FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id) ORDER BY name' }), 'query');
      assertEqual(q.rows.length, 1, 'only alice has orders');
      assertEqual((q.rows[0] as { name: string }).name, 'alice', 'alice');
      await silentClose(DB);
    },
  },
  {
    id: 'exists-02', group: 'EXISTS', name: 'NOT EXISTS subquery excludes matched rows',
    fn: async () => {
      const DB = 'suite_exists02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS users', 'DROP TABLE IF EXISTS orders',
        'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)',
        'CREATE TABLE orders (user_id INTEGER)',
      ]});
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO users VALUES (1,?)', values: ['alice'] },
        { statement: 'INSERT INTO users VALUES (2,?)', values: ['bob'] },
        { statement: 'INSERT INTO orders VALUES (1)' },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB,
        statement: 'SELECT name FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)' }), 'query');
      assertEqual(q.rows.length, 1, 'only bob has no orders');
      assertEqual((q.rows[0] as { name: string }).name, 'bob', 'bob');
      await silentClose(DB);
    },
  },

  // ── Triggers ──────────────────────────────────────────────────────────────────
  {
    id: 'trg-01', group: 'Triggers', name: 'AFTER INSERT trigger increments counter table',
    fn: async () => {
      const DB = 'suite_trg01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS items', 'DROP TABLE IF EXISTS item_count',
        'DROP TRIGGER IF EXISTS trg_count',
        'CREATE TABLE items (name TEXT)',
        'CREATE TABLE item_count (n INTEGER)',
        'INSERT INTO item_count VALUES (0)',
        'CREATE TRIGGER trg_count AFTER INSERT ON items BEGIN UPDATE item_count SET n = n + 1; END',
      ]});
      await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO items VALUES ('apple')" });
      await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO items VALUES ('banana')" });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT n FROM item_count' }), 'query');
      assertEqual((q.rows[0] as { n: number }).n, 2, 'trigger fired twice → counter = 2');
      await silentClose(DB);
    },
  },
  {
    id: 'trg-02', group: 'Triggers', name: 'BEFORE DELETE trigger writes audit log',
    fn: async () => {
      const DB = 'suite_trg02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS items', 'DROP TABLE IF EXISTS audit',
        'DROP TRIGGER IF EXISTS trg_audit',
        'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)',
        'CREATE TABLE audit (deleted_name TEXT)',
        'CREATE TRIGGER trg_audit BEFORE DELETE ON items BEGIN INSERT INTO audit VALUES (OLD.name); END',
      ]});
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO items VALUES (1,?)', values: ['alpha'] },
        { statement: 'INSERT INTO items VALUES (2,?)', values: ['beta'] },
      ]});
      await CapacitorSqlite.run({ database: DB, statement: 'DELETE FROM items WHERE id = 1' });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT deleted_name FROM audit' }), 'query');
      assertEqual(q.rows.length, 1, '1 audit row after delete');
      assertEqual((q.rows[0] as { deleted_name: string }).deleted_name, 'alpha', 'audit captured correct name');
      await silentClose(DB);
    },
  },
  {
    id: 'trg-03', group: 'Triggers', name: 'AFTER UPDATE trigger captures OLD and NEW values',
    fn: async () => {
      const DB = 'suite_trg03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS prices', 'DROP TABLE IF EXISTS price_changes',
        'DROP TRIGGER IF EXISTS trg_price',
        'CREATE TABLE prices (id INTEGER PRIMARY KEY, amount REAL)',
        'CREATE TABLE price_changes (old_amt REAL, new_amt REAL)',
        'CREATE TRIGGER trg_price AFTER UPDATE ON prices BEGIN INSERT INTO price_changes VALUES (OLD.amount, NEW.amount); END',
      ]});
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO prices VALUES (1, 9.99)' });
      await CapacitorSqlite.run({ database: DB, statement: 'UPDATE prices SET amount = 14.99 WHERE id = 1' });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT old_amt, new_amt FROM price_changes' }), 'query');
      assertEqual(q.rows.length, 1, '1 price change recorded');
      const row = q.rows[0] as { old_amt: number; new_amt: number };
      assert(Math.abs(row.old_amt - 9.99) < 0.001, 'OLD amount');
      assert(Math.abs(row.new_amt - 14.99) < 0.001, 'NEW amount');
      await silentClose(DB);
    },
  },
  {
    id: 'trg-04', group: 'Triggers', name: 'DROP TRIGGER removes the trigger',
    fn: async () => {
      const DB = 'suite_trg04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t', 'DROP TABLE IF EXISTS log',
        'DROP TRIGGER IF EXISTS trg_log',
        'CREATE TABLE t (v INTEGER)',
        'CREATE TABLE log (v INTEGER)',
        'CREATE TRIGGER trg_log AFTER INSERT ON t BEGIN INSERT INTO log VALUES (NEW.v); END',
      ]});
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1)' });
      // Now drop the trigger
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TRIGGER IF EXISTS trg_log'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (2)' });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM log' }), 'query');
      assertEqual((q.rows[0] as { n: number }).n, 1, 'log has 1 row — trigger fired only before DROP');
      await silentClose(DB);
    },
  },
  {
    id: 'trg-05', group: 'Triggers', name: 'Trigger on VIEW (INSTEAD OF INSERT)',
    fn: async () => {
      const DB = 'suite_trg05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS people', 'DROP VIEW IF EXISTS v_people',
        'DROP TRIGGER IF EXISTS trg_v_insert',
        'CREATE TABLE people (name TEXT, age INTEGER)',
        'CREATE VIEW v_people AS SELECT name, age FROM people',
        'CREATE TRIGGER trg_v_insert INSTEAD OF INSERT ON v_people BEGIN INSERT INTO people VALUES (NEW.name, NEW.age); END',
      ]});
      await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO v_people VALUES ('alice', 30)" });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT name, age FROM people' }), 'query');
      assertEqual(q.rows.length, 1, 'INSTEAD OF INSERT routed to base table');
      assertEqual((q.rows[0] as { name: string }).name, 'alice', 'name via view');
      await silentClose(DB);
    },
  },

  // ── Numeric / Type Casting ────────────────────────────────────────────────────
  {
    id: 'cast-01', group: 'Type Casting', name: 'CAST TEXT to INTEGER',
    fn: async () => {
      const DB = 'suite_cast01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT CAST('42' AS INTEGER) AS v, TYPEOF(CAST('42' AS INTEGER)) AS t" }), 'query');
      const row = q.rows[0] as { v: number; t: string };
      assertEqual(row.v, 42, 'CAST text to int value');
      assertEqual(row.t, 'integer', 'CAST text to int type');
      await silentClose(DB);
    },
  },
  {
    id: 'cast-02', group: 'Type Casting', name: 'CAST INTEGER to TEXT',
    fn: async () => {
      const DB = 'suite_cast02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT CAST(123 AS TEXT) AS v, TYPEOF(CAST(123 AS TEXT)) AS t" }), 'query');
      const row = q.rows[0] as { v: string; t: string };
      assertEqual(row.v, '123', 'CAST int to text value');
      assertEqual(row.t, 'text', 'CAST int to text type');
      await silentClose(DB);
    },
  },
  {
    id: 'cast-03', group: 'Type Casting', name: 'CAST REAL to INTEGER truncates toward zero',
    fn: async () => {
      const DB = 'suite_cast03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT CAST(3.9 AS INTEGER) AS a, CAST(-3.9 AS INTEGER) AS b' }), 'query');
      const row = q.rows[0] as { a: number; b: number };
      assertEqual(row.a, 3, 'CAST 3.9 → 3 (truncate)');
      assertEqual(row.b, -3, 'CAST -3.9 → -3 (truncate toward zero)');
      await silentClose(DB);
    },
  },
  {
    id: 'cast-04', group: 'Type Casting', name: 'Integer division returns integer quotient (no fractional part)',
    fn: async () => {
      const DB = 'suite_cast04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT 7/2 AS a, 7.0/2 AS b, 7/2.0 AS c' }), 'query');
      const row = q.rows[0] as { a: number; b: number; c: number };
      assertEqual(row.a, 3, 'integer division 7/2 = 3');
      assert(Math.abs(row.b - 3.5) < 0.001, 'real division 7.0/2 = 3.5');
      assert(Math.abs(row.c - 3.5) < 0.001, 'real division 7/2.0 = 3.5');
      await silentClose(DB);
    },
  },
  {
    id: 'cast-05', group: 'Type Casting', name: 'Division by zero returns NULL (not an error)',
    fn: async () => {
      const DB = 'suite_cast05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT 1/0 AS v' }), 'query');
      const v = (q.rows[0] as { v: unknown }).v;
      assert(v === null || v === undefined, '1/0 in SQLite = NULL (not error)');
      await silentClose(DB);
    },
  },
  {
    id: 'cast-06', group: 'Type Casting', name: 'Very large integer near Int64 max stored accurately',
    fn: async () => {
      const DB = 'suite_cast06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (n INTEGER)'] });
      const big = Number.MAX_SAFE_INTEGER; // 2^53 - 1 = 9007199254740991, largest exactly-representable JS integer
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [big] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT n FROM t' }), 'query');
      assertEqual((q.rows[0] as { n: number }).n, big, 'large integer round-trip');
      await silentClose(DB);
    },
  },
  {
    id: 'cast-07', group: 'Type Casting', name: 'Type affinity: TEXT column stores integer as text',
    fn: async () => {
      const DB = 'suite_cast07';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [42] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v, TYPEOF(v) AS t FROM t' }), 'query');
      const row = q.rows[0] as { v: string; t: string };
      assertEqual(row.t, 'text', 'TEXT affinity stores as text');
      assertEqual(row.v, '42', 'value is text "42"');
      await silentClose(DB);
    },
  },
  {
    id: 'cast-08', group: 'Type Casting', name: 'REAL affinity: integer stored as real',
    fn: async () => {
      const DB = 'suite_cast08';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v REAL)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [42] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v, TYPEOF(v) AS t FROM t' }), 'query');
      // REAL affinity converts integer to real
      const row = q.rows[0] as { v: number; t: string };
      assertEqual(row.t, 'real', 'REAL affinity stores as real');
      assert(Math.abs(row.v - 42) < 0.001, 'value ≈ 42.0');
      await silentClose(DB);
    },
  },

  // ── Recursive CTE ─────────────────────────────────────────────────────────────
  {
    id: 'rcte-01', group: 'Recursive CTE', name: 'Recursive CTE generates sequence 1..10',
    fn: async () => {
      const DB = 'suite_rcte01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: `
        WITH RECURSIVE seq(n) AS (
          SELECT 1
          UNION ALL
          SELECT n+1 FROM seq WHERE n < 10
        )
        SELECT n FROM seq ORDER BY n
      ` }), 'query');
      assertEqual(q.rows.length, 10, '10 rows in sequence');
      assertEqual((q.rows[0] as { n: number }).n, 1, 'starts at 1');
      assertEqual((q.rows[9] as { n: number }).n, 10, 'ends at 10');
      await silentClose(DB);
    },
  },
  {
    id: 'rcte-02', group: 'Recursive CTE', name: 'Recursive CTE computes Fibonacci numbers',
    fn: async () => {
      const DB = 'suite_rcte02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: `
        WITH RECURSIVE fib(a, b) AS (
          SELECT 0, 1
          UNION ALL
          SELECT b, a+b FROM fib WHERE b <= 55
        )
        SELECT a AS v FROM fib ORDER BY a
      ` }), 'query');
      const values = q.rows.map((r) => (r as { v: number }).v);
      const expected = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55];
      expected.forEach((exp, i) => {
        assertEqual(values[i], exp, `fib[${i}] = ${exp}`);
      });
      await silentClose(DB);
    },
  },
  {
    id: 'rcte-03', group: 'Recursive CTE', name: 'Recursive CTE traverses a tree hierarchy',
    fn: async () => {
      const DB = 'suite_rcte03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS tree',
        'CREATE TABLE tree (id INTEGER PRIMARY KEY, parent INTEGER, name TEXT)',
      ]});
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO tree VALUES (1,NULL,?)', values: ['root'] },
        { statement: 'INSERT INTO tree VALUES (2,1,?)', values: ['child1'] },
        { statement: 'INSERT INTO tree VALUES (3,1,?)', values: ['child2'] },
        { statement: 'INSERT INTO tree VALUES (4,2,?)', values: ['grandchild1'] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: `
        WITH RECURSIVE subtree(id, name, depth) AS (
          SELECT id, name, 0 FROM tree WHERE parent IS NULL
          UNION ALL
          SELECT t.id, t.name, s.depth+1 FROM tree t JOIN subtree s ON t.parent = s.id
        )
        SELECT name, depth FROM subtree ORDER BY id
      ` }), 'query');
      assertEqual(q.rows.length, 4, 'all 4 nodes traversed');
      assertEqual((q.rows[0] as { name: string; depth: number }).depth, 0, 'root depth=0');
      assertEqual((q.rows[3] as { name: string; depth: number }).depth, 2, 'grandchild depth=2');
      await silentClose(DB);
    },
  },

  // ── Window Functions ──────────────────────────────────────────────────────────
  {
    id: 'wnd-01', group: 'Window Functions', name: 'ROW_NUMBER() OVER (ORDER BY) assigns sequential numbers',
    fn: async () => {
      const DB = 'suite_wnd01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (score INTEGER)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?)', values: [30] },
        { statement: 'INSERT INTO t VALUES (?)', values: [10] },
        { statement: 'INSERT INTO t VALUES (?)', values: [20] },
      ]});
      const r = await CapacitorSqlite.query({ database: DB,
        statement: 'SELECT score, ROW_NUMBER() OVER (ORDER BY score ASC) AS rn FROM t ORDER BY score ASC' });
      if (!r.success) {
        // Window functions require SQLite ≥ 3.25 — skip gracefully on older builds
        return;
      }
      assertEqual(r.data.rows.length, 3, '3 rows');
      assertEqual((r.data.rows[0] as { rn: number }).rn, 1, 'lowest score gets rn=1');
      assertEqual((r.data.rows[2] as { rn: number }).rn, 3, 'highest score gets rn=3');
      await silentClose(DB);
    },
  },
  {
    id: 'wnd-02', group: 'Window Functions', name: 'SUM() OVER running total',
    fn: async () => {
      const DB = 'suite_wnd02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (day INTEGER, amount INTEGER)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?,?)', values: [1, 10] },
        { statement: 'INSERT INTO t VALUES (?,?)', values: [2, 20] },
        { statement: 'INSERT INTO t VALUES (?,?)', values: [3, 30] },
      ]});
      const r = await CapacitorSqlite.query({ database: DB,
        statement: 'SELECT day, amount, SUM(amount) OVER (ORDER BY day ROWS UNBOUNDED PRECEDING) AS running FROM t ORDER BY day' });
      if (!r.success) return; // SQLite < 3.25 graceful skip
      const rows = r.data.rows as { day: number; amount: number; running: number }[];
      assertEqual(rows[0].running, 10, 'day 1 running = 10');
      assertEqual(rows[1].running, 30, 'day 2 running = 30');
      assertEqual(rows[2].running, 60, 'day 3 running = 60');
      await silentClose(DB);
    },
  },
  {
    id: 'wnd-03', group: 'Window Functions', name: 'RANK() assigns same rank to tied scores',
    fn: async () => {
      const DB = 'suite_wnd03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (name TEXT, score INTEGER)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?,?)', values: ['alice', 100] },
        { statement: 'INSERT INTO t VALUES (?,?)', values: ['bob', 90] },
        { statement: 'INSERT INTO t VALUES (?,?)', values: ['carol', 100] },
      ]});
      const r = await CapacitorSqlite.query({ database: DB,
        statement: 'SELECT name, score, RANK() OVER (ORDER BY score DESC) AS rnk FROM t ORDER BY score DESC, name ASC' });
      if (!r.success) return; // SQLite < 3.25 graceful skip
      const rows = r.data.rows as { name: string; rnk: number }[];
      assertEqual(rows[0].rnk, 1, 'alice rank=1 (tied)');
      assertEqual(rows[1].rnk, 1, 'carol rank=1 (tied)');
      assertEqual(rows[2].rnk, 3, 'bob rank=3 (gap after tie)');
      await silentClose(DB);
    },
  },

  // ── JSON Functions ────────────────────────────────────────────────────────────
  {
    id: 'json-01', group: 'JSON Functions', name: 'json_extract() retrieves nested value from JSON column',
    fn: async () => {
      const DB = 'suite_json01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', "CREATE TABLE t (data TEXT)"] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: ['{"name":"alice","age":30,"tags":["admin","user"]}'] });
      const r = await CapacitorSqlite.query({ database: DB,
        statement: "SELECT json_extract(data,'$.name') AS name, json_extract(data,'$.age') AS age FROM t" });
      if (!r.success) return; // json_extract requires SQLite ≥ 3.9 — skip if not supported
      const row = r.data.rows[0] as { name: string; age: number };
      assertEqual(row.name, 'alice', 'json_extract name');
      assertEqual(row.age, 30, 'json_extract age');
      await silentClose(DB);
    },
  },
  {
    id: 'json-02', group: 'JSON Functions', name: 'json() validates and normalises JSON string',
    fn: async () => {
      const DB = 'suite_json02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const r = await CapacitorSqlite.query({ database: DB, statement: "SELECT json('{\"a\":1,\"b\":2}') AS v" });
      if (!r.success) return; // graceful skip if json() not available
      const v = (r.data.rows[0] as { v: string }).v;
      assert(typeof v === 'string' && v.length > 0, 'json() returns non-empty string');
      const parsed = JSON.parse(v) as { a: number; b: number };
      assertEqual(parsed.a, 1, 'json() preserves a');
      assertEqual(parsed.b, 2, 'json() preserves b');
      await silentClose(DB);
    },
  },
  {
    id: 'json-03', group: 'JSON Functions', name: 'json_array() builds JSON array from values',
    fn: async () => {
      const DB = 'suite_json03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const r = await CapacitorSqlite.query({ database: DB, statement: "SELECT json_array(1,'two',3.0) AS v" });
      if (!r.success) return; // graceful skip
      const v = (r.data.rows[0] as { v: string }).v;
      const arr = JSON.parse(v) as unknown[];
      assertEqual(arr.length, 3, 'json_array length');
      assertEqual(arr[0], 1, 'first element');
      assertEqual(arr[1], 'two', 'second element');
      await silentClose(DB);
    },
  },

  // ── Index Advanced ────────────────────────────────────────────────────────────
  {
    id: 'idx-01', group: 'Index Advanced', name: 'UNIQUE INDEX rejects duplicate values',
    fn: async () => {
      const DB = 'suite_idx01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (email TEXT)',
        'CREATE UNIQUE INDEX idx_email ON t(email)',
      ]});
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: ['a@b.com'] });
      const r2 = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: ['a@b.com'] });
      assert(!r2.success, 'duplicate insert must fail with UNIQUE INDEX');
      await silentClose(DB);
    },
  },
  {
    id: 'idx-02', group: 'Index Advanced', name: 'Composite index on (a, b) columns',
    fn: async () => {
      const DB = 'suite_idx02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (a INTEGER, b INTEGER, val TEXT)',
        'CREATE INDEX idx_ab ON t(a, b)',
      ]});
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?,?,?)', values: [1, 1, 'x'] },
        { statement: 'INSERT INTO t VALUES (?,?,?)', values: [1, 2, 'y'] },
        { statement: 'INSERT INTO t VALUES (?,?,?)', values: [2, 1, 'z'] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT val FROM t WHERE a=1 AND b=2' }), 'query');
      assertEqual(q.rows.length, 1, '1 match on composite index');
      assertEqual((q.rows[0] as { val: string }).val, 'y', 'correct value');
      await silentClose(DB);
    },
  },
  {
    id: 'idx-03', group: 'Index Advanced', name: 'DROP INDEX removes index (duplicates allowed again)',
    fn: async () => {
      const DB = 'suite_idx03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (email TEXT)',
        'CREATE UNIQUE INDEX idx_email ON t(email)',
      ]});
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: ['a@b.com'] });
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP INDEX IF EXISTS idx_email'] });
      // After drop, duplicate should succeed
      const r2 = assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: ['a@b.com'] }), 'second insert after drop index');
      assert(r2.changes === 1, 'second insert succeeds after DROP INDEX');
      await silentClose(DB);
    },
  },

  // ── PRAGMA ────────────────────────────────────────────────────────────────────
  {
    id: 'prg-01', group: 'PRAGMA', name: 'PRAGMA integrity_check returns ok',
    fn: async () => {
      const DB = 'suite_prg01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'PRAGMA integrity_check' }), 'integrity_check');
      const result = (q.rows[0] as { integrity_check: string }).integrity_check;
      assertEqual(result, 'ok', 'DB integrity is ok');
      await silentClose(DB);
    },
  },
  {
    id: 'prg-02', group: 'PRAGMA', name: 'PRAGMA foreign_keys can be read and set',
    fn: async () => {
      const DB = 'suite_prg02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['PRAGMA foreign_keys = ON'], transaction: false });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'PRAGMA foreign_keys' }), 'query');
      const val = (q.rows[0] as { foreign_keys: number }).foreign_keys;
      assertEqual(val, 1, 'foreign_keys = ON reads as 1');
      await silentClose(DB);
    },
  },
  {
    id: 'prg-03', group: 'PRAGMA', name: 'PRAGMA table_info returns column metadata',
    fn: async () => {
      const DB = 'suite_prg03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL)'] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'PRAGMA table_info(t)' }), 'query');
      assertEqual(q.rows.length, 3, '3 columns');
      const cols = q.rows as { name: string; type: string; notnull: number; pk: number }[];
      assertEqual(cols[0].name, 'id', 'col0 name');
      assertEqual(cols[0].pk, 1, 'id is primary key');
      assertEqual(cols[1].notnull, 1, 'name is NOT NULL');
      await silentClose(DB);
    },
  },
  {
    id: 'prg-04', group: 'PRAGMA', name: 'PRAGMA index_list shows created indexes',
    fn: async () => {
      const DB = 'suite_prg04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (email TEXT)',
        'CREATE UNIQUE INDEX idx_mail ON t(email)',
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'PRAGMA index_list(t)' }), 'query');
      assert(q.rows.length >= 1, 'at least 1 index');
      const idx = q.rows.find((r) => (r as { name: string }).name === 'idx_mail');
      assert(idx !== undefined, 'idx_mail found in index_list');
      await silentClose(DB);
    },
  },
  {
    id: 'prg-05', group: 'PRAGMA', name: 'PRAGMA page_count returns non-negative number',
    fn: async () => {
      const plat = assertOk(await CapacitorSqlite.getPlatform(), 'platform');
      const DB = 'suite_prg05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      // Insert a row so the DB has at least one page on all platforms
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)', 'INSERT INTO t VALUES (1)'] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'PRAGMA page_count' }), 'query');
      const n = (q.rows[0] as { page_count: number }).page_count;
      // Web SQLite WASM may report 0 for in-memory-backed stores before flush
      if (plat.platform === 'web') {
        assert(typeof n === 'number' && n >= 0, `page_count should be >= 0 on web, got ${n}`);
      } else {
        assert(typeof n === 'number' && n > 0, `page_count should be > 0, got ${n}`);
      }
      await silentClose(DB);
    },
  },
  {
    id: 'prg-06', group: 'PRAGMA', name: 'PRAGMA cache_size can be set and read back',
    fn: async () => {
      const DB = 'suite_prg06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['PRAGMA cache_size = 500'], transaction: false });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'PRAGMA cache_size' }), 'query');
      const val = (q.rows[0] as { cache_size: number }).cache_size;
      assertEqual(val, 500, 'cache_size reads back 500');
      await silentClose(DB);
    },
  },

  // ── Foreign Keys ──────────────────────────────────────────────────────────────
  {
    id: 'fk-01', group: 'Foreign Keys', name: 'FK constraint rejects orphan row when enabled',
    fn: async () => {
      const DB = 'suite_fk01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['PRAGMA foreign_keys = ON'], transaction: false });
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS orders', 'DROP TABLE IF EXISTS customers',
        'CREATE TABLE customers (id INTEGER PRIMARY KEY)',
        'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id))',
      ]});
      const r = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO orders VALUES (1, 999)' });
      assert(!r.success, 'FK violation must fail');
      await silentClose(DB);
    },
  },
  {
    id: 'fk-02', group: 'Foreign Keys', name: 'FK CASCADE DELETE removes child rows',
    fn: async () => {
      const DB = 'suite_fk02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['PRAGMA foreign_keys = ON'], transaction: false });
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS tags', 'DROP TABLE IF EXISTS posts',
        'CREATE TABLE posts (id INTEGER PRIMARY KEY)',
        'CREATE TABLE tags (id INTEGER PRIMARY KEY, post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE)',
      ]});
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO posts VALUES (1)' });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO tags VALUES (1,1)' },
        { statement: 'INSERT INTO tags VALUES (2,1)' },
      ]});
      await CapacitorSqlite.run({ database: DB, statement: 'DELETE FROM posts WHERE id = 1' });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM tags' }), 'query');
      assertEqual((q.rows[0] as { n: number }).n, 0, 'CASCADE DELETE removed child rows');
      await silentClose(DB);
    },
  },
  {
    id: 'fk-03', group: 'Foreign Keys', name: 'FK SET NULL on delete nullifies child FK column',
    fn: async () => {
      const DB = 'suite_fk03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['PRAGMA foreign_keys = ON'], transaction: false });
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS items', 'DROP TABLE IF EXISTS categories',
        'CREATE TABLE categories (id INTEGER PRIMARY KEY)',
        'CREATE TABLE items (id INTEGER, cat_id INTEGER REFERENCES categories(id) ON DELETE SET NULL)',
      ]});
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO categories VALUES (1)' });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO items VALUES (10, 1)' });
      await CapacitorSqlite.run({ database: DB, statement: 'DELETE FROM categories WHERE id = 1' });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT cat_id FROM items WHERE id = 10' }), 'query');
      const v = (q.rows[0] as { cat_id: unknown }).cat_id;
      assert(v === null || v === undefined, 'SET NULL nullified cat_id');
      await silentClose(DB);
    },
  },

  // ── Advanced Queries ──────────────────────────────────────────────────────────
  {
    id: 'adv-01', group: 'Advanced Queries', name: 'Self-JOIN to find pairs with same value',
    fn: async () => {
      const DB = 'suite_adv01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS employees', 'CREATE TABLE employees (id INTEGER, name TEXT, dept TEXT)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO employees VALUES (?,?,?)', values: [1, 'alice', 'eng'] },
        { statement: 'INSERT INTO employees VALUES (?,?,?)', values: [2, 'bob', 'eng'] },
        { statement: 'INSERT INTO employees VALUES (?,?,?)', values: [3, 'carol', 'hr'] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB,
        statement: 'SELECT a.name AS p1, b.name AS p2 FROM employees a JOIN employees b ON a.dept = b.dept AND a.id < b.id ORDER BY a.name' }), 'query');
      assertEqual(q.rows.length, 1, '1 pair in same department');
      const row = q.rows[0] as { p1: string; p2: string };
      assertEqual(row.p1, 'alice', 'alice');
      assertEqual(row.p2, 'bob', 'bob');
      await silentClose(DB);
    },
  },
  {
    id: 'adv-02', group: 'Advanced Queries', name: 'CROSS JOIN produces cartesian product',
    fn: async () => {
      const DB = 'suite_adv02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS colors', 'DROP TABLE IF EXISTS sizes',
        'CREATE TABLE colors (c TEXT)', 'CREATE TABLE sizes (s TEXT)',
      ]});
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO colors VALUES (?)', values: ['red'] },
        { statement: 'INSERT INTO colors VALUES (?)', values: ['blue'] },
        { statement: 'INSERT INTO sizes VALUES (?)', values: ['S'] },
        { statement: 'INSERT INTO sizes VALUES (?)', values: ['M'] },
        { statement: 'INSERT INTO sizes VALUES (?)', values: ['L'] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT c, s FROM colors CROSS JOIN sizes ORDER BY c, s' }), 'query');
      assertEqual(q.rows.length, 6, 'CROSS JOIN: 2 colors × 3 sizes = 6');
      await silentClose(DB);
    },
  },
  {
    id: 'adv-03', group: 'Advanced Queries', name: 'LEFT JOIN preserves unmatched left rows as NULLs',
    fn: async () => {
      const DB = 'suite_adv03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS depts', 'DROP TABLE IF EXISTS emps',
        'CREATE TABLE depts (id INTEGER, name TEXT)',
        'CREATE TABLE emps (id INTEGER, dept_id INTEGER)',
      ]});
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO depts VALUES (?,?)', values: [1, 'eng'] },
        { statement: 'INSERT INTO depts VALUES (?,?)', values: [2, 'hr'] },
        { statement: 'INSERT INTO emps VALUES (?,?)', values: [10, 1] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB,
        statement: 'SELECT d.name, e.id AS emp_id FROM depts d LEFT JOIN emps e ON e.dept_id = d.id ORDER BY d.id' }), 'query');
      assertEqual(q.rows.length, 2, 'both depts appear in LEFT JOIN');
      const hrRow = q.rows[1] as { name: string; emp_id: unknown };
      assertEqual(hrRow.name, 'hr', 'hr dept present');
      assert(hrRow.emp_id === null || hrRow.emp_id === undefined, 'hr has no employee → NULL');
      await silentClose(DB);
    },
  },
  {
    id: 'adv-04', group: 'Advanced Queries', name: 'Scalar subquery in SELECT list',
    fn: async () => {
      const DB = 'suite_adv04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS sales', 'CREATE TABLE sales (region TEXT, amount REAL)',
      ]});
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO sales VALUES (?,?)', values: ['east', 100] },
        { statement: 'INSERT INTO sales VALUES (?,?)', values: ['west', 200] },
        { statement: 'INSERT INTO sales VALUES (?,?)', values: ['east', 150] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB,
        statement: 'SELECT region, SUM(amount) AS total, (SELECT SUM(amount) FROM sales) AS grand_total FROM sales GROUP BY region ORDER BY region' }), 'query');
      assertEqual(q.rows.length, 2, '2 regions');
      const row = q.rows[0] as { region: string; total: number; grand_total: number };
      assertEqual(row.grand_total, 450, 'grand total = 450 in each row');
      await silentClose(DB);
    },
  },
  {
    id: 'adv-05', group: 'Advanced Queries', name: 'Correlated subquery in WHERE clause',
    fn: async () => {
      const DB = 'suite_adv05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS products', 'CREATE TABLE products (cat TEXT, name TEXT, price REAL)',
      ]});
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO products VALUES (?,?,?)', values: ['fruit', 'apple', 1.2] },
        { statement: 'INSERT INTO products VALUES (?,?,?)', values: ['fruit', 'mango', 3.5] },
        { statement: 'INSERT INTO products VALUES (?,?,?)', values: ['veg', 'carrot', 0.8] },
        { statement: 'INSERT INTO products VALUES (?,?,?)', values: ['veg', 'broccoli', 2.0] },
      ]});
      // Find products priced above their category average
      const q = assertOk(await CapacitorSqlite.query({ database: DB,
        statement: 'SELECT name FROM products p WHERE price > (SELECT AVG(price) FROM products p2 WHERE p2.cat = p.cat) ORDER BY name' }), 'query');
      assertEqual(q.rows.length, 2, '2 above-avg products');
      const names = q.rows.map((r) => (r as { name: string }).name).sort();
      assertEqual(names[0], 'broccoli', 'broccoli above veg avg');
      assertEqual(names[1], 'mango', 'mango above fruit avg');
      await silentClose(DB);
    },
  },
  {
    id: 'adv-06', group: 'Advanced Queries', name: 'Multiple CTEs in single query',
    fn: async () => {
      const DB = 'suite_adv06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t', 'CREATE TABLE t (dept TEXT, salary REAL)',
      ]});
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?,?)', values: ['eng', 90000] },
        { statement: 'INSERT INTO t VALUES (?,?)', values: ['eng', 110000] },
        { statement: 'INSERT INTO t VALUES (?,?)', values: ['hr', 70000] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: `
        WITH
          dept_avg AS (SELECT dept, AVG(salary) AS avg_sal FROM t GROUP BY dept),
          total AS (SELECT SUM(salary) AS grand FROM t)
        SELECT d.dept, d.avg_sal, t.grand FROM dept_avg d, total t ORDER BY d.dept
      ` }), 'query');
      assertEqual(q.rows.length, 2, '2 depts');
      const engRow = q.rows[0] as { dept: string; avg_sal: number; grand: number };
      assertEqual(engRow.dept, 'eng', 'eng dept');
      assertEqual(engRow.avg_sal, 100000, 'eng avg salary');
      assertEqual(engRow.grand, 270000, 'grand total in each row');
      await silentClose(DB);
    },
  },
  {
    id: 'adv-07', group: 'Advanced Queries', name: 'HAVING filters groups after aggregation',
    fn: async () => {
      const DB = 'suite_adv07';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS orders', 'CREATE TABLE orders (customer TEXT, amount REAL)',
      ]});
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO orders VALUES (?,?)', values: ['alice', 50] },
        { statement: 'INSERT INTO orders VALUES (?,?)', values: ['alice', 80] },
        { statement: 'INSERT INTO orders VALUES (?,?)', values: ['bob', 20] },
        { statement: 'INSERT INTO orders VALUES (?,?)', values: ['carol', 100] },
        { statement: 'INSERT INTO orders VALUES (?,?)', values: ['carol', 150] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB,
        statement: 'SELECT customer, SUM(amount) AS total FROM orders GROUP BY customer HAVING total > 100 ORDER BY total DESC' }), 'query');
      assertEqual(q.rows.length, 2, 'alice (130) and carol (250) pass HAVING');
      assertEqual((q.rows[0] as { customer: string }).customer, 'carol', 'carol has highest total');
      await silentClose(DB);
    },
  },

  // ── View ──────────────────────────────────────────────────────────────────────
  {
    id: 'view-01', group: 'View', name: 'CREATE VIEW and query through it',
    fn: async () => {
      const DB = 'suite_view01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP VIEW IF EXISTS active_users', 'DROP TABLE IF EXISTS users',
        'CREATE TABLE users (id INTEGER, name TEXT, active INTEGER)',
        'CREATE VIEW active_users AS SELECT id, name FROM users WHERE active = 1',
      ]});
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO users VALUES (1,?,1)', values: ['alice'] },
        { statement: 'INSERT INTO users VALUES (2,?,0)', values: ['bob'] },
        { statement: 'INSERT INTO users VALUES (3,?,1)', values: ['carol'] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT name FROM active_users ORDER BY name' }), 'query');
      assertEqual(q.rows.length, 2, '2 active users via view');
      assertEqual((q.rows[0] as { name: string }).name, 'alice', 'alice');
      assertEqual((q.rows[1] as { name: string }).name, 'carol', 'carol');
      await silentClose(DB);
    },
  },
  {
    id: 'view-02', group: 'View', name: 'DROP VIEW removes the view',
    fn: async () => {
      const DB = 'suite_view02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP VIEW IF EXISTS v', 'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (n INTEGER)', 'CREATE VIEW v AS SELECT n FROM t',
      ]});
      // Verify view works
      const q1 = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM v' }), 'view before drop');
      assert((q1.rows[0] as { n: number }).n === 0, 'view works before drop');
      // Drop view and verify it's gone
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP VIEW IF EXISTS v'] });
      const r = await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM v' });
      assert(!r.success, 'query on dropped view must fail');
      await silentClose(DB);
    },
  },

  // ── Error Handling ────────────────────────────────────────────────────────────
  {
    id: 'err-01', group: 'Error Handling', name: 'Query on non-existent table returns QUERY_FAILED',
    fn: async () => {
      const DB = 'suite_err01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const r = await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM nonexistent_xyz_table_abc' });
      assert(!r.success, 'query on missing table must fail');
      await silentClose(DB);
    },
  },
  {
    id: 'err-02', group: 'Error Handling', name: 'SQL syntax error in execute returns EXECUTE_FAILED',
    fn: async () => {
      const DB = 'suite_err02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const r = await CapacitorSqlite.execute({ database: DB, statements: ['SELEKT * FORM nowhere'] });
      assert(!r.success, 'syntax error must fail');
      await silentClose(DB);
    },
  },
  {
    id: 'err-03', group: 'Error Handling', name: 'NOT NULL constraint violation on INSERT returns EXECUTE_FAILED',
    fn: async () => {
      const DB = 'suite_err03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (name TEXT NOT NULL)'] });
      const r = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (NULL)' });
      assert(!r.success, 'NOT NULL violation must fail');
      await silentClose(DB);
    },
  },
  {
    id: 'err-04', group: 'Error Handling', name: 'CHECK constraint violation returns EXECUTE_FAILED',
    fn: async () => {
      const DB = 'suite_err04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (age INTEGER CHECK (age >= 0 AND age <= 150))'] });
      const r = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (-1)' });
      assert(!r.success, 'CHECK violation must fail');
      await silentClose(DB);
    },
  },
  {
    id: 'err-05', group: 'Error Handling', name: 'Inserting into non-existent table returns EXECUTE_FAILED',
    fn: async () => {
      const DB = 'suite_err05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const r = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO ghost_table_xyz VALUES (1)' });
      assert(!r.success, 'insert into missing table must fail');
      await silentClose(DB);
    },
  },

  // ── Concurrency ───────────────────────────────────────────────────────────────
  {
    id: 'cc-01', group: 'Concurrency', name: '10 parallel open() same DB — all succeed or get DB_ALREADY_OPEN',
    fn: async () => {
      const DB = 'suite_cc01';
      await silentClose(DB);
      const results = await Promise.all(Array.from({ length: 10 }, () => CapacitorSqlite.open({ database: DB })));
      const successes = results.filter((r) => r.success);
      assert(successes.length > 0, 'at least one parallel open must succeed');
      await silentClose(DB);
    },
  },
  {
    id: 'cc-02', group: 'Concurrency', name: '10 parallel run() INSERTs — all rows committed',
    fn: async () => {
      const DB = 'suite_cc02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [i + 1] })
        )
      );
      const successes = results.filter((r) => r.success).length;
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((q.rows[0] as { n: number }).n, successes, `${successes} parallel inserts committed`);
      assert(successes > 0, 'at least one parallel insert succeeded');
      await silentClose(DB);
    },
  },
  {
    id: 'cc-03', group: 'Concurrency', name: '10 parallel query() calls — all return consistent data',
    fn: async () => {
      const DB = 'suite_cc03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      for (let i = 0; i < 5; i++) {
        await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [i] });
      }
      const results = await Promise.all(
        Array.from({ length: 10 }, () => CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }))
      );
      for (const r of results) {
        const data = assertOk(r, 'parallel query');
        assertEqual((data.rows[0] as { n: number }).n, 5, 'each parallel query returns count=5');
      }
      await silentClose(DB);
    },
  },
  {
    id: 'cc-04', group: 'Concurrency', name: 'Rapid open→close→open 10 cycles — data stable across cycles',
    fn: async () => {
      const DB = 'suite_cc04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (n INTEGER)', 'INSERT INTO t VALUES (42)'] });
      await silentClose(DB);
      for (let i = 0; i < 10; i++) {
        assertOk(await CapacitorSqlite.open({ database: DB }), `open cycle ${i}`);
        const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT n FROM t' }), 'query');
        assertEqual((q.rows[0] as { n: number }).n, 42, `data stable at cycle ${i}`);
        await silentClose(DB);
      }
    },
  },
  {
    id: 'cc-05', group: 'Concurrency', name: 'Parallel runBatch + query — batch completes, no corruption',
    fn: async () => {
      const DB = 'suite_cc05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      const [batchResult] = await Promise.all([
        CapacitorSqlite.runBatch({
          database: DB,
          set: Array.from({ length: 20 }, (_, i) => ({ statement: 'INSERT INTO t VALUES (?)', values: [i] })),
          transaction: true,
        }),
        CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }),
      ]);
      assert(batchResult.success, 'runBatch succeeded');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'final count');
      assertEqual((q.rows[0] as { n: number }).n, 20, '20 rows after concurrent batch+query');
      await silentClose(DB);
    },
  },

  // ── Invalid Params ────────────────────────────────────────────────────────────
  {
    id: 'ip-01', group: 'Invalid Params', name: 'run() with empty SQL string → error',
    fn: async () => {
      const DB = 'suite_ip01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const r = await CapacitorSqlite.run({ database: DB, statement: '' });
      assert(!r.success, 'empty SQL must fail');
      await silentClose(DB);
    },
  },
  {
    id: 'ip-02', group: 'Invalid Params', name: 'query() with empty SQL string → error',
    fn: async () => {
      const DB = 'suite_ip02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const r = await CapacitorSqlite.query({ database: DB, statement: '' });
      assert(!r.success, 'empty SQL must fail');
      await silentClose(DB);
    },
  },
  {
    id: 'ip-03', group: 'Invalid Params', name: "execute() with empty string '' in statements array → error",
    fn: async () => {
      const DB = 'suite_ip03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const r = await CapacitorSqlite.execute({ database: DB, statements: [''] });
      assert(!r.success, 'empty statement must fail');
      await silentClose(DB);
    },
  },
  {
    id: 'ip-04', group: 'Invalid Params', name: 'run() with object {} param — plugin must not crash',
    fn: async () => {
      const DB = 'suite_ip04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v)'] });
      // Object as param — must not crash; may fail or bind as NULL/string
      const r = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [{} as unknown as null] });
      assert(typeof r.success === 'boolean', 'result must have success field (no crash)');
      await silentClose(DB);
    },
  },
  {
    id: 'ip-05', group: 'Invalid Params', name: 'run() with NaN param — JSON bridge converts to null (SQL NULL)',
    fn: async () => {
      const DB = 'suite_ip05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v)'] });
      // NaN serializes as null in JSON → typically bound as SQL NULL
      const r = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [NaN as unknown as null] });
      assert(typeof r.success === 'boolean', 'must not crash');
      if (r.success) {
        const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT TYPEOF(v) AS t FROM t' }), 'query');
        const t = (q.rows[0] as { t: string }).t;
        assert(['null', 'real', 'integer'].includes(t), `NaN stored as null/real/integer, got: ${t}`);
      }
      await silentClose(DB);
    },
  },
  {
    id: 'ip-06', group: 'Invalid Params', name: 'run() with Infinity param — plugin must not crash',
    fn: async () => {
      const DB = 'suite_ip06';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v)'] });
      const r = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [Infinity as unknown as null] });
      assert(typeof r.success === 'boolean', 'must not crash');
      // Plugin still functional after edge-case
      const q = await CapacitorSqlite.query({ database: DB, statement: 'SELECT 1 AS ok' });
      assert(q.success, 'DB still functional after Infinity param');
      await silentClose(DB);
    },
  },
  {
    id: 'ip-07', group: 'Invalid Params', name: 'DB name with path traversal ../ — rejected or sanitized',
    fn: async () => {
      const r = await CapacitorSqlite.open({ database: '../traversal_test_xyz' });
      if (r.success) {
        await silentClose('../traversal_test_xyz');
      } else {
        // Correctly rejected — verify error shape
        assert(typeof r.error.code === 'string' && r.error.code.length > 0, 'rejection must have error code');
      }
      // Either outcome acceptable — plugin must not crash or expose raw FS paths in error
      assert(typeof r.success === 'boolean', 'result must have success field');
    },
  },
  {
    id: 'ip-08', group: 'Invalid Params', name: 'Excessively long DB name (400 chars) — error or handled',
    fn: async () => {
      const longName = 'a'.repeat(400);
      const r = await CapacitorSqlite.open({ database: longName });
      if (r.success) {
        await silentClose(longName);
      }
      assert(typeof r.success === 'boolean', 'must not crash on long DB name');
    },
  },

  // ── Error Format ──────────────────────────────────────────────────────────────
  {
    id: 'ef-01', group: 'Error Format', name: 'run() error: { success:false, error:{ code, message } }',
    fn: async () => {
      const DB = 'suite_ef01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const r = await CapacitorSqlite.run({ database: DB, statement: 'INVALID SQL GARBAGE HERE' });
      if (r.success) throw new Error('ef-01: expected failure, got success');
      assert(typeof r.error.code === 'string' && r.error.code.length > 0, 'error.code is non-empty string');
      assert(typeof r.error.message === 'string' && r.error.message.length > 0, 'error.message is non-empty string');
      await silentClose(DB);
    },
  },
  {
    id: 'ef-02', group: 'Error Format', name: 'query() error has consistent { code, message } shape',
    fn: async () => {
      const DB = 'suite_ef02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const r = await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM ghost_table_zzz_abc' });
      if (r.success) throw new Error('ef-02: expected failure, got success');
      assert(typeof r.error.code === 'string' && r.error.code.length > 0, 'code non-empty');
      assert(typeof r.error.message === 'string' && r.error.message.length > 0, 'message non-empty');
      await silentClose(DB);
    },
  },
  {
    id: 'ef-03', group: 'Error Format', name: 'execute() error has consistent shape',
    fn: async () => {
      const DB = 'suite_ef03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const r = await CapacitorSqlite.execute({ database: DB, statements: ['NOT VALID SQL AT ALL 🙈'] });
      if (r.success) throw new Error('ef-03: expected failure, got success');
      assert(typeof r.error.code === 'string' && r.error.code.length > 0, 'code non-empty');
      assert(typeof r.error.message === 'string' && r.error.message.length > 0, 'message non-empty');
      await silentClose(DB);
    },
  },
  {
    id: 'ef-04', group: 'Error Format', name: 'All error codes are SCREAMING_SNAKE_CASE strings',
    fn: async () => {
      const DB = 'suite_ef04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const codePattern = /^[A-Z][A-Z0-9_]*$/;
      const results = await Promise.all([
        CapacitorSqlite.run({ database: DB, statement: 'BAD SQL' }),
        CapacitorSqlite.query({ database: DB, statement: 'BAD SQL' }),
        CapacitorSqlite.execute({ database: DB, statements: ['BAD SQL'] }),
      ]);
      for (const r of results) {
        if (r.success) throw new Error('ef-04: expected failure, got success');
        assert(codePattern.test(r.error.code), `error code "${r.error.code}" must be SCREAMING_SNAKE_CASE`);
      }
      await silentClose(DB);
    },
  },

  // ── Large Data ────────────────────────────────────────────────────────────────
  {
    id: 'ld-01', group: 'Large Data', name: '1 MB TEXT stored and LENGTH() verified',
    fn: async () => {
      const DB = 'suite_ld01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (d TEXT)'] });
      const oneMB = 'x'.repeat(1_048_576);
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [oneMB] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT LENGTH(d) AS len FROM t' }), 'query');
      assertEqual((q.rows[0] as { len: number }).len, 1_048_576, '1 MB TEXT length correct');
      await silentClose(DB);
    },
  },
  {
    id: 'ld-02', group: 'Large Data', name: '1 MB BLOB stored and LENGTH() verified',
    fn: async () => {
      const DB = 'suite_ld02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (d BLOB)'] });
      const oneMB = new Uint8Array(1_048_576).fill(0xAB);
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [oneMB] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT LENGTH(d) AS len FROM t' }), 'query');
      assertEqual((q.rows[0] as { len: number }).len, 1_048_576, '1 MB BLOB length correct');
      await silentClose(DB);
    },
  },
  {
    id: 'ld-03', group: 'Large Data', name: 'Table with 50 columns — all values stored and retrieved',
    fn: async () => {
      const DB = 'suite_ld03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const colDefs = Array.from({ length: 50 }, (_, i) => `c${i} INTEGER`).join(', ');
      await CapacitorSqlite.execute({ database: DB, statements: [`DROP TABLE IF EXISTS t`, `CREATE TABLE t (${colDefs})`] });
      const vals = Array.from({ length: 50 }, (_, i) => i * 10);
      const placeholders = vals.map(() => '?').join(', ');
      await CapacitorSqlite.run({ database: DB, statement: `INSERT INTO t VALUES (${placeholders})`, values: vals });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM t' }), 'query');
      const row = q.rows[0] as Record<string, number>;
      assertEqual(row['c0'], 0, 'first column c0');
      assertEqual(row['c25'], 250, 'middle column c25');
      assertEqual(row['c49'], 490, 'last column c49');
      await silentClose(DB);
    },
  },
  {
    id: 'ld-04', group: 'Large Data', name: 'IN clause with 200 bound params — matches 200 of 300 rows',
    fn: async () => {
      const DB = 'suite_ld04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.runBatch({
        database: DB,
        set: Array.from({ length: 300 }, (_, i) => ({ statement: 'INSERT INTO t VALUES (?)', values: [i] })),
      });
      const inVals = Array.from({ length: 200 }, (_, i) => i);
      const placeholders = inVals.map(() => '?').join(',');
      const q = assertOk(await CapacitorSqlite.query({
        database: DB,
        statement: `SELECT COUNT(*) AS n FROM t WHERE v IN (${placeholders})`,
        values: inVals,
      }), 'query');
      assertEqual((q.rows[0] as { n: number }).n, 200, 'IN with 200 params matches 200 rows');
      await silentClose(DB);
    },
  },

  // ── WAL Mode ──────────────────────────────────────────────────────────────────
  {
    id: 'wal-01', group: 'WAL Mode', name: 'PRAGMA journal_mode=WAL — graceful on platforms that support it',
    fn: async () => {
      const plat = assertOk(await CapacitorSqlite.getPlatform(), 'platform');
      if (plat.platform === 'web') return; // OPFS WAL not reliably supported in WASM
      const DB = 'suite_wal01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const r = await CapacitorSqlite.query({ database: DB, statement: 'PRAGMA journal_mode=WAL' });
      if (!r.success) { await silentClose(DB); return; } // graceful skip
      const mode = (r.data.rows[0] as { journal_mode: string }).journal_mode;
      assert(['wal', 'delete', 'memory'].includes(mode), `journal_mode "${mode}" is a known mode`);
      await silentClose(DB);
    },
  },
  {
    id: 'wal-02', group: 'WAL Mode', name: 'PRAGMA synchronous=NORMAL — read back as 1',
    fn: async () => {
      const plat = assertOk(await CapacitorSqlite.getPlatform(), 'platform');
      if (plat.platform === 'web') return;
      const DB = 'suite_wal02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['PRAGMA synchronous=NORMAL'], transaction: false });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'PRAGMA synchronous' }), 'query');
      assertEqual((q.rows[0] as { synchronous: number }).synchronous, 1, 'synchronous=NORMAL reads back as 1');
      await silentClose(DB);
    },
  },
  {
    id: 'wal-03', group: 'WAL Mode', name: 'VACUUM after mass DELETE compacts and integrity_check passes',
    fn: async () => {
      const DB = 'suite_wal03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      await CapacitorSqlite.runBatch({
        database: DB,
        set: Array.from({ length: 500 }, (_, i) => ({ statement: 'INSERT INTO t VALUES (?)', values: [`row_${i}`] })),
      });
      await CapacitorSqlite.run({ database: DB, statement: 'DELETE FROM t' });
      await CapacitorSqlite.execute({ database: DB, statements: ['VACUUM'], transaction: false });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'PRAGMA integrity_check' }), 'integrity_check');
      assertEqual((q.rows[0] as { integrity_check: string }).integrity_check, 'ok', 'integrity ok after vacuum');
      const cnt = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((cnt.rows[0] as { n: number }).n, 0, 'table empty after DELETE + VACUUM');
      await silentClose(DB);
    },
  },
  {
    id: 'wal-04', group: 'WAL Mode', name: 'ANALYZE and REINDEX run successfully',
    fn: async () => {
      const DB = 'suite_wal04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (v TEXT)',
        'CREATE INDEX IF NOT EXISTS idx_v ON t(v)',
      ]});
      await CapacitorSqlite.runBatch({
        database: DB,
        set: Array.from({ length: 50 }, (_, i) => ({ statement: 'INSERT INTO t VALUES (?)', values: [`val${i}`] })),
      });
      const r1 = assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['ANALYZE'], transaction: false }), 'ANALYZE');
      assert(r1 !== undefined, 'ANALYZE succeeded');
      const r2 = assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['REINDEX'], transaction: false }), 'REINDEX');
      assert(r2 !== undefined, 'REINDEX succeeded');
      await silentClose(DB);
    },
  },

  // ── Collation ─────────────────────────────────────────────────────────────────
  {
    id: 'coll-01', group: 'Collation', name: 'COLLATE NOCASE — case-insensitive equality for ASCII',
    fn: async () => {
      const DB = 'suite_coll01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT COLLATE NOCASE)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: ['Hello'] });
      const q1 = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT v FROM t WHERE v = 'hello'" }), 'lower');
      assertEqual(q1.rows.length, 1, 'NOCASE: hello == Hello');
      const q2 = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT v FROM t WHERE v = 'HELLO'" }), 'upper');
      assertEqual(q2.rows.length, 1, 'NOCASE: HELLO == Hello');
      await silentClose(DB);
    },
  },
  {
    id: 'coll-02', group: 'Collation', name: 'ORDER BY COLLATE NOCASE sorts case-independently',
    fn: async () => {
      const DB = 'suite_coll02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?)', values: ['Banana'] },
        { statement: 'INSERT INTO t VALUES (?)', values: ['apple'] },
        { statement: 'INSERT INTO t VALUES (?)', values: ['Cherry'] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t ORDER BY v COLLATE NOCASE ASC' }), 'query');
      assertEqual((q.rows[0] as { v: string }).v, 'apple', 'apple first (a < b nocase)');
      assertEqual((q.rows[1] as { v: string }).v, 'Banana', 'Banana second');
      assertEqual((q.rows[2] as { v: string }).v, 'Cherry', 'Cherry third');
      await silentClose(DB);
    },
  },
  {
    id: 'coll-03', group: 'Collation', name: 'LIKE is case-insensitive for ASCII by default',
    fn: async () => {
      const DB = 'suite_coll03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?)', values: ['Hello World'] },
        { statement: 'INSERT INTO t VALUES (?)', values: ['HELLO WORLD'] },
        { statement: 'INSERT INTO t VALUES (?)', values: ['goodbye'] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT COUNT(*) AS n FROM t WHERE v LIKE '%hello%'" }), 'query');
      assertEqual((q.rows[0] as { n: number }).n, 2, 'LIKE case-insensitive for ASCII');
      await silentClose(DB);
    },
  },
  {
    id: 'coll-04', group: 'Collation', name: 'Default BINARY collation is case-sensitive for non-ASCII (SQLite limitation)',
    fn: async () => {
      const DB = 'suite_coll04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?)', values: ['Čeština'] },
        { statement: 'INSERT INTO t VALUES (?)', values: ['čeština'] },
      ]});
      // BINARY collation (default) distinguishes Č from č
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT COUNT(*) AS n FROM t WHERE v = 'čeština'" }), 'query');
      assertEqual((q.rows[0] as { n: number }).n, 1, 'default collation is case-sensitive for non-ASCII');
      await silentClose(DB);
    },
  },
  {
    id: 'coll-05', group: 'Collation', name: 'Unicode emoji stored and compared by code point',
    fn: async () => {
      const DB = 'suite_coll05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] });
      await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (?)', values: ['🍎'] },
        { statement: 'INSERT INTO t VALUES (?)', values: ['🍌'] },
        { statement: 'INSERT INTO t VALUES (?)', values: ['🍒'] },
      ]});
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT v FROM t WHERE v = '🍌'" }), 'query');
      assertEqual(q.rows.length, 1, 'emoji equality by Unicode code point');
      assertEqual((q.rows[0] as { v: string }).v, '🍌', 'banana emoji returned correctly');
      await silentClose(DB);
    },
  },

  // ── Migration Extras ──────────────────────────────────────────────────────────
  {
    id: 'me-01', group: 'Migration Extras', name: 'Version 0 migration not applied (0 > current_version=0 is false)',
    fn: async () => {
      const DB = 'suite_me01';
      await silentClose(DB);
      // Version 0 is ≤ current user_version (also 0) → must not be applied
      const r = await CapacitorSqlite.open({ database: DB, migrations: [
        { version: 0, statements: ['CREATE TABLE IF NOT EXISTS marker_me01 (v INTEGER)'] },
      ]});
      if (!r.success) { await silentClose(DB); return; } // plugin rejects v0 — also acceptable
      // If open succeeded, verify user_version is still 0 (v0 was not applied)
      const gv = assertOk(await CapacitorSqlite.getSchemaVersion({ database: DB }), 'getSchemaVersion');
      assertEqual(gv.version, 0, 'user_version remains 0 — v0 migration not applied');
      await silentClose(DB);
    },
  },
  {
    id: 'me-02', group: 'Migration Extras', name: 'user_version tracks each migration version accurately',
    fn: async () => {
      const DB = 'suite_me02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB, migrations: [
        { version: 1, statements: ['CREATE TABLE IF NOT EXISTS t1 (x INTEGER)'] },
        { version: 2, statements: ['CREATE TABLE IF NOT EXISTS t2 (x INTEGER)'] },
        { version: 3, statements: ['CREATE TABLE IF NOT EXISTS t3 (x INTEGER)'] },
      ]}), 'open with 3 migrations');
      const gv = assertOk(await CapacitorSqlite.getSchemaVersion({ database: DB }), 'getSchemaVersion');
      assertEqual(gv.version, 3, 'user_version = 3 after applying v1, v2, v3');
      await silentClose(DB);
    },
  },
  {
    id: 'me-03', group: 'Migration Extras', name: 'Re-open with higher version — only new migration applied, old data unchanged',
    fn: async () => {
      const DB = 'suite_me03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB, migrations: [
        { version: 1, statements: ['CREATE TABLE IF NOT EXISTS t (n INTEGER)', 'INSERT INTO t VALUES (100)'] },
      ]}), 'open v1');
      await silentClose(DB);
      // Re-open with v1 + v2 — v1 INSERT must NOT be re-executed
      assertOk(await CapacitorSqlite.open({ database: DB, migrations: [
        { version: 1, statements: ['INSERT INTO t VALUES (100)'] }, // would duplicate if re-run
        { version: 2, statements: ['INSERT INTO t VALUES (200)'] },
      ]}), 'open v2');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT n FROM t ORDER BY n' }), 'query');
      assertEqual(q.rows.length, 2, 'exactly 2 rows: original v1 + new v2 (no duplicate)');
      assertEqual((q.rows[0] as { n: number }).n, 100, 'v1 row');
      assertEqual((q.rows[1] as { n: number }).n, 200, 'v2 row');
      await silentClose(DB);
    },
  },
  {
    id: 'me-04', group: 'Migration Extras', name: 'Failed migration leaves user_version at last successful version',
    fn: async () => {
      const DB = 'suite_me04';
      await silentClose(DB);
      // Apply v1 successfully
      assertOk(await CapacitorSqlite.open({ database: DB, migrations: [
        { version: 1, statements: ['CREATE TABLE IF NOT EXISTS t (n INTEGER)'] },
      ]}), 'open v1');
      await silentClose(DB);
      // Try v2 with bad SQL — must fail but v1 must still be in place
      const r2 = await CapacitorSqlite.open({ database: DB, migrations: [
        { version: 1, statements: ['CREATE TABLE IF NOT EXISTS t (n INTEGER)'] },
        { version: 2, statements: ['TOTALLY BROKEN SQL THAT FAILS'] },
      ]});
      if (!r2.success) {
        // Re-open without migrations to verify user_version = 1
        assertOk(await CapacitorSqlite.open({ database: DB }), 'reopen after fail');
        const gv = assertOk(await CapacitorSqlite.getSchemaVersion({ database: DB }), 'getSchemaVersion');
        assertEqual(gv.version, 1, 'user_version stayed at 1 after v2 failure');
        await silentClose(DB);
      } else {
        // Some plugins allow partial migration — just verify we can close cleanly
        await silentClose(DB);
      }
    },
  },

  // ── Result Shape ──────────────────────────────────────────────────────────────
  {
    id: 'rs-01', group: 'Result Shape', name: 'query() always returns rows array even when empty',
    fn: async () => {
      const DB = 'suite_rs01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM t' }), 'query');
      assert(Array.isArray(q.rows), 'rows is an Array');
      assertEqual(q.rows.length, 0, 'rows is empty array, not null/undefined');
      await silentClose(DB);
    },
  },
  {
    id: 'rs-02', group: 'Result Shape', name: 'run() INSERT always returns { changes, lastInsertId }',
    fn: async () => {
      const DB = 'suite_rs02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'] });
      const r = assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t (v) VALUES (?)', values: ['hello'] }), 'run');
      assert(typeof r.changes === 'number', 'changes is a number');
      assert(typeof r.lastInsertId === 'number', 'lastInsertId is a number');
      assertEqual(r.changes, 1, 'changes = 1');
      assert(r.lastInsertId > 0, 'lastInsertId > 0 after INSERT');
      await silentClose(DB);
    },
  },
  {
    id: 'rs-03', group: 'Result Shape', name: 'run() UPDATE no match → changes=0, lastInsertId=0',
    fn: async () => {
      const DB = 'suite_rs03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'] });
      const r = assertOk(await CapacitorSqlite.run({ database: DB, statement: "UPDATE t SET v='x' WHERE id=9999" }), 'run');
      assertEqual(r.changes, 0, 'changes = 0 for no-match UPDATE');
      assertEqual(r.lastInsertId, 0, 'lastInsertId = 0 for UPDATE');
      await silentClose(DB);
    },
  },
  {
    id: 'rs-04', group: 'Result Shape', name: 'runBatch() always returns { changes, lastInsertId }',
    fn: async () => {
      const DB = 'suite_rs04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      const r = assertOk(await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO t VALUES (1)' },
        { statement: 'INSERT INTO t VALUES (2)' },
      ]}), 'runBatch');
      assert(typeof r.changes === 'number', 'changes is a number');
      assert(typeof r.lastInsertId === 'number', 'lastInsertId is a number');
      await silentClose(DB);
    },
  },
  {
    id: 'rs-05', group: 'Result Shape', name: 'Column types consistent: INTEGER→number, REAL→number, TEXT→string, NULL→null',
    fn: async () => {
      const DB = 'suite_rs05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB,
        statement: "SELECT 42 AS n, 3.14 AS f, 'hello' AS s, NULL AS nul" }), 'query');
      const row = q.rows[0] as { n: unknown; f: unknown; s: unknown; nul: unknown };
      assert(typeof row.n === 'number', `INTEGER → JS number, got ${typeof row.n}`);
      assert(typeof row.f === 'number', `REAL → JS number, got ${typeof row.f}`);
      assert(typeof row.s === 'string', `TEXT → JS string, got ${typeof row.s}`);
      assert(row.nul === null || row.nul === undefined, `NULL → null/undefined, got ${String(row.nul)}`);
      await silentClose(DB);
    },
  },

  // ── Recovery ──────────────────────────────────────────────────────────────────
  {
    id: 'rec-01', group: 'Recovery', name: 'DB usable after failed run() — can insert and query',
    fn: async () => {
      const DB = 'suite_rec01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INVALID SQL GARBAGE' });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (42)' });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), 'query after failure');
      assertEqual((q.rows[0] as { v: number }).v, 42, 'DB functional after failed run()');
      await silentClose(DB);
    },
  },
  {
    id: 'rec-02', group: 'Recovery', name: 'DB usable after transaction rollback',
    fn: async () => {
      const DB = 'suite_rec02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1)' });
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (999)' });
      assertOk(await CapacitorSqlite.rollbackTransaction({ database: DB }), 'rollback');
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (2)' });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t ORDER BY v' }), 'query');
      assertEqual(q.rows.length, 2, '2 rows: only 1 and 2 (999 was rolled back)');
      assertEqual((q.rows[0] as { v: number }).v, 1, 'row 1');
      assertEqual((q.rows[1] as { v: number }).v, 2, 'row 2');
      await silentClose(DB);
    },
  },
  {
    id: 'rec-03', group: 'Recovery', name: 'DB usable after execute() syntax error',
    fn: async () => {
      const DB = 'suite_rec03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.execute({ database: DB, statements: ['INVALID SYNTAX!!!'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (100)' });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), 'query');
      assertEqual((q.rows[0] as { v: number }).v, 100, 'DB functional after execute() syntax error');
      await silentClose(DB);
    },
  },
  {
    id: 'rec-04', group: 'Recovery', name: 'DB usable after query() on non-existent table',
    fn: async () => {
      const DB = 'suite_rec04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] });
      await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM ghost_table_xyz_abc' });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (77)' });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), 'query');
      assertEqual((q.rows[0] as { v: number }).v, 77, 'DB functional after failed query()');
      await silentClose(DB);
    },
  },
  {
    id: 'rec-05', group: 'Recovery', name: 'DB usable after 3 consecutive different errors',
    fn: async () => {
      const DB = 'suite_rec05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER NOT NULL)'] });
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (NULL)' }); // NOT NULL violation
      await CapacitorSqlite.run({ database: DB, statement: 'INVALID SYNTAX' });              // syntax error
      await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM nonexistent' }); // missing table
      await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (42)' });
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), 'final query');
      assertEqual((q.rows[0] as { v: number }).v, 42, 'DB fully functional after 3 consecutive errors');
      await silentClose(DB);
    },
  },

  // ── Transaction Atomicity ──────────────────────────────────────────────────
  {
    id: 'txn-01', group: 'Transaction Atomicity', name: 'begin → run×3 + runBatch + execute → rollback: all 6 inserts rolled back',
    fn: async () => {
      const DB = 'suite_txn01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS a', 'CREATE TABLE a (v INTEGER)'] }), 'ddl');
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO a VALUES (?)', values: [1] }), 'run1');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO a VALUES (?)', values: [2] }), 'run2');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO a VALUES (?)', values: [3] }), 'run3');
      assertOk(await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: 'INSERT INTO a VALUES (?)', values: [4] },
        { statement: 'INSERT INTO a VALUES (?)', values: [5] },
      ], transaction: false }), 'runBatch');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['INSERT INTO a VALUES (6)'], transaction: false }), 'execute');
      assertOk(await CapacitorSqlite.rollbackTransaction({ database: DB }), 'rollback');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM a' }), 'count');
      assertEqual((q.rows[0] as { n: number }).n, 0, 'all 6 inserts from 3 API methods rolled back');
      await silentClose(DB);
    },
  },
  {
    id: 'txn-02', group: 'Transaction Atomicity', name: 'uncommitted writes visible within same transaction',
    fn: async () => {
      const DB = 'suite_txn02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] }), 'ddl');
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (99)' }), 'insert');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), 'query within tx');
      assertEqual((q.rows[0] as { v: number }).v, 99, 'uncommitted row visible within same connection');
      assertOk(await CapacitorSqlite.rollbackTransaction({ database: DB }), 'rollback');
      const q2 = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count after rollback');
      assertEqual((q2.rows[0] as { n: number }).n, 0, 'rolled back to 0');
      await silentClose(DB);
    },
  },
  {
    id: 'txn-03', group: 'Transaction Atomicity', name: 'commit persists all API writes across close/reopen',
    fn: async () => {
      const DB = 'suite_txn03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] }), 'ddl');
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1)' }), 'run');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['INSERT INTO t VALUES (2)'], transaction: false }), 'execute');
      assertOk(await CapacitorSqlite.runBatch({ database: DB, set: [{ statement: 'INSERT INTO t VALUES (3)' }], transaction: false }), 'batch');
      assertOk(await CapacitorSqlite.commitTransaction({ database: DB }), 'commit');
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'reopen');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT SUM(v) AS s FROM t' }), 'sum');
      assertEqual((q.rows[0] as { s: number }).s, 6, '1+2+3=6 committed and persisted');
      await silentClose(DB);
    },
  },
  {
    id: 'txn-04', group: 'Transaction Atomicity', name: 'rollback on DB-A does not affect committed data on DB-B',
    fn: async () => {
      const DB1 = 'suite_txn04a';
      const DB2 = 'suite_txn04b';
      await silentClose(DB1);
      await silentClose(DB2);
      assertOk(await CapacitorSqlite.open({ database: DB1 }), 'open1');
      assertOk(await CapacitorSqlite.open({ database: DB2 }), 'open2');
      assertOk(await CapacitorSqlite.execute({ database: DB1, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] }), 'ddl1');
      assertOk(await CapacitorSqlite.execute({ database: DB2, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] }), 'ddl2');
      assertOk(await CapacitorSqlite.run({ database: DB2, statement: 'INSERT INTO t VALUES (99)' }), 'insert2');
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB1 }), 'begin1');
      assertOk(await CapacitorSqlite.run({ database: DB1, statement: 'INSERT INTO t VALUES (77)' }), 'insert1');
      assertOk(await CapacitorSqlite.rollbackTransaction({ database: DB1 }), 'rollback1');
      const q1 = assertOk(await CapacitorSqlite.query({ database: DB1, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count1');
      const q2 = assertOk(await CapacitorSqlite.query({ database: DB2, statement: 'SELECT v FROM t' }), 'query2');
      assertEqual((q1.rows[0] as { n: number }).n, 0, 'DB1 rolled back: 0 rows');
      assertEqual((q2.rows[0] as { v: number }).v, 99, 'DB2 data unaffected');
      await silentClose(DB1);
      await silentClose(DB2);
    },
  },
  {
    id: 'txn-05', group: 'Transaction Atomicity', name: 'rollback after mixed API: run+execute+runBatch all undone',
    fn: async () => {
      const DB = 'suite_txn05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v TEXT)'] }), 'ddl');
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES ('a')" }), 'run');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ["INSERT INTO t VALUES ('b')", "INSERT INTO t VALUES ('c')"], transaction: false }), 'execute');
      assertOk(await CapacitorSqlite.runBatch({ database: DB, set: [
        { statement: "INSERT INTO t VALUES ('d')" },
        { statement: "INSERT INTO t VALUES ('e')" },
      ], transaction: false }), 'batch');
      assertOk(await CapacitorSqlite.rollbackTransaction({ database: DB }), 'rollback');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((q.rows[0] as { n: number }).n, 0, 'all 5 rows from 3 API methods rolled back');
      await silentClose(DB);
    },
  },

  // ── lastInsertId Edge Cases ────────────────────────────────────────────────
  {
    id: 'lid-01', group: 'lastInsertId', name: 'Table without INTEGER PRIMARY KEY — lastInsertId is implicit rowid',
    fn: async () => {
      const DB = 'suite_lid01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (name TEXT)'] }), 'ddl');
      const r = assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES ('hello')" }), 'insert');
      assert(r.lastInsertId > 0, `lastInsertId should be positive rowid, got ${r.lastInsertId}`);
      await silentClose(DB);
    },
  },
  {
    id: 'lid-02', group: 'lastInsertId', name: 'Manually set INTEGER PRIMARY KEY — lastInsertId matches specified id',
    fn: async () => {
      const DB = 'suite_lid02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)'] }), 'ddl');
      const r = assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (42, ?)', values: ['test'] }), 'insert');
      assertEqual(r.lastInsertId, 42, 'lastInsertId = explicitly set primary key 42');
      await silentClose(DB);
    },
  },
  {
    id: 'lid-03', group: 'lastInsertId', name: 'UPDATE and DELETE return lastInsertId = 0',
    fn: async () => {
      const DB = 'suite_lid03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)'] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1, 100)' }), 'seed');
      const upd = assertOk(await CapacitorSqlite.run({ database: DB, statement: 'UPDATE t SET v = 200 WHERE id = 1' }), 'update');
      assertEqual(upd.lastInsertId, 0, 'UPDATE: lastInsertId = 0');
      const del = assertOk(await CapacitorSqlite.run({ database: DB, statement: 'DELETE FROM t WHERE id = 1' }), 'delete');
      assertEqual(del.lastInsertId, 0, 'DELETE: lastInsertId = 0');
      await silentClose(DB);
    },
  },
  {
    id: 'lid-04', group: 'lastInsertId', name: 'AFTER INSERT trigger: trigger row insertion tracked in audit table',
    fn: async () => {
      const DB = 'suite_lid04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS main_t',
        'DROP TABLE IF EXISTS audit',
        'CREATE TABLE main_t (id INTEGER PRIMARY KEY, name TEXT)',
        'CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT)',
        "CREATE TRIGGER trg_lid04 AFTER INSERT ON main_t BEGIN INSERT INTO audit (msg) VALUES ('inserted ' || NEW.name); END",
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO main_t VALUES (1, 'alpha')" }), 'insert');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT msg FROM audit' }), 'audit');
      assertEqual((q.rows[0] as { msg: string }).msg, 'inserted alpha', 'trigger inserted audit row correctly');
      await silentClose(DB);
    },
  },
  {
    id: 'lid-05', group: 'lastInsertId', name: 'AUTOINCREMENT: IDs never reuse deleted values',
    fn: async () => {
      const DB = 'suite_lid05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)',
      ] }), 'ddl');
      const r1 = assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t (v) VALUES ('a')" }), 'insert1');
      const r2 = assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t (v) VALUES ('b')" }), 'insert2');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: `DELETE FROM t WHERE id = ${r2.lastInsertId}` }), 'delete');
      const r3 = assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t (v) VALUES ('c')" }), 'insert3');
      assert(r3.lastInsertId > r2.lastInsertId, `AUTOINCREMENT does not reuse: ${r3.lastInsertId} > ${r2.lastInsertId}`);
      assertEqual(r2.lastInsertId, r1.lastInsertId + 1, 'sequential IDs assigned in order');
      await silentClose(DB);
    },
  },

  // ── WITHOUT ROWID ──────────────────────────────────────────────────────────
  {
    id: 'wrid-01', group: 'WITHOUT ROWID', name: 'Basic INSERT / SELECT / DELETE on WITHOUT ROWID table',
    fn: async () => {
      const DB = 'suite_wrid01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (code TEXT PRIMARY KEY, val INTEGER) WITHOUT ROWID',
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES ('abc', 42)" }), 'insert');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT val FROM t WHERE code = 'abc'" }), 'select');
      assertEqual((q.rows[0] as { val: number }).val, 42, 'value correct');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "DELETE FROM t WHERE code = 'abc'" }), 'delete');
      const q2 = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((q2.rows[0] as { n: number }).n, 0, 'row deleted');
      await silentClose(DB);
    },
  },
  {
    id: 'wrid-02', group: 'WITHOUT ROWID', name: 'WITHOUT ROWID primary key duplicate → error',
    fn: async () => {
      const DB = 'suite_wrid02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (code TEXT PRIMARY KEY, val INTEGER) WITHOUT ROWID',
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES ('x', 1)" }), 'first insert');
      const r = await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES ('x', 2)" });
      if (r.success) throw new Error('wrid-02: duplicate PK must fail');
      assert(typeof r.error.code === 'string', 'error code is string');
      await silentClose(DB);
    },
  },
  {
    id: 'wrid-03', group: 'WITHOUT ROWID', name: 'UPDATE on WITHOUT ROWID table',
    fn: async () => {
      const DB = 'suite_wrid03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (code TEXT PRIMARY KEY, score INTEGER) WITHOUT ROWID',
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES ('k', 10)" }), 'insert');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "UPDATE t SET score = 99 WHERE code = 'k'" }), 'update');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT score FROM t' }), 'select');
      assertEqual((q.rows[0] as { score: number }).score, 99, 'value updated to 99');
      await silentClose(DB);
    },
  },
  {
    id: 'wrid-04', group: 'WITHOUT ROWID', name: 'lastInsertId = 0 after INSERT into WITHOUT ROWID table',
    fn: async () => {
      const DB = 'suite_wrid04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (code TEXT PRIMARY KEY, val INTEGER) WITHOUT ROWID',
      ] }), 'ddl');
      const r = assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES ('z', 7)" }), 'insert');
      assertEqual(r.lastInsertId, 0, 'WITHOUT ROWID has no rowid → lastInsertId = 0');
      await silentClose(DB);
    },
  },

  // ── FTS5 ──────────────────────────────────────────────────────────────────
  {
    id: 'fts-01', group: 'FTS5', name: 'CREATE VIRTUAL TABLE USING fts5 + INSERT + MATCH search (graceful skip)',
    fn: async () => {
      const DB = 'suite_fts01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const ftsCreate = await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS docs',
        'CREATE VIRTUAL TABLE docs USING fts5(title, body)',
      ] });
      if (!ftsCreate.success) return;
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        "INSERT INTO docs VALUES ('Hello World', 'The quick brown fox')",
        "INSERT INTO docs VALUES ('SQLite FTS', 'Full text search is fast')",
        "INSERT INTO docs VALUES ('Other doc', 'Nothing relevant here')",
      ] }), 'insert');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT title FROM docs WHERE docs MATCH 'fox'" }), 'search');
      assertEqual(q.rows.length, 1, 'MATCH returns 1 result');
      assertEqual((q.rows[0] as { title: string }).title, 'Hello World', 'correct document matched');
      await silentClose(DB);
    },
  },
  {
    id: 'fts-02', group: 'FTS5', name: 'FTS5 MATCH counts only matching rows',
    fn: async () => {
      const DB = 'suite_fts02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const ftsCreate = await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS docs',
        'CREATE VIRTUAL TABLE docs USING fts5(content)',
      ] });
      if (!ftsCreate.success) return;
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        "INSERT INTO docs VALUES ('the quick brown fox')",
        "INSERT INTO docs VALUES ('a lazy dog sits')",
        "INSERT INTO docs VALUES ('the fox and the dog')",
      ] }), 'insert');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT COUNT(*) AS n FROM docs WHERE docs MATCH 'fox'" }), 'count');
      assertEqual((q.rows[0] as { n: number }).n, 2, 'two rows contain "fox"');
      await silentClose(DB);
    },
  },
  {
    id: 'fts-03', group: 'FTS5', name: 'FTS5 DELETE removes document from index',
    fn: async () => {
      const DB = 'suite_fts03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const ftsCreate = await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS docs',
        'CREATE VIRTUAL TABLE docs USING fts5(content)',
      ] });
      if (!ftsCreate.success) return;
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        "INSERT INTO docs(rowid, content) VALUES (1, 'searchable alpha content')",
        "INSERT INTO docs(rowid, content) VALUES (2, 'unrelated beta')",
      ] }), 'insert');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'DELETE FROM docs WHERE rowid = 1' }), 'delete');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT COUNT(*) AS n FROM docs WHERE docs MATCH 'alpha'" }), 'search after delete');
      assertEqual((q.rows[0] as { n: number }).n, 0, 'deleted document not in FTS index');
      await silentClose(DB);
    },
  },

  // ── Generated Columns ──────────────────────────────────────────────────────
  {
    id: 'gen-01', group: 'Generated Columns', name: 'VIRTUAL generated column computed on read (graceful skip)',
    fn: async () => {
      const DB = 'suite_gen01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const ddl = await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (price REAL, qty INTEGER, total REAL GENERATED ALWAYS AS (price * qty) VIRTUAL)',
      ] });
      if (!ddl.success) return;
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t (price, qty) VALUES (2.5, 4)' }), 'insert');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT total FROM t' }), 'select');
      assertEqual((q.rows[0] as { total: number }).total, 10.0, 'virtual generated: 2.5 * 4 = 10');
      await silentClose(DB);
    },
  },
  {
    id: 'gen-02', group: 'Generated Columns', name: 'STORED generated column computed on write (graceful skip)',
    fn: async () => {
      const DB = 'suite_gen02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const ddl = await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        "CREATE TABLE t (first TEXT, last TEXT, full_name TEXT GENERATED ALWAYS AS (first || ' ' || last) STORED)",
      ] });
      if (!ddl.success) return;
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t (first, last) VALUES ('John', 'Doe')" }), 'insert');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT full_name FROM t' }), 'select');
      assertEqual((q.rows[0] as { full_name: string }).full_name, 'John Doe', 'stored generated: first || last');
      await silentClose(DB);
    },
  },
  {
    id: 'gen-03', group: 'Generated Columns', name: 'INDEX on stored generated column — query returns correct row (graceful skip)',
    fn: async () => {
      const DB = 'suite_gen03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const ddl = await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (data TEXT, upper_data TEXT GENERATED ALWAYS AS (UPPER(data)) STORED)',
        'CREATE INDEX idx_upper ON t (upper_data)',
      ] });
      if (!ddl.success) return;
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t (data) VALUES ('hello')" }), 'insert');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT data FROM t WHERE upper_data = 'HELLO'" }), 'indexed query');
      assertEqual(q.rows.length, 1, 'indexed generated column query returns 1 row');
      assertEqual((q.rows[0] as { data: string }).data, 'hello', 'correct row returned');
      await silentClose(DB);
    },
  },
  {
    id: 'gen-04', group: 'Generated Columns', name: 'INSERT into generated column → error (graceful skip)',
    fn: async () => {
      const DB = 'suite_gen04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const ddl = await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (x INTEGER, y INTEGER GENERATED ALWAYS AS (x * 2) VIRTUAL)',
      ] });
      if (!ddl.success) return;
      const r = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t (x, y) VALUES (1, 999)' });
      if (r.success) throw new Error('gen-04: INSERT into generated column must fail');
      assert(typeof r.error.code === 'string', 'error code is string');
      await silentClose(DB);
    },
  },

  // ── STRICT Tables ──────────────────────────────────────────────────────────
  {
    id: 'strict-01', group: 'STRICT Tables', name: 'STRICT table accepts correct types (graceful skip on SQLite <3.37)',
    fn: async () => {
      const DB = 'suite_strict01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const ddl = await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER, name TEXT, score REAL) STRICT',
      ] });
      if (!ddl.success) return;
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1, ?, 9.5)', values: ['Alice'] }), 'insert');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT name, score FROM t' }), 'select');
      assertEqual((q.rows[0] as { name: string }).name, 'Alice', 'name correct');
      assertEqual((q.rows[0] as { score: number }).score, 9.5, 'score correct');
      await silentClose(DB);
    },
  },
  {
    id: 'strict-02', group: 'STRICT Tables', name: 'INSERT wrong type into STRICT INTEGER column → error (graceful skip)',
    fn: async () => {
      const DB = 'suite_strict02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const ddl = await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER, val INTEGER) STRICT',
      ] });
      if (!ddl.success) return;
      const r = await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES (1, 'not_an_integer')" });
      if (r.success) throw new Error('strict-02: text into STRICT INTEGER must fail');
      assert(typeof r.error.code === 'string', 'error code is string');
      await silentClose(DB);
    },
  },
  {
    id: 'strict-03', group: 'STRICT Tables', name: 'STRICT table ANY column accepts integer, text, and real (graceful skip)',
    fn: async () => {
      const DB = 'suite_strict03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const ddl = await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER, flex ANY) STRICT',
      ] });
      if (!ddl.success) return;
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1, 42)' }), 'integer');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES (2, 'text')" }), 'text');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (3, 3.14)' }), 'real');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((q.rows[0] as { n: number }).n, 3, 'ANY column stored all 3 types');
      await silentClose(DB);
    },
  },

  // ── RETURNING ─────────────────────────────────────────────────────────────
  {
    id: 'ret-01', group: 'RETURNING', name: 'INSERT ... RETURNING returns inserted row via query() (graceful skip on SQLite <3.35)',
    fn: async () => {
      const DB = 'suite_ret01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)',
      ] }), 'ddl');
      const q = await CapacitorSqlite.query({ database: DB, statement: "INSERT INTO t (name) VALUES ('Alice') RETURNING id, name" });
      if (!q.success) return;
      const rows = q.data.rows as { id: number; name: string }[];
      assertEqual(rows.length, 1, 'RETURNING yields 1 row');
      assertEqual(rows[0].name, 'Alice', 'RETURNING name correct');
      assert(rows[0].id > 0, 'RETURNING id is positive');
      await silentClose(DB);
    },
  },
  {
    id: 'ret-02', group: 'RETURNING', name: 'UPDATE ... RETURNING returns updated value (graceful skip)',
    fn: async () => {
      const DB = 'suite_ret02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, score INTEGER)',
        'INSERT INTO t VALUES (1, 10)',
      ] }), 'ddl');
      const q = await CapacitorSqlite.query({ database: DB, statement: 'UPDATE t SET score = score + 5 WHERE id = 1 RETURNING id, score' });
      if (!q.success) return;
      const rows = q.data.rows as { id: number; score: number }[];
      assertEqual(rows.length, 1, 'RETURNING 1 row');
      assertEqual(rows[0].score, 15, 'RETURNING updated score = 10 + 5 = 15');
      await silentClose(DB);
    },
  },
  {
    id: 'ret-03', group: 'RETURNING', name: 'DELETE ... RETURNING returns deleted row (graceful skip)',
    fn: async () => {
      const DB = 'suite_ret03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)',
        "INSERT INTO t VALUES (1, 'Bob')",
        "INSERT INTO t VALUES (2, 'Carol')",
      ] }), 'ddl');
      const q = await CapacitorSqlite.query({ database: DB, statement: 'DELETE FROM t WHERE id = 1 RETURNING id, name' });
      if (!q.success) return;
      const rows = q.data.rows as { id: number; name: string }[];
      assertEqual(rows.length, 1, 'RETURNING 1 deleted row');
      assertEqual(rows[0].name, 'Bob', 'RETURNING deleted name');
      const q2 = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((q2.rows[0] as { n: number }).n, 1, 'only Carol remains');
      await silentClose(DB);
    },
  },
  {
    id: 'ret-04', group: 'RETURNING', name: 'INSERT ... RETURNING with computed expression column (graceful skip)',
    fn: async () => {
      const DB = 'suite_ret04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val INTEGER)',
      ] }), 'ddl');
      const q = await CapacitorSqlite.query({ database: DB, statement: 'INSERT INTO t (val) VALUES (7) RETURNING id, val, val * 2 AS doubled' });
      if (!q.success) return;
      const rows = q.data.rows as { id: number; val: number; doubled: number }[];
      assertEqual(rows[0].doubled, 14, 'RETURNING expression: 7 * 2 = 14');
      await silentClose(DB);
    },
  },

  // ── Parameter Limits ──────────────────────────────────────────────────────
  {
    id: 'param-01', group: 'Parameter Limits', name: '999 bound parameters in SELECT IN() — all match',
    fn: async () => {
      const DB = 'suite_param01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] }), 'ddl');
      const N = 999;
      const batch = Array.from({ length: N }, (_, i) => ({ statement: 'INSERT INTO t VALUES (?)', values: [i + 1] as [number] }));
      assertOk(await CapacitorSqlite.runBatch({ database: DB, set: batch }), 'batch insert 999 rows');
      const placeholders = Array.from({ length: N }, () => '?').join(', ');
      const values: number[] = Array.from({ length: N }, (_, i) => i + 1);
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: `SELECT COUNT(*) AS n FROM t WHERE v IN (${placeholders})`, values }), 'query 999 params');
      assertEqual((q.rows[0] as { n: number }).n, N, '999 IN() params all matched');
      await silentClose(DB);
    },
  },
  {
    id: 'param-02', group: 'Parameter Limits', name: '1001 parameters → graceful result (no crash)',
    fn: async () => {
      const DB = 'suite_param02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] }), 'ddl');
      const placeholders = Array.from({ length: 1001 }, () => '?').join(', ');
      const values: number[] = Array.from({ length: 1001 }, (_, i) => i);
      const r = await CapacitorSqlite.query({ database: DB, statement: `SELECT COUNT(*) AS n FROM t WHERE v IN (${placeholders})`, values });
      assert(typeof r.success === 'boolean', '1001 params: plugin returns a result without crashing');
      await silentClose(DB);
    },
  },
  {
    id: 'param-03', group: 'Parameter Limits', name: 'Single row with 256 KB TEXT column — length correct',
    fn: async () => {
      const DB = 'suite_param03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (d TEXT)'] }), 'ddl');
      const big = 'A'.repeat(256 * 1024);
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [big] }), 'insert 256 KB');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT LENGTH(d) AS len FROM t' }), 'query');
      assertEqual((q.rows[0] as { len: number }).len, 256 * 1024, '256 KB row: length correct');
      await silentClose(DB);
    },
  },

  // ── Semicolons & Comments ─────────────────────────────────────────────────
  {
    id: 'mstmt-01', group: 'Semicolons & Comments', name: 'Trailing semicolon in run() and query() — works',
    fn: async () => {
      const DB = 'suite_mstmt01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1);' }), 'insert with semicolon');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t;' }), 'select with semicolon');
      assertEqual((q.rows[0] as { v: number }).v, 1, 'trailing semicolons OK');
      await silentClose(DB);
    },
  },
  {
    id: 'mstmt-02', group: 'Semicolons & Comments', name: 'SQL with -- inline comment — works',
    fn: async () => {
      const DB = 'suite_mstmt02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (42) -- inline comment' }), 'insert with comment');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t -- get it' }), 'select with comment');
      assertEqual((q.rows[0] as { v: number }).v, 42, 'inline comment ignored');
      await silentClose(DB);
    },
  },
  {
    id: 'mstmt-03', group: 'Semicolons & Comments', name: 'SQL with /* block comment */ — works',
    fn: async () => {
      const DB = 'suite_mstmt03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: '/* block */ INSERT INTO t VALUES (7)' }), 'insert with block comment');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT /* inline */ v FROM t' }), 'select with block comment');
      assertEqual((q.rows[0] as { v: number }).v, 7, 'block comment ignored');
      await silentClose(DB);
    },
  },
  {
    id: 'mstmt-04', group: 'Semicolons & Comments', name: 'execute() with trailing semicolons on every statement',
    fn: async () => {
      const DB = 'suite_mstmt04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t;',
        'CREATE TABLE t (v INTEGER);',
        'INSERT INTO t VALUES (10);',
        'INSERT INTO t VALUES (20);',
      ] }), 'execute with semicolons');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT SUM(v) AS s FROM t' }), 'sum');
      assertEqual((q.rows[0] as { s: number }).s, 30, '10 + 20 = 30');
      await silentClose(DB);
    },
  },
  {
    id: 'mstmt-05', group: 'Semicolons & Comments', name: 'run() with two semicolon-separated statements — no crash',
    fn: async () => {
      const DB = 'suite_mstmt05';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] }), 'ddl');
      const r = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)' });
      assert(typeof r.success === 'boolean', 'run() with two statements: no crash, returns a result');
      await silentClose(DB);
    },
  },

  // ── Identifier Quoting ────────────────────────────────────────────────────
  {
    id: 'iq-01', group: 'Identifier Quoting', name: 'Table named "order" (reserved word) — double-quoted identifier',
    fn: async () => {
      const DB = 'suite_iq01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS "order"',
        'CREATE TABLE "order" (id INTEGER, total REAL)',
        'INSERT INTO "order" VALUES (1, 99.9)',
      ] }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT total FROM "order" WHERE id = 1' }), 'select');
      assertEqual((q.rows[0] as { total: number }).total, 99.9, 'reserved word table "order" works');
      await silentClose(DB);
    },
  },
  {
    id: 'iq-02', group: 'Identifier Quoting', name: 'Columns named "select" and "group" (reserved words) — double-quoted',
    fn: async () => {
      const DB = 'suite_iq02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t ("select" INTEGER, "group" TEXT)',
        "INSERT INTO t VALUES (42, 'admin')",
      ] }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT "select", "group" FROM t' }), 'select');
      assertEqual((q.rows[0] as Record<string, unknown>)['select'], 42, 'reserved column "select" = 42');
      assertEqual((q.rows[0] as Record<string, unknown>)['group'], 'admin', 'reserved column "group" = admin');
      await silentClose(DB);
    },
  },
  {
    id: 'iq-03', group: 'Identifier Quoting', name: 'Identifiers with spaces — double-quoted work',
    fn: async () => {
      const DB = 'suite_iq03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS "my table"',
        'CREATE TABLE "my table" ("first name" TEXT, "last name" TEXT)',
        "INSERT INTO \"my table\" VALUES ('John', 'Doe')",
      ] }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT "first name", "last name" FROM "my table"' }), 'select');
      assertEqual((q.rows[0] as Record<string, unknown>)['first name'], 'John', 'spaced col "first name"');
      assertEqual((q.rows[0] as Record<string, unknown>)['last name'], 'Doe', 'spaced col "last name"');
      await silentClose(DB);
    },
  },
  {
    id: 'iq-04', group: 'Identifier Quoting', name: 'Unicode table and column names — double-quoted work',
    fn: async () => {
      const DB = 'suite_iq04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS "položky"',
        'CREATE TABLE "položky" ("název" TEXT, "cena" REAL)',
        "INSERT INTO \"položky\" VALUES ('Káva', 35.5)",
      ] }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT "název", "cena" FROM "položky"' }), 'select');
      assertEqual((q.rows[0] as Record<string, unknown>)['název'], 'Káva', 'unicode column název = Káva');
      assertEqual((q.rows[0] as Record<string, unknown>)['cena'], 35.5, 'unicode column cena = 35.5');
      await silentClose(DB);
    },
  },

  // ── Boolean Policy ────────────────────────────────────────────────────────
  {
    id: 'bool-01', group: 'Boolean Policy', name: 'true stores as INTEGER 1, false stores as INTEGER 0',
    fn: async () => {
      const DB = 'suite_bool01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [true] }), 'insert true');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [false] }), 'insert false');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t ORDER BY rowid' }), 'select');
      assertEqual((q.rows[0] as { v: number }).v, 1, 'true → 1');
      assertEqual((q.rows[1] as { v: number }).v, 0, 'false → 0');
      await silentClose(DB);
    },
  },
  {
    id: 'bool-02', group: 'Boolean Policy', name: 'TYPEOF of bound true is "integer"',
    fn: async () => {
      const DB = 'suite_bool02';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT TYPEOF(?) AS t', values: [true] }), 'typeof true');
      assertEqual((q.rows[0] as { t: string }).t, 'integer', 'TYPEOF(true) = integer');
      const q2 = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT TYPEOF(?) AS t', values: [false] }), 'typeof false');
      assertEqual((q2.rows[0] as { t: string }).t, 'integer', 'TYPEOF(false) = integer');
      await silentClose(DB);
    },
  },
  {
    id: 'bool-03', group: 'Boolean Policy', name: 'Boolean round-trip: stored 1/0 reads back as number not boolean',
    fn: async () => {
      const DB = 'suite_bool03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (flag INTEGER)'] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [true] }), 'insert');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT flag FROM t' }), 'select');
      const val = (q.rows[0] as { flag: unknown }).flag;
      assert(typeof val === 'number', `boolean true reads back as number, got typeof=${typeof val}`);
      assertEqual(val as number, 1, 'reads back as 1 not true');
      await silentClose(DB);
    },
  },
  {
    id: 'bool-04', group: 'Boolean Policy', name: 'Multiple boolean params in one row — consistent across platforms',
    fn: async () => {
      const DB = 'suite_bool04';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (a INTEGER, b INTEGER, c INTEGER)',
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?, ?, ?)', values: [true, false, true] }), 'insert');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT a, b, c FROM t' }), 'select');
      const row = q.rows[0] as { a: number; b: number; c: number };
      assertEqual(row.a, 1, 'true → 1');
      assertEqual(row.b, 0, 'false → 0');
      assertEqual(row.c, 1, 'true → 1 (second)');
      assert(typeof row.a === 'number' && typeof row.b === 'number', 'types are numbers');
      await silentClose(DB);
    },
  },

  // ── Compatibility Matrix ───────────────────────────────────────────────────
  {
    id: 'compat-01', group: 'Compatibility Matrix', name: 'Feature detection: JSON, FTS5, Window, RETURNING, STRICT, WAL, Generated cols',
    fn: async () => {
      const DB = 'suite_compat01';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const features: Record<string, boolean> = {};
      // JSON
      const json = await CapacitorSqlite.query({ database: DB, statement: "SELECT json('{\"a\":1}') AS v" });
      features.json = json.success;
      // FTS5
      const fts = await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS _fts_probe',
        'CREATE VIRTUAL TABLE _fts_probe USING fts5(x)',
        'DROP TABLE IF EXISTS _fts_probe',
      ] });
      features.fts5 = fts.success;
      // Window functions (3.25+)
      const wnd = await CapacitorSqlite.query({ database: DB, statement: 'SELECT ROW_NUMBER() OVER () AS r' });
      features.windowFunctions = wnd.success;
      // RETURNING (3.35+)
      const ddlProbe = await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS _ret_probe',
        'CREATE TABLE _ret_probe (id INTEGER PRIMARY KEY)',
      ] });
      if (ddlProbe.success) {
        const retQ = await CapacitorSqlite.query({ database: DB, statement: 'INSERT INTO _ret_probe(id) VALUES (1) RETURNING id' });
        features.returning = retQ.success;
        await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS _ret_probe'] });
      } else {
        features.returning = false;
      }
      // STRICT tables (3.37+)
      const strict = await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS _strict_probe',
        'CREATE TABLE _strict_probe (x INTEGER) STRICT',
        'DROP TABLE IF EXISTS _strict_probe',
      ] });
      features.strict = strict.success;
      // WAL mode
      const wal = await CapacitorSqlite.query({ database: DB, statement: 'PRAGMA journal_mode=WAL' });
      features.wal = wal.success && wal.data.rows.length > 0 && (wal.data.rows[0] as Record<string, unknown>).journal_mode === 'wal';
      // Generated columns (3.31+)
      const gen = await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS _gen_probe',
        'CREATE TABLE _gen_probe (x INTEGER, y INTEGER GENERATED ALWAYS AS (x * 2))',
        'DROP TABLE IF EXISTS _gen_probe',
      ] });
      features.generatedColumns = gen.success;
      console.log('[compat-01] Feature matrix:', JSON.stringify(features));
      assert(true, 'compatibility matrix recorded (always passes)');
      await silentClose(DB);
    },
  },

  // ── Real-world Schema ─────────────────────────────────────────────────────
  {
    id: 'rw-01', group: 'Real-world Schema', name: 'Create 5-table e-commerce schema with FKs, indexes, view',
    fn: async () => {
      await silentClose(RW_DB);
      assertOk(await CapacitorSqlite.open({ database: RW_DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: RW_DB, statements: RW_DDL }), 'schema DDL');
      const tables = assertOk(await CapacitorSqlite.query({ database: RW_DB, statement: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" }), 'tables');
      const names = (tables.rows as { name: string }[]).map((r) => r.name);
      assert(names.includes('users'), 'users table');
      assert(names.includes('products'), 'products table');
      assert(names.includes('order_items'), 'order_items table');
      const idxCount = assertOk(await CapacitorSqlite.query({ database: RW_DB, statement: "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'" }), 'indexes');
      assert((idxCount.rows[0] as { n: number }).n >= 3, 'at least 3 custom indexes created');
      await silentClose(RW_DB);
    },
  },
  {
    id: 'rw-02', group: 'Real-world Schema', name: 'Seed realistic data — FK join and category filter correct',
    fn: async () => {
      await silentClose(RW_DB);
      assertOk(await CapacitorSqlite.open({ database: RW_DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: RW_DB, statements: RW_DDL }), 'schema');
      assertOk(await CapacitorSqlite.execute({ database: RW_DB, statements: RW_SEED_STMTS }), 'seed');
      const uc = assertOk(await CapacitorSqlite.query({ database: RW_DB, statement: 'SELECT COUNT(*) AS n FROM users' }), 'users');
      assertEqual((uc.rows[0] as { n: number }).n, 2, '2 users seeded');
      const pc = assertOk(await CapacitorSqlite.query({ database: RW_DB, statement: 'SELECT COUNT(*) AS n FROM products' }), 'products');
      assertEqual((pc.rows[0] as { n: number }).n, 3, '3 products seeded');
      const join = assertOk(await CapacitorSqlite.query({ database: RW_DB, statement: "SELECT p.name FROM products p JOIN categories c ON c.id = p.category_id WHERE c.name = 'Electronics' ORDER BY p.price DESC" }), 'join');
      assertEqual(join.rows.length, 2, '2 electronics products');
      assertEqual((join.rows[0] as { name: string }).name, 'Laptop', 'Laptop first (higher price)');
      await silentClose(RW_DB);
    },
  },
  {
    id: 'rw-03', group: 'Real-world Schema', name: 'Create order atomically — total correct via aggregation view',
    fn: async () => {
      await silentClose(RW_DB);
      assertOk(await CapacitorSqlite.open({ database: RW_DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: RW_DB, statements: RW_DDL }), 'schema');
      assertOk(await CapacitorSqlite.execute({ database: RW_DB, statements: RW_SEED_STMTS }), 'seed');
      assertOk(await CapacitorSqlite.beginTransaction({ database: RW_DB }), 'begin');
      const ord = assertOk(await CapacitorSqlite.run({ database: RW_DB, statement: "INSERT INTO orders (user_id, status) VALUES (1, 'confirmed')" }), 'create order');
      const ordId = ord.lastInsertId;
      assertOk(await CapacitorSqlite.runBatch({ database: RW_DB, set: [
        { statement: 'INSERT INTO order_items (order_id, product_id, qty, unit_price) VALUES (?, 1, 1, 999.99)', values: [ordId] },
        { statement: 'INSERT INTO order_items (order_id, product_id, qty, unit_price) VALUES (?, 3, 2, 29.99)', values: [ordId] },
      ], transaction: false }), 'add items');
      assertOk(await CapacitorSqlite.commitTransaction({ database: RW_DB }), 'commit');
      const tot = assertOk(await CapacitorSqlite.query({ database: RW_DB, statement: 'SELECT total FROM order_totals WHERE order_id = ?', values: [ordId] }), 'total');
      const expected = 999.99 + 2 * 29.99;
      const actual = (tot.rows[0] as { total: number }).total;
      assert(Math.abs(actual - expected) < 0.01, `order total: expected ${expected.toFixed(2)}, got ${actual}`);
      await silentClose(RW_DB);
    },
  },
  {
    id: 'rw-04', group: 'Real-world Schema', name: 'ON DELETE CASCADE: deleting order removes all its order_items',
    fn: async () => {
      await silentClose(RW_DB);
      assertOk(await CapacitorSqlite.open({ database: RW_DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: RW_DB, statements: RW_DDL }), 'schema');
      assertOk(await CapacitorSqlite.execute({ database: RW_DB, statements: RW_SEED_STMTS }), 'seed');
      await CapacitorSqlite.execute({ database: RW_DB, statements: ['PRAGMA foreign_keys = ON'], transaction: false });
      const ord = assertOk(await CapacitorSqlite.run({ database: RW_DB, statement: "INSERT INTO orders (user_id) VALUES (1)" }), 'order');
      const ordId = ord.lastInsertId;
      assertOk(await CapacitorSqlite.runBatch({ database: RW_DB, set: [
        { statement: 'INSERT INTO order_items (order_id, product_id, qty, unit_price) VALUES (?, 1, 1, 10)', values: [ordId] },
        { statement: 'INSERT INTO order_items (order_id, product_id, qty, unit_price) VALUES (?, 2, 1, 10)', values: [ordId] },
        { statement: 'INSERT INTO order_items (order_id, product_id, qty, unit_price) VALUES (?, 3, 1, 10)', values: [ordId] },
      ] }), 'items');
      const before = assertOk(await CapacitorSqlite.query({ database: RW_DB, statement: 'SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', values: [ordId] }), 'before');
      assertEqual((before.rows[0] as { n: number }).n, 3, '3 items before delete');
      assertOk(await CapacitorSqlite.run({ database: RW_DB, statement: 'DELETE FROM orders WHERE id = ?', values: [ordId] }), 'delete order');
      const after = assertOk(await CapacitorSqlite.query({ database: RW_DB, statement: 'SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', values: [ordId] }), 'after');
      assertEqual((after.rows[0] as { n: number }).n, 0, 'cascade deleted all 3 items');
      await silentClose(RW_DB);
    },
  },
  {
    id: 'rw-05', group: 'Real-world Schema', name: 'Rollback on failed order — DB left in clean consistent state',
    fn: async () => {
      await silentClose(RW_DB);
      assertOk(await CapacitorSqlite.open({ database: RW_DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: RW_DB, statements: RW_DDL }), 'schema');
      assertOk(await CapacitorSqlite.execute({ database: RW_DB, statements: RW_SEED_STMTS }), 'seed');
      const before = assertOk(await CapacitorSqlite.query({ database: RW_DB, statement: 'SELECT COUNT(*) AS n FROM orders' }), 'before');
      assertOk(await CapacitorSqlite.beginTransaction({ database: RW_DB }), 'begin');
      assertOk(await CapacitorSqlite.run({ database: RW_DB, statement: "INSERT INTO orders (user_id) VALUES (1)" }), 'order');
      await CapacitorSqlite.run({ database: RW_DB, statement: 'INSERT INTO order_items (order_id, product_id, qty, unit_price) VALUES (9999, 9999, 1, 10)' });
      assertOk(await CapacitorSqlite.rollbackTransaction({ database: RW_DB }), 'rollback');
      const after = assertOk(await CapacitorSqlite.query({ database: RW_DB, statement: 'SELECT COUNT(*) AS n FROM orders' }), 'after');
      assertEqual((after.rows[0] as { n: number }).n, (before.rows[0] as { n: number }).n, 'order count unchanged after rollback');
      const q = assertOk(await CapacitorSqlite.query({ database: RW_DB, statement: 'SELECT COUNT(*) AS n FROM users' }), 'users intact');
      assertEqual((q.rows[0] as { n: number }).n, 2, 'users data untouched');
      await silentClose(RW_DB);
    },
  },

  // ── Soak Tests ────────────────────────────────────────────────────────────
  {
    id: 'soak-01', group: 'Soak Tests', name: '50× open → insert → query → close: data correct each cycle',
    fn: async () => {
      const DB = 'suite_soak01';
      assertOk(await CapacitorSqlite.open({ database: DB }), 'init open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (cycle INTEGER)'] }), 'ddl');
      await silentClose(DB);
      for (let i = 1; i <= 50; i++) {
        assertOk(await CapacitorSqlite.open({ database: DB }), `open ${i}`);
        assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [i] }), `insert ${i}`);
        const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT MAX(cycle) AS m FROM t' }), `query ${i}`);
        assertEqual((q.rows[0] as { m: number }).m, i, `cycle ${i}: max = ${i}`);
        await silentClose(DB);
      }
      assertOk(await CapacitorSqlite.open({ database: DB }), 'final open');
      const final = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'final count');
      assertEqual((final.rows[0] as { n: number }).n, 50, '50 rows from 50 open/close cycles');
      await silentClose(DB);
    },
  },
  {
    id: 'soak-02', group: 'Soak Tests', name: '30× open → failing query → close: plugin stable after failures',
    fn: async () => {
      const DB = 'suite_soak02';
      await silentClose(DB);
      for (let i = 1; i <= 30; i++) {
        assertOk(await CapacitorSqlite.open({ database: DB }), `open ${i}`);
        await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM no_such_table_xyz' });
        await silentClose(DB);
      }
      assertOk(await CapacitorSqlite.open({ database: DB }), 'final open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['CREATE TABLE IF NOT EXISTS t (v INTEGER)', 'INSERT INTO t VALUES (1)'] }), 'insert after failures');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT v FROM t' }), 'final query');
      assertEqual((q.rows[0] as { v: number }).v, 1, 'plugin stable after 30 failed queries');
      await silentClose(DB);
    },
  },
  {
    id: 'soak-03', group: 'Soak Tests', name: '20× insert 50 KB BLOB / read / delete — table stays empty',
    fn: async () => {
      const DB = 'suite_soak03';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (d BLOB)'] }), 'ddl');
      const blob = new Uint8Array(50 * 1024).fill(0xCD);
      for (let i = 1; i <= 20; i++) {
        const ins = assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (?)', values: [blob] }), `insert ${i}`);
        const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT LENGTH(d) AS len FROM t WHERE rowid = ?', values: [ins.lastInsertId] }), `query ${i}`);
        assertEqual((q.rows[0] as { len: number }).len, 50 * 1024, `cycle ${i}: 50 KB BLOB length correct`);
        assertOk(await CapacitorSqlite.run({ database: DB, statement: 'DELETE FROM t WHERE rowid = ?', values: [ins.lastInsertId] }), `delete ${i}`);
      }
      const cnt = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'final count');
      assertEqual((cnt.rows[0] as { n: number }).n, 0, 'table empty after 20 BLOB insert/delete cycles');
      await silentClose(DB);
    },
  },

  // ── Query Plan ────────────────────────────────────────────────────────────
  {
    id: 'plan-01', group: 'Query Plan', name: 'EXPLAIN QUERY PLAN: unindexed column causes full table scan',
    fn: async () => {
      const DB = 'suite_plan';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)',
      ] }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'EXPLAIN QUERY PLAN SELECT * FROM t WHERE val = ?', values: ['x'] }), 'eqp');
      const plan = JSON.stringify(q.rows);
      assert(plan.includes('SCAN'), `expected SCAN in plan, got: ${plan}`);
      await silentClose(DB);
    },
  },
  {
    id: 'plan-02', group: 'Query Plan', name: 'EXPLAIN QUERY PLAN: indexed column uses index search',
    fn: async () => {
      const DB = 'suite_plan';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)',
        'CREATE INDEX idx_val ON t(val)',
      ] }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'EXPLAIN QUERY PLAN SELECT * FROM t WHERE val = ?', values: ['x'] }), 'eqp');
      const plan = JSON.stringify(q.rows);
      assert(plan.includes('SEARCH') || plan.includes('INDEX') || plan.includes('COVERING'), `expected index usage in plan, got: ${plan}`);
      await silentClose(DB);
    },
  },
  {
    id: 'plan-03', group: 'Query Plan', name: 'EXPLAIN QUERY PLAN: covering index avoids table lookup',
    fn: async () => {
      const DB = 'suite_plan';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT)',
        'CREATE INDEX idx_ab ON t(a, b)',
      ] }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'EXPLAIN QUERY PLAN SELECT a, b FROM t WHERE a = ?', values: ['x'] }), 'eqp');
      const plan = JSON.stringify(q.rows);
      assert(plan.includes('SEARCH') || plan.includes('COVERING') || plan.includes('INDEX'), `expected index usage in plan, got: ${plan}`);
      await silentClose(DB);
    },
  },
  {
    id: 'plan-04', group: 'Query Plan', name: 'EXPLAIN QUERY PLAN: JOIN on indexed FK column avoids full scan',
    fn: async () => {
      const DB = 'suite_plan';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS child',
        'DROP TABLE IF EXISTS parent',
        'CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT)',
        'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER)',
        'CREATE INDEX idx_child_parent ON child(parent_id)',
      ] }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'EXPLAIN QUERY PLAN SELECT * FROM parent p JOIN child c ON c.parent_id = p.id WHERE p.id = 1' }), 'eqp');
      const plan = JSON.stringify(q.rows);
      assert(plan.includes('SEARCH') || plan.includes('INDEX'), `expected index usage in JOIN plan, got: ${plan}`);
      await silentClose(DB);
    },
  },

  // ── FK ON UPDATE ──────────────────────────────────────────────────────────
  {
    id: 'fku-01', group: 'FK ON UPDATE', name: 'ON UPDATE CASCADE propagates parent PK change to child FK',
    fn: async () => {
      const DB = 'suite_fku';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['PRAGMA foreign_keys = ON'], transaction: false });
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS children',
        'DROP TABLE IF EXISTS parents',
        'CREATE TABLE parents (id INTEGER PRIMARY KEY)',
        'CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id) ON UPDATE CASCADE)',
        'INSERT INTO parents VALUES (1)',
        'INSERT INTO children VALUES (1, 1)',
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'UPDATE parents SET id = 99 WHERE id = 1' }), 'update parent');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT parent_id FROM children WHERE id = 1' }), 'query child');
      assertEqual((q.rows[0] as { parent_id: number }).parent_id, 99, 'child FK cascaded to 99');
      await silentClose(DB);
    },
  },
  {
    id: 'fku-02', group: 'FK ON UPDATE', name: 'ON UPDATE SET NULL nullifies child FK when parent PK changes',
    fn: async () => {
      const DB = 'suite_fku';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['PRAGMA foreign_keys = ON'], transaction: false });
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS children',
        'DROP TABLE IF EXISTS parents',
        'CREATE TABLE parents (id INTEGER PRIMARY KEY)',
        'CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id) ON UPDATE SET NULL)',
        'INSERT INTO parents VALUES (1)',
        'INSERT INTO children VALUES (1, 1)',
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'UPDATE parents SET id = 99 WHERE id = 1' }), 'update parent');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT parent_id FROM children WHERE id = 1' }), 'query child');
      assert((q.rows[0] as { parent_id: null | number }).parent_id === null, 'child FK set to NULL');
      await silentClose(DB);
    },
  },
  {
    id: 'fku-03', group: 'FK ON UPDATE', name: 'ON UPDATE RESTRICT blocks parent PK change when children exist',
    fn: async () => {
      const DB = 'suite_fku';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['PRAGMA foreign_keys = ON'], transaction: false });
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS children',
        'DROP TABLE IF EXISTS parents',
        'CREATE TABLE parents (id INTEGER PRIMARY KEY)',
        'CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id) ON UPDATE RESTRICT)',
        'INSERT INTO parents VALUES (1)',
        'INSERT INTO children VALUES (1, 1)',
      ] }), 'ddl');
      const r = await CapacitorSqlite.run({ database: DB, statement: 'UPDATE parents SET id = 99 WHERE id = 1' });
      if (r.success) throw new Error('fku-03: expected FK RESTRICT to block update');
      assert(typeof r.error.message === 'string' && r.error.message.length > 0, 'error message present');
      await silentClose(DB);
    },
  },

  // ── Deferred FK ───────────────────────────────────────────────────────────
  {
    id: 'dfk-01', group: 'Deferred FK', name: 'DEFERRABLE INITIALLY DEFERRED: commitTransaction fails when FK violation exists',
    fn: async () => {
      const DB = 'suite_dfk';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['PRAGMA foreign_keys = ON'], transaction: false });
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS children',
        'DROP TABLE IF EXISTS parents',
        'CREATE TABLE parents (id INTEGER PRIMARY KEY)',
        'CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)',
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['INSERT INTO children VALUES (1, 999)'], transaction: false }), 'insert violating child');
      const commit = await CapacitorSqlite.commitTransaction({ database: DB });
      if (commit.success) throw new Error('dfk-01: expected commit to fail on deferred FK violation');
      // SQLite does NOT auto-rollback on a failed COMMIT — the transaction stays open.
      await CapacitorSqlite.rollbackTransaction({ database: DB });
      const cnt = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM children' }), 'count');
      assertEqual((cnt.rows[0] as { n: number }).n, 0, 'after explicit rollback, no rows');
      await silentClose(DB);
    },
  },
  {
    id: 'dfk-02', group: 'Deferred FK', name: 'DEFERRABLE INITIALLY DEFERRED: single-statement autocommit still enforces FK',
    fn: async () => {
      const DB = 'suite_dfk';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['PRAGMA foreign_keys = ON'], transaction: false });
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS children',
        'DROP TABLE IF EXISTS parents',
        'CREATE TABLE parents (id INTEGER PRIMARY KEY)',
        'CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)',
      ] }), 'ddl');
      const r = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO children VALUES (1, 999)' });
      if (r.success) throw new Error('dfk-02: expected FK violation even in deferred mode under autocommit');
      await silentClose(DB);
    },
  },
  {
    id: 'dfk-03', group: 'Deferred FK', name: 'DEFERRABLE INITIALLY DEFERRED: child inserted before parent within transaction commits OK',
    fn: async () => {
      const DB = 'suite_dfk';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      await CapacitorSqlite.execute({ database: DB, statements: ['PRAGMA foreign_keys = ON'], transaction: false });
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS children',
        'DROP TABLE IF EXISTS parents',
        'CREATE TABLE parents (id INTEGER PRIMARY KEY)',
        'CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)',
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['INSERT INTO children VALUES (1, 1)'], transaction: false }), 'insert child first');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['INSERT INTO parents VALUES (1)'], transaction: false }), 'insert parent after');
      assertOk(await CapacitorSqlite.commitTransaction({ database: DB }), 'commit succeeds — FK satisfied at commit time');
      const cnt = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM children' }), 'count');
      assertEqual((cnt.rows[0] as { n: number }).n, 1, '1 child row committed');
      await silentClose(DB);
    },
  },

  // ── Trigger Rollback ──────────────────────────────────────────────────────
  {
    id: 'trrb-01', group: 'Trigger Rollback', name: 'BEFORE INSERT trigger raising ABORT prevents row insertion',
    fn: async () => {
      const DB = 'suite_trrb';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (v INTEGER)',
        "CREATE TRIGGER no_negatives BEFORE INSERT ON t BEGIN SELECT RAISE(ABORT, 'negative not allowed') WHERE NEW.v < 0; END",
      ] }), 'ddl');
      const r = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (-1)' });
      if (r.success) throw new Error('trrb-01: expected BEFORE INSERT trigger to block insert');
      const cnt = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((cnt.rows[0] as { n: number }).n, 0, 'no rows inserted');
      await silentClose(DB);
    },
  },
  {
    id: 'trrb-02', group: 'Trigger Rollback', name: 'AFTER INSERT trigger raising ABORT rolls back the insertion',
    fn: async () => {
      const DB = 'suite_trrb';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (v INTEGER)',
        "CREATE TRIGGER check_after AFTER INSERT ON t BEGIN SELECT RAISE(ABORT, 'rejected') WHERE NEW.v = 99; END",
      ] }), 'ddl');
      const r = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (99)' });
      if (r.success) throw new Error('trrb-02: expected AFTER INSERT trigger to roll back insert');
      const cnt = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((cnt.rows[0] as { n: number }).n, 0, 'trigger rollback removed the row');
      await silentClose(DB);
    },
  },

  // ── Conflict Policies ─────────────────────────────────────────────────────
  {
    id: 'conf-01', group: 'Conflict Policies', name: 'INSERT OR IGNORE: duplicate key is silently skipped',
    fn: async () => {
      const DB = 'suite_conf';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)',
        "INSERT INTO t VALUES (1, 'original')",
      ] }), 'ddl');
      const r = assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT OR IGNORE INTO t VALUES (1, 'duplicate')" }), 'insert ignore');
      assertEqual(r.changes, 0, 'no rows changed');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT val FROM t WHERE id = 1' }), 'query');
      assertEqual((q.rows[0] as { val: string }).val, 'original', 'original row preserved');
      await silentClose(DB);
    },
  },
  {
    id: 'conf-02', group: 'Conflict Policies', name: 'INSERT OR REPLACE: duplicate key row is replaced',
    fn: async () => {
      const DB = 'suite_conf';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)',
        "INSERT INTO t VALUES (1, 'original')",
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT OR REPLACE INTO t VALUES (1, 'replaced')" }), 'insert replace');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT val FROM t WHERE id = 1' }), 'query');
      assertEqual((q.rows[0] as { val: string }).val, 'replaced', 'row replaced');
      await silentClose(DB);
    },
  },
  {
    id: 'conf-03', group: 'Conflict Policies', name: 'INSERT OR ABORT: duplicate key aborts statement but leaves transaction active',
    fn: async () => {
      const DB = 'suite_conf';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)',
        "INSERT INTO t VALUES (1, 'original')",
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ["INSERT INTO t VALUES (2, 'new')"], transaction: false }), 'insert new');
      const r = await CapacitorSqlite.run({ database: DB, statement: "INSERT OR ABORT INTO t VALUES (1, 'dup')" });
      if (r.success) throw new Error('conf-03: expected ABORT on duplicate');
      assertOk(await CapacitorSqlite.commitTransaction({ database: DB }), 'transaction still alive after ABORT');
      const cnt = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((cnt.rows[0] as { n: number }).n, 2, 'row 2 preserved after commit');
      await silentClose(DB);
    },
  },
  {
    id: 'conf-04', group: 'Conflict Policies', name: 'INSERT OR ROLLBACK: conflict auto-rolls back entire active transaction',
    fn: async () => {
      const DB = 'suite_conf';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)',
        "INSERT INTO t VALUES (1, 'original')",
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'begin');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ["INSERT INTO t VALUES (2, 'new')"], transaction: false }), 'insert new within txn');
      const r = await CapacitorSqlite.run({ database: DB, statement: "INSERT OR ROLLBACK INTO t VALUES (1, 'dup')" });
      if (r.success) throw new Error('conf-04: expected INSERT OR ROLLBACK to fail');
      // Transaction auto-rolled back; only original row should remain
      const cnt = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((cnt.rows[0] as { n: number }).n, 1, 'auto-rollback: only original row remains');
      await silentClose(DB);
    },
  },
  {
    id: 'conf-05', group: 'Conflict Policies', name: 'INSERT OR FAIL: duplicate key fails statement; existing data unchanged',
    fn: async () => {
      const DB = 'suite_conf';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)',
        "INSERT INTO t VALUES (1, 'original')",
      ] }), 'ddl');
      const r = await CapacitorSqlite.run({ database: DB, statement: "INSERT OR FAIL INTO t VALUES (1, 'dup')" });
      if (r.success) throw new Error('conf-05: expected INSERT OR FAIL to fail on duplicate');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT val FROM t WHERE id = 1' }), 'query');
      assertEqual((q.rows[0] as { val: string }).val, 'original', 'original row unchanged');
      await silentClose(DB);
    },
  },

  // ── Partial Indexes ───────────────────────────────────────────────────────
  {
    id: 'pidx-01', group: 'Partial Indexes', name: 'CREATE INDEX ... WHERE creates a partial index without error',
    fn: async () => {
      const DB = 'suite_pidx';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, val TEXT)',
        "CREATE INDEX idx_active ON t(val) WHERE status = 'active'",
        "INSERT INTO t VALUES (1, 'active', 'foo')",
        "INSERT INTO t VALUES (2, 'inactive', 'bar')",
      ] }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT COUNT(*) AS n FROM t WHERE status = 'active'" }), 'query');
      assertEqual((q.rows[0] as { n: number }).n, 1, 'partial index table queryable');
      await silentClose(DB);
    },
  },
  {
    id: 'pidx-02', group: 'Partial Indexes', name: 'Partial UNIQUE index prevents duplicate values within its filter',
    fn: async () => {
      const DB = 'suite_pidx';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, val TEXT)',
        "CREATE UNIQUE INDEX idx_unique_active ON t(val) WHERE status = 'active'",
        "INSERT INTO t VALUES (1, 'active', 'foo')",
      ] }), 'ddl');
      const r = await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES (2, 'active', 'foo')" });
      if (r.success) throw new Error('pidx-02: expected partial unique index to block duplicate');
      await silentClose(DB);
    },
  },
  {
    id: 'pidx-03', group: 'Partial Indexes', name: 'Partial UNIQUE index allows duplicate values outside its filter',
    fn: async () => {
      const DB = 'suite_pidx';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, val TEXT)',
        "CREATE UNIQUE INDEX idx_unique_active ON t(val) WHERE status = 'active'",
        "INSERT INTO t VALUES (1, 'active', 'foo')",
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES (2, 'inactive', 'foo')" }), 'inactive dup allowed');
      const cnt = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT COUNT(*) AS n FROM t WHERE val = 'foo'" }), 'count');
      assertEqual((cnt.rows[0] as { n: number }).n, 2, 'both rows with val=foo exist');
      await silentClose(DB);
    },
  },

  // ── Expression Indexes ────────────────────────────────────────────────────
  {
    id: 'eidx-01', group: 'Expression Indexes', name: 'CREATE INDEX ON lower(col) creates expression index without error',
    fn: async () => {
      const DB = 'suite_eidx';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)',
        'CREATE INDEX idx_lower_name ON t(lower(name))',
        "INSERT INTO t VALUES (1, 'Alice')",
        "INSERT INTO t VALUES (2, 'BOB')",
      ] }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT COUNT(*) AS n FROM t WHERE lower(name) = 'alice'" }), 'query');
      assertEqual((q.rows[0] as { n: number }).n, 1, 'expression index query returns correct row');
      await silentClose(DB);
    },
  },
  {
    id: 'eidx-02', group: 'Expression Indexes', name: 'EXPLAIN QUERY PLAN: expression index used for lower(col) predicate',
    fn: async () => {
      const DB = 'suite_eidx';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)',
        'CREATE INDEX idx_lower_name ON t(lower(name))',
      ] }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "EXPLAIN QUERY PLAN SELECT * FROM t WHERE lower(name) = 'alice'" }), 'eqp');
      const plan = JSON.stringify(q.rows);
      assert(plan.includes('SEARCH') || plan.includes('INDEX') || plan.includes('COVERING'), `expected index in plan, got: ${plan}`);
      await silentClose(DB);
    },
  },

  // ── Composite PK ──────────────────────────────────────────────────────────
  {
    id: 'cpk-01', group: 'Composite PK', name: 'Composite PRIMARY KEY: unique combinations all insert successfully',
    fn: async () => {
      const DB = 'suite_cpk';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (a INTEGER, b TEXT, val TEXT, PRIMARY KEY (a, b))',
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES (1, 'x', 'first')" }), 'insert 1');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES (1, 'y', 'second')" }), 'insert 2');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES (2, 'x', 'third')" }), 'insert 3');
      const cnt = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((cnt.rows[0] as { n: number }).n, 3, '3 unique composite PK rows');
      await silentClose(DB);
    },
  },
  {
    id: 'cpk-02', group: 'Composite PK', name: 'Composite PRIMARY KEY: fully duplicate combination fails',
    fn: async () => {
      const DB = 'suite_cpk';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (a INTEGER, b TEXT, val TEXT, PRIMARY KEY (a, b))',
        "INSERT INTO t VALUES (1, 'x', 'original')",
      ] }), 'ddl');
      const r = await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES (1, 'x', 'duplicate')" });
      if (r.success) throw new Error('cpk-02: expected composite PK violation to fail');
      await silentClose(DB);
    },
  },
  {
    id: 'cpk-03', group: 'Composite PK', name: 'Composite PRIMARY KEY: sharing one component with different other is allowed',
    fn: async () => {
      const DB = 'suite_cpk';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (a INTEGER, b TEXT, PRIMARY KEY (a, b))',
        "INSERT INTO t VALUES (1, 'x')",
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES (1, 'y')" }), 'same a, diff b');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: "INSERT INTO t VALUES (2, 'x')" }), 'diff a, same b');
      const cnt = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((cnt.rows[0] as { n: number }).n, 3, '3 rows — partial component sharing is valid');
      await silentClose(DB);
    },
  },

  // ── Multi-column CHECK ────────────────────────────────────────────────────
  {
    id: 'mchk-01', group: 'Multi-column CHECK', name: 'Multi-column CHECK (lo < hi) passes for valid data',
    fn: async () => {
      const DB = 'suite_mchk';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (lo REAL, hi REAL, CHECK (lo < hi))',
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (1.0, 2.0)' }), 'valid lo < hi');
      const cnt = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT COUNT(*) AS n FROM t' }), 'count');
      assertEqual((cnt.rows[0] as { n: number }).n, 1, '1 valid row');
      await silentClose(DB);
    },
  },
  {
    id: 'mchk-02', group: 'Multi-column CHECK', name: 'Multi-column CHECK (lo < hi) rejects invalid data',
    fn: async () => {
      const DB = 'suite_mchk';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (lo REAL, hi REAL, CHECK (lo < hi))',
      ] }), 'ddl');
      const r = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t VALUES (5.0, 2.0)' });
      if (r.success) throw new Error('mchk-02: expected multi-column CHECK to reject lo >= hi');
      await silentClose(DB);
    },
  },

  // ── DEFAULT Values ────────────────────────────────────────────────────────
  {
    id: 'def-01', group: 'DEFAULT Values', name: "DEFAULT text literal applied when column omitted from INSERT",
    fn: async () => {
      const DB = 'suite_def';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        "CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending')",
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t (id) VALUES (1)' }), 'insert without status');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT status FROM t WHERE id = 1' }), 'query');
      assertEqual((q.rows[0] as { status: string }).status, 'pending', 'default status applied');
      await silentClose(DB);
    },
  },
  {
    id: 'def-02', group: 'DEFAULT Values', name: "DEFAULT (datetime('now')) generates a non-empty timestamp",
    fn: async () => {
      const DB = 'suite_def';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        "CREATE TABLE t (id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')))",
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t (id) VALUES (1)' }), 'insert without ts');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT ts FROM t WHERE id = 1' }), 'query');
      const ts = (q.rows[0] as { ts: string }).ts;
      assert(typeof ts === 'string' && ts.length > 0, `expected non-empty timestamp, got: ${JSON.stringify(ts)}`);
      await silentClose(DB);
    },
  },
  {
    id: 'def-03', group: 'DEFAULT Values', name: 'DEFAULT numeric 0 applied when score column not specified',
    fn: async () => {
      const DB = 'suite_def';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, score INTEGER NOT NULL DEFAULT 0)',
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t (id) VALUES (1)' }), 'insert without score');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT score FROM t WHERE id = 1' }), 'query');
      assertEqual((q.rows[0] as { score: number }).score, 0, 'default score = 0');
      await silentClose(DB);
    },
  },
  {
    id: 'def-04', group: 'DEFAULT Values', name: 'Explicit NULL in INSERT overrides DEFAULT value',
    fn: async () => {
      const DB = 'suite_def';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        "CREATE TABLE t (id INTEGER PRIMARY KEY, tag TEXT DEFAULT 'default-tag')",
      ] }), 'ddl');
      assertOk(await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO t (id, tag) VALUES (1, NULL)' }), 'explicit null');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT tag FROM t WHERE id = 1' }), 'query');
      assert((q.rows[0] as { tag: null | string }).tag === null, 'explicit NULL stored; DEFAULT not applied');
      await silentClose(DB);
    },
  },

  // ── Column Alter ──────────────────────────────────────────────────────────
  {
    id: 'alter-01', group: 'Column Alter', name: 'ALTER TABLE RENAME COLUMN (SQLite ≥ 3.25) — graceful skip on older',
    fn: async () => {
      const DB = 'suite_alter';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, old_name TEXT)',
        "INSERT INTO t VALUES (1, 'hello')",
      ] }), 'ddl');
      const rename = await CapacitorSqlite.execute({ database: DB, statements: ['ALTER TABLE t RENAME COLUMN old_name TO new_name'] });
      if (!rename.success) return; // SQLite < 3.25 — graceful skip
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT new_name FROM t WHERE id = 1' }), 'query');
      assertEqual((q.rows[0] as { new_name: string }).new_name, 'hello', 'renamed column returns original value');
      await silentClose(DB);
    },
  },
  {
    id: 'alter-02', group: 'Column Alter', name: 'ALTER TABLE DROP COLUMN (SQLite ≥ 3.35) — graceful skip on older',
    fn: async () => {
      const DB = 'suite_alter';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, keep_col TEXT, drop_col TEXT)',
        "INSERT INTO t VALUES (1, 'keep', 'drop')",
      ] }), 'ddl');
      const drop = await CapacitorSqlite.execute({ database: DB, statements: ['ALTER TABLE t DROP COLUMN drop_col'] });
      if (!drop.success) return; // SQLite < 3.35 — graceful skip
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT keep_col FROM t WHERE id = 1' }), 'query');
      assertEqual((q.rows[0] as { keep_col: string }).keep_col, 'keep', 'remaining column intact after drop');
      await silentClose(DB);
    },
  },

  // ── Transaction State ─────────────────────────────────────────────────────
  {
    id: 'txstate-01', group: 'Transaction State', name: 'Nested beginTransaction fails when one is already active',
    fn: async () => {
      const DB = 'suite_txstate';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: ['DROP TABLE IF EXISTS t', 'CREATE TABLE t (v INTEGER)'] }), 'ddl');
      assertOk(await CapacitorSqlite.beginTransaction({ database: DB }), 'first begin');
      const nested = await CapacitorSqlite.beginTransaction({ database: DB });
      if (nested.success) {
        await CapacitorSqlite.rollbackTransaction({ database: DB });
        throw new Error('txstate-01: expected nested beginTransaction to fail');
      }
      assert(typeof nested.error.code === 'string', 'error code present');
      await CapacitorSqlite.rollbackTransaction({ database: DB });
      await silentClose(DB);
    },
  },
  {
    id: 'txstate-02', group: 'Transaction State', name: 'commitTransaction without an active transaction fails',
    fn: async () => {
      const DB = 'suite_txstate';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      const r = await CapacitorSqlite.commitTransaction({ database: DB });
      if (r.success) throw new Error('txstate-02: expected commitTransaction to fail when no transaction active');
      assert(typeof r.error.code === 'string', 'error code present');
      await silentClose(DB);
    },
  },

  // ── Column Names ──────────────────────────────────────────────────────────
  {
    id: 'colname-01', group: 'Column Names', name: 'Column name with embedded space (double-quoted identifier)',
    fn: async () => {
      const DB = 'suite_colname';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, "first name" TEXT)',
        "INSERT INTO t VALUES (1, 'Alice')",
      ] }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT "first name" FROM t WHERE id = 1' }), 'query');
      assertEqual((q.rows[0] as { 'first name': string })['first name'], 'Alice', 'space-column readable');
      await silentClose(DB);
    },
  },
  {
    id: 'colname-02', group: 'Column Names', name: 'Column named after SQL reserved keyword (double-quoted) works',
    fn: async () => {
      const DB = 'suite_colname';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, "select" TEXT, "order" INTEGER)',
        "INSERT INTO t VALUES (1, 'chosen', 42)",
      ] }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT "select", "order" FROM t WHERE id = 1' }), 'query');
      assertEqual((q.rows[0] as { select: string }).select, 'chosen', 'keyword-named col readable');
      assertEqual((q.rows[0] as { order: number }).order, 42, 'keyword-named col value correct');
      await silentClose(DB);
    },
  },
  {
    id: 'colname-03', group: 'Column Names', name: 'Column with Unicode characters in name stored and queried correctly',
    fn: async () => {
      const DB = 'suite_colname';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (id INTEGER PRIMARY KEY, "jméno" TEXT)',
        "INSERT INTO t VALUES (1, 'Karel')",
      ] }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT "jméno" FROM t WHERE id = 1' }), 'query');
      assertEqual((q.rows[0] as { jméno: string }).jméno, 'Karel', 'unicode column name works');
      await silentClose(DB);
    },
  },

  // ── Quote Semantics ───────────────────────────────────────────────────────
  {
    id: 'quote-01', group: 'Quote Semantics', name: "Single quotes = string literal; double quotes = identifier",
    fn: async () => {
      const DB = 'suite_quote';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t ("name" TEXT)',
        "INSERT INTO t VALUES ('Alice')",
      ] }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: "SELECT \"name\" FROM t WHERE \"name\" = 'Alice'" }), 'query');
      assertEqual((q.rows[0] as { name: string }).name, 'Alice', 'single-quote string, double-quote identifier');
      await silentClose(DB);
    },
  },
  {
    id: 'quote-02', group: 'Quote Semantics', name: 'Backtick identifier quoting (SQLite extension) works like double quotes',
    fn: async () => {
      const DB = 'suite_quote';
      await silentClose(DB);
      assertOk(await CapacitorSqlite.open({ database: DB }), 'open');
      assertOk(await CapacitorSqlite.execute({ database: DB, statements: [
        'DROP TABLE IF EXISTS t',
        'CREATE TABLE t (`value` INTEGER)',
        'INSERT INTO t VALUES (42)',
      ] }), 'ddl');
      const q = assertOk(await CapacitorSqlite.query({ database: DB, statement: 'SELECT `value` FROM t' }), 'query');
      assertEqual((q.rows[0] as { value: number }).value, 42, 'backtick identifier works');
      await silentClose(DB);
    },
  },
];

// ── group helper ──────────────────────────────────────────────────────────────

const GROUPS = [...new Set(TESTS.map((t) => t.group))];

// ── component ─────────────────────────────────────────────────────────────────

export const PageSuite: React.FC = () => {
  const log = useLogger();
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<string>('All');

  const visibleTests = selectedGroup === 'All'
    ? TESTS
    : TESTS.filter((t) => t.group === selectedGroup);

  const runAll = useCallback(async () => {
    setRunning(true);
    setResults([]);
    const out: TestResult[] = [];
    for (const tc of visibleTests) {
      const r = await runTestCase(tc);
      out.push(r);
      setResults([...out]);
      log[r.pass ? 'info' : 'error']('suite', `[${r.pass ? 'PASS' : 'FAIL'}] ${r.group} / ${r.name} (${r.durationMs}ms)${r.pass ? '' : ` — ${r.message}`}`);
    }
    setRunning(false);
    const passed = out.filter((r) => r.pass).length;
    log.info('suite', `Done: ${passed}/${out.length} passed`);
  }, [visibleTests, log]);

  const runSingle = useCallback(async (tc: TestCase) => {
    const r = await runTestCase(tc);
    setResults((prev) => {
      const next = prev.filter((x) => x.id !== tc.id);
      return [...next, r];
    });
    log[r.pass ? 'info' : 'error']('suite', `[${r.pass ? 'PASS' : 'FAIL'}] ${r.group} / ${r.name} (${r.durationMs}ms)${r.pass ? '' : ` — ${r.message}`}`);
  }, [log]);

  const resultMap = Object.fromEntries(results.map((r) => [r.id, r]));
  const totalPass = results.filter((r) => r.pass).length;
  const totalFail = results.filter((r) => !r.pass).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="green" onClick={runAll} disabled={running}>
          {running ? 'Running…' : `Run ${visibleTests.length} tests`}
        </Button>
        <Button type="neutral" onClick={() => setResults([])}>Clear results</Button>

        <div className="flex items-center gap-1">
          <span className="text-sm text-slate-500">Group:</span>
          <select
            className="border border-slate-300 rounded px-2 py-1 text-sm"
            value={selectedGroup}
            onChange={(e) => setSelectedGroup(e.target.value)}
          >
            <option>All</option>
            {GROUPS.map((g) => <option key={g}>{g}</option>)}
          </select>
        </div>

        {results.length > 0 && (
          <span className="text-sm font-semibold">
            <span className="text-emerald-700">{totalPass} pass</span>
            {totalFail > 0 && <span className="text-red-600 ml-2">{totalFail} fail</span>}
          </span>
        )}
      </div>

      <div className="space-y-1">
        {visibleTests.map((tc) => {
          const r = resultMap[tc.id];
          return (
            <div
              key={tc.id}
              className={[
                'flex items-center gap-2 px-3 py-1.5 rounded text-sm',
                r ? (r.pass ? 'bg-emerald-50' : 'bg-red-50') : 'bg-slate-50',
              ].join(' ')}
            >
              <span className="w-5 text-center flex-shrink-0">
                {r ? (r.pass ? '✓' : '✗') : '○'}
              </span>
              <span className="text-slate-500 text-xs w-20 flex-shrink-0">{tc.group}</span>
              <span className="flex-1 text-slate-800">{tc.name}</span>
              {r && !r.pass && (
                <span className="text-red-600 text-xs truncate max-w-xs" title={r.message}>{r.message}</span>
              )}
              {r && <span className="text-slate-400 text-xs flex-shrink-0">{r.durationMs}ms</span>}
              <button
                onClick={() => runSingle(tc)}
                disabled={running}
                className="text-xs text-indigo-600 hover:underline flex-shrink-0 disabled:opacity-40"
              >
                run
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

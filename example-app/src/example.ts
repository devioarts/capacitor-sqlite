import { CapacitorSqlite } from '@devioarts/capacitor-sqlite';
import type { Migration, SQLiteValues } from '@devioarts/capacitor-sqlite';
import { Capacitor } from '@capacitor/core';

const DB = 'demo';

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
         id    INTEGER PRIMARY KEY AUTOINCREMENT,
         name  TEXT    NOT NULL,
         score INTEGER NOT NULL DEFAULT 0
       )`,
    ],
  },
];

interface User {
  id: number;
  name: string;
  score: number;
}

interface SqliteObj {
  type: string;
  name: string;
}

function btn(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}

// ─── platform badge ───────────────────────────────────────────────────────────

const platform = Capacitor.getPlatform();
const badge = document.getElementById('platformBadge')!;
badge.textContent = platform;
badge.style.background = platform === 'electron' ? '#1e3a1e' : platform === 'web' ? '#1e2a3a' : '#2a1e3a';
badge.style.color = platform === 'electron' ? '#4ade80' : platform === 'web' ? '#38bdf8' : '#a78bfa';

// ─── setup ────────────────────────────────────────────────────────────────────

btn('btnGetPlatform').onclick = (): void => {
  console.log('platform:', platform, '| isNative:', Capacitor.isNativePlatform());
};

btn('btnPluginPlatform').onclick = async (): Promise<void> => {
  const result = await CapacitorSqlite.getPlatform();
  if (result.success) {
    console.log('plugin backend:', result.data.platform);
  } else {
    console.error('getPlatform failed:', result.error);
  }
};

btn('btnAvailable').onclick = async (): Promise<void> => {
  console.group('isAvailable');
  const result = await CapacitorSqlite.isAvailable();
  if (result.success) {
    console.log('result:', result.data.available, result.data.available ? '— OPFS + WASM ready' : '— OPFS unavailable');
  } else {
    console.error('isAvailable failed:', result.error);
  }
  console.groupEnd();
};

btn('btnOpen').onclick = async (): Promise<void> => {
  console.group('open + migrations');
  const result = await CapacitorSqlite.open({ database: DB, migrations: MIGRATIONS });
  if (result.success) {
    console.log('opened "' + DB + '" — migration v1 applied if first run');
  } else {
    console.error('open failed:', result.error);
  }
  console.groupEnd();
};

btn('btnGetVersion').onclick = async (): Promise<void> => {
  console.group('getVersion');
  const result = await CapacitorSqlite.getVersion({ database: DB });
  if (result.success) {
    const backend = platform === 'electron' ? 'node:sqlite' : 'sqlite-wasm';
    console.log(`SQLite ${result.data.version} — backend: ${backend}`);
  } else {
    console.error('getVersion failed:', result.error);
  }
  console.groupEnd();
};

btn('btnClose').onclick = async (): Promise<void> => {
  console.group('close');
  const result = await CapacitorSqlite.close({ database: DB });
  if (result.success) {
    console.log('closed "' + DB + '"');
  } else {
    console.error('close failed:', result.error);
  }
  console.groupEnd();
};

// ─── CRUD ─────────────────────────────────────────────────────────────────────

btn('btnInsert').onclick = async (): Promise<void> => {
  console.group('insert 3 users');
  const users: Array<[string, number]> = [
    ['Alice', Math.floor(Math.random() * 100)],
    ['Bob',   Math.floor(Math.random() * 100)],
    ['Carol', Math.floor(Math.random() * 100)],
  ];
  for (const [name, score] of users) {
    const result = await CapacitorSqlite.run({
      database: DB,
      statement: 'INSERT INTO users (name, score) VALUES (?, ?)',
      values: [name, score] satisfies SQLiteValues,
    });
    if (result.success) {
      console.log('inserted', name, '— lastInsertId:', result.data.lastInsertId);
    } else {
      console.error('insert', name, 'failed:', result.error);
    }
  }
  console.groupEnd();
};

btn('btnQuery').onclick = async (): Promise<void> => {
  console.group('query all users');
  const result = await CapacitorSqlite.query<User>({
    database: DB,
    statement: 'SELECT * FROM users ORDER BY id',
  });
  if (result.success) {
    console.log('rows:', result.data.rows);
  } else {
    console.error('query failed:', result.error);
  }
  console.groupEnd();
};

btn('btnRun').onclick = async (): Promise<void> => {
  console.group('run UPDATE');
  const result = await CapacitorSqlite.run({
    database: DB,
    statement: 'UPDATE users SET score = score + 10 WHERE id = (SELECT MIN(id) FROM users)',
  });
  if (result.success) {
    console.log('updated — changes:', result.data.changes);
  } else {
    console.error('run failed:', result.error);
  }
  console.groupEnd();
};

btn('btnBatch').onclick = async (): Promise<void> => {
  console.group('runBatch — 5 rows');
  const set = Array.from({ length: 5 }, (_, i) => ({
    statement: 'INSERT INTO users (name, score) VALUES (?, ?)',
    values: ['BatchUser' + (i + 1), i * 10] satisfies SQLiteValues,
  }));
  const result = await CapacitorSqlite.runBatch({ database: DB, set });
  if (result.success) {
    console.log('batch result — changes:', result.data.changes);
  } else {
    console.error('runBatch failed:', result.error);
  }
  console.groupEnd();
};

btn('btnExec').onclick = async (): Promise<void> => {
  console.group('execute DDL');
  const result = await CapacitorSqlite.execute({
    database: DB,
    statements: [
      'CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, msg TEXT, ts INTEGER)',
      `INSERT INTO logs (msg, ts) VALUES ('demo log', ${Date.now()})`,
    ],
  });
  if (result.success) {
    console.log('execute result — changes:', result.data.changes);
  } else {
    console.error('execute failed:', result.error);
  }
  console.groupEnd();
};

// ─── transactions ─────────────────────────────────────────────────────────────

btn('btnTxOk').onclick = async (): Promise<void> => {
  console.group('transaction — commit');

  const begin = await CapacitorSqlite.beginTransaction({ database: DB });
  if (!begin.success) { console.error('beginTransaction failed:', begin.error); console.groupEnd(); return; }

  const insert = await CapacitorSqlite.run({
    database: DB,
    statement: "INSERT INTO users (name, score) VALUES ('TxUser', 99)",
  });
  if (!insert.success) {
    await CapacitorSqlite.rollbackTransaction({ database: DB });
    console.error('insert inside tx failed:', insert.error); console.groupEnd(); return;
  }

  const commit = await CapacitorSqlite.commitTransaction({ database: DB });
  if (!commit.success) { console.error('commitTransaction failed:', commit.error); console.groupEnd(); return; }
  console.log('committed — TxUser inserted');

  const verify = await CapacitorSqlite.query<User>({
    database: DB,
    statement: "SELECT * FROM users WHERE name = 'TxUser'",
  });
  if (verify.success) {
    console.log('verify:', verify.data.rows);
  } else {
    console.error('verify query failed:', verify.error);
  }
  console.groupEnd();
};

btn('btnTxFail').onclick = async (): Promise<void> => {
  console.group('transaction — rollback');

  const begin = await CapacitorSqlite.beginTransaction({ database: DB });
  if (!begin.success) { console.error('beginTransaction failed:', begin.error); console.groupEnd(); return; }

  await CapacitorSqlite.run({
    database: DB,
    statement: "INSERT INTO users (name, score) VALUES ('Ghost', 0)",
  });
  console.log('inserted Ghost inside transaction…');

  // Intentionally bad statement to trigger rollback
  const bad = await CapacitorSqlite.run({ database: DB, statement: 'INSERT INTO nonexistent VALUES (1)' });
  if (!bad.success) {
    console.log('expected error:', bad.error.message);
    const rb = await CapacitorSqlite.rollbackTransaction({ database: DB });
    if (rb.success) {
      console.log('rolled back — Ghost not persisted');
    } else {
      console.error('rollback failed:', rb.error);
    }

    const verify = await CapacitorSqlite.query<User>({
      database: DB,
      statement: "SELECT * FROM users WHERE name = 'Ghost'",
    });
    if (verify.success) {
      console.log('verify (should be empty):', verify.data.rows);
    }
  }
  console.groupEnd();
};

// ─── :memory: ─────────────────────────────────────────────────────────────────

btn('btnMemory').onclick = async (): Promise<void> => {
  console.group(':memory: database');
  const MEM = ':memory:';

  const open = await CapacitorSqlite.open({ database: MEM });
  if (!open.success) { console.error('open :memory: failed:', open.error); console.groupEnd(); return; }
  console.log('opened :memory:');

  await CapacitorSqlite.execute({
    database: MEM,
    statements: ['CREATE TABLE tmp (id INTEGER PRIMARY KEY, val TEXT)'],
  });

  await CapacitorSqlite.runBatch({
    database: MEM,
    set: [
      { statement: 'INSERT INTO tmp (val) VALUES (?)', values: ['hello'] satisfies SQLiteValues },
      { statement: 'INSERT INTO tmp (val) VALUES (?)', values: ['world'] satisfies SQLiteValues },
    ],
  });

  const q = await CapacitorSqlite.query<{ id: number; val: string }>({
    database: MEM,
    statement: 'SELECT * FROM tmp',
  });
  if (q.success) {
    console.log('query result:', q.data.rows);
  } else {
    console.error('query failed:', q.error);
  }

  await CapacitorSqlite.close({ database: MEM });
  console.log('closed :memory: — data gone');
  console.groupEnd();
};

// ─── reset ────────────────────────────────────────────────────────────────────

btn('btnReset').onclick = async (): Promise<void> => {
  if (!confirm('Drop all tables in "' + DB + '"?')) return;
  console.group('reset database');

  await CapacitorSqlite.execute({
    database: DB,
    statements: ['PRAGMA foreign_keys = OFF'],
    transaction: false,
  });

  const list = await CapacitorSqlite.query<SqliteObj>({
    database: DB,
    statement: `SELECT type, name FROM sqlite_master
      WHERE type IN ('view','trigger','table') AND name NOT LIKE 'sqlite_%'
      ORDER BY CASE type WHEN 'view' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END`,
  });

  if (!list.success) {
    console.error('list objects failed:', list.error);
    console.groupEnd();
    return;
  }

  const allowedTypes = new Set(['table', 'view', 'trigger']);
  for (const row of list.data.rows) {
    if (!allowedTypes.has(row.type)) continue;
    const safeName = row.name.replace(/"/g, '""');
    await CapacitorSqlite.execute({
      database: DB,
      statements: [`DROP ${row.type.toUpperCase()} IF EXISTS "${safeName}"`],
    });
    console.log('dropped', row.type, row.name);
  }

  await CapacitorSqlite.execute({ database: DB, statements: ['PRAGMA user_version = 0'] });
  await CapacitorSqlite.execute({
    database: DB,
    statements: ['PRAGMA foreign_keys = ON'],
    transaction: false,
  });
  await CapacitorSqlite.close({ database: DB });
  console.log('reset done — reopen to recreate schema');
  console.groupEnd();
};

import React, { useState } from 'react';
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite';
import { Button } from '../components/Button.tsx';
import { Input, Label } from '../components/Input.tsx';
import { useLogger } from '../components/Logger.tsx';

const DB = 'extras_demo';
const SCOPE = 'extras';

// Fallback path shown in the UI — replace with a real absolute path on native.
const CUSTOM_DIR_PLACEHOLDER = '/tmp/my_custom_dir';

export const PageExtras: React.FC = () => {
  const log = useLogger();
  const [isSetup, setIsSetup] = useState(false);
  const [blobHex, setBlobHex] = useState('deadbeef01020304');
  const [customDir, setCustomDir] = useState(CUSTOM_DIR_PLACEHOLDER);

  // ── lifecycle ──────────────────────────────────────────────────────────────
  const setup = async () => {
    const open = await CapacitorSqlite.open({ database: DB });
    if (!open.success) { log.error(SCOPE, 'open failed', open.error); return; }
    const r = await CapacitorSqlite.execute({
      database: DB,
      statements: [
        'DROP TABLE IF EXISTS blobs',
        'CREATE TABLE blobs (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, data BLOB)',
      ],
    });
    if (r.success) { log.info(SCOPE, 'Schema ready ✓'); setIsSetup(true); }
    else log.error(SCOPE, 'setup failed', r.error);
  };

  const teardown = async () => {
    await CapacitorSqlite.close({ database: DB });
    setIsSetup(false);
    log.info(SCOPE, 'Closed');
  };

  // ── getVersion / getSchemaVersion ──────────────────────────────────────────
  const getVersion = async () => {
    const r = await CapacitorSqlite.getVersion({ database: DB });
    if (r.success) log.info(SCOPE, `getVersion() → "${r.data.version}"`, r.data);
    else log.error(SCOPE, 'getVersion failed', r.error);
  };

  const getSchemaVersion = async () => {
    const r = await CapacitorSqlite.getSchemaVersion({ database: DB });
    if (r.success) log.info(SCOPE, `getSchemaVersion() → ${r.data.version}`, r.data);
    else log.error(SCOPE, 'getSchemaVersion failed', r.error);
  };

  // ── vacuum ─────────────────────────────────────────────────────────────────
  const vacuum = async () => {
    const insert = await CapacitorSqlite.execute({
      database: DB,
      statements: [
        "INSERT INTO blobs (label, data) VALUES ('to_delete', x'aabb')",
        'DELETE FROM blobs',
      ],
    });
    if (!insert.success) { log.error(SCOPE, 'pre-vacuum insert/delete failed', insert.error); return; }

    const r = await CapacitorSqlite.vacuum({ database: DB });
    if (r.success) log.info(SCOPE, 'vacuum() ✓');
    else log.error(SCOPE, 'vacuum failed', r.error);
  };

  // ── :memory: isolation ─────────────────────────────────────────────────────
  const memoryIsolation = async () => {
    const a = await CapacitorSqlite.open({ database: ':memory:' });
    const b = await CapacitorSqlite.open({ database: ':memory:' });
    if (!a.success || !b.success) {
      log.warn(SCOPE, ':memory: DB open failed (may not be supported on this platform)');
      return;
    }

    await CapacitorSqlite.execute({ database: ':memory:', statements: ['CREATE TABLE t (v INTEGER)'] });
    await CapacitorSqlite.run({ database: ':memory:', statement: 'INSERT INTO t VALUES (42)' });

    const r = await CapacitorSqlite.query({ database: ':memory:', statement: 'SELECT * FROM t' });
    if (r.success) log.info(SCOPE, ':memory: DB visible data', r.data.rows);

    await CapacitorSqlite.close({ database: ':memory:' });
    log.info(SCOPE, ':memory: DB closed — data is gone');
  };

  // ── readonly enforcement ───────────────────────────────────────────────────
  const readonlyEnforcement = async () => {
    const ro = 'ro_test';
    const rw = await CapacitorSqlite.open({ database: ro });
    if (!rw.success) { log.error(SCOPE, 'open rw failed', rw.error); return; }
    await CapacitorSqlite.execute({ database: ro, statements: ['CREATE TABLE IF NOT EXISTS rd (v TEXT)'] });
    await CapacitorSqlite.close({ database: ro });

    const r = await CapacitorSqlite.open({ database: ro, readonly: true });
    if (!r.success) { log.error(SCOPE, 'open readonly failed', r.error); return; }
    log.info(SCOPE, `Opened "${ro}" as readonly ✓`);

    const write = await CapacitorSqlite.run({ database: ro, statement: "INSERT INTO rd VALUES ('x')" });
    if (!write.success)
      log.info(SCOPE, `Write to readonly DB → error (${write.error.code}) ✓`, write.error.message);
    else
      log.error(SCOPE, 'Write to readonly DB unexpectedly succeeded');

    await CapacitorSqlite.close({ database: ro });
  };

  // ── BLOB round-trip ────────────────────────────────────────────────────────
  const hexToUint8Array = (hex: string): Uint8Array => {
    const clean = hex.replace(/\s/g, '');
    const arr = new Uint8Array(clean.length / 2);
    for (let i = 0; i < arr.length; i++) {
      arr[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return arr;
  };

  const uint8ArrayToHex = (arr: Uint8Array): string =>
    Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');

  const blobRoundTrip = async () => {
    let bytes: Uint8Array;
    try {
      bytes = hexToUint8Array(blobHex);
    } catch {
      log.error(SCOPE, 'Invalid hex string');
      return;
    }

    log.info(SCOPE, `Inserting BLOB: ${bytes.length} bytes → 0x${uint8ArrayToHex(bytes)}`);

    const insert = await CapacitorSqlite.run({
      database: DB,
      statement: 'INSERT INTO blobs (label, data) VALUES (?, ?)',
      values: ['roundtrip', bytes],
    });
    if (!insert.success) { log.error(SCOPE, 'BLOB insert failed', insert.error); return; }
    const id = insert.data.lastInsertId;
    log.info(SCOPE, `BLOB inserted → id=${id} ✓`);

    const q = await CapacitorSqlite.query<{ id: number; label: string; data: unknown }>({
      database: DB,
      statement: 'SELECT * FROM blobs WHERE id = ?',
      values: [id],
    });
    if (!q.success) { log.error(SCOPE, 'BLOB query failed', q.error); return; }

    const row = q.data.rows[0];
    if (!row) { log.error(SCOPE, 'Row not found'); return; }

    const rawData = row.data;
    log.info(SCOPE, `Read back type: ${rawData instanceof Uint8Array ? 'Uint8Array' : typeof rawData}`, row);

    if (rawData instanceof Uint8Array) {
      const roundTrippedHex = uint8ArrayToHex(rawData);
      const match = roundTrippedHex === uint8ArrayToHex(bytes);
      if (match)
        log.info(SCOPE, `BLOB round-trip match ✓ (0x${roundTrippedHex})`);
      else
        log.error(SCOPE, `BLOB round-trip MISMATCH`, { sent: uint8ArrayToHex(bytes), got: roundTrippedHex });
    } else if (typeof rawData === 'string') {
      log.warn(SCOPE, `BLOB came back as string (bridge serialization) — value: "${rawData}"`);
    } else {
      log.warn(SCOPE, `BLOB came back as unexpected type: ${typeof rawData}`, rawData);
    }
  };

  const blobNull = async () => {
    const r = await CapacitorSqlite.run({
      database: DB,
      statement: 'INSERT INTO blobs (label, data) VALUES (?, ?)',
      values: ['null_blob', null],
    });
    if (r.success) {
      log.info(SCOPE, `INSERT with null BLOB → id=${r.data.lastInsertId} ✓`);
      const q = await CapacitorSqlite.query({
        database: DB,
        statement: 'SELECT * FROM blobs WHERE id = ?',
        values: [r.data.lastInsertId],
      });
      if (q.success) log.info(SCOPE, 'null BLOB row', q.data.rows[0]);
    } else {
      log.error(SCOPE, 'null BLOB insert failed', r.error);
    }
  };

  const blobEmptyArray = async () => {
    const r = await CapacitorSqlite.run({
      database: DB,
      statement: 'INSERT INTO blobs (label, data) VALUES (?, ?)',
      values: ['empty_blob', new Uint8Array(0)],
    });
    if (r.success) {
      log.info(SCOPE, `INSERT with empty Uint8Array → id=${r.data.lastInsertId}`);
      const q = await CapacitorSqlite.query({
        database: DB,
        statement: 'SELECT * FROM blobs WHERE id = ?',
        values: [r.data.lastInsertId],
      });
      if (q.success) log.info(SCOPE, 'empty BLOB row', q.data.rows[0]);
    } else {
      log.error(SCOPE, 'empty BLOB insert failed', r.error);
    }
  };

  const queryAllBlobs = async () => {
    const r = await CapacitorSqlite.query({ database: DB, statement: 'SELECT id, label FROM blobs ORDER BY id' });
    if (r.success) log.info(SCOPE, `blobs table: ${r.data.rows.length} rows`, r.data.rows);
    else log.error(SCOPE, 'query failed', r.error);
  };

  // ── custom directory ───────────────────────────────────────────────────────
  const customDirectoryTest = async () => {
    const dbName = 'custom_dir_test';
    const open = await CapacitorSqlite.open({ database: dbName, directory: customDir });
    if (!open.success) {
      log.error(SCOPE, `open with directory="${customDir}" failed`, open.error);
      return;
    }
    log.info(SCOPE, `Opened "${dbName}" in "${customDir}" ✓`);

    const create = await CapacitorSqlite.execute({
      database: dbName,
      statements: ['CREATE TABLE IF NOT EXISTS t (v TEXT)'],
    });
    if (!create.success) { log.error(SCOPE, 'CREATE TABLE failed', create.error); return; }

    const insert = await CapacitorSqlite.run({
      database: dbName,
      statement: "INSERT INTO t VALUES ('hello from custom dir')",
    });
    if (!insert.success) { log.error(SCOPE, 'INSERT failed', insert.error); return; }

    const q = await CapacitorSqlite.query({ database: dbName, statement: 'SELECT * FROM t' });
    if (q.success) log.info(SCOPE, `custom dir DB rows`, q.data.rows);
    else log.error(SCOPE, 'query failed', q.error);

    await CapacitorSqlite.close({ database: dbName });
    log.info(SCOPE, `Closed "${dbName}" ✓`);
  };

  // ── getVersion on closed DB ────────────────────────────────────────────────
  const versionOnClosed = async () => {
    const r = await CapacitorSqlite.getVersion({ database: 'definitely_closed_' + Date.now() });
    if (!r.success)
      log.info(SCOPE, `getVersion on closed DB → ${r.error.code} ✓`, r.error.message);
    else
      log.warn(SCOPE, 'getVersion on closed DB unexpectedly succeeded');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button type={isSetup ? 'red' : 'green'} onClick={isSetup ? teardown : setup}>
          {isSetup ? 'Teardown' : 'Setup (open + blobs table)'}
        </Button>
        {isSetup && <span className="text-xs text-emerald-700 font-semibold">● DB open</span>}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">DB metadata</h3>
        <div className="flex flex-wrap gap-2">
          <Button onClick={getVersion} disabled={!isSetup}>getVersion()</Button>
          <Button onClick={getSchemaVersion} disabled={!isSetup}>getSchemaVersion()</Button>
          <Button type="yellow" onClick={versionOnClosed}>getVersion on closed DB</Button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">VACUUM</h3>
        <Button onClick={vacuum} disabled={!isSetup}>vacuum()</Button>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">BLOB round-trip</h3>
        <Label label="Hex bytes to insert">
          <Input
            value={blobHex}
            onChange={(e) => setBlobHex(e.target.value)}
            placeholder="deadbeef..."
          />
        </Label>
        <div className="flex flex-wrap gap-2">
          <Button type="green" onClick={blobRoundTrip} disabled={!isSetup}>
            BLOB round-trip
          </Button>
          <Button onClick={blobNull} disabled={!isSetup}>Insert NULL blob</Button>
          <Button onClick={blobEmptyArray} disabled={!isSetup}>Insert empty Uint8Array</Button>
          <Button onClick={queryAllBlobs} disabled={!isSetup}>List blobs</Button>
        </div>
        <p className="text-xs text-slate-500">
          BLOB bridging is platform-dependent. On web, <code>Uint8Array</code> is native.
          On iOS/Android it passes through the Capacitor bridge — verify types in log output.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">Special databases</h3>
        <div className="flex flex-wrap gap-2">
          <Button type="yellow" onClick={memoryIsolation}>:memory: isolation</Button>
          <Button type="yellow" onClick={readonlyEnforcement}>Readonly enforcement</Button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">Custom directory</h3>
        <Label label="Absolute path (iOS/Android only — ignored on web)">
          <Input
            value={customDir}
            onChange={(e) => setCustomDir(e.target.value)}
            placeholder="/absolute/path/to/dir"
          />
        </Label>
        <Button type="yellow" onClick={customDirectoryTest}>
          Open DB in custom directory
        </Button>
        <p className="text-xs text-slate-500">
          Creates <code>&lt;directory&gt;/custom_dir_test.db</code>. On web this option is ignored — OPFS does not support custom paths.
        </p>
      </div>
    </div>
  );
};

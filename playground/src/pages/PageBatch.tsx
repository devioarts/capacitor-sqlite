import React, { useState } from 'react';
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite';
import { Button } from '../components/Button.tsx';
import { useLogger } from '../components/Logger.tsx';

const DB = 'batch_demo';
const SCOPE = 'batch';

export const PageBatch: React.FC = () => {
  const log = useLogger();
  const [isSetup, setIsSetup] = useState(false);
  const [batchSize, setBatchSize] = useState(10);

  const setup = async () => {
    const open = await CapacitorSqlite.open({ database: DB });
    if (!open.success) { log.error(SCOPE, 'open failed', open.error); return; }
    const r = await CapacitorSqlite.execute({
      database: DB,
      statements: [
        'DROP TABLE IF EXISTS items',
        'CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT, num REAL)',
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

  const runBatch = async () => {
    const set = Array.from({ length: batchSize }, (_, i) => ({
      statement: 'INSERT INTO items (val, num) VALUES (?, ?)',
      values: [`item_${i}`, i * 1.5] as [string, number],
    }));
    const r = await CapacitorSqlite.runBatch({ database: DB, set });
    if (r.success)
      log.info(SCOPE, `runBatch(${batchSize}) → changes=${r.data.changes}, lastInsertId=${r.data.lastInsertId} (always 0)`, r.data);
    else log.error(SCOPE, 'runBatch failed', r.error);
  };

  const runBatchNoTx = async () => {
    const set = Array.from({ length: 5 }, (_, i) => ({
      statement: 'INSERT INTO items (val, num) VALUES (?, ?)',
      values: [`notx_${i}`, i] as [string, number],
    }));
    const r = await CapacitorSqlite.runBatch({ database: DB, set, transaction: false });
    if (r.success)
      log.info(SCOPE, `runBatch(transaction:false) → changes=${r.data.changes}`, r.data);
    else log.error(SCOPE, 'runBatch (no tx) failed', r.error);
  };

  const runBatchRollback = async () => {
    const countBefore = await CapacitorSqlite.query({
      database: DB,
      statement: 'SELECT COUNT(*) AS n FROM items',
    });
    const before = (countBefore.success ? countBefore.data.rows[0] : null) as { n: number } | null;

    const set = [
      { statement: 'INSERT INTO items (val, num) VALUES (?, ?)', values: ['bad_item', 1] as [string, number] },
      { statement: 'INSERT INTO items (val, num) VALUES (?, ?)', values: [null as unknown as string, 2] as never }, // null violates NOT NULL
    ];
    const r = await CapacitorSqlite.runBatch({ database: DB, set, transaction: true });
    if (!r.success)
      log.info(SCOPE, `runBatch with bad row → error (${r.error.code}) — rollback expected ✓`, r.error.message);
    else log.warn(SCOPE, 'runBatch with bad row succeeded (null allowed on this platform?)');

    const countAfter = await CapacitorSqlite.query({
      database: DB,
      statement: 'SELECT COUNT(*) AS n FROM items',
    });
    const after = (countAfter.success ? countAfter.data.rows[0] : null) as { n: number } | null;
    log.info(SCOPE, `Row count: before=${before?.n}, after=${after?.n} (should be same on rollback)`);
  };

  const mixedTypes = async () => {
    const set = [
      { statement: 'INSERT INTO items (val, num) VALUES (?, ?)', values: ['text_val', 42] as [string, number] },
      { statement: 'INSERT INTO items (val, num) VALUES (?, ?)', values: [null as unknown as string, 3.14] as never },
      { statement: 'INSERT INTO items (val, num) VALUES (?, ?)', values: ['bool_num', 1] as [string, number] },
    ];
    const r = await CapacitorSqlite.runBatch({ database: DB, set });
    if (r.success) log.info(SCOPE, `Mixed types batch → changes=${r.data.changes}`, r.data);
    else log.error(SCOPE, 'Mixed types batch failed', r.error);
  };

  const queryAll = async () => {
    const r = await CapacitorSqlite.query({
      database: DB,
      statement: 'SELECT * FROM items ORDER BY id DESC LIMIT 20',
    });
    if (r.success) log.info(SCOPE, `items (latest 20): ${r.data.rows.length} rows`, r.data.rows);
    else log.error(SCOPE, 'query failed', r.error);
  };

  const clearItems = async () => {
    const r = await CapacitorSqlite.execute({ database: DB, statements: ['DELETE FROM items'] });
    if (r.success) log.info(SCOPE, `Deleted all items, changes=${r.data.changes}`);
    else log.error(SCOPE, 'clear failed', r.error);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button type={isSetup ? 'red' : 'green'} onClick={isSetup ? teardown : setup}>
          {isSetup ? 'Teardown' : 'Setup (open + schema)'}
        </Button>
        {isSetup && <span className="text-xs text-emerald-700 font-semibold">● DB open</span>}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">runBatch()</h3>
        <div className="flex items-center gap-3">
          <label className="text-sm text-slate-600">Batch size:</label>
          <input
            type="number"
            className="w-20 border border-slate-300 rounded px-2 py-1 text-sm"
            value={batchSize}
            min={1}
            max={1000}
            onChange={(e) => setBatchSize(Math.max(1, +e.target.value))}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="green" onClick={runBatch} disabled={!isSetup}>
            runBatch({batchSize} inserts, tx=true)
          </Button>
          <Button type="neutral" onClick={runBatchNoTx} disabled={!isSetup}>
            runBatch(5 inserts, tx=false)
          </Button>
          <Button type="yellow" onClick={runBatchRollback} disabled={!isSetup}>
            runBatch rollback on bad row
          </Button>
          <Button onClick={mixedTypes} disabled={!isSetup}>
            Mixed types
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">Inspect</h3>
        <div className="flex gap-2">
          <Button onClick={queryAll} disabled={!isSetup}>Query latest 20</Button>
          <Button type="red" onClick={clearItems} disabled={!isSetup}>Clear all</Button>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Note: <code>lastInsertId</code> is always <code>0</code> from runBatch. Use{' '}
        <code>run()</code> to get the inserted row ID.
      </p>
    </div>
  );
};

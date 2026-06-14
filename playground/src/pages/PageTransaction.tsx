import React, { useState } from 'react';
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite';
import { Button } from '../components/Button.tsx';
import { useLogger } from '../components/Logger.tsx';

const DB = 'tx_demo';
const SCOPE = 'tx';

export const PageTransaction: React.FC = () => {
  const log = useLogger();
  const [isSetup, setIsSetup] = useState(false);

  const setup = async () => {
    const open = await CapacitorSqlite.open({ database: DB });
    if (!open.success) { log.error(SCOPE, 'open failed', open.error); return; }
    const r = await CapacitorSqlite.execute({
      database: DB,
      statements: [
        'DROP TABLE IF EXISTS accounts',
        `CREATE TABLE accounts (
           id      INTEGER PRIMARY KEY,
           name    TEXT    NOT NULL,
           balance REAL    NOT NULL DEFAULT 0 CHECK (balance >= 0)
         )`,
        "INSERT INTO accounts VALUES (1, 'Alice', 1000)",
        "INSERT INTO accounts VALUES (2, 'Bob', 500)",
      ],
    });
    if (r.success) { log.info(SCOPE, 'Schema + seed data ✓'); setIsSetup(true); }
    else log.error(SCOPE, 'setup failed', r.error);
  };

  const teardown = async () => {
    await CapacitorSqlite.close({ database: DB });
    setIsSetup(false);
    log.info(SCOPE, 'Closed');
  };

  const showBalances = async () => {
    const r = await CapacitorSqlite.query({ database: DB, statement: 'SELECT * FROM accounts ORDER BY id' });
    if (r.success) log.info(SCOPE, 'accounts', r.data.rows);
    else log.error(SCOPE, 'query failed', r.error);
  };

  const txCommit = async () => {
    const begin = await CapacitorSqlite.beginTransaction({ database: DB });
    if (!begin.success) { log.error(SCOPE, 'beginTransaction failed', begin.error); return; }

    await CapacitorSqlite.run({ database: DB, statement: 'UPDATE accounts SET balance = balance - ? WHERE id = ?', values: [100, 1] });
    await CapacitorSqlite.run({ database: DB, statement: 'UPDATE accounts SET balance = balance + ? WHERE id = ?', values: [100, 2] });

    const commit = await CapacitorSqlite.commitTransaction({ database: DB });
    if (commit.success) log.info(SCOPE, 'Transfer Alice→Bob committed ✓');
    else log.error(SCOPE, 'commit failed', commit.error);

    await showBalances();
  };

  const txRollback = async () => {
    const begin = await CapacitorSqlite.beginTransaction({ database: DB });
    if (!begin.success) { log.error(SCOPE, 'beginTransaction failed', begin.error); return; }

    await CapacitorSqlite.run({ database: DB, statement: 'UPDATE accounts SET balance = balance - ? WHERE id = ?', values: [9999, 1] });
    log.info(SCOPE, 'UPDATE sent (balance would go negative)');

    const rollback = await CapacitorSqlite.rollbackTransaction({ database: DB });
    if (rollback.success) log.info(SCOPE, 'rollbackTransaction ✓ — balances restored');
    else log.error(SCOPE, 'rollback failed', rollback.error);

    await showBalances();
  };

  const txConstraintViolation = async () => {
    const begin = await CapacitorSqlite.beginTransaction({ database: DB });
    if (!begin.success) { log.error(SCOPE, 'beginTransaction failed', begin.error); return; }

    const r = await CapacitorSqlite.run({
      database: DB,
      statement: 'UPDATE accounts SET balance = -100 WHERE id = 1',
    });
    if (!r.success) {
      log.info(SCOPE, `run() during tx → error (${r.error.code}): CHECK constraint ✓`, r.error.message);
    } else {
      log.warn(SCOPE, 'run() succeeded unexpectedly (deferred constraint?)');
    }

    const rb = await CapacitorSqlite.rollbackTransaction({ database: DB });
    if (rb.success) log.info(SCOPE, 'rolled back after constraint violation ✓');
    else log.error(SCOPE, 'rollback failed', rb.error);
  };

  const beginTwice = async () => {
    const r1 = await CapacitorSqlite.beginTransaction({ database: DB });
    if (!r1.success) { log.error(SCOPE, 'first begin failed', r1.error); return; }
    log.info(SCOPE, 'first beginTransaction → OK');

    const r2 = await CapacitorSqlite.beginTransaction({ database: DB });
    if (!r2.success)
      log.info(SCOPE, `second beginTransaction → ${r2.error.code} (expected TRANSACTION_FAILED) ✓`, r2.error.message);
    else
      log.warn(SCOPE, 'second beginTransaction succeeded unexpectedly (nested tx?)');

    await CapacitorSqlite.rollbackTransaction({ database: DB });
  };

  const commitWithoutBegin = async () => {
    const r = await CapacitorSqlite.commitTransaction({ database: DB });
    if (!r.success)
      log.info(SCOPE, `commitTransaction without begin → ${r.error.code} ✓`, r.error.message);
    else
      log.warn(SCOPE, 'commitTransaction without begin unexpectedly succeeded');
  };

  const rollbackWithoutBegin = async () => {
    const r = await CapacitorSqlite.rollbackTransaction({ database: DB });
    if (!r.success)
      log.info(SCOPE, `rollbackTransaction without begin → ${r.error.code} ✓`, r.error.message);
    else
      log.warn(SCOPE, 'rollbackTransaction without begin unexpectedly succeeded');
  };

  const executeInsideTx = async () => {
    const begin = await CapacitorSqlite.beginTransaction({ database: DB });
    if (!begin.success) { log.error(SCOPE, 'begin failed', begin.error); return; }

    const r = await CapacitorSqlite.execute({
      database: DB,
      statements: [
        'UPDATE accounts SET balance = balance + 50 WHERE id = 1',
        'UPDATE accounts SET balance = balance - 50 WHERE id = 2',
      ],
    });
    if (r.success)
      log.info(SCOPE, `execute() inside manual tx → changes=${r.data.changes} ✓`);
    else {
      log.error(SCOPE, 'execute() inside tx failed', r.error);
      await CapacitorSqlite.rollbackTransaction({ database: DB });
      return;
    }

    const commit = await CapacitorSqlite.commitTransaction({ database: DB });
    if (commit.success) log.info(SCOPE, 'committed outer tx ✓');
    else log.error(SCOPE, 'commit failed', commit.error);

    await showBalances();
  };

  const closeAutoRollback = async () => {
    const open = await CapacitorSqlite.open({ database: 'tx_close_test' });
    if (!open.success) { log.error(SCOPE, 'open failed', open.error); return; }

    await CapacitorSqlite.execute({
      database: 'tx_close_test',
      statements: ['CREATE TABLE IF NOT EXISTS t (v INTEGER)'],
    });

    await CapacitorSqlite.beginTransaction({ database: 'tx_close_test' });
    await CapacitorSqlite.run({ database: 'tx_close_test', statement: 'INSERT INTO t VALUES (42)' });
    log.info(SCOPE, 'Inserted 42 inside open transaction, now closing without commit...');

    await CapacitorSqlite.close({ database: 'tx_close_test' });

    const open2 = await CapacitorSqlite.open({ database: 'tx_close_test' });
    if (!open2.success) { log.error(SCOPE, 'reopen failed', open2.error); return; }
    const check = await CapacitorSqlite.query({ database: 'tx_close_test', statement: 'SELECT * FROM t' });
    if (check.success) {
      if (check.data.rows.length === 0)
        log.info(SCOPE, 'No rows after close-without-commit → auto-rollback ✓');
      else
        log.warn(SCOPE, 'Rows survived close-without-commit (WAL flush?)', check.data.rows);
    }
    await CapacitorSqlite.close({ database: 'tx_close_test' });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button type={isSetup ? 'red' : 'green'} onClick={isSetup ? teardown : setup}>
          {isSetup ? 'Teardown' : 'Setup (accounts table)'}
        </Button>
        {isSetup && <span className="text-xs text-emerald-700 font-semibold">● DB open</span>}
        {isSetup && <Button onClick={showBalances}>Show balances</Button>}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">Manual transactions</h3>
        <div className="flex flex-wrap gap-2">
          <Button type="green" onClick={txCommit} disabled={!isSetup}>
            Transfer (commit)
          </Button>
          <Button type="yellow" onClick={txRollback} disabled={!isSetup}>
            Transfer (rollback)
          </Button>
          <Button type="yellow" onClick={txConstraintViolation} disabled={!isSetup}>
            Constraint violation in tx
          </Button>
          <Button onClick={executeInsideTx} disabled={!isSetup}>
            execute() inside manual tx
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">Error cases</h3>
        <div className="flex flex-wrap gap-2">
          <Button type="yellow" onClick={beginTwice} disabled={!isSetup}>
            beginTransaction twice
          </Button>
          <Button type="yellow" onClick={commitWithoutBegin} disabled={!isSetup}>
            commit without begin
          </Button>
          <Button type="yellow" onClick={rollbackWithoutBegin} disabled={!isSetup}>
            rollback without begin
          </Button>
          <Button type="yellow" onClick={closeAutoRollback}>
            close() auto-rollback
          </Button>
        </div>
      </div>
    </div>
  );
};

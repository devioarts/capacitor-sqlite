import React, { useState } from 'react';
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite';
import { Button } from '../components/Button.tsx';
import { Input, Label, TextArea } from '../components/Input.tsx';
import { useLogger } from '../components/Logger.tsx';

const DB = 'crud_demo';
const SCOPE = 'crud';

export const PageCrud: React.FC = () => {
  const log = useLogger();
  const [isSetup, setIsSetup] = useState(false);
  const [runSql, setRunSql] = useState("INSERT INTO users (name, email) VALUES (?, ?)");
  const [runValues, setRunValues] = useState('["Alice", "alice@example.com"]');
  const [querySql, setQuerySql] = useState("SELECT * FROM users ORDER BY id DESC LIMIT 10");
  const [queryValues, setQueryValues] = useState('[]');
  const [execSql, setExecSql] = useState(
    "CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT)"
  );

  const setup = async () => {
    const open = await CapacitorSqlite.open({ database: DB });
    if (!open.success) { log.error(SCOPE, 'open failed', open.error); return; }

    const r = await CapacitorSqlite.execute({
      database: DB,
      statements: [
        'DROP TABLE IF EXISTS users',
        `CREATE TABLE users (
           id    INTEGER PRIMARY KEY AUTOINCREMENT,
           name  TEXT    NOT NULL,
           email TEXT
         )`,
      ],
    });
    if (r.success) {
      log.info(SCOPE, 'Schema created ✓', { changes: r.data.changes });
      setIsSetup(true);
    } else {
      log.error(SCOPE, 'setup failed', r.error);
    }
  };

  const teardown = async () => {
    await CapacitorSqlite.close({ database: DB });
    setIsSetup(false);
    log.info(SCOPE, 'Database closed');
  };

  const doRun = async () => {
    let values: unknown[];
    try { values = JSON.parse(runValues); } catch { log.error(SCOPE, 'Invalid JSON in values'); return; }

    const r = await CapacitorSqlite.run({
      database: DB,
      statement: runSql,
      values: values as never,
    });
    if (r.success)
      log.info(SCOPE, `run() → changes=${r.data.changes}, lastInsertId=${r.data.lastInsertId}`, r.data);
    else log.error(SCOPE, 'run() failed', r.error);
  };

  const doQuery = async () => {
    let values: unknown[];
    try { values = JSON.parse(queryValues); } catch { log.error(SCOPE, 'Invalid JSON in values'); return; }

    const r = await CapacitorSqlite.query({
      database: DB,
      statement: querySql,
      values: values as never,
    });
    if (r.success)
      log.info(SCOPE, `query() → ${r.data.rows.length} rows`, r.data.rows);
    else log.error(SCOPE, 'query() failed', r.error);
  };

  const doExec = async () => {
    const statements = execSql.split(';').map(s => s.trim()).filter(Boolean);
    const r = await CapacitorSqlite.execute({ database: DB, statements });
    if (r.success)
      log.info(SCOPE, `execute() → changes=${r.data.changes}`, r.data);
    else log.error(SCOPE, 'execute() failed', r.error);
  };

  const demoInsertUpdate = async () => {
    const ins = await CapacitorSqlite.run({
      database: DB,
      statement: 'INSERT INTO users (name, email) VALUES (?, ?)',
      values: ['Bob', 'bob@example.com'],
    });
    if (!ins.success) { log.error(SCOPE, 'INSERT failed', ins.error); return; }
    log.info(SCOPE, `INSERT → lastInsertId=${ins.data.lastInsertId} ✓`);

    const upd = await CapacitorSqlite.run({
      database: DB,
      statement: 'UPDATE users SET email = ? WHERE id = ?',
      values: ['bob2@example.com', ins.data.lastInsertId],
    });
    if (!upd.success) { log.error(SCOPE, 'UPDATE failed', upd.error); return; }
    log.info(SCOPE, `UPDATE → changes=${upd.data.changes}, lastInsertId=${upd.data.lastInsertId} (should be 0) ✓`);

    const del = await CapacitorSqlite.run({
      database: DB,
      statement: 'DELETE FROM users WHERE id = ?',
      values: [ins.data.lastInsertId],
    });
    if (!del.success) { log.error(SCOPE, 'DELETE failed', del.error); return; }
    log.info(SCOPE, `DELETE → changes=${del.data.changes} ✓`);
  };

  const demoNullParam = async () => {
    const r = await CapacitorSqlite.run({
      database: DB,
      statement: 'INSERT INTO users (name, email) VALUES (?, ?)',
      values: ['NullEmail', null],
    });
    if (r.success) log.info(SCOPE, `INSERT with null param → id=${r.data.lastInsertId} ✓`);
    else log.error(SCOPE, 'INSERT with null failed', r.error);
  };

  const demoExecuteRollback = async () => {
    const r = await CapacitorSqlite.execute({
      database: DB,
      statements: [
        "INSERT INTO users (name) VALUES ('willRollback')",
        "INSERT INTO users (name) VALUES (NULL)",   // violates NOT NULL
      ],
      transaction: true,
    });
    if (!r.success && r.error.code === 'EXECUTE_FAILED')
      log.info(SCOPE, `execute rollback on NOT NULL violation → EXECUTE_FAILED ✓`, r.error.message);
    else log.error(SCOPE, 'Expected EXECUTE_FAILED', r);

    const check = await CapacitorSqlite.query({
      database: DB,
      statement: "SELECT name FROM users WHERE name='willRollback'",
    });
    if (check.success && check.data.rows.length === 0)
      log.info(SCOPE, 'Row not persisted after rollback ✓');
    else log.warn(SCOPE, 'Unexpected rows after rollback', check);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button type={isSetup ? 'red' : 'green'} onClick={isSetup ? teardown : setup}>
          {isSetup ? 'Teardown (close)' : 'Setup (open + create schema)'}
        </Button>
        {isSetup && <span className="text-xs text-emerald-700 font-semibold">● DB open</span>}
      </div>

      {/* Custom run */}
      <div className="space-y-2 border border-slate-200 rounded-lg p-3">
        <h3 className="text-sm font-semibold text-slate-700">run() — parameterized DML</h3>
        <Label label="SQL">
          <Input value={runSql} onChange={(e) => setRunSql(e.target.value)} />
        </Label>
        <Label label="Values (JSON array)">
          <Input value={runValues} onChange={(e) => setRunValues(e.target.value)} />
        </Label>
        <Button type="green" onClick={doRun} disabled={!isSetup}>run()</Button>
      </div>

      {/* Custom query */}
      <div className="space-y-2 border border-slate-200 rounded-lg p-3">
        <h3 className="text-sm font-semibold text-slate-700">query() — SELECT</h3>
        <Label label="SQL">
          <TextArea rows={2} value={querySql} onChange={(e) => setQuerySql(e.target.value)} />
        </Label>
        <Label label="Values (JSON array)">
          <Input value={queryValues} onChange={(e) => setQueryValues(e.target.value)} />
        </Label>
        <Button type="primary" onClick={doQuery} disabled={!isSetup}>query()</Button>
      </div>

      {/* Custom execute */}
      <div className="space-y-2 border border-slate-200 rounded-lg p-3">
        <h3 className="text-sm font-semibold text-slate-700">execute() — DDL / no-param DML</h3>
        <Label label="SQL (split by ';')">
          <TextArea rows={2} value={execSql} onChange={(e) => setExecSql(e.target.value)} />
        </Label>
        <Button type="neutral" onClick={doExec} disabled={!isSetup}>execute()</Button>
      </div>

      {/* Demos */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">Quick demos</h3>
        <div className="flex flex-wrap gap-2">
          <Button onClick={demoInsertUpdate} disabled={!isSetup}>INSERT → UPDATE → DELETE</Button>
          <Button onClick={demoNullParam} disabled={!isSetup}>INSERT with NULL param</Button>
          <Button type="yellow" onClick={demoExecuteRollback} disabled={!isSetup}>
            execute rollback on error
          </Button>
        </div>
      </div>
    </div>
  );
};

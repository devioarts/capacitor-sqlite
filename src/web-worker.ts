import sqlite3InitModule, { type Database, type ExecOptions } from '@sqlite.org/sqlite-wasm';

// Keep the worker1 envelope used by sqlite3Worker1Promiser, adding SQLite's actual
// transaction state to both successful replies and SQL errors.
interface WorkerRequest {
  type: string;
  messageId: string;
  dbId?: string;
  args: ExecOptions & { filename?: string; countChanges?: number; lastInsertRowId?: boolean };
}

void sqlite3InitModule().then((sqlite3) => {
  const databases = new Map<string, Database>();
  let nextDbId = 0;

  globalThis.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
    const { type, messageId, args } = data;
    let dbId = data.dbId;
    let db = dbId ? databases.get(dbId) : undefined;
    try {
      let result: Record<string, unknown>;
      switch (type) {
        case 'open': {
          db = new sqlite3.oo1.DB({ filename: args.filename });
          dbId = `db#${++nextDbId}`;
          databases.set(dbId, db);
          result = { dbId, filename: db.filename };
          break;
        }
        case 'close': {
          if (!db) throw new Error(`Unknown database '${dbId}'`);
          const filename = db.filename;
          db.close();
          databases.delete(dbId!);
          db = undefined;
          result = { filename };
          break;
        }
        case 'exec': {
          if (!db) throw new Error(`Unknown database '${dbId}'`);
          const before = args.countChanges ? db.changes(true, true) : undefined;
          result = { ...args };
          if (args.returnValue === 'resultRows') {
            result.resultRows = db.exec(args.sql!, { bind: args.bind, rowMode: 'object', returnValue: 'resultRows' });
          } else {
            db.exec(args.sql!, { bind: args.bind });
          }
          if (before !== undefined) result.changeCount = db.changes(true, true) - before;
          if (args.lastInsertRowId) result.lastInsertRowId = sqlite3.capi.sqlite3_last_insert_rowid(db.pointer!);
          break;
        }
        default:
          throw new Error(`Unknown SQLite worker method '${type}'`);
      }
      globalThis.postMessage({
        type,
        messageId,
        dbId,
        result,
        inTransaction: db?.pointer ? sqlite3.capi.sqlite3_get_autocommit(db.pointer) === 0 : false,
      });
    } catch (error) {
      globalThis.postMessage({
        type: 'error',
        messageId,
        dbId,
        result: { message: error instanceof Error ? error.message : String(error) },
        inTransaction: db?.pointer ? sqlite3.capi.sqlite3_get_autocommit(db.pointer) === 0 : false,
      });
    }
  };
  globalThis.postMessage({ type: 'sqlite3-api', result: 'worker1-ready' });
});

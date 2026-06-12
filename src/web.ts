import { WebPlugin } from '@capacitor/core';
import { sqlite3Worker1Promiser } from '@sqlite.org/sqlite-wasm';

import type {
  CapacitorSqlitePlugin,
  ExecuteOptions,
  Migration,
  OpenOptions,
  QueryOptions,
  RunBatchOptions,
  RunOptions,
  SqliteErrorCode,
  SqliteFailure,
  SqlitePlatform,
  SqliteResult,
  SqliteSuccess,
} from './definitions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Promiser = (type: string, args?: any) => Promise<any>;

interface DbEntry {
  dbId: string;
  readonly: boolean;
  inTransaction: boolean;
}

const SAFE_DB_NAME = /^[A-Za-z0-9_-]+$/;
const WORKER_READY_TIMEOUT_MS = 10_000;

class SqliteRuntimeError extends Error {
  constructor(
    readonly code: SqliteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function assertPlainObject(value: unknown, method: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SqliteRuntimeError('INVALID_PARAMS', `${method}: options must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function validateName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SqliteRuntimeError('INVALID_PARAMS', "'database' is required");
  }
  if (value !== ':memory:' && !SAFE_DB_NAME.test(value)) {
    throw new SqliteRuntimeError('INVALID_NAME', `Invalid database name '${value}'. Use only A-Z, a-z, 0-9, _ or -`);
  }
  return value;
}

function validateSql(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SqliteRuntimeError('INVALID_PARAMS', `'${label}' is required`);
  }
  return value;
}

function validateValues(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SqliteRuntimeError('INVALID_PARAMS', `'${label}' must be an array`);
  }
  value.forEach((item, index) => {
    const valid =
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      item instanceof Uint8Array ||
      (typeof item === 'number' && Number.isFinite(item));
    if (!valid) {
      throw new SqliteRuntimeError('INVALID_PARAMS', `'${label}[${index}]' has an unsupported value type`);
    }
  });
  return value;
}

function validateStatements(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SqliteRuntimeError('INVALID_PARAMS', "'statements' must be a non-empty array");
  }
  return value.map((item, index) => validateSql(item, `statements[${index}]`));
}

function validateMigrations(value: unknown): Migration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SqliteRuntimeError('MIGRATION_FAILED', "'migrations' must be an array");
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new SqliteRuntimeError('MIGRATION_FAILED', `Migration at index ${index}: entry must be an object`);
    }
    const migration = item as Record<string, unknown>;
    if (!Number.isInteger(migration.version) || (migration.version as number) < 1) {
      throw new SqliteRuntimeError(
        'MIGRATION_FAILED',
        `Migration at index ${index}: 'version' must be a positive integer`,
      );
    }
    if (!Array.isArray(migration.statements) || migration.statements.length === 0) {
      throw new SqliteRuntimeError(
        'MIGRATION_FAILED',
        `Migration at index ${index}: 'statements' must be a non-empty array`,
      );
    }
    const statements = migration.statements.map((sql, statementIndex) =>
      validateSql(sql, `migrations[${index}].statements[${statementIndex}]`),
    );
    return { version: migration.version as number, statements };
  });
}

function validateRunBatchSet(value: unknown): { statement: string; values?: unknown[] }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SqliteRuntimeError('INVALID_PARAMS', "'set' must be a non-empty array");
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new SqliteRuntimeError('INVALID_PARAMS', `set[${index}] must be an object`);
    }
    const batchItem = item as Record<string, unknown>;
    return {
      statement: validateSql(batchItem.statement, `set[${index}].statement`),
      values: validateValues(batchItem.values, `set[${index}].values`),
    };
  });
}

function errorCode(err: unknown, fallback: SqliteErrorCode): SqliteErrorCode {
  const message = extractMessage(err).toLowerCase();
  if (message.includes('transaction is already active')) return 'TRANSACTION_FAILED';
  if (message.includes('cannot start a transaction within a transaction')) return 'TRANSACTION_FAILED';
  if (message.includes('no transaction is active')) return 'TRANSACTION_FAILED';
  return err instanceof SqliteRuntimeError ? err.code : fallback;
}

export class CapacitorSqliteWeb extends WebPlugin implements CapacitorSqlitePlugin {
  private promiser: Promiser | null = null;
  // Stores the in-flight init Promise so concurrent callers coalesce on one worker.
  private initPromise: Promise<Promiser> | null = null;

  private openDbs = new Map<string, DbEntry>();
  // Stores in-flight open Promises so concurrent open() calls for the same db coalesce.
  private pendingOpens = new Map<string, Promise<SqliteResult>>();
  private pendingOpenModes = new Map<string, boolean>();
  private spCounter = 0;
  // Per-database serial queue: ensures only one operation runs at a time on each connection.
  private dbQueues = new Map<string, Promise<void>>();

  // MARK: - Unified response helpers

  private ok<T extends Record<string, unknown>>(data: T): SqliteSuccess<T> {
    return { success: true, data };
  }

  private okEmpty(): SqliteSuccess<Record<string, never>> {
    return { success: true, data: {} as Record<string, never> };
  }

  private err(code: SqliteErrorCode, method: string, err: unknown): SqliteFailure {
    return { success: false, error: { code, message: extractMessage(err), platform: 'web', method, details: {} } };
  }

  private enqueue<T>(database: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.dbQueues.get(database) ?? Promise.resolve();
    const next = prev.then(
      () => fn(),
      () => fn(),
    );
    this.dbQueues.set(
      database,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // MARK: - getPlatform

  async getPlatform(): Promise<SqliteResult<{ platform: SqlitePlatform }>> {
    return this.ok({ platform: 'web' });
  }

  // MARK: - isAvailable

  async isAvailable(): Promise<SqliteResult<{ available: boolean }>> {
    try {
      await this.getOrCreatePromiser();
      // OPFS is required for persistent file-based databases on web
      await navigator.storage.getDirectory();
      return this.ok({ available: true });
    } catch {
      return this.ok({ available: false });
    }
  }

  // MARK: - open

  async open(options: OpenOptions): Promise<SqliteResult> {
    let database: string;
    let readonly: boolean;
    let migrations: Migration[];
    try {
      const opts = assertPlainObject(options, 'open');
      database = validateName(opts.database);
      readonly = opts.readonly === true;
      migrations = validateMigrations(opts.migrations);
    } catch (err) {
      return this.err(errorCode(err, 'INVALID_NAME'), 'open', err);
    }

    const openModeError = this.openModeError(database, readonly);
    if (openModeError) return openModeError;
    if (this.openDbs.has(database)) return this.okEmpty();

    // Coalesce concurrent open() calls for the same database name.
    const pending = this.pendingOpens.get(database);
    if (pending) {
      const pendingReadonly = this.pendingOpenModes.get(database);
      if (pendingReadonly !== readonly) {
        return this.err(
          'DB_ALREADY_OPEN',
          'open',
          new Error(
            `open: database '${database}' is already opening as ${pendingReadonly ? 'readonly' : 'read/write'}`,
          ),
        );
      }
      return pending;
    }

    const openOp = this._doOpen(database, readonly, migrations).finally(() => {
      this.pendingOpens.delete(database);
      this.pendingOpenModes.delete(database);
    });
    this.pendingOpens.set(database, openOp);
    this.pendingOpenModes.set(database, readonly);
    return openOp;
  }

  private async _doOpen(database: string, readonly: boolean, migrations: Migration[]): Promise<SqliteResult> {
    let openedDbId: string | null = null;
    let promiserForCleanup: Promiser | null = null;
    try {
      // Re-check after the Promise is scheduled — a previous open may have completed.
      if (this.openDbs.has(database)) return this.okEmpty();

      const promiser = await this.getOrCreatePromiser();
      promiserForCleanup = promiser;

      // Re-check after awaiting the promiser.
      const openModeError = this.openModeError(database, readonly);
      if (openModeError) return openModeError;
      if (this.openDbs.has(database)) return this.okEmpty();

      const isMemory = database === ':memory:';
      const res = await promiser('open', {
        filename: isMemory ? ':memory:' : `file:${database}.db?vfs=opfs`,
      });
      const dbId: string = res.dbId;
      openedDbId = dbId;

      if (!readonly) {
        await execSql(promiser, dbId, 'PRAGMA foreign_keys = ON');
        if (migrations.length) {
          await this.runMigrations(promiser, dbId, migrations);
        }
      }
      this.openDbs.set(database, { dbId, readonly, inTransaction: false });
      return this.okEmpty();
    } catch (err) {
      if (openedDbId && promiserForCleanup) {
        try {
          await promiserForCleanup('close', { dbId: openedDbId });
        } catch {
          /* ignore cleanup error */
        }
      }
      this.openDbs.delete(database);
      const code: SqliteErrorCode = errorCode(
        err,
        err instanceof Error && err.message.includes('Migration') ? 'MIGRATION_FAILED' : 'OPEN_FAILED',
      );
      return this.err(code, 'open', err);
    }
  }

  // MARK: - close

  async close(options: { database: string }): Promise<SqliteResult> {
    let database: string;
    try {
      database = validateName(assertPlainObject(options, 'close').database);
    } catch (err) {
      return this.err(errorCode(err, 'INVALID_NAME'), 'close', err);
    }
    return this.enqueue(database, async () => {
      try {
        const { entry, promiser } = this.requireOpen(database, 'close');
        if (entry.inTransaction) {
          try {
            await execSql(promiser, entry.dbId, 'ROLLBACK');
          } catch {
            /* ignore rollback error */
          }
        }
        const { dbId } = entry;
        await promiser('close', { dbId });
        this.openDbs.delete(database);
        this.dbQueues.delete(database);
        return this.okEmpty();
      } catch (err) {
        return this.err(errorCode(err, 'CLOSE_FAILED'), 'close', err);
      }
    });
  }

  // MARK: - isOpen

  async isOpen(options: { database: string }): Promise<SqliteResult<{ open: boolean }>> {
    try {
      const opts = assertPlainObject(options, 'isOpen');
      const database = validateName(opts.database);
      return this.ok({ open: this.openDbs.has(database) });
    } catch (err) {
      return this.err(errorCode(err, 'INVALID_NAME'), 'isOpen', err);
    }
  }

  // MARK: - getVersion

  async getVersion(options: { database: string }): Promise<SqliteResult<{ version: string }>> {
    let database: string;
    try {
      database = validateName(assertPlainObject(options, 'getVersion').database);
    } catch (err) {
      return this.err(errorCode(err, 'INVALID_NAME'), 'getVersion', err);
    }
    return this.enqueue(database, async () => {
      try {
        const { entry, promiser } = this.requireOpen(database, 'getVersion');
        const { dbId } = entry;
        const [row] = await selectRows<{ version: string }>(promiser, dbId, 'SELECT sqlite_version() AS version');
        return this.ok({ version: row?.version ?? '' });
      } catch (err) {
        return this.err(errorCode(err, 'VERSION_FAILED'), 'getVersion', err);
      }
    });
  }

  // MARK: - getSchemaVersion

  async getSchemaVersion(options: { database: string }): Promise<SqliteResult<{ version: number }>> {
    let database: string;
    try {
      database = validateName(assertPlainObject(options, 'getSchemaVersion').database);
    } catch (err) {
      return this.err(errorCode(err, 'INVALID_NAME'), 'getSchemaVersion', err);
    }
    return this.enqueue(database, async () => {
      try {
        const { entry, promiser } = this.requireOpen(database, 'getSchemaVersion');
        const { dbId } = entry;
        const [row] = await selectRows<{ user_version: number }>(promiser, dbId, 'PRAGMA user_version');
        return this.ok({ version: row?.user_version ?? 0 });
      } catch (err) {
        return this.err(errorCode(err, 'SCHEMA_VERSION_FAILED'), 'getSchemaVersion', err);
      }
    });
  }

  // MARK: - vacuum

  async vacuum(options: { database: string }): Promise<SqliteResult> {
    let database: string;
    try {
      database = validateName(assertPlainObject(options, 'vacuum').database);
    } catch (err) {
      return this.err(errorCode(err, 'INVALID_NAME'), 'vacuum', err);
    }
    return this.enqueue(database, async () => {
      try {
        const { entry, promiser } = this.requireOpen(database, 'vacuum');
        const { dbId } = entry;
        await execSql(promiser, dbId, 'VACUUM');
        return this.okEmpty();
      } catch (err) {
        return this.err(errorCode(err, 'VACUUM_FAILED'), 'vacuum', err);
      }
    });
  }

  // MARK: - execute

  async execute(options: ExecuteOptions): Promise<SqliteResult<{ changes: number }>> {
    let database: string;
    let statements: string[];
    let transaction: boolean;
    try {
      const opts = assertPlainObject(options, 'execute');
      database = validateName(opts.database);
      statements = validateStatements(opts.statements);
      transaction = opts.transaction !== false;
    } catch (err) {
      return this.err(errorCode(err, 'INVALID_PARAMS'), 'execute', err);
    }
    return this.enqueue(database, async () => {
      try {
        const { entry, promiser } = this.requireOpen(database, 'execute');
        if (transaction && entry.inTransaction) {
          throw new SqliteRuntimeError(
            'TRANSACTION_FAILED',
            `execute: a transaction is already active on '${database}'`,
          );
        }
        const { dbId } = entry;
        const sp = transaction ? `sp_${++this.spCounter}` : null;
        if (sp) await execSql(promiser, dbId, `SAVEPOINT "${sp}"`);
        try {
          let total = 0;
          for (const sql of statements) {
            const trimmed = sql.trim();
            await execSql(promiser, dbId, trimmed);
            const [row] = await selectRows<{ c: number }>(promiser, dbId, 'SELECT changes() AS c');
            total += row?.c ?? 0;
          }
          if (sp) await execSql(promiser, dbId, `RELEASE "${sp}"`);
          return this.ok({ changes: total });
        } catch (innerErr) {
          if (sp) {
            try {
              await execSql(promiser, dbId, `ROLLBACK TO "${sp}"`);
              await execSql(promiser, dbId, `RELEASE "${sp}"`);
            } catch {
              /* ignore */
            }
          }
          throw innerErr;
        }
      } catch (err) {
        return this.err(errorCode(err, 'EXECUTE_FAILED'), 'execute', err);
      }
    });
  }

  // MARK: - run

  async run(options: RunOptions): Promise<SqliteResult<{ changes: number; lastInsertId: number }>> {
    let database: string;
    let statement: string;
    let values: unknown[];
    try {
      const opts = assertPlainObject(options, 'run');
      database = validateName(opts.database);
      statement = validateSql(opts.statement, 'statement');
      values = validateValues(opts.values, 'values');
    } catch (err) {
      return this.err(errorCode(err, 'INVALID_PARAMS'), 'run', err);
    }
    return this.enqueue(database, async () => {
      try {
        const { entry, promiser } = this.requireOpen(database, 'run');
        const { dbId } = entry;
        await execSql(promiser, dbId, statement, values);
        const [row] = await selectRows<{ c: number; id: number }>(
          promiser,
          dbId,
          'SELECT changes() AS c, last_insert_rowid() AS id',
        );
        const changes = row?.c ?? 0;
        return this.ok({ changes, lastInsertId: isInsertStatement(statement) && changes > 0 ? (row?.id ?? 0) : 0 });
      } catch (err) {
        return this.err(errorCode(err, 'EXECUTE_FAILED'), 'run', err);
      }
    });
  }

  // MARK: - runBatch

  async runBatch(options: RunBatchOptions): Promise<SqliteResult<{ changes: number; lastInsertId: number }>> {
    let database: string;
    let set: { statement: string; values?: unknown[] }[];
    let transaction: boolean;
    try {
      const opts = assertPlainObject(options, 'runBatch');
      database = validateName(opts.database);
      set = validateRunBatchSet(opts.set);
      transaction = opts.transaction !== false;
    } catch (err) {
      return this.err(errorCode(err, 'INVALID_PARAMS'), 'runBatch', err);
    }
    return this.enqueue(database, async () => {
      try {
        const { entry, promiser } = this.requireOpen(database, 'runBatch');
        if (transaction && entry.inTransaction) {
          throw new SqliteRuntimeError(
            'TRANSACTION_FAILED',
            `runBatch: a transaction is already active on '${database}'`,
          );
        }
        const { dbId } = entry;
        const sp = transaction ? `sp_${++this.spCounter}` : null;
        if (sp) await execSql(promiser, dbId, `SAVEPOINT "${sp}"`);
        try {
          let totalChanges = 0;
          for (const item of set) {
            await execSql(promiser, dbId, item.statement, item.values ?? []);
            const [row] = await selectRows<{ c: number }>(promiser, dbId, 'SELECT changes() AS c');
            totalChanges += row?.c ?? 0;
          }
          if (sp) await execSql(promiser, dbId, `RELEASE "${sp}"`);
          return this.ok({ changes: totalChanges, lastInsertId: 0 });
        } catch (innerErr) {
          if (sp) {
            try {
              await execSql(promiser, dbId, `ROLLBACK TO "${sp}"`);
              await execSql(promiser, dbId, `RELEASE "${sp}"`);
            } catch {
              /* ignore */
            }
          }
          throw innerErr;
        }
      } catch (err) {
        return this.err(errorCode(err, 'EXECUTE_FAILED'), 'runBatch', err);
      }
    });
  }

  // MARK: - query

  async query<T = Record<string, unknown>>(options: QueryOptions): Promise<SqliteResult<{ rows: T[] }>> {
    let database: string;
    let statement: string;
    let values: unknown[];
    try {
      const opts = assertPlainObject(options, 'query');
      database = validateName(opts.database);
      statement = validateSql(opts.statement, 'statement');
      values = validateValues(opts.values, 'values');
    } catch (err) {
      return this.err(errorCode(err, 'INVALID_PARAMS'), 'query', err);
    }
    return this.enqueue(database, async () => {
      try {
        const { entry, promiser } = this.requireOpen(database, 'query');
        const { dbId } = entry;
        const rows = await selectRows<T>(promiser, dbId, statement, values);
        return this.ok({ rows });
      } catch (err) {
        return this.err(errorCode(err, 'QUERY_FAILED'), 'query', err);
      }
    });
  }

  // MARK: - transactions

  async beginTransaction(options: { database: string }): Promise<SqliteResult> {
    let database: string;
    try {
      database = validateName(assertPlainObject(options, 'beginTransaction').database);
    } catch (err) {
      return this.err(errorCode(err, 'INVALID_NAME'), 'beginTransaction', err);
    }
    return this.enqueue(database, async () => {
      try {
        const { entry, promiser } = this.requireOpen(database, 'beginTransaction');
        if (entry.inTransaction) {
          throw new SqliteRuntimeError(
            'TRANSACTION_FAILED',
            `beginTransaction: a transaction is already active on '${database}'`,
          );
        }
        const { dbId } = entry;
        await execSql(promiser, dbId, 'BEGIN');
        entry.inTransaction = true;
        return this.okEmpty();
      } catch (err) {
        return this.err(errorCode(err, 'TRANSACTION_FAILED'), 'beginTransaction', err);
      }
    });
  }

  async commitTransaction(options: { database: string }): Promise<SqliteResult> {
    let database: string;
    try {
      database = validateName(assertPlainObject(options, 'commitTransaction').database);
    } catch (err) {
      return this.err(errorCode(err, 'INVALID_NAME'), 'commitTransaction', err);
    }
    return this.enqueue(database, async () => {
      try {
        const { entry, promiser } = this.requireOpen(database, 'commitTransaction');
        if (!entry.inTransaction) {
          throw new SqliteRuntimeError(
            'TRANSACTION_FAILED',
            `commitTransaction: no transaction is active on '${database}'`,
          );
        }
        const { dbId } = entry;
        await execSql(promiser, dbId, 'COMMIT');
        entry.inTransaction = false;
        return this.okEmpty();
      } catch (err) {
        return this.err(errorCode(err, 'TRANSACTION_FAILED'), 'commitTransaction', err);
      }
    });
  }

  async rollbackTransaction(options: { database: string }): Promise<SqliteResult> {
    let database: string;
    try {
      database = validateName(assertPlainObject(options, 'rollbackTransaction').database);
    } catch (err) {
      return this.err(errorCode(err, 'INVALID_NAME'), 'rollbackTransaction', err);
    }
    return this.enqueue(database, async () => {
      try {
        const { entry, promiser } = this.requireOpen(database, 'rollbackTransaction');
        if (!entry.inTransaction) {
          throw new SqliteRuntimeError(
            'TRANSACTION_FAILED',
            `rollbackTransaction: no transaction is active on '${database}'`,
          );
        }
        const { dbId } = entry;
        await execSql(promiser, dbId, 'ROLLBACK');
        entry.inTransaction = false;
        return this.okEmpty();
      } catch (err) {
        return this.err(errorCode(err, 'TRANSACTION_FAILED'), 'rollbackTransaction', err);
      }
    });
  }

  // MARK: - Private helpers

  private async runMigrations(promiser: Promiser, dbId: string, migrations: Migration[]): Promise<void> {
    const [row] = await selectRows<{ user_version: number }>(promiser, dbId, 'PRAGMA user_version');
    const current = row?.user_version ?? 0;

    const pending = [...migrations].filter((m) => m.version > current).sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      await execSql(promiser, dbId, 'BEGIN');
      try {
        for (const sql of migration.statements) {
          const trimmed = sql.trim();
          if (trimmed) await execSql(promiser, dbId, trimmed);
        }
        // Integer-cast version to prevent injection from malformed objects.
        await execSql(promiser, dbId, `PRAGMA user_version = ${migration.version | 0}`);
        await execSql(promiser, dbId, 'COMMIT');
      } catch (err) {
        try {
          await execSql(promiser, dbId, 'ROLLBACK');
        } catch {
          /* ignore rollback error */
        }
        throw new Error(`Migration v${migration.version} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private requireOpen(name: string, context: string): { entry: DbEntry; promiser: Promiser } {
    const entry = this.openDbs.get(name);
    if (!entry) {
      throw new SqliteRuntimeError('DB_NOT_OPEN', `${context}: database '${name}' is not open`);
    }
    if (!this.promiser) {
      throw new SqliteRuntimeError('UNKNOWN', `${context}: SQLite worker is not initialized for '${name}'`);
    }
    return { entry, promiser: this.promiser };
  }

  private openModeError(database: string, readonly: boolean): SqliteFailure | null {
    const existing = this.openDbs.get(database);
    if (!existing || existing.readonly === readonly) return null;
    return this.err(
      'DB_ALREADY_OPEN',
      'open',
      new Error(`open: database '${database}' is already open as ${existing.readonly ? 'readonly' : 'read/write'}`),
    );
  }

  private getOrCreatePromiser(): Promise<Promiser> {
    // Store the Promise itself (not the result) so concurrent callers coalesce
    // on a single worker — duplicate workers cause dbId collisions (sqlite-wasm #113).
    if (!this.initPromise) {
      this.initPromise = new Promise<Promiser>((resolve, reject) => {
        const holder: { ref?: Promiser } = {};
        const timeout = window.setTimeout(() => {
          reject(new Error(`sqlite worker did not become ready within ${WORKER_READY_TIMEOUT_MS}ms`));
        }, WORKER_READY_TIMEOUT_MS);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        holder.ref = sqlite3Worker1Promiser({
          onready: () => {
            window.clearTimeout(timeout);
            resolve(holder.ref as Promiser);
          },
        }) as any;
      })
        .then((p) => {
          this.promiser = p;
          return p;
        })
        .catch((err) => {
          this.initPromise = null;
          this.promiser = null;
          throw err;
        });
    }
    return this.initPromise;
  }
}

// Module-level helpers

// sqlite-wasm worker1 rejects with plain objects, not always Error instances.
// Shape: { type: 'error', result: { message: '...' } } or { message: '...' } or Error.
function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.result === 'object' && obj.result !== null) {
      const result = obj.result as Record<string, unknown>;
      if (typeof result.message === 'string') return result.message;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return '[unserializable error]';
    }
  }
  return String(err);
}

async function execSql(promiser: Promiser, dbId: string, sql: string, bind: unknown[] = []): Promise<void> {
  await promiser('exec', { dbId, sql, bind });
}

async function selectRows<T = Record<string, unknown>>(
  promiser: Promiser,
  dbId: string,
  sql: string,
  bind: unknown[] = [],
): Promise<T[]> {
  const res = await promiser('exec', {
    dbId,
    sql,
    bind,
    returnValue: 'resultRows',
    rowMode: 'object',
  });
  // The worker1 message spec nests exec results under .result; guard both shapes.
  const rows = res?.result?.resultRows ?? res?.resultRows;
  if (!Array.isArray(rows)) return [];
  return rows as T[];
}

function isInsertStatement(sql: string): boolean {
  const stmtType = sql.trim().split(/\s+/, 1)[0]?.toUpperCase();
  return stmtType === 'INSERT' || stmtType === 'REPLACE';
}

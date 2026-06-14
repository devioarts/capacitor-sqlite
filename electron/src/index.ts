// Electron main-process plugin for @devioarts/capacitor-sqlite.
// Use the generated electron-main.ts (npm run update) for automatic setup.

import { app } from 'electron';
import * as fs from 'fs';
import type * as SqliteType from 'node:sqlite';
import * as nodePath from 'path';

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
} from '../../src/definitions';


type DatabaseSync = InstanceType<typeof SqliteType.DatabaseSync>;
type SQLiteValue = string | number | boolean | null | Uint8Array | number[];
type NodeSQLiteValue = null | number | string | bigint | Uint8Array;
type SQLiteValues = SQLiteValue[];

interface RunBatchItem {
  statement: string;
  values: SQLiteValues;
}

interface DatabaseEntry {
  db: DatabaseSync;
  readonly: boolean;
  inTransaction: boolean;
}

const SAFE_DB_NAME = /^[A-Za-z0-9_-]+$/;

let sqliteModule: typeof SqliteType | null = null;
let sqliteLoadError: Error | null = null;

class SqliteRuntimeError extends Error {
  constructor(
    readonly code: SqliteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function loadSqlite(): typeof SqliteType {
  if (sqliteModule) return sqliteModule;
  if (sqliteLoadError) {
    throw new SqliteRuntimeError('NOT_AVAILABLE', sqliteLoadError.message);
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sqliteModule = require('node:sqlite') as typeof SqliteType;
    return sqliteModule;
  } catch {
    sqliteLoadError = new Error(
      'capacitor-sqlite: node:sqlite is not available. Electron with Node 24+ is required. ' +
        `Current Node version: ${process.version}`,
    );
    throw new SqliteRuntimeError('NOT_AVAILABLE', sqliteLoadError.message);
  }
}

function isSqliteAvailable(): boolean {
  try {
    loadSqlite();
    return true;
  } catch {
    return false;
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

function isByteArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255);
}

function validateValues(value: unknown, label: string): SQLiteValues {
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
      isByteArray(item) ||
      (typeof item === 'number' && Number.isFinite(item));
    if (!valid) {
      throw new SqliteRuntimeError('INVALID_PARAMS', `'${label}[${index}]' has an unsupported value type`);
    }
  });
  return value as SQLiteValues;
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

function validateRunBatchSet(value: unknown): RunBatchItem[] {
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
  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    if (message.includes('transaction is already active')) return 'TRANSACTION_FAILED';
    if (message.includes('cannot start a transaction within a transaction')) return 'TRANSACTION_FAILED';
    if (message.includes('no transaction is active')) return 'TRANSACTION_FAILED';
  }
  return err instanceof SqliteRuntimeError ? err.code : fallback;
}

export class CapacitorSqlite implements CapacitorSqlitePlugin {
  private databases = new Map<string, DatabaseEntry>();
  // Coalesces concurrent open() calls for the same database.
  private pendingOpens = new Map<string, Promise<SqliteResult>>();
  private pendingOpenModes = new Map<string, boolean>();

  // MARK: - Unified response helpers

  private ok<T extends Record<string, unknown>>(data: T): SqliteSuccess<T> {
    return { success: true, data };
  }

  private okEmpty(): SqliteSuccess<Record<string, never>> {
    return { success: true, data: {} as Record<string, never> };
  }

  private err(code: SqliteErrorCode, method: string, err: unknown): SqliteFailure {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: { code, message, platform: 'electron', method, details: {} } };
  }

  // MARK: - getPlatform

  async getPlatform(): Promise<SqliteResult<{ platform: SqlitePlatform }>> {
    return this.ok({ platform: 'electron' });
  }

  // MARK: - isAvailable

  async isAvailable(): Promise<SqliteResult<{ available: boolean }>> {
    return this.ok({ available: isSqliteAvailable() });
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
    if (this.databases.has(database)) return this.okEmpty();

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
    let db: DatabaseSync | null = null;
    try {
      const openModeError = this.openModeError(database, readonly);
      if (openModeError) return openModeError;
      if (this.databases.has(database)) return this.okEmpty();

      const sqlite = loadSqlite();
      const dbPath = database === ':memory:' ? ':memory:' : this.databasePath(database);
      db = new sqlite.DatabaseSync(dbPath, {
        readOnly: readonly,
        enableForeignKeyConstraints: !readonly,
      });

      if (!readonly) {
        // Skip WAL for in-memory databases.
        if (dbPath !== ':memory:') {
          db.exec('PRAGMA journal_mode = WAL');
        }
        if (migrations.length) {
          this.runMigrations(db, migrations);
        }
      }

      this.databases.set(database, { db, readonly, inTransaction: false });
      db = null;
      return this.okEmpty();
    } catch (err) {
      if (db) {
        try {
          db.close();
        } catch {
          /* ignore cleanup error */
        }
      }
      this.databases.delete(database);
      const code = errorCode(
        err,
        err instanceof Error && err.message.includes('Migration') ? 'MIGRATION_FAILED' : 'OPEN_FAILED',
      );
      return this.err(code, 'open', err);
    }
  }

  // MARK: - close

  async close(options: { database: string }): Promise<SqliteResult> {
    try {
      const opts = assertPlainObject(options, 'close');
      const database = validateName(opts.database);
      const entry = this.requireOpenEntry(database, 'close');
      this.databases.delete(database);
      if (entry.inTransaction) {
        try {
          entry.db.exec('ROLLBACK');
        } catch {
          /* ignore rollback error */
        }
      }
      entry.db.close();
      return this.okEmpty();
    } catch (err) {
      return this.err(errorCode(err, 'CLOSE_FAILED'), 'close', err);
    }
  }

  // MARK: - isOpen

  async isOpen(options: { database: string }): Promise<SqliteResult<{ open: boolean }>> {
    try {
      const opts = assertPlainObject(options, 'isOpen');
      const database = validateName(opts.database);
      return this.ok({ open: this.databases.has(database) });
    } catch (err) {
      return this.err(errorCode(err, 'INVALID_NAME'), 'isOpen', err);
    }
  }

  // MARK: - getVersion

  async getVersion(options: { database: string }): Promise<SqliteResult<{ version: string }>> {
    try {
      const opts = assertPlainObject(options, 'getVersion');
      const database = validateName(opts.database);
      const db = this.requireOpen(database, 'getVersion');
      const row = db.prepare('SELECT sqlite_version() AS version').get() as { version: string } | undefined;
      return this.ok({ version: row?.version ?? '' });
    } catch (err) {
      return this.err(errorCode(err, 'VERSION_FAILED'), 'getVersion', err);
    }
  }

  // MARK: - getSchemaVersion

  async getSchemaVersion(options: { database: string }): Promise<SqliteResult<{ version: number }>> {
    try {
      const opts = assertPlainObject(options, 'getSchemaVersion');
      const database = validateName(opts.database);
      const db = this.requireOpen(database, 'getSchemaVersion');
      const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
      return this.ok({ version: row?.user_version ?? 0 });
    } catch (err) {
      return this.err(errorCode(err, 'SCHEMA_VERSION_FAILED'), 'getSchemaVersion', err);
    }
  }

  // MARK: - vacuum

  async vacuum(options: { database: string }): Promise<SqliteResult> {
    try {
      const opts = assertPlainObject(options, 'vacuum');
      const database = validateName(opts.database);
      this.requireOpen(database, 'vacuum').exec('VACUUM');
      return this.okEmpty();
    } catch (err) {
      return this.err(errorCode(err, 'VACUUM_FAILED'), 'vacuum', err);
    }
  }

  // MARK: - execute

  async execute(options: ExecuteOptions): Promise<SqliteResult<{ changes: number }>> {
    try {
      const opts = assertPlainObject(options, 'execute');
      const database = validateName(opts.database);
      const statements = validateStatements(opts.statements);
      const transaction = opts.transaction !== false;
      const entry = this.requireOpenEntry(database, 'execute');
      if (transaction && entry.inTransaction) {
        throw new SqliteRuntimeError('TRANSACTION_FAILED', `execute: a transaction is already active on '${database}'`);
      }
      const db = entry.db;
      if (transaction) db.exec('BEGIN');
      try {
        let total = 0;
        for (const sql of statements) {
          const result = db.prepare(sql.trim()).run();
          total += toNumber(result.changes);
        }
        if (transaction) db.exec('COMMIT');
        return this.ok({ changes: total });
      } catch (innerErr) {
        if (transaction) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* ignore rollback error */
          }
        }
        throw innerErr;
      }
    } catch (err) {
      return this.err(errorCode(err, 'EXECUTE_FAILED'), 'execute', err);
    }
  }

  // MARK: - run

  async run(options: RunOptions): Promise<SqliteResult<{ changes: number; lastInsertId: number }>> {
    try {
      const opts = assertPlainObject(options, 'run');
      const database = validateName(opts.database);
      const statement = validateSql(opts.statement, 'statement');
      const values = convertValues(validateValues(opts.values, 'values'));
      const db = this.requireOpen(database, 'run');
      const result = db.prepare(statement).run(...values);
      const changes = toNumber(result.changes);
      return this.ok({
        changes,
        lastInsertId: isInsertStatement(statement) && changes > 0 ? toNumber(result.lastInsertRowid) : 0,
      });
    } catch (err) {
      return this.err(errorCode(err, 'EXECUTE_FAILED'), 'run', err);
    }
  }

  // MARK: - runBatch

  async runBatch(options: RunBatchOptions): Promise<SqliteResult<{ changes: number; lastInsertId: number }>> {
    try {
      const opts = assertPlainObject(options, 'runBatch');
      const database = validateName(opts.database);
      const set = validateRunBatchSet(opts.set);
      const transaction = opts.transaction !== false;
      const entry = this.requireOpenEntry(database, 'runBatch');
      if (transaction && entry.inTransaction) {
        throw new SqliteRuntimeError(
          'TRANSACTION_FAILED',
          `runBatch: a transaction is already active on '${database}'`,
        );
      }
      const db = entry.db;

      if (transaction) db.exec('BEGIN');
      try {
        let totalChanges = 0;
        for (const item of set) {
          const result = db.prepare(item.statement).run(...convertValues(item.values));
          totalChanges += toNumber(result.changes);
        }
        if (transaction) db.exec('COMMIT');
        return this.ok({ changes: totalChanges, lastInsertId: 0 });
      } catch (innerErr) {
        if (transaction) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* ignore rollback error */
          }
        }
        throw innerErr;
      }
    } catch (err) {
      return this.err(errorCode(err, 'EXECUTE_FAILED'), 'runBatch', err);
    }
  }

  // MARK: - query

  async query<T = Record<string, unknown>>(options: QueryOptions): Promise<SqliteResult<{ rows: T[] }>> {
    try {
      const opts = assertPlainObject(options, 'query');
      const database = validateName(opts.database);
      const statement = validateSql(opts.statement, 'statement');
      const values = convertValues(validateValues(opts.values, 'values'));
      const db = this.requireOpen(database, 'query');
      const rows = db.prepare(statement).all(...values) as T[];
      return this.ok({ rows });
    } catch (err) {
      return this.err(errorCode(err, 'QUERY_FAILED'), 'query', err);
    }
  }

  // MARK: - transactions

  async beginTransaction(options: { database: string }): Promise<SqliteResult> {
    try {
      const opts = assertPlainObject(options, 'beginTransaction');
      const database = validateName(opts.database);
      const entry = this.requireOpenEntry(database, 'beginTransaction');
      if (entry.inTransaction) {
        throw new SqliteRuntimeError(
          'TRANSACTION_FAILED',
          `beginTransaction: a transaction is already active on '${database}'`,
        );
      }
      entry.db.exec('BEGIN');
      entry.inTransaction = true;
      return this.okEmpty();
    } catch (err) {
      return this.err(errorCode(err, 'TRANSACTION_FAILED'), 'beginTransaction', err);
    }
  }

  async commitTransaction(options: { database: string }): Promise<SqliteResult> {
    try {
      const opts = assertPlainObject(options, 'commitTransaction');
      const database = validateName(opts.database);
      const entry = this.requireOpenEntry(database, 'commitTransaction');
      if (!entry.inTransaction) {
        throw new SqliteRuntimeError(
          'TRANSACTION_FAILED',
          `commitTransaction: no transaction is active on '${database}'`,
        );
      }
      entry.db.exec('COMMIT');
      entry.inTransaction = false;
      return this.okEmpty();
    } catch (err) {
      return this.err(errorCode(err, 'TRANSACTION_FAILED'), 'commitTransaction', err);
    }
  }

  async rollbackTransaction(options: { database: string }): Promise<SqliteResult> {
    try {
      const opts = assertPlainObject(options, 'rollbackTransaction');
      const database = validateName(opts.database);
      const entry = this.requireOpenEntry(database, 'rollbackTransaction');
      if (!entry.inTransaction) {
        throw new SqliteRuntimeError(
          'TRANSACTION_FAILED',
          `rollbackTransaction: no transaction is active on '${database}'`,
        );
      }
      entry.db.exec('ROLLBACK');
      entry.inTransaction = false;
      return this.okEmpty();
    } catch (err) {
      return this.err(errorCode(err, 'TRANSACTION_FAILED'), 'rollbackTransaction', err);
    }
  }

  // MARK: - Private helpers

  private runMigrations(db: DatabaseSync, migrations: Migration[]): void {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    const current = row?.user_version ?? 0;

    const pending = [...migrations].filter((m) => m.version > current).sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      db.exec('BEGIN');
      try {
        for (const sql of migration.statements) {
          db.exec(sql.trim());
        }
        db.exec(`PRAGMA user_version = ${migration.version | 0}`);
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* ignore rollback error */
        }
        throw new SqliteRuntimeError(
          'MIGRATION_FAILED',
          `Migration v${migration.version} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private databasePath(name: string): string {
    const userData = app.getPath('userData') as string;
    const dir = nodePath.join(userData, 'CapacitorSQLite');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const resolved = nodePath.resolve(dir, `${name}.db`);
    const allowedPrefix = nodePath.resolve(dir) + nodePath.sep;
    if (!resolved.startsWith(allowedPrefix)) {
      throw new SqliteRuntimeError('INVALID_NAME', `Invalid database path for '${name}'`);
    }
    return resolved;
  }

  private requireOpen(name: string, context: string): DatabaseSync {
    return this.requireOpenEntry(name, context).db;
  }

  private requireOpenEntry(name: string, context: string): DatabaseEntry {
    const entry = this.databases.get(name);
    if (!entry) throw new SqliteRuntimeError('DB_NOT_OPEN', `${context}: database '${name}' is not open`);
    return entry;
  }

  private openModeError(database: string, readonly: boolean): SqliteFailure | null {
    const existing = this.databases.get(database);
    if (!existing || existing.readonly === readonly) return null;
    return this.err(
      'DB_ALREADY_OPEN',
      'open',
      new Error(`open: database '${database}' is already open as ${existing.readonly ? 'readonly' : 'read/write'}`),
    );
  }
}

function convertValues(values: SQLiteValues): NodeSQLiteValue[] {
  return values.map((v) => {
    if (Array.isArray(v)) return new Uint8Array(v);
    if (typeof v === 'boolean') return BigInt(v ? 1 : 0);
    // node:sqlite binds all JS numbers as REAL (float64). Convert safe integers to
    // BigInt so node:sqlite stores them as SQLite INTEGER, preserving typeof() semantics.
    if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
    return v as NodeSQLiteValue;
  });
}

function toNumber(v: number | bigint | undefined | null): number {
  if (v === undefined || v === null) return 0;
  return typeof v === 'bigint' ? Number(v) : v;
}

function isInsertStatement(sql: string): boolean {
  const stmtType = sql.trim().split(/\s+/, 1)[0]?.toUpperCase();
  return stmtType === 'INSERT' || stmtType === 'REPLACE';
}

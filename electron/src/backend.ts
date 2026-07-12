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
  RunManyOptions,
  RunManyResult,
  RunOptions,
  SqliteDirectory,
  SqliteErrorCode,
  SqliteFailure,
  SqlitePlatform,
  SqliteResult,
  SqliteSuccess,
} from '../../src/definitions';
import { findDuplicateMigrationVersion, isValidMigrationVersion, MAX_MIGRATION_VERSION } from '../../src/migrations.js';
import {
  assertSingleSqlStatement,
  assertAnonymousBindParameterCount,
  hasConflictClause,
  hasRollbackConflictClause,
  isInsertStatement,
  isQueryResultStatement,
} from '../../src/sql.js';

export interface ElectronSqliteBackendPaths {
  userData: string;
  temp: string;
}

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
  path: string;
  inTransaction: boolean;
}

export interface CompactQueryRows {
  columns: string[];
  values: unknown[][];
}

const SAFE_DB_NAME = /^[A-Za-z0-9_-]+$/;
const VALID_DIRECTORIES: readonly SqliteDirectory[] = ['default', 'documents', 'library', 'cache'];

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

function databaseKey(name: string): string {
  return name === ':memory:' ? name : name.toLowerCase();
}

function sameDatabasePath(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}

function validateDirectory(value: unknown): SqliteDirectory {
  if (value === undefined) return 'default';
  if (typeof value === 'string' && (VALID_DIRECTORIES as readonly string[]).includes(value)) {
    return value as SqliteDirectory;
  }
  throw new SqliteRuntimeError('INVALID_PARAMS', "'directory' must be one of: default, documents, library or cache");
}

function validateSql(value: unknown, label: string, code: SqliteErrorCode = 'INVALID_PARAMS'): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SqliteRuntimeError(code, `'${label}' is required`);
  }
  try {
    assertSingleSqlStatement(value, `'${label}'`);
  } catch (err) {
    throw new SqliteRuntimeError(code, err instanceof Error ? err.message : String(err));
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
    if (typeof item === 'number' && Number.isInteger(item) && !Number.isSafeInteger(item)) {
      throw new SqliteRuntimeError('INVALID_PARAMS', `'${label}[${index}]' must be within Number.MAX_SAFE_INTEGER`);
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

function validateBindParameterCount(sql: string, count: number, label = 'values'): void {
  try {
    assertAnonymousBindParameterCount(sql, count, label);
  } catch (err) {
    throw new SqliteRuntimeError('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
  }
}

function validateMigrations(value: unknown): Migration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SqliteRuntimeError('MIGRATION_FAILED', "'migrations' must be an array");
  }
  const migrations = value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new SqliteRuntimeError('MIGRATION_FAILED', `Migration at index ${index}: entry must be an object`);
    }
    const migration = item as Record<string, unknown>;
    if (!isValidMigrationVersion(migration.version)) {
      throw new SqliteRuntimeError(
        'MIGRATION_FAILED',
        `Migration at index ${index}: 'version' must be a positive integer between 1 and ${MAX_MIGRATION_VERSION}`,
      );
    }
    if (!Array.isArray(migration.statements) || migration.statements.length === 0) {
      throw new SqliteRuntimeError(
        'MIGRATION_FAILED',
        `Migration at index ${index}: 'statements' must be a non-empty array`,
      );
    }
    const statements = migration.statements.map((sql, statementIndex) =>
      validateSql(sql, `migrations[${index}].statements[${statementIndex}]`, 'MIGRATION_FAILED'),
    );
    return { version: migration.version as number, statements };
  });
  const duplicate = findDuplicateMigrationVersion(migrations);
  if (duplicate) {
    throw new SqliteRuntimeError(
      'MIGRATION_FAILED',
      `Migration at index ${duplicate.index}: duplicate version ${duplicate.version}`,
    );
  }
  return migrations;
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
    const statement = validateSql(batchItem.statement, `set[${index}].statement`);
    const values = validateValues(batchItem.values, `set[${index}].values`);
    validateBindParameterCount(statement, values.length, `set[${index}].values`);
    return { statement, values };
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

export class ElectronSqliteBackend implements CapacitorSqlitePlugin {
  private databases = new Map<string, DatabaseEntry>();
  // Coalesces concurrent open() calls for the same database.
  private pendingOpens = new Map<string, Promise<SqliteResult>>();
  private pendingOpenModes = new Map<string, boolean>();
  private pendingOpenPaths = new Map<string, string>();

  constructor(private readonly paths: ElectronSqliteBackendPaths) {}

  // MARK: - Unified response helpers

  private ok<T extends Record<string, unknown>>(data: T): SqliteSuccess<T> {
    return { success: true, data };
  }

  private okEmpty(): SqliteSuccess<Record<string, never>> {
    return { success: true, data: {} as Record<string, never> };
  }

  private err(code: SqliteErrorCode, method: string, err: unknown): SqliteFailure {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        code,
        message,
        platform: 'electron',
        method,
        details: { nativeCode: code, nativeMessage: message, source: 'electron-worker-backend' },
      },
    };
  }

  // MARK: - getPlatform

  async getPlatform(): Promise<SqliteResult<{ platform: SqlitePlatform }>> {
    return this.ok({ platform: 'electron' });
  }

  // MARK: - isAvailable

  async isAvailable(): Promise<SqliteResult<{ available: boolean }>> {
    return this.ok({ available: isSqliteAvailable() });
  }

  /** Closes every connection before the owning worker exits. */
  async shutdown(): Promise<SqliteResult> {
    let firstError: unknown = null;
    for (const entry of this.databases.values()) {
      try {
        if (entry.db.isTransaction) entry.db.exec('ROLLBACK');
        entry.db.close();
      } catch (err) {
        firstError ??= err;
      }
    }
    this.databases.clear();
    return firstError ? this.err('CLOSE_FAILED', 'shutdown', firstError) : this.okEmpty();
  }

  // MARK: - open

  async open(options: OpenOptions): Promise<SqliteResult> {
    let database: string;
    let readonly: boolean;
    let dbPath: string;
    let migrations: Migration[];
    let directory: SqliteDirectory;
    try {
      const opts = assertPlainObject(options, 'open');
      database = validateName(opts.database);
      readonly = opts.readonly === true;
      directory = validateDirectory(opts.directory);
      migrations = validateMigrations(opts.migrations);
      if (readonly && migrations.length) {
        throw new SqliteRuntimeError('MIGRATION_FAILED', 'migrations cannot run when readonly is true');
      }
    } catch (err) {
      return this.err(errorCode(err, 'INVALID_NAME'), 'open', err);
    }
    try {
      dbPath = database === ':memory:' ? ':memory:' : this.databasePath(database, directory);
    } catch (err) {
      return this.err(errorCode(err, 'OPEN_FAILED'), 'open', err);
    }
    const key = databaseKey(database);

    const openModeError = this.openModeError(key, database, readonly, dbPath);
    if (openModeError) return openModeError;
    const existing = this.databases.get(key);
    if (existing) {
      if (migrations.length) {
        if (existing.db.isTransaction) {
          return this.err(
            'MIGRATION_FAILED',
            'open',
            new Error(`open: migrations cannot run while a transaction is active on '${database}'`),
          );
        }
        try {
          this.runMigrations(existing.db, migrations);
        } catch (err) {
          return this.err(errorCode(err, 'MIGRATION_FAILED'), 'open', err);
        }
      }
      return this.okEmpty();
    }

    const pending = this.pendingOpens.get(key);
    if (pending) {
      const pendingReadonly = this.pendingOpenModes.get(key);
      const pendingPath = this.pendingOpenPaths.get(key);
      if (pendingReadonly !== readonly || !sameDatabasePath(pendingPath ?? '', dbPath)) {
        return this.err(
          'DB_ALREADY_OPEN',
          'open',
          new Error(
            `open: database '${database}' is already opening as ${pendingReadonly ? 'readonly' : 'read/write'} at '${pendingPath}'`,
          ),
        );
      }
      return pending;
    }

    const openOp = this._doOpen(key, database, readonly, dbPath, migrations).finally(() => {
      this.pendingOpens.delete(key);
      this.pendingOpenModes.delete(key);
      this.pendingOpenPaths.delete(key);
    });
    this.pendingOpens.set(key, openOp);
    this.pendingOpenModes.set(key, readonly);
    this.pendingOpenPaths.set(key, dbPath);
    return openOp;
  }

  private async _doOpen(
    key: string,
    database: string,
    readonly: boolean,
    dbPath: string,
    migrations: Migration[],
  ): Promise<SqliteResult> {
    let db: DatabaseSync | null = null;
    try {
      const openModeError = this.openModeError(key, database, readonly, dbPath);
      if (openModeError) return openModeError;
      if (this.databases.has(key)) return this.okEmpty();

      const sqlite = loadSqlite();
      db = new sqlite.DatabaseSync(dbPath, {
        readOnly: readonly,
        enableForeignKeyConstraints: !readonly,
        timeout: 5000,
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

      this.databases.set(key, { db, readonly, path: dbPath, inTransaction: false });
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
      this.databases.delete(key);
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
      if (entry.inTransaction) {
        try {
          entry.db.exec('ROLLBACK');
        } catch {
          /* ignore rollback error */
        }
      }
      entry.db.close();
      this.databases.delete(databaseKey(database));
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
      return this.ok({ open: this.databases.has(databaseKey(database)) });
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
      const entry = this.requireOpenEntry(database, 'vacuum');
      this.requireWritable(entry, database, 'vacuum', 'VACUUM_FAILED');
      entry.db.exec('VACUUM');
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
      this.requireWritable(entry, database, 'execute', 'EXECUTE_FAILED');
      if (transaction && entry.inTransaction) {
        throw new SqliteRuntimeError('TRANSACTION_FAILED', `execute: a transaction is already active on '${database}'`);
      }
      const db = entry.db;
      if (transaction) db.exec('BEGIN');
      try {
        const before = totalChanges(db);
        for (const sql of statements) {
          db.prepare(sql.trim()).run();
        }
        const total = totalChanges(db) - before;
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
      const opts =
        typeof options === 'object' && options !== null ? (options as unknown as Record<string, unknown>) : null;
      const database = typeof opts?.database === 'string' ? opts.database : null;
      if (database) {
        const entry = this.databases.get(databaseKey(database));
        if (entry) entry.inTransaction = entry.db.isTransaction;
      }
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
      validateBindParameterCount(statement, values.length);
      const entry = this.requireOpenEntry(database, 'run');
      this.requireWritable(entry, database, 'run', 'EXECUTE_FAILED');
      const before = totalChanges(entry.db);
      const beforeId = lastInsertRowId(entry.db);
      const result = entry.db.prepare(statement).run(...values);
      const changes = totalChanges(entry.db) - before;
      // An UPSERT resolved via its DO UPDATE arm leaves lastInsertRowid pointing at the
      // connection's last real insert, not this statement's affected row — see
      // hasConflictClause in src/sql.ts.
      const resultId = toNumber(result.lastInsertRowid);
      const isReliableInsert =
        isInsertStatement(statement) && changes > 0 && !hasConflictClause(statement) && resultId !== beforeId;
      return this.ok({
        changes,
        lastInsertId: isReliableInsert ? resultId : 0,
      });
    } catch (err) {
      const opts =
        typeof options === 'object' && options !== null ? (options as unknown as Record<string, unknown>) : null;
      const database = typeof opts?.database === 'string' ? opts.database : null;
      const statement = typeof opts?.statement === 'string' ? opts.statement : '';
      if (database) {
        const entry = this.databases.get(databaseKey(database));
        if (entry) entry.inTransaction = entry.db.isTransaction;
      }
      // Keep the scanner call here as an explicit regression signal for runtimes
      // where isTransaction is unavailable in a future node:sqlite compatibility layer.
      void hasRollbackConflictClause(statement);
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
      this.requireWritable(entry, database, 'runBatch', 'EXECUTE_FAILED');
      if (transaction && entry.inTransaction) {
        throw new SqliteRuntimeError(
          'TRANSACTION_FAILED',
          `runBatch: a transaction is already active on '${database}'`,
        );
      }
      const db = entry.db;
      // Compile each distinct SQL string once. StatementSync resets itself after
      // run(), so repeated batch items only bind and step.
      const prepared = new Map<string, ReturnType<DatabaseSync['prepare']>>();
      for (const item of set) {
        if (!prepared.has(item.statement)) prepared.set(item.statement, db.prepare(item.statement));
      }

      if (transaction) db.exec('BEGIN');
      try {
        const before = totalChanges(db);
        for (const item of set) {
          prepared.get(item.statement)!.run(...convertValues(item.values));
        }
        const changed = totalChanges(db) - before;
        if (transaction) db.exec('COMMIT');
        return this.ok({ changes: changed, lastInsertId: 0 });
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
      const opts =
        typeof options === 'object' && options !== null ? (options as unknown as Record<string, unknown>) : null;
      const database = typeof opts?.database === 'string' ? opts.database : null;
      if (database) {
        const entry = this.databases.get(databaseKey(database));
        if (entry) entry.inTransaction = entry.db.isTransaction;
      }
      return this.err(errorCode(err, 'EXECUTE_FAILED'), 'runBatch', err);
    }
  }

  // MARK: - runMany

  async runMany(options: RunManyOptions): Promise<SqliteResult<RunManyResult>> {
    try {
      const opts = assertPlainObject(options, 'runMany');
      const database = validateName(opts.database);
      const statement = validateSql(opts.statement, 'statement');
      if (!Array.isArray(opts.values) || opts.values.length === 0) {
        throw new SqliteRuntimeError('INVALID_PARAMS', "'values' must be a non-empty array of value arrays");
      }
      const valueSets = opts.values.map((values, index) => {
        const validated = validateValues(values, `values[${index}]`);
        validateBindParameterCount(statement, validated.length);
        return convertValues(validated);
      });
      const transaction = opts.transaction !== false;
      const returnResults = opts.returnResults === true;
      const entry = this.requireOpenEntry(database, 'runMany');
      this.requireWritable(entry, database, 'runMany', 'EXECUTE_FAILED');
      if (transaction && entry.inTransaction) {
        throw new SqliteRuntimeError('TRANSACTION_FAILED', `runMany: a transaction is already active on '${database}'`);
      }
      const db = entry.db;
      const prepared = db.prepare(statement);
      const results: { changes: number; lastInsertId: number }[] | undefined = returnResults ? [] : undefined;
      if (transaction) db.exec('BEGIN');
      try {
        const beforeTotal = totalChanges(db);
        if (results) {
          let beforeId = lastInsertRowId(db);
          for (const values of valueSets) {
            const beforeItem = totalChanges(db);
            const runResult = prepared.run(...values);
            const afterItem = totalChanges(db);
            const resultId = toNumber(runResult.lastInsertRowid);
            const reliable =
              isInsertStatement(statement) &&
              afterItem > beforeItem &&
              !hasConflictClause(statement) &&
              resultId !== beforeId;
            results.push({ changes: afterItem - beforeItem, lastInsertId: reliable ? resultId : 0 });
            beforeId = resultId;
          }
        } else {
          for (const values of valueSets) prepared.run(...values);
        }
        const changes = totalChanges(db) - beforeTotal;
        if (transaction) db.exec('COMMIT');
        return this.ok({ changes, lastInsertId: 0 as const, ...(results ? { results } : {}) });
      } catch (innerErr) {
        if (transaction) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* preserve original error */
          }
        }
        throw innerErr;
      }
    } catch (err) {
      const opts =
        typeof options === 'object' && options !== null ? (options as unknown as Record<string, unknown>) : null;
      const database = typeof opts?.database === 'string' ? opts.database : null;
      if (database) {
        const entry = this.databases.get(databaseKey(database));
        if (entry) entry.inTransaction = entry.db.isTransaction;
      }
      return this.err(errorCode(err, 'EXECUTE_FAILED'), 'runMany', err);
    }
  }

  // MARK: - query

  async query<T = Record<string, unknown>>(options: QueryOptions): Promise<SqliteResult<{ rows: T[] }>> {
    try {
      const opts = assertPlainObject(options, 'query');
      const database = validateName(opts.database);
      const statement = validateSql(opts.statement, 'statement');
      if (!isQueryResultStatement(statement)) {
        throw new SqliteRuntimeError(
          'INVALID_PARAMS',
          "'statement' must be a SELECT, PRAGMA, EXPLAIN, or DML statement with RETURNING",
        );
      }
      const values = convertValues(validateValues(opts.values, 'values'));
      validateBindParameterCount(statement, values.length);
      const db = this.requireOpen(database, 'query');
      const stmt = db.prepare(statement);
      if (typeof stmt.setReadBigInts === 'function') {
        stmt.setReadBigInts(true);
      }
      const rows = stmt.all(...values).map((row) => normalizeRow(row as Record<string, unknown>)) as T[];
      return this.ok({ rows });
    } catch (err) {
      return this.err(errorCode(err, 'QUERY_FAILED'), 'query', err);
    }
  }

  /**
   * Electron IPC-only query representation. Repeating property names in every row
   * made a 100k-row result extremely expensive to clone worker→main→renderer.
   * The renderer reconstructs the documented row objects after both IPC hops.
   */
  async queryCompact(options: QueryOptions): Promise<SqliteResult<{ compactRows: CompactQueryRows }>> {
    try {
      const opts = assertPlainObject(options, 'query');
      const database = validateName(opts.database);
      const statement = validateSql(opts.statement, 'statement');
      if (!isQueryResultStatement(statement)) {
        throw new SqliteRuntimeError(
          'INVALID_PARAMS',
          "'statement' must be a SELECT, PRAGMA, EXPLAIN, or DML statement with RETURNING",
        );
      }
      const values = convertValues(validateValues(opts.values, 'values'));
      validateBindParameterCount(statement, values.length);
      const db = this.requireOpen(database, 'query');
      const stmt = db.prepare(statement);
      if (typeof stmt.setReadBigInts === 'function') stmt.setReadBigInts(true);
      const rawRows = stmt.all(...values) as Record<string, unknown>[];
      const columns = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];
      const compactValues = rawRows.map((row) => columns.map((column) => normalizeValue(row[column])));
      return this.ok({ compactRows: { columns, values: compactValues } });
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
      this.requireWritable(entry, database, 'beginTransaction', 'TRANSACTION_FAILED');
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
      const opts = typeof options === 'object' && options !== null ? (options as Record<string, unknown>) : null;
      const database = typeof opts?.database === 'string' ? opts.database : null;
      if (database) {
        const entry = this.databases.get(databaseKey(database));
        if (entry) entry.inTransaction = entry.db.isTransaction;
      }
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
      const opts = typeof options === 'object' && options !== null ? (options as Record<string, unknown>) : null;
      const database = typeof opts?.database === 'string' ? opts.database : null;
      if (database) {
        const entry = this.databases.get(databaseKey(database));
        if (entry) entry.inTransaction = entry.db.isTransaction;
      }
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
        // `| 0` forces a plain integer literal into the SQL string. Safe from truncation:
        // validateMigrations() already rejects anything outside 1..MAX_MIGRATION_VERSION
        // (Int32 range), which is the same range this bitwise op maps to.
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

  private databasePath(name: string, directory: SqliteDirectory): string {
    const dir = this.directoryPath(directory);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const resolved = nodePath.resolve(dir, `${name}.db`);
    const allowedPrefix = nodePath.resolve(dir) + nodePath.sep;
    if (!resolved.startsWith(allowedPrefix)) {
      throw new SqliteRuntimeError('INVALID_NAME', `Invalid database path for '${name}'`);
    }
    return resolved;
  }

  private directoryPath(directory: SqliteDirectory): string {
    if (directory === 'cache') {
      return nodePath.join(this.paths.temp, 'capacitor-sqlite', 'CapacitorSQLite');
    }
    // `default`, `library`, and `documents` all use userData on Electron. The
    // `documents` fallback keeps app databases out of the user's visible
    // Documents folder while still accepting the shared directory enum.
    return nodePath.join(this.paths.userData, 'CapacitorSQLite');
  }

  private requireOpen(name: string, context: string): DatabaseSync {
    return this.requireOpenEntry(name, context).db;
  }

  private requireOpenEntry(name: string, context: string): DatabaseEntry {
    const entry = this.databases.get(databaseKey(name));
    if (!entry) throw new SqliteRuntimeError('DB_NOT_OPEN', `${context}: database '${name}' is not open`);
    return entry;
  }

  private requireWritable(entry: DatabaseEntry, database: string, method: string, code: SqliteErrorCode): void {
    if (entry.readonly) {
      throw new SqliteRuntimeError(code, `${method}: database '${database}' is open in readonly mode`);
    }
  }

  private openModeError(key: string, database: string, readonly: boolean, dbPath: string): SqliteFailure | null {
    const existing = this.databases.get(key);
    if (!existing || (existing.readonly === readonly && sameDatabasePath(existing.path, dbPath))) return null;
    return this.err(
      'DB_ALREADY_OPEN',
      'open',
      new Error(
        `open: database '${database}' is already open as ${existing.readonly ? 'readonly' : 'read/write'} at '${existing.path}'`,
      ),
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

function totalChanges(db: DatabaseSync): number {
  const row = db.prepare('SELECT total_changes() AS c').get() as { c: number | bigint } | undefined;
  return toNumber(row?.c);
}

function lastInsertRowId(db: DatabaseSync): number {
  const row = db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number | bigint } | undefined;
  return toNumber(row?.id);
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    out[key] = normalizeValue(row[key]);
  }
  return out;
}

function normalizeValue(value: unknown): unknown {
  if (typeof value !== 'bigint') return value;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > max || value < -max) return value.toString();
  return Number(value);
}

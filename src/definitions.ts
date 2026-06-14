export type SQLiteValue = string | number | boolean | null | Uint8Array;
export type SQLiteValues = SQLiteValue[];

export interface Migration {
  /** Target schema version. Migrations run in ascending order. */
  version: number;
  /** SQL statements executed when upgrading to this version. */
  statements: string[];
}

export interface OpenOptions {
  /** Database file name (without extension). */
  database: string;
  readonly?: boolean;
  /**
   * When provided the plugin reads `PRAGMA user_version`, then runs every
   * migration whose `version` is greater than the stored value, in order.
   * After all migrations complete it writes the highest version back.
   * Returns MIGRATION_FAILED if any entry is malformed or a statement fails.
   */
  migrations?: Migration[];
}

export interface ExecuteOptions {
  database: string;
  /**
   * One or more SQL statements (DDL or DML). No parameter binding.
   * Must be a non-empty array — empty array returns INVALID_PARAMS.
   */
  statements: string[];
  /** Wrap all statements in a single transaction. Default: `true`. */
  transaction?: boolean;
}

export interface RunOptions {
  database: string;
  /** Single parameterized SQL statement. */
  statement: string;
  /** Positional values bound to `?` placeholders. */
  values?: SQLiteValues;
}

export interface RunBatchOptions {
  database: string;
  set: { statement: string; values?: SQLiteValues }[];
  /** Wrap all statements in a single transaction. Default: `true`. */
  transaction?: boolean;
}

export interface QueryOptions {
  database: string;
  statement: string;
  values?: SQLiteValues;
}

// ── Unified response types ────────────────────────────────────────────────────

export type SqlitePlatform = 'ios' | 'android' | 'web' | 'electron';

export type SqliteErrorCode =
  | 'INVALID_PARAMS'
  | 'INVALID_NAME'
  | 'DB_NOT_OPEN'
  | 'DB_ALREADY_OPEN'
  | 'OPEN_FAILED'
  | 'CLOSE_FAILED'
  | 'EXECUTE_FAILED'
  | 'QUERY_FAILED'
  | 'VACUUM_FAILED'
  | 'VERSION_FAILED'
  | 'SCHEMA_VERSION_FAILED'
  | 'TRANSACTION_FAILED'
  | 'MIGRATION_FAILED'
  | 'NOT_AVAILABLE'
  | 'UNKNOWN';

export interface SqliteError {
  code: SqliteErrorCode;
  message: string;
  platform: SqlitePlatform;
  method: string;
  details?: Record<string, unknown>;
}

export interface SqliteSuccess<T extends Record<string, unknown> = Record<string, never>> {
  success: true;
  data: T;
}

export interface SqliteFailure {
  success: false;
  error: SqliteError;
}

/** Every plugin method resolves to this type — never rejects. */
export type SqliteResult<T extends Record<string, unknown> = Record<string, never>> = SqliteSuccess<T> | SqliteFailure;

// ── Plugin interface ──────────────────────────────────────────────────────────

export interface CapacitorSqlitePlugin {
  /** Returns the platform identifier of the implementation answering calls. */
  getPlatform(): Promise<SqliteResult<{ platform: SqlitePlatform }>>;

  /** Returns `true` if SQLite is available on the current platform. */
  isAvailable(): Promise<SqliteResult<{ available: boolean }>>;

  /**
   * Open (or create) a database. If `migrations` are supplied, pending
   * migrations are applied before the promise resolves.
   * Returns MIGRATION_FAILED if a migration entry
   * is malformed or a migration statement fails.
   */
  open(options: OpenOptions): Promise<SqliteResult>;

  close(options: { database: string }): Promise<SqliteResult>;

  isOpen(options: { database: string }): Promise<SqliteResult<{ open: boolean }>>;

  /** Returns the SQLite engine version for the opened database connection. */
  getVersion(options: { database: string }): Promise<SqliteResult<{ version: string }>>;

  /** Returns the current SQLite `PRAGMA user_version` for the opened database. */
  getSchemaVersion(options: { database: string }): Promise<SqliteResult<{ version: number }>>;

  /** Runs SQLite `VACUUM` for the opened database. */
  vacuum(options: { database: string }): Promise<SqliteResult>;

  /**
   * Execute one or more SQL statements sequentially.
   * Use for DDL (`CREATE TABLE`, …) or bulk DML without params.
   * `statements` must be a non-empty array.
   * **Each array element must be a single SQL statement** — multiple semicolon-separated
   * statements in one string work on iOS/Web but fail on Android/Electron.
   * Statements run in a single transaction by default; pass
   * `transaction: false` to keep prior successful statements if a later one fails.
   * When called inside `beginTransaction()`, pass `transaction: false`;
   * nested transactions return TRANSACTION_FAILED.
   */
  execute(options: ExecuteOptions): Promise<SqliteResult<{ changes: number }>>;

  /**
   * Execute a single parameterized statement.
   * Returns the number of affected rows and the row ID inserted by this statement.
   * `lastInsertId` is `0` for UPDATE, DELETE, statements that insert no row,
   * and other non-INSERT/REPLACE statements.
   * `lastInsertId` is a JavaScript number and is precise up to `Number.MAX_SAFE_INTEGER`.
   * **Android caveat:** a multi-value `INSERT INTO t VALUES (…),(…)` always reports
   * `changes = 1` regardless of the number of inserted rows; other platforms report
   * the real count. Single-row inserts are correct on all platforms.
   */
  run(options: RunOptions): Promise<SqliteResult<{ changes: number; lastInsertId: number }>>;

  /**
   * Execute multiple parameterized statements in a single native call.
   * `lastInsertId` is always `0`; use `run()` when you need the inserted row ID.
   * **Android caveat:** a multi-value `INSERT INTO t VALUES (…),(…)` always reports
   * `changes = 1` regardless of the number of inserted rows; other platforms report
   * the real count.
   * When called inside `beginTransaction()`, pass `transaction: false`;
   * nested transactions return TRANSACTION_FAILED.
   */
  runBatch(options: RunBatchOptions): Promise<SqliteResult<{ changes: number; lastInsertId: number }>>;

  /**
   * Execute a `SELECT` statement and return rows as plain objects.
   * Column names become object keys. Results are in `data.rows`.
   */
  query<T = Record<string, unknown>>(options: QueryOptions): Promise<SqliteResult<{ rows: T[] }>>;

  /** Start a transaction. Returns TRANSACTION_FAILED if one is already active. */
  beginTransaction(options: { database: string }): Promise<SqliteResult>;

  commitTransaction(options: { database: string }): Promise<SqliteResult>;

  rollbackTransaction(options: { database: string }): Promise<SqliteResult>;
}

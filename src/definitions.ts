export type SQLiteValue = string | number | boolean | null | Uint8Array;
export type SQLiteValues = SQLiteValue[];
export type SqliteDirectory = 'default' | 'documents' | 'library' | 'cache';

export interface Migration {
  /** Target schema version. Must be unique within an `open()` call. Migrations run in ascending order. */
  version: number;
  /** SQL statements executed when upgrading to this version. Each string must contain exactly one statement. */
  statements: string[];
}

export interface OpenOptions {
  /**
   * Database file name (without extension). On iOS and Electron, open database
   * registry keys are matched case-insensitively to avoid two handles pointing
   * at the same file on case-insensitive filesystems.
   */
  database: string;
  /**
   * When `true`, opens the database in read-only mode.
   * Read operations are allowed, while write operations (`execute`, `run`,
   * `runBatch`, `runMany`, `vacuum`, write transactions, and migrations) return a failure.
   * Attempting to reopen an already-open database with a different `readonly`
   * value or `directory` returns DB_ALREADY_OPEN.
   */
  readonly?: boolean;
  /**
   * Logical storage location for the database file. Raw filesystem paths are
   * not accepted.
   *
   * - `default` / omitted: recommended persistent app storage
   *   - iOS: `Library/Application Support/CapacitorSQLite/`
   *   - Android: `<filesDir>/CapacitorSQLite/`
   *   - Electron: `app.getPath('userData')/CapacitorSQLite/`
   *   - Web: OPFS (`file:<name>.db?vfs=opfs`)
   * - `documents`: user-document location where appropriate
   *   - iOS: `Documents/CapacitorSQLite/`
   *   - Android: app-specific external Documents if available, otherwise
   *     `<filesDir>/Documents/CapacitorSQLite/`
   *   - Electron: falls back to `userData` to avoid placing app databases in
   *     the user's Documents folder
   *   - Web: OPFS fallback
   * - `library`: persistent app support data
   *   - iOS: `Library/Application Support/CapacitorSQLite/`
   *   - Android: `<filesDir>/CapacitorSQLite/`
   *   - Electron: `userData/CapacitorSQLite/`
   *   - Web: OPFS fallback
   * - `cache`: rebuildable data only; the OS may delete it
   *   - iOS: `Library/Caches/CapacitorSQLite/`
   *   - Android: `<cacheDir>/CapacitorSQLite/`
   *   - Electron: `temp/capacitor-sqlite/CapacitorSQLite/`
   *   - Web: OPFS fallback
   *
   * `:memory:` databases ignore this option.
   */
  directory?: SqliteDirectory;
  /**
   * When provided the plugin reads `PRAGMA user_version`, then runs every
   * migration whose `version` is greater than the stored value, in order.
   * After all migrations complete it writes the highest version back.
   * Returns MIGRATION_FAILED if any entry is malformed, versions are duplicated,
   * or a statement fails.
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
  /**
   * Positional values bound to anonymous `?` placeholders, in order.
   * The value count must exactly match the placeholder count; `?` inside SQL
   * strings, quoted identifiers, and comments is not counted.
   * `number` values must be finite; integer `number` values must be within
   * `Number.MAX_SAFE_INTEGER`.
   *
   * BLOB values should use `Uint8Array`. Android/iOS transport them through a
   * private tagged base64 envelope; Web/Electron retain the typed array.
   *
   * Numbered placeholders (`?1`) and named placeholders (`:name`, `@name`,
   * `$name`) are not part of the cross-platform API contract.
   */
  values?: SQLiteValues;
}

export interface RunBatchOptions {
  database: string;
  set: { statement: string; values?: SQLiteValues }[];
  /** Wrap all statements in a single transaction. Default: `true`. */
  transaction?: boolean;
}

export interface RunManyOptions {
  database: string;
  /** Single parameterized SQL statement reused for every values entry. */
  statement: string;
  /**
   * Non-empty list of positional value sets. Every inner array must exactly
   * match the statement's anonymous `?` placeholders.
   */
  values: SQLiteValues[];
  /** Wrap every execution in one transaction. Default: `true`. */
  transaction?: boolean;
  /**
   * Return `{changes, lastInsertId}` for every execution. Default: `false`.
   * Leave disabled for maximum throughput and the smallest bridge response.
   */
  returnResults?: boolean;
}

export interface RunManyItemResult {
  changes: number;
  lastInsertId: number;
}

export interface RunManyResult extends Record<string, unknown> {
  changes: number;
  /** Aggregate operations do not have one unambiguous inserted row ID. */
  lastInsertId: 0;
  /** Present only when `returnResults: true`. */
  results?: RunManyItemResult[];
}

export interface QueryOptions {
  database: string;
  /** Result-producing statement using anonymous `?` placeholders for bound values. */
  statement: string;
  /**
   * Positional values bound to anonymous `?` placeholders, in order.
   * The value count must exactly match the placeholder count; `?` inside SQL
   * strings, quoted identifiers, and comments is not counted.
   * `number` values must be finite; integer `number` values must be within
   * `Number.MAX_SAFE_INTEGER`.
   *
   * BLOB values should use `Uint8Array`. Android/iOS transport them through a
   * private tagged base64 envelope; Web/Electron retain the typed array.
   *
   * On Android, `query()` uses a small SQL scanner before calling
   * `rawQuery(String[])` so numeric, boolean, and BLOB values keep their SQLite
   * types. The scanner ignores `?` inside strings, quoted identifiers, and SQL
   * comments, and rejects unsupported numbered/named placeholder forms.
   */
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
  /**
   * Platform diagnostic metadata. All implementations include `nativeCode`,
   * `nativeMessage`, and `source`; callers should treat additional keys as
   * platform-specific debugging hints.
   */
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
   * is malformed, versions are duplicated, or a migration statement fails.
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
   * statements in one string return a failure on every platform.
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
   * `lastInsertId` is also `0` for any INSERT/REPLACE statement containing an
   * `ON CONFLICT` clause, since SQLite does not update the underlying rowid counter
   * when such a statement resolves via its `DO UPDATE` arm — use `query()` with a
   * `RETURNING` clause instead to get the affected row's id from an UPSERT.
   * It is conservatively `0` whenever SQLite's connection-level rowid counter
   * is unchanged (for example `WITHOUT ROWID`, replacement of the same explicit
   * rowid, or rowid reuse after deletion). Use `RETURNING` when the exact id is required.
   * Leading SQL comments and common `WITH ... INSERT` CTE forms are detected as inserts.
   * `lastInsertId` is a JavaScript number and is precise up to `Number.MAX_SAFE_INTEGER`.
   *
   * For Web/OPFS, each successful autocommit write includes a browser durability
   * barrier. Use an explicit transaction, `runBatch()`, or `runMany()` for groups of
   * writes instead of issuing many individual autocommit `run()` calls.
   */
  run(options: RunOptions): Promise<SqliteResult<{ changes: number; lastInsertId: number }>>;

  /**
   * Execute multiple parameterized statements in a single native call.
   * Use this for mixed-SQL bulk writes. For one repeated statement, prefer
   * `runMany()` because it transports and classifies the SQL text only once.
   * `lastInsertId` is always `0`; use `run()` when you need the inserted row ID.
   * When called inside `beginTransaction()`, pass `transaction: false`;
   * nested transactions return TRANSACTION_FAILED.
   */
  runBatch(options: RunBatchOptions): Promise<SqliteResult<{ changes: number; lastInsertId: number }>>;

  /**
   * Execute one parameterized statement for many value sets in one plugin call.
   * Unlike `runBatch()`, the SQL text is transported and classified only once.
   * Native and Electron backends retain one prepared statement for the loop;
   * sqlite-wasm Worker1 does not expose persistent statement handles, but still
   * benefits from the compact request shape. All value sets are validated before
   * the first write.
   *
   * Prefer this over firing hundreds or thousands of concurrent `run()` calls for
   * bulk inserts. `Promise.all(run(...))` still creates one bridge request, native
   * queue entry, result object, and JavaScript callback per row; `runMany()` keeps
   * the same work in one public call. On Web/OPFS it also avoids repeating a durable
   * autocommit barrier for every row when `transaction` is left at its default.
   *
   * The operation is atomic by default. Pass `transaction: false` to preserve
   * successful earlier executions if a later execution fails. `lastInsertId`
   * on the aggregate result is always `0`; opt into `returnResults` when each
   * execution's inserted row ID is required.
   */
  runMany(options: RunManyOptions): Promise<SqliteResult<RunManyResult>>;

  /**
   * Execute a result-producing statement and return rows as plain objects.
   * Supported forms are `SELECT`, `PRAGMA`, `EXPLAIN`, and
   * `INSERT`/`UPDATE`/`DELETE`/`REPLACE ... RETURNING`.
   * DML without `RETURNING` returns `INVALID_PARAMS`; use `run()` instead.
   * Use anonymous `?` placeholders with `values: [...]` for parameters.
   * Numbered and named placeholders are not guaranteed across platforms.
   * INTEGER result values outside JavaScript's safe integer range are returned
   * as strings rather than imprecise numbers.
   * Column names become object keys. Results are in `data.rows`.
   */
  query<T = Record<string, unknown>>(options: QueryOptions): Promise<SqliteResult<{ rows: T[] }>>;

  /** Start a transaction. Returns TRANSACTION_FAILED if one is already active. */
  beginTransaction(options: { database: string }): Promise<SqliteResult>;

  commitTransaction(options: { database: string }): Promise<SqliteResult>;

  rollbackTransaction(options: { database: string }): Promise<SqliteResult>;
}

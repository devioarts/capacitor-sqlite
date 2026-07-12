import type {
  CapacitorSqlitePlugin,
  ExecuteOptions,
  OpenOptions,
  QueryOptions,
  RunBatchOptions,
  RunManyOptions,
  RunManyResult,
  RunOptions,
  SqlitePlatform,
  SqliteResult,
} from '../../dist/esm/definitions';

export declare class CapacitorSqlite implements CapacitorSqlitePlugin {
  getPluginPlatform(): Promise<SqliteResult<{ platform: SqlitePlatform }>>;
  isAvailable(): Promise<SqliteResult<{ available: boolean }>>;
  /**
   * Terminates the worker thread that runs all SQLite work. Not part of
   * `CapacitorSqlitePlugin` — call explicitly (typically from `app.on('before-quit')`)
   * to release the worker before the process exits. Safe to call again later; a fresh
   * worker is spawned on demand.
   */
  dispose(): Promise<void>;
  open(options: OpenOptions): Promise<SqliteResult>;
  close(options: { database: string }): Promise<SqliteResult>;
  isOpen(options: { database: string }): Promise<SqliteResult<{ open: boolean }>>;
  getVersion(options: { database: string }): Promise<SqliteResult<{ version: string }>>;
  getSchemaVersion(options: { database: string }): Promise<SqliteResult<{ version: number }>>;
  vacuum(options: { database: string }): Promise<SqliteResult>;
  execute(options: ExecuteOptions): Promise<SqliteResult<{ changes: number }>>;
  run(options: RunOptions): Promise<SqliteResult<{ changes: number; lastInsertId: number }>>;
  runBatch(options: RunBatchOptions): Promise<SqliteResult<{ changes: number; lastInsertId: number }>>;
  runMany(options: RunManyOptions): Promise<SqliteResult<RunManyResult>>;
  query<T = Record<string, unknown>>(options: QueryOptions): Promise<SqliteResult<{ rows: T[] }>>;
  beginTransaction(options: { database: string }): Promise<SqliteResult>;
  commitTransaction(options: { database: string }): Promise<SqliteResult>;
  rollbackTransaction(options: { database: string }): Promise<SqliteResult>;
}

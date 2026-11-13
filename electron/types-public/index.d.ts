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
   * Waits for queued SQLite work, closes all connections, and terminates the worker.
   * Not part of `CapacitorSqlitePlugin`; await it from your Electron main process
   * before allowing the app to quit. A later call spawns a fresh worker on demand.
   * This is graceful shutdown: it cannot interrupt a running or stuck SQL statement.
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

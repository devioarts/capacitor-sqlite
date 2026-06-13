import type {
  CapacitorSqlitePlugin,
  ExecuteOptions,
  OpenOptions,
  QueryOptions,
  RunBatchOptions,
  RunOptions,
  SqlitePlatform,
  SqliteResult,
} from '../../dist/esm/definitions';

export declare class CapacitorSqlite implements CapacitorSqlitePlugin {
  getPlatform(): Promise<SqliteResult<{ platform: SqlitePlatform }>>;
  isAvailable(): Promise<SqliteResult<{ available: boolean }>>;
  open(options: OpenOptions): Promise<SqliteResult>;
  close(options: { database: string }): Promise<SqliteResult>;
  isOpen(options: { database: string }): Promise<SqliteResult<{ open: boolean }>>;
  getVersion(options: { database: string }): Promise<SqliteResult<{ version: string }>>;
  getSchemaVersion(options: { database: string }): Promise<SqliteResult<{ version: number }>>;
  vacuum(options: { database: string }): Promise<SqliteResult>;
  execute(options: ExecuteOptions): Promise<SqliteResult<{ changes: number }>>;
  run(options: RunOptions): Promise<SqliteResult<{ changes: number; lastInsertId: number }>>;
  runBatch(options: RunBatchOptions): Promise<SqliteResult<{ changes: number; lastInsertId: number }>>;
  query<T = Record<string, unknown>>(options: QueryOptions): Promise<SqliteResult<{ rows: T[] }>>;
  beginTransaction(options: { database: string }): Promise<SqliteResult>;
  commitTransaction(options: { database: string }): Promise<SqliteResult>;
  rollbackTransaction(options: { database: string }): Promise<SqliteResult>;
}

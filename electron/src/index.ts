// Electron main-process plugin for @devioarts/capacitor-sqlite.
// Import @devioarts/capacitor-sqlite/electron/settings from Capacitor Electron
// tooling, or register this class manually in your app's main-process IPC layer.

import { app } from 'electron';
import * as nodePath from 'path';
import { Worker } from 'worker_threads';

import type {
  CapacitorSqlitePlugin,
  ExecuteOptions,
  OpenOptions,
  QueryOptions,
  RunBatchOptions,
  RunOptions,
  SqliteErrorCode,
  SqliteFailure,
  SqlitePlatform,
  SqliteResult,
} from '../../src/definitions';

type WorkerMethod = Exclude<keyof CapacitorSqlitePlugin, 'getPlatform'>;
type AnySqliteResult = SqliteResult<Record<string, unknown>>;

interface WorkerRequest {
  id: number;
  method: WorkerMethod;
  options: unknown;
}

interface WorkerResponse {
  id: number;
  result: AnySqliteResult;
}

interface PendingRequest {
  method: WorkerMethod;
  resolve: (result: AnySqliteResult) => void;
}

export class CapacitorSqlite implements CapacitorSqlitePlugin {
  private nextRequestId = 1;
  private worker: Worker | null = null;
  private pending = new Map<number, PendingRequest>();

  // MARK: - Plugin metadata

  async getPlatform(): Promise<SqliteResult<{ platform: SqlitePlatform }>> {
    return { success: true, data: { platform: 'electron' } };
  }

  async isAvailable(): Promise<SqliteResult<{ available: boolean }>> {
    return this.request('isAvailable', undefined) as Promise<SqliteResult<{ available: boolean }>>;
  }

  // MARK: - Database lifecycle

  async open(options: OpenOptions): Promise<SqliteResult> {
    return this.request('open', options) as Promise<SqliteResult>;
  }

  async close(options: { database: string }): Promise<SqliteResult> {
    return this.request('close', options) as Promise<SqliteResult>;
  }

  async isOpen(options: { database: string }): Promise<SqliteResult<{ open: boolean }>> {
    return this.request('isOpen', options) as Promise<SqliteResult<{ open: boolean }>>;
  }

  // MARK: - Metadata and maintenance

  async getVersion(options: { database: string }): Promise<SqliteResult<{ version: string }>> {
    return this.request('getVersion', options) as Promise<SqliteResult<{ version: string }>>;
  }

  async getSchemaVersion(options: { database: string }): Promise<SqliteResult<{ version: number }>> {
    return this.request('getSchemaVersion', options) as Promise<SqliteResult<{ version: number }>>;
  }

  async vacuum(options: { database: string }): Promise<SqliteResult> {
    return this.request('vacuum', options) as Promise<SqliteResult>;
  }

  // MARK: - SQL operations

  async execute(options: ExecuteOptions): Promise<SqliteResult<{ changes: number }>> {
    return this.request('execute', options) as Promise<SqliteResult<{ changes: number }>>;
  }

  async run(options: RunOptions): Promise<SqliteResult<{ changes: number; lastInsertId: number }>> {
    return this.request('run', options) as Promise<SqliteResult<{ changes: number; lastInsertId: number }>>;
  }

  async runBatch(options: RunBatchOptions): Promise<SqliteResult<{ changes: number; lastInsertId: number }>> {
    return this.request('runBatch', options) as Promise<SqliteResult<{ changes: number; lastInsertId: number }>>;
  }

  async query<T = Record<string, unknown>>(options: QueryOptions): Promise<SqliteResult<{ rows: T[] }>> {
    return this.request('query', options) as Promise<SqliteResult<{ rows: T[] }>>;
  }

  // MARK: - Transactions

  async beginTransaction(options: { database: string }): Promise<SqliteResult> {
    return this.request('beginTransaction', options) as Promise<SqliteResult>;
  }

  async commitTransaction(options: { database: string }): Promise<SqliteResult> {
    return this.request('commitTransaction', options) as Promise<SqliteResult>;
  }

  async rollbackTransaction(options: { database: string }): Promise<SqliteResult> {
    return this.request('rollbackTransaction', options) as Promise<SqliteResult>;
  }

  private request(method: WorkerMethod, options: unknown): Promise<AnySqliteResult> {
    let worker: Worker;
    try {
      worker = this.getWorker();
    } catch (err) {
      return Promise.resolve(this.failure('NOT_AVAILABLE', method, err));
    }

    const id = this.nextRequestId++;
    const message: WorkerRequest = { id, method, options };
    return new Promise((resolve) => {
      this.pending.set(id, { method, resolve });
      try {
        worker.postMessage(message);
      } catch (err) {
        this.pending.delete(id);
        resolve(this.failure('UNKNOWN', method, err));
      }
    });
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(nodePath.join(__dirname, 'worker.cjs.js'), {
      workerData: {
        paths: {
          userData: app.getPath('userData'),
          temp: app.getPath('temp'),
        },
      },
    });
    worker.on('message', (message: WorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message.result);
    });
    worker.on('error', (err) => {
      this.failPending('UNKNOWN', err);
      this.worker = null;
    });
    worker.on('exit', (code) => {
      if (code !== 0) {
        this.failPending('UNKNOWN', new Error(`Electron SQLite worker exited with code ${code}`));
      }
      this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  private failPending(code: SqliteErrorCode, err: unknown): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.resolve(this.failure(code, pending.method, err));
    }
  }

  private failure(code: SqliteErrorCode, method: string, err: unknown): SqliteFailure {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        code,
        message,
        platform: 'electron',
        method,
        details: { nativeCode: code, nativeMessage: message, source: 'electron-worker-proxy' },
      },
    };
  }
}

// Electron main-process plugin for @devioarts/capacitor-sqlite.
// Import @devioarts/capacitor-sqlite/electron/settings from Capacitor Electron
// tooling, or register this class manually in your app's main-process IPC layer.

import { app } from 'electron';
import * as fs from 'fs';
import * as nodePath from 'path';
import { Worker } from 'worker_threads';

import type {
  CapacitorSqlitePlugin,
  ExecuteOptions,
  OpenOptions,
  QueryOptions,
  RunBatchOptions,
  RunManyOptions,
  RunManyResult,
  RunOptions,
  SqliteErrorCode,
  SqliteFailure,
  SqlitePlatform,
  SqliteResult,
} from '../../src/definitions';

type PluginWorkerMethod = Exclude<keyof CapacitorSqlitePlugin, 'getPluginPlatform'>;
type WorkerMethod = PluginWorkerMethod | '__queryCompact' | '__shutdown';
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
  worker: Worker;
  resolve: (result: AnySqliteResult) => void;
}

export class CapacitorSqlite implements CapacitorSqlitePlugin {
  private nextRequestId = 1;
  private worker: Worker | null = null;
  private pending = new Map<number, PendingRequest>();
  private disposing: Promise<void> | null = null;

  // MARK: - Plugin metadata

  async getPluginPlatform(): Promise<SqliteResult<{ platform: SqlitePlatform }>> {
    return { success: true, data: { platform: 'electron' } };
  }

  async isAvailable(): Promise<SqliteResult<{ available: boolean }>> {
    return this.request('isAvailable', undefined) as Promise<SqliteResult<{ available: boolean }>>;
  }

  /**
   * Terminates the worker thread that runs all SQLite work, failing any in-flight
   * requests with `NOT_AVAILABLE`. Not part of `CapacitorSqlitePlugin` — call it
   * explicitly from your Electron main process, typically from `app.on('before-quit')`,
   * to release the worker (and let SQLite flush its WAL) before the process exits.
   * A later call automatically spawns a fresh worker on demand, so this is also safe to
   * use to recover from a worker stuck in a bad state.
   */
  async dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    const operation = this.disposeCurrentWorker();
    this.disposing = operation;
    try {
      await operation;
    } finally {
      if (this.disposing === operation) this.disposing = null;
    }
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

  async runMany(options: RunManyOptions): Promise<SqliteResult<RunManyResult>> {
    return this.request('runMany', options) as Promise<SqliteResult<RunManyResult>>;
  }

  async query<T = Record<string, unknown>>(options: QueryOptions): Promise<SqliteResult<{ rows: T[] }>> {
    if ((options as unknown as Record<string, unknown>).__capacitorSqliteCompactRows === true) {
      // Internal renderer request: keep the columnar representation through both
      // structured-clone boundaries. src/index.ts restores public row objects.
      return this.request('__queryCompact', options) as Promise<SqliteResult<{ rows: T[] }>>;
    }
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
    if (this.disposing) return this.disposing.then(() => this.request(method, options));
    let worker: Worker;
    try {
      worker = this.getWorker();
    } catch (err) {
      return Promise.resolve(this.failure('NOT_AVAILABLE', method, err));
    }

    return this.requestWithWorker(worker, method, options);
  }

  private requestWithWorker(worker: Worker, method: WorkerMethod, options: unknown): Promise<AnySqliteResult> {
    const id = this.nextRequestId++;
    const message: WorkerRequest = { id, method, options };
    return new Promise((resolve) => {
      this.pending.set(id, { method, worker, resolve });
      try {
        worker.postMessage(message);
      } catch (err) {
        this.pending.delete(id);
        resolve(this.failure('UNKNOWN', method, err));
      }
    });
  }

  private async disposeCurrentWorker(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    // Queue shutdown behind all earlier requests so transactions are rolled back
    // and handles are closed before the thread is terminated.
    await this.requestWithWorker(worker, '__shutdown', undefined);
    if (this.worker === worker) this.worker = null;
    await worker.terminate();
  }

  private resolveWorkerFile(): string {
    // Plugin loaded from node_modules: worker.cjs.js sits next to plugin.cjs.js.
    const candidates: string[] = [];
    if (typeof __dirname === 'string') {
      candidates.push(nodePath.join(__dirname, 'worker.cjs.js'));
    }
    // App builds that bundle the main process (esbuild/rollup/webpack) inline
    // this module, relocating __dirname into the app's own dist folder. Resolve
    // the installed package at runtime instead. The specifier is concatenated
    // so bundlers keep this as a runtime require.resolve call.
    try {
      const pkg = '@devioarts/capacitor-sqlite';
      candidates.push(require.resolve(pkg + '/electron/worker'));
    } catch {
      /* package not resolvable at runtime — fall through to the error below */
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(
      `capacitor-sqlite: Electron worker file not found (looked for: ${candidates.join(', ')}). ` +
        'If your build bundles the Electron main process, ship the plugin as a runtime dependency ' +
        "so require.resolve('@devioarts/capacitor-sqlite/electron/worker') works, or copy " +
        'node_modules/@devioarts/capacitor-sqlite/electron/dist/worker.cjs.js next to your main bundle.',
    );
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(this.resolveWorkerFile(), {
      workerData: {
        paths: {
          userData: app.getPath('userData'),
          temp: app.getPath('temp'),
        },
      },
    });
    worker.on('message', (message: WorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (pending?.worker !== worker) return;
      this.pending.delete(message.id);
      pending.resolve(message.result);
    });
    worker.on('error', (err) => {
      this.failPending('UNKNOWN', err, worker);
      if (this.worker === worker) this.worker = null;
    });
    worker.on('exit', (code) => {
      if (code !== 0) {
        this.failPending('UNKNOWN', new Error(`Electron SQLite worker exited with code ${code}`), worker);
      }
      if (this.worker === worker) this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  private failPending(code: SqliteErrorCode, err: unknown, worker?: Worker): void {
    for (const [id, pending] of this.pending) {
      if (worker && pending.worker !== worker) continue;
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

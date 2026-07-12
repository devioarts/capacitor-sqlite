import { parentPort, workerData } from 'worker_threads';

import type { CapacitorSqlitePlugin, SqliteFailure, SqliteResult } from '../../src/definitions';

import { ElectronSqliteBackend, type ElectronSqliteBackendPaths } from './backend';

type WorkerMethod = Exclude<keyof CapacitorSqlitePlugin, 'getPlatform'> | '__queryCompact' | '__shutdown';
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

interface WorkerInitData {
  paths: ElectronSqliteBackendPaths;
}

const port = parentPort;
if (!port) {
  throw new Error('capacitor-sqlite Electron worker requires parentPort');
}

const initData = workerData as WorkerInitData;
const backend = new ElectronSqliteBackend(initData.paths);

port.on('message', async (message: WorkerRequest) => {
  const response: WorkerResponse = {
    id: message.id,
    result: await dispatch(message.method, message.options),
  };
  port.postMessage(response);
});

async function dispatch(method: WorkerMethod, options: unknown): Promise<AnySqliteResult> {
  try {
    switch (method) {
      case 'isAvailable':
        return backend.isAvailable();
      case 'open':
        return backend.open(options as Parameters<CapacitorSqlitePlugin['open']>[0]);
      case 'close':
        return backend.close(options as Parameters<CapacitorSqlitePlugin['close']>[0]);
      case 'isOpen':
        return backend.isOpen(options as Parameters<CapacitorSqlitePlugin['isOpen']>[0]);
      case 'getVersion':
        return backend.getVersion(options as Parameters<CapacitorSqlitePlugin['getVersion']>[0]);
      case 'getSchemaVersion':
        return backend.getSchemaVersion(options as Parameters<CapacitorSqlitePlugin['getSchemaVersion']>[0]);
      case 'vacuum':
        return backend.vacuum(options as Parameters<CapacitorSqlitePlugin['vacuum']>[0]);
      case 'execute':
        return backend.execute(options as Parameters<CapacitorSqlitePlugin['execute']>[0]);
      case 'run':
        return backend.run(options as Parameters<CapacitorSqlitePlugin['run']>[0]);
      case 'runBatch':
        return backend.runBatch(options as Parameters<CapacitorSqlitePlugin['runBatch']>[0]);
      case 'runMany':
        return backend.runMany(options as Parameters<CapacitorSqlitePlugin['runMany']>[0]);
      case 'query':
        return backend.query(options as Parameters<CapacitorSqlitePlugin['query']>[0]);
      case '__queryCompact':
        return backend.queryCompact(options as Parameters<CapacitorSqlitePlugin['query']>[0]);
      case 'beginTransaction':
        return backend.beginTransaction(options as Parameters<CapacitorSqlitePlugin['beginTransaction']>[0]);
      case 'commitTransaction':
        return backend.commitTransaction(options as Parameters<CapacitorSqlitePlugin['commitTransaction']>[0]);
      case 'rollbackTransaction':
        return backend.rollbackTransaction(options as Parameters<CapacitorSqlitePlugin['rollbackTransaction']>[0]);
      case '__shutdown':
        return backend.shutdown();
      default:
        return failure(method, new Error(`Unknown Electron SQLite worker method '${String(method)}'`));
    }
  } catch (err) {
    return failure(method, err);
  }
}

function failure(method: string, err: unknown): SqliteFailure {
  const message = err instanceof Error ? err.message : String(err);
  return {
    success: false,
    error: {
      code: 'UNKNOWN',
      message,
      platform: 'electron',
      method,
      details: { nativeCode: 'UNKNOWN', nativeMessage: message, source: 'electron-worker' },
    },
  };
}

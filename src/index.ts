import { registerPlugin, Capacitor } from '@capacitor/core';

import {
  decodeElectronCompactRows,
  ELECTRON_COMPACT_QUERY_OPTION,
  encodeNativeBridgeValues,
  usesJsonValueBridge,
} from './bridge-values';
import { assertAnonymousBindParameterCount, assertSingleSqlStatement } from './sql';
import type {
  CapacitorSqlitePlugin,
  QueryOptions,
  RunManyItemResult,
  RunManyOptions,
  RunManyResult,
  SQLiteValues,
  SqliteErrorCode,
  SqliteFailure,
  SqlitePlatform,
  SqliteResult,
} from './definitions';

// Must match BLOB_PREFIX in SQLiteHelpers.swift and SQLiteHelpers.kt.
const BLOB_PREFIX = 'blob64:';
const TEXT_PREFIX = 'text64:';

// Decode a single value arriving from the native bridge.
// BLOB columns are returned as "blob64:<base64>" strings; convert back to Uint8Array.
function decodeValue(v: unknown): unknown {
  if (typeof v === 'string' && v.startsWith(TEXT_PREFIX)) {
    try {
      const binary = atob(v.slice(TEXT_PREFIX.length));
      const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return v;
    }
  }
  if (typeof v === 'string' && v.startsWith(BLOB_PREFIX)) {
    try {
      const binary = atob(v.slice(BLOB_PREFIX.length));
      const arr = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
      return arr;
    } catch {
      return v;
    }
  }
  return v;
}

function decodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) out[k] = decodeValue(row[k]);
  return out;
}

function failureResult(
  method: string,
  code: SqliteErrorCode,
  err: unknown,
  platform: SqlitePlatform = Capacitor.getPlatform() as SqlitePlatform,
  source = 'capacitor-js-bridge',
): SqliteFailure {
  const message = err instanceof Error ? err.message : String(err);
  return {
    success: false,
    error: {
      code,
      message,
      platform,
      method,
      details: {
        nativeCode: code,
        nativeMessage: message,
        source,
      },
    },
  };
}

async function nativeCall<T extends Record<string, unknown>>(
  method: string,
  fn: () => Promise<SqliteResult<T>>,
  fallbackCode: SqliteErrorCode = 'UNKNOWN',
): Promise<SqliteResult<T>> {
  try {
    return await fn();
  } catch (err) {
    return failureResult(method, fallbackCode, err) as SqliteResult<T>;
  }
}

function unavailablePlugin(platform: SqlitePlatform, message: string): CapacitorSqlitePlugin {
  const failure = (method: string): Promise<SqliteResult> =>
    Promise.resolve(failureResult(method, 'NOT_AVAILABLE', new Error(message), platform, 'capacitor-js-bridge'));

  return {
    getPlatform: async () => ({ success: true, data: { platform } }),
    isAvailable: async () => ({ success: true, data: { available: false } }),
    open: () => failure('open'),
    close: () => failure('close'),
    isOpen: () => failure('isOpen') as Promise<SqliteResult<{ open: boolean }>>,
    getVersion: () => failure('getVersion') as Promise<SqliteResult<{ version: string }>>,
    getSchemaVersion: () => failure('getSchemaVersion') as Promise<SqliteResult<{ version: number }>>,
    vacuum: () => failure('vacuum'),
    execute: () => failure('execute') as Promise<SqliteResult<{ changes: number }>>,
    run: () => failure('run') as Promise<SqliteResult<{ changes: number; lastInsertId: number }>>,
    runBatch: () => failure('runBatch') as Promise<SqliteResult<{ changes: number; lastInsertId: number }>>,
    runMany: () => failure('runMany') as ReturnType<CapacitorSqlitePlugin['runMany']>,
    query: <T = Record<string, unknown>>() => failure('query') as Promise<SqliteResult<{ rows: T[] }>>,
    beginTransaction: () => failure('beginTransaction'),
    commitTransaction: () => failure('commitTransaction'),
    rollbackTransaction: () => failure('rollbackTransaction'),
  };
}

function electronPlugin(): CapacitorSqlitePlugin {
  // Capacitor's Electron bridge registers plugins on window.CapacitorCustomPlatform.
  // Guard every access so a missing main-process registration returns NOT_AVAILABLE.
  const globalObj = globalThis as any;
  const customPlatform = globalObj.window?.CapacitorCustomPlatform ?? globalObj.CapacitorCustomPlatform;
  const plugin = customPlatform?.plugins?.CapacitorSqlite as CapacitorSqlitePlugin | undefined;
  return (
    plugin ??
    unavailablePlugin('electron', 'CapacitorSqlite Electron plugin is not registered on CapacitorCustomPlatform')
  );
}

const _raw = registerPlugin<CapacitorSqlitePlugin>('CapacitorSqlite', {
  web: () => import('./web.js').then((m) => new m.CapacitorSqliteWeb()),
  electron: () => Promise.resolve(electronPlugin()),
});

// Capacitor classifies every custom platform (including Electron) as "native".
// Only Android/iOS actually use the JSON bridge that needs the tagged base64 BLOB
// envelope; Electron supports Uint8Array through structured clone and must not pay
// the million-number Array.from() conversion that used to happen here.
const platform = Capacitor.getPlatform();
const encodesBridgeValues = usesJsonValueBridge(platform);
const normalizesRejectedCalls = Capacitor.isNativePlatform();

function bridgeValues(values?: SQLiteValues): SQLiteValues | undefined {
  return (encodesBridgeValues ? encodeNativeBridgeValues(values) : values) as SQLiteValues | undefined;
}

function isMissingElectronRunMany(result: SqliteResult<RunManyResult>): boolean {
  return (
    platform === 'electron' && !result.success && /runmany\(\).*not implemented on electron/i.test(result.error.message)
  );
}

/**
 * Compatibility for Electron applications whose generated preload/main registry
 * predates runMany(). New registries call the native repeated-statement path. An
 * old registry can still provide correct behavior through methods it already
 * exposes, without the plugin modifying application-owned generated files.
 */
async function electronRunManyCompatibility(
  options: RunManyOptions,
  values: SQLiteValues[],
): Promise<SqliteResult<RunManyResult>> {
  if (!options.returnResults) {
    const batch = await nativeCall(
      'runMany',
      () =>
        _raw.runBatch({
          database: options.database,
          transaction: options.transaction,
          set: values.map((itemValues) => ({ statement: options.statement, values: itemValues })),
        }),
      'INVALID_PARAMS',
    );
    if (!batch.success) return batch;
    return { success: true, data: { changes: batch.data.changes, lastInsertId: 0 } };
  }

  const ownsTransaction = options.transaction !== false;
  if (ownsTransaction) {
    const begun = await nativeCall('runMany', () => _raw.beginTransaction({ database: options.database }));
    if (!begun.success) return begun;
  }

  const results: RunManyItemResult[] = [];
  let changes = 0;
  for (const itemValues of values) {
    const item = await nativeCall(
      'runMany',
      () => _raw.run({ database: options.database, statement: options.statement, values: itemValues }),
      'INVALID_PARAMS',
    );
    if (!item.success) {
      if (ownsTransaction) {
        await nativeCall('runMany', () => _raw.rollbackTransaction({ database: options.database }));
      }
      return item;
    }
    changes += item.data.changes;
    results.push({ changes: item.data.changes, lastInsertId: item.data.lastInsertId });
  }

  if (ownsTransaction) {
    const committed = await nativeCall('runMany', () => _raw.commitTransaction({ database: options.database }));
    if (!committed.success) return committed;
  }
  return { success: true, data: { changes, lastInsertId: 0, results } };
}

async function callRunMany(options: RunManyOptions): Promise<SqliteResult<RunManyResult>> {
  let values: SQLiteValues[];
  try {
    if (!options.statement.trim()) throw new Error("'statement' is required");
    if (options.values.length === 0) throw new Error("'values' must be a non-empty array of value arrays");
    assertSingleSqlStatement(options.statement, 'statement');
    options.values.forEach((itemValues, index) =>
      assertAnonymousBindParameterCount(options.statement, itemValues.length, `values[${index}]`),
    );
    // Encode and validate every set before the first native call. This preserves
    // runMany's no-partial-write validation guarantee in the old-Electron fallback.
    values = options.values.map((itemValues) => bridgeValues(itemValues) as SQLiteValues);
  } catch (error) {
    return failureResult('runMany', 'INVALID_PARAMS', error) as SqliteResult<RunManyResult>;
  }
  const direct = await nativeCall('runMany', () => _raw.runMany({ ...options, values }), 'INVALID_PARAMS');
  return isMissingElectronRunMany(direct) ? electronRunManyCompatibility(options, values) : direct;
}

export const CapacitorSqlite: CapacitorSqlitePlugin = normalizesRejectedCalls
  ? {
      getPlatform: () => nativeCall('getPlatform', () => _raw.getPlatform()),
      isAvailable: () => nativeCall('isAvailable', () => _raw.isAvailable()),
      open: (o) => nativeCall('open', () => _raw.open(o)),
      close: (o) => nativeCall('close', () => _raw.close(o)),
      isOpen: (o) => nativeCall('isOpen', () => _raw.isOpen(o)),
      getVersion: (o) => nativeCall('getVersion', () => _raw.getVersion(o)),
      getSchemaVersion: (o) => nativeCall('getSchemaVersion', () => _raw.getSchemaVersion(o)),
      vacuum: (o) => nativeCall('vacuum', () => _raw.vacuum(o)),
      execute: (o) => nativeCall('execute', () => _raw.execute(o)),
      run: (o) => nativeCall('run', () => _raw.run({ ...o, values: bridgeValues(o.values) }), 'INVALID_PARAMS'),
      runBatch: (o) =>
        nativeCall(
          'runBatch',
          () =>
            _raw.runBatch({
              ...o,
              set: o.set.map((s) => ({ ...s, values: bridgeValues(s.values) })),
            }),
          'INVALID_PARAMS',
        ),
      runMany: (o: RunManyOptions) => callRunMany(o),
      query: async <T>(o: QueryOptions) => {
        const usesCompactRows = platform === 'electron' || encodesBridgeValues;
        const queryOptions = usesCompactRows
          ? ({
              ...o,
              values: bridgeValues(o.values),
              [ELECTRON_COMPACT_QUERY_OPTION]: true,
            } as QueryOptions)
          : o;
        const r = await nativeCall('query', () => _raw.query<T>(queryOptions), 'INVALID_PARAMS');
        if (!r.success) return r;
        if (usesCompactRows) {
          try {
            const rows = decodeElectronCompactRows(r.data);
            const decodedRows = encodesBridgeValues ? rows.map(decodeRow) : rows;
            return { success: true as const, data: { rows: decodedRows as T[] } };
          } catch (error) {
            return failureResult('query', 'QUERY_FAILED', error, platform as SqlitePlatform, 'compact-row-decoder');
          }
        }
        return r;
      },
      beginTransaction: (o) => nativeCall('beginTransaction', () => _raw.beginTransaction(o)),
      commitTransaction: (o) => nativeCall('commitTransaction', () => _raw.commitTransaction(o)),
      rollbackTransaction: (o) => nativeCall('rollbackTransaction', () => _raw.rollbackTransaction(o)),
    }
  : _raw;

export * from './definitions.js';

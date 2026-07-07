import { registerPlugin, Capacitor } from '@capacitor/core';

import type {
  CapacitorSqlitePlugin,
  QueryOptions,
  SQLiteValues,
  SqliteErrorCode,
  SqliteFailure,
  SqlitePlatform,
  SqliteResult,
} from './definitions';

// Must match BLOB_PREFIX in SQLiteHelpers.swift and SQLiteHelpers.kt.
const BLOB_PREFIX = 'blob64:';
const TEXT_PREFIX = 'text64:';

// Encode a single value for the Capacitor native bridge.
// Uint8Array is not JSON-serialisable — the bridge turns it into a plain object
// {"0":n,"1":n,...} which native rejects. Convert to a plain number array instead;
// native detects List<*> / NSArray and binds it as a SQLite BLOB.
function encodeValue(v: unknown, label: string): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error(`'${label}' must be a finite number`);
    }
    if (Number.isInteger(v) && !Number.isSafeInteger(v)) {
      throw new Error(`'${label}' must be within Number.MAX_SAFE_INTEGER`);
    }
    return v;
  }
  if (v instanceof Uint8Array) return Array.from(v);
  // A plain number[] of bytes is also accepted as a BLOB shorthand on iOS/Android/Electron
  // (README "Value types"), so it's passed through unchanged here rather than rejected —
  // reject it here so a malformed byte array fails fast in JS instead of relying on each
  // native implementation to validate the same thing on its own.
  if (Array.isArray(v)) {
    const validBytes = v.every((item) => Number.isInteger(item) && item >= 0 && item <= 255);
    if (validBytes) return v;
  }
  throw new Error(`'${label}' has an unsupported value type`);
}

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

function encodeValues(values?: SQLiteValues): SQLiteValues | undefined {
  return values?.map((value, index) => encodeValue(value, `values[${index}]`)) as SQLiteValues | undefined;
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

// On web/electron the JS implementation receives Uint8Array directly (no JSON bridge),
// so no encoding/decoding is needed. On native (iOS/Android) the Capacitor bridge
// JSON-serialises all call options, so we must transform BLOBs on both sides.
const isNative = Capacitor.isNativePlatform();

export const CapacitorSqlite: CapacitorSqlitePlugin = isNative
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
      run: (o) => nativeCall('run', () => _raw.run({ ...o, values: encodeValues(o.values) }), 'INVALID_PARAMS'),
      runBatch: (o) =>
        nativeCall(
          'runBatch',
          () =>
            _raw.runBatch({
              ...o,
              set: o.set.map((s) => ({ ...s, values: encodeValues(s.values) })),
            }),
          'INVALID_PARAMS',
        ),
      query: async <T>(o: QueryOptions) => {
        const r = await nativeCall(
          'query',
          () => _raw.query<T>({ ...o, values: encodeValues(o.values) }),
          'INVALID_PARAMS',
        );
        if (!r.success) return r;
        return {
          success: true as const,
          data: { rows: (r.data.rows as Record<string, unknown>[]).map(decodeRow) as unknown as T[] },
        };
      },
      beginTransaction: (o) => nativeCall('beginTransaction', () => _raw.beginTransaction(o)),
      commitTransaction: (o) => nativeCall('commitTransaction', () => _raw.commitTransaction(o)),
      rollbackTransaction: (o) => nativeCall('rollbackTransaction', () => _raw.rollbackTransaction(o)),
    }
  : _raw;

export * from './definitions.js';

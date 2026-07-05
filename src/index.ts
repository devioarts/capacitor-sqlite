import { registerPlugin, Capacitor } from '@capacitor/core';

import type { CapacitorSqlitePlugin, QueryOptions, SQLiteValues, SqliteResult } from './definitions';

// Must match BLOB_PREFIX in SQLiteHelpers.swift and SQLiteHelpers.kt.
const BLOB_PREFIX = 'blob64:';
const TEXT_PREFIX = 'text64:';

// Encode a single value for the Capacitor native bridge.
// Uint8Array is not JSON-serialisable — the bridge turns it into a plain object
// {"0":n,"1":n,...} which native rejects. Convert to a plain number array instead;
// native detects List<*> / NSArray and binds it as a SQLite BLOB.
function encodeValue(v: unknown): unknown {
  if (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)) {
    throw new Error('integer values must be within Number.MAX_SAFE_INTEGER');
  }
  if (v instanceof Uint8Array) return Array.from(v);
  return v;
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
  return values?.map(encodeValue) as SQLiteValues | undefined;
}

function decodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) out[k] = decodeValue(row[k]);
  return out;
}

async function nativeCall<T extends Record<string, unknown>>(
  method: string,
  fn: () => Promise<SqliteResult<T>>,
): Promise<SqliteResult<T>> {
  try {
    return await fn();
  } catch (err) {
    return {
      success: false,
      // These failures originate in the JS bridge wrapper before native code is called.
      error: {
        code: 'INVALID_PARAMS',
        message: err instanceof Error ? err.message : String(err),
        platform: Capacitor.getPlatform() as 'ios' | 'android',
        method,
        details: {
          nativeCode: 'INVALID_PARAMS',
          nativeMessage: err instanceof Error ? err.message : String(err),
          source: 'capacitor-js-bridge',
        },
      },
    };
  }
}

const _raw = registerPlugin<CapacitorSqlitePlugin>('CapacitorSqlite', {
  web: () => import('./web.js').then((m) => new m.CapacitorSqliteWeb()),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  electron: () =>
    Promise.resolve((window as any).CapacitorCustomPlatform.plugins.CapacitorSqlite as CapacitorSqlitePlugin),
});

// On web/electron the JS implementation receives Uint8Array directly (no JSON bridge),
// so no encoding/decoding is needed. On native (iOS/Android) the Capacitor bridge
// JSON-serialises all call options, so we must transform BLOBs on both sides.
const isNative = Capacitor.isNativePlatform();

export const CapacitorSqlite: CapacitorSqlitePlugin = isNative
  ? {
      getPlatform: () => _raw.getPlatform(),
      isAvailable: () => _raw.isAvailable(),
      open: (o) => _raw.open(o),
      close: (o) => _raw.close(o),
      isOpen: (o) => _raw.isOpen(o),
      getVersion: (o) => _raw.getVersion(o),
      getSchemaVersion: (o) => _raw.getSchemaVersion(o),
      vacuum: (o) => _raw.vacuum(o),
      execute: (o) => _raw.execute(o),
      run: (o) => nativeCall('run', () => _raw.run({ ...o, values: encodeValues(o.values) })),
      runBatch: (o) =>
        nativeCall('runBatch', () =>
          _raw.runBatch({
            ...o,
            set: o.set.map((s) => ({ ...s, values: encodeValues(s.values) })),
          }),
        ),
      query: async <T>(o: QueryOptions) => {
        const r = await nativeCall('query', () => _raw.query<T>({ ...o, values: encodeValues(o.values) }));
        if (!r.success) return r;
        return {
          success: true as const,
          data: { rows: (r.data.rows as Record<string, unknown>[]).map(decodeRow) as unknown as T[] },
        };
      },
      beginTransaction: (o) => _raw.beginTransaction(o),
      commitTransaction: (o) => _raw.commitTransaction(o),
      rollbackTransaction: (o) => _raw.rollbackTransaction(o),
    }
  : _raw;

export * from './definitions.js';

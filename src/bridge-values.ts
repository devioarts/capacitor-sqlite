// Internal wire format used only across Capacitor's JSON-based Android/iOS bridge.
// A tagged object avoids confusing an ordinary user string with an encoded BLOB.
export const NATIVE_BLOB_BASE64_KEY = '__capacitorSqliteBlobBase64';
export const ELECTRON_COMPACT_QUERY_OPTION = '__capacitorSqliteCompactRows';

export type NativeBlobEnvelope = { [NATIVE_BLOB_BASE64_KEY]: string };

export function usesJsonValueBridge(platform: string): boolean {
  return platform === 'android' || platform === 'ios';
}

function bytesToBase64(value: Uint8Array): string {
  // Keep each spread comfortably below engine argument limits and align chunks to
  // three bytes so concatenating their independently encoded base64 is valid.
  const chunkSize = 24_576;
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    const chunk = value.subarray(offset, Math.min(offset + chunkSize, value.length));
    chunks.push(btoa(String.fromCharCode(...chunk)));
  }
  return chunks.join('');
}

export function encodeNativeBridgeValue(value: unknown, label: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`'${label}' must be a finite number`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`'${label}' must be within Number.MAX_SAFE_INTEGER`);
    }
    return value;
  }

  let bytes: Uint8Array | null = null;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (Array.isArray(value)) {
    const validBytes = value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255);
    if (validBytes) bytes = Uint8Array.from(value as number[]);
  }
  if (bytes) return { [NATIVE_BLOB_BASE64_KEY]: bytesToBase64(bytes) } satisfies NativeBlobEnvelope;

  throw new Error(`'${label}' has an unsupported value type`);
}

export function encodeNativeBridgeValues(values: readonly unknown[] | undefined): unknown[] | undefined {
  return values?.map((value, index) => encodeNativeBridgeValue(value, `values[${index}]`));
}

export function decodeElectronCompactRows(value: unknown): Record<string, unknown>[] {
  if (typeof value !== 'object' || value === null) throw new Error('Electron returned no compact query result');
  const compact = (value as { compactRows?: { columns?: unknown; values?: unknown } }).compactRows;
  if (!compact || !Array.isArray(compact.columns) || !Array.isArray(compact.values)) {
    throw new Error('Electron returned an invalid compact query result');
  }
  if (!compact.columns.every((column): column is string => typeof column === 'string')) {
    throw new Error('Electron returned invalid compact column names');
  }
  const columns = compact.columns as string[];
  return compact.values.map((values) => {
    if (!Array.isArray(values) || values.length !== columns.length) {
      throw new Error('Electron returned an invalid compact row');
    }
    const row: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      row[column] = values[index];
    });
    return row;
  });
}

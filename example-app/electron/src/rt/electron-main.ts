// Auto-generated — do not edit.
// Regenerate with: npm run update

import { app, ipcMain } from 'electron';
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite/electron';

type AnyRecord = Record<string, unknown>;

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function registerPlugin(pluginClass: string, instance: AnyRecord, methods: readonly string[]): void {
  for (const method of methods) {
    ipcMain.handle(`${pluginClass}-${method}`, async (_event, opts: unknown) => {
      if (!isPlainObject(opts) && opts !== undefined) {
        return { success: false, error: { code: 'INVALID_PARAMS', message: 'Options must be a plain object', platform: 'electron', method, details: {} } };
      }
      try {
        return await (instance[method] as (opts: AnyRecord) => Promise<unknown>)((opts ?? {}) as AnyRecord);
      } catch (err) {
        return { success: false, error: { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err), platform: 'electron', method, details: {} } };
      }
    });
  }
}

void (async () => {
  await app.whenReady();
  const capacitorSqlite = new CapacitorSqlite();
  registerPlugin('CapacitorSqlite', capacitorSqlite as unknown as AnyRecord, ['getPlatform', 'isAvailable', 'open', 'close', 'isOpen', 'getVersion', 'getSchemaVersion', 'vacuum', 'execute', 'run', 'runBatch', 'query', 'beginTransaction', 'commitTransaction', 'rollbackTransaction']);
})();

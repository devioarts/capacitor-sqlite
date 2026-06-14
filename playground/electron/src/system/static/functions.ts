import { ipcMain, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig, ElectronConfig } from './types';

export type AnyRecord = Record<string, unknown>;
export type EventHooks = Record<string, { onAdd?: () => void; onRemove?: () => void }>;

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Broadcast an event from a plugin to all renderer windows.
 *
 * Safe to call before any window exists — the loop over `BrowserWindow.getAllWindows()`
 * simply runs zero iterations in that case.
 *
 * @param pluginClass  Class name of the plugin (e.g. `'MyPlugin'`).
 * @param eventType    Event name matching one of the plugin's declared `pluginEvents`.
 * @param data         Optional payload forwarded verbatim to the renderer listener.
 */
export function emitPluginEvent(pluginClass: string, eventType: string, data?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(`event-${pluginClass}-${eventType}`, data);
    }
  }
}

/**
 * Register a plugin's IPC handlers in the main process.
 *
 * For each method in `methods`, registers an `ipcMain.handle` handler on the
 * channel `{pluginClass}-{method}`. The options argument must be a plain JSON
 * object; errors thrown by the implementation are caught and returned as a
 * structured `{ success: false, error }` object so the renderer can inspect them.
 *
 * When `events` is provided, registers `event-add-{pluginClass}` and
 * `event-remove-{pluginClass}-{type}` listeners used by the preload to start
 * and stop lazy event sources (e.g. hardware sensors, file watchers).
 *
 * @param pluginClass  Class name used as the IPC channel prefix.
 * @param instance     Plugin instance whose methods are invoked by the handlers.
 * @param methods      Method names to expose via IPC.
 * @param events       Optional lifecycle hooks for lazy event sources.
 */
export function registerPlugin(pluginClass: string, instance: AnyRecord, methods: readonly string[], events?: EventHooks): void {
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

  if (events && Object.keys(events).length > 0) {
    ipcMain.on(`event-add-${pluginClass}`, (_event, type: string) => {
      events[type]?.onAdd?.();
    });
    for (const [type, hooks] of Object.entries(events)) {
      if (hooks.onRemove) {
        ipcMain.on(`event-remove-${pluginClass}-${type}`, () => hooks.onRemove!());
      }
    }
  }
}

/**
 * Read `capacitor.config.json` from the `electron/` directory and extract the
 * root app config and the `plugins.Electron` section.
 *
 * Returns empty objects when the file is absent or unparseable — this is expected
 * before `cap-electron sync` has been run for the first time.
 */
export function loadConfig(): { appCfg: AppConfig; cfg: ElectronConfig } {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'capacitor.config.json'), 'utf-8')
    ) as AppConfig;
    return { appCfg: raw, cfg: raw.plugins?.Electron ?? {} };
  } catch {
    return { appCfg: {}, cfg: {} };
  }
}

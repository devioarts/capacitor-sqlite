// Electron implementation of @capacitor/preferences
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { registerPlugin, type AnyRecord } from './functions';

// ── In-memory store + disk persistence ───────────────────────────────────────

const store     = new Map<string, string>();
const storePath = path.join(app.getPath('userData'), 'preferences.json');

try {
  const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') store.set(k, v);
  }
} catch { /* file absent or corrupted on first run */ }

function persist(): void {
  fs.writeFileSync(storePath, JSON.stringify(Object.fromEntries(store)), 'utf-8');
}

// ── Plugin class ──────────────────────────────────────────────────────────────

/**
 * Electron implementation of the Capacitor Preferences plugin.
 *
 * Stores data in `userData/preferences.json`. An in-memory Map serves as a
 * write-through cache so reads never hit disk.
 *
 * Advantages over the web fallback (localStorage):
 * - Data survives "Clear browsing data" in Chromium.
 * - No 5–10 MB size limit.
 * - Accessible from the main process.
 *
 * Limitations:
 * - The `group` (namespace) option is ignored — all keys share one flat store.
 * - `migrate()` and `removeOld()` are no-ops (no localStorage migration on Electron).
 */
class Preferences {
  async get(opts: AnyRecord): Promise<{ value: string | null }> {
    return { value: store.get(opts['key'] as string) ?? null };
  }

  async set(opts: AnyRecord): Promise<void> {
    store.set(opts['key'] as string, opts['value'] as string);
    persist();
  }

  async remove(opts: AnyRecord): Promise<void> {
    store.delete(opts['key'] as string);
    persist();
  }

  async clear(): Promise<void> {
    store.clear();
    persist();
  }

  async keys(): Promise<{ keys: string[] }> {
    return { keys: [...store.keys()] };
  }

  async migrate(): Promise<{ migrated: string[]; existing: string[] }> {
    return { migrated: [], existing: [] };
  }

  async removeOld(): Promise<void> {}
}

registerPlugin(
  'Preferences',
  new Preferences() as unknown as AnyRecord,
  ['get', 'set', 'remove', 'clear', 'keys', 'migrate', 'removeOld'],
);

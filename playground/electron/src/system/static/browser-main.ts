// Electron implementation of @capacitor/browser and @capacitor/app-launcher
import { shell } from 'electron';
import { registerPlugin, type AnyRecord } from './functions';

const UNSAFE_SCHEMES = ['javascript:', 'data:', 'vbscript:'];

function isSafe(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return !UNSAFE_SCHEMES.some(s => lower.startsWith(s));
}

// ── @capacitor/browser ────────────────────────────────────────────────────────

/**
 * Electron implementation of the Capacitor Browser plugin.
 *
 * Uses `shell.openExternal` — the URL opens in the default OS browser.
 *
 * Limitations:
 * - `close()` is a no-op — Electron cannot close an external browser window.
 * - `getSnapshot()` returns null — no access to the external browser's content.
 * - `browserFinished` and `browserPageLoaded` events are never emitted
 *   (shell.openExternal is fire-and-forget).
 */
class Browser {
  async open(opts: AnyRecord): Promise<void> {
    const url = opts['url'] as string;
    if (!isSafe(url)) throw new Error(`Refused to open unsafe URL: ${url}`);
    await shell.openExternal(url);
  }

  async close(): Promise<void> { /* no-op — OS owns the window */ }

  async getSnapshot(): Promise<null> { return null; }
}

registerPlugin('Browser', new Browser() as unknown as AnyRecord, ['open', 'close', 'getSnapshot']);

// ── @capacitor/app-launcher ───────────────────────────────────────────────────

/**
 * Electron implementation of the Capacitor AppLauncher plugin.
 *
 * Uses `shell.openExternal` to open URLs / app deep-link URIs.
 *
 * Limitations:
 * - `canOpenUrl()` always returns `{ value: true }` — Electron has no API to test
 *   whether a URL scheme is registered on the system.
 */
class AppLauncher {
  async canOpenUrl(): Promise<{ value: boolean }> {
    return { value: true };
  }

  async openUrl(opts: AnyRecord): Promise<{ completed: boolean }> {
    const url = opts['url'] as string;
    if (!isSafe(url)) return { completed: false };
    try {
      await shell.openExternal(url);
      return { completed: true };
    } catch {
      return { completed: false };
    }
  }
}

registerPlugin('AppLauncher', new AppLauncher() as unknown as AnyRecord, ['canOpenUrl', 'openUrl']);

// Electron implementation of @capacitor/app
import { app, BrowserWindow } from 'electron';
import { registerPlugin, emitPluginEvent, loadConfig, type AnyRecord, type EventHooks } from './functions';

function getMainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0];
}

function parseLaunchUrl(): string | null {
  const argv = process.argv.slice(app.isPackaged ? 1 : 2);
  return argv.find(a => a.includes('://')) ?? null;
}

// ── Plugin class ──────────────────────────────────────────────────────────────

/**
 * Electron implementation of the Capacitor App plugin.
 *
 * `appStateChange`, `resume`, and `pause` are emitted via focus/blur window events.
 * `appUrlOpen` is forwarded from the deep-link system (deep-link-main.ts emits it).
 * `backButton` is a no-op on desktop.
 * `minimizeApp` maps to `win.minimize()` — Android-only in Capacitor but sensible on desktop.
 */
class App {
  async getInfo(): Promise<{ id: string; name: string; build: string; version: string }> {
    const { appCfg } = loadConfig();
    const id      = appCfg.appId ?? app.getName();
    const version = app.getVersion();
    return { id, name: app.getName(), build: version, version };
  }

  async getState(): Promise<{ isActive: boolean }> {
    const win = getMainWindow();
    return { isActive: !!win && !win.isMinimized() && win.isFocused() };
  }

  async exitApp(): Promise<void> { app.quit(); }

  async minimizeApp(): Promise<void> { getMainWindow()?.minimize(); }

  async getLaunchUrl(): Promise<{ url: string } | null> {
    const url = parseLaunchUrl();
    return url ? { url } : null;
  }
}

// ── Window event hooks ────────────────────────────────────────────────────────
// Shared ref-count so appStateChange, resume, and pause share one pair of
// focus/blur handlers — each type independently adds/removes the listener.

let listenCount  = 0;
let focusHandler: (() => void) | null = null;
let blurHandler:  (() => void) | null = null;

function attachWindowListeners(): void {
  if (++listenCount !== 1) return;
  const win = getMainWindow();
  if (!win) return;
  focusHandler = () => {
    emitPluginEvent('App', 'appStateChange', { isActive: true });
    emitPluginEvent('App', 'resume');
  };
  blurHandler = () => {
    emitPluginEvent('App', 'appStateChange', { isActive: false });
    emitPluginEvent('App', 'pause');
  };
  win.on('focus', focusHandler);
  win.on('blur',  blurHandler);
}

function detachWindowListeners(): void {
  if (--listenCount > 0) return;
  const win = getMainWindow();
  if (win && focusHandler) win.removeListener('focus', focusHandler);
  if (win && blurHandler)  win.removeListener('blur',  blurHandler);
  focusHandler = null;
  blurHandler  = null;
}

const events: EventHooks = {
  appStateChange: { onAdd: attachWindowListeners, onRemove: detachWindowListeners },
  resume:         { onAdd: attachWindowListeners, onRemove: detachWindowListeners },
  pause:          { onAdd: attachWindowListeners, onRemove: detachWindowListeners },
  appUrlOpen:     {},  // emitted from deep-link-main.ts via emitPluginEvent('App', 'appUrlOpen')
  backButton:     {},  // no-op on desktop
};

registerPlugin(
  'App',
  new App() as unknown as AnyRecord,
  ['getInfo', 'getState', 'exitApp', 'minimizeApp', 'getLaunchUrl'],
  events,
);

import { app, BrowserWindow } from 'electron';
import { emitPluginEvent } from './functions';

let _pending: string | null = null;

function urlFromArgv(argv: string[], scheme: string): string | undefined {
  return argv.find(arg => arg.startsWith(`${scheme}://`));
}

function forward(url: string, getWin: () => BrowserWindow | null): void {
  const win = getWin();
  if (!win || win.isDestroyed()) {
    _pending = url;
    return;
  }
  _pending = null;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  win.webContents.send('deepLink', { url });
  emitPluginEvent('App', 'appUrlOpen', { url });
}

/** Register the protocol and event listeners. Call before app.whenReady(). */
export function setupDeepLinking(scheme: string, getWin: () => BrowserWindow | null): void {
  if (!app.isPackaged) {
    console.warn(`[deep-link] Registering '${scheme}://' protocol in dev mode`);
  }

  app.setAsDefaultProtocolClient(scheme);

  // macOS: system fires open-url when the app is launched via protocol URL
  app.on('open-url', (event, url) => {
    event.preventDefault();
    forward(url, getWin);
  });

  // Windows second-instance: the deep link URL is passed as a CLI argument.
  // Also handles plain second-instance launch (no URL) — restore + focus.
  app.on('second-instance', (_event, argv) => {
    const url = urlFromArgv(argv, scheme);
    if (url) {
      forward(url, getWin);
    } else {
      const win = getWin();
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    }
  });

  app.on('will-quit', () => app.removeAsDefaultProtocolClient(scheme));
}

/**
 * Handle Windows startup URL and flush any URL that arrived before the window was ready.
 * Call after createWindow() inside app.whenReady().
 */
export function flushDeepLink(scheme: string, getWin: () => BrowserWindow | null): void {
  if (process.platform === 'win32') {
    const url = urlFromArgv(process.argv, scheme);
    if (url) { forward(url, getWin); return; }
  }
  if (_pending) forward(_pending, getWin);
}

import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { loadConfig, setupUpdater, setupDeepLinking, flushDeepLink, setupCSP, setupMenu, setupSplash, loadWindowState, trackWindowState, setupShortcuts, setupTray } from './src';
import { shortcuts } from './src/user/shortcuts';
import { trayMenu } from './src/user/tray';
import { onReady } from './src/user/main-user';

const isDev = !app.isPackaged;

const { appCfg, cfg } = loadConfig();

// Single instance lock — default on, opt-out with singleInstance: false
if (cfg.singleInstance !== false && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  setup();
}

function setup(): void {
  let win: BrowserWindow | null = null;
  const getWin = () => win;

  if (cfg.deepLinkingScheme) {
    setupDeepLinking(cfg.deepLinkingScheme, getWin);
  }

  /**
   * Create the main BrowserWindow and load the web app.
   *
   * @param hideSplash     Callback that closes the splash screen once the renderer
   *                       fires `did-finish-load`. Pass `null` when reopening on macOS.
   * @param hookTrayWindow Callback from `setupTray` that wires up close-to-tray
   *                       behaviour. `null` when `minimizeToTray` is disabled.
   */
  function createWindow(hideSplash?: (() => void) | null, hookTrayWindow?: ((win: BrowserWindow) => void) | null): void {
    const iconPath = cfg.icon
      ? path.join(__dirname, '..', cfg.icon)
      : undefined;

    const windowState = loadWindowState(cfg);

    win = new BrowserWindow({
      width:          windowState.width,
      height:         windowState.height,
      x:              windowState.x,
      y:              windowState.y,
      minWidth:       cfg.minWidth,
      minHeight:      cfg.minHeight,
      fullscreen:     cfg.fullscreen      ?? false,
      fullscreenable: cfg.fullscreenable  !== false,
      resizable:      cfg.resizable       !== false,
      center:         windowState.x == null && cfg.center !== false,
      alwaysOnTop:    cfg.alwaysOnTop    ?? false,
      kiosk:          cfg.kiosk          ?? false,
      frame:            cfg.frame          !== false,
      titleBarStyle:    cfg.titleBarStyle,
      autoHideMenuBar:  cfg.autoHideMenuBar ?? false,
      backgroundColor:  appCfg.backgroundColor,
      title:            appCfg.appName,
      icon:             iconPath && fs.existsSync(iconPath) ? iconPath : undefined,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration:  false,
        sandbox:          cfg.sandbox,
        preload:          path.join(__dirname, 'preload.cjs'),
      },
    });

    if (isDev) {
      win.loadURL(cfg.devUrl ?? 'http://localhost:5173');
      if (cfg.openDevTools !== false) win.webContents.openDevTools();
      watchPreloadSignal(win);
    } else {
      win.loadFile(path.join(process.resourcesPath, 'app', 'index.html'));
      if (cfg.openDevTools === true) win.webContents.openDevTools();
    }

    if (windowState.isMaximized) win.maximize();
    if (cfg.persistWindowState) trackWindowState(win);

    if (hideSplash) win.webContents.once('did-finish-load', hideSplash);
    if (hookTrayWindow) hookTrayWindow(win);

    win.on('closed', () => { win = null; });
  }

  app.whenReady().then(() => {
    setupCSP(cfg, isDev);
    setupMenu(cfg, isDev);
    setupShortcuts(shortcuts, getWin);
    const hookTrayWindow = setupTray(cfg, getWin, trayMenu);
    const hideSplash = setupSplash(cfg);
    createWindow(hideSplash, hookTrayWindow);
    onReady(getWin);
    if (cfg.deepLinkingScheme) flushDeepLink(cfg.deepLinkingScheme, getWin);
    setupUpdater(cfg);

    // macOS: reopen window when clicking dock icon
    app.on('activate', () => {
      if (win === null) createWindow(null, hookTrayWindow);
      else { win.show(); win.focus(); }
    });

    // Bring window to front when second instance is launched
    // (skipped when deep linking is active — deep-link-main.ts handles focus there)
    if (!cfg.deepLinkingScheme) {
      app.on('second-instance', () => {
        if (win) {
          if (win.isMinimized()) win.restore();
          win.focus();
        }
      });
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/**
 * Watch the `.dev-reload` signal file written by `cap-electron open` whenever
 * `preload.cjs` is rebuilt, then reload the renderer so the fresh preload
 * script takes effect without restarting the whole Electron process.
 *
 * Only active in development (`isDev === true`).
 */
function watchPreloadSignal(win: BrowserWindow): void {
  const signalFile = path.join(__dirname, '.dev-reload');
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(signalFile, () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        if (!win.isDestroyed()) win.webContents.reload();
      }, 100);
    });
    win.on('closed', () => { watcher?.close(); });
  } catch {
    // Signal file absent means we're not running under cap-electron open — fine.
  }
}


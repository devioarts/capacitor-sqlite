import { app, globalShortcut, BrowserWindow, ipcMain } from 'electron';

/**
 * Built-in main-process actions available for global shortcuts.
 *
 * | Value             | Effect                                                        |
 * |-------------------|---------------------------------------------------------------|
 * | `quit`            | Quit the application                                         |
 * | `minimize`        | Minimize the window to the taskbar                           |
 * | `maximize`        | Maximize the window                                          |
 * | `toggleMaximize`  | Toggle between maximized and normal state                    |
 * | `toggleFullscreen`| Toggle fullscreen mode                                       |
 * | `toggleWindow`    | Show + focus when hidden/minimized, hide when visible        |
 * | `focus`           | Show and bring the window to the front                       |
 * | `reload`          | Reload the renderer                                          |
 * | `openDevTools`    | Open DevTools                                                |
 */
export type MainAction =
  | 'quit'
  | 'minimize'
  | 'maximize'
  | 'toggleMaximize'
  | 'toggleFullscreen'
  | 'toggleWindow'
  | 'focus'
  | 'reload'
  | 'openDevTools';

/**
 * A single global shortcut definition. Three mutually exclusive variants:
 *
 * - **event** — sends `{ event }` to the renderer via `window.Electron.onShortcut()`.
 *   Use this to trigger UI logic (open modals, toggle panels, etc.) from the renderer.
 *
 * - **action** — runs a built-in {@link MainAction} directly in the main process.
 *   Works even when the window is hidden (useful for tray / menu-bar apps).
 *
 * - **handler** — runs arbitrary custom code in the main process.
 *   Use when the built-in actions are not enough.
 *
 * @example
 * // Send an event to the renderer
 * { accelerator: 'CmdOrCtrl+Shift+K', event: 'open-search' }
 *
 * // Run a built-in action
 * { accelerator: 'CmdOrCtrl+Shift+H', action: 'toggle-window' }
 *
 * // Custom main-process code
 * { accelerator: 'CmdOrCtrl+Shift+L', handler: () => { myService.doSomething(); } }
 */
export type GlobalShortcutDef =
  | { accelerator: string; event: string }
  | { accelerator: string; action: MainAction }
  | { accelerator: string; handler: () => void };

type GetWin = () => BrowserWindow | null;

function runAction(action: MainAction, getWin: GetWin): void {
  const win = getWin();
  switch (action) {
    case 'quit':             app.quit(); return;
    case 'toggleWindow':
      if (!win) return;
      if (win.isVisible() && !win.isMinimized()) { win.hide(); }
      else { win.show(); win.focus(); }
      return;
  }
  if (!win) return;
  switch (action) {
    case 'minimize':         win.minimize(); break;
    case 'maximize':         win.maximize(); break;
    case 'toggleMaximize':   win.isMaximized() ? win.unmaximize() : win.maximize(); break;
    case 'toggleFullscreen': win.setFullScreen(!win.isFullScreen()); break;
    case 'focus':            win.show(); win.focus(); break;
    case 'reload':           win.webContents.reload(); break;
    case 'openDevTools':     win.webContents.openDevTools(); break;
  }
}

function registerDef(def: GlobalShortcutDef, getWin: GetWin): boolean {
  return globalShortcut.register(def.accelerator, () => {
    if ('handler' in def)      def.handler();
    else if ('action' in def)  runAction(def.action, getWin);
    else                       getWin()?.webContents.send('shortcut', { event: def.event });
  });
}

/**
 * Register global keyboard shortcuts and wire up IPC handlers for dynamic
 * registration from the renderer.
 *
 * Call this once inside `app.whenReady()` — after the window getter is available
 * but before `createWindow()` so shortcuts are active from the first launch.
 *
 * All shortcuts (static and dynamically added at runtime) are automatically
 * unregistered when the app quits via a single `will-quit` listener.
 *
 * Static shortcuts are defined in `src/user/shortcuts.ts`.
 * Dynamic shortcuts can be added at runtime from the renderer via
 * `window.Electron.registerShortcut()` / `window.Electron.unregisterShortcut()`.
 *
 * @param defs    Array of shortcut definitions from the user config.
 * @param getWin  Getter that returns the current main `BrowserWindow` (or null).
 */
export function setupShortcuts(defs: GlobalShortcutDef[], getWin: GetWin): void {
  app.on('will-quit', () => globalShortcut.unregisterAll());

  for (const def of defs) registerDef(def, getWin);

  ipcMain.handle('shortcuts:register', (_e, def: { accelerator: string; event: string }) =>
    globalShortcut.register(def.accelerator, () => {
      getWin()?.webContents.send('shortcut', { event: def.event });
    })
  );

  ipcMain.handle('shortcuts:unregister', (_e, accelerator: string) => {
    globalShortcut.unregister(accelerator);
  });
}

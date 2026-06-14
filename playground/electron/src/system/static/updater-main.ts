import { app, ipcMain, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { ElectronConfig } from './types';

// Variant B: exposed via window.Electron.updater namespace.
// Chosen over a Capacitor pseudo-plugin (Variant A) because the updater is
// platform infrastructure, not application logic, and fits alongside the
// existing system:* IPC layer that backs window.Electron.

/**
 * Configure `electron-updater` and wire up the IPC bridge for `window.Electron.updater`.
 *
 * Only active in packaged builds (`app.isPackaged === true`) when
 * `cfg.autoUpdater.enabled === true`. In all other cases, no-op IPC handlers
 * are registered so renderer calls (`checkForUpdate`, etc.) silently succeed
 * instead of rejecting with "no handler" errors.
 *
 * Updater errors are caught and logged — they never crash the main process.
 *
 * @param cfg  Electron platform config.
 */
export function setupUpdater(cfg: ElectronConfig): void {
  const active = app.isPackaged && cfg.autoUpdater?.enabled === true;

  if (!active) {
    // Register no-op handlers so renderer calls don't reject with "no handler" error
    ipcMain.handle('updater:checkForUpdate', () => {});
    ipcMain.handle('updater:downloadUpdate', () => {});
    ipcMain.handle('updater:quitAndInstall', () => {});
    return;
  }

  const uc = cfg.autoUpdater!;

  try {
    autoUpdater.channel              = uc.channel          ?? 'latest';
    autoUpdater.autoDownload         = uc.autoDownload      ?? false;
    autoUpdater.autoInstallOnAppQuit = uc.autoInstallOnQuit ?? true;
    autoUpdater.allowPrerelease      = uc.allowPrerelease   ?? false;
    autoUpdater.allowDowngrade       = uc.allowDowngrade    ?? false;

    function broadcast(type: string, data?: unknown): void {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('updater:event', { type, data });
        }
      }
    }

    autoUpdater.on('checking-for-update',  ()         => broadcast('checking-for-update'));
    autoUpdater.on('update-available',     (info)     => broadcast('update-available', info));
    autoUpdater.on('update-not-available', (info)     => broadcast('update-not-available', info));
    autoUpdater.on('download-progress',    (progress) => broadcast('download-progress', progress));
    autoUpdater.on('update-downloaded',    (info)     => broadcast('update-downloaded', info));
    autoUpdater.on('error',                (err)      => broadcast('error', { message: err?.message ?? String(err) }));

    ipcMain.handle('updater:checkForUpdate', () => { autoUpdater.checkForUpdates().catch(() => {}); });
    ipcMain.handle('updater:downloadUpdate', () => { autoUpdater.downloadUpdate().catch(() => {}); });
    ipcMain.handle('updater:quitAndInstall', () => { autoUpdater.quitAndInstall(); });
  } catch (err) {
    // updater errors are non-fatal — main process continues normally
    console.error('[updater] setup failed:', err);
  }
}

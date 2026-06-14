import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

function win(e: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender);
}

ipcMain.handle('system:quit',           ()                  => { app.quit(); });
ipcMain.handle('system:minimize',       (e)                 => {
  const w = win(e);
  if (w?.isFullScreen()) {
    w.once('leave-full-screen', () => w.minimize());
    w.setFullScreen(false);
  } else {
    w?.minimize();
  }
});
ipcMain.handle('system:maximize',       (e)                 => { win(e)?.maximize(); });
ipcMain.handle('system:unmaximize',     (e)                 => { win(e)?.unmaximize(); });
ipcMain.handle('system:toggleMaximize', (e)                 => { const w = win(e); w?.isMaximized() ? w.unmaximize() : w?.maximize(); });
ipcMain.handle('system:isMaximized',    (e)                 => win(e)?.isMaximized() ?? false);
ipcMain.handle('system:setFullscreen',  (e, flag: boolean)  => { win(e)?.setFullScreen(flag); });
ipcMain.handle('system:isFullscreen',   (e)                 => win(e)?.isFullScreen() ?? false);
ipcMain.handle('system:focus',          (e)                 => { win(e)?.focus(); });
ipcMain.handle('system:reload',         (e)                 => { win(e)?.reload(); });
ipcMain.handle('system:openDevTools',   (e)                 => { win(e)?.webContents.openDevTools(); });
ipcMain.handle('system:closeDevTools',  (e)                 => { win(e)?.webContents.closeDevTools(); });
ipcMain.handle('system:getAppVersion',  ()                  => app.getVersion());

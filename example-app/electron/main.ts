import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import './src/rt/electron-main';

const isDev = !app.isPackaged;

app.whenReady().then(() => {
  console.log('userData:', app.getPath('userData'));


  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

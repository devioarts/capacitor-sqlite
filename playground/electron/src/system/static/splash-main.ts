import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import type { ElectronConfig } from './types';

/**
 * Create a splash-screen window and return a callback that closes it.
 *
 * The splash is a frameless, always-on-top, centered window that displays `cfg.splashScreen.image`.
 * Pass the returned callback to `win.webContents.once('did-finish-load', hideSplash)` so the splash
 * closes automatically when the main renderer finishes loading.
 *
 * Returns `null` when `cfg.splashScreen` is not configured or has no `image` path.
 *
 * @param cfg  Electron platform config read from `capacitor.config.json`.
 * @returns    A `hideSplash()` function, or `null` if the splash is disabled.
 */
export function setupSplash(cfg: ElectronConfig): (() => void) | null {
  if (!cfg.splashScreen) return null;

  const {
    width = 400,
    height = 300,
    backgroundColor = '#ffffff',
    image,
    minDisplayTime = 0,
  } = cfg.splashScreen;

  if (!image) return null;

  const imageSrc = resolveImage(image);
  if (!imageSrc) return null;

  const html = buildHTML(backgroundColor, imageSrc);

  const splash = new BrowserWindow({
    width,
    height,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    center: true,
    resizable: false,
    focusable: false,
    transparent: backgroundColor === 'transparent',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const shownAt = Date.now();

  return function hideSplash(): void {
    const remaining = minDisplayTime - (Date.now() - shownAt);
    const close = () => { if (!splash.isDestroyed()) splash.close(); };
    if (remaining > 0) setTimeout(close, remaining);
    else close();
  };
}

function resolveImage(rel: string): string {
  const abs = path.join(__dirname, '..', rel);
  if (!fs.existsSync(abs)) return '';
  try {
    const data = fs.readFileSync(abs);
    const ext = path.extname(abs).slice(1).toLowerCase();
    const mime =
      ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
      ext === 'png'  ? 'image/png'       :
      ext === 'svg'  ? 'image/svg+xml'   :
      ext === 'gif'  ? 'image/gif'       :
      ext === 'webp' ? 'image/webp'      : 'image/png';
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch {
    return '';
  }
}

function buildHTML(bg: string, imageSrc: string): string {
  const imgTag = imageSrc
    ? `<img src="${imageSrc}" style="max-width:100%;max-height:100%;object-fit:contain">`
    : '';
  return `<!DOCTYPE html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;width:100vw;height:100vh;background:${bg};overflow:hidden">${imgTag}</body></html>`;
}

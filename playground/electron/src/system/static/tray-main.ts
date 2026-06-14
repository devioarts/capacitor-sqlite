import { app, Tray, Menu, BrowserWindow, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import type { ElectronConfig } from './types';

export type TrayMenuAction = 'show' | 'quit' | 'separator';

/**
 * A single tray context menu item. Four variants:
 *
 * - `show` — shows and focuses the main window
 * - `quit` — quits the application
 * - `separator` — visual divider line (no label needed)
 * - `handler` — runs arbitrary custom code in the main process
 *
 * @example
 * { label: 'Open', action: 'show' }
 * { action: 'separator' }
 * { label: 'Open Settings', handler: () => { shell.openPath(settingsPath); } }
 * { label: 'Quit', action: 'quit' }
 */
export type TrayMenuItemDef =
  | { label?: string; action: TrayMenuAction }
  | { label: string; handler: () => void };

type GetWin = () => BrowserWindow | null;

let isQuitting = false;

/**
 * Set up the system tray icon and context menu.
 *
 * Call inside `app.whenReady()`. Returns a `hookWindow` function when
 * `minimizeToTray` is enabled — pass it the newly created `BrowserWindow`
 * inside `createWindow()` to wire up the close-to-tray behaviour.
 *
 * @param cfg        Electron config (reads `cfg.tray.*` and `cfg.icon` as fallback).
 * @param getWin     Getter that returns the current main BrowserWindow (or null).
 * @param menuItems  Menu item definitions from `src/user/tray.ts`.
 * @returns          A `hookWindow(win)` function, or `null` if minimizeToTray is off.
 */
export function setupTray(
  cfg: ElectronConfig,
  getWin: GetWin,
  menuItems: TrayMenuItemDef[],
): ((win: BrowserWindow) => void) | null {
  if (!cfg.tray?.enabled) return null;

  const iconSrc = cfg.tray.icon ?? cfg.icon;
  let image = nativeImage.createEmpty();
  if (iconSrc) {
    const abs = path.join(__dirname, '..', iconSrc as string);
    if (fs.existsSync(abs)) image = nativeImage.createFromPath(abs);
  }

  const tray = new Tray(image);
  if (cfg.tray.tooltip) tray.setToolTip(cfg.tray.tooltip);

  type MenuItem = Parameters<typeof Menu.buildFromTemplate>[0][number];
  const template: MenuItem[] = menuItems.map(item => {
    if ('handler' in item) return { label: item.label, click: item.handler };
    if (item.action === 'separator') return { type: 'separator' as const };
    if (item.action === 'show') return {
      label: item.label ?? 'Open',
      click: () => { const w = getWin(); if (w) { w.show(); w.focus(); } },
    };
    return {
      label: item.label ?? 'Quit',
      click: () => { isQuitting = true; app.quit(); },
    };
  });

  tray.setContextMenu(Menu.buildFromTemplate(template));

  tray.on('click', () => {
    const win = getWin();
    if (!win) return;
    if (win.isVisible() && !win.isMinimized()) win.hide();
    else { win.show(); win.focus(); }
  });

  if (!cfg.tray.minimizeToTray) return null;

  app.on('before-quit', () => { isQuitting = true; });

  return (win: BrowserWindow) => {
    win.on('close', e => {
      if (isQuitting) return;
      e.preventDefault();
      win.hide();
    });
  };
}

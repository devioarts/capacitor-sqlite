import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import type { ElectronConfig } from './types';

/**
 * Configure the native application menu (menu bar).
 *
 * - `cfg.menu === undefined` — keeps Electron's default menu unchanged.
 * - `cfg.menu === false` — removes the menu entirely on Windows/Linux; on macOS keeps a
 *   minimal App menu (Quit only) because Cmd+Q must always work.
 * - `cfg.menu` is an object — builds a custom menu from the provided sub-options.
 *
 * Must be called inside `app.whenReady()`.
 *
 * @param cfg    Electron platform config.
 * @param isDev  `true` when the app is not packaged (forces `viewMenu` visible in dev).
 */
export function setupMenu(cfg: ElectronConfig, isDev: boolean): void {
  if (cfg.menu === undefined) return;

  if (cfg.menu === false) {
    if (process.platform === 'darwin') {
      // macOS requires at least the App menu for Cmd+Q to work
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: app.name, submenu: [{ role: 'quit' }] },
      ]));
    } else {
      Menu.setApplicationMenu(null);
    }
    return;
  }

  const { editMenu = true, viewMenu } = cfg.menu;
  const showView = isDev || viewMenu === true;

  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  if (editMenu) template.push({ role: 'editMenu' });
  if (showView) template.push({ role: 'viewMenu' });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Tray context menu items — edit freely, never overwritten by cap-electron sync.
//
// Four variants available:
//   { label: 'Open', action: 'show' }              → shows and focuses the main window
//   { label: 'Quit', action: 'quit' }              → quits the application
//   { action: 'separator' }                        → visual divider line
//   { label: 'Custom', handler: () => { ... } }    → arbitrary main-process code
//
// Only used when tray.enabled is true in capacitor.config.ts.

import type { TrayMenuItemDef } from '../system/static/tray-main';

export const trayMenu: TrayMenuItemDef[] = [
  { label: 'Open', action: 'show' },
  { action: 'separator' },
  { label: 'Quit', action: 'quit' },
];

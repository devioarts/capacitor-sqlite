// Custom main-process setup — edit freely, never overwritten by cap-electron upgrade.
// Called inside app.whenReady(), after the main window is created.
// Use this to register custom IPC handlers or run any additional setup.

import type { BrowserWindow } from 'electron';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function onReady(_getWin: () => BrowserWindow | null): void {
  // your code here
}

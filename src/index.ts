import { registerPlugin } from '@capacitor/core';

import type { CapacitorSqlitePlugin } from './definitions';

const CapacitorSqlite = registerPlugin<CapacitorSqlitePlugin>('CapacitorSqlite', {
  web: () => import('./web.js').then((m) => new m.CapacitorSqliteWeb()),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  electron: () =>
    Promise.resolve((window as any).CapacitorCustomPlatform.plugins.CapacitorSqlite as CapacitorSqlitePlugin),
});

export * from './definitions.js';
export { CapacitorSqlite };

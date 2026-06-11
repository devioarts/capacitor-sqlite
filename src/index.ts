import { registerPlugin } from '@capacitor/core';

import type { CapacitorSqlitePlugin } from './definitions';

const CapacitorSqlite = registerPlugin<CapacitorSqlitePlugin>('CapacitorSqlite', {
  web: () => import('./web').then((m) => new m.CapacitorSqliteWeb()),
});

export * from './definitions';
export { CapacitorSqlite };

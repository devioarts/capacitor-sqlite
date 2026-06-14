// Auto-generated — do not edit.
// Regenerate with: cap-electron sync

import { app } from 'electron';
import { registerPlugin, AnyRecord } from '../static/functions';
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite/electron';

void (async () => {
  await app.whenReady();
  registerPlugin('CapacitorSqlite', new CapacitorSqlite() as unknown as AnyRecord, ['getPlatform', 'isAvailable', 'open', 'close', 'isOpen', 'getVersion', 'getSchemaVersion', 'vacuum', 'execute', 'run', 'runBatch', 'query', 'beginTransaction', 'commitTransaction', 'rollbackTransaction']);
})();

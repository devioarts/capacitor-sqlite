export const pluginSettings = {
  pluginClass: 'CapacitorSqlite',
  pluginMethods: [
    'getPlatform',
    'isAvailable',
    'open',
    'close',
    'isOpen',
    'getVersion',
    'getSchemaVersion',
    'vacuum',
    'execute',
    'run',
    'runBatch',
    'query',
    'beginTransaction',
    'commitTransaction',
    'rollbackTransaction',
  ] as const,
  pluginEvents: [] as const,
  autoRegister: true,
  imports: ["import { CapacitorSqlite } from '@devioarts/capacitor-sqlite/electron'"] as const,
  beforeRegister: ['await app.whenReady()', 'const capacitorSqlite = new CapacitorSqlite()'] as const,
} as const;

export type PluginSettings = typeof pluginSettings;

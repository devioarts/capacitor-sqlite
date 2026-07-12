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
    'runMany',
    'query',
    'beginTransaction',
    'commitTransaction',
    'rollbackTransaction',
  ] as const,
  pluginEvents: [] as const,
  // optional, default is true
  // autoRegister: true,

  // add only if the plugin reads plugins.TCPClient from capacitor.config
  // configSections: ['TCPClient'],
} as const;

export type PluginSettings = typeof pluginSettings;

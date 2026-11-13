export declare const pluginSettings: {
  readonly pluginClass: 'CapacitorSqlite';
  readonly pluginMethods: readonly [
    'getPluginPlatform',
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
  ];
  readonly pluginEvents: readonly [];
};
export type PluginSettings = typeof pluginSettings;

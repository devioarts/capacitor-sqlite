// Manual plugin registrations — edit freely, never overwritten by cap-electron sync.
// Add entries here to register plugins that are not auto-detected,
// or to override auto-detected entries.

export const pluginsUser = {
  // Example:
  // MyPlugin: {
  //   methods: ['doSomething', 'getValue'],
  //   events: ['onUpdate'],
  // },
} as const;

export type PluginUserRegistry = typeof pluginsUser;

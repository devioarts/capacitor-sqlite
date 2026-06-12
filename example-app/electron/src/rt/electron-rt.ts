// Electron preload runtime — sets up CapacitorCustomPlatform automatically.
// Import once from preload.ts: import './rt/electron-rt';
// Regenerate electron-plugins.ts with: npm run update

import { contextBridge, ipcRenderer } from 'electron';

import { plugins } from './electron-plugins';

type AnyFn = (...args: unknown[]) => unknown;
type PluginEntry = { methods: readonly string[]; events?: readonly string[] };

const bridged: Record<string, Record<string, AnyFn>> = {};

for (const [className, entry] of Object.entries(plugins) as [string, PluginEntry][]) {
  const bridge: Record<string, AnyFn> = {};

  for (const method of entry.methods) {
    bridge[method] = (opts?: unknown) => ipcRenderer.invoke(`${className}-${method}`, opts);
  }

  if (entry.events?.length) {
    const listeners: Record<string, { type: string; handler: AnyFn }> = {};

    const hasType = (type: string) => Object.values(listeners).some((l) => l.type === type);

    bridge['addListener'] = (type: unknown, callback: unknown) => {
      const id = Math.random().toString(36).slice(2);
      if (!hasType(type as string)) ipcRenderer.send(`event-add-${className}`, type);
      const handler = (_: unknown, ...args: unknown[]) => (callback as AnyFn)(...args);
      ipcRenderer.on(`event-${className}-${type}`, handler as Parameters<typeof ipcRenderer.on>[1]);
      listeners[id] = { type: type as string, handler };
      return id;
    };

    bridge['removeListener'] = (id: unknown) => {
      const entry = listeners[id as string];
      if (!entry) return;
      ipcRenderer.removeListener(`event-${className}-${entry.type}`, entry.handler as Parameters<typeof ipcRenderer.removeListener>[1]);
      delete listeners[id as string];
      if (!hasType(entry.type)) ipcRenderer.send(`event-remove-${className}-${entry.type}`);
    };

    bridge['removeAllListeners'] = (type?: unknown) => {
      for (const [id, l] of Object.entries(listeners)) {
        if (!type || l.type === type) {
          ipcRenderer.removeListener(`event-${className}-${l.type}`, l.handler as Parameters<typeof ipcRenderer.removeListener>[1]);
          ipcRenderer.send(`event-remove-${className}-${l.type}`);
          delete listeners[id];
        }
      }
    };
  }

  bridged[className] = bridge;
}

contextBridge.exposeInMainWorld('CapacitorCustomPlatform', {
  name: 'electron',
  getPlatform: () => 'electron',
  isNativePlatform: true,
  plugins: bridged,
});

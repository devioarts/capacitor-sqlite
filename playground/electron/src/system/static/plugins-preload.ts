// Sets up CapacitorCustomPlatform in the renderer via contextBridge.
// Import once from preload.ts: import './src/system/static/plugins-preload';
// Regenerate plugins-preload-auto.ts with: cap-electron sync

import { contextBridge, ipcRenderer } from 'electron';

import { pluginsAuto } from '../generated/plugins-preload-auto';
import { pluginsUser } from '../../user/plugins-preload-user';

type AnyFn = (...args: unknown[]) => unknown;
type PluginEntry = { methods: readonly string[]; events?: readonly string[] };

// Built-in system plugins — always available regardless of installed npm packages.
// pluginsAuto (cap-electron sync) and pluginsUser can override these.
const pluginsSystem: Record<string, PluginEntry> = {
  // @capacitor/local-notifications
  LocalNotifications: {
    methods: [
      'schedule', 'cancel', 'getPending',
      'getDeliveredNotifications', 'removeDeliveredNotifications', 'removeAllDeliveredNotifications',
      'registerActionTypes',
      'checkPermissions', 'requestPermissions',
      'checkExactNotificationSetting', 'changeExactNotificationSetting',
      'areEnabled',
      'createChannel', 'deleteChannel', 'listChannels',
    ],
    events: ['localNotificationReceived', 'localNotificationActionPerformed'],
  },
  // @capacitor/action-sheet
  ActionSheet: {
    methods: ['showActions'],
  },
  // @capacitor/dialog
  Dialog: {
    methods: ['alert', 'confirm', 'prompt'],
  },
  // @capacitor/app
  App: {
    methods: ['getInfo', 'getState', 'exitApp', 'minimizeApp', 'getLaunchUrl'],
    events: ['appStateChange', 'appUrlOpen', 'resume', 'pause', 'backButton'],
  },
  // @capacitor/browser
  Browser: {
    methods: ['open', 'close', 'getSnapshot'],
    events: ['browserFinished', 'browserPageLoaded'],
  },
  // @capacitor/app-launcher
  AppLauncher: {
    methods: ['canOpenUrl', 'openUrl'],
  },
  // @capacitor/filesystem
  Filesystem: {
    methods: [
      'readFile', 'writeFile', 'appendFile', 'deleteFile',
      'mkdir', 'rmdir', 'readdir', 'getUri', 'stat',
      'rename', 'copy', 'downloadFile',
    ],
  },
  // @capacitor/preferences
  Preferences: {
    methods: ['get', 'set', 'remove', 'clear', 'keys', 'migrate', 'removeOld'],
  },
  // @capacitor/toast
  Toast: {
    methods: ['show'],
  },
};

const plugins: Record<string, PluginEntry> = { ...pluginsSystem, ...pluginsAuto, ...pluginsUser };

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

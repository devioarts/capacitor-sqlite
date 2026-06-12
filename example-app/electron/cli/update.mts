#!/usr/bin/env node
// Run from the electron directory: npm run update
// Scans the Capacitor app root for plugins with capacitor.electron.src in package.json,
// loads their compiled plugin-settings.js, and generates:
//   src/rt/electron-plugins.ts  — preload method/event registry
//   src/rt/electron-main.ts     — main-process side-effect imports

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.join(__dirname, '..');
const capacitorRoot = path.join(electronDir, '..');
const depRequire = createRequire(path.join(capacitorRoot, 'package.json'));

interface PluginSettings {
  pluginClass: string;
  pluginMethods: readonly string[];
  pluginEvents?: readonly string[];
  autoRegister?: boolean;
  imports?: readonly string[];
  beforeRegister?: readonly string[];
}

interface PluginEntry extends PluginSettings {
  packageName: string;
}

function findPlugins(): PluginEntry[] {
  const pkgPath = path.join(capacitorRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
  const deps = {
    ...(pkg.dependencies as Record<string, string> ?? {}),
    ...(pkg.devDependencies as Record<string, string> ?? {}),
  };

  const found: PluginEntry[] = [];

  for (const name of Object.keys(deps)) {
    const depPkgPath = path.join(capacitorRoot, 'node_modules', name, 'package.json');
    if (!fs.existsSync(depPkgPath)) continue;

    const depPkg = JSON.parse(fs.readFileSync(depPkgPath, 'utf-8')) as Record<string, unknown>;
    const electronSrc = (depPkg.capacitor as Record<string, unknown> | undefined)
      ?.electron as Record<string, unknown> | undefined;

    if (!electronSrc?.src) continue;

    const settingsPath = path.join(capacitorRoot, 'node_modules', name, electronSrc.src as string, 'dist', 'plugin-settings.js');
    if (!fs.existsSync(settingsPath)) continue;

    let settings: PluginSettings;
    try {
      ({ pluginSettings: settings } = depRequire(settingsPath) as { pluginSettings: PluginSettings });
    } catch {
      console.warn(`  ⚠  ${name}: failed to load plugin-settings.js, skipping`);
      continue;
    }

    if (!settings.pluginClass || !settings.pluginMethods?.length) continue;

    found.push({ packageName: name, ...settings });
  }

  return found;
}

function generateElectronPlugins(plugins: PluginEntry[]): string {
  const lines = [
    '// Auto-generated — do not edit.',
    '// Regenerate with: npm run update',
    '',
    'export const plugins = {',
  ];

  for (const { pluginClass, pluginMethods, pluginEvents } of plugins) {
    lines.push(`  ${pluginClass}: {`);
    lines.push(`    methods: [${pluginMethods.map((m) => `'${m}'`).join(', ')}],`);
    if (pluginEvents?.length) {
      lines.push(`    events: [${pluginEvents.map((e) => `'${e}'`).join(', ')}],`);
    }
    lines.push(`  },`);
  }

  if (plugins.length === 0) lines.push('  // no Capacitor Electron plugins found');

  lines.push('} as const;', '', 'export type PluginRegistry = typeof plugins;');

  return lines.join('\n') + '\n';
}

const REGISTER_PLUGIN_HELPER = `\
type AnyRecord = Record<string, unknown>;

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function registerPlugin(pluginClass: string, instance: AnyRecord, methods: readonly string[]): void {
  for (const method of methods) {
    ipcMain.handle(\`\${pluginClass}-\${method}\`, async (_event, opts: unknown) => {
      if (!isPlainObject(opts) && opts !== undefined) {
        return { success: false, error: { code: 'INVALID_PARAMS', message: 'Options must be a plain object', platform: 'electron', method, details: {} } };
      }
      try {
        return await (instance[method] as (opts: AnyRecord) => Promise<unknown>)((opts ?? {}) as AnyRecord);
      } catch (err) {
        return { success: false, error: { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err), platform: 'electron', method, details: {} } };
      }
    });
  }
}`;

function generateElectronMain(plugins: PluginEntry[]): string {
  const parts: string[] = [
    '// Auto-generated — do not edit.',
    '// Regenerate with: npm run update',
    '',
    "import { app, ipcMain } from 'electron';",
  ];

  const autoPlugins = plugins.filter((p) => p.autoRegister !== false);

  if (autoPlugins.length === 0) {
    parts.push('', '// no Capacitor Electron plugins found');
    return parts.join('\n') + '\n';
  }

  // Plugin-specific imports from settings (deduplicated)
  const extraImports = new Set<string>();
  for (const { imports } of autoPlugins) {
    for (const imp of imports ?? []) extraImports.add(imp);
  }
  for (const imp of extraImports) parts.push(`${imp};`);

  parts.push('', REGISTER_PLUGIN_HELPER, '');

  // Collect beforeRegister lines across all plugins
  const beforeRegisterLines: string[] = [];
  for (const { beforeRegister } of autoPlugins) {
    for (const line of beforeRegister ?? []) beforeRegisterLines.push(line);
  }

  const needsAsync = beforeRegisterLines.some((l) => l.includes('await'));
  const i = needsAsync ? '  ' : '';

  if (needsAsync) parts.push('void (async () => {');

  for (const line of beforeRegisterLines) parts.push(`${i}${line};`);

  for (const { pluginClass, pluginMethods } of autoPlugins) {
    const varName = pluginClass.charAt(0).toLowerCase() + pluginClass.slice(1);
    const methods = pluginMethods.map((m) => `'${m}'`).join(', ');
    parts.push(`${i}registerPlugin('${pluginClass}', ${varName} as unknown as AnyRecord, [${methods}]);`);
  }

  if (needsAsync) parts.push('})();');

  return parts.join('\n') + '\n';
}

function main(): void {
  const rtDir = path.join(electronDir, 'src', 'rt');
  fs.mkdirSync(rtDir, { recursive: true });

  console.log('Scanning for Capacitor Electron plugins...\n');
  const plugins = findPlugins();

  if (plugins.length === 0) {
    console.log('  No plugins found (looking for capacitor.electron.src + plugin-settings.js).');
  } else {
    for (const { packageName, pluginClass, pluginEvents } of plugins) {
      const eventsNote = pluginEvents?.length ? `  [${pluginEvents.length} event(s)]` : '';
      console.log(`  ✓  ${packageName}  →  ${pluginClass}${eventsNote}`);
    }
  }

  const pluginsFile = path.join(rtDir, 'electron-plugins.ts');
  fs.writeFileSync(pluginsFile, generateElectronPlugins(plugins));
  console.log(`\nWritten: src/rt/electron-plugins.ts`);

  const mainFile = path.join(rtDir, 'electron-main.ts');
  fs.writeFileSync(mainFile, generateElectronMain(plugins));
  console.log(`Written: src/rt/electron-main.ts`);
}

main();

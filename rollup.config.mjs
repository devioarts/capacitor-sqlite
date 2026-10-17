import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sqliteDist = path.join(path.dirname(require.resolve('@sqlite.org/sqlite-wasm/package.json')), 'dist');

export default [
  {
    input: 'dist/esm/index.js',
    output: [
      {
        file: 'dist/plugin.js',
        format: 'iife',
        name: 'capacitorSqlite',
        globals: {
          '@capacitor/core': 'capacitorExports',
          '@sqlite.org/sqlite-wasm': 'sqliteWasm',
        },
        sourcemap: true,
        inlineDynamicImports: true,
      },
      {
        file: 'dist/plugin.cjs.js',
        format: 'cjs',
        sourcemap: true,
        inlineDynamicImports: true,
      },
    ],
    external: ['@capacitor/core', '@sqlite.org/sqlite-wasm'],
  },
  {
    input: 'dist/esm/web-worker.js',
    output: { dir: 'dist', entryFileNames: 'web-worker.js', format: 'esm' },
    plugins: [
      {
        name: 'sqlite-worker-assets',
        resolveId(source) {
          if (source === '@sqlite.org/sqlite-wasm') return path.join(sqliteDist, 'index.mjs');
        },
        buildStart() {
          for (const fileName of ['sqlite3.wasm', 'sqlite3-opfs-async-proxy.js']) {
            this.emitFile({ type: 'asset', fileName, source: readFileSync(path.join(sqliteDist, fileName)) });
          }
        },
      },
    ],
  },
];

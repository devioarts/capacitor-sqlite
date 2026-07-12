// dist/esm/*.js is emitted by `tsc` using ES module syntax (import/export), but the root
// package.json has no top-level "type" field. Without a nested package.json here, Node's
// own ESM loader falls back to CommonJS rules for these .js files (per-directory nearest
// package.json), which fails to parse on Node versions that lack the "detect module
// syntax" fallback (pre-22.7). Bundlers (Vite/Webpack/Rollup) ignore this and are
// unaffected either way — this only matters for raw `node --experimental-*`/ESM imports.
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'dist', 'esm', 'package.json');
fs.writeFileSync(target, JSON.stringify({ type: 'module' }, null, 2) + '\n');

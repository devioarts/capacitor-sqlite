// ESLint 9+ only reads flat config (eslint.config.js) — the legacy `eslintConfig` field
// in package.json and .eslintignore are no longer read at all. @ionic/eslint-config is
// still published in the old shareable-config shape (extends/plugins/rules), so it's
// bridged through FlatCompat rather than rewritten by hand; the underlying rule
// packages (@typescript-eslint, eslint-plugin-import) are new enough to run under
// ESLint 10 even though the config shape predates flat config.
const path = require('path');
const { FlatCompat } = require('@eslint/eslintrc');
const js = require('@eslint/js');

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  // eslint-plugin-import (a dependency of @ionic/eslint-config, not of this project) has
  // a peer range that predates ESLint 10, so npm nests it under
  // @ionic/eslint-config/node_modules instead of hoisting it to this project's root.
  // Resolve plugins from there instead of baseDirectory, or FlatCompat looks in the
  // wrong node_modules and fails with "couldn't find the plugin eslint-plugin-import".
  resolvePluginsRelativeTo: path.dirname(require.resolve('@ionic/eslint-config/package.json')),
});

// The old `eslint . --ext ts` CLI flag only linted .ts files; --ext has no flat-config
// equivalent; instead, the file scope is pinned here on every config entry so `eslint .`
// (now file-extension-agnostic by default) doesn't sweep up .mjs/.cjs build and test
// runner scripts that were never linted before.
const TS_FILES = ['**/*.ts'];

module.exports = [
  {
    // Formerly .eslintignore — ESLint 9+ ignores that file entirely. `.build/` is Swift
    // Package Manager's artifact cache; it vendors third-party JS (e.g. Capacitor's own
    // native-bridge.js) that was never meant to be linted as part of this project.
    ignores: ['**/build/**', '**/dist/**', '**/.build/**', 'playground/**'],
  },
  // `compat.extends(name)` (not `compat.config(require(name))`) is required here — it
  // resolves the config's own internal relative `extends` (e.g. `./index` inside
  // @ionic/eslint-config/recommended.js) relative to that package's own directory,
  // rather than relative to this project's baseDirectory.
  ...compat.extends('@ionic/eslint-config/recommended').map((config) => ({ ...config, files: TS_FILES })),
  {
    files: TS_FILES,
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json', './electron/tsconfig.json', './test/suite/tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },
  },
];

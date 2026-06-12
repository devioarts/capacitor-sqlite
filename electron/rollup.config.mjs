const external = ['electron', 'node:sqlite', 'fs', 'path'];

// tsc --project electron/tsconfig.json uses rootDir: ".." (project root),
// so output mirrors the full tree under electron/build/:
//   electron/src/index.ts  → electron/build/electron/src/index.js
export default [
  {
    input: 'electron/build/electron/src/index.js',
    output: [
      {
        file: 'electron/dist/plugin.cjs.js',
        format: 'cjs',
        sourcemap: true,
        inlineDynamicImports: true,
      },
    ],
    external,
  },
  {
    input: 'electron/build/electron/src/plugin-settings.js',
    output: [
      {
        file: 'electron/dist/plugin-settings.js',
        format: 'cjs',
        sourcemap: true,
      },
    ],
    external,
  },
];

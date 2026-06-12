// Minimal type stubs for electron APIs used by the plugin adapter.
// Consumer Electron apps have the real electron package installed.
declare module 'electron' {
  export const app: {
    getPath(name: string): string;
  };
}

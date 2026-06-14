import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Cross-origin isolation headers are required by sqlite-wasm (OPFS backend on web).
// iOS/Android ignore these; they only affect browser preview.
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig(({ command }) => ({
  // './' is required for Capacitor native webview (assets must use relative paths).
  // Dev server needs '/' — otherwise Vite 6+ serves scripts at a relative base
  // and the browser renders raw HTML instead of executing the app.
  base: command === 'serve' ? '/' : './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    strictPort: true,
    headers: coiHeaders,
    fs: {
      // sqlite-wasm is resolved from the plugin's node_modules (one level up),
      // which is outside Vite's default serve root.
      allow: ['..'],
    },
  },
  preview: {
    headers: coiHeaders,
  },
}));

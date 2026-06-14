const fs = require('fs');
const path = require('path');

let appId = 'com.example.app';
let appName = 'App';

try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'capacitor.config.json'), 'utf-8'));
  if (cfg.appId)   appId   = cfg.appId;
  if (cfg.appName) appName = cfg.appName;
} catch {
  console.warn('[electron-builder] capacitor.config.json not found — using defaults. Run: cap-electron sync');
}

const icon = (file) => fs.existsSync(path.join(__dirname, 'assets', file))
  ? path.join('assets', file)
  : undefined;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId,
  productName: appName,
  directories: {
    output: 'dist-electron',
    buildResources: 'assets',
  },
  files: [
    'dist/**',
    '!dist/**/*.map',
    'capacitor.config.json',
  ],
  extraResources: [
    { from: '../dist', to: 'app', filter: ['**/*'] },
  ],
  mac: {
    category: 'public.app-category.utilities',
    icon: icon('icon.icns'),
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
  },
  win: {
    icon: icon('icon.ico'),
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
  },
  linux: {
    icon: icon('icon.png'),
    target: [{ target: 'AppImage', arch: ['x64'] }],
    category: 'Utility',
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
};

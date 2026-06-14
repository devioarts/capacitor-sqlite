import { app, BrowserWindow, screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { ElectronConfig } from './types';

interface SavedState {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

function statePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readState(): SavedState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf-8')) as SavedState;
  } catch {
    return null;
  }
}

function writeState(state: SavedState): void {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state), 'utf-8');
  } catch {
    // non-fatal — userData may not always be writable
  }
}

function isOnAnyScreen(x: number, y: number): boolean {
  return screen.getAllDisplays().some(({ bounds: b }) =>
    x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height
  );
}

/**
 * Load saved window bounds. Call before new BrowserWindow().
 * Returns config defaults when persistWindowState is disabled or no state is saved.
 */
export function loadWindowState(cfg: ElectronConfig): WindowBounds {
  const defaults: WindowBounds = {
    width: cfg.width ?? 1200,
    height: cfg.height ?? 800,
    isMaximized: false,
  };

  if (!cfg.persistWindowState) return defaults;

  const saved = readState();
  if (!saved) return defaults;

  let x: number | undefined = saved.x;
  let y: number | undefined = saved.y;
  // Drop saved position if it's off all current screens (monitor unplugged etc.)
  if (x != null && y != null && !isOnAnyScreen(x, y)) { x = undefined; y = undefined; }

  return {
    x,
    y,
    width:      saved.width      ?? defaults.width,
    height:     saved.height     ?? defaults.height,
    isMaximized: saved.isMaximized ?? false,
  };
}

/**
 * Attach resize/move/close listeners that debounce-persist window state.
 * Call after new BrowserWindow() when persistWindowState is enabled.
 */
export function trackWindowState(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function save(): void {
    if (win.isDestroyed()) return;
    const isMaximized = win.isMaximized();
    // getNormalBounds() returns pre-maximize dimensions — avoids saving screen-sized bounds
    const { x, y, width, height } = isMaximized ? win.getNormalBounds() : win.getBounds();
    writeState({ x, y, width, height, isMaximized });
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  }

  win.on('resize', schedule);
  win.on('move',   schedule);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    save();
  });
}

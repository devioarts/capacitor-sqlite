// Electron implementation of @capacitor/filesystem
import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { registerPlugin, type AnyRecord } from './functions';

// ── Directory mapping ─────────────────────────────────────────────────────────

const DIR_MAP: Record<string, Parameters<typeof app.getPath>[0]> = {
  DOCUMENTS:        'documents',
  DATA:             'userData',
  LIBRARY:          'userData',
  CACHE:            'temp',
  EXTERNAL:         'downloads',
  EXTERNAL_STORAGE: 'downloads',
};

function resolvePath(filePath: string, directory?: string): string {
  if (!directory) return filePath;
  const base = app.getPath(DIR_MAP[directory] ?? 'userData');
  return path.join(base, filePath);
}

// ── Encoding helpers ──────────────────────────────────────────────────────────

const ENCODINGS: Record<string, BufferEncoding> = {
  'utf8':   'utf-8',
  'utf-8':  'utf-8',
  'ascii':  'ascii',
  'utf16':  'utf16le',
  'utf-16': 'utf16le',
};

function bufEnc(encoding?: string): BufferEncoding | undefined {
  if (!encoding) return undefined;
  return ENCODINGS[encoding.toLowerCase()] ?? (encoding as BufferEncoding);
}

// ── Error mapping ─────────────────────────────────────────────────────────────

const ERR_MAP: Record<string, string> = {
  ENOENT:    'File does not exist',
  EEXIST:    'Directory exists',
  ENOTDIR:   'Not a directory',
  EISDIR:    'Is a directory',
  EACCES:    'Permission denied',
  ENOTEMPTY: 'Directory not empty',
};

function mapError(err: unknown, op: string): never {
  const e = err as NodeJS.ErrnoException;
  throw new Error(ERR_MAP[e.code ?? ''] ?? `${op}: ${e.message}`);
}

function toUri(abs: string): string {
  return `file://${abs.split(path.sep).join('/')}`;
}

// ── Plugin class ──────────────────────────────────────────────────────────────

/**
 * Electron implementation of the Capacitor Filesystem plugin.
 *
 * Uses Node.js `fs/promises` for all I/O. No extra dependencies.
 * `downloadFile` uses global `fetch` (Node 18+ / Electron 20+).
 *
 * Directory enum mapping:
 *   DOCUMENTS        → app.getPath('documents')
 *   DATA / LIBRARY   → app.getPath('userData')
 *   CACHE            → app.getPath('temp')
 *   EXTERNAL / EXTERNAL_STORAGE → app.getPath('downloads')
 *   (no directory)   → path treated as absolute
 */
class Filesystem {

  async readFile(opts: AnyRecord): Promise<{ data: string }> {
    const abs = resolvePath(opts['path'] as string, opts['directory'] as string | undefined);
    const enc = bufEnc(opts['encoding'] as string | undefined);
    try {
      if (enc) {
        return { data: await fs.readFile(abs, enc) };
      }
      return { data: (await fs.readFile(abs)).toString('base64') };
    } catch (e) { return mapError(e, 'readFile'); }
  }

  async writeFile(opts: AnyRecord): Promise<{ uri: string }> {
    const abs       = resolvePath(opts['path'] as string, opts['directory'] as string | undefined);
    const enc       = bufEnc(opts['encoding'] as string | undefined);
    const data      = opts['data'] as string;
    const recursive = opts['recursive'] as boolean | undefined;
    try {
      if (recursive) await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, enc ? data : Buffer.from(data, 'base64'), enc ? { encoding: enc } : undefined);
      return { uri: toUri(abs) };
    } catch (e) { return mapError(e, 'writeFile'); }
  }

  async appendFile(opts: AnyRecord): Promise<void> {
    const abs  = resolvePath(opts['path'] as string, opts['directory'] as string | undefined);
    const enc  = bufEnc(opts['encoding'] as string | undefined);
    const data = opts['data'] as string;
    try {
      await fs.appendFile(abs, enc ? data : Buffer.from(data, 'base64'), enc ? { encoding: enc } : undefined);
    } catch (e) { return mapError(e, 'appendFile'); }
  }

  async deleteFile(opts: AnyRecord): Promise<void> {
    const abs = resolvePath(opts['path'] as string, opts['directory'] as string | undefined);
    try { await fs.unlink(abs); } catch (e) { return mapError(e, 'deleteFile'); }
  }

  async mkdir(opts: AnyRecord): Promise<void> {
    const abs = resolvePath(opts['path'] as string, opts['directory'] as string | undefined);
    try {
      await fs.mkdir(abs, { recursive: (opts['recursive'] as boolean | undefined) ?? false });
    } catch (e) { return mapError(e, 'mkdir'); }
  }

  async rmdir(opts: AnyRecord): Promise<void> {
    const abs = resolvePath(opts['path'] as string, opts['directory'] as string | undefined);
    try {
      await fs.rm(abs, { recursive: (opts['recursive'] as boolean | undefined) ?? false, force: false });
    } catch (e) { return mapError(e, 'rmdir'); }
  }

  async readdir(opts: AnyRecord): Promise<{ files: object[] }> {
    const abs = resolvePath(opts['path'] as string, opts['directory'] as string | undefined);
    try {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const files = await Promise.all(entries.map(async e => {
        const ep = path.join(abs, e.name);
        const st = await fs.stat(ep);
        return { name: e.name, type: e.isDirectory() ? 'directory' : 'file', size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs, uri: toUri(ep) };
      }));
      return { files };
    } catch (e) { return mapError(e, 'readdir'); }
  }

  async getUri(opts: AnyRecord): Promise<{ uri: string }> {
    return { uri: toUri(resolvePath(opts['path'] as string, opts['directory'] as string | undefined)) };
  }

  async stat(opts: AnyRecord): Promise<{ type: string; size: number; mtime: number; ctime: number; uri: string }> {
    const abs = resolvePath(opts['path'] as string, opts['directory'] as string | undefined);
    try {
      const st = await fs.stat(abs);
      return { type: st.isDirectory() ? 'directory' : 'file', size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs, uri: toUri(abs) };
    } catch (e) { return mapError(e, 'stat'); }
  }

  async rename(opts: AnyRecord): Promise<void> {
    const from = resolvePath(opts['from'] as string, opts['fromDirectory'] as string | undefined);
    const to   = resolvePath(opts['to']   as string, opts['toDirectory']   as string | undefined);
    try { await fs.rename(from, to); } catch (e) { return mapError(e, 'rename'); }
  }

  async copy(opts: AnyRecord): Promise<{ uri: string }> {
    const from = resolvePath(opts['from'] as string, opts['fromDirectory'] as string | undefined);
    const to   = resolvePath(opts['to']   as string, opts['toDirectory']   as string | undefined);
    try {
      await fs.copyFile(from, to);
      return { uri: toUri(to) };
    } catch (e) { return mapError(e, 'copy'); }
  }

  async downloadFile(opts: AnyRecord): Promise<{ path: string }> {
    const url     = opts['url']  as string;
    const dest    = resolvePath(opts['path'] as string, opts['directory'] as string | undefined);
    const headers = (opts['headers'] as Record<string, string> | undefined) ?? {};
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, buf);
      return { path: dest };
    } catch (e) { return mapError(e, 'downloadFile'); }
  }
}

const METHODS = [
  'readFile', 'writeFile', 'appendFile', 'deleteFile',
  'mkdir', 'rmdir', 'readdir', 'getUri', 'stat',
  'rename', 'copy', 'downloadFile',
] as const;

registerPlugin('Filesystem', new Filesystem() as unknown as AnyRecord, METHODS);

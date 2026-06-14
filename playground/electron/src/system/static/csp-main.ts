import { session } from 'electron';
import type { ElectronConfig } from './types';

const DEV_CSP = [
  "default-src 'self' 'unsafe-inline' http://localhost:* ws://localhost:*",
  "script-src 'self' 'unsafe-eval' 'unsafe-inline' http://localhost:*",
].join('; ');

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
].join('; ');

function buildCsp(directives: Record<string, string | string[]>): string {
  return Object.entries(directives)
    .map(([key, val]) => `${key} ${Array.isArray(val) ? val.join(' ') : val}`)
    .join('; ');
}

/**
 * Set up CSP via session.defaultSession.webRequest.onHeadersReceived.
 * Must be called inside app.whenReady(), before createWindow().
 */
export function setupCSP(cfg: ElectronConfig, isDev: boolean): void {
  if (cfg.csp === false) return;

  let headerValue: string;
  if (typeof cfg.csp === 'string') {
    headerValue = cfg.csp;
  } else if (cfg.csp && typeof cfg.csp === 'object') {
    headerValue = buildCsp(cfg.csp);
  } else {
    headerValue = isDev ? DEV_CSP : PROD_CSP;
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [headerValue],
      },
    });
  });
}

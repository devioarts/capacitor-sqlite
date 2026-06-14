// Electron implementation of @capacitor/toast
import { Notification } from 'electron';
import { registerPlugin, type AnyRecord } from './functions';

/**
 * Electron implementation of the Capacitor Toast plugin.
 *
 * Uses the Electron Notification API (fire-and-forget, silent).
 *
 * Limitations:
 * - `position` ('top' | 'center' | 'bottom') is ignored — the OS controls notification placement.
 * - On macOS (unsigned builds) Notification may fail silently — wrapped in try/catch.
 * - On headless / kiosk environments where `Notification.isSupported()` is false, `show()` is a no-op.
 */
class Toast {
  async show(opts: AnyRecord): Promise<void> {
    if (!Notification.isSupported()) return;
    const text     = opts['text']     as string;
    const duration = opts['duration'] as string | undefined;
    const ms       = duration === 'long' ? 3500 : 2000;
    try {
      const notif = new Notification({ title: '', body: text, silent: true, timeoutType: 'default' });
      notif.show();
      setTimeout(() => { try { notif.close(); } catch { /* already dismissed by OS */ } }, ms);
    } catch { /* unsigned macOS or platform without notification support */ }
  }
}

registerPlugin('Toast', new Toast() as unknown as AnyRecord, ['show']);

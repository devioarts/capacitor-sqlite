// Electron implementation of @capacitor/action-sheet
import { dialog, BrowserWindow } from 'electron';
import { registerPlugin, type AnyRecord } from './functions';

/**
 * Electron implementation of the Capacitor ActionSheet plugin.
 *
 * Uses `dialog.showMessageBox` — a native OS dialog with a button per option.
 *
 * Limitations:
 * - DESTRUCTIVE style is indicated with a "⚠ " prefix (Electron dialogs have no red buttons).
 * - Pressing Escape closes the dialog and returns the cancelId index (if any CANCEL option exists).
 */
class ActionSheet {
  async showActions(opts: AnyRecord): Promise<{ index: number }> {
    const title   = (opts['title']   as string | undefined) ?? '';
    const message = (opts['message'] as string | undefined) ?? '';
    const options = (opts['options'] as Array<{ title: string; style?: string }> | undefined) ?? [];

    const buttons  = options.map(o => (o.style === 'DESTRUCTIVE' ? `⚠ ${o.title}` : o.title));
    const cancelId = options.findIndex(o => o.style === 'CANCEL');

    const win  = BrowserWindow.getAllWindows()[0] ?? null;
    const base = {
      type:     'question' as const,
      title,
      message,
      buttons,
      cancelId: cancelId >= 0 ? cancelId : undefined,
    };

    const { response } = win
      ? await dialog.showMessageBox(win, base)
      : await dialog.showMessageBox(base);

    return { index: response };
  }
}

registerPlugin('ActionSheet', new ActionSheet() as unknown as AnyRecord, ['showActions']);

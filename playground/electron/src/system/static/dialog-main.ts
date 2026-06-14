// Electron implementation of @capacitor/dialog
import { dialog, BrowserWindow } from 'electron';
import { registerPlugin, type AnyRecord } from './functions';

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null;
}

/**
 * Electron implementation of the Capacitor Dialog plugin.
 *
 * `alert` and `confirm` use `dialog.showMessageBox` — native OS dialogs.
 * `prompt` is not supported on Electron (no native input dialog API) and
 * always returns `{ value: '', cancelled: true }`.
 */
class Dialog {
  async alert(opts: AnyRecord): Promise<void> {
    const title       = (opts['title']       as string | undefined) ?? '';
    const message     = (opts['message']     as string | undefined) ?? '';
    const buttonTitle = (opts['buttonTitle'] as string | undefined) ?? 'OK';

    const win  = mainWindow();
    const base = { type: 'info' as const, title, message, buttons: [buttonTitle] };
    win ? await dialog.showMessageBox(win, base) : await dialog.showMessageBox(base);
  }

  async confirm(opts: AnyRecord): Promise<{ value: boolean }> {
    const title            = (opts['title']            as string | undefined) ?? '';
    const message          = (opts['message']          as string | undefined) ?? '';
    const okButtonTitle    = (opts['okButtonTitle']    as string | undefined) ?? 'OK';
    const cancelButtonTitle = (opts['cancelButtonTitle'] as string | undefined) ?? 'Cancel';

    const win  = mainWindow();
    const base = {
      type:      'question' as const,
      title,
      message,
      buttons:   [okButtonTitle, cancelButtonTitle],
      defaultId: 0,
      cancelId:  1,
    };
    const { response } = win
      ? await dialog.showMessageBox(win, base)
      : await dialog.showMessageBox(base);

    return { value: response === 0 };
  }

  async prompt(): Promise<{ value: string; cancelled: boolean }> {
    // Electron has no native input dialog. Return a cancelled response rather
    // than spawning a custom BrowserWindow — callers must check `cancelled`.
    return { value: '', cancelled: true };
  }
}

registerPlugin('Dialog', new Dialog() as unknown as AnyRecord, ['alert', 'confirm', 'prompt']);

import { ipcMain } from 'electron';
import {
  binariesPresent, ensureBinaries, checkForUpdates,
  getYtDlpVersion, getFfmpegVersion,
} from './binaries';
import { sendSetup } from './window';
import type { BinarySetupEvent } from '../shared/types';

export async function bootstrapBinaries(): Promise<void> {
  if (binariesPresent()) {
    sendSetup({ phase: 'ready' });
  } else {
    sendSetup({ phase: 'first-run' });
    try {
      await ensureBinaries(sendSetup);
      sendSetup({ phase: 'ready' });
    } catch (e) {
      console.error('[main] ensureBinaries failed:', e);
      sendSetup({ phase: 'error', error: (e as Error).message });
      return;
    }
  }
  checkForUpdates((p: BinarySetupEvent) => sendSetup({ ...p, background: true }))
    .catch((e) => console.error('[main] update check failed:', e));
}

export function registerBinaryHandlers(): void {
  ipcMain.handle('get-ytdlp-version', async () => ({ version: await getYtDlpVersion() }));
  ipcMain.handle('get-ffmpeg-version', async () => ({ version: await getFfmpegVersion() }));
  ipcMain.handle('force-check-updates', async () => {
    await checkForUpdates((p: BinarySetupEvent) => sendSetup({ ...p, background: true }), { force: true });
    return true;
  });
}

import { ipcMain, dialog } from 'electron';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ytDlpPath } from './binaries';
import { clipPath, audioPath, peaksPath, chunkPath, safeUnlink } from './paths';
import { sendDownloadProgress, getMainWindow } from './window';
import { evictOldCache } from './cache';
import type { VideoInfo } from '../shared/types';

function ytDlp(): string { return ytDlpPath(); }

export function registerClipHandlers(): void {
  ipcMain.handle('get-video-info', async (_event, url: string): Promise<VideoInfo> => {
    return new Promise((resolve, reject) => {
      execFile(ytDlp(), [
        '--dump-json',
        '--no-playlist',
        '--no-warnings',
        url,
      ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(error.message);
        try {
          const info = JSON.parse(stdout);
          resolve({
            title: info.title || 'Untitled',
            duration: info.duration || 0,
            thumbnail: info.thumbnail || '',
            id: info.id || '',
          });
        } catch {
          reject('Failed to parse video info');
        }
      });
    });
  });

  ipcMain.handle('download-clip', async (_event, url: string, clipId: string): Promise<string> => {
    const outPath = clipPath(clipId);
    try { fs.accessSync(outPath); return outPath; } catch {}

    return new Promise((resolve, reject) => {
      const proc = spawn(ytDlp(), [
        '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--no-playlist',
        '--no-warnings',
        '--newline',
        '--progress',
        '-o', outPath,
        url,
      ]);

      let lastStderr = '';

      const parseProgress = (data: Buffer) => {
        const line = data.toString();
        const match = line.match(/(\d+\.?\d*)%/);
        if (match) {
          sendDownloadProgress({ clipId, progress: parseFloat(match[1]) });
        }
      };

      proc.stderr.on('data', (data: Buffer) => {
        lastStderr = data.toString();
        parseProgress(data);
      });
      proc.stdout.on('data', parseProgress);

      proc.on('close', (code) => {
        if (code === 0) { evictOldCache(); resolve(outPath); }
        else reject(lastStderr || `yt-dlp exited with code ${code}`);
      });

      proc.on('error', (err) => reject(err.message));
    });
  });

  // Local media — both pick-via-dialog and ingest-by-path flows.
  ipcMain.handle('pick-local-files', async (): Promise<string[]> => {
    const win = getMainWindow();
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
      title: 'Load Media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'opus'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return [];
    return result.filePaths;
  });

  ipcMain.handle('load-local-clip', async (_event, filePath: string, clipId: string): Promise<{ title: string }> => {
    const target = clipPath(clipId);
    await fs.promises.copyFile(filePath, target);
    return { title: path.basename(filePath, path.extname(filePath)) };
  });

  ipcMain.handle('delete-clip', async (_event, clipId: string): Promise<boolean> => {
    safeUnlink(clipPath(clipId));
    safeUnlink(audioPath(clipId));
    safeUnlink(peaksPath(clipId));
    let i = 0;
    while (true) {
      const p = chunkPath(clipId, i);
      if (!fs.existsSync(p)) break;
      safeUnlink(p);
      i++;
    }
    return true;
  });
}

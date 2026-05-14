import { ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegPath } from './binaries';
import {
  clipPath, audioPath, chunkPath, peaksPath,
  DOWNLOADS_DIR, CHUNK_DURATION, CHUNK_THRESHOLD,
} from './paths';
import type { ExtractAudioResult } from '../shared/types';

function ffmpeg(): string { return ffmpegPath(); }

function countChunks(clipId: string): number {
  let i = 0;
  while (fs.existsSync(chunkPath(clipId, i))) i++;
  return i;
}

function extractSingleAudio(clipId: string, mp4: string, audio: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg(), ['-i', mp4, '-vn', '-c:a', 'copy', '-y', audio], { timeout: 300000 });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(audio)) return resolve(true);
      const proc2 = spawn(ffmpeg(), ['-i', mp4, '-vn', '-c:a', 'aac', '-b:a', '192k', '-y', audio], { timeout: 600000 });
      proc2.on('close', (code2) => resolve(code2 === 0 && fs.existsSync(audio)));
      proc2.on('error', () => resolve(false));
    });
    proc.on('error', () => resolve(false));
  });
}

function extractChunked(clipId: string, audioFile: string): Promise<ExtractAudioResult> {
  return new Promise((resolve) => {
    const pattern = path.join(DOWNLOADS_DIR, `${clipId}_chunk_%03d.m4a`);
    const proc = spawn(ffmpeg(), [
      '-i', audioFile,
      '-f', 'segment', '-segment_time', String(CHUNK_DURATION),
      '-c:a', 'aac', '-b:a', '192k', '-y',
      pattern,
    ], { timeout: 600000 });

    proc.on('close', (code) => {
      if (code === 0) {
        const count = countChunks(clipId);
        if (count > 0) {
          computeAndSavePeaks(clipId, audioFile).then(() => {
            resolve({ ok: true, chunked: true, chunkCount: count, chunkDuration: CHUNK_DURATION });
          });
          return;
        }
      }
      resolve({ ok: false, reason: 'chunking-failed' });
    });
    proc.on('error', () => resolve({ ok: false, reason: 'ffmpeg-error' }));
  });
}

function computeAndSavePeaks(clipId: string, audioFile: string): Promise<void> {
  return new Promise((resolve) => {
    const NUM_PEAKS = 4000;
    const proc = spawn(ffmpeg(), [
      '-i', audioFile, '-ac', '1', '-ar', '8000', '-f', 'f32le', '-',
    ], { timeout: 300000 });

    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.on('close', (code) => {
      if (code !== 0) { resolve(); return; }
      const raw = Buffer.concat(chunks);
      const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      const samplesPerBucket = Math.max(1, Math.floor(samples.length / NUM_PEAKS));
      const peaks = new Float32Array(Math.min(NUM_PEAKS, samples.length));

      for (let i = 0; i < peaks.length; i++) {
        const start = i * samplesPerBucket;
        const end = Math.min(start + samplesPerBucket, samples.length);
        let max = 0;
        for (let j = start; j < end; j++) {
          const abs = Math.abs(samples[j]);
          if (abs > max) max = abs;
        }
        peaks[i] = max;
      }

      fs.writeFileSync(peaksPath(clipId), Buffer.from(peaks.buffer));
      resolve();
    });
    proc.on('error', () => resolve());
  });
}

export function registerAudioHandlers(): void {
  ipcMain.handle('extract-audio', async (_event, clipId: string): Promise<ExtractAudioResult> => {
    if (!fs.existsSync(ffmpeg())) return { ok: false, reason: 'ffmpeg-missing' };

    const mp4 = clipPath(clipId);
    try { fs.accessSync(mp4); }
    catch { return { ok: false, reason: 'mp4-missing' }; }

    if (fs.existsSync(chunkPath(clipId, 0))) {
      const count = countChunks(clipId);
      return { ok: true, chunked: true, chunkCount: count, chunkDuration: CHUNK_DURATION };
    }

    const audio = audioPath(clipId);
    if (fs.existsSync(audio)) {
      const stat = fs.statSync(audio);
      if (stat.size > CHUNK_THRESHOLD) {
        return await extractChunked(clipId, audio);
      }
      return { ok: true, chunked: false };
    }

    const extracted = await extractSingleAudio(clipId, mp4, audio);
    if (!extracted) return { ok: false, reason: 'extraction-failed' };

    const stat = fs.statSync(audio);
    if (stat.size > CHUNK_THRESHOLD) {
      return await extractChunked(clipId, audio);
    }

    return { ok: true, chunked: false };
  });

  ipcMain.handle('get-audio-buffer', async (_event, clipId: string) => {
    const p = audioPath(clipId);
    try {
      const stat = fs.statSync(p);
      if (stat.size > CHUNK_THRESHOLD) return { error: 'use-chunks', size: stat.size };
      const data = fs.readFileSync(p);
      return data.buffer;
    } catch { return null; }
  });

  ipcMain.handle('get-audio-chunk', async (_event, clipId: string, chunkIndex: number) => {
    const p = chunkPath(clipId, chunkIndex);
    try { return fs.readFileSync(p).buffer; }
    catch { return null; }
  });

  ipcMain.handle('get-audio-peaks', async (_event, clipId: string) => {
    const p = peaksPath(clipId);
    try { return fs.readFileSync(p).buffer; }
    catch { return null; }
  });
}

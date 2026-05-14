import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export const DOWNLOADS_DIR = path.join(app.getPath('userData'), 'clips');
export const MANIFEST_PATH = path.join(app.getPath('userData'), 'manifest.json');
export const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
export const RECENT_DECKS_PATH = path.join(app.getPath('userData'), 'recent-decks.json');

export const CHUNK_DURATION = 60;
export const CHUNK_THRESHOLD = 30 * 1024 * 1024;
export const DEFAULT_MAX_CACHE = 10 * 1024 * 1024 * 1024;

export function clipPath(id: string) { return path.join(DOWNLOADS_DIR, `${id}.mp4`); }
export function audioPath(id: string) { return path.join(DOWNLOADS_DIR, `${id}_audio.m4a`); }
export function chunkPath(id: string, idx: number) {
  return path.join(DOWNLOADS_DIR, `${id}_chunk_${String(idx).padStart(3, '0')}.m4a`);
}
export function peaksPath(id: string) { return path.join(DOWNLOADS_DIR, `${id}_peaks.bin`); }

export function safeUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch {}
}

export function ensureDownloadsDir(): void {
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }
}

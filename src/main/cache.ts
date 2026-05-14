import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  DOWNLOADS_DIR, SETTINGS_PATH, MANIFEST_PATH,
  DEFAULT_MAX_CACHE, safeUnlink,
} from './paths';
import type { CacheInfo } from '../shared/types';

interface CacheFile { name: string; path: string; size: number; mtime: number; }

function getMaxCacheSize(): number {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    return s.maxCacheBytes ?? DEFAULT_MAX_CACHE;
  } catch { return DEFAULT_MAX_CACHE; }
}

function setMaxCacheSize(bytes: number): void {
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')); } catch {}
  settings.maxCacheBytes = bytes;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function getCacheFiles(): CacheFile[] {
  try {
    return fs.readdirSync(DOWNLOADS_DIR)
      .map((name): CacheFile | null => {
        const full = path.join(DOWNLOADS_DIR, name);
        try {
          const stat = fs.statSync(full);
          return { name, path: full, size: stat.size, mtime: stat.mtimeMs };
        } catch { return null; }
      })
      .filter((f): f is CacheFile => f !== null);
  } catch { return []; }
}

function getCacheSize(): number {
  return getCacheFiles().reduce((sum, f) => sum + f.size, 0);
}

function getActiveSourceIds(): Set<string> {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
    const manifest = JSON.parse(raw);
    return new Set(Object.keys(manifest.sources || {}));
  } catch { return new Set(); }
}

export function evictOldCache(): void {
  const maxBytes = getMaxCacheSize();
  let totalSize = getCacheSize();
  if (totalSize <= maxBytes) return;

  const activeIds = getActiveSourceIds();
  const files = getCacheFiles().sort((a, b) => a.mtime - b.mtime);

  for (const file of files) {
    if (totalSize <= maxBytes) break;
    const match = file.name.match(/^(src_\d+_\d+)/);
    if (!match) continue;
    if (activeIds.has(match[1])) continue;
    safeUnlink(file.path);
    totalSize -= file.size;
  }
}

export function registerCacheHandlers(): void {
  ipcMain.handle('get-cache-info', async (): Promise<CacheInfo> => {
    const maxBytes = getMaxCacheSize();
    const usedBytes = getCacheSize();
    const files = getCacheFiles().length;
    return {
      maxBytes,
      usedBytes,
      files,
      maxGB: (maxBytes / (1024 ** 3)).toFixed(1),
      usedGB: (usedBytes / (1024 ** 3)).toFixed(2),
    };
  });

  ipcMain.handle('set-max-cache', async (_event, gb: number): Promise<boolean> => {
    const bytes = Math.max(1024 * 1024 * 512, gb * 1024 ** 3);
    setMaxCacheSize(bytes);
    evictOldCache();
    return true;
  });

  ipcMain.handle('clear-cache', async (): Promise<number> => {
    const activeIds = getActiveSourceIds();
    for (const file of getCacheFiles()) {
      const match = file.name.match(/^(src_\d+_\d+)/);
      if (match && activeIds.has(match[1])) continue;
      safeUnlink(file.path);
    }
    return getCacheSize();
  });
}

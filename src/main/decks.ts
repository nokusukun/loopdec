import { ipcMain, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { RECENT_DECKS_PATH } from './paths';
import { getMainWindow } from './window';
import type { DeckData, RecentDeck, SaveDeckResult, LoadDeckResult, SaveDeckOptions } from '../shared/types';

const MAX_RECENT = 8;

function getRecentDecks(): RecentDeck[] {
  try { return JSON.parse(fs.readFileSync(RECENT_DECKS_PATH, 'utf-8')); }
  catch { return []; }
}

function addRecentDeck(filePath: string): void {
  let recent = getRecentDecks().filter(r => r.path !== filePath);
  const name = path.basename(filePath, '.dec');
  recent.unshift({ path: filePath, name, time: Date.now() });
  if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
  try { fs.writeFileSync(RECENT_DECKS_PATH, JSON.stringify(recent)); } catch {}
}

// Strip characters that would make a bad filename on any common OS.
function sanitizeFilename(name: string): string {
  const clean = (name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || 'session';
}

export function registerDeckHandlers(): void {
  ipcMain.handle('save-deck', async (_event, deckData: DeckData, opts?: SaveDeckOptions): Promise<SaveDeckResult> => {
    let target = opts?.path ?? null;

    // No fixed path → ask the user where to save, defaulting to the (sanitized) deck title.
    if (!target) {
      const win = getMainWindow();
      const defaultName = `${sanitizeFilename(opts?.suggestedName ?? deckData.meta?.name ?? '')}.dec`;
      const result = await dialog.showSaveDialog(win!, {
        title: 'Save Deck',
        defaultPath: defaultName,
        filters: [{ name: 'LoopDec Deck', extensions: ['dec'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false };
      target = result.filePath;
    }

    try {
      fs.writeFileSync(target, JSON.stringify(deckData, null, 2));
      addRecentDeck(target);
      return { ok: true, path: target };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle('load-deck', async (): Promise<LoadDeckResult | null> => {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: 'Load Deck',
      filters: [{ name: 'LoopDec Deck', extensions: ['dec'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths?.length) return null;
    const filePath = result.filePaths[0];
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data: DeckData = JSON.parse(raw);
      addRecentDeck(filePath);
      return { data, path: filePath };
    } catch { return null; }
  });

  ipcMain.handle('load-deck-path', async (_event, filePath: string): Promise<DeckData | null> => {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data: DeckData = JSON.parse(raw);
      addRecentDeck(filePath);
      return data;
    } catch { return null; }
  });

  // Preserve the most-recent entry even when its file is missing — clicking it will
  // fail loudly, but the user still has a record of what they last worked on.
  ipcMain.handle('get-recent-decks', async (): Promise<RecentDeck[]> => {
    const recent = getRecentDecks();
    if (recent.length === 0) return [];
    const [head, ...rest] = recent;
    const existing = rest.filter(r => { try { fs.accessSync(r.path); return true; } catch { return false; } });
    return [head, ...existing];
  });
}

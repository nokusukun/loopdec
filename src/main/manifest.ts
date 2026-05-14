import { ipcMain } from 'electron';
import fs from 'node:fs';
import { MANIFEST_PATH, clipPath } from './paths';
import type { Manifest } from '../shared/types';

export function registerManifestHandlers(): void {
  ipcMain.handle('save-manifest', async (_event, data: Manifest): Promise<boolean> => {
    try { fs.writeFileSync(MANIFEST_PATH, JSON.stringify(data, null, 2)); return true; }
    catch { return false; }
  });

  ipcMain.handle('load-manifest', async (): Promise<Manifest | null> => {
    try {
      const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
      const manifest: Manifest = JSON.parse(raw);
      if (manifest.sources) {
        for (const id of Object.keys(manifest.sources)) {
          try { fs.accessSync(clipPath(id)); }
          catch {
            delete manifest.sources[id];
            manifest.tiles = (manifest.tiles || []).filter(t => t.sourceId !== id);
          }
        }
      }
      return manifest;
    } catch { return null; }
  });
}

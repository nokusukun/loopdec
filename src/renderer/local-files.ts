// Local-media ingestion: drag-and-drop onto the window + file picker via dialog.
// Drag-and-drop uses webUtils.getPathForFile (exposed by preload) since Electron's
// File.path was removed; the picker round-trips through main's showOpenDialog.

import { addLocalClip } from './tile';

const ACCEPTED_EXT = new Set([
  'mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'opus',
  'mp4', 'mov', 'mkv', 'webm', 'm4v',
]);

function hasFilesPayload(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  // 'Files' appears in types[] for any OS-level file drag.
  return [...dt.types].includes('Files');
}

function extOf(p: string): string {
  const m = /\.([^./\\]+)$/.exec(p);
  return m ? m[1].toLowerCase() : '';
}

async function ingestPaths(paths: string[]): Promise<void> {
  for (const p of paths) {
    if (!ACCEPTED_EXT.has(extOf(p))) continue;
    try { await addLocalClip(p); } catch (e) { console.warn('addLocalClip failed:', e); }
  }
}

export async function pickAndLoad(): Promise<void> {
  const paths = await window.api.pickLocalFiles();
  if (paths.length) await ingestPaths(paths);
}

export function bindLocalFiles(): void {
  // Drag depth counter avoids the dragleave-firing-on-child-element flicker
  // that a single boolean toggle would suffer from.
  let depth = 0;
  const setDropping = (on: boolean) => {
    document.body.dataset.dropping = String(on);
  };

  document.addEventListener('dragenter', (e) => {
    if (!hasFilesPayload(e.dataTransfer)) return;
    e.preventDefault();
    depth++;
    if (depth === 1) setDropping(true);
  });

  document.addEventListener('dragover', (e) => {
    if (!hasFilesPayload(e.dataTransfer)) return;
    e.preventDefault();
    // copy cursor reads as "this will add a pad", not "this will move something".
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('dragleave', () => {
    if (depth === 0) return;
    depth--;
    if (depth === 0) setDropping(false);
  });

  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    depth = 0;
    setDropping(false);
    const paths: string[] = [];
    for (const file of Array.from(e.dataTransfer.files)) {
      try {
        const p = window.api.getPathForFile(file);
        if (p) paths.push(p);
      } catch {}
    }
    await ingestPaths(paths);
  });
}

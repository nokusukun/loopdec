import { gridShape, applyGridShape, findFirstEmptyCell, setTilePosition, syncEmptyCellHeight } from './grid';
import { gridColsInput, gridRowsInput, clipsContainer } from './dom';
import { tiles, sources } from '../state';
import { saveManifest } from '../persistence/manifest';
import { decodeSourceAudio, playAudio, tearDownTileAudio } from '../audio/engine';
import { stopPlayheadAnimation } from '../audio/playback';
import { updateTileLoopIndicator } from './tile-display';

type TileSize = 's' | 'm' | 'l';
const TILE_SIZES: readonly TileSize[] = ['s', 'm', 'l'] as const;

function applyTileSize(size: TileSize): void {
  clipsContainer.dataset.tileSize = size;
  const group = document.getElementById('set-tile-size');
  group?.querySelectorAll<HTMLButtonElement>('[data-value]').forEach((btn) => {
    btn.setAttribute('aria-checked', String(btn.dataset.value === size));
  });
  localStorage.setItem('loopdec-tile-size', size);
  // Tile width changed → tile-video aspect-ratio recomputes height → ResizeObserver
  // already triggers syncEmptyCellHeight, but call once eagerly so empty cells
  // don't lag behind by a frame.
  syncEmptyCellHeight();
}

function setGridShape(cols: number, rows: number): void {
  gridShape.cols = Math.max(1, Math.min(10, cols | 0));
  gridShape.rows = Math.max(1, Math.min(10, rows | 0));
  const overflow = [...tiles.values()].filter(t => (t.row ?? 0) >= gridShape.rows || (t.col ?? 0) >= gridShape.cols);
  for (const t of overflow) {
    t.row = -1; t.col = -1;
    const cell = findFirstEmptyCell();
    setTilePosition(t, cell.row, cell.col);
  }
  applyGridShape();
  localStorage.setItem('loopdec-grid-cols', String(gridShape.cols));
  localStorage.setItem('loopdec-grid-rows', String(gridShape.rows));
  saveManifest();
}

export function bindSettings(): void {
  document.getElementById('set-cache')!.addEventListener('change', async (e) => {
    const gb = parseFloat((e.target as HTMLInputElement).value);
    if (gb > 0 && isFinite(gb)) {
      await window.api.setMaxCache(gb);
      const info = await window.api.getCacheInfo();
      document.getElementById('set-cache-used')!.textContent = `${info.usedGB} GB / ${info.files} files`;
    }
  });

  gridColsInput.addEventListener('change', () => {
    setGridShape(parseInt(gridColsInput.value), gridShape.rows);
  });
  gridRowsInput.addEventListener('change', () => {
    setGridShape(gridShape.cols, parseInt(gridRowsInput.value));
  });

  document.getElementById('set-quality')!.addEventListener('change', (e) => {
    localStorage.setItem('loopdec-quality', (e.target as HTMLInputElement).value);
  });
  document.getElementById('set-bitrate')!.addEventListener('change', (e) => {
    localStorage.setItem('loopdec-bitrate', (e.target as HTMLInputElement).value);
  });
  document.getElementById('set-snap')!.addEventListener('change', (e) => {
    localStorage.setItem('loopdec-snap', (e.target as HTMLInputElement).value);
  });
  document.getElementById('set-ytdlp')!.addEventListener('change', (e) => {
    localStorage.setItem('loopdec-ytdlp', (e.target as HTMLInputElement).value);
  });

  document.getElementById('set-tile-size')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-value]');
    if (!btn) return;
    const v = btn.dataset.value;
    if (v === 's' || v === 'm' || v === 'l') applyTileSize(v);
  });

  const rebuildBtn = document.getElementById('set-rebuild-cache') as HTMLButtonElement | null;
  rebuildBtn?.addEventListener('click', () => { void rebuildAudioCache(rebuildBtn); });
}

// Wipe every loaded clip's derived audio (chunks + peaks + extracted m4a) and
// re-run extract + decode. Source .mp4 files are kept so we don't re-download.
// Used to migrate existing clips to a new CHUNK_DURATION or recover from a
// corrupted cache.
let rebuildInFlight = false;
async function rebuildAudioCache(btn: HTMLButtonElement): Promise<void> {
  if (rebuildInFlight) return;
  rebuildInFlight = true;
  btn.disabled = true;
  btn.dataset.state = 'running';
  const status = btn.querySelector<HTMLElement>('.setting-btn-status');
  if (status) status.dataset.state = 'running';

  const sourceList = [...sources.values()];
  let completed = 0;
  let failed = 0;

  // Snapshot which tiles were playing per source so we can restart them at
  // their previous source-time position after re-decode finishes.
  const resumePositions = new Map<string, number>();
  for (const tile of tiles.values()) {
    if (tile.state === 'playing') {
      const source = sources.get(tile.sourceId);
      if (source?.audioReady) {
        // Capture via the audio engine's own clock — same path getAudioPosition uses.
        const { getAudioPosition } = await import('../audio/engine');
        resumePositions.set(tile.id, getAudioPosition(tile));
      }
      tearDownTileAudio(tile);
      stopPlayheadAnimation(tile);
    }
  }

  for (const source of sourceList) {
    try {
      // Mark not ready so playAudio rejects mid-rebuild calls cleanly.
      source.audioReady = false;
      source.audioBuffer = null;
      source.decodedChunks = null;
      source.peaks = null;
      source.chunked = false;
      source.chunkCount = 0;
      source.chunkDuration = 0;

      await window.api.rebuildAudioCache(source.id);
      const result = await window.api.extractAudio(source.id);
      if (!result.ok) { failed++; continue; }
      if (result.chunked) {
        source.chunked = true;
        source.chunkCount = result.chunkCount;
        source.chunkDuration = result.chunkDuration;
      }
      await decodeSourceAudio(source);
      completed++;
    } catch (e) {
      console.warn('rebuild failed for', source.id, e);
      failed++;
    } finally {
      btn.dataset.progress = `${completed + failed}/${sourceList.length}`;
    }
  }

  // Restart playback on tiles that were playing — and refresh loop indicators
  // since the underlying buffers were swapped.
  for (const tile of tiles.values()) {
    updateTileLoopIndicator(tile);
    const resumeFrom = resumePositions.get(tile.id);
    if (resumeFrom !== undefined) {
      const source = sources.get(tile.sourceId);
      if (source?.audioReady) await playAudio(tile, resumeFrom);
    }
  }

  const info = await window.api.getCacheInfo();
  const usedEl = document.getElementById('set-cache-used');
  if (usedEl) usedEl.textContent = `${info.usedGB} GB / ${info.files} files`;

  saveManifest();

  btn.disabled = false;
  btn.dataset.state = failed > 0 ? 'error' : 'done';
  if (status) status.dataset.state = failed > 0 ? 'error' : 'done';
  delete btn.dataset.progress;
  // Settle back to idle after a beat so the result is readable but the button
  // isn't permanently flagged.
  setTimeout(() => {
    btn.dataset.state = 'idle';
    if (status) status.dataset.state = 'idle';
    rebuildInFlight = false;
  }, 1500);
}

export function restoreSettings(): void {
  const quality = localStorage.getItem('loopdec-quality');
  if (quality) (document.getElementById('set-quality') as HTMLInputElement).value = quality;
  const bitrate = localStorage.getItem('loopdec-bitrate');
  if (bitrate) (document.getElementById('set-bitrate') as HTMLInputElement).value = bitrate;
  const snapPref = localStorage.getItem('loopdec-snap');
  if (snapPref) (document.getElementById('set-snap') as HTMLInputElement).value = snapPref;
  const savedCols = parseInt(localStorage.getItem('loopdec-grid-cols') ?? '');
  const savedRows = parseInt(localStorage.getItem('loopdec-grid-rows') ?? '');
  if (savedCols) gridShape.cols = savedCols;
  if (savedRows) gridShape.rows = savedRows;
  gridColsInput.value = String(gridShape.cols);
  gridRowsInput.value = String(gridShape.rows);
  applyGridShape();
  const ytdlp = localStorage.getItem('loopdec-ytdlp');
  if (ytdlp) (document.getElementById('set-ytdlp') as HTMLInputElement).value = ytdlp;

  const savedSize = localStorage.getItem('loopdec-tile-size') as TileSize | null;
  applyTileSize(savedSize && TILE_SIZES.includes(savedSize) ? savedSize : 'm');
}

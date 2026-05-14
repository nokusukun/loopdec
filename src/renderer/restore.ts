import type { Tile } from './types';
import { tiles, sources, counters } from './state';
import { tilesGrid, emptyState, gridColsInput, gridRowsInput } from './dom';
import { gridShape, applyGridShape, findFirstEmptyCell, renderEmptyCells, setTilePosition } from './grid';
import { updateEmptyState } from './state';
import { createTileElement, loadVideo } from './tile';
import { decodeSourceAudio } from './audio-engine';
import { updateTileLoopIndicator } from './tile-display';

export async function restoreSession(): Promise<void> {
  const manifest = await window.api.loadManifest();
  if (!manifest || !manifest.sources || !manifest.tiles?.length) {
    updateEmptyState();
    return;
  }

  if (manifest.grid && manifest.grid.cols && manifest.grid.rows) {
    gridShape.cols = manifest.grid.cols;
    gridShape.rows = manifest.grid.rows;
    gridColsInput.value = String(gridShape.cols);
    gridRowsInput.value = String(gridShape.rows);
    applyGridShape();
  }

  for (const [id, src] of Object.entries(manifest.sources)) {
    sources.set(id, {
      id,
      url: src.url,
      title: src.title,
      duration: src.duration,
      audioBuffer: null,
      audioReady: false,
      chunked: src.chunked || false,
      chunkCount: src.chunkCount || 0,
      chunkDuration: src.chunkDuration || 0,
      decodedChunks: null,
      peaks: null,
    });
  }

  for (const td of manifest.tiles) {
    const source = sources.get(td.sourceId);
    if (!source) continue;

    const tile: Tile = {
      id: td.id,
      sourceId: td.sourceId,
      loopStart: td.loopStart,
      loopEnd: td.loopEnd,
      enabled: td.enabled !== false,
      state: 'paused',
      video: null,
      audioSource: null,
      audioStartedAt: 0,
      audioStartedOffset: 0,
      animFrameId: null,
      volume: td.volume ?? 1,
      gainNode: null,
      muted: false,
      els: undefined as unknown as Tile['els'],
      eq: td.eq && td.eq.length === 8 ? [...td.eq] : [0, 0, 0, 0, 0, 0, 0, 0],
      eqFilters: null,
      speed: td.speed ?? 1,
      pitchLock: td.pitchLock ?? false,
    };

    const tileNum = parseInt(tile.id.split('_').pop() ?? '') || 0;
    if (tileNum >= counters.tile) counters.tile = tileNum + 1;
    const srcNum = parseInt(td.sourceId.split('_').pop() ?? '') || 0;
    if (srcNum >= counters.source) counters.source = srcNum + 1;

    tiles.set(tile.id, tile);
    const tileEl = createTileElement(tile, source);
    tilesGrid.insertBefore(tileEl, emptyState);
    if (Number.isInteger(td.row) && Number.isInteger(td.col)) {
      setTilePosition(tile, td.row!, td.col!);
    } else {
      const cell = findFirstEmptyCell();
      setTilePosition(tile, cell.row, cell.col);
    }
    loadVideo(tile, source);
    updateTileLoopIndicator(tile);

    if (tile.volume !== 1) tile.els.volumeSlider.value = String(tile.volume);
    if (!tile.enabled) {
      tile.els.tile.dataset.enabled = 'false';
      tile.els.toggleBtn.textContent = 'OFF';
      tile.els.toggleBtn.classList.remove('enabled');
    }
  }

  let maxRow = gridShape.rows - 1;
  let maxCol = gridShape.cols - 1;
  for (const t of tiles.values()) {
    if ((t.row ?? 0) > maxRow) maxRow = t.row!;
    if ((t.col ?? 0) > maxCol) maxCol = t.col!;
  }
  if (maxRow + 1 > gridShape.rows || maxCol + 1 > gridShape.cols) {
    gridShape.rows = Math.max(gridShape.rows, maxRow + 1);
    gridShape.cols = Math.max(gridShape.cols, maxCol + 1);
    gridColsInput.value = String(gridShape.cols);
    gridRowsInput.value = String(gridShape.rows);
    applyGridShape();
  }

  renderEmptyCells();
  updateEmptyState();

  await Promise.all([...sources.values()].map(src => decodeSourceAudio(src)));
}

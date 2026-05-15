import type { DeckData } from '../../shared/types';
import type { Tile, Source } from '../types';
import {
  tiles, sources, counters, currentDeckMeta, resetDeckMeta,
  updateDeckTitle, updateEmptyState, tilesForSource,
} from '../state';
import { tilesGrid, emptyState, gridColsInput, gridRowsInput } from '../ui/dom';
import { editor } from '../editor-state';
import { gridShape, applyGridShape, findFirstEmptyCell, renderEmptyCells, setTilePosition } from '../ui/grid';
import { saveManifest } from './manifest';
import { createTileElement, loadVideo, removeTile } from '../ui/tile';
import { decodeSourceAudio, tearDownTileAudio } from '../audio/engine';
import { stopPlayheadAnimation } from '../audio/playback';
import { closeWaveformEditor } from '../ui/waveform';
import { updateTileLoopIndicator } from '../ui/tile-display';
import { initTilePlugins, serializeTilePlugins, persistedToPluginState } from '../plugins/registry';

function buildDeckData(): DeckData {
  const data: DeckData = {
    meta: {
      name: currentDeckMeta.name || 'Untitled',
      description: currentDeckMeta.description || '',
      created: currentDeckMeta.created || new Date().toISOString(),
      modified: new Date().toISOString(),
      tileCount: tiles.size,
      sourceCount: sources.size,
    },
    sources: {},
    tiles: [],
    grid: { cols: gridShape.cols, rows: gridShape.rows },
  };
  for (const [id, src] of sources) {
    data.sources[id] = {
      id, url: src.url, title: src.title, duration: src.duration,
      chunked: src.chunked || false, chunkCount: src.chunkCount || 0, chunkDuration: src.chunkDuration || 0,
    };
  }
  for (const tile of tiles.values()) {
    data.tiles.push({
      id: tile.id, sourceId: tile.sourceId,
      loopStart: tile.loopStart, loopEnd: tile.loopEnd,
      enabled: tile.enabled, volume: tile.volume,
      row: tile.row, col: tile.col,
      plugins: serializeTilePlugins(tile),
    });
  }
  return data;
}

import { palettePrompt, closePalette } from '../ui/palette';

// Save in place: overwrite the deck's current file with no dialog.
// Falls through to Save As when the deck has never been written to disk.
export async function saveDeck(): Promise<void> {
  if (!currentDeckMeta.path) {
    await saveDeckAs();
    return;
  }
  if (!currentDeckMeta.created) currentDeckMeta.created = new Date().toISOString();
  const result = await window.api.saveDeck(buildDeckData(), { path: currentDeckMeta.path });
  if (result?.ok) {
    currentDeckMeta.modified = new Date().toISOString();
    updateDeckTitle();
  }
}

// Save As: always prompt, default filename = sanitized deck title.
export async function saveDeckAs(): Promise<void> {
  if (!currentDeckMeta.name) {
    const name = await palettePrompt('Deck name (Enter to confirm)', 'Untitled');
    if (!name) return;
    currentDeckMeta.name = name;
  }
  if (!currentDeckMeta.created) currentDeckMeta.created = new Date().toISOString();
  const result = await window.api.saveDeck(buildDeckData(), { suggestedName: currentDeckMeta.name });
  if (result?.ok && result.path) {
    currentDeckMeta.path = result.path;
    currentDeckMeta.modified = new Date().toISOString();
    updateDeckTitle();
  }
}

export async function loadDeckByPath(filePath: string): Promise<void> {
  const data = await window.api.loadDeckPath(filePath);
  if (data) await applyDeckData(data, filePath);
}

export async function loadDeck(): Promise<void> {
  const result = await window.api.loadDeck();
  if (result) await applyDeckData(result.data, result.path);
}

export function newDeck(): void {
  for (const tileId of [...tiles.keys()]) removeTile(tileId);
  resetDeckMeta();
  updateDeckTitle();
  updateEmptyState();
  saveManifest();
}

async function applyDeckData(data: DeckData, path: string | null = null): Promise<void> {
  if (!data?.sources || !data?.tiles) return;

  if (data.meta) {
    resetDeckMeta({
      name: data.meta.name || '',
      description: data.meta.description || '',
      created: data.meta.created || null,
      modified: data.meta.modified || null,
      path,
    });
  } else {
    resetDeckMeta({ path });
  }
  updateDeckTitle();

  if (data.grid && data.grid.cols && data.grid.rows) {
    gridShape.cols = data.grid.cols;
    gridShape.rows = data.grid.rows;
    gridColsInput.value = String(gridShape.cols);
    gridRowsInput.value = String(gridShape.rows);
    applyGridShape();
  }

  const incomingSourceIds = new Set(Object.keys(data.sources));

  for (const tileId of [...tiles.keys()]) {
    const tile = tiles.get(tileId);
    if (!tile) continue;

    if (editor.tileId === tileId) closeWaveformEditor();
    tearDownTileAudio(tile);
    if (tile.video) { tile.video.pause(); tile.video.src = ''; }
    stopPlayheadAnimation(tile);
    tile.els.tile.remove();
    tiles.delete(tileId);

    if (tilesForSource(tile.sourceId).length === 0 && !incomingSourceIds.has(tile.sourceId)) {
      sources.delete(tile.sourceId);
      window.api.deleteClip(tile.sourceId);
    }
  }
  for (const id of [...sources.keys()]) {
    if (!incomingSourceIds.has(id)) sources.delete(id);
  }

  for (const [id, src] of Object.entries(data.sources)) {
    sources.set(id, {
      id, url: src.url, title: src.title, duration: src.duration,
      audioBuffer: null, audioReady: false,
      chunked: src.chunked || false, chunkCount: src.chunkCount || 0, chunkDuration: src.chunkDuration || 0,
      decodedChunks: null, peaks: null,
    });
  }

  for (const td of data.tiles) {
    const source = sources.get(td.sourceId);
    if (!source) continue;

    const tile: Tile = {
      id: td.id, sourceId: td.sourceId,
      loopStart: td.loopStart, loopEnd: td.loopEnd,
      enabled: td.enabled !== false, state: 'paused',
      video: null, audioSource: null, audioStartedAt: 0, audioStartedOffset: 0,
      animFrameId: null, volume: td.volume ?? 1,
      gainNode: null, muted: false,
      els: undefined as unknown as Tile['els'],
      plugins: {},
    };
    initTilePlugins(tile, persistedToPluginState(td));

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

    if (tile.volume !== 1) tile.els.volumeSlider.value = String(tile.volume);
    if (!tile.enabled) {
      tile.els.tile.dataset.enabled = 'false';
      tile.els.toggleBtn.textContent = 'OFF';
      tile.els.toggleBtn.classList.remove('enabled');
    }
  }

  renderEmptyCells();
  updateEmptyState();
  saveManifest();

  for (const source of sources.values()) {
    (async () => {
      try {
        await window.api.downloadClip(source.url, source.id);
        for (const t of tilesForSource(source.id)) {
          t.state = 'paused';
          t.els.tile.dataset.state = 'paused';
          loadVideo(t, source);
          updateTileLoopIndicator(t);
        }
        const result = await window.api.extractAudio(source.id);
        if (result.ok) {
          if (result.chunked) {
            source.chunked = true;
            source.chunkCount = result.chunkCount;
            source.chunkDuration = result.chunkDuration;
          }
          await decodeSourceAudio(source);
          saveManifest();
        }
      } catch {
        for (const t of tilesForSource(source.id)) {
          t.state = 'error';
          t.els.tile.dataset.state = 'error';
        }
      }
    })();
  }
}

// Avoid unused-import warning when bundler dead-strips closePalette
void closePalette;

import type { Source, Tile, DeckMeta } from './types';
import { deckNameEl, emptyState, clipsContainer } from './dom';

let emptyStateHook: (() => void) | null = null;
export function onEmptyStateEnter(fn: () => void): void { emptyStateHook = fn; }

export const sources = new Map<string, Source>();
export const tiles = new Map<string, Tile>();

export const counters = { source: 0, tile: 0 };

export const currentDeckMeta: DeckMeta = {
  name: '', description: '', created: null, modified: null, path: null,
};

export function resetDeckMeta(meta?: Partial<DeckMeta>): void {
  currentDeckMeta.name = meta?.name ?? '';
  currentDeckMeta.description = meta?.description ?? '';
  currentDeckMeta.created = meta?.created ?? null;
  currentDeckMeta.modified = meta?.modified ?? null;
  currentDeckMeta.path = meta?.path ?? null;
}

export function generateSourceId(): string {
  return `src_${Date.now()}_${++counters.source}`;
}

export function generateTileId(): string {
  return `tile_${Date.now()}_${++counters.tile}`;
}

export function getSource(tile: Tile): Source | undefined {
  return sources.get(tile.sourceId);
}

export function tilesForSource(sourceId: string): Tile[] {
  return [...tiles.values()].filter(t => t.sourceId === sourceId);
}

export function updateEmptyState(): void {
  const empty = tiles.size === 0;
  emptyState.classList.toggle('hidden', !empty);
  const wasEmpty = clipsContainer.dataset.empty === 'true';
  clipsContainer.dataset.empty = String(empty);
  if (empty && !wasEmpty) emptyStateHook?.();
}

export function updateDeckTitle(): void {
  deckNameEl.textContent = currentDeckMeta.name || '';
}

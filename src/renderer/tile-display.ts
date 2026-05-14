import type { Tile } from './types';
import { getSource } from './state';
import { formatTime } from './utils';

export function updateTileLoopIndicator(tile: Tile): void {
  const source = getSource(tile);
  if (!source || source.duration === 0) return;
  const startPct = (tile.loopStart / source.duration) * 100;
  const endPct = (tile.loopEnd / source.duration) * 100;
  tile.els.loopRegion.style.left = `${startPct}%`;
  tile.els.loopRegion.style.width = `${endPct - startPct}%`;
  tile.els.timeRange.textContent = `${formatTime(tile.loopStart)} → ${formatTime(tile.loopEnd)}`;
}

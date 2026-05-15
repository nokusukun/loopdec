import type { Tile } from '../types';
import { getSource } from '../state';
import { formatTime } from '../utils';
import { getSpeed } from '../plugins/speed';

export function updateTileLoopIndicator(tile: Tile): void {
  const source = getSource(tile);
  if (!source || source.duration === 0) return;
  const startPct = (tile.loopStart / source.duration) * 100;
  const endPct = (tile.loopEnd / source.duration) * 100;
  tile.els.loopRegion.style.left = `${startPct}%`;
  tile.els.loopRegion.style.width = `${endPct - startPct}%`;
  tile.els.timeRange.textContent = `${formatTime(tile.loopStart)} → ${formatTime(tile.loopEnd)}`;
}

// Show a small "0.75×" pill in the tile header when speed != 1, hide otherwise.
export function applyTileSpeedDisplay(tile: Tile): void {
  const speed = getSpeed(tile);
  const mod = Math.abs(speed - 1) > 0.001;
  tile.els.tile.dataset.speedMod = String(mod);
  tile.els.speedPill.textContent = mod ? `${speed.toFixed(2)}×` : '';
}

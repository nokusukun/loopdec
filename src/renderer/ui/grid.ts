import type { GridShape, Tile } from '../types';
import { tiles, tilesForSource } from '../state';
import { tilesGrid, emptyState, waveformAddressEl, gridRowsInput } from './dom';
import { editor } from '../editor-state';

void tilesForSource; // referenced from other modules but unused here

export const gridShape: GridShape = { cols: 4, rows: 3 };

export function padAddress(row: number, col: number): string {
  return `${String.fromCharCode(65 + row)}${col + 1}`;
}

export function applyGridShape(): void {
  // Column count drives the CSS grid template via `--cols`; per-column width
  // comes from `--tile-w` (set on #clips-container by the size selector).
  tilesGrid.style.setProperty('--cols', String(gridShape.cols));
  tilesGrid.style.gridTemplateRows = `18px`;
  renderCoordinateLabels();
  renderEmptyCells();
}

export function renderCoordinateLabels(): void {
  tilesGrid.querySelectorAll('.grid-coord').forEach(el => el.remove());
  for (let c = 0; c < gridShape.cols; c++) {
    const label = document.createElement('div');
    label.className = 'grid-coord grid-coord-col';
    label.textContent = String(c + 1).padStart(2, '0');
    label.style.gridRow = '1';
    label.style.gridColumn = String(c + 2);
    tilesGrid.insertBefore(label, emptyState);
  }
  for (let r = 0; r < gridShape.rows; r++) {
    const label = document.createElement('div');
    label.className = 'grid-coord grid-coord-row';
    label.textContent = String.fromCharCode(65 + r);
    label.style.gridRow = String(r + 2);
    label.style.gridColumn = '1';
    tilesGrid.insertBefore(label, emptyState);
  }
}

export function setTilePosition(tile: Tile, row: number, col: number): void {
  tile.row = row;
  tile.col = col;
  tile.els.tile.style.gridRow = String(row + 2);
  tile.els.tile.style.gridColumn = String(col + 2);
  tile.els.address.textContent = padAddress(row, col);
  if (editor.tileId === tile.id) {
    waveformAddressEl.textContent = padAddress(row, col);
  }
}

export function tileAt(row: number, col: number): Tile | null {
  for (const t of tiles.values()) {
    if (t.row === row && t.col === col) return t;
  }
  return null;
}

export function findFirstEmptyCell(): { row: number; col: number } {
  for (let r = 0; r < gridShape.rows; r++) {
    for (let c = 0; c < gridShape.cols; c++) {
      if (!tileAt(r, c)) return { row: r, col: c };
    }
  }
  gridShape.rows += 1;
  gridRowsInput.value = String(gridShape.rows);
  localStorage.setItem('loopdec-grid-rows', String(gridShape.rows));
  renderCoordinateLabels();
  return { row: gridShape.rows - 1, col: 0 };
}

export function renderEmptyCells(): void {
  tilesGrid.querySelectorAll('.tile-empty').forEach(el => el.remove());
  for (let r = 0; r < gridShape.rows; r++) {
    for (let c = 0; c < gridShape.cols; c++) {
      if (tileAt(r, c)) continue;
      const cell = document.createElement('div');
      cell.className = 'tile-empty';
      cell.dataset.row = String(r);
      cell.dataset.col = String(c);
      cell.dataset.address = padAddress(r, c);
      cell.style.gridRow = String(r + 2);
      cell.style.gridColumn = String(c + 2);
      tilesGrid.insertBefore(cell, emptyState);
    }
  }
  syncEmptyCellHeight();
}

// Keeps empty cells visually aligned with the rendered tile height.
//
// We observe the .tile-video element, NOT the tile itself: the video has a fixed
// 16/9 aspect-ratio so its height tracks width reliably, while the tile gets
// stretched up to match the empty cells' --tile-h and so won't shrink on its own
// when the window narrows. Each sync drops --tile-h before measuring so the row
// can collapse to the tile's natural height.
let videoObserver: ResizeObserver | null = null;
let observedVideo: Element | null = null;

export function syncEmptyCellHeight(): void {
  const ref = tilesGrid.querySelector<HTMLElement>('.tile:not(.dragging)');
  if (!ref) {
    tilesGrid.style.removeProperty('--tile-h');
    videoObserver?.disconnect();
    observedVideo = null;
    return;
  }

  // Drop the override so empty cells fall back to their default; the row will
  // size to the tile's natural content height for this measurement.
  tilesGrid.style.removeProperty('--tile-h');
  void ref.offsetHeight; // force reflow
  const h = ref.getBoundingClientRect().height;
  if (h > 0) tilesGrid.style.setProperty('--tile-h', `${h}px`);

  const video = ref.querySelector<HTMLElement>('.tile-video');
  if (!video) return;
  if (!videoObserver) {
    videoObserver = new ResizeObserver(() => syncEmptyCellHeight());
  }
  if (observedVideo !== video) {
    videoObserver.disconnect();
    videoObserver.observe(video);
    observedVideo = video;
  }
}

// Custom 8-band EQ panel inside the waveform editor.
//
// No native sliders — each band is a hit-tested track div. Click+drag anywhere
// in the column to set its dB value (snapped to 0.5 dB). Double-click resets a
// single band. RESET button flattens all bands.
//
// Visual model: bars bloom from the 0 dB centerline. Boost grows up, cut grows
// down. Bands that aren't at 0 light up amber (track + thumb + label + readout)
// and the panel header switches from "FLAT" → "ACTIVE".

import { tiles } from './state';
import { editor } from './editor-state';
import { setEqBand, EQ_BAND_COUNT } from './audio-engine';
import { saveManifest } from './manifest';
import { bindSliderDrag } from './drag';

const DB_MIN = -12;
const DB_MAX = 12;
const DB_STEP = 0.5;
const DEAD_ZONE = 0.25; // pixels around centerline that snap to 0

const eqPanel = document.getElementById('eq-panel');
const statusEl = document.getElementById('eq-status');
const resetBtn = document.getElementById('eq-reset');
const bandEls = Array.from(document.querySelectorAll<HTMLElement>('.eq-band'));

function clampDb(v: number): number {
  if (v > DB_MAX) return DB_MAX;
  if (v < DB_MIN) return DB_MIN;
  return v;
}

function formatDb(v: number): string {
  if (Math.abs(v) < 0.01) return '0';
  const sign = v > 0 ? '+' : '−'; // unicode minus for monospace alignment
  return `${sign}${Math.abs(v).toFixed(Math.abs(v) >= 10 ? 0 : 1)}`;
}

// Paint a single band's DOM from a dB value.
function paintBand(band: number, v: number): void {
  const el = bandEls[band];
  if (!el) return;
  const thumb = el.querySelector<HTMLElement>('.eq-thumb');
  const fill = el.querySelector<HTMLElement>('.eq-fill');
  const readout = el.querySelector<HTMLElement>('.eq-readout');
  if (!thumb || !fill || !readout) return;

  // map dB → vertical position. v=+12 → 0% (top), v=0 → 50%, v=-12 → 100% (bottom).
  const topPct = 50 - (v / DB_MAX) * 50;
  thumb.style.top = `${topPct}%`;

  const isZero = Math.abs(v) < 0.01;
  if (isZero) {
    fill.style.top = '50%';
    fill.style.height = '0';
    readout.textContent = '';
  } else if (v > 0) {
    fill.style.top = `${topPct}%`;
    fill.style.height = `${50 - topPct}%`;
    readout.textContent = formatDb(v);
  } else {
    fill.style.top = '50%';
    fill.style.height = `${topPct - 50}%`;
    readout.textContent = formatDb(v);
  }

  // Only flip the state class if we're not mid-drag (the drag handler manages
  // its own 'dragging' state).
  if (el.dataset.state !== 'dragging') {
    el.dataset.state = isZero ? 'neutral' : 'active';
  }
}

function refreshStatus(): void {
  const tile = editor.tileId ? tiles.get(editor.tileId) : null;
  if (!eqPanel || !statusEl) return;
  if (!tile) {
    eqPanel.dataset.active = 'false';
    statusEl.textContent = 'FLAT';
    return;
  }
  const any = tile.eq.some(v => Math.abs(v) > 0.01);
  eqPanel.dataset.active = String(any);
  statusEl.textContent = any ? 'ACTIVE' : 'FLAT';
}

// Reload the panel from the currently-edited tile (called whenever the editor opens).
export function loadEqForCurrentTile(): void {
  const tile = editor.tileId ? tiles.get(editor.tileId) : null;
  for (let i = 0; i < EQ_BAND_COUNT; i++) {
    paintBand(i, tile?.eq[i] ?? 0);
  }
  refreshStatus();
}

// Convert a pointer Y inside the track (0 = top, height = bottom) to a snapped dB value.
function dbFromY(y: number, height: number): number {
  if (height <= 0) return 0;
  const norm = Math.max(0, Math.min(1, y / height));
  let v = (1 - 2 * norm) * DB_MAX;
  // dead zone around 0 for easy "back to flat"
  if (Math.abs(v) < DEAD_ZONE) return 0;
  return clampDb(Math.round(v / DB_STEP) * DB_STEP);
}

function bindBand(el: HTMLElement, band: number): void {
  const track = el.querySelector<HTMLElement>('.eq-track');
  if (!track) return;

  bindSliderDrag(track, {
    start: () => {
      const tile = editor.tileId ? tiles.get(editor.tileId) : null;
      if (!tile) return false;
      el.dataset.state = 'dragging';
    },
    move: (_x, y, rect) => {
      const tile = editor.tileId ? tiles.get(editor.tileId) : null;
      if (!tile) return;
      const v = dbFromY(y - rect.top, rect.height);
      setEqBand(tile, band, v);
      paintBand(band, v);
      refreshStatus();
    },
    end: () => {
      const tile = editor.tileId ? tiles.get(editor.tileId) : null;
      if (!tile) return;
      const v = tile.eq[band] ?? 0;
      el.dataset.state = Math.abs(v) < 0.01 ? 'neutral' : 'active';
      saveManifest();
    },
  });

  track.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    if (!tile) return;
    setEqBand(tile, band, 0);
    paintBand(band, 0);
    refreshStatus();
    saveManifest();
  });
}

export function bindEq(): void {
  bandEls.forEach((el, i) => bindBand(el, i));

  resetBtn?.addEventListener('click', () => {
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    if (!tile) return;
    for (let i = 0; i < EQ_BAND_COUNT; i++) {
      setEqBand(tile, i, 0);
      paintBand(i, 0);
    }
    refreshStatus();
    saveManifest();
  });

  // Initial paint with no tile (all neutral, status FLAT).
  loadEqForCurrentTile();
}

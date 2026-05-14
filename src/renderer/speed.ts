// Per-track speed control inside the waveform editor.
//
// Range 0.5× to 2.0× mapped logarithmically so 1.0× sits at the visual center.
// Snaps to 0.05 increments. Dead-zone of ±0.03 around 1.0 snaps to exactly 1.0
// so it's easy to drop back to "normal". Pointer-driven, no native input.

import { tiles } from './state';
import { editor } from './editor-state';
import { setTileSpeed, setTilePitchLock } from './audio-engine';
import { saveManifest } from './manifest';
import { applyTileSpeedDisplay } from './tile-display';
import { bindSliderDrag } from './drag';

const MIN = 0.5;
const MAX = 2.0;
const STEP = 0.05;
const DEAD_ZONE = 0.03; // |speed - 1| < this → snap to 1.0

const panel    = document.getElementById('speed-panel') as HTMLElement | null;
const track    = document.getElementById('speed-track') as HTMLElement | null;
const readoutEl = document.getElementById('speed-readout');
const lockBtn  = document.getElementById('speed-lock') as HTMLButtonElement | null;
const thumb    = track?.querySelector<HTMLElement>('.speed-thumb') ?? null;

// log-uniform mapping: slider 0..1 ↔ speed 0.5..2.0, with 0.5 → 1.0× at midpoint.
function speedToFrac(speed: number): number {
  return (Math.log2(speed) + 1) / 2;
}
function fracToSpeed(frac: number): number {
  const clamped = Math.max(0, Math.min(1, frac));
  return Math.pow(2, 2 * clamped - 1);
}

function snap(speed: number): number {
  const clamped = Math.max(MIN, Math.min(MAX, speed));
  if (Math.abs(clamped - 1) < DEAD_ZONE) return 1.0;
  return Math.round(clamped / STEP) * STEP;
}


function formatSpeed(s: number): string {
  return `${s.toFixed(2)}×`;
}

function paint(speed: number): void {
  if (!thumb || !readoutEl || !panel) return;
  // Visual thumb clamps to the slider's musical range; typed values outside
  // (e.g. 4×) still apply audibly and show in the readout, the thumb just pins.
  const frac = Math.max(0, Math.min(1, speedToFrac(speed)));
  thumb.style.left = `${frac * 100}%`;
  readoutEl.textContent = formatSpeed(speed);
  panel.dataset.active = Math.abs(speed - 1) < 0.001 ? 'false' : 'true';
}

// Refresh from the currently-edited tile (called when the editor opens).
export function loadSpeedForCurrentTile(): void {
  const tile = editor.tileId ? tiles.get(editor.tileId) : null;
  paint(tile?.speed ?? 1);
  if (lockBtn) lockBtn.setAttribute('aria-pressed', String(tile?.pitchLock ?? false));
}

function selectAll(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function bindReadoutEdit(): void {
  if (!readoutEl) return;

  const startEdit = () => {
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    if (!tile) return;
    // Strip the × so the user only edits the number.
    readoutEl.textContent = tile.speed.toFixed(2);
    readoutEl.setAttribute('contenteditable', 'true');
    readoutEl.focus();
    selectAll(readoutEl);
  };

  const endEdit = (commit: boolean) => {
    if (readoutEl.getAttribute('contenteditable') !== 'true') return;
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    let nextSpeed = tile?.speed ?? 1;

    if (commit && tile) {
      const raw = (readoutEl.textContent ?? '').replace(/[×x\s]/gi, '');
      const parsed = parseFloat(raw);
      // Only sanity bounds — typing is the escape hatch from the slider's musical range.
      if (isFinite(parsed) && parsed > 0) {
        nextSpeed = parsed;
        setTileSpeed(tile, nextSpeed);
        applyTileSpeedDisplay(tile);
        saveManifest();
      }
    }
    readoutEl.removeAttribute('contenteditable');
    readoutEl.blur();
    paint(nextSpeed);
  };

  readoutEl.addEventListener('dblclick', (e) => { e.preventDefault(); startEdit(); });

  readoutEl.addEventListener('keydown', (e) => {
    if (readoutEl.getAttribute('contenteditable') !== 'true') return;
    if (e.key === 'Enter') { e.preventDefault(); endEdit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); endEdit(false); }
    // Don't let Space bubble up to the global play/stop shortcut.
    e.stopPropagation();
  });

  readoutEl.addEventListener('blur', () => endEdit(true));
}

export function bindSpeed(): void {
  if (!track || !panel) return;

  bindSliderDrag(track, {
    start: () => {
      const tile = editor.tileId ? tiles.get(editor.tileId) : null;
      if (!tile) return false;
      panel.dataset.state = 'dragging';
    },
    move: (x, _y, rect) => {
      const tile = editor.tileId ? tiles.get(editor.tileId) : null;
      if (!tile) return;
      const frac = (x - rect.left) / rect.width;
      const s = snap(fracToSpeed(frac));
      setTileSpeed(tile, s);
      paint(s);
      applyTileSpeedDisplay(tile);
    },
    end: () => {
      panel.dataset.state = '';
      saveManifest();
    },
  });

  track.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    if (!tile) return;
    setTileSpeed(tile, 1.0);
    paint(1.0);
    applyTileSpeedDisplay(tile);
    saveManifest();
  });

  bindReadoutEdit();

  lockBtn?.addEventListener('click', () => {
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    if (!tile) return;
    const next = !tile.pitchLock;
    setTilePitchLock(tile, next);
    lockBtn.setAttribute('aria-pressed', String(next));
    saveManifest();
  });

  // Initial paint: neutral (no tile yet).
  paint(1.0);
}

import { snap } from './editor-state';
import { editor } from './editor-state';
import { tiles, getSource } from './state';
import { getAudioPosition } from './audio-engine';
import {
  waveformSnapEl, snapCustomInput, snapOffsetInput, snapOffsetTapBtn,
} from './dom';

function setSnapInterval(val: number): void {
  snap.interval = val;
  document.querySelectorAll('.snap-btn').forEach(b => b.classList.remove('active'));
  snapCustomInput.classList.remove('active');
  if (val === 0) {
    document.querySelector('[data-snap="0"]')?.classList.add('active');
    snapCustomInput.value = '';
  } else {
    const preset = document.querySelector(`[data-snap="${val}"]`);
    if (preset) preset.classList.add('active');
    else snapCustomInput.classList.add('active');
  }
}

function setupDragNumber(): void {
  const el = snapOffsetInput;
  let dragging = false;
  let startX = 0;
  let startVal = 0;

  el.addEventListener('pointerdown', (e) => {
    if (document.activeElement === el) return;
    dragging = true;
    startX = e.clientX;
    startVal = parseFloat(el.value) || 0;
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const delta = (e.clientX - startX) * parseFloat(el.step || '0.01');
    const newVal = Math.max(0, startVal + delta);
    el.value = newVal.toFixed(2);
    snap.offset = newVal;
  });

  el.addEventListener('pointerup', () => { dragging = false; });
  el.addEventListener('lostpointercapture', () => { dragging = false; });
}

export function bindSnap(): void {
  waveformSnapEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.snap-btn');
    if (!btn) return;
    setSnapInterval(parseFloat(btn.dataset.snap!));
    snapCustomInput.value = '';
  });

  snapCustomInput.addEventListener('input', () => {
    const val = parseFloat(snapCustomInput.value);
    if (val > 0 && isFinite(val)) {
      snap.interval = val;
      document.querySelectorAll('.snap-btn').forEach(b => b.classList.remove('active'));
      snapCustomInput.classList.add('active');
    }
  });

  snapCustomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); snapCustomInput.blur(); }
    e.stopPropagation();
  });

  snapOffsetInput.addEventListener('input', () => {
    const val = parseFloat(snapOffsetInput.value);
    if (isFinite(val)) snap.offset = Math.max(0, val);
  });

  snapOffsetInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); snapOffsetInput.blur(); }
    e.stopPropagation();
  });

  snapOffsetTapBtn.addEventListener('click', () => {
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    if (!tile) return;
    const source = getSource(tile);
    if (!source) return;

    let pos = 0;
    if (tile.state === 'playing' && source.audioReady) {
      pos = getAudioPosition(tile);
    } else if (tile.video) {
      pos = tile.video.currentTime;
    }
    snap.offset = parseFloat(pos.toFixed(3));
    snapOffsetInput.value = String(snap.offset);
  });

  setupDragNumber();
}

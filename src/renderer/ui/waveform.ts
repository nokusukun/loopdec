import type { Tile, Source } from '../types';
import { tiles, getSource } from '../state';
import {
  waveformPanel, waveformCanvas, waveformCtx, waveformTitleEl, waveformAddressEl,
  waveformTimeStart, waveformTimeEnd, waveformCloseBtn, waveformFitBtn, waveformMinimap,
} from './dom';
import { padAddress } from './grid';
import { editor, snap, snapTime } from '../editor-state';
import { getAudioPosition, updateAudioLoopPoints } from '../audio/engine';
import { updateTileLoopIndicator } from './tile-display';
import { saveManifest } from '../persistence/manifest';
import { formatTimePrecise } from '../utils';
import { loadTileIntoEditor } from '../plugins/registry';
import { resetActivePage, getActivePage } from './editor-pages';

let lastCanvasW = 0;
let lastCanvasH = 0;

// Color palette pulled out of the draw loop — these are constants, not
// per-frame values. Allocating them once also keeps the JIT happy.
const COL_MUTED       = 'rgba(98, 92, 80, 0.30)';
const COL_ACTIVE      = 'rgba(225, 180, 85, 0.85)';
const COL_ACTIVE_PLAY = 'rgba(110, 195, 130, 0.88)';
const COL_REGION      = 'rgba(225, 180, 85, 0.06)';
const COL_REGION_PLAY = 'rgba(110, 195, 130, 0.08)';
const COL_HANDLE      = 'rgb(225, 180, 85)';
const COL_HANDLE_PLAY = 'rgb(120, 205, 140)';
const COL_PLAYHEAD    = 'rgb(232, 226, 218)';
const COL_GRID        = 'rgba(225, 180, 85, 0.07)';
const COL_CENTER      = 'rgba(98, 92, 80, 0.4)';
const COL_MM_IDLE     = 'rgba(98, 92, 80, 0.28)';
const COL_MM_LOOP     = 'rgba(225, 180, 85, 0.55)';
const COL_MM_LOOP_PLAY = 'rgba(110, 195, 130, 0.65)';

function computePeaks(audioBuffer: AudioBuffer, numBuckets: number): Float32Array {
  const channel = new Float32Array(audioBuffer.length);
  audioBuffer.copyFromChannel(channel, 0, 0);
  const samplesPerBucket = channel.length / numBuckets;
  const peaks = new Float32Array(numBuckets);
  for (let i = 0; i < numBuckets; i++) {
    const start = Math.floor(i * samplesPerBucket);
    const end = Math.min(Math.floor((i + 1) * samplesPerBucket), channel.length);
    let max = 0;
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channel[j]);
      if (abs > max) max = abs;
    }
    peaks[i] = max;
  }
  return peaks;
}

function timeToX(t: number, w: number): number {
  return ((t - editor.viewStart) / (editor.viewEnd - editor.viewStart)) * w;
}

// ── Static-layer caches ────────────────────────────────────────────────
//
// The peaks, region fill, handles, and gridlines change only when the user
// zooms, drags, or changes snap — not every frame. We render them into
// offscreen canvases keyed by their inputs and blit those each frame.
// The playhead is drawn fresh on the main canvas (one fillRect) and the
// minimap playhead is a CSS-positioned <div> so it costs nothing per frame.

let mainCache: HTMLCanvasElement | null = null;
let mainCacheKey = '';
let mainCachePeaks: Float32Array | null = null;

let mmCache: HTMLCanvasElement | null = null;
let mmCacheKey = '';
let mmCachePeaks: Float32Array | null = null;

let mmCanvasEl: HTMLCanvasElement | null = null;
let mmViewportEl: HTMLElement | null = null;
let mmPlayheadEl: HTMLElement | null = null;

function ensureMinimapDOM(): void {
  if (!mmCanvasEl) {
    mmCanvasEl = document.createElement('canvas');
    waveformMinimap.appendChild(mmCanvasEl);
  }
  if (!mmViewportEl) {
    mmViewportEl = document.createElement('div');
    mmViewportEl.className = 'minimap-viewport';
    waveformMinimap.appendChild(mmViewportEl);
  }
  if (!mmPlayheadEl) {
    mmPlayheadEl = document.createElement('div');
    mmPlayheadEl.className = 'minimap-playhead';
    waveformMinimap.appendChild(mmPlayheadEl);
  }
}

function paintMainCache(peaks: Float32Array, loopStart: number, loopEnd: number, duration: number, isPlaying: boolean, w: number, h: number, dpr: number): void {
  if (!mainCache) mainCache = document.createElement('canvas');
  const physW = Math.round(w * dpr);
  const physH = Math.round(h * dpr);
  if (mainCache.width !== physW || mainCache.height !== physH) {
    mainCache.width = physW;
    mainCache.height = physH;
  }
  const ctx = mainCache.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const centerY = h / 2;
  const loopColor   = isPlaying ? COL_ACTIVE_PLAY : COL_ACTIVE;
  const regionFill  = isPlaying ? COL_REGION_PLAY : COL_REGION;
  const handleFill  = isPlaying ? COL_HANDLE_PLAY : COL_HANDLE;

  const startX = timeToX(loopStart, w);
  const endX   = timeToX(loopEnd,   w);

  if (snap.interval > 0) {
    ctx.fillStyle = COL_GRID;
    const firstGrid = Math.ceil((editor.viewStart - snap.offset) / snap.interval) * snap.interval + snap.offset;
    for (let t = firstGrid; t <= editor.viewEnd; t += snap.interval) {
      ctx.fillRect(Math.round(timeToX(t, w)), 0, 1, h);
    }
  }

  ctx.fillStyle = COL_CENTER;
  ctx.fillRect(0, Math.round(centerY), w, 1);

  ctx.fillStyle = regionFill;
  ctx.fillRect(startX, 0, endX - startX, h);

  const peakStart = Math.max(0, Math.floor((editor.viewStart / duration) * peaks.length));
  const peakEnd   = Math.min(peaks.length, Math.ceil((editor.viewEnd / duration) * peaks.length));
  const barW = Math.max(1, w / (peakEnd - peakStart));

  // Batch fillRect calls by color so the canvas doesn't churn fillStyle.
  ctx.fillStyle = COL_MUTED;
  for (let i = peakStart; i < peakEnd; i++) {
    const peakTime = (i / peaks.length) * duration;
    if (peakTime >= loopStart && peakTime <= loopEnd) continue;
    const x = timeToX(peakTime, w);
    const barH = peaks[i] * centerY * 0.9;
    ctx.fillRect(x, centerY - barH, barW, barH * 2);
  }
  ctx.fillStyle = loopColor;
  for (let i = peakStart; i < peakEnd; i++) {
    const peakTime = (i / peaks.length) * duration;
    if (peakTime < loopStart || peakTime > loopEnd) continue;
    const x = timeToX(peakTime, w);
    const barH = peaks[i] * centerY * 0.9;
    ctx.fillRect(x, centerY - barH, barW, barH * 2);
  }

  ctx.fillStyle = handleFill;
  if (loopStart >= editor.viewStart && loopStart <= editor.viewEnd) {
    ctx.fillRect(startX - 1, 0, 2, h);
    ctx.fillRect(startX - 4, 0, 8, 3);
    ctx.fillRect(startX - 4, h - 3, 8, 3);
  }
  if (loopEnd >= editor.viewStart && loopEnd <= editor.viewEnd) {
    ctx.fillRect(endX - 1, 0, 2, h);
    ctx.fillRect(endX - 4, 0, 8, 3);
    ctx.fillRect(endX - 4, h - 3, 8, 3);
  }
}

function paintMinimapCache(peaks: Float32Array, loopStart: number, loopEnd: number, duration: number, isPlaying: boolean, mw: number, mh: number, dpr: number): void {
  ensureMinimapDOM();
  const cv = mmCache ?? (mmCache = document.createElement('canvas'));
  const physW = Math.round(mw * dpr);
  const physH = Math.round(mh * dpr);
  if (cv.width !== physW || cv.height !== physH) {
    cv.width = physW;
    cv.height = physH;
  }
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, mw, mh);

  const centerY = mh / 2;
  const barW = Math.max(0.5, mw / peaks.length);
  const inLoopColor = isPlaying ? COL_MM_LOOP_PLAY : COL_MM_LOOP;

  // Same color-batching trick as the main canvas.
  ctx.fillStyle = COL_MM_IDLE;
  for (let i = 0; i < peaks.length; i++) {
    const t = (i / peaks.length) * duration;
    if (t >= loopStart && t <= loopEnd) continue;
    const x = (i / peaks.length) * mw;
    const barH = peaks[i] * centerY * 0.85;
    ctx.fillRect(x, centerY - barH, barW, barH * 2);
  }
  ctx.fillStyle = inLoopColor;
  for (let i = 0; i < peaks.length; i++) {
    const t = (i / peaks.length) * duration;
    if (t < loopStart || t > loopEnd) continue;
    const x = (i / peaks.length) * mw;
    const barH = peaks[i] * centerY * 0.85;
    ctx.fillRect(x, centerY - barH, barW, barH * 2);
  }
}

function drawWaveform(peaks: Float32Array, loopStart: number, loopEnd: number, duration: number, playheadPos: number): void {
  const dpr = window.devicePixelRatio || 1;
  const w = waveformCanvas.clientWidth;
  const h = waveformCanvas.clientHeight;

  const isPlaying = !!editor.tileId && tiles.get(editor.tileId)?.state === 'playing';

  if (w !== lastCanvasW || h !== lastCanvasH) {
    waveformCanvas.width = Math.round(w * dpr);
    waveformCanvas.height = Math.round(h * dpr);
    lastCanvasW = w;
    lastCanvasH = h;
  }

  waveformPanel.dataset.playing = isPlaying ? 'true' : 'false';

  // Static-cache key: anything that affects the static layer goes in here.
  // String compare is microseconds; reproducing the layer is milliseconds.
  const mainKey = `${w}|${h}|${dpr}|${editor.viewStart}|${editor.viewEnd}|${loopStart}|${loopEnd}|${isPlaying}|${snap.interval}|${snap.offset}|${duration}`;
  if (mainKey !== mainCacheKey || mainCachePeaks !== peaks) {
    paintMainCache(peaks, loopStart, loopEnd, duration, isPlaying, w, h, dpr);
    mainCacheKey = mainKey;
    mainCachePeaks = peaks;
  }

  // Blit cached static layer at physical pixel size, then switch back to
  // logical pixels for the playhead.
  waveformCtx.setTransform(1, 0, 0, 1, 0, 0);
  waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
  waveformCtx.drawImage(mainCache!, 0, 0);

  if (playheadPos >= editor.viewStart && playheadPos <= editor.viewEnd) {
    waveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    waveformCtx.fillStyle = COL_PLAYHEAD;
    waveformCtx.fillRect(Math.round(timeToX(playheadPos, w)), 0, 1, h);
  }

  updateMinimap(peaks, loopStart, loopEnd, duration, isPlaying, playheadPos, dpr);
}

function updateMinimap(peaks: Float32Array, loopStart: number, loopEnd: number, duration: number, isPlaying: boolean, playheadPos: number, dpr: number): void {
  ensureMinimapDOM();
  const mw = waveformMinimap.clientWidth;
  const mh = waveformMinimap.clientHeight;

  const mmKey = `${mw}|${mh}|${dpr}|${loopStart}|${loopEnd}|${duration}|${isPlaying}`;
  if (mmKey !== mmCacheKey || mmCachePeaks !== peaks) {
    paintMinimapCache(peaks, loopStart, loopEnd, duration, isPlaying, mw, mh, dpr);
    mmCacheKey = mmKey;
    mmCachePeaks = peaks;
    // Resize and blit onto the visible minimap canvas.
    const cv = mmCanvasEl!;
    const physW = Math.round(mw * dpr);
    const physH = Math.round(mh * dpr);
    if (cv.width !== physW || cv.height !== physH) {
      cv.width = physW;
      cv.height = physH;
    }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(mmCache!, 0, 0);
  }

  // Viewport rectangle — transform only, no repaint.
  const viewStartPct = (editor.viewStart / duration) * 100;
  const viewWidthPct = ((editor.viewEnd - editor.viewStart) / duration) * 100;
  mmViewportEl!.style.left = `${viewStartPct}%`;
  mmViewportEl!.style.width = `${viewWidthPct}%`;

  // Playhead — pure transform, GPU composited.
  if (playheadPos >= 0 && duration > 0) {
    mmPlayheadEl!.style.opacity = '1';
    mmPlayheadEl!.style.transform = `translateX(${(playheadPos / duration) * mw}px)`;
  } else {
    mmPlayheadEl!.style.opacity = '0';
  }
}

function resetCaches(): void {
  mainCacheKey = '';
  mainCachePeaks = null;
  mmCacheKey = '';
  mmCachePeaks = null;
}

// Peak buckets per non-chunked source. 2000 covers any plausible canvas
// width (Retina up to ~1000 CSS px) without visible aliasing. We compute
// once per source, not per resize event — the old per-resize recomputation
// allocated tens of MB and burned 100ms+ on every window-resize frame.
const PEAK_BUCKETS = 2000;

function ensureSourcePeaks(source: Source): Float32Array | null {
  if (source.peaks) return source.peaks;
  if (!source.audioBuffer) return null;
  source.peaks = computePeaks(source.audioBuffer, PEAK_BUCKETS);
  return source.peaks;
}

export function resizeWaveformCanvas(): void {
  if (!editor.tileId) return;
  const tile = tiles.get(editor.tileId);
  if (!tile) return;
  const source = getSource(tile);
  if (!source?.audioReady) return;

  const w = waveformCanvas.clientWidth;
  if (w < 10) return;

  const peaks = ensureSourcePeaks(source);
  if (!peaks) return;
  editor.cachedPeaks = peaks;
  lastCanvasW = 0;
}

function updateWaveformTimes(tile: Tile): void {
  waveformTimeStart.textContent = formatTimePrecise(tile.loopStart);
  waveformTimeEnd.textContent = formatTimePrecise(tile.loopEnd);
}

export function openWaveformEditor(tileId: string): void {
  const tile = tiles.get(tileId);
  if (!tile) return;
  const source = getSource(tile);
  if (!source?.audioReady) return;

  if (editor.tileId) {
    const prev = tiles.get(editor.tileId);
    prev?.els.tile.classList.remove('editing');
  }

  editor.tileId = tileId;
  tile.els.tile.classList.add('editing');

  editor.viewStart = 0;
  editor.viewEnd = source.duration;

  // Different source → invalidate offscreen caches so the first frame
  // redraws cleanly into the new dimensions.
  resetCaches();
  lastCanvasW = 0;
  lastCanvasH = 0;

  waveformTitleEl.textContent = source.title;
  waveformAddressEl.textContent = padAddress(tile.row ?? 0, tile.col ?? 0);
  updateWaveformTimes(tile);
  loadTileIntoEditor(tile);
  resetActivePage();

  waveformPanel.classList.add('open');
  document.body.classList.add('waveform-open');

  void waveformPanel.offsetHeight; // force layout
  setupWaveformDrag();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      resizeWaveformCanvas();
      startWaveformAnimation();
    });
  });
}

export function closeWaveformEditor(): void {
  if (editor.tileId) {
    const tile = tiles.get(editor.tileId);
    tile?.els.tile.classList.remove('editing');
  }
  editor.tileId = null;
  editor.cachedPeaks = null;
  waveformPanel.classList.remove('open');
  document.body.classList.remove('waveform-open');
  if (editor.animId) {
    cancelAnimationFrame(editor.animId);
    editor.animId = null;
  }
  if (editor.dragCleanup) {
    editor.dragCleanup();
    editor.dragCleanup = null;
  }
}

function startWaveformAnimation(): void {
  if (editor.animId) cancelAnimationFrame(editor.animId);

  const tick = () => {
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    if (!tile) { closeWaveformEditor(); return; }
    const source = getSource(tile);
    if (!source || !editor.cachedPeaks) return;

    let pos = -1;
    if (tile.state === 'playing') {
      pos = source.audioReady ? getAudioPosition(tile) : (tile.video?.currentTime ?? tile.loopStart);
    }

    if (pos >= 0) {
      const viewDur = editor.viewEnd - editor.viewStart;
      if (viewDur < source.duration) {
        const margin = viewDur * 0.15;
        if (pos > editor.viewEnd - margin) {
          editor.viewStart = pos - viewDur + margin;
          editor.viewEnd = editor.viewStart + viewDur;
          if (editor.viewEnd > source.duration) {
            editor.viewEnd = source.duration;
            editor.viewStart = editor.viewEnd - viewDur;
          }
        } else if (pos < editor.viewStart + margin) {
          editor.viewStart = pos - margin;
          editor.viewEnd = editor.viewStart + viewDur;
          if (editor.viewStart < 0) { editor.viewStart = 0; editor.viewEnd = viewDur; }
        }
      }
    }

    // Skip the redraw when the Sample page isn't visible — its canvas has
    // zero dimensions and the work would be wasted. The animation loop keeps
    // ticking so view-tracking math above stays current.
    if (getActivePage() === 'sample') {
      drawWaveform(editor.cachedPeaks, tile.loopStart, tile.loopEnd, source.duration, pos);
    }
    editor.animId = requestAnimationFrame(tick);
  };
  editor.animId = requestAnimationFrame(tick);
}

function setupWaveformDrag(): void {
  if (editor.dragCleanup) editor.dragCleanup();

  const HANDLE_HIT = 10;

  const onPointerDown = (e: PointerEvent) => {
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    if (!tile) return;
    const source = getSource(tile);
    if (!source) return;

    e.preventDefault();
    try { waveformCanvas.setPointerCapture(e.pointerId); } catch {}

    const rect = waveformCanvas.getBoundingClientRect();
    const toTime = (clientX: number) => {
      const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
      return editor.viewStart + (x / rect.width) * (editor.viewEnd - editor.viewStart);
    };
    const sn = (t: number) => snapTime(t, snap.interval);

    const clickTime = toTime(e.clientX);
    const startPx = timeToX(tile.loopStart, rect.width);
    const endPx = timeToX(tile.loopEnd, rect.width);
    const px = e.clientX - rect.left;

    let mode: 'start' | 'end' | 'region' | 'select';
    let regionOffset = 0;
    let regionLen = 0;
    let selectAnchor = 0;

    if (Math.abs(px - startPx) < HANDLE_HIT) {
      mode = 'start';
    } else if (Math.abs(px - endPx) < HANDLE_HIT) {
      mode = 'end';
    } else if (px > startPx + HANDLE_HIT && px < endPx - HANDLE_HIT) {
      mode = 'region';
      regionOffset = clickTime - tile.loopStart;
      regionLen = tile.loopEnd - tile.loopStart;
    } else {
      mode = 'select';
      selectAnchor = sn(clickTime);
      tile.loopStart = selectAnchor;
      tile.loopEnd = Math.min(selectAnchor + 0.5, source.duration);
    }

    const onMove = (ev: PointerEvent) => {
      const rawTime = toTime(ev.clientX);

      if (mode === 'select') {
        const t = sn(rawTime);
        tile.loopStart = Math.max(0, Math.min(selectAnchor, t));
        tile.loopEnd = Math.min(source.duration, Math.max(selectAnchor, t));
        if (tile.loopEnd - tile.loopStart < 0.1) {
          tile.loopEnd = Math.min(tile.loopStart + 0.5, source.duration);
        }
      } else if (mode === 'region') {
        let newStart = sn(rawTime - regionOffset);
        newStart = Math.max(0, Math.min(newStart, source.duration - regionLen));
        tile.loopStart = newStart;
        tile.loopEnd = newStart + regionLen;
      } else {
        const t = sn(rawTime);
        if (mode === 'start') {
          tile.loopStart = Math.max(0, Math.min(t, tile.loopEnd - 0.1));
        } else {
          tile.loopEnd = Math.min(source.duration, Math.max(t, tile.loopStart + 0.1));
        }
      }

      updateAudioLoopPoints(tile);
      updateTileLoopIndicator(tile);
      updateWaveformTimes(tile);
    };

    const onUp = () => {
      waveformCanvas.removeEventListener('pointermove', onMove);
      waveformCanvas.removeEventListener('pointerup', onUp);
      saveManifest();
    };

    waveformCanvas.addEventListener('pointermove', onMove);
    waveformCanvas.addEventListener('pointerup', onUp);
  };

  const clampView = (dur: number) => {
    if (editor.viewStart < 0) { editor.viewEnd -= editor.viewStart; editor.viewStart = 0; }
    if (editor.viewEnd > dur) { editor.viewStart -= (editor.viewEnd - dur); editor.viewEnd = dur; }
    editor.viewStart = Math.max(0, editor.viewStart);
    editor.viewEnd = Math.min(dur, editor.viewEnd);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    if (!tile) return;
    const source = getSource(tile);
    if (!source) return;

    const rect = waveformCanvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseFrac = mouseX / rect.width;
    const viewDur = editor.viewEnd - editor.viewStart;

    if (e.ctrlKey || (!e.shiftKey && e.deltaX === 0)) {
      const mouseTime = editor.viewStart + mouseFrac * viewDur;
      const zoomFactor = e.ctrlKey
        ? (1 + Math.abs(e.deltaY) * 0.01) ** (e.deltaY > 0 ? 1 : -1)
        : (e.deltaY > 0 ? 1.2 : 1 / 1.2);
      let newDur = viewDur * zoomFactor;
      newDur = Math.max(0.5, Math.min(newDur, source.duration));
      editor.viewStart = mouseTime - mouseFrac * newDur;
      editor.viewEnd = mouseTime + (1 - mouseFrac) * newDur;
    } else {
      const panAmount = (e.deltaX || e.deltaY) * (viewDur / rect.width);
      editor.viewStart += panAmount;
      editor.viewEnd += panAmount;
    }

    clampView(source.duration);
  };

  const onMinimapDown = (e: PointerEvent) => {
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    if (!tile) return;
    const source = getSource(tile);
    if (!source) return;

    e.preventDefault();
    const rect = waveformMinimap.getBoundingClientRect();
    const viewDur = editor.viewEnd - editor.viewStart;

    const panTo = (clientX: number) => {
      const frac = (clientX - rect.left) / rect.width;
      const centerTime = frac * source.duration;
      editor.viewStart = Math.max(0, Math.min(centerTime - viewDur / 2, source.duration - viewDur));
      editor.viewEnd = editor.viewStart + viewDur;
    };

    panTo(e.clientX);

    const onMove = (ev: PointerEvent) => panTo(ev.clientX);
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  waveformCanvas.addEventListener('pointerdown', onPointerDown);
  waveformCanvas.addEventListener('wheel', onWheel, { passive: false });
  waveformMinimap.addEventListener('pointerdown', onMinimapDown);

  editor.dragCleanup = () => {
    waveformCanvas.removeEventListener('pointerdown', onPointerDown);
    waveformCanvas.removeEventListener('wheel', onWheel);
    waveformMinimap.removeEventListener('pointerdown', onMinimapDown);
  };
}

export function bindWaveform(): void {
  new ResizeObserver(() => {
    if (editor.tileId) resizeWaveformCanvas();
  }).observe(waveformCanvas);

  waveformPanel.addEventListener('transitionend', () => {
    if (editor.tileId) resizeWaveformCanvas();
  });

  waveformCloseBtn.addEventListener('click', closeWaveformEditor);

  waveformFitBtn.addEventListener('click', () => {
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    if (!tile) return;
    const source = getSource(tile);
    if (!source) return;
    editor.viewStart = 0;
    editor.viewEnd = source.duration;
  });
}

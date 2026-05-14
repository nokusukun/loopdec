import type { Tile } from './types';
import { tiles, getSource } from './state';
import {
  waveformPanel, waveformCanvas, waveformCtx, waveformTitleEl, waveformAddressEl,
  waveformTimeStart, waveformTimeEnd, waveformCloseBtn, waveformFitBtn, waveformMinimap,
} from './dom';
import { padAddress } from './grid';
import { editor, snap, snapTime } from './editor-state';
import { getAudioPosition, updateAudioLoopPoints } from './audio-engine';
import { updateTileLoopIndicator } from './tile-display';
import { saveManifest } from './manifest';
import { formatTimePrecise } from './utils';

let lastCanvasW = 0;
let lastCanvasH = 0;

function computePeaks(audioBuffer: AudioBuffer, numBuckets: number): Float32Array {
  const channel = audioBuffer.getChannelData(0);
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

function drawWaveform(peaks: Float32Array, loopStart: number, loopEnd: number, duration: number, playheadPos: number): void {
  const dpr = window.devicePixelRatio || 1;
  const w = waveformCanvas.clientWidth;
  const h = waveformCanvas.clientHeight;

  if (w !== lastCanvasW || h !== lastCanvasH) {
    waveformCanvas.width = w * dpr;
    waveformCanvas.height = h * dpr;
    lastCanvasW = w;
    lastCanvasH = h;
  }
  waveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const centerY = h / 2;

  const mutedColor = 'rgba(98, 92, 80, 0.30)';
  const activeColor = 'rgba(225, 180, 85, 0.85)';
  const playingActiveColor = 'rgba(110, 195, 130, 0.88)';
  const regionBg = 'rgba(225, 180, 85, 0.06)';
  const regionBgPlay = 'rgba(110, 195, 130, 0.08)';
  const handleColor = 'rgb(225, 180, 85)';
  const handleColorPlay = 'rgb(120, 205, 140)';
  const playheadColor = 'rgb(232, 226, 218)';
  const gridColor = 'rgba(225, 180, 85, 0.07)';
  const centerLineColor = 'rgba(98, 92, 80, 0.4)';

  const isPlaying = !!editor.tileId && tiles.get(editor.tileId)?.state === 'playing';
  const loopColor = isPlaying ? playingActiveColor : activeColor;
  const regionFill = isPlaying ? regionBgPlay : regionBg;
  const handleFill = isPlaying ? handleColorPlay : handleColor;

  waveformPanel.dataset.playing = isPlaying ? 'true' : 'false';

  waveformCtx.clearRect(0, 0, w, h);

  const startX = timeToX(loopStart, w);
  const endX = timeToX(loopEnd, w);

  if (snap.interval > 0) {
    waveformCtx.fillStyle = gridColor;
    const firstGrid = Math.ceil((editor.viewStart - snap.offset) / snap.interval) * snap.interval + snap.offset;
    for (let t = firstGrid; t <= editor.viewEnd; t += snap.interval) {
      const gx = timeToX(t, w);
      waveformCtx.fillRect(Math.round(gx), 0, 1, h);
    }
  }

  waveformCtx.fillStyle = centerLineColor;
  waveformCtx.fillRect(0, Math.round(centerY), w, 1);

  waveformCtx.fillStyle = regionFill;
  waveformCtx.fillRect(startX, 0, endX - startX, h);

  const peakStart = Math.max(0, Math.floor((editor.viewStart / duration) * peaks.length));
  const peakEnd = Math.min(peaks.length, Math.ceil((editor.viewEnd / duration) * peaks.length));
  const barW = Math.max(1, w / (peakEnd - peakStart));

  for (let i = peakStart; i < peakEnd; i++) {
    const peakTime = (i / peaks.length) * duration;
    const x = timeToX(peakTime, w);
    const barH = peaks[i] * centerY * 0.9;
    const inLoop = peakTime >= loopStart && peakTime <= loopEnd;
    waveformCtx.fillStyle = inLoop ? loopColor : mutedColor;
    waveformCtx.fillRect(x, centerY - barH, barW, barH * 2);
  }

  waveformCtx.fillStyle = handleFill;
  if (loopStart >= editor.viewStart && loopStart <= editor.viewEnd) {
    waveformCtx.fillRect(startX - 1, 0, 2, h);
    waveformCtx.fillRect(startX - 4, 0, 8, 3);
    waveformCtx.fillRect(startX - 4, h - 3, 8, 3);
  }
  if (loopEnd >= editor.viewStart && loopEnd <= editor.viewEnd) {
    waveformCtx.fillRect(endX - 1, 0, 2, h);
    waveformCtx.fillRect(endX - 4, 0, 8, 3);
    waveformCtx.fillRect(endX - 4, h - 3, 8, 3);
  }

  if (playheadPos >= editor.viewStart && playheadPos <= editor.viewEnd) {
    const px = timeToX(playheadPos, w);
    waveformCtx.fillStyle = playheadColor;
    waveformCtx.fillRect(Math.round(px), 0, 1, h);
  }

  drawMinimap(peaks, loopStart, loopEnd, duration, playheadPos);
}

function drawMinimap(peaks: Float32Array, loopStart: number, loopEnd: number, duration: number, playheadPos: number): void {
  const dpr = window.devicePixelRatio || 1;
  let mmCanvas = waveformMinimap.querySelector('canvas');
  if (!mmCanvas) {
    mmCanvas = document.createElement('canvas');
    waveformMinimap.appendChild(mmCanvas);
  }

  let vp = waveformMinimap.querySelector<HTMLElement>('.minimap-viewport');
  if (!vp) {
    vp = document.createElement('div');
    vp.className = 'minimap-viewport';
    waveformMinimap.appendChild(vp);
  }

  const mw = waveformMinimap.clientWidth;
  const mh = waveformMinimap.clientHeight;
  mmCanvas.width = mw * dpr;
  mmCanvas.height = mh * dpr;
  const mmCtx = mmCanvas.getContext('2d')!;
  mmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mmCtx.clearRect(0, 0, mw, mh);

  const centerY = mh / 2;
  const barW = Math.max(0.5, mw / peaks.length);
  const isPlaying = !!editor.tileId && tiles.get(editor.tileId)?.state === 'playing';
  const inLoopColor = isPlaying ? 'rgba(110, 195, 130, 0.65)' : 'rgba(225, 180, 85, 0.55)';

  for (let i = 0; i < peaks.length; i++) {
    const x = (i / peaks.length) * mw;
    const barH = peaks[i] * centerY * 0.85;
    const t = (i / peaks.length) * duration;
    const inLoop = t >= loopStart && t <= loopEnd;
    mmCtx.fillStyle = inLoop ? inLoopColor : 'rgba(98, 92, 80, 0.28)';
    mmCtx.fillRect(x, centerY - barH, barW, barH * 2);
  }

  if (playheadPos >= 0) {
    const px = (playheadPos / duration) * mw;
    mmCtx.fillStyle = 'rgb(232, 226, 218)';
    mmCtx.fillRect(px, 0, 1, mh);
  }

  const vpLeft = (editor.viewStart / duration) * 100;
  const vpWidth = ((editor.viewEnd - editor.viewStart) / duration) * 100;
  vp.style.left = `${vpLeft}%`;
  vp.style.width = `${vpWidth}%`;
}

export function resizeWaveformCanvas(): void {
  if (!editor.tileId) return;
  const tile = tiles.get(editor.tileId);
  if (!tile) return;
  const source = getSource(tile);
  if (!source?.audioReady) return;

  const w = waveformCanvas.clientWidth;
  if (w < 10) return;

  if (source.chunked && source.peaks) {
    editor.cachedPeaks = source.peaks;
  } else if (source.audioBuffer) {
    const numBuckets = Math.max(200, Math.min(w * 2, 2000));
    editor.cachedPeaks = computePeaks(source.audioBuffer, numBuckets);
  } else {
    return;
  }
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

  waveformTitleEl.textContent = source.title;
  waveformAddressEl.textContent = padAddress(tile.row ?? 0, tile.col ?? 0);
  updateWaveformTimes(tile);

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

    drawWaveform(editor.cachedPeaks, tile.loopStart, tile.loopEnd, source.duration, pos);
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

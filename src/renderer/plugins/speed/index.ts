// Per-tile playback speed with optional pitch-lock (time-stretched).
//
//   state          { speed: number, pitchLock: boolean }
//   audio          source.playbackRate = speed (pitched)  OR
//                  pre-stretched loop buffer + playbackRate = 1.0 (pitch-locked)
//   video          tile.video.playbackRate = speed (always)
//   UI             slider + numeric readout (editable on dblclick) + HOLD toggle
//
// Speed is fundamental to playback math, so this plugin also exports
// getSpeed/getPitchLock for audio-engine to consume.

import './speed.css';

import type { Tile } from '../../types';
import { tiles } from '../../state';
import { editor } from '../../editor-state';
import { saveManifest } from '../../persistence/manifest';
import { bindSliderDrag } from '../../ui/drag';
import { getAudioCtx } from '../../audio/context';
import { applyTileSpeedDisplay } from '../../ui/tile-display';
import { registerPlugin } from '../registry';
import type { TilePlugin, PlayContext } from '../types';
import { stretchAudioBufferProgressive } from './time-stretch';

interface SpeedState {
  speed: number;
  pitchLock: boolean;
}

const SPEED_MIN = 0.5;
const SPEED_MAX = 2.0;
const SPEED_STEP = 0.05;
const SPEED_DEAD_ZONE = 0.03;
const PITCHLOCK_DEBOUNCE_MS = 180;

// Per-tile debounce handle for pitch-lock rebuilds. Per-tile so concurrent
// edits on multiple tiles don't cancel each other's rebuild.
const rebuildTimers = new WeakMap<Tile, ReturnType<typeof setTimeout>>();

// Pre-stretched loop buffer cache. onPlay consults this; if it doesn't match
// the tile's current source/loop/speed, audio plays pitched (no pitch lock)
// while the worker computes a fresh stretch off the main thread.
interface StretchCacheEntry {
  buffer: AudioBuffer;
  speed: number;
  loopStart: number;  // source-time
  loopEnd: number;    // source-time
  sourceId: string;
}
const stretchCache = new WeakMap<Tile, StretchCacheEntry>();

// Monotonic per-tile job id so late worker results from a superseded request
// are silently discarded.
const stretchJobIds = new WeakMap<Tile, number>();
let nextStretchJobId = 1;

// How many stretches are currently in flight for each tile. Drives the
// "computing" state on the HOLD button so the user knows the pitch swap
// is queued rather than ignored.
const inFlight = new WeakMap<Tile, number>();
function setInFlight(tile: Tile, delta: number): void {
  const prev = inFlight.get(tile) ?? 0;
  const next = Math.max(0, prev + delta);
  if (next === 0) inFlight.delete(tile);
  else inFlight.set(tile, next);
  if (lockBtn && editor.tileId === tile.id) {
    lockBtn.dataset.busy = next > 0 ? 'true' : 'false';
  }
  console.info('[hold] setInFlight', { tile: tile.id, delta, prev, next });
}

function cacheMatches(c: StretchCacheEntry | undefined, tile: Tile, speed: number): boolean {
  if (!c) return false;
  return c.speed === speed
    && c.sourceId === tile.sourceId
    && Math.abs(c.loopStart - tile.loopStart) < 1e-6
    && Math.abs(c.loopEnd - tile.loopEnd) < 1e-6;
}

// ── State accessors (used by audio-engine) ──────────────────────────

function state(tile: Tile): SpeedState {
  return tile.plugins.speed as SpeedState;
}

export function getSpeed(tile: Tile): number {
  return (tile.plugins.speed as SpeedState | undefined)?.speed ?? 1;
}

export function getPitchLock(tile: Tile): boolean {
  return (tile.plugins.speed as SpeedState | undefined)?.pitchLock ?? false;
}

// Mount a pre-stretched buffer into the play context: BufferSource will run
// at unity rate, the source-time → buffer-time mapping is divided by speed.
function mountStretched(ctx: PlayContext, buffer: AudioBuffer, speed: number): void {
  ctx.startOffset = Math.max(0, (ctx.startOffset - ctx.loopStart) / speed);
  ctx.buffer = buffer;
  ctx.loopStart = 0;
  ctx.loopEnd = buffer.duration;
}

function sliceLoopRegion(ctx: BaseAudioContext, buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const start = Math.max(0, Math.floor(startSec * buffer.sampleRate));
  const end = Math.min(buffer.length, Math.floor(endSec * buffer.sampleRate));
  const length = Math.max(1, end - start);
  const slice = ctx.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
  // copyFromChannel/copyToChannel lets engines avoid exposing the underlying
  // storage as a JS-visible Float32Array.
  const tmp = new Float32Array(length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    buffer.copyFromChannel(tmp, ch, start);
    slice.copyToChannel(tmp, ch, 0);
  }
  return slice;
}

// Watchdog ceiling for progressive stretches. The underlying chunks may
// still resolve after this fires; we just stop showing the busy state so
// the user isn't stranded.
const STRETCH_TIMEOUT_MS = 60_000;

function debug(label: string, payload: Record<string, unknown> = {}): void {
  console.info(`[hold] ${label}`, payload);
}

// Mount the in-progress stretched buffer on this play context immediately
// and dispatch chunks in the background. The BufferSourceNode reads from
// the same memory the workers write into — wherever a chunk has landed,
// audio plays; gaps are momentarily silent until the worker pool catches
// up. The cache is populated synchronously so a subsequent play before
// every chunk lands still re-uses the partially-filled buffer.
function beginProgressiveStretch(
  tile: Tile,
  ctx: PlayContext,
  region: AudioBuffer,
  speed: number,
): { buffer: AudioBuffer } {
  const myJobId = ++nextStretchJobId;
  stretchJobIds.set(tile, myJobId);

  const priorityOffset = Math.max(
    0,
    Math.floor(((ctx.startOffset - ctx.loopStart) / speed) * region.sampleRate),
  );

  const { buffer, done, chunkCount } = stretchAudioBufferProgressive(
    ctx.audioCtx, region, speed, priorityOffset,
  );

  stretchCache.set(tile, {
    buffer, speed,
    loopStart: tile.loopStart, loopEnd: tile.loopEnd,
    sourceId: tile.sourceId,
  });

  debug('progressive stretch started', {
    jobId: myJobId, tile: tile.id, speed,
    regionSamples: region.length, outSamples: buffer.length, chunks: chunkCount,
    priorityOffset,
  });

  setInFlight(tile, +1);
  const startedAt = performance.now();

  let settled = false;
  const watchdog = window.setTimeout(() => {
    if (settled) return;
    settled = true;
    console.warn('[hold] progressive watchdog fired — not all chunks landed in time', {
      jobId: myJobId, tile: tile.id, speed, timeoutMs: STRETCH_TIMEOUT_MS,
    });
    setInFlight(tile, -1);
  }, STRETCH_TIMEOUT_MS);

  done.then(() => {
    const elapsedMs = (performance.now() - startedAt) | 0;
    debug('progressive stretch fully written', { jobId: myJobId, elapsedMs, chunks: chunkCount });
  }).catch((err) => {
    console.warn('[hold] progressive stretch errored', { jobId: myJobId, err });
  }).finally(() => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    setInFlight(tile, -1);
  });

  return { buffer };
}

// ── Live updates from UI / palette ────────────────────────────────────

// Called by audio-engine on slider drag / typed override. Rebases position
// across the rate change in pitched mode; debounces a rebuild in pitch-lock
// mode (stretch is expensive so we don't run it per frame).
export function setTileSpeed(tile: Tile, speed: number): void {
  // Need playAudio for the rebuild path; import lazily to break the cycle.
  void import('../../audio/engine').then(({ getAudioPosition, playAudio }) => {
    const s = state(tile);
    if (speed === s.speed) return;

    if (s.pitchLock) {
      const pos = tile.audioSource ? getAudioPosition(tile) : tile.loopStart;
      s.speed = speed;
      if (tile.video) tile.video.playbackRate = speed;
      applyTileSpeedDisplay(tile);

      const prev = rebuildTimers.get(tile);
      if (prev) clearTimeout(prev);
      const timer = setTimeout(() => {
        rebuildTimers.delete(tile);
        if (state(tile).pitchLock && tile.audioSource) playAudio(tile, pos);
      }, PITCHLOCK_DEBOUNCE_MS);
      rebuildTimers.set(tile, timer);
      return;
    }

    // Pitched: change BufferSource.playbackRate in place. Cheap, no rebuild.
    if (tile.audioSource) {
      const pos = getAudioPosition(tile);
      tile.audioStartedOffset = pos;
      tile.audioStartedAt = getAudioCtx().currentTime;
      tile.audioSource.playbackRate.value = speed;
    }
    s.speed = speed;
    if (tile.video) tile.video.playbackRate = speed;
    applyTileSpeedDisplay(tile);
  });
}

export function setTilePitchLock(tile: Tile, locked: boolean): void {
  const s = state(tile);
  if (s.pitchLock === locked) return;
  debug('setTilePitchLock', { tile: tile.id, from: s.pitchLock, to: locked, speed: s.speed, playing: !!tile.audioSource });
  s.pitchLock = locked;
  if (tile.audioSource) {
    void import('../../audio/engine').then(({ getAudioPosition, playAudio }) => {
      const pos = getAudioPosition(tile);
      playAudio(tile, pos);
    });
  }
}

// ── UI ────────────────────────────────────────────────────────────────

let panel: HTMLElement | null = null;
let track: HTMLElement | null = null;
let readoutEl: HTMLElement | null = null;
let lockBtn: HTMLButtonElement | null = null;
let thumb: HTMLElement | null = null;

function speedToFrac(speed: number): number {
  return (Math.log2(speed) + 1) / 2;
}
function fracToSpeed(frac: number): number {
  return Math.pow(2, 2 * Math.max(0, Math.min(1, frac)) - 1);
}
function snapSliderSpeed(speed: number): number {
  const clamped = Math.max(SPEED_MIN, Math.min(SPEED_MAX, speed));
  if (Math.abs(clamped - 1) < SPEED_DEAD_ZONE) return 1.0;
  return Math.round(clamped / SPEED_STEP) * SPEED_STEP;
}

function formatSpeed(s: number): string { return `${s.toFixed(2)}×`; }

function paint(speed: number): void {
  if (!thumb || !readoutEl || !panel) return;
  // Visual thumb pins to slider's range; typed values outside still apply.
  const frac = Math.max(0, Math.min(1, speedToFrac(speed)));
  thumb.style.left = `${frac * 100}%`;
  readoutEl.textContent = formatSpeed(speed);
  panel.dataset.active = Math.abs(speed - 1) < 0.001 ? 'false' : 'true';
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
  const r = readoutEl;

  const startEdit = () => {
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    if (!tile) return;
    r.textContent = state(tile).speed.toFixed(2);
    r.setAttribute('contenteditable', 'true');
    r.focus();
    selectAll(r);
  };

  const endEdit = (commit: boolean) => {
    if (r.getAttribute('contenteditable') !== 'true') return;
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    let next = tile ? state(tile).speed : 1;

    if (commit && tile) {
      const raw = (r.textContent ?? '').replace(/[×x\s]/gi, '');
      const parsed = parseFloat(raw);
      if (isFinite(parsed) && parsed > 0) {
        next = parsed;
        setTileSpeed(tile, next);
        saveManifest();
      }
    }
    r.removeAttribute('contenteditable');
    r.blur();
    paint(next);
  };

  r.addEventListener('dblclick', (e) => { e.preventDefault(); startEdit(); });
  r.addEventListener('keydown', (e) => {
    if (r.getAttribute('contenteditable') !== 'true') return;
    if (e.key === 'Enter') { e.preventDefault(); endEdit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); endEdit(false); }
    e.stopPropagation();
  });
  r.addEventListener('blur', () => endEdit(true));
}

// ── Plugin definition ────────────────────────────────────────────────

const plugin: TilePlugin = {
  id: 'speed',

  bind() {
    panel = document.getElementById('speed-panel');
    track = document.getElementById('speed-track');
    readoutEl = document.getElementById('speed-readout');
    lockBtn = document.getElementById('speed-lock') as HTMLButtonElement | null;
    thumb = track?.querySelector<HTMLElement>('.speed-thumb') ?? null;

    if (track && panel) {
      const t = track;
      const p = panel;
      bindSliderDrag(t, {
        start: () => {
          const tile = editor.tileId ? tiles.get(editor.tileId) : null;
          if (!tile) return false;
          p.dataset.state = 'dragging';
        },
        move: (x, _y, rect) => {
          const tile = editor.tileId ? tiles.get(editor.tileId) : null;
          if (!tile) return;
          const frac = (x - rect.left) / rect.width;
          const s = snapSliderSpeed(fracToSpeed(frac));
          setTileSpeed(tile, s);
          paint(s);
        },
        end: () => {
          p.dataset.state = '';
          saveManifest();
        },
      });
      t.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const tile = editor.tileId ? tiles.get(editor.tileId) : null;
        if (!tile) return;
        setTileSpeed(tile, 1.0);
        paint(1.0);
        saveManifest();
      });
    }

    bindReadoutEdit();

    lockBtn?.addEventListener('click', () => {
      const tile = editor.tileId ? tiles.get(editor.tileId) : null;
      if (!tile) return;
      const next = !state(tile).pitchLock;
      setTilePitchLock(tile, next);
      lockBtn!.setAttribute('aria-pressed', String(next));
      saveManifest();
    });

    paint(1.0);
  },

  defaultState(): SpeedState {
    return { speed: 1, pitchLock: false };
  },

  serialize(s: unknown): unknown {
    const v = s as SpeedState;
    if (v.speed === 1 && !v.pitchLock) return undefined;
    return { speed: v.speed, pitchLock: v.pitchLock };
  },

  hydrate(raw: unknown): SpeedState | undefined {
    if (raw && typeof raw === 'object') {
      const r = raw as { speed?: unknown; pitchLock?: unknown };
      const speed = typeof r.speed === 'number' && isFinite(r.speed) && r.speed > 0 ? r.speed : 1;
      const pitchLock = r.pitchLock === true;
      return { speed, pitchLock };
    }
    return undefined;
  },

  loadForTile(tile: Tile): void {
    const s = state(tile);
    paint(s.speed);
    if (lockBtn) {
      lockBtn.setAttribute('aria-pressed', String(s.pitchLock));
      lockBtn.dataset.busy = (inFlight.get(tile) ?? 0) > 0 ? 'true' : 'false';
    }
  },

  onPlay(tile: Tile, ctx: PlayContext): void {
    const s = state(tile);
    const useStretch = s.pitchLock && Math.abs(s.speed - 1) > 0.001;
    if (useStretch) {
      const cached = stretchCache.get(tile);
      if (cacheMatches(cached, tile, s.speed)) {
        debug('onPlay cache HIT', { tile: tile.id, speed: s.speed });
        mountStretched(ctx, cached!.buffer, s.speed);
        ctx.source.playbackRate.value = 1.0;
      } else {
        debug('onPlay cache MISS', {
          tile: tile.id, speed: s.speed,
          hasCached: !!cached,
          cachedSpeed: cached?.speed,
          tileLoop: { start: tile.loopStart, end: tile.loopEnd },
          cachedLoop: cached ? { start: cached.loopStart, end: cached.loopEnd } : null,
        });
        // Kick off a progressive stretch and mount the partially-filled
        // buffer right now. As workers fill in chunks the buffer's contents
        // become audible in place — BufferSourceNode reads from this same
        // memory. Silent windows shrink as priority chunk lands first.
        const region = sliceLoopRegion(ctx.audioCtx, ctx.buffer, ctx.loopStart, ctx.loopEnd);
        const { buffer } = beginProgressiveStretch(tile, ctx, region, s.speed);
        mountStretched(ctx, buffer, s.speed);
        ctx.source.playbackRate.value = 1.0;
      }
    } else {
      ctx.source.playbackRate.value = s.speed;
    }
    if (tile.video) tile.video.playbackRate = s.speed;
  },

  teardownTile(tile: Tile): void {
    const t = rebuildTimers.get(tile);
    if (t) {
      clearTimeout(t);
      rebuildTimers.delete(tile);
    }
    stretchCache.delete(tile);
    stretchJobIds.delete(tile);
  },
};

registerPlugin(plugin);
export {};

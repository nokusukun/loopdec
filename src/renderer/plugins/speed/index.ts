// Per-tile speed + independent pitch.
//
//   state          { speed: number, pitch: number (semitones), link: boolean }
//   audio          F = 2^(pitch/12) / speed
//                  R = 2^(pitch/12)
//                    F ≈ 1   →  source.playbackRate = R, no stretch
//                    F  ≠ 1  →  pre-stretched buffer (by F), source.playbackRate = R
//   video          tile.video.playbackRate = speed (always — video has no pitch)
//   UI             two slider rows (RATE / PITCH) + LINK toggle. When LINK
//                  is on, the pitch slider is driven by the speed slider:
//                  pitch = 12·log2(speed). Audio takes the no-stretch path
//                  because F = 2^(pitch/12)/speed = speed/speed = 1.

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
  pitch: number;     // semitones offset from source
  link: boolean;     // true → pitch follows speed naturally (no stretch)
}

const SPEED_MIN = 0.5;
const SPEED_MAX = 2.0;
const SPEED_STEP = 0.05;
const SPEED_DEAD_ZONE = 0.03;

const PITCH_MIN = -12;
const PITCH_MAX = 12;
const PITCH_STEP = 0.5;     // half-semitone resolution
const PITCH_DEAD_ZONE = 0.25;

const REBUILD_DEBOUNCE_MS = 180;
// When |F − 1| is below this we skip time-stretching and run the cheap
// BufferSource.playbackRate path. Catches the LINK-on case (F is exactly 1
// by construction) and small float drift near it.
const STRETCH_NOOP_EPSILON = 1e-3;

// Per-tile debounce handle so a long stretch isn't kicked off on every
// slider tick. Per-tile so concurrent edits on multiple tiles don't cancel
// each other's rebuild.
const rebuildTimers = new WeakMap<Tile, ReturnType<typeof setTimeout>>();

interface StretchCacheEntry {
  buffer: AudioBuffer;
  speed: number;
  pitch: number;
  loopStart: number;
  loopEnd: number;
  sourceId: string;
}
const stretchCache = new WeakMap<Tile, StretchCacheEntry>();

const stretchJobIds = new WeakMap<Tile, number>();
let nextStretchJobId = 1;

const inFlight = new WeakMap<Tile, number>();
function setInFlight(tile: Tile, delta: number): void {
  const prev = inFlight.get(tile) ?? 0;
  const next = Math.max(0, prev + delta);
  if (next === 0) inFlight.delete(tile);
  else inFlight.set(tile, next);
  if (linkBtn && editor.tileId === tile.id) {
    linkBtn.dataset.busy = next > 0 ? 'true' : 'false';
  }
}

function cacheMatches(c: StretchCacheEntry | undefined, tile: Tile, speed: number, pitch: number): boolean {
  if (!c) return false;
  return c.speed === speed
    && c.pitch === pitch
    && c.sourceId === tile.sourceId
    && Math.abs(c.loopStart - tile.loopStart) < 1e-6
    && Math.abs(c.loopEnd - tile.loopEnd) < 1e-6;
}

// ── Math helpers ─────────────────────────────────────────────────────

function naturalPitchFor(speed: number): number {
  return 12 * Math.log2(speed);
}
function stretchFactor(speed: number, pitch: number): number {
  return Math.pow(2, pitch / 12) / speed;
}
function rateFactor(pitch: number): number {
  return Math.pow(2, pitch / 12);
}

// ── State accessors ──────────────────────────────────────────────────

function state(tile: Tile): SpeedState {
  return tile.plugins.speed as SpeedState;
}

export function getSpeed(tile: Tile): number {
  return (tile.plugins.speed as SpeedState | undefined)?.speed ?? 1;
}

// ── Audio graph helpers ──────────────────────────────────────────────

function mountStretched(ctx: PlayContext, buffer: AudioBuffer, factor: number): void {
  // ctx.startOffset is in buffer-time at this point (set up by audio-engine).
  // The stretched buffer's time is the loop-region time multiplied by F.
  ctx.startOffset = Math.max(0, (ctx.startOffset - ctx.loopStart) * factor);
  ctx.buffer = buffer;
  ctx.loopStart = 0;
  ctx.loopEnd = buffer.duration;
}

function sliceLoopRegion(ctx: BaseAudioContext, buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const start = Math.max(0, Math.floor(startSec * buffer.sampleRate));
  const end = Math.min(buffer.length, Math.floor(endSec * buffer.sampleRate));
  const length = Math.max(1, end - start);
  const slice = ctx.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
  const tmp = new Float32Array(length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    buffer.copyFromChannel(tmp, ch, start);
    slice.copyToChannel(tmp, ch, 0);
  }
  return slice;
}

const STRETCH_TIMEOUT_MS = 60_000;

function debug(label: string, payload: Record<string, unknown> = {}): void {
  console.info(`[speed] ${label}`, payload);
}

function beginProgressiveStretch(
  tile: Tile,
  ctx: PlayContext,
  region: AudioBuffer,
  speed: number,
  pitch: number,
  factor: number,
): { buffer: AudioBuffer } {
  const myJobId = ++nextStretchJobId;
  stretchJobIds.set(tile, myJobId);

  // Map current playhead (in seconds, buffer-time) → output-buffer-time so
  // the priority chunk is the one the BufferSource will read first.
  // p_in   = (ctx.startOffset - ctx.loopStart)              seconds in the loop region
  // p_out  = p_in × F                                       seconds in the stretched output
  // sample = p_out × sampleRate
  const priorityOffset = Math.max(
    0,
    Math.floor((ctx.startOffset - ctx.loopStart) * factor * region.sampleRate),
  );

  const { buffer, done, chunkCount } = stretchAudioBufferProgressive(
    ctx.audioCtx, region, /* tempo */ 1 / factor, priorityOffset,
  );

  stretchCache.set(tile, {
    buffer, speed, pitch,
    loopStart: tile.loopStart, loopEnd: tile.loopEnd,
    sourceId: tile.sourceId,
  });

  debug('progressive stretch started', {
    jobId: myJobId, tile: tile.id, speed, pitch, factor,
    regionSamples: region.length, outSamples: buffer.length, chunks: chunkCount,
  });

  setInFlight(tile, +1);
  let settled = false;
  const watchdog = window.setTimeout(() => {
    if (settled) return;
    settled = true;
    console.warn('[speed] watchdog fired', { jobId: myJobId, tile: tile.id });
    setInFlight(tile, -1);
  }, STRETCH_TIMEOUT_MS);

  done.finally(() => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    setInFlight(tile, -1);
  });

  return { buffer };
}

// ── Live updates from UI / palette ────────────────────────────────────

export function setTileSpeed(tile: Tile, speed: number): void {
  void import('../../audio/engine').then(({ getAudioPosition, playAudio }) => {
    const s = state(tile);
    if (speed === s.speed) return;

    // Update state up-front, then either rebase the live BufferSource (if
    // the new combination stays on the no-stretch fast path) or debounce
    // a full rebuild (if it crosses into the stretch path).
    s.speed = speed;
    if (s.link) s.pitch = naturalPitchFor(speed);
    if (tile.video) tile.video.playbackRate = speed;
    applyTileSpeedDisplay(tile);
    paintRate(speed);
    paintPitch(s.pitch);

    const newFactor = stretchFactor(s.speed, s.pitch);
    if (Math.abs(newFactor - 1) < STRETCH_NOOP_EPSILON && tile.audioSource) {
      // Cheap path: live-update playbackRate, rebase the time origin so
      // audio position stays continuous through the rate change.
      const pos = getAudioPosition(tile);
      tile.audioStartedOffset = pos;
      tile.audioStartedAt = getAudioCtx().currentTime;
      tile.audioSource.playbackRate.value = rateFactor(s.pitch);
      return;
    }

    // Stretch path — debounce so a slider drag through many intermediate
    // values doesn't kick off many stretch jobs.
    const pos = tile.audioSource ? getAudioPosition(tile) : tile.loopStart;
    const prev = rebuildTimers.get(tile);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      rebuildTimers.delete(tile);
      if (tile.audioSource) playAudio(tile, pos);
    }, REBUILD_DEBOUNCE_MS);
    rebuildTimers.set(tile, timer);
  });
}

export function setTilePitch(tile: Tile, pitch: number): void {
  void import('../../audio/engine').then(({ getAudioPosition, playAudio }) => {
    const s = state(tile);
    if (s.link) return;             // pitch is derived when linked
    if (pitch === s.pitch) return;

    s.pitch = pitch;
    paintPitch(pitch);

    const newFactor = stretchFactor(s.speed, s.pitch);
    if (Math.abs(newFactor - 1) < STRETCH_NOOP_EPSILON && tile.audioSource) {
      const pos = getAudioPosition(tile);
      tile.audioStartedOffset = pos;
      tile.audioStartedAt = getAudioCtx().currentTime;
      tile.audioSource.playbackRate.value = rateFactor(s.pitch);
      return;
    }

    const pos = tile.audioSource ? getAudioPosition(tile) : tile.loopStart;
    const prev = rebuildTimers.get(tile);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      rebuildTimers.delete(tile);
      if (tile.audioSource) playAudio(tile, pos);
    }, REBUILD_DEBOUNCE_MS);
    rebuildTimers.set(tile, timer);
  });
}

export function setTileLink(tile: Tile, link: boolean): void {
  const s = state(tile);
  if (s.link === link) return;
  debug('setTileLink', { tile: tile.id, from: s.link, to: link, speed: s.speed, pitch: s.pitch });
  s.link = link;
  if (link) {
    // Snap pitch to the natural value for the current speed — that's the
    // no-stretch path, F = 1.
    s.pitch = naturalPitchFor(s.speed);
    paintPitch(s.pitch);
  }
  if (tile.audioSource) {
    void import('../../audio/engine').then(({ getAudioPosition, playAudio }) => {
      playAudio(tile, getAudioPosition(tile));
    });
  }
}

// ── UI ────────────────────────────────────────────────────────────────

let panel: HTMLElement | null = null;
let rateTrack: HTMLElement | null = null;
let rateReadout: HTMLElement | null = null;
let rateThumb: HTMLElement | null = null;
let pitchTrack: HTMLElement | null = null;
let pitchReadout: HTMLElement | null = null;
let pitchThumb: HTMLElement | null = null;
let linkBtn: HTMLButtonElement | null = null;

// log-uniform mapping: slider 0..1 ↔ speed 0.5..2.0, with 0.5 → 1.0× at midpoint.
function speedToFrac(speed: number): number { return (Math.log2(speed) + 1) / 2; }
function fracToSpeed(frac: number): number {
  return Math.pow(2, 2 * Math.max(0, Math.min(1, frac)) - 1);
}
function snapSliderSpeed(speed: number): number {
  const clamped = Math.max(SPEED_MIN, Math.min(SPEED_MAX, speed));
  if (Math.abs(clamped - 1) < SPEED_DEAD_ZONE) return 1.0;
  return Math.round(clamped / SPEED_STEP) * SPEED_STEP;
}

// linear mapping: slider 0..1 ↔ pitch -12..+12, with 0.5 → 0 semitones.
function pitchToFrac(p: number): number { return (p + PITCH_MAX) / (PITCH_MAX - PITCH_MIN); }
function fracToPitch(frac: number): number {
  return (Math.max(0, Math.min(1, frac)) - 0.5) * (PITCH_MAX - PITCH_MIN);
}
function snapSliderPitch(p: number): number {
  const clamped = Math.max(PITCH_MIN, Math.min(PITCH_MAX, p));
  if (Math.abs(clamped) < PITCH_DEAD_ZONE) return 0;
  return Math.round(clamped / PITCH_STEP) * PITCH_STEP;
}

// Readout displays the *value only* — the unit ("×" / "ST") is a sibling
// span in the markup so editing the readout never has to step over the
// unit characters.
function formatSpeed(s: number): string { return s.toFixed(2); }
function formatPitch(p: number): string {
  if (Math.abs(p) < 0.05) return '+0';
  const sign = p > 0 ? '+' : '−';
  const abs = Math.abs(p);
  return `${sign}${abs % 1 === 0 ? abs.toFixed(0) : abs.toFixed(1)}`;
}

function paintRate(speed: number): void {
  if (!rateThumb || !rateReadout || !panel) return;
  const frac = Math.max(0, Math.min(1, speedToFrac(speed)));
  rateThumb.style.left = `${frac * 100}%`;
  rateReadout.textContent = formatSpeed(speed);
  panel.dataset.rateActive = Math.abs(speed - 1) < 0.001 ? 'false' : 'true';
  panel.dataset.active = panel.dataset.rateActive === 'true' || panel.dataset.pitchActive === 'true' ? 'true' : 'false';
}

function paintPitch(pitch: number): void {
  if (!pitchThumb || !pitchReadout || !panel) return;
  const frac = Math.max(0, Math.min(1, pitchToFrac(pitch)));
  pitchThumb.style.left = `${frac * 100}%`;
  pitchReadout.textContent = formatPitch(pitch);
  panel.dataset.pitchActive = Math.abs(pitch) < 0.05 ? 'false' : 'true';
  panel.dataset.active = panel.dataset.rateActive === 'true' || panel.dataset.pitchActive === 'true' ? 'true' : 'false';
}

function paintLink(link: boolean): void {
  if (!panel || !linkBtn) return;
  panel.dataset.link = String(link);
  linkBtn.setAttribute('aria-pressed', String(link));
}

function selectAll(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function bindReadoutEdit(
  el: HTMLElement,
  parse: (raw: string) => number | null,
  apply: (tile: Tile, v: number) => void,
  current: (tile: Tile) => number,
  format: (v: number) => string,
  rawFormat: (v: number) => string,
): void {
  const startEdit = () => {
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    if (!tile) return;
    el.textContent = rawFormat(current(tile));
    el.setAttribute('contenteditable', 'true');
    el.focus();
    selectAll(el);
  };
  const endEdit = (commit: boolean) => {
    if (el.getAttribute('contenteditable') !== 'true') return;
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    let next = tile ? current(tile) : 0;
    if (commit && tile) {
      const parsed = parse(el.textContent ?? '');
      if (parsed !== null) {
        next = parsed;
        apply(tile, next);
        saveManifest();
      }
    }
    el.removeAttribute('contenteditable');
    el.blur();
    el.textContent = format(next);
  };
  el.addEventListener('dblclick', (e) => { e.preventDefault(); startEdit(); });
  el.addEventListener('keydown', (e) => {
    if (el.getAttribute('contenteditable') !== 'true') return;
    if (e.key === 'Enter')      { e.preventDefault(); endEdit(true);  }
    else if (e.key === 'Escape'){ e.preventDefault(); endEdit(false); }
    e.stopPropagation();
  });
  el.addEventListener('blur', () => endEdit(true));
}

// ── Plugin definition ────────────────────────────────────────────────

const plugin: TilePlugin = {
  id: 'speed',

  bind() {
    panel = document.getElementById('speed-panel');
    rateTrack   = document.getElementById('speed-track');
    rateReadout = document.getElementById('speed-readout');
    rateThumb   = rateTrack?.querySelector<HTMLElement>('.speed-thumb') ?? null;
    pitchTrack   = document.getElementById('pitch-track');
    pitchReadout = document.getElementById('pitch-readout');
    pitchThumb   = pitchTrack?.querySelector<HTMLElement>('.speed-thumb') ?? null;
    linkBtn = document.getElementById('speed-link') as HTMLButtonElement | null;

    // ── Rate slider ───────────────────────────────────────────
    if (rateTrack && panel) {
      const t = rateTrack;
      const p = panel;
      bindSliderDrag(t, {
        start: () => {
          const tile = editor.tileId ? tiles.get(editor.tileId) : null;
          if (!tile) return false;
          p.dataset.stateRate = 'dragging';
        },
        move: (x, _y, rect) => {
          const tile = editor.tileId ? tiles.get(editor.tileId) : null;
          if (!tile) return;
          const frac = (x - rect.left) / rect.width;
          const s = snapSliderSpeed(fracToSpeed(frac));
          setTileSpeed(tile, s);
        },
        end: () => { p.dataset.stateRate = ''; saveManifest(); },
      });
      t.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const tile = editor.tileId ? tiles.get(editor.tileId) : null;
        if (!tile) return;
        setTileSpeed(tile, 1.0);
        saveManifest();
      });
    }

    // ── Pitch slider ──────────────────────────────────────────
    if (pitchTrack && panel) {
      const t = pitchTrack;
      const p = panel;
      bindSliderDrag(t, {
        start: () => {
          const tile = editor.tileId ? tiles.get(editor.tileId) : null;
          if (!tile) return false;
          if (state(tile).link) return false;   // disabled when linked
          p.dataset.statePitch = 'dragging';
        },
        move: (x, _y, rect) => {
          const tile = editor.tileId ? tiles.get(editor.tileId) : null;
          if (!tile) return;
          if (state(tile).link) return;
          const frac = (x - rect.left) / rect.width;
          const v = snapSliderPitch(fracToPitch(frac));
          setTilePitch(tile, v);
        },
        end: () => { p.dataset.statePitch = ''; saveManifest(); },
      });
      t.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const tile = editor.tileId ? tiles.get(editor.tileId) : null;
        if (!tile) return;
        if (state(tile).link) return;
        setTilePitch(tile, 0);
        saveManifest();
      });
    }

    // ── Typed-in numeric overrides ────────────────────────────
    if (rateReadout) {
      bindReadoutEdit(
        rateReadout,
        (raw) => {
          const v = parseFloat(raw.replace(/[×x\s]/gi, ''));
          return isFinite(v) && v > 0 ? v : null;
        },
        (tile, v) => setTileSpeed(tile, v),
        (tile) => state(tile).speed,
        formatSpeed,
        (v) => v.toFixed(2),
      );
    }
    if (pitchReadout) {
      bindReadoutEdit(
        pitchReadout,
        (raw) => {
          // Unicode minus (used in the formatted display) → ASCII so
          // parseFloat sees the sign. Then strip everything else.
          const normalised = raw.replace(/−/g, '-').replace(/[stST\s+]/g, '');
          const v = parseFloat(normalised);
          return isFinite(v) ? v : null;
        },
        (tile, v) => { if (!state(tile).link) setTilePitch(tile, v); },
        (tile) => state(tile).pitch,
        formatPitch,
        (v) => v.toFixed(1),
      );
    }

    // ── LINK toggle ───────────────────────────────────────────
    linkBtn?.addEventListener('click', () => {
      const tile = editor.tileId ? tiles.get(editor.tileId) : null;
      if (!tile) return;
      const next = !state(tile).link;
      setTileLink(tile, next);
      paintLink(next);
      saveManifest();
    });

    paintRate(1.0);
    paintPitch(0);
    paintLink(true);
  },

  defaultState(): SpeedState {
    return { speed: 1, pitch: 0, link: true };
  },

  serialize(s: unknown): unknown {
    const v = s as SpeedState;
    // Default state isn't worth persisting.
    if (v.speed === 1 && v.pitch === 0 && v.link === true) return undefined;
    return { speed: v.speed, pitch: v.pitch, link: v.link };
  },

  hydrate(raw: unknown): SpeedState | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as { speed?: unknown; pitch?: unknown; link?: unknown; pitchLock?: unknown };
    const speed = typeof r.speed === 'number' && isFinite(r.speed) && r.speed > 0 ? r.speed : 1;
    // New shape carries explicit pitch + link. Older shape carries pitchLock:
    // pitchLock = true  →  pitch held at 0 while speed shifts → link off, pitch 0
    // pitchLock = false →  pitch follows speed naturally       → link on
    if (typeof r.link === 'boolean') {
      const pitch = typeof r.pitch === 'number' && isFinite(r.pitch) ? r.pitch : (r.link ? naturalPitchFor(speed) : 0);
      return { speed, pitch, link: r.link };
    }
    if (r.pitchLock === true)  return { speed, pitch: 0,                       link: false };
    if (r.pitchLock === false) return { speed, pitch: naturalPitchFor(speed),  link: true  };
    return { speed, pitch: naturalPitchFor(speed), link: true };
  },

  loadForTile(tile: Tile): void {
    const s = state(tile);
    paintRate(s.speed);
    paintPitch(s.pitch);
    paintLink(s.link);
    if (linkBtn) linkBtn.dataset.busy = (inFlight.get(tile) ?? 0) > 0 ? 'true' : 'false';
  },

  onPlay(tile: Tile, ctx: PlayContext): void {
    const s = state(tile);
    const F = stretchFactor(s.speed, s.pitch);
    const R = rateFactor(s.pitch);

    if (Math.abs(F - 1) < STRETCH_NOOP_EPSILON) {
      // No-stretch path. Covers LINK on (by construction) and any
      // hand-set (speed, pitch) combo where pitch ≈ 12·log2(speed).
      ctx.source.playbackRate.value = R;
    } else {
      const cached = stretchCache.get(tile);
      if (cacheMatches(cached, tile, s.speed, s.pitch)) {
        mountStretched(ctx, cached!.buffer, F);
        ctx.source.playbackRate.value = R;
      } else {
        const region = sliceLoopRegion(ctx.audioCtx, ctx.buffer, ctx.loopStart, ctx.loopEnd);
        const { buffer } = beginProgressiveStretch(tile, ctx, region, s.speed, s.pitch, F);
        mountStretched(ctx, buffer, F);
        ctx.source.playbackRate.value = R;
      }
    }
    if (tile.video) tile.video.playbackRate = s.speed;
  },

  teardownTile(tile: Tile): void {
    const t = rebuildTimers.get(tile);
    if (t) { clearTimeout(t); rebuildTimers.delete(tile); }
    stretchCache.delete(tile);
    stretchJobIds.delete(tile);
  },
};

registerPlugin(plugin);
export {};

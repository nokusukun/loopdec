// 8-band peaking EQ as a self-contained tile plugin.
//
//   state          { gains: number[8] }
//   audio chain    8 BiquadFilter nodes (peaking) in series, lazy-built on first
//                  play and disconnected on tile teardown
//   UI             panel inside the waveform editor's #tile-params slot;
//                  pointer-driven sliders with dead-zone snap to 0 dB
//
// The plugin keeps its own runtime data (filter node arrays) keyed by tile id
// in a private WeakMap so Tile interface stays plugin-agnostic.

import './eq.css';

import type { Tile } from '../../types';
import { tiles } from '../../state';
import { editor } from '../../editor-state';
import { saveManifest } from '../../persistence/manifest';
import { bindSliderDrag } from '../../ui/drag';
import { registerPlugin } from '../registry';
import type { TilePlugin, PlayContext } from '../types';

const EQ_BANDS = [63, 160, 400, 1000, 2500, 6300, 10000, 16000] as const;
const EQ_Q = 1.41;
const BAND_COUNT = EQ_BANDS.length;

const DB_MIN = -12;
const DB_MAX = 12;
const DB_STEP = 0.5;
const DEAD_ZONE = 0.25;

interface EqState {
  gains: number[];  // length 8
}

// Runtime audio nodes per tile, kept out of Tile to avoid leaking plugin internals.
const filtersByTile = new WeakMap<Tile, BiquadFilterNode[]>();

function getState(tile: Tile): EqState {
  return tile.plugins.eq as EqState;
}

function buildChain(ctx: AudioContext, gains: number[]): BiquadFilterNode[] {
  const filters = EQ_BANDS.map((freq, i) => {
    const f = ctx.createBiquadFilter();
    f.type = 'peaking';
    f.frequency.value = freq;
    f.Q.value = EQ_Q;
    f.gain.value = gains[i] ?? 0;
    return f;
  });
  for (let i = 0; i < filters.length - 1; i++) {
    filters[i].connect(filters[i + 1]);
  }
  return filters;
}

// ── UI ────────────────────────────────────────────────────────────────

const bandEls: HTMLElement[] = [];
let panelEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let resetBtn: HTMLElement | null = null;

function formatDb(v: number): string {
  if (Math.abs(v) < 0.01) return '0';
  const sign = v > 0 ? '+' : '−';
  return `${sign}${Math.abs(v).toFixed(Math.abs(v) >= 10 ? 0 : 1)}`;
}

function paintBand(band: number, v: number): void {
  const el = bandEls[band];
  if (!el) return;
  const thumb = el.querySelector<HTMLElement>('.eq-thumb');
  const fill = el.querySelector<HTMLElement>('.eq-fill');
  const readout = el.querySelector<HTMLElement>('.eq-readout');
  if (!thumb || !fill || !readout) return;

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

  if (el.dataset.state !== 'dragging') {
    el.dataset.state = isZero ? 'neutral' : 'active';
  }
}

function refreshStatus(): void {
  const tile = editor.tileId ? tiles.get(editor.tileId) : null;
  if (!panelEl || !statusEl) return;
  if (!tile) {
    panelEl.dataset.active = 'false';
    statusEl.textContent = 'FLAT';
    return;
  }
  const { gains } = getState(tile);
  const any = gains.some(v => Math.abs(v) > 0.01);
  panelEl.dataset.active = String(any);
  statusEl.textContent = any ? 'ACTIVE' : 'FLAT';
}

function dbFromY(y: number, height: number): number {
  if (height <= 0) return 0;
  const norm = Math.max(0, Math.min(1, y / height));
  const v = (1 - 2 * norm) * DB_MAX;
  if (Math.abs(v) < DEAD_ZONE) return 0;
  return Math.max(DB_MIN, Math.min(DB_MAX, Math.round(v / DB_STEP) * DB_STEP));
}

// Push a new gain value into both the persisted state and the live filter
// node so audio responds in real time during slider drag.
function setBand(tile: Tile, band: number, gainDB: number): void {
  if (band < 0 || band >= BAND_COUNT) return;
  getState(tile).gains[band] = gainDB;
  const filters = filtersByTile.get(tile);
  if (filters?.[band]) filters[band].gain.value = gainDB;
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
      setBand(tile, band, v);
      paintBand(band, v);
      refreshStatus();
    },
    end: () => {
      const tile = editor.tileId ? tiles.get(editor.tileId) : null;
      if (!tile) return;
      const v = getState(tile).gains[band] ?? 0;
      el.dataset.state = Math.abs(v) < 0.01 ? 'neutral' : 'active';
      saveManifest();
    },
  });

  track.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    if (!tile) return;
    setBand(tile, band, 0);
    paintBand(band, 0);
    refreshStatus();
    saveManifest();
  });
}

// ── Plugin definition ────────────────────────────────────────────────

const plugin: TilePlugin = {
  id: 'eq',

  bind() {
    panelEl = document.getElementById('eq-panel');
    statusEl = document.getElementById('eq-status');
    resetBtn = document.getElementById('eq-reset');
    bandEls.push(...document.querySelectorAll<HTMLElement>('.eq-band'));

    bandEls.forEach((el, i) => bindBand(el, i));

    resetBtn?.addEventListener('click', () => {
      const tile = editor.tileId ? tiles.get(editor.tileId) : null;
      if (!tile) return;
      for (let i = 0; i < BAND_COUNT; i++) {
        setBand(tile, i, 0);
        paintBand(i, 0);
      }
      refreshStatus();
      saveManifest();
    });
  },

  defaultState(): EqState {
    return { gains: [0, 0, 0, 0, 0, 0, 0, 0] };
  },

  serialize(state: unknown): unknown {
    const s = state as EqState;
    return { gains: [...s.gains] };
  },

  hydrate(raw: unknown): EqState | undefined {
    // Plugin payload shape OR legacy bare array — accept both for back-compat.
    if (Array.isArray(raw) && raw.length === BAND_COUNT) {
      return { gains: [...raw] };
    }
    if (raw && typeof raw === 'object') {
      const gains = (raw as { gains?: unknown }).gains;
      if (Array.isArray(gains) && gains.length === BAND_COUNT) {
        return { gains: [...gains] };
      }
    }
    return undefined;
  },

  loadForTile(tile: Tile): void {
    const { gains } = getState(tile);
    for (let i = 0; i < BAND_COUNT; i++) paintBand(i, gains[i] ?? 0);
    refreshStatus();
  },

  onPlay(tile: Tile, ctx: PlayContext): void {
    let filters = filtersByTile.get(tile);
    if (!filters) {
      filters = buildChain(ctx.audioCtx, getState(tile).gains);
      filtersByTile.set(tile, filters);
    } else {
      // Refresh gains in case state changed while no filter chain existed
      const { gains } = getState(tile);
      filters.forEach((f, i) => { f.gain.value = gains[i] ?? 0; });
    }
    ctx.chain.push({ input: filters[0], output: filters[filters.length - 1] });
  },

  teardownTile(tile: Tile): void {
    const filters = filtersByTile.get(tile);
    if (!filters) return;
    for (const f of filters) {
      try { f.disconnect(); } catch {}
    }
    filtersByTile.delete(tile);
  },
};

registerPlugin(plugin);
export {};

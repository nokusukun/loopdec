// Per-tile reverb — algorithmic impulse response fed into a ConvolverNode.
//
//   state          { size: seconds, damp: 0..1, mix: 0..1 }
//   audio          parallel wet/dry split:
//                    input → dry gain → output
//                    input → convolver → wet gain → output
//                  Dry and wet are mixed via equal-power crossfade so the
//                  total energy stays roughly constant across mix sweeps.
//   UI             three slider rows (SIZE / DAMP / MIX), each with its
//                  own LCD readout and calibration scale.

import './reverb.css';

import type { Tile } from '../../types';
import { tiles } from '../../state';
import { editor } from '../../editor-state';
import { saveManifest } from '../../persistence/manifest';
import { bindSliderDrag } from '../../ui/drag';
import { registerPlugin } from '../registry';
import type { TilePlugin, PlayContext } from '../types';

interface ReverbState {
  size: number;     // decay length in seconds
  damp: number;     // 0..1 — higher = faster HF decay (darker tail)
  mix: number;      // 0..1 — wet/dry blend (0 = bypassed)
  lastMix: number;  // memory for the on/off toggle. Updates on slider
                    // commit / typed entry, NOT on transient drag values,
                    // so dragging through 0 doesn't poison the restore.
}

const SIZE_MIN = 0.10;
const SIZE_MAX = 6.0;
const SIZE_DEFAULT = 1.5;
const DAMP_DEFAULT = 0.40;
const MIX_DEFAULT  = 0.0;
const MIX_DEFAULT_ON = 0.5;   // power-on default when no lastMix is remembered
const MIX_ON_THRESHOLD = 0.01;

// Rebuilding the impulse response touches a ConvolverNode buffer assignment
// (a one-shot operation that internally rebuilds FFT tables). Cheap enough
// per call, but worth debouncing during slider drags.
const IR_DEBOUNCE_MS = 150;

// ── Audio graph per tile ───────────────────────────────────────────

interface ReverbNodes {
  input: GainNode;        // pre-split bus, exposed to the engine as chain stage input
  output: GainNode;       // post-mix bus, exposed as chain stage output
  convolver: ConvolverNode;
  dryGain: GainNode;
  wetGain: GainNode;
  irSize: number;         // cached IR params so we don't rebuild when nothing changed
  irDamp: number;
}

const nodesByTile = new WeakMap<Tile, ReverbNodes>();
const irRebuildTimers = new WeakMap<Tile, ReturnType<typeof setTimeout>>();

function ensureNodes(tile: Tile, audioCtx: AudioContext): ReverbNodes {
  let n = nodesByTile.get(tile);
  if (n) return n;

  const input  = audioCtx.createGain();
  const output = audioCtx.createGain();
  const convolver = audioCtx.createConvolver();
  // Keep the engine's built-in equal-power IR normalisation (the spec
  // default). Without it the raw convolved signal scales with the IR's
  // total energy — a 1.5s noise tail then dwarfs the dry signal and
  // anything past a few percent wet mix clips. Normalisation preserves
  // the IR's *shape* (decay curve, density) while keeping wet loudness
  // predictable as size/damp move.
  convolver.normalize = true;
  const dryGain = audioCtx.createGain();
  const wetGain = audioCtx.createGain();

  // Parallel split: input feeds both paths. The output merges them.
  input.connect(dryGain);
  dryGain.connect(output);
  input.connect(convolver);
  convolver.connect(wetGain);
  wetGain.connect(output);

  n = { input, output, convolver, dryGain, wetGain, irSize: -1, irDamp: -1 };
  nodesByTile.set(tile, n);
  return n;
}

function applyMix(n: ReverbNodes, mix01: number): void {
  // Equal-power crossfade: keeps perceived loudness ~stable when sweeping
  // mix from dry to wet. cos²+sin²=1 → constant power sum.
  const m = Math.max(0, Math.min(1, mix01));
  n.dryGain.gain.value = Math.cos(m * Math.PI / 2);
  n.wetGain.gain.value = Math.sin(m * Math.PI / 2);
}

function generateIR(audioCtx: BaseAudioContext, sizeSec: number, damp01: number): AudioBuffer {
  // Two-channel decorrelated noise with an exponential decay envelope.
  // `damp` shapes the decay curve — higher damp = steeper drop-off, which
  // also subtly mimics HF damping because the resulting spectrum becomes
  // narrower in time. Cheap; takes ~1-5ms for typical sizes.
  const rate = audioCtx.sampleRate;
  const len = Math.max(2, Math.floor(Math.max(SIZE_MIN, Math.min(SIZE_MAX, sizeSec)) * rate));
  const ir = audioCtx.createBuffer(2, len, rate);
  const shape = 1.5 + damp01 * 5.5;  // 1.5 (bright/slow decay) … 7 (dark/fast decay)
  // copyToChannel preferred — lets engines elide the public storage copy.
  const tmp = new Float32Array(len);
  for (let ch = 0; ch < 2; ch++) {
    for (let i = 0; i < len; i++) {
      const t = i / len;            // 0..1 across the tail
      const decay = Math.pow(1 - t, shape);
      tmp[i] = (Math.random() * 2 - 1) * decay;
    }
    ir.copyToChannel(tmp, ch, 0);
  }
  return ir;
}

function applyIR(n: ReverbNodes, audioCtx: BaseAudioContext, size: number, damp: number): void {
  if (Math.abs(n.irSize - size) < 1e-6 && Math.abs(n.irDamp - damp) < 1e-6) return;
  n.convolver.buffer = generateIR(audioCtx, size, damp);
  n.irSize = size;
  n.irDamp = damp;
}

function scheduleIRRebuild(tile: Tile): void {
  const prev = irRebuildTimers.get(tile);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    irRebuildTimers.delete(tile);
    const n = nodesByTile.get(tile);
    if (!n) return;
    const s = state(tile);
    applyIR(n, n.convolver.context, s.size, s.damp);
  }, IR_DEBOUNCE_MS);
  irRebuildTimers.set(tile, timer);
}

// ── State accessors ──────────────────────────────────────────────────

function state(tile: Tile): ReverbState {
  return tile.plugins.reverb as ReverbState;
}

function isModified(s: ReverbState): boolean {
  return Math.abs(s.mix) > 0.001
      || Math.abs(s.size - SIZE_DEFAULT) > 1e-6
      || Math.abs(s.damp - DAMP_DEFAULT) > 1e-6;
}

function isOn(s: ReverbState): boolean {
  return s.mix > MIX_ON_THRESHOLD;
}

// Toggle the wet path on/off via the MIX value. ON → restore the
// remembered last mix (defaults to 50% the first time). OFF → drop to 0.
// lastMix is kept across the OFF state so power-cycling returns to the
// same level.
function toggleReverbPower(tile: Tile): void {
  const s = state(tile);
  if (isOn(s)) {
    setMix(tile, 0);
  } else {
    const restore = s.lastMix > MIX_ON_THRESHOLD ? s.lastMix : MIX_DEFAULT_ON;
    setMix(tile, restore);
  }
}

// Commit a settled mix value into the on/off memory. Called from drag-end
// and from typed entries — i.e. the points where the user has explicitly
// chosen a value, not transient drag positions.
function commitMixToMemory(tile: Tile): void {
  const s = state(tile);
  if (s.mix > MIX_ON_THRESHOLD) s.lastMix = s.mix;
}

// ── Live UI bindings ─────────────────────────────────────────────────

function setSize(tile: Tile, size: number): void {
  const s = state(tile);
  if (Math.abs(size - s.size) < 1e-6) return;
  s.size = size;
  paintSize(size);
  scheduleIRRebuild(tile);
}

function setDamp(tile: Tile, damp: number): void {
  const s = state(tile);
  if (Math.abs(damp - s.damp) < 1e-6) return;
  s.damp = damp;
  paintDamp(damp);
  scheduleIRRebuild(tile);
}

function setMix(tile: Tile, mix: number): void {
  const s = state(tile);
  if (Math.abs(mix - s.mix) < 1e-6) return;
  s.mix = mix;
  paintMix(mix);
  const n = nodesByTile.get(tile);
  if (n) applyMix(n, mix);
}

// ── Slider math ──────────────────────────────────────────────────────

// Size: log-mapped so 0.5/1.5/3 land at intuitive thumb positions across
// a 60× dynamic range.
function sizeToFrac(s: number): number {
  return Math.log(s / SIZE_MIN) / Math.log(SIZE_MAX / SIZE_MIN);
}
function fracToSize(f: number): number {
  const c = Math.max(0, Math.min(1, f));
  return SIZE_MIN * Math.pow(SIZE_MAX / SIZE_MIN, c);
}
function snapSize(s: number): number {
  const c = Math.max(SIZE_MIN, Math.min(SIZE_MAX, s));
  return Math.round(c * 10) / 10;  // one decimal place
}

// Damp + Mix: plain linear 0..1.
function snapPct(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  return Math.round(c * 100) / 100;
}

function formatSize(s: number): string { return s.toFixed(1); }
function formatPct(v: number): string { return `${Math.round(v * 100)}`; }

// ── UI elements ──────────────────────────────────────────────────────

let panel: HTMLElement | null = null;
let sizeTrack: HTMLElement | null = null;
let sizeReadout: HTMLElement | null = null;
let sizeThumb: HTMLElement | null = null;
let dampTrack: HTMLElement | null = null;
let dampReadout: HTMLElement | null = null;
let dampThumb: HTMLElement | null = null;
let mixTrack: HTMLElement | null = null;
let mixReadout: HTMLElement | null = null;
let mixThumb: HTMLElement | null = null;
let powerBtn: HTMLButtonElement | null = null;

function paintActive(): void {
  if (!panel) return;
  const tile = editor.tileId ? tiles.get(editor.tileId) : null;
  if (!tile) return;
  const s = state(tile);
  panel.dataset.active = isModified(s) ? 'true' : 'false';
  panel.dataset.mixActive = s.mix > 0.001 ? 'true' : 'false';
}

function paintSize(size: number): void {
  if (!sizeThumb || !sizeReadout) return;
  sizeThumb.style.left = `${sizeToFrac(size) * 100}%`;
  sizeReadout.textContent = formatSize(size);
  paintActive();
}

function paintDamp(damp: number): void {
  if (!dampThumb || !dampReadout) return;
  dampThumb.style.left = `${damp * 100}%`;
  dampReadout.textContent = formatPct(damp);
  paintActive();
}

function paintMix(mix: number): void {
  if (!mixThumb || !mixReadout) return;
  mixThumb.style.left = `${mix * 100}%`;
  mixReadout.textContent = formatPct(mix);
  if (powerBtn) powerBtn.setAttribute('aria-pressed', String(mix > MIX_ON_THRESHOLD));
  paintActive();
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
    const range = document.createRange();
    range.selectNodeContents(el);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  };
  const endEdit = (commit: boolean) => {
    if (el.getAttribute('contenteditable') !== 'true') return;
    const tile = editor.tileId ? tiles.get(editor.tileId) : null;
    let next = tile ? current(tile) : 0;
    if (commit && tile) {
      const parsed = parse(el.textContent ?? '');
      if (parsed !== null) { next = parsed; apply(tile, next); saveManifest(); }
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
  id: 'reverb',

  bind() {
    panel = document.getElementById('reverb-panel');
    sizeTrack   = document.getElementById('reverb-size-track');
    sizeReadout = document.getElementById('reverb-size-readout');
    sizeThumb   = sizeTrack?.querySelector<HTMLElement>('.rv-thumb') ?? null;
    dampTrack   = document.getElementById('reverb-damp-track');
    dampReadout = document.getElementById('reverb-damp-readout');
    dampThumb   = dampTrack?.querySelector<HTMLElement>('.rv-thumb') ?? null;
    mixTrack    = document.getElementById('reverb-mix-track');
    mixReadout  = document.getElementById('reverb-mix-readout');
    mixThumb    = mixTrack?.querySelector<HTMLElement>('.rv-thumb') ?? null;

    if (sizeTrack && panel) {
      const t = sizeTrack;
      const p = panel;
      bindSliderDrag(t, {
        start: () => { if (!editor.tileId) return false; p.dataset.stateSize = 'dragging'; },
        move: (x, _y, rect) => {
          const tile = editor.tileId ? tiles.get(editor.tileId) : null;
          if (!tile) return;
          setSize(tile, snapSize(fracToSize((x - rect.left) / rect.width)));
        },
        end: () => { p.dataset.stateSize = ''; saveManifest(); },
      });
      t.addEventListener('dblclick', () => {
        const tile = editor.tileId ? tiles.get(editor.tileId) : null;
        if (!tile) return;
        setSize(tile, SIZE_DEFAULT); saveManifest();
      });
    }
    if (dampTrack && panel) {
      const t = dampTrack;
      const p = panel;
      bindSliderDrag(t, {
        start: () => { if (!editor.tileId) return false; p.dataset.stateDamp = 'dragging'; },
        move: (x, _y, rect) => {
          const tile = editor.tileId ? tiles.get(editor.tileId) : null;
          if (!tile) return;
          setDamp(tile, snapPct((x - rect.left) / rect.width));
        },
        end: () => { p.dataset.stateDamp = ''; saveManifest(); },
      });
      t.addEventListener('dblclick', () => {
        const tile = editor.tileId ? tiles.get(editor.tileId) : null;
        if (!tile) return;
        setDamp(tile, DAMP_DEFAULT); saveManifest();
      });
    }
    if (mixTrack && panel) {
      const t = mixTrack;
      const p = panel;
      bindSliderDrag(t, {
        start: () => { if (!editor.tileId) return false; p.dataset.stateMix = 'dragging'; },
        move: (x, _y, rect) => {
          const tile = editor.tileId ? tiles.get(editor.tileId) : null;
          if (!tile) return;
          setMix(tile, snapPct((x - rect.left) / rect.width));
        },
        end: () => {
          p.dataset.stateMix = '';
          // Settled value → fold into the on/off memory. Transient drag
          // values (including dragging through 0) don't pollute lastMix.
          const tile = editor.tileId ? tiles.get(editor.tileId) : null;
          if (tile) commitMixToMemory(tile);
          saveManifest();
        },
      });
      t.addEventListener('dblclick', () => {
        const tile = editor.tileId ? tiles.get(editor.tileId) : null;
        if (!tile) return;
        setMix(tile, MIX_DEFAULT); saveManifest();
      });
    }

    if (sizeReadout) {
      bindReadoutEdit(
        sizeReadout,
        (raw) => { const v = parseFloat(raw.replace(/[sS\s]/g, '')); return isFinite(v) && v > 0 ? v : null; },
        (tile, v) => setSize(tile, Math.max(SIZE_MIN, Math.min(SIZE_MAX, v))),
        (tile) => state(tile).size,
        formatSize,
        (v) => v.toFixed(1),
      );
    }
    if (dampReadout) {
      bindReadoutEdit(
        dampReadout,
        (raw) => { const v = parseFloat(raw.replace(/[%\s]/g, '')); return isFinite(v) ? v / 100 : null; },
        (tile, v) => setDamp(tile, Math.max(0, Math.min(1, v))),
        (tile) => state(tile).damp,
        formatPct,
        (v) => Math.round(v * 100).toString(),
      );
    }
    if (mixReadout) {
      bindReadoutEdit(
        mixReadout,
        (raw) => { const v = parseFloat(raw.replace(/[%\s]/g, '')); return isFinite(v) ? v / 100 : null; },
        (tile, v) => {
          setMix(tile, Math.max(0, Math.min(1, v)));
          commitMixToMemory(tile);
        },
        (tile) => state(tile).mix,
        formatPct,
        (v) => Math.round(v * 100).toString(),
      );
    }

    powerBtn = document.getElementById('reverb-power') as HTMLButtonElement | null;
    powerBtn?.addEventListener('click', () => {
      const tile = editor.tileId ? tiles.get(editor.tileId) : null;
      if (!tile) return;
      toggleReverbPower(tile);
      saveManifest();
    });

    paintSize(SIZE_DEFAULT);
    paintDamp(DAMP_DEFAULT);
    paintMix(MIX_DEFAULT);
  },

  defaultState(): ReverbState {
    return { size: SIZE_DEFAULT, damp: DAMP_DEFAULT, mix: MIX_DEFAULT, lastMix: MIX_DEFAULT_ON };
  },

  serialize(s: unknown): unknown {
    const v = s as ReverbState;
    if (!isModified(v) && Math.abs(v.lastMix - MIX_DEFAULT_ON) < 1e-6) return undefined;
    return { size: v.size, damp: v.damp, mix: v.mix, lastMix: v.lastMix };
  },

  hydrate(raw: unknown): ReverbState | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as { size?: unknown; damp?: unknown; mix?: unknown; lastMix?: unknown };
    const mix = typeof r.mix  === 'number' && isFinite(r.mix)  ? Math.max(0, Math.min(1, r.mix))  : MIX_DEFAULT;
    return {
      size: typeof r.size === 'number' && isFinite(r.size) ? Math.max(SIZE_MIN, Math.min(SIZE_MAX, r.size)) : SIZE_DEFAULT,
      damp: typeof r.damp === 'number' && isFinite(r.damp) ? Math.max(0, Math.min(1, r.damp)) : DAMP_DEFAULT,
      mix,
      lastMix: typeof r.lastMix === 'number' && isFinite(r.lastMix) && r.lastMix > MIX_ON_THRESHOLD
        ? Math.max(0, Math.min(1, r.lastMix))
        : (mix > MIX_ON_THRESHOLD ? mix : MIX_DEFAULT_ON),
    };
  },

  loadForTile(tile: Tile): void {
    const s = state(tile);
    paintSize(s.size);
    paintDamp(s.damp);
    paintMix(s.mix);
  },

  onPlay(tile: Tile, ctx: PlayContext): void {
    const s = state(tile);
    const n = ensureNodes(tile, ctx.audioCtx);
    applyIR(n, ctx.audioCtx, s.size, s.damp);
    applyMix(n, s.mix);
    ctx.chain.push({ input: n.input, output: n.output });
  },

  teardownTile(tile: Tile): void {
    const timer = irRebuildTimers.get(tile);
    if (timer) { clearTimeout(timer); irRebuildTimers.delete(tile); }
    const n = nodesByTile.get(tile);
    if (!n) return;
    for (const node of [n.input, n.output, n.convolver, n.dryGain, n.wetGain]) {
      try { node.disconnect(); } catch {}
    }
    nodesByTile.delete(tile);
  },
};

registerPlugin(plugin);
export {};

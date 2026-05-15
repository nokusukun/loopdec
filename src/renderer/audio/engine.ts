import type { Source, Tile } from '../types';
import { getSource, tilesForSource } from '../state';
import { getAudioCtx } from './context';
import { runOnPlay, teardownTilePlugins } from '../plugins/registry';
import { getSpeed } from '../plugins/speed';
import type { PlayContext } from '../plugins/types';

export async function decodeSourceAudio(source: Source): Promise<void> {
  if (source.chunked) {
    const peaksBuf = await window.api.getAudioPeaks(source.id);
    if (peaksBuf) source.peaks = new Float32Array(peaksBuf);
    source.decodedChunks = new Map();
    source.audioReady = true;
    for (const t of tilesForSource(source.id)) {
      if (t.video) t.video.muted = true;
    }
    return;
  }

  const rawBuffer = await window.api.getAudioBuffer(source.id);
  if (!rawBuffer) return;
  if (!(rawBuffer instanceof ArrayBuffer)) {
    if ((rawBuffer as { error?: string }).error === 'use-chunks') {
      console.warn(`Audio file for ${source.id} is large but not chunked — run extract-audio first`);
    }
    return;
  }
  const actx = getAudioCtx();
  try {
    source.audioBuffer = await actx.decodeAudioData(rawBuffer);
    source.audioReady = true;
    for (const t of tilesForSource(source.id)) {
      if (t.video) t.video.muted = true;
    }
  } catch (e) {
    console.warn(`Audio decode failed for ${source.id}:`, e);
  }
}

async function decodeChunk(source: Source, index: number): Promise<AudioBuffer | null> {
  if (!source.decodedChunks) return null;
  if (source.decodedChunks.has(index)) return source.decodedChunks.get(index)!;
  if (index < 0 || index >= source.chunkCount) return null;

  const raw = await window.api.getAudioChunk(source.id, index);
  if (!raw) return null;

  const actx = getAudioCtx();
  const decoded = await actx.decodeAudioData(raw);
  source.decodedChunks.set(index, decoded);
  return decoded;
}

async function loadChunksForRegion(source: Source, start: number, end: number): Promise<void> {
  const firstChunk = Math.floor(start / source.chunkDuration);
  const lastChunk = Math.min(Math.floor(end / source.chunkDuration), source.chunkCount - 1);
  const promises: Promise<AudioBuffer | null>[] = [];
  for (let i = firstChunk; i <= lastChunk; i++) promises.push(decodeChunk(source, i));
  await Promise.all(promises);
}

function buildRegionBuffer(source: Source, start: number, end: number): { buffer: AudioBuffer; offset: number } | null {
  if (!source.decodedChunks) return null;
  const actx = getAudioCtx();
  const firstChunk = Math.floor(start / source.chunkDuration);
  const lastChunk = Math.min(Math.floor(end / source.chunkDuration), source.chunkCount - 1);

  const chunks: AudioBuffer[] = [];
  for (let i = firstChunk; i <= lastChunk; i++) {
    const buf = source.decodedChunks.get(i);
    if (!buf) return null;
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;

  const sampleRate = chunks[0].sampleRate;
  const channels = chunks[0].numberOfChannels;
  const totalLength = chunks.reduce((sum, b) => sum + b.length, 0);

  const combined = actx.createBuffer(channels, totalLength, sampleRate);
  // Use copyFromChannel/copyToChannel so engines can elide internal copies
  // and avoid exposing the underlying storage (per Web Audio perf guidance).
  const scratch = new Float32Array(chunks[0].length);
  let offset = 0;
  for (const buf of chunks) {
    const view = buf.length === scratch.length ? scratch : new Float32Array(buf.length);
    for (let ch = 0; ch < channels; ch++) {
      buf.copyFromChannel(view, ch, 0);
      combined.copyToChannel(view, ch, offset);
    }
    offset += buf.length;
  }

  return { buffer: combined, offset: firstChunk * source.chunkDuration };
}

// Decode a margin of chunks on either side of the loop so a small drag of
// the loop bounds doesn't have to wait on disk + decode. Sized in chunks
// rather than seconds: at the chunk granularity used here, ±2 yields ~10s
// of pre-decoded margin which covers typical loop-edit gestures.
const PRELOAD_MARGIN_CHUNKS = 2;
function preloadAdjacentChunks(source: Source, start: number, end: number): void {
  const firstChunk = Math.floor(start / source.chunkDuration);
  const lastChunk = Math.floor(end / source.chunkDuration);
  for (let i = 1; i <= PRELOAD_MARGIN_CHUNKS; i++) {
    if (firstChunk - i >= 0) decodeChunk(source, firstChunk - i);
    if (lastChunk + i < source.chunkCount) decodeChunk(source, lastChunk + i);
  }
}

// Edges we created between long-lived nodes on the previous play (chain →
// chain and chain → gain). We must disconnect them before re-wiring,
// otherwise each play adds a parallel path and the signal multiplies.
// Source-to-chain edges aren't tracked: the source is one-shot, and its
// disconnect on stopAudioSource cleans up its sole outgoing edge.
const previousWiring = new WeakMap<Tile, Array<{ from: AudioNode; to: AudioNode }>>();

function disconnectPreviousWiring(tile: Tile): void {
  const edges = previousWiring.get(tile);
  if (!edges) return;
  for (const { from, to } of edges) {
    try { from.disconnect(to); } catch {}
  }
  previousWiring.delete(tile);
}

export async function playAudio(tile: Tile, offset: number): Promise<void> {
  const source = getSource(tile);
  if (!source?.audioReady) return;

  const actx = getAudioCtx();
  if (actx.state === 'suspended') actx.resume();

  stopAudioSource(tile);
  disconnectPreviousWiring(tile);

  if (!tile.gainNode) {
    tile.gainNode = actx.createGain();
    tile.gainNode.connect(actx.destination);
  }
  tile.gainNode.gain.value = tile.muted ? 0 : tile.volume;

  let buffer: AudioBuffer, loopStart: number, loopEnd: number, startInBuffer: number;

  if (source.chunked) {
    await loadChunksForRegion(source, tile.loopStart, tile.loopEnd);
    const region = buildRegionBuffer(source, tile.loopStart, tile.loopEnd);
    if (!region) return;
    buffer = region.buffer;
    loopStart = tile.loopStart - region.offset;
    loopEnd = tile.loopEnd - region.offset;
    startInBuffer = offset - region.offset;
    tile._regionOffset = region.offset;
    preloadAdjacentChunks(source, tile.loopStart, tile.loopEnd);
  } else {
    if (!source.audioBuffer) return;
    buffer = source.audioBuffer;
    loopStart = tile.loopStart;
    loopEnd = tile.loopEnd;
    startInBuffer = offset;
    tile._regionOffset = 0;
  }

  const node = actx.createBufferSource();
  const ctx: PlayContext = {
    audioCtx: actx,
    source: node,
    buffer,
    loopStart,
    loopEnd,
    startOffset: startInBuffer,
    chain: [],
  };

  // Plugins participate: pitch-lock may swap ctx.buffer for a pre-stretched
  // version, EQ pushes filter stages into ctx.chain, etc.
  runOnPlay(tile, ctx);

  node.buffer = ctx.buffer;
  node.loop = true;
  node.loopStart = ctx.loopStart;
  node.loopEnd = ctx.loopEnd;

  // Wire source → chain[0].input … chain[N].output → gain. The source edge
  // doesn't need tracking (one-shot node). Inter-stage and stage→gain edges
  // are between long-lived nodes, so we remember them to disconnect next play.
  const edges: Array<{ from: AudioNode; to: AudioNode }> = [];
  let prev: AudioNode = node;
  for (const stage of ctx.chain) {
    prev.connect(stage.input);
    if (prev !== node) edges.push({ from: prev, to: stage.input });
    prev = stage.output;
  }
  prev.connect(tile.gainNode);
  if (prev !== node) edges.push({ from: prev, to: tile.gainNode });
  if (edges.length > 0) previousWiring.set(tile, edges);

  tile.audioSource = node;
  tile.audioStartedAt = actx.currentTime;
  // audioStartedOffset is stored in SOURCE time (not buffer time) so that
  // getAudioPosition's `offset + elapsed × speed` formula yields source time
  // identically across pitched and pitch-locked playback.
  tile.audioStartedOffset = offset;
  node.start(0, ctx.startOffset);
}

export function stopAudioSource(tile: Tile): void {
  if (tile.audioSource) {
    try { tile.audioSource.stop(); } catch {}
    try { tile.audioSource.disconnect(); } catch {}
    tile.audioSource = null;
  }
}

// Full teardown of a tile's Web Audio graph: source, plugin chains, gain.
// Called when removing a tile or swapping decks.
export function tearDownTileAudio(tile: Tile): void {
  stopAudioSource(tile);
  disconnectPreviousWiring(tile);
  teardownTilePlugins(tile);
  if (tile.gainNode) {
    try { tile.gainNode.disconnect(); } catch {}
    tile.gainNode = null;
  }
}

export function getAudioPosition(tile: Tile): number {
  const source = getSource(tile);
  if (!tile.audioSource || !source?.audioReady) return tile.loopStart;

  const actx = getAudioCtx();
  const elapsed = actx.currentTime - tile.audioStartedAt;
  // audioStartedOffset is source time. Source time advances at `speed × wall time`
  // in both pitched (BufferSource rate-changed) and pitch-locked (buffer pre-stretched)
  // playback modes, so this formula is mode-agnostic.
  const rawPos = tile.audioStartedOffset + elapsed * getSpeed(tile);
  const loopLen = tile.loopEnd - tile.loopStart;
  if (loopLen <= 0) return tile.loopStart;
  if (rawPos >= tile.loopEnd) {
    return tile.loopStart + ((rawPos - tile.loopStart) % loopLen);
  }
  return rawPos;
}

let chunkRebuildTimeout: ReturnType<typeof setTimeout> | null = null;

export function updateAudioLoopPoints(tile: Tile): void {
  const source = getSource(tile);
  if (!tile.audioSource) return;

  if (source?.chunked) {
    const off = tile._regionOffset ?? 0;
    tile.audioSource.loopStart = tile.loopStart - off;
    tile.audioSource.loopEnd = tile.loopEnd - off;

    if (chunkRebuildTimeout) clearTimeout(chunkRebuildTimeout);
    chunkRebuildTimeout = setTimeout(async () => {
      const firstNeeded = Math.floor(tile.loopStart / source.chunkDuration);
      const lastNeeded = Math.floor(tile.loopEnd / source.chunkDuration);
      const firstLoaded = Math.floor(off / source.chunkDuration);
      const bufDuration = tile.audioSource?.buffer?.duration ?? 0;
      const lastLoaded = Math.floor((off + bufDuration) / source.chunkDuration);

      if (firstNeeded < firstLoaded || lastNeeded > lastLoaded) {
        if (tile.state === 'playing') {
          const pos = getAudioPosition(tile);
          await playAudio(tile, pos);
        }
      }
      preloadAdjacentChunks(source, tile.loopStart, tile.loopEnd);
    }, 300);
  } else {
    tile.audioSource.loopStart = tile.loopStart;
    tile.audioSource.loopEnd = tile.loopEnd;
  }
}

export function syncVideoToAudio(tile: Tile, audioPos: number): void {
  if (!tile.video) return;
  const drift = Math.abs(tile.video.currentTime - audioPos);
  if (drift > 0.15) tile.video.currentTime = audioPos;
  // Chromium can self-pause the <video> after a playbackRate change or a burst
  // of currentTime seeks. Edge-detect: only nudge play() when the element has
  // just transitioned to paused, not every frame while it's still pending.
  const isPaused = tile.video.paused;
  if (isPaused && !tile._lastVideoPaused && tile.state === 'playing') {
    tile.video.play().catch(() => {});
  }
  tile._lastVideoPaused = isPaused;
}

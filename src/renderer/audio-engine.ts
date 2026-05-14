import type { Source, Tile } from './types';
import { getSource, tilesForSource } from './state';
import { getAudioCtx } from './audio-context';
import { stretchAudioBuffer } from './time-stretch';

// 8-band graphic EQ. Logarithmic spacing from bass to air, peaking filters with
// ~2/3-octave bandwidth so adjacent bands overlap musically.
export const EQ_BANDS = [63, 160, 400, 1000, 2500, 6300, 10000, 16000] as const;
export const EQ_Q = 1.41;
export const EQ_BAND_COUNT = EQ_BANDS.length;

function buildEqChain(tile: Tile): BiquadFilterNode[] {
  const actx = getAudioCtx();
  const filters = EQ_BANDS.map((freq, i) => {
    const f = actx.createBiquadFilter();
    f.type = 'peaking';
    f.frequency.value = freq;
    f.Q.value = EQ_Q;
    f.gain.value = tile.eq[i] ?? 0;
    return f;
  });
  for (let i = 0; i < filters.length - 1; i++) {
    filters[i].connect(filters[i + 1]);
  }
  return filters;
}

// Live update from the EQ panel; called on every slider drag.
export function setEqBand(tile: Tile, band: number, gainDB: number): void {
  if (band < 0 || band >= EQ_BAND_COUNT) return;
  tile.eq[band] = gainDB;
  if (tile.eqFilters?.[band]) {
    tile.eqFilters[band].gain.value = gainDB;
  }
}

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
  let offset = 0;
  for (const buf of chunks) {
    for (let ch = 0; ch < channels; ch++) {
      combined.getChannelData(ch).set(buf.getChannelData(ch), offset);
    }
    offset += buf.length;
  }

  return { buffer: combined, offset: firstChunk * source.chunkDuration };
}

function preloadAdjacentChunks(source: Source, start: number, end: number): void {
  const firstChunk = Math.floor(start / source.chunkDuration);
  const lastChunk = Math.floor(end / source.chunkDuration);
  if (firstChunk > 0) decodeChunk(source, firstChunk - 1);
  if (lastChunk < source.chunkCount - 1) decodeChunk(source, lastChunk + 1);
}

export async function playAudio(tile: Tile, offset: number): Promise<void> {
  const source = getSource(tile);
  if (!source?.audioReady) return;

  const actx = getAudioCtx();
  if (actx.state === 'suspended') actx.resume();

  stopAudioSource(tile);

  if (!tile.gainNode) {
    tile.gainNode = actx.createGain();
    tile.gainNode.connect(actx.destination);
  }
  tile.gainNode.gain.value = tile.muted ? 0 : tile.volume;

  // Lazy-build the EQ chain on first play; persists across plays so live slider
  // tweaks never need to rebuild the graph.
  if (!tile.eqFilters) {
    tile.eqFilters = buildEqChain(tile);
    tile.eqFilters[tile.eqFilters.length - 1].connect(tile.gainNode);
  }

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

  // Pitch-lock branch: pre-stretch the loop region so the BufferSource can run
  // at unity rate with original pitch preserved. The video element is left on
  // pitched-rate playback (no realtime video time-stretcher; visual drift is
  // tolerable since audio is the truth).
  const useStretch = tile.pitchLock && Math.abs(tile.speed - 1) > 0.001;
  if (useStretch) {
    const loopRegion = sliceLoopRegion(actx, buffer, loopStart, loopEnd);
    buffer = stretchAudioBuffer(actx, loopRegion, tile.speed);
    // Loop is now the whole stretched buffer.
    startInBuffer = Math.max(0, (startInBuffer - loopStart) / tile.speed);
    loopStart = 0;
    loopEnd = buffer.duration;
  }

  const node = actx.createBufferSource();
  node.buffer = buffer;
  node.loop = true;
  node.loopStart = loopStart;
  node.loopEnd = loopEnd;
  node.playbackRate.value = useStretch ? 1.0 : tile.speed;
  node.connect(tile.eqFilters![0]);

  tile.audioSource = node;
  tile.audioStartedAt = actx.currentTime;
  // audioStartedOffset is stored in SOURCE time (not buffer time) so that
  // getAudioPosition's `offset + elapsed × speed` formula yields source time
  // identically across all three modes (non-chunked, chunked, pitch-locked).
  tile.audioStartedOffset = offset;
  node.start(0, startInBuffer);

  if (tile.video) tile.video.playbackRate = tile.speed;
}

function sliceLoopRegion(ctx: BaseAudioContext, buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const start = Math.max(0, Math.floor(startSec * buffer.sampleRate));
  const end = Math.min(buffer.length, Math.floor(endSec * buffer.sampleRate));
  const length = Math.max(1, end - start);
  const slice = ctx.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    slice.getChannelData(ch).set(buffer.getChannelData(ch).subarray(start, end));
  }
  return slice;
}

export function stopAudioSource(tile: Tile): void {
  if (tile.audioSource) {
    try { tile.audioSource.stop(); } catch {}
    try { tile.audioSource.disconnect(); } catch {}
    tile.audioSource = null;
  }
}

// Full teardown of a tile's Web Audio graph: source, EQ filters, gain.
// Called when removing a tile or swapping decks.
export function tearDownTileAudio(tile: Tile): void {
  stopAudioSource(tile);
  if (tile.eqFilters) {
    for (const f of tile.eqFilters) { try { f.disconnect(); } catch {} }
    tile.eqFilters = null;
  }
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
  const rawPos = tile.audioStartedOffset + elapsed * tile.speed;
  const loopLen = tile.loopEnd - tile.loopStart;
  if (loopLen <= 0) return tile.loopStart;
  if (rawPos >= tile.loopEnd) {
    return tile.loopStart + ((rawPos - tile.loopStart) % loopLen);
  }
  return rawPos;
}

// Live-update speed. Rebases timing so the audio position is preserved across
// the rate change. In pitch-locked mode the stretched buffer would need to be
// re-rendered (expensive, ~50–400ms), so we update tile.speed immediately but
// debounce the actual rebuild — slider drags settle into a single rebuild on
// release. Timer lives on the tile so concurrent edits on multiple tiles don't
// cancel each other's rebuild.
export function setTileSpeed(tile: Tile, speed: number): void {
  if (speed === tile.speed) return;

  if (tile.pitchLock) {
    const pos = tile.audioSource ? getAudioPosition(tile) : tile.loopStart;
    tile.speed = speed;
    if (tile.video) tile.video.playbackRate = speed;

    if (tile._pitchLockTimer) clearTimeout(tile._pitchLockTimer);
    tile._pitchLockTimer = setTimeout(() => {
      tile._pitchLockTimer = null;
      if (tile.pitchLock && tile.audioSource) playAudio(tile, pos);
    }, 180);
    return;
  }

  // Pitched mode: change BufferSource.playbackRate in place. Cheap, no rebuild.
  if (tile.audioSource) {
    const pos = getAudioPosition(tile);
    tile.audioStartedOffset = pos;
    tile.audioStartedAt = getAudioCtx().currentTime;
    tile.audioSource.playbackRate.value = speed;
  }
  tile.speed = speed;
  if (tile.video) tile.video.playbackRate = speed;
}

// Toggle pitch-lock and restart playback at the current position so the new
// mode applies immediately.
export function setTilePitchLock(tile: Tile, locked: boolean): void {
  if (tile.pitchLock === locked) return;
  tile.pitchLock = locked;
  if (tile.audioSource) {
    const pos = getAudioPosition(tile);
    playAudio(tile, pos);
  }
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

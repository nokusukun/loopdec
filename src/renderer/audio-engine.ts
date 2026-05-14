import type { Source, Tile } from './types';
import { getSource, tilesForSource } from './state';
import { getAudioCtx } from './audio-context';

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

  let buffer: AudioBuffer, loopStart: number, loopEnd: number, startOffset: number;

  if (source.chunked) {
    await loadChunksForRegion(source, tile.loopStart, tile.loopEnd);
    const region = buildRegionBuffer(source, tile.loopStart, tile.loopEnd);
    if (!region) return;
    buffer = region.buffer;
    loopStart = tile.loopStart - region.offset;
    loopEnd = tile.loopEnd - region.offset;
    startOffset = offset - region.offset;
    tile._regionOffset = region.offset;
    preloadAdjacentChunks(source, tile.loopStart, tile.loopEnd);
  } else {
    if (!source.audioBuffer) return;
    buffer = source.audioBuffer;
    loopStart = tile.loopStart;
    loopEnd = tile.loopEnd;
    startOffset = offset;
    tile._regionOffset = 0;
  }

  const node = actx.createBufferSource();
  node.buffer = buffer;
  node.loop = true;
  node.loopStart = loopStart;
  node.loopEnd = loopEnd;
  node.connect(tile.gainNode);

  tile.audioSource = node;
  tile.audioStartedAt = actx.currentTime;
  tile.audioStartedOffset = startOffset;
  node.start(0, startOffset);
}

export function stopAudioSource(tile: Tile): void {
  if (tile.audioSource) {
    try { tile.audioSource.stop(); } catch {}
    try { tile.audioSource.disconnect(); } catch {}
    tile.audioSource = null;
  }
}

export function getAudioPosition(tile: Tile): number {
  const source = getSource(tile);
  if (!tile.audioSource || !source?.audioReady) return tile.loopStart;

  const actx = getAudioCtx();
  const elapsed = actx.currentTime - tile.audioStartedAt;
  const regionOff = tile._regionOffset ?? 0;
  const rawPos = tile.audioStartedOffset + elapsed + regionOff;
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
}

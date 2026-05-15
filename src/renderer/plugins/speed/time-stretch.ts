// Public time-stretch API for the Speed plugin.
//
//   stretchAudioBuffer       — sync, main-thread fallback. Used only when the
//                              worker pool cannot be created.
//   stretchAudioBufferAsync  — worker-backed. Large inputs are split into
//                              consecutive input chunks, stretched in parallel
//                              across a worker pool, then overlap-added back
//                              together at the boundaries (the existing OLA
//                              Hann fade-in/fade-out on each chunk's edges
//                              sums to unity at HOP_OUT overlap, so no seam).
//
// Both paths share the kernel via stretch-core.ts.

import { stretchChannels } from './stretch-core';

// Must mirror stretch-core's grain math so the chunk overlap matches what
// the kernel actually produces.
const GRAIN_MS = 40;
function hopOutFor(sampleRate: number): number {
  const grain = Math.max(64, Math.floor(sampleRate * GRAIN_MS / 1000));
  return grain >> 1;
}

// Above this many input samples, switch from a single worker dispatch to
// the parallel chunked path. Below the threshold parallelism overhead is a
// loss; the single-shot path is fine.
const CHUNK_PARALLEL_THRESHOLD_SECONDS = 30;
// Per-chunk input duration. Picked so that even at minimum tempo the chunk's
// stretched output far exceeds HOP_OUT, and so we get a reasonable number of
// chunks for a 4–8 worker pool on minute-scale loops.
const CHUNK_INPUT_SECONDS = 8;

function audioBufferFromChannels(
  ctx: BaseAudioContext,
  channels: Float32Array[],
  sampleRate: number,
): AudioBuffer {
  const buf = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
  for (let ch = 0; ch < channels.length; ch++) {
    // copyToChannel's TS sig requires Float32Array<ArrayBuffer>; channels from
    // the worker arrive as Float32Array<ArrayBufferLike>. Re-wrap so the call
    // type-checks and the engine still gets a typed-array fast path.
    const view = new Float32Array(channels[ch].length);
    view.set(channels[ch]);
    buf.copyToChannel(view, ch, 0);
  }
  return buf;
}

export function stretchAudioBuffer(
  ctx: BaseAudioContext,
  input: AudioBuffer,
  tempo: number,
): AudioBuffer {
  if (Math.abs(tempo - 1) < 0.001 || input.length === 0) return input;
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < input.numberOfChannels; ch++) {
    const copy = new Float32Array(input.length);
    input.copyFromChannel(copy, ch, 0);
    channels.push(copy);
  }
  const out = stretchChannels(channels, input.sampleRate, tempo);
  return audioBufferFromChannels(ctx, out, input.sampleRate);
}

// ── Worker pool ───────────────────────────────────────────────────────
//
// Workers are created lazily on first stretch request. Each handles one
// (input → stretched output) job at a time; the pool feeds jobs from a
// queue, so dispatch is naturally load-balanced — fast workers grab more
// chunks than slow ones without any explicit scheduling.

interface Job {
  channelBufs: ArrayBuffer[];
  sampleRate: number;
  tempo: number;
  resolve: (channels: Float32Array[]) => void;
}

const workers: Worker[] = [];
const idleWorkers: Worker[] = [];
const jobQueue: Job[] = [];
const pending = new Map<number, (channels: Float32Array[]) => void>();
let nextJobId = 1;
let poolInitTried = false;

function ensurePool(): boolean {
  if (poolInitTried) return workers.length > 0;
  poolInitTried = true;

  const size = Math.max(2, Math.min(navigator.hardwareConcurrency || 4, 8));
  try {
    for (let i = 0; i < size; i++) {
      const w = new Worker('stretch-worker.js');
      w.addEventListener('message', (e: MessageEvent<{ id: number; channels: ArrayBuffer[] }>) => {
        const { id, channels } = e.data;
        const resolve = pending.get(id);
        if (resolve) {
          pending.delete(id);
          resolve(channels.map(b => new Float32Array(b)));
        }
        idleWorkers.push(w);
        flushQueue();
      });
      w.addEventListener('error', (e) => {
        console.warn('stretch worker error', e.message);
      });
      workers.push(w);
      idleWorkers.push(w);
    }
    console.info(`[stretch] worker pool ready (${workers.length})`);
  } catch (e) {
    console.warn('stretch worker pool init failed; falling back to sync', e);
    workers.length = 0;
    idleWorkers.length = 0;
  }
  return workers.length > 0;
}

function flushQueue(): void {
  while (idleWorkers.length > 0 && jobQueue.length > 0) {
    const w = idleWorkers.shift()!;
    const job = jobQueue.shift()!;
    const id = nextJobId++;
    pending.set(id, job.resolve);
    w.postMessage(
      { id, channels: job.channelBufs, sampleRate: job.sampleRate, tempo: job.tempo },
      job.channelBufs as Transferable[],
    );
  }
}

function dispatchChunk(channels: Float32Array[], sampleRate: number, tempo: number): Promise<Float32Array[]> {
  // Copy + take ownership of the underlying buffers so we can transfer them.
  // The caller's channels are kept intact (subarrays of source data).
  const channelBufs: ArrayBuffer[] = channels.map(ch => {
    const copy = new Float32Array(ch.length);
    copy.set(ch);
    return copy.buffer;
  });
  return new Promise(resolve => {
    jobQueue.push({ channelBufs, sampleRate, tempo, resolve });
    flushQueue();
  });
}

// ── Progressive chunked stretch ───────────────────────────────────────
//
// Split input into consecutive chunks (no input overlap). Each chunk is
// dispatched to the worker pool and stretched independently. As results
// return, they are read-modify-written into a pre-allocated output buffer:
// the existing OLA Hann fade-in/fade-out at each chunk's edges sum to
// unity at HOP_OUT overlap, so adjacent chunks join seamlessly regardless
// of arrival order.
//
// The returned buffer reference is the SAME memory the workers write into,
// so the caller can mount it on a BufferSourceNode immediately. Playback
// reads zeros wherever chunks haven't landed yet — typically a brief silent
// window of tens of milliseconds before the worker pool catches up.

export interface ProgressiveStretch {
  buffer: AudioBuffer;
  done: Promise<void>;        // resolves once every chunk has been written
  chunkCount: number;         // for diagnostics
}

export function stretchAudioBufferProgressive(
  ctx: BaseAudioContext,
  input: AudioBuffer,
  tempo: number,
  /**
   * Output sample offset that the caller is about to play from. The chunk
   * containing this offset is dispatched first, then chunks radiating
   * outward — minimises the silent window at the playhead.
   */
  prioritySampleOffset: number = 0,
): ProgressiveStretch {
  // No-stretch passthrough — caller still gets the "progressive" shape so
  // the call sites don't have to branch.
  if (Math.abs(tempo - 1) < 0.001 || input.length === 0) {
    return { buffer: input, done: Promise.resolve(), chunkCount: 0 };
  }
  if (!ensurePool()) {
    // Worker pool unavailable — fall back to sync. UI freezes; rare path.
    return { buffer: stretchAudioBuffer(ctx, input, tempo), done: Promise.resolve(), chunkCount: 1 };
  }

  const sampleRate = input.sampleRate;
  const inLen = input.length;
  const numChannels = input.numberOfChannels;
  const chunkInLen = Math.floor(CHUNK_INPUT_SECONDS * sampleRate);
  const hopOut = hopOutFor(sampleRate);
  const grain = Math.max(64, Math.floor(sampleRate * GRAIN_MS / 1000));

  // Plan the chunks: each one's input range and its destination offset in
  // the final buffer. Adjacent chunks overlap by HOP_OUT in the output so
  // their natural Hann edges sum to unity at the boundary.
  interface Chunk { inStart: number; inLen: number; outStart: number; outLen: number; }
  const chunks: Chunk[] = [];
  let writePos = 0;
  for (let start = 0; start < inLen; start += chunkInLen) {
    const len = Math.min(chunkInLen, inLen - start);
    const outLen = Math.max(grain, Math.floor(len / tempo));
    chunks.push({ inStart: start, inLen: len, outStart: writePos, outLen });
    writePos += outLen - hopOut;
  }
  // The trailing chunk's HOP_OUT isn't consumed by any successor — add it back.
  const totalLen = writePos + hopOut;
  const buffer = ctx.createBuffer(numChannels, totalLen, sampleRate);

  // Pull each input channel into a Float32Array once. Subarrays are passed
  // to dispatchChunk, which itself copies before transferring to the worker.
  const inputChannels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    const copy = new Float32Array(inLen);
    input.copyFromChannel(copy, ch, 0);
    inputChannels.push(copy);
  }

  // Dispatch order: chunk that contains prioritySampleOffset first, then
  // expand outward symmetrically. Workers pick from the queue in FIFO,
  // so head-of-queue chunks finish first.
  let priorityIdx = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].outStart + chunks[i].outLen > prioritySampleOffset) { priorityIdx = i; break; }
    priorityIdx = i;
  }
  const order: number[] = [priorityIdx];
  for (let d = 1; d < chunks.length; d++) {
    if (priorityIdx + d < chunks.length) order.push(priorityIdx + d);
    if (priorityIdx - d >= 0) order.push(priorityIdx - d);
  }

  let chunksDone = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>(r => { resolveDone = r; });

  for (const idx of order) {
    const chunk = chunks[idx];
    const chunkChannels = inputChannels.map(c => c.subarray(chunk.inStart, chunk.inStart + chunk.inLen));
    dispatchChunk(chunkChannels, sampleRate, tempo).then(result => {
      const len = result[0].length;
      // Read-modify-write: at chunk boundaries, the existing buffer already
      // holds a Hann fade from the neighbour. Adding our fade reconstructs
      // unity. Order-independent because addition is commutative.
      const tmp = new Float32Array(len);
      for (let c = 0; c < numChannels; c++) {
        buffer.copyFromChannel(tmp, c, chunk.outStart);
        for (let s = 0; s < len; s++) tmp[s] += result[c][s];
        buffer.copyToChannel(tmp, c, chunk.outStart);
      }
      chunksDone++;
      if (chunksDone === chunks.length) resolveDone();
    }).catch((err) => {
      console.warn('[stretch] chunk failed', { idx, err });
      // Resolve done anyway after all chunks attempted, so callers don't hang.
      chunksDone++;
      if (chunksDone === chunks.length) resolveDone();
    });
  }

  return { buffer, done, chunkCount: chunks.length };
}

export async function stretchAudioBufferAsync(
  ctx: BaseAudioContext,
  input: AudioBuffer,
  tempo: number,
): Promise<AudioBuffer> {
  if (Math.abs(tempo - 1) < 0.001 || input.length === 0) return input;
  if (!ensurePool()) return stretchAudioBuffer(ctx, input, tempo);

  // For small inputs use the single-shot path — avoids progressive overhead.
  if (input.length <= CHUNK_PARALLEL_THRESHOLD_SECONDS * input.sampleRate) {
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < input.numberOfChannels; ch++) {
      const copy = new Float32Array(input.length);
      input.copyFromChannel(copy, ch, 0);
      channels.push(copy);
    }
    const out = await dispatchChunk(channels, input.sampleRate, tempo);
    return audioBufferFromChannels(ctx, out, input.sampleRate);
  }

  const { buffer, done } = stretchAudioBufferProgressive(ctx, input, tempo, 0);
  await done;
  return buffer;
}

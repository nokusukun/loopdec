// Web Worker entry: runs OLA/WSOLA off the main thread. The hot loop is in
// WASM (compiled from stretch.as.ts) — falls back to the pure-JS kernel in
// stretch-core.ts if WASM init fails.

import { stretchChannels } from './stretch-core';

interface WasmStretch {
  memory: WebAssembly.Memory;
  stretchMono(
    inPtr: number, inLen: number,
    outPtr: number, outLen: number,
    scratchPtr: number,
    sampleRate: number, tempo: number,
  ): void;
  plannedOutputLength(inLen: number, sampleRate: number, tempo: number): number;
}

const PAGE = 65536;
const SCRATCH_BYTES = 64 * 1024;  // 64 KB — enough for a grain of any plausible sample rate

let wasm: WasmStretch | null = null;
const wasmReady = (async () => {
  try {
    const response = await fetch('stretch.wasm');
    if (!response.ok) throw new Error(`fetch ${response.status}`);
    const bytes = await response.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    wasm = instance.exports as unknown as WasmStretch;
  } catch (e) {
    console.warn('stretch wasm init failed; using JS fallback', e);
  }
})();

function stretchWasm(input: Float32Array[], sampleRate: number, tempo: number): Float32Array[] {
  const w = wasm!;
  const inLen = input[0].length;
  const outLen = w.plannedOutputLength(inLen, sampleRate, tempo);

  // Layout: [scratch (64KB)] [input (inLen × 4)] [output (outLen × 4)]
  const inBytes  = inLen * 4;
  const outBytes = outLen * 4;
  const need = SCRATCH_BYTES + inBytes + outBytes;
  const pagesNeeded = Math.ceil(need / PAGE);
  const havePages = w.memory.buffer.byteLength / PAGE;
  if (pagesNeeded > havePages) w.memory.grow(pagesNeeded - havePages);

  const scratchPtr = 0;
  const inPtr  = SCRATCH_BYTES;
  const outPtr = SCRATCH_BYTES + inBytes;

  const outputs: Float32Array[] = [];
  for (let ch = 0; ch < input.length; ch++) {
    // Re-create views each iteration: memory.grow can detach the buffer.
    new Float32Array(w.memory.buffer, inPtr, inLen).set(input[ch]);
    new Float32Array(w.memory.buffer, outPtr, outLen).fill(0);

    w.stretchMono(inPtr, inLen, outPtr, outLen, scratchPtr, sampleRate, tempo);

    const result = new Float32Array(outLen);
    result.set(new Float32Array(w.memory.buffer, outPtr, outLen));
    outputs.push(result);
  }
  return outputs;
}

interface StretchJob {
  id: number;
  channels: ArrayBuffer[];
  sampleRate: number;
  tempo: number;
}

self.addEventListener('message', async (e: MessageEvent<StretchJob>) => {
  await wasmReady;
  const { id, channels, sampleRate, tempo } = e.data;
  const input = channels.map((b) => new Float32Array(b));
  const output = wasm ? stretchWasm(input, sampleRate, tempo) : stretchChannels(input, sampleRate, tempo);
  const buffers = output.map(c => c.buffer);
  (self as unknown as Worker).postMessage(
    { id, channels: buffers },
    buffers as Transferable[],
  );
});

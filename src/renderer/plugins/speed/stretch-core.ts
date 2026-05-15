// OLA + WSOLA granular time-stretch — pure math, no Web Audio types.
// Imported by both the main-thread sync wrapper (time-stretch.ts) and the
// worker entry (stretch-worker.ts) so they share the same algorithm.
//
// Convention: `tempo` matches the user-facing speed —
//   tempo = 0.5  →  output is 2× as long (slower playback, same pitch)
//   tempo = 2.0  →  output is 0.5× as long (faster playback, same pitch)

const GRAIN_MS = 40;
// WSOLA search half-window. Must span at least one full period of the
// lowest content frequency, otherwise grain placement can't lock to it and
// we hear audible warble / phase beating. Threshold table at 44.1 kHz:
//   2 ms → catches ≥ 500 Hz   (whistle, sibilants, treble)
//   5 ms → catches ≥ 200 Hz   (most vocal range, mid instruments)
//  10 ms → catches ≥ 100 Hz   (male voice, low instruments, kick body)
//  20 ms → catches ≥  50 Hz   (sub-bass)
// 10ms is the sampler default — covers musical content down through bass.
// Cost in the inner correlation loop is linear in this value; we offset it
// with coarse-to-fine search below.
const SEARCH_MS = 10;
// Fine pass stride: 1 = evaluate every sample for the cleanest alignment.
const SEARCH_STEP = 1;
// Coarse-to-fine scheme: the full search is expensive with SEARCH_MS=10,
// so we sweep every COARSE_STEP-th offset to locate the correlation peak,
// then refine within ±COARSE_STEP of the winner at step 1. This is safe
// because correlation peaks for tonal content are at least one pitch
// period wide (≥ 100 Hz → 441 samples at 44.1 kHz), so a stride of 8
// samples (≈ 0.18 ms) can't fall between adjacent peaks.
const COARSE_STEP = 8;

function buildHann(grain: number): Float32Array {
  const w = new Float32Array(grain);
  for (let i = 0; i < grain; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grain - 1));
  }
  return w;
}

export function stretchChannels(
  channels: Float32Array[],
  sampleRate: number,
  tempo: number,
): Float32Array[] {
  if (channels.length === 0 || channels[0].length === 0) return channels;
  if (Math.abs(tempo - 1) < 0.001) return channels.map(c => new Float32Array(c));

  const inputLength = channels[0].length;
  const GRAIN  = Math.max(64, Math.floor(sampleRate * (GRAIN_MS / 1000)));
  const HOP_OUT = Math.floor(GRAIN / 2);
  const HOP_IN  = Math.max(1, Math.floor(HOP_OUT * tempo));
  const SEARCH  = Math.max(8, Math.floor(sampleRate * (SEARCH_MS / 1000)));
  const win = buildHann(GRAIN);

  const outputLength = Math.max(GRAIN, Math.floor(inputLength / tempo));
  const out: Float32Array[] = channels.map(() => new Float32Array(outputLength));

  for (let ch = 0; ch < channels.length; ch++) {
    const inData  = channels[ch];
    const outData = out[ch];

    for (let i = 0; i < GRAIN && i < inData.length && i < outputLength; i++) {
      outData[i] = inData[i] * win[i];
    }
    let outPos = HOP_OUT;
    let inPos  = HOP_IN;

    while (outPos + GRAIN <= outputLength && inPos + GRAIN <= inData.length) {
      // WSOLA coarse-to-fine search. Phase 1 sweeps the full ±SEARCH range
      // at COARSE_STEP stride; Phase 2 refines around that winner at step 1.
      // Keeps grain alignment within 1 sample of the true peak at a small
      // fraction of full-search cost.
      let bestOffset = 0;
      let bestScore  = -Infinity;
      for (let offset = -SEARCH; offset <= SEARCH; offset += COARSE_STEP) {
        const start = inPos + offset;
        if (start < 0 || start + HOP_OUT > inData.length) continue;
        let score = 0;
        for (let i = 0; i < HOP_OUT; i++) {
          score += outData[outPos + i] * inData[start + i];
        }
        if (score > bestScore) { bestScore = score; bestOffset = offset; }
      }
      const fineLo = Math.max(-SEARCH, bestOffset - COARSE_STEP + 1);
      const fineHi = Math.min( SEARCH, bestOffset + COARSE_STEP - 1);
      for (let offset = fineLo; offset <= fineHi; offset += SEARCH_STEP) {
        if (offset === bestOffset) continue;
        const start = inPos + offset;
        if (start < 0 || start + HOP_OUT > inData.length) continue;
        let score = 0;
        for (let i = 0; i < HOP_OUT; i++) {
          score += outData[outPos + i] * inData[start + i];
        }
        if (score > bestScore) { bestScore = score; bestOffset = offset; }
      }

      const grainStart = inPos + bestOffset;
      for (let i = 0; i < GRAIN; i++) {
        if (grainStart + i >= 0 && grainStart + i < inData.length) {
          outData[outPos + i] += inData[grainStart + i] * win[i];
        }
      }

      outPos += HOP_OUT;
      inPos  += HOP_IN;
    }
  }

  return out;
}

// OLA + WSOLA granular time-stretch — pure math, no Web Audio types.
// Imported by both the main-thread sync wrapper (time-stretch.ts) and the
// worker entry (stretch-worker.ts) so they share the same algorithm.
//
// Convention: `tempo` matches the user-facing speed —
//   tempo = 0.5  →  output is 2× as long (slower playback, same pitch)
//   tempo = 2.0  →  output is 0.5× as long (faster playback, same pitch)

const GRAIN_MS = 40;
// WSOLA search half-window. Smaller = faster, fewer offsets to correlate.
// 2ms covers most pitch periods above ~250 Hz, which is good enough for
// sample-style loops; below that we accept some phasing.
const SEARCH_MS = 2;
// Stride through the search range. 2 cuts correlation evaluations in half
// for a small quality cost — picked grains are still within 1 sample of the
// best, never the *worst* match.
const SEARCH_STEP = 2;

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
      // WSOLA: pick the input start within ±SEARCH that best correlates with
      // the overlap region we're about to write into.
      let bestOffset = 0;
      let bestScore  = -Infinity;
      for (let offset = -SEARCH; offset <= SEARCH; offset += SEARCH_STEP) {
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

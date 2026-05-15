// AssemblyScript port of the OLA/WSOLA time-stretch kernel.
// Operates directly on linear WASM memory: caller writes one channel of
// input at `inPtr`, allocates space for the output at `outPtr`, and provides
// `scratchPtr` for the Hann window. No runtime allocations, no GC.
//
// Compile with `--runtime stub` so the produced module is essentially a
// raw computational core — no AS heap, no managed types.

const GRAIN_MS:    f32 = 40.0;
// Must mirror stretch-core.ts. 10ms half-window covers pitch periods down
// to ~100 Hz (male vocals, kick body, bass). We pay for that with a
// coarse-to-fine search: sweep ±SEARCH at COARSE_STEP, then refine within
// ±(COARSE_STEP-1) at step 1. Total inner loops ≈ SEARCH/4 + 15, vs full
// 2·SEARCH+1, with no perceptible quality loss for musical content.
const SEARCH_MS:   f32 = 10.0;
const SEARCH_STEP: i32 = 1;
const COARSE_STEP: i32 = 8;

// Predict the output sample count for a given input length / tempo.
// JS uses this to size the output region of memory before calling stretchMono.
export function plannedOutputLength(inLen: i32, sampleRate: f32, tempo: f32): i32 {
  const grain = max(64, i32(Mathf.floor(sampleRate * GRAIN_MS / 1000.0)));
  if (Mathf.abs(tempo - 1.0) < 1e-3 || inLen <= 0) return inLen;
  return max(grain, i32(Mathf.floor(f32(inLen) / tempo)));
}

// Stretch one mono channel.
//   in:     [inPtr, inPtr + inLen*4)
//   out:    [outPtr, outPtr + outLen*4)         — must be zero-cleared by caller
//   scratch: [scratchPtr, scratchPtr + grain*4)  — work area for Hann window
export function stretchMono(
  inPtr: i32,   inLen: i32,
  outPtr: i32,  outLen: i32,
  scratchPtr: i32,
  sampleRate: f32, tempo: f32,
): void {
  if (inLen <= 0 || outLen <= 0) return;

  // tempo ≈ 1: pass-through copy.
  if (Mathf.abs(tempo - 1.0) < 1e-3) {
    const n = inLen < outLen ? inLen : outLen;
    for (let i: i32 = 0; i < n; i++) {
      store<f32>(outPtr + (i << 2), load<f32>(inPtr + (i << 2)));
    }
    return;
  }

  const grain  = max(64, i32(Mathf.floor(sampleRate * GRAIN_MS / 1000.0)));
  const hopOut = grain >> 1;
  const hopIn  = max(1, i32(Mathf.floor(f32(hopOut) * tempo)));
  const search = max(8, i32(Mathf.floor(sampleRate * SEARCH_MS / 1000.0)));

  // Build the Hann window into the scratch region.
  const denom: f32 = f32(grain - 1);
  for (let i: i32 = 0; i < grain; i++) {
    const v: f32 = <f32>0.5 - <f32>0.5 * Mathf.cos(<f32>2.0 * <f32>Mathf.PI * f32(i) / denom);
    store<f32>(scratchPtr + (i << 2), v);
  }

  // First grain: just place at the start (no similarity search yet).
  const first = grain < inLen ? (grain < outLen ? grain : outLen) : inLen;
  for (let i: i32 = 0; i < first; i++) {
    const s: f32 = load<f32>(inPtr  + (i << 2));
    const w: f32 = load<f32>(scratchPtr + (i << 2));
    store<f32>(outPtr + (i << 2), s * w);
  }

  let outPos: i32 = hopOut;
  let inPos:  i32 = hopIn;

  while (outPos + grain <= outLen && inPos + grain <= inLen) {
    // WSOLA coarse-to-fine. Phase 1: sweep ±SEARCH at COARSE_STEP stride to
    // locate the correlation peak's neighbourhood. Phase 2: refine within
    // ±(COARSE_STEP-1) of that winner at step 1 for the final pick.
    let bestOffset: i32 = 0;
    let bestScore:  f32 = <f32>-3.4e38;

    let offset: i32 = -search;
    while (offset <= search) {
      const start: i32 = inPos + offset;
      if (start >= 0 && start + hopOut <= inLen) {
        let score: f32 = 0.0;
        const outBase: i32 = outPtr + (outPos << 2);
        const inBase:  i32 = inPtr  + (start  << 2);
        for (let i: i32 = 0; i < hopOut; i++) {
          score += load<f32>(outBase + (i << 2)) * load<f32>(inBase + (i << 2));
        }
        if (score > bestScore) { bestScore = score; bestOffset = offset; }
      }
      offset += COARSE_STEP;
    }

    let fineLo: i32 = bestOffset - COARSE_STEP + 1;
    let fineHi: i32 = bestOffset + COARSE_STEP - 1;
    if (fineLo < -search) fineLo = -search;
    if (fineHi >  search) fineHi =  search;
    offset = fineLo;
    while (offset <= fineHi) {
      if (offset != bestOffset) {
        const start: i32 = inPos + offset;
        if (start >= 0 && start + hopOut <= inLen) {
          let score: f32 = 0.0;
          const outBase: i32 = outPtr + (outPos << 2);
          const inBase:  i32 = inPtr  + (start  << 2);
          for (let i: i32 = 0; i < hopOut; i++) {
            score += load<f32>(outBase + (i << 2)) * load<f32>(inBase + (i << 2));
          }
          if (score > bestScore) { bestScore = score; bestOffset = offset; }
        }
      }
      offset += SEARCH_STEP;
    }

    const grainStart: i32 = inPos + bestOffset;
    for (let i: i32 = 0; i < grain; i++) {
      const idx: i32 = grainStart + i;
      if (idx >= 0 && idx < inLen) {
        const accumPtr: i32 = outPtr + ((outPos + i) << 2);
        const cur: f32 = load<f32>(accumPtr);
        const s: f32   = load<f32>(inPtr + (idx << 2));
        const w: f32   = load<f32>(scratchPtr + (i << 2));
        store<f32>(accumPtr, cur + s * w);
      }
    }

    outPos += hopOut;
    inPos  += hopIn;
  }
}

let sharedAudioCtx: AudioContext | null = null;

// Pluggable hook so a sibling module (audio-output) can apply the stored device
// the first time the context is created — avoids a circular import.
let onCreate: ((ctx: AudioContext) => void) | null = null;
export function onAudioContextCreated(fn: (ctx: AudioContext) => void): void {
  onCreate = fn;
}

export function getAudioCtx(): AudioContext {
  if (!sharedAudioCtx) {
    sharedAudioCtx = new AudioContext();
    onCreate?.(sharedAudioCtx);
  }
  return sharedAudioCtx;
}

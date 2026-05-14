let sharedAudioCtx: AudioContext | null = null;

export function getAudioCtx(): AudioContext {
  if (!sharedAudioCtx) sharedAudioCtx = new AudioContext();
  return sharedAudioCtx;
}

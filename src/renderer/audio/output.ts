// Picks the output audio device for the whole app.
//
// Two surfaces need the deviceId set:
//   1. The shared AudioContext (Web Audio path — most playback)
//   2. Every <video> element (used when a source's audio hasn't been extracted yet)
//
// Stored in localStorage so the choice survives restarts. Empty string = system default.

import { getAudioCtx } from './context';
import { tiles } from '../state';

const STORAGE_KEY = 'loopdec-output-device';

let currentDeviceId = '';

// Some Chromium versions have setSinkId on AudioContext via a vendor-prefix or
// via the option bag in the constructor. We feature-detect on the instance.
interface SinkIdable { setSinkId(id: string): Promise<void>; }
function hasSinkId(x: unknown): x is SinkIdable {
  return !!x && typeof (x as SinkIdable).setSinkId === 'function';
}

export function getOutputDeviceId(): string {
  return currentDeviceId;
}

export async function applyDeviceToVideo(video: HTMLVideoElement): Promise<void> {
  if (!currentDeviceId) return;
  if (hasSinkId(video)) {
    try { await video.setSinkId(currentDeviceId); } catch {}
  }
}

export async function setOutputDevice(deviceId: string): Promise<void> {
  currentDeviceId = deviceId;
  localStorage.setItem(STORAGE_KEY, deviceId);

  const ctx = getAudioCtx();
  if (hasSinkId(ctx)) {
    try { await ctx.setSinkId(deviceId); }
    catch (e) { console.warn('AudioContext.setSinkId failed:', e); }
  }

  for (const tile of tiles.values()) {
    if (tile.video && hasSinkId(tile.video)) {
      try { await tile.video.setSinkId(deviceId); } catch {}
    }
  }
}

// Load the stored ID at startup; doesn't apply yet because the AudioContext
// is created lazily on first playback. applyStoredDevice() is called from there.
export function restoreOutputDevice(): void {
  currentDeviceId = localStorage.getItem(STORAGE_KEY) ?? '';
}

// Called by getAudioCtx the first time it creates the context.
export function applyStoredDeviceToContext(ctx: AudioContext): void {
  if (!currentDeviceId) return;
  if (hasSinkId(ctx)) {
    ctx.setSinkId(currentDeviceId).catch(() => {});
  }
}

export async function enumerateOutputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'audiooutput');
  } catch {
    return [];
  }
}

// State shared between the waveform editor, the tile grid, and the snap controls.
// Kept in dedicated objects so multiple modules can mutate the same singleton.

export const editor = {
  tileId: null as string | null,
  viewStart: 0,
  viewEnd: 0,
  cachedPeaks: null as Float32Array | null,
  animId: null as number | null,
  dragCleanup: null as (() => void) | null,
};

export const snap = {
  interval: 0,
  offset: 0,
};

export function snapTime(time: number, interval: number): number {
  if (interval <= 0) return time;
  return Math.round((time - snap.offset) / interval) * interval + snap.offset;
}

import type { GridShape } from '../shared/types';
export type { GridShape };

export interface Source {
  id: string;
  url: string;
  title: string;
  duration: number;
  audioBuffer: AudioBuffer | null;
  audioReady: boolean;
  chunked: boolean;
  chunkCount: number;
  chunkDuration: number;
  decodedChunks: Map<number, AudioBuffer> | null;
  peaks: Float32Array | null;
}

export interface TileEls {
  tile: HTMLElement;
  dragHandle: HTMLElement;
  address: HTMLElement;
  speedPill: HTMLElement;
  videoContainer: HTMLElement;
  downloadLabel: HTMLElement;
  progressFill: HTMLElement;
  title: HTMLElement;
  loopRegion: HTMLElement;
  loopPlayhead: HTMLElement;
  timeCurrent: HTMLElement;
  timeRange: HTMLElement;
  playBtn: HTMLButtonElement;
  toggleBtn: HTMLButtonElement;
  muteBtn: HTMLButtonElement;
  volumeSlider: HTMLInputElement;
}

export type TileState = 'downloading' | 'paused' | 'playing' | 'error';

export interface Tile {
  id: string;
  sourceId: string;
  loopStart: number;
  loopEnd: number;
  enabled: boolean;
  state: TileState;
  video: HTMLVideoElement | null;
  audioSource: AudioBufferSourceNode | null;
  audioStartedAt: number;
  audioStartedOffset: number;
  _pausedAt?: number;
  _wasPlaying?: boolean;
  _regionOffset?: number;
  // Tracks the previous frame's video.paused to edge-detect Chromium auto-pause
  // and avoid spamming play() every animation frame while stuck-paused.
  _lastVideoPaused?: boolean;
  animFrameId: number | null;
  volume: number;
  gainNode: GainNode | null;
  muted: boolean;
  els: TileEls;
  row?: number;
  col?: number;
  // Per-plugin state slots. Each registered plugin owns one slot keyed by its id.
  // Persisted via plugin's serialize/hydrate.
  plugins: Record<string, unknown>;
}

export interface DeckMeta {
  name: string;
  description: string;
  created: string | null;
  modified: string | null;
  // Filesystem path of the deck currently being edited. null = unsaved or new deck.
  // Used by Save (in-place) vs Save As (always prompt). Not persisted to the deck file.
  path: string | null;
}

export interface CommandItem {
  id: string;
  label?: string;
  sublabel?: string;
  hint?: string;
  action?: () => void;
  separator?: boolean;
}

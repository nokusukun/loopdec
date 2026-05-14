// Persisted shapes that flow between main ↔ renderer (manifest, decks)
// and the in-memory shapes the renderer uses to drive the UI.

export interface SourcePersisted {
  id: string;
  url: string;
  title: string;
  duration: number;
  chunked: boolean;
  chunkCount: number;
  chunkDuration: number;
}

export interface TilePersisted {
  id: string;
  sourceId: string;
  loopStart: number;
  loopEnd: number;
  enabled: boolean;
  volume: number;
  row?: number;
  col?: number;
  // 8-band graphic EQ gains in dB, one per fixed band (see EQ_BANDS in audio-engine).
  // Omitted on legacy decks → defaults to flat [0,0,0,0,0,0,0,0] on load.
  eq?: number[];
  // Playback rate multiplier. 1.0 = normal. Currently pitched (changes pitch with speed).
  // Range 0.5–2.0 enforced by the UI. Omitted on legacy decks → defaults to 1.
  speed?: number;
  // When true, speed changes preserve pitch (time-stretched via OLA). When false,
  // BufferSource.playbackRate changes pitch with speed (sampler/varispeed feel).
  pitchLock?: boolean;
}

export interface GridShape {
  cols: number;
  rows: number;
}

export interface Manifest {
  sources: Record<string, SourcePersisted>;
  tiles: TilePersisted[];
  grid?: GridShape;
}

export interface DeckMeta {
  name: string;
  description: string;
  created: string | null;
  modified: string | null;
  tileCount?: number;
  sourceCount?: number;
}

export interface DeckData extends Manifest {
  meta: DeckMeta;
}

export interface RecentDeck {
  path: string;
  name: string;
  time: number;
}

export interface CacheInfo {
  maxBytes: number;
  usedBytes: number;
  files: number;
  maxGB: string;
  usedGB: string;
}

export interface VideoInfo {
  title: string;
  duration: number;
  thumbnail: string;
  id: string;
}

export type ExtractAudioResult =
  | { ok: true; chunked: true; chunkCount: number; chunkDuration: number }
  | { ok: true; chunked: false }
  | { ok: false; reason: string };

export interface SaveDeckResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export interface SaveDeckOptions {
  // If set, write directly without showing a dialog (Save behavior).
  path?: string;
  // If no path is set and a dialog is shown, use this as the suggested filename.
  suggestedName?: string;
}

export interface LoadDeckResult {
  data: DeckData;
  path: string;
}

export interface DownloadProgressEvent {
  clipId: string;
  progress: number;
}

export type BinarySetupEvent =
  | { phase: 'ready' }
  | { phase: 'first-run' }
  | { phase: 'error'; error: string }
  | { phase: 'start'; name: 'yt-dlp' | 'ffmpeg' }
  | { phase: 'downloading'; name: 'yt-dlp' | 'ffmpeg'; received: number; total: number }
  | { phase: 'extracting'; name: 'yt-dlp' | 'ffmpeg' }
  | { phase: 'pending-restart'; name: 'yt-dlp' | 'ffmpeg' }
  | { phase: 'done'; name: 'yt-dlp' | 'ffmpeg' }
  | { phase: 'updating'; name: 'yt-dlp' | 'ffmpeg'; from?: string; to?: string }
  | { phase: string; background?: boolean; name?: string; [key: string]: unknown };

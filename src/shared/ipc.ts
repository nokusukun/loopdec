// The IPC surface — what preload exposes as `window.api` / `window.win`.
// Both preload and renderer import this; main mirrors the channel names.

import type {
  Manifest,
  DeckData,
  RecentDeck,
  CacheInfo,
  VideoInfo,
  ExtractAudioResult,
  SaveDeckResult,
  SaveDeckOptions,
  LoadDeckResult,
  DownloadProgressEvent,
  BinarySetupEvent,
} from './types';

export interface LocalClipInfo {
  title: string;
}

export interface LoopDecApi {
  getVideoInfo(url: string): Promise<VideoInfo>;
  downloadClip(url: string, clipId: string): Promise<string>;
  deleteClip(clipId: string): Promise<boolean>;
  extractAudio(clipId: string): Promise<ExtractAudioResult>;
  pickLocalFiles(): Promise<string[]>;
  loadLocalClip(filePath: string, clipId: string): Promise<LocalClipInfo>;
  getPathForFile(file: File): string;
  getAudioBuffer(clipId: string): Promise<ArrayBuffer | null | { error: 'use-chunks'; size: number }>;
  getAudioChunk(clipId: string, index: number): Promise<ArrayBuffer | null>;
  getAudioPeaks(clipId: string): Promise<ArrayBuffer | null>;
  saveManifest(data: Manifest): Promise<boolean>;
  loadManifest(): Promise<Manifest | null>;
  saveDeck(data: DeckData, opts?: SaveDeckOptions): Promise<SaveDeckResult>;
  loadDeck(): Promise<LoadDeckResult | null>;
  loadDeckPath(path: string): Promise<DeckData | null>;
  getRecentDecks(): Promise<RecentDeck[]>;
  getCacheInfo(): Promise<CacheInfo>;
  setMaxCache(gb: number): Promise<boolean>;
  clearCache(): Promise<number>;
  getYtDlpVersion(): Promise<{ version: string | null }>;
  getFfmpegVersion(): Promise<{ version: string | null }>;
  forceCheckUpdates(): Promise<boolean>;
  onDownloadProgress(cb: (data: DownloadProgressEvent) => void): void;
  onBinarySetup(cb: (data: BinarySetupEvent) => void): void;
}

export interface WindowControls {
  minimize(): void;
  maximize(): void;
  close(): void;
}

declare global {
  interface Window {
    api: LoopDecApi;
    win: WindowControls;
  }
}

import { contextBridge, ipcRenderer } from 'electron';
import type { LoopDecApi, WindowControls } from '../shared/ipc';
import type { DownloadProgressEvent, BinarySetupEvent } from '../shared/types';

const winApi: WindowControls = {
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),
};

const api: LoopDecApi = {
  getVideoInfo: (url) => ipcRenderer.invoke('get-video-info', url),
  downloadClip: (url, clipId) => ipcRenderer.invoke('download-clip', url, clipId),
  deleteClip: (clipId) => ipcRenderer.invoke('delete-clip', clipId),
  extractAudio: (clipId) => ipcRenderer.invoke('extract-audio', clipId),
  getAudioBuffer: (clipId) => ipcRenderer.invoke('get-audio-buffer', clipId),
  getAudioChunk: (clipId, index) => ipcRenderer.invoke('get-audio-chunk', clipId, index),
  getAudioPeaks: (clipId) => ipcRenderer.invoke('get-audio-peaks', clipId),
  saveManifest: (data) => ipcRenderer.invoke('save-manifest', data),
  loadManifest: () => ipcRenderer.invoke('load-manifest'),
  saveDeck: (data, opts) => ipcRenderer.invoke('save-deck', data, opts),
  loadDeck: () => ipcRenderer.invoke('load-deck'),
  loadDeckPath: (path) => ipcRenderer.invoke('load-deck-path', path),
  getRecentDecks: () => ipcRenderer.invoke('get-recent-decks'),
  getCacheInfo: () => ipcRenderer.invoke('get-cache-info'),
  setMaxCache: (gb) => ipcRenderer.invoke('set-max-cache', gb),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  getYtDlpVersion: () => ipcRenderer.invoke('get-ytdlp-version'),
  getFfmpegVersion: () => ipcRenderer.invoke('get-ffmpeg-version'),
  forceCheckUpdates: () => ipcRenderer.invoke('force-check-updates'),
  onDownloadProgress: (callback) => {
    ipcRenderer.on('download-progress', (_event, data: DownloadProgressEvent) => callback(data));
  },
  onBinarySetup: (callback) => {
    ipcRenderer.on('binary-setup', (_event, data: BinarySetupEvent) => callback(data));
  },
};

contextBridge.exposeInMainWorld('win', winApi);
contextBridge.exposeInMainWorld('api', api);

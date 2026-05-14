import type { Tile, TileEls, Source, TileState } from './types';
import {
  tiles, sources, generateTileId, generateSourceId, getSource, tilesForSource,
  updateEmptyState,
} from './state';
import { tilesGrid, emptyState } from './dom';
import {
  findFirstEmptyCell, setTilePosition, renderEmptyCells,
} from './grid';
import { enableTileDrag } from './drag';
import {
  togglePlayTile, pauseTile, playTile, stopPlayheadAnimation, updateMasterPlayState,
} from './playback';
import { decodeSourceAudio, playAudio, tearDownTileAudio } from './audio-engine';
import { openWaveformEditor, closeWaveformEditor } from './waveform';
import { editor } from './editor-state';
import { updateTileLoopIndicator, applyTileSpeedDisplay } from './tile-display';
import { saveManifest } from './manifest';
import { applyDeviceToVideo } from './audio-output';

export function createTileElement(tile: Tile, source: Source): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.tileId = tile.id;
  el.dataset.state = tile.state;
  el.dataset.enabled = 'true';
  el.dataset.muted = 'false';

  const header = document.createElement('div');
  header.className = 'tile-header';

  const dragHandle = document.createElement('span');
  dragHandle.className = 'tile-drag-handle';
  dragHandle.textContent = '⋮⋮';
  dragHandle.title = 'Drag to reorder';

  const address = document.createElement('span');
  address.className = 'tile-address';
  address.textContent = '--';

  const speedPill = document.createElement('span');
  speedPill.className = 'tile-speed-pill';
  speedPill.title = 'Playback speed';

  const leds = document.createElement('div');
  leds.className = 'tile-leds';
  for (const cls of ['tile-led-power', 'tile-led-ready', 'tile-led-play', 'tile-led-mute']) {
    const led = document.createElement('span');
    led.className = `tile-led ${cls}`;
    leds.appendChild(led);
  }

  header.append(dragHandle, address, speedPill, leds);

  const videoContainer = document.createElement('div');
  videoContainer.className = 'tile-video';

  const downloadEl = document.createElement('div');
  downloadEl.className = 'tile-download';
  const dlLabel = document.createElement('span');
  dlLabel.className = 'tile-download-label';
  dlLabel.textContent = 'FETCH';
  const progressTrack = document.createElement('div');
  progressTrack.className = 'tile-progress-track';
  const progressFill = document.createElement('div');
  progressFill.className = 'tile-progress-fill';
  progressTrack.appendChild(progressFill);
  downloadEl.append(dlLabel, progressTrack);
  videoContainer.appendChild(downloadEl);

  const body = document.createElement('div');
  body.className = 'tile-body';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'tile-title';
  titleSpan.textContent = source.title;

  const loopIndicator = document.createElement('div');
  loopIndicator.className = 'tile-loop-indicator';
  const loopRegion = document.createElement('div');
  loopRegion.className = 'tile-loop-region';
  const loopPlayhead = document.createElement('div');
  loopPlayhead.className = 'tile-loop-playhead';
  loopIndicator.append(loopRegion, loopPlayhead);

  const timesRow = document.createElement('div');
  timesRow.className = 'tile-times';
  const timeCurrent = document.createElement('span');
  timeCurrent.className = 'tile-time-current';
  timeCurrent.textContent = '0:00';
  const timeSep = document.createElement('span');
  timeSep.className = 'tile-time-sep';
  timeSep.textContent = '·';
  const timeRange = document.createElement('span');
  timeRange.textContent = '0:00 → 0:00';
  timesRow.append(timeCurrent, timeSep, timeRange);

  const volumeSlider = document.createElement('input');
  volumeSlider.type = 'range';
  volumeSlider.className = 'tile-volume';
  volumeSlider.min = '0';
  volumeSlider.max = '1';
  volumeSlider.step = '0.01';
  volumeSlider.value = String(tile.volume);
  volumeSlider.title = 'Volume';

  volumeSlider.addEventListener('input', () => {
    tile.volume = parseFloat(volumeSlider.value);
    if (tile.muted) {
      tile.muted = false;
      tile.els.muteBtn.classList.remove('muted');
      tile.els.tile.dataset.muted = 'false';
    }
    if (tile.gainNode) tile.gainNode.gain.value = tile.volume;
    if (tile.video && !getSource(tile)?.audioReady) tile.video.volume = tile.volume;
  });
  volumeSlider.addEventListener('change', () => saveManifest());

  const controls = document.createElement('div');
  controls.className = 'tile-controls';

  const mkBtn = (cls: string, label: string, title: string) => {
    const b = document.createElement('button');
    b.className = `tile-btn ${cls}`;
    b.textContent = label;
    b.title = title;
    return b;
  };

  const playBtn = mkBtn('tile-play-btn', 'PLY', 'Play/pause');
  const toggleBtn = mkBtn('tile-toggle enabled', 'ON', 'Enable/disable');
  const muteBtn = mkBtn('tile-mute-btn', 'MUT', 'Mute/unmute');
  const dupeBtn = mkBtn('tile-dupe-btn', 'DUP', 'Duplicate');
  const editBtn = mkBtn('tile-edit-btn', 'EDT', 'Edit loop');
  const removeBtn = mkBtn('tile-remove', 'DEL', 'Remove');
  controls.append(playBtn, toggleBtn, muteBtn, dupeBtn, editBtn, removeBtn);

  body.append(titleSpan, loopIndicator, timesRow, volumeSlider, controls);
  el.append(header, videoContainer, body);

  const els: TileEls = {
    tile: el, dragHandle, address, speedPill, videoContainer,
    downloadLabel: dlLabel, progressFill, title: titleSpan,
    loopRegion, loopPlayhead, timeCurrent, timeRange,
    playBtn, toggleBtn, muteBtn, volumeSlider,
  };
  tile.els = els;
  applyTileSpeedDisplay(tile);

  body.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.tile-btn') || t.closest('.tile-volume')) return;
    openWaveformEditor(tile.id);
  });

  playBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlayTile(tile); });
  toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleEnabled(tile); });
  muteBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(tile); });
  dupeBtn.addEventListener('click', (e) => { e.stopPropagation(); duplicateTile(tile.id); });
  editBtn.addEventListener('click', (e) => { e.stopPropagation(); openWaveformEditor(tile.id); });
  removeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeTile(tile.id); });

  enableTileDrag(tile);

  return el;
}

export function loadVideo(tile: Tile, source: Source): void {
  tile.els.videoContainer.innerHTML = '';

  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  video.src = `clip:///${tile.sourceId}`;
  if (source.audioReady) video.muted = true;
  else video.volume = tile.volume;
  video.playbackRate = tile.speed;
  applyDeviceToVideo(video);

  const overlay = document.createElement('div');
  overlay.className = 'tile-video-overlay';
  const icon = document.createElement('span');
  icon.innerHTML = '&#9654;';
  overlay.appendChild(icon);
  overlay.addEventListener('click', () => togglePlayTile(tile));

  tile.els.videoContainer.append(video, overlay);
  tile.video = video;

  video.addEventListener('loadedmetadata', () => {
    if (source.duration === 0) {
      source.duration = video.duration;
      tile.loopEnd = video.duration;
    }
    updateTileLoopIndicator(tile);
  });

  video.addEventListener('timeupdate', () => {
    if (!source.audioReady) enforceLoop(tile, source);
  });
  video.addEventListener('ended', () => {
    if (!source.audioReady) {
      video.currentTime = tile.loopStart;
      video.playbackRate = tile.speed;
      video.play().catch(() => {});
    }
  });
}

function enforceLoop(tile: Tile, source: Source): void {
  if (!tile.video || source.audioReady) return;
  if (tile.video.currentTime >= tile.loopEnd) {
    tile.video.currentTime = tile.loopStart;
  }
}

export function toggleEnabled(tile: Tile): void {
  tile.enabled = !tile.enabled;
  tile.els.tile.dataset.enabled = String(tile.enabled);
  tile.els.toggleBtn.textContent = tile.enabled ? 'ON' : 'OFF';
  tile.els.toggleBtn.classList.toggle('enabled', tile.enabled);

  if (!tile.enabled && tile.state === 'playing') {
    tile._wasPlaying = true;
    pauseTile(tile);
  } else if (tile.enabled && tile._wasPlaying) {
    tile._wasPlaying = false;
    playTile(tile);
  }
  saveManifest();
}

export function toggleMute(tile: Tile): void {
  tile.muted = !tile.muted;
  tile.els.muteBtn.textContent = tile.muted ? 'UNM' : 'MUT';
  tile.els.muteBtn.classList.toggle('muted', tile.muted);
  tile.els.tile.dataset.muted = String(tile.muted);
  if (tile.gainNode) tile.gainNode.gain.value = tile.muted ? 0 : tile.volume;
  if (tile.video && !getSource(tile)?.audioReady) tile.video.volume = tile.muted ? 0 : tile.volume;
}

export function removeTile(tileId: string): void {
  const tile = tiles.get(tileId);
  if (!tile) return;

  if (editor.tileId === tileId) closeWaveformEditor();

  tearDownTileAudio(tile);
  if (tile.video) { tile.video.pause(); tile.video.src = ''; }
  stopPlayheadAnimation(tile);
  tile.els.tile.remove();
  tiles.delete(tileId);

  if (tilesForSource(tile.sourceId).length === 0) {
    sources.delete(tile.sourceId);
    window.api.deleteClip(tile.sourceId);
  }

  renderEmptyCells();
  updateEmptyState();
  updateMasterPlayState();
  saveManifest();
}

function makeTile(id: string, sourceId: string, init: Partial<Tile>): Tile {
  return {
    id,
    sourceId,
    loopStart: init.loopStart ?? 0,
    loopEnd: init.loopEnd ?? 0,
    enabled: init.enabled ?? true,
    state: init.state ?? 'downloading',
    video: null,
    audioSource: null,
    audioStartedAt: 0,
    audioStartedOffset: 0,
    animFrameId: null,
    volume: init.volume ?? 1,
    gainNode: null,
    muted: false,
    els: undefined as unknown as TileEls,
    eq: init.eq && init.eq.length === 8 ? [...init.eq] : [0, 0, 0, 0, 0, 0, 0, 0],
    eqFilters: null,
    speed: init.speed ?? 1,
    pitchLock: init.pitchLock ?? false,
  };
}

// Allocate a fresh source + tile + DOM in the next empty pad. Caller fills in
// the rest of source.title/duration once it knows them.
function setupClip(url: string): { source: Source; tile: Tile } {
  const sourceId = generateSourceId();
  const tileId = generateTileId();

  const source: Source = {
    id: sourceId, url, title: 'Loading...', duration: 0,
    audioBuffer: null, audioReady: false,
    chunked: false, chunkCount: 0, chunkDuration: 0,
    decodedChunks: null, peaks: null,
  };
  const tile = makeTile(tileId, sourceId, { state: 'downloading' });

  sources.set(sourceId, source);
  tiles.set(tileId, tile);

  const tileEl = createTileElement(tile, source);
  tilesGrid.insertBefore(tileEl, emptyState);
  const cell = findFirstEmptyCell();
  setTilePosition(tile, cell.row, cell.col);
  renderEmptyCells();
  updateEmptyState();

  return { source, tile };
}

// Common tail: media is now on disk → load video, extract audio, decode, hand
// off playback to any tiles already mid-play on this source.
async function finalizeClip(tile: Tile, source: Source): Promise<void> {
  tile.state = 'paused';
  tile.els.tile.dataset.state = 'paused';
  loadVideo(tile, source);
  updateTileLoopIndicator(tile);
  saveManifest();

  const result = await window.api.extractAudio(source.id);
  if (!result.ok) return;

  if (result.chunked) {
    source.chunked = true;
    source.chunkCount = result.chunkCount;
    source.chunkDuration = result.chunkDuration;
  }
  await decodeSourceAudio(source);
  saveManifest();
  for (const t of tilesForSource(source.id)) {
    if (t.state === 'playing' && t.video && !t.video.paused) {
      playAudio(t, t.video.currentTime);
    }
  }
}

function setClipError(tile: Tile, err: unknown): void {
  tile.state = 'error';
  tile.els.tile.dataset.state = 'error';
  tile.els.videoContainer.innerHTML = '';
  const errEl = document.createElement('div');
  errEl.className = 'tile-error';
  const raw = typeof err === 'string' ? err : (err as Error).message || 'Load failed';
  errEl.textContent = raw.split('\n').find(l => l.trim()) || 'Failed';
  tile.els.videoContainer.appendChild(errEl);
}

export async function addClip(url: string): Promise<void> {
  const { source, tile } = setupClip(url);
  try {
    const info = await window.api.getVideoInfo(url);
    source.title = info.title;
    source.duration = info.duration;
    tile.loopEnd = info.duration;
    tile.els.title.textContent = info.title;

    await window.api.downloadClip(url, source.id);
    await finalizeClip(tile, source);
  } catch (err) {
    setClipError(tile, err);
  }
}

// loadedmetadata in loadVideo fills in source.duration / tile.loopEnd later;
// no pre-known duration to set on the tile here.
export async function addLocalClip(filePath: string): Promise<void> {
  const { source, tile } = setupClip(filePath);
  try {
    const info = await window.api.loadLocalClip(filePath, source.id);
    source.title = info.title;
    tile.els.title.textContent = info.title;
    await finalizeClip(tile, source);
  } catch (err) {
    setClipError(tile, err);
  }
}

export function duplicateTile(tileId: string): void {
  const original = tiles.get(tileId);
  if (!original) return;
  const source = getSource(original);
  if (!source) return;

  const newTile = makeTile(generateTileId(), original.sourceId, {
    loopStart: original.loopStart,
    loopEnd: original.loopEnd,
    enabled: true,
    state: source.audioReady ? 'paused' : original.state,
    volume: original.volume,
    eq: original.eq,
    speed: original.speed,
    pitchLock: original.pitchLock,
  });

  tiles.set(newTile.id, newTile);
  const tileEl = createTileElement(newTile, source);
  tilesGrid.insertBefore(tileEl, emptyState);
  const cell = findFirstEmptyCell();
  setTilePosition(newTile, cell.row, cell.col);
  renderEmptyCells();

  if (original.state !== 'downloading' && original.state !== 'error') {
    loadVideo(newTile, source);
  }

  updateTileLoopIndicator(newTile);
  updateEmptyState();
  saveManifest();
}

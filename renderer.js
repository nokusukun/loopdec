// ── State ────────────────────────────────────────────────────────────
const sources = new Map();
const tiles = new Map();
let sourceCounter = 0;
let tileCounter = 0;
let currentDeckMeta = { name: '', description: '', created: null, modified: null };

// ── Window controls ──────────────────────────────────────────────────
document.getElementById('win-close').addEventListener('click', () => window.win.close());
document.getElementById('win-minimize').addEventListener('click', () => window.win.minimize());
document.getElementById('win-maximize').addEventListener('click', () => window.win.maximize());

// ── Shared Web Audio context ─────────────────────────────────────────
let sharedAudioCtx = null;
function getAudioCtx() {
  if (!sharedAudioCtx) sharedAudioCtx = new AudioContext();
  return sharedAudioCtx;
}

// ── Waveform editor state ────────────────────────────────────────────
let editingTileId = null;
let waveformAnimId = null;
let waveformDragCleanup = null;
let cachedPeaks = null;
let snapInterval = 0;
let snapOffset = 0;
let viewStart = 0;    // visible time window start (seconds)
let viewEnd = 0;      // visible time window end (seconds)

// ── DOM refs ─────────────────────────────────────────────────────────
const urlForm = document.getElementById('url-form');
const urlInput = document.getElementById('url-input');
const tilesGrid = document.getElementById('tiles-grid');
const emptyState = document.getElementById('empty-state');
const deckNameEl = document.getElementById('deck-name');
const playAllBtn = document.getElementById('play-all-btn');
const stopAllBtn = document.getElementById('stop-all-btn');
const syncBtn = document.getElementById('sync-btn');
const waveformPanel = document.getElementById('waveform-panel');
const waveformCanvas = document.getElementById('waveform-canvas');
const waveformCtx = waveformCanvas.getContext('2d');
const waveformTitleEl = document.getElementById('waveform-title');
const waveformTimeStart = document.getElementById('waveform-time-start');
const waveformTimeEnd = document.getElementById('waveform-time-end');
const waveformCloseBtn = document.getElementById('waveform-close');
const waveformFitBtn = document.getElementById('waveform-fit');
const waveformMinimap = document.getElementById('waveform-minimap');

// ── Utilities ────────────────────────────────────────────────────────
function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function formatTimePrecise(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${ss < 10 ? '0' : ''}${ss.toFixed(2)}`;
}

function snapTime(time, interval) {
  if (interval <= 0) return time;
  return Math.round((time - snapOffset) / interval) * interval + snapOffset;
}

function generateSourceId() {
  return `src_${Date.now()}_${++sourceCounter}`;
}

function generateTileId() {
  return `tile_${Date.now()}_${++tileCounter}`;
}

function getSource(tile) {
  return sources.get(tile.sourceId);
}

function tilesForSource(sourceId) {
  return [...tiles.values()].filter(t => t.sourceId === sourceId);
}

function updateEmptyState() {
  emptyState.classList.toggle('hidden', tiles.size > 0);
}

function updateDeckTitle() {
  deckNameEl.textContent = currentDeckMeta.name || '';
}

// ── Manifest (session persistence) ───────────────────────────────────
let saveTimeout = null;

function saveManifest() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const data = {
      sources: {},
      tiles: [],
    };
    for (const [id, src] of sources) {
      data.sources[id] = {
        id, url: src.url, title: src.title, duration: src.duration,
        chunked: src.chunked || false,
        chunkCount: src.chunkCount || 0,
        chunkDuration: src.chunkDuration || 0,
      };
    }
    for (const tile of tiles.values()) {
      data.tiles.push({
        id: tile.id,
        sourceId: tile.sourceId,
        loopStart: tile.loopStart,
        loopEnd: tile.loopEnd,
        enabled: tile.enabled,
        volume: tile.volume,
      });
    }
    window.api.saveManifest(data);
  }, 500);
}

async function decodeSourceAudio(source) {
  if (source.chunked) {
    // Chunked mode: load pre-computed peaks, mark ready (chunks decoded on demand)
    const peaksBuf = await window.api.getAudioPeaks(source.id);
    if (peaksBuf) {
      source.peaks = new Float32Array(peaksBuf);
    }
    source.decodedChunks = new Map();
    source.audioReady = true;
    for (const t of tilesForSource(source.id)) {
      if (t.video) t.video.muted = true;
    }
    return;
  }

  // Single-buffer mode
  const rawBuffer = await window.api.getAudioBuffer(source.id);
  if (!rawBuffer) return;
  if (rawBuffer.error === 'use-chunks') {
    console.warn(`Audio file for ${source.id} is large but not chunked — run extract-audio first`);
    return;
  }
  const actx = getAudioCtx();
  try {
    source.audioBuffer = await actx.decodeAudioData(rawBuffer);
    source.audioReady = true;
    for (const t of tilesForSource(source.id)) {
      if (t.video) t.video.muted = true;
    }
  } catch (e) {
    console.warn(`Audio decode failed for ${source.id}:`, e);
  }
}

// ── Chunked audio helpers ────────────────────────────────────────────
async function decodeChunk(source, index) {
  if (source.decodedChunks.has(index)) return source.decodedChunks.get(index);
  if (index < 0 || index >= source.chunkCount) return null;

  const raw = await window.api.getAudioChunk(source.id, index);
  if (!raw) return null;

  const actx = getAudioCtx();
  const decoded = await actx.decodeAudioData(raw);
  source.decodedChunks.set(index, decoded);
  return decoded;
}

async function loadChunksForRegion(source, start, end) {
  const firstChunk = Math.floor(start / source.chunkDuration);
  const lastChunk = Math.min(Math.floor(end / source.chunkDuration), source.chunkCount - 1);
  const promises = [];
  for (let i = firstChunk; i <= lastChunk; i++) {
    promises.push(decodeChunk(source, i));
  }
  await Promise.all(promises);
}

function buildRegionBuffer(source, start, end) {
  const actx = getAudioCtx();
  const firstChunk = Math.floor(start / source.chunkDuration);
  const lastChunk = Math.min(Math.floor(end / source.chunkDuration), source.chunkCount - 1);

  // Gather decoded chunks
  const chunks = [];
  for (let i = firstChunk; i <= lastChunk; i++) {
    const buf = source.decodedChunks.get(i);
    if (!buf) return null;
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;

  const sampleRate = chunks[0].sampleRate;
  const channels = chunks[0].numberOfChannels;
  const totalLength = chunks.reduce((sum, b) => sum + b.length, 0);

  const combined = actx.createBuffer(channels, totalLength, sampleRate);
  let offset = 0;
  for (const buf of chunks) {
    for (let ch = 0; ch < channels; ch++) {
      combined.getChannelData(ch).set(buf.getChannelData(ch), offset);
    }
    offset += buf.length;
  }

  const regionOffset = firstChunk * source.chunkDuration;
  return { buffer: combined, offset: regionOffset };
}

function preloadAdjacentChunks(source, start, end) {
  const firstChunk = Math.floor(start / source.chunkDuration);
  const lastChunk = Math.floor(end / source.chunkDuration);
  // Preload one chunk before and after
  if (firstChunk > 0) decodeChunk(source, firstChunk - 1);
  if (lastChunk < source.chunkCount - 1) decodeChunk(source, lastChunk + 1);
}

async function restoreSession() {
  const manifest = await window.api.loadManifest();
  if (!manifest || !manifest.sources || !manifest.tiles?.length) return;

  // Restore sources
  for (const [id, src] of Object.entries(manifest.sources)) {
    sources.set(id, {
      id,
      url: src.url,
      title: src.title,
      duration: src.duration,
      audioBuffer: null,
      audioReady: false,
      chunked: src.chunked || false,
      chunkCount: src.chunkCount || 0,
      chunkDuration: src.chunkDuration || 0,
      decodedChunks: null,
      peaks: null,
    });
  }

  // Restore tiles
  for (const td of manifest.tiles) {
    const source = sources.get(td.sourceId);
    if (!source) continue;

    const tile = {
      id: td.id,
      sourceId: td.sourceId,
      loopStart: td.loopStart,
      loopEnd: td.loopEnd,
      enabled: td.enabled !== false,
      state: 'paused',
      video: null,
      audioSource: null,
      audioStartedAt: 0,
      audioStartedOffset: 0,
      _pausedAt: undefined,
      animFrameId: null,
      volume: td.volume ?? 1,
      gainNode: null,
      muted: false,
      els: {},
    };

    // Keep counters ahead of restored IDs
    const tileNum = parseInt(tile.id.split('_').pop()) || 0;
    if (tileNum >= tileCounter) tileCounter = tileNum + 1;
    const srcNum = parseInt(td.sourceId.split('_').pop()) || 0;
    if (srcNum >= sourceCounter) sourceCounter = srcNum + 1;

    tiles.set(tile.id, tile);
    const tileEl = createTileElement(tile, source);
    tilesGrid.insertBefore(tileEl, emptyState);
    loadVideo(tile, source);
    updateTileLoopIndicator(tile);

    if (tile.volume !== 1 && tile.els.volumeSlider) {
      tile.els.volumeSlider.value = tile.volume;
    }
    if (!tile.enabled) {
      tile.els.tile.dataset.enabled = 'false';
      tile.els.toggleBtn.textContent = 'OFF';
      tile.els.toggleBtn.classList.remove('enabled');
    }
  }

  updateEmptyState();

  // Decode audio for all sources in parallel
  await Promise.all(
    [...sources.values()].map(src => decodeSourceAudio(src))
  );
}

// ── Add clip from URL ────────────────────────────────────────────────
async function addClip(url) {
  const sourceId = generateSourceId();
  const tileId = generateTileId();

  const source = {
    id: sourceId,
    url,
    title: 'Loading...',
    duration: 0,
    audioBuffer: null,
    audioReady: false,
    chunked: false,
    chunkCount: 0,
    chunkDuration: 0,
    decodedChunks: null,
    peaks: null,
  };

  const tile = {
    id: tileId,
    sourceId,
    loopStart: 0,
    loopEnd: 0,
    enabled: true,
    state: 'downloading',
    video: null,
    audioSource: null,
    audioStartedAt: 0,
    audioStartedOffset: 0,
    _pausedAt: undefined,
    animFrameId: null,
    volume: 1,
    gainNode: null,
    els: {},
  };

  sources.set(sourceId, source);
  tiles.set(tileId, tile);

  const tileEl = createTileElement(tile, source);
  tilesGrid.insertBefore(tileEl, emptyState);
  updateEmptyState();

  try {
    const info = await window.api.getVideoInfo(url);
    source.title = info.title;
    source.duration = info.duration;
    tile.loopEnd = info.duration;
    tile.els.title.textContent = info.title;

    await window.api.downloadClip(url, sourceId);

    tile.state = 'paused';
    tileEl.dataset.state = 'paused';
    loadVideo(tile, source);
    updateTileLoopIndicator(tile);

    saveManifest();

    // Extract and decode audio
    const result = await window.api.extractAudio(sourceId);
    if (result.ok) {
      if (result.chunked) {
        source.chunked = true;
        source.chunkCount = result.chunkCount;
        source.chunkDuration = result.chunkDuration;
      }
      await decodeSourceAudio(source);
      saveManifest();
      for (const t of tilesForSource(sourceId)) {
        if (t.state === 'playing' && t.video && !t.video.paused) {
          playAudio(t, t.video.currentTime);
        }
      }
    }
  } catch (err) {
    tile.state = 'error';
    tileEl.dataset.state = 'error';
    tile.els.videoContainer.innerHTML = '';
    const errEl = document.createElement('div');
    errEl.className = 'tile-error';
    const raw = typeof err === 'string' ? err : err.message || 'Download failed';
    errEl.textContent = raw.split('\n').find(l => l.trim()) || 'Failed';
    tile.els.videoContainer.appendChild(errEl);
  }
}

// ── Duplicate tile ───────────────────────────────────────────────────
function duplicateTile(tileId) {
  const original = tiles.get(tileId);
  if (!original) return;
  const source = getSource(original);
  if (!source) return;

  const newTile = {
    id: generateTileId(),
    sourceId: original.sourceId,
    loopStart: original.loopStart,
    loopEnd: original.loopEnd,
    enabled: true,
    state: source.audioReady ? 'paused' : original.state,
    video: null,
    audioSource: null,
    audioStartedAt: 0,
    audioStartedOffset: 0,
    _pausedAt: undefined,
    animFrameId: null,
    volume: original.volume,
    gainNode: null,
    els: {},
  };

  tiles.set(newTile.id, newTile);
  const tileEl = createTileElement(newTile, source);
  original.els.tile.after(tileEl);

  if (original.state !== 'downloading' && original.state !== 'error') {
    loadVideo(newTile, source);
  }

  updateTileLoopIndicator(newTile);
  updateEmptyState();
  saveManifest();
}

// ── Create tile DOM ──────────────────────────────────────────────────
function createTileElement(tile, source) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.tileId = tile.id;
  el.dataset.state = tile.state;
  el.dataset.enabled = 'true';

  // Video container
  const videoContainer = document.createElement('div');
  videoContainer.className = 'tile-video';

  const downloadEl = document.createElement('div');
  downloadEl.className = 'tile-download';
  const dlLabel = document.createElement('span');
  dlLabel.className = 'tile-download-label';
  dlLabel.textContent = 'Fetching';
  const progressTrack = document.createElement('div');
  progressTrack.className = 'tile-progress-track';
  const progressFill = document.createElement('div');
  progressFill.className = 'tile-progress-fill';
  progressTrack.appendChild(progressFill);
  downloadEl.appendChild(dlLabel);
  downloadEl.appendChild(progressTrack);
  videoContainer.appendChild(downloadEl);

  // Body
  const body = document.createElement('div');
  body.className = 'tile-body';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'tile-title';
  titleSpan.textContent = source.title;

  // Loop indicator (read-only)
  const loopIndicator = document.createElement('div');
  loopIndicator.className = 'tile-loop-indicator';
  const loopRegion = document.createElement('div');
  loopRegion.className = 'tile-loop-region';
  const loopPlayhead = document.createElement('div');
  loopPlayhead.className = 'tile-loop-playhead';
  loopIndicator.appendChild(loopRegion);
  loopIndicator.appendChild(loopPlayhead);

  // Controls
  const controls = document.createElement('div');
  controls.className = 'tile-controls';

  const playBtn = document.createElement('button');
  playBtn.className = 'tile-btn tile-play-btn';
  playBtn.textContent = 'PLY';
  playBtn.title = 'Play/pause';

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'tile-btn tile-toggle enabled';
  toggleBtn.textContent = 'ON';
  toggleBtn.title = 'Enable/disable';

  const muteBtn = document.createElement('button');
  muteBtn.className = 'tile-btn tile-mute-btn';
  muteBtn.textContent = 'MUT';
  muteBtn.title = 'Mute/unmute';

  const dupeBtn = document.createElement('button');
  dupeBtn.className = 'tile-btn tile-dupe-btn';
  dupeBtn.textContent = 'DUP';
  dupeBtn.title = 'Duplicate';

  const editBtn = document.createElement('button');
  editBtn.className = 'tile-btn tile-edit-btn';
  editBtn.textContent = 'EDT';
  editBtn.title = 'Edit loop';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'tile-btn tile-remove';
  removeBtn.textContent = 'DEL';
  removeBtn.title = 'Remove';

  // Volume slider
  const volumeSlider = document.createElement('input');
  volumeSlider.type = 'range';
  volumeSlider.className = 'tile-volume';
  volumeSlider.min = '0';
  volumeSlider.max = '1';
  volumeSlider.step = '0.01';
  volumeSlider.value = tile.volume;
  volumeSlider.title = 'Volume';

  volumeSlider.addEventListener('input', () => {
    tile.volume = parseFloat(volumeSlider.value);
    if (tile.muted) { tile.muted = false; tile.els.muteBtn.textContent = 'MUT'; tile.els.muteBtn.classList.remove('muted'); }
    if (tile.gainNode) tile.gainNode.gain.value = tile.volume;
    if (tile.video && !getSource(tile)?.audioReady) tile.video.volume = tile.volume;
  });
  volumeSlider.addEventListener('change', () => saveManifest());

  controls.appendChild(playBtn);
  controls.appendChild(toggleBtn);
  controls.appendChild(muteBtn);
  controls.appendChild(dupeBtn);
  controls.appendChild(editBtn);
  controls.appendChild(removeBtn);

  // Timecodes
  const timesRow = document.createElement('div');
  timesRow.className = 'tile-times';
  const timeCurrent = document.createElement('span');
  timeCurrent.className = 'tile-time-current';
  timeCurrent.textContent = '0:00';
  const timeRange = document.createElement('span');
  timeRange.textContent = '0:00 - 0:00';
  timesRow.appendChild(timeCurrent);
  timesRow.appendChild(timeRange);

  body.appendChild(titleSpan);
  body.appendChild(loopIndicator);
  body.appendChild(volumeSlider);
  body.appendChild(timesRow);
  body.appendChild(controls);

  el.appendChild(videoContainer);
  el.appendChild(body);

  tile.els = {
    tile: el,
    videoContainer,
    downloadLabel: dlLabel,
    progressFill,
    title: titleSpan,
    loopRegion,
    loopPlayhead,
    timeCurrent,
    timeRange,
    playBtn,
    toggleBtn,
    muteBtn,
    volumeSlider,
  };

  // Click tile body to open waveform editor
  body.addEventListener('click', (e) => {
    if (e.target.closest('.tile-btn') || e.target.closest('.tile-volume')) return;
    openWaveformEditor(tile.id);
  });

  // Button handlers (these don't propagate to body click)
  playBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlayTile(tile); });
  toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleEnabled(tile); });
  muteBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(tile); });
  dupeBtn.addEventListener('click', (e) => { e.stopPropagation(); duplicateTile(tile.id); });
  editBtn.addEventListener('click', (e) => { e.stopPropagation(); openWaveformEditor(tile.id); });
  removeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeTile(tile.id); });

  return el;
}

// ── Load video (visual proxy) ────────────────────────────────────────
function loadVideo(tile, source) {
  tile.els.videoContainer.innerHTML = '';

  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  video.src = `clip:///${tile.sourceId}`;
  if (source.audioReady) video.muted = true;
  else video.volume = tile.volume;

  const overlay = document.createElement('div');
  overlay.className = 'tile-video-overlay';
  const icon = document.createElement('span');
  icon.innerHTML = '&#9654;';
  overlay.appendChild(icon);
  overlay.addEventListener('click', () => togglePlayTile(tile));

  tile.els.videoContainer.appendChild(video);
  tile.els.videoContainer.appendChild(overlay);
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
      video.play().catch(() => {});
    }
  });
}

// ── Loop enforcement (video-only fallback) ───────────────────────────
function enforceLoop(tile, source) {
  if (!tile.video || source.audioReady) return;
  if (tile.video.currentTime >= tile.loopEnd) {
    tile.video.currentTime = tile.loopStart;
  }
}

// ── Tile loop indicator update ───────────────────────────────────────
function updateTileLoopIndicator(tile) {
  const source = getSource(tile);
  if (!source || source.duration === 0) return;
  const startPct = (tile.loopStart / source.duration) * 100;
  const endPct = (tile.loopEnd / source.duration) * 100;
  tile.els.loopRegion.style.left = `${startPct}%`;
  tile.els.loopRegion.style.width = `${endPct - startPct}%`;
  tile.els.timeRange.textContent = `${formatTime(tile.loopStart)} - ${formatTime(tile.loopEnd)}`;
}

// ── Web Audio engine ─────────────────────────────────────────────────
async function playAudio(tile, offset) {
  const source = getSource(tile);
  if (!source?.audioReady) return;

  const actx = getAudioCtx();
  if (actx.state === 'suspended') actx.resume();

  stopAudioSource(tile);

  if (!tile.gainNode) {
    tile.gainNode = actx.createGain();
    tile.gainNode.connect(actx.destination);
  }
  tile.gainNode.gain.value = tile.muted ? 0 : tile.volume;

  let buffer, loopStart, loopEnd, startOffset;

  if (source.chunked) {
    // Chunked mode: load region chunks, build contiguous buffer
    await loadChunksForRegion(source, tile.loopStart, tile.loopEnd);
    const region = buildRegionBuffer(source, tile.loopStart, tile.loopEnd);
    if (!region) return;
    buffer = region.buffer;
    loopStart = tile.loopStart - region.offset;
    loopEnd = tile.loopEnd - region.offset;
    startOffset = offset - region.offset;
    tile._regionOffset = region.offset;
    preloadAdjacentChunks(source, tile.loopStart, tile.loopEnd);
  } else {
    if (!source.audioBuffer) return;
    buffer = source.audioBuffer;
    loopStart = tile.loopStart;
    loopEnd = tile.loopEnd;
    startOffset = offset;
    tile._regionOffset = 0;
  }

  const node = actx.createBufferSource();
  node.buffer = buffer;
  node.loop = true;
  node.loopStart = loopStart;
  node.loopEnd = loopEnd;
  node.connect(tile.gainNode);

  tile.audioSource = node;
  tile.audioStartedAt = actx.currentTime;
  tile.audioStartedOffset = startOffset;
  node.start(0, startOffset);
}

function stopAudioSource(tile) {
  if (tile.audioSource) {
    try { tile.audioSource.stop(); } catch {}
    try { tile.audioSource.disconnect(); } catch {}
    tile.audioSource = null;
  }
}

function getAudioPosition(tile) {
  const source = getSource(tile);
  if (!tile.audioSource || !source?.audioReady) return tile.loopStart;

  const actx = getAudioCtx();
  const elapsed = actx.currentTime - tile.audioStartedAt;
  const regionOff = tile._regionOffset || 0;
  const rawPos = tile.audioStartedOffset + elapsed + regionOff;
  const loopLen = tile.loopEnd - tile.loopStart;
  if (loopLen <= 0) return tile.loopStart;
  if (rawPos >= tile.loopEnd) {
    return tile.loopStart + ((rawPos - tile.loopStart) % loopLen);
  }
  return rawPos;
}

let chunkRebuildTimeout = null;

function updateAudioLoopPoints(tile) {
  const source = getSource(tile);
  if (!tile.audioSource) return;

  if (source?.chunked) {
    // For chunked: adjust loop points relative to region offset
    const off = tile._regionOffset || 0;
    tile.audioSource.loopStart = tile.loopStart - off;
    tile.audioSource.loopEnd = tile.loopEnd - off;

    // Debounced rebuild if loop crosses chunk boundaries not in current region buffer
    if (chunkRebuildTimeout) clearTimeout(chunkRebuildTimeout);
    chunkRebuildTimeout = setTimeout(async () => {
      const firstNeeded = Math.floor(tile.loopStart / source.chunkDuration);
      const lastNeeded = Math.floor(tile.loopEnd / source.chunkDuration);
      const firstLoaded = Math.floor(off / source.chunkDuration);
      const bufDuration = tile.audioSource?.buffer?.duration || 0;
      const lastLoaded = Math.floor((off + bufDuration) / source.chunkDuration);

      if (firstNeeded < firstLoaded || lastNeeded > lastLoaded) {
        // Need chunks outside current region — rebuild
        if (tile.state === 'playing') {
          const pos = getAudioPosition(tile);
          await playAudio(tile, pos);
        }
      }
      preloadAdjacentChunks(source, tile.loopStart, tile.loopEnd);
    }, 300);
  } else {
    tile.audioSource.loopStart = tile.loopStart;
    tile.audioSource.loopEnd = tile.loopEnd;
  }
}

function syncVideoToAudio(tile, audioPos) {
  if (!tile.video) return;
  const drift = Math.abs(tile.video.currentTime - audioPos);
  if (drift > 0.15) tile.video.currentTime = audioPos;
}

// ── Playhead animation ───────────────────────────────────────────────
function startPlayheadAnimation(tile) {
  if (tile.animFrameId) return;
  const source = getSource(tile);

  function tick() {
    let pos;
    if (source.audioReady) {
      if (!tile.audioSource) { tile.animFrameId = null; return; }
      pos = getAudioPosition(tile);
      syncVideoToAudio(tile, pos);
    } else {
      if (!tile.video || tile.video.paused) { tile.animFrameId = null; return; }
      pos = tile.video.currentTime;
    }
    const pct = (pos / source.duration) * 100;
    tile.els.loopPlayhead.style.left = `${pct}%`;
    tile.els.timeCurrent.textContent = formatTime(pos);
    tile.animFrameId = requestAnimationFrame(tick);
  }

  tile.animFrameId = requestAnimationFrame(tick);
}

function stopPlayheadAnimation(tile) {
  if (tile.animFrameId) {
    cancelAnimationFrame(tile.animFrameId);
    tile.animFrameId = null;
  }
}

// ── Play/Pause ───────────────────────────────────────────────────────
function togglePlayTile(tile) {
  if (!tile.video || !tile.enabled) return;
  if (tile.state === 'playing') pauseTile(tile);
  else playTile(tile);
}

async function playTile(tile) {
  if (!tile.video || !tile.enabled) return;
  const source = getSource(tile);

  let startPos = tile.loopStart;
  if (tile._pausedAt !== undefined && tile._pausedAt >= tile.loopStart && tile._pausedAt < tile.loopEnd) {
    startPos = tile._pausedAt;
    tile._pausedAt = undefined;
  } else if (tile.video.currentTime >= tile.loopStart && tile.video.currentTime < tile.loopEnd) {
    startPos = tile.video.currentTime;
  }

  // Seek video and wait for it to be ready before playing
  const seekVideo = () => new Promise((resolve) => {
    if (Math.abs(tile.video.currentTime - startPos) < 0.5) { resolve(); return; }
    tile.video.addEventListener('seeked', resolve, { once: true });
    tile.video.currentTime = startPos;
    setTimeout(resolve, 500); // fallback if seeked doesn't fire
  });

  if (source.audioReady) {
    await playAudio(tile, startPos);
    tile.video.muted = true;
    await seekVideo();
    tile.video.play().catch(() => {});
  } else {
    await seekVideo();
    tile.video.play().catch(() => {});
  }

  tile.state = 'playing';
  tile.els.tile.dataset.state = 'playing';
  tile.els.playBtn.textContent = 'STP';
  startPlayheadAnimation(tile);
  updateMasterPlayState();
}

function pauseTile(tile) {
  if (!tile.video) return;
  const source = getSource(tile);

  if (source?.audioReady) {
    tile._pausedAt = getAudioPosition(tile);
    stopAudioSource(tile);
  }

  tile.video.pause();
  tile.state = 'paused';
  tile.els.tile.dataset.state = 'paused';
  tile.els.playBtn.textContent = 'PLY';
  stopPlayheadAnimation(tile);
  updateMasterPlayState();
}

// ── Enable/Disable ───────────────────────────────────────────────────
function toggleEnabled(tile) {
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

// ── Mute/Unmute ──────────────────────────────────────────────────────
function toggleMute(tile) {
  tile.muted = !tile.muted;
  tile.els.muteBtn.textContent = tile.muted ? 'UNM' : 'MUT';
  tile.els.muteBtn.classList.toggle('muted', tile.muted);
  if (tile.gainNode) tile.gainNode.gain.value = tile.muted ? 0 : tile.volume;
  if (tile.video && !getSource(tile)?.audioReady) tile.video.volume = tile.muted ? 0 : tile.volume;
}

// ── Remove tile ──────────────────────────────────────────────────────
function removeTile(tileId) {
  const tile = tiles.get(tileId);
  if (!tile) return;

  if (editingTileId === tileId) closeWaveformEditor();

  stopAudioSource(tile);
  if (tile.gainNode) { try { tile.gainNode.disconnect(); } catch {} tile.gainNode = null; }
  if (tile.video) { tile.video.pause(); tile.video.src = ''; }
  stopPlayheadAnimation(tile);
  tile.els.tile.remove();
  tiles.delete(tileId);

  // Delete source files if last tile
  if (tilesForSource(tile.sourceId).length === 0) {
    sources.delete(tile.sourceId);
    window.api.deleteClip(tile.sourceId);
  }

  updateEmptyState();
  updateMasterPlayState();
  saveManifest();
}

// ── Master transport ─────────────────────────────────────────────────
function playAll() {
  for (const tile of tiles.values()) {
    if (tile.enabled && tile.video && tile.state !== 'downloading' && tile.state !== 'error') {
      playTile(tile);
    }
  }
  updateMasterPlayState();
}

function stopAll() {
  for (const tile of tiles.values()) {
    if (tile.video) pauseTile(tile);
  }
  updateMasterPlayState();
}

function syncAll() {
  // Stop all, then restart all enabled tiles simultaneously from their loopStart
  for (const tile of tiles.values()) {
    if (tile.state === 'playing') {
      stopAudioSource(tile);
      if (tile.video) tile.video.pause();
      stopPlayheadAnimation(tile);
    }
    tile._pausedAt = undefined;
  }

  // Small delay to ensure all are stopped, then start together
  requestAnimationFrame(() => {
    for (const tile of tiles.values()) {
      if (tile.enabled && tile.video && tile.state !== 'downloading' && tile.state !== 'error') {
        const source = getSource(tile);
        if (source?.audioReady) {
          playAudio(tile, tile.loopStart);
          tile.video.muted = true;
          tile.video.currentTime = tile.loopStart;
          tile.video.play().catch(() => {});
        } else {
          tile.video.currentTime = tile.loopStart;
          tile.video.play().catch(() => {});
        }
        tile.state = 'playing';
        tile.els.tile.dataset.state = 'playing';
        tile.els.playBtn.textContent = 'STP';
        startPlayheadAnimation(tile);
      }
    }
    updateMasterPlayState();
  });
}

function isAnyPlaying() {
  return [...tiles.values()].some(t => t.state === 'playing');
}

function updateMasterPlayState() {
  playAllBtn.classList.toggle('active', isAnyPlaying());
}

// ── Waveform editor ──────────────────────────────────────────────────
function computePeaks(audioBuffer, numBuckets) {
  const channel = audioBuffer.getChannelData(0);
  const samplesPerBucket = channel.length / numBuckets;
  const peaks = new Float32Array(numBuckets);

  for (let i = 0; i < numBuckets; i++) {
    const start = Math.floor(i * samplesPerBucket);
    const end = Math.min(Math.floor((i + 1) * samplesPerBucket), channel.length);
    let max = 0;
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channel[j]);
      if (abs > max) max = abs;
    }
    peaks[i] = max;
  }
  return peaks;
}

let lastCanvasW = 0;
let lastCanvasH = 0;

// Map a time value to pixel x within the current view window
function timeToX(t, w) {
  return ((t - viewStart) / (viewEnd - viewStart)) * w;
}

function drawWaveform(peaks, loopStart, loopEnd, duration, playheadPos) {
  const dpr = window.devicePixelRatio || 1;
  const w = waveformCanvas.clientWidth;
  const h = waveformCanvas.clientHeight;

  if (w !== lastCanvasW || h !== lastCanvasH) {
    waveformCanvas.width = w * dpr;
    waveformCanvas.height = h * dpr;
    lastCanvasW = w;
    lastCanvasH = h;
  }
  waveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const centerY = h / 2;
  const viewDur = viewEnd - viewStart;

  const mutedColor = 'rgba(90, 85, 80, 0.35)';
  const activeColor = 'rgba(190, 95, 75, 0.7)';
  const playingActiveColor = 'rgba(80, 160, 110, 0.7)';
  const regionBg = 'rgba(190, 95, 75, 0.08)';
  const handleColor = 'rgb(190, 95, 75)';
  const playheadColor = 'rgb(215, 210, 205)';
  const gridColor = 'rgba(215, 210, 205, 0.08)';

  const isPlaying = editingTileId && tiles.get(editingTileId)?.state === 'playing';
  const loopColor = isPlaying ? playingActiveColor : activeColor;

  waveformCtx.clearRect(0, 0, w, h);

  const startX = timeToX(loopStart, w);
  const endX = timeToX(loopEnd, w);

  // Snap grid lines
  if (snapInterval > 0) {
    waveformCtx.fillStyle = gridColor;
    const firstGrid = Math.ceil((viewStart - snapOffset) / snapInterval) * snapInterval + snapOffset;
    for (let t = firstGrid; t <= viewEnd; t += snapInterval) {
      const gx = timeToX(t, w);
      waveformCtx.fillRect(Math.round(gx), 0, 1, h);
    }
  }

  // Loop region background
  waveformCtx.fillStyle = regionBg;
  waveformCtx.fillRect(startX, 0, endX - startX, h);

  // Waveform bars — only draw peaks visible in the view window
  const peakStart = Math.max(0, Math.floor((viewStart / duration) * peaks.length));
  const peakEnd = Math.min(peaks.length, Math.ceil((viewEnd / duration) * peaks.length));
  const barW = Math.max(1, w / (peakEnd - peakStart));

  for (let i = peakStart; i < peakEnd; i++) {
    const peakTime = (i / peaks.length) * duration;
    const x = timeToX(peakTime, w);
    const barH = peaks[i] * centerY * 0.9;
    const inLoop = peakTime >= loopStart && peakTime <= loopEnd;
    waveformCtx.fillStyle = inLoop ? loopColor : mutedColor;
    waveformCtx.fillRect(x, centerY - barH, barW, barH * 2);
  }

  // Handles (only draw if in view)
  waveformCtx.fillStyle = handleColor;
  if (loopStart >= viewStart && loopStart <= viewEnd)
    waveformCtx.fillRect(startX - 1, 0, 3, h);
  if (loopEnd >= viewStart && loopEnd <= viewEnd)
    waveformCtx.fillRect(endX - 2, 0, 3, h);

  // Playhead
  if (playheadPos >= viewStart && playheadPos <= viewEnd) {
    const px = timeToX(playheadPos, w);
    waveformCtx.fillStyle = playheadColor;
    waveformCtx.fillRect(px - 1, 0, 2, h);
  }

  // Draw minimap
  drawMinimap(peaks, loopStart, loopEnd, duration, playheadPos);
}

function drawMinimap(peaks, loopStart, loopEnd, duration, playheadPos) {
  const dpr = window.devicePixelRatio || 1;
  let mmCanvas = waveformMinimap.querySelector('canvas');
  if (!mmCanvas) {
    mmCanvas = document.createElement('canvas');
    waveformMinimap.appendChild(mmCanvas);
  }

  // Remove old viewport indicator
  let vp = waveformMinimap.querySelector('.minimap-viewport');
  if (!vp) {
    vp = document.createElement('div');
    vp.className = 'minimap-viewport';
    waveformMinimap.appendChild(vp);
  }

  const mw = waveformMinimap.clientWidth;
  const mh = waveformMinimap.clientHeight;
  mmCanvas.width = mw * dpr;
  mmCanvas.height = mh * dpr;
  const mmCtx = mmCanvas.getContext('2d');
  mmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mmCtx.clearRect(0, 0, mw, mh);

  const centerY = mh / 2;
  const barW = Math.max(0.5, mw / peaks.length);

  // Draw waveform
  for (let i = 0; i < peaks.length; i++) {
    const x = (i / peaks.length) * mw;
    const barH = peaks[i] * centerY * 0.85;
    const t = (i / peaks.length) * duration;
    const inLoop = t >= loopStart && t <= loopEnd;
    mmCtx.fillStyle = inLoop ? 'rgba(190, 95, 75, 0.5)' : 'rgba(90, 85, 80, 0.3)';
    mmCtx.fillRect(x, centerY - barH, barW, barH * 2);
  }

  // Playhead on minimap
  if (playheadPos >= 0) {
    const px = (playheadPos / duration) * mw;
    mmCtx.fillStyle = 'rgb(215, 210, 205)';
    mmCtx.fillRect(px, 0, 1, mh);
  }

  // Viewport indicator
  const vpLeft = (viewStart / duration) * 100;
  const vpWidth = ((viewEnd - viewStart) / duration) * 100;
  vp.style.left = `${vpLeft}%`;
  vp.style.width = `${vpWidth}%`;
}

function resizeWaveformCanvas() {
  const tile = tiles.get(editingTileId);
  if (!tile) return;
  const source = getSource(tile);
  if (!source?.audioReady) return;

  const w = waveformCanvas.clientWidth;
  if (w < 10) return;

  if (source.chunked && source.peaks) {
    // Use pre-computed peaks for chunked sources
    cachedPeaks = source.peaks;
  } else if (source.audioBuffer) {
    const numBuckets = Math.max(200, Math.min(w * 2, 2000));
    cachedPeaks = computePeaks(source.audioBuffer, numBuckets);
  } else {
    return;
  }
  lastCanvasW = 0;
}

// Re-measure canvas when panel transition finishes
waveformPanel.addEventListener('transitionend', () => {
  if (editingTileId) resizeWaveformCanvas();
});

function openWaveformEditor(tileId) {
  const tile = tiles.get(tileId);
  if (!tile) return;
  const source = getSource(tile);
  if (!source?.audioReady) return;

  // Remove editing class from previous tile
  if (editingTileId) {
    const prev = tiles.get(editingTileId);
    if (prev) prev.els.tile.classList.remove('editing');
  }

  editingTileId = tileId;
  tile.els.tile.classList.add('editing');

  // Reset view to full clip
  viewStart = 0;
  viewEnd = source.duration;

  waveformTitleEl.textContent = source.title;
  updateWaveformTimes(tile);

  waveformPanel.classList.add('open');
  document.body.classList.add('waveform-open');

  // Force layout recalculation, then initialize
  waveformPanel.offsetHeight;
  setupWaveformDrag();

  // Double-rAF ensures the panel has been painted before we measure the canvas
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      resizeWaveformCanvas();
      startWaveformAnimation();
    });
  });
}

function closeWaveformEditor() {
  if (editingTileId) {
    const tile = tiles.get(editingTileId);
    if (tile) tile.els.tile.classList.remove('editing');
  }
  editingTileId = null;
  cachedPeaks = null;
  waveformPanel.classList.remove('open');
  document.body.classList.remove('waveform-open');
  if (waveformAnimId) {
    cancelAnimationFrame(waveformAnimId);
    waveformAnimId = null;
  }
  if (waveformDragCleanup) {
    waveformDragCleanup();
    waveformDragCleanup = null;
  }
}

function updateWaveformTimes(tile) {
  waveformTimeStart.textContent = formatTimePrecise(tile.loopStart);
  waveformTimeEnd.textContent = formatTimePrecise(tile.loopEnd);
}

function startWaveformAnimation() {
  if (waveformAnimId) cancelAnimationFrame(waveformAnimId);

  function tick() {
    const tile = tiles.get(editingTileId);
    if (!tile) { closeWaveformEditor(); return; }
    const source = getSource(tile);
    if (!source || !cachedPeaks) return;

    let pos = -1;
    if (tile.state === 'playing') {
      pos = source.audioReady ? getAudioPosition(tile) : (tile.video?.currentTime ?? tile.loopStart);
    }

    // Auto-scroll to follow playhead when zoomed in
    if (pos >= 0) {
      const viewDur = viewEnd - viewStart;
      if (viewDur < source.duration) {
        const margin = viewDur * 0.15;
        if (pos > viewEnd - margin) {
          viewStart = pos - viewDur + margin;
          viewEnd = viewStart + viewDur;
          if (viewEnd > source.duration) { viewEnd = source.duration; viewStart = viewEnd - viewDur; }
        } else if (pos < viewStart + margin) {
          viewStart = pos - margin;
          viewEnd = viewStart + viewDur;
          if (viewStart < 0) { viewStart = 0; viewEnd = viewDur; }
        }
      }
    }

    drawWaveform(cachedPeaks, tile.loopStart, tile.loopEnd, source.duration, pos);
    waveformAnimId = requestAnimationFrame(tick);
  }
  waveformAnimId = requestAnimationFrame(tick);
}

function setupWaveformDrag() {
  if (waveformDragCleanup) waveformDragCleanup();

  const HANDLE_HIT = 10;

  const onPointerDown = (e) => {
    const tile = tiles.get(editingTileId);
    if (!tile) return;
    const source = getSource(tile);
    if (!source) return;

    e.preventDefault();
    try { waveformCanvas.setPointerCapture(e.pointerId); } catch {}

    const rect = waveformCanvas.getBoundingClientRect();
    // Map pixel to time using the current view window
    const toTime = (clientX) => {
      const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
      return viewStart + (x / rect.width) * (viewEnd - viewStart);
    };
    const snap = (t) => snapTime(t, snapInterval);

    const clickTime = toTime(e.clientX);
    const startPx = timeToX(tile.loopStart, rect.width);
    const endPx = timeToX(tile.loopEnd, rect.width);
    const px = e.clientX - rect.left;

    let mode;
    let regionOffset = 0;
    let regionLen = 0;
    let selectAnchor = 0;

    if (Math.abs(px - startPx) < HANDLE_HIT) {
      mode = 'start';
    } else if (Math.abs(px - endPx) < HANDLE_HIT) {
      mode = 'end';
    } else if (px > startPx + HANDLE_HIT && px < endPx - HANDLE_HIT) {
      mode = 'region';
      regionOffset = clickTime - tile.loopStart;
      regionLen = tile.loopEnd - tile.loopStart;
    } else {
      mode = 'select';
      selectAnchor = snap(clickTime);
      tile.loopStart = selectAnchor;
      tile.loopEnd = Math.min(selectAnchor + 0.5, source.duration);
    }

    const onMove = (ev) => {
      const rawTime = toTime(ev.clientX);

      if (mode === 'select') {
        const t = snap(rawTime);
        tile.loopStart = Math.max(0, Math.min(selectAnchor, t));
        tile.loopEnd = Math.min(source.duration, Math.max(selectAnchor, t));
        if (tile.loopEnd - tile.loopStart < 0.1) {
          tile.loopEnd = Math.min(tile.loopStart + 0.5, source.duration);
        }
      } else if (mode === 'region') {
        let newStart = snap(rawTime - regionOffset);
        newStart = Math.max(0, Math.min(newStart, source.duration - regionLen));
        tile.loopStart = newStart;
        tile.loopEnd = newStart + regionLen;
      } else {
        const t = snap(rawTime);
        if (mode === 'start') {
          tile.loopStart = Math.max(0, Math.min(t, tile.loopEnd - 0.1));
        } else {
          tile.loopEnd = Math.min(source.duration, Math.max(t, tile.loopStart + 0.1));
        }
      }

      updateAudioLoopPoints(tile);
      updateTileLoopIndicator(tile);
      updateWaveformTimes(tile);
    };

    const onUp = () => {
      waveformCanvas.removeEventListener('pointermove', onMove);
      waveformCanvas.removeEventListener('pointerup', onUp);
      saveManifest();
    };

    waveformCanvas.addEventListener('pointermove', onMove);
    waveformCanvas.addEventListener('pointerup', onUp);
  };

  // Wheel zoom centered on cursor position
  const clampView = (dur) => {
    if (viewStart < 0) { viewEnd -= viewStart; viewStart = 0; }
    if (viewEnd > dur) { viewStart -= (viewEnd - dur); viewEnd = dur; }
    viewStart = Math.max(0, viewStart);
    viewEnd = Math.min(dur, viewEnd);
  };

  const onWheel = (e) => {
    e.preventDefault();
    const tile = tiles.get(editingTileId);
    if (!tile) return;
    const source = getSource(tile);
    if (!source) return;

    const rect = waveformCanvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseFrac = mouseX / rect.width;
    const viewDur = viewEnd - viewStart;

    // Touchpad pinch (ctrlKey + deltaY) or mouse wheel = zoom
    if (e.ctrlKey || (!e.shiftKey && e.deltaX === 0)) {
      const mouseTime = viewStart + mouseFrac * viewDur;
      const zoomFactor = e.ctrlKey
        ? (1 + Math.abs(e.deltaY) * 0.01) ** (e.deltaY > 0 ? 1 : -1)
        : (e.deltaY > 0 ? 1.2 : 1 / 1.2);
      let newDur = viewDur * zoomFactor;
      newDur = Math.max(0.5, Math.min(newDur, source.duration));
      viewStart = mouseTime - mouseFrac * newDur;
      viewEnd = mouseTime + (1 - mouseFrac) * newDur;
    } else {
      // Touchpad two-finger horizontal scroll or shift+wheel = pan
      const panAmount = (e.deltaX || e.deltaY) * (viewDur / rect.width);
      viewStart += panAmount;
      viewEnd += panAmount;
    }

    clampView(source.duration);
  };

  // Minimap click/drag to pan
  const onMinimapDown = (e) => {
    const tile = tiles.get(editingTileId);
    if (!tile) return;
    const source = getSource(tile);
    if (!source) return;

    e.preventDefault();
    const rect = waveformMinimap.getBoundingClientRect();
    const viewDur = viewEnd - viewStart;

    const panTo = (clientX) => {
      const frac = (clientX - rect.left) / rect.width;
      const centerTime = frac * source.duration;
      viewStart = Math.max(0, Math.min(centerTime - viewDur / 2, source.duration - viewDur));
      viewEnd = viewStart + viewDur;
    };

    panTo(e.clientX);

    const onMove = (ev) => panTo(ev.clientX);
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  waveformCanvas.addEventListener('pointerdown', onPointerDown);
  waveformCanvas.addEventListener('wheel', onWheel, { passive: false });
  waveformMinimap.addEventListener('pointerdown', onMinimapDown);

  waveformDragCleanup = () => {
    waveformCanvas.removeEventListener('pointerdown', onPointerDown);
    waveformCanvas.removeEventListener('wheel', onWheel);
    waveformMinimap.removeEventListener('pointerdown', onMinimapDown);
  };
}

// ── Resize observer for waveform ─────────────────────────────────────
new ResizeObserver(() => {
  if (editingTileId) resizeWaveformCanvas();
}).observe(waveformCanvas);

waveformCloseBtn.addEventListener('click', closeWaveformEditor);

waveformFitBtn.addEventListener('click', () => {
  const tile = tiles.get(editingTileId);
  if (!tile) return;
  const source = getSource(tile);
  if (!source) return;
  viewStart = 0;
  viewEnd = source.duration;
});

// ── Event listeners ──────────────────────────────────────────────────
urlForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  if (!url.match(/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//)) {
    urlInput.style.borderColor = 'var(--accent)';
    setTimeout(() => { urlInput.style.borderColor = ''; }, 1500);
    return;
  }

  urlInput.value = '';
  addClip(url);
});

playAllBtn.addEventListener('click', () => {
  if (isAnyPlaying()) stopAll();
  else playAll();
});

stopAllBtn.addEventListener('click', stopAll);
syncBtn.addEventListener('click', syncAll);

// ── Sidebar ──────────────────────────────────────────────────────────
const sidebarEl = document.getElementById('sidebar');
const sidebarOverlayEl = document.getElementById('sidebar-overlay');
let sidebarOpen = false;

async function openSidebar() {
  sidebarOpen = true;
  sidebarEl.classList.add('open');
  sidebarOverlayEl.classList.add('open');

  // Load settings
  const cacheInfo = await window.api.getCacheInfo();
  document.getElementById('set-cache').value = cacheInfo.maxGB;
  document.getElementById('set-cache-used').textContent = `${cacheInfo.usedGB} GB / ${cacheInfo.files} files`;

  // Load recent decks
  const recent = await window.api.getRecentDecks();
  const recentSection = document.getElementById('sb-recent-section');
  const recentList = document.getElementById('sb-recent-list');
  recentList.innerHTML = '';
  if (recent.length > 0) {
    recentSection.style.display = '';
    for (const deck of recent) {
      const el = document.createElement('div');
      el.className = 'sidebar-item sidebar-recent';
      el.innerHTML = `<span class="sidebar-recent-name">${deck.name}</span>`;
      el.addEventListener('click', () => { closeSidebar(); loadDeckByPath(deck.path); });
      recentList.appendChild(el);
    }
  } else {
    recentSection.style.display = 'none';
  }
}

function closeSidebar() {
  sidebarOpen = false;
  sidebarEl.classList.remove('open');
  sidebarOverlayEl.classList.remove('open');
}

document.getElementById('menu-btn').addEventListener('click', (e) => {
  console.log('menu-btn clicked, sidebarOpen:', sidebarOpen);
  e.stopPropagation();
  if (sidebarOpen) closeSidebar();
  else openSidebar().catch(e => console.error('Sidebar error:', e));
});
document.getElementById('sidebar-close').addEventListener('click', closeSidebar);
sidebarOverlayEl.addEventListener('click', closeSidebar);

// Sidebar deck actions
document.getElementById('sb-new-deck').addEventListener('click', () => { closeSidebar(); newDeck(); });
document.getElementById('sb-save-deck').addEventListener('click', () => { closeSidebar(); saveDeck(); });
document.getElementById('sb-load-deck').addEventListener('click', () => { closeSidebar(); loadDeck(); });

// Settings change handlers
document.getElementById('set-cache').addEventListener('change', async (e) => {
  const gb = parseFloat(e.target.value);
  if (gb > 0 && isFinite(gb)) {
    await window.api.setMaxCache(gb);
    const info = await window.api.getCacheInfo();
    document.getElementById('set-cache-used').textContent = `${info.usedGB} GB / ${info.files} files`;
  }
});

document.getElementById('set-tile-size').addEventListener('change', (e) => {
  const size = parseInt(e.target.value);
  document.querySelector('.tiles-grid').style.gridTemplateColumns = `repeat(auto-fill, minmax(${size}px, 1fr))`;
});

// Persist settings changes to a simple settings object (stored via manifest or settings.json)
document.getElementById('set-quality').addEventListener('change', (e) => {
  localStorage.setItem('loopdec-quality', e.target.value);
});
document.getElementById('set-bitrate').addEventListener('change', (e) => {
  localStorage.setItem('loopdec-bitrate', e.target.value);
});
document.getElementById('set-snap').addEventListener('change', (e) => {
  localStorage.setItem('loopdec-snap', e.target.value);
});
document.getElementById('set-ytdlp').addEventListener('change', (e) => {
  localStorage.setItem('loopdec-ytdlp', e.target.value);
});

// Restore settings from localStorage on startup
(function restoreSettings() {
  const quality = localStorage.getItem('loopdec-quality');
  if (quality) document.getElementById('set-quality').value = quality;
  const bitrate = localStorage.getItem('loopdec-bitrate');
  if (bitrate) document.getElementById('set-bitrate').value = bitrate;
  const snap = localStorage.getItem('loopdec-snap');
  if (snap) document.getElementById('set-snap').value = snap;
  const tileSize = localStorage.getItem('loopdec-tile-size');
  if (tileSize) {
    document.getElementById('set-tile-size').value = tileSize;
    document.querySelector('.tiles-grid').style.gridTemplateColumns = `repeat(auto-fill, minmax(${tileSize}px, 1fr))`;
  }
  const ytdlp = localStorage.getItem('loopdec-ytdlp');
  if (ytdlp) document.getElementById('set-ytdlp').value = ytdlp;
})();

// Also persist tile size
document.getElementById('set-tile-size').addEventListener('change', (e) => {
  localStorage.setItem('loopdec-tile-size', e.target.value);
});

// Snap controls
const snapCustomInput = document.getElementById('snap-custom');
const snapOffsetInput = document.getElementById('snap-offset');
const snapOffsetTapBtn = document.getElementById('snap-offset-tap');

function setSnapInterval(val) {
  snapInterval = val;
  document.querySelectorAll('.snap-btn').forEach(b => b.classList.remove('active'));
  snapCustomInput.classList.remove('active');
  if (val === 0) {
    document.querySelector('[data-snap="0"]').classList.add('active');
    snapCustomInput.value = '';
  } else {
    const preset = document.querySelector(`[data-snap="${val}"]`);
    if (preset) preset.classList.add('active');
    else snapCustomInput.classList.add('active');
  }
}

document.getElementById('waveform-snap').addEventListener('click', (e) => {
  const btn = e.target.closest('.snap-btn');
  if (!btn) return;
  setSnapInterval(parseFloat(btn.dataset.snap));
  snapCustomInput.value = '';
});

snapCustomInput.addEventListener('input', () => {
  const val = parseFloat(snapCustomInput.value);
  if (val > 0 && isFinite(val)) {
    snapInterval = val;
    document.querySelectorAll('.snap-btn').forEach(b => b.classList.remove('active'));
    snapCustomInput.classList.add('active');
  }
});

snapCustomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    snapCustomInput.blur();
  }
  e.stopPropagation(); // prevent spacebar from triggering play/stop
});

snapOffsetInput.addEventListener('input', () => {
  const val = parseFloat(snapOffsetInput.value);
  if (isFinite(val)) snapOffset = Math.max(0, val);
});

snapOffsetInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); snapOffsetInput.blur(); }
  e.stopPropagation();
});

snapOffsetTapBtn.addEventListener('click', () => {
  const tile = tiles.get(editingTileId);
  if (!tile) return;
  const source = getSource(tile);
  if (!source) return;

  let pos = 0;
  if (tile.state === 'playing' && source.audioReady) {
    pos = getAudioPosition(tile);
  } else if (tile.video) {
    pos = tile.video.currentTime;
  }
  snapOffset = parseFloat(pos.toFixed(3));
  snapOffsetInput.value = snapOffset;
});

// ── Command palette ──────────────────────────────────────────────────
const cmdOverlay = document.getElementById('cmd-overlay');
const cmdInput = document.getElementById('cmd-input');
const cmdResults = document.getElementById('cmd-results');
let cmdOpen = false;
let cmdActiveIdx = 0;

function newDeck() {
  for (const tileId of [...tiles.keys()]) removeTile(tileId);
  currentDeckMeta = { name: '', description: '', created: null, modified: null };
  updateDeckTitle();
  updateEmptyState();
  saveManifest();
}

const baseCommands = [
  { id: 'new-deck', label: 'New Deck', hint: '', action: () => { closePalette(); newDeck(); } },
  { id: 'save-deck', label: 'Save Deck', hint: '', action: () => { closePalette(); saveDeck(); } },
  { id: 'load-deck', label: 'Load Deck', hint: '', action: () => { closePalette(); loadDeck(); } },
  { id: 'sep-1', separator: true },
  { id: 'add-url', label: 'Add YouTube URL', hint: '', action: () => { closePalette(); urlInput.focus(); } },
  { id: 'play-all', label: 'Play All', hint: 'Space', action: () => { closePalette(); playAll(); } },
  { id: 'stop-all', label: 'Stop All', hint: 'Space', action: () => { closePalette(); stopAll(); } },
  { id: 'sync-all', label: 'Sync All', hint: '', action: () => { closePalette(); syncAll(); } },
  { id: 'fit-waveform', label: 'Fit Waveform', hint: '', action: () => {
    closePalette();
    const tile = tiles.get(editingTileId);
    if (tile) { const src = getSource(tile); if (src) { viewStart = 0; viewEnd = src.duration; } }
  }},
  { id: 'sep-cache', separator: true },
  { id: 'cache-info', label: 'Cache Info', hint: '', action: async () => {
    const info = await window.api.getCacheInfo();
    await palettePrompt(`Cache: ${info.usedGB} GB / ${info.maxGB} GB (${info.files} files) — press Enter`, '');
    closePalette();
  }},
  { id: 'set-cache-size', label: 'Set Cache Size', hint: '', action: async () => {
    closePalette();
    const info = await window.api.getCacheInfo();
    const input = await palettePrompt(`Max cache GB (current: ${info.maxGB})`, info.maxGB);
    if (input !== null) {
      const gb = parseFloat(input);
      if (gb > 0 && isFinite(gb)) await window.api.setMaxCache(gb);
    }
  }},
  { id: 'clear-cache', label: 'Clear Unused Cache', hint: '', action: async () => {
    closePalette();
    await window.api.clearCache();
  }},
];

let cachedRecentDecks = [];

async // Reuse the palette as a single-line prompt (replaces window.prompt which Electron blocks)
function palettePrompt(placeholder, defaultVal) {
  return new Promise((resolve) => {
    cmdOpen = true;
    cmdInput.value = defaultVal || '';
    cmdInput.placeholder = placeholder;
    cmdResults.innerHTML = '';
    cmdOverlay.classList.add('open');
    cmdInput.focus();
    cmdInput.select();

    const cleanup = () => {
      cmdInput.removeEventListener('keydown', onKey);
      cmdOverlay.removeEventListener('click', onClickOut);
      cmdInput.placeholder = 'Type a command...';
      closePalette();
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(cmdInput.value || null); }
      else if (e.key === 'Escape') { e.stopPropagation(); cleanup(); resolve(null); }
    };
    const onClickOut = (e) => { if (e.target === cmdOverlay) { cleanup(); resolve(null); } };

    cmdInput.addEventListener('keydown', onKey);
    cmdOverlay.addEventListener('click', onClickOut);
  });
}

async function openPalette() {
  cmdOpen = true;
  cmdInput.value = '';
  cmdActiveIdx = 0;
  cmdOverlay.classList.add('open');

  cachedRecentDecks = await window.api.getRecentDecks();
  renderCmdResults('');
  cmdInput.focus();
}

function closePalette() {
  cmdOpen = false;
  cmdOverlay.classList.remove('open');
}

function buildCommandList(query) {
  const q = query.toLowerCase();

  // Build full list: base commands + recent decks
  let all = [...baseCommands];

  if (cachedRecentDecks.length > 0) {
    all.push({ id: 'sep-recent', separator: true });
    for (const deck of cachedRecentDecks) {
      all.push({
        id: `recent-${deck.path}`,
        label: deck.name,
        sublabel: 'recent deck',
        hint: '',
        action: () => { closePalette(); loadDeckByPath(deck.path); },
      });
    }
  }

  if (q) {
    all = all.filter(c => c.separator ? false : c.label.toLowerCase().includes(q) || c.sublabel?.toLowerCase().includes(q));
  }

  return all;
}

function renderCmdResults(query) {
  const filtered = buildCommandList(query);
  const actionable = filtered.filter(c => !c.separator);
  cmdActiveIdx = Math.min(cmdActiveIdx, Math.max(0, actionable.length - 1));

  cmdResults.innerHTML = '';
  let actionIdx = 0;
  for (const cmd of filtered) {
    if (cmd.separator) {
      const sep = document.createElement('div');
      sep.className = 'cmd-separator';
      cmdResults.appendChild(sep);
      continue;
    }

    const isActive = actionIdx === cmdActiveIdx;
    const div = document.createElement('div');
    div.className = 'cmd-item' + (isActive ? ' active' : '');

    let labelHtml = cmd.label;
    if (cmd.sublabel) labelHtml += `<span class="cmd-sublabel">${cmd.sublabel}</span>`;
    div.innerHTML = `<span class="cmd-item-label">${labelHtml}</span>${cmd.hint ? `<span class="cmd-item-hint">${cmd.hint}</span>` : ''}`;

    const idx = actionIdx;
    div.addEventListener('click', () => cmd.action());
    div.addEventListener('mouseenter', () => {
      cmdActiveIdx = idx;
      cmdResults.querySelectorAll('.cmd-item').forEach((el, j) => {
        el.classList.toggle('active', j === [...cmdResults.querySelectorAll('.cmd-item')].indexOf(el) && el === div);
      });
      // Simpler: just toggle all
      const items = cmdResults.querySelectorAll('.cmd-item');
      items.forEach(el => el.classList.remove('active'));
      div.classList.add('active');
    });
    cmdResults.appendChild(div);
    actionIdx++;
  }
}

cmdInput.addEventListener('input', () => renderCmdResults(cmdInput.value));

cmdInput.addEventListener('keydown', (e) => {
  const items = cmdResults.querySelectorAll('.cmd-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    cmdActiveIdx = Math.min(cmdActiveIdx + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle('active', i === cmdActiveIdx));
    items[cmdActiveIdx]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    cmdActiveIdx = Math.max(cmdActiveIdx - 1, 0);
    items.forEach((el, i) => el.classList.toggle('active', i === cmdActiveIdx));
    items[cmdActiveIdx]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const actionable = buildCommandList(cmdInput.value).filter(c => !c.separator);
    if (actionable[cmdActiveIdx]) actionable[cmdActiveIdx].action();
  } else if (e.key === 'Escape') {
    closePalette();
  }
  e.stopPropagation();
});

cmdOverlay.addEventListener('click', (e) => {
  if (e.target === cmdOverlay) closePalette();
});

// ── Deck save/load ───────────────────────────────────────────────────
function buildDeckData() {
  const data = {
    meta: {
      name: currentDeckMeta.name || 'Untitled',
      description: currentDeckMeta.description || '',
      created: currentDeckMeta.created || new Date().toISOString(),
      modified: new Date().toISOString(),
      tileCount: tiles.size,
      sourceCount: sources.size,
    },
    sources: {},
    tiles: [],
  };
  for (const [id, src] of sources) {
    data.sources[id] = {
      id, url: src.url, title: src.title, duration: src.duration,
      chunked: src.chunked || false, chunkCount: src.chunkCount || 0, chunkDuration: src.chunkDuration || 0,
    };
  }
  for (const tile of tiles.values()) {
    data.tiles.push({
      id: tile.id, sourceId: tile.sourceId,
      loopStart: tile.loopStart, loopEnd: tile.loopEnd,
      enabled: tile.enabled, volume: tile.volume,
    });
  }
  return data;
}

async function saveDeck() {
  if (!currentDeckMeta.name) {
    const name = await palettePrompt('Deck name (Enter to confirm)', 'Untitled');
    if (!name) return;
    currentDeckMeta.name = name;
  }
  if (!currentDeckMeta.created) currentDeckMeta.created = new Date().toISOString();
  const data = buildDeckData();
  const result = await window.api.saveDeck(data);
  if (result?.ok) {
    currentDeckMeta.modified = new Date().toISOString();
    updateDeckTitle();
  }
}

async function loadDeckByPath(filePath) {
  const data = await window.api.loadDeckPath(filePath);
  if (data) await applyDeckData(data);
}

async function loadDeck() {
  const data = await window.api.loadDeck();
  if (data) await applyDeckData(data);
}

async function applyDeckData(data) {
  if (!data?.sources || !data?.tiles) return;

  // Restore deck metadata
  if (data.meta) {
    currentDeckMeta = {
      name: data.meta.name || '',
      description: data.meta.description || '',
      created: data.meta.created || null,
      modified: data.meta.modified || null,
    };
  } else {
    currentDeckMeta = { name: '', description: '', created: null, modified: null };
  }
  updateDeckTitle();

  // Collect source IDs that will be reloaded so we don't delete their cached files
  const incomingSourceIds = new Set(Object.keys(data.sources));

  // Clear tiles without deleting files for sources being reloaded
  for (const tileId of [...tiles.keys()]) {
    const tile = tiles.get(tileId);
    if (!tile) continue;

    if (editingTileId === tileId) closeWaveformEditor();
    stopAudioSource(tile);
    if (tile.gainNode) { try { tile.gainNode.disconnect(); } catch {} tile.gainNode = null; }
    if (tile.video) { tile.video.pause(); tile.video.src = ''; }
    stopPlayheadAnimation(tile);
    tile.els.tile.remove();
    tiles.delete(tileId);

    // Only delete files if the source won't be reloaded
    if (tilesForSource(tile.sourceId).length === 0 && !incomingSourceIds.has(tile.sourceId)) {
      sources.delete(tile.sourceId);
      window.api.deleteClip(tile.sourceId);
    }
  }
  // Clear any remaining sources not in the incoming deck
  for (const id of [...sources.keys()]) {
    if (!incomingSourceIds.has(id)) sources.delete(id);
  }

  for (const [id, src] of Object.entries(data.sources)) {
    sources.set(id, {
      id, url: src.url, title: src.title, duration: src.duration,
      audioBuffer: null, audioReady: false,
      chunked: src.chunked || false, chunkCount: src.chunkCount || 0, chunkDuration: src.chunkDuration || 0,
      decodedChunks: null, peaks: null,
    });
  }

  for (const td of data.tiles) {
    const source = sources.get(td.sourceId);
    if (!source) continue;

    const tile = {
      id: td.id, sourceId: td.sourceId,
      loopStart: td.loopStart, loopEnd: td.loopEnd,
      enabled: td.enabled !== false, state: 'paused',
      video: null, audioSource: null, audioStartedAt: 0, audioStartedOffset: 0,
      _pausedAt: undefined, animFrameId: null,
      volume: td.volume ?? 1, gainNode: null, muted: false, els: {},
    };

    const tileNum = parseInt(tile.id.split('_').pop()) || 0;
    if (tileNum >= tileCounter) tileCounter = tileNum + 1;
    const srcNum = parseInt(td.sourceId.split('_').pop()) || 0;
    if (srcNum >= sourceCounter) sourceCounter = srcNum + 1;

    tiles.set(tile.id, tile);
    const tileEl = createTileElement(tile, source);
    tilesGrid.insertBefore(tileEl, emptyState);

    if (tile.volume !== 1 && tile.els.volumeSlider) tile.els.volumeSlider.value = tile.volume;
    if (!tile.enabled) {
      tile.els.tile.dataset.enabled = 'false';
      tile.els.toggleBtn.textContent = 'OFF';
      tile.els.toggleBtn.classList.remove('enabled');
    }
  }

  updateEmptyState();
  saveManifest();

  for (const source of sources.values()) {
    (async () => {
      try {
        await window.api.downloadClip(source.url, source.id);
        for (const t of tilesForSource(source.id)) {
          t.state = 'paused';
          t.els.tile.dataset.state = 'paused';
          loadVideo(t, source);
          updateTileLoopIndicator(t);
        }
        const result = await window.api.extractAudio(source.id);
        if (result.ok) {
          if (result.chunked) { source.chunked = true; source.chunkCount = result.chunkCount; source.chunkDuration = result.chunkDuration; }
          await decodeSourceAudio(source);
          saveManifest();
        }
      } catch {
        for (const t of tilesForSource(source.id)) {
          t.state = 'error'; t.els.tile.dataset.state = 'error';
        }
      }
    })();
  }
}

// ── Draggable number input ───────────────────────────────────────────
(function setupDragNumber() {
  const el = snapOffsetInput;
  let dragging = false;
  let startX = 0;
  let startVal = 0;

  el.addEventListener('pointerdown', (e) => {
    if (document.activeElement === el) return; // Already focused for text editing
    dragging = true;
    startX = e.clientX;
    startVal = parseFloat(el.value) || 0;
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const delta = (e.clientX - startX) * parseFloat(el.step || 0.01);
    const newVal = Math.max(0, startVal + delta);
    el.value = newVal.toFixed(2);
    snapOffset = newVal;
  });

  el.addEventListener('pointerup', () => { dragging = false; });
  el.addEventListener('lostpointercapture', () => { dragging = false; });
})();

// ── Global keyboard handler ──────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Command palette
  if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
    e.preventDefault();
    if (cmdOpen) closePalette();
    else openPalette();
    return;
  }

  if (cmdOpen) return;

  if (e.code === 'Escape' && sidebarOpen) {
    closeSidebar();
    return;
  }
  if (e.code === 'Escape' && editingTileId) {
    closeWaveformEditor();
    return;
  }
  if (e.code === 'Space' && !document.activeElement?.matches('input')) {
    e.preventDefault();
    if (isAnyPlaying()) stopAll();
    else playAll();
  }
});

// ── Download progress ────────────────────────────────────────────────
window.api.onDownloadProgress(({ clipId: sourceId, progress }) => {
  for (const tile of tilesForSource(sourceId)) {
    if (tile.els.progressFill) {
      tile.els.progressFill.style.width = `${progress}%`;
    }
    if (tile.els.downloadLabel) {
      tile.els.downloadLabel.textContent = progress < 100 ? `${Math.floor(progress)}%` : 'Loading';
    }
  }
});

// ── Restore session on startup ───────────────────────────────────────
restoreSession();

const { app, BrowserWindow, ipcMain, protocol, dialog } = require('electron');
const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const binManager = require('./bin-manager');

// ── Path helpers ─────────────────────────────────────────────────────
function clipPath(id) { return path.join(DOWNLOADS_DIR, `${id}.mp4`); }
function audioPath(id) { return path.join(DOWNLOADS_DIR, `${id}_audio.m4a`); }
function chunkPath(id, idx) { return path.join(DOWNLOADS_DIR, `${id}_chunk_${String(idx).padStart(3, '0')}.m4a`); }
function peaksPath(id) { return path.join(DOWNLOADS_DIR, `${id}_peaks.bin`); }
const MANIFEST_PATH = path.join(app.getPath('userData'), 'manifest.json');
const CHUNK_DURATION = 60;
const CHUNK_THRESHOLD = 30 * 1024 * 1024;
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_MAX_CACHE = 10 * 1024 * 1024 * 1024; // 10GB

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch {}
}

const DOWNLOADS_DIR = path.join(app.getPath('userData'), 'clips');

function ensureDownloadsDir() {
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }
}

// Register custom protocol for streaming clip files to <video>
protocol.registerSchemesAsPrivileged([
  { scheme: 'clip', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true } },
]);

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: -100, y: -100 }, // hide native controls
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  ensureDownloadsDir();

  // Handle clip:// protocol — serves downloaded mp4 files to <video> elements
  // Must support Range requests for video seeking/playback
  protocol.handle('clip', (request) => {
    const id = decodeURIComponent(request.url.slice('clip:///'.length));
    const filePath = clipPath(id);

    let stat;
    try { stat = fs.statSync(filePath); } catch {
      return new Response('Not found', { status: 404 });
    }

    const fileSize = stat.size;
    const rangeHeader = request.headers.get('Range');

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (!match) return new Response('Bad range', { status: 416 });
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      return new Response(fs.createReadStream(filePath, { start, end }), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
          'Content-Type': 'video/mp4',
        },
      });
    }

    return new Response(fs.createReadStream(filePath), {
      status: 200,
      headers: {
        'Content-Length': String(fileSize),
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
      },
    });
  });

  createWindow();

  mainWindow.webContents.once('did-finish-load', () => {
    bootstrapBinaries();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Window controls ──────────────────────────────────────────────────
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('win-close', () => mainWindow?.close());

// Managed binaries live in bin/ next to the app executable — see bin-manager.js.
function ytDlp() { return binManager.ytDlpPath(); }
function ffmpeg() { return binManager.ffmpegPath(); }

function sendSetup(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('binary-setup', payload);
  }
}

async function bootstrapBinaries() {
  if (binManager.binariesPresent()) {
    sendSetup({ phase: 'ready' });
  } else {
    sendSetup({ phase: 'first-run' });
    try {
      await binManager.ensureBinaries(sendSetup);
      sendSetup({ phase: 'ready' });
    } catch (e) {
      console.error('[main] ensureBinaries failed:', e);
      sendSetup({ phase: 'error', error: e.message });
      return;
    }
  }
  // Background update check (daily yt-dlp, monthly ffmpeg).
  binManager.checkForUpdates((p) => sendSetup({ ...p, background: true }))
    .catch((e) => console.error('[main] update check failed:', e));
}

ipcMain.handle('get-ytdlp-version', async () => {
  const version = await binManager.getYtDlpVersion();
  return { version };
});

ipcMain.handle('get-ffmpeg-version', async () => {
  const version = await binManager.getFfmpegVersion();
  return { version };
});

ipcMain.handle('force-check-updates', async () => {
  await binManager.checkForUpdates((p) => sendSetup({ ...p, background: true }), { force: true });
  return true;
});

// Get video info (title, duration) without downloading
ipcMain.handle('get-video-info', async (_event, url) => {
  return new Promise((resolve, reject) => {
    execFile(ytDlp(), [
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      url,
    ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error.message);
      try {
        const info = JSON.parse(stdout);
        resolve({
          title: info.title || 'Untitled',
          duration: info.duration || 0,
          thumbnail: info.thumbnail || '',
          id: info.id || '',
        });
      } catch (e) {
        reject('Failed to parse video info');
      }
    });
  });
});

ipcMain.handle('download-clip', async (event, url, clipId) => {
  const outPath = clipPath(clipId);

  try { fs.accessSync(outPath); return outPath; } catch {}

  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlp(), [
      '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--no-warnings',
      '--newline',
      '--progress',
      '-o', outPath,
      url,
    ]);

    let lastStderr = '';

    const parseProgress = (data) => {
      const line = data.toString();
      const match = line.match(/(\d+\.?\d*)%/);
      if (match) {
        mainWindow?.webContents.send('download-progress', {
          clipId,
          progress: parseFloat(match[1]),
        });
      }
    };

    proc.stderr.on('data', (data) => {
      lastStderr = data.toString();
      parseProgress(data);
    });
    proc.stdout.on('data', parseProgress);

    proc.on('close', (code) => {
      if (code === 0) { evictOldCache(); resolve(outPath); }
      else reject(lastStderr || `yt-dlp exited with code ${code}`);
    });

    proc.on('error', (err) => reject(err.message));
  });
});

// ── Audio extraction via ffmpeg ───────────────────────────────────────
// Extract audio: small files → single m4a, large files → chunked
ipcMain.handle('extract-audio', async (_event, clipId) => {
  if (!fs.existsSync(ffmpeg())) return { ok: false, reason: 'ffmpeg-missing' };

  const mp4 = clipPath(clipId);
  try { fs.accessSync(mp4); } catch { return { ok: false, reason: 'mp4-missing' }; }

  // Check if already chunked
  if (fs.existsSync(chunkPath(clipId, 0))) {
    const count = countChunks(clipId);
    return { ok: true, chunked: true, chunkCount: count, chunkDuration: CHUNK_DURATION };
  }

  // Check if single m4a already exists
  const audio = audioPath(clipId);
  if (fs.existsSync(audio)) {
    const stat = fs.statSync(audio);
    if (stat.size > CHUNK_THRESHOLD) {
      // Already extracted but too large — chunk it
      return await extractChunked(clipId, audio);
    }
    return { ok: true, chunked: false };
  }

  // Extract single m4a first
  const extracted = await extractSingleAudio(clipId, mp4, audio);
  if (!extracted) return { ok: false, reason: 'extraction-failed' };

  // Check if it needs chunking
  const stat = fs.statSync(audio);
  if (stat.size > CHUNK_THRESHOLD) {
    return await extractChunked(clipId, audio);
  }

  return { ok: true, chunked: false };
});

function extractSingleAudio(clipId, mp4, audio) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg(), ['-i', mp4, '-vn', '-c:a', 'copy', '-y', audio], { timeout: 300000 });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(audio)) return resolve(true);
      const proc2 = spawn(ffmpeg(), ['-i', mp4, '-vn', '-c:a', 'aac', '-b:a', '192k', '-y', audio], { timeout: 600000 });
      proc2.on('close', (code2) => resolve(code2 === 0 && fs.existsSync(audio)));
      proc2.on('error', () => resolve(false));
    });
    proc.on('error', () => resolve(false));
  });
}

function extractChunked(clipId, audioFile) {
  return new Promise((resolve) => {
    const pattern = path.join(DOWNLOADS_DIR, `${clipId}_chunk_%03d.m4a`);
    const proc = spawn(ffmpeg(), [
      '-i', audioFile,
      '-f', 'segment', '-segment_time', String(CHUNK_DURATION),
      '-c:a', 'aac', '-b:a', '192k', '-y',
      pattern,
    ], { timeout: 600000 });

    proc.on('close', (code) => {
      if (code === 0) {
        const count = countChunks(clipId);
        if (count > 0) {
          // Compute peaks for waveform
          computeAndSavePeaks(clipId, audioFile).then(() => {
            resolve({ ok: true, chunked: true, chunkCount: count, chunkDuration: CHUNK_DURATION });
          });
          return;
        }
      }
      resolve({ ok: false, reason: 'chunking-failed' });
    });
    proc.on('error', () => resolve({ ok: false, reason: 'ffmpeg-error' }));
  });
}

function countChunks(clipId) {
  let i = 0;
  while (fs.existsSync(chunkPath(clipId, i))) i++;
  return i;
}

// Compute waveform peaks from full audio file and save to disk
function computeAndSavePeaks(clipId, audioFile) {
  return new Promise((resolve) => {
    const NUM_PEAKS = 4000;
    // ffmpeg outputs raw mono float32 at low sample rate for peak computation
    const proc = spawn(ffmpeg(), [
      '-i', audioFile, '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'
    ], { timeout: 300000 });

    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('close', (code) => {
      if (code !== 0) { resolve(); return; }
      const raw = Buffer.concat(chunks);
      const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      const samplesPerBucket = Math.max(1, Math.floor(samples.length / NUM_PEAKS));
      const peaks = new Float32Array(Math.min(NUM_PEAKS, samples.length));

      for (let i = 0; i < peaks.length; i++) {
        const start = i * samplesPerBucket;
        const end = Math.min(start + samplesPerBucket, samples.length);
        let max = 0;
        for (let j = start; j < end; j++) {
          const abs = Math.abs(samples[j]);
          if (abs > max) max = abs;
        }
        peaks[i] = max;
      }

      fs.writeFileSync(peaksPath(clipId), Buffer.from(peaks.buffer));
      resolve();
    });
    proc.on('error', () => resolve());
  });
}

ipcMain.handle('get-audio-buffer', async (_event, clipId) => {
  const p = audioPath(clipId);
  try {
    const stat = fs.statSync(p);
    if (stat.size > CHUNK_THRESHOLD) return { error: 'use-chunks', size: stat.size };
    const data = fs.readFileSync(p);
    return data.buffer;
  } catch { return null; }
});

ipcMain.handle('get-audio-chunk', async (_event, clipId, chunkIndex) => {
  const p = chunkPath(clipId, chunkIndex);
  try {
    const data = fs.readFileSync(p);
    return data.buffer;
  } catch { return null; }
});

ipcMain.handle('get-audio-peaks', async (_event, clipId) => {
  const p = peaksPath(clipId);
  try {
    const data = fs.readFileSync(p);
    return data.buffer;
  } catch { return null; }
});

ipcMain.handle('delete-clip', async (_event, clipId) => {
  safeUnlink(clipPath(clipId));
  safeUnlink(audioPath(clipId));
  safeUnlink(peaksPath(clipId));
  // Delete all chunks
  let i = 0;
  while (true) {
    const p = chunkPath(clipId, i);
    if (!fs.existsSync(p)) break;
    safeUnlink(p);
    i++;
  }
  return true;
});

// ── Cache management ─────────────────────────────────────────────────
function getMaxCacheSize() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    return s.maxCacheBytes ?? DEFAULT_MAX_CACHE;
  } catch { return DEFAULT_MAX_CACHE; }
}

function setMaxCacheSize(bytes) {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')); } catch {}
  settings.maxCacheBytes = bytes;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function getCacheFiles() {
  try {
    return fs.readdirSync(DOWNLOADS_DIR)
      .map(name => {
        const full = path.join(DOWNLOADS_DIR, name);
        try {
          const stat = fs.statSync(full);
          return { name, path: full, size: stat.size, mtime: stat.mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

function getCacheSize() {
  return getCacheFiles().reduce((sum, f) => sum + f.size, 0);
}

function getActiveSourceIds() {
  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(raw);
    return new Set(Object.keys(manifest.sources || {}));
  } catch { return new Set(); }
}

function evictOldCache() {
  const maxBytes = getMaxCacheSize();
  let totalSize = getCacheSize();
  if (totalSize <= maxBytes) return;

  const activeIds = getActiveSourceIds();
  const files = getCacheFiles().sort((a, b) => a.mtime - b.mtime); // oldest first

  for (const file of files) {
    if (totalSize <= maxBytes) break;
    // Extract source ID from filename (e.g., src_123_456.mp4 → src_123_456)
    const match = file.name.match(/^(src_\d+_\d+)/);
    if (!match) continue;
    const sourceId = match[1];
    // Don't evict files belonging to active sources
    if (activeIds.has(sourceId)) continue;
    safeUnlink(file.path);
    totalSize -= file.size;
  }
}

ipcMain.handle('get-cache-info', async () => {
  const maxBytes = getMaxCacheSize();
  const usedBytes = getCacheSize();
  const files = getCacheFiles().length;
  return { maxBytes, usedBytes, files, maxGB: (maxBytes / (1024 ** 3)).toFixed(1), usedGB: (usedBytes / (1024 ** 3)).toFixed(2) };
});

ipcMain.handle('set-max-cache', async (_event, gb) => {
  const bytes = Math.max(1024 * 1024 * 512, gb * 1024 ** 3); // min 512MB
  setMaxCacheSize(bytes);
  evictOldCache();
  return true;
});

ipcMain.handle('clear-cache', async () => {
  const activeIds = getActiveSourceIds();
  for (const file of getCacheFiles()) {
    const match = file.name.match(/^(src_\d+_\d+)/);
    if (match && activeIds.has(match[1])) continue;
    safeUnlink(file.path);
  }
  return getCacheSize();
});

// ── Session manifest (persist/restore tiles across restarts) ─────────
ipcMain.handle('save-manifest', async (_event, data) => {
  try {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(data, null, 2));
    return true;
  } catch { return false; }
});

ipcMain.handle('load-manifest', async () => {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
    const manifest = JSON.parse(raw);
    // Verify referenced files still exist
    if (manifest.sources) {
      for (const [id, src] of Object.entries(manifest.sources)) {
        try { fs.accessSync(clipPath(id)); } catch {
          delete manifest.sources[id];
          manifest.tiles = (manifest.tiles || []).filter(t => t.sourceId !== id);
        }
      }
    }
    return manifest;
  } catch { return null; }
});

// ── Deck save/load ───────────────────────────────────────────────────
const RECENT_DECKS_PATH = path.join(app.getPath('userData'), 'recent-decks.json');
const MAX_RECENT = 8;

function getRecentDecks() {
  try {
    return JSON.parse(fs.readFileSync(RECENT_DECKS_PATH, 'utf-8'));
  } catch { return []; }
}

function addRecentDeck(filePath) {
  let recent = getRecentDecks().filter(r => r.path !== filePath);
  const name = path.basename(filePath, '.dec');
  recent.unshift({ path: filePath, name, time: Date.now() });
  if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
  try { fs.writeFileSync(RECENT_DECKS_PATH, JSON.stringify(recent)); } catch {}
}

ipcMain.handle('save-deck', async (_event, deckData) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Deck',
    defaultPath: 'session.dec',
    filters: [{ name: 'LoopDec Deck', extensions: ['dec'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false };
  try {
    fs.writeFileSync(result.filePath, JSON.stringify(deckData, null, 2));
    addRecentDeck(result.filePath);
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('load-deck', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Load Deck',
    filters: [{ name: 'LoopDec Deck', extensions: ['dec'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths?.length) return null;
  try {
    const raw = fs.readFileSync(result.filePaths[0], 'utf-8');
    const data = JSON.parse(raw);
    addRecentDeck(result.filePaths[0]);
    return data;
  } catch { return null; }
});

ipcMain.handle('load-deck-path', async (_event, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    addRecentDeck(filePath);
    return data;
  } catch { return null; }
});

ipcMain.handle('get-recent-decks', async () => {
  const recent = getRecentDecks();
  // Filter out files that no longer exist
  return recent.filter(r => { try { fs.accessSync(r.path); return true; } catch { return false; } });
});

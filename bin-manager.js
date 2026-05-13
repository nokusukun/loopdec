const { app, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const extract = require('extract-zip');

const PLATFORM = process.platform;
const YT_DLP_EXEC = PLATFORM === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const FFMPEG_EXEC = PLATFORM === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

const YT_DLP_ASSET = {
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp_macos',
  linux: 'yt-dlp_linux',
}[PLATFORM] || 'yt-dlp';

const ONE_DAY = 24 * 60 * 60 * 1000;
const THIRTY_DAYS = 30 * ONE_DAY;

function binDir() {
  const base = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
  return path.join(base, 'bin');
}
function ytDlpPath() { return path.join(binDir(), YT_DLP_EXEC); }
function ffmpegPath() { return path.join(binDir(), FFMPEG_EXEC); }
function metaPath() { return path.join(binDir(), 'bin-meta.json'); }

function readMeta() {
  try { return JSON.parse(fs.readFileSync(metaPath(), 'utf-8')); }
  catch { return {}; }
}
function writeMeta(meta) {
  fs.mkdirSync(binDir(), { recursive: true });
  fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2));
}

function binariesPresent() {
  try { fs.accessSync(ytDlpPath()); fs.accessSync(ffmpegPath()); return true; }
  catch { return false; }
}

function download(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmp = destPath + '.partial';
    try { fs.unlinkSync(tmp); } catch {}
    const file = fs.createWriteStream(tmp);

    const req = net.request({ url, redirect: 'follow' });
    req.setHeader('User-Agent', 'loopdec');

    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        file.destroy();
        try { fs.unlinkSync(tmp); } catch {}
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        file.write(chunk);
        if (onProgress) onProgress({ received, total });
      });
      res.on('end', () => {
        file.end(() => {
          try {
            fs.renameSync(tmp, destPath);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
      res.on('error', (e) => { file.destroy(); reject(e); });
    });
    req.on('error', (e) => { file.destroy(); reject(e); });
    req.end();
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow' });
    req.setHeader('User-Agent', 'loopdec');
    req.setHeader('Accept', 'application/json');
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchLatestTag(repo) {
  const json = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
  return json?.tag_name || null;
}

function findFile(dir, regex) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      const r = findFile(full, regex);
      if (r) return r;
    } else if (regex.test(name)) {
      return full;
    }
  }
  return null;
}

async function downloadYtDlp(onProgress) {
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YT_DLP_ASSET}`;
  const dest = ytDlpPath();
  await download(url, dest, (p) => onProgress?.({ name: 'yt-dlp', phase: 'downloading', ...p }));
  if (PLATFORM !== 'win32') { try { fs.chmodSync(dest, 0o755); } catch {} }
}

async function downloadFfmpeg(onProgress) {
  if (PLATFORM !== 'win32') {
    // macOS/Linux ffmpeg auto-install not implemented yet — fail loudly so the UI can surface a manual-install hint.
    throw new Error(`Automatic ffmpeg install not supported on ${PLATFORM}`);
  }
  const zipUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';
  const tmpZip = path.join(binDir(), 'ffmpeg.zip');
  const extractTmp = path.join(binDir(), 'ffmpeg-extract');
  fs.mkdirSync(binDir(), { recursive: true });
  try { fs.rmSync(extractTmp, { recursive: true, force: true }); } catch {}

  await download(zipUrl, tmpZip, (p) => onProgress?.({ name: 'ffmpeg', phase: 'downloading', ...p }));

  onProgress?.({ name: 'ffmpeg', phase: 'extracting' });
  await extract(tmpZip, { dir: extractTmp });
  const exe = findFile(extractTmp, /^ffmpeg\.exe$/i);
  if (!exe) throw new Error('ffmpeg.exe not found in archive');
  // Write to a .new file first, then rename — handles the case where ffmpeg.exe is in use.
  const dest = ffmpegPath();
  const newPath = dest + '.new';
  fs.copyFileSync(exe, newPath);
  try { fs.renameSync(newPath, dest); }
  catch {
    // Old exe is locked — leave .new in place; next launch will pick it up.
    onProgress?.({ name: 'ffmpeg', phase: 'pending-restart' });
  }
  try { fs.rmSync(extractTmp, { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(tmpZip); } catch {}
}

function applyPendingSwap(targetPath) {
  const pending = targetPath + '.new';
  if (fs.existsSync(pending)) {
    try { fs.renameSync(pending, targetPath); } catch {}
  }
}

function getYtDlpVersion() {
  return new Promise((resolve) => {
    execFile(ytDlpPath(), ['--version'], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : stdout.toString().trim());
    });
  });
}

function getFfmpegVersion() {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), ['-version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = stdout.toString().match(/ffmpeg version (\S+)/);
      resolve(m ? m[1] : null);
    });
  });
}

async function ensureBinaries(onProgress) {
  applyPendingSwap(ytDlpPath());
  applyPendingSwap(ffmpegPath());

  const meta = readMeta();
  const needsYtDlp = !fs.existsSync(ytDlpPath());
  const needsFfmpeg = !fs.existsSync(ffmpegPath());

  if (needsYtDlp) {
    onProgress?.({ name: 'yt-dlp', phase: 'start' });
    await downloadYtDlp(onProgress);
    meta.ytDlp = { version: await getYtDlpVersion(), lastCheck: Date.now() };
    writeMeta(meta);
    onProgress?.({ name: 'yt-dlp', phase: 'done' });
  }
  if (needsFfmpeg) {
    onProgress?.({ name: 'ffmpeg', phase: 'start' });
    await downloadFfmpeg(onProgress);
    meta.ffmpeg = { version: await getFfmpegVersion(), lastCheck: Date.now() };
    writeMeta(meta);
    onProgress?.({ name: 'ffmpeg', phase: 'done' });
  }
}

async function checkForUpdates(onProgress, { force = false } = {}) {
  const meta = readMeta();
  const now = Date.now();

  const ytStale = force || !meta.ytDlp?.lastCheck || (now - meta.ytDlp.lastCheck) > ONE_DAY;
  if (ytStale) {
    try {
      const latest = await fetchLatestTag('yt-dlp/yt-dlp');
      if (latest && latest !== meta.ytDlp?.version) {
        onProgress?.({ name: 'yt-dlp', phase: 'updating', from: meta.ytDlp?.version, to: latest });
        await downloadYtDlp(onProgress);
        meta.ytDlp = { version: latest, lastCheck: now };
      } else {
        meta.ytDlp = { ...(meta.ytDlp || {}), lastCheck: now };
      }
      writeMeta(meta);
    } catch (e) {
      console.error('[bin-manager] yt-dlp update check failed:', e.message);
    }
  }

  const ffStale = force || !meta.ffmpeg?.lastCheck || (now - meta.ffmpeg.lastCheck) > THIRTY_DAYS;
  if (ffStale && PLATFORM === 'win32') {
    try {
      const latest = await fetchLatestTag('BtbN/FFmpeg-Builds');
      if (latest && latest !== meta.ffmpeg?.version) {
        onProgress?.({ name: 'ffmpeg', phase: 'updating', from: meta.ffmpeg?.version, to: latest });
        await downloadFfmpeg(onProgress);
        meta.ffmpeg = { version: latest, lastCheck: now };
      } else {
        meta.ffmpeg = { ...(meta.ffmpeg || {}), lastCheck: now };
      }
      writeMeta(meta);
    } catch (e) {
      console.error('[bin-manager] ffmpeg update check failed:', e.message);
    }
  }
}

module.exports = {
  ytDlpPath,
  ffmpegPath,
  binDir,
  binariesPresent,
  ensureBinaries,
  checkForUpdates,
  getYtDlpVersion,
  getFfmpegVersion,
  readMeta,
};

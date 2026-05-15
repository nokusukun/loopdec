// Idle "boot screen" — shown when the deck has zero pads.
// Displays system status, recent decks, and getting-started keys.

import { onEmptyStateEnter, tiles } from '../state';
import { loadDeckByPath } from '../persistence/decks';

const els = {
  recent: document.getElementById('idle-recent')!,
  ytdlp:  document.getElementById('idle-ytdlp')!,
  ffmpeg: document.getElementById('idle-ffmpeg')!,
  cache:  document.getElementById('idle-cache')!,
};

function setStatus(id: 'ytdlp' | 'ffmpeg' | 'cache', value: string, state: 'ok' | 'error' | 'loading'): void {
  els[id].textContent = value;
  const li = els[id].closest('li');
  if (li) li.dataset.state = state;
}

function fmtRelative(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const day = 86400_000;
  if (diff < day)         return 'today';
  if (diff < 2 * day)     return '1d ago';
  if (diff < 7 * day)     return `${Math.floor(diff / day)}d ago`;
  if (diff < 30 * day)    return `${Math.floor(diff / (7 * day))}w ago`;
  return `${Math.floor(diff / (30 * day))}mo ago`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

async function refreshVersions(): Promise<void> {
  try {
    const { version } = await window.api.getYtDlpVersion();
    setStatus('ytdlp', version ?? 'missing', version ? 'ok' : 'error');
  } catch {
    setStatus('ytdlp', 'unavailable', 'error');
  }
  try {
    const { version } = await window.api.getFfmpegVersion();
    setStatus('ffmpeg', version ?? 'missing', version ? 'ok' : 'error');
  } catch {
    setStatus('ffmpeg', 'unavailable', 'error');
  }
}

async function refreshCache(): Promise<void> {
  try {
    const info = await window.api.getCacheInfo();
    setStatus('cache', `${info.usedGB} / ${info.maxGB} GB · ${info.files} files`, 'ok');
  } catch {
    setStatus('cache', 'unavailable', 'error');
  }
}

async function refreshRecent(): Promise<void> {
  try {
    const recent = await window.api.getRecentDecks();
    els.recent.innerHTML = '';
    if (recent.length === 0) {
      const li = document.createElement('li');
      li.className = 'idle-recent-empty';
      li.innerHTML = 'No decks saved yet. Build a session, then save it with <kbd>⌘P</kbd> &rsaquo; Save Deck.';
      els.recent.appendChild(li);
      return;
    }
    recent.slice(0, 6).forEach((deck, i) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="idle-recent-address">${String.fromCharCode(65 + i)}</span>
        <span class="idle-recent-name">${escapeHtml(deck.name)}</span>
        <span class="idle-recent-meta">${fmtRelative(deck.time)}</span>
      `;
      li.addEventListener('click', () => loadDeckByPath(deck.path));
      els.recent.appendChild(li);
    });
  } catch {
    // leave the placeholder
  }
}

async function refresh(): Promise<void> {
  await Promise.all([refreshVersions(), refreshCache(), refreshRecent()]);
}

export function bindIdle(): void {
  // Initial load: fetch immediately so the screen is populated on first paint.
  refresh();

  // Re-fetch whenever the deck transitions back to empty (e.g., after newDeck).
  onEmptyStateEnter(() => { if (tiles.size === 0) refresh(); });

  // Cache/binaries can change while the idle screen is up — refresh on binary events too.
  window.api.onBinarySetup((data: { phase?: string; background?: boolean }) => {
    if (data.phase === 'ready' || data.phase === 'done') {
      // Don't fight the setup overlay handler; only refresh when idle is showing.
      if (tiles.size === 0) refreshVersions();
    }
  });
}

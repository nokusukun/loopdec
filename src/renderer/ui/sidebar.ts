import { sidebarEl, sidebarOverlayEl, menuBtn } from './dom';

let sidebarOpen = false;

export function isSidebarOpen(): boolean { return sidebarOpen; }

import { loadDeckByPath, newDeck, saveDeck, saveDeckAs, loadDeck } from '../persistence/decks';
import { enumerateOutputs, getOutputDeviceId, setOutputDevice } from '../audio/output';

// Heuristic: known virtual audio cable / loopback driver names. The list is
// intentionally narrow to keep false positives away from real devices like
// "VAIO" or "Cable Bay Audio" that happen to contain a substring.
const VIRTUAL_PATTERNS = [
  /vb[- ]?audio/i,
  /vb[- ]?cable/i,
  /voicemeeter/i,
  /\bcable (input|output)\b/i,
  /virtual audio cable/i,
  /blackhole/i,
  /\bloopback\b/i,
  /soundflower/i,
  /synchronous audio router/i,
];
function isVirtualOutput(label: string): boolean {
  if (!label) return false;
  return VIRTUAL_PATTERNS.some(p => p.test(label));
}

function mkOption(d: MediaDeviceInfo): HTMLOptionElement {
  const opt = document.createElement('option');
  opt.value = d.deviceId;
  opt.textContent = d.label || `Output ${d.deviceId.slice(0, 6)}`;
  return opt;
}

async function populateOutputDevices(): Promise<void> {
  const sel = document.getElementById('set-audio-output') as HTMLSelectElement | null;
  if (!sel) return;
  const devices = await enumerateOutputs();

  // Keep only the "System default" option, refill the rest.
  while (sel.options.length > 1) sel.remove(1);

  const real: MediaDeviceInfo[] = [];
  const virtual: MediaDeviceInfo[] = [];
  for (const d of devices) {
    if (d.deviceId === 'default' || d.deviceId === '') continue;
    (isVirtualOutput(d.label || '') ? virtual : real).push(d);
  }

  if (real.length > 0) {
    const group = document.createElement('optgroup');
    group.label = 'Devices';
    for (const d of real) group.appendChild(mkOption(d));
    sel.appendChild(group);
  }
  if (virtual.length > 0) {
    const group = document.createElement('optgroup');
    group.label = 'Virtual';
    for (const d of virtual) group.appendChild(mkOption(d));
    sel.appendChild(group);
  }

  const current = getOutputDeviceId();
  sel.value = [...sel.options].some(o => o.value === current) ? current : '';

  // Hint shows only when no virtual outputs are detected — quiet otherwise.
  const hint = document.getElementById('virtual-cable-hint');
  if (hint) hint.dataset.visible = virtual.length === 0 ? 'true' : 'false';
}

export async function openSidebar(): Promise<void> {
  sidebarOpen = true;
  sidebarEl.classList.add('open');
  sidebarOverlayEl.classList.add('open');

  const cacheInfo = await window.api.getCacheInfo();
  (document.getElementById('set-cache') as HTMLInputElement).value = cacheInfo.maxGB;
  document.getElementById('set-cache-used')!.textContent = `${cacheInfo.usedGB} GB / ${cacheInfo.files} files`;

  populateOutputDevices().catch(() => {});

  const recent = await window.api.getRecentDecks();
  const recentSection = document.getElementById('sb-recent-section') as HTMLElement;
  const recentList = document.getElementById('sb-recent-list')!;
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

export function closeSidebar(): void {
  sidebarOpen = false;
  sidebarEl.classList.remove('open');
  sidebarOverlayEl.classList.remove('open');
}

export function bindSidebar(): void {
  // Close handlers go first and are isolated so a later listener-attach failure
  // can never leave the sidebar un-closable.
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (sidebarOpen) closeSidebar();
    else openSidebar().catch((err) => console.error('Sidebar error:', err));
  });
  sidebarOverlayEl.addEventListener('click', (e) => { e.stopPropagation(); closeSidebar(); });

  // Optional bindings — each wrapped so a missing element doesn't break the
  // earlier ones. Order matters: this is the first place I touch the audio-out
  // element which was added recently and must not regress sidebar dismissal.
  const safe = (fn: () => void) => { try { fn(); } catch (e) { console.warn('sidebar bind:', e); } };

  safe(() => document.getElementById('sb-new-deck')!.addEventListener('click', () => { closeSidebar(); newDeck(); }));
  safe(() => document.getElementById('sb-save-deck')!.addEventListener('click', () => { closeSidebar(); saveDeck(); }));
  safe(() => document.getElementById('sb-save-deck-as')!.addEventListener('click', () => { closeSidebar(); saveDeckAs(); }));
  safe(() => document.getElementById('sb-load-deck')!.addEventListener('click', () => { closeSidebar(); loadDeck(); }));

  safe(() => document.getElementById('set-audio-output')!.addEventListener('change', (e) => {
    setOutputDevice((e.target as HTMLSelectElement).value).catch(() => {});
  }));

  safe(() => navigator.mediaDevices?.addEventListener('devicechange', () => {
    if (sidebarOpen) populateOutputDevices().catch(() => {});
  }));
}

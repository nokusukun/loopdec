import { sidebarEl, sidebarOverlayEl, menuBtn, sidebarCloseBtn } from './dom';

let sidebarOpen = false;

export function isSidebarOpen(): boolean { return sidebarOpen; }

import { loadDeckByPath, newDeck, saveDeck, saveDeckAs, loadDeck } from './decks';

export async function openSidebar(): Promise<void> {
  sidebarOpen = true;
  sidebarEl.classList.add('open');
  sidebarOverlayEl.classList.add('open');

  const cacheInfo = await window.api.getCacheInfo();
  (document.getElementById('set-cache') as HTMLInputElement).value = cacheInfo.maxGB;
  document.getElementById('set-cache-used')!.textContent = `${cacheInfo.usedGB} GB / ${cacheInfo.files} files`;

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
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (sidebarOpen) closeSidebar();
    else openSidebar().catch((err) => console.error('Sidebar error:', err));
  });
  sidebarCloseBtn.addEventListener('click', closeSidebar);
  sidebarOverlayEl.addEventListener('click', closeSidebar);

  document.getElementById('sb-new-deck')!.addEventListener('click', () => { closeSidebar(); newDeck(); });
  document.getElementById('sb-save-deck')!.addEventListener('click', () => { closeSidebar(); saveDeck(); });
  document.getElementById('sb-save-deck-as')!.addEventListener('click', () => { closeSidebar(); saveDeckAs(); });
  document.getElementById('sb-load-deck')!.addEventListener('click', () => { closeSidebar(); loadDeck(); });
}

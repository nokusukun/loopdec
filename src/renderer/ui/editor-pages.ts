// Two-page editor switcher: SMP (sample / loop region) and FX (rack of
// plugin modules). Tabs live in the panel's top bar; switch with click or
// number keys (1 / 2). State-by-glow — active tab is amber.
//
// Why only two pages? Per-plugin pages were unbounded in count and felt
// fiddly; samplers group effects on a single FX page where you see all
// your modules at once. Adding a new plugin means adding another module
// card to the FX grid in waveform-editor.html, not another tab.

interface PageDef { id: string; label: string; }

const PAGES: PageDef[] = [
  { id: 'sample', label: 'SMP' },
  { id: 'fx',     label: 'FX'  },
];

let activePageId = 'sample';
let tabsEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
const subscribers: Array<(pageId: string) => void> = [];

export function bindEditorPages(): void {
  tabsEl = document.getElementById('page-tabs');
  bodyEl = document.getElementById('page-body');
  if (!tabsEl || !bodyEl) return;

  tabsEl.replaceChildren();
  PAGES.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'page-tab';
    btn.dataset.pageId = p.id;
    btn.dataset.active = String(p.id === activePageId);
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-controls', `page-${p.id}`);
    btn.setAttribute('title', `${p.label} (${i + 1})`);

    const led = document.createElement('span');
    led.className = 'page-tab-led';
    led.setAttribute('aria-hidden', 'true');

    const num = document.createElement('span');
    num.className = 'page-tab-num';
    num.textContent = String(i + 1).padStart(2, '0');

    const label = document.createElement('span');
    label.className = 'page-tab-label';
    label.textContent = p.label;

    btn.append(led, num, label);
    btn.addEventListener('click', () => setActivePage(p.id));
    tabsEl!.appendChild(btn);
  });

  document.addEventListener('keydown', (e) => {
    if (!document.body.classList.contains('waveform-open')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const active = document.activeElement;
    if (active) {
      const tag = active.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || active.getAttribute('contenteditable') === 'true') return;
    }
    const n = parseInt(e.key, 10);
    if (!Number.isFinite(n) || n < 1 || n > PAGES.length) return;
    e.preventDefault();
    setActivePage(PAGES[n - 1].id);
  });
}

export function setActivePage(pageId: string): void {
  if (!bodyEl || !tabsEl) return;
  if (pageId === activePageId) return;
  activePageId = pageId;

  for (const sec of bodyEl.querySelectorAll<HTMLElement>('.editor-page')) {
    sec.dataset.active = String(sec.dataset.pageId === pageId);
  }
  for (const tab of tabsEl.querySelectorAll<HTMLElement>('.page-tab')) {
    tab.dataset.active = String(tab.dataset.pageId === pageId);
  }
  for (const fn of subscribers) fn(pageId);
}

export function getActivePage(): string { return activePageId; }

export function resetActivePage(): void {
  activePageId = '__none__';
  setActivePage('sample');
}

export function onActivePageChange(fn: (pageId: string) => void): void {
  subscribers.push(fn);
}

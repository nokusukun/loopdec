import type { CommandItem } from '../types';
import { cmdOverlay, cmdInput, cmdResults, urlInput } from './dom';
import { tiles, getSource } from '../state';
import { editor } from '../editor-state';
import { playAll, stopAll, syncAll } from '../audio/transport';

let cmdOpen = false;
let cmdActiveIdx = 0;
let cachedRecentDecks: { path: string; name: string; time: number }[] = [];

export function isPaletteOpen(): boolean { return cmdOpen; }

export function openPalette(): void {
  cmdOpen = true;
  cmdInput.value = '';
  cmdActiveIdx = 0;
  cmdOverlay.classList.add('open');

  window.api.getRecentDecks().then((recent) => {
    cachedRecentDecks = recent;
    renderCmdResults('');
  });
  cmdInput.focus();
}

export function closePalette(): void {
  cmdOpen = false;
  cmdOverlay.classList.remove('open');
}

export function palettePrompt(placeholder: string, defaultVal: string | number): Promise<string | null> {
  return new Promise((resolve) => {
    cmdOpen = true;
    cmdInput.value = String(defaultVal ?? '');
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(cmdInput.value || null); }
      else if (e.key === 'Escape') { e.stopPropagation(); cleanup(); resolve(null); }
    };
    const onClickOut = (e: MouseEvent) => { if (e.target === cmdOverlay) { cleanup(); resolve(null); } };

    cmdInput.addEventListener('keydown', onKey);
    cmdOverlay.addEventListener('click', onClickOut);
  });
}

function buildCommandList(query: string): CommandItem[] {
  const q = query.toLowerCase();

  // Resolved at call time so we don't pull `decks` into a circular import.
  const lazy = () => import('../persistence/decks');

  const baseCommands: CommandItem[] = [
    { id: 'new-deck',     label: 'New Deck',          action: async () => { closePalette(); (await lazy()).newDeck(); } },
    { id: 'save-deck',    label: 'Save Deck',         action: async () => { closePalette(); (await lazy()).saveDeck(); } },
    { id: 'save-deck-as', label: 'Save Deck As…',     action: async () => { closePalette(); (await lazy()).saveDeckAs(); } },
    { id: 'load-deck',    label: 'Load Deck',         action: async () => { closePalette(); (await lazy()).loadDeck(); } },
    { id: 'sep-1', separator: true },
    { id: 'add-url',   label: 'Add YouTube URL', action: () => { closePalette(); urlInput.focus(); } },
    { id: 'load-file', label: 'Load File…',  action: async () => {
      closePalette();
      const m = await import('./local-files');
      await m.pickAndLoad();
    }},
    { id: 'play-all',  label: 'Play All',  hint: 'Space', action: () => { closePalette(); playAll(); } },
    { id: 'stop-all',  label: 'Stop All',  hint: 'Space', action: () => { closePalette(); stopAll(); } },
    { id: 'sync-all',  label: 'Sync All',  action: () => { closePalette(); syncAll(); } },
    { id: 'fit-waveform', label: 'Fit Waveform', action: () => {
      closePalette();
      const tile = editor.tileId ? tiles.get(editor.tileId) : null;
      if (tile) {
        const src = getSource(tile);
        if (src) { editor.viewStart = 0; editor.viewEnd = src.duration; }
      }
    }},
    { id: 'sep-cache', separator: true },
    { id: 'cache-info', label: 'Cache Info', action: async () => {
      const info = await window.api.getCacheInfo();
      await palettePrompt(`Cache: ${info.usedGB} GB / ${info.maxGB} GB (${info.files} files) — press Enter`, '');
      closePalette();
    }},
    { id: 'set-cache-size', label: 'Set Cache Size', action: async () => {
      closePalette();
      const info = await window.api.getCacheInfo();
      const input = await palettePrompt(`Max cache GB (current: ${info.maxGB})`, info.maxGB);
      if (input !== null) {
        const gb = parseFloat(input);
        if (gb > 0 && isFinite(gb)) await window.api.setMaxCache(gb);
      }
    }},
    { id: 'clear-cache', label: 'Clear Unused Cache', action: async () => {
      closePalette();
      await window.api.clearCache();
    }},
  ];

  let all = [...baseCommands];

  if (cachedRecentDecks.length > 0) {
    all.push({ id: 'sep-recent', separator: true });
    for (const deck of cachedRecentDecks) {
      all.push({
        id: `recent-${deck.path}`,
        label: deck.name,
        sublabel: 'recent deck',
        action: async () => { closePalette(); (await lazy()).loadDeckByPath(deck.path); },
      });
    }
  }

  if (q) {
    all = all.filter(c => c.separator
      ? false
      : c.label!.toLowerCase().includes(q) || c.sublabel?.toLowerCase().includes(q));
  }

  return all;
}

function renderCmdResults(query: string): void {
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

    let labelHtml = cmd.label ?? '';
    if (cmd.sublabel) labelHtml += `<span class="cmd-sublabel">${cmd.sublabel}</span>`;
    div.innerHTML = `<span class="cmd-item-label">${labelHtml}</span>${cmd.hint ? `<span class="cmd-item-hint">${cmd.hint}</span>` : ''}`;

    div.addEventListener('click', () => cmd.action?.());
    div.addEventListener('mouseenter', () => {
      cmdResults.querySelectorAll('.cmd-item').forEach(el => el.classList.remove('active'));
      div.classList.add('active');
    });

    cmdResults.appendChild(div);
    actionIdx++;
  }
}

export function bindPalette(): void {
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
      actionable[cmdActiveIdx]?.action?.();
    } else if (e.key === 'Escape') {
      closePalette();
    }
    e.stopPropagation();
  });

  cmdOverlay.addEventListener('click', (e) => {
    if (e.target === cmdOverlay) closePalette();
  });
}

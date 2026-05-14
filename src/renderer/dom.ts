// Cached DOM element references. Imported by any module that needs to touch the DOM.

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

export const urlForm        = $<HTMLFormElement>('url-form');
export const urlInput       = $<HTMLInputElement>('url-input');
export const tilesGrid      = $<HTMLDivElement>('tiles-grid');
export const emptyState     = $('empty-state');
export const clipsContainer = $('clips-container');
export const idleScreen     = $('idle-screen');
export const deckNameEl     = $('deck-name');
export const playAllBtn     = $<HTMLButtonElement>('play-all-btn');
export const stopAllBtn     = $<HTMLButtonElement>('stop-all-btn');
export const syncBtn        = $<HTMLButtonElement>('sync-btn');

export const waveformPanel       = $('waveform-panel');
export const waveformCanvas      = $<HTMLCanvasElement>('waveform-canvas');
export const waveformCtx         = waveformCanvas.getContext('2d')!;
export const waveformTitleEl     = $('waveform-title');
export const waveformAddressEl   = $('waveform-address');
export const waveformTimeStart   = $('waveform-time-start');
export const waveformTimeEnd     = $('waveform-time-end');
export const waveformCloseBtn    = $<HTMLButtonElement>('waveform-close');
export const waveformFitBtn      = $<HTMLButtonElement>('waveform-fit');
export const waveformMinimap     = $('waveform-minimap');

export const setupOverlay   = $('setup-overlay');
export const setupError     = $('setup-error');

export const sidebarEl        = $('sidebar');
export const sidebarOverlayEl = $('sidebar-overlay');
export const menuBtn          = $<HTMLButtonElement>('menu-btn');
export const sidebarCloseBtn  = $<HTMLButtonElement>('sidebar-close');

export const cmdOverlay  = $('cmd-overlay');
export const cmdInput    = $<HTMLInputElement>('cmd-input');
export const cmdResults  = $('cmd-results');

export const gridColsInput   = $<HTMLInputElement>('set-grid-cols');
export const gridRowsInput   = $<HTMLInputElement>('set-grid-rows');
export const snapCustomInput = $<HTMLInputElement>('snap-custom');
export const snapOffsetInput = $<HTMLInputElement>('snap-offset');
export const snapOffsetTapBtn = $<HTMLButtonElement>('snap-offset-tap');
export const waveformSnapEl  = $('waveform-snap');

export const winCloseBtn    = $<HTMLButtonElement>('win-close');
export const winMinimizeBtn = $<HTMLButtonElement>('win-minimize');
export const winMaximizeBtn = $<HTMLButtonElement>('win-maximize');

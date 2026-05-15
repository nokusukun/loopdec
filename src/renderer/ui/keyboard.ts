import { editor } from '../editor-state';
import { closeWaveformEditor } from './waveform';
import { isAnyPlaying } from '../audio/playback';
import { playAll, stopAll } from '../audio/transport';
import { isSidebarOpen, closeSidebar } from './sidebar';
import { isPaletteOpen, openPalette, closePalette } from './palette';

export function bindKeyboard(): void {
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
      e.preventDefault();
      if (isPaletteOpen()) closePalette();
      else openPalette();
      return;
    }

    if (isPaletteOpen()) return;

    if (e.code === 'Escape' && isSidebarOpen()) {
      closeSidebar();
      return;
    }
    if (e.code === 'Escape' && editor.tileId) {
      closeWaveformEditor();
      return;
    }
    if (e.code === 'Space' && !(document.activeElement as HTMLElement | null)?.matches('input')) {
      e.preventDefault();
      if (isAnyPlaying()) stopAll();
      else playAll();
    }
  });
}

// Master transport: play-all / stop-all / sync-all bound to the toolbar buttons.

import { tiles, getSource } from './state';
import { stopAudioSource, playAudio } from './audio-engine';
import {
  playTile, pauseTile, startPlayheadAnimation, stopPlayheadAnimation,
  updateMasterPlayState, isAnyPlaying,
} from './playback';
import { playAllBtn, stopAllBtn, syncBtn } from './dom';

export function playAll(): void {
  for (const tile of tiles.values()) {
    if (tile.enabled && tile.video && tile.state !== 'downloading' && tile.state !== 'error') {
      playTile(tile);
    }
  }
  updateMasterPlayState();
}

export function stopAll(): void {
  for (const tile of tiles.values()) {
    if (tile.video) pauseTile(tile);
  }
  updateMasterPlayState();
}

export function syncAll(): void {
  for (const tile of tiles.values()) {
    if (tile.state === 'playing') {
      stopAudioSource(tile);
      if (tile.video) tile.video.pause();
      stopPlayheadAnimation(tile);
    }
    tile._pausedAt = undefined;
  }

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

export function bindTransport(): void {
  playAllBtn.addEventListener('click', () => {
    if (isAnyPlaying()) stopAll();
    else playAll();
  });
  stopAllBtn.addEventListener('click', stopAll);
  syncBtn.addEventListener('click', syncAll);
}

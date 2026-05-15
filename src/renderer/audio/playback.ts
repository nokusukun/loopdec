// Tile play/pause + playhead animation. Imported by master transport and by tile UI handlers.

import type { Tile } from '../types';
import { tiles, getSource } from '../state';
import { playAudio, stopAudioSource, getAudioPosition, syncVideoToAudio } from './engine';
import { playAllBtn } from '../ui/dom';
import { formatTime } from '../utils';
import { getSpeed } from '../plugins/speed';

export function startPlayheadAnimation(tile: Tile): void {
  if (tile.animFrameId) return;
  const source = getSource(tile);
  if (!source) return;

  function tick() {
    let pos: number;
    if (source!.audioReady) {
      if (!tile.audioSource) { tile.animFrameId = null; return; }
      pos = getAudioPosition(tile);
      syncVideoToAudio(tile, pos);
    } else {
      if (!tile.video || tile.video.paused) { tile.animFrameId = null; return; }
      pos = tile.video.currentTime;
    }
    const pct = (pos / source!.duration) * 100;
    tile.els.loopPlayhead.style.left = `${pct}%`;
    tile.els.timeCurrent.textContent = formatTime(pos);
    tile.animFrameId = requestAnimationFrame(tick);
  }

  tile.animFrameId = requestAnimationFrame(tick);
}

export function stopPlayheadAnimation(tile: Tile): void {
  if (tile.animFrameId) {
    cancelAnimationFrame(tile.animFrameId);
    tile.animFrameId = null;
  }
}

export function isAnyPlaying(): boolean {
  return [...tiles.values()].some(t => t.state === 'playing');
}

export function updateMasterPlayState(): void {
  playAllBtn.classList.toggle('active', isAnyPlaying());
}

export async function playTile(tile: Tile): Promise<void> {
  if (!tile.video || !tile.enabled) return;
  const source = getSource(tile);
  if (!source) return;

  let startPos = tile.loopStart;
  if (tile._pausedAt !== undefined && tile._pausedAt >= tile.loopStart && tile._pausedAt < tile.loopEnd) {
    startPos = tile._pausedAt;
    tile._pausedAt = undefined;
  } else if (tile.video.currentTime >= tile.loopStart && tile.video.currentTime < tile.loopEnd) {
    startPos = tile.video.currentTime;
  }

  const seekVideo = () => new Promise<void>((resolve) => {
    if (!tile.video || Math.abs(tile.video.currentTime - startPos) < 0.5) { resolve(); return; }
    tile.video.addEventListener('seeked', () => resolve(), { once: true });
    tile.video.currentTime = startPos;
    setTimeout(resolve, 500);
  });

  if (source.audioReady) {
    await playAudio(tile, startPos);
    tile.video.muted = true;
    await seekVideo();
    // Reassert rate immediately before play(): seek/await window can let
    // intermediate playbackRate writes get clobbered by element resets.
    tile.video.playbackRate = getSpeed(tile);
    tile.video.play().catch(() => {});
  } else {
    tile.video.playbackRate = getSpeed(tile);
    await seekVideo();
    tile.video.playbackRate = getSpeed(tile);
    tile.video.play().catch(() => {});
  }

  tile.state = 'playing';
  tile.els.tile.dataset.state = 'playing';
  tile.els.playBtn.textContent = 'STP';
  startPlayheadAnimation(tile);
  updateMasterPlayState();
}

export function pauseTile(tile: Tile): void {
  if (!tile.video) return;
  const source = getSource(tile);

  if (source?.audioReady) {
    tile._pausedAt = getAudioPosition(tile);
    stopAudioSource(tile);
  }

  tile.video.pause();
  tile.state = 'paused';
  tile.els.tile.dataset.state = 'paused';
  tile.els.playBtn.textContent = 'PLY';
  stopPlayheadAnimation(tile);
  updateMasterPlayState();
}

export function togglePlayTile(tile: Tile): void {
  if (!tile.video || !tile.enabled) return;
  if (tile.state === 'playing') pauseTile(tile);
  else playTile(tile);
}

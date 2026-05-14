import type { Manifest } from '../shared/types';
import { tiles, sources } from './state';
import { gridShape } from './grid';

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

export function saveManifest(): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const data: Manifest = {
      sources: {},
      tiles: [],
      grid: { cols: gridShape.cols, rows: gridShape.rows },
    };
    for (const [id, src] of sources) {
      data.sources[id] = {
        id, url: src.url, title: src.title, duration: src.duration,
        chunked: src.chunked || false,
        chunkCount: src.chunkCount || 0,
        chunkDuration: src.chunkDuration || 0,
      };
    }
    for (const tile of tiles.values()) {
      data.tiles.push({
        id: tile.id,
        sourceId: tile.sourceId,
        loopStart: tile.loopStart,
        loopEnd: tile.loopEnd,
        enabled: tile.enabled,
        volume: tile.volume,
        row: tile.row,
        col: tile.col,
        eq: [...tile.eq],
        speed: tile.speed,
        pitchLock: tile.pitchLock,
      });
    }
    window.api.saveManifest(data);
  }, 500);
}

// Plugin registry + lifecycle dispatchers. Plugins register themselves at
// module load via registerPlugin(); the renderer's bootstrap calls bindPlugins()
// once after DOM is ready, then the audio/persistence layers dispatch through
// the helpers below.

import type { Tile } from '../types';
import type { TilePersisted } from '../../shared/types';
import type { TilePlugin, PlayContext } from './types';

const registered: TilePlugin[] = [];

export function registerPlugin(p: TilePlugin): void {
  if (registered.some(x => x.id === p.id)) {
    console.warn(`plugin "${p.id}" already registered`);
    return;
  }
  registered.push(p);
}

export function plugins(): readonly TilePlugin[] {
  return registered;
}

export function bindPlugins(): void {
  for (const p of registered) p.bind();
}

// Tile is being created (new clip, duplicate, restore). Fill in every plugin's
// state slot — either from a persisted blob or from the plugin's defaults.
export function initTilePlugins(
  tile: Tile,
  persisted?: Record<string, unknown>,
): void {
  for (const p of registered) {
    const raw = persisted?.[p.id];
    const hydrated = raw !== undefined && p.hydrate ? p.hydrate(raw) : undefined;
    tile.plugins[p.id] = hydrated ?? p.defaultState();
  }
}

export function serializeTilePlugins(tile: Tile): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of registered) {
    const state = tile.plugins[p.id];
    if (state == null) continue;
    const s = p.serialize ? p.serialize(state) : state;
    if (s !== undefined) out[p.id] = s;
  }
  return out;
}

export function loadTileIntoEditor(tile: Tile): void {
  for (const p of registered) p.loadForTile?.(tile);
}

export function runOnPlay(tile: Tile, ctx: PlayContext): void {
  for (const p of registered) p.onPlay?.(tile, ctx);
}

export function teardownTilePlugins(tile: Tile): void {
  for (const p of registered) p.teardownTile?.(tile);
}

// Convert a persisted tile to the `Record<plugin-id, raw>` shape that
// initTilePlugins expects. Prefers the new `plugins` blob; falls back to
// the pre-plugin top-level fields (eq, speed, pitchLock) for back-compat
// with old manifests/decks.
export function persistedToPluginState(td: TilePersisted): Record<string, unknown> {
  if (td.plugins) return td.plugins;
  const out: Record<string, unknown> = {};
  if (td.eq !== undefined) out.eq = td.eq;
  if (td.speed !== undefined || td.pitchLock !== undefined) {
    out.speed = { speed: td.speed ?? 1, pitchLock: td.pitchLock ?? false };
  }
  return out;
}

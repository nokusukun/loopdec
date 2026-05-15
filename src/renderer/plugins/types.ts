// Per-tile audio/UI plugins. Each plugin owns its state, persistence, UI,
// and audio integration for one effect or property (EQ, Speed, etc).
//
// Lifecycle:
//   1. bind()           — once at app start. Wire DOM, listeners, etc.
//   2. defaultState()   — when a tile is created or restored without persisted state
//   3. hydrate()        — when a tile is restored with persisted state
//   4. loadForTile()    — when waveform editor opens for a tile (sync UI)
//   5. onPlay()         — every time playAudio fires; mutate PlayContext as needed
//   6. teardownTile()   — when tile is removed/deck swapped; clean up nodes
//   7. serialize()      — when saving manifest/deck

import type { Tile } from '../types';

export interface PlayContext {
  audioCtx: AudioContext;
  // Source node created by the engine. Plugins can configure it (e.g., playbackRate).
  source: AudioBufferSourceNode;
  // Mutable starting state. Plugins can replace buffer / change loop region
  // (e.g., pitch-lock pre-stretches the loop into a new buffer).
  buffer: AudioBuffer;
  loopStart: number;
  loopEnd: number;
  startOffset: number;
  // Effect chain stages between source and gain. Plugins push stages here in
  // onPlay; the engine wires them: source → chain[0].input … chain[N].output → gain.
  chain: ChainStage[];
}

export interface ChainStage {
  input: AudioNode;
  output: AudioNode;
}

export interface TilePlugin {
  readonly id: string;

  // App startup hook. Render UI shells, attach listeners.
  bind(): void;

  // Returns the plugin's per-tile state shape with defaults filled in.
  defaultState(): unknown;

  // Optional: produce a serializable representation (or undefined to skip).
  serialize?(state: unknown): unknown | undefined;

  // Optional: parse a persisted blob back into runtime state. Falls back to
  // defaultState() if not provided or returns undefined.
  hydrate?(raw: unknown): unknown | undefined;

  // Called when the waveform editor focuses a tile — sync UI to tile state.
  loadForTile?(tile: Tile): void;

  // Called from playAudio. Mutate PlayContext to participate in playback.
  onPlay?(tile: Tile, ctx: PlayContext): void;

  // Called when a tile is removed or the deck is swapped. Disconnect any
  // AudioNodes the plugin keeps on the tile, clear timers, etc.
  teardownTile?(tile: Tile): void;
}

# AGENTS.md

LoopDec — Electron desktop app, TypeScript via esbuild, single `build.mjs`.

## Stack

- Electron 42 + TypeScript, ES2022, CJS output. esbuild is the only bundler.
- Three processes: `src/main/`, `src/preload/`, `src/renderer/`. Typed IPC contract: `src/shared/ipc.ts`.
- Audio: Web Audio API (AudioBufferSourceNode for loops, BiquadFilter for EQ, GainNode for vol). Time-stretch is OLA + WSOLA in `renderer/plugins/speed/time-stretch.ts`.

## Commands

- `node build.mjs` — full build to `dist/`. `--watch` to watch.
- `npx tsc --noEmit` — type check. No separate emit step; esbuild handles transpile.
- `npm start` — launch Electron against `dist/`.
- No tests. Verify with build + tsc + manual smoke in the running app.

## Renderer layout — keep the domain split

```
src/renderer/
  index.ts, state.ts, editor-state.ts, types.ts, utils.ts   ← top-level cross-cutting
  audio/        Web Audio + playback orchestration
  ui/           every DOM widget/panel
  persistence/  disk I/O via IPC (decks, manifest, restore)
  plugins/      per-tile TilePlugins
  styles/       global CSS, barrel-imported from index.ts
```

Don't add new files at `renderer/` top level — pick the right domain folder. Top-level is reserved for genuinely cross-cutting state/types.

## HTML and CSS

- `src/index.html` is a thin shell of `<!-- @include path -->` directives. Partials live in `src/partials/` and `src/renderer/plugins/*/`.
- `build.mjs` expands includes, resolving all paths from `src/` (not from the including file). Nested includes work.
- CSS is bundled via TS imports. Add a stylesheet to `src/renderer/styles/`, import it in `styles/index.ts`. Plugin CSS lives next to plugin TS and is imported from the plugin's `index.ts`. Everything ends up in `dist/renderer.css`.
- Do not put inline `<style>` blocks back into `index.html`.

## Plugin system — per-tile effects

Per-tile audio/UI effects (Speed, EQ, future filter/delay/etc.) are `TilePlugin`s, not ad-hoc code threaded through `audio/engine.ts` and `ui/tile.ts`.

Contract (`renderer/plugins/types.ts`): `id`, `bind()`, `defaultState()`, `serialize()/hydrate()`, `loadForTile()`, `onPlay(tile, ctx)`, `teardownTile()`.

In `onPlay` a plugin can mutate `ctx.buffer/loopStart/loopEnd/startOffset`, configure `ctx.source`, or push `{input, output}` stages onto `ctx.chain`. The engine wires `source → chain[0].input … chain[N].output → gain`.

Adding one:
1. `src/renderer/plugins/<id>/{index.ts, <id>.html, <id>.css}`.
2. `index.ts`: `import './<id>.css'`, define the plugin, `registerPlugin(plugin)`, `export {};`.
3. Import the module in `src/renderer/index.ts` so it self-registers.
4. Add `<!-- @include renderer/plugins/<id>/<id>.html -->` wherever it mounts (usually `#tile-params` inside `partials/waveform-editor.html`).

Plugin state lives in `tile.plugins[id]`. Persistence: `serializeTilePlugins(tile)` → `td.plugins`. Loading: `initTilePlugins(tile, persistedToPluginState(td))` — `persistedToPluginState` handles both new and legacy (top-level `eq`/`speed`/`pitchLock`) formats.

If audio-engine/transport/playback need to read a plugin's state, export accessor(s) from the plugin (see `getSpeed`/`getPitchLock` in `plugins/speed/index.ts`).

## Audio timing invariants

- `tile.audioStartedOffset` is in **source time**, not buffer time. `getAudioPosition` computes `offset + elapsed × getSpeed(tile)`, which works identically for pitched and pitch-locked playback.
- `getSpeed(tile)` from `plugins/speed` is the source of truth for speed. Never read `tile.speed` — the field doesn't exist anymore.

## Conventions

- Edit existing files; don't create new top-level dirs without a reason.
- No comments that just narrate WHAT code does. Comments are for non-obvious WHY (hidden constraints, invariants, workarounds).
- Don't add backwards-compatibility shims unless needed; do keep the legacy-deck hydration path in `persistedToPluginState`.
- Windows is the dev platform. Shell is PowerShell; Bash is available via the Bash tool.

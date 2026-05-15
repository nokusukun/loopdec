import type { Tile } from '../types';
import { tiles } from '../state';
import { tilesGrid } from './dom';
import { setTilePosition, renderEmptyCells } from './grid';
import { saveManifest } from '../persistence/manifest';

// Generic pointer-slider lifecycle used by the EQ bands and the speed track.
// Captures the pointer, computes the element's rect once on down, then forwards
// every move and the final release to the caller. Cancellation is treated as release.
export interface SliderDragHandlers {
  // Return false to abort the drag (e.g. no tile to edit). Run before preventDefault.
  start?: () => boolean | void;
  move: (clientX: number, clientY: number, rect: DOMRect) => void;
  end?: () => void;
}

export function bindSliderDrag(target: HTMLElement, h: SliderDragHandlers): void {
  target.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (h.start?.() === false) return;
    e.preventDefault();
    try { target.setPointerCapture(e.pointerId); } catch {}

    const rect = target.getBoundingClientRect();
    h.move(e.clientX, e.clientY, rect);

    const onMove = (ev: PointerEvent) => h.move(ev.clientX, ev.clientY, rect);
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      h.end?.();
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  });
}

export function enableTileDrag(tile: Tile): void {
  const handle = tile.els.dragHandle;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();

    const tileEl = tile.els.tile;
    const rect = tileEl.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    tileEl.style.position = 'fixed';
    tileEl.style.left = rect.left + 'px';
    tileEl.style.top = rect.top + 'px';
    tileEl.style.width = rect.width + 'px';
    tileEl.style.height = rect.height + 'px';
    tileEl.style.zIndex = '1000';
    tileEl.style.pointerEvents = 'none';
    tileEl.classList.add('dragging');
    document.body.style.cursor = 'grabbing';

    let target: HTMLElement | null = null;
    function setTarget(t: HTMLElement | null) {
      if (target === t) return;
      target?.classList.remove('drop-target');
      target = t;
      target?.classList.add('drop-target');
    }

    function move(ev: PointerEvent) {
      tileEl.style.left = (ev.clientX - offsetX) + 'px';
      tileEl.style.top = (ev.clientY - offsetY) + 'px';

      const below = document.elementFromPoint(ev.clientX, ev.clientY);
      const candidate = below?.closest<HTMLElement>('.tile, .tile-empty') ?? null;
      if (!candidate || candidate === tileEl || !tilesGrid.contains(candidate)) {
        setTarget(null);
        return;
      }
      setTarget(candidate);
    }

    function finish(applyDrop: boolean) {
      if (applyDrop && target) {
        const r = parseInt(target.dataset.row!);
        const c = parseInt(target.dataset.col!);
        if (target.classList.contains('tile-empty')) {
          setTilePosition(tile, r, c);
        } else {
          const other = tiles.get(target.dataset.tileId!);
          if (other) {
            const orow = other.row!, ocol = other.col!;
            setTilePosition(other, tile.row!, tile.col!);
            setTilePosition(tile, orow, ocol);
          }
        }
      }
      target?.classList.remove('drop-target');
      (['position', 'left', 'top', 'width', 'height', 'zIndex', 'pointerEvents'] as const).forEach(p => {
        tileEl.style[p] = '';
      });
      tileEl.classList.remove('dragging');
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', onKey);
      if (applyDrop) {
        renderEmptyCells();
        saveManifest();
      }
    }

    function up() { finish(true); }
    function onKey(ev: KeyboardEvent) { if (ev.key === 'Escape') finish(false); }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', onKey);
  });
}

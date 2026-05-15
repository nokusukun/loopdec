// Middle-click + drag panning for the clips container. The pad bank uses
// fixed-size pads, so on small windows or large grids the container scrolls
// in both directions; middle-drag is the quickest way to roam the bank.

import { clipsContainer } from './dom';

export function bindPan(): void {
  let panning = false;
  let startX = 0;
  let startY = 0;
  let startScrollX = 0;
  let startScrollY = 0;

  // Suppress the default browser autoscroll (the four-arrow cursor) on
  // middle-down so our pointer-driven pan can take over.
  clipsContainer.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  clipsContainer.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  });

  clipsContainer.addEventListener('pointerdown', (e) => {
    if (e.button !== 1) return;
    panning = true;
    startX = e.clientX;
    startY = e.clientY;
    startScrollX = clipsContainer.scrollLeft;
    startScrollY = clipsContainer.scrollTop;
    clipsContainer.classList.add('panning');
    try { clipsContainer.setPointerCapture(e.pointerId); } catch {}
  });

  clipsContainer.addEventListener('pointermove', (e) => {
    if (!panning) return;
    clipsContainer.scrollLeft = startScrollX - (e.clientX - startX);
    clipsContainer.scrollTop  = startScrollY - (e.clientY - startY);
  });

  const stop = (e: PointerEvent) => {
    if (!panning) return;
    panning = false;
    clipsContainer.classList.remove('panning');
    try { clipsContainer.releasePointerCapture(e.pointerId); } catch {}
  };
  clipsContainer.addEventListener('pointerup', stop);
  clipsContainer.addEventListener('pointercancel', stop);
}

import { setupOverlay, setupError } from './dom';
import { formatBytes } from './utils';

// The phase machine is loose by design — events flow from main and we route by string.
// Cast to a flat record once at the boundary rather than enumerate every variant.
interface SetupEvent {
  phase: string;
  background?: boolean;
  name?: string;
  error?: string;
  total?: number;
  received?: number;
}

export function bindSetupOverlay(): void {
  window.api.onBinarySetup((raw) => {
    const data = raw as unknown as SetupEvent;
    if (data.background) return;

    if (data.phase === 'ready') { setupOverlay.classList.remove('open'); return; }
    if (data.phase === 'error') {
      setupError.textContent = data.error || 'Setup failed';
      setupError.classList.add('show');
      return;
    }
    if (data.phase === 'first-run') { setupOverlay.classList.add('open'); return; }

    const row = data.name === 'yt-dlp'
      ? document.getElementById('setup-row-yt-dlp')
      : data.name === 'ffmpeg' ? document.getElementById('setup-row-ffmpeg') : null;
    if (!row) return;

    const status = row.querySelector<HTMLElement>('.setup-bin-status')!;
    const fill = row.querySelector<HTMLElement>('.setup-progress-fill')!;

    if (data.phase === 'start') {
      row.dataset.state = 'active';
      status.textContent = 'Starting...';
    } else if (data.phase === 'downloading') {
      row.dataset.state = 'active';
      const total = data.total ?? 0;
      const received = data.received ?? 0;
      const pct = total ? (received / total) * 100 : 0;
      fill.style.width = `${pct}%`;
      status.textContent = total
        ? `${formatBytes(received)} / ${formatBytes(total)}`
        : `${formatBytes(received)}`;
    } else if (data.phase === 'extracting') {
      status.textContent = 'Extracting...';
      fill.style.width = '100%';
    } else if (data.phase === 'pending-restart') {
      status.textContent = 'Ready after restart';
      row.dataset.state = 'done';
    } else if (data.phase === 'done') {
      row.dataset.state = 'done';
      status.textContent = 'Ready';
      fill.style.width = '100%';
    }
  });
}

import { gridShape, applyGridShape, findFirstEmptyCell, setTilePosition } from './grid';
import { gridColsInput, gridRowsInput } from './dom';
import { tiles } from './state';
import { saveManifest } from './manifest';

function setGridShape(cols: number, rows: number): void {
  gridShape.cols = Math.max(1, Math.min(10, cols | 0));
  gridShape.rows = Math.max(1, Math.min(10, rows | 0));
  const overflow = [...tiles.values()].filter(t => (t.row ?? 0) >= gridShape.rows || (t.col ?? 0) >= gridShape.cols);
  for (const t of overflow) {
    t.row = -1; t.col = -1;
    const cell = findFirstEmptyCell();
    setTilePosition(t, cell.row, cell.col);
  }
  applyGridShape();
  localStorage.setItem('loopdec-grid-cols', String(gridShape.cols));
  localStorage.setItem('loopdec-grid-rows', String(gridShape.rows));
  saveManifest();
}

export function bindSettings(): void {
  document.getElementById('set-cache')!.addEventListener('change', async (e) => {
    const gb = parseFloat((e.target as HTMLInputElement).value);
    if (gb > 0 && isFinite(gb)) {
      await window.api.setMaxCache(gb);
      const info = await window.api.getCacheInfo();
      document.getElementById('set-cache-used')!.textContent = `${info.usedGB} GB / ${info.files} files`;
    }
  });

  gridColsInput.addEventListener('change', () => {
    setGridShape(parseInt(gridColsInput.value), gridShape.rows);
  });
  gridRowsInput.addEventListener('change', () => {
    setGridShape(gridShape.cols, parseInt(gridRowsInput.value));
  });

  document.getElementById('set-quality')!.addEventListener('change', (e) => {
    localStorage.setItem('loopdec-quality', (e.target as HTMLInputElement).value);
  });
  document.getElementById('set-bitrate')!.addEventListener('change', (e) => {
    localStorage.setItem('loopdec-bitrate', (e.target as HTMLInputElement).value);
  });
  document.getElementById('set-snap')!.addEventListener('change', (e) => {
    localStorage.setItem('loopdec-snap', (e.target as HTMLInputElement).value);
  });
  document.getElementById('set-ytdlp')!.addEventListener('change', (e) => {
    localStorage.setItem('loopdec-ytdlp', (e.target as HTMLInputElement).value);
  });
}

export function restoreSettings(): void {
  const quality = localStorage.getItem('loopdec-quality');
  if (quality) (document.getElementById('set-quality') as HTMLInputElement).value = quality;
  const bitrate = localStorage.getItem('loopdec-bitrate');
  if (bitrate) (document.getElementById('set-bitrate') as HTMLInputElement).value = bitrate;
  const snapPref = localStorage.getItem('loopdec-snap');
  if (snapPref) (document.getElementById('set-snap') as HTMLInputElement).value = snapPref;
  const savedCols = parseInt(localStorage.getItem('loopdec-grid-cols') ?? '');
  const savedRows = parseInt(localStorage.getItem('loopdec-grid-rows') ?? '');
  if (savedCols) gridShape.cols = savedCols;
  if (savedRows) gridShape.rows = savedRows;
  gridColsInput.value = String(gridShape.cols);
  gridRowsInput.value = String(gridShape.rows);
  applyGridShape();
  const ytdlp = localStorage.getItem('loopdec-ytdlp');
  if (ytdlp) (document.getElementById('set-ytdlp') as HTMLInputElement).value = ytdlp;
}

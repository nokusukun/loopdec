import { tilesForSource } from '../state';

export function bindDownloadProgress(): void {
  window.api.onDownloadProgress(({ clipId: sourceId, progress }) => {
    for (const tile of tilesForSource(sourceId)) {
      if (tile.els.progressFill) {
        tile.els.progressFill.style.width = `${progress}%`;
      }
      if (tile.els.downloadLabel) {
        tile.els.downloadLabel.textContent = progress < 100 ? `${Math.floor(progress)}%` : 'Loading';
      }
    }
  });
}

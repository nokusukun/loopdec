import { urlForm, urlInput } from './dom';
import { addClip } from './tile';

export function bindUrlInput(): void {
  urlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;

    if (!url.match(/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//)) {
      urlInput.style.borderColor = 'var(--accent)';
      setTimeout(() => { urlInput.style.borderColor = ''; }, 1500);
      return;
    }

    urlInput.value = '';
    addClip(url);
  });
}

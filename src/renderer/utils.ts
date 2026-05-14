export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

export function formatTimePrecise(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${ss < 10 ? '0' : ''}${ss.toFixed(2)}`;
}

export function formatBytes(n: number): string {
  if (!n) return '';
  const mb = n / (1024 * 1024);
  return mb < 1 ? `${(n / 1024).toFixed(0)} KB` : `${mb.toFixed(1)} MB`;
}

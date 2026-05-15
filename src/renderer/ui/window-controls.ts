import { winCloseBtn, winMinimizeBtn, winMaximizeBtn } from './dom';

export function bindWindowControls(): void {
  winCloseBtn.addEventListener('click', () => window.win.close());
  winMinimizeBtn.addEventListener('click', () => window.win.minimize());
  winMaximizeBtn.addEventListener('click', () => window.win.maximize());
}

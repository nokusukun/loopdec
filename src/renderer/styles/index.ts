// Barrel for global styles. Imported once from the renderer entry; esbuild
// concatenates everything into dist/renderer.css alongside any plugin CSS.
// Per-plugin styles ship from src/renderer/plugins/*/<name>.css.

import './base.css';
import './titlebar.css';
import './pads.css';
import './idle.css';
import './waveform.css';
import './palette.css';
import './sidebar.css';
import './drop.css';
import './setup.css';

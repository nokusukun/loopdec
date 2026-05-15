// Renderer entry. Imports here run in order — each `bind*` attaches DOM listeners
// to elements that already exist (this script runs at end of <body>).

import './styles'; // global CSS — bundled to dist/renderer.css by esbuild
import './ui/dom'; // ensures DOM refs throw early if any are missing
import { bindWindowControls } from './ui/window-controls';
import { bindSetupOverlay } from './ui/setup-overlay';
import { bindTransport } from './audio/transport';
import { bindWaveform } from './ui/waveform';
import { bindSnap } from './ui/snap';
import { bindSidebar } from './ui/sidebar';
import { bindSettings, restoreSettings } from './ui/settings';
import { bindPalette } from './ui/palette';
import { bindKeyboard } from './ui/keyboard';
import { bindUrlInput } from './ui/url-input';
import { bindDownloadProgress } from './ui/download-progress';
import { bindIdle } from './ui/idle';
import { bindPlugins } from './plugins/registry';
import './plugins/eq';
import './plugins/speed';
import { bindLocalFiles } from './ui/local-files';
import { bindPan } from './ui/pan';
import { restoreOutputDevice, applyStoredDeviceToContext } from './audio/output';
import { onAudioContextCreated } from './audio/context';
import { updateEmptyState } from './state';

bindWindowControls();
bindSetupOverlay();
bindTransport();
bindWaveform();
bindSnap();
bindSidebar();
bindSettings();
bindPalette();
bindKeyboard();
bindUrlInput();
bindDownloadProgress();
bindIdle();
bindPlugins();
bindLocalFiles();
bindPan();

// Tag the host OS so platform-specific hints (e.g. the virtual-cable suggestion
// in audio settings) can show only the relevant entry without touching JS.
const ua = navigator.userAgent;
document.documentElement.dataset.os =
  /Windows/i.test(ua) ? 'win' :
  /Mac OS X|Macintosh/i.test(ua) ? 'mac' :
  'linux';

restoreSettings();
restoreOutputDevice();
onAudioContextCreated(applyStoredDeviceToContext);

// Start with a fresh deck on every launch. The idle screen surfaces recent decks
// for quick re-open; explicit Save Deck is the persistence mechanism, not the manifest.
updateEmptyState();

// Renderer entry. Imports here run in order — each `bind*` attaches DOM listeners
// to elements that already exist (this script runs at end of <body>).

import './dom'; // ensures DOM refs throw early if any are missing
import { bindWindowControls } from './window-controls';
import { bindSetupOverlay } from './setup-overlay';
import { bindTransport } from './transport';
import { bindWaveform } from './waveform';
import { bindSnap } from './snap';
import { bindSidebar } from './sidebar';
import { bindSettings, restoreSettings } from './settings';
import { bindPalette } from './palette';
import { bindKeyboard } from './keyboard';
import { bindUrlInput } from './url-input';
import { bindDownloadProgress } from './download-progress';
import { bindIdle } from './idle';
import { bindEq } from './eq';
import { bindSpeed } from './speed';
import { bindLocalFiles } from './local-files';
import { restoreOutputDevice, applyStoredDeviceToContext } from './audio-output';
import { onAudioContextCreated } from './audio-context';
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
bindEq();
bindSpeed();
bindLocalFiles();

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

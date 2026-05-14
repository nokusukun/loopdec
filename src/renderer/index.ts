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
import { restoreSession } from './restore';

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

// Reads localStorage prefs (including grid shape) and applies them before restoring session,
// so the grid is correctly sized when tiles get re-placed.
restoreSettings();

restoreSession();

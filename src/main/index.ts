import { app, BrowserWindow } from 'electron';
import { ensureDownloadsDir } from './paths';
import { registerClipProtocolSchemes, handleClipProtocol } from './protocol';
import { createWindow, getMainWindow, registerWindowControls } from './window';
import { registerClipHandlers } from './clips';
import { registerAudioHandlers } from './audio';
import { registerCacheHandlers } from './cache';
import { registerManifestHandlers } from './manifest';
import { registerDeckHandlers } from './decks';
import { registerBinaryHandlers, bootstrapBinaries } from './binaries-ipc';

registerClipProtocolSchemes();
registerWindowControls();
registerClipHandlers();
registerAudioHandlers();
registerCacheHandlers();
registerManifestHandlers();
registerDeckHandlers();
registerBinaryHandlers();

app.whenReady().then(() => {
  ensureDownloadsDir();
  handleClipProtocol();
  const win = createWindow();

  win.webContents.once('did-finish-load', () => {
    bootstrapBinaries();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Suppress unused-import warning for getMainWindow (re-exported via window.ts).
void getMainWindow;

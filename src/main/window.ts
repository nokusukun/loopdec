import { BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import type { BinarySetupEvent, DownloadProgressEvent } from '../shared/types';

let mainWindow: BrowserWindow | null = null;

export function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: -100, y: -100 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Route any target="_blank" / window.open() out to the user's default browser
  // instead of opening a new Electron window. Returning 'deny' prevents the
  // popup window from being created.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function registerWindowControls(): void {
  ipcMain.on('win-minimize', () => mainWindow?.minimize());
  ipcMain.on('win-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.on('win-close', () => mainWindow?.close());
}

export function sendSetup(payload: BinarySetupEvent & { background?: boolean }): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('binary-setup', payload);
  }
}

export function sendDownloadProgress(payload: DownloadProgressEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('download-progress', payload);
  }
}

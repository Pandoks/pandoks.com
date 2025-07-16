import { WebContentsView, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';

export const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    mainWindow.webContents.on('did-frame-finish-load', () => {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    });
  } else {
    mainWindow.loadFile(
      path.join(import.meta.dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }
};

const windowWebContentsViews = new Map<number, WebContentsView>();

export function registerBrowserHandlers() {
  ipcMain.handle('navigate', async (event, url) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const webContentsView = windowWebContentsViews.get(senderWindow?.id || 0);

    if (webContentsView) {
      await webContentsView.webContents.loadURL(url);
    }
  });
}

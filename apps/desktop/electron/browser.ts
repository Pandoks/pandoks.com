import { WebContentsView, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';

// tells TypeScript that the variables are available in the main process
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

export const createBrowserWindow = () => {
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
    const webContentsView = createWebContentsView(mainWindow);
    webContentsView.setBounds({ x: 0, y: 60, width: 800, height: 540 });
    webContentsView.webContents.loadURL('https://www.google.com');

    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    mainWindow.contentView.addChildView(webContentsView);

    mainWindow.webContents.on('did-frame-finish-load', () => {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    });
  } else {
    mainWindow.loadFile(
      path.join(import.meta.dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }
};

export const createWebContentsView = (browserWindow: BrowserWindow) => {
  const webContentsView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  windowWebContentsViews.set(browserWindow.id, webContentsView);
  return webContentsView;
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

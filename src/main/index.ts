import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import path from 'path';
import { startPeerServer } from '../peer/server';
import { Database } from '../db';

let mainWindow: BrowserWindow;
let peerServer: any;
let db: Database;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    icon: path.join(__dirname, '../../public/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const isDev = process.env.NODE_ENV === 'development';
  const startUrl = isDev
    ? 'http://localhost:3001'
    : `file://${path.join(__dirname, '../renderer/index.html')}`;

  mainWindow.loadURL(startUrl);
  mainWindow.show();

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null as any;
  });
}

app.on('ready', async () => {
  // Initialize database
  db = new Database(path.join(app.getPath('userData'), 'chaosnet.db'));
  await db.init();

  // Start P2P server
  peerServer = await startPeerServer(db);

  // Create window
  createWindow();

  // Setup IPC handlers
  ipcMain.handle('upload-page', async (event, { html, title, tags }) => {
    const pageId = await db.addPage({ html, title, tags, author: 'anonymous' });
    return { success: true, pageId };
  });

  ipcMain.handle('get-pages', async () => {
    return db.getPages();
  });

  ipcMain.handle('get-stats', async () => {
    return db.getStats();
  });

  ipcMain.handle('get-peer-status', async () => {
    return {
      isOnline: peerServer.isListening,
      port: peerServer.port,
      peers: peerServer.peerCount,
      pageCount: await db.getPageCount(),
    };
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

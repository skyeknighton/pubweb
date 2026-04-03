import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import path from 'path';
import { startPeerServer } from '../peer/server';
import { ContentKind, Database, ShareMode } from '../db';

const DEFAULT_MAX_PAGE_BYTES = 1_474_560;
const MAX_PRIVATE_PAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getMaxPageBytes(): number {
  const configuredMaxPageBytes = parseInt(process.env.PEER_MAX_PAGE_BYTES || '', 10);
  return Number.isFinite(configuredMaxPageBytes) && configuredMaxPageBytes > 0
    ? configuredMaxPageBytes
    : DEFAULT_MAX_PAGE_BYTES;
}

let mainWindow: BrowserWindow;
let peerServer: any;
let db: Database;

function normalizeShareMode(value: unknown): ShareMode {
  return value === 'unlisted' || value === 'private-link' || value === 'expires'
    ? value
    : 'public';
}

function normalizeContentKind(value: unknown): ContentKind {
  return value === 'image-page' ? 'image-page' : 'html';
}

function normalizeExpiresAt(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function getMaxPrivateExpiry(shareMode: ShareMode, now: number): number | undefined {
  const enforceLimit = shareMode === 'unlisted' || shareMode === 'private-link' || shareMode === 'expires';
  if (!enforceLimit) {
    return undefined;
  }

  return now + MAX_PRIVATE_PAGE_TTL_MS;
}

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
    : `file://${path.join(__dirname, '../../renderer/index.html')}`;

  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedURL) => {
    console.error(`Window failed to load (${code}): ${description} -> ${validatedURL}`);
  });

  mainWindow.loadURL(startUrl);
  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);
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
  const startupReachability = peerServer.getReachabilityState();
  console.log('Peer reachability on startup:', startupReachability);

  // Create window
  createWindow();

  // Setup IPC handlers
  ipcMain.handle('upload-page', async (event, payload) => {
    const {
      html,
      title,
      tags,
      shareMode: rawShareMode,
      discoverable: rawDiscoverable,
      expiresAt: rawExpiresAt,
      contentKind: rawContentKind,
      mimeType,
      mediaWidth,
      mediaHeight,
      isEncrypted,
    } = payload || {};

    const maxPageBytes = getMaxPageBytes();
    const htmlBytes = Buffer.byteLength(String(html || ''));
    if (!html || htmlBytes > maxPageBytes) {
      throw new Error(`Page exceeds max size of ${maxPageBytes} bytes`);
    }

    const shareMode = normalizeShareMode(rawShareMode);
    const providedExpiresAt = normalizeExpiresAt(rawExpiresAt);
    const discoverable = typeof rawDiscoverable === 'boolean'
      ? rawDiscoverable
      : !(shareMode === 'unlisted' || shareMode === 'private-link');
    const contentKind = normalizeContentKind(rawContentKind);
    const now = Date.now();
    const maxPrivateExpiry = getMaxPrivateExpiry(shareMode, now);
    if (providedExpiresAt && maxPrivateExpiry && providedExpiresAt > maxPrivateExpiry) {
      throw new Error('Expiry cannot be more than 7 days in the future for unlisted/private pages');
    }
    const expiresAt = providedExpiresAt ?? maxPrivateExpiry;

    if (expiresAt && expiresAt <= now) {
      throw new Error('Expiry must be in the future');
    }

    const pageId = await db.addPage({
      html,
      title: typeof title === 'string' ? title : '',
      tags: Array.isArray(tags) ? tags : [],
      author: 'anonymous',
      shareMode,
      discoverable,
      expiresAt,
      contentKind,
      mimeType: typeof mimeType === 'string' ? mimeType : undefined,
      mediaWidth: typeof mediaWidth === 'number' ? mediaWidth : undefined,
      mediaHeight: typeof mediaHeight === 'number' ? mediaHeight : undefined,
      isEncrypted: !!isEncrypted,
    });
    return {
      success: true,
      pageId,
      expiresAt,
      effectiveExpiresAt: expiresAt,
      shareMode,
    };
  });

  ipcMain.handle('get-pages', async () => {
    return db.getPages();
  });

  ipcMain.handle('get-stats', async () => {
    return db.getStats();
  });

  ipcMain.handle('get-peer-status', async () => {
    const reachability = peerServer.getReachabilityState();
    return {
      isOnline: peerServer.isListening,
      port: peerServer.port,
      peers: peerServer.peerCount,
      pageCount: await db.getPageCount(),
      trackerUrl: process.env.TRACKER_URL || 'https://tracker.pubweb.online',
      reachable: reachability.reachable,
      relayRequired: reachability.relayRequired,
      natType: reachability.natType,
      publicBaseUrl: reachability.publicBaseUrl,
      mappedPort: reachability.mappedPort,
      probeStatus: reachability.probeStatus,
      lastProbeAt: reachability.lastProbeAt,
      lastProbeError: reachability.lastProbeError,
    };
  });

  ipcMain.handle('retry-nat-probe', async () => {
    await peerServer.retryReachabilityProbe();
    const reachability = peerServer.getReachabilityState();
    return {
      isOnline: peerServer.isListening,
      port: peerServer.port,
      peers: peerServer.peerCount,
      pageCount: await db.getPageCount(),
      trackerUrl: process.env.TRACKER_URL || 'https://tracker.pubweb.online',
      reachable: reachability.reachable,
      relayRequired: reachability.relayRequired,
      natType: reachability.natType,
      publicBaseUrl: reachability.publicBaseUrl,
      mappedPort: reachability.mappedPort,
      probeStatus: reachability.probeStatus,
      lastProbeAt: reachability.lastProbeAt,
      lastProbeError: reachability.lastProbeError,
    };
  });

  ipcMain.handle('get-network-stats', async () => {
    const trackerBase = (process.env.TRACKER_URL || 'https://tracker.pubweb.online').replace(/\/+$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const [peersRes, discoverRes] = await Promise.all([
        fetch(`${trackerBase}/peers`, { signal: controller.signal }),
        fetch(`${trackerBase}/discover?limit=100`, { signal: controller.signal }),
      ]);
      const peersData = peersRes.ok ? (await peersRes.json() as { count?: number }) : null;
      const discoverData = discoverRes.ok ? (await discoverRes.json() as { count?: number; items?: unknown[] }) : null;
      return {
        peerCount: typeof peersData?.count === 'number' ? peersData.count : null,
        pageCount: discoverData?.items ? (discoverData.items as unknown[]).length : null,
        trackerReachable: peersRes.ok,
      };
    } catch {
      return { peerCount: null, pageCount: null, trackerReachable: false };
    } finally {
      clearTimeout(timeout);
    }
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

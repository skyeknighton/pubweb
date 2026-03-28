import express, { Express } from 'express';
import crypto from 'crypto';
import { Database } from '../db';
import * as config from '../../config.json';

const TRACKER_URL = process.env.TRACKER_URL || (config as any).trackerUrl || 'http://localhost:4000';

class PeerServer {
  private app: Express;
  private db: Database;
  private peerId: string = crypto.randomUUID();
  private announceInterval: NodeJS.Timeout | null = null;
  private assignmentInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private publicHost: string;

  public port: number = 3000;
  public isListening: boolean = false;
  public peerCount: number = 0;
  private pages: Set<string> = new Set();

  constructor(db: Database) {
    this.db = db;
    this.app = express();
    this.publicHost = process.env.PUBLIC_HOST || process.env.TUNNEL_HOST || 'localhost';
    this.setupRoutes();
  }

  public getPeerId(): string {
    return this.peerId;
  }

  public async getInventoryHashes(): Promise<string[]> {
    return this.db.getPageHashes(1000);
  }

  private async announceTracker() {
    try {
      const pages = Array.from(this.pages.keys());
      console.log(`Announcing ${pages.length} pages to tracker at ${TRACKER_URL}`);
      const response = await fetch(`${TRACKER_URL.replace(/\/+$/, '')}/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          peerId: this.peerId,
          host: this.publicHost,
          port: this.port,
          pages,
          bytesUploaded: (await this.db.getStats()).bytesUploaded,
          bytesDownloaded: (await this.db.getStats()).bytesDownloaded,
        }),
      });
      if (response.ok) {
        console.log('Successfully announced to tracker');
      } else {
        console.warn('Tracker announce failed with status:', response.status);
      }
    } catch (err) {
      console.warn('Tracker announce failed:', err);
    }
  }

  private setupRoutes() {
    this.app.use(express.json());

    // Serve a page by hash
    this.app.get('/page/:hash', async (req, res) => {
      const { hash } = req.params;
      const page = await this.db.getPageByHash(hash);
      
      if (!page) {
        return res.status(404).json({ error: 'Page not found' });
      }

      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(page.html);
      
      // Update stats
      await this.db.recordDownload(hash, Buffer.byteLength(page.html));
    });

    // Publish a page
    this.app.post('/publish', express.json({ limit: '1mb' }), async (req, res) => {
      const { html, title, tags } = req.body;
      
      if (!html || Buffer.byteLength(html) > 1024 * 1024) {
        return res.status(400).json({ error: 'Page too large or missing HTML' });
      }

      const hash = crypto.createHash('sha256').update(html).digest('hex');
      const pageId = await this.db.addPage({ html, title, tags, author: 'peer' });

      this.pages.add(hash);
      this.peerCount = this.pages.size;

      await this.announceTracker();

      res.json({ success: true, hash, pageId, size: Buffer.byteLength(html) });
    });

    // Get page metadata
    this.app.get('/page/:hash/meta', async (req, res) => {
      const { hash } = req.params;
      const page = await this.db.getPageByHash(hash);
      
      if (!page) {
        return res.status(404).json({ error: 'Page not found' });
      }

      res.json({
        hash,
        title: page.title,
        author: page.author,
        created: page.created,
        version: page.version,
        size: Buffer.byteLength(page.html),
        downloads: page.downloads,
      });
    });

    // Get peer status
    this.app.get('/status', async (req, res) => {
      const stats = await this.db.getStats();
      res.json({
        status: 'online',
        port: this.port,
        peers: this.peerCount,
        pages: await this.db.getPageCount(),
        bytesUploaded: stats.bytesUploaded,
        bytesDownloaded: stats.bytesDownloaded,
        shareUrl: process.env.PUBLIC_BASE_URL || `https://${config.domain}/page/`,
      });
    });

    // Discover peers
    this.app.post('/discover', (req, res) => {
      res.json({
        peerId: crypto.randomUUID(),
        port: this.port,
        pages: Array.from(this.pages.keys()),
      });
    });
  }

  async start(port: number = config.peerPort): Promise<void> {
    const hashes = await this.db.getPageHashes(2000);
    this.pages = new Set(hashes);
    this.peerCount = this.pages.size;

    return new Promise(async (resolve) => {
      this.port = port;
      console.log(`Starting peer server on port ${port}...`);
      this.app.listen(port, async () => {
        this.isListening = true;
        console.log(`Peer server listening on port ${port}`);
        await this.announceTracker();
        await this.sendHeartbeat();
        await this.syncAssignments();
        this.announceInterval = setInterval(() => this.announceTracker(), 15000);
        this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), 60000);
        this.assignmentInterval = setInterval(() => this.syncAssignments(), 60000);
        resolve();
      });
    });
  }

  private async syncAssignments(): Promise<void> {
    try {
      const assignmentsUrl = `${TRACKER_URL.replace(/\/+$/, '')}/v1/peer/assignments?peerId=${encodeURIComponent(this.peerId)}`;
      const response = await fetch(assignmentsUrl);
      if (!response.ok) {
        return;
      }

      const payload = await response.json() as { items?: Array<{ siteHash: string }> };
      const items = payload.items || [];

      for (const item of items) {
        const hash = item.siteHash;
        if (!hash) {
          continue;
        }

        const exists = await this.db.hasPageHash(hash);
        if (exists) {
          continue;
        }

        const fetchUrl = `${TRACKER_URL.replace(/\/+$/, '')}/page/${encodeURIComponent(hash)}`;
        const pageRes = await fetch(fetchUrl);
        if (!pageRes.ok) {
          continue;
        }

        const html = await pageRes.text();
        const computed = crypto.createHash('sha256').update(html).digest('hex');
        if (computed !== hash) {
          console.warn(`Assignment content hash mismatch for ${hash}`);
          continue;
        }

        await this.db.addPage({
          html,
          title: `Assigned ${hash.slice(0, 12)}`,
          tags: ['assigned'],
          author: 'network',
        });

        this.pages.add(hash);
      }

      this.peerCount = this.pages.size;
      if (items.length > 0) {
        await this.announceTracker();
      }
    } catch (err) {
      console.warn('Assignment sync failed:', err);
    }
  }

  async sendHeartbeat(): Promise<void> {
    try {
      const stats = await this.db.getStats();
      const storageBytes = await this.db.getStorageBytes();
      const inventory = (await this.db.getPageHashes(2000)).map((siteHash) => ({
        siteHash,
        version: 1,
        state: 'seeded',
      }));

      const body = {
        peerId: this.peerId,
        version: process.env.npm_package_version || '0.1.0',
        capacity: {
          maxDiskBytes: parseInt(process.env.PEER_MAX_DISK_BYTES || `${5 * 1024 * 1024 * 1024}`, 10),
          maxUploadKbps: parseInt(process.env.PEER_MAX_UPLOAD_KBPS || '2048', 10),
        },
        usage: {
          usedDiskBytes: storageBytes,
          bytesUploaded24h: stats.bytesUploaded,
          bytesDownloaded24h: stats.bytesDownloaded,
        },
        inventory,
        health: {
          uptimeSec: Math.floor(process.uptime()),
          natType: process.env.NAT_TYPE || 'unknown',
        },
      };

      const heartbeatUrl = `${TRACKER_URL.replace(/\/+$/, '')}/v1/peer/heartbeat`;
      const response = await fetch(heartbeatUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        console.warn('Heartbeat failed with status:', response.status);
      }
    } catch (err) {
      console.warn('Heartbeat failed:', err);
    }
  }

  stop(): void {
    this.isListening = false;
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
    if (this.assignmentInterval) {
      clearInterval(this.assignmentInterval);
      this.assignmentInterval = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
}

export async function startPeerServer(db: Database): Promise<PeerServer> {
  const server = new PeerServer(db);
  const requestedPort = parseInt(process.env.PORT || process.env.PEER_PORT || String(config.peerPort || 3000), 10);
  await server.start(requestedPort);
  return server;
}

export { PeerServer };

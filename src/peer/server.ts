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

  public port: number = 3000;
  public isListening: boolean = false;
  public peerCount: number = 0;
  private pages: Map<string, string> = new Map();

  constructor(db: Database) {
    this.db = db;
    this.app = express();
    this.setupRoutes();
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
          host: 'localhost',
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

      this.pages.set(hash, html);
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
        shareUrl: `https://${config.domain}:${this.port}/page/`,
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
    return new Promise(async (resolve) => {
      this.port = port;
      console.log(`Starting peer server on port ${port}...`);
      this.app.listen(port, async () => {
        this.isListening = true;
        console.log(`Peer server listening on port ${port}`);
        await this.announceTracker();
        this.announceInterval = setInterval(() => this.announceTracker(), 15000);
        resolve();
      });
    });
  }

  stop(): void {
    this.isListening = false;
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
  }
}

export async function startPeerServer(db: Database): Promise<PeerServer> {
  const server = new PeerServer(db);
  await server.start(3000);
  return server;
}

export { PeerServer };

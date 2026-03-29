import express, { Express } from 'express';
import crypto from 'crypto';
import { Server } from 'http';
import { Database } from '../db';

const NatAPI = require('nat-api');

const TRACKER_URL = process.env.TRACKER_URL || 'http://localhost:4000';
const PEER_ID_SETTING_KEY = 'peer.identity.id';
const PEER_PORT_SETTING_KEY = 'peer.localPort';
const MIN_DYNAMIC_PORT = 49152;
const MAX_DYNAMIC_PORT = 65535;
const MAX_PORT_CANDIDATES = 20;
const DEFAULT_MAX_PAGE_BYTES = 1_474_560;

interface PeerEndpoint {
  kind: 'public' | 'local';
  url: string;
  reachable: boolean;
  source: 'upnp' | 'config' | 'local';
}

interface SwarmPeer {
  peerId: string;
  host: string;
  port: number;
  mappedPort?: number;
  publicBaseUrl?: string;
  natType?: string;
  reachable?: boolean;
  relayRequired?: boolean;
  endpoints?: PeerEndpoint[];
  pageUrl?: string;
}

interface AnnouncePageSummary {
  hash: string;
  title: string;
  created: number;
}

function pickRandomHighPort(): number {
  return Math.floor(Math.random() * (MAX_DYNAMIC_PORT - MIN_DYNAMIC_PORT + 1)) + MIN_DYNAMIC_PORT;
}

function isAddressInUseError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const maybeError = err as { code?: string };
  return maybeError.code === 'EADDRINUSE';
}

class PeerServer {
  private app: Express;
  private db: Database;
  private peerId: string;
  private announceInterval: NodeJS.Timeout | null = null;
  private assignmentInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private publicHost: string;
  private publicBaseUrl?: string;
  private mappedPort?: number;
  private announcedNatType: string;
  private reachable: boolean;
  private relayRequired: boolean;
  private natClient: any | null = null;
  private httpServer: Server | null = null;
  private maxPageBytes: number;

  public port: number = 3000;
  public isListening: boolean = false;
  public peerCount: number = 0;
  private pages: Set<string> = new Set();

  constructor(db: Database, peerId: string) {
    this.db = db;
    this.peerId = peerId;
    this.app = express();
    this.publicHost = process.env.PUBLIC_HOST || process.env.TUNNEL_HOST || 'localhost';
    this.publicBaseUrl = process.env.PUBLIC_BASE_URL;
    this.announcedNatType = process.env.NAT_TYPE || 'unknown';
    this.reachable = !!this.publicBaseUrl || (this.publicHost !== 'localhost' && this.publicHost !== '127.0.0.1');
    this.relayRequired = !this.reachable;
    const configuredMaxPageBytes = parseInt(process.env.PEER_MAX_PAGE_BYTES || '', 10);
    this.maxPageBytes = Number.isFinite(configuredMaxPageBytes) && configuredMaxPageBytes > 0
      ? configuredMaxPageBytes
      : DEFAULT_MAX_PAGE_BYTES;
    this.setupRoutes();
  }

  public getPeerId(): string {
    return this.peerId;
  }

  public async getInventoryHashes(): Promise<string[]> {
    return this.db.getPageHashes(1000);
  }

  private getAdvertisedEndpoints(): PeerEndpoint[] {
    const endpoints: PeerEndpoint[] = [];

    if (this.publicBaseUrl) {
      endpoints.push({
        kind: 'public',
        url: this.publicBaseUrl,
        reachable: this.reachable,
        source: this.announcedNatType === 'upnp' ? 'upnp' : 'config',
      });
    }

    endpoints.push({
      kind: 'local',
      url: `http://127.0.0.1:${this.port}`,
      reachable: true,
      source: 'local',
    });

    return endpoints;
  }

  private inferReachability(): { reachable: boolean; relayRequired: boolean; mappedPort?: number } {
    const explicitReachable = process.env.PEER_REACHABLE;
    const explicitRelay = process.env.PEER_RELAY_REQUIRED;
    const mappedPort = parseInt(process.env.PEER_MAPPED_PORT || '', 10);

    if (explicitReachable === 'true' || explicitReachable === 'false') {
      const reachable = explicitReachable === 'true';
      const relayRequired = explicitRelay === 'true' || !reachable;
      return { reachable, relayRequired, mappedPort: Number.isFinite(mappedPort) ? mappedPort : undefined };
    }

    return {
      reachable: this.reachable,
      relayRequired: this.relayRequired,
      mappedPort: Number.isFinite(mappedPort) ? mappedPort : this.mappedPort,
    };
  }

  private async probeReachability(): Promise<void> {
    if (process.env.DISABLE_NAT_PROBE === 'true' || this.publicBaseUrl) {
      return;
    }

    const currentHost = (this.publicHost || '').toLowerCase();
    if (currentHost !== 'localhost' && currentHost !== '127.0.0.1') {
      this.reachable = true;
      this.relayRequired = false;
      return;
    }

    const preferredPublicPort = parseInt(process.env.PEER_PUBLIC_PORT || process.env.PEER_MAPPED_PORT || `${this.port}`, 10);
    const natClient = new NatAPI({ enablePMP: false, description: 'PubWeb Peer' });
    this.natClient = natClient;

    try {
      await new Promise<void>((resolve, reject) => {
        natClient.map({
          publicPort: preferredPublicPort,
          privatePort: this.port,
          protocol: 'TCP',
          ttl: 3600,
          description: 'PubWeb Peer',
        }, (err: Error | null | undefined) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });

      const externalIp = await new Promise<string>((resolve, reject) => {
        natClient.externalIp((err: Error | null | undefined, ip: string) => {
          if (err || !ip) {
            reject(err || new Error('No external IP returned'));
            return;
          }
          resolve(ip);
        });
      });

      this.publicHost = externalIp;
      this.mappedPort = preferredPublicPort;
      this.publicBaseUrl = `http://${externalIp}:${preferredPublicPort}`;
      this.announcedNatType = 'upnp';
      this.reachable = true;
      this.relayRequired = false;
      console.log(`NAT probe succeeded, mapped peer to ${this.publicBaseUrl}`);
    } catch (err) {
      this.announcedNatType = process.env.NAT_TYPE || 'unknown';
      this.reachable = false;
      this.relayRequired = true;
      console.warn('NAT probe failed, continuing as relay-required peer:', err);
    }
  }

  private buildPeerPageUrl(peer: SwarmPeer, hash: string): string {
    if (peer.pageUrl) {
      return peer.pageUrl;
    }
    if (peer.publicBaseUrl) {
      return `${peer.publicBaseUrl.replace(/\/+$/, '')}/page/${encodeURIComponent(hash)}`;
    }
    return `http://${peer.host}:${peer.port}/page/${encodeURIComponent(hash)}`;
  }

  private extractTitleFromHtml(html: string, fallback: string): string {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const rawTitle = titleMatch?.[1] || h1Match?.[1] || '';
    const cleaned = rawTitle
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .trim();

    return cleaned || fallback;
  }

  private isPlaceholderTitle(value: string | undefined): boolean {
    if (!value) {
      return true;
    }

    const title = value.trim();
    if (!title) {
      return true;
    }

    return title.startsWith('Assigned ') || title.startsWith('Untitled ');
  }

  private async getSwarmPeers(hash: string): Promise<SwarmPeer[]> {
    const url = `${TRACKER_URL.replace(/\/+$/, '')}/v1/swarm/${encodeURIComponent(hash)}/peers?peerId=${encodeURIComponent(this.peerId)}&max=20`;
    const response = await fetch(url);
    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as { peers?: SwarmPeer[] };
    return payload.peers || [];
  }

  private async announceTracker() {
    try {
      const pages = Array.from(this.pages.keys());
      const pageSummaries = (await this.db.getPageSummaries(500))
        .filter((summary) => pages.includes(summary.hash))
        .map<AnnouncePageSummary>((summary) => ({
          hash: summary.hash,
          title: summary.title,
          created: summary.created,
        }));
      const reachability = this.inferReachability();
      console.log(`Announcing ${pages.length} pages to tracker at ${TRACKER_URL}`);
      const response = await fetch(`${TRACKER_URL.replace(/\/+$/, '')}/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          peerId: this.peerId,
          host: this.publicHost,
          port: this.port,
          publicBaseUrl: this.publicBaseUrl,
          mappedPort: reachability.mappedPort,
          natType: this.announcedNatType,
          reachable: reachability.reachable,
          relayRequired: reachability.relayRequired,
          endpoints: this.getAdvertisedEndpoints(),
          pages,
          pageSummaries,
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
    this.app.use(express.json({ limit: this.maxPageBytes }));

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
    this.app.post('/publish', async (req, res) => {
      const { html, title, tags } = req.body;
      
      if (!html) {
        return res.status(400).json({ error: 'Missing HTML' });
      }

      const htmlBytes = Buffer.byteLength(html);
      if (htmlBytes > this.maxPageBytes) {
        return res.status(400).json({
          error: 'Page too large',
          maxPageBytes: this.maxPageBytes,
          htmlBytes,
        });
      }

      const hash = crypto.createHash('sha256').update(html).digest('hex');
      const inferredTitle = this.extractTitleFromHtml(html, `Untitled ${hash.slice(0, 12)}`);
      const providedTitle = typeof title === 'string' ? title.trim() : '';
      const finalTitle = providedTitle || inferredTitle;
      const existingPage = await this.db.getPageByHash(hash);

      const pageId = await this.db.addPage({
        html,
        title: finalTitle,
        tags: Array.isArray(tags) ? tags : [],
        author: 'peer',
      });

      const shouldRefreshExistingTitle = !existingPage || this.isPlaceholderTitle(existingPage.title);
      if (shouldRefreshExistingTitle && existingPage?.title !== finalTitle) {
        await this.db.updatePageTitle(hash, finalTitle);
      }

      this.pages.add(hash);
      this.peerCount = this.pages.size;

      await this.announceTracker();

      res.json({ success: true, hash, pageId, size: htmlBytes, maxPageBytes: this.maxPageBytes });
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
        peerId: this.peerId,
        port: this.port,
        publicHost: this.publicHost,
        publicBaseUrl: this.publicBaseUrl,
        mappedPort: this.mappedPort,
        natType: this.announcedNatType,
        reachable: this.reachable,
        relayRequired: this.relayRequired,
        endpoints: this.getAdvertisedEndpoints(),
        maxPageBytes: this.maxPageBytes,
        peers: this.peerCount,
        pages: await this.db.getPageCount(),
        bytesUploaded: stats.bytesUploaded,
        bytesDownloaded: stats.bytesDownloaded,
        shareUrl: this.publicBaseUrl || `http://localhost:${this.port}/page/`,
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

  async start(port: number = 3000): Promise<void> {
    const hashes = await this.db.getPageHashes(2000);
    this.pages = new Set(hashes);
    this.peerCount = this.pages.size;

    return new Promise(async (resolve, reject) => {
      this.port = port;
      console.log(`Starting peer server on port ${port}...`);
      this.httpServer = this.app.listen(port, async () => {
        this.isListening = true;
        console.log(`Peer server listening on port ${port}`);
        await this.probeReachability();
        await this.announceTracker();
        await this.sendHeartbeat();
        await this.syncAssignments();
        this.announceInterval = setInterval(() => this.announceTracker(), 15000);
        this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), 60000);
        this.assignmentInterval = setInterval(() => this.syncAssignments(), 60000);
        resolve();
      });

      this.httpServer.once('error', (error) => {
        this.httpServer = null;
        reject(error);
      });
    });
  }

  private async syncAssignments(): Promise<void> {
    if (process.env.DISABLE_ASSIGNMENTS === 'true') {
      return;
    }

    try {
      const assignmentsUrl = `${TRACKER_URL.replace(/\/+$/, '')}/v1/peer/assignments?peerId=${encodeURIComponent(this.peerId)}`;
      const response = await fetch(assignmentsUrl);
      if (!response.ok) {
        return;
      }

      const payload = await response.json() as { items?: Array<{ siteHash: string }> };
      const items = payload.items || [];
      let fetched = 0;

      for (const item of items) {
        const hash = item.siteHash;
        if (!hash) {
          continue;
        }

        const exists = await this.db.hasPageHash(hash);
        if (exists) {
          continue;
        }

        let html: string | null = null;
        const swarmPeers = await this.getSwarmPeers(hash);
        for (const peer of swarmPeers) {
          const peerUrl = this.buildPeerPageUrl(peer, hash);
          try {
            const peerRes = await fetch(peerUrl);
            if (!peerRes.ok) {
              continue;
            }
            html = await peerRes.text();
            break;
          } catch {
            // Try next peer candidate
          }
        }

        if (!html) {
          const fetchUrl = `${TRACKER_URL.replace(/\/+$/, '')}/page/${encodeURIComponent(hash)}`;
          const pageRes = await fetch(fetchUrl);
          if (!pageRes.ok) {
            continue;
          }
          html = await pageRes.text();
        }
        const computed = crypto.createHash('sha256').update(html).digest('hex');
        if (computed !== hash) {
          console.warn(`Assignment content hash mismatch for ${hash}`);
          continue;
        }

        const inferredTitle = this.extractTitleFromHtml(html, `Assigned ${hash.slice(0, 12)}`);

        await this.db.addPage({
          html,
          title: inferredTitle,
          tags: ['assigned'],
          author: 'network',
        });

        this.pages.add(hash);
        fetched++;
      }

      this.peerCount = this.pages.size;
      if (fetched > 0) {
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
      const reachability = this.inferReachability();
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
          natType: this.announcedNatType,
          reachable: reachability.reachable,
          relayRequired: reachability.relayRequired,
          mappedPort: reachability.mappedPort,
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

  async stop(): Promise<void> {
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
    if (this.natClient) {
      try {
        this.natClient.destroy();
      } catch {
        // Ignore teardown failures during shutdown.
      }
      this.natClient = null;
    }

    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = null;
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  }
}

export async function startPeerServer(db: Database): Promise<PeerServer> {
  let peerId = await db.getSetting(PEER_ID_SETTING_KEY);
  if (!peerId) {
    peerId = crypto.randomUUID();
    await db.setSetting(PEER_ID_SETTING_KEY, peerId);
  }

  const server = new PeerServer(db, peerId);
  const explicitPortRaw = process.env.PORT || process.env.PEER_PORT;
  if (explicitPortRaw) {
    const explicitPort = parseInt(explicitPortRaw, 10);
    if (!Number.isFinite(explicitPort) || explicitPort <= 0 || explicitPort > 65535) {
      throw new Error(`Invalid explicit peer port: ${explicitPortRaw}`);
    }

    await server.start(explicitPort);
    return server;
  }

  const candidates: number[] = [];
  const seen = new Set<number>();
  const storedPortValue = await db.getSetting(PEER_PORT_SETTING_KEY);
  const storedPort = storedPortValue ? parseInt(storedPortValue, 10) : NaN;

  if (Number.isFinite(storedPort) && storedPort >= MIN_DYNAMIC_PORT && storedPort <= MAX_DYNAMIC_PORT) {
    candidates.push(storedPort);
    seen.add(storedPort);
  }

  while (candidates.length < MAX_PORT_CANDIDATES) {
    const candidate = pickRandomHighPort();
    if (!seen.has(candidate)) {
      candidates.push(candidate);
      seen.add(candidate);
    }
  }

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      await server.start(candidate);
      await db.setSetting(PEER_PORT_SETTING_KEY, String(candidate));
      return server;
    } catch (err) {
      lastError = err;
      if (isAddressInUseError(err)) {
        console.warn(`Peer port ${candidate} already in use, trying another high port...`);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Unable to start peer: no available high dynamic port after ${MAX_PORT_CANDIDATES} attempts. Last error: ${String(lastError)}`);
}

export { PeerServer };

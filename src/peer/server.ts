import express, { Express } from 'express';
import crypto from 'crypto';
import { Server } from 'http';
import { ContentKind, Database, ShareMode } from '../db';

const NatAPI = require('nat-api');

const TRACKER_URL = process.env.TRACKER_URL || 'http://localhost:4000';
const PEER_ID_SETTING_KEY = 'peer.identity.id';
const PEER_PRIVATE_KEY_SETTING_KEY = 'peer.identity.privateKey';
const PEER_PUBLIC_KEY_SETTING_KEY = 'peer.identity.publicKey';
const PEER_PORT_SETTING_KEY = 'peer.localPort';
const MIN_DYNAMIC_PORT = 49152;
const MAX_DYNAMIC_PORT = 65535;
const MAX_PORT_CANDIDATES = 20;
const DEFAULT_MAX_PAGE_BYTES = 1_474_560;
const DEFAULT_EXPIRED_CLEANUP_INTERVAL_MS = 60_000;

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
  signerPeerId: string;
  signature: string;
  signerPublicKey: string;
  shareMode: ShareMode;
  discoverable: boolean;
  expiresAt?: number;
  contentKind: ContentKind;
  mimeType?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  isEncrypted: boolean;
}

interface RemotePageMeta {
  title?: string;
  shareMode?: ShareMode;
  discoverable?: boolean;
  expiresAt?: number;
  contentKind?: ContentKind;
  mimeType?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  isEncrypted?: boolean;
}

type ReachabilityProbeStatus = 'pending' | 'success' | 'failed' | 'skipped';

function normalizeShareMode(value: unknown): ShareMode {
  if (value === 'unlisted' || value === 'private-link' || value === 'expires') {
    return value;
  }
  return 'public';
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
  private expiredCleanupInterval: NodeJS.Timeout | null = null;
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
  private signerPrivateKey: string;
  private signerPublicKey: string;
  private requestCounters: Map<string, { count: number; resetAt: number }> = new Map();
  private adminToken: string;
  private expiredCleanupIntervalMs: number;
  private reachabilityProbeStatus: ReachabilityProbeStatus = 'pending';
  private reachabilityLastProbeAt: number | null = null;
  private reachabilityLastError: string | null = null;

  public port: number = 3000;
  public isListening: boolean = false;
  public peerCount: number = 0;
  private pages: Set<string> = new Set();

  constructor(db: Database, peerId: string, signerPrivateKey: string, signerPublicKey: string) {
    this.db = db;
    this.peerId = peerId;
    this.signerPrivateKey = signerPrivateKey;
    this.signerPublicKey = signerPublicKey;
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
    this.adminToken = String(process.env.PEER_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '').trim();
    const configuredCleanupMs = parseInt(process.env.PEER_EXPIRED_CLEANUP_INTERVAL_MS || '', 10);
    this.expiredCleanupIntervalMs = Number.isFinite(configuredCleanupMs) && configuredCleanupMs >= 5_000
      ? configuredCleanupMs
      : DEFAULT_EXPIRED_CLEANUP_INTERVAL_MS;
    this.setupRoutes();
  }

  private async cleanupExpiredPages(limit: number = 1000): Promise<number> {
    try {
      const expiredHashes = await this.db.findExpiredPageHashes(Date.now(), limit);
      if (expiredHashes.length === 0) {
        return 0;
      }

      const deleted = await this.db.deletePagesByHashes(expiredHashes);
      if (deleted > 0) {
        this.pages = new Set(await this.db.getPageHashes(2000));
        this.peerCount = this.pages.size;
      }
      return deleted;
    } catch (err) {
      console.warn('Failed to cleanup expired pages:', err);
      return 0;
    }
  }

  private isAdminAuthorized(req: express.Request): boolean {
    if (!this.adminToken) {
      return false;
    }

    const headerToken = String(req.get('x-admin-token') || '').trim();
    const authHeader = String(req.get('authorization') || '').trim();
    const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : '';
    const bodyToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';

    return headerToken === this.adminToken || bearerToken === this.adminToken || bodyToken === this.adminToken;
  }

  private getClientIp(req: express.Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const raw = (forwardedValue || req.socket.remoteAddress || req.ip || '').split(',')[0].trim();
    return raw.replace(/^::ffff:/, '') || 'unknown';
  }

  private checkRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    const current = this.requestCounters.get(key);
    if (!current || current.resetAt <= now) {
      this.requestCounters.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }

    if (current.count >= maxRequests) {
      return false;
    }

    current.count += 1;
    return true;
  }

  private static isValidHash(value: string): boolean {
    return /^[a-f0-9]{64}$/i.test(value);
  }

  private createSignedPageManifest(hash: string, title: string, created: number): { signerPeerId: string; signature: string; signerPublicKey: string } {
    const manifest = JSON.stringify({
      hash,
      title,
      created,
      version: 1,
      signerPeerId: this.peerId,
    });

    const signature = crypto.sign(null, Buffer.from(manifest, 'utf8'), this.signerPrivateKey).toString('base64');
    return {
      signerPeerId: this.peerId,
      signature,
      signerPublicKey: this.signerPublicKey,
    };
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

  public getReachabilityState(): {
    reachable: boolean;
    relayRequired: boolean;
    natType: string;
    publicBaseUrl?: string;
    mappedPort?: number;
    probeStatus: ReachabilityProbeStatus;
    lastProbeAt: number | null;
    lastProbeError: string | null;
  } {
    const reachability = this.inferReachability();
    return {
      reachable: reachability.reachable,
      relayRequired: reachability.relayRequired,
      natType: this.announcedNatType,
      publicBaseUrl: this.publicBaseUrl,
      mappedPort: reachability.mappedPort,
      probeStatus: this.reachabilityProbeStatus,
      lastProbeAt: this.reachabilityLastProbeAt,
      lastProbeError: this.reachabilityLastError,
    };
  }

  public async retryReachabilityProbe(): Promise<void> {
    await this.probeReachability(true);
    if (this.isListening) {
      await this.announceTracker();
    }
  }

  private async probeReachability(force: boolean = false): Promise<void> {
    this.reachabilityLastProbeAt = Date.now();
    this.reachabilityLastError = null;

    if (process.env.DISABLE_NAT_PROBE === 'true') {
      this.reachabilityProbeStatus = 'skipped';
      this.reachabilityLastError = 'NAT probe disabled by DISABLE_NAT_PROBE=true';
      console.log('NAT probe skipped (disabled by environment).');
      return;
    }

    if (!force && this.publicBaseUrl) {
      this.reachabilityProbeStatus = 'skipped';
      console.log('NAT probe skipped (public base URL already configured).');
      return;
    }

    if (this.natClient) {
      try {
        this.natClient.destroy();
      } catch {
        // Ignore NAT client cleanup errors between probe attempts.
      }
      this.natClient = null;
    }

    const currentHost = (this.publicHost || '').toLowerCase();
    if (currentHost !== 'localhost' && currentHost !== '127.0.0.1') {
      this.reachable = true;
      this.relayRequired = false;
      this.reachabilityProbeStatus = 'success';
      console.log(`NAT probe not required (public host configured: ${this.publicHost}).`);
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
      this.reachabilityProbeStatus = 'success';
      console.log(`NAT probe succeeded, mapped peer to ${this.publicBaseUrl}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.announcedNatType = process.env.NAT_TYPE || 'unknown';
      this.reachable = false;
      this.relayRequired = true;
      this.reachabilityProbeStatus = 'failed';
      this.reachabilityLastError = message;
      console.warn(`NAT probe failed (${message}). Continuing in relay-required mode.`);
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
      const now = Date.now();
      const pages = Array.from(this.pages.keys());
      const pageSummaries = (await this.db.getPageSummaries(500))
        .filter((summary) => pages.includes(summary.hash))
        .filter((summary) => !summary.expiresAt || summary.expiresAt > now)
        .map<AnnouncePageSummary>((summary) => ({
          hash: summary.hash,
          title: summary.title,
          created: summary.created,
          signerPeerId: summary.signerPeerId || this.peerId,
          signature: summary.signature || '',
          signerPublicKey: summary.signerPublicKey || this.signerPublicKey,
          shareMode: summary.shareMode,
          discoverable: summary.discoverable,
          expiresAt: summary.expiresAt,
          contentKind: summary.contentKind,
          mimeType: summary.mimeType,
          mediaWidth: summary.mediaWidth,
          mediaHeight: summary.mediaHeight,
          isEncrypted: summary.isEncrypted,
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
          pages: pageSummaries.map((s) => s.hash),
          pageSummaries,
          bytesUploaded: (await this.db.getStats()).bytesUploaded,
          bytesDownloaded: (await this.db.getStats()).bytesDownloaded,
        }),
      });
      if (response.ok) {
        console.log(`Successfully announced ${pageSummaries.length} pages to tracker`);
      } else {
        console.warn('Tracker announce failed with status:', response.status);
      }
    } catch (err) {
      console.warn('Tracker announce failed:', err);
    }
  }

  private setupRoutes() {
    this.app.disable('x-powered-by');
    this.app.use((req, res, next) => {
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('x-frame-options', 'SAMEORIGIN');
      res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
      next();
    });
    this.app.use(express.json({ limit: this.maxPageBytes }));

    // Serve a page by hash
    this.app.get('/page/:hash', async (req, res) => {
      const { hash } = req.params;
      if (!PeerServer.isValidHash(hash)) {
        return res.status(400).json({ error: 'Invalid hash format' });
      }

      const rateKey = `page:${this.getClientIp(req)}`;
      if (!this.checkRateLimit(rateKey, 300, 60_000)) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
      }

      const page = await this.db.getPageByHash(hash);
      
      if (!page) {
        return res.status(404).json({ error: 'Page not found' });
      }

      if (page.expiresAt && page.expiresAt <= Date.now()) {
        return res.status(410).json({ error: 'Page expired', expiresAt: page.expiresAt });
      }

      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('cache-control', 'no-store');
      res.send(page.html);
      
      // Update stats
      await this.db.recordDownload(hash, Buffer.byteLength(page.html));
    });

    // Publish a page
    this.app.post('/publish', async (req, res) => {
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
      } = req.body || {};
      const rateKey = `publish:${this.getClientIp(req)}`;
      if (!this.checkRateLimit(rateKey, 30, 60_000)) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
      }
      
      if (typeof html !== 'string' || !html.trim()) {
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
      const finalTitle = (providedTitle || inferredTitle).replace(/\s+/g, ' ').trim().slice(0, 160);
      const created = Date.now();
      const shareMode = normalizeShareMode(rawShareMode);
      const expiresAt = normalizeExpiresAt(rawExpiresAt);
      const discoverable = typeof rawDiscoverable === 'boolean'
        ? rawDiscoverable
        : !(shareMode === 'unlisted' || shareMode === 'private-link');
      const contentKind = normalizeContentKind(rawContentKind);

      if (expiresAt && expiresAt <= created) {
        return res.status(400).json({ error: 'Expiry must be in the future' });
      }

      const signedManifest = this.createSignedPageManifest(hash, finalTitle, created);
      const existingPage = await this.db.getPageByHash(hash);

      const pageId = await this.db.addPage({
        html,
        title: finalTitle,
        tags: Array.isArray(tags) ? tags : [],
        author: 'peer',
        signerPeerId: signedManifest.signerPeerId,
        signature: signedManifest.signature,
        signerPublicKey: signedManifest.signerPublicKey,
        created,
        shareMode,
        discoverable,
        expiresAt,
        contentKind,
        mimeType: typeof mimeType === 'string' ? mimeType : undefined,
        mediaWidth: typeof mediaWidth === 'number' ? mediaWidth : undefined,
        mediaHeight: typeof mediaHeight === 'number' ? mediaHeight : undefined,
        isEncrypted: !!isEncrypted,
      });

      const shouldRefreshExistingTitle = !existingPage || this.isPlaceholderTitle(existingPage.title);
      if (shouldRefreshExistingTitle && existingPage?.title !== finalTitle) {
        await this.db.updatePageTitle(hash, finalTitle);
      }

      this.pages.add(hash);
      this.peerCount = this.pages.size;

      await this.announceTracker();

      res.json({
        success: true,
        hash,
        pageId,
        size: htmlBytes,
        maxPageBytes: this.maxPageBytes,
        signerPeerId: signedManifest.signerPeerId,
        signature: signedManifest.signature,
        shareMode,
        discoverable,
        expiresAt,
        contentKind,
        isEncrypted: !!isEncrypted,
      });
    });

    // Get page metadata
    this.app.get('/page/:hash/meta', async (req, res) => {
      const { hash } = req.params;
      if (!PeerServer.isValidHash(hash)) {
        return res.status(400).json({ error: 'Invalid hash format' });
      }
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
        signerPeerId: page.signerPeerId,
        signature: page.signature,
        signerPublicKey: page.signerPublicKey,
        shareMode: page.shareMode,
        discoverable: page.discoverable,
        expiresAt: page.expiresAt,
        contentKind: page.contentKind,
        mimeType: page.mimeType,
        mediaWidth: page.mediaWidth,
        mediaHeight: page.mediaHeight,
        isEncrypted: page.isEncrypted,
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
        probeStatus: this.reachabilityProbeStatus,
        lastProbeAt: this.reachabilityLastProbeAt,
        lastProbeError: this.reachabilityLastError,
        endpoints: this.getAdvertisedEndpoints(),
        maxPageBytes: this.maxPageBytes,
        peers: this.peerCount,
        pages: await this.db.getPageCount(),
        bytesUploaded: stats.bytesUploaded,
        bytesDownloaded: stats.bytesDownloaded,
        shareUrl: this.publicBaseUrl || `http://localhost:${this.port}/page/`,
      });
    });

    // Purge endpoint for old smoke-test pages.
    this.app.post('/admin/purge-smoke', async (req, res) => {
      const titlePrefix = typeof req.body?.titlePrefix === 'string' && req.body.titlePrefix.trim()
        ? req.body.titlePrefix.trim()
        : 'PubWeb smoke';

      // If no admin token is configured, allow only constrained smoke-prefix purges.
      if (this.adminToken && !this.isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (!this.adminToken && titlePrefix !== 'PubWeb smoke') {
        return res.status(403).json({ error: 'Only default smoke prefix purge is allowed without admin token' });
      }

      const dryRun = req.body?.dryRun === true;
      const maxAgeMs = typeof req.body?.maxAgeMs === 'number'
        ? req.body.maxAgeMs
        : parseInt(String(req.body?.maxAgeMs || ''), 10);
      const limitInput = typeof req.body?.limit === 'number'
        ? req.body.limit
        : parseInt(String(req.body?.limit || '500'), 10);
      const limit = Number.isFinite(limitInput) ? Math.max(1, Math.min(limitInput, 2000)) : 500;
      const beforeTimestamp = Number.isFinite(maxAgeMs) && maxAgeMs > 0
        ? Date.now() - maxAgeMs
        : undefined;

      const candidates = await this.db.findPagesByTitlePrefix(titlePrefix, beforeTimestamp, limit);
      const hashes = candidates.map((candidate) => candidate.hash);

      if (!dryRun && hashes.length > 0) {
        await this.db.deletePagesByHashes(hashes);
        this.pages = new Set(await this.db.getPageHashes(2000));
        this.peerCount = this.pages.size;
        await this.announceTracker();
      }

      return res.json({
        success: true,
        dryRun,
        titlePrefix,
        beforeTimestamp,
        limit,
        count: hashes.length,
        hashes,
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
        const cleaned = await this.cleanupExpiredPages();
        if (cleaned > 0) {
          console.log(`Cleaned up ${cleaned} expired pages before initial announce`);
        }
        await this.probeReachability();
        await this.announceTracker();
        await this.sendHeartbeat();
        await this.syncAssignments();
        this.announceInterval = setInterval(() => this.announceTracker(), 15000);
        this.expiredCleanupInterval = setInterval(async () => {
          const deleted = await this.cleanupExpiredPages();
          if (deleted > 0) {
            console.log(`Cleaned up ${deleted} expired pages`);
            await this.announceTracker();
          }
        }, this.expiredCleanupIntervalMs);
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
        let remoteMeta: RemotePageMeta | null = null;
        const swarmPeers = await this.getSwarmPeers(hash);
        for (const peer of swarmPeers) {
          const peerUrl = this.buildPeerPageUrl(peer, hash);
          try {
            const peerRes = await fetch(peerUrl);
            if (!peerRes.ok) {
              continue;
            }
            html = await peerRes.text();

            try {
              const metaRes = await fetch(`${peerUrl}/meta`);
              if (metaRes.ok) {
                remoteMeta = await metaRes.json() as RemotePageMeta;
              }
            } catch {
              // Continue without metadata if source peer meta fetch fails
            }
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
        const remoteShareMode = normalizeShareMode(remoteMeta?.shareMode);
        const remoteContentKind = normalizeContentKind(remoteMeta?.contentKind);
        const remoteExpiresAt = normalizeExpiresAt(remoteMeta?.expiresAt);
        const remoteDiscoverable = typeof remoteMeta?.discoverable === 'boolean'
          ? remoteMeta.discoverable
          : !(remoteShareMode === 'unlisted' || remoteShareMode === 'private-link');

        await this.db.addPage({
          html,
          title: typeof remoteMeta?.title === 'string' && remoteMeta.title.trim()
            ? remoteMeta.title.trim().slice(0, 160)
            : inferredTitle,
          tags: ['assigned'],
          author: 'network',
          shareMode: remoteShareMode,
          discoverable: remoteDiscoverable,
          expiresAt: remoteExpiresAt,
          contentKind: remoteContentKind,
          mimeType: typeof remoteMeta?.mimeType === 'string' ? remoteMeta.mimeType : undefined,
          mediaWidth: typeof remoteMeta?.mediaWidth === 'number' ? remoteMeta.mediaWidth : undefined,
          mediaHeight: typeof remoteMeta?.mediaHeight === 'number' ? remoteMeta.mediaHeight : undefined,
          isEncrypted: !!remoteMeta?.isEncrypted,
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
          maxDiskBytes: parseInt(process.env.PEER_MAX_DISK_BYTES || `${1024 * 1024 * 1024}`, 10),
          maxUploadKbps: parseInt(process.env.PEER_MAX_UPLOAD_KBPS || '1024', 10),
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
    if (this.expiredCleanupInterval) {
      clearInterval(this.expiredCleanupInterval);
      this.expiredCleanupInterval = null;
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

  let signerPrivateKey = await db.getSetting(PEER_PRIVATE_KEY_SETTING_KEY);
  let signerPublicKey = await db.getSetting(PEER_PUBLIC_KEY_SETTING_KEY);
  if (!signerPrivateKey || !signerPublicKey) {
    const pair = crypto.generateKeyPairSync('ed25519');
    signerPrivateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    signerPublicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await db.setSetting(PEER_PRIVATE_KEY_SETTING_KEY, signerPrivateKey);
    await db.setSetting(PEER_PUBLIC_KEY_SETTING_KEY, signerPublicKey);
  }

  const server = new PeerServer(db, peerId, signerPrivateKey, signerPublicKey);
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

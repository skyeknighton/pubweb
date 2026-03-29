import express, { Request } from 'express';
import crypto from 'crypto';
import { Server } from 'http';
import path from 'path';
import { TrackerStore, PeerHeartbeatPayload } from './store';
// import config from '../../config.json';

interface PeerEndpoint {
  kind: 'public' | 'local';
  url: string;
  reachable: boolean;
  source: 'upnp' | 'config' | 'local';
}

interface TrackerEntry {
  peerId: string;
  host: string;
  port: number;
  observedIp?: string;
  publicBaseUrl?: string;
  mappedPort?: number;
  natType?: string;
  reachable?: boolean;
  relayRequired?: boolean;
  endpoints?: PeerEndpoint[];
  pages: string[];
  pageTitles: Record<string, string>;
  bytesUploaded: number;
  bytesDownloaded: number;
  lastSeen: number;
}

class Tracker {
  private app = express();
  private httpServer: Server | null = null;
  private peers: Map<string, TrackerEntry> = new Map();
  private pageIndex: Map<string, Set<string>> = new Map();
  private resolveCursor: Map<string, number> = new Map();
  private store: TrackerStore;
  private replicationTarget: number;
  private onboardingHash: string;
  private wrapperVersion: string;
  private exposePeerNetworkDetails: boolean;
  private requestCounters: Map<string, { count: number; resetAt: number }> = new Map();
  private firstSignerByHash: Map<string, string> = new Map();
  private requireSignedPages: boolean;

  constructor() {
    const dbPath = process.env.TRACKER_DB_PATH || path.join(process.cwd(), 'tracker.db');
    this.store = new TrackerStore(dbPath);
    this.replicationTarget = parseInt(process.env.REPLICATION_TARGET || '2', 10);
    this.onboardingHash = process.env.PUBWEB_ONBOARDING_HASH || '2cdd7f0aba040460a0b4e1b8dbdc64fcafb669cee87f5ac547c6ecb8f781310f';
    this.wrapperVersion = process.env.PUBWEB_WRAPPER_VERSION || process.env.RAILWAY_DEPLOYMENT_ID || String(Date.now());
    this.exposePeerNetworkDetails = process.env.TRACKER_EXPOSE_PEER_DETAILS === 'true';
    this.requireSignedPages = process.env.TRACKER_REQUIRE_SIGNED_PAGES === 'true';
    this.setupRoutes();
  }

  private static isValidHash(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
  }

  private getClientIp(req: Request): string {
    return this.extractObservedIp(req) || 'unknown';
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

  private isPrivateOrLoopbackHost(host: string): boolean {
    const value = host.toLowerCase();
    if (value === 'localhost' || value === '::1' || value === '0.0.0.0') {
      return true;
    }

    if (/^127\./.test(value) || /^10\./.test(value) || /^192\.168\./.test(value)) {
      return true;
    }

    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(value)) {
      return true;
    }

    if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')) {
      return true;
    }

    return false;
  }

  private normalizePublicBaseUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) {
      return undefined;
    }

    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return undefined;
      }

      if (this.isPrivateOrLoopbackHost(parsed.hostname)) {
        return undefined;
      }

      parsed.hash = '';
      parsed.search = '';
      return parsed.toString().replace(/\/+$/, '');
    } catch {
      return undefined;
    }
  }

  private canonicalManifest(hash: string, title: string, created: number, signerPeerId: string): string {
    return JSON.stringify({
      hash,
      title,
      created,
      version: 1,
      signerPeerId,
    });
  }

  private verifySummarySignature(summary: { hash: string; title: string; created: number; signerPeerId: string; signature: string; signerPublicKey: string }): boolean {
    try {
      const manifest = this.canonicalManifest(summary.hash, summary.title, summary.created, summary.signerPeerId);
      return crypto.verify(
        null,
        Buffer.from(manifest, 'utf8'),
        summary.signerPublicKey,
        Buffer.from(summary.signature, 'base64')
      );
    } catch {
      return false;
    }
  }

  private escapeHtml(value: string): string {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private sanitizeTitleInput(value: unknown): string {
    if (typeof value !== 'string') {
      return '';
    }

    const normalized = value
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return normalized.slice(0, 160);
  }

  private extractObservedIp(req: Request): string | undefined {
    const forwarded = req.headers['x-forwarded-for'];
    const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const candidate = (forwardedValue || req.socket.remoteAddress || req.ip || '').split(',')[0].trim();
    if (!candidate) {
      return undefined;
    }

    return candidate.replace(/^::ffff:/, '');
  }

  private isLocalHost(host: string | undefined): boolean {
    if (!host) {
      return true;
    }

    const normalized = host.toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
  }

  private getDisplayHost(peer: TrackerEntry): string {
    if (peer.observedIp && this.isLocalHost(peer.host)) {
      return peer.observedIp;
    }

    return peer.host;
  }

  private getFetchHost(peer: TrackerEntry): string {
    return peer.host;
  }

  private async probePeer(peer: TrackerEntry): Promise<void> {
    const candidateBases = new Set<string>();

    if (peer.publicBaseUrl) {
      const normalized = this.normalizePublicBaseUrl(peer.publicBaseUrl);
      if (normalized) {
        candidateBases.add(normalized);
      }
    }

    const displayHost = this.getDisplayHost(peer);
    const mappedPort = peer.mappedPort || peer.port;
    if (displayHost && mappedPort && !this.isPrivateOrLoopbackHost(displayHost)) {
      candidateBases.add(`http://${displayHost}:${mappedPort}`);
    }

    for (const baseUrl of candidateBases) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      try {
        const response = await fetch(`${baseUrl}/status`, { signal: controller.signal });
        if (!response.ok) {
          continue;
        }

        const current = this.peers.get(peer.peerId);
        if (!current) {
          return;
        }

        current.publicBaseUrl = baseUrl;
        current.reachable = true;
        current.relayRequired = false;
        current.host = this.getDisplayHost(current);

        if (current.endpoints && current.endpoints.length > 0) {
          current.endpoints = current.endpoints.map((endpoint) => {
            if (endpoint.kind === 'public') {
              return {
                ...endpoint,
                url: baseUrl,
                reachable: true,
              };
            }
            return endpoint;
          });
        } else {
          current.endpoints = [{ kind: 'public', url: baseUrl, reachable: true, source: 'config' }];
        }

        return;
      } catch {
        // Try next candidate
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  private getPeerCandidate(hash: string): TrackerEntry | null {
    const peerIds = this.pageIndex.get(hash);
    if (!peerIds || peerIds.size === 0) {
      return null;
    }

    const candidate = Array.from(peerIds)
      .map((peerId) => this.peers.get(peerId))
      .filter((p): p is TrackerEntry => !!p && Date.now() - p.lastSeen < 60000)[0];

    return candidate || null;
  }

  private getResolveCandidates(hash: string): TrackerEntry[] {
    const candidates = this.getActivePeersForHash(hash, 60_000)
      .sort((a, b) => {
        const aReachable = a.reachable ? 1 : 0;
        const bReachable = b.reachable ? 1 : 0;
        if (bReachable !== aReachable) {
          return bReachable - aReachable;
        }

        const aPublic = a.publicBaseUrl ? 1 : 0;
        const bPublic = b.publicBaseUrl ? 1 : 0;
        if (bPublic !== aPublic) {
          return bPublic - aPublic;
        }

        return b.lastSeen - a.lastSeen;
      });

    if (candidates.length <= 1) {
      return candidates;
    }

    const offset = this.resolveCursor.get(hash) || 0;
    const rotated = candidates.map((_, index) => candidates[(index + offset) % candidates.length]);
    this.resolveCursor.set(hash, (offset + 1) % candidates.length);
    return rotated;
  }

  private getActivePeersForHash(hash: string, maxAgeMs: number = 60_000): TrackerEntry[] {
    const peerIds = this.pageIndex.get(hash);
    if (!peerIds || peerIds.size === 0) {
      return [];
    }

    const cutoff = Date.now() - maxAgeMs;
    return Array.from(peerIds)
      .map((peerId) => this.peers.get(peerId))
      .filter((peer): peer is TrackerEntry => !!peer && peer.lastSeen >= cutoff);
  }

  private buildPeerPageUrl(peer: TrackerEntry, hash: string): string {
    const publicEndpoint = (peer.endpoints || []).find((endpoint) => endpoint.kind === 'public' && endpoint.reachable);
    if (publicEndpoint) {
      const normalized = this.normalizePublicBaseUrl(publicEndpoint.url);
      if (normalized) {
        return `${normalized}/page/${hash}`;
      }
    }
    if (peer.publicBaseUrl) {
      const normalized = this.normalizePublicBaseUrl(peer.publicBaseUrl);
      if (normalized) {
        return `${normalized}/page/${hash}`;
      }
    }

    if (this.isPrivateOrLoopbackHost(this.getFetchHost(peer))) {
      return '';
    }
    return `http://${this.getFetchHost(peer)}:${peer.port}/page/${hash}`;
  }

  private async resolvePage(hash: string): Promise<
    | { status: 'ready'; html: string; contentType: string; target: string; peerId: string }
    | { status: 'warming'; reason: string }
    | { status: 'missing'; reason: string }
  > {
    const candidates = this.getResolveCandidates(hash);
    if (candidates.length === 0) {
      const known = this.pageIndex.has(hash);
      return known
        ? { status: 'warming', reason: 'Page hash exists, waiting for an active peer.' }
        : { status: 'missing', reason: 'Page hash is not currently indexed by tracker.' };
    }

    let lastReason = 'Failed to reach active peer, retrying.';
    for (const candidate of candidates) {
      const target = this.buildPeerPageUrl(candidate, hash);
      if (!target) {
        lastReason = 'Peer endpoint blocked by tracker security policy.';
        continue;
      }
      try {
        const upstream = await fetch(target);
        if (!upstream.ok) {
          lastReason = `Peer responded ${upstream.status}, retrying.`;
          continue;
        }

        const contentType = upstream.headers.get('content-type') || 'text/html; charset=utf-8';
        const html = await upstream.text();
        return { status: 'ready', html, contentType, target, peerId: candidate.peerId };
      } catch {
        lastReason = 'Failed to reach active peer, retrying.';
      }
    }

    return { status: 'warming', reason: lastReason };
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
    this.app.use(express.json());

    this.app.post('/v1/peer/heartbeat', async (req, res) => {
      const rateKey = `heartbeat:${this.getClientIp(req)}`;
      if (!this.checkRateLimit(rateKey, 120, 60_000)) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
      }

      const payload = req.body as PeerHeartbeatPayload;
      if (!payload?.peerId || typeof payload.peerId !== 'string' || payload.peerId.length > 128) {
        return res.status(400).json({ error: 'Missing peerId' });
      }

      try {
        await this.store.processHeartbeat(payload);
        await this.store.generateAssignments(payload.peerId, 20, this.replicationTarget);
        await this.store.pruneStalePeers(5 * 60 * 1000);

        res.json({
          serverTime: Date.now(),
          nextHeartbeatSec: 60,
          assignmentEtag: crypto.randomUUID(),
        });
      } catch (err) {
        console.error('Heartbeat processing failed:', err);
        res.status(500).json({ error: 'Failed to process heartbeat' });
      }
    });

    this.app.get('/v1/peer/assignments', async (req, res) => {
      const peerId = String(req.query.peerId || '').trim();
      const rateKey = `assignments:${this.getClientIp(req)}`;
      if (!this.checkRateLimit(rateKey, 240, 60_000)) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
      }

      if (!peerId) {
        return res.status(400).json({ error: 'Missing peerId query param' });
      }

      try {
        const items = await this.store.getAssignments(peerId);
        res.json({
          etag: crypto.randomUUID(),
          generatedAt: Date.now(),
          items,
        });
      } catch (err) {
        console.error('Assignment read failed:', err);
        res.status(500).json({ error: 'Failed to get assignments' });
      }
    });

      // Top assignments bulletin board (pull-based self-assignment)
      this.app.get('/top-assignments', async (req, res) => {
        try {
          const items = await this.store.getTopAssignments(50, this.replicationTarget);
          res.json({
            timestamp: Date.now(),
            replicationTarget: this.replicationTarget,
            items,
          });
        } catch (err) {
          console.error('Top assignments fetch failed:', err);
          res.status(500).json({ error: 'Failed to get top assignments' });
        }
      });

    // Register/update peer
    this.app.post('/announce', async (req, res) => {
      const { peerId, host, port, publicBaseUrl, mappedPort, natType, reachable, relayRequired, endpoints, pages, pageSummaries, bytesUploaded, bytesDownloaded } = req.body;

      const rateKey = `announce:${this.getClientIp(req)}`;
      if (!this.checkRateLimit(rateKey, 120, 60_000)) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
      }

      const parsedPort = parseInt(String(port), 10);
      if (!peerId || typeof peerId !== 'string' || peerId.length > 128 || !host || typeof host !== 'string' || !parsedPort || parsedPort < 1 || parsedPort > 65535) {
        return res.status(400).json({ error: 'Missing peer info' });
      }

      const observedIp = this.extractObservedIp(req);
      const summaryList = Array.isArray(pageSummaries) ? pageSummaries : [];
      const pageTitles: Record<string, string> = {};
      const acceptedSummaryHashes = new Set<string>();
      for (const summary of summaryList) {
        if (!summary || typeof summary !== 'object') {
          continue;
        }

        const hash = typeof summary.hash === 'string' ? summary.hash : '';
        const title = this.sanitizeTitleInput(summary.title);
        if (!Tracker.isValidHash(hash) || !title) {
          continue;
        }

        const signerPeerId = typeof summary.signerPeerId === 'string' ? summary.signerPeerId : '';
        const signature = typeof summary.signature === 'string' ? summary.signature : '';
        const signerPublicKey = typeof summary.signerPublicKey === 'string' ? summary.signerPublicKey : '';
        const hasSignature = !!(signerPeerId && signature && signerPublicKey);

        if (this.requireSignedPages && !hasSignature) {
          continue;
        }

        if (hasSignature) {
          const verified = this.verifySummarySignature({
            hash,
            title,
            created: Number(summary.created) || 0,
            signerPeerId,
            signature,
            signerPublicKey,
          });
          if (!verified || signerPeerId !== peerId) {
            continue;
          }

          const firstSigner = this.firstSignerByHash.get(hash);
          if (!firstSigner) {
            this.firstSignerByHash.set(hash, signerPeerId);
          } else if (firstSigner !== signerPeerId) {
            continue;
          }
        }

        pageTitles[hash] = title;
        acceptedSummaryHashes.add(hash);
      }

      const announcedPages = Array.isArray(pages)
        ? pages.filter((pageHash) => Tracker.isValidHash(pageHash))
        : [];

      const filteredPages = this.requireSignedPages
        ? announcedPages.filter((pageHash) => acceptedSummaryHashes.has(pageHash))
        : announcedPages;

      const peer: TrackerEntry = {
        peerId,
        host,
        port: parsedPort,
        observedIp,
        publicBaseUrl: this.normalizePublicBaseUrl(publicBaseUrl),
        mappedPort: Number.isFinite(parseInt(String(mappedPort), 10)) ? parseInt(String(mappedPort), 10) : undefined,
        natType: typeof natType === 'string' ? natType.slice(0, 32) : undefined,
        reachable: typeof reachable === 'boolean' ? reachable : !!this.normalizePublicBaseUrl(publicBaseUrl),
        relayRequired: typeof relayRequired === 'boolean' ? relayRequired : false,
        endpoints: Array.isArray(endpoints)
          ? endpoints
            .filter((endpoint) => endpoint && typeof endpoint === 'object' && typeof endpoint.url === 'string')
            .slice(0, 10)
            .map((endpoint): PeerEndpoint => ({
              kind: endpoint.kind === 'public' ? 'public' : 'local',
              url: endpoint.kind === 'public' ? (this.normalizePublicBaseUrl(endpoint.url) || '') : String(endpoint.url),
              reachable: !!endpoint.reachable,
              source: endpoint.source === 'upnp' || endpoint.source === 'config' ? endpoint.source : 'local',
            }))
            .filter((endpoint) => endpoint.kind !== 'public' || !!endpoint.url)
          : [],
        pages: filteredPages,
        pageTitles,
        bytesUploaded: Math.max(0, Number(bytesUploaded) || 0),
        bytesDownloaded: Math.max(0, Number(bytesDownloaded) || 0),
        lastSeen: Date.now(),
      };

      this.peers.set(peerId, peer);
      void this.probePeer(peer);

      // Update page index
      for (const pageHash of filteredPages) {
        if (!this.pageIndex.has(pageHash)) {
          this.pageIndex.set(pageHash, new Set());
        }
        this.pageIndex.get(pageHash)!.add(peerId);
        try {
          await this.store.upsertSite(pageHash, 1, 0);
        } catch (err) {
          console.warn('Failed to persist site from announce:', pageHash, err);
        }
      }

      res.json({ success: true, peerId });
    });

    this.app.get('/discover', async (req, res) => {
      const rateKey = `discover:${this.getClientIp(req)}`;
      if (!this.checkRateLimit(rateKey, 240, 60_000)) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
      }

      const q = String(req.query.q || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || '25'), 10) || 25, 100));
      const now = Date.now();
      const siteHashes = Array.from(this.pageIndex.keys());
      const siteStats = await this.store.getSiteDeliveryStats(siteHashes);

      const items = siteHashes
        .map((hash) => {
          const activePeers = this.getActivePeersForHash(hash, 120_000);
          if (activePeers.length === 0) {
            return null;
          }

          const title = activePeers
            .map((peer) => peer.pageTitles?.[hash])
            .find((value): value is string => !!value) || `Untitled ${hash.slice(0, 12)}`;

          const latestSeen = activePeers.reduce((maxSeen, peer) => Math.max(maxSeen, peer.lastSeen), 0);
          return {
            hash,
            title,
            copies: activePeers.length,
            pageVisits: siteStats.get(hash)?.pageVisits || 0,
            latestSeen,
            url: `/${hash}`,
          };
        })
        .filter((item): item is { hash: string; title: string; copies: number; pageVisits: number; latestSeen: number; url: string } => !!item)
        .filter((item) => {
          if (!q) {
            return true;
          }

          return item.title.toLowerCase().includes(q) || item.hash.includes(q);
        })
        .sort((a, b) => {
          if (b.copies !== a.copies) {
            return b.copies - a.copies;
          }
          return b.latestSeen - a.latestSeen;
        })
        .slice(0, limit);

      res.json({
        generatedAt: now,
        count: items.length,
        items,
      });
    });

    // Query peers for a page
    this.app.get('/query/:hash', (req, res) => {
      const { hash } = req.params;
      if (!Tracker.isValidHash(hash)) {
        return res.status(400).json({ error: 'Invalid hash format' });
      }
      const peerList = this.getActivePeersForHash(hash);

      if (peerList.length === 0) {
        return res.status(404).json({ error: 'Page not found on network' });
      }

      res.json({ peers: peerList });
    });

    // Swarm-style peer discovery for a specific hash
    this.app.get('/v1/swarm/:hash/peers', (req, res) => {
      const { hash } = req.params;
      if (!Tracker.isValidHash(hash)) {
        return res.status(400).json({ error: 'Invalid hash format' });
      }
      const requesterPeerId = String(req.query.peerId || '').trim();
      const max = Math.max(1, Math.min(parseInt(String(req.query.max || '20'), 10) || 20, 100));

      const peers = this.pageIndex.get(hash);
      if (!peers || peers.size === 0) {
        return res.status(404).json({ error: 'No peers currently indexing this hash', peers: [] });
      }

      const now = Date.now();
      const items = Array.from(peers)
        .filter((peerId) => !requesterPeerId || peerId !== requesterPeerId)
        .map((peerId) => this.peers.get(peerId))
        .filter((p): p is TrackerEntry => !!p && now - p.lastSeen < 90_000)
        .sort((a, b) => {
          const reachA = a.reachable ? 1 : 0;
          const reachB = b.reachable ? 1 : 0;
          if (reachA !== reachB) {
            return reachB - reachA;
          }
          return b.lastSeen - a.lastSeen;
        })
        .slice(0, max)
        .map((p) => ({
          peerId: p.peerId,
          host: this.getDisplayHost(p),
          port: p.port,
          mappedPort: this.exposePeerNetworkDetails ? p.mappedPort : undefined,
          observedIp: this.exposePeerNetworkDetails ? p.observedIp : undefined,
          publicBaseUrl: this.exposePeerNetworkDetails ? p.publicBaseUrl : undefined,
          natType: p.natType || 'unknown',
          reachable: !!p.reachable,
          relayRequired: !!p.relayRequired,
          endpoints: this.exposePeerNetworkDetails ? (p.endpoints || []) : undefined,
          lastSeen: p.lastSeen,
          pageUrl: this.buildPeerPageUrl(p, hash),
        }));

      res.json({
        hash,
        count: items.length,
        generatedAt: now,
        peers: items,
      });
    });

    // Get leaderboard for today
    this.app.get('/leaderboard', async (req, res) => {
      const now = Date.now();
      const today = new Date().toDateString();
      const peerEntries = Array.from(this.peers.values())
        .filter((p) => new Date(p.lastSeen).toDateString() === today);
      const peerStats = await this.store.getPeerDeliveryStats(peerEntries.map((peer) => peer.peerId));

      const leaderboard = peerEntries
        .sort((a, b) => b.bytesUploaded - a.bytesUploaded)
        .map((p, rank) => ({
          rank: rank + 1,
          peerId: p.peerId,
          host: this.getDisplayHost(p),
          port: p.port,
          bytesUploaded: p.bytesUploaded,
          bytesDownloaded: p.bytesDownloaded,
          pagesServed: peerStats.get(p.peerId)?.pageServes || 0,
          ratio: p.bytesUploaded / Math.max(p.bytesDownloaded, 1),
          pages: p.pages.length,
        }))
        .slice(0, 100);

      res.json({ leaderboard, timestamp: now });
    });

    // Public tracker dashboard (one-server one-page landing)
    this.app.get('/', async (req, res) => {
      const today = new Date().toDateString();
      const leaderboardPeers = Array.from(this.peers.values())
        .filter((p) => new Date(p.lastSeen).toDateString() === today);
      const peerStats = await this.store.getPeerDeliveryStats(leaderboardPeers.map((peer) => peer.peerId));
      const siteHashes = Array.from(this.pageIndex.keys());
      const siteStats = await this.store.getSiteDeliveryStats(siteHashes);

      const leaderboard = leaderboardPeers
        .sort((a, b) => b.bytesUploaded - a.bytesUploaded)
        .slice(0, 20);

      const topPages = siteHashes
        .map((hash) => {
          const peers = this.getActivePeersForHash(hash);
          const title = peers
            .map((peer) => peer.pageTitles?.[hash])
            .find((value): value is string => !!value) || `Untitled ${hash.slice(0, 12)}`;
          return {
            hash,
            title,
            copies: peers.length,
            pageVisits: siteStats.get(hash)?.pageVisits || 0,
          };
        })
        .filter((page) => page.copies > 0)
        .sort((a, b) => {
          if (b.pageVisits !== a.pageVisits) {
            return b.pageVisits - a.pageVisits;
          }
          return b.copies - a.copies;
        })
        .slice(0, 50);

      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>PubWeb Tracker</title>
  <style>body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:20px;}h1,h2{margin-bottom:0.25rem}table{border-collapse:collapse;width:100%;max-width:900px;}th,td{border:1px solid #ccc;padding:6px;text-align:left;}a{color:#0366d6;text-decoration:none;}.onboard{display:inline-block;margin:10px 0 18px;padding:10px 14px;border:1px solid #2b6de5;border-radius:999px;background:#eef4ff;color:#0f4dc4;font-weight:600}</style>
</head>
<body>
  <h1>PubWeb Tracker</h1>
  <p>Live peers and page index (one-server / one-page test)</p>
  <p><a class="onboard" href="/${this.onboardingHash}">Start here: Make your own page (download + publish loop)</a></p>

  <h2>Top peers (by upload bytes today)</h2>
  <table>
    <tr><th>#</th><th>peerId</th><th>host:port</th><th>uploaded</th><th>downloaded</th><th>pages served</th><th>pages</th></tr>
    ${leaderboard
      .map(
        (p, i) =>
          `<tr><td>${i + 1}</td><td>${this.escapeHtml(p.peerId)}</td><td>${this.escapeHtml(this.getDisplayHost(p))}:${p.mappedPort || p.port}</td><td>${p.bytesUploaded}</td><td>${p.bytesDownloaded}</td><td>${peerStats.get(p.peerId)?.pageServes || 0}</td><td>${p.pages.length}</td></tr>`
      )
      .join('')}
  </table>

  <h2>Top page hashes</h2>
  <table>
    <tr><th>#</th><th>title</th><th>hash</th><th>copies</th><th>page visits</th><th>view</th></tr>
    ${topPages
      .map(
        (p, i) =>
          `<tr><td>${i + 1}</td><td>${this.escapeHtml(p.title)}</td><td><code>${p.hash}</code></td><td>${p.copies}</td><td>${p.pageVisits}</td><td><a href="/${p.hash}">open</a></td></tr>`
      )
      .join('')}
  </table>

</body>
</html>`;

      res.send(html);
    });

    // Fetch from a peer and return content directly (works behind cPanel routing)
    this.app.get('/page/:hash', async (req, res) => {
      const { hash } = req.params;
      if (!Tracker.isValidHash(hash)) {
        return res.status(400).json({ error: 'Invalid hash format' });
      }
      const resolved = await this.resolvePage(hash);
      if (resolved.status === 'ready') {
        await this.store.recordServe(resolved.peerId, hash, Buffer.byteLength(resolved.html));
        return res
          .status(200)
          .set('content-type', resolved.contentType)
          .set('x-pubweb-cache', 'WARMING')
          .send(resolved.html);
      }

      if (resolved.status === 'missing') {
        return res.status(404).json({ error: resolved.reason });
      }

      return res.status(202).json({ error: resolved.reason });
    });

    this.app.get('/resolve/:hash', async (req, res) => {
      const { hash } = req.params;
      if (!Tracker.isValidHash(hash)) {
        return res.status(400).json({ status: 'missing', reason: 'Invalid hash format' });
      }
      const resolved = await this.resolvePage(hash);

      if (resolved.status === 'ready') {
        return res.json({ status: 'ready' });
      }

      if (resolved.status === 'missing') {
        return res.status(404).json({ status: 'missing', reason: resolved.reason });
      }

      return res.status(202).json({ status: 'warming', reason: resolved.reason });
    });

    this.app.get('/:hash([a-fA-F0-9]{64})', (req, res) => {
      const { hash } = req.params;
      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline' 'self'; script-src 'unsafe-inline' 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'" />
  <title>PubWeb Loading ${hash.slice(0, 12)}...</title>
  <style>
    html, body { height: 100%; }
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #0b1220; color: #dbe7ff; }
    .shell { height: 100%; min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; }
    .top { padding: 14px 16px; border-bottom: 1px solid #1f2a44; background: #111a2f; }
    .title { font-size: 14px; opacity: .9; }
    .meta { font-size: 12px; opacity: .75; margin-top: 4px; word-break: break-all; }
    .status { padding: 16px; font-size: 14px; }
    .frame-wrap { flex: 1 1 auto; min-height: 0; display: none; }
    iframe { width: 100%; height: 100%; min-height: 0; border: 0; background: white; }
    .dot::after { content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-left: 6px; background: #7aa2ff; animation: pulse 1s infinite ease-in-out; }
    @keyframes pulse { 0%{opacity:.3} 50%{opacity:1} 100%{opacity:.3} }
  </style>
</head>
<body>
  <div class="shell">
    <div class="top">
      <div class="title">PubWeb wrapper</div>
      <div class="meta">Hash: ${hash}</div>
      <div class="meta">Wrapper version: ${this.escapeHtml(this.wrapperVersion)}</div>
    </div>
    <div class="status" id="statusText">Locating content across the network<span class="dot"></span></div>
    <div class="frame-wrap" id="frameWrap">
      <iframe id="siteFrame" title="PubWeb Site" sandbox="allow-scripts allow-same-origin"></iframe>
    </div>
  </div>
  <script>
    const hash = ${JSON.stringify(hash)};
    const wrapperVersion = ${JSON.stringify(this.wrapperVersion)};
    const statusText = document.getElementById('statusText');
    const frameWrap = document.getElementById('frameWrap');
    const frame = document.getElementById('siteFrame');
    window.__pubwebWrapperVersion = wrapperVersion;

    function installExternalLinkEscape() {
      let frameDoc;
      try {
        frameDoc = frame.contentDocument;
      } catch (err) {
        return;
      }

      if (!frameDoc) {
        return;
      }

      function markExternalLinks() {
        const links = frameDoc.querySelectorAll('a[href]');
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          if (!href || href.startsWith('#')) {
            continue;
          }

          let destination;
          try {
            destination = new URL(link.href, frame.contentWindow ? frame.contentWindow.location.href : window.location.href);
          } catch (err) {
            continue;
          }

          if ((destination.protocol === 'http:' || destination.protocol === 'https:') && destination.origin !== window.location.origin) {
            link.setAttribute('target', '_top');
            link.setAttribute('rel', 'noopener noreferrer external');
          }
        }
      }

      markExternalLinks();

      const observer = new MutationObserver(() => {
        markExternalLinks();
      });
      observer.observe(frameDoc.documentElement, { childList: true, subtree: true });

      frameDoc.addEventListener('click', (event) => {
        const rawTarget = event.target;
        const target = rawTarget instanceof Element ? rawTarget : rawTarget && rawTarget.parentElement;
        if (!target) {
          return;
        }

        const link = target.closest('a[href]');
        if (!link) {
          return;
        }

        const href = link.getAttribute('href') || '';
        if (!href || href.startsWith('#')) {
          return;
        }

        let destination;
        try {
          destination = new URL(link.href, frame.contentWindow ? frame.contentWindow.location.href : window.location.href);
        } catch (err) {
          return;
        }

        if (destination.origin === window.location.origin) {
          return;
        }

        if (destination.protocol !== 'http:' && destination.protocol !== 'https:') {
          return;
        }

        event.preventDefault();
        window.top.location.assign(destination.toString());
      }, true);

      frame.addEventListener('load', () => {
        observer.disconnect();
      }, { once: true });
    }

    frame.addEventListener('load', installExternalLinkEscape);

    async function checkReady() {
      try {
        const res = await fetch('/resolve/' + hash, { cache: 'no-store' });
        if (res.ok) {
          statusText.style.display = 'none';
          frameWrap.style.display = 'flex';
          frame.src = '/page/' + hash;
          return;
        }

        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          statusText.textContent = data.reason || 'This hash is not currently available.';
          return;
        }

        statusText.textContent = data.reason || 'Still warming content from network peers...';
      } catch (err) {
        statusText.textContent = 'Network check failed, retrying shortly...';
      }

      setTimeout(checkReady, 3000);
    }

    checkReady();
  </script>
</body>
</html>`;

      res.status(200)
        .set('content-type', 'text/html; charset=utf-8')
        .set('cache-control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0')
        .set('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline' 'self'; script-src 'unsafe-inline' 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'")
        .set('pragma', 'no-cache')
        .set('expires', '0')
        .set('x-pubweb-wrapper-version', this.wrapperVersion)
        .send(html);
    });

    // Get all peers
    this.app.get('/peers', (req, res) => {
      const activePeers = Array.from(this.peers.values()).filter(
        (p) => Date.now() - p.lastSeen < 60000
      );

      res.json({
        count: activePeers.length,
        peers: activePeers.map((p) => ({
          peerId: p.peerId,
          host: this.getDisplayHost(p),
          port: p.port,
          mappedPort: this.exposePeerNetworkDetails ? p.mappedPort : undefined,
          observedIp: this.exposePeerNetworkDetails ? p.observedIp : undefined,
          publicBaseUrl: this.exposePeerNetworkDetails ? p.publicBaseUrl : undefined,
          natType: p.natType || 'unknown',
          reachable: !!p.reachable,
          relayRequired: !!p.relayRequired,
          endpoints: this.exposePeerNetworkDetails ? (p.endpoints || []) : undefined,
          pages: p.pages.length,
        })),
      });
    });

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });
  }

  async start(port: number = 4000): Promise<void> {
    await this.store.init();
    return new Promise((resolve, reject) => {
      this.httpServer = this.app.listen(port, () => {
        console.log(`Tracker listening on port ${port}`);
        resolve();
      });

      this.httpServer.once('error', (error) => {
        this.httpServer = null;
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.httpServer) {
      return;
    }

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

// Main
const tracker = new Tracker();
console.log('Starting tracker...');
tracker.start(parseInt(process.env.PORT || process.env.TRACKER_PORT || '4000')).then(() => {
  console.log('Tracker started successfully');
}).catch(err => {
  console.error('Tracker failed to start:', err);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}, shutting down tracker...`);

  try {
    await tracker.stop();
    console.log('Tracker shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('Tracker shutdown failed:', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

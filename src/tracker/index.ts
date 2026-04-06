import express, { Request } from 'express';
import crypto from 'crypto';
import { Server } from 'http';
import path from 'path';
import QRCode from 'qrcode';
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
  pageModes: Record<string, 'public' | 'unlisted' | 'private-link' | 'expires'>;
  pageDiscoverable: Record<string, boolean>;
  pageExpiresAt: Record<string, number | undefined>;
  bytesUploaded: number;
  bytesDownloaded: number;
  lastSeen: number;
}

type ShareMode = 'public' | 'unlisted' | 'private-link' | 'expires';

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

  private normalizeShareMode(value: unknown): ShareMode {
    return value === 'unlisted' || value === 'private-link' || value === 'expires' ? value : 'public';
  }

  private normalizeExpiresAt(value: unknown): number | undefined {
    const parsed = typeof value === 'number' ? value : parseInt(String(value || ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return undefined;
    }
    return parsed;
  }

  private isExpired(peer: TrackerEntry, hash: string, now: number = Date.now()): boolean {
    const expiresAt = peer.pageExpiresAt[hash];
    return typeof expiresAt === 'number' && expiresAt > 0 && expiresAt <= now;
  }

  private isDiscoverable(peer: TrackerEntry, hash: string, now: number = Date.now()): boolean {
    if (this.isExpired(peer, hash, now)) {
      return false;
    }

    if (peer.pageDiscoverable[hash] === false) {
      return false;
    }

    const mode = peer.pageModes[hash] || 'public';
    return mode !== 'private-link' && mode !== 'unlisted';
  }

  private getFirstModeForHash(hash: string, peers?: TrackerEntry[]): ShareMode {
    const activePeers = peers || this.getActivePeersForHash(hash, 120_000);
    let sawExpires = false;

    for (const peer of activePeers) {
      const mode = peer.pageModes[hash];
      if (!mode) {
        continue;
      }

      if (mode === 'private-link' || mode === 'unlisted') {
        return mode;
      }

      if (mode === 'expires') {
        sawExpires = true;
      }
    }

    if (sawExpires) {
      return 'expires';
    }

    for (const peer of activePeers) {
      const mode = peer.pageModes[hash];
      if (mode) {
        return mode;
      }
    }

    return 'public';
  }

  private isHashDiscoverable(hash: string, activePeers: TrackerEntry[], now: number = Date.now()): boolean {
    let sawExplicitMetadata = false;

    for (const peer of activePeers) {
      if (this.isExpired(peer, hash, now)) {
        return false;
      }

      const hasMode = typeof peer.pageModes[hash] === 'string';
      const hasDiscoverable = typeof peer.pageDiscoverable[hash] === 'boolean';
      const hasExpiresAt = typeof peer.pageExpiresAt[hash] === 'number';
      if (hasMode || hasDiscoverable || hasExpiresAt) {
        sawExplicitMetadata = true;
      }

      if (peer.pageDiscoverable[hash] === false) {
        return false;
      }

      const mode = peer.pageModes[hash];
      if (mode === 'private-link' || mode === 'unlisted') {
        return false;
      }
    }

    // Legacy peers may omit privacy metadata; keep them discoverable by default.
    return sawExplicitMetadata || activePeers.length > 0;
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

  private isSmokeTitle(title: string): boolean {
    return String(title || '').toLowerCase().startsWith('pubweb smoke');
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
      .filter((peer) => !this.isExpired(peer, hash))
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
      .filter((peer): peer is TrackerEntry => !!peer && peer.lastSeen >= cutoff && peer.pages.includes(hash));
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

  private buildPeerPublishUrl(peer: TrackerEntry): string {
    const publicEndpoint = (peer.endpoints || []).find((endpoint) => endpoint.kind === 'public' && endpoint.reachable);
    if (publicEndpoint) {
      const normalized = this.normalizePublicBaseUrl(publicEndpoint.url);
      if (normalized) {
        return `${normalized}/publish`;
      }
    }

    if (peer.publicBaseUrl) {
      const normalized = this.normalizePublicBaseUrl(peer.publicBaseUrl);
      if (normalized) {
        return `${normalized}/publish`;
      }
    }

    if (this.isPrivateOrLoopbackHost(this.getFetchHost(peer))) {
      return '';
    }

    return `http://${this.getFetchHost(peer)}:${peer.port}/publish`;
  }

  private getPublishCandidates(maxAgeMs: number = 90_000): TrackerEntry[] {
    const cutoff = Date.now() - maxAgeMs;
    return Array.from(this.peers.values())
      .filter((peer) => peer.lastSeen >= cutoff)
      .sort((a, b) => {
        const aReach = a.reachable ? 1 : 0;
        const bReach = b.reachable ? 1 : 0;
        if (bReach !== aReach) {
          return bReach - aReach;
        }

        const aPublic = this.buildPeerPublishUrl(a) ? 1 : 0;
        const bPublic = this.buildPeerPublishUrl(b) ? 1 : 0;
        if (bPublic !== aPublic) {
          return bPublic - aPublic;
        }

        return b.lastSeen - a.lastSeen;
      });
  }

  private async resolvePage(hash: string): Promise<
    | { status: 'ready'; html: string; contentType: string; target: string; peerId: string }
    | { status: 'warming'; reason: string }
    | { status: 'missing'; reason: string }
    | { status: 'expired'; reason: string }
  > {
    const candidates = this.getResolveCandidates(hash);
    if (candidates.length === 0) {
      const known = this.pageIndex.has(hash);
      if (known) {
        const activePeers = this.getActivePeersForHash(hash, 120_000);
        const hasOnlyExpired = activePeers.length > 0 && activePeers.every((peer) => this.isExpired(peer, hash));
        if (hasOnlyExpired) {
          return { status: 'expired', reason: 'Page expired on official network.' };
        }
      }
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
    this.app.use(express.json({ limit: '2mb' }));

    this.app.get('/qr/:hash.svg', async (req, res) => {
      const { hash } = req.params;
      if (!Tracker.isValidHash(hash)) {
        return res.status(400).json({ error: 'Invalid hash format' });
      }

      const requestedSize = parseInt(String(req.query.size || '260'), 10);
      const size = Number.isFinite(requestedSize)
        ? Math.max(120, Math.min(requestedSize, 1024))
        : 260;
      const rawKey = typeof req.query.k === 'string' ? req.query.k : '';
      const fragmentKey = /^[A-Za-z0-9_-]{8,256}$/.test(rawKey) ? rawKey : '';
      const targetUrl = `${req.protocol}://${req.get('host')}/${hash}${fragmentKey ? `#k=${fragmentKey}` : ''}`;

      try {
        const svg = await QRCode.toString(targetUrl, {
          type: 'svg',
          margin: 1,
          width: size,
          errorCorrectionLevel: 'M',
        });

        return res.status(200)
          .set('content-type', 'image/svg+xml; charset=utf-8')
          .set('cache-control', 'public, max-age=86400')
          .send(svg);
      } catch (err) {
        console.error('QR generation failed:', err);
        return res.status(500).json({ error: 'Failed to generate QR code' });
      }
    });

    this.app.get('/share-image', (req, res) => {
      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PubWeb Share Image</title>
  <style>
    :root {
      --bg: #f8f7f3;
      --card: #fffdf7;
      --ink: #1f1a17;
      --muted: #6e655d;
      --accent: #a33f2f;
      --accent-soft: #f4ddd7;
      --line: #e7dcd3;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      color: var(--ink);
      background: radial-gradient(1200px 400px at 50% -10%, #fff4e8, var(--bg));
      min-height: 100vh;
    }
    .wrap { max-width: 720px; margin: 0 auto; padding: 20px 14px 36px; }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 8px 30px rgba(64, 36, 18, 0.06);
    }
    h1 { margin: 0 0 8px; font-size: 24px; }
    .sub { margin: 0 0 16px; color: var(--muted); font-size: 14px; }
    .row { display: grid; grid-template-columns: 1fr; gap: 10px; margin-bottom: 10px; }
    label { font-size: 13px; font-weight: 600; }
    input, select, textarea, button {
      width: 100%;
      font: inherit;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: #fff;
    }
    textarea { min-height: 68px; resize: vertical; }
    .inline { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .small { font-size: 12px; color: var(--muted); margin: 4px 0 0; }
    .btn {
      border: 0;
      background: linear-gradient(120deg, #b24837, var(--accent));
      color: #fff;
      font-weight: 700;
      margin-top: 8px;
    }
    .preview { margin-top: 12px; display: none; }
    .preview img { width: 100%; border-radius: 10px; border: 1px solid var(--line); }
    .status { margin-top: 10px; font-size: 13px; color: var(--muted); }
    .success { margin-top: 14px; padding: 12px; border-radius: 12px; border: 1px solid #cae6c9; background: #f1fff0; display: none; }
    .success a { word-break: break-all; }
    .qr { margin-top: 10px; text-align: center; }
    .qr img { width: 180px; height: 180px; border: 1px solid var(--line); border-radius: 10px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Share image</h1>
      <p class="sub">Phone friendly uploader. Low-res by default on purpose.</p>

      <div class="row">
        <label for="fileInput">Image</label>
        <input id="fileInput" type="file" accept="image/*" />
      </div>

      <div class="inline">
        <div class="row">
          <label for="titleInput">Title</label>
          <input id="titleInput" type="text" maxlength="120" placeholder="Evening walk" />
        </div>
        <div class="row">
          <label for="modeInput">Mode</label>
          <select id="modeInput">
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
            <option value="private-link">Private Link</option>
            <option value="expires">Expires</option>
          </select>
        </div>
      </div>

      <div class="row">
        <label for="captionInput">Caption (optional)</label>
        <textarea id="captionInput" maxlength="240" placeholder="Tiny pictures, big vibes."></textarea>
      </div>

      <div class="inline">
        <div class="row">
          <label for="qualityInput">Preset</label>
          <select id="qualityInput">
            <option value="tiny">Tiny</option>
            <option value="balanced" selected>Balanced</option>
            <option value="clear">Clear</option>
          </select>
          <p class="small">Balanced default aims for phone-friendly size.</p>
        </div>
        <div class="row" id="expiresWrap" style="display:none;">
          <label for="expiresInput">Expires</label>
          <input id="expiresInput" type="datetime-local" />
        </div>
      </div>

      <button class="btn" id="publishBtn" type="button">Publish image</button>
      <p class="status" id="status">Select an image to begin.</p>

      <div class="preview" id="previewWrap">
        <img id="previewImg" alt="Preview" />
      </div>

      <div class="success" id="successBox">
        <strong>Published.</strong>
        <div style="margin-top:8px;"><a id="shareLink" href="#" target="_blank" rel="noopener noreferrer"></a></div>
        <div class="qr"><img id="qrImg" alt="Share QR code" /></div>
      </div>
    </div>
  </div>

  <script>
    const fileInput = document.getElementById('fileInput');
    const titleInput = document.getElementById('titleInput');
    const modeInput = document.getElementById('modeInput');
    const captionInput = document.getElementById('captionInput');
    const qualityInput = document.getElementById('qualityInput');
    const expiresWrap = document.getElementById('expiresWrap');
    const expiresInput = document.getElementById('expiresInput');
    const publishBtn = document.getElementById('publishBtn');
    const statusEl = document.getElementById('status');
    const previewWrap = document.getElementById('previewWrap');
    const previewImg = document.getElementById('previewImg');
    const successBox = document.getElementById('successBox');
    const shareLink = document.getElementById('shareLink');
    const qrImg = document.getElementById('qrImg');
    const MAX_PRIVATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

    function formatDateTimeLocal(ms) {
      const dt = new Date(ms);
      const year = dt.getFullYear();
      const month = String(dt.getMonth() + 1).padStart(2, '0');
      const day = String(dt.getDate()).padStart(2, '0');
      const hour = String(dt.getHours()).padStart(2, '0');
      const minute = String(dt.getMinutes()).padStart(2, '0');
      return year + '-' + month + '-' + day + 'T' + hour + ':' + minute;
    }

    function applyExpiryBounds() {
      const now = Date.now();
      expiresInput.min = formatDateTimeLocal(now + 60_000);
      expiresInput.max = formatDateTimeLocal(now + MAX_PRIVATE_TTL_MS);
    }

    function validateExpirySelection() {
      if (modeInput.value !== 'expires' || !expiresInput.value) {
        return true;
      }

      const now = Date.now();
      const parsed = new Date(expiresInput.value).getTime();
      const maxAllowed = now + MAX_PRIVATE_TTL_MS;
      if (!Number.isFinite(parsed) || parsed <= now) {
        statusEl.textContent = 'Expiry must be in the future.';
        return false;
      }
      if (parsed > maxAllowed) {
        statusEl.textContent = 'Expiry cannot be more than 7 days in the future.';
        return false;
      }
      return true;
    }

    modeInput.addEventListener('change', () => {
      expiresWrap.style.display = modeInput.value === 'expires' ? 'block' : 'none';
      applyExpiryBounds();
    });

    expiresInput.addEventListener('change', validateExpirySelection);
    applyExpiryBounds();

    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        previewWrap.style.display = 'none';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        previewImg.src = String(reader.result || '');
        previewWrap.style.display = 'block';
      };
      reader.readAsDataURL(file);
    });

    function presetConfig(preset) {
      if (preset === 'tiny') {
        return { maxDim: 900, quality: 0.46 };
      }
      if (preset === 'clear') {
        return { maxDim: 1400, quality: 0.7 };
      }
      return { maxDim: 1200, quality: 0.58 };
    }

    async function fileToCompressedDataUrl(file, preset) {
      const cfg = presetConfig(preset);
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, cfg.maxDim / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, width, height);

      let quality = cfg.quality;
      let out = canvas.toDataURL('image/jpeg', quality);
      let bytes = Math.floor((out.length * 3) / 4);
      while (bytes > 230000 && quality > 0.34) {
        quality -= 0.05;
        out = canvas.toDataURL('image/jpeg', quality);
        bytes = Math.floor((out.length * 3) / 4);
      }

      return { dataUrl: out, width, height, bytes, mimeType: 'image/jpeg' };
    }

    function toBase64Url(bytes) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      let out = '';
      for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i];
        const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
        const chunk = (a << 16) | (b << 8) | c;
        out += chars[(chunk >> 18) & 63];
        out += chars[(chunk >> 12) & 63];
        out += i + 1 < bytes.length ? chars[(chunk >> 6) & 63] : '';
        out += i + 2 < bytes.length ? chars[chunk & 63] : '';
      }
      return out;
    }

    async function encryptPayloadText(plainText) {
      const encoder = new TextEncoder();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const keyBytes = crypto.getRandomValues(new Uint8Array(32));
      const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
      const cipherBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(String(plainText || '')));
      const cipherBytes = new Uint8Array(cipherBuffer);
      return {
        iv: toBase64Url(iv),
        cipher: toBase64Url(cipherBytes),
        key: toBase64Url(keyBytes),
      };
    }

    function buildImagePageHtml(title, caption, pageData) {
      const safeTitle = (title || 'PubWeb Image').replace(/[<>]/g, '');
      const safeCaption = (caption || '').replace(/[<>]/g, '');
      const captionHtml = safeCaption ? '<div class="cap">' + safeCaption + '</div>' : '';
      const isEncrypted = !!(pageData && pageData.cipher && pageData.iv);
      const imageMarkup = isEncrypted
        ? '<div class="locked" id="lockedBox">Private link required. Open with full link containing #k=...</div><img class="main" id="mainImage" alt="Shared image" style="display:none;" />'
        : '<img class="main" src="' + pageData.dataUrl + '" alt="Shared image" />';
      const titleMarkup = isEncrypted
        ? '<div class="t" id="titleText">Private image</div>'
        : '<div class="t">' + safeTitle + '</div>';
      const extraCaptionMarkup = isEncrypted
        ? '<div class="cap" id="captionBox" style="display:none;"></div>'
        : captionHtml;
      const decryptScript = isEncrypted
        ? '<script>' +
          'const ivB64=' + JSON.stringify(pageData.iv) + ';' +
          'const cipherB64=' + JSON.stringify(pageData.cipher) + ';' +
          'const keyParam=(new URLSearchParams((location.hash||"#").slice(1))).get("k")||"";' +
          'const lock=document.getElementById("lockedBox");const img=document.getElementById("mainImage");const titleNode=document.getElementById("titleText");const captionNode=document.getElementById("captionBox");' +
          'function fromB64Url(s){const chars="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";let bits=0,v=0,o=[];for(let i=0;i<s.length;i++){const idx=chars.indexOf(s[i]);if(idx<0)continue;v=(v<<6)|idx;bits+=6;if(bits>=8){bits-=8;o.push((v>>bits)&255);}}return new Uint8Array(o);}' +
          'async function decrypt(){if(!keyParam){return;}try{const keyBytes=fromB64Url(keyParam);const iv=fromB64Url(ivB64);const data=fromB64Url(cipherB64);const key=await crypto.subtle.importKey("raw",keyBytes,"AES-GCM",false,["decrypt"]);const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv},key,data);const text=new TextDecoder().decode(plain);let parsed=null;try{parsed=JSON.parse(text);}catch(_e){}const imageData=(parsed&&parsed.dataUrl)?parsed.dataUrl:text;if(parsed&&parsed.title&&titleNode){titleNode.textContent=String(parsed.title).slice(0,120);}if(parsed&&parsed.caption&&captionNode){captionNode.textContent=String(parsed.caption).slice(0,240);captionNode.style.display="block";}img.src=imageData;img.style.display="block";if(lock)lock.style.display="none";}catch(e){if(lock)lock.textContent="Unable to decrypt. Verify you opened the full private link.";}}decrypt();' +
          '<' + '/script>'
        : '';
      return '<!doctype html>' +
        '<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />' +
        '<title>' + safeTitle + '</title>' +
        '<style>' +
        'body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#171312;color:#f8efe8;}' +
        '.top{position:sticky;top:0;z-index:2;background:#201916d9;backdrop-filter:blur(8px);padding:10px 12px;border-bottom:1px solid #3c302a;}' +
        '.top-row{display:flex;justify-content:space-between;align-items:center;gap:10px;}' +
        '.t{font-size:14px;font-weight:700;}' +
        '.pubweb-link{font-size:12px;color:#ffd6bd;text-decoration:none;border:1px solid #6b5244;border-radius:999px;padding:5px 9px;background:#2a1f1a;white-space:nowrap;font-weight:700;}' +
        '.pic-wrap{padding:10px;display:flex;justify-content:center;align-items:center;}' +
        'img.main{max-width:100%;max-height:78vh;border-radius:10px;box-shadow:0 8px 26px rgba(0,0,0,.32);}' +
        '.locked{padding:16px;border:1px dashed #7b5f51;border-radius:10px;color:#e9cec0;background:#2a1d18;font-size:13px;}' +
        '.cap{padding:0 12px 14px;color:#d8cbc2;font-size:13px;}' +
        '</style></head><body>' +
        '<div class="top"><div class="top-row">' + titleMarkup + '<a class="pubweb-link" href="https://pubweb.online/">PubWeb</a></div></div>' +
        '<div class="pic-wrap">' + imageMarkup + '</div>' +
        extraCaptionMarkup +
        decryptScript +
        '</body></html>';
    }

    async function publish() {
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        statusEl.textContent = 'Choose an image first.';
        return;
      }

      publishBtn.disabled = true;
      statusEl.textContent = 'Compressing image...';
      successBox.style.display = 'none';

      try {
        const mode = modeInput.value;
        if (!validateExpirySelection()) {
          return;
        }
        const rawTitle = titleInput.value.trim() || 'Shared image';
        const rawCaption = captionInput.value.trim();
        const compressed = await fileToCompressedDataUrl(file, qualityInput.value);
        const needsPrivatePayload = mode === 'private-link' || mode === 'expires';
        const encryptedPayload = needsPrivatePayload
          ? await encryptPayloadText(JSON.stringify({
            title: rawTitle,
            caption: rawCaption,
            dataUrl: compressed.dataUrl,
          }))
          : null;
        const pageData = encryptedPayload
          ? { cipher: encryptedPayload.cipher, iv: encryptedPayload.iv }
          : { dataUrl: compressed.dataUrl };
        const html = buildImagePageHtml(rawTitle, rawCaption, pageData);
        const payload = {
          html,
          title: needsPrivatePayload ? 'Private image' : rawTitle,
          tags: ['image', 'mobile'],
          shareMode: mode,
          contentKind: 'image-page',
          mimeType: compressed.mimeType,
          mediaWidth: compressed.width,
          mediaHeight: compressed.height,
          discoverable: mode === 'public',
          isEncrypted: mode === 'private-link' || mode === 'expires',
          expiresAt: mode === 'expires' && expiresInput.value ? new Date(expiresInput.value).getTime() : undefined,
        };

        statusEl.textContent = 'Publishing to PubWeb...';
        const response = await fetch('/v1/publish', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.hash) {
          throw new Error(result.error || ('Publish failed (' + response.status + ')'));
        }

        const fragment = encryptedPayload ? '#k=' + encryptedPayload.key : '';
        const finalUrl = location.origin + '/' + result.hash + fragment;
        shareLink.href = finalUrl;
        shareLink.textContent = finalUrl;
        qrImg.src = '/qr/' + result.hash + '.svg?size=240' + (encryptedPayload ? '&k=' + encodeURIComponent(encryptedPayload.key) : '');
        successBox.style.display = 'block';
        const effectiveExpiresAt = Number(result.effectiveExpiresAt || result.expiresAt || 0);
        const expiryLabel = Number.isFinite(effectiveExpiresAt) && effectiveExpiresAt > 0
          ? ' Expires ' + new Date(effectiveExpiresAt).toLocaleString() + '.'
          : '';
        statusEl.textContent = 'Published. Share the link or scan the QR.' + expiryLabel;
      } catch (err) {
        statusEl.textContent = String(err && err.message ? err.message : err);
      } finally {
        publishBtn.disabled = false;
      }
    }

    publishBtn.addEventListener('click', publish);
  </script>
</body>
</html>`;

      res.status(200)
        .set('content-type', 'text/html; charset=utf-8')
        .set('cache-control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0')
        .send(html);
    });

    this.app.post('/v1/publish', async (req, res) => {
      const rateKey = `publish-proxy:${this.getClientIp(req)}`;
      if (!this.checkRateLimit(rateKey, 20, 60_000)) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
      }

      const { html } = req.body || {};
      if (typeof html !== 'string' || !html.trim()) {
        return res.status(400).json({ error: 'Missing HTML' });
      }

      const candidates = this.getPublishCandidates();
      if (candidates.length === 0) {
        return res.status(503).json({ error: 'No active publish peers available' });
      }

      let lastError = 'No publish peer accepted request';
      for (const peer of candidates) {
        const target = this.buildPeerPublishUrl(peer);
        if (!target) {
          continue;
        }

        try {
          const upstream = await fetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(req.body || {}),
          });

          const payload = await upstream.json().catch(() => ({})) as Record<string, unknown>;
          if (!upstream.ok) {
            const errorMessage = typeof payload.error === 'string' ? payload.error : '';
            lastError = errorMessage || `Peer publish failed (${upstream.status})`;
            continue;
          }

          const hash = typeof payload.hash === 'string' ? payload.hash : '';
          if (!Tracker.isValidHash(hash)) {
            lastError = 'Peer returned invalid hash';
            continue;
          }

          return res.json({
            ...payload,
            shareUrl: `${req.protocol}://${req.get('host')}/${hash}`,
          });
        } catch (err) {
          lastError = String(err || lastError);
        }
      }

      return res.status(502).json({ error: lastError });
    });

    this.app.post('/v1/purge-smoke', async (req, res) => {
      const rateKey = `purge-proxy:${this.getClientIp(req)}`;
      if (!this.checkRateLimit(rateKey, 30, 60_000)) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
      }

      const candidates = this.getPublishCandidates();
      if (candidates.length === 0) {
        return res.status(503).json({ error: 'No active publish peers available' });
      }

      let lastError = 'No publish peer accepted purge request';
      for (const peer of candidates) {
        const publishTarget = this.buildPeerPublishUrl(peer);
        if (!publishTarget) {
          continue;
        }

        const target = publishTarget.replace(/\/publish$/, '/admin/purge-smoke');

        try {
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          const authHeader = req.get('authorization');
          const adminTokenHeader = req.get('x-admin-token');
          if (authHeader) {
            headers.authorization = authHeader;
          }
          if (adminTokenHeader) {
            headers['x-admin-token'] = adminTokenHeader;
          }

          const upstream = await fetch(target, {
            method: 'POST',
            headers,
            body: JSON.stringify(req.body || {}),
          });

          const payload = await upstream.json().catch(() => ({})) as Record<string, unknown>;
          if (!upstream.ok) {
            const errorMessage = typeof payload.error === 'string' ? payload.error : '';
            lastError = errorMessage || `Peer purge failed (${upstream.status})`;
            continue;
          }

          return res.json(payload);
        } catch (err) {
          lastError = String(err || lastError);
        }
      }

      return res.status(502).json({ error: lastError });
    });

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
        const pageModes: Record<string, 'public' | 'unlisted' | 'private-link' | 'expires'> = {};
        const pageDiscoverable: Record<string, boolean> = {};
        const pageExpiresAt: Record<string, number | undefined> = {};
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
        pageModes[hash] = this.normalizeShareMode(summary.shareMode);
        pageDiscoverable[hash] = typeof summary.discoverable === 'boolean'
          ? summary.discoverable
          : !(pageModes[hash] === 'unlisted' || pageModes[hash] === 'private-link');
        pageExpiresAt[hash] = this.normalizeExpiresAt(summary.expiresAt);
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
        pageModes,
        pageDiscoverable,
        pageExpiresAt,
        bytesUploaded: Math.max(0, Number(bytesUploaded) || 0),
        bytesDownloaded: Math.max(0, Number(bytesDownloaded) || 0),
        lastSeen: Date.now(),
      };

      const previousPeer = this.peers.get(peerId);
      this.peers.set(peerId, peer);
      void this.probePeer(peer);

      // Remove stale mappings for hashes this peer no longer advertises.
      const announcedHashes = new Set(filteredPages);
      for (const oldHash of previousPeer?.pages || []) {
        if (announcedHashes.has(oldHash)) {
          continue;
        }

        const indexedPeers = this.pageIndex.get(oldHash);
        if (!indexedPeers) {
          continue;
        }

        indexedPeers.delete(peerId);
        if (indexedPeers.size === 0) {
          this.pageIndex.delete(oldHash);
          this.resolveCursor.delete(oldHash);
        }
      }

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

          if (!this.isHashDiscoverable(hash, activePeers, now)) {
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
            mode: this.getFirstModeForHash(hash, activePeers),
          };
        })
        .filter((item): item is { hash: string; title: string; copies: number; pageVisits: number; latestSeen: number; url: string; mode: ShareMode } => !!item)
        .filter((item) => !this.isSmokeTitle(item.title))
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

    // Domain-aware landing behavior
    this.app.get('/', (req, res) => {
      const host = String(req.get('host') || '').toLowerCase().split(':')[0];
      if (host === 'tracker.pubweb.online' || host.startsWith('tracker.')) {
        return res.redirect(302, '/network');
      }
      return res.redirect(302, '/share-image');
    });

    // Tracker dashboard
    this.app.get('/network', async (req, res) => {
      const today = new Date().toDateString();
      const leaderboardPeers = Array.from(this.peers.values())
        .filter((p) => new Date(p.lastSeen).toDateString() === today);
      const peerStats = await this.store.getPeerDeliveryStats(leaderboardPeers.map((peer) => peer.peerId));
      const siteHashes = Array.from(this.pageIndex.keys());
      const siteStats = await this.store.getSiteDeliveryStats(siteHashes);

      const leaderboard = leaderboardPeers
        .sort((a, b) => b.bytesUploaded - a.bytesUploaded)
        .slice(0, 20);

      const now = Date.now();

      const topPages = siteHashes
        .map((hash) => {
          const peers = this.getActivePeersForHash(hash);
          if (!this.isHashDiscoverable(hash, peers, now)) {
            return null;
          }
          const title = peers
            .map((peer) => peer.pageTitles?.[hash])
            .find((value): value is string => !!value) || `Untitled ${hash.slice(0, 12)}`;
          return {
            hash,
            title,
            copies: peers.length,
            pageVisits: siteStats.get(hash)?.pageVisits || 0,
            mode: this.getFirstModeForHash(hash, peers),
          };
        })
          .filter((page): page is { hash: string; title: string; copies: number; pageVisits: number; mode: ShareMode } => !!page)
          .filter((page) => page.copies > 0 && page.mode !== 'private-link' && page.mode !== 'unlisted')
        .filter((page) => !this.isSmokeTitle(page.title))
        .sort((a, b) => {
          if (b.pageVisits !== a.pageVisits) {
            return b.pageVisits - a.pageVisits;
          }
          return b.copies - a.copies;
        })
        .slice(0, 50);

      // Network-wide stats: unlisted, expiring, next expiry
      let unlistedCount = 0;
      let expiringCount = 0;
      let nextExpiryMs: number | null = null;
      for (const hash of siteHashes) {
        const peers = this.getActivePeersForHash(hash);
        if (peers.length === 0) continue;
        // skip pages that have already expired on all peers
        const allExpired = peers.every((peer) => this.isExpired(peer, hash, now));
        if (allExpired) continue;
        const mode = this.getFirstModeForHash(hash, peers);
        if (mode === 'unlisted' || mode === 'private-link') {
          unlistedCount++;
        }
        if (mode === 'expires') {
          // only count pages with a future expiry timestamp
          const earliestFutureExpiry = peers
            .map((peer) => peer.pageExpiresAt[hash])
            .filter((exp): exp is number => typeof exp === 'number' && exp > now)
            .reduce((min, exp) => Math.min(min, exp), Infinity);
          if (earliestFutureExpiry === Infinity) continue;
          expiringCount++;
          if (nextExpiryMs === null || earliestFutureExpiry < nextExpiryMs) {
            nextExpiryMs = earliestFutureExpiry;
          }
        }
      }
      const nextExpiryLabel = nextExpiryMs !== null
        ? (() => {
            const diffMs = nextExpiryMs - now;
            const mins = Math.floor(diffMs / 60_000);
            const secs = Math.floor((diffMs % 60_000) / 1000);
            return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
          })()
        : null;

      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>PubWeb Tracker</title>
  <style>body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:20px;}h1,h2{margin-bottom:0.25rem}table{border-collapse:collapse;width:100%;max-width:900px;}th,td{border:1px solid #ccc;padding:6px;text-align:left;}a{color:#0366d6;text-decoration:none;}.onboard{display:inline-block;margin:10px 8px 18px 0;padding:10px 14px;border:1px solid #2b6de5;border-radius:999px;background:#eef4ff;color:#0f4dc4;font-weight:600}.shareimg{display:inline-block;margin:10px 0 18px;padding:10px 14px;border:1px solid #b24f2a;border-radius:999px;background:#fff0e8;color:#a03c15;font-weight:600}</style>
</head>
<body>
  <h1>PubWeb Network</h1>
  <p>Live peers and page index (one-server / one-page test)</p>
  <p><a class="onboard" href="/${this.onboardingHash}">Start here: Make your own page (download + publish loop)</a></p>
  <p><a class="shareimg" href="/share-image">Share image from phone</a></p>
  <p style="color:#555;font-size:0.95em">
    Unlisted pages: <strong>${unlistedCount}</strong> &nbsp;|&nbsp;
    Expiring pages: <strong>${expiringCount}</strong>${nextExpiryLabel ? ` &nbsp;|&nbsp; Next expiry in: <strong>${nextExpiryLabel}</strong>` : ''}
  </p>

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

      if (resolved.status === 'expired') {
        return res.status(410).json({ error: resolved.reason, status: 'expired' });
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

      if (resolved.status === 'expired') {
        return res.status(410).json({ status: 'expired', reason: resolved.reason });
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
    .top-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
    .share-link { border: 1px solid #34466f; border-radius: 999px; background: #182646; color: #dbe7ff; padding: 6px 10px; font-size: 12px; text-decoration: none; white-space: nowrap; }
    .qr-slot { margin-top: 10px; }
    .qr-btn { border: 1px solid #34466f; border-radius: 999px; background: #182646; color: #dbe7ff; padding: 6px 10px; font-size: 12px; }
    .qr-img { display: none; width: 170px; height: 170px; border-radius: 8px; border: 1px solid #314971; background: white; }
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
      <div class="top-row">
        <div>
          <div class="title">PubWeb wrapper</div>
          <div class="meta">Hash: ${hash}</div>
          <div class="meta">Wrapper version: ${this.escapeHtml(this.wrapperVersion)}</div>
        </div>
        <a class="share-link" href="https://pubweb.online/share-image">Share image</a>
      </div>
      <div class="qr-slot" id="qrSlot">
        <button class="qr-btn" id="qrToggle" type="button">Share QR</button>
        <img class="qr-img" id="qrImage" alt="Shareable QR" />
      </div>
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
    const qrToggle = document.getElementById('qrToggle');
    const qrImage = document.getElementById('qrImage');
    window.__pubwebWrapperVersion = wrapperVersion;

    const fragmentKey = (new URLSearchParams((window.location.hash || '#').slice(1))).get('k') || '';
    qrImage.src = '/qr/' + hash + '.svg?size=260' + (fragmentKey ? '&k=' + encodeURIComponent(fragmentKey) : '');
    qrToggle.addEventListener('click', () => {
      const showing = qrImage.style.display === 'block';
      qrImage.style.display = showing ? 'none' : 'block';
      qrToggle.style.display = showing ? 'inline-block' : 'none';
    });
    qrImage.addEventListener('click', () => {
      qrImage.style.display = 'none';
      qrToggle.style.display = 'inline-block';
    });

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
          frame.src = '/page/' + hash + (window.location.hash || '');
          return;
        }

        const data = await res.json().catch(() => ({}));
        if (res.status === 410) {
          statusText.textContent = data.reason || 'This page has expired on the official network.';
          return;
        }
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

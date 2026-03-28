import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { TrackerStore, PeerHeartbeatPayload } from './store';
// import config from '../../config.json';

interface TrackerEntry {
  peerId: string;
  host: string;
  port: number;
  pages: string[];
  bytesUploaded: number;
  bytesDownloaded: number;
  lastSeen: number;
}

class Tracker {
  private app = express();
  private peers: Map<string, TrackerEntry> = new Map();
  private pageIndex: Map<string, Set<string>> = new Map();
  private store: TrackerStore;
  private replicationTarget: number;

  constructor() {
    const dbPath = process.env.TRACKER_DB_PATH || path.join(process.cwd(), 'tracker.db');
    this.store = new TrackerStore(dbPath);
    this.replicationTarget = parseInt(process.env.REPLICATION_TARGET || '2', 10);
    this.setupRoutes();
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

  private async resolvePage(hash: string): Promise<
    | { status: 'ready'; html: string; contentType: string; target: string }
    | { status: 'warming'; reason: string }
    | { status: 'missing'; reason: string }
  > {
    const candidate = this.getPeerCandidate(hash);
    if (!candidate) {
      const known = this.pageIndex.has(hash);
      return known
        ? { status: 'warming', reason: 'Page hash exists, waiting for an active peer.' }
        : { status: 'missing', reason: 'Page hash is not currently indexed by tracker.' };
    }

    const target = `http://${candidate.host}:${candidate.port}/page/${hash}`;
    try {
      const upstream = await fetch(target);
      if (!upstream.ok) {
        return { status: 'warming', reason: `Peer responded ${upstream.status}, retrying.` };
      }

      const contentType = upstream.headers.get('content-type') || 'text/html; charset=utf-8';
      const html = await upstream.text();
      return { status: 'ready', html, contentType, target };
    } catch (err) {
      return { status: 'warming', reason: 'Failed to reach active peer, retrying.' };
    }
  }

  private setupRoutes() {
    this.app.use(express.json());

    this.app.post('/v1/peer/heartbeat', async (req, res) => {
      const payload = req.body as PeerHeartbeatPayload;
      if (!payload?.peerId) {
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

    // Register/update peer
    this.app.post('/announce', async (req, res) => {
      const { peerId, host, port, pages, bytesUploaded, bytesDownloaded } = req.body;

      if (!peerId || !host || !port) {
        return res.status(400).json({ error: 'Missing peer info' });
      }

      const peer: TrackerEntry = {
        peerId,
        host,
        port,
        pages: pages || [],
        bytesUploaded: bytesUploaded || 0,
        bytesDownloaded: bytesDownloaded || 0,
        lastSeen: Date.now(),
      };

      this.peers.set(peerId, peer);

      // Update page index
      for (const pageHash of pages || []) {
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

    // Query peers for a page
    this.app.get('/query/:hash', (req, res) => {
      const { hash } = req.params;
      const peers = this.pageIndex.get(hash);

      if (!peers || peers.size === 0) {
        return res.status(404).json({ error: 'Page not found on network' });
      }

      const peerList = Array.from(peers)
        .map((peerId) => this.peers.get(peerId))
        .filter((p) => p && Date.now() - p.lastSeen < 60000); // Online in last minute

      res.json({ peers: peerList });
    });

    // Get leaderboard for today
    this.app.get('/leaderboard', (req, res) => {
      const now = Date.now();
      const today = new Date().toDateString();

      const leaderboard = Array.from(this.peers.values())
        .filter((p) => new Date(p.lastSeen).toDateString() === today)
        .sort((a, b) => b.bytesUploaded - a.bytesUploaded)
        .map((p, rank) => ({
          rank: rank + 1,
          peerId: p.peerId,
          host: p.host,
          port: p.port,
          bytesUploaded: p.bytesUploaded,
          bytesDownloaded: p.bytesDownloaded,
          ratio: p.bytesUploaded / Math.max(p.bytesDownloaded, 1),
          pages: p.pages.length,
        }))
        .slice(0, 100);

      res.json({ leaderboard, timestamp: now });
    });

    // Public tracker dashboard (one-server one-page landing)
    this.app.get('/', (req, res) => {
      const today = new Date().toDateString();
      const leaderboard = Array.from(this.peers.values())
        .filter((p) => new Date(p.lastSeen).toDateString() === today)
        .sort((a, b) => b.bytesUploaded - a.bytesUploaded)
        .slice(0, 20);

      const topPages = Array.from(this.pageIndex.entries())
        .map(([hash, peers]) => ({ hash, copies: peers.size }))
        .sort((a, b) => b.copies - a.copies)
        .slice(0, 50);

      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>PubWeb Tracker</title>
  <style>body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:20px;}h1,h2{margin-bottom:0.25rem}table{border-collapse:collapse;width:100%;max-width:900px;}th,td{border:1px solid #ccc;padding:6px;text-align:left;}a{color:#0366d6;text-decoration:none;}</style>
</head>
<body>
  <h1>PubWeb Tracker</h1>
  <p>Live peers and page index (one-server / one-page test)</p>

  <h2>Top peers (by upload bytes today)</h2>
  <table>
    <tr><th>#</th><th>peerId</th><th>host:port</th><th>uploaded</th><th>downloaded</th><th>pages</th></tr>
    ${leaderboard
      .map(
        (p, i) =>
          `<tr><td>${i + 1}</td><td>${p.peerId}</td><td>${p.host}:${p.port}</td><td>${p.bytesUploaded}</td><td>${p.bytesDownloaded}</td><td>${p.pages.length}</td></tr>`
      )
      .join('')}
  </table>

  <h2>Top page hashes</h2>
  <table>
    <tr><th>#</th><th>hash</th><th>copies</th><th>view</th></tr>
    ${topPages
      .map(
        (p, i) =>
          `<tr><td>${i + 1}</td><td><code>${p.hash}</code></td><td>${p.copies}</td><td><a href="/page/${p.hash}">open</a></td></tr>`
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
      const resolved = await this.resolvePage(hash);
      if (resolved.status === 'ready') {
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
  <title>PubWeb Loading ${hash.slice(0, 12)}...</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #0b1220; color: #dbe7ff; }
    .shell { min-height: 100vh; display: flex; flex-direction: column; }
    .top { padding: 14px 16px; border-bottom: 1px solid #1f2a44; background: #111a2f; }
    .title { font-size: 14px; opacity: .9; }
    .meta { font-size: 12px; opacity: .75; margin-top: 4px; word-break: break-all; }
    .status { padding: 16px; font-size: 14px; }
    .frame-wrap { flex: 1; display: none; }
    iframe { width: 100%; height: 100%; border: 0; background: white; }
    .dot::after { content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-left: 6px; background: #7aa2ff; animation: pulse 1s infinite ease-in-out; }
    @keyframes pulse { 0%{opacity:.3} 50%{opacity:1} 100%{opacity:.3} }
  </style>
</head>
<body>
  <div class="shell">
    <div class="top">
      <div class="title">PubWeb wrapper</div>
      <div class="meta">Hash: ${hash}</div>
    </div>
    <div class="status" id="statusText">Locating content across the network<span class="dot"></span></div>
    <div class="frame-wrap" id="frameWrap">
      <iframe id="siteFrame" title="PubWeb Site"></iframe>
    </div>
  </div>
  <script>
    const hash = ${JSON.stringify(hash)};
    const statusText = document.getElementById('statusText');
    const frameWrap = document.getElementById('frameWrap');
    const frame = document.getElementById('siteFrame');

    async function checkReady() {
      try {
        const res = await fetch('/resolve/' + hash, { cache: 'no-store' });
        if (res.ok) {
          statusText.style.display = 'none';
          frameWrap.style.display = 'block';
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

      res.status(200).set('content-type', 'text/html; charset=utf-8').send(html);
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
          host: p.host,
          port: p.port,
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
    return new Promise((resolve) => {
      this.app.listen(port, () => {
        console.log(`Tracker listening on port ${port}`);
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
});

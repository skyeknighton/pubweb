import express from 'express';
import crypto from 'crypto';
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

  constructor() {
    this.setupRoutes();
  }

  private setupRoutes() {
    this.app.use(express.json());

    // Register/update peer
    this.app.post('/announce', (req, res) => {
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
      pages?.forEach((pageHash: string) => {
        if (!this.pageIndex.has(pageHash)) {
          this.pageIndex.set(pageHash, new Set());
        }
        this.pageIndex.get(pageHash)!.add(peerId);
      });

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

    // Redirect to a peer holding the page for easy one-server fetch
    this.app.get('/page/:hash', (req, res) => {
      const { hash } = req.params;
      const peerIds = this.pageIndex.get(hash);
      if (!peerIds || peerIds.size === 0) {
        return res.status(404).json({ error: 'Page not found on tracker' });
      }

      const candidate = Array.from(peerIds)
        .map((peerId) => this.peers.get(peerId))
        .filter((p): p is TrackerEntry => !!p && Date.now() - p.lastSeen < 60000)[0];

      if (!candidate) {
        return res.status(404).json({ error: 'No active peer currently available' });
      }

      const target = `http://${candidate.host}:${candidate.port}/page/${hash}`;
      res.redirect(target);
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
tracker.start(parseInt(process.env.TRACKER_PORT || '4000')).then(() => {
  console.log('Tracker started successfully');
}).catch(err => {
  console.error('Tracker failed to start:', err);
});

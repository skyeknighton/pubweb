# PubWeb - Decentralized Webpage Hosting

A peer-to-peer network for hosting and distributing HTML pages with a reputation tracker. Run a local peer, publish pages, and appear on the global leaderboard.

## Deploy Readiness

- Deployment and distribution plan: [docs/deploy-distribution-plan.md](docs/deploy-distribution-plan.md)

## Public Onboarding Loop

- Repository: https://github.com/skyeknighton/pubweb
- Download channel: https://github.com/skyeknighton/pubweb/releases/latest

Publish the themed onboarding page to the network:

```bash
npm run publish:make-page
```

Optional: pin the tracker homepage "Start here" button to a specific onboarding page hash:

```bash
PUBWEB_ONBOARDING_HASH=<your_hash_here>
```

Publish the styled Moby-Dick page:

```bash
npm run publish:moby-dick
```

## Windows Release Flow

Windows is the first supported desktop release target.

Build local Windows installers:

```bash
npm run dist:win
```

This outputs installer artifacts into `release/`:

- NSIS installer (`.exe`)
- Portable executable (`.exe`)

GitHub release automation:

- Push a version tag like `v0.10.1`
- GitHub Actions builds Windows artifacts and checksums
- A **draft** GitHub release is created/updated with artifacts attached

## Features

- **Peer Server** (port 3000): Hosts published HTML pages
- **Tracker Server** (port 4000): Leaderboard + page discovery
- **Auto-Announce**: Peers automatically register with tracker every 15 seconds
- **Page Hashing**: SHA-256 page content addressing
- **Metrics**: Upload/download byte tracking per peer

## Quick Start

### Local Testing

1. **Install dependencies:**
   ```bash
   npm install
   npm run build
   ```

2. **Start tracker service** (in PowerShell):
   ```powershell
   Start-Job -ScriptBlock { node dist/main/tracker/index.js }
   ```

3. **Start peer service** (in PowerShell):
   ```powershell
   Start-Job -ScriptBlock { node start-peer.js }
   ```

4. **Visit tracker dashboard:**
   ```
   http://localhost:4000/
   ```

5. **Publish a test page:**
   ```bash
   node publish-test-page.js
   ```

### Production Deployment

**Deploy to Namecheap server via SSH:**

```bash
ssh pubwvxel@server146.web-hosting.com
bash -c "$(curl -fsSL https://raw.githubusercontent.com/skyeknighton/pubweb/main/deploy.sh)"
```

Or manually:
```bash
git clone https://github.com/skyeknighton/pubweb.git ~/pubweb
cd ~/pubweb
npm install && npm run build
cp .env.example .env  # Edit with production settings
npm install -g pm2
pm2 start dist/main/tracker/index.js --name tracker
pm2 start start-peer.js --name peer
pm2 save && pm2 startup
```

## Architecture

```
PubWeb/
├── src/
│   ├── main/          # Electron app (unused for now)
│   ├── peer/          # Peer server (port 3000)
│   ├── tracker/       # Tracker server (port 4000)
│   ├── db/            # SQLite persistence
│   └── renderer/      # React UI (Electron)
├── dist/              # Compiled JavaScript
├── config.json        # Domain/port configuration
├── start-peer.js      # Peer startup script
└── deploy.sh          # Deployment script
```

## API Endpoints

### Peer Server (localhost:3000)

- `POST /publish` - Publish a new page
- `GET /page/:hash` - Retrieve page content
- `GET /page/:hash/meta` - Get page metadata
- `GET /status` - Peer status and stats

### Tracker Server (localhost:4000)

- `GET /` - Dashboard HTML (leaderboard + pages)
- `POST /announce` - Peer announces itself
- `POST /v1/peer/heartbeat` - Peer capacity/inventory heartbeat
- `GET /v1/peer/assignments?peerId=...` - Automatic assignment manifest
- `GET /query/:hash` - Find peers hosting page
- `GET /resolve/:hash` - Wrapper readiness status for delayed-load flow
- `GET /:hash` - Invisible wrapper for public hash access
- `GET /leaderboard` - Top peers by upload bytes
- `GET /peers` - List active peers
- `GET /health` - Health check

## Configuration

Edit `config.json`:
```json
{
  "domain": "pubweb.online",
  "trackerUrl": "http://localhost:4000",
  "peerPort": 3000,
  "trackerPort": 4000,
  "maxPageSize": 1048576,
  "enableHttps": false
}
```

For production, update trackerUrl to your domain.

## Testing

**Publish a page:**
```bash
node publish-test-page.js
```

**Check tracker dashboard:**
```bash
node -e "
const http = require('http');
http.request({
  hostname: 'localhost',
  port: 4000,
  path: '/',
  method: 'GET'
}, (res) => {
  res.on('data', (chunk) => console.log(chunk.toString()));
}).end();
"
```

## Development

### Build
```bash
npm run build
```

### Watch mode
```bash
npm run build  # Run this after changes
```

## Residential Deployment Notes

Target behavior: end users request `https://pubweb.online/<hash>` and receive a wrapper page while content is fetched from peers.

1. Run a public tracker/gateway node (`src/tracker/index.ts`) on a reachable host (Railway/VPS/home+tunnel).
2. Run contributor peers with `TRACKER_URL` pointing to that gateway.
3. On each peer, set `PUBLIC_HOST` to a reachable hostname/IP (or tunnel host) for back-fetching.
4. Keep `PEER_MAX_DISK_BYTES` and `PEER_MAX_UPLOAD_KBPS` bounded for residential safety.
5. Use a tunnel/provider edge if your residential ISP blocks inbound ports.

Example peer env:

```bash
TRACKER_URL=https://pubweb.online
PUBLIC_HOST=my-peer.example.com
PEER_MAX_DISK_BYTES=2147483648
PEER_MAX_UPLOAD_KBPS=1024
```

### Project Structure Details

- **src/tracker/index.ts** - Tracker server with HTML dashboard
- **src/peer/server.ts** - Peer server with auto-announce logic
- **src/db/index.ts** - SQLite wrapper for pages + stats
- **start-peer.js** - Entry point for peer with DB init

## License

MIT
└── README.md
```

## Architecture

### 1. **Peer Server** (`src/peer/server.ts`)
- Express HTTP server running on port 3000
- Serves pages by SHA-256 hash: `/page/Qm...HASH`
- Tracks download/upload stats
- Gossips page availability to other peers

### 2. **Electron App** (`src/main/index.ts`)
- Desktop UI wrapper
- SQLite database for metadata
- React frontend for uploads/browsing
- IPC bridge to peer server

### 3. **Central Tracker** (`src/tracker/index.ts`)  
- Optional HTTP server (port 4000)
- Tracks online peers and page locations
- Maintains daily leaderboard
- Helps new users discover content

### 4. **Database** (`src/db/index.ts`)
- SQLite3 with tables: `pages`, `uploads`, `downloads`
- Tracks page metadata (hash, author, timestamp)
- Records all transfers for reputation system

### 5. **React UI** (`src/renderer/`)
- Upload new pages
- Browse network pages
- View upload/download stats
- Monitor peer status

## Features

### Content Addressing
Pages are identified by SHA-256 hash of the HTML content. Same content = same hash = deduplication across the network.

```javascript
const hash = crypto.createHash('sha256').update(html).digest('hex');
```

### Transparent Attribution
Every page includes author metadata. Public key cryptography (future) enables signatures. Full accountability by design.

### Reputation System
Each user gets a unique peer ID (`uuid`). Stats tracked:
- **Bytes uploaded today** — How much you're hosting
- **Bytes downloaded** — Content you've served to others  
- **Ratio** — Upload/Download ratio (like BitTorrent ratio)
- **Rank** — Daily leaderboard position

Incentivizes sharing without requiring tokens.

### Peer Discovery
Lightweight tracker server maintains a list of online peers and which pages they host:
```
GET /query/:hash → returns list of peers hosting that hash
POST /announce → peers register with tracker
GET /leaderboard → daily top uploaders
```

### Page Format
Self-contained HTML5 with inline everything:
```html
<html>
  <head>
    <meta charset="utf-8">
    <style>/* all CSS inline */</style>
  </head>
  <body>
    <!-- HTML content -->
    <img src="data:image/png;base64,..." />
  </body>
</html>
```

**No external resources.** No APIs, CDNs, fonts, trackers. Just HTML + CSS + base64 images.

## Sharing a Page

1. **Create** — Write/generate HTML in the app
2. **Upload** — Click "Upload Page"
3. **Get hash** — App returns SHA-256 hash
4. **Share** — Post link anywhere:
   ```
   https://pubweb.online:3000/page/abc123...
   ```
5. **Replicate** — As peers discover it, they cache and rehost

## Example Page

A sample "My Trip to NYC" page is included in `examples/example-page.html` (~7.5 KB).
Shows how to:
- Use inline CSS for styling
- Include image placeholders (use base64 for real images)
- Make beautiful, self-contained pages
- Share detailed content without external dependencies

## API Endpoints

### Peer Server (`:3000`)
```
GET  /page/:hash              # Fetch page HTML
POST /publish                 # Publish new page
GET  /page/:hash/meta         # Get page metadata
GET  /status                  # Peer status info
POST /discover                # Peer discovery
```

### Tracker Server (`:4000`)
```
POST /announce                # Register peer
GET  /query/:hash             # Find peers with page
GET  /leaderboard             # Daily top uploaders
GET  /peers                   # Active peers list
GET  /health                  # Tracker health
```

## Stats in Electron UI

The **Status & Stats** tab shows:
- **Peer Info** — Online/offline, port, connected peers, pages hosting
- **Your Stats** — Bytes uploaded/downloaded today, ratio, page count
- **Network Info** — Top contributors on daily leaderboard

## Environment Variables

```bash
TRACKER_PORT=4000              # Port for tracker server (default: 4000)
NODE_ENV=development|production
```

## Development Tips

### TypeScript
Project uses strict TypeScript. Run `npm run build:main` to compile.

### React Components
- `UploadForm` — Upload page form with size warnings
- `PageBrowser` — Grid of available pages
- `StatusDashboard` — Stats and peer status

### Database Queries
SQLite uses callbacks. Database class wraps them in Promises for async/await.

### Testing
```bash
npm test  # Run Jest tests (if configured)
```

## Project Docs

- [Architecture Document](docs/architecture.md)
- [Full Description](docs/description.md)

## Future Enhancements

- [ ] **DHT fallback** — Pure P2P without central tracker
- [ ] **NAT traversal** — UPnP + relay servers for home networks
- [ ] **Page versioning** — Multiple versions of same page
- [ ] **Cryptographic signatures** — Author verification
- [ ] **Web gateway** — Access pages from browser without app
- [ ] **Full-text search** — Indexed page content
- [ ] **Real-time collaboration** — Co-edit pages
- [ ] **Blockchain integration** — Optional reputation tokens
- [ ] **Content filtering** — Community moderation
- [ ] **Mobile apps** — iOS/Android clients

## Privacy & Safety

- **No encryption by default** — Pages are public and discoverable
- **Full transparency** — Every upload shows author ID
- **Responsibility** — Authors own what they upload
- **Takedowns** — Tracker operator enforces copyright/abuse policies
- **No personal data** — Peer IDs are just UUIDs (optional key-pair later)

## License

MIT

## Contributing

Open issues and PRs welcomed! Areas needing help:
- NAT traversal implementation
- Webpack production config
- Web viewer for pages
- API documentation
- Example pages

## About PubWeb

PubWeb is the decentralized successor to early web publishing platforms like Geocities. Instead of a centralized service, PubWeb distributes hosting across its users' computers, creating a web where everyone both publishes and serves.

**Domain:** pubweb.online

## Questions?

Check `.github/copilot-instructions.md` for development notes.


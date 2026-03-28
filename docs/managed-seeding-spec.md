# PubWeb Managed Seeding Spec (MVP)

## 1) Objective

Build an "invisible BitTorrent" contribution model where:
- end users donate disk/bandwidth,
- the client handles torrent mechanics automatically,
- a coordinator controls what each peer stores/seeds,
- web users access content by HTTP URL (`/siteHash`) without understanding torrents.

This spec is intentionally aligned to the current PubWeb codebase and defines an incremental migration path.

---

## 2) Product Principles

1. **Torrent internals are hidden by default**
   - No magnet/infohash UX in normal mode.
2. **Operator-controlled distribution**
   - Coordinator assigns content to peers.
3. **User-controlled resource ceilings**
   - Peer user controls max disk, max upload, and optional schedule.
4. **HTTP-first consumption UX**
   - Public access remains URL-based (`https://pubweb.online/:siteHash`).
5. **Safe-by-default operation**
   - Enforce strict size/time/content controls and policy/takedown handling.
6. **Protocol-level portability**
  - The official network enforces its own policy, while protocol artifacts remain interoperable so independent networks can exist.

## 2.1 Decision Log (2026-03-28)

- MVP content scope: **HTML-only**.
- Keep submissions intentionally small (strict size cap) for scale testing.
- Incentives: **no built-in rewards** in MVP; use leaderboard/contribution stats only.
- Moderation: **basic takedown + central blocklist** in MVP.
- Moderation SLA details: **deferred** (post-MVP policy iteration).
- Contributor policy: official peers do not seed blocked hashes; pirate peers are out-of-protocol and not trusted.
- Topology recommendation for MVP: run coordinator + gateway in one service first, then split later.
- Assignment model: **fully automatic** (no contributor content-category filters in MVP).

---

## 3) Current-State Mapping (from existing repo)

Current implementation already provides:
- `src/peer/server.ts`: peer HTTP publish/serve + tracker announce loop.
- `src/tracker/index.ts`: tracker index + dashboard + `/page/:hash` proxy behavior.
- `src/db/index.ts`: SQLite page and transfer stats.
- Electron UI (`src/renderer/*`) for upload/browse/status.

Current limitations relative to target:
- no torrent identity layer (infohash/magnet not first-class),
- no coordinator assignment model,
- no background content allocator/evictor,
- tracker index is in-memory only (not durable across restart),
- peer announce host/port assumptions are local/dev oriented.

---

## 4) System Roles

## 4.1 Gateway (Public HTTP)

Responsibilities:
- Accept HTTP requests for `/:siteHash`.
- Resolve site metadata and content availability.
- Serve cached content immediately when available.
- Trigger background retrieval when missing.

MVP placement:
- Can be integrated into current tracker service, then split later if needed.

## 4.2 Coordinator (Control Plane)

Responsibilities:
- Decide which sites each peer should host.
- Track peer capacity and reliability.
- Emit assignment manifests and rebalance over time.

MVP placement:
- Can be added as routes/tables in tracker service first.

## 4.3 Peer Client (Contributor Node)

Responsibilities:
- Enforce local resource caps.
- Pull assignments from coordinator.
- Ensure assigned content is seeded (fetch missing content if needed).
- Report health, usage, and contribution stats.

MVP placement:
- Extend existing peer service with background worker loops.

## 4.4 Content Publisher

Responsibilities:
- Submit site payload and metadata.
- Receive canonical site identifiers.

MVP placement:
- Keep current publish API, then augment with packaged content metadata.

---

## 5) Content Model

## 5.1 Core IDs

- **siteHash**: canonical URL identifier used by HTTP routes.
- **torrentInfoHash**: BitTorrent identifier for payload swarm.
- **version**: monotonic integer per site.

MVP recommendation:
- Keep `siteHash` stable per exact payload version for now.
- Treat each version as immutable content-addressed object.

## 5.2 Site Bundle

A site bundle is a deterministic package containing:
- `index.html`
- optional assets (if/when multi-file support is enabled)
- `manifest.json` (title, size, createdAt, contentType, version)

MVP simplification:
- Start with single-file HTML payloads (already aligned with repo behavior).

## 5.3 Metadata Record (Coordinator)

`SiteRecord`:
- `siteHash`
- `torrentInfoHash`
- `sizeBytes`
- `version`
- `createdAt`
- `publisherId`
- `policyState` (`active`, `blocked`, `pending_review`)
- `replicationTarget`

---

## 6) Peer Resource Contract

Peer user configurable settings:
- `maxDiskBytes` (hard cap)
- `maxUploadKbps` (soft cap)
- `activeHours` (optional)
- `autoUpdate` (client update policy)

Peer runtime must enforce:
- disk high-water and low-water marks,
- bounded concurrent downloads,
- graceful eviction respecting coordinator priorities.

Suggested defaults (MVP):
- `maxDiskBytes`: 5 GB
- `maxUploadKbps`: 2048
- `concurrentFetches`: 2
- reserve free space: 15%

---

## 7) Assignment & Rebalancing Model

## 7.1 Assignment Unit

An assignment targets a site/version and includes priority:
- `siteHash`
- `torrentInfoHash`
- `version`
- `priority` (0-100)
- `minSeedUntil` timestamp
- `reason` (`hot`, `under_replicated`, `regional`, `baseline`)

## 7.2 Peer Poll Cycle

Every `N` seconds peer:
1. reports status and current inventory,
2. fetches assignment manifest,
3. reconciles desired vs local inventory,
4. downloads missing required content,
5. evicts low-priority content if over cap.

MVP interval: 60 seconds.

## 7.3 Eviction Policy (MVP)

Evict candidates sorted by:
1. lowest coordinator priority,
2. not pinned by `minSeedUntil`,
3. lowest recent demand score,
4. largest size first (to recover quickly).

Do not evict if site is under global replication floor unless coordinator explicitly allows.

---

## 8) API Contracts (MVP)

## 8.1 Peer → Coordinator

### `POST /v1/peer/heartbeat`

Request:
```json
{
  "peerId": "uuid",
  "version": "0.2.0",
  "capacity": {
    "maxDiskBytes": 5368709120,
    "maxUploadKbps": 2048
  },
  "usage": {
    "usedDiskBytes": 123456789,
    "bytesUploaded24h": 987654,
    "bytesDownloaded24h": 123456
  },
  "inventory": [
    { "siteHash": "...", "version": 1, "state": "seeded" }
  ],
  "health": {
    "uptimeSec": 86400,
    "natType": "unknown"
  }
}
```

Response:
```json
{
  "serverTime": 1760000000000,
  "nextHeartbeatSec": 60,
  "assignmentEtag": "abc123"
}
```

### `GET /v1/peer/assignments?peerId=...&etag=...`

Response:
```json
{
  "etag": "def456",
  "generatedAt": 1760000000000,
  "items": [
    {
      "siteHash": "...",
      "torrentInfoHash": "...",
      "version": 1,
      "priority": 85,
      "minSeedUntil": 1760003600000,
      "reason": "under_replicated"
    }
  ]
}
```

## 8.2 Publisher → Coordinator

### `POST /v1/publish`

Request:
```json
{
  "title": "Example",
  "html": "<!doctype html>...",
  "tags": ["demo"]
}
```

Response:
```json
{
  "siteHash": "...",
  "torrentInfoHash": "...",
  "version": 1,
  "gatewayUrl": "https://pubweb.online/..."
}
```

## 8.3 Gateway Public API

### `GET /:siteHash`

Behavior:
- Cache hit: `200` with site content.
- Cache miss + retrieval started: return an interstitial/loading page and poll server-side status.
- Not found or policy blocked: `404`/`451`.

Optional headers:
- `X-PubWeb-Cache: HIT|MISS|WARMING`
- `Retry-After: 5`

MVP UI behavior for cache miss:
- Return lightweight HTML interstitial (same URL) that auto-refreshes status.
- Interstitial states: `warming`, `unavailable`, `blocked`.
- If fetch completes in a short window, transition to final content automatically.

---

## 9) Runtime Flows

## 9.1 Publish Flow

1. Publisher submits site.
2. System validates payload limits and policy.
3. System computes content hash and creates torrent metadata.
4. System stores metadata + initial cache entry.
5. Coordinator boosts replication priority for new item.

## 9.2 Serve Flow

1. User requests `/:siteHash`.
2. Gateway checks cache.
3. If miss, queue retrieval from swarm and return `202`.
4. Once available, subsequent request serves from cache (`200`).
5. Background promotes content to peers when demand increases.

## 9.3 Peer Reconcile Flow

1. Peer heartbeats.
2. Peer fetches assignments.
3. Peer downloads assigned missing sites.
4. Peer seeds and reports contribution stats.
5. Peer evicts if above capacity using policy.

---

## 10) Safety, Abuse, and Compliance (MVP minimum)

- Content size limits (already present conceptually; enforce globally).
- MIME/content gating (HTML only in MVP).
- Takedown path: mark `policyState=blocked` and stop assignment.
- Gateway denylist check before serving content.
- Signed assignment manifests to prevent assignment spoofing.
- Basic rate limits on publish and gateway fetch miss storms.

Policy boundary (explicit):
- Official PubWeb-managed peers must follow coordinator blocklist and takedown policy.
- Protocol compatibility is preserved, meaning independent third-party swarms/trackers may exist outside official policy control.
- MVP scope covers enforcement for official infrastructure only.

---

## 11) Storage & Data Schema (Incremental)

Add durable coordinator tables (SQLite initially):
- `sites`
- `site_versions`
- `peer_nodes`
- `peer_inventory`
- `assignments`
- `policy_events`
- `gateway_cache_index`

Note:
- Existing `pages/uploads/downloads` can coexist during migration.

---

## 12) Implementation Plan (Phased)

## Phase A — Coordinator Foundations
- Persist tracker index and site metadata.
- Add heartbeat + assignments endpoints.
- Keep existing tracker dashboard working.

## Phase B — Peer Capacity & Assignment Worker
- Add peer settings storage and local cap enforcement.
- Implement reconcile loop (poll assignments, fetch, seed, evict).
- Add user-visible contribution metrics in UI.

## Phase C — Gateway Cache-Miss Orchestration
- Add `/:siteHash` retrieval queue and warm state.
- Return `202` during warm; `200` on ready.
- Add basic cache TTL and integrity checks.

## Phase D — Policy & Hardening
- Add policy state machine and moderation hooks.
- Add signed assignment manifests.
- Add richer observability (assignment success, under-replication alerts).

---

## 13) Success Metrics

Network metrics:
- replication floor compliance (% of sites meeting target)
- p95 cold-fetch latency
- cache hit ratio at gateway

Peer metrics:
- assignment compliance rate
- disk cap adherence
- upload contribution per GB allocated

User metrics:
- site availability (`/:siteHash` success rate)
- median time-to-first-byte for hot and cold content

---

## 14) Risks & Mitigations

1. **Cold-start delays for low-seeded content**
   - Mitigate with prewarming and minimum replication targets.
2. **Abuse/moderation burden**
   - Mitigate with policy gating + takedown tooling + block states.
3. **Peer churn volatility**
   - Mitigate with rebalance loop and reliability-weighted assignment.
4. **Complexity jump from current architecture**
   - Mitigate with phased rollout that keeps current APIs functioning.

---

## 15) Open Questions (Needs Product Decisions)

1. What minimum online reliability should be required for a peer to receive assignments?
2. At what scale threshold do we split gateway and coordinator into separate services?

Deferred (post-MVP):
- moderation/takedown SLA and escalation workflow details.

---

## 16) Out of Scope (MVP)

- Full token economics.
- End-user magnet/torrent controls in standard UI.
- Multi-region smart routing.
- Large binary media optimization.
- Full decentralized moderation governance.

---

## 17) Recommended Immediate Next Step

Implement **Phase A** first in the current codebase:
- durable `sites`/`peer_nodes`/`assignments` tables,
- `POST /v1/peer/heartbeat`,
- `GET /v1/peer/assignments`,
- no UI breakage for existing publish/browse/status.

Topology note:
- Start monolithic (tracker + coordinator + gateway together) to reduce operational complexity.
- Split gateway and coordinator after traffic or team velocity justifies independent scaling.

---

## 18) Next Spec Opportunity: Invisible Transport E2E Demo

Trigger this phase only after both a gateway host and at least one peer are running.

Goal:
- validate end-user behavior where a non-peer user opens `/:siteHash`, sees a wrapper loading state, and the page appears when network retrieval completes.

Readiness gates:
- gateway host is reachable publicly,
- peer heartbeat and assignment loops are stable,
- peer can serve assigned content hashes,
- wrapper + resolver routes are enabled.

Proposed deliverables:
- a deterministic local/remote test script for the full hash wrapper journey,
- acceptance criteria for warm/miss/error states,
- latency budget targets for first paint and final render,
- operator runbook for troubleshooting stalled warm states.

Exit criteria:
- repeated end-to-end runs succeed without manual intervention,
- wrapper transitions to content for reachable hashes,
- unavailable hashes show clear terminal state instead of indefinite loading.

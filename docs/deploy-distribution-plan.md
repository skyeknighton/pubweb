# PubWeb Deploy And Distribution Plan

## Goal

Ship PubWeb so non-technical users can:

1. Download a peer app they trust.
2. Publish their first page in minutes.
3. Opt into contributing disk space and bandwidth safely.

## Short Answer: Should The GitHub Be Public?

Yes, for the core product repository.

Public is the right default for this product because:

- Trust: users are more likely to run a peer app when source is open.
- Security: public review catches issues faster.
- Community growth: contributors can improve peer, tracker, and docs.
- Alignment: decentralized infrastructure benefits from transparent code.

Keep sensitive things out of GitHub:

- API tokens, deployment credentials, private keys.
- Environment-specific secrets.
- Ops-only scripts containing credentials.

Use branch protection and signed releases so public does not mean unsafe.

## Distribution Strategy For The Peer

Primary channel:

- GitHub Releases with platform installers.

Installers to publish per release:

- Windows: `.exe` installer.
- macOS: `.dmg`.
- Linux: AppImage or `.deb`.

Release artifacts should include:

- Binary/installer files.
- SHA-256 checksums.
- A signed release tag and changelog.

Optional secondary channel (later):

- Website download page that links to latest signed GitHub release.

## Trust And Safety Baseline

Before wide rollout, add these controls:

1. Signed tags for releases.
2. Checksums displayed in release notes.
3. First-run warning if app is from an unsigned build.
4. Conservative default limits for resource sharing.

Suggested defaults:

- `PEER_MAX_DISK_BYTES`: 1 GB
- `PEER_MAX_UPLOAD_KBPS`: 1024 KB/s
- `DISABLE_ASSIGNMENTS`: false for network mode, true for local test mode

## First-Run User Experience (Recommended)

### Step 1: Welcome + Trust

- Explain in one sentence: "PubWeb stores and serves HTML pages by content hash across peers."
- Show link to source repo and release signature/checksum.

### Step 2: Storage Allocation

- Slider for max disk usage.
- Clear copy: "You can change this anytime."
- Show estimated number of pages at current limit.

### Step 3: Network Contribution

- Toggle: "Help seed network pages".
- Explain tradeoff: better resilience vs local storage/bandwidth use.

### Step 4: Publish First Page

- Paste/upload HTML.
- Live size meter against page cap.
- One-click publish returns hash URL and copy buttons.

### Step 5: Status Dashboard

- Show pages hosted, pages served, page visits, bandwidth used.
- Show reachable state and troubleshooting hint if relay-required.

## Deployment Topology (Current Direction)

- Public tracker service on Railway.
- At least one always-on peer service on Railway.
- Optional user peers on residential devices with tunnel/public endpoint.

## Build Toward Deploy: Milestones

### Milestone A: Release-Ready App Packaging

- Add electron-builder packaging for Win/macOS/Linux.
- Create CI workflow that builds and drafts GitHub release.
- Attach checksums to each release.

### Milestone B: Onboarding And Limits

- Add first-run wizard for storage + bandwidth + seeding toggle.
- Persist settings in local DB settings table.
- Expose current allocation in dashboard.

### Milestone C: Publisher Experience

- Add guided publisher with hash preview and wrapper URL copy.
- Add validation errors with byte-level guidance.
- Add one-click "publish example" onboarding action.

### Milestone D: Network Confidence

- Add release smoke test in CI using tracker + peer status + publish + resolve checks.
- Add lightweight health banner in app if tracker unreachable.

## Recommended Immediate Decision

1. Keep repository public.
2. Distribute peer through signed GitHub Releases.
3. Keep tracker/peer infra public endpoint separate from user app binaries.
4. Prioritize first-run storage allocation UX before broad rollout.

## Launch Readiness Checklist

- [ ] Repo public with cleaned secrets and branch protection.
- [ ] Signed release process and checksums.
- [ ] Download/install docs for Windows/macOS/Linux.
- [ ] First-run storage and bandwidth controls.
- [ ] Publish flow with clear success and copyable URLs.
- [ ] Operational runbook for tracker/peer redeploy.

# PubWeb Image Sharing Spec

## 1. Objective

Extend PubWeb from generic self-contained HTML publishing into a first-class image sharing product that supports:

- computer-to-computer image sharing,
- computer-to-phone sharing,
- phone-to-phone sharing,
- public accountability by design,
- optional private payload delivery,
- ephemeral access and retention controls,
- a scale path that remains compatible with the current tracker and peer architecture.

This spec is intentionally aligned to the existing codebase in `src/main`, `src/peer`, `src/tracker`, and `src/renderer`.

---

## 2. Product Principles

1. **Accountability by design**
   - The originating publisher identity remains attributable at the network level.
   - Official infrastructure may log publisher identity, publish time, and site hash.
   - Public links are acceptable and expected for moderation and abuse response.

2. **Ephemerality by design**
   - Content retention and discoverability should be bounded by policy, defaults, and expiry controls rather than assumed permanence.
   - Ephemerality is implemented by replication policy, expiry metadata, and optional encrypted payloads, not by removing attribution.

3. **Authoritative but not authoritarian moderation**
   - The official network maintains an authoritative blocklist for official peers, gateway routes, and discovery surfaces.
   - The protocol remains portable so independent networks can choose different policies.

4. **HTTP-first sharing UX**
   - The primary share primitive remains a URL based on the site hash.
   - QR codes are first-class for cross-device handoff.

5. **Mobile-first publish path**
   - A user should be able to turn a photo into a PubWeb site and share it in a few actions.

6. **Scale through constrained content**
   - Keep image pages small, deterministic, and cacheable.
   - Prefer constrained single-page image bundles before introducing arbitrary large media uploads.

---

## 3. User-Facing Experience

## 3.1 Image Publish Flow

The publisher flow should be:

1. Pick an image.
2. Optionally add a title or caption.
3. Auto-resize and compress to a bounded target.
4. Strip EXIF metadata by default.
5. Generate a self-contained image page.
6. Publish and receive:
   - the site hash,
   - the public wrapper URL,
   - a QR code for the wrapper URL,
   - optional payload privacy status,
   - optional expiry status.

## 3.2 Viewer Flow

Each published page should expose a compact top bar with:

- title,
- short hash display,
- click-to-toggle full hash,
- click-to-toggle QR code,
- attribution metadata,
- expiry status when present.

The top bar should be visually minimal so image viewing remains primary.

## 3.3 Share Modes

The product should standardize on four user-facing share modes:

1. `Public`
2. `Unlisted`
3. `Private Link`
4. `Expires`

These modes are intentionally simple, do not require accounts, and remain compatible with a decentralized peer network plus an official policy layer.

### Public Image

- Wrapper URL resolves directly to the image page.
- Content can be indexed by the official tracker unless policy says otherwise.
- Publisher identity is attributable.

### Unlisted Image

- Wrapper URL works, but the page is omitted from discovery and public listings.
- Publisher identity remains attributable to operators.
- The hash is still an address, not a secret.

### Private Payload Image

- Wrapper page and attribution remain public.
- The image payload is encrypted client-side.
- The decryption key is carried in the URL fragment so official infrastructure does not receive it.
- Official infrastructure can still identify the publisher, timestamp, hash, and policy metadata.

### Private Share Link

- For MVP, the official share link only needs to embed the decryption key in the URL fragment.
- Example shape:
   - `https://pubweb.online/<hash>#k=<base64url-key>`
- The gateway receives the public hash route but does not receive the fragment key.
- The browser uses the fragment key to decrypt the payload locally.
- This allows private payload delivery with public publisher accountability.

User-facing label for this mode should be `Private Link`.

### Expiring Image

- This mode layers expiry policy on top of one of the other access modes.
- The most useful first version is `Private Link + expiresAt`.
- Official gateway routes stop serving after `expiresAt`.
- Official peers evict content after expiry unless policy requires temporary retention.
- Attribution and moderation metadata remain available to operators.

User-facing label for this mode should be `Expires`.

## 3.4 Canonical Mode Matrix

| Mode | Shareable by link alone | Visible in discovery | Payload readable by gateway | Official expiry support |
| --- | --- | --- | --- | --- |
| Public | Yes | Yes | Yes | Optional |
| Unlisted | Yes | No | Yes | Optional |
| Private Link | Yes | Usually no | No | Optional |
| Expires | Yes | Depends on base mode | Depends on base mode | Yes |

Implementation note:

- `Expires` is a lifecycle modifier, but it is acceptable to present it as a top-level mode in the UI because that matches user expectations.
- The first UI can offer these as four choices even if internally `Expires` maps to `Private Link` or `Unlisted` plus `expiresAt`.

### Ephemeral Image

- Content includes an `expiresAt` policy.
- Official peers stop serving after expiry unless policy overrides for abuse handling.
- Gateway behavior after expiry becomes `410 Gone` for official infrastructure.
- Audit metadata remains available to operators.

---

## 4. Trust, Safety, and Moderation

## 4.1 Accountability Model

The following should be retained for official network operation:

- `publisherPeerId`,
- `signerPublicKey`,
- publish timestamp,
- site hash,
- content type classification,
- moderation state,
- optional expiry metadata.

This preserves traceability for abuse response even when payloads are encrypted or expire.

## 4.2 Blocklist Model

Official infrastructure enforces a blocklist at three layers:

1. tracker discovery,
2. gateway resolution,
3. official peer seeding.

Blocked content may remain addressable on unofficial networks, which is acceptable and consistent with protocol portability.

## 4.3 Encryption Boundaries

Client-side encryption is for payload confidentiality, not anonymity.

Encryption does not hide:

- who published,
- when it was published,
- that a given site hash exists,
- whether the official network has blocked it.

Encryption should hide:

- the image bytes,
- captions included inside the encrypted payload,
- any private user content embedded in the page.

---

## 5. Content Model

## 5.1 Image Site Manifest

Add structured metadata for image pages:

```json
{
  "siteHash": "sha256-hex",
  "contentKind": "image-page",
  "mimeType": "image/jpeg",
  "width": 1440,
  "height": 1080,
  "sizeBytes": 284231,
  "publisherPeerId": "uuid",
  "createdAt": 1775000000000,
  "expiresAt": 1775086400000,
  "discoveryMode": "public",
  "encryption": {
    "mode": "none"
  }
}
```

For encrypted payloads:

```json
{
  "encryption": {
    "mode": "aes-gcm",
    "keyId": "local-fragment-only",
    "payloadEncoding": "base64"
  }
}
```

## 5.2 HTML Envelope

The uploaded HTML remains the canonical content-addressed artifact.

The generated image page should contain:

- a minimal frame,
- image metadata,
- responsive image presentation,
- optional caption,
- QR toggle container,
- optional encrypted payload bootstrap code.

---

## 6. Architecture Decisions

## 6.1 Keep the Existing Hash Address

The current `sha256(html)` approach remains valid for image pages.

Advantages:

- deduplication still works,
- existing `/page/:hash`, `/resolve/:hash`, and `/:hash` flows continue to work,
- tracker and peer indexing do not need a new primary identifier.

## 6.2 Add a First-Class Image Publisher

The Electron renderer should gain an image publishing flow that:

- accepts a local image,
- converts to a bounded, normalized format,
- emits generated HTML,
- publishes through the existing IPC and peer publish path.

Suggested implementation points:

- `src/renderer/components/ImageUploadForm.tsx`
- `src/main/preload.ts`
- `src/main/index.ts`

## 6.3 Public Wrapper Plus Optional Private Payload

The tracker wrapper route `/:hash` remains public and attributable.

For private payload mode:

- the wrapper and metadata are still public,
- the payload inside the page is encrypted,
- the decryption key is stored after `#` in the share URL,
- the browser decrypts locally after page load.

Example shape:

`https://pubweb.online/<hash>#k=<base64url-key>`

This preserves accountability while preventing the gateway from learning the plaintext.

This is sufficient for the first private-sharing model.

If the product later needs share-scoped controls, it can extend the link with a server-issued capability token, but that is not required for MVP.

## 6.4 Ephemerality Through Policy, Not Illusion

Ephemeral content should use explicit metadata:

- `expiresAt`,
- optional `maxReplicas`,
- optional `retainForAbuseReview`.

Official behavior:

- discovery omits expired content,
- gateway returns `410 Gone` after expiry,
- official peers evict expired content unless blocked for evidence retention.

This creates real lifecycle control without pretending the network can guarantee deletion from all copies.

### 6.4.1 Deferred Click Limits

Click-limited links are explicitly out of scope for MVP.

For the first release, ephemerality should be limited to:

- encrypted payloads with keys embedded in the share link,
- optional `expiresAt` policy on official infrastructure,
- official peer eviction after expiry.

This keeps the model simple and avoids overstating what the network can enforce after a recipient has decrypted the content.

## 6.5 Browser Phones Are Not Full Peers Yet

A mobile browser tab cannot reliably act as a public HTTP peer in the current architecture because:

- it usually cannot accept inbound connections,
- background execution is limited,
- tabs are short-lived,
- public reachability is not dependable.

Therefore:

- mobile web should support publish and view first,
- ephemeral browser seeding should be a later transport layer feature,
- durable mobile seeding likely requires a native app or a relay-assisted browser transport.

---

## 7. Scale Path

## 7.1 Phase 1: Robust MVP

Ship:

- image upload UI,
- generated image pages,
- wrapper URL copy,
- QR code toggle,
- image metadata,
- unlisted mode,
- expiry metadata stored and enforced by official gateway.
- small in-page header link inviting viewers to publish their own image.

Do not ship yet:

- mobile browser seeding,
- arbitrary large files,
- end-to-end encrypted multi-file bundles.

## 7.2 Phase 2: Operational Hardening

Add:

- durable moderation tables,
- persistent site metadata for image classification,
- expiry sweeper jobs,
- cache and replication policies by content kind,
- per-peer storage quotas for image replicas,
- abuse reporting and operator review tools.

## 7.3 Phase 3: Browser-Assisted Seeding

If needed, introduce a separate browser transport plane:

- WebRTC data channels or relay-assisted fetch,
- tracker-issued session tokens,
- ephemeral browser inventory announcements,
- session-limited seeding only while app/tab is active.

This should be additive and not replace the stable HTTP peer model used by desktop contributors.

## 7.4 Phase 4: Native Mobile Peer

If real mobile contribution matters:

- build a native mobile app,
- keep the same content-addressed site format,
- reuse tracker moderation and assignment APIs,
- expose explicit user controls for battery, storage, and background networking.

---

## 8. Data Model Changes

Extend page records with metadata such as:

- `content_kind`,
- `mime_type`,
- `width`,
- `height`,
- `discovery_mode`,
- `expires_at`,
- `is_encrypted`,
- `policy_state`.

These should be stored in both:

- peer local database for local inventory and UI,
- tracker store for discovery, moderation, and lifecycle enforcement.

---

## 9. UI Changes

## 9.1 Publisher UI

Add a dedicated image publish view with:

- drag-and-drop or file picker,
- title and optional caption,
- quality/resize presets,
- privacy mode selector,
- expiry selector,
- publish button,
- success state with URL, hash, and QR code.

## 9.2 Viewer UI

Generated pages should include:

- a compact info rail,
- full-screen friendly image layout,
- tap-to-toggle metadata,
- QR code reveal,
- attribution text,
- clear expired/blocked states.
- a small CTA link for publishing a photo or creating a private share.

The CTA should open the publisher flow with modes like:

- public,
- unlisted,
- private payload,
- optional expiring share link later.

For public pages this link should be subtle and non-disruptive.

---

## 9.3 Backend Scale Model

The official network should scale by adding more gateway and peer hosts behind the same logical service surface.

Immediate implications:

- phone browsers can publish immediately by sending payloads to the official publish endpoint,
- QR-based sharing works without mobile devices acting as durable peers,
- storage growth is handled by adding more managed peer capacity,
- the tracker can remain the policy authority while peer capacity expands horizontally.

Recommended shape:

- stateless gateway instances,
- durable tracker metadata store,
- managed seeding peers with bounded storage,
- optional object cache for hot encrypted payloads if needed later.

---

## 10. Recommended Immediate Build Order

1. Add structured image page metadata and image-specific HTML generator.
2. Add a renderer image publish component and wrapper URL success state.
3. Add QR generation for published hashes and page header toggles.
4. Add tracker support for `discoveryMode` and `expiresAt` metadata.
5. Add official blocklist and expired-content enforcement in tracker resolve/discover paths.
6. Add private payload mode using client-side encryption with fragment keys.
7. Evaluate browser seeding only after the above is stable.

---

## 11. Non-Goals For The First Release

- anonymous publishing,
- untraceable payload submission,
- guaranteed deletion from all peers,
- arbitrary video hosting,
- mobile browser as a durable always-on peer,
- full federated moderation in MVP.

These can be revisited later, but they are not required to make image sharing useful, accountable, and scalable.
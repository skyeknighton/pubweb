import sqlite3 from 'sqlite3';

export interface PeerHeartbeatPayload {
  peerId: string;
  version?: string;
  capacity?: {
    maxDiskBytes?: number;
    maxUploadKbps?: number;
  };
  usage?: {
    usedDiskBytes?: number;
    bytesUploaded24h?: number;
    bytesDownloaded24h?: number;
  };
  inventory?: Array<{
    siteHash: string;
    version?: number;
    state?: string;
  }>;
  health?: {
    uptimeSec?: number;
    natType?: string;
  };
}

export interface AssignmentItem {
  siteHash: string;
  torrentInfoHash: string;
  version: number;
  priority: number;
  minSeedUntil: number;
  reason: string;
}

export interface PeerDeliveryStats {
  peerId: string;
  pageServes: number;
  bytesServed: number;
  lastServed: number;
}

export interface SiteDeliveryStats {
  siteHash: string;
  pageVisits: number;
  bytesServed: number;
  lastVisit: number;
}

export class TrackerStore {
  private db: sqlite3.Database;

  constructor(dbPath: string) {
    this.db = new sqlite3.Database(dbPath);
  }

  async init(): Promise<void> {
    await this.run(`
      CREATE TABLE IF NOT EXISTS peer_nodes (
        peer_id TEXT PRIMARY KEY,
        version TEXT,
        max_disk_bytes INTEGER DEFAULT 0,
        max_upload_kbps INTEGER DEFAULT 0,
        used_disk_bytes INTEGER DEFAULT 0,
        bytes_uploaded_24h INTEGER DEFAULT 0,
        bytes_downloaded_24h INTEGER DEFAULT 0,
        uptime_sec INTEGER DEFAULT 0,
        nat_type TEXT DEFAULT 'unknown',
        last_seen INTEGER NOT NULL
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS peer_inventory (
        peer_id TEXT NOT NULL,
        site_hash TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL DEFAULT 'seeded',
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (peer_id, site_hash, version)
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS sites (
        site_hash TEXT PRIMARY KEY,
        torrent_info_hash TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        size_bytes INTEGER DEFAULT 0,
        policy_state TEXT NOT NULL DEFAULT 'active',
        replication_target INTEGER NOT NULL DEFAULT 2,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS assignments (
        peer_id TEXT NOT NULL,
        site_hash TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 50,
        min_seed_until INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT 'under_replicated',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (peer_id, site_hash, version)
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS peer_delivery_stats (
        peer_id TEXT PRIMARY KEY,
        page_serves INTEGER NOT NULL DEFAULT 0,
        bytes_served INTEGER NOT NULL DEFAULT 0,
        last_served INTEGER NOT NULL DEFAULT 0
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS site_delivery_stats (
        site_hash TEXT PRIMARY KEY,
        page_visits INTEGER NOT NULL DEFAULT 0,
        bytes_served INTEGER NOT NULL DEFAULT 0,
        last_visit INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  async recordServe(peerId: string, siteHash: string, bytesServed: number): Promise<void> {
    const now = Date.now();

    await this.run(
      `INSERT INTO peer_delivery_stats (peer_id, page_serves, bytes_served, last_served)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(peer_id) DO UPDATE SET
         page_serves = peer_delivery_stats.page_serves + 1,
         bytes_served = peer_delivery_stats.bytes_served + excluded.bytes_served,
         last_served = excluded.last_served`,
      [peerId, bytesServed, now]
    );

    await this.run(
      `INSERT INTO site_delivery_stats (site_hash, page_visits, bytes_served, last_visit)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(site_hash) DO UPDATE SET
         page_visits = site_delivery_stats.page_visits + 1,
         bytes_served = site_delivery_stats.bytes_served + excluded.bytes_served,
         last_visit = excluded.last_visit`,
      [siteHash, bytesServed, now]
    );
  }

  async getPeerDeliveryStats(peerIds: string[]): Promise<Map<string, PeerDeliveryStats>> {
    if (peerIds.length === 0) {
      return new Map();
    }

    const placeholders = peerIds.map(() => '?').join(', ');
    const rows = await this.all<{
      peer_id: string;
      page_serves: number;
      bytes_served: number;
      last_served: number;
    }>(
      `SELECT peer_id, page_serves, bytes_served, last_served
       FROM peer_delivery_stats
       WHERE peer_id IN (${placeholders})`,
      peerIds
    );

    return new Map(
      rows.map((row) => [row.peer_id, {
        peerId: row.peer_id,
        pageServes: row.page_serves || 0,
        bytesServed: row.bytes_served || 0,
        lastServed: row.last_served || 0,
      }])
    );
  }

  async getSiteDeliveryStats(siteHashes: string[]): Promise<Map<string, SiteDeliveryStats>> {
    if (siteHashes.length === 0) {
      return new Map();
    }

    const placeholders = siteHashes.map(() => '?').join(', ');
    const rows = await this.all<{
      site_hash: string;
      page_visits: number;
      bytes_served: number;
      last_visit: number;
    }>(
      `SELECT site_hash, page_visits, bytes_served, last_visit
       FROM site_delivery_stats
       WHERE site_hash IN (${placeholders})`,
      siteHashes
    );

    return new Map(
      rows.map((row) => [row.site_hash, {
        siteHash: row.site_hash,
        pageVisits: row.page_visits || 0,
        bytesServed: row.bytes_served || 0,
        lastVisit: row.last_visit || 0,
      }])
    );
  }

  async upsertSite(siteHash: string, version: number = 1, sizeBytes: number = 0): Promise<void> {
    const now = Date.now();
    await this.run(
      `INSERT INTO sites (site_hash, torrent_info_hash, version, size_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_hash) DO UPDATE SET
         version = excluded.version,
         size_bytes = CASE WHEN excluded.size_bytes > 0 THEN excluded.size_bytes ELSE sites.size_bytes END,
         updated_at = excluded.updated_at`,
      [siteHash, siteHash, version, sizeBytes, now, now]
    );
  }

  async processHeartbeat(payload: PeerHeartbeatPayload): Promise<void> {
    const now = Date.now();

    await this.run(
      `INSERT INTO peer_nodes (
          peer_id, version, max_disk_bytes, max_upload_kbps,
          used_disk_bytes, bytes_uploaded_24h, bytes_downloaded_24h,
          uptime_sec, nat_type, last_seen
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(peer_id) DO UPDATE SET
          version = excluded.version,
          max_disk_bytes = excluded.max_disk_bytes,
          max_upload_kbps = excluded.max_upload_kbps,
          used_disk_bytes = excluded.used_disk_bytes,
          bytes_uploaded_24h = excluded.bytes_uploaded_24h,
          bytes_downloaded_24h = excluded.bytes_downloaded_24h,
          uptime_sec = excluded.uptime_sec,
          nat_type = excluded.nat_type,
          last_seen = excluded.last_seen`,
      [
        payload.peerId,
        payload.version || 'unknown',
        payload.capacity?.maxDiskBytes || 0,
        payload.capacity?.maxUploadKbps || 0,
        payload.usage?.usedDiskBytes || 0,
        payload.usage?.bytesUploaded24h || 0,
        payload.usage?.bytesDownloaded24h || 0,
        payload.health?.uptimeSec || 0,
        payload.health?.natType || 'unknown',
        now,
      ]
    );

    await this.run('DELETE FROM peer_inventory WHERE peer_id = ?', [payload.peerId]);

    for (const item of payload.inventory || []) {
      if (!item.siteHash) {
        continue;
      }

      await this.upsertSite(item.siteHash, item.version || 1, 0);
      await this.run(
        `INSERT INTO peer_inventory (peer_id, site_hash, version, state, last_seen)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(peer_id, site_hash, version) DO UPDATE SET
           state = excluded.state,
           last_seen = excluded.last_seen`,
        [payload.peerId, item.siteHash, item.version || 1, item.state || 'seeded', now]
      );
    }
  }

  async generateAssignments(peerId: string, maxItems: number, replicationTarget: number): Promise<AssignmentItem[]> {
    const now = Date.now();
    const minSeedUntil = now + 30 * 60 * 1000;

    const candidates = await this.all<{
      site_hash: string;
      version: number;
      replicas: number;
      replication_target: number;
    }>(
      `SELECT
         s.site_hash,
         s.version,
         s.replication_target,
         (SELECT COUNT(1) FROM peer_inventory pi WHERE pi.site_hash = s.site_hash) AS replicas
       FROM sites s
       WHERE s.policy_state = 'active'
         AND NOT EXISTS (
            SELECT 1 FROM peer_inventory i
            WHERE i.peer_id = ? AND i.site_hash = s.site_hash
         )
       ORDER BY replicas ASC, s.updated_at DESC
       LIMIT 200`,
      [peerId]
    );

    const chosen = candidates
      .filter((row) => row.replicas < Math.max(replicationTarget, row.replication_target || 1))
      .slice(0, maxItems);

    for (const row of chosen) {
      const shortage = Math.max(1, replicationTarget - row.replicas);
      const priority = Math.min(100, 50 + shortage * 10);

      await this.run(
        `INSERT INTO assignments (peer_id, site_hash, version, priority, min_seed_until, reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(peer_id, site_hash, version) DO UPDATE SET
           priority = excluded.priority,
           min_seed_until = excluded.min_seed_until,
           reason = excluded.reason,
           updated_at = excluded.updated_at`,
        [peerId, row.site_hash, row.version, priority, minSeedUntil, 'under_replicated', now]
      );
    }

    return this.getAssignments(peerId);
  }

  async getAssignments(peerId: string): Promise<AssignmentItem[]> {
    const rows = await this.all<{
      site_hash: string;
      version: number;
      priority: number;
      min_seed_until: number;
      reason: string;
    }>(
      `SELECT site_hash, version, priority, min_seed_until, reason
       FROM assignments
       WHERE peer_id = ?
       ORDER BY priority DESC, updated_at DESC
       LIMIT 200`,
      [peerId]
    );

    return rows.map((row) => ({
      siteHash: row.site_hash,
      torrentInfoHash: row.site_hash,
      version: row.version,
      priority: row.priority,
      minSeedUntil: row.min_seed_until,
      reason: row.reason,
    }));
  }

  async pruneStalePeers(maxAgeMs: number): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    await this.run('DELETE FROM peer_nodes WHERE last_seen < ?', [cutoff]);
    await this.run('DELETE FROM peer_inventory WHERE last_seen < ?', [cutoff]);
  }

    async getTopAssignments(limit: number = 50, replicationTarget: number = 2): Promise<Array<{
      siteHash: string;
      replicas: number;
      priority: number;
    }>> {
      const rows = await this.all<{
        site_hash: string;
        replicas: number;
        replication_target: number;
      }>(
        `SELECT
           s.site_hash,
           s.replication_target,
           (SELECT COUNT(1) FROM peer_inventory pi WHERE pi.site_hash = s.site_hash) AS replicas
         FROM sites s
         WHERE s.policy_state = 'active'
         ORDER BY replicas ASC, s.updated_at DESC
         LIMIT ?`,
        [limit]
      );

      return rows.map((row) => ({
        siteHash: row.site_hash,
        replicas: row.replicas,
        priority: Math.min(100, 50 + (Math.max(1, replicationTarget - row.replicas) * 10)),
      }));
    }

  close(): void {
    this.db.close();
  }

  private run(sql: string, params: any[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private all<T>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows: T[]) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }
}

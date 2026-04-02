import sqlite3 from 'sqlite3';
import crypto from 'crypto';

export interface Page {
  id: string;
  hash: string;
  html: string;
  title: string;
  author: string;
  tags: string[];
  version: number;
  created: number;
  downloads: number;
  signerPeerId?: string;
  signature?: string;
  signerPublicKey?: string;
  shareMode: ShareMode;
  discoverable: boolean;
  expiresAt?: number;
  contentKind: ContentKind;
  mimeType?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  isEncrypted: boolean;
}

export interface Stats {
  bytesUploaded: number;
  bytesDownloaded: number;
  pagesHosted: number;
}

export interface PageSummary {
  hash: string;
  title: string;
  created: number;
  signerPeerId?: string;
  signature?: string;
  signerPublicKey?: string;
  shareMode: ShareMode;
  discoverable: boolean;
  expiresAt?: number;
  contentKind: ContentKind;
  mimeType?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  isEncrypted: boolean;
}

export interface PagePurgeCandidate {
  id: string;
  hash: string;
  title: string;
  created: number;
}

export type ShareMode = 'public' | 'unlisted' | 'private-link' | 'expires';
export type ContentKind = 'html' | 'image-page';

const DEFAULT_SHARE_MODE: ShareMode = 'public';
const DEFAULT_CONTENT_KIND: ContentKind = 'html';

function parseShareMode(value: unknown): ShareMode {
  if (value === 'public' || value === 'unlisted' || value === 'private-link' || value === 'expires') {
    return value;
  }
  return DEFAULT_SHARE_MODE;
}

function parseContentKind(value: unknown): ContentKind {
  if (value === 'html' || value === 'image-page') {
    return value;
  }
  return DEFAULT_CONTENT_KIND;
}

function parseNullableNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseBoolean(value: unknown, fallback: boolean = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return fallback;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no') {
      return false;
    }
    if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
      return true;
    }
  }
  return fallback;
}

export class Database {
  private db: sqlite3.Database;

  constructor(dbPath: string) {
    this.db = new sqlite3.Database(dbPath);
  }

  async init(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.db.serialize(() => {
        // Pages table
        this.db.run(`
          CREATE TABLE IF NOT EXISTS pages (
            id TEXT PRIMARY KEY,
            hash TEXT UNIQUE,
            html TEXT,
            title TEXT,
            author TEXT,
            tags TEXT,
            version INTEGER DEFAULT 1,
            created INTEGER,
            downloads INTEGER DEFAULT 0,
            signer_peer_id TEXT,
            signature TEXT,
            signer_public_key TEXT
          )
        `);

        // Download stats
        this.db.run(`
          CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pageHash TEXT,
            timestamp INTEGER,
            bytes INTEGER,
            FOREIGN KEY (pageHash) REFERENCES pages(hash)
          )
        `);

        // Upload stats
        this.db.run(`
          CREATE TABLE IF NOT EXISTS uploads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pageId TEXT,
            timestamp INTEGER,
            bytes INTEGER,
            FOREIGN KEY (pageId) REFERENCES pages(id)
          )
        `);

        this.db.run(`
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated INTEGER NOT NULL
          )
        `, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }).then(async () => {
      await this.ensureColumn('pages', 'signer_peer_id', 'TEXT');
      await this.ensureColumn('pages', 'signature', 'TEXT');
      await this.ensureColumn('pages', 'signer_public_key', 'TEXT');
      await this.ensureColumn('pages', 'share_mode', `TEXT NOT NULL DEFAULT '${DEFAULT_SHARE_MODE}'`);
      await this.ensureColumn('pages', 'discoverable', 'INTEGER NOT NULL DEFAULT 1');
      await this.ensureColumn('pages', 'expires_at', 'INTEGER');
      await this.ensureColumn('pages', 'content_kind', `TEXT NOT NULL DEFAULT '${DEFAULT_CONTENT_KIND}'`);
      await this.ensureColumn('pages', 'mime_type', 'TEXT');
      await this.ensureColumn('pages', 'media_width', 'INTEGER');
      await this.ensureColumn('pages', 'media_height', 'INTEGER');
      await this.ensureColumn('pages', 'is_encrypted', 'INTEGER NOT NULL DEFAULT 0');
    });
  }

  async addPage(data: {
    html: string;
    title: string;
    tags: string[];
    author: string;
    signerPeerId?: string;
    signature?: string;
    signerPublicKey?: string;
    created?: number;
    shareMode?: ShareMode;
    discoverable?: boolean;
    expiresAt?: number;
    contentKind?: ContentKind;
    mimeType?: string;
    mediaWidth?: number;
    mediaHeight?: number;
    isEncrypted?: boolean;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const hash = crypto.createHash('sha256').update(data.html).digest('hex');
    const bytes = Buffer.byteLength(data.html);
    const created = data.created || Date.now();

    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO pages (id, hash, html, title, author, tags, created, signer_peer_id, signature, signer_public_key, share_mode, discoverable, expires_at, content_kind, mime_type, media_width, media_height, is_encrypted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          hash,
          data.html,
          data.title,
          data.author,
          JSON.stringify(data.tags),
          created,
          data.signerPeerId || null,
          data.signature || null,
          data.signerPublicKey || null,
          parseShareMode(data.shareMode),
          data.discoverable === false ? 0 : 1,
          parseNullableNumber(data.expiresAt) || null,
          parseContentKind(data.contentKind),
          typeof data.mimeType === 'string' ? data.mimeType.slice(0, 120) : null,
          parseNullableNumber(data.mediaWidth) || null,
          parseNullableNumber(data.mediaHeight) || null,
          data.isEncrypted ? 1 : 0,
        ],
        (err) => {
          if (err) {
            const isDuplicateHash = typeof err.message === 'string' && err.message.includes('UNIQUE constraint failed: pages.hash');
            if (!isDuplicateHash) {
              reject(err);
              return;
            }

            this.db.get(
              'SELECT id FROM pages WHERE hash = ?',
              [hash],
              (lookupErr, row: any) => {
                if (lookupErr) {
                  reject(lookupErr);
                } else if (row?.id) {
                  if (data.signerPeerId && data.signature && data.signerPublicKey) {
                    this.db.run(
                      `UPDATE pages
                       SET signer_peer_id = COALESCE(signer_peer_id, ?),
                           signature = COALESCE(signature, ?),
                           signer_public_key = COALESCE(signer_public_key, ?),
                           share_mode = COALESCE(share_mode, ?),
                           discoverable = COALESCE(discoverable, ?),
                           expires_at = COALESCE(expires_at, ?),
                           content_kind = COALESCE(content_kind, ?),
                           mime_type = COALESCE(mime_type, ?),
                           media_width = COALESCE(media_width, ?),
                           media_height = COALESCE(media_height, ?),
                           is_encrypted = COALESCE(is_encrypted, ?)
                       WHERE hash = ?`,
                      [
                        data.signerPeerId,
                        data.signature,
                        data.signerPublicKey,
                        parseShareMode(data.shareMode),
                        data.discoverable === false ? 0 : 1,
                        parseNullableNumber(data.expiresAt) || null,
                        parseContentKind(data.contentKind),
                        typeof data.mimeType === 'string' ? data.mimeType.slice(0, 120) : null,
                        parseNullableNumber(data.mediaWidth) || null,
                        parseNullableNumber(data.mediaHeight) || null,
                        data.isEncrypted ? 1 : 0,
                        hash,
                      ],
                      () => resolve(row.id)
                    );
                    return;
                  }
                  resolve(row.id);
                } else {
                  reject(err);
                }
              }
            );
            return;
          } else {
            this.db.run(
              `INSERT INTO uploads (pageId, timestamp, bytes)
               VALUES (?, ?, ?)`,
              [id, Date.now(), bytes],
              (err) => {
                if (err) reject(err);
                else resolve(id);
              }
            );
          }
        }
      );
    });
  }

  async getPageByHash(hash: string): Promise<Page | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM pages WHERE hash = ?',
        [hash],
        (err, row: any) => {
          if (err) reject(err);
          else if (row) {
            resolve({
              id: row.id,
              hash: row.hash,
              html: row.html,
              title: row.title,
              author: row.author,
              version: row.version,
              created: row.created,
              downloads: row.downloads,
              tags: JSON.parse(row.tags || '[]'),
              signerPeerId: row.signer_peer_id || undefined,
              signature: row.signature || undefined,
              signerPublicKey: row.signer_public_key || undefined,
              shareMode: parseShareMode(row.share_mode),
              discoverable: parseBoolean(row.discoverable, true),
              expiresAt: parseNullableNumber(row.expires_at),
              contentKind: parseContentKind(row.content_kind),
              mimeType: row.mime_type || undefined,
              mediaWidth: parseNullableNumber(row.media_width),
              mediaHeight: parseNullableNumber(row.media_height),
              isEncrypted: parseBoolean(row.is_encrypted, false),
            });
          } else {
            resolve(null);
          }
        }
      );
    });
  }

  async getPages(limit: number = 50): Promise<Page[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM pages ORDER BY created DESC LIMIT ?',
        [limit],
        (err, rows: any[]) => {
          if (err) reject(err);
          else {
            resolve(
              rows.map((r) => ({
                id: r.id,
                hash: r.hash,
                html: r.html,
                title: r.title,
                author: r.author,
                version: r.version,
                created: r.created,
                downloads: r.downloads,
                tags: JSON.parse(r.tags || '[]'),
                signerPeerId: r.signer_peer_id || undefined,
                signature: r.signature || undefined,
                signerPublicKey: r.signer_public_key || undefined,
                shareMode: parseShareMode(r.share_mode),
                discoverable: parseBoolean(r.discoverable, true),
                expiresAt: parseNullableNumber(r.expires_at),
                contentKind: parseContentKind(r.content_kind),
                mimeType: r.mime_type || undefined,
                mediaWidth: parseNullableNumber(r.media_width),
                mediaHeight: parseNullableNumber(r.media_height),
                isEncrypted: parseBoolean(r.is_encrypted, false),
              }))
            );
          }
        }
      );
    });
  }

  async getPageHashes(limit: number = 500): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT hash FROM pages ORDER BY created DESC LIMIT ?',
        [limit],
        (err, rows: Array<{ hash: string }>) => {
          if (err) reject(err);
          else resolve((rows || []).map((row) => row.hash));
        }
      );
    });
  }

  async getPageSummaries(limit: number = 500): Promise<PageSummary[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT hash, title, created, signer_peer_id, signature, signer_public_key,
                share_mode, discoverable, expires_at, content_kind, mime_type, media_width, media_height, is_encrypted
         FROM pages
         ORDER BY created DESC
         LIMIT ?`,
        [limit],
        (err, rows: Array<{ hash: string; title: string | null; created: number; signer_peer_id: string | null; signature: string | null; signer_public_key: string | null; share_mode?: string; discoverable?: number; expires_at?: number | null; content_kind?: string; mime_type?: string | null; media_width?: number | null; media_height?: number | null; is_encrypted?: number }>) => {
          if (err) {
            reject(err);
            return;
          }

          resolve(
            (rows || []).map((row) => ({
              hash: row.hash,
              title: (row.title || '').trim() || `Untitled ${row.hash.slice(0, 12)}`,
              created: row.created || 0,
              signerPeerId: row.signer_peer_id || undefined,
              signature: row.signature || undefined,
              signerPublicKey: row.signer_public_key || undefined,
              shareMode: parseShareMode(row.share_mode),
              discoverable: parseBoolean(row.discoverable, true),
              expiresAt: parseNullableNumber(row.expires_at),
              contentKind: parseContentKind(row.content_kind),
              mimeType: row.mime_type || undefined,
              mediaWidth: parseNullableNumber(row.media_width),
              mediaHeight: parseNullableNumber(row.media_height),
              isEncrypted: parseBoolean(row.is_encrypted, false),
            }))
          );
        }
      );
    });
  }

  async hasPageHash(hash: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT 1 as found FROM pages WHERE hash = ? LIMIT 1',
        [hash],
        (err, row: any) => {
          if (err) reject(err);
          else resolve(!!row?.found);
        }
      );
    });
  }

  async getStorageBytes(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT COALESCE(SUM(LENGTH(html)), 0) as totalBytes FROM pages',
        (err, row: any) => {
          if (err) reject(err);
          else resolve(row?.totalBytes || 0);
        }
      );
    });
  }

  async getPageCount(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT COUNT(*) as count FROM pages', (err, row: any) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });
  }

  async recordDownload(hash: string, bytes: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO downloads (pageHash, timestamp, bytes)
         VALUES (?, ?, ?)`,
        [hash, Date.now(), bytes],
        (err) => {
          if (err) reject(err);
          else {
            // Update page download count
            this.db.run(
              'UPDATE pages SET downloads = downloads + 1 WHERE hash = ?',
              [hash],
              (err) => {
                if (err) reject(err);
                else resolve();
              }
            );
          }
        }
      );
    });
  }

  async getStats(): Promise<Stats> {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT 
          (SELECT COALESCE(SUM(bytes), 0) FROM uploads) as bytesUploaded,
          (SELECT COALESCE(SUM(bytes), 0) FROM downloads) as bytesDownloaded,
          (SELECT COUNT(*) FROM pages) as pagesHosted`,
        (err, rows: any[]) => {
          if (err) reject(err);
          else {
            const row = rows[0];
            resolve({
              bytesUploaded: row.bytesUploaded,
              bytesDownloaded: row.bytesDownloaded,
              pagesHosted: row.pagesHosted,
            });
          }
        }
      );
    });
  }

  async getSetting(key: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT value FROM settings WHERE key = ?',
        [key],
        (err, row: any) => {
          if (err) reject(err);
          else resolve(typeof row?.value === 'string' ? row.value : null);
        }
      );
    });
  }

  async setSetting(key: string, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO settings (key, value, updated)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated = excluded.updated`,
        [key, value, Date.now()],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async updatePageTitle(hash: string, title: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE pages SET title = ? WHERE hash = ?',
        [title, hash],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async findPagesByTitlePrefix(prefix: string, beforeTimestamp?: number, limit: number = 500): Promise<PagePurgeCandidate[]> {
    const normalizedPrefix = String(prefix || '').trim();
    const cappedLimit = Math.max(1, Math.min(limit, 2000));
    if (!normalizedPrefix) {
      return [];
    }

    const hasBefore = typeof beforeTimestamp === 'number' && Number.isFinite(beforeTimestamp);
    const query = hasBefore
      ? `SELECT id, hash, title, created
         FROM pages
         WHERE title LIKE ? AND created < ?
         ORDER BY created ASC
         LIMIT ?`
      : `SELECT id, hash, title, created
         FROM pages
         WHERE title LIKE ?
         ORDER BY created ASC
         LIMIT ?`;
    const args = hasBefore
      ? [`${normalizedPrefix}%`, beforeTimestamp, cappedLimit]
      : [`${normalizedPrefix}%`, cappedLimit];

    return new Promise((resolve, reject) => {
      this.db.all(query, args, (err, rows: Array<{ id: string; hash: string; title: string; created: number }>) => {
        if (err) {
          reject(err);
          return;
        }

        resolve((rows || []).map((row) => ({
          id: row.id,
          hash: row.hash,
          title: row.title || '',
          created: row.created || 0,
        })));
      });
    });
  }

  async deletePagesByHashes(hashes: string[]): Promise<number> {
    const uniqueHashes = Array.from(new Set((hashes || []).filter((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash))));
    if (uniqueHashes.length === 0) {
      return 0;
    }

    const placeholders = uniqueHashes.map(() => '?').join(',');
    const pageIds = await new Promise<string[]>((resolve, reject) => {
      this.db.all(
        `SELECT id FROM pages WHERE hash IN (${placeholders})`,
        uniqueHashes,
        (err, rows: Array<{ id: string }>) => {
          if (err) {
            reject(err);
            return;
          }
          resolve((rows || []).map((row) => row.id));
        }
      );
    });

    const idPlaceholders = pageIds.map(() => '?').join(',');

    await new Promise<void>((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run('BEGIN TRANSACTION');
        this.db.run(
          `DELETE FROM downloads WHERE pageHash IN (${placeholders})`,
          uniqueHashes,
          (downloadsErr) => {
            if (downloadsErr) {
              this.db.run('ROLLBACK');
              reject(downloadsErr);
              return;
            }

            const deleteUploads = (callback: (err?: Error | null) => void) => {
              if (pageIds.length === 0) {
                callback(null);
                return;
              }
              this.db.run(
                `DELETE FROM uploads WHERE pageId IN (${idPlaceholders})`,
                pageIds,
                callback
              );
            };

            deleteUploads((uploadsErr) => {
              if (uploadsErr) {
                this.db.run('ROLLBACK');
                reject(uploadsErr);
                return;
              }

              this.db.run(
                `DELETE FROM pages WHERE hash IN (${placeholders})`,
                uniqueHashes,
                (pagesErr) => {
                  if (pagesErr) {
                    this.db.run('ROLLBACK');
                    reject(pagesErr);
                    return;
                  }

                  this.db.run('COMMIT', (commitErr) => {
                    if (commitErr) {
                      reject(commitErr);
                      return;
                    }
                    resolve();
                  });
                }
              );
            });
          }
        );
      });
    });

    return uniqueHashes.length;
  }

  async findExpiredPageHashes(beforeTimestamp: number = Date.now(), limit: number = 500): Promise<string[]> {
    const cutoff = Number.isFinite(beforeTimestamp) ? beforeTimestamp : Date.now();
    const cappedLimit = Math.max(1, Math.min(limit, 5000));
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT hash
         FROM pages
         WHERE expires_at IS NOT NULL
           AND expires_at > 0
           AND expires_at <= ?
         ORDER BY expires_at ASC
         LIMIT ?`,
        [cutoff, cappedLimit],
        (err, rows: Array<{ hash: string }>) => {
          if (err) {
            reject(err);
            return;
          }
          resolve((rows || []).map((row) => row.hash).filter((hash) => typeof hash === 'string' && hash.length > 0));
        }
      );
    });
  }

  close(): void {
    this.db.close();
  }

  private async ensureColumn(table: string, column: string, definition: string): Promise<void> {
    const columns = await new Promise<string[]>((resolve, reject) => {
      this.db.all(`PRAGMA table_info(${table})`, (err, rows: Array<{ name: string }>) => {
        if (err) {
          reject(err);
          return;
        }
        resolve((rows || []).map((row) => row.name));
      });
    });

    if (columns.includes(column)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

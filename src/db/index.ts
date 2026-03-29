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
  }): Promise<string> {
    const id = crypto.randomUUID();
    const hash = crypto.createHash('sha256').update(data.html).digest('hex');
    const bytes = Buffer.byteLength(data.html);
    const created = data.created || Date.now();

    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO pages (id, hash, html, title, author, tags, created, signer_peer_id, signature, signer_public_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                           signer_public_key = COALESCE(signer_public_key, ?)
                       WHERE hash = ?`,
                      [data.signerPeerId, data.signature, data.signerPublicKey, hash],
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
        'SELECT hash, title, created, signer_peer_id, signature, signer_public_key FROM pages ORDER BY created DESC LIMIT ?',
        [limit],
        (err, rows: Array<{ hash: string; title: string | null; created: number; signer_peer_id: string | null; signature: string | null; signer_public_key: string | null }>) => {
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

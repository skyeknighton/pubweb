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
}

export interface Stats {
  bytesUploaded: number;
  bytesDownloaded: number;
  pagesHosted: number;
}

export class Database {
  private db: sqlite3.Database;

  constructor(dbPath: string) {
    this.db = new sqlite3.Database(dbPath);
  }

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
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
            downloads INTEGER DEFAULT 0
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
        `, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  async addPage(data: {
    html: string;
    title: string;
    tags: string[];
    author: string;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const hash = crypto.createHash('sha256').update(data.html).digest('hex');
    const bytes = Buffer.byteLength(data.html);

    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO pages (id, hash, html, title, author, tags, created)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          hash,
          data.html,
          data.title,
          data.author,
          JSON.stringify(data.tags),
          Date.now(),
        ],
        (err) => {
          if (err) reject(err);
          else {
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
              ...row,
              tags: JSON.parse(row.tags || '[]'),
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
                ...r,
                tags: JSON.parse(r.tags || '[]'),
              }))
            );
          }
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

  close(): void {
    this.db.close();
  }
}

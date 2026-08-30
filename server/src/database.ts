import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BookmarkRepository, HistoryEntry, PushResult } from "@bookmark-sync/core";

interface SnapshotRow {
  id: string;
  revision: number;
  created_at: string;
  message: string;
  author: string | null;
  repository_json: string;
}

export class SnapshotDatabase {
  private readonly database: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.database = new DatabaseSync(filePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        message TEXT NOT NULL,
        author TEXT,
        repository_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS current_snapshot (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id)
      );
    `);
  }

  private rowToRepository(row: SnapshotRow): BookmarkRepository {
    return JSON.parse(row.repository_json) as BookmarkRepository;
  }

  getCurrent(): BookmarkRepository | null {
    const row = this.database.prepare(`
      SELECT s.* FROM snapshots s
      JOIN current_snapshot c ON c.snapshot_id = s.id
      WHERE c.singleton = 1
    `).get() as SnapshotRow | undefined;
    return row ? this.rowToRepository(row) : null;
  }

  save(repository: BookmarkRepository, message: string, author?: string): PushResult {
    const current = this.getCurrent();
    const now = new Date().toISOString();
    const revision = Math.max(repository.revision, (current?.revision ?? 0) + 1) || 1;
    const next: BookmarkRepository = { ...repository, revision, updatedAt: now };
    const id = `server-${revision}-${Date.now().toString(36)}`;
    const insert = this.database.prepare(`
      INSERT INTO snapshots (id, revision, created_at, message, author, repository_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const updateCurrent = this.database.prepare(`
      INSERT INTO current_snapshot (singleton, snapshot_id) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET snapshot_id = excluded.snapshot_id
    `);
    const pruneOld = this.database.prepare(`
      DELETE FROM snapshots WHERE id NOT IN (
        SELECT id FROM snapshots ORDER BY revision DESC, created_at DESC LIMIT 10
      )
    `);
    this.database.exec("BEGIN");
    try {
      insert.run(id, revision, now, message, author ?? null, JSON.stringify(next));
      updateCurrent.run(id);
      pruneOld.run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { revision, id, createdAt: now };
  }

  getHistory(): HistoryEntry[] {
    const rows = this.database.prepare(`SELECT * FROM snapshots ORDER BY revision DESC, created_at DESC LIMIT 10`).all() as unknown as SnapshotRow[];
    return rows.map((row) => {
      const repository = this.rowToRepository(row);
      const counts = repository.nodes.reduce((value, node) => {
        if (node.type === "folder") value.folders += 1;
        else value.bookmarks += 1;
        return value;
      }, { bookmarks: 0, folders: 0 });
      return {
        id: row.id,
        revision: row.revision,
        createdAt: row.created_at,
        message: row.message,
        ...(row.author ? { author: row.author } : {}),
        bookmarkCount: counts.bookmarks,
        folderCount: counts.folders,
      };
    });
  }

  getVersion(id: string): BookmarkRepository | null {
    const row = this.database.prepare(`SELECT * FROM snapshots WHERE id = ?`).get(id) as SnapshotRow | undefined;
    return row ? this.rowToRepository(row) : null;
  }

  close(): void {
    this.database.close();
  }
}

import { validateRepository } from "@bookmark-sync/core";
import type {
  BookmarkRepository,
  CommitMetadata,
  HistoryEntry,
  KeyValueStore,
  PushResult,
  RemoteState,
  StorageAdapter,
} from "@bookmark-sync/core";

interface LocalStorageRecord {
  repository: BookmarkRepository | null;
  history: HistoryEntry[];
  versions: Record<string, BookmarkRepository>;
}

function emptyRecord(): LocalStorageRecord {
  return { repository: null, history: [], versions: {} };
}

function cloneRepository(repository: BookmarkRepository): BookmarkRepository {
  return JSON.parse(JSON.stringify(repository)) as BookmarkRepository;
}

export interface LocalStorageInfo {
  key: string;
  revision: number;
  historyCount: number;
  hasRepository: boolean;
  sizeBytes: number;
}

const MAX_HISTORY_ENTRIES = 10;

export class LocalStorageAdapter implements StorageAdapter {
  constructor(private readonly store: KeyValueStore, private readonly key = "bookmark-sync-local-storage") {}

  private async readRecord(): Promise<LocalStorageRecord> {
    return (await this.store.get<LocalStorageRecord>(this.key)) ?? emptyRecord();
  }

  private async writeRecord(record: LocalStorageRecord): Promise<void> {
    await this.store.set(this.key, record);
  }

  async clear(): Promise<void> {
    await this.store.remove(this.key);
  }

  async getStorageInfo(): Promise<LocalStorageInfo> {
    const record = await this.readRecord();
    const serialized = JSON.stringify(record);
    const sizeBytes = typeof TextEncoder !== "undefined"
      ? new TextEncoder().encode(serialized).length
      : Buffer.byteLength(serialized, "utf8");
    return {
      key: this.key,
      revision: record.repository?.revision ?? 0,
      historyCount: record.history.length,
      hasRepository: Boolean(record.repository),
      sizeBytes,
    };
  }

  async pull(): Promise<RemoteState | null> {
    const record = await this.readRecord();
    return record.repository ? { repository: cloneRepository(record.repository) } : null;
  }

  async push(repository: BookmarkRepository, metadata: CommitMetadata = {}): Promise<PushResult> {
    const errors = validateRepository(repository);
    if (errors.length) throw new Error(`Invalid repository: ${errors.join(", ")}`);
    const record = await this.readRecord();
    const now = new Date().toISOString();
    const revision = Math.max(repository.revision, (record.repository?.revision ?? 0) + 1) || 1;
    const next: BookmarkRepository = { ...cloneRepository(repository), revision, updatedAt: now };
    const id = `local-${revision}-${Date.now().toString(36)}`;
    const counts = next.nodes.reduce((value, node) => {
      if (node.type === "folder") value.folders += 1;
      else value.bookmarks += 1;
      return value;
    }, { bookmarks: 0, folders: 0 });
    const entry: HistoryEntry = {
      id,
      revision,
      createdAt: now,
      message: metadata.message ?? `Local snapshot revision ${revision}`,
      ...(metadata.author ? { author: metadata.author } : {}),
      bookmarkCount: counts.bookmarks,
      folderCount: counts.folders,
    };
    record.repository = next;
    record.versions[id] = cloneRepository(next);
    record.history = [entry, ...record.history.filter((item) => item.revision !== revision)].slice(0, MAX_HISTORY_ENTRIES);
    const activeIds = new Set(record.history.map((item) => item.id));
    for (const versionId of Object.keys(record.versions)) {
      if (!activeIds.has(versionId)) {
        delete record.versions[versionId];
      }
    }
    await this.writeRecord(record);
    return { revision, id, createdAt: now };
  }

  async getHistory(): Promise<HistoryEntry[]> {
    return (await this.readRecord()).history.slice(0, MAX_HISTORY_ENTRIES);
  }

  async getVersion(id: string): Promise<BookmarkRepository> {
    const version = (await this.readRecord()).versions[id];
    if (!version) throw new Error(`Local history version not found: ${id}`);
    return cloneRepository(version);
  }

  async restoreVersion(id: string): Promise<void> {
    const version = await this.getVersion(id);
    await this.push(version, { message: `Restored local snapshot ${id}` });
  }

  async testConnection(): Promise<void> {
    return;
  }
}

export class MemoryKeyValueStore implements KeyValueStore {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

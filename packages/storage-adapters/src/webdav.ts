import { validateRepository } from "@bookmark-sync/core";
import type {
  BookmarkRepository,
  CommitMetadata,
  HistoryEntry,
  PushResult,
  RemoteState,
  StorageAdapter,
} from "@bookmark-sync/core";

export interface WebDAVStorageConfig {
  url: string;
  username?: string;
  password?: string;
  filePath?: string;
}

type FetchLike = typeof fetch;

function encodeBase64(value: string): string {
  if (typeof btoa !== "undefined") {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  return Buffer.from(value, "utf8").toString("base64");
}

function resolveUrl(baseUrl: string, relativePath: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const trimmedPath = relativePath.replace(/^\/+/, "");
  return `${trimmedBase}/${trimmedPath}`;
}

function getParentUrl(targetUrl: string): string | null {
  const url = new URL(targetUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length <= 1) return null;
  parts.pop();
  url.pathname = `/${parts.join("/")}/`;
  return url.toString();
}

const MAX_HISTORY_ENTRIES = 10;

export class WebDAVStorageAdapter implements StorageAdapter {
  private readonly fileUrl: string;
  private readonly historyDirUrl: string;
  private readonly historyIndexUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: WebDAVStorageConfig,
    fetchImpl?: FetchLike,
  ) {
    if (!config.url) {
      throw new Error("WebDAV URL is required");
    }
    this.fetchImpl = fetchImpl ? fetchImpl.bind(globalThis) : globalThis.fetch.bind(globalThis);
    const filePath = config.filePath?.trim() || "bookmarks.json";
    this.fileUrl = resolveUrl(config.url, filePath);
    const parentDir = getParentUrl(this.fileUrl) ?? config.url;
    this.historyDirUrl = resolveUrl(parentDir, "history/");
    this.historyIndexUrl = resolveUrl(this.historyDirUrl, "history.json");
  }

  private headers(extra: HeadersInit = {}): HeadersInit {
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
    };
    if (this.config.username || this.config.password) {
      const credentials = `${this.config.username ?? ""}:${this.config.password ?? ""}`;
      headers["Authorization"] = `Basic ${encodeBase64(credentials)}`;
    }
    return { ...headers, ...extra };
  }

  private async ensureDirectory(dirUrl: string): Promise<void> {
    const normalizedDir = dirUrl.endsWith("/") ? dirUrl : `${dirUrl}/`;
    try {
      const response = await this.fetchImpl(normalizedDir, {
        method: "MKCOL",
        headers: this.headers(),
      });
      // 201 Created, 405 Method Not Allowed (already exists), 301/302 (redirected collection)
      if (response.status === 201 || response.status === 405) return;
      if (response.status === 409) {
        // Parent does not exist, try creating grandparent
        const parent = getParentUrl(normalizedDir);
        if (parent && parent !== normalizedDir) {
          await this.ensureDirectory(parent);
          await this.fetchImpl(normalizedDir, {
            method: "MKCOL",
            headers: this.headers(),
          });
        }
      }
    } catch {
      // Ignore network / MKCOL errors if server automatically manages directories
    }
  }

  async pull(): Promise<RemoteState | null> {
    const response = await this.fetchImpl(this.fileUrl, {
      method: "GET",
      headers: this.headers(),
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`WebDAV pull request failed with HTTP ${response.status} (${response.statusText || "Error"})`);
    }

    const text = await response.text();
    if (!text.trim()) return null;

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`Failed to parse WebDAV repository JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    const repository = payload as BookmarkRepository;
    const errors = validateRepository(repository);
    if (errors.length) {
      throw new Error(`Invalid WebDAV repository: ${errors.join(", ")}`);
    }

    const etag = response.headers.get("etag") ?? undefined;
    return { repository, ...(etag ? { etag } : {}) };
  }

  async push(repository: BookmarkRepository, metadata: CommitMetadata = {}): Promise<PushResult> {
    const errors = validateRepository(repository);
    if (errors.length) throw new Error(`Invalid repository: ${errors.join(", ")}`);

    const current = await this.pull();
    const revision = Math.max(repository.revision, (current?.repository.revision ?? 0) + 1) || 1;
    const now = new Date().toISOString();
    const next: BookmarkRepository = { ...repository, revision, updatedAt: now };
    const content = `${JSON.stringify(next, null, 2)}\n`;

    // Try uploading the main bookmarks file
    let putResponse = await this.fetchImpl(this.fileUrl, {
      method: "PUT",
      headers: this.headers({ "Content-Type": "application/json; charset=utf-8" }),
      body: content,
    });

    // If 404 or 409, directory might not exist yet; try creating parent directory and retry
    if (putResponse.status === 404 || putResponse.status === 409) {
      const parentDir = getParentUrl(this.fileUrl);
      if (parentDir) {
        await this.ensureDirectory(parentDir);
        putResponse = await this.fetchImpl(this.fileUrl, {
          method: "PUT",
          headers: this.headers({ "Content-Type": "application/json; charset=utf-8" }),
          body: content,
        });
      }
    }

    if (!putResponse.ok) {
      throw new Error(`WebDAV push failed with HTTP ${putResponse.status} (${putResponse.statusText || "Error"})`);
    }

    const id = `webdav-${revision}-${Date.now().toString(36)}`;
    const counts = next.nodes.reduce(
      (acc, node) => {
        if (node.type === "folder") acc.folders += 1;
        else acc.bookmarks += 1;
        return acc;
      },
      { bookmarks: 0, folders: 0 },
    );

    const historyEntry: HistoryEntry = {
      id,
      revision,
      createdAt: now,
      message: metadata.message ?? `Bookmark sync revision ${revision}`,
      ...(metadata.author ? { author: metadata.author } : {}),
      bookmarkCount: counts.bookmarks,
      folderCount: counts.folders,
    };

    // Save history snapshot asynchronously (best-effort)
    await this.saveHistorySnapshot(id, next, historyEntry);

    return {
      revision,
      id,
      createdAt: now,
    };
  }

  private async saveHistorySnapshot(
    id: string,
    repository: BookmarkRepository,
    entry: HistoryEntry,
  ): Promise<void> {
    try {
      await this.ensureDirectory(this.historyDirUrl);
      const snapshotUrl = resolveUrl(this.historyDirUrl, `${id}.json`);

      // Write snapshot file
      await this.fetchImpl(snapshotUrl, {
        method: "PUT",
        headers: this.headers({ "Content-Type": "application/json; charset=utf-8" }),
        body: `${JSON.stringify(repository, null, 2)}\n`,
      });

      // Update history index
      const existingHistory = await this.getHistory();
      const updatedHistory = [entry, ...existingHistory.filter((item) => item.id !== id && item.revision !== entry.revision)].slice(0, MAX_HISTORY_ENTRIES);

      // Clean up pruned snapshots from WebDAV server
      const keptIds = new Set(updatedHistory.map((item) => item.id));
      const prunedEntries = existingHistory.filter((item) => !keptIds.has(item.id));
      for (const pruned of prunedEntries) {
        const prunedUrl = resolveUrl(this.historyDirUrl, `${pruned.id}.json`);
        try {
          await this.fetchImpl(prunedUrl, {
            method: "DELETE",
            headers: this.headers(),
          });
        } catch {
          // Best-effort cleanup
        }
      }

      await this.fetchImpl(this.historyIndexUrl, {
        method: "PUT",
        headers: this.headers({ "Content-Type": "application/json; charset=utf-8" }),
        body: `${JSON.stringify(updatedHistory, null, 2)}\n`,
      });
    } catch {
      // Best-effort history recording
    }
  }

  async getHistory(): Promise<HistoryEntry[]> {
    try {
      const response = await this.fetchImpl(this.historyIndexUrl, {
        method: "GET",
        headers: this.headers(),
      });
      if (response.status === 404) return [];
      if (!response.ok) return [];
      const data = await response.json() as unknown;
      if (Array.isArray(data)) return (data as HistoryEntry[]).slice(0, MAX_HISTORY_ENTRIES);
      return [];
    } catch {
      return [];
    }
  }

  async getVersion(id: string): Promise<BookmarkRepository> {
    const snapshotUrl = resolveUrl(this.historyDirUrl, `${id}.json`);
    const response = await this.fetchImpl(snapshotUrl, {
      method: "GET",
      headers: this.headers(),
    });

    if (response.status === 404) {
      // Fallback: check if the current file matches the requested revision
      const current = await this.pull();
      if (current && (id.includes(`-${current.repository.revision}-`) || id === `webdav-${current.repository.revision}`)) {
        return current.repository;
      }
      throw new Error(`WebDAV history version not found: ${id}`);
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch WebDAV version ${id}: HTTP ${response.status}`);
    }

    const payload = await response.json() as BookmarkRepository;
    const errors = validateRepository(payload);
    if (errors.length) {
      throw new Error(`Invalid WebDAV snapshot data for version ${id}: ${errors.join(", ")}`);
    }

    return payload;
  }

  async restoreVersion(id: string): Promise<void> {
    const repository = await this.getVersion(id);
    await this.push(repository, { message: `Restored WebDAV snapshot ${id}` });
  }

  async testConnection(): Promise<void> {
    // Attempt PROPFIND or HEAD or GET on root/parent directory or the file itself
    let response: Response;
    try {
      response = await this.fetchImpl(this.fileUrl, {
        method: "HEAD",
        headers: this.headers(),
      });
    } catch (err) {
      throw new Error(`Network error connecting to WebDAV server: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (response.status === 401) {
      throw new Error("Authentication failed: invalid WebDAV username or password (HTTP 401)");
    }
    if (response.status === 403) {
      throw new Error("Access denied: permission denied by WebDAV server (HTTP 403)");
    }

    // 200 (file exists), 404 (file doesn't exist yet but server is reachable and auth valid) are both OK
    if (response.ok || response.status === 404 || response.status === 405) {
      return;
    }

    // If HEAD failed with 405 (Method Not Allowed), try PROPFIND or GET
    const propfindResponse = await this.fetchImpl(this.config.url, {
      method: "PROPFIND",
      headers: this.headers({ Depth: "0" }),
    });

    if (propfindResponse.status === 401) {
      throw new Error("Authentication failed: invalid WebDAV username or password (HTTP 401)");
    }
    if (propfindResponse.status === 403) {
      throw new Error("Access denied: permission denied by WebDAV server (HTTP 403)");
    }

    if (!propfindResponse.ok && propfindResponse.status !== 207 && propfindResponse.status !== 404) {
      throw new Error(`WebDAV server returned HTTP ${propfindResponse.status} (${propfindResponse.statusText || "Error"})`);
    }
  }
}

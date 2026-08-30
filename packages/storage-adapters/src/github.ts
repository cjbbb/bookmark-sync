import type {
  BookmarkRepository,
  CommitMetadata,
  HistoryEntry,
  PushResult,
  RemoteState,
  StorageAdapter,
} from "@bookmark-sync/core";
import { validateRepository } from "@bookmark-sync/core";

export interface GitHubStorageConfig {
  token: string;
  owner: string;
  repository: string;
  branch: string;
  filePath: string;
}

type FetchLike = typeof fetch;

interface GitHubContentResponse {
  content?: string;
  sha?: string;
  encoding?: string;
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): string {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function serializeRepository(repository: BookmarkRepository): string {
  return `${JSON.stringify(repository, null, 2)}\n`;
}

export function deserializeRepository(value: string): BookmarkRepository {
  const repository = JSON.parse(value) as BookmarkRepository;
  const errors = validateRepository(repository);
  if (errors.length) throw new Error(`Invalid GitHub repository: ${errors.join(", ")}`);
  return repository;
}

export class GitHubStorageAdapter implements StorageAdapter {
  private readonly apiBase = "https://api.github.com";
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: GitHubStorageConfig, fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ? fetchImpl.bind(globalThis) : globalThis.fetch.bind(globalThis);
  }

  private contentUrl(ref?: string): string {
    const path = this.config.filePath.split("/").map(encodeURIComponent).join("/");
    const base = `${this.apiBase}/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repository)}/contents/${path}`;
    return ref ? `${base}?ref=${encodeURIComponent(ref)}` : base;
  }

  private headers(): HeadersInit {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.config.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private async fetchContent(ref?: string): Promise<{ repository: BookmarkRepository; sha?: string } | null> {
    const response = await this.fetchImpl(this.contentUrl(ref ?? this.config.branch), { headers: this.headers() });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub request failed with HTTP ${response.status}`);
    const payload = await response.json() as GitHubContentResponse;
    if (!payload.content) throw new Error("GitHub file response did not contain content");
    return {
      repository: deserializeRepository(decodeBase64(payload.content)),
      ...(payload.sha ? { sha: payload.sha } : {}),
    };
  }

  async pull(): Promise<RemoteState | null> {
    const content = await this.fetchContent();
    if (!content) return null;
    return { repository: content.repository, ...(content.sha ? { etag: content.sha } : {}) };
  }

  async push(repository: BookmarkRepository, metadata: CommitMetadata = {}): Promise<PushResult> {
    const errors = validateRepository(repository);
    if (errors.length) throw new Error(`Invalid repository: ${errors.join(", ")}`);
    const current = await this.fetchContent();
    const revision = Math.max(repository.revision, (current?.repository.revision ?? 0) + 1) || 1;
    const next = { ...repository, revision, updatedAt: new Date().toISOString() };
    const message = metadata.message ?? `Bookmark sync revision ${revision}`;
    const body: Record<string, unknown> = {
      message,
      content: encodeBase64(serializeRepository(next)),
      branch: this.config.branch,
    };
    if (current?.sha) body.sha = current.sha;
    const response = await this.fetchImpl(this.contentUrl(), {
      method: "PUT",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`GitHub push failed with HTTP ${response.status}`);
    const payload = await response.json() as { commit?: { sha?: string; html_url?: string } };
    return { revision, ...(payload.commit?.sha ? { id: payload.commit.sha } : {}), createdAt: next.updatedAt };
  }

  async getHistory(): Promise<HistoryEntry[]> {
    const path = encodeURIComponent(this.config.filePath);
    const url = `${this.apiBase}/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repository)}/commits?path=${path}&sha=${encodeURIComponent(this.config.branch)}&per_page=10`;
    const response = await this.fetchImpl(url, { headers: this.headers() });
    if (!response.ok) throw new Error(`GitHub history request failed with HTTP ${response.status}`);
    const commits = await response.json() as Array<{
      sha: string;
      commit?: { message?: string; author?: { name?: string; date?: string } };
    }>;
    return commits.slice(0, 10).map((commit, index) => {
      const message = commit.commit?.message?.split("\n")[0] ?? "Bookmark snapshot";
      const revision = Number(message.match(/revision\s+(\d+)/i)?.[1] ?? commits.length - index);
      return {
        id: commit.sha,
        revision,
        createdAt: commit.commit?.author?.date ?? new Date(0).toISOString(),
        message,
        ...(commit.commit?.author?.name ? { author: commit.commit.author.name } : {}),
        bookmarkCount: 0,
        folderCount: 0,
      };
    });
  }

  async getVersion(id: string): Promise<BookmarkRepository> {
    const content = await this.fetchContent(id);
    if (!content) throw new Error(`GitHub history version not found: ${id}`);
    return content.repository;
  }

  async restoreVersion(id: string): Promise<void> {
    const repository = await this.getVersion(id);
    await this.push(repository, { message: `Restored GitHub snapshot ${id}` });
  }

  async testConnection(): Promise<void> {
    await this.fetchContent();
  }
}

import { validateRepository } from "@bookmark-sync/core";
import type {
  BookmarkRepository,
  CommitMetadata,
  HistoryEntry,
  PushResult,
  RemoteState,
  StorageAdapter,
} from "@bookmark-sync/core";

export interface SelfHostedStorageConfig {
  serverUrl: string;
  apiToken: string;
}

type FetchLike = typeof fetch;

export class SelfHostedStorageAdapter implements StorageAdapter {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: SelfHostedStorageConfig, fetchImpl?: FetchLike) {
    this.baseUrl = config.serverUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl ? fetchImpl.bind(globalThis) : globalThis.fetch.bind(globalThis);
  }

  private headers(): HeadersInit {
    return { Accept: "application/json", Authorization: `Bearer ${this.config.apiToken}` };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`Self-hosted server request failed with HTTP ${response.status}`);
    return response;
  }

  async pull(): Promise<RemoteState | null> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/repository`, { headers: this.headers() });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Self-hosted repository request failed with HTTP ${response.status}`);
    const payload = await response.json() as unknown;
    const repository = isRepositoryWrapper(payload) ? payload.repository : payload as BookmarkRepository;
    if (!repository) return null;
    const errors = validateRepository(repository);
    if (errors.length) throw new Error(`Invalid self-hosted repository: ${errors.join(", ")}`);
    return { repository };
  }

  async push(repository: BookmarkRepository, metadata: CommitMetadata = {}): Promise<PushResult> {
    const errors = validateRepository(repository);
    if (errors.length) throw new Error(`Invalid repository: ${errors.join(", ")}`);
    const response = await this.request("/api/repository", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository, metadata }),
    });
    return await response.json() as PushResult;
  }

  async getHistory(): Promise<HistoryEntry[]> {
    const response = await this.request("/api/history");
    return await response.json() as HistoryEntry[];
  }

  async getVersion(id: string): Promise<BookmarkRepository> {
    const response = await this.request(`/api/history/${encodeURIComponent(id)}`);
    const payload = await response.json() as unknown;
    const repository = isRepositoryWrapper(payload) ? payload.repository : payload as BookmarkRepository;
    if (!repository) throw new Error(`Self-hosted history version not found: ${id}`);
    return repository;
  }

  async restoreVersion(id: string): Promise<void> {
    await this.request(`/api/history/${encodeURIComponent(id)}/restore`, { method: "POST" });
  }

  async testConnection(): Promise<void> {
    await this.request("/health");
  }
}

function isRepositoryWrapper(value: unknown): value is { repository: BookmarkRepository } {
  return Boolean(value && typeof value === "object" && "repository" in value && (value as { repository?: unknown }).repository);
}

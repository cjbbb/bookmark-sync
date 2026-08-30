import { getFolderPath } from "./paths.js";
import { normalizeUrl } from "./url.js";
import type { BookmarkNode, BookmarkRepository } from "./types.js";

export type LinkReachabilityStatus = "reachable" | "restricted" | "broken" | "error" | "unsupported";

export interface LinkReachabilityResult {
  normalizedUrl: string;
  url: string;
  nodeIds: string[];
  titles: string[];
  folderPaths: string[];
  status: LinkReachabilityStatus;
  checkedAt: string;
  latencyMs: number;
  httpStatus?: number;
  finalUrl?: string;
  error?: string;
}

export interface ReachabilityProgress {
  total: number;
  completed: number;
  currentResult?: LinkReachabilityResult | undefined;
  url?: string | undefined;
  title?: string | undefined;
}

export interface ReachabilityOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  concurrency?: number;
  now?: () => string;
  onProgress?: (progress: ReachabilityProgress) => void;
  signal?: AbortSignal;
}

interface UrlGroup {
  normalizedUrl: string;
  url: string;
  nodes: BookmarkNode[];
}

function classifyStatus(status: number): LinkReachabilityStatus {
  if (status >= 200 && status < 400) return "reachable";
  if (status === 401 || status === 403 || status === 407 || status === 429) return "restricted";
  return "broken";
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Request timed out";
  return error instanceof Error ? error.message : String(error);
}

async function requestUrl(url: string, fetchFn: typeof fetch, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response = await fetchFn(url, {
      method: "HEAD",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 403 || response.status === 405 || response.status === 501) {
      response = await fetchFn(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal,
      });
      await response.body?.cancel();
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkGroup(
  repository: BookmarkRepository,
  group: UrlGroup,
  fetchFn: typeof fetch,
  timeoutMs: number,
  now: () => string,
): Promise<LinkReachabilityResult> {
  const base = {
    normalizedUrl: group.normalizedUrl,
    url: group.url,
    nodeIds: group.nodes.map((node) => node.id),
    titles: group.nodes.map((node) => node.title),
    folderPaths: group.nodes.map((node) => getFolderPath(repository, node.id)),
  };
  let protocol: string;
  try {
    protocol = new URL(group.url).protocol;
  } catch {
    return { ...base, status: "unsupported", checkedAt: now(), latencyMs: 0, error: "Invalid URL" };
  }
  if (protocol !== "http:" && protocol !== "https:") {
    return { ...base, status: "unsupported", checkedAt: now(), latencyMs: 0, error: `Unsupported protocol: ${protocol}` };
  }

  const startedAt = Date.now();
  try {
    const response = await requestUrl(group.url, fetchFn, timeoutMs);
    const result: LinkReachabilityResult = {
      ...base,
      status: classifyStatus(response.status),
      checkedAt: now(),
      latencyMs: Date.now() - startedAt,
      httpStatus: response.status,
    };
    if (response.url) result.finalUrl = response.url;
    return result;
  } catch (error) {
    return {
      ...base,
      status: "error",
      checkedAt: now(),
      latencyMs: Date.now() - startedAt,
      error: errorMessage(error),
    };
  }
}

/**
 * Checks a single bookmark URL and returns its reachability result.
 */
export async function checkSingleBookmarkReachability(
  repository: BookmarkRepository,
  url: string,
  options: ReachabilityOptions = {},
): Promise<LinkReachabilityResult> {
  const normalizedUrl = normalizeUrl(url);
  const matchingNodes = repository.nodes.filter(
    (n) => n.type === "bookmark" && n.url && (normalizeUrl(n.url) === normalizedUrl || n.url.trim() === url.trim()),
  );
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = Math.max(100, options.timeoutMs ?? 8000);
  const now = options.now ?? (() => new Date().toISOString());
  return await checkGroup(
    repository,
    { normalizedUrl, url, nodes: matchingNodes },
    fetchFn,
    timeoutMs,
    now,
  );
}

/**
 * Checks each normalized HTTP(S) URL once and reports results for all matching
 * canonical bookmark IDs. This function is read-only and never mutates a repository.
 */
export async function checkBookmarkReachability(
  repository: BookmarkRepository,
  options: ReachabilityOptions = {},
): Promise<LinkReachabilityResult[]> {
  const grouped = new Map<string, UrlGroup>();
  for (const node of repository.nodes) {
    if (node.type !== "bookmark" || !node.url) continue;
    const normalizedUrl = normalizeUrl(node.url);
    const key = normalizedUrl || node.url.trim();
    const existing = grouped.get(key);
    if (existing) existing.nodes.push(node);
    else grouped.set(key, { normalizedUrl, url: node.url, nodes: [node] });
  }

  const groups = [...grouped.values()];
  const results = new Array<LinkReachabilityResult>(groups.length);
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = Math.max(100, options.timeoutMs ?? 8000);
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 6));
  const now = options.now ?? (() => new Date().toISOString());
  let nextIndex = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (nextIndex < groups.length) {
      if (options.signal?.aborted) break;
      const index = nextIndex++;
      const group = groups[index];
      if (group) {
        const result = await checkGroup(repository, group, fetchFn, timeoutMs, now);
        results[index] = result;
        completed++;
        options.onProgress?.({
          total: groups.length,
          completed,
          currentResult: result,
          url: group.url,
          title: group.nodes[0]?.title,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, () => worker()));
  return results.filter(Boolean);
}

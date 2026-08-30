import { getFolderPath } from "./paths.js";
import { normalizeUrl } from "./url.js";
import type { BookmarkNode, BookmarkRepository } from "./types.js";

export interface DuplicateGroup {
  id: string;
  type: "exact" | "normalized";
  normalizedUrl: string;
  nodeIds: string[];
  titles: string[];
  folderPaths: string[];
  urls: string[];
}

export function detectDuplicates(repository: BookmarkRepository): DuplicateGroup[] {
  const groups = new Map<string, BookmarkNode[]>();
  for (const node of repository.nodes) {
    if (node.type !== "bookmark" || !node.url) continue;
    const key = normalizeUrl(node.url);
    if (!key) continue;
    const existing = groups.get(key) ?? [];
    existing.push(node);
    groups.set(key, existing);
  }

  let sequence = 0;
  return [...groups.entries()]
    .filter(([, nodes]) => nodes.length > 1)
    .map(([normalizedUrl, nodes]) => {
      const exact = new Set(nodes.map((node) => node.url));
      return {
        id: `duplicate-${++sequence}`,
        type: exact.size === 1 ? "exact" as const : "normalized" as const,
        normalizedUrl,
        nodeIds: nodes.map((node) => node.id),
        titles: nodes.map((node) => node.title),
        folderPaths: nodes.map((node) => getFolderPath(repository, node.id)),
        urls: nodes.map((node) => node.url ?? ""),
      };
    });
}

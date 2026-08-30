import { getNodeDepth, sortNodesForApply } from "./paths.js";
import { normalizeUrl } from "./url.js";
import type {
  BookmarkIdMapping,
  BookmarkIdMappingEntry,
  BookmarkRepository,
  BrowserAdapter,
  CanonicalizationResult,
} from "./types.js";

function mappingEntry(nodeId: string, browserBookmarkId: string, node: BookmarkRepository["nodes"][number], pathKey = ""): BookmarkIdMappingEntry {
  const entry: BookmarkIdMappingEntry = {
    canonicalId: nodeId,
    browserBookmarkId,
    browserType: node.type,
    title: node.title,
    pathKey,
  };
  if (node.url !== undefined) entry.normalizedUrl = normalizeUrl(node.url);
  return entry;
}

export interface ApplyRepositoryResult {
  mapping: BookmarkIdMapping;
}

export async function applyRepositoryToBrowser(
  adapter: BrowserAdapter,
  current: CanonicalizationResult,
  target: BookmarkRepository,
): Promise<ApplyRepositoryResult> {
  const targetById = new Map(target.nodes.map((node) => [node.id, node]));
  const currentById = new Map(current.repository.nodes.map((node) => [node.id, node]));
  const browserByCanonical = new Map(current.mapping.entries.map((entry) => [entry.canonicalId, entry.browserBookmarkId]));
  const targetIds = new Set(target.nodes.map((node) => node.id));

  const deletes = current.repository.nodes
    .filter((node) => !targetIds.has(node.id) && !node.rootKey)
    .sort((a, b) => getNodeDepth(current.repository, b) - getNodeDepth(current.repository, a));
  for (const node of deletes) {
    const browserId = browserByCanonical.get(node.id);
    if (browserId) await adapter.removeNode(browserId);
    browserByCanonical.delete(node.id);
  }

  const orderedTarget = sortNodesForApply(target);
  for (const node of orderedTarget) {
    if (node.rootKey) continue;
    if (browserByCanonical.has(node.id)) continue;
    const parentBrowserId = node.parentId ? browserByCanonical.get(node.parentId) : undefined;
    if (!parentBrowserId) throw new Error(`Cannot create ${node.id}: browser parent is missing`);
    const result = node.type === "folder"
      ? await adapter.createFolder({ parentBrowserId, title: node.title, index: node.order })
      : await adapter.createBookmark({ parentBrowserId, title: node.title, url: node.url ?? "", index: node.order });
    browserByCanonical.set(node.id, result.browserId);
  }

  for (const node of orderedTarget) {
    if (node.rootKey) continue;
    const browserId = browserByCanonical.get(node.id);
    if (!browserId) throw new Error(`Browser id is missing for ${node.id}`);
    const old = currentById.get(node.id);
    if (old && (old.title !== node.title || old.url !== node.url || old.type !== node.type)) {
      const changes: { title?: string; url?: string } = { title: node.title };
      if (node.type === "bookmark") changes.url = node.url ?? "";
      await adapter.updateBookmark(browserId, changes);
    }
    const parentBrowserId = node.parentId ? browserByCanonical.get(node.parentId) : undefined;
    if (parentBrowserId) {
      await adapter.moveNode(browserId, { parentBrowserId, index: node.order });
    }
  }

  const entries = current.mapping.entries.filter((entry) => targetById.has(entry.canonicalId));
  const entryById = new Map(entries.map((entry) => [entry.canonicalId, entry]));
  for (const node of target.nodes) {
    const browserId = browserByCanonical.get(node.id);
    if (!browserId) continue;
    const previous = entryById.get(node.id);
    const next = mappingEntry(node.id, browserId, node, previous?.pathKey ?? "");
    if (node.rootKey) next.rootKey = node.rootKey;
    entryById.set(node.id, next);
  }
  return { mapping: { schemaVersion: 1, entries: [...entryById.values()] } };
}

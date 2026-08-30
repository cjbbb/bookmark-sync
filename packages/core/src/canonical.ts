import { createId } from "./id.js";
import { getFolderPath, getNodeDepth } from "./paths.js";
import { normalizeUrl } from "./url.js";
import type {
  BookmarkIdMapping,
  BookmarkIdMappingEntry,
  BookmarkNode,
  BookmarkRepository,
  BrowserBookmarkNode,
  CanonicalizationResult,
  CanonicalizeOptions,
} from "./types.js";

interface FlattenedBrowserNode {
  node: BrowserBookmarkNode;
  pathKey: string;
}

function flattenTree(nodes: BrowserBookmarkNode[], parentPath = ""): FlattenedBrowserNode[] {
  const flattened: FlattenedBrowserNode[] = [];
  for (const node of nodes) {
    const ownPath = node.isRoot
      ? `root:${node.rootKey ?? node.browserId}`
      : parentPath ? `${parentPath}/${node.title}` : node.title;
    flattened.push({ node, pathKey: ownPath });
    if (node.children?.length) {
      flattened.push(...flattenTree(node.children, ownPath));
    }
  }
  return flattened;
}

function rootCanonicalId(rootKey: string): string {
  return `root:${rootKey}`;
}

function makeNodeId(
  node: BrowserBookmarkNode,
  pathKey: string,
  previousEntries: BookmarkIdMappingEntry[],
  usedIds: Set<string>,
  idFactory: () => string,
): string {
  if (node.isRoot || node.rootKey) {
    return rootCanonicalId(node.rootKey ?? node.browserId);
  }

  const normalized = node.url ? normalizeUrl(node.url) : undefined;
  const candidates = previousEntries
    .filter((entry) => !usedIds.has(entry.canonicalId) && entry.browserType === node.type)
    .map((entry) => {
      let score = 0;
      if (normalized && entry.normalizedUrl === normalized) score += 100;
      if (entry.title === node.title) score += 30;
      if (entry.pathKey === pathKey) score += 20;
      return { entry, score };
    })
    .sort((left, right) => right.score - left.score);
  const fallback = candidates[0];
  if (fallback && (fallback.score >= 100 || (fallback.score >= 50 && fallback.entry.pathKey === pathKey))) {
    return fallback.entry.canonicalId;
  }

  let nextId = idFactory();
  while (usedIds.has(nextId)) nextId = idFactory();
  return nextId;
}

export function canonicalizeBrowserTree(
  tree: BrowserBookmarkNode[],
  options: CanonicalizeOptions,
): CanonicalizationResult {
  const now = options.now ?? new Date().toISOString();
  const previousEntries = options.previousMapping?.entries ?? [];
  const previousByBrowserId = new Map(previousEntries.map((entry) => [entry.browserBookmarkId, entry]));
  const previousNodes = new Map((options.previousRepository?.nodes ?? []).map((node) => [node.id, node]));
  const flattened = flattenTree(tree);
  const browserToCanonical = new Map<string, string>();
  const usedIds = new Set<string>();
  const nodes: BookmarkNode[] = [];
  const entries: BookmarkIdMappingEntry[] = [];

  for (const { node, pathKey } of flattened) {
    const previous = previousByBrowserId.get(node.browserId);
    let canonicalId = previous && previous.browserType === node.type
      ? previous.canonicalId
      : makeNodeId(node, pathKey, previousEntries, usedIds, options.idFactory ?? createId);

    if (usedIds.has(canonicalId)) {
      canonicalId = makeNodeId(node, `${pathKey}:${node.browserId}`, previousEntries, usedIds, options.idFactory ?? createId);
    }
    usedIds.add(canonicalId);
    browserToCanonical.set(node.browserId, canonicalId);

    const parentId = node.parentBrowserId === null
      ? null
      : browserToCanonical.get(node.parentBrowserId) ?? null;
    const oldNode = previousNodes.get(canonicalId);
    const canonicalNode: BookmarkNode = {
      id: canonicalId,
      type: node.type,
      title: node.title,
      parentId,
      order: node.index,
      updatedAt: now,
    };
    if (node.url !== undefined) canonicalNode.url = node.url;
    if (oldNode?.createdAt !== undefined) canonicalNode.createdAt = oldNode.createdAt;
    else canonicalNode.createdAt = now;
    if (node.isRoot || node.rootKey) canonicalNode.rootKey = node.rootKey ?? node.browserId;
    nodes.push(canonicalNode);

    const mappingEntry: BookmarkIdMappingEntry = {
      canonicalId,
      browserBookmarkId: node.browserId,
      browserType: node.type,
      title: node.title,
      pathKey,
    };
    if (node.url !== undefined) mappingEntry.normalizedUrl = normalizeUrl(node.url);
    if (node.isRoot || node.rootKey) mappingEntry.rootKey = node.rootKey ?? node.browserId;
    entries.push(mappingEntry);
  }

  return {
    repository: {
      schemaVersion: 1,
      revision: options.revision ?? options.previousRepository?.revision ?? 0,
      updatedAt: now,
      updatedBy: options.deviceId,
      nodes,
    },
    mapping: {
      schemaVersion: 1,
      entries,
    },
  };
}

export function validateRepository(repository: BookmarkRepository): string[] {
  const errors: string[] = [];
  if (repository.schemaVersion !== 1) errors.push("Unsupported repository schema version");
  const ids = new Set<string>();
  for (const node of repository.nodes) {
    if (!node.id) errors.push("Node id is required");
    if (ids.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    ids.add(node.id);
    if (node.type === "bookmark" && !node.url) errors.push(`Bookmark ${node.id} is missing a URL`);
    if (node.type === "folder" && node.url !== undefined) errors.push(`Folder ${node.id} cannot have a URL`);
    if (node.parentId === node.id) errors.push(`Node ${node.id} cannot parent itself`);
  }
  for (const node of repository.nodes) {
    if (node.parentId && !ids.has(node.parentId)) errors.push(`Missing parent ${node.parentId} for ${node.id}`);
  }
  return errors;
}

/**
 * On a first two-way sync there may be no local mapping yet. Rebase matching
 * local nodes onto an existing canonical repository where the stable
 * bookmark identity is apparent, while preserving unmatched local additions.
 */
export function rebaseCanonicalIds(
  local: CanonicalizationResult,
  reference: BookmarkRepository,
): CanonicalizationResult {
  const usedReferenceIds = new Set<string>();
  const idMap = new Map<string, string>();
  const nodesToMatch = [...local.repository.nodes].sort((left, right) => {
    if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
    return getNodeDepth(local.repository, left) - getNodeDepth(local.repository, right);
  });
  for (const node of nodesToMatch) {
    const localPath = getFolderPath(local.repository, node.id);
    const mappedParentId = node.parentId ? idMap.get(node.parentId) : null;
    const candidates = reference.nodes
      .filter((candidate) => !usedReferenceIds.has(candidate.id) && candidate.type === node.type)
      .map((candidate) => {
        let score = 0;
        if (node.rootKey && candidate.rootKey === node.rootKey) score += 1000;
        if (node.title === candidate.title) score += 30;
        if (node.type === "bookmark" && node.url && candidate.url && normalizeUrl(node.url) === normalizeUrl(candidate.url)) score += 100;
        if (candidate.parentId === mappedParentId) score += 30;
        if (getFolderPath(reference, candidate.id) === localPath) score += 20;
        return { candidate, score };
      })
      .sort((left, right) => right.score - left.score);
    const best = candidates[0];
    const minimumScore = node.rootKey ? 1000 : node.type === "bookmark" ? 100 : 50;
    if (best && best.score >= minimumScore) {
      idMap.set(node.id, best.candidate.id);
      usedReferenceIds.add(best.candidate.id);
    }
  }

  if (!idMap.size) return local;
  const remappedNodes = local.repository.nodes.map((node) => {
    const remapped: BookmarkNode = { ...node, id: idMap.get(node.id) ?? node.id };
    if (remapped.parentId) remapped.parentId = idMap.get(remapped.parentId) ?? remapped.parentId;
    return remapped;
  });
  const remappedEntries = local.mapping.entries.map((entry) => ({
    ...entry,
    canonicalId: idMap.get(entry.canonicalId) ?? entry.canonicalId,
  }));
  return {
    repository: { ...local.repository, nodes: remappedNodes },
    mapping: { ...local.mapping, entries: remappedEntries },
  };
}

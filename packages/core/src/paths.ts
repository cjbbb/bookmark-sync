import type { BookmarkNode, BookmarkRepository } from "./types.js";

export function indexNodes(repository: BookmarkRepository): Map<string, BookmarkNode> {
  return new Map(repository.nodes.map((node) => [node.id, node]));
}

export function getFolderPath(repository: BookmarkRepository, nodeId: string): string {
  const byId = indexNodes(repository);
  const segments: string[] = [];
  let current = byId.get(nodeId);
  const visited = new Set<string>();

  while (current && current.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    if (parent.title) segments.unshift(parent.title);
    current = parent;
  }

  return segments.join("/");
}

export function getNodeDepth(repository: BookmarkRepository, node: BookmarkNode): number {
  const byId = indexNodes(repository);
  let depth = 0;
  let parentId = node.parentId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    depth += 1;
    parentId = parent.parentId;
  }
  return depth;
}

export function getFolderByPath(repository: BookmarkRepository, path: string): BookmarkNode | undefined {
  const wanted = path.split("/").filter(Boolean);
  if (!wanted.length) return undefined;

  return repository.nodes.find((node) => {
    if (node.type !== "folder" || node.title !== wanted[wanted.length - 1]) return false;
    const actual = getFolderPath(repository, node.id).split("/").filter(Boolean);
    return actual.length === wanted.length - 1 && actual.every((part, index) => part === wanted[index]);
  });
}

export function sortNodesForApply(repository: BookmarkRepository): BookmarkNode[] {
  const byParent = new Map<string | null, BookmarkNode[]>();
  for (const node of repository.nodes) {
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  }

  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }

  const result: BookmarkNode[] = [];
  const visit = (parentId: string | null) => {
    for (const node of byParent.get(parentId) ?? []) {
      result.push(node);
      if (node.type === "folder") visit(node.id);
    }
  };
  visit(null);
  return result;
}

export function normalizeSiblingOrders(nodes: BookmarkNode[]): BookmarkNode[] {
  const nextOrder = new Map<string | null, number>();
  return [...nodes]
    .sort((a, b) => a.parentId === b.parentId ? a.order - b.order : a.parentId?.localeCompare(b.parentId ?? "") ?? -1)
    .map((node) => {
      const order = nextOrder.get(node.parentId) ?? 0;
      nextOrder.set(node.parentId, order + 1);
      return { ...node, order };
    });
}

import { getNodeDepth } from "./paths.js";
import type { BookmarkNode, BookmarkRepository, Change } from "./types.js";

function sameValue(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

export function sameNodeContent(left: BookmarkNode, right: BookmarkNode): boolean {
  return left.type === right.type &&
    left.title === right.title &&
    sameValue(left.url, right.url);
}

export function sameNodePlacement(left: BookmarkNode, right: BookmarkNode): boolean {
  return left.parentId === right.parentId && left.order === right.order;
}

export function sameNode(left: BookmarkNode, right: BookmarkNode): boolean {
  return sameNodeContent(left, right) && sameNodePlacement(left, right);
}

export function diffRepositories(from: BookmarkRepository, to: BookmarkRepository): Change[] {
  const fromById = new Map(from.nodes.map((node) => [node.id, node]));
  const toById = new Map(to.nodes.map((node) => [node.id, node]));
  const creates: Change[] = [];
  const updates: Change[] = [];
  const moves: Change[] = [];
  const deletes: Change[] = [];

  for (const node of to.nodes) {
    const before = fromById.get(node.id);
    if (!before) {
      creates.push({ kind: "create", nodeId: node.id, after: node });
      continue;
    }
    if (!sameNodeContent(before, node)) updates.push({ kind: "update", nodeId: node.id, before, after: node });
    if (!sameNodePlacement(before, node)) moves.push({ kind: "move", nodeId: node.id, before, after: node });
  }

  for (const node of from.nodes) {
    if (!toById.has(node.id)) deletes.push({ kind: "delete", nodeId: node.id, before: node });
  }

  const byDepthAscending = (a: Change, b: Change) => {
    const aNode = a.after ?? a.before;
    const bNode = b.after ?? b.before;
    if (!aNode || !bNode) return 0;
    return getNodeDepth(to, aNode) - getNodeDepth(to, bNode) || aNode.order - bNode.order;
  };
  const byDepthDescending = (a: Change, b: Change) => -byDepthAscending(a, b);
  return [
    ...creates.sort(byDepthAscending),
    ...updates.sort(byDepthAscending),
    ...moves.sort(byDepthAscending),
    ...deletes.sort(byDepthDescending),
  ];
}

export function emptyRepository(updatedBy = "system", now = new Date().toISOString()): BookmarkRepository {
  return { schemaVersion: 1, revision: 0, updatedAt: now, updatedBy, nodes: [] };
}

export function countNodeTypes(repository: BookmarkRepository): { bookmarks: number; folders: number } {
  return repository.nodes.reduce(
    (counts, node) => {
      if (node.type === "folder") counts.folders += 1;
      else counts.bookmarks += 1;
      return counts;
    },
    { bookmarks: 0, folders: 0 },
  );
}

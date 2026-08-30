import { sameNode, sameNodeContent, sameNodePlacement } from "./diff.js";
import { normalizeSiblingOrders } from "./paths.js";
import type {
  BookmarkNode,
  BookmarkRepository,
  SyncConflict,
  SyncConflictType,
} from "./types.js";

export interface MergeResult {
  repository: BookmarkRepository;
  conflicts: SyncConflict[];
}

function changedContentFields(base: BookmarkNode, value: BookmarkNode): Set<"type" | "title" | "url"> {
  const changed = new Set<"type" | "title" | "url">();
  if (base.type !== value.type) changed.add("type");
  if (base.title !== value.title) changed.add("title");
  if (base.url !== value.url) changed.add("url");
  return changed;
}

function isMoveChanged(base: BookmarkNode, value: BookmarkNode): boolean {
  return !sameNodePlacement(base, value);
}

function conflictTypeForChanges(base: BookmarkNode, local: BookmarkNode, remote: BookmarkNode): SyncConflictType {
  const localMoved = isMoveChanged(base, local);
  const remoteMoved = isMoveChanged(base, remote);
  return localMoved && remoteMoved ? "move_move" : "edit_edit";
}

function cloneNode(node: BookmarkNode): BookmarkNode {
  return { ...node };
}

function mergePresentNodes(base: BookmarkNode, local: BookmarkNode, remote: BookmarkNode): {
  node: BookmarkNode;
  conflict?: SyncConflict;
} {
  if (sameNode(local, remote)) return { node: cloneNode(local) };
  const localChanged = !sameNode(local, base);
  const remoteChanged = !sameNode(remote, base);
  if (!localChanged) return { node: cloneNode(remote) };
  if (!remoteChanged) return { node: cloneNode(local) };

  const localFields = changedContentFields(base, local);
  const remoteFields = changedContentFields(base, remote);
  const overlapping = [...localFields].filter((field) => remoteFields.has(field));
  const conflictingFields = overlapping.filter((field) => local[field] !== remote[field]);
  const localMoved = isMoveChanged(base, local);
  const remoteMoved = isMoveChanged(base, remote);
  const moveConflict = localMoved && remoteMoved && !sameNodePlacement(local, remote);

  if (conflictingFields.length || moveConflict) {
    return {
      node: cloneNode(local),
      conflict: {
        nodeId: base.id,
        type: moveConflict ? "move_move" : conflictTypeForChanges(base, local, remote),
        base: cloneNode(base),
        local: cloneNode(local),
        remote: cloneNode(remote),
      },
    };
  }

  const merged: BookmarkNode = cloneNode(base);
  for (const field of localFields) {
    if (field === "type") merged.type = local.type;
    if (field === "title") merged.title = local.title;
    if (field === "url") {
      if (local.url === undefined) delete merged.url;
      else merged.url = local.url;
    }
  }
  for (const field of remoteFields) {
    if (field === "type") merged.type = remote.type;
    if (field === "title") merged.title = remote.title;
    if (field === "url") {
      if (remote.url === undefined) delete merged.url;
      else merged.url = remote.url;
    }
  }
  if (localMoved) {
    merged.parentId = local.parentId;
    merged.order = local.order;
  }
  if (remoteMoved) {
    merged.parentId = remote.parentId;
    merged.order = remote.order;
  }
  return { node: merged };
}

function deletionConflict(
  base: BookmarkNode,
  surviving: BookmarkNode,
  deletedSide: "local" | "remote",
): SyncConflict | undefined {
  if (sameNode(base, surviving)) return undefined;
  const type: SyncConflictType = isMoveChanged(base, surviving) ? "delete_move" : "delete_edit";
  return {
    nodeId: base.id,
    type,
    base: cloneNode(base),
    ...(deletedSide === "local" ? { remote: cloneNode(surviving) } : { local: cloneNode(surviving) }),
  };
}

export function mergeRepositories(
  base: BookmarkRepository,
  local: BookmarkRepository,
  remote: BookmarkRepository,
  updatedBy = local.updatedBy,
  now = new Date().toISOString(),
): MergeResult {
  const baseById = new Map(base.nodes.map((node) => [node.id, node]));
  const localById = new Map(local.nodes.map((node) => [node.id, node]));
  const remoteById = new Map(remote.nodes.map((node) => [node.id, node]));
  const allIds = new Set([...baseById.keys(), ...localById.keys(), ...remoteById.keys()]);
  const mergedNodes: BookmarkNode[] = [];
  const conflicts: SyncConflict[] = [];

  for (const id of allIds) {
    const baseNode = baseById.get(id);
    const localNode = localById.get(id);
    const remoteNode = remoteById.get(id);
    if (!baseNode) {
      if (localNode && remoteNode) {
        if (sameNode(localNode, remoteNode)) mergedNodes.push(cloneNode(localNode));
        else {
          conflicts.push({
            nodeId: id,
            type: "edit_edit",
            local: cloneNode(localNode),
            remote: cloneNode(remoteNode),
          });
          mergedNodes.push(cloneNode(localNode));
        }
      } else if (localNode) mergedNodes.push(cloneNode(localNode));
      else if (remoteNode) mergedNodes.push(cloneNode(remoteNode));
      continue;
    }

    if (!localNode && !remoteNode) continue;
    if (!localNode && remoteNode) {
      const conflict = deletionConflict(baseNode, remoteNode, "local");
      if (conflict) conflicts.push(conflict);
      else continue;
      mergedNodes.push(cloneNode(remoteNode));
      continue;
    }
    if (localNode && !remoteNode) {
      const conflict = deletionConflict(baseNode, localNode, "remote");
      if (conflict) conflicts.push(conflict);
      else continue;
      mergedNodes.push(cloneNode(localNode));
      continue;
    }

    if (!localNode || !remoteNode) continue;
    const result = mergePresentNodes(baseNode, localNode, remoteNode);
    mergedNodes.push(result.node);
    if (result.conflict) conflicts.push(result.conflict);
  }

  const cleaned = mergedNodes.filter((node) => !node.parentId || mergedNodes.some((parent) => parent.id === node.parentId));
  const repository: BookmarkRepository = {
    schemaVersion: 1,
    revision: Math.max(local.revision, remote.revision, base.revision) + 1,
    updatedAt: now,
    updatedBy,
    nodes: normalizeSiblingOrders(cleaned),
  };
  return { repository, conflicts };
}

export function applyConflictDecisions(
  merge: MergeResult,
  decisions: Record<string, "local" | "remote">,
  updatedBy = merge.repository.updatedBy,
  now = new Date().toISOString(),
): BookmarkRepository {
  const nodesById = new Map(merge.repository.nodes.map((node) => [node.id, node]));
  for (const conflict of merge.conflicts) {
    const choice = decisions[conflict.nodeId];
    if (!choice) continue;
    const selected = choice === "local" ? conflict.local : conflict.remote;
    if (selected) nodesById.set(conflict.nodeId, cloneNode(selected));
    else nodesById.delete(conflict.nodeId);
  }
  const nodes = [...nodesById.values()].filter((node) => !node.parentId || nodesById.has(node.parentId));
  return {
    ...merge.repository,
    revision: merge.repository.revision + 1,
    updatedAt: now,
    updatedBy,
    nodes: normalizeSiblingOrders(nodes),
  };
}

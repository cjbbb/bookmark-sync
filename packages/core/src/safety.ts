import { diffRepositories } from "./diff.js";
import type { BookmarkRepository, DestructiveChangeReport } from "./types.js";

export interface DestructiveChangeOptions {
  minimumPreviousNodes?: number;
  deletionRatio?: number;
}

export function analyzeDestructiveChange(
  previous: BookmarkRepository,
  next: BookmarkRepository,
  options: DestructiveChangeOptions = {},
): DestructiveChangeReport {
  const minimumPreviousNodes = options.minimumPreviousNodes ?? 20;
  const deletionRatio = options.deletionRatio ?? 0.3;
  const deletes = diffRepositories(previous, next).filter((change) => change.kind === "delete");
  const deletedBookmarks = deletes.filter((change) => change.before?.type === "bookmark").length;
  const deletedFolders = deletes.filter((change) => change.before?.type === "folder").length;
  const deletedNodes = deletes.length;
  const previousNodes = previous.nodes.length;
  const nextNodes = next.nodes.length;
  const reasons: string[] = [];

  if (previousNodes >= minimumPreviousNodes && nextNodes < previousNodes * (1 - deletionRatio)) {
    reasons.push(`The snapshot shrinks from ${previousNodes} nodes to ${nextNodes}`);
  }
  if (previousNodes >= minimumPreviousNodes && deletedNodes > previousNodes * deletionRatio) {
    reasons.push(`${deletedNodes} of ${previousNodes} nodes would be deleted`);
  }

  return {
    requiresConfirmation: reasons.length > 0,
    deletedBookmarks,
    deletedFolders,
    deletedNodes,
    previousNodes,
    nextNodes,
    reasons,
  };
}

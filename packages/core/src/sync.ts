import { diffRepositories, emptyRepository } from "./diff.js";
import { applyConflictDecisions, mergeRepositories } from "./merge.js";
import { analyzeDestructiveChange } from "./safety.js";
import type {
  BookmarkRepository,
  Change,
  DestructiveChangeReport,
  SyncConflict,
  SyncMode,
  SyncPlan,
} from "./types.js";

function categorize(changes: Change[]): Pick<SyncPlan, "creates" | "updates" | "moves" | "deletes"> {
  return {
    creates: changes.filter((change) => change.kind === "create"),
    updates: changes.filter((change) => change.kind === "update"),
    moves: changes.filter((change) => change.kind === "move"),
    deletes: changes.filter((change) => change.kind === "delete"),
  };
}

function unchangedDestructive(repository: BookmarkRepository): DestructiveChangeReport {
  return {
    requiresConfirmation: false,
    deletedBookmarks: 0,
    deletedFolders: 0,
    deletedNodes: 0,
    previousNodes: repository.nodes.length,
    nextNodes: repository.nodes.length,
    reasons: [],
  };
}

export interface SyncCalculationInput {
  mode: SyncMode;
  local: BookmarkRepository;
  remote?: BookmarkRepository | null;
  base?: BookmarkRepository | null;
  updatedBy?: string;
  now?: string;
  conflictDecisions?: Record<string, "local" | "remote">;
}

export interface ExtendedSyncPlan extends SyncPlan {
  localChanges: Change[];
  mergeConflicts: SyncConflict[];
}

export function calculateSyncPlan(input: SyncCalculationInput): ExtendedSyncPlan {
  const now = input.now ?? new Date().toISOString();
  const updatedBy = input.updatedBy ?? input.local.updatedBy;
  const remote = input.remote ?? emptyRepository("remote", now);
  const base = input.base ?? input.local;
  const hasRemote = input.remote !== undefined && input.remote !== null;
  let target: BookmarkRepository;
  let localChanges: Change[];
  let remoteChanges: Change[];
  let conflicts: SyncConflict[] = [];

  if (!hasRemote) {
    target = { ...input.local, revision: Math.max(input.local.revision, remote.revision) + 1, updatedAt: now, updatedBy };
    localChanges = [];
    remoteChanges = diffRepositories(remote, target);
  } else if (input.mode === "publish") {
    target = { ...input.local, revision: Math.max(input.local.revision, remote.revision) + 1, updatedAt: now, updatedBy };
    localChanges = [];
    remoteChanges = diffRepositories(remote, target);
  } else if (input.mode === "mirror") {
    target = { ...remote, updatedAt: now, updatedBy };
    localChanges = diffRepositories(input.local, target);
    remoteChanges = [];
  } else {
    const merge = mergeRepositories(base, input.local, remote, updatedBy, now);
    const decisions = input.conflictDecisions ?? {};
    const unresolved = merge.conflicts.filter((conflict) => !decisions[conflict.nodeId]);
    target = unresolved.length ? merge.repository : applyConflictDecisions(merge, decisions, updatedBy, now);
    conflicts = unresolved;
    localChanges = diffRepositories(input.local, target);
    remoteChanges = diffRepositories(remote, target);
  }

  const primaryFrom = input.mode === "publish" ? remote : input.local;
  const primaryChanges = input.mode === "publish" ? remoteChanges : localChanges;
  const primaryDestructive = analyzeDestructiveChange(primaryFrom, target);
  const remoteDestructive = input.mode === "publish" || input.mode === "two-way"
    ? analyzeDestructiveChange(remote, target)
    : unchangedDestructive(remote);
  const categories = categorize(primaryChanges);
  return {
    mode: input.mode,
    target,
    ...categories,
    conflicts,
    remoteChanges,
    destructive: primaryDestructive,
    remoteDestructive,
    hasChanges: primaryChanges.length > 0 || remoteChanges.length > 0 || conflicts.length > 0,
    localChanges,
    mergeConflicts: conflicts,
  };
}

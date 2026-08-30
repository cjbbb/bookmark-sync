import {
  applyRepositoryToBrowser,
  buildOrganizerRequest,
  calculateSyncPlan,
  canonicalizeBrowserTree,
  checkBookmarkReachability,
  checkSingleBookmarkReachability,
  createId,
  detectDuplicates,
  diffRepositories,
  emptyRepository,
  getFolderByPath,
  getFolderPath,
  normalizeUrl,
  normalizeSiblingOrders,
  OpenAICompatibleProvider,
  rebaseCanonicalIds,
  validateOrganizerResult,
  analyzeDestructiveChange,
  type BookmarkNode,
  type BookmarkRepository,
  type BrowserAdapter,
  type CanonicalizationResult,
  type Change,
  type OrganizerSuggestion,
  type StorageAdapter,
  type SyncConflict,
} from "@bookmark-sync/core";
import { ChromiumBrowserAdapter, type ChromiumBookmarksApi, type ChromiumRawBookmarkNode } from "@bookmark-sync/browser-adapters";
import { GitHubStorageAdapter, LocalStorageAdapter, SelfHostedStorageAdapter, WebDAVStorageAdapter } from "@bookmark-sync/storage-adapters";
import { loadState, saveState, type ExtensionSettings, type ExtensionState, type SafetySnapshot, type SyncSourceMetadata } from "./app-state.js";
import { store } from "./store.js";

const DEBOUNCE_ALARM = "bookmark-sync-debounced";
const PERIODIC_ALARM = "bookmark-sync-periodic";
const STALE_LOCK_MS = 5 * 60 * 1000;

let syncInMemory = false;
let suppressEvents = false;

function browserApi(): ChromiumBookmarksApi {
  return {
    getTree: () => chrome.bookmarks.getTree() as Promise<ChromiumRawBookmarkNode[]>,
    create: async (details) => {
      const node = await chrome.bookmarks.create(details);
      return { id: node.id };
    },
    update: async (id, changes) => {
      await chrome.bookmarks.update(id, changes);
    },
    move: async (id, destination) => {
      await chrome.bookmarks.move(id, destination);
    },
    removeTree: async (id) => {
      await chrome.bookmarks.removeTree(id);
    },
  };
}

const browser: BrowserAdapter = new ChromiumBrowserAdapter(browserApi());

function cloneRepository(repository: BookmarkRepository): BookmarkRepository {
  return JSON.parse(JSON.stringify(repository)) as BookmarkRepository;
}

function countNodes(repository: BookmarkRepository): { bookmarks: number; folders: number } {
  return repository.nodes.reduce((counts, node) => {
    if (node.type === "folder") counts.folders += 1;
    else counts.bookmarks += 1;
    return counts;
  }, { bookmarks: 0, folders: 0 });
}

function countSummary(repository: BookmarkRepository): { bookmarks: number; folders: number; total: number } {
  return { ...countNodes(repository), total: repository.nodes.length };
}

function reachabilityKey(url: string): string {
  return normalizeUrl(url) || url.trim();
}

function serializeConflict(conflict: SyncConflict): Record<string, unknown> {
  return {
    nodeId: conflict.nodeId,
    type: conflict.type,
    base: conflict.base,
    local: conflict.local,
    remote: conflict.remote,
  };
}

function serializeChange(change: Change, before: BookmarkRepository, after: BookmarkRepository): Record<string, unknown> {
  const beforeNode = change.before;
  const afterNode = change.after;
  return {
    kind: change.kind,
    nodeId: change.nodeId,
    type: afterNode?.type ?? beforeNode?.type ?? "bookmark",
    title: afterNode?.title ?? beforeNode?.title ?? "",
    url: afterNode?.url ?? beforeNode?.url,
    beforePath: beforeNode ? getFolderPath(before, beforeNode.id) : null,
    afterPath: afterNode ? getFolderPath(after, afterNode.id) : null,
  };
}

function serializePlanSide(
  changes: Change[],
  before: BookmarkRepository,
  after: BookmarkRepository,
  destructive: ReturnType<typeof analyzeDestructiveChange>,
): Record<string, unknown> {
  const counts = {
    creates: changes.filter((change) => change.kind === "create").length,
    updates: changes.filter((change) => change.kind === "update").length,
    moves: changes.filter((change) => change.kind === "move").length,
    deletes: changes.filter((change) => change.kind === "delete").length,
  };
  const deletionPaths = changes
    .filter((change) => change.kind === "delete" && change.before)
    .map((change) => {
      const node = change.before!;
      return {
        nodeId: node.id,
        type: node.type,
        title: node.title,
        url: node.url,
        path: getFolderPath(before, node.id),
      };
    });
  return {
    ...counts,
    totalChanges: changes.length,
    before: countSummary(before),
    after: countSummary(after),
    destructive,
    changes: changes.map((change) => serializeChange(change, before, after)),
    deletionPaths,
  };
}

function serializeSource(repository: BookmarkRepository | null | undefined): Record<string, unknown> | null {
  if (!repository) return null;
  return {
    device: repository.updatedBy,
    updatedAt: repository.updatedAt,
    revision: repository.revision,
  };
}

function sourceMetadata(repository: BookmarkRepository | null | undefined): SyncSourceMetadata | null {
  if (!repository) return null;
  return {
    device: repository.updatedBy,
    updatedAt: repository.updatedAt,
    revision: repository.revision,
  };
}

type PlanSerializationContext = {
  local: BookmarkRepository;
  remote: BookmarkRepository | null;
  base: BookmarkRepository | null;
  localChanges?: Change[];
  snapshotStatus: "not_required" | "will_create" | "created" | "blocked";
  snapshotReason: string | null;
};

function serializePlan(plan: ReturnType<typeof calculateSyncPlan>, context: PlanSerializationContext) {
  const remote = context.remote ?? emptyRepository("remote", plan.target.updatedAt);
  const base = context.base ?? emptyRepository("base", plan.target.updatedAt);
  const localChanges = context.localChanges ?? plan.localChanges;
  return {
    mode: plan.mode,
    hasChanges: plan.hasChanges,
    creates: plan.creates.length,
    updates: plan.updates.length,
    moves: plan.moves.length,
    deletes: plan.deletes.length,
    conflicts: plan.conflicts.map(serializeConflict),
    destructive: plan.destructive,
    remoteDestructive: plan.remoteDestructive,
    targetCounts: countNodes(plan.target),
    local: serializePlanSide(localChanges, context.local, plan.target, plan.destructive),
    remote: serializePlanSide(plan.remoteChanges, remote, plan.target, plan.remoteDestructive),
    sources: {
      base: serializeSource(context.base ? base : null),
      local: serializeSource(context.local),
      remote: serializeSource(context.remote),
    },
    snapshot: {
      status: context.snapshotStatus,
      reason: context.snapshotReason ?? null,
    },
  };
}

function createStorage(settings: ExtensionSettings): StorageAdapter {
  if (settings.provider === "local") return new LocalStorageAdapter(store, "bookmark-sync-local-provider");
  if (settings.provider === "github") {
    const config = settings.github;
    if (!config.token || !config.owner || !config.repository || !config.branch || !config.filePath) {
      throw new Error("GitHub provider is not fully configured");
    }
    return new GitHubStorageAdapter(config);
  }
  if (settings.provider === "webdav") {
    const config = settings.webdav;
    if (!config.url) {
      throw new Error("WebDAV provider is not fully configured (URL is required)");
    }
    return new WebDAVStorageAdapter(config);
  }
  if (!settings.selfHosted.serverUrl || !settings.selfHosted.apiToken) {
    throw new Error("Self-hosted provider is not fully configured");
  }
  return new SelfHostedStorageAdapter(settings.selfHosted);
}

async function readLocal(state: ExtensionState, override?: BookmarkRepository): Promise<CanonicalizationResult> {
  const tree = await browser.readTree();
  const current = canonicalizeBrowserTree(tree, {
    deviceId: state.deviceId,
    previousMapping: state.mapping,
    previousRepository: state.lastSyncedSnapshot,
  });
  if (override) return { ...current, repository: override };
  return current;
}

function saveSafetySnapshot(state: ExtensionState, repository: BookmarkRepository, reason: string): void {
  const snapshot: SafetySnapshot = {
    id: `safety-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    reason,
    repository: cloneRepository(repository),
  };
  state.safetySnapshots = [snapshot, ...state.safetySnapshots].slice(0, 10);
}

function bootstrapPlan(
  mode: ExtensionSettings["mode"],
  local: BookmarkRepository,
  now: string,
  deviceId: string,
) {
  const plan = calculateSyncPlan({ mode: "publish", local, remote: emptyRepository("remote", now), updatedBy: deviceId, now });
  return { ...plan, mode };
}

interface SyncOptions {
  confirm?: boolean;
  preview?: boolean;
  decisions?: Record<string, "local" | "remote">;
  localOverride?: BookmarkRepository;
}

async function syncNow(options: SyncOptions = {}): Promise<Record<string, unknown>> {
  if (syncInMemory) return { ok: false, status: "busy", message: "A sync is already running." };
  syncInMemory = true;
  let state = await loadState();
  const startedAt = new Date().toISOString();
  if (state.syncInProgress && state.syncStartedAt && Date.now() - Date.parse(state.syncStartedAt) < STALE_LOCK_MS) {
    syncInMemory = false;
    return { ok: false, status: "busy", message: "A sync is already running." };
  }
  state.syncInProgress = true;
  state.syncStartedAt = startedAt;
  await saveState(state);

  try {
    const now = new Date().toISOString();
    // Keep the actual browser projection separate from an optional local
    // override. Organizer suggestions are calculated as an override, so the
    // sync plan quite correctly sees them as already present in `local`, but
    // the browser itself still needs to receive those changes.
    let browserProjection = await readLocal(state);
    let localProjection = options.localOverride
      ? { ...browserProjection, repository: options.localOverride }
      : browserProjection;
    const storage = createStorage(state.settings);
    const remoteState = await storage.pull();
    const remote = remoteState?.repository ?? null;
    if (remote && !state.lastSyncedSnapshot && state.settings.mode === "two-way") {
      browserProjection = rebaseCanonicalIds(browserProjection, remote);
      localProjection = options.localOverride
        ? rebaseCanonicalIds(localProjection, remote)
        : browserProjection;
    }
    // With no shared snapshot yet, an empty base makes unmatched bookmarks on
    // both sides independent additions. Using local as the base incorrectly
    // interprets local-only bookmarks as remote deletions.
    const base = state.lastSyncedSnapshot ?? (state.settings.mode === "two-way" ? emptyRepository("initial-sync", now) : remote);
    let plan: ReturnType<typeof calculateSyncPlan>;
    if (remote) {
      const calculation = {
        mode: state.settings.mode,
        local: localProjection.repository,
        remote,
        base,
        updatedBy: state.deviceId,
        now,
      } as Parameters<typeof calculateSyncPlan>[0];
      if (options.decisions !== undefined) calculation.conflictDecisions = options.decisions;
      plan = calculateSyncPlan(calculation);
    } else {
      plan = bootstrapPlan(state.settings.mode, localProjection.repository, now, state.deviceId);
    }

    const browserProjectionChanges = diffRepositories(browserProjection.repository, plan.target);
    const browserDestructive = analyzeDestructiveChange(browserProjection.repository, plan.target);
    const effectiveLocalDestructive = browserDestructive.deletedNodes > 0 || browserDestructive.requiresConfirmation
      ? {
          ...browserDestructive,
          requiresConfirmation: browserDestructive.requiresConfirmation || plan.destructive.requiresConfirmation,
          reasons: [...new Set([...plan.destructive.reasons, ...browserDestructive.reasons])],
        }
      : plan.destructive;
    const effectivePlan = { ...plan, destructive: effectiveLocalDestructive };
    const dangerous = effectivePlan.destructive.requiresConfirmation || plan.remoteDestructive.requiresConfirmation;
    const hasDeletes = browserProjectionChanges.some((change) => change.kind === "delete") ||
      plan.localChanges.some((change) => change.kind === "delete") ||
      plan.remoteChanges.some((change) => change.kind === "delete");
    const snapshotRequired = dangerous || hasDeletes || state.settings.mode === "mirror";
    const snapshotReason = state.settings.mode === "mirror"
      ? "Before a Mirror sync"
      : dangerous || hasDeletes
        ? "Before a destructive sync"
        : undefined;
    const serializationContext = (snapshotStatus: PlanSerializationContext["snapshotStatus"]): PlanSerializationContext => ({
      local: browserProjection.repository,
      remote,
      base,
      localChanges: browserProjectionChanges,
      snapshotStatus,
      snapshotReason: snapshotReason ?? null,
    });

    if (plan.conflicts.length) {
      state.lastSyncStatus = "conflict";
      state.pendingConflicts = plan.conflicts;
      state.pendingConflictSources = {
        base: sourceMetadata(base),
        local: sourceMetadata(browserProjection.repository),
        remote: sourceMetadata(remote),
      };
      state.lastSyncError = null;
      await saveState(state);
      return { ok: false, status: "conflict", plan: serializePlan(effectivePlan, serializationContext("blocked")) };
    }

    if (dangerous && !options.confirm) {
      state.lastSyncStatus = "confirmation_required";
      state.lastSyncError = null;
      await saveState(state);
      return {
        ok: false,
        status: "confirmation_required",
        plan: serializePlan(effectivePlan, serializationContext("will_create")),
      };
    }

    if (options.preview) {
      return {
        ok: false,
        status: "preview",
        plan: serializePlan(effectivePlan, serializationContext(snapshotRequired ? "will_create" : "not_required")),
      };
    }

    if (snapshotRequired) {
      saveSafetySnapshot(state, browserProjection.repository, snapshotReason ?? "Before a sync");
    }
    suppressEvents = true;
    let mapping = browserProjection.mapping;
    // `plan.localChanges` compares the projected local repository with the
    // target. When a suggestion is passed as `localOverride`, that comparison
    // intentionally excludes the suggestion itself. Compare against the
    // actual browser projection so accepted create-folder and move suggestions
    // are materialized in every sync mode.
    if (diffRepositories(browserProjection.repository, plan.target).length) {
      const applied = await applyRepositoryToBrowser(browser, browserProjection, plan.target);
      mapping = applied.mapping;
      mapping = canonicalizeBrowserTree(await browser.readTree(), {
        deviceId: state.deviceId,
        previousMapping: mapping,
        previousRepository: plan.target,
      }).mapping;
    }

    let finalRepository = plan.target;
    const shouldPush = !remote ||
      ((state.settings.mode === "publish" || state.settings.mode === "two-way") && plan.remoteChanges.length > 0);
    if (shouldPush) {
      const pushed = await storage.push(plan.target, {
        message: `Bookmark sync revision ${plan.target.revision}`,
        author: state.deviceId,
      });
      finalRepository = { ...plan.target, revision: pushed.revision, updatedAt: pushed.createdAt };
    } else if (remote) {
      finalRepository = remote;
    }
    state.mapping = mapping;
    state.lastSyncedSnapshot = finalRepository;
    state.lastSyncAt = finalRepository.updatedAt;
    state.lastSyncStatus = "synced";
    state.lastSyncError = null;
    state.pendingConflicts = [];
    state.pendingConflictSources = null;
    const counts = countNodes(finalRepository);
    state.lastSyncStats = { ...counts, changes: browserProjectionChanges.length + plan.remoteChanges.length };
    await saveState(state);
    return {
      ok: true,
      status: "synced",
      plan: serializePlan(effectivePlan, serializationContext(snapshotRequired ? "created" : "not_required")),
      updatedAt: finalRepository.updatedAt,
    };
  } catch (error) {
    state.lastSyncStatus = "error";
    state.lastSyncError = error instanceof Error ? error.message : String(error);
    await saveState(state);
    return { ok: false, status: "error", message: state.lastSyncError };
  } finally {
    suppressEvents = false;
    try {
      // Reload before releasing the lock so settings changed while a long sync
      // was running are not overwritten by this operation's stale state copy.
      const latest = await loadState();
      latest.syncInProgress = false;
      latest.syncStartedAt = null;
      await saveState(latest);
    } finally {
      syncInMemory = false;
    }
  }
}

function settingsPatch(current: ExtensionSettings, patch: Partial<ExtensionSettings>): ExtensionSettings {
  return {
    ...current,
    ...patch,
    github: { ...current.github, ...(patch.github ?? {}) },
    selfHosted: { ...current.selfHosted, ...(patch.selfHosted ?? {}) },
    webdav: { ...current.webdav, ...(patch.webdav ?? {}) },
    ai: { ...current.ai, ...(patch.ai ?? {}) },
  };
}

async function configureAlarms(): Promise<void> {
  const state = await loadState();
  await chrome.alarms.clear(PERIODIC_ALARM);
  const periods: Record<Exclude<ExtensionSettings["autoSync"], "off">, number> = { "5m": 5, "15m": 15, "1h": 60 };
  if (state.settings.autoSync !== "off") {
    await chrome.alarms.create(PERIODIC_ALARM, { periodInMinutes: periods[state.settings.autoSync] });
  }
}

function scheduleChangeSync(): void {
  if (suppressEvents || syncInMemory) return;
  void loadState().then((state) => {
    if (!state.settings.syncOnBookmarkChange) return;
    void chrome.alarms.create(DEBOUNCE_ALARM, { delayInMinutes: 0.05 });
  });
}

function folderByPath(repository: BookmarkRepository, path: string): BookmarkNode | undefined {
  return getFolderByPath(repository, path);
}

function ensureFolderPath(repository: BookmarkRepository, path: string): { repository: BookmarkRepository; folder: BookmarkNode } {
  const parts = path.split("/").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error("A folder path is required");
  let next = cloneRepository(repository);
  let parentId: string | null = next.nodes.find((node) => node.rootKey === "browser-root")?.id ?? null;
  let current: BookmarkNode | undefined;
  for (const part of parts) {
    current = next.nodes.find((node) => node.type === "folder" && node.title === part && node.parentId === parentId);
    if (!current) {
      const siblingOrders = next.nodes.filter((node) => node.parentId === parentId).map((node) => node.order);
      current = { id: createId(), type: "folder", title: part, parentId, order: siblingOrders.length ? Math.max(...siblingOrders) + 1 : 0 };
      next.nodes.push(current);
    }
    parentId = current.id;
  }
  if (!current) throw new Error(`Cannot create folder ${path}`);
  return { repository: next, folder: current };
}

function applySuggestion(repository: BookmarkRepository, suggestion: OrganizerSuggestion): BookmarkRepository {
  if (suggestion.kind === "semantic-duplicate" || suggestion.kind === "merge-folder") {
    throw new Error("This suggestion is informational and cannot be applied automatically");
  }
  let next = cloneRepository(repository);
  if (suggestion.kind === "create-folder") {
    if (!suggestion.targetFolderPath) throw new Error("Folder suggestion has no target path");
    next = ensureFolderPath(next, suggestion.targetFolderPath).repository;
  } else {
    if (!suggestion.nodeId || !suggestion.targetFolderPath) throw new Error("Move suggestion is incomplete");
    const target = folderByPath(next, suggestion.targetFolderPath);
    if (!target) throw new Error(`Target folder not found: ${suggestion.targetFolderPath}`);
    const node = next.nodes.find((item) => item.id === suggestion.nodeId);
    if (!node) throw new Error(`Bookmark not found: ${suggestion.nodeId}`);
    const order = next.nodes.filter((item) => item.parentId === target.id && item.id !== node.id).length;
    node.parentId = target.id;
    node.order = order;
  }
  return { ...next, nodes: normalizeSiblingOrders(next.nodes), updatedAt: new Date().toISOString() };
}

async function dashboardState(): Promise<Record<string, unknown>> {
  const state = await loadState();
  const current = await readLocal(state);
  const counts = countNodes(current.repository);
  return {
    deviceId: state.deviceId,
    settings: state.settings,
    status: state.lastSyncStatus,
    lastSyncAt: state.lastSyncAt,
    lastSyncError: state.lastSyncError,
    stats: { ...counts, changes: state.lastSyncStats.changes },
    duplicates: detectDuplicates(current.repository),
    suggestions: state.aiSuggestions,
    ignoredReachabilityUrls: state.ignoredReachabilityUrls,
    conflicts: state.pendingConflicts.map(serializeConflict),
    conflictSources: state.pendingConflictSources,
    safetySnapshots: state.safetySnapshots.map((snapshot) => ({ id: snapshot.id, createdAt: snapshot.createdAt, reason: snapshot.reason })),
    browser: await browser.getBrowserInfo(),
  };
}

async function bookmarksState(): Promise<Record<string, unknown>> {
  const state = await loadState();
  const current = await readLocal(state);
  return {
    nodes: current.repository.nodes.map((node) => ({ ...node, folderPath: getFolderPath(current.repository, node.id) })),
  };
}

async function restoreVersion(id: string): Promise<Record<string, unknown>> {
  const state = await loadState();
  if (syncInMemory) return { ok: false, status: "busy", message: "A sync is already running." };
  syncInMemory = true;
  state.syncInProgress = true;
  state.syncStartedAt = new Date().toISOString();
  try {
    const current = await readLocal(state);
    saveSafetySnapshot(state, current.repository, "Before restoring a history version");
    const storage = createStorage(state.settings);
    await storage.restoreVersion(id);
    const remote = await storage.pull();
    if (!remote) throw new Error("The restored repository could not be read back");
    suppressEvents = true;
    const applied = await applyRepositoryToBrowser(browser, current, remote.repository);
    state.mapping = applied.mapping;
    state.lastSyncedSnapshot = remote.repository;
    state.lastSyncAt = remote.repository.updatedAt;
    state.lastSyncStatus = "synced";
    state.lastSyncError = null;
    state.pendingConflicts = [];
    state.pendingConflictSources = null;
    await saveState(state);
    return { ok: true, status: "synced" };
  } catch (error) {
    state.lastSyncStatus = "error";
    state.lastSyncError = error instanceof Error ? error.message : String(error);
    await saveState(state);
    return { ok: false, status: "error", message: state.lastSyncError };
  } finally {
    suppressEvents = false;
    try {
      const latest = await loadState();
      latest.syncInProgress = false;
      latest.syncStartedAt = null;
      await saveState(latest);
    } finally {
      syncInMemory = false;
    }
  }
}

async function restoreSafetySnapshot(id: string): Promise<Record<string, unknown>> {
  if (syncInMemory) return { ok: false, status: "busy", message: "A sync is already running." };
  syncInMemory = true;
  const state = await loadState();
  const snapshot = state.safetySnapshots.find((item) => item.id === id);
  if (!snapshot) {
    syncInMemory = false;
    return { ok: false, status: "error", message: "Safety snapshot not found" };
  }
  state.syncInProgress = true;
  state.syncStartedAt = new Date().toISOString();
  try {
    const current = await readLocal(state);
    suppressEvents = true;
    const applied = await applyRepositoryToBrowser(browser, current, snapshot.repository);
    state.mapping = applied.mapping;
    state.lastSyncStatus = "synced";
    state.lastSyncError = null;
    await saveState(state);
    return { ok: true, status: "synced", message: "Safety snapshot restored locally. Storage was not changed." };
  } catch (error) {
    state.lastSyncStatus = "error";
    state.lastSyncError = error instanceof Error ? error.message : String(error);
    await saveState(state);
    return { ok: false, status: "error", message: state.lastSyncError };
  } finally {
    suppressEvents = false;
    try {
      const latest = await loadState();
      latest.syncInProgress = false;
      latest.syncStartedAt = null;
      await saveState(latest);
    } finally {
      syncInMemory = false;
    }
  }
}

async function handleMessage(message: { type: string; [key: string]: unknown }): Promise<Record<string, unknown>> {
  switch (message.type) {
    case "GET_STATE":
      return await dashboardState();
    case "GET_BOOKMARKS":
      return await bookmarksState();
    case "GET_HISTORY": {
      const state = await loadState();
      return { history: await createStorage(state.settings).getHistory() };
    }
    case "GET_VERSION": {
      const state = await loadState();
      return { repository: await createStorage(state.settings).getVersion(String(message.id)) };
    }
    case "SYNC_NOW":
      {
        const syncOptions: SyncOptions = {
          confirm: message.confirm === true,
          preview: message.preview === true,
        };
        if (message.decisions !== undefined) syncOptions.decisions = message.decisions as Record<string, "local" | "remote">;
        return await syncNow(syncOptions);
      }
    case "SAVE_SETTINGS": {
      const state = await loadState();
      state.settings = settingsPatch(state.settings, message.settings as Partial<ExtensionSettings>);
      await saveState(state);
      await configureAlarms();
      return { ok: true, settings: state.settings };
    }
    case "TEST_CONNECTION": {
      const state = await loadState();
      const settings = message.settings && typeof message.settings === "object"
        ? settingsPatch(state.settings, message.settings as Partial<ExtensionSettings>)
        : state.settings;
      await createStorage(settings).testConnection?.();
      return { ok: true };
    }
    case "TEST_AI_CONNECTION": {
      const state = await loadState();
      const config = (message.ai as ExtensionSettings["ai"]) || state.settings.ai;
      if (!config.baseUrl || !config.model) {
        throw new Error("AI Base URL and Model are required for connection test");
      }
      const provider = new OpenAICompatibleProvider(config);
      const result = await provider.testConnection();
      return { ok: true, model: result.model };
    }
    case "RESTORE_VERSION":
      return await restoreVersion(String(message.id));
    case "RESTORE_SAFETY":
      return await restoreSafetySnapshot(String(message.id));
    case "GENERATE_AI": {
      const state = await loadState();
      const config = state.settings.ai;
      if (!config.baseUrl || !config.model) {
        return {
          ok: false,
          status: "error",
          message: "AI provider is not configured. Please configure Base URL and Model in Settings.",
        };
      }
      const current = await readLocal(state);
      const provider = new OpenAICompatibleProvider(config);
      const requestedRationaleLanguage = message.rationaleLanguage === "zh-CN" || message.rationaleLanguage === "en"
        ? message.rationaleLanguage
        : state.settings.language;
      const organizerRequest = {
        ...buildOrganizerRequest(current.repository),
        rationaleLanguage: requestedRationaleLanguage,
      };
      const result = await provider.organize(organizerRequest);
      const validated = validateOrganizerResult(result, current.repository);
      state.aiSuggestions = validated.suggestions;
      await saveState(state);
      return { ok: true, suggestions: state.aiSuggestions };
    }
    case "CHECK_REACHABILITY": {
      const state = await loadState();
      const current = await readLocal(state);
      const results = await checkBookmarkReachability(current.repository);
      return { ok: true, checkedAt: new Date().toISOString(), results };
    }
    case "CHECK_SINGLE_REACHABILITY": {
      const state = await loadState();
      const current = await readLocal(state);
      const result = await checkSingleBookmarkReachability(current.repository, String(message.url));
      return { ok: true, result };
    }
    case "SET_REACHABILITY_IGNORED": {
      const state = await loadState();
      const key = reachabilityKey(String(message.url));
      const ignored = new Set(state.ignoredReachabilityUrls);
      if (message.ignored === true) ignored.add(key);
      else ignored.delete(key);
      state.ignoredReachabilityUrls = [...ignored];
      await saveState(state);
      return { ok: true, ignoredReachabilityUrls: state.ignoredReachabilityUrls };
    }
    case "DELETE_BOOKMARKS": {
      const rawIds = message.nodeIds ?? message.nodeId;
      const requestedIds = Array.isArray(rawIds) ? (rawIds as unknown[]).map(String) : [String(rawIds)];
      const state = await loadState();
      const current = await readLocal(state);
      const nodesById = new Map(current.repository.nodes.map((node) => [node.id, node]));
      const childrenByParent = new Map<string, string[]>();
      for (const node of current.repository.nodes) {
        if (!node.parentId) continue;
        const children = childrenByParent.get(node.parentId) ?? [];
        children.push(node.id);
        childrenByParent.set(node.parentId, children);
      }

      const idSet = new Set<string>();
      const queue = [...requestedIds];
      let queueIndex = 0;
      while (queueIndex < queue.length) {
        const id = queue[queueIndex++];
        if (!id || idSet.has(id)) continue;
        const node = nodesById.get(id);
        if (!node || node.rootKey) continue;
        idSet.add(id);
        queue.push(...(childrenByParent.get(id) ?? []));
      }
      if (!idSet.size) return { ok: false, status: "error", message: "No deletable bookmarks were selected." };

      const targetNodes = current.repository.nodes.filter((node) => !idSet.has(node.id));
      const target: BookmarkRepository = {
        ...current.repository,
        nodes: normalizeSiblingOrders(targetNodes),
        updatedAt: new Date().toISOString(),
      };
      return await syncNow({ localOverride: target, confirm: message.confirm === true });
    }
    case "ACCEPT_SUGGESTION": {
      const state = await loadState();
      const suggestion = state.aiSuggestions.find((item) => item.id === String(message.id));
      if (!suggestion) return { ok: false, status: "error", message: "Suggestion not found" };
      const current = await readLocal(state);
      const updated = applySuggestion(current.repository, suggestion);
      const result = await syncNow({ localOverride: updated, confirm: message.confirm === true });
      if (result.ok) {
        const latest = await loadState();
        latest.aiSuggestions = latest.aiSuggestions.filter((item) => item.id !== suggestion.id);
        await saveState(latest);
      }
      return result;
    }
    case "IGNORE_SUGGESTION": {
      const state = await loadState();
      state.aiSuggestions = state.aiSuggestions.filter((item) => item.id !== String(message.id));
      await saveState(state);
      return { ok: true };
    }
    case "GET_LOCAL_STORAGE_INFO": {
      const localAdapter = new LocalStorageAdapter(store, "bookmark-sync-local-provider");
      const info = await localAdapter.getStorageInfo();
      return {
        ok: true,
        engine: "chrome.storage.local",
        key: info.key,
        revision: info.revision,
        historyCount: info.historyCount,
        hasRepository: info.hasRepository,
        sizeBytes: info.sizeBytes,
        scope: "Browser profile sandbox",
      };
    }
    case "CLEAR_LOCAL_STORAGE": {
      const localAdapter = new LocalStorageAdapter(store, "bookmark-sync-local-provider");
      await localAdapter.clear();
      const state = await loadState();
      state.lastSyncedSnapshot = null;
      state.lastSyncAt = null;
      state.lastSyncStatus = "never";
      state.lastSyncError = null;
      state.pendingConflicts = [];
      state.pendingConflictSources = null;
      state.mapping = { schemaVersion: 1, entries: [] };
      await saveState(state);
      return { ok: true };
    }
    case "CLEAR_SAFETY_SNAPSHOTS": {
      const state = await loadState();
      state.safetySnapshots = [];
      await saveState(state);
      return { ok: true };
    }
    case "RESET_MAPPING": {
      const state = await loadState();
      state.mapping = { schemaVersion: 1, entries: [] };
      const current = await readLocal(state);
      state.mapping = current.mapping;
      await saveState(state);
      return { ok: true };
    }
    default:
      return { ok: false, status: "error", message: `Unknown message type: ${message.type}` };
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "reachability-stream") {
    const abortController = new AbortController();
    port.onDisconnect.addListener(() => {
      abortController.abort();
    });
    port.onMessage.addListener(async (message: { type: string }) => {
      if (message.type === "START") {
        try {
          const state = await loadState();
          const current = await readLocal(state);
          const results = await checkBookmarkReachability(current.repository, {
            signal: abortController.signal,
            onProgress: (progress) => {
              try {
                port.postMessage({ type: "PROGRESS", ...progress });
              } catch {
                // Ignore port closed error
              }
            },
          });
          try {
            port.postMessage({ type: "COMPLETE", results, checkedAt: new Date().toISOString() });
          } catch {}
        } catch (error) {
          try {
            port.postMessage({
              type: "ERROR",
              message: error instanceof Error ? error.message : String(error),
            });
          } catch {}
        }
      }
    });
  }
});

chrome.runtime.onMessage.addListener((message: { type: string; [key: string]: unknown }, _sender, sendResponse) => {
  void handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, status: "error", message: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.bookmarks.onCreated.addListener(scheduleChangeSync);
chrome.bookmarks.onRemoved.addListener(scheduleChangeSync);
chrome.bookmarks.onChanged.addListener(scheduleChangeSync);
chrome.bookmarks.onMoved.addListener(scheduleChangeSync);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PERIODIC_ALARM || alarm.name === DEBOUNCE_ALARM) void syncNow();
});

void configureAlarms();

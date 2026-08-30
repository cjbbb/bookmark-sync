import "./styles.css";
import { getLanguage, setLanguage, t, type TranslationKey } from "./i18n.js";
import { escapeHtml, formatBytes, formatCount, formatDate, send, statusClass } from "./ui.js";

type Dashboard = {
  deviceId: string;
  settings: Settings;
  status: string;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  stats: { bookmarks: number; folders: number; changes: number };
  duplicates: DuplicateGroup[];
  suggestions: Suggestion[];
  ignoredReachabilityUrls: string[];
  conflicts: Conflict[];
  conflictSources?: { base: PlanSource; local: PlanSource; remote: PlanSource } | null;
  safetySnapshots: Array<{ id: string; createdAt: string; reason: string }>;
  browser: { name: string; version?: string };
};

type Settings = {
  language: "zh-CN" | "en";
  provider: "github" | "self-hosted" | "local" | "webdav";
  mode: "publish" | "mirror" | "two-way";
  autoSync: "off" | "5m" | "15m" | "1h";
  syncOnBookmarkChange: boolean;
  github: { token: string; owner: string; repository: string; branch: string; filePath: string };
  selfHosted: { serverUrl: string; apiToken: string };
  webdav: { url: string; username: string; password: string; filePath: string };
  ai: { baseUrl: string; apiKey: string; model: string };
};

type DuplicateGroup = {
  id: string;
  type: "exact" | "normalized";
  normalizedUrl: string;
  nodeIds: string[];
  titles: string[];
  folderPaths: string[];
  urls: string[];
};

type LinkReachabilityResult = {
  normalizedUrl: string;
  url: string;
  nodeIds: string[];
  titles: string[];
  folderPaths: string[];
  status: "reachable" | "restricted" | "broken" | "error" | "unsupported";
  checkedAt: string;
  latencyMs: number;
  httpStatus?: number;
  finalUrl?: string;
  error?: string;
};

type Suggestion = {
  id: string;
  kind: string;
  nodeId?: string;
  targetFolderPath?: string;
  sourceFolderPath?: string;
  relatedNodeIds?: string[];
  confidence: number;
  rationale: string;
};

type Conflict = {
  nodeId: string;
  type: string;
  base?: BookmarkNode;
  local?: BookmarkNode;
  remote?: BookmarkNode;
};

type BookmarkNode = {
  id: string;
  type: string;
  title: string;
  url?: string;
  parentId: string | null;
  order: number;
  createdAt?: string;
  updatedAt?: string;
  folderPath?: string;
  rootKey?: string;
};

type Destructive = {
  requiresConfirmation: boolean;
  deletedBookmarks: number;
  deletedFolders: number;
  deletedNodes: number;
  previousNodes: number;
  nextNodes: number;
  reasons: string[];
};

type PlanCounts = { bookmarks: number; folders: number; total: number };

type PlanChange = {
  kind: "create" | "update" | "move" | "delete";
  nodeId: string;
  type: string;
  title: string;
  url?: string;
  beforePath?: string | null;
  afterPath?: string | null;
};

type PlanDeletionPath = {
  nodeId: string;
  type: string;
  title: string;
  url?: string;
  path: string;
};

type PlanSide = {
  creates: number;
  updates: number;
  moves: number;
  deletes: number;
  totalChanges: number;
  before: PlanCounts;
  after: PlanCounts;
  destructive: Destructive;
  changes: PlanChange[];
  deletionPaths: PlanDeletionPath[];
};

type PlanSource = { device: string; updatedAt: string; revision: number } | null;

type Plan = {
  mode: string;
  hasChanges: boolean;
  creates: number;
  updates: number;
  moves: number;
  deletes: number;
  conflicts: Conflict[];
  destructive: Destructive;
  remoteDestructive: Destructive;
  targetCounts: { bookmarks: number; folders: number };
  local: PlanSide;
  remote: PlanSide;
  sources: { base: PlanSource; local: PlanSource; remote: PlanSource };
  snapshot: {
    status: "not_required" | "will_create" | "created" | "blocked";
    reason: string | null;
  };
};

type LocalStorageDetails = {
  ok: boolean;
  engine: string;
  key: string;
  revision: number;
  historyCount: number;
  hasRepository: boolean;
  sizeBytes: number;
  scope: string;
};

const managerRoot = document.querySelector<HTMLDivElement>("#manager-app");
if (!managerRoot) throw new Error("Manager root is missing");
const app = managerRoot;

const requestedPage = new URLSearchParams(window.location.search).get("page");
const validPages = new Set(["overview", "organizer", "health", "bookmarks", "sync", "history", "settings"]);
let activePage = requestedPage && validPages.has(requestedPage) ? requestedPage : "overview";
let activeSettingsTab = "general";
let dashboard: Dashboard | null = null;
let localStorageDetails: LocalStorageDetails | null = null;
let actionResult: { ok: boolean; status?: string; message?: string; plan?: Plan; updatedAt?: string } | null = null;
let conflictChoices: Record<string, "local" | "remote"> = {};
let settingsDraft: Settings | null = null;
let settingsDirty = false;
let settingsSaving = false;
let pendingNavigation: string | null = null;
let syncBusy = false;
let focusAfterRender: string | null = null;
let versionPreview: { id: string; repository: { revision: number; nodes: BookmarkNode[] } } | null = null;
let versionSearchFilter = "";
let bookmarkRows: BookmarkNode[] = [];
let bookmarkRowsLoaded = false;
let bookmarkFilter = "";
let bookmarksRefreshing = false;
let selectedBookmarkNodeIds = new Set<string>();
let deletingBookmarkNodeIds = new Set<string>();
let feedbackToast: { type: "success" | "error"; text: string } | null = null;
let collapsedFolders: Record<string, boolean> = {};
let reachabilityResults: LinkReachabilityResult[] | null = null;
let organizerScanning = false;
let aiGenerating = false;
let aiTestResult: { ok: boolean; message: string } | null = null;

function cloneSettings(settings: Settings): Settings {
  return JSON.parse(JSON.stringify(settings)) as Settings;
}

function ensureSettingsDraft(): Settings | null {
  if (!dashboard) return null;
  if (!settingsDraft) settingsDraft = cloneSettings(dashboard.settings);
  return settingsDraft;
}

function settingsForRender(): Settings | null {
  return settingsDraft ?? dashboard?.settings ?? null;
}

function updateSettingsDirty(): void {
  settingsDirty = Boolean(dashboard && settingsDraft && JSON.stringify(settingsDraft) !== JSON.stringify(dashboard.settings));
  const status = document.querySelector<HTMLElement>("[data-settings-draft-status]");
  if (status) {
    status.textContent = settingsDirty ? t("settingsUnsavedChanges") : t("settingsNoUnsavedChanges");
    status.classList.toggle("dirty", settingsDirty);
  }
}

function discardSettingsDraft(): void {
  settingsDraft = null;
  settingsDirty = false;
}

function collectCurrentSettingsDraft(): void {
  const form = document.querySelector<HTMLFormElement>("#settings-form");
  const draft = ensureSettingsDraft();
  if (!form || !draft) return;
  const data = new FormData(form);

  if (data.has("githubToken")) draft.github.token = String(data.get("githubToken") ?? "");
  if (data.has("githubOwner")) draft.github.owner = String(data.get("githubOwner") ?? "");
  if (data.has("githubRepo")) draft.github.repository = String(data.get("githubRepo") ?? "");
  else if (data.has("githubRepository")) draft.github.repository = String(data.get("githubRepository") ?? "");
  if (data.has("githubBranch")) draft.github.branch = String(data.get("githubBranch") ?? "main");
  if (data.has("githubFilePath")) draft.github.filePath = String(data.get("githubFilePath") ?? "bookmarks.json");

  if (data.has("serverUrl")) draft.selfHosted.serverUrl = String(data.get("serverUrl") ?? "");
  if (data.has("serverToken")) draft.selfHosted.apiToken = String(data.get("serverToken") ?? "");

  if (data.has("webdavUrl")) draft.webdav.url = String(data.get("webdavUrl") ?? "");
  if (data.has("webdavUsername")) draft.webdav.username = String(data.get("webdavUsername") ?? "");
  if (data.has("webdavPassword")) draft.webdav.password = String(data.get("webdavPassword") ?? "");
  if (data.has("webdavFilePath")) draft.webdav.filePath = String(data.get("webdavFilePath") ?? "bookmarks.json");

  if (data.has("aiBaseUrl")) draft.ai.baseUrl = String(data.get("aiBaseUrl") ?? "");
  if (data.has("aiApiKey")) draft.ai.apiKey = String(data.get("aiApiKey") ?? "");
  if (data.has("aiModel")) draft.ai.model = String(data.get("aiModel") ?? "");

  if (data.has("language")) draft.language = String(data.get("language")) as Settings["language"];
  if (data.has("provider")) draft.provider = String(data.get("provider")) as Settings["provider"];
  if (data.has("mode")) draft.mode = String(data.get("mode")) as Settings["mode"];
  if (data.has("autoSync")) draft.autoSync = String(data.get("autoSync")) as Settings["autoSync"];
  draft.syncOnBookmarkChange = data.get("syncOnBookmarkChange") === "on";
  updateSettingsDirty();
}

type ReachabilityProgressState = {
  total: number;
  completed: number;
  currentTitle?: string | undefined;
  currentUrl?: string | undefined;
  reachableCount: number;
  problemCount: number;
};

let reachabilityProgress: ReachabilityProgressState | null = null;
let reachabilityFilter: "all-problems" | "broken" | "restricted" | "reachable" | "ignored" | "all" = "all-problems";
let recheckingUrl: string | null = null;
let deletingNodeId: string | null = null;
let updatingIgnoredUrl: string | null = null;

function pageTitle(): string {
  const titles: Record<string, TranslationKey> = {
    overview: "navOverview",
    bookmarks: "navBookmarks",
    sync: "navSync",
    history: "navHistory",
    organizer: "navOrganizer",
    health: "navHealth",
    settings: "navSettings",
  };
  return t(titles[activePage] ?? "navOverview");
}

function localizedStatus(status: string): string {
  if (status === "synced") return t("statusSynced");
  if (status === "never") return t("statusNever");
  if (status === "conflict") return t("statusConflict");
  if (status === "confirmation_required") return t("statusConfirmationRequired");
  if (status === "error") return t("statusError");
  if (status === "busy") return t("statusBusy");
  return status.replaceAll("_", " ");
}

function providerDisplayName(provider: string): string {
  if (provider === "github") return "GitHub";
  if (provider === "self-hosted") return "Self-Hosted";
  if (provider === "webdav") return "WebDAV";
  return t("providerLocalTitle");
}

function modeDisplayName(mode: string): string {
  if (mode === "publish") return t("strategyPublish");
  if (mode === "mirror") return t("strategyMirror");
  return t("strategyTwoWay");
}

async function ensureBookmarkRowsLoaded(): Promise<void> {
  if (bookmarkRowsLoaded) return;
  const response = await send<{ nodes: BookmarkNode[] }>({ type: "GET_BOOKMARKS" });
  bookmarkRows = response.nodes ?? [];
  bookmarkRowsLoaded = true;
  pruneBookmarkSelection();
}

function isSelectableBookmarkNode(node: BookmarkNode): boolean {
  return !node.rootKey;
}

function filteredBookmarkRows(): BookmarkNode[] {
  const query = bookmarkFilter.trim().toLowerCase();
  return bookmarkRows.filter((node) => `${node.title} ${node.url ?? ""} ${node.folderPath ?? ""}`.toLowerCase().includes(query));
}

function visibleSelectableBookmarkNodeIds(): string[] {
  return filteredBookmarkRows().filter(isSelectableBookmarkNode).map((node) => node.id);
}

function pruneBookmarkSelection(): void {
  const validIds = new Set(bookmarkRows.filter(isSelectableBookmarkNode).map((node) => node.id));
  selectedBookmarkNodeIds = new Set([...selectedBookmarkNodeIds].filter((id) => validIds.has(id)));
}

function expandBookmarkDeletionIds(nodeIds: Iterable<string>): string[] {
  const nodesById = new Map(bookmarkRows.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, string[]>();
  for (const node of bookmarkRows) {
    if (!node.parentId) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node.id);
    childrenByParent.set(node.parentId, children);
  }

  const expanded = new Set<string>();
  const queue = [...nodeIds];
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const id = queue[queueIndex++];
    if (!id || expanded.has(id)) continue;
    const node = nodesById.get(id);
    if (!node || !isSelectableBookmarkNode(node)) continue;
    expanded.add(id);
    queue.push(...(childrenByParent.get(id) ?? []));
  }
  return [...expanded];
}

function summarizeBookmarkNodes(nodeIds: Iterable<string>): { bookmarks: number; folders: number; total: number } {
  const idSet = new Set(nodeIds);
  return bookmarkRows.reduce((summary, node) => {
    if (!idSet.has(node.id)) return summary;
    if (node.type === "folder") summary.folders += 1;
    else summary.bookmarks += 1;
    summary.total += 1;
    return summary;
  }, { bookmarks: 0, folders: 0, total: 0 });
}

function syncBookmarkSelectionUi(): void {
  pruneBookmarkSelection();
  const visibleIds = visibleSelectableBookmarkNodeIds();
  const selectedVisibleCount = visibleIds.filter((id) => selectedBookmarkNodeIds.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  const selectAll = document.querySelector<HTMLInputElement>("[data-bookmark-select-all]");
  if (selectAll) {
    selectAll.checked = allVisibleSelected;
    selectAll.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected;
    selectAll.disabled = visibleIds.length === 0 || deletingBookmarkNodeIds.size > 0;
    selectAll.setAttribute("aria-checked", selectAll.indeterminate ? "mixed" : String(allVisibleSelected));
  }

  document.querySelectorAll<HTMLInputElement>("[data-bookmark-select]").forEach((input) => {
    const id = input.dataset.nodeId;
    input.checked = Boolean(id && selectedBookmarkNodeIds.has(id));
    input.disabled = deletingBookmarkNodeIds.size > 0;
  });
  document.querySelectorAll<HTMLElement>("[data-bookmark-row]").forEach((row) => {
    row.classList.toggle("is-selected", Boolean(row.dataset.nodeId && selectedBookmarkNodeIds.has(row.dataset.nodeId)));
  });

  const summary = document.querySelector<HTMLElement>("[data-bookmark-selection-summary]");
  if (summary) summary.textContent = t("bookmarksSelectedCount", { count: selectedBookmarkNodeIds.size });
  const deleteButton = document.querySelector<HTMLButtonElement>("[data-action='delete-selected-bookmarks']");
  if (deleteButton) deleteButton.disabled = selectedBookmarkNodeIds.size === 0 || deletingBookmarkNodeIds.size > 0;
  const clearButton = document.querySelector<HTMLButtonElement>("[data-action='clear-bookmark-selection']");
  if (clearButton) clearButton.disabled = selectedBookmarkNodeIds.size === 0 || deletingBookmarkNodeIds.size > 0;
}

function folderIconSvg(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"></path><path d="M3.5 9h17"></path></svg>`;
}

function chevronIconSvg(): string {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>`;
}

function bookmarkIconSvg(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-3.5L6 21z"></path></svg>`;
}

function organizeIconSvg(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path><path d="m10 13 2 2 4-4"></path></svg>`;
}

function healthIconSvg(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l2.2-6 4.1 12 2.1-6H21"></path><path d="M5 5.5A3.5 3.5 0 0 1 12 4a3.5 3.5 0 0 1 7 1.5c0 5-7 10.5-7 10.5S5 10.5 5 5.5Z"></path></svg>`;
}

function duplicateIconSvg(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="13" height="13" rx="2"></rect><path d="M17 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2"></path></svg>`;
}

function syncIconSvg(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.5 2v6h-6"></path><path d="M21.34 15.57a10 10 0 1 1-.57-8.38L21.5 8"></path></svg>`;
}

function arrowIconSvg(): string {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path></svg>`;
}

function refreshIconSvg(spinning = false): string {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${spinning ? 'style="animation:spin 1s linear infinite;"' : ""}><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;
}

function trashIconSvg(): string {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
}

function suggestionKindLabel(kind: string): string {
  const labels: Record<string, TranslationKey> = {
    move: "suggestionMove",
    "create-folder": "suggestionCreateFolder",
    "merge-folder": "suggestionMergeFolder",
    "semantic-duplicate": "suggestionSemanticDuplicate",
  };
  const labelKey = labels[kind];
  return labelKey ? t(labelKey) : kind;
}

function getConflictTypeLabel(type: string): string {
  if (type.includes("edit") || type.includes("update")) return t("conflictTypeEdit");
  if (type.includes("move")) return t("conflictTypeMove");
  if (type.includes("delete")) return t("conflictTypeDelete");
  return t("conflictTypeGeneral");
}

function renderSettingsLeaveDialog(): string {
  if (!pendingNavigation) return "";
  return `
    <div class="settings-leave-backdrop" data-settings-leave-dialog>
      <div class="settings-leave-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-leave-title" aria-describedby="settings-leave-desc" tabindex="-1">
        <h3 id="settings-leave-title">${escapeHtml(t("settingsLeaveTitle"))}</h3>
        <p id="settings-leave-desc">${escapeHtml(t("settingsLeaveDesc"))}</p>
        <div class="button-row settings-leave-actions">
          <button type="button" class="button primary sm" data-action="settings-leave-save">${escapeHtml(t("settingsLeaveSave"))}</button>
          <button type="button" class="button danger-ghost sm" data-action="settings-leave-discard">${escapeHtml(t("settingsLeaveDiscard"))}</button>
          <button type="button" class="button subtle sm" data-action="settings-leave-continue">${escapeHtml(t("settingsLeaveContinue"))}</button>
        </div>
      </div>
    </div>`;
}

function renderShell(body: string): void {
  const currentLang = getLanguage();
  const problematicLinksCount = (reachabilityResults ?? []).filter((item) => {
    const key = item.normalizedUrl || item.url.trim();
    return item.status !== "reachable" && !dashboard?.ignoredReachabilityUrls?.includes(key);
  }).length;

  const workspaceNavItems: Array<{ id: string; labelKey: TranslationKey; iconSvg: string; badge?: number }> = [
    {
      id: "overview",
      labelKey: "navOverview",
      iconSvg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`,
    },
    {
      id: "organizer",
      labelKey: "navOrganizer",
      iconSvg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path><path d="m10 13 2 2 4-4"></path></svg>`,
      badge: dashboard?.suggestions.length || 0,
    },
    {
      id: "health",
      labelKey: "navHealth",
      iconSvg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.2-6 4.1 12 2.1-6H21"></path><path d="M5 5.5A3.5 3.5 0 0 1 12 4a3.5 3.5 0 0 1 7 1.5c0 5-7 10.5-7 10.5S5 10.5 5 5.5Z"></path></svg>`,
      badge: problematicLinksCount,
    },
    {
      id: "bookmarks",
      labelKey: "navBookmarks",
      iconSvg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"></path></svg>`,
    },
  ];
  const systemNavItems: Array<{ id: string; labelKey: TranslationKey; iconSvg: string; badge?: number }> = [
    {
      id: "sync",
      labelKey: "navSync",
      iconSvg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>`,
      badge: dashboard?.conflicts.length || 0,
    },
    {
      id: "history",
      labelKey: "navHistory",
      iconSvg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
    },
    {
      id: "settings",
      labelKey: "navSettings",
      iconSvg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
    },
  ];

  app.innerHTML = `
    <div class="manager-shell">
      <aside class="sidebar">
        <div>
          <div class="brand">
            <img class="brand-mark" src="/icons/icon48.png" alt="Logo" width="28" height="28" />
            <div class="brand-info">
              <h1>${escapeHtml(t("brandName"))}</h1>
              <p>${escapeHtml(t("brandSlogan"))}</p>
            </div>
          </div>
          <nav class="nav" aria-label="Main navigation">
            <div class="nav-group">
              <div class="nav-group-label">${escapeHtml(t("navWorkspaceGroup"))}</div>
              ${workspaceNavItems.map((item) => `
                <button type="button" class="${activePage === item.id ? "active" : ""}" data-nav="${item.id}" ${activePage === item.id ? 'aria-current="page"' : ""}>
                  <div class="nav-btn-content">
                    <span class="nav-icon">${item.iconSvg}</span>
                    <span>${escapeHtml(t(item.labelKey))}</span>
                  </div>
                  ${item.badge ? `<span class="badge ${item.id === "organizer" ? "blue" : "warn"} nav-badge">${item.badge}</span>` : ""}
                </button>
              `).join("")}
            </div>
            <div class="nav-group nav-group-secondary">
              <div class="nav-group-label">${escapeHtml(t("navSystemGroup"))}</div>
              ${systemNavItems.map((item) => `
                <button type="button" class="${activePage === item.id ? "active" : ""}" data-nav="${item.id}" ${activePage === item.id ? 'aria-current="page"' : ""}>
                  <div class="nav-btn-content">
                    <span class="nav-icon">${item.iconSvg}</span>
                    <span>${escapeHtml(t(item.labelKey))}</span>
                  </div>
                  ${item.badge ? `<span class="badge red nav-badge">${item.badge}</span>` : ""}
                </button>
              `).join("")}
            </div>
          </nav>
        </div>
        <div class="sidebar-footer">
          <div class="sidebar-device-pill" title="Device ID">
            <span title="${escapeHtml(dashboard?.deviceId ?? "")}">${escapeHtml(dashboard?.deviceId?.slice(0, 12) ?? "—")}…</span>
            <button type="button" class="button sm subtle" data-action="copy-device-id" style="height:20px; padding:0 6px; font-size:10px;">${escapeHtml(t("copyId"))}</button>
          </div>
          <div class="segmented-control" role="group" aria-label="Language selector" style="width: 100%; justify-content: center;">
            <button type="button" class="${currentLang === "zh-CN" ? "active" : ""}" data-action="switch-lang" data-lang="zh-CN">中文</button>
            <button type="button" class="${currentLang === "en" ? "active" : ""}" data-action="switch-lang" data-lang="en">EN</button>
          </div>
        </div>
      </aside>
      <main class="main"><div class="content">
        <div class="topline">
          <div class="topline-title-group">
            <h2 id="page-title" tabindex="-1">${pageTitle()}</h2>
            <p class="topline-context">${escapeHtml(dashboard?.browser?.name ?? "Chromium Browser")} · ${escapeHtml(t("toplineContext"))}</p>
          </div>
          <div class="topline-actions">
            ${activePage === "overview" ? `
              <button class="button sm" data-action="scan-bookmarks" ${organizerScanning ? 'disabled aria-busy="true"' : ""}>${escapeHtml(organizerScanning ? t("scanningBookmarksBtn") : t("runHealthCheckBtn"))}</button>
              <button class="button primary sm" data-nav="organizer">${escapeHtml(t("openOrganizerBtn"))}</button>
            ` : ""}
          </div>
        </div>
        ${feedbackToast ? `
          <div id="feedback-live" class="toast ${feedbackToast.type}" role="${feedbackToast.type === "error" ? "alert" : "status"}" aria-live="${feedbackToast.type === "error" ? "assertive" : "polite"}" tabindex="-1" data-feedback-live style="margin-bottom: 14px;">
            <span>${escapeHtml(feedbackToast.text)}</span>
          </div>
        ` : ""}
        ${body}
      </div></main>
      ${renderSettingsLeaveDialog()}
    </div>`;
}

function snapshotStatusLabel(status: Plan["snapshot"]["status"]): string {
  if (status === "will_create") return t("snapshotWillCreate");
  if (status === "created") return t("snapshotCreated");
  if (status === "blocked") return t("snapshotBlocked");
  return t("snapshotNotRequired");
}

function planSourceLabel(source: PlanSource, missingLabel = "—"): string {
  if (!source) return missingLabel;
  return `${source.device} · ${formatDate(source.updatedAt, getLanguage())} · v${source.revision}`;
}

function planReviewComplete(plan: Plan): boolean {
  const sideComplete = (side: PlanSide | undefined): boolean => Boolean(
    side &&
    side.before &&
    side.after &&
    side.destructive &&
    Array.isArray(side.destructive.reasons) &&
    Array.isArray(side.changes) &&
    Array.isArray(side.deletionPaths),
  );
  return Boolean(
    sideComplete(plan.local) &&
    sideComplete(plan.remote) &&
    plan.sources &&
    Object.prototype.hasOwnProperty.call(plan.sources, "base") &&
    Object.prototype.hasOwnProperty.call(plan.sources, "local") &&
    Object.prototype.hasOwnProperty.call(plan.sources, "remote") &&
    plan.snapshot &&
    typeof plan.snapshot.status === "string",
  );
}

function renderPlanSideDetails(label: string, side: PlanSide, source: PlanSource): string {
  const before = side.before ?? { bookmarks: 0, folders: 0, total: 0 };
  const after = side.after ?? { bookmarks: 0, folders: 0, total: 0 };
  const destructive = side.destructive ?? emptyDestructive();
  const paths = Array.isArray(side.deletionPaths) ? side.deletionPaths : [];
  return `
    <section class="plan-side-card" aria-label="${escapeHtml(label)}">
      <h4>${escapeHtml(label)}</h4>
      <div class="plan-source-meta">${escapeHtml(t("planSourceBeforeAfter"))} · ${escapeHtml(planSourceLabel(source, t("conflictSourceUnavailable")))}</div>
      <div class="plan-count-flow">
        <span>${escapeHtml(t("statBookmarks"))}</span>
        <strong>${formatCount(before.bookmarks)} → ${formatCount(after.bookmarks)}</strong>
      </div>
      <div class="plan-count-flow">
        <span>${escapeHtml(t("statFolders"))}</span>
        <strong>${formatCount(before.folders)} → ${formatCount(after.folders)}</strong>
      </div>
      <div class="plan-count-flow">
        <span>${escapeHtml(t("planTotalNodes"))}</span>
        <strong>${formatCount(before.total)} → ${formatCount(after.total)}</strong>
      </div>
      ${destructive.reasons.length ? `
        <ul class="plan-reasons">
          ${destructive.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}
        </ul>
      ` : ""}
      ${paths.length ? `
        <details class="plan-paths" ${paths.length <= 20 ? "open" : ""}>
          <summary>${escapeHtml(t("planDeletionPaths", { count: paths.length }))}</summary>
          <ul>
            ${paths.map((item) => `
              <li>
                <span class="plan-path-title">${escapeHtml(item.title || t(item.type === "folder" ? "folder" : "bookmark"))}</span>
                <span class="plan-path-value">${escapeHtml(item.path || t("rootFolder"))}</span>
              </li>
            `).join("")}
          </ul>
        </details>
      ` : `<div class="plan-no-deletions">${escapeHtml(t("planNoDeletions"))}</div>`}
    </section>`;
}

function renderPlanImpact(plan: Plan): string {
  const local = plan.local ?? emptyPlanSide();
  const remote = plan.remote ?? emptyPlanSide();
  const rows: Array<{ key: TranslationKey; local: number; remote: number }> = [
    { key: "planCreates", local: local.creates, remote: remote.creates },
    { key: "planUpdates", local: local.updates, remote: remote.updates },
    { key: "planMoves", local: local.moves, remote: remote.moves },
    { key: "planDeletes", local: local.deletes, remote: remote.deletes },
  ];
  return `
    <div class="plan-impact" data-plan-impact>
      <table class="plan-impact-table">
        <caption>${escapeHtml(t("planImpactCaption"))}</caption>
        <thead>
          <tr>
            <th scope="col">${escapeHtml(t("planChangeType"))}</th>
            <th scope="col">${escapeHtml(t("planLocalSide"))}</th>
            <th scope="col">${escapeHtml(t("planRemoteSide"))}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <th scope="row">${escapeHtml(t(row.key))}</th>
              <td>${formatCount(row.local)}</td>
              <td>${formatCount(row.remote)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <div class="plan-side-details">
        ${renderPlanSideDetails(t("planLocalSide"), local, plan.sources?.local ?? null)}
        ${renderPlanSideDetails(t("planRemoteSide"), remote, plan.sources?.remote ?? null)}
      </div>
    </div>`;
}

function renderSyncResultCard(plan: Plan, updatedAt?: string): string {
  const snapshot = plan.snapshot ?? { status: "not_required" as const, reason: null };
  return `
    <section class="sync-result-card" data-result-card tabindex="-1" role="status" aria-live="polite" aria-labelledby="sync-result-title">
      <div class="sync-result-heading">
        <div>
          <strong id="sync-result-title">${escapeHtml(t("syncCompletedTitle"))}</strong>
          <p>${escapeHtml(t("syncCompletedDesc", { updatedAt: updatedAt ? formatDate(updatedAt, getLanguage()) : t("neverDate") }))}</p>
        </div>
        <span class="badge green">${escapeHtml(snapshotStatusLabel(snapshot.status))}</span>
      </div>
      ${renderPlanImpact(plan)}
    </section>`;
}

function renderPlanPreviewNotice(plan: Plan): string {
  const complete = planReviewComplete(plan);
  const local = plan.local ?? emptyPlanSide();
  const remote = plan.remote ?? emptyPlanSide();
  const hasChanges = plan.hasChanges || local.totalChanges > 0 || remote.totalChanges > 0;
  const snapshot = plan.snapshot ?? { status: "not_required" as const, reason: null };
  return `
    <section class="notice preview-notice" data-preview-card data-result-card tabindex="-1" aria-labelledby="preview-title">
      <div class="sync-result-heading">
        <div>
          <strong id="preview-title">${escapeHtml(t("lastPreviewTitle"))}</strong>
          <p>${escapeHtml(t("planPreviewNotApplied"))}</p>
        </div>
        <span class="badge blue">${escapeHtml(t("badgePreview"))}</span>
      </div>
      ${renderPlanImpact(plan)}
      <div class="plan-snapshot-status">
        <span class="plan-snapshot-label">${escapeHtml(t("snapshotStatusLabel"))}</span>
        <span class="badge ${snapshot.status === "will_create" ? "warn" : "green"}">${escapeHtml(snapshotStatusLabel(snapshot.status))}</span>
        ${snapshot.reason ? `<span class="muted small">${escapeHtml(snapshot.reason)}</span>` : ""}
      </div>
      ${!hasChanges
        ? `<p class="muted small confirmation-ready">${escapeHtml(t("popupPreviewNoChanges"))}</p>`
        : complete
          ? `<p class="muted small confirmation-ready">${escapeHtml(t("confirmationReady"))}</p>`
          : `<p class="notice error plan-incomplete">${escapeHtml(t("planDetailsIncomplete"))}</p>`}
      <div class="button-row" style="margin-top:12px;">
        ${hasChanges ? `<button class="button primary sm" data-action="confirm-sync" ${!complete || syncBusy ? "disabled" : ""}>${escapeHtml(t("confirmAndApplyBtn"))}</button>` : ""}
        <button class="button sm subtle" data-action="dismiss-result">${escapeHtml(t("dismissBtn"))}</button>
      </div>
    </section>`;
}

function renderSyncError(message: string): string {
  return `
    <div class="notice error" data-result-card tabindex="-1" role="alert" aria-live="assertive">
      <strong>${escapeHtml(t("syncFailedTitle"))}</strong>
      <p style="margin:4px 0 8px;">${escapeHtml(message)}</p>
      <button type="button" class="button sm" data-action="retry-sync">${escapeHtml(t("retrySyncBtn"))}</button>
    </div>`;
}

function renderConfirmationNotice(plan: Plan): string {
  const complete = planReviewComplete(plan);
  const snapshot = plan.snapshot ?? { status: "blocked" as const, reason: null };
  return `
    <section class="notice confirmation-notice" data-confirmation-card tabindex="-1" aria-labelledby="confirmation-title">
      <strong id="confirmation-title">${escapeHtml(t("largeChangeTitle"))}</strong>
      <p style="margin:4px 0 10px;">${escapeHtml(t("confirmationReviewDesc"))}</p>
      ${renderPlanImpact(plan)}
      <div class="plan-snapshot-status">
        <span class="plan-snapshot-label">${escapeHtml(t("snapshotStatusLabel"))}</span>
        <span class="badge ${snapshot.status === "will_create" ? "warn" : "green"}">${escapeHtml(snapshotStatusLabel(snapshot.status))}</span>
        ${snapshot.reason ? `<span class="muted small">${escapeHtml(snapshot.reason)}</span>` : ""}
      </div>
      ${complete ? `<p class="muted small confirmation-ready">${escapeHtml(t("confirmationReady"))}</p>` : `<p class="notice error plan-incomplete">${escapeHtml(t("planDetailsIncomplete"))}</p>`}
      <div class="button-row" style="margin-top:12px;">
        <button class="button primary sm" data-action="confirm-sync" ${!complete || syncBusy ? "disabled" : ""}>${escapeHtml(t("confirmAndApplyBtn"))}</button>
        <button class="button sm subtle" data-action="dismiss-result">${escapeHtml(t("dismissBtn"))}</button>
      </div>
    </section>`;
}

function renderOverview(): string {
  if (!dashboard) return `<div class="section"><div class="section-body">${escapeHtml(t("loading"))}</div></div>`;
  const reachabilityChecked = reachabilityResults !== null;
  const ignoredUrls = new Set(dashboard.ignoredReachabilityUrls ?? []);
  const problematicLinks = (reachabilityResults ?? []).filter((item) => {
    const key = item.normalizedUrl || item.url.trim();
    return item.status !== "reachable" && !ignoredUrls.has(key);
  });
  const reviewCount = dashboard.suggestions.length + dashboard.duplicates.length + problematicLinks.length;
  const aiReady = Boolean(dashboard.settings.ai.baseUrl && dashboard.settings.ai.model);

  const notice = actionResult?.status === "confirmation_required" && actionResult.plan
    ? renderConfirmationNotice(actionResult.plan)
    : actionResult?.status === "conflict" && actionResult.plan
      ? renderConflictNotice(actionResult.plan)
      : actionResult?.status === "preview" && actionResult.plan
        ? renderPlanPreviewNotice(actionResult.plan)
      : actionResult?.status === "synced" && actionResult.plan
        ? renderSyncResultCard(actionResult.plan, actionResult.updatedAt)
        : actionResult?.status === "error" || dashboard.lastSyncError
          ? renderSyncError(actionResult?.message || dashboard.lastSyncError || t("syncFailedTitle"))
          : "";

  return `
    ${notice}
    <section class="stats" aria-label="Metrics">
      <div class="stat">
        <div class="stat-header">
          <span class="stat-label">${escapeHtml(t("statBookmarks"))}</span>
          <span class="stat-icon-wrap" style="color:var(--accent-blue); background:var(--accent-blue-subtle);">${bookmarkIconSvg()}</span>
        </div>
        <div class="stat-value">${formatCount(dashboard.stats.bookmarks)}</div>
        <div class="stat-meta">${formatCount(dashboard.stats.folders)} ${escapeHtml(t("statFolders"))}</div>
      </div>
      <div class="stat">
        <div class="stat-header">
          <span class="stat-label">${escapeHtml(t("signalAiTitle"))}</span>
          <span class="stat-icon-wrap" style="color:var(--accent-blue); background:var(--accent-blue-subtle);">${organizeIconSvg()}</span>
        </div>
        <div class="stat-value">${formatCount(dashboard.suggestions.length)}</div>
        <div class="stat-meta">${escapeHtml(dashboard.suggestions.length ? t("workspaceNeedsReview") : t("workspaceLooksGood"))}</div>
      </div>
      <div class="stat">
        <div class="stat-header">
          <span class="stat-label">${escapeHtml(t("signalHealthTitle"))}</span>
          <span class="stat-icon-wrap" style="color:var(--color-good); background:var(--bg-good);">${healthIconSvg()}</span>
        </div>
        <div class="stat-value">${reachabilityChecked ? formatCount(problematicLinks.length) : "—"}</div>
        <div class="stat-meta">${escapeHtml(reachabilityChecked ? (problematicLinks.length ? t("healthProblems") : t("healthAllClear")) : t("signalHealthUnscanned"))}</div>
      </div>
      <div class="stat">
        <div class="stat-header">
          <span class="stat-label">${escapeHtml(t("signalDuplicatesTitle"))}</span>
          <span class="stat-icon-wrap" style="color:var(--color-warn); background:var(--bg-warn);">${duplicateIconSvg()}</span>
        </div>
        <div class="stat-value">${formatCount(dashboard.duplicates.length)}</div>
        <div class="stat-meta">${escapeHtml(t("signalDuplicatesMeta"))}</div>
      </div>
    </section>

    <div class="action-toolbar">
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="status-line"><i class="dot ${reviewCount ? "warn" : ""}"></i>${escapeHtml(reviewCount ? t("workspaceNeedsReview") : t("workspaceLooksGood"))}</span>
        <span class="muted small">· ${escapeHtml(t("workspaceGuardrail"))}</span>
      </div>
      <div class="button-row">
        <button class="button primary sm" data-action="${aiReady ? "generate-ai" : "go-to-ai-settings"}" ${aiGenerating ? 'disabled aria-busy="true"' : ""}>
          ${escapeHtml(aiReady ? (aiGenerating ? t("generatingAiStatus") : t("runAiBtn")) : t("configureAiBtn"))}
        </button>
        <button class="button sm" data-action="scan-bookmarks" ${organizerScanning ? 'disabled aria-busy="true"' : ""}>
          ${escapeHtml(organizerScanning ? t("scanningBookmarksBtn") : t("runHealthCheckBtn"))}
        </button>
        <button class="button sm subtle" data-action="sync" ${syncBusy ? 'disabled aria-busy="true"' : ""}>
          ${escapeHtml(syncBusy ? t("statusBusy") : t("previewSyncBtn"))}
        </button>
      </div>
    </div>

    ${organizerScanning ? renderReachabilityScanning() : ""}

    <!-- Pending Work Queue Section -->
    ${dashboard.suggestions.length || dashboard.duplicates.length || problematicLinks.length ? `
      <section class="section">
        <div class="section-head">
          <div class="section-head-title-wrap">
            <h3>${escapeHtml(t("workspaceReadoutLabel"))}</h3>
            <span class="badge warn">${formatCount(reviewCount)}</span>
          </div>
          <div class="button-row">
            ${dashboard.suggestions.length ? `<button class="button sm subtle" data-nav="organizer">${escapeHtml(t("viewAiQueueBtn"))}</button>` : ""}
            ${problematicLinks.length ? `<button class="button sm subtle" data-nav="health">${escapeHtml(t("viewHealthQueueBtn"))}</button>` : ""}
          </div>
        </div>
        <div class="section-body" style="padding:10px 14px;">
          <div class="list">
            ${dashboard.suggestions.slice(0, 3).map((item) => {
              const kindLabel = suggestionKindLabel(item.kind);
              return `
                <div class="list-row suggestion-row">
                  <div class="list-main">
                    <div class="suggestion-action">
                      <span>${escapeHtml(kindLabel)}</span>
                      ${item.targetFolderPath ? `<span class="suggestion-arrow" aria-hidden="true">${arrowIconSvg()}</span><span class="suggestion-target">${escapeHtml(item.targetFolderPath)}</span>` : ""}
                      ${item.confidence < 0.7 ? `<span class="badge warn sm">${escapeHtml(t("suggestionNeedsReview"))}</span>` : ""}
                    </div>
                    <div class="list-meta suggestion-rationale">${escapeHtml(item.rationale)}</div>
                  </div>
                  <div class="button-row">
                    <button class="button primary sm" data-action="accept-suggestion" data-id="${escapeHtml(item.id)}">${escapeHtml(t("acceptSuggestionBtn"))}</button>
                    <button class="button sm subtle" data-action="ignore-suggestion" data-id="${escapeHtml(item.id)}">${escapeHtml(t("ignoreSuggestionBtn"))}</button>
                  </div>
                </div>
              `;
            }).join("")}
            ${dashboard.suggestions.length > 3 ? `
              <div style="text-align:center; padding:6px 0 2px;">
                <button class="button sm subtle" data-nav="organizer">${escapeHtml(t("viewAiQueueBtn"))} (${dashboard.suggestions.length}) →</button>
              </div>
            ` : ""}
          </div>
        </div>
      </section>
    ` : ""}

    <!-- Storage & Sync Status Card -->
    <section class="section">
      <div class="section-head">
        <div class="section-head-title-wrap">
          <span class="bookmark-node-icon">${syncIconSvg()}</span>
          <h3>${escapeHtml(t("syncFoundationTitle"))}</h3>
        </div>
        <div class="button-row">
          <span class="status-line"><i class="dot ${statusClass(dashboard.status)}"></i>${escapeHtml(localizedStatus(dashboard.status))}</span>
          <button class="button sm subtle" data-nav="sync">${escapeHtml(t("openSyncFoundationBtn"))}</button>
        </div>
      </div>
      <div class="section-body">
        <div class="kv-grid">
          <div class="kv-item">
            <div class="kv-label">${escapeHtml(t("storageTab"))}</div>
            <div class="kv-value">${escapeHtml(providerDisplayName(dashboard.settings.provider))}</div>
          </div>
          <div class="kv-item">
            <div class="kv-label">${escapeHtml(t("syncStrategyTitle"))}</div>
            <div class="kv-value">${escapeHtml(modeDisplayName(dashboard.settings.mode))}</div>
          </div>
          <div class="kv-item">
            <div class="kv-label">${escapeHtml(t("lastSyncPrefix"))}</div>
            <div class="kv-value">${escapeHtml(dashboard.lastSyncAt ? formatDate(dashboard.lastSyncAt, getLanguage(), t("neverDate")) : t("syncNotRunYet"))}</div>
          </div>
          <div class="kv-item">
            <div class="kv-label">${escapeHtml(t("autoSyncSettingLabel"))}</div>
            <div class="kv-value">${escapeHtml(dashboard.settings.autoSync === "off" ? t("autoSyncOff") : dashboard.settings.autoSync)}</div>
          </div>
        </div>
      </div>
    </section>

    ${dashboard.conflicts.length ? `
      <section class="section">
        <div class="section-head">
          <div class="section-head-title-wrap">
            <h3>${escapeHtml(t("conflictsWaitingTitle"))}</h3>
            <span class="badge red">${dashboard.conflicts.length}</span>
          </div>
          <button class="button sm" data-nav="sync">${escapeHtml(t("reviewConflictsBtn"))}</button>
        </div>
        <div class="section-body">
          <p class="muted small">${escapeHtml(t("conflictsWaitingDesc"))}</p>
        </div>
      </section>
    ` : ""}`;
}

function renderConflictNodeDetails(
  node: BookmarkNode | undefined,
  options: { titleDiff?: boolean; urlDiff?: boolean; folderDiff?: boolean } = {},
): string {
  if (!node) return `<div class="conflict-missing">${escapeHtml(t("conflictNodeMissing"))}</div>`;
  return `
    <div class="conflict-prop">
      <strong>${escapeHtml(t("conflictTitleLabel"))}:</strong>
      <span class="${options.titleDiff ? "diff-highlight" : ""}">${escapeHtml(node.title || "—")}</span>
      ${options.titleDiff ? `<span class="diff-tag mod">${escapeHtml(t("diffModified"))}</span>` : ""}
    </div>
    ${node.url ? `
      <div class="conflict-prop">
        <strong>${escapeHtml(t("conflictUrlLabel"))}:</strong>
        <span class="codeish ${options.urlDiff ? "diff-highlight" : ""}">${escapeHtml(node.url)}</span>
        ${options.urlDiff ? `<span class="diff-tag mod">${escapeHtml(t("diffModified"))}</span>` : ""}
      </div>
    ` : ""}
    <div class="conflict-prop">
      <strong>${escapeHtml(t("conflictFolderLabel"))}:</strong>
      <span class="${options.folderDiff ? "diff-highlight" : ""}">${escapeHtml(node.folderPath || t("rootFolder"))}</span>
      ${options.folderDiff ? `<span class="diff-tag move">${escapeHtml(t("diffMoved"))}</span>` : ""}
    </div>`;
}

function renderConflictSourceMeta(source: PlanSource): string {
  return `<div class="conflict-side-meta">${escapeHtml(planSourceLabel(source, t("conflictSourceUnavailable")))}</div>`;
}

function renderConflictNotice(plan: Plan): string {
  const total = plan.conflicts.length;
  const localCount = plan.conflicts.filter((conflict) => conflictChoices[conflict.nodeId] === "local").length;
  const remoteCount = plan.conflicts.filter((conflict) => conflictChoices[conflict.nodeId] === "remote").length;
  const unresolved = total - localCount - remoteCount;
  const baseSource = plan.sources?.base ?? null;
  const localSource = plan.sources?.local ?? null;
  const remoteSource = plan.sources?.remote ?? null;

  return `
    <section class="notice conflict-notice" data-conflict-region tabindex="-1" aria-labelledby="conflicts-choice-title">
      <strong id="conflicts-choice-title">${escapeHtml(t("conflictsChoiceTitle"))}</strong>
      <p class="muted small" style="margin:4px 0 10px;">${escapeHtml(t("conflictsChoiceDesc"))}</p>
      <div class="conflict-source-context" aria-label="${escapeHtml(t("conflictSourceContext"))}">
        <div><span>${escapeHtml(t("conflictBase"))}</span><strong>${escapeHtml(planSourceLabel(baseSource, t("conflictSourceUnavailable")))}</strong></div>
        <div><span>${escapeHtml(t("conflictThisBrowser"))}</span><strong>${escapeHtml(planSourceLabel(localSource, t("conflictSourceUnavailable")))}</strong></div>
        <div><span>${escapeHtml(t("conflictCloud"))}</span><strong>${escapeHtml(planSourceLabel(remoteSource, t("conflictSourceUnavailable")))}</strong></div>
      </div>

      <div class="action-toolbar" style="margin-bottom:10px;">
        <div style="font-size:12px; font-weight:600; color:var(--text-secondary);" aria-live="polite">
          ${escapeHtml(t("conflictSummary", { local: localCount, remote: remoteCount, unresolved }))}
        </div>
        <div class="button-row">
          <button type="button" class="button sm" data-action="conflict-select-all-local">${escapeHtml(t("conflictSelectAllLocal"))}</button>
          <button type="button" class="button sm" data-action="conflict-select-all-remote">${escapeHtml(t("conflictSelectAllRemote"))}</button>
        </div>
      </div>

      <div class="conflict-list">
        ${plan.conflicts.map((conflict) => {
          const itemTitle = conflict.local?.title || conflict.remote?.title || conflict.base?.title || t("bookmark");
          const typeLabel = getConflictTypeLabel(conflict.type);
          const choice = conflictChoices[conflict.nodeId];
          const localChecked = choice === "local";
          const remoteChecked = choice === "remote";
          const titleDiff = Boolean(conflict.local && conflict.remote && conflict.local.title !== conflict.remote.title);
          const urlDiff = Boolean(conflict.local && conflict.remote && conflict.local.url !== conflict.remote.url);
          const folderDiff = Boolean(conflict.local && conflict.remote && (conflict.local.folderPath ?? "") !== (conflict.remote.folderPath ?? ""));
          const conflictId = escapeHtml(conflict.nodeId);

          return `
            <div class="conflict-card" data-conflict-card="${conflictId}">
              <div class="conflict-header">
                <span class="conflict-item-title">${escapeHtml(itemTitle)}</span>
                <span class="badge warn sm">${escapeHtml(typeLabel)}</span>
              </div>
              <div class="conflict-grid">
                <div class="conflict-side conflict-baseline">
                  <div class="conflict-side-header"><span>${escapeHtml(t("conflictBase"))}</span></div>
                  ${renderConflictSourceMeta(baseSource)}
                  ${renderConflictNodeDetails(conflict.base)}
                </div>
                <label class="conflict-side ${localChecked ? "active" : ""}">
                  <div class="conflict-side-header">
                    <input type="radio" name="conflict-${conflictId}" data-conflict-choice="local" data-conflict-id="${conflictId}" aria-label="${escapeHtml(t("conflictChooseLocal", { title: itemTitle }))}" ${localChecked ? "checked" : ""}>
                    <span>${escapeHtml(t("conflictThisBrowser"))}</span>
                    ${!conflict.local ? `<span class="diff-tag del">${escapeHtml(t("diffDeleted"))}</span>` : ""}
                  </div>
                  ${renderConflictSourceMeta(localSource)}
                  ${conflict.local ? renderConflictNodeDetails(conflict.local, { titleDiff, urlDiff, folderDiff }) : `<div class="conflict-missing deleted">${escapeHtml(t("conflictDeletedLocal"))}</div>`}
                </label>
                <label class="conflict-side ${remoteChecked ? "active" : ""}">
                  <div class="conflict-side-header">
                    <input type="radio" name="conflict-${conflictId}" data-conflict-choice="remote" data-conflict-id="${conflictId}" aria-label="${escapeHtml(t("conflictChooseRemote", { title: itemTitle }))}" ${remoteChecked ? "checked" : ""}>
                    <span>${escapeHtml(t("conflictCloud"))}</span>
                    ${!conflict.remote ? `<span class="diff-tag del">${escapeHtml(t("diffDeleted"))}</span>` : ""}
                  </div>
                  ${renderConflictSourceMeta(remoteSource)}
                  ${conflict.remote ? renderConflictNodeDetails(conflict.remote, { titleDiff, urlDiff, folderDiff }) : `<div class="conflict-missing deleted">${escapeHtml(t("conflictDeletedCloud"))}</div>`}
                </label>
              </div>
            </div>
          `;
        }).join("")}
      </div>
      ${unresolved ? `<p class="conflict-unresolved" role="status">${escapeHtml(t("conflictsUnresolved", { count: unresolved }))}</p>` : `<p class="conflict-resolved" role="status">${escapeHtml(t("conflictsAllSelected"))}</p>`}
      <div class="button-row" style="margin-top:14px;">
        <button class="button primary sm" data-action="resolve-conflicts" ${unresolved > 0 || syncBusy ? "disabled" : ""}>${escapeHtml(t("applySelectedConflicts"))}</button>
        <button class="button sm subtle" data-action="dismiss-result">${escapeHtml(t("keepPausedConflicts"))}</button>
      </div>
    </section>
  `;
}

function renderBookmarks(): string {
  const query = bookmarkFilter.trim().toLowerCase();
  const filtered = filteredBookmarkRows();

  // Group by folderPath
  const groups: Record<string, BookmarkNode[]> = {};
  for (const node of filtered) {
    const folder = node.folderPath && node.folderPath.trim() ? node.folderPath : t("rootFolder");
    if (!groups[folder]) groups[folder] = [];
    groups[folder].push(node);
  }

  const folderNames = Object.keys(groups);
  const totalFolders = new Set(bookmarkRows.filter((n) => n.type === "folder").map((n) => n.id)).size || folderNames.length;
  const totalBookmarks = bookmarkRows.filter((n) => n.type === "bookmark").length || bookmarkRows.length;
  const visibleSelectableIds = filtered.filter(isSelectableBookmarkNode).map((node) => node.id);
  const selectedVisibleCount = visibleSelectableIds.filter((id) => selectedBookmarkNodeIds.has(id)).length;
  const allVisibleSelected = visibleSelectableIds.length > 0 && selectedVisibleCount === visibleSelectableIds.length;
  const selectionIsMixed = selectedVisibleCount > 0 && !allVisibleSelected;

  return `<section class="section">
    <div class="section-head bookmark-section-head">
      <div class="section-head-title-wrap">
        <h3>${escapeHtml(t("bookmarksTreeTitle"))}</h3>
        <span class="muted small">${escapeHtml(t("bookmarksFolderCount", { folders: totalFolders, bookmarks: totalBookmarks }))}</span>
      </div>
      <div class="bookmark-section-actions">
        <button type="button" class="button sm subtle bookmark-refresh-btn" data-action="refresh-bookmarks" ${bookmarksRefreshing ? 'disabled aria-busy="true"' : ""}>
          ${refreshIconSvg(bookmarksRefreshing)}
          <span>${escapeHtml(t(bookmarksRefreshing ? "bookmarksRefreshingBtn" : "bookmarksRefreshBtn"))}</span>
        </button>
        <input class="search" data-bookmark-search aria-label="${escapeHtml(t("searchBookmarksPlaceholder"))}" placeholder="${escapeHtml(t("searchBookmarksPlaceholder"))}" value="${escapeHtml(bookmarkFilter)}">
      </div>
    </div>
    <div class="section-body">
      <div class="tree-controls">
        <div class="button-row">
          <button type="button" class="button sm subtle" data-action="expand-all-folders">${escapeHtml(t("bookmarksExpandAll"))}</button>
          <button type="button" class="button sm subtle" data-action="collapse-all-folders">${escapeHtml(t("bookmarksCollapseAll"))}</button>
        </div>
      </div>

      <div class="bookmark-batch-toolbar" aria-label="${escapeHtml(t("bookmarksBatchActions"))}">
        <div class="bookmark-selection-group">
          <label class="bookmark-select-all">
            <input type="checkbox" data-bookmark-select-all aria-label="${escapeHtml(t("bookmarksSelectAll"))}" aria-checked="${selectionIsMixed ? "mixed" : String(allVisibleSelected)}" ${allVisibleSelected ? "checked" : ""} ${visibleSelectableIds.length === 0 || deletingBookmarkNodeIds.size > 0 ? "disabled" : ""}>
            <span>${escapeHtml(t("bookmarksSelectAll"))}</span>
          </label>
          <span class="bookmark-selection-summary" data-bookmark-selection-summary aria-live="polite">${escapeHtml(t("bookmarksSelectedCount", { count: selectedBookmarkNodeIds.size }))}</span>
        </div>
        <div class="button-row">
          <button type="button" class="button sm subtle" data-action="clear-bookmark-selection" ${selectedBookmarkNodeIds.size === 0 || deletingBookmarkNodeIds.size > 0 ? "disabled" : ""}>${escapeHtml(t("bookmarksClearSelection"))}</button>
          <button type="button" class="button sm danger" data-action="delete-selected-bookmarks" ${selectedBookmarkNodeIds.size === 0 || deletingBookmarkNodeIds.size > 0 ? "disabled" : ""}>${trashIconSvg()}<span>${escapeHtml(t("bookmarksDeleteSelected"))}</span></button>
        </div>
      </div>

      ${folderNames.length ? folderNames.map((folderName) => {
        const items = groups[folderName] ?? [];
        const isCollapsed = query ? false : (collapsedFolders[folderName] ?? false);
        return `
          <div class="folder-group ${isCollapsed ? "" : "open"}" data-folder-path="${escapeHtml(folderName)}">
            <div class="folder-header" data-action="toggle-folder" data-folder-path="${escapeHtml(folderName)}" tabindex="0" role="button" aria-expanded="${!isCollapsed}">
              <div class="folder-title-wrap">
                <span class="folder-arrow">${chevronIconSvg()}</span>
                <span class="bookmark-node-icon">${folderIconSvg()}</span>
                <span>${escapeHtml(folderName)}</span>
              </div>
              <span class="badge sm">${escapeHtml(t("bookmarksItemCount", { count: items.length }))}</span>
            </div>
            <div class="folder-children">
              ${items.map((node) => {
                const selectable = isSelectableBookmarkNode(node);
                const selected = selectedBookmarkNodeIds.has(node.id);
                const isDeleting = deletingBookmarkNodeIds.has(node.id);
                const nodeTitle = node.title || (node.type === "folder" ? t("folder") : t("bookmark"));
                const selectionLabel = t(node.type === "folder" ? "selectFolder" : "selectBookmark", { title: nodeTitle });
                const deleteTooltip = node.type === "folder" ? t("deleteFolderTooltip") : t("deleteBookmarkTooltip");
                return `
                  <div class="list-row bookmark-row ${selected ? "is-selected" : ""}" data-bookmark-row data-node-id="${escapeHtml(node.id)}">
                    ${selectable ? `
                      <label class="bookmark-selection-cell">
                        <input type="checkbox" data-bookmark-select data-node-id="${escapeHtml(node.id)}" aria-label="${escapeHtml(selectionLabel)}" ${selected ? "checked" : ""} ${deletingBookmarkNodeIds.size > 0 ? "disabled" : ""}>
                      </label>
                    ` : `<span class="bookmark-selection-cell bookmark-selection-spacer" aria-hidden="true"></span>`}
                    <div class="bookmark-row-main list-main">
                      <div class="list-title bookmark-row-title">
                        <span class="bookmark-node-icon ${node.type === "folder" ? "folder" : "bookmark"}">${node.type === "folder" ? folderIconSvg() : bookmarkIconSvg()}</span>
                        <span>${escapeHtml(nodeTitle)}</span>
                      </div>
                      ${node.url ? `<div class="list-meta codeish bookmark-row-url">${escapeHtml(node.url)}</div>` : ""}
                    </div>
                    <span class="badge sm ${node.type === "folder" ? "blue" : ""}">${escapeHtml(node.type === "folder" ? t("folder") : t("bookmark"))}</span>
                    ${selectable ? `
                      <button type="button" class="button sm danger-ghost bookmark-row-delete" data-action="delete-bookmark" data-node-id="${escapeHtml(node.id)}" data-title="${escapeHtml(nodeTitle)}" data-url="${escapeHtml(node.url ?? "")}" aria-label="${escapeHtml(t("deleteBookmarkBtn"))}: ${escapeHtml(nodeTitle)}" title="${escapeHtml(deleteTooltip)}" ${isDeleting ? 'disabled aria-busy="true"' : ""}>
                        ${trashIconSvg()}<span>${escapeHtml(t("deleteBookmarkBtn"))}</span>
                      </button>
                    ` : ""}
                  </div>
                `;
              }).join("")}
            </div>
          </div>
        `;
      }).join("") : `<div class="empty">${escapeHtml(t("noMatchingBookmarks"))}</div>`}
    </div>
  </section>`;
}

function emptyDestructive(): Destructive {
  return {
    requiresConfirmation: false,
    deletedBookmarks: 0,
    deletedFolders: 0,
    deletedNodes: 0,
    previousNodes: 0,
    nextNodes: 0,
    reasons: [],
  };
}

function emptyPlanSide(): PlanSide {
  return {
    creates: 0,
    updates: 0,
    moves: 0,
    deletes: 0,
    totalChanges: 0,
    before: { bookmarks: 0, folders: 0, total: 0 },
    after: { bookmarks: 0, folders: 0, total: 0 },
    destructive: emptyDestructive(),
    changes: [],
    deletionPaths: [],
  };
}

function renderSync(): string {
  if (!dashboard) return "";
  const plan = actionResult?.plan;
  const lang = getLanguage();
  const savedConflicts = !plan && dashboard.conflicts.length ? dashboard.conflicts : [];
  const conflictPlan: Plan | null = savedConflicts.length ? {
    mode: dashboard.settings.mode,
    hasChanges: true,
    creates: 0,
    updates: 0,
    moves: 0,
    deletes: 0,
    conflicts: savedConflicts,
    destructive: emptyDestructive(),
    remoteDestructive: emptyDestructive(),
    targetCounts: { bookmarks: 0, folders: 0 },
    local: emptyPlanSide(),
    remote: emptyPlanSide(),
    sources: dashboard.conflictSources ?? { base: null, local: null, remote: null },
    snapshot: { status: "blocked", reason: null },
  } : null;
  const activeConflictPlan = plan?.conflicts.length ? plan : conflictPlan;
  return `
    ${actionResult?.status === "confirmation_required" && plan ? renderConfirmationNotice(plan) : ""}
    ${actionResult?.status === "synced" && plan ? renderSyncResultCard(plan, actionResult.updatedAt) : ""}
    ${actionResult?.status === "error" ? renderSyncError(actionResult.message || t("syncFailedTitle")) : ""}
    ${actionResult?.status === "preview" && plan ? renderPlanPreviewNotice(plan) : ""}

    ${activeConflictPlan?.conflicts.length ? renderConflictNotice(activeConflictPlan) : ""}

    <section class="section">
      <div class="section-head">
        <div class="section-head-title-wrap">
          <h3>${escapeHtml(t("syncStrategyTitle"))}</h3>
          <span class="badge blue">${escapeHtml(modeDisplayName(dashboard.settings.mode))}</span>
        </div>
        <button class="button primary sm" data-action="sync" ${syncBusy ? 'disabled aria-busy="true"' : ""}>
          ${escapeHtml(syncBusy ? t("statusBusy") : t("previewSyncBtn"))}
        </button>
      </div>
      <div class="section-body">
        <p class="muted small">${escapeHtml(t("syncStrategyDesc"))}</p>
        <div class="kv-grid" style="margin-top:12px;">
          <div class="kv-item">
            <div class="kv-label">${escapeHtml(t("storageTab"))}</div>
            <div class="kv-value">${escapeHtml(providerDisplayName(dashboard.settings.provider))}</div>
          </div>
          <div class="kv-item">
            <div class="kv-label">${escapeHtml(t("lastSyncPrefix"))}</div>
            <div class="kv-value">${escapeHtml(dashboard.lastSyncAt ? formatDate(dashboard.lastSyncAt, lang, t("neverDate")) : t("syncNotRunYet"))}</div>
          </div>
          <div class="kv-item">
            <div class="kv-label">${escapeHtml(t("statusSynced"))}</div>
            <div class="kv-value"><span class="status-line"><i class="dot ${statusClass(dashboard.status)}"></i>${escapeHtml(localizedStatus(dashboard.status))}</span></div>
          </div>
        </div>
      </div>
    </section>

    <!-- Safety Snapshots List -->
    <section class="section">
      <div class="section-head">
        <div>
          <h3>${escapeHtml(t("safetySectionTitle"))}</h3>
          <p class="section-head-desc">${escapeHtml(t("safetySectionDesc"))}</p>
        </div>
        <span class="badge sm">${dashboard.safetySnapshots.length}</span>
      </div>
      <div class="section-body">
        ${dashboard.safetySnapshots.length ? `
          <div class="list">
            ${dashboard.safetySnapshots.map((snapshot) => `
              <div class="list-row">
                <div class="list-main">
                  <div class="list-title">
                    <span>${escapeHtml(formatDate(snapshot.createdAt, lang))}</span>
                    <span class="badge sm" style="font-family:monospace;">${escapeHtml(snapshot.id.slice(0, 10))}</span>
                  </div>
                  <div class="list-meta">${escapeHtml(snapshot.reason || t("snapshotCreated"))}</div>
                </div>
                <button class="button sm subtle" data-action="restore-safety" data-id="${escapeHtml(snapshot.id)}">${escapeHtml(t("restoreLocallyBtn"))}</button>
              </div>
            `).join("")}
          </div>
        ` : `<div class="empty">${escapeHtml(t("noSnapshotsYet"))}</div>`}
      </div>
    </section>
  `;
}

function renderHistory(history: Array<{ id: string; revision: number; createdAt: string; message: string; bookmarkCount: number; folderCount: number }>): string {
  const lang = getLanguage();
  if (versionPreview) {
    return renderVersionDetails(versionPreview);
  }

  return `
    <section class="section">
      <div class="section-head">
        <div>
          <h3>${escapeHtml(t("historyTitle"))}</h3>
          <p class="section-head-desc">${escapeHtml(t("historyDesc"))}</p>
        </div>
        <span class="badge sm">${history.length}</span>
      </div>
      <div class="section-body">
        ${history.length ? `
          <div class="list">
            ${history.map((entry) => `
              <div class="list-row">
                <div class="list-main">
                  <div class="list-title">
                    <span class="badge blue sm">v${entry.revision}</span>
                    <span>${escapeHtml(formatDate(entry.createdAt, lang))}</span>
                  </div>
                  <div class="list-meta">
                    <span>${entry.bookmarkCount} ${escapeHtml(t("statBookmarks"))} · ${entry.folderCount} ${escapeHtml(t("statFolders"))}</span>
                    ${entry.message ? ` · <span class="muted">${escapeHtml(entry.message)}</span>` : ""}
                  </div>
                </div>
                <div class="button-row">
                  <button class="button sm subtle" data-action="view-version" data-id="${escapeHtml(entry.id)}">${escapeHtml(t("viewVersionBtn"))}</button>
                  <button class="button sm" data-action="restore-version" data-id="${escapeHtml(entry.id)}">${escapeHtml(t("restoreVersionBtn"))}</button>
                </div>
              </div>
            `).join("")}
          </div>
        ` : `<div class="empty">${escapeHtml(t("noSnapshotsYet"))}</div>`}
      </div>
    </section>
  `;
}

function renderVersionDetails(preview: { id: string; repository: { revision: number; nodes: BookmarkNode[] } }): string {
  const nodes = preview.repository.nodes ?? [];
  const bookmarksCount = nodes.filter((n) => n.type === "bookmark").length;
  const foldersCount = nodes.filter((n) => n.type === "folder").length;
  const query = versionSearchFilter.trim().toLowerCase();
  const filteredNodes = query
    ? nodes.filter((n) => `${n.title} ${n.url ?? ""} ${n.folderPath ?? ""}`.toLowerCase().includes(query))
    : nodes;

  return `
    <section class="section">
      <div class="section-head">
        <div>
          <h3>${escapeHtml(t("versionPreviewTitle"))}</h3>
          <p class="section-head-desc">${escapeHtml(t("versionPreviewDesc", { id: preview.id.slice(0, 12), revision: preview.repository.revision }))}</p>
        </div>
        <div class="button-row">
          <button class="button sm primary" data-action="restore-version" data-id="${escapeHtml(preview.id)}">${escapeHtml(t("restoreVersionBtn"))}</button>
          <button class="button sm subtle" data-action="close-version">${escapeHtml(t("close"))}</button>
        </div>
      </div>
      <div class="section-body">
        <div class="kv-grid" style="margin-bottom:12px;">
          <div class="kv-item">
            <div class="kv-label">${escapeHtml(t("versionTotalNodes"))}</div>
            <div class="kv-value">${nodes.length}</div>
          </div>
          <div class="kv-item">
            <div class="kv-label">${escapeHtml(t("versionBookmarks"))}</div>
            <div class="kv-value">${bookmarksCount}</div>
          </div>
          <div class="kv-item">
            <div class="kv-label">${escapeHtml(t("versionFolders"))}</div>
            <div class="kv-value">${foldersCount}</div>
          </div>
        </div>

        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px;">
          <h4 style="margin:0; font-size:12px; font-weight:600;">${escapeHtml(t("versionContentTree"))}</h4>
          <input type="search" class="search" data-action="version-search" placeholder="${escapeHtml(t("searchVersionPlaceholder"))}" value="${escapeHtml(versionSearchFilter)}">
        </div>

        <div class="list" style="max-height:360px; overflow:auto;">
          ${filteredNodes.map((node) => `
            <div class="list-row bookmark-row">
              <div class="list-main">
                <div class="list-title bookmark-row-title">
                  <span class="bookmark-node-icon ${node.type === "folder" ? "folder" : "bookmark"}">${node.type === "folder" ? folderIconSvg() : bookmarkIconSvg()}</span>
                  <span>${escapeHtml(node.title || t(node.type === "folder" ? "folder" : "bookmark"))}</span>
                </div>
                ${node.url ? `<div class="list-meta codeish bookmark-row-url">${escapeHtml(node.url)}</div>` : ""}
              </div>
              <span class="badge sm ${node.type === "folder" ? "blue" : ""}">${escapeHtml(node.type === "folder" ? t("folder") : t("bookmark"))}</span>
            </div>
          `).join("")}
        </div>

        <details class="json-inspector" style="margin-top:12px;">
          <summary>${escapeHtml(t("versionRawJsonToggle"))}</summary>
          <pre class="codeish" style="background:var(--bg-subtle); padding:10px; border-radius:6px; border:1px solid var(--border-subtle); max-height:260px; overflow:auto; margin-top:6px;">${escapeHtml(JSON.stringify(preview.repository, null, 2))}</pre>
        </details>
      </div>
    </section>
  `;
}

function renderReachabilityScanning(): string {
  const progress = reachabilityProgress;
  const total = progress?.total ?? 0;
  const completed = progress?.completed ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const reachableCount = progress?.reachableCount ?? 0;
  const problemCount = progress?.problemCount ?? 0;

  return `
    <div class="reachability-scanning-card">
      <div class="reachability-progress-header">
        <div class="reachability-progress-title">
          <div class="pulse-dot" aria-hidden="true"></div>
          <span>${escapeHtml(t("scanningReachabilityProgress"))}</span>
        </div>
        <div class="reachability-progress-pct">${percent}% (${completed}/${total})</div>
      </div>
      <div class="progress-bar-bg" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100">
        <div class="progress-bar-fill" style="--progress-scale: ${(percent / 100).toFixed(3)};"></div>
      </div>
      <div class="reachability-live-grid">
        <div class="reachability-live-stat">
          <span class="reachability-live-label">${escapeHtml(t("liveTotal"))}</span>
          <span class="reachability-live-val">${total}</span>
        </div>
        <div class="reachability-live-stat">
          <span class="reachability-live-label">${escapeHtml(t("liveCompleted"))}</span>
          <span class="reachability-live-val blue">${completed}</span>
        </div>
        <div class="reachability-live-stat">
          <span class="reachability-live-label">${escapeHtml(t("liveReachable"))}</span>
          <span class="reachability-live-val green">${reachableCount}</span>
        </div>
        <div class="reachability-live-stat">
          <span class="reachability-live-label">${escapeHtml(t("liveProblems"))}</span>
          <span class="reachability-live-val warn">${problemCount}</span>
        </div>
      </div>
      ${progress?.currentTitle || progress?.currentUrl ? `
        <div class="reachability-ticker">
          <span class="reachability-ticker-text">
            <strong>${escapeHtml(t("scanningCurrent", { title: progress.currentTitle ?? "" }))}</strong>
            ${progress.currentUrl ? `<span style="opacity:0.75; margin-left:6px; font-family:monospace;">${escapeHtml(progress.currentUrl)}</span>` : ""}
          </span>
        </div>
      ` : ""}
    </div>
  `;
}

function renderReachabilityResults(): string {
  if (!reachabilityResults) return "";
  const allResults = reachabilityResults;
  const ignoredUrls = new Set(dashboard?.ignoredReachabilityUrls ?? []);
  const isIgnored = (item: LinkReachabilityResult): boolean => ignoredUrls.has(item.normalizedUrl || item.url.trim());
  const problematicLinks = allResults.filter((item) => item.status !== "reachable" && !isIgnored(item));
  const ignoredLinks = allResults.filter(isIgnored);
  const reachableCount = allResults.filter((item) => item.status === "reachable").length;
  const brokenCount = problematicLinks.filter((item) => item.status === "broken" || item.status === "error").length;
  const restrictedCount = problematicLinks.filter((item) => item.status === "restricted" || item.status === "unsupported").length;

  let displayItems = problematicLinks;
  if (reachabilityFilter === "broken") {
    displayItems = problematicLinks.filter((item) => item.status === "broken" || item.status === "error");
  } else if (reachabilityFilter === "restricted") {
    displayItems = problematicLinks.filter((item) => item.status === "restricted" || item.status === "unsupported");
  } else if (reachabilityFilter === "reachable") {
    displayItems = allResults.filter((item) => item.status === "reachable" && !isIgnored(item));
  } else if (reachabilityFilter === "ignored") {
    displayItems = ignoredLinks;
  } else if (reachabilityFilter === "all") {
    displayItems = allResults;
  }

  const statusBadge = (status: LinkReachabilityResult["status"]): string => {
    if (status === "reachable") return "green";
    if (status === "restricted" || status === "unsupported") return "warn";
    return "red";
  };

  const statusLabel = (item: LinkReachabilityResult): string => {
    let label = t(item.status === "broken" ? "linkBroken" : item.status === "error" ? "linkError" : item.status === "restricted" ? "linkRestricted" : item.status === "reachable" ? "liveReachable" : "linkUnsupported");
    if (item.httpStatus) label += ` · HTTP ${item.httpStatus}`;
    return label;
  };

  return `
    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
      <p class="muted small" style="margin:0;">
        ${escapeHtml(t("reachabilitySummary", { reachable: reachableCount, problems: problematicLinks.length, ignored: ignoredLinks.length }))}
      </p>
      <div class="chips-row" style="margin:0;">
        <button type="button" class="chip ${reachabilityFilter === "all-problems" ? "active" : ""}" data-action="reachability-filter" data-filter="all-problems">
          ${escapeHtml(t("filterAllProblems", { count: problematicLinks.length }))}
        </button>
        ${brokenCount > 0 ? `
          <button type="button" class="chip ${reachabilityFilter === "broken" ? "active" : ""}" data-action="reachability-filter" data-filter="broken">
            ${escapeHtml(t("filterBroken"))} (${brokenCount})
          </button>
        ` : ""}
        ${restrictedCount > 0 ? `
          <button type="button" class="chip ${reachabilityFilter === "restricted" ? "active" : ""}" data-action="reachability-filter" data-filter="restricted">
            ${escapeHtml(t("filterRestricted"))} (${restrictedCount})
          </button>
        ` : ""}
        ${ignoredLinks.length > 0 ? `
          <button type="button" class="chip ${reachabilityFilter === "ignored" ? "active" : ""}" data-action="reachability-filter" data-filter="ignored">
            ${escapeHtml(t("filterIgnored"))} (${ignoredLinks.length})
          </button>
        ` : ""}
        <button type="button" class="chip ${reachabilityFilter === "all" ? "active" : ""}" data-action="reachability-filter" data-filter="all">
          ${escapeHtml(t("filterAll", { count: allResults.length }))}
        </button>
      </div>
    </div>
    ${displayItems.length ? `
      <div class="list">
        ${displayItems.map((item) => {
          const isRechecking = recheckingUrl === item.url;
          const isDeleting = Boolean(deletingNodeId && item.nodeIds.includes(deletingNodeId));
          const ignored = isIgnored(item);
          const isUpdatingIgnored = updatingIgnoredUrl === item.url;
          const firstTitle = item.titles[0] || item.url;
          return `
            <div class="reachability-item-card${ignored ? " is-ignored" : ""}">
              <div class="reachability-item-main">
                <div class="reachability-item-title">
                  <span class="bookmark-node-icon">${bookmarkIconSvg()}</span>
                  <span>${escapeHtml(item.titles.join(" · "))}</span>
                </div>
                <div class="reachability-item-path">
                  <span>${escapeHtml(item.folderPaths.join(" · "))}</span>
                </div>
                <span class="reachability-item-url" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</span>
                ${item.error ? `
                  <div class="reachability-item-error">
                    <span>${escapeHtml(item.error === "Failed to fetch" ? t("automaticCheckBlocked") : item.error)}</span>
                  </div>
                ` : ""}
              </div>
              <div class="reachability-item-actions">
                <span class="badge ${statusBadge(item.status)} sm">
                  ${escapeHtml(statusLabel(item))}
                </span>
                ${ignored ? `<span class="badge sm">${escapeHtml(t("ignoredStatus"))}</span>` : ""}
                <button
                  type="button"
                  class="button sm subtle"
                  data-action="try-visit"
                  data-url="${escapeHtml(item.url)}"
                  title="${escapeHtml(t("tryVisitTooltip"))}"
                >
                  <span>${escapeHtml(t("tryVisitBtn"))}</span>
                </button>
                <button
                  type="button"
                  class="button sm subtle"
                  data-action="recheck-link"
                  data-url="${escapeHtml(item.url)}"
                  ${isRechecking ? 'disabled aria-busy="true"' : ""}
                  title="${escapeHtml(t("recheckLinkBtn"))}"
                >
                  <span>${escapeHtml(isRechecking ? t("recheckingLink") : t("recheckLinkBtn"))}</span>
                </button>
                ${item.status !== "reachable" || ignored ? `
                  <button
                    type="button"
                    class="button sm subtle"
                    data-action="toggle-ignore-link"
                    data-url="${escapeHtml(item.url)}"
                    data-ignored="${ignored ? "true" : "false"}"
                    ${isUpdatingIgnored ? 'disabled aria-busy="true"' : ""}
                    title="${escapeHtml(ignored ? t("unignoreLinkTooltip") : t("ignoreLinkTooltip"))}"
                  >
                    <span>${escapeHtml(ignored ? t("unignoreLinkBtn") : t("ignoreLinkBtn"))}</span>
                  </button>
                ` : ""}
                <button
                  type="button"
                  class="button sm danger-ghost"
                  data-action="delete-link-bookmark"
                  data-node-ids="${escapeHtml(JSON.stringify(item.nodeIds))}"
                  data-title="${escapeHtml(firstTitle)}"
                  data-url="${escapeHtml(item.url)}"
                  ${isDeleting ? 'disabled aria-busy="true"' : ""}
                  title="${escapeHtml(t("deleteBookmarkTooltip"))}"
                >
                  ${trashIconSvg()}<span>${escapeHtml(t("deleteBookmarkBtn"))}</span>
                </button>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    ` : `<div class="empty">${escapeHtml(t(reachabilityFilter === "ignored" ? "noIgnoredLinks" : "allLinksReachable"))}</div>`}
  `;
}

function renderReachabilityEmptyState(): string {
  return `
    <div class="reachability-empty">
      <div class="reachability-empty-icon" aria-hidden="true">${healthIconSvg()}</div>
      <strong>${escapeHtml(t("reachabilityEmptyTitle"))}</strong>
      <p>${escapeHtml(t("reachabilityNotScanned"))}</p>
    </div>`;
}

function renderHealth(): string {
  if (!dashboard) return "";
  const checked = reachabilityResults !== null;
  const ignoredUrls = new Set(dashboard.ignoredReachabilityUrls ?? []);
  const allResults = reachabilityResults ?? [];
  const actionableProblems = allResults.filter((item) => item.status !== "reachable" && !ignoredUrls.has(item.normalizedUrl || item.url.trim()));
  const reachableCount = allResults.filter((item) => item.status === "reachable").length;
  const score = checked && allResults.length ? Math.round((reachableCount / allResults.length) * 100) : null;

  return `
    <section class="stats" aria-label="Diagnostic Stats">
      <div class="stat">
        <div class="stat-header">
          <span class="stat-label">${escapeHtml(t("liveTotal"))}</span>
          <span class="stat-icon-wrap" style="color:var(--accent-blue); background:var(--accent-blue-subtle);">${healthIconSvg()}</span>
        </div>
        <div class="stat-value">${checked ? formatCount(allResults.length) : "—"}</div>
        <div class="stat-meta">${escapeHtml(checked ? t("healthCheckedLinks") : t("healthNotChecked"))}</div>
      </div>
      <div class="stat">
        <div class="stat-header">
          <span class="stat-label">${escapeHtml(t("healthReadoutLabel"))}</span>
          <span class="stat-icon-wrap" style="color:var(--color-good); background:var(--bg-good);">${checked && score !== null && score >= 90 ? "●" : "○"}</span>
        </div>
        <div class="stat-value" style="color:${score !== null && score < 90 ? "var(--color-warn)" : "var(--color-good)"};">${score === null ? "—" : `${score}%`}</div>
        <div class="stat-meta">${escapeHtml(checked ? (actionableProblems.length ? t("healthNeedsReview") : t("healthAllClear")) : t("healthNotChecked"))}</div>
      </div>
      <div class="stat">
        <div class="stat-header">
          <span class="stat-label">${escapeHtml(t("liveProblems"))}</span>
          <span class="stat-icon-wrap" style="color:var(--color-error); background:var(--bg-error);">${trashIconSvg()}</span>
        </div>
        <div class="stat-value" style="color:${actionableProblems.length ? "var(--color-error)" : "inherit"};">${checked ? formatCount(actionableProblems.length) : "—"}</div>
        <div class="stat-meta">${escapeHtml(t("healthProblems"))}</div>
      </div>
      <div class="stat">
        <div class="stat-header">
          <span class="stat-label">${escapeHtml(t("ignoredStatus"))}</span>
          <span class="stat-icon-wrap" style="color:var(--text-muted); background:var(--bg-subtle);">-</span>
        </div>
        <div class="stat-value">${checked ? formatCount(allResults.filter((item) => ignoredUrls.has(item.normalizedUrl || item.url.trim())).length) : "—"}</div>
        <div class="stat-meta">${escapeHtml(t("noIgnoredLinks"))}</div>
      </div>
    </section>

    <div class="action-toolbar">
      <div style="display:flex; align-items:center; gap:8px;">
        <h3 style="margin:0;">${escapeHtml(t("healthPageTitle"))}</h3>
        <span class="muted small">· ${escapeHtml(t("healthPageGuardrail"))}</span>
      </div>
      <div class="button-row">
        <button class="button primary sm" data-action="scan-bookmarks" ${organizerScanning ? 'disabled aria-busy="true"' : ""}>
          ${escapeHtml(organizerScanning ? t("scanningBookmarksBtn") : checked ? t("rescanReachabilityBtn") : t("startReachabilityBtn"))}
        </button>
        <button class="button sm subtle" data-nav="bookmarks">${escapeHtml(t("openBookmarkLibraryBtn"))}</button>
      </div>
    </div>

    ${organizerScanning ? renderReachabilityScanning() : checked ? renderReachabilityResults() : renderReachabilityEmptyState()}`;
}

function renderOrganizer(): string {
  if (!dashboard) return "";
  const bookmarksById = new Map<string, BookmarkNode>(
    bookmarkRows
      .filter((node) => node.type === "bookmark")
      .map((node) => [node.id, node] as const),
  );
  const aiReady = Boolean(dashboard.settings.ai.baseUrl && dashboard.settings.ai.model);

  return `
    <div class="action-toolbar">
      <div style="display:flex; align-items:center; gap:8px;">
        <h3 style="margin:0;">${escapeHtml(t("aiWorkspaceTitle"))}</h3>
        <span class="badge ${aiReady ? "blue" : "warn"} sm">${escapeHtml(aiReady ? (dashboard.settings.ai.model || t("popupAiReady")) : t("popupAiSetup"))}</span>
        <span class="muted small">· ${escapeHtml(t("aiWorkspaceGuardrail"))}</span>
      </div>
      <div class="button-row">
        <button class="button primary sm" data-action="${aiReady ? "generate-ai" : "go-to-ai-settings"}" ${aiGenerating ? 'disabled aria-busy="true"' : ""}>
          ${escapeHtml(aiGenerating ? t("generatingAiStatus") : aiReady ? t("generateAiBtn") : t("goToAiSettingsBtn"))}
        </button>
        <button class="button sm subtle" data-nav="health">${escapeHtml(t("openHealthPageBtn"))}</button>
      </div>
    </div>

    ${!aiReady ? `
      <div class="info-banner amber">
        <div class="info-banner-content">
          <div class="info-banner-title">${escapeHtml(t("aiNotConfiguredTip"))}</div>
          <p style="margin:4px 0 8px;">${escapeHtml(t("aiSetupDesc"))}</p>
          <button type="button" class="button sm" data-action="go-to-ai-settings">${escapeHtml(t("goToAiSettingsBtn"))}</button>
        </div>
      </div>
    ` : ""}

    ${aiGenerating ? `
      <div class="reachability-scanning-card" role="status" aria-live="polite" style="margin-bottom:14px;">
        <div class="reachability-progress-header">
          <div class="reachability-progress-title">
            <div class="pulse-dot" aria-hidden="true"></div>
            <span>${escapeHtml(t("generatingAiStatus"))}</span>
          </div>
        </div>
        <p class="muted small" style="margin:4px 0 0;">${escapeHtml(t("aiGeneratingStatus"))}</p>
      </div>
    ` : ""}

    ${actionResult?.status === "error" && actionResult.message ? `
      <div class="notice error" role="alert"><strong>${escapeHtml(t("aiGenerateFailed"))}</strong><span>${escapeHtml(actionResult.message)}</span></div>
    ` : ""}

    <section class="section">
      <div class="section-head">
        <div class="section-head-title-wrap">
          <h3>${escapeHtml(t("aiQueueTitle"))}</h3>
          <span class="badge ${dashboard.suggestions.length ? "blue" : ""} sm">${dashboard.suggestions.length}</span>
        </div>
        <p class="section-head-desc">${escapeHtml(t("aiQueueDesc"))}</p>
      </div>
      <div class="section-body">
        ${dashboard.suggestions.length ? `
          <div class="list">
            ${dashboard.suggestions.map((item) => {
              const sourceBookmark = item.nodeId ? bookmarksById.get(item.nodeId) : undefined;
              const sourceTitle = sourceBookmark?.title.trim() || (item.nodeId ? t("suggestionBookmarkUnavailable") : "");
              const kindLabel = suggestionKindLabel(item.kind);
              return `
                <div class="list-row suggestion-row">
                  <div class="list-main">
                    ${item.nodeId ? `
                      <div class="suggestion-subject ${sourceBookmark ? "" : "is-missing"}">
                        <span class="suggestion-subject-label">${escapeHtml(t("suggestionOriginalBookmark"))}:</span>
                        <span class="suggestion-subject-name" title="${escapeHtml(sourceTitle)}">${escapeHtml(sourceTitle)}</span>
                      </div>
                    ` : ""}
                    <div class="suggestion-action">
                      <span>${escapeHtml(kindLabel)}</span>
                      ${item.targetFolderPath ? `<span class="suggestion-arrow" aria-hidden="true">${arrowIconSvg()}</span><span class="suggestion-target">${escapeHtml(item.targetFolderPath)}</span>` : ""}
                      ${item.confidence < 0.7 ? `<span class="badge warn sm">${escapeHtml(t("suggestionNeedsReview"))}</span>` : ""}
                    </div>
                    <div class="list-meta suggestion-rationale">${escapeHtml(item.rationale)}${item.nodeId ? ` · ${escapeHtml(t("suggestionIdLabel"))}: ${escapeHtml(item.nodeId)}` : ""}</div>
                  </div>
                  <div class="button-row suggestion-actions">
                    <button class="button primary sm" data-action="accept-suggestion" data-id="${escapeHtml(item.id)}">${escapeHtml(t("acceptSuggestionBtn"))}</button>
                    <button class="button sm subtle" data-action="ignore-suggestion" data-id="${escapeHtml(item.id)}">${escapeHtml(t("ignoreSuggestionBtn"))}</button>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        ` : !aiGenerating ? `<div class="empty">${escapeHtml(t("noAiSuggestionsFound"))}</div>` : ""}
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div class="section-head-title-wrap">
          <h3>${escapeHtml(t("duplicatesSectionTitle"))}</h3>
          <span class="badge ${dashboard.duplicates.length ? "warn" : "green"} sm">${dashboard.duplicates.length}</span>
        </div>
        <p class="section-head-desc">${escapeHtml(t("duplicatesDesc"))}</p>
      </div>
      <div class="section-body">
        ${dashboard.duplicates.length ? `
          <div class="list">
            ${dashboard.duplicates.map((group) => `
              <div class="list-row" style="align-items:flex-start;">
                <div class="bookmark-node-icon" style="color:var(--color-warn); margin-top:2px;">${duplicateIconSvg()}</div>
                <div class="list-main">
                  <div class="list-title">${escapeHtml(group.titles.join(" · "))}</div>
                  <div class="list-meta">
                    <span class="badge ${group.type === "exact" ? "red" : "warn"} sm">${group.type === "exact" ? escapeHtml(t("dupExact")) : escapeHtml(t("dupNormalized"))}</span>
                    <span style="margin-left:6px;">${escapeHtml(group.folderPaths.join(" · "))}</span>
                  </div>
                  <span class="codeish" style="display:block; margin-top:3px; color:var(--text-muted);">${escapeHtml(group.normalizedUrl)}</span>
                </div>
              </div>
            `).join("")}
          </div>
        ` : `<div class="empty">${escapeHtml(t("noDuplicatesFound"))}</div>`}
      </div>
    </section>`;
}

function inputField(label: string, name: string, value: string, type = "text", full = false, placeholder = "", help = ""): string {
  const isPassword = type === "password";

  return `
    <div class="field ${full ? "full" : ""}">
      <label for="${name}">${label}</label>
      <div class="${isPassword ? "input-with-action" : ""}">
        <input id="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">
        ${isPassword ? `
          <button type="button" class="button sm subtle" data-toggle-visibility="${name}" title="Toggle visibility" aria-label="Toggle password visibility">
            ${escapeHtml(t("showPassword"))}
          </button>
        ` : ""}
      </div>
      ${help ? `<div class="field-help">${help}</div>` : ""}
    </div>`;
}

function renderSettings(): string {
  if (!dashboard) return "";
  ensureSettingsDraft();
  const settings = settingsForRender() ?? dashboard.settings;
  const currentLang = getLanguage();

  const providerFields = settings.provider === "github"
    ? `
      <div class="setting-grid" style="margin-top: 14px;">
        ${inputField(t("githubToken"), "githubToken", settings.github.token, "password", true, t("githubTokenPlaceholder"), t("githubTokenHelp"))}
        ${inputField(t("githubOwner"), "githubOwner", settings.github.owner, "text", false, "octocat")}
        ${inputField(t("githubRepo"), "githubRepo", settings.github.repository, "text", false, "bookmarks-sync")}
        ${inputField(t("githubBranch"), "githubBranch", settings.github.branch, "text", false, "main")}
        ${inputField(t("githubFilePath"), "githubFilePath", settings.github.filePath, "text", false, "bookmarks.json")}
        <div class="field full" style="margin-top: 4px;">
          <button type="button" class="button sm" data-action="test-connection">${escapeHtml(t("testConnectionBtn"))}</button>
        </div>
      </div>
    `
    : settings.provider === "self-hosted"
      ? `
        <div class="setting-grid" style="margin-top: 14px;">
          ${inputField(t("selfHostedUrl"), "serverUrl", settings.selfHosted.serverUrl, "text", false, "http://127.0.0.1:8787")}
          ${inputField(t("selfHostedToken"), "serverToken", settings.selfHosted.apiToken, "password", false, "sync-secret-token")}
          <div class="field full" style="margin-top: 4px;">
            <button type="button" class="button sm" data-action="test-connection">${escapeHtml(t("testConnectionBtn"))}</button>
          </div>
        </div>
      `
      : settings.provider === "webdav"
        ? `
          <div class="setting-grid" style="margin-top: 14px;">
            ${inputField(t("webdavUrl"), "webdavUrl", settings.webdav.url, "text", true, t("webdavUrlPlaceholder"))}
            ${inputField(t("webdavUsername"), "webdavUsername", settings.webdav.username, "text", false, "username")}
            ${inputField(t("webdavPassword"), "webdavPassword", settings.webdav.password, "password", false, t("webdavPasswordPlaceholder"))}
            ${inputField(t("webdavFilePath"), "webdavFilePath", settings.webdav.filePath, "text", false, "bookmarks.json")}
            <div class="field full" style="margin-top: 4px;">
              <button type="button" class="button sm" data-action="test-connection">${escapeHtml(t("testConnectionBtn"))}</button>
            </div>
          </div>
        `
        : `
        <div style="margin-top: 14px;">
          <div class="info-banner blue">
            <div class="info-banner-content">
              <div class="info-banner-title">${escapeHtml(t("localLocationBannerTitle"))}</div>
              <div>• ${escapeHtml(t("localLocationSandbox"))}</div>
              <div>• ${escapeHtml(t("localLocationPath"))}</div>
              <div>• ${escapeHtml(t("localLocationKey"))}</div>
              <div style="margin-top: 4px; color: var(--text-muted);">${escapeHtml(t("localLocationNote"))}</div>
            </div>
          </div>
          <div class="kv-grid">
            <div class="kv-item">
              <div class="kv-label">${escapeHtml(t("localStatsRevision"))}</div>
              <div class="kv-value">v${localStorageDetails?.revision ?? 0}</div>
            </div>
            <div class="kv-item">
              <div class="kv-label">${escapeHtml(t("localStatsSnapshots"))}</div>
              <div class="kv-value">${localStorageDetails?.historyCount ?? 0}</div>
            </div>
            <div class="kv-item">
              <div class="kv-label">${escapeHtml(t("localStatsSize"))}</div>
              <div class="kv-value">${formatBytes(localStorageDetails?.sizeBytes ?? 0)}</div>
            </div>
          </div>
          <div style="margin-top: 12px;">
            <button type="button" class="button danger sm" data-action="clear-local-storage">${escapeHtml(t("clearLocalStorageBtn"))}</button>
          </div>
        </div>
      `;

  const tabs: Array<{ id: string; labelKey: TranslationKey }> = [
    { id: "general", labelKey: "settingsTabGeneral" },
    { id: "storage", labelKey: "settingsTabStorage" },
    { id: "sync", labelKey: "settingsTabSync" },
    { id: "ai", labelKey: "settingsTabAi" },
    { id: "maintenance", labelKey: "settingsTabDanger" },
  ];

  return `
    <form id="settings-form" aria-describedby="settings-draft-status">
      <div id="settings-draft-status" class="settings-draft-status ${settingsDirty ? "dirty" : ""}" data-settings-draft-status role="status" aria-live="polite">
        ${escapeHtml(settingsDirty ? t("settingsUnsavedChanges") : t("settingsNoUnsavedChanges"))}
      </div>

      <!-- Settings Tab Bar -->
      <div class="settings-tabs" role="tablist" aria-label="${escapeHtml(t("settingsTitle"))}">
        ${tabs.map((tab) => `
          <button type="button" id="settings-tab-${tab.id}" class="settings-tab-btn ${activeSettingsTab === tab.id ? "active" : ""}" data-settings-tab="${tab.id}" role="tab" aria-selected="${activeSettingsTab === tab.id}" aria-controls="settings-pane-${tab.id}" tabindex="${activeSettingsTab === tab.id ? "0" : "-1"}">
            <span>${escapeHtml(t(tab.labelKey))}</span>
          </button>
        `).join("")}
      </div>

      <!-- 1. General Tab Pane -->
      <div id="settings-pane-general" class="settings-tab-pane ${activeSettingsTab === "general" ? "active" : ""}" data-pane="general" role="tabpanel" aria-labelledby="settings-tab-general" ${activeSettingsTab === "general" ? "" : "hidden"}>
        <section class="section">
          <div class="section-head">
            <h3>${escapeHtml(t("settingsTabGeneral"))}</h3>
          </div>
          <div class="section-body">
            <div class="setting-grid">
              <div class="field">
                <label id="languageFieldLabel">${escapeHtml(t("languageLabel"))}</label>
                <div class="segmented-control" role="group" aria-labelledby="languageFieldLabel">
                  <button type="button" class="${currentLang === "zh-CN" ? "active" : ""}" data-action="switch-lang" data-lang="zh-CN">${escapeHtml(t("languageZh"))}</button>
                  <button type="button" class="${currentLang === "en" ? "active" : ""}" data-action="switch-lang" data-lang="en">${escapeHtml(t("languageEn"))}</button>
                </div>
              </div>
              <div class="field">
                <label for="deviceIdField">${escapeHtml(t("deviceIdLabel"))}</label>
                <div class="input-with-action">
                  <input id="deviceIdField" type="text" readonly value="${escapeHtml(dashboard.deviceId)}" style="background:var(--bg-subtle); font-family:monospace; font-size:12px;">
                  <button type="button" class="button sm subtle" data-action="copy-device-id">${escapeHtml(t("copyId"))}</button>
                </div>
                <div class="field-help">${escapeHtml(t("deviceIdDesc"))}</div>
              </div>
            </div>
          </div>
        </section>
      </div>

      <!-- 2. Storage Provider Tab Pane -->
      <div id="settings-pane-storage" class="settings-tab-pane ${activeSettingsTab === "storage" ? "active" : ""}" data-pane="storage" role="tabpanel" aria-labelledby="settings-tab-storage" ${activeSettingsTab === "storage" ? "" : "hidden"}>
        <section class="section">
          <div class="section-head">
            <h3>${escapeHtml(t("settingsTabStorage"))}</h3>
            <span class="badge blue sm">${escapeHtml(providerDisplayName(settings.provider))}</span>
          </div>
          <div class="section-body">
            <div class="choice-row">
              <label class="choice-card ${settings.provider === "local" ? "active" : ""}">
                <input type="radio" name="provider" value="local" ${settings.provider === "local" ? "checked" : ""}>
                <div class="choice-card-head">
                  <span class="choice-card-title">${escapeHtml(t("providerLocalTitle"))}</span>
                </div>
                <span class="badge green sm" style="align-self: flex-start; margin-bottom: 6px;">${escapeHtml(t("providerLocalBadge"))}</span>
                <div class="choice-card-desc">${escapeHtml(t("providerLocalSubtitle"))}</div>
              </label>
              <label class="choice-card ${settings.provider === "github" ? "active" : ""}">
                <input type="radio" name="provider" value="github" ${settings.provider === "github" ? "checked" : ""}>
                <div class="choice-card-head">
                  <span class="choice-card-title">${escapeHtml(t("providerGithubTitle"))}</span>
                </div>
                <span class="badge blue sm" style="align-self: flex-start; margin-bottom: 6px;">${escapeHtml(t("providerGithubBadge"))}</span>
                <div class="choice-card-desc">${escapeHtml(t("providerGithubSubtitle"))}</div>
              </label>
              <label class="choice-card ${settings.provider === "webdav" ? "active" : ""}">
                <input type="radio" name="provider" value="webdav" ${settings.provider === "webdav" ? "checked" : ""}>
                <div class="choice-card-head">
                  <span class="choice-card-title">${escapeHtml(t("providerWebdavTitle"))}</span>
                </div>
                <span class="badge green sm" style="align-self: flex-start; margin-bottom: 6px;">${escapeHtml(t("providerWebdavBadge"))}</span>
                <div class="choice-card-desc">${escapeHtml(t("providerWebdavSubtitle"))}</div>
              </label>
              <label class="choice-card ${settings.provider === "self-hosted" ? "active" : ""}">
                <input type="radio" name="provider" value="self-hosted" ${settings.provider === "self-hosted" ? "checked" : ""}>
                <div class="choice-card-head">
                  <span class="choice-card-title">${escapeHtml(t("providerSelfHostedTitle"))}</span>
                </div>
                <span class="badge sm" style="align-self: flex-start; margin-bottom: 6px;">${escapeHtml(t("providerSelfHostedBadge"))}</span>
                <div class="choice-card-desc">${escapeHtml(t("providerSelfHostedSubtitle"))}</div>
              </label>
            </div>
            ${providerFields}
          </div>
        </section>
      </div>

      <!-- 3. Sync Strategy Tab Pane -->
      <div id="settings-pane-sync" class="settings-tab-pane ${activeSettingsTab === "sync" ? "active" : ""}" data-pane="sync" role="tabpanel" aria-labelledby="settings-tab-sync" ${activeSettingsTab === "sync" ? "" : "hidden"}>
        <section class="section">
          <div class="section-head">
            <h3>${escapeHtml(t("settingsTabSync"))}</h3>
          </div>
          <div class="section-body">
            <div class="setting-grid">
              <div class="field">
                <label for="mode">${escapeHtml(t("syncModeSettingLabel"))}</label>
                <select id="mode" name="mode">
                  <option value="two-way" ${settings.mode === "two-way" ? "selected" : ""}>${escapeHtml(t("strategyTwoWay"))}</option>
                  <option value="publish" ${settings.mode === "publish" ? "selected" : ""}>${escapeHtml(t("strategyPublish"))}</option>
                  <option value="mirror" ${settings.mode === "mirror" ? "selected" : ""}>${escapeHtml(t("strategyMirror"))}</option>
                </select>
              </div>
              <div class="field">
                <label for="autoSync">${escapeHtml(t("autoSyncSettingLabel"))}</label>
                <select id="autoSync" name="autoSync">
                  <option value="off" ${settings.autoSync === "off" ? "selected" : ""}>${escapeHtml(t("autoSyncOff"))}</option>
                  <option value="5m" ${settings.autoSync === "5m" ? "selected" : ""}>${escapeHtml(t("autoSync5m"))}</option>
                  <option value="15m" ${settings.autoSync === "15m" ? "selected" : ""}>${escapeHtml(t("autoSync15m"))}</option>
                  <option value="1h" ${settings.autoSync === "1h" ? "selected" : ""}>${escapeHtml(t("autoSync1h"))}</option>
                </select>
              </div>
              <div class="field full">
                <label style="cursor:pointer; display:flex; align-items:center; gap:8px;">
                  <input type="checkbox" name="syncOnBookmarkChange" ${settings.syncOnBookmarkChange ? "checked" : ""} style="width:auto; height:auto;">
                  <div>
                    <strong style="font-size:12px;">${escapeHtml(t("syncOnChangeLabel"))}</strong>
                    <div class="muted small">${escapeHtml(t("syncOnChangeDesc"))}</div>
                  </div>
                </label>
              </div>
            </div>
            <div class="info-banner amber" style="margin-top:14px; margin-bottom:0">
              <div class="info-banner-content">${escapeHtml(t("safetySafeguardBanner"))}</div>
            </div>
          </div>
        </section>
      </div>

      <!-- 4. AI Organizer Tab Pane -->
      <div id="settings-pane-ai" class="settings-tab-pane ${activeSettingsTab === "ai" ? "active" : ""}" data-pane="ai" role="tabpanel" aria-labelledby="settings-tab-ai" ${activeSettingsTab === "ai" ? "" : "hidden"}>
        <section class="section">
          <div class="section-head">
            <h3>${escapeHtml(t("settingsTabAi"))}</h3>
          </div>
          <div class="section-body">
            <div class="chips-row">
              <span class="muted small" style="font-weight:600">${escapeHtml(t("aiPresetsLabel"))}</span>
              <button type="button" class="chip" data-ai-preset="deepseek">DeepSeek</button>
              <button type="button" class="chip" data-ai-preset="openai">OpenAI</button>
              <button type="button" class="chip" data-ai-preset="gemini">Gemini</button>
              <button type="button" class="chip" data-ai-preset="siliconflow">SiliconFlow</button>
              <button type="button" class="chip" data-ai-preset="ollama">Ollama</button>
              <button type="button" class="chip" data-ai-preset="custom">Custom</button>
            </div>
            <div class="setting-grid">
              ${inputField(t("aiBaseUrl"), "aiBaseUrl", settings.ai.baseUrl, "text", false, "https://api.deepseek.com")}
              ${inputField(t("aiModel"), "aiModel", settings.ai.model, "text", false, "deepseek-chat", t("aiModelHelp"))}
              ${inputField(t("aiApiKey"), "aiApiKey", settings.ai.apiKey, "password", true, "sk-...")}
              <div class="field full" style="margin-top: 4px;">
                <button type="button" class="button sm" data-action="test-ai-connection">${escapeHtml(t("testAiConnectionBtn"))}</button>
                ${aiTestResult ? `
                  <div class="notice ${aiTestResult.ok ? "" : "error"}" style="margin-top: 10px; margin-bottom: 0;">
                    <span>${escapeHtml(aiTestResult.message)}</span>
                  </div>
                ` : ""}
              </div>
            </div>
            <div class="info-banner blue" style="margin-top:14px; margin-bottom:0">
              <div class="info-banner-content">${escapeHtml(t("aiPrivacyBanner"))}</div>
            </div>
          </div>
        </section>
      </div>

      <!-- 5. Maintenance / Danger Tab Pane -->
      <div id="settings-pane-maintenance" class="settings-tab-pane ${activeSettingsTab === "maintenance" ? "active" : ""}" data-pane="maintenance" role="tabpanel" aria-labelledby="settings-tab-maintenance" ${activeSettingsTab === "maintenance" ? "" : "hidden"}>
        <section class="section">
          <div class="section-head">
            <h3 style="color:#b91c1c">${escapeHtml(t("dangerZoneTitle"))}</h3>
          </div>
          <div class="section-body">
            <div class="list">
              <div class="list-row">
                <div class="list-main">
                  <div class="list-title">${escapeHtml(t("resetMappingTitle"))}</div>
                  <div class="list-meta">${escapeHtml(t("resetMappingDesc"))}</div>
                </div>
                <button type="button" class="button danger sm" data-action="reset-mapping">${escapeHtml(t("resetMappingBtn"))}</button>
              </div>
              <div class="list-row">
                <div class="list-main">
                  <div class="list-title">${escapeHtml(t("clearSafetyTitle"))}</div>
                  <div class="list-meta">${escapeHtml(t("clearSafetyDesc"))}</div>
                </div>
                <button type="button" class="button danger sm" data-action="clear-safety-snapshots">${escapeHtml(t("clearSafetyBtn"))}</button>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div class="button-row settings-save-row" style="margin-top:16px; ${activeSettingsTab === "maintenance" ? "display:none;" : ""}">
        <button class="button primary sm" type="submit" ${settingsSaving ? 'disabled aria-busy="true"' : ""}>${escapeHtml(t("saveSettings"))}</button>
      </div>
    </form>`;
}

async function renderPage(): Promise<void> {
  closeActivePopconfirm();
  const renderedSettings = settingsForRender();
  if (renderedSettings?.language) {
    setLanguage(renderedSettings.language);
  }

  if (activePage === "overview") {
    renderShell(renderOverview());
  } else if (activePage === "bookmarks") {
    await ensureBookmarkRowsLoaded();
    renderShell(renderBookmarks());
  } else if (activePage === "sync") {
    renderShell(renderSync());
  } else if (activePage === "organizer") {
    await ensureBookmarkRowsLoaded();
    renderShell(renderOrganizer());
  } else if (activePage === "health") {
    await ensureBookmarkRowsLoaded();
    renderShell(renderHealth());
  } else if (activePage === "settings") {
    ensureSettingsDraft();
    try {
      localStorageDetails = await send<LocalStorageDetails>({ type: "GET_LOCAL_STORAGE_INFO" });
    } catch {
      localStorageDetails = null;
    }
    renderShell(renderSettings());
  } else {
    const response = await send<{ history: Array<{ id: string; revision: number; createdAt: string; message: string; bookmarkCount: number; folderCount: number }> }>({ type: "GET_HISTORY" });
    renderShell(renderHistory(response.history ?? []));
  }
  if (activePage === "bookmarks") syncBookmarkSelectionUi();
  if (focusAfterRender) {
    const focusTarget = document.querySelector<HTMLElement>(focusAfterRender);
    focusAfterRender = null;
    focusTarget?.focus();
  } else if (pendingNavigation) {
    document.querySelector<HTMLElement>("[data-settings-leave-dialog] [role='dialog']")?.focus();
  }
}

async function refresh(): Promise<void> {
  try {
    dashboard = await send<Dashboard>({ type: "GET_STATE" });
    bookmarkRowsLoaded = false;
    if (dashboard?.settings?.language) {
      setLanguage(settingsForRender()?.language ?? dashboard.settings.language);
    }
    await renderPage();
  } catch (error) {
    app.innerHTML = `<main class="main"><div class="content"><div class="notice error" data-result-card tabindex="-1" role="alert" aria-live="assertive"><strong>${escapeHtml(t("syncFailedTitle"))}</strong><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p><button type="button" class="button sm" data-action="retry-sync">${escapeHtml(t("retrySyncBtn"))}</button></div></div></main>`;
  }
}

async function refreshBookmarks(): Promise<void> {
  if (bookmarksRefreshing) return;
  bookmarksRefreshing = true;
  feedbackToast = null;
  await renderPage();

  try {
    dashboard = await send<Dashboard>({ type: "GET_STATE" });
    bookmarkRowsLoaded = false;
    if (dashboard?.settings?.language) setLanguage(dashboard.settings.language);
    await ensureBookmarkRowsLoaded();
    feedbackToast = { type: "success", text: t("bookmarksRefreshed") };
  } catch (error) {
    feedbackToast = {
      type: "error",
      text: `${t("bookmarksRefreshFailed")}: ${error instanceof Error ? error.message : String(error)}`,
    };
    bookmarkRowsLoaded = true;
  } finally {
    bookmarksRefreshing = false;
    await renderPage();
  }
}

function requestPageNavigation(nextPage: string): void {
  if (nextPage === activePage) return;
  if (activePage === "settings") {
    collectCurrentSettingsDraft();
    if (settingsDirty) {
      pendingNavigation = nextPage;
      focusAfterRender = null;
      void renderPage();
      return;
    }
    discardSettingsDraft();
  }
  pendingNavigation = null;
  activePage = nextPage;
  actionResult = null;
  feedbackToast = null;
  if (activePage === "settings") ensureSettingsDraft();
  void renderPage();
}

async function saveSettings(navigateAfter?: string): Promise<void> {
  if (settingsSaving) return;
  collectCurrentSettingsDraft();
  const draft = ensureSettingsDraft();
  if (!draft) return;

  settingsSaving = true;
  feedbackToast = null;
  await renderPage();
  try {
    const response = await send<{ ok: boolean; settings?: Settings; message?: string }>({
      type: "SAVE_SETTINGS",
      settings: cloneSettings(draft),
    });
    if (!response.ok) throw new Error(response.message || t("settingsSaveFailed"));
    if (dashboard) dashboard.settings = response.settings ?? cloneSettings(draft);
    discardSettingsDraft();
    pendingNavigation = null;
    if (navigateAfter) activePage = navigateAfter;
    setLanguage(dashboard?.settings.language ?? draft.language);
    feedbackToast = { type: "success", text: t("settingsSaved") };
    focusAfterRender = "[data-feedback-live]";
  } catch (error) {
    feedbackToast = {
      type: "error",
      text: `${t("settingsSaveFailed")}: ${error instanceof Error ? error.message : String(error)}`,
    };
    focusAfterRender = pendingNavigation ? "[data-settings-leave-dialog] [role='dialog']" : "[data-feedback-live]";
  } finally {
    settingsSaving = false;
    await refresh();
  }
}

function retainConflictChoices(plan: Plan | undefined): void {
  if (!plan?.conflicts?.length) {
    if (plan && !plan.conflicts.length) conflictChoices = {};
    return;
  }
  const ids = new Set(plan.conflicts.map((conflict) => conflict.nodeId));
  conflictChoices = Object.fromEntries(
    Object.entries(conflictChoices).filter(([id, choice]) => ids.has(id) && (choice === "local" || choice === "remote")),
  );
}

async function runSync(confirm = false, decisions?: Record<string, "local" | "remote">, preview = false): Promise<void> {
  if (syncBusy) return;
  if (decisions) {
    const currentConflicts = actionResult?.plan?.conflicts ?? dashboard?.conflicts ?? [];
    const unresolved = currentConflicts.filter((conflict) => decisions[conflict.nodeId] !== "local" && decisions[conflict.nodeId] !== "remote");
    if (unresolved.length) {
      feedbackToast = { type: "error", text: t("conflictsUnresolved", { count: unresolved.length }) };
      await renderPage();
      return;
    }
  }
  syncBusy = true;
  feedbackToast = null;
  try {
    actionResult = await send<{ ok: boolean; status?: string; message?: string; plan?: Plan; updatedAt?: string }>({ type: "SYNC_NOW", confirm, decisions, preview });
    retainConflictChoices(actionResult.plan);
    if (actionResult.status === "synced") focusAfterRender = "[data-result-card]";
    else if (actionResult.status === "confirmation_required") focusAfterRender = "[data-confirmation-card]";
    else if (actionResult.status === "conflict") focusAfterRender = "[data-conflict-region]";
    else if (actionResult.status === "preview") focusAfterRender = "[data-preview-card]";
    else if (actionResult.status === "error") focusAfterRender = "[data-result-card]";
  } catch (error) {
    actionResult = { ok: false, status: "error", message: error instanceof Error ? error.message : String(error) };
    focusAfterRender = "[data-result-card]";
  } finally {
    syncBusy = false;
    await refresh();
  }
}

async function startReachabilityScan(): Promise<void> {
  organizerScanning = true;
  feedbackToast = null;
  reachabilityProgress = {
    total: 0,
    completed: 0,
    reachableCount: 0,
    problemCount: 0,
  };
  await renderPage();

  try {
    const port = chrome.runtime.connect({ name: "reachability-stream" });
    let resolved = false;

    await new Promise<void>((resolve, reject) => {
      port.onMessage.addListener(async (msg: {
        type: string;
        total?: number;
        completed?: number;
        currentResult?: LinkReachabilityResult;
        url?: string;
        title?: string;
        results?: LinkReachabilityResult[];
        message?: string;
      }) => {
        if (msg.type === "PROGRESS") {
          if (msg.total !== undefined && msg.completed !== undefined) {
            const isReachable = msg.currentResult?.status === "reachable";
            reachabilityProgress = {
              total: msg.total,
              completed: msg.completed,
              currentTitle: msg.title || msg.currentResult?.titles[0] || msg.url,
              currentUrl: msg.url || msg.currentResult?.url,
              reachableCount: (reachabilityProgress?.reachableCount ?? 0) + (isReachable ? 1 : 0),
              problemCount: (reachabilityProgress?.problemCount ?? 0) + (msg.currentResult && !isReachable ? 1 : 0),
            };
            void renderPage();
          }
        } else if (msg.type === "COMPLETE") {
          resolved = true;
          reachabilityResults = msg.results ?? [];
          reachabilityProgress = null;
          feedbackToast = { type: "success", text: t("scanComplete") };
          resolve();
        } else if (msg.type === "ERROR") {
          resolved = true;
          reachabilityProgress = null;
          reject(new Error(msg.message ?? t("reachabilityScanFailed")));
        }
      });

      port.onDisconnect.addListener(() => {
        if (!resolved) {
          reachabilityProgress = null;
          resolve();
        }
      });

      port.postMessage({ type: "START" });
    });
  } catch (error) {
    feedbackToast = { type: "error", text: `${t("reachabilityScanFailed")}: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    organizerScanning = false;
    await refresh();
  }
}

async function recheckSingleUrl(url: string): Promise<void> {
  recheckingUrl = url;
  await renderPage();
  try {
    const response = await send<{ ok: boolean; result?: LinkReachabilityResult; message?: string }>({
      type: "CHECK_SINGLE_REACHABILITY",
      url,
    });
    if (!response.ok || !response.result) {
      throw new Error(response.message || t("reachabilityScanFailed"));
    }
    const updated = response.result;
    if (reachabilityResults) {
      const idx = reachabilityResults.findIndex((item) => item.url === url || item.normalizedUrl === updated.normalizedUrl);
      if (idx >= 0) {
        reachabilityResults[idx] = updated;
      } else {
        reachabilityResults.push(updated);
      }
    }
    if (updated.status === "reachable") {
      feedbackToast = { type: "success", text: t("recheckSuccess") };
    } else {
      const statusName = t(updated.status === "broken" ? "linkBroken" : updated.status === "error" ? "linkError" : updated.status === "restricted" ? "linkRestricted" : "linkUnsupported");
      feedbackToast = {
        type: "error",
        text: t("recheckStillFailed", { status: statusName + (updated.httpStatus ? ` (HTTP ${updated.httpStatus})` : "") }),
      };
    }
  } catch (err) {
    feedbackToast = { type: "error", text: `${t("reachabilityScanFailed")}: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    recheckingUrl = null;
    await renderPage();
  }
}

async function setReachabilityIgnored(url: string, ignored: boolean): Promise<void> {
  updatingIgnoredUrl = url;
  await renderPage();
  try {
    const response = await send<{ ok: boolean; ignoredReachabilityUrls?: string[]; message?: string }>({
      type: "SET_REACHABILITY_IGNORED",
      url,
      ignored,
    });
    if (!response.ok) throw new Error(response.message || t("ignoreLinkFailed"));
    if (dashboard) dashboard.ignoredReachabilityUrls = response.ignoredReachabilityUrls ?? [];
    feedbackToast = {
      type: "success",
      text: t(ignored ? "ignoreLinkSuccess" : "unignoreLinkSuccess"),
    };
  } catch (err) {
    feedbackToast = {
      type: "error",
      text: `${t("ignoreLinkFailed")}: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    updatingIgnoredUrl = null;
    await renderPage();
  }
}

type PopconfirmOptions = {
  anchorEl: HTMLElement;
  title: string;
  targetText?: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "warn" | "info";
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
};

let activePopconfirmCleanup: (() => void) | null = null;

function closeActivePopconfirm(): void {
  if (activePopconfirmCleanup) {
    activePopconfirmCleanup();
    activePopconfirmCleanup = null;
  }
}

function showPopconfirm(options: PopconfirmOptions): void {
  closeActivePopconfirm();

  const {
    anchorEl,
    title,
    targetText,
    description,
    confirmText = t("popconfirmConfirmBtn"),
    cancelText = t("popconfirmCancelBtn"),
    variant = "danger",
    onConfirm,
    onCancel,
  } = options;

  const popconfirmId = `popconfirm-${Math.random().toString(36).slice(2, 8)}`;
  const titleId = `${popconfirmId}-title`;
  const targetId = `${popconfirmId}-target`;
  const descId = `${popconfirmId}-desc`;

  const bubble = document.createElement("div");
  bubble.className = "popconfirm-bubble";
  bubble.setAttribute("role", "dialog");
  bubble.setAttribute("aria-modal", "true");
  bubble.setAttribute("aria-labelledby", titleId);
  const describedBy = [targetText ? targetId : "", description ? descId : ""].filter(Boolean).join(" ");
  if (describedBy) bubble.setAttribute("aria-describedby", describedBy);

  const arrow = document.createElement("div");
  arrow.className = "popconfirm-arrow";

  let iconSvg = "";
  if (variant === "danger") {
    iconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
  } else if (variant === "warn") {
    iconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
  } else {
    iconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
  }

  bubble.innerHTML = `
    <div class="popconfirm-header">
      <div class="popconfirm-icon-wrap ${variant}">
        ${iconSvg}
      </div>
      <div class="popconfirm-text">
        <div id="${titleId}" class="popconfirm-title">${escapeHtml(title)}</div>
        ${targetText ? `<div id="${targetId}" class="popconfirm-target" title="${escapeHtml(targetText)}">「${escapeHtml(targetText)}」</div>` : ""}
        ${description ? `<div id="${descId}" class="popconfirm-desc">${escapeHtml(description)}</div>` : ""}
      </div>
    </div>
    <div class="popconfirm-actions">
      <button type="button" class="button sm subtle popconfirm-cancel-btn">${escapeHtml(cancelText)}</button>
      <button type="button" class="button sm ${variant === "danger" ? "danger" : "primary"} popconfirm-confirm-btn">${escapeHtml(confirmText)}</button>
    </div>
  `;
  bubble.appendChild(arrow);
  document.body.appendChild(bubble);

  const updatePosition = () => {
    if (!anchorEl.isConnected || !bubble.isConnected) return;
    const rect = anchorEl.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const gap = 8;
    const padding = 12;

    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const placeAbove = spaceBelow < bubbleRect.height + gap && spaceAbove > spaceBelow;

    let top = 0;
    if (placeAbove) {
      top = rect.top - bubbleRect.height - gap;
      arrow.className = "popconfirm-arrow arrow-bottom";
      bubble.style.setProperty("--popconfirm-enter-y", "4px");
    } else {
      top = rect.bottom + gap;
      arrow.className = "popconfirm-arrow arrow-top";
      bubble.style.setProperty("--popconfirm-enter-y", "-4px");
    }

    let left = rect.right - bubbleRect.width;
    if (left < padding) {
      left = padding;
    }
    if (left + bubbleRect.width > window.innerWidth - padding) {
      left = window.innerWidth - padding - bubbleRect.width;
    }

    bubble.style.top = `${Math.round(top)}px`;
    bubble.style.left = `${Math.round(left)}px`;

    const anchorCenter = rect.left + rect.width / 2;
    const arrowLeft = Math.max(14, Math.min(bubbleRect.width - 24, anchorCenter - left - 5));
    arrow.style.left = `${Math.round(arrowLeft)}px`;
  };

  updatePosition();

  const cancelBtn = bubble.querySelector<HTMLButtonElement>(".popconfirm-cancel-btn");
  const confirmBtn = bubble.querySelector<HTMLButtonElement>(".popconfirm-confirm-btn");

  cancelBtn?.focus();

  let isDismissing = false;
  const dismiss = (confirmed: boolean) => {
    if (isDismissing) return;
    isDismissing = true;
    bubble.classList.add("closing");
    setTimeout(() => {
      if (bubble.isConnected) {
        bubble.remove();
      }
    }, 100);

    cleanup();
    if (confirmed) {
      void onConfirm();
    } else {
      onCancel?.();
      anchorEl.focus();
    }
  };

  const handlePointerDown = (e: PointerEvent) => {
    const target = e.target as Node;
    if (!bubble.contains(target) && !anchorEl.contains(target)) {
      dismiss(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss(false);
      return;
    }
    if (e.key === "Tab") {
      const focusable: HTMLButtonElement[] = [];
      if (cancelBtn && !cancelBtn.disabled) focusable.push(cancelBtn);
      if (confirmBtn && !confirmBtn.disabled) focusable.push(confirmBtn);
      if (focusable.length <= 1) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const handleScrollOrResize = () => {
    updatePosition();
  };

  document.addEventListener("pointerdown", handlePointerDown, true);
  document.addEventListener("keydown", handleKeyDown, true);
  window.addEventListener("scroll", handleScrollOrResize, { passive: true, capture: true });
  window.addEventListener("resize", handleScrollOrResize, { passive: true });

  const cleanup = () => {
    document.removeEventListener("pointerdown", handlePointerDown, true);
    document.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("scroll", handleScrollOrResize, { capture: true });
    window.removeEventListener("resize", handleScrollOrResize);
    activePopconfirmCleanup = null;
  };

  activePopconfirmCleanup = () => {
    if (bubble.isConnected) bubble.remove();
    cleanup();
  };

  cancelBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    dismiss(false);
  });

  confirmBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    dismiss(true);
  });
}

function showBookmarkDeleteConfirmation(anchorEl: HTMLElement, nodeIds: Iterable<string>, title = "", url = ""): void {
  const deletionIds = expandBookmarkDeletionIds(nodeIds);
  const summary = summarizeBookmarkNodes(deletionIds);
  if (!summary.total) {
    feedbackToast = { type: "error", text: t("bookmarksNoSelection") };
    void renderPage();
    return;
  }

  const isBatch = summary.total > 1 || summary.folders > 0;
  const popconfirmOptions: PopconfirmOptions = {
    anchorEl,
    title: isBatch ? t("bookmarksBatchDeleteTitle") : t("popconfirmDeleteTitle"),
    description: isBatch
      ? t("bookmarksBatchDeleteDesc", { bookmarks: summary.bookmarks, folders: summary.folders })
      : t("popconfirmDeleteDesc"),
    confirmText: t("popconfirmConfirmBtn"),
    cancelText: t("popconfirmCancelBtn"),
    variant: "danger",
    onConfirm: () => deleteBookmarkItem(deletionIds, title, url),
  };
  if (!isBatch && (title || url)) popconfirmOptions.targetText = title || url;
  showPopconfirm(popconfirmOptions);
}

async function deleteBookmarkItem(nodeIds: string[], title: string, url: string): Promise<void> {
  const deletionIds = expandBookmarkDeletionIds(nodeIds);
  const deletionSummary = summarizeBookmarkNodes(deletionIds);
  if (!deletionSummary.total) return;
  deletingNodeId = deletionIds[0] ?? url;
  deletingBookmarkNodeIds = new Set(deletionIds);
  await renderPage();
  try {
    const response = await send<{ ok: boolean; status?: string; message?: string; plan?: Plan }>({
      type: "DELETE_BOOKMARKS",
      nodeIds: deletionIds,
      confirm: true,
    });
    if (!response.ok) {
      if (response.status === "conflict" && response.plan) {
        actionResult = response;
        activePage = "sync";
        feedbackToast = { type: "error", text: t("bookmarksDeleteConflict") };
        return;
      }
      throw new Error(response.message || t("deleteBookmarkFailed"));
    }

    if (reachabilityResults) {
      const deletionIdSet = new Set(deletionIds);
      reachabilityResults = reachabilityResults.filter(
        (item) => item.url !== url && !item.nodeIds.some((id) => deletionIdSet.has(id)),
      );
    }
    for (const id of deletionIds) selectedBookmarkNodeIds.delete(id);
    feedbackToast = deletionSummary.total === 1 && deletionSummary.bookmarks === 1
      ? { type: "success", text: t("deleteBookmarkSuccess", { title: title || url }) }
      : { type: "success", text: t("bookmarksDeleteSuccess", { count: deletionSummary.total }) };
    await refresh();
  } catch (err) {
    feedbackToast = { type: "error", text: `${t("deleteBookmarkFailed")}: ${err instanceof Error ? err.message : String(err)}` };
    await renderPage();
  } finally {
    deletingNodeId = null;
    deletingBookmarkNodeIds.clear();
    await renderPage();
  }
}

app.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;

  // Language switch
  const langBtn = target.closest<HTMLElement>("[data-action='switch-lang']");
  if (langBtn) {
    const lang = langBtn.dataset.lang as "zh-CN" | "en";
    if (lang && (lang === "zh-CN" || lang === "en")) {
      setLanguage(lang);
      if (activePage === "settings") {
        const draft = ensureSettingsDraft();
        if (draft) draft.language = lang;
        updateSettingsDirty();
      } else if (dashboard) {
        dashboard.settings.language = lang;
        void send({ type: "SAVE_SETTINGS", settings: { language: lang } });
      }
      void renderPage();
      return;
    }
  }

  const leaveAction = target.closest<HTMLElement>("[data-action^='settings-leave-']")?.dataset.action;
  if (leaveAction === "settings-leave-continue") {
    pendingNavigation = null;
    focusAfterRender = "[data-settings-draft-status]";
    void renderPage();
    return;
  }
  if (leaveAction === "settings-leave-discard") {
    const nextPage = pendingNavigation;
    discardSettingsDraft();
    pendingNavigation = null;
    if (nextPage) {
      activePage = nextPage;
      actionResult = null;
      feedbackToast = null;
    }
    void renderPage();
    return;
  }
  if (leaveAction === "settings-leave-save") {
    void saveSettings(pendingNavigation ?? undefined);
    return;
  }

  // Navigation
  const nav = target.closest<HTMLElement>("[data-nav]")?.dataset.nav;
  if (nav) {
    requestPageNavigation(nav);
    return;
  }

  // Settings Tab Navigation
  const tabBtn = target.closest<HTMLElement>("[data-settings-tab]");
  if (tabBtn) {
    const tabId = tabBtn.dataset.settingsTab;
    if (tabId) {
      collectCurrentSettingsDraft();
      activeSettingsTab = tabId;
      document.querySelectorAll<HTMLElement>(".settings-tab-btn").forEach((btn) => {
        const isSelected = btn.dataset.settingsTab === tabId;
        btn.classList.toggle("active", isSelected);
        btn.setAttribute("aria-selected", String(isSelected));
        btn.setAttribute("tabindex", isSelected ? "0" : "-1");
      });
      document.querySelectorAll<HTMLElement>(".settings-tab-pane").forEach((pane) => {
        pane.classList.toggle("active", pane.dataset.pane === tabId);
        pane.toggleAttribute("hidden", pane.dataset.pane !== tabId);
      });
      const saveRow = document.querySelector<HTMLElement>(".settings-save-row");
      if (saveRow) {
        saveRow.style.display = tabId === "maintenance" ? "none" : "";
      }
      return;
    }
  }

  // Password visibility toggle
  const toggleBtn = target.closest<HTMLButtonElement>("[data-toggle-visibility]");
  if (toggleBtn) {
    const fieldName = toggleBtn.dataset.toggleVisibility;
    if (fieldName) {
      const input = document.getElementById(fieldName) as HTMLInputElement | null;
      if (input) {
        const isPassword = input.type === "password";
        input.type = isPassword ? "text" : "password";
        toggleBtn.textContent = isPassword ? t("hidePassword") : t("showPassword");
      }
    }
    return;
  }

  // Conflict Batch Select All Local
  const selectAllLocalBtn = target.closest<HTMLElement>("[data-action='conflict-select-all-local']");
  if (selectAllLocalBtn) {
    const currentPlan = actionResult?.plan || (dashboard?.conflicts.length ? { conflicts: dashboard.conflicts } : null);
    if (currentPlan?.conflicts) {
      for (const c of currentPlan.conflicts) {
        conflictChoices[c.nodeId] = "local";
      }
      void renderPage();
    }
    return;
  }

  // Conflict Batch Select All Remote
  const selectAllRemoteBtn = target.closest<HTMLElement>("[data-action='conflict-select-all-remote']");
  if (selectAllRemoteBtn) {
    const currentPlan = actionResult?.plan || (dashboard?.conflicts.length ? { conflicts: dashboard.conflicts } : null);
    if (currentPlan?.conflicts) {
      for (const c of currentPlan.conflicts) {
        conflictChoices[c.nodeId] = "remote";
      }
      void renderPage();
    }
    return;
  }

  // Bookmarks Folder Expand/Collapse All
  const expandAllBtn = target.closest<HTMLElement>("[data-action='expand-all-folders']");
  if (expandAllBtn) {
    collapsedFolders = {};
    document.querySelectorAll<HTMLElement>(".folder-group").forEach((el) => el.classList.add("open"));
    return;
  }
  const collapseAllBtn = target.closest<HTMLElement>("[data-action='collapse-all-folders']");
  if (collapseAllBtn) {
    document.querySelectorAll<HTMLElement>(".folder-group").forEach((el) => {
      el.classList.remove("open");
      const path = el.dataset.folderPath;
      if (path) collapsedFolders[path] = true;
    });
    return;
  }

  // Bookmark Single Folder Toggle
  const folderHeader = target.closest<HTMLElement>("[data-action='toggle-folder']");
  if (folderHeader) {
    const path = folderHeader.dataset.folderPath;
    const group = folderHeader.closest<HTMLElement>(".folder-group");
    if (group && path) {
      const isOpen = group.classList.toggle("open");
      collapsedFolders[path] = !isOpen;
      folderHeader.setAttribute("aria-expanded", String(isOpen));
    }
    return;
  }

  // AI Presets
  const aiPreset = target.closest<HTMLElement>("[data-ai-preset]")?.dataset.aiPreset;
  if (aiPreset) {
    aiTestResult = null;
    const form = document.querySelector<HTMLFormElement>("#settings-form");
    if (form) {
      const baseUrlInput = form.querySelector<HTMLInputElement>("#aiBaseUrl");
      const modelInput = form.querySelector<HTMLInputElement>("#aiModel");
      if (baseUrlInput && modelInput) {
        if (aiPreset === "deepseek") {
          baseUrlInput.value = "https://api.deepseek.com";
          modelInput.value = "deepseek-chat";
        } else if (aiPreset === "openai") {
          baseUrlInput.value = "https://api.openai.com/v1";
          modelInput.value = "gpt-4o-mini";
        } else if (aiPreset === "gemini") {
          baseUrlInput.value = "https://generativelanguage.googleapis.com/v1beta/openai/";
          modelInput.value = "gemini-2.0-flash";
        } else if (aiPreset === "siliconflow") {
          baseUrlInput.value = "https://api.siliconflow.cn/v1";
          modelInput.value = "deepseek-ai/DeepSeek-V3";
        } else if (aiPreset === "ollama") {
          baseUrlInput.value = "http://localhost:11434/v1";
          modelInput.value = "qwen2.5";
        } else if (aiPreset === "custom") {
          baseUrlInput.value = "";
          modelInput.value = "";
        }
        collectCurrentSettingsDraft();
      }
    }
    return;
  }

  // Copy Device ID
  const copyBtn = target.closest<HTMLElement>("[data-action='copy-device-id']");
  if (copyBtn && dashboard?.deviceId) {
    void navigator.clipboard.writeText(dashboard.deviceId).then(() => {
      feedbackToast = { type: "success", text: t("copied") };
      void renderPage();
      setTimeout(() => {
        feedbackToast = null;
        void renderPage();
      }, 3000);
    });
    return;
  }

  // Clear Local Storage
  const clearLocalBtn = target.closest<HTMLElement>("[data-action='clear-local-storage']");
  if (clearLocalBtn) {
    showPopconfirm({
      anchorEl: clearLocalBtn,
      title: t("clearLocalStorageBtn"),
      description: t("clearLocalStorageConfirm"),
      confirmText: t("clearLocalStorageBtn"),
      cancelText: t("popconfirmCancelBtn"),
      variant: "danger",
      onConfirm: async () => {
        await send({ type: "CLEAR_LOCAL_STORAGE" });
        feedbackToast = { type: "success", text: t("clearLocalStorageSuccess") };
        await refresh();
      },
    });
    return;
  }

  // Reset Mapping
  const resetMappingBtn = target.closest<HTMLElement>("[data-action='reset-mapping']");
  if (resetMappingBtn) {
    showPopconfirm({
      anchorEl: resetMappingBtn,
      title: t("resetMappingTitle"),
      description: t("resetMappingConfirm"),
      confirmText: t("resetMappingBtn"),
      cancelText: t("popconfirmCancelBtn"),
      variant: "danger",
      onConfirm: async () => {
        await send({ type: "RESET_MAPPING" });
        feedbackToast = { type: "success", text: t("resetMappingSuccess") };
        await refresh();
      },
    });
    return;
  }

  // Clear Safety Snapshots
  const clearSafetyBtn = target.closest<HTMLElement>("[data-action='clear-safety-snapshots']");
  if (clearSafetyBtn) {
    showPopconfirm({
      anchorEl: clearSafetyBtn,
      title: t("clearSafetyTitle"),
      description: t("clearSafetyConfirm"),
      confirmText: t("clearSafetyBtn"),
      cancelText: t("popconfirmCancelBtn"),
      variant: "danger",
      onConfirm: async () => {
        await send({ type: "CLEAR_SAFETY_SNAPSHOTS" });
        feedbackToast = { type: "success", text: t("clearSafetySuccess") };
        await refresh();
      },
    });
    return;
  }

  const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
  if (!action) return;
  if (action === "refresh-bookmarks") {
    void refreshBookmarks();
    return;
  }
  if (action === "clear-bookmark-selection") {
    selectedBookmarkNodeIds.clear();
    syncBookmarkSelectionUi();
    return;
  }
  if (action === "delete-selected-bookmarks") {
    const button = target.closest<HTMLElement>("[data-action='delete-selected-bookmarks']");
    if (!button || selectedBookmarkNodeIds.size === 0) return;
    showBookmarkDeleteConfirmation(button, selectedBookmarkNodeIds);
    return;
  }
  if (action === "delete-bookmark") {
    const button = target.closest<HTMLElement>("[data-action='delete-bookmark']");
    const nodeId = button?.dataset.nodeId;
    if (!button || !nodeId) return;
    showBookmarkDeleteConfirmation(button, [nodeId], button.dataset.title ?? "", button.dataset.url ?? "");
    return;
  }
  if (action === "sync") void runSync(false, undefined, true);
  if (action === "confirm-sync") void runSync(true);
  if (action === "retry-sync") void runSync(false, undefined, true);
  if (action === "dismiss-result") { actionResult = null; void renderPage(); }
  if (action === "resolve-conflicts") void runSync(true, conflictChoices);
  if (action === "reachability-filter") {
    const filter = target.closest<HTMLElement>("[data-filter]")?.dataset.filter as typeof reachabilityFilter;
    if (filter) {
      reachabilityFilter = filter;
      void renderPage();
    }
  }
  if (action === "try-visit") {
    const url = target.closest<HTMLElement>("[data-url]")?.dataset.url;
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }
  if (action === "recheck-link") {
    const url = target.closest<HTMLElement>("[data-url]")?.dataset.url;
    if (url) void recheckSingleUrl(url);
  }
  if (action === "toggle-ignore-link") {
    const btn = target.closest<HTMLElement>("[data-action='toggle-ignore-link']");
    const url = btn?.dataset.url;
    if (url) void setReachabilityIgnored(url, btn?.dataset.ignored !== "true");
  }
  if (action === "delete-link-bookmark") {
    const btn = target.closest<HTMLElement>("[data-action='delete-link-bookmark']");
    if (btn) {
      const rawIds = btn.dataset.nodeIds;
      let nodeIds: string[] = [];
      try {
        nodeIds = rawIds ? (JSON.parse(rawIds) as string[]) : [];
      } catch {
        nodeIds = rawIds ? [rawIds] : [];
      }
      const title = btn.dataset.title || "";
      const url = btn.dataset.url || "";
      showPopconfirm({
        anchorEl: btn,
        title: t("popconfirmDeleteTitle"),
        targetText: title || url,
        description: t("popconfirmDeleteDesc"),
        confirmText: t("popconfirmConfirmBtn"),
        cancelText: t("popconfirmCancelBtn"),
        variant: "danger",
        onConfirm: () => deleteBookmarkItem(nodeIds, title, url),
      });
    }
  }
  if (action === "scan-bookmarks") {
    void startReachabilityScan();
  }
  if (action === "go-to-ai-settings") {
    activePage = "settings";
    activeSettingsTab = "ai";
    actionResult = null;
    feedbackToast = null;
    void renderPage();
    return;
  }
  if (action === "generate-ai") {
    if (aiGenerating) return;
    void (async () => {
      if (!dashboard?.settings.ai.baseUrl || !dashboard?.settings.ai.model) {
        feedbackToast = { type: "error", text: t("aiNotConfiguredTip") };
        void renderPage();
        return;
      }
      aiGenerating = true;
      actionResult = null;
      feedbackToast = null;
      await renderPage();
      try {
        const response = await send<{ ok: boolean; suggestions?: Suggestion[]; message?: string }>({
          type: "GENERATE_AI",
          rationaleLanguage: getLanguage(),
        });
        if (response.ok) {
          actionResult = null;
          const count = response.suggestions?.length ?? 0;
          if (count > 0) {
            feedbackToast = { type: "success", text: t("aiGeneratedCount", { count }) };
          } else {
            feedbackToast = { type: "success", text: t("aiNoSuggestionsGenerated") };
          }
        } else {
          actionResult = { ok: false, status: "error", message: response.message || "Unknown error" };
          feedbackToast = { type: "error", text: `${t("aiGenerateFailed")}${response.message || "Unknown error"}` };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        actionResult = { ok: false, status: "error", message: msg };
        feedbackToast = { type: "error", text: `${t("aiGenerateFailed")}${msg}` };
      } finally {
        aiGenerating = false;
        await refresh();
      }
    })();
    return;
  }
  if (action === "accept-suggestion") {
    void (async () => {
      const id = target.closest<HTMLElement>("[data-id]")?.dataset.id;
      const response = await send<{ ok: boolean; status?: string; message?: string; plan?: Plan }>({
        type: "ACCEPT_SUGGESTION",
        id,
        confirm: false,
      });
      actionResult = response;
      await refresh();
    })();
  }
  if (action === "ignore-suggestion") {
    void (async () => {
      const id = target.closest<HTMLElement>("[data-id]")?.dataset.id;
      await send({ type: "IGNORE_SUGGESTION", id });
      await refresh();
    })();
  }
  if (action === "test-ai-connection") {
    void (async () => {
      const button = target.closest<HTMLButtonElement>("button");
      if (button) button.disabled = true;
      collectCurrentSettingsDraft();
      try {
        const aiDraft = settingsDraft?.ai;
        if (!aiDraft?.baseUrl || !aiDraft?.model) {
          throw new Error(t("aiNotConfiguredTip"));
        }
        const res = await send<{ ok: boolean; model?: string; message?: string }>({
          type: "TEST_AI_CONNECTION",
          ai: aiDraft,
        });
        if (!res.ok) {
          throw new Error(res.message || "Connection failed");
        }
        const successMsg = t("testAiConnectionSuccess", { model: res.model || aiDraft.model });
        aiTestResult = { ok: true, message: successMsg };
        feedbackToast = { type: "success", text: successMsg };
      } catch (error) {
        const errorMsg = `${t("testAiConnectionError")}${error instanceof Error ? error.message : String(error)}`;
        aiTestResult = { ok: false, message: errorMsg };
        feedbackToast = {
          type: "error",
          text: errorMsg,
        };
      } finally {
        if (button) button.disabled = false;
        void renderPage();
      }
    })();
    return;
  }
  if (action === "test-connection") {
    void (async () => {
      const button = target.closest<HTMLButtonElement>("button");
      if (button) button.disabled = true;
      collectCurrentSettingsDraft();
      try {
        const draft = settingsDraft;
        if (!draft) throw new Error(t("settingsDraftUnavailable"));
        await send({ type: "TEST_CONNECTION", settings: cloneSettings(draft) });
        feedbackToast = { type: "success", text: t("testConnectionSuccess") };
      } catch (error) {
        feedbackToast = { type: "error", text: `${t("testConnectionError")}${error instanceof Error ? error.message : String(error)}` };
      } finally {
        if (button) button.disabled = false;
        void renderPage();
      }
    })();
  }
  if (action === "view-version") {
    void (async () => {
      const id = target.closest<HTMLElement>("[data-id]")?.dataset.id;
      if (!id) return;
      const response = await send<{ repository: { revision: number; nodes: BookmarkNode[] } }>({ type: "GET_VERSION", id });
      versionPreview = { id, repository: response.repository };
      await renderPage();
    })();
  }
  if (action === "close-version") {
    versionPreview = null;
    versionSearchFilter = "";
    void renderPage();
  }
  if (action === "restore-version") {
    const btn = target.closest<HTMLElement>("[data-action='restore-version']");
    const id = target.closest<HTMLElement>("[data-id]")?.dataset.id;
    if (!id || !btn) return;
    showPopconfirm({
      anchorEl: btn,
      title: t("restoreVersionConfirm"),
      confirmText: t("restoreVersionBtn"),
      cancelText: t("popconfirmCancelBtn"),
      variant: "warn",
      onConfirm: async () => {
        const response = await send<{ ok: boolean; status?: string; message?: string }>({ type: "RESTORE_VERSION", id });
        actionResult = response;
        await refresh();
      },
    });
  }
  if (action === "restore-safety") {
    const btn = target.closest<HTMLElement>("[data-action='restore-safety']");
    const id = target.closest<HTMLElement>("[data-id]")?.dataset.id;
    if (!id || !btn) return;
    showPopconfirm({
      anchorEl: btn,
      title: t("restoreSafetyConfirm"),
      confirmText: t("restoreLocallyBtn"),
      cancelText: t("popconfirmCancelBtn"),
      variant: "warn",
      onConfirm: async () => {
        const response = await send<{ ok: boolean; status?: string; message?: string }>({ type: "RESTORE_SAFETY", id });
        actionResult = response;
        await refresh();
      },
    });
  }
});

app.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.matches("[data-bookmark-select-all]")) {
    const visibleIds = visibleSelectableBookmarkNodeIds();
    if (target.checked) {
      for (const id of visibleIds) selectedBookmarkNodeIds.add(id);
    } else {
      for (const id of visibleIds) selectedBookmarkNodeIds.delete(id);
    }
    syncBookmarkSelectionUi();
    return;
  }
  if (target.matches("[data-bookmark-select]")) {
    const id = target.dataset.nodeId;
    if (id) {
      if (target.checked) selectedBookmarkNodeIds.add(id);
      else selectedBookmarkNodeIds.delete(id);
      syncBookmarkSelectionUi();
    }
    return;
  }
  if (target.matches("[data-conflict-choice]")) {
    const id = target.dataset.conflictId;
    const choice = target.dataset.conflictChoice;
    if (id && (choice === "local" || choice === "remote")) {
      conflictChoices[id] = choice;
      void renderPage();
    }
  }
  if (target.name === "provider" && activePage === "settings") {
    collectCurrentSettingsDraft();
    const draft = ensureSettingsDraft();
    if (draft && (target.value === "local" || target.value === "github" || target.value === "self-hosted" || target.value === "webdav")) {
      draft.provider = target.value;
      updateSettingsDirty();
    }
    void renderPage();
  }
  if (target.matches("[data-quick-mode]")) {
    void (async () => {
      if (!dashboard) return;
      await send({ type: "SAVE_SETTINGS", settings: { mode: target.value } });
      await refresh();
    })();
  }
  if (activePage === "settings" && target.closest("#settings-form")) {
    collectCurrentSettingsDraft();
  }
});

app.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;
  if (activePage === "settings" && target.closest("#settings-form")) {
    collectCurrentSettingsDraft();
  }
  if (target.matches("[data-bookmark-search]")) {
    bookmarkFilter = target.value;
    void renderPage();
  }
  if (target.matches("[data-action='version-search']")) {
    versionSearchFilter = target.value;
    void renderPage();
  }
});

app.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (pendingNavigation && event.key === "Escape") {
    event.preventDefault();
    pendingNavigation = null;
    focusAfterRender = "[data-settings-draft-status]";
    void renderPage();
    return;
  }
  if (pendingNavigation && event.key === "Tab") {
    const dialog = document.querySelector<HTMLElement>("[data-settings-leave-dialog] [role='dialog']");
    const focusable = dialog ? Array.from(dialog.querySelectorAll<HTMLButtonElement>("button:not([disabled])")) : [];
    if (dialog && focusable.length) {
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    return;
  }
  if (target.matches("[data-settings-tab]") && ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) {
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]"));
    const currentIndex = tabs.indexOf(target as HTMLButtonElement);
    if (currentIndex >= 0) {
      const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0;
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (currentIndex + delta + tabs.length) % tabs.length;
      event.preventDefault();
      tabs[nextIndex]?.focus();
      tabs[nextIndex]?.click();
      return;
    }
  }
  if (event.key === "Enter" || event.key === " ") {
    if (target.matches("[data-action='toggle-folder']")) {
      event.preventDefault();
      target.click();
    }
  }
});

app.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  if (form.id !== "settings-form") return;
  event.preventDefault();
  void saveSettings();
});

window.addEventListener("beforeunload", (event) => {
  if (!settingsDirty) return;
  event.preventDefault();
  event.returnValue = "";
});

void refresh();

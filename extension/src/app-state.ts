import { createDeviceId } from "@bookmark-sync/core";
import type {
  BookmarkIdMapping,
  BookmarkRepository,
  OrganizerSuggestion,
  SyncConflict,
  SyncMode,
} from "@bookmark-sync/core";
import { store } from "./store.js";

export const STATE_KEY = "bookmark-sync-extension-state";

export type AutoSyncInterval = "off" | "5m" | "15m" | "1h";
export type Language = "zh-CN" | "en";

export interface ExtensionSettings {
  language: Language;
  provider: "github" | "self-hosted" | "local" | "webdav";
  mode: SyncMode;
  autoSync: AutoSyncInterval;
  syncOnBookmarkChange: boolean;
  github: {
    token: string;
    owner: string;
    repository: string;
    branch: string;
    filePath: string;
  };
  selfHosted: {
    serverUrl: string;
    apiToken: string;
  };
  webdav: {
    url: string;
    username: string;
    password: string;
    filePath: string;
  };
  ai: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
}

export interface SafetySnapshot {
  id: string;
  createdAt: string;
  reason: string;
  repository: BookmarkRepository;
}

export interface SyncSourceMetadata {
  device: string;
  updatedAt: string;
  revision: number;
}

export interface PendingConflictSources {
  base: SyncSourceMetadata | null;
  local: SyncSourceMetadata | null;
  remote: SyncSourceMetadata | null;
}

export interface ExtensionState {
  deviceId: string;
  mapping: BookmarkIdMapping;
  lastSyncedSnapshot: BookmarkRepository | null;
  lastSyncAt: string | null;
  lastSyncStatus: "never" | "synced" | "confirmation_required" | "conflict" | "error";
  lastSyncError: string | null;
  lastSyncStats: {
    bookmarks: number;
    folders: number;
    changes: number;
  };
  syncInProgress: boolean;
  syncStartedAt: string | null;
  pendingConflicts: SyncConflict[];
  pendingConflictSources: PendingConflictSources | null;
  aiSuggestions: OrganizerSuggestion[];
  ignoredReachabilityUrls: string[];
  safetySnapshots: SafetySnapshot[];
  settings: ExtensionSettings;
}

export function defaultSettings(): ExtensionSettings {
  const isZh = typeof navigator !== "undefined" && navigator.language ? navigator.language.startsWith("zh") : true;
  return {
    language: isZh ? "zh-CN" : "en",
    provider: "local",
    mode: "two-way",
    autoSync: "off",
    syncOnBookmarkChange: false,
    github: { token: "", owner: "", repository: "", branch: "main", filePath: "bookmarks.json" },
    selfHosted: { serverUrl: "http://127.0.0.1:8787", apiToken: "" },
    webdav: { url: "", username: "", password: "", filePath: "bookmarks.json" },
    ai: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "" },
  };
}

function mergeState(raw: Partial<ExtensionState> | undefined): ExtensionState {
  const defaults = defaultSettings();
  const settings = raw?.settings;
  return {
    deviceId: raw?.deviceId ?? createDeviceId(),
    mapping: raw?.mapping ?? { schemaVersion: 1, entries: [] },
    lastSyncedSnapshot: raw?.lastSyncedSnapshot ?? null,
    lastSyncAt: raw?.lastSyncAt ?? null,
    lastSyncStatus: raw?.lastSyncStatus ?? "never",
    lastSyncError: raw?.lastSyncError ?? null,
    lastSyncStats: raw?.lastSyncStats ?? { bookmarks: 0, folders: 0, changes: 0 },
    syncInProgress: false,
    syncStartedAt: null,
    pendingConflicts: raw?.pendingConflicts ?? [],
    pendingConflictSources: raw?.pendingConflictSources ?? null,
    aiSuggestions: raw?.aiSuggestions ?? [],
    ignoredReachabilityUrls: Array.isArray(raw?.ignoredReachabilityUrls)
      ? raw.ignoredReachabilityUrls.filter((url): url is string => typeof url === "string")
      : [],
    safetySnapshots: raw?.safetySnapshots ?? [],
    settings: {
      ...defaults,
      ...settings,
      github: { ...defaults.github, ...settings?.github },
      selfHosted: { ...defaults.selfHosted, ...settings?.selfHosted },
      webdav: { ...defaults.webdav, ...settings?.webdav },
      ai: { ...defaults.ai, ...settings?.ai },
    },
  };
}

export async function loadState(): Promise<ExtensionState> {
  const raw = await store.get<Partial<ExtensionState>>(STATE_KEY);
  const state = mergeState(raw);
  if (!raw?.deviceId) await saveState(state);
  return state;
}

export async function saveState(state: ExtensionState): Promise<void> {
  await store.set(STATE_KEY, state);
}

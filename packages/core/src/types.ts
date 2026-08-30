export type BookmarkNodeType = "bookmark" | "folder";

export interface BookmarkNode {
  id: string;
  type: BookmarkNodeType;
  title: string;
  url?: string;
  parentId: string | null;
  order: number;
  createdAt?: string;
  updatedAt?: string;
  /** Browser-independent role for roots supplied by an adapter. */
  rootKey?: string;
}

export interface BookmarkRepository {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  updatedBy: string;
  nodes: BookmarkNode[];
}

export interface BrowserBookmarkNode {
  browserId: string;
  type: BookmarkNodeType;
  title: string;
  url?: string;
  parentBrowserId: string | null;
  index: number;
  children?: BrowserBookmarkNode[];
  isRoot?: boolean;
  rootKey?: string;
}

export interface BrowserInfo {
  id: string;
  name: string;
  version?: string;
}

export interface CreateBookmarkInput {
  parentBrowserId: string;
  title: string;
  url: string;
  index?: number;
}

export interface CreateFolderInput {
  parentBrowserId: string;
  title: string;
  index?: number;
}

export interface UpdateBookmarkInput {
  title?: string;
  url?: string;
}

export interface MoveNodeInput {
  parentBrowserId: string;
  index?: number;
}

export interface BrowserAdapter {
  getBrowserInfo(): Promise<BrowserInfo>;
  readTree(): Promise<BrowserBookmarkNode[]>;
  createBookmark(input: CreateBookmarkInput): Promise<{ browserId: string }>;
  createFolder(input: CreateFolderInput): Promise<{ browserId: string }>;
  updateBookmark(browserId: string, input: UpdateBookmarkInput): Promise<void>;
  moveNode(browserId: string, input: MoveNodeInput): Promise<void>;
  removeNode(browserId: string): Promise<void>;
}

export interface BookmarkIdMappingEntry {
  canonicalId: string;
  browserBookmarkId: string;
  browserType: BookmarkNodeType;
  title: string;
  normalizedUrl?: string;
  pathKey: string;
  rootKey?: string;
}

export interface BookmarkIdMapping {
  schemaVersion: number;
  entries: BookmarkIdMappingEntry[];
}

export interface CanonicalizeOptions {
  deviceId: string;
  now?: string;
  revision?: number;
  previousMapping?: BookmarkIdMapping;
  previousRepository?: BookmarkRepository | null;
  idFactory?: () => string;
}

export interface CanonicalizationResult {
  repository: BookmarkRepository;
  mapping: BookmarkIdMapping;
}

export type SyncMode = "publish" | "mirror" | "two-way";

export interface Change {
  kind: "create" | "update" | "move" | "delete";
  nodeId: string;
  before?: BookmarkNode;
  after?: BookmarkNode;
}

export type SyncConflictType = "move_move" | "edit_edit" | "delete_edit" | "delete_move";

export interface SyncConflict {
  nodeId: string;
  type: SyncConflictType;
  base?: BookmarkNode;
  local?: BookmarkNode;
  remote?: BookmarkNode;
}

export interface DestructiveChangeReport {
  requiresConfirmation: boolean;
  deletedBookmarks: number;
  deletedFolders: number;
  deletedNodes: number;
  previousNodes: number;
  nextNodes: number;
  reasons: string[];
}

export interface SyncPlan {
  mode: SyncMode;
  target: BookmarkRepository;
  creates: Change[];
  updates: Change[];
  moves: Change[];
  deletes: Change[];
  conflicts: SyncConflict[];
  remoteChanges: Change[];
  destructive: DestructiveChangeReport;
  remoteDestructive: DestructiveChangeReport;
  hasChanges: boolean;
}

export interface RemoteState {
  repository: BookmarkRepository;
  etag?: string;
}

export interface CommitMetadata {
  message?: string;
  author?: string;
}

export interface PushResult {
  revision: number;
  id?: string;
  createdAt: string;
}

export interface HistoryEntry {
  id: string;
  revision: number;
  createdAt: string;
  message: string;
  author?: string;
  bookmarkCount: number;
  folderCount: number;
}

export interface StorageAdapter {
  pull(): Promise<RemoteState | null>;
  push(repository: BookmarkRepository, metadata?: CommitMetadata): Promise<PushResult>;
  getHistory(): Promise<HistoryEntry[]>;
  getVersion(id: string): Promise<BookmarkRepository>;
  restoreVersion(id: string): Promise<void>;
  testConnection?(): Promise<void>;
}

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface StorageConfig {
  provider: "github" | "self-hosted" | "local" | "webdav";
  github?: {
    token: string;
    owner: string;
    repository: string;
    branch: string;
    filePath: string;
  };
  selfHosted?: {
    serverUrl: string;
    apiToken: string;
  };
  webdav?: {
    url: string;
    username?: string;
    password?: string;
    filePath?: string;
  };
}

export interface OrganizerBookmarkInput {
  id: string;
  title: string;
  url: string;
  hostname: string;
  folderPath: string;
}

export interface OrganizerRequest {
  folders: string[];
  bookmarks: OrganizerBookmarkInput[];
  rationaleLanguage?: "zh-CN" | "en";
}

export type OrganizerSuggestionKind = "move" | "create-folder" | "merge-folder" | "semantic-duplicate";

export interface OrganizerSuggestion {
  id: string;
  kind: OrganizerSuggestionKind;
  nodeId?: string;
  targetFolderPath?: string;
  sourceFolderPath?: string;
  suggestedTitle?: string;
  relatedNodeIds?: string[];
  confidence: number;
  rationale: string;
}

export interface OrganizerResult {
  suggestions: OrganizerSuggestion[];
}

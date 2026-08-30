import type {
  BrowserAdapter,
  BrowserBookmarkNode,
  BrowserInfo,
  CreateBookmarkInput,
  CreateFolderInput,
  MoveNodeInput,
  UpdateBookmarkInput,
} from "@bookmark-sync/core";

export interface ChromiumRawBookmarkNode {
  id: string;
  title: string;
  url?: string;
  parentId?: string;
  index?: number;
  children?: ChromiumRawBookmarkNode[];
}

export interface ChromiumBookmarksApi {
  getTree(): Promise<ChromiumRawBookmarkNode[]>;
  create(details: { parentId: string; index?: number; title: string; url?: string }): Promise<{ id: string }>;
  update(id: string, changes: { title?: string; url?: string }): Promise<void>;
  move(id: string, destination: { parentId: string; index?: number }): Promise<void>;
  removeTree(id: string): Promise<void>;
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function rootKeyFor(title: string, index: number): string {
  const normalized = normalizeLabel(title);
  if (normalized.includes("bookmark") && normalized.includes("bar")) return "bookmarks-bar";
  if (normalized.includes("favorite") && normalized.includes("bar")) return "bookmarks-bar";
  if (normalized.includes("other") && (normalized.includes("bookmark") || normalized.includes("favorite"))) return "other-bookmarks";
  if (normalized.includes("mobile")) return "mobile-bookmarks";
  return `root-slot-${index}`;
}

function convertNode(
  raw: ChromiumRawBookmarkNode,
  parentBrowserId: string | null,
  index: number,
  isSyntheticRoot = false,
  rootKey?: string,
): BrowserBookmarkNode {
  const children = raw.children?.map((child, childIndex) => convertNode(
    child,
    raw.id,
    child.index ?? childIndex,
    false,
    parentBrowserId === null ? rootKeyFor(child.title, childIndex) : undefined,
  ));
  const node: BrowserBookmarkNode = {
    browserId: raw.id,
    type: raw.url === undefined ? "folder" : "bookmark",
    title: raw.title,
    parentBrowserId,
    index: raw.index ?? index,
  };
  if (raw.url !== undefined) node.url = raw.url;
  if (children?.length) node.children = children;
  if (isSyntheticRoot) node.isRoot = true;
  if (rootKey) node.rootKey = rootKey;
  return node;
}

export class ChromiumBrowserAdapter implements BrowserAdapter {
  constructor(private readonly bookmarks: ChromiumBookmarksApi, private readonly navigatorObject: Navigator = navigator) {}

  async getBrowserInfo(): Promise<BrowserInfo> {
    const userAgent = this.navigatorObject.userAgent;
    const edge = userAgent.match(/Edg\/([\d.]+)/);
    const chrome = userAgent.match(/Chrome\/([\d.]+)/);
    if (edge?.[1]) return { id: "edge", name: "Microsoft Edge", version: edge[1] };
    if (chrome?.[1]) return { id: "chrome", name: "Google Chrome", version: chrome[1] };
    return { id: "chromium", name: "Chromium" };
  }

  async readTree(): Promise<BrowserBookmarkNode[]> {
    const rawTree = await this.bookmarks.getTree();
    return rawTree.map((node, index) => convertNode(node, null, index, true, "browser-root"));
  }

  async createBookmark(input: CreateBookmarkInput): Promise<{ browserId: string }> {
    const details: { parentId: string; index?: number; title: string; url: string } = {
      parentId: input.parentBrowserId,
      title: input.title,
      url: input.url,
    };
    if (input.index !== undefined) details.index = input.index;
    const node = await this.bookmarks.create(details);
    return { browserId: node.id };
  }

  async createFolder(input: CreateFolderInput): Promise<{ browserId: string }> {
    const details: { parentId: string; index?: number; title: string } = { parentId: input.parentBrowserId, title: input.title };
    if (input.index !== undefined) details.index = input.index;
    const node = await this.bookmarks.create(details);
    return { browserId: node.id };
  }

  async updateBookmark(browserId: string, input: UpdateBookmarkInput): Promise<void> {
    await this.bookmarks.update(browserId, input);
  }

  async moveNode(browserId: string, input: MoveNodeInput): Promise<void> {
    const destination: { parentId: string; index?: number } = { parentId: input.parentBrowserId };
    if (input.index !== undefined) destination.index = input.index;
    await this.bookmarks.move(browserId, destination);
  }

  async removeNode(browserId: string): Promise<void> {
    await this.bookmarks.removeTree(browserId);
  }
}

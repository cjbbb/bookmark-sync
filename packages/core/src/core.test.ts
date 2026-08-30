import { describe, expect, it } from "vitest";
import {
  applyConflictDecisions,
  applyRepositoryToBrowser,
  buildOrganizerRequest,
  calculateSyncPlan,
  canonicalizeBrowserTree,
  checkBookmarkReachability,
  checkSingleBookmarkReachability,
  detectDuplicates,
  diffRepositories,
  emptyRepository,
  extractAndParseJson,
  mergeRepositories,
  normalizeUrl,
  OpenAICompatibleProvider,
  rebaseCanonicalIds,
  runRuleEngine,
  validateOrganizerResult,
  type BookmarkNode,
  type BookmarkRepository,
  type BrowserBookmarkNode,
} from "./index.js";

function repository(nodes: BookmarkNode[], revision = 1): BookmarkRepository {
  return {
    schemaVersion: 1,
    revision,
    updatedAt: "2026-08-29T00:00:00.000Z",
    updatedBy: "test-device",
    nodes,
  };
}

function folder(id: string, title: string, parentId: string | null = null, order = 0): BookmarkNode {
  return { id, type: "folder", title, parentId, order };
}

function bookmark(id: string, title: string, url: string, parentId: string | null = null, order = 0): BookmarkNode {
  return { id, type: "bookmark", title, url, parentId, order };
}

describe("URL normalization and duplicate detection", () => {
  it("removes tracking parameters and fragments without dropping semantic query parameters", () => {
    expect(normalizeUrl("HTTPS://Example.COM/docs/?utm_source=x&keep=1#section")).toBe("https://example.com/docs?keep=1");
  });

  it("finds exact and normalized URL duplicates", () => {
    const repo = repository([
      folder("root", "Bookmarks"),
      bookmark("a", "Example", "https://example.com", "root", 0),
      bookmark("b", "Example copy", "https://example.com/?utm_source=google", "root", 1),
    ]);
    const groups = detectDuplicates(repo);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.type).toBe("normalized");
    expect(groups[0]?.nodeIds).toEqual(["a", "b"]);
  });

  it("reports reachability groups, supports progress updates, and checks single URLs", async () => {
    const repo = repository([
      { id: "root", type: "folder", title: "root", parentId: null, order: 0, rootKey: "browser-root" },
      { id: "a", type: "bookmark", title: "A", url: "https://example.com/?utm_source=x", parentId: "root", order: 0 },
      { id: "b", type: "bookmark", title: "B", url: "https://example.com/?utm_medium=y", parentId: "root", order: 1 },
      { id: "c", type: "bookmark", title: "C", url: "https://missing.test", parentId: "root", order: 2 },
      { id: "d", type: "bookmark", title: "D", url: "javascript:void(0)", parentId: "root", order: 3 },
    ]);
    const calls: string[] = [];
    const progressEvents: number[] = [];
    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      return new Response(null, { status: url.includes("missing") ? 404 : 204 });
    };
    const results = await checkBookmarkReachability(repo, {
      fetchFn: mockFetch as typeof fetch,
      now: () => "2026-08-29T00:00:00.000Z",
      onProgress: (p) => {
        progressEvents.push(p.completed);
      },
    });
    expect(calls).toEqual(["https://example.com/?utm_source=x", "https://missing.test"]);
    expect(progressEvents).toEqual([1, 2, 3]);
    expect(results.find((result) => result.nodeIds.includes("a"))).toMatchObject({ status: "reachable", nodeIds: ["a", "b"] });
    expect(results.find((result) => result.nodeIds.includes("c"))?.status).toBe("broken");
    expect(results.find((result) => result.nodeIds.includes("d"))?.status).toBe("unsupported");

    const singleResult = await checkSingleBookmarkReachability(repo, "https://example.com/?utm_source=x", {
      fetchFn: mockFetch as typeof fetch,
      now: () => "2026-08-29T00:00:00.000Z",
    });
    expect(singleResult.status).toBe("reachable");
    expect(singleResult.nodeIds).toEqual(["a", "b"]);
  });
});

describe("canonical model and browser mapping", () => {
  const tree = (browserRootId: string, bookmarkId: string): BrowserBookmarkNode[] => [{
    browserId: browserRootId,
    type: "folder",
    title: "",
    parentBrowserId: null,
    index: 0,
    isRoot: true,
    rootKey: "browser-root",
    children: [{
      browserId: "bar",
      type: "folder",
      title: "Bookmarks bar",
      parentBrowserId: browserRootId,
      index: 0,
      rootKey: "bookmarks-bar",
      children: [{
        browserId: bookmarkId,
        type: "bookmark",
        title: "ChatGPT",
        url: "https://chatgpt.com/#home",
        parentBrowserId: "bar",
        index: 0,
      }],
    }],
  }];

  it("uses deterministic root IDs and preserves a bookmark ID through browser ID changes", () => {
    const first = canonicalizeBrowserTree(tree("chrome-root", "chrome-bookmark"), {
      deviceId: "device-a",
      now: "2026-08-29T00:00:00.000Z",
      idFactory: () => "canonical-bookmark",
    });
    const firstBookmark = first.repository.nodes.find((node) => node.type === "bookmark");
    expect(first.repository.nodes.find((node) => node.rootKey === "browser-root")?.id).toBe("root:browser-root");
    expect(firstBookmark?.id).toBe("canonical-bookmark");

    const second = canonicalizeBrowserTree(tree("edge-root", "edge-bookmark"), {
      deviceId: "device-a",
      previousMapping: first.mapping,
      previousRepository: first.repository,
      now: "2026-08-29T00:01:00.000Z",
      idFactory: () => "new-id-should-not-be-used",
    });
    expect(second.repository.nodes.find((node) => node.type === "bookmark")?.id).toBe("canonical-bookmark");
    expect(second.mapping.entries.find((entry) => entry.canonicalId === "canonical-bookmark")?.browserBookmarkId).toBe("edge-bookmark");
  });

  it("can align an uninitialized browser with an existing remote canonical repository", () => {
    const local = canonicalizeBrowserTree(tree("edge-root", "edge-bookmark"), {
      deviceId: "edge",
      now: "2026-08-29T00:00:00.000Z",
      idFactory: () => "edge-local-id",
    });
    const remote = canonicalizeBrowserTree(tree("chrome-root", "chrome-bookmark"), {
      deviceId: "chrome",
      now: "2026-08-29T00:00:00.000Z",
      idFactory: () => "chrome-canonical-id",
    });
    const aligned = rebaseCanonicalIds(local, remote.repository);
    expect(aligned.repository.nodes.find((node) => node.type === "bookmark")?.id).toBe("chrome-canonical-id");
  });
});

describe("sync plans", () => {
  it("creates a publish plan that replaces remote content and reports remote deletions", () => {
    const local = repository([folder("root", "Bookmarks"), bookmark("local", "Local", "https://local.test", "root")]);
    const remote = repository([folder("root", "Bookmarks"), bookmark("old", "Old", "https://old.test", "root")], 2);
    const plan = calculateSyncPlan({ mode: "publish", local, remote, now: "2026-08-29T00:02:00.000Z" });
    expect(plan.remoteChanges.map((change) => change.kind)).toContain("delete");
    expect(plan.creates.map((change) => change.nodeId)).toContain("local");
    expect(plan.deletes.map((change) => change.nodeId)).toContain("old");
  });

  it("creates a mirror plan without writing remote content", () => {
    const local = repository([folder("root", "Bookmarks"), bookmark("local", "Local", "https://local.test", "root")]);
    const remote = repository([folder("root", "Bookmarks"), bookmark("cloud", "Cloud", "https://cloud.test", "root")], 2);
    const plan = calculateSyncPlan({ mode: "mirror", local, remote });
    expect(plan.target.nodes.some((node) => node.id === "cloud")).toBe(true);
    expect(plan.remoteChanges).toEqual([]);
    expect(plan.creates.map((change) => change.nodeId)).toContain("cloud");
    expect(plan.deletes.map((change) => change.nodeId)).toContain("local");
  });

  it("merges local-only and remote-only additions in a two-way sync plan", () => {
    const base = repository([folder("root", "Bookmarks"), bookmark("base", "Base", "https://base.test", "root")]);
    const local = repository([...base.nodes, bookmark("local", "Local", "https://local.test", "root", 1)]);
    const remote = repository([...base.nodes, bookmark("remote", "Remote", "https://remote.test", "root", 1)], 2);
    const plan = calculateSyncPlan({ mode: "two-way", base, local, remote });
    expect(plan.conflicts).toEqual([]);
    expect(plan.target.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["base", "local", "remote"]));
  });

  it("preserves independent bookmarks when a browser first joins an existing remote", () => {
    const local = repository([folder("root", "Bookmarks"), bookmark("local", "Local", "https://local.test", "root")]);
    const remote = repository([folder("root", "Bookmarks"), bookmark("remote", "Remote", "https://remote.test", "root")], 2);
    const base = emptyRepository("initial-sync");
    const plan = calculateSyncPlan({ mode: "two-way", base, local, remote });
    expect(plan.conflicts).toEqual([]);
    expect(plan.target.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["local", "remote"]));
  });

  it("bootstraps an empty remote without treating Mirror as permission to erase the browser", () => {
    const local = repository([folder("root", "Bookmarks"), bookmark("local", "Local", "https://local.test", "root")]);
    const plan = calculateSyncPlan({ mode: "mirror", local, remote: null });
    expect(plan.target.nodes).toEqual(local.nodes);
    expect(plan.localChanges).toEqual([]);
    expect(plan.remoteChanges.map((change) => change.kind)).toContain("create");
  });
});

describe("three-way merge and conflicts", () => {
  const base = repository([
    folder("root", "Bookmarks"),
    bookmark("chatgpt", "ChatGPT", "https://chatgpt.com", "root"),
  ]);

  it("keeps independent local and remote additions", () => {
    const local = repository([...base.nodes, bookmark("claude", "Claude", "https://claude.ai", "root", 1)]);
    const remote = repository([...base.nodes, bookmark("gemini", "Gemini", "https://gemini.google.com", "root", 1)], 2);
    const result = mergeRepositories(base, local, remote);
    expect(result.conflicts).toEqual([]);
    expect(result.repository.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["chatgpt", "claude", "gemini"]));
  });

  it("detects edit/edit conflicts", () => {
    const local = repository([folder("root", "Bookmarks"), bookmark("chatgpt", "ChatGPT Tools", "https://chatgpt.com", "root")]);
    const remote = repository([folder("root", "Bookmarks"), bookmark("chatgpt", "ChatGPT Research", "https://chatgpt.com", "root")], 2);
    const result = mergeRepositories(base, local, remote);
    expect(result.conflicts[0]?.type).toBe("edit_edit");
  });

  it("detects move/move conflicts and applies an explicit decision", () => {
    const withFolders = repository([...base.nodes, folder("tools", "Tools"), folder("research", "Research")]);
    const local = repository(withFolders.nodes.map((node) => node.id === "chatgpt" ? { ...node, parentId: "tools" } : node));
    const remote = repository(withFolders.nodes.map((node) => node.id === "chatgpt" ? { ...node, parentId: "research" } : node), 2);
    const result = mergeRepositories(withFolders, local, remote);
    expect(result.conflicts[0]?.type).toBe("move_move");
    const resolved = applyConflictDecisions(result, { chatgpt: "remote" });
    expect(resolved.nodes.find((node) => node.id === "chatgpt")?.parentId).toBe("research");
  });

  it("detects delete/edit conflicts", () => {
    const local = repository([folder("root", "Bookmarks")]);
    const remote = repository([folder("root", "Bookmarks"), bookmark("chatgpt", "Renamed", "https://chatgpt.com", "root")], 2);
    const result = mergeRepositories(base, local, remote);
    expect(result.conflicts[0]?.type).toBe("delete_edit");
  });
});

describe("safety and AI validation", () => {
  it("pauses a large deletion before applying it", () => {
    const oldNodes = [folder("root", "Bookmarks"), ...Array.from({ length: 19 }, (_, index) => bookmark(`b-${index}`, `Bookmark ${index}`, `https://example.com/${index}`, "root", index))];
    const next = repository(oldNodes.slice(0, 5));
    const plan = calculateSyncPlan({ mode: "publish", local: next, remote: repository(oldNodes, 2) });
    expect(plan.destructive.requiresConfirmation).toBe(true);
    expect(plan.destructive.deletedNodes).toBeGreaterThan(10);
  });

  it("validates suggestion-only AI output and rejects unknown nodes", () => {
    const repo = repository([folder("root", "Bookmarks"), bookmark("a", "A", "https://a.test", "root")]);
    const valid = validateOrganizerResult({ suggestions: [{ id: "s1", kind: "move", nodeId: "a", targetFolderPath: "AI", confidence: 0.94, rationale: "The hostname is an AI service." }] }, repo);
    expect(valid.suggestions[0]?.kind).toBe("move");
    expect(() => validateOrganizerResult({ suggestions: [{ id: "s2", kind: "move", nodeId: "missing", targetFolderPath: "AI", confidence: 0.9, rationale: "bad" }] }, repo)).toThrow("Unknown AI node id");
  });

  it("extracts JSON correctly from markdown code blocks and surrounding text", () => {
    const rawWithFences = "```json\n{\"suggestions\": [{\"kind\": \"move\", \"nodeId\": \"a\", \"targetFolderPath\": \"AI\", \"confidence\": 95, \"reason\": \"AI service\"}]}\n```";
    const extracted = extractAndParseJson(rawWithFences);
    const repo = repository([folder("root", "Bookmarks"), bookmark("a", "A", "https://a.test", "root")]);
    const result = validateOrganizerResult(extracted, repo);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.kind).toBe("move");
    expect(result.suggestions[0]?.confidence).toBe(0.95);
    expect(result.suggestions[0]?.rationale).toBe("AI service");
    expect(typeof result.suggestions[0]?.id).toBe("string");
  });

  it("finds a complete JSON value without being confused by braces in text", () => {
    const extracted = extractAndParseJson(
      'The result is: {"suggestions":[{"kind":"create-folder","targetFolderPath":"AI","confidence":0.9,"rationale":"Keep {AI} links together"}]} Thank you.',
    );
    expect(extracted).toEqual({
      suggestions: [{ kind: "create-folder", targetFolderPath: "AI", confidence: 0.9, rationale: "Keep {AI} links together" }],
    });
  });

  it("reports truncated JSON instead of exposing a low-level parser position", () => {
    expect(() => extractAndParseJson('{"suggestions":[{"kind":"create-folder"}')).toThrow("incomplete or invalid JSON");
  });

  it("tests connection successfully and handles error details", async () => {
    let calledUrl = "";
    let calledBody = "";
    const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calledUrl = String(input);
      calledBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200 });
    };

    const provider = new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: "test-key", model: "gpt-4o-mini" }, mockFetch as typeof fetch);
    const res = await provider.testConnection();
    expect(res.ok).toBe(true);
    expect(res.model).toBe("gpt-4o-mini");
    expect(calledUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(calledBody).toContain("gpt-4o-mini");

    const failingMockFetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: { message: "Invalid API key provided" } }), { status: 401 });
    };
    const failingProvider = new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: "bad-key", model: "gpt-4o-mini" }, failingMockFetch as typeof fetch);
    await expect(failingProvider.testConnection()).rejects.toThrow("AI provider returned HTTP 401: Invalid API key provided");
  });

  it("bounds organizer output and explains a truncated completion", async () => {
    let organizerBody = "";
    const mockFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      organizerBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "{\"suggestions\":[]}" } }] }), { status: 200 });
    };

    const provider = new OpenAICompatibleProvider({ baseUrl: "https://api.example.test/v1", apiKey: "", model: "example-model" }, mockFetch as typeof fetch);
    const result = await provider.organize({ folders: [], bookmarks: [], rationaleLanguage: "zh-CN" });
    const body = JSON.parse(organizerBody) as { max_tokens?: number; messages?: Array<{ content?: string }> };
    expect(result.suggestions).toEqual([]);
    expect(body.max_tokens).toBe(4096);
    expect(body.messages?.[0]?.content).toContain("no more than 40 suggestions");
    expect(body.messages?.[0]?.content).toContain("Simplified Chinese");

    const truncatedFetch = async (): Promise<Response> => new Response(JSON.stringify({
      choices: [{
        finish_reason: "length",
        message: { content: '{"suggestions":[{"kind":"create-folder","targetFolderPath":"AI","confidence":0.9,"rationale":"Group links"}' },
      }],
    }), { status: 200 });
    const truncatedProvider = new OpenAICompatibleProvider({ baseUrl: "https://api.example.test/v1", apiKey: "", model: "example-model" }, truncatedFetch as typeof fetch);
    await expect(truncatedProvider.organize({ folders: [], bookmarks: [] })).rejects.toThrow("truncated before valid JSON");
  });

  it("builds a compact organizer request", () => {
    const repo = repository([folder("root", "Bookmarks"), folder("ai", "AI", "root"), bookmark("a", "Hugging Face", "https://huggingface.co", "ai")]);
    const request = buildOrganizerRequest(repo);
    expect(request.bookmarks[0]).toMatchObject({ id: "a", hostname: "huggingface.co", folderPath: "Bookmarks/AI" });
    expect(request.folders).toEqual(expect.arrayContaining(["Bookmarks", "Bookmarks/AI"]));
  });

  it("emits rule-based move suggestions without mutating the repository", () => {
    const repo = repository([folder("root", "Bookmarks"), bookmark("a", "GitHub", "https://github.com/openai", "root")]);
    const suggestions = runRuleEngine(repo, [{ id: "github", hostname: "github.com", targetFolderPath: "Development", rationale: "Code hosting belongs in Development." }]);
    expect(suggestions[0]).toMatchObject({ kind: "move", nodeId: "a", targetFolderPath: "Development", confidence: 1 });
    expect(repo.nodes.find((node) => node.id === "a")?.parentId).toBe("root");
  });

  it("provides an empty repository for first-run local storage", () => {
    expect(emptyRepository("device").nodes).toEqual([]);
  });

  it("reconstructs a canonical target through browser adapter operations", async () => {
    const current = canonicalizeBrowserTree([{
      browserId: "browser-root",
      type: "folder",
      title: "",
      parentBrowserId: null,
      index: 0,
      isRoot: true,
      rootKey: "browser-root",
      children: [{
        browserId: "bar",
        type: "folder",
        title: "Bookmarks bar",
        parentBrowserId: "browser-root",
        index: 0,
        rootKey: "bookmarks-bar",
        children: [{ browserId: "old-browser-id", type: "bookmark", title: "Old", url: "https://old.test", parentBrowserId: "bar", index: 0 }],
      }],
    }], { deviceId: "device", idFactory: () => "old-canonical" });
    const bar = current.repository.nodes.find((node) => node.rootKey === "bookmarks-bar");
    if (!bar) throw new Error("bar root missing");
    const target: BookmarkRepository = {
      ...current.repository,
      nodes: [...current.repository.nodes, folder("tools", "Tools", bar.id, 1), bookmark("new", "New", "https://new.test", "tools", 0)],
    };
    const calls: string[] = [];
    const result = await applyRepositoryToBrowser({
      async getBrowserInfo() { return { id: "fake", name: "Fake" }; },
      async readTree() { return []; },
      async createFolder(input) { calls.push(`folder:${input.title}`); return { browserId: "tools-browser" }; },
      async createBookmark(input) { calls.push(`bookmark:${input.title}`); return { browserId: "new-browser" }; },
      async updateBookmark() {},
      async moveNode(inputId, input) { calls.push(`move:${inputId}:${input.parentBrowserId}`); },
      async removeNode() {},
    }, current, target);
    expect(calls.slice(0, 2)).toEqual(["folder:Tools", "bookmark:New"]);
    expect(result.mapping.entries.find((entry) => entry.canonicalId === "new")?.browserBookmarkId).toBe("new-browser");
  });

  it("materializes an accepted local folder change even when the sync plan already contains it", async () => {
    const current = canonicalizeBrowserTree([{
      browserId: "browser-root",
      type: "folder",
      title: "",
      parentBrowserId: null,
      index: 0,
      isRoot: true,
      rootKey: "browser-root",
      children: [{
        browserId: "bar",
        type: "folder",
        title: "Bookmarks bar",
        parentBrowserId: "browser-root",
        index: 0,
        rootKey: "bookmarks-bar",
      }],
    }], { deviceId: "device", idFactory: () => "generated-id" });
    const bar = current.repository.nodes.find((node) => node.rootKey === "bookmarks-bar");
    if (!bar) throw new Error("bar root missing");

    const target: BookmarkRepository = {
      ...current.repository,
      nodes: [...current.repository.nodes, folder("tools", "AI Tools", bar.id, 0)],
    };
    const plan = calculateSyncPlan({
      mode: "two-way",
      base: current.repository,
      local: target,
      remote: current.repository,
    });

    // The suggestion is already in the projected local repository, so the
    // normal localChanges list is empty. The browser still differs from the
    // merged target and must receive the folder creation.
    expect(plan.localChanges).toEqual([]);
    expect(diffRepositories(current.repository, plan.target).map((change) => change.kind)).toContain("create");

    const createdFolders: string[] = [];
    await applyRepositoryToBrowser({
      async getBrowserInfo() { return { id: "fake", name: "Fake" }; },
      async readTree() { return []; },
      async createFolder(input) { createdFolders.push(input.title); return { browserId: "tools-browser" }; },
      async createBookmark() { return { browserId: "bookmark-browser" }; },
      async updateBookmark() {},
      async moveNode() {},
      async removeNode() {},
    }, current, plan.target);
    expect(createdFolders).toEqual(["AI Tools"]);
  });
});

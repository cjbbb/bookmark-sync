import { describe, expect, it } from "vitest";
import { WebDAVStorageAdapter } from "./webdav.js";
import type { BookmarkRepository } from "@bookmark-sync/core";

function repository(revision: number, title: string): BookmarkRepository {
  return {
    schemaVersion: 1,
    revision,
    updatedAt: "2026-08-29T00:00:00.000Z",
    updatedBy: "test-device",
    nodes: [
      { id: "root", type: "folder", title: "Bookmarks", parentId: null, order: 0 },
      { id: "bookmark", type: "bookmark", title, url: "https://example.com", parentId: "root", order: 0 },
    ],
  };
}

describe("WebDAVStorageAdapter", () => {
  it("pulls null when remote file returns 404", async () => {
    const mockFetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toBe("https://dav.example.com/bookmarks.json");
      return new Response(null, { status: 404 });
    };

    const adapter = new WebDAVStorageAdapter(
      { url: "https://dav.example.com/", filePath: "bookmarks.json" },
      mockFetch as unknown as typeof fetch,
    );

    const result = await adapter.pull();
    expect(result).toBeNull();
  });

  it("pulls repository successfully with ETag", async () => {
    const repo = repository(1, "Test Bookmark");
    const mockFetch = async () => {
      return new Response(JSON.stringify(repo), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          etag: '"etag-12345"',
        },
      });
    };

    const adapter = new WebDAVStorageAdapter(
      { url: "https://dav.example.com/dav/", filePath: "bookmarks.json" },
      mockFetch as unknown as typeof fetch,
    );

    const result = await adapter.pull();
    expect(result).not.toBeNull();
    expect(result?.repository.revision).toBe(1);
    expect(result?.etag).toBe('"etag-12345"');
  });

  it("pushes repository with basic auth and records history", async () => {
    const memoryFiles = new Map<string, string>();
    const recordedHeaders: Record<string, string>[] = [];

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      recordedHeaders.push(headers);

      if (method === "GET") {
        if (memoryFiles.has(url)) {
          return new Response(memoryFiles.get(url), { status: 200 });
        }
        return new Response(null, { status: 404 });
      }

      if (method === "PUT") {
        memoryFiles.set(url, String(init?.body ?? ""));
        return new Response(null, { status: 201 });
      }

      if (method === "MKCOL") {
        return new Response(null, { status: 201 });
      }

      return new Response(null, { status: 200 });
    };

    const adapter = new WebDAVStorageAdapter(
      {
        url: "https://dav.example.com/bookmarks/",
        username: "testuser",
        password: "secretpassword",
        filePath: "sync.json",
      },
      mockFetch as unknown as typeof fetch,
    );

    // Initial push
    const pushResult1 = await adapter.push(repository(1, "First Title"), { message: "First push" });
    expect(pushResult1.revision).toBe(1);
    expect(pushResult1.id).toBeDefined();

    // Verify basic auth was sent
    const authHeader = recordedHeaders.find((h) => h["Authorization"]);
    expect(authHeader?.["Authorization"]).toBe(`Basic ${btoa("testuser:secretpassword")}`);

    // Verify file content in memory
    const savedFile = memoryFiles.get("https://dav.example.com/bookmarks/sync.json");
    expect(savedFile).toBeDefined();
    const parsed = JSON.parse(savedFile!) as BookmarkRepository;
    expect(parsed.nodes[1].title).toBe("First Title");

    // Second push (should increment revision to 2)
    const pushResult2 = await adapter.push(repository(1, "Updated Title"), { message: "Second push" });
    expect(pushResult2.revision).toBe(2);

    // Check history
    const history = await adapter.getHistory();
    expect(history.length).toBe(2);
    expect(history[0].revision).toBe(2);

    // Restore first version
    await adapter.restoreVersion(history[1].id);
    const restored = await adapter.pull();
    expect(restored?.repository.revision).toBe(3);
    expect(restored?.repository.nodes[1].title).toBe("First Title");
  });

  it("handles parent directory creation on 404/409", async () => {
    let mkcolCalled = false;
    let mainFilePutAttempts = 0;
    const targetFile = "https://dav.example.com/dav/subfolder/nested/bookmarks.json";

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (method === "GET") {
        return new Response(null, { status: 404 });
      }

      if (method === "MKCOL") {
        mkcolCalled = true;
        return new Response(null, { status: 201 });
      }

      if (method === "PUT") {
        if (url === targetFile) {
          mainFilePutAttempts++;
          if (mainFilePutAttempts === 1) {
            // First attempt returns 409 because directory is missing
            return new Response(null, { status: 409, statusText: "Conflict" });
          }
        }
        return new Response(null, { status: 201 });
      }

      return new Response(null, { status: 200 });
    };

    const adapter = new WebDAVStorageAdapter(
      {
        url: "https://dav.example.com/dav/",
        filePath: "subfolder/nested/bookmarks.json",
      },
      mockFetch as unknown as typeof fetch,
    );

    const result = await adapter.push(repository(1, "Nested"));
    expect(result.revision).toBe(1);
    expect(mkcolCalled).toBe(true);
    expect(mainFilePutAttempts).toBe(2);
  });

  it("tests connection successfully", async () => {
    const mockFetch = async () => new Response(null, { status: 200 });
    const adapter = new WebDAVStorageAdapter(
      { url: "https://dav.example.com/dav/" },
      mockFetch as unknown as typeof fetch,
    );

    await expect(adapter.testConnection()).resolves.toBeUndefined();
  });

  it("reports authentication error on test connection", async () => {
    const mockFetch = async () => new Response(null, { status: 401, statusText: "Unauthorized" });
    const adapter = new WebDAVStorageAdapter(
      { url: "https://dav.example.com/dav/", username: "bad", password: "bad" },
      mockFetch as unknown as typeof fetch,
    );

    await expect(adapter.testConnection()).rejects.toThrow(/Authentication failed/i);
  });

  it("limits WebDAV history to 10 entries and deletes pruned remote snapshot files", async () => {
    const memoryFiles = new Map<string, string>();
    const deletedUrls: string[] = [];

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (method === "GET") {
        if (memoryFiles.has(url)) {
          return new Response(memoryFiles.get(url), { status: 200 });
        }
        return new Response(null, { status: 404 });
      }

      if (method === "PUT") {
        memoryFiles.set(url, String(init?.body ?? ""));
        return new Response(null, { status: 201 });
      }

      if (method === "DELETE") {
        deletedUrls.push(url);
        memoryFiles.delete(url);
        return new Response(null, { status: 204 });
      }

      if (method === "MKCOL") {
        return new Response(null, { status: 201 });
      }

      return new Response(null, { status: 200 });
    };

    const adapter = new WebDAVStorageAdapter(
      {
        url: "https://dav.example.com/bookmarks/",
        filePath: "sync.json",
      },
      mockFetch as unknown as typeof fetch,
    );

    const snapshotIds: string[] = [];
    for (let i = 1; i <= 13; i++) {
      const res = await adapter.push(repository(i, `Title ${i}`), { message: `Revision ${i}` });
      if (res.id) snapshotIds.push(res.id);
    }

    const history = await adapter.getHistory();
    expect(history.length).toBe(10);
    expect(history[0].revision).toBe(13);
    expect(history[9].revision).toBe(4);

    // Revisions 1, 2, 3 should have been deleted via HTTP DELETE
    expect(deletedUrls.length).toBe(3);
    expect(deletedUrls[0]).toContain(snapshotIds[0]); // first snapshot
    expect(deletedUrls[1]).toContain(snapshotIds[1]); // second snapshot
    expect(deletedUrls[2]).toContain(snapshotIds[2]); // third snapshot
  });
});

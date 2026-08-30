import { describe, expect, it } from "vitest";
import { LocalStorageAdapter, MemoryKeyValueStore } from "./local.js";
import { deserializeRepository, serializeRepository } from "./github.js";
import type { BookmarkRepository } from "@bookmark-sync/core";

function repository(revision: number, title: string): BookmarkRepository {
  return {
    schemaVersion: 1,
    revision,
    updatedAt: "2026-08-29T00:00:00.000Z",
    updatedBy: "test-device",
    nodes: [{ id: "root", type: "folder", title: "Bookmarks", parentId: null, order: 0 }, { id: "bookmark", type: "bookmark", title, url: "https://example.com", parentId: "root", order: 0 }],
  };
}

describe("local storage adapter", () => {
  it("keeps history and restores by creating a new snapshot", async () => {
    const adapter = new LocalStorageAdapter(new MemoryKeyValueStore(), "test-storage");
    await adapter.push(repository(1, "First"), { message: "First snapshot" });
    const second = await adapter.push(repository(2, "Second"), { message: "Second snapshot" });
    const history = await adapter.getHistory();
    expect(history).toHaveLength(2);
    await adapter.restoreVersion(history[1]?.id ?? second.id);
    const current = await adapter.pull();
    expect(current?.repository.nodes.find((node) => node.id === "bookmark")?.title).toBe("First");
    expect((await adapter.getHistory()).length).toBe(3);

    const info = await adapter.getStorageInfo();
    expect(info.hasRepository).toBe(true);
    expect(info.historyCount).toBe(3);
    expect(info.revision).toBe(3);
    expect(info.sizeBytes).toBeGreaterThan(0);

    await adapter.clear();
    const afterClear = await adapter.pull();
    expect(afterClear).toBeNull();
    const infoAfterClear = await adapter.getStorageInfo();
    expect(infoAfterClear.hasRepository).toBe(false);
    expect(infoAfterClear.historyCount).toBe(0);
  });

  it("limits history to at most 10 entries and prunes old versions", async () => {
    const adapter = new LocalStorageAdapter(new MemoryKeyValueStore(), "test-storage-limit");
    let firstSnapshotId = "";
    for (let i = 1; i <= 15; i++) {
      const res = await adapter.push(repository(i, `Title ${i}`), { message: `Snapshot ${i}` });
      if (i === 1) firstSnapshotId = res.id ?? "";
    }

    const history = await adapter.getHistory();
    expect(history).toHaveLength(10);
    expect(history[0].revision).toBe(15);
    expect(history[9].revision).toBe(6);

    const info = await adapter.getStorageInfo();
    expect(info.historyCount).toBe(10);

    // Oldest version (1) should be pruned
    await expect(adapter.getVersion(firstSnapshotId)).rejects.toThrow(/not found/);

    // Newest version should still exist
    const newestVersion = await adapter.getVersion(history[0].id);
    expect(newestVersion.revision).toBe(15);
  });
});

describe("GitHub serialization", () => {
  it("round-trips canonical JSON without changing the model", () => {
    const value = repository(7, "Serialized");
    expect(deserializeRepository(serializeRepository(value))).toEqual(value);
  });
});

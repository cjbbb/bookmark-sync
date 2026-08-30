import { describe, expect, it } from "vitest";
import { ChromiumBrowserAdapter, type ChromiumBookmarksApi } from "./chromium.js";

describe("Chromium browser adapter", () => {
  it("normalizes Chrome and Edge trees behind the same adapter contract", async () => {
    const api: ChromiumBookmarksApi = {
      async getTree() {
        return [{ id: "0", title: "", index: 0, children: [{ id: "10", title: "Favorites bar", parentId: "0", index: 0, children: [{ id: "20", title: "OpenAI", url: "https://openai.com", parentId: "10", index: 0 }] }] }];
      },
      async create() { return { id: "new" }; },
      async update() {},
      async move() {},
      async removeTree() {},
    };
    const adapter = new ChromiumBrowserAdapter(api, { userAgent: "Edg/130.0" } as Navigator);
    const tree = await adapter.readTree();
    expect((await adapter.getBrowserInfo()).id).toBe("edge");
    expect(tree[0]?.isRoot).toBe(true);
    expect(tree[0]?.children?.[0]?.rootKey).toBe("bookmarks-bar");
    expect(tree[0]?.children?.[0]?.children?.[0]?.url).toBe("https://openai.com");
  });
});

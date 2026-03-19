/**
 * BookmarkManager - handles browser bookmark CRUD operations
 * and converts between browser bookmark format and our custom format.
 */

export class BookmarkManager {
  /**
   * Get all browser bookmarks as a flat list.
   * @returns {Promise<Array>} Flat array of bookmark objects
   */
  static async getAllBookmarks() {
    const tree = await chrome.bookmarks.getTree();
    const flat = [];
    this._flatten(tree, flat, '');
    return flat;
  }

  /**
   * Flatten the bookmark tree recursively.
   * @param {Array} nodes
   * @param {Array} result
   * @param {string} parentPath
   */
  static _flatten(nodes, result, parentPath) {
    for (const node of nodes) {
      if (node.url) {
        result.push({
          id: node.id,
          title: node.title || '',
          url: node.url,
          category: parentPath,
          dateAdded: node.dateAdded
            ? new Date(node.dateAdded).toISOString()
            : new Date().toISOString(),
        });
      }
      if (node.children) {
        const currentPath = parentPath
          ? `${parentPath}/${node.title}`
          : node.title || '';
        this._flatten(node.children, result, currentPath);
      }
    }
  }

  /**
   * Get the bookmark tree (folder structure).
   * @returns {Promise<Array>} Bookmark tree
   */
  static async getTree() {
    return chrome.bookmarks.getTree();
  }

  /**
   * Create a bookmark in the browser.
   * @param {Object} params - { parentId, title, url }
   * @returns {Promise<Object>} Created bookmark node
   */
  static async create({ parentId, title, url }) {
    return chrome.bookmarks.create({ parentId, title, url });
  }

  /**
   * Move a bookmark to a different folder.
   * @param {string} id - Bookmark ID
   * @param {string} parentId - Target folder ID
   * @returns {Promise<Object>}
   */
  static async move(id, parentId) {
    return chrome.bookmarks.move(id, { parentId });
  }

  /**
   * Update bookmark title or url.
   * @param {string} id
   * @param {Object} changes - { title?, url? }
   * @returns {Promise<Object>}
   */
  static async update(id, changes) {
    return chrome.bookmarks.update(id, changes);
  }

  /**
   * Remove a bookmark.
   * @param {string} id
   * @returns {Promise<void>}
   */
  static async remove(id) {
    return chrome.bookmarks.remove(id);
  }

  /**
   * Search bookmarks by query.
   * @param {string} query
   * @returns {Promise<Array>}
   */
  static async search(query) {
    return chrome.bookmarks.search(query);
  }

  /**
   * Find or create a folder path like "技术/前端".
   * Returns the final folder node ID.
   * @param {string} path - e.g. "技术/前端"
   * @param {string} rootId - root folder ID (default "1" = Bookmarks Bar)
   * @returns {Promise<string>} Folder ID
   */
  static async ensureFolderPath(path, rootId = '1') {
    const parts = path.split('/').filter(Boolean);
    let currentParentId = rootId;

    for (const folderName of parts) {
      const children = await chrome.bookmarks.getChildren(currentParentId);
      const existing = children.find(
        (c) => !c.url && c.title === folderName
      );
      if (existing) {
        currentParentId = existing.id;
      } else {
        const created = await chrome.bookmarks.create({
          parentId: currentParentId,
          title: folderName,
        });
        currentParentId = created.id;
      }
    }

    return currentParentId;
  }

  /**
   * Export bookmarks to our custom JSON format.
   * @returns {Promise<Object>} The bookmark data object for sync
   */
  static async exportToSyncFormat() {
    const bookmarks = await this.getAllBookmarks();
    const categories = this._extractCategories(bookmarks);
    return {
      version: '1.0',
      lastSync: new Date().toISOString(),
      bookmarks: bookmarks.map((b) => ({
        id: b.id,
        title: b.title,
        url: b.url,
        category: b.category,
        tags: [],
        createdAt: b.dateAdded,
        updatedAt: new Date().toISOString(),
      })),
      categories,
    };
  }

  /**
   * Extract category tree from bookmarks.
   * @param {Array} bookmarks
   * @returns {Array}
   */
  static _extractCategories(bookmarks) {
    const catMap = new Map();
    for (const b of bookmarks) {
      if (!b.category) continue;
      const parts = b.category.split('/').filter(Boolean);
      if (parts.length === 0) continue;
      const root = parts[0];
      if (!catMap.has(root)) {
        catMap.set(root, new Set());
      }
      for (let i = 1; i < parts.length; i++) {
        catMap.get(root).add(parts[i]);
      }
    }
    return Array.from(catMap.entries()).map(([name, childrenSet]) => ({
      name,
      children: Array.from(childrenSet),
    }));
  }

  /**
   * Import bookmarks from sync format into browser.
   * This is a merge operation — it won't duplicate existing bookmarks.
   * @param {Object} syncData - The sync format data
   * @param {Object} options - { mode: 'merge' | 'overwrite' }
   * @returns {Promise<{added: number, skipped: number, moved?: number, updated?: number, removed?: number}>}
   */
  static async importFromSyncFormat(syncData, options = {}) {
    const mode = options.mode || 'merge';
    if (mode === 'overwrite') {
      return this._restoreFromSyncFormat(syncData);
    }

    const existing = await this.getAllBookmarks();
    const existingUrls = new Set(existing.map((b) => b.url));

    let added = 0;
    let skipped = 0;

    for (const bookmark of syncData.bookmarks) {
      if (existingUrls.has(bookmark.url)) {
        skipped++;
        continue;
      }

      let parentId = '1'; // default to Bookmarks Bar
      if (bookmark.category) {
        // Remove root folder names like "Bookmarks Bar" from path
        const cleanPath = bookmark.category
          .replace(/^书签栏\/?/, '')
          .replace(/^Bookmarks Bar\/?/, '')
          .replace(/^Other Bookmarks\/?/, '')
          .replace(/^其他书签\/?/, '');
        if (cleanPath) {
          parentId = await this.ensureFolderPath(cleanPath);
        }
      }

      await this.create({
        parentId,
        title: bookmark.title,
        url: bookmark.url,
      });
      added++;
    }

    return { added, skipped };
  }

  /**
   * Restore bookmarks from sync data with overwrite strategy.
   * Existing bookmarks not found in the snapshot will be removed.
   * @param {Object} syncData
   * @returns {Promise<{added: number, skipped: number, moved: number, updated: number, removed: number}>}
   */
  static async _restoreFromSyncFormat(syncData) {
    const snapshot = Array.isArray(syncData?.bookmarks)
      ? syncData.bookmarks.filter((b) => b && b.url)
      : [];

    const existing = await this.getAllBookmarks();
    const existingByUrl = new Map();

    for (const item of existing) {
      if (!existingByUrl.has(item.url)) {
        existingByUrl.set(item.url, []);
      }
      existingByUrl.get(item.url).push(item);
    }

    let added = 0;
    let moved = 0;
    let updated = 0;
    let removed = 0;

    for (const target of snapshot) {
      const sameUrlList = existingByUrl.get(target.url) || [];
      const matched = sameUrlList.shift();

      const { rootId, cleanPath } = this._normalizeCategoryPath(target.category);
      const parentId = cleanPath
        ? await this.ensureFolderPath(cleanPath, rootId)
        : rootId;

      if (matched) {
        if (matched.category !== target.category) {
          await this.move(matched.id, parentId);
          moved++;
        }
        if ((matched.title || '') !== (target.title || '')) {
          await this.update(matched.id, { title: target.title || '' });
          updated++;
        }
      } else {
        await this.create({
          parentId,
          title: target.title || '',
          url: target.url,
        });
        added++;
      }
    }

    for (const leftovers of existingByUrl.values()) {
      for (const item of leftovers) {
        await this.remove(item.id);
        removed++;
      }
    }

    return {
      added,
      skipped: 0,
      moved,
      updated,
      removed,
    };
  }

  /**
   * Normalize category path and detect target root folder.
   * @param {string} category
   * @returns {{rootId: string, cleanPath: string}}
   */
  static _normalizeCategoryPath(category) {
    const raw = (category || '').trim();
    const rootMappings = [
      { prefix: '书签栏', rootId: '1' },
      { prefix: 'Bookmarks Bar', rootId: '1' },
      { prefix: '其他书签', rootId: '2' },
      { prefix: 'Other Bookmarks', rootId: '2' },
      { prefix: '移动设备书签', rootId: '3' },
      { prefix: 'Mobile Bookmarks', rootId: '3' },
    ];

    for (const { prefix, rootId } of rootMappings) {
      if (raw === prefix || raw.startsWith(`${prefix}/`)) {
        return {
          rootId,
          cleanPath: raw.replace(new RegExp(`^${prefix}/?`), ''),
        };
      }
    }

    return { rootId: '1', cleanPath: raw };
  }
}

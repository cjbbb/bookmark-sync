/**
 * Background Service Worker
 * Handles bookmark events and message routing between popup/options and lib modules.
 */

import { BookmarkManager } from '../lib/bookmark-manager.js';
import { SyncEngine } from '../lib/sync/sync-engine.js';
import { AIEngine } from '../lib/ai/ai-engine.js';

// Listen for messages from popup and options pages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));
  return true; // keep the channel open for async response
});

/**
 * Route and handle messages.
 * @param {Object} message - { action, payload }
 * @returns {Promise<Object>}
 */
async function handleMessage(message) {
  const { action, payload } = message;

  switch (action) {
    // ── Bookmark operations ──
    case 'getBookmarks':
      return BookmarkManager.getAllBookmarks();

    case 'getBookmarkTree':
      return BookmarkManager.getTree();

    case 'searchBookmarks':
      return BookmarkManager.search(payload.query);

    case 'exportBookmarks':
      return BookmarkManager.exportToSyncFormat();

    case 'importBookmarks':
      return BookmarkManager.importFromSyncFormat(payload);

    case 'moveBookmark':
      return BookmarkManager.move(payload.id, payload.parentId);

    case 'ensureFolder':
      return BookmarkManager.ensureFolderPath(payload.path, payload.rootId);

    // ── Sync operations ──
    case 'syncUpload': {
      const data = await BookmarkManager.exportToSyncFormat();
      return SyncEngine.upload(data);
    }

    case 'syncDownload': {
      const syncData = await SyncEngine.download();
      return BookmarkManager.importFromSyncFormat(syncData, {
        mode: 'overwrite',
      });
    }

    case 'testSync':
      return SyncEngine.testConnection();

    case 'getSyncVersions':
      return SyncEngine.getVersions(payload?.limit || 20);

    case 'restoreSyncVersion': {
      const syncData = await SyncEngine.downloadVersion(payload.versionId);
      return BookmarkManager.importFromSyncFormat(syncData, {
        mode: 'overwrite',
      });
    }

    case 'getSyncConfig':

      return SyncEngine.getConfig();

    case 'saveSyncConfig':
      return SyncEngine.saveConfig(payload);

    // ── AI operations ──
    case 'aiClassify': {
      const bookmarks = await BookmarkManager.getAllBookmarks();
      const exportData = await BookmarkManager.exportToSyncFormat();
      const categories = exportData.categories.map((c) => c.name);
      return AIEngine.classifyBookmarks(bookmarks, categories);
    }

    case 'aiApplySuggestion': {
      // Apply a single approved suggestion
      const { bookmarkId, suggestedCategory } = payload;
      const folderId = await BookmarkManager.ensureFolderPath(suggestedCategory);
      await BookmarkManager.move(bookmarkId, folderId);
      return { success: true };
    }

    case 'testAI':
      return AIEngine.testConnection();

    case 'getAIConfig':
      return AIEngine.getConfig();

    case 'saveAIConfig':
      return AIEngine.saveConfig(payload);

    default:
      throw new Error(`未知操作: ${action}`);
  }
}

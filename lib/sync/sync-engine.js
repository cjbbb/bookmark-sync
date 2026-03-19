/**
 * SyncEngine - Unified interface for bookmark synchronization.
 * Supports GitLab and GitHub as sync backends.
 */

import { GitLabSync } from './gitlab-sync.js';
import { GitHubSync } from './github-sync.js';

export class SyncEngine {
  /**
   * Create a sync provider based on stored settings.
   * @returns {Promise<GitLabSync|GitHubSync>}
   */
  static async getProvider() {
    const config = await this.getConfig();
    if (!config || !config.platform) {
      throw new Error('同步未配置。请先在设置页面配置同步信息。');
    }

    if (config.platform === 'gitlab') {
      return new GitLabSync({
        baseUrl: config.gitlabUrl || 'https://gitlab.com',
        token: config.token,
        projectId: config.projectId,
        filePath: config.filePath || 'bookmarks.json',
        branch: config.branch || 'main',
      });
    } else if (config.platform === 'github') {
      return new GitHubSync({
        token: config.token,
        owner: config.owner,
        repo: config.repo,
        filePath: config.filePath || 'bookmarks.json',
        branch: config.branch || 'main',
      });
    }

    throw new Error(`不支持的同步平台: ${config.platform}`);
  }

  /**
   * Get sync configuration from chrome storage.
   * @returns {Promise<Object|null>}
   */
  static async getConfig() {
    const result = await chrome.storage.local.get('syncConfig');
    return result.syncConfig || null;
  }

  /**
   * Save sync configuration.
   * @param {Object} config
   */
  static async saveConfig(config) {
    await chrome.storage.local.set({ syncConfig: config });
  }

  /**
   * Upload bookmarks to remote.
   * @param {Object} bookmarkData - The sync format data
   * @returns {Promise<Object>} Result from provider
   */
  static async upload(bookmarkData) {
    const provider = await this.getProvider();
    return provider.upload(bookmarkData);
  }

  /**
   * Download bookmarks from remote.
   * @returns {Promise<Object>} The sync format data
   */
  static async download() {
    const provider = await this.getProvider();
    return provider.download();
  }

  /**
   * Test the connection to the remote.
   * @returns {Promise<{success: boolean, message: string, code?: number}>}
   */
  static async testConnection() {
    try {
      const provider = await this.getProvider();
      return provider.testConnection();
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Get remote version history for bookmark sync file.
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  static async getVersions(limit = 20) {
    const provider = await this.getProvider();
    if (typeof provider.getVersions !== 'function') {
      throw new Error('当前同步平台不支持版本历史');
    }
    return provider.getVersions(limit);
  }

  /**
   * Download bookmark data for a specific version.
   * @param {string} versionId
   * @returns {Promise<Object>}
   */
  static async downloadVersion(versionId) {
    const provider = await this.getProvider();
    if (typeof provider.downloadVersion !== 'function') {
      throw new Error('当前同步平台不支持版本恢复');
    }
    return provider.downloadVersion(versionId);
  }
}



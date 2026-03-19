/**
 * AIEngine - Unified interface for AI-powered bookmark classification.
 * Supports DeepSeek and MiniMax providers.
 */

import { DeepSeekProvider } from './deepseek-provider.js';
import { MiniMaxProvider } from './minimax-provider.js';

export class AIEngine {
  /**
   * Create an AI provider based on stored settings.
   * @returns {Promise<DeepSeekProvider|MiniMaxProvider>}
   */
  static async getProvider() {
    const config = await this.getConfig();
    if (!config || !config.provider) {
      throw new Error('AI 未配置。请先在设置页面配置 AI API 信息。');
    }

    if (config.provider === 'deepseek') {
      return new DeepSeekProvider({
        apiKey: config.apiKey,
        model: config.model || 'deepseek-chat',
      });
    } else if (config.provider === 'minimax') {
      return new MiniMaxProvider({
        apiKey: config.apiKey,
        groupId: config.groupId || '',
        model: config.model || 'MiniMax-Text-01',
      });
    }

    throw new Error(`不支持的 AI 提供商: ${config.provider}`);
  }

  /**
   * Get AI configuration from chrome storage.
   * @returns {Promise<Object|null>}
   */
  static async getConfig() {
    const result = await chrome.storage.local.get('aiConfig');
    return result.aiConfig || null;
  }

  /**
   * Save AI configuration.
   * @param {Object} config
   */
  static async saveConfig(config) {
    await chrome.storage.local.set({ aiConfig: config });
  }

  /**
   * Classify bookmarks using the configured AI provider.
   * Returns suggestions that need user confirmation.
   * @param {Array} bookmarks - Array of bookmark objects
   * @param {Array} existingCategories - Existing category names
   * @returns {Promise<Array>} Array of classification suggestions
   */
  static async classifyBookmarks(bookmarks, existingCategories = []) {
    const provider = await this.getProvider();
    return provider.classifyBookmarks(bookmarks, existingCategories);
  }

  /**
   * Test the AI connection.
   * @returns {Promise<{success: boolean, message: string}>}
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
   * Parse a natural-language category operation instruction.
   * @param {string} instruction
   * @param {Array<string>} categoryCandidates
   * @returns {Promise<{operations: Array, explanation: string}>}
   */
  static async parseCategoryRule(instruction, categoryCandidates = []) {
    const provider = await this.getProvider();
    if (typeof provider.parseCategoryRule !== 'function') {
      throw new Error('当前 AI 提供商不支持规则解析');
    }
    return provider.parseCategoryRule(instruction, categoryCandidates);
  }
}

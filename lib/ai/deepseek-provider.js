/**
 * DeepSeekProvider - AI classification using DeepSeek API.
 * Accessible in China without VPN.
 * API docs: https://platform.deepseek.com/api-docs
 */

export class DeepSeekProvider {
  /**
   * @param {Object} options
   * @param {string} options.apiKey - DeepSeek API Key
   * @param {string} options.model - Model name (default: deepseek-chat)
   */
  constructor({ apiKey, model }) {
    this.apiKey = apiKey;
    this.model = model || 'deepseek-chat';
    this.baseUrl = 'https://api.deepseek.com';
  }

  /**
   * Send a chat completion request to DeepSeek.
   * @param {Array} messages - Chat messages
   * @returns {Promise<string>} Assistant response content
   */
  async _chat(messages) {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`DeepSeek API 错误 (${response.status}): ${err}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  /**
   * Classify bookmarks into categories.
   * @param {Array} bookmarks - Array of bookmark objects { id, title, url, category }
   * @param {Array} existingCategories - Existing category names for reference
   * @returns {Promise<Array>} Classification suggestions
   */
  async classifyBookmarks(bookmarks, existingCategories = []) {
    // Process in batches to avoid token limits
    const BATCH_SIZE = 30;
    const allSuggestions = [];

    for (let i = 0; i < bookmarks.length; i += BATCH_SIZE) {
      const batch = bookmarks.slice(i, i + BATCH_SIZE);
      const suggestions = await this._classifyBatch(
        batch,
        existingCategories
      );
      allSuggestions.push(...suggestions);
    }

    return allSuggestions;
  }

  /**
   * Classify a batch of bookmarks.
   * @param {Array} batch
   * @param {Array} existingCategories
   * @returns {Promise<Array>}
   */
  async _classifyBatch(batch, existingCategories) {
    const bookmarkList = batch
      .map(
        (b, i) =>
          `${i + 1}. [ID: ${b.id}] 标题: "${b.title}" | URL: ${b.url} | 当前分类: ${b.category || '无'}`
      )
      .join('\n');

    const categoryHint =
      existingCategories.length > 0
        ? `\n现有分类供参考（你也可以建议新的分类）:\n${existingCategories.join(', ')}`
        : '';

    const systemPrompt = `你是一个智能书签分类助手。你的任务是分析用户的书签，并为每个书签建议合适的分类。

规则：
1. 分类应使用层级结构，用"/"分隔，例如"技术/前端"、"工具/设计"
2. 分类名称使用中文
3. 尽量将相关书签归入同一分类
4. 如果书签已经有合适的分类，保持不变
5. 最多3层分类深度

你必须以 JSON 格式返回，格式如下：
{
  "suggestions": [
    {
      "bookmarkId": "书签ID",
      "title": "书签标题",
      "currentCategory": "当前分类",
      "suggestedCategory": "建议分类",
      "reason": "分类理由（简短）"
    }
  ]
}`;

    const userPrompt = `请为以下书签建议分类：\n\n${bookmarkList}${categoryHint}`;

    const content = await this._chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    try {
      const parsed = JSON.parse(content);
      return parsed.suggestions || [];
    } catch {
      throw new Error('AI 返回的数据格式无效，请重试。');
    }
  }

  /**
   * Test the connection to DeepSeek API.
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async testConnection() {
    try {
      const content = await this._chat([
        {
          role: 'user',
          content: '请回复JSON: {"status": "ok", "message": "连接成功"}',
        },
      ]);
      const parsed = JSON.parse(content);
      return {
        success: true,
        message: `DeepSeek 连接成功！模型: ${this.model}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `DeepSeek 连接失败: ${error.message}`,
      };
    }
  }
}

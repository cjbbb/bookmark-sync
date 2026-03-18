/**
 * MiniMaxProvider - AI classification using MiniMax API.
 * Accessible in China without VPN.
 * API docs: https://platform.minimaxi.com/document
 */

export class MiniMaxProvider {
  /**
   * @param {Object} options
   * @param {string} options.apiKey - MiniMax API Key
   * @param {string} options.groupId - MiniMax Group ID
   * @param {string} options.model - Model name (default: MiniMax-Text-01)
   */
  constructor({ apiKey, groupId, model }) {
    this.apiKey = apiKey;
    this.groupId = groupId;
    this.model = model || 'MiniMax-Text-01';
    this.baseUrl = 'https://api.minimax.chat/v1';
  }

  /**
   * Send a chat completion request to MiniMax.
   * @param {Array} messages - Chat messages
   * @returns {Promise<string>} Assistant response content
   */
  async _chat(messages) {
    const response = await fetch(`${this.baseUrl}/text/chatcompletion_v2`, {
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
      throw new Error(`MiniMax API 错误 (${response.status}): ${err}`);
    }

    const data = await response.json();

    if (data.base_resp && data.base_resp.status_code !== 0) {
      throw new Error(
        `MiniMax API 业务错误: ${data.base_resp.status_msg}`
      );
    }

    return data.choices[0].message.content;
  }

  /**
   * Classify bookmarks into categories.
   * @param {Array} bookmarks - Array of bookmark objects { id, title, url, category }
   * @param {Array} existingCategories - Existing category names for reference
   * @returns {Promise<Array>} Classification suggestions
   */
  async classifyBookmarks(bookmarks, existingCategories = []) {
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
   * Test the connection to MiniMax API.
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
      JSON.parse(content);
      return {
        success: true,
        message: `MiniMax 连接成功！模型: ${this.model}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `MiniMax 连接失败: ${error.message}`,
      };
    }
  }
}

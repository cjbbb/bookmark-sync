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

    const categoryNames = Array.isArray(existingCategories) ? existingCategories : (existingCategories.names || []);
    const allPaths = Array.isArray(existingCategories) ? [] : (existingCategories._allPaths || []);

    const categoryHint =
      categoryNames.length > 0
        ? `\n现有分类供参考（你也可以建议新的分类）:\n${categoryNames.join(', ')}`
        : '';

    const allFoldersHint = allPaths.length > 0
      ? `\n用户已有的完整文件夹路径示例（请遵循类似命名风格，如：成人内容→"好看的"）：\n${allPaths.slice(0, 30).join('\n')}`
      : '';

    const systemPrompt = `你是一个智能书签分类助手。你的任务是分析用户的书签，并为每个书签建议合适的分类。

规则：
1. 绝大部分书签只用【一级分类名称】（如"效率工具"、"学习"、"搜索引擎"）。不要分类太细（如避免"学习/英语考试/CELPIP"这种），直接用"英语考试"或"学习"即可。
2. 特殊情况允许【两级分类】：比如成人色情网站，可以使用"成人网站/具体网站名"（如"成人网站/MissAV"）。
3. 分类名称必须简短并使用中文。
4. 尽量将相关书签归入同一分类类别或一级分类之下。
5. 如果书签已经有合适的分类，请基于规则进行精简或保持。
6. **重要**：请仔细学习用户已有的文件夹命名风格和分类标准，尽量沿用用户的习惯来命名新分类。例如用户把成人电影放到"好看的"文件夹，则成人网站也应使用类似风格。

你必须以 JSON 格式返回，格式如下：
{
  "suggestions": [
    {
      "bookmarkId": "书签ID",
      "title": "书签标题",
      "currentCategory": "当前分类",
      "suggestedCategory": "建议分类"
    }
  ]
}`;

    const userPrompt = `请为以下书签建议分类：\n\n${bookmarkList}${categoryHint}${allFoldersHint}`;

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

  /**
   * Interpret natural language category operation instructions.
   * @param {string} instruction
   * @param {Array<string>} categoryCandidates
   * @returns {Promise<{operations: Array, explanation: string}>}
   */
  async parseCategoryRule(instruction, categoryCandidates = []) {
    const categories = Array.isArray(categoryCandidates)
      ? categoryCandidates.filter(Boolean).slice(0, 120)
      : [];

    const systemPrompt = `你是一个中文书签分类规则解析器。请把用户自然语言规则解析为结构化操作。

仅返回 JSON，格式如下：
{
  "operations": [
    {
      "type": "merge|rename|move|move_all_except",
      "sources": ["源分类1", "源分类2"],
      "source": "单源分类（rename/move可用）",
      "excludes": ["要排除的分类"],
      "target": "目标分类"
    }
  ],
  "explanation": "对解析结果的简短中文说明"
}

规则：
1. 用户表达“合并”“并入”“归到”“都为”时，优先解析为 merge 或 move。
2. 用户表达“改为”“重命名”时，解析为 rename。
3. 如果一句话提到多个源分类合并到一个目标，返回 type=merge 且 sources 至少2个。
4. 如果出现“除X外都并入Y/归到Y”，返回 type=move_all_except，excludes=[X], target=Y。
5. 用户可能一句话包含多个动作（例如“把A和B合并为C，再把D并入C”），请按顺序返回多个 operations。
6. 同义表达视为同义动作，例如“都为/归为/统归到/统一到”可按 merge 或 move 处理。
7. 分类名请尽量保留用户原意，不要杜撰。
8. 无法解析时返回 operations: []，并在 explanation 说明原因。`;

    const userPrompt = `用户指令：${instruction}\n\n候选分类（可为空）：\n${categories.join('\n')}`;

    const content = await this._chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('AI 规则解析返回格式无效');
    }

    return {
      operations: Array.isArray(parsed.operations) ? parsed.operations : [],
      explanation: parsed.explanation || '已由 AI 解析规则',
    };
  }
}

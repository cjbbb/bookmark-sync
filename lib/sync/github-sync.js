/**
 * GitHubSync - Sync bookmarks via GitHub REST API.
 * Requires network access to github.com / api.github.com.
 */

export class GitHubSync {
  /**
   * @param {Object} options
   * @param {string} options.token - Personal Access Token (classic or fine-grained)
   * @param {string} options.owner - Repository owner (user or org)
   * @param {string} options.repo - Repository name
   * @param {string} options.filePath - File path in repo (default: bookmarks.json)
   * @param {string} options.branch - Branch name (default: main)
   */
  constructor({ token, owner, repo, filePath, branch }) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.filePath = filePath;
    this.branch = branch;
    this.baseUrl = 'https://api.github.com';
  }

  /**
   * Make an authenticated request to GitHub API.
   * @param {string} url
   * @param {Object} options - fetch options
   * @returns {Promise<Response>}
   */
  async _fetch(url, options = {}) {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    };
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `GitHub API 错误 (${response.status}): ${errorBody}`
      );
    }
    return response;
  }

  /**
   * Upload bookmark data to GitHub repository.
   * Creates the file if it doesn't exist, updates it otherwise.
   * @param {Object} bookmarkData
   * @returns {Promise<Object>}
   */
  async upload(bookmarkData) {
    const content = JSON.stringify(bookmarkData, null, 2);
    // GitHub API requires base64 encoded content
    const encoded = btoa(unescape(encodeURIComponent(content)));

    const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/contents/${this.filePath}`;

    // Check if file exists to get its sha (needed for update)
    let sha = null;
    try {
      const checkResponse = await this._fetch(
        `${url}?ref=${this.branch}`
      );
      const existing = await checkResponse.json();
      sha = existing.sha;
    } catch {
      // File doesn't exist, will create
    }

    const body = {
      message: `📚 Sync bookmarks - ${new Date().toLocaleString('zh-CN')}`,
      content: encoded,
      branch: this.branch,
    };

    if (sha) {
      body.sha = sha;
    }

    const response = await this._fetch(url, {
      method: 'PUT',
      body: JSON.stringify(body),
    });

    return response.json();
  }

  /**
   * Download bookmark data from GitHub repository.
   * @returns {Promise<Object>} The bookmark sync data
   */
  async download() {
    const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/contents/${this.filePath}?ref=${this.branch}`;
    const response = await this._fetch(url);
    const data = await response.json();

    // GitHub returns file content as base64
    const decoded = atob(data.content.replace(/\n/g, ''));
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) {
      bytes[i] = decoded.charCodeAt(i);
    }
    const text = new TextDecoder('utf-8').decode(bytes);
    return JSON.parse(text);
  }

  /**
   * Test the connection to GitHub repository.
   * @returns {Promise<{success: boolean, message: string, code?: number}>}
   */
  async testConnection() {
    const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}`;
    try {
      const response = await this._fetch(url);
      const repo = await response.json();
      return {
        success: true,
        message: `连接成功！仓库: ${repo.full_name}`,
      };
    } catch (error) {
      // 通过 response 状态码切入
      if (error.message && error.message.includes('404')) {
        return {
          success: false,
          code: 404,
          message: `仓库未找到 (404)，插件可以使用您的 Token 自动创建。`,
        };
      }
      return {
        success: false,
        message: `连接失败: ${error.message}`,
      };
    }
  }

  /**
   * 🚀 一键创建并初始化 GitHub 仓库
   */
  async createRepository() {
    const url = `${this.baseUrl}/user/repos`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `token ${this.token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify({
          name: this.repo,
          private: true,
          auto_init: true, // 初始 main 分支
          description: '智能书签同步备份'
        })
      });

      if (res.status === 201) return { success: true, message: '仓库创建并初始化成功' };
      const err = await res.json();
      return { success: false, message: err.message || '创建失败' };
    } catch (err) {
      return { success: false, message: `创建错误: ${err.message}` };
    }
  }
}


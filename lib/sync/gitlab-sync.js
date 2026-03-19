/**
 * GitLabSync - Sync bookmarks via GitLab REST API.
 * Supports gitlab.com and self-hosted instances.
 * Works in China without VPN.
 */

export class GitLabSync {
  /**
   * @param {Object} options
   * @param {string} options.baseUrl - GitLab instance URL (default: https://gitlab.com)
   * @param {string} options.token - Personal Access Token
   * @param {string} options.projectId - Project ID (numeric) or URL-encoded path
   * @param {string} options.filePath - File path in repo (default: bookmarks.json)
   * @param {string} options.branch - Branch name (default: main)
   */
  constructor({ baseUrl, token, projectId, filePath, branch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.projectId = encodeURIComponent(projectId);
    this.filePath = filePath;
    this.branch = branch;
  }

  /**
   * Build API URL for a specific endpoint.
   * @param {string} endpoint
   * @returns {string}
   */
  _apiUrl(endpoint) {
    return `${this.baseUrl}/api/v4/projects/${this.projectId}${endpoint}`;
  }

  /**
   * Make an authenticated request to GitLab API.
   * @param {string} url
   * @param {Object} options - fetch options
   * @returns {Promise<Response>}
   */
  async _fetch(url, options = {}) {
    const headers = {
      'PRIVATE-TOKEN': this.token,
      'Content-Type': 'application/json',
      ...options.headers,
    };
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `GitLab API 错误 (${response.status}): ${errorBody}`
      );
    }
    return response;
  }

  /**
   * Upload bookmark data to GitLab repository.
   * Creates the file if it doesn't exist, updates it otherwise.
   * @param {Object} bookmarkData
   * @returns {Promise<Object>}
   */
  async upload(bookmarkData) {
    const content = JSON.stringify(bookmarkData, null, 2);
    const encodedPath = encodeURIComponent(this.filePath);

    // Check if file exists to decide between create and update
    let fileExists = false;
    try {
      const checkUrl = this._apiUrl(
        `/repository/files/${encodedPath}?ref=${this.branch}`
      );
      await this._fetch(checkUrl);
      fileExists = true;
    } catch {
      fileExists = false;
    }

    const url = this._apiUrl(`/repository/files/${encodedPath}`);
    const body = {
      branch: this.branch,
      content: content,
      commit_message: `📚 Sync bookmarks - ${new Date().toLocaleString('zh-CN')}`,
    };

    const method = fileExists ? 'PUT' : 'POST';
    const response = await this._fetch(url, {
      method,
      body: JSON.stringify(body),
    });

    return response.json();
  }

  /**
   * Download bookmark data from GitLab repository.
   * @param {string} ref - branch name or commit sha
   * @returns {Promise<Object>} The bookmark sync data
   */
  async download(ref = this.branch) {
    const encodedPath = encodeURIComponent(this.filePath);
    const url = this._apiUrl(
      `/repository/files/${encodedPath}?ref=${encodeURIComponent(ref)}`
    );
    const response = await this._fetch(url);
    const data = await response.json();

    // GitLab returns file content as base64
    const decoded = atob(data.content);
    // Handle UTF-8 properly
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) {
      bytes[i] = decoded.charCodeAt(i);
    }
    const text = new TextDecoder('utf-8').decode(bytes);
    return JSON.parse(text);
  }

  /**
   * Get version history for bookmark file.
   * @param {number} limit
   * @returns {Promise<Array<{id: string, shortId: string, message: string, author: string, date: string}>>}
   */
  async getVersions(limit = 20) {
    const url = this._apiUrl(
      `/repository/commits?ref_name=${encodeURIComponent(this.branch)}&path=${encodeURIComponent(this.filePath)}&per_page=${limit}`
    );
    const response = await this._fetch(url);
    const commits = await response.json();

    return commits.map((commit) => ({
      id: commit.id,
      shortId: commit.short_id || commit.id?.slice(0, 7) || '',
      message: commit.title || '无提交信息',
      author: commit.author_name || '未知作者',
      date: commit.committed_date || '',
    }));
  }

  /**
   * Download bookmark data from a historical version.
   * @param {string} versionId - commit sha
   * @returns {Promise<Object>}
   */
  async downloadVersion(versionId) {
    if (!versionId) {
      throw new Error('缺少版本 ID');
    }
    return this.download(versionId);
  }

  /**
   * Test the connection to GitLab.
   * @returns {Promise<{success: boolean, message: string, code?: number}>}
   */
  async testConnection() {
    try {
      const url = this._apiUrl('');
      const response = await this._fetch(url);
      const project = await response.json();
      return {
        success: true,
        message: `连接成功！项目: ${project.name_with_namespace}`,
      };
    } catch (error) {
      if (error.message && error.message.includes('404')) {
        return {
          success: false,
          code: 404,
          message: `项目未找到 (404)。请先在 GitLab 手动创建项目后重试。`,
        };
      }
      return {
        success: false,
        message: `连接失败: ${error.message}`,
      };
    }
  }
}


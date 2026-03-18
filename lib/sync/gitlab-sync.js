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
   * @returns {Promise<Object>} The bookmark sync data
   */
  async download() {
    const encodedPath = encodeURIComponent(this.filePath);
    const url = this._apiUrl(
      `/repository/files/${encodedPath}?ref=${this.branch}`
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
          message: `项目未找到 (404)，插件可以使用您的 Token 自动为您创建该项目。`,
        };
      }
      return {
        success: false,
        message: `连接失败: ${error.message}`,
      };
    }
  }

  /**
   * 🚀 一键创建并初始化 GitLab 项目
   */
  async createRepository() {
    // 处理仓库名，如果是 命名空间/仓库名，提取最后的仓库名
    const name = this.repo.includes('/') ? this.repo.split('/').pop() : this.repo;
    const url = `${this.gitlabUrl}/api/v4/projects`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'PRIVATE-TOKEN': this.token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: name,
          path: name,
          visibility: 'private',
          initialize_with_readme: true // 创建后即初始化默认分支
        })
      });

      if (res.status === 201) return { success: true, message: 'GitLab 仓库创建及初始化成功' };
      const err = await res.json();
      return { success: false, message: err.message || '创建失败' };
    } catch (err) {
      return { success: false, message: `创建错误: ${err.message}` };
    }
  }
}


import { BookmarkManager } from '../lib/bookmark-manager.js';
import { AIEngine } from '../lib/ai/ai-engine.js';

const META_KEY = 'optionsConsoleMeta';

function $(sel) {
  return document.querySelector(sel);
}

function $$(sel) {
  return Array.from(document.querySelectorAll(sel));
}

const state = {
  bookmarks: [],
  bookmarkTree: [],
  syncVersions: [],
  aiSuggestions: [],
  groupedSuggestions: {},
  currentSuggestionGroup: null,
  healthResults: [],
  duplicateGroups: [],
  navGroup: 'assets',
  meta: defaultMeta(),
};

function defaultMeta() {
  return {
    sync: {
      lastTestAt: '',
      lastTestSuccess: false,
      lastTestMessage: '',
      lastSyncAt: '',
      lastSyncDirection: '',
      lastRemoteVersionAt: '',
      remoteBookmarkCount: 0,
      lastTarget: '',
    },
    ai: {
      lastTestAt: '',
      lastTestSuccess: false,
      lastTestMessage: '',
      lastAnalysisAt: '',
      lastAnalysisCount: 0,
    },
    health: {
      lastRunAt: '',
      ok: 0,
      failed: 0,
      timeout: 0,
      redirect: 0,
    },
    duplicate: {
      lastRunAt: '',
      groups: 0,
      items: 0,
    },
  };
}

async function sendMessage(action, payload = {}) {
  return chrome.runtime.sendMessage({ action, payload });
}

async function loadMeta() {
  const result = await chrome.storage.local.get(META_KEY);
  state.meta = {
    ...defaultMeta(),
    ...(result[META_KEY] || {}),
    sync: { ...defaultMeta().sync, ...(result[META_KEY]?.sync || {}) },
    ai: { ...defaultMeta().ai, ...(result[META_KEY]?.ai || {}) },
    health: { ...defaultMeta().health, ...(result[META_KEY]?.health || {}) },
    duplicate: { ...defaultMeta().duplicate, ...(result[META_KEY]?.duplicate || {}) },
  };
}

async function saveMeta() {
  await chrome.storage.local.set({ [META_KEY]: state.meta });
}

async function patchMeta(partial) {
  state.meta = {
    ...state.meta,
    ...partial,
    sync: partial.sync ? { ...state.meta.sync, ...partial.sync } : state.meta.sync,
    ai: partial.ai ? { ...state.meta.ai, ...partial.ai } : state.meta.ai,
    health: partial.health ? { ...state.meta.health, ...partial.health } : state.meta.health,
    duplicate: partial.duplicate ? { ...state.meta.duplicate, ...partial.duplicate } : state.meta.duplicate,
  };
  await saveMeta();
}

function showToast(text, type = 'info', duration = 2600) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.className = `toast show ${type}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

function showResult(id, text, type = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `result-box ${type}`.trim();
  el.classList.remove('hidden');
}

function clearResult(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = '';
  el.className = 'result-box hidden';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str || '');
  return div.innerHTML;
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN');
}

function compactNumber(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-';
  return value.toLocaleString('zh-CN');
}

function compactPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '0%';
  return `${Math.round(value)}%`;
}

function formatPlatform(platform) {
  if (platform === 'github') return 'GitHub';
  if (platform === 'gitlab') return 'GitLab';
  return '未配置';
}

function formatAIProvider(provider) {
  if (provider === 'deepseek') return 'DeepSeek';
  if (provider === 'minimax') return 'MiniMax';
  return '未配置';
}

function setBadge(el, variant, text) {
  if (!el) return;
  el.className = `status-badge ${variant}`;
  el.textContent = text;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function setConnectionPillState(selector, status) {
  const element = $(selector);
  if (!element) return;
  element.classList.remove('is-ready', 'is-pending');
  if (status === 'ready') {
    element.classList.add('is-ready');
  } else if (status === 'pending') {
    element.classList.add('is-pending');
  }
}

function initTheme() {
  let theme = localStorage.getItem('theme');
  if (!theme) {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.body.classList.toggle('light-mode', theme === 'light');
  $('#btn-theme-toggle .theme-icon').textContent = theme === 'light' ? '☀︎' : '☾';
}

function initThemeEvents() {
  $('#btn-theme-toggle').addEventListener('click', () => {
    const current = localStorage.getItem('theme') || (document.body.classList.contains('light-mode') ? 'light' : 'dark');
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', next);
    initTheme();
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    if (!localStorage.getItem('theme')) {
      document.body.classList.toggle('light-mode', !event.matches);
      $('#btn-theme-toggle .theme-icon').textContent = event.matches ? '☾' : '☀︎';
    }
  });
}

function initNavigation() {
  $$('[data-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = document.getElementById(button.dataset.target);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    const matchedButton = $$('.console-nav-link').find((button) => button.dataset.target === visible.target.id);
    if (matchedButton?.dataset.navGroup && matchedButton.dataset.navGroup !== state.navGroup) {
      applyNavigationGroup({ group: matchedButton.dataset.navGroup, shouldScroll: false });
    }
    $$('.console-nav-link').forEach((button) => {
      button.classList.toggle('active', button.dataset.target === visible.target.id);
    });
  }, { threshold: [0.2, 0.45, 0.7] });

  $$('[data-section]').forEach((section) => observer.observe(section));
}

function applyNavigationGroup({ group, shouldScroll = false } = {}) {
  if (group) state.navGroup = group;

  $$('.sidebar-manage-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.navGroup === state.navGroup);
  });

  const links = $$('.console-nav-link');
  links.forEach((button) => {
    const hidden = button.dataset.navGroup !== state.navGroup;
    button.classList.toggle('is-hidden', hidden);
  });

  if (shouldScroll) {
    const firstVisible = links.find((button) => button.dataset.navGroup === state.navGroup);
    document.getElementById(firstVisible?.dataset.target || '')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function initManagementTabs() {
  $$('.sidebar-manage-tab').forEach((button) => {
    button.addEventListener('click', () => {
      applyNavigationGroup({ group: button.dataset.navGroup, shouldScroll: true });
    });
  });
  applyNavigationGroup({ group: state.navGroup, shouldScroll: false });
}

function initSections() {
  $$('.section-toggle').forEach((toggle) => {
    const section = toggle.closest('.console-section');
    toggle.addEventListener('click', () => {
      const collapsed = section.classList.toggle('collapsed');
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  });
}

function initVisibilityToggles() {
  $$('[data-toggle-visibility]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = document.getElementById(button.dataset.toggleVisibility);
      if (!target) return;
      const visible = target.type === 'text';
      target.type = visible ? 'password' : 'text';
      button.textContent = visible ? '显示' : '隐藏';
    });
  });
}

function modalConfirm({ title, text, confirmText = '确认执行', danger = true }) {
  return new Promise((resolve) => {
    const modal = $('#confirm-modal');
    $('#confirm-modal-title').textContent = title;
    $('#confirm-modal-text').textContent = text;
    const confirmButton = $('#btn-confirm-modal');
    confirmButton.textContent = confirmText;
    confirmButton.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    modal.classList.remove('hidden');

    const cleanup = () => {
      modal.classList.add('hidden');
      confirmButton.removeEventListener('click', onConfirm);
      $('#btn-cancel-modal').removeEventListener('click', onCancel);
      $('#btn-close-modal').removeEventListener('click', onCancel);
      modal.querySelector('[data-close-modal]').removeEventListener('click', onCancel);
    };

    const onConfirm = () => {
      cleanup();
      resolve(true);
    };

    const onCancel = () => {
      cleanup();
      resolve(false);
    };

    confirmButton.addEventListener('click', onConfirm);
    $('#btn-cancel-modal').addEventListener('click', onCancel);
    $('#btn-close-modal').addEventListener('click', onCancel);
    modal.querySelector('[data-close-modal]').addEventListener('click', onCancel);
  });
}

function collectSyncConfig() {
  const platform = document.querySelector('input[name="platform"]:checked')?.value;
  if (!platform) return null;

  const base = {
    platform,
    branch: $('#sync-branch').value.trim() || 'main',
    filePath: $('#sync-filepath').value.trim() || 'bookmarks.json',
  };

  if (platform === 'gitlab') {
    return {
      ...base,
      gitlabUrl: $('#gitlab-url').value.trim() || 'https://gitlab.com',
      token: $('#gitlab-token').value.trim(),
      projectId: $('#gitlab-project').value.trim(),
    };
  }

  return {
    ...base,
    token: $('#github-token').value.trim(),
    owner: $('#github-owner').value.trim(),
    repo: $('#github-repo').value.trim(),
  };
}

function collectAIConfig() {
  const provider = document.querySelector('input[name="ai-provider"]:checked')?.value;
  if (!provider) return null;

  if (provider === 'deepseek') {
    return {
      provider,
      apiKey: $('#deepseek-key').value.trim(),
      model: $('#deepseek-model').value,
    };
  }

  return {
    provider,
    apiKey: $('#minimax-key').value.trim(),
    groupId: $('#minimax-group').value.trim(),
    model: $('#minimax-model').value,
  };
}

async function persistCurrentAIConfig() {
  const config = collectAIConfig();
  if (!config?.apiKey) {
    throw new Error('请先选择 AI 提供商并填写 API Key');
  }
  await sendMessage('saveAIConfig', config);
  return config;
}

function onPlatformChange(selected) {
  $('#gitlab-fields').classList.toggle('hidden', selected !== 'gitlab');
  $('#github-fields').classList.toggle('hidden', selected !== 'github');
  $('#common-fields').classList.toggle('hidden', !selected);
  updateSyncStatusUI();
}

function onAIProviderChange(selected) {
  $('#deepseek-fields').classList.toggle('hidden', selected !== 'deepseek');
  $('#minimax-fields').classList.toggle('hidden', selected !== 'minimax');
  $('#ai-common-fields').classList.toggle('hidden', !selected);
  updateAIStatusUI();
}

function initRadioHandlers() {
  $$('input[name="platform"]').forEach((radio) => {
    radio.addEventListener('change', () => onPlatformChange(radio.value));
  });

  $$('input[name="ai-provider"]').forEach((radio) => {
    radio.addEventListener('change', () => onAIProviderChange(radio.value));
  });
}

function currentPendingActions() {
  const aiMove = state.aiSuggestions.filter((item) => item.status === 'accepted');
  const aiDelete = state.aiSuggestions.filter((item) => item.status === 'deleted');
  const healthDelete = state.healthResults.filter((item) => item.queuedForDeletion);
  const duplicateDelete = state.duplicateGroups.flatMap((group) => group.items.filter((item) => item.markedForDeletion));
  return { aiMove, aiDelete, healthDelete, duplicateDelete };
}

function setButtonState(selector, disabled) {
  const element = $(selector);
  if (element) element.disabled = disabled;
}

function updateSyncSummaryCard(syncConfig) {
  const platform = syncConfig?.platform ? formatPlatform(syncConfig.platform) : '未配置';
  const ready = Boolean(
    syncConfig?.token &&
    (syncConfig.platform === 'github' ? syncConfig.owner && syncConfig.repo : syncConfig.projectId)
  );
  const tested = Boolean(state.meta.sync.lastTestSuccess);

  $('#sync-summary-platform').textContent = ready ? `${platform} 连接已录入` : '未配置平台';
  $('#sync-summary-platform-name').textContent = platform;
  $('#sync-summary-target').textContent = syncConfig ? (extractSyncTarget(syncConfig) || '-') : '-';
  $('#sync-summary-branch').textContent = syncConfig?.branch || '-';
  $('#sync-summary-path').textContent = syncConfig?.filePath || '-';
  $('#sync-summary-tested-at').textContent = formatTime(state.meta.sync.lastTestAt);
  $('#sync-summary-last-sync').textContent = formatTime(state.meta.sync.lastSyncAt);
  $('#sync-summary-connection-text').textContent = !syncConfig
    ? '完成平台选择、填写连接字段并测试成功后，这里会显示可追踪的连接状态。'
    : tested
      ? `${platform} 已连接到 ${state.meta.sync.lastTarget || extractSyncTarget(syncConfig)}，可用于同步和版本追溯。`
      : ready
        ? '连接字段已录入，建议先执行一次测试连接，确认令牌和目标仓库可用。'
        : '当前信息尚未完整，仍需补全令牌或目标仓库 / 项目标识。';
  setBadge($('#sync-summary-badge'), tested ? 'success' : ready ? 'warning' : 'muted', tested ? '已验证' : ready ? '待验证' : '未配置');
}

function updateHeaderAndOverview(syncConfig = collectSyncConfig(), aiConfig = collectAIConfig()) {
  const pending = currentPendingActions();
  const problemCount = pending.aiMove.length + pending.aiDelete.length + pending.healthDelete.length + pending.duplicateDelete.length;

  const platform = syncConfig?.platform ? formatPlatform(syncConfig.platform) : '未配置';
  const aiProvider = aiConfig?.provider ? formatAIProvider(aiConfig.provider) : '未配置';
  const hasSyncReady = Boolean(syncConfig?.platform && syncConfig?.token && ((syncConfig.platform === 'github' && syncConfig.owner && syncConfig.repo) || (syncConfig.platform === 'gitlab' && syncConfig.projectId)));
  const hasAIReady = Boolean(aiConfig?.provider && aiConfig?.apiKey);
  const testedSync = Boolean(state.meta.sync.lastTestSuccess);
  const testedAI = Boolean(state.meta.ai.lastTestSuccess);

  $('#header-connection-status').textContent = hasSyncReady
    ? `${platform} ${testedSync ? '已连接' : '待验证'}`
    : '未配置';
  $('#header-last-sync').textContent = formatTime(state.meta.sync.lastSyncAt);
  $('#header-pending-count').textContent = `${compactNumber(problemCount)} 项`;

  $('#overview-platform').textContent = platform;
  $('#overview-platform-detail').textContent = hasSyncReady
    ? `${platform} 已准备就绪，当前目标 ${state.meta.sync.lastTarget || '等待首次测试'}.`
    : '请选择 GitHub 或 GitLab，并填写连接字段后保存。';

  $('#overview-ai-provider').textContent = aiProvider;
  $('#overview-ai-detail').textContent = hasAIReady
    ? `${aiProvider} ${testedAI ? '已测试成功' : '已配置待测试'}。`
    : '完成配置后即可用于分类建议与规则语义解析。';

  $('#overview-bookmark-count').textContent = compactNumber(state.bookmarks.length);
  $('#overview-bookmark-detail').textContent = state.bookmarks.length
    ? `当前已读取 ${state.bookmarks.length} 条本地书签。`
    : '当前未发现本地书签数据。';

  $('#overview-last-sync').textContent = formatTime(state.meta.sync.lastSyncAt);
  $('#overview-remote-detail').textContent = state.meta.sync.lastRemoteVersionAt
    ? `远端最新版本时间 ${formatTime(state.meta.sync.lastRemoteVersionAt)}。`
    : '远端快照信息会在同步或加载历史后更新。';

  const analysisTimes = [state.meta.ai.lastAnalysisAt, state.meta.health.lastRunAt, state.meta.duplicate.lastRunAt].filter(Boolean).sort().reverse();
  $('#overview-last-analysis').textContent = formatTime(analysisTimes[0] || '');
  $('#overview-analysis-detail').textContent = state.meta.ai.lastAnalysisAt
    ? `最近一次 AI 分析共生成 ${state.meta.ai.lastAnalysisCount || 0} 条建议。`
    : '尚未执行 AI 分析或书签治理扫描。';

  $('#overview-pending-issues').textContent = compactNumber(problemCount);
  $('#overview-pending-detail').textContent = `AI ${pending.aiMove.length + pending.aiDelete.length} 项，失效链接 ${pending.healthDelete.length} 项，重复清理 ${pending.duplicateDelete.length} 项。`;

  $('#sync-metric-local-count').textContent = compactNumber(state.bookmarks.length);
  $('#sync-metric-remote-count').textContent = state.meta.sync.remoteBookmarkCount ? compactNumber(state.meta.sync.remoteBookmarkCount) : '-';
  $('#sync-metric-last-sync').textContent = formatTime(state.meta.sync.lastSyncAt);
  $('#sync-metric-remote-version').textContent = formatTime(state.meta.sync.lastRemoteVersionAt);

  $('#ai-metric-pending').textContent = compactNumber(state.bookmarks.length);
  $('#ai-metric-provider').textContent = aiProvider;
  $('#ai-metric-last-analysis').textContent = formatTime(state.meta.ai.lastAnalysisAt);

  $('#health-metric-total').textContent = compactNumber(state.bookmarks.length);
  $('#health-metric-last-run').textContent = formatTime(state.meta.health.lastRunAt);
  $('#health-metric-summary').textContent = state.meta.health.lastRunAt
    ? `${state.meta.health.failed} 失效 / ${state.meta.health.timeout} 超时`
    : '未检测';

  $('#duplicate-metric-groups').textContent = compactNumber(state.meta.duplicate.groups || 0);
  $('#duplicate-metric-items').textContent = compactNumber(state.meta.duplicate.items || 0);
  $('#duplicate-metric-last-run').textContent = formatTime(state.meta.duplicate.lastRunAt);
  renderGovernanceOverview(problemCount, hasSyncReady, hasAIReady, testedSync, testedAI);
  updateSyncSummaryCard(syncConfig);
}

function updateSectionSummaries() {
  const syncConfig = collectSyncConfig();
  const aiConfig = collectAIConfig();

  $('#sync-section-summary').textContent = syncConfig?.platform
    ? `同步配置 - ${formatPlatform(syncConfig.platform)} ${state.meta.sync.lastTestSuccess ? '已连接' : '待验证'}`
    : '同步配置 - 未配置平台';
  $('#version-section-summary').textContent = state.syncVersions.length
    ? `版本控制 - 已加载 ${state.syncVersions.length} 条远端历史`
    : '版本控制 - 等待加载远端历史';
  $('#ai-section-summary').textContent = aiConfig?.provider
    ? `AI 分类配置 - ${formatAIProvider(aiConfig.provider)} ${state.meta.ai.lastTestSuccess ? '已就绪' : '待测试'}`
    : 'AI 分类配置 - 未配置提供商';
  $('#health-section-summary').textContent = state.meta.health.lastRunAt
    ? `书签体检 - 上次发现 ${state.meta.health.failed + state.meta.health.timeout + state.meta.health.redirect} 个问题`
    : '书签体检 - 尚未检测失效链接';
  $('#duplicate-section-summary').textContent = state.meta.duplicate.lastRunAt
    ? `重复清理 - 待处理 ${currentPendingActions().duplicateDelete.length} 条重复项`
    : '重复清理 - 尚未检测重复书签';

  $('#nav-sync-summary').textContent = syncConfig?.platform ? `${formatPlatform(syncConfig.platform)} ${state.meta.sync.lastTestSuccess ? '已连接' : '待验证'}` : '未配置';
  $('#nav-version-summary').textContent = state.syncVersions.length ? `${state.syncVersions.length} 条记录` : '等待加载';
  $('#nav-ai-summary').textContent = aiConfig?.provider ? `${formatAIProvider(aiConfig.provider)} ${state.meta.ai.lastTestSuccess ? '已就绪' : '待测试'}` : '未配置';
  $('#nav-health-summary').textContent = state.meta.health.lastRunAt ? `${state.meta.health.failed + state.meta.health.timeout + state.meta.health.redirect} 个问题` : '未检测';
  $('#nav-duplicate-summary').textContent = state.meta.duplicate.lastRunAt ? `${state.meta.duplicate.groups} 组重复` : '未检测';
}

function updateSyncStatusUI() {
  const config = collectSyncConfig();
  const badge = $('#sync-connection-badge');
  const title = $('#sync-platform-title');
  const statusBadge = $('#sync-platform-status-badge');
  const text = $('#sync-platform-status-text');

  if (!config) {
    setBadge(badge, 'muted', '未配置');
    title.textContent = '未选择同步平台';
    setBadge(statusBadge, 'muted', '等待配置');
    text.textContent = '请选择 GitHub 或 GitLab，然后填写 Token、Owner / Repo 或项目标识。';
    updateHeaderAndOverview();
    updateSectionSummaries();
    return;
  }

  const ready = Boolean(
    config.token &&
    (config.platform === 'github' ? config.owner && config.repo : config.projectId)
  );
  setBadge(badge, ready ? (state.meta.sync.lastTestSuccess ? 'success' : 'warning') : 'muted', ready ? '已填写' : '未完成');
  title.textContent = `${formatPlatform(config.platform)} 连接信息`;
  setBadge(statusBadge, state.meta.sync.lastTestSuccess ? 'success' : ready ? 'warning' : 'muted', state.meta.sync.lastTestSuccess ? '已连接' : ready ? '待测试' : '未配置');
  text.textContent = state.meta.sync.lastTestMessage
    ? `${state.meta.sync.lastTestMessage} 最后验证时间：${formatTime(state.meta.sync.lastTestAt)}。`
    : config.platform === 'github'
      ? '填写 Owner / Repo、Token 与分支后即可测试连接。'
      : '填写 GitLab 地址、项目标识和 Token 后即可测试连接。';
  updateHeaderAndOverview(config);
  updateSectionSummaries();
}

function updateAIStatusUI() {
  const config = collectAIConfig();
  const ready = Boolean(config?.apiKey);
  const classifyButton = $('#btn-ai-classify');
  classifyButton.disabled = !ready;
  const readyBadge = $('#ai-ready-badge');

  if (!config) {
    setBadge(readyBadge, 'muted', '未就绪');
    $('#ai-status-title').textContent = '尚未配置 AI 提供商';
    $('#ai-status-text').textContent = '完成配置并测试成功后，这里会提示 AI 服务已可用于建议分类与规则语义解析。';
    $('#ai-status-provider').textContent = '-';
    $('#ai-status-tested-at').textContent = '-';
    $('#ai-status-analyzed-at').textContent = formatTime(state.meta.ai.lastAnalysisAt);
    setBadge($('#ai-status-source'), 'muted', '等待配置');
    updateHeaderAndOverview(undefined, config);
    updateSectionSummaries();
    renderRulePreview();
    return;
  }

  setBadge(readyBadge, state.meta.ai.lastTestSuccess ? 'success' : 'warning', state.meta.ai.lastTestSuccess ? '已就绪' : '待测试');
  $('#ai-status-title').textContent = `${formatAIProvider(config.provider)} ${state.meta.ai.lastTestSuccess ? '已可用' : '已配置待验证'}`;
  $('#ai-status-text').textContent = state.meta.ai.lastTestSuccess
    ? 'AI 服务已可用，可用于建议分类与规则语义解析。'
    : '建议先测试连接，确认 API 可用后再开始分析。';
  $('#ai-status-provider').textContent = formatAIProvider(config.provider);
  $('#ai-status-tested-at').textContent = formatTime(state.meta.ai.lastTestAt);
  $('#ai-status-analyzed-at').textContent = formatTime(state.meta.ai.lastAnalysisAt);
  setBadge($('#ai-status-source'), state.meta.ai.lastTestSuccess ? 'success' : 'warning', state.meta.ai.lastTestSuccess ? '测试通过' : '尚未验证');
  updateHeaderAndOverview(undefined, config);
  updateSectionSummaries();
  renderRulePreview();
}

function setProgress(prefix, percent, stage, text, indeterminate = false) {
  const fill = document.getElementById(`${prefix}-progress-bar`);
  const stageEl = document.getElementById(`${prefix}-progress-stage`);
  const textEl = document.getElementById(`${prefix}-progress-text`);
  if (!fill || !stageEl || !textEl) return;
  stageEl.textContent = stage;
  textEl.textContent = text;
  if (indeterminate) {
    fill.classList.add('indeterminate');
  } else {
    fill.classList.remove('indeterminate');
    fill.style.width = `${percent}%`;
  }
}

function countBookmarksInNode(node) {
  if (!node) return 0;
  if (node.url) return 1;
  return (node.children || []).reduce((sum, child) => sum + countBookmarksInNode(child), 0);
}

function flattenTreePreview(nodes, depth = 0, bucket = [], limit = 16) {
  for (const node of nodes || []) {
    if (bucket.length >= limit) return bucket;
    const isFolder = !node.url;
    const title = node.title || (depth === 0 ? '根目录' : '未命名');

    if (isFolder) {
      const count = countBookmarksInNode(node);
      if (count || depth === 0) {
        bucket.push({ type: 'folder', title, depth, count });
      }
      flattenTreePreview(node.children || [], depth + 1, bucket, limit);
    } else {
      bucket.push({ type: 'bookmark', title: node.title || node.url || '未命名书签', depth, url: node.url });
    }

    if (bucket.length >= limit) return bucket;
  }
  return bucket;
}

function renderSidebarBookmarkTree() {
  const container = $('#sidebar-bookmark-tree');
  const badge = $('#sidebar-bookmark-count');
  if (!container || !badge) return;

  badge.textContent = `${compactNumber(state.bookmarks.length)} 条`;

  const roots = state.bookmarkTree[0]?.children || [];
  const previewNodes = flattenTreePreview(roots, 0, [], 16)
    .filter((item) => item.title && item.title !== 'root________')
    .slice(0, 14);

  if (!previewNodes.length) {
    container.innerHTML = '<div class="sidebar-tree-empty">未发现可展示的书签层级。</div>';
    return;
  }

  container.innerHTML = previewNodes.map((item) => `
    <div class="sidebar-bookmark-node" style="--depth:${Math.min(item.depth, 4)}">
      <span class="sidebar-bookmark-node-icon" aria-hidden="true">${item.type === 'folder'
        ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg>'
        : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10H7z" /><path d="M9 12h6" /></svg>'}</span>
      <span class="sidebar-bookmark-node-label">${escapeHtml(item.title)}</span>
      <span class="sidebar-bookmark-node-meta">${item.type === 'folder' ? `${compactNumber(item.count)} 条` : '链接'}</span>
    </div>
  `).join('');
}

function renderGovernanceOverview(problemCount, hasSyncReady, hasAIReady, testedSync, testedAI) {
  const donut = $('#governance-donut');
  if (!donut) return;

  const total = state.bookmarks.length;
  const unhealthyRaw = state.meta.health.failed + state.meta.health.timeout + state.meta.health.redirect;
  const duplicateRaw = state.meta.duplicate.items || 0;
  const hasHealthScan = Boolean(state.meta.health.lastRunAt);
  const hasDuplicateScan = Boolean(state.meta.duplicate.lastRunAt);

  let unhealthy = hasHealthScan ? Math.min(total, unhealthyRaw) : 0;
  let duplicate = hasDuplicateScan ? Math.min(Math.max(total - unhealthy, 0), duplicateRaw) : 0;
  let healthy = hasHealthScan ? Math.max(total - unhealthy - duplicate, 0) : 0;
  let unknown = Math.max(total - unhealthy - duplicate - healthy, 0);

  if (!hasHealthScan && !hasDuplicateScan) {
    unknown = total || 1;
  }

  const safeTotal = total || unhealthy || duplicate || healthy || unknown || 1;
  const healthyPct = (healthy / safeTotal) * 100;
  const unhealthyPct = (unhealthy / safeTotal) * 100;
  const duplicatePct = (duplicate / safeTotal) * 100;
  const unknownPct = Math.max(0, 100 - healthyPct - unhealthyPct - duplicatePct);

  const healthyDeg = healthyPct * 3.6;
  const unhealthyDeg = unhealthyPct * 3.6;
  const duplicateDeg = duplicatePct * 3.6;

  donut.style.background = `conic-gradient(
    var(--accent-green) 0deg ${healthyDeg}deg,
    var(--accent-red) ${healthyDeg}deg ${healthyDeg + unhealthyDeg}deg,
    var(--accent-amber) ${healthyDeg + unhealthyDeg}deg ${healthyDeg + unhealthyDeg + duplicateDeg}deg,
    rgba(124, 135, 152, 0.28) ${healthyDeg + unhealthyDeg + duplicateDeg}deg 360deg
  )`;

  $('#overview-healthy-ratio').textContent = compactPercent(healthyPct);
  $('#overview-unhealthy-ratio').textContent = compactPercent(unhealthyPct);
  $('#overview-duplicate-ratio').textContent = compactPercent(duplicatePct);
  $('#overview-unknown-ratio').textContent = compactPercent(unknownPct);
  $('#overview-distribution-title').textContent = total
    ? problemCount
      ? `${compactNumber(problemCount)} 项待处理`
      : '治理状态良好'
    : '等待读取';

  $('#header-connection-status-mirror').textContent = $('#header-connection-status')?.textContent || '未配置';
  setConnectionPillState('#overview-sync-pill', hasSyncReady ? (testedSync ? 'ready' : 'pending') : '');
  setConnectionPillState('#overview-ai-pill', hasAIReady ? (testedAI ? 'ready' : 'pending') : '');
}

async function refreshBookmarks() {
  const [bookmarks, bookmarkTree] = await Promise.all([
    BookmarkManager.getAllBookmarks(),
    BookmarkManager.getTree(),
  ]);
  state.bookmarks = bookmarks;
  state.bookmarkTree = bookmarkTree;
  renderSidebarBookmarkTree();
  updateHeaderAndOverview();
  updateSectionSummaries();
}

async function fillConfigsFromStorage() {
  const syncConfig = await sendMessage('getSyncConfig');
  if (syncConfig?.platform) {
    const radio = document.querySelector(`input[name="platform"][value="${syncConfig.platform}"]`);
    if (radio) {
      radio.checked = true;
      onPlatformChange(syncConfig.platform);
    }
    $('#sync-branch').value = syncConfig.branch || 'main';
    $('#sync-filepath').value = syncConfig.filePath || 'bookmarks.json';
    if (syncConfig.platform === 'gitlab') {
      $('#gitlab-url').value = syncConfig.gitlabUrl || 'https://gitlab.com';
      $('#gitlab-project').value = syncConfig.projectId || '';
      $('#gitlab-token').value = syncConfig.token || '';
    } else {
      $('#github-owner').value = syncConfig.owner || '';
      $('#github-repo').value = syncConfig.repo || '';
      $('#github-token').value = syncConfig.token || '';
    }
  }

  const aiConfig = await sendMessage('getAIConfig');
  if (aiConfig?.provider) {
    const radio = document.querySelector(`input[name="ai-provider"][value="${aiConfig.provider}"]`);
    if (radio) {
      radio.checked = true;
      onAIProviderChange(aiConfig.provider);
    }
    if (aiConfig.provider === 'deepseek') {
      $('#deepseek-key').value = aiConfig.apiKey || '';
      $('#deepseek-model').value = aiConfig.model || 'deepseek-chat';
    } else {
      $('#minimax-key').value = aiConfig.apiKey || '';
      $('#minimax-group').value = aiConfig.groupId || '';
      $('#minimax-model').value = aiConfig.model || 'MiniMax-M2.1';
    }
  }
}

async function handleSyncTest() {
  const config = collectSyncConfig();
  if (!config) {
    showToast('请先选择平台并填写配置', 'error');
    return;
  }

  const button = $('#btn-test-sync');
  button.disabled = true;
  button.textContent = '测试中...';
  clearResult('sync-test-result');

  try {
    await sendMessage('saveSyncConfig', config);
    const result = await sendMessage('testSync');
    const success = Boolean(result?.success);
    const testMessage = success
      ? `${result.message} 验证时间：${formatTime(new Date().toISOString())}。`
      : result?.code === 404
        ? '远端仓库或项目未找到。请先在对应平台手动创建后再重新测试。'
        : (result?.message || '连接测试失败');
    showResult('sync-test-result', testMessage, success ? 'success' : 'error');
    await patchMeta({
      sync: {
        lastTestAt: new Date().toISOString(),
        lastTestSuccess: success,
        lastTestMessage: success
          ? `${formatPlatform(config.platform)} 已连接到 ${extractSyncTarget(config)}`
          : testMessage,
        lastTarget: extractSyncTarget(config),
      },
    });
    updateSyncStatusUI();
  } catch (error) {
    showResult('sync-test-result', `测试连接失败：${error.message}`, 'error');
    await patchMeta({
      sync: {
        lastTestAt: new Date().toISOString(),
        lastTestSuccess: false,
        lastTestMessage: error.message,
      },
    });
    updateSyncStatusUI();
  } finally {
    button.disabled = false;
    button.textContent = '测试连接';
  }
}

async function handleSyncSave() {
  const config = collectSyncConfig();
  if (!config) {
    showToast('请先选择平台并填写配置', 'error');
    return;
  }
  await sendMessage('saveSyncConfig', config);
  await patchMeta({ sync: { lastTarget: extractSyncTarget(config) } });
  updateSyncStatusUI();
  showToast('同步配置已保存', 'success');
}

function extractSyncTarget(config) {
  if (!config) return '';
  if (config.platform === 'github') return `${config.owner || '-'}/${config.repo || '-'}`;
  return `${config.gitlabUrl || 'https://gitlab.com'} / ${config.projectId || '-'}`;
}

async function handleSyncUpload() {
  const config = collectSyncConfig();
  if (!config) {
    showToast('请先完成同步配置', 'error');
    return;
  }
  const confirmed = await modalConfirm({
    title: '确认覆盖远端',
    text: `这会把当前本地浏览器书签完整写入远端 ${config.filePath || 'bookmarks.json'}，并覆盖远端已有内容。确认继续吗？`,
    confirmText: '上传并覆盖远端',
    danger: false,
  });
  if (!confirmed) return;

  const button = $('#btn-sync-upload-full');
  button.disabled = true;
  button.textContent = '上传中...';
  clearResult('sync-ops-result');

  try {
    await sendMessage('saveSyncConfig', config);
    const result = await sendMessage('syncUpload');
    if (result?.error) throw new Error(result.error);

    await patchMeta({
      sync: {
        lastSyncAt: new Date().toISOString(),
        lastSyncDirection: 'upload',
        lastRemoteVersionAt: new Date().toISOString(),
        remoteBookmarkCount: state.bookmarks.length,
        lastTarget: extractSyncTarget(config),
      },
    });
    showResult('sync-ops-result', `上传成功，远端已更新为 ${state.bookmarks.length} 条本地书签。`, 'success');
    updateHeaderAndOverview();
    updateSectionSummaries();
    showToast('远端快照已更新', 'success');
  } catch (error) {
    showResult('sync-ops-result', `上传失败：${error.message}`, 'error');
    showToast(`上传失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '全量上传覆盖远端';
  }
}

async function handleSyncDownload() {
  const config = collectSyncConfig();
  if (!config) {
    showToast('请先完成同步配置', 'error');
    return;
  }
  const confirmed = await modalConfirm({
    title: '确认覆盖本地',
    text: '这会使用远端 bookmarks.json 完整覆盖本地书签。当前本地未同步内容可能丢失，且远端不存在的本地书签会被删除。',
    confirmText: '下载并覆盖本地',
  });
  if (!confirmed) return;

  const button = $('#btn-sync-download-full');
  button.disabled = true;
  button.textContent = '下载中...';
  clearResult('sync-ops-result');

  try {
    await sendMessage('saveSyncConfig', config);
    const result = await sendMessage('syncDownload');
    if (result?.error) throw new Error(result.error);
    await refreshBookmarks();
    await patchMeta({
      sync: {
        lastSyncAt: new Date().toISOString(),
        lastSyncDirection: 'download',
        lastRemoteVersionAt: new Date().toISOString(),
        remoteBookmarkCount: state.bookmarks.length,
        lastTarget: extractSyncTarget(config),
      },
    });
    showResult('sync-ops-result', `下载完成：移动 ${result.moved || 0}，更新 ${result.updated || 0}，新增 ${result.added || 0}，删除 ${result.removed || 0}。`, 'success');
    updateHeaderAndOverview();
    updateSectionSummaries();
    showToast('本地书签已按远端回写', 'success');
  } catch (error) {
    showResult('sync-ops-result', `下载失败：${error.message}`, 'error');
    showToast(`下载失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '全量下载覆盖本地';
  }
}

function renderSyncVersions() {
  const box = $('#sync-versions-box');
  const list = $('#sync-versions-list');
  const count = $('#sync-versions-count');
  list.innerHTML = '';

  if (!state.syncVersions.length) {
    box.classList.remove('hidden');
    count.textContent = '0 条';
    list.innerHTML = `
      <div class="empty-state">
        <strong>暂无版本历史</strong>
        <p>请先执行一次上传，远端才会生成可回滚版本。</p>
      </div>
    `;
    updateSectionSummaries();
    return;
  }

  box.classList.remove('hidden');
  count.textContent = `${state.syncVersions.length} 条`;

  state.syncVersions.forEach((version, index) => {
    const item = document.createElement('article');
    item.className = 'timeline-item';
    item.innerHTML = `
      <div class="timeline-meta">
        <span class="timeline-id">${escapeHtml(version.shortId || (version.id || '').slice(0, 7))}</span>
        <span>${escapeHtml(formatTime(version.date))}</span>
        <span>${escapeHtml(version.author || '未知作者')}</span>
        ${index === 0 ? '<span class="status-badge info">Latest</span>' : ''}
      </div>
      <div class="timeline-message">${escapeHtml(version.message || '无提交信息')}</div>
      <div class="timeline-actions">
        <button class="btn timeline-restore-link btn-restore-version" data-version-id="${escapeHtml(version.id)}" type="button">恢复并替换本地</button>
        <span class="timeline-note">本地会以该版本为准重新回写。</span>
      </div>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('.btn-restore-version').forEach((button) => {
    button.addEventListener('click', async () => {
      const versionId = button.dataset.versionId;
      const ok = await modalConfirm({
        title: '确认恢复历史版本',
        text: '恢复后会用所选历史版本覆盖当前本地书签。当前本地未同步内容可能丢失，且不在该版本中的书签会被删除。',
        confirmText: '恢复到此版本',
      });
      if (!ok) return;

      const original = button.textContent;
      button.disabled = true;
      button.textContent = '恢复中...';
      try {
        const result = await sendMessage('restoreSyncVersion', { versionId });
        if (result?.error) throw new Error(result.error);
        await refreshBookmarks();
        const selectedVersion = state.syncVersions.find((item) => item.id === versionId);
        await patchMeta({
          sync: {
            lastSyncAt: new Date().toISOString(),
            lastSyncDirection: 'restore',
            lastRemoteVersionAt: selectedVersion?.date || new Date().toISOString(),
            remoteBookmarkCount: state.bookmarks.length,
          },
        });
        showResult('sync-ops-result', `恢复完成：移动 ${result.moved || 0}，更新 ${result.updated || 0}，新增 ${result.added || 0}，删除 ${result.removed || 0}。`, 'success');
        updateHeaderAndOverview();
        updateSectionSummaries();
        showToast('已恢复到所选版本', 'success');
      } catch (error) {
        showResult('sync-ops-result', `恢复失败：${error.message}`, 'error');
        showToast(`恢复失败：${error.message}`, 'error');
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    });
  });

  updateSectionSummaries();
}

async function handleLoadSyncVersions() {
  const config = collectSyncConfig();
  if (!config) {
    showToast('请先完成同步配置', 'error');
    return;
  }
  const button = $('#btn-load-sync-versions');
  button.disabled = true;
  button.textContent = '刷新中...';

  try {
    await sendMessage('saveSyncConfig', config);
    const versions = await sendMessage('getSyncVersions', { limit: 20 });
    if (versions?.error) throw new Error(versions.error);
    state.syncVersions = Array.isArray(versions) ? versions : [];
    if (state.syncVersions[0]?.date) {
      await patchMeta({ sync: { lastRemoteVersionAt: state.syncVersions[0].date } });
    }
    renderSyncVersions();
    showToast(`已加载 ${state.syncVersions.length} 条远端历史`, 'success');
  } catch (error) {
    showResult('sync-ops-result', `加载历史失败：${error.message}`, 'error');
    showToast(`加载历史失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '刷新历史';
  }
}

async function handleAITest() {
  const config = collectAIConfig();
  if (!config?.apiKey) {
    showToast('请先选择 AI 提供商并填写配置', 'error');
    return;
  }

  const button = $('#btn-test-ai');
  button.disabled = true;
  button.textContent = '测试中...';
  clearResult('ai-test-result');

  try {
    await sendMessage('saveAIConfig', config);
    const result = await sendMessage('testAI');
    const success = Boolean(result?.success);
    showResult('ai-test-result', result?.message || '测试完成', success ? 'success' : 'error');
    await patchMeta({
      ai: {
        lastTestAt: new Date().toISOString(),
        lastTestSuccess: success,
        lastTestMessage: result?.message || '',
      },
    });
    updateAIStatusUI();
  } catch (error) {
    showResult('ai-test-result', `AI 测试失败：${error.message}`, 'error');
    await patchMeta({
      ai: {
        lastTestAt: new Date().toISOString(),
        lastTestSuccess: false,
        lastTestMessage: error.message,
      },
    });
    updateAIStatusUI();
  } finally {
    button.disabled = false;
    button.textContent = '测试连接';
  }
}

async function handleAISave() {
  const config = collectAIConfig();
  if (!config?.apiKey) {
    showToast('请先选择 AI 提供商并填写配置', 'error');
    return;
  }
  await sendMessage('saveAIConfig', config);
  updateAIStatusUI();
  showToast('AI 配置已保存', 'success');
}

async function handleAIClassify() {
  const button = $('#btn-ai-classify');
  button.disabled = true;
  $('#ai-progress-box').classList.remove('hidden');
  $('#ai-suggestions').classList.add('hidden');
  setProgress('ai', 0, '准备环境', '正在准备分析环境...', true);

  try {
    await persistCurrentAIConfig();
    await nextFrame();
    setProgress('ai', 10, '读取书签', '正在读取本地书签...', true);
    const bookmarks = await BookmarkManager.getAllBookmarks();
    state.bookmarks = bookmarks;
    if (!bookmarks.length) {
      throw new Error('未检测到任何书签');
    }

    setProgress('ai', 20, '整理分类上下文', '正在整理已有分类和文件夹路径...', true);
    const exportData = await BookmarkManager.exportToSyncFormat();
    const categories = exportData.categories.map((item) => item.name);
    const allPaths = [...new Set(bookmarks.map((item) => item.category).filter(Boolean))];
    const bookmarkIndex = new Map(bookmarks.map((item) => [String(item.id), item]));

    const batchSize = 50;
    const concurrency = 5;
    const batches = [];
    for (let index = 0; index < bookmarks.length; index += batchSize) {
      batches.push(bookmarks.slice(index, index + batchSize));
    }

    const suggestions = [];
    let processed = 0;
    for (let index = 0; index < batches.length; index += concurrency) {
      const chunk = batches.slice(index, index + concurrency);
      setProgress('ai', 25, '生成建议', `正在生成分类建议，已处理 ${processed} / ${bookmarks.length}...`, true);
      await Promise.all(chunk.map(async (batch) => {
        try {
          const result = await AIEngine.classifyBatch(batch, { names: categories, _allPaths: allPaths });
          if (Array.isArray(result)) {
            suggestions.push(...result);
          }
        } catch (error) {
          console.error('AI classify batch failed:', error);
        }
      }));
      processed += chunk.reduce((sum, current) => sum + current.length, 0);
      const percent = 20 + Math.round((processed / bookmarks.length) * 78);
      setProgress('ai', percent, '生成建议', `正在生成分类建议，已处理 ${processed} / ${bookmarks.length}...`);
    }

    state.aiSuggestions = suggestions.map((item) => {
      const local = bookmarkIndex.get(String(item.bookmarkId));
      return {
        bookmarkId: String(item.bookmarkId),
        title: item.title || local?.title || '未命名书签',
        url: local?.url || '',
        currentCategory: local?.category || '未分类',
        suggestedCategory: item.suggestedCategory || item.category || '未分类',
        reason: item.reason || '',
        status: 'pending',
      };
    });

    await patchMeta({
      ai: {
        lastAnalysisAt: new Date().toISOString(),
        lastAnalysisCount: state.aiSuggestions.length,
      },
    });

    setProgress('ai', 100, '整理结果', `分析完成，共生成 ${state.aiSuggestions.length} 条建议。`);
    renderSuggestionsWorkspace();
    updateAIStatusUI();
    showToast(
      state.aiSuggestions.length
        ? `AI 已生成 ${state.aiSuggestions.length} 条建议`
        : 'AI 未给出需要调整的分类建议',
      state.aiSuggestions.length ? 'success' : 'info'
    );
  } catch (error) {
    showToast(`AI 分类失败：${error.message}`, 'error');
  } finally {
    $('#ai-progress-bar').classList.remove('indeterminate');
    button.disabled = !collectAIConfig()?.apiKey;
  }
}

function getSuggestionGroupKey(item, mode) {
  return mode === 'current' ? (item.currentCategory || '未分类') : (item.suggestedCategory || '未分类');
}

function getVisibleSuggestions() {
  const search = ($('#suggestion-search').value || '').trim().toLowerCase();
  const checkedOnly = $('#filter-checked-only').checked;
  const filterCategory = $('#suggestion-category-filter').value;
  const groupMode = $('#suggestion-group-mode').value;

  return state.aiSuggestions.filter((item) => {
    const matchesChecked = !checkedOnly || item.status === 'accepted';
    const groupKey = getSuggestionGroupKey(item, groupMode);
    const matchesCategory = filterCategory === 'all' || groupKey === filterCategory;
    const haystack = `${item.title} ${item.url} ${item.currentCategory} ${item.suggestedCategory}`.toLowerCase();
    const matchesSearch = !search || haystack.includes(search);
    return matchesChecked && matchesCategory && matchesSearch;
  });
}

function populateSuggestionFilters() {
  const mode = $('#suggestion-group-mode').value;
  const categories = [...new Set(state.aiSuggestions.map((item) => getSuggestionGroupKey(item, mode)).filter(Boolean))].sort();
  const select = $('#suggestion-category-filter');
  const current = select.value;
  select.innerHTML = '<option value="all">按分类筛选</option>';
  categories.forEach((category) => {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    select.appendChild(option);
  });
  if (categories.includes(current)) {
    select.value = current;
  }
}

function renderSuggestionTabs(grouped, groupKeys) {
  const tabs = $('#category-tabs');
  tabs.innerHTML = '';
  if (!groupKeys.length) return;

  groupKeys.forEach((key) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `category-tab${state.currentSuggestionGroup === key ? ' active' : ''}`;
    button.innerHTML = `<span>${escapeHtml(key)}</span><span class="category-count">${grouped[key].length}</span>`;
    button.addEventListener('click', () => {
      state.currentSuggestionGroup = key;
      renderSuggestionsWorkspace();
    });
    tabs.appendChild(button);
  });
}

function renderSuggestionsWorkspace() {
  const wrapper = $('#ai-suggestions');
  const list = $('#suggestions-list');
  const empty = $('#suggestions-empty');
  const actionBar = $('#category-action-bar');
  const groupMode = $('#suggestion-group-mode').value;

  if (!state.aiSuggestions.length) {
    wrapper.classList.add('hidden');
    list.innerHTML = '';
    empty.classList.add('hidden');
    actionBar.classList.add('hidden');
    $('#category-tabs').innerHTML = '';
    refreshGovernanceState();
    return;
  }

  populateSuggestionFilters();

  const visible = getVisibleSuggestions();
  const grouped = visible.reduce((acc, item) => {
    const key = getSuggestionGroupKey(item, groupMode);
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
  const groupKeys = Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length);

  if (!groupKeys.length) {
    state.currentSuggestionGroup = null;
    wrapper.classList.remove('hidden');
    list.innerHTML = '';
    empty.classList.remove('hidden');
    actionBar.classList.add('hidden');
    renderSuggestionTabs({}, []);
    refreshGovernanceState();
    return;
  }

  if (!groupKeys.includes(state.currentSuggestionGroup)) {
    state.currentSuggestionGroup = groupKeys[0];
  }

  const currentItems = grouped[state.currentSuggestionGroup] || [];
  wrapper.classList.remove('hidden');
  empty.classList.add('hidden');
  renderSuggestionTabs(grouped, groupKeys);

  const acceptedCount = currentItems.filter((item) => item.status === 'accepted').length;
  const deletedCount = currentItems.filter((item) => item.status === 'deleted').length;
  actionBar.classList.remove('hidden');
  $('#category-action-hint').textContent = `${state.currentSuggestionGroup} · ${acceptedCount}/${currentItems.length} 已勾选，${deletedCount} 条待删除`;

  list.innerHTML = '';
  currentItems.forEach((item) => {
    const card = document.createElement('article');
    card.className = `suggestion-item ${item.status === 'accepted' ? 'accepted' : ''} ${item.status === 'deleted' ? 'deleted' : ''}`;
    card.innerHTML = `
      <div class="suggestion-main">
        <input class="suggestion-check" type="checkbox" data-bookmark-id="${escapeHtml(item.bookmarkId)}" ${item.status === 'accepted' ? 'checked' : ''}>
        <div>
          <p class="suggestion-title">
            <a class="suggestion-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>
          </p>
          <div class="suggestion-meta">${escapeHtml(item.url)}</div>
          <div class="route-compare">
            <span class="route-pill">${escapeHtml(item.currentCategory || '未分类')}</span>
            <span class="route-arrow">→</span>
            <span class="route-pill">${escapeHtml(item.suggestedCategory || '未分类')}</span>
          </div>
          ${item.reason ? `<span class="reason-chip" title="${escapeHtml(item.reason)}">建议理由</span>` : ''}
        </div>
        <div class="suggestion-actions">
          <button type="button" class="ghost-action btn-mark-delete ${item.status === 'deleted' ? 'active' : ''}" data-bookmark-id="${escapeHtml(item.bookmarkId)}">加入删除</button>
          <button type="button" class="ghost-action btn-reset-suggestion" data-bookmark-id="${escapeHtml(item.bookmarkId)}">恢复待定</button>
        </div>
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('.suggestion-check').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const item = state.aiSuggestions.find((suggestion) => suggestion.bookmarkId === checkbox.dataset.bookmarkId);
      if (!item) return;
      item.status = checkbox.checked ? 'accepted' : 'pending';
      renderSuggestionsWorkspace();
    });
  });

  list.querySelectorAll('.btn-mark-delete').forEach((button) => {
    button.addEventListener('click', () => {
      const item = state.aiSuggestions.find((suggestion) => suggestion.bookmarkId === button.dataset.bookmarkId);
      if (!item) return;
      item.status = item.status === 'deleted' ? 'pending' : 'deleted';
      renderSuggestionsWorkspace();
    });
  });

  list.querySelectorAll('.btn-reset-suggestion').forEach((button) => {
    button.addEventListener('click', () => {
      const item = state.aiSuggestions.find((suggestion) => suggestion.bookmarkId === button.dataset.bookmarkId);
      if (!item) return;
      item.status = 'pending';
      renderSuggestionsWorkspace();
    });
  });

  refreshGovernanceState();
}

function normalizeCategoryName(text) {
  return (text || '')
    .trim()
    .replace(/^把|^将/, '')
    .replace(/收藏夹$|文件夹$/, '')
    .trim();
}

function buildCategoryCandidates() {
  return [...new Set(state.aiSuggestions.flatMap((item) => [item.suggestedCategory, item.currentCategory]).filter(Boolean))];
}

function resolveCategoryName(rawName, candidates) {
  const normalized = normalizeCategoryName(rawName);
  if (!normalized) return '';

  const exact = candidates.find((item) => normalizeCategoryName(item) === normalized);
  if (exact) return exact;
  const contains = candidates.find((item) => normalizeCategoryName(item).includes(normalized));
  if (contains) return contains;
  const reverse = candidates.find((item) => normalized.includes(normalizeCategoryName(item)));
  return reverse || normalized;
}

function replaceSuggestionCategory(sourceCategory, targetCategory) {
  let changed = 0;
  state.aiSuggestions.forEach((item) => {
    if (item.status === 'deleted') return;
    const current = item.suggestedCategory || '';
    if (current === sourceCategory || current.startsWith(`${sourceCategory}/`)) {
      item.suggestedCategory = current.replace(sourceCategory, targetCategory);
      if (item.status === 'pending') item.status = 'accepted';
      changed += 1;
    }
  });
  return changed;
}

function normalizeInstructionText(text) {
  return (text || '')
    .trim()
    .replace(/[。！!？?]/g, '；')
    .replace(/\s+/g, ' ')
    .replace(/\s*(然后|再|并且|同时)\s*/g, '；')
    .replace(/；+/g, '；')
    .replace(/^；|；$/g, '');
}

function splitInstructionActions(text) {
  return normalizeInstructionText(text)
    .split('；')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCategoryList(raw) {
  return (raw || '')
    .split(/(?:和|与|及|跟|、|,|，|\/)/)
    .map((item) => normalizeCategoryName(item))
    .filter(Boolean);
}

function parseSingleRuleAction(actionText) {
  const text = normalizeInstructionText(actionText);
  if (!text) return null;

  let match = text.match(/^(?:把|将)?\s*除\s*(.+?)\s*外(?:都|全部)?\s*(?:并入|归入|归到|归为|统归到|统归为|合并到|合并为|放入|移动到)\s*(.+)$/i);
  if (match) {
    return { type: 'move_all_except', excludes: parseCategoryList(match[1]), target: normalizeCategoryName(match[2]) };
  }

  match = text.match(/^(?:把|将)?\s*(.+?)\s*(?:合并(?:到|为)?|并为|都为|归为|归到|统归到|统归为|统一到)\s*(.+)$/i);
  if (match) {
    return { type: 'merge', sources: parseCategoryList(match[1]), target: normalizeCategoryName(match[2]) };
  }

  match = text.match(/^(?:把|将)?\s*(.+?)\s*(?:并入|归入|迁入|放入|移动到)\s*(.+)$/i);
  if (match) {
    return { type: 'move', sources: parseCategoryList(match[1]), target: normalizeCategoryName(match[2]) };
  }

  match = text.match(/^(?:把|将)?\s*(.+?)\s*(?:改为|改成|改名为|重命名为|命名为|叫做)\s*(.+)$/i);
  if (match) {
    return { type: 'rename', source: normalizeCategoryName(match[1]), target: normalizeCategoryName(match[2]) };
  }

  return null;
}

function replaceAllExceptToTarget(excludedSources, targetCategory, categoryCandidates) {
  const resolvedExcludes = (excludedSources || []).map((item) => resolveCategoryName(item, categoryCandidates)).filter(Boolean);
  const excludeSet = new Set(resolvedExcludes);
  const target = resolveCategoryName(targetCategory, categoryCandidates);
  let changed = 0;

  state.aiSuggestions.forEach((item) => {
    if (item.status === 'deleted') return;
    const current = item.suggestedCategory || '';
    if (!current || current === target || current.startsWith(`${target}/`)) return;
    const excluded = Array.from(excludeSet).some((name) => current === name || current.startsWith(`${name}/`));
    if (excluded) return;
    item.suggestedCategory = target;
    if (item.status === 'pending') item.status = 'accepted';
    changed += 1;
  });

  return changed;
}

function applyStructuredOperations(operations, categoryCandidates) {
  let changed = 0;
  for (const operation of operations || []) {
    const type = String(operation?.type || '').toLowerCase();

    if (type === 'move_all_except') {
      changed += replaceAllExceptToTarget(operation.excludes || [], operation.target || operation.to, categoryCandidates);
      continue;
    }

    if (type === 'merge') {
      const target = resolveCategoryName(operation.target, categoryCandidates);
      const sources = Array.isArray(operation.sources) ? operation.sources : [];
      sources.forEach((sourceItem) => {
        const source = resolveCategoryName(sourceItem, categoryCandidates);
        if (source && target && source !== target) {
          changed += replaceSuggestionCategory(source, target);
        }
      });
      continue;
    }

    if (type === 'rename' || type === 'move') {
      const target = resolveCategoryName(operation.target || operation.to, categoryCandidates);
      const sources = Array.isArray(operation.sources) && operation.sources.length
        ? operation.sources
        : [operation.source || operation.from].filter(Boolean);
      sources.forEach((sourceItem) => {
        const source = resolveCategoryName(sourceItem, categoryCandidates);
        if (source && target && source !== target) {
          changed += replaceSuggestionCategory(source, target);
        }
      });
    }
  }
  return changed;
}

function applyNaturalLanguageRule(rawInstruction) {
  const text = (rawInstruction || '').trim();
  if (!text) throw new Error('请输入自然语言规则');
  const actions = splitInstructionActions(text);
  if (!actions.length) throw new Error('请输入有效规则');

  const candidates = buildCategoryCandidates();
  const parsed = [];
  for (const action of actions) {
    const operation = parseSingleRuleAction(action);
    if (!operation) return null; // 本地无法解析，交由调用方决定是否降级 AI
    parsed.push(operation);
  }

  const changed = applyStructuredOperations(parsed, candidates);
  return {
    changed,
    message: `已应用 ${parsed.length} 条规则`,
  };
}

async function applyNaturalLanguageRuleWithAI(rawInstruction) {
  await persistCurrentAIConfig();
  const candidates = buildCategoryCandidates();
  const parsed = await AIEngine.parseCategoryRule(rawInstruction, candidates);
  return {
    changed: applyStructuredOperations(parsed.operations || [], candidates),
    message: parsed.explanation || '已通过 AI 语义理解应用规则',
  };
}

function renderRulePreview() {
  const input = $('#ai-rule-input')?.value || '';
  const title = $('#rule-preview-title');
  const text = $('#rule-preview-text');

  if (!input.trim()) {
    title.textContent = '等待输入规则';
    text.textContent = '输入后会展示解析出的动作数量、命中分类和解析来源。';
    return;
  }

  try {
    const actions = splitInstructionActions(input);
    const parsed = actions.map((item) => parseSingleRuleAction(item)).filter(Boolean);
    if (!parsed.length || parsed.length !== actions.length) {
      throw new Error('需要 AI 语义解析');
    }
    const excludes = parsed.filter((item) => item.type === 'move_all_except').flatMap((item) => item.excludes || []);
    const targets = parsed.flatMap((item) => [item.target || item.to].filter(Boolean));
    title.textContent = `已识别 ${parsed.length} 个动作`;
    text.textContent = `命中目标分类 ${targets.join('、') || '无'}${excludes.length ? `，包含排除条件 ${excludes.join('、')}` : ''}。解析来源：本地规则解析。`;
  } catch {
    title.textContent = '本地规则未完全命中';
    text.textContent = '当前表达会优先尝试 AI 语义解析。应用时会返回结构化动作，再映射到当前建议列表。';
  }
}

async function handleApplyRule() {
  if (!state.aiSuggestions.length) {
    showToast('请先执行 AI 分析后再应用规则', 'info');
    return;
  }
  const instruction = $('#ai-rule-input').value || '';
  try {
    // applyNaturalLanguageRule 返回 null 表示本地无法解析，需降级 AI
    let result = applyNaturalLanguageRule(instruction);
    if (result === null) {
      result = await applyNaturalLanguageRuleWithAI(instruction);
    }
    if (!result.changed) {
      showToast('规则已解析，但未命中可调整的分类', 'info');
      return;
    }
    renderSuggestionsWorkspace();
    renderRulePreview();
    showToast(`${result.message}，共调整 ${result.changed} 条`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function classifyHealthResult(url, response, errorMessage = '') {
  if (!response) {
    if (/timed out|timeout/i.test(errorMessage)) {
      return { status: 'timeout', label: '超时', summary: '请求超时' };
    }
    return { status: 'failed', label: '无法连接', summary: errorMessage || '无法建立连接' };
  }

  const finalUrl = response.url || url;
  if (response.redirected && normalizeUrlForCompare(finalUrl) !== normalizeUrlForCompare(url)) {
    return { status: 'redirect', label: '重定向异常', summary: `跳转到 ${finalUrl}` };
  }
  if (response.status >= 400) {
    return { status: 'failed', label: String(response.status), summary: `HTTP ${response.status}` };
  }
  return { status: 'ok', label: response.status ? String(response.status) : '正常', summary: '可正常访问' };
}

async function probeUrl(url, timeout = 8000) {
  const attempt = async (method) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), timeout);
    try {
      const response = await fetch(url, {
        method,
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timer);
      return response;
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  };

  try {
    const head = await attempt('HEAD');
    if (head.status === 405 || head.status === 403) {
      return await attempt('GET');
    }
    return head;
  } catch (error) {
    if (String(error).includes('timeout') || error?.name === 'AbortError') {
      throw new Error('timeout');
    }
    try {
      return await attempt('GET');
    } catch (getError) {
      if (getError?.name === 'AbortError') throw new Error('timeout');
      throw getError;
    }
  }
}

function healthStatusVariant(status) {
  if (status === 'ok') return 'success';
  if (status === 'redirect') return 'warning';
  return 'danger';
}

function renderHealthStats() {
  const ok = state.healthResults.filter((item) => item.status === 'ok').length;
  const failed = state.healthResults.filter((item) => item.status === 'failed').length;
  const timeout = state.healthResults.filter((item) => item.status === 'timeout').length;
  const redirect = state.healthResults.filter((item) => item.status === 'redirect').length;

  $('#health-stat-ok').textContent = compactNumber(ok);
  $('#health-stat-failed').textContent = compactNumber(failed);
  $('#health-stat-timeout').textContent = compactNumber(timeout);
  $('#health-stat-redirect').textContent = compactNumber(redirect);

  state.meta.health.ok = ok;
  state.meta.health.failed = failed;
  state.meta.health.timeout = timeout;
  state.meta.health.redirect = redirect;
}

function populateHealthFilters() {
  const categories = [...new Set(state.healthResults.map((item) => item.category || '未分类'))].sort();
  const select = $('#health-category-filter');
  const current = select.value;
  select.innerHTML = '<option value="all">按分类查看</option>';
  categories.forEach((category) => {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    select.appendChild(option);
  });
  if (categories.includes(current)) select.value = current;
}

function getVisibleHealthResults() {
  const filter = $('#health-filter').value;
  const category = $('#health-category-filter').value;
  return state.healthResults.filter((item) => {
    const matchesCategory = category === 'all' || (item.category || '未分类') === category;
    if (!matchesCategory) return false;
    if (filter === 'all') return true;
    if (filter === 'problem') return item.status !== 'ok';
    if (filter === 'timeout') return item.status === 'timeout';
    if (filter === 'queued') return item.queuedForDeletion;
    return true;
  });
}

function renderHealthResults() {
  renderHealthStats();
  populateHealthFilters();
  const empty = $('#health-empty');
  const list = $('#health-results-list');
  const visible = getVisibleHealthResults();
  list.innerHTML = '';

  if (!state.healthResults.length) {
    empty.classList.remove('hidden');
    empty.querySelector('strong').textContent = '还没有体检结果';
    empty.querySelector('p').textContent = '开始检测后，这里会出现正常、失效、超时和重定向异常的统计与列表。';
    refreshGovernanceState();
    return;
  }

  if (!visible.length) {
    empty.classList.remove('hidden');
    empty.querySelector('strong').textContent = '当前筛选下没有结果';
    empty.querySelector('p').textContent = '可以切换筛选条件，查看全部体检结果。';
    refreshGovernanceState();
    return;
  }

  empty.classList.add('hidden');
  visible.forEach((item) => {
    const row = document.createElement('article');
    row.className = `health-item ${item.queuedForDeletion ? 'queued' : ''}`;
    row.innerHTML = `
      <div class="health-item-top">
        <div>
          <p class="health-title"><a class="health-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></p>
          <div class="health-meta">${escapeHtml(item.url)}</div>
          <div class="health-meta">分类：${escapeHtml(item.category || '未分类')} · 最后检测：${escapeHtml(formatTime(item.checkedAt))}</div>
        </div>
        <span class="status-badge ${healthStatusVariant(item.status)}">${escapeHtml(item.label)}</span>
      </div>
      <div class="health-meta">${escapeHtml(item.summary)}</div>
      <div class="health-actions">
        <button type="button" class="ghost-action btn-health-open" data-bookmark-id="${escapeHtml(item.bookmarkId)}">打开确认</button>
        <button type="button" class="ghost-action btn-health-ignore ${item.ignored ? 'active' : ''}" data-bookmark-id="${escapeHtml(item.bookmarkId)}">${item.ignored ? '已忽略' : '忽略'}</button>
        <button type="button" class="ghost-action btn-health-queue ${item.queuedForDeletion ? 'active' : ''}" data-bookmark-id="${escapeHtml(item.bookmarkId)}">${item.queuedForDeletion ? '已加入待删除' : '加入待删除'}</button>
        <button type="button" class="ghost-action btn-health-retest" data-bookmark-id="${escapeHtml(item.bookmarkId)}">重新检测</button>
      </div>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll('.btn-health-open').forEach((button) => {
    button.addEventListener('click', () => {
      const item = state.healthResults.find((result) => result.bookmarkId === button.dataset.bookmarkId);
      if (item?.url) window.open(item.url, '_blank', 'noopener');
    });
  });

  list.querySelectorAll('.btn-health-ignore').forEach((button) => {
    button.addEventListener('click', () => {
      const item = state.healthResults.find((result) => result.bookmarkId === button.dataset.bookmarkId);
      if (!item) return;
      item.ignored = !item.ignored;
      if (item.ignored) item.queuedForDeletion = false;
      renderHealthResults();
    });
  });

  list.querySelectorAll('.btn-health-queue').forEach((button) => {
    button.addEventListener('click', () => {
      const item = state.healthResults.find((result) => result.bookmarkId === button.dataset.bookmarkId);
      if (!item) return;
      item.queuedForDeletion = !item.queuedForDeletion;
      if (item.queuedForDeletion) item.ignored = false;
      renderHealthResults();
    });
  });

  list.querySelectorAll('.btn-health-retest').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = state.healthResults.find((result) => result.bookmarkId === button.dataset.bookmarkId);
      if (!item) return;
      button.disabled = true;
      button.textContent = '检测中...';
      try {
        const response = await probeUrl(item.url, 8000);
        Object.assign(item, classifyHealthResult(item.url, response), {
          checkedAt: new Date().toISOString(),
          ignored: false,
        });
        renderHealthResults();
      } catch (error) {
        Object.assign(item, classifyHealthResult(item.url, null, error.message), {
          checkedAt: new Date().toISOString(),
          ignored: false,
        });
        renderHealthResults();
      } finally {
        button.disabled = false;
        button.textContent = '重新检测';
      }
    });
  });

  refreshGovernanceState();
}

async function handleHealthCheck() {
  const button = $('#btn-run-health-check');
  button.disabled = true;
  button.textContent = '检测中...';
  $('#health-progress-box').classList.remove('hidden');
  setProgress('health', 0, '准备扫描', '正在读取书签...', true);

  try {
    const bookmarks = await BookmarkManager.getAllBookmarks();
    state.bookmarks = bookmarks;
    if (!bookmarks.length) {
      throw new Error('未检测到任何书签');
    }

    const concurrency = 8;
    const results = [];
    let processed = 0;
    for (let index = 0; index < bookmarks.length; index += concurrency) {
      const chunk = bookmarks.slice(index, index + concurrency);
      setProgress('health', 10, '请求网址状态', `正在检测 ${processed} / ${bookmarks.length}...`, true);
      const chunkResults = await Promise.all(chunk.map(async (bookmark) => {
        try {
          const response = await probeUrl(bookmark.url);
          return {
            bookmarkId: String(bookmark.id),
            title: bookmark.title,
            url: bookmark.url,
            category: bookmark.category || '未分类',
            checkedAt: new Date().toISOString(),
            ignored: false,
            queuedForDeletion: false,
            ...classifyHealthResult(bookmark.url, response),
          };
        } catch (error) {
          return {
            bookmarkId: String(bookmark.id),
            title: bookmark.title,
            url: bookmark.url,
            category: bookmark.category || '未分类',
            checkedAt: new Date().toISOString(),
            ignored: false,
            queuedForDeletion: false,
            ...classifyHealthResult(bookmark.url, null, error.message),
          };
        }
      }));
      results.push(...chunkResults);
      processed += chunk.length;
      const percent = 12 + Math.round((processed / bookmarks.length) * 88);
      setProgress('health', percent, '整理体检结果', `已检测 ${processed} / ${bookmarks.length} 条书签`);
    }

    state.healthResults = results;
    const okCount = results.filter((item) => item.status === 'ok').length;
    const failedCount = results.filter((item) => item.status === 'failed').length;
    const timeoutCount = results.filter((item) => item.status === 'timeout').length;
    const redirectCount = results.filter((item) => item.status === 'redirect').length;
    await patchMeta({
      health: {
        lastRunAt: new Date().toISOString(),
        ok: okCount,
        failed: failedCount,
        timeout: timeoutCount,
        redirect: redirectCount,
      },
    });
    renderHealthResults();
    updateHeaderAndOverview();
    updateSectionSummaries();

    const issues = results.filter((item) => item.status !== 'ok').length;
    if (issues === 0) {
      $('#health-empty').classList.remove('hidden');
      $('#health-empty strong').textContent = '未发现失效链接';
      $('#health-empty p').textContent = '当前书签整体状态良好，暂未发现明显不可访问的网址。';
    }
    showToast(issues ? `体检完成，发现 ${issues} 个问题` : '体检完成，当前书签很健康', issues ? 'warning' : 'success');
  } catch (error) {
    showToast(`体检失败：${error.message}`, 'error');
  } finally {
    $('#health-progress-bar').classList.remove('indeterminate');
    button.disabled = false;
    button.textContent = '一键开始检测';
  }
}

function normalizeUrlForCompare(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const paramsToDelete = [];
    url.searchParams.forEach((_, key) => {
      if (key.toLowerCase().startsWith('utm_')) paramsToDelete.push(key);
    });
    paramsToDelete.forEach((key) => url.searchParams.delete(key));
    url.hash = '';
    url.hostname = url.hostname.replace(/^www\./, '').toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    if (url.pathname !== '/') {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function scoreDuplicateKeep(bookmark) {
  let score = 0;
  score += Math.min((bookmark.title || '').trim().length, 60);
  score += bookmark.category ? 12 : 0;
  score += /https:/.test(bookmark.url || '') ? 8 : 0;
  score += /\?/.test(bookmark.url || '') ? -4 : 4;
  score += bookmark.dateAdded ? new Date(bookmark.dateAdded).getTime() / 1e12 : 0;
  return score;
}

function applyDuplicateStrategy(group, strategy) {
  group.strategy = strategy;
  let keepId = group.keepId;

  if (strategy === 'latest') {
    keepId = group.items.slice().sort((a, b) => new Date(b.dateAdded || 0) - new Date(a.dateAdded || 0))[0]?.bookmarkId;
  } else if (strategy === 'earliest') {
    keepId = group.items.slice().sort((a, b) => new Date(a.dateAdded || 0) - new Date(b.dateAdded || 0))[0]?.bookmarkId;
  } else if (strategy === 'recommended') {
    keepId = group.items.slice().sort((a, b) => scoreDuplicateKeep(b) - scoreDuplicateKeep(a))[0]?.bookmarkId;
  }

  group.keepId = keepId || group.items[0]?.bookmarkId;
  group.items.forEach((item) => {
    item.markedForDeletion = strategy === 'manual' ? item.markedForDeletion : item.bookmarkId !== group.keepId;
  });
}

function populateDuplicateFilters() {
  const categories = [...new Set(state.duplicateGroups.flatMap((group) => group.items.map((item) => item.category || '未分类')))].sort();
  const select = $('#duplicate-category-filter');
  const current = select.value;
  select.innerHTML = '<option value="all">按分类聚合</option>';
  categories.forEach((category) => {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    select.appendChild(option);
  });
  if (categories.includes(current)) select.value = current;
}

function getVisibleDuplicateGroups() {
  const filter = $('#duplicate-filter').value;
  const category = $('#duplicate-category-filter').value;
  return state.duplicateGroups.filter((group) => {
    const matchesCategory = category === 'all' || group.items.some((item) => (item.category || '未分类') === category);
    if (!matchesCategory) return false;
    if (filter === 'pending') {
      return group.items.some((item) => item.markedForDeletion);
    }
    return true;
  });
}

function renderDuplicateGroups() {
  populateDuplicateFilters();
  const empty = $('#duplicate-empty');
  const list = $('#duplicate-groups-list');
  const groups = getVisibleDuplicateGroups();
  list.innerHTML = '';

  if (!state.duplicateGroups.length) {
    empty.classList.remove('hidden');
    empty.querySelector('strong').textContent = '还没有重复检测结果';
    empty.querySelector('p').textContent = '开始检测后，这里会按重复组展示保留与删除建议。';
    refreshGovernanceState();
    return;
  }

  if (!groups.length) {
    empty.classList.remove('hidden');
    empty.querySelector('strong').textContent = '当前筛选下没有重复组';
    empty.querySelector('p').textContent = '可以切换为“查看全部重复组”以检查完整结果。';
    refreshGovernanceState();
    return;
  }

  empty.classList.add('hidden');
  groups.forEach((group) => {
    const wrapper = document.createElement('article');
    wrapper.className = 'duplicate-group';
    wrapper.innerHTML = `
      <div class="duplicate-group-head">
        <div>
          <p class="duplicate-title">${escapeHtml(group.label)}</p>
          <div class="duplicate-meta">${group.items.length} 条重复项 · 推荐保留 ${escapeHtml(group.items.find((item) => item.bookmarkId === group.keepId)?.title || '当前项')}</div>
        </div>
        <div class="duplicate-strategy">
          <button type="button" class="ghost-action btn-dup-strategy ${group.strategy === 'recommended' ? 'active' : ''}" data-strategy="recommended" data-group-id="${escapeHtml(group.groupId)}">保留推荐</button>
          <button type="button" class="ghost-action btn-dup-strategy ${group.strategy === 'latest' ? 'active' : ''}" data-strategy="latest" data-group-id="${escapeHtml(group.groupId)}">保留最新</button>
          <button type="button" class="ghost-action btn-dup-strategy ${group.strategy === 'earliest' ? 'active' : ''}" data-strategy="earliest" data-group-id="${escapeHtml(group.groupId)}">保留最早</button>
          <button type="button" class="ghost-action btn-dup-strategy ${group.strategy === 'manual' ? 'active' : ''}" data-strategy="manual" data-group-id="${escapeHtml(group.groupId)}">手动选择</button>
        </div>
      </div>
      <div class="duplicate-group-items"></div>
    `;

    const itemsContainer = wrapper.querySelector('.duplicate-group-items');
    group.items.forEach((item) => {
      const row = document.createElement('div');
      row.className = `duplicate-item ${item.markedForDeletion ? 'marked-delete' : ''}`;
      row.innerHTML = `
        <div class="duplicate-main">
          <label class="toolbar-check">
            <input type="radio" name="dup-keep-${escapeHtml(group.groupId)}" ${item.bookmarkId === group.keepId ? 'checked' : ''} data-group-id="${escapeHtml(group.groupId)}" data-bookmark-id="${escapeHtml(item.bookmarkId)}">
            <span>保留这一条</span>
          </label>
          <div>
            <p class="duplicate-title"><a class="duplicate-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></p>
            <div class="duplicate-meta">${escapeHtml(item.url)}</div>
            <div class="duplicate-meta">分类：${escapeHtml(item.category || '未分类')} · 保存时间：${escapeHtml(formatTime(item.dateAdded))}</div>
          </div>
          <div class="duplicate-actions">
            <button type="button" class="ghost-action btn-dup-delete ${item.markedForDeletion ? 'active' : ''}" data-group-id="${escapeHtml(group.groupId)}" data-bookmark-id="${escapeHtml(item.bookmarkId)}">${item.markedForDeletion ? '待清理' : '加入清理'}</button>
          </div>
        </div>
      `;
      itemsContainer.appendChild(row);
    });

    list.appendChild(wrapper);
  });

  list.querySelectorAll('.btn-dup-strategy').forEach((button) => {
    button.addEventListener('click', () => {
      const group = state.duplicateGroups.find((item) => item.groupId === button.dataset.groupId);
      if (!group) return;
      applyDuplicateStrategy(group, button.dataset.strategy);
      renderDuplicateGroups();
    });
  });

  list.querySelectorAll('input[type="radio"][name^="dup-keep-"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const group = state.duplicateGroups.find((item) => item.groupId === radio.dataset.groupId);
      if (!group) return;
      group.strategy = 'manual';
      group.keepId = radio.dataset.bookmarkId;
      group.items.forEach((item) => {
        item.markedForDeletion = item.bookmarkId !== group.keepId;
      });
      renderDuplicateGroups();
    });
  });

  list.querySelectorAll('.btn-dup-delete').forEach((button) => {
    button.addEventListener('click', () => {
      const group = state.duplicateGroups.find((item) => item.groupId === button.dataset.groupId);
      const target = group?.items.find((item) => item.bookmarkId === button.dataset.bookmarkId);
      if (!group || !target) return;
      group.strategy = 'manual';
      target.markedForDeletion = !target.markedForDeletion;
      if (!target.markedForDeletion) {
        group.keepId = target.bookmarkId;
      }
      renderDuplicateGroups();
    });
  });

  refreshGovernanceState();
}

async function handleDuplicateCheck() {
  const button = $('#btn-run-duplicate-check');
  button.disabled = true;
  button.textContent = '检测中...';

  try {
    const bookmarks = await BookmarkManager.getAllBookmarks();
    state.bookmarks = bookmarks;
    const groupsByUrl = new Map();
    bookmarks.forEach((bookmark) => {
      const key = normalizeUrlForCompare(bookmark.url);
      if (!groupsByUrl.has(key)) groupsByUrl.set(key, []);
      groupsByUrl.get(key).push({
        bookmarkId: String(bookmark.id),
        title: bookmark.title || '未命名书签',
        url: bookmark.url,
        category: bookmark.category || '未分类',
        dateAdded: bookmark.dateAdded,
        markedForDeletion: false,
      });
    });

    state.duplicateGroups = Array.from(groupsByUrl.entries())
      .filter(([, items]) => items.length > 1)
      .map(([key, items], index) => {
        const group = {
          groupId: `dup-${index}-${items[0].bookmarkId}`,
          normalizedUrl: key,
          label: (() => {
            try {
              const url = new URL(key);
              return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
            } catch {
              return key;
            }
          })(),
          items,
          strategy: 'recommended',
          keepId: items[0].bookmarkId,
        };
        applyDuplicateStrategy(group, 'recommended');
        return group;
      });

    await patchMeta({
      duplicate: {
        lastRunAt: new Date().toISOString(),
        groups: state.duplicateGroups.length,
        items: state.duplicateGroups.reduce((sum, group) => sum + group.items.length, 0),
      },
    });
    renderDuplicateGroups();
    updateHeaderAndOverview();
    updateSectionSummaries();

    if (!state.duplicateGroups.length) {
      $('#duplicate-empty').classList.remove('hidden');
      $('#duplicate-empty strong').textContent = '未发现重复书签';
      $('#duplicate-empty p').textContent = '当前书签结构比较健康，暂未发现重复收藏的网址。';
    }
    showToast(
      state.duplicateGroups.length
        ? `重复检测完成，发现 ${state.duplicateGroups.length} 组重复项`
        : '重复检测完成，未发现重复书签',
      'success'
    );
  } catch (error) {
    showToast(`重复检测失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '一键开始检测';
  }
}

function refreshGovernanceState() {
  const pending = currentPendingActions();
  const aiCount = pending.aiMove.length + pending.aiDelete.length;
  const healthCount = pending.healthDelete.length;
  const duplicateCount = pending.duplicateDelete.length;

  const aiSummary = $('#ai-action-summary');
  if (aiSummary) {
    aiSummary.textContent = aiCount
      ? `待应用 ${pending.aiMove.length} 条分类调整，待删除 ${pending.aiDelete.length} 条书签`
      : '当前没有待应用建议';
  }

  const healthSummary = $('#health-action-summary');
  if (healthSummary) {
    healthSummary.textContent = healthCount
      ? `当前已加入 ${healthCount} 条待删除链接`
      : '当前没有待删除项';
  }

  const duplicateSummary = $('#duplicate-action-summary');
  if (duplicateSummary) {
    duplicateSummary.textContent = duplicateCount
      ? `当前已标记 ${duplicateCount} 条重复书签待清理`
      : '当前没有待清理项';
  }

  setButtonState('#btn-clear-ai-actions', !aiCount);
  setButtonState('#btn-apply-ai-actions', !aiCount);
  setButtonState('#btn-clear-health-actions', !healthCount);
  setButtonState('#btn-apply-health-actions', !healthCount);
  setButtonState('#btn-clear-duplicate-actions', !duplicateCount);
  setButtonState('#btn-apply-duplicate-actions', !duplicateCount);

  $('#duplicate-stat-marked').textContent = compactNumber(duplicateCount);
  $('#duplicate-stat-kept').textContent = compactNumber(state.duplicateGroups.filter((group) => group.keepId).length);
  $('#duplicate-stat-visible').textContent = compactNumber(state.duplicateGroups.length ? getVisibleDuplicateGroups().length : 0);

  updateHeaderAndOverview();
  updateSectionSummaries();
}

function clearQueuedActions(scope) {
  if (scope === 'ai') {
    state.aiSuggestions.forEach((item) => {
      if (item.status === 'accepted' || item.status === 'deleted') {
        item.status = 'pending';
      }
    });
    renderSuggestionsWorkspace();
    refreshGovernanceState();
    showToast('已清空 AI 待应用建议', 'success');
    return;
  }

  if (scope === 'health') {
    state.healthResults.forEach((item) => {
      item.queuedForDeletion = false;
    });
    renderHealthResults();
    refreshGovernanceState();
    showToast('已清空体检待删除项', 'success');
    return;
  }

  if (scope === 'duplicate') {
    state.duplicateGroups.forEach((group) => {
      group.strategy = 'manual';
      group.items.forEach((item) => {
        item.markedForDeletion = false;
      });
    });
    renderDuplicateGroups();
    refreshGovernanceState();
    showToast('已清空重复清理待处理项', 'success');
  }
}

function getScopePending(scope) {
  const pending = currentPendingActions();
  if (scope === 'ai') {
    return {
      move: pending.aiMove,
      remove: pending.aiDelete,
      label: 'AI 变更',
      confirmTitle: '确认应用 AI 变更',
      confirmText: `将更新 ${pending.aiMove.length} 条分类，并删除 ${pending.aiDelete.length} 条 AI 标记书签。`,
      applyButton: '#btn-apply-ai-actions',
      applyIdleText: '应用 AI 变更',
      applyBusyText: '应用中...',
    };
  }

  if (scope === 'health') {
    return {
      move: [],
      remove: pending.healthDelete,
      label: '体检结果',
      confirmTitle: '确认应用体检结果',
      confirmText: `将删除 ${pending.healthDelete.length} 条已确认失效或异常的书签。`,
      applyButton: '#btn-apply-health-actions',
      applyIdleText: '应用体检结果',
      applyBusyText: '应用中...',
    };
  }

  return {
    move: [],
    remove: pending.duplicateDelete,
    label: '重复清理',
    confirmTitle: '确认应用重复清理',
    confirmText: `将删除 ${pending.duplicateDelete.length} 条已标记为重复的书签。`,
    applyButton: '#btn-apply-duplicate-actions',
    applyIdleText: '应用重复清理',
    applyBusyText: '应用中...',
  };
}

async function applyQueuedActions(scope) {
  const scoped = getScopePending(scope);
  if (!scoped.move.length && !scoped.remove.length) {
    showToast(`当前没有待应用的${scoped.label}`, 'info');
    return;
  }

  const confirmed = await modalConfirm({
    title: scoped.confirmTitle,
    text: scoped.confirmText,
    confirmText: scoped.applyIdleText,
    danger: scope !== 'ai',
  });
  if (!confirmed) return;

  const applyButton = $(scoped.applyButton);
  applyButton.disabled = true;
  applyButton.textContent = scoped.applyBusyText;

  try {
    const deleteIds = new Set(scoped.remove.map((item) => item.bookmarkId));

    let deleted = 0;
    for (const bookmarkId of deleteIds) {
      try {
        await BookmarkManager.remove(bookmarkId);
        deleted += 1;
      } catch (error) {
        console.error('Delete bookmark failed:', bookmarkId, error);
      }
    }

    let moved = 0;
    for (const item of scoped.move) {
      if (deleteIds.has(item.bookmarkId)) continue;
      try {
        const folderId = await BookmarkManager.ensureFolderPath(item.suggestedCategory);
        await BookmarkManager.move(item.bookmarkId, folderId);
        moved += 1;
      } catch (error) {
        console.error('Move bookmark failed:', item.bookmarkId, error);
      }
    }

    state.aiSuggestions = state.aiSuggestions.filter((item) => {
      if (deleteIds.has(item.bookmarkId)) return false;
      if (scope === 'ai' && (item.status === 'accepted' || item.status === 'deleted')) return false;
      return true;
    });

    state.healthResults = state.healthResults.filter((item) => !deleteIds.has(item.bookmarkId));

    state.duplicateGroups = state.duplicateGroups
      .map((group) => {
        const items = group.items.filter((item) => !deleteIds.has(item.bookmarkId));
        const keepStillExists = items.some((item) => item.bookmarkId === group.keepId);
        return {
          ...group,
          keepId: keepStillExists ? group.keepId : items[0]?.bookmarkId,
          items,
        };
      })
      .filter((group) => group.items.length > 1);

    await patchMeta({
      duplicate: {
        groups: state.duplicateGroups.length,
        items: state.duplicateGroups.reduce((sum, group) => sum + group.items.length, 0),
      },
    });

    await refreshBookmarks();
    renderSuggestionsWorkspace();
    renderHealthResults();
    renderDuplicateGroups();
    refreshGovernanceState();
    showToast(`已应用${scoped.label}：更新 ${moved} 条分类，删除 ${deleted} 条书签`, 'success', 3200);
  } catch (error) {
    showToast(`应用失败：${error.message}`, 'error');
  } finally {
    applyButton.disabled = false;
    applyButton.textContent = scoped.applyIdleText;
  }
}

function wireSuggestionToolbar() {
  // select/checkbox 用 change，文本搜索框用 input（实时响应键入）
  ['#filter-checked-only', '#suggestion-category-filter', '#suggestion-group-mode'].forEach((selector) => {
    $(selector).addEventListener('change', () => renderSuggestionsWorkspace());
  });
  $('#suggestion-search').addEventListener('input', () => renderSuggestionsWorkspace());

  $('#btn-select-visible').addEventListener('click', () => {
    getVisibleSuggestions().forEach((item) => {
      if (item.status !== 'deleted') item.status = 'accepted';
    });
    renderSuggestionsWorkspace();
  });

  $('#btn-clear-visible').addEventListener('click', () => {
    getVisibleSuggestions().forEach((item) => {
      if (item.status === 'accepted') item.status = 'pending';
    });
    renderSuggestionsWorkspace();
  });

  $('#btn-accept-cat').addEventListener('click', () => {
    if (!state.currentSuggestionGroup) return;
    const mode = $('#suggestion-group-mode').value;
    state.aiSuggestions.forEach((item) => {
      if (getSuggestionGroupKey(item, mode) === state.currentSuggestionGroup && item.status !== 'deleted') {
        item.status = 'accepted';
      }
    });
    renderSuggestionsWorkspace();
  });

  $('#btn-reject-cat').addEventListener('click', () => {
    if (!state.currentSuggestionGroup) return;
    const mode = $('#suggestion-group-mode').value;
    state.aiSuggestions.forEach((item) => {
      if (getSuggestionGroupKey(item, mode) === state.currentSuggestionGroup && item.status === 'accepted') {
        item.status = 'pending';
      }
    });
    renderSuggestionsWorkspace();
  });

  $('#btn-delete-selected').addEventListener('click', () => {
    if (!state.currentSuggestionGroup) return;
    const mode = $('#suggestion-group-mode').value;
    state.aiSuggestions.forEach((item) => {
      if (getSuggestionGroupKey(item, mode) === state.currentSuggestionGroup) {
        item.status = 'deleted';
      }
    });
    renderSuggestionsWorkspace();
  });
}

function wireRuleEvents() {
  $('#ai-rule-input').addEventListener('input', renderRulePreview);
  $('#btn-apply-ai-rule').addEventListener('click', handleApplyRule);
  $$('.example-chip').forEach((button) => {
    button.addEventListener('click', () => {
      $('#ai-rule-input').value = button.dataset.ruleExample || '';
      renderRulePreview();
    });
  });
  $('#btn-cancel-ai').addEventListener('click', () => {
    state.aiSuggestions = [];
    $('#ai-rule-input').value = '';
    $('#ai-suggestions').classList.add('hidden');
    $('#ai-progress-box').classList.add('hidden');
    renderRulePreview();
    refreshGovernanceState();
    showToast('已清空本次 AI 分析结果');
  });
}

function wireHealthEvents() {
  $('#btn-run-health-check').addEventListener('click', handleHealthCheck);
  $('#health-filter').addEventListener('change', renderHealthResults);
  $('#health-category-filter').addEventListener('change', renderHealthResults);
}

function wireDuplicateEvents() {
  $('#btn-run-duplicate-check').addEventListener('click', handleDuplicateCheck);
  $('#duplicate-filter').addEventListener('change', renderDuplicateGroups);
  $('#duplicate-category-filter').addEventListener('change', renderDuplicateGroups);
  $('#btn-apply-default-duplicate-strategy').addEventListener('click', () => {
    state.duplicateGroups.forEach((group) => applyDuplicateStrategy(group, 'recommended'));
    renderDuplicateGroups();
  });
  $('#btn-expand-duplicates').addEventListener('click', () => {
    document.getElementById('duplicate-cleanup-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function wireGovernanceActionEvents() {
  $('#btn-clear-ai-actions').addEventListener('click', () => clearQueuedActions('ai'));
  $('#btn-apply-ai-actions').addEventListener('click', () => applyQueuedActions('ai'));
  $('#btn-clear-health-actions').addEventListener('click', () => clearQueuedActions('health'));
  $('#btn-apply-health-actions').addEventListener('click', () => applyQueuedActions('health'));
  $('#btn-clear-duplicate-actions').addEventListener('click', () => clearQueuedActions('duplicate'));
  $('#btn-apply-duplicate-actions').addEventListener('click', () => applyQueuedActions('duplicate'));
}

function wireSyncAndAIEvents() {
  $('#btn-test-sync').addEventListener('click', handleSyncTest);
  $('#btn-save-sync').addEventListener('click', handleSyncSave);
  $('#btn-sync-upload-full').addEventListener('click', handleSyncUpload);
  $('#btn-sync-download-full').addEventListener('click', handleSyncDownload);
  $('#btn-load-sync-versions').addEventListener('click', handleLoadSyncVersions);
  $('#btn-test-ai').addEventListener('click', handleAITest);
  $('#btn-save-ai').addEventListener('click', handleAISave);
  $('#btn-ai-classify').addEventListener('click', handleAIClassify);

  [
    '#gitlab-url',
    '#gitlab-project',
    '#gitlab-token',
    '#github-owner',
    '#github-repo',
    '#github-token',
    '#sync-branch',
    '#sync-filepath',
  ].forEach((selector) => {
    const element = $(selector);
    element?.addEventListener('input', updateSyncStatusUI);
    element?.addEventListener('change', updateSyncStatusUI);
  });

  [
    '#deepseek-key',
    '#deepseek-model',
    '#minimax-key',
    '#minimax-group',
    '#minimax-model',
  ].forEach((selector) => {
    const element = $(selector);
    element?.addEventListener('input', updateAIStatusUI);
    element?.addEventListener('change', updateAIStatusUI);
  });
}

async function init() {
  initTheme();
  initThemeEvents();
  initSections();
  initVisibilityToggles();
  initRadioHandlers();
  initNavigation();
  initManagementTabs();
  await loadMeta();
  await fillConfigsFromStorage();
  await refreshBookmarks();
  updateSyncStatusUI();
  updateAIStatusUI();
  renderRulePreview();
  renderSyncVersions();
  renderHealthResults();
  renderDuplicateGroups();
  refreshGovernanceState();
  wireSyncAndAIEvents();
  wireSuggestionToolbar();
  wireRuleEvents();
  wireHealthEvents();
  wireDuplicateEvents();
  wireGovernanceActionEvents();
}

init().catch((error) => {
  console.error(error);
  showToast(`页面初始化失败：${error.message}`, 'error', 4000);
});

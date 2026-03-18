/**
 * Options page logic – handles configuration save/load/test for Sync and AI.
 */

import { BookmarkManager } from '../lib/bookmark-manager.js';
import { AIEngine } from '../lib/ai/ai-engine.js';

// ─── Helpers ───
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }


async function sendMessage(action, payload = {}) {
  return chrome.runtime.sendMessage({ action, payload });
}

function showToast(text, type = 'info', duration = 2500) {
  const el = $('#toast');
  el.textContent = text;
  el.className = `toast show ${type}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), duration);
}

function showResult(id, text, type) {
  const el = $(`#${id}`);
  el.textContent = text;
  el.className = `opt-result ${type}`;
}

// ─── Platform Radio Toggle ───
$$('input[name="platform"]').forEach(radio => {
  radio.addEventListener('change', () => {
    $('#gitlab-fields').classList.toggle('hidden', radio.value !== 'gitlab');
    $('#github-fields').classList.toggle('hidden', radio.value !== 'github');
    $('#common-fields').classList.remove('hidden');
  });
});

// ─── AI Provider Radio Toggle ───
$$('input[name="ai-provider"]').forEach(radio => {
  radio.addEventListener('change', () => {
    $('#deepseek-fields').classList.toggle('hidden', radio.value !== 'deepseek');
    $('#minimax-fields').classList.toggle('hidden', radio.value !== 'minimax');
    $('#ai-common-fields').classList.remove('hidden');
  });
});

// ─── Sync: Collect Config ───
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
  } else {
    return {
      ...base,
      token: $('#github-token').value.trim(),
      owner: $('#github-owner').value.trim(),
      repo: $('#github-repo').value.trim(),
    };
  }
}

// ─── Sync: Test Connection ───
$('#btn-test-sync').addEventListener('click', async () => {
  const config = collectSyncConfig();
  if (!config) {
    showToast('请先选择平台并填写配置', 'error');
    return;
  }

  const btn = $('#btn-test-sync');
  btn.disabled = true;
  btn.textContent = '测试中...';

  // Save temporarily to test
  await sendMessage('saveSyncConfig', config);
  const result = await sendMessage('testSync');

  if (result.success) {
    showResult('sync-test-result', `✅ ${result.message}`, 'success');
  } else {
    if (result.code === 404) {
      if (confirm(`检测到该仓库不存在 (404)。是否授权插件使用您的 Token 自动创建一个 Private（私有）仓并初始化？`)) {
        const createRes = await sendMessage('createSyncRepo');
        if (createRes.success) {
          showToast('仓库创建成功！重新测试连接中...');
          btn.disabled = false;
          $('#btn-test-sync').click();
          return;
        } else {
          showResult('sync-test-result', `❌ 自动创建仓库失败: ${createRes.message}`, 'error');
          btn.disabled = false;
          btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>测试连接`;
          return;
        }
      }
    }
    showResult('sync-test-result', `❌ ${result.message}`, 'error');
  }


  btn.disabled = false;
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>测试连接`;
});

// ─── Sync: Save Config ───
$('#btn-save-sync').addEventListener('click', async () => {
  const config = collectSyncConfig();
  if (!config) {
    showToast('请先选择平台并填写配置', 'error');
    return;
  }

  await sendMessage('saveSyncConfig', config);
  showToast('同步配置已保存！', 'success');
});

// ─── AI: Collect Config ───
function collectAIConfig() {
  const provider = document.querySelector('input[name="ai-provider"]:checked')?.value;
  if (!provider) return null;

  if (provider === 'deepseek') {
    return {
      provider,
      apiKey: $('#deepseek-key').value.trim(),
      model: $('#deepseek-model').value,
    };
  } else {
    return {
      provider,
      apiKey: $('#minimax-key').value.trim(),
      groupId: $('#minimax-group').value.trim(),
      model: $('#minimax-model').value,
    };
  }
}

// ─── AI: Test Connection ───
$('#btn-test-ai').addEventListener('click', async () => {
  const config = collectAIConfig();
  if (!config) {
    showToast('请先选择 AI 提供商并填写配置', 'error');
    return;
  }

  const btn = $('#btn-test-ai');
  btn.disabled = true;
  btn.textContent = '测试中...';

  // Save temporarily to test
  await sendMessage('saveAIConfig', config);
  const result = await sendMessage('testAI');

  if (result.success) {
    showResult('ai-test-result', `✅ ${result.message}`, 'success');
  } else {
    showResult('ai-test-result', `❌ ${result.message}`, 'error');
  }

  btn.disabled = false;
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>测试连接`;
});

// ─── AI: Save Config ───
$('#btn-save-ai').addEventListener('click', async () => {
  const config = collectAIConfig();
  if (!config) {
    showToast('请先选择 AI 提供商并填写配置', 'error');
    return;
  }

  await sendMessage('saveAIConfig', config);
  showToast('AI 配置已保存！', 'success');
});

// ─── Theme Management ───
function initTheme() {
  let theme = localStorage.getItem('theme');
  if (!theme) {
    // 自动跟从系统
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    theme = prefersDark ? 'dark' : 'light';
  }
  
  document.body.className = theme === 'light' ? 'light-mode' : '';
  const icon = $('#btn-theme-toggle .theme-icon');
  if (icon) icon.textContent = theme === 'light' ? '☀️' : '🌙';
}

// 监听系统主题变化（只有在没有手动指定时才生效）
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!localStorage.getItem('theme')) {
    document.body.className = e.matches ? '' : 'light-mode';
    const icon = $('#btn-theme-toggle .theme-icon');
    if (icon) icon.textContent = e.matches ? '🌙' : '☀️';
  }
});

$('#btn-theme-toggle').addEventListener('click', () => {
  const current = localStorage.getItem('theme');
  let next = 'light'; // 默认
  
  if (current) {
    next = current === 'dark' ? 'light' : 'dark';
  } else {
    // 如果之前是系统自动，点击则取反
    const isDarkNow = !document.body.classList.contains('light-mode');
    next = isDarkNow ? 'light' : 'dark';
  }

  localStorage.setItem('theme', next);
  initTheme();
});


// ─── AI Classification (With Dynamic Progress) ───
let aiSuggestions = [];

async function updateAIPanelStatus() {
  const config = collectAIConfig();
  const btn = $('#btn-ai-classify');
  if (config && config.apiKey) {
    btn.disabled = false;
  } else {
    btn.disabled = true;
  }
}

$('#btn-ai-classify').addEventListener('click', async () => {
  const btn = $('#btn-ai-classify');
  const progressBox = $('#ai-progress-box');
  const progressBar = $('#ai-progress-bar');
  const progressText = $('#ai-progress-text');
  
  btn.disabled = true;
  progressBox.classList.remove('hidden');
  $('#ai-suggestions').classList.add('hidden');
  progressBar.style.width = '0%';
  progressText.textContent = '准备分析书签：0%';

  try {
    const bookmarks = await BookmarkManager.getAllBookmarks();
    const exportData = await BookmarkManager.exportToSyncFormat();
    const categories = exportData.categories.map((c) => c.name);

    if (!bookmarks || bookmarks.length === 0) {
      throw new Error('未检测到任何书签');
    }

    aiSuggestions = [];
    const BATCH_SIZE = 30; // 扩大单批次容量
    const CONCURRENCY = 4; // 并发请求数 (4路齐发)
    const provider = await AIEngine.getProvider();

    const batches = [];
    for (let i = 0; i < bookmarks.length; i += BATCH_SIZE) {
      batches.push(bookmarks.slice(i, i + BATCH_SIZE));
    }

    // 分组执行并发，避免因一次请求太多触发 API 频率限制 (429)
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const currentChunk = batches.slice(i, i + CONCURRENCY);
      const batchPercent = Math.round((i / batches.length) * 100);
      progressText.textContent = `并发分析中... (进度 ${batchPercent}%)`;
      progressBar.style.width = `${batchPercent}%`;

      // 4路齐发
      await Promise.all(currentChunk.map(async (batch) => {
        try {
          const res = await provider._classifyBatch(batch, categories);
          if (res && Array.isArray(res)) {
            aiSuggestions.push(...res);
          }
        } catch (err) {
          console.error('Batch failed:', err);
        }
      }));
    }

    progressBar.style.width = '100%';
    progressText.textContent = '分析完成：100%';


    if (aiSuggestions.length === 0) {
      showToast('AI 没有给出任何移动分类的建议', 'info');
    } else {
      aiSuggestions = aiSuggestions.map(s => ({ ...s, status: 'pending' }));
      renderSuggestions();
      $('#ai-suggestions').classList.remove('hidden');
      showToast(`AI 生成了 ${aiSuggestions.length} 条分类建议`, 'success');
    }

  } catch (err) {
    showToast(`AI 分类失败: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    setTimeout(() => {
        progressBox.classList.add('hidden');
    }, 1500);
  }
});

function renderSuggestions() {
  const list = $('#suggestions-list');
  list.innerHTML = '';

  aiSuggestions.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = `suggestion-card ${s.status === 'accepted' ? 'selected' : ''} ${s.status === 'rejected' ? 'rejected' : ''}`;
    card.innerHTML = `
      <div class="sug-header">
        <div class="sug-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</div>
      </div>
      <div class="sug-change">
        <span class="sug-old">${escapeHtml(s.currentCategory || '暂无')}</span>
        <span>→</span>
        <span class="sug-new">${escapeHtml(s.suggestedCategory)}</span>
      </div>
      ${s.reason ? `<div class="sug-reason">${escapeHtml(s.reason)}</div>` : ''}
      <div class="sug-op">
        <button class="sug-mini-btn accept" data-index="${i}">接受</button>
        <button class="sug-mini-btn reject" data-index="${i}">拒绝</button>
      </div>
    `;
    list.appendChild(card);
  });

  // Bind Buttons
  list.querySelectorAll('.sug-mini-btn.accept').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.index;
      aiSuggestions[idx].status = aiSuggestions[idx].status === 'accepted' ? 'pending' : 'accepted';
      renderSuggestions();
    });
  });

  list.querySelectorAll('.sug-mini-btn.reject').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.index;
      aiSuggestions[idx].status = aiSuggestions[idx].status === 'rejected' ? 'pending' : 'rejected';
      renderSuggestions();
    });
  });
}

$('#btn-accept-all').addEventListener('click', () => {
  aiSuggestions.forEach(s => s.status = 'accepted');
  renderSuggestions();
});

$('#btn-reject-all').addEventListener('click', () => {
  aiSuggestions.forEach(s => s.status = 'rejected');
  renderSuggestions();
});

$('#btn-apply-selected').addEventListener('click', async () => {
  const accepted = aiSuggestions.filter(s => s.status === 'accepted');
  if (accepted.length === 0) {
    showToast('请先选择要应用的建议（点击“接受”）', 'info');
    return;
  }

  const btn = $('#btn-apply-selected');
  btn.disabled = true;
  btn.textContent = '应用中...';

  let successCount = 0;
  for (const s of accepted) {
    try {
      const folderId = await BookmarkManager.ensureFolderPath(s.suggestedCategory);
      await BookmarkManager.move(s.bookmarkId, folderId);
      successCount++;
    } catch { /* skip err */ }
  }

  showToast(`成功应用 ${successCount} 条建议`);
  btn.disabled = false;
  btn.textContent = '应用已选建议';
  $('#ai-suggestions').classList.add('hidden');
  aiSuggestions = [];
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Load Existing Config on Init ───
(async function init() {
  initTheme();
  // Load sync config
  const syncConfig = await sendMessage('getSyncConfig');
  if (syncConfig && syncConfig.platform) {
    const radio = document.querySelector(`input[name="platform"][value="${syncConfig.platform}"]`);
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change'));
    }

    if (syncConfig.platform === 'gitlab') {
      $('#gitlab-url').value = syncConfig.gitlabUrl || 'https://gitlab.com';
      $('#gitlab-token').value = syncConfig.token || '';
      $('#gitlab-project').value = syncConfig.projectId || '';
    } else {
      $('#github-token').value = syncConfig.token || '';
      $('#github-owner').value = syncConfig.owner || '';
      $('#github-repo').value = syncConfig.repo || '';
    }

    $('#sync-branch').value = syncConfig.branch || 'main';
    $('#sync-filepath').value = syncConfig.filePath || 'bookmarks.json';
  }

  // Load AI config
  const aiConfig = await sendMessage('getAIConfig');
  if (aiConfig && aiConfig.provider) {
    const radio = document.querySelector(`input[name="ai-provider"][value="${aiConfig.provider}"]`);
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change'));
    }

    if (aiConfig.provider === 'deepseek') {
      $('#deepseek-key').value = aiConfig.apiKey || '';
      $('#deepseek-model').value = aiConfig.model || 'deepseek-chat';
    } else {
      $('#minimax-key').value = aiConfig.apiKey || '';
      $('#minimax-group').value = aiConfig.groupId || '';
      $('#minimax-model').value = aiConfig.model || 'MiniMax-Text-01';
    }
    
    updateAIPanelStatus();
  }
})();


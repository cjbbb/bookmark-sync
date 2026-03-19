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

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
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

function showSyncOperationResult(text, type) {
  const targetId = $('#sync-ops-result') ? 'sync-ops-result' : 'sync-test-result';
  showResult(targetId, text, type);
}

function formatTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN');
}

function initCollapsibleSections() {
  $$('.opt-section[data-collapsible="true"] .section-toggle').forEach((toggle) => {
    const section = toggle.closest('.opt-section');
    if (!section) return;

    const switchState = () => {
      const willCollapse = !section.classList.contains('collapsed');
      section.classList.toggle('collapsed', willCollapse);
      toggle.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
    };

    toggle.addEventListener('click', switchState);
    toggle.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      switchState();
    });
  });
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
    updateAIPanelStatus();
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
      showResult('sync-test-result', '❌ 远端仓库/项目不存在，请先在对应平台手动创建后再测试连接。', 'error');
    } else {
      showResult('sync-test-result', `❌ ${result.message}`, 'error');
    }
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

$('#btn-sync-upload-full').addEventListener('click', async () => {
  const config = collectSyncConfig();
  if (!config) {
    showToast('请先选择平台并填写同步配置', 'error');
    return;
  }

  const btn = $('#btn-sync-upload-full');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '上传中...';

  try {
    await sendMessage('saveSyncConfig', config);
    const result = await sendMessage('syncUpload');
    if (result?.error) {
      throw new Error(result.error);
    }
    showToast('上传完成，远端已全部替换为本地书签', 'success', 3200);
    showSyncOperationResult('✅ 上传成功：远端已全部替换。', 'success');
  } catch (err) {
    showToast(`上传失败: ${err.message}`, 'error', 3500);
    showSyncOperationResult(`❌ 上传失败: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

$('#btn-sync-download-full').addEventListener('click', async () => {
  const config = collectSyncConfig();
  if (!config) {
    showToast('请先选择平台并填写同步配置', 'error');
    return;
  }

  const ok = confirm('该操作会用远端版本将本地书签全部替换（会删除本地多余项），是否继续？');
  if (!ok) return;

  const btn = $('#btn-sync-download-full');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '下载中...';

  try {
    await sendMessage('saveSyncConfig', config);
    const result = await sendMessage('syncDownload');
    if (result?.error) {
      throw new Error(result.error);
    }
    const moved = result?.moved || 0;
    const updated = result?.updated || 0;
    const added = result?.added || 0;
    const removed = result?.removed || 0;
    showToast(`全部替换完成：移动 ${moved}，更新 ${updated}，新增 ${added}，删除 ${removed}`, 'success', 3500);
    showSyncOperationResult('✅ 下载成功：本地已按远端全部替换。', 'success');
  } catch (err) {
    showToast(`下载失败: ${err.message}`, 'error', 3500);
    showSyncOperationResult(`❌ 下载失败: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

// ─── Sync: Version History & Restore ───
let syncVersions = [];

function renderSyncVersions() {
  const box = $('#sync-versions-box');
  const list = $('#sync-versions-list');
  const count = $('#sync-versions-count');

  list.innerHTML = '';

  if (!syncVersions || syncVersions.length === 0) {
    box.classList.remove('hidden');
    count.textContent = '0 条';
    list.innerHTML = '<div class="form-hint">未找到版本历史，请先执行一次上传。</div>';
    return;
  }

  count.textContent = `${syncVersions.length} 条`;
  box.classList.remove('hidden');

  syncVersions.forEach((v) => {
    const item = document.createElement('div');
    item.className = 'sync-version-item';
    item.innerHTML = `
      <div class="sync-version-top">
        <span class="sync-version-id">${escapeHtml(v.shortId || (v.id || '').slice(0, 7))}</span>
      </div>
      <div class="sync-version-meta">${escapeHtml(v.author || '未知作者')} · ${escapeHtml(formatTime(v.date))}</div>
      <div class="sync-version-message">${escapeHtml(v.message || '无提交信息')}</div>
      <button class="opt-btn secondary sync-version-restore" data-version-id="${escapeHtml(v.id)}">恢复到此版本</button>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('.sync-version-restore').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const versionId = btn.dataset.versionId;
      if (!versionId) return;

      const ok = confirm('恢复后将用所选历史版本把当前本地书签全部替换（会删除不在该版本中的书签）。是否继续？');
      if (!ok) return;

      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '恢复中...';

      try {
        const result = await sendMessage('restoreSyncVersion', { versionId });
        if (result?.error) {
          throw new Error(result.error);
        }

        const moved = result.moved || 0;
        const updated = result.updated || 0;
        const added = result.added || 0;
        const removed = result.removed || 0;
        showToast(`恢复完成：移动 ${moved}，更新 ${updated}，新增 ${added}，删除 ${removed}`, 'success', 3500);
        showSyncOperationResult('✅ 已按所选历史版本全部替换本地。', 'success');
      } catch (err) {
        showToast(`恢复失败: ${err.message}`, 'error', 3500);
        showSyncOperationResult(`❌ 恢复失败: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });
}

$('#btn-load-sync-versions').addEventListener('click', async () => {
  const config = collectSyncConfig();
  if (!config) {
    showToast('请先选择平台并填写同步配置', 'error');
    return;
  }

  const btn = $('#btn-load-sync-versions');
  btn.disabled = true;
  btn.textContent = '加载中...';

  try {
    await sendMessage('saveSyncConfig', config);
    const versions = await sendMessage('getSyncVersions', { limit: 20 });
    if (versions?.error) {
      throw new Error(versions.error);
    }

    syncVersions = Array.isArray(versions) ? versions : [];
    renderSyncVersions();
    showToast(`已加载 ${syncVersions.length} 条版本历史`, 'success');
  } catch (err) {
    showToast(`加载历史失败: ${err.message}`, 'error');
    showSyncOperationResult(`❌ 加载历史记录失败: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-9"/></svg>查看版本历史`;
  }
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
let aiBookmarkIndex = new Map();

function enterAISubView() {
  $('#ai-main-view')?.classList.add('hidden');
  $('#ai-sub-view')?.classList.remove('hidden');
  $('.opt-left')?.classList.add('hidden');
  $('.dashboard-grid')?.classList.add('ai-focus');
}

function returnToMainView() {
  $('#ai-main-view')?.classList.remove('hidden');
  $('#ai-sub-view')?.classList.add('hidden');
  $('.opt-left')?.classList.remove('hidden');
  $('.dashboard-grid')?.classList.remove('ai-focus');
  $('#ai-suggestions')?.classList.add('hidden');
  $('#ai-progress-box')?.classList.add('hidden');
}

function setAIProgress(percent, text, indeterminate = false) {
  const bar = $('#ai-progress-bar');
  const label = $('#ai-progress-text');
  if (!bar || !label) return;
  if (indeterminate) {
    bar.classList.add('indeterminate');
  } else {
    bar.classList.remove('indeterminate');
    bar.style.width = `${percent}%`;
  }
  label.textContent = text;
}

$('#btn-enter-ai-analysis').addEventListener('click', () => {
  enterAISubView();
});

$('#btn-back-main').addEventListener('click', () => {
  returnToMainView();
});

async function updateAIPanelStatus() {
  const config = collectAIConfig();
  const btn = $('#btn-ai-classify');
  const enterBtn = $('#btn-enter-ai-analysis');
  const ready = Boolean(config && config.apiKey);
  if (btn) btn.disabled = !ready;
  if (enterBtn) enterBtn.disabled = !ready;
}

['#deepseek-key', '#minimax-key', '#deepseek-model', '#minimax-model', '#minimax-group'].forEach((sel) => {
  const el = $(sel);
  if (!el) return;
  el.addEventListener('input', () => updateAIPanelStatus());
  el.addEventListener('change', () => updateAIPanelStatus());
});

$('#btn-ai-classify').addEventListener('click', async () => {
  const btn = $('#btn-ai-classify');
  const progressBox = $('#ai-progress-box');

  btn.disabled = true;
  progressBox.classList.remove('hidden');
  $('#ai-suggestions').classList.add('hidden');
  setAIProgress(0, '准备分析书签：0%');

  try {
    setAIProgress(5, '正在准备分析环境...', true);
    await nextFrame();

    setAIProgress(10, '正在读取本地书签...', true);
    const bookmarks = await BookmarkManager.getAllBookmarks();

    setAIProgress(18, '正在整理分类上下文...', true);
    const exportData = await BookmarkManager.exportToSyncFormat();
    const categories = exportData.categories.map((c) => c.name);
    const allPaths = [...new Set(bookmarks.map(b => b.category).filter(Boolean))];
    aiBookmarkIndex = new Map(bookmarks.map((b) => [String(b.id), b]));

    if (!bookmarks || bookmarks.length === 0) {
      throw new Error('未检测到任何书签');
    }

    aiSuggestions = [];
    const BATCH_SIZE = 50;
    const CONCURRENCY = 6;
    const provider = await AIEngine.getProvider();

    const batches = [];
    for (let i = 0; i < bookmarks.length; i += BATCH_SIZE) {
      batches.push(bookmarks.slice(i, i + BATCH_SIZE));
    }

    let totalProcessed = 0;
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const currentChunk = batches.slice(i, i + CONCURRENCY);

      await Promise.all(currentChunk.map(async (batch) => {
        try {
          const res = await provider._classifyBatch(batch, { names: categories, _allPaths: allPaths });
          if (res && Array.isArray(res)) {
            aiSuggestions.push(...res);
          }
        } catch (err) {
          console.error('Batch failed:', err);
        }
      }));

      totalProcessed += currentChunk.reduce((sum, b) => sum + b.length, 0);
      const analysisPercent = 20 + Math.round((totalProcessed / bookmarks.length) * 75);
      setAIProgress(analysisPercent, `正在分析书签：${analysisPercent}%`);
    }

    setAIProgress(100, '分析完成：100%');


    if (aiSuggestions.length === 0) {
      showToast('AI 没有给出任何移动分类的建议', 'info');
    } else {
      aiSuggestions = aiSuggestions.map((s) => {
        const local = aiBookmarkIndex.get(String(s.bookmarkId));
        return {
          ...s,
          title: s.title || local?.title || '未命名书签',
          url: local?.url || '',
          status: 'pending',
        };
      });
      renderSuggestions();
      $('#ai-suggestions').classList.remove('hidden');
      showToast(`AI 生成了 ${aiSuggestions.length} 条分类建议`, 'success');
    }

  } catch (err) {
    showToast(`AI 分类失败: ${err.message}`, 'error');
  } finally {
    $('#ai-progress-bar')?.classList.remove('indeterminate');
    btn.disabled = false;
    setTimeout(() => {
      progressBox.classList.add('hidden');
    }, 1500);
  }
});

let groupedSuggestions = {};
let currentCategory = null;

function refreshSuggestionsView(preferredCategory = currentCategory) {
  groupedSuggestions = groupSuggestionsByCategory();
  const cats = Object.keys(groupedSuggestions);
  if (cats.length === 0) {
    currentCategory = null;
    renderCategoryTabs();
    renderCurrentCategorySuggestions();
    return;
  }

  currentCategory = preferredCategory && groupedSuggestions[preferredCategory]
    ? preferredCategory
    : cats[0];

  renderCategoryTabs();
  renderCurrentCategorySuggestions();
}

function groupSuggestionsByCategory() {
  const groups = {};
  aiSuggestions.forEach((s, i) => {
    if (s.status === 'deleted') return;
    const cat = s.suggestedCategory || '未分类';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push({ ...s, _index: i });
  });
  const sorted = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
  const result = {};
  sorted.forEach(k => { result[k] = groups[k]; });
  return result;
}

function renderCategoryTabs() {
  const tabsContainer = $('#category-tabs');
  tabsContainer.innerHTML = '';
  const cats = Object.keys(groupedSuggestions);

  cats.forEach(cat => {
    const tab = document.createElement('button');
    tab.className = `cat-tab${cat === currentCategory ? ' active' : ''}`;
    tab.dataset.cat = cat;
    const count = groupedSuggestions[cat].length;
    tab.innerHTML = `<span>${escapeHtml(cat)}</span><span class="cat-count">${count}</span>`;
    tabsContainer.appendChild(tab);

    tab.addEventListener('click', () => {
      currentCategory = cat;
      renderCategoryTabs();
      renderCurrentCategorySuggestions();
    });
  });
}

function renderCurrentCategorySuggestions() {
  const list = $('#suggestions-list');
  const actionBar = $('#category-action-bar');
  list.innerHTML = '';

  if (!currentCategory || !groupedSuggestions[currentCategory]) return;

  const items = groupedSuggestions[currentCategory];
  const acceptedCount = items.filter(s => s.status === 'accepted').length;
  const deletedCount = items.filter(s => s.status === 'deleted').length;

  actionBar.classList.remove('hidden');
  let hintText = `${acceptedCount} / ${items.length} 条已选`;
  if (deletedCount > 0) hintText += `，${deletedCount} 条待删除`;
  $('#category-action-hint').textContent = hintText;

  items.forEach(s => {
    const card = document.createElement('div');
    card.className = `suggestion-list-item${s.status === 'accepted' ? ' accepted' : ''}${s.status === 'deleted' ? ' deleted' : ''}`;
    card.innerHTML = `
      <div class="sug-checkbox-wrap">
        <input type="checkbox" class="sug-check" data-orig-index="${s._index}" ${s.status === 'accepted' ? 'checked' : ''}>
      </div>
      <div class="sug-content">
        <div class="sug-title" title="${escapeHtml(s.title)}">
          ${s.url ? `<a class="sug-title-link" href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a>` : escapeHtml(s.title)}
        </div>
        <div class="sug-path">
          <span>${escapeHtml(s.currentCategory || '暂无分类')}</span>
          <span style="opacity:0.5; margin:0 8px;">→</span>
          <span class="sug-new-path">${escapeHtml(s.suggestedCategory)}</span>
          ${s.reason ? `<span class="sug-reason-badge" title="${escapeHtml(s.reason)}">有建议理由</span>` : ''}
        </div>
      </div>
      <button class="sug-delete-btn" data-orig-index="${s._index}" title="删除此书签">✕</button>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('.sug-check').forEach(chk => {
    chk.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.origIndex, 10);
      if (Number.isNaN(idx) || !aiSuggestions[idx]) return;
      aiSuggestions[idx].status = e.target.checked ? 'accepted' : 'pending';
      refreshSuggestionsView(currentCategory);
    });
  });

  list.querySelectorAll('.sug-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = parseInt(btn.dataset.origIndex, 10);
      if (Number.isNaN(idx) || !aiSuggestions[idx]) return;
      aiSuggestions[idx].status = 'deleted';
      renderSuggestions();
    });
  });
}

function renderSuggestions() {
  refreshSuggestionsView();
}

$('#btn-accept-cat').addEventListener('click', () => {
  if (!currentCategory || !groupedSuggestions[currentCategory]) return;
  groupedSuggestions[currentCategory].forEach(s => {
    aiSuggestions[s._index].status = 'accepted';
  });
  refreshSuggestionsView(currentCategory);
});

$('#btn-reject-cat').addEventListener('click', () => {
  if (!currentCategory || !groupedSuggestions[currentCategory]) return;
  groupedSuggestions[currentCategory].forEach(s => {
    aiSuggestions[s._index].status = 'pending';
  });
  refreshSuggestionsView(currentCategory);
});

$('#btn-delete-selected').addEventListener('click', () => {
  if (!currentCategory || !groupedSuggestions[currentCategory]) return;
  groupedSuggestions[currentCategory].forEach((s) => {
    aiSuggestions[s._index].status = 'deleted';
  });
  refreshSuggestionsView(currentCategory);
});

function normalizeCategoryName(text) {
  return (text || '')
    .trim()
    .replace(/^把|^将/, '')
    .replace(/收藏夹$|文件夹$/, '')
    .trim();
}

function buildCategoryCandidates() {
  const set = new Set();
  for (const s of aiSuggestions) {
    if (!s || s.status === 'deleted') continue;
    if (s.suggestedCategory) set.add(s.suggestedCategory);
    if (s.currentCategory) set.add(s.currentCategory);
  }
  return Array.from(set);
}

function resolveCategoryName(rawName, candidates) {
  const normalized = normalizeCategoryName(rawName);
  if (!normalized) return '';

  const exact = candidates.find((c) => normalizeCategoryName(c) === normalized);
  if (exact) return exact;

  const contains = candidates.find((c) => normalizeCategoryName(c).includes(normalized));
  if (contains) return contains;

  const reverseContains = candidates.find((c) => normalized.includes(normalizeCategoryName(c)));
  if (reverseContains) return reverseContains;

  return normalized;
}

function replaceSuggestionCategory(sourceCategory, targetCategory) {
  let changed = 0;
  for (const s of aiSuggestions) {
    if (s.status === 'deleted') continue;
    const current = s.suggestedCategory || '';
    if (current === sourceCategory || current.startsWith(`${sourceCategory}/`)) {
      s.suggestedCategory = current.replace(sourceCategory, targetCategory);
      if (s.status === 'pending') {
        s.status = 'accepted';
      }
      changed++;
    }
  }
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
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCategoryList(raw) {
  return (raw || '')
    .split(/(?:和|与|及|跟|、|,|，|\/)/)
    .map((s) => normalizeCategoryName(s))
    .filter(Boolean);
}

function parseSingleRuleAction(actionText) {
  const text = normalizeInstructionText(actionText);
  if (!text) return null;

  // 例：除工作外都并入学习
  let m = text.match(/^(?:把|将)?\s*除\s*(.+?)\s*外(?:都|全部)?\s*(?:并入|归入|归到|归为|统归到|统归为|合并到|合并为|放入|移动到)\s*(.+)$/i);
  if (m) {
    return {
      type: 'move_all_except',
      excludes: parseCategoryList(m[1]),
      target: normalizeCategoryName(m[2]),
    };
  }

  // 例：把A和B合并为C / A、B、C都为D / A 归为 D
  m = text.match(/^(?:把|将)?\s*(.+?)\s*(?:合并(?:到|为)?|并为|都为|归为|归到|统归到|统归为|统一到)\s*(.+)$/i);
  if (m) {
    const sources = parseCategoryList(m[1]);
    if (sources.length >= 1) {
      return {
        type: 'merge',
        sources,
        target: normalizeCategoryName(m[2]),
      };
    }
  }

  // 例：把A并入B / 把A、B归入C
  m = text.match(/^(?:把|将)?\s*(.+?)\s*(?:并入|归入|迁入|放入|移动到)\s*(.+)$/i);
  if (m) {
    const sources = parseCategoryList(m[1]);
    if (sources.length >= 1) {
      return {
        type: 'move',
        sources,
        target: normalizeCategoryName(m[2]),
      };
    }
  }

  // 例：把A改为B / 把A重命名为B
  m = text.match(/^(?:把|将)?\s*(.+?)\s*(?:改为|改成|改名为|重命名为|命名为|叫做)\s*(.+)$/i);
  if (m) {
    return {
      type: 'rename',
      source: normalizeCategoryName(m[1]),
      target: normalizeCategoryName(m[2]),
    };
  }

  return null;
}

function replaceAllExceptToTarget(excludedSources, targetCategory, categoryCandidates) {
  const resolvedExcludes = (excludedSources || [])
    .map((name) => resolveCategoryName(name, categoryCandidates))
    .filter(Boolean);
  const excludeSet = new Set(resolvedExcludes);
  const target = resolveCategoryName(targetCategory, categoryCandidates);
  let changed = 0;

  for (const s of aiSuggestions) {
    if (!s || s.status === 'deleted') continue;
    const current = s.suggestedCategory || '';
    if (!current) continue;
    if (current === target || current.startsWith(`${target}/`)) continue;

    const isExcluded = Array.from(excludeSet).some((ex) => current === ex || current.startsWith(`${ex}/`));
    if (isExcluded) continue;

    s.suggestedCategory = target;
    if (s.status === 'pending') {
      s.status = 'accepted';
    }
    changed++;
  }

  return changed;
}

function applyNaturalLanguageRule(rawInstruction) {
  const text = (rawInstruction || '').trim();
  if (!text) {
    throw new Error('请输入自然语言规则');
  }

  const actions = splitInstructionActions(text);
  if (!actions.length) {
    throw new Error('请输入有效规则');
  }

  const candidates = buildCategoryCandidates();
  const parsedOps = [];
  for (const actionText of actions) {
    const op = parseSingleRuleAction(actionText);
    if (!op) {
      throw new Error(`暂不支持该表达: ${actionText}`);
    }
    parsedOps.push(op);
  }

  let changed = 0;
  for (const op of parsedOps) {
    if (op.type === 'move_all_except') {
      changed += replaceAllExceptToTarget(op.excludes, op.target, candidates);
      continue;
    }

    if (op.type === 'merge' || op.type === 'move') {
      const target = resolveCategoryName(op.target, candidates);
      const sources = Array.isArray(op.sources) ? op.sources : [];
      for (const src of sources) {
        const source = resolveCategoryName(src, candidates);
        if (!source || !target || source === target) continue;
        changed += replaceSuggestionCategory(source, target);
      }
      continue;
    }

    if (op.type === 'rename') {
      const source = resolveCategoryName(op.source, candidates);
      const target = resolveCategoryName(op.target, candidates);
      if (!source || !target || source === target) continue;
      changed += replaceSuggestionCategory(source, target);
    }
  }

  return {
    changed,
    message: `已应用 ${parsedOps.length} 条规则`,
  };
}

function applyStructuredOperations(operations, categoryCandidates) {
  let changed = 0;

  for (const op of operations || []) {
    const type = String(op?.type || '').toLowerCase();

    if (type === 'move_all_except') {
      const excludes = Array.isArray(op.excludes) ? op.excludes : [];
      const target = op.target || op.to;
      changed += replaceAllExceptToTarget(excludes, target, categoryCandidates);
      continue;
    }

    if (type === 'merge') {
      const target = resolveCategoryName(op.target, categoryCandidates);
      const sources = Array.isArray(op.sources) ? op.sources : [];
      for (const src of sources) {
        const source = resolveCategoryName(src, categoryCandidates);
        if (!source || !target || source === target) continue;
        changed += replaceSuggestionCategory(source, target);
      }
      continue;
    }

    if (type === 'rename' || type === 'move') {
      const target = resolveCategoryName(op.target || op.to, categoryCandidates);
      const sources = Array.isArray(op.sources) && op.sources.length
        ? op.sources
        : [op.source || op.from].filter(Boolean);

      for (const rawSource of sources) {
        const source = resolveCategoryName(rawSource, categoryCandidates);
        if (!source || !target || source === target) continue;
        changed += replaceSuggestionCategory(source, target);
      }
    }
  }

  return changed;
}

async function applyNaturalLanguageRuleWithAI(rawInstruction) {
  const candidates = buildCategoryCandidates();
  const parsed = await AIEngine.parseCategoryRule(rawInstruction, candidates);
  const changed = applyStructuredOperations(parsed.operations || [], candidates);
  return {
    changed,
    message: parsed.explanation || '已通过 AI 语义理解应用规则',
  };
}

$('#btn-apply-ai-rule').addEventListener('click', async () => {
  if (!aiSuggestions.length) {
    showToast('请先执行 AI 分析后再应用规则', 'info');
    return;
  }

  const input = $('#ai-rule-input');
  const instruction = input?.value || '';
  try {
    let result;
    try {
      result = applyNaturalLanguageRule(instruction);
    } catch (parseErr) {
      const msg = parseErr?.message || '';
      if (msg.includes('请输入')) {
        throw parseErr;
      }
      result = await applyNaturalLanguageRuleWithAI(instruction);
    }

    if (!result.changed) {
      showToast('规则已解析，但未命中可调整的分类', 'info');
      return;
    }
    refreshSuggestionsView(currentCategory);
    showToast(`${result.message}（共调整 ${result.changed} 条）`, 'success', 3200);
  } catch (err) {
    showToast(err.message, 'error', 3200);
  }
});

$('#btn-cancel-ai').addEventListener('click', () => {
  returnToMainView();
  $('#ai-rule-input').value = '';
  aiSuggestions = [];
  showToast('已放弃分类');
});

$('#btn-apply-selected').addEventListener('click', async () => {
  const accepted = aiSuggestions.filter(s => s.status === 'accepted');
  const deleted = aiSuggestions.filter(s => s.status === 'deleted');
  if (accepted.length === 0 && deleted.length === 0) {
    showToast('请先选择要应用的建议或标记要删除的书签', 'info');
    return;
  }

  const btn = $('#btn-apply-selected');
  btn.disabled = true;
  btn.textContent = '应用中...';

  let successCount = 0;
  let deleteCount = 0;

  for (const s of deleted) {
    try {
      await BookmarkManager.remove(s.bookmarkId);
      deleteCount++;
    } catch { /* skip err */ }
  }

  for (const s of accepted) {
    try {
      const folderId = await BookmarkManager.ensureFolderPath(s.suggestedCategory);
      await BookmarkManager.move(s.bookmarkId, folderId);
      successCount++;
    } catch { /* skip err */ }
  }

  let msg = '';
  if (successCount > 0) msg += `成功移动 ${successCount} 条`;
  if (deleteCount > 0) msg += `${msg ? '，' : ''}成功删除 ${deleteCount} 条`;
  showToast(msg || '操作完成');
  btn.disabled = false;
  btn.textContent = '应用勾选变更';
  returnToMainView();
  $('#ai-rule-input').value = '';
  aiSuggestions = [];
  groupedSuggestions = {};
  currentCategory = null;
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Load Existing Config on Init ───
(async function init() {
  initTheme();
  initCollapsibleSections();
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

  }

  updateAIPanelStatus();
})();


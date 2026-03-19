/**
 * Popup main script – orchestrates UI interactions.
 */

// ─── Helpers ───
function $(sel) {
  return document.querySelector(sel);
}
function $$(sel) {
  return document.querySelectorAll(sel);
}

async function sendMessage(action, payload = {}) {
  return chrome.runtime.sendMessage({ action, payload });
}

function showToast(text, type = 'info', duration = 2500) {
  const el = $('#toast');
  el.textContent = text;
  el.className = `toast show ${type}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.classList.remove('show');
  }, duration);
}

// ─── Tab Navigation ───
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    $$('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// ─── Settings Button ───
$('#btn-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ─── Search ───
$('#search-input').addEventListener('input', async (e) => {
  const query = e.target.value.trim();
  if (!query) {
    await loadBookmarks();
    return;
  }
  const results = await sendMessage('searchBookmarks', { query });
  if (results.error) return;
  renderSearchResults(results);
});

function renderSearchResults(bookmarks) {
  const container = $('#bookmark-tree');
  container.innerHTML = '';
  if (!bookmarks || bookmarks.length === 0) {
    container.innerHTML =
      '<p style="color:var(--text-muted);text-align:center;padding:30px 0;">未找到匹配的书签</p>';
    return;
  }

  bookmarks.forEach((b) => {
    if (!b.url) return;
    const el = document.createElement('a');
    el.className = 'bookmark-item';
    el.href = b.url;
    el.target = '_blank';
    el.rel = 'noopener';
    el.innerHTML = `
      <img class="bookmark-favicon" src="${getFaviconUrl(b.url)}" alt="">
      <span class="bookmark-title">${escapeHtml(b.title || b.url)}</span>
    `;
    container.appendChild(el);
  });
}

// ─── Bookmarks Tree ───
async function loadBookmarks() {
  const tree = await sendMessage('getBookmarkTree');
  if (tree.error) {
    showToast(tree.error, 'error');
    return;
  }
  renderTree(tree);
}

function renderTree(nodes) {
  const container = $('#bookmark-tree');
  container.innerHTML = '';
  if (!Array.isArray(nodes)) return;
  nodes.forEach((node) => {
    const fragment = buildTreeNode(node);
    if (fragment) container.appendChild(fragment);
  });
}

function buildTreeNode(node) {
  if (node.url) {
    // Bookmark link
    const el = document.createElement('a');
    el.className = 'bookmark-item';
    el.href = node.url;
    el.target = '_blank';
    el.rel = 'noopener';
    el.innerHTML = `
      <img class="bookmark-favicon" src="${getFaviconUrl(node.url)}" alt="">
      <span class="bookmark-title">${escapeHtml(node.title || node.url)}</span>
    `;
    return el;
  }

  if (node.children && node.children.length > 0) {
    const folder = document.createElement('div');
    folder.className = 'folder-item';

    const bookmarkCount = countBookmarks(node);

    const header = document.createElement('div');
    header.className = 'folder-header';
    header.innerHTML = `
      <svg class="folder-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
      <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span class="folder-name">${escapeHtml(node.title || '未命名')}</span>
      <span class="folder-count">${bookmarkCount}</span>
    `;
    header.addEventListener('click', () =>
      folder.classList.toggle('open')
    );

    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'folder-children';
    node.children.forEach((child) => {
      const childEl = buildTreeNode(child);
      if (childEl) childrenContainer.appendChild(childEl);
    });

    folder.appendChild(header);
    folder.appendChild(childrenContainer);
    return folder;
  }

  return null;
}

function countBookmarks(node) {
  let count = 0;
  if (node.url) return 1;
  if (node.children) {
    node.children.forEach((c) => (count += countBookmarks(c)));
  }
  return count;
}

function getFaviconUrl(url) {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
  } catch {
    return 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="%236366f1" rx="3"/></svg>';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN');
}

// ─── Sync Panel ───
let popupSyncVersions = [];

function setSyncEnabled(enabled) {
  $('#btn-sync-upload').disabled = !enabled;
  $('#btn-sync-download').disabled = !enabled;
  $('#btn-sync-load-versions').disabled = !enabled;
}

function renderPopupSyncVersions() {
  const container = $('#popup-sync-versions');
  container.innerHTML = '';

  if (!popupSyncVersions.length) {
    container.classList.remove('hidden');
    container.innerHTML = '<div class="result-box">暂无历史记录，请先执行一次上传。</div>';
    return;
  }

  container.classList.remove('hidden');
  popupSyncVersions.forEach((v) => {
    const item = document.createElement('div');
    item.className = 'popup-sync-version-item';
    item.innerHTML = `
      <div class="popup-sync-version-id">${escapeHtml(v.shortId || (v.id || '').slice(0, 7))}</div>
      <div class="popup-sync-version-meta">${escapeHtml(v.author || '未知作者')} · ${escapeHtml(formatTime(v.date))}</div>
      <div class="popup-sync-version-msg">${escapeHtml(v.message || '无提交信息')}</div>
      <div class="popup-sync-version-actions">
        <button class="action-btn secondary popup-restore-btn" data-version-id="${escapeHtml(v.id)}">恢复并全部替换本地</button>
      </div>
    `;
    container.appendChild(item);
  });

  container.querySelectorAll('.popup-restore-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const versionId = btn.dataset.versionId;
      if (!versionId) return;

      const ok = confirm('将用该历史版本把本地书签全部替换，是否继续？');
      if (!ok) return;

      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = '恢复中...';
      try {
        const result = await sendMessage('restoreSyncVersion', { versionId });
        if (result?.error) throw new Error(result.error);

        const moved = result?.moved || 0;
        const updated = result?.updated || 0;
        const added = result?.added || 0;
        const removed = result?.removed || 0;
        showResult('sync-result', `✅ 恢复完成：移动 ${moved}，更新 ${updated}，新增 ${added}，删除 ${removed}`, 'success');
        showToast('已按历史版本替换本地', 'success');
        await loadBookmarks();
      } catch (err) {
        showResult('sync-result', `❌ 恢复失败: ${err.message}`, 'error');
        showToast('恢复失败', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  });
}

async function loadPopupSyncVersions() {
  const btn = $('#btn-sync-load-versions');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '加载中...';
  try {
    const versions = await sendMessage('getSyncVersions', { limit: 20 });
    if (versions?.error) throw new Error(versions.error);
    popupSyncVersions = Array.isArray(versions) ? versions : [];
    renderPopupSyncVersions();
    showToast(`已加载 ${popupSyncVersions.length} 条历史记录`, 'success');
  } catch (err) {
    showResult('sync-result', `❌ 加载历史记录失败: ${err.message}`, 'error');
    showToast('加载历史失败', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function initSyncPanel() {
  const config = await sendMessage('getSyncConfig');
  if (config && config.platform) {
    // Test connection
    const result = await sendMessage('testSync');
    const dot = $('#sync-status-dot');
    const text = $('#sync-status-text');
    if (result.success) {
      dot.className = 'status-dot connected';
      text.textContent = result.message;
      setSyncEnabled(true);
      await loadPopupSyncVersions();
    } else {
      dot.className = 'status-dot error';
      text.textContent = result.message;
      setSyncEnabled(false);
    }
  } else {
    $('#sync-status-text').textContent =
      '未配置同步，请点击右上角⚙进入设置';
    setSyncEnabled(false);
  }
}

$('#btn-sync-upload').addEventListener('click', async () => {
  const btn = $('#btn-sync-upload');
  btn.disabled = true;
  btn.textContent = '上传中...';
  try {
    const result = await sendMessage('syncUpload');
    if (result.error) throw new Error(result.error);
    showResult('sync-result', '✅ 上传成功，远端书签文件已全部替换。', 'success');
    showToast('上传成功', 'success');
    await loadPopupSyncVersions();
  } catch (err) {
    showResult('sync-result', `❌ 上传失败: ${err.message}`, 'error');
    showToast('上传失败', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>上传并全部替换远端`;
  }
});

$('#btn-sync-download').addEventListener('click', async () => {
  const ok = confirm('该操作会将本地书签全部替换为远端版本，是否继续？');
  if (!ok) return;

  const btn = $('#btn-sync-download');
  btn.disabled = true;
  btn.textContent = '下载中...';
  try {
    const result = await sendMessage('syncDownload');
    if (result.error) throw new Error(result.error);
    const moved = result?.moved || 0;
    const updated = result?.updated || 0;
    const added = result?.added || 0;
    const removed = result?.removed || 0;
    showResult(
      'sync-result',
      `✅ 替换完成：移动 ${moved}，更新 ${updated}，新增 ${added}，删除 ${removed}。`,
      'success'
    );
    showToast('下载完成', 'success');
    await loadBookmarks(); // Refresh tree
  } catch (err) {
    showResult('sync-result', `❌ 下载失败: ${err.message}`, 'error');
    showToast('下载失败', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>下载并全部替换本地`;
  }
});

$('#btn-sync-load-versions').addEventListener('click', async () => {
  await loadPopupSyncVersions();
});

function showResult(id, text, type) {
  const el = $(`#${id}`);
  el.textContent = text;
  el.className = `result-box ${type}`;
}

// ─── Theme Management ───
function initTheme() {
  let theme = localStorage.getItem('theme');
  if (!theme) {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    theme = prefersDark ? 'dark' : 'light';
  }
  document.body.className = theme === 'light' ? 'light-mode' : '';
  const icon = $('#btn-theme-toggle .theme-icon');
  if (icon) icon.textContent = theme === 'light' ? '☀️' : '🌙';
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!localStorage.getItem('theme')) {
    document.body.className = e.matches ? '' : 'light-mode';
    const icon = $('#btn-theme-toggle .theme-icon');
    if (icon) icon.textContent = e.matches ? '🌙' : '☀️';
  }
});

$('#btn-theme-toggle').addEventListener('click', () => {
  const current = localStorage.getItem('theme');
  let next = 'light';
  if (current) {
    next = current === 'dark' ? 'light' : 'dark';
  } else {
    const isDarkNow = !document.body.classList.contains('light-mode');
    next = isDarkNow ? 'light' : 'dark';
  }
  localStorage.setItem('theme', next);
  initTheme();
});


// ─── Init ───
(async function init() {
  initTheme();
  await loadBookmarks();
  initSyncPanel();
})();


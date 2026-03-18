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

// ─── Sync Panel ───
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
      $('#btn-sync-upload').disabled = false;
      $('#btn-sync-download').disabled = false;
    } else {
      dot.className = 'status-dot error';
      text.textContent = result.message;
    }
  } else {
    $('#sync-status-text').textContent =
      '未配置同步，请点击右上角⚙进入设置';
  }
}

$('#btn-sync-upload').addEventListener('click', async () => {
  const btn = $('#btn-sync-upload');
  btn.disabled = true;
  btn.textContent = '上传中...';
  try {
    const result = await sendMessage('syncUpload');
    if (result.error) throw new Error(result.error);
    showResult('sync-result', '✅ 书签已成功上传到远程仓库！', 'success');
    showToast('上传成功', 'success');
  } catch (err) {
    showResult('sync-result', `❌ 上传失败: ${err.message}`, 'error');
    showToast('上传失败', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>上传到远程`;
  }
});

$('#btn-sync-download').addEventListener('click', async () => {
  const btn = $('#btn-sync-download');
  btn.disabled = true;
  btn.textContent = '下载中...';
  try {
    const result = await sendMessage('syncDownload');
    if (result.error) throw new Error(result.error);
    showResult(
      'sync-result',
      `✅ 同步完成！新增 ${result.added} 个书签，跳过 ${result.skipped} 个已有书签。`,
      'success'
    );
    showToast('下载完成', 'success');
    await loadBookmarks(); // Refresh tree
  } catch (err) {
    showResult('sync-result', `❌ 下载失败: ${err.message}`, 'error');
    showToast('下载失败', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>从远程下载`;
  }
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


# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Chrome/Edge browser extension (Manifest V3) for intelligent bookmark management with GitHub/GitLab sync and AI-powered classification. No build system — load directly as an unpacked extension. No npm, no transpilation.

**To install:** Open `chrome://extensions` or `edge://extensions`, enable Developer Mode, click "Load unpacked", select this directory.

## Architecture

### Layer Structure

```
UI (popup/, options/)
    ↓ chrome.runtime.sendMessage()
background/service-worker.js  ← central message router
    ↓ direct function calls
lib/bookmark-manager.js        ← Chrome Bookmarks API wrapper
lib/sync/sync-engine.js        ← factory → GitHubSync | GitLabSync
lib/ai/ai-engine.js            ← factory → DeepSeekProvider | MiniMaxProvider
```

### Key Patterns

**Factory/Static Pattern:** `SyncEngine`, `AIEngine`, and `BookmarkManager` all use static methods — no instantiation at call sites. Providers are created internally via `getProvider()`.

**Message Bus:** All communication from UI to business logic goes through `background/service-worker.js` via `chrome.runtime.sendMessage`. The service worker is the only entry point to `lib/`.

**Adapter Interface:** Both `GitHubSync` and `GitLabSync` implement the same interface (`upload`, `download`, `testConnection`, `getVersions`, `downloadVersion`), as do the AI providers. Swap providers by changing config, not code.

### Data Flow for Sync

1. User triggers sync in `options/options.js` → sends message to service worker
2. Service worker calls `SyncEngine.getProvider()` → reads `chrome.storage.local` → returns `GitHubSync` or `GitLabSync` instance
3. Provider calls external API; for upload, `BookmarkManager.exportToSyncFormat()` serializes Chrome bookmark tree to JSON with version metadata
4. For download, `BookmarkManager.importFromSync()` handles overwrite vs. merge modes

### AI Classification Flow

1. `AIEngine.classifyBookmarks(bookmarks)` batches items in groups of 30 to avoid token limits
2. Each batch is sent to the configured provider (DeepSeek or MiniMax) with existing folder names as context
3. Results are applied via `BookmarkManager.moveBookmark()` / folder creation

### Configuration Storage

All runtime config is in `chrome.storage.local`:
- `syncConfig`: `{ platform, token, owner, repo, branch, filePath }`
- `aiConfig`: `{ provider, apiKey, model, groupId }` (groupId is MiniMax-specific)

## Important Implementation Details

- **No tests, no linter** — the project ships raw JS with no tooling infrastructure
- **Health check and duplicate cleanup** sections in `options/options.html` are UI placeholders; backend logic is not yet implemented
- `DeepSeekProvider` and `MiniMaxProvider` share nearly identical prompt logic — when modifying AI behavior, update both files
- GitLab support requires a numeric project ID (not just `owner/repo`); `gitlab-sync.js` handles the lookup
- Version history (rollback) is implemented by reading Git commit history on the sync file, not a separate version store

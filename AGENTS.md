# Bookmark Sync project guidance

- Keep the four layers explicit: browser adapters, canonical model/sync core, storage adapters, and the independent organizer.
- Keep sync calculations pure and previewable. Browser mutations must go through `applyRepositoryToBrowser` after a plan is approved; AI output is suggestion-only.
- Treat canonical IDs as the cross-browser identity. Never use Chrome or Edge bookmark IDs in persisted repository data.
- Preserve history on restore by writing a new revision. Require confirmation for large destructive changes and create a local safety snapshot first.
- Do not log or commit GitHub, server, or AI credentials. Keep provider-specific code outside the sync engine.
- Run `npm test`, `npm run typecheck`, and `npm run build` before handing off changes.
- Use short English branch names such as `fix-merge-conflict`; do not use a `codex` prefix.

# Product Direction: from sync utility to bookmark intelligence

## Decision

Bookmark Sync should be opened to make a bookmark library more useful, not merely to move it between browsers. The product center is now **AI curation + link health + reviewable cleanup**. Cross-browser sync, revision history, and safety snapshots remain the trust layer that stores and protects the user's decisions.

This is a focus change, not a permission change: the product still does not let AI or a background job silently mutate the bookmark tree.

## The primary user question

> “What in my bookmark library needs attention, and can I understand the reason before I change it?”

The interface should answer that question in the first viewport with three signal types:

| Signal | What it means | Primary action |
| --- | --- | --- |
| AI queue | A model found a possible categorization, folder, or semantic-duplicate improvement | Review, accept, or ignore |
| Link health | A saved URL is broken, restricted, unsupported, or not yet checked | Recheck, visit manually, ignore, or delete with confirmation |
| Duplicate URLs | The same URL appears more than once, exactly or after normalization | Inspect the group and decide what to keep |

## Information architecture

The Manager navigation is organized into two groups:

### Intelligence

1. **Workspace** — counts, next actions, scan → review → apply explanation, and a compact safety-foundation status.
2. **AI curation** — suggestion queue with confidence, rationale, destination, and explicit accept / ignore actions.
3. **Link health** — streamed reachability scan, honest result states, filters, manual visit, recheck, ignore, and confirmed deletion.
4. **Library** — the actual browser bookmark tree for search, inspection, and direct maintenance.

### Data & safety

5. **Cross-browser sync** — preview, 3-way merge, conflict decisions, sync strategy, and safety snapshots.
6. **Version history** — immutable provider history and append-only restore.
7. **Settings** — AI endpoint, storage provider, sync policy, language, and maintenance.

The browser Popup mirrors the same priority: it shows the current collection size and actionable signals first, routes to AI curation as the main action, and keeps sync preview one step away.

## Experience principles

- **Signal before status**: show what needs attention before showing infrastructure state.
- **Evidence beside action**: a suggestion must include its subject, target, rationale, and confidence; a health result must include its status and a manual escape hatch.
- **Uncertainty is a state**: `restricted`, `error`, and `unsupported` are not synonyms for “dead”.
- **Suggestion-only by construction**: AI output enters a validated queue. It never calls a browser API directly.
- **One safe write path**: accepted AI changes and direct cleanup both go through the normal sync plan, safety checks, and `applyRepositoryToBrowser`.
- **Sync protects decisions**: sync is visible and reliable, but it should feel like the place where approved organization is preserved rather than the product's only purpose.

## Content rules

- Prefer “待审核 / 需要检查 / 可能重复” over categorical claims when evidence is incomplete.
- Explain technical terms at the point of use: “规范化 URL” means tracking parameters or equivalent URL noise were normalized for comparison.
- Never call a preview an applied change, and never call a restricted check a broken link.
- Keep privacy scope visible before an AI run: title, URL, hostname, and folder path are sent only to the configured endpoint when the user starts analysis.

## Success measures for this direction

- A first-time user can identify the next useful action without opening the sync page.
- A user can complete one AI suggestion or one link-health finding without learning the storage model first.
- Every accepted change leaves a clear, reversible trail.
- Users can still find and complete sync, conflict, history, and restore workflows without those workflows dominating the entry surface.

## Out of scope for this pivot

- Autonomous deletion, merging, renaming, or background AI mutation.
- Replacing the canonical repository or browser adapter boundaries.
- Treating network reachability as a perfect truth source.
- Removing sync, history, conflict handling, safety snapshots, or provider support.

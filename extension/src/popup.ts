import "./styles.css";
import { setLanguage, t } from "./i18n.js";
import { escapeHtml, formatCount, formatDate, send, statusClass } from "./ui.js";

const popupRoot = document.querySelector<HTMLElement>("#popup-app");
if (!popupRoot) throw new Error("Popup root is missing");
const app = popupRoot;

function localizedStatus(status: string): string {
  if (status === "synced") return t("statusSynced");
  if (status === "never") return t("statusNever");
  if (status === "conflict") return t("statusConflict");
  if (status === "confirmation_required") return t("statusConfirmationRequired");
  if (status === "error") return t("statusError");
  if (status === "busy") return t("statusBusy");
  return status.replaceAll("_", " ");
}

function providerLabel(provider: string): string {
  if (provider === "github") return "GitHub";
  if (provider === "self-hosted") return "Self-Hosted";
  if (provider === "webdav") return "WebDAV";
  return t("providerLocalTitle");
}

function modeLabel(mode: string): string {
  if (mode === "publish") return t("strategyPublish");
  if (mode === "mirror") return t("strategyMirror");
  return t("strategyTwoWay");
}

type PopupPlanSide = {
  creates?: number;
  updates?: number;
  moves?: number;
  deletes?: number;
};

type PopupPlan = {
  hasChanges: boolean;
  conflicts?: unknown[];
  local?: PopupPlanSide;
  remote?: PopupPlanSide;
  destructive?: { requiresConfirmation?: boolean };
  remoteDestructive?: { requiresConfirmation?: boolean };
};

let previewPlan: PopupPlan | null = null;
let previewBusy = false;
let previewError: string | null = null;
let previewSuccess: string | null = null;

function renderPreview(): string {
  if (previewBusy) {
    return `
      <section class="popup-preview" role="status" aria-live="polite" aria-busy="true">
        <div style="display:flex; align-items:center; gap:6px;">
          <div class="pulse-dot" aria-hidden="true"></div>
          <strong>${escapeHtml(t("popupPreviewTitle"))}</strong>
        </div>
        <p class="muted small" style="margin:4px 0 0;">${escapeHtml(t("popupPreviewBusy"))}</p>
      </section>`;
  }
  if (previewError) {
    return `
      <section class="popup-preview error" role="alert" aria-live="assertive">
        <strong>${escapeHtml(t("popupPreviewTitle"))}</strong>
        <p class="small" style="margin:4px 0 8px;">${escapeHtml(`${t("popupPreviewError")}${previewError}`)}</p>
        <button type="button" class="button sm" data-popup-action="sync">${escapeHtml(t("retrySyncBtn"))}</button>
      </section>`;
  }
  if (previewSuccess) {
    return `
      <section class="popup-preview success" role="status" aria-live="polite">
        <strong style="color:var(--color-good); font-size:12px;">${escapeHtml(previewSuccess)}</strong>
      </section>`;
  }
  if (!previewPlan) return "";

  const local = previewPlan.local ?? {};
  const remote = previewPlan.remote ?? {};
  const conflicts = previewPlan.conflicts ?? [];
  const rows: Array<{ key: "planCreates" | "planUpdates" | "planMoves" | "planDeletes"; local: number; remote: number }> = [
    { key: "planCreates", local: local.creates ?? 0, remote: remote.creates ?? 0 },
    { key: "planUpdates", local: local.updates ?? 0, remote: remote.updates ?? 0 },
    { key: "planMoves", local: local.moves ?? 0, remote: remote.moves ?? 0 },
    { key: "planDeletes", local: local.deletes ?? 0, remote: remote.deletes ?? 0 },
  ];
  const blocked = conflicts.length > 0 || Boolean(previewPlan.destructive?.requiresConfirmation) || Boolean(previewPlan.remoteDestructive?.requiresConfirmation);
  const hasChanges = previewPlan.hasChanges || rows.some((row) => row.local > 0 || row.remote > 0);

  return `
    <section class="popup-preview" role="region" aria-labelledby="popup-preview-title">
      <div class="popup-preview-heading">
        <div style="display:flex; align-items:center; gap:6px;">
          <h2 id="popup-preview-title" style="font-size:12px; margin:0;">${escapeHtml(t("popupPreviewTitle"))}</h2>
        </div>
        <button type="button" class="button sm subtle" data-popup-action="preview-cancel">${escapeHtml(t("popupPreviewCancel"))}</button>
      </div>
      <table class="popup-preview-table" style="margin-top:6px;">
        <caption>${escapeHtml(t("planImpactCaption"))}</caption>
        <thead><tr><th scope="col">${escapeHtml(t("popupPreviewChangeType"))}</th><th scope="col">${escapeHtml(t("popupPreviewLocal"))}</th><th scope="col">${escapeHtml(t("popupPreviewRemote"))}</th></tr></thead>
        <tbody>
          ${rows.map((row) => `<tr><th scope="row">${escapeHtml(t(row.key))}</th><td>${formatCount(row.local)}</td><td>${formatCount(row.remote)}</td></tr>`).join("")}
        </tbody>
      </table>
      <p class="popup-preview-status ${blocked ? "warn" : ""}" role="status" style="margin:6px 0 8px; font-size:11px;">
        ${escapeHtml(blocked ? t("popupPreviewBlocked") : hasChanges ? t("popupPreviewReady") : t("popupPreviewNoChanges"))}
      </p>
      <div class="popup-preview-actions">
        ${blocked ? `<button type="button" class="button primary sm" data-popup-action="preview-manager">${escapeHtml(t("popupPreviewOpenManager"))}</button>` : hasChanges ? `<button type="button" class="button primary sm" data-popup-action="preview-confirm">${escapeHtml(t("popupPreviewConfirm"))}</button>` : ""}
      </div>
    </section>`;
}

async function render(): Promise<void> {
  try {
    const state = await send<{
      status: string;
      lastSyncAt: string | null;
      lastSyncError: string | null;
      stats: { bookmarks: number; folders: number; changes: number };
      duplicates: unknown[];
      suggestions: unknown[];
      settings: { provider: string; mode: string; language?: "zh-CN" | "en"; ai?: { baseUrl?: string; model?: string } };
    }>({ type: "GET_STATE" });

    if (state.settings.language) {
      setLanguage(state.settings.language);
    }
    const lang = state.settings.language ?? "zh-CN";
    const status = localizedStatus(state.status);
    const aiReady = Boolean(state.settings.ai?.baseUrl && state.settings.ai?.model);

    app.innerHTML = `
      <div class="popup-header">
        <div class="popup-brand">
          <img class="popup-brand-mark" src="/icons/icon32.png" alt="Logo" width="22" height="22" />
          <div>
            <h1 class="popup-title">${escapeHtml(t("popupTitle"))}</h1>
            <p class="popup-subtitle">${escapeHtml(t("popupSubtitle"))}</p>
          </div>
        </div>
        <span class="status-line"><i class="dot ${statusClass(state.status)}"></i>${escapeHtml(status)}</span>
      </div>

      <div class="popup-card">
        <div class="popup-focus-meta" style="margin-bottom:8px;">
          <span class="badge blue sm">${escapeHtml(providerLabel(state.settings.provider))}</span>
          <span class="badge sm">${escapeHtml(modeLabel(state.settings.mode))}</span>
          <span style="margin-left:auto; font-size:11px; color:var(--text-muted);">
            ${escapeHtml(state.lastSyncAt ? formatDate(state.lastSyncAt, lang, t("neverDate")) : t("popupLocalSnapshot"))}
          </span>
        </div>

        <div class="popup-stat-grid">
          <div class="popup-stat-item">
            <span class="popup-stat-label">${escapeHtml(t("statBookmarks"))}</span>
            <strong class="popup-stat-value">${formatCount(state.stats.bookmarks)}</strong>
          </div>
          <div class="popup-stat-item">
            <span class="popup-stat-label">${escapeHtml(t("signalAiTitle"))}</span>
            <strong class="popup-stat-value" style="color:${state.suggestions.length ? "var(--accent-blue)" : "inherit"};">${formatCount(state.suggestions.length)}</strong>
          </div>
          <div class="popup-stat-item">
            <span class="popup-stat-label">${escapeHtml(t("signalDuplicatesTitle"))}</span>
            <strong class="popup-stat-value" style="color:${state.duplicates.length ? "var(--color-warn)" : "inherit"};">${formatCount(state.duplicates.length)}</strong>
          </div>
        </div>
      </div>

      ${renderPreview()}

      <div class="popup-actions">
        <button type="button" class="button primary sm" data-popup-action="sync" ${previewBusy ? 'disabled aria-busy="true"' : ""}>
          ${escapeHtml(t("popupSyncNow"))}
        </button>
        <button type="button" class="button sm" data-popup-action="open-organizer">
          ${escapeHtml(t("popupOrganizeNow"))}
        </button>
      </div>

      <div class="popup-footer-row">
        <span class="popup-ai-status ${aiReady ? "ready" : "needs-setup"}">
          <i class="dot ${aiReady ? "" : "warn"}"></i>
          ${escapeHtml(aiReady ? (state.settings.ai?.model || t("popupAiReady")) : t("popupAiSetup"))}
        </span>
        <button type="button" class="button sm subtle" data-popup-action="open" style="font-size:11px;">
          ${escapeHtml(t("popupViewManager"))} →
        </button>
      </div>

      ${state.lastSyncError ? `
        <div class="notice error" style="margin-top:8px;">
          <strong>${escapeHtml(t("popupSyncError"))}</strong>
          <p class="small" style="margin:3px 0 6px;">${escapeHtml(state.lastSyncError)}</p>
          <button type="button" class="button sm" data-popup-action="sync">${escapeHtml(t("retrySyncBtn"))}</button>
        </div>
      ` : ""}`;
  } catch (error) {
    app.innerHTML = `<div class="notice error">${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

app.addEventListener("click", (event) => {
  const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-popup-action]");
  const action = btn?.dataset.popupAction;
  if (action === "sync") {
    void previewSync();
  }
  if (action === "preview-confirm") {
    void confirmPreview();
  }
  if (action === "preview-cancel") {
    previewPlan = null;
    previewError = null;
    previewSuccess = null;
    void render();
  }
  if (action === "preview-manager") {
    void chrome.runtime.openOptionsPage();
  }
  if (action === "open-organizer") {
    const url = `${chrome.runtime.getURL("manager.html")}?page=organizer`;
    void chrome.tabs.create({ url });
  }
  if (action === "open") void chrome.runtime.openOptionsPage();
});

async function previewSync(): Promise<void> {
  if (previewBusy) return;
  previewBusy = true;
  previewPlan = null;
  previewError = null;
  previewSuccess = null;
  await render();
  try {
    const response = await send<{ ok: boolean; status?: string; message?: string; plan?: PopupPlan }>({ type: "SYNC_NOW", preview: true });
    if (!response.plan) throw new Error(response.message || t("popupPreviewNoChanges"));
    previewPlan = response.plan;
  } catch (error) {
    previewError = error instanceof Error ? error.message : String(error);
  } finally {
    previewBusy = false;
    await render();
  }
}

async function confirmPreview(): Promise<void> {
  if (previewBusy || !previewPlan) return;
  previewBusy = true;
  previewError = null;
  await render();
  try {
    const response = await send<{ ok: boolean; status?: string; message?: string }>({ type: "SYNC_NOW", confirm: true });
    if (response.status === "confirmation_required" || response.status === "conflict") {
      await chrome.runtime.openOptionsPage();
      return;
    }
    if (!response.ok) throw new Error(response.message || t("popupSyncError"));
    previewPlan = null;
    previewSuccess = t("syncCompletedTitle");
  } catch (error) {
    previewError = error instanceof Error ? error.message : String(error);
  } finally {
    previewBusy = false;
    await render();
  }
}

void render();

import { createId } from "./id.js";
import { getFolderPath } from "./paths.js";
import { getHostname } from "./url.js";
import type {
  BookmarkRepository,
  OrganizerRequest,
  OrganizerResult,
  OrganizerSuggestion,
  OrganizerSuggestionKind,
} from "./types.js";

const MAX_SUGGESTIONS_PER_RESPONSE = 40;
const AI_MAX_OUTPUT_TOKENS = 4096;

export interface BookmarkAIProvider {
  organize(request: OrganizerRequest): Promise<OrganizerResult>;
  testConnection?(signal?: AbortSignal): Promise<{ ok: boolean; model: string }>;
}

export function buildOrganizerRequest(repository: BookmarkRepository): OrganizerRequest {
  const folders = repository.nodes
    .filter((node) => node.type === "folder")
    .map((node) => {
      const parentPath = getFolderPath(repository, node.id);
      return parentPath ? `${parentPath}/${node.title}` : node.title;
    })
    .filter(Boolean);
  const bookmarks = repository.nodes
    .filter((node) => node.type === "bookmark" && node.url)
    .map((node) => ({
      id: node.id,
      title: node.title,
      url: node.url ?? "",
      hostname: getHostname(node.url ?? ""),
      folderPath: getFolderPath(repository, node.id),
    }));
  return { folders: [...new Set(folders)], bookmarks };
}

function normalizeSuggestionKind(value: unknown): OrganizerSuggestionKind | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase().trim().replace(/_/g, "-");
  if (normalized === "move") return "move";
  if (normalized === "create-folder" || normalized === "createfolder") return "create-folder";
  if (normalized === "merge-folder" || normalized === "mergefolder") return "merge-folder";
  if (normalized === "semantic-duplicate" || normalized === "semanticduplicate" || normalized === "duplicate") return "semantic-duplicate";
  return undefined;
}

export function extractAndParseJson(content: string): unknown {
  let cleaned = content.trim();
  // Strip markdown code fences if present (e.g. ```json ... ``` or ``` ...)
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    // Providers sometimes add a short preamble or trailing explanation even
    // when JSON mode is enabled. Find the first complete, balanced JSON value
    // instead of slicing from the first opening brace to the last closing one;
    // the latter breaks when a rationale contains braces or the response was
    // cut off at the output limit.
    const extracted = findCompleteJsonValue(cleaned);
    if (extracted !== undefined) return extracted;

    if (/[\[{]/.test(cleaned)) {
      throw new Error("AI response contained incomplete or invalid JSON; the model may have stopped before completing the response");
    }
    throw new Error("AI response was not valid JSON");
  }
}

function findCompleteJsonValue(text: string): unknown | undefined {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    let start = searchFrom;
    while (start < text.length && text[start] !== "{" && text[start] !== "[") start += 1;
    if (start >= text.length) return undefined;

    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    let completeEnd = -1;

    for (let index = start; index < text.length; index += 1) {
      const character = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{" || character === "[") {
        stack.push(character);
        continue;
      }
      if (character !== "}" && character !== "]") continue;

      const expectedOpening = character === "}" ? "{" : "[";
      if (stack[stack.length - 1] !== expectedOpening) break;
      stack.pop();

      if (stack.length === 0) {
        completeEnd = index;
        break;
      }
    }

    // An unclosed first candidate is most commonly a response truncated at
    // the model's output limit. Do not search inside it and accidentally
    // return one nested, partial suggestion as if it were the full result.
    if (completeEnd === -1) return undefined;

    const candidate = text.slice(start, completeEnd + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      searchFrom = completeEnd + 1;
    }
  }

  return undefined;
}

export function validateOrganizerResult(value: unknown, repository?: BookmarkRepository): OrganizerResult {
  let rawList: unknown[] | undefined;
  if (Array.isArray(value)) {
    rawList = value;
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.suggestions)) {
      rawList = obj.suggestions;
    } else if (Array.isArray(obj.items)) {
      rawList = obj.items;
    } else if (Array.isArray(obj.results)) {
      rawList = obj.results;
    }
  }

  if (!rawList) {
    throw new Error("AI response must be an object with a suggestions array");
  }

  const knownIds = new Set(repository?.nodes.map((node) => node.id));
  const suggestions: OrganizerSuggestion[] = [];

  for (const raw of rawList.slice(0, MAX_SUGGESTIONS_PER_RESPONSE)) {
    if (!raw || typeof raw !== "object") throw new Error("AI suggestion must be an object");
    const item = raw as Record<string, unknown>;

    const kind = normalizeSuggestionKind(item.kind);
    if (!kind) {
      throw new Error(`Unsupported AI suggestion kind: ${String(item.kind)}`);
    }

    // Auto-generate suggestion id if omitted or not a string
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : createId();

    // Parse confidence flexibly (supports 0-1, 0-100%, number strings)
    let confidence = 0.85;
    if (typeof item.confidence === "number") {
      if (item.confidence >= 0 && item.confidence <= 1) {
        confidence = item.confidence;
      } else if (item.confidence > 1 && item.confidence <= 100) {
        confidence = item.confidence / 100;
      } else {
        throw new Error("AI confidence must be a number between 0 and 1");
      }
    } else if (typeof item.confidence === "string") {
      const parsed = parseFloat(item.confidence);
      if (!isNaN(parsed)) {
        confidence = parsed > 1 && parsed <= 100 ? parsed / 100 : Math.max(0, Math.min(1, parsed));
      }
    }

    // Parse rationale with fallbacks
    const rawRationale = item.rationale ?? item.reason ?? item.description ?? item.explanation;
    if (typeof rawRationale !== "string" || !rawRationale.trim()) {
      throw new Error("AI rationale is required");
    }
    const rationale = rawRationale.trim().slice(0, 500);

    const suggestion: OrganizerSuggestion = {
      id,
      kind,
      confidence,
      rationale,
    };

    // Node ID
    const rawNodeId = item.nodeId ?? item.node_id ?? item.bookmarkId ?? item.bookmark_id;
    if (rawNodeId !== undefined) {
      if (typeof rawNodeId !== "string" || (repository && !knownIds.has(rawNodeId))) {
        throw new Error(`Unknown AI node id: ${String(rawNodeId)}`);
      }
      suggestion.nodeId = rawNodeId;
    }

    // Target folder path
    const rawTargetPath = item.targetFolderPath ?? item.target_folder_path ?? item.targetFolder ?? item.target_folder ?? item.folderPath;
    if (rawTargetPath !== undefined) {
      if (typeof rawTargetPath !== "string" || !rawTargetPath.trim()) throw new Error("Invalid target folder path");
      suggestion.targetFolderPath = rawTargetPath.trim();
    }

    // Source folder path
    const rawSourcePath = item.sourceFolderPath ?? item.source_folder_path ?? item.sourceFolder;
    if (rawSourcePath !== undefined) {
      if (typeof rawSourcePath !== "string") throw new Error("Invalid source folder path");
      suggestion.sourceFolderPath = rawSourcePath;
    }

    // Suggested title
    const rawTitle = item.suggestedTitle ?? item.suggested_title ?? item.title;
    if (rawTitle !== undefined) {
      if (typeof rawTitle !== "string") throw new Error("Invalid suggested folder title");
      suggestion.suggestedTitle = rawTitle.slice(0, 200);
    }

    // Related node IDs
    const rawRelated = item.relatedNodeIds ?? item.related_node_ids ?? item.relatedIds;
    if (rawRelated !== undefined) {
      if (!Array.isArray(rawRelated) || rawRelated.some((relId) => typeof relId !== "string" || (repository && !knownIds.has(relId)))) {
        throw new Error("Invalid related node ids");
      }
      suggestion.relatedNodeIds = rawRelated.slice(0, 10) as string[];
    }

    if (suggestion.kind === "move" && (!suggestion.nodeId || !suggestion.targetFolderPath)) {
      throw new Error("Move suggestions require nodeId and targetFolderPath");
    }

    suggestions.push(suggestion);
  }

  return { suggestions };
}

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function endpointFor(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

async function extractHttpErrorMessage(response: Response): Promise<string> {
  let errorDetail = "";
  try {
    const text = await response.text();
    try {
      const errorJson = JSON.parse(text) as {
        error?: { message?: string } | string;
        message?: string;
        detail?: string;
      };
      if (typeof errorJson.error === "object" && errorJson.error?.message) {
        errorDetail = `: ${errorJson.error.message}`;
      } else if (typeof errorJson.error === "string") {
        errorDetail = `: ${errorJson.error}`;
      } else if (typeof errorJson.message === "string") {
        errorDetail = `: ${errorJson.message}`;
      } else if (typeof errorJson.detail === "string") {
        errorDetail = `: ${errorJson.detail}`;
      }
    } catch {
      if (text && text.length < 300) {
        errorDetail = `: ${text.trim()}`;
      }
    }
  } catch {}
  return `AI provider returned HTTP ${response.status}${errorDetail}`;
}

export class OpenAICompatibleProvider implements BookmarkAIProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OpenAICompatibleConfig, fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ? fetchImpl.bind(globalThis) : globalThis.fetch.bind(globalThis);
  }

  async testConnection(signal?: AbortSignal): Promise<{ ok: boolean; model: string }> {
    const baseUrl = this.config.baseUrl.trim();
    const model = this.config.model.trim();
    const apiKey = (this.config.apiKey || "").trim();

    if (!baseUrl || !model) {
      throw new Error("AI Base URL and Model must be configured");
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 5,
        messages: [{ role: "user", content: "ping" }],
      }),
    };
    if (signal) {
      init.signal = signal;
    }

    const response = await this.fetchImpl(endpointFor(baseUrl), init);

    if (!response.ok) {
      throw new Error(await extractHttpErrorMessage(response));
    }
    return { ok: true, model };
  }

  async organize(request: OrganizerRequest): Promise<OrganizerResult> {
    const baseUrl = this.config.baseUrl.trim();
    const model = this.config.model.trim();
    const apiKey = (this.config.apiKey || "").trim();
    const rationaleLanguage = request.rationaleLanguage === "zh-CN" ? "Simplified Chinese" : "English";

    if (!baseUrl || !model) {
      throw new Error("AI provider is not configured (Base URL and Model are required)");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const systemPrompt = `You are a precise, conservative bookmark organizer. Propose clean, high-confidence reorganization suggestions for the user's bookmarks.

Return ONLY a valid JSON object matching this schema:
{
  "suggestions": [
    {
      "id": "sug-1",
      "kind": "move",
      "nodeId": "exact_bookmark_id_from_input",
      "targetFolderPath": "Development/Tools",
      "confidence": 0.95,
      "rationale": "Group developer tools together with existing repositories"
    },
    {
      "id": "sug-2",
      "kind": "create-folder",
      "targetFolderPath": "Documentation",
      "confidence": 0.9,
      "rationale": "Aggregate scattered API references into a dedicated documentation folder"
    }
  ]
}

Rules:
1. Allowed "kind" values: "move", "create-folder", "merge-folder", "semantic-duplicate".
2. For "move", "nodeId" MUST match an existing bookmark "id" from the input, and "targetFolderPath" must be specified.
3. For "create-folder", specify "targetFolderPath".
4. For "semantic-duplicate", specify "nodeId" and "relatedNodeIds".
5. Confidence must be a number between 0.0 and 1.0.
6. Write the explanation in "rationale" using ${rationaleLanguage}. Provide concise, concrete reasons based on domain, topic, or content relationship (avoid empty generic phrases). Keep bookmark titles, URLs, and folder paths exactly as provided; do not translate those source values.
7. Prioritize organizing uncategorized root bookmarks into appropriate folders. Avoid unnecessary changes to well-organized subfolders.
8. If no reorganization is needed, return {"suggestions": []}.
9. Return no more than ${MAX_SUGGESTIONS_PER_RESPONSE} suggestions, prioritizing the highest-confidence changes.
10. Return JSON ONLY without conversational text or markdown code blocks.`;

    const requestBody = {
      model: this.config.model,
      temperature: 0.2,
      max_tokens: AI_MAX_OUTPUT_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(request) },
      ],
    };

    let response = await this.fetchImpl(endpointFor(this.config.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });

    // Fallback if provider doesn't support response_format
    if (!response.ok && response.status === 400) {
      const errorText = await response.clone().text();
      if (errorText.toLowerCase().includes("response_format")) {
        const fallbackBody = {
          model: this.config.model,
          temperature: 0.2,
          max_tokens: AI_MAX_OUTPUT_TOKENS,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(request) },
          ],
        };
        response = await this.fetchImpl(endpointFor(this.config.baseUrl), {
          method: "POST",
          headers,
          body: JSON.stringify(fallbackBody),
        });
      }
    }

    if (!response.ok) {
      throw new Error(await extractHttpErrorMessage(response));
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        finish_reason?: unknown;
        message?: { content?: unknown };
      }>;
    };
    const choice = payload.choices?.[0];
    const content = extractMessageContent(choice?.message?.content);
    if (!content) throw new Error("AI response did not contain JSON content");

    let parsed: unknown;
    try {
      parsed = extractAndParseJson(content);
    } catch (error) {
      const finishReason = String(choice?.finish_reason ?? "").toLowerCase();
      if (finishReason === "length" || finishReason === "max_tokens") {
        throw new Error("AI response was truncated before valid JSON was completed; try generating suggestions again");
      }
      throw error;
    }
    return validateOrganizerResult(parsed);
  }
}

function extractMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const textParts = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean);

  return textParts.length > 0 ? textParts.join("") : undefined;
}

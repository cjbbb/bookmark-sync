import { getFolderPath } from "./paths.js";
import { getHostname } from "./url.js";
import type { BookmarkRepository, OrganizerSuggestion } from "./types.js";

export interface BookmarkRule {
  id: string;
  hostname?: string;
  titleIncludes?: string;
  targetFolderPath: string;
  rationale?: string;
}

export function runRuleEngine(repository: BookmarkRepository, rules: BookmarkRule[]): OrganizerSuggestion[] {
  const suggestions: OrganizerSuggestion[] = [];
  for (const node of repository.nodes) {
    if (node.type !== "bookmark" || !node.url) continue;
    const currentPath = getFolderPath(repository, node.id);
    for (const rule of rules) {
      const hostnameMatches = !rule.hostname || getHostname(node.url) === rule.hostname.toLowerCase();
      const titleMatches = !rule.titleIncludes || node.title.toLowerCase().includes(rule.titleIncludes.toLowerCase());
      if (!hostnameMatches || !titleMatches || currentPath === rule.targetFolderPath) continue;
      suggestions.push({
        id: `rule-${rule.id}-${node.id}`,
        kind: "move",
        nodeId: node.id,
        targetFolderPath: rule.targetFolderPath,
        confidence: 1,
        rationale: rule.rationale ?? `Matched rule ${rule.id}`,
      });
      break;
    }
  }
  return suggestions;
}

const TRACKING_PARAMETERS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
]);

export function normalizeUrl(value: string): string {
  const input = value.trim();
  if (!input) return "";

  try {
    const parsed = new URL(input);
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";

    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }

    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }

    if ((parsed.protocol === "http:" && parsed.port === "80") ||
        (parsed.protocol === "https:" && parsed.port === "443")) {
      parsed.port = "";
    }

    return parsed.toString();
  } catch {
    return input.replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

export function getHostname(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

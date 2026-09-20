const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";

type Rule = { method: "GET" | "POST" | "PUT"; pattern: RegExp; query?: Set<string> };

const rules: Rule[] = [
  { method: "GET", pattern: /^\/api\/docgrid\/repositories$/ },
  { method: "POST", pattern: /^\/api\/docgrid\/repositories$/ },

  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/overview$`) },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/branches$`) },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/branches$`) },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/artifacts$`) },

  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/reviews$`) },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/issues$`) },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/issues$`) },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/releases$`) },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/releases$`) },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/ai-review$`) },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/activity$`), query: new Set(["limit"]) },

  { method: "GET", pattern: new RegExp(`^/api/docgrid/branches/${UUID}/documents$`) },
  { method: "PUT", pattern: new RegExp(`^/api/docgrid/branches/${UUID}/documents/${UUID}$`) },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/branches/${UUID}/commits$`), query: new Set(["limit"]) },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/branches/${UUID}/compare/${UUID}$`) },

  { method: "GET", pattern: new RegExp(`^/api/docgrid/commits/${UUID}$`) },

  { method: "POST", pattern: /^\/api\/docgrid\/reviews$/ },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/reviews/${UUID}/(?:merge|close)$`) },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/issues/${UUID}/decide$`) },
];

export function isAllowedDocGridRequest(method: string, pathname: string, searchParams: URLSearchParams): boolean {
  const normalizedMethod = method.toUpperCase();
  const rule = rules.find((item) => item.method === normalizedMethod && item.pattern.test(pathname));
  if (!rule) return false;

  const seen = new Set<string>();
  for (const [key, value] of searchParams.entries()) {
    if (!rule.query?.has(key) || seen.has(key)) return false;
    seen.add(key);
    if (key === "limit" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100)) return false;
  }
  return true;
}

export function readBearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token || token.length > 16_384 || /\s/.test(token)) return null;
  return token;
}

export function buildUpstreamUrl(base: string, originalUrl: string): URL {
  const relative = new URL(originalUrl, "https://docgrid.invalid");
  if (!relative.pathname.startsWith("/api/docgrid/")) throw new Error("Route is outside DocGrid API");
  return new URL(relative.pathname + relative.search, base.replace(/\/+$/, "") + "/");
}

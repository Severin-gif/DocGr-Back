const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";

export type BodyKind = "json" | "multipart";
export type ResponseKind = "json" | "binary";

type Rule = {
  method: "GET" | "POST" | "PUT";
  pattern: RegExp;
  query?: Set<string>;
  body?: BodyKind;
  response?: ResponseKind;
};

export type RouteRule = { body: BodyKind; response: ResponseKind; query?: Set<string> };

const rules: Rule[] = [
  // Human control plane. Agent credentials are rejected by the identity verifier.
  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/astra/catalog$`) },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/astra/grants$`) },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/astra/grants$`) },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/astra/grants/${UUID}/revoke$`) },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/astra/operations$`) },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/astra/operations/${UUID}$`) },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/astra/operations/${UUID}/(?:approve|cancel)$`) },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/astra/artifacts/${UUID}/versions/[1-9][0-9]{0,8}/(?:docx|pdf)$`), response: "binary" },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/astra/artifacts/${UUID}/versions/[1-9][0-9]{0,8}$`) },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/astra/artifacts/${UUID}/history$`) },
  { method: "GET", pattern: /^\/api\/docgrid\/repositories$/ },
  { method: "POST", pattern: /^\/api\/docgrid\/repositories$/ },
  { method: "PUT", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}$`) },

  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/overview$`) },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/branches$`) },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/branches$`) },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/artifacts$`) },

  // Файловое дерево, папки и исходные материалы (workspace v2)
  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/files$`), query: new Set(["trash"]) },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/folders$`) },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/materials$`), body: "multipart" },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/materials/${UUID}/download$`), response: "binary" },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/files/${UUID}/trash$`) },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/members$`) },
  { method: "PUT", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/members$`) },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/repositories/${UUID}/judgments/${UUID}$`) },

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
  { method: "POST", pattern: new RegExp(`^/api/docgrid/branches/${UUID}/documents/${UUID}/restore$`) },
  { method: "GET", pattern: new RegExp(`^/api/docgrid/branches/${UUID}/documents/${UUID}/comments$`) },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/branches/${UUID}/documents/${UUID}/comments$`) },

  { method: "GET", pattern: new RegExp(`^/api/docgrid/commits/${UUID}$`) },

  { method: "POST", pattern: /^\/api\/docgrid\/reviews$/ },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/reviews/${UUID}/(?:merge|close|refresh)$`) },
  { method: "POST", pattern: new RegExp(`^/api/docgrid/issues/${UUID}/decide$`) },
];

export function resolveDocGridRoute(method: string, pathname: string, searchParams: URLSearchParams): RouteRule | null {
  const normalizedMethod = method.toUpperCase();
  const rule = rules.find((item) => item.method === normalizedMethod && item.pattern.test(pathname));
  if (!rule) return null;

  const seen = new Set<string>();
  for (const [key, value] of searchParams.entries()) {
    if (!rule.query?.has(key) || seen.has(key)) return null;
    seen.add(key);
    if (key === "limit" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100)) return null;
    if (key === "trash" && value !== "true" && value !== "false") return null;
  }
  return { body: rule.body ?? "json", response: rule.response ?? "json", query: rule.query };
}

export function isAllowedDocGridRequest(method: string, pathname: string, searchParams: URLSearchParams): boolean {
  return resolveDocGridRoute(method, pathname, searchParams) !== null;
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

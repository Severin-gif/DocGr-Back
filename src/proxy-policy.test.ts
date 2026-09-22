import test from "node:test";
import assert from "node:assert/strict";
import { buildUpstreamUrl, isAllowedDocGridRequest, readBearer, resolveDocGridRoute } from "./proxy-policy.js";

const u = (path: string) => new URL(path, "https://api.docgrid.ru");

test("allows current DocGrid API and blocks internal/legacy paths", () => {
  assert.equal(isAllowedDocGridRequest("GET", "/api/docgrid/repositories", new URLSearchParams()), true);
  assert.equal(
    isAllowedDocGridRequest(
      "GET",
      "/api/docgrid/repositories/11111111-1111-4111-8111-111111111111/overview",
      new URLSearchParams(),
    ),
    true,
  );
  assert.equal(isAllowedDocGridRequest("GET", "/internal/docgrid/admin/events", new URLSearchParams()), false);
  assert.equal(isAllowedDocGridRequest("GET", "/api/projects", new URLSearchParams()), false);
  assert.equal(isAllowedDocGridRequest("DELETE", "/api/docgrid/repositories", new URLSearchParams()), false);
});

test("limits query parameters to bounded limit on list endpoints", () => {
  assert.equal(
    isAllowedDocGridRequest(
      "GET",
      "/api/docgrid/repositories/11111111-1111-4111-8111-111111111111/activity",
      new URLSearchParams("limit=50"),
    ),
    true,
  );
  assert.equal(
    isAllowedDocGridRequest(
      "GET",
      "/api/docgrid/repositories/11111111-1111-4111-8111-111111111111/activity",
      new URLSearchParams("limit=999"),
    ),
    false,
  );
  assert.equal(
    isAllowedDocGridRequest(
      "GET",
      "/api/docgrid/repositories/11111111-1111-4111-8111-111111111111/activity",
      new URLSearchParams("user=other"),
    ),
    false,
  );
});

test("accepts only one compact Bearer token", () => {
  assert.equal(readBearer("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(readBearer("Basic abc"), null);
  assert.equal(readBearer("Bearer abc def"), null);
  assert.equal(readBearer(undefined), null);
});

test("builds upstream URL without turning the gateway into an open proxy", () => {
  const target = buildUpstreamUrl(
    "https://sps.codex-chat.ru",
    "/api/docgrid/branches/11111111-1111-4111-8111-111111111111/commits?limit=25",
  );
  assert.equal(
    target.toString(),
    "https://sps.codex-chat.ru/api/docgrid/branches/11111111-1111-4111-8111-111111111111/commits?limit=25",
  );
  assert.throws(() => buildUpstreamUrl("https://sps.codex-chat.ru", "/internal/docgrid/admin/events"));
});

test("allows workspace v2 routes used by the current frontend", () => {
  const P = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const D = "33333333-3333-4333-8333-333333333333";
  const q = (s = "") => new URLSearchParams(s);
  assert.equal(isAllowedDocGridRequest("GET", `/api/docgrid/repositories/${P}/files`, q("trash=false")), true);
  assert.equal(isAllowedDocGridRequest("GET", `/api/docgrid/repositories/${P}/files`, q("trash=maybe")), false);
  assert.equal(isAllowedDocGridRequest("POST", `/api/docgrid/repositories/${P}/folders`, q()), true);
  assert.equal(isAllowedDocGridRequest("POST", `/api/docgrid/repositories/${P}/files/${D}/trash`, q()), true);
  assert.equal(isAllowedDocGridRequest("GET", `/api/docgrid/repositories/${P}/members`, q()), true);
  assert.equal(isAllowedDocGridRequest("PUT", `/api/docgrid/repositories/${P}/members`, q()), true);
  assert.equal(isAllowedDocGridRequest("GET", `/api/docgrid/repositories/${P}/judgments/${B}`, q()), true);
  assert.equal(isAllowedDocGridRequest("POST", `/api/docgrid/branches/${B}/documents/${D}/restore`, q()), true);
  assert.equal(isAllowedDocGridRequest("GET", `/api/docgrid/branches/${B}/documents/${D}/comments`, q()), true);
  assert.equal(isAllowedDocGridRequest("POST", `/api/docgrid/branches/${B}/documents/${D}/comments`, q()), true);
  assert.equal(isAllowedDocGridRequest("POST", `/api/docgrid/reviews/${D}/refresh`, q()), true);
  // legal-core admin/internal routes stay closed
  assert.equal(isAllowedDocGridRequest("GET", "/api/docgrid/summary", q()), false);
  assert.equal(isAllowedDocGridRequest("GET", "/api/docgrid/events", q()), false);
  assert.equal(isAllowedDocGridRequest("POST", "/api/docgrid/backup", q()), false);
  assert.equal(isAllowedDocGridRequest("GET", "/api/docgrid/backup-status", q()), false);
});

test("marks materials upload as multipart and download as binary", () => {
  const P = "11111111-1111-4111-8111-111111111111";
  const M = "44444444-4444-4444-8444-444444444444";
  const q = new URLSearchParams();
  assert.deepEqual(
    { ...resolveDocGridRoute("POST", `/api/docgrid/repositories/${P}/materials`, q), query: undefined },
    { body: "multipart", response: "json", query: undefined },
  );
  assert.deepEqual(
    { ...resolveDocGridRoute("GET", `/api/docgrid/repositories/${P}/materials/${M}/download`, q), query: undefined },
    { body: "json", response: "binary", query: undefined },
  );
  assert.equal(resolveDocGridRoute("GET", "/api/docgrid/repositories", q)?.body, "json");
  assert.equal(resolveDocGridRoute("GET", "/api/docgrid/repositories", q)?.response, "json");
});

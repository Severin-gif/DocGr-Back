import test from "node:test";
import assert from "node:assert/strict";
import { buildUpstreamUrl, isAllowedDocGridRequest, readBearer } from "./proxy-policy.js";

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

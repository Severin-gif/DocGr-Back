import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createAstraRouter, readAgentToken } from "./astra-proxy.js";
import { isAllowedDocGridRequest } from "./proxy-policy.js";

const token = "dga_" + "a".repeat(43);
const projectId = "11111111-1111-4111-8111-111111111111";
const artifactId = "22222222-2222-4222-8222-222222222222";
const toolPath = "/api/docgrid/astra/tools/docgrid_get_capabilities";

test("agent bearer cannot be substituted with chat or human JWT", () => {
  assert.equal(readAgentToken(`Bearer ${token}`), token);
  for (const value of ["Bearer human.jwt.signature", "Bearer dga_short", `Bearer ${token} bad`, undefined]) {
    assert.equal(readAgentToken(value), null);
  }
  const q = new URLSearchParams();
  assert.equal(isAllowedDocGridRequest("POST", toolPath, q), false);
  assert.equal(isAllowedDocGridRequest("POST", `/api/docgrid/repositories/${projectId}/astra/operations/${artifactId}/approve`, q), true);
  assert.equal(isAllowedDocGridRequest("POST", `/api/docgrid/repositories/${projectId}/astra/operations/${artifactId}/approve`, new URLSearchParams("actor=admin")), false);
});

test("direct adapter isolates credentials, rejects unknown routes and bounds downloads", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  let mock = new Response(JSON.stringify({ actions: ["docgrid_get_project"] }), { headers: { "content-type": "application/json" } });
  const app = express();
  app.use(express.json());
  app.use("/api/docgrid/astra", createAstraRouter({
    upstream: "https://legal-core.invalid",
    serviceToken: "server-only",
    timeoutMs: 1000,
    maxResponseBytes: 1024,
    fetcher: (async (url, init) => {
      seen.push({ url: String(url), init: init! });
      return new Response(await mock.clone().arrayBuffer(), { status: mock.status, headers: mock.headers });
    }) as typeof fetch,
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, credential = token) => fetch(base + path, {
    method: "POST", headers: {
      Authorization: `Bearer ${credential}`, "Content-Type": "application/json",
      "X-DocGrid-Subject": "spoofed-human", "X-DocGrid-Service-Token": "spoofed-secret",
      Cookie: "session=forged",
    }, body: JSON.stringify({ projectId, runId: "fixture", traceId: "trace", input: {} }),
  });
  try {
    assert.equal((await post(toolPath, "human.jwt.signature")).status, 401);
    assert.equal(seen.length, 0);
    assert.equal((await post(toolPath)).status, 200);
    const headers = new Headers(seen[0]!.init.headers);
    assert.equal(headers.get("x-docgrid-agent-token"), token);
    assert.equal(headers.get("x-docgrid-service-token"), "server-only");
    for (const key of ["authorization", "cookie", "x-docgrid-subject", "x-docgrid-email", "x-docgrid-role"]) assert.equal(headers.get(key), null);
    for (const path of ["/api/docgrid/astra/approve", toolPath + "?target=other", "/api/docgrid/astra/tools/http_request"]) assert.equal((await post(path)).status, 404);
    assert.equal(seen.length, 1);
    mock = new Response("x".repeat(1025), { headers: { "content-type": "application/pdf" } });
    const file = `/api/docgrid/astra/artifacts/${artifactId}/versions/1/pdf?projectId=${projectId}`;
    assert.equal((await fetch(base + file, { headers: { Authorization: `Bearer ${token}` } })).status, 502);
    mock = new Response("%PDF-synthetic", { headers: { "content-type": "application/pdf" } });
    const result = await fetch(base + file, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(result.headers.get("content-type"), "application/pdf");
    assert.equal(await result.text(), "%PDF-synthetic");
    assert.equal((await fetch(base + file + "&projectId=" + projectId, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
    mock = new Response("<h1>upstream exception</h1>", { headers: { "content-type": "text/html" } });
    const error = await post(toolPath);
    assert.equal(error.status, 502);
    assert.doesNotMatch(await error.text(), /upstream exception/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

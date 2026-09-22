import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.LEGAL_CORE_URL = "https://sps.codex-chat.ru";
process.env.DOCGRID_IDENTITY_JWT_SECRET = "a".repeat(64);
process.env.DOCGRID_SERVICE_TOKEN = "b".repeat(64);
process.env.DOCGRID_IDENTITY_ISSUER = "ai-orchestra";
process.env.DOCGRID_IDENTITY_AUDIENCE = "legal-core-docgrid";

const { verifyDocGridAccessToken, trustedIdentityHeaders } = await import("./docgrid-identity.js");

function sign(payload: Record<string, unknown>, secret = process.env.DOCGRID_IDENTITY_JWT_SECRET!) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

const now = 1_800_000_000;
const payload = {
  sub: "user-1",
  email: "User@Example.com",
  name: "User",
  role: "USER",
  plan: "pro",
  typ: "docgrid_access",
  iss: "ai-orchestra",
  aud: "legal-core-docgrid",
  iat: now - 10,
  exp: now + 300,
};

test("verifies AI-Orchestra DocGrid token and converts it to trusted headers", () => {
  const identity = verifyDocGridAccessToken(sign(payload), now);
  assert.equal(identity.sub, "user-1");
  const headers = trustedIdentityHeaders(identity);
  assert.equal(headers["X-DocGrid-Service-Token"], "b".repeat(64));
  assert.equal(headers["X-DocGrid-Subject"], "user-1");
  assert.equal(headers["X-DocGrid-Email"], "user@example.com");
  assert.equal(headers["X-DocGrid-Role"], "USER");
  assert.equal(headers["X-DocGrid-Plan"], "pro");
  assert.equal("Authorization" in headers, false);
});

test("rejects token signed with another secret", () => {
  assert.throws(
    () => verifyDocGridAccessToken(sign(payload, "z".repeat(64)), now),
    /bad_signature/,
  );
});

test("rejects expired or wrong-audience identity tokens", () => {
  assert.throws(
    () => verifyDocGridAccessToken(sign({ ...payload, exp: now - 1 }), now),
    /invalid_claims/,
  );
  assert.throws(
    () => verifyDocGridAccessToken(sign({ ...payload, aud: "other-service" }), now),
    /invalid_claims/,
  );
});

import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

export type DocGridIdentity = {
  sub: string;
  email: string;
  name?: string | null;
  role: "USER" | "ADMIN";
  plan: "free" | "basic" | "standard" | "pro" | "business";
  typ: "docgrid_access";
  iss: string;
  aud: string | string[];
  iat?: number;
  exp: number;
};

function decodeBase64UrlJson<T>(value: string): T {
  const json = Buffer.from(value, "base64url").toString("utf8");
  return JSON.parse(json) as T;
}

function audienceMatches(aud: string | string[]): boolean {
  return Array.isArray(aud)
    ? aud.includes(config.DOCGRID_IDENTITY_AUDIENCE)
    : aud === config.DOCGRID_IDENTITY_AUDIENCE;
}

export function verifyDocGridAccessToken(token: string, nowSeconds = Math.floor(Date.now() / 1000)): DocGridIdentity {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed_token");
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = decodeBase64UrlJson<{ alg?: string; typ?: string }>(headerB64);
  if (header.alg !== "HS256") throw new Error("unsupported_algorithm");

  const expected = createHmac("sha256", config.DOCGRID_IDENTITY_JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const supplied = Buffer.from(signatureB64, "base64url");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new Error("bad_signature");
  }

  const payload = decodeBase64UrlJson<Partial<DocGridIdentity>>(payloadB64);
  if (
    payload.typ !== "docgrid_access" ||
    payload.iss !== config.DOCGRID_IDENTITY_ISSUER ||
    !payload.aud ||
    !audienceMatches(payload.aud) ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.email !== "string" ||
    !payload.email ||
    !["USER", "ADMIN"].includes(payload.role ?? "") ||
    !["free", "basic", "standard", "pro", "business"].includes(payload.plan ?? "") ||
    typeof payload.exp !== "number" ||
    payload.exp <= nowSeconds
  ) {
    throw new Error("invalid_claims");
  }

  if (payload.iat !== undefined && (typeof payload.iat !== "number" || payload.iat > nowSeconds + 60)) {
    throw new Error("invalid_iat");
  }

  return payload as DocGridIdentity;
}

export function trustedIdentityHeaders(identity: DocGridIdentity): Record<string, string> {
  const headers: Record<string, string> = {
    "X-DocGrid-Service-Token": config.DOCGRID_SERVICE_TOKEN,
    "X-DocGrid-Subject": identity.sub,
    "X-DocGrid-Email": identity.email.trim().toLowerCase(),
    "X-DocGrid-Role": identity.role,
    "X-DocGrid-Plan": identity.plan,
  };
  const name = identity.name?.trim();
  if (name) headers["X-DocGrid-Name"] = name.slice(0, 200);
  return headers;
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export type AgentTransportOptions = {
  upstream: string; serviceToken: string; timeoutMs: number; maxResponseBytes: number;
  publicOrigin: string; allowedOrigins: string[]; fetcher?: typeof fetch;
};
export const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
export class UpstreamError extends Error {
  constructor(public status: number) { super('DocGrid request failed'); }
}
export async function agentJson(options: AgentTransportOptions, path: string, token?: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const response = await (options.fetcher ?? fetch)(new URL(path, options.upstream), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-DocGrid-Service-Token': options.serviceToken,
      ...(token ? { 'X-DocGrid-Agent-Token': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new UpstreamError(response.status); }
  if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); throw new UpstreamError(502); }
  const reader = response.body?.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
  try {
    if (reader) while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length;
      if (bytes > options.maxResponseBytes) { await reader.cancel(); throw new UpstreamError(502); }
      parts.push(part.value);
    }
  } finally { reader?.releaseLock(); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
// Purpose-separated authenticated encryption: no grant is present in callback URLs,
// client registration IDs, or the durable code store in plaintext.
export function seal(secret: string, purpose: string, value: unknown): string {
  const key = createHash('sha256').update(`docgrid:${purpose}:`).update(secret).digest();
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64url');
}
export function unseal(secret: string, purpose: string, value: string): any {
  if (!/^[A-Za-z0-9_-]{32,8192}$/.test(value)) throw new Error('Invalid token');
  const data = Buffer.from(value, 'base64url');
  const key = createHash('sha256').update(`docgrid:${purpose}:`).update(secret).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  const result = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
  if (!record(result) || (typeof result.exp === 'number' && result.exp <= Date.now())) throw new Error('Expired token');
  return result;
}

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

export type AstraDb = Prisma.TransactionClient;
export type AstraContext = {
  operationId: string; projectId: string; ownerId: string; grantId: string;
  agentRef: string; runId: string; requestKey: string; traceId: string;
  allowedSourceIds: string[] | null;
  principalKind?: 'human' | 'agent'; humanActorId?: string;
};
export type AstraDomainResult = {
  status?: 'completed' | 'needs_user_action'; output: unknown;
  nextAction?: string; approval?: unknown;
};
export type AstraOperation = {
  id: string; projectId: string; grantId: string; tool: string; runId: string;
  requestKey: string; traceId: string; status: string; input: Record<string, unknown>;
  result: unknown; approval: unknown; approvalDigest: string | null;
  error: unknown; createdAt: Date; updatedAt: Date;
  passport?: unknown;
};
export const ASTRA_CATALOG_VERSION = 'docgrid-agents-v1.1.0';
export const ASTRA_SPEC_VERSION = 'DOCGRID-AGENTS/1.1';

export function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Expected an object');
  return value as Record<string, unknown>;
}
export function assertKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const extras = Object.keys(input).filter(key => !allowed.includes(key));
  if (extras.length) throw new BadRequestException(`Unknown fields: ${extras.slice(0, 10).map(key => key.slice(0, 80)).join(', ')}${extras.length > 10 ? ' (additional fields omitted)' : ''}`);
}
export function stringInput(input: Record<string, unknown>, key: string, max = 500, required = true): string {
  const value = input[key];
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000]/.test(value)) {
    throw new BadRequestException(`Invalid ${key}`);
  }
  return value.trim();
}
export function uuidInput(input: Record<string, unknown>, key: string, required = true): string {
  const value = stringInput(input, key, 36, required);
  if (!value && !required) return '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new BadRequestException(`Invalid ${key}`);
  return value;
}
export function integerInput(input: Record<string, unknown>, key: string, min: number, max: number, fallback?: number): number {
  const value = input[key] === undefined ? fallback : input[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new BadRequestException(`Invalid ${key}`);
  return value;
}
export function canonical(value: unknown, depth = 0): string {
  if (depth > 30) throw new BadRequestException('Input nesting limit exceeded');
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  throw new BadRequestException('Unsupported JSON value');
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function unsupported(tool: string): never { throw new BadRequestException({ code: 'UNSUPPORTED', message: `Unsupported DocGrid capability: ${tool}` }); }

/** Persist provenance, never a second copy of uploaded originals in the operation ledger.
 * The caller computes bodyDigest from the original input before invoking this function.
 * Invalid payloads are summarized too, since failed operations are also durable.
 */
export function persistedOperationInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  if (tool !== 'docgrid_upload_sources') return input;
  const files = Array.isArray(input.files) ? input.files : [];
  const folders = Array.isArray(input.folders) ? input.folders : [];
  const boundedText = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : null;
  return {
    payloadRedacted: true, fileCount: files.length, folderCount: folders.length,
    files: files.slice(0, 64).map((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { index, invalid: true, inputDigest: digest(value) };
      const file = value as Record<string, unknown>, encoded = file.contentBase64;
      let byteSize: number | null = null, contentSha256: string | null = null;
      if (typeof encoded === 'string' && encoded.length <= 819200 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') === encoded) { byteSize = bytes.length; contentSha256 = createHash('sha256').update(bytes).digest('hex'); }
      }
      return { index, name: boundedText(file.name, 180), path: boundedText(file.path, 500), mimeType: boundedText(file.mimeType, 150),
        byteSize, contentSha256, encodedCharacters: typeof encoded === 'string' ? encoded.length : null, inputDigest: digest(value) };
    }),
    folders: folders.slice(0, 128).map(value => typeof value === 'string' ? value.slice(0, 500) : { invalid: true, inputDigest: digest(value) }),
    omittedFiles: Math.max(0, files.length - 64), omittedFolders: Math.max(0, folders.length - 128),
  };
}


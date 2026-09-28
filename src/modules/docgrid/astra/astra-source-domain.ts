import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function strictKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) {
    throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Unexpected input fields' });
  }
}
export function textField(input: Record<string, unknown>, key: string, max = 500, optional = false): string {
  const value = input[key];
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || !value.length || value.length > max) throw new BadRequestException({ code: 'INVALID_INPUT', field: key });
  return value;
}
export function idField(input: Record<string, unknown>, key: string): string {
  const value = textField(input, key, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new BadRequestException({ code: 'INVALID_INPUT', field: key });
  return value;
}
export function boundedInt(input: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = input[key] === undefined ? fallback : input[key];
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new BadRequestException({ code: 'INVALID_INPUT', field: key });
  return value as number;
}
export function scopeSource(ids: string[] | null, sourceId: string) {
  if (ids !== null && !ids.includes(sourceId)) throw new ForbiddenException({ code: 'SOURCE_OUT_OF_SCOPE' });
}
export function normalizedPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 500 || !value.startsWith('/') || /[\x00-\x1f\\]/.test(value)) throw new BadRequestException({ code: 'INVALID_PATH' });
  const parts = value.split('/').filter(Boolean);
  if (parts.some(p => p === '.' || p === '..')) throw new BadRequestException({ code: 'INVALID_PATH' });
  return '/' + parts.join('/');
}
export function makeCursor(secret: string, binding: unknown, position: number): string {
  const payload = Buffer.from(JSON.stringify({ binding, position })).toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}
export function readCursor(secret: string, binding: unknown, cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor.length > 4096) throw new BadRequestException({ code: 'INVALID_CURSOR' });
  const parts = cursor.split('.');
  const expected = createHmac('sha256', secret).update(parts[0] || '').digest('base64url');
  if (parts.length !== 2 || parts[1].length !== expected.length || !timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) throw new BadRequestException({ code: 'INVALID_CURSOR' });
  try {
    const decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (JSON.stringify(decoded.binding) !== JSON.stringify(binding) || !Number.isInteger(decoded.position) || decoded.position < 0) throw new Error();
    return decoded.position;
  } catch { throw new BadRequestException({ code: 'CURSOR_SCOPE_MISMATCH' }); }
}
export function sliceSource(content: string, start: number, maxChars: number) {
  if (start > content.length) throw new BadRequestException({ code: 'LOCATOR_OUT_OF_RANGE' });
  let end = Math.min(start + maxChars, content.length);
  // UTF-16 offsets are exact JS string offsets. Do not split a surrogate pair.
  if (end < content.length && end > start && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
  return { text: content.slice(start, end), locator: { kind: 'text_range', unit: 'utf16', start, end }, truncated: end < content.length };
}
export function exactDecimal(value: string): bigint {
  if (!/^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(value)) throw new BadRequestException({ code: 'UNRECOGNIZED_AMOUNT', message: 'Expected decimal amount with at most 2 fraction digits' });
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const units = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -units : units;
}
export function sumDecimals(values: string[]): string {
  const total = values.reduce((s, v) => s + exactDecimal(v), 0n);
  const abs = total < 0n ? -total : total;
  return (total < 0n ? '-' : '') + (abs / 100n).toString() + '.' + (abs % 100n).toString().padStart(2, '0');
}
export function assertRevision(actual: string, expected: unknown) {
  if (typeof expected !== 'string' || actual !== expected) throw new ConflictException({ code: 'STALE_TREE_REVISION', actualRevision: actual });
}


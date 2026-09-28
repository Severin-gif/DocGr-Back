import { exactDecimal, makeCursor, readCursor, sha256, sliceSource, sumDecimals } from './astra-source-domain';

describe('Astra immutable source primitives', () => {
  it('pages a large UTF16 text losslessly without implying original coverage', () => {
    const source = ('абв😀строка\n').repeat(20000);
    let offset = 0, result = '';
    while (offset < source.length) { const part = sliceSource(source, offset, 113); expect(part.text.length).toBeLessThanOrEqual(113); result += part.text; offset = part.locator.end; }
    expect(result).toBe(source); expect(sha256(result)).toBe(sha256(source));
  });
  it('binds continuation to project, grant, snapshot, version and filter', () => {
    const scope = { projectId: 'p', grantId: 'g', snapshotId: 's', sourceId: 'f', version: 'v', filter: 'text' };
    const cursor = makeCursor('secret', scope, 100);
    expect(readCursor('secret', scope, cursor)).toBe(100);
    for (const key of Object.keys(scope)) expect(() => readCursor('secret', { ...scope, [key]: 'other' }, cursor)).toThrow();
    expect(() => readCursor('other-secret', scope, cursor)).toThrow();
    expect(() => readCursor('secret', scope, cursor + 'x')).toThrow();
  });
  it('uses exact cents, preserves negatives, rejects missing/ambiguous/overprecise values', () => {
    expect(sumDecimals(['0.10', '0.20', '-0.01', '1000000000000000.99'])).toBe('1000000000000001.28');
    for (const value of ['', ' ', '—', '1,25', '1.234', 'NaN', '1e3', ' 12.50', '12.50 руб.']) expect(() => exactDecimal(value)).toThrow();
  });
});


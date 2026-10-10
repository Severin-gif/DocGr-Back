import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDocGridTokenAccess } from './product-access';

const now = Date.parse('2026-10-10T08:00:00Z');
const end = new Date(now + 3600000).toISOString();
const access = (sources: unknown[]) => ({ version: 1, workspace: true, subscriptionAccess: true,
  checkoutEnabled: false, sources: [{ kind: 'early_access', validUntil: null }, ...sources] });

test('legacy tokens retain early access without deriving paid rights from a global CODEX plan', () => {
  assert.equal(resolveDocGridTokenAccess(undefined, now).workspace, true);
  assert.equal(resolveDocGridTokenAccess(undefined, now).subscriptionAccess, false);
});
test('paid claims expire at the exact period boundary even while the identity JWT is still valid', () => {
  const claim = access([{ kind: 'codex_pro', validUntil: end }]);
  assert.equal(resolveDocGridTokenAccess(claim, now).subscriptionAccess, true);
  assert.equal(resolveDocGridTokenAccess(claim, Date.parse(end)).subscriptionAccess, false);
  assert.equal(resolveDocGridTokenAccess(claim, Date.parse(end)).workspace, true);
});
test('an independent DocGrid period survives CODEX expiry and vice versa', () => {
  for (const kinds of [['codex_pro', 'docgrid_subscription'], ['docgrid_subscription', 'codex_pro']]) {
    const claim = access([{ kind: kinds[0], validUntil: new Date(now).toISOString() }, { kind: kinds[1], validUntil: end }]);
    assert.equal(resolveDocGridTokenAccess(claim, now).subscriptionAccess, true);
    assert.equal(resolveDocGridTokenAccess(claim, Date.parse(end)).subscriptionAccess, false);
  }
});
test('signed but malformed access claims fail closed', () => {
  for (const claim of [null, {}, access([{ kind: 'document_license', validUntil: null }]),
    access([{ kind: 'docgrid_subscription', validUntil: null }]), access([{ kind: 'codex_pro', validUntil: 'invalid' }]),
    access([{ kind: 'early_access', validUntil: null }])]) {
    assert.throws(() => resolveDocGridTokenAccess(claim, now), /invalid_product_access/);
  }
});

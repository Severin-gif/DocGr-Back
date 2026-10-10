export type DocGridAccessSource = {
  kind: 'early_access' | 'codex_pro' | 'docgrid_subscription' | 'legacy_business';
  validUntil: string | null;
};
export type DocGridAccess = {
  version: 1;
  workspace: true;
  subscriptionAccess: boolean;
  sources: DocGridAccessSource[];
  checkoutEnabled: false;
};

/** Only call after verifying the dedicated identity token's signature and audience. */
export function resolveDocGridTokenAccess(claim: unknown, nowMs = Date.now()): DocGridAccess {
  if (claim === undefined) {
    // Older issuers remain compatible. A global CODEX plan never invents paid DocGrid rights.
    return { version: 1, workspace: true, subscriptionAccess: false,
      sources: [{ kind: 'early_access', validUntil: null }], checkoutEnabled: false };
  }
  const access = claim as Partial<DocGridAccess> | null;
  if (!access || access.version !== 1 || access.workspace !== true ||
    typeof access.subscriptionAccess !== 'boolean' || access.checkoutEnabled !== false ||
    !Array.isArray(access.sources) || access.sources.length < 1 || access.sources.length > 4) {
    throw new Error('invalid_product_access');
  }
  const kinds = new Set(['early_access', 'codex_pro', 'docgrid_subscription', 'legacy_business']);
  const seen = new Set<string>();
  const sources: DocGridAccessSource[] = [];
  for (const source of access.sources) {
    if (!source || !kinds.has(source.kind) || seen.has(source.kind) ||
      !(source.validUntil === null || typeof source.validUntil === 'string' && Number.isFinite(Date.parse(source.validUntil))) ||
      source.kind === 'early_access' && source.validUntil !== null ||
      source.kind === 'docgrid_subscription' && source.validUntil === null) {
      throw new Error('invalid_product_access');
    }
    seen.add(source.kind);
    if (source.validUntil === null || Date.parse(source.validUntil) > nowMs) {
      sources.push({ kind: source.kind, validUntil: source.validUntil });
    }
  }
  if (!seen.has('early_access')) throw new Error('invalid_product_access');
  return { version: 1, workspace: true, subscriptionAccess: sources.some(source => source.kind !== 'early_access'),
    sources, checkoutEnabled: false };
}

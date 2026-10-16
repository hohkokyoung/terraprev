import type { CostReport, TfResource } from '../../../shared/types.ts';
import { UTILITY_PROVIDERS } from '../graph/catalog.ts';
import { emptyResult, type PricingResult, type ProviderPricer } from './types.ts';

export async function estimate(
  pricers: ProviderPricer[],
  all: TfResource[],
  region: string,
  nodeOf: Map<string, string>,
): Promise<CostReport> {
  const managed = all.filter((r) => r.mode === 'managed' && !UTILITY_PROVIDERS.has(r.provider));
  const byProvider = new Map<string, TfResource[]>();
  for (const r of managed) byProvider.set(r.provider, [...(byProvider.get(r.provider) ?? []), r]);

  const results: PricingResult[] = [];
  for (const [provider, resources] of byProvider) {
    const pricer = pricers.find((p) => p.provider === provider);
    if (!pricer) {
      const res = emptyResult();
      for (const r of resources) {
        res.unpriced.push({ address: r.address, type: r.type, nodeId: nodeOf.get(r.address), reason: `No price source for provider "${provider}" yet` });
      }
      results.push(res);
      continue;
    }
    try {
      results.push(await pricer.estimate({ resources, all: managed, region, nodeOf }));
    } catch (err) {
      const res = emptyResult();
      res.errors.push(`${provider}: ${(err as Error).message}`);
      for (const r of resources) res.unpriced.push({ address: r.address, type: r.type, nodeId: nodeOf.get(r.address), reason: 'Price source failed to load' });
      results.push(res);
    }
  }

  return {
    currency: 'USD',
    region,
    status: results.some((r) => r.errors.length) && !results.some((r) => r.components.length) ? 'error' : 'ready',
    components: results.flatMap((r) => r.components),
    usage: results.flatMap((r) => r.usage),
    unpriced: results.flatMap((r) => r.unpriced),
    free: results.flatMap((r) => r.free),
    sources: results.flatMap((r) => r.sources),
    errors: results.flatMap((r) => r.errors),
    savings: results.flatMap((r) => r.savings),
  };
}

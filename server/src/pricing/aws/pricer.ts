import type { TfResource, UsageParam } from '../../../../shared/types.ts';
import { emptyResult, type PricingInput, type PricingResult, type ProviderPricer } from '../types.ts';
import { FREE_TYPES, MAPPERS, type MapperApi } from './mappers.ts';
import { offerUrl, pricingPage, type AwsOffers, type OfferSet } from './offers.ts';

export class AwsPricer implements ProviderPricer {
  readonly provider = 'aws';
  private readonly offers: AwsOffers;

  constructor(offers: AwsOffers) {
    this.offers = offers;
  }

  async estimate({ resources, all, region, nodeOf }: PricingInput): Promise<PricingResult> {
    const res = emptyResult();

    // 1. Which offer files do we need?
    const needed = new Set<string>();
    for (const r of resources) for (const s of MAPPERS[r.type]?.services(r) ?? []) needed.add(s);

    // 2. Load them (cached on disk; first run streams from AWS).
    const loaded = new Map<string, OfferSet>();
    await Promise.all(
      [...needed].map(async (svc) => {
        try {
          const set = await this.offers.load(svc, region);
          loaded.set(svc, set);
          res.sources.push({ name: `AWS Price List · ${svc} · ${region}`, publishedAt: set.publishedAt, fetchedAt: set.fetchedAt, pageUrl: pricingPage(svc), dataUrl: offerUrl(svc, region) });
        } catch (err) {
          res.errors.push(`${svc}: ${(err as Error).message}`);
        }
      }),
    );

    // Parallel loads finish in any order; keep the list stable.
    res.sources.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    res.errors.sort();

    // 3. Price each resource.
    for (const r of resources) {
      const nodeId = nodeOf.get(r.address) ?? r.address;
      const mapper = MAPPERS[r.type];
      if (!mapper) {
        if (r.type === 'aws_acm_certificate' && r.attrs.certificate_authority_arn) {
          res.unpriced.push({ address: r.address, type: r.type, nodeId, reason: 'Private CA certificates are billed per certificate (not mapped yet)' });
        } else if (FREE_TYPES.some((re) => re.test(r.type))) res.free.push({ address: r.address, type: r.type });
        else res.unpriced.push({ address: r.address, type: r.type, nodeId, reason: `No pricing rule for ${r.type} yet` });
        continue;
      }
      mapper.price(this.api(r, nodeId, all, loaded, res));
    }
    return res;
  }

  private api(r: TfResource, nodeId: string, all: TfResource[], offers: Map<string, OfferSet>, res: PricingResult): MapperApi {
    const add: (kind: 'fixed' | 'usage') => MapperApi['usage'] = (kind) => (service, name, q, base, keys, note) => {
      const set = offers.get(service);
      if (!set) {
        res.unpriced.push({ address: r.address, type: r.type, nodeId, reason: `${name}: ${service} price list unavailable` });
        return;
      }
      const match = set.find(q);
      if (!match) {
        res.unpriced.push({ address: r.address, type: r.type, nodeId, reason: `${name}: no ${service} price for ${JSON.stringify(q)}` });
        return;
      }
      res.components.push({
        id: `${r.address}:${name}`,
        nodeId,
        address: r.address,
        name,
        unit: match.unit,
        tiers: match.tiers,
        quantity: keys.length ? { base, usage: keys } : { base },
        kind,
        source: `AWS Price List · ${service}`,
        pageUrl: pricingPage(service, q.usageType),
        dataUrl: offerUrl(service, set.region),
        sku: match.sku,
        priceDescription: match.description,
        note,
        freeTier: match.free && { pool: `${service}:${q.free ?? q.usageType}`, ...match.free },
      });
    };
    const usage = add('usage');
    return {
      r,
      a: r.attrs,
      find: (type, pred) => all.find((x) => x.type === type && pred(x)),
      fixed: (service, name, q, qty, note) => add('fixed')(service, name, q, qty, [], note),
      usage,
      param: (id, label, unit, def, max, scale = 'log') => {
        const key = `${r.address}:${id}`;
        const p: UsageParam = { key, nodeId, address: r.address, label, unit, default: def, min: 0, max, scale };
        res.usage.push(p);
        return key;
      },
      unpriced: (reason) => res.unpriced.push({ address: r.address, type: r.type, nodeId, reason }),
    };
  }
}

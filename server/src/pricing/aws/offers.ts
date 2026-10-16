// AWS Price List Bulk API: public, no credentials.
// https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/current/<region>/index.csv
//
// Files are big (EC2 ≈ 300 MB per region), so we stream them once, keep only
// On-Demand rows we might need, and cache the slim result on disk.

import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PriceTier, PriceProgress } from '../../../../shared/types.ts';

const BASE = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws';

export const offerUrl = (service: string, region: string) => `${BASE}/${service}/current/${region}/index.csv`;

/** Official pricing pages, for people. The bulk CSVs above are what the numbers come from. */
export const PRICING_PAGES: Record<string, string> = {
  AmazonEC2: 'https://aws.amazon.com/ec2/pricing/on-demand/',
  AmazonVPC: 'https://aws.amazon.com/vpc/pricing/',
  AWSELB: 'https://aws.amazon.com/elasticloadbalancing/pricing/',
  AmazonRDS: 'https://aws.amazon.com/rds/pricing/',
  AWSLambda: 'https://aws.amazon.com/lambda/pricing/',
  AmazonApiGateway: 'https://aws.amazon.com/api-gateway/pricing/',
  AWSQueueService: 'https://aws.amazon.com/sqs/pricing/',
  AmazonSNS: 'https://aws.amazon.com/sns/pricing/',
  AmazonS3: 'https://aws.amazon.com/s3/pricing/',
  AmazonDynamoDB: 'https://aws.amazon.com/dynamodb/pricing/',
  AWSSecretsManager: 'https://aws.amazon.com/secrets-manager/pricing/',
  AmazonCloudWatch: 'https://aws.amazon.com/cloudwatch/pricing/',
  AmazonCognito: 'https://aws.amazon.com/cognito/pricing/',
};

/** Some charges live in one offer file but are documented on another service's page. */
export function pricingPage(service: string, usageType = ''): string | undefined {
  if (usageType.startsWith('NatGateway')) return 'https://aws.amazon.com/vpc/pricing/';
  if (usageType.startsWith('EBS:')) return 'https://aws.amazon.com/ebs/pricing/';
  return PRICING_PAGES[service];
}

export interface OfferRow {
  sku: string;
  usageType: string;
  operation: string;
  unit: string;
  price: number;
  from: number;
  to: number | null;
  desc: string;
  attrs: Record<string, string>;
  /** Set on 1-year No Upfront Reserved rows (same SKU as the on-demand row). Unset = on-demand. */
  term?: 'reserved';
}

export interface PriceMatch {
  tiers: PriceTier[];
  unit: string;
  sku: string;
  description: string;
  /** Size of a free band that was stripped from the front of the tiers (e.g. SNS's first 1M). */
  free?: { allowance: number; label: string };
}

export interface Query {
  /** usageType without the region prefix, e.g. "BoxUsage:t3.micro" or "NatGateway-Hours". */
  usageType?: string;
  operation?: string;
  /** Column → accepted value(s). With several values, earlier ones win. */
  attrs?: Record<string, string | string[]>;
  /** usageType of a separate "Global-…" free tier row that applies to this charge (e.g. Global-Request for Lambda). */
  free?: string;
}

/** Columns kept per service, on top of the core ones. Everything else is dropped. */
const EXTRA_COLUMNS: Record<string, string[]> = {
  AmazonEC2: ['Instance Type', 'Operating System', 'Tenancy', 'Pre Installed S/W', 'CapacityStatus', 'License Model', 'Volume API Name'],
  AmazonRDS: ['Instance Type', 'Database Engine', 'Deployment Option', 'License Model', 'Volume Type'],
};

/** Row pre-filters, to keep the cache small. */
const KEEP: Record<string, (r: Record<string, string>) => boolean> = {
  AmazonEC2: (r) => {
    const fam = r['Product Family'];
    if (fam === 'Compute Instance' || fam === 'Compute Instance (bare metal)') {
      return r['Operating System'] === 'Linux' && r['Tenancy'] === 'Shared' && r['Pre Installed S/W'] === 'NA' && r['CapacityStatus'] === 'Used';
    }
    return fam === 'NAT Gateway' || fam === 'Storage' || fam === 'IP Address';
  },
  AmazonRDS: (r) => ['Database Instance', 'Database Storage', 'Storage Snapshot'].includes(r['Product Family']),
};

/** Services whose 1-year No Upfront reserved rates are kept too, for the "reserve it" savings. */
const RESERVED_SERVICES = new Set(['AmazonEC2', 'AmazonRDS']);
/** Bumped when the cached rows change shape. Caches from before reserved rates were kept refresh on next use. */
const CACHE_SCHEMA = 2;

/** usageType prefixes per region. us-east-1 rows are often unprefixed. */
const REGION_PREFIX: Record<string, string> = {
  'us-east-1': 'USE1', 'us-east-2': 'USE2', 'us-west-1': 'USW1', 'us-west-2': 'USW2',
  'ca-central-1': 'CAN1', 'ca-west-1': 'CAN2', 'sa-east-1': 'SAE1', 'mx-central-1': 'MXC1',
  'eu-west-1': 'EU', 'eu-west-2': 'EUW2', 'eu-west-3': 'EUW3', 'eu-central-1': 'EUC1', 'eu-central-2': 'EUC2',
  'eu-north-1': 'EUN1', 'eu-south-1': 'EUS1', 'eu-south-2': 'EUS2',
  'ap-northeast-1': 'APN1', 'ap-northeast-2': 'APN2', 'ap-northeast-3': 'APN3',
  'ap-southeast-1': 'APS1', 'ap-southeast-2': 'APS2', 'ap-south-1': 'APS3', 'ap-southeast-3': 'APS4',
  'ap-south-2': 'APS5', 'ap-southeast-4': 'APS6', 'ap-east-1': 'APE1',
  'me-south-1': 'MES1', 'me-central-1': 'MEC1', 'af-south-1': 'AFS1', 'il-central-1': 'ILC1',
};

export class OfferSet {
  readonly service: string;
  readonly region: string;
  readonly rows: OfferRow[];
  readonly publishedAt?: string;
  readonly fetchedAt: string;
  private readonly prefix?: string;

  constructor(data: { service: string; region: string; rows: OfferRow[]; publishedAt?: string; fetchedAt: string }) {
    this.service = data.service;
    this.region = data.region;
    this.rows = data.rows;
    this.publishedAt = data.publishedAt;
    this.fetchedAt = data.fetchedAt;
    this.prefix = REGION_PREFIX[data.region];
  }

  private usageMatches(actual: string, wanted: string): boolean {
    return actual === wanted || (!!this.prefix && actual === `${this.prefix}-${wanted}`);
  }

  find(q: Query): PriceMatch | undefined {
    let rows = this.rows.filter(
      (r) =>
        !r.term &&
        (q.usageType === undefined || this.usageMatches(r.usageType, q.usageType)) &&
        (q.operation === undefined || r.operation === q.operation),
    );
    // Apply attribute filters; for multi-valued filters keep only the best-ranked value present.
    for (const [col, want] of Object.entries(q.attrs ?? {})) {
      const prefs = Array.isArray(want) ? want : [want];
      const best = prefs.find((p) => rows.some((r) => r.attrs[col] === p));
      rows = best === undefined ? [] : rows.filter((r) => r.attrs[col] === best);
    }
    if (!rows.length) return undefined;
    const sku = rows[0].sku;
    const skuRows = rows.filter((r) => r.sku === sku).sort((a, b) => a.from - b.from);
    const all = skuRows.map((r) => ({ from: r.from, to: r.to, price: r.price, desc: r.desc }));
    const tiers = withoutFreeTier(all);
    // withoutFreeTier drops leading free bands; whatever it dropped is the embedded allowance.
    const stripped = all.slice(0, all.length - tiers.length);
    const embedded = stripped.reduce((n, t) => n + (t.to! - t.from), 0);
    return {
      sku,
      unit: skuRows[0].unit,
      description: skuRows.map((r) => r.desc).find((d) => !/free/i.test(d)) ?? skuRows[0].desc,
      tiers,
      free: q.free ? this.freeAllowance(q.free) : embedded > 0 ? { allowance: embedded, label: stripped[0].desc } : undefined,
    };
  }

  /** Allowance from a "Global-…" free tier row, e.g. 1,000,000 for Global-Request. */
  freeAllowance(usageType: string): PriceMatch['free'] {
    const row = this.rows.find((r) => !r.term && r.usageType === usageType && r.price === 0 && r.to !== null && r.to > 0);
    return row ? { allowance: row.to!, label: row.desc } : undefined;
  }

  /** Hourly rate of a 1-year standard Reserved Instance, No Upfront, for this on-demand SKU. */
  reserved(sku: string): number | undefined {
    return this.rows.find((r) => r.term === 'reserved' && r.sku === sku && r.unit === 'Hrs')?.price;
  }
}

/**
 * Drops leading "free tier" bands and shifts the paid ones down, so the estimate
 * matches the AWS Pricing Calculator default (free tier excluded).
 */
export function withoutFreeTier(tiers: (PriceTier & { desc?: string })[]): PriceTier[] {
  let shift = 0;
  let i = 0;
  while (i < tiers.length - 1 && tiers[i].price === 0 && tiers[i].to !== null && /free/i.test(tiers[i].desc ?? '')) {
    shift += tiers[i].to! - tiers[i].from;
    i++;
  }
  return tiers.slice(i).map((t) => ({ from: t.from - shift, to: t.to === null ? null : t.to - shift, price: t.price }));
}

export class AwsOffers {
  private readonly cacheDir: string;
  private readonly ttlMs: number;
  private readonly onProgress: (p: PriceProgress) => void;
  private readonly inflight = new Map<string, Promise<OfferSet>>();

  /** offline: only ever use the disk cache, however old. */
  private readonly offline: boolean;

  constructor(cacheDir: string, ttlDays: number, onProgress: (p: PriceProgress) => void = () => {}, opts: { offline?: boolean } = {}) {
    this.cacheDir = join(cacheDir, 'prices', 'aws');
    this.ttlMs = ttlDays * 86_400_000;
    this.onProgress = onProgress;
    this.offline = !!opts.offline;
  }

  load(service: string, region: string): Promise<OfferSet> {
    const key = `${region}/${service}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.loadUncached(service, region).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async loadUncached(service: string, region: string): Promise<OfferSet> {
    const file = join(this.cacheDir, region, `${service}.json`);
    const cached = await readCache(file);
    const current = cached && (cached.schema === CACHE_SCHEMA || !RESERVED_SERVICES.has(service));
    if (cached && (this.offline || (current && Date.now() - (await stat(file)).mtimeMs < this.ttlMs))) return new OfferSet(cached);
    if (this.offline) throw new Error(`no cached ${service} prices for ${region}; run once without --offline`);
    try {
      const fresh = await this.download(service, region);
      await mkdir(join(this.cacheDir, region), { recursive: true });
      await writeFile(file + '.tmp', JSON.stringify(fresh));
      await rename(file + '.tmp', file);
      return new OfferSet(fresh);
    } catch (err) {
      if (cached) return new OfferSet(cached); // stale beats nothing when offline
      throw err;
    }
  }

  private async download(service: string, region: string) {
    const url = offerUrl(service, region);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`AWS price list ${service}/${region}: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || undefined;
    const label = `AWS ${service}`;
    let loaded = 0;
    let lastReport = 0;
    const body = Readable.fromWeb(res.body as any);
    body.on('data', (chunk: Buffer) => {
      loaded += chunk.length;
      if (loaded - lastReport > 4_000_000) {
        lastReport = loaded;
        this.onProgress({ source: label, loadedBytes: loaded, totalBytes: total, done: false });
      }
    });

    const keepCols = EXTRA_COLUMNS[service] ?? ['Group'];
    const keep = KEEP[service] ?? (() => true);
    const reservedToo = RESERVED_SERVICES.has(service);
    const rows: OfferRow[] = [];
    let header: string[] | undefined;
    let publishedAt: string | undefined;
    let lineNo = 0;
    for await (const line of createInterface({ input: body, crlfDelay: Infinity })) {
      lineNo++;
      if (!header) {
        const cells = parseCsvLine(line);
        if (cells[0] === 'Publication Date') publishedAt = cells[1];
        if (cells[0] === 'SKU') header = cells;
        if (lineNo > 20 && !header) throw new Error(`Unexpected CSV layout for ${service}`);
        continue;
      }
      // Cheap reject before full parse: most EC2 rows are other Reserved/Savings Plan terms.
      if (!line.includes('"OnDemand"') && !(reservedToo && line.includes('"Reserved"') && line.includes('"1yr"') && line.includes('"No Upfront"'))) continue;
      const cells = parseCsvLine(line);
      const r: Record<string, string> = {};
      for (let i = 0; i < header.length; i++) r[header[i]] = cells[i] ?? '';
      const reserved = r.TermType === 'Reserved';
      if (reserved ? !(reservedToo && r.LeaseContractLength === '1yr' && r.PurchaseOption === 'No Upfront' && (r.OfferingClass || 'standard') === 'standard' && r.Unit === 'Hrs') : r.TermType !== 'OnDemand') continue;
      if (r.Currency !== 'USD') continue;
      const loc = r['Location Type'];
      if (loc && loc !== 'AWS Region') continue;
      if (!keep(r)) continue;
      const attrs: Record<string, string> = { 'Product Family': r['Product Family'] };
      for (const c of keepCols) if (r[c]) attrs[c] = r[c];
      rows.push({
        sku: r.SKU,
        usageType: r.usageType,
        operation: r.operation,
        unit: r.Unit,
        price: Number(r.PricePerUnit),
        from: Number(r.StartingRange) || 0,
        to: r.EndingRange === 'Inf' || r.EndingRange === '' ? null : Number(r.EndingRange),
        desc: r.PriceDescription,
        attrs,
        ...(reserved ? { term: 'reserved' as const } : {}),
      });
    }
    this.onProgress({ source: label, loadedBytes: loaded, totalBytes: total, done: true });
    return { schema: CACHE_SCHEMA, service, region, rows, publishedAt, fetchedAt: new Date().toISOString() };
  }
}

async function readCache(file: string) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Minimal RFC 4180 line parser (AWS price CSVs have no embedded newlines). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let s = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            s += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else s += line[i++];
      }
      out.push(s);
      i++; // skip comma
    } else {
      const j = line.indexOf(',', i);
      const end = j === -1 ? line.length : j;
      out.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return out;
}

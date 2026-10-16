// Plan previews and stack comparisons. Both sides are built and priced exactly like a snapshot; the
// comparison adds what happens to each address. The page and the Markdown work out the rest
// (shared/compare.ts), so cost deltas follow the usage sliders.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname } from 'node:path';
import type { ChangeAction, Comparison, CostReport } from '../../shared/types.ts';
import { UTILITY_PROVIDERS } from './graph/catalog.ts';
import { buildBase, buildBaseFrom, priceSnapshot, type SnapshotParts } from './snapshot.ts';
import { isPlan, parsePlan } from './state/plan.ts';
import type { ProviderPricer } from './pricing/types.ts';

export interface Compared {
  /** The "after" side: what the page shows. */
  parts: SnapshotParts;
  cost: CostReport;
  compare: Comparison;
}

/** `terraform show -json` output, or a saved plan file (a zip), which this runs `terraform show -json` on. */
export function readPlan(file: string): unknown {
  const buf = readFileSync(file);
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const r = spawnSync('terraform', ['show', '-json', basename(file)], {
      cwd: dirname(file), encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, shell: process.platform === 'win32',
    });
    if (r.error || r.status !== 0) {
      throw new Error(`could not read the saved plan with terraform show -json (${r.error?.message ?? r.stderr.trim()}). Run it yourself: terraform show -json ${basename(file)} > plan.json`);
    }
    return JSON.parse(r.stdout);
  }
  const json = JSON.parse(buf.toString('utf8'));
  if (!isPlan(json)) {
    throw new Error(json?.version === 4
      ? `${file} is a state file, not a plan. Make one with: terraform plan -out=plan.out && terraform show -json plan.out > plan.json`
      : `${file} is not a Terraform plan (expected the output of terraform show -json <planfile>)`);
  }
  return json;
}

export async function planComparison(file: string, json: unknown, defaultRegion: string, pricers: ProviderPricer[]): Promise<Compared> {
  const plan = parsePlan(json);
  const region = plan.region ?? defaultRegion;
  const after = buildBaseFrom(file, plan.after, region);
  const before = buildBaseFrom(file, plan.before, after.region);
  const [cost, baseCost] = await Promise.all([priceSnapshot(after, pricers), priceSnapshot(before, pricers)]);
  return {
    parts: after,
    cost,
    compare: {
      kind: 'plan',
      base: { ...before.base, cost: baseCost },
      baseLabel: 'now',
      targetLabel: 'after apply',
      actions: plan.actions,
      changedAttrs: plan.changedAttrs,
      unknownAfterApply: plan.unknownAfterApply,
    },
  };
}

/** `target` compared with the stack in `baseFile`, e.g. prod against staging. */
export function stackComparison(target: SnapshotParts, baseFile: string, defaultRegion: string, pricers: ProviderPricer[]): Promise<Comparison> {
  return stacksCompared(target, readStack(baseFile, defaultRegion), pricers);
}

/** A state file, built like the live one. */
export function readStack(file: string, defaultRegion: string): SnapshotParts {
  return buildBase(file, JSON.parse(readFileSync(file, 'utf8')), defaultRegion);
}

/** `target` (the stack on show) compared with `base`, both already built. Either can be the live stack. */
export async function stacksCompared(target: SnapshotParts, base: SnapshotParts, pricers: ProviderPricer[]): Promise<Comparison> {
  const baseCost = await priceSnapshot(base, pricers);
  const managed = (p: SnapshotParts) => new Set(p.state.resources.filter((r) => r.mode === 'managed' && !UTILITY_PROVIDERS.has(r.provider)).map((r) => r.address));
  const was = managed(base), now = managed(target);
  // No plan to say what "changed" means across two stacks; the page compares configuration and cost per resource.
  const actions: Record<string, ChangeAction> = {};
  for (const a of now) if (!was.has(a)) actions[a] = 'create';
  for (const a of was) if (!now.has(a)) actions[a] = 'delete';
  let [baseLabel, targetLabel] = [stackLabel(base.base.stateFile), stackLabel(target.base.stateFile)];
  if (baseLabel === targetLabel) [baseLabel, targetLabel] = [`${baseLabel} (other)`, `${targetLabel} (this)`];
  return { kind: 'stacks', base: { ...base.base, cost: baseCost }, baseLabel, targetLabel, actions };
}

/** ../prod/terraform.tfstate → prod ; staging.tfstate → staging */
export function stackLabel(file: string): string {
  const name = basename(file);
  return name === 'terraform.tfstate' ? basename(dirname(file)) : name.replace(/\.tfstate$/, '');
}

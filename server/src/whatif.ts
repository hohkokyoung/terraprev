// What if: the stack with some attributes changed or resources removed, before anyone writes .tf or
// runs terraform. The result is built, priced and checked exactly like the "after" side of a plan.

import type { ChangeAction } from '../../shared/types.ts';
import type { ParsedState } from './state/load.ts';

export interface WhatIfChange {
  /** A Terraform address (aws_db_instance.main, aws_subnet.public["a"]), a base address for every instance, or a name. */
  resource: string;
  /** Attribute → new value; nested attributes use dots, e.g. root_block_device.0.volume_size. */
  set?: Record<string, unknown>;
  remove?: boolean;
}

export interface WhatIf {
  state: ParsedState;
  actions: Record<string, ChangeAction>;
  changedAttrs: Record<string, string[]>;
  /** Changes that may not do what was meant, e.g. an attribute the resource doesn't have. */
  warnings: string[];
}

/** Applies `changes` to a copy of `state`; `resolve` turns each change's `resource` into the addresses it means. */
export function applyWhatIf(state: ParsedState, changes: WhatIfChange[], resolve: (query: string) => string[]): WhatIf {
  const actions: Record<string, ChangeAction> = {};
  const changedAttrs: Record<string, string[]> = {};
  const warnings: string[] = [];
  const edited = new Map<string, Record<string, unknown>>();
  const removed = new Set<string>();
  const byAddress = new Map(state.resources.map((r) => [r.address, r]));

  for (const change of changes) {
    const addresses = resolve(change.resource).filter((a) => byAddress.has(a));
    if (!addresses.length) throw new Error(`No resource "${change.resource}" in this state.`);
    if (change.remove) {
      for (const a of addresses) {
        removed.add(a);
        actions[a] = 'delete';
      }
      continue;
    }
    const keys = Object.keys(change.set ?? {});
    if (!keys.length) throw new Error(`Change to "${change.resource}" has nothing to set; pass "set" or "remove": true.`);
    for (const a of addresses) {
      const attrs = edited.get(a) ?? structuredClone(byAddress.get(a)!.attrs);
      for (const key of keys) {
        if (getPath(attrs, key) === undefined) warnings.push(`${a} has no "${key}" in state; it was set anyway, but check the attribute name (describe_resource shows them).`);
        setPath(attrs, key, change.set![key]);
      }
      edited.set(a, attrs);
      actions[a] = 'update';
      changedAttrs[a] = [...new Set([...(changedAttrs[a] ?? []), ...keys.map((k) => k.split('.')[0])])];
    }
  }

  const resources = state.resources
    .filter((r) => !removed.has(r.address))
    .map((r) => (edited.has(r.address) ? { ...r, attrs: edited.get(r.address)! } : r));
  return { state: { ...state, resources }, actions, changedAttrs, warnings };
}

const parts = (path: string) => path.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p));

function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const p of parts(path)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const ps = parts(path);
  let cur: any = obj;
  for (const [i, p] of ps.slice(0, -1).entries()) {
    if (cur[p] === null || typeof cur[p] !== 'object') cur[p] = typeof ps[i + 1] === 'number' ? [] : {};
    cur = cur[p];
  }
  cur[ps[ps.length - 1]] = value;
}

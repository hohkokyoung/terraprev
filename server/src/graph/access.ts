// Who-can-do-what for each drawn resource: its IAM role (+ policies) and security groups,
// summarised in plain language so the diagram doesn't need a box per policy.

import type { AccessRole, AccessSecurityGroup, GraphNode, NodeAccess, PolicyStatement, TfResource } from '../../../shared/types.ts';
import { displayName } from './catalog.ts';

type Lookup = (value: unknown) => TfResource | undefined;

export function attachAccess(nodes: GraphNode[], resources: TfResource[], byAddress: Map<string, TfResource>, nodeOf: Map<string, string>, lookup: Lookup) {
  const sgName = (id: string) => {
    const sg = lookup(id);
    return sg?.type === 'aws_security_group' ? displayName(sg) : id;
  };

  for (const n of nodes) {
    if (n.kind !== 'resource' || n.supporting || !n.addresses.length) continue;
    const roles = new Map<string, AccessRole>();
    const sgs = new Map<string, AccessSecurityGroup>();
    const reveal = new Set<string>();
    const show = (r: TfResource) => {
      const id = nodeOf.get(r.address);
      if (id && id !== n.id) reveal.add(id);
      return id;
    };

    const addRole = (role: TfResource, via?: TfResource) => {
      if (roles.has(role.address)) return;
      show(role);
      if (via) show(via);
      roles.set(role.address, {
        nodeId: nodeOf.get(role.address),
        address: role.address,
        name: displayName(role),
        trustedBy: trustedBy(role.attrs.assume_role_policy),
        via: via ? displayName(via) : undefined,
        policies: rolePolicies(role, resources, lookup).map((p) => {
          if (p.address) {
            const pr = byAddress.get(p.address);
            if (pr) show(pr);
          }
          return { ...p, nodeId: p.address ? nodeOf.get(p.address) : undefined };
        }),
      });
    };

    for (const addr of n.addresses) {
      const r = byAddress.get(addr);
      if (!r) continue;
      walk(r.attrs, (key, v) => {
        if (key === 'tags' || key === 'tags_all') return;
        const t = lookup(v);
        if (!t || t === r) return;
        if (t.type === 'aws_iam_role') addRole(t);
        else if (t.type === 'aws_iam_instance_profile') {
          const role = lookup(t.attrs.role);
          if (role?.type === 'aws_iam_role') addRole(role, t);
        } else if (t.type === 'aws_security_group' && !sgs.has(t.address)) {
          show(t);
          sgs.set(t.address, { nodeId: nodeOf.get(t.address), address: t.address, name: displayName(t), ...sgRules(t, sgName) });
        }
      });
    }

    if (roles.size || sgs.size) n.access = { roles: [...roles.values()], securityGroups: [...sgs.values()], nodeIds: [...reveal] } satisfies NodeAccess;
  }
}

function trustedBy(doc: unknown): string[] {
  const out: string[] = [];
  for (const st of statements(doc)) {
    const p = st.Principal;
    if (typeof p === 'string') out.push(p);
    else if (p && typeof p === 'object') for (const v of Object.values(p)) out.push(...arr(v).map(String));
  }
  return [...new Set(out)];
}

function rolePolicies(role: TfResource, resources: TfResource[], lookup: Lookup): { name: string; address?: string; managed?: boolean; statements: PolicyStatement[] }[] {
  const names = new Set([role.attrs.name, role.attrs.id, role.attrs.arn]);
  const out: { name: string; address?: string; managed?: boolean; statements: PolicyStatement[] }[] = [];
  for (const r of resources) {
    if (r.type === 'aws_iam_role_policy' && names.has(r.attrs.role)) {
      out.push({ name: r.attrs.name ?? r.name, address: r.address, statements: summarise(r.attrs.policy, lookup) });
    }
    if (r.type === 'aws_iam_role_policy_attachment' && names.has(r.attrs.role)) {
      const pol = lookup(r.attrs.policy_arn);
      out.push(
        pol?.type === 'aws_iam_policy'
          ? { name: displayName(pol), address: pol.address, statements: summarise(pol.attrs.policy, lookup) }
          : { name: String(r.attrs.policy_arn).split('/').pop()!, address: r.address, managed: true, statements: [] },
      );
    }
  }
  for (const ip of arr(role.attrs.inline_policy)) {
    if (ip?.policy && !out.some((p) => p.name === ip.name)) out.push({ name: ip.name, statements: summarise(ip.policy, lookup) });
  }
  for (const arn of arr(role.attrs.managed_policy_arns)) {
    const name = String(arn).split('/').pop()!;
    if (!out.some((p) => p.name === name)) out.push({ name, managed: true, statements: [] });
  }
  return out;
}

function summarise(doc: unknown, lookup: Lookup): PolicyStatement[] {
  return statements(doc).map((st) => ({
    effect: st.Effect ?? 'Allow',
    actions: arr(st.Action ?? st.NotAction).map(String),
    resources: arr(st.Resource ?? st.NotResource).map((res) => shortResource(String(res), lookup)),
  }));
}

/** arn:aws:s3:::bucket-123/* → "tf-lab-archive/*" when we know the bucket. */
function shortResource(res: string, lookup: Lookup): string {
  if (res === '*') return 'all resources';
  const m = res.match(/^(.*?)((?::\*|\/\*|\*)?)$/)!;
  const hit = lookup(m[1]) ?? lookup(m[1].replace(/:$/, ''));
  if (hit) return displayName(hit) + m[2];
  const tail = res.split(/:(?=[^:]*$)/).pop() ?? res;
  return tail.length < res.length ? tail : res;
}

function sgRules(sg: TfResource, sgName: (id: string) => string) {
  const fmt = (r: any, dir: 'from' | 'to') => {
    const proto = r.protocol === '-1' || r.protocol === 'all' ? 'all traffic' : `${r.protocol} ${r.from_port === r.to_port ? r.from_port : `${r.from_port}-${r.to_port}`}`;
    const peers = [...arr(r.cidr_blocks), ...arr(r.ipv6_cidr_blocks), ...arr(r.security_groups).map((id: string) => sgName(id)), ...(r.self ? ['itself'] : [])];
    const who = peers.map((p: string) => (p === '0.0.0.0/0' || p === '::/0' ? 'anywhere' : p)).join(', ') || 'nobody';
    return `${proto} ${dir} ${who}`;
  };
  const egress = arr(sg.attrs.egress).map((r) => fmt(r, 'to'));
  return {
    ingress: arr(sg.attrs.ingress).map((r) => fmt(r, 'from')),
    egress: egress.length === 1 && egress[0] === 'all traffic to anywhere' ? ['all outbound'] : egress,
  };
}

function statements(doc: unknown): any[] {
  try {
    const d = typeof doc === 'string' ? JSON.parse(doc) : doc;
    return arr((d as any)?.Statement);
  } catch {
    return [];
  }
}

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
}

function walk(v: any, fn: (key: string, value: string) => void, key = '') {
  if (typeof v === 'string') fn(key, v);
  else if (Array.isArray(v)) v.forEach((x) => walk(x, fn, key));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, fn, key === 'tags' || key === 'tags_all' ? key : k);
}

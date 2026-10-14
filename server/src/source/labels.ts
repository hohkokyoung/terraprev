import type { TfResource } from '../../../shared/types.ts';
import { displayName } from '../graph/catalog.ts';

/** The name AWS shows for a resource; listeners and rules have none, so describe them. Undefined when it would just repeat the Terraform name. */
export function awsLabel(r: TfResource): string | undefined {
  if (r.type === 'aws_lb_listener') return `${r.attrs.protocol} :${r.attrs.port}`;
  if (r.type === 'aws_lb_listener_rule') return r.attrs.priority ? `priority ${r.attrs.priority}` : undefined;
  const n = displayName(r);
  return n === r.name || n.startsWith(`${r.name}[`) ? undefined : n;
}

export function labelMap(resources: TfResource[]): Map<string, { name?: string; type: string }> {
  return new Map(resources.map((r) => [r.address, { name: awsLabel(r), type: r.type }]));
}

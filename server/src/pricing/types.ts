import type { CostComponent, CostReport, Saving, TfResource, UsageParam } from '../../../shared/types.ts';

export interface PricingInput {
  /** Managed resources of this provider. */
  resources: TfResource[];
  /** All managed resources in state, for cross-references (e.g. ASG → launch template). */
  all: TfResource[];
  region: string;
  /** address → diagram node id (absorbed children map to their parent). */
  nodeOf: Map<string, string>;
}

export interface PricingResult {
  components: CostComponent[];
  usage: UsageParam[];
  unpriced: CostReport['unpriced'];
  free: CostReport['free'];
  sources: CostReport['sources'];
  errors: string[];
  savings: Saving[];
}

/** One per cloud. Add Azure/GCP by implementing this and registering it in estimate.ts. */
export interface ProviderPricer {
  provider: string;
  estimate(input: PricingInput): Promise<PricingResult>;
}

export function emptyResult(): PricingResult {
  return { components: [], usage: [], unpriced: [], free: [], sources: [], errors: [], savings: [] };
}

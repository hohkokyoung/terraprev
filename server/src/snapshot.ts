import type { CostReport, Snapshot } from '../../shared/types.ts';
import { buildGraph } from './graph/build.ts';
import { awsInsights, detectEnvironment } from './insights/aws.ts';
import { parseState, type ParsedState } from './state/load.ts';
import { estimate } from './pricing/estimate.ts';
import type { ProviderPricer } from './pricing/types.ts';

export interface SnapshotParts {
  state: ParsedState;
  base: Omit<Snapshot, 'cost'>;
  nodeOf: Map<string, string>;
  region: string;
}

/** Fast part: parse + graph. Ready in milliseconds so the diagram updates immediately. */
export function buildBase(stateFile: string, json: unknown, defaultRegion: string): SnapshotParts {
  return buildBaseFrom(stateFile, parseState(json), defaultRegion);
}

/** The same, from resources already parsed (one side of a plan). */
export function buildBaseFrom(stateFile: string, state: ParsedState, defaultRegion: string): SnapshotParts {
  const graph = buildGraph(state.resources, state.secrets, defaultRegion);
  const providers = [...new Set(state.resources.filter((r) => r.mode === 'managed').map((r) => r.provider))].sort();
  const region = graph.region ?? defaultRegion;
  return {
    state,
    nodeOf: graph.nodeOf,
    region,
    base: {
      stateFile,
      serial: state.serial,
      lineage: state.lineage,
      terraformVersion: state.terraformVersion,
      updatedAt: new Date().toISOString(),
      resourceCount: state.resources.filter((r) => r.mode === 'managed').length,
      providers,
      graph: { nodes: graph.nodes, edges: graph.edges },
      warnings: [],
      insights: awsInsights(state.resources, graph.nodeOf, graph.nodes),
      environment: detectEnvironment(state.resources),
    },
  };
}

/** Slow part: pricing may need to download price lists on first run. */
export function priceSnapshot(parts: SnapshotParts, pricers: ProviderPricer[]): Promise<CostReport> {
  return estimate(pricers, parts.state.resources, parts.region, parts.nodeOf);
}

export function loadingCost(region: string): CostReport {
  return { currency: 'USD', region, status: 'loading', components: [], usage: [], unpriced: [], free: [], sources: [], errors: [], savings: [] };
}

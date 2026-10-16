// Types shared by the server and the web app. Type-only, plus cost math in cost.ts.

export type Category =
  | 'compute'
  | 'database'
  | 'storage'
  | 'network'
  | 'integration'
  | 'api'
  | 'security'
  | 'monitoring'
  | 'other';

/** One resource instance from terraform state. `attrs` never leaves the server. */
export interface TfResource {
  /** Full address incl. module and index, e.g. module.worker.aws_lambda_function.this */
  address: string;
  /** Address without the index key; this is what `dependencies` refer to. */
  baseAddress: string;
  mode: 'managed' | 'data';
  type: string;
  name: string;
  module?: string;
  indexKey?: string | number;
  /** Short provider name: aws, azurerm, google, random, ... */
  provider: string;
  attrs: Record<string, any>;
  deps: string[];
}

export interface GraphNode {
  id: string;
  kind: 'group' | 'resource';
  /** Group flavour, used for styling. */
  groupKind?: 'provider' | 'vpc' | 'subnet';
  type: string;
  label: string;
  sublabel?: string;
  category: Category;
  parentId?: string;
  /** Resource addresses represented by this node (the main one first, then absorbed children). */
  addresses: string[];
  /** Curated display attributes. Redacted, safe to show. */
  details: [string, string][];
  /** Supporting resources (IAM, SGs, routes...) are hidden unless toggled on. */
  supporting?: boolean;
  /** Synthetic node, e.g. one instance launched by an ASG. */
  virtual?: boolean;
  provider: string;
  /** IAM + security groups attached to this resource. Shown as chips; expanding reveals the nodes. */
  access?: NodeAccess;
}

export interface PolicyStatement {
  effect: string;
  actions: string[];
  /** Resource ARNs shortened to names where we know the resource. */
  resources: string[];
}

export interface AccessRole {
  nodeId?: string;
  address: string;
  name: string;
  /** Who may assume it, e.g. lambda.amazonaws.com */
  trustedBy: string[];
  /** Instance profile name when the role is reached through one (EC2). */
  via?: string;
  policies: { name: string; nodeId?: string; managed?: boolean; statements: PolicyStatement[] }[];
}

export interface AccessSecurityGroup {
  nodeId?: string;
  address: string;
  name: string;
  ingress: string[];
  egress: string[];
}

export interface NodeAccess {
  roles: AccessRole[];
  securityGroups: AccessSecurityGroup[];
  /** Every supporting node to reveal when this node is expanded. */
  nodeIds: string[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** flow: requests/events travel this way. uses: reads config/secrets/logs. manages: controller → instance. */
  kind: 'flow' | 'uses' | 'manages' | 'route';
  label?: string;
}

export interface PriceTier {
  /** Quantity at which this tier starts (inclusive). */
  from: number;
  /** Quantity at which it ends, null = no upper bound. */
  to: number | null;
  /** USD per unit. */
  price: number;
}

/**
 * One billable line. Monthly quantity = base × product(usage values for `usage` keys).
 * Fixed components have no usage keys.
 */
export interface CostComponent {
  id: string;
  nodeId: string;
  address: string;
  name: string;
  unit: string;
  tiers: PriceTier[];
  quantity: { base: number; usage?: string[] };
  kind: 'fixed' | 'usage';
  source: string;
  /** Human-readable AWS pricing page for this charge. */
  pageUrl?: string;
  /** The machine-readable price list file the number was read from. */
  dataUrl?: string;
  sku?: string;
  priceDescription?: string;
  note?: string;
  /**
   * AWS "Always Free" allowance this line draws from. Allowances are per account, so every
   * line with the same `pool` shares one allowance (e.g. all Lambdas share 1M requests).
   */
  freeTier?: { pool: string; allowance: number; label: string };
}

export interface UsageParam {
  /** Stable across applies: `${address}:${param}`. */
  key: string;
  nodeId: string;
  address: string;
  label: string;
  unit: string;
  default: number;
  min: number;
  max: number;
  scale: 'log' | 'linear';
}

export interface CostReport {
  currency: 'USD';
  region: string;
  status: 'ready' | 'loading' | 'error';
  components: CostComponent[];
  usage: UsageParam[];
  /** Resources we don't know how to price yet. Never silently $0. */
  unpriced: { address: string; type: string; nodeId?: string; reason: string }[];
  /** Resources that are free by design (IAM, SGs, subnets...). */
  free: { address: string; type: string }[];
  sources: { name: string; publishedAt?: string; fetchedAt?: string; pageUrl?: string; dataUrl?: string }[];
  errors: string[];
  /** Cheaper ways to run the same stack, each priced from the same price lists. */
  savings?: Saving[];
}

/**
 * A priced way to cut the bill: swap these cost lines for those. The saving itself is computed where
 * it's shown (shared/savings.ts), so it follows the usage sliders and the free tier like every other number.
 */
export interface Saving {
  id: string;
  kind: 'graviton' | 'gp3' | 'reserved' | 'arm64' | 'release-ip' | 'private-subnets' | 'log-retention' | 'gateway-endpoints';
  nodeId: string;
  title: string;
  /** What changes, in plain words. */
  detail: string;
  /** What it takes or risks, e.g. "Needs an arm64 AMI" or "1-year commitment". */
  caveat?: string;
  /** The Terraform change, e.g. instance_type = "t4g.small". */
  change?: string;
  /** Cost component ids this replaces. */
  replaces: string[];
  /** What they become (may be empty: the charge goes away). */
  with: CostComponent[];
  /** For savings that depend on traffic the state can't show, e.g. "$0.045 per GB of S3 traffic". */
  perUnit?: string;
}

/** One apply, as recorded by the snapshot build or the live server. */
export interface HistoryPoint {
  serial: number;
  /** When terraform wrote the state. */
  appliedAt: string;
  resourceCount: number;
  /** Always-on monthly cost. */
  fixed: number;
  /** Usage-based monthly cost at the default usage assumptions. */
  usage: number;
  /** Monthly cost per category (fixed + default usage), e.g. { Database: 31.2 }. */
  byCategory: Record<string, number>;
  findings: { high: number; medium: number };
}

export type ChangeAction = 'create' | 'update' | 'replace' | 'delete';

/** A second snapshot to compare against: the state before a plan, or another stack. */
export interface Comparison {
  kind: 'plan' | 'stacks';
  /** The "before" side: prior state of a plan, or the stack being compared against. */
  base: Snapshot;
  baseLabel: string;
  targetLabel: string;
  /** Terraform address → what happens to it. Only addresses that change. */
  actions: Record<string, ChangeAction>;
  /** Address → names of the attributes that change (plans only; values are never included). */
  changedAttrs?: Record<string, string[]>;
  /** Addresses whose cost may be incomplete because a value is only known after apply. */
  unknownAfterApply?: string[];
}

export type InsightSeverity = 'high' | 'medium' | 'low' | 'info' | 'good';
export type InsightCategory = 'reliability' | 'security' | 'cost' | 'operations';

/** A finding about the architecture, derived from state attributes (never from guesses). */
export interface Insight {
  id: string;
  severity: InsightSeverity;
  category: InsightCategory;
  title: string;
  /** What we saw, in plain language. */
  detail: string;
  recommendation?: string;
  /** Diagram node ids this is about. */
  nodes: string[];
}

export interface Snapshot {
  stateFile: string;
  serial: number;
  lineage: string;
  terraformVersion: string;
  updatedAt: string;
  resourceCount: number;
  providers: string[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  cost: CostReport;
  warnings: string[];
  insights: Insight[];
  /** e.g. "local emulator (account 000000000000)" when the state wasn't applied to real AWS. */
  environment?: string;
  /** Earlier applies of this state (same lineage), oldest first, ending with this one. */
  history?: HistoryPoint[];
}

export interface PriceProgress {
  source: string;
  loadedBytes: number;
  totalBytes?: number;
  done: boolean;
}

/** One HCL block shown in the Terraform tab. */
export interface SourceBlock {
  /** What this block is: the resource itself, or the module call that created it. */
  role: 'resource' | 'module';
  label: string;
  file: string; // relative to the stack root
  absPath: string;
  startLine: number; // 1-based, first line of the leading comment if any
  blockLine: number; // line of the `resource "..." "..." {` header
  endLine: number;
  text: string;
  modifiedAt: string;
}

export interface SourceResult {
  address: string;
  blocks: SourceBlock[];
  /** True when any shown file was edited after the state was last written (i.e. not applied yet). */
  changedSinceApply: boolean;
  /** Name in the cloud, e.g. tf-lab-alb, or "HTTPS :443" for a listener. */
  name?: string;
  type?: string;
}

/** Everything a static snapshot page needs, embedded by `terraprev build`. */
export interface StaticBundle {
  snapshot: Snapshot;
  /** address → its source blocks, or null when not found in any .tf file. */
  sources: Record<string, SourceResult | null>;
  generatedAt: string;
  /** Slider values to use instead of the viewer's saved ones (the server-rendered report PDF). */
  usage?: Record<string, number>;
  /** Plan preview or stack comparison: `snapshot` is the "after" side, this holds the "before". */
  compare?: Comparison;
}

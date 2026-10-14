# terraprev

**See what your Terraform stack looks like and what it would cost on AWS, every time you apply.**

terraprev reads your `terraform.tfstate` and produces:

- an **architecture diagram** (VPC → subnets → resources, with traffic arrows),
- a **monthly cost estimate** from AWS's official public price list,
- a **written brief** (Markdown / PDF) with findings and recommendations you can hand to a CTO.

It runs entirely on your machine. It needs no AWS account and no credentials, and nothing is uploaded.
It works with real AWS and with local emulators such as floci or LocalStack: the cost shown is what the same stack would cost on real AWS.

```
terraform apply ─▶ terraform.tfstate ─▶ terraprev ─▶ out/terraprev.html   (diagram + cost + code)
                                            │      ─▶ out/<stack>-brief.md / .pdf   (CTO brief)
                     .cache/prices ─────────┘      ─▶ http://localhost:4600   (optional live view)
```

---

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Two ways to run it](#two-ways-to-run-it)
- [Commands](#commands)
- [Working offline](#working-offline)
- [Using the page](#using-the-page)
- [The CTO brief](#the-cto-brief)
- [How costs are calculated](#how-costs-are-calculated)
- [Configuration](#configuration)
- [Privacy and security](#privacy-and-security)
- [Deterministic output](#deterministic-output)
- [Limitations](#limitations)
- [Extending terraprev](#extending-terraprev)
- [Development](#development)

---

## Features

### Architecture diagram
- Laid out automatically: cloud → VPC → public/private subnets → resources, with right-angled arrows that never overlap.
- **Traffic arrows** come from real relationships in state: ALB → target groups → ASG, API Gateway → integration, SNS → SQS subscriptions, SQS → Lambda triggers, S3 → Lambda notifications, DLQs, and **security-group rules** (e.g. `ASG → RDS tcp 5432`).
- Auto Scaling groups are drawn as one box per running instance, spread across their subnets.
- Child resources fold into their parent (listeners, rules and target groups into the ALB; stages and routes into the API) so the picture stays readable.
- Each box shows its AWS name (e.g. *Amazon RDS · DB instance*) and its monthly cost.

### Cost estimate
- On-demand **list prices from the AWS Price List API**, for your region, with links to the AWS pricing page and the raw price file behind every number.
- **Always-on** costs (instance hours, NAT, ALB, public IPv4, RDS storage…) are computed from state.
- **Usage** costs (Lambda invocations, SQS requests, S3 GB, NAT data, Cognito users…) are set with sliders.
- **Free tier** switch: applies AWS *Always Free* allowances, shared across the account like on a real bill.
- Free resources (IAM, subnets, security groups…) are listed as free. Anything terraprev can't price is listed as **not priced** and never silently counted as $0.

### Exploring the stack
- **Inspector**: click any box for its cost breakdown, configuration, and the IAM role and security group rules in plain English.
- **Terraform tab**: the actual `resource "…" {}` block from your `.tf` files, with line numbers, an *open in VS Code* link, and a warning if the file changed since the last apply. Module resources also show the `module "…"` call that passed in the real values.
- **IAM / SG chips**: expand a resource to draw its role, policies and security groups on the diagram.
- **Data flow mode**: click a resource to highlight every path that can reach it, e.g. *Internet → API Gateway → ALB → ASG → RDS*.
- **Dependencies**: click a resource to see what it uses (secrets, log groups, roles).

### Outputs
- **Snapshot**: one self-contained HTML file. Open it by double-clicking; it needs no server and no internet.
- **Diagram PDF**: one A4 landscape page, light or dark.
- **CTO brief**: executive summary, architecture, cost drivers, findings with recommendations, security posture and inventory, as Markdown (with a Mermaid diagram) and PDF.
- Output is **deterministic**: the same inputs give byte-identical files.

### Quality of life
- Light / dark / auto theme · collapsible side panel (`\`) · usage values remembered between applies.

---

## Requirements

| Need | For |
|---|---|
| **Node.js 22.18+** (tested on 26) | everything (runs TypeScript directly, no build step for the CLI) |
| **Terraform state, format v4** (Terraform 0.12+) | the input |
| **Chrome, Edge, Brave or Chromium** installed | only for PDF export from the command line |
| Internet, once | `npm install` and the first price download (~330 MB streamed, ~3.5 MB kept) |

---

## Quick start

```bash
git clone <this repo> terraprev && cd terraprev
npm install
```

Point terraprev at your stack: edit `terraprev.config.json`, or pass `--state`:

```json
{ "stateFile": "../my-stack/terraform.tfstate" }
```

Then:

```bash
npm run snapshot -- --open
```

This builds `out/terraprev.html` and opens it. The first run downloads AWS price lists (about a minute); later runs take ~30 ms.

---

## Two ways to run it

| | **Snapshot** (recommended) | **Live server** |
|---|---|---|
| Start | `npm run snapshot` or `bin/tf apply` | `npm run dev` |
| Open | `out/terraprev.html` (double-click) | http://localhost:4600 |
| After `terraform apply` | reload the tab | updates by itself within ~1 s |
| Background process | none | yes (ports 4600 + 4610) |
| Works offline | ✔ | ✔ (with cached prices) |

### Snapshot mode: rebuild on every apply

`bin/tf` is a drop-in wrapper for `terraform`. It runs the real command, then rebuilds the snapshot whenever the state may have changed (`apply`, `destroy`, `import`, `refresh`, `state`, `taint`, `untaint`):

```bash
cd ~/my-stack
~/terraprev/bin/tf apply          # = terraform apply, then terraprev build
```

To type just `tf apply`, put it on your PATH once:

```bash
ln -s ~/terraprev/bin/tf /usr/local/bin/tf
```

Pass extra build options through an environment variable, e.g. a PDF on every apply:

```bash
TERRAPREV_BUILD_ARGS="--pdf --report" tf apply
```

Terraform's own exit code is always kept: a failed snapshot never fails your apply.

### Live mode

```bash
npm run dev                        # API on :4610, web on http://localhost:4600
```

The page reconnects by itself and highlights what changed after each apply (*serial 223 → 224, +1 added*).
To serve the built UI on a single port: `npm run build && npm start` → http://localhost:4610.

---

## Commands

### npm scripts

| Command | What it does |
|---|---|
| `npm run snapshot` | Build `out/terraprev.html` |
| `npm run prices` | Re-download AWS price lists now (normally every 7 days) |
| `npm run dev` | Live server + web app with hot reload |
| `npm run build` / `npm start` | Build the web app / serve it from the API on one port |
| `npm test` | Run the test suite (offline) |
| `npm run typecheck` | Type-check server and web |

### `npm run snapshot -- [options]`

| Option | Description | Default |
|---|---|---|
| `--state <path>` | State file to read | `stateFile` in config |
| `--out <file.html>` | Where to write the snapshot; other outputs go next to it | `out/terraprev.html` |
| `--offline` | Never use the network; use cached prices however old | off |
| `--refresh-prices` | Ignore the cache and download prices now | off |
| `--open` | Open the snapshot when done | off |
| `--pdf` | Also write the diagram as `<out>.pdf` (A4 landscape) | off |
| `--pdf-out <file.pdf>` | Diagram PDF to a specific path (implies `--pdf`) | |
| `--report` | Also write the CTO brief: `<stack>-brief.md` and `<stack>-brief.pdf` | off |
| `--theme light\|dark` | Theme for the PDFs | `light` |
| `--free-tier` | Apply AWS Always Free allowances in PDFs and the brief | off |
| `-q`, `--quiet` | Print nothing except errors | off |

**Examples**

```bash
npm run snapshot -- --open                                   # build and view
npm run snapshot -- --state ~/other-stack/terraform.tfstate  # a different stack
npm run snapshot -- --report --free-tier                     # brief with free tier applied
npm run snapshot -- --pdf --theme dark                       # dark one-page diagram PDF
npm run snapshot -- --offline --report --pdf                 # everything, no network at all
```

**Remote state** (S3, Terraform Cloud…): pull it to a file first.

```bash
terraform state pull > /tmp/stack.tfstate
npm run snapshot -- --state /tmp/stack.tfstate
```

---

## Working offline

After **one** online run, everything works without internet.

| Part | Offline? | Notes |
|---|---|---|
| Reading state and `.tf` files | ✔ | always local |
| Prices | ✔ | read from `.cache/prices/` (~3.5 MB) |
| Snapshot HTML | ✔ | fonts and code are embedded; the file makes no network requests |
| PDFs | ✔ | printed by your locally installed Chrome |
| Live server | ✔ | uses the cache; if a refresh is due but fails, the old prices are used |
| Links to AWS pricing pages | ✗ | they're just links |

How the price cache behaves:

```
first build       → download AWS price lists (~330 MB streamed, filtered while downloading)
                     → keep only the rows needed → .cache/prices/aws/<region>/*.json (~3.5 MB)
later builds      → read the cache, no network
older than 7 days → re-download at the next build; on failure, keep using the old file
--offline         → never download; fail only if a needed price list was never cached
```

To prepare a machine for offline use, run once while online:

```bash
npm install && npm run prices
```

Change the refresh interval with `priceCacheDays` in `terraprev.config.json`. Delete `.cache/prices` to start fresh.

---

## Using the page

### Header

| Control | What it does |
|---|---|
| **Free tier** | Apply AWS Always Free allowances. Allowances are per account, so e.g. all Lambdas share 1M requests. 12-month trials and credits are not included. |
| **☀ / Auto / ☾** | Theme. *Auto* follows your OS. |
| **Report** | Open the CTO brief (see below). |
| **PDF** | Print the diagram on one A4 landscape page, in the current theme. |
| Total | Estimated monthly cost: always-on + usage − free tier. |

### Diagram

| Action | Result |
|---|---|
| Click a box | Open it in the inspector and highlight its connections |
| `IAM` / `SG` chip under a box | Draw that resource's role, policies and security groups; click again to hide |
| **Data flow** toggle, then click a box | Highlight everything that can reach it; the inspector lists each path |
| **All dependencies** | Show every *uses* line (secrets, logs, roles) at once |
| **All IAM, security groups & routes** | Show all supporting resources |
| Scroll / drag / `+ −` | Zoom and pan; the minimap is bottom right |

Line styles: **solid** = traffic or events · **dashed** = uses (dependency) · **dotted** = network route.

### Side panel (`\` or `›` to hide/show)

| Tab | Contents |
|---|---|
| **Cost** | Cost by category and by resource, free and unpriced resources, price sources with dates |
| **Usage** | Sliders for every usage-based charge; *Set all to 0* shows always-on cost only; *Reset to defaults*. Values are saved in your browser and survive applies. |
| **Resource → Overview** | Cost lines (quantity × unit price, SKU, links to the AWS pricing page and the raw price file), usage sliders, *What can reach this*, access (IAM + security groups in plain English), configuration |
| **Resource → Terraform** | The real `.tf` blocks for the resource, labelled with the AWS name and Terraform address; copy / open in VS Code |

---

## The CTO brief

Open it with **Report** in the page, or generate it with `--report` on the command line.

| Section | Contents |
|---|---|
| Executive summary | What the stack is, what it costs and why, the most important risks |
| At a glance | Monthly cost, always-on share, components, AZs, entry points, findings |
| Architecture | Diagram, components by tier, every request/data path, subnet layout |
| Cost | Always-on vs usage, by category and resource, what drives the bill, usage assumptions |
| Findings & recommendations | Each item with severity (high / medium / low / note / **strength**) and a recommendation |
| Security posture | Internet-facing entry points, what each security group allows, what each IAM role can do |
| Appendix | Resource inventory, pricing sources with publish dates, methodology and caveats |

**Formats**: *Save as PDF* (A4, your current theme) · *Download / Copy Markdown*. The Markdown includes a Mermaid diagram that renders in GitHub, GitLab, Notion and Confluence.

**How findings are made**: plain rules over state attributes, with no AI and no guessing. For example:

| Finding | Triggered by |
|---|---|
| RDS automated backups disabled | `backup_retention_period = 0` |
| RDS not encrypted at rest | `storage_encrypted = false` |
| Instances allow IMDSv1 | `metadata_options.http_tokens` not `"required"` |
| One NAT gateway serves every AZ | 1 NAT gateway, private subnets in 2+ AZs |
| Port open to the internet | SG ingress from `0.0.0.0/0` other than 80/443 |
| Credential hard-coded in user data | a literal value assigned to a password-like variable (references and ARNs are ignored) |
| *Strength*: private database | `publicly_accessible = false`, ingress only from security groups |

The page version uses your current sliders and free tier setting. The CLI uses default usage (add `--free-tier` to apply it).

---

## How costs are calculated

| Kind | Examples | Quantity comes from |
|---|---|---|
| **Always-on** | EC2 / ASG instances (× desired capacity), root volumes, NAT hours, ALB hours, public IPv4, RDS instance + storage, Secrets Manager secrets | state × 730 hours/month |
| **Usage** | Lambda requests + GB-seconds, API Gateway requests, SQS/SNS requests, S3 storage + requests, DynamoDB, NAT data, ALB LCUs, CloudWatch Logs, Cognito MAU | **Usage** sliders |
| **Free** | IAM, VPC, subnets, route tables, security groups, listeners, target groups, launch templates… | listed, $0 |
| **Not priced** | types without a pricing rule yet, non-AWS providers | listed with the reason, not in the total |

- USD, on-demand, for the region found in your state (falling back to `defaultRegion`).
- Tiered prices are applied band by band (e.g. S3, Lambda compute).
- Free tier is **off by default**, matching the AWS Pricing Calculator.
- Not included: savings plans, reserved capacity, taxes, support plans, data transfer out to the internet.
- Root volume size is assumed to be 8 GB gp3 when the launch template doesn't say; the cost line notes this.

---

## Configuration

`terraprev.config.json` (all keys optional):

```json
{
  "stateFile": "../floci-terraform/terraform.tfstate",
  "port": 4610,
  "defaultRegion": "us-east-1",
  "priceCacheDays": 7
}
```

| Environment variable | Overrides / does |
|---|---|
| `TERRAPREV_STATE` | `stateFile` |
| `TERRAPREV_REGION` | `defaultRegion` |
| `PORT` | API port (live server) |
| `CHROME_PATH` | Browser used for PDF export, if not found automatically |
| `TERRAPREV_BUILD_ARGS` | Extra options `bin/tf` passes to the build, e.g. `"--pdf --report"` |

---

## Privacy and security

- **Nothing leaves your machine.** The only network requests are downloads of AWS's public price lists.
- **Secrets are stripped.** Values Terraform marks as sensitive (passwords, `random_password` results, secret values) never reach the page or the reports. Tests check this.
- The live server listens on `127.0.0.1` only.
- The snapshot and brief contain your Terraform source blocks and resource names. They're written to `out/` (git-ignored). Treat them like the state file before sharing.

---

## Deterministic output

The same state, prices and settings produce **byte-identical** Markdown and PDF, on any machine, in any timezone or locale:

- There is no "generated at" time. Each report carries an **input fingerprint** (`report ecc256badd41`); the same ID means the same inputs.
- Dates come from the state's last-applied time and are always shown in UTC.
- Every list has a fixed sort order.
- Fonts are bundled rather than fetched, so PDF rendering doesn't depend on load timing.
- PDF creation dates are set to the last-applied time instead of the print time.

Covered by `server/test/report.test.ts`. (In testing, 1 of ~20 PDF builds differed and wasn't reproducible; the Markdown has always matched.)

---

## Limitations

- **AWS pricing only.** Other providers are drawn but listed as *not priced*.
- Reads **local state files**. For remote backends, use `terraform state pull` (see [Commands](#commands)).
- Shows what was **last applied**, not pending changes in your `.tf` files. The Terraform tab warns when a file changed since the last apply.
- Linux on-demand prices are assumed for EC2; Windows/RHEL AMIs cost more.
- Findings only cover what the rules check; no finding doesn't mean no problem.
- PDF export from the command line needs a Chromium-based browser installed; viewing works in any modern browser.

---

## Extending terraprev

| To add… | Edit | Notes |
|---|---|---|
| A resource type to the diagram | `server/src/graph/catalog.ts` | category, short tag, parent to fold into, links |
| A pricing rule | `server/src/pricing/aws/mappers.ts` | find the `usageType` in the AWS offer CSV; add a test in `server/test/pricing.test.ts` |
| A finding | `server/src/insights/aws.ts` | one `if` on state attributes → `add({ severity, title, detail, recommendation })` |
| An AWS display name | `shared/awsNames.ts` | Terraform type → `[service, resource]` |
| Another cloud | implement `ProviderPricer` (`server/src/pricing/types.ts`), register it in `index.ts` and `cli/build.ts` | Azure Retail Prices needs no auth; GCP needs an API key |

---

## Development

```bash
npm install
npm run dev        # http://localhost:4600, reloads on change
npm test           # graph, pricing, redaction, source lookup, report, determinism
npm run typecheck
```

### Project layout

```
bin/tf                      terraform wrapper: rebuild the snapshot after state-changing commands
server/src/
  cli/build.ts              snapshot / PDF / report builder (no server)
  index.ts, watch.ts        live server: watch state, push updates over SSE
  state/                    parse state, collect sensitive values
  graph/                    diagram model: catalog, layout relationships, IAM/SG access
  pricing/aws/              price list download + cache, resource → SKU rules
  insights/aws.ts           findings for the brief
  source/                   find the .tf block for a resource
shared/                     used by server and web: types, cost math, report, flow tracing, AWS names
web/src/                    React app: diagram (React Flow + ELK), panels, report view
```

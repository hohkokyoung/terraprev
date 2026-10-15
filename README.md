# terraprev

**See your Terraform stack's architecture and AWS cost, every time you apply.**

[![terraprev demo: diagram, cost breakdown, usage sliders, data flow, IAM, CTO brief](docs/demo.gif)](docs/demo.mp4)

<sub>▶ [Full-resolution video](docs/demo.mp4)</sub>

terraprev reads your `terraform.tfstate` and runs entirely on your machine: no AWS account, no credentials, nothing uploaded. It works with real AWS and with emulators such as LocalStack or floci, showing what the same stack would cost on real AWS.

## Features

- **Architecture diagram.** Cloud → VPC → subnets → resources, laid out automatically. Traffic arrows come from real relationships in state: ALB → ASG, SNS → SQS, SQS → Lambda, security-group rules (`ASG → RDS tcp 5432`).
- **Monthly cost.** On-demand list prices from the AWS Price List API for your region. Every number links to its SKU and the price file behind it. Anything terraprev can't price is listed as *not priced*, never silently counted as $0.
- **Usage sliders.** Set Lambda invocations, S3 storage, NAT data and other usage-based charges, and the total follows. An optional switch applies the AWS Always Free tier.
- **Inspector.** Click any resource for its cost lines, configuration, IAM role and security group rules in plain English, and the `resource {}` block from your `.tf` files.
- **Data flow.** Highlight every path that can reach a resource, e.g. *Internet → ALB → ASG → RDS*.
- **CTO brief.** Executive summary, cost drivers, findings with recommendations and security posture, as Markdown (with a Mermaid diagram) or PDF.
- **Snapshot file.** One self-contained HTML page that opens offline, plus an optional one-page diagram PDF. The same inputs always give byte-identical output.

## Quick start

Needs **Node.js 22.18+**. Command-line PDF export also needs Chrome, Edge, Brave or Chromium.

```bash
git clone https://github.com/hohkokyoung/terraprev && cd terraprev
npm install
npm run snapshot -- --state ../my-stack/terraform.tfstate --open
```

The first run downloads AWS price lists (about a minute). After that, builds take ~30 ms and work offline.

**Rebuild on every apply.** `bin/tf` is a drop-in wrapper for `terraform`: it runs the real command, then rebuilds the snapshot whenever state may have changed. A failed snapshot never fails your apply.

```bash
~/terraprev/bin/tf apply
TERRAPREV_BUILD_ARGS="--pdf --report" tf apply   # also write the PDFs
```

**Live mode.** `npm run dev` serves http://localhost:4600 and updates within a second of each apply, highlighting what changed.

## Options

`npm run snapshot -- [options]`

| Option | Description |
|---|---|
| `--state <path>` | State file to read (default: `stateFile` in config) |
| `--out <file.html>` | Snapshot path; other outputs go next to it (default `out/terraprev.html`) |
| `--open` | Open the snapshot when done |
| `--pdf`, `--pdf-out <file>` | Also write the diagram as an A4 landscape PDF |
| `--report` | Also write the CTO brief as `<stack>-brief.md` and `.pdf` |
| `--theme light\|dark` | Theme for the PDFs |
| `--free-tier` | Apply AWS Always Free allowances in the PDFs and brief |
| `--offline` / `--refresh-prices` | Never download prices / re-download them now |
| `-q`, `--quiet` | Print only errors |

For remote state (S3, Terraform Cloud…), pull it to a file first: `terraform state pull > /tmp/stack.tfstate`.

Defaults live in `terraprev.config.json`: `stateFile`, `defaultRegion`, `port` and `priceCacheDays` (how often prices refresh, default 7). The environment variables `TERRAPREV_STATE`, `TERRAPREV_REGION`, `PORT` and `CHROME_PATH` override them.

## How it works

**Costs.** Always-on charges (instance hours, NAT, ALB, public IPv4, RDS storage…) come from state × 730 hours. Usage charges come from the sliders. Free resources (IAM, subnets, security groups…) are listed at $0. Prices are USD on-demand. Savings plans, reserved capacity, taxes and data transfer out are not included.

**Findings.** Plain rules over state attributes, with no AI and no guessing. For example: RDS backups disabled (`backup_retention_period = 0`), storage not encrypted, IMDSv1 allowed, one NAT gateway for several AZs, non-web ports open to `0.0.0.0/0`, credentials hard-coded in user data.

**Privacy.** The only network requests are downloads of AWS's public price lists. Values Terraform marks as sensitive never reach the page or the reports. The live server listens on `127.0.0.1` only. Snapshots include your resource names and `.tf` blocks, so share them as carefully as the state file.

## Limitations

- Prices AWS only. Other providers are drawn but not priced.
- Shows what was last applied, not pending changes in your `.tf` files.
- Assumes Linux on-demand prices for EC2.
- Findings cover only what the rules check: no finding doesn't mean no problem.

## Development

```bash
npm run dev         # live server + web app with hot reload
npm test            # offline test suite
npm run typecheck
```

| To add… | Edit |
|---|---|
| A resource type to the diagram | `server/src/graph/catalog.ts` |
| A pricing rule | `server/src/pricing/aws/mappers.ts` (+ a test in `server/test/pricing.test.ts`) |
| A finding | `server/src/insights/aws.ts` |
| An AWS display name | `shared/awsNames.ts` |
| Another cloud | implement `ProviderPricer` in `server/src/pricing/types.ts` |

The demo video is made with [Remotion](https://www.remotion.dev) from screenshots of a real snapshot: `npm run capture` (needs `out/terraprev.html`), then `npm run render` and `npm run render:gif` in `video/`.

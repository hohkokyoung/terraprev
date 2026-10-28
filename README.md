# terraprev

**See your Terraform stack's architecture and AWS cost, every time you apply.**

Point terraprev at a `terraform.tfstate` (or a plan, before you apply it) and you get:

1. **An architecture diagram** of your VPCs, subnets and resources, with the traffic between them.
2. **A monthly AWS cost estimate**, line by line, from AWS's official price list.
3. **A brief for your CTO**: summary, cost drivers, risks and how to fix them, as Markdown or PDF.
4. **A preview of a plan**: what it adds, changes and destroys, and what that does to the bill, before anything is applied.
5. **A comparison of two stacks**, such as staging and prod: what only one has, what's set up differently, and what each costs.

It runs on your machine: no AWS account, no credentials, nothing uploaded. It also works with emulators such as LocalStack or floci, showing what the same stack would cost on real AWS.

![terraprev in 15 seconds: the snapshot page with the diagram and monthly bill, a line-by-line cost breakdown, findings with fixes, and an AI assistant asking terraprev what drives the bill](docs/teaser.webp)

▶ [Watch the launch video (24 s, 1080p, with sound)](https://github.com/user-attachments/assets/4c07746c-11fa-41d2-91a4-96ae6d989016)

## Features

### See the architecture

- **Diagram, laid out for you.** Cloud → VPC → subnets → resources. Arrows come from real relationships in state: ALB → ASG, SNS → SQS, SQS → Lambda, security-group rules (`ASG → RDS tcp 5432`).
- **Data flow.** Pick a resource and every path that can reach it lights up, e.g. *Internet → ALB → ASG → RDS*.
- **Access in plain English.** Draw a resource's IAM role, policies and security groups on the diagram.
- **Inspector.** Click anything for its configuration and the `resource {}` block from your `.tf` files.

### Know the cost

- **Monthly estimate** from the AWS Price List API, on-demand prices for your region.
- **Every dollar explained.** Each line shows quantity × unit price, linked to the SKU and the price file behind it.
- **Usage sliders** for traffic-based charges (Lambda invocations, S3 storage, NAT data…); the total follows. Optional AWS Always Free tier. Saved in `terraprev.usage.json` next to the state, so snapshots and the MCP server price at the same assumptions, and they can be reviewed in git.
- **Nothing hidden.** Anything terraprev can't price is listed as *not priced*, never counted as $0.
- **Ways to save.** Priced suggestions that remove nothing: Graviton instance types, gp3 volumes, 1-year reservations for always-on instances, arm64 Lambdas, idle IPs, log retention, free S3/DynamoDB gateway endpoints. Each comes with the Terraform change and what it takes.
- **Cost over time.** Every apply adds a point, so you see what the last change did to the bill (*+18% since 16 Sep, mostly Database*).

### Before you apply

- **Plan preview.** Feed it a plan and the diagram shows what will be added, changed, replaced or destroyed, each with its monthly cost change, plus the findings the plan introduces or fixes. Nothing is applied, and terraprev needs no credentials.
- **Compare two stacks.** Staging against prod, or this week against last, side by side: what only one has, what's configured differently, and what each costs. Neither side is "right": the gap is shown without a verdict.
- **Two pickers, no flags.** In live mode, **[prod ▾] vs [staging ▾]** in the header picks any stack or plan in the folder and what to compare it with. Pick them the other way round to flip the sides, or pick no comparison to look at one stack on its own.
- **Ready for a pull request.** Both write a Markdown summary next to the page, ready to paste as a PR comment.

### Share it

- **CTO brief.** Executive summary, cost drivers, findings and security posture, as Markdown (with a Mermaid diagram) or PDF. With a plan or comparison on screen, the brief and its PDF cover that too: both stacks in the title and header, a table of what differs, and the diagram marked up with a legend.
- **Findings with fixes.** Rule-based checks for disabled backups, unencrypted storage, IMDSv1, open ports and more.
- **One snapshot file.** A self-contained HTML page that opens offline, plus an optional one-page diagram PDF. The same inputs always give byte-identical files.
- **Always current.** `bin/tf` rebuilds the snapshot on every apply; live mode updates the page within a second.
- **Ask your AI assistant.** An MCP server lets Claude, Cursor and other assistants read the same diagram, costs and findings. See [MCP](#mcp).

## Quick start

Needs **Node.js 22.18+**. Command-line PDF export also needs Chrome, Edge, Brave or Chromium.

```bash
git clone https://github.com/hohkokyoung/terraprev && cd terraprev
npm install
npm run snapshot -- --state ../my-stack/terraform.tfstate --open
```

The first run downloads AWS price lists (about a minute) and caches them. After that, builds take ~30 ms and need no network.

**Rebuild on every apply.** `bin/tf` is a drop-in wrapper for `terraform`: it runs the real command, then rebuilds the snapshot whenever state may have changed. A failed snapshot never fails your apply.

```bash
~/terraprev/bin/tf apply
TERRAPREV_BUILD_ARGS="--pdf --report" tf apply   # also write the PDFs
```

**Live mode.** `npm run dev` serves http://localhost:4600 and updates within a second of each apply, highlighting what changed. The two pickers in the header choose what's on show and what to compare it with: **[prod ▾] vs [staging ▾]**. The left one lists every `.tfstate` in the stack's folder (the watched one is marked *live*) and any plans saved there (`plan.json`, or `plan.out` when `terraform` is on your PATH); the right one is another stack, or no comparison. The pickers look a few levels down from the state file's folder; for side-by-side env folders (`envs/prod`, `envs/staging`), set `compareRoot` to `envs`. The server reads nothing outside it.

**Preview a plan before applying it.** `bin/tf plan` does this for you: it saves the plan (to a temp file, unless you pass `-out`), writes `out/terraprev-plan.html` and `.md`, and prints the cost change. By hand:

```bash
terraform plan -out=plan.out && terraform show -json plan.out > plan.json
npm run snapshot -- --plan plan.json --dir . --open
```

`--plan` also takes `plan.out` itself when `terraform` is on your PATH. `plan.json` holds every value in plain text, secrets included, so delete it afterwards.

**Compare two stacks.** In live mode, pick them in the header. From the command line, the page shows `--state`, compared with `--compare`:

```bash
npm run snapshot -- --state ../prod/terraform.tfstate --compare ../staging/terraform.tfstate --open
```

## MCP

terraprev also runs as an [MCP](https://modelcontextprotocol.io) server, so an AI assistant can answer questions like *"what does this stack cost, and what's driving it?"* or *"what can reach the database?"* from your state file. It uses the same code as the snapshot, and runs locally over stdio.

Claude Code:

```bash
claude mcp add terraprev -- node ~/terraprev/server/src/cli/mcp.ts --state ~/my-stack/terraform.tfstate
```

Other clients (Claude Desktop, Cursor…) take the same command in their JSON config:

```json
{
  "mcpServers": {
    "terraprev": {
      "command": "node",
      "args": ["/path/to/terraprev/server/src/cli/mcp.ts", "--state", "/path/to/terraform.tfstate"]
    }
  }
}
```

`--state` is optional (default: `stateFile` in config), and every tool also takes a `state` path, so one server can answer for several stacks. `--offline` never downloads prices. Run `npm run snapshot` once first so the price cache is ready; otherwise the first call waits about a minute for the download.

| Tool | Returns |
|---|---|
| `stack_overview` | Summary, monthly total, top cost lines, finding counts, every resource |
| `find_resources` | Resources matching filters: kind, VPC or subnet, monthly cost range, reachable from the internet, finding severity, usage-based |
| `estimate_cost` | Every cost line (quantity × unit price, SKU, price page), usage assumptions (and whether each is saved or the default), unpriced resources. Takes `usage` overrides and `free_tier` for one call |
| `set_usage` | Saves usage assumptions and the free tier switch to `terraprev.usage.json`; the live page follows within a second |
| `what_if` | Prices a change before it is written: attributes set (`instance_class`, `multi_az`, `desired_capacity`…) or resources removed. Cost before and after per resource, findings added or fixed |
| `list_findings` | Findings with what was seen and how to fix it, optionally by severity |
| `describe_resource` | One resource: configuration, location, connections, paths that reach it, IAM and security groups, cost, findings, its `.tf` block |
| `get_brief` | The CTO brief as Markdown |
| `suggest_savings` | Priced ways to cut the bill, with the Terraform change and what each takes |
| `cost_history` | The monthly cost at each apply, and what moved it |
| `preview_plan` | What a plan (`terraform show -json` output) adds, changes and destroys, the cost before and after, new and fixed findings, and Markdown for a PR |
| `compare_stacks` | This stack against another state file: what only one has, what differs, what each costs |
| `build_snapshot` | Writes the HTML snapshot, and optionally the PDFs and brief |

Every tool prices at the saved usage assumptions (`terraprev.usage.json`, the same file the page's sliders write), else the defaults. The tools return what the page shows: sensitive values never appear in them.

Prompts, shown as slash commands in clients that support them: `review_plan` (cost, risk and a PR comment for a plan), `explain_bill`, `cost_change` (why the bill moved), `harden_stack` (high and medium findings with fixes) and `price_change` (price a change in plain words with `what_if`).

## Options

`npm run snapshot -- [options]`

| Option | Description |
|---|---|
| `--state <path>` | State file to read (default: `stateFile` in config) |
| `--plan <plan.json>` | Preview a plan instead: `terraform show -json` output, or a saved plan file. Writes `out/terraprev-plan.html` and `.md` |
| `--compare <other.tfstate>` | Show `--state` compared with another stack. Writes `out/terraprev-compare.html` and `.md` |
| `--dir <folder>` | Where the `.tf` files are (default: next to the state or plan file) |
| `--out <file.html>` | Snapshot path; other outputs go next to it (default `out/terraprev.html`) |
| `--open` | Open the snapshot when done |
| `--pdf`, `--pdf-out <file>` | Also write the diagram as an A4 landscape PDF |
| `--report` | Also write the CTO brief as `<stack>-brief.md` and `.pdf` |
| `--theme light\|dark` | Theme for the PDFs |
| `--free-tier` | Apply AWS Always Free allowances in the PDFs and brief |
| `--offline` / `--refresh-prices` | Never download prices / re-download them now |
| `-q`, `--quiet` | Print only errors |

For remote state (S3, Terraform Cloud…), pull it to a file first: `terraform state pull > /tmp/stack.tfstate`.

Defaults live in `terraprev.config.json`: `stateFile`, `defaultRegion`, `port`, `priceCacheDays` (how often prices refresh, default 7), `historyDir` (default `history/`) and `compareRoot` (where the live page's Compare and Plan pickers look; default the state file's folder). The environment variables `TERRAPREV_STATE`, `TERRAPREV_REGION`, `TERRAPREV_HISTORY`, `TERRAPREV_COMPARE_ROOT`, `PORT` and `CHROME_PATH` override them.

## How it works

**Costs.** Always-on charges (instance hours, NAT, ALB, public IPv4, RDS storage…) come from state × 730 hours. Usage charges come from the sliders, saved in `terraprev.usage.json` next to the state (one file per folder, so stacks side by side share it; delete it to go back to the defaults). Free resources (IAM, subnets, security groups…) are listed at $0. Prices are USD on-demand. Savings plans, reserved capacity, taxes and data transfer out are not included.

**Plan previews.** The plan's prior state and planned values go through the same diagram, pricing and findings as a state file, and the two are compared. New resources have no ids yet, so terraprev follows the references in the plan's configuration to draw their connections (a new NAT gateway and its new Elastic IP, an instance and its new security group), through module outputs and inputs too. A new instance's public IPv4 is priced from its subnet's `map_public_ip_on_launch`. Other cost-relevant values Terraform only knows after apply can't be priced; those resources are marked ⚠. The plan reader is tested against real `terraform show -json` output (`server/test/real-plan/`).

**Comparisons.** Both stacks go through the same diagram, pricing and findings, with the same usage settings. A resource differs when its shown configuration or its cost does; ids, ARNs and endpoints are ignored, since they always differ between stacks. The diagram is the stack on show; what only the other one has is drawn dashed where it sits there.

**Savings.** Each suggestion is the same resource priced with one thing changed (a Graviton instance type, gp3, arm64, 30-day log retention) or a 1-year standard No Upfront reservation from the same price list. Savings follow the usage sliders and free tier. Two that change the same cost line (Graviton, or reserving the same instances) are counted once in the total.

**History.** `npm run snapshot` (so `bin/tf apply`) and the live server record one point per state serial in `history/<lineage>.json`: always-on and default-usage cost, by category. Plan previews and comparisons don't record anything.

**Findings.** Plain rules over state attributes, with no AI and no guessing. For example: RDS backups disabled (`backup_retention_period = 0`), storage not encrypted, IMDSv1 allowed, one NAT gateway for several AZs, non-web ports open to `0.0.0.0/0`, credentials hard-coded in user data.

**Offline use.** Only the price lists need the internet: once on the first run, then a refresh every 7 days (`priceCacheDays`). EC2 and RDS lists also keep 1-year reserved rates now; a cache from an older terraprev refreshes once for them. If a refresh fails, the cached prices are used; `--offline` never tries. Everything else works without a connection, including both PDFs (printed by the Chrome or Edge on your machine), apart from the links to AWS pricing pages and raw price files.

**Privacy.** The only network requests are downloads of AWS's public price lists. Values Terraform marks as sensitive never reach the page or the reports. The live server listens on `127.0.0.1` only, and its stack pickers read nothing outside `compareRoot`. Snapshots include your resource names and `.tf` blocks, so share them as carefully as the state file.

## Limitations

- Prices AWS only. Other providers are drawn but not priced.
- Pending changes need a plan (`bin/tf plan`, `--plan`, or a plan file picked in live mode); unsaved edits to `.tf` files aren't read.
- Reservations are 1-year standard No Upfront only; Savings Plans aren't priced.
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
| What the live page's stack pickers list and read | `server/src/views.ts` |
| Another cloud | implement `ProviderPricer` in `server/src/pricing/types.ts` |

The videos are made with [Remotion](https://www.remotion.dev) from screenshots of a real snapshot, following the [/brag-slim](https://github.com/latent-spaces/brag) recipe: `npm run capture` (needs `out/terraprev.html`), then, in `video/`, `npm run teaser` (the loop at the top of this page, `docs/teaser.webp`) and `npm run render` (the launch video with its soundtrack, `video/out/brag.mp4`, plus its poster `brag.jpg`). The soundtrack is synthesised by `video/brag-audio.ts`, with no samples. Both videos take their timings from `video/src/brag-timeline.ts`, so picture and sound stay in sync. The earlier 40-second feature tour is still there: `npm run render:tour`. GitHub only plays video it hosts, so to update the video link, drag the MP4 into a GitHub issue or comment box and use the link it gives.

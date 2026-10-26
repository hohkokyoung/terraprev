# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Infrastructure engineers (DevOps, platform, SRE) working on a Terraform stack. The main moment is right after `terraform apply`, or before merging a plan: they want to see what the stack now looks like, what changed, and what it costs, without opening the AWS Console.

A second audience reads the output rather than the app: a CTO or engineering lead who receives the brief (Markdown or PDF) or a plan/comparison summary pasted into a pull request.

## Product Purpose

terraprev turns a `terraform.tfstate` (or a plan) into an architecture diagram, a line-by-line monthly AWS cost estimate, findings with fixes, and a shareable brief. Success is an engineer understanding the shape and cost of their stack, and the effect of a change, in under a minute, and trusting every number enough to act on it or forward it.

## Positioning

- Runs entirely on the engineer's machine: no AWS account, no credentials, nothing uploaded. The only network traffic is AWS's public price lists.
- Every dollar is explained: quantity × unit price, linked to the SKU and price file. Anything it can't price is listed as *not priced*, never counted as $0.
- Works from state alone, including emulator stacks (LocalStack, floci), showing what the same stack would cost on real AWS.
- Same inputs give byte-identical snapshot files.

## Operating Context

- `bin/tf apply` rebuilds a self-contained HTML snapshot (and optional PDFs and brief) on every apply.
- Live mode (`npm run dev`, localhost) updates within a second of each apply and highlights what changed. Header pickers choose a stack or plan and what to compare it with (e.g. prod vs staging).
- Plan preview and stack comparison write Markdown summaries meant to be pasted as PR comments.
- An MCP server lets AI assistants (Claude, Cursor) query the same diagram, costs and findings.
- Engineers usually have a terminal and editor open alongside; the page is a check-in between commands, not a place they live all day.

## Capabilities and Constraints

- Surfaces: live web app (React + Vite + React Flow + ELK layout), offline HTML snapshot, A4 landscape diagram PDF, CTO brief (Markdown with Mermaid, and PDF), light and dark themes.
- Diagram: Cloud → VPC → subnet → resource, edges from real relationships in state, data-flow paths, IAM/security-group overlays, inspector with config and the `resource {}` block.
- Cost: AWS on-demand prices for the region, usage sliders for traffic-based charges, optional Always Free tier, savings suggestions with the Terraform change, cost history per state serial.
- Prices AWS only; other providers are drawn but not priced.
- Pending changes need a plan; unsaved `.tf` edits are not read.
- Snapshots contain resource names and `.tf` blocks; sensitive values never reach the page.
- Terminology: stack, snapshot, live mode, plan preview, compare, brief, findings, not priced, always-on vs usage cost.

## Brand Commitments

Personality stated by the user: precise, calm, trustworthy; also fast, technical, dense. Information-rich screens for experts, with every figure explained and nothing shouting.

Reference the user made binding: engineering drawings (measured, labeled, exact).

Anti-references the user made binding: the AWS Console (cluttered, inconsistent, buried information); neon "hacker" dark mode (green-on-black, glow); playful or cartoony UI (illustrations, bouncy motion, emoji-heavy).

## Evidence on Hand

- `docs/teaser.webp`: 15-second loop of the snapshot page, cost breakdown, findings and MCP assistant.
- Launch video (24 s) linked from the README; source in `video/`.
- Sample outputs in `out/`: snapshot HTML, plan preview, diagram PDFs (light and dark), CTO brief.
- No customers, testimonials, usage numbers or benchmarks exist. Do not invent them.

## Product Principles

1. **Every number shows its working.** A figure without its quantity, unit price and source is not finished.
2. **Never hide what's unknown.** Unpriced, unsupported or missing data is stated plainly, never rounded to zero or silently dropped.
3. **Density for experts, calm in tone.** Show a lot at once, but keep the page quiet so the change that matters stands out.
4. **Show the gap, not a verdict.** Comparisons and plans state differences and their cost; the engineer decides what's right.
5. **Local and reproducible.** Nothing leaves the machine, and the same inputs always produce the same output.

## Accessibility & Inclusion

WCAG 2.2 AA across the live app, snapshot and PDFs: text contrast, full keyboard access (including the diagram and pickers), visible focus, reduced-motion alternatives, and status colors (added, changed, destroyed, findings) that never rely on color alone.

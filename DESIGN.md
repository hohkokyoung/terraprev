---
name: terraprev
description: What a Terraform stack looks like and costs, after apply — drawn like an engineering drawing.
colors:
  bg: "#f4f2ec"
  canvas: "#f8f7f3"
  panel: "#fffefb"
  code-bg: "#f3f1ea"
  ink: "#1c1d20"
  ink-2: "#4a4c52"
  ink-3: "#6c6d72"
  line: "#e2dfd6"
  line-2: "#cfcbbf"
  dots: "#d6d2c6"
  accent: "#1f6feb"
  ok: "#277540"
  warn: "#985518"
  bad: "#c2382f"
  fresh: "#36b46b"
  iam: "#b04034"
  sg: "#7055b7"
  vpc: "#7a5cc7"
  cat-compute: "#9b551e"
  cat-database: "#3262c7"
  cat-storage: "#2f7342"
  cat-network: "#7055b7"
  cat-integration: "#b13764"
  cat-api: "#13707a"
  cat-security: "#b04034"
  cat-monitoring: "#83620b"
  cat-other: "#65676e"
  t-com: "#8a8c92"
  t-str: "#2f7d4a"
  t-key: "#1f5fb8"
  t-ref: "#b5651d"
  t-lit: "#a0522d"
  t-kw: "#a2408f"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  heading:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  ui:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  secondary:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.06em"
  tag:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.04em"
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.65
rounded:
  xs: "3px"
  tight: "4px"
  sm: "5px"
  md: "6px"
  lg: "8px"
  strip: "10px"
  xl: "12px"
  pill: "24px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-quiet:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
    typography: "{typography.secondary}"
  button-ghost:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ink-2}"
    padding: "0"
  chip-status:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xs}"
    padding: "1px 5px"
    typography: "{typography.tag}"
  chip-overlay:
    textColor: "{colors.iam}"
    rounded: "{rounded.xs}"
    padding: "2px 4px"
    typography: "{typography.tag}"
  card-panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.lg}"
    padding: "16px"
  input-numeric:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
    typography: "{typography.label}"
---

# Design System: terraprev

## Overview

**Creative North Star: "The Engineering Drawing"**

terraprev's screens are drawings, not dashboards. An engineering drawing is read by someone who will build from it, so every line is measured, every part is labeled, and nothing is drawn for effect. The interface keeps the same contract: a warm paper ground, hairline structure drawn at exactly 1px, one blue that behaves like the single ink used to mark up a drawing, and a fixed hue per AWS resource category so the same thing is always the same color. Density is high — this is a tool an engineer checks between terminal commands — and the tone stays quiet, because the change that just applied should be the loudest thing on the page, never the page itself.

Depth is carried almost entirely by tone and hairlines — page shell, drafting canvas, panel — with a single soft "floating chrome" shadow reserved for small controls that sit on top of the drawing. Data is never blurred, glazed or layered in glass; the drawing metaphor forbids atmosphere. Everything uncertain is stated plainly: "not priced" appears as ink, not a rounded zero.

The system is explicitly not the AWS Console (no inconsistent chrome, no buried information, no hard-saturated fills), not neon "hacker" dark mode (no green-on-black, no glow), and never playful (no illustrations, no bouncy motion, no emoji as UI).

**Key Characteristics:**
- Warm-paper neutrals (page `#f4f2ec`, canvas `#f8f7f3`, panel `#fffefb`) instead of pure white or black.
- One accent blue for the entire interface; nine fixed category hues used only as small identifiers.
- 1px hairline borders and tonal layering carry structure; one shared soft shadow under floating chrome.
- A single Inter type scale from 10 to 28px, tabular figures on every number, JetBrains Mono only for code and identifiers.
- Small radii (3–8px); resources and boundaries drawn as flat 1px contours with no fills or shadows; change and status carried by worded tags, not color alone.
- Light and dark are two prints of the same drawing: identical structure, swapped papers.

## Colors

The palette is drafting paper plus one mark-up pen: warm paper neutrals do the drawing, a single blue does the pointing, and a fixed set of category and status hues acts as labeled stamps — small, consistent, never filling large areas. Values below are the light theme; the dark theme swaps each paper token for its night print (see `.impeccable/design.json` for the full dark map).

### Primary
- **Printing Blue** (`#1f6feb`): the only accent. Selection rings, links, active tab states, "current view" badges, cost bars in the brief, the trace highlight on the diagram, and focus rings. In the dark theme it lightens to a sky blue so it keeps the same contrast against night paper.

### Status
Used as small outlined tags next to words, never as the only signal (WCAG 2.2 AA):
- **Check Green** (`#277540`): monthly ok / fixed items, statements Allow (in dark tint backgrounds).
- **Annotation Ochre** (`#985518`): warnings and findings, "changed" deltas, slider caution, plan-preview banner.
- **Revision Red** (`#c2382f`): errors, "removed/destroyed", deny statements, high-severity findings.
- **Apply Green** (`#36b46b`): the transient just-applied pulse in the diagram and banner; deliberately brighter than Check Green and used only for the moment after apply.

### Category hues
Nine fixed hues, one per AWS resource category, used as a node's type cell (a 14% tint with the code in the hue), a legend dot or a cost bar — never as a wider surface fill or a side stripe: **Computer Amber** (`#9b551e`), **Database Blue** (`#3262c7`), **Storage Leaf** (`#2f7342`), **Network Violet** (`#7055b7`), **Integration Rose** (`#b13764`), **API Teal** (`#13707a`), **Security Rust** (`#b04034`), **Monitoring Brass** (`#83620b`), **Unclassified Grey** (`#65676e`). Network Violet doubles as the VPC boundary stroke and dotted route-line color.

### Overlay hues
- **IAM Rust** (`#b04034`) and **Security Violet** (`#7055b7`): the IAM / security-group chips clipped to node bottom edges; Security Violet reuses Network Violet so firewalls read as network-domain objects.

### Neutral
All neutrals are slightly warm — no pure white or black anywhere on a screen:
- **Warm Paper** (`#f4f2ec`): the page background around everything; also row-hover and inset control fill.
- **Drafting Canvas** (`#f8f7f3`): the diagram ground, with **Graph Dots** (`#d6d2c6`) as its dot grid.
- **Tracing Panel** (`#fffefb`): every raised surface: top bar, side panel, node cards, chips, menus.
- **Code Paper** (`#f3f1ea`): HCL source blocks only.
- **Blueprint Ink** (`#1c1d20`): primary text and the strongest borders (2px rules under brief headings, table totals).
- **Slate Ink** (`#4a4c52`): secondary text, solid dependency edges, arrowheads.
- **Pencil Grey** (`#6c6d72`): muted text, dashed "uses" edges; never below WCAG AA at its size.
- **Hairline Sand** (`#e2dfd6`) / **Hairline Umber** (`#cfcbbf`): the two-duct border scale; Sand separates sections, Umber outlines drawing elements.

### Syntax palette
HCL blocks get their own fixed six-color assignment (Comment `#8a8c92`, String `#2f7d4a`, Attribute key `#1f5fb8`, Interpolation/Reference `#b5651d`, Literal `#a0522d`, Keyword/Function `#a2408f`), identical on both papers, and are not reused for any other UI role.

### Named Rules (optional, powerful)
**The One Voice Rule.** Printing Blue is the only accent. It points: selection, links, active state, live attention. It never tints a surface wider than a banner, and no second accent exists.
**The Labeled-Color Rule.** A color never carries meaning alone. Status and change states always ride with words (pills, keys, captions); the hue is a second reading of the same text.
**The Stamped-ID Rule.** Category and overlay hues are small stamps — a node's type cell, a dot, a bar, colored tag text. They identify; they never decorate, fill panels, or run down a card's edge.

## Typography

**Display Font:** Inter (fallback: `ui-sans-serif`, system-ui) — every UI and document role.
**Body Font:** Inter — same face; hierarchy comes from size and weight, not from a second family.
**Label/Mono Font:** JetBrains Mono (fallback: `ui-monospace`, SF Mono, Menlo) — only for addresses, CIDRs, HCL, file paths and SKU links.

**Character:** A technical pairing that behaves like lettering on a drawing: Inter is neutral, tightly tracked and information-dense; JetBrains Mono is the measured annotation hand appended wherever an exact identifier matters. One continuous scale from 10 to 28px does all the work; no ad-hoc sizes exist anywhere.

### Hierarchy
- **Display** (700, 28px, 1.2): the document title in the CTO brief only.
- **Headline** (600, 24px, tabular figures, −0.025em): key money figures — the monthly total in the top bar, the resource total in the inspector.
- **Title** (600, 18px, −0.015em): page-level headings, the inspector's resource name, reporting h2.
- **Heading** (600, 15px, −0.01em): section titles, brand, group-node labels.
- **Body** (400, 14px, 1.6): document/brief prose.
- **UI body** (400, 13px, 1.5): interface text, table cells, findings.
- **Secondary** (400, 12px, 1.5): captions, controls, small meta.
- **Label** (600, 11px, uppercase, +0.06em): the caps-label — section headers, `<dt>` categories, KPI and table-column eyebrows.
- **Tag** (700, 10px, uppercase, +0.04em): badges, pills, change stamps, severity marks.
- **Mono** (400, 11px/1.65): code blocks with line numbers; 0.9em inline in prose.

### Named Rules (optional)
**The Tabular-Figure Rule.** Every number, money or count, is set in Inter with tabular figures (`font-variant-numeric: tabular-nums`) so columns of figures line up vertically; money values right-align and keep unit prefixes distinct.
**The Mono-Boundary Rule.** JetBrains Mono marks machine text — addresses, ARNs, HCL, paths, SKUs. It never sets prose, labels, or buttons.
**The Caps-Label Rule.** All-caps is a label texture, not an emphasis tool: 11px/600 with +0.06em tracking, muted ink, used for eyebrows above content — never for sentences.
**The Negative-Track Rule.** Anything 15px and larger reads as display and gets negative tracking (−0.01em to −0.025em); small sizes keep default tracking.

## Layout

One app shell: a fixed top bar (brand · state-file picker · compare pickers · right-aligned monthly total · controls) over a two-column drawing table — the diagram canvas fills the left fraction of a `1fr / 380px` grid, and the right panel of stacked bordered sections holds costs, findings, access and the HCL inspector. Sections inside the panel step down with 1px rules and 14/16px padding; the canvas carries its own tool row: flat, outlined controls laid over the drawing, no shadows. The brief (`report`) is a fixed 880px-max paper sheet centered on the page.

Density is deliberate: rows step tightly (2px gaps in cost lists, 8px in tables), and services share screen happily. Motion is limited to state responses (see motion tokens); the page never animates for show.

Responsive behavior (nested `max-width` guards, one column per step):
- **1200px**: the top bar wraps — the state file drops to its own row; the side panel keeps its width.
- **900px**: the two columns stack — diagram first at ~62vh (scrollable), panel below at full height; tabs go sticky; minimap and the panel-collapse handle disappear.
- **700px**: the brief sheet loses its margins (border-radius 0, edge-to-edge) and its meta grid drops to two columns.
- **600px**: the top bar reorders into three phone rows (total first, controls second, state file third); canvas tools become one swipeable row.
Coarse pointers get 16px input text to stop iOS zoom-on-focus.

### Print
The diagram PDF is one fixed A4-landscape sheet (1123×794px) in the current theme with shadows stripped; the brief prints as a flowed A4 portrait document (182mm content width, 11.5px body) with headings kept against page breaks.

## Elevation & Depth

The system is flat by default and layered by tone. Depth reads as three paper steps — **Warm Paper** (page) behind **Drafting Canvas** (diagram) behind **Tracing Panel** (chrome and cards) — then hairlines decide which contour is which. Only dropdown menus lift off the page. Everything else, the canvas tool row, zoom controls, minimap, side panel and every drawn element (resources, boundaries, tags), is flat linework with a 1px contour. Shadows never mark hierarchy between panels, never scale up on hover as decoration, and are removed entirely in print/PDF (they render as grey boxes) and in removed-state nodes.

### Shadow Vocabulary (if applicable)
- **Floating chrome** (`box-shadow: 0 1px 2px rgb(30 25 10 / 0.06), 0 2px 8px rgb(30 25 10 / 0.05)`): kept as a token, used only inside the menu lift below. Controls and nodes do not take it.
- **Dark paper chrome** (`0 1px 2px rgb(0 0 0 / 0.4), 0 4px 14px rgb(0 0 0 / 0.25)`): the same token re-balanced for dark paper.
- **Menu lift** (`0 12px 32px rgb(0 0 0 / 0.28)`, combined with floating chrome): overlay dropdowns only.
- **State ring** (`0 0 0 2px <accent or status color at 30–55% mix>`, combined with floating chrome): selected / just-changed states; it replaces, not stacks with, other rings.

### Named Rules (optional)
**The Flat-By-Default Rule.** Surfaces are flat at rest. Elevation appears only to mark something floating above the drawing, or responding to state (selection, fresh apply).
**The Hairline Rule.** All structure is drawn with 1px hairlines (`--line` between sections, `--line-2` around drawing elements). A shadow never does a border's job, and no border is thicker than the ink rules of the brief (2px under document h2 and table totals).
**The One Shadow Rule.** Exactly one soft shadow vocabulary exists for floating chrome. If something needs a bigger shadow, it should be a menu (the one sanctioned lift), not a new token.

## Shapes

The form language is drafting-simple: small radii, drawn contours, one crop geography. Radii run on a 3–8px scale — 3px for every drawn diagram element (resource nodes, type codes, IAM/SG strips, finding and change tags, subnets), 4px for VPC and cloud boundaries, 5px for sub-controls, 6px as the default for buttons/inputs/toolbars, 8px for panels and dropdowns, and a true pill (24px+) only for the scroll thumb.

Borders are functional annotations: resource nodes carry one even 1px contour, and their category hue appears only in the type cell at the left — the title block of the part — while virtual/dashed borders consistently mean "not a real resource" (router groups, launched instances, removed or replaced nodes in plan mode). Boundaries (cloud, VPC, subnet) are lines only, never tinted fills; public and private subnets differ by line color and label. Dots, tabs and controls are circles or simple rectangles; there is no asymmetric corner logic and no clipping beyond `overflow: hidden` on the diagram.

### Named Rules (optional)
**The Type-Cell Rule.** Every diagram resource identifies its category by a full-height cell at its left edge, split off by a hairline: a 14% tint of the category hue with the type code (`EC2`, `ALB`) in the hue itself, matching the cost bar and legend dot. The cell is part of the node's own frame. No floating outlined badge in front of the name (the boxed icon tile is the generic generated-UI tell), and no side stripes (a thick colored edge on a rounded card is the generic dashboard tell, and it breaks at the corners).
**The Dashed-Means-Virtual Rule.** A dashed contour always means "not solid": virtual (router) nodes, removed/replaced resources, or a live-attention frame. It never means decorative variety.

## Components

### Resource node (signature)
The one component that defines the system: a flat Tracing Panel outline, 1px Umber contour, 3px radius, no shadow. Inside: the full-height type cell at the left (min 46px wide, 14% category tint, 1px hairline at 40% of the hue, Inter 11px/700 code in the hue, ≥4.5:1 in both themes), an Inter 12px/600 label with mono 10px hint below, and a right-aligned tabular cost figure with no chip behind it. IAM/SG and finding tags sit flat on the bottom edge (3px radius, no shadow). Every node, real or virtual, is drawn at one size (216×64). The type cell is a fixed 52px; codes longer than six characters show a short form there (`DDB`, `SFN`) and lead the hint line in full. States: hover lifts the paper 3% toward ink and moves a solid contour to Pencil Grey (dashed contours keep their hairline color: bright dashes read as noise); selection is a 2px Printing Blue ring; a fresh apply breathes the Apply Green pulse three times; removed lines cross out their label and ghost to 60%.

### Buttons
- **Shape:** rectangle, 6px radius, 1px Umber contour on Tracing Panel.
- **Primary (quiet):** panel paper with Blueprint Ink 12px/500 text; padding `4–5px 9–10px`.
- **Hover / Focus:** hover recolors border and text to Printing Blue (never fills); focus-visible is a 2px Printing Blue outline offset −2px to 2px. Transition 0.15–0.2s ease on color/border/box-shadow only.
- **Ghost/text:** the "linkish" button — no border, Printing Blue text, underlines on hover.

### Chips
- **Status tags** (change/mode/severity): 10px/700 uppercase tag type, 1–2px × 5–6px padding, 3px radius, a 1px outline in the hue with same-hue text on paper. Only High severity is a solid fill (white on Revision Red): the one loud stamp. No tinted pill backgrounds.
- **IAM/SG chips:** 10px/700 colored text with no fill, in one flat 3px-radius strip clipped onto the node's bottom edge; caret opens the attached popover; open/hover contour goes Printing Blue.
- **Toggle chips** (canvas toolbar): flat, 1px Umber contour, 3px radius, no shadow; "on" state takes Printing Blue border + text.

### Cards / Containers
- **Corner Style:** 8px for menus, 6px for HCL blocks and buttons, 3px for the brief sheet, notes and every drawn or floating canvas element, 4px for diagram boundaries.
- **Background:** Tracing Panel. KPI figures are not tiles: each sits under a 1px ink rule, like a dimension on a drawing. Report findings are rows separated by hairlines, never stripe-edged cards.
- **Shadow Strategy:** none, except dropdown menus; side-panel sections are flat and separated by hairlines.
- **Border:** 1px Sand internally, Umber when adjoining the canvas.
- **Internal Padding:** 16px (sections), 12–14px (findings, KPI), 48/56px (brief sheet on screen).

### Inputs / Fields
- **Numeric + slider row:** Warm Paper 6px-inset number field (right-aligned tabular figures) above a hand-drawn 4px slider track — accent fill to `--fill`, Pencil Grey at 30% behind, 14px accent thumb, focus ring in accent.
- **Switch (on/off):** 28×16px track, panel-paper 12px knob, Check Green when checked, 2px accent focus-visible outline.
- **Selects:** custom themed menus (never OS popups): 1px contour, 8px radius, menu-lift shadow, active row at 12% accent mix, mono path captions.
- **Error / Disabled:** errors use Revision Red text + banner tint; disabled sits at ~45% opacity with no styling tricks.

### Navigation
Top bar: Tracing Panel, hairline bottom, 18px gutters; brand at 15px/700 nearly full tracking; state file in mono. Connection health has no status light: when healthy the view picker's `live` says so, and trouble appears as a word (`reconnecting…` in Annotation Ochre, `offline` or `error` in Revision Red) only while it lasts. Side tabs: 12px text, 2px ink underline on the active tab, never a filled block; inspector sub-tabs are quiet 6px-radius chips with Warm Paper fill when active. The same sub-tab chips form the side panel's scope switch, the panel's first row above the tabs (`Whole stack | <resource>`, the resource being the last one selected). Scope and diagram selection move together. Cost, Findings and Usage, and their tab counts, follow the scope; the whole stack adds Changes in a plan or comparison, and one resource adds Details (its configuration, access and Terraform).

### Diagram chrome
Everything drawn in the canvas is an annotation: A **Key** chip on the tool row (6px radius, accent when open) expands an inline panel with the chrome shadow listing the node encodings — type cell, the "~" estimate marker, access chips, dashed-virtual, severity stamp, change pills — each row rendered with the real component classes so the legend can't drift from the nodes. solid Slate edges for real relationships, dashed Pencil-grey "uses" edges, dotted Network-Violet routes, active traced paths in accent with slow dash drift (paused under reduced motion), edge labels as plain mono text on the canvas (no bordered pill), the internet edge as a frameless caps label where its arrow starts, and a dotted background. The view picker's `live` state is plain Check Green text beside the live dot, not an outlined tag. Selection and traces are crisp rings, never glows. Controls and minimap match button/card anatomy.

## Do's and Don'ts

### Do:
- **Do** keep every number in tabular figures, right-aligned where columns meet, with the quantity × price × source one mono line below (`font-size` 10–11px).
- **Do** state the unknown: "not priced" as text in muted ink, never a bold $0.00, never blank.
- **Do** use the category-tinted type cell as the identity kit for any new resource kind before inventing any new color.
- **Do** draw all structure with 1px hairlines; keep shadows to dropdown menus; strip shadows from print output.
- **Do** keep dark mode a re-papering of the same drawing — identical structure, hue, spacing (only papers/shadows vary).
- **Do** respect `prefers-reduced-motion`: pause dash animations and pulses, keep state changes readable through color and shape.

### Don't:
- **Don't** introduce a second accent hue, a gradient fill, a glow, or a glass/blur surface; one blue and paper do the work.
- **Don't** use pure `#fff` or `#000` surfaces or neon-on-black dark mode; every neutral stays warm.
- **Don't** rely on color alone for added/changed/removed or severity — words or border style always accompany it, and comparisons show gaps without red/green verdicts.
- **Don't** scale elevation or motion as decoration; shadows don't grow on hover, and idle screens don't animate.
- **Don't** break the 10–28px type scale or set prose/labels in mono; ad-hoc sizes and "code-chic" text are off-system.
- **Don't** let category hues become surfaces beyond the type cell; they identify (type cell/dot/bar/tag text), they don't fill.

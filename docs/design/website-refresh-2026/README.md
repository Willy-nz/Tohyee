# Website refresh — 22 October 2026

Replaces the document-style landing page with a responsive product overview:

- Green, cream and charcoal palette; quieter navigation and more whitespace.
- A clearly labelled illustrative workspace with a sales trend graph.
- Interactive sales/cost bar charts with fictional values, a common scale,
  keyboard-operable buttons and screen-reader summaries.
- Existing demo screenshots for bank reconciliation and farm maps.
- Dedicated Accounting, CRM, Payroll/Jobs, Tax, Analytics and Farming sections.
- Current-main backup/recovery and farm-calendar updates, distinguished from
  packaged release availability. No claim that open PRs are shipped.
- Explicit IRD import limitations and early-development status.
- Static HTML, local fonts and images; no new external dependencies.

Content baseline: main at 2956743c. Existing screenshots are labelled as demo
screens that can differ by version. The hero is a marketing illustration, not
an exact screenshot or a promised redesign of the application.

## Validation

Passed JavaScript syntax, local asset existence, internal anchor targets,
unique element IDs and git whitespace checks. The two chart series are fixed
fictional examples; totals are $195,000 sales and $139,000 costs.

Browser visual/interaction testing remains required: Playwright is available,
but no browser is installed and Chromium downloads returned invalid archives.
No full application lint/typecheck/test/build run was performed for this
static-site change; the normal CI gates remain required before merge.

Review at desktop, tablet and 390/320px mobile widths; check navigation toggle,
Escape handling, chart switching, keyboard focus, reduced motion, no-JS layout,
image crops, contrast and lack of horizontal overflow.

Serve `website/` with a static HTTP server. Merging this PR triggers the
existing GitHub Pages workflow; this branch itself does not deploy the site.

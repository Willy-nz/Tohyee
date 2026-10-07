# Tohyee UI specification

Version 1 · 7 October 2026

## Purpose and status

Translate the agreed visual direction into an implementation brief for Tohyee's app shell, home screen and shared components. The product should feel calm, warm and precise, with New Zealand character expressed through pounamu green and a restrained mountain watermark.

This is a proposed design specification based on the visible conversation and supplied photo. It is not a fresh audit of the repository. Component names mentioned below come from the earlier review and must be verified against the current checkout before implementation. Financial examples are illustrative, not live data.

The reference home screen has no mascot. An assistant can remain available through an explicit control; character design is a separate future decision.

## Design rules

1. Financial information determines the hierarchy. The main balance is immediately recognisable.
2. Start with flat sections. Add a container when content needs a distinct boundary, background or interaction.
3. Use pounamu for selected navigation and primary actions. Reserve warning and danger colours for actual conditions.
4. Use a serif only for major page headings. Tables, controls and financial amounts remain sans serif.
5. Avoid decorative gradients, pill-shaped navigation and coloured icon tiles.
6. Every dashboard region answers a different question. Do not duplicate the same alert in a second task list.
7. Keep organisation, reporting period and data freshness visible.
8. Preserve accounting logic, permissions and existing destinations while changing presentation.

## Colours

| Token | Value | Use |
|---|---|---|
| Canvas | #F7F6F2 | Warm application background |
| Surface | #FFFFFF | Inputs, menus, contained working panels |
| Subtle surface | #EFEEE8 | Sidebar and subdued section backgrounds |
| Ink | #202E2B | Primary text and financial values |
| Secondary text | #53625C | Labels, explanatory copy and timestamps |
| Quiet text | #66716B | Low-emphasis text; never reduce opacity further |
| Border | #DCDDD5 | Decorative separators |
| Control border | #7C8881 | Input boundaries and interactive outlines |
| Pounamu | #0E7467 | Primary actions and links |
| Pounamu hover | #095D53 | Hover/pressed emphasis |
| Selected surface | #E4EEE8 | Active navigation background |
| Warning | #825500 | Warning text/icons |
| Warning surface | #FFF3D6 | Warning background |
| Danger | #B33832 | Error and overdue text/icons |
| Danger surface | #FBEDEB | Error background |
| Focus | #0E7467 | Keyboard focus ring |

Use white text on pounamu primary buttons. Use ink for text on selected and subtle surfaces. Selected navigation also needs a weight change or leading marker; colour alone does not communicate selection. Light decorative borders must not be the sole cue identifying an input.

For implementation, verify text contrast on actual rendered backgrounds: at least 4.5:1 for ordinary text, 3:1 for large text and meaningful control/graphic boundaries. These are acceptance targets, not a claim that all combinations in this proposal have been audited.

## Typography and spacing

Proposed families: Source Serif 4 for major headings; Inter for the interface. Self-host approved font files if available. Fallbacks: Georgia for headings and system-ui for the interface. Review the rendered result if a fallback is used.

| Role | Size / line height | Weight |
|---|---|---|
| Home greeting / major title | 32 / 40px | Serif 500 |
| Main bank total, wide screen | 48 / 56px | Sans 500 |
| Main bank total, compact screen | 36 / 44px | Sans 500 |
| Supporting metric | 26 / 34px | Sans 600 |
| Section heading | 18 / 26px | Sans 600 |
| Body, navigation and forms | 14 / 22px | Sans 400–500 |
| Table values | 14 / 20px | Sans 400 |
| Metadata | 12 / 18px | Sans 400–500 |

Financial amounts use tabular numerals. Right-align values in tables, consistently format currency and negatives, and keep labels readable instead of making them tiny. Main metrics remain sans serif for clarity.

Spacing scale: 4, 8, 12, 16, 24, 32, 48px. Desktop page padding: 32px. Compact page padding: 24px. Phone padding: 16px. Section separation: 32px. Panel padding: 24px desktop, 16px phone. Default control height: 40px; compact table actions can be 32px where the clickable area remains usable.

Radii: 6px controls, 8px panels, 10px dialogs. Avatars can be circular. Shadows belong to menus and dialogs; dashboard panels rely on spacing and a quiet boundary.

## App shell

Desktop sidebar width: 232px. Background: subtle surface. Separate from content with one border.

Sidebar order:

1. Tohyee wordmark.
2. Organisation switcher directly below it: organisation initials, full name, currency and financial year end. Keep the active name readable and show its full value on expansion if truncated.
3. Primary navigation mapped to existing routes. Proposed groups: Home, Banking, Sales, Purchases, Accounting, Reports. Retain other existing modules within a deliberate secondary group rather than inventing or removing routes.
4. Settings, help and profile near the bottom.

Navigation rows: 40px tall, 16px horizontal padding, 18px consistent outline icons. Active row: selected surface, pounamu text, medium weight and a short leading marker.

The content utility row contains search, one primary Create action and compact notification/profile controls as required by current behaviour. Avoid duplicating the profile control in both sidebar and utility row. Use a search field around 280px wide on desktop, shrinking to an explicit search button on phone.

Organisation switching must clear the previous entity's visible financial data before loading the next. Charts, metrics, alerts and links must all use the same active organisation. Label any unsaved-work prompt with the organisation concerned.

## Home screen composition

The reading order is: organisation context and greeting → financial position → cash movement → required actions → recent activity → bank health.

### Header

“Good evening, William” uses the display heading. A second line shows the organisation and financial year, for example “Glimmers Ltd · Financial year ending 31 March 2027”. Time-based wording follows the user's local time; it must not be hard-coded.

The financial summary and chart each show their relevant as-at date or reporting range. Do not imply every panel has the same refresh timestamp if its source differs.

### Mountain treatment

Use the supplied photo as the visual source. Crop around the central mountain and adjoining ridge, with only a thin suggestion of the lake. Exclude the foreground road, trees and most empty sky. Do not substitute invented mountain artwork.

The implementation treatment is monochrome, initially 5% opacity, with a soft fade into the canvas on the left and bottom. Place it only on the right of the greeting region, approximately 520px wide and 150px high at desktop size. Keep greeting text over a solid canvas area and utility controls on an opaque surface.

Treat the asset as decorative: no pointer interaction and no screen-reader announcement. It must not extend behind tables, chart axes or financial metrics. On screens below 768px, omit it. Never darken the image merely because a crop makes it difficult to see.

The photo is available for reference; no edited watermark asset is included in this specification.

### Financial strip

Use one open section with a bottom divider. Avoid four identical metric cards.

| Metric | Presentation | Required meaning |
|---|---|---|
| Cash in bank | Largest value | Sum of included bank account ledger balances at the stated date; expose included accounts |
| Owed to you | Supporting value | Outstanding customer invoices at the stated date; show overdue amount separately |
| Bills to pay | Supporting value | Outstanding supplier bills at the stated date; indicate those due soon |
| GST position | Supporting value | Estimated payable or refundable amount for an explicitly named period and configured basis |

Use existing verified calculations. If these definitions differ from current product behaviour, resolve that before applying the labels. Do not silently change financial calculations during a visual redesign.

GST needs a visible “Estimate” qualifier and text distinguishing payable from refundable. A negative number alone is insufficient. Multi-currency totals require the reporting currency and conversion basis; never simply add unlike currencies.

Every metric links to its supporting detail where available. Missing data is “Unavailable”, not zero. A loading skeleton must not expose values from the previous organisation.

### Main working region

At wide sizes use a 2fr / 1fr grid with a 24px gap. The left contains Cash flow; the right contains Needs attention. Both are restrained white panels with little or no shadow.

Cash flow:

- Default range: six complete months, visibly labelled; the product can retain a different established default if intentional.
- Grouped bars show Money in and Money out. A Net cash flow line may share the same currency axis; include a zero baseline and allow negative net values.
- A separate “Cash flow / Cash balance” control switches the view. Cash balance replaces the flow series; never overlay cumulative balances on an unrelated scale.
- All series use actual cash movements, not accrual income/expense figures presented as cash.
- Money in uses pounamu; Money out uses neutral grey with an outline or pattern; net uses dark ink. Legends and tooltips identify series in words.
- Tooltip includes month, values and currency. Provide an accessible table of the same values.
- Distinguish missing months from confirmed zero activity.

Needs attention:

- System-generated accounting actions only, ordered by urgency and relevance.
- Each row states the issue, count or amount, due date when relevant, and one clear action.
- Examples: overdue invoices, unreconciled transactions, a configured GST due date, bills due soon and a disconnected feed.
- Do not duplicate these rows in a “To do” panel. User-created tasks can retain their existing destination elsewhere.
- Use plain language and exact dates. Deadline examples are not hard-coded tax rules.
- Show up to five rows, then “View all”. An empty state says “You're up to date”.

### Lower working region

Recent activity uses a flat ledger-style list on the wide side. Each row has event, reference/entity, timestamp, and amount where meaningful. Maintain clear row boundaries and align amounts.

Bank accounts occupies the narrow side, with account name, masked identifier, ledger balance, feed status, last successful update and reconciliation count. Show the source of each balance. If a bank-feed balance differs from the ledger balance, label both explicitly.

Feed states use text and icon together: Connected, Updating, Needs reconnecting, Manual import. A failed feed is not evidence that the balance is zero.

## Shared components

| Component | Rules |
|---|---|
| Page / PageHeader | Common content width, spacing and heading hierarchy; optional decorative header |
| Card | Quiet container, 8px radius, no default shadow; also support uncontained sections |
| Button | Pounamu primary; outlined secondary; text tertiary; destructive action clearly labelled |
| Badge | Compact status only, with text; no decorative badges on every metric |
| Stat | Label, amount, qualifier and optional detail link; explicit loading/error/empty states |
| Table | 44px default rows, readable header, right-aligned amounts, clear sorting controls |
| Input | Visible label, 40px height, clear boundary, inline error tied to field |
| Tabs | Text with underline selection; preserve keyboard operation |
| Dialog | One clear title, grouped fields, explicit actions; restore focus on close |

Existing primitives should carry this system so screens inherit it. Use scoped variants where necessary; a blanket change to every white rectangle risks making complex forms harder to understand.

Keyboard focus: visible 2px pounamu outline with 2px offset, adapted on dark or selected surfaces. Hover must not be the only way to discover actions. Honour reduced-motion preferences. Use short 120–160ms transitions for interface feedback.

## Responsive rules

Breakpoints refer to the viewport in CSS pixels, not physical laptop size.

| Viewport | Shell | Home layout |
|---|---|---|
| ≥1440px | 232px sidebar; 32px page padding | 2:1 working grid; financial strip in one row |
| 1200–1439px | 232px sidebar; 24px padding | Same grid if chart stays ≥560px and actions ≥280px; otherwise stack |
| 768–1199px | Sidebar becomes an accessible drawer; full organisation name stays in header | Full-width chart; then attention; then activity and banks; metrics 2×2 |
| <768px | Menu button and organisation control; 16px padding | All working regions stack; main total first; supporting metrics in compact rows; no watermark |

Content maximum width: 1440px, centred inside the workspace. At browser zoom or unusually long labels, switch layout based on available space rather than forcing the nominal grid.

On phone, use labelled activity rows rather than a compressed desktop table. Dense accounting tables may retain horizontal scrolling in their dedicated screens, with essential identifiers visible and an obvious scroll affordance.

## States and verification

Before treating the reference implementation as complete, verify:

- At 1440, 1280, 1024, 768 and 390px, no controls overlap and labels remain readable.
- At 200% zoom, navigation, organisation context and primary actions remain usable.
- Text and chart contrast is tested against actual backgrounds, including the watermark treatment.
- Keyboard users can switch organisation, navigate, change chart view and open supporting detail; focus remains visible.
- Long organisation names, large amounts, negative balances, no transactions, partial data, slow loading and disconnected feeds remain clear.
- Entity switching never briefly displays another client's amounts.
- Dashboard figures reconcile to their linked detail views for the same organisation, date, currency and basis.
- Chart toggles retain the selected period and never mix balance and flow measures.
- System alerts appear once; bank status is consistent with the corresponding banking screen.

Preserve an existing accessible dark theme during rollout. Before applying the full redesign in dark mode, define and validate separate colour tokens; do not invert the warm palette or photo automatically.

## Implementation sequence

1. Inspect current routes, design tokens, shared primitives and dashboard data sources in the current repository.
2. Introduce theme tokens and typography; keep changes easy to review.
3. Implement the sidebar and utility row using existing navigation and organisation-switching behaviour.
4. Build the home screen against the actual data, keeping metric definitions explicit.
5. Add the decorative mountain asset treatment and check readability.
6. Apply the reusable table, form and navigation rules to representative dense screens.
7. Run relevant existing checks and the visual, keyboard and accounting verification above.

Use a dedicated branch when implementation begins. The present deliverable defines the direction; it does not modify, push or deploy the application.

## Brief for future coding work

“Follow Tohyee-UI-Spec.md. Use the existing application architecture and accounting calculations. Build a warm off-white interface with pounamu actions, strong financial hierarchy and a restrained sidebar. Use serif only for major headings. Avoid unnecessary cards, decorative gradients and duplicated dashboard alerts. Keep the active organisation obvious. Use the supplied mountain photo only as a pale monochrome header watermark. Do not add a dashboard mascot. Reuse shared components and verify responsive, keyboard and financial behaviour before expanding the redesign.”

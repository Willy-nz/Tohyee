# Tohyee usability and visual review — 19 October 2026

Review baseline: main `e7e775a36251cb56c0c52d86bc4176fb73dc1483`.

## Assessment

Tohyee has a coherent visual foundation: blue/slate colours, serif page headings, restrained cards, dense financial tables and mobile adaptations. Keep that identity. A good contemporary accounting product should prioritise clear actions, dependable state feedback, accessible keyboard use and visibility of the evidence behind automated suggestions. A decorative redesign alone would not address the most important issues below.

This is a source review of representative workflows, supplemented by existing repository screenshots. It is not a signed-in production usability test, complete accessibility audit, or certification of every module. Older screenshots use a superseded green palette; findings were checked against current source. Current home already has a needs-attention area, month calendar already switches to agenda on phones, and current date input already uses NZ date entry. Do not reimplement those as missing features.

## What happened (added when merged)

Built in #325 and released in 0.10.0. Findings 1, 2, 4 and 5 were done as
written: calendar loading and failure states with Retry, view buttons with
`aria-pressed`, the month as a table, focus moved to the detail and back,
details beside the schedule from 1024px wide with Back on phones, "Sender",
mailbox settings behind a button, and the cash forecast led by its summary
with a balance chart and collapsible assumptions. Two parts differ:

- Finding 3: the button that opens a line now says "Review", but applying a
  match still says "OK", as Xero does (decision 537).
- Finding 6: the picker button stays out of the tab order; Alt+Down opens
  the picker from the date field instead, and an invalid date shows a
  visible error after leaving the field.

## Mockups

Keep `mockups.html` and `mountain-photo.png` together and open the HTML locally in a browser. The top navigation switches between three proposals; calendar events and its review filter demonstrate selection. All values, names and excerpts are fictional. Other buttons explain the intended action and do not perform it.

1. **Farm calendar:** schedule and selected evidence side by side on desktop; stacked reading order on narrow screens. Distinguish checked facts, extracted suggestions and missing times. Keep mailbox configuration out of the daily workflow. Production mobile detail should use an accessible sheet or dedicated detail screen with Back and restored focus; the static prototype only scrolls to the detail section.
2. **Reconciliation:** use “Review” for opening details and “Confirm match” for the mutation, with one clear primary action and a visible explanation of its effect. Keep batch review available.
3. **Cash forecast:** lead with the cash question, shortfall and balance trajectory, with existing assumptions and full detail available. The illustrative chart is not a new calculation engine. Preserve current report exports, transaction drill-through, account selection and double-counting warnings.

The mockups now use the owner’s replacement mountain/lake photo, supplied 19 October 2026, as a subtle desktop header watermark. The original is preserved in `mountain-photo.png`; CSS frames the mountains and lake above the car/foreground. Text has a solid background, controls stay opaque, and the decorative image is hidden below 1100px. Claude: use this source for the app’s next watermark update, preserve the existing light/dark readability protections, and verify the crop at actual header sizes. This PR updates design assets only; it does not replace the deployed app image. Preserve existing organisation navigation and permission behaviour. The mockup's three-button navigation is only a screen selector.

## Findings and acceptance criteria for Claude

### 1. P1 — Calendar request failure can appear as no work remaining

**Confirmed source issue.** In `src/components/farm-calendar.tsx`, `toCheck` is a separate request, but only `calendar.error` is rendered. `CheckList` receives an empty array after failed initial loading and can say “Nothing to check”. `MonthGrid` receives no loading state, and its mobile `Agenda` hardcodes `loading={false}`.

Acceptance: show the active request's error with Retry; never show a success empty state on failure; distinguish initial loading, refreshing, loaded-empty and failed states in every view, including month on phones. If retained data is displayed after refresh failure, visibly mark it as not refreshed. Test failed check request while ordinary calendar request succeeds; slow/failed month loads; retry recovery; genuine empty success.

### 2. P2 — Calendar ARIA and detail focus need completion

**Confirmed source structure; assistive-technology impact requires browser verification.** Month `role=grid` directly contains `columnheader` and `gridcell` elements without row containers. Calendar tabs have `role=tab` but lack the associated tab panels and expected keyboard interaction. Selecting an event scrolls to the detail panel but does not move focus; closing does not explicitly restore it.

Acceptance: choose a complete grid keyboard pattern or simpler suitable native semantics; use proper row ownership if retaining grid. Implement the WAI-ARIA tabs pattern or ordinary view-selection buttons with accurate semantics. Establish predictable detail focus and return focus to the selected event. Validate keyboard-only navigation, a screen reader, 200% zoom, reduced motion and small screens. Preserve the already-existing mobile agenda.

### 3. P2 — Bank actions do not clearly separate review from confirmation

**Confirmed labels; usability recommendation.** `src/components/bank/confident.tsx` uses “OK” to apply a suggestion and “OK all … confident matches” for a batch. `src/components/bank/reconcile-panel.tsx` uses the primary label “Reconcile” merely to open the editing area. Thus a row may present two primary-looking controls with different effects.

Acceptance: opening details says “Review”; applying a suggestion says “Confirm match” or another explicit accounting action. Provide one primary committing action per active review surface; show matched record, amount and effect before commitment. Batch review keeps line-level outcomes and failures. Preserve current matching logic, duplicate protection, role checks and confirmation behaviour. Test mouse and keyboard flows, no-match and changed-match states. The split-pane mockup is a proposal, not a requirement to rewrite all reconciliation logic.

### 4. P2 — Calendar selection removes schedule context

**Design recommendation from current layout.** `ItemPanel` is rendered after the entire agenda/month and scrolls into view. The owner must move between a long schedule, detail form and mailbox settings. “From” means email sender, not worker assignment.

Acceptance: desktop selection keeps the relevant schedule visible alongside details; mobile has accessible details and a clear return path; preserve selection/scroll across updates when the selected record still exists. Label the filter “Sender”. Keep source excerpt and uncertainty next to the date/time. Put connection configuration behind an explicit settings entry while keeping real connection failures visible. Never infer that a sender is the person assigned to the job. Email-derived details remain owner-private by default; any future sharing must be an explicit separate action with a preview of exactly what is shared, not inherited from a farm staff view.

### 5. P2 — Cash forecast makes the user read before seeing the risk

**Design recommendation confirmed against `src/components/cash-flow.tsx`.** The component repeats the report title in its Card and ReportActions and gives detailed explanation, account selection, summary values and a full table before the assumptions sections. It has useful lowest-balance and shortfall information already; retain those. There is no trajectory chart in the current component.

Acceptance: one clear screen title, concise scope summary, current/lowest/end values and shortfall warning before detailed controls. Add an accessible balance chart backed by the same forecast response as the full table; show negative values and excluded data honestly. Keep the full table, drill-through and exports available. Move advanced assumptions into a clearly labelled collapsible area or panel; preserve accounting warnings. Verify on narrow screens, with long account names and negative/zero balances. User research should establish whether the chart actually helps make a funding decision.

### 6. P3 — Shared date picker discoverability

**Confirmed implementation; improvement, not a blanket WCAG failure.** `src/components/date-input.tsx` sets the picker button and native input to `tabIndex={-1}`; text entry is keyboard accessible, but keyboard users cannot reach the picker button. Invalid entry uses validity state without its own visible inline explanation.

Acceptance: either offer an accessible keyboard-operable calendar trigger or clearly document the text-entry alternative without misleading affordances. Show a visible associated date error when invalid input is committed; preserve dd/mm/yyyy and existing shorthand support. Test Enter, Escape, invalid dates, blur and date selection. Do not replace this component with US-format date fields.

## Review gates for implementation

- Use the existing design tokens and shared components; keep compact financial density where it supports work.
- Evaluate 390px, 768px and 1440px layouts, light/dark themes, long real-world labels and 200% zoom. Prevent page-wide horizontal overflow; allow intentional table scrolling with a visible affordance.
- Check normal text contrast at 4.5:1; WCAG 2.2 AA target sizing is 24 CSS pixels or a qualifying exception, not a universal 44px rule. Prefer larger controls for primary phone actions.
- Test keyboard focus, visible errors, pending actions, empty success, failure/retry and stale data. Avoid presenting extracted suggestions as confirmed facts.
- Follow repository test-first requirements for production changes. This handoff modifies no production code or accounting behaviour.

References: [WCAG contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [focus not obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html), [ARIA tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/), [ARIA grid](https://www.w3.org/WAI/ARIA/apg/patterns/grid/).

## Validation of this handoff

Source findings were inspected at the baseline above. The HTML uses one adjacent local photo, with no external dependencies or live data calls. Its script was syntax-checked. Browser installation failed in the review environment, so the mockups have not been rendered or interaction-tested here; Claude should render and inspect them before implementation. No production test suite was run for this documentation-only change. No claim is made that the redesign is already implemented or that Claude has reviewed it.

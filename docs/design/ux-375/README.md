# Workspaces and alignment: issue #375

Owner feedback on screenshots (20 October 2026): crowded menus, a Home that
read like a printed statement, one long Income tax page, and controls that
didn't line up. Draft PR #381 (Codex) started this; the review on 21-22
October 2026 changed it as below. Decisions 700-705 in `docs/DECISIONS.md`.

## What changed

- **Menus** (decision 700): the Accountant menu is now three dropdowns,
  Accounting, Tax and Settings. Every link keeps its address, role and module;
  decision 580's settings shortcuts and All settings page stay. The draft's
  landing pages (`/operations/accounting-tools`, `/operations/tax-workspace`)
  were dropped because they made everything two clicks away. The ☰ menu now
  takes over from 1,240px wide (was 1,180px), and the bar tightens from
  1,320px, so the longer bar still fits with Farm on.
- **Home** (decisions 701 and 703): no mountain photo (Jess, 21 October 2026),
  a sans-serif title, bordered summary cards, and Needs attention before the
  profit chart.
- **Income tax** (decision 702): Overview, Forecast, Tax calculation, Payments,
  Returns and Tax settings, each its own address with the income year kept.
  The figures come from the same calculation as before; "Forecast incomplete"
  shows only when the year has no inputs at all.
- **Rows of fields** (decision 704): controls line up whatever help or error
  text sits under them.
- **Farm calendar** (decision 705): mailbox setup behind Manage mailboxes, a
  one-line Connect a mailbox prompt, Email provider and Email sender labels,
  Add an item on an empty week, and the redirect addresses under Settings ›
  Email.

## How it was checked

Screenshots in `screenshots/` (`before-*` is main at 4756609d, `after-*` is
this branch), taken with Playwright's Chromium against copies of the demo
databases, from `next dev` (the machine didn't have the memory for production
builds of both). Widths 1440, 1250, 1200, 1024 and 390px; "zoom200" is a
1440px window at 200% (a 720px-wide viewport at twice the pixel density);
light and dark. No page scrolled sideways at any of them.

Checked in the browser:

- Populated (Kererū Joinery, Kōwhai Dairies), empty (Kererū's 2025 income
  year: "Forecast incomplete"), a worked-out zero (Kōwhai's 2027 year, a loss:
  0.00 tax, not "incomplete"), unsupported (Pasture demo has no taxpayer type)
  and a server error (the API answered 500 on purpose).
- Back between Overview, Payments and Returns returns to the right page with
  the year kept and the right link marked current; changing the year and
  pressing Back restores the year.
- Keyboard: Tab along the workspace's links and Enter opens one; a top-bar
  dropdown opens with Enter, closes with Escape with focus back on its button,
  and Tab moves into its first link.
- Farm calendar: with a mailbox, without one (the mailbox moved to another
  person in the copy only), the connect form with a deliberately long label
  and its help text, the connect error when no Google app is set up, and the
  folder picker opening. Choosing real folders needs a real Google or
  Microsoft mailbox, so the folder list itself wasn't seen.

Not checked: a screen reader, and real mailbox folders. A label long enough
to wrap still pushes its own control down (decision 704).

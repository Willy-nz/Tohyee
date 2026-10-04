# UI review 2026 proposal

This PR is a review and proposal only. It does not change app code.

> **Revised by Claude (4 Oct 2026) after Jess's review.** Dashboards go on the
> main pages only, and each can be hidden. The top bar is simplified. Two tile
> figures are corrected: Cash in bank no longer includes credit cards, and
> Purchases this month is replaced by Bills this month. The mockups were redone
> without slogans, repeated numbers or placeholder charts. The build order
> changed. Copilot's original findings below are kept.

## What I reviewed

I ran Tohyee locally, made a demo organisation with sales, bills, bank lines, payroll, contacts, CRM data and an Analytics dashboard, then captured light and dark screenshots in `docs/ui-review/before/` for:

- Home (`/operations`)
- Sales invoices, bills and a draft invoice editor
- Contacts and an opened contact workflow
- Banking and reconciliation
- Payroll pay runs
- Reports, GST return and Settings
- CRM home and Analytics home

## What makes the product still feel dated

Across the product the same patterns keep making Tohyee feel older than it is:

- **Too much page furniture before the work starts.** Long helper paragraphs sit above tables and forms that people already understand after the first use.
- **Pages do more than one job at once.** List, setup, edit and help often share the same canvas.
- **Almost no default summaries.** Most pages open straight into a full table or form instead of a quick “what matters today” strip.
- **Wide tables are carrying too much meaning.** Status, due state, totals and next action all live in columns, so scanning is slow.
- **Important actions are spread out.** Some pages use tabs, some row buttons, some inline forms, and some links in helper text.
- **Depth is exposed too early.** Advanced detail that suits a drawer, side panel or “More” menu is visible all the time.
- **The visual rhythm is flat.** Many pages are one large card plus a dense table, which makes every row feel equally important.

The right direction is not “fewer features”. It is **clearer layers**:

1. a short page header,
2. a default dashboard strip,
3. the main task for the page,
4. deeper tools in drawers, tabs or “More”.

## The top bar

Today the top bar has three app buttons (Accounting, CRM, Analytics), eight
menus (Home, Sales, Purchases, Payroll, Reporting, Accounting, Tax, Contacts),
New, Search and AI. A server warning can also fill the top of every page.
That's a big part of "too many things in one place".

- **Apps:** one grid button opens Accounting, CRM and Analytics, the way
  Google and Microsoft do it.
- **Menus:** Home, Sales, Purchases, Banking, Payroll, Reports, Accountant.
  - Banking gets its own menu, since it's daily work.
  - Contacts appear under Sales (customers) and Purchases (suppliers).
  - Accounting and Tax become **Accountant**: chart of accounts, journals, GST,
    period close, fixed assets and so on.
  - Payroll shows only when it's switched on.
- **Notices:** server warnings (such as "save the backup key") and things like
  a bank feed that needs reconnecting move into a bell with a dot, instead of
  a banner on every page. A warning that stops work, such as no backups at all,
  still shows as a banner.
- Search and New stay. Search becomes the quick way to jump anywhere (Ctrl K).

## Search everything

Today Ctrl K only finds pages and actions from the menus; it doesn't look
inside the books. Jess (4 Oct 2026): it should search everything, as an
option on the same search bar.

- **One box, two kinds of result.** Typing shows **Records** first (contacts,
  invoices, bills, credit notes, quotes and orders, payments, journals, items,
  accounts, bank lines, fixed assets, and with the CRM on, companies, people
  and opportunities), then **Go to** (pages, settings and actions, as now).
- **Narrow it with chips:** All · Contacts · Sales · Purchases · Banking ·
  Accounts · CRM. A short word does the same: "inv 107", "bill kauri",
  "c: kobe".
- **Search by what people remember:** name, number, reference, email, phone,
  the amount ("1748" or "1,748.00" finds documents with that total), and a
  date ("4 Oct").
- **Each result says what it is:** for example "Invoice INV-0107 · Kobe Ltd ·
  1,748.00 · Overdue". Enter opens it; arrow keys move between results.
- **When the box is empty,** it shows the records you opened recently.
- **Only what you're allowed to see.** It searches the organisation you're in
  and follows your access. Employees and pay are only for people with payroll
  access. Report viewers search only the dashboards shared with them.
- **Speed.** At most five results per kind, answered as you type (after a
  short pause), from indexed name, number and reference columns.
  "See all 23 invoices" opens the invoices list already filtered.

This goes in build step 1 with the top bar.

## Where dashboards go

Only the **main pages** get a dashboard:

| Page | Dashboard |
| --- | --- |
| Home | Yes: four tiles and a monthly profit chart |
| Sales › Invoices | Yes: four tiles |
| Purchases › Bills | Yes: four tiles |
| Banking (the accounts list) | Yes: four tiles |
| CRM home | Yes: four tiles |
| Analytics | It is the dashboards |
| Editors (invoices, bills, journals and so on), contacts, a contact, reconciling, payroll, reports, GST return, settings | No. These pages are for one job; their own totals stay where they are. |

Every dashboard follows the same rules:

- **One row of up to four tiles.** Each tile opens the report its number comes
  from. Home also has one chart card under its tiles.
- **Hide.** A Hide button folds the dashboard into a one-line "Dashboard
  hidden on this page · Show dashboard". This is remembered per person and per
  page, saved with their login so it follows them to other computers.
- **Customise.** You can swap a default tile for another default tile, or pin
  a tile from one of your Analytics dashboards. Pinned tiles have a dashed
  edge and say which dashboard they come from.
- **Speed.** Tiles load after the page, so the list or editor is never held up
  waiting for a figure.

## Findings and proposal by page

### Home (`/operations`)

**What feels dated or crowded now**

- The page opens with reminders, a bank-account section, three due/GST tiles, four financial-year stats and an eight-row journals table.
- Each bank account becomes its own full tile, so the page grows vertically as soon as an organisation has more than a few accounts.
- “This financial year” and “Latest journals” are useful, but they sit at the same visual weight as urgent work.
- The page is informative, but it is not a dashboard in the modern sense; it reads more like a summary report.

**2026 proposal**

- The dashboard has four tiles: Cash in bank (bank accounts only), Money owed to you, Bills to pay and Next GST return.
- Under the tiles, two cards side by side:
  - **Net profit by month**, a real column chart for this financial year that matches the profit and loss;
  - **To do**, which takes the place of the reminders: filings due, accounts to reconcile, feeds to reconnect and drafts to approve, each with its own button.
- **Recent activity** is three or four plain-English lines, with All journals for the rest.
- No separate list of bank accounts; that's what Banking is for.
- Shortcuts don't repeat the tiles' numbers.

### Sales invoices list (`/operations/invoices`)

**What feels dated or crowded now**

- One card contains a long explainer, five tabs, one primary action and a table.
- The base table has **10 columns** in advanced mode: Number, Customer, Date, Due, Reference, Salesperson, Status, Payment, Total and Amount due, before any custom fields.
- Status and payment state both compete for attention in separate columns.
- “Reference” is always visible even though it is often blank or secondary.

**2026 proposal**

- Add a **four-tile dashboard** above the list: Awaiting payment, Overdue, Sales this month, and a spare tile (for example one pinned from Analytics).
- Replace the five full tabs with a compact segmented filter: All, Drafts, Awaiting, Overdue, More.
- Keep the list to the columns people scan first: Customer, invoice/date pair, due state, total, amount due, status.
- Move Reference, Salesperson and custom fields into a row expander or column picker.
- Keep “New invoice” visible; move secondary list actions into a “More” menu.
- On phone width, switch to stacked list cards with due state and amount due pinned at top right.

### Purchases / bills list (`/operations/bills`)

**What feels dated or crowded now**

- It mirrors Sales, which is consistent, but it repeats the same density problems.
- The base table has **8 columns** before custom fields.
- Supplier invoice number, status, payment state, total and amount due all compete in one line.

**2026 proposal**

- Mirror the Sales layout so the two areas feel like one system.
- Add a four-tile dashboard: Bills to pay, Overdue, Bills this month and Suppliers overdue.
- Keep the list focused on Supplier, bill/date pair, due state, total, amount due and status.
- Hide custom fields and less-used metadata behind row expansion, not full-width columns.

### Invoice editor (`/operations/invoices/[invoiceId]/edit`)

**What feels dated or crowded now**

- The top form shows **7 core fields** before custom fields and line items: Customer, Invoice date, Due date, Salesperson, Reference, Amounts are and Exchange rate.
- The line table is very wide: Description, Quantity, Unit price, Account, Tax code, GST, Amount and remove.
- Tracking and line custom fields live inside the Account column, which is powerful but visually heavy.
- Important context (“drafts post nothing”) sits in helper text at the bottom instead of in the action area.

**2026 proposal**

- Split the editor into **two clear panels**: document details on the left, totals/action rail on the right.
- Keep only Customer, dates and amount mode open by default; move Salesperson, Reference, exchange rate and custom document fields into a “More details” drawer.
- Turn each line into a calmer editable row with progressive reveal: show Description, Qty, Price and Amount first; open tax, account, tracking and custom line fields inline when expanded.
- Keep totals and draft status sticky on desktop so the effect of edits stays visible.
- Put Save draft, Approve and More actions together in one footer bar.

### Contacts list (`/operations/contacts`)

**What feels dated or crowded now**

- The page mixes search, archive filtering, create, edit, notes/files and people management in one place.
- The list has **6 base columns** plus custom fields and an action column.
- Each row can show postal address, parent contact and primary person inside the first cell, which makes the rows uneven and hard to scan.
- The action area can contain Statement, People, Notes & files, Edit and Archive.

**2026 proposal**

- Make Contacts a true split view: list on the left, selected company summary on the right.
- No dashboard on Contacts. Balances owed show in each row instead.
- Keep the table/list to Name, type tags, primary contact detail and balance/risk state.
- Move row actions into a single “Open” button plus a More menu.
- Show notes, files, people and recent activity in the right-hand detail panel, not as separate page fragments below the list.

### Contact detail workflow

**What feels dated or crowded now**

- There is no dedicated contact page; opening a contact starts an inline edit card or panel inside the list page.
- That keeps routing simple, but it makes the page feel like a form-driven admin tool, not a modern workspace.

**2026 proposal**

- Keep the same data and permissions, but present contact detail as a stable side panel or dedicated detail route.
- The first view should be a **contact dashboard**: open invoices, open bills, people, open CRM work and latest notes/files.
- Editing should happen from a clear “Edit contact” action, not by replacing the top of the list page.

### Banking (`/operations/bank-accounts`)

**What feels dated or crowded now**

- The page mixes account summary, account creation and Akahu feed setup.
- The accounts table has **7 columns** and tries to show both financial state and setup state in one place.
- “Add account” opens inline above the table, pushing the page down.

**2026 proposal**

- Add a four-tile dashboard: Cash in bank, Credit cards owed, Lines to reconcile, and Accounts with a difference. Feeds that need attention go in the notices bell.
- Keep the accounts list focused on Account, statement vs books, unreconciled count and last import/feed state.
- Open “Add account” in a drawer, not inline.
- Move Akahu setup into its own secondary section with less prominence unless feeds are disconnected.

### Reconciliation (`/operations/bank-accounts/[accountId]`)

**What feels dated or crowded now**

- The page opens with four stats, optional warnings, then a five-tab card: Reconcile, Statement lines, Import a statement, Bank feed and Bank transactions.
- Reconciliation, import and feed setup all sit at the same level.
- The summary is useful, but the page still feels like a stack of technical tools rather than one focused task.

**2026 proposal**

- Make **Reconcile** the clear default workspace. This page doesn't get a dashboard; its four facts (statement balance, books balance, difference, lines left) stay as a compact summary line.
- Move Import and Bank feed behind a single “More” menu or utility drawer.
- Keep Statement lines and Transactions as secondary tabs under the reconcile canvas.
- Use a sticky “difference” chip so someone always knows whether they are done.

### Payroll (`/operations/payroll/pay-runs`)

**What feels dated or crowded now**

- The page starts with a full “Start a pay run” form, then a “Pay runs” table.
- The create form has 3 fields and a primary button, but it dominates the page even when the regular task is checking existing runs.
- The runs table has 6 columns and no dashboard context.

**2026 proposal**

- No dashboard on Payroll. Instead, a one-line "Next pay run: 14 Oct · PAYE due 20 Oct" sits above the list. Payday filing due shows in Home's To do.
- Turn “Start a pay run” into a modal or drawer launched from a primary button.
- Keep the main list focused on run, pay date, employees, gross/net and status.
- Keep filing and payment tasks visible as follow-up badges after approval.

### Reports (`/operations/reports`)

**What feels dated or crowded now**

- The page has **two tab bars**: one for Home/Custom/Drafts/Published/Archived, then one for the standard reports.
- Standard reports expose 11 report tabs at once.
- It feels like a filing cabinet rather than a modern reports home.

**2026 proposal**

- Make the first screen a report dashboard and report launcher.
- No dashboard on Reports. Each report already shows its own figures, and Home covers the headline numbers.
- Group the standard reports into clusters: Financial, Working capital, Banking, Sales, Custom.
- Open report filters in a side panel so the report body gets more room.
- Surface recently used and pinned reports before the full catalogue.

### GST return (`/operations/gst-return`)

**What feels dated or crowded now**

- The report is accurate and detailed, but the first impression is still a dense report table.
- Boxes, basis explanation, drill-down and filing history all compete on one page.

**2026 proposal**

- No dashboard. Instead, a one-line summary sits at the top: period, basis, Box 15 and filing status.
- Put the box table first, then keep line drill-down in a side pane or lower split.
- Move explanatory copy into collapsible help.
- Keep the audit path intact; just improve the order and hierarchy.

### Settings (`/operations/settings`)

**What feels dated or crowded now**

- Settings contains one large Organisation form, Period locks, Logo and Modules in the same flow.
- The organisation form has **9 main fields/controls**, plus two long checkbox explanations and three subheadings.
- The page feels like an old admin form because everything is fully open.

**2026 proposal**

- Split the page into Settings categories: Organisation, Tax and documents, Inventory, Modules, Branding.
- Keep only the most-used settings visible first.
- Move advanced or infrequently changed controls into accordions.
- Keep Period locks and Modules as their own cards with stronger summaries.

### CRM home (`/crm`)

**What feels dated or crowded now**

- It already has three cards, which is a good start, but it still looks like tables on a page, not a dashboard product.
- “My open opportunities”, “My tasks due” and “Recent activities” are all the same visual weight.

**2026 proposal**

- Keep the same three concepts, with a four-tile dashboard on top: Open pipeline (by currency), Open opportunities, Tasks due and Closing this month.
- Show one compact list per card and push the rest to the linked pages.
- Use stronger status chips and a clear empty state that suggests the next action.

### Analytics home (`/analytics`)

**What feels dated or crowded now**

- It is mostly a dashboard directory with a create box at the top.
- It is useful, but it does not yet feel tied into the rest of the product.

**2026 proposal**

- Keep Analytics as the power-user builder.
- Make the home screen emphasise **shared dashboards**, recently viewed dashboards and “pin to page” actions.
- Keep dashboard creation, but move the blank input + button into a lighter toolbar.
- Use Analytics as the source of optional, role-safe pinned tiles across Operations and CRM.

## Default dashboard tiles

Every default tile below uses data Tohyee already has. No new accounting logic is needed.

| Page | Tile | Exact figure or chart | Source function or table | Matching report |
| --- | --- | --- | --- | --- |
| Home | Cash in bank | Sum of the ledger balances of active **bank** accounts in base currency. Credit cards aren't included; they show on Banking as "Credit cards owed". | `getHomeSummary()` bank accounts in `src/lib/reports/home.ts`, filtered to account type bank | Balance sheet bank lines |
| Home | Money owed to you | `owedToYou.total`, with the overdue part as the note | `getHomeSummary()` | Aged receivables total |
| Home | Bills to pay | `billsToPay.total`, with how many are due this week as the note | `getHomeSummary()` | Aged payables total |
| Home | Next GST return | `nextGstReturn.box15`, to pay or refund, with the period end as the note | `getHomeSummary()` → `calculateGstReturn()` | GST return Box 15 |
| Home (chart) | Net profit by month | Net profit for each month of this financial year so far | `profitAndLoss()` in `src/lib/reports/financial.ts`, one column per month | Profit and loss, monthly columns |
| Sales | Awaiting payment | Aged receivables total today, with the invoice count as the note | `agedReceivables()` | Aged receivables |
| Sales | Overdue | Aged receivables overdue buckets today, with the number of customers as the note | `agedReceivables()` | Aged receivables |
| Sales | Sales this month | Net sales excluding GST for this calendar month | `salesBySalesperson()` total `netSales` | Sales by salesperson (total) |
| Sales | Customers overdue | Count of customers with an overdue balance (can be swapped for a pinned Analytics tile) | `agedReceivables()` rows | Aged receivables |
| Purchases | Bills to pay | Aged payables total today | `agedPayables()` | Aged payables |
| Purchases | Overdue | Aged payables overdue buckets today | `agedPayables()` | Aged payables |
| Purchases | Bills this month | Approved bills dated this month, excluding GST, less supplier credit notes. This replaces "Purchases this month", because the profit and loss expense total leaves out stock and assets that were bought. | Bills list total for the month | Bills list filtered to this month |
| Purchases | Suppliers overdue | Count of suppliers with an overdue balance | `agedPayables()` rows | Aged payables |
| Banking | Cash in bank | As on Home | `getHomeSummary()` bank accounts | Balance sheet bank lines |
| Banking | Credit cards owed | Sum of active credit card account balances | `getHomeSummary()` card accounts | Balance sheet card lines |
| Banking | Lines to reconcile | Sum of `unreconciledCount` across active accounts | Bank accounts list | Bank accounts |
| Banking | Accounts with a difference | Count of accounts where `bankReconciliationReport().notExplained` isn't zero | `bankReconciliationReport()` | Bank reconciliation report |
| CRM | Open pipeline | Your open opportunities, by currency | `crmHome()` | CRM home |
| CRM | Open opportunities | Count of your open opportunities | `crmHome()` | CRM home |
| CRM | Tasks due | Your tasks due today or earlier | `crmHome()` | CRM home |
| CRM | Closing this month | Your opportunities with an expected close date this month | `crmHome()` opportunities | Opportunities list |

## Pinned Analytics tiles

When Analytics is on, each area should support **default tiles first** and **optional pinned tiles second**.

### How pinning should work

- A dashboard tile is still authored in Analytics, using the existing saved dashboard model and loaded `tohyee_*` tables.
- On a dashboard tile menu, add **Pin to page**.
- The picker should offer pages such as Home, Sales, Purchases, Banking, Payroll, Reports and CRM.
- Pinned tiles should keep the tile’s existing question, title, date range behaviour and slicers.
- The page stores only a reference to the saved dashboard tile plus layout metadata; it does not copy accounting logic.
- The page should show pinned Analytics tiles **in a tile slot chosen with Customise. The page keeps at most four tiles.

### Role and sharing rule

Respect decisions 360 and 368:

- report viewers can see only **shared dashboards**;
- they can pin only tiles from dashboards already shared with them;
- page-level pinned tiles must enforce the same `analytics_dashboard_shares` access rules as Analytics itself.

## Mockups included in this PR

Static proposal mockups are in `docs/ui-review/proposal/`:

- `home-light.html`
- `home-dark.html`
- `sales-list-light.html`
- `sales-list-dark.html`
- `invoice-editor-light.html`
- `invoice-editor-dark.html`
- `mockup.css`

They use the existing surface, text, accent and chart token values from `src/app/globals.css`. Figures are made up. `search-light.html` and `search-dark.html` show search everything open. Home shows what a hidden dashboard looks like at the bottom. The Sales list shows a pinned Analytics tile, which has a dashed edge, and one row opened up. The invoice editor has no dashboard.

## Build plan in small PRs

1. **Top bar, search everything and the dashboard frame.** The simpler menus,
   the app grid, the notices bell, Ctrl K searching records as well as pages,
   and a reusable dashboard (up to four tiles) with Hide and Customise that's
   remembered per person and page. No accounting changes.
2. **Home.** Tiles, the monthly profit chart, To do and Recent activity.
3. **Pinned Analytics tiles.** "Pin to page" from a dashboard tile, with the
   existing sharing rules (report viewers only see shared dashboards). This
   comes early because dashboards from Analytics are what Jess asked for.
4. **Sales and Purchases lists.** Dashboards, fewer columns, rows that open
   for detail, and a column picker.
5. **Invoice and bill editors.** Four fields up front, "more details", lines
   that open for account, tax and tracking, and a totals panel.
6. **Banking.** The dashboard, and reconciling kept apart from setup.
7. **Contacts.** List and detail side by side; no dashboard.
8. **Payroll, Reports and GST.** Tidier pages; no dashboards.
9. **Settings.** Grouped into sections.
10. **CRM home.** Its dashboard.
11. **Phone and accessibility pass** across everything above.

## Accessibility and phone-width guardrails

Any build work from this proposal should keep these rules:

- default contrast must stay within the existing light and dark token system;
- every filter, tab and action must work by keyboard;
- drawers and panels must trap focus correctly and close with Escape;
- tables need a stacked or summary view on narrow screens;
- hidden detail must stay discoverable, not disappear.

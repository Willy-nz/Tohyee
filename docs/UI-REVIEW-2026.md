# UI review 2026 proposal

This PR is a review and proposal only. It does not change app code.

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

## Findings and proposal by page

### Home (`/operations`)

**What feels dated or crowded now**

- The page opens with reminders, a bank-account section, three due/GST tiles, four financial-year stats and an eight-row journals table.
- Each bank account becomes its own full tile, so the page grows vertically as soon as an organisation has more than a few accounts.
- “This financial year” and “Latest journals” are useful, but they sit at the same visual weight as urgent work.
- The page is informative, but it is not a dashboard in the modern sense; it reads more like a summary report.

**2026 proposal**

- Keep a **single dashboard strip** at the top: cash to reconcile, money owed to you, bills to pay, next GST, net profit YTD.
- Collapse bank accounts into **one compact cash card** with total cash, accounts with unreconciled lines, and a “View accounts” action.
- Move journals down into a secondary “Recent posting activity” card.
- Turn reminders into a slim stacked alert rail above the strip instead of full-width blocks.
- Let Analytics tiles pin into the right side of the strip when enabled.

### Sales invoices list (`/operations/invoices`)

**What feels dated or crowded now**

- One card contains a long explainer, five tabs, one primary action and a table.
- The base table has **10 columns** in advanced mode: Number, Customer, Date, Due, Reference, Salesperson, Status, Payment, Total and Amount due, before any custom fields.
- Status and payment state both compete for attention in separate columns.
- “Reference” is always visible even though it is often blank or secondary.

**2026 proposal**

- Add a **four-tile strip** above the list: awaiting payment total, overdue total, customers overdue, sales this month.
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
- Add a default strip for bills to pay, overdue bills, suppliers overdue and purchases this month.
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
- Add a top strip for active customers, active suppliers, prospects and overdue balances.
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

- Add a dashboard strip: total cash, unreconciled lines, accounts out of balance, feeds needing attention.
- Keep the accounts list focused on Account, statement vs books, unreconciled count and last import/feed state.
- Open “Add account” in a drawer, not inline.
- Move Akahu setup into its own secondary section with less prominence unless feeds are disconnected.

### Reconciliation (`/operations/bank-accounts/[accountId]`)

**What feels dated or crowded now**

- The page opens with four stats, optional warnings, then a five-tab card: Reconcile, Statement lines, Import a statement, Bank feed and Bank transactions.
- Reconciliation, import and feed setup all sit at the same level.
- The summary is useful, but the page still feels like a stack of technical tools rather than one focused task.

**2026 proposal**

- Make **Reconcile** the clear default workspace.
- Keep the top strip to four compact facts: statement balance, books balance, difference, lines left.
- Move Import and Bank feed behind a single “More” menu or utility drawer.
- Keep Statement lines and Transactions as secondary tabs under the reconcile canvas.
- Use a sticky “difference” chip so someone always knows whether they are done.

### Payroll (`/operations/payroll/pay-runs`)

**What feels dated or crowded now**

- The page starts with a full “Start a pay run” form, then a “Pay runs” table.
- The create form has 3 fields and a primary button, but it dominates the page even when the regular task is checking existing runs.
- The runs table has 6 columns and no dashboard context.

**2026 proposal**

- Start with a payroll strip: next pay date, gross pay this month, PAYE due, employees paid this month.
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
- Keep a short top strip: profit this month, receivables, payables, cash and stock.
- Group the standard reports into clusters: Financial, Working capital, Banking, Sales, Custom.
- Open report filters in a side panel so the report body gets more room.
- Surface recently used and pinned reports before the full catalogue.

### GST return (`/operations/gst-return`)

**What feels dated or crowded now**

- The report is accurate and detailed, but the first impression is still a dense report table.
- Boxes, basis explanation, drill-down and filing history all compete on one page.

**2026 proposal**

- Keep the filing-grade numbers, but add a clear strip first: period, basis, Box 15 state, late claims, filing status.
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

- Keep the same three concepts, but make the top row feel like a dashboard strip: open pipeline by currency, overdue tasks, activities today, expected close this month.
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
| Home | Cash in bank | Sum of active bank-account ledger balances in base currency | `getHomeSummary()` bank accounts in `src/lib/reports/home.ts` | Home bank-account tiles |
| Home | Lines to reconcile | Sum of `unreconciledCount` across active bank accounts | `getHomeSummary()` bank accounts in `src/lib/reports/home.ts` | Home bank-account tiles / Bank accounts page |
| Home | Money owed to you | `owedToYou.total` | `getHomeSummary()` in `src/lib/reports/home.ts` | Home “Money owed to you” tile |
| Home | Bills to pay | `billsToPay.total` | `getHomeSummary()` in `src/lib/reports/home.ts` | Home “Bills to pay” tile |
| Home | Next GST | `nextGstReturn.box15` with pay/refund state | `getHomeSummary()` -> `calculateGstReturn()` | Home “Next GST return” tile / GST return |
| Home | Net profit YTD | `netProfit` to today | `profitAndLoss()` in `src/lib/reports/financial.ts` | Profit and loss |
| Sales | Awaiting payment | Aged receivables total at today | `agedReceivables()` in `src/lib/reports/aged-receivables.ts` | Aged receivables |
| Sales | Overdue receivables | Sum of overdue buckets / overdue total at today | `agedReceivables()` in `src/lib/reports/aged-receivables.ts` | Aged receivables |
| Sales | Customers overdue | Count of customers with overdue balances | `agedReceivables()` rows | Aged receivables |
| Sales | Sales by salesperson | Current-period chart by salesperson | `salesBySalesperson()` in `src/lib/reports/sales-by-salesperson.ts` | Sales by salesperson |
| Purchases | Bills to pay | Aged payables total at today | `agedPayables()` in `src/lib/reports/aged-payables.ts` | Aged payables |
| Purchases | Overdue bills | Sum of overdue buckets / overdue total at today | `agedPayables()` in `src/lib/reports/aged-payables.ts` | Aged payables |
| Purchases | Suppliers overdue | Count of suppliers with overdue balances | `agedPayables()` rows | Aged payables |
| Purchases | Purchases this month | Expense total for the chosen month or FY-to-date slice | `profitAndLoss()` in `src/lib/reports/financial.ts` | Profit and loss |
| Banking | Statement lines waiting | Count of unreconciled statement lines across accounts | Bank-account list / `getHomeSummary()` bank accounts | Bank accounts / Home |
| Banking | Accounts with a difference | Count of accounts where statement balance and books balance differ after reconciliation | `bankReconciliationReport()` in `src/lib/reports/bank-reconciliation.ts` | Bank reconciliation report |
| Banking | Total cash | Sum of bank-account balances in base currency | `getHomeSummary()` bank accounts | Home bank-account tiles |
| Banking | Balance difference | Statement minus expected statement balance for the selected account | `bankReconciliationReport().notExplained` | Bank reconciliation report |
| Payroll | Gross pay this period | `totals.gross` for the selected dates | `payrollSummaryReport()` in `src/lib/payroll/reports.ts` | Payroll summary |
| Payroll | Net pay this period | `totals.netPay` for the selected dates | `payrollSummaryReport()` in `src/lib/payroll/reports.ts` | Payroll summary |
| Payroll | PAYE to pay | PAYE liability movement in the selected dates | `payrollReconciliation()` in `src/lib/payroll/report-reconciliation.ts` | Payroll reconciliation |
| Payroll | Employees paid | `totals.employeeCount` | `payrollSummaryReport()` in `src/lib/payroll/reports.ts` | Payroll summary |
| Reports | Profit this month | Net profit for the current month | `profitAndLoss()` | Profit and loss |
| Reports | Receivables today | Aged receivables total | `agedReceivables()` | Aged receivables |
| Reports | Payables today | Aged payables total | `agedPayables()` | Aged payables |
| Reports | Stock on hand | `totalValue` | `inventoryValuation()` in `src/lib/reports/financial.ts` | Stock valuation |
| CRM | Open pipeline | Sum of the signed-in user’s open opportunities, by currency | `crmHome()` in `src/lib/crm/service.ts` | CRM home |
| CRM | Open opportunities | Count of the signed-in user’s open opportunities | `crmHome()` in `src/lib/crm/service.ts` | CRM home |
| CRM | Tasks due | Count of tasks due today or earlier | `crmHome()` in `src/lib/crm/service.ts` | CRM home |
| CRM | Recent activity | Count of the latest activity items shown on home | `crmHome()` in `src/lib/crm/service.ts` | CRM home |

## Pinned Analytics tiles

When Analytics is on, each area should support **default tiles first** and **optional pinned tiles second**.

### How pinning should work

- A dashboard tile is still authored in Analytics, using the existing saved dashboard model and loaded `tohyee_*` tables.
- On a dashboard tile menu, add **Pin to page**.
- The picker should offer pages such as Home, Sales, Purchases, Banking, Payroll, Reports and CRM.
- Pinned tiles should keep the tile’s existing question, title, date range behaviour and slicers.
- The page stores only a reference to the saved dashboard tile plus layout metadata; it does not copy accounting logic.
- The page should show pinned Analytics tiles **after** the default strip, never instead of it.

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

They use the existing surface, text, accent and chart token values from `src/app/globals.css`.

## Build plan in small PRs

1. **Shared shell and dashboard strip**
   - Add a reusable page dashboard strip and pinned-tile container.
   - No accounting logic changes.
2. **Home refresh**
   - Rework `/operations` to use the new strip and calmer secondary cards.
3. **Sales and Purchases list refresh**
   - Reduce default columns, add row expansion, add dashboard strips.
4. **Invoice and bill editor refresh**
   - Rework document editors into layered details + totals layouts.
5. **Contacts refresh**
   - Introduce split view / detail panel and compact actions.
6. **Banking refresh**
   - Separate daily reconciliation from account/feed setup.
7. **Payroll refresh**
   - Add payroll strip and move “Start pay run” to a modal/drawer.
8. **Reports and GST refresh**
   - Turn Reports into a launcher/dashboard; tidy GST hierarchy.
9. **Settings refresh**
   - Break one long admin form into clearer categories.
10. **CRM refresh**
    - Make CRM home feel like a dashboard workspace.
11. **Pinned Analytics tiles**
    - Add page pinning for shared Analytics tiles, reusing existing dashboard questions and access rules.
12. **Phone-width and accessibility pass**
    - Keyboard order, focus states, contrast, touch targets and stacked mobile layouts across the new shell.

## Accessibility and phone-width guardrails

Any build work from this proposal should keep these rules:

- default contrast must stay within the existing light and dark token system;
- every filter, tab and action must work by keyboard;
- drawers and panels must trap focus correctly and close with Escape;
- tables need a stacked or summary view on narrow screens;
- hidden detail must stay discoverable, not disappear.

# Gap review (30 September 2026)

What Tohyee still lacks compared with what a NZ bookkeeper expects from Xero,
plus the scope Jess set (Xero core, NetSuite-style depth, NZ payroll, fixed
assets, projects and time, multi-currency, a not-for-profit module). Written
overnight at Jess's request ("do a review of what features we are missing and
add those yourself"). Items built overnight are marked with their PR; every
one of them has worked examples that **Jess hasn't approved yet**.

Built already (for context): ledger, chart of accounts, invoices, bills,
payments, credit notes, overpayments, GST return (all three bases), bank
accounts, feeds and reconciliation, custom reports, tracking categories,
custom fields, salespeople, CRM with mail sync, richer customers, products
and services, stock per location, backups, remote access, two-step sign-in.

## Order chosen for overnight work

Everyday bookkeeping gaps first, because they're used every week and their
rules are well settled; then the larger scope items.

| # | Gap | Why it matters | Size |
| --- | --- | --- | --- |
| 1 | **Reports**: aged payables, account transactions (general ledger detail), journal report, GST audit report (plan step 5), customer statements with parent roll-up | Month-end and audit work can't be done without them | Medium. Built overnight (examples AGP, ATX, JR, GA, CST) |
| 2 | **Sales documents**: quotes (accept to invoice), repeating invoices, printable invoice/credit note/statement PDFs | Daily sales work in Xero | Medium. Built overnight (examples QT, RI, PD) |
| 3 | **Purchase orders** (approve, then turn into a bill), **repeating bills** | Standard in Xero and NetSuite | Medium. Built overnight (examples PO); repeating bills built 30 Sep 2026 (examples RB), sharing the repeating invoices' scheduler |
| 4 | **Budgets** and the budget column in custom reports (TODO item 4) | Not-for-profits and boards report against budget | Medium. Built overnight (examples BU) |
| 5 | **Stock transfers** between locations | The one stock movement missing after PR #36 | Small. Built overnight (examples TR) |
| 6 | **Fixed assets**: register, IRD depreciation (DV/SL), disposals | Every year-end needs it | Large. Built overnight (examples FA) |
| 7 | **Expense claims** (staff paid back) | Common in Xero | Medium. Built overnight (examples EC) |
| 8 | **Projects and time tracking** | In Jess's scope | Large. Built overnight (examples PJ) |
| 9 | **Multi-currency invoices and bills** | In Jess's scope | Large |
| 10 | **NZ payroll** (PAYE, KiwiSaver, ACC, student loan, payday filing) | In Jess's scope; needs current IRD rates and Jess's decisions, so planned rather than built overnight | Very large |
| 11 | **Not-for-profit module** (funds/grants, restricted funds, PBE reporting) | In Jess's scope; tracking categories and custom segments cover part of it | Large |

Also noticed, smaller: supplier overpayments and prepayments (waiting on
Jess's GST decision), emailing documents to customers (built: sent from each
organisation's own email account, as Jess decided on 30 Sep 2026), CSV import
and export of contacts and items, year-end close.

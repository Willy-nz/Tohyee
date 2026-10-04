# Tohyee architecture

This is the source of truth for how Tohyee is put together. If code and this
document disagree, flag it instead of quietly picking one.

## System shape

- One Next.js application (TypeScript) serves the web UI and the JSON API.
- PostgreSQL stores everything. Redis is reserved for background jobs later;
  nothing uses it yet.
- One server hosts many organisations (e.g. a bookkeeper's clients).

## Tenancy: one database per organisation

**Every organisation has its own PostgreSQL database.** This is a deliberate
decision by the project owner; do not change it to schema-per-organisation or
row-level tenancy.

```
tohyee                  core database (DATABASE_URL)
├─ organisations        registry: id, name, database_name, status
├─ users, sessions      logins, two-step sign-in (authenticator key encrypted),
│                       user_backup_codes, two_step_reset_tokens
├─ server_settings      email sending and remote access (secrets encrypted with
│                       TOHYEE_SECRET_KEY; never accounting data)
├─ organisation_members who can open which organisation, with what role
├─ ai_access_tokens     personal AI keys (SHA-256 only) with an access level, per user per organisation
└─ admin_audit_events   server-level audit trail

tohyee_org_glimmers     one database per organisation (organisation "glimmers")
├─ organisation_settings  (records which organisation owns this database)
├─ accounts, ledger_journals, ledger_journal_lines
├─ ledger_journal_drafts, ledger_journal_draft_lines   draft manual journals (post nothing; a posted one links its journal and can't change)
├─ ledger_fx_revaluation_runs / _items / _documents   revaluations, per account and currency, and the open documents they revalued (MC39)
├─ ledger_foreign_opening_balances   a foreign-currency account's foreign balance as at a date, entered once (FXB1)
├─ inventory_item_balances, inventory_movements   stock by item code and location (a Location tracking value)
├─ stock_transfers        stock moved between locations (append-only; its two movements and journal point at it)
├─ tax_codes, accounting_period_controls
├─ contacts               customers and suppliers (with terms, credit limit, group, price level, parent, currency)
├─ payment_terms, customer_groups, price_levels   lists for customers (archived, never deleted)
├─ items, item_units, item_level_prices, item_suppliers, kit_components   products and services
├─ sales_invoices, sales_invoice_lines, sales_invoice_numbering   (with the sales order and line they came from, if any)
├─ quotes, quote_lines, quote_numbering   quotes (post nothing; accepting makes a draft invoice or sales order)
├─ sales_orders, sales_order_lines, sales_order_numbering   sales orders (post nothing; invoiced in parts)
├─ repeating_invoices, repeating_invoice_lines   repeating invoice templates (post nothing)
├─ repeating_invoice_runs   one row per scheduled date made (unique), so a date is never made twice
├─ repeating_bills, repeating_bill_lines, repeating_bill_runs   repeating bill templates and the bills they made (the same rules)
├─ customer_payments      money received against sales invoices (with any overpayment)
├─ customer_overpayment_applications   overpayments applied to other sales invoices
├─ customer_overpayment_refunds        overpayments paid back to customers
├─ bills, bill_lines      bills from suppliers (with the purchase order and line they came from, if any)
├─ purchase_orders, purchase_order_lines, purchase_order_numbering   purchase orders (post nothing; copied to bills)
├─ supplier_payments      money paid against bills
├─ expense_claims, expense_claim_receipts, expense_claim_payments   staff expense claims, their receipts and payments
├─ payroll_employees        employee payroll details (IRD and bank details encrypted), job title, reports-to, pay and employee group
├─ payroll_pay_rates        pay rate history: salary or hourly rate from a date (append-only)
├─ payroll_cost_allocations, payroll_cost_allocation_lines   where pay is charged, split by % from a date (append-only; lines total 100.00%)
├─ payroll_pay_groups, payroll_employee_groups   pay groups (with a pay frequency) and employee groups for reporting
├─ payroll_access           who has payroll access, by core user id (grants and removals in audit_events)
├─ payroll_pay_items        pay items: earnings, after-tax deductions and employer KiwiSaver, each with its account and tax treatment (archived, never deleted)
├─ payroll_pay_runs, payroll_pay_run_employees, payroll_pay_run_lines   pay runs: drafts, then approved (with a snapshot of each person's pay) or voided; frozen once approved
├─ payroll_pay_run_postings  how each approved pay run's earnings and employer KiwiSaver were split per employee by allocation, and which journal line each went to (append-only; payroll access only)
├─ payroll_pay_run_shares, payroll_pay_run_timesheets   each employee's shares on an approved pay run (timesheet row or allocation line, hours, weight, tags, R&D activity) and the approved timesheets it used (append-only)
├─ payroll_timesheets, payroll_timesheet_entries, payroll_timesheet_history   weekly timesheets (draft, submitted, approved), hours per day stamped by the database (replaced or removed, never changed or deleted) and each step with who and when
├─ payroll_wage_payments    net wages paid from an approved pay run, as a whole or per employee (voided, never changed or deleted)
├─ payroll_ird_payments, payroll_ird_payment_lines   payments to IRD for an IRD period, per liability (voided, never changed or deleted; lines append-only)
├─ rd_activities, rd_activity_supports   the R&D activity register (archived, never deleted) and which core activities each supporting one supports
├─ rd_approvals, rd_approval_activities   general approvals from IRD and the activities they cover (withdrawn, never deleted)
├─ rd_files               files on R&D records (append-only; a new version replaces, never deletes)
├─ rd_tags                one tag per posted cost line: activity, share, category or ineligible reason (removed, never deleted)
├─ rd_asset_tax_depreciation, rd_asset_usage   a fixed asset's tax depreciation per income year (append-only) and its usage log
├─ rd_overhead_rules      "% of an account" to an R&D activity with its basis and workings; changed by a replacing rule (never deleted)
├─ rd_history             every version of every R&D record, stamped by the database (append-only)
├─ fixed_asset_types, fixed_assets, fixed_asset_numbering   the fixed asset register (archived, never deleted)
├─ fixed_asset_depreciation_runs, fixed_asset_disposals, fixed_asset_depreciation_lines   depreciation runs and disposals, and the months each charged
├─ projects, project_tasks, project_time_entries, project_expenses   projects, their tasks, time (whole minutes) and linked expense lines (post nothing; never deleted)
├─ project_invoices, project_invoice_items, project_staff_rates   what each project invoice billed, and staff cost rates per member
├─ customer_payment_batches, supplier_payment_batches   one payment for several invoices or bills (its parts are customer or supplier payments)
├─ custom_reports         custom report drafts, and published frozen copies with their figures
├─ dashboard_preferences  per-user per-page dashboard hide/show and tile choices
├─ budgets, budget_amounts   budgets (post nothing; archived, never deleted) and their amounts per account and month
├─ sales_credit_notes, sales_credit_note_lines, sales_credit_note_numbering
├─ sales_credit_note_applications   credit applied to sales invoices
├─ sales_credit_note_refunds        credit paid back to customers
├─ supplier_credit_notes, supplier_credit_note_lines
├─ supplier_credit_note_applications   credit applied to bills
├─ supplier_credit_note_refunds        credit paid back by suppliers
├─ gst_returns, gst_return_adjustments, gst_return_lines   filed GST returns
├─ bank_account_settings  per bank/card account: statement balance, import layout, Akahu feed link, bank file format and account number (P5)
├─ akahu_connections      the organisation's own Akahu personal app (tokens encrypted)
├─ bank_statement_imports, bank_statement_lines   statement files and bank feed syncs
├─ bank_reconciliations, bank_reconciliation_items   which journal lines each statement line is
├─ bank_reconciliation_splits   one journal line reconciled across several statement lines
├─ bank_transactions, bank_transaction_lines   spend and receive money
├─ bank_transfers         money moved between bank and card accounts
├─ bank_rules             text to look for, and the bank transaction to suggest
├─ record_notes, record_attachments   notes and files on journals, documents and contacts
├─ conversion_balances, conversion_balance_lines   opening balances as brought in, once (IM1-IM21)
├─ import_mappings        the column mapping last used for each kind of import file
├─ organisation_email_settings, email_templates   the organisation's own email account (SMTP password or Microsoft or Google tokens encrypted) and templates
├─ email_oauth_states     one-time states for signing in to the Microsoft or Google mailbox documents are sent from
├─ organisation_logo      the organisation's logo (PNG or JPEG, 512 KB at most), on emails, PDFs and print pages
├─ document_emails, document_email_batches   each email of a document, statement or payslip (pay run and employee): queued, then sent or failed by the job
├─ sales_platform_connections, sales_platform_mappings   connected stores (Shopify; credentials encrypted) and which contact or item each store record is
├─ sales_platform_sync_log, sales_platform_webhook_deliveries   what each sync and webhook did (append-only), and webhook deliveries already handled
└─ audit_events
```

Why:

- Each organisation can be backed up, restored or moved to another server on
  its own (`pg_dump`/`pg_restore` of one database).
- Isolation is enforced by PostgreSQL connections, not by remembering to add
  a filter: a query in one organisation's transaction physically can't read
  another organisation's tables.
- The core database never holds accounting data.

Rules:

- Requests and jobs carry **organisation IDs**, never database names. The
  database name is looked up from `organisations` in trusted server code.
- All organisation work goes through `withOrganisation()` (API) or
  `withOrganisationTransaction()` (lib), which: authenticates, checks the
  caller's role, opens a transaction on that organisation's database, and
  checks the database's `organisation_settings.organisation_id` matches.
- Organisation databases are named `<core database>_org_<organisation id>`,
  with dashes turned into underscores (set `TOHYEE_ORG_DATABASE_PREFIX` to
  change the prefix). The name is stored in the registry when the
  organisation is created, so changing the prefix later only affects new
  organisations.
- One small connection pool per organisation database, least-recently-used
  pools are closed (`TOHYEE_MAX_ORG_POOLS`, default 25;
  `TOHYEE_ORG_POOL_SIZE`, default 5). Size PostgreSQL's `max_connections`
  accordingly.
- Migrations run at startup. Apart from a server admin creating or repairing
  an organisation, requests never run DDL or take advisory locks.

### Database logins

- `DATABASE_URL` is the runtime login.
- `DATABASE_ADMIN_URL` (optional) is a login with `CREATEDB` that creates
  organisation databases, owns their tables and runs migrations. When it is
  set, the runtime login gets data access only: no DDL, and no
  `UPDATE`/`DELETE`/`TRUNCATE` on posted history
  (`tests/integration/separate-logins.test.ts`). This relies on PostgreSQL 15
  or newer, where ordinary logins can't create tables in the `public` schema.
- When `DATABASE_ADMIN_URL` isn't set, the one login does everything. That's
  fine for a small self-hosted server: the database triggers below still stop
  the app from rewriting history, though a login that owns the tables could
  switch them off.
- Organisation databases revoke `CONNECT` from `PUBLIC`, so other logins on
  the same PostgreSQL server can't connect to them.

### Provisioning

Creating an organisation (server admins only):

1. registers it in `organisations` with status `pending` and makes the owner
   a member,
2. runs `CREATE DATABASE` (outside any transaction),
3. applies the tenant migrations,
4. seeds `organisation_settings`, a starting NZ chart of accounts and the
   standard NZ GST codes (each only if there are none yet),
5. gives the first owner payroll access, once (`organisation_settings.payroll_access_started_at`
   records it; also run after migrations at start-up so upgraded organisations get it),
6. marks it `ready`.

Every step is idempotent. If any step fails the organisation is marked
`failed` with the error, and **Repair** (`POST /api/admin/organisations/:id/repair`)
re-runs the whole sequence.

### Migrations

- Migrations are TypeScript modules (`src/lib/db/migrations/core.ts` and
  `tenant.ts`) so they ship inside the release bundle.
- They run automatically on server start (`src/instrumentation.ts`) and with
  `npm run db:migrate`.
- Each migration runs in its own transaction, under an advisory lock per
  database, and is checksummed. **Never edit a released migration; add a new
  one.** An edited migration or a database newer than the code stops that
  database from being migrated.
- Tenant migration numbers are unique across active branches; coordinate the
  next number with the other open branches before adding a tenant migration.
- The core database migrates first; if it fails, the server doesn't start.
- Each organisation then migrates on its own. A failure marks that
  organisation `failed` and blocks it (not half-upgraded); others carry on.
- Every tenant migration is tested against multiple organisation databases in
  the integration tests.

## Identity and access

- Logins are email + password (scrypt hashes), with server-side sessions in
  the core database. The browser only holds a random session token in an
  `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS); the database stores
  its SHA-256.
- A session ends after 14 days without use; using it pushes the expiry out
  again. (Browsers keep the cookie for up to 400 days so it doesn't expire
  while the session is still in use; the server decides when it ends.)
  Changing your password signs out your other sessions; an admin reset signs
  out all of them.
- **Two-step sign-in** is required for everyone whenever the server has
  `TOHYEE_SECRET_KEY` (the Windows installers create it). The password only
  opens a *pending* session (10 minutes, can do nothing but finish signing
  in); an authenticator code (RFC 6238, 30 seconds, one step either side, a
  code never accepted twice) or a one-use backup code (10, scrypt-hashed)
  then replaces it with a new, full session token. People without it set up
  are sent to set it up (QR code, first code, backup codes) before anything
  else, including existing sessions after an upgrade. Five wrong codes end a
  pending session; ten in a row lock the account for 15 minutes. Lost phone:
  a backup code, an emailed reset link (after the password; the link needs
  the password again, lasts 30 minutes and works once), a server admin reset
  from Users, or `npm run admin -- reset-two-step`. Each reset signs the
  person out everywhere. Without `TOHYEE_SECRET_KEY`, sign-in is password
  only and server admins see a warning on every page; remote access can't be
  turned on.
- Security alerts are emailed (when Email is set up in the server settings) for two-step
  turned on or reset, a backup code used, new backup codes and a lockout.
  A failed alert never blocks the action.
- Five failed sign-ins lock the account for 15 minutes. Unknown emails take
  about the same time to reject as wrong passwords (a dummy password check
  runs). A lockout message does reveal that the email has an account.
- State-changing requests from another site are rejected (`Origin` /
  `Sec-Fetch-Site` check) on top of `SameSite` cookies.
- Every API route needs a signed-in user and checks their role, except two: `/api/mcp` (below), and
  the sales platform webhook address
  (`/api/sales-platforms/webhooks/<organisation>/<random key>`), which a
  store calls. It authenticates only by the platform's signature (Shopify:
  HMAC-SHA256 of the raw body with the app's secret, compared in constant
  time) with that connection's secret, before reading the body or writing
  anything; every refusal is the same 401. The random key (32 bytes) only
  finds the connection; it isn't the secret.
- `/api/mcp` (decisions 339-345), where people's own AI connects over MCP,
  doesn't use sessions either: it takes only `Authorization: Bearer
  tohyee_ai_…`, a personal AI key (SHA-256 in `ai_access_tokens`, core
  database) for one organisation, which works while its owner's login is
  active and they're still a member, with their current role. The key's
  access level (look only, make drafts, make and post; decision 346) is
  capped by that role, and only those tools are offered. Read tools run in
  a read-only PostgreSQL transaction (`withOrganisationTransaction(...,
  { readOnly: true })`); write tools call the screens' services as the
  person, with `actor.via` naming the key, which `writeAuditEvent` adds to
  every audit event. No tool deletes anything (decision 347). No
  same-origin check (AI services call it from elsewhere) and no CORS
  headers; cookies are ignored.
- First-time setup creates the first server admin and needs `SETUP_TOKEN`
  from the server's environment. It only works while there are no users.
- Command-line tool (`scripts/admin.ts`; `npm run admin`, or
  `node tohyee-admin.cjs` in the Docker image, bundled by
  `scripts/build-admin.mjs`): the server settings for Docker and Linux
  (organisations, users, remote access, email, updates) and break-glass
  (`set-password`, `reset-two-step`). It runs on the server against the core
  database with no user, so it calls the same functions as `/api/admin/*`
  with an actor whose id is null and whose email is `cli` in the audit trail.
  It saves remote access without starting or stopping the tunnel (the
  running server does that at start-up).

### Roles

Server-wide:

- **Server admin**: creates organisations and users, repairs organisations,
  sets up remote access and email. Being a server admin does *not* grant
  access to any organisation's books; that trust boundary is deliberate.
  Server settings live apart from the books (`/server`) and only work on the
  server computer itself: Tohyee opens a second address on 127.0.0.1
  (`TOHYEE_ADMIN_PORT`, default the main port + 1) that passes requests on to
  the main server with a secret header made fresh at each start
  (`src/lib/server-admin/`). `/api/admin/*` and the `/server` pages refuse
  anything without it, so they can't be reached over the network or through
  the Cloudflare Tunnel even with a server admin's session. On Windows the
  server settings are a native app (`installer/windows/tray`, .NET Framework
  4.8, which Windows 10 and 11 include): a tray icon that shows whether the
  services are running and a window that signs in as a server admin (with
  two-step sign-in) and uses the same `/api/admin/*` routes through the local
  address. It starts when its user signs in to Windows (HKCU Run key, set by
  the installer and switchable from its menu). The browser `/server` pages
  stay as a fallback until the owner has tried the server app on a real server.

Per organisation (lowest to highest):

| Role | Can |
| --- | --- |
| viewer | fill in and submit their own timesheets when linked to an employee (Payroll › Timesheets; hours only); read journals, stock, expense claims, fixed assets (with runs and the register), contacts, invoices, customer payments, credit notes (with their applications and refunds), bills, supplier payments, supplier credit notes (with their applications and refunds), reports (including custom report drafts and published copies, budgets and budget vs actual), the GST return, filed GST returns, the GST audit report and customer statements, quotes, sales orders (with their invoices), repeating invoices, repeating bills and purchase orders, projects (with profitability, the time report and staff cost rates), the R&D activity register, tags, tagged R&D costs, overhead rules and the R&D claim report (each employee's pay only with payroll access), and export the claim report as CSV; print invoices, credit notes, quotes and purchase orders; read notes, download files and see the history |
| bookkeeper | + post journals, corrections, stock movements and transfers, FX revaluations; add and archive exchange rates; add, edit and archive contacts; save, approve, void and delete draft invoices; record and void customer payments (one invoice or several); save, approve, void and delete draft credit notes, apply and remove their credit, record and void their refunds; save, approve, void and delete draft bills; record and void supplier payments (one bill or several); enter a foreign-currency bank account's opening foreign balance; save, approve, void and delete draft supplier credit notes, apply and remove their credit, record and void their refunds; make, change, publish, archive and delete custom reports; add, change, quick fill and archive budgets; make, change, submit and delete their own expense claims, and approve (not their own), decline, pay and void claims and void their payments; register, change and archive fixed assets, run depreciation and roll back the latest run, dispose of assets and undo disposals; close a month on Period close when every check passes; save, finalise, accept (as an invoice or a sales order), decline, copy and delete draft quotes; save, approve, invoice, close, cancel and delete draft sales orders; save, approve, cancel, copy to a bill and delete draft purchase orders; save, change, run, pause, resume and end repeating invoices and repeating bills; start and change projects and tasks, record, change and remove their own time, link and remove expenses, invoice, close and reopen projects; add and change R&D activities, enter approvals, tag lines to R&D activities, enter assets' tax depreciation and log their use, set, change and end R&D overhead rules, and add or replace R&D files; add notes and files, and edit, delete or remove their own |
| admin | + archive and restore R&D activities and withdraw R&D approvals; see R&D deadline reminders; approve their own expense claims; staff cost rates, and recording and changing other members' project time; fixed asset types and the part-month settings; chart of accounts, tax codes, closing a month with checks that need attention (after confirming) and reopening months (with a reason) on Period close, settings (including payment terms, customer groups, price levels, the credit limit setting and the GST number, address and payment details printed on documents), people; mark GST returns as filed; edit and delete anyone's notes and remove anyone's files |
| owner | + manage other owners (an organisation always keeps one) |

**Payroll access** is a separate permission, not a role (examples PE9-PE12).
An admin gives it to, or removes it from, named members (Settings › Payroll
access); it needs the bookkeeper role or higher, and admins and owners don't
get it automatically. It's kept in the organisation's own database
(`payroll_access`, keyed by the core user id), and every grant and removal is
in `audit_events` with who did it. The first owner has it from the start, the
last current member who has it and can use it (bookkeeper or higher)
can't lose it, and someone removed from the
organisation and added again starts without it. Every payroll service calls
`requirePayrollAccess(tx)` (`src/lib/payroll/access.ts`) first, and payroll
routes use `withPayrollAccess()` (`src/lib/api/http.ts`: bookkeeper and
payroll access); pay runs and payroll reports do. Audit
details for payroll never include IRD numbers, bank accounts or pay amounts.

**Pay runs** (payroll stage P3, examples PRUN1-PRUN11) live in
`src/lib/payroll/pay-runs.ts`, with pay items and the approver setting in
`pay-items.ts`. One person's pay is worked out by the pure
`calculateEmployeePay()` (`pay-calculation.ts`), which calls the P2
calculations with the rates in effect on the pay date (decision 1). A draft
is calculated live from each person's current details; approving stores a
snapshot of every figure on `payroll_pay_run_employees`, and triggers then
refuse changes to the run, its people and its lines. Approving posts one
journal (origin `payroll`, dated the pay date) through the ledger service, so
locks and period close apply as for any journal; earnings and employer
KiwiSaver are split with `allocationOn()` and `splitByPercentages()` per
person, then summed per pay item, account, tracking and project, so journal
lines never name or single out a person (decision 6). The per-person split is
kept in `payroll_pay_run_postings`, readable only with payroll access. Voiding
posts a reversing journal; payroll journals can't be corrected through the
general ledger. When the organisation turns on
`payroll_approver_must_differ`, anyone who created or changed a draft
(`prepared_by_user_ids`) can't approve it.

**Paying wages and IRD** (payroll stage P4, examples PPAY1-PPAY12) live in
`src/lib/payroll/wage-payments.ts` and `ird-payments.ts`, with IRD's periods
and due dates as pure functions in `ird-due-dates.ts` (sources in the file).
A wage payment pays an approved pay run's net pay (its stored snapshot) as a
whole or for one employee on it, never both on one run, never more than
what's unpaid, dated on or after the pay date: one journal (origin
`payroll`, reference WAGES-n), Dr the `wages_payable` account / Cr the bank,
lines described "Net pay" so the bank account never names anyone (decision
6). An IRD payment pays one IRD period (by pay date; monthly or twice a
month from `organisation_settings.payroll_ird_payment_frequency`): what's
owing per liability is worked out from the approved pay runs' stored PAYE,
student loan, KiwiSaver (employee plus employer net of ESCT) and ESCT less
active IRD payment lines for the same period, and each line is refused above
it; recording takes the settings row lock so two can't overpay. One journal
(reference IRD-n) debits each liability's control account and credits the
bank. Both are matched to statement lines by the existing reconciliation
(any journal line on the bank account is a suggestion). Voiding posts the
exact reversal; the database refuses changing or deleting payments other
than voiding once, refuses a wage payment above what's unpaid or on an
unapproved run, and refuses voiding a pay run while it has active wage
payments or an active IRD payment covers its pay date. Audit details hold no
amounts, bank account numbers or IRD numbers.

**Bank files and payslips** (payroll stage P5, examples PBF1-PBF7 and
PSLIP1-PSLIP6, tenant migration 0063). Direct credit files are pure
functions in `src/lib/payroll/bank-files.ts` (ANZ domestic extended, ASB
FastNet MT9, BNZ IB4B, each written to its bank's published specification in
`docs/sources/nz-bank-direct-credit-formats.md`; Westpac and Kiwibank
refused), with account-number shape checks in `bank-account-number.ts`.
`bank-file-service.ts` reads the pay run's unpaid net pay per employee
(`listWagePayments`), decrypts employees' bank accounts after
`requirePayrollAccess`, and returns the file; it posts nothing, marks nothing
paid and its audit event holds no amounts or account numbers. Each bank
account's format and number are in `bank_account_settings` (admins set them,
Settings › Bank files). Payslips (`payslips.ts`) are built from the approved
pay run's snapshot with the year to date summed from approved runs in the tax
year (`payslip-figures.ts`); `payslip-layout.ts` (browser-safe) lays out
the rows both the page and the PDF (`src/lib/pdf/payslip.ts`) show. Payslip
emails are `document_emails` rows of kind `payslip` (pay run and employee,
no contact): the text is fixed and has no figures, and the outbox writes the
PDF when it sends, loading the payslip as the person who asked, so it needs
their payroll access then.

**Timesheets** (payroll stage P9, examples TS1-TS11, decisions 91-101,
tenant migration 0067) live in `src/lib/payroll/timesheets.ts`, with the
pure week, hours, weights and split rules in `timesheet-split.ts`
(browser-safe). They're their own record, not project time entries
(decision 91): `payroll_timesheets` (one per employee per Monday-to-Sunday
week; draft, submitted, approved), `payroll_timesheet_entries` (one active
entry per day and row; a trigger sets `entered_at` to the database's time,
allows entries only on a draft timesheet's week, and lets an entry change
only by being marked replaced or removed; no deletes) and
`payroll_timesheet_history` (append-only steps). Access isn't payroll
access (decision 95): `payroll_employees.user_id` links an employee to a
member's login, who can fill in their own (viewer and up);
`timesheet_approver_user_id` (bookkeeper and up), else the login of the
reports-to manager, approves; people with payroll access can do both, never
for their own. Timesheet APIs (`/api/payroll/timesheets/...`) return hours,
never pay. When a pay run is approved, `timesheetCoverage()` gives each
employee's approved hours on the period's days; the pay run weights each
timesheet row and allocation line (decision 98), splits every amount with
`splitByWeights` (PE3's largest-remainder rule; identical to
`splitByPercentages` when there are no timesheets), and keeps the shares in
`payroll_pay_run_shares` and the timesheets in `payroll_pay_run_timesheets`;
a trigger then refuses reopening a timesheet an approved pay run used. A
draft for an hourly employee whose whole period is covered takes Ordinary
time hours from the timesheets (decision 99). Postings' percentage is kept
to 4 places (decision 101).

**Payroll reports** (payroll stage P10, examples PREP1-PREP8, decisions
102-111, no tables of their own) read approved pay runs only and post
nothing. `src/lib/payroll/report-figures.ts` is pure and browser-safe (the
report names, months, FTE, splitting to any number of places, grouping
labour cost, CSV); `report-common.ts` parses the pay date range (at most 5
years) and filters and lists voided pay runs; `reports.ts` has labour cost
(`payroll_pay_run_postings` joined to the `payroll_pay_run_shares` row each
posting's `share_number` names, for the Department, project and R&D
activity; pay runs from before P9 fall back to the posting's Department tag
and show the R&D activity as not recorded), the payroll summary and
earnings history (`payroll_pay_run_employees` and `payroll_pay_run_lines`
as approving stored them) and the PAYE summary (by month of pay date, IRD
payments by period, each pay run's EI file from the
`payroll_payday_filing.made` audit events); `report-reconciliation.ts`
compares each payroll account's payroll figure with its ledger movement and
lists every journal not from a counted pay run or active payment, labelled
with `journalSource()`; `report-headcount.ts` works headcount and FTE out
in memory from employees' dates, pay rate history and allocations.
`report-export.ts` writes the CSV and the `payroll_report.exported` audit
event (report, dates, filter ids, row count, SHA-256; no figures). Routes:
`GET /api/payroll/reports?report=...` and `POST /api/payroll/reports/export`,
both `withPayrollAccess()`. Screen: `src/components/payroll-reports.tsx`.

**Workforce budgets** (payroll stage P11, examples WB1-WB7, decisions
112-123, tenant migration 0068): `payroll_workforce_budgets` (name, first
month, 1-24 months, version), `payroll_workforce_budget_lines` (an employee
or a position, salary with FTE or hourly with hours, KiwiSaver rate, start
and end months) with `..._line_rates` (pay from a month) and
`..._line_splits` (a position's split), replaced as a set on each save, and
`payroll_workforce_budget_targets` (the budgets each feeds; `budget_id`
unique). `budget_amounts.workforce_budget_id` marks the amounts a workforce
budget wrote; the trigger `tohyee_guard_budget_amount_workforce` refuses
writing, changing or releasing such an amount unless
`tohyee.workforce_budget_feed` is set (for the transaction) to that
workforce budget's id, which only its own rewrite does.
`src/lib/payroll/workforce-figures.ts` is pure and browser-safe (monthly
wages half up, KiwiSaver truncated, splitting with `splitByPercentages`);
`workforce-budgets.ts` loads lines, splits each month by the employee's
allocation in effect on the 1st (or the position's split), filters split
parts by a fed budget's tracking value (Department, Class or Location and
values under it), and writes them through `writeWorkforceAmounts()` in
`src/lib/budgets/service.ts`, which records `budget.amounts_changed` like
any budget change; typed and quick-fill changes to an owned amount are
refused there. "Out of date" is worked out by comparing owned amounts with
today's figures. Budget vs actual calls P10's `labourCostReport()` per
month by Department. Routes under `/api/payroll/workforce-budgets`
(list/create, `[id]` get/put, `[id]/lines` put, `[id]/update-budgets`
post, `[id]/vs-actual` get), all `withPayrollAccess()`. Screen:
`src/components/payroll-workforce.tsx`; the budget grid shows fed amounts
read-only (`fromWorkforce`).

**Extra pays, back pay and final pays** (payroll stage P12, examples
XP1-XP14, decisions 124-137, tenant migration 0069): pure functions in
`src/lib/payroll/calculations.ts`: `annualiseForExtraPay()` (four weeks or
the last 2 paid periods, refusing other patterns), `secondaryLowThreshold()`
(the start of the bracket at a secondary code's rate) and
`calculateExtraPayTax()` (rate from the grossed-up amount, ACC levy steps
4.1-4.4, one truncation); `calculateEmployeePay()` taxes lines flagged
`extraPay` with them and the rest as before, and puts student loan on the
whole pay. Pay item kinds `extra_pay`, `back_pay`,
`termination_holiday_pay` and `redundancy` (`EXTRA_PAY_KINDS`,
`TERMINATION_KINDS` in `pay-items.ts`; the migration replaces the kind
checks and lets redundancy have no levy). In `pay-runs.ts`,
`extraPayBasis()` reads approved pay runs' regular pay
(`taxable_earnings - extra_pay`) for the window and returns the method and
annualised income, or the employee's problem; `addBackPay()` /
`removeBackPay()` (route `.../employees/[employeeId]/back-pay`, POST and
DELETE) write lines with `payroll_pay_run_lines.back_pay_for_pay_run_id`,
which `setPayRunEmployeeLines()` keeps after the typed lines and approving
checks no other approved pay run has paid. Approving keeps `extra_pay`,
`extra_pay_tax`, `extra_pay_tax_rate`, `extra_pay_method`,
`extra_pay_annualised`, `lump_sum_lowest_rate` and `finish_date` on
`payroll_pay_run_employees`; the EI file reads the indicator and the kept
finish date, and works field 13 out from lines whose item is taxed but not
levied. `notes` on each pay run employee (final pay, extra pay rate) are
worked out, never stored.

**Holidays Act leave** (payroll stage P8, examples HL1-HL42, decisions
7-29 and 138-167, tenant migration 0070). The law is one dated rule-set:
`src/lib/payroll/leave/rules.ts` refuses any pay period starting on or
after 6 Aug 2028 (Employment Leave Act 2026; decision 7). Pure,
browser-safe calculations in `src/lib/payroll/leave/`: `quantity.ts`
keeps balances exactly as hours over unit hours (a week of the usual week,
or a day), so part weeks add up; `work-pattern.ts` (the usual week, OWP
s 8(1), RDP s 9, the pay for time worked on a public holiday);
`earnings.ts` (gross earnings in a window with partial pay periods by
hours, AWE over 12 calendar months, AWE since the start for holidays in
advance, the four-week OWP, ADP); `annual.ts` (anniversaries moved by
unpaid leave, holiday pay, cash-up limits, holiday pay on finishing);
`sick.ts` (sick and family violence balances with carry-over, the hours
test, part days); `public-holiday-dates.ts` (Employment NZ's dates as data)
and `public-holidays.ts` (s 45/s 45A moves per employee, the otherwise
working day suggestion, s 50, the s 40(3) walk). The database side:
`leave-settings.ts` (dated usual week and settings, the organisation's
anniversary region and cash-up policy); `leave-facts.ts` loads one
employee's facts (approved pay runs' gross earnings by period from
`payroll_pay_items.counts_for_holiday_pay`, approved timesheets' hours,
unpaid leave, leave lines on approved pay runs) and works out rates and
balances from them, including whether Tohyee keeps the employee's leave
(decision 143); `leave-records.ts` (bookings, unpaid leave, public holiday
decisions, cash-ups and exchanges with their files in
`payroll_leave_files`, append-only); `leave-pay-runs.ts` works a draft's
usual pay and leave lines out (`workOutLeave()`), saves them
(`updateEmployeeLeave()`, called by `createPayRun()`,
`setPayRunEmployeeLines()`, Update leave and every leave record change via
`updateDraftsCovering()`), and on approval `leaveOutOfDate()` works them
out again and compares. Pay run lines carry `source` (typed, usual_pay,
leave), `regular`, and the leave columns (type, booking, dates, hours,
unit hours, units, in advance, holiday date, cash-up, exchange, basis
JSON); a leave problem is kept on `payroll_pay_run_employees.leave_problem`
and blocks approval like any problem. Balances count only approved pay
runs' lines, so voiding a pay run gives its leave back. `leave-reports.ts`
has balances, the s 81 record (with CSV) and the liability report (with
CSV), which `leave-liability.ts` posts (below). Payslips read the balances at the
period end; the EI file's hours include leave hours. Routes under
`/api/payroll/leave/...`, `/api/payroll/employees/[employeeId]/leave`
(and `/record`) and `/api/payroll/pay-runs/[payRunId]/leave`, all
`withPayrollAccess()`; multipart bodies (cash-ups, agreements) go through
`src/lib/api/json-or-form.ts`. Screens: `src/components/payroll-leave.tsx`
(Payroll › Leave, the employee's leave, the record page) and leave on
`payroll-pay-runs.tsx`.

**Opening leave balances** (HL43-HL48, decision 168, tenant migration
0071): `payroll_leave_opening_balances` (one `current` row per employee; a
replacement marks the old one `replaced`) and its append-only
`payroll_leave_opening_earnings` rows, with the report in
`payroll_leave_files` (purpose `opening_balances_report`). Pure checks and
helpers in `src/lib/payroll/leave/opening.ts`; the service is
`src/lib/payroll/leave-opening.ts` (`/api/payroll/leave/opening`, payroll
access). `loadEmployeeFacts()` reads them into `facts.opening` and puts the
earnings rows into `facts.periods` (marked with `openingDays`) ahead of
Tohyee's own pay periods, so every window calculation uses them unchanged;
`annualDates()` runs from the last entitlement date, `annualBalance()`,
the sick and family violence balances (`sick.ts` takes an opening
balance), `alternativeHolidays()` and `advancePaidSince()` start from them,
`daysWorkedOrPaid()` counts whole rows' days, and `whyLeaveNotKept()` no
longer refuses for decision 143 when they exist. A draft for a pay period
up to the opening date leaves leave alone; one across it is refused.

**Posting the leave liability** (HL52-HL56, decisions 177 and 182-187,
tenant migration 0072): `src/lib/payroll/leave/liability-posting.ts` is
pure (the change by Department since the last posting, and the journal
lines, netted per tracking group); `src/lib/payroll/leave-liability.ts`
runs `leaveLiabilityReport()` at the date, refuses on any row's problem,
compares with the last `active` row of `payroll_leave_liability_postings`
and its append-only `payroll_leave_liability_departments`, and posts one
journal (origin `payroll`, command source `payroll:leave_liability`,
reference LEAVELIAB-n, Department tags on both lines) under an advisory
lock. Voiding only the latest active posting posts the exact reversal
(`payroll:leave_liability_void`); a trigger allows only that change, and
`correctJournal()` refuses these journals. The accounts are
`organisation_settings.payroll_leave_expense_account_id` and
`payroll_leave_liability_account_id`, read and set through
`getPayrollSettings()` / `updatePayrollSettings()` in `pay-items.ts`.
Routes: `/api/payroll/leave/liability/postings` (GET, POST) and
`/postings/[postingId]/void`, `withPayrollAccess()`. Screens: the
Liability tab of `payroll-leave.tsx`, and the accounts on
`payroll-pay-items.tsx`.

**Leave requests** (HL49-HL51, decision 169, migration 0071's
`payroll_leave_requests`): `src/lib/payroll/leave-requests.ts`, routes
under `/api/payroll/leave/requests` with the viewer role, the service
deciding who sees what with `employeeAccess()` from `timesheets.ts`
(decisions 95, 96). Approving calls `createLeaveBooking()` with
`fromApprovedRequest`, the one way a booking is made without payroll
access. Screen: `src/components/payroll-leave-requests.tsx`.

**Payday filing** (payroll stage P6, examples PF1-PF9, decisions 56-65):
`src/lib/payroll/payday-filing.ts` is pure (no database): IRD's employment
information file (HEI2 header, DEI lines, amounts in hundredths, CR LF),
the settings field checks and the due date; the field list and its source
are in `docs/sources/ird-payday-filing-file-spec.md`.
`payday-filing-service.ts` reads an approved pay run's stored snapshot
(`payroll_pay_run_employees`), hours from its lines, and each employee's
IRD number (decrypted only there, after the payroll access check), and
returns the file as text for the browser to save; it writes one audit event
(file name, line count, SHA-256) and posts nothing. The header details are
four columns on `organisation_settings` (tenant migration 0064:
`payroll_employer_ird_number`, `payroll_contact_name`,
`payroll_contact_phone`, `payroll_contact_email`, each with IRD's format as
a check constraint). Routes: `/api/payroll/pay-runs/[payRunId]/payday-filing`
(GET the card, POST make the file) and `/api/payroll/payday-filing-settings`
(PUT admins only).

People who aren't members get "not found", so organisation IDs can't be
probed. Every audit record stores the signed-in user, never a name typed into
a form.

Organisation databases record who did something by email (`created_by_email`
and so on), since users live in the core database. Screens show people by
name: `withOrganisation()` loads the organisation's members' names once per
request (before the transaction) and, after it, adds a name beside every
person's email in the result (`createdByEmail` gets `createdByName`), looking
up anyone who has left in one more query; someone who can't be found (a
deleted user, `cli`, a scheduled job) shows as the email recorded
(`src/lib/people/names.ts`). Names are looked up when read rather than
copied into organisation databases, so a renamed person shows their current
name and posted history is never rewritten. Text written once, like a new
journal's description, uses the name from `tx.people`; journals posted
before this change keep the email they were posted with.

## Financial integrity

Enforced by the database itself, not just the app:

- Every journal balances: deferred constraint triggers check at commit that
  there are at least two lines and that debits = credits = the header totals.
- Each line is either a debit or a credit, never both or neither.
- **Foreign-currency lines** (decided by Jess, 30 Sep 2026, following
  NetSuite; examples FXB1-FXB11): every journal line on an account whose
  currency isn't the base currency, posted since migration 0033, has the
  foreign amount (on the same side as its base amount, so the same
  direction), the currency and the exchange rate (base per 1 unit, up to 8
  decimal places) besides its base debit or credit; a line on a
  base-currency account has none (a `before insert` trigger). `fx_kind`
  says how the base amount came about: `rate` (base = foreign x rate,
  rounded once to cents half away from zero, checked by the trigger),
  `implied` (a transfer in, booked at the base amount that left),
  `carrying_value` (a transfer out) or `revaluation` (foreign amount 0).
  `account_amount` (a generated column) is the line in its account's
  currency, signed like a statement line. Lines posted before 0033 keep
  only their base amount; an account with such lines takes nothing new but
  revaluations until its opening foreign balance is entered
  (`ledger_foreign_opening_balances`: once per account, append-only, the
  account's base balance at that date with a foreign balance of the same
  sign, no postings after the date), and then nothing dated on or before
  it. Nothing but a revaluation is posted to a foreign-currency account
  dated before its latest transfer out. An account's currency can't change
  once it has postings.
- **Foreign-currency documents** (built overnight 1 Oct 2026 following
  NetSuite as Jess asked; migration 0042; examples MC1-MC13, not yet
  approved): `contacts.currency_code` (null is the base currency) is the
  contact's currency; its invoices, bills and credit notes are in it (a
  trigger), and it can't change once it has any (a trigger). A
  foreign-currency document keeps its `exchange_rate` and base amounts
  (`base_subtotal`, `base_tax_total`, `base_total`, and each line's
  `base_net_amount`, `base_tax_amount`: each line converted and rounded
  once, the totals their sums; standard-rated GST is worked out in the
  document's currency and its base GST posted to the GST account with no
  foreign amount, MC71-MC83); a base-currency one has none. Accounts
  receivable and payable stay base-currency accounts, but (like NetSuite's
  A/R and A/P) their lines for foreign-currency documents carry the foreign
  amount and currency: `fx_kind` `document` for the document's own line
  (base = its lines' sum), `carrying_value` for a payment or credit
  clearing it (at the document's carrying value of what's cleared) and
  `revaluation`; the trigger refuses any other foreign amount on them, and
  on other base-currency accounts as before. Payments store their own
  rate, the base amount that moved in the bank account, the base cleared
  and the realised gain (`base_amount - base_cleared` for receivables,
  the other way for payables, posted to 7020); credit note applications
  between foreign-currency documents store both sides' base and the gain,
  with its own journal. A document's open base value is its base total less
  its active settlements' base cleared (`src/lib/fx/documents.ts`).
  Revaluation items are unique per account, currency and date, so accounts
  receivable and payable revalue each currency's open balance.
  Migration 0043 (examples MC14-MC30, not yet approved) adds: a foreign
  payment's `base_overpayment` (its overpayment at the payment's rate,
  `fx_kind` `document` on accounts receivable); the base values and gain of
  overpayment applications (with their own journal) and of refunds
  (`exchange_rate`, `base_amount`, `base_cleared`, `realised_gain`); the
  rate and bank base amount on payments for several documents, whose parts
  must add up to it; SQL helpers for what's open on a foreign document or
  credit (`tohyee_invoice_base_settled` and friends); and a trigger keeping
  quotes, repeating templates and purchase orders (and, from migration
  0055, sales orders) in their contact's currency (they have no rate). Stock is valued in the base currency: a
  foreign line's stock value is its base net amount (`stockLinesAtBase`).
  Migration 0045 (examples MC31-MC43, not yet approved) adds, following
  NetSuite: the system account `fx_rounding` (7050 Rounding gains and
  losses) and a `rounding_gain` on every foreign settlement (payments,
  applications, refunds), whose checks become `realised_gain +
  rounding_gain` = the difference; `realised_gain` is (rate debited - rate
  credited) x amount, rounded once, and the rest is rounding
  (`splitGain` in `src/lib/fx/documents.ts`). It also adds
  `ledger_fx_revaluation_documents` (append-only): a revaluation of
  receivables or payables in a currency revalues each open document at its
  own rate, and the database checks each row's unrealised amount is
  (closing rate - its rate) x its open foreign amount, rounded.
- The currency exchange rates list (MC46-MC53, like NetSuite's Currency
  Exchange Rates) is `currency_exchange_rates`: currency, effective date,
  rate (base per 1 unit) and note, one row per line of a command (one
  idempotency key, `line_number`). A trigger refuses the base currency,
  every change but archiving once, and deletes. `defaultRates` in
  `src/lib/ledger/foreign.ts` is the one lookup behind every default rate
  (documents via `exchangeRateFor`, payments, refunds, statement lines and
  `/api/fx/last-rate`): the list's latest entry effective on or before the
  date, then the last rate used (D4). A foreign repeating template set to
  approve is approved only when the list has a rate for the date
  (`assertListedRateForRepeating`); otherwise the scheduler records the
  refused approval.
- Posted history is append-only: `ledger_journals`, `ledger_journal_lines`,
  `inventory_movements`, `stock_transfers`, FX revaluation runs and `audit_events` reject
  `UPDATE`, `DELETE` and `TRUNCATE`. Corrections are new rows.
- Stock on hand and carrying value can't go negative unless the
  organisation allows negative stock, and that setting can't be turned off
  while anything is below zero (triggers); zero stock has zero value.
- Notes and files (examples NF1-NF14) post nothing. Files are stored in the
  organisation's own database (`record_attachments.content`), so its backup
  includes them; the type is checked from the contents as well as the name.
  `record_notes` and `record_attachments` reject `DELETE` and `TRUNCATE`: a
  deleted note keeps its row, and removing a file clears only its contents
  (and can't be undone). Every add, edit and delete goes to `audit_events`
  with the old text, which is where a record's history comes from.
- Contacts are archived, never deleted: `contacts` rejects `DELETE` and
  `TRUNCATE`, and no two active contacts share a name (ignoring case).
- Sales invoices: only drafts can be changed or deleted. An approved invoice
  can only become voided (and then only its void details change); a voided one
  can't change at all. Lines of approved and voided invoices are frozen, and
  neither table can be truncated. Invoice numbers come from a one-row counter
  that can only move forward by one, so `INV-` numbers have no gaps.
- Customer payments: a payment is recorded against an approved invoice, in
  the invoice's currency and dated on or after it. Its
  overpayment must be exactly what it pays beyond the amount due at that
  moment, so what's settled on an invoice (payments less overpayments, plus
  credit applied) never goes over its total. Payments can't be edited,
  deleted or truncated; the only change allowed is voiding one, once, which
  fills in its void details, and not while its overpayment is applied or
  refunded. An invoice with active payments can't be voided.
- Customer overpayments: applications and refunds follow the credit note
  rules (applied only to other approved invoices of the same customer and
  currency, never more than what's left, removed or voided once, never
  edited, deleted or truncated), and an invoice with overpayment credit
  applied can't be voided.
- Bills: only drafts can be changed or deleted, and a draft can't be voided
  (it's deleted instead). An approved bill can only become voided (and then
  only its void details change); a voided one can't change at all. Lines of
  approved and voided bills are frozen, and neither table can be truncated. A
  unique index stops a supplier having two bills that aren't voided (drafts
  included) with the same supplier invoice number, compared ignoring case and
  spaces. Only a draft can be without a number (B9, migration 0041); approved
  and voided bills always have one (a check constraint), and a repeating bill
  without a number pattern can only save drafts (RB11).
- Supplier payments: a payment is recorded against an approved bill, in the
  bill's currency and dated on or after it, and a bill's active payments plus
  active credit applied can't add up to more than its total. Payments can't be edited, deleted or
  truncated; the only change allowed is voiding one, once, which fills in its
  void details. A bill with active payments can't be voided.
- Payments for several invoices or bills: a batch row holds the date, amount,
  bank account and the one journal; each invoice or bill gets an ordinary
  customer or supplier payment row with the batch's id, sharing that journal
  (so amount due, overpayments, the GST return and bank matching work
  unchanged). The database checks, at commit, that a batch's parts have its
  contact, date, bank account and journal and add up to its amount. A batch
  is voided whole: a part can only be voided once its batch has been, in the
  same transaction, all with the batch's void journal.
- Custom reports: a draft holds its layout (title, columns, tables of rows,
  notes) and its figures are worked out from the ledger each time it's
  opened. Publishing inserts a new row holding the layout and the figures
  worked out at that moment; the database refuses any change to a published
  row except archiving it or bringing it back, and refuses deleting it.
- Budgets (BU1-BU8): every organisation has one overall budget (a unique
  index), which can't be archived. `budgets` and `budget_amounts` refuse
  `DELETE` and `TRUNCATE` (a budget is archived, an amount set to 0.00); a
  budget's tracking value and whether it's the overall one never change;
  amounts are only for revenue and expense accounts and can't change while
  their budget is archived (triggers). Budgets post nothing; budget vs
  actual (`src/lib/reports/budget-vs-actual.ts`) and the custom report
  budget column read them beside the same account totals as the profit and
  loss.
- Expense claims (EC1-EC12): only drafts can be deleted, and receipts only
  change while their claim is a draft. A submitted claim only goes back to
  draft (declined) or to approved; an approved one only to voided, once,
  and not while it has active payments; a voided one never changes. A
  payment needs an approved claim, is dated on or after it, and active
  payments never add up to more than its total; payments are only voided,
  once, and never deleted (triggers). What's paid and due is worked out.
  Approving posts Dr each receipt's account (net) and GST / Cr the account
  marked "Used by Tohyee" for expense claims payable (2010 in the starting
  chart; migration 0028 gave existing organisations one at 2010 or the next
  free code), which bills, bank transactions and receipts can't use.
- Fixed assets (FA1-FA14): registering an asset posts nothing (its cost is
  already in the ledger). `fixed_asset_types`, `fixed_assets`, runs and
  disposals refuse `DELETE` and `TRUNCATE`; a type's accounts can't change
  once it has assets; an asset from a bill line must be on an approved
  bill's line on its type's asset account, and assets from one line never
  cost more than it (excluding GST); a bill with a registered asset can't be
  voided. Once an asset has depreciation or a disposal that counts, only its
  name, description and tracking change, and it can't be archived. Runs are
  to a month end after the latest active run (one active run per month end);
  only the latest can be rolled back, once, and not while an asset it
  depreciated has an active disposal. A disposal is of a registered asset,
  after the latest run, one active per asset, and its figures satisfy cost -
  accumulated + recovered + capital gain - loss = proceeds; it's undone
  once. `fixed_asset_depreciation_lines` (one row per asset per financial
  year a run or disposal charged) never change; a rolled back run or undone
  disposal takes its rows out of the count (triggers). The maths is in
  `src/lib/fixed-assets/depreciation.ts` (browser-safe): whole months, each
  financial year's figure so far rounded once, never below the residual
  value; the rates are typed in by the organisation (no built-in IRD
  rates). Runs, disposals and asset changes take the settings row lock so
  they're worked out one at a time. Run and disposal journals (origins
  `fixed_asset_depreciation`, `fixed_asset_disposal`) are corrected by
  rolling back or undoing, and 7030/7040 (system keys
  `fixed_asset_disposal`, `fixed_asset_capital_gain`; migration 0029 gave
  existing organisations them at those codes or the next free ones) are the
  default gain, loss and capital gain accounts. The register
  (`src/lib/fixed-assets/register.ts`) ties to the ledger per account.
- Projects (PJ1-PJ13) post nothing; only the invoices made from them do.
  `projects`, `project_tasks`, `project_time_entries` and
  `project_expenses` refuse `DELETE` and `TRUNCATE` (tasks are archived,
  time and expense links removed). Time is whole minutes (1 to 1440) with
  the member's staff cost rate copied on. An expense link is an approved
  bill's line, an approved expense claim's receipt or a posted spend money
  line at its net amount, coded to an expense-class account (the service
  refuses balance sheet lines, PJ13), one active link per line (unique indexes), and
  that bill, claim or spend money can't be voided while linked. Invoicing
  inserts `project_invoices` (one per sales invoice, deleted with its draft
  by `on delete cascade`, otherwise never changed) and
  `project_invoice_items`; an item is billed while it's on an invoice that
  isn't voided (`tohyee_project_item_invoice`), and a trigger refuses billing
  it twice, billing time on a task that isn't hourly, and billing anything
  removed, written off or not chargeable. Billed time and expenses can't
  change; a task's charge type and fixed price can't change once it's
  billed; a write-off is never undone. Only closing and reopening change a
  project's status, and closing is refused while
  `tohyee_project_open_item` finds a draft project invoice or anything
  unbilled; a closed project takes no new tasks, time, expenses or
  invoices, and its invoices can't be voided or deleted. Figures and the
  time report are worked out in `src/lib/projects/service.ts` (maths in
  the browser-safe `amounts.ts`): time cost and charges are minutes x rate
  / 60 rounded to the cent, markups cost x (100 + %) / 100.
- Purchase orders (PO1-PO9): only drafts can be changed or deleted. An
  approved one can only become cancelled (and then only its cancel details
  change), and only while no bill that isn't voided names it; its lines are
  frozen, and none of the tables can be truncated. `PO-` numbers come from
  their own one-row counter that only moves forward by one, so they have no
  gaps. A bill's `purchase_order_id` must be an approved purchase order from
  the bill's supplier and never changes; a bill line's
  `purchase_order_line_id` must be a line of that purchase order with the
  same item and unit, and the lines on bills that aren't voided never add
  up to more than the purchase order line's quantity (triggers). Whether a
  purchase order is billed is worked out from its bills, never stored.
- Sales orders (SO1-SO12, migration 0055, following NetSuite): only drafts
  can be changed or deleted. An approved one can only become closed (not
  while a draft invoice names it) or cancelled (only while no invoice that
  isn't voided names it), and then only those details change; its lines
  are frozen, and none of the tables can be truncated. `SO-` numbers come
  from their own one-row counter, so they have no gaps. An invoice's
  `sales_order_id` must be an approved sales order to the invoice's
  customer and never changes, nor does the customer; an invoice line's
  `sales_order_line_id` must be a line of that order with the same item and
  unit, and the lines on invoices that aren't voided never add up to more
  than the order line's quantity (triggers; saving a linked invoice locks
  the order first, and so does the trigger, so two invoices can't both take
  the last of a line). A quote's
  `sales_order_id` is set when it's accepted as an order (an accepted quote
  has an invoice or a sales order, not both). What's invoiced per line and
  the status (pending billing, partly billed, billed) are worked out from
  approved invoices in SQL each time they're read
  (`src/lib/sales-orders/service.ts`), never stored; only closed and
  cancelled are stored, as decisions. Sales orders post nothing and touch
  no stock; cost of sales stays on invoice approval until deliveries exist.
- Sales credit notes: only drafts can be changed or deleted, and a draft can't
  be voided (it's deleted instead). An approved credit note can only become
  voided (and then only its void details change); a voided one can't change at
  all. Lines of approved and voided credit notes are frozen, and none of the
  credit note tables can be truncated. Credit note numbers come from their own
  one-row counter that can only move forward by one, so `CN-` numbers have no
  gaps.
- Credit note applications and refunds can't be edited or deleted; the only
  change allowed is removing an application, or voiding a refund, once, which
  fills in its removal or void details. An application needs an approved
  credit note and an approved invoice of the same customer and currency, and
  is dated on or after both. For every invoice, active payments plus active
  credit applied can't add up to more than its total; for every credit note,
  active applications plus active refunds can't add up to more than its total.
  An invoice with active credit applied, or a credit note with active
  applications or refunds, can't be voided.
- Supplier credit notes work the same way on the bills side: only drafts can
  be changed or deleted, an approved one can only become voided, lines of
  approved and voided ones are frozen, and none of their tables can be
  truncated. There's no Tohyee number; a unique index stops a supplier having
  two supplier credit notes that aren't voided (drafts included) with the same
  supplier's credit note number, compared ignoring case and spaces.
  Applications need an approved supplier credit note and an approved bill of
  the same supplier and currency, dated on or after both, and can only be
  removed once; refunds can only be voided once. For every supplier credit
  note, active applications plus active refunds can't add up to more than its
  total. A bill with active credit applied, or a supplier credit note with
  active applications or refunds, can't be voided.
- Filed GST returns (`gst_returns` with its `gst_return_adjustments` and
  `gst_return_lines` snapshot) can't be edited, deleted or truncated, and
  adjustments and lines can only be added while the return is being filed.
  A return covers 1, 2 or 6 whole calendar months, its boxes must follow the
  GST101A arithmetic (Box 7 = 5 - 6, Box 8 = Box 7 x 3 / 23, and so on), and
  at commit its adjustments and lines must match its counts and Box 5, 6, 9,
  11 and 13 totals. An exclusion constraint stops two filed returns covering
  the same day.

Enforced by the app (and covered by tests):

- Money is exact decimal (BigInt), never floating point. Posted amounts use
  exactly the base currency's minor units (cents for NZD).
- Journals are posted in the organisation's base currency: their debits and
  credits (and so the trial balance) are always in the base currency. Lines
  on foreign-currency accounts carry the foreign amount too (above;
  `src/lib/ledger/journals.ts` checks it, `src/lib/ledger/foreign.ts` works
  out foreign balances, opening balances, carrying values and the last rate
  used). A manual journal line on a foreign-currency account gives
  `foreignAmount` and `exchangeRate`. Foreign-currency invoices, bills and
  payments aren't supported yet.
- FX revaluation takes an account's foreign balance from the ledger when
  it's known (FXB7; a typed one must agree) and the typed one otherwise
  (F1-F7 for accounts with base-only postings and no opening foreign
  balance). Its lines on the account have a foreign amount of 0 at the
  closing rate.
- Idempotency: every command carries an idempotency key. A retry with the
  same key and content returns the original result; the same key with
  different content is refused (409). The key check happens before anything
  is recalculated, so retries still work after a period is locked.
- Period close (YE1-YE4, PC1-PC12): the lock date in
  `accounting_period_controls` is the last day closed. Closing a month runs
  its checklist (`src/lib/ledger/period-close.ts`, worked out from the books,
  posting nothing) and moves the lock to the month end; reopening moves it
  to the day before the month, reopening every later month (NetSuite's
  rule). Both take the controls row lock and write an audit event (with the
  warnings accepted, or the reason). A trigger on `ledger_journals` refuses
  journals dated on or before the lock date, reading the row `for share`, so
  a close waits for postings in progress. There are no closing journals:
  the balance sheet works out current year earnings and retained earnings
  (the retained earnings account plus earlier years' profit) when it runs.
- Journals made by stock movements, FX revaluations, sales invoices,
  customer payments, sales credit notes, credit note refunds, bills,
  supplier payments, supplier credit notes, supplier credit note refunds,
  expense claims or their payments, depreciation runs or asset disposals
  can't be corrected in the ledger; they are corrected at their source (an
  invoice, payment, credit note, refund, bill or expense claim is voided) so
  the sub-ledgers stay in step.
- Sales invoices post to the accounts marked "Used by Tohyee" for accounts
  receivable and GST (1100 and 2100 in the starting chart), so those can't be
  archived. Invoice amounts are worked out in one place
  (`src/lib/invoices/amounts.ts`), which the editor also uses for its live
  totals.
- Customer payments debit an active, base-currency account of type `bank`
  and credit the accounts receivable account above, for the full amount
  received. The part beyond the invoice's amount due is stored once, as the
  payment's overpayment; it stays in accounts receivable as credit for the
  customer, and applying it posts no journal while refunding it posts
  Dr accounts receivable / Cr the bank account (`src/lib/invoices/overpayments.ts`).
  An invoice's amount paid, amount due and paid status (`unpaid`,
  `part_paid`, `paid`), and what's left of an overpayment, are worked out
  from active payments, applications and refunds whenever they're read; they
  are never stored.
- Sales credit notes use the invoice line maths and post the mirror of an
  invoice (Dr revenue and GST / Cr accounts receivable). Applying credit to
  invoices posts no journal, since both sides are accounts receivable, but
  period locks still apply to its date and its removal date. Refunds credit an
  active, base-currency account of type `bank` and debit accounts receivable.
  A credit note's amount applied, amount refunded, remaining credit and credit
  status (`open`, `part_used`, `used`) are worked out whenever it's read; they
  are never stored.
- Bills debit each line's account for its amount excluding GST, debit GST and
  credit the account marked "Used by Tohyee" for accounts payable (2000 in the
  starting chart), so it can't be archived either. Bill lines go to active,
  base-currency accounts of type expense or direct costs, or to asset
  accounts other than bank and accounts receivable; the accounts payable and
  GST accounts are refused (`src/lib/bills/accounts.ts`, which the editor also
  uses to filter its account list). Bill amounts are worked out with the same
  code as sales invoices.
- Supplier payments debit the accounts payable account above and credit an
  active, base-currency account of type `bank`. A bill's amount paid, amount
  due and paid status (`unpaid`, `part_paid`, `paid`) are worked out from its
  active payments and active credit applied whenever it's read; they are
  never stored.
- Supplier credit notes use the bill line rules and maths and post the mirror
  of a bill (Dr accounts payable / Cr the line accounts and GST). Applying
  credit to bills posts no journal, but period locks still apply to its date
  and its removal date. Refunds received debit an active, base-currency
  account of type `bank` and credit accounts payable. Remaining credit and
  credit status are worked out whenever they're read; they are never stored.
- The GST return is worked out from documents, not postings, line by line,
  by the tax code's category (`src/lib/reports/gst-return.ts`; the box maths,
  settlement shares and basis-change adjustment are in
  `src/lib/reports/gst-boxes.ts`). On the invoice basis sales invoices, sales
  credit notes, bills and supplier credit notes count on their own date when
  approved and the other way on their void date. On the payments basis they
  count when settled (payments, credit applications, refunds, overpayments
  applied, and their voids and removals), each settlement counting every line
  in proportion; the hybrid basis does sales the invoice way and purchases
  the payments way. Bank transactions count on their date on every basis. Expense
  claims count like bills (on the claim and void dates, or when paid), each
  receipt's supplier and description as the line, with no contact.
  Box 8 and Box 12 are worked out from the box totals (x 3 / 23, rounded
  once), so they can differ from the lines' own GST by rounding.
  Standard-rated lines at a rate other than 15% are refused. A filed return
  keeps its basis and is always worked out again on it. A change of basis is
  found from the filed returns, and the IR546 debtors/creditors adjustment is
  suggested, never added on its own. Filing takes a lock on the settings row
  so returns are filed one at a time.
- Bank statements: statement lines are what the bank says, stored as money in
  positive and money out negative. They can't be deleted or edited (only
  reconciled, excluded, or deleted with their whole import), and importing
  never posts anything. A reconciliation links a line to journal lines on the
  same account that add up to it exactly (checked at commit by a deferred
  trigger); a journal line can be in only one active reconciliation, and a
  reconciled journal can't be voided or reversed until it's unreconciled.
  The one exception is a split (BK26-BK28, `bank_reconciliation_splits`):
  several statement lines each reconciled to part of one journal line (same
  sign, smaller), the parts adding up to it exactly with nothing else on
  it, and the split's reconciliations all active or all removed (checked at
  commit), so its lines are only ever reconciled and unreconciled together.
  Spend and receive money (`bank_transactions`) post like a bill or an
  invoice without the payable or receivable, and count in the GST return on
  their date (spend as purchases, receive as sales). Transfers post
  Dr to / Cr from between two bank or card accounts.
- Foreign-currency bank and card accounts (FXB1-FXB11): statement lines
  record their currency (`bank_statement_lines.currency_code`, which a
  trigger keeps equal to the account's; a file saying another currency is
  refused) and are reconciled against journal lines' `account_amount`
  (the trigger requires lines with foreign amounts). Each line shows its
  base value at the exchange rates list's rate in effect on its date, or
  else the last rate used for its currency on or before its date (a rate or
  implied line, or a revaluation's closing rate; by date, then the latest
  entered). Spend and receive money store the rate, the base
  total and each line's base amounts (what the GST return and project
  costs count), and allow only zero-rated, exempt and no-GST codes; split
  lines must add up after each is rounded. Transfers to and from a
  base-currency account store both amounts; out of a foreign account the
  money leaves at its carrying value (base balance x amount / foreign
  balance, rounded once; all that's left takes the whole base balance) and
  the difference goes to the account with system key `realised_fx` (7020,
  migration 0033). Invoices and bills can't be paid from these lines,
  adjustments aren't available, transfers between two foreign accounts are
  refused, and Akahu feeds can't be linked (Akahu's transactions have no
  currency).
- Bank feeds (Akahu) are read outside any database transaction: a sync reads
  what to fetch in one short transaction, calls Akahu, then adds new lines in
  a second. Feed lines carry Akahu's transaction id, so a line is never added
  twice; lines that match a file line on date and amount are flagged as
  possible duplicates rather than skipped.
- Tracking categories (advanced features): `tracking_categories` and a tree
  of `tracking_values` per organisation. Lines store their tags as a jsonb
  map `{categoryId: valueId}` (`tracking` on document lines and
  `ledger_journal_lines`); a trigger checks every value exists and belongs to
  its category, and values can't be deleted or put under their own children.
  Posting groups document lines into journal lines by account and tags, so
  AR, AP, GST and bank lines are never tagged. Empty tags are left out of
  idempotency hashes, so requests from before tracking hash the same.
  Required categories are checked when approving or posting (not on drafts),
  and only on income and expense lines. The rules are in
  `src/lib/tracking/service.ts`. Custom segments are tracking categories of
  kind `custom`; only they can be archived.
- Custom fields: `custom_fields` (type and what it's on fixed by a trigger)
  and `custom_field_options`, neither deletable. Values are a jsonb map
  `{fieldId: value}` in a `custom_fields` column on contacts, the document
  tables, their line tables and `ledger_journals`/`ledger_journal_lines`
  (manual journals only); a trigger checks every key is a field for that
  kind of record, and `src/lib/custom-fields/` checks types, options and
  required fields. They never reach posting, reports or the GST return.
  `custom_field_sections` (tenant migration 0053) are named, ordered groups
  per kind of record (contact, document, person, opportunity); a field's
  `section_id` must be a section for its own kind (trigger). CRM people and
  opportunities have their own `custom_fields` column (kinds `person` and
  `opportunity`), and contact fields can be used on prospects (the
  migration leaves existing fields where they were). Each use needs its
  module: prospects, people and opportunities need the CRM switch,
  everything else Advanced reporting; with the switch off, kept values stay
  but new ones are refused. Setting up a field needs the switch for each
  place being added, and otherwise for one of the places it's already on.
- Apps: Accounting (with Tax) is under `/operations`, the CRM under `/crm`.
  Each has its own layout (`src/app/operations/layout.tsx`,
  `src/app/crm/layout.tsx`) that loads the signed-in user and their
  organisations the same way (`src/lib/auth/page-workspace.ts`) and renders
  `AppShell` for its app, with the app switcher
  (`src/components/app-switcher.tsx`). The CRM is a sibling of `/operations`
  rather than a nested layout because a nested layout can only add to the
  accounting shell, not replace it. Old `/operations/crm/...` URLs redirect
  (307, query kept) in `next.config.ts`. The CRM's Home reads
  `GET /api/crm/home` (viewer), which uses `tx.actor`, never the request, for
  whose work to show.
- Modules: `organisation_settings.crm_enabled` and `advanced_features`
  (Advanced reporting). The CRM's tables are `crm_people`,
  `crm_opportunities`, `crm_tasks` and `crm_activities` (none deletable);
  companies are `contacts`, which can be prospects (`is_prospect`). Owners
  and assignees are user ids from the core database, checked against the
  organisation's members when set. An opportunity's `invoice_id` is set once
  and a trigger keeps it in its (Closed won) stage from then on. The rules are in
  `src/lib/crm/service.ts`; only the invoice it makes ever reaches the ledger.
- CRM record types (tenant migration 0059, CRT1-CRT13): `crm_record_types`
  holds each type's kind (`contact`, `person` or `opportunity`), name,
  default flag, order and its page layout as JSON (sections, each with
  ordered `{ key, required, readOnly }` fields; keys are standard field
  names or `custom:<id>`). Types are never deleted and never change kind
  (trigger); one default per kind (partial unique index). `contacts`,
  `crm_people` and `crm_opportunities` have a not-null `record_type_id`
  (existing rows got the default; a trigger fills in the default on insert
  and refuses a type of another kind); `contacts.owner_user_id` is the
  company's owner (a member, checked like other CRM owners). The pure
  layout rules (standard fields per kind, locked and system fields,
  normalising a layout) are in `src/lib/crm/record-types/layout.ts`; the
  service (`src/lib/crm/record-types/service.ts`) checks a save against
  the record's type: required fields must be filled in (server-side, on
  every save of that record, stage moves included, only while the CRM is
  on) and read-only ones are refused (403) for anyone below admin. A new
  custom field joins every layout of its kind. Type changes and inline
  edits go into the record's history like other CRM changes. The record
  page (`src/components/crm-record-page.tsx`) reads
  `GET /api/crm/companies/:id`, `/api/crm/people/:id` and
  `/api/crm/opportunities/:id` (viewer) and saves one field at a time with
  the existing PATCH routes; `src/lib/crm/record-page.ts` holds its pure
  grouping (layout sections, upcoming and overdue, past activity by NZ
  month). Record types are set up through `/api/crm/record-types` (GET
  viewer; POST and PATCH admin).
- CRM stages and forecasts (tenant migration 0066, CRMS1-CRMS11, decisions
  76-90): `crm_opportunity_stages` holds the organisation's stages (a fixed
  `key`, name unique ignoring case, `sort_order`, `stage_type` open / won /
  lost, a whole-per-cent `probability`, `forecast_category`, `is_active`).
  Check constraints keep a won stage 100% Closed, a lost one 0% Omitted and
  an open one out of Closed; triggers refuse deleting a stage, changing its
  key, or changing its type while opportunities are in it, and a deferred
  constraint trigger keeps one active stage of each type. The upgrade made
  the six old stages the starting rows with their old keys, so
  `crm_opportunities.stage` (now a foreign key to the key instead of a
  check) didn't change. Opportunities got `probability` and
  `forecast_category` (filled from the stage on insert when missing); a
  trigger enforces the stage type's rules and that only an opportunity in a
  Closed won stage has an invoice, and the old guard now keeps an invoiced
  opportunity in whatever stage it was in. `crm_record_types.stage_keys`
  (opportunity types only, null = every active stage) is the sales
  process. `crm_forecast_quotas` holds one quota per owner per month (base
  currency). The pure rules (stage and opportunity rules, weighted
  amount rounding, cumulative rollups, periods of the financial year,
  attainment) are in `src/lib/crm/forecast-figures.ts` (browser-safe); set-up
  and the stage choice for a save (archived and sales-process checks) in
  `src/lib/crm/stages.ts`; the forecast and quotas in
  `src/lib/crm/forecast.ts`, worked out live from the opportunities. Stage
  history is read from `audit_events` (opportunity created and updated
  events now carry probability and forecast category). Routes:
  `/api/crm/stages` (GET viewer, POST admin), `/api/crm/stages/:id` (PATCH
  admin), `/api/crm/sales-processes/:recordTypeId` (PUT admin),
  `/api/crm/forecasts` (GET viewer) and `/api/crm/forecasts/quotas` (PUT
  admin); the opportunity routes take `probability` and `forecastCategory`
  (bookkeeper) and the opportunity's GET returns `stageHistory`.
- CRM mail sync: the organisation's Google/Microsoft app is in
  `crm_mail_settings` (secrets encrypted with TOHYEE_SECRET_KEY); each
  member's mailbox in `crm_connected_accounts` (tokens encrypted). OAuth uses
  a one-time state (`<organisation>.<random>`, 15 minutes, tied to the
  signed-in user) and the address the request came in on for the redirect.
  A sync reads what's due in one short transaction, calls Google or
  Microsoft Graph with nothing open, then writes in a second: only messages
  and events with a known participant go into `crm_messages` /
  `crm_calendar_events`, linked through `crm_participant_links`.
  Disconnecting deletes those rows. Every 15 minutes, off with
  TOHYEE_MAIL_SYNC_SCHEDULER=off. The code is in `src/lib/crm/mail/`.
- Sales platform connections (SPC1-SPC10, migration 0056; not tried against
  a real store): a connector framework in `src/lib/sales-platforms/`
  (`connector.ts` is what each platform provides; `shopify.ts` is the first,
  on the Admin GraphQL API 2026-07 with only `read_customers` and
  `read_products`; `service.ts` decides what happens in Tohyee; `merge.ts`
  has the field rules). `sales_platform_connections` holds each store's
  credentials as encrypted JSON (TOHYEE_SECRET_KEY), a short-lived access
  token (encrypted) when the app hands those out, status, the last sync and
  error, and how far each kind has been synced. `sales_platform_mappings`
  links a platform record (customer, variant) to a contact or item, unique
  both ways per connection, with the values last copied, so a value
  someone changed in Tohyee is kept (and logged) rather than overwritten.
  `sales_platform_sync_log` is append-only (triggers) and readable by
  viewers. Like mail sync, connecting, testing, syncing and disconnecting
  read in one short transaction, call the store with nothing open, then
  write in a second, which locks the connection row and checks it's still
  connected. Each record is applied in a savepoint, so a bad one is logged
  as failed and the rest carry on. Webhooks are verified before any
  transaction; the delivery id goes into `sales_platform_webhook_deliveries`
  (primary key) in the same transaction as the changes, so a repeated
  delivery does nothing. Webhook subscriptions are set up all or none (if
  one topic is refused, the ones already made are removed again), and
  subscriptions made after the connection was disconnected or set up by
  another request are removed rather than saved. Contacts and items are made through
  `createContact` / `createItem` (source `sales-platform`, an idempotency
  key per platform record) and changed through `updateContact` /
  `updateItem`, so the usual checks and audit apply. Nothing posts to the
  ledger. Disconnecting deletes the mappings and the credentials and keeps
  the contacts, items and log.
- Salespeople: `salespeople` (never deleted), `contacts.default_salesperson_id`
  and `salesperson_id` on `sales_invoices` and `sales_credit_notes`, fixed
  with the rest of the document once approved. Sales by salesperson reads
  the documents (subtotals excluding GST), not the ledger. The rules are in
  `src/lib/salespeople/service.ts` and `src/lib/reports/sales-by-salesperson.ts`.
- Richer customers (RC1-RC12): `payment_terms` (for every organisation),
  `customer_groups` and `price_levels` (none deletable), and on `contacts`
  `delivery_address`, `payment_term_id`, `credit_limit`, `customer_group_id`,
  `price_level_id` and `parent_contact_id`; `postal_address` is the billing
  address. A trigger keeps parent customers loop-free, at most 4 levels, and
  both sides customers. Contact people are `crm_people` (one `is_primary` per
  company, a unique index). A new invoice without a due date gets it from
  the customer's terms (`src/lib/customers/terms.ts`, shared with the
  editor). Approving an invoice locks the customer and compares their
  receivables balance, worked out from the documents, plus the invoice with
  the credit limit (`organisation_settings.credit_limit_action`: warn or
  block). Aged receivables reads the same documents as at a date
  (`src/lib/reports/aged-receivables.ts`), never the ledger, and ties to it.
- Products and services (IT1-IT9): `items` (code unique ignoring case,
  never deleted), `item_units` (a fixed multiple of the base unit; the
  database refuses changing a unit's size or deleting it),
  `item_level_prices`, `item_suppliers` (one preferred, a unique index) and
  `kit_components` (a trigger keeps kits out of kits and parts out of being
  kits). Invoice, bill and credit note lines have `item_id`, `unit_id` and
  `base_quantity`; a trigger checks the unit is the item's and that the base
  quantity is exactly quantity x the unit's size. What picking an item fills
  is worked out in one place (`src/lib/items/pricing.ts`, shared with the
  editors); the server fills blank fields on item lines the same way
  (`src/lib/items/lines.ts`) and otherwise treats the line exactly as
  before, so amounts, GST and journals don't depend on items. Units, level
  prices, supplier prices and kits can only be given new values while
  Advanced reporting is on; an item keeps them when it's turned off.
- Stock tracking (ST1-ST12, `src/lib/inventory/stock.ts`): balances are per
  item code and location (`inventory_item_balances`, unique ignoring a null
  location). Approving a bill, invoice or credit note with stock items locks
  each balance it touches, costs the movements with `./costing` and adds
  their lines to the document's own journal (cost of sales tagged like the
  line, inventory untagged), then records `inventory_movements` with the
  document as their source and the journal's id. A void undoes them newest
  first (`reversal` movements): stock that went out comes back at the value
  it went out at; stock that came in goes back out exactly, and only if
  nothing has moved there since (otherwise refused, since later movements
  would need re-costing). Credit notes returning stock name the invoice it
  came from (`return_invoice_id`) and restock at those sales' cost. Stock
  lines on bills and supplier credit notes must be on the inventory account
  and nothing else can be (bills, manual journals, corrections and stock
  movements are all checked), so stock equals the account to the cent.
- Stock transfers (TR1-TR6, `src/lib/inventory/transfers.ts`): the planner
  takes the quantity out of the from-location as an issue (average,
  negative stock setting, backdating check) and into the to-location at the
  same value, refusing a to-location below zero. One journal (origin
  `inventory`) posts Dr inventory tagged with the to-location / Cr
  inventory tagged with the from-location, since bills tag inventory lines
  by Location; the account's total is unchanged. `stock_transfers` is
  append-only, and a check ties `transfer_out`/`transfer_in` movements to
  source type `transfer`.
- Bringing in existing books (IM1-IM21, `src/lib/import/`): each file's
  rows go through the ordinary services (accounts, contacts, items, stock
  movements) inside one savepoint per file and one per row, so every rule
  still applies; any refused row rolls the whole file back, and a check runs
  the same way and always rolls back. Opening balances are one command
  (`importConversion`): the trial balance posts as one journal of origin
  `opening_balance` (not correctable in the ledger) with its accounts
  receivable, accounts payable and inventory lines on the account with
  system key `conversion_clearing` (3900 Opening balance, equity, in
  the starting chart; migration 0036 changed an unused 2990 Conversion
  clearing over); open invoices and bills are approved documents flagged
  `is_opening_balance` (their own number, no INV sequence; migration 0034),
  carrying the GST in what's still owed on one line (two when it's less
  than 3/23, `opening-gst.ts`; inclusive or no-GST amounts, migration 0036),
  posting Dr AR / Cr clearing and Dr clearing / Cr AP of the amount
  including GST (the GST is already in the trial balance's GST line), and
  stock comes in as receipts at its value against clearing, all dated the
  conversion date. The command refuses unless the trial balance balances and
  AR, AP and inventory equal their documents; it leaves clearing at 0.00.
  `conversion_balances` (one row, append-only) and its lines keep the
  imported trial balance for the final check, which also shows how the GST
  line splits. In the GST return, approving or voiding an opening invoice or
  bill never counts, but its settlements do on the bases that count them
  (the same proportional shares as any document); sales by salesperson
  leaves them out, the invoice counter passes over INV-numbers they use, and
  the bank reconciliation report and matching leave the opening journal out.
- Ledger and document reports (AGP, ATX, JR, GA, CST) store nothing and
  post nothing. Aged payables (`src/lib/reports/aged-payables.ts`) and
  customer statements (`customer-statements.ts`) read the documents as at a
  date, like aged receivables, sharing the ageing maths in `ageing.ts`.
  Account transactions and the journal report read `ledger_journal_lines`
  and find each journal's source from the documents' journal columns
  (`journal-sources.ts`); who posted a journal is its `created_by_email`, shown by name.
  The GST audit report (`gst-audit.ts`) only groups the GST return's own
  counted lines (`calculateGstReturn`, or a filed return's stored lines),
  so it can't disagree with the return.
- IRD payroll rates (PR1-PR16, payroll stage P2) are national figures, the
  same for every organisation, so they're versioned data in the code
  (`src/lib/payroll/rates/`, one file per edition of IRD's Payroll
  Calculations and Business Rules Specification), not a table in the core or
  an organisation's database: no migration. Each value has its own
  from/to dates and a source (section and page), and each edition records
  the IRD documents' names, editions, URLs, read dates and SHA-256 hashes.
  `payrollRatesOn(payDate)` picks the values in effect on the pay date and
  refuses dates no edition covers. The calculations
  (`src/lib/payroll/calculations.ts`: PAYE, ACC earners' levy, student loan,
  KiwiSaver, ESCT) are pure functions (no database, no network) and
  truncate as IRD's rules say, using `truncate` and `divideTruncated` in
  `money/decimal.ts`. Adding a year is a new data file: see the README in
  that folder. Pay runs (P3) call them through `calculateEmployeePay()`.
- R&D Tax Incentive records (RDTI stage R2, `src/lib/rd/`, migration 0060)
  post nothing and change no amount. They're contemporaneous records
  (decision 38), so the database does the stamping: `created_at` and
  `updated_at` come from `now()` in triggers whatever an insert says, the
  user comes from the session (`tx.actor`), and every version goes to
  `rd_history` (append-only, its time forced by the database). A tag's
  line, work date (the document's date) and line amount can't change; the
  "entered late" flag compares the day it was entered, in the business time
  zone, with the work date (more than 14 days). Tags point at bill lines,
  expense claim receipts, spend money lines and journal lines through
  nullable columns checked by a trigger (`tohyee_check_rd_tag_source`)
  rather than foreign keys, as fixed assets do, so those tables keep their
  own protections. Amounts come from the documents in base currency at the
  document's rate, excluding GST; shares use `divideTruncated` so they're
  rounded down to the cent. `rd_files` keeps every version (no delete; a
  replacement points back at the version it replaced; decision 45). Approvals
  need at least one activity and an approval letter, checked by a deferred
  constraint trigger. `payroll_cost_allocation_lines.rd_activity_id` is a
  foreign key to `rd_activities`. R&D screens aren't behind payroll access
  and never show an individual's pay, except the claim report's pay section
  for people with payroll access.
- The R&D claim report (RDTI stage R3, `src/lib/rd/claim.ts`, migration
  0065) is read-only and computed each time it's opened. The arithmetic is a
  pure, browser-safe function (`claim-figures.ts`: the overseas limit, the
  minimum and maximum, the credit, per-project return figures, all rounded
  down with `divideTruncated`), as are the due dates and reminders
  (`deadlines.ts`). `claim.ts` collects what counts from tags
  (`loadTags`), asset tax depreciation (`assetSharesForYear`), overhead rules
  (`overheads.ts`, applied to the same posted lines tags use, through the
  exported `SOURCES` query, skipping lines with their own tag) and pay
  (`payroll.ts`: approved pay runs' postings, split by the shares each pay
  run kept (payroll P9): a timesheet share counts, an allocation share only
  when the allocation is 100% R&D; each R&D share is the cost × weight ÷
  all weights, rounded down. Pay runs approved before P9 kept no shares and
  use the allocation in force on the pay date that was entered before the
  pay run was approved. Either way a later timesheet or backdated
  allocation never changes a posted pay; timesheets approved after their
  pay run are listed). The route decides
  whether the viewer gets each employee's pay (`hasPayrollAccess` and
  bookkeeper or above) and reminders (admins); without payroll access pay is
  folded into totals before it leaves the server. An export writes the
  summary figures to `rd_history` (record type `claim_export`), never a file
  with anyone's pay. Overhead rules are stamped and guarded like other R&D
  records: a deferred trigger requires the workings file, and only the end
  date or the "replaced" mark can change.
- Dates are plain `YYYY-MM-DD` strings end to end (the `pg` DATE parser is
  overridden), so there are no time-zone shifts.

See `docs/ACCOUNTING-EXAMPLES.md` for the worked examples these rules are
tested against.

## Remote access

Remote access (use Tohyee from anywhere) has three ways, one on at a time,
recorded in the `remote_access` server setting as its `method`:

- `tohyee`: a Tohyee address. The server asks the Tohyee address service
  (`src/lib/remote/address-service.ts`; `TOHYEE_ADDRESS_SERVICE_URL`) for an
  address and a Cloudflare tunnel token, sending the main port, the app
  version and a random install id kept encrypted in the `address_service`
  setting (whoever has it can ask for the same address). The token and the
  release key are stored encrypted. The service only hands out addresses;
  requests go through Cloudflare's tunnel straight to this computer.
- `cloudflare`: a tunnel on the owner's own Cloudflare account, made by the
  Windows server app (`cloudflared tunnel login/create/route dns/token`) or
  in Cloudflare's dashboard; the server is given its token.
- `tailscale`: Tailscale Funnel, run by Tailscale's own Windows service; the
  server only records that it's on and its address.

For the first two the server runs Cloudflare's `cloudflared` connector as a
child process (`src/lib/remote/tunnel.ts`):
`cloudflared tunnel run --url http://127.0.0.1:<port>` with the token in
`TUNNEL_TOKEN`. Tunnels made in the dashboard (or by the address service) get
their routes from Cloudflare, which replace `--url`; a tunnel made with
`cloudflared tunnel create` has none, so `--url` is what sends its address to
Tohyee. Nothing is opened on the router and Cloudflare provides HTTPS.
Requests arrive with `X-Forwarded-Proto: https`, so session cookies are
`Secure`. The connector is started at boot when remote access is on
(`TOHYEE_REMOTE_ACCESS=off` stops that), restarted with growing waits if it
stops, and its status comes from its own `/ready` endpoint. The Windows
installer and the Docker image include a pinned, checksum-verified
`cloudflared`; elsewhere set `TOHYEE_CLOUDFLARED_PATH` or put it on the
`PATH`. Emailed links use the saved public address rather than the request's
Host header.

## Background work

The only background job so far is the bank feed sync: every 15 minutes the
server checks each ready organisation for linked accounts not synced in the
last few hours (the organisation's "sync every" setting) and syncs them one at a time
(`src/lib/bank/akahu/sync.ts`, started from `src/instrumentation.ts`; set
`TOHYEE_BANK_FEEDS_SCHEDULER=off` to stop it). A failure is kept on the
account and shown on its Bank feed tab, and the next run tries again. It makes
no network calls inside a database transaction and re-resolves each
organisation from the registry.

The repeating invoices and bills job (`src/lib/repeating/scheduler.ts`,
started from `src/instrumentation.ts`; `TOHYEE_REPEATING_INVOICES_SCHEDULER=off`
stops both) runs two minutes after start-up and then hourly: for each ready
organisation, each active template runs in its own transaction and makes
every scheduled date up to today not yet made (examples RI1-RI10,
RB1-RB10). The rules live once in `src/lib/repeating/runner.ts`; each
document type is a `RepeatingKind` that says how to make and approve one
(`service.ts` for invoices, `bills.ts` for bills). Each date made is a row
in `repeating_invoice_runs` or `repeating_bill_runs`, unique on (template,
date), and the template row is locked while it runs, so overlapping runs,
restarts or a second server process never make a date twice. An error is
kept on the template and that date is tried again next run. No network
calls.

The email job (`src/lib/email/outbox.ts`, started from
`src/instrumentation.ts`; `TOHYEE_EMAIL_OUTBOX=off` stops it) sends the
documents people ask to email, from each organisation's own account
(`organisation_email_settings`): an SMTP account (password encrypted with
TOHYEE_SECRET_KEY like other secrets), or a Microsoft 365 / Outlook mailbox
an admin signed in to (`microsoft.ts`, migration 0037). The Microsoft
sign-in is the OAuth 2.0 authorization code flow with the organisation's own
Microsoft app registration (`crm_mail_settings`, shared with the CRM's mail
sync, which doesn't need the CRM on) and the delegated Mail.Send scope; the
refresh token is stored encrypted and replaced whenever Microsoft issues a
new one, the access token is renewed outside any transaction, and emails go
through Microsoft Graph's `POST /me/sendMail` (202 is "sent"; attachments
over 3 MB in all are refused, since larger ones need an upload session).
A Gmail or Google Workspace mailbox (`google.ts`, migration 0044) works the
same way with the organisation's own Google OAuth client (also in
`crm_mail_settings`), asking only for `gmail.send` plus `openid` and
`userinfo.email` (the Gmail profile doesn't accept gmail.send, so the address
comes from OAuth2 v2 userinfo); a sign-in whose granted scopes lack gmail.send
is refused. The message is written by nodemailer's own composer from the same
options as SMTP (`composeRawMessage`, stream transport) and uploaded as
`message/rfc822` to the Gmail API's `users.messages.send` media endpoint
(`uploadType=media`, 36,700,160 bytes at most per Google's discovery
document; bigger is refused before sending); 200 with the message id is
"sent". Each sign-in state records its provider, so one can't be finished at
the other's callback. Disconnecting a mailbox falls back to the method in use,
then SMTP, then the other mailbox.
`sender.ts` hides which it is from the job and the test email. Every email
has an HTML part (`html.ts`: escaped text, a summary box, the contact
details, and the logo as an inline `cid:` attachment, no remote images)
and the plain text as typed. Asking to send only inserts a
`document_emails` row (the outbox; payslips too) and nudges the job; each email is then
claimed in one transaction (`for update skip locked`, so two processes
never send the same one), its document loaded and checked in another, its
PDF written (`src/lib/pdf`, pdf-lib with Liberation Sans, from the same
`printedDocument` and statement functions as the print pages), sent with
no transaction open, and the result recorded in a third: `sent` with the
SMTP server's message id (or Graph's request id, and `sent_via`) only when
it accepted the message; busy or
unreachable servers are retried after 1, 5 and 30 minutes (four attempts);
anything else fails with a plain-English reason. An email left "sending"
for 10 minutes is marked failed, not resent, since it may have gone. Each
organisation sends at most 100 an hour. The database refuses changes to
what a queued email says and any change to a finished one. Every minute it
works through organisations with emails waiting, and every 10 minutes it
checks all of them (for retries and after a restart).

The sales platform sync (`src/lib/sales-platforms/service.ts`, started from
`src/instrumentation.ts`; `TOHYEE_SALES_PLATFORM_SYNC_SCHEDULER=off` stops
it) runs two minutes after start-up and then every 15 minutes, like mail
sync: for each ready organisation, each active connection is synced one at
a time, asking only for what changed since the last sync. A failure is kept
on the connection; after three in a row it's paused until someone chooses
Sync now. No network calls inside a database transaction.

Still to come for other jobs: a general transactional outbox.

## Backups and restore

`src/lib/backups/`. Each database (every ready organisation, plus the core
database) is dumped with `pg_dump --format=custom --no-owner --no-privileges`
as the admin login, straight into an encrypted file:

- **Format** (`format.ts`): `TOHYEE-BACKUP 1\n`, a JSON header line (what's
  inside: organisation, database, schema version, Tohyee version, when, a
  fingerprint of the key), then a 12-byte IV, the AES-256-GCM ciphertext and
  its 16-byte tag. The header is the GCM additional data, so it can't be
  changed either. The key is HKDF-SHA256 of `TOHYEE_SECRET_KEY` ("tohyee
  backups v1"), separate from the key for stored secrets. Losing
  `TOHYEE_SECRET_KEY` means losing the backups, so (`key.ts`) a server admin
  can see it after typing their password again (5 wrong tries in 15 minutes
  blocks it), and proves a saved copy by pasting it back: the server compares
  it and records when, for that key's fingerprint, in `server_settings`
  (`backup_key`). Until a saved copy of the current key has been checked,
  server admins see a reminder on every page and the server app opens on
  Backups. The key never goes in the audit trail.
- **Where**: the backup folder (a server setting; default
  `TOHYEE_BACKUP_DIR`, else `%ProgramData%\Tohyee\backups` on Windows or
  `./backups`), one sub-folder per organisation and `_server` for the core
  database, files named `<id>_<YYYY-MM-DD_HHmmss>.tohyee-backup` in the
  business time zone. Saving the setting checks the server can write there.
  It's written as `.partial` and renamed once checked.
- **Checked** after writing: the whole file is decrypted (so the tag is
  verified) into `pg_restore --list`.
- **Kept**: the newest of each of the last 14 days that have a backup and the
  first of each of the last 12 months (`retention.ts`); only files with that
  organisation's prefix in its folder are ever deleted.
- **Recorded**: every attempt is a row in `backup_runs` (core database),
  written by the code doing the work: started, ok or failed with the error,
  file and size.
- **When** (`scheduler.ts`, started from `instrumentation.ts`, off with
  `TOHYEE_BACKUP_SCHEDULER=off`): every 5 minutes it checks whether each
  database has a good backup since today's set time (default 02:00); a failed
  one is retried an hour later, and server admins are emailed about the first
  failure of the day. One backup job runs at a time (advisory lock), and
  "Back up now" (server app, `/api/admin/backups`, `backups run`) uses the
  same code.
- **Restoring** (`restoreBackupAsCopy`) never overwrites: it checks the file
  first, registers a new organisation (ID `<id>-<YYYYMMDD>` by default, name
  "... (restored from <date>)", the original's members, or the given owner if
  the original is gone), creates its database, `pg_restore`s into it, points
  its `organisation_settings` at the new ID, then provisions it as usual
  (migrations up to this server's version, runtime-login grants). Any failure
  drops the new database and registry row. A backup from a newer Tohyee is
  refused. A backup made on another server (or before the key changed) is
  restored by giving that server's key with the request; this server's own
  key is never replaced. The core database isn't restored by the app: `backups decrypt`
  turns a file into a plain pg_dump for a database administrator.
- Tests (`tests/integration/backups.test.ts`) back up and restore real
  organisations, with one login and with a separate runtime login, and check
  that a changed file or the wrong key is refused.

## Analytics data

Analytics (decisions 353-362) keeps loaded data out of PostgreSQL. Each
organisation with Analytics on has one DuckDB file,
`<TOHYEE_ANALYTICS_DIR>/<organisation id>.duckdb` (Windows:
`%ProgramData%\Tohyee\analytics` by default, set by the installer to the data
folder's `analytics`; Docker: the `/analytics` volume). DuckDB runs inside
the server through `@duckdb/node-api` (kept out of Next's bundle with
`serverExternalPackages`), one instance per file per process, with loads for
one organisation run one at a time. No DuckDB extensions are downloaded at
run time.

- **Definitions stay in the organisation's database** (tenant migrations
  0082/0087: `analytics_sources`, `analytics_shaped_tables`,
  `analytics_load_runs`), so they're backed up and restored with it. The
  DuckDB file holds only loaded data and can always be rebuilt by loading
  again; it isn't in the backups.
- **Source folders are a server setting** (`analytics_folders` in the core
  `server_settings`), chosen by a server admin on the server computer. Files
  are only read from inside an organisation's own folder, after resolving
  links and `..`.
- **Loads** (`src/lib/analytics/engine.ts`) read every column as text and
  convert it to the confirmed type, so money is `DECIMAL(18,2)` and never a
  guessed floating-point number. A load writes a new table and swaps it in
  only when it succeeds. The PostgreSQL record of a load is written before
  and after it, in short transactions; the file is never read inside one.
- **The nightly reload** (`src/lib/analytics/scheduler.ts`) loads each daily
  source once a day after 04:00 business time and retries a failure an
  hour later (off with `TOHYEE_ANALYTICS_SCHEDULER=off`).
- **File access** (decision 377): each organisation's DuckDB is opened with
  `allowed_directories` set to its source folder and data folder,
  `enable_external_access = false` and `lock_configuration = true`
  (`src/lib/analytics/engine.ts`). The folder is checked on each use and a
  change reopens the file. Previews have a 10-second limit
  (`PREVIEW_TIME_LIMIT_MS`, via `connection.interrupt()`).
- **Sharing** (decision 368): the `report_viewer` role ranks below viewer
  (`src/lib/auth/roles.ts`), so routes guarded at viewer refuse it. The
  dashboard routes accept it and filter through `analytics_dashboard_shares`
  (`src/lib/analytics/dashboards.ts`: `DashboardReader`, `allowedFilters`).
  `/api/analytics/query` runs a saved tile when given `dashboardId` and
  `tileId`; a free question needs viewer. `/api/analytics/values` needs a
  shared dashboard with that slicer. The app shell sends report viewers to
  `/analytics` and shows no other app.
- **Shaped tables** store their base table and ordered steps in PostgreSQL.
  The shaping compiler checks each step against its current columns, quotes
  identifiers and binds values; it supports filters, column selection and
  renames, type changes, split/unpivot/group/calculated columns, joins and
  union-by-name appends. Rebuilds stage a new DuckDB table and swap it in only
  on success. They run after a dependent CSV or books table loads, nightly or
  on demand, and each result is recorded in `analytics_load_runs`. Averages
  and division go through `src/lib/analytics/decimal-sql.ts`, which divides
  whole millionths as HUGEINT, since DuckDB divides decimals as DOUBLE.
- **Report emails** (tenant migration 0088) keep mailbox configuration,
  remembered message IDs, replacement timestamps and job-written checks in
  the organisation's PostgreSQL database. Admins and owners use their own
  CRM-connected Gmail or Microsoft mailbox, or TLS IMAP on port 993 with an
  encrypted app password. Network reads run outside transactions; committed
  leases keep checks from overlapping. Checks run once a night after 03:00
  business time, before the 04:00 reload, and on demand (scheduler off with
  `TOHYEE_REPORT_EMAIL_SCHEDULER=off`). Saved messages are skipped before
  they're downloaded; a message that can't be read is noted and the check
  carries on, and one that keeps failing is tried three times in all. IMAP
  hosts must resolve to public addresses (`src/lib/analytics/mail-host.ts`),
  checked on save and before each connection. Data files
  go into `email/<mailbox id>/` inside the server-admin-chosen source folder;
  the existing loader discovers them there. OAuth permissions cover the
  whole mailbox, but these checks only read the chosen folder or label and
  never modify mail.

## Open decisions

- Canonical production HTTPS origin and local/offline access model.
- Break-glass recovery ownership beyond the admin CLI.
- Backup key custody beyond "keep a copy of TOHYEE_SECRET_KEY", and recovery
  targets. Restoring the core database is still manual.
- Remote BI connectivity.
- GST on standard-rated foreign-currency spend and receive money, and the
  reverse charge on imported services. (Foreign-currency documents, their
  standard-rated GST included, were built overnight on 1 Oct 2026 following
  NetSuite: see "Foreign-currency documents" under Financial integrity.)
- Backdated stock movements (needs re-costing of later movements), and
  voiding documents whose stock has moved since.

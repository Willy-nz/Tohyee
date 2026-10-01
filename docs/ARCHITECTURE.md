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
└─ admin_audit_events   server-level audit trail

tohyee_org_glimmers     one database per organisation (organisation "glimmers")
├─ organisation_settings  (records which organisation owns this database)
├─ accounts, ledger_journals, ledger_journal_lines
├─ ledger_fx_revaluation_runs / _items / _documents   revaluations, per account and currency, and the open documents they revalued (MC39)
├─ ledger_foreign_opening_balances   a foreign-currency account's foreign balance as at a date, entered once (FXB1)
├─ inventory_item_balances, inventory_movements   stock by item code and location (a Location tracking value)
├─ stock_transfers        stock moved between locations (append-only; its two movements and journal point at it)
├─ tax_codes, accounting_period_controls
├─ contacts               customers and suppliers (with terms, credit limit, group, price level, parent, currency)
├─ payment_terms, customer_groups, price_levels   lists for customers (archived, never deleted)
├─ items, item_units, item_level_prices, item_suppliers, kit_components   products and services
├─ sales_invoices, sales_invoice_lines, sales_invoice_numbering
├─ quotes, quote_lines, quote_numbering   quotes (post nothing; accepting makes a draft invoice)
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
├─ payroll_employees        employee payroll details (IRD and bank details encrypted)
├─ fixed_asset_types, fixed_assets, fixed_asset_numbering   the fixed asset register (archived, never deleted)
├─ fixed_asset_depreciation_runs, fixed_asset_disposals, fixed_asset_depreciation_lines   depreciation runs and disposals, and the months each charged
├─ projects, project_tasks, project_time_entries, project_expenses   projects, their tasks, time (whole minutes) and linked expense lines (post nothing; never deleted)
├─ project_invoices, project_invoice_items, project_staff_rates   what each project invoice billed, and staff cost rates per member
├─ customer_payment_batches, supplier_payment_batches   one payment for several invoices or bills (its parts are customer or supplier payments)
├─ custom_reports         custom report drafts, and published frozen copies with their figures
├─ budgets, budget_amounts   budgets (post nothing; archived, never deleted) and their amounts per account and month
├─ sales_credit_notes, sales_credit_note_lines, sales_credit_note_numbering
├─ sales_credit_note_applications   credit applied to sales invoices
├─ sales_credit_note_refunds        credit paid back to customers
├─ supplier_credit_notes, supplier_credit_note_lines
├─ supplier_credit_note_applications   credit applied to bills
├─ supplier_credit_note_refunds        credit paid back by suppliers
├─ gst_returns, gst_return_adjustments, gst_return_lines   filed GST returns
├─ bank_account_settings  per bank/card account: statement balance, import layout, Akahu feed link
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
├─ document_emails, document_email_batches   each email of a document or statement: queued, then sent or failed by the job
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
5. marks it `ready`.

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
| viewer | read journals, stock, expense claims, fixed assets (with runs and the register), contacts, invoices, customer payments, credit notes (with their applications and refunds), bills, supplier payments, supplier credit notes (with their applications and refunds), reports (including custom report drafts and published copies, budgets and budget vs actual), the GST return, filed GST returns, the GST audit report and customer statements, quotes, repeating invoices, repeating bills and purchase orders, projects (with profitability, the time report and staff cost rates); print invoices, credit notes, quotes and purchase orders; read notes, download files and see the history |
| bookkeeper | + post journals, corrections, stock movements and transfers, FX revaluations; add and archive exchange rates; add, edit and archive contacts; save, approve, void and delete draft invoices; record and void customer payments (one invoice or several); save, approve, void and delete draft credit notes, apply and remove their credit, record and void their refunds; save, approve, void and delete draft bills; record and void supplier payments (one bill or several); enter a foreign-currency bank account's opening foreign balance; save, approve, void and delete draft supplier credit notes, apply and remove their credit, record and void their refunds; make, change, publish, archive and delete custom reports; add, change, quick fill and archive budgets; make, change, submit and delete their own expense claims, and approve (not their own), decline, pay and void claims and void their payments; register, change and archive fixed assets, run depreciation and roll back the latest run, dispose of assets and undo disposals; close a month on Period close when every check passes; save, finalise, accept, decline, copy and delete draft quotes; save, approve, cancel, copy to a bill and delete draft purchase orders; save, change, run, pause, resume and end repeating invoices and repeating bills; start and change projects and tasks, record, change and remove their own time, link and remove expenses, invoice, close and reopen projects; add notes and files, and edit, delete or remove their own |
| admin | + approve their own expense claims; staff cost rates, and recording and changing other members' project time; fixed asset types and the part-month settings; chart of accounts, tax codes, closing a month with checks that need attention (after confirming) and reopening months (with a reason) on Period close, settings (including payment terms, customer groups, price levels, the credit limit setting and the GST number, address and payment details printed on documents), people; mark GST returns as filed; edit and delete anyone's notes and remove anyone's files |
| owner | + manage other owners (an organisation always keeps one) |

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
  quotes, repeating templates and purchase orders in their contact's
  currency (they have no rate). Stock is valued in the base currency: a
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
  and a trigger keeps it won from then on. The rules are in
  `src/lib/crm/service.ts`; only the invoice it makes ever reaches the ledger.
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
  that folder. Nothing calls them yet; pay runs (P3) will.
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
`document_emails` row (the outbox) and nudges the job; each email is then
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

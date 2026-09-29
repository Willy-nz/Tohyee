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
├─ ledger_fx_revaluation_runs / _items
├─ inventory_item_balances, inventory_movements   stock by item code and location (a Location tracking value)
├─ tax_codes, accounting_period_controls
├─ contacts               customers and suppliers (with terms, credit limit, group, price level, parent)
├─ payment_terms, customer_groups, price_levels   lists for customers (archived, never deleted)
├─ items, item_units, item_level_prices, item_suppliers, kit_components   products and services
├─ sales_invoices, sales_invoice_lines, sales_invoice_numbering
├─ quotes, quote_lines, quote_numbering   quotes (post nothing; accepting makes a draft invoice)
├─ repeating_invoices, repeating_invoice_lines   repeating invoice templates (post nothing)
├─ repeating_invoice_runs   one row per scheduled date made (unique), so a date is never made twice
├─ customer_payments      money received against sales invoices (with any overpayment)
├─ customer_overpayment_applications   overpayments applied to other sales invoices
├─ customer_overpayment_refunds        overpayments paid back to customers
├─ bills, bill_lines      bills from suppliers (with the purchase order and line they came from, if any)
├─ purchase_orders, purchase_order_lines, purchase_order_numbering   purchase orders (post nothing; copied to bills)
├─ supplier_payments      money paid against bills
├─ customer_payment_batches, supplier_payment_batches   one payment for several invoices or bills (its parts are customer or supplier payments)
├─ custom_reports         custom report drafts, and published frozen copies with their figures
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
├─ bank_transactions, bank_transaction_lines   spend and receive money
├─ bank_transfers         money moved between bank and card accounts
├─ bank_rules             text to look for, and the bank transaction to suggest
├─ record_notes, record_attachments   notes and files on journals, documents and contacts
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
4. seeds `organisation_settings` and a starting NZ chart of accounts,
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
| viewer | read journals, stock, contacts, invoices, customer payments, credit notes (with their applications and refunds), bills, supplier payments, supplier credit notes (with their applications and refunds), reports (including custom report drafts and published copies), the GST return, filed GST returns, the GST audit report and customer statements, quotes, repeating invoices and purchase orders; print invoices, credit notes, quotes and purchase orders; read notes, download files and see the history |
| bookkeeper | + post journals, corrections, stock movements, FX revaluations; add, edit and archive contacts; save, approve, void and delete draft invoices; record and void customer payments (one invoice or several); save, approve, void and delete draft credit notes, apply and remove their credit, record and void their refunds; save, approve, void and delete draft bills; record and void supplier payments (one bill or several); save, approve, void and delete draft supplier credit notes, apply and remove their credit, record and void their refunds; make, change, publish, archive and delete custom reports; save, finalise, accept, decline, copy and delete draft quotes; save, approve, cancel, copy to a bill and delete draft purchase orders; save, change, run, pause, resume and end repeating invoices; add notes and files, and edit, delete or remove their own |
| admin | + chart of accounts, tax codes, period locks, settings (including payment terms, customer groups, price levels, the credit limit setting and the GST number, address and payment details printed on documents), people; mark GST returns as filed; edit and delete anyone's notes and remove anyone's files |
| owner | + manage other owners (an organisation always keeps one) |

People who aren't members get "not found", so organisation IDs can't be
probed. Every audit record stores the signed-in user, never a name typed into
a form.

## Financial integrity

Enforced by the database itself, not just the app:

- Every journal balances: deferred constraint triggers check at commit that
  there are at least two lines and that debits = credits = the header totals.
- Each line is either a debit or a credit, never both or neither.
- Posted history is append-only: `ledger_journals`, `ledger_journal_lines`,
  `inventory_movements`, FX revaluation runs and `audit_events` reject
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
  spaces.
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
- Journals are posted in the organisation's base currency only.
  Foreign-currency transactions are not supported yet; foreign-currency
  balances are handled by the FX revaluation screen.
- Idempotency: every command carries an idempotency key. A retry with the
  same key and content returns the original result; the same key with
  different content is refused (409). The key check happens before anything
  is recalculated, so retries still work after a period is locked.
- Journals made by stock movements, FX revaluations, sales invoices,
  customer payments, sales credit notes, credit note refunds, bills,
  supplier payments, supplier credit notes or supplier credit note refunds
  can't be corrected in the ledger; they are corrected at their source (an
  invoice, payment, credit note, refund or bill is voided) so
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
  the payments way. Bank transactions count on their date on every basis.
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
  Spend and receive money (`bank_transactions`) post like a bill or an
  invoice without the payable or receivable, and count in the GST return on
  their date (spend as purchases, receive as sales). Transfers post
  Dr to / Cr from between two base-currency bank or card accounts.
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
- Ledger and document reports (AGP, ATX, JR, GA, CST) store nothing and
  post nothing. Aged payables (`src/lib/reports/aged-payables.ts`) and
  customer statements (`customer-statements.ts`) read the documents as at a
  date, like aged receivables, sharing the ageing maths in `ageing.ts`.
  Account transactions and the journal report read `ledger_journal_lines`
  and find each journal's source from the documents' journal columns
  (`journal-sources.ts`); who posted a journal is its `created_by_email`.
  The GST audit report (`gst-audit.ts`) only groups the GST return's own
  counted lines (`calculateGstReturn`, or a filed return's stored lines),
  so it can't disagree with the return.
- Dates are plain `YYYY-MM-DD` strings end to end (the `pg` DATE parser is
  overridden), so there are no time-zone shifts.

See `docs/ACCOUNTING-EXAMPLES.md` for the worked examples these rules are
tested against.

## Remote access

Remote access (server settings) runs Cloudflare's `cloudflared` connector as a child
process (`src/lib/remote/tunnel.ts`) with the tunnel token a server admin
pasted from Cloudflare's dashboard (stored encrypted). The tunnel's public
hostname is pointed at `http://127.0.0.1:<port>` in Cloudflare, so nothing is
opened on the router and Cloudflare provides HTTPS. Requests arrive with
`X-Forwarded-Proto: https`, so session cookies are `Secure`. The connector is
started at boot when remote access is on (`TOHYEE_REMOTE_ACCESS=off` stops
that), restarted with growing waits if it stops, and its status comes from
its own `/ready` endpoint. The Windows installer and the Docker image include
a pinned, checksum-verified `cloudflared`; elsewhere set
`TOHYEE_CLOUDFLARED_PATH` or put it on the `PATH`. Emailed links use the saved
public address rather than the request's Host header.

## Background work

The only background job so far is the bank feed sync: every 15 minutes the
server checks each ready organisation for linked accounts not synced in the
last few hours (the organisation's "sync every" setting) and syncs them one at a time
(`src/lib/bank/akahu/sync.ts`, started from `src/instrumentation.ts`; set
`TOHYEE_BANK_FEEDS_SCHEDULER=off` to stop it). A failure is kept on the
account and shown on its Bank feed tab, and the next run tries again. It makes
no network calls inside a database transaction and re-resolves each
organisation from the registry.

The repeating invoices job (`src/lib/repeating/scheduler.ts`, started from
`src/instrumentation.ts`; `TOHYEE_REPEATING_INVOICES_SCHEDULER=off` stops
it) runs two minutes after start-up and then hourly: for each ready
organisation, each active template runs in its own transaction and makes
every scheduled date up to today not yet made (examples RI1-RI10). Each date
made is a row in `repeating_invoice_runs`, unique on (template, date), and
the template row is locked while it runs, so overlapping runs, restarts or
a second server process never make a date twice. An error is kept on the
template and that date is tried again next run. No network calls.

Still to come for other jobs: a transactional outbox and bounded retries.

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
- Multi-currency transactions (line-level foreign amounts and rates).
- Backdated stock movements (needs re-costing of later movements), and
  voiding documents whose stock has moved since.

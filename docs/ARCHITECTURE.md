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
├─ inventory_item_balances, inventory_movements
├─ tax_codes, accounting_period_controls
├─ contacts               customers and suppliers
├─ sales_invoices, sales_invoice_lines, sales_invoice_numbering
├─ customer_payments      money received against sales invoices (with any overpayment)
├─ customer_overpayment_applications   overpayments applied to other sales invoices
├─ customer_overpayment_refunds        overpayments paid back to customers
├─ bills, bill_lines      bills from suppliers
├─ supplier_payments      money paid against bills
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
- Break-glass: `npm run admin -- set-password --email ...` (or
  `reset-two-step --email ...`) from a checkout of
  the repository with `DATABASE_URL` pointing at the core database (the
  release bundle doesn't include it).

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
  the Cloudflare Tunnel even with a server admin's session.

Per organisation (lowest to highest):

| Role | Can |
| --- | --- |
| viewer | read journals, stock, contacts, invoices, customer payments, credit notes (with their applications and refunds), bills, supplier payments, supplier credit notes (with their applications and refunds), reports, the GST return and filed GST returns; read notes, download files and see the history |
| bookkeeper | + post journals, corrections, stock movements, FX revaluations; add, edit and archive contacts; save, approve, void and delete draft invoices; record and void customer payments; save, approve, void and delete draft credit notes, apply and remove their credit, record and void their refunds; save, approve, void and delete draft bills; record and void supplier payments; save, approve, void and delete draft supplier credit notes, apply and remove their credit, record and void their refunds; add notes and files, and edit, delete or remove their own |
| admin | + chart of accounts, tax codes, period locks, settings, people; mark GST returns as filed; edit and delete anyone's notes and remove anyone's files |
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
- Stock on hand and carrying value can't go negative.
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

Still to come for other jobs: a transactional outbox and bounded retries.

## Backups and restore

Not built into the app yet. Because each organisation is its own database,
a backup is simply:

```
pg_dump -Fc -d tohyee_org_<id> > <id>-2026-09-30.dump
```

and back up the core database the same way. There is no restore tooling yet,
and restoring an organisation from a dump hasn't been tested, so treat
restores as a manual job for a database administrator until that's built.

## Open decisions

- Canonical production HTTPS origin and local/offline access model.
- Break-glass recovery ownership beyond the admin CLI.
- Backup key custody and recovery targets; built-in scheduled backups.
- Remote BI connectivity.
- Multi-currency transactions (line-level foreign amounts and rates).
- Backdated stock movements (needs re-costing of later movements).

# Tohyee feature scope

What's built, what's intentionally not, and what comes next. "Built" means it
works end to end and has tests; nothing is listed as built if it only records
that something happened.

## Built

- **Organisations**, each with its own PostgreSQL database, created and
  repaired by server admins.
- **Logins and roles**: server admins; per-organisation owner, admin,
  bookkeeper and viewer; first-time setup; password changes and resets;
  sign-in lockout; admin CLI for recovery.
- **Chart of accounts** with account classes and types, a starting NZ chart,
  archiving, and foreign-currency accounts.
- **General ledger**: manual journals in the base currency, corrections by
  reversal and replacement, period locks with unlock windows, idempotent
  posting, database-enforced balancing and append-only history.
- **FX revaluation** of foreign-currency asset and liability accounts, with
  carrying amounts taken from the ledger and automatic next-day reversal.
- **Stock**: receipts, sales, stocktake adjustments, customer and supplier
  returns, landed cost; weighted-average costing to the cent; every movement
  posts its journal in the same transaction.
- **Reports**: trial balance, profit and loss, balance sheet, stock valuation.
  The financial year end is a setting (default 31 March); the balance sheet
  splits earnings into this year and previous years.
- **Contacts**: customers and suppliers with optional email, phone, postal
  address and GST number (format-checked only); search by name or email;
  archiving instead of deleting. Customers are used by sales invoices and
  suppliers by bills.
- **Tax codes** as settings. Sales invoices and bills apply them; manual
  journals don't.
- **Sales invoices** in the base currency: drafts that can be edited and
  deleted, tax-exclusive, tax-inclusive or no-tax amounts, GST worked out and
  rounded per line, approval that numbers the invoice (`INV-0001`, with no
  gaps) and posts its journal on the invoice date, and voiding that posts the
  exact reversal on the void date. Period locks apply to both; approving and
  voiding are idempotent. See examples I1-I9.
- **Customer payments** against one approved sales invoice at a time:
  recording a payment posts Dr the bank account / Cr accounts receivable on
  the payment date, and voiding it posts the exact reversal on the void date.
  An invoice's amount due and paid status (unpaid, part paid, paid) are worked
  out from its active payments, and the invoice list can show just the
  invoices awaiting payment. Overpayments are refused, and an invoice with
  active payments can't be voided. Period locks apply; recording and voiding
  are idempotent. See examples CP1-CP8.
- **Bills** from suppliers in the base currency: drafts that can be edited and
  deleted, with the supplier's invoice number (a supplier can't have two bills
  that aren't voided with the same number, ignoring case and spaces),
  tax-exclusive, tax-inclusive or no-tax amounts and GST worked out and
  rounded per line as on sales invoices. Approving posts Dr each line's
  account and GST / Cr accounts payable on the bill date, and voiding posts
  the exact reversal on the void date. Period locks apply; approving and
  voiding are idempotent. Paying bills isn't built yet. See examples B1-B8.
- **GST basis** setting (invoice, payments or hybrid). Stored and shown only;
  the GST return will use it.
- **Update check** against GitHub releases.

## Not built yet, on purpose

These only arrive as working features. A screen that just records a status
someone types in (for example "backup completed") without doing the work
isn't acceptable, because people would trust it:

- backups, restores and restore activation
- update runs and recovery incidents
- export jobs and downloads
- attachments
- job executions
- AI suggestions
- bank feeds and bank reconciliation
- import staging
- tax transactions and the tax summary
- stock "recomputation"

## Next, in rough order

1. Credit notes and supplier payments (the core of a Xero-style ledger),
   customer payments across several invoices, overpayments and prepayments,
   and a GST return built from postings using the GST basis setting. Invoice
   PDFs and emailing come with or after these.
2. Bank feeds (through an NZ open-banking provider, still to be chosen) and
   bank reconciliation that matches real transactions.
3. Backdated stock movements with proper re-costing.
4. Scheduled per-organisation backups (`pg_dump`) and tested restores.
5. Stock depth: an item list, locations/bins, lots and serial numbers,
   variants, assemblies/bundles, stock takes.
6. NZ payroll, fixed assets, projects and time tracking.
7. Multi-currency transactions.

## Guardrails

- Accounting behaviour follows `docs/ACCOUNTING-EXAMPLES.md`. New behaviour
  needs a worked example with numbers and a test before it ships.
- AI output, when it arrives, is suggestion-only and never posts on its own.
- Don't add screens or APIs that only record statuses a person types in.

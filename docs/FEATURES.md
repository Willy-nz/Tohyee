# Toeyee feature scope

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
  archiving instead of deleting. Not yet used by anything else: invoices and
  bills come next.
- **Tax codes** as settings (not yet applied to journals).
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

1. Sales invoices, bills and payments against contacts (the core of a
   Xero-style ledger), with GST codes on lines and a GST return built from
   postings.
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

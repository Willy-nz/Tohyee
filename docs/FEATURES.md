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
- **Reports**: trial balance, profit and loss, balance sheet, stock valuation
  and the GST return (below).
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
  invoices awaiting payment. An invoice with active payments can't be voided.
  Period locks apply; recording and voiding are idempotent. See examples
  CP1-CP8.
- **Customer overpayments**: a payment of more than the amount due pays the
  invoice and keeps the rest as an overpayment, credit for the customer in
  accounts receivable (one journal for the whole payment, no GST on the
  overpayment). It's applied to the customer's other invoices in one
  all-or-nothing command (no journal) or refunded from a bank account, and
  applications can be removed and refunds voided. A payment whose overpayment
  is used can't be voided. A payment for an invoice that's already paid (the
  customer paid twice) is all credit, after a confirmation on screen. See
  examples OP1-OP11.
- **Bills** from suppliers in the base currency: drafts that can be edited and
  deleted, with the supplier's invoice number (a supplier can't have two bills
  that aren't voided with the same number, ignoring case and spaces),
  tax-exclusive, tax-inclusive or no-tax amounts and GST worked out and
  rounded per line as on sales invoices. Approving posts Dr each line's
  account and GST / Cr accounts payable on the bill date, and voiding posts
  the exact reversal on the void date. Period locks apply; approving and
  voiding are idempotent. See examples B1-B8.
- **Supplier payments** against one approved bill at a time: recording a
  payment posts Dr accounts payable / Cr the bank account on the payment date,
  and voiding it posts the exact reversal on the void date. A bill's amount
  due and paid status (unpaid, part paid, paid) are worked out from its active
  payments, and the bill list can show just the bills awaiting payment.
  Overpayments are refused, and a bill with active payments can't be voided.
  Period locks apply; recording and voiding are idempotent. See examples
  SP1-SP8.
- **Sales credit notes** in the base currency: drafts with the same lines,
  amounts modes and per-line GST as invoices (a new draft can start from an
  approved invoice's lines), approval that numbers the credit note
  (`CN-0001`, from its own counter, with no gaps) and posts Dr revenue and GST
  / Cr accounts receivable on its date, and voiding that posts the exact
  reversal. Approved credit is applied to one or more of the same customer's
  approved invoices in one all-or-nothing command (no journal; it lowers their
  amount due), an application can be removed once, and unused credit stays on
  the credit note or is refunded from a bank account (Dr accounts receivable /
  Cr bank; a refund can be voided). Remaining credit, credit status (open,
  part used, used) and an invoice's credit applied are worked out, never
  stored. A credit note with active applications or refunds, or an invoice
  with credit applied, can't be voided. Period locks apply to every step;
  every command is idempotent. See examples CN1-CN12.
- **Supplier credit notes** in the base currency: drafts with the same lines,
  amounts modes and line account rules as bills (a new draft can start from a
  bill's supplier and lines), carrying the supplier's credit note number
  (required, and unique per supplier among credit notes that aren't voided,
  ignoring case and spaces). Approval posts Dr accounts payable / Cr the line
  accounts and GST on its date, and voiding posts the exact reversal.
  Approved credit is applied to one or more of the same supplier's approved
  bills in one all-or-nothing command (no journal; it lowers their amount
  due), an application can be removed once, and unused credit stays on the
  supplier credit note or is refunded by the supplier into a bank account
  (Dr bank / Cr accounts payable; a refund can be voided). A bill's amount due
  is its total less its active payments and credit applied. A supplier credit
  note with active applications or refunds, or a bill with credit applied,
  can't be voided. Period locks apply to every step; every command is
  idempotent. See examples SCN1-SCN12.
- **GST basis** setting (invoice, payments or hybrid). The GST return uses
  it: only the invoice basis is built so far.
- **GST return** (NZ GST101A, boxes 5-15) on the invoice basis, for 1, 2 or 6
  whole calendar months, under Reports. Worked out from sales invoices, sales
  credit notes, bills and supplier credit notes: each counts on its own date
  when approved and the other way on its void date; drafts, payments,
  refunds, credit applications, manual journals, stock movements and FX
  revaluations don't count. Lines go into boxes by their tax code's category
  (standard, zero rated, exempt, out of scope), and every box can be opened
  to see its lines. GST on transactions is shown next to Box 8 and Box 12 for
  information (the difference is rounding). Box 9 and Box 13 adjustments are
  entered with a description. "Mark as filed" (admins) stores the period,
  basis, adjustments, every box and the counted lines, and is idempotent;
  filed returns can't be changed or deleted and can't overlap (the database
  refuses). A filed return shows its stored figures and "Changed since
  filed", box by box, if documents in its period were approved or voided
  afterwards. Standard-rated lines at a rate other than 15% are refused. See
  examples G1-G9.
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
- the GST return on the payments and hybrid bases (refused for now)
- amending a filed GST return, imported goods (Customs GST), GST rates other
  than 15%, recording the GST payment or refund to IRD, and filing to IRD
  electronically
- stock "recomputation"

## Next, in rough order

The owner's to-do list in [TODO.md](TODO.md) comes first.

1. The GST return on the payments and hybrid bases; then customer and
   supplier payments across several invoices or bills, supplier
   overpayments, and prepayments (once the owner has decided how GST works
   on them). Invoice and credit note PDFs and emailing come with or after
   these.
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

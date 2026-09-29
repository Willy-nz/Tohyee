# Tohyee feature scope

What's built, what's intentionally not, and what comes next. "Built" means it
works end to end and has tests; nothing is listed as built if it only records
that something happened.

## Built

- **Organisations**, each with its own PostgreSQL database, created and
  repaired by server admins.
- **Server settings apart from the books** (organisations, users, remote
  access, email, updates), open only on the server computer itself. On
  Windows they're in the **Tohyee server app**: an icon by the clock (started
  when you sign in, like a media server's) that shows whether Tohyee is
  running, restarts it, backs it up and opens the logs, and a window for the
  settings. On Docker and Linux they're a **command-line tool**
  (`tohyee-admin.cjs` in the image, `npm run admin` from a checkout).
- **Nightly backups** of each organisation (and the server's own database),
  encrypted with the server's secret key, into a folder the server admin
  chooses (a OneDrive folder gets copies off the computer); each checked after
  it's made; 14 daily and 12 monthly kept; failures retried hourly and
  emailed to server admins. **Restoring** makes a copy of the organisation, so
  nothing is overwritten, and works on a new server given the old server's
  key. **Keeping the key**: server admins can see the backup key (with their
  password) and check a saved copy by pasting it back; they're reminded on
  every page until someone has.
- **Menus**: Home, Sales, Purchases, Reporting, Accounting, Tax and Contacts
  across the top, each opening to its overview, lists and settings; a ☰ menu
  with the same sections on phones, where line editors stack each line's
  fields. **Home** (examples H1-H4): a card per bank account with its
  balances and "Reconcile N items", money owed to you and bills to pay (with
  what's overdue), and the next GST return's Box 15 so far.
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
  posts its journal in the same transaction. **Stock tracking** (ST1-ST12):
  stock items on bills, invoices and credit notes move stock with the
  document's journal, at weighted average **per location** (the line's
  Location tag; one pool without locations). Bills put stock lines on the
  inventory account; approving an invoice posts its cost of sales; credit
  notes restock at the original sale's cost; voids put stock back exactly;
  units and kits move the right stock. **Negative stock** is a setting (off
  by default): sales below zero are costed at the average, the last cost or
  the purchase price, and the bill that fills the shortfall tops up cost of
  sales. Stock always equals the inventory account (the database and the
  app keep anything else off it), and the **stock on hand** report shows it
  by item and location beside the ledger. Transfers between locations
  aren't built yet.
- **Reports**: trial balance, profit and loss, balance sheet, stock valuation,
  aged receivables and payables, account transactions, the journal report,
  customer statements, the GST return and GST audit report (below).
  The financial year end is a setting (default 31 March); the balance sheet
  splits earnings into this year and previous years.
- **Custom reports** (Reporting, tabs Home, Custom, Drafts, Published and
  Archived): start from the profit and loss or balance sheet, then change the
  title, the columns (1-12 months, quarters or years, a difference and %
  column, and year to date on profit and loss), and the rows (groups of
  accounts by type or by code, showing each account or just the total,
  formula rows that add and subtract other rows, headings, and the balance
  sheet's earnings lines), move and delete them, and add more tables and
  notes. Accounts left out or counted twice are listed on the report.
  Publishing keeps a frozen copy that never changes (the database refuses);
  drafts and published reports can be archived and brought back, and drafts
  deleted. "Print or save as PDF" prints just the report. Budget columns
  come with budgets. See examples CR1-CR10.
- **Contacts**: customers and suppliers with optional email, phone, postal
  (billing) address and GST number (format-checked only); search by name or
  email; archiving instead of deleting. Customers are used by sales invoices
  and suppliers by bills. Customers also have a delivery address and
  **payment terms** (N days after the invoice, N days after the end of the
  month, or day N of the following month; six NZ defaults to start, archived
  never deleted), and a new invoice's due date comes from them (still
  editable on the draft). See examples RC1, RC2.
- **Aged receivables** (Reporting): what each customer owes as at a date,
  by days past due (current, 1-30, 31-60, 61-90, over 90) less unused
  credit, each row opening to its invoices, and totalling to accounts
  receivable; with "Roll up sub-customers" a parent shows itself and its
  subs (RC9-RC11).
- **Aged payables** (Reporting; examples AGP1-AGP3, not yet approved by
  Jess): the same for suppliers, what's owed on each bill as at a date by
  days past its due date, less supplier credit not yet used, each row
  opening to its bills and credit, totalling to accounts payable (the
  ledger's figure is shown beside it).
- **Account transactions** (Reporting; ATX1-ATX5, not yet approved): the
  general ledger detail for one account or all of them over a date range:
  opening balance, every posted line (date, source with a link, description,
  contact, debit, credit, running balance) and closing balance, tying to the
  trial balance; voids and corrections are their own lines; with Advanced
  reporting, only lines tagged with a tracking value (and those under it).
- **Journal report** (Reporting; JR1-JR3, not yet approved): every journal
  posted in a date range with its lines, where it came from and who posted
  it and when.
- **Customer statements** (Contacts; CST1-CST5, not yet approved): an
  activity statement for a date range (opening balance, invoices, credit
  notes, payments, refunds and their voids, closing balance) or an
  outstanding statement as at a date, both aged by due date at the foot; a
  parent customer can include its sub-customers. Printed or saved as PDF
  with the browser's print; emailing them isn't built.
- **GST audit report** (Tax; GA1-GA4, not yet approved): for a GST period
  on the organisation's basis, or a filed return as filed, every document
  behind Box 5, 6 and 11, the Box 9 and 13 adjustments and the lines left
  out, grouped from the GST return's own lines so each list adds up to its
  box to the cent. Each of these five reports has "Print or save as PDF".
- **Tax codes** as settings. Sales invoices and bills apply them; manual
  journals don't.
- **Sales invoices** in the base currency: drafts that can be edited and
  deleted, tax-exclusive, tax-inclusive or no-tax amounts, GST worked out and
  rounded per line, approval that numbers the invoice (`INV-0001`, with no
  gaps) and posts its journal on the invoice date, and voiding that posts the
  exact reversal on the void date. Period locks apply to both; approving and
  voiding are idempotent. See examples I1-I9.
- **Quotes** (Sales; QT1-QT8, not yet approved by Jess): drafts with the
  same lines as an invoice and an optional expiry date and terms; finalising
  numbers them (`QU-0001`, no gaps) and locks them (the database refuses
  changes); accepting makes a draft invoice with the same lines, due by the
  customer's payment terms or a date given, linked both ways; declining
  closes it; a finalised quote past its expiry date shows as expired;
  copying makes a new draft. Quotes post nothing. There's no "sent" status,
  because nothing sends quotes yet.
- **Repeating invoices** (Sales; RI1-RI10, not yet approved): a template
  with invoice lines, every N weeks or months from a start date to an
  optional end date, due by payment terms or N days, and each invoice saved
  as a draft or approved. A background job (hourly, and "Run now") makes each
  date's invoice once, catching up missed dates in order; the database key
  on (template, date) means two runs never make two. A refused approval
  (locked period, credit limit, required field) leaves the draft with the
  reason in the template's history. Pause, resume (paused dates are
  skipped) and end.
- **Printed invoices, credit notes and quotes** (PD1-PD8, not yet
  approved): "Print or save as PDF" with the browser's print, showing the
  organisation's name, address and GST number (set in Settings), the
  customer and billing address, the lines with GST, the totals, and on
  approved invoices what's paid, what's due and how to pay. Approved invoices
  from a GST-registered organisation print as **Tax invoice**; drafts, voided
  invoices and quotes say so. The screen warns when a tax invoice over $1,000
  has no customer address, or GST is charged with no GST number in Settings.
  Emailing isn't built.
- **Customer payments** against one approved sales invoice at a time:
  recording a payment posts Dr the bank account / Cr accounts receivable on
  the payment date, and voiding it posts the exact reversal on the void date.
  An invoice's amount due and paid status (unpaid, part paid, paid) are worked
  out from its active payments, and the invoice list can show just the
  invoices awaiting payment. An invoice with active payments can't be voided.
  Period locks apply; recording and voiding are idempotent. See examples
  CP1-CP8.
- **Payments for several invoices** ("Receive a payment" under Sales): one
  payment from a customer, with the amount typed for each of their invoices,
  posts one journal with one bank line for the whole amount and one accounts
  receivable line per invoice, so it matches one bank statement line. Anything
  more than the amounts typed is kept as an overpayment, but only when every
  invoice is paid in full. It's voided only as a whole (one reversal), not one
  invoice at a time. See examples MP1-MP10.
- **Customer overpayments**: a payment of more than the amount due pays the
  invoice and keeps the rest as an overpayment, credit for the customer in
  accounts receivable (one journal for the whole payment, no GST on the
  overpayment). It's applied to the customer's other invoices in one
  all-or-nothing command (no journal) or refunded from a bank account, and
  applications can be removed and refunds voided. A payment whose overpayment
  is used can't be voided. A payment for an invoice that's already paid (the
  customer paid twice) is all credit, after a confirmation on screen. Sales >
  Overpayments lists them all (or those with credit left, with the total
  left), each linking to its page. See examples OP1-OP11.
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
- **Payments for several bills** ("Pay bills" under Purchases): the same for
  one payment to a supplier (Dr accounts payable per bill / Cr bank once). The
  amounts must add up to the payment exactly, since supplier overpayments
  aren't built. See examples SMP1-SMP6.
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
- **Notes, files and history** on journals, sales invoices, bills, sales
  credit notes, supplier credit notes and contacts: notes that their author
  or an admin can edit or delete (the history keeps the old text), files
  (PDF, JPG, PNG, HEIC, Word, Excel, CSV, up to 10 MB each) stored in the
  organisation's own database, and a history of who did what and when,
  including payments, credit and refunds. See examples NF1-NF14.
- **GST basis** setting (invoice, payments or hybrid), used by the GST
  return.
- **GST return** (NZ GST101A, boxes 5-15) on the invoice, payments or hybrid
  basis, for 1, 2 or 6 whole calendar months, under Reports. Worked out from
  sales invoices, sales credit notes, bills, supplier credit notes and spend
  or receive money. On the invoice basis each document counts on its own
  date when approved and the other way on its void date; on the payments
  basis it counts when paid, credited or refunded, each line in proportion;
  the hybrid basis counts sales the invoice way and purchases the payments
  way; spend and receive money count on their date on every basis (examples
  G1-G22). Drafts, manual journals, stock movements and FX revaluations
  never count. After a change of basis the next return suggests IRD's IR546
  adjustment for debtors and creditors, added with one click. Lines go into boxes by their tax code's category
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
- **Bank accounts and reconciliation**. Bank and credit card accounts (any
  number, any bank) with a statement balance, the balance in Tohyee and a
  count of lines to reconcile. Statements come in as files (CSV and Excel
  with column mapping that's remembered per account, OFX/QFX/QBO, QIF,
  CAMT.053 and MT940; up to 10 MB) or through an **Akahu bank feed** (NZ),
  which can bring in history from a chosen start date (as far back as Akahu
  and the bank allow) and then syncs in the background. Duplicates are
  skipped; lines that look like a file-and-feed duplicate are flagged. Each
  line is reconciled by matching what's already posted (within 60 days),
  paying invoices or bills, creating spend or receive money (with GST), or a
  transfer between accounts; lines can be excluded, unreconciled and imports
  deleted. **Bank rules** fill in spend or receive money from text in the
  line. Each organisation sets up its own Akahu personal app (with its own
  bank logins) and an organisation admin enters its tokens, which are checked
  with Akahu and stored encrypted. See examples BK1-BK16.
- **Modules**: Accounting and Tax are always on; the **CRM** and
  **Advanced reporting** are switched on per organisation in Settings, and
  their menus and screens show only while on (MOD1).
- **CRM** (after [Twenty](https://github.com/twentyhq/twenty), built in):
  companies are the contacts, which can now also be **prospects**; **people**
  at each company; **opportunities** with Twenty's stages (plus Lost) on a
  drag-and-drop pipeline board, where a won one makes its draft invoice in
  one click (and makes a prospect a customer); **tasks** with due dates and
  assignees; logged **calls, meetings and notes**; and a **timeline** per
  company that also shows its invoices, credit notes, bills and payments.
  People, opportunities, tasks and activities are never deleted (CRM1-CRM9).
  **Email and calendar sync**: each member connects their own Gmail or
  Microsoft 365 mailbox (read-only, through the organisation's own Google or
  Microsoft app, tokens encrypted); every 15 minutes Tohyee keeps only the
  emails and meetings with known people and companies (subject and a short
  preview, never full bodies or attachments) and shows them on timelines,
  with each mailbox choosing whether the team sees subjects or only that
  something happened (MAIL1-MAIL9).
- **Advanced reporting** (formerly "Advanced (ERP) features") with
  **tracking categories**: Department, Class and Location, each a tree of
  values (Otago › Dunedin) that admins can rename, move and archive (never
  delete), and each optionally required on income and expense lines before
  approving or posting. Lines of invoices, bills, sales and supplier credit
  notes, spend and receive money and manual journals take one value per
  category; the tags go onto the posted journal lines and are copied onto
  voids and corrections. The profit and loss can be **split by** a category
  (a column per top-level value, "Not set" and the total), and a custom
  profit and loss can be **filtered** to one value and everything under it.
  Tags never change an amount, an account or a GST box. See examples
  TC1-TC10. Admins can add up to 20 **custom segments** of their own (like
  Grant or Project) that work the same way and can be archived (CS1-CS3).
  **Custom fields** (like NetSuite's) add the organisation's own fields to
  contacts (customers, suppliers or both), to the top of documents, or to
  their lines: text, long text, whole and decimal numbers, money, percent,
  date, check box, list, multiple select, email, phone and web address, each
  optionally required, with a default and shown as a column in lists.
  Fields and list options are archived, never deleted, and never reach the
  ledger (CF1-CF10). **Salespeople** (like NetSuite's sales reps): a default
  per customer and one on each sales invoice and credit note, and a **sales
  by salesperson** report (excluding GST, voids on their void date, each row
  opening to its documents) that ties to income (SR1-SR8). Team selling and
  commissions aren't built. **Richer customers** (like NetSuite's): a
  **credit limit** per customer, checked when an invoice is approved against
  their balance (unpaid invoices less unused credit notes and overpayments)
  plus the invoice, either warning (the default; approved and said so) or
  blocking, per organisation; **contact people**, the CRM's people at the
  company, one of them the primary contact for invoices (also with only this
  module on); **customer groups**; **price levels** (a percent on or off the
  base price, used once items arrive); and **parent customers** (no loops,
  at most 4 levels) with aged receivables and customer statements rolled
  up (RC3-RC12, CST3). With it on, items also get NetSuite's extras
  (below). The **GST audit report** (step 5, above) is for everyone.
- **Products and services** (Sales, like Xero's items, for everyone): a
  code (unique ignoring case), name, description, sale and purchase prices,
  income and purchase accounts and sales and purchase tax codes; service,
  non-stock and stock types; archived, never deleted. Picking an item on an
  invoice, bill or credit note line fills its description, price, account
  and tax code, all still editable on a draft; lines without an item work as
  before. With **Advanced reporting** on, NetSuite's extras: **units of
  measure** (a base unit and fixed multiples like "Box of 12"; lines keep
  the unit and the exact quantity in the base unit), **price levels**
  pricing items (the level's percent, rounded to cents, or the item's own
  price for that level) from the customer's default level, **supplier
  prices** (one preferred) filling bills, and **kits** (bundles of other
  items; no kits in kits). Stock items move stock (ST1-ST12, above). See
  examples IT1-IT9.
- **Two-step sign-in** for everyone: an authenticator app (QR code set-up)
  plus 10 one-use backup codes; wrong-code limits and lockout; lost-phone
  reset by emailed link, by a server admin, or from the command line; new
  backup codes from your profile.
- **Server email** (Gmail or other SMTP, password encrypted) for security
  alerts and two-step reset links, with a test button.
- **Remote access** through a Cloudflare Tunnel (in the server settings):
  paste the tunnel token, Tohyee runs Cloudflare's connector and shows its
  status; needs two-step sign-in to be in force.
- **Update check** against GitHub releases.

## Not built yet, on purpose

These only arrive as working features. A screen that just records a status
someone types in (for example "backup completed") without doing the work
isn't acceptable, because people would trust it:

- switching people over to a restored copy (restores make a new
  organisation; moving people or retiring the original is done by hand)
- update runs and recovery incidents
- export jobs and downloads
- job executions
- AI suggestions
- import staging (other than bank statements)
- bank feeds from providers other than Akahu, foreign-currency bank
  accounts, splitting one posted transaction across several statement
  lines, and old Excel (.xls) files
- GST: deferred-payment supplies of $225,000 or more on the payments basis
  (section 19D), checking payments-basis eligibility, and bad debt write-offs
- amending a filed GST return, imported goods (Customs GST), GST rates other
  than 15%, recording the GST payment or refund to IRD, and filing to IRD
  electronically
- stock "recomputation", and transfers between locations

## Next, in rough order

The owner's to-do list in [TODO.md](TODO.md) comes first.

1. Supplier overpayments and prepayments (once the owner has decided how GST works
   on them). Emailing invoices, credit notes, quotes and statements comes
   with or after these (they print already).
2. Backdated stock movements with proper re-costing.
3. Stock depth: transfers between locations, bins, lots and serial
   numbers, variants, assemblies, stock takes (the item list, locations and
   kits are built).
4. NZ payroll, fixed assets, projects and time tracking.
5. Multi-currency transactions.

## Guardrails

- Accounting behaviour follows `docs/ACCOUNTING-EXAMPLES.md`. New behaviour
  needs a worked example with numbers and a test before it ships.
- AI output, when it arrives, is suggestion-only and never posts on its own.
- Don't add screens or APIs that only record statuses a person types in.

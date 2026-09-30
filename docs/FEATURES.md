# Tohyee feature scope

What's built, what's intentionally not, and what comes next. "Built" means it
works end to end and has tests; nothing is listed as built if it only records
that something happened.

## Built

- **Organisations**, each with its own PostgreSQL database, created and
  repaired by server admins.
- **Server settings apart from the books** (organisations, users, remote
  access, email, updates), open only on the server computer itself. On
  Windows they're in the **Tohyee server app**: an icon by the clock (the
  logo with a green, amber or red dot; started when you sign in, like a
  media server's) that shows whether Tohyee is running, restarts it, backs it
  up and opens the logs, and a dark window for the settings with a sidebar
  (Home, Organisations, Users, Phone access, Backups, Email, Updates). **Home**
  shows whether the server is running (version, how long it's been up),
  phone access, the last backup and the organisations at a glance, the latest
  Tohyee news (GitHub releases plus announcements from `website/news.json`,
  fetched at most every four hours and kept for when the computer is
  offline) and a (light-hearted) conference card. On Docker and Linux they're a **command-line tool**
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
- **General ledger**: manual journals in the base currency (lines on
  foreign-currency accounts also carry the foreign amount and rate), corrections by
  reversal and replacement, period close (below), idempotent
  posting, database-enforced balancing and append-only history.
- **FX revaluation** of foreign-currency asset and liability accounts, with
  carrying amounts and (where Tohyee has them) foreign balances taken from
  the ledger, and automatic next-day reversal; also the open
  foreign-currency invoices, bills and credit notes on accounts receivable
  and payable, one currency at a time (MC8).
- **Multi-currency invoices, bills, credit notes and payments** (built
  overnight 1 Oct 2026 following NetSuite, examples MC1-MC13 not yet approved
  by Jess): a contact has a currency (like NetSuite's primary currency); its
  documents are in it at a rate for their date (the last rate used,
  changeable), each line converted to NZD on its own; accounts receivable
  and payable carry the foreign amount beside the NZD; payments are in the
  document's currency into or from a bank account in that currency or NZD, at
  their own rate, with the realised gain or loss on 7020; credit notes applied
  at another rate realise the difference; aged receivables and payables and
  customer statements show the document currency and NZD; overpayments,
  applying them, and refunds of overpayments, credit notes and supplier
  credit notes are in the document's currency at their own rate, realising
  the difference on 7020 (MC14-MC19); one payment can pay several of a
  contact's foreign documents at one rate, each with its own gain or loss
  (MC20-MC24); quotes, repeating invoices and bills and purchase orders are
  in the contact's currency with no rate, and the invoice or bill made from
  them takes a rate for its own date (MC25-MC28; repeating ones save
  drafts). Zero-rated, exempt and no-GST codes only.
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
  by item and location beside the ledger. **Transfers between locations**
  (Stock screen; TR1-TR6, not yet approved by Jess) move a quantity at the
  from-location's average cost (the whole remaining value when all of it
  goes) with a journal moving the value between the locations on the
  inventory account, whose total never changes; the negative stock
  setting, backdating and period locks are respected.
- **Reports**: trial balance, profit and loss, balance sheet, stock valuation,
  aged receivables and payables, account transactions, the journal report,
  customer statements, the GST return and GST audit report (below).
  The financial year end is a setting (default 31 March); the balance sheet
  shows current year earnings and retained earnings (the retained earnings
  account plus all earlier years' profit), with no closing journals, like
  NetSuite (YE1-YE4, not yet approved by Jess). The **trial balance** is
  NetSuite's (TB1-TB4, decided 1 Oct 2026, not yet approved): income and
  expense accounts show this financial year to date, and earlier years'
  profit is in retained earnings, so it matches the balance sheet and still
  balances.
- **Period close** (Accounting; PC1-PC12, not yet approved by Jess), like
  NetSuite's period close checklist: each financial year and its months,
  Open or Closed; for a month, checks Tohyee works out itself (bank accounts
  reconciled to the month end, no drafts dated in it, depreciation run,
  foreign-currency balances revalued, stock equals 1400 and nothing below
  zero, receivables and payables equal their control accounts, GST returns
  filed by the GST period setting, the opening balance account at 0.00),
  each with a link to fix it. A bank account with no statement is a
  warning an owner or admin can accept, not a block (as in NetSuite).
  Closing locks everything up to the month end (the database refuses
  journals dated in it); months are closed in order. Bookkeepers close
  when every check passes; with warnings only owners and admins, after
  confirming. Owners and admins reopen with a reason, which reopens every
  later month; closes, reopens, reasons and accepted warnings are in the
  audit log. It replaces the old lock date and unlock window on Settings.
  The financial year end can't change while a year is closed.
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
  deleted. "Print or save as PDF" prints just the report. A profit and loss
  can show a **budget column** and **actual less budget** (BU7). See
  examples CR1-CR10.
- **Budgets** (Reporting; BU1-BU8, not yet approved by Jess), like Xero's
  budget manager: every organisation has an **overall budget**, and can add
  **named budgets**, each optionally for one tracking value (a Department,
  or a grant or segment as a custom segment). Each holds an amount per
  profit and loss account per month, typed or **quick filled** (the same
  amount each month, optionally changing by a % each month, or last year's
  actuals, optionally changed by a %). Budgets post nothing, are archived
  (never deleted), and every change of amounts is in the history with the
  amounts before and after. **Budget vs actual** shows actual, budget,
  variance and variance % per account with section totals, gross and net
  profit, for whole months; a budget for a tracking value compares with
  only that value's lines. Balance sheet budgets aren't built.
- **Contacts**: customers and suppliers with optional email, phone, postal
  (billing) address and GST number (format-checked only); search by name or
  email; archiving instead of deleting. Customers are used by sales invoices
  and suppliers by bills. Customers also have a delivery address and
  **payment terms** (N days after the invoice, N days after the end of the
  month, or day N of the following month; six NZ defaults to start, archived
  never deleted), and a new invoice's due date comes from them (still
  editable on the draft). See examples RC1, RC2. **Suppliers** have their
  own payment terms from the same list (like the Terms on NetSuite's vendor
  record): a new bill's due date comes from them (still editable on the
  draft), and repeating bills and copy to bill use them. See examples
  SPT1-SPT5 (not yet approved by Jess).
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
  with the browser's print, or emailed as a PDF (below).
- **GST audit report** (Tax; GA1-GA4, not yet approved): for a GST period
  on the organisation's basis, or a filed return as filed, every document
  behind Box 5, 6 and 11, the Box 9 and 13 adjustments and the lines left
  out, grouped from the GST return's own lines so each list adds up to its
  box to the cent. Each of these five reports has "Print or save as PDF".
- **Tax codes** as settings. Sales invoices and bills apply them; manual
  journals don't. A new organisation starts with the standard NZ codes
  (GST 15%, Zero rated, Exempt, No GST, from 1 Oct 2010); existing
  organisations with no codes at all were given them by migration 0031.
- **Sales invoices** in the base currency (or the customer's currency, MC1-MC13): drafts that can be edited and
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
  copying makes a new draft. Quotes post nothing. A quote shows **Sent**
  only once an email of it has been accepted by the email server (below); its
  status doesn't change.
- **Repeating invoices** (Sales; RI1-RI10, not yet approved): a template
  with invoice lines, every N weeks or months from a start date to an
  optional end date, due by payment terms or N days, and each invoice saved
  as a draft or approved. A background job (hourly, and "Run now") makes each
  date's invoice once, catching up missed dates in order; the database key
  on (template, date) means two runs never make two. A refused approval
  (locked period, credit limit, required field) leaves the draft with the
  reason in the template's history. Pause, resume (paused dates are
  skipped) and end.
- **Repeating bills** (Purchases; RB1-RB12, not yet approved by Jess), like
  Xero's repeating bills and made by the same scheduler as repeating
  invoices: a template with a supplier and bill lines (items fill the
  supplier's price; stock items need a Location once locations are in use),
  a supplier invoice number pattern with {date}, {month} or {n} so each
  bill's number is its own, or no pattern, so each bill is a draft without
  a number to complete from the real invoice (RB11), a due date rule (the
  supplier's payment terms, N days after the bill date, N days after the
  end of its month, or day N of the following month), every N weeks or
  months, and each bill saved as a draft or approved. The hourly job and "Run now" make each
  date's bill once, catching up missed dates; a number the supplier already
  has stops the template at that date with the reason. Pause, resume and
  end; a history of the bills made, linked both ways. Nothing is paid
  automatically.
- **Printed invoices, credit notes and quotes** (PD1-PD8, not yet
  approved): "Print or save as PDF" with the browser's print, showing the
  organisation's name, address and GST number (set in Settings), the
  customer and billing address, the lines with GST, the totals, and on
  approved invoices what's paid, what's due and how to pay. Approved invoices
  from a GST-registered organisation print as **Tax invoice**; drafts, voided
  invoices and quotes say so. The screen warns when a tax invoice over $1,000
  has no customer address, or GST is charged with no GST number in Settings.
  Emailed as a PDF (below).
- **Purchase orders** (Purchases; PO1-PO9, not yet approved by Jess): drafts
  to a supplier with the same lines as a bill (items fill the supplier's
  price), a delivery date, address and instructions; approving numbers them
  (`PO-0001`, no gaps) and locks them (the database refuses changes). They
  post nothing. **Copy to bill** makes a draft bill with what's still to
  bill on each line, linked back line by line; a purchase order can be
  billed in parts, shows what's billed and on draft bills per line, and is
  **billed** once approved bills cover it, worked out from the bills
  (voiding or deleting a bill puts its quantities back). Linked bill lines
  keep their item, the bill keeps its supplier, and bills can't add up to
  more than was ordered (the database refuses too). An approved purchase
  order with no bills can be cancelled. Stock comes in on the bill (ST1).
  "Print or save as PDF" like quotes, or emailed as a PDF (below).
- **Expense claims** (Purchases; EC1-EC12, not yet approved by Jess), like
  Xero's older expense claims: a member enters the receipts they paid for
  themselves (date, supplier, description, account, tax code, amount
  including GST, optional tracking) and attaches the receipts as files;
  submits the claim; a bookkeeper or admin approves it (not their own,
  unless they're an admin or owner), which posts Dr each expense account
  and GST / Cr **Expense claims payable** (2010, a new system account) on
  the claim date, or declines it back with a reason. Paying it (in full or
  in parts, from a bank account) clears the liability and matches in bank
  reconciliation; payments and unpaid approved claims can be voided (exact
  reversals). Locked periods apply. The GST return counts claims like
  bills (receipts with no tax code are left out). Mileage, batch payments
  and a submit-only role aren't built.
- **Fixed assets** (Accounting; FA1-FA14, not yet approved by Jess), like
  Xero's fixed asset register: **asset types** (admins) with their asset,
  accumulated depreciation and depreciation expense accounts and a default
  method and rate that the organisation types in (no built-in IRD rates);
  **assets** numbered `FA-0001`, registered from an approved bill line
  (the cost excluding GST, never more than the line; the bill can't then be
  voided) or typed in, optionally with opening accumulated depreciation at
  a month end for bringing in an existing register; registering posts
  nothing. **Diminishing value**, **straight line** or **no depreciation**,
  in whole months, never below a residual value, with settings for whether
  the months of purchase and disposal count. **Depreciation runs** to a
  month end post one journal (Dr depreciation / Cr accumulated depreciation
  per asset type and tracking), go forward only, catch up assets registered
  late, and the latest can be rolled back. **Disposals** (sale or write-off)
  charge depreciation to the disposal, take off cost and accumulated
  depreciation, clear the proceeds from the account the sale was coded to
  and post the loss, depreciation recovered or capital gain (7030, 7040 by
  default); they can be undone. The **fixed asset register** (Reporting)
  shows each asset's cost, accumulated depreciation, book value and this
  year's depreciation by type, disposals this year, and ties to the ledger
  account by account. Tax depreciation beside book, pooling and low-value
  write-offs aren't built.
- **Projects and time tracking** (Sales; PJ1-PJ13, not yet approved by
  Jess), like Xero Projects: a **project** for a customer with an optional
  estimate and deadline, **In progress** or **Closed** (only by closing and
  reopening). **Tasks** are hourly (a rate), fixed price or non-chargeable,
  with an optional estimate in hours, archived never deleted. **Time** is
  entered in hours and minutes and kept as whole minutes, by each member
  for themselves (admins can enter it for another member); admins set each
  member's **staff cost rate**, copied onto their time as its cost.
  **Expenses** are linked from approved bill lines, expense claim receipts
  and spend money lines coded to expense or direct cost accounts (PJ13) at
  cost excluding GST (never re-posted), chargeable
  or not, with an optional markup; while linked, their document can't be
  voided. **Invoice** makes a draft sales invoice from the ticked unbilled
  items (time grouped per task at its rate, fixed prices, expenses with
  markup) to one income account and tax code, and links each item so it
  can't be invoiced twice; voiding the invoice or deleting the draft makes
  them unbilled again. **Closing** is refused while anything is unbilled or
  on a draft invoice, unless the unbilled items are written off; a closed
  project takes nothing new and its invoices can't be voided until it's
  reopened. **Project profitability** (invoiced less expenses at cost and
  time at cost, draft invoices, unbilled, written off, estimate left) and
  the **time report** (by person, project and task for a date range) are
  under Reporting. Projects post nothing; only their invoices do. A timer,
  deposits and progress billing aren't built.
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
- **Bills** from suppliers in the base currency (or the supplier's currency, MC10): drafts that can be edited and
  deleted, with the supplier's invoice number (a supplier can't have two bills
  that aren't voided with the same number, ignoring case and spaces; a draft
  can wait for it, approving needs it, B9),
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
- **Sales credit notes** in the base currency (or the customer's currency, MC7): drafts with the same lines,
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
- **Supplier credit notes** in the base currency (or the supplier's currency, MC10): drafts with the same lines,
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
- **GST filing frequency** setting (monthly, two-monthly ending in odd or
  even months, or six-monthly ending in a chosen pair of months), like
  NetSuite's tax periods: the GST return opens on the next period, and Home
  and the period close use it (GP1-GP6, not yet approved by Jess).
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
  with Akahu and stored encrypted. See examples BK1-BK16. **One-click
  matching** (like Xero's OK): a line whose only exact-amount candidate (a
  posted transaction on the account, or an invoice or bill due) isn't wanted
  by another line, or that only a bank rule fits, shows the suggestion
  highlighted with an **OK** button, and **OK all confident matches** does
  them all, each line on its own, reporting what failed and why (examples
  BK17-BK19, not yet approved by Jess). The **bank reconciliation report**
  (Reporting, and linked from each account) shows, as at a date, the
  statement balance (from the bank's running balances or the feed's
  balance), the balance in Tohyee, statement lines not yet in Tohyee and
  transactions in Tohyee not yet on the statement, with the arithmetic and a
  warning when they don't fully explain the difference; it prints or saves as
  PDF (examples BK20, BK21, not yet approved by Jess). **Bulk coding**
  ("cash coding"): tick several lines to reconcile and give them an account,
  GST code and optionally a contact, description and tracking, for all of
  them or line by line; each becomes its own spend or receive money
  reconciled to its line, exactly as if done one at a time, each in its own
  transaction, and the result says which lines were done and why any weren't
  (examples BK22, BK23, not yet approved by Jess). **Small differences**:
  when matching a line or paying invoices or bills from it and the amounts
  differ slightly (a merchant fee taken off a deposit), the difference can be
  recorded in the same step as an adjustment to a chosen account, with an
  optional GST code: spend or receive money for the difference, reconciled
  with the payment or match so the line ties exactly, while the invoice or
  bill is still paid in full (examples BK24, BK25, not yet approved by Jess).
  **One transaction on several lines**: when the bank shows one posted
  payment or deposit as two or more lines, the lines can be reconciled
  together against it ("Part of one transaction"), each to its part; they
  must add up to it exactly (no adjustment), nothing is posted, and
  unreconciling any of them unreconciles them all. One-click OK never
  suggests one, and the reconciliation report counts only the part on lines
  by its date (examples BK26-BK28, not yet approved by Jess).
  **Foreign-currency bank and card accounts** (following NetSuite, as Jess
  decided): every posting keeps the foreign amount, the NZD amount and the
  rate; statement files are imported in the account's currency (a file in
  another currency is refused); each line shows its NZD value at the last
  rate used for that currency (filled in, changeable); spend and receive
  money (zero-rated, exempt or no GST), matching, one-click OK, bulk coding
  and the reconciliation report work in the account's currency with NZD
  beside it; transfers to and from NZD accounts take both amounts, money
  leaving at its carrying value with the difference a realised gain or loss
  (7020); an account with postings from before gets its foreign balance
  entered once as at a date; revaluation uses the stored foreign balance
  (examples FXB1-FXB11, not yet approved by Jess).
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
- **Import and export** (Accounting > Settings, admins and owners; examples
  IM1-IM21, not yet approved by Jess): a wizard following NetSuite's import
  assistant for bringing in existing books: upload CSV or Excel, map columns
  (automatic for Tohyee's own columns and for Xero-style exports, labelled
  "From another accounting system"; remembered per organisation), check
  every row, then import the whole file in one transaction or nothing. Steps:
  chart of accounts (by code; Tohyee's own control accounts keep their type
  and can take the other system's code), contacts (by name, with addresses,
  GST number, payment terms and custom fields), products and services (by
  code), then opening balances as at a conversion date: the trial balance,
  stock on hand, and open invoices and bills, posted together once through
  3900 Opening balance (equity, like NetSuite's and Xero's opening
  balance accounts, decided with Jess 30 Sep 2026) so accounts receivable,
  payable and inventory equal their documents and stock; open invoices keep
  their numbers and stay out of sales reports. Open invoices and bills carry
  the GST in what's still owed (a GST column, the whole invoice's GST with
  its total, or a GST code), as in Xero: on the payments basis (and for
  purchases on the hybrid basis) paying them after the conversion puts the
  paid share of their GST in that period's return; on the invoice basis it
  was returned before, so never again. The check shows how the GST account's
  opening balance splits between the old returns and the open documents. A final check compares the trial
  balance at the conversion date with the imported one and locks the period.
  Accounts get a usual GST code, filled in when the account is picked on a
  line. The chart of accounts, contacts and items export as CSV.
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
- **Emailing documents** (decided by Jess, 30 Sep 2026): invoices, credit
  notes, quotes, purchase orders and customer statements are emailed from
  **each organisation's own email account** (Settings > Email, admins:
  **Microsoft 365 / Outlook (sign in)**, decided with Jess 30 Sep 2026 since
  Microsoft is retiring password SMTP: the organisation registers its own
  Microsoft app once (shared with the CRM's mail sync), an admin clicks
  **Connect Microsoft account** and signs in to the mailbox, which then sends
  for the organisation through Microsoft Graph with the Mail.Send permission,
  showing the connected address, with Disconnect; or **SMTP**: Gmail or
  Google Workspace with an app password, Microsoft 365 with Authenticated
  SMTP, or any SMTP server; from name, from address, reply-to; the password
  and tokens encrypted with TOHYEE_SECRET_KEY and never sent back to the
  browser; a **Send test email** button). Emails are **HTML** with the
  organisation's **logo** (Settings: PNG or JPEG up to 512 KB, stored in
  the organisation's database so backups have it; embedded in the email,
  never a remote image), the message as paragraphs, a box with the
  document's number, total and due date, and the organisation's contact
  details, plus the plain text for mail clients that want it; templates stay
  plain text with placeholders. The logo is also top left on the PDFs and
  print pages. Each document has an **Email** card
  (bookkeepers and above send; everyone sees the history): To (the contact's
  email and its primary person's), Cc, subject and message from the
  organisation's **templates** (editable in Settings > Email, with
  {contact}, {number}, {total}, {amount due}, {due date}, {organisation} and
  so on), and the PDF's name. The PDF is written on the server with the
  same figures as the print page (pdf-lib, pure JavaScript, so it works on
  the Windows install). Sending is a background job: an email is **Sent**
  only when the SMTP server accepted it (its message id is kept); a busy or
  unreachable server is tried again after 1, 5 and 30 minutes; a wrong
  password or refused address fails straight away with the reason in plain
  English, and **Send again** is offered. Each email is recorded in the
  document's history (the contact's for statements) with who asked, when
  and to whom. Only approved invoices and credit notes, finalised quotes and
  approved purchase orders can be emailed. **Statements** go to one customer,
  or to **every customer with a balance** (a preview shows who gets one and
  at which address, and who is skipped for having no email address; then a
  result per customer). Limits: 100 emails an hour and 500 a day per
  organisation. Addresses are plain `name@domain` only and line breaks are
  taken out of subjects, so nothing typed can add a header; the only
  attachment is the document's own PDF; internal notes are never included.
  Not built: signing in with Google to send (a possible follow-up; Gmail
  uses an app password for now), attachments over 3 MB through Microsoft
  (Graph's upload sessions), and tracking whether the email was opened
  (never: no tracking pixels).
- **Phone access (remote access)**, three ways, one on at a time (switching
  asks first and turns the other off), all needing two-step sign-in to be in
  force (decided with Jess, 30 Sep 2026):
  - **Tohyee address** (recommended for most; Windows server app → Phone
    access, or `remote-access address --on`): one click, no sign-up. The
    server asks the Tohyee address service (a Cloudflare Worker the project
    runs; `TOHYEE_ADDRESS_SERVICE_URL`, placeholder
    `https://relay.tohyee.example` until it's deployed) for an address and a
    Cloudflare tunnel token, stores the token and release key encrypted (and a
    random install id, so asking again gets the same address), and runs
    Cloudflare's connector. Turn off keeps the address; giving it back
    releases it. Says "The Tohyee address service isn't available yet" while
    it can't be reached. Tested against a stand-in for the service; the real
    service isn't built in this repository.
  - **Your own domain (Cloudflare)** (free for businesses; needs a domain on
    Cloudflare): the Windows server app's Connect to Cloudflare signs in to
    Cloudflare in the browser (`cloudflared tunnel login`), asks for the name
    and domain, makes the tunnel, adds the DNS name and hands the tunnel's
    token to the server, which runs Cloudflare's connector pointed at
    Tohyee's port. Pasting a tunnel token from Cloudflare's dashboard still
    works. The cloudflared steps still need trying on a real Windows computer
    with a real Cloudflare account.
  - **Tailscale Funnel** (Windows server app → Phone access): the simplest
    set-up, but Tailscale's free plan is for non-commercial use only;
    businesses need a paid Tailscale plan (from US$8 per user a month). One
    button installs Tailscale from Tailscale's package server if needed
    (checksum checked, unattended mode so it works before anyone signs in to
    Windows), signs in to Tailscale in the browser, records the address on
    the server (which refuses without two-step sign-in), and turns Funnel on
    for Tohyee's port in the background so it survives restarts. Tohyee
    doesn't store any Tailscale login. The server tests cover requests
    arriving through Funnel; the Tailscale steps themselves still need trying
    on a real Windows computer.
  Each shows the address with a QR code, Copy address, Open and Turn off.
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
- import staging (other than bank statements and the one-file-at-a-time
  import checks, which save nothing), and importing transactions from before
  a conversion date
- bank feeds from providers other than Akahu, Akahu feeds for
  foreign-currency accounts (Akahu's transactions don't say their currency),
  an adjustment when splitting one posted transaction across several
  statement lines, and old Excel (.xls) files
- on foreign-currency documents (MC11): standard-rated GST, supplier
  overpayments, payments through a bank account in a third currency, stock
  items, project and CRM invoices, approving repeating ones automatically,
  and sales on the payments GST basis; also paying NZD
  documents from a foreign-currency statement line, standard-rated GST on
  foreign-currency spend and receive money, adjustments on foreign-currency
  lines, and transfers between two foreign-currency accounts
- GST: deferred-payment supplies of $225,000 or more on the payments basis
  (section 19D), checking payments-basis eligibility, and bad debt write-offs
- amending a filed GST return, imported goods (Customs GST), GST rates other
  than 15%, recording the GST payment or refund to IRD, and filing to IRD
  electronically
- stock "recomputation" (transfers between locations are built; editing or
  voiding a transfer, and transfers in transit, aren't)

## Next, in rough order

The owner's to-do list in [TODO.md](TODO.md) comes first.

1. Supplier overpayments and prepayments (once the owner has decided how GST works
   on them).
2. Backdated stock movements with proper re-costing.
3. Stock depth: bins, lots and serial
   numbers, variants, assemblies, stock takes (the item list, locations and
   kits are built).
4. NZ payroll.
5. The rest of foreign-currency documents (MC11): foreign-currency bank
   accounts, invoices, bills, credit notes and payments are built.

## Guardrails

- Accounting behaviour follows `docs/ACCOUNTING-EXAMPLES.md`. New behaviour
  needs a worked example with numbers and a test before it ships.
- AI output, when it arrives, is suggestion-only and never posts on its own.
- Don't add screens or APIs that only record statuses a person types in.

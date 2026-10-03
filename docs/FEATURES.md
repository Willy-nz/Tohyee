# Tohyee feature scope

What's built, what's intentionally not, and what comes next. "Built" means it
works end to end and has tests; nothing is listed as built if it only records
that something happened.

## Built

- **Organisations**, each with its own PostgreSQL database, created and
  repaired by server admins.
- **The look (2026 redesign, 3 Oct 2026):** a simpler top bar where each menu opens a short grouped panel, one **+ New** button for every "New …" action, a **search / command palette (Ctrl+K)** for any screen, an **AI** item, light and dark themes that follow the computer (switch in the user menu), the Inter font with tabular figures, and a short fade between pages. Reports and printed documents stay on white paper.
- **Server settings apart from the books** (organisations, users, remote
  access, email, updates), open only on the server computer itself. On
  Windows they're in the **Tohyee server app**: an icon by the clock (the
  logo with a green, amber or red dot; started when you sign in, like a
  media server's) that shows whether Tohyee is running, restarts it, backs it
  up and opens the logs, and a dark window for the settings with a sidebar
  (Home, Organisations, Users, Remote access, Backups, Email, Stats, Updates). **Home**
  shows whether the server is running (version, how long it's been up),
  remote access, the last backup and the organisations at a glance, the latest
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
- **Payroll employee records** (PE1-PE12; examples not yet approved by Jess):
  employee details, pay frequency, tax code, student loan and KiwiSaver
  settings; IRD numbers and bank accounts are encrypted. Employees are
  archived, never deleted. Job title, reports-to, pay groups (each with a pay
  frequency) and employee groups. **Pay rate history**: salary or hourly rate
  from a date, kept for ever; the current rate is the one in effect today.
  **Cost allocation**: where each employee's pay is charged, split by % across
  Department, Class, Location, a project and an R&D activity from the R&D
  register, totalling exactly 100.00%, from a date, keeping the history;
  the employee list shows each person's primary department. Splitting an amount
  shares out the cents so the parts always add back to the whole. **Payroll
  access**: only members an admin has given it to (bookkeeper or higher) can
  see or change any of this; the first owner has it to start with. Pay runs,
  paying wages and IRD, bank files, payslips, the payday filing file,
  timesheets, payroll reports and Holidays Act leave are below.
- **Chart of accounts** with account classes and types, a starting NZ chart,
  archiving, and foreign-currency accounts.
- **General ledger**: manual journals in the base currency (lines on
  foreign-currency accounts also carry the foreign amount and rate), corrections by
  reversal and replacement, period close (below), idempotent
  posting, database-enforced balancing and append-only history.
- **FX revaluation** of foreign-currency asset and liability accounts, with
  carrying amounts and (where Tohyee has them) foreign balances taken from
  the ledger, and automatic next-day reversal; also the open
  foreign-currency invoices, bills, credit notes and overpayments on
  accounts receivable and payable, one currency at a time and, like
  NetSuite, each document on its own at its own rate, listed on the
  revaluation (MC8, MC39-MC43).
- **Multi-currency invoices, bills, credit notes and payments** (built
  overnight 1 Oct 2026 following NetSuite, examples MC1-MC13 not yet approved
  by Jess): a contact has a currency (like NetSuite's primary currency); its
  documents are in it at a rate for their date (from the exchange rates
  list, else the last rate used; changeable), each line converted to NZD on
  its own; accounts receivable
  and payable carry the foreign amount beside the NZD; payments are in the
  document's currency into or from a bank account in that currency or NZD, at
  their own rate, with the realised gain or loss on 7020; credit notes applied
  at another rate realise the difference; aged receivables and payables and
  customer statements show the document currency and NZD; overpayments,
  applying them, and refunds of overpayments, credit notes and supplier
  credit notes are in the document's currency at their own rate, realising
  the difference on 7020 (MC14-MC19); one payment can pay several of a
  contact's foreign documents at one rate, each with its own gain or loss
  (MC20-MC24); quotes, sales orders, repeating invoices and bills and purchase orders are
  in the contact's currency with no rate, and the invoice or bill made from
  them takes a rate for its own date (MC25-MC28; repeating ones are approved
  automatically only at a rate from the exchange rates list); stock items on foreign-currency documents are valued in NZD at
  the document's rate, and cost of sales is the NZD average (MC29); like
  NetSuite, the cent or two left by rounding when a payment, credit or
  refund settles a foreign document goes to 7050 Rounding gains and losses,
  apart from the realised gain or loss on 7020 (MC31-MC38);
  projects and CRM opportunities for a customer in another currency are in
  it, and so are the invoices made from them (MC61-MC70).
  Any GST code, standard-rated included (built overnight 1 Oct 2026
  following NetSuite and IRD, examples MC71-MC83 not yet approved by Jess):
  GST is worked out in the document's currency and each line's GST
  converted at the document's rate, posted to 2100 in NZD and never changed
  by payments or revaluations; the GST return and GST audit report count
  the NZD amounts, and bills on the payments or hybrid basis their NZD share
  at the bill's rate; the documents' screens show the NZD GST beside the NZD
  total.
- **Currency exchange rates list** (built overnight 1 Oct 2026 following
  NetSuite's Currency Exchange Rates, examples MC46-MC53 not yet approved by
  Jess): Accounting › Exchange rates keeps rates for each foreign currency
  with the date each takes effect (NZD per 1 unit), added one at a time or
  pasted from a spreadsheet by bookkeepers, admins and owners, audited, and
  corrected by a newer entry or archiving (never changed or deleted). New
  foreign-currency invoices, bills, credit notes, payments, refunds, bank
  statement lines, accepted quotes and copied purchase orders start with the
  rate in effect on their date (else the last rate used); foreign repeating
  invoices and bills are approved automatically when the list has a rate for
  their date (else left as drafts saying why); FX revaluation suggests the
  list's closing rate. No automatic daily feed (a question for Jess).
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
- **A tax code's "Available on"** (built overnight 1 Oct 2026 following
  NetSuite, examples TAO1-TAO12 not yet approved by Jess): **Sales**,
  **Purchases** or **Both**, chosen when a code is added and changed by
  admins on the Tax codes screen (audited). Every existing and starting NZ
  code is Both. Sales lines (invoices, credit notes, quotes, repeating
  invoices, receive money, project and CRM invoices) take only Sales or Both
  codes, purchase lines (bills, supplier credit notes, purchase orders,
  repeating bills, spend money, expense claims) only Purchases or Both,
  checked on save and approval; approved documents are never checked again,
  and a draft with a code no longer on its side is refused until it's
  changed. Editors list only the codes for their side. Contact defaults,
  items' codes, bank rules and the tax code for exports must be on their
  side, and a code's Available on can't change while one of those uses it on
  the side it would lose (the refusal lists them).
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
  status doesn't change. A finalised quote can instead be **accepted as a
  sales order** (SO9).
- **Sales orders, stage 1** (Sales; SO1-SO12, not yet approved by Jess),
  following NetSuite's sales orders: drafts to a customer with the same
  lines as an invoice (items, units, price levels, tracking, custom fields,
  salesperson), an order date, an optional expected date, a reference and a
  memo; made by hand or by accepting a quote. Approving numbers them
  (`SO-0001`, no gaps) and locks them (the database refuses changes). They
  post nothing and don't change stock or GST. **Invoice** makes a draft
  invoice for what's left on each line, or less for a part invoice, each
  line linked back to its order line. What's invoiced per line is worked out
  from approved linked invoices (draft ones shown separately), never typed;
  voiding an invoice or deleting a draft gives its quantities back. Linked
  invoice lines keep their item and unit, the invoice keeps its customer,
  and invoices can't add up to more than was ordered on a line (the
  database refuses too). The status (draft, pending billing, partly billed,
  billed, closed, cancelled) is worked out from those figures; an approved
  order can be **closed** (nothing more to invoice; not while it has draft
  invoices) or **cancelled** (only with no invoices other than voided
  ones). In the customer's currency with no rate; each invoice takes a rate
  for its own date (SO10). Cost of sales is still posted when the invoice is
  approved. Not yet: reserving stock, deliveries, line discounts, editing an
  approved order, closing single lines, printing or emailing orders, and CRM
  or Shopify orders.
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
- **Purchase orders** (Purchases; PO1-PO10, not yet approved by Jess; "Close
  the rest" of a part-billed one, decision 281): drafts
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
  deposits and progress billing aren't built. A project is in its
  **customer's currency** (built overnight 1 Oct 2026 following NetSuite,
  MC61-MC70 not yet approved by Jess): for a USD customer its rates, prices,
  estimate and invoices are in USD (at a rate for the invoice's date), while
  staff and expense costs and profit stay NZD; its expenses are costs only.
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
- **Exports and the tax code for overseas customers** (built overnight 1 Oct
  2026 following NetSuite, examples EX1-EX15 not yet approved by Jess).
  Contacts have a **billing country** and an optional **delivery country**
  (ISO codes chosen by name; New Zealand unless set; in the contacts CSV
  import and export), and customers an optional **default sales tax code**.
  Settings › Exports (admins, audited): **Foreign trade** (off to start
  with) and the **Tax code for exports** (ZERO to start with; only an active
  zero-rated code, since exports are zero-rated, not exempt, and go in Box 5
  and Box 6). A new sales line (invoices, credit notes, quotes, repeating
  invoices, project and CRM invoices, item lines) starts with the
  customer's own code, else, with Foreign trade on and the customer outside
  New Zealand by delivery (else billing) country, the tax code for exports,
  else the usual default as before. It's only a starting value: lines can be
  changed and saved documents never change. The currency doesn't decide it.
  Sales documents for an overseas customer show **Export (country)**, and
  with Foreign trade on a standard-rated line shows a warning that never
  blocks, only where lines can still be changed (editors and drafts; not on
  approved documents, decided 1 Oct 2026, EX25).
- **A supplier's default purchase tax code** (built overnight 1 Oct 2026
  following Xero's contact "Purchase defaults", examples EX16-EX25 not yet
  approved by Jess). Contacts have an optional **default purchase tax code**
  (any active code available on purchases; inactive ones refused; audited), separate from the
  default sales tax code. A new line on a bill, supplier credit note,
  purchase order, repeating bill or spend money starts with it, beating the
  item's and the account's usual code; without one, the usual default as
  before. Only a starting value: lines can be changed and saved documents
  never change. No import or reverse-charge tax code (refused rather than
  guessed).
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
- **Modules**: Accounting and Tax are always on; the **CRM**, **Advanced
  reporting** and **Not-for-profit** modules are switched on per organisation
  in Settings. Their module-specific menus show only while on (MOD1, NFP1).
  Not-for-profit reuses tracking categories, budgets and custom reports for
  fund activity. Fund equity carryforward, conditional grant accounting,
  donation tax-credit receipts and compliant Tier 3/4 PBE reports are not
  supported; see the NFP examples and questions in
  `docs/ACCOUNTING-EXAMPLES.md`.
- **CRM** (after [Twenty](https://github.com/twentyhq/twenty), built in):
  its **own app** at `/crm`, with its own top bar and tabs (Home, Companies,
  People, Pipeline, Tasks, Email and calendar; a ☰ menu on phones), the same
  sign-in, organisations and roles. An **app switcher** (Accounting / CRM)
  beside the Tohyee name in both apps replaces the old CRM menu; it shows
  only while the CRM is on for the organisation, so people without it never
  see it. Old `/operations/crm/...` links redirect to the same pages under
  `/crm`. The CRM's **Home** shows the signed-in person's open opportunities
  (with a total per currency), their tasks due today or overdue, and the
  team's ten most recent calls, meetings and notes (CRM10, not yet approved
  by Jess). Companies are the contacts, which can now also be **prospects**; **people**
  at each company; **opportunities** with the organisation's own stages
  (starting with Twenty's, plus Lost) on a drag-and-drop pipeline board, where a won one makes its draft invoice in
  one click (and makes a prospect a customer); an opportunity for a company
  in another currency is in it, amount and invoice (MC68, MC69), and the
  board totals each currency on its own; **tasks** with due dates and
  assignees; logged **calls, meetings and notes**; and a **timeline** per
  company that also shows its invoices, credit notes, bills and payments.
  People, opportunities, tasks and activities are never deleted (CRM1-CRM9).
  **CRM custom fields** (like Salesforce's): the organisation's own fields
  on companies (contact fields used on prospects), people and
  opportunities, with the same types, required fields, defaults and
  archiving as other custom fields, in named, ordered **sections** per kind
  of record (shown as groups that can be collapsed on the company page and
  the people and opportunity forms; sections only group fields, they don't
  hide them). Fields shown in lists are columns on the Companies and People
  lists and lines on the pipeline cards, and changes are in each record's
  history. Prospects only get the fields an admin turns on for prospects;
  existing customer fields, required or not, stay off them. They need only
  the CRM switch, not Advanced reporting (decided by Jess, 1 Oct 2026);
  accounting fields still need Advanced reporting, and with it off behave
  as before. A field that's already somewhere can be changed while one of
  its places is switched on, so customer fields can still be changed with
  the CRM off. They never change an amount, account, stage or the invoice
  a won opportunity makes (CRMF1-CRMF12, not yet approved).
  **Record types and page layouts** (Salesforce's record types and page
  layouts, NetSuite's custom forms): an admin sets up, in CRM › Record
  types, several kinds of company, person and opportunity (like "Standard
  account" and "Funding body"), one the default for each kind. Every record
  has one; existing records got the default, "Standard". Each type's page
  layout says which standard and custom fields show, in which sections and
  order, and which are required or read-only on that type. Required fields
  are checked by the server on every save of a record of that type (even a
  stage move), so a field can be required on one type and not another;
  read-only fields can be changed only by admins and owners. Changing a
  record's type is in its history and needs the new type's required fields
  filled in. Types are archived, never deleted (CRT1-CRT13, not yet
  approved by Jess).
  **Record page** for companies, people and opportunities (after
  Salesforce's Lightning record page): a header with the name, record type
  (changeable by bookkeepers and up) and key fields; a **Details** tab
  showing the layout's sections, which collapse, with a pencil on each
  field the person may change for inline edit (viewers read only); a
  **Related** tab with people, opportunities, invoices, credit notes, tasks
  and notes and files, each with its count and "View all"; and an
  **Activity** panel with "Upcoming & overdue" tasks and planned meetings,
  then past activity grouped by New Zealand month (the timeline), and
  buttons to log a call, a meeting or a note and to add a task. On phones
  the panel goes below the tabs. Not built: Salesforce's "Follow", and
  cases, contracts and assets (Tohyee has none).
  **Opportunity stages and forecasts** (after Salesforce; CRMS1-CRMS11,
  not yet approved by Jess; decisions 76-90): an admin sets up, in CRM ›
  Stages, the organisation's stages in order, each with a type (Open,
  Closed won, Closed lost), a default probability and a forecast category
  (Pipeline, Best case, Commit, Closed, Omitted); the old six stages are
  the starting ones (New 10%, Screening 20%, Meeting 50%, Proposal 75%, Won
  100% Closed, Lost 0% Omitted), so nothing saved changed. Stages are
  archived, never deleted (their opportunities stay); one active stage of
  each type always stays; a stage's type can't change while opportunities
  are in it. Whatever it's called, a Closed won stage is what makes the
  invoice and what's not "open". **Sales processes**: each opportunity
  record type can use a chosen list of stages. Each opportunity has a
  **probability** and **forecast category** (the stage's, changed by
  bookkeepers within the stage type's rules) and a **weighted amount**
  (amount × probability, rounded half up), shown on cards and the record
  page, and a **Stage history** related list (each change of stage, amount,
  probability, category or close date, with who and when). **Forecasts**
  (CRM › Forecasts): by expected close month or financial-year quarter, per
  owner and currency (never added together), Salesforce's cumulative
  Closed, Commit, Best case and Open pipeline, the weighted pipeline, and
  each figure opens its opportunities; admins set **quotas** per owner per
  month (base currency) and see attainment. Not built: forecast manager
  adjustments, a forecast hierarchy (teams) and submitted forecast
  snapshots, converting currencies in forecasts, and quotas by quarter or
  in other currencies (questions for Jess under CRMS11).
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
  contacts (customers, suppliers, prospects or a mix), to the top of
  documents, or to their lines, grouped into named sections if wanted: text, long text, whole and decimal numbers, money, percent,
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
  showing the connected address, with Disconnect; **Google / Gmail (sign
  in)** (1 Oct 2026), the same for a Gmail or Google Workspace mailbox: the
  organisation's own Google OAuth client (shared with the CRM's mail sync),
  **Connect Google account**, only the gmail.send permission (plus the
  account's address), the message written by the same composer as SMTP and
  sent through the Gmail API (35 MB at most; bigger is refused with a plain
  message), with plain-English errors for access withdrawn, the permission
  unticked, a Workspace admin blocking the app and Gmail's daily limit; the
  settings help explains Google's "unverified app" screen (checked against
  Google's documentation on 1 Oct 2026: gmail.send is a sensitive, not
  restricted, permission; Internal apps for Workspace need no verification;
  for personal Gmail, an External app published In production works
  unverified for up to 100 people, while Testing ends the connection after 7
  days; not yet tried with a real Google app); or **SMTP**: Gmail or
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
  Not built: attachments over 3 MB through Microsoft
  (Graph's upload sessions), and tracking whether the email was opened
  (never: no tracking pixels).
- **Sales platform connections, stage 1: Shopify customers and products**
  (Settings › Sales platforms; SPC1-SPC10, examples not yet approved by
  Jess). **Not tried against a real Shopify store**: the tests use
  Shopify-shaped responses (Admin GraphQL API 2026-07) and webhooks signed
  in the tests. A general connector framework (Shopify is the first
  connector): per-organisation connections with the credentials encrypted
  with TOHYEE_SECRET_KEY, status, last sync and last error; links from the
  platform's records to contacts and items so nothing is brought in twice;
  a sync log everyone can read; a webhook address per connection that
  checks the platform's signature before anything else; and a catch-up
  sync every 15 minutes (off with TOHYEE_SALES_PLATFORM_SYNC_SCHEDULER=off)
  that pauses a store after three failures in a row. Admins connect a store
  with a Dev Dashboard app's client ID and secret (Shopify's way since
  1 Jan 2026) or an older custom app's Admin API access token and API secret
  key; only `read_customers` and `read_products` are accepted, and a token
  that can change the store is refused. Then: test the connection, choose
  customers and/or products, **Sync now**, and **Disconnect** (the contacts,
  items and log stay; the credentials, the links and Shopify's webhooks
  go). Customers become contacts marked as customers, linked to an existing
  contact with the same email (ignoring case); variants become non-stock
  items, linked to an existing item with the SKU as its code. Unclear ones
  are skipped with the reason (two contacts with the email, a contact with
  the name but another email, no SKU). Shopify's changes are copied unless
  someone changed that value in Tohyee, which is kept and logged. Prices
  are copied only from a store in the base currency whose prices exclude
  tax. Customer and product create/update webhooks are handled once each
  (a repeated delivery does nothing) and need a public https address
  (Settings › Remote access). Stage 1 posts nothing to the ledger.
- **Sales platform connections, stage 2: Shopify orders, refunds and
  payouts** (#77, SPC11-SPC24, decisions 51-55 and 317-322, not yet
  approved by Jess; not tried against a real store). With "Post to the
  accounts" on (Settings › Sales platforms › Posting to the accounts,
  admins; the form was added on 2 Oct 2026, before then only the API could
  set it), paid orders from the start date become approved sales orders
  and invoices with their payment into a clearing account, refunds become
  credit notes and refunds, and payouts move money from the clearing
  account to the bank with the fees. Shopify's tax rates are matched to
  tax codes; untaxed lines take the zero-rated or exempt code chosen.
  Guest checkouts go to the customer contact chosen for them, or are
  refused (SPC24). Refused rather than guessed: test orders, other
  currencies, gift cards, tips or duties, chargebacks and reserves.
- **Remote access (remote access)**, three ways, one on at a time (switching
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
  - **Tailscale Funnel** (Windows server app → Remote access): the simplest
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
- **Updates** (decisions 328-331): Tohyee checks GitHub for a new release a
  minute after it starts and then daily. On Windows the server app shows a
  notification and installs it in one click: every organisation is backed
  up first (nothing happens if a backup fails), the installer is downloaded
  and checked against GitHub's SHA-256, it runs silently, Tohyee upgrades
  each organisation's database as it starts, and the app comes back to say
  whether everything came up or which organisations are blocked. Each
  server start is recorded (version, previous version, upgrades). Elsewhere
  the server settings show the update and how to install it by hand. Not
  yet tried on a real Windows computer.
- **Server stats** in the Windows server app (decision 332): CPU, memory,
  requests, people using Tohyee, database connections, disk space and each
  organisation's database size, with graphs of the last 24 hours.
- **NZ payroll rates and calculations** (payroll stage P2, PR1-PR16, not yet
  approved by Jess): IRD's payroll figures for pay dates 1 April 2025 to 31
  March 2027, from IRD's Payroll Calculations and Business Rules
  Specification (2025-26 and 2026-27 editions), as dated data in
  `src/lib/payroll/rates/`, and pure functions for one pay's PAYE (tax codes
  M, ME, SB, S, SH, ST, SA, ND, NSW, CAE, EDW and their SL versions,
  including the ACC earners' levy and the independent earner tax credit),
  student loan deductions, KiwiSaver employee and employer contributions,
  the ESCT rate and ESCT. Weekly, fortnightly, four-weekly and monthly pays.
  The tests use IRD's own examples (the specification, IR335, KS4) and 976
  rows of IRD's PAYE deduction tables IR340 and IR341, which match exactly.
  Refused rather than guessed: STC and WT tax codes, other pay frequencies,
  pay dates outside those two years, ESCT threshold amounts between IRD's
  bands. There's no screen of their own; pay runs (below) use them.
- **NZ payroll pay items and pay runs** (payroll stage P3, PRUN1-PRUN11, not
  yet approved by Jess; everything needs payroll access and the bookkeeper
  role, reading too). **Pay items** (Payroll › Pay items): ordinary time,
  overtime (a multiple of the hourly rate), allowances (taxable or not),
  holiday pay typed as an amount, reimbursements, after-tax deductions (e.g.
  union fees) and the employer's KiwiSaver contribution, each with its own
  account and its tax treatment (taxable items are subject to PAYE, the ACC
  earners' levy and student loan together; whether it counts for KiwiSaver).
  Every organisation starts with a set mapped to its chart (wages 6200,
  employer KiwiSaver 6210, and new liability accounts PAYE payable 2200,
  KiwiSaver payable, ESCT payable, Student loan payable, Wages payable and
  Payroll deductions payable at the next free codes); admins add more and
  archive them. **Pay runs** (Payroll › Pay runs): a draft for a pay group,
  period and pay date with a line per employee working in the period, from
  their pay rate (salary per period, or hours for hourly staff); add or change
  earnings and deductions per person. Each person's gross, PAYE, student
  loan, KiwiSaver, deductions, net pay, employer KiwiSaver, ESCT and employer
  cost, and the run's totals, are worked out with IRD's rates for the pay
  date; anyone whose pay can't be worked out is shown with the reason, and the
  run can't be approved until it's fixed. **Approve** posts one journal dated
  the pay date: each earnings and employer KiwiSaver item to its account,
  split by each person's cost allocation on the pay date (cents exact), with
  PAYE, student loan, KiwiSaver (employee plus employer net of ESCT), ESCT,
  deductions and net wages credited to their liability accounts. Journal
  lines show totals by account and tracking, never a person; the per-person
  split is kept separately for people with payroll access. Locked and closed
  periods are respected, and an organisation can require someone other than
  the preparer to approve. Approved pay runs can't be changed, only voided
  with a reversing journal. Refused rather than guessed: child
  support, payroll giving, negative amounts, pay rate changes inside a
  period, tax codes and KiwiSaver rates IRD's rates don't support, and
  employer contributions other than KiwiSaver. (Extra pays, back pay and
  final pays came in P12, and leave in P8, below.)
- **Paying wages and IRD** (payroll stage P4, PPAY1-PPAY12, not yet approved
  by Jess; bookkeeper role and payroll access). **Wages** (on an approved pay
  run, "Wages paid"): record the net pay leaving a bank or credit card
  account in NZD, dated on or after the pay date, as one payment for the
  pay run or one per employee (so each bank line matches), in full or in
  part, never more than what's unpaid. Each posts Dr Wages payable / Cr the
  bank (WAGES-n), its lines saying "Net pay", never whose; it shows as a
  match suggestion on the bank statement like any payment. Voiding posts the
  exact reversal. **IRD** (Payroll › IRD payments): per IRD period (monthly,
  or twice a month, set under Payroll › Pay items), what the approved pay
  runs paid in it owe for PAYE (incl. the ACC earners' levy), student loan,
  KiwiSaver and ESCT, what's been paid and what's owing, with IRD's due date
  (20th of the next month; twice a month: 20th and 5th, 16-31 December by
  15 January; a weekend shows the Monday IRD accepts). Pay any part of each
  liability up to what's owing (IRD-n: Dr each liability, Cr the bank), and
  void payments. Undo in order: a pay run can't be voided while it has wage
  payments or its IRD period has IRD payments, and a payment matched on the
  bank statement must be unreconciled first. Locked periods apply. Not built:
  public holidays in due dates, IRD penalties and interest, child support.
- **Bank files for paying wages** (payroll stage P5, PBF1-PBF7, not yet
  approved by Jess; bookkeeper role and payroll access). On an approved pay
  run, "Make bank file" writes a direct credit file of each employee's
  unpaid net pay, from a bank account set up under Settings › Bank files
  (admins enter its account number and bank): ANZ domestic extended, ASB
  FastNet MT9 or BNZ IB4B (one statement line or one per employee), each to
  the bank's published specification, with the hash total. Employees' bank
  accounts are checked (bank-branch-account-suffix) first. Making a file
  posts nothing; record the payment under Wages paid after uploading it.
  Westpac and Kiwibank are refused (no published file specification), as is
  ASB's CSV format.
- **Payslips** (payroll stage P5, PSLIP1-PSLIP6, not yet approved by Jess;
  bookkeeper role and payroll access). For each employee on an approved pay
  run: employer, employee and start date, pay period and pay date, tax
  code, earnings with hours and rates, gross, PAYE (incl. ACC earners'
  levy), student loan, KiwiSaver, other deductions, net pay, the bank
  account masked to its last 3 digits, employer KiwiSaver and ESCT, and the
  year to date for the tax year. Print, download as a PDF, or email to the
  employee (one or everyone with an email address) from the organisation's
  email account; the email's text and the audit log have no figures. Since
  P8, leave balances at the end of the period (annual holidays, sick
  leave, alternative holidays; never family violence leave). Not shown:
  hours each day. No employee self-service portal.
- **Payday filing file** (payroll stage P6, PF1-PF9, not yet approved by
  Jess; decisions 56-65; bookkeeper role and payroll access). On an approved
  pay run, "Payday filing" makes IRD's employment information file (the
  2026-27 file upload specification's HEI2 header and a DEI line per
  employee: IRD number, name, tax code, start date if in the period, pay
  period, pay cycle, hours paid, taxable gross earnings, PAYE, student loan,
  KiwiSaver deductions, net employer contributions and ESCT) to upload in
  myIR, and shows its due date: 2 working days after the pay date, weekends
  skipped, public holidays not yet. Employees starting in the period are
  listed so their details can be given in myIR. The employer's IRD number
  and payroll contact are set by admins under Payroll › Pay items. Making
  the file posts nothing and records only an audit event with its SHA-256;
  there's no "filed" tick. Not built: the employee details file, EI
  amendments, filing straight to IRD's gateway, and fields for things
  Tohyee doesn't pay yet (child support, ESS: always 0). Since P12 the
  lump sum indicator, the finish date of a final pay and redundancy (not
  liable for the ACC earners' levy) are filled in. No file has been
  through myIR's checker yet.
- **Timesheets** (payroll stage P9, TS1-TS11, not yet approved by Jess;
  decisions 91-101; tenant migration 0067). Payroll › Timesheets: one
  timesheet per employee per week (Monday to Sunday unless the organisation
  starts its weeks on another day, decision 192, TS12) of hours per day, to 2
  decimal places, by R&D activity, Department, project, any combination, or
  "other work" (spread by the default allocation); "Fill from project time"
  suggests rows from the employee's project time. Every entry is stamped by
  the database with who and when, a change replaces the entry (the old one is
  kept) and clearing a cell removes it; entries made more than 14 days after
  the work are flagged "entered late". Employees linked to their login fill
  in and submit their own (viewers can; timesheets show hours, never pay);
  their timesheet approver (bookkeeper or higher), or the login of their
  reports-to manager, or anyone with payroll access approves or rejects with
  a reason, never their own; approval locks the timesheet and only payroll
  access can reopen it, never once an approved pay run used it. Pay runs
  approved afterwards split each employee's costs by the approved hours for
  the days covered and the default allocation for the rest (largest
  remainder, as PE3), keep the shares and the timesheets used, and give an
  hourly employee whose whole period is covered their timesheet hours as
  Ordinary time; PAYE and the rest are calculated as before. The R&D claim
  counts timesheet shares as time records (the 100% rule stays for the
  allocation's share) and notes timesheets approved after their pay run. Not
  built: leave and overtime from timesheets (since P8 hours on a public
  holiday count as hours worked on it), reallocating a posted pay to a
  late timesheet, copying timesheet hours into project time.
- **Payroll reports** (payroll stage P10, PREP1-PREP8, not yet approved by
  Jess; decisions 102-111; no migration). Payroll › Reports, for people with
  payroll access (bookkeeper or higher) only, read-only, by pay date, from
  approved pay runs' stored figures and the shares each used (allocation or
  timesheets), never recalculated: **labour cost** by Department, project,
  R&D activity, pay item or employee with a column per pay item, filtered by
  any of those together (reimbursements on their own line); the **payroll
  summary** (each pay run gross to net, employer KiwiSaver and ESCT, totals
  by pay item); the **reconciliation to the ledger** (each payroll account's
  payroll figure against its ledger movement, with every other journal that
  explains the difference: voided pay runs and payments, manual journals,
  other documents); **headcount and FTE** at a date and by month (usual
  hours ÷ a standard week (saved per organisation, 40.00 unless changed,
  or typed for one report; decision 199); usual hours from the employee's
  usual week where they have leave settings, else the pay rate's, and
  salaries without a usual week count 1, marked assumed (decision 200,
  PREP9); by Department from the allocation; starters, leavers and who was
  paid); **employee earnings history**; and **PAYE, KiwiSaver and student
  loan** by month, tied to each pay run's employment information file (made
  or not, from the audit log) and IRD payments. Voided pay runs are listed,
  not counted. Each exports as CSV, recorded in the audit log without
  figures or names. (Leave reports are under Payroll › Leave since P8; wage budgets are P11, below.) Not built:
  reports by pay period, a view for people without payroll access.
- **Workforce budgets** (payroll stage P11, WB1-WB7, not yet approved by
  Jess; decisions 112-123; tenant migration 0068). Payroll › Workforce
  budget, for people with payroll access (bookkeeper or higher): wages by
  **employee** or **position** (to be hired) and month over 1-24 months,
  salary × FTE ÷ 12 or hourly rate × hours × 52 ÷ 12, whole months from a
  start to an optional end month, **pay rises from a month**, employer
  KiwiSaver at the line's rate (truncated as pay runs do; ESCT adds no
  cost). An employee line copies their pay and KiwiSaver rate when added
  and is split by their cost allocation on the 1st of each month; a
  position has its own % split by Department and project. Each line's
  month is rounded once to the cent and split with the allocation rule, so
  Departments add up. A workforce budget **feeds** chosen budgets (each
  budget fed by at most one): it writes the Ordinary time and KiwiSaver
  employer accounts for all its months, only the shares tagged with a
  Department, Class or Location budget's value, and those amounts are
  read-only on the budget (the database refuses other changes); they're
  rewritten on every save and on **Update budgets**, and the screen says
  when they're out of date (an allocation changed). Taking a budget off
  leaves its amounts as typed amounts. **Budget vs actual for wages** by
  month and Department against P10's labour cost by pay date. Audit events
  without amounts or names. Not built: part months, more than one person
  per position line, overtime, holiday pay and other on-costs, a future
  KiwiSaver minimum rate, following later pay rate changes automatically.
- **Extra pays, back pay and final pays** (payroll stage P12, XP1-XP14,
  not yet approved by Jess; decisions 124-137; tenant migration 0069).
  Admins add pay items of the kinds **Extra pay** (bonuses, gratuities,
  lump sums), **Back pay**, **Holiday pay on finishing** (worked out
  outside Tohyee) and **Redundancy**, each to its own account. In a pay
  run, extra pays are taxed under IRD's extra pay rules (payroll
  specification 2026-27 5.11, 5.12): the employee's regular pay in the four
  weeks to the pay date annualised (× 13, or × 12 for a monthly pay; none
  gives $0), plus the extra pay, picks the rate; the ACC earners' levy up to
  its maximum; one truncation to cents. Secondary codes add their low
  threshold; ND and NSW use their flat rate; ME gets no credit on extra
  pays. A final pay with holiday pay on finishing or redundancy uses the
  last 2 paid periods (× 26, 13, 6.5 or 6). Redundancy has no levy and no
  KiwiSaver; student loan is on the whole pay. Back pay: "Add back pay"
  picks a pay rate from the employee's history and adds a line for each
  approved pay period it covers that was paid at less (Ordinary time, and
  overtime at the old rate × its multiplier), never twice. Drafts include
  people finishing in the period (hourly leavers start at 0 hours to fill
  in, or since P8 their usual hours to the finish date); since P8 Tohyee
  works out holiday pay owed on finishing where it keeps the employee's
  leave, and the screen says so where it doesn't. The EI file has the lump sum indicator, the finish date and
  redundancy as not liable for the levy; payslips note extra pays and final
  pays; reports and journals show each new pay item; the R&D claim counts
  bonuses, back pay and holiday pay on finishing. Refused rather than
  guessed: short or mixed four-week windows, fewer than 2 paid periods on
  leaving, an extra pay on a final pay without a termination item,
  termination items on any other pay, CAE and EDW extra pays, redundancy
  for ND and NSW or where the levy's maximum falls inside mixed extra pays,
  a higher rate on request, separate extra-pay pay runs, holiday pay on
  back pay and periods with holiday pay, rates starting part-way through a
  paid period, lower rates, a change of basis, overtime at a typed rate.

- **R&D Tax Incentive register and tagging** (RDTI stage R2; RD1-RD3, RD8,
  RD9, RD11-RD13 and RD21-RD23 tested, examples not yet approved by Jess;
  decisions 30-50): Tax › R&D activities lists each organisation's core and
  supporting activities (project, IR1240's descriptions, income years, New
  Zealand or overseas, and the core activities a supporting one supports).
  Bookkeepers add and change them; admins archive them, never delete them.
  General approvals are entered with IRD's letter attached (required) and
  show "not checked with IRD"; a later change to an approved activity is
  flagged. Files on R&D records are replaced with a new version, never
  deleted. Posted bill, expense claim, spend money and manual journal lines
  are tagged to an activity from the document's page (or Tax › Tagged R&D
  costs) with a share %, an IR1240 category or an ineligible reason, the
  supplementary return flags, goods not used by year end and a contractor's
  own ineligible costs. GST, exchange gains and losses, income and balance
  sheet lines can't be tagged; foreign-currency lines use the document's
  rate. A fixed asset's tax depreciation and Investment Boost are entered
  per income year and split by a usage log of hours, R&D shares rounded down
  to the cent. Everything is stamped by the server with who and when, kept
  in its history, and flagged "entered late" when entered more than 14 days
  after the work. Tagged R&D costs lists what's tagged by activity and
  category for an income year. (Timesheets came with payroll P9.) Not built: criteria and
  methodologies approvals, and purging files after 7 years.

- **R&D claim report** (RDTI stage R3, on branch
  `claude/rdti-r3-claim-report`, tenant migration 0065; RD3, RD4, RD16-RD20,
  RD24-RD27 and RD28-RD42 tested, examples not yet approved by Jess;
  decisions 66-75): Tax › R&D claim report works out an income year's claim
  from the tags, assets' tax depreciation, overhead rules and approved pay
  runs, for activities with an approval covering the year: the counted
  amounts by activity and category, the 10% overseas limit (rounded down and
  shared across the overseas amounts), the $50,000 minimum after the limit
  (approved research provider expenditure only below it), the $120 million
  maximum, the 15% credit rounded down, and per project the supplementary
  return's figures (categories, of which overseas, internal software,
  commercial production and supporting activity from the year before, and
  the core share). Pay counts from the shares each approved pay run kept:
  from approved timesheets (payroll P9) always, and from the default
  allocation only when it's 100% R&D; other splits are listed as "default
  split, no time record" (pay runs approved before P9 use the allocation
  they used). Each employee's pay only for
  people with payroll access; others see totals. Overhead rules ("% of an
  account" to an activity, with an IR1240 basis and workings attached) are
  set there by bookkeepers, applied when the report runs, changed by adding a
  replacing rule (the earlier figure is shown), and never deleted. What's
  left out is listed with why (no approval, no approved core activity,
  supporting activity before its core activity, feedstock, commercial
  production, goods not used, voided), with ineligible expenditure for the
  return's evaluation questions. Deadlines for a 31 March balance date
  (weekends moved to Monday; public holidays not checked) with reminders 60
  days ahead for owners and admins on the home page. CSV export, which keeps
  the summary figures (never anyone's pay) so later changes show as
  differences. Read-only: it posts nothing, decides nothing is R&D and
  records no "filed" status. Not built: feedstock output values,
  refundability, supporting activity in the following year, other balance
  dates' deadlines, joint ventures.

- **Holidays Act leave** (payroll stage P8, HL1-HL42, not yet approved by
  Jess; decisions 7-29 and 138-167; tenant migration 0070; bookkeeper role
  and payroll access). Built for the Holidays Act 2003 until each
  employee's first pay period starting on or after 6 Aug 2028 (refused
  after that: the Employment Leave Act 2026 comes later). Each employee's
  **usual week** (hours each day, regular overtime and allowances, or hours
  that vary with the agreed week), RDP or ADP with the reason, the
  agreement to pay annual holidays in the usual pay, a part-day sick leave
  agreement, casual or not, and their anniversary day, dated. Drafts get
  the usual pay from the usual week and Tohyee's **leave lines**: annual
  holidays at the greater of ordinary weekly pay and average weekly
  earnings over 12 calendar months (in advance at AWE since the start
  before 12 months, with a warning), sick, bereavement and family
  violence leave ("Special leave") and alternative holidays at relevant or
  average daily pay, public holidays not worked at RDP or ADP and worked
  at time and a half with an alternative holiday, part days, agreed
  **cash-ups** (written request and answer attached, at most 1 week a
  year, an extra pay) and **exchanged alternative holidays**; a final pay
  gets **holiday pay owed on finishing** (untaken weeks, the public
  holidays they'd have covered, the 8%, untaken alternative holidays).
  Every entry keeps its hours, units and the rate's inputs; balances count
  approved pay runs (voiding gives leave back); approving works leave out
  again and stops if it changed. **Public holidays** 2025-2027 as dated
  data with Employment NZ as the source, moved off weekends per employee;
  for hours that vary Tohyee suggests whether a holiday would otherwise
  have been a working day and the person running pay records it. Unpaid
  leave moves the anniversary unless a written agreement to count it is
  attached. Payroll › Leave: balances, bookings, public holidays and
  decisions, cash-ups, the **leave liability report** by Department with
  the running 8% (posted to the ledger since 2 Oct 2026, below), settings; each employee's
  printable **holiday and leave record** (s 81) with CSV. Refused rather
  than guessed: deducting advance holiday pay over the 8% (IRD's tax
  treatment not confirmed, decision 170), back pay over leave (decision
  171), paying holidays before they're taken (decision 172), and the
  section's own list (closedowns, transfers, being on call, pay-as-you-go
  8%, board, ACC, more than the minimums).
- **Opening leave balances** (2 Oct 2026, HL43-HL48, decision 168, tenant
  migration 0071; payroll access). For someone employed before Tohyee's
  first pay run for them: on the employee's leave, their balances as at the
  end of a pay period (annual weeks and the last entitlement date, weeks
  cashed up that entitlement year, advance holiday pay, sick and family
  violence days, untaken alternative holidays with the dates they arose)
  and their earlier earnings one row per pay period (gross, the irregular
  part, days worked or on paid leave), with the source and the previous
  payroll's report attached, both required. Tohyee then treats them as its
  own records, so annual holidays, AWE, ADP, the running 8%, the liability
  report and holiday pay on finishing work for them; typed holiday pay up
  to the opening date is covered. Replaceable (the old one kept) until a
  pay run has paid them leave. Refused: casual employees, an opening date
  inside a pay period, gaps or overlaps in the rows, and leave whose
  window starts before the first row.
- **Employees' own leave requests** (2 Oct 2026, HL49-HL51, decision 169;
  Payroll › Leave requests, viewers and up, like Timesheets). An employee
  linked to their login asks for leave and sees their annual and sick
  balances in weeks and days; their timesheet approver, reports-to
  manager's login or payroll access approves, which books the leave as the
  approver (the next pay run pays it), or rejects it with a reason; the
  employee changes or withdraws it until then. Days and hours only, never
  pay; family violence leave shows as "Special leave" to approvers.
- **Posting the leave liability** (2 Oct 2026, HL52-HL56, decisions 177
  and 182-187, tenant migration 0072; payroll access and the bookkeeper
  role). Payroll › Leave › Liability: "Post leave liability" at a date
  makes one journal (LEAVELIAB-n) for the change since the last posting
  not voided: the liability report's total (annual holidays entitled to,
  the running 8%, untaken alternative holidays; never sick, bereavement
  or family violence leave) by Department, Dr leave expense / Cr employee
  entitlements, or the other way when it falls, tagged with the
  Department, never naming anyone. Leave paid in pay runs still goes to
  wages; the next posting takes the fall. The two accounts are payroll
  settings (Payroll › Pay items, admins); the entitlements account is
  locked while a posting has left a liability in it. Refused: a date
  before the last posting, a locked period, no accounts, a problem on any
  row of the report (named), nothing to post. Only the latest posting is
  voided, with the reversing journal; the ledger won't correct them.
  Audited without figures. Since decisions 188-191 (2 Oct 2026, HL53,
  HL57-HL61, tenant migration 0073): someone who has finished stays in the
  report until their final pay's pay date, at the holiday pay on finishing
  on it (a problem that blocks posting while the final pay isn't
  approved); the employer KiwiSaver on enrolled employees' leave (gross,
  truncated to cents) is posted as its own pair of lines, "Employer
  KiwiSaver on leave"; and the home page reminds bookkeepers with payroll
  access to post after each month end with approved pay runs. Sick leave
  carried over stays out (PBE IPSAS 39 para 17; journal your own estimate
  if your agreements let it be taken as annual leave).
- **AI: connect your own AI** (decisions 339-348, core migration 0005). The
  AI page (`/operations/ai`) lets each member make personal access keys for
  the organisation (shown once, stored hashed, at most 10, revocable), each
  with a level: **Look only** (the default), **Make drafts** (also add and
  edit contacts and make and edit draft invoices, bills and journals) or
  **Make and post** (also approve invoices and bills, post draft journals
  and record payments). The level is capped by the person's role (a
  viewer's key only looks). It shows how to connect Claude Desktop (through
  `mcp-remote`), Claude.ai or ChatGPT custom connectors, or any MCP client
  to `/api/mcp`. The AI can look up the organisation's settings, chart of
  accounts, profit and loss, balance sheet, trial balance, aged receivables
  and payables, invoices, bills, contacts, account transactions, draft
  journals and the GST return for a period, in a read-only database
  transaction; writing tools use the same services as the screens, as the
  key's owner, and the history shows "<person> via AI key <name>". It
  **never deletes**: nothing at any level deletes, voids, archives, rolls
  back or refunds anything. Payroll isn't included. A key stops working
  when it's revoked, its owner leaves the organisation or their login is
  turned off. Not yet tried against each AI app; no OAuth sign-in yet, so
  AI services that only take OAuth connectors can't connect.
- **Draft manual journals** (examples MJD1-MJD9, decisions 349-352, tenant
  migration 0081), like Xero's: "Save as draft" beside "Post journal", and a
  Draft journals list on the journal page to edit, post or delete them. A
  draft is checked like a journal when saved but posts nothing; posting it
  posts one manual journal through the usual checks and links it, and a
  posted draft can't change.
- **Analytics, step 1: data sources** (decisions 353-358, tenant migration
  0082; plan in [ANALYTICS-REVIEW.md](ANALYTICS-REVIEW.md)). A module
  switched on per organisation, with its own app at `/analytics`. A server
  admin chooses each organisation's folder on the server (server settings ›
  Analytics folders, or `analytics folder` on the command line). Admins set
  up a CSV file from it: Tohyee shows the headings, its guess at each type
  and the first values, and they confirm each column (money loads as exact
  decimals). Each organisation's loaded data is one DuckDB file in
  `TOHYEE_ANALYTICS_DIR`; a load swaps the table in only when it succeeds.
  Sources reload nightly after 04:00 and on demand, and every load is
  recorded. Tested with a made-up 1M-row CSV (about a second to load).
- **Analytics, step 3: dashboards** (tenant migration 0083). Dashboards at
  `/analytics` (data sources moved to `/analytics/sources`). Each tile asks
  one question of a loaded table: group by a column (dates by day, week,
  month, quarter or year), one to six values (total, average, smallest,
  largest, count, count of different values; a total can multiply two
  columns, e.g. quantity x unit price), optional "and last year", filters,
  order and top N. Shown as columns, bars, line, area, columns and line,
  pie, donut, a key figure or a table (ECharts, from PR #94, with the
  checked series colours `--chart-1` to `--chart-8`). A dashboard has a date
  range and slicers (tick boxes) that apply to every tile. Totals stay
  exact (DuckDB decimals, shown from their text); column and value names
  are checked against the table and typed values go in as parameters.
  Bookkeepers and up make dashboards; everyone in the organisation can see
  them. Tried with the made-up 1M-row CSV: a five-tile dashboard opens in
  about 3 seconds. Tohyee's own books and CRM, sharing with clients,
  shaping and pivot tables are the next steps.

- **Analytics, step 2: the books and CRM** (examples AB1-AB10, decision
  367). Each organisation's ledger lines, invoices, bills, contacts, items and
  (with the CRM on) companies, opportunities and activities are copied into
  its analytics every night and by Refresh now, as the same data with the
  ledger's signs; dashboard values can be shown the other way round. Pay run
  lines are copied without names.
- **Analytics, step 5: report emails** (decision 362, tenant migration
  0087). Admins and owners configure their own CRM-connected Gmail or
  Microsoft mailbox, or IMAP with an encrypted app password, in Analytics
  › Data sources. Choose a folder or label and set a mailbox rule to file
  reports there. Checks save CSV, TSV and TXT attachments, or flat CSV/TSV
  files extracted from ZIPs, in the source folder; keep every file or replace
  matching names with the newest receipt. PDFs (including Looker Studio
  reports) and Excel files are not accepted in this step. Limits are 25 MB
  per attachment and 100 MB per check, including ZIP expansion. Message IDs
  prevent repeat saves, and the job records files saved and errors. Checks
  run every 15 minutes while the server runs, or by Check now. Google and
  Microsoft permissions cover the whole mailbox, although checks read only
  the chosen folder; mail is never moved, marked, labelled or deleted.
  Microsoft 365 does not support IMAP passwords: use its CRM connection.
  Provider and IMAP tests use mock mail; live GA4/Google Ads sends have not
  been verified.
- **GST late claims** (examples LG1-LG7, decisions 363-366, tenant
  migration 0084), like Xero's: anything approved or changed after a return
  was filed but dated in its period is offered in the next return, counted
  in the ordinary boxes unless unticked, with "IRD says ..." notes for
  purchases more than 2 years old and changes over $1,000. Filed returns
  list what later returns claimed for them.

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
- on foreign-currency documents (MC11): the reverse charge on imported
  services, supplier overpayments, payments through a bank account in a third currency (as
  NetSuite, MC30), chargeable expenses on foreign-currency projects and
  projects in currencies without cents (MC70), approving repeating ones
  automatically without a rate from the exchange rates list, and sales on the
  payments GST basis; an automatic daily exchange rate feed; also paying NZD
  documents from a foreign-currency statement line, standard-rated GST on
  foreign-currency spend and receive money, adjustments on foreign-currency
  lines, and transfers between two foreign-currency accounts
- GST: deferred-payment supplies of $225,000 or more on the payments basis
  (section 19D), checking payments-basis eligibility, and bad debt write-offs
- amending a filed GST return, imported goods (Customs GST), GST rates other
  than 15%, recording the GST payment or refund to IRD, and filing to IRD
  electronically
- an import or reverse-charge tax code (imported services under the
  reverse charge, EX16-EX25), and a default purchase tax code on expense
  claims (their suppliers aren't contacts), cash coding and bank rules
- sales platforms: WooCommerce, Square and Stripe, Shopify chargebacks
  and reserves, customers' addresses and companies,
  stock levels, and anything written back to the store
- stock "recomputation" (transfers between locations are built; editing or
  voiding a transfer, and transfers in transit, aren't)
- on sales orders (SO1-SO12, stage 1): reserving stock (committed
  quantities), deliveries and moving cost of sales to delivery (orders
  from won CRM opportunities, decision 327, and from Shopify, SPC11, are
  built), line discounts, editing an
  approved order, closing single lines or reopening a closed order, credit
  notes giving quantities back, and printing or emailing orders

## Next, in rough order

The owner's to-do list in [TODO.md](TODO.md) comes first.

1. Supplier overpayments and prepayments (once the owner has decided how GST works
   on them).
2. Backdated stock movements with proper re-costing.
3. Stock depth: bins, lots and serial
   numbers, variants, assemblies, stock takes (the item list, locations and
   kits are built).
4. NZ payroll: IRD's employee details file, and
   the Employment Leave Act 2026 from 6 Aug 2028 once MBIE's guidance is
   out (employee records, IRD rates and calculations, pay items, pay runs,
   paying wages and IRD, bank files, payslips, the payday filing file,
   timesheets, payroll reports, Holidays Act leave and posting the leave
   liability are built).
5. The rest of foreign-currency documents (MC11): sales on the payments
   basis, and chargeable expenses on foreign-currency projects.
   Foreign-currency bank accounts, invoices, bills, credit notes, payments,
   overpayments, refunds, batch payments, quotes, repeating documents,
   purchase orders, stock, projects, CRM opportunities, standard-rated GST
   on documents and the exchange rates list are built (MC1-MC29,
   MC46-MC53, MC61-MC70, MC71-MC83), with
   rounding on its own account and revaluation per open document
   (MC31-MC43); a bank account in a third currency stays refused, as in
   NetSuite (MC30).

## Guardrails

- Accounting behaviour follows `docs/ACCOUNTING-EXAMPLES.md`. New behaviour
  needs a worked example with numbers and a test before it ships.
- AI output, when it arrives, is suggestion-only and never posts on its own.
- Don't add screens or APIs that only record statuses a person types in.

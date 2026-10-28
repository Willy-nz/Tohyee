# Tohyee feature scope

What's built, what's intentionally not, and what comes next. "Built" means it
works end to end and has tests; nothing is listed as built if it only records
that something happened.

## Built

- **Organisations**, each with its own PostgreSQL database, created and
  repaired by server admins.
- **The demo farm** (#437, decisions 855-866 and 880-884; for now, to be taken out
  later: [docs/DEMO-FARM.md](DEMO-FARM.md)): a server admin adds it where
  organisations are added (#445, decisions 880-884), on the Windows server
  app's Organisations page or the server settings' Organisations page in the
  browser (or runs `tohyee-admin demo add --owner EMAIL`), for themselves or
  another login, and that person gets their own **Kōwhai Dairies
  Ltd**, a made-up ~300-cow Otago dairy farm, made in the background with a
  progress bar (about 20-40 seconds). It's entered through Tohyee's own
  services from 1 June at least a year back to today: co-op milk invoices
  (kg MS), bills, bank statements imported and reconciled (the last few days
  left to do), two-monthly GST returns filed and paid, opening balances and
  fixed assets with monthly depreciation, fortnightly payroll for two staff
  with PAYE paid (on servers with `TOHYEE_SECRET_KEY`), the herd's calving,
  culls, bulls and year-end counts, two farms with paddock maps, farm walks,
  grazings, supplements, fertiliser plans with applications and linked bills,
  soil tests, co-op shares and dividends, benchmark figures, a season budget,
  the farm calendar and notebook, farm safety (hazards and no-go zones,
  emergency details, an induction with sign-offs and a gate sign-in,
  equipment with pre-start checks and one machine out of use, training,
  chemicals with made-up safety data sheets, a near miss and an incident;
  decisions 1040-1042), this week's mobs, readings and calendar jobs, three
  finished spreader jobs with GPS tracks linked to fertiliser applications
  (decisions 1043-1045), and Analytics (the books copied in, a
  shaped table of milk solids beside the ledger, and four reports: Farm
  performance with working expenses per kg MS, Accounts: profit, cash and
  GST, Farm and Business overview). A **DEMO** badge shows on every page.
  It never reaches outside Tohyee: its automatic jobs stay paused, and
  sending email, mailbox, bank, IRD and sales connections and adding people
  are refused with a message saying why. **Reset** makes it again from the
  start, **Delete** removes it (both ask first; server admins, on the same
  Organisations pages); one each. The books' organisation menu doesn't offer
  it. `TOHYEE_DEMO_FARM=off`
  turns it off. Not yet reviewed by Jess.
- **The look (2026 redesign, 4 Oct 2026):** a simpler top bar where each menu opens a short grouped panel, one **apps launcher** button (Accounting, CRM, Analytics), one **+ New** button for every "New …" action, a **search / command palette (Ctrl+K)** for any screen, an **AI** item, a **notices bell** for non-blocking warnings, light and dark themes that follow the computer (switch in the user menu), the Inter font with tabular figures, and a short fade between pages. Reports and printed documents stay on white paper.
- **Server settings apart from the books** (organisations, users, remote
  access, email, updates), open only on the server computer itself. On
  Windows they're in the **Tohyee server app**: an icon by the clock (the
  logo with a green, amber or red dot; started when you sign in, like a
  media server's) that shows whether Tohyee is running, restarts it, backs it
  up and opens the logs, and a dark window for the settings with a sidebar
  (Home; Organisations and Users; Backups and Updates; Remote access, Email
  and Analytics; Stats, with a badge where something needs attention). **Home**
  shows whether the server is running (version, how long it's been up), what
  needs attention, the last backup, remote access, the organisations and email at a glance, the latest
  Tohyee news (GitHub releases plus announcements from `website/news.json`,
  fetched at most every four hours and kept for when the computer is
  offline) and a (light-hearted) conference card. On Docker and Linux they're a **command-line tool**
  (`tohyee-admin.cjs` in the image, `npm run admin` from a checkout).
- **Nightly backups** of each organisation (and the server's own database),
  encrypted with the server's backup recovery key, into a folder the server admin
  chooses (a OneDrive folder gets copies off the computer); each checked after
  it's made; 14 daily and 12 monthly kept; failures retried hourly and
  emailed to server admins. **Restoring** makes a copy of the organisation, so
  nothing is overwritten, and works on a new server given the old server's
  recovery kit (below).
- **Menus**: Home, Sales, Purchases, Banking, Payroll, Reports, Accounting,
  Tax and Settings across the top (Contacts under Sales/Purchases; #375,
  decision 700), each opening to its overview, lists and settings; a ☰ menu with
  every page until someone has. **Managed backups** (#389 part 1): a
  **Backups** page in Server settings (and a Status card in the server app)
  shows the latest backup and its age, when the newest files were last read
  back and checked again (weekly, or **Check backups now**), off-site as
  **not verified** (Tohyee can't see OneDrive uploads; the server app warns
  when OneDrive isn't running), the space used and free, and what needs
  attention or isn't proven, with no "safe" badge. Each file's SHA-256 is
  recorded; a file changed, replaced or deleted afterwards fails the check.
  Damaged files are never counted towards or deleted by pruning; a missing
  folder or a disk that's clearly too full fails the backup at once with a
  message saying what to do, keeping the older backups. **The recovery kit**
  (#389 part 2): backups are encrypted with a recovery key of their own
  (format 2), kept apart from the server's live secrets; the kit is that
  key alone, as a recovery code or a passphrase-protected recovery file
  (optional random name, said to be a convenience only), got with the
  password again and checked by giving it back, per key version. A new
  recovery key can be made; older backups keep opening and the status says
  which earlier kit to keep until when. The recovery kit is the only way in:
  the older backup key and the first backup format were removed before anyone
  used Tohyee (decision 867). **Restore on this computer** (#389 part 3): a
  wizard finds backups in any folder (OneDrive, a USB drive), takes the
  recovery code or file, checks the whole backup and its version first,
  restores as a new organisation (keeping its ID on a replacement
  computer), re-encrypts stored secrets for this computer, and starts the
  copy with its automatic jobs paused until a server admin turns them on.
  **Recover people** brings users, passwords, two-step sign-in and
  memberships back from a server backup with their own IDs, so private
  mail stays its owner's, with their Sign in with Google links (a Google
  account already linked to another login here is reported and left
  there, decision 851). **Test a restore** proves the newest backups
  restore, in a scratch database. An interrupted restore is cleaned up.
  Design: `docs/BACKUP-RECOVERY.md`.
- **Menus**: Home, Sales, Purchases, Banking, Payroll, Reports and Accountant
  across the top (Contacts under Sales/Purchases; Tax and Accounting under
  Accountant), each opening to its overview, lists and settings; a ☰ menu with
  the same sections on phones, where line editors stack each line's fields.
  Long columns have grey sub-headings so each group is two to six links, and
  settings live on an **All settings** page of cards (Settings › All settings)
  with the five most used left in the menu (#338, decision 580). Page titles
  use the interface font and Home has a compact header with no picture
  (decisions 701 and 703). Fields in a row line up by their controls, so help
  and error text under one doesn't move the others (decision 704).
  **Home** is now one page dashboard: four tiles (Cash in bank; Money owed to
  you; Bills to pay with due-this-week; Next GST return), net profit by month,
  a To do card and recent activity. With Farming on, Home is the **farm
  Home** (#341, FH1-FH8, decisions 587-589): this week on the farm (private to
  you) and Needs checking, stock by class with AI suggestions waiting,
  pasture cover, growth and supplements, fertiliser planned against applied,
  farm working expenses per unit against last season, a small Money card and
  the farm notebook. Each card links to its page, and empty cards are hidden.
  Customise turns cards on and off and orders them, per person, with
  Analytics tiles pinned alongside (up to 10). It also has **Records to
  catch up on** (old farm walks, unmeasured paddocks, missing season
  figures, bank lines to reconcile, stock suggestions and your own calendar
  items to check) and **Cash this season** (month ends from the bank, then
  the cash flow forecast to the season's end; FH9-FH11, decision 663). Not
  yet: production and income, FWE against budget and soil tests due.
  **Starting dashboards** (#360 item 20, decisions 660-664, HD1-HD5): sales
  reps and managers start on the CRM Home, farms on the farm Home and
  everyone else on the owner's Home, each with starting cards for their
  kind; your own Customise always wins, and **Go back to the starting
  cards** undoes it. Bills to pay and Needs attention show overdue bills,
  and Home offers Jobs and Sales pipeline tiles. No practice manager
  dashboard.
- **Logins and roles**: server admins; per-organisation owner, admin,
  bookkeeper and viewer; first-time setup; password changes and resets;
  sign-in lockout; admin CLI for recovery.
- **Invite people from People and roles** (#441, decisions 870-879, as
  Xero does): an owner or admin enters a name, email and role and presses
  **Invite**. Someone who already has a login is added straight away, as
  before (nothing is sent to them). Someone new gets a login that only
  opens this organisation (never a server admin) and an emailed link to set
  it up: choose a password, or Continue with Google. Until they first sign
  in they show as **Invited**, with **Resend** (a new link; the old one
  stops) and **Cancel** (takes them out, and takes away the login the
  invitation made if nothing else uses it). When the server can't send
  email, the inviter is shown the link to pass on. Only owners invite
  owners. An organisation can add or invite 30 people an hour. Audited.
  The demo farm refuses it. Server › Users still manages every login.
- **Payroll employee records** (PE1-PE12; examples not yet approved by Jess):
  employee details, pay frequency, tax code, student loan and KiwiSaver
  settings (including a temporary rate reduction approved by IRD, with its
  dates, PR13b); IRD numbers and bank accounts are encrypted. Employees are
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
  revaluation (MC8, MC39-MC43). A revaluation can be **voided** (both its
  journals reversed); a transfer out of a foreign account dated before a
  revaluation's reversal is refused, as is revaluing an account again
  before its last revaluation is reversed (FXB12-FXB13).
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
- **Year-end pack** (Accounting › Year end › Year-end pack; #258, decision 522): one
  ZIP for the accountant for a financial year. It holds:
  - the trial balance, profit and loss, balance sheet and general ledger
    (CSV)
  - a bank reconciliation for each bank and credit card account as at the
    year end (PDF)
  - for a farm with co-op shares, the co-op share register for the year
    (CSV) and the statements its entries name (#327, CSR9)
  - a read-me
  The figures come from the same report functions as the screens. Nothing
  is posted.
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
- **Not registered for GST** (#180, NR1-NR8, approved by Jess 8 Oct 2026;
  decision 478): Settings › GST has **Registered for GST** with optional
  "Registered from" and "Registration ended" dates. On a date the
  organisation isn't registered, only No GST codes can be used on sales,
  purchases, expense claims and bank lines, items don't add their GST code,
  new documents start with No GST amounts, documents print as **Invoice**,
  and the Shopify and WooCommerce postings leave GST out. While not
  registered the GST return and GST audit leave the menus, and period close
  shows the GST check as not applicable. The last return before
  deregistering lists the fixed assets still held as a reminder. Approved
  documents never change; dates that would leave GST in the books outside
  the registration are refused.
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
  voiding are idempotent. See examples I1-I9. A line can be free (price
  0.00, shown on the invoice) or negative (a discount or trade-in) as long
  as the total is above zero; for less, use a credit note (ZN1-ZN4, as
  Xero does, not yet reviewed). Bills, purchase orders and repeating bills
  take free and negative lines too, except for stock items (ZN5-ZN8).
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
- **Price changes on repeating invoices** (Sales; RP1-RP8, not yet
  approved, decision 535): a percentage up or down, or a fixed price for
  one item, across chosen templates, with a minimum increase and rounding
  to 50c, $1, $5 or $10, from a date. A preview shows every line and
  invoice total first. Templates whose next invoice is on or after the date
  change straight away; others change just before their first invoice on
  or after it. Lines edited since are left alone, and undo puts back old
  prices on lines still at the new ones. Nothing posts.
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
- **Expense claims** (Purchases; EC1-EC12, approved by Jess 5 Oct 2026), like
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
  bills (receipts with no tax code are left out). **Mileage** (MI1-MI7,
  decisions 407-410): a claim can have mileage lines (date, from, to,
  purpose, kilometres, vehicle type, account, 6120 by default) paid at IRD's
  kilometre rates with no GST: tier 1 for the first 14,000 km of the
  person's mileage per vehicle type in the income year, tier 2 after that,
  with the working shown on the line. **Kilometre rates** (Settings) are per
  income year and vehicle type; Tohyee starts with IRD's 2025-26 rates,
  admins enter later years, and a year an approved claim used can't change.
  Without the line's year's rates, the latest are used and the line says so.
  An admin can choose a draft line's tier. Batch payments and a submit-only
  role aren't built.
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
- **Jobs and visits** (Sales, Jobs; JV1-JV9 approved by Jess, decision 510,
  tenant migration 0129), like ServiceM8 and Tradify: a **job** is a project
  with a site address, a contact on site, a checklist and an optional
  service interval. **Visits** are booked for a member on a task and shown
  on the **job calendar** (by week, everyone or one person); overlaps are
  flagged. **My visits** on a phone: Start and Finish fill in the hours,
  which the person confirms into project time; checklist ticks record who
  and when, finishing with open items asks first; photos and the signature
  image are files on the visit, with who signed. **Materials** (items) go on
  the project invoice as item lines, so stock and cost of sales move when
  it's approved (as ServiceM8 does with Xero); unbilled materials stop a job
  closing unless written off. **Services due** show on the Jobs page. Visits
  download as an .ics calendar file (one way); the CRM's calendar connection
  is read-only, so they aren't pushed to it. Not built: adding visit photos
  to the invoice email straight from the visit.
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
  voiding are idempotent. See examples B1-B8. **Likely duplicates** are
  warned about on the bill (DU1-DU5, decisions 411-413): the same supplier
  and total within 7 days, or another supplier with the same invoice number
  and total. Approving one asks "Approve anyway?" and the history notes it;
  a connected AI can't approve past a warning.
- **Pay now with Stripe** (Settings, Online payments; PN1-PN12, decisions
  414-419, tenant migration 0098), like Xero's: approved invoices with
  something due get a Stripe payment link in their email and PDF (and Copy
  payment link on the invoice), for the amount due in the invoice's
  currency, through the organisation's own Stripe connection. Every 15
  minutes (and with Check now) Tohyee records paid links as customer
  payments into the Stripe bank account, where the Stripe feed's charge
  line matches them and fees arrive as their own lines. A link is replaced
  when the amount due changes; paying twice becomes an overpayment; a
  payment Tohyee can't record (a voided invoice, no linked balance) waits as
  a notice. An invoice can leave Pay now off. No surcharges, saved cards,
  webhooks or refunds from Tohyee. **Pay with PayPal** (PPN1-PPN10,
  decisions 420-423, tenant migration 0099) works the same way through the
  organisation's PayPal connection: Tohyee makes a copy of the invoice in
  its PayPal account (one line for the amount due; PayPal doesn't email the
  customer), links to PayPal's page, and records PayPal payments into the
  PayPal bank account for the invoice's currency. Only invoices in a
  currency whose PayPal balance is linked offer it.
- **Direct debit with GoCardless** (Settings, Online payments; GC1-GC10,
  decision 482, tenant migration 0113): an admin connects the
  organisation's own GoCardless account with an access token and chooses
  a clearing bank account, the payout bank account and a fees account. A
  contact gets a link to GoCardless's page to sign a BECS NZ authority.
  Then every approved NZD invoice for that customer is collected on its due
  date unless ticked "don't collect this one"; confirmed collections are
  recorded as payments into the clearing account, failures are voided and
  shown on the invoice and in the top bar with "Try again" (no automatic
  retry), and payouts are posted with their fees (without GST). Tested
  against a pretend GoCardless only.
- **Farm calendar from email** (Farm › Farm calendar; #319, FC1-FC16,
  decisions 570-572, tenant migration 0162, not yet reviewed): each member
  connects their own Gmail or Microsoft mailbox, read-only, and Tohyee reads
  vet visits, deliveries, stock trucks, contractor work, deadlines and
  meetings out of the emails with fixed rules (no AI): Today, Week, Month
  and Needs checking, filtered by farm and sender, with tentative wording
  marked, moved and cancelled bookings followed, a link to each email, and
  corrections. Private to the member who connects it. Since FC17-FC23
  (decisions 573-575, tenant migration 0163): items you add yourself, with
  private notes; repeats every 1, 2 or 4 weeks or monthly, with a date
  skipped; sharing chosen items with the whole organisation after a preview
  of exactly what they'll see (never the email or notes); and a private
  calendar link (.ics) for Google, Apple or Outlook to subscribe to, shown
  once. Since FC25-FC31 (#340, decisions 584-586, tenant migration 0164):
  only the Outlook folders or Gmail labels the member ticks are read, with
  their subfolders if asked, and nothing until one is ticked (mailboxes
  connected earlier stopped until their member chooses); the chosen folders
  show on the mailbox with Change folders; taking a folder off deletes what
  was taken from it, and emails moved out of the chosen folders drop at the
  next check (moved in, they're read). Since FC32 (#390, decision 741): with
  two or more farms, an item placed only by the mailbox's usual farm waits
  in Needs checking with the reason; No farm stays No farm. Not yet: attachments, changing one
  date of a repeat, and repeats read from email wording. The private copy
  (My mail, #250) uses the same connection and folder choice. Since #375
  (decision 705) the calendar comes first: mailbox setup opens from Manage
  mailboxes, someone with no mailbox gets a one-line Connect a mailbox
  prompt, an empty week offers Add an item, and the redirect addresses an
  administrator needs are under Settings › Email.
- **Farm safety records** (Farm › Safety; #446, FS1-FS12 in
  `docs/FARM-SAFETY.md`, decisions 930-941, tenant migration 0189, not yet
  reviewed by Jess): each farm's emergency details first (111, WorkSafe,
  address, entrance, assembly point, tap-to-call contacts, first aiders,
  equipment, a no-coverage plan; Print; a copy kept on the phone and shown
  with its age when Tohyee can't be reached), and hazards and no-go zones on
  the farm map (a point or a drawn zone, paddocks, how serious, what's done
  about it, review dates, reviewed and removed). Every record is kept as
  versions dated by the database, nothing can be changed or deleted, a
  mistake is corrected or withdrawn with why, and a hash chain shows changes
  made behind Tohyee's back (**Check the history**, **Compare with a copy**).
  The **WorkSafe pack** is a zip of everything in a date range with its full
  history and a checker that runs anywhere. Restricted incident and medical
  details are for owners, members an owner names, and their author. A
  record-keeping tool, not a compliance claim. Since FS13-FS20 (decisions
  942-947): **Report something** (hazard spotted, near miss, incident) on a
  phone, saved on the phone first and sent once; injury details kept apart
  and restricted; WorkSafe's notifiable-event questions prompting a person
  to tell WorkSafe (Tohyee never does) and recording when they did; photos
  with the camera's date and their hash; corrective actions through done
  and checked to a closed report, never closed by an AI or app. Since
  FS21-FS27 (decisions 948-952, tenant migration 0190): inductions (shared
  or per farm) read with the farm's hazards and emergency details, signed on
  your own login or recorded for someone, kept with the version and hazards
  shown, and "sign again" after a marked change or a new high or no-go
  hazard; On site now (sign in and out, missed sign-outs corrected); and a
  farm sign-in link with a QR code for visitors and contractors without a
  login. Since FS28-FS34 (decisions 953-957): equipment (ours, hired or a
  contractor's, a fixed asset optional) with QR codes and versioned
  checklists; pre-start checks that keep the questions as asked; a failed
  critical check puts a machine out of use with an action until someone
  allowed releases it (only an owner or admin, in person, chooses who
  besides them may: decision 969); a training register with expiry and the person
  confirming their own; and each farm's chemicals inventory with safety data
  sheets (a missing one needed; over five years old a prompt to get the
  current one when next supplied). Since FS35-FS38 (decisions 958-959,
  tenant migration 0191): a weekly PDF emailed off the farm through the
  organisation's own email, with the latest entry's number and hash, never
  injury details, recorded only when the mail server accepted it; each copy
  picks up after the last entry number a sent copy included, so nothing
  entered between copies is missed (decision 970). Since
  FS39-FS44 (decisions 960-962): in the farmer's workspace (#447) the
  Safety tab, hazards on the map and paddock card, Report a hazard / Near
  miss / Incident in Log, a Safety card on Today and Safety due on the farm
  calendar; farm staff report, check and sign on their assigned farms and
  never see injury or medical details. Since FS45-FS48 (decisions 963-968, the
  answers to the open questions; Claude, delegated by Jess, 28 October
  2026): the five-year keeping period for notifiable-event records (s 57)
  on the report and in the pack, a link to WorkSafe's current guide and
  its site exceptions in the prompt, gate-link sign-offs labelled
  "self-declared, no login" (with the suggestion to invite regular
  contractors as Farm staff), and a short privacy notice on the gate page.
  Since FS49-FS51 (#446 layout follow-up, decisions 976-989, not yet
  reviewed by Jess): Safety is a small overview (emergency strip with Call
  111 and the address, **Report something**, **Check equipment**, **Sign in
  / induction**, **Needs doing** with links to each record, and **Browse
  safety** with counts) and focused screens with their own addresses and
  Back to Safety; a machine's QR code opens its check directly; reports in
  two short steps, kept in the tab while moving around; WorkSafe's
  questions as Yes / No with unanswered never taken as No; large check
  choices; and actions not on a report listed under Other actions.
- **My mail: a private copy of an Owner's own mail** (user menu › My mail;
  #250 with #340, PM1-PM29, decisions 610-619 and 720-726, tenant
  migrations 0168, 0169 and 0180, not
  yet reviewed; not tried with a real mailbox): an Owner of any
  organisation keeps a copy of their own Gmail or Microsoft mail, from the
  folders or labels they tick on the farm calendar's one connection and
  folder choice (nothing until they tick one; drafts, spam and trash only
  if ticked, and never for the farm calendar), read-only,
  back to the read-back date. A first copy that resumes, with progress,
  dates covered, last sync and errors; then a sync every 15 minutes, with
  emails moved out of the ticked folders dropped and moved in copied;
  emails deleted in the mailbox are kept, marked (an archive).
  Search (whole words, from: and to:), conversations, and attachments to
  download (files over 20 MB keep their name only). Only that Owner can
  read it, through one access layer: everyone else, admins, other Owners,
  accountants, server admins and app keys included, gets "not found", and
  ownership never moves. Encrypted in the database with a key of its own,
  wrapped with the server's key; docs/PRIVATE-MAIL.md says what that does
  and doesn't protect against. Off, Disconnect (keeps the history) and
  Delete imported history are separate. Since PM15-PM19 (decisions 618,
  619, tenant migration 0169): the Owner can let their own Look only AI
  keys search and read it over MCP (search_my_mail, read_my_mail), citing
  each email; no other key is offered the tools. Since PM20-PM29
  (decisions 720-726, tenant migration 0180): **File…** on an attachment
  files a copy into the bills inbox, a soil test, pasture reading or
  fertiliser application import, or an existing record's files, after a
  preview of exactly what others will see and what stays private (each
  feature's own import preview and checks; refused if anything changed
  since). Filed copies say "filed from a private email" and carry nothing of
  the email. Rules (sender or @domain and/or a file name pattern) put
  matches in **To file** for the Owner to confirm one by one. Not yet:
  making the bill while filing, choosing import columns from My mail, rules
  that file without asking.
- **Consolidation** (Reports, Consolidation; CO1-CO12, decisions 437-445, 563,
  core migration 0007, tenant migration 0102), like NetSuite OneWorld:
  groups of organisations on this server in different currencies and with
  different year ends, reported in the parent's currency (profit and loss
  at monthly average rates, the balance sheet at the current rate, equity at
  historical rates, with a translation reserve), with intercompany accounts
  and what's owed between members eliminated and any differences shown.
  Elimination adjustments (including unrealised profit in stock, typed by
  the accountant), changed rates, budget exchange rates and a
  consolidated budget vs actual. Seen only by people in every member.
- **Group workspace** (#200 stage 1; decisions 640-647, CO13-CO14, core
  migration 0015, tenant migration 0173), the first tab of a consolidation
  group: the members on a date, the consolidated revenue and net profit for
  the year to date (from the existing consolidated profit and loss), each
  member's share and what its customers owe, the CRM pipeline per currency
  (translated into the group's currency only when asked, with the rate
  shown) and by stage, and linked customers. Members have first and last
  days, and reports include the members in the group on their date
  (refusing dates that cross a join or leave). Customers are linked across
  organisations by a person, never merged; stages that differ need a
  person's mapping. Save a copy keeps a consolidated report with the
  members it used. A steward member keeps these records in its own
  database. Missing modules or unreadable members are named, so a partial
  result never passes for the whole group. Says that a group isn't a tax
  group. Not yet: a group selector that stays across modules, group
  analytics datasets and dashboards, group CRM lists and search, exports of
  the workspace, account mappings between different charts, nested groups,
  ownership and minority interest, acquisitions and disposals, moving the
  existing core records to the steward (planned and dry-run tested only,
  decision 646), and Projects, Inventory, Payroll and Tax summaries.
- **Exchange rates from the European Central Bank** (FX1, decision 437):
  turned on per organisation, each working day's ECB rates are added to the
  exchange rates list for the currencies in use; typed rates stay.
- **Several logins per bank feed** (#182, BK30-BK37 approved by Jess 8 Oct
  2026, decision 481, tenant migration 0112): Akahu, SimpleFIN, Stripe,
  PayPal and Wise each take any number of named logins (say Jess's ANZ
  login and Will's BNZ login). Linking lists every login's accounts as
  "login · account", each account syncs with its own login's tokens, a
  login whose tokens are refused says so without affecting the others, new
  tokens carry its accounts on, and removing a login stops only its feeds.
  Stripe, PayPal and Wise allow one link per currency per login.
- **Feed health** (#258, decision 520):
  - A feed that hasn't tried to sync for 2 days shows "not syncing" on its
    account, and the top bar says how many have stopped. That usually
    means the server was off or its sync job isn't running.
  - "Needs reconnecting" now counts failed SimpleFIN, Stripe, PayPal and
    Wise feeds as well as Akahu's.
  - There's no re-authorisation link: Akahu feeds use tokens an admin
    pastes in.
- **Accounting as a module** (#181, MOD2-MOD7 approved by Jess 8 Oct 2026,
  decision 480, tenant migration 0111): a server admin chooses an
  organisation's modules when creating it (Accounting, Tax = registered for
  GST, CRM, Analytics), and admins change them under Modules (account menu,
  every app). With Accounting off the organisation is CRM or Analytics
  only: no Accounting menus, its pages say it's off, an opportunity can't
  make an invoice, the books copy has only CRM tables, and bank feeds,
  sales platform syncs, repeating documents and the other Accounting jobs
  pause until it's back on. At least one of Accounting, CRM or Analytics
  stays on; Advanced reporting and Not-for-profit need Accounting.
- **Rate source and uploaded rate sets** (#183, FX2-FX9 approved by Jess 8
  Oct 2026, decision 479, tenant migration 0110): Accounting › Exchange
  rates chooses where rates come from: ECB (daily), uploaded rate sets, or
  typed only. A set is a CSV or Excel file of currency and rate for a
  period, named for its source (IRD's monthly averages, the Reserve Bank,
  a bank), quoted either way round and previewed before it's saved. While
  sets are the source, a document dated in a set's period takes its rate
  and a date outside every set asks for one. A set overlapping another
  replaces it with a reason. Changing the source while ECB or sets are in
  use asks for the reason Inland Revenue asks you to keep. Every rate in
  the list shows its source, and invoices, bills and credit notes record
  where their rate came from.
- **Cash flow forecast** (Reports, Cash flow forecast; CF1-CF9, decisions
  432-436, tenant migration 0101), like NetSuite's Cash 360: today's bank
  balance, then money in and out by day, week or month (about 3 months by
  default) from open invoices and bills on their due dates, repeating
  invoices and bills, unpaid expense claims, forecast items (once or every
  week or month) and account averages (e.g. wages from the last 3 or 6
  months), optionally drafts and sales and purchase orders. Shows the lowest
  balance and the first period below zero, each period's documents, and
  exports to CSV, Excel and PDF. The connected AI can read it.
- **Report commentary** (AC1-AC2, decision 446, core migration 0008, tenant
  migration 0103): a commentary card on the cash flow forecast and on a
  group's consolidated profit and loss and balance sheet. The connected AI
  can suggest one ("Suggested by Jess's AI key Claude, not checked") that a
  bookkeeper accepts, edits or removes; people can write their own.
- **Approval workflows** (Settings, Approval rules, and Purchases,
  Approvals; AW1-AW17, decisions 424-431, tenant migration 0100), like
  ApprovalMax and NetSuite's approval routing: rules for bills, purchase
  orders and expense claims (a total at least an amount in the base
  currency, a supplier or claimant, an account or tracking value on any
  line) send a document through approval steps, each needing any one or all
  of its approvers. A matching draft is submitted rather than approved, and
  can't be edited until it's approved, declined (with a reason) or
  withdrawn. Each approver is asked on the Approvals page and by email (a
  link that needs signing in). The approval page shows the steps, who has
  approved, and the month's budget for each account ("Over budget by
  900.00"), never blocking. The last approval approves the document as
  usual; a locked period leaves it waiting with the reason. Nobody approves
  their own document. The connected AI can submit and list, never approve.
  Repeating bills under a rule are submitted instead.
- **Bills inbox** (Purchases, `/operations/bills/inbox`; BI1-BI7, decisions
  404-406, tenant migration 0097), like Xero's files inbox and Dext: supplier
  bills and receipts (PDF, JPG, PNG, HEIC) waiting to be entered, uploaded
  several at a time or read from a **mailbox folder or Gmail label** (an
  admin's own CRM mailbox or IMAP, every hour or with Check now, each email
  once, with its sender and subject). **Make bill** opens a new draft with
  the file beside it and attaches it when saved; files that aren't bills are
  removed with a reason. The same file arriving twice says where it went
  before. **The organisation's connected AI** (with a "Make drafts" key) can
  list the inbox, read each file and make the draft bill from it, which a
  person then checks and approves; Tohyee itself reads no documents (no OCR).
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
- **A contact's default account and tracking** (Xero's contact "Purchase
  defaults" and "Sales defaults", examples SD1-SD3, decision 384). Contacts
  have an optional default purchase account and tracking (bills, supplier
  credit notes, spend money) and default sales account and tracking
  (invoices, sales credit notes, receive money). Choosing the contact fills
  them into lines nobody has filled in yet, and lines added afterwards start
  with them; bulk coding uses them for a line with no account. Archived
  defaults are kept but not used.
- **Bank accounts and reconciliation**. Bank and credit card accounts (any
  number, any bank) with a statement balance, the balance in Tohyee and a
  count of lines to reconcile. Statements come in as files (CSV and Excel
  with column mapping that's remembered per account, OFX/QFX/QBO, QIF,
  CAMT.053 and MT940; up to 10 MB) or through an **Akahu bank feed** (NZ),
  which can bring in history from a chosen start date (as far back as Akahu
  and the bank allow) and then syncs in the background, re-reading the last
  30 days so late-settling transactions arrive; lines deleted from any API
  feed stay deleted (BK29). **Automatic
  statement files**: for banks without a feed, each account can read new
  statement files by itself from a folder inside the organisation's bank
  files folder (chosen by a server admin) or from a mailbox folder or Gmail
  label (the admin's own CRM mailbox, or IMAP with an app password), every
  6 hours by default (1-24) or with Check now. Each file is imported as if
  by hand, read again only when it changes; CSV and Excel files must match
  the columns of the last file imported by hand, or they wait (examples
  BF1-BF10, decisions 385-387). **SimpleFIN bank feeds** for overseas
  accounts (mostly US banks): the organisation connects its own SimpleFIN
  Bridge account with a setup token, links each account (its currency must
  match, so USD accounts work), chooses the bank's time zone, and transactions
  come in every 6 hours or with Sync now, within the Bridge's 24 requests a
  day (examples SF1-SF10, decisions 388-391). **Stripe as a bank feed**:
  the organisation's Stripe balance becomes a bank account (e.g. 1050
  Stripe), connected with a read-only restricted key; each charge comes in at
  its full amount, with Stripe's fees and any tax on them as separate lines,
  and refunds, disputes and payouts as Stripe reports them, so charges match
  invoices and payouts reconcile as transfers (examples ST1-ST10, decisions
  392-395). **PayPal as a bank feed**, the same way: the live REST app's client
  ID and secret (stored encrypted; PayPal has no read-only credentials, which
  the screen says), each completed payment with its fee as a separate line,
  refunds, chargebacks, holds, currency conversions and withdrawals as PayPal
  reports them (examples PP1-PP10, decisions 396-399). **Wise as a bank
  feed**: each currency balance of the organisation's Wise business account
  (based in NZ, Australia, the US, Canada, Singapore or Malaysia), connected
  with a personal API token stored encrypted, with Wise's fees split onto
  their own lines when Wise's running balance confirms them (examples
  WI1-WI10, decisions 400-403). Duplicates are
  skipped; lines that look like a file-and-feed duplicate are flagged. Each
  line is reconciled by matching what's already posted (within 60 days),
  paying invoices or bills, creating spend or receive money (with GST), or a
  transfer between accounts; lines can be excluded, unreconciled and imports
  deleted. A **transfer is suggested** when another of your accounts has an
  unreconciled line for the opposite amount within 2 days, in the same
  currency. Choosing it saves the transfer and reconciles both lines at once
  (#258, decision 521). **Bank rules** fill in spend or receive money for lines that
  meet their conditions (all or any of: payee, description, reference and
  other text *contains*, *equals* or *starts with*; amount *equals*, *at
  least*, *at most* or *between*), with a chosen contact or the contact named
  like the payee, and one or more lines: fixed amounts first, then the rest
  split by percentages, each with its own account, GST code and tracking
  (examples BR1-BR10, decisions 380-383). Rules only suggest; nothing posts
  until OK. Each organisation sets up its own Akahu personal app (with its own
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
  fund activity. Fund equity carryforward, conditional grant accounting and
  donation tax-credit receipts are not supported; see the NFP examples and
  questions in `docs/ACCOUNTING-EXAMPLES.md`.
- **Tier 3 and Tier 4 performance reports** (Reports › Financial statements;
  NPR1-NPR10, not yet reviewed, decision 536): the organisation chooses
  special purpose statements, Tier 3 (accrual) or Tier 4 (cash). Entity
  information, a statement of service performance with measures for both
  years, statements in XRB's minimum categories (each account's category
  suggested from its type until chosen), cash by what it was for (payments
  split by the invoices and bills they paid, credit cards as cash, GST as one
  line), and draft notes for each tier, as one PDF. Opening balances
  entered during a year show on their own cash line, not as receipts or
  payments (NPR11). Accounts nothing has been posted to are hidden on the
  categories list until asked for.
- **CRM** (after [Twenty](https://github.com/twentyhq/twenty), built in):
  its **own app** at `/crm`, with its own top bar (Home, Contacts, Sales,
  Tasks, Dashboard, More and Settings, the last ones opening to grouped
  menus; a ☰ menu on phones; #342, decision 581), the same
  sign-in, organisations and roles. An **app switcher** (Accounting / CRM)
  beside the Tohyee name in both apps replaces the old CRM menu; it shows
  only while the CRM is on for the organisation, so people without it never
  see it. Old `/operations/crm/...` links redirect to the same pages under
  `/crm`. The CRM's **Home** shows the signed-in person's open opportunities
  (with a total per currency), their tasks due today or overdue, and the
  team's ten most recent calls, meetings and notes (CRM10, not yet approved
  by Jess), with **Pipeline**, **Conversion** and **Next actions** cards in a
  dashboard frame each person can customise (decision 662, SD1-SD6), and a card for Shopify: connected stores with their last sync
  and error, or "Connect Shopify" for an admin; CRM › Settings ›
  Integrations opens Settings › Sales platforms (decision 582). Companies are the contacts, which can now also be **prospects**; **people**
  at each company; **opportunities** with the organisation's own stages
  (starting with Twenty's, plus Lost) on a drag-and-drop pipeline board, where a won one makes its draft invoice in
  one click (and makes a prospect a customer); an opportunity for a company
  in another currency is in it, amount and invoice (MC68, MC69), and the
  board totals each currency on its own; **tasks** with due dates and
  assignees; logged **calls, meetings and notes**; and a **timeline** per
  company that also shows its invoices, credit notes, bills and payments.
  People, opportunities, tasks and activities are never deleted (CRM1-CRM9).
- **CRM sales roles and teams** (decision 491, #216, Jess 10 Oct 2026):
  **Sales rep** and **Sales manager** roles use the CRM and nothing else (no
  books, payroll, analytics or settings; anywhere else goes to the CRM, apart
  from their own profile). Everyone in sales sees every company and person
  (one address book) and the company's shared history, but a rep sees only
  the deals and tasks they own or are assigned, their own forecast, and
  activities other than those on someone else's deal; a manager also sees
  their teams'. Sales roles see no invoices, credit notes or payments on a
  company or deal, can't make an invoice or sales order from a won deal, add
  companies as prospects with their contact details only, and can add notes
  and files on a company. **CRM › Teams**: admins and owners make teams (a
  manager and members; one team each). Search finds only a sales person's
  CRM records. Viewers and up see every CRM record as before.
- **CRM leads** (decision 492, #216): CRM › Leads, for enquiries before
  they're customers, after Salesforce's leads: typed in or imported from a
  CSV or Excel file (duplicates of open leads skipped), owned by whoever adds
  them, worked (new, working, unqualified with a reason) and converted into a
  company (a new prospect or an existing one), a person and optionally an
  opportunity, keeping their calls, notes and tasks. Leads show in search,
  scoped like deals for sales roles. Leads also arrive from a **web form**
  on the business's own website (HTML to paste, a hidden trap field and
  limits per sender against spam) and from a **mailbox folder or label**
  (each email once; one from an open lead adds a note to it), unassigned and
  "to review" (decision 493).
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
  month (base currency) and see attainment. **Team forecasts**
  (decision 499): each sales team's figures added up with its quotas; a
  team manager (or an admin) can adjust a member's Commit or Best case with
  a reason, shown next to the deals' own figure, with every change kept;
  and a person, a team's manager or an admin can submit a period's
  forecast, kept as it was to compare with now. Not built: converting
  currencies in forecasts (kept apart, decisions 324 and 499) and quotas by
  quarter or in other currencies.
  **Email and calendar sync**: each member connects their own Gmail or
  Microsoft 365 mailbox (read-only unless they allow sending, decision 496;
  through the organisation's own Google or Microsoft app, tokens encrypted); every 15 minutes Tohyee keeps only the
  emails and meetings with known people, companies and open leads (subject
  and a short preview, never full bodies or attachments; leads' since
  decision 651) and shows them on timelines and lead pages,
  with each mailbox choosing whether the team sees subjects or only that
  something happened (MAIL1-MAIL9).
- **CRM duplicates** (decision 494, #216): CRM › Duplicates suggests
  companies with the same name (ignoring case, accents, punctuation and
  endings like Ltd), email or phone, and people with the same email or the
  same name at the same company. A company with no accounting records can
  be merged into the other (its people, deals, tasks, activities and
  converted leads move across; it's archived and says where it went); two
  that both have accounting records are only linked as the same customer,
  shown on each company's page. People merge within their company. Adding
  a company or a lead warns about similar companies, people and open leads.
  Merging needs the bookkeeper role or higher; anyone who changes CRM
  records can mark a pair as not duplicates.
- **CRM bulk reassignment** (decision 650, #216): CRM › Settings ›
  Reassign records moves leads, companies, open deals (closed ones if
  ticked), open tasks and active sequences from one person (or someone who
  has left, or nobody) to another, after listing every record that will
  move so any can be unticked. Admins and bookkeepers move anyone's; a sales
  manager only within their teams; reps can't. Each record moved shows it
  in its history, and the page lists recent moves.
- **CRM follow-up rules** (decision 495, #216 stage 2): CRM › Follow-ups,
  for admins and owners. Rules make a task for the right person when a new
  lead arrives (its owner, or each sales team manager if nobody owns it), a
  deal reaches a chosen stage (its owner, due N days later), an open deal
  goes quiet for N days (a reminder for its owner, once per quiet spell),
  a task is N days overdue (the assignee's team manager), or a renewal is N
  days away (the deal's owner, decision 654). Rules are checked
  every 15 minutes or with Run now, and the page lists what each run did.
  Each event makes its task once, even if a check runs twice. Reminders stay
  in Tohyee; nothing is emailed.
- **CRM sales emails** (decision 496, #216 stage 2): each person can allow
  sending from their own connected Gmail or Microsoft 365 mailbox (a second
  sign-in that adds sending), then use **Send email** on a lead, a person or
  a deal's point of contact. Admins write **email templates** with merge
  fields ({{first_name}}, {{company}}, {{my_name}} and others); the sender
  checks and edits the words, and nothing goes until they press Send. Plain
  text only, logged as a note on the record. People and leads can be marked
  **Don't email**, and are then never sent one. A retry never sends twice;
  one that may have gone is shown as "check your Sent folder" and isn't
  retried.
- **CRM sequences** (decision 497, #216 stage 2): admins set out steps
  (email from a template, call, or task) on days from the start; a lead,
  person or deal is added to one from its page, and each step becomes a
  task on its day for the owner. Nothing is sent by itself. It stops when
  they reply, a lead is unqualified or converted, a deal is won or lost, or
  someone stops it; email steps are skipped for people marked "Don't
  email".
- **CRM replies** (decision 651, #216): when a lead or person replies to a
  sales email (sent in the 30 days before) or while in a sequence, their
  owner gets one task, "Reply from …", due today, checked straight after
  each mail sync; the sequence stops as before. One task per email or
  sequence answered, never two for the same reply. Tested with pretend
  Gmail only, not real Gmail or Microsoft 365.
- **CRM campaigns** (decision 498, #216 stage 2): CRM › Campaigns, for
  events, adverts, emails and the like, with dates, a budget and an actual
  cost (for reports only). Each lead and deal has one source campaign
  (set by hand, by a web form or lead mailbox tied to the campaign, or on
  import; a deal from a lead keeps it), so won revenue is counted once.
  Members are added from the Leads list in bulk or from a lead's or
  person's page, and move from added to sent (emailed) to responded
  (replied). Each campaign's page shows leads and deals from it, won and
  open amounts per currency, and cost per lead and per won deal.
- **CRM sales dashboard** (decision 500, #216 stage 3): CRM › Dashboard,
  by month or quarter: lead conversion, win rate and won amounts, sales
  cycle (average and median days), open deals by stage with how long
  they've been there, activity per person, quota attainment and campaign
  results. A sales rep sees their own; deal counts open the deals.
- **Line discounts** (decision 501, DS1-DS6): a "Disc %" on invoice, quote,
  sales order, repeating invoice and credit note lines, rounded once per
  line with GST worked out on the discounted amount, shown on screen and on
  printed and PDF documents, and kept when one document is made from
  another.
- **Deal products and quotes** (decision 502, DS7-DS9): a deal's product
  lines (item, quantity, price, discount, excluding GST) set its amount;
  Make quote turns them into a draft quote, New revision replaces the open
  one, and accepting the quote wins the deal and links its invoice or
  sales order.
- **CRM account plans and renewals** (decisions 653-654, #216 stage 4): a
  company's Related tab has an account plan (where things stand, goals with
  target dates, the part each of its people plays in buying, plus its
  renewals, open deals and open tasks as next steps). A deal and its
  products can have renewal dates, and a follow-up rule reminds the deal's
  owner N days before, once per deal and date.
- **Livestock: movements and head counts** (#221 stage 2, decision 504,
  LV1-LV3): dairy cattle, beef cattle and sheep by IRD's NAMV classes.
  - **Starting:** livestock is a module, turned on in Settings › Modules
    (it needs Accounting, and turning Accounting off turns it off). It
    starts from the current income year, which can change in Livestock
    settings until movements are recorded. That year's opening (head and value by class) comes from
    last year's workpaper.
  - **Movements:** births, purchases, sales, deaths, missing and found
    stock, class changes and moves between locations. A sale or purchase
    can link an approved invoice or bill line, once per class.
  - **Ageing:** worked out at the start of each year. How many mixed-age
    ewes turn rising five is said per year.
  - **Head count reconciliation:** by class, with ageing netting to zero.
    Year-end counts show any difference as "not explained".
  - **Stock held for others** is shown but never counted.
  - **Killed for rations** (RAT1-RAT10, decisions 624-627, tenant
    migration 0171; Jess, 20 Oct 2026, not yet reviewed): homekill for the
    owner and staff rations are head counts and post nothing. Under
    Livestock › Movements, the accountant enters one homekill adjustment a
    year (amount, basis, and GST if it applies on a GST-registered date):
    Dr drawings or current account, Cr rations income, Cr GST. With GST it's
    in that date's GST return. The year's head count is shown beside it.
    Voiding needs a reason. Rations posted per event before 20 Oct 2026
    stay, and are shown so they aren't counted twice.
  - **Never below zero:** no class is let go below zero on any date.
  - **Year-end valuation** (stage 3, decision 505, LV4-LV12):
    - Herd scheme and national standard cost (mature group averaged). Each
      farm's elections are kept with their evidence.
    - IRD's 2026 rates come with Tohyee, and an admin can add other years
      with their source.
    - The workings and the trading statement show taxable profit, with the
      non-taxable revaluation separate.
    - One approved journal posts at the year end. The revaluation goes to
      profit and loss or a reserve (the reserve only under special purpose
      reporting; LV28, decision 567).
    - Each class is current (held for sale) or non-current; the valuation
      moves the current classes' value to 1490 (LV27, decision 566).
    - Approval is refused until counts, elections, rates, amounts and the
      ledger opening tie.
    - Replacing a valuation reverses its journal.
  - **Agent account sales** (LV13-LV16): stock lines, deductions and
    the net the agent owes, entered once. They are kept as an invoice, a
    bill and a contra, so GST, payments and receivables work as usual.
  - **Beef males under NSC** (LV17) add a cost each year until rising
    three, then join the mature group.
  - **Monthly management values** (LV18-LV20): stock on hand at the
    farm's own values per head, month by month, with head and price
    changes. A report only.
  - **Stage 4** (LV21-LV26, from IRD OS 25/02):
    - Deer and goats.
    - Male breeding stock under the herd scheme, or alongside NSC.
    - Herd value ratios, including Chatham Islands.
    - Bought young stock under NSC at cost.
    - High-priced livestock, with IRD's rate typed by the accountant.
  - **Screens** under Accounting › Assets › Livestock: the head count,
    movements, and the valuation with a step for each. Livestock's
    settings (opening, elections, rates, accounts, locations) are under
    Settings.
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
  **History** (step 7; IM22-IM28, as NetSuite's journal import does, not
  yet reviewed, decision 540): a general ledger from the old system after
  the opening balances, such as a year from MYOB, comes in as one journal
  per date and ID# (MYOB's Src and ID# can be joined), up to 50,000 rows.
  MYOB's layout with account headings works; rows without dates are
  skipped. Every journal must balance and every account exist, or nothing
  posts; a transaction already imported is refused. Imported journals are
  "Imported history", out of the journal list unless chosen there, and in
  every report. No GST codes, so GST returns leave them out.
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
- **Sign in with Google for invited people** (#424, decisions 800-809):
  a setup link offers **Continue with Google** (for the Google account with
  the invited address) instead of a password; people with a password link a
  Google account on Your account (password again) and can unlink it while
  they still have their password; the sign-in page shows **Sign in with
  Google**. Linked by Google's account ID, with a verified email; an
  uninvited Google account can never make a login. A Google sign-in relies
  on Google's own checks; password sign-ins keep two-step. Server admins
  always keep a password. Set up per server in Server settings › Sign in
  with Google (client ID and secret, or an organisation's existing Google
  app), with the sign-in address to add to the app and a warning when the
  server has no web address Google accepts. OpenID Connect with state,
  nonce, PKCE and a browser-bound cookie; only `openid email profile`.
  A server admin removing someone's Google sign-in also disconnects their
  AI apps, AI keys, farm app keys and PowerPoint add-in sign-ins; their
  password keeps working (#432, decision 850). Unlinking your own leaves
  them connected and the email says how to disconnect them (decision 852).
  Tested against a made-up Google only; not yet tried with a real Google
  account.
- **Sign in with a passkey** (#450, decisions 885-899): Face ID, a
  fingerprint or Windows Hello. Under **Your account › Passkeys**, enter
  your password, name the passkey ("Jess's iPhone") and **Add a passkey**;
  the sign-in page then has **Sign in with a passkey** (and offers passkeys
  in the email box where the browser can). The face or finger never leaves
  the device: Tohyee keeps only the passkey's public key. A passkey sign-in
  counts as two-step. Passkeys can be renamed and removed; a server admin
  can remove someone's under Users (which also disconnects their apps).
  Resetting a password or two-step, a setup link, changing your password or
  turning a login off ends them. Only on Tohyee's web address (Remote
  access) or on the server computer as localhost; on a home-network
  address the page says why. Recorded in the sign-in monitor and limited
  per address like other sign-ins; a security email for each added or
  removed passkey. Tested with a software authenticator only; not yet tried
  with a real phone.
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
  SMTP, or any SMTP server on port 25, 465, 587 or 2525 at a public
  address (a mail server on the Tohyee server or its local network needs a
  server admin to turn on "Allow local mail relay"); from name, from address, reply-to; the password
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
  currencies, gift cards, tips or duties.
- **WooCommerce orders** (WC1-WC10, decisions 451-455, tenant migration
  0105; not tried against a real store): connect a store with a REST API
  key; paid orders become invoices with their payment recorded into the
  account chosen for the order's payment method (Stripe into the Stripe
  feed's account, WooPayments into a clearing account); bank-transfer
  orders are invoiced and left owing for the bank feed to match, and voided
  if cancelled unpaid; refunds become credit notes. Customers matched by
  email, lines by SKU. Surcharges and other currencies are refused. A
  refund line is matched to the order line its `_refunded_item_id` names
  (decision 666).
- **Shopify checked against Admin API 2026-10** (decision 665): the
  version, webhook subscriptions by `uri`, payout transactions checked
  against their payout, and a plain message when Shopify withholds
  protected customer data. Still not tried against a real store.
- **Shopify chargebacks and reserves** (SPC25-SPC31, decisions 447-450,
  tenant migration 0104): a payout's chargebacks go to the chargebacks
  account chosen in the settings (fees to fees), won disputes come back,
  and money Shopify holds back moves to a reserve bank account until it's
  released. Chargeback holds and anything Shopify doesn't explain are
  still refused. No summary mode (Jess): each order keeps its invoice.
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
  **Paused when someone is guessing** (decision 542): 20 failed sign-ins
  through remote access within 10 minutes, from any logins and addresses,
  pause signing in and signed-in use through remote access for an hour
  (doubling if it happens again the same day, up to a day) and email the
  server admins. The local network, and customers' payment and form links,
  carry on. A server admin can resume it on the server computer (Remote
  access).
  The Remote access pages say plainly who can see the traffic (#208): with a
  Tohyee address or your own domain, Cloudflare decrypts it on its network;
  with Funnel it stays encrypted to this computer. Through remote access,
  `/api/health` gives only up or down, and a Cloudflare sign-in file left by
  an interrupted Connect to Cloudflare is deleted when the server app starts.
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
  the preparer to approve (someone who changed a draft's employee's tax
  code, student loan, KiwiSaver, ESCT, bank account or pay rate counts as
  preparing it, PRUN7b). Approved pay runs can't be changed, only voided
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
  ASB's CSV format. The file pays the bank account kept when the pay run
  was approved, with a warning if the employee's account has changed since
  (PBF8).
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
- **Farm benchmarks by farm** (Farm › Benchmarks; #390, FR1-FR8, decision
  743, tenant migration 0182, not yet reviewed): as Xero does with tracking
  categories, a chosen tracking category carries the farm and each farm is
  linked to a value. The year's gross farm revenue, working expenses and
  operating surplus are split by farm, with **Not allocated** shown (never
  spread) and a total that is the organisation's benchmarks. Each farm's
  own hectares, cows, stock units and milk solids are entered for the year,
  and its per-unit amounts use only those. Shared costs and charges
  between farms are moved with journals. Needs Advanced features on.
- **Farms each member works on** (People and roles; #390, FMA1-FMA8,
  decision 744, tenant migration 0183; Jess: "Yes, assigned farms only"):
  with two or more farms, viewers, bookkeepers and report viewers see and
  record only for their farms (or all farms if chosen); owners and admins
  see every farm. Not assigned yet means no farms, with a warning on the
  screen. Enforced on the server for every farming route, Home's farm
  cards, the shared farm calendar, farm apps and AI tools; the farm
  notebook and Analytics' farm tables need all farms.
- **Farms and paddocks** (Farm menu; #249 stage 1, decision 514, tenant
  migration 0133): an optional module, part of Accounting, turned on in
  Settings, Modules. **Farms** hold **paddocks**. The farm selector supports
  multiple properties within one organisation. Maps, soil, pasture and
  fertiliser share the selected farm in the current browser tab, separately
  for each user and organisation. With multiple farms and no saved choice,
  the user chooses before working; an unavailable saved or linked farm never
  silently falls back to another one, and the page says so. With one farm
  there's no selector. Links can open a farm (`?farm=`); Home's pasture,
  catch-up and fertiliser lines use them (decision 740). Boundary imports
  show their destination farm in the preview and import button, and an
  archived farm can't be imported into. Farm Home remains an all-farms overview:
  money, livestock and performance are organisation-wide, not separate books
  or farm profitability reports. **All farms compared** (Farm menu, and
  from the farm selector; #390, PF9, decision 742): each active farm's
  area, pasture cover with its reading dates and freshness, paddocks
  missing readings, and latest fertiliser plan, with links to that farm's
  records, and a total row worked from every paddock (not an average of
  averages). No money figures. A paddock's identity
  doesn't depend on its name, and its **effective area** (what plans use,
  FB1) sits beside its **mapped area**. The mapped area is worked out from
  its boundary, geodesically on WGS84 with GeographicLib, with no PostGIS.
  Boundaries are versioned GeoJSON; the newest is current and earlier ones
  are kept. **Splits and merges** retire the old paddocks on a date and link
  the new ones to them, so history keeps its own areas (FB7); a retired
  name can be used again. **Importing** a GeoJSON file shows a preview first:
  paddocks are matched by name; new names add paddocks; a changed shape
  adds a boundary version; shapes that cross themselves, aren't closed or
  are in NZTM metres are skipped with the reason. The same file can't be
  imported twice. The **map** draws the paddock outlines to scale, north
  up. With an organisation's own **LINZ Basemaps key** (an admin adds it on
  the Farms and paddocks page), **aerial imagery** shows under the outlines.
  The browser loads it straight from LINZ, with LINZ's attribution, and it
  can be switched off. In **Analytics**, while Farming is on, the books copy
  also carries these tables, row for row as recorded:
  - `tohyee_farm_paddocks` (with each one's current boundary as GeoJSON)
  - `tohyee_farm_fertiliser_products`
  - `tohyee_farm_fertiliser_plan_lines` (every version)
  - `tohyee_farm_fertiliser_applications`
  - `tohyee_farm_fertiliser_bill_links` (bill id and line, to join
    `tohyee_bill_lines`)
  - `tohyee_farm_soil_results`

  Tapping a paddock shows its soil tests and fertiliser applications.
  **Drawing** (decision 517): a paddock is drawn on the map by tapping its
  corners, or redrawn from its panel, with pan, zoom and "My location".
  Outlines that cross themselves are refused, and overlaps with other
  paddocks are warned about. **Importing** also reads KML and KMZ (Google
  Earth) and zipped shapefiles. Shapes in NZTM2000 are converted, and
  other projections are refused with a plain message.
- **Co-op shares** (Farm, Co-op shares; #327, decisions 630-633, tenant
  migration 0172, examples CSR1-CSR10, not yet reviewed). A register of
  the farm's shares in co-ops (Fonterra, Ballance, Ravensdown, Silver Fern
  Farms and the like), one line per co-op and share class.
  - **What's kept:** each movement (brought forward, bought, issued
    without payment, sold or surrendered, adjustment) with its date,
    quantity, value and source statement; and each dividend (with
    imputation credits), rebate and retention, kept apart from the shares
    and from each other.
  - **The register for a year:** each holding's opening quantity and
    value, the year's movements, the closing quantity and value, and the
    year's dividends, rebates and retentions. A holding can never go below
    no shares or no value.
  - **Statements:** the co-op's statements are files on the holding, and
    each entry names its statement, its file, or both.
  - **Year-end pack:** the register and the year's statements go in it.
  - **Not built:** ledger links or proposed postings, a Fonterra share
    standard calculator, and share valuation.
- **Soil tests** (Farm, Soil tests; #249 stage 2, decision 516, tenant
  migration 0136).
  - **What's kept:** each test is a sample on a paddock and date, with
    the lab, lab reference and depth. Results are kept as the lab
    reported them, units included and "<0.5" kept as written, with no
    conversions and no judgement of high or low.
  - **Importing:** a lab's CSV or Excel (.xlsx) file. The preview shows
    how each column was matched (paddock or sample name, date, lab
    reference, depth, or a result with its unit), and any of it can be
    changed before importing. The same file can't be imported twice.
  - **Entering by hand:** a test can be typed in instead.
  - **Lab reports:** the report is attached to the test as a file.
  - **Summary:** each current paddock's latest results and how long ago
    they were taken, with paddocks never tested flagged.
  - **Analytics:** results are copied as `tohyee_farm_soil_results`.
- **Fertiliser plans** (Farm, Fertiliser plans; #249 stage 2, FB1-FB8
  approved by Jess, tenant migration 0134). Turning Farming on adds **6310
  Fertiliser and lime** and **6320 Fertiliser spreading**, unless those
  codes are already used.
  - **Products** record N, P, K and S as percentages by weight.
  - **Plans** are budgets and post nothing. A plan lists paddock, product,
    kg/ha, treated hectares (starting as the effective area) and quoted
    price a tonne, plus a spreading quote a hectare. Each change is saved as
    a new **version**, and earlier versions are kept.
  - **Bought:** fertiliser is expensed when its bill is approved. Approved
    6310 bill lines are linked to the plan, which posts nothing.
  - **Applied:** applications are entered or **imported** from a CSV
    (Paddock, Product, Date, Tonnes, optionally Treated ha). The import shows
    a preview first, and the same file can't be imported twice. Each
    application is costed at the linked bills' average price. Anything beyond
    what they bought uses the quoted price, marked "quoted", with a warning.
    An application can't be removed while a spreading bill is linked to it.
  - **Spreading:** a 6320 bill line is linked to the applications it
    covered and shared by hectares, for paddock costs only.
  - **Planned against actual** compares, for each product, tonnes planned,
    bought and applied, with cost expensed, applied and not yet applied. For
    each paddock it shows kg N/ha and cost (and cost a hectare).
  - No rates are recommended, and nutrient loss isn't worked out. Tax
    spreading (s EJ 3) is left to the tax return.
- **Rosters** (Payroll, Rosters; RS1-RS4 approved by Jess, decision 511,
  tenant migration 0130), like Deputy: **areas** (such as the shop) each with
  a weekly budget, and each week's **shifts** with an unpaid break, costed as
  hours at the employee's hourly rate plus employer KiwiSaver (salaried
  shifts show hours, not cost). **Unavailability** (a weekday every week, or
  dates) is added by the employee under My shifts or by payroll; rostering
  someone then needs a reason. Shifts in booked leave are flagged "on leave"
  and not counted. **Publishing** keeps a copy that employees with a linked
  login see under **My shifts**; later changes are listed until published
  again. **Emailing staff** (decision 518): publishing can email each
  employee their own shifts for the week, and a later publish emails only
  those whose shifts changed, including anyone taken off. Emails are plain
  text, have no pay figures, and go out through the organisation's own
  email. Anyone not emailed (no address, or email not set up) is listed.
  The weekly budget is typed on the area, not taken from the monthly
  workforce budget (Jess, 14 Oct 2026). Needs payroll access. Posts
  nothing. **Copy last week** (RS9, as Deputy and Xero do, not yet
  reviewed) copies the week before's shifts a week on at the same local
  times, leaving out and listing anyone unavailable, finished or already
  rostered then.
- **Clocking in** (Payroll, Clock-ins; RS5-RS8 approved by Jess, decision
  512, tenant migration 0131): a **shared device** at the shop is set up by
  someone with payroll access and keeps a key in a cookie; `/clock` on it
  lets staff (login or not) tap their name, type a **PIN** (4-8 digits,
  hashed; five wrong tries lock that person for 15 minutes) and clock in or
  out or start and end a break. Exact minutes, no location. Clocking out puts
  the time on the person's **timesheet** as other work, marked "from
  clock-in"; a submitted or approved week is left alone and the time waits
  under **Needs attention**. A shift not clocked out by midnight needs a
  manager to enter the out time, with a reason, before it reaches the
  timesheet or the person can clock in again. The roster week shows rostered
  against clocked hours and the difference at their rate.
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
  paid period, lower rates, a change of basis, overtime at a typed rate,
  and a salary period that wasn't paid the full salary (XP11b).

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
  the running 8%, untaken alternative holidays, any expected sick leave
  assessed; never bereavement or family violence leave) by Department, Dr leave expense / Cr employee
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
  carried over (decision 564, HL62, tenant migration 0160): someone with
  payroll access can record the days an employee is expected to take
  beyond their new entitlements, from a date and with a reason (never more
  than their balance; 0 takes it out); they're valued at a usual day's pay
  and posted with the rest. Without one, it's not in (NZ IAS 19 and PBE
  IPSAS 39 paras 16-17). Tohyee doesn't estimate the days.
- **AI: connect your own AI** (decisions 339-348, core migration 0005). The
  AI page (`/operations/ai`) lets each member make personal access keys for
  the organisation (shown once, stored hashed, at most 10, revocable), each
  with a level: **Look only** (the default), **Make drafts** (also add and
  edit contacts, make and edit draft invoices, bills and journals, add files
  to the bills inbox and make draft bills from them) or
  **Make and post** (also approve invoices and bills, post draft journals
  and record payments) or **Full access** (decision 488, #205; Owners only,
  after ticking a warning: also reconcile bank statement lines, up to 100 a
  call, and make and edit bank rules; examples AIB1-AIB8). The level is
  capped by the person's role (a viewer's key only looks; a Full access key
  whose owner is no longer an Owner works as Make and post). Any key can
  read bank accounts, statement lines with Tohyee's suggestions, bank rules
  and a reconciliation summary. It shows how to connect Claude Desktop (through
  `mcp-remote`), Claude.ai or ChatGPT custom connectors, or any MCP client
  to `/api/mcp`. The AI can look up the organisation's settings, chart of
  accounts, profit and loss, balance sheet, trial balance, aged receivables
  and payables, invoices, bills, contacts, account transactions, draft
  journals, the GST return for a period and the bills inbox (reading each
  file, BI4), in a read-only database
  transaction; writing tools use the same services as the screens, as the
  key's owner, and the history shows "<person> via AI key <name>". It
  **never deletes**: nothing at any level deletes, voids, archives, rolls
  back or refunds anything, except that a Full access key can undo its own
  bank reconciliation within 24 hours, reversing what it posted for the line
  on the line's date (AIB7). Full access also makes, edits and approves
  credit notes, quotes, sales and purchase orders and repeating invoices and
  bills, applies credit and records refunds, approves and pays expense
  claims, adds and edits items, accounts, tracking, budgets and fixed assets,
  and runs depreciation (decision 489, AIF1-AIF6); anything an approval rule
  covers still waits for a person. Payroll isn't included. A key stops working
  when it's revoked, its owner leaves the organisation or their login is
  turned off. Not yet tried against each AI app.
- **AI apps connect by signing in** (#427, decisions 810-829, core
  migration 0018). Claude.ai, ChatGPT and other cloud AI connect by pasting
  one address (the MCP address on the remote access address) and signing in
  to Tohyee (password with two-step, or Google), as the MCP authorisation
  specification expects (OAuth 2.1), instead of pasting a key. A consent
  screen shows the app's name (with a warning that any app can claim any
  name), the address it sends you back to, and lets the person choose the
  organisation and level (the role ceiling applies; Full access for Owners
  only, after ticking the warning). A connection is listed on the AI page
  (name, where it sends you back to, level, connected, last used) and can be
  disconnected; its actions show in history as the person "via AI app
  <name>". It ends when disconnected, when the person is removed or their
  login is turned off, when their password or two-step is reset, or after 60
  days unused. Owner-private mail stays off for a connection unless the
  Owner turns it on in My mail (Look only only). Only through https remote
  access; with it off the page says so and keys still work. Keys stay for
  Claude Desktop and other apps that need them. The AI page now leads with
  "Connect your AI", then Connected apps and Keys; the Claude Desktop
  setup, headers and protocol, and the "what it can do" list fold away.
  Built from the specification and the AI services' published docs; **not
  yet tried with real Claude.ai or ChatGPT**.
- **PowerPoint add-in for Analytics** (#429, decisions 830-849, core
  migration 0019; docs/POWERPOINT-ADDIN.md). A content add-in, like Power
  BI's: a live, interactive Analytics report page (or one tile) on a slide,
  with its dates and slicers, click-to-filter, drill-down, tooltips and page
  tabs, while editing and in the slide show. Everyone viewing the slide
  signs in to Tohyee themselves (password and two-step, or Google, in
  Office's sign-in window; the OAuth from #427, with its own read-only
  audience) and sees only what they can see in Analytics (a report viewer
  only reports shared with them). Someone who can't sign in sees the
  picture saved the last time someone signed in looked at it, with "Sign
  in to see live data". What the slide shows (organisation, report, page or
  tile, filters pane on or off, keep a picture) is saved in the
  presentation; tokens never are. Slide toolbar: Refresh, Show/Hide
  filters, Open in Tohyee, Change, Sign out. It only reads: no editing,
  sharing, pinning or exports, never a typed question. Settings › PowerPoint
  add-in (admins) downloads the manifest and explains installing it for
  yourself (Upload My Add-in) or for everyone (Microsoft 365 Integrated
  apps); only with https remote access. Sign-ins are listed under Your
  account › Connected apps and can be signed out. **Not yet tried in real
  PowerPoint** (Windows, Mac or web): built from Microsoft's docs and tested
  in Chromium with Office.js stubbed.
- **Draft manual journals** (examples MJD1-MJD9, decisions 349-352, tenant
  migration 0081), like Xero's: "Save as draft" beside "Post journal", and a
  Draft journals list on the journal page to edit, post or delete them. A
  draft is checked like a journal when saved but posts nothing; posting it
  posts one manual journal through the usual checks and links it, and a
  posted draft can't change.
- **Analytics, step 1: data sources** (decisions 353-358 and 376, tenant
  migrations 0082/0090; plan in [ANALYTICS-REVIEW.md](ANALYTICS-REVIEW.md)). A module
  switched on per organisation, with its own app at `/analytics`. A server
  admin chooses each organisation's folder on the server (server settings ›
  Analytics folders, or `analytics folder` on the command line). Admins set
  up a CSV or Excel (`.xlsx`) file from it: for Excel, Tohyee shows the sheet
  names and previews the selected sheet (first by default); it shows the
  headings, its guess at each type and the first values, and they confirm each
  column (money loads as exact decimals). An Excel source loads one sheet,
  stored on the source; dates and formula results load as Excel shows them
  and numbers as written (0.1 + 0.2 loads as 0.30). Excel files are streamed
  and capped at 50 MB with ZIP-bomb checks; old `.xls`, `.xlsm`, workbooks
  with macros and password-protected files are refused with a reason. Each organisation's loaded data is one DuckDB file in
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
  checked series colours `--chart-1` to `--chart-8`; every chart in Tohyee
  shares one theme, `src/lib/charts/theme.ts`, decisions 599-601). A dashboard has a date
  range and slicers (tick boxes) that apply to every tile. Totals stay
  exact (DuckDB decimals, shown from their text); column and value names
  are checked against the table and typed values go in as parameters.
  Negative money shows as -$27.00, and a value's label follows its column
  and calculation until someone types their own (decision 576). Sources
  and columns have plain names grouped by source (the real name in a
  tooltip), Yes/No columns show Yes and No, and Dates offers presets from
  This month to This financial year (from the balance date) and All time,
  which a dashboard can keep so it moves with the calendar (decision 577).
  Tile filters also have is one of / is not one of (ticked from the
  column's values), is blank / is not blank, between, in the last N days
  or months, this or last financial year, and "or" groups (decision 578).
  Bookkeepers and up make dashboards; everyone in the organisation can see
  them. Tried with the made-up 1M-row CSV: a five-tile dashboard opens in
  about 3 seconds. Analytics also copies Tohyee's books and CRM, shares
  dashboards with report viewers and supports shaping.
  Pivot tiles have one to five row fields, an optional column field and
  exact sum/count/average/minimum/maximum values, with date groups by month,
  quarter or year. DuckDB returns the cells and subtotals without sending raw
  source rows to the browser; results above 2,000 cells ask for more filtering
  or grouping. Subtotals and totals are worked out by DuckDB, so they equal
  their rows exactly. Cells drill into up to 500 matching rows showing only
  the tile's own fields. Shared report viewers can see, drill and export only
  saved pivots on dashboards shared with them. The read-only grid is an
  accessible HTML table; CSV and Excel exports use the standard report
  export (decision 375).

- **Analytics: database sources** (decisions 602-605, tenant migration
  0166). Under Analytics › Data sources › Add data source, admins and owners
  can connect a **Microsoft SQL Server**, **PostgreSQL** or **MySQL**
  database: server, port (or SQL Server instance), database, user, password
  and encryption (none, encrypted without checking the certificate, i.e.
  SQL Server's "trust server certificate", or encrypted and checked). The
  connection is tested before it's saved; the password is encrypted with
  the server's key and never shown again, and changing the server, database
  or user needs it typed again. Then pick a table or view, or write one
  SELECT query, preview its columns and first 20 rows, confirm each
  column's type (exact decimals load as Money or Number, dates, date-times
  in local time, yes/no; binary data isn't loaded), and load it into the
  organisation's own analytics copy. Database sources reload nightly after
  04:00 and on demand, with the same load history as files, and don't need
  an analytics folder. Tohyee only reads: typed queries must be a single
  SELECT and are checked; PostgreSQL and MySQL queries run in read-only
  transactions; every query has a time limit (30 seconds for a preview, 10
  minutes for a load, `TOHYEE_ANALYTICS_DATABASE_SECONDS`), and a source
  has a row limit (1,000,000 by default, up to 5,000,000) past which the
  load fails rather than loading part of the data. The screens recommend a
  read-only database user. Tohyee's own databases can't be connected to.
  PostgreSQL is tested against a real server; **MySQL and SQL Server are
  only tested with stand-in drivers and haven't been tried against a real
  server yet.**
- **Analytics: calculated values, saved values and templates** (#337,
  decision 597, examples BM1-BM4, tenant migration 0165). A chart can add a
  calculated value, a formula over its other values such as
  `[Sales] - [Costs]` or `[Sales] / [Units]`, worked out in exact decimals.
  Any value can be saved on its data source for other charts, and the books
  copy has built-in values: Sales, Cost of sales, Gross profit, Gross
  margin %, Other income, Operating expenses, Net profit, Accounts
  receivable, Accounts payable, Cash in bank and Days to get paid. A new
  report can start from a template: Business overview, Sales & customers,
  Profit & loss, CRM pipeline or Farm.
- **Analytics: Google Analytics for websites** (decisions 606-609,
  examples GA1-GA8, tenant migration 0167). In Data sources › Add data
  source › Google Analytics, an admin signs in with Google (the
  organisation's Google app from Settings › Email, read-only Analytics
  access), chooses a GA4 property, and Tohyee loads five daily tables:
  website by day (visitors, new visitors, sessions, engaged sessions, page
  views, engagement rate, key events, revenue), traffic sources (channel,
  source, medium), pages, countries and devices. 13 months of history by
  default (1 to 60), nightly and by Refresh now, in the load history.
  Google's quota limits, a disabled API and an expired sign-in each get a
  plain message, and a failed load keeps the last copy. Disconnect deletes
  the sign-in and the loaded tables. A **Website** report template puts
  visitors, sessions, top pages, channels and devices beside invoiced
  sales. Setting up: in the Google app's Cloud project, enable the Google
  Analytics Data API and Admin API, add the `analytics.readonly` scope to
  the consent screen and `/api/analytics/google/callback` to the redirect
  URIs; while the app is in Testing, Google ends sign-ins after 7 days.
  Tested with canned Google responses only, not a real GA4 property.
- **Analytics: safe report editing** (#387, decisions 690-691, tenant
  migration 0178). While a report is being edited, every change (adding,
  changing, moving, duplicating or removing tiles, pasting a format, the
  theme, dates, slicers, name and description) goes into a draft that only
  **Save** or **Save and view** saves; viewers keep seeing the report as
  last saved. The toolbar says whether everything is saved. **Undo** and
  **Redo** (also Ctrl+Z and Ctrl+Shift+Z or Ctrl+Y) step back and forward
  through this session's changes, each named ("Undo remove Sales"), and
  **Discard changes** goes back to the saved report (and can itself be
  undone). Closing the tab or following a link with unsaved changes asks
  first. Every saved report has a version: a save from an older version
  (someone else saved in the meantime) is refused, saying who saved and
  when, and offers **Save mine as a copy** or **Reload the saved report**;
  a refused or failed save keeps the draft.
- **Analytics: values that say what they mean** (#387, decisions
  693-696, examples MD1-MD6). Each value in the chart editor has "What it
  means": what a row is, how it's added up, its unit, movement or balance,
  its date, blanks and zero, and totals. A table's totals row works
  calculated values and averages out from the totals (10/100 and 90/300
  total 25%). Amounts in different currencies are never added together
  (blank, with a note, where they'd mix). A value can be a balance recorded
  on each date, using the latest in each period rather than adding dates
  up. A shaped table's Merge is refused when it would repeat rows or
  numbers, and the preview says how many rows had no match.
- **Analytics: quick calculations** (#376 phase 4, decision 770, examples
  QC1-QC8). Each value on a grouped chart or table has **Show as**: running
  total, % of total, % of row or of column (with a second grouping or in a
  pivot), rank, difference or % change from the previous period, or a
  moving average. They're worked out over every group the filters leave
  (before Top N), shares of the value worked out again for the whole, with
  missing periods blank rather than 0; "What it means" says what each is of.
- **Analytics: year to date and last year** (#376 phase 4, decision 771,
  examples TI1-TI5). Each value with a date has **Over**: financial year
  to date, financial quarter to date, month to date or the last 12 months,
  by the organisation's balance date. A key figure or a table by account
  shows it to the To date, with "and last year" the same dates a year
  before (29 February becomes 28 February); a chart by month shows each
  month's year to date, starting again each financial year.
- **Analytics: calculated fields on a data source** (#376 phase 4,
  decision 772, tenant migration 0184, examples CF1-CF6). Under a chart's
  data source, **Calculated fields on this data source** adds a formula
  worked out on each row (IF, CASE, comparisons, text and date functions,
  financial year and quarter, arithmetic), saved on the table for every
  report. Its kind is checked before it's saved; changing one changes every
  report using it, and removing or renaming one in use is refused.
- **Analytics: what-if parameters and switches** (#376 phase 4, decision
  773). A report can have sliders (Parameter settings in edit mode) whose
  number formulas use as @name, e.g. `[Sales] * (1 + @growth)`. A tile can
  let the reader show one of its values at a time, or group it by other
  fields its author chose (Interactions tab). Only the report's own steps
  and choices are accepted from readers.
- **Analytics: related tables** (#376 phase 4, decision 774, tenant
  migration 0185, examples RL1-RL5). Under a chart's data source, **Related
  tables** relates each row of the chart's table to one row of another
  (invoice lines to their contact or item), so its fields can be used as
  `customer.region` and the like. It's checked on the data each time:
  a table with two rows for one match is refused (amounts would count
  twice), a related table's numbers aren't added up, and rows with no match
  are counted in a note. Blending isn't built.
- **Analytics: field settings** (#376 phase 4, decision 775, examples
  FS1-FS3). Under a chart's data source, **Field settings** sorts a field
  by another column (month names by month number), says how it's added up
  when chosen, gives it a default number format, and puts it in a folder
  with a description in the field list.
- **Analytics: one access check for every output** (#387, decision 697).
  The access contract in [ANALYTICS-STUDIO.md](ANALYTICS-STUDIO.md) lists how
  figures, tooltips, totals, drill-through rows, slicer values, CSV and
  Excel, pinned tiles and addresses all use the same server-side check. A
  report viewer's slicer now lists only values in the rows the report's
  tiles read, not the whole column.
- **Analytics: how fresh a report is** (#387, decision 698). Under a
  report's dates, each source says when it was last refreshed and the
  latest date in its data; a failed refresh shows as a warning that the
  report still has the last good data, and sources refreshed at different
  times are pointed out.
- **Analytics: dashboard layout** (#335, decision 596). Tiles can be a
  quarter, a third, a half, two-thirds or the full width of a row, and
  charts Small, Medium or Large. In edit mode, tiles can be dragged into
  place (the arrows still work from the keyboard), duplicated, or clicked
  to open, and **+ Add text or item** adds a heading with notes to split a
  dashboard into sections (or an image, shape or button). Up to 40 tiles.
- **Analytics: more Prepare data steps** (#376 phase 4, decisions
  790-798). Analytics › Prepare data has ten more steps, named as in Power
  Query: Pivot column, Unpivot other columns, Fill down or up, Replace
  values, Remove duplicates (choosing the columns that make a duplicate),
  Conditional column (if, else if, otherwise), Date parts (year, quarter,
  month, month name, ISO week, day, day of the week, day name, and the
  financial year and its quarter from the organisation's balance date),
  Sort rows, Index column and Custom column (a formula over number
  columns, worked out exactly). The new steps have forms (the older ones
  still edit as settings), each step shows the rows after it and the
  change from the step before, and steps can still be moved, edited and
  removed. Existing shaped tables build as before.
- **Analytics: zoom on time charts** (#376 phase 3, decision 760). Column,
  line and area charts can have a zoom slider along the bottom axis
  (Interactions tab), with the mouse wheel or a pinch too.
- **Analytics: bookmarks and page buttons** (#376 phase 3, decision 759).
  A report can keep bookmarks (a page, dates, slicer choices and hidden
  tiles), opened from the Bookmarks row or a button. Buttons can go to a
  page, open a bookmark, go back, or reset to the report's default.
- **Analytics: slicer styles, page filters and a tile's own dates** (#376
  phase 3, decisions 757-758). Slicers can be tick boxes, search and tick,
  a drop-down, buttons, a number range, a date range, relative dates or two
  levels (e.g. region then town), in three sizes, on every page or chosen
  pages; number and date columns can be slicers. A page can have its own
  filters (Page settings › Filters on this page), and a chart can keep its
  own dates (Dates for this chart), noted under its title.
- **Analytics: clicks, drill-down and drill-through** (#376 phase 3,
  decisions 754-756). Clicking a group on a chart or table (or choosing it
  from the chart's **Choose a group** list) filters the page's other tiles,
  or highlights the group on tiles grouped the same way; each tile's
  Interactions tab sets Filter, Highlight or No change for each other tile.
  Charts can drill down by financial year, quarter, month and day (or
  calendar years, or other fields), with **Drill down on click**, **↑ Up**
  and **Next level for all**. A page marked as a drill-through page opens
  filtered to a chosen group, with **← Back**. A bar above the tiles shows
  what the page is filtered by, with Clear and **Reset to default**. None of
  this can show a report viewer anything the report's tiles don't.
- **Analytics: report pages** (#376 phase 3, decision 753). A report can
  have up to 12 pages, shown as tabs under its dates. In edit mode, **+ Add
  page** and **Page settings** (name, width, background, hide from the
  tabs, move earlier or later, remove). Links can open a page (`?page=`).
  Reports without pages look as they always have.
- **Analytics: a simpler chart panel** (#387, decisions 750-752). The
  selected chart's panel has **Data**, **Style** and **Interactions** tabs,
  showing only the settings that apply to its chart type. Each Style
  section and each value's number format says whether it's **changed on
  this chart**, comes from **this report's default** for the chart type, or
  from **the theme**, with a **Reset** for just that setting (or for the
  default). Specialist chart types are under **More chart types…**, and
  reference lines, trend lines and projections, colour rules, gridline
  styles and log scales under **Show advanced settings** (shown anyway
  when a chart uses them). In edit mode, tiles can be chosen (**Select**)
  and given the **same width** or **same height**, made to **share a row**
  (two halves, three thirds or four quarters) or have their **heights lined
  up** across a row, all from the keyboard.
- **Analytics: New Zealand maps** (#376 phase 2, decision 687). A
  **filled map** colours New Zealand's regions or districts and cities by a
  value, e.g. sales by region; names are matched however they're spelt
  (macrons, "Region", "District" and so on), and names that aren't on the
  map are listed under it. A **map with points** puts a dot at each
  latitude and longitude, sized by a third value if you like. The
  boundaries come with Tohyee (Stats NZ, CC BY 4.0), so no outside map
  service is used.
- **Analytics: text, images, shapes and buttons** (#376 phase 2, decisions
  683-686). **+ Add text or item** adds one of four things to a report.
  **Text** can use **bold**, *italic*, links, lists and values from the
  data, e.g. "Sales this month: {Sales}", worked out over the report's
  dates and slicers; whatever is typed always shows as text, and only web
  and email links become links. An **image** (JPG or PNG, up to 5 MB) is
  stored with the report and only people who can see the report can see
  it. A **shape or line** (rectangle, rounded, circle, line or arrow) uses
  the report's theme colours unless others are chosen. A **button** resets
  the report's filters; going to another page and opening a bookmark will
  come with report pages and bookmarks.
- **Analytics: pivot table (matrix) improvements** (#376 phase 2, decision
  682). A pivot can have up to three column fields nested inside each
  other (e.g. year, then channel), with a total for each outer column; rows
  can be laid out stepped (one indented column, each group's total as its
  heading, as Power BI's matrix) or a column per field as before; each
  group opens and closes (+ / −, with Open all and Close all), and the
  report can choose how many levels are open to start with. Clicking a
  cell under nested columns opens that cell's rows, and exports name each
  column by its whole path.
- **Analytics: small multiples** (#376 phase 2, decision 681). A column,
  bar or line chart can show "One small chart for each" value of a second
  field, e.g. a chart per region: every small chart has the same groups
  along the axis and the same value scale, one legend above them all, and
  up to 6 charts (2 to 12 can be chosen). Past that the smaller ones are
  added together exactly as "Other" when the values are totals or counts;
  averages and other values that can't be added are left out, and the
  card says so. Pinned tiles show up to four.
- **Analytics: treemap, heat map, calendar heat map and Sankey** (#376
  phase 2, decision 680). A **treemap** shows each group as a box sized by
  its total, optionally split into a second grouping ("Inside each box"),
  groups in the theme's colours in order. A **heat map** puts the groups
  across and a second grouping down, each cell coloured on one blue scale
  (or orange-grey-blue when amounts are both sides of zero), with the
  scale under it. A **calendar heat map** colours each day of up to the
  three latest years with data. A **Sankey** diagram shows each group
  flowing to the values of a second grouping ("Flows to"), widths by
  total. Totals are added exactly; treemaps and Sankeys leave out amounts
  of zero or less, which have no size.
- **Analytics: scatter and bubble, histogram and box plot** (#376 phase 2,
  decisions 678-679). A **scatter** chart puts each group at its first
  value across and its second up; a third value makes it a **bubble**
  chart (bubble area in proportion), with an optional straight trend line
  and names by the dots. A **histogram** counts how many groups' value
  falls in each range: bins chosen automatically (round widths), by number
  or by width, worked out exactly so a value on an edge is always in the
  bin it starts. A **box plot** shows the spread of a value: quartiles as
  a spreadsheet's QUARTILE.INC, whiskers to 1.5 box heights and dots
  beyond. With "Each box is made of" (a second grouping, e.g. boxes by
  region made of their customers' totals) there's a box per group;
  without it, one box of every group's value.
- **Analytics: waterfall, funnel, gauge and bullet chart** (#376 phase 2,
  decisions 676-677). New chart types in the chart editor. A **waterfall**
  (a P&L bridge) moves a running total up and down group by group, added
  exactly in decimals, and ends with a total bar (named as you like, or
  left off), with rises, falls and the total in their own colours and thin
  lines joining the bars. A **funnel** draws its stages in the tile's
  order with each stage's share of the first stage or the one before. A
  **gauge** shows one total on a dial from 0 (or a chosen minimum) to a
  chosen maximum, or twice the value, with a target from a second value or
  a typed number. A **bullet chart** shows each group's value as a thin
  bar over grey bands at percentages of its target (60% and 80% unless
  changed), with the target as an upright line. All four use the report's
  theme and the Format panel: number formats, data labels, colours (any
  hex, per group, colour rules), axes and gridlines where they have them,
  tooltips, the card and title. Copying a format or a chart type default
  leaves out a gauge's range and the targets.
- **Analytics: key figure formatting** (#376 phase 1, decision 674). Under
  Key figure › Number style: the number's size (small to extra large, or
  exact pixels), colour, alignment, weight and the value's name above or
  below; colour by rules on the value (e.g. green at 1,000 or more) or by
  the comparison (green for good news, red if not); an arrow or dot by the
  number; the trend as a line, area or columns in any colour; and every
  value as its own number in one card.
- **Analytics: richer key figures** (#334, decisions 594-595). A key
  figure can compare with the previous period (the same length before the
  dashboard's dates), the same period last year or a target, showing the
  change as an amount and a percentage with an arrow, Up or Down, and green
  or red ("Down is good" for costs). An optional trend by month sits under
  the number, and the number has its own format with words before or
  after it. Pinned key figures show the same.
- **Analytics: conditional formatting and table styles** (#376 phase 1,
  decision 675). Tables and pivots can colour each value's cells (background
  or text) by a two- or three-colour scale, rules (e.g. red below zero) or a
  field holding colours, and show data bars and icons (arrows or shapes).
  Charts can colour columns and dots by rules, e.g. red below a target.
  Table and pivot style: header colours, banded rows, gridlines, text size,
  column width, word wrap, a totals row (added exactly) or the grand total,
  totals bold or shaded, and subtotals per level.
- **Analytics: report themes, chart type defaults and the format painter**
  (#376 phase 1, decisions 668-671, tenant migration 0176). In a report's
  edit mode, **Theme** chooses the report's look: Tohyee (the default, and
  what every chart outside Analytics keeps), Harbour, Kōwhai, Bush, Bright
  or Strong contrast (each checked for colour-blind readers in light and
  dark), or one of the organisation's own. The theme editor sets up to 12
  chart colours (any hex) for light and dark (or works dark out from
  light), page and card backgrounds, text colours, a font from a safe
  list, text sizes, and the cards' corners, border, shadow and padding,
  with a live preview and colour checks that warn but don't block. Themes
  are saved for the whole organisation, export to a JSON file and import
  from one. "Set as default for columns in this report" (any chart type)
  makes every chart of that type in the report start from that look, and
  **Copy format** / **Paste format** copies a chart's look to others.
- **Analytics: formatting each chart** (#376 phase 1, decisions 672-673).
  The Format section now also has: title and subtitle styling (size,
  weight, italic, colour, alignment, a colour behind the title); the card's
  colour and transparency, border colour and width, corners, shadow and
  padding; any colour for a value or a group, with Reset to the theme;
  data label size, colour, own number format and which labels show (a pie
  can show its name, value and percentage in any mix); axes shown or
  hidden, text size, colour, angle, reversed, the value axis's own number
  format and step, label interval and a date range for the group axis; the
  legend in any side or corner, with a size and title; dashed or dotted
  gridlines in a chosen colour and a plot area colour; tooltips off, with a
  total, and values left out of the tooltip or shown only there; reference
  lines (a value, target, average, median, lowest, highest, percentile or a
  shaded band); a trend line and a linear projection per value (#387,
  decision 692: only on a regular run of dates, oldest first, with missing
  periods shown as gaps; not the cash flow forecast); column
  thickness, gaps and square ends; each line's width, style, step and dots.
  Chosen colours get a dark version in dark mode, and the editor warns
  when one fails the colour checks.
- **Analytics: chart formatting and a second axis** (#331, #333,
  decisions 590-593). The chart panel has a Format section with a live
  preview and Reset to default: colour sets (Tohyee, Tohyee blues, Orange
  first, Green first; all checked for colour-blind readers in light and
  dark), a colour per value, a colour for each group, red when below zero,
  data labels, the legend (automatic, shown or hidden; top, bottom or
  right), axis titles, gridlines, lowest and highest, start at zero and log
  scale, a number format per value (dollars, percentage or plain; decimal
  places; short or full; thousands separator), stacked and 100% stacked,
  smooth lines and dots, a donut's total in the middle, and the card's
  title, subtitle, background and border. Columns and line, Line and Area
  can put each value on a left or right axis (the right with its own scale
  and format), and Columns and line can show each value as columns or a
  line.
- **Analytics, step 2: the books and CRM** (examples AB1-AB10, decision
  367). Each organisation's ledger lines, invoices, bills, contacts, items and
  (with the CRM on) companies, opportunities and activities are copied into
  its analytics every night and by Refresh now, as the same data with the
  ledger's signs; dashboard values can be shown the other way round. Pay run
  lines are copied without names. With the CRM on, also leads, campaigns
  and their members, sequences and enrolments, sales emails (without
  addresses, subjects or words), deal products and tasks, each with a plain
  name (decision 652, AB11).
- **Analytics: sharing with clients** (decision 368, tenant migration 0085,
  core migration 0006). A new "Report viewer" access for clients: they sign
  in like anyone else and see only the Analytics dashboards shared with them
  (Share, in a dashboard's edit mode, for bookkeepers and up), using that
  dashboard's slicers and dates. They can't see the books, the data tables or
  anything else in the organisation.
- **Pinned Analytics tiles** (decision 374, issue #119). "Pin to page" on a
  dashboard tile puts it on Home, next to or in place of the default tiles
  (still four at most); Customise lists both. A pinned tile shows the saved
  question with the dashboard's own dates (a key figure, a small chart or a
  table's first rows), has a dashed edge and "From <dashboard name>", and
  opens the dashboard. Access is checked every time the page loads: report
  viewers can only pin dashboards shared with them, and a pin from a deleted
  or unshared dashboard or tile drops off, as all pins do while Analytics is
  off.
- **Keyboard entry** (#258, decision 519). Date fields in invoices, bills,
  journals, quotes, orders, credit notes, payments, expense claims and bank
  pages take dates typed day first or in shorthand:
  - 14/10/2026, 14/10, 1410, 141026
  - "t" for today
  - +14 or -3 days, +2w
  - +20m for the 20th of the following month
  A due date counts from its document's date. The calendar button still
  opens the browser's date picker. **Ctrl/Cmd+Enter** clicks the form's
  main button (Save, or Post on a journal). **Enter** in a line table moves
  to the next field instead of saving the form.
- **Search everything** (decision 373). Ctrl K finds records as well as
  pages: contacts, invoices, bills, credit notes, quotes and orders, payments,
  bank lines, journals, items, accounts, fixed assets and CRM records. Search
  by name, number, reference, amount or date, narrow it with chips or "inv",
  "bill" and "c:" prefixes, and see your recently opened records when the box
  is empty.
- **Save transaction reports as custom** (examples CR11-CR15, decision 369,
  tenant migration 0086). Account transactions, aged receivables and
  payables, sales by salesperson and the journal report can be saved with
  their own title, filters and columns: contact details and fields, document
  fields, and on account transactions and the journal report, line fields
  and tracking. Columns can be reordered; figures never change.
- **Analytics, step 6: shaping** (tenant migration 0087). Under Analytics ›
  Shaping, admins can save ordered, repeatable steps against a loaded
  CSV or `tohyee_*` table: filter, keep/remove or rename columns, change
  types, split or unpivot, group and aggregate, calculate a number or joined
  text column, merge with another loaded table, or append by column name.
  The selected step previews up to 100 rows. Output tables are rebuilt after
  a dependent source/books load or on demand; a failed rebuild leaves the
  previous output in place, with its result recorded in load history.
- **Analytics, step 5: report emails** (decisions 362 and 376, tenant migration
  0088). Admins and owners configure their own CRM-connected Gmail or
  Microsoft mailbox, or IMAP with an encrypted app password, in Analytics
  › Data sources. Choose a folder or label and set a mailbox rule to file
  reports there. Checks save CSV, TSV, TXT and Excel (`.xlsx`) attachments,
  or flat CSV/TSV files extracted from ZIPs, in the source folder, replacing
  matching names with the newest receipt (or, as an archive, keeping every
  file dated).
  Mailboxes are checked each night before the reload, or with Check now. PDFs (including Looker Studio
  reports), `.xls`, and `.xlsm` files aren't accepted, and `.xlsx` files
  with macros or a password are refused. Limits are 25 MB
  per attachment and 100 MB per check, including ZIP and Excel workbook
  expansion. Message IDs prevent repeat saves, and the job records files saved and errors. Checks
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
- **Income tax, stage 1** (#292; examples ITX1-ITX10, decision 545, tenant
  migration 0150), from IRD's published rules and **not yet reviewed by an
  accountant** (the screen says so): for a company or a sole trader with a
  31 March balance date, from the 2025 income year. Tax › Income tax
  (owners and admins), a workspace of pages since #375 (decision 702):
  Overview (next payment, what needs doing, due dates), Forecast, Tax
  calculation, Payments, Returns and Tax settings, keeping the income year
  between them, with "Forecast incomplete" instead of $0.00 when the year has
  no inputs at all. Taxable income comes from the books, with each income or
  expense account counting in full, not deductible, entertainment 50%,
  business use % or not taxable, plus typed adjustments, losses brought
  forward, other income and tax credits; actuals to the last whole month
  then the overall budget, so the current year is a forecast; tax at the
  company rate or individual rates; standard provisional tax (5% and 10%
  uplifts, a return filed late, six-monthly GST filers' two instalments);
  expected end-of-year tax; and due dates moved to the next business day.
  IRD's figures and payments to IRD are typed in and labelled. Nothing
  posts, files, pays or chooses a provisional tax option.
- **Provisional tax payments and where they go** (#292; examples
  ITX6A-ITX6H, decisions 620-623, tenant migration 0170; Codex, delegated by
  owner (via Will), 20 Oct 2026; not yet reviewed by an accountant). On the
  Income tax › Payments page, each payment to IRD has its bank date and IRD's effective
  date, and is allocated to an instalment or the end-of-year tax as
  confirmed by IRD (naming an IRD document), allocated with evidence, or a
  forecast assumption. Unallocated payments are awaiting reconciliation and
  count against no instalment. The provisional tax table shows each
  instalment's amount, what's paid towards it (and how much late), and the
  cash still needed by its date, with credits carried forward and never a
  negative demand. An excess towards instalment 1 reduces instalment 2 (no
  cap). Reallocating needs a reason and keeps the old allocation. A payment
  from the books whose journal was reversed counts for nothing. Nothing is
  paid or filed.
- **Tax depreciation and Investment Boost** (#292 stage 2; examples
  ITX11-ITX18, decision 546, tenant migration 0151; from IRD's pages, not
  yet reviewed): on the Income tax page, each fixed asset gets tax details
  (diminishing value, straight line, low-value write-off up to 1,000.00 or
  not depreciable; the IRD rate typed from IRD's rate finder; tax cost;
  business use %; first available date; opening ATV for older assets) and
  Investment Boost (20% for new assets first available from 22 May 2025,
  then depreciation on the remaining 80%). Each year shows opening ATV,
  boost, depreciation, depreciation recovered or loss on sale (none in the
  year of sale) and closing ATV. In taxable income, those assets' book
  depreciation and book gains and losses come out and the tax figures go
  in; assets without tax details keep book depreciation and are listed.
- **IR10 financial statements summary** (#292 stage 3; examples ITX19-ITX24,
  decision 547, tenant migration 0152; from IRD's IR10 and IR10G, not yet
  reviewed): for a finished income year, the Income tax page fills all 60
  IR10 boxes from the books, the taxable income workpaper and the fixed
  asset register (purchases worked out from direct costs and stock, bank
  overdrafts as current loans, tax depreciation including Investment Boost,
  additions, disposals, drawings, dividends and current accounts), checks
  that box 27 matches the profit and loss and that 43 - 50 = 51, and
  downloads as CSV. Each account's box has a default by type (and for the
  starting chart) and can be changed. Nothing is filed.
- **Imputation credit account** (#292 stage 4; examples ITX25-ITX29,
  decision 548, tenant migration 0153; from IRD's IR274, not yet reviewed):
  for companies, the Income tax page keeps the ICA for each 1 April to 31
  March year: income tax paid (from the payments typed there), typed
  dividends paid (credits at most 28/72, a different ratio from the year's
  first dividend flagged), dividends received, RWT, refunds and other
  entries, with a running balance. A debit balance at 31 March shows
  further income tax and the 10% penalty due 20 June.
- **IRD documents read by the connected AI** (#292 stage 5; examples
  ITX30-ITX35, decision 549, tenant migration 0154): owners and admins
  upload IRD files (assessments, statements, letters from myIR) on the
  Income tax page. The organisation's own AI, when its key's owner is an
  owner or admin, can list and read them and the typed figures
  (`list_ird_documents`, `read_ird_document`, `get_income_tax_figures`) and
  propose figures (`propose_ird_figures`: assessed RIT and filing date,
  losses, credits, other income, payments). A person checks each proposal
  beside the current figures and the document, and accepts or declines it;
  payments already typed aren't added twice. Tohyee calls no AI and never
  touches myIR.
- **Importing IRD account files** (#292, #360 item 3; examples ITX-IMP1 to
  ITX-IMP12, decisions 710-716, tenant migration 0179; Codex, delegated by
  owner, 20 October 2026, as delegated, not yet reviewed): on the Income
  tax page, owners and admins bring in a CSV or Excel file of an IRD
  account's transactions, saying whether it was downloaded from myIR or is
  another spreadsheet. They pick the columns (no IRD layout is assumed),
  say what each value in the type and instalment columns means, and see
  every row with any problem before importing; mappings can be saved and
  are chosen again for a file with the same headings. The file is kept as
  an IRD document, optionally linked to a PDF. Each row waits for a person
  to accept or decline it. An accepted payment is added (or linked to the
  same payment already in Tohyee) and allocated only when the row says
  which instalment (confirmed by IRD for a myIR file, with evidence for
  another spreadsheet); otherwise it's awaiting reconciliation. An
  assessment becomes the assessed RIT only when the person says so, with
  the filing date. Interest, penalties, credits and refunds are recorded
  and totalled for the year. No IRD connection, filing or payments.
- **IRD payments from the books** (#292 stage 6; examples ITX36-ITX40,
  decision 550, tenant migration 0155): owners and admins choose the
  accounts income tax payments are coded to; payments to them from a bank
  or credit card (not voided or reversed) are listed with a suggested income
  year from the date and counted with one click, linked to their journal
  line so they can't count twice (a matching typed payment is linked
  instead). Money in on those accounts is listed as possible refunds.
- **Income tax for other balance dates** (#292 stage 7; examples
  ITX41-ITX43, decision 551): income years follow IRD's early/late balance
  date rule (SPS 24/01), and provisional tax dates follow the Income Tax Act
  2007 schedule 3 part A for every balance date month. End-of-year tax for
  April to September balance dates is due in February (April with a tax
  agent) of the calendar year after the balance date (decision 557).
- **Use-of-money interest estimate** (#292 stage 8; examples ITX44-ITX48,
  decision 552): the Income tax page estimates interest so far and if
  everything's paid on its due date, at IRD's dated rates, simple and daily,
  with the $60,000 rules for the standard option and nothing on $100 or
  less. Overpayment interest isn't worked out.
- **IR4 imputation return boxes** (ITX49): a company's imputation credit
  account fills boxes 41-45 of the IR4's annual imputation return.
- **IR4 income and tax boxes** (ITX50-ITX53, decision 553): once a
  company's income year ends, the Income tax page fills IR4 boxes 20B-30L
  (taxable income, tax, credits, provisional tax paid, refund or tax to pay)
  from the workpaper, using the form's own arithmetic. Boxes Tohyee has no
  figures for are 0.00 with a note. Next year's provisional tax (box 33)
  shows the standard option (ITX62); the disclosures and shareholder
  details aren't filled.
- **IR3 income boxes and tax worksheet** (ITX54-ITX57, decision 554): once
  a sole trader's income year ends, the Income tax page fills IR3 boxes
  24-32 and the IR3 guide's tax calculation worksheet (the refund or tax to
  pay) from the workpaper, and next year's provisional tax (box 39) on the
  standard option. IETC, PIE income, the ACC earners' levy, Working for
  Families and student loans aren't worked out.
- **Imputation credits and overseas tax** (ITX58-ITX61, decision 555): each
  income year takes imputation credits received and overseas tax paid apart
  from the refundable tax credits, in the IR4 and IR3's order. A company's
  excess imputation credits become a loss carried forward; an individual's
  carry forward as credits.
- **Imputation credits brought forward** (ITX65, decision 556): a sole
  trader types last year's excess imputation credits from IRD's letter
  (IR3 box 34); Tohyee says if its own figure for last year differs.
- **Whole dollars on the returns and IR10** (ITX66, decision 557): taxable
  income (IR4 30A, IR3 worksheet 1), next year's provisional tax and every
  IR10 box drop their cents, and the tax is worked out on whole dollars.

- **Pasture and feed** (#249 stage 4; PF1-PF8, decision 559): Farming ›
  Pasture and feed records cover readings (typed, or imported from CSV or
  Excel with a preview), shows each paddock's growth and the farm's cover
  and feed wedge on a date, and records grazings (what was eaten, with
  covers before and after) and supplements fed in kg DM. Satellite and
  model readings are labelled as estimates. Records only.

- **The AI reads farm data** (AIW10-AIW14, decision 560): a connected AI
  can read soil tests, fertiliser products and plans, pasture cover,
  readings, grazings and supplements fed, and work out a proposed
  fertiliser application's tonnes, nutrients and cost without saving it.

- **Farm apps and the Farming API** (FA1-FA8, decision 561): Farm › Farm
  apps makes keys for people's own apps, with scopes to read farms, soil
  and pasture and to record soil samples and pasture readings, through
  `/api/farm-apps/v1` (OpenAPI 3.1). A sample soil sampling app is in
  `examples/farm-apps/soil-sampling`, and soil samples taken in the field
  show on Soil tests. Guide: [FARM-APPS.md](FARM-APPS.md).

- **Farmer-friendly farm pages, step 1** (#447, decisions 900-903): farm
  pages open on the farm you last worked on (remembered for you on the
  server, on any device, and forgotten when that farm is taken off you or
  archived). Pasture readings, grazings and supplements load from the
  server a page at a time (25, then Show more) with From, To and paddock
  filters; the farm's cover, feed wedge and supplements by month are worked
  out on their own, so paging never changes them. A record sent for one
  farm with a paddock from another is refused, so switching farms can't put
  it on the wrong farm. On a phone, paddocks, the feed wedge, readings,
  grazings, supplements and latest soil tests are one line each that opens;
  Remove sits apart and asks first; buttons and fields are at least 44px.
  Plainer words: "Paddock area", "Farm costs" (with FWE as a hint),
  "Changes" for fertiliser plans; internal codes are gone from farm pages.
  The Farming API's readings and the AI's farm lists use the same pages.

- **Farm staff** (#447, decisions 904-906): a **Farm staff** role under
  People and roles records field work (cover readings, grazings and days
  out, supplements fed, soil samples) and reads paddocks, pasture, soil and
  the farm calendar, on the farms an owner or admin chooses for them, and
  nothing of the books: journals, contacts, reports, exports, search, money
  on farm pages, the notebook and the AI are all refused on the server. Their
  top bar has the Farm menu's field pages only. Farm app keys work for them,
  on their farms. Removing a record stays with bookkeepers and up.

- **The farmer's workspace** (#447, decisions 907-910): Farm › Today, map and
  log (`/operations/farm`) has **Today · Map · Log · Safety · More**, as
  tabs along the bottom of a phone. The farm being worked on stays at the
  top. **Today** has today's and the next few days' jobs from the farm
  calendar, the mobs in now, a compact map that opens to its full height,
  and the farm's app tiles. **Map** colours paddocks by days since grazed
  or by the cover reading's age, with a key, and a list of every paddock;
  tapping one opens its card (cover and how old it is, mob, last grazed,
  recent records, Add cover and Mob in or out). **Safety** is a placeholder
  until farm health and safety (#446). **More** has every table under
  Details, and year-end and setup. Farm staff land on Today. **App tiles**
  (a name and an address) are added by admins on Farm apps, now headed
  Manage integrations for the keys; a tile never holds a key (tenant
  migration 0187). Paddock numbers on the map stay readable on a phone.

- **Quick logs and the farm walk** (#447, decisions 911-913): the Log tab
  records a mob in, a mob out, a cover reading or feed, one question a
  screen with today and the paddock or mob filled in where known, then a
  check before saving. **Farm walk** goes paddock by paddock with a big
  number box, saving each reading on the phone as it's typed, so closing
  the app and coming back carries on where it was. Every record is kept on
  the phone first (Saved on this phone), sent when there's a signal
  (Synced), or marked Needs attention if Tohyee refuses it; it's never sent
  to another farm or written over another person's record. A record changed
  or added while another is being sent is kept and sent as it is now
  (decision 971). If the phone's storage is full or blocked, it says **Not
  saved on this phone** with a warning to keep the page open, sends it
  straight away, and has **Try saving on this phone again** (decision 972). Each carries
  its own operation id (tenant migration 0188), so sending it twice makes
  it once. The pages themselves still need a signal to open: there's no
  offline app yet (decision 913 says how it would work). Not kept in
  Tohyee yet: rainfall, photos and voice notes, treatments, births and
  deaths.

- **Tohyee on phones and tablets: install** (#472, decisions 990-998;
  [MOBILE-APP.md](MOBILE-APP.md)): **Get Tohyee on this device**
  (`/get-tohyee`) gives each device's steps (iPhone and iPad: Safari ›
  Share › Add to Home Screen; Android: Chrome › Install), with the app icon
  and a web app manifest, so Tohyee opens from the Home Screen on the server
  it was added from. A service worker keeps the farm pages (Today, Map, Log,
  Safety, More) so they open with no signal, for 14 days after the last
  online sign-in; other pages say they need a connection. Copies are kept
  per server and account; signing out deletes them after offering to send
  anything not sent, which is kept. A durable queue in IndexedDB
  (`src/lib/offline/queue.ts`) holds work recorded on the device with
  Unsaved / Saved on this device / Waiting to send / Synced / Needs
  attention, sending each once by its operation id; approvals are never
  queued. Needs HTTPS (Remote access or Tailscale HTTPS); a home-network
  http address works in the browser but not offline. Not yet tried on a
  real iPhone or Android phone. Next: offline farm information (#472 stage
  3), then offline safety and Log work through the queue (stage 4).

- **Offline farm information, kept automatically** (#472 stage 3, decisions
  999-1007): every farm the person can see is kept on the device after an
  online sign-in and whenever Tohyee is open with a connection, a part at a
  time: safety (emergency details, hazards, reports without injury
  details), map and paddocks, pasture, grazing and feed for 12 months, the
  calendar, equipment, inductions and training, fertiliser plans, soil,
  the notebook and small copies of photos. Built on the server from the
  farm screens' own reads as the person, so permissions match; never
  injury or medical details, restricted photos, farm mail, the books or
  payroll. With no connection the farm screens show it, labelled **Last
  known information**. The last good copy of each part stays until a new
  one has arrived. Farm › More › **Offline on this device** shows what's
  kept, when and how big, with extras (3 years, original photos), Update
  now and removal (never of unsent work). Not yet tried on a real phone.

- **Phone app fixes from ChatGPT's review** (#477-#481, decisions
  1050-1057): queued work and farm pack reads name the account they're
  for, and Tohyee refuses them when someone else is signed in, so work is
  never recorded as another person; an old tab whose account changed is
  held and says so. Only Tohyee confirming the same account renews the 14
  offline days (never a public page). Offline histories honour dates,
  paddock and paging, and say what's on the device; a past day's summary
  isn't shown from today's copy. Tractor mode and the farm sections
  (pasture, soil, calendar, fertiliser, notebook, Farms and paddocks) open
  offline with what they read kept in the pack; Ready offline needs both.
  A tractor fix the device refused is kept trying, in order, and a job
  isn't sent until its whole track is kept. Not yet tried on a real phone.

- **Offline work and safety without a signal** (#472 stage 4, decisions
  1008-1016): safety reports with photos, pre-start checks, marking your
  action done, induction sign-offs, signing in and out, and the Log's
  records are kept on the device first and sent once when Tohyee can be
  reached, through the one queue (the Log's and safety's old localStorage
  drafts move into it). Photos are compressed copies with the phone's time
  and, if asked, where the phone was (tenant migration 0193); a photo's
  operation id is its file id, so it's never kept twice. A failed critical
  check shows **Fault on this device** at once; a changed checklist or
  induction makes a queued check or sign-off need attention; sign-ins keep
  the phone's time and show as **Pending**. Releasing machines and
  checking or closing actions always need a connection. Not yet tried on a
  real phone.

- **Tractor and spreader mode** (#472 stage 5, decisions 1020-1030; tenant
  migration 0197): Farm › Map › **Tractor mode** (also under More). Choose
  spreading, spraying, mowing or other work, the paddocks (or none, an
  **Unassigned paddock** job) and the equipment, whose working width and
  implement offset are saved as dated versions. **Start** opens a
  full-screen map (portrait phone or landscape tablet) with the GPS
  accuracy, a big **Working ON/OFF** separate from recording, **Pause**,
  **Finish**, follow and recentre, north up, the estimated worked area,
  overlap and share of the paddocks, and Safety's hazards and no-go zones as
  a reminder. It records only while Tohyee is on screen, keeping the screen
  awake where the browser allows, and says **NOT RECORDING** when the screen
  went off, GPS was lost or weak, or location permission was removed. Each
  GPS fix is kept on the device as it comes; Carry on picks a job up after
  Tohyee closed. Coverage is worked out from the width swept with Working
  ON, overlapping passes counted once, clipped to the paddocks, with GPS
  gaps, jumps and standing still shown as gaps, not invented coverage.
  **Finish** shows the map and numbers, takes the product, rate and
  quantity (marked entered, not measured) and sends the job through the
  device's one queue, with the same statuses as other work kept on the
  device (decisions 1028-1029); sending twice makes it once. With no
  connection the map's hazards can come from the farm's offline copy,
  with its age (decision 1030). On the website each job shows the track against the
  worked footprint, what happened when, the settings used, links to a
  fertiliser plan or a chemical, re-clipping to chosen paddocks,
  withdrawal, and **GeoJSON** and **GPX** exports. Everything says it's a
  phone GPS estimate. Nothing posts to the books. Not tried in a real
  paddock or on a real phone yet.

- **Farm dairy effluent** (#487, decisions 1070-1099, docs/FARM-EFFLUENT.md;
  tenant migration 0200): Farm › More › **Effluent**. Setup (owners and
  admins): systems (travelling irrigator, pods or K-line, slurry tanker or
  spreader, fixed sprinklers or rain gun), each a machine in Safety's
  equipment register with a starting checklist from DairyNZ's staff guides,
  so checks, faults, out of use and release follow Safety's rules; ponds and
  sumps with capacity, gauge marks and warning levels; effluent blocks and
  no-apply zones with buffers on the map; and the consent conditions,
  optionally started from an Otago Regional Council or Environment
  Southland template that fills in what the council's pages say, links
  them, and says "check against your own consent". Kept in the safety
  history (versions, nothing deleted, corrections marked), but not in the
  WorkSafe pack. Tohyee never says a farm complies and never sends anything
  to a council. Not yet reviewed by Jess.
  The **daily log** (farm staff and above, phone first, offline through the
  queue): runs started, shifted and stopped with pod or irrigator positions
  and times, photos with their time and place, the ponding and runoff check,
  weather and soil; depth as entered beside depth worked out from the
  system's settings; last moved on the map; pond readings with percent
  full, storage and days left and high or low warnings; days not applied
  and why; and counts against the consent's entered limits in neutral words.

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
- automatic statement files from zipped files, Tohyee's own email addresses
  (there's no relay), checking a file's account number, or moving or
  deleting files after reading them
- bank feeds from providers other than Akahu, SimpleFIN, Stripe, PayPal and
  Wise, Akahu feeds for foreign-currency accounts (Akahu's transactions
  don't say their currency),
  an adjustment when splitting one posted transaction across several
  statement lines, and old Excel (.xls) files
- on foreign-currency documents (MC11): the reverse charge on imported
  services, supplier overpayments, payments through a bank account in a third currency (as
  NetSuite, MC30), chargeable expenses on foreign-currency projects and
  projects in currencies without cents (MC70), approving repeating ones
  automatically without a rate from the exchange rates list, and sales on the
  payments GST basis; automatic exchange rates from anywhere but the ECB
  (an RBNZ or IRD set comes in as an uploaded file, #183); also paying NZD
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
- sales platforms: Stripe sales (Square left out by Jess, decision 667),
  WooCommerce product and customer sync and surcharges, Shopify chargeback holds, customers' addresses and companies,
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

0. Income tax (#292), next stages: Will's review of the worked examples
   (ITX1-ITX66) and the "paid towards" rule for a late-filed return (ITX6).

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

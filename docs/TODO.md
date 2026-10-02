# Owner's to-do list

Changes the project owner (Jess) has asked for, newest list first. Coding
agents: these come before the "Next" list in docs/FEATURES.md. Anything marked
"to confirm" needs an answer from Jess before it's built; ask rather than guess.

## List of 2 October 2026

Items 1-3 noticed by Jess using the Windows server app on the evening of 1
Oct 2026; items 4 and 5 asked for the same day ("needs to be ERP level
features"). Not looked into yet: find the cause before changing anything.

1. **Glitching between screens.** The program on the computer "kind of
   glitches" when moving between screens. Reproduce it first (on the
   Windows app and in a browser, to see whether it's the app or the pages),
   and ask Jess which screens if it can't be seen.
2. **Items: couldn't find where to add or look at them.** Products and
   services is under Sales (`/operations/items`), which Jess didn't find.
   Checked 2 Oct 2026: the page and New item work. Jess looked under
   Accounting, so it's now in the Accounting menu too (and still under
   Sales).
3. **Couldn't add a fixed asset.** Checked 2 Oct 2026 on a new
   organisation: New asset opens, but a new organisation has no asset
   types, so the Asset type box only offers "Choose a type" and the form
   can't be saved (the browser says "Please select an item in the list";
   the only hint was small grey text). Probably what happened, not yet
   confirmed by Jess. Now New asset says to add an asset type first, with
   a button to Asset types, and adding a type offers "Register an asset".
   Still to check with Jess on her desktop that this was the problem.
4. **Fixed assets to ERP level.** Jess wants ERP-level fixed assets (follow
   NetSuite's Fixed Assets Management, else Xero), taking into account NZ
   GAAP and tax changes of the last 10 years ("make sure any difficult
   things are taken into account", 2 Oct 2026). Researched on 2 Oct 2026:
   `docs/sources/nz-fixed-assets-reporting-changes.md` (NZ IFRS 16 leases,
   IAS 16 proceeds before intended use, Tier 3 revaluations from 1 Apr
   2024, NZ IFRS 18 from 2027, PBE leases and measurement not yet
   effective; building depreciation 2011, 2020 and 2024, low-value
   thresholds, Investment Boost from 22 May 2025). What's built now
   (FEATURES.md, FA1-FA14): asset types, assets from bills or typed,
   diminishing value and straight line, monthly depreciation runs,
   disposals and the register. Next: worked examples and decisions for book
   and tax depreciation, revaluations, impairment, components, assets under
   construction, leases, held for sale, donated assets and transfers, then
   build in stages like payroll's.
5. **Import from any accounting system, to ERP level.** Decided by Jess (2
   Oct 2026): everything that's missing is needed, from files (CSV or
   Excel), **not** a Xero connection, and not tied to Xero: "could be any
   accounting software". What exists: the import wizard (Accounting ›
   Settings, IM1-IM21) for the chart of accounts, contacts, products and
   services, and opening balances at a conversion date (trial balance,
   stock, open invoices and bills). To add: transaction history, the fixed
   asset register (with book and tax values), tracking categories,
   repeating invoices, employees and leave balances, and attachments.
   Worked examples first, following NetSuite's import assistant.

## Tried out on Jess's server, 2 October 2026 (evening)

Claude used Tohyee v0.3.0 on Jess's Windows server through her Chrome, in
the smalldog organisation (made-up data; Jess said to "go nuts"):
contact, item, invoice, approve, payment, bill, asset type, fixed asset
from the bill, depreciation run, profit and loss, balance sheet, GST
return, bank account. The sums were right throughout (invoice 3 x 120 +
GST = 414; depreciation 2,500 x 50% / 12 = 104.17; the balance sheet
balanced). What could be better, not yet decided or built:

1. **Due date is required but often blank.** With no payment terms on the
   customer or supplier, the invoice and bill due dates stay empty and
   Save draft only shows the browser's small "Please fill out this field".
   Xero falls back to the organisation's default terms. To confirm with
   Jess: a default (for example the organisation's terms) or a clearer
   message.
2. **No way to add a supplier (or customer) from the bill or invoice.**
   The bill says to go to Contacts first. Xero lets you type a new name
   on the bill.
3. **A bill on an asset account doesn't offer to register the asset.**
   Approving a bill to 1620 Computer equipment says nothing about fixed
   assets; you have to know to go to New asset (where the bill line is
   then offered). Xero lists these as pending assets.
4. **New items start with no income account or tax code** ("None"), so
   picking the item on an invoice doesn't fill them. Probably default to
   Sales and GST (to confirm).
5. **"All reconciled" / "Everything is reconciled" with no statement at
   all.** Home and the bank account say everything's reconciled when no
   statement has been imported, although 414.00 has gone through the
   account. Should say there's nothing to reconcile yet, or no statement.
6. **The GST return opens on the period that hasn't ended** (1 Oct to 30
   Nov), so September's bill isn't in it; and there's no filing frequency
   set. Probably open on the last period that has ended (to confirm).
7. **Confirm boxes are the browser's own** (Approve, payments, disposals,
   rolling back depreciation). They work, but look old-fashioned next to
   the rest of Tohyee.
8. **Small things:** "Depreciation has already been run to 2026-09-30"
   shows the date as 2026-09-30 where everything else says 30 Sep 2026;
   the customer and supplier tick boxes have no labels for screen
   readers; on a wide (2560 px) screen the pages use about a third of the
   width.
9. **Screen glitch:** in the browser, moving between screens shows
   "Loading…" for a moment (about 50 ms) before the page fills in; no
   freezes or long tasks were measured. The Windows server app needs
   signing in, which Claude doesn't do, so its screens are still to be
   watched with Jess.

## List of 27 September 2026

1. **Server admin completely separate from accounting.** When dealing with the server there is no accounting anywhere: only server information and settings (organisations, users, updates, server details). A Tohyee icon in the Windows tray (by the clock), like a media server's tray icon, shows the server is running and opens the server screen. Decided with Jess (28 Sep 2026): the server settings become a **Windows tray app** installed on the server, not done in the browser at all; Docker/Linux servers use the command-line tool. Done so far: the server screens are out of the accounting menus, in their own area that only opens on the server computer itself (127.0.0.1, main port + 1), and the Windows tray app (installer/windows/tray; starts when you sign in to Windows, like a media server's, as Jess asked). The command-line tool now covers everything the server screens do, for Docker/Linux (`docker compose exec tohyee node tohyee-admin.cjs help`). To do: remove the browser server pages once Jess has tried the app on her server.
2. **Bank feeds and bank reconciliation.** Done: bank accounts, statement import, reconciliation, bank rules and Akahu bank feeds, each organisation connecting its own Akahu personal app (examples BK1-BK16).
3. **Xero-style menus.** A top bar with the organisation switcher, then exactly: Home, Sales, Purchases, Reporting, Accounting, Tax, Contacts. Each drops down to an overview page, its lists and that area's settings. Home shows a card per bank account with the balance and "Reconcile N items" (needs item 2). Our own look, not Xero's branding. Built, with a ☰ menu on phones; Home also shows money owed, bills to pay and the next GST return (Jess's choice, examples H1-H4).
4. **Custom reports.** Reports area with tabs Home, Custom, Drafts, Published, Archived. Edit layout: the report as a page with an editable title, organisation and period, columns per period, grouped rows with totals, formula rows (e.g. Gross Profit), and a toolbar (text block, table, rows/columns, move up/down, delete, PDF). Decided with Jess (29 Sep 2026): start from a standard report; columns for several periods, difference and %, year to date (and budget, once budgets exist); "Published" is a frozen copy; the text block is a note and the table button adds a second accounts table. Built (examples CR1-CR10), with "Print or save as PDF" using the browser's print. The budget column (and actual less budget) is built too, with budgets (built overnight 30 Sep 2026, examples BU1-BU8 not yet approved by Jess).
5. **History, notes and attachments** on journals: show who did what and when (already in the audit log), add notes, and attach files (stored with the organisation's data so backups include them). Confirmed with Jess (28 Sep 2026): invoices, bills, credit notes and contacts too; files stored in the organisation's database, PDF/images/Office/CSV up to 10 MB; notes editable by their author or an admin with the history kept. Built (examples NF1-NF14).

6. **Use Tohyee from anywhere** (phone or laptop, away from home), the way a media server lets you reach it remotely. Decided with Jess (28 Sep 2026): Cloudflare Tunnel; two-step sign-in with an authenticator app and backup codes, required for everyone; email (Gmail/Outlook SMTP) for security alerts and reset links, not sign-in codes. Built: the tunnel (Remote access in the server settings), two-step sign-in and server email, and phone screens (a ☰ menu, and line editors that stack on a phone). **Decided with Jess (30 Sep 2026): three ways — Tohyee address (run by the project, one click, no sign-up), own domain via Cloudflare (free for business), Tailscale Funnel (paid for business).** Built: all three on the Windows server app's Phone access page (one on at a time, each with the address, a QR code, Copy, Open and Turn off); the server gets the Tohyee address (so `remote-access address --on` works on Linux/Docker too) and records the method (tohyee, cloudflare or tailscale); Connect to Cloudflare replaces pasting a token from the Zero Trust dashboard (pasting is kept as a fallback). Still to do: build and deploy the Tohyee address service (a Cloudflare Worker; another branch) and point `TOHYEE_ADDRESS_SERVICE_URL`'s default at it; try Connect to Cloudflare and Tailscale on a real Windows computer (sign-in pages, UAC, surviving a restart); a Linux/Docker way to use Funnel (by hand for now: `tailscale funnel --bg <port>` and set the public address).
7. **Backups.** Decided with Jess (28 Sep 2026): every night; keep 14 daily and 12 monthly; saved to a folder that a cloud service picks up (her server uses OneDrive); encrypted, with a copy of the key kept somewhere safe; restoring makes a copy of the organisation rather than overwriting it. Built: nightly encrypted backups of each organisation and the server's own database, checked after writing, failures retried hourly and emailed; Backups tab in the Windows server app and `backups ...` in the command-line tool; restore as a copy (tested). Jess asked (29 Sep 2026) that people don't lose the key: server admins can see the key (with their password) and check a saved copy by pasting it back, are reminded on every page until someone has, and can restore on a new server with the old server's key. Not yet tried on a real OneDrive folder.

8. **NetSuite-style detail for bigger organisations.** Jess asked (29 Sep 2026) for the extra detail NetSuite has, behind a setting; she chose one "Advanced (ERP) features" switch per organisation (off by default) and custom fields in the first round. The plan sent to her, in order: (1) Department, Class and Location on every line, with the profit and loss split and filtered by them; (2) custom fields and custom segments, in the first round; (3) salespeople on invoices and a sales-by-salesperson report; (4) richer customers and items; (5) a GST audit report. Not planned: subsidiaries/consolidation and commission calculations. Built: (1) (examples TC1-TC10), (2) following NetSuite as Jess asked (examples CS1-CS3, CF1-CF10), (3) salespeople and sales by salesperson (examples SR1-SR8), and (4) richer customers and items, stock tracking (examples RC1-RC12, IT1-IT9, ST1-ST12): payment terms (for everyone, like Xero), credit limits that warn or block, billing and delivery addresses, contact people (the CRM's people, one primary), customer groups, price levels, parent customers and an aged receivables report that can roll subs up; a products and services list for everyone like Xero's, with NetSuite's units of measure, price level prices, supplier prices and kits behind the switch; and stock items on bills, invoices and credit notes moving stock at weighted average per location, with cost of sales on approval and an optional negative stock setting (examples ST1-ST12 approved by Jess, 30 Sep 2026), and (5) the GST audit report (built overnight 30 Sep 2026, examples GA1-GA4 not yet approved by Jess), for every organisation rather than behind the switch since every GST-registered organisation needs it.

9. **Four modules and a CRM.** Decided with Jess (29 Sep 2026): Tohyee has four modules, Accounting, Tax, CRM and Advanced reporting, with a switch per organisation for the CRM and Advanced reporting. The CRM follows Twenty (the best open-source CRM, AGPL like Tohyee), built into Tohyee rather than run alongside it; first round: companies and people, the opportunities pipeline (won work becomes an invoice), tasks and activities, and email and calendar sync. Built, all four (examples MOD1, CRM1-CRM9, MAIL1-MAIL9). Not yet tried against a real Google or Microsoft app.

Done from before: payments and hybrid GST bases (examples G10-G22, from IRD's IR375 and IR546; Jess chose split in proportion for part payments, credit notes counting when applied or refunded, and the basis-change adjustment suggested with one click). Confirmed with Jess (29 Sep 2026): only zero-rated supplies (sales) count, in Box 6; zero-rated purchases stay out of Box 11, as built.

## Step 1: Bigcapital review (do this before building items 1-5)

Study Bigcapital (https://github.com/bigcapitalhq/bigcapital, AGPL-3.0, the same licence as Tohyee) and write docs/BIGCAPITAL-REVIEW.md. Don't change any other files in this session.

For each item below, say (a) how Bigcapital does it, with file paths; (b) what's worth taking (design, logic or React components); (c) what must change for Tohyee (Next.js + PostgreSQL, one database per organisation, database-enforced ledger rules in docs/ARCHITECTURE.md, NZ GST); (d) a rough size (small, medium or large):
1. Navigation and menus (we want: Home, Sales, Purchases, Reporting, Accounting, Tax, Contacts dropdowns)
2. Bank accounts, bank feeds (Plaid, and whether an NZ open-banking provider could replace it), transaction matching, rules and reconciliation
3. The report builder and custom reports
4. History, notes and attachments on transactions (including how files are stored)
5. Anything else Tohyee lacks that a NZ bookkeeper would expect (list only)

Also note: the licence of each folder you'd copy from, anywhere their accounting looks weaker than Tohyee's rules (e.g. can posted entries be edited?), and how they separate server/admin screens from accounting screens.

Keep it factual and cite files. Don't trigger or wait for GitHub Actions. Open a ready-for-review PR with just that document, and stop.

After that review, each item becomes its own build session with worked examples, the same way credit notes were done.

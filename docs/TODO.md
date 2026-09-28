# Owner's to-do list

Changes the project owner (Jess) has asked for, newest list first. Coding
agents: these come before the "Next" list in docs/FEATURES.md. Anything marked
"to confirm" needs an answer from Jess before it's built; ask rather than guess.

## List of 27 September 2026

1. **Server admin completely separate from accounting.** When dealing with the server there is no accounting anywhere: only server information and settings (organisations, users, updates, server details). A Tohyee icon in the Windows tray (by the clock), like a media server's tray icon, shows the server is running and opens the server screen.
2. **Bank feeds and bank reconciliation.** Done: bank accounts, statement import, reconciliation, bank rules and Akahu bank feeds, each organisation connecting its own Akahu personal app (examples BK1-BK16).
3. **Xero-style menus.** A top bar with the organisation switcher, then exactly: Home, Sales, Purchases, Reporting, Accounting, Tax, Contacts. Each drops down to an overview page, its lists and that area's settings. Home shows a card per bank account with the balance and "Reconcile N items" (needs item 2). Our own look, not Xero's branding.
4. **Custom reports.** Reports area with tabs Home, Custom, Drafts, Published, Archived. Edit layout: the report as a page with an editable title, organisation and period, columns per period, grouped rows with totals, formula rows (e.g. Gross Profit), and a toolbar (text block, table, rows/columns, move up/down, delete, PDF). To confirm with Jess: what each toolbar button does, and what else a custom report can change.
5. **History, notes and attachments** on journals: show who did what and when (already in the audit log), add notes, and attach files (stored with the organisation's data so backups include them). Confirmed with Jess (28 Sep 2026): invoices, bills, credit notes and contacts too. Next to build.

6. **Use Tohyee from anywhere** (phone or laptop, away from home), the way a media server lets you reach it remotely. Decided with Jess (28 Sep 2026): Cloudflare Tunnel; two-step sign-in with an authenticator app and backup codes, required for everyone; email (Gmail/Outlook SMTP) for security alerts and reset links, not sign-in codes. Built: the tunnel (Server → Remote access), two-step sign-in and server email. Still to do: screens that work well on a phone.

Done from before: payments and hybrid GST bases (examples G10-G22, from IRD's IR375 and IR546; Jess chose split in proportion for part payments, credit notes counting when applied or refunded, and the basis-change adjustment suggested with one click). Still open: confirming zero-rated purchases stay out of Box 11.

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

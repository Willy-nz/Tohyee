# Plan: build what Xero's top 10 add-ons do

Handover from Jess, 5 Oct 2026. Source: Xero App Store NZ, "Most popular apps
2026" (apps.xero.com/nz/collection/most-popular-apps-2026), read on 5 Oct
2026; the features come from each app's listing. The usual rules apply
(AGENTS.md, `.github/copilot-instructions.md`): worked examples first and
Jess approves them, decimal money, one database per organisation, Xero for
look and usability, NetSuite for features, no status-only screens, no relay
or connection service (third-party services are set up per organisation with
the client's own account), one PR per stage, all checks pass.

## The top 10 and where Tohyee is

| # | App | What it does | Tohyee (5 Oct 2026) |
|---|-----|--------------|---------------------|
| 1 | Syft | Reports, dashboards, KPIs, cash flow forecasts, consolidations, budgets, AI insights, exports and share links | Partly: Analytics, budgets, custom reports. Missing: cash flow forecast, consolidation, AI commentary |
| 2 | Dext | Captures receipts and bills and reads them with AI; supplier rules; duplicates; mileage; approvals | Partly: expense claims with receipts, files on documents, duplicate flags on bank lines, bank rules and bulk coding (BK10, BK22-BK23). Missing: reading documents, a bills inbox, richer rules and supplier defaults, mileage, duplicate check on bills |
| 3 | Stripe | "Pay now" on invoices, saved cards, payments and fees into the books | Missing |
| 4 | ApprovalMax | Multi-step approval rules, budget at approval, approve from email | Partly: single-step approve. Missing: rules, steps, budget check, email approval |
| 5 | PayPal | "Pay now" via PayPal; transactions for reconciliation | Missing (a PayPal CSV export may already import through the CSV mapper; not checked with a real file) |
| 6 | ServiceM8 | Jobs, scheduling, dispatch, checklists, signatures, photos, bookings | Partly: projects, tasks, time, quotes, invoices, CRM. Missing: jobs calendar and the rest |
| 7 | Deputy | Rosters, clock in and out, unavailability, roster cost | Partly: timesheets, leave, workforce budgets. Missing: rosters, clocking in, unavailability |
| 8 | GoCardless | Direct debit when invoices are due | Missing. **GoCardless supports NZ direct debit (BECS NZ)**: docs.gocardless.com/docs/api-reference/schemes, checked 5 Oct 2026 |
| 9 | Tradify | Jobs, scheduling with calendar sync, job photos, service reminders | Partly (as ServiceM8) |
| 10 | A2X | Marketplace payouts as summary entries with fees, refunds and COGS | Partly: Shopify orders, refunds and payouts. Missing: other platforms, chargebacks and reserves, summary mode |

## Jess's answers (5 Oct 2026)

1. **Order:** the stage order below.
2. **Reading receipts and bills:** the AI connected in Tohyee's AI section
   only (decisions 339-348). Nothing new is installed; without a connected
   AI, documents are stored and typed in by hand.
3. **Online payments:** Stripe, then PayPal, then GoCardless direct debit
   (stage 9).
4. **Jobs and scheduling:** part of Projects, not a separate app.
   **Rosters:** inside Payroll.
5. **Consolidation:** organisations on the same server only, with
   eliminations; only people who are members of every organisation in it
   can see it.
6. **Text messages:** not for now.
7. **Bank rules:** always suggest; no "post automatically" option.
8. **Provider connections:** one connection per provider account serves
   both its bank feed (stage 1b) and its online payments (stage 3).

## Stages

Each stage: worked examples first (where it touches the books), Jess
approves, then build with tests, then one PR. Afterwards update FEATURES,
DECISIONS, ARCHITECTURE and HANDOVER, and take screenshots (light, dark,
phone width).

1. **Bank rules and supplier defaults.** Bank rules and bulk coding already
   exist (BK10, BK22-BK23), so this extends them: several conditions (all or
   any, text and amount), fixed and percentage split lines with tracking,
   the contact named like the payee, and contacts' default accounts and
   tracking. **Built** (examples BR1-BR10 and SD1-SD3, approved by Jess
   5 Oct 2026; decisions 380-384; tenant migration 0091).
2. **1b. More bank feeds:** a provider interface (Akahu becomes one of
   several), then PayPal, Stripe and Wise (Jess to confirm the order); a
   watched folder and an email address per bank account using the existing
   statement importers; foreign-currency feeds need worked examples. Study
   the OCA bank-statement-import modules' design; don't copy their code.
   Note: GoCardless's old "Bank Account Data" product was discontinued on
   18 Dec 2023 (gocardless.com/bank-account-data/announcement), and covered
   European banks, so it isn't a provider here.
3. **Bills inbox and reading documents** (connected AI only), duplicate check
   on bills, mileage claims (IRD kilometre rates as a setting).
4. **Online invoice payments:** Stripe (hosted Checkout or Payment Links,
   polling rather than webhooks unless remote access is on), then PayPal. A
   clearing account per provider, fees to expense, payouts matched to the
   bank deposit. Worked examples for part payments, refunds, disputes,
   foreign-currency invoices and GST on fees. Saved cards later (ask Jess).
5. **Approval workflows:** rules, steps, budget at approval, approve by a
   signed single-use email link (ask Jess about sign-in), history.
6. **Cash flow forecast and consolidation** (same server, members of all),
   AI commentary as a suggestion only.
7. **More sales platforms, A2X style:** Shopify summary mode, then
   WooCommerce, Stripe sales, Square, Amazon, eBay, Etsy, PayPal (Jess picks
   the order); Shopify chargebacks and reserves.
8. **Jobs and scheduling inside Projects:** jobs with site address, visits
   on a calendar, time and materials, checklists, photos and signatures,
   invoice from the job, service reminders, Google and Microsoft calendar
   sync. No text messages or booking page for now.
9. **Rosters and clocking in inside Payroll:** rosters with shift costs,
   unavailability and leave as conflicts, clock in and out (location: ask
   Jess), hours into timesheets, cost against workforce budgets and sales.
10. **Direct debit (GoCardless, BECS NZ):** mandates, collection on the due
    date, clearing-account accounting as stage 4.

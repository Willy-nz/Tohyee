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
2. **1b. More bank feeds** (Jess, 5 Oct 2026: Claude chose the order). One PR
   each: (i) automatic statement files, a folder and a mailbox per bank
   account (examples BF1-BF10 approved by Jess 5 Oct 2026; decisions
   385-387; tenant migration 0092; **built**); (ii) SimpleFIN (examples
   SF1-SF10 approved by Jess 5 Oct 2026; decisions 388-391; tenant migration
   0093; **built**), an open
   protocol whose SimpleFIN Bridge (US$15 a year, the organisation's own
   account) reaches US banks, as Actual Budget uses it; (iii) Stripe (examples
   ST1-ST10 approved by Jess 5 Oct 2026; decisions 392-395; tenant migration
   0094; **built**);
   (iv) PayPal (examples PP1-PP10 approved by Jess 5 Oct 2026;
   decisions 396-399; tenant migration 0095; **built**); (v) Wise (examples WI1-WI10 approved by Jess 5 Oct 2026;
   decisions 400-403; tenant migration 0096; **built**; Wise needs no request signing for accounts based in NZ, AU,
   US, CA, SG or MY, so EU and UK accounts are left out).
   Australian banks: only CDR-accredited aggregators (Basiq, Fiskil) reach
   them, aimed at businesses rather than one organisation; left out unless
   Jess asks. Earlier notes: a provider interface (Akahu becomes one of
   several), then PayPal, Stripe and Wise (Jess to confirm the order); a
   watched folder and an email address per bank account using the existing
   statement importers; foreign-currency feeds need worked examples. Study
   the OCA bank-statement-import modules' design; don't copy their code.
   Note: GoCardless's old "Bank Account Data" product was discontinued on
   18 Dec 2023 (gocardless.com/bank-account-data/announcement), and covered
   European banks, so it isn't a provider here.
3. **Bills inbox and reading documents** (connected AI only; examples
   BI1-BI7, DU1-DU5 and MI1-MI7 approved by Jess 5 Oct 2026; built,
   decisions 404-413, tenant migration 0097), duplicate check on bills,
   mileage claims (IRD kilometre rates as a setting).
4. **Online invoice payments** (Stripe part: examples PN1-PN12 approved
   by Jess 5 Oct 2026; built, decisions 414-419, tenant migration 0098;
   PayPal is part 2: examples PPN1-PPN10 approved by Jess 5 Oct 2026;
   built, decisions 420-423, tenant migration 0099): Stripe (hosted Checkout or Payment Links,
   polling rather than webhooks unless remote access is on), then PayPal. A
   clearing account per provider, fees to expense, payouts matched to the
   bank deposit. Worked examples for part payments, refunds, disputes,
   foreign-currency invoices and GST on fees. Saved cards later (ask Jess).
5. **Approval workflows** (examples AW1-AW17 approved by Jess 5 Oct 2026;
   bills, purchase orders and expense claims; built, decisions 424-431,
   tenant migration 0100): rules, steps, budget at approval, an email link
   that needs signing in (Jess chose sign-in over single-use links),
   history.
6. **Cash flow forecast and consolidation** (same server, members of all),
   AI commentary as a suggestion only. Examples CF1-CF9, CO1-CO11 and FX1
   approved by Jess 5 Oct 2026, following NetSuite (Cash 360; OneWorld with
   currency translation, different year ends, ECB daily rates and budget
   exchange rates). Part 1: cash flow forecast; part 2: consolidation;
   part 3: AI commentary (built, decision 446).
7. **More sales platforms, A2X style:** Shopify chargebacks and reserves
   (part 1, examples SPC25-SPC31), then WooCommerce (part 2), then Stripe
   sales, Square, Amazon, eBay, Etsy, PayPal. Jess, 5 Oct 2026: no summary
   mode (each order keeps its invoice and a payout matches them);
   chargebacks to a chargebacks account; reserves to a reserve account;
   WooCommerce next.
8. **Jobs and scheduling inside Projects:** jobs with site address, visits
   on a calendar, time and materials, checklists, photos and signatures,
   invoice from the job, service reminders, Google and Microsoft calendar
   sync. No text messages or booking page for now.
9. **Rosters and clocking in inside Payroll:** rosters with shift costs,
   unavailability and leave as conflicts, clock in and out (location: ask
   Jess), hours into timesheets, cost against workforce budgets and sales.
10. **Direct debit (GoCardless, BECS NZ):** mandates, collection on the due
    date, clearing-account accounting as stage 4.

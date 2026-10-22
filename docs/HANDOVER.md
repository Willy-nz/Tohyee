# Handover (2 October 2026)

Where Tohyee is up to, and what's left to do. This is for Jess and for the
next person or coding agent picking the work up. Read `AGENTS.md` and
`.github/copilot-instructions.md` first; they still apply.

**20 Oct 2026:** the old "Open questions for Jess" are reconciled to their
answers, and what's left is sorted into implementation, research, external
access and real-world validation: see "What's left, by kind" (issue #360).

## Start here (end of the 1-2 Oct 2026 Claude session)

Wound up at Jess's request on Fri 2 Oct 2026, 12:30 NZ time, because usage
was getting high. Nothing is half-done on a branch: everything below is
merged into main, and every merge passed typecheck, lint, unit tests, the
full integration suite (1,014 tests at the end) and the build, then CI on
main.

**Merged in this session** (most without a pull request page: the browser
was asleep overnight, and later the connected Chrome wasn't signed in to
GitHub; each merge commit says so):

| Work | Tenant migration | Examples | Decisions |
| --- | --- | --- | --- |
| Shopify stage 2 (#77) | 0061 | SPC11... | 51-55 |
| Payroll P5 bank files and payslips (#79) | 0063 | PBF1-7, PSLIP1-6 | - |
| Payroll P6 payday filing file | 0064 | PF1-PF9 | 56-65 |
| RDTI R3 claim report | 0065 | RD28-RD42 | 66-75 |
| CRM editable stages, forecasts, quotas | 0066 | CRMS1-CRMS11 | 76-90 |
| Payroll P9 timesheets | 0067 | TS1-TS11 | 91-101 |
| Payroll P10 payroll reports | none | PREP1-PREP8 | 102-111 |
| Payroll P11 workforce budgets | 0068 | WB1-WB7 | 112-123 |
| Payroll P12 extra pays, back pay, final pays | 0069 | XP1-XP14 | 124-137 |
| Payroll P8 Holidays Act leave | 0070 | HL1-HL42 (tested) | 138-167 |
| Leave calls, opening balances, leave requests | 0071 | HL43-HL51 | 168-181 |
| Leave liability posting | 0072 | HL52-HL56 | 182-187 |
| Leave liability: finished employees, employer KiwiSaver, month-end reminder (2 Oct, afternoon session) | 0073 | HL53 (rewritten), HL57-HL61 | 188-191 |

**Next free tenant migration: 0082. Next core migration: 0006. Next decision number: 353.**

**Connect your own AI (branch `claude/connect-your-ai`; decisions 339-352, core
migration 0005, tenant migration 0081):** personal AI keys (Look only, Make
drafts, or Make and post; never delete) and an MCP endpoint (`POST /api/mcp`)
so people's own Claude, ChatGPT and other AI can look up the books, make drafts
and, if allowed, post them; plus draft manual journals (MJD1-MJD9, not yet
approved by Jess). The AI page is `/operations/ai` (the top bar's menu item
comes with the top bar redesign). Tested with the integration tests
(`tests/integration/ai-mcp.test.ts`, `ai-mcp-write.test.ts`,
`journal-drafts.test.ts`) calling the routes directly, not yet with Claude
Desktop, Claude.ai or ChatGPT themselves: try one before telling people it
works with it.

**Evening of 2 Oct 2026 (for 0.4.0):** Claude tried Tohyee on Jess's server through her Chrome and fixed what turned up (docs/TODO.md, "Tried out on Jess's server"; decisions 333-338, tenant migration 0080 for default payment terms), the server app's missing lists and screen glitch on Windows (PR #86; the Windows installer workflow now saves pictures of the server app, also on the ci/tray-screenshots branch), and replaced the browser's confirm boxes with an in-page dialog.

**Updates and server stats (2 Oct 2026, late afternoon; decisions 328-332, core
migration 0004):** the server checks GitHub daily; the Windows server app
notifies and installs in one click (backs up every organisation, checks the
download's SHA-256, runs TohyeeSetup silently, reports how the upgrades
went from the server's new start record); and the app has a Stats page.
The server side is tested here; the tray parts compile (checked with Mono)
and the installer's CI test checks the start record and stats after an
update, but **Install and the notifications haven't been tried on a real
Windows desktop yet**: Jess to try it with the next release. Unverified:
whether Inno Setup's `runasoriginaluser` restarts the app as the signed-in
person when the app starts the installer (it should, since Setup elevates
itself), and whether the Windows build of Node reports disk space through
`fs.statfs` (the installer test will show it).

No worked example is marked approved; Jess still needs to approve them.
Jess asked for open questions to be decided by law, then NetSuite, then
Xero, and recorded in `docs/DECISIONS.md` rather than left for her.

**Done in the afternoon session (2 Oct 2026):** the four leave liability
questions under HL56, decided as the builder proposed (decisions 188-191,
PBE IPSAS 39 paras 9, 11, 13, 17 and 53 read again through the summarising
fetch tool) and built with tenant migration 0073: sick leave stays out
(documented only); finished employees stay in until their final pay's pay
date, at its holiday pay on finishing (HL53 rewritten: Hemi 5,302.89 at 31
Oct, LEAVELIAB-3 −1,024.56; HL57 takes him out at 4 Nov); employer
KiwiSaver on the leave as its own line pair (HL59, HL60); a home page
reminder after each month end (HL61). Tests:
`tests/integration/payroll-leave-liability.test.ts` and
`payroll-leave-liability-kiwisaver.test.ts`. The Liability tab and the home
page reminder weren't opened in a browser.

**Also done in the afternoon (2 Oct 2026, branch `claude/open-questions`):**
Jess asked for every open "Questions for Jess" list to be decided by law →
NetSuite → Xero. All 27 lists in `docs/ACCOUNTING-EXAMPLES.md` are now
marked "decided", with decisions 192-327 in `docs/DECISIONS.md` (most keep
what's built, each with its reason). Built from them, each with examples
and tests:
- timesheet weeks can start on any day (TS12, migration 0074);
- FTE's standard week saved per organisation, and salaried usual hours
  from the usual week (PREP9);
- the buyer's identifier on tax invoices over $1,000 can be an email or
  phone (PD4, IRD's list);
- Shopify guest checkouts to a chosen contact (SPC24, 0075), and a
  "Posting to the accounts" form, which was missing (the posting settings
  could only be set through the API);
- closing the rest of a purchase order (PO10, 0076);
- the supplier's GST number on expense claim receipts over $200 (EC13,
  0077);
- payslips show the account the pay went into (PSLIP7, 0078);
- payday filing due dates count tax working days (PF6; ITA s YA 1, read
  in Chrome with ERA s 130, `docs/sources/`);
- a won opportunity can make a sales order (CRM5b, 0079).
None of the new screens was opened in a browser.

**Next job:** not chosen. Candidates: click through the new payroll screens
in a browser (list below), or Jess's open questions.

**New from Jess (2 Oct 2026), in `docs/TODO.md` ("List of 2 October
2026"):** the Windows app glitches between screens; she couldn't find
where to add or look at items (Products and services is under Sales);
she couldn't add a fixed asset; fixed assets to ERP level, allowing for
NZ GAAP and tax changes of the last 10 years (researched:
`docs/sources/nz-fixed-assets-reporting-changes.md`); and importing
everything from any accounting system by file, no Xero connection.

**Still waiting on Jess or the outside world:**
- Put a payday filing file through myIR's "Check your employment
  information file" service before relying on it.
- Ask IRD how recovering advance holiday pay over the 8% on leaving is
  taxed (decision on Q3 in 168-181; still refused until then).
- IRD's extra pay example 1 is a cent off its own steps (Tohyee follows the
  steps; XP questions).
- Add 2028 public holidays once Employment NZ publishes them (Matariki is
  Fri 14 Jul 2028).
- None of the new screens has been opened in a browser yet: click through
  Payroll (pay runs, bank files, payslips, payday filing, timesheets,
  reports, workforce budget, leave, leave requests, liability), Tax › R&D
  claim report and CRM › Stages / Forecasts.
- Some sources (IRD PDFs, Employment NZ, legislation.govt.nz) were read
  only through a summarising fetch tool; check the quoted figures against
  the real pages.

**Open questions still listed in the docs** (each section's "Questions for
Jess"): mostly agree-or-change calls; the payroll ones are after PF9, TS11,
PREP8, WB7, XP14 and the HL section. (20 Oct 2026: all decided since; see "What's left, by
kind".)

## Where things stand

- **Latest release: v0.5.0** (3 Oct 2026), published with the Windows
  installer, the Docker zip and the Linux bundle.
- **Website and README farm pictures** (15 Oct 2026): a "From the paddock to
  the year-end" section with tabbed farm screenshots, a year-end statements
  picture, and drawn illustrations for each kind of user (`website/img/illo-*.svg`).
  The farm screenshots are of a fictional dairy farm, Kōwhai Dairies, seeded
  with the real services in a scratch file (not committed). Aerial imagery is
  off in them because LINZ can't be reached from the build sessions.
- **Website and README redesigned** (6 Oct 2026, for 0.7.0): `website/` is
  one static page in the app's colours, with Inter served from the site (no
  third-party requests), light and dark, and screenshots of a fictional demo
  business (Kōwhai Coffee Roasters) in `website/img/`, also used by the
  README. The demo data was seeded with the real services in a scratch test
  file, not committed; the payroll and phone-invoice shots were left out
  because they show layout problems (pay run totals tables, the phone line
  table cut off) worth fixing in the app.
- **0.7.0 is ready to publish** (6 Oct 2026): `package.json` says 0.7.0.
  0.6.0 was prepared (4 Oct 2026) but never tagged, so 0.7.0 carries
  everything since 0.5.0: UI step 1 and Ctrl K search (#117, #118), the
  Analytics changes (#122-#125, #128), the Xero add-ons (#159-#173) and
  the review fixes (#174, #175 and this release). Jess to publish the
  `v0.7.0` release on main (pushing the tag starts the release workflows);
  the release notes are below.
- **0.12.0 ready to publish from main** (22 Oct 2026): `package.json` says
  0.12.0 and the notes cover #374-#425. Jess publishes the release "Tohyee
  0.12.0" on main with tag `v0.12.0` and pastes in `docs/releases/0.12.0.md`.
- **0.11.0 ready to publish from main** (20 Oct 2026): `package.json` says
  0.11.0 and the notes cover #339-#372. Jess publishes the release "Tohyee
  0.11.0" on main with tag `v0.11.0` and pastes in `docs/releases/0.11.0.md`.
  The yearly homekill adjustment (#371) and the group workspace (#368)
  merged after the release PR and are included in the notes.
- **0.10.0 ready to publish from main** (19 Oct 2026): `package.json` says
  0.10.0 and the notes cover #289-#325 (income tax, pasture and feed, the
  Farming API, the farm calendar, livestock reporting, expected sick leave,
  the #310 and #323 reviews). Jess publishes the release "Tohyee 0.10.0"
  on main with tag `v0.10.0` and pastes in `docs/releases/0.10.0.md`.
- **0.9.0 ready to publish from main** (15 Oct 2026): `package.json` says
  0.9.0 and the notes cover #282-#288 (NFP performance reports, repeating
  invoice price changes, general ledger history import, free and negative
  lines, roster copy, hardening). Jess publishes the release "Tohyee 0.9.0"
  on main with tag `v0.9.0` and pastes in `docs/releases/0.9.0.md`.
- **0.8.0 ready to publish from main** (15 Oct 2026): the notes now cover
  #180-#278 and the README and website point at v0.8.0. Claude's sessions
  can't push tags or create releases (both refused), so Jess publishes the
  release "Tohyee 0.8.0" on main with tag `v0.8.0` and pastes in
  `docs/releases/0.8.0.md`.
- **0.8.0 was ready to publish** (notes updated 14 Oct 2026): `package.json`
  says 0.8.0. It carries everything merged since v0.7.0 (#180-#256): the
  CRM stages, line discounts, GST registration, exchange rate sources,
  accounting as a module, feed logins, GoCardless, AI full access keys, the
  blue theme and Analytics studio, the security work, livestock for tax,
  jobs, rosters and clocking in, and farming (paddocks, LINZ imagery,
  fertiliser plans, soil tests). The release notes are in
  `docs/releases/0.8.0.md`. Claude's sessions can't create GitHub releases,
  so the earlier mention of a draft release was wrong: Jess creates the
  release "Tohyee 0.8.0" on main with tag `v0.8.0` and pastes the notes in
  (publishing creates the tag, which starts the release workflows).
- Visual check before 0.6.0 (4 Oct 2026, built app in Chromium, light and
  dark, desktop and phone width): Home with two pinned tiles, the dashboard
  with a pivot and its drill-down, Customise, and an Excel source's sheet
  choice (a hidden sheet shows "(hidden)"). Fixed: a pinned (bar)
  chart was squeezed flat (ECharts' default 60px margins on a 140px chart),
  axis labels overlapped on narrow charts, and the report emails text didn't
  say Excel attachments are saved. No page scrolls sideways; no console
  errors.

**0.7.0 release notes** (paste into the release):

```
## Fixes & Improvements

From the project review of 4 Oct 2026 (#158):
- Sign-in limits hold under many requests at once; two-step reset emails only use the server's set public address; personal AI keys stop after a password or two-step reset; request bodies are size-limited before sign-in is checked; crafted .xlsx files can't freeze the server (#130-#134).
- Backups and organisations: a failed restore never drops an existing database, a new organisation never takes over an existing database, and a backup cut off by a restart no longer blocks the day's backups (#135-#137).
- Journal corrections are limited to the journals they're meant for (#138). Switching organisation in another tab no longer posts this tab's form to the other organisation (#143). Emails aren't sent twice after an unclear result (#146). CSV exports neutralise spreadsheet formulas (#148). IMAP report emails save .xlsx attachments (#149). The Customer field is labelled for screen readers (#157).
- Payroll: bank files pay the account kept when the run was approved, approvers can't change an employee's tax code, KiwiSaver or bank account and still approve, KiwiSaver temporary rate reductions, and salary back pay after a reduced period (#139-#142).
- Security headers on every page and API response: frame-ancestors, X-Frame-Options, Referrer-Policy and nosniff (#144).
- Organisations' email servers must be public addresses on ports 25, 465, 587 or 2525. **If an organisation sends through a mail server on the Tohyee server or its local network, a server admin must turn on "Allow local mail relay" (Server settings › Email) after updating, or its emails stop** (#145).
- Akahu bank feeds re-read the last 30 days so late transactions arrive, lines deleted from any bank feed stay deleted, and amounts are read as exact decimals (#147).
- Foreign currency: revaluations can be voided; a transfer out of a foreign account before a revaluation is reversed is refused; one revaluation at a time per account; JPY and XPF statement lines can be coded (#151).
- Analytics: DuckDB memory and temporary-disk caps, a 5-minute limit on rebuilding a shaped table (keeping the last one), and the books copy read in batches (#150).
- Update checks time out after 15 seconds (#154).

New since 0.5.0:
- Bank: rules with several conditions and split lines, contact defaults, statement files read from a folder or mailbox, and SimpleFIN, Stripe, PayPal and Wise feeds.
- Purchases: a bills inbox, duplicate bill warnings, mileage on expense claims, and approval workflows for bills, purchase orders and expense claims.
- Sales: Pay now links with Stripe and PayPal; WooCommerce orders; Shopify chargebacks and reserves.
- Reports: a cash flow forecast, consolidation with ECB rates, and AI-suggested commentary that a person checks.
- Analytics: pinned tiles on Home, pivot tables, Excel (.xlsx) sources, a 30-second limit per question, and each organisation limited to its own folders.
- A simpler top bar, page dashboards, a new Home, and search everything with Ctrl K.

## Documentation & Website
- README and the website list the new features; the Docker zip's README.txt explains the encrypted nightly backups, the backup folder, the backup key and restoring (#153).
- The dev docker-compose.yml is labelled dev-only, binds PostgreSQL to 127.0.0.1 and drops the unused Redis (#155).

## Packaging & Windows Installer
- Release bundles and the Docker image no longer pick up the repository or local analytics/, backups/ or data/ folders (#155).
- The Windows build refuses a PostgreSQL major version other than 17 until upgrades are built (#156). CI now checks relay/ (#156).
- Release workflows run with read-only tokens except the jobs that publish, never overwrite a release's files, and pin the Visual C++ and Inno Setup downloads by SHA-256 (#154; signing comes later).
- Docker zip: Backup-Tohyee makes Tohyee's encrypted backup, and nightly backups go to a `backups` folder beside the compose file instead of inside Docker (#153; not yet tried on Windows).

Database upgrades run by themselves when Tohyee starts. Back up first if you install by hand.
```
- **Next: the Xero top 10 add-ons plan** ([XERO-ADDONS-PLAN.md](XERO-ADDONS-PLAN.md),
  Jess, 5 Oct 2026), with Jess's answers to its questions. Stage 1 (bank
  rules with several conditions and split lines, contacts' default accounts
  and tracking) is built: examples BR1-BR10 and SD1-SD3 approved by Jess
  5 Oct 2026, decisions 380-384, tenant migration 0091. Stage 1b part 1,
  automatic statement files (a folder and a mailbox per bank account), is
  built: examples BF1-BF10 approved by Jess 5 Oct 2026, decisions 385-387,
  tenant migration 0092. Stage 1b part 2, SimpleFIN bank feeds for overseas
  accounts, is built: examples SF1-SF10 approved by Jess 5 Oct 2026,
  decisions 388-391, tenant migration 0093. Stage 1b part 3, Stripe as a
  bank feed, is built: examples ST1-ST10 approved by Jess 5 Oct 2026,
  decisions 392-395, tenant migration 0094. Stage 1b part 4, PayPal as a
  bank feed, is built: examples PP1-PP10 approved by Jess 5 Oct 2026,
  decisions 396-399, tenant migration 0095. Stage 1b part 5, Wise as a
  bank feed, is built: examples WI1-WI10 approved by Jess 5 Oct 2026,
  decisions 400-403, tenant migration 0096. That completes stage 1b. Item 3,
  the bills inbox (read by the connected AI only), duplicate bill warnings
  and mileage on expense claims, is built: examples BI1-BI7, DU1-DU5 and
  MI1-MI7 (and EC1-EC12) approved by Jess 5 Oct 2026, decisions 404-413,
  tenant migration 0097. Item 4 part 1, Pay now with Stripe, is built:
  examples PN1-PN12 approved by Jess 5 Oct 2026, decisions 414-419, tenant
  migration 0098. Item 4 part 2, Pay with PayPal, is built: examples
  PPN1-PPN10 approved by Jess 5 Oct 2026, decisions 420-423, tenant
  migration 0099. That completes item 4 (GoCardless direct debit is stage
  9). Item 5, approval workflows for bills, purchase orders and expense
  claims, is built: examples AW1-AW17 approved by Jess 5 Oct 2026,
  decisions 424-431, tenant migration 0100. Item 6 part 1, the cash flow
  forecast, is built: examples CF1-CF9 approved by Jess 5 Oct 2026,
  decisions 432-436, tenant migration 0101. Item 6 part 2, consolidation
  with ECB rates, is built: examples CO1-CO11 and FX1 approved by Jess 5 Oct
  2026, decisions 437-445, core migration 0007, tenant migration 0102.
  Item 6 part 3, AI commentary as a suggestion (approved by Jess 5 Oct
  2026), is built: examples AC1-AC2, decision 446, core migration 0008,
  tenant migration 0103. That completes item 6. Item 7 part 1, Shopify
  chargebacks and reserves, is built: examples SPC25-SPC31 approved by Jess
  5 Oct 2026, decisions 447-450, tenant migration 0104 (Jess: no summary
  mode; GST on lost chargebacks is with IRD). Item 7 part 2, WooCommerce orders, is built: examples WC1-WC10
  approved by Jess 5 Oct 2026, decisions 451-455, tenant migration 0105.
  Next: the rest of item 7 (Stripe sales, Square, Amazon, eBay, Etsy,
  PayPal; Jess picks the order), examples first.
- Project review of 4 Oct 2026 (#158, issues #130-#157): fixed (decisions
  456-460): #130-#138, #143, #146, #148, #149, #157 (PR #174), #139-#142
  (PR #175), #144, #155, #156 (PR #176), and #144, #145, #147, #150, #151,
  #153, #154, #155, #156 in full (decisions 465-473). Still open: #152
  (Windows testing), #154 signing, the Akahu card balance sign (#147).
  Details in [TODO.md](TODO.md).
- Design rule from Jess: **follow NetSuite where it has an answer, otherwise
  Xero.** Never guess tax rates or legal rules; cite IRD.

## Decisions

`docs/DECISIONS.md` has the calls made on 1 Oct 2026 for payroll rates,
payroll access, Holidays Act leave (built for the 2003 Act now, designed for
the Employment Leave Act 2026 from 6 Aug 2028) and the R&D Tax Incentive,
with sources. Jess asked Claude to research and decide them.

## Choosing the Copilot agent's model and reasoning level

Jess asked Claude to choose these (1 Oct 2026) to keep Copilot credits down.
Set them in the Agents box before sending each task:

| Kind of task | Model | Reasoning |
| --- | --- | --- |
| Accounting, tax, payroll or RDTI calculations; anything that posts to the ledger; migrations that change existing tables; permissions and security | Claude Opus 5.5 | High |
| Ordinary features: screens, records and their APIs, connectors, reports that don't calculate tax | Claude Sonnet 5.5 | Medium |
| Docs-only planning and worked examples (research and citing) | Claude Sonnet 5.5 | Medium |
| Small fixes: renumbering migrations, fixing a test, doc updates, adding next year's rates from IRD's specification | Claude Sonnet 5.5 | Low |

- Don't use X-High or Max unless a task has already failed at High.
- Prefer Claude doing small fixes, reviews and merges directly in its own
  session (no Copilot credits) over starting an agent.
- Give agents everything they need up front (sources, allowlisted sites,
  migration number) so a session isn't spent stopping to ask.

## In progress (GitHub Copilot coding agents)

| Work | Issue | PR | Branch | Tenant migration |
| --- | --- | --- | --- | --- |
| (none) | | | | |

Merged 3 Oct 2026 from Copilot: the ECharts chart component (#94), DuckDB
on Windows (#99), the tray app's Analytics folders page (#100, light theme
removed by Claude), report drill-downs and CSV/Excel/PDF exports (#101).

Analytics (3 Oct 2026): the plan and decisions 353-362 are in
[ANALYTICS-REVIEW.md](ANALYTICS-REVIEW.md). Step 1 (engine, folders,
sources, nightly loads) was built by Claude (#95); step 3's first part
(dashboards, #103) is tenant migration 0083. GST late claims (issue #88)
are built from examples LG1-LG7 (tenant migration 0084, decisions
363-366). Analytics step 2 (the books and CRM, AB1-AB10) is decision 367,
no migration. Tax manager and Practice manager are parked (Jess, 3 Oct
2026; PR #91 left open). The rest of #89 (save any report as custom,
contact and custom-field columns) is with Copilot (#106). Sharing with
clients (report viewer role, dashboard shares) is decision 368, tenant
migration 0085 and core migration 0006. Saving transaction reports as custom
(#107, CR11-CR15) is decision 369, tenant migration 0086; shaping (#110) is
decision 370, 0087; report emails (#111) are decision 371, 0088 (Copilot
built #107, #110 and #111; Claude reviewed and fixed them). All released in
**v0.5.0** (3 Oct 2026). UI review step 1 (#117, decision 372, tenant
migration 0089: top bar, notices bell, dashboard preferences, Home) and
search everything (#118, decision 373, no migration) are built. Pinned
Analytics tiles (#122 for issue #119, decision 374, no migration) put
dashboard tiles on Home; the pages they can go on are listed in
`src/lib/dashboard/pages.ts`. Analytics pivot tiles are built (#123 for issue
#120, decision 375): exact server-side DuckDB aggregates, a 2,000-cell cap,
subtotals, a read-only HTML grid, restricted cell drill-down and CSV/Excel
exports. Perspective was not added because its viewer package is 14 MB
unpacked and needs browser-side WASM and controls to be explicitly locked
down. Excel sources and report-email attachments (#124 for issue #121,
decision 376, tenant migration 0090) use the existing MIT-licensed ExcelJS
package; sources store their chosen worksheet, and workbooks are streamed
with size and ZIP expansion checks. Old `.xls`, `.xlsm` and
password-protected workbooks are refused. DuckDB's file access is limited
(decision 377); pins are kept while hidden (decision 378); every Analytics
question stops after 30 seconds (decision 379). Bank rules with several
conditions and split lines, and contacts' default accounts and tracking
(Xero add-ons stage 1, decisions 380-384, tenant migration 0091).
Automatic statement files from a folder or mailbox per bank account
(stage 1b part 1, decisions 385-387, tenant migration 0092). SimpleFIN
bank feeds (stage 1b part 2, decisions 388-391, tenant migration 0093).
Stripe as a bank feed (stage 1b part 3, decisions 392-395, tenant migration
0094). PayPal as a bank feed (stage 1b part 4, decisions 396-399, tenant
migration 0095). Wise as a bank feed (stage 1b part 5, decisions 400-403,
tenant migration 0096). Bills inbox, duplicate bill warnings and mileage
(item 3, decisions 404-413, tenant migration 0097). Pay now with Stripe
(item 4 part 1, decisions 414-419, tenant migration 0098). Pay with PayPal
(item 4 part 2, decisions 420-423, tenant migration 0099). Approval
workflows (item 5, decisions 424-431, tenant migration 0100). Cash flow
forecast (item 6 part 1, decisions 432-436, tenant migration 0101).
Consolidation and ECB rates (item 6 part 2, decisions 437-445, core
migration 0007, tenant migration 0102). Report commentary (item 6 part 3,
decision 446, core migration 0008, tenant migration 0103). Shopify chargebacks
and reserves (item 7 part 1, decisions 447-450, tenant migration 0104).
WooCommerce orders (item 7
part 2, decisions 451-455, tenant migration 0105). Review fixes
(decisions 456-460, no migrations). Payroll review fixes (decisions
461-464, tenant migrations 0106-0107). Review fixes part 3 (decisions
465-473, tenant migration 0108). Next numbers: tenant migration 0109,
core migration 0009, decision 474. Still open from the review: #152
(Windows service account and folder permissions; needs testing on
Windows), #153's changes untried on Windows, #154 code signing, and
Akahu's credit card balance sign (#147).

Merged 1-2 Oct 2026 (built in Claude sessions): Shopify stage 2 (#77, 0061),
payroll P4 paying wages and IRD (#78, 0062), P5 bank files and payslips (#79,
0063), and, without pull request pages because the browser was unavailable
overnight (each checked locally with typecheck, lint, unit tests, the full
integration suite and the build, then by CI on main): P6 payday filing file
(0064), RDTI R3 claim report (0065), CRM editable stages and forecasts
(0066), P9 timesheets (0067), P10 payroll reports (no migration) and P11
workforce budgets (0068), P12 extra pays, back pay and final pays (0069), P8 Holidays Act leave
(0070), and P8b opening leave balances and leave requests (0071).

Merged 1 Oct 2026: payroll employee records (#62, 0051), not-for-profit fund
tracking (#63, 0052), the CRM as its own app (#66), CRM custom fields (#67,
0053), payroll rates P2 (#71), payroll P1b allocation and payroll access
(#73, 0057), Holidays Act plan P7 (#68), RDTI plan R1 (#72), sales orders
stage 1 (#69, 0055), Shopify stage 1 (#70, 0056), CRM record types
and record page (#74, 0059), the RDTI register R2 (#75, 0060) and payroll
pay runs P3 (#76, 0058).

Next free tenant migration number: 0082 (0058-0081 used: 0081 draft manual journals, 0080 default payment terms, 0079 opportunity sales orders, 0078 pay run bank accounts, 0077 expense claim supplier GST numbers, 0076 purchase order close, 0075 Shopify guest contact, 0074 timesheet first day and standard week, 0063 P5, 0064 P6, 0065 R3, 0066 CRM stages, 0067 timesheets P9, 0068 workforce budgets P11, 0069 extra pays P12, 0070 leave P8, 0071 opening balances and leave requests, 0072 leave liability posting, 0073 employer KiwiSaver on the leave liability).

Merged: the CRM as its own app at `/crm`, with the Accounting ↔ CRM switcher
and the CRM Home (CRM roadmap item 1, example CRM10, #66, 1 Oct 2026).

CRM custom fields are available whenever the CRM module is on, even with
Advanced features off (decided by Jess, 1 Oct 2026). Prospects only get the
fields turned on for prospects; existing customer fields aren't added to
them.

CRM opportunity stages and forecasting (merged 2 Oct 2026,
tenant migration 0066, examples CRMS1-CRMS11 not yet approved, decisions
76-90): the six fixed stages became the organisation's own editable stages
(same keys, so saved opportunities and the API are unchanged), with type,
probability and forecast category; opportunities have their own
probability and forecast category; stage history comes from the audit
history; sales processes per opportunity record type; CRM › Forecasts by
month or financial-year quarter, owner and currency with Salesforce's
cumulative rollups, weighted pipeline, drill-down and monthly quotas.
"Won" now means a stage of type Closed won (the invoice and "open" follow
the type). A won opportunity can make a sales order instead of an invoice
since 2 Oct 2026 (decision 327, CRM5b); it checks `stageType === "won"`. help.salesforce.com couldn't be
read by our tools, so decisions marked (unverified) should be checked.
Jess's questions are under CRMS11.

CRM record types and page layouts, and the Salesforce-style record page,
are in #74 (examples CRT1-CRT13, not yet approved by Jess; her questions are
in the PR). Existing companies, people and opportunities get each kind's
default record type, "Standard", whose layout shows what the old company
page showed, so nothing changes until an admin sets up another type.

### Payroll: the plan (issue #60)

Jess wants payroll for complex businesses (1 Oct 2026). From her Datapay
experience: see each employee's department, split where their pay goes by %,
and split the parts of pay out for reports and budgets. Payroll reports must
only be run by certain people. Each item is its own branch and PR.

- [x] **P1 Employee records** (#62, migration 0051), merged 1 Oct 2026.
- [x] **P1b Cost allocation, pay rate history and payroll access** (migration
      0057). Draft PR #73; examples PE3-PE12 await Jess. Pay runs use
      `allocationOn()`, `payRateOn()`, `splitByPercentages()` and
      `requirePayrollAccess()`.
      - Each employee's default cost split by %: Department, Class, Location
        (the existing tracking categories), and optionally a project and an
        R&D activity, totalling 100%, with effective-from dates so history is
        kept (a move between departments doesn't rewrite old pays).
      - Job title, reports-to, pay rate history with effective dates, and
        employee groups / pay groups (e.g. weekly wages vs monthly salaries).
      - **Payroll access**: a separate permission an admin gives named people
        (not a role). Only they can see employee pay details, pay runs and
        payroll reports. Everyone else sees payroll in the ledger only as
        totals by department and pay item, never per employee.
- [x] **P2 IRD payroll rates as dated data** (#71, no table so 0054 unused):
      `src/lib/payroll/rates/` for 2025-26 and 2026-27 and pure calculations
      in `src/lib/payroll/calculations.ts` (examples PR1-PR16, waiting for
      Jess). Checked against IRD's site 1 Oct 2026. Before each 1 April, add
      the next year's file (README in that folder; a scheduled task checks
      every 5 April).
- [x] **P3 Pay runs** (migration 0058). Merged (#76); examples
      PRUN1-PRUN11 await Jess (questions in the PR and under PRUN11).
      Built:
      - **Pay items** (earnings, after-tax deductions, reimbursements,
        employer KiwiSaver), each with its own expense or liability account
        and its tax treatment from IRD's specification, so wages, overtime,
        allowances, holiday pay, employer KiwiSaver and ESCT report
        separately. Admins add allowances, overtime, holiday pay,
        reimbursements and deductions.
      - Pay runs per pay group and period: draft (calculated live) →
        approve, posting one journal dated the pay date, split by each
        employee's allocation on the pay date, tagged with
        Department/Class/Location/project, so profit and loss and **budget
        vs actual by department** work from the existing budgets. Journal
        lines never name employees; the per-employee split is in
        `payroll_pay_run_postings` (payroll access only). Void with a
        reversing journal.
      - The approver different from the preparer when the organisation turns
        that on (Payroll › Pay items).
      Not built in P3: a per-pay-item allocation override and the R&D
      activity tag (waits for the RDTI register); other employer
      contributions; adding an employee back to a draft once left out
      (delete and start the draft again). Refused rather than guessed:
      extra pays, back pay and final pays (built in P12), leave (built in P8, on its branch), child
      support, payroll giving, pay rate changes inside a period.
- [x] **P4 Paying wages and IRD** (#78, migration 0062), merged; examples
      PPAY1-PPAY12 await Jess (questions under PPAY12). Built:
      - **Wages**: from an approved pay run, payments of net pay from a bank
        account (Dr Wages payable, Cr bank), for the whole run or per
        employee (not both), in part or in full, never more than unpaid;
        journal lines say "Net pay", never a name; matched to the bank
        statement like any payment; void with the exact reversal.
      - **IRD** (Payroll › IRD payments): what approved pay runs owe per IRD
        period (by pay date) for PAYE incl. ACC levy, student loan,
        KiwiSaver and ESCT, with IRD's due date (checked on ird.govt.nz
        1 Oct 2026: monthly by the 20th of the next month; twice a month
        for $500,000+ of PAYE and ESCT: 1st-15th by the 20th, 16th-end by
        the 5th, 16-31 Dec by 15 Jan; weekends move to Monday, public
        holidays aren't checked). Part payments; overpaying a liability
        refused. Monthly or twice a month is a setting (Payroll › Pay items).
      - Undo order enforced: a pay run can't be voided while it has wage
        payments or IRD payments for its period.
      Not built: public holidays in due dates, IRD penalties, child
      support. (Bank files came in P5.)
- [x] **P5 Payslips and bank files** (migration 0063), merged (#79);
      examples PBF1-PBF7 and PSLIP1-PSLIP6 await Jess (questions under each).
      Built:
      - **Bank files** for an approved pay run's unpaid net wages: ANZ
        domestic extended, ASB FastNet MT9 and BNZ IB4B, from each bank's
        own published specification (`docs/sources/nz-bank-direct-credit-formats.md`),
        tested byte for byte with hash totals. Each bank account's number and
        format are set by an admin (Settings › Bank files). Making a file
        posts nothing; "Record as paid" is the P4 wage payment. Westpac and
        Kiwibank refused (no published specification); ASB CSV not made.
      - **Payslips**: print, PDF and email to the employee, with the year to
        date for the tax year and the bank account masked to its last 3
        digits. The email's text is fixed (no figures) and the audit log
        records only that it was queued and sent, to whom.
      Not built: hours each day (P9), an employee portal (leave balances
      came in P8, on its branch). ERA s 130's wording couldn't be read (legislation.govt.nz
      blocks our tools); the payslip follows Holidays Act s 81 and
      Employment NZ's guidance.
- [x] **P6 Payday filing file** for myIR (tenant migration 0064), merged 2 Oct 2026;
      examples PF1-PF9 await Jess (questions under PF9), decisions 56-65.
      From an approved pay run: IRD's employment information file (file
      upload specification 2026-27, `docs/sources/ird-payday-filing-file-spec.md`)
      to upload in myIR, its due date (2 working days after the pay date;
      weekends skipped, public holidays not), and who starts in the period.
      Employer IRD number and payroll contact under Payroll › Pay items.
      Posts nothing; audit event with the file's hash. Not built: the
      employee details file (decision 64), EI amendments, gateway filing.
      **No file has been through myIR's "Check your employment information
      file" service yet**: do that before relying on it.
- [x] **P7 Holidays Act leave, plan** (#68): HL1-HL42 in
      `docs/ACCOUNTING-EXAMPLES.md`, reworked to follow decisions 7-29 in
      `docs/DECISIONS.md` (built for the Holidays Act 2003 until each
      employee's first pay period on or after 6 Aug 2028). Waiting for
      Jess to approve the examples (P8 was built on them anyway, with her
      go-ahead; three were corrected while building: HL11's dates, HL15's
      deduction and the "Decided" summary of decision 14).
- [x] **P8 Holidays Act leave, build** (tenant migration 0070), merged 2 Oct
      2026; examples
      HL1-HL42 still await Jess (questions at the end of the HL section),
      decisions 138-167. Built:
      - Each employee's usual week (hours each day with regular overtime
        and allowances, or hours that vary) and leave settings, dated;
        drafts make the usual pay from it.
      - Leave bookings (annual, sick, bereavement, family violence as
        "Special leave", alternative holidays), unpaid leave, public
        holiday decisions, cash-ups with the written request and answer,
        exchanged alternative holidays; pay runs pay them as leave lines
        with hours, units and the rate's inputs, worked out again on
        approval; balances count approved pay runs only.
      - Annual holidays at max(OWP, AWE over 12 calendar months), part
        weeks by hours, holidays in advance, cash-ups (extra pays),
        public holidays (2025-2027 data, s 45/45A per employee, time and a
        half, alternative holidays), holiday pay on finishing (s 23-s 26,
        s 40(3), s 60(2)(b)) replacing P12's typed figure where Tohyee
        keeps the leave.
      - The s 81 record (print, CSV), balances, the leave liability report
        by Department with the running 8% (shown only), payslip balances,
        leave hours in the EI file, leave pay as R&D cost.
      Refused: opening leave balances (so anyone employed before Tohyee's
      first pay run for them; built in P8b, decision 168), deducting
      advance holiday pay over the 8%, back pay over leave, paying holidays
      before they're taken, employees booking their own leave (requests
      built in P8b, decision 169), the Employment Leave Act 2026. Screens weren't checked in a browser.
- [x] **P8b The leave build's questions, opening balances and leave
      requests** (tenant migration 0071), merged from `claude/payroll-p8b-leave-calls`
      (2 Oct 2026). Jess asked Claude to research and decide the 14 leave
      build questions: decisions 168-181 in `docs/DECISIONS.md`
      ("Decided (leave build)" at the end of the HL section). Built, with
      examples HL43-HL51 (not approved by Jess):
      - **Opening leave balances** (decision 168): entered once per employee
        on their leave screen, as at the end of a pay period, with the
        source and the previous payroll's report; the earlier earnings by
        pay period. This lifts decision 143's refusal, the biggest gap.
      - **Employees' own leave requests** (decision 169): Payroll › Leave
        requests, approved by the timesheet approver, reports-to manager or
        payroll access; approving books the leave.
      - The public holiday decision shows s 12(3)'s other factors beside
        Tohyee's suggestion (decision 173); HL13 sets Aroha's anniversary
        day to Wellington's (decision 180).
      Still refused (decisions 170-172): advance holiday pay over the 8%
      (ask IRD how the recovery is taxed), back pay over leave (the law
      isn't clear), paying holidays before they're taken. **Next:** 2028's
      public holidays when Employment NZ publishes them (decision 179).
      Screens weren't checked in a browser.
- [x] **Posting the leave liability** (tenant migration 0072), on
      `claude/payroll-leave-liability-posting` (2 Oct 2026), decisions
      182-187, examples HL52-HL56 (not approved by Jess; questions at the
      end of the HL section). Payroll › Leave › Liability: one journal at
      a date for the change since the last posting not voided, by
      Department, Dr leave expense / Cr employee entitlements (the other
      way for a fall), never naming anyone; accounts in payroll settings;
      refused before the last posting, in a locked period, without the
      accounts, with a problem on any report row, or with nothing to
      post; only the latest posting voided (reversing journal). PBE IPSAS
      39 paras 11, 13, 15 and 16 read (decision 187). Then decisions
      188-191 (migration 0073, HL53 rewritten, HL57-HL61): finished
      employees until their final pay is paid, employer KiwiSaver on the
      leave, a month-end reminder on the home page; sick leave stays out.
      Screens weren't checked in a browser.
- [x] **P9 Timesheets** (tenant migration 0067), merged 2 Oct 2026; examples
      TS1-TS11 await Jess (questions under TS11), decisions 91-101. Built:
      - Payroll › Timesheets: one timesheet per employee per week (Monday to
        Sunday), hours per day to 2 places by R&D activity, Department,
        project, a combination or "other work"; "Fill from project time"
        suggests rows from the employee's project time (timesheets are their
        own record, decision 91). Every entry is stamped by the database;
        changes replace entries and keep the old ones; entries more than 14
        days after the work are flagged (decision 38).
      - Employees linked to their login fill in their own (viewers can;
        hours only, never pay); the timesheet approver (bookkeeper and up),
        else the reports-to manager's login, or anyone with payroll access
        approves or rejects with a reason, never their own (NetSuite). Only
        payroll access reopens an approved timesheet, and never once an
        approved pay run used it (the database refuses).
      - Pay runs approved afterwards split costs by the approved hours for
        the days covered and the default allocation for the rest, and keep
        the shares; fully covered hourly employees get their timesheet hours
        as Ordinary time. PAYE and the rest unchanged.
      - The R&D claim counts timesheet shares as time records (decision 34's
        100% rule stays for the allocation's share), and notes timesheets
        approved after their pay run (decision 37).
      Not built: leave and overtime from timesheets, reallocating a posted
      pay to a late timesheet (RD22), copying hours into project time.
      Screens weren't checked in a browser.
- [x] **P10 Payroll reports** (no migration), merged 2 Oct 2026; examples
      PREP1-PREP8 await Jess (questions under PREP8), decisions 102-111.
      Payroll › Reports, payroll access only, read-only, by pay date, from
      approved pay runs' stored figures and the shares each used:
      - labour cost by Department, project, R&D activity, pay item or
        employee, all five as filters together; reimbursements apart;
      - payroll summary (gross to net per pay run, totals by pay item);
      - reconciliation of each payroll account to its ledger movement, with
        the journals that explain each difference (voided pay runs and
        payments, manual journals, other documents);
      - headcount and FTE at a date and by month (usual hours ÷ a standard
        week of 40 unless typed; salaries 1, assumed);
      - employee earnings history; PAYE, KiwiSaver and student loan by
        month, tied to EI files (from the audit log) and IRD payments.
      CSV export of each, audited without figures. Not built: leave reports
      (P8), reports by pay period, a view without payroll access. Screens
      weren't checked in a browser.
- [x] **P11 Workforce budgets** (tenant migration 0068), merged 2 Oct 2026;
      examples WB1-WB7 await Jess (questions at the end of the section),
      decisions 112-123. Payroll › Workforce budget, payroll access only:
      wages by employee or position (to be hired) and month, salary × FTE or
      hourly × hours, pay rises from a month, employer KiwiSaver (ESCT adds
      no cost), split by the employee's allocation on the 1st of each month
      or a position's own split; written into the budgets it feeds (overall
      or a Department, Class or Location budget) as read-only wages and
      KiwiSaver amounts the database protects, rewritten on save and on
      "Update budgets" (the screen says when an allocation change made them
      out of date); budget vs actual for wages against P10 labour cost by
      Department and month. NetSuite has no workforce module ("A Workforce
      module is not currently available"), so this follows Oracle Planning
      Workforce; Xero unverified. Not built: part months, several people
      per position line, on-costs, following later pay rate changes. The
      screen wasn't checked in a browser.
- [x] **P12 Back pay, extra pays and final pays** (tenant migration 0069),
      merged 2 Oct 2026; examples XP1-XP14
      await Jess (questions at the end of the section), decisions 124-137.
      Built:
      - Pay items Extra pay, Back pay, Holiday pay on finishing (worked out
        outside Tohyee) and Redundancy; extra pays taxed by IRD's extra pay
        rules (spec 2026-27 5.11, 5.12, IR335): four weeks' regular pay
        annualised, or on a final pay with a termination item the last 2
        paid periods; secondary codes' low thresholds; ND and NSW flat;
        redundancy without levy or KiwiSaver; student loan on the whole pay.
        IRD's own examples are the unit tests.
      - Back pay from pay rate history, a line per approved period paid at
        less, never paid twice.
      - Final pays: drafts include people finishing in the period; EI file
        finish date, lump sum indicator and redundancy as not levied;
        payslip notes; reports, journals and the R&D claim handle the new
        items.
      Not built (refused): holiday pay owed on finishing (P8; typed for
      now), holiday pay on back pay, short four-week windows, extra pays on
      a final pay without a termination item, CAE/EDW extra pays, a higher
      rate on request, separate extra-pay pay runs. **Conflict found:** IRD's
      printed example 1 truncates tax and levy separately ($10,366.39); its
      steps truncate once ($10,366.40), which Tohyee follows (question 1).
      Screens weren't checked in a browser.

Payroll and RDTI work needs IRD, ACC, legislation and Employment NZ sites:
ird.govt.nz, acc.co.nz, legislation.govt.nz and employment.govt.nz are on the
repo's Copilot cloud agent allowlist (added 1 Oct 2026, with Jess's OK). A
scheduled task checks IRD's payroll specification every 5 April and starts an
agent to add the new year's rates.

### RDTI (Research and Development Tax Incentive)

Jess wants R&D tax incentive tracking (1 Oct 2026). The rules are in IRD's
guidance IR1240 (15% credit; $50,000 minimum eligible expenditure in most
cases; core and supporting activities; employee, goods and services,
depreciation and apportioned overhead costs; contemporaneous records kept at
the time, not backdated; general approval and the supplementary return have
deadlines). Agents must check the current IR1240 and cite it, never memory.

- [x] **R1 Plan**: worked examples and questions for Jess, docs only.
      Written (RD1-RD27 in `docs/ACCOUNTING-EXAMPLES.md`, from IR1240 April
      2026, read 1 Oct 2026). Its questions are decided (`docs/DECISIONS.md`
      30-50) and the examples follow them; waiting for Jess to approve the
      examples.
- [x] **R2 R&D activity register and tagging** (merged, #75, tenant
      migration 0060; RD1-RD3, RD8, RD9, RD11-RD13, RD21-RD23 tested, the
      examples still waiting for Jess):
      - Register (Tax › R&D activities, `src/lib/rd/register.ts`): core or
        supporting activities with project, IR1240's descriptions, income
        years, NZ or overseas, and the core activities a supporting one
        supports (decision 39). Archived by admins, never deleted. General
        approvals need IRD's letter attached and show "not checked with IRD"
        (decision 40); a change to an approved activity's descriptions,
        type, place or links flags "changed since approval was entered".
      - Files (`src/lib/rd/files.ts`): replaced with a new version, never
        deleted (decision 45). Nothing purges them after 7 years yet.
      - Tags (`src/lib/rd/tags.ts`): one tag per posted bill, expense claim,
        spend money or manual journal line, with a share %, an eligible
        category or an ineligible reason (IR1240), flags for the
        supplementary return, goods not used by year end (decision 41) and a
        contractor's own ineligible costs. Amounts exclude GST and use the
        document's exchange rate; GST, exchange gains and losses, income and
        balance sheet lines can't be tagged (decision 42). Tagging without an
        approval warns (decision 47).
      - Fixed assets (`src/lib/rd/assets.ts`): tax depreciation and
        Investment Boost entered per income year (decision 33), split by a
        usage log of hours; the split rounds R&D shares down to the cent.
      - Every register change, tag and usage entry is stamped by the
        database with who and when, kept in `rd_history`, and flagged
        "entered late" when entered more than 14 days after the work
        (decision 38).
      - Payroll hook: `payroll_cost_allocation_lines.rd_activity_id` is now a
        foreign key to `rd_activities`; an allocation line can name an
        active activity. Pay runs (P3) don't tag yet; R3 must count an
        employee's pay as R&D only for the R&D share of their allocation or
        timesheets, with the 100% rule in decision 34 applied in the claim
        report. The allocation screen doesn't offer the picker yet (it's in
        the payroll area another agent is changing).
      - Tagged costs (Tax › Tagged R&D costs): what's tagged by activity and
        category for an income year, plus untagged lines to tag. Not the
        claim.
- [x] **R3 RDTI claim report**: merged 2 Oct 2026 (tenant migration **0065**); examples RD28-RD42 (and RD3, RD4, RD16-RD20,
      RD24-RD27 now tested) await Jess, with "Questions for Jess (claim
      report)" under RD42; decisions 66-75 in `docs/DECISIONS.md`. Tax › R&D
      claim report (`src/lib/rd/claim.ts`, `claim-figures.ts`,
      `deadlines.ts`, `overheads.ts`, `payroll.ts`):
      - eligible expenditure by activity and category for activities with an
        approval covering the year; the overseas limit shared across
        categories; the $50,000 minimum after it (approved research provider
        only below it); the $120 million maximum; the 15% credit; per project
        the supplementary return's figures; ineligible expenditure; what's
        left out and why;
      - **pay from cost allocations, not timesheets** (P9 isn't built): a pay
        counts only when the allocation the pay run used is 100% R&D
        (decisions 34, 67); others are listed as "default split, no time
        record". Pay runs still don't tag; the report reads their postings
        and the allocation entered before approval. Each employee's pay only
        with payroll access;
      - overhead rules (% of an account, IR1240 basis, workings required),
        changed by a replacing rule with the earlier figure shown;
      - deadlines for 31 March balance dates only, reminders for owners and
        admins on the home page; CSV export keeping the summary figures.
      Payroll P9 (branch `claude/payroll-p9-timesheets`) now does this: pay
      runs keep their shares and the report takes timesheet hours before the
      allocation (TS5-TS9; RD5 with P3's figures is TS7). RD6's spreading of
      leave and RD22's reallocation still aren't built.

To do:

- [ ] Review each PR against the repo rules: worked examples with real
      numbers in `docs/ACCOUNTING-EXAMPLES.md` and a test for each; money only
      through `src/lib/money/decimal.ts`; IRD/XRB figures stored as dated
      data with sources; new tenant migrations numbered after 0050.
- [ ] Check the questions each PR lists for Jess, and answer or decide them.
      (20 Oct 2026: decided under decisions 537 and 634-639; what remains is
      in "What's left, by kind".)
- [ ] Holidays Act leave was planned in #60 but only clearly specified parts
      should be built; expect it to be partly refused. (Built in P8 on
      `claude/payroll-p8-leave`, with the refusals listed there; review and
      merge it, and decide the leave questions.)

## Things only Jess (or her computer) can do

(20 Oct 2026: kept for the history. Each item is now under "What's left, by
kind" below as external access, research or real-world validation.)

- [ ] **The legal texts still missing.** Everything asked for is now in
      `docs/sources/` (ERA s 130 and tax "working day" added 2 Oct 2026),
      except: the rule that moves a tax payment due on a non-working day
      (decision 250), and MBIE's technical guidance for the Employment
      Leave Act when it's published (due Nov 2026 to Jan 2027), including
      how to convert existing leave balances.
- [ ] **Ask IRD how recovering advance holiday pay is taxed** (decision
      170): an employee leaves having taken more annual holidays in advance
      than the 8% covers, and consents in writing to the excess coming off
      the final pay. Does it reduce the final pay's gross (PAYE income), or
      is it an after-tax deduction, and what if the holiday pay was in an
      earlier tax year? Tohyee refuses the deduction until this is known.
- [ ] **2028 public holidays** (decision 179): when Employment NZ publishes
      2028's dates (anniversary days included), add them to
      `src/lib/payroll/leave/public-holiday-dates.ts` before any pay period
      touching 2028; check Matariki is Fri 14 Jul 2028 (Te Papa's list).
- [ ] **Test on a real Windows computer**: install from TohyeeSetup, the
      server app, backups to OneDrive.
- [ ] **Akahu bank feeds** with a real Akahu app.
- [ ] **Email sending** with real accounts: Microsoft sign-in and Google
      sign-in. For Google, the app should be "In production" (Testing ends
      the connection after 7 days) or "Internal" for Workspace.
- [ ] **Tohyee address relay** (the no-sign-up phone access option): needs a
      domain, Cloudflare's written OK, and setting up the Worker in `relay/`
      (see `relay/README.md`).
- [ ] **Check a payday filing file in myIR**: make the file from a real
      approved pay run (Payroll › Pay runs › Payday filing) and put it
      through myIR's "Check your employment information file" service before
      filing with it. It's the only way to confirm amounts in cents, line
      endings, macrons and the 3.5% KiwiSaver rate (decisions 56-65).
- [ ] **Approve the worked examples.** Every section marked "(examples not yet
      approved by Jess)" in `docs/ACCOUNTING-EXAMPLES.md` is waiting, most
      importantly the newest: multi-currency (MC1-MC83), exports and tax codes
      (EX1-EX25, TAO1-TAO12), year end and period close, bringing in existing
      books, and bank reconciliation.
- [ ] Release 0.3.1 (or later) when ready.

## What's left, by kind (reconciled 20 October 2026)

The old "Open questions for Jess" list below was stale (issue #360): almost
every item had a later answer in `docs/DECISIONS.md` or
`docs/ACCOUNTING-EXAMPLES.md`. Jess asked on 2 Oct 2026 for the lists to be
decided by law, then NetSuite, then Xero (decisions 192-327). On 15 Oct 2026
she said to follow Xero or NetSuite until a real person says otherwise
(decision 537). On 20 Oct 2026 she delegated the remaining choices to Codex
(issue #360 and the 20 Oct comment on #292; decisions 634-639). What's left
isn't a set of questions for Jess. It's work, split into four kinds, and
nobody should ask her these again. Each item says where its answer is.

**Implementation** (decided; needs worked examples, tests and building):
- Extra-pay pay runs on their own and a higher tax rate on request
  (decisions 218, 219).
- GST on foreign-currency spend and receive money (multi-currency
  question 1; not built). Opening unpresented bank items as opening
  transactions (decision 313: later). An optional RBNZ rate source beside
  the ECB rates (decision 437 built ECB rates).
- Workforce budget on-costs: holiday pay, ACC levies, overtime (decision
  209: later). Project time rounding as a setting (297). Balance sheet
  budgets (289).
- RDTI feedstock (decision 222) and RD22's reallocation of a posted pay to
  a late timesheet (decision 198 lists it).
- Tax: the organisation's own tax workspace first, then a multi-client
  overview; finish IR4/IR3/IR10, then trusts, then partnerships/LTCs;
  imports and reviewable forecasts first; prepare and export only
  (decision 634). ITX6 (provisional tax payments) and RAT1 (GST on rations)
  are **being built** now from the #292 comment of 20 Oct 2026; see that
  PR.
- Private farm mail history, retention and the privacy boundary (#360
  items 8-10, #250): **being built**.
- Flat groups, linked customers and group storage (#360 items 11-13,
  #200): **being built**.
- CRM workflow completeness (#360 item 17, #216): **being built**.
- The co-op share register (#360 item 15, #327): built in its own PR
  (decisions 630-633, examples CSR1-CSR10). Ledger links and a Fonterra
  share standard calculator are deferred there.
- Marketplaces: finish Shopify, then WooCommerce's gaps (decisions 637,
  665, 666). Square was left out by Jess on 20 Oct 2026: it doesn't take
  card payments in New Zealand (decision 667). Farm data: file imports, then Pasture.io, then LIC
  (decision 635). Default dashboards by kind of user (decision 639).
- **Practice manager stays unbuilt.** Jess's own "Dont do practice
  manager" stands over #360 item 19 (decision 638; parked since 3 Oct
  2026, PR #91).

**Research** (read the source, then write the example; no owner choice):
- Payments basis, part-paid foreign sales: which rate. Read IRD's guidance
  (decision 307; refused until then).
- Whether a USD tax invoice must also show its GST in NZD. Read the GST Act
  (decision 306 is unverified).
- The reverse charge on imported services: when IRD applies it (decision
  311; refused until then).
- Back pay over periods with leave: the law doesn't say whether a
  backdated rise changes holiday pay already paid (decisions 171, 216;
  refused).
- How Xero handles a change of GST filing frequency, before deciding
  whether to let IRD's start date be entered. Until then the changeover is
  worked out from the setting (GP2).
- RAT1's narrow case (GST valuation and timing for a sole trader's own
  homekill) and tax-form rounding under decision 565: technical checks,
  not preferences (#360 item 7).
- The rule that moves a tax payment due on a non-working day (decision
  250), and MBIE's Employment Leave Act guidance when it's published (Nov
  2026 to Jan 2027).
- Fonterra's share standard rules over time, before any calculator (#327).
- Sources read only through the summarising fetch tool: check the quoted
  figures against the real pages.

**External access** (needs an account, a provider, IRD or money; not a
preference):
- IRD: how recovering advance holiday pay over the 8% is taxed (decision
  170), and whether to follow its extra pay example 1 or its steps (212
  follows the steps; asking IRD is optional).
- IRD gateway or myIR filing access; provider terms and access for Akahu,
  Pasture.io, LIC and any tax-pooling provider (#360 items 3, 6,
  14, 18).
- A domain and Cloudflare's written OK for the Tohyee address relay
  (`relay/README.md`).
- A code-signing certificate. Installer signing stays deferred until one
  exists; no purchase is authorised (#154, #360).
- 2028 public holidays once Employment NZ publishes them (decision 179;
  then add them to `public-holiday-dates.ts`; Matariki is Fri 14 Jul 2028).

**Real-world validation** (try it for real; don't claim it passed until
someone has):
- A real Windows computer: TohyeeSetup, the server app, updates, OneDrive
  backups, Connect to Cloudflare and Tailscale, Docker Desktop (#153).
- Akahu with a real app, including the credit card balance sign (#147).
- Email sending and mail sync with real Microsoft and Google accounts.
- A payday filing file through myIR's "Check your employment information
  file" service (decision 265).
- AI keys with Claude Desktop, Claude.ai or ChatGPT themselves.
- Clicking through screens that no one has opened in a browser.
- An accountant's review of the worked examples. Delegated answers don't
  make an example reviewed: keep the "not yet reviewed" marks (#360).

Also settled, so not to be reopened (#360): jobs JV1-JV9 (decision 510:
hours confirmed, materials leave stock on the invoice, reminders in Tohyee,
one-way calendar file); rosters RS1-RS8 (decisions 511, 512, 518: no
location, exact minutes, wages plus employer KiwiSaver, shared-device PINs,
weekly area budget typed); livestock (decisions 503-509, with the later
reporting-basis and class qualifications in 566 and 567).

## Open questions for Jess (as listed until 20 October 2026, with their answers)

Kept for the history. Each item now says what answered it. Each "Questions
for Jess" list in `docs/ACCOUNTING-EXAMPLES.md` has the full wording; all of
them are marked "decided".

**Multi-currency**
- Foreign sales on the **payments basis**: count a part payment at the
  invoice's rate or the payment's rate? → Still refused (decision 307).
  Research, above.
- **Refunds** of foreign credit treated like payments: OK? → Kept (309).
- **Stock on a foreign bill** valued at the bill's rate: OK? → Kept (310).
- A **free daily exchange rate feed**? → Daily ECB rates were built (437,
  FX1, Jess 5 Oct 2026), replacing 308's "later".
- Revaluation: round each document to cents on its own? Revalue again
  before the last one reverses? → Per document, as built (multi-currency
  question 4); one revaluation at a time, and revaluations can be voided
  (469, 470, Jess approved FXB12-FXB14).
- Should a printed USD tax invoice also show its GST in NZD? → USD only
  (306, unverified). Research, above.
- Build the **reverse charge**, or GST on foreign spend and receive money?
  → Reverse charge stays refused (311, exports question 3). GST on foreign
  spend and receive money: implementation, above.

**Projects and CRM** (foreign currency)
- Chargeable expenses on a foreign project? → Foreign projects are costs
  only (302).
- Customer's currency changeable while projects or opportunities are empty?
  → No, fixed once it has one (304).
- Refuse projects in currencies without cents? → Yes (305).

**Tax codes**
- Should drafts and repeating templates stop "Available on" from changing?
  → No: they're refused when next saved or made (TAO section, TAO9, TAO11),
  as built following NetSuite (exports question 5).
- Check invoices and bills brought in from existing books against
  "Available on"? → No: they record the old system's documents (TAO "Not
  supported yet").

**GST**
- Enter IRD's start date when the filing frequency changes? → The
  changeover is worked out from the setting (GP2). Research, above.

**Bringing in existing books** → All kept: 0.05 rounding (312), the bank
opening balance as the ledger balance (313), control accounts matched by
name and re-coded (314), contacts without columns are both (315).

**Year end and period close** → A bookkeeper can close a month when every
check passes (316).

**RDTI claim report** → Decisions 220-223: timesheet credit as built;
reimbursements stay out; feedstock not built (implementation, above);
exports keep the summary figures.

**Timesheets** → Decisions 192-198: the first day of the week is a setting;
viewers keep filling in their own; approvers can't change hours; calendar
days; ordinary time only; project hours not automatic; late timesheets
listed (RD22's reallocation is implementation, above).

**Payroll reports** → Decisions 199-205: standard week per organisation;
salaried hours from the usual week; FTE capped at 1; reimbursements out;
pay date only; "Not recorded" stays; no second permission.

**Workforce budgets** → Decisions 206-211: whole months; no automatic rate
follow; KiwiSaver as typed; on-costs later (implementation, above); one
line per person; actuals by pay date.

**Posting the leave liability**: decided 2 Oct 2026 (decisions 188-191)
and built.

**Holidays Act leave** (P8): decided 2 Oct 2026 (168-181). The three left
for IRD or the law are now under External access (advance holiday pay,
170; 2028 public holidays, 179) and Research (back pay over leave, 171).

**Extra pays, back pay and final pays** → Decisions 212-219: IRD's steps,
not its example; short windows use IRD's "other circumstances" rule
(built); a bonus on a final pay without a termination item stays refused;
holiday pay on finishing as built; back pay over holiday pay periods stays
refused; hourly leavers as built; separate extra-pay runs and a higher
rate on request are implementation, above.

**Older lists** (repeating bills, quotes, repeating invoices and printed
documents, purchase orders, stock transfers, budgets, expense claims, fixed
assets, projects) → Decided 2 Oct 2026, decisions 270-305.

## How things are done (practical notes)

- **Merging**: Jess has said to merge PRs once checks pass (there are no users
  yet). Use merge commits, not squash.
- **Checks**: `npm run lint`, `npm run typecheck`,
  `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm test`
  (about 15 minutes for the full suite), `npm run build`. CI runs the same.
- **Year simulation** (opt-in, not in CI): `SIMULATION=1` with the usual
  `TEST_DATABASE_URL` runs `tests/simulation/year.test.ts`, a made-up year of
  trading checked against its own tally of every account, the GST returns,
  the reports and the next year's rollover. `SIMULATION_SEED=<number>` gives a
  different year; `SIMULATION_BASIS=payments` uses the payments basis. Run it
  after changing anything that posts to the ledger. It prints
  `PROBLEMS FOUND: 0` when everything ties out.
- **Releases**: bump `package.json`, merge to main, then publish a release on
  GitHub with a new `v<version>` tag on main. Publishing the tag runs the
  workflows that build and attach TohyeeSetup, the Docker zip and the Linux
  bundle. From a Claude cloud session, tag pushes and the releases API are
  blocked, so publish through Jess's **Windows desktop** Chrome (the Mac is
  someone else's computer).
- **Website**: `website/` publishes to https://willy-nz.github.io/Tohyee/ when
  it changes on main. `website/news.json` feeds the server app's news.
- **Parallel work**: give each branch its own tenant migration number up
  front; conflicts in `tenant.ts` and the docs are expected and easy to merge.

## Not started

- Bank feeds from providers other than Akahu.
- Anything else in `docs/FEATURES.md` under "Next" and `docs/TODO.md`.

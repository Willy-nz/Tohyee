# Handover (2 October 2026)

Where Tohyee is up to, and what's left to do. This is for Jess and for the
next person or coding agent picking the work up. Read `AGENTS.md` and
`.github/copilot-instructions.md` first; they still apply.

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
PREP8, WB7, XP14 and the HL section.

## Where things stand

- **Latest release: v0.5.0** (3 Oct 2026), published with the Windows
  installer, the Docker zip and the Linux bundle.
- **main is ahead of the release** and already says version **0.3.1** in
  `package.json`. Merged since 0.3.0, not released yet:
  - normal GST on foreign-currency invoices, bills and credit notes
    (#56, examples MC71-MC83)
  - exports: contact country, Settings › Exports, the export flag
    (#57, EX1-EX15)
  - default sales and purchase tax codes on contacts (#58, EX16-EX25)
  - tax codes "Available on" sales, purchases or both (#59, TAO1-TAO12)
- Jess decided **not to release 0.3.1 yet** ("lots to do still").
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
search everything (#118, decision 373, no migration) are built. Next
numbers: tenant migration 0090, core migration 0007, decision 374. Still to do for Analytics: pivot tables (Perspective),
reading Excel files (then saving Excel report emails), and limiting DuckDB's
file access (`allowed_directories`).

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
- [ ] Holidays Act leave was planned in #60 but only clearly specified parts
      should be built; expect it to be partly refused. (Built in P8 on
      `claude/payroll-p8-leave`, with the refusals listed there; review and
      merge it, and decide the leave questions.)

## Things only Jess (or her computer) can do

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

## Open questions for Jess

Each "Questions for Jess" list in `docs/ACCOUNTING-EXAMPLES.md` has the full
wording. Still open:

**Multi-currency**
- Foreign sales on the **payments basis**: count a part payment at the
  invoice's rate or the payment's rate? (NetSuite's help doesn't say; refused
  for now.)
- **Refunds** of foreign credit treated like payments (refund rate against the
  credit's rate, difference to 7020): OK?
- **Stock on a foreign bill** valued at the bill's rate, never adjusted at
  payment: OK?
- A **free daily exchange rate feed** (e.g. RBNZ) into the rates list, or keep
  typing and pasting rates?
- Revaluation: round each document to cents on its own (as built)? Allow
  revaluing again before the last one reverses (refused now; NetSuite allows
  it from the earlier rate)?
- Should a printed USD tax invoice also show its GST in NZD?
- Build the **reverse charge** on imported services, or GST on foreign spend
  and receive money?

**Projects and CRM** (foreign currency)
- Chargeable expenses on a foreign project, and at which rate?
- Should a customer's currency be changeable while its projects or
  opportunities are empty or lost?
- Is refusing projects in currencies without cents (JPY, XPF) needed?

**Tax codes**
- Should drafts and repeating templates also stop a code's "Available on"
  from changing (now only defaults and settings do)?
- Should invoices and bills brought in from existing books be checked against
  "Available on"?

**GST**
- When the GST filing frequency changes, IRD sets the date the new frequency
  starts. Should Tohyee let you enter IRD's start date rather than working out
  the changeover itself?

**Bringing in existing books**
- Is a 0.05 rounding allowance on GST in open invoices and bills right?
- Bank opening balance as the ledger balance, with unpresented items entered
  as opening transactions (as in Xero)?
- Matching the old system's control accounts by name and re-coding: wanted?
- Contacts without customer/supplier columns default to both?

**Year end and period close**
- Can a bookkeeper close a month when every check passes, or only owners and
  admins?

**RDTI claim report** (R3, under RD42)
- Part-time R&D staff now earn credit from approved timesheets (P9, TS5);
  without a timesheet only 100% R&D allocations count. OK?
- Reimbursements on pay runs aren't counted anywhere: let them be tagged as
  materials later?
- Feedstock: record the output's value at year end so the part over it can
  be claimed?
- Exports keep the summary figures, not the file: keep the CSV too, for
  people with payroll access only?

**Timesheets** (P9, under TS11)
- Monday-to-Sunday weeks, or timesheets per pay period as Xero does?
- Viewers fill in their own timesheets: OK, or a "time only" role?
- Approvers can't change hours (NetSuite) but reject; or let them correct
  and approve (Xero)?
- Part-covered pay periods split by calendar days: or working days?
- Hourly pay from timesheets only when the whole period is covered, Ordinary
  time only: should extra hours become overtime?
- Should approved project hours also become project time (to invoice)?
- Build the reallocation of a posted pay to a late timesheet (RD22)?

**Payroll reports** (P10, under PREP8)
- FTE's standard week: 40 hours typed on the report; save one per
  organisation (or pay group)?
- Salaried staff count 1.0000 FTE (assumed): record their usual hours?
- FTE capped at 1 (45 hours = 1.0000): OK?
- Reimbursements left out of labour cost: agreed?
- Reports by pay date only: labour cost by period worked too?
- Pay runs approved before P9 show "R&D activity not recorded": work it out
  from the allocation they used, as the R&D claim does?
- Exports audited without figures: need a second permission too?

**Workforce budgets** (P11, end of the WB section)
- Part months: count a line starting mid-month by days?
- Follow later pay rate changes on the employee automatically?
- KiwiSaver employer minimum after 2026-27: a planned rate change, or typed?
- Budget on-costs too (holiday pay, ACC levies, overtime)?
- A "number of people" on a position line?
- Compare actuals by pay date (as now) or by period worked?

**Posting the leave liability** (end of the HL section): the four
questions were decided on 2 Oct 2026 (decisions 188-191) and built.

**Holidays Act leave** (P8): the 14 leave build questions were decided on
2 Oct 2026 at Jess's request (decisions 168-181, "Decided (leave build)" at
the end of the HL section). Still for Jess or IRD:
- Advance holiday pay over the 8% on leaving (decision 170): ask IRD how
  recovering it is taxed (less gross pay, or after tax; same or a later
  tax year). Refused until then.
- Back pay over periods with leave (decision 171): the law doesn't say
  whether a backdated rise changes holiday pay already paid. Refused.
- 2028's public holidays (decision 179): add them when Employment NZ
  publishes them, before any pay period touching 2028.

**Extra pays, back pay and final pays** (P12, end of the XP section)
- IRD's example 1 is a cent off its own steps ($10,366.39 vs $10,366.40):
  ask IRD, or follow the example?
- Short four-week windows (a new weekly employee's bonus) are refused: use
  IRD's "other circumstances" rule (× 13), or annualise the pays there are?
- A bonus on a final pay without a termination item: end-of-employment
  rule, or let the person running pay choose?
- Holiday pay on finishing typed until P8: enough, or should final pays
  wait for P8? (Since P8 Tohyee works it out where it keeps the leave.)
- Back pay for periods with holiday pay is refused: pay the ordinary time
  and flag the holiday pay instead?
- Hourly leavers start at 0 hours (starters get the full period): agreed?
- Separate extra-pay pay runs, and a higher rate on request: needed?

**Older lists still open** (see each section): repeating bills, quotes and
repeating invoices and printed documents, purchase orders, stock transfers,
budgets, expense claims, fixed assets, projects.

## How things are done (practical notes)

- **Merging**: Jess has said to merge PRs once checks pass (there are no users
  yet). Use merge commits, not squash.
- **Checks**: `npm run lint`, `npm run typecheck`,
  `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm test`
  (about 15 minutes for the full suite), `npm run build`. CI runs the same.
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

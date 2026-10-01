# Handover (1 October 2026)

Where Tohyee is up to, and what's left to do. This is for Jess and for the
next person or coding agent picking the work up. Read `AGENTS.md` and
`.github/copilot-instructions.md` first; they still apply.

## Where things stand

- **Latest release: v0.3.0** (1 Oct 2026), published with the Windows
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

## In progress (GitHub Copilot coding agents)

| Work | Issue | Draft PR | Branch | Tenant migration |
| --- | --- | --- | --- | --- |
| Not-for-profit module, first stage: opt-in fund tracking | #61 | #63 | `copilot/not-for-profit-module-development` | 0052 (renumbered) |
| Custom fields on CRM people, opportunities and prospects, with sections (CRM roadmap item 2, examples CRMF1-CRMF9) | none (Agents tab) | #67 | `copilot/extend-custom-fields-crm-records` | 0053 (renumbered); merge after #62 and #63 |
| Payroll P2: IRD payroll rates as dated data | #60 | none | `copilot/issue-60-ird-payroll-rates` | 0054 if needed. Restarted 1 Oct after the IRD sites were allowlisted |
| Payroll P7: Holidays Act leave worked examples (docs only) | #60 | #68 | `copilot/nz-payroll-stage-p7-holidays-act-leave` | none |
| Sales orders, stage 1: the document and invoicing from it (CRM roadmap item 12) | none (Agents tab) | not opened yet | `copilot/sales-orders-stage-1` | 0055 |
| Sales platform connections, stage 1: connector framework, Shopify customers and products (CRM roadmap items 27-28) | none (Agents tab) | not opened yet | `copilot/sales-platform-connections-stage-1` | 0056 |
| RDTI R1: R&D Tax Incentive worked examples and questions (docs only, RD1-RD27) | none (Agents tab) | draft | `copilot/rdti-stage-r1-plan-tracking` | none |

Next free tenant migration number: 0058 (0057 reserved for payroll P1b).

Merged: the CRM as its own app at `/crm`, with the Accounting ↔ CRM switcher
and the CRM Home (CRM roadmap item 1, example CRM10, #66, 1 Oct 2026).

CRM custom fields: decided by Jess (1 Oct 2026) that prospects only get the
fields someone deliberately turns on for prospects; existing customer fields
are not added to prospects automatically. A review of #67 found the first
version did add them (locking accounting fields when the CRM is off); Copilot
was asked to fix it on the PR.

CRM work waiting on custom fields: record types and page layouts, and the
Salesforce-style record page. Claude will build these once custom fields is
merged.

### Payroll: the plan (issue #60)

Jess wants payroll for complex businesses (1 Oct 2026). From her Datapay
experience: see each employee's department, split where their pay goes by %,
and split the parts of pay out for reports and budgets. Payroll reports must
only be run by certain people. Each item is its own branch and PR.

- [x] **P1 Employee records** (#62, migration 0051), merged 1 Oct 2026.
- [ ] **P1b Cost allocation, pay rate history and payroll access** (migration
      0057). Can start now.
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
- [ ] **P2 IRD payroll rates as dated data** (0054 if needed). Running.
- [ ] **P3 Pay runs**, now including:
      - **Pay items** (earnings, deductions, reimbursements, employer
        contributions), each with its own expense or liability account and
        its tax treatment from IRD's specification, so wages, overtime,
        allowances, bonuses, holiday pay, employer KiwiSaver and ESCT report
        separately.
      - Posting split by each employee's allocation (or a per-pay-item
        override), tagged with Department/Class/Location/project/R&D
        activity, so profit and loss and **budget vs actual by department**
        work from the existing budgets.
      - Draft → approve, with the approver different from the preparer when
        the organisation turns that on.
      Needs P1b and P2.
- [ ] **P4 Paying** wages and IRD. Needs P3.
- [ ] **P5 Payslips** (PDF and email). Needs P3.
- [ ] **P6 Payday filing file** for myIR. Needs P3.
- [ ] **P7 Holidays Act leave, plan** (#68). Running.
- [ ] **P8 Holidays Act leave, build** what P7 specifies and Jess approves,
      including leave liability by department. Needs P3 and P7.
- [ ] **P9 Timesheets**: hours by project, department or R&D activity
      (reusing project time tracking), approved by a manager, overriding the
      default split for the hours they cover. Time is stamped when entered,
      so it counts as contemporaneous for RDTI. Needs P3.
- [ ] **P10 Payroll reports** (payroll access only): labour cost by
      department, project, R&D activity and pay item; payroll summary and
      reconciliation to the ledger; headcount and FTE; employee earnings
      history; PAYE, KiwiSaver and student loan summaries. Needs P3.
- [ ] **P11 Workforce budgets**: budget wages by employee or position and
      month, feeding budgets by department (existing budgets). Needs P3.
- [ ] **P12 Back pay, extra pays and final pays** (bonuses under IRD's extra
      pay rules, retrospective rate changes, termination pays). Needs P3,
      and P8 for holiday pay on termination.

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

- [ ] **R1 Plan**: worked examples and questions for Jess, docs only.
      Written (RD1-RD27 and 21 questions in `docs/ACCOUNTING-EXAMPLES.md`,
      from IR1240 April 2026, read 1 Oct 2026); waiting for Jess.
- [ ] **R2 R&D activity register and tagging**: activities (core or
      supporting, linked core activity, approval reference, income year, in NZ
      or overseas); tag time, payroll costs (via P1b/P3/P9), bills, expense
      claims and fixed asset depreciation to activities with an eligible or
      ineligible category; GST never included; entries stamped when made.
      Needs R1 approved.
- [ ] **R3 RDTI claim report**: eligible expenditure by category and
      activity, overhead apportionment with its method, the overseas limit,
      the minimum check, the 15% credit, figures for the supplementary return,
      and reminders for the approval and return deadlines. Needs R2.

To do:

- [ ] Review each PR against the repo rules: worked examples with real
      numbers in `docs/ACCOUNTING-EXAMPLES.md` and a test for each; money only
      through `src/lib/money/decimal.ts`; IRD/XRB figures stored as dated
      data with sources; new tenant migrations numbered after 0050.
- [ ] Check the questions each PR lists for Jess, and answer or decide them.
- [ ] Holidays Act leave was planned in #60 but only clearly specified parts
      should be built; expect it to be partly refused.

## Things only Jess (or her computer) can do

- [ ] **Test on a real Windows computer**: install from TohyeeSetup, the
      server app, backups to OneDrive.
- [ ] **Akahu bank feeds** with a real Akahu app.
- [ ] **Email sending** with real accounts: Microsoft sign-in and Google
      sign-in. For Google, the app should be "In production" (Testing ends
      the connection after 7 days) or "Internal" for Workspace.
- [ ] **Tohyee address relay** (the no-sign-up phone access option): needs a
      domain, Cloudflare's written OK, and setting up the Worker in `relay/`
      (see `relay/README.md`).
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

**R&D Tax Incentive** (21 questions in the RDTI section; the main ones)
- Does exactly $50,000.00 qualify (the Act says "or more", IR1240 p 72
  "must exceed")? Is the minimum tested after the 10% overseas limit?
- Book depreciation (as Tohyee has) or tax depreciation, and the new DI 5
  investment boost?
- Does a default payroll % split without a timesheet count as a time
  record? Should a late timesheet change R&D figures after the pay run?
- Store IRD's approval reference (typed, with the letter attached, marked
  "not checked with IRD")?

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

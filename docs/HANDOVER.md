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
| NZ payroll, stage 1: employee records only (see the payroll list below for the rest) | #60 | #62 | `copilot/build-nz-payroll-tohyee` | 0051 |
| Not-for-profit module, first stage: opt-in fund tracking | #61 | #63 | `copilot/not-for-profit-module-development` | 0052 (renumbered) |
| Custom fields on CRM people, opportunities and prospects, with sections (CRM roadmap item 2, examples CRMF1-CRMF9) | none (Agents tab) | not opened yet | `copilot/extend-custom-fields-crm-records` | 0053 (renumbered) |
| Sales platform connections, stage 1: connector framework, Shopify customers and products (examples SPC1-SPC10; not tried against a real store) | none (Agents tab) | #70 | `copilot/sales-platform-connections-stage-1` | 0056 |

Merged: the CRM as its own app at `/crm`, with the Accounting ↔ CRM switcher
and the CRM Home (CRM roadmap item 1, example CRM10, #66, 1 Oct 2026).

The CRM custom fields brief makes CRM custom fields available whenever the
CRM module is on, even with Advanced features off. Jess to confirm.

CRM work waiting on custom fields: record types and page layouts, and the
Salesforce-style record page. Claude will build these once custom fields is
merged.

### Payroll: what's left after #62

#62 only adds employee records (pay basis, frequency, tax code, KiwiSaver and
student loan status, dates; IRD number and bank account encrypted). It
calculates nothing. The rest of #60, in order, each its own branch and PR:

- [ ] **P1 Review and merge #62** (employee records, migration 0051).
- [ ] **P2 IRD payroll rates as dated data**: PAYE brackets and tax codes,
      ACC earners' levy rate and maximum, student loan rate and threshold,
      KiwiSaver rates, ESCT brackets, each with its tax year and IRD source
      (IR340/IR335, the payroll calculation specification). No pay runs yet.
      Can start now; reserve migration 0054 if it needs a table.
- [ ] **P3 Pay runs**: draft → approve; earnings (ordinary time, overtime,
      allowances, bonuses) and deductions; PAYE incl. ACC earners' levy,
      student loan, KiwiSaver employee and employer, ESCT. Approving posts one
      journal (wages expense; PAYE, KiwiSaver, student loan and ESCT payable to
      IRD; net wages payable). Needs P1 and P2.
- [ ] **P4 Paying**: pay net wages from a bank account or match a bank line;
      pay IRD. Needs P3.
- [ ] **P5 Payslips**: PDF and email, using the existing document PDF and
      email pieces. Needs P3.
- [ ] **P6 Payday filing file**: the employment information file for myIR
      upload, plus new and departing employee details, to IRD's current file
      specification (cited). No IRD gateway connection. Needs P3.
- [ ] **P7 Holidays Act leave, plan first**: worked examples and questions
      for Jess (annual leave, sick leave, public holidays, alternative days,
      average weekly earnings vs ordinary weekly pay) in
      `docs/ACCOUNTING-EXAMPLES.md`, docs only. Can start now.
- [ ] **P8 Holidays Act leave, build** only what P7 specifies and Jess
      approves. Needs P3 and P7.

P2 and P7 can run in parallel now; P4, P5 and P6 can run in parallel once P3
is merged. Give each its own migration number up front.

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

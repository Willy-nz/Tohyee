# Accounting worked examples

These are the acceptance examples for posting and stock behaviour. Each one
has real numbers and a matching automated test, so "approved" means "a test
proves it". Test names start with the example IDs they cover:

- `tests/unit/decimal.test.ts` (R1, R3), `tests/unit/costing.test.ts`
  (W1-W12 and ST10, ST11, pure costing maths) and `tests/unit/invoice-amounts.test.ts`
  (I1-I6 and B1-B4, pure invoice and bill maths; CP1, CP2 and CP4 paid
  status; CN2, CN10 credit note maths and CN2-CN4, CN6-CN8 credit and paid
  status) and `tests/unit/gst-return.test.ts` (G1, G2, G5-G9, G11, G12,
  G20, G21, pure GST return maths, periods, shares and basis changes; GP1,
  GP2, GP4, the GST period setting) and
  `tests/unit/item-pricing.test.ts` (IT2, IT4-IT6, pure item price and
  unit maths)
- `tests/integration/ledger.test.ts` (R2, R4, R5, L1-L4, C1-C5, C7, D1, D2,
  P1-P3), `tests/integration/journal-drafts.test.ts` (MJD1-MJD9, not yet
  approved), `tests/integration/inventory-fx.test.ts` (W1, W2, W7, W8, C6, D3,
  F1-F7), `tests/integration/auth-routes.test.ts` (D1, D2 over HTTP),
  `tests/integration/contacts.test.ts` (D1, D2 for contacts),
  `tests/integration/invoices.test.ts` (I1-I9, D1, D2 for invoices),
  `tests/integration/customer-payments.test.ts` (CP1-CP8),
  `tests/integration/customer-overpayments.test.ts` (OP1-OP11),
  `tests/integration/multi-payments.test.ts` (MP1-MP10, SMP1-SMP6),
  `tests/integration/bills.test.ts` (B1-B9, SPT1, SPT2, SPT5, D1, D2 for bills) and
  `tests/integration/supplier-payments.test.ts` (SP1-SP8) and
  `tests/integration/credit-notes.test.ts` (CN1-CN12) and
  `tests/integration/supplier-credit-notes.test.ts` (SCN1-SCN12) and
  `tests/integration/gst-returns.test.ts` (G1-G9) and
  `tests/integration/gst-bases.test.ts` (G10-G22) and
  `tests/integration/record-extras.test.ts` (NF1-NF14) and
  `tests/integration/home.test.ts` (H1-H4) and
  `tests/integration/custom-reports.test.ts` (CR1-CR10) and
  `tests/integration/tracking.test.ts` (TC1-TC10) and
  `tests/integration/custom-fields.test.ts` (CS1-CS3, CF1-CF10) and
  `tests/integration/salespeople.test.ts` (SR1-SR8) and
  `tests/integration/customers.test.ts` (RC1-RC12) and
  `tests/integration/items.test.ts` (IT1-IT9) and
  `tests/integration/stock.test.ts` (ST1-ST12) and
  `tests/integration/crm.test.ts` (MOD1, CRM1-CRM10) and
  `tests/integration/crm-mail.test.ts` (MAIL1-MAIL9) and
  `tests/integration/sales-platforms.test.ts` (SPC1-SPC10) and
  `tests/integration/sales-platform-orders.test.ts` (SPC11-SPC23, not yet
  approved) and
  `tests/integration/crm-custom-fields.test.ts` (CRMF1-CRMF12, not yet
  approved) and
  `tests/integration/reports-ledger.test.ts` (AGP1-AGP3, ATX1-ATX5,
  JR1-JR3) and `tests/integration/gst-audit.test.ts` (GA1-GA4) and
  `tests/integration/customer-statements.test.ts` (CST1-CST5) and
  `tests/integration/quotes.test.ts` (QT1-QT8) and
  `tests/integration/sales-orders.test.ts` (SO1-SO12) and
  `tests/integration/repeating-invoices.test.ts` (RI1-RI10) and
  `tests/integration/repeating-bills.test.ts` (RB1-RB12, SPT3) and
  `tests/integration/printed-documents.test.ts` (PD1-PD8) and
  `tests/integration/purchase-orders.test.ts` (PO1-PO9, SPT4) and
  `tests/integration/stock-transfers.test.ts` (TR1-TR6) and
  `tests/integration/budgets.test.ts` (BU1-BU8) and
  `tests/integration/expense-claims.test.ts` (EC1-EC12) and
  `tests/integration/expense-mileage.test.ts` (MI1-MI7) and
  `tests/integration/bills-inbox.test.ts` (BI1-BI7, DU1-DU5) and
  `tests/integration/online-payments-stripe.test.ts` (PN1-PN12) and
  `tests/integration/online-payments-paypal.test.ts` (PPN1-PPN10) and
  `tests/integration/fixed-assets.test.ts` (FA1-FA14) and
  `tests/integration/projects.test.ts` (PJ1-PJ13) and
  `tests/integration/bank-quick.test.ts` (BK17-BK25) and
  `tests/integration/bank-split.test.ts` (BK26-BK28) and
  `tests/integration/bank-foreign.test.ts` (FXB1-FXB11) and
  `tests/integration/multi-currency.test.ts` (MC1-MC13) and
  `tests/integration/multi-currency-settlements.test.ts` (MC14-MC30) and
  `tests/integration/import.test.ts` (IM1-IM16) and
  `tests/integration/tax-available-on.test.ts` (TAO1-TAO5, TAO7-TAO12) and
  `tests/integration/period-close.test.ts` (YE1-YE4, TB1-TB4, PC1-PC12,
  GP3, GP5, GP6) and `tests/integration/payroll-employees.test.ts` (PE1, PE2)
  and `tests/integration/payroll-allocation.test.ts` (PE3, PE5-PE13)
  and `tests/integration/payroll-pay-runs.test.ts` (PRUN1-PRUN11, not yet
  approved) and `tests/integration/payroll-payments.test.ts` (PPAY1-PPAY12,
  not yet approved) and `tests/integration/payroll-bank-files.test.ts`
  (PBF1-PBF7, not yet approved) and `tests/integration/payroll-payslips.test.ts`
  (PSLIP1-PSLIP6, not yet approved) and
  `tests/integration/payroll-timesheets.test.ts` (TS1-TS11, not yet
  approved), all against
  a real PostgreSQL database; `tests/unit/ageing.test.ts` has the pure
  ageing maths (AGP1, CST1), `tests/unit/repeating-schedule.test.ts` the
  repeating dates (RI1, RI5, RI6), `tests/unit/repeating-bill-rules.test.ts`
  the repeating bill numbers and due dates (RB1-RB3, RB11, RB12) and `tests/unit/tax-invoice.test.ts` what
  a printed document is headed and shows (QT5, PD3-PD7), and
  `tests/unit/fixed-asset-depreciation.test.ts` the depreciation and
  disposal maths (FA3, FA4, FA6-FA10), and `tests/unit/project-amounts.test.ts`
  the project time and markup maths (PJ3-PJ7), and
  `tests/unit/foreign-currency.test.ts` the conversion, carrying value,
  rate and file currency pieces of FXB2-FXB10, and
  `tests/unit/import-fields.test.ts` the import column matching (IM2-IM5, IM16), and
  `tests/unit/tax-available-on.test.ts` the tax code pickers and starting codes
  by side (TAO2-TAO4, TAO6, TAO8),
  `tests/unit/custom-field-sections.test.ts` the grouping of fields into
  sections and which switch a field needs (CRMF1, CRMF6, CRMF8), and
  `tests/unit/payroll-rates.test.ts`,
  `tests/unit/payroll-calculations.test.ts` and
  `tests/unit/payroll-ird-tables.test.ts` IRD's payroll rates and
  calculations (PR1-PR16), and `tests/unit/payroll-allocation.test.ts`
  the payroll % split (PE3-PE5), and `tests/unit/payroll-pay-calculation.test.ts`
  one employee's pay in a pay run (PRUN1-PRUN4, PRUN8), and
  `tests/unit/payroll-ird-due-dates.test.ts` IRD payroll periods and due
  dates (PPAY4, PPAY9), and `tests/unit/payroll-bank-files.test.ts` the
  bank direct credit files byte for byte (PBF1-PBF4, PBF6), and
  `tests/unit/payroll-payslips.test.ts` the payslip's masked account, tax
  year and year to date (PSLIP1, PSLIP2), and
  `tests/unit/payroll-timesheets.test.ts` timesheet weeks, weights, splits
  and lateness (TS2, TS3, TS5-TS8), and `tests/unit/sales-platforms.test.ts`
  the webhook signature check, Shopify record shapes and which value is kept
  (SPC2, SPC3, SPC5, SPC6, SPC8), and `tests/unit/sales-platforms-screen.test.ts`
  the sync log on the settings screen (SPC10), and
  `tests/unit/sales-platform-orders.test.ts` Shopify orders, refunds and
  payouts worked out into Tohyee lines (SPC11-SPC17)

## NZ payroll — employee records (examples not yet approved by Jess)

This first stage follows [NetSuite's employee payroll record](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N921988.html) for keeping payroll details on the employee, and [Xero's NZ employee setup](https://central.xero.com/s/article/Set-up-a-fixed-term-employee) for salary or hourly pay details. This stage stores employee details only; it does not calculate or post payroll.

| ID | Employee details | Result |
| --- | --- | --- |
| PE1 | Add Aroha Ngata, starting 1 April 2026, fortnightly salary of NZD 70,000.00 a year, tax code M, student loan, and her IRD and bank details. Record the current KiwiSaver status and the employee and employer rates supplied for her. | Her payroll profile is saved; the IRD number and bank account are encrypted in the organisation database. No tax or net-pay amount is calculated and no journal is posted. |
| PE2 | Set Aroha's finish date to 30 September 2026, then archive her. | Her profile remains in the database and audit trail, is hidden from the active list and can be restored; it is never deleted. |

The rates in PE1 are copied from the employee's current instructions; see [IRD's KiwiSaver employer guidance](https://www.ird.govt.nz/kiwisaver/kiwisaver-employers). This example does not prescribe KiwiSaver rates or calculate deductions. Entering an employee is not authority to run payroll.

### Not supported yet (refused rather than guessed)

- Pay calculations, approval and journal posting; payment to employees or Inland Revenue; and payslips. The current sources to verify before building calculations are [IRD's 2026 IR340 PAYE tables](https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir300---ir399/ir340/ir340-apr-2026.pdf), [Payroll Calculations and Business Rules](https://www.ird.govt.nz/employing-staff/payroll-calculations-and-business-rules), and [Employer's guide IR335](https://www.ird.govt.nz/forms-guides).
- Payday filing exports. Use IRD's [file upload service](https://www.ird.govt.nz/digital-service-providers/services-catalogue/returns-and-information/payday-filing/payday-filing-through-file-upload-services) and its [2026–27 file upload specification](https://www.ird.govt.nz/-/media/project/ir/home/documents/digital-service-providers/iir-file-upload-specification/payday-filing-file-upload-specification-2026-2027.pdf); the exact required records and output layout have not yet been verified against the specification.
- Holidays Act leave calculations. Annual leave, sick leave, public holidays, alternative days, ordinary weekly pay and average weekly earnings need Jess-approved worked examples and decisions first.
- Questions for Jess: which pay frequencies and KiwiSaver status values are needed in practice; which payroll bank account and payable/expense accounts to use; and how payroll corrections should fit the period-close workflow.

## NZ payroll — cost allocation, pay rates, job details and payroll access (examples not yet approved by Jess)

Stage P1b. Each employee gets a default **cost allocation** (where their pay
is charged, split by %), a **pay rate history**, job details, and payroll
data is only open to people an admin has given **payroll access**. Nothing
here posts to the ledger or calculates pay; pay runs (P3) will use the
allocation and rate in effect on each date.

Sources followed (NetSuite first, then Xero Payroll NZ where NetSuite has no
answer). The agent sandbox couldn't open docs.oracle.com or Xero Central, so
these were found by web search and not read in full; check them before
approving:

- Splitting pay by % across Department, Class and Location: NetSuite's
  [Labor Expense Allocation](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_159118277665.html) and
  [Classifying Individual Paycheck Lines](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1543951211.html)
  (paycheck lines take the employee's Department, Class and Location by
  default). NetSuite's percentage allocation schedules
  ([Creating Expense Allocation Schedules](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1483674.html))
  require the percentages to total 100%. Neither page says how leftover
  cents are shared out; the largest-remainder rule below is ours (question
  for Jess).
- Effective-dated changes kept as history: NetSuite's
  [Effective Dating for Employee Information](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_4659236711.html)
  (an effective date and a reason, with a change log) and
  [Compensation Tracking](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_157489167446.html); Xero's
  [pay and work pattern effective date](https://central.xero.com/s/article/Change-an-employee-s-salary-and-wages-details).
- Job title and supervisor (reports-to): NetSuite's
  [Human Resources information on the employee record](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N895403.html).
- Pay frequency and employee groups: NetSuite's
  [Including an Employee in Payroll](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N921988.html) (pay
  frequency on the employee) and [Creating a Payroll Batch](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N947366.html)
  (run per pay frequency); Xero's [pay frequencies](https://central.xero.com/0/article/Add-a-pay-calendar)
  and [employee groups for payroll tracking](https://central.xero.com/s/article/Payroll-tracking-in-Xero).
- Payroll access separate from accounting roles: NetSuite's
  [Advanced Employee Permissions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_1494536002.html) (an
  "Employee Compensation" permission apart from the rest of the employee
  record) and Xero's [user role access to payroll](https://central.xero.com/s/article/User-role-access-to-payroll-in-Xero)
  (only payroll admins and advisers see employee pay and bank details).

Tests: `tests/unit/payroll-allocation.test.ts` (PE3, PE4, PE5),
`tests/unit/payroll-access-screen.test.ts` (PE10's message) and
`tests/integration/payroll-allocation.test.ts` (PE3, PE5-PE13).

### Cost allocation

An allocation has an **effective-from date** and one or more lines. Each line
has a percentage (more than 0, at most 2 decimal places) and any of a
Department, Class and Location value (the tracking categories), a project
and an R&D activity from the RDTI register (stage R2: an active activity in
the register; an unknown or archived one is refused). A line needs at least
one of the Department, Class, Location, project or R&D activity. The
allocation only records where pay is charged: for the R&D claim (stage R3), a
default split counts as R&D only when the employee's allocation is 100% R&D,
and otherwise needs a time record (decision 34; RD7). Two lines can't
have exactly the same Department, Class, Location, project and R&D activity.
The lines must total exactly **100.00%**. Saving a new allocation never
changes an earlier one: the allocation in effect on a date is the one with
the latest effective-from date on or before it (if two were saved for the
same date, the later one saved). The database refuses an allocation that
doesn't total 100.00% and refuses changing or deleting a saved one.

**Splitting an amount** by the allocation: each line's exact share (amount ×
% ÷ 100) is cut to whole cents (towards zero). The cents left over (fewer
than the number of lines) go one each to the lines with the largest part
cut off; when two lines tie, the earlier line gets the cent. So the parts
always add back to exactly the amount. A negative amount is split as if it
were positive and each part made negative, so a reversal mirrors the
original exactly.

| ID | Allocation and amount | Result |
| --- | --- | --- |
| PE3 | Aroha Ngata from 1 April 2026: 60% Department Sales, Location Wellington; 40% Department Operations, Location Auckland. Split **$1,234.57**. | Exact shares 740.742 and 493.828. Cut to cents: 740.74 + 493.82 = 1,234.56, so 1 cent is left. The 40% line had the larger part cut off (0.008 against 0.002), so it gets the cent: **Sales 740.74, Operations 493.83**, total 1,234.57. Split **−$1,234.57** (a reversal): **−740.74 and −493.83**. |
| PE4 | Rounding cents: 33.33% / 33.33% / 33.34% of **$10.00**; 50% / 50% of **$0.01**; 33.33% / 33.33% / 33.34% of **$100.00**. | 3.333, 3.333, 3.334 cut to 3.33 each (9.99); the third line had the most cut off: **3.33, 3.33, 3.34**. Half a cent each ties, so the first line gets it: **0.01 and 0.00** (rounding each half up would give 0.02). 33.33, 33.33, 33.34 are exact: **33.33, 33.33, 33.34**, nothing left over. |
| PE5 | Lines of 60% and 30% (90%); lines of 60% and 50% (110%); a line of 0%; a line of 33.333%; a 100% line with no Department, Class, Location or project; two 50% lines both Department Sales. | All refused: "The allocation lines total 90.00%. They must total exactly 100.00%." (and 110.00%); a 0% line, a third decimal place, an empty line ("Line 1 needs a Department, Class, Location, project or R&D activity"), an R&D activity not in the register ("Line 1: that R&D activity wasn't found") or archived ("Line 1: C1 is archived") and a repeated line ("Line 2 is the same as line 1") are refused too. Nothing is saved. |
| PE6 | Aroha is 100% Department Sales from 1 April 2026. On 20 September 2026 she moves to Operations from **15 September 2026** (mid-month): a new allocation, 100% Operations, effective 15 September 2026. | The allocation in effect on 1 May and 14 September 2026 is still **100% Sales**; on 15 September 2026 and later it's **100% Operations**. Both stay in her history, oldest first. Her primary department in the employee list (the department of the biggest line in effect today) is Operations. How a pay period that spans the move is charged is a P3 question (below). |

### Pay rate history

| ID | Rate changes | Result |
| --- | --- | --- |
| PE7 | Aroha starts on 1 April 2026 on a salary of **$70,000.00** a year (PE1), which becomes her first pay rate, effective 1 April 2026. On 20 September 2026 she's given **$74,000.00** a year from 1 October 2026, with the reason "Annual review". On 15 December 2026 she moves to **$38.50 an hour for 37.5 hours a week** from 1 January 2027. | Her rate on 20 September and 30 September 2026 is $70,000.00; on 1 October 2026, $74,000.00; on 1 January 2027, $38.50 an hour, 37.5 hours a week. Her current rate is the one in effect today. All three stay in her history. Saving another rate for 1 October 2026 (to correct a typo) replaces the earlier one from that date; both stay in the history. A rate before her start date, a zero rate, or a salary with an hourly rate is refused. The audit log records that a rate was added and from when, never the amount. |

### Job details, pay groups and employee groups

| ID | Details | Result |
| --- | --- | --- |
| PE8 | Pay groups "Weekly wages" (weekly) and "Monthly salaries" (monthly); employee groups "Wellington office" and "Field staff". Aroha (fortnightly) is given the job title "Payroll officer", reports to Mere Tane, and joins employee group "Wellington office". She's then put in pay group "Monthly salaries". | Job title, reports-to and employee group are saved. "Monthly salaries" is **refused** because her pay frequency is fortnightly ("Aroha is paid fortnightly but Monthly salaries is monthly"). Changing her to monthly in the same save puts her in it. An employee can't report to themselves or to someone who (directly or further up) reports to them. A pay group's frequency can't change while employees are in it. Groups are archived, never deleted. |

### Payroll access

Payroll access is a separate permission, not a role: an admin (or owner)
gives it to, or takes it from, named members of the organisation. Without
it, nobody (admins and owners included) can see or change employees' pay,
allocations, rate history, IRD numbers or bank accounts, and later pay runs
and payroll reports. Having it also needs the bookkeeper role or higher.
It's kept in the organisation's own database against the person's user ID,
and every grant and removal goes in the organisation's audit log with who
did it and when.

| ID | What happens | Result |
| --- | --- | --- |
| PE9 | Jess creates the organisation (or it's upgraded to this version); she's its first owner. Mere is an admin, Ben a bookkeeper. | **Jess has payroll access** from the start, recorded in the audit log as given by "system". Mere and Ben don't, even though Mere is an admin. |
| PE10 | Ben (bookkeeper, no payroll access) opens Payroll › Employees, and tries the employee, pay rate, allocation and group APIs. | He sees "You need payroll access to see payroll. Ask an admin to give it to you in Settings › Payroll access." and no data; every payroll API answers 403 with that message, for reading and changing. |
| PE11 | Mere (admin) opens Settings › Payroll access and gives it to herself, then to Ben. Later she removes Ben's. Ben tries to give himself access. A viewer is given access. | Mere and then Ben can see payroll once given it; the audit log shows "payroll access given" to each, by Mere, with the time. After removal Ben is refused again (PE10), and the audit log shows it. Ben can't give access (admins only, 403). Giving it to a viewer is refused ("needs the bookkeeper role or higher"). Removing access from the last member who has it (and the bookkeeper role or higher to use it) is refused, so there's always someone. |
| PE12 | Ben, who has payroll access, is removed from the organisation and added again later. | When he's added again **he has no payroll access** until an admin gives it to him again; the removal is in the audit log. |
| PE13 | Ben, who has payroll access, is moved from bookkeeper to viewer and later back to bookkeeper; separately, he is removed from the organisation. | Moving him below bookkeeper or removing him **takes his payroll access away at once**, with the reason in the audit log, so moving him back doesn't bring it back; an admin has to give it again. Trying to make a change you're not allowed to (an admin removing an owner) changes nothing, including payroll access. |

No IRD number, bank account or pay amount is ever written into an audit
event: allocation events record the effective date and the percentages,
rate events the effective date and pay basis.

### Not supported yet (refused rather than guessed)

- Choosing an R&D activity on the allocation screen: the API accepts one
  (RDTI stage R2), but the screen doesn't offer it yet.
- Allocations by pay item (e.g. overtime to a different department) and
  timesheets overriding the default split: stages P3 and P9.
- Changing or deleting a saved allocation or pay rate: save a new one with
  the same effective date instead.

### Questions for Jess (allocation, pay rates and payroll access), decided

Decided on 2 Oct 2026: decisions 225-233 in `docs/DECISIONS.md`. What was asked is kept below.

- A pay period that spans an allocation change (PE6, a monthly pay with a
  move on 15 September): charge the whole pay by the allocation in effect on
  the period's end date, its pay date, or split it by days in each part?
- Once pay runs exist, should an allocation or rate dated before the last
  posted pay run be refused, or treated as back pay (P12)?
- One employee group per employee (as built, like Xero's employee group), or
  several groups each?
- Should a pay group set the employee's pay frequency (and later their pay
  calendar), rather than having to match it as built?
- Should removing the last person with payroll access be allowed if an
  owner does it (it's refused as built)?
- Should a viewer with payroll access be able to read payroll (refused as
  built: payroll needs bookkeeper as well)?
- Leftover cents in a split go to the lines with the largest part cut off,
  the earlier line first on a tie (PE3, PE4). Is that right, or should they
  always go to the biggest line, or the last line?
- Should a line be allowed with no Department, Class, Location or project
  (refused as built, PE5)?
- When someone with payroll access is moved down to viewer, should their
  access be removed then (as built it stays, unused, until an admin removes
  it or they're moved back up)?

If you change behaviour, change the example, the test and the code together.
If a scenario isn't covered here, stop and ask for a decision before coding it.

All amounts are NZD with 2 decimal places unless stated.

## Money and rounding

- **R1** Amounts are exact decimals, never floating point:
  `0.1 + 0.2` is exactly `0.3`.
- **R2** Posted amounts have exactly the currency's minor units. A journal
  line of `3.333` NZD is refused ("at most 2 decimal places"). Amounts are
  stored as e.g. `115.00`.
- **R3** Rounding is half away from zero, applied once, at the posting
  boundary: `2.345 -> 2.35`, `-2.345 -> -2.35`, `10 / 3 -> 3.33`,
  `20 / 3 -> 6.67`.
- **R4** Journals must balance exactly: `Dr 10.00 / Cr 9.99` is refused.
  PostgreSQL also refuses an unbalanced journal at commit.
- **R5** Journals are posted in the base currency only. A `USD` journal in an
  `NZD` organisation is refused. (Lines on foreign-currency accounts carry
  their foreign amount as well: FXB1-FXB11.)

## Weighted-average stock

Value going out = quantity x carrying value / quantity on hand, computed
exactly and rounded once to cents. Taking out everything that's left takes the
whole remaining value, so nothing is ever left over at zero stock. Stock value
always equals the inventory account to the cent.

| ID | Movements | Result |
| --- | --- | --- |
| W1 | Receive 3 @ 3.33 (9.99); sell 1 | Cost of sale **3.33**; 2 left worth **6.66** |
| W2 | Receive 999 @ 2.57 (2,567.43); sell 1 | Cost of sale **2.57** |
| W3 | Receive 1 @ 3, 1 @ 3, 1 @ 4 (10.00); sell 1, 1, 1 | **3.33, 3.34, 3.33**; 0 left worth **0.00** |
| W4 | Receive 3 @ 3.333333 (10.00); sell 1, then 2 | **3.33**, then the remaining **6.67** |
| W5 | Receive 10 @ 5 and 10 @ 7 (120.00); sell 5 | Average 6.00; cost of sale **30.00**; 90.00 left |
| W6 | Receive 2.5 kg @ 4 (10.00); sell 0.75 kg | Cost of sale **3.00**; 1.75 kg left |
| W7 | Receive 2; sell 3 | **Refused** (stock can't go negative); selling with nothing on hand is refused too |
| W8 | Receive 10 @ 5; sell 4 (20.00); receive 6 @ 8; customer returns 1 of the 4 | Restocked at the **original** cost: **5.00** |
| W9 | A sale took 3 units for 10.00; returns of 1 then 2 | **3.33** then **6.67** (adds back exactly 10.00); returning more is refused |
| W10 | Receive 4 @ 10 (40.00); landed cost 6.00; sell 1 | Stock worth 46.00; cost of sale **11.50** |
| W11 | Receive 3 @ 10; stocktake -1; stocktake +2 @ 4 | Write-off **10.00** at average; found stock **8.00**; 28.00 left |
| W12 | Receive 0.001 @ 1.00 | **Refused**: value rounds to 0.00 |

Quantities allow up to 4 decimal places, unit costs up to 6.

### Not supported yet (refused rather than guessed)

- **Backdating**: a stock movement dated before the item's latest movement is
  refused with a clear message. Supporting it means re-costing every later
  movement and adjusting their journals; that is designed but not built.
- **Negative stock**: refused unless the organisation allows it (ST9-ST12).
- **Late landed cost allocated partly to already-sold stock**: landed cost is
  added to the stock currently on hand only.

## Stock tracking (items on documents)

Approved by the owner (30 Sep 2026) as ST1-ST12. Stock items (IT1) on bills,
invoices and credit notes move stock, costed at weighted average (W1-W12),
in the same transaction as the document's journal. GST 15%. Accounts: 1100
accounts receivable, 1400 inventory, 2000 accounts payable, 2100 GST, 4000
sales, 5000 cost of goods sold.

- **Per location**: the weighted average is kept per item and **location**.
  A location is a value of the Location tracking category (TC1); a stock
  line's location is its Location tag. Once the Location category has any
  values, every stock line needs one to be approved; until then (or in an
  organisation that never uses locations) each item has **one default
  pool**. Stock entered on the Stock screen can name a location too.
- **Stock lines on bills and supplier credit notes** go to the inventory
  account (1400), and nothing else can: a stock item on another account, or
  a non-stock line on 1400, is refused, and so are manual journals and
  corrections that touch 1400, and stock movements to any other account. So
  stock always equals account 1400 to the cent.
- **Cost of sales** is posted when the invoice is approved, dated the
  invoice date (there's no fulfilment yet, even for sales orders: SO3), in the
  invoice's own journal: Dr 5000 / Cr 1400, the 5000 line tagged like the
  invoice line.
- **Units** (IT5): stock is kept in the item's base unit. **Kits** (IT7):
  selling a kit takes each stock item in it out of stock; its income goes to
  the kit's income account.
- **Voiding** puts stock back exactly: an invoice's stock comes back at the
  value it went out at, and a bill's goes back out at the value it came in
  at. A bill (or sales credit note) whose stock has moved since can't be
  voided yet (that needs re-costing later movements). Backdating is refused
  as before.
- **Negative stock** is a setting per organisation, **off** by default.

| ID | What happens | Journal |
| --- | --- | --- |
| ST1 | Bill: 10 Widgets @ 5.00 + GST into Dunedin | Dr 1400 **50.00** / Dr 2100 **7.50** / Cr 2000 **57.50**. Dunedin holds 10 worth **50.00** |
| ST2 | After ST1, invoice: 4 Widgets @ 12.00 + GST from Dunedin | Dr 1100 **55.20** / Cr 4000 **48.00** / Cr 2100 **7.20**, and Dr 5000 **20.00** / Cr 1400 **20.00**, all on the invoice date. Dunedin: 6 worth 30.00 |
| ST3 | Dunedin 10 @ 5.00 and Auckland 10 @ 7.00; invoice 1 Widget @ 12.00 from Auckland | Cost of sales **7.00** (not 6.00): Dr 5000 7.00 / Cr 1400 7.00. Auckland 9 worth 63.00; Dunedin unchanged |
| ST4 | Void ST2's invoice | Dr 4000 48.00 / Dr 2100 7.20 / Cr 1100 55.20 and Dr 1400 **20.00** / Cr 5000 **20.00** on the void date. Dunedin back to 10 worth 50.00 |
| ST5 | After ST2, bill 6 more @ 8.00 (Dunedin 12 worth 78.00, average 6.50); credit note returning 1 of ST2's 4, from that invoice, @ 12.00 + GST | Dr 4000 12.00 / Dr 2100 1.80 / Cr 1100 13.80 and Dr 1400 **5.00** / Cr 5000 **5.00** (the original 5.00, not 6.50). Dunedin 13 worth 83.00. Returning 4 more from that invoice is refused (only 3 left); the invoice can't be voided until the credit note is; voiding the credit note takes the unit out again at 5.00 |
| ST6 | Invoice and bill lines for a service and a non-stock item | No 1400 or 5000 lines; no stock moves |
| ST7 | Widget has "Box of 12"; after a bill of 30 each @ 5.00, invoice 2 Box of 12 | 24 each leave stock: Dr 5000 **120.00** / Cr 1400 **120.00**; 6 left worth 30.00 |
| ST8 | Gift set = 1 Widget + 2 Candles (Widget 5.00, Candle 2.00 each on hand); invoice 1 Gift set @ 30.00 + GST | Dr 1100 34.50 / Cr 4100 **30.00** (the kit's income account) / Cr 2100 4.50, and Dr 5000 **9.00** / Cr 1400 **9.00**; 1 Widget and 2 Candles leave stock |
| ST9 | Negative stock off; 2 on hand; invoice 3 | Approval **refused** ("Stock can't go negative"); the draft stays a draft and no number is used |
| ST10 | Negative stock on; 2 on hand worth 10.00; invoice 3, then bill 4 @ 6.00 | Invoice: Dr 5000 **15.00** / Cr 1400 **15.00**, leaving **-1 worth -5.00**. Bill: Dr 1400 24.00 / Dr 2100 3.60 / Cr 2000 27.60 and Dr 5000 **1.00** / Cr 1400 **1.00** on the bill date, leaving **3 worth 18.00** |
| ST11 | Negative stock on; item never received here, purchase price 4.00; invoice 2 | Costed at 4.00: Dr 5000 **8.00** / Cr 1400 **8.00**, leaving -2 worth -8.00. With no purchase price it's **refused** ("no cost to use for it") |
| ST12 | After ST10's invoice (before the bill) turn negative stock off | **Refused** while anything is below zero; allowed once the bill has brought it back to 3 |

- **ST10 rule**: stock coming in while below zero first fills the shortfall;
  the filled units' share of what came in, less the value they went out at,
  goes to cost of sales on the receipt's date. If it doesn't fill the whole
  shortfall, the stock value moves by the issued value of the units filled
  and the rest goes to cost of sales. With nothing on hand, stock going out
  is costed at the last cost it came in at there, else the item's purchase
  price (ST11); already below zero, at the current average.
- **Supplier credit notes** returning stock take it out at the location's
  average (W's supplier return); the line's net amount is credited to 1400,
  and any difference between it and the stock's value goes to cost of
  sales. After ST5 (the credit note voided, Dunedin 12 worth 78.00), a
  supplier credit note for 2 Widgets @ 8.00 + GST posts Dr 2000 **18.40** /
  Cr 1400 **16.00** / Cr 2100 **2.40**, and Dr 1400 **3.00** / Cr 5000
  **3.00** (they were carried at 6.50 each), leaving 10 worth 65.00.
- **Transfers between locations**: see "Stock transfers between locations"
  (TR1-TR6, not yet approved by Jess).
- **Stock equals the ledger**: across ST1-ST11 the stock report's total
  equals account 1400 on the trial balance, to the cent (tested).
- **Foreign-currency documents**: stock is valued in NZD at the document's
  rate (MC29, not yet approved by Jess).

### Not supported yet (refused rather than guessed)

- **Voiding a bill or sales credit note whose stock has moved since**:
  refused (it needs later movements re-costed).
- **Credit notes returning stock without the invoice it was sold on**:
  refused; the credit note names the invoice (to restock at the sale's
  cost). A price adjustment is a line without the item.
- **Returning a kit on a credit note**: its parts come back at their sale's
  cost, from the same invoice.
- **Bins, lots and serial numbers, assemblies**, and receiving stock without
  a bill (use a stock movement).

## Locked periods

With a lock date of 31 Mar 2026:

- **L1** 1 Apr 2026 posts. (Regression check: an earlier version rejected
  every date once any lock was set, because it compared a Date object with a
  string.)
- **L2** 31 Mar 2026 and 10 Feb 2026 are refused.
- **L3** Reopening February (moving the lock to 31 Jan 2026, with a reason;
  without one it's refused) reopens March too: 10 Feb 2026 posts and
  15 Jan 2026 is still refused. (The unlock window this used to describe is
  gone: see "Year end and period close".)
- **L4** A retry of a journal that was posted before the period was locked
  returns the original journal instead of an error.

## Corrections

- **C1** Correct journal #1 (Dr bank 100 / Cr sales 100) to 125 on 2 Jul:
  posts a reversal (Dr sales 100 / Cr bank 100) and a replacement
  (Dr bank 125 / Cr sales 125), both dated 2 Jul. Journal #1 is unchanged.
- **C2** Correcting journal #1 again is refused ("already been corrected").
- **C3** Retrying the same correction (same idempotency key) returns the
  same reversal and replacement.
- **C4** The replacement can itself be corrected later.
- **C5** A reversal can't be corrected.
- **C6** Journals created by stock movements or FX revaluations can't be
  corrected in the ledger; correct them with a stock adjustment/return.
- **C7** The correction date must be in an open period (see L1-L3).

## Draft manual journals (examples not yet approved by Jess)

Like Xero's draft manual journals (decisions 349-352): a draft posts nothing
until someone posts it. Tested in `tests/integration/journal-drafts.test.ts`.

A 12-month software subscription of $1,200.00 was expensed to 6040
Software and subscriptions; at 30 Jun 2026 six months are still to come.

- **MJD1** Save a draft dated 30 Jun 2026, reference PREPAY-JUN: Dr 1200
  Prepayments 600.00 / Cr 6040 Software and subscriptions 600.00. Nothing
  is posted: no journal, and the trial balance is unchanged (1200 and 6040
  still 0.00 and 1,200.00). The draft shows who saved it and when.
- **MJD2** A draft is checked like a journal when it's saved: Dr 600.00 /
  Cr 550.00 is refused ("doesn't balance: debits 600, credits 550"), as are
  one line, a line with both a debit and a credit, and an unknown or
  archived account. Nothing is saved.
- **MJD3** Editing the draft to 650.00 each side replaces its lines; still
  nothing is posted.
- **MJD4** Posting the draft posts one manual journal dated 30 Jun 2026,
  reference PREPAY-JUN: Dr 1200 650.00 / Cr 6040 650.00, recorded as posted
  by the person who posted it. The draft is marked posted and links the
  journal. The trial balance shows 1200 650.00 Dr and 6040 550.00 Dr.
- **MJD5** Posting it again returns the same journal; no second journal.
  A posted draft can't be edited or deleted (the database refuses it too);
  correct the journal instead (C1).
- **MJD6** With June locked (lock date 30 Jun 2026), posting a draft dated
  30 Jun 2026 is refused and the draft stays a draft; changed to 1 Jul
  2026, it posts.
- **MJD7** A draft that hasn't been posted can be deleted (bookkeeper and
  up); nothing was ever posted. Viewers can see drafts but not save, post or
  delete them.
- **MJD8** Saving with the same idempotency key and the same content
  returns the same draft (D1); the same key with different content is
  refused (D2).
- **MJD9** A draft saved by an AI key (decision 346) records the person
  and the key ("jess@… via AI key \"Claude on my laptop\""); the key can save
  and post drafts at its level but can never delete one.

## Duplicate and retried commands

- **D1** Same idempotency key + same content: returns the original, creates
  nothing (201 then 200).
- **D2** Same key + different content: refused (409).
- **D3** A retried stock sale after all stock was sold returns the original
  sale; it does not fail with "no stock on hand".

## Foreign-currency revaluation

A USD bank account holds USD 1,000.00, booked at NZD 1,600.00. Revalue on
31 Aug 2026 at 1 USD = 1.6543 NZD:

- **F1** Carrying amount comes from the ledger: **1,600.00**.
- **F2** Revalued amount = 1,000.00 x 1.6543 = **1,654.30** (rounded once).
- **F3** Posts Dr USD bank 54.30 / Cr unrealised currency gains 54.30 on
  31 Aug, and the exact reversal on 1 Sep.
- **F4** After 1 Sep the unrealised gain is gone from the trial balance.
- **F5** Revaluing the same account on the same date again is refused.
- **F6** Liabilities work the other way: a USD payable that is worth more in
  NZD is an unrealised **loss**.
- **F7** Only accounts marked with a foreign currency can be revalued, and
  only when their balance has the normal sign. (Accounts receivable and
  payable also revalue their open foreign-currency documents, one currency
  at a time and each document on its own, with either sign: MC8, MC39.)

Since foreign-currency lines keep their foreign amount (FXB1-FXB11), the
USD 1,000.00 is in the ledger too (the journal booking it gives USD 1,000.00
at 1.6), so it needn't be typed; typing it is still allowed if it agrees,
and it's still typed for accounts with postings from before (FXB7).

## Sales invoices

An invoice's amounts are tax **exclusive** (GST is added on top), tax
**inclusive** (the prices already include GST) or **no tax**.

- Line amount = quantity x unit price, rounded once to cents, half away from
  zero. Quantities and unit prices allow up to 4 decimal places.
- GST is worked out and rounded on each line, then added up. Exclusive:
  line amount x rate. Inclusive: line amount x rate / (1 + rate), which is
  3/23 at 15%, and the net is the line amount less its GST. Per-line rounding
  matches Xero; the owner is still confirming it, so all invoice rounding
  lives in one place (`src/lib/invoices/amounts.ts`).
- Drafts post nothing. Approving posts one journal dated the invoice date:
  Dr accounts receivable (1100) for the total, Cr each revenue account for
  its net amount, Cr GST (2100) for the GST. There's no GST line when the GST
  is 0.00.
- Numbers `INV-0001`, `INV-0002`, ... are given on approval, with no gaps.
- Tax codes: every organisation starts with the standard NZ codes, like
  Xero: **GST** "GST (15%)" (standard, 0.15), **ZERO** "Zero rated"
  (zero rated, 0), **EXEMPT** "Exempt" (exempt, 0) and **NONE** "No GST"
  (out of scope, 0), all in effect from **1 Oct 2010** (when GST became
  15%). So a document dated 30 Sep 2010 with GST is refused ("isn't in
  effect"). Organisations made before this change that had no tax codes at
  all were given the same four (migration 0031); one that already had any
  codes was left alone (`tests/integration/provisioning.test.ts`). The
  examples in this document use these seeded codes.

| ID | Invoice | Result |
| --- | --- | --- |
| I1 | Exclusive: 2 x 50.00 at 15% | Net **100.00**, GST **15.00**, total **115.00**. Journal: Dr 1100 115.00 / Cr 4000 100.00 / Cr 2100 15.00 |
| I2 | Inclusive: 1 x 115.00 at 15% | Net **100.00**, GST **15.00**, total **115.00** |
| I3 | Exclusive: three lines of 1 x 3.33 at 15% | GST **0.50** a line (0.4995 rounds up), GST **1.50**, total **11.49** |
| I4 | Inclusive: 1 x 10.00 at 15% | GST = 10.00 x 3/23 = 1.3043 -> **1.30**; net **8.70** |
| I5 | Exclusive: 100.00 at standard 15% + 50.00 zero-rated, both to 4000 | GST **15.00**, total **165.00**; Cr 4000 **150.00** |
| I6 | No tax: 1 x 80.00 | Total **80.00**, no GST line. Journal: Dr 1100 80.00 / Cr 4000 80.00 |

- **I7** Voiding I1 on a later date in an open period posts the exact
  reversal on that date (Dr 4000 100.00 / Dr 2100 15.00 / Cr 1100 115.00).
  The invoice shows as voided, and a second void is refused.
- **I8** Approving an invoice dated in a locked period is refused; the draft
  stays a draft.
- **I9** Retrying an approval with the same idempotency key returns the same
  invoice number and journal. Drafts post nothing.

### Not supported yet (refused rather than guessed)

- **Negative or zero lines** (discounts, credits): quantities and unit prices
  must be more than zero, and a line that rounds to 0.00 is refused. Credit
  the customer with a sales credit note instead (CN1-CN12).
- **Correcting an approved invoice**: it can't be edited, and its journals
  can't be corrected in the ledger. Void it and raise a new one.
- **Foreign-currency invoices**: see "Multi-currency invoices and bills"
  (MC1-MC13, not yet approved by Jess) for what's built and what's still
  refused.

## Customer payments

A customer payment is money received against one approved sales invoice.
Recording it posts one journal dated the payment date: Dr the bank account the
money went into / Cr accounts receivable (1100). The bank account must be an
active account of type bank. Amounts must be more than zero, with at most
2 decimal places.

An invoice's amount due is its total less the part of its active (not
voided) payments that paid it (a payment less its overpayment, OP1) and the
active credit applied to it from sales credit notes (CN3) and from
overpayments (OP2). Its paid
status is **unpaid** (nothing paid), **part paid** or **paid**
(nothing due). Both are worked out from the payments every time; they're
never stored or typed in.

- **CP1** INV-0001 for 115.00 (I1). Pay 115.00 into 1000: the journal is
  Dr 1000 115.00 / Cr 1100 115.00, dated the payment date. Amount due
  **0.00**; status **paid**.
- **CP2** The same invoice paid 50.00, then 65.00: amount due **65.00** and
  **part paid** after the first; **0.00** and **paid** after the second.
- **CP3** Paying a draft or a voided invoice is refused (paying an
  already-paid invoice is all overpayment, OP4). Amounts must be more than zero with at most 2 decimal places: 0.00,
  -5.00 and 10.001 are refused. Paying 115.01 against a 115.00 invoice is not
  refused: it pays the invoice and the extra 0.01 is an overpayment (OP1).
- **CP4** Voiding the 65.00 payment from CP2 on a later date in an open
  period posts the exact reversal on that date (Dr 1100 65.00 /
  Cr 1000 65.00). Amount due goes back to **65.00**; status **part paid**. A
  second void is refused.
- **CP5** Voiding INV-0001 while it has an active payment is refused ("void
  its payments first"). After its payments are voided, voiding the invoice
  works.
- **CP6** A payment dated in a locked period is refused, and nothing is
  posted.
- **CP7** Retrying a payment with the same idempotency key and content returns
  the same payment (201 then 200); the same key with a different amount is
  refused (409).
- **CP8** The bank account must be an active account of type bank: paying
  into 1100, or into an archived bank account, is refused.

### Not supported yet (refused rather than guessed)

- **Prepayments**: a payment can't be dated before the invoice date. Money
  received before an invoice exists is refused; raise the invoice first.
  Under s9(1) of the GST Act a payment received can trigger the time of
  supply (IRD interpretation statement IS 10/03), so how GST should work on
  prepayments is still to be decided by the owner.
- **One payment for several invoices**: see "Payments for several invoices"
  below.
- **Foreign-currency bank accounts**: an NZD invoice is paid into a bank
  account in the base currency only; a foreign-currency invoice into one in
  its currency or the base currency (MC5, MC6).
- **Correcting a payment**: its journals can't be corrected in the ledger.
  Void the payment and record it again. A void can't be dated before the
  payment.

## Payments for several invoices

One amount received from a customer can pay several of their invoices at
once (decided with the owner, 29 Sep 2026). It posts **one journal** dated
the payment date, with **one line on the bank account** for the whole amount
received (so it matches the one deposit on the bank statement) and one credit
line on accounts receivable (1100) for each invoice. Each invoice's part is
kept as a payment against that invoice, so its amount due, paid status,
Home, the GST return and overpayments work exactly as for a payment against
one invoice (CP1-CP8, OP1-OP11). The amount for each invoice is typed in; a
part payment is just a smaller amount.

- The invoices are approved invoices of the same customer, each listed once.
  Each amount is more than zero, with at most 2 decimal places, and no more
  than that invoice's amount due. The payment date is on or after every
  invoice's date, in an open period; the bank account follows CP8.
- The amounts for the invoices add up to the amount received. The only
  exception: when **every** invoice is paid in full, the amount received can
  be more, and the extra is an **overpayment** (OP1), kept on the part for
  the last invoice listed.
- It's undone as a whole: **voiding** the payment (once, dated on or after
  it, in an open period) posts the exact reversal of its journal and voids
  every invoice's part. One invoice's part can't be voided on its own
  ("void the whole payment"), and the payment can't be voided while its
  overpayment is applied or refunded (OP8).
- An invoice with an active part of such a payment can't be voided (CP5).
- **In a foreign currency** (invoices or bills of a contact in another
  currency): see MC20-MC24.

Setup: customer Kobe Ltd with INV-0001 = I1 (total 115.00) and INV-0002 =
I6 (no tax, 80.00), customer Rex Ltd with INV-0003 (no tax, 50.00), all
dated 10 May 2026. Payments are dated 15 May 2026 into 1000.

- **MP1** Kobe Ltd pays 195.00 for INV-0001 (115.00) and INV-0002 (80.00):
  one journal, Dr 1000 **195.00** / Cr 1100 **115.00** (INV-0001) /
  Cr 1100 **80.00** (INV-0002). Both invoices due **0.00**, **paid**; each
  shows a payment of its part, dated 15 May.
- **MP2** 155.00 for INV-0001 (115.00) and INV-0002 (40.00): Dr 1000 155.00 /
  Cr 1100 115.00 / Cr 1100 40.00. INV-0001 **paid**; INV-0002 due **40.00**,
  **part paid**.
- **MP3** 210.00 for INV-0001 (115.00) and INV-0002 (80.00), both in full:
  Dr 1000 210.00 / Cr 1100 115.00 / Cr 1100 95.00. The part for INV-0002 is
  95.00, of which **15.00** is an overpayment, **open**; it can be applied to
  Kobe's other invoices (not INV-0002) or refunded, as in OP2 and OP7.
- **MP4** Refused, and nothing is posted: less received than the amounts
  for the invoices (150.00 for 115.00 + 40.00); more received when not every
  invoice is paid in full (160.00 for 115.00 + 40.00: the extra isn't an
  overpayment, because INV-0002 isn't paid in full); an amount more than an invoice's amount due (INV-0002
  80.01); Rex Ltd's INV-0003 with Kobe's invoices; the same invoice twice; a
  draft or voided invoice; no invoices; dated before an invoice's date;
  amounts 0.00, -1.00 and 1.001.
- **MP5** Voiding MP1 on 20 May posts one journal, Dr 1100 115.00 /
  Dr 1100 80.00 / Cr 1000 195.00, dated 20 May; both invoices due again
  (**115.00** and **80.00**). Voiding INV-0001's part on its own is refused;
  a second void, and a void dated before 15 May, are refused.
- **MP6** Voiding MP3 while 5.00 of its overpayment is applied to another
  Kobe invoice is refused; after the application is removed it works.
- **MP7** Voiding INV-0002 while MP1 is active is refused ("void its
  payments first").
- **MP8** A GST return on the payments basis for May 2026 counts MP1 exactly
  like two separate payments of 115.00 and 80.00 on 15 May (G10-G22); on the
  invoice basis it changes nothing.
- **MP9** A bank statement line of +195.00 on 15 May 2026 matches MP1's one
  bank journal line and reconciles it.
- **MP10** Recording or voiding dated in a locked period is refused, and
  nothing is posted. Retrying with the same idempotency key and content
  returns the same payment; the same key with different content is refused
  (409). A bank account that isn't an active base-currency bank account is
  refused (CP8).

## Customer overpayments

An overpayment is the part of a customer payment that's more than the
invoice's amount due when the payment is recorded. The payment still posts
**one journal** for the full amount received: Dr the bank account /
Cr accounts receivable (1100). No GST is posted: the invoice already carried
the GST, and the excess isn't payment for a new supply. The excess sits in
1100 as credit for that customer, the way a credit note's remaining credit
does.

- When a payment is recorded it's split once, and the split is kept: the
  part that pays the invoice (at most the amount due at that moment) and the
  overpayment (the rest). A payment that's no more than the amount due has
  no overpayment and works exactly as before (CP1-CP8).
- **Applying** an overpayment to other approved invoices of the same
  customer and currency works like applying credit-note credit (CN3-CN5): it
  posts **no journal** (both sides are 1100). One command can cover several
  invoices, with one date and an amount for each, all or nothing. Each amount
  is more than zero with at most 2 decimal places and no more than that
  invoice's amount due; the total is no more than what's left of the
  overpayment; the date is on or after both the payment date and the invoice
  date. It can't be applied to the invoice it overpaid.
- **Removing** an application (once, dated on or after the application)
  posts no journal and puts the amount back on both.
- **Refunding** what's left posts Dr 1100 / Cr the bank account on the
  refund date (on or after the payment date), from an active, base-currency
  account of type bank (a foreign-currency overpayment: MC16). A refund can be
  voided once, which posts the exact reversal.
- What's left of an overpayment is the overpayment less its active
  applications and active refunds; its status is **open** (none used),
  **part used** or **used** (none left). Only the split is stored; the rest
  is worked out every time.
- Voiding a payment is refused while any of its overpayment is applied or
  refunded ("remove its applications and void its refunds first"). Otherwise
  the void reverses the full amount received.
- The GST return (invoice basis) isn't changed by overpayments,
  applications, removals or refunds.
- Period locks apply to recording, applying, removing, refunding and voiding,
  by their dates, even when no journal is posted.

Setup: the credit notes setup (customer Kobe Ltd, INV-0001 = I1, total
115.00, and INV-0002 = I6, no tax, 80.00) plus customer Rex Ltd with INV-0003
(no tax, 50.00), all dated 10 May 2026. Each example starts from the setup
plus the steps it names.

- **OP1** Pay 130.00 into 1000 against INV-0001: one journal,
  Dr 1000 130.00 / Cr 1100 130.00. Invoice part **115.00**, overpayment
  **15.00**. INV-0001 due **0.00**, **paid**. Overpayment left **15.00**,
  **open**. Kobe's 1100 balance is 80.00 - 15.00 = **65.00**.
- **OP2** From OP1, apply 15.00 of the overpayment to INV-0002: no journal.
  INV-0002 due **65.00**, **part paid**. Overpayment left **0.00**, **used**.
- **OP3** Pay INV-0001 50.00, then 100.00: the second payment's invoice part
  is **65.00** and its overpayment **35.00**; INV-0001 due **0.00**, **paid**.
  With a 15.00 credit note applied first, paying 115.00 is 100.00 on the
  invoice and 15.00 overpaid.
- **OP4** Paying an invoice that's already paid (e.g. the customer pays
  INV-0001 115.00 again after OP1) is all overpayment: invoice part **0.00**,
  overpayment **115.00**, one journal Dr 1000 115.00 / Cr 1100 115.00. It's
  credit on the customer's account, to apply to their other invoices or
  refund (OP7). The screen asks for confirmation first, so a payment entered
  twice by mistake is caught.
- **OP5** Refused, and nothing changes: applying more than what's left of the
  overpayment; more than an invoice's amount due (one bad line fails the
  whole command); Rex Ltd's INV-0003; the invoice the payment overpaid; a
  draft or voided invoice; dated before the payment date or the invoice date;
  amounts 0.00, -1.00 and 1.001; applying or refunding from a payment with no
  overpayment or a voided payment.
- **OP6** From OP2, removing the application on a later date posts no
  journal: INV-0002 due back to **80.00**; overpayment left back to
  **15.00**. A second removal is refused, and so is one dated before the
  application.
- **OP7** From OP1, refunding 15.00 from 1000 posts Dr 1100 15.00 /
  Cr 1000 15.00; left **0.00**. Refunding 15.01, from 1100, or from an
  archived bank account is refused. Voiding the refund later posts
  Dr 1000 15.00 / Cr 1100 15.00; left back to **15.00**.
- **OP8** Voiding the OP1 payment while any of its overpayment is applied or
  refunded is refused. After those are removed or voided, voiding posts
  Dr 1100 130.00 / Cr 1000 130.00; INV-0001 due back to **115.00**; the
  overpayment can't be used again. Voiding INV-0002 while overpayment credit
  is applied to it is refused ("remove its credit first").
- **OP9** A GST return on the invoice basis for the period with OP1, an
  application and a refund in it has the same boxes and lines as one with only
  the invoices. (On the payments basis see G15.)
- **OP10** Recording, applying, removing, refunding or voiding dated in a
  locked period is refused, and nothing is posted.
- **OP11** Retrying record, apply, remove, refund or void with the same
  idempotency key and content returns the same result; the same key with
  different content is refused (409).

### Not supported yet (refused rather than guessed)

- **Prepayments**: see customer payments above.
- **Supplier overpayments**: supplier payments still can't be more than the
  amount due (SP3).
- **Receiving money that isn't against any invoice**: refused, like
  prepayments. (A customer who paid an invoice twice is OP4.)
- **Foreign-currency** overpayments are built: see MC14-MC16.
- **Correcting an overpayment refund**: its journals can't be corrected in
  the ledger. Void the refund and record it again.

## Bills

A bill is an invoice from a supplier. Bills work like sales invoices the
other way round: the same amounts modes (tax exclusive, tax inclusive or no
tax), the same line maths and the same per-line GST rounding, from the same
code (`src/lib/invoices/amounts.ts`, see "Sales invoices").

- The supplier must be an active contact marked as a supplier. The
  supplier's invoice number is required to approve a bill, and a supplier
  can't have two bills that aren't voided with the same number, ignoring
  case and spaces. A **draft** can be saved without it (B9, decided 1 Oct
  2026 following NetSuite, where a vendor bill's Reference No. is optional),
  to be typed when the supplier's real invoice arrives; approved and voided
  bills always have one (the database refuses otherwise).
- The due date is typed, or, for a new bill sent without one, comes from
  the supplier's payment terms (SPT1-SPT5); either way a draft's due date
  can be changed.
- Line accounts are active, base-currency accounts of type expense or direct
  costs, or asset accounts, but not bank, accounts receivable, accounts
  payable or GST. The inventory account (1400) takes only stock item lines,
  and stock item lines only go there (ST1). Tax codes come from the same list
  as invoices.
- Drafts post nothing. Approving posts one journal dated the bill date: Dr
  each line's account for its net amount, Dr GST (2100) for the GST, Cr
  accounts payable (2000) for the total. There's no GST line when the GST is
  0.00. Its reference is the supplier's invoice number.
- An approved bill can't be edited, and its journal can't be corrected in the
  ledger. It can be voided once, which posts the exact reversal.

| ID | Bill | Result |
| --- | --- | --- |
| B1 | Exclusive: 1 x 200.00 at 15% to 6010 | Net **200.00**, GST **30.00**, total **230.00**. Journal: Dr 6010 200.00 / Dr 2100 30.00 / Cr 2000 230.00 |
| B2 | Inclusive: 1 x 46.00 at 15% to 6040 | GST = 46.00 x 3/23 = **6.00**; net **40.00**; total **46.00** |
| B3 | Exclusive: three lines of 1 x 3.33 at 15% | GST **0.50** a line, GST **1.50**, total **11.49** (same as I3) |
| B4 | Exclusive: 100.00 at standard 15% + 20.00 exempt | GST **15.00**, total **135.00** |

- **B5** A second bill (not voided) from the same supplier with supplier
  invoice number "inv 42" when "INV42" exists is refused; after the first one
  is voided it's allowed. The same number from a different supplier is fine.
- **B6** Voiding B1 on a later date in an open period posts the exact
  reversal on that date (Dr 2000 230.00 / Cr 6010 200.00 / Cr 2100 30.00).
  The bill shows as voided, and a second void is refused.
- **B7** Approving a bill dated in a locked period is refused; the draft stays
  a draft.
- **B8** Retrying an approval with the same idempotency key returns the same
  journal. Drafts post nothing. A contact that is only a customer, or is
  archived, can't be the supplier.
- **B9** (example not yet approved by Jess) Two draft bills from Waiting
  Supplies saved without a supplier's invoice number (1 x 200.00 + GST =
  **230.00** each) are fine: no number, no clash. Approving one is refused
  ("Add the supplier's invoice number before approving: this draft bill from
  Waiting Supplies doesn't have one yet.") and posts nothing; the database
  refuses an approved bill without a number too. Once **WS-8841** is typed
  on it, approving posts B1's journal (Dr 6010 200.00 / Dr 2100 30.00 /
  Cr 2000 230.00) with reference WS-8841. Typing "ws-8841 " on the other
  draft is then refused (B5), and a draft's number can be cleared again.

### Not supported yet (refused rather than guessed)

- **Paying bills other than one at a time**: supplier payments (see
  "Supplier payments" below) pay one bill each, from a base-currency bank
  account, and have their own list of what isn't supported yet.
- **Negative or zero lines** (e.g. discounts): the same rules as invoices.
  Credit from a supplier is a supplier credit note (SCN1-SCN12).
- **Correcting an approved bill**: it can't be edited, and its journal can't
  be corrected in the ledger. Void it and enter it again. A void can't be
  dated before the bill.
- **Foreign-currency bills**: bills are in the base currency only, and lines
  can't go to foreign-currency accounts.

### Supplier payment terms (examples not yet approved by Jess)

Decided 1 Oct 2026, following NetSuite: a vendor record has a Terms field,
and NetSuite's [Creating Terms of
Payment](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1234186.html)
says terms are applied "by setting default terms on customer and vendor
records" and used on "vendor bills and other transactions"; its [Entering a
Vendor Bill](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_161968486146.html)
has a Terms field and an editable Due Date. So:

- A supplier has a default **supplier payment term**, from the same list as
  customers' terms (RC1, RC2: N days after the date, N days after the end
  of the month, or day N of the following month) with the same maths. It's
  its own field: a contact that's both a customer and a supplier can have
  different terms each way. Only suppliers can be given one; a newly chosen
  term must be active; a contact that stops being a supplier keeps it.
- A **new bill sent without a due date** takes it from the supplier's terms
  (on screen, the due date fills when the supplier or date is chosen, until
  it's typed over). With no terms, or archived ones, the due date is
  required. A draft's due date can always be changed.
- **Repeating bills** can be due "by the supplier's payment terms" (RB12),
  and **copy to bill** from a purchase order without a due date uses them
  (SPT4).
- Changing or archiving a term, or a supplier's term, never changes a saved
  bill.

#### Default terms (decision 333, examples not yet approved by Jess)

- **DT1** Supplier No Terms Supplies has no payment terms and the
  organisation has no default: a bill dated 15 Jun 2026 sent without a due
  date is refused ("this supplier has no payment terms"), as before.
- **DT2** The organisation's default for bills is "20th of the following
  month" (and for invoices "7 days", which bills ignore): the same bill is
  due **20 Jul 2026**. A supplier with its own terms (7 days) still uses
  them: due **22 Jun 2026**. An archived term can't be made the default;
  clearing the defaults brings DT1 back. Invoices work the same way with
  the invoice default and the customer's terms. A draft's due date can
  still be changed.

Setup: the six starting payment terms; supplier Harbour Property Ltd;
Paw Supplies and Sales, a customer and a supplier. Tests:
`tests/integration/bills.test.ts` (SPT1, SPT2, SPT5, DT1, DT2),
`tests/integration/repeating-bills.test.ts` (SPT3, as RB12) and
`tests/integration/purchase-orders.test.ts` (SPT4).

- **SPT1** Harbour gets "20th of the following month". Paw Supplies and
  Sales has customer terms "7 days" and supplier terms "30 days". A contact
  that's only a customer can't be given supplier terms ("Only suppliers
  have supplier payment terms."), and an archived term can't be chosen.
- **SPT2** A bill from Harbour dated **15 Jun 2026** sent without a due date
  is due **20 Jul 2026**; dated **31 Dec 2026**, **20 Jan 2027**. One sent
  with a due date of 30 Jun 2026 keeps it, and a draft's due date can be
  changed to 1 Aug 2026. Paw Supplies and Sales' bill dated 15 Jun 2026 is
  due **15 Jul 2026** (its supplier terms, not its customer terms). A retry
  with the same key returns the same bill. A supplier with no terms: the due
  date is required.
- **SPT3** = RB12 (repeating bills due by the supplier's terms).
- **SPT4** Copying PO-0001 (PO3) to a bill dated **12 Jul 2026** without a
  due date is refused while Paw Supplies has no terms (nothing is made); with
  "30 days" it's due **11 Aug 2026** (total 287.50), and a retry returns the
  same bill.
- **SPT5** Harbour's terms changed to "7 days": the draft keeps 1 Aug 2026,
  and a new bill dated 15 Jun 2026 is due **22 Jun 2026**. With "7 days"
  archived, a new bill needs a due date typed.

## Supplier payments

A supplier payment is money paid against one approved bill. It's the mirror
of a customer payment. Recording it posts one journal dated the payment date:
Dr accounts payable (2000) / Cr the bank account the money came from. The bank
account must be an active, base-currency account of type bank. Amounts must be
more than zero, with at most 2 decimal places.

A bill's amount due is its total less its active (not voided) payments and
the active credit applied to it from supplier credit notes (SCN3). Its paid
status is **unpaid** (nothing paid), **part paid** or **paid** (nothing
due). Both are worked out every time; they're never stored or typed in.

- **SP1** Bill B1 (total 230.00). Pay 230.00 from 1000: the journal is
  Dr 2000 230.00 / Cr 1000 230.00, dated the payment date. Amount due
  **0.00**; status **paid**.
- **SP2** The same bill paid 100.00, then 130.00: amount due **130.00** and
  **part paid** after the first; **0.00** and **paid** after the second.
- **SP3** Paying 230.01 against a 230.00 bill is refused (no overpayments
  yet). Paying a draft or a voided bill is refused. A payment dated before the
  bill date is refused. Amounts must be more than zero with at most 2 decimal
  places: 0.00, -5.00 and 10.001 are refused.
- **SP4** Voiding the 130.00 payment from SP2 on a later date in an open
  period posts the exact reversal on that date (Dr 1000 130.00 /
  Cr 2000 130.00). Amount due goes back to **130.00**; status **part paid**. A
  second void is refused, and so is a void dated before the payment.
- **SP5** Voiding bill B1 while it has an active payment is refused ("void its
  payments first"). After its payments are voided, voiding the bill works.
- **SP6** A payment or a void dated in a locked period is refused, and nothing
  is posted.
- **SP7** Retrying a payment with the same idempotency key and content returns
  the same payment (201 then 200); the same key with a different amount is
  refused (409).
- **SP8** The bank account must be an active, base-currency account of type
  bank: paying from 2000, or from an archived bank account, is refused.

### Not supported yet (refused rather than guessed)

- **One payment for several bills**: see "Payments for several bills"
  below.
- **Overpayments and prepayments to suppliers**: a payment can't be more than
  the amount due, and it can't be dated before the bill date.
- **Foreign-currency bank accounts**: payments are made from bank accounts in
  the base currency only.
- **Batch payments and bank files** (e.g. ABA): each payment is recorded on
  its own, and no bank file is made.
- **Correcting a payment**: its journals can't be corrected in the ledger.
  Void the payment and record it again.

## Payments for several bills

The mirror of payments for several invoices (decided with the owner, 29 Sep
2026): one amount paid to a supplier for several of their bills posts **one
journal** dated the payment date, one debit line on accounts payable (2000)
for each bill and **one line on the bank account** for the whole amount. Each
bill's part is kept as a payment against that bill (SP1-SP8). The rules are
the same as for invoices, except that there are **no overpayments**: the
amounts for the bills must add up to exactly the amount paid, and none can be
more than its bill's amount due.

Setup: supplier Kiwi Supplies with bills B1 (total 230.00) and B4 (total
135.00), and supplier Rata Ltd with a no-tax bill of 60.00, all dated 10 May
2026. Payments are dated 15 May 2026 from 1000.

- **SMP1** 365.00 to Kiwi Supplies for B1 (230.00) and B4 (135.00): one
  journal, Dr 2000 **230.00** (B1) / Dr 2000 **135.00** (B4) / Cr 1000
  **365.00**. Both bills due **0.00**, **paid**.
- **SMP2** 330.00 for B1 (230.00) and B4 (100.00): B4 due **35.00**, **part
  paid**.
- **SMP3** Refused, and nothing is posted: 370.00 for B1 (230.00) and B4
  (135.00) (no supplier overpayments); amounts that don't add up to the
  amount paid; an amount more than a bill's amount due; Rata Ltd's bill with
  Kiwi's; the same bill twice; a draft or voided bill; no bills; dated before
  a bill's date; amounts 0.00, -1.00 and 1.001.
- **SMP4** Voiding SMP1 on 20 May posts one journal, Dr 1000 365.00 /
  Cr 2000 230.00 / Cr 2000 135.00; both bills due again. Voiding one bill's
  part on its own is refused, and so are a second void and one dated before
  15 May. Voiding B1 while SMP1 is active is refused.
- **SMP5** A GST return on the payments basis counts SMP1 like two separate
  payments of 230.00 and 135.00 on 15 May; a statement line of -365.00 on
  15 May matches its one bank journal line.
- **SMP6** Locked periods, retries with the same idempotency key (same or
  different content) and bank accounts work as in SP6-SP8.

## Sales credit notes

A sales credit note is credit given to a customer, e.g. for goods returned or
an overcharge. Its lines work exactly like invoice lines (the same amounts
modes, line rules and per-line GST in `src/lib/invoices/amounts.ts`).

- Drafts post nothing, can be edited and deleted, and have no number.
- Approving numbers it `CN-0001`, `CN-0002`, ... with no gaps, from its own
  counter (separate from `INV-`), and posts one journal dated the credit note
  date: Dr each revenue account for its net amount, Dr GST (2100) for the GST,
  Cr accounts receivable (1100) for the total. There's no GST line when the
  GST is 0.00. Approved credit notes can't be edited.
- **Applying** approved credit to approved invoices of the same customer and
  currency posts **no journal** (both sides are accounts receivable); it only
  changes the amounts due. One command can apply credit to several invoices,
  with one date and an amount for each, and it's all or nothing. Each amount
  is more than zero with at most 2 decimal places and no more than that
  invoice's amount due; the total is no more than the remaining credit. The
  date is on or after both the credit note date and the invoice date.
- **Removing** an application (once, dated on or after the application)
  posts no journal and puts the amount back on both. Nothing is deleted.
- **Refunding** remaining credit posts Dr 1100 / Cr the bank account on the
  refund date (on or after the credit note date), from an active,
  base-currency account of type bank (a foreign-currency credit note: MC17). A
  refund can be voided once, which posts the exact reversal on the void date.
- A credit note's remaining credit is its total less its active applications
  and active refunds; its credit status is **open** (none used), **part used**
  or **used** (none left). An invoice's amount due is its total less its active
  payments and active credit applied. All of these are worked out every time,
  never stored.
- Period locks apply to approving, applying, removing, refunding and voiding,
  by their dates, even when no journal is posted.

Setup: customer Kobe Ltd has INV-0001 = I1 (total 115.00, Dr 1100 115.00 /
Cr 4000 100.00 / Cr 2100 15.00) and INV-0002 = I6 (no tax, 80.00). Each example
starts from the setup plus the steps it names.

- **CN1** A draft credit note, exclusive, 1 x 20.00 at 15% to 4000, posts
  nothing, can be edited and deleted, and uses no number.
- **CN2** Approving it gives **CN-0001**: net **20.00**, GST **3.00**, total
  **23.00**. Journal on its date: Dr 4000 20.00 / Dr 2100 3.00 /
  Cr 1100 23.00. Remaining credit **23.00**; status **open**.
- **CN3** Applying 23.00 of CN-0001 to INV-0001 posts no journal. INV-0001 is
  credited **23.00**, amount due **92.00**, **part paid**. CN-0001 remaining
  **0.00**, **used**.
- **CN4** CN-0002 is exclusive 1 x 100.00 at 15% (total 115.00). One command
  applies 80.00 to INV-0002 and 20.00 to INV-0001 (after CN3, due 92.00):
  INV-0002 due **0.00**, **paid**; INV-0001 due **72.00**; CN-0002 remaining
  **15.00**, **part used**.
- **CN5** Refused, and nothing changes: applying more than the remaining
  credit; more than an invoice's amount due (one bad line fails the whole
  command); an invoice of another customer; a draft or voided invoice; a draft
  or voided credit note; dated before the credit note or invoice date; amounts
  0.00, -1.00 and 1.001.
- **CN6** After CN3, a payment of 92.00 makes INV-0001 **paid**; 92.01
  instead pays 92.00 and overpays 0.01 (OP1).
- **CN7** Starting from CN3, removing that application on a later date posts
  no journal: INV-0001 due back to **115.00**; CN-0001 remaining back to
  **23.00**, **open**. A second removal is refused, and so is a removal dated
  before the application.
- **CN8** Refunding CN-0002's remaining 15.00 from 1000 posts
  Dr 1100 15.00 / Cr 1000 15.00 on the refund date; remaining **0.00**,
  **used**. Refunding 15.01 is refused; refunding from 1100 or from an
  archived bank account is refused. Voiding the refund later posts
  Dr 1000 15.00 / Cr 1100 15.00; remaining back to **15.00**.
- **CN9** Voiding CN-0001 while it has an active application is refused
  ("remove its applications and refunds first"); after removing it, voiding
  posts Dr 1100 23.00 / Cr 4000 20.00 / Cr 2100 3.00. Voiding INV-0001 while
  credit is applied to it is refused ("remove its credit first").
- **CN10** Inclusive: 1 x 15.00 at 15% gives GST **1.96**, net **13.04**,
  total **15.00** (the same maths as invoices).
- **CN11** Approving, applying, removing, refunding or voiding dated in a
  locked period is refused, and nothing is posted or numbered. Approving two
  credit notes gives CN-0001 and CN-0002 with no gap, even with a refused
  approval in between; drafts never take a number; `INV-` numbering is
  unaffected.
- **CN12** Retrying approve, apply, refund or void with the same idempotency
  key and content returns the same result; the same key with different
  content is refused (409).

### Not supported yet (refused rather than guessed)

- **Applying credit across currencies**: credit is applied only to invoices in
  the credit note's currency.
- **Prepayments as credit**: only credit notes and overpayments (OP1-OP8)
  give credit.
- **Applying credit from the invoice page**: apply it from the credit note's
  page. The invoice page shows the credit applied and links to the customer's
  credit notes with credit left.
- **Credit note PDFs and emailing**.
- **Correcting a credit note or a refund**: their journals can't be corrected
  in the ledger. Void and raise them again.

## Supplier credit notes

A supplier credit note is credit a supplier gives us, e.g. for goods returned
or an overcharge on a bill. It's the mirror of a sales credit note. Its lines
work exactly like bill lines (the same amounts modes and line maths in
`src/lib/invoices/amounts.ts`, and the bill line account rules in
`src/lib/bills/accounts.ts`).

- The supplier must be an active contact marked as a supplier. There's no
  Tohyee number: the supplier's credit note number is required, and a
  supplier can't have two supplier credit notes that aren't voided (drafts
  included) with the same number, ignoring case and spaces. These numbers are
  separate from bill numbers.
- Drafts post nothing and can be edited and deleted. Approving posts one
  journal dated the credit note date: Dr accounts payable (2000) for the
  total, Cr each line's account for its net amount, Cr GST (2100) for the
  GST. There's no GST line when the GST is 0.00. Approved supplier credit
  notes can't be edited.
- **Applying** approved credit to approved bills of the same supplier and
  currency posts **no journal** (both sides are accounts payable); it only
  changes the amounts due. One command can apply credit to several bills,
  with one date and an amount for each, and it's all or nothing. Each amount
  is more than zero with at most 2 decimal places and no more than that
  bill's amount due; the total is no more than the remaining credit. The date
  is on or after both the credit note date and the bill date.
- **Removing** an application (once, dated on or after the application)
  posts no journal and puts the amount back on both. Nothing is deleted.
- **Refund received**: the supplier pays remaining credit back into an
  active, base-currency account of type bank (a foreign-currency one: MC18).
  It posts Dr the bank account / Cr 2000 on the refund date (on or after the
  credit note date). A refund can be voided once, which posts the exact
  reversal on the void date.
- A supplier credit note's remaining credit is its total less its active
  applications and active refunds; its credit status is **open** (none used),
  **part used** or **used** (none left). A bill's amount due is its total less
  its active supplier payments and active credit applied, and its paid status
  uses that amount due. All of these are worked out every time, never stored.
- A bill with active credit applied can't be voided ("remove its credit
  first"). A supplier credit note can only be voided when it has no active
  applications or refunds.
- Period locks apply to approving, applying, removing, refunding and voiding,
  by their dates, even when no journal is posted.

Setup: supplier Paw Supplies has bill B1 (exclusive 1 x 200.00 at 15% to
6010: Dr 6010 200.00 / Dr 2100 30.00 / Cr 2000 230.00) and bill BX (no tax,
1 x 80.00 to 6040, total 80.00). Each example starts from the setup plus the
steps it names.

- **SCN1** A draft supplier credit note "CR-7", exclusive, 1 x 40.00 at 15%
  to 6010, posts nothing and can be edited and deleted.
- **SCN2** Approving it: net **40.00**, GST **6.00**, total **46.00**.
  Journal on its date: Dr 2000 46.00 / Cr 6010 40.00 / Cr 2100 6.00.
  Remaining credit **46.00**; status **open**.
- **SCN3** Applying 46.00 of CR-7 to B1 posts no journal. B1 is credited
  **46.00**, amount due **184.00**, **part paid**. CR-7 remaining **0.00**,
  **used**.
- **SCN4** After SCN3, "CR-8" is exclusive 1 x 100.00 at 15% (total 115.00).
  One command applies 80.00 to BX and 20.00 to B1: BX due **0.00**, **paid**;
  B1 due **164.00**; CR-8 remaining **15.00**, **part used**.
- **SCN5** Refused, and nothing changes: applying more than the remaining
  credit; more than a bill's amount due (one bad line fails the whole
  command); a bill of another supplier; a draft or voided bill; a draft or
  voided credit note; dated before the credit note or bill date; amounts
  0.00, -1.00 and 1.001.
- **SCN6** After SCN3, a supplier payment of 184.00 makes B1 **paid**; 184.01
  instead is refused.
- **SCN7** Starting from SCN3, removing that application on a later date posts
  no journal: B1 due back to **230.00**; CR-7 remaining back to **46.00**,
  **open**. A second removal is refused, and so is a removal dated before the
  application.
- **SCN8** After SCN4, the supplier refunds CR-8's remaining 15.00 into 1000:
  Dr 1000 15.00 / Cr 2000 15.00 on the refund date; remaining **0.00**,
  **used**. Refunding 15.01 is refused; a refund into 2000 or into an archived
  bank account is refused. Voiding the refund later posts Dr 2000 15.00 /
  Cr 1000 15.00; remaining back to **15.00**.
- **SCN9** Voiding CR-7 while it has an active application is refused
  ("remove its applications and refunds first"); after removing it, voiding
  posts Dr 6010 40.00 / Dr 2100 6.00 / Cr 2000 46.00. Voiding B1 while credit
  is applied to it is refused ("remove its credit first").
- **SCN10** Inclusive: 1 x 46.00 at 15% gives GST **6.00**, net **40.00**,
  total **46.00** (the same maths as bills).
- **SCN11** A second supplier credit note from Paw Supplies numbered "cr7"
  while "CR 7" exists and isn't voided (draft or approved) is refused; after
  the first is voided it's allowed. The same number from another supplier, or
  on a bill, is fine.
- **SCN12** Approving, applying, removing, refunding or voiding dated in a
  locked period is refused, and nothing is posted. Retrying approve, apply,
  refund or void with the same idempotency key and content returns the same
  result; the same key with different content is refused (409).

### Not supported yet (refused rather than guessed)

- **Applying credit across currencies**: credit is applied only to bills in
  the credit note's currency.
- **Supplier prepayments and overpayments as credit**: only supplier credit
  notes give credit.
- **Applying credit from the bill page**: apply it from the supplier credit
  note's page. The bill page shows the credit applied and a note when the
  supplier has unused credit.
- **Correcting a supplier credit note or a refund**: their journals can't be
  corrected in the ledger. Void and enter them again.

## Bank accounts, statements and reconciliation

Bank accounts (type **bank**, an asset) and credit cards (type **credit
card**, a liability) hold **statement lines**: what the bank says happened,
brought in from an Akahu bank feed or an imported file. Statement lines are
not ledger entries. Nothing is posted until a line is reconciled, and
reconciling ties each line to journal lines on the same account.

- A statement line has a date, an amount, a description and, when the bank
  gives them, the payee, particulars, code, reference and running balance.
  Its amount is from the account holder's point of view: **money in is
  positive** (a deposit; on a credit card, a refund or a payment to the card)
  and **money out is negative** (a withdrawal; on a credit card, a purchase).
  Money in is a debit to the bank or credit card account; money out is a
  credit.
- Lines are **unreconciled**, **reconciled** or **excluded** (e.g. a
  duplicate, or something that isn't the organisation's). Only unreconciled
  lines count towards "reconcile N items". Deleting an import removes its
  lines, and is refused while any of them is reconciled.
- **Duplicates.** A line from a bank feed or an OFX file with the bank's own
  transaction id is never added twice. Lines without one are compared on
  date, amount, description and reference: an import adds a line only when
  the file has more of that line than the account already has, so the same
  file imported twice adds nothing and two genuine identical coffees on one
  day are both kept. A line that matches a line from another source on date
  and amount is added but flagged **possible duplicate**.
- **Reconciling** a line ties it to one or more journal lines on the same
  account whose amounts add up to the line's amount, dated within 60 days of
  it. A journal line can be reconciled once. The journal lines come from:
  - **matching** something already posted (a customer or supplier payment, a
    refund, a transfer, a bank transaction or a manual journal): posts
    nothing;
  - **paying invoices or bills** from the line: records customer payments
    (money in) or supplier payments (money out) dated the line date, into the
    line's account, one per invoice or bill, adding up to the line's amount;
  - a **bank transaction** (spend money for money out, receive money for money
    in): a contact, lines with accounts, tax codes and amounts, tax exclusive,
    inclusive or no tax (the invoice line maths). It posts one journal dated
    the line date: for spend money Dr each line's account for its net amount
    and Dr GST for the GST / Cr the bank or credit card account; receive
    money is the other way round. It counts in the GST return like a bill
    (spend) or an invoice (receive);
  - a **transfer** to or from another bank or credit card account: Dr the
    account the money went to / Cr the account it came from, dated the line
    date. The other account's own statement line then matches the transfer.
- **Unreconciling** puts the line back to unreconciled and posts nothing.
  Payments, bank transactions and transfers made from the line stay; void them
  separately. A payment, refund, bank transaction or transfer whose journal
  line on a bank or credit card account is reconciled can't be voided
  ("unreconcile it first").
- **Bank rules** suggest a bank transaction for lines whose description,
  payee, particulars, code or reference contains some text, optionally only
  for money in or out and one account. A suggestion posts nothing until it's
  confirmed.
- Period locks apply to reconciling and unreconciling by the line's date,
  even when nothing is posted, and to everything posted.
- Bank transactions and transfers can't be edited. Voiding one (not while
  reconciled) posts the exact reversal on the void date; a voided spend or
  receive money counts again, the other way, in the GST return on its void
  date.

Setup: 1000 Business bank account (bank), 1010 Savings account (bank), 2400
Credit card (credit card), tax code GST (15%), customer Kobe Ltd with
INV-0001 = I1 (total 115.00, 10 May 2026), supplier Kauri Supplies with bill
B1 (total 230.00, 10 May 2026), contact Z Energy.

- **BK1** Importing this CSV into 1000 adds three unreconciled lines and posts
  nothing:

  ```
  Date,Amount,Payee,Particulars,Code,Reference
  20/05/2026,115.00,KOBE LTD,INV-0001,,
  21/05/2026,-46.00,Z ENERGY,,,
  22/05/2026,-500.00,TRANSFER,SAVINGS,,
  ```

  Dates are day first. 1000's "reconcile" count is **3**. The column layout
  used (heading row, which column is which, date order, whether amounts are
  flipped) is saved on 1000: the next CSV or Excel file with the same columns
  is read with it, so a mapping chosen by hand sticks (a card export
  `Date,Amount,Details` with 20.00 for a purchase, imported once with
  "flip amounts", reads the next file's 15.00 as **-15.00**). A file whose
  columns differ is read with a freshly worked-out layout.
- **BK2** Importing the same file again adds **0** lines (3 duplicates). A
  file with those three rows and one more adds **1**. A file with two
  identical rows (21/05/2026, -4.50, CAFE) adds **2** the first time and
  **0** the second.
- **BK3** The same three transactions as an OFX file, a QIF file, an Excel
  (.xlsx) file, an ISO 20022 CAMT.053 file and an MT940 file give the same
  lines as BK1. OFX lines keep the bank's FITID, and importing OFX then the
  CSV flags the CSV's lines as possible duplicates instead of skipping them.
- **BK4** A customer payment of 115.00 into 1000 on 20 May against INV-0001
  (Dr 1000 115.00 / Cr 1100 115.00) matches the BK1 line +115.00: nothing is
  posted, the line is **reconciled**, the count is **2**. Matching it to a
  journal line already reconciled, on another account, dated more than 60
  days away, or not adding up to 115.00 is refused.
- **BK5** From the +115.00 line with no payment yet, paying INV-0001 115.00
  records a customer payment dated 20 May into 1000 (Dr 1000 115.00 /
  Cr 1100 115.00) and reconciles the line; INV-0001 is **paid**. From a
  -230.00 line, paying B1 records a supplier payment (Dr 2000 230.00 /
  Cr 1000 230.00). Paying amounts that don't add up to the line is refused.
- **BK6** From the -46.00 line, spend money to Z Energy, one line to 6120
  Motor vehicle expenses, GST, tax inclusive, 46.00: GST **6.00**, net
  **40.00**. Journal on 21 May: Dr 6120 40.00 / Dr 2100 6.00 / Cr 1000
  46.00. The line is reconciled. It adds **46.00** to the May GST return's
  Box 11 and **6.00** to its purchases GST.
- **BK7** From a +57.50 line, receive money from Kobe Ltd, 4000 Sales, GST,
  tax inclusive: Dr 1000 57.50 / Cr 4000 50.00 / Cr 2100 7.50, adding
  **57.50** to Box 5. A +2.30 interest line, receive money to 4200 with no tax: Dr 1000
  2.30 / Cr 4200 2.30, in no GST box.
- **BK8** From the -500.00 line, a transfer to 1010: Dr 1010 500.00 / Cr 1000
  500.00 on 22 May. A +500.00 line on 1010 matches the transfer's 1010
  journal line (BK4).
- **BK9** Credit card: a -86.25 line on 2400, spend money to 6130, GST,
  inclusive: Dr 6130 75.00 / Dr 2100 11.25 / Cr 2400 86.25. Paying the card,
  a -86.25 line on 1000 is a transfer to 2400: Dr 2400 86.25 / Cr 1000 86.25,
  and the card's +86.25 line matches it. Supplier payments can be paid from a
  credit card.
- **BK10** A rule "description contains Z ENERGY, money out: spend money to Z
  Energy, 6120, GST, inclusive" suggests the BK6 bank transaction for the
  -46.00 line and posts nothing until it's confirmed.
- **BK11** Unreconciling the BK6 line posts nothing; the line is unreconciled
  again and the bank transaction stays. Voiding the bank transaction while it
  was reconciled is refused; after unreconciling, voiding it posts Dr 1000
  46.00 / Cr 6120 40.00 / Cr 2100 6.00 on the void date, which takes
  **46.00** off Box 11 of the GST return covering the void date. The same "unreconcile it first" rule
  stops voiding a reconciled customer payment.
- **BK12** An unreconciled line can be excluded and brought back; a reconciled
  line can't be excluded. Deleting the BK1 import is refused while one of its
  lines is reconciled, and removes its lines once none is.
- **BK13** Reconciling or unreconciling a line dated in a locked period is
  refused, and nothing changes.
- **BK14** Retrying an import, reconcile, bank transaction, transfer or void
  with the same idempotency key and content returns the same result; the same
  key with different content is refused (409).

### Bank feeds (Akahu)

Bank feeds come from Akahu (NZ open finance). Each organisation sets up its
own Akahu **personal app** at my.akahu.nz with its own bank logins, and an
organisation admin enters the app's App ID token and user token in Tohyee.
The tokens are checked with Akahu before they're saved, stored encrypted
(with the server's `TOHYEE_SECRET_KEY`) in the organisation's own database,
and never shown again. An admin then links each Akahu account to one of the
organisation's bank or credit card accounts, with a start date for the
history to bring in.

- Syncing reads settled transactions only (pending ones wait until they
  settle) from two days before the last line it brought in (lines already
  there are skipped by Akahu's id), or from the start date the first time, as far back as Akahu and the bank allow. Network calls
  happen outside database transactions; each account's lines are then added
  in one transaction.
- Akahu's amount is signed the same way as statement lines (negative is money
  out). Its date is converted to the New Zealand date. Particulars, code,
  reference and the merchant name come across when Akahu has them.
- Accounts sync on a schedule (every 6 hours by default, 1-24 per
  organisation) and on demand. A failed sync keeps the error on the account
  and changes nothing. Saving new tokens replaces the old ones and linked
  accounts carry on; removing them stops syncing until tokens are saved
  again.

- **BK15** An Akahu account linked to 1000 with a start date of 1 May 2026
  returns two settled transactions (-46.00 on 21 May, +115.00 on 20 May) and
  one pending: two lines are added with Akahu's ids. Syncing again adds none.
  A +115.00 line on 20 May already imported from a CSV is flagged as a
  possible duplicate of the feed line.
- **BK16** Akahu's balance for the account is kept as the statement balance
  with its date, shown next to the ledger balance.

### Automatic statement files: a folder and a mailbox per bank account (approved by Jess, 5 Oct 2026)

Stage 1b, part 1, of the Xero add-ons plan (5 Oct 2026). Most banks have no
API Tohyee can use, but nearly all can email a statement file on a schedule
or save one where Tohyee can read it. Like the OCA bank-statement-import
modules for Odoo, each bank account can have **feeds** that bring in
statement files by themselves, read by the same importers as a file chosen
by hand (CSV, Excel, OFX, QIF, CAMT.053 and MT940, BK1-BK3), with the same
duplicate rules. Akahu stays a feed of its own (BK15, BK16). Nothing is
posted: lines arrive unreconciled, exactly as an import by hand.

- **A folder feed** reads one subfolder of the organisation's **bank files
  folder**. As with Analytics folders (decision 358), a server admin chooses
  each organisation's bank files folder (server app, command line or web),
  so an organisation can't point Tohyee at other folders on the server. An
  admin of the organisation then links a bank account to one subfolder of it
  (for example `ANZ business`, where the bank's scheduled export or a
  OneDrive sync puts its files). Tohyee only reads: files are never moved,
  changed or deleted.
- **A mailbox feed** reads one mailbox folder or Gmail label, through the
  admin's own mailbox connected in the CRM (Gmail or Microsoft), or IMAP
  with an app password (stored encrypted), the same connections report
  emails use (decisions 362 and 376) but kept with the feed, so it doesn't
  need Analytics. Statement files attached to the messages there are imported; other
  attachments (PDFs, images) are ignored. Mail is never changed. Tohyee
  doesn't give out email addresses of its own (there's no relay): set a rule
  in the mailbox to file the bank's emails into that folder or label.
- **When:** every feed is checked every 6 hours by default (1 to 24, as the
  Akahu feed), and with **Check now**. Each check takes every file (or
  attachment) it hasn't seen before, oldest first.
- **Seen before** means the same file name with the same contents (SHA-256)
  in that feed, or the same message and attachment name in that mailbox. A
  bank that overwrites one file (`statement.csv`) every day is read again
  whenever its contents change, and the duplicate rules (BK2) keep lines
  already on the account out, so only new lines are added.
- **CSV and Excel files are read with the account's saved column layout**
  (BK1), so the first file of a kind has to be imported by hand once. A file
  whose columns don't match the saved layout is **not imported**: it's
  listed as "Columns don't match the last file imported by hand" and tried
  again only if it changes. (A file chosen by hand works out a fresh
  layout; an automatic one doesn't guess.)
- A file that can't be read (empty, too large, an old .xls, rows that don't
  read) is listed with the reason and tried again only if it changes. A
  file with **no new lines** is recorded as seen, adds no import, and shows
  "0 new lines".
- Each file that adds lines is an **import** like one by hand, marked with
  its feed and file name, so it can be deleted (BK12) as now. Deleting it
  doesn't make the feed bring it back: the file is still seen.
- A file in a currency other than the account's is refused (FXB10). Files
  don't say which account they're for (Tohyee doesn't store bank account
  numbers), so linking the right subfolder or label is up to the admin.
- Admins set up and change feeds; anyone who can see the account sees each
  feed's last check (time, files read, lines added, problems). Changes are in
  the audit history.

Setup: as BK1 (1000 Business bank account, its column layout saved by the
BK1 import), dates in June 2026. The server admin has chosen `D:\BankFiles\
Kobe Co` as the organisation's bank files folder; an admin links 1000 to its
subfolder `ANZ business`.

- **BF1** `anz-2026-06-01.csv` arrives with three lines:

  ```
  Date,Amount,Payee,Particulars,Code,Reference
  01/06/2026,-46.00,Z ENERGY,,,
  01/06/2026,-4.50,CAFE,,,
  01/06/2026,115.00,KOBE LTD,INV-0007,,
  ```

  The next check imports it: **3** new unreconciled lines, one import
  marked "Folder feed · anz-2026-06-01.csv". Nothing is posted.
- **BF2** The next day `anz-2026-06-02.csv` holds the 1 Jun lines again plus
  `02/06/2026,-69.00,CALTEX,,,`. The check adds **1** line. A check with no
  new files reads nothing.
- **BF3** The bank overwrites `statement.csv` each day. On 3 Jun it holds the
  02/06 line and `03/06/2026,-11.50,Z ENERGY,,,`; the check adds **1**. On
  4 Jun it's the same file again, unchanged: not read. On 5 Jun it has a
  05/06 line added: read again, **1** added. Two identical lines on one day
  in a file (two `-4.50 CAFE` on 05/06) add **2** the first time and **0**
  after, as BK2.
- **BF4** `anz-export.csv` with the columns `Date,Details,Debit,Credit` (not
  the saved layout) isn't imported: it's listed "Columns don't match the last
  file imported by hand". Importing it once by hand saves the new layout;
  the next file with those columns is read by the feed.
- **BF5** `june.ofx` holds the same three 1 Jun transactions, each with the
  bank's FITID. As in BK3, a line from another kind of file that matches a
  line already on the account on date and amount is **added but flagged
  possible duplicate**: the check adds **3** flagged lines, to be excluded
  or matched (BK12). The same OFX file saved again under another name adds
  **0** (the FITIDs are on the account). An empty file and a `.xls` file are
  listed with "The file is empty." and "Older Excel files (.xls) aren't
  supported…", and tried again only when they change.
- **BF6** Deleting BF2's import removes its 1 line (none reconciled, BK12);
  the next check doesn't bring `anz-2026-06-02.csv` back. Its lines come back
  by importing the file by hand.
- **BF7** (mailbox) An admin links 1000 to the label `Bank/ANZ` of the CRM
  Gmail mailbox. A message there has `anz-2026-06-06.csv` (one new line,
  `06/06/2026,-230.00,KAURI SUPPLIES,,,`) and `statement.pdf`. The check
  imports the CSV (**1** line, marked "Mailbox feed · anz-2026-06-06.csv")
  and ignores the PDF. Checking again reads nothing new. A forwarded copy
  of the same message (a new message, the same file) adds **0** lines (BK2).
- **BF8** A check that fails (the folder can't be read, or the mailbox's
  sign-in has expired) adds nothing, keeps the files for next time, and
  shows the reason on the account; the next check after it's fixed reads
  them.
- **BF9** Only admins can link, change or remove a feed; a bookkeeper can
  press Check now; viewers see the last check. A subfolder outside the bank
  files folder (`..\Other Co`) is refused. With no bank files folder chosen
  by a server admin, folder feeds can't be set up and the page says to ask
  them.
- **BF10** Removing a feed keeps every import it made and what's been seen,
  so linking the same subfolder again doesn't import old files twice.

**Questions for Jess (automatic statement files), decided** (Jess approved
the examples and the proposed answers on 5 Oct 2026):
1. Every 6 hours by default, 1 to 24 as Akahu: **yes** (decision 385).
2. CSV and Excel files with different columns wait for a person (BF4);
   Tohyee doesn't guess: **yes** (decision 387).
3. A server admin chooses each organisation's bank files folder, as for
   Analytics, and organisation admins pick subfolders of it (BF9): **yes**
   (decision 386).

Tests: `tests/integration/bank-file-feeds.test.ts`.

Not supported yet (refused rather than guessed): zipped statement files;
Tohyee's own email addresses (no relay); checking a file's account number
against the bank account; moving or deleting files after reading them.

### SimpleFIN bank feeds (approved by Jess, 5 Oct 2026)

Stage 1b, part 2, of the Xero add-ons plan. SimpleFIN is an open protocol
(simplefin.org/protocol.html). Its **SimpleFIN Bridge** reaches banks through
an aggregator; Actual Budget uses it. Jess won't run a relay, so each
organisation pays for and sets up its **own** Bridge account (US$1.50 a
month or US$15 a year, as the Bridge says on 5 Oct 2026), the way each
organisation has its own Akahu app (BK15). Like Akahu, it's a feed: lines
arrive unreconciled and nothing is posted.

How it works (checked against the protocol page, the Bridge's developer
guide and its public demo on 5 Oct 2026):

- In the Bridge, the organisation connects its banks and makes a **setup
  token**. An admin pastes it into Tohyee once. Tohyee claims it (the token
  works only once) and keeps the **access URL** it gets back, encrypted like
  Akahu's tokens. One SimpleFIN connection per organisation (Jess: one
  connection per provider).
- The admin links a SimpleFIN account to a Tohyee bank or credit card
  account with a start date, as BK15. One account can't be linked twice.
- **Currency:** each SimpleFIN account says its currency (ISO code). It must
  be the Tohyee account's currency: the base currency, or the account's own
  currency for a foreign-currency account (FXB10). Unlike Akahu, a USD
  account in a NZD organisation can link to a USD bank account.
- Each transaction has an `id`, a `posted` time, an `amount` (money in is
  positive) and a `description`, and may have a `payee`, a `memo` and
  `pending`. A line gets the description, the payee and the memo (as its
  particulars). **Pending transactions are left out** until they post, as
  BK15. Lines carry `simplefin:<account id>:<transaction id>`, because the
  demo reuses the same transaction id in two accounts.
- **The date:** `posted` is a moment in time, not a date (the demo's are at
  08:00 and 16:00 UTC). A line's date is that moment's date **in the time
  zone chosen when the account is linked**, defaulting to the organisation's
  own (Pacific/Auckland). For a US bank choose its zone (e.g.
  America/Los_Angeles); see question 2.
- **The Bridge's limits:** at most 90 days per request and 24 requests a
  day (its developer guide), with some allowance while setting up. One sync
  asks for every linked account in one request, in 90-day pieces from the
  start date the first time, then from 10 days before the last line (late
  postings are caught, and lines already here are skipped, BK2). Syncs run
  every 6 hours by default (1 to 24, as Akahu) at a minute picked at random
  per organisation, as the guide asks. **Sync now** is refused, saying when
  it can run, once Tohyee has made 20 requests in the last 24 hours, leaving
  room for the schedule.
- The account's `balance` with its `balance-date` is kept as the statement
  balance (BK16).
- Problems the Bridge reports (`errlist`, e.g. a bank that needs signing in
  again) are shown on the connection and on each affected account. Lines
  the Bridge did return are still added.

Setup: as BK1, base currency NZD, 1000 Business bank account and a USD bank
account 1020 (FXB setup). The organisation's Bridge connects "Chase" with
two accounts, `ACT-1` Checking (USD) and `ACT-2` Savings (USD).

- **SF1** An admin pastes a setup token. Tohyee claims it, stores the access
  URL encrypted and lists the two accounts with their names, currencies and
  balances. Pasting the same token again is refused: "This setup token has
  been used. Make a new one in SimpleFIN Bridge." Nothing is posted; the
  audit history says who connected.
- **SF2** Linking `ACT-1` (USD) to 1000 (NZD) is refused: "SimpleFIN says
  this account is in USD; 1000 is in NZD." Linking it to 1020 (USD) with a
  start date of 1 Sep 2026 and the zone America/Los_Angeles works.
- **SF3** The first sync gets, for `ACT-1`:
  `{id "T1", posted 1788336000, amount "-10.00", description "Fishing bait",
  payee "John's Fishin Shack", memo "JOHNS FISHIN SHACK BAIT"}`,
  `{id "T2", posted 1788364800, amount "-130.00", description "Grocery store"}`
  and `{id "T3", amount "-20.00", pending true}`. Two lines are added to
  1020 in USD: -10.00 dated **2 Sep 2026** (01:00 in Los Angeles) and
  -130.00 dated **2 Sep 2026** (09:00 in Los Angeles; it would be 3 Sep in
  Pacific/Auckland). T3 isn't added. Syncing again adds none.
- **SF4** Next day T3 posts as `{id "T3", posted 1788451200, amount
  "-20.00"}`: the sync adds it (3 Sep). A transaction the bank changes after
  it posted (same id, new amount) is not changed: lines are kept as first
  received, as with Akahu (BK15), and the new amount isn't added twice.
- **SF5** A start date of 1 Jan 2026 on 5 Oct 2026 is 277 days back: the
  first sync makes 4 requests (90 + 90 + 90 + 7 days). A bank that has less
  history returns less; Tohyee adds what it gets and says from which date.
- **SF6** The Bridge's balance for `ACT-1`, "25401.15" dated 5 Oct 2026 00:00 UTC, is kept
  as 1020's statement balance (USD 25,401.15) with its date, shown next to
  the balance in Tohyee (FXB7).
- **SF7** A USD CSV for 1020 imported before linking had -10.00 on 2 Sep. The
  feed's -10.00 on 2 Sep is added and flagged as a possible duplicate (BK3,
  BK15), to be excluded or matched.
- **SF8** The response has `errlist: [{code "con.auth", msg "Chase needs you
  to sign in again", conn_id "CON-1"}]`. The connection and 1020 show
  "SimpleFIN: Chase needs you to sign in again (fix it in SimpleFIN
  Bridge)". Lines returned for other connections are added; 1020's last
  sync is marked failed.
- **SF9** An amount with more than 2 decimal places (`"-1.005"`), a missing
  amount or a currency that isn't the account's makes that one transaction
  skipped and listed with the reason; the rest of the sync goes ahead.
- **SF10** Disconnecting deletes the stored access URL and unlinks every
  account. Lines and their reconciliations stay; nothing posted changes.
  Connecting again with a new token and relinking adds no line twice (the
  ids are the same).

Only admins connect, link, unlink and disconnect; bookkeepers press Sync now;
viewers see the last sync, as BK15.

Tests: `tests/integration/bank-simplefin.test.ts`.

**Questions for Jess (SimpleFIN), decided** (Jess approved the examples
and chose the proposed answers on 5 Oct 2026):
1. Offer SimpleFIN for organisations with US or other overseas accounts; NZ
   banks stay with Akahu (the Bridge's own pages don't list countries, and
   Tohyee hasn't checked which NZ or Australian banks it reaches).
2. A line's date is the `posted` moment's date in a time zone chosen per
   linked account, defaulting to the organisation's (SF3).
3. Lines are kept as first received when the bank changes a posted
   transaction (SF4), as with Akahu.
4. Sync now is refused after 20 requests in 24 hours (the Bridge allows 24).

Not supported (refused rather than guessed): pending transactions,
investment holdings (the demo returns them; they're ignored), custom
currencies (SimpleFIN allows a URL instead of an ISO code), and checking
SimpleFIN account numbers against Tohyee's.

### Stripe as a bank feed (approved by Jess, 5 Oct 2026)

Stage 1b, part 3, of the Xero add-ons plan. Like Xero's Stripe feed, an
organisation's **Stripe balance is a bank account in Tohyee** (e.g. 1050
Stripe), and everything that changes the balance arrives as statement lines:
charges, Stripe's fees, refunds, disputes and payouts to the bank. Nothing
is posted. Lines are reconciled as any others: a charge matched to the
invoice it paid (BK4, one-click matching BK17), fees coded with a bank rule,
a payout reconciled as a transfer to the bank account the money landed in.
Taking invoice payments through Stripe (Checkout, payment links) is stage 4,
not this.

How it works (checked against Stripe's API reference on 5 Oct 2026):

- The organisation creates a **restricted API key** in its own Stripe
  dashboard with read access only, and an admin pastes it into Tohyee. It's
  checked with Stripe, then stored encrypted. One Stripe connection per
  organisation (Jess: one connection per provider). See question 1.
- Stripe keeps a balance per currency. The admin links each balance currency
  to a Tohyee bank account in that currency (usually just NZD to 1050).
- Tohyee reads Stripe's **balance transactions**
  (`GET /v1/balance_transactions`). Each has a gross `amount`, a `fee` and
  its breakdown `fee_details` (types `stripe_fee`, `application_fee`,
  `payment_method_passthrough_fee`, `tax`, `withheld_tax`), a `net`, a
  `currency`, a `type` (`charge`, `refund`, `payout`, `adjustment`,
  `stripe_fee`, ...), a `created` time and a `status` (`pending` or
  `available`). Amounts are in cents (the currency's smallest unit).
- **Each balance transaction becomes one line for its gross amount, plus one
  line for each kind of fee**, so fees can be coded separately, the way Xero
  shows them. Lines carry `stripe:<transaction id>` (and `:fee`, `:tax` for
  fee lines). Every balance transaction is brought in, whatever its type, so
  the lines always add up to the change in Stripe's balance.
- **Foreign cards:** Stripe converts the charge into the balance currency
  before it reaches the balance. The line is in the balance currency, and
  its description says the original amount and Stripe's rate.
- **Dates:** a line's date is the `created` time's date in the
  organisation's time zone (question 4). Pending transactions come in when
  created (question 2).
- The statement balance is Stripe's balance for that currency (`GET
  /v1/balance`: available plus pending).
- Syncs run every 6 hours by default (1-24) and with Sync now. Each asks for
  transactions created since a day before the last line; lines already here
  are skipped (BK2).

Setup: base currency NZD, 1000 Business bank account (Akahu feed), a new bank
account 1050 Stripe (NZD), Kobe Ltd with INV-0010 for 115.00 due.

- **ST1** An admin pastes a restricted key `rk_live_...` with read access.
  Tohyee checks it with Stripe (it can read the balance), stores it
  encrypted and shows the balance currencies: NZD. A full secret key
  (`sk_live_...`, which can move money) is refused: "Use a restricted key
  with read access only." The audit history says who connected.
- **ST2** Linking the NZD balance to 1000 is allowed (both NZD), but the
  admin links it to 1050. Linking it to a USD account is refused: "Stripe's
  balance is in NZD; 1020 is in USD."
- **ST3** Kobe Ltd pays INV-0010 by card on 1 Oct 2026 at 10:15. Stripe's
  balance transaction: `{id "txn_1", type "charge", amount 11500, fee 341,
  fee_details [{type "stripe_fee", amount 341}], net 11159, currency "nzd",
  created 1 Oct 10:15 NZDT, status "pending", description "Payment for
  INV-0010"}`. Two lines on 1050, both 1 Oct: **+115.00** "Payment for
  INV-0010" (`stripe:txn_1`) and **-3.41** "Stripe fees" (`stripe:txn_1:fee`).
  The +115.00 line can be matched to INV-0010 with OK (BK17). Syncing again
  adds none.
- **ST4** A US customer pays USD 50.00. Stripe converts it at 1.70:
  `{id "txn_2", type "charge", amount 8500, fee 305, currency "nzd",
  exchange_rate 1.7}`. Lines: **+85.00** "Charge (USD 50.00 at 1.7)" and
  **-3.05** "Stripe fees". The line is NZD; there's no foreign amount to
  revalue, because Stripe already converted it.
- **ST5** INV-0010 is refunded in full on 3 Oct: `{id "txn_3", type
  "refund", amount -11500, fee 0}`. One line, **-115.00**. Stripe doesn't
  give back the 3.41 fee in this example (it shows `fee 0` on the refund),
  so no fee line.
- **ST6** A customer disputes the txn_2 charge on 6 Oct: `{id "txn_4", type
  "adjustment", reporting_category "dispute", amount -8500, fee 2500}`. Lines:
  **-85.00** "Dispute" and **-25.00** "Stripe fees". If the dispute is won,
  a later `{type "adjustment", reporting_category "dispute_reversal", amount
  8500, fee 0}` adds **+85.00**. Whatever Stripe charges or returns is what
  comes in; Tohyee doesn't work fees out itself.
- **ST7** A charge on 7 Oct whose fee includes tax: `{id "txn_5", type
  "charge", amount 10000, fee 345, fee_details [{type "stripe_fee", amount
  300}, {type "tax", amount 45}]}`. Lines: **+100.00**, **-3.00** "Stripe
  fees" and **-0.45** "Tax on Stripe fees" (`stripe:txn_5:tax`). Tohyee doesn't decide whether that tax is GST you can
  claim: you code the line (Stripe's NZ help says GST applies to "certain"
  Stripe fees and sends a monthly tax invoice for it; see question 3).
- **ST8** Stripe pays out on 8 Oct: `{id "txn_6", type "payout", amount
  -5000, fee 0}`. Line on 1050: **-50.00** "Payout to bank". The Akahu feed
  brings **+50.00** "STRIPE" into 1000 the next day. The two are
  reconciled as one transfer from 1050 to 1000 (BK transfers), so the
  payout isn't counted as income twice.
- **ST9** After ST3-ST8 (the dispute not yet decided), the eleven lines on
  1050 add up to 115.00 - 3.41 + 85.00 - 3.05 - 115.00 - 85.00 - 25.00 +
  100.00 - 3.00 - 0.45 - 50.00 = **15.09**, the change in Stripe's NZD
  balance (each transaction's `net` added up: 111.59 + 81.95 - 115.00 -
  110.00 + 96.55 - 50.00 = 15.09). Stripe's own balance (available plus
  pending) is kept as 1050's statement balance, so the bank reconciliation
  report (BK20) shows any gap.
- **ST10** Disconnecting deletes the stored key. Lines and reconciliations
  stay. Connecting again (a new key) and relinking adds no line twice: the
  ids are Stripe's.

Only admins connect, link, unlink and disconnect; bookkeepers press Sync now;
viewers see the last sync, as BK15.

**Questions for Jess (Stripe), decided** (Jess approved the examples and
chose the proposed answers on 5 Oct 2026):
1. Only **restricted keys** are accepted; full secret keys (`sk_...`) are
   refused, since they could move money. The exact permission names for
   reading balance transactions haven't been checked with a real account.
2. **Pending** transactions come in when they're created.
3. The **tax part of Stripe's fees** is its own line (ST7) and the GST code
   is left to the person reconciling it.
4. A line's date is the `created` time's date in the **organisation's time
   zone**.

Each link also has a first date to bring in, as Akahu's (BK15).

Tests: `tests/integration/bank-stripe.test.ts`.

Not supported (refused rather than guessed): taking payments (stage 4),
Stripe Connect platform fees paid to you as a platform, Stripe Issuing
cards, and looking up each charge's customer name (one more request per
charge; the description is used instead).

### PayPal as a bank feed (approved by Jess, 5 Oct 2026)

Stage 1b, part 4, of the Xero add-ons plan. As with Stripe (ST1-ST10), an
organisation's **PayPal balance is a bank account in Tohyee** (e.g. 1060
PayPal), and everything that changes it arrives as statement lines:
payments received, PayPal's fees, refunds, chargebacks, currency
conversions and withdrawals to the bank. Nothing is posted. Taking invoice
payments through PayPal is stage 4, not this.

How it works (checked against PayPal's Transaction Search API specification,
`paypal/paypal-rest-api-specifications` on GitHub, and its transaction event
code reference, on 5 Oct 2026):

- The organisation creates a REST app in its own PayPal developer dashboard
  (live, not sandbox), turns on Transaction Search for it, and an admin
  pastes its **client ID and secret** into Tohyee. Tohyee gets a token with
  them (OAuth client credentials), checks it can read the balances
  (`GET /v1/reporting/balances`, scope `reporting/balances/read`), and
  stores the secret encrypted. One PayPal connection per organisation. The
  secret can also send payments through other PayPal APIs; PayPal has no
  read-only key like Stripe's, so this is the only way (see question 1).
- PayPal keeps a balance per currency. The admin links each currency to a
  Tohyee bank account in that currency (usually NZD to 1060; a USD balance
  to a USD account).
- Tohyee reads `GET /v1/reporting/transactions` (scope
  `reporting/search/read`, `fields=all`), at most **31 days per request**
  (PayPal's limit), for each linked currency. PayPal says a transaction can
  take **up to three hours** to appear, and keeps three years.
- Each transaction has a `transaction_id`, a five-character
  `transaction_event_code` (`T0006` checkout payment, `T0007` standard
  payment, `T01xx` fees, `T0200` currency conversion, `T0400` withdrawal to
  a bank, `T1107` refund, `T1201` chargeback, `T15xx` holds), a gross
  `transaction_amount`, a `fee_amount`, a `transaction_status` (`S`
  completed, `P` pending, `D` denied, `V` reversed), a
  `transaction_initiation_date` in **the PayPal account's own time zone**,
  and may have `transaction_subject`, `invoice_id` and the payer's name.
- **Each transaction becomes one line for its gross amount and, when there's
  a fee, one line for it**, as Stripe (ST3). Charged fees are debits and
  refunded fees credits (PayPal's event code reference); the line keeps
  PayPal's sign. Lines carry `paypal:<transaction id>` (and `:fee`). The
  line's payee is the payer's name, its description the subject (or what
  the event code means), its reference the `invoice_id`.
- **Dates:** the date part of `transaction_initiation_date`, as PayPal
  expresses it (the account's own time zone, as on PayPal's statements).
- **Pending and denied** transactions are left out until PayPal completes
  them (question 2). Reversed ones (`V`) are kept: the reversal comes as
  its own transaction.
- The statement balance is PayPal's `total_balance` for that currency.
- Syncs run every 6 hours by default (1-24) and with Sync now, from three
  days before the last line (PayPal's delay), skipping lines already here
  (BK2).

Setup: base currency NZD, 1000 Business bank account (Akahu feed), 1060
PayPal (NZD), 1070 PayPal USD (USD), Kobe Ltd with INV-0011 for 115.00 due.

- **PP1** An admin pastes the client ID and secret. Tohyee gets a token,
  reads the balances (NZD 0.00, USD 0.00) and stores the secret encrypted;
  the client ID is shown, the secret never. A wrong secret is refused with
  PayPal's message. A sandbox app's credentials are refused: "Use the live
  app's client ID and secret."
- **PP2** NZD links to 1060 and USD to 1070. Linking NZD to 1070 is refused:
  "PayPal's balance is in NZD; 1070 is in USD."
- **PP3** Kobe Ltd pays INV-0011 on 1 Oct 2026:
  `{transaction_id "1AB", transaction_event_code "T0006",
  transaction_initiation_date "2026-10-01T10:15:00+1300",
  transaction_amount {NZD "115.00"}, fee_amount {NZD "-4.12"},
  transaction_status "S", invoice_id "INV-0011", payer "Kobe Ltd"}`. Lines
  on 1060, 1 Oct: **+115.00** (payee Kobe Ltd, reference INV-0011) and
  **-4.12** "PayPal fees". The +115.00 can be matched to INV-0011 with OK
  (BK17).
- **PP4** A full refund on 3 Oct: `{T1107, transaction_amount "-115.00",
  fee_amount "3.82"}`. Lines: **-115.00** "Refund" and **+3.82** "PayPal
  fees" (PayPal returned part of the fee). Whatever PayPal returns is what
  comes in.
- **PP5** USD 200.00 is converted to NZD on 4 Oct: PayPal gives two
  `T0200` transactions, `-200.00 USD` and `+320.00 NZD`. 1070 gets
  **-200.00** and 1060 **+320.00**, each "Currency conversion". They reconcile as one
  transfer between 1070 and 1060 with both amounts (as FXB transfers).
- **PP6** A chargeback on 6 Oct: `{T1201, "-60.00"}` and PayPal's chargeback
  fee `{T0106, "-20.00"}` as its own transaction. Lines: **-60.00**
  "Chargeback" and **-20.00** "Chargeback fee".
- **PP7** A withdrawal to the bank on 8 Oct: `{T0400, "-100.00"}`. Line on
  1060: **-100.00** "Withdrawal to bank"; the Akahu feed brings **+100.00**
  into 1000; they reconcile as one transfer (as ST8).
- **PP8** An eCheck payment `{T0006, "50.00", status "P"}` isn't brought in.
  When PayPal completes it (`S`), the next sync adds it, dated as PayPal
  dates it. A denied one (`D`) never comes in.
- **PP9** The lines on 1060 after PP3-PP7 (115.00 - 4.12 - 115.00 + 3.82 +
  320.00 - 60.00 - 20.00 - 100.00 = **139.70**) are the change in PayPal's
  NZD balance; PayPal's `total_balance` is kept as the statement balance, so
  the bank reconciliation report (BK20) shows any gap.
- **PP10** Disconnecting deletes the secret. Lines stay. Connecting again and
  relinking adds no line twice: the ids are PayPal's.

Only admins connect, link, unlink and disconnect; bookkeepers press Sync now;
viewers see the last sync, as BK15.

**Questions for Jess (PayPal), decided** (Jess approved the examples and
chose the proposed answers on 5 Oct 2026):
1. The client secret is accepted although PayPal has no read-only
   credentials: stored encrypted, used only for Transaction Search and
   balances, and the connect screen says so plainly.
2. Pending and denied transactions are left out until PayPal completes them
   (PP8).
3. Holds come in like everything else, so the lines add up to PayPal's
   balance.
4. Lines are dated as PayPal dates them (the PayPal account's own time zone).

Each link also has a first date to bring in, as Akahu's (BK15).

Tests: `tests/integration/bank-paypal.test.ts`.

Not checked with a real PayPal account: the sign PayPal uses on
`fee_amount` (its reference says charged fees are debits), whether
Transaction Search is on by default for a new app, and how the sandbox is
told apart (Tohyee would use PayPal's live API address only).

Not supported (refused rather than guessed): taking payments (stage 4),
PayPal Here card readers' settlement details, and PayPal accounts the
organisation doesn't own (partner access).

### Wise as a bank feed (approved by Jess, 5 Oct 2026)

Stage 1b, part 5, the last of the Xero add-ons plan's bank feeds. Each
currency balance in an organisation's **Wise business account** is a bank
account in Tohyee (e.g. 1080 Wise NZD, 1090 Wise USD), and Wise's balance
statement for it arrives as statement lines: money received, card payments,
transfers out, conversions between currencies, and Wise's fees. Nothing is
posted.

How it works (checked against Wise's API reference and its personal API
token guide, docs.wise.com, on 5 Oct 2026):

- An admin creates a **personal API token** in the organisation's own Wise
  business account (Your account → Connect and manage apps → API tokens)
  and pastes it into Tohyee, which stores it encrypted. Wise lets balance
  statements be read with a personal token only for accounts **based in the
  US, Canada, Australia, New Zealand, Singapore or Malaysia**; elsewhere
  (the EU and UK) it needs signing Tohyee can't do with a personal token, so
  those accounts are refused with Wise's reason. The same token can also
  create and fund transfers (Wise has no read-only token); see question 1.
- Tohyee lists the token's business profile (`GET /profiles`) and its
  currency balances (`GET /profiles/{id}/balances?types=STANDARD`), and the
  admin links each currency to a Tohyee bank account in that currency.
- Tohyee reads each linked balance's statement
  (`GET /profiles/{id}/balance-statements/{balanceId}/statement.json`), at
  most 469 days per request (Wise's limit). Each transaction has a `type`
  (`DEBIT` or `CREDIT`), a `date` (UTC), an `amount` (negative for debits),
  `totalFees`, `details` (its kind: `CARD`, `CONVERSION`, `DEPOSIT`,
  `TRANSFER`, `MONEY_ADDED`, `DIRECT_DEBIT`, `BALANCE_INTEREST`, ...; a
  description; the sender's name and payment reference for money received;
  the merchant for card payments; amounts and rate for conversions), a
  `runningBalance` after it, and Wise's unique `referenceNumber`.
- **Each transaction becomes a line, and its fee its own line** (question 3),
  when Wise's running balance confirms how: if the balance moved by the
  amount, the amount includes the fee, so the line is the amount less the
  fee; if it moved by the amount less the fee, the line is the amount as
  given. Either way the fee line is the fee and the lines add up to what
  Wise took from or added to the balance. Each line keeps Wise's running
  balance. Lines carry
  `wise:<referenceNumber>` (and `:fee`). The payee is the sender's name or
  the merchant, the reference the payment reference.
- **Dates:** the transaction's date in the organisation's time zone
  (question 4).
- The statement balance is Wise's balance for that currency.
- Syncs run every 6 hours by default (1-24) and with Sync now, from three
  days before the last line, skipping lines already here (BK2).

Setup: base currency NZD, 1080 Wise NZD (NZD), 1090 Wise USD (USD); Acme Inc
owes USD 500.00 on INV-0012; Kauri Supplies is owed 400.00 on bill B7.

- **WI1** An admin pastes the token. Tohyee reads the business profile and
  its balances (NZD, USD), stores the token encrypted, and never shows it
  again. A token for an account based outside those six countries is
  refused when the first statement is read, with Wise's message and what it
  means.
- **WI2** NZD links to 1080, USD to 1090; NZD to 1090 is refused: "Wise's
  balance is in NZD; 1090 is in USD."
- **WI3** Acme pays INV-0012 into the USD account details on 1 Oct 2026:
  `{type CREDIT, amount USD 500.00, totalFees 0.00, details {type DEPOSIT,
  senderName "ACME INC", paymentReference "INV-0012"}, referenceNumber
  "DEPOSIT-111"}`. One line on 1090: **+500.00** (USD), payee ACME INC,
  reference INV-0012, matchable to INV-0012 (BK17).
- **WI4** USD 300.00 is converted to NZD on 2 Oct: the USD statement has
  `{DEBIT, amount -300.00, totalFees 2.25, details {CONVERSION, sourceAmount
  USD 300.00, targetAmount NZD 489.12, fee USD 2.25, rate 1.6427}}` and the
  NZD statement `{CREDIT, amount 489.12}`. Lines: 1090 **-297.75** "Converted
  USD to NZD" and **-2.25** "Wise fees"; 1080 **+489.12**. The -297.75 and
  +489.12 reconcile as one transfer with both amounts (FXB transfers); the
  fee is coded to bank fees.
- **WI5** A card payment in NZD on 3 Oct: `{DEBIT, -46.00, details {CARD,
  merchant {name "Z Energy"}}}`. Line on 1080: **-46.00**, payee Z Energy.
- **WI6** A card payment abroad on 4 Oct: AUD 20.00 charged to the NZD
  balance as `{DEBIT, -22.45, totalFees 0.20, exchangeDetails {forAmount AUD
  20.00}}`. Lines: **-22.25** "Card payment (AUD 20.00)" and **-0.20** "Wise
  fees".
- **WI7** Bill B7 is paid by Wise transfer on 6 Oct: `{DEBIT, -404.10,
  totalFees 4.10, details {TRANSFER, description "To Kauri Supplies"}}`.
  Lines: **-400.00** (matchable to B7) and **-4.10** "Wise fees".
- **WI8** If Tohyee can't confirm it (the first transaction it reads has no
  earlier running balance to compare with, or neither way adds up), the
  amount comes in as one line, with no fee line, and the line says "Wise fee
  0.20 not split: Wise's running balance couldn't confirm it", so someone
  checks it against Wise. (Corrected after approval, 5 Oct 2026: as first
  written, WI8 said the lines would still add up to Wise's balance, which
  isn't so if Wise's amount leaves the fee out; the running balance now
  settles both cases.)
- **WI9** After WI3-WI7, 1080's lines are 489.12 - 46.00 - 22.25 - 0.20 -
  400.00 - 4.10 = **16.57** and 1090's 500.00 - 297.75 - 2.25 =
  **200.00**, each the change in that Wise balance, which is kept as the
  statement balance.
- **WI10** Disconnecting deletes the token. Lines stay. Connecting again and
  relinking adds no line twice: Wise's reference numbers are the same.

Only admins connect, link, unlink and disconnect; bookkeepers press Sync now;
viewers see the last sync, as BK15.

**Questions for Jess (Wise), decided** (Jess approved the examples and chose
the proposed answers on 5 Oct 2026):
1. The personal token is accepted although it isn't read-only: stored
   encrypted, used only to read profiles, balances and statements, and the
   connect screen says so plainly.
2. Only accounts based in the US, Canada, Australia, New Zealand, Singapore
   or Malaysia; others are refused with Wise's reason.
3. Wise's fee is split onto its own line when the running balance confirms
   how (WI4, WI6, WI7), and left in one line with a note when it can't
   (WI8).
4. Lines are dated in the organisation's time zone.

Each link also has a first date to bring in, as Akahu's (BK15).

Tests: `tests/integration/bank-wise.test.ts`.

Not supported (refused rather than guessed): Wise savings ("jars") balances,
Wise accounts based outside the six countries above, and sending or funding
transfers from Tohyee.

### One-click matching ("OK") (examples not yet approved by Jess)

Like Xero's "OK" button. For each unreconciled line, Tohyee looks for
**candidates with the line's exact amount**:

- a posted journal line on the line's account, on the same side (money in is
  a debit), not reconciled, dated within 60 days of the line, and not a
  reversal or reversed (a voided payment's lines never count); and
- for money in, an approved invoice whose amount due is exactly the line's
  amount; for money out, an approved bill whose amount due is exactly the
  line's amount (without its minus sign). The invoice or bill must be dated on
  or before the line, since a payment can't be dated before it.

The suggestion is **confident**, and shown highlighted with an **OK** button,
when the line has exactly one candidate and no other unreconciled line on the
same account has that candidate too. When a line has no candidates at all, a
bank rule that applies (BK10) is a confident suggestion. Anything else shows
no OK button: two or more candidates (a tie) are listed on the line to choose
from, and two lines competing for one candidate are left for a person to
decide. OK posts exactly what choosing the suggestion by hand posts (BK4, BK5,
BK10), through the same reconcile command.

- **BK17** After BK1: the +115.00 line has one candidate, INV-0001 (115.00
  due, dated 10 May): confident, "Pay INV-0001". The -46.00 line has no
  candidates and no rule: no suggestion; with the BK10 rule it's confident
  (spend money to Z Energy, 6120). The -500.00 line has none. Then:
  - a second approved invoice to Kobe Ltd for 115.00 (INV-0002, 12 May) makes
    the +115.00 line a **tie** (2 candidates): no OK;
  - instead, a second +115.00 line on 25 May makes both lines **compete** for
    INV-0001: neither has an OK;
  - a customer payment of 115.00 into 1000 on 19 May (INV-0001 is then paid)
    makes the payment's journal line the one candidate: confident "match";
    once that payment is voided it's no longer a candidate;
  - with the BK10 rule, a spend money of 46.00 to Z Energy already posted on
    21 May wins over the rule: the suggestion is to match it, so nothing is
    posted twice;
  - an invoice for 115.00 dated 21 May (after the 20 May line) is not a
    candidate.
- **BK18** OK on the +115.00 line, shown as "Pay INV-0001", records a
  customer payment of 115.00 dated 20 May into 1000 (Dr 1000 115.00 / Cr 1100
  115.00) and reconciles the line; INV-0001 is paid. OK on the -46.00 line
  with the BK10 rule posts Dr 6120 40.00 / Dr 2100 6.00 / Cr 1000 46.00. If
  the suggestion shown has changed (e.g. INV-0001 was paid meanwhile), OK is
  refused (409) and nothing is posted. Retrying with the same key returns the
  same reconciled line. Viewers can't OK (403).
- **BK19** "OK all confident matches" on 1000 after BK1 with the BK10 rule and
  the period locked up to 20 May: the -46.00 line is reconciled (succeeded);
  the +115.00 line is refused with "2026-05-20 is in a locked period (locked
  up to 2026-05-20)…" (failed); the -500.00 line isn't included (not
  confident). The result is **1 succeeded, 1 failed**, each line in its own
  transaction, so the failure doesn't undo the success. Retrying the same
  request returns the -46.00 line as already done and posts nothing more.

### Bank reconciliation report (examples not yet approved by Jess)

For one bank or credit card account as at a date (Reporting › Bank
reconciliation, also linked from the account). It posts nothing.

- **Balance in Tohyee**: the account's journal lines dated on or before the
  date (debits less credits).
- **In the bank, not yet in Tohyee**: unreconciled statement lines dated on
  or before the date, plus any part of a reconciled line (dated on or before
  it) that was matched to a journal line dated after it.
- **In Tohyee, not yet on the statement**: the account's journal lines dated
  on or before the date that aren't reconciled to a statement line dated on
  or before it (unpresented payments, deposits not yet cleared). A payment
  reconciled to a line after the date is still listed, with that line's date.
  A payment or bank transaction voided on or before the date isn't listed
  when neither it nor its reversal is reconciled, since the two cancel out.
- **Statement balance these explain** = balance in Tohyee + in the bank not
  in Tohyee - in Tohyee not on the statement.
- **Statement balance**: Tohyee doesn't store a statement's closing balance,
  so it's worked out from the latest of (a) the bank's running balance on the
  latest statement line (not deleted) dated on or before the date that has
  one, the last brought in that day, taken as that day's closing balance, and
  (b) the bank feed's balance (BK16), as at the end of the New Zealand day it
  was fetched, if that's on or before the date; plus the unreconciled and
  reconciled lines dated after it up to the date. With neither it's **not
  known**. Excluded lines are never added (they're duplicates or not the
  organisation's), though an excluded line's running balance still counts,
  since it's the bank's figure.
- **Not explained** = statement balance - the balance the items explain. The
  report says "Fully explained" only when that's 0.00.

Setup as above, with this statement imported into 1000 (it has the bank's
running balance):

```
Date,Amount,Payee,Particulars,Code,Reference,Balance
01/05/2026,1000.00,J KELLY,CAPITAL,,,1000.00
20/05/2026,115.00,KOBE LTD,INV-0001,,,1115.00
21/05/2026,-46.00,Z ENERGY,,,,1069.00
28/05/2026,-12.00,MONTHLY FEE,,,,1057.00
02/06/2026,-230.00,KAURI SUPPLIES,K-100,,,827.00
```

In Tohyee: a manual journal on 1 May, Dr 1000 1,000.00 / Cr 3000 1,000.00,
matched to the 1 May line; INV-0001 paid from the 20 May line (BK5); the
BK6 spend money from the 21 May line; a supplier payment of B1, 230.00 on
30 May from 1000, matched to the 2 June line; and receive money of 57.50
from Kobe Ltd on 31 May (4000, GST inclusive), not reconciled. The 28 May fee
isn't reconciled.

- **BK20** As at 31 May 2026: balance in Tohyee **896.50** (1,000.00 +
  115.00 - 46.00 - 230.00 + 57.50). In the bank, not in Tohyee: 28 May
  MONTHLY FEE **-12.00**. In Tohyee, not on the statement: the 30 May
  supplier payment **-230.00** (on the statement 2 June) and the 31 May
  receive money **57.50**, total **-172.50**. Explained: 896.50 - 12.00 +
  172.50 = **1,057.00**. Statement balance **1,057.00**, the running balance
  on the 28 May line: fully explained. As at 30 June 2026: statement
  **827.00** (the 2 June line), Tohyee 896.50, in the bank -12.00, in Tohyee
  57.50: 896.50 - 12.00 - 57.50 = 827.00, fully explained. As at 25 May:
  statement and Tohyee both **1,069.00**, no items. A spend money of 20.00
  (6120, no GST) on 29 May, voided on 30 May, changes nothing as at 31 May
  (neither it nor the reversal is listed); as at 29 May it's listed: Tohyee
  **1,049.00**, in the bank -12.00, in Tohyee -20.00, 1,049.00 - 12.00 +
  20.00 = **1,057.00**, fully explained.
- **BK21** Where the statement balance comes from:
  - Only BK1's file (no running balances) and no bank feed: as at 31 May the
    statement balance is **not known**; the items (115.00, -46.00, -500.00,
    total -431.00) still show, explaining a statement balance of
    **-431.00**, and the report doesn't say "Fully explained".
  - The same with a bank feed balance of **69.00** fetched at 10:00 on
    21 May (New Zealand time): as at 31 May the statement balance is 69.00
    plus the one line after 21 May (-500.00) = **-431.00**, fully explained.
    As at 20 May the feed balance is later than the date, so the balance is
    not known.
  - In BK20, excluding the 28 May fee line (as if it were a duplicate): as at
    31 May the items explain **1,069.00** but the statement balance is still
    1,057.00, so **-12.00 is not explained** and the report says so.

### Bulk coding ("cash coding") (examples not yet approved by Jess)

Like Xero's cash coding. On one bank or credit card account, tick several
unreconciled lines and give them an account, a GST code (or no GST), and
optionally a contact, a description and tracking, either for all the ticked
lines at once or line by line (a line's own value wins). Saving does each line
exactly as if it were reconciled on its own as a bank transaction (BK6, BK7):
spend money for money out, receive money for money in, for the line's full
amount, dated the line date, one line to the chosen account, reconciled to
the statement line.

- With a GST code the line's amount includes GST (tax inclusive); with none
  there's no GST.
- With no contact chosen, the line's contact is the active contact whose
  name is the line's payee (or, with no payee, its description), ignoring
  case and extra spaces. With no such contact the line is refused.
- With no description, each transaction line is described as the statement
  line is.
- Each line is done in its own database transaction, so a line that's refused
  (a locked period, no account, no contact, already reconciled, on another
  account) doesn't stop the others. The result lists every line with what
  happened or why it was refused.
- Retrying the same request (same idempotency key) returns the lines already
  done without posting them again; the same key with different content is
  refused for those lines (409).

Setup as above, plus the contact ANZ, and this statement imported into 1000:

```
Date,Amount,Payee,Particulars,Code,Reference
21/05/2026,-46.00,Z ENERGY,,,
24/05/2026,-11.50,Z ENERGY,,,
26/05/2026,-69.00,Z ENERGY,,,
28/05/2026,-12.00,MONTHLY FEE,,,
```

- **BK22** Tick the three Z ENERGY lines and the MONTHLY FEE line. For all:
  6120 Motor vehicle expenses, GST, no contact, description "Fuel". For the
  MONTHLY FEE line only: 6020 Bank fees, no GST, contact ANZ, description
  "Account fee". Saving posts four spend money transactions, each reconciled
  to its line (4 succeeded, 0 failed):
  - 21 May, Z Energy, Fuel: Dr 6120 40.00 / Dr 2100 6.00 / Cr 1000 46.00;
  - 24 May, Z Energy, Fuel: Dr 6120 10.00 / Dr 2100 1.50 / Cr 1000 11.50;
  - 26 May, Z Energy, Fuel: Dr 6120 60.00 / Dr 2100 9.00 / Cr 1000 69.00;
  - 28 May, ANZ, Account fee: Dr 6020 12.00 / Cr 1000 12.00.

  They add **126.50** to the May GST return's Box 11 and **16.50** to its
  purchases GST, as four separate BK6s would. 1000's "reconcile" count is
  **0**.
- **BK23** One bad line doesn't stop the others. With the period locked up
  to 21 May, tick all four lines with 6120, GST and no contact for all:
  - 21 May: refused, "2026-05-21 is in a locked period (locked up to
    2026-05-21)…";
  - 24 May and 26 May: spend money as in BK22 (described "Z ENERGY", the
    line's own description), reconciled;
  - 28 May: refused, "No contact was chosen, and there's no contact called
    “MONTHLY FEE”…".

  The result is **2 succeeded, 2 failed**, and exactly 2 journals are
  posted. Retrying the same request posts nothing more: the 24 and 26 May
  lines come back as already done, the other two are refused again. The same
  key with 6130 instead of 6120 is refused (409) for the 24 and 26 May lines.
  After unlocking, a new request for the 21 May line (6120, GST, no
  contact) and the 28 May line (6020, no GST, contact ANZ) reconciles both.
  A line with no account, for all or its own, is refused with "Choose an
  account for this line"; a line on another account or already reconciled is
  refused; viewers can't cash code (403).

### Bank rules with several conditions and split lines (examples BR1-BR10, approved by Jess 5 Oct 2026)

Stage 1 of the Xero add-ons plan (5 Oct 2026), from Dext's supplier rules
and Xero's own bank rules. **Xero** (look and usability): a rule has
conditions joined by "all" or "any" (payee, description, reference and
other text fields with *contains*, *equals* or *starts with*, and the
amount), a contact, **fixed amount lines** taken first, and the
**remainder split by percentages** adding up to 100%. **NetSuite**
(features): its bank feed rules match on several fields and set the
account, the entity and the classification segments (Tohyee's tracking).
So a BK10 rule grows into:

- **Where and which way:** one bank or credit card account, or all of them;
  money in, money out or either (as now).
- **Conditions**, all of which or any of which must hold (up to 10):
  - a text field (payee, description, particulars, code, reference, or any
    of them) *contains*, *equals* or *starts with* some text, ignoring case
    and extra spaces;
  - the amount *equals*, *is at least*, *is at most* or *is between* two
    amounts. The amount is the line's amount without its sign (−46.00 is
    46.00), since the money-in or money-out choice already covers the sign.
- **Contact:** a chosen contact, or **"the contact named like the payee"**
  (the active contact whose name is the line's payee, or with no payee its
  description, ignoring case and extra spaces, exactly as bulk coding finds
  one, BK22).
- **Lines** (up to 20), each with an account, a GST code (or none), a
  description and tracking (one value per category, TC1-TC10):
  - **fixed amount lines** first, each a positive amount;
  - then **percentage lines** for what's left, at least one, each more
    than 0% with at most 2 decimal places, adding up to exactly 100%.
    Percentages are split in cents the way payroll allocations already are:
    each share is rounded down to the cent, and the cents left over go one
    at a time to the shares that lost the most, earliest line first on a
    tie. So the lines always add up to the statement line exactly.
  - A rule whose fixed amounts are more than the statement line **doesn't
    fit** that line; the next rule that matches and fits is used instead. A
    percentage line that comes to 0.00 (fixed amounts equal to the line) is
    left out.
- **Amounts include GST**: each line is a share of the statement line, so a
  line with a GST code works out its GST from its share (tax inclusive),
  one line at a time as on a bill, and a line without one has no GST. (A
  rule no longer has its own "amounts are" choice: "tax exclusive" couldn't
  add up to the statement line.)
- **The first rule that matches and fits wins**: lowest priority number
  first, then the oldest rule (as now). Inactive rules are ignored.
- **A rule only suggests** (Jess, 5 Oct 2026: no "post automatically"). The
  suggestion is the same spend or receive money as BK6 and BK7, posted only
  when someone clicks OK (or "OK all confident matches", BK17), and it can
  be changed before that. A suggestion still waiting for a contact (no
  contact named like the payee) isn't confident and can't be OK'd until one
  is chosen.
- Existing rules keep working as before: each becomes one text condition
  (*contains*) and one 100% line with its account and GST code (none for a
  "no tax" rule).
- Rules are settings: bookkeepers and up create, change and delete them,
  and every change is in the audit history, as now.

Setup: as the bank examples above (1000 Business bank account, 2400 Credit
card, tax code GST 15%, 2100 GST, contact Z Energy), dates in June 2026,
advanced features on with Department values **Retail** and **Wholesale**,
the default chart's **6020** Bank fees, **6120** Motor vehicle expenses,
**6150** Rent, **6170** Telephone and internet and **2800** Term loan,
contacts **Spark**, **Caltex**, **Harbour Properties**, **ANZ** and **Gull
NZ**, and this statement imported into 1000:

```
Date,Amount,Payee,Particulars,Code,Reference
02/06/2026,-115.00,SPARK,,,
03/06/2026,-230.00,SPARK,,,
04/06/2026,-69.00,CALTEX ,,,
05/06/2026,-11.50,Z ENERGY,,,
06/06/2026,-2300.00,HARBOUR PROPERTIES,,,rent
08/06/2026,-46.01,SPARK MOBILE,,,
09/06/2026,-505.00,ANZ,LOAN,,
10/06/2026,-3.00,ANZ,FEE,,
12/06/2026,-18.40,GULL,,,
```

The rules, all on any account:

| Rule | Priority | Money | Conditions | Contact | Lines (GST inclusive unless "no GST") |
| --- | --- | --- | --- | --- | --- |
| A Spark broadband | 100 | out | **all**: payee contains SPARK; amount at most 200.00 | Spark | 100% 6170, GST |
| B Fuel | 100 | out | **any**: payee contains CALTEX; payee contains Z ENERGY; payee contains GULL | named like the payee | 100% 6120, GST |
| C Rent | 100 | out | **all**: reference equals RENT; amount equals 2,300.00 | Harbour Properties | 100% 6150, GST |
| D Spark mobile | 10 | out | **all**: payee starts with SPARK MOBILE | Spark | 60% 6170 Retail, GST; 40% 6170 Wholesale, GST |
| E ANZ loan | 20 | out | **all**: payee equals ANZ | ANZ | fixed 5.00 6020, no GST; then 100% 2800, no GST |
| F ANZ fees | 30 | out | **all**: payee equals ANZ | ANZ | 100% 6020, no GST |

- **BR1** (all conditions) The 2 Jun −115.00 SPARK line gets rule A's
  suggestion: spend money to Spark, 6170, GST: **Dr 6170 100.00 / Dr 2100
  15.00 / Cr 1000 115.00**. Nothing is posted until OK. The 3 Jun −230.00
  SPARK line gets no suggestion from rule A (230.00 is more than 200.00), and
  no other rule matches it.
- **BR2** (any condition, contact from the payee) Rule B suggests, for the
  4 Jun −69.00 "CALTEX " line (trailing space ignored), spend money to
  **Caltex**: **Dr 6120 60.00 / Dr 2100 9.00 / Cr 1000 69.00**; for the 5 Jun
  −11.50 line, to **Z Energy**: **Dr 6120 10.00 / Dr 2100 1.50 / Cr 1000
  11.50**. For the 12 Jun −18.40 GULL line there's no contact called "GULL",
  so the suggestion shows 6120 and GST with "No contact called “GULL”;
  choose one", isn't confident, and OK is refused until a contact is chosen.
  Choosing Gull NZ and OK posts **Dr 6120 16.00 / Dr 2100 2.40 / Cr 1000
  18.40**.
- **BR3** (equals, amount equals) Rule C suggests, for the 6 Jun −2,300.00
  line with reference "rent" (case ignored), spend money to Harbour
  Properties: **Dr 6150 2,000.00 / Dr 2100 300.00 / Cr 1000 2,300.00**. A
  −2,300.01 line with reference RENT, or a −2,300.00 line with reference
  "RENT JUNE", doesn't match rule C ("equals" isn't "contains").
- **BR4** (percentage split with tracking, rounding) The 8 Jun −46.01 SPARK
  MOBILE line matches rules D and A; D has the lower priority number, so D's
  suggestion is used. 60% of 46.01 is 27.606 and 40% is 18.404; rounded down
  they're 27.60 and 18.40, and the cent left over goes to the first line
  (it lost 0.006, the second 0.004): **27.61** Retail and **18.40**
  Wholesale. GST on each line: 27.61 → 3.60, net 24.01; 18.40 → 2.40, net
  16.00. OK posts **Dr 6170 24.01 (Retail) / Dr 6170 16.00 (Wholesale) /
  Dr 2100 6.00 / Cr 1000 46.01**, adding **46.01** to the June GST return's
  Box 11 and **6.00** to its purchases GST. (A −115.00 SPARK MOBILE line
  would split exactly: 69.00 Retail (60.00 + GST 9.00) and 46.00 Wholesale
  (40.00 + GST 6.00).)
- **BR5** (fixed amount, then the rest) The 9 Jun −505.00 ANZ line matches
  rules E and F; E is first: **Dr 6020 5.00 / Dr 2800 500.00 / Cr 1000
  505.00**, no GST, in no GST box.
- **BR6** (a rule that doesn't fit) The 10 Jun −3.00 ANZ line matches rule
  E, but E's fixed 5.00 is more than 3.00, so E doesn't fit and rule F is
  used: **Dr 6020 3.00 / Cr 1000 3.00**. A −5.00 ANZ line fits E with
  nothing left for the percentage line, which is left out: **Dr 6020 5.00 /
  Cr 1000 5.00**.
- **BR7** (where a rule applies) Rule A limited to **2400** Credit card
  suggests nothing for any line on 1000. With rule D made inactive, the
  8 Jun SPARK MOBILE line gets rule A's suggestion instead (one 6170 line,
  46.01: Dr 6170 40.01 / Dr 2100 6.00 / Cr 1000 46.01). A money-in rule
  never matches these money-out lines.
- **BR8** (OK all) "OK all confident matches" on 1000 posts the BR1, BR2
  (Caltex and Z Energy only), BR3, BR4, BR5 and BR6 suggestions, each as its
  own spend money reconciled to its line, exactly as BR1-BR6 show. The GULL
  line (no contact) and the 3 Jun line (no rule) stay unreconciled. With the
  period locked up to 5 Jun, the 2, 4 and 5 Jun lines are refused as in
  BK13 and the others are posted.
- **BR9** (saving a rule) Refused, with nothing saved: percentage lines
  adding up to 99.99% or 100.01%; a percentage of 0 or less, or with 3
  decimal places; no percentage line; a fixed amount of 0 or less; more than
  10 conditions or 20 lines; no conditions; "between" with the first amount
  more than the second; an archived account, GST code or tracking value; a
  sales-only GST code on a money-out rule (TAO7); with Department
  **required** (TC), a line on an income or expense account without a
  Department. A viewer can't create or change rules (403).
- **BR10** (existing rules) After the upgrade, the BK10 rule ("description
  contains Z ENERGY, money out: spend money to Z Energy, 6120, GST,
  inclusive") is one condition and one 100% line, and suggests exactly the
  BK6 transaction for the −46.00 line, as before. The single-condition shape
  is still accepted when saving a rule (e.g. "Save a bank rule" while
  reconciling).

**Questions for Jess (bank rules), decided** (Jess, 5 Oct 2026: "do what
you think is best"; decisions 380-383): splits round as payroll
allocations do; amount conditions ignore the sign; a 0.00 percentage line is
left out; "the contact named like the payee" stays.

Not supported yet (refused rather than guessed): negative percentages
(Xero allows them as long as the total is 100%); rules that pay invoices or
bills, make transfers or match existing transactions (rules only make spend
and receive money); rules that post by themselves; regular expressions in
conditions; standard-rated GST on foreign-currency accounts (as FXB4).

### Small differences when matching (examples not yet approved by Jess)

Like Xero's adjustment. When matching a line (BK4) or paying invoices or
bills from it (BK5) and the amounts differ slightly (a merchant fee taken
off a deposit, a customer rounding up), the difference can be recorded in
the same step as an **adjustment** to an account the person chooses, with an
optional GST code. There's no limit on the difference, but the account must
be chosen.

- The adjustment is a bank transaction (BK6, BK7) for the difference: spend
  money when the line is less than what it's matched with (money in) or more
  than it (money out), otherwise receive money; dated the line date, one line
  to the chosen account, tax inclusive with a GST code or no GST without one,
  described as given ("Adjustment" if not). Its contact is the one chosen, or
  when paying, the first invoice's or bill's contact; when matching, a
  contact must be chosen.
- Payments are recorded for the amounts given (usually the full amount due),
  not the line's amount. The line is reconciled to the payments or matched
  journal lines **and** the adjustment, which together add up to it exactly.
- It all happens in one database transaction with the reconciliation: if
  anything is refused (a locked period, no account), nothing is posted.
- Unreconciling (BK11) leaves the payment and the adjustment; void them
  separately. The adjustment counts in the GST return like any bank
  transaction.

Setup as above (INV-0001 115.00 due, B1 230.00 due, both 10 May 2026).

- **BK24** Recording a difference:
  - A **+113.50** line on 20 May (INV-0001 less a 1.50 merchant fee). Pay
    INV-0001 **115.00** with an adjustment to 6020 Bank fees, no GST,
    "Merchant fee": a customer payment of 115.00 dated 20 May (Dr 1000
    115.00 / Cr 1100 115.00) and spend money to Kobe Ltd dated 20 May (Dr
    6020 1.50 / Cr 1000 1.50). The line is reconciled to both (115.00 -
    1.50 = 113.50). INV-0001 is **paid**, amount due **0.00**. The spend
    money is in no GST box.
  - A **+115.50** line on 20 May instead (the customer paid 0.50 over). Pay
    INV-0001 **115.00** with an adjustment to 4100 Other revenue, GST:
    receive money from Kobe Ltd of 0.50, GST inclusive: Dr 1000 0.50 / Cr
    4100 0.43 / Cr 2100 0.07. It adds **0.50** to Box 5. INV-0001 is paid
    with no overpayment.
  - A **-231.50** line on 21 May (B1 plus a 1.50 payment fee). Pay B1
    **230.00** with an adjustment to 6020, no GST: a supplier payment (Dr
    2000 230.00 / Cr 1000 230.00) and spend money to Kauri Supplies (Dr 6020
    1.50 / Cr 1000 1.50). B1 is paid.
  - Matching: a customer payment of 115.00 into 1000 on 19 May is already
    recorded. The +113.50 line on 20 May is matched to it with an adjustment
    to 6020, no GST, contact Kobe Ltd: only the spend money (Dr 6020 1.50 /
    Cr 1000 1.50) is posted, and the line is reconciled to the payment and
    the spend money.
- **BK25** What's refused, with nothing posted:
  - an adjustment with no account: "Choose the account for the 1.50
    difference.";
  - matching with an adjustment and no contact: "Choose a contact for the
    1.50 adjustment.";
  - an adjustment when the amounts already add up to the line: "…already
    add up to the line, so there's no difference for an adjustment.";
  - an adjustment with a bank transaction or a transfer;
  - an adjustment to 1100 Accounts receivable (as for any bank transaction);
  - with the period locked up to 20 May, paying INV-0001 from the +113.50
    line with an adjustment: refused, and neither the payment nor the
    adjustment is posted.

  Retrying the BK24 payment with an adjustment with the same key returns
  the reconciled line and posts nothing more; the same key with another
  account is refused (409). Unreconciling it leaves the payment and the
  spend money; after that the spend money can be voided on its own.

### One transaction on several statement lines (examples not yet approved by Jess)

Sometimes the bank shows one payment or deposit as two or more lines (a
customer's payment split into two transfers, a deposit the bank credited in
parts). **Splitting** reconciles several statement lines together against
**one** posted journal line on the account. (The other way round, one
statement line for several posted transactions, such as a deposit of several
cheques, is ordinary matching, BK4.)

- The lines must be unreconciled, on the same account, all money in or all
  money out, each dated within 60 days of the journal line, and add up to it
  **exactly**. The journal line must not be reconciled already. Nothing is
  posted.
- Each line is reconciled to **its part** of the journal line (its own
  amount). The lines stay tied together: unreconciling any one of them
  unreconciles all of them, posting nothing, and is refused if any of them
  is in a locked period.
- There's **no adjustment** (BK24) when splitting: if the lines don't add up
  to the transaction exactly, it's refused. Record the difference as its own
  bank transaction first, or match instead.
- One-click OK (BK17) never suggests a split: a line that's only part of a
  transaction has no candidate with its exact amount, so it's never
  confident, and a journal line in a split is no longer a candidate for
  anything. Bulk coding (BK22) refuses a line in a split as already
  reconciled.

Setup as above, plus receive money of **300.00** from Kobe Ltd on 20 May,
4000 Sales, no GST: Dr 1000 300.00 / Cr 4000 300.00 (journal line **J**
on 1000), and this statement imported into 1000:

```
Date,Amount,Payee,Particulars,Code,Reference,Balance
20/05/2026,200.00,KOBE LTD,PART 1,,,200.00
03/06/2026,100.00,KOBE LTD,PART 2,,,300.00
```

- **BK26** Splitting J across the 20 May +200.00 line and the 3 June
  +100.00 line posts nothing and reconciles both lines: the 20 May line to
  **200.00** of J and the 3 June line to **100.00** of J, each showing the
  split (J's 300.00 and both lines). 1000's "reconcile" count is **0**.
  The receive money can't be voided while they're reconciled ("unreconcile
  it first"). Retrying with the same idempotency key returns the same
  result and posts nothing; the same key with a different journal line is
  refused (409).
- **BK27** Refused, with nothing reconciled:
  - lines of +200.00 and +50.00 against J: "The chosen statement lines add
    up to 250.00, but the transaction is 300.00. They must add up to it
    exactly.";
  - only one line: "Choose at least two statement lines…" (match it
    instead);
  - a money-in line with a money-out line: "…all money in or all money
    out.";
  - a line on 1010, or one already reconciled, or J already reconciled;
  - a line dated more than 60 days from J;
  - with an adjustment: "An adjustment isn't available when splitting…";
  - with the period locked up to 20 May: refused ("2026-05-20 is in a
    locked period…"), and the 3 June line isn't reconciled either.
- **BK28** After BK26:
  - **Unreconciling** the 3 June line unreconciles the 20 May line too:
    both are unreconciled, nothing is posted, the receive money stays and
    can then be voided. With the period locked up to 20 May, unreconciling
    the 3 June line is refused (the 20 May line is in the locked period)
    and both stay reconciled. Retrying with the same key returns the same
    result.
  - **One-click OK**: with both lines unreconciled and J posted, neither
    line has a candidate (neither is 300.00), so neither is confident.
    After BK26, a new +300.00 line on 25 May has no candidate either (J is
    reconciled).
  - **Bulk coding** the 20 May line after BK26 is refused: "This line is
    already reconciled."
  - **Bank reconciliation report** (BK20) as at 31 May: balance in Tohyee
    **300.00**; in the bank, not in Tohyee: nothing; in Tohyee, not on the
    statement: the **100.00** of J that's on the 3 June line (shown with
    that date). Explained: 300.00 - 100.00 = **200.00**, the running balance
    on the 20 May line: fully explained. As at 30 June: nothing outstanding,
    statement and Tohyee both **300.00**. If J were dated 2 June instead (and
    the lines 30 May and 3 June), as at 31 May the 30 May line's **200.00**
    is in the bank, not in Tohyee (matched to a journal dated after the
    date).

### Foreign-currency bank accounts (examples not yet approved by Jess)

A bank or credit card account can be in a foreign currency (its currency in
the chart of accounts, e.g. USD). Following NetSuite, which keeps every
transaction in both currencies:

- **Every journal line on a foreign-currency account has both amounts**: the
  foreign amount, the NZD (base) amount and the exchange rate (NZD per 1
  unit of the foreign currency). The foreign amount is on the same side as
  the NZD amount (a debit of NZD 1,654.30 is a debit of USD 1,000.00). The
  database refuses a line on a foreign-currency account without a foreign
  amount in that currency, and a foreign amount on an NZD account. Lines
  posted before Tohyee kept foreign amounts keep only their NZD amount.
- **Rates** have up to 8 decimal places. NZD amount = foreign amount x rate,
  worked out with the full rate and rounded once to cents, half away from
  zero (R3). The database checks this for every line posted at a rate.
- An account's **foreign balance** is its opening foreign balance (below),
  if any, plus its lines' foreign amounts (debits less credits); its **NZD
  balance** is the usual ledger balance. Statement lines, matching and the
  bank reconciliation report use the foreign balance and foreign amounts;
  NZD is shown beside them.
- **Opening foreign balance.** An account that already has NZD-only
  postings needs its foreign balance entered **once**, as at a date on or
  after its last NZD-only posting, before it can take statement lines or
  new postings. It records that the NZD balance at that date is that many
  units of foreign currency; it posts nothing. Afterwards nothing can be
  posted to the account dated on or before that date. The foreign balance
  must have the same sign as the NZD balance (both zero, both money in the
  account, or both owed). Accounts with no postings don't need one.
- **The rate shown on a statement line** is the last rate used for its
  currency on or before the line's date: the latest of a rate a posted line
  in that currency was converted at (spend or receive money, a transfer
  into a foreign account, a manual journal) and a revaluation's closing rate
  for that currency (by date; on the same date, the one entered last). The
  line shows its NZD value at that rate. It's filled in and can be changed.
  With no such rate, the rate must be typed. Rates of money leaving at its
  carrying value (transfers out) aren't market rates and aren't used.
- **Spend and receive money** on a foreign account are in the account's
  currency, converted at the rate given (or the one shown). Only zero-rated
  (ZERO), exempt (EXEMPT) and no-GST (NONE) codes, or no tax code, can be
  used: standard-rated GST on foreign-currency transactions isn't supported
  yet. Several lines are allowed when each line's NZD amount (rounded on its
  own) adds up to the NZD amount of the total; otherwise it's refused. In the
  GST return and project costs they count at their NZD amounts.
- **Transfers** between an NZD account and a foreign account: the NZD side is
  what really moved, so it's given in NZD and in the foreign currency.
  - **Out of a foreign account**: the foreign amount leaves at its **carrying
    value** = the account's NZD balance x foreign amount / foreign balance, on
    the transfer date, rounded once to cents; taking everything left takes
    the whole remaining NZD balance (the weighted-average stock approach,
    W1-W4). The NZD account gets the NZD received, and the difference goes to
    **7020 Realised currency gains and losses** (a gain is a credit). A
    transfer out can't take more than the foreign balance.
  - **Into a foreign account**: booked at the NZD that left; the rate stored
    is NZD / foreign amount (8 decimal places, for information).
  - Nothing but a revaluation can be posted to a foreign account dated
    before its latest transfer out (its carrying value would change); post
    in date order.
    Transfers between two foreign-currency accounts aren't supported yet.
- **Revaluation** (F1-F7) of an account whose foreign balance is known uses
  it; typing a different foreign balance is refused. Its lines on the account
  have a foreign amount of 0.00 (only the NZD value changes) at the closing
  rate. Accounts without a known foreign balance still have it typed.
- **Imports** record each line's currency: the file's, when it says (OFX
  CURDEF, CAMT.053 Ccy, MT940 balances, a CSV or Excel currency column),
  otherwise the account's. A file in another currency is refused. **Akahu
  bank feeds can't be linked to foreign-currency accounts**: Akahu's
  transactions don't say their currency.
- **Invoices and bills** in the line's currency can be paid from it, at a rate
  (MC5, not yet approved by Jess); NZD ones can't be paid from a
  foreign-currency line, and one-click OK never suggests invoices or bills for
  one. Adjustments (BK24) aren't available on foreign-currency lines yet.

Setup as above, plus 1030 **USD account** (bank, USD), the customer Etsy and
the supplier Amazon Web Services. 1030 was set to USD before Tohyee kept
foreign amounts, and has one posting from then: a manual journal on 1 Jun
2026, Dr 1030 1,600.00 / Cr 3000 1,600.00 (USD 1,000.00 received, but only the
NZD was kept). This statement is imported into 1030 (after FXB1):

```
Date,Amount,Payee,Particulars,Code,Reference,Balance
03/07/2026,1000.00,ETSY PAYMENTS,,,,2000.00
05/07/2026,-50.00,AMAZON WEB SERVICES,,,,1950.00
10/07/2026,-500.00,TRANSFER TO NZD,,,,1450.00
20/07/2026,610.00,TRANSFER FROM NZD,,,,2060.00
05/08/2026,-2060.00,TRANSFER TO NZD,,,,0.00
```

- **FXB1** Opening foreign balance. Before it's entered, importing that file
  into 1030, or posting to 1030, is refused: "Account 1030 (USD account) has
  postings from before Tohyee kept foreign amounts. Enter its USD balance as
  at a date (its opening foreign balance) first." Entering **USD 1,000.00 as
  at 30 Jun 2026** records USD 1,000.00 = NZD **1,600.00** (1030's NZD balance
  on 30 Jun) and posts nothing; the trial balance doesn't change. 1030's
  balance is then USD 1,000.00 / NZD 1,600.00. Refused: a second opening
  balance for 1030; one dated before 1 Jun (before its last NZD-only
  posting); USD -1,000.00 (the other sign); one for 1000 (an NZD account) or
  for a USD account with no postings ("doesn't need one"); and afterwards, a
  manual journal on 1030 dated 30 Jun 2026 or earlier. Retrying with the
  same idempotency key returns the same opening balance.
- **FXB2** Receive USD 1,000.00 at 1.6543. The 3 Jul line (+1,000.00) shows no
  rate (none has been used for USD yet), so one must be typed; without it
  it's refused ("Type the exchange rate…"). Receive money from Etsy, 4000
  Sales, ZERO, at **1.6543**: NZD **1,654.30** (1,000.00 x 1.6543). Journal on
  3 Jul: Dr 1030 1,654.30 (USD 1,000.00 at 1.6543) / Cr 4000 1,654.30. The
  line is reconciled. It adds **1,654.30** to Box 5 and Box 6 of the July GST
  return. 1030: USD 2,000.00 / NZD 3,254.30.
- **FXB3** Spend USD 50.00 at 1.66. The 5 Jul line (-50.00) shows the last
  USD rate, **1.6543** (FXB2), and NZD **-82.72** (50.00 x 1.6543 = 82.715,
  rounded half away from zero). Changing the rate to **1.66**: spend money to
  Amazon Web Services, 6040 Software and subscriptions, no GST, NZD **83.00**.
  Journal on 5 Jul: Dr 6040 83.00 / Cr 1030 83.00 (USD 50.00 at 1.66). In no
  GST box. 1030: USD 1,950.00 / NZD 3,171.30. The next line now shows 1.66.
- **FXB4** What's refused on foreign-currency spend and receive money, with
  nothing posted:
  - the 5 Jul line with tax code GST: "GST on foreign-currency spend and
    receive money isn't supported yet. Use zero-rated (ZERO), exempt
    (EXEMPT) or no GST (NONE)…";
  - two lines of USD 10.01 at 1.5 (15.015 → 15.02 each, 30.04; but USD 20.02
    x 1.5 = 30.03): "…the lines come to NZD 30.04 but the total is NZD
    30.03…". Two lines of USD 30.00 and USD 20.00 at 1.66 (49.80 + 33.20 =
    83.00 = USD 50.00 x 1.66) are allowed;
  - a rate of 0, or with more than 8 decimal places;
  - a bank transaction in USD on 1000 (an NZD account) is still refused.
- **FXB5** Transfer out: from the 10 Jul line (-500.00), a transfer to 1000,
  NZD **820.00** received. Carrying value = 3,171.30 x 500.00 / 1,950.00 =
  813.1538… → **813.15**, so the gain is 820.00 - 813.15 = **6.85**. Journal on
  10 Jul: Dr 1000 820.00 / Cr 1030 813.15 (USD 500.00 at carrying value) /
  Cr 7020 6.85. 1030: USD 1,450.00 / NZD 2,358.15. A +820.00 line on 1000 on 10
  Jul matches the 1000 journal line (BK4). Transferring USD 1,450.01 is
  refused (more than the foreign balance); a transfer from 1030 without the
  NZD received is refused.
- **FXB6** Transfer in: from a -1,000.00 line on 1000 on 20 Jul, a transfer to
  1030, USD **610.00** received. Journal on 20 Jul: Dr 1030 1,000.00 (USD
  610.00, rate 1.63934426) / Cr 1000 1,000.00. The 20 Jul +610.00 line on 1030
  then **matches** the 1030 journal line (USD 610.00), posting nothing. 1030:
  USD 2,060.00 / NZD 3,358.15. Now a spend money on 1030 dated 9 Jul (before
  the FXB5 transfer out) is refused.
- **FXB7** Revaluation on 31 Jul 2026 at 1.64 (reversal 1 Aug), with no
  foreign balance typed: the foreign balance is USD **2,060.00** from the
  ledger; revalued 2,060.00 x 1.64 = **3,378.40**; carrying **3,358.15**;
  Dr 1030 20.25 (USD 0.00 at 1.64) / Cr 7000 20.25, reversed on 1 Aug.
  Typing USD 2,000.00 for 1030 is refused ("…the ledger has USD 2,060.00…").
  The bank reconciliation report for 1030 as at 31 Jul: balance in Tohyee
  **USD 2,060.00** (NZD 3,378.40), statement balance **USD 2,060.00** (the 20
  Jul line's running balance), nothing outstanding: fully explained. The 5 Aug
  line now shows the rate **1.64** (the revaluation, later than the 20 Jul
  transfer's 1.63934426).
- **FXB8** Transfer everything left: from the 5 Aug line (-2,060.00), a
  transfer to 1000, NZD **3,400.00** received. After the 1 Aug reversal 1030's
  NZD balance is 3,358.15, and all USD 2,060.00 is leaving, so the carrying
  value is the whole **3,358.15** and the gain **41.85**: Dr 1000 3,400.00 /
  Cr 1030 3,358.15 (USD 2,060.00) / Cr 7020 41.85. 1030: USD 0.00 / NZD 0.00.
  With NZD 3,300.00 received instead it would be a loss of 58.15: Dr 7020
  58.15.
- **FXB9** Invoices and bills: a +115.00 line on 1030 can't pay INV-0001 (NZD):
  "…Invoice INV-0001 is in NZD, so it can't be paid from a USD statement line
  yet…" (a USD invoice can be, MC5); one-click OK suggests no invoice for it, and an
  adjustment on it is refused. Voiding the FXB3 spend money (after
  unreconciling) posts its exact reversal, foreign amount included.
- **FXB10** Imports: a CSV with a Currency column saying NZD, into 1030, is
  refused: "This file is in NZD, but 1030 (USD account) is in USD. Nothing was
  imported."; an OFX file with CURDEF USD into 1000 is refused the same way.
  The file above (no currency column) is recorded in USD. An Akahu feed
  can't be linked to 1030 ("…Akahu's transactions don't say their
  currency…").
- **FXB11** After FXB1-FXB8 the trial balance as at 31 Aug 2026 still balances
  in NZD: 1030 **0.00**, 7020 **48.70** credit (6.85 + 41.85), 7000 nothing
  (the revaluation was reversed), 4000 1,754.30 credit (FXB2's 1,654.30 and
  INV-0001's 100.00), 6040 83.00 debit.

### Not supported yet (refused rather than guessed)

- **Akahu bank feeds for foreign-currency accounts**: Akahu's transaction
  data has no currency, so a feed can't be linked to one (FXB10). Import
  statement files instead.
- **Standard-rated GST on foreign-currency spend and receive money** (FXB4),
  paying NZD invoices or bills from a foreign-currency line (FXB9), and
  adjustments on foreign-currency lines. (Paying invoices and bills in the
  line's own currency is built: MC5.)
- **Transfers between two foreign-currency accounts**, and posting to a
  foreign-currency account dated before its latest transfer out (FXB6).
- **Splitting with an adjustment**: the statement lines must add up to the
  transaction exactly (BK27).
- **Older Excel files** (.xls): save them as .xlsx or CSV.

## Multi-currency invoices and bills (examples not yet approved by Jess)

Built overnight (1 Oct 2026) following NetSuite, as Jess asked ("copy what
NetSuite does"); where NetSuite didn't settle something the smallest safe
choice was taken and anything else is refused ("Not supported yet") and
listed as a question below. Sources: NetSuite help, *Customers and Multiple
Currencies*, *Vendors and Multiple Currencies*, *Setting Exchange Rates
Directly on Transactions*, *Applied Payments and Realized Gain/Loss*,
*Variance Calculations for Realized Gain and Loss*, *Rounding Gain/Loss
Using the Same Exchange Rate*, *Revaluation of Open Currency Balances*,
*Currency Revaluation Transactions* and *Accounts Receivable and Accounts
Payable* (docs.oracle.com/en/cloud/saas/netsuite/ns-online-help); IRD, BR
Pub 04/01 *Supplies paid for in foreign currency* (GST Act s 77: amounts are
expressed in NZD as at the time of supply).

- **A contact has a currency**, like a NetSuite customer's or vendor's
  primary currency: blank is NZD. Its invoices, bills and credit notes are in
  it (the database checks), and it can't change once the contact has any
  ("You can't remove a currency from a customer if transactions have been
  entered in that currency"). Credit limits and a customer's statement are in
  the contact's currency, as NetSuite shows balances and credit limits in the
  primary currency.
- **Exchange rate**: NZD per 1 unit, up to 8 decimal places (as NetSuite).
  A document or payment starts with the rate in the currency exchange rates
  list effective on its date (MC48), or with none there, the last rate used
  for its currency on or before its date (the same lookup as a statement
  line, D4: rates posted lines were converted at, documents' and payments'
  own rates, revaluations' closing rates), and it can be changed; with
  neither, it must be typed.
- **Converting a document**: like NetSuite, each line's net amount and GST is
  converted on its own (amount x rate, rounded once to cents, half away from
  zero) and the document's NZD total is the sum of its lines.
- **Posting**: accounts receivable (1100) and payable (2000) stay NZD
  accounts but, like NetSuite's A/R and A/P accounts, hold documents in any
  currency: a foreign-currency document's line on them has the foreign amount
  and currency beside the NZD (`fx_kind` "document"); income, expense and GST
  lines are NZD only. Manual journals still can't put a foreign amount on
  1100 or 2000.
- **Payments** are in the document's currency, into (or from) a bank account
  in that currency or in NZD, at the payment's own rate. The bank line is
  amount x payment rate. The document is cleared at its carrying value of
  what's paid: its open NZD x amount / its open amount, rounded once, and
  all that's left when it's paid off (as FXB8). The difference is split as
  NetSuite splits it: the realised gain or loss on 7020 is (payment rate -
  document rate) x amount, rounded once, and the cent or two left by
  rounding goes to **7050 Rounding gains and losses** (MC4, MC31-MC38).
- **Credit notes** applied to an invoice (or supplier credit notes to a bill)
  of the same contact and currency clear each side at its own carrying value;
  a difference is a realised gain or loss in a journal of its own, dated the
  application date (NetSuite's realized gain/loss on applying a credit
  memo: (credit's rate - document's rate) x amount, any rounding on 7050,
  MC34), and removing the application reverses it. Credit applied across
  currencies stays refused.
- **Month end**: open foreign-currency documents are revalued per account
  and currency (1100 USD, 2000 USD), like NetSuite's revaluation of open
  currency balances, and, as NetSuite does, **each open document on its
  own**: (closing rate - its rate) x its open foreign amount, rounded once;
  the account and currency's total is the sum (MC39). It goes to 7000/7010
  on the date and is reversed the next day (as F1-F7; NetSuite also reverses
  on the first day of the next period). Payments after it still clear at the
  document's own rate. Period close's FX check lists each account and
  currency with an open balance.
- **Reports**: aged receivables and payables are in NZD, each foreign-currency
  document at its own rate, with its own currency and amount beside it and
  the contact's total in its currency; on a revaluation date the revaluation
  is shown beside the total, so documents + revaluation = the ledger (the
  period close check uses the same). A customer's statement is in the
  customer's currency with the NZD balance beside it. The trial balance,
  balance sheet and GST return are NZD. Home (money owed, bills to pay) and
  sales by salesperson are NZD at the documents' rates.
- **GST**: any GST code, standard-rated included (revised 1 Oct 2026: GST
  is worked out in the document's currency and converted at its rate,
  MC71-MC83; these examples use zero-rated ones). On the invoice basis a
  foreign-currency invoice counts at its lines' NZD amounts on its date (s 77,
  the time of supply being the invoice date under s 9(1)): zero-rated sales
  in Boxes 5 and 6.

Setup: 1000 Business bank account (NZD), 1030 USD account and 1040 EUR
account (both new, no postings before), 1100, 2000, 4000 Sales, 6040
Software and subscriptions, 7000/7010 unrealised and 7020 realised currency
gains and losses; customers Acme Inc (USD) and Kobe Ltd (NZD); supplier
Amazon Web Services (USD).

| ID | What happens | Result |
| --- | --- | --- |
| MC1 | Contacts: Acme with currency "usd", AWS "USD", Kobe none; "NZD" typed; "XYZ" | Acme and AWS are **USD**, Kobe and "NZD" are blank (NZD); "XYZ" refused. A contact with no documents can change currency; once Acme has an invoice, changing it is refused ("…has invoices, bills or credit notes in USD, so its currency can't change"), by the database too |
| MC2 | INV-0001 for Acme, 3 Jul 2026: 1 x USD 1,000.00, 4000, ZERO, exclusive | With no rate typed and no USD rate used yet: refused ("Type the exchange rate…"). (With a GST line it was refused; revised 1 Oct 2026, standard-rated GST is MC71.) At **1.6543**: NZD **1,654.30**. Journal: Dr 1100 **1,654.30 (USD 1,000.00)** / Cr 4000 **1,654.30** |
| MC3 | INV-0002 for Acme, 4 Jul, USD 500.00, no rate typed | Takes **1.6543** (the last USD rate on or before 4 Jul): NZD **827.15** |
| MC4 | INV-0003, 12 Jul, three lines of USD 10.01 at **1.5**; paid in full the same day into 1000 at 1.5 | Each line 15.015 -> **15.02**, so NZD **45.06** (not 30.03 x 1.5 = 45.05): Dr 1100 45.06 (USD 30.03) / Cr 4000 45.06. Payment: bank **45.05**, 1100 cleared **45.06**; the same rate, so no realised gain or loss ((1.5 - 1.5) x 30.03 = 0.00) and the cent is a **rounding loss** (MC31): Dr 1000 45.05 / Dr 7050 0.01 / Cr 1100 45.06 (USD 30.03) |
| MC5 | A USD statement line on 1030, 20 Jul, +1,000.00: pay INV-0001 at **1.64** | Dr 1030 **1,640.00 (USD 1,000.00 at 1.64)** / Dr 7020 **14.30** / Cr 1100 **1,654.30 (USD 1,000.00)**; INV-0001 paid, NZD due 0.00. An NZD invoice (Kobe's INV-0004) from a USD line stays refused ("Invoice INV-0004 is in NZD, so it can't be paid from a USD statement line yet", FXB9), and a USD invoice from an NZD line is refused (record it on the invoice, then match) |
| MC6 | INV-0002 (USD 500.00 = NZD 827.15): USD 200.00 on 15 Jul into 1000 at **1.70**, then USD 300.00 on 28 Jul at **1.60** | First: bank **340.00**, cleared 827.15 x 200 / 500 = **330.86**, gain **9.14**: Dr 1000 340.00 / Cr 1100 330.86 (USD 200.00) / Cr 7020 9.14. Due **USD 300.00 = NZD 496.29**. Second (the rest): bank **480.00**, cleared all **496.29**, loss **16.29**: Dr 1000 480.00 / Dr 7020 16.29 / Cr 1100 496.29. Into 1040 (EUR) refused (a third currency, MC30); overpaying is MC14. Voiding the second on 29 Jul posts its exact reversal (USD 300.00 back on 1100); paid again on 29 Jul at 1.60, the same |
| MC7 | CN-0001 for Acme, 22 Jul, USD 100.00 at **1.63**; INV-0005, 25 Jul, USD 2,000.00 at **1.60** (NZD 3,200.00); CN-0001 applied to INV-0005 on 28 Jul | Credit note: Dr 4000 **163.00** / Cr 1100 **163.00 (USD 100.00)**. Applying: the credit note's side **163.00**, the invoice's 3,200.00 x 100 / 2,000 = **160.00**, gain **3.00** ((1.63 - 1.60) x 100): Dr 1100 163.00 (USD 100.00) / Cr 1100 160.00 (USD 100.00) / Cr 7020 3.00. INV-0005 due **USD 1,900.00 = NZD 3,040.00**. Removing it posts the exact reversal; applied again, the same. (Refunding a USD credit note: MC17.) |
| MC8 | Revaluation on 31 Jul at **1.62** (reversal 1 Aug) of 1030, 1100 USD and 2000 USD | 1030: USD 1,000.00, carrying 1,640.00, revalued 1,620.00: Dr 7010 **20.00** / Cr 1030 20.00. 1100 USD: USD **1,900.00** (INV-0005, its only open document: (1.62 - 1.60) x 1,900.00), carrying **3,040.00**, revalued **3,078.00**: Dr 1100 **38.00** (USD 0.00 at 1.62) / Cr 7000 38.00. 2000 USD: USD **50.00** (AWS-7: (1.62 - 1.66) x 50.00), carrying **83.00**, revalued **81.00**: Dr 2000 **2.00** / Cr 7000 2.00. All reversed on 1 Aug. Before it, period close's FX check lists 1030, 1100 and 2000; after, it passes. Refused: 1100 without a currency ("…Say which currency…"), 1100 USD typed as 2,000.00 ("the ledger has USD 1900.00 open…"), 1100 EUR ("nothing open in EUR"), 1100 USD again on 31 Jul |
| MC9 | Aged receivables and payables, and Acme's statement, as at 31 Jul | Acme: INV-0005 **USD 1,900.00 / NZD 3,040.00**, owes USD 1,900.00; total **NZD 3,155.00** (with Kobe's 115.00); revaluation **38.00** beside it (3,155.00 + 38.00 = 1100's 3,193.00). Payables: AWS-7 **USD 50.00 / NZD 83.00**; revaluation **-2.00**; 2000 **81.00**, difference 0.00. Period close's receivables and payables checks pass. Acme's July statement is in **USD**: closing **1,900.00**, NZD **3,040.00** beside it |
| MC10 | Bills from AWS: AWS-7, 5 Jul, USD 50.00 at **1.66**, 6040, no tax; AWS-8, 6 Jul, the same; supplier credit note AWS-CR1, 7 Jul, USD 20.00 at **1.70**, applied to AWS-8 on 8 Jul; AWS-8's USD 30.00 paid 9 Jul from 1000 at 1.66 | AWS-7: Dr 6040 **83.00** / Cr 2000 **83.00 (USD 50.00)** (a USD bill with GST: MC75). AWS-CR1: Dr 2000 **34.00 (USD 20.00)** / Cr 6040 34.00. Applying: the bill's side 83.00 x 20 / 50 = **33.20**, the credit's **34.00**, loss **0.80**: Dr 2000 33.20 (USD 20.00) / Cr 2000 34.00 (USD 20.00) / Dr 7020 0.80. Payment: bank **49.80**, cleared **49.80**, no gain or loss (no 7020 line): Dr 2000 49.80 (USD 30.00) / Cr 1000 49.80 |
| MC11 | Refused rather than guessed, with nothing posted | A USD invoice made any way but entering it directly, from a quote (MC25), a repeating invoice (MC26), a project (MC64) or a CRM opportunity (MC69); item lines without a typed price on foreign-currency documents (stock items are MC29); a manual journal with a foreign amount on 1100 (and, in the database, any foreign amount on 1100 or 2000 but a document's, a payment's or credit's, or a revaluation's); foreign-currency invoices and credit notes while sales count when paid (the payments basis) |
| MC12 | AWS-7 paid on 5 Aug from 1030 at **1.65** (after the 1 Aug reversal) | Dr 2000 **83.00 (USD 50.00)** / Cr 1030 **82.50 (USD 50.00 at 1.65)** / Cr 7020 **0.50** |
| MC13 | July GST return (invoice basis) and the trial balance at 31 Aug | Box 5 **5,678.51**, Box 6 **5,563.51** (1,654.30 + 827.15 + 45.06 + 3,200.00 - 163.00 zero-rated; Kobe's 115.00 standard-rated); AWS's no-GST bills in no box. Trial balance balances: 7020 debit **18.75** (-14.30 + 9.14 - 16.29 + 3.00 - 0.80 + 0.50), 7050 debit **0.01** (MC4), 7000 and 7010 nothing (reversed), 1100 **3,155.00**, 2000 nothing, 1030 **1,557.50** (USD 950.00) |

Tests: `tests/integration/multi-currency.test.ts` (MC1-MC13).

### Foreign-currency overpayments and refunds (examples not yet approved by Jess)

Built overnight (1 Oct 2026), following NetSuite as Jess asked. NetSuite
posts a realised gain or loss whenever a payment or credit settles a
transaction at a rate other than its own: "Variance = (Payment FX Rate -
Source FX Rate) x Payment", and "the payment transaction can be a payment,
credit memo, customer deposit, or journal entry" (*Variance Calculations for
Realized Gain and Loss*, *Accounting for Fluctuation in Exchange Rates for
Closed Transactions*). A customer refund has its own Exchange Rate field, in
the currency of the credits it refunds (*Refunding an Open Balance*), and
"NetSuite expects the payment currency to match the invoice currency"
(*Currency on Customer Transactions*). So, in Tohyee:

- **Overpaying a foreign-currency invoice** (OP1 in another currency): the
  overpayment is credit in the invoice's currency **at the payment's rate**
  (NetSuite's unapplied payment). Its base value is overpayment x rate,
  rounded once, on its own accounts receivable line (`fx_kind` "document");
  the rest of the bank amount pays the invoice, cleared at the invoice's
  carrying value, and the realised gain or loss is on that part only.
  Paying an already-paid invoice is all overpayment (OP4), with no gain.
- **Applying** it to the same customer's other invoices in that currency
  works like a foreign credit note (MC7): each side clears at its own
  carrying value, and the difference is a realised gain or loss in a journal
  of its own, dated the application date; removing it posts the reversal.
- **Refunding** an overpayment, a credit note or a supplier credit note
  is in the credit's currency, at the **refund's own rate** (typed, or the
  last rate used, MC3), from (or into) a bank account in that currency or
  in NZD. The bank moves amount x refund rate, rounded once; accounts
  receivable (payable) is cleared at the credit's carrying value (all
  that's left when the rest is refunded); the difference is realised on
  7020 (the rates' difference x amount; any rounding on 7050, MC36).
  Voiding posts the exact reversal, foreign amounts included.
- **Supplier overpayments** are still refused, as in NZD (SP3).
- Aged receivables and payables, customer statements, Home and period
  close count unused foreign credit at its carrying value, so the documents
  still add up to 1100 and 2000.

Setup: 1000 (NZD), 1030 USD account, 1040 EUR account, 1100, 2000, 4000,
6040, 7020; customer Acme Inc (USD), supplier Amazon Web Services (USD);
INV-0001 for Acme, 1 Jul 2026, USD 1,000.00 at **1.60** (NZD 1,600.00) and
INV-0002, 2 Jul, USD 500.00 at **1.70** (NZD 850.00), both zero-rated.

| ID | What happens | Result |
| --- | --- | --- |
| MC14 | Acme pays USD **1,100.00** for INV-0001 on 3 Jul into 1030 at **1.65** | Bank 1,100.00 x 1.65 = **1,815.00**; overpayment USD **100.00** = **165.00**; the invoice part (1,815.00 - 165.00 = 1,650.00) clears **1,600.00**, gain **50.00** ((1.65 - 1.60) x 1,000): Dr 1030 1,815.00 (USD 1,100.00 at 1.65) / Cr 1100 1,600.00 (USD 1,000.00) / Cr 1100 165.00 (USD 100.00, the overpayment) / Cr 7020 50.00. INV-0001 **paid**; overpayment **open**, USD 100.00 = NZD 165.00. Paying INV-0001 USD 10.00 again (into 1000 at 1.65) is all overpayment: Dr 1000 16.50 / Cr 1100 16.50 (USD 10.00), no gain; voiding it posts the exact reversal |
| MC15 | Apply USD 60.00 of it to INV-0002 on 10 Jul | The overpayment's side 165.00 x 60 / 100 = **99.00**; the invoice's 850.00 x 60 / 500 = **102.00**; loss **3.00** ((1.65 - 1.70) x 60): Dr 1100 99.00 (USD 60.00) / Cr 1100 102.00 (USD 60.00) / Dr 7020 3.00. INV-0002 due **USD 440.00 = NZD 748.00**; overpayment left **USD 40.00 = NZD 66.00**, **part used**. Removing it posts the exact reversal; applied again, the same |
| MC16 | Refund the USD 40.00 left on 20 Jul from 1000 at **1.62** | Bank 40.00 x 1.62 = **64.80**; carrying value all **66.00**; gain **1.20**: Dr 1100 66.00 (USD 40.00) / Cr 1000 64.80 / Cr 7020 1.20; **used**. USD 40.01 and a refund from 1040 (EUR, MC30) are refused. Voided on 21 Jul (exact reversal), then refunded from 1030 at 1.62: Cr 1030 64.80 (USD 40.00 at 1.62). The payment can't be voided now (OP8) |
| MC17 | CN-0001 for Acme, 5 Jul, USD 100.00 at **1.63** (NZD 163.00); refund USD 30.00 on 15 Jul from 1030 at **1.60** | Carrying 163.00 x 30 / 100 = **48.90**, bank **48.00**, gain **0.90**: Dr 1100 48.90 (USD 30.00) / Cr 1030 48.00 (USD 30.00 at 1.60) / Cr 7020 0.90. Remaining **USD 70.00 = NZD 114.10**. Voided on 16 Jul (exact reversal; back to USD 100.00 = NZD 163.00) and refunded again, the same |
| MC18 | Supplier credit note AWS-CR1, 5 Jul, USD 20.00 at **1.70** (NZD 34.00); AWS refunds it on 12 Jul into 1030 at **1.66** | Bank **33.20**, carrying **34.00**, loss **0.80**: Dr 1030 33.20 (USD 20.00 at 1.66) / Dr 7020 0.80 / Cr 2000 34.00 (USD 20.00). Remaining 0.00. Voided (exact reversal) and received again, the same |
| MC19 | As at 31 Jul | Aged receivables: Acme's INV-0002 **USD 440.00 / NZD 748.00** less CN-0001's unused **USD 70.00 / NZD 114.10**: Acme owes **USD 370.00**, total **NZD 633.90** = 1100 on the trial balance. 7020 credit **48.30** (50.00 - 3.00 + 1.20 + 0.90 - 0.80); 2000 nothing. Revaluing 1100 USD at **1.60**: USD 370.00, carrying **633.90**, revalued **592.00**, one document at a time (MC39): INV-0002 (1.60 - 1.70) x 440.00 = **-44.00**, CN-0001 (1.60 - 1.63) x -70.00 = **+2.10**: Dr 7010 44.00 / Cr 1100 44.00 and Dr 1100 2.10 / Cr 7000 2.10, **-41.90** in all; aged receivables shows the revaluation **-41.90**, and period close's receivables and payables checks pass |

Tests: `tests/integration/multi-currency-settlements.test.ts` (MC14-MC19).

### Payments for several foreign-currency documents (examples not yet approved by Jess)

Built overnight (1 Oct 2026) following NetSuite: "For payments or credits
applied to multiple transactions, NetSuite calculates and records a gain or
loss for each transaction" (*Variance Calculations for Realized Gain and
Loss*), and on Pay Bills "If the account currency is different from the base
currency, only bills that use the account currency show in the list"
(*Paying Bills to Multiple Vendors*). A payment for several invoices (MP1-MP10)
or bills (SMP1-SMP6) of a contact in another currency works the same way,
plus:

- It's in the documents' currency (a contact has one, so they all share it),
  at the payment's **one rate** (typed, or the last rate used, MC3), into
  (or from) a bank account in that currency or NZD; a third currency is
  refused (MC30).
- The **bank line** is the whole amount x rate, rounded once, so it matches
  the one statement line. Each document's **part** is its amount x rate,
  rounded once, except the last listed, which takes what's left of the bank
  line, so the parts add up to it exactly.
- Each document is cleared at its own carrying value, and each has **its own
  realised gain or loss** line on 7020, (payment rate - its rate) x its
  amount, rounded once, after its accounts receivable (payable) line; any
  cent left over (the last part's included) is rounding, on 7050 (MC20,
  MC31).
- A customer overpayment (every invoice paid in full, the extra on the last
  one) is USD credit at the payment's rate, as MC14. Supplier overpayments
  stay refused (SMP3).
- Voiding it posts the exact reversal, foreign amounts included.

Setup: MC14-MC19, then (all zero-rated or no tax) INV-0003, 3 Aug 2026, USD
100.01 at **1.60** (NZD 160.02); INV-0004, 4 Aug, USD 100.01 at **1.62**
(NZD 162.02); INV-0005 and INV-0006, 5 Aug, USD 50.00 each at **1.60** (NZD
80.00 each); AWS bills AWS-1, 1 Aug, USD 50.00 at **1.66** (NZD 83.00) and
AWS-2, 2 Aug, USD 30.00 at **1.70** (NZD 51.00), 6040.

| ID | What happens | Result |
| --- | --- | --- |
| MC20 | Acme pays USD **200.02** on 10 Aug into 1000 at **1.65**: USD 100.01 for INV-0003 and for INV-0004 | Bank 200.02 x 1.65 = 330.033 -> **330.03** (not 165.02 + 165.02). INV-0003's part 100.01 x 1.65 = **165.02**, clears **160.02**, gain **5.00** ((1.65 - 1.60) x 100.01 = 5.0005); INV-0004's part is the rest, **165.01**, clears **162.02**: realised gain **3.00** ((1.65 - 1.62) x 100.01 = 3.0003) and a rounding loss of **0.01** on 7050. One journal: Dr 1000 330.03 / Cr 1100 160.02 (USD 100.01) / Cr 7020 5.00 / Cr 1100 162.02 (USD 100.01) / Cr 7020 3.00 / Dr 7050 0.01. Both **paid** |
| MC21 | Acme pays USD **110.00** on 12 Aug into 1030 at **1.70** for INV-0005 and INV-0006, USD 50.00 each | Both paid in full, so the extra USD **10.00** is an overpayment on INV-0006. Bank **187.00** (USD 110.00 at 1.70); INV-0005's part 85.00 clears 80.00, gain **5.00**; INV-0006's part (the rest, 102.00) is 85.00 on the invoice, clearing 80.00, gain **5.00**, and the overpayment USD 10.00 = **17.00**: Dr 1030 187.00 / Cr 1100 80.00 (USD 50.00) / Cr 7020 5.00 / Cr 1100 80.00 (USD 50.00) / Cr 1100 17.00 (USD 10.00, the overpayment) / Cr 7020 5.00. With USD 40.00 for INV-0005 instead it's refused (MP4) |
| MC22 | USD **80.00** paid to AWS on 15 Aug from 1030 at **1.60** for AWS-1 (50.00) and AWS-2 (30.00) | AWS-1's part **80.00** clears **83.00**, gain **3.00**; AWS-2's **48.00** clears **51.00**, gain **3.00**: Dr 2000 83.00 (USD 50.00) / Cr 7020 3.00 / Dr 2000 51.00 (USD 30.00) / Cr 7020 3.00 / Cr 1030 128.00 (USD 80.00 at 1.60). Both **paid**. USD 80.01 (a supplier overpayment) and paying from 1040 (EUR) are refused |
| MC23 | Refused, nothing posted | A rate typed for Kobe Ltd's NZD invoice ("…in NZD, so the payment has no exchange rate"); Kobe's NZD invoice paid into 1030 (USD); a USD invoice with an NZD one (they're different customers, MP4) |
| MC24 | Void MC21 on 13 Aug | The exact reversal: Cr 1030 187.00 (USD 110.00) / Dr 1100 80.00 / Dr 7020 5.00 / Dr 1100 80.00 / Dr 1100 17.00 / Dr 7020 5.00, with every foreign amount; INV-0006 due again **USD 50.00 = NZD 80.00** |

Tests: `tests/integration/multi-currency-settlements.test.ts` (MC20-MC24).

### Quotes, repeating documents and purchase orders in a foreign currency (examples not yet approved by Jess)

Built overnight (1 Oct 2026) following NetSuite: "When you convert a sales
transaction to another sales transaction in the sales process, the currency
from the original transaction is maintained" (*Currency on Customer
Transactions*); for purchases, "the currency from the original transaction
is maintained and can't be changed", "Memorized purchase order transactions
use the same currency as the original transaction" and "Payment must be made
in the same currency as the purchase order" (*Currency on Vendor
Transactions*). So:

- A **quote**, **repeating invoice**, **repeating bill** or **purchase
  order** for a contact in another currency is in that currency (the
  database checks, and the contact's currency can't change once it has any,
  MC1). It has **no rate** and posts nothing, like its NZD self.
- The **invoice or bill made from it** is an ordinary foreign-currency
  document (MC2, MC10) with a rate for **its own date**: the rate typed when
  accepting the quote or copying the order to a bill, or else the exchange
  rates list's rate effective on that date (MC51), or else the last rate
  used on or before it (MC3), as for a document entered directly. Nothing
  posts until it's approved.
- The same line rules as foreign-currency documents apply when it's saved:
  no stock items, and item lines need a typed price (MC11). Standard-rated
  GST is allowed (revised 1 Oct 2026, MC79), worked out in its currency.
- **Repeating invoices and bills in a foreign currency** can be saved as
  "approve" (revised 1 Oct 2026, MC52): each one is approved only when the
  exchange rates list has a rate effective on its date, which it takes.
  With only the last rate used (which could be stale), it's left as a draft
  and its history says why, so a person checks the rate before approving.

Setup: MC14-MC24 (the last USD rate used on 25 Aug is **1.60**, MC22's
payment).

| ID | What happens | Result |
| --- | --- | --- |
| MC25 | A quote for Acme, 20 Aug 2026, USD 400.00 zero-rated; finalised QU-0001; accepted on 25 Aug with no rate typed | The quote is **USD 400.00** and posts nothing (a quote with GST: MC79). Accepting makes a **draft** invoice in USD at **1.60** (the last USD rate used on or before 25 Aug): NZD **640.00**, still nothing posted; approved: Dr 1100 640.00 (USD 400.00) / Cr 4000 640.00. Another quote (USD 10.00) accepted on 26 Aug with the rate **1.58** typed: NZD **15.80** |
| MC26 | A monthly repeating invoice for Acme from 31 Aug, USD 100.00 zero-rated, saved as "approve"; the job runs on 31 Aug; the exchange rates list is empty | The template is **USD 100.00**. The job makes an invoice dated 31 Aug in USD at **1.60** (the last rate used by then; MC25's 1.58 invoice is a draft, which posts nothing, so it isn't one), NZD **160.00**, and leaves it a **draft** (approval refused, 1 made): "Left as a draft: The exchange rates list has no USD rate effective on or before 2026-08-31, so this invoice took the last USD rate used (1.6)…"; nothing posts. (Revised 1 Oct 2026: saving it as "approve" used to be refused. With a list rate it's approved, MC52.) |
| MC27 | A monthly repeating bill from AWS from 31 Aug, "AWS-{month}", USD 40.00 no tax to 6040, saved as "approve"; the job runs on 31 Aug | The bill made is a **draft** (approval refused, as MC26) dated 31 Aug, USD 40.00 at **1.60** = NZD **64.00** |
| MC28 | A purchase order to AWS, 20 Aug, 3 x USD 20.00 no tax to 6040; approved; copied to a bill AWS-PO1 dated 28 Aug at **1.55** | The order is **USD 60.00** and posts nothing, approved or not. The bill is a draft, USD 60.00 at 1.55 = NZD **93.00**; approved: Dr 6040 93.00 / Cr 2000 93.00 (USD 60.00). AWS's currency can't change now |

Tests: `tests/integration/multi-currency-settlements.test.ts` (MC25-MC28).

### Stock on foreign-currency documents (examples not yet approved by Jess)

Built overnight (1 Oct 2026) following NetSuite, which keeps inventory in
the base currency: a foreign-currency receipt is valued at the base amount
at its exchange rate, and a later bill at another rate posts an exchange
rate variance (*Vendor Bill Variance Journals*: "Bill Exchange Rate Variance
- A variance associated with exchange rate changes … between the time you
receive an item and the time the vendor bills you"). Tohyee has no item
receipts (stock comes in with the bill, ST1), so there's no such variance:

- A foreign-currency **bill's stock line** adds stock at its **NZD net
  amount**: the line converted at the bill's rate, rounded once (MC4), which
  the bill also debits to 1400. Weighted average and everything after it is
  in NZD, as before (W1-W12, ST1-ST12).
- A foreign-currency **invoice's cost of sales** is the NZD weighted average,
  exactly as for an NZD invoice (ST2); its income is at the invoice's rate.
- A foreign-currency **credit note** restocks at the sale's NZD cost (ST5).
- A foreign-currency **supplier credit note** credits 1400 its line's NZD
  net amount at its own rate; the stock leaves at the NZD average and the
  difference goes to cost of sales (as in "Stock tracking").
- Stock still equals 1400 to the cent. Item lines still need a typed price
  (item prices are NZD, MC11). GST works as on any foreign-currency
  document (MC71); these examples have none.
- A foreign bill's stock isn't revalued or adjusted when the bill is paid at
  another rate: the realised gain or loss goes to 7020 (MC5), as NetSuite's
  does.

Setup: MC14-MC28, plus a stock item Widget (1400, 4000, 5000, purchase price
NZD 5.00) with none on hand and the NZD supplier Paw Supplies; all no tax.

| ID | What happens | Result |
| --- | --- | --- |
| MC29 | Bill AWS-STK, 1 Sep 2026: 10 Widgets @ USD 5.00 at **1.60**; bill PAW-1 (NZD), 1 Sep: 10 @ 10.00; invoice to Acme, 5 Sep: 4 @ USD 20.00 at 1.60; credit note to Acme, 6 Sep, returning 1 from that invoice @ USD 20.00 at 1.60; supplier credit note AWS-RET1 to AWS, 7 Sep: 2 @ USD 5.00 at **1.62** | AWS-STK: Dr 1400 **80.00** / Cr 2000 80.00 (USD 50.00); stock 10 worth **80.00**. After PAW-1: 20 worth **180.00** (average 9.00). Invoice: Dr 1100 128.00 (USD 80.00) / Cr 4000 128.00, and Dr 5000 **36.00** / Cr 1400 36.00 (4 x 9.00); 16 worth 144.00. Credit note: Dr 4000 32.00 / Cr 1100 32.00 (USD 20.00), and Dr 1400 **9.00** / Cr 5000 9.00; 17 worth 153.00. Supplier credit note: Dr 2000 16.20 (USD 10.00) / Cr 1400 **16.20**, and Dr 5000 **1.80** / Cr 1400 1.80 (2 left at 9.00 = 18.00); 15 worth **135.00**. At every step the stock report equals 1400 on the trial balance. An item line without a price on a USD invoice is refused |

Tests: `tests/integration/multi-currency-settlements.test.ts` (MC29).

### A bank account in a third currency (examples not yet approved by Jess)

Decided overnight (1 Oct 2026) following NetSuite, which keeps this refused:
"NetSuite expects the payment currency to match the invoice currency"
(*Currency on Customer Transactions*), "Payment must be made in the same
currency as the purchase order" (*Currency on Vendor Transactions*), and on
Pay Bills "If the account currency is different from the base currency, only
bills that use the account currency show in the list" (*Paying Bills to
Multiple Vendors*). So money for a USD document moves in USD through a USD or
NZD bank account only; a EUR account can't pay, receive or refund it (to use
EUR money, transfer it to the NZD or USD account first, FXB5). The message
says why: "Account 1040 (EUR account) is in EUR, but this bill is in USD.
Like NetSuite, money for a USD bill moves in USD, through a USD or NZD bank
account; paying it from an account in a third currency isn't supported.
Transfer the money to a USD or NZD account first."

| ID | What happens | Result |
| --- | --- | --- |
| MC30 | From 1040 (EUR): paying AWS-STK (USD), receiving a payment for INV-0006 (USD), refunding CN-0001 (USD), and a EUR statement line of -45.00 on 10 Sep 2026 matched to AWS-STK | All refused with the message above (the statement line's names account 1040), and nothing is posted. (Payments for several documents and overpayment refunds are refused the same way: MC16, MC22.) |

Tests: `tests/integration/multi-currency-settlements.test.ts` (MC30).

### Rounding gains and losses, and revaluing each document (examples not yet approved by Jess)

Built overnight (1 Oct 2026) following NetSuite, as Jess asked, settling
questions 3, 4 and 8 below. NetSuite's help (*Variance Calculations for
Realized Gain and Loss*, *Rounding Gain/Loss Using the Same Exchange Rate*,
*Applied Payments and Realized Gain/Loss*, *Revaluation of Open Currency
Balances*, *Currency Revaluation Transactions*) says:

- **Rounding Gain/Loss** is a system account of its own, apart from
  Realized Gain/Loss. When a payment or credit is applied to a document (or
  a credit is refunded) the realised variance is (payment rate - source
  document's rate) x the foreign amount applied, with the full rates,
  rounded to 2 decimal places; if the NZD cleared from the document doesn't
  exactly equal the payment's NZD plus that variance, the cent or two left
  posts to Rounding Gain/Loss.
- For payments or credits applied to several documents, NetSuite "calculates
  and records a gain or loss for each transaction", and any rounding goes to
  Rounding Gain/Loss.
- **Revalue Open Currency Balances** revalues each open receivable and
  payable transaction on its own ((period-end rate - the transaction's rate,
  or its last revaluation's rate) x its open foreign amount), plus
  foreign-currency bank and other balance sheet accounts, lists them by
  document (Open Receivables, Open Payables, Other Accounts) and reverses
  itself on the first day of the next period.

So, in Tohyee:

- **7050 Rounding gains and losses** (other income) is in the starting chart;
  migration 0045 gives existing organisations it at 7050 or the next free
  code. It's found by its role, like 7020.
- Every settlement of a foreign-currency document (a payment, a statement
  line matched to it, a payment for several documents, a credit note or
  overpayment applied, a refund of foreign credit) splits its difference:
  the **realised** part on 7020 is (rate of the side debited - rate of the
  side credited) x the foreign amount, rounded once, half away from zero; the
  rest is **rounding** on 7050. Each is only posted when it isn't 0.00. The
  payment, application or refund keeps both (`realisedGain`,
  `roundingGain`); ones from before keep all of it as realised (rounding
  0.00). Voiding or removing posts the exact reversal, 7050 included.
  (Transfers out of a foreign-currency bank account, FXB5, settle no
  document, so their gain or loss stays all on 7020.)
- In a payment for several documents each document has its own realised gain
  and its own rounding; the last part still takes what's left of the bank
  line, so its rounding includes that cent (MC20, MC38).
- **Revaluing accounts receivable or payable** in a currency revalues each
  open invoice, bill, credit note, supplier credit note and customer
  overpayment on its own: (closing rate - its own rate) x its open foreign
  amount, **rounded to cents one document at a time** (NetSuite's help
  doesn't say how it rounds; this is the choice made). Credit notes and
  overpayments count as negative amounts. The account and currency's total
  is the sum; it can differ by a cent or two from revaluing the currency's
  total (MC39). Each document gets its own pair of lines (the control
  account and 7000 or 7010) and is listed on the revaluation; the documents
  must agree with the ledger (period close's check), or it's refused.
  Foreign-currency bank and other accounts are still revalued as one balance
  each (F1-F7). Every revaluation still reverses the next day, so a
  document's "last revaluation's rate" never applies; revaluing again before
  an earlier one is reversed is refused (MC42).
- The FX revaluation screen lists the open documents under each account and
  currency, and each past revaluation's documents with their rates and
  gains or losses.

Setup (1): 1000 (NZD), 1030 USD account, 1100, 2000, 4000, 6040, 7020, 7050;
customer Acme Inc (USD) and supplier Amazon Web Services (USD); everything
zero-rated or no tax. USD 10.05 at 1.5 is 15.075 -> **15.08** and at 1.60 is
**16.08**, but (1.60 - 1.5) x 10.05 = 1.005 -> **1.01**: a cent of rounding.

| ID | What happens | Result |
| --- | --- | --- |
| MC31 | The chart of accounts; an organisation from before migration 0045 whose 7050 is already "Donations" | A new organisation has **7050 Rounding gains and losses** (other income). The older one gets it at **7051**; 7050 Donations is left alone |
| MC32 | INV-0001, 1 Jul 2026, USD 10.05 at **1.5** (NZD 15.08); paid in full on 10 Jul into 1000 at **1.60**; voided on 11 Jul and paid again that day | Bank **16.08**, cleared **15.08**; realised gain **1.01**, rounding loss **0.01**: Dr 1000 16.08 / Cr 1100 15.08 (USD 10.05) / Cr 7020 1.01 / Dr 7050 0.01. Voiding posts the exact reversal (Cr 7050 0.01); paid again, the same |
| MC33 | Bill AWS-1, 1 Jul, USD 10.05 at 1.5 (NZD 15.08), paid on 10 Jul from 1000 at 1.60 | Bank **16.08**, cleared **15.08**; realised loss **1.01** ((1.5 - 1.60) x 10.05), rounding gain **0.01**: Dr 2000 15.08 (USD 10.05) / Cr 1000 16.08 / Dr 7020 1.01 / Cr 7050 0.01 |
| MC34 | CN-0001, 3 Jul, USD 10.05 at 1.5 (NZD 15.08); INV-0003, 4 Jul, USD 20.00 at 1.60 (NZD 32.00); CN-0001 applied to INV-0003 on 15 Jul; removed on 16 Jul and applied again | The credit's side **15.08**, the invoice's 32.00 x 10.05 / 20.00 = **16.08**; realised loss **1.01**, rounding gain **0.01**: Dr 1100 15.08 (USD 10.05) / Cr 1100 16.08 (USD 10.05) / Dr 7020 1.01 / Cr 7050 0.01. INV-0003 due **USD 9.95 = NZD 15.92**. Removing posts the exact reversal; applied again, the same |
| MC35 | INV-0004, 5 Jul, USD 10.00 at 1.60 (NZD 16.00); Acme pays USD **20.05** on 6 Jul into 1000 at **1.5**; INV-0005, 7 Jul, USD 10.05 at 1.60 (NZD 16.08); the USD 10.05 overpayment applied to it on 20 Jul | Payment: bank 30.075 -> **30.08**, overpayment USD 10.05 = **15.08**, the invoice part 15.00 clears 16.00: realised loss **1.00**, no rounding: Dr 1000 30.08 / Cr 1100 16.00 (USD 10.00) / Cr 1100 15.08 (USD 10.05) / Dr 7020 1.00. Applying: the overpayment's side **15.08**, INV-0005's **16.08**; realised loss **1.01**, rounding gain **0.01**: Dr 1100 15.08 / Cr 1100 16.08 / Dr 7020 1.01 / Cr 7050 0.01 |
| MC36 | CN-0002, 8 Jul, USD 10.05 at 1.60 (NZD 16.08), refunded on 21 Jul from 1000 at 1.5; supplier credit note AWS-CR1, 9 Jul, USD 10.05 at 1.5 (NZD 15.08), refunded by AWS on 22 Jul into 1000 at 1.60 | CN-0002: bank **15.08**, carrying **16.08**; realised gain **1.01** ((1.60 - 1.5) x 10.05), rounding loss **0.01**: Dr 1100 16.08 (USD 10.05) / Cr 1000 15.08 / Cr 7020 1.01 / Dr 7050 0.01. AWS-CR1: bank **16.08**, carrying **15.08**; realised gain **1.01**, rounding loss **0.01**: Dr 1000 16.08 / Cr 2000 15.08 (USD 10.05) / Cr 7020 1.01 / Dr 7050 0.01 |
| MC37 | Supplier credit note AWS-CR2, 10 Jul, USD 10.05 at 1.60 (NZD 16.08); bill AWS-2, 10 Jul, USD 20.00 at 1.5 (NZD 30.00); AWS-CR2 applied to AWS-2 on 23 Jul | The bill's side 30.00 x 10.05 / 20.00 = 15.075 -> **15.08**, the credit's **16.08**; realised loss **1.01** ((1.5 - 1.60) x 10.05), rounding gain **0.01**: Dr 2000 15.08 / Cr 2000 16.08 / Dr 7020 1.01 / Cr 7050 0.01 |
| MC38 | Bills AWS-3 and AWS-4, 11 Jul, USD 10.05 each at 1.5 (NZD 15.08 each), paid together on 25 Jul from 1000 at 1.60 (USD 20.10) | Bank 20.10 x 1.60 = **32.16**; each part **16.08** clears **15.08**, with its own realised loss **1.01** and rounding gain **0.01**: Dr 2000 15.08 / Dr 7020 1.01 / Cr 7050 0.01 / Dr 2000 15.08 / Dr 7020 1.01 / Cr 7050 0.01 / Cr 1000 32.16. Trial balance at 31 Jul: 7020 debit **4.03**, 7050 credit **0.03** |

Setup (2), a second organisation: 1000, 1030 USD account, 1100, 2000, 4000,
6040, 7000, 7010, 7020; Acme Inc (USD) and Amazon Web Services (USD). Open on
31 Jul 2026: INV-0001 (1 Jul) and INV-0002 (2 Jul), USD 10.01 each at 1.5
(NZD 15.02 each); INV-0003, 3 Jul, USD 100.00 at 1.62 (162.00); CN-0001, 4
Jul, USD 20.00 at 1.60 (32.00), unused; INV-0004, 5 Jul, USD 50.00 at 1.60,
paid with USD 60.00 on 6 Jul into 1030 at 1.64 (NZD 98.40), leaving an
overpayment of USD 10.00 = 16.40; bills AWS-1 and AWS-2, 1 and 2 Jul, USD
10.01 each at 1.5 (15.02 each); supplier credit note AWS-CR1, 3 Jul, USD
5.00 at 1.70 (8.50), unused.

| ID | What happens | Result |
| --- | --- | --- |
| MC39 | Revaluation on 31 Jul at **1.55** (reversal 1 Aug) of 1030, 1100 USD and 2000 USD | 1030 (one balance): USD 60.00, carrying 98.40, revalued 93.00, **-5.40**. 1100 USD, one document at a time: INV-0001 (1.55 - 1.5) x 10.01 = 0.5005 -> **+0.50**, INV-0002 **+0.50**, INV-0003 (1.55 - 1.62) x 100.00 = **-7.00**, CN-0001 (1.55 - 1.60) x -20.00 = **+1.00**, the overpayment (1.55 - 1.64) x -10.00 = **+0.90**: USD **90.02**, carrying **143.64**, **-4.10**, revalued **139.54** (the currency's total at 1.55, 90.02 x 1.55 = 139.53, would have given -4.11). 2000 USD: AWS-1 **+0.50**, AWS-2 **+0.50**, AWS-CR1 (1.55 - 1.70) x -5.00 = **+0.75**: USD 15.02, carrying 21.54, **+1.75** owed (a loss), revalued 23.29 (not 1.74). Journal: Cr 1030 5.40 / Dr 7010 5.40; Dr 1100 0.50 / Cr 7000 0.50 (INV-0001); the same for INV-0002; Cr 1100 7.00 / Dr 7010 7.00 (INV-0003); Dr 1100 1.00 / Cr 7000 1.00 (CN-0001); Dr 1100 0.90 / Cr 7000 0.90 (the overpayment); Cr 2000 0.50 / Dr 7010 0.50 (AWS-1); the same for AWS-2; Cr 2000 0.75 / Dr 7010 0.75 (AWS-CR1). Reversed on 1 Aug. The revaluation lists every document with its rate |
| MC40 | The FX revaluation screen on 30 Jul | Under 1100 USD (USD 90.02, NZD 143.64): INV-0001, INV-0002, INV-0003, CN-0001 (-20.00, -32.00, at 1.6) and "Overpayment on INV-0004" (-10.00, -16.40, at 1.64), by date; under 2000 USD (USD 15.02, NZD 21.54): AWS-1, AWS-2, AWS-CR1 |
| MC41 | As at 31 Jul, then 1 Aug | Aged receivables **143.64** with the revaluation **-4.10** beside it; aged payables' revaluation **1.75**, 2000 **23.29**, difference 0.00; period close's FX, receivables and payables checks pass. Trial balance 31 Jul: 7000 credit **2.90**, 7010 debit **14.15**, 1100 **139.54**; 1 Aug: 7000 and 7010 nothing, 1100 **143.64** |
| MC42 | Refused, nothing posted | 1100 USD again on 31 Jul ("already revalued"); on 15 Aug with USD 90.00 typed ("the ledger has USD 90.02 open on 2026-08-15, not 90.00"); 1100 EUR ("nothing open in EUR"). After revaluing 2000 USD on 15 Aug with the reversal on 1 Sep, revaluing it on 31 Aug: "Account 2000 USD was revalued on 2026-08-15 (FX-MID), and that isn't reversed until 2026-09-01. Revaluing it again before then isn't supported yet." |
| MC43 | INV-0003 paid on 3 Aug into 1000 at 1.55 (after the reversal) | Still cleared at its own rate: bank **155.00**, cleared **162.00**, realised loss **7.00**, no rounding: Dr 1000 155.00 / Cr 1100 162.00 (USD 100.00) / Dr 7020 7.00 |

Tests: `tests/integration/multi-currency-rounding.test.ts` (MC31-MC43),
`tests/unit/fx-rounding.test.ts`, and MC4, MC8, MC13, MC19 and MC20 in their
own tests.

### Currency exchange rates list (examples not yet approved by Jess)

Built overnight (1 Oct 2026) following NetSuite, as Jess asked. NetSuite
keeps a **Currency Exchange Rates** list: "exchange rates for each currency
pair" with an **effective date**, and when a transaction is entered "the
exchange rate defaults to the rate in effect on the transaction date", which
can be changed on the transaction (NetSuite help, *Currency Exchange Rates*,
*Setting Exchange Rates Directly on Transactions*, *Currency Exchange Rate
Integration*; sections N1404249, N1404429 and N564637). Its daily feed
(Currency Exchange Rate Integration) comes from paid providers (HSBC,
Xignite), so it isn't copied; whether to add a free feed is Jess's decision
(question 6). In Tohyee:

- **Accounting › Exchange rates**: for each foreign currency, rates with the
  date each takes effect, **NZD per 1 unit** (the direction of every
  document's rate), up to 8 decimal places, with an optional note (e.g.
  "RBNZ"). Bookkeepers, admins and owners add them (the role that posts FX
  revaluations); viewers see them. Each is audited (who and when). The base
  currency, unknown currencies, a zero rate, more than 8 decimal places and
  impossible dates are refused.
- **Never changed or deleted** (the database checks): a correction is a
  newer entry for the same date (for one date, the one added last wins) or
  archiving the wrong one, which is kept with who archived it. Documents
  that already took a rate keep it.
- **Default rate**: a new foreign-currency invoice, bill, credit note,
  supplier credit note, payment (one or several documents), refund, bank
  statement line, accepted quote or copied purchase order starts with the
  list's rate **in effect on its date** (the latest entry on or before it);
  with none, the last rate used in the books on or before it (MC3, D4); with
  neither, it must be typed (MC2). A typed rate always wins.
- **Repeating invoices and bills** in a foreign currency are approved
  automatically (when set to) only when the list has a rate effective on the
  document's date, which it took; otherwise it's left as a draft at the last
  rate used and the history says why. NetSuite's help doesn't say which rate
  memorized transactions use; taking the rate in effect on the new
  document's date, as for any new transaction, is the choice made
  (question 9).
- **Pasting several** (one command, all or nothing): one per line,
  "currency, effective date, rate" and an optional note, with commas or tabs
  (rows copied from a spreadsheet), dates as YYYY-MM-DD or DD/MM/YYYY, and a
  heading line skipped.
- **FX revaluation** starts each closing rate as the list's rate in effect on
  the revaluation date, when there is one (it can be changed or cleared).

Setup: 1000 (NZD), 1030 USD account, 1100, 2000, 4000, 6040, 7020; customer
Acme Inc (USD); suppliers Amazon Web Services (USD) and Bristol Ltd (GBP);
nothing posted before; all zero-rated or no tax.

| ID | What happens | Result |
| --- | --- | --- |
| MC46 | A bookkeeper adds USD **1.60** effective 1 Jul 2026 (note "RBNZ"), USD **1.65** effective 1 Aug and EUR **1.80** effective 1 Jul | Added, each with an audit event (who, when). Refused: NZD ("NZD is the base currency, so it has no exchange rate"), "XYZ", a rate of 0, 1.123456789 (more than 8 places), 30 Feb. A viewer is refused (403). The same idempotency key again returns the same entry; with another rate it's refused. In effect on 15 Jul: **USD 1.60, EUR 1.80**, GBP none |
| MC47 | USD **1.66** effective 1 Aug added later (a typo), then archived | While it's there, 15 Aug takes **1.66** (the newest for that date). Archived: 15 Aug takes **1.65** again; 1.66 stays in the list as archived by the bookkeeper; archiving it again is refused. The database refuses changing a rate, un-archiving, deleting and emptying the table, and a NZD entry |
| MC48 | INV-0001 for Acme, 10 Jul, USD 1,000.00 at **1.70** typed; INV-0002, 15 Jul, USD 500.00 no rate typed; INV-0003, 5 Aug, USD 200.00 no rate; INV-0004, 6 Aug, USD 100.00 at **1.62** typed | INV-0001 NZD **1,700.00** (1.70 is now the last USD rate used). INV-0002 takes the list's **1.60** (effective 1 Jul), not the last used 1.70: NZD **800.00**, Dr 1100 800.00 (USD 500.00) / Cr 4000 800.00. INV-0003: **1.65**, NZD **330.00**. INV-0004: the typed **1.62**, NZD **162.00** |
| MC49 | Bill BR-1 from Bristol (GBP), 1 Jul, GBP 100.00, no rate typed; again at **2.10**; BR-2, 20 Jul, GBP 50.00, no rate; a USD bill dated 20 Jun, no rate | BR-1 refused ("Type the exchange rate for this bill (NZD per 1 GBP): no GBP rate has been used on or before 2026-07-01 yet, and the exchange rates list … has none effective by then"); at 2.10: NZD **210.00**. BR-2 takes **2.10** (no GBP in the list, so the last rate used): NZD **105.00**. The USD bill on 20 Jun is refused (before the list's first USD entry and before any USD was used) |
| MC50 | Acme pays INV-0002 (USD 500.00 = NZD 800.00) on 12 Aug into 1030, no rate typed; a USD statement line on 1030, 20 Aug, +100.00, matched to INV-0003 with no rate typed | Payment at **1.65**: Dr 1030 **825.00** (USD 500.00 at 1.65) / Cr 1100 800.00 (USD 500.00) / Cr 7020 **25.00**. The statement line shows **1.65** from the list (effective 1 Aug) and NZD **165.00**; matched, INV-0003 due **USD 100.00 = NZD 165.00**, no gain (its own rate) |
| MC51 | A quote for Acme, 25 Jul, USD 400.00, accepted on 3 Aug with no rate; a purchase order to AWS, 25 Jul, 3 x USD 20.00, approved and copied to bill AWS-PO1 dated 3 Aug with no rate | Both take the rate for the new document's date, **1.65** (as NetSuite's bill made from a purchase order has its own rate): the draft invoice NZD **660.00**, the draft bill NZD **99.00** |
| MC52 | A monthly repeating invoice for Acme from 31 Jul, USD 100.00, saved as "approve"; the job runs on 31 Aug. A monthly repeating bill from Bristol from 31 Jul, "BR-{month}", GBP 40.00 to 6040, "approve"; the job runs on 31 Jul, then GBP **2.05** effective 1 Aug is added and it runs on 31 Aug | Invoices: 31 Jul at **1.60**, approved: Dr 1100 **160.00** (USD 100.00) / Cr 4000 160.00; 31 Aug at **1.65**, approved, NZD **165.00**. Bill 31 Jul: no GBP in the list, so a **draft** at 2.10 (NZD 84.00), history: "Left as a draft: The exchange rates list has no GBP rate effective on or before 2026-07-31, so this bill took the last GBP rate used (2.1). Check its rate, then approve it; or add rates under Accounting › Exchange rates." Bill 31 Aug at **2.05**, approved: Dr 6040 **82.00** / Cr 2000 82.00 (GBP 40.00) |
| MC53 | Pasted: "Currency,Date,Rate,Note" / "USD,31/08/2026,1.62,RBNZ month end" / (blank) / "EUR[tab]2026-08-31[tab]1.85"; and a paste whose line 2 is "USD, 2026-08-31, abc" | Two entries added: USD **1.62** and EUR **1.85**, effective 31 Aug (the heading and blank line skipped). The bad paste adds nothing ("Line 2: The rate must be a plain number…"). The revaluation on 31 Aug suggests **1.62** for USD (30 Aug would be 1.65), and a new USD document dated 31 Aug takes 1.62 |

Tests: `tests/integration/fx-rate-table.test.ts` (MC46-MC53),
`tests/unit/fx-rate-text.test.ts` (MC48, MC53).

### Projects and CRM opportunities in a foreign currency (examples not yet approved by Jess)

Built overnight (1 Oct 2026) following NetSuite, as Jess asked. In NetSuite
a new transaction starts in the customer's currency, and "Projects and their
associated transactions must share a single currency" (NetSuite help,
docs.oracle.com/en/cloud/saas/netsuite/ns-online-help, bridgehead_N1398658,
section_N1404249, section_4369706980 and section_3752834264): a project for a customer in
another currency is in that currency, its billing rates (time, fixed fees)
are set in it, and the invoices made from it are in it, so nothing charged
is converted from NZD. Staff costs stay in the base currency. So, in Tohyee:

- **A project is in its customer's currency** (PJ1): taken from the customer
  when it's created, never typed (the database checks). Its hourly rates,
  fixed prices and estimate are in it. Existing projects are in their
  customer's currency (NZD for NZD customers).
- A project's currency **can't change once it has tasks, time, expenses or
  invoices** (moving it to a customer in another currency is refused before
  then too: its customer can't change once it has invoices, PJ); a
  customer's currency can't change once it has projects or opportunities
  (as MC1 for documents). The database refuses both.
- **Staff cost rates and costs stay NZD** (PJ3), and so do expense costs
  (the line's NZD net amount, PJ4).
- **Invoicing a foreign project** (PJ6) makes a draft invoice in its
  currency, like any foreign-currency invoice (MC2): the rate typed, or else
  the one a new invoice for that date starts with (MC3); any GST code, as on
  any foreign-currency invoice (revised 1 Oct 2026, MC71); nothing posts
  until it's approved.
- **Profitability** (PJ9): invoiced, on draft invoices, unbilled, written
  off and the estimate are in the project's currency; **invoiced (NZD)** is
  the approved invoices' NZD subtotals at their own rates (what the ledger
  has in 4000); costs and **profit (invoiced NZD less costs)** are NZD. The
  report's totals are NZD: invoiced (NZD), costs and profit of every
  project, and what's still to invoice of the NZD projects, with a line per
  other currency for its projects' amounts (never added to NZD).
- **Chargeable expenses on a foreign project are refused** (smallest safe
  choice): the cost is NZD and which rate would turn it into USD for the
  invoice isn't settled. Link it as not chargeable (a cost only) and charge
  for it as a fixed price task. The database refuses it too.
- **CRM**: an opportunity is in its company's currency (its amount too),
  following its company if that changes, until it has made its invoice. The
  pipeline totals each currency on its own; a company's open pipeline is in
  its currency. A **won opportunity's invoice** (CRM5) is a draft in that
  currency at the rate typed or else the usual starting rate, with the same
  **standard GST code** as an NZD opportunity's invoice (CRM5; no tax if
  there's none). Revised 1 Oct 2026: it used to be zero-rated, when only
  zero-rated, exempt or no GST could be on a foreign-currency invoice; now
  standard-rated GST works (MC71). It's a draft, so an export can be changed
  to ZERO before it's approved.

Setup: GST on the invoice basis; 1000, 1100, 4000, 6040; customers **Acme
Inc (USD)** and **Harbour Cafe** (NZD), supplier Paw Supplies (NZD); Jess's
staff cost rate **NZD 40.00** an hour; no USD rate used yet.

| ID | What happens | Result |
| --- | --- | --- |
| MC61 | Projects: "Website build" for Acme, estimate 3,000.00; "Cafe menu" for Harbour Cafe | Website build is **USD** (estimate **USD 3,000.00**), Cafe menu **NZD**; nothing posts. Changing Acme's currency is now refused ("Acme Inc has projects or CRM opportunities in USD, so its currency can't change…"), by the database too; so is setting Website build's currency to NZD in the database ("This contact's documents are in USD, not NZD"). A project for Yamato KK (JPY) is refused: MC70 |
| MC62 | Tasks: Development, hourly **USD 120.00**; Setup, fixed **USD 500.00**. Jess records 2 h 30 min of Development on 1 Jul 2026; on Cafe menu, Design hourly 90.00 and 1 h of Jess's time on 2 Jul | Jess's entry costs **NZD 100.00** (150 x 40.00 / 60, her NZD cost rate). Website build unbilled **USD 800.00** (300.00 time + 500.00 fixed); Cafe menu unbilled **90.00** (NZD), cost 40.00 |
| MC63 | Bill PS-1 from Paw Supplies, 3 Jul, "Hosting" 50.00 + GST to 6040, approved; linked to Website build | Chargeable: refused ("Project Website build is in USD, and expense costs are in NZD. Charging an expense on a USD project isn't supported yet…"), and by the database. Not chargeable: linked at cost **NZD 50.00**; making it chargeable later is refused. Nothing posts |
| MC64 | Invoice everything unbilled on Website build, 10 Jul, to 4000 | (With GST (standard) it was refused; revised 1 Oct 2026, it works as MC71.) ZERO with no rate typed (no USD rate used yet): refused ("Type the exchange rate…"); nothing is linked. ZERO at **1.60**: a **draft USD invoice** for Acme: "Development (2 h 30 min)" 2.5 x **120.00** = **300.00**, "Setup" 1 x **500.00**: **USD 800.00**, no GST, NZD **1,280.00** (480.00 + 800.00); unbilled USD 0.00. Approved: Dr 1100 **1,280.00 (USD 800.00)** / Cr 4000 **1,280.00** |
| MC65 | 1 h more Development on 12 Jul, invoiced on 20 Jul (ZERO) with no rate typed, and approved | Takes **1.60**, the rate a new USD invoice dated 20 Jul starts with (MC3; MC64's): "Development (1 h)" **USD 120.00** = NZD **192.00**: Dr 1100 192.00 (USD 120.00) / Cr 4000 192.00 |
| MC66 | Project profitability and the time report for July 2026 | Website build: invoiced **USD 920.00**, invoiced (NZD) **1,472.00**; costs **NZD 190.00** (time 3 h 30 min, 140.00, plus hosting 50.00); profit **NZD 1,282.00**; unbilled **USD 0.00**; estimate USD 3,000.00, **USD 2,080.00** left. Cafe menu: costs 40.00, profit **-40.00**, unbilled **90.00**. Totals (NZD): invoiced **1,472.00**, costs **230.00**, profit **1,242.00**, unbilled **90.00** (NZD projects); USD projects: invoiced USD 920.00, unbilled USD 0.00. 4000 on the trial balance is 1,472.00. Time report: Jess 4 h 30 min, cost **NZD 180.00** |
| MC67 | Currency locks | Website build can't move to Harbour Cafe (it has invoices). "Discovery" for Acme with a task Workshop (fixed USD 200.00) can't move to Harbour Cafe ("…has tasks, time or expenses in USD, so it can't move to a customer in NZD…"); the database refuses its currency changing too. "Scoping" for Acme, with nothing on it, moves to Harbour Cafe and is then **NZD** |
| MC68 | CRM on. Opportunities "Annual retainer" for Acme 2,000.00 and "Menu reprint" for Harbour Cafe 500.00, both New | Annual retainer is **USD 2,000.00**, Menu reprint **NZD 500.00**; the New column totals **NZD 500.00 + USD 2,000.00** (never added together); Acme's open pipeline **USD 2,000.00**. Moved to Acme, Menu reprint is USD 500.00; moved back, NZD 500.00. For Yamato KK (JPY) 1000.50 is refused ("…no cents…"), 1000 works |
| MC69 | Annual retainer and Menu reprint marked Won and invoiced (today); "Logo licence" for Acme, USD 100.00, Won, invoiced with the rate **1.58** typed | Annual retainer (revised 1 Oct 2026): a **draft USD invoice**, 1 x USD 2,000.00 to 4000, **GST** (the standard code, as CRM5), at **1.60** (the last USD rate used, MC65's): USD 2,000.00 + GST 300.00 = **USD 2,300.00**; NZD 3,200.00 + GST **480.00** = **3,680.00** (MC71); nothing posts; again returns the same invoice; its company can't change now (the database refuses too). Logo licence: USD 115.00 at 1.58 = NZD 158.00 + GST **23.70** = **181.70**. Menu reprint: NZD with GST, as CRM5 (575.00); a rate typed for it is refused ("…in NZD, so its invoice has no exchange rate"). In an organisation with no USD rate used, a USD opportunity's invoice without a rate is refused ("Type the exchange rate…") |
| MC70 | Refused rather than guessed, nothing posted | A project for Yamato KK (JPY: "…which has no cents. Projects in JPY aren't supported yet…"); chargeable expenses on a USD project (MC63); invoicing a USD project, or a USD opportunity, while sales count for GST when paid (the payments basis, as MC11) |

Tests: `tests/integration/multi-currency-projects.test.ts` (MC61-MC70).

### Standard-rated GST on foreign-currency documents (examples not yet approved by Jess)

Built overnight (1 Oct 2026) following NetSuite and IRD, settling question 1
below. NetSuite calculates tax on a foreign-currency transaction in the
transaction's currency, and the base-currency tax is that tax converted at
the transaction's own exchange rate (NetSuite help, section_1524036773 and
section_0911063515). IRD's guidance (BR Pub 04/01, GST Act s 77, cited
above) is that amounts in a foreign currency are converted to NZD at the
time of supply; in Tohyee that's the document's rate, the rate for its date.
So:

- **Any GST code** can be on a foreign-currency invoice, credit note, bill or
  supplier credit note, and on the quotes, repeating invoices and bills,
  purchase orders, projects and CRM opportunities they're made from:
  standard-rated (GST, and any other standard-rated code), zero-rated,
  exempt or none.
- **GST is worked out in the document's currency** exactly as on an NZD
  document: per line, exclusive (line x rate) or inclusive (line x rate /
  (1 + rate)), rounded to cents half away from zero (I1-I6).
- **Converting to NZD** is as before (MC4): each line's net amount and its GST
  are each x the document's rate, rounded once to cents; the NZD GST is the
  sum of the lines' NZD GST, and the NZD total the sum of the lines. So the
  journal balances exactly: Dr (Cr) the control account the NZD total with
  the foreign total beside it, Cr (Dr) income or expense the NZD net, Cr (Dr)
  **2100 GST the NZD GST, with no foreign amount**. When the lines' NZD
  total isn't the foreign total x the rate (each line is rounded), that
  cent stays in the document's carrying value and is **rounding** (7050)
  when it's settled (MC73); GST is never adjusted to absorb it.
- **GST never changes after the document**: payments, credit applied,
  refunds, revaluations and their reversals post no GST, and realised and
  unrealised gains and losses have none (NetSuite's are the same). GST is
  owed to IRD in NZD, so 2100 is an NZD account and is never revalued.
- **Revaluation** of receivables and payables (MC39) revalues each document's
  whole open foreign amount, GST included, since what's owed is the gross
  amount (MC78).
- **GST return**: on the invoice basis a foreign-currency document counts its
  NZD amounts from the document: Box 5 or 11 the NZD total including GST,
  and its NZD GST in the GST on transactions (MC77). On the payments or
  hybrid basis a foreign-currency bill counts its share of the bill's NZD
  total at the bill's rate (MC11), and now its GST: its NZD GST x the share
  (split as G12). The payment's rate doesn't matter, and the realised gain
  or loss is in no box (MC80). The IR546 basis-change adjustment uses the
  NZD GST share of what's still owed (MC81). Foreign-currency sales on the
  payments basis stay refused (question 2, MC82).
- **GST audit report**: foreign-currency documents are listed with their NZD
  amounts and GST (MC77).
- **Screens**: an invoice, credit note, bill or supplier credit note in
  another currency shows its GST in its currency, and beside it the exchange
  rate, the **GST (NZD)**, the total (NZD) and what's due or remaining (NZD,
  at its rate).
- **Still refused**: standard-rated GST on foreign-currency spend and receive
  money (FXB4; they convert the total as well as each line, so their GST
  would need its own rounding rule; MC83), the reverse charge on imported
  services (not built in any currency), and foreign-currency sales on the
  payments basis (MC82).

Setup (A, invoice basis): 1000 (NZD), 1030 USD account, 1100, 2000, 2100 GST,
4000, 6040, 7000, 7010, 7020, 7050; customers Acme Inc (USD) and Kobe Ltd
(NZD); supplier Amazon Web Services (USD). All exclusive at GST 15% unless
stated.

| ID | What happens | Result |
| --- | --- | --- |
| MC71 | INV-0001 for Acme, 1 Jul 2026: 1 x USD 1,000.00, 4000, GST, at **1.60** | USD 1,000.00 + GST **150.00** = **1,150.00**. NZD: net 1,600.00, GST 150.00 x 1.60 = **240.00**, total **1,840.00**. Journal: Dr 1100 **1,840.00 (USD 1,150.00)** / Cr 4000 **1,600.00** / Cr 2100 **240.00** (NZD only) |
| MC72 | INV-0002, 2 Jul, tax inclusive: 1 x USD 230.00, GST, at **1.65** | GST 230.00 x 0.15 / 1.15 = **30.00**, net 200.00. NZD: net **330.00**, GST **49.50**, total **379.50**: Dr 1100 379.50 (USD 230.00) / Cr 4000 330.00 / Cr 2100 49.50 |
| MC73 | INV-0003, 3 Jul: three lines of USD 10.07, GST, at **1.5**; paid in full the same day, USD 34.74 into 1000 at 1.5 | Each line's GST 1.5105 -> **1.51**: USD 30.21 + 4.53 = **34.74**. Each line in NZD: net 15.105 -> **15.11**, GST 2.265 -> **2.27**: NZD 45.33 + GST **6.81** = **52.14** (not 34.74 x 1.5 = 52.11, and not 4.53 x 1.5 = 6.80 of GST). Journal: Dr 1100 52.14 (USD 34.74) / Cr 4000 45.33 / Cr 2100 6.81. Payment: bank **52.11**, cleared **52.14**, no realised gain (same rate), a **rounding loss of 0.03**: Dr 1000 52.11 / Cr 1100 52.14 (USD 34.74) / Dr 7050 0.03. The GST stays **6.81** |
| MC74 | CN-0001 for Acme, 10 Jul: 1 x USD 100.00, GST, at **1.62**; applied to INV-0001 on 12 Jul | USD **115.00**; NZD 162.00 + GST **24.30** = **186.30**: Dr 4000 162.00 / Dr 2100 24.30 / Cr 1100 186.30 (USD 115.00). Applying: the credit's side **186.30**, the invoice's 1,840.00 x 115 / 1,150 = **184.00**, realised gain **2.30** ((1.62 - 1.60) x 115.00), no GST: Dr 1100 186.30 (USD 115.00) / Cr 1100 184.00 (USD 115.00) / Cr 7020 2.30. INV-0001 due **USD 1,035.00 = NZD 1,656.00** |
| MC75 | Bill AWS-1, 5 Jul: 1 x USD 200.00 to 6040, GST, at **1.60**; paid in full on 20 Jul from 1000 at **1.70** | USD **230.00**; NZD 320.00 + GST **48.00** = **368.00**: Dr 6040 320.00 / Dr 2100 48.00 / Cr 2000 368.00 (USD 230.00). Payment: bank 230.00 x 1.70 = **391.00**, cleared **368.00**, realised loss **23.00** and no GST line: Dr 2000 368.00 (USD 230.00) / Dr 7020 23.00 / Cr 1000 391.00. The bill's GST stays **48.00** |
| MC76 | Supplier credit note AWS-CR1, 8 Jul: 1 x USD 20.00 to 6040, GST, at 1.60 | USD **23.00**; NZD 32.00 + GST **4.80** = **36.80**: Dr 2000 36.80 (USD 23.00) / Cr 6040 32.00 / Cr 2100 4.80 |
| MC77 | Kobe's INV-0004 (NZD), 4 Jul: 100.00 + GST; the July GST return (invoice basis) and GST audit report | Box 5 **2,200.34** (1,840.00 + 379.50 + 52.14 + 115.00 - 186.30), Box 6 0.00, Box 8 = 2,200.34 x 3 / 23 = **287.00**; Box 11 **331.20** (368.00 - 36.80), Box 12 **43.20**. GST on transactions: sales **287.01** (240.00 + 49.50 + 6.81 + 15.00 - 24.30; a cent from Box 8, as with NZD documents), purchases **43.20**. The audit report lists INV-0001 **1,840.00** (GST 240.00), INV-0002 379.50 (49.50), INV-0003 52.14 (6.81), INV-0004 115.00 (15.00), CN-0001 -186.30 (-24.30); AWS-1 368.00 (48.00), AWS-CR1 -36.80 (-4.80). Trial balance at 31 Jul balances; 2100 credit **243.81** (287.01 - 43.20) |
| MC78 | Revaluation of 1100 USD on 31 Jul at **1.70** (reversal 1 Aug) | INV-0001's open USD 1,035.00 (GST included) at 1.60: (1.70 - 1.60) x 1,035.00 = **+103.50**; INV-0002's USD 230.00 at 1.65: **+11.50**. USD **1,265.00**, carrying **2,035.50**, revalued **2,150.50**, **+115.00**: Dr 1100 103.50 / Cr 7000 103.50; Dr 1100 11.50 / Cr 7000 11.50. No 2100 line: 2100 is still **243.81**, and the July return is unchanged (Box 5 2,200.34) |
| MC79 | A quote for Acme, 3 Aug, 1 x USD 100.00, GST, accepted on 5 Aug at **1.70**; a purchase order to AWS, 3 Aug, 2 x USD 20.00, GST, approved and copied to bill AWS-PO1 dated 6 Aug at **1.70**; a repeating invoice for Acme, 1 x USD 100.00, GST | Quote **USD 115.00** (GST 15.00), posts nothing; its invoice NZD 170.00 + GST **25.50** = **195.50**: Dr 1100 195.50 (USD 115.00) / Cr 4000 170.00 / Cr 2100 25.50. Order **USD 46.00** (GST 6.00); the bill NZD 68.00 + GST **10.20** = **78.20**: Dr 6040 68.00 / Dr 2100 10.20 / Cr 2000 78.20 (USD 46.00). The repeating invoice saves as **USD 115.00** (GST 15.00). (A project's invoice and a CRM opportunity's are the same: MC64, MC69) |

Setup (B, hybrid basis): 1000, 1030 USD account; Acme Inc (USD) and Amazon
Web Services (USD).

| ID | What happens | Result |
| --- | --- | --- |
| MC80 | INV-0001 for Acme, 2 Aug: USD 100.00 + GST at **1.60**; bill AWS-2, 1 Aug: USD 200.00 + GST at **1.60**; USD 115.00 (half) of AWS-2 paid on 10 Aug from 1030 at **1.70**; the August return | INV-0001 NZD 160.00 + GST **24.00** = **184.00**. AWS-2 NZD 320.00 + GST 48.00 = **368.00**. Payment: bank **195.50** (USD 115.00 at 1.70), cleared 368.00 x 115 / 230 = **184.00**, realised loss **11.50**: Dr 2000 184.00 (USD 115.00) / Dr 7020 11.50 / Cr 1030 195.50 (USD 115.00 at 1.70). August: sales when approved, Box 5 **184.00**, Box 8 **24.00**; purchases when paid, AWS-2's share at the bill's rate: settled 115.00 x 368.00 / 230.00 = **184.00**, GST 48.00 x 184.00 / 368.00 = **24.00**: Box 11 **184.00**, Box 12 **24.00**, Box 15 **0.00**. The 11.50 loss is in no box |
| MC81 | August filed on the hybrid basis; the basis then changed to invoice; the September return | At 31 Aug AWS-2 still owes USD 115.00: GST on creditors 115.00 x **48.00** (its NZD GST) / 230.00 = **24.00** (not 115.00 x 30.00 / 230.00 = 15.00 of USD GST); GST on debtors **24.00** (INV-0001). Hybrid -> invoice (IR546): suggested Box 13 **24.00** |

Setup (C, payments basis): as B.

| ID | What happens | Result |
| --- | --- | --- |
| MC82 | A USD invoice and a USD credit note for Acme, 1 Sep, with GST; bill AWS-3, 1 Sep: USD 200.00 + GST at 1.60 (NZD 368.00, GST 48.00), USD 46.00 of it paid on 10 Sep from 1030 at **1.50**; the September return | The invoice and credit note are refused as before ("Foreign-currency invoices aren't supported yet while sales count for GST when they're paid (the payments basis)…", question 2). The bill works; September: Box 5 0.00, Box 11 368.00 x 46 / 230 = **73.60**, Box 12 **9.60** (at the bill's rate, not 1.50) |
| MC83 | Spend money of USD 50.00 inclusive, GST, from 1030 at 1.60 | Still refused: "GST on foreign-currency spend and receive money isn't supported yet…" (FXB4) |

Tests: `tests/integration/multi-currency-gst.test.ts` (MC71-MC83), and
MC2, MC10, MC25, MC64 and MC69 revised in their own tests.

### Not supported yet (refused rather than guessed)

- **Foreign-currency sales while sales count for GST when paid** (the
  payments basis): which NZD value a part payment counts at isn't settled.
  Hybrid and invoice bases work. (Foreign-currency bills on the payments or
  hybrid basis count their share of the bill's NZD value and NZD GST, at the
  bill's rate: MC80, MC82.)
- **Standard-rated GST on foreign-currency spend and receive money** (FXB4,
  MC83), and the **reverse charge on imported services** (in any currency).
- **Prepayments** of foreign-currency invoices, and **supplier
  overpayments** (as in NZD, SP3). (Foreign overpayments and refunds are
  built, MC14-MC19, and payments for several foreign documents, MC20-MC24.)
- **Paying in one currency into (or from) a bank account in a third
  currency** (a USD invoice from the EUR account): refused as NetSuite does
  (MC30). Also paying NZD documents from a foreign-currency statement line,
  and a foreign-currency document from an NZD statement line (pay it on the
  document, then match the line).
- **Credit applied across currencies**, and a contact's currency changing once
  it has documents.
- Item lines whose price would come from the item on foreign-currency
  documents (item prices are NZD). (Stock items are built: MC29.)
- **Revaluing receivables or payables again before an earlier revaluation of
  them is reversed** (NetSuite would revalue from that revaluation's rate;
  Tohyee's reverse the next day), and revaluing a currency whose open
  documents net to 0.00 (MC42).
- **An automatic daily rate feed** (NetSuite's Currency Exchange Rate
  Integration uses paid providers); rates are typed or pasted into the list
  (MC46, MC53). A question below.
- **Chargeable expenses on a project in another currency** (MC63), and
  projects in a currency without cents (JPY, XPF; MC70). (Projects and CRM
  opportunities in another currency are built: MC61-MC70.)

### Questions for Jess (multi-currency), decided

Decided on 2 Oct 2026 where still open: decisions 306-311 in `docs/DECISIONS.md` (payments basis part payments stay refused until IRD's guidance is read). What was asked is kept below.

1. Answered 1 Oct 2026 by following NetSuite (and IRD's BR Pub 04/01):
   standard-rated GST on foreign-currency invoices, credit notes, bills and
   supplier credit notes is worked out in the document's currency and each
   line's GST converted at the document's rate, rounded to cents; payments
   and revaluations never change it (MC71-MC83; MC2, MC10, MC25, MC64 and
   MC69 revised). Please check the examples. Still open: whether a printed
   tax invoice in USD should also show its GST in NZD (it shows USD only),
   and imported services under the reverse charge and GST on
   foreign-currency spend and receive money, which aren't built.
2. Payments basis: count a part-paid foreign-currency sale at its share of
   the invoice's NZD value (the time-of-supply rate), or at the payment's
   rate?
3. Answered 1 Oct 2026 by following NetSuite: rounding goes to a separate
   account, 7050 Rounding gains and losses, apart from the realised gain or
   loss on 7020 ((payment rate - document rate) x amount, rounded to cents),
   MC31-MC38 (and MC4 revised). Please check the examples.
4. Answered 1 Oct 2026 by following NetSuite: receivables and payables are
   revalued per open document (MC39-MC43; MC8 and MC19 revised), each
   rounded to cents on its own (NetSuite's help doesn't say how it rounds;
   that was the choice made). Please check the examples.
5. (Answered overnight 1 Oct 2026 by following NetSuite: foreign refunds,
   overpayments and batch payments are built, MC14-MC24, and a bank account
   in a third currency stays refused, MC30. Please check the examples.)
6. (Answered overnight 1 Oct 2026 by following NetSuite: a Currency Exchange
   Rates list is built under Accounting › Exchange rates, MC46-MC53, and new
   documents take its rate in effect on their date, else the last rate used.)
   Still yours to decide: NetSuite's automatic daily feed uses paid
   providers (HSBC, Xignite), so none is built. Should Tohyee fetch a free
   daily rate into the list (e.g. RBNZ's published rates), or keep rates
   typed and pasted?
7. Refunds (MC16-MC18): NetSuite's help doesn't show a customer refund's
   gain or loss in so many words; Tohyee treats a refund like a payment
   (refund rate against the credit's own rate, difference to 7020). Is that
   what you'd expect?
8. Answered 1 Oct 2026 by following NetSuite: each document in a payment for
   several has its own realised gain and the rounding cent goes to 7050
   (MC20 now posts 3.00 plus a 0.01 rounding loss; MC38). Please check the
   examples.
9. (Answered overnight 1 Oct 2026 by following NetSuite, whose memorized
   transactions can post automatically: a foreign repeating invoice or bill
   set to "approve" is approved when the exchange rates list has a rate
   effective on its date, and otherwise left as a draft saying why, MC52,
   MC26, MC27.) NetSuite's help doesn't say which rate a memorized
   transaction uses; Tohyee takes the rate in effect on the new document's
   date, like any new transaction. Please check.
10. (Answered overnight 1 Oct 2026 by following NetSuite, whose bill made
    from a purchase order has its own rate: a quote accepted, or a purchase
    order copied, without a rate typed takes the exchange rates list's rate
    in effect on the new document's date, else the last rate used on or
    before it, as for documents entered directly, MC51, MC25, MC28.)
11. Stock on a foreign bill is valued at the bill's rate and never adjusted
    when the bill is paid at another rate (MC29; the difference is realised
    on 7020). NetSuite's "bill exchange rate variance" only arises between an
    item receipt and a later bill, which Tohyee doesn't have. OK?
12. (Answered overnight 1 Oct 2026 by following NetSuite: a project and a
    CRM opportunity are in their customer's currency, and so are their
    invoices, MC61-MC70. Please check the examples; what's still open about
    them is under "Questions for Jess (projects)".)

## Exports and the tax code for overseas customers (examples not yet approved by Jess)

Built overnight (1 Oct 2026) at Jess's request ("should be an option and a
flag"), following NetSuite. NetSuite's tax preferences (Setting Tax
Preferences, section_N1813668) have, per nexus, a **Foreign Trade** box
("if this box is checked, the system creates the Export tax code") and a
**Tax Code for Exports**, "the default tax code for orders placed by
international customers", besides a **Default Tax Code** used "if no tax code
has been predefined for the customer or items"; its tax lookup works "based
on the shipping address of the customer". A NetSuite customer can carry its
own tax code, and any line can be changed by hand.

IRD's GST guide (IR375, March 2026, pages 7-8): exported goods, and most
services to non-residents, are **zero-rated, not exempt**: "GST is charged at
0%", the sale goes in Box 5 (total sales) and Box 6 (zero-rated supplies),
and GST on the expenses can still be claimed. **The currency of the invoice
doesn't decide it**: a USD invoice to a New Zealand customer is
standard-rated, and an NZD invoice to an overseas customer can be
zero-rated. So:

- **Contacts have a country** for their billing address and, optionally, for
  their delivery address (blank: the billing country), as ISO 3166-1 codes
  chosen from a list of names. The addresses themselves stay free text.
  Existing and new contacts are in **New Zealand** unless set otherwise. The
  contacts CSV import and export have **Country** and **Delivery country**
  columns (a code like AU or a name like Australia).
- **Settings › Exports** (admins; audited): **Foreign trade**, off for every
  organisation to start with, and the **Tax code for exports**, ZERO to start
  with, which must be an active **zero-rated** code.
- **A contact's own default sales tax code** (optional; an inactive code is
  refused).
- **A new sales line starts with**: the contact's own default sales tax code
  if it has one; else, with Foreign trade on and the delivery country (else
  the billing country) outside New Zealand, the tax code for exports; else
  Tohyee's usual default, exactly as before (the item's sales tax code, the
  account's usual code, or the first active standard-rated code). This is
  on invoices, credit notes, quotes, repeating invoices, a project's invoice
  and a won CRM opportunity's invoice, and on item lines. It's **only a
  starting value**: any line can be changed and saves as chosen, and saved
  documents never change when a contact or the settings change.
- **The flag**: a sales document for a contact outside New Zealand shows
  **Export (Australia)** (the country's name) by the customer, in the editor
  and on the document; with Foreign trade on, a standard-rated line for that
  customer shows a gentle warning, "This customer is overseas; exports are
  usually zero-rated." It never blocks saving: a service consumed in New
  Zealand can be standard-rated. The warning shows only where the lines can
  still be changed: in the editors, and on a draft invoice, credit note or
  quote or a repeating invoice that hasn't ended; not on an approved or
  finalised document (decided 1 Oct 2026; neither NetSuite nor Xero has
  such a warning, so this is Tohyee's own choice; EX25).
- **GST return**: nothing new. Zero-rated lines were already in Box 5 and
  Box 6, and exempt and no-GST lines in no box (EX11).
- **Purchases**: suppliers have a country and their own default purchase
  tax code (EX16-EX25, below); there's no import tax code (imported goods'
  GST is collected by Customs, and imported services are under the reverse
  charge, neither built).

Setup: invoice basis, GST 15%; tax codes GST (standard, 15%), ZERO (zero
rated), EXEMPT (exempt), NONE (no GST); 1100 Accounts receivable, 2100 GST,
4000 Sales (its usual code GST); an item TOUR whose sales tax code is GST.
Customers, all in NZD unless stated: **Kobe Ltd** (New Zealand), **Wombat Pty
Ltd** (Australia), **Paws LLC** (United States), **Tui Traders** (New Zealand,
in USD), **Kiwi Gifts Ltd** (billing New Zealand, delivery Australia),
**Sydney Visitors** (billing Australia, delivery New Zealand), **Harbour
Tours** (Australia, own default sales tax code GST: tours taken in New
Zealand) and **Rata Rentals** (New Zealand, own default EXEMPT: residential
rent). Amounts exclusive of GST.

| ID | What happens | Result |
| --- | --- | --- |
| EX1 | Migration 0048 on an organisation with existing contacts; a new organisation; a contact added with no country | Every existing contact: billing country **NZ** (New Zealand), no delivery country, no default sales tax code. Foreign trade **off**, tax code for exports **ZERO**, for existing and new organisations. The new contact is in **NZ** |
| EX2 | Foreign trade on. A new invoice for Kobe Ltd (New Zealand): 1 x 100.00 to 4000 | The line starts with **GST**, as before (the organisation's usual default): GST **15.00**, total **115.00** |
| EX3 | Foreign trade **off**. A new invoice for Wombat Pty Ltd (Australia) | The line starts with **GST**, as before. The invoice shows **Export (Australia)**; no warning (Foreign trade is off) |
| EX4 | An admin turns Foreign trade on. A new invoice for Wombat, 1 Jul 2026: 1 x 500.00 to 4000; another line with the item TOUR | The change is in the history (organisation.settings_updated, foreignTrade true). The line starts with **ZERO**, and stays ZERO when account 4000 (usual code GST) or the item TOUR (sales code GST) is picked. Approved: GST **0.00**, total **500.00**: Dr 1100 500.00 / Cr 4000 500.00 |
| EX5 | Foreign trade on. New invoices for Harbour Tours (Australia, own default GST) and Rata Rentals (New Zealand, own default EXEMPT); setting an inactive code OLD as a contact's default | Harbour Tours' lines start with **GST** (the contact's own code beats the tax code for exports), with the warning (EX12); Rata Rentals' with **EXEMPT** (beating the usual GST). OLD is refused: "Tax code OLD is inactive, so it can't be a contact's default sales tax code." |
| EX6 | Foreign trade on. New invoices for Kiwi Gifts Ltd (billing NZ, delivery Australia) and Sydney Visitors (billing Australia, delivery NZ) | The delivery country decides: Kiwi Gifts' lines start with **ZERO** and show **Export (Australia)**; Sydney Visitors' with **GST**, no export flag |
| EX7 | Foreign trade on. Wombat's line starts ZERO; it's changed by hand to GST, 1 x 200.00, and saved; then the customer is changed to Kobe and back | Saves with **GST**: GST **30.00**, total **230.00**. The warning shows but doesn't stop the save. A code chosen by hand stays when the customer changes |
| EX8 | Wombat's draft invoice from EX4 (ZERO) is saved. An admin then turns Foreign trade off, and Wombat's billing country is changed to New Zealand; the draft is approved | The saved draft still has **ZERO** and approves with GST **0.00**, total **500.00**. Only new lines start differently (now **GST**) |
| EX9 | Foreign trade on. An invoice for Tui Traders (New Zealand, in USD): 1 x USD 1,000.00 at **1.60** | The currency doesn't decide the tax: the line starts with **GST**. USD 1,000.00 + GST **150.00** = **1,150.00**; NZD 1,600.00 + GST **240.00** = **1,840.00** (as MC71). No export flag |
| EX10 | Foreign trade on. An invoice for Paws LLC (United States, in NZD): 1 x 800.00 | The line starts with **ZERO**: GST **0.00**, total **800.00** NZD. It shows **Export (United States)** |
| EX11 | Foreign trade on. July 2026, approved: Kobe 1 x 100.00 GST (115.00); Wombat 1 x 500.00 ZERO; Paws 1 x 800.00 ZERO; Rata Rentals 1 x 400.00 EXEMPT. The July GST return (invoice basis) | Box 5 **1,415.00** (115.00 + 500.00 + 800.00), Box 6 **1,300.00** (the exports), Box 7 **115.00**, Box 8 **15.00**. The exempt 400.00 is in **no box** (exempt sales are left out; zero-rated ones aren't) |
| EX12 | The flag and warning for Foreign trade on or off, for Wombat, Kobe and Sydney Visitors, with lines coded GST, ZERO, EXEMPT or NONE, in the editor | **Export (Australia)** by Wombat whatever the setting; nothing by Kobe or Sydney Visitors (delivered in New Zealand). The warning "This customer is overseas; exports are usually zero-rated." only with Foreign trade on, for Wombat, when a line is standard-rated (GST); not for ZERO, EXEMPT or NONE lines. On an approved invoice the flag shows but the warning doesn't (EX25) |
| EX13 | An admin sets the tax code for exports to EXEMPT, GST, NONE, an inactive zero-rated code, then a new zero-rated code EXPORT | EXEMPT is refused: "The tax code for exports must be zero-rated (like ZERO): exports are zero-rated, not exempt, so they count in Box 5 and Box 6 of the GST return. EXEMPT is exempt." GST and NONE likewise, and the inactive code ("…is inactive…"). EXPORT is accepted and audited. The database refuses a non-zero-rated code too |
| EX14 | Countries: a contact's billing country "XX", "Australia" and "au"; a contacts CSV with Country "Australia", "US" and blank, and Delivery country "AU" | "XX" is refused ("Billing country "XX" isn't a country…"); "Australia" and "au" are both **AU**. The import gives **AU**, **US** and **NZ**, and the delivery country **AU**; the export writes the codes back |
| EX15 | Foreign trade on. A won CRM opportunity's invoice for Wombat, for Harbour Tours and for Kobe; a credit note, quote, repeating invoice and project invoice for Wombat | The CRM invoices' lines are **ZERO** (Wombat), **GST** (Harbour Tours' own code) and **GST** (Kobe). The other documents' new lines start with **ZERO** in their editors, the same rule |

Tests: `tests/integration/exports.test.ts` (EX1-EX11, EX13-EX15) and
`tests/unit/exports.test.ts` (the editors' starting code, the flag and
warning, and countries: EX2-EX7, EX9, EX10, EX12, EX14).

### A supplier's default purchase tax code (examples not yet approved by Jess)

Built overnight (1 Oct 2026) after Jess asked us to settle the open export
questions by checking NetSuite and Xero. **Xero**: a contact's "Purchase
defaults" include a tax rate, used for new bill and spend money lines for
that contact. **NetSuite**: its per-nexus "Tax Code for Imports" is for
reverse-charge reporting, which isn't in New Zealand's list of NetSuite tax
features. IRD's reverse charge on imported services applies only in limited
cases, so Tohyee doesn't guess at it. So, matching the customer's default
sales tax code (EX5):

- **A contact's own default purchase tax code** (optional): any active tax
  code available on purchases (Purchases or Both, TAO7), matched ignoring
  case; an inactive (archived) one is refused, and one that became inactive
  after it was set can be kept but isn't used. The sales and purchase
  defaults are separate and each is used only on its own side.
  Changes are in the contact's history (contact.created, contact.updated).
  It's set in the contact screen for suppliers. Not in the contacts CSV
  import and export (the default sales tax code isn't either).
- **A new purchase line starts with** the contact's default purchase tax
  code if it has an active one, beating the item's purchase tax code and
  the account's usual code; else Tohyee's usual default exactly as before
  (the item's, the account's, or the first active standard-rated code). On
  bills, supplier credit notes, purchase orders, repeating bills and spend
  money (only codes the line can take: a foreign-currency bank line has no
  standard-rated codes). Receive money doesn't use it. Expense claims don't:
  their receipts' suppliers are typed names, not contacts.
- **Only a starting value**: any line can be changed and saves as chosen; a
  code chosen by hand, filled in by a bank rule, or on a saved or copied
  line stays when the supplier changes; saved documents never change when
  the contact's default does.
- Migration 0049 adds it; existing contacts have none, so nothing changes.

Setup as above (1000 bank, 2000 Accounts payable, 2100 GST, 6010 an expense
account whose usual code is GST; an item SERVER whose purchase tax code is
GST). Suppliers, all in NZD: **Cloud Apps Inc** (United States, default
purchase tax code NONE: an overseas software subscription with no New
Zealand GST charged), **Kauri Supplies** (New Zealand, no default) and
**Rata Rentals** (New Zealand, a customer and supplier: default sales tax
code EXEMPT, default purchase tax code GST). Amounts exclusive of GST unless
stated.

| ID | What happens | Result |
| --- | --- | --- |
| EX16 | Migration 0049 on an organisation with existing contacts; a new organisation; Cloud Apps added with default "none" | Existing contacts: **no** default purchase tax code. Cloud Apps' is **NONE**, in the contact.created history. Foreign trade stays **off** for new organisations (decided 1 Oct 2026, as NetSuite's Foreign Trade box is off until ticked) |
| EX17 | A new bill for Cloud Apps: 1 x 50.00 to 6010 | The line starts with **NONE** (not GST): GST **0.00**, total **50.00**. Approved: Dr 6010 50.00 / Cr 2000 50.00 |
| EX18 | A new bill for Kauri Supplies: 1 x 200.00 to 6010 | No default: the line starts with **GST** as before: GST **30.00**, total **230.00** |
| EX19 | On Cloud Apps' bill, account 6010 (usual code GST) and then the item SERVER (purchase code GST) are picked; the supplier is then changed to Kauri Supplies | The line stays **NONE** (the contact's default beats the account's and the item's). Changed to Kauri Supplies, it goes back to the usual **GST** |
| EX20 | On a bill for Cloud Apps, the line is changed by hand to GST (local support charged with GST): 1 x 100.00; the supplier is changed and back | Saves with **GST**: GST **15.00**, total **115.00**. A code chosen by hand stays when the supplier changes |
| EX21 | Cloud Apps' draft bill (1 x 50.00 NONE) is saved; its default is changed to GST; the draft is saved again and approved | The change is in the history (contact.updated, defaultPurchaseTaxCode NONE to GST). The draft keeps **NONE** and approves with GST **0.00**, total **50.00**. Only new lines start with **GST**. Clearing the default (blank) and setting NONE again over the API works |
| EX22 | Setting OLD (inactive), NOPE (no such code) and ZERO as Kauri Supplies' default; a new contact with OLD; Rata Rentals' sales and purchase lines | OLD is refused: "Tax code OLD is inactive, so it can't be a contact's default purchase tax code." (on a new contact too); NOPE: "There's no tax code NOPE."; **ZERO** is accepted (it's available on both; TAO7 refuses a sales-only code). A default that later became inactive can be kept but isn't used. Rata Rentals' sales lines start **EXEMPT**, its purchase lines **GST**; Cloud Apps' sales lines aren't affected by its purchase default |
| EX23 | Spend money to Cloud Apps from 1000: 50.00 inclusive, to 6010 | The line starts with **NONE**: GST **0.00**, total **50.00**: Dr 6010 50.00 / Cr 1000 50.00. On a foreign-currency bank line a standard-rated default (e.g. Rata Rentals' GST) isn't used, as those lines can't take it |
| EX24 | A supplier credit note (1 x 10.00), purchase order (1 x 600.00) and repeating bill (1 x 50.00 a month) for Cloud Apps | Their new lines start with **NONE** in the editors (the same rule) and save it: GST **0.00**, totals **10.00** and **600.00**, and the repeating bill's line **NONE** |
| EX25 | Foreign trade on. Wombat's invoice with a GST line: in the editor, as a draft, then approved | The warning shows in the editor and on the draft, but **not** on the approved invoice; **Export (Australia)** shows on all three (decided 1 Oct 2026) |

Tests: `tests/integration/supplier-tax.test.ts` (EX16-EX18, EX20-EX24) and
`tests/unit/supplier-tax.test.ts` (the purchase editors' starting code and
the warning: EX17-EX23, EX25; EX12 in `tests/unit/exports.test.ts` too).

### A contact's default account and tracking (examples SD1-SD3, approved by Jess 5 Oct 2026)

Stage 1 of the Xero add-ons plan (5 Oct 2026). **Xero**: a contact's
"Purchase defaults" and "Sales defaults" hold an account, a tax rate and
tracking, used for new bill, spend money, invoice and receive money lines
for that contact. **NetSuite**: a vendor's default expense account. So, next
to the default purchase and sales tax codes above:

- **Default purchase account** and **default purchase tracking** (one value
  per category), and **default sales account** and **default sales
  tracking**, all optional. The purchase account can be any active account a
  bill line can use, the sales account any active account an invoice line
  can use. Archived accounts and tracking values can't be chosen; one that's
  archived after it was set is kept but not used. Changes are in the
  contact's history. Not in the contacts CSV import and export (the default
  tax codes aren't either).
- **New lines start with** the defaults for their side: bills, supplier
  credit notes and spend money use the purchase defaults; invoices, sales
  credit notes and receive money use the sales defaults. Choosing the
  contact fills them into lines nobody has filled in yet (on a bill, a line
  with no account; on an invoice, a line with no item, description or
  price), and lines added afterwards start with them. Lines already filled
  in keep their account and tracking, so changing a draft's contact doesn't
  recode it. The GST code still comes from the contact's default tax code,
  or the usual default (TAO6). They're only a starting point: any line can
  be changed.
- **Bulk coding** (BK22) uses them too: a ticked line with no account, for
  all or its own, takes its contact's default account, GST code and tracking
  for its side (money out: purchase, money in: sales), in place of whatever
  GST code and tracking were chosen. When an account is chosen, the chosen
  GST code and tracking are used as now. With no account and no default
  it's refused as now ("Choose an account for this line").
- Bank rules don't use them: a rule's lines say their own account (BR1-BR10).

Setup: as BR1-BR10. Spark has default purchase account 6170, default
purchase tax code GST, and default purchase tracking Department Retail.

- **SD1** On a new bill, choosing Spark fills the empty first line with
  **6170**, **GST** and **Retail**, and an added line starts the same; so
  does a new spend money to Spark. Changing the line to 6120 and Wholesale
  is kept. A new invoice to Spark keeps the usual starting account (Spark
  has no sales defaults). On a draft bill whose line is already coded to
  6120, changing the contact to Spark leaves that line as it was.
- **SD2** Bulk coding the 3 Jun −230.00 SPARK line with no account and no
  contact chosen: the contact named like the payee is Spark, so the line
  takes 6170, GST and Retail: **Dr 6170 200.00 (Retail) / Dr 2100 30.00 /
  Cr 1000 230.00**, adding **230.00** to Box 11 and **30.00** to purchases
  GST. The same with 6120, GST and no tracking chosen for all uses those
  (Dr 6120 200.00 / Dr 2100 30.00 / Cr 1000 230.00, no tracking): the
  chosen account wins.
- **SD3** With 6170 archived, Spark's default account is kept but not used:
  choosing Spark on a new bill leaves the line with no account, and SD2 is
  refused with "Choose an account for this line". Choosing an archived account or tracking value as
  a default is refused, and a viewer can't change a contact (403).

### A tax code's "Available on" (examples not yet approved by Jess)

Built overnight (1 Oct 2026) after Jess asked us to "look into what NetSuite
does and do that" (question 5 below). **NetSuite**: the tax code record has
an **Available On** field, **Sales Transactions**, **Purchase Transactions**
or **Both**: "Most NetSuite Tax Codes are exclusive to either sales or
purchase transactions. However, some are available for both." And "the
default tax code you assign to a vendor must be available on purchase
transactions, otherwise you will be unable to select this tax code on
purchase orders or bills for that vendor" (Oracle help, "Setting Default Tax
Items on Vendor Records" and "Creating Alternative Tax Codes"). So:

- **Every tax code has "Available on": Sales, Purchases or Both.** Every
  existing code, and the starting NZ codes (GST 15%, Zero rated, Exempt, No
  GST), are **Both**: in New Zealand each applies to sales and purchases
  alike, so nothing changes until an admin chooses otherwise. A code added
  without a choice is Both. Migration 0050 adds it.
- **Admins choose it** when adding a code and can change it on the Tax codes
  screen (in the history as tax.code_created and tax.code_updated). Tax
  codes have no other edits yet, so this is the only change there. It
  **never changes saved documents**.
- **Sales lines** (invoices, credit notes, quotes, repeating invoices,
  receive money, project and CRM invoices) take only **Sales or Both** codes;
  **purchase lines** (bills, supplier credit notes, purchase orders,
  repeating bills, spend money, expense claim receipts) only **Purchases or
  Both**. Manual journals have no tax codes, so there's nothing to check.
  The refusal names the code and the side: "Line 1: tax code PUR is
  available on purchases only, so it can't be used on sales. Choose a tax
  code available on sales." It's checked where a line's code is checked
  today (being active and in effect): when a document is saved or approved,
  so an approved document is never checked again (voiding it works as
  before), but a draft with a code that's no longer available on its side
  can't be saved or approved until the code is changed (NetSuite: "unable to
  select"). A repeating invoice or bill whose code is no longer available
  makes nothing on that date and keeps the reason, like any other document
  it can't make.
- **Pickers** in every editor list only the codes available on their side
  (a saved line's own code still shows, as "PUR (purchases only)", so it's
  clear why it will be refused). The starting code of a new line comes only
  from those codes: the first standard-rated one, an account's usual code
  (an account is used on both sides, so its usual code is used only on the
  side it's available on; elsewhere the line keeps its code), an item's
  code, or the contact's.
- **Defaults must match** (NetSuite's rule for a vendor's default): a
  contact's **default sales tax code** must be Sales or Both and its
  **default purchase tax code** Purchases or Both (EX5, EX16); an item's
  sales tax code Sales or Both and its purchase tax code Purchases or Both;
  the **tax code for exports** (Settings › Exports) Sales or Both. **Bank
  rules** suggest receive money for money in (Sales or Both), spend money
  for money out (Purchases or Both), and a rule for either needs a Both
  code; cash coding and the reconcile screen list codes by each line's side.
  The database checks these settings too.
- **Changing "Available on" is refused while a setting uses the code on the
  side it would lose**, listing them (a contact's default, the tax code for
  exports, an item, a bank rule). NetSuite instead lets a default become one
  that can't be selected; Tohyee refuses, so no setting quietly stops
  working (Tohyee's choice, the safer one). Drafts and repeating templates
  don't stop the change; they're refused when next saved or made.
- **GST return**: nothing new. A line counts by its code's category whatever
  the code's "Available on".

Setup as above: invoice basis, GST 15%; 1000 bank, 1100 Accounts
receivable, 2000 Accounts payable, 2100 GST, 4000 Sales, 6010 an expense
account. **Kobe Ltd** (customer), **Kauri Supplies** (supplier) and **Cloud
Apps Inc** (supplier, default purchase tax code NONE, EX17). An admin has
added **PUR** "GST on purchases", standard-rated 15%, **Purchases**, and
**SAL** "GST on sales", standard-rated 15%, **Sales**. Amounts exclusive of
GST unless stated.

| ID | What happens | Result |
| --- | --- | --- |
| TAO1 | Migration 0050 on an organisation with tax codes; a new organisation; a code added without choosing; then an invoice and a bill coded GST | GST, ZERO, EXEMPT and NONE are **Both**, in existing and new organisations, and so is the added code. The invoice (1 x 100.00) has GST **15.00**, total **115.00**, and the bill (1 x 200.00) GST **30.00**, total **230.00**, as before |
| TAO2 | An invoice for Kobe: 1 x 100.00 coded PUR; a bill from Kauri Supplies: 1 x 200.00 coded PUR, approved | The invoice is refused: "Line 1: tax code PUR is available on purchases only, so it can't be used on sales. Choose a tax code available on sales." The bill: GST **30.00**, total **230.00**: Dr 6010 200.00, Dr 2100 30.00 / Cr 2000 230.00 |
| TAO3 | SAL on a bill, supplier credit note, purchase order, repeating bill and expense claim receipt; PUR on a credit note, quote and repeating invoice; SAL on an invoice (1 x 100.00); PUR on a supplier credit note (1 x 10.00) | Each wrong-side line is refused the same way ("Receipt 1: tax code SAL is available on sales only, so it can't be used on purchases. …" on the claim). The invoice: GST **15.00**, total **115.00**; the supplier credit note: GST **1.50**, total **11.50** |
| TAO4 | Spend money from 1000 to Kauri Supplies, 115.00 inclusive, coded SAL, then PUR; receive money from Kobe, 115.00 inclusive, coded PUR, then SAL | SAL on spend money and PUR on receive money are refused (spend money is purchases, receive money sales). PUR on spend money and SAL on receive money: net **100.00**, GST **15.00**, total **115.00** |
| TAO5 | Adding PUR (Purchases); adding a code with "Available on" "sometimes"; a bookkeeper, then an admin, changes EXEMPT to Sales over the API, and back to Both | PUR's tax.code_created history has availableOn **purchases**. "sometimes" is refused. The bookkeeper is refused (**403**); the admin's change is saved, with tax.code_updated {availableOn: both to sales} |
| TAO6 | Codes GST, ZERO, EXEMPT, NONE (Both), PUR, SAL and OLD (inactive): the editors' pickers and starting codes. Account 6200 Cleaning's usual code is PUR | Sales pickers list **GST, ZERO, EXEMPT, NONE, SAL**; purchase pickers **GST, ZERO, EXEMPT, NONE, PUR**. A sales draft's saved PUR line shows "PUR (purchases only)". With GST archived, new sales lines start **SAL** and purchase lines **PUR**. Picking 6200 on a bill line gives **PUR**; on an invoice line the line keeps its code |
| TAO7 | Kobe's default sales tax code PUR; Kauri Supplies' default purchase tax code SAL, then PUR; ZPUR (zero-rated, Purchases) as the tax code for exports; item TOUR with sales tax code PUR, then SAL with purchase tax code PUR | "Tax code PUR is available on purchases only, so it can't be a contact's default sales tax code. Choose a code available on sales." (on a new contact too); SAL likewise as a purchase default; PUR is accepted for Kauri Supplies. "ZPUR is available on purchases only, so it can't be the tax code for exports. Choose a zero-rated code available on sales." TOUR with PUR as its sales code is refused; with SAL and PUR it's saved. The database refuses the wrong-side settings too |
| TAO8 | Bank rules coding to 4000: money out with SAL; money in or out with SAL; money in with SAL; money in or out with GST | Refused: "…so it can't be used on a rule for money out (spend money is purchases)." and "…for money in or out (that needs a code available on both)." Money in with SAL and either way with GST are saved. The database refuses a rule changed to the wrong side |
| TAO9 | Two invoices for Kobe on 8 Jul 2026 coded GST: a draft 1 x 100.00, and 1 x 200.00 approved. An admin makes GST **Purchases**; the draft is saved again and approved; the approved one is voided; GST goes back to **Both** and the draft is approved | The draft can't be saved or approved: "Line 1: tax code GST is available on purchases only, so it can't be used on sales. …". The approved invoice is **unchanged** (GST **30.00**, total **230.00**, coded GST) and voids as before. Back on Both, the draft approves: GST **15.00**, total **115.00** |
| TAO10 | Making ZERO (the tax code for exports) Purchases; NONE (Cloud Apps' default purchase code) Sales; PUR (Kauri Supplies' default and TOUR's purchase code) Sales; SAL (TOUR's sales code, a money-in rule) Purchases; ZERO Sales | Refused: "Tax code ZERO can't be made available on purchases only while it's used for sales: the tax code for exports (Settings › Exports). Change those first."; "…NONE … used for purchases: Cloud Apps Inc's default purchase tax code…"; "…PUR …: Kauri Supplies' default purchase tax code; item TOUR's purchase tax code…"; SAL's lists item TOUR and the bank rule. **ZERO to Sales is accepted** (the export code is on the sales side). The database refuses a direct change too |
| TAO11 | A repeating invoice for Kobe from 1 Aug 2026, monthly, 1 x 100.00 coded SVC (standard 15%, Both). SVC is made Purchases; the 1 Aug run; SVC back to Both; run again | The first run makes **nothing**; the template keeps "2026-08-01: Line 1: tax code SVC is available on purchases only, so it can't be used on sales. …". The second makes the invoice: GST **15.00**, total **115.00** |
| TAO12 | A new organisation, July 2026, invoice basis: an invoice 1 x 100.00 coded SAL and a bill 1 x 200.00 coded PUR, both approved; the July GST return | Box 5 **115.00**, Box 6 **0.00**, Box 7 **115.00**, Box 8 **15.00**, Box 11 **230.00**, Box 12 **30.00**: exactly as if both were coded GST |

Tests: `tests/integration/tax-available-on.test.ts` (TAO1-TAO5, TAO7-TAO12)
and `tests/unit/tax-available-on.test.ts` (the pickers, starting codes and
refusals: TAO2-TAO4, TAO6, TAO8).

### Not supported yet (refused rather than guessed)

- **Imports**: no import tax code (NetSuite's "Tax Code for Imports" is for
  reverse-charge reporting, not in New Zealand's list), no reverse charge on
  imported services (IRD applies it only in limited cases), and no Customs
  GST on imported goods. Put the right code on the line by hand.
- **A default purchase tax code on expense claims, cash coding and bank
  rules**: expense claim receipts name their supplier as text, not a
  contact, and cash coding and bank rules keep the code they're given.
- **Deciding which services to non-residents are zero-rated**: IR375 has
  exceptions (e.g. services to a non-resident who's in New Zealand when they
  receive them). Tohyee only suggests the tax code for exports by country and
  warns; the person entering the line decides.
- **Checking the export evidence** (IRD's time limits for goods to leave New
  Zealand, customs export entries): not recorded.
- **Tax lookup by region** (NetSuite's "Enable Tax Lookup on Sales and
  Purchases" by state or province): only the country is used.
- **"Available on" for opening balances**: invoices and bills brought in
  when converting existing books (IM13, IM17-IM20) record documents raised
  in the old system, so their codes aren't checked against Available on.
  Other tax code changes (renaming, archiving, rates) aren't on the Tax
  codes screen yet.

### Questions for Jess (exports), decided

All decided on 1 Oct 2026 (below).

1. Decided 1 Oct 2026 (following NetSuite, whose Foreign Trade box is off
   until ticked): Foreign trade stays **off** for every organisation to
   start with, new ones too.
2. Decided 1 Oct 2026 (following NetSuite, whose tax lookup uses the
   shipping address): the **delivery country beats the billing country**; a
   customer with no delivery country uses the billing country.
3. Decided 1 Oct 2026 (following Xero's contact "Purchase defaults" tax
   rate): suppliers get a **default purchase tax code** (EX16-EX24). **No
   import or reverse-charge code**: NetSuite's Tax Code for Imports is for
   reverse-charge reporting, which isn't in New Zealand's list, and IRD's
   reverse charge on imported services applies only in limited cases, so
   it's refused rather than guessed.
4. Decided 1 Oct 2026 (neither NetSuite nor Xero has such a warning, so
   this is Tohyee's choice): the warning shows **only where lines can still
   be changed** (editors and drafts), not on approved documents; the
   Export (country) flag stays everywhere (EX25).
5. Decided 1 Oct 2026 following NetSuite ("look into what NetSuite does and
   do that"): tax codes have NetSuite's **Available on** (Sales, Purchases
   or Both), every existing and starting NZ code is Both, sales lines take
   Sales or Both codes and purchase lines Purchases or Both, a contact's
   defaults, items' codes, bank rules and the tax code for exports must be
   on their side, and saved documents never change (TAO1-TAO12). Where
   NetSuite lets a default become unusable, Tohyee refuses changing a
   code's Available on while a setting uses it on that side, and lists them.

## Reports

The financial year ends on the last day of a month chosen in Settings
(default: 31 March, NZ's standard balance date). There are no year-end closing
journals; the balance sheet works profit out when it runs (see "Year end and
period close", YE1-YE4).

- **P1** The trial balance always balances; totals of debits = credits.
  It's NetSuite's trial balance (decided 1 Oct 2026, following NetSuite; see
  "Trial balance" under "Year end and period close", TB1-TB4): balance sheet
  accounts show every posting to the date, income and expense accounts only
  this financial year's, and earlier years' profit is in retained earnings.
- **P2** Balance sheet: assets = liabilities + equity + earnings from previous
  years + current year earnings (retained earnings is the retained earnings
  account plus earnings from previous years). With a 31 March year end, a balance sheet at
  31 Dec 2026 counts profit from 1 Apr 2026 as current year earnings. Sales of
  7.00 on 20 Jan and 5.00 on 10 Feb 2026 belong to the year that ended
  31 Mar 2026, so they show as **12.00** of earnings from previous years. With
  a December year end the same sheet shows **0.00** from previous years.
- **P3** Profit and loss: net profit = income - cost of sales + other
  income - expenses. Without a start date it covers the financial year to
  date, and then equals the balance sheet's current year earnings.

### Custom reports

A custom report is a copy of a standard report (profit and loss or balance
sheet) that can be changed: its title, its columns, its rows, and extra
tables and notes (decided with the owner, 29 Sep 2026). It posts nothing and
changes no figures in the ledger; its numbers come from the same account
totals as the standard reports, worked out when it's opened.

- **Columns** are whole calendar periods ending on a month end: 1 to 12
  months, quarters (3 months) or years (12 months), newest first. Profit and
  loss columns cover each period; balance sheet columns are as at each
  period's last day. Options: a **difference** column (the first column less
  the second) with a **%** column (difference / the second column's amount,
  as a percentage rounded to 1 decimal place, halves away from zero; blank
  when the second column is 0.00), and for profit and loss only a **year to
  date** column (from the start of the financial year that the first
  column's period ends in). A profit and loss can also have a budget
  column and an actual less budget column (see "Budgets", BU7).
- **Rows** belong to a table. A **group** lists accounts, chosen by account
  type or by account code, each in its natural direction as on the standard
  reports (income as credits, costs as debits), with a total; it can show
  its accounts or just its total. A **formula** row adds and subtracts other
  rows of the same table (groups, formulas, earnings lines). A **heading**
  is just text. The balance sheet's **earnings** rows (previous years and
  current year) are worked out as on the balance sheet (P2). Rows can be
  renamed, moved up and down, added and deleted.
- A report can have several **tables** and **notes** (text blocks), in any
  order.
- Nothing is hidden: accounts with a balance that aren't in any group are
  listed under "Not in this report", and an account in more than one group
  is flagged, so a report that no longer adds up to the ledger says so.
- **Published** means a frozen copy: publishing keeps the figures, rows and
  columns as they were at that moment, and a published report never changes
  (the database refuses). The draft stays editable. Drafts and published
  reports can be archived and brought back; only drafts can be deleted.

Setup: the starting chart, a 31 March year end, and these journals (Dr / Cr,
all through 1000 Business bank account):

| Date | Journal |
| --- | --- |
| 1 Mar 2026 | Dr 1000 5,000.00 / Cr 3000 Owner funds introduced |
| 20 Mar 2026 | Dr 1000 500.00 / Cr 4000 Sales |
| 10 Apr 2026 | Dr 1000 1,000.00 / Cr 4000 Sales |
| 15 Apr 2026 | Dr 6010 Accounting fees 100.00 / Cr 1000 |
| 12 May 2026 | Dr 1000 1,500.00 / Cr 4000 Sales |
| 13 May 2026 | Dr 5000 Cost of goods sold 400.00 / Cr 1000 |
| 8 Jun 2026 | Dr 1000 1,200.00 / Cr 4000 Sales |
| 9 Jun 2026 | Dr 5000 300.00 / Cr 1000 |
| 20 Jun 2026 | Dr 6010 250.00 / Cr 1000 |
| 30 Jun 2026 | Dr 1000 20.00 / Cr 4200 Interest income |

- **CR1** A new custom report from **Profit and loss**, one month ending
  30 Jun 2026, has the rows Revenue (group: revenue accounts), Cost of sales
  (direct costs), Gross profit (formula: Revenue - Cost of sales), Other
  income, Expenses (expenses and depreciation) and Net profit (formula:
  Gross profit + Other income - Expenses). June: Revenue **1,200.00** (4000),
  Cost of sales **300.00** (5000), Gross profit **900.00**, Other income
  **20.00** (4200), Expenses **250.00** (6010), Net profit **670.00**, the
  same as the standard profit and loss for 1-30 Jun 2026.
- **CR2** Three monthly columns ending 30 Jun 2026, with difference, % and
  year to date (1 Apr - 30 Jun 2026):

  | Row | Jun 2026 | May 2026 | Apr 2026 | Difference | % | Year to date |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: |
  | Revenue | 1,200.00 | 1,500.00 | 1,000.00 | -300.00 | -20.0 | 3,700.00 |
  | Cost of sales | 300.00 | 400.00 | 0.00 | -100.00 | -25.0 | 700.00 |
  | Gross profit | 900.00 | 1,100.00 | 1,000.00 | -200.00 | -18.2 | 3,000.00 |
  | Other income | 20.00 | 0.00 | 0.00 | 20.00 | (blank) | 20.00 |
  | Expenses | 250.00 | 0.00 | 100.00 | 250.00 | (blank) | 350.00 |
  | Net profit | 670.00 | 1,100.00 | 900.00 | -430.00 | -39.1 | 2,670.00 |

  The year to date equals the three months added up, and the March sale
  (last financial year) isn't in it.
- **CR3** Two quarterly columns ending 30 Jun 2026: Apr-Jun 2026 net profit
  **2,670.00**, Jan-Mar 2026 **500.00**, difference **2,170.00**, **434.0**%.
- **CR4** Changing rows (June, as CR1): renaming Revenue to "Sales" and
  showing its total only, and moving Expenses above Gross profit, change no
  figures. A new formula row "Trading result" = Gross profit - Expenses is
  **650.00**. A new group "Accounting fees" with account 6010 only is
  **250.00**, and 6010 is then flagged as in two groups. Deleting Other
  income is refused while Net profit uses it; after Net profit is deleted it
  works, and 4200 Interest income (**20.00** in June) is listed under "Not
  in this report".
- **CR5** A second table "Cash" with one group of account 1000 (as at the
  end of each column's period on a balance sheet; for profit and loss the
  movement in the period, so June: 1,200.00 + 20.00 - 300.00 - 250.00 =
  **670.00**) and a note "Figures are unaudited." sit after the first
  table, in that order; moving the note up puts it first.
- **CR6** A new custom report from **Balance sheet**, two monthly columns
  ending 30 Jun 2026, with difference and %: Assets **8,170.00** / **7,500.00**
  (1000), Liabilities **0.00** / **0.00**, Net assets (formula: Assets -
  Liabilities) **8,170.00** / **7,500.00**, Equity accounts **5,000.00** (3000),
  Earnings from previous years **500.00** / **500.00**, Current year
  earnings **2,670.00** / **2,000.00**, Total equity (formula) **8,170.00** /
  **7,500.00**; Net assets difference **670.00**, **8.9**%. The same as the
  standard balance sheet at 30 Jun and 31 May 2026. A year to date column is
  refused on a balance sheet.
- **CR7** Publishing CR2 keeps a frozen copy. After another sale of 100.00
  on 15 Jun 2026 (Dr 1000 / Cr 4000), the draft shows June Revenue
  **1,300.00** and Net profit **770.00**; the published copy still shows
  **1,200.00** and **670.00**. Changing or deleting a published report is
  refused, also by the database; archiving it and bringing it back works.
  A draft can be deleted.
- **CR8** Refused, and nothing is saved: a period end that isn't a month end
  (15 Jun 2026); 0 or 13 columns; a % column without a difference column; a
  difference column with only one period; a formula that uses itself, or two
  formulas that use each other; a formula using a row of another table; an
  unknown account code; an empty title, or one over 200 characters; a note
  over 5,000 characters; more than 20 tables and notes, or 100 rows in a
  table.
- **CR9** A custom report's figures for a column always equal the standard
  report for the same dates (P&L for its period; balance sheet at its last
  day), whatever the rows, as long as nothing is "Not in this report" or in
  two groups.
- **CR10** Viewers can open drafts and published reports; only bookkeepers
  and admins can create, change, publish, archive and delete them. Opening a
  report posts nothing.

### Transaction-style custom reports

Jess's direction (3 Oct 2026): like Xero for the look (pick columns, reorder
them, Save as custom, draft or published), and like NetSuite for custom
fields, which belong to a contact, a document or a line. Anything more
advanced (items by category, say) is done in Analytics, which has every
invoice line.

An account transactions, aged receivables or payables, sales by salesperson
or journal report can be saved as a custom report with its own title,
filters and ordered columns; the standard report is unchanged. Extra columns
only add information: they never change an amount or a total, and saving or
publishing posts nothing. Contact columns (email, addresses, phone, group,
contact fields) and document fields are offered on every one of these
reports. Line fields and tracking are only offered where each row is one
ledger line (account transactions and the journal report), so a cell never
mixes several lines' values. Sales post one ledger line per account and
tracking (TC3), so on account transactions an invoice's sales line shows its
tracking but not an invoice line's own field.

Setup: the custom-report journals above (CR1-CR10), advanced features on,
salesperson Aroha. Kobe Ltd is a customer with email
`accounts@kobe.example.nz`, billing address `1 Kauri Road, Dunedin`, group
`Trade`, contact field **Region** `Otago` and default salesperson Aroha.
Invoice INV-REPORT-1 for Kobe Ltd, 20 May 2026, **100.00 + GST 15.00**, has
document field **Channel** `Web`; its one line (4000) has line field
**Project** `Fit-out` and Location `Dunedin`.

- **CR11** Account transactions for 4000, 1 April-31 May 2026, saved with
  Date, Source, email, address, group, Region, Channel, Project, Location,
  Credit and Balance: credits **1,000.00**, **1,500.00** and **100.00**,
  total credits **2,600.00**, the same as the standard report. The invoice's
  row shows `accounts@kobe.example.nz`, `1 Kauri Road, Dunedin`, `Trade`,
  `Otago`, `Web` and `Dunedin`, with Project blank; the manual journals'
  rows have blank contact and Location cells.
- **CR12** Aged receivables as at 31 May 2026, saved with Region before
  Contact, then Channel, Current and Total: Kobe Ltd **115.00** current,
  Region `Otago`, its invoice Channel `Web`; total **115.00**. Project and
  Location can't be added ("That report column isn't available.").
- **CR13** Sales by salesperson for May 2026 saved with Region and Channel:
  Aroha **1** invoice, sales **100.00**, credit notes **0.00**, net
  **100.00**, and the same total; the invoice shows `Otago` and `Web`.
  Project and Location can't be added.
- **CR14** A journal on 25 May 2026, Dr 6010 **50.00** (Project `Fit-out`,
  Location `Dunedin`) / Cr 1000 **50.00**. The journal report for that day
  saved with Project and Location shows `Fit-out` and `Dunedin` on the debit
  line and blanks on the credit line, and equals the standard journal
  report.
- **CR15** The CR12 report with Contact, email and Total, saved and then
  published (no journal is posted). After Kobe's email changes to
  `ap@kobe.example.nz`, a viewer opening the draft sees the new email and
  the published report still shows `accounts@kobe.example.nz`; both total
  **115.00**.

### Home

Home shows a card for each bank account, money owed to you, bills to pay and
the next GST return. It's worked out whenever it's opened, posts nothing, and
viewers can see it. "Today" is the date in the business time zone
(Pacific/Auckland unless `TOHYEE_TIME_ZONE` says otherwise).

- **H1** Bank accounts: one card for each active bank or credit card account,
  with its balance in Tohyee (the ledger), its statement balance if any, and
  "Reconcile N items" for its unreconciled statement lines (excluded lines
  don't count), "No statement yet: import one" when no statement has been
  imported or synced (2 Oct 2026: it used to say "All reconciled" then), or
  "All reconciled". Archived accounts aren't shown.
- **H2** Money owed to you, on 1 Jun 2026: INV-0001 (115.00, due 20 Jun,
  50.00 paid) and INV-0002 (230.00, due 10 May, nothing paid): owed
  **295.00** on **2** invoices, of which **230.00** on **1** invoice is
  overdue (due before today; an invoice due today isn't overdue). Drafts,
  voided invoices and paid invoices don't count. Credit applied (CN3) and
  overpayment credit applied (OP2) lower what's owed; credit that hasn't been
  applied yet doesn't.
- **H3** Bills to pay works the same way for approved bills, less supplier
  payments and supplier credit applied: B1 (230.00, due 30 Jun, 115.00 paid)
  and B4 (135.00, due 20 May): **250.00** on **2** bills, **135.00** overdue
  on **1**.
- **H4** Next GST return: the period straight after the latest filed return,
  by the GST period setting (GP3), or without one the same length. With Feb-Mar 2026 filed (no setting), it's **1 Apr - 31 May 2026**,
  with Box 15 worked out as the GST return would on the organisation's basis,
  with no adjustments (G1 gives **-15.00**, a refund). If no GST return has
  been filed in Tohyee, Home says so and links to the GST return instead of
  guessing the period. If the GST return can't be worked out (e.g. a
  standard-rated line at another rate, G9), Home shows why.

## GST return

The GST return is New Zealand's GST101A (boxes 5-15), worked out from
approved documents on the organisation's GST basis: **invoice** (G1-G9),
**payments** or **hybrid** (G10-G22). Nothing is typed in except the Box 9
and Box 13 adjustments. The rules below are the invoice basis; the payments
and hybrid bases change only *when* a document counts.

- A **GST event** is a document change on a date. Only these count:
  - a sales invoice approved (+, on its invoice date) or voided (-, on its
    void date);
  - a sales credit note approved (-, on its date) or voided (+, on its void
    date);
  - a bill approved (+, on its bill date) or voided (-, on its void date);
  - a supplier credit note approved (-, on its date) or voided (+, on its
    void date);
  - spend or receive money posted (+, on its date; spend counts like a bill,
    receive like an invoice) or voided (-, on its void date). See BK6, BK7.

  Drafts never count. Payments, refunds, credit applications, manual
  journals, stock movements and FX revaluations don't count.
- Each line of a counted document goes by its tax code's category (a line
  with no tax code counts as out of scope). Amounts are the line's amount
  including GST (its net amount plus its GST).
  - Sales: standard -> Box 5; zero rated -> Box 5 and Box 6; exempt and out
    of scope -> left out.
  - Purchases: standard -> Box 11; zero rated, exempt and out of scope ->
    left out (no GST to claim). Confirmed with the owner (29 Sep 2026): only
    zero-rated sales are reported (Box 6); zero-rated purchases stay out of
    Box 11.
- Boxes are exact decimals with 2 places, rounded half away from zero:
  Box 7 = 5 - 6; Box 8 = Box 7 x 3 / 23; Box 9 = debit adjustments;
  Box 10 = 8 + 9; Box 12 = Box 11 x 3 / 23; Box 13 = credit adjustments;
  Box 14 = 12 + 13; Box 15 = 10 - 14 (positive: GST to pay; negative: a
  refund). Boxes can be negative, e.g. a period with more credit notes than
  sales.
- **GST on transactions** is the sum of the counted lines' own GST (sales and
  purchases separately). Its difference from Box 8 and Box 12 is shown as
  information only (rounding).
- Box 9 (debit) and Box 13 (credit) adjustments are GST amounts with a
  description, each more than zero with at most 2 decimal places.
- A return covers 1, 2 or 6 whole calendar months: it starts on the 1st and
  ends on the last day of a month.
- **Mark as filed** (admins only) stores the period, basis, adjustments, every
  box and the counted lines, with who filed it and when. Filed returns can't
  be changed, deleted or truncated, and two filed returns can't cover the
  same day. A filed return shows its stored figures; if the figures worked out
  now differ, it shows "Changed since filed" with each changed box's filed
  and current values.

Period 1 Apr 2026 - 31 May 2026 unless stated, with documents dated inside
it. I1, I5, I6, B1, B4, CN-0001 and CR-7 are the documents from the examples
above.

- **G1** I1 (standard, total 115.00) and B1 (standard, total 230.00):
  Box 5 **115.00**, Box 6 **0.00**, Box 7 **115.00**, Box 8 **15.00**,
  Box 9 **0.00**, Box 10 **15.00**, Box 11 **230.00**, Box 12 **30.00**,
  Box 13 **0.00**, Box 14 **30.00**, Box 15 **-15.00** (a refund of 15.00).
- **G2** I5 (100.00 standard + 50.00 zero rated, exclusive, total 165.00):
  Box 5 **165.00**, Box 6 **50.00**, Box 7 **115.00**, Box 8 **15.00**.
- **G3** Left out: I6 (no tax, 80.00) and an invoice line with an exempt
  code. B4 (100.00 at 15% + 20.00 exempt, total 135.00): Box 11 **115.00**,
  Box 12 **15.00**. A zero-rated bill line of 50.00 is left out of Box 11.
- **G4** Credit notes: I1 plus CN-0001 (exclusive 1 x 20.00 at 15%, total
  23.00): Box 5 **92.00**, Box 8 **12.00**. B1 plus supplier credit note
  CR-7 (total 46.00): Box 11 **184.00**, Box 12 **24.00**. Credit
  applications and payments change nothing.
- **G5** Timing: I1 dated 31 Mar 2026 and voided 15 Apr 2026. The Feb-Mar
  return has Box 5 **115.00**; the Apr-May return has Box 5 **-115.00** and
  Box 8 **-15.00**. A draft invoice dated in the period is left out. A
  customer payment dated in the period changes nothing.
- **G6** Rounding: three invoices of 1 x 10.00 inclusive at 15% (GST 1.30
  each): Box 5 **30.00**, Box 8 = 30.00 x 3/23 = 3.913 -> **3.91**; GST on
  transactions **3.90**, difference **0.01**.
- **G7** Adjustments: with G1, a Box 9 adjustment of 23.00 and a Box 13
  adjustment of 11.50: Box 10 **38.00**, Box 14 **41.50**, Box 15 **-3.50**.
  Adjustments of 0.00, -1.00 or 1.001 are refused.
- **G8** Filing G1 stores its boxes; retrying with the same idempotency key
  returns the same return; filing another return that overlaps it by any day
  (e.g. 1 May - 31 May) is refused; a viewer or bookkeeper can't file. After
  filing, approving a bill dated 10 May makes the filed return show "Changed
  since filed" with Box 11 and Box 12 filed vs current. The database refuses
  to change or delete a filed return.
- **G9** Periods: 1 Apr - 30 Apr, 1 Apr - 31 May and 1 Apr - 30 Sep are
  allowed; 2 Apr - 31 May, 1 Apr - 30 Jun (3 months) and 1 Apr - 15 May are
  refused. A standard-rated line at a rate other than 15% in the period is
  refused, naming its document.

### Late changes to filed GST periods (examples LG1-LG7, approved by Jess 3 Oct 2026)

From Jess's issue #88: a change dated in a period whose return has been
filed (for example GST on an asset that wasn't claimed) is ignored by every
later return. Today the filed return just shows "Changed since filed" (G8).

**Follow Xero** (Jess, 3 Oct 2026). Xero's help: "If you approved, edited,
voided or deleted transactions in Xero after you finalised the GST return
for that period, you can include these transactions as late claims on the
current GST return." Its late claims sit in the ordinary boxes of the
return, can be turned on or off, and can be filtered to on the
transactions list (Xero product ideas forum; Xero's own page on turning
them off couldn't be read here). That's also how practices handle them
(Jess: "we just jammed it into sales or expenses", and adjustments often
wait until year end).

**IRD's rules are shown, not enforced** (Jess: "just say IRD says this but
if you want we can"). Checked 3 Oct 2026:

- GST on a purchase that wasn't claimed can be claimed in a later return
  within 2 years (GST Act s20(3)); after that only in a few cases (the
  supply information couldn't be got, the price was disputed, it was
  wrongly thought not to be a taxable supply, or a clear mistake or simple
  oversight).
- Other mistakes can be fixed in the next return if the tax difference in
  total is $1,000 or less, or no more than the lower of $10,000 and 2% of
  the output tax for the return period (Tax Administration Act s113A);
  otherwise IRD expects the earlier return to be amended.

**Proposed rules:**

- A **late claim** is a GST event (as defined above) dated inside a filed
  return's period that isn't one of the lines stored when that return was
  filed. Voids are dated when they're voided, so a void after filing is an
  ordinary event in the current period, not a late claim.
- The next return **includes late claims automatically**, in the ordinary
  boxes (sales in Box 5/6, purchases in Box 11), and marks them "Late claim
  · from Apr-May 2026" in its list of transactions, which can be filtered to
  late claims only. Each can be **turned off**; a late claim turned off
  stays waiting for a later return, and the filed return it belongs to
  keeps showing "Changed since filed" (G8).
- Where IRD's rules say otherwise, the late claim shows a note starting
  "IRD says", with nothing blocked and nothing extra to fill in:
  - a purchase more than 2 years old: "IRD says GST on purchases more than
    2 years old can only be claimed in a few cases";
  - when the other late claims add up to more than $1,000 of GST: "IRD says
    changes over $1,000 (or over the lower of $10,000 and 2% of output tax)
    should be fixed by amending the earlier return".
- **Filing** stores the late claims it included with their own dates and
  the period they belong to, so they're never counted twice.

Filed: the Apr-May 2026 return (G1: I1 and B1). Working on the Jun-Jul 2026
return.

- **LG1** On 10 Jun 2026, bill B9 is entered for a laptop bought on 20 May
  2026: 2,300.00 including GST, GST **300.00**. The Jun-Jul return includes
  it: Box 11 goes up by **2,300.00** and Box 12 by **300.00**, and B9 is
  listed as "Late claim · from Apr-May 2026". No IRD note (within 2 years).
  The Apr-May return still shows "Changed since filed" (Box 11 230.00 ->
  2,530.00).
- **LG2** Filing the Jun-Jul return stores B9 as a late claim belonging to
  Apr-May. The Aug-Sep return doesn't include B9 again. The Apr-May return
  now says B9 was claimed in the Jun-Jul return.
- **LG3** Turning B9 off: Box 11 and Box 12 go back down by 2,300.00 and
  300.00. B9 is offered again in the Aug-Sep return.
- **LG4** Invoice I20 dated 15 May 2026, entered 5 Jun 2026: 1,150.00
  including GST, GST **150.00**. Included: Box 5 goes up by **1,150.00**
  and Box 8 by **150.00**. No IRD note (150.00 is within $1,000).
- **LG5** Invoice I21 dated 15 May 2026 for 11,500.00 including GST, GST
  **1,500.00**. Included like LG4 (Box 5 +11,500.00, Box 8 +1,500.00), with
  the note "IRD says changes over $1,000 … should be fixed by amending the
  earlier return". It can be turned off as in LG3.
- **LG6** A bill dated 10 Mar 2024 (GST 45.00) entered in Jun 2026 is
  included (Box 11 +345.00, Box 12 +45.00) with the note "IRD says GST on
  purchases more than 2 years old can only be claimed in a few cases".
- **LG7** On the payments and hybrid bases, the same applies to payments
  dated in a filed period that were entered after it was filed.

Sources:
- Xero, View transactions on your GST return ("Check the GST return
  includes late claims"): https://central.xero.com/0/article/The-GST-Audit-Report
- Xero late claims in the return body (product ideas forum): https://productideas.xero.com/forums/967133-reports-tax/suggestions/48289109-nz-gst-keep-separate-late-claims-tab
- IRD, Fixing mistakes in my return: https://www.ird.govt.nz/managing-my-tax/fixing-mistakes-in-my-return
- IRD SPS 20/03, correcting errors: https://www.taxtechnical.ird.govt.nz/standard-practice-statements/investigations/sps-20-03
- IRD QB 09/04 on s113 TAA and s20(3) GST Act: https://www.taxtechnical.ird.govt.nz/questions-we-ve-been-asked/2009/qb-0904-the-relationship-between-section-113-of-the-taa-and-the-proviso-to-section-20-3-of-the-gst-a
- Not verified: the current text of GST Act s20(3); whether Xero includes
  late claims automatically or only when turned on; whether Xero offers a
  turned-off late claim again in later returns.

### GST period setting (examples not yet approved by Jess)

Decided 1 Oct 2026, following NetSuite's tax periods ([Tax Periods
Overview](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4454154841.html):
"A tax period can be a month, a quarter, or a year, depending on the
frequency of your tax submissions", and "you can define tax periods
independently of your accounting periods"). IRD's [Which GST accounting
basis and filing frequency should I
use?](https://www.ird.govt.nz/gst/registering-for-gst/which-gst-accounting-basis-and-filing-frequency-should-i-use)
gives the NZ choices: monthly, two-monthly, or six-monthly, and with a
31 March balance date two-monthly filers "file for periods ending in odd
months" and six-monthly filers "for periods ending 30 September and 31
March". Only the calendar is used here; no thresholds or rates are checked.

- An organisation setting (Settings, admins): **Not set**, **Monthly**,
  **Two-monthly** ending in odd months (January, March, ...) or even months
  (February, April, ...), or **Six-monthly** ending in a pair of months six
  apart (January and July, ..., June and December). Choosing two-monthly or
  six-monthly without a month lines the periods up with the financial year
  end, as IRD does with the balance date. Stored as the months (1, 2 or 6)
  and the first month of the year a period ends in; changes are audited.
- The **GST return** opens on the period after the latest filed return;
  with none filed, on the latest period (by the setting) that has ended. It
  shows the setting. Periods can still be picked by hand (G9).
- **Home**'s next GST return (H4) and the **period close** GST check
  (PC8) take the periods after the latest filed return from the setting:
  each runs from the day after the last one to the end of the setting's
  period that day is in, so after a change of frequency the first one can
  be shorter (a changeover). Without a setting they keep the old rule (the
  same length as the latest filed return). With nothing filed, Home still
  says so and the check still needs attention if there's a GST number.

Tests: `tests/unit/gst-return.test.ts` (GP1, GP2, GP4) and
`tests/integration/period-close.test.ts` (GP3, GP5, GP6).

- **GP1** The period a date is in: 15 Jun 2026 is in **1 Jun - 31 Jul 2026**
  (two-monthly, odd), **1 May - 30 Jun 2026** (even), **1 Apr - 30 Sep
  2026** (six-monthly, March and September) and **1 Jun - 30 Jun 2026**
  (monthly); 10 Dec 2026 (odd) is in 1 Dec 2026 - 31 Jan 2027; 15 Jan 2027
  (March and September) in 1 Oct 2026 - 31 Mar 2027; 10 Feb 2028 (monthly)
  in 1-29 Feb 2028. Two-monthly ending in September is odd months; six-monthly
  ending in September is March and September. 3 months, or month 13, is
  refused.
- **GP2** After a filed return for 1 Apr - 31 May 2026: two-monthly odd,
  **1 Jun - 31 Jul 2026**; even, **1 Jun - 30 Jun 2026** (the changeover),
  then 1 Jul - 31 Aug; monthly, 1 Jun - 30 Jun; no setting, 1 Jun - 31 Jul
  (as before). After 1 Oct 2025 - 31 Mar 2026 (six-monthly, March and
  September): 1 Apr - 30 Sep 2026.
- **GP3** Home, on 5 Jul 2026 with Apr-May filed and two-monthly even: the
  next GST return is **1 Jun - 30 Jun 2026**, the same period the GST return
  opens on.
- **GP4** The GST return opens on: nothing filed, two-monthly odd, on
  1 Oct 2026: **1 Aug - 30 Sep 2026**; on 30 Sep 2026 (that period hasn't
  ended): 1 Jun - 31 Jul 2026; six-monthly March and September on 1 Oct 2026:
  1 Apr - 30 Sep 2026. With Aug-Sep filed: **1 Oct - 30 Nov 2026**. With no
  setting and nothing filed there's no suggestion (it opens on this month,
  as before).
- **GP5** Period close, with a GST number and Apr-May 2026 filed:
  two-monthly odd: June passes ("Filed to 31 May 2026. GST period setting:
  Two-monthly, ending in odd months ..."), July needs **1 Jun - 31 Jul
  2026**. Even: June needs **1 Jun - 30 Jun 2026**; August needs that and
  **1 Jul - 31 Aug 2026**. Monthly: July needs June and July. Cleared: July
  needs 1 Jun - 31 Jul 2026 (PC8).
- **GP6** Setting two-monthly with no month on a 31 March year end gives odd
  months, recorded in the audit log; 3 months or month 13 is refused and
  changes nothing.

### Payments and hybrid bases

Sources: IRD's IR375 GST guide (March 2026) and IR546 "Change of GST
accounting basis" (March 2026). On the **payments basis** GST is accounted
for when a payment is made or received; on the **hybrid basis** sales are on
the invoice basis and purchases on the payments basis. IRD's guides don't
say how to split a part payment across a document's lines or when a credit
note counts on the payments basis; Tohyee's choices for those are marked
*(Tohyee's rule)*.

- **Which documents count when**:

  | Basis    | Sales invoices and credit notes | Bills and supplier credit notes |
  |----------|---------------------------------|---------------------------------|
  | Invoice  | when approved / voided (G1-G9)  | when approved / voided (G1-G9)  |
  | Payments | when settled                    | when settled                    |
  | Hybrid   | when approved / voided          | when settled                    |

  Spend and receive money count on their date on every basis: they're paid
  when they're posted.
- A document is **settled** by these, each on its own date:
  - a customer payment against an invoice (only the part that pays the
    invoice, not an overpayment);
  - a supplier payment against a bill;
  - credit applied from a credit note to an invoice, or from a supplier credit
    note to a bill. This settles **both** documents: the invoice (or bill)
    counts +, the credit note counts - *(Tohyee's rule)*;
  - a credit note refund (the credit note counts -), or a refund received on a
    supplier credit note (-) *(Tohyee's rule)*;
  - overpayment credit applied to another invoice (that invoice counts +).

  Voiding a payment or refund, or removing an application, counts the same
  amounts the other way on its void or removal date. An overpayment refund
  never counts (the overpayment was never counted). Approving or voiding a
  document counts nothing on its own: a document can't be voided while it
  has payments, credit or refunds, so nothing of it is left counted.
- **Split in proportion** *(Tohyee's rule)*: a settlement counts each line of
  the document by its share: line amount (including GST) x amount settled /
  document total, rounded to 2 places, half away from zero. Any cent left over
  goes to the line with the largest amount (the first such line), so the
  shares add up to exactly the amount settled. The line's GST share is worked
  out the same way (the leftover cent going to the line with the most GST),
  and adds up to the document's GST x amount settled / document total. Each
  share then goes in the boxes by the line's tax code as on the invoice basis.
  Across several part payments a line's shares can differ from the line by a
  cent; the amount settled is always exact.

Documents (all exclusive, from the examples above): **I1** 1 x 100.00 at 15%,
total 115.00; **I5** 100.00 at 15% (115.00) + 50.00 zero rated, total
165.00; **CN-0001** 1 x 20.00 at 15%, total 23.00; **B1** 1 x 200.00 at 15%,
total 230.00; **CR-7** 1 x 40.00 at 15%, total 46.00. Periods are two months
unless stated.

- **G10** Payments basis, paid later: I1 dated 25 Mar 2026, paid 115.00 on
  20 Apr. Feb-Mar: Box 5 **0.00**. Apr-May: Box 5 **115.00**, Box 8
  **15.00**, one line "customer payment" dated 20 Apr.
- **G11** Part payment: I5 paid 82.50 on 15 Apr. Shares 115.00 x 82.50 /
  165.00 = **57.50** (standard) and 50.00 x 82.50 / 165.00 = **25.00** (zero
  rated). Apr-May: Box 5 **82.50**, Box 6 **25.00**, Box 7 **57.50**, Box 8
  **7.50**. The other 82.50, paid 10 Jun, counts in Jun-Jul the same way.
- **G12** Rounding a share: an invoice, inclusive, with three lines of 10.00
  (standard, standard, zero rated; GST 1.30, 1.30, 0.00; total 30.00) paid
  10.00. Each share is 3.333 -> 3.33, which adds up to 9.99, so the first
  line gets the leftover cent: **3.34**, **3.33**, **3.33**. Box 5
  **10.00**, Box 6 **3.33**, Box 7 **6.67**, Box 8 = 6.67 x 3/23 = 0.870 ->
  **0.87**. GST shares 0.433 -> 0.43 each, which add up to 0.86 against
  2.60 x 10.00 / 30.00 = 0.867 -> 0.87, so the first line's is **0.44**; GST
  on transactions **0.87**. Paying the other 20.00 gives shares 6.667 ->
  6.67 each (20.01), so the first line's is **6.66**; each line has then
  counted exactly 10.00.
- **G13** Credit notes: I1 approved 1 Apr, CN-0001 approved 5 Apr and applied
  to I1 on 5 Apr, and the other 92.00 paid on 20 Apr. Apr-May: I1 +23.00
  (credit applied), CN-0001 -23.00 (credit applied), I1 +92.00 (payment):
  Box 5 **92.00**, Box 8 **12.00** (the same as G4 on the invoice basis).
  If instead I1 is paid in full on 20 Apr and CN-0001's 23.00 is refunded on
  12 Jun: Apr-May Box 5 **115.00**, Box 8 **15.00**; Jun-Jul Box 5
  **-23.00**, Box 8 **-3.00**. A credit note that's approved but not applied
  or refunded counts nothing.
- **G14** Purchases: B1 approved 2 Apr and 115.00 paid on 30 Apr: Box 11
  **115.00**, Box 12 **15.00**. CR-7 applied to B1 on 10 May counts B1
  +46.00 and CR-7 -46.00 (nothing overall) and the other 69.00 paid on
  20 May: Apr-May Box 11 **184.00**, Box 12 **24.00** (the same as G4).
- **G15** Overpayments: 150.00 received against I1 on 20 Apr (overpayment
  35.00) counts **115.00**. Applying the 35.00 on 10 May to another
  invoice of 115.00 (standard) counts that invoice's share, **35.00**:
  Apr-May Box 5 **150.00**, Box 8 = 150.00 x 3/23 = 19.565 -> **19.57**. If
  the 35.00 is refunded instead, the refund counts nothing and Box 5 is
  **115.00**.
- **G16** Voids and removals: I1's 115.00 payment on 20 Apr is voided on
  3 Jun. Apr-May Box 5 **115.00**; Jun-Jul Box 5 **-115.00**, Box 8
  **-15.00**. Removing G13's credit application on 8 Jun counts I1 -23.00 and
  CN-0001 +23.00 in Jun-Jul. A draft, and an approved invoice or bill with
  nothing settled, count nothing.
- **G17** Spend money of 57.50 inclusive at 15% dated 3 Apr counts on 3 Apr on
  every basis: Box 11 **57.50**, Box 12 **7.50**.
- **G18** Hybrid: I1 approved 10 Apr and not paid; B1 approved 12 Apr, 115.00
  paid 25 May. Apr-May: Box 5 **115.00**, Box 8 **15.00** (sales when
  approved), Box 11 **115.00**, Box 12 **15.00** (purchases when paid),
  Box 15 **0.00**. A customer payment in the period changes nothing; a bill
  approved but not paid counts nothing.
- **G19** Filing on the payments or hybrid basis stores the basis and the
  counted lines, each with its event (e.g. "customer payment"), the amount
  settled and the document's total. After filing G10's Apr-May return,
  recording a payment against I5 dated 15 May makes it show "Changed since
  filed". A filed return is always worked out again on the basis it was filed
  on, even if the organisation's basis has changed since.

**Changing basis (IR546).** The first return after a change adjusts for the
documents still outstanding at the end of the last period on the old basis,
so nothing is counted twice or missed. Tohyee finds the change from the
filed returns: when the latest filed return that ends before this period was
filed on another basis, it suggests the adjustment, and one click adds it as
a Box 9 or Box 13 adjustment (it can be removed like any other). Once a
return on the new basis is filed, there's no suggestion. Changes made before
the first return filed in Tohyee aren't known to it.

- **GST on debtors** at that date: for each approved invoice dated on or
  before it and not voided by then, the amount still owed (its total less
  what was settled by then) x its GST / its total, rounded to 2 places; less
  the same for each approved credit note's credit not yet applied or
  refunded. **GST on creditors**: the same for bills and supplier credit
  notes.
- The adjustment is GST on debtors if sales move from counting when settled
  to counting when approved (-, the other way), plus GST on creditors if
  purchases move from counting when approved to counting when settled (-,
  the other way). More than 0.00 is a Box 9 adjustment; less than 0.00 is a
  Box 13 adjustment of its size; 0.00 suggests nothing. That's IR546's six
  cases:

  | From -> to          | Adjustment (IR546)                               |
  |---------------------|--------------------------------------------------|
  | Payments -> invoice | debtors - creditors: Box 9 if more, else Box 13  |
  | Invoice -> payments | creditors - debtors: Box 9 if more, else Box 13  |
  | Payments -> hybrid  | GST on debtors, Box 9                            |
  | Invoice -> hybrid   | GST on creditors, Box 9                          |
  | Hybrid -> payments  | GST on debtors, Box 13                           |
  | Hybrid -> invoice   | GST on creditors, Box 13                         |

  IR546 doesn't cover the one-sided changes when the amount is less than
  0.00 (e.g. more unused credit notes than money owed); Tohyee suggests it in
  the other box, as the same rule gives *(Tohyee's rule)*.

- **G20** Feb-Mar 2026 was filed on the invoice basis. At 31 Mar: I1 (dated
  25 Mar, not paid) GST **15.00**; I5 (82.50 paid 30 Mar, 82.50 owed)
  82.50 x 15.00 / 165.00 = **7.50**; CN-0001 (approved in March, not
  applied) **-3.00**: GST on debtors **19.50**. B1 (not paid) GST on
  creditors **30.00**. The basis is now payments, so the Apr-May return
  suggests Box 9 **10.50** (30.00 - 19.50), "Change of GST basis from
  invoice to payments at 31 Mar 2026: GST on debtors 19.50, GST on creditors
  30.00".
- **G21** The same documents for the other changes: payments -> invoice
  Box 13 **10.50**; invoice -> hybrid Box 9 **30.00**; payments -> hybrid
  Box 9 **19.50**; hybrid -> payments Box 13 **19.50**; hybrid -> invoice
  Box 13 **30.00**. With no filed return before the period, or the latest one
  on the same basis, nothing is suggested. Payments -> hybrid with only
  CN-0001 outstanding (GST on debtors -3.00) suggests Box 13 **3.00**.
- **G22** A payment dated on or before 31 Mar that was voided after it still
  counts as paid at 31 Mar; a document voided on or before 31 Mar isn't
  outstanding.

### Not supported yet (refused rather than guessed)

- **Deferred-payment supplies of $225,000 or more** (section 19D): an
  organisation on the payments basis has to account for these on the invoice
  basis. Tohyee counts them like any other invoice (when paid); adjust for
  them yourself with Box 9.
- **Checking eligibility for the payments basis** (sales of $2 million or
  less): Tohyee uses whichever basis is set and doesn't check turnover.
- **Bad debts**: there's no write-off yet. (On the payments basis IRD allows
  no deduction for a written-off debt that was never paid, because it was
  never counted.)
- **Amending a filed return**: a filed return can't be changed. "Changed since
  filed" shows what's different; correcting it with IRD is done outside
  Tohyee.
- **Imported goods** (GST paid to Customs): there's nowhere to record it yet.
- **Recording the GST payment or refund to IRD**: filing posts no journal.
- **Filing to IRD electronically**: "Mark as filed" records that you filed the
  return yourself (through myIR), with the figures it had at the time.
- **Other GST rates**: standard-rated lines must be at 15%.

## Tracking categories (advanced features)

For bigger organisations (decided with the owner, 29 Sep 2026, after looking
at NetSuite's classifications): an organisation setting, **Advanced (ERP)
features**, off by default, turns on **tracking categories**: Department,
Class and Location to begin with (more of the organisation's own come
later). Each category holds a **tree of values** (e.g. Location: Otago >
Dunedin). Lines of sales invoices, bills, sales and supplier credit notes,
spend and receive money, and manual journals can be tagged with one value per
category, and the posted journal lines keep the tags, so reports can split
or filter by them. Tags only describe lines; they never change an amount,
an account or a GST box.

- Only lines that users write are tagged: each document line's income,
  expense or other account line in the journal carries that document line's
  tags. Accounts receivable, accounts payable, GST and bank lines are never
  tagged. When an invoice (bill, credit note, spend or receive money) has
  several lines on the same account, they're posted as one journal line only
  if their tags are the same.
- A category can be **required**: then every line on an income or expense
  account needs a value from it before it can be approved or posted (drafts
  can still be saved without). Lines on balance sheet accounts never need
  one.
- Values are renamed, moved under another value, or archived, never deleted.
  An archived value can't be chosen for a new line but stays on old ones.
  Names are unique among a value's siblings (ignoring case), and a value can't
  sit under itself or its own children.
- Voiding and corrections copy the tags onto the reversing lines, so a voided
  document nets to zero in every column.
- Turning the setting off hides the fields, the categories page and the
  split and filter options; tags already on lines are kept, and come back
  when it's turned on again.

Setup: advanced features on; Department values Retail and Wholesale; Class
values Jewellery and Kits; Location values Otago (with Dunedin and
Queenstown under it) and Canterbury (with Christchurch under it). Tax code
GST (15%); dates in June 2026.

- **TC1** A new organisation has advanced features off, and the categories
  Department, Class and Location with no values. With the setting off, a
  line's tags are refused ("Advanced features are off"). Turning it on and
  off is recorded in the history. A draft tagged while it was on can still
  be edited and approved with the switch off: the tags it already had are
  kept, but no new ones can be added.
- **TC2** Values: "Dunedin" can be added under Otago and under Canterbury
  (different parents), but a second "dunedin" under Otago is refused; moving
  Otago under Dunedin is refused (it's its own child); a value can't be
  deleted, only archived; an archived value is refused on a new line
  ("Queenstown is archived") and still shows on lines that already have it.
- **TC3** Invoice (tax exclusive) with 100.00 to 4000 tagged Retail /
  Jewellery / Dunedin and 50.00 to 4000 tagged Wholesale / Kits /
  Christchurch posts Dr 1100 **172.50** / Cr 4000 **100.00** (Retail,
  Jewellery, Dunedin) / Cr 4000 **50.00** (Wholesale, Kits, Christchurch) /
  Cr 2100 **22.50** (no tags). Two lines of 30.00 and 20.00 to 4000 with the
  same tags are posted as one 50.00 line. The GST return is the same as
  without tags.
- **TC4** Bill (tax exclusive) with 40.00 to 6010 tagged Retail / Dunedin
  and 60.00 to 6010 with no tags posts Dr 6010 **40.00** (Retail, Dunedin) /
  Dr 6010 **60.00** / Dr 2100 **15.00** / Cr 2000 **115.00**. Voiding it
  posts the same lines the other way round, with the same tags.
- **TC5** A manual journal Dr 6010 25.00 (Retail) / Cr 1000 25.00 posts
  with the tag on the 6010 line. A tag with a value from the wrong category
  (Department: Dunedin) is refused. A correction's reversal keeps the
  original tags; its replacement can have different ones, and can keep a
  value the original had even if that value has since been archived.
- **TC6** With Department required: approving the TC3 invoice with its
  second line untagged is refused ("Line 2 needs a Department"), but the
  draft saves; the TC4 bill's 60.00 line is refused the same way; a manual
  journal line to 6010 without a Department is refused, while its 1000 line
  (a bank account) needs nothing. With the requirement off again, all of
  them work.
- **TC7** Profit and loss for June 2026 with TC3's invoice and TC4's bill,
  **split by Department**: Revenue Retail **100.00**, Wholesale **50.00**,
  Not set **0.00**, Total **150.00**; Expenses Retail **40.00**, Wholesale
  **0.00**, Not set **60.00**, Total **100.00**; Net profit Retail **60.00**,
  Wholesale **50.00**, Not set **-60.00**, Total **50.00** (the same as the
  profit and loss without a split). **Split by Location**, values under a
  top-level value count in its column: Revenue Otago **100.00**, Canterbury
  **50.00**; Expenses Otago **40.00**, Not set **60.00**; Net profit Otago
  **60.00**, Canterbury **50.00**, Not set **-60.00**.
- **TC8** A custom report (CR1) **filtered** to Location Otago counts only
  lines tagged Otago or a value under it: June Revenue **100.00**, Expenses
  **40.00**, Net profit **60.00**. The filter is shown on the report and kept
  in a published copy. A balance sheet can't be filtered (its AR, AP, GST
  and bank lines aren't tagged).
- **TC9** Voiding the TC3 invoice in June: split by Department, Revenue is
  **0.00** in every column.
- **TC10** A sales credit note, a supplier credit note and spend and receive
  money carry line tags the same way as TC3 and TC4 (credit note 20.00 to
  4000 tagged Retail posts Dr 4000 **20.00** (Retail)); payments, refunds,
  transfers and bank reconciliation never add tags.

## Custom segments and custom fields (advanced features)

The owner asked (29 Sep 2026) for these to work the way NetSuite's custom
segments and custom fields do
([custom segments](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4732448748.html),
[custom field types](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2842731.html)),
and like tracking categories they only show while **Advanced (ERP)
features** is on.

**Custom segments** are tracking categories an admin adds alongside
Department, Class and Location (for example "Grant" or "Project"). They
behave exactly like those three (TC1-TC10): a tree of values, optional or
required, on every line, posted onto the journal lines, and used to split and
filter the profit and loss. Like NetSuite's segments with "GL impact" they
always reach the ledger. A segment is never deleted: it can be archived,
which hides it from new lines (lines that already have it keep it, and
reports still show them), and brought back. Up to 20 segments of the
organisation's own.

**Custom fields** hold extra information that never reaches the ledger or
the GST return: they change no amount, account, tag or box, and the
profit and loss is the same with or without them. Each field has:

- a **label** (unique among fields for the same kind of record, ignoring
  case) and optional **help text**;
- **what it's on**, fixed once created, one of: **contacts** (customers,
  suppliers or both, like NetSuite's entity fields), **documents** (the top
  of an invoice, bill, sales or supplier credit note, spend or receive money
  or a manual journal, like its transaction body fields), or **lines**
  (each line of those, like its transaction column fields). A document or
  line field says which of those six it's used on;
- a **type**, fixed once created: text (up to 300 characters), long text (up
  to 4,000), whole number, decimal number (up to 6 decimal places), money
  (2 decimal places), percent (0 to 100, up to 2 decimal places), date,
  check box, list (one of its options), multiple select (any of its
  options), email address, phone number or web address (http or https). Up to
  15 digits before the point. Lists keep their options, which can be added,
  renamed and archived, never deleted;
- **required** (not for check boxes), a **default value** filled in on new
  records, and **show in list** (shown as a column on the list of those
  records);
- it can be **archived** (hidden from new records; values already saved stay
  and still show) and brought back, never deleted. Up to 100 fields.

Rules for values:

- Values are checked against the field's type, and a list or multiple
  select value must be one of its options (an archived option only if the
  record already had it). Blank means "not set": an empty text, no number,
  no date, an unticked check box and no options are all not set.
- A required contact field is needed whenever the contact is saved. A
  required document or line field is needed when the document is approved
  or posted (drafts still save), the same as required segments; a required
  line field is only needed on lines to income and expense accounts.
- Values are part of a draft, so they can be changed until it's approved;
  after that they're fixed with the rest of the document. A contact's
  values can be changed at any time, and the change is in its history.
- A new record starts with each active field's default. Leaving the values
  out when saving an existing record keeps what it had.
- With the setting off, fields are hidden; a record keeps the values it
  had and can still be saved with them, but can't be given new ones.
- A sales credit note started from an invoice (and a supplier credit note
  from a bill) copies the values of fields that are used on both; a
  correction of a manual journal starts with the original's values.
  Reversals and voids don't carry custom fields (they never reach the
  ledger).

Setup: advanced features on. Fields: contact field "Pet name" (text, on
customers); contact field "Channel" (list: Shopify, Market, Wholesale; on
customers, required, shown in the list); document field "Engraving
proof sent" (check box, on invoices); document field "Grant code" (text, on
bills and spend money, default "GEN"); document field "Approved by" (text,
on journals); line field "Engraving text" (text, on invoice and credit note
lines, required); line field "Hours" (decimal number, on bill and journal
lines).

- **CS1** Adding a segment "Grant" with values "Lotteries" and "Council" puts a fourth select on every line.
  An invoice with 100.00 to 4000 tagged Grant: Lotteries posts Cr 4000
  **100.00** tagged with it, and the profit and loss split by Grant shows
  Lotteries **100.00**. A second segment called "grant" is refused (names
  are unique ignoring case, across all categories).
- **CS2** Archiving "Grant": new lines can't be tagged with it ("Grant is
  archived"), the CS1 invoice keeps its tag, the split by Grant still shows
  **100.00**, and a draft that already had it can still be approved.
  Bringing it back makes it usable again. Department, Class and Location
  can't be archived, and a segment can't be deleted.
- **CS3** A 21st segment of the organisation's own is refused.
- **CF1** Field set-up: a second field labelled "pet name" on contacts is
  refused, but "Pet name" on lines is fine; a field's type and what it's on
  can't be changed; a required check box is refused; a list needs at least
  one option; a default must be a valid value ("GEN" is fine for text, "abc"
  isn't for a decimal number); a field can't be deleted, only archived.
- **CF2** Values by type: text over 300 characters, "12.5" for a whole
  number, "1.1234567" for a decimal (7 places), "12.345" for money, "101"
  for a percent, "2026-02-30" for a date, "Etsy" for Channel, "not an email"
  for an email and "ftp://x" for a web address are each refused, naming the
  field ("Channel: choose one of its options."). "1,234.50" is refused for
  money (no thousands separators). Valid values are stored as typed: money
  "12.50", decimal "3.25", whole number "12", percent "12.5", check box
  true.
- **CF3** Contacts: a new customer gets Channel's default if it has one;
  saving a customer without Channel is refused ("Channel is required"),
  while a supplier-only contact doesn't need it (Channel is on customers
  only) and can't be given "Pet name". The customer list shows a Channel
  column; changing Kobe Ltd's Channel from Market to Shopify is recorded in
  its history.
- **CF4** Invoice: a draft with "Engraving proof sent" ticked and line 1
  "Engraving text" = "Kobe" but line 2 blank saves; approving it is refused
  ("Line 2 needs Engraving text"); filling it in lets it approve. The posted
  journal is Dr 1100 / Cr 4000 / Cr 2100 exactly as without fields, with no
  custom fields on the journal lines. After approval the values can't be
  changed.
- **CF5** Bill: a new bill gets "Grant code" = "GEN" by default; a line with
  "Hours" = 2.5 saves; "Engraving text" (not used on bills) is refused on a
  bill line ("Engraving text isn't used on bill lines").
- **CF6** Credit note from the CF4 invoice copies "Engraving text" (used on
  credit note lines) but not "Engraving proof sent" (invoices only).
- **CF7** Archiving "Pet name": it's hidden from new contacts and the
  contact editor, but Kobe Ltd still shows and keeps "Pet name: Rex", and
  can be saved with it. Archiving the "Market" option: Kobe Ltd (Market)
  keeps it; a new customer can't choose it.
- **CF8** With the setting off, saving Kobe Ltd with its existing values
  works; giving it a new "Pet name" is refused.
- **CF9** Manual journal: "Approved by" and a line's "Hours" are stored
  with the journal; a correction starts with the original's values and the
  replacement keeps what was entered; the reversal has none.
- **CF10** Spend money reconciled from a bank line with "Grant code" =
  "LOT-22" keeps it; a receive-money transaction doesn't get "Grant code"
  (it's on spend money only).

## Salespeople (advanced features)

The owner asked (29 Sep 2026) for salespeople to work the way NetSuite's
sales reps do
([marking a sales rep](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1039206.html),
[Sales by Sales Rep Summary](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1117863.html)).
NetSuite's help doesn't say how every detail works, so where it's silent the
rules below are our choice. Like tracking categories, salespeople only show
while **Advanced (ERP) features** is on.

- A **salesperson** has a name (unique, ignoring case) and an optional
  email. Salespeople are archived, never deleted. (In NetSuite they're
  employees ticked as sales reps; Tohyee has no employee records yet.)
- A **customer** can have a default salesperson. A **sales invoice** and a
  **sales credit note** each have one salesperson (or none). A new invoice
  or credit note gets the customer's default when none is sent; a credit
  note started from an invoice gets the invoice's salesperson. It can be
  changed while the document is a draft and is fixed once approved.
  Changing a customer's default doesn't change documents already saved.
- The salesperson never changes an amount, an account or a GST box. Team
  selling (splitting a sale between several salespeople) and commissions
  aren't built.
- An archived salesperson can't be chosen for a new document, and an
  archived default isn't applied; a draft that already has them keeps them
  and can be approved. With the setting off, documents keep their
  salesperson but can't be given a new one.
- **Sales by salesperson** (a report for a date range), one row per
  salesperson plus "Not set", amounts excluding GST: **Invoices** is how
  many invoices are dated in the range (approved, including ones voided
  later); **Sales** is those invoices' amounts excluding GST, less invoices
  voided in the range (on their void date); **Credit notes** is the same for
  sales credit notes; **Net sales** is Sales less Credit notes. Drafts never
  count. Each row opens to the documents behind it. The total net sales
  equals the income that invoices and credit notes posted in the range.

Setup: advanced features on; salespeople Aroha and Ben; customer Kobe Ltd
with default salesperson Aroha; customer Rata Ltd with none; GST 15%.

- **SR1** A new invoice for Kobe Ltd with no salesperson sent gets Aroha;
  one sent with Ben keeps Ben; one for Rata Ltd has none. A second
  salesperson called "aroha" is refused, and a salesperson can't be
  deleted.
- **SR2** Kobe's invoice for 100.00 (tax exclusive) with Aroha posts
  Dr 1100 **115.00** / Cr 4000 **100.00** / Cr 2100 **15.00**, exactly as
  without a salesperson. After approval its salesperson can't be changed.
- **SR3** June 2026: invoice 1 Kobe/Aroha 100.00, invoice 2 Kobe/Ben
  200.00, invoice 3 Rata/none 50.00 (all tax exclusive), a credit note from
  invoice 1 for 20.00 (it gets Aroha), and a draft invoice for 999.00 with
  Ben. Sales by salesperson for June: Aroha invoices **1**, sales
  **100.00**, credit notes **20.00**, net **80.00**; Ben **1**, **200.00**,
  **0.00**, **200.00**; Not set **1**, **50.00**, **0.00**, **50.00**; total
  **3**, **350.00**, **20.00**, **330.00**, the same as June's income on
  4000.
- **SR4** Voiding invoice 2 on 5 July 2026: June is unchanged; July shows
  Ben invoices **0**, sales **-200.00**, net **-200.00**.
- **SR5** A tax inclusive invoice for 115.00 with Aroha counts **100.00**.
- **SR6** Archiving Ben: a new invoice with Ben is refused ("Ben is
  archived"); the draft that already had Ben keeps him and can be approved.
  Archiving Aroha: a new invoice for Kobe gets no salesperson. Changing
  Kobe's default to Ben (restored) doesn't change invoice 1.
- **SR7** With the setting off, a new invoice for Kobe gets no salesperson,
  and one sent with Aroha is refused; a draft that already had Aroha keeps
  her.
- **SR8** The June report's Aroha row lists invoice 1 (100.00) and the
  credit note (20.00).

## Richer customers (advanced features)

The owner asked (29 Sep 2026) for richer customers, step 4 of the
NetSuite-style plan, choosing all five parts below. They follow NetSuite's
customer record
([terms](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1418163.html),
[credit limits](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1415896.html),
[customer categories, price levels](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1412993.html),
[sub-customers](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1413598.html))
and, for payment terms, Xero's. Where they're silent the rules below are our
choice.

- **Payment terms are for everyone** (Xero has them for every
  organisation), not only with **Advanced (ERP) features** on. Each term is
  one of: N days after the invoice date, N days after the end of the
  invoice's month, or day N of the following month (NetSuite's date-driven
  terms; a day the month doesn't have becomes its last day). A new
  organisation starts with Due on receipt, 7 days, 14 days, 30 days, 20th of
  the following month, and 30 days after the end of the month. A customer
  has a default term; a new invoice sent without a due date gets it from the
  term. The due date can still be changed while the invoice is a draft.
  Changing or archiving a term, or a customer's term, never changes a saved
  invoice.
- The **billing address** is the old postal address (nothing moves); a
  customer also has a **delivery address**. Both are for everyone.
- **Contact people** are the CRM's people at the company (there's one list,
  not two): name, job title (their role), email and phone, and one of them
  can be the **primary contact** for invoices. They can be managed while the
  CRM or Advanced reporting is on.
- With Advanced reporting on, a customer can have a **credit limit**, a
  **customer group** (NetSuite's customer categories), a default **price
  level** and a **parent customer**. Groups and price levels are lists that
  are archived, never deleted. A price level is a percent on (a markup) or
  off (a discount) the base price; nothing is priced from it until items
  arrive, so invoices don't change.
- **Credit limit check**: when an invoice is approved, the customer's
  balance (their approved invoices' amounts due, less credit notes and
  overpayments not yet used or refunded) plus the invoice's total is compared
  with their limit. Going over it is either a **warning** (the default: the
  invoice is approved and the warning is shown and kept in its history) or
  **blocked** (refused with a message; the draft stays as it was and no
  number is used), set per organisation. Exactly at the limit is fine. No
  limit means no check, and with Advanced reporting off nothing is checked.
  The limit is the customer's own, not shared with its parent or subs.
- **Parent customers**: both must be customers, a customer can't be its own
  parent or under one of its own subs, and a tree is at most 4 levels deep
  (the database refuses otherwise). A customer with subs must stay a
  customer.
- **Aged receivables** (a new report, for everyone): what each customer owes
  as at a date, by days past each invoice's due date (current, 1-30, 31-60,
  61-90, over 90), less credit not yet used, worked out from the documents
  as they stood on that date. Its total equals accounts receivable on the
  balance sheet on that date. With **roll-up**, a parent shows the total of
  itself and everything under it, with its subs indented beneath. Customer
  statements don't exist yet, so there's no statement roll-up.

Setup: Advanced reporting on; GST 15%; the six starting payment terms.

- **RC1** Customer Kobe Ltd has "20th of the following month". A new invoice
  dated 15 June 2026 sent without a due date is due **20 July 2026**; one
  dated 31 December 2026 is due **20 January 2027**; one sent with a due
  date of 30 June 2026 keeps it, and the draft's due date can be changed to
  1 August 2026. With "30 days" the 15 June invoice is due **15 July 2026**,
  with "30 days after the end of the month" **30 July 2026**, and with "Due
  on receipt" **15 June 2026**. A term "31st of the following month" on an
  invoice dated 10 January 2026 gives **28 February 2026**. For a customer
  with no terms the due date is still required. This works with Advanced
  reporting off.
- **RC2** A second term called "30 DAYS" is refused, and terms can't be
  deleted. Archiving "30 days": it can't be chosen for a customer, and a
  customer already on it keeps it but new invoices need a due date typed.
  Changing Kobe's term to "7 days" doesn't change its saved invoices.
- **RC3** (warn) Kobe has a credit limit of **1,000.00**. Invoice A for
  500.00 + GST = **575.00** is approved and unpaid. Approving invoice B for
  400.00 + GST = **460.00** takes Kobe to **1,035.00**: B is approved (and
  posts Dr 1100 460.00 / Cr 4000 400.00 / Cr 2100 60.00 as usual) with the
  warning "Kobe Ltd owes 575.00, so this invoice for 460.00 takes them to
  1035.00, 35.00 over their credit limit of 1000.00."
- **RC4** (block) The same with the setting on block: approving B is
  refused with that message, B stays a draft and INV-0002 is still unused.
  After a payment of **100.00** on A, Kobe owes **475.00**; 475.00 + 460.00
  = **935.00**, so B is approved as INV-0002.
- **RC5** Credit counts: with A (575.00) approved, a credit note for
  100.00 + GST = **115.00** not yet applied, and a payment of 690.00 on a
  third invoice of 575.00 (an overpayment of **115.00** left), Kobe owes
  575.00 - 115.00 - 115.00 = **345.00**, so B (460.00) takes them to
  **805.00**, under 1,000.00. With a limit of exactly 805.00 B is approved
  with no warning; at 804.99 it's over by 0.01. With no limit, or with
  Advanced reporting off, nothing is checked.
- **RC6** A contact saved with a postal address keeps it as its billing
  address; a delivery address "12 Wharf St, Dunedin 9016" is saved beside
  it. People Aroha (primary) and Ben work at Kobe Ltd: Kobe's primary
  contact is Aroha. Making Ben primary takes it from Aroha. An archived
  person, or someone at no company, can't be primary; archiving the primary
  person leaves the company with none. People can be added with only
  Advanced reporting on, and are refused with both it and the CRM off.
- **RC7** Customer groups Retail and Wholesale; price levels "Wholesale"
  **-10** (10% off) and "Trade plus" **5** (5% on). Kobe is in Wholesale
  with price level Wholesale; its invoices' amounts are unchanged. A price
  level of -100 or 1000.01 is refused, names are unique ignoring case, an
  archived group or level can't be chosen (a customer already on it keeps
  it), and neither can be deleted.
- **RC8** Kobe Group Ltd is the parent of Kobe Auckland and Kobe Dunedin,
  and Kobe Dunedin of Kobe Mosgiel (3 levels). Making Kobe Group Ltd a sub
  of Kobe Mosgiel is refused (a loop), as is a customer as its own parent
  and a supplier-only parent. Kobe Mosgiel can have a sub, Kobe Mosgiel
  North (4 levels), but a sub of that is refused (5 levels). Kobe Group Ltd
  can't stop being a customer while it has subs.
- **RC9** Aged receivables as at **31 July 2026**: Rata Ltd's invoice of
  460.00 due 31 March 2026 with 60.00 paid (**400.00**, 122 days, over 90);
  Kobe Auckland's invoice of **345.00** due 15 May 2026 (77 days, 61-90) and
  its unused credit note of **23.00**; Kobe Dunedin's invoice of **115.00**
  due 20 July 2026 (11 days, 1-30) and **230.00** due 20 August 2026
  (current). Kobe Mosgiel's invoice dated 5 August 2026, and Kobe
  Auckland's invoice voided on 10 May 2026, don't count. Totals: current **230.00**, 1-30 **115.00**, 31-60 **0.00**, 61-90
  **345.00**, over 90 **400.00**, credit **23.00**, total **1,067.00**, the
  same as account 1100 on the balance sheet at 31 July 2026. Rows: Kobe
  Auckland **322.00**, Kobe Dunedin **345.00**, Rata Ltd **400.00**.
- **RC10** With roll-up (the tree from RC8): Kobe Group Ltd (nothing of its
  own) shows current 230.00, 1-30 115.00, 61-90 345.00, credit 23.00, total
  **667.00**, with Kobe Auckland (322.00) and Kobe Dunedin (345.00) beneath
  it; Kobe Mosgiel owes nothing and isn't shown; Rata Ltd **400.00**. The
  grand total is still **1,067.00**.
- **RC11** As at **30 June 2026** (the same documents): Kobe Dunedin's
  first invoice is current (115.00), Kobe Auckland's is 46 days overdue
  (31-60, 345.00), Rata's 91 days (over 90, 400.00), credit 23.00, total
  **837.00**. Voiding Rata's payment on 10 August 2026 doesn't change the
  report as at 31 July; as at 10 August Rata owes **460.00**.
- **RC12** With Advanced reporting off: customers keep their credit limit,
  group, price level and parent, but new ones can't be set ("Advanced
  reporting is off"), and approving over a limit is neither warned nor
  blocked. Payment terms and delivery addresses still work.

### Not supported yet (refused rather than guessed)

- Credit limits shared across a parent and its subs (each customer's limit
  is its own). Prices from price levels arrived with items (IT4).
- Holding sales orders over the limit (sales orders aren't checked) or
  checking the limit when a draft is saved (only approving is checked).
- Customer statements (and so their roll-up); only aged receivables rolls
  up.
- Terms with early-payment discounts (NetSuite's "2% 10 Net 30").

## Products and services (items)

The owner asked (29 Sep 2026) for items, step 4 of the NetSuite-style plan
continued: a products and services list like
[Xero's items](https://central.xero.com/s/article/Add-an-item), with
[NetSuite's](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_N2093617.html)
item types, units of measure, price levels, vendor prices and kits. Where
they're silent the rules below are our choice.

- **Every organisation** has the item list (Xero has it for everyone): a
  **code** (unique, ignoring case, archived items included), a name, an
  optional description, a **sale price** and a **purchase price** (excluding
  GST, for the base unit, up to 4 decimal places), an **income account**
  (revenue), a **purchase account** (the bill line rules), and **sales** and
  **purchase tax codes**. Items are archived, never deleted.
- **Types**: **service**, **non-stock** and **stock** for everyone; **kit**
  (a bundle of other items) only with **Advanced reporting** on. A stock item
  only records its type in this step: nothing moves stock or posts cost of
  sales until stock tracking (ST1-ST12). An item's type can't change once a
  document line uses it.
- **Picking an item** on an invoice, bill or credit note line fills its
  description (the item's description, else its name), unit price, account
  and tax code, which stay editable on a draft. The API does the same for
  any of those left blank on a line with an item. Lines without an item work
  as before. Amounts, GST and journals are worked out from the line exactly
  as before; the item only fills it in.
- With **Advanced reporting** on (NetSuite's extras):
  - **Units of measure**: an item counts in its **base unit** (default
    "each"; e.g. kg) and can have other units that are a fixed multiple of
    it ("Box of 12" = 12 each). A line records the unit it's in, and its
    quantity in the base unit is worked out exactly (quantity x the unit's
    size) and stored with it. A unit's size never changes (lines use it);
    units are renamed or archived. An item can start sales and purchases in
    one of its units; the price filled in is the base price x the unit's
    size.
  - **Price levels** (from richer customers, RC7) price items: an item's
    price for a level is its sale price adjusted by the level's percent,
    rounded once to cents, half away from zero, unless the item has its own
    price for that level. Picking an item on an invoice or credit note for a
    customer with a default price level fills that price.
  - **Supplier prices**: per item, suppliers with their price and their own
    code for it, at most one **preferred**. Picking an item on a bill or
    supplier credit note fills that supplier's price, else the item's
    purchase price.
  - **Kits**: a kit lists other items and quantities. Kits can't be inside
    kits (NetSuite's kits can; costing a kit of kits needs a decision, so
    it's refused), and kits are sold, not bought.
  - Turning Advanced reporting off keeps an item's units, level prices,
    supplier prices and kit parts, and documents keep their lines, but new
    ones can't be set and prices come from the item's own sale and purchase
    prices.

Setup: GST 15%; supplier Paw Supplies; customers Kobe Ltd and Rata Ltd.
Item **WIDGET** "Widget", stock, sale price **12.00**, purchase price
**5.00**, income 4000, purchase account 1400, GST both ways.

- **IT1** With Advanced reporting off, WIDGET, a service item "Engraving"
  and a non-stock item "Gift box" can be added. A second item coded
  "widget" is refused (codes ignore case). Archiving WIDGET keeps it; it
  can't be deleted (the database refuses) or picked on a new line, but a
  draft that already has it can still be saved and approved. Once a line
  uses WIDGET its type can't change. A retry with the same key returns the
  same item; the same key with a different item is refused (409); a viewer
  can't add items.
- **IT2** An invoice to Kobe with a line of only WIDGET and quantity **4**
  is filled in as "Widget", 4 x **12.00** to 4000 with GST. Approving posts
  Dr 1100 **55.20** / Cr 4000 **48.00** / Cr 2100 **7.20**, as any invoice
  line does (and, since stock tracking, its cost of sales, ST2). On a draft the price can be changed to 11.50 (net 46.00) and is
  kept. A line without an item still works. A sales credit note filled from
  WIDGET works the same way.
- **IT3** A bill from Paw Supplies with a line of only "Gift box" (purchase
  price **2.00**, account 5100, GST) and quantity 10 is filled in and
  approves as Dr 5100 **20.00** / Dr 2100 **3.00** / Cr 2000 **23.00**. A
  supplier credit note filled from it works the same way.
- **IT4** (Advanced reporting on) Price levels "Wholesale" **-10** and "Trade
  plus" **5** (RC7). Kobe has Wholesale, Rata Trade plus, and a third
  customer none. WIDGET picked for Kobe is **10.80** (12.00 x 0.90), for Rata
  **12.60** (12.00 x 1.05) and for the third customer **12.00**. A sale price
  of **9.99** gives **8.99** (8.991) and **10.49** (10.4895). With WIDGET's
  own Wholesale price of **10.00**, Kobe gets **10.00**. With Advanced
  reporting off, Kobe gets **12.00**.
- **IT5** (Advanced reporting on) WIDGET gets the unit "Box of 12" (12
  each). An invoice line of **2** "Box of 12" is filled at **144.00** a box
  (12.00 x 12), comes to **288.00** and records **24** each. Quantities are
  exact: 0.3333 of a "Pack of 3" is **0.9999** each. A unit's size can't be
  changed (the database refuses too), a unit of another item is refused,
  and a unit named like the base unit is refused. With Advanced reporting
  off, units can't be added.
- **IT6** (Advanced reporting on) WIDGET's suppliers: Paw Supplies at
  **4.80** (their code PS-W1, preferred) and Otago Wholesale with no price.
  WIDGET on a bill from Paw is filled at **4.80**; from Otago Wholesale at
  **5.00** (the item's purchase price). Two preferred suppliers, or a
  customer-only contact as a supplier, are refused.
- **IT7** (Advanced reporting on) Kit "GIFT-SET" = 1 WIDGET + 2 CANDLE,
  sale price 30.00. An invoice line of one GIFT-SET is filled at **30.00**
  to its income account. A kit inside a kit, a kit with no parts, a kit on
  a bill, and making a kit's part into a kit are all refused. (Its cost of
  sales and stock come with stock tracking, ST8.)
- **IT8** With Advanced reporting off: kits, units, level prices and
  supplier prices can't be set ("Advanced reporting is off"); an item that
  already has them keeps them.
- **IT9** The items API: listing (viewer), adding and changing (bookkeeper),
  and "what picking an item fills" (`/api/items/line-defaults`) give the
  same answers as IT2-IT6.

### Not supported yet (refused rather than guessed)

- Kits inside kits, and kits on bills or supplier credit notes.
- Changing a unit's size or an item's type once used; archive and add new.
- Quantity price breaks, prices in other currencies, and item images.
- Assemblies (building stock from parts) and item variants.

## Modules and the CRM

Decided with the owner (29 Sep 2026): Tohyee has five modules: **Accounting**
and **Tax** (always on), **CRM**, **Advanced reporting**, and **Not-for-profit**
(each optional module is switched on per organisation in Settings).
Advanced reporting is the existing
"advanced features" switch: tracking categories and segments, custom fields,
salespeople and their reports. The CRM follows
[Twenty](https://github.com/twentyhq/twenty) (AGPL-3.0, the same licence as
Tohyee): its companies, people, opportunities, tasks, notes and timeline,
built into Tohyee rather than run alongside it.

- **MOD1** A new organisation has the CRM and Advanced reporting off. Turning
  either on or off is recorded in the history. With the CRM off its menu and
  screens are hidden and its commands are refused ("The CRM is off"); what
  was entered is kept.

## Not-for-profit (examples not yet approved by Jess)

The first tranche reuses Advanced reporting's tracking categories/custom
segments for funds, and its budget and custom-report features. Set up a custom
segment called **Fund**, with values grouped under **Unrestricted**,
**Restricted** or **Endowment**; make it required if every income and expense
line must be assigned. Tag the income/expense lines with the named fund value.
This follows [NetSuite's custom segments for NFP financials](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1519241750.html)
and [Xero's tracking categories](https://central.xero.com/s/article/Set-up-tracking-categories):
both use transaction classifications to analyse financial activity; Tohyee
uses its existing tracking tags rather than a duplicate fund dimension. Turn
on Advanced reporting as well as Not-for-profit to create and use these tags.
Fund labels are for analysis: they do not change a journal, GST treatment or
the recognition policy for a grant.

- **NFP1** In June 2026, the Community workshops fund (a value under
  Restricted) earns **1,000.00** in workshop fees and incurs **400.00** in
  printing costs. Post Dr 1000 Cash 1,000.00 / Cr 4000 Workshop fees 1,000.00
  (Fund: Community workshops), then Dr 6010 Printing 400.00 (Fund: Community
  workshops) / Cr 1000 Cash 400.00. The profit and loss split by Fund shows
  revenue **1,000.00**, expenses **400.00** and net profit **600.00** for
  Restricted. The $600 is this period's tagged activity, not a claim about the
  fund's closing equity balance. A budget can be assigned to the fund value
  and compared with its tagged actuals (BU5-BU7).

### Not supported yet (refused rather than guessed)

- **Fund equity balances carried forward by fund**: the existing balance sheet
  calculates total retained and current-year earnings; income/expense tags do
  not allocate untagged assets or liabilities. Do not treat a fund's tagged
  period surplus as its equity balance. Jess needs to decide how opening
  balances and shared assets/liabilities are allocated, and whether the
  year-end schedule is calculated or posted.
- **Grants and conditional funding**: no grant register, condition tracking,
  deferred-income release or grant-specific recognition is provided. XRB
  distinguishes conditions from restrictions in [PBE IPSAS 23](https://www.xrb.govt.nz/standards/accounting-standards/not-for-profit-standards/standards-list/pbe-ipsas-23/).
  The predecessor [PBE SFR-A (NFP)](https://www.xrb.govt.nz/standards/accounting-standards/not-for-profit-standards/standards-list/pbe-sfr-a-nfp/)
  and [PBE SFR-C (NFP)](https://www.xrb.govt.nz/standards/accounting-standards/not-for-profit-standards/standards-list/pbe-sfr-c-nfp/)
  apply to earlier reporting periods;
  XRB's Tier 3 and Tier 4 requirements apply to periods beginning on or after
  1 April 2024. The current Tier 3 requirements include documented
  expectations, so the older condition/restriction rule alone is not enough
  to implement current grants. Confirm the entity's tier, period and grant
  terms against [XRB Tier 3](https://www.xrb.govt.nz/standards/accounting-standards/not-for-profit-standards/standards-list/reporting-requirements-for-tier-3-not-for-profit-entities/)
  and [Tier 4](https://www.xrb.govt.nz/standards/accounting-standards/not-for-profit-standards/standards-list/reporting-requirements-for-tier-4-not-for-profit-entities/)
  before adding grant recognition. Do not use an ordinary journal as a claim
  that a grant has been recognised correctly.
- **Donation tax-credit receipts**: Tohyee does not produce these. IRD's
  [receipt requirements](https://www.ird.govt.nz/roles/not-for-profits-and-charities/running-your-nfp/requirements-for-creating-donation-receipts)
  (reviewed 1 Oct 2026) confirm the donor's name, donation amount and date,
  that the payment is a donation, and the receiving organisation's name and
  IRD number. Confirm any other particulars and layout against the current
  IRD guidance before generating a receipt that donors could rely on.
- **Tier 3 and Tier 4 performance reports**: the standard P&L and balance sheet
  are not PBE SFR-A (NFP) or PBE SFR-C (NFP) performance reports. Service
  performance measures, required statement layouts, accounting policies and
  disclosures are not implemented. Confirm the reporting tier and required
  measures with Jess against the [XRB Tier 3](https://www.xrb.govt.nz/standards/accounting-standards/not-for-profit-standards/standards-list/reporting-requirements-for-tier-3-not-for-profit-entities/)
  and [Tier 4](https://www.xrb.govt.nz/standards/accounting-standards/not-for-profit-standards/standards-list/reporting-requirements-for-tier-4-not-for-profit-entities/) requirements.
- **Incorporated societies**: no society-specific financial statements,
  filing dates or audit checks are implemented. Ask Jess which clients are
  societies, whether they are registered charities, and which reporting
  requirements apply; see [Incorporated Societies Act 2022, ss 102 and 108](https://www.legislation.govt.nz/act/public/2022/0012/latest/whole.html).

**Companies** are Tohyee's contacts, so the CRM and the accounts share one
list. As well as customer and supplier, a contact can be a **prospect**
(someone you hope to sell to). A contact must be at least one of the three;
a prospect-only contact can't be put on an invoice, bill or credit note
until it's marked as a customer, and only the CRM can make one.

**People** work at a company (or at none): first and last name, job title,
email and phone. People are archived, never deleted.

**Opportunities** (deals) have a name, a company, a point of contact (one of
its people), an owner (a member of the organisation), an amount excluding
GST, an expected close date and a **stage**: New, Screening, Meeting,
Proposal, Won or Lost (Twenty's stages, with its "Customer" called Won, and
Lost added; since CRMS1 these are the organisation's starting stages, which
an admin can change, and "Won" means any Closed won stage). Stages change freely until an opportunity has made an invoice.
A **won opportunity can make a draft invoice** for its company: one line with
the opportunity's name and amount, the first active revenue account and the
standard GST code, dated today and due on the customer's payment terms (in
20 days if they have none, RC1), which is then edited and
approved like any other. Making it marks a prospect as a customer too. An
opportunity makes at most one invoice. An opportunity for a company in
another currency is in that currency, amount and invoice (zero-rated, at a
rate for its date), following NetSuite (MC68, MC69).

**Tasks** have a title, optional details, a due date, an assignee (a
member), a status (To do, In progress, Done) and can be about a company, a
person or an opportunity. **Activities** record a call, a meeting or a note
on a company, person or opportunity, with when it happened. Tasks and
activities are edited but never deleted (a task is marked done; an activity
can be corrected, and the change is in the history).

A company's **timeline** lists, newest first: its activities, tasks,
opportunities (created and stage changes), and its approved invoices, credit
notes, customer payments, bills and supplier payments, each linking to it.

None of the CRM posts anything except the draft invoice, which posts only
when approved.

- **CRM1** Adding Mānuka Vets as a prospect (not a customer or supplier)
  works with the CRM on and is refused with it off; a draft invoice for it is
  refused ("isn't marked as a customer"). A contact that's none of the three
  is refused.
- **CRM2** People: Aroha Ngata (Practice manager, aroha@manukavets.nz) at
  Mānuka Vets. A person's company must be an existing contact; an email must
  look like one. A person can't be deleted, only archived.
- **CRM3** Opportunity "Memorial paw prints 2027" for Mānuka Vets, 2,400.00,
  closing 2026-12-15, point of contact Aroha, owner Jess, stage New. The
  point of contact must work at that company. The amount can't be negative.
- **CRM4** Moving it New → Proposal → Lost → Proposal works and each move is
  in the history (the timeline shows "Proposal → Lost").
- **CRM5** Marking it Won and making the invoice: a draft invoice for Mānuka
  Vets dated today, one line "Memorial paw prints 2027" 1 × 2,400.00 to 4000
  with GST (15%), total **2,760.00**; Mānuka Vets is now a customer (still a
  prospect too); nothing is posted until the draft is approved. Making the
  invoice again returns the same invoice; an opportunity that isn't Won
  can't make one; once it has an invoice its stage can't change.
- **CRM5b** A won opportunity can make a **draft sales order** instead
  (NetSuite's opportunity to sales order; decision 327): for Mānuka Vets,
  dated today, one line "Memorial paw prints 2027" 1 × 2,400.00 to 4000
  with GST (15%), total **2,760.00**, reference the opportunity's name,
  posting nothing (a sales order never posts). It's either an invoice or a
  sales order: once one is made the other is refused ("This opportunity
  already has an invoice." / "This opportunity already has a sales
  order."). Making it again returns the same sales order; an opportunity
  that isn't Won can't make one ("Only a won opportunity can make a sales
  order."); once it has a sales order its stage can't change. A company in
  another currency gets the sales order in its currency, with no exchange
  rate (as SO10).
- **CRM6** Tasks: "Send sample kit" due 2026-10-01 for Jess about the
  opportunity, To do → Done. The assignee must be a member of the
  organisation. A task can't be deleted.
- **CRM7** Activities: a call with Aroha on 2026-09-28 10:00 ("Talked about
  pricing"), a meeting and a note on Mānuka Vets. An activity must be about
  something (a company, person or opportunity).
- **CRM8** Mānuka Vets' timeline after CRM3-CRM7 and approving the CRM5
  invoice lists, newest first, the approved invoice, the task, the
  activities and the opportunity's events, and the company's list shows 1
  open task and the open pipeline total **0.00** (the only opportunity is
  won; open means not Won or Lost).
- **CRM9** The pipeline board groups open and closed opportunities by stage
  with a total per stage (amounts excluding GST).
- **CRM10** The CRM's Home (not yet approved by Jess) shows the signed-in
  person's own work. On 1 Oct 2026 Jess owns "Memorial paw prints 2027"
  (Mānuka Vets, 2,400.00, New), "Clinic display" (Mānuka Vets, 600.00,
  Proposal), "Logo licence" (Acme Inc, which deals in USD, USD 100.00,
  Meeting) and "Menu reprint" (500.00, Won); Ben owns "Kennel cards"
  (900.00, New). Jess's open opportunities are the first three, totalling
  **NZD 3,000.00** and **USD 100.00** (never added together; Won and Lost
  aren't open). Jess's tasks due or overdue are "Send sample kit" (due 30 Sep,
  To do, overdue) and "Call Aroha" (due 1 Oct, In progress), in due-date
  order; not "Post brochure" (due 2 Oct), a done task due 30 Sep, a task with
  no due date, or Ben's task due 30 Sep. Ben's Home shows only "Kennel cards"
  (**900.00**) and his task. Both see the organisation's ten most recent
  calls, meetings and notes, newest first. Viewers can read it; it changes
  nothing.

## CRM email and calendar sync

The owner asked (29 Sep 2026) for email and calendar sync in the first round of
the CRM; the details follow Twenty's connected accounts:
each member of an organisation can connect their own **Gmail** or
**Microsoft 365** mailbox and calendar, and emails and meetings with people
the CRM knows show on those people's and companies' timelines. Like Akahu,
each organisation uses its own Google or Microsoft app: an admin enters its
client ID and secret (stored encrypted, never shown again), and the page
shows the redirect address to register with Google or Microsoft. Tohyee asks
for read-only access (Gmail and Google Calendar read-only; Microsoft
Mail.Read and Calendars.Read, plus offline access), never sends or changes
anything, and needs TOHYEE_SECRET_KEY to store the tokens.

- Only emails and meetings with at least one **known participant** are
  kept: someone whose address is a CRM person's email or a contact's email
  (ignoring case), other than the mailbox's owner. Everything else is never
  stored. A participant counts once however many times they appear.
- Each kept email records who it was from and to, when, whether it was
  sent or received, its subject and a short preview (at most 300
  characters); never the full body or attachments. Each kept meeting
  records its title, start, end, location and attendees.
- Each connected account chooses what the rest of the team sees:
  **subject and preview** (the default) or **only that it happened** (who
  and when, with "(private)" for the subject and no preview). The owner of
  the account always sees everything that was kept.
- Syncs run every 15 minutes, or on "Sync now". The first sync looks back
  30 days (emails) and 30 days either side of today (meetings); later syncs
  fetch what's new since the last one. An email or meeting already kept is
  never kept twice (it's matched by the provider's id); a changed meeting is
  updated.
- Disconnecting deletes the account's tokens and everything it synced (the
  copies in Tohyee, never the mailbox). A failed sync is recorded with its
  error and retried next time; three failures in a row pause the account
  until it's reconnected.
- The CRM must be on to connect or sync.

Setup: CRM on; company Mānuka Vets (hello@manukavets.nz) with person Aroha
Ngata (aroha@manukavets.nz); Jess connects jess@glimmers.nz.

- **MAIL1** Settings: saving a Google client ID and secret stores the secret
  encrypted and shows it only as "saved"; without TOHYEE_SECRET_KEY saving is
  refused. Only admins can change it; the redirect address shown ends in
  /api/crm/mail/callback.
- **MAIL2** Connecting: the Google sign-in address carries the client ID,
  the redirect address, read-only scopes, offline access and a one-time
  state; the callback with that state stores the account (jess@glimmers.nz,
  Google) with encrypted tokens. A callback with an unknown, used or
  expired (over 15 minutes) state, or from another signed-in user, is
  refused.
- **MAIL3** First sync of Gmail with three emails: from
  aroha@manukavets.nz to Jess ("Paw print order"), from Jess to
  hello@manukavets.nz ("Quote"), and from newsletter@shop.example to Jess.
  The first two are kept (received and sent), linked to Aroha and to
  Mānuka Vets; the newsletter isn't stored at all.
- **MAIL4** Syncing again with the same emails keeps nothing new; a fourth
  email to aroha@manukavets.nz is added.
- **MAIL5** Calendar: a meeting "Clinic visit" with aroha@manukavets.nz is
  kept and linked to Aroha and Mānuka Vets; a meeting with only Jess isn't;
  moving the clinic visit an hour later updates it.
- **MAIL6** Mānuka Vets' timeline shows the two emails and the meeting,
  with subject and preview, newest first, among its other entries.
- **MAIL7** Setting Jess's account to "only that it happened": other
  members see "(private)" and no preview; Jess still sees the subject.
- **MAIL8** Microsoft 365 works the same way (Graph messages and calendar
  view), matched and linked the same.
- **MAIL9** Disconnecting removes the account and its synced emails and
  meetings from the timeline. Three failed syncs in a row pause it with the
  last error shown.

## Sales platform connections (examples not yet approved by Jess)

Jess sells through Shopify and asked (1 Oct 2026) for Tohyee to connect to
sales platforms: Shopify first, then WooCommerce, Square and Stripe. The
plan is Shopify order → sales order → invoice, but sales orders are being
built separately, so **this first stage brings in only customers and
products, and posts nothing to the ledger**. The connector framework
(connections, the record links, the sync log, webhooks and the catch-up
sync) is shared, so other platforms can be added as more connectors.

The IDs are **SPC1-SPC10**: the brief suggested SP1, SP2..., but SP1-SP8
are already the supplier payment examples.

**This hasn't been tried against a real Shopify store.** The tests use
recorded Shopify-shaped responses and webhooks signed in the tests, like the
mail sync's.

What Shopify says (shopify.dev and help.shopify.com can't be opened from the
sandbox these were written in; the rules below come from Shopify's own
open-source app library,
[Shopify/shopify-app-js](https://github.com/Shopify/shopify-app-js), and
web searches of Shopify's pages, so check them against the pages linked):

- **Access**: a store owner makes a custom app and gives it an Admin API
  access token
  ([custom apps](https://help.shopify.com/en/manual/apps/app-types/custom-apps)).
  Shopify stopped new custom apps being made in the store admin from
  1 January 2026; ones made before then keep their access token (it starts
  `shpat_`) and API secret key. New custom apps are made in Shopify's Dev
  Dashboard, which gives a **client ID and client secret**; the app then
  asks the store for an access token itself (the
  [client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant),
  which lasts about 24 hours and only works when the app and store belong
  to the same organisation). Tohyee accepts either: an access token with
  the app's API secret key, or a client ID and secret.
- **API**: the Admin GraphQL API, version **2026-07**
  ([Admin GraphQL API](https://shopify.dev/docs/api/admin-graphql/2026-07)),
  at `https://{store}.myshopify.com/admin/api/2026-07/graphql.json` with the
  `X-Shopify-Access-Token` header. Customer `email` and `phone` are
  deprecated in this version, so Tohyee reads `defaultEmailAddress` and
  `defaultPhoneNumber`.
- **Scopes** (read-only only): `read_customers` and `read_products`
  ([access scopes](https://shopify.dev/docs/api/usage/access-scopes)). Tohyee
  never asks for a write scope and never changes anything in the store.
- **Webhooks**: Shopify signs each delivery with the app's secret (the API
  secret key, or the client secret): the `X-Shopify-Hmac-SHA256` header is
  the base64 HMAC-SHA256 of the raw body
  ([verifying webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe/https)).
  Each delivery has an `X-Shopify-Webhook-Id`, which is the same if Shopify
  sends it again. Webhooks set up by hand in the store's notification
  settings are signed with a different key, so Tohyee subscribes itself
  (`webhookSubscriptionCreate`), and only when the server has a public
  https address (Settings › Remote access). Without one, the catch-up sync
  still runs every 15 minutes.

The rules (our choice where Shopify and Jess are silent):

- An admin connects a store with its address (`name.myshopify.com`) and
  either an access token and API secret key, or a client ID and secret.
  Tohyee checks them by reading the shop's name, currency and whether its
  prices include tax before saving anything; then they're stored encrypted
  with TOHYEE_SECRET_KEY (without it, connecting is refused) and never shown
  again. A store can only be connected once at a time.
- The admin chooses what to sync: **customers** (into contacts, as
  customers) and **products** (each variant into an item). Each Tohyee
  record linked to a Shopify record is remembered, so nothing is brought in
  twice.
- **Matching**: a Shopify customer links to the one active contact with
  the same email (ignoring case). A variant links to the item whose code is
  the variant's SKU (ignoring case). Anything else that isn't clear is
  skipped and logged, never guessed: no email match and a contact with the
  same name already exists; more than one contact with that email; a
  record already linked to another Shopify record; a variant with no SKU,
  or a SKU that can't be an item code; an archived contact or item.
  Otherwise a new contact (a customer) or a new **non-stock** item is
  added. A new item's name is the product's title, followed by " - " and
  the variant's title unless Shopify calls it "Default Title".
- **What's copied**: a contact's name, email and phone; an item's name and
  sale price. The **sale price is only copied when the store's currency is
  the organisation's base currency and its prices exclude tax**, because
  Tohyee's item prices exclude GST; otherwise it's logged as not copied
  (see the questions below). Addresses, countries and stock levels aren't
  copied. An item's code isn't changed after it's linked.
- **Never overwriting what someone changed**: Tohyee remembers the value
  Shopify last had for each copied field. When Shopify changes a field and
  Tohyee still has the value Shopify last had, Tohyee's is updated; when
  someone changed it in Tohyee, Tohyee's is kept and the log says so. When
  a record is first linked, blank Tohyee fields are filled and different
  ones kept (and logged).
- **Webhooks** (customer and product create and update) are checked
  against the connection's secret before anything is read from them; a
  delivery that fails the check is refused (401) and nothing is stored or
  logged. A delivery already received (same webhook ID) is acknowledged
  and does nothing. A change older than the last one seen is ignored.
- **The sync log** lists, newest first, what each sync and webhook did:
  created, linked, updated, kept Tohyee's value, skipped (with why) and
  errors. Syncs run every 15 minutes (off with
  TOHYEE_SALES_PLATFORM_SYNC_SCHEDULER=off) or on **Sync now**; each fetches
  what changed since the last one. A failed sync records its error and is
  tried again next time; three failures in a row pause the connection until
  an admin syncs it successfully.
- **Disconnecting** removes the credentials, the cached access token and
  the links between Shopify and Tohyee records, and unsubscribes the
  webhooks it can. Contacts and items brought in stay, and so does the
  sync log. Connecting the same store again matches by email and SKU again.
- Admins (and owners) connect, test, change what's synced, sync now and
  disconnect; everyone in the organisation (viewers up) can see the
  connections and the sync log. Nothing here touches the ledger.

Setup: base currency NZD. Active contact **Aroha Ngata**
(aroha@manukavets.nz, a customer, no phone) and **Kiri Walker** (no email).
Item **CANDLE-L** "Large soy candle", non-stock, sale price **20.00**.
Shopify store glimmers.myshopify.com, "Glimmers", NZD, prices exclude tax.

- **SPC1** Connecting checks the credentials (the shop's name, Glimmers,
  is read back) and stores the access token and secret encrypted; the
  connection shows the store, its currency, "prices exclude tax" and what's
  synced, never the secrets. Wrong credentials (Shopify says 401) are
  refused and nothing is stored; without TOHYEE_SECRET_KEY connecting is
  refused; connecting glimmers.myshopify.com a second time is refused.
  If the store refuses one of the four webhooks (PRODUCTS_CREATE), the two
  already made are removed again, the connection is still connected with a
  note saying why webhooks aren't on, and testing the connection later sets
  up all four once (testing again doesn't add more).
- **SPC2** Customers sync: Shopify customer 1001 "Aroha Ngata",
  AROHA@manukavets.nz, +64 21 555 0101 links to the existing contact Aroha
  Ngata (email ignoring case) and fills her blank phone; 1002 "Tama Rewi",
  tama@example.co.nz, adds a new customer contact Tama Rewi; 1003 "Kiri
  Walker" with no email is skipped (there's already a Kiri Walker and
  nothing to match them by). The log has linked, updated (phone), created
  and skipped lines.
- **SPC3** Products sync: product "Large candle" with one variant
  (Default Title, SKU candle-l, 20.00) links to CANDLE-L and keeps its name
  "Large soy candle" (logged as kept); product "Wax melts" with variants
  Vanilla (SKU MELT-VAN, 8.50) and Lavender (no SKU) adds non-stock item
  MELT-VAN "Wax melts - Vanilla" at **8.50** and skips Lavender (no SKU).
- **SPC4** Syncing again with nothing changed in Shopify changes nothing
  and adds nothing: no new contacts, items or log lines.
- **SPC5** Changes on both sides: someone renames Tama Rewi in Tohyee to
  "Tama Rewi (wholesale)". Shopify then changes Tama's last name to
  "Rewi-Smith" and phone to +64 22 555 0102, and Large candle's price to
  22.00. The next sync updates Tama's phone and CANDLE-L's sale price to
  **22.00**, and keeps "Tama Rewi (wholesale)", logging that Tohyee's name
  was kept because it was changed in Tohyee.
- **SPC6** A store whose prices include tax: MELT-VAN is added with **no
  sale price** and the log says the price wasn't copied because Shopify's
  prices include tax. The same for a store in AUD.
- **SPC7** Webhooks: a `customers/create` webhook for customer 1004 "Mere
  Tane", signed with the connection's secret, adds the contact; the same
  delivery again (same webhook ID) is acknowledged and does nothing; a
  `products/update` webhook for "Wax melts" with Vanilla at 9.00 updates
  MELT-VAN's price to **9.00**. A webhook whose change is older than the
  last one seen for that record changes nothing.
- **SPC8** A bad signature is refused: a webhook signed with another
  secret, one whose body was changed after signing, one with no signature,
  one for another store's domain and one to an unknown connection address
  are all refused with 401, and no contact is added and nothing is logged.
- **SPC9** Disconnecting keeps records: Aroha, Tama, Mere, CANDLE-L and
  MELT-VAN stay as they are, the credentials and links are gone, the log is
  kept with a "disconnected" line, and the old webhook address refuses
  deliveries. Connecting the store again and syncing links Aroha and
  CANDLE-L again by email and SKU, without adding duplicates.
- **SPC10** Roles: a viewer sees the connection and its sync log, but
  connecting, testing, changing what's synced, syncing now and
  disconnecting are refused (403); an admin can do them all. Nothing is
  posted to the ledger by any of this (no journals before or after).

### Stage 2: Shopify orders into the accounts (examples not yet approved by Jess)

Jess answered the stage 1 questions on 1 Oct 2026 (decisions 51-55 in
`docs/DECISIONS.md`): orders reach the accounts **per order**, as
NetSuite's Shopify connectors do; tax comes from Shopify's own tax lines;
tracked products become stock items; the customer's country comes across.
**None of this has been tried against a real Shopify store**: the tests use
recorded Shopify-shaped responses and webhooks signed in the tests.

What Shopify says (read on shopify.dev and help.shopify.com, Admin GraphQL
API version 2026-07, 1 Oct 2026):

- **Connecting a Dev Dashboard app**: the client ID and secret are
  exchanged for a token by `POST https://{shop}.myshopify.com/admin/oauth/access_token`
  with a form-encoded body `grant_type=client_credentials`, `client_id`,
  `client_secret`; the answer has `access_token`, `scope` and `expires_in`
  ("Always 86399 (24 hours)"). It only works when the app and store are in
  the same Shopify organisation; otherwise Shopify answers
  `shop_not_permitted` ("Client credentials cannot be performed on this
  shop"), and a store outside the organisation needs the authorization code
  grant
  ([client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant)).
- **Scopes** ([access scopes](https://shopify.dev/docs/api/usage/access-scopes)):
  `read_orders` (orders, their transactions and refunds; only the last 60
  days of orders without `read_all_orders`, which Shopify must approve),
  `read_shopify_payments_payouts` (payouts and balance transactions) and
  `read_shopify_payments_accounts` (the Shopify Payments account the payouts
  hang off). `read_products` also covers whether a variant's inventory is
  tracked (`InventoryItem.tracked`). All read-only.
- **Orders** ([Order](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order)):
  `taxesIncluded` — "When `true`, the subtotal and line item prices include
  tax amounts"; `totalPriceSet` is the total "before returns ... This
  includes taxes and discounts"; `customer` is null for a guest checkout;
  `test` marks test orders; `cancelledAt`; `displayFinancialStatus` (PAID,
  PARTIALLY_PAID, PENDING, AUTHORIZED, PARTIALLY_REFUNDED, REFUNDED,
  VOIDED, EXPIRED); `transactions` (kind SALE, CAPTURE, AUTHORIZATION,
  REFUND...; status SUCCESS...).
- **Lines** ([LineItem](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/LineItem)):
  `originalTotalSet` "doesn't include discounts"; `discountAllocations` are
  all the discounts allocated to the line (order-level ones too), so a
  line's amount is its original total less its allocations; `taxLines`
  (title, rate, `priceSet`); `taxable`; `isGiftCard`.
  **Shipping** ([ShippingLine](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/ShippingLine)):
  `discountedPriceSet` is "the shipping price after applying discounts. If
  the parent order.taxesIncluded field is true, then this price includes
  taxes", including cart-level discounts like free shipping; its own
  `taxLines`; `isRemoved`.
- **Refunds** ([Refund](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Refund),
  [RefundLineItem](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/RefundLineItem)):
  each refunded line has `quantity`, `restocked`, `subtotalSet` and
  `totalTaxSet`; refunded shipping has `subtotalAmountSet` and
  `taxAmountSet`; `orderAdjustments`; and the refund's `transactions` are
  the money returned. Shopify's page doesn't say whether a refund line's
  subtotal includes tax on a taxes-included order; Tohyee takes it the same
  way as the order's line prices and checks the result against the money
  refunded (see below).
- **Payouts** ([ShopifyPaymentsPayout](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/ShopifyPaymentsPayout),
  [ShopifyPaymentsBalanceTransaction](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/ShopifyPaymentsBalanceTransaction)):
  `shopifyPaymentsAccount.payouts` (status PAID, SCHEDULED, CANCELED, FAILED;
  `issuedAt`; `net`; `transactionType` DEPOSIT or WITHDRAWAL) and
  `shopifyPaymentsAccount.balanceTransactions(query: "payments_transfer_id:…")`
  (type CHARGE, REFUND, ADJUSTMENT, CHARGEBACK…, each with `amount`, `fee`
  and `net`). Shopify Payments takes its fees out of each transaction
  before paying out
  ([payout fees](https://help.shopify.com/en/manual/payments/shopify-payments/payouts/pay-periods-and-fees)),
  and adds tax to them only for businesses in Switzerland, the European
  Union, Australia or Singapore (same page), so a New Zealand store's fees
  carry **no GST**.
- **Webhooks** ([WebhookSubscriptionTopic](https://shopify.dev/docs/api/admin-graphql/2026-07/enums/WebhookSubscriptionTopic)):
  `ORDERS_CREATE`, `ORDERS_UPDATED`, `ORDERS_PAID`, `ORDERS_CANCELLED` and
  `REFUNDS_CREATE` (needing `read_orders`). There's no payout topic, so
  payouts come with the catch-up sync.

What NetSuite does (docs.oracle.com, NetSuite Connector for Shopify):
orders come in as sales orders, billed as cash sales left in undeposited
funds; the **Shopify Payout Report sync** then "creates a deposit record,
deposits the corresponding cash sales and cash refunds, then adds lines to
the deposit for the fees Shopify charges", with variances to a chosen
account
([Shopify Payout Report Sync](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_0630052659.html)).
Tohyee has no undeposited funds account, so the "Shopify clearing" bank
account plays that part (like Xero's Shopify clearing account), and the
deposit is a transfer to the bank plus the fees. NetSuite maps discounts to
a discount item; Tohyee's invoices have no negative lines, so each line
carries Shopify's discount allocation instead (the amounts are the same).

The rules (our choice where Shopify, NetSuite and Jess are silent):

- **Connecting**: the admin gives either an existing admin-app access token
  and API secret key (as in stage 1) or a Dev Dashboard app's client ID and
  secret. Tokens from the client ID and secret are asked for again 5
  minutes before they expire, stored encrypted with TOHYEE_SECRET_KEY and
  never shown or logged. `shop_not_permitted` is refused with: "This app
  and store aren't in the same Shopify organisation. Tohyee can only
  connect a store with a Dev Dashboard app from the store's own
  organisation (connecting someone else's store needs Shopify's
  authorization code grant, which Tohyee doesn't do yet)."
- **Settings** (admins): **Post to accounts** (off to start with; nothing is
  fetched or posted while it's off), a **start date** (only orders
  processed on or after it, and payouts issued on or after it, come in),
  the **clearing account** (a bank account; set-up can add one called
  "Shopify clearing"), the **bank account payouts arrive in**, the **fees
  account** (an expense account, e.g. 6020 Bank fees), the **sales account**
  and **shipping account** (revenue accounts, for lines whose item has no
  income account and for shipping), the **tax code for each Shopify tax
  rate** (e.g. 15% → GST) and the **code for untaxed sales** (zero-rated or
  exempt, e.g. ZERO). Turning posting on needs the clearing, payout, fees,
  sales and shipping accounts, a start date, and `read_orders` granted to
  the app.
- **Orders**: each Shopify order processed on or after the start date
  becomes an **approved sales order** for the linked customer (stage 1's
  customer sync runs for it first), reference the order's name ("#1001"),
  dated the day it was processed in New Zealand time. It's remembered by
  the store and order ID, kept after disconnecting, so a webhook sent again,
  an overlapping sync or connecting the store again never makes a second.
  **Paid** orders (Shopify says PAID, PARTIALLY_REFUNDED or REFUNDED) are
  invoiced from the sales order (the whole order), approved, and the
  successful sale and capture transactions are recorded as a **customer
  payment into the clearing account**, dated the day of the last one.
  Orders **cancelled before payment** cancel the sales order.
- **Lines**: each order line's amount is Shopify's original total less its
  discount allocations; quantity × unit price must give that amount
  exactly, so when it doesn't divide (22.00 for 3) it's two lines (2 ×
  7.33 and 1 × 7.34). Each non-removed shipping line is a line "Shipping:
  {title}" at its discounted price to the shipping account. A line whose
  variant is linked to an item carries the item (so stock items move
  stock) and goes to the item's income account, else the sales account.
- **Tax**: an organisation with a GST number in Settings is GST registered
  (as on its tax invoices, PD2-PD7). Registered: the amounts are tax
  inclusive when Shopify's `taxesIncluded` is true, else exclusive; a line
  with a Shopify tax line takes the Tohyee code mapped to that rate (whose
  rate must be the same); a line with none takes the export tax code when
  Foreign trade is on and the customer is overseas (EX3, EX4), else the
  untaxed code. Tohyee works GST out per line, as always; when a line's GST
  differs from Shopify's tax line (by rounding), the sync log says so with
  both amounts. **Not registered**: the amounts have no tax; any tax
  Shopify charged is part of the sale and the log says so. If the invoice
  total isn't Shopify's order total, the order isn't invoiced and the log
  shows both totals.
- **Country**: a new contact gets the customer's country (Shopify
  customer's default address, else the order's billing address) as its
  billing country; for a linked contact the country is a copied field like
  name and email (SPC5's rules).
- **Stock**: a new item from a variant whose inventory Shopify tracks is a
  **stock** item, otherwise non-stock. Stock moves only through the
  invoices and credit notes, by the existing rules (ST1-ST12): an invoice
  for more than is on hand is refused unless negative stock is allowed, and
  then the order waits (logged) until there's stock. Nothing is written
  back to Shopify. A linked item keeps its type.
- **Refunds**: each Shopify refund with money returned, on an order that
  was invoiced, becomes an **approved credit note** against the invoice,
  dated the refund's day: a line per refunded line (the quantity, and
  Shopify's subtotal, plus its tax when the order's prices exclude tax), a
  line per refunded shipping line; restocked stock items come back at the
  sale's cost (ST5), others are a line without the item. The credit note's
  total must equal the money refunded (the refund's successful REFUND
  transactions), otherwise nothing is posted and the log shows both. The
  credit note is then **refunded from the clearing account** for its total.
- **Payouts**: each Shopify Payments payout with status PAID, issued on or
  after the start date, is posted on its issue date (New Zealand time) as a
  **transfer from the clearing account to the payouts bank account** for
  its net amount, and a **spend money from the clearing account** to the
  fees account for the fees and any adjustments (no GST; contact "Shopify",
  added if there isn't one). Its balance transactions' nets must add up to
  the payout's net, and only CHARGE, REFUND and ADJUSTMENT ones are posted;
  anything else (chargebacks, reserves, advances...) is refused for that
  payout and logged. So the payout's bank statement line matches the
  transfer, and the clearing account is left with what Shopify still holds.
- **Never twice, never silently**: everything posted is remembered by store
  and Shopify ID; every order, refund and payout that's posted, refused or
  waiting gets a sync log line, and a line that says the same thing isn't
  repeated every 15 minutes. Posting follows the period lock: a date in a
  locked period is refused and logged, and tried again next sync.

Setup (on top of SPC1-SPC10's): Glimmers Ltd, base currency NZD, **GST
number 123-456-789**, Foreign trade **off**, tax code for exports
**EXPORT** (a zero-rated code, EX13). The store's prices **include tax**.
Connection settings: post to accounts **on**, start date **2026-10-01**,
clearing account **1010 Shopify clearing** (bank, added in set-up), payouts
into **1000 Business bank account**, fees **6020 Bank fees**, sales and
shipping **4000 Sales**, Shopify 15% → **GST**, untaxed → **ZERO**. Dates
are New Zealand dates (NZDT, UTC+13).

- **SPC11** A GST-registered organisation's taxes-included order: order
  **#1001** (5001), processed 2026-10-02T01:30Z, customer 1001 Aroha Ngata,
  2 × Large candle (CANDLE-L) at 23.00 = **46.00**, Shopify tax line GST 15%
  **6.00**, paid by Shopify Payments 46.00. Sales order **SO-0001** (2 Oct,
  approved, tax inclusive): 2 × 23.00 GST. Invoice **INV-0001** 2 Oct:
  **Dr 1100 46.00 / Cr 4000 40.00 / Cr 2100 6.00**. Payment 2 Oct:
  **Dr 1010 46.00 / Cr 1100 46.00**. The invoice is paid and the sales
  order billed. The log has the order's "posted" line.
- **SPC12** A non-GST-registered organisation's order (the Glimmers store
  isn't GST registered, decision 53): no GST number; the same order with no
  tax lines. SO and invoice have **no tax**: 2 × 23.00 = 46.00:
  **Dr 1100 46.00 / Cr 4000 46.00**, payment **Dr 1010 46.00 / Cr 1100
  46.00**. Had Shopify charged 6.00 tax, the amounts would be the same and
  the log would say the 6.00 is part of the sale because the organisation
  isn't GST registered.
- **SPC13** Shipping and a discount: order **#1002** (5002), customer 1002
  Tama Rewi, processed 2026-10-03T00:15Z, 3 × Wax melts - Vanilla
  (MELT-VAN) at 9.00 = 27.00 with order discount WELCOME5 allocated **5.00**
  → **22.00**, Shopify tax **2.87**; shipping "NZ Post standard" **6.90**,
  tax **0.90**; total **28.90**, paid. Invoice lines: **2 × 7.33** (GST
  1.91) and **1 × 7.34** (GST 0.96) MELT-VAN to 4000, and **Shipping: NZ
  Post standard 1 × 6.90** (GST 0.90) to 4000; GST **3.77**, total
  **28.90**: **Dr 1100 28.90 / Cr 4000 19.13 / Cr 4000 6.00 / Cr 2100
  3.77**; payment **Dr 1010 28.90 / Cr 1100 28.90**.
- **SPC14** A partial refund: on 2026-10-05T22:00Z (6 Oct) Shopify refunds
  1 of #1001's 2 candles, not restocked: subtotal **23.00**, tax **3.00**,
  REFUND transaction **23.00**. Credit note **CN-0001** 6 Oct against
  INV-0001, 1 × 23.00 GST: **Dr 4000 20.00 / Dr 2100 3.00 / Cr 1100
  23.00**; refund from clearing **Dr 1100 23.00 / Cr 1010 23.00**. A refund
  whose lines don't add up to the money refunded (a 23.00 line but 20.00
  refunded) posts nothing and the log shows 23.00 and 20.00.
- **SPC15** A payout with fees matching a bank line: payout **70001**,
  PAID, issued 2026-10-07T03:00Z, net **49.38**: CHARGE #1001 46.00 (fee
  1.38, net 44.62), CHARGE #1002 28.90 (fee 1.14, net 27.76), REFUND #1001
  −23.00 (fee 0.00, net −23.00). Posted 7 Oct: transfer **Dr 1000 49.38 /
  Cr 1010 49.38**; spend money to Shopify **Dr 6020 2.52 / Cr 1010 2.52**
  (no GST). The clearing account is then **0.00** (46.00 + 28.90 − 23.00 −
  49.38 − 2.52). A statement line on 1000 dated 8 Oct, +49.38 "SHOPIFY
  PAYOUT", is offered the transfer as its exact match. A second payout
  **70002** issued 2026-10-14T03:00Z, net **17.33**: CHARGE #1003 23.00
  (fee 0.67, net 22.33) and ADJUSTMENT −5.00 ("Shopify adjustment",
  net −5.00): transfer **17.33**, spend money **Dr 6020 5.67** (fees 0.67
  and the adjustment 5.00, each its own line) / Cr 1010 5.67. A payout with
  a CHARGEBACK transaction, or whose balance transactions don't add up to
  its net, posts nothing and is logged.
- **SPC16** An overseas customer: Shopify customer 1005 Emma Clarke
  (default address in AU) orders **#1003** (5003), processed
  2026-10-08T02:00Z, 1 × Large candle 23.00 with **no tax lines**, paid.
  The new contact Emma Clarke has billing country **AU**. Foreign trade
  **off**: the line's tax code is the untaxed code **ZERO**, GST 0.00,
  total 23.00: **Dr 1100 23.00 / Cr 4000 23.00**. With Foreign trade **on**
  (the same order in another organisation), the line's code is **EXPORT**,
  GST 0.00, the same journal.
- **SPC17** A tracked product moving stock: Shopify product "Gift box"
  (variant SKU GIFTBOX, inventory tracked) is added as **stock** item
  GIFTBOX. A bill puts 10 into stock at 12.00 (**Dr 1400 120.00**). Order
  **#1004** (5004), Aroha, processed 2026-10-09T01:00Z, 1 × GIFTBOX at
  34.50, tax 4.50, paid: invoice **Dr 1100 34.50 / Cr 4000 30.00 / Cr 2100
  4.50** and cost of sales **Dr 5000 12.00 / Cr 1400 12.00**; 9 left. An
  order for 20 more (with negative stock off) is refused at the invoice and
  logged; the sales order stays approved and nothing is posted.
- **SPC18** A duplicate webhook: an `orders/paid` webhook for #1001
  (signed, webhook ID W-1) brings it in as SPC11; the same delivery again is
  acknowledged ("Already handled") and does nothing; an `orders/updated`
  delivery (W-2) for the same unchanged order, and a catch-up sync, add no
  sales order, invoice, payment or journal. A `refunds/create` webhook
  posts SPC14's refund once.
- **SPC19** A token refresh: a connection made with client ID and secret
  holds a token expiring at 2026-10-02T00:03Z. A sync at 00:00Z (within 5
  minutes of expiry) asks Shopify for a new one (form-encoded
  `grant_type=client_credentials`), uses it, and stores it encrypted with
  expiry 00:00Z + 86399 s; neither token appears in the connection, the
  sync log or the audit trail. A sync an hour later uses the stored token
  without asking again. Shopify answering `shop_not_permitted` on
  connecting is refused with the "same Shopify organisation" message and
  nothing is saved.
- **SPC20** Cancelled before payment: order **#1005** (5005), pending
  (bank deposit), processed 2026-10-10T00:00Z: sales order SO-000n
  approved, not invoiced. Shopify cancels it (VOIDED, cancelledAt set): the
  sales order is **cancelled**. No journals at any point.
- **SPC21** The start date, the switch and the period lock: an order
  processed 2026-09-30T10:00Z (30 Sep NZ) is before the start date and
  isn't brought in. With **post to accounts off**, a sync and an order
  webhook fetch and post nothing (no sales orders, no journals). Turning it
  on without a clearing account, or when the app hasn't `read_orders`, is
  refused. With October locked, a paid order dated in October is refused
  at the invoice and logged; after unlocking, the next sync posts it once.
- **SPC22** Roles: only admins change these settings (viewers and
  bookkeepers get 403); everyone can read the log; the webhook address
  takes only signed deliveries.
- **SPC23** Refused rather than guessed (logged, nothing posted): a test
  order; an order without a customer (guest checkout) when no contact is
  chosen for them (SPC24); an order in another
  currency (store or presentment not NZD); an order with a gift card line;
  a paid order whose total Tohyee can't reproduce (e.g. with a tip or
  duties); a payment by a gift card; a partly paid order (it waits); a
  refund with an order adjustment; a payout that's a withdrawal.

- **SPC24** Guest checkouts (decision 317). An admin chooses the
  customer contact **Shopify customers** for guest checkouts on the
  connection (a supplier-only contact such as Box Co is refused). A paid
  guest order **#1201** (no Shopify customer, billing country NZ) is then
  brought in like #1001 (SPC11), with its sales order and invoice against
  Shopify customers. Whether a guest order is an
  export comes from its own billing country, not the contact. With no
  contact chosen, a guest order (**#1202**) is refused and logged: "#1202
  has no Shopify customer (a guest checkout). Choose a contact for guest
  checkouts in the connection's settings to bring it in."

### Not supported yet (refused rather than guessed)

- WooCommerce, Square and Stripe.
- Copying sale prices from a store whose prices include tax, or whose
  currency isn't the base currency.
- Addresses (other than the country), stock levels and costs from Shopify;
  writing anything back to Shopify (stock levels need write access).
- Connecting a store owned by another Shopify organisation (Shopify's
  authorization code grant).
- Per-payout summary accounting (one journal per payout instead of per
  order).
- The cases in SPC23; Shopify locations (a stock item needs a Location once
  locations are in use, so such orders are refused at the invoice); orders
  edited after they came in (the sales order keeps the first version, and
  the totals check refuses the invoice if they differ); more than 50 lines
  or 10 shipping lines on an order, 50 or more payment transactions or 10
  or more refunds on an order, or more than 50 lines on a refund (kept
  small so each query stays under Shopify's query cost limit of 1,000).
- Deleting or archiving a Tohyee record when it's deleted in Shopify (the
  link stays; nothing happens).
- Matching by name, or anything other than one clear email or SKU match.

### Questions for Jess (sales platform connections), decided

Decided on 2 Oct 2026: decisions 317-322 (guest checkouts go to a chosen contact, SPC24; a real refund still to check). What was asked is kept below.

Answered 1 Oct 2026 (decisions 51-55): per order; tax from Shopify's tax
lines; tracked products as stock items; countries come across; both kinds
of app. Still open:

- **Guest checkouts**: an order without a Shopify customer is refused.
  Should they go to one contact (e.g. "Shopify customers"), as some
  connectors do?
- **Chargebacks, reserves and other payout transactions**: only charges,
  refunds and adjustments are posted; payouts with anything else are
  refused for you to record by hand. Where should chargebacks go?
- **Adjustments** in a payout go to the fees account. Is that right, or
  should they have their own account?
- **Invoice date**: a paid order is invoiced on the day it was paid (the
  sales order keeps the order's date). Should it be the order's date?
- **Refund line subtotals**: Shopify's docs don't say whether a refunded
  line's subtotal includes tax on a taxes-included order. Tohyee assumes it
  does (like the order's prices) and refuses a refund that doesn't add up
  to the money refunded. Please check one real refund.
- **Shipping**: shipping goes to the shipping account chosen in settings
  (4000 Sales to start with). Should it be its own account?

### Shopify chargebacks and reserves (item 7 part 1, approved by Jess, 5 Oct 2026)

Jess, 5 Oct 2026: **no summary mode** (each order keeps its own invoice,
and a payout matches them, as SPC15 and NetSuite do); a disputed amount goes
to a **chargebacks account** with the chargeback fee to fees; money Shopify
holds back goes to a **reserve account** until it's released; WooCommerce
comes next (part 2).

What Shopify says (read on shopify.dev and help.shopify.com, Admin GraphQL
API 2026-07, 5 Oct 2026):

- When a chargeback opens, "the bank takes the disputed amount from you
  right away. The cardholder's bank also takes a chargeback fee from you";
  with Shopify Payments "the amount is deducted from your next available
  payout". If you win, "you get the disputed amount back, and Shopify might
  refund the chargeback fee depending on your country or region". An
  inquiry doesn't "take the disputed amount or a fee right away"
  ([managing chargebacks](https://help.shopify.com/manual/payments/shopify-payments/managing-chargebacks)).
- A reserve is "a temporary hold on a portion, in some cases a full amount,
  of transactions"; "negative reserve transactions" are the part of payouts
  put in reserve and "positive reserve transactions" the funds that become
  available after the reserve ends
  ([reserves](https://help.shopify.com/en/manual/payments/shopify-payments/reserves)).
- The balance transaction types
  ([ShopifyPaymentsTransactionType](https://shopify.dev/docs/api/admin-graphql/2026-07/enums/ShopifyPaymentsTransactionType))
  include `DISPUTE_WITHDRAWAL`, `DISPUTE_REVERSAL`, `CHARGEBACK_FEE`,
  `CHARGEBACK_FEE_REFUND`, `CHARGEBACK_HOLD`, `CHARGEBACK_HOLD_RELEASE`,
  `RESERVED_FUNDS`, `RESERVED_FUNDS_REVERSAL` and
  `RESERVED_FUNDS_WITHDRAWAL`; Shopify describes each only as "The
  dispute_withdrawal transaction type" and so on. **Which type is which
  step, and its sign, is our reading of the names**, so each is posted only
  when its amount has the sign below, and a payout with any other sign or
  type is still refused for you to record by hand (SPC31). Please check one
  real chargeback and one reserve against this (question 2).

The rules:

- **Settings** (admins): a **chargebacks account** (an expense account,
  e.g. 6025 Shopify chargebacks) and a **reserve account** (a bank account
  in the base currency, e.g. 1015 Shopify reserve, shown with the bank
  accounts in current assets; not the clearing or payout account). Neither
  is needed until a payout has a chargeback or reserve; such a payout is
  refused until it's chosen: "Choose a chargebacks account in the Shopify
  settings."
- `DISPUTE_WITHDRAWAL` (negative: the disputed amount taken) goes on the
  payout's spend money to the chargebacks account, described "Chargeback on
  #1002"; `CHARGEBACK_FEE` (negative) and any `fee` on these transactions go
  to the fees account, as Shopify's other fees (decision 319).
- `DISPUTE_REVERSAL` (positive: a won dispute) and `CHARGEBACK_FEE_REFUND`
  (positive) come back on a **receive money** into the clearing account from
  contact Shopify, to the chargebacks and fees accounts.
- The order's invoice and sales stay as they are: a chargeback doesn't
  reduce sales or GST (Jess chose the chargebacks account over treating it
  as a refund; see question 1 about GST).
- `RESERVED_FUNDS` (negative: held) is a **transfer** from the clearing
  account to the reserve account; `RESERVED_FUNDS_REVERSAL` (positive:
  released) a transfer back. So the reserve account always shows what
  Shopify is holding.
- Everything else is as SPC15: the net goes from clearing to the payout
  account by transfer, the payout is checked to add up to its net, and each
  document is made once (idempotency keys per payout and step).

Setup (on top of SPC11-SPC24's): 6025 Shopify chargebacks (expense) and
1015 Shopify reserve (bank, NZD) chosen in the connection's settings. Orders
#1005-#1010 are paid orders posted as SPC11 (invoice paid into 1010).

- **SPC25** A chargeback opens on #1002 (28.90, SPC15). Payout **70003**,
  PAID, issued 2026-10-21T03:00Z, net **13.03**: CHARGE #1005 69.00 (fee
  2.07, net 66.93), DISPUTE_WITHDRAWAL #1002 −28.90 (fee 0.00, net −28.90),
  CHARGEBACK_FEE −25.00 (net −25.00; 25.00 is just this example's fee).
  Posted 21 Oct: spend money from 1010 to Shopify **Dr 6020 2.07 / Dr 6025
  28.90 ("Chargeback on #1002") / Dr 6020 25.00 ("Chargeback fee") / Cr
  1010 55.97** (no GST), and the transfer **Dr 1000 13.03 / Cr 1010 13.03**.
  1010 is back to **0.00** (69.00 − 55.97 − 13.03). INV-0002 (#1002) stays
  paid; sales and GST are unchanged.
- **SPC26** The dispute is won. Payout **70004**, issued
  2026-11-04T03:00Z, net **76.23**: DISPUTE_REVERSAL #1002 +28.90,
  CHARGEBACK_FEE_REFUND +25.00, CHARGE #1006 23.00 (fee 0.67, net 22.33).
  Posted 4 Nov: receive money into 1010 from Shopify **Dr 1010 53.90 / Cr
  6025 28.90 / Cr 6020 25.00**, spend money **Dr 6020 0.67 / Cr 1010
  0.67**, transfer **Dr 1000 76.23 / Cr 1010 76.23**. 1010: 23.00 + 53.90 −
  0.67 − 76.23 = **0.00**; 6025 is back to **0.00**. Had Shopify not
  refunded the fee, there'd be no 25.00 line and the net would be 51.23.
  Had the dispute been lost, nothing more comes: the 28.90 stays in 6025.
- **SPC27** An inquiry (no money taken) adds no transaction to a payout, so
  nothing is posted.
- **SPC28** Shopify holds back a reserve. Payout **70005**, issued
  2026-11-11T03:00Z, net **87.10**: CHARGE #1007 100.00 (fee 2.90, net
  97.10), RESERVED_FUNDS −10.00 (net −10.00). Posted 11 Nov: transfer **Dr
  1015 10.00 / Cr 1010 10.00** ("Shopify reserve held, payout 70005"), spend
  money **Dr 6020 2.90 / Cr 1010 2.90**, transfer **Dr 1000 87.10 / Cr 1010
  87.10**. 1010 is **0.00**; 1015 shows **10.00** held.
- **SPC29** The reserve is released. Payout **70006**, issued
  2027-03-11T03:00Z, net **54.62**: RESERVED_FUNDS_REVERSAL +10.00, CHARGE
  #1010 46.00 (fee 1.38, net 44.62). Posted 11 Mar: transfer **Dr 1010
  10.00 / Cr 1015 10.00**, spend money **Dr 6020 1.38 / Cr 1010 1.38**,
  transfer **Dr 1000 54.62 / Cr 1010 54.62**. 1010 and 1015 are both
  **0.00**. The bank line "+54.62 SHOPIFY PAYOUT" matches the transfer.
- **SPC30** No accounts chosen: payout 70003 in an organisation without a
  chargebacks account posts nothing and logs "Choose a chargebacks account
  in the Shopify settings." Choosing 6025 and syncing again posts SPC25 once.
- **SPC31** Still refused, logged, nothing posted: CHARGEBACK_HOLD,
  CHARGEBACK_HOLD_RELEASE, RESERVED_FUNDS_WITHDRAWAL and every other type
  not above (Shopify doesn't say what they do); a DISPUTE_WITHDRAWAL or
  RESERVED_FUNDS that's positive, or a DISPUTE_REVERSAL or
  RESERVED_FUNDS_REVERSAL that's negative; a payout whose transactions don't
  add up to its net. The log names the type and amount.

Built (decisions 447-450, tenant migration 0104). Tests:
`tests/unit/sales-platform-orders.test.ts` and
`tests/integration/sales-platform-orders.test.ts` (SPC25-SPC31). 6025 is
used because 6030 is Cleaning in the default chart.

**Questions for Jess (chargebacks and reserves)**, answered 5 Oct 2026:
examples approved; GST on a lost chargeback: Jess is checking with IRD
(Tohyee leaves GST alone meanwhile); build now and check a real payout
later; chargeback holds stay refused. What was asked:

1. **GST on a lost chargeback:** Tohyee leaves the sale's GST as it was
   (the money went back to the cardholder, but the invoice stands). Whether
   GST can be claimed back (e.g. as a bad debt) is a tax question we won't
   guess; check with IRD or your accountant. Leave GST alone (proposed)?
2. **Check a real payout:** the type names and signs above are our reading
   of Shopify's names. Can someone look at one real chargeback and one
   reserve in Shopify's payout export and confirm the types and signs?
3. **Chargeback holds** (`CHARGEBACK_HOLD`, `CHARGEBACK_HOLD_RELEASE`):
   Shopify doesn't say what they are, so they stay refused (proposed)?

### WooCommerce orders into the accounts (item 7 part 2, examples not yet approved by Jess)

Jess, 5 Oct 2026: WooCommerce next; **each payment method is mapped to an
account** (as NetSuite maps a store's payment methods); orders paid later
by **bank transfer are invoiced at once and left owing**; **WooPayments**
goes through a clearing account and its deposits are reconciled by hand.
The rest follows the Shopify rules (SPC11-SPC24) wherever WooCommerce
works the same way. **None of this has been tried against a real store.**

What WooCommerce says (REST API v3,
[woocommerce.github.io/woocommerce-rest-api-docs](https://woocommerce.github.io/woocommerce-rest-api-docs/),
read 5 Oct 2026):

- **Connecting:** a key made in the store (WooCommerce › Settings ›
  Advanced › REST API) is a consumer key and secret, sent "as the username
  and ... password" with HTTP Basic Auth over **HTTPS**; plain HTTP needs
  OAuth 1.0a. Endpoints are under `/wp-json/wc/v3`. Lists are paged with
  `page` and `per_page`; `X-WP-Total` and `X-WP-TotalPages` give the count.
- **Orders:** `status` (pending, processing, on-hold, completed,
  cancelled, refunded, failed, trash), `currency`, `prices_include_tax`,
  `date_paid_gmt`, `payment_method` and `payment_method_title`,
  `customer_id` (0 for a guest), `billing` (with `email` and `country`),
  `line_items` (`sku`, `quantity`, `subtotal` before discounts, `total`
  after discounts, `total_tax`, and `taxes` by rate id), `shipping_lines`
  (`total`, `total_tax`), `fee_lines`, `coupon_lines`, `tax_lines`
  (`rate_id`, `rate_code`, `rate_percent`), `total` and `refunds`.
- **Refunds** (`/orders/{id}/refunds`): `amount`, `date_created_gmt`,
  `reason`, `line_items` (with negative quantities and totals) and
  `api_refund` (whether the payment method gave the money back).
- **Webhooks** carry `X-WC-Webhook-Topic` (e.g. `order.created`,
  `order.updated`), `X-WC-Webhook-ID`, `X-WC-Webhook-Delivery-ID` and
  `X-WC-Webhook-Signature`, a base64 HMAC-SHA256 of the body with the
  webhook's secret.
- **WooPayments** (WooCommerce's own card payments, available in New
  Zealand) pays deposits into the bank, but we found no documented API for
  them, so its deposits are reconciled by hand (WC6).

The rules (our choice where WooCommerce, NetSuite and Jess are silent):

- **Connecting** (admins): the store's address (must be `https://`), a
  consumer key and secret. Tohyee only reads; WooCommerce doesn't tell a
  key's permission to the API, so the screen asks for a **Read** key.
  Stored encrypted (TOHYEE_SECRET_KEY), never shown or logged. A webhook
  secret is made by Tohyee and the webhooks `order.created` and
  `order.updated` are added to the store; a catch-up sync runs every 15
  minutes as for Shopify.
- **Settings** as Shopify's (start date, sales and shipping accounts, tax
  rate → tax code, untaxed code, guest checkouts), plus **payment
  methods**: each `payment_method` the store uses (shown once an order
  has it) is mapped to a bank account the money is paid into, or to
  **"Left owing"** (bank transfer, cheque). An order with a method not
  mapped yet is logged and tried again at each sync until it is (WC8).
- **Customers** are matched by email as Shopify's (SPC1-SPC10 rules), or
  go to the guest contact (decision 317); **lines** use the item whose
  code is the line's SKU (a stock item moves stock, SPC17), else the sales
  account with the line's name.
- **A paid order** (`date_paid_gmt` set; status processing or completed)
  becomes an approved sales order and invoice dated the day paid (decision
  320), and a payment into the mapped account on that day. An order with a
  "Left owing" method (status on-hold) becomes an approved invoice on its
  order date with nothing paid; when the money arrives the bank feed's line
  is matched to the invoice (BK4). Tohyee never records a payment for a
  "Left owing" method.
- **Amounts:** each line's `total` (after discounts) and shipping's
  `total` are amounts **before tax**, with `total_tax` beside them, so the
  invoice's amounts are tax exclusive and its GST is WooCommerce's tax.
  The invoice must come to the order's `total` exactly, or nothing is
  posted and the log shows both amounts.
- **Refunds** become a credit note against the invoice; if the order was
  paid, the refund is paid out of the same account the payment went into;
  if it was left owing and is unpaid, the credit note reduces what's owed.
- **Cancelled** (or failed) before it's invoiced: the sales order is
  cancelled (SPC20). A "Left owing" invoice cancelled in WooCommerce with
  nothing paid against it is voided; with something paid, it's logged for
  you to deal with.
- **Refused rather than guessed** (logged, nothing posted): another
  currency, `fee_lines` (surcharges), gift cards, a refund whose lines
  don't add up to its amount, and anything SPC23 refuses.

Setup: Glimmers Ltd as SPC11 (GST registered, NZD). Store
`https://shop.glimmers.nz`, prices **include tax**, WooCommerce tax rate 1
"GST" 15% → **GST**. Accounts: **1050 Stripe** (the Stripe feed's account,
ST1), **1060 WooPayments clearing** (bank, NZD), 1000 Business bank
account, 4000 Sales for sales and shipping. Payment methods: `stripe` →
1050, `woocommerce_payments` → 1060, `bacs` (Direct bank transfer) → Left
owing. Start date 2026-10-01. Items CANDLE-L Large candle and MELT-VAN Wax
melts as SPC.

- **WC1** Connecting: `http://shop.glimmers.nz` is refused ("Use the
  store's https:// address"). With `https://`, key `ck_…` and secret
  `cs_…`, Tohyee reads one order to check the key (a 401 is refused: "The
  store didn't accept that key"), stores the key encrypted, adds the two
  webhooks and shows the payment methods found. The audit history says who
  connected.
- **WC2** Paid by card through Stripe: order **#2001**, processing, paid
  2026-10-02T01:30Z, Aroha Ngata, 2 × Large candle, line `total` 40.00,
  `total_tax` 6.00, order `total` 46.00, `payment_method` stripe. Invoice
  INV-0001 on 2 Oct: **Dr 1100 46.00 / Cr 4000 40.00 / Cr 2100 6.00**;
  payment into 1050: **Dr 1050 46.00 / Cr 1100 46.00**. The Stripe feed's
  line +46.00 on 1050 (ST3's way) is offered that payment as its exact
  match, and Stripe's fee line is coded as in ST3.
- **WC3** A coupon and shipping: order **#2002**, paid 3 Oct by stripe, 3 ×
  Wax melts with line `total` 19.13 after a coupon (tax 2.87),
  shipping `total` 6.00 (tax 0.90), order total **28.90**. Invoice lines
  Wax melts 19.13 GST and Shipping 6.00 GST: **Dr 1100 28.90 / Cr 4000
  25.13 / Cr 2100 3.77**; payment into 1050.
- **WC4** Direct bank transfer: order **#2003**, on-hold, created
  2026-10-04T02:00Z, `bacs`, 1 × Large candle total 20.00 tax 3.00 = 23.00,
  no `date_paid`. Invoice INV-0003 on 4 Oct for **23.00**, owing:
  **Dr 1100 23.00 / Cr 4000 20.00 / Cr 2100 3.00**, no payment. On 6 Oct
  the bank feed brings +23.00 "A NGATA 2003" into 1000 and it's matched to
  INV-0003 (BK4). WooCommerce then marks #2003 processing with
  `date_paid`: nothing more is posted.
- **WC5** A partial refund of WC2: refund 7001 on 2026-10-05T22:00Z,
  `amount` 23.00, 1 × Large candle (−20.00, tax −3.00). Credit note CN-0001
  on 6 Oct against INV-0001: **Dr 4000 20.00 / Dr 2100 3.00 / Cr 1100
  23.00**, refunded from 1050: **Dr 1100 23.00 / Cr 1050 23.00**. A refund
  whose lines come to 23.00 but `amount` 20.00 posts nothing; the log
  shows both.
- **WC6** WooPayments: order **#2004**, paid 7 Oct by
  `woocommerce_payments`, 46.00: invoice as WC2, payment into **1060**.
  WooPayments' deposit of **44.62** (46.00 less a 1.38 fee in this example) lands in 1000
  on 9 Oct; you reconcile the bank line as a transfer from 1060 (44.62) and
  code the 1.38 fee from 1060 to 6020 by hand. 1060 is then 0.00.
- **WC7** Cancelled: #2005 on-hold by `bacs` (23.00, INV-0005 owing) is
  cancelled in WooCommerce on 8 Oct with nothing paid: INV-0005 is voided
  (its journal reversed). Had 10.00 been matched to it, nothing changes
  and the log says "INV-0005 has payments; deal with it in Tohyee." #2006,
  pending then failed, is never posted.
- **WC8** Unmapped method: #2007 paid by `cod` (Cash on delivery), not
  mapped: nothing posted; logged "Choose where cod (Cash on delivery)
  payments go in the WooCommerce settings." Mapping cod to Left owing and
  syncing again posts it once, as WC4.
- **WC9** Webhooks: an `order.updated` delivery signed with the webhook
  secret for #2001 brings it in once; the same `X-WC-Webhook-Delivery-ID`
  again is "Already handled"; a wrong signature is refused (401) and
  nothing changes.
- **WC10** Refused: an order in AUD; an order with a `fee_lines` surcharge;
  an order whose lines, shipping and tax come to 46.00 but `total` is
  45.00. Each is logged with the reason and nothing is posted.

**Questions for Jess (WooCommerce)**

1. **Surcharges** (`fee_lines`, e.g. a card fee added at checkout): refuse
   for now (proposed), or post them to a chosen account?
2. **Cancelled bank-transfer orders:** void the unpaid invoice (proposed)?
3. **Products:** lines use the Tohyee item whose code is the SKU; there's
   no product or customer sync from WooCommerce like Shopify's stage 1
   (proposed for now). Is that enough?

## Custom fields on CRM records (examples not yet approved by Jess)

The owner asked (1 Oct 2026) for the CRM's records to carry many fields of
the organisation's own, the way Salesforce accounts do. They're the custom
fields above (CF1-CF10), extended:

- Two more kinds of record: **people** and **opportunities**, alongside
  contacts, documents and lines. Same types, required, defaults, show in
  list, archiving, options and history. A people field is always on people
  and an opportunity field on opportunities (there's nothing else to
  choose).
- A contact field can now be on **prospects** as well as customers and
  suppliers (any of the three). A contact uses the fields for each of its
  roles: a prospect-only company gets only prospect fields, a company that
  is a customer and a prospect gets both. Prospects only get the fields an
  admin deliberately turns on for prospects (Jess, 1 Oct 2026): the upgrade
  leaves existing contact fields where they were, so a customer field, even
  a required one, isn't shown on and doesn't block a prospect-only company
  until an admin ticks prospects for it. (Before this, prospects used the
  customer fields while Advanced reporting was on; values a prospect
  already has stay on it.)
- **Which switch** (decided by Jess, 1 Oct 2026): a field on prospects,
  people or opportunities is a CRM field, usable while the **CRM** is on
  even with Advanced reporting off. Fields on customers, suppliers,
  documents and lines keep their rule: only with **Advanced reporting** on,
  and with it off they behave exactly as before (not shown, not required,
  can't be set or changed). A contact field on both customers and prospects
  works on a company through whichever of its roles is switched on. Adding
  a field, or adding a place to an existing one, needs that place's switch
  on. Changing a field that's already somewhere (renaming, archiving,
  required, default, list column, section, moving it, its options, or
  taking it off a place) only needs one of the places it's on to be
  switched on, so an organisation with the CRM off can still change its
  customer fields.
- Up to 100 fields on contacts, documents and lines together (as before),
  and up to 100 more each on people and on opportunities.
- People and opportunity values follow the contact rules: checked by type,
  a required one needed whenever the record is saved (while the CRM is on),
  a new record starts with the defaults, leaving the values out keeps them,
  and they can be changed at any time (also after an opportunity has made
  its invoice), each change in the record's history. Archived fields and
  options stay on records that have them. With the CRM off a record keeps
  its values and can be saved with them, but can't be given new ones.
- Values never change an amount, account, tag, stage or GST box: an
  opportunity's values don't reach the pipeline totals or the invoice it
  makes, and nothing is posted.
- **Sections**: an admin can add named sections for contacts, documents,
  people and opportunities (not lines, whose fields sit on the line), up to
  20 per kind, each name unique for its kind ignoring case. Sections are
  renamed and moved up or down; an empty one can be removed, one with
  fields in it (even archived ones) can't. A field is in at most one
  section, of its own kind, and can be moved up or down among its section's
  fields. A record's page and form show the fields with no section first,
  then each section that has fields to show, in order, as a group that can
  be collapsed (open to start). Sections only group fields: they don't hide
  them from anyone (a section called "Admin only" is seen by everyone who
  can see the record).
- **Lists**: fields shown in lists are columns on the CRM's Companies list
  (contact fields for the roles that are switched on), its People list,
  and lines on the pipeline's cards (opportunity fields).

Setup: CRM on, Advanced reporting off; company Mānuka Vets (a prospect),
person Aroha Ngata at Mānuka Vets and the opportunity "Memorial paw prints
2027" for 2,400.00 (CRM2, CRM3). Sections: "Practice details" (contacts),
"Preferences" and "Personal" (people), "Marketing" (opportunities). Fields:
contact "Practice size" (whole number, on prospects, shown in lists,
Practice details); contact "Species seen" (multiple select: Dogs, Cats,
Horses; on prospects, Practice details); person "Preferred contact" (list:
Email, Phone, Text; required, default Email, shown in lists, Preferences);
person "Birthday" (date, Personal); opportunity "Lead source" (list:
Referral, Website, Expo; shown in lists, Marketing); opportunity "Discount
offered" (percent, Marketing); opportunity "Sample kit sent" (check box, no
section).

- **CRMF1** Which switch: with Advanced reporting off and the CRM on, the
  admin adds the seven fields and four sections. A contact field "Pet name"
  on customers is refused ("Advanced reporting is off, so a field can't be
  on customers."), and so is a document field on invoices. With the CRM
  off as well, a people field is refused ("The CRM is off, so a field can't
  be on people.") and so is a section for opportunities.
- **CRMF2** Set-up rules: "Lead source" can be on people as well as
  opportunities, but a second "lead source" on opportunities is refused
  ("There's already an opportunity field called lead source."); a people
  field can't be "used on" customers; a field's type and kind still can't
  change; a 101st opportunity field is refused while people can still have
  their own.
- **CRMF3** Prospects: Mānuka Vets saved with Practice size 12 and Species
  seen Dogs and Cats keeps them; "12.5" is refused ("Practice size: must
  be a whole number"). Changing Practice size to 14 is in its history (from
  12 to 14). Marking it a customer too keeps them. With Advanced reporting
  on, a contact field on customers only ("Pet name") can't be given to a
  prospect-only company ("Pet name isn't used on prospects."), and a
  supplier-only contact can't be given Practice size. The upgrade leaves
  existing contact fields where they were: one on customers is still only
  on customers after it, and one on suppliers only on suppliers.
- **CRMF4** People: Aroha starts with Preferred contact = Email (the
  default); clearing it is refused ("Preferred contact is required.");
  "2026-02-30" for Birthday is refused; changing Preferred contact from
  Email to Phone is in her history (from Email to Phone); saving a new job
  title without sending the values keeps them.
- **CRMF5** Opportunities: the opportunity with Lead source Referral,
  Discount offered 10 and Sample kit sent ticked still has amount
  **2,400.00** and the New column's total is still **2,400.00**; "101" for
  Discount offered is refused. Marking it Won and making the invoice gives
  exactly the CRM5 invoice: one line "Memorial paw prints 2027" 1 ×
  2,400.00 to 4000 with GST, total **2,760.00**, and no custom values on
  the invoice or its line. After that Lead source can still be changed to
  Expo (in its history), and the stage still can't change.
- **CRMF6** Sections: moving "Personal" up puts it before "Preferences";
  a second "preferences" for people is refused ("There's already a section
  called preferences for people.") but "Preferences" for opportunities is
  fine; a section for lines is refused; Lead source can't go in
  "Preferences" ("Preferences is a section for people, not
  opportunities."); "Marketing" can't be removed while it has fields ("Move
  Marketing's fields out first.") but an empty section can be; a 21st
  section for people is refused. Moving Discount offered up puts it before
  Lead source. The opportunity form shows Sample kit sent (no section)
  first, then Marketing with Discount offered and Lead source.
- **CRMF7** Lists: the Companies list gives Mānuka Vets' values, with
  Practice size as a column and Species seen not (it isn't shown in
  lists); the People list has a Preferred contact column (Aroha: Phone);
  the pipeline card shows Lead source.
- **CRMF8** Switching off: with the CRM off and Advanced reporting on,
  Aroha (a contact person) can still be saved with her values, but giving
  her a new Birthday is refused ("the CRM is off, so Birthday can't be
  set.") and Preferred contact isn't required; Mānuka Vets keeps Practice
  size and can be saved with it, but not given a new one. With the CRM on
  and Advanced reporting off, a company that is a customer and a prospect
  can be given Practice size but not a new "Pet name" (customers only:
  "advanced reporting is off, so Pet name can't be set.").
- **CRMF9** Over HTTP: a viewer reads the setup, the company page and
  the people and pipeline lists with their values, but can't change a
  person's values (403); a bookkeeper can; adding a field or section is for
  admins only (403 for a bookkeeper, 201 for an admin).
- **CRMF10** Older customer fields with the CRM off: with Advanced
  reporting on and the CRM off, the admin has a contact field "Channel"
  (text, on customers) and a list "Region" (North, South; on customers and
  suppliers), as an organisation would have from before the CRM. They can
  rename Channel to "Sales channel", make it required, archive and restore
  it, add an option "Islands" to Region and rename "South" to "South
  Island". Adding prospects to Sales channel is refused ("The CRM is off,
  so a field can't be on prospects."). Practice size (on prospects only)
  can't be changed ("The CRM is off. Turn it on in Settings › Modules
  first."). With Advanced reporting off as well, Sales channel can't be
  changed either ("Advanced reporting is off. Turn it on in Settings ›
  Modules first.").
- **CRMF11** A required customer field doesn't block prospects: with both
  switches on, "Account manager" (text, on customers, required). Mānuka
  Vets (a prospect only) is saved with its Practice size and no Account
  manager, and a new prospect "Rata Clinic" is made with no values; the
  fields for a prospect are Practice size and Species seen only. Marking
  Mānuka Vets a customer too without one is refused ("Account manager is
  required."); with Account manager "Hemi" it's saved. With Advanced
  reporting off, a new customer "Tui Kennels" is saved without one, as
  before (not required, not shown), and a customer and prospect is saved
  without one too.
- **CRMF12** Turning a field on for prospects: the admin ticks prospects
  on Account manager. Now it's one of the fields for a prospect (after
  Practice size and Species seen), it's required there: saving Rata Clinic
  without one is refused ("Account manager is required."), and with
  "Hemi" it's saved and kept. With Advanced reporting off, it still shows
  and is required on prospects (its prospect use needs only the CRM), but
  not on a customer-only contact.

## CRM record types and page layouts (examples not yet approved by Jess)

Jess asked (1 Oct 2026) for different kinds of company, person and
opportunity to show and need different fields, and for a record page like a
Salesforce account page. This follows Salesforce **record types** and **page
layouts** (one layout per record type, which NetSuite calls a **custom
form**), and Salesforce's Lightning record page for the page itself:

- **Record types**: an admin can define several for companies (contacts in
  the CRM), people and opportunities, e.g. "Standard" and "Funding body".
  Each record has exactly one. One type per kind is the **default**: new
  records get it unless another is chosen. Names are 1-60 characters,
  unique for their kind ignoring case, with an optional description. Types
  are never deleted: an archived type stays on its records (and they can
  still be saved) but can't be given to another record; the default can't
  be archived. A new type starts as a copy of another type's layout (the
  default's unless one is chosen), as Salesforce clones a layout.
- **Page layouts**: each type has one layout: named sections (up to 20,
  each name unique on the layout ignoring case) in order, each with fields
  in order. A field is a standard field of that kind of record or one of
  its custom fields (CF1-CF10, CRMF1-CRMF12), at most once on the layout.
  Each field on a layout can be **required** or **read-only** on that type
  (not both, as Salesforce). Fields that every record of the kind needs
  (company name, person's first name, opportunity name and company) must
  stay on every layout, are always required and can't be read-only. Fields
  Tohyee fills in (created, last changed) are always read-only. A field
  that always has a value (opportunity amount and stage) or a check box
  can't be made required. Leaving a field off a layout only hides it on
  that type's record page: the values it already has are kept.
- **Required** fields on a record's type are needed whenever the record is
  saved, checked by the server on every save (the CRM, the Contacts screen,
  imports and the API), while the CRM is on. A custom field counts only
  where it applies, as before (a contact field only for the roles it's on
  and switched on: CRMF11). So does a company's delivery address: only
  customers have one, so it isn't required of (or shown on) a prospect or
  supplier. A required field on one type isn't required on another.
- **Read-only** fields on a record's type can be changed by admins and
  owners only (as Salesforce's "Edit Read Only Fields" permission, which
  its administrators have). For anyone else the server refuses a change to
  the field on a record of that type, including giving it a value (other
  than its default) on a new record. When a record's type changes, the
  fields read-only on either the old or the new type can't be changed in
  that same save.
- **Changing a record's type** (bookkeepers and above) needs the new type's
  required fields; nothing else changes, and the record keeps every value
  (including ones the new layout doesn't show). The change is in the
  record's history (from and to). Setting up types and layouts is for
  admins and owners only, and each change (with the layout before and
  after) is in the audit history.
- **New custom fields** for companies, people or opportunities join every
  layout of their kind (Salesforce's "add to page layouts"): at the end of
  the layout's section with the same name as the field's custom field
  section, or else at the end of the first section. An admin can then move
  or remove them per layout. Custom field sections (CRMF6) still group the
  fields on forms for new records elsewhere and in lists; on a CRM record
  page the layout decides.
- The upgrade gives every organisation a default type called "Standard"
  for each kind, and every existing company (every contact, as any contact
  can become a prospect), person and opportunity gets it.
- Record types and layouts are CRM features: with the CRM off they don't
  apply (nothing is required or read-only because of them) and can't be
  changed; records keep their type.
- Record types never change an amount, account, stage, invoice or GST box.

Standard fields:

| Kind | Standard fields (key) |
| --- | --- |
| Company | Company name (name, always required), Owner (ownerUserId), Email, Phone, GST number, Billing address (postalAddress), Delivery address, Created, Last changed |
| Person | First name (always required), Last name, Job title, Company (contactId), Email, Phone, Created, Last changed |
| Opportunity | Opportunity (name, always required), Company (contactId, always required), Point of contact, Owner, Amount (excl. GST), Expected close date, Stage, Created, Last changed |

The record page (companies, and the same page for people and
opportunities) follows Salesforce's Lightning record page: a header with
the record's name, its type, its owner (a company's owner or an
opportunity's owner; a person's company) and key fields (email and phone;
amount, stage and expected close date); a **Details** tab with the layout's
sections, each collapsible, every field with a pencil to change just that
field (bookkeepers and above; read-only fields only for admins and
owners); a **Related** tab with lists, each with its count and "View all";
and an **Activity** panel to the right: quick add (log a call, a meeting, a
note, a new task), then **Upcoming and overdue** (open tasks by due date,
overdue first), then past activity grouped by month, newest first (the
CRM10 timeline). On a phone the tabs stack and the activity panel comes
below them.

Setup: CRM on, Advanced reporting off; company Mānuka Vets (a prospect),
person Aroha Ngata at Mānuka Vets and the opportunity "Memorial paw prints
2027" for 2,400.00 (CRM2, CRM3). Contact fields on prospects: "Funder
reference" (text, no section) and "Grant round" (list: 2026 Round 1, 2026
Round 2; no section).

- **CRT1** Upgrade: the organisation has one record type "Standard" for
  each of companies, people and opportunities, each the default, and every
  existing contact (customers and suppliers too), person and opportunity
  has it. Standard's company layout is "Company information" (Company name
  required, Owner, Email, Phone, GST number, then the contact custom fields
  with no section, in their order), "Address information" (Billing address,
  Delivery address), then one section per contact custom field section with
  its fields, then "System information" (Created, Last changed). People
  and opportunities get "Person information" and "Opportunity information"
  sections with their standard fields and their custom fields the same
  way, then "System information". A new company, person or opportunity
  gets Standard.
- **CRT2** Set-up rules: the admin adds the company type "Funding body"
  (copied from Standard's layout). A second "funding body" for companies is
  refused ("There's already a company record type called funding body."),
  but "Funding body" for opportunities is fine. A bookkeeper can't add or
  change a type (403); a viewer can read them. Making Funding body the
  default makes Standard not the default (one default per kind); making
  Standard the default again, then archiving the default is refused
  ("Standard is the default, so it can't be archived."). Each change is in
  the audit history.
- **CRT3** Layout rules: Company name can't be taken off ("Company name
  must stay on the layout.") or made read-only ("Company name can't be
  read-only."); Phone twice is refused ("Phone is on the layout more than
  once."); a people field "Preferred contact" on a company layout is
  refused ("Preferred contact isn't a company field."); Phone required and
  read-only is refused ("Phone can't be both required and read-only.");
  Created can't be required ("Created is filled in by Tohyee, so it can't be
  required."), and neither can a check box or Amount; two sections called
  "Grants" and "grants" are refused; a 21st section is refused.
- **CRT4** A field required on one type but not another: Funding body's
  layout makes Phone and Funder reference required. Mānuka Vets (Standard)
  is still saved without either. A new prospect "Lottery Grants Board" as
  a Funding body without them is refused ("Phone is required on Funding
  body companies."), with Phone 04 123 4567 but no Funder reference refused
  ("Funder reference is required on Funding body companies."), and with
  Funder reference "LGB-2026" too it's saved. Saving it again later without
  Phone is refused; the same request to the API is refused the same way.
  With Delivery address required on Standard, Mānuka Vets (a prospect) and
  a new supplier are still saved without one, but a new customer isn't
  ("Delivery address is required on Standard companies."), and nor is
  marking Mānuka Vets a customer until it's given one.
- **CRT5** Changing a record's type: changing Mānuka Vets to Funding body
  is refused ("Phone is required on Funding body companies."); with Phone
  09 555 0101 and Funder reference "MV-1" in the same save it's saved, and
  its history says the record type changed from Standard to Funding body
  (and Phone and Funder reference from nothing to their values). Changing
  it back to Standard keeps both values. An archived company type "Old
  grants" can't be chosen ("Old grants is archived, so it can't be
  chosen."), but a company already of that type can still be saved. A
  person type can't be given to a company ("That record type isn't for
  companies."). A viewer can't change a type (403).
- **CRT6** A read-only field: on Funding body, Grant round is read-only. A
  bookkeeper changing Lottery Grants Board's Grant round to "2026 Round 2"
  is refused (403: "Grant round is read-only on Funding body companies.
  Ask an admin to change it."), and so is a bookkeeper making a new Funding
  body company with a Grant round; an admin can change it (in its
  history). On Mānuka Vets (Standard, where Grant round isn't read-only) a
  bookkeeper can set it. A bookkeeper can't change Lottery Grants Board to
  Standard and its Grant round in the same save.
- **CRT7** A viewer can't edit inline: a viewer sees Mānuka Vets' record
  page (header, details, related lists, activity) with no pencils, no quick
  add and no type change, and a change sent anyway (a field, its type or
  its owner) is refused (403). A bookkeeper sees a pencil on every field
  except Created and Last changed and, on Funding body companies, Grant
  round; an admin also on Grant round.
- **CRT8** Inline edit: a bookkeeper changes only Mānuka Vets' Phone from
  its page; nothing else changes and the history says Phone changed. The
  owner is set to a member (Aroha Ngata's colleague, a bookkeeper) and is
  in the history; an owner who isn't a member is refused ("The owner must
  be a member of the organisation.").
- **CRT9** New custom fields join the layouts: the admin has a contact
  custom field section "Practice details" and adds a "Practice details"
  section to Funding body's layout (not Standard's). Adding "Board meeting"
  (date, on prospects, in the Practice details custom field section) puts
  it at the end of Funding body's Practice details section and at the end
  of Standard's first section (Company information). "Website" (url, on
  prospects, no section) goes at the end of the first section of both.
  Taking Website off Funding body's layout keeps the values companies
  already have.
- **CRT10** Opportunities: an opportunity type "Grant application" whose
  layout makes Expected close date required. A new "Community grant 2027"
  for 5,000.00 at Lottery Grants Board without a close date is refused
  ("Expected close date is required on Grant application opportunities."),
  and with 2027-03-31 it's saved. "Memorial paw prints 2027" (Standard)
  is still saved without one. The New column totals **7,400.00**
  (2,400.00 + 5,000.00); changing Community grant's type to Standard changes
  neither its amount nor its stage. Making the invoice from Memorial paw
  prints gives exactly the CRM5 invoice (total **2,760.00**).
- **CRT11** Record page: after CRM5 (Memorial paw prints won and invoiced
  2,760.00), a call logged in September 2026 and an open task "Send
  sample" due yesterday plus one due next week, Mānuka Vets' page has the
  header (Mānuka Vets, Standard, its owner, email and phone) and the
  Standard layout's sections; Related: People 1 (Aroha Ngata),
  Opportunities 1, Tasks 2, Invoices 1 (2,760.00), Credit notes 0, Notes
  and Files with their counts; Activity: Upcoming and overdue lists "Send
  sample" (overdue) before the one due next week, then October 2026 (the
  invoice for 2,760.00 and the stage change to Won) before September 2026
  (the call). Aroha's and the opportunity's pages show their own type,
  layout, related lists (her opportunities and tasks; the opportunity's
  tasks and invoice) and activity.
- **CRT12** CRM off: with the CRM off, Lottery Grants Board (Funding body)
  is saved from the Contacts screen without Phone, a bookkeeper can change
  its Grant round, and it keeps its type; record types can't be added or
  changed ("The CRM is off. An admin can turn it on in Settings."), and
  neither can a record's type.
- **CRT13** Over HTTP: every record type route needs a signed-in member: a
  viewer reads the types and the record pages of companies, people and
  opportunities (200), a bookkeeper changes a record's fields and type
  (200) but not the set-up (403), an admin changes the set-up (201, 200).
  Old URLs still work: /operations/crm/companies/5 opens /crm/companies/5,
  and the new pages are /crm/people/{id} and /crm/opportunities/{id}.

## Opportunity stages, probability and forecasts (examples not yet approved by Jess)

Jess wants a Salesforce-level CRM (2 Oct 2026). This follows Salesforce's
opportunity **Stage** picklist (each stage has a type, a probability and a
forecast category), **sales processes** (which stages a record type uses),
the opportunity's **Probability** and **Forecast Category** fields, the
**Stage History** related list and **Collaborative Forecasts** with
cumulative rollups and quotas. Decisions 76-90 in `docs/DECISIONS.md` give
the sources.

- **Stages** are the organisation's own list, in order. Each has a name
  (1-40 characters, unique ignoring case), a **type** (Open, Closed won or
  Closed lost), a default **probability** (a whole number of per cent,
  0-100) and a **forecast category** (Pipeline, Best case, Commit, Closed or
  Omitted). A Closed won stage is always 100% and Closed; a Closed lost
  stage is always 0% and Omitted; an Open stage is never Closed. Each stage
  also has a fixed **key** (like Salesforce's API name) that the API uses;
  renaming a stage doesn't change it. Setting up stages is for admins and
  owners; everyone can read them.
- Stages are **archived, never deleted**. An archived stage keeps its
  opportunities (they can still be saved) but can't be chosen for another
  one. At least one active Open, one active Closed won and one active
  Closed lost stage must stay. A stage's type can't change while any
  opportunity is in it.
- A **won opportunity** is one in a Closed won stage, whatever it's called:
  that's what can make the invoice (CRM5) and what "open" means everywhere
  (Home, the company list's open pipeline, the record page).
- **Sales processes**: an opportunity record type (CRT10) can use a chosen
  list of stages, with at least one of each type; a type without a list
  uses every active stage. A new opportunity starts in the first active
  Open stage of its type's process.
- An opportunity's **probability** and **forecast category** start as its
  stage's. Moving it to another stage sets both to the new stage's, unless
  they're sent in the same save. They can be changed without changing the
  stage (bookkeepers and above), within the stage type's rules. The
  **weighted amount** is amount × probability, rounded half up to the
  currency's smallest unit.
- **Stage history** (Salesforce's Stage History): a row each time the
  stage, amount, probability, forecast category or expected close date
  changes, with who and when, newest first.
- **Forecasts**: opportunities with an expected close date in each month or
  quarter (quarters of the organisation's financial year), per owner and
  per currency (never added across currencies, MC68), with Salesforce's
  cumulative totals:
  - **Closed** = Closed
  - **Commit** = Commit + Closed
  - **Best case** = Best case + Commit + Closed
  - **Open pipeline** = Pipeline + Best case + Commit (open opportunities)
  - **Weighted pipeline** = the weighted amounts of open opportunities not
    Omitted, each rounded first, then added.

  Omitted opportunities (including all lost ones) are in none of them.
  Opportunities without an expected close date are left out and counted.
  Each figure opens the list of opportunities it's made of. Forecasts are
  read-only: they're worked out from the opportunities and change nothing.
- **Quotas**: an admin can set a quota per owner per month, in the base
  currency. A quarter's quota is its months' quotas added. **Attainment** is
  Closed (base currency) ÷ quota, as a percentage to 2 decimal places,
  rounded half up.

Starting stages (the upgrade):

| Key | Stage | Type | Probability | Forecast category |
| --- | --- | --- | --- | --- |
| new | New | Open | 10% | Pipeline |
| screening | Screening | Open | 20% | Pipeline |
| meeting | Meeting | Open | 50% | Pipeline |
| proposal | Proposal | Open | 75% | Pipeline |
| won | Won | Closed won | 100% | Closed |
| lost | Lost | Closed lost | 0% | Omitted |

Setup for CRMS2-CRMS7: as CRT (Mānuka Vets, Aroha Ngata, "Memorial paw
prints 2027" for 2,400.00 closing 2026-12-15, owner Jess, NZD base).

- **CRMS1** Upgrade: before it, the organisation has "Clinic display"
  (Proposal, 600.00), "Menu reprint" (Won, 500.00) and "Old prints" (Lost,
  200.00), and "Clinic display" was moved New → Proposal. Afterwards there
  are the six stages above; Clinic display is 75% Pipeline (weighted
  450.00), Menu reprint 100% Closed (weighted 500.00), Old prints 0%
  Omitted, and the opportunities list in the stages' order. Clinic display's
  stage history shows the move to Proposal (by whoever did it, then) with
  no probability (it wasn't kept). A stage that doesn't exist ("nonsense")
  is refused by the database ("There's no stage called nonsense"). A new
  opportunity starts in New at 10%
  Pipeline.
- **CRMS2** Set-up rules: the admin adds "Negotiation" (Open, 90%, Commit)
  and moves it up to sit between Proposal and Won. "proposal" is refused
  ("There's already a stage called proposal."), as are 101% ("The
  probability must be a whole number from 0 to 100."), 12.5%, an Open stage
  in Closed ("Only a Closed won stage can be in the Closed forecast
  category."), a Closed won stage at 90% ("A Closed won stage is 100%
  and in the Closed forecast category.") and a Closed lost stage in
  Pipeline ("A Closed lost stage is 0% and in the Omitted forecast
  category."). Its key is "negotiation"; renaming it "Negotiation/review"
  keeps the key. A bookkeeper can't add or change a stage (403); a viewer
  can read them. Each change is in the audit history.
- **CRMS3** Archiving and types: with Memorial paw prints in Screening,
  archiving Screening works; Memorial paw prints stays in Screening and can
  still be saved (its amount changed to 2,500.00), but another opportunity
  can't be moved there ("Screening is archived, so it can't be chosen.").
  Archiving Lost, the only Closed lost stage, is refused ("Lost is the only
  active Closed lost stage. Add or restore another first."), and so is
  changing Won's type to Open. Changing Screening's type to Closed lost is
  refused while Memorial paw prints is in it ("Screening has
  opportunities, so its type can't change."); Proposal (empty) can change
  type. Restoring Screening works. Stages can't be deleted (the database
  refuses).
- **CRMS4** The invoice follows the stage's type: Won renamed "Closed won"
  still makes the CRM5 invoice (total **2,760.00**) when Memorial paw
  prints is in it. A second Closed won stage "Won – renewal" makes one too
  (a 1,000.00 opportunity: total **1,150.00**). An opportunity in Lost or
  any Open stage can't ("Only a won opportunity can make an invoice.").
  Once invoiced, its stage can't change, and the database refuses an
  invoiced opportunity in a stage that isn't Closed won.
- **CRMS5** Probability and forecast category: Memorial paw prints (New) is
  10% Pipeline, weighted **240.00**. Moved to Proposal: 75% Pipeline,
  **1,800.00**. Changed to 80% and Commit without moving: **1,920.00**.
  Moved to Negotiation: 90% Commit (the stage's), **2,160.00**; moved back
  to Proposal with 70% in the same save: 70% Pipeline, **1,680.00**. An
  Open opportunity can be Omitted but not Closed ("Only a won opportunity
  can be in the Closed forecast category."); 101% is refused. Moved to Won
  it's 100% Closed (**2,400.00**), and 90% or Commit on a won one are
  refused ("A won opportunity is 100% and in the Closed forecast
  category."); Lost makes it 0% Omitted (**0.00**). Rounding: "Window
  decals" for 333.33 at 15% is 49.9995, weighted **50.00**. A viewer can't
  change them (403).
- **CRMS6** Stage history: Memorial paw prints is added (New, 10%,
  Pipeline, 2,400.00, 2026-12-15), moved to Proposal (75%), changed to 80%
  Commit, renamed "Memorial paw prints 2027/28" (no row), changed to
  2,600.00 (weighted 2,080.00) and its close date to 2027-01-15. Its stage
  history has five rows, newest first: 2027-01-15 / 2,600.00 / 80% /
  Commit / Proposal; 2026-12-15 / 2,600.00 / 80% / Commit / Proposal;
  2026-12-15 / 2,400.00 / 80% / Commit / Proposal; 2026-12-15 / 2,400.00 /
  75% / Pipeline / Proposal; 2026-12-15 / 2,400.00 / 10% / Pipeline / New,
  each with Jess's email and when. A viewer can read it.
- **CRMS7** Sales processes: the opportunity type "Grant application"
  uses New, Proposal, Won and Lost. A new Grant application opportunity
  starts in New; moving it to Meeting is refused ("Meeting isn't in the
  Grant application sales process."); Proposal is fine. A process without a
  Closed lost stage is refused ("A sales process needs at least one Open,
  one Closed won and one Closed lost stage."), as is an unknown stage.
  Changing Memorial paw prints (Standard, in Meeting) to Grant application
  is refused for the same reason, and works moved to Proposal in the same
  save. Taking the list off (Standard behaviour: every stage) works. Only
  admins set processes (403 for a bookkeeper); each change is in the
  history. The pipeline board shows the active stages in their order, and
  an archived stage only while it has opportunities.
- **CRMS8** Forecast by month and owner, from 1 Oct 2026 for three months.
  Jess owns, closing in October: "Clinic display" 600.00 (Won), "Memorial
  paw prints 2027" 2,400.00 (Negotiation, 90%, Commit), "Kennel cards"
  900.00 (Proposal, 75%, changed to Best case), "Brochure" 1,000.00
  (Meeting, 50%, Pipeline), "Old prints" 500.00 (Lost), "Sponsorship"
  300.00 (Screening, 20%, changed to Omitted), and Acme Inc's "Logo licence"
  USD 100.00 (Proposal, 75%, changed to Commit); in November "Christmas
  cards" 1,500.00 (Proposal, 75%, Pipeline); and "Website" 700.00 (New, no
  close date). Ben owns, in October, "Menu reprint" 1,250.00 (Won) and
  "Window decals" 333.33 (New, changed to 15%). "September deal" closes
  2026-09-30. The forecast:

  | Month | Owner | Currency | Closed | Commit | Best case | Open pipeline | Weighted |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | Oct 2026 | Ben | NZD | 1,250.00 | 1,250.00 | 1,250.00 | 333.33 | 50.00 |
  | Oct 2026 | Jess | NZD | 600.00 | 3,000.00 | 3,900.00 | 4,300.00 | 3,335.00 |
  | Oct 2026 | Jess | USD | 0.00 | 100.00 | 100.00 | 100.00 | 75.00 |
  | Nov 2026 | Jess | NZD | 0.00 | 0.00 | 0.00 | 1,500.00 | 1,125.00 |

  October's NZD total is Closed **1,850.00**, Commit **4,250.00**, Best case
  **5,150.00**, Open pipeline **4,633.33**, Weighted **3,385.00**; USD is
  totalled on its own (**100.00** Commit). December has nothing. "Website"
  is counted as 1 opportunity with no close date; "September deal" isn't in
  the range. Asking for Ben only gives his row.
- **CRMS9** By quarter and drill-down: with a 31 March year end, Oct-Dec
  2026 is a quarter; Jess's NZD row for it is Closed 600.00, Commit
  3,000.00, Best case 3,900.00, Open pipeline **5,800.00**, Weighted
  **4,460.00**. Drilling into Jess's October NZD Best case lists Clinic
  display, Kennel cards and Memorial paw prints 2027; her Open pipeline
  lists Brochure, Kennel cards and Memorial paw prints 2027; her Closed
  lists Clinic display; her Weighted lists Brochure (500.00), Kennel cards
  (675.00) and Memorial paw prints 2027 (2,160.00). With a 30 June year end
  the quarter containing October is Oct-Dec too, and with a 31 May year
  end it's Sep-Nov.
- **CRMS10** Quotas: the admin sets Jess 5,000.00 for October and November
  and Ben 1,000.00 for October. Jess's October attainment is **12.00%**,
  November **0.00%**, Ben's October **125.00%**; December has no quota (no
  attainment). By quarter, Jess's quota is **10,000.00** (**6.00%**) and
  Ben's **1,000.00** (**125.00%**). A negative quota, a quota for someone
  who isn't a member, or a month given as 2026-10-15 is refused; a
  bookkeeper can't set one (403). Clearing Jess's November quota removes
  it. Each change is in the history.
- **CRMS11** Over HTTP and with the CRM off: every stage, sales process,
  forecast and quota route needs a signed-in member (401 without, 404 for
  someone outside the organisation, as for other organisation routes): a viewer reads stages and forecasts
  (200), a bookkeeper changes an opportunity's probability (200) but not
  stages or quotas (403), an admin adds and changes stages (201, 200) and
  sets quotas (200). With the CRM off, stages, processes and quotas can't
  be changed ("The CRM is off. An admin can turn it on in Settings.").

### Questions for Jess (stages and forecasts), decided

Decided on 2 Oct 2026: decisions 323-325. What was asked is kept below.

- Are the starting probabilities (New 10%, Screening 20%, Meeting 50%,
  Proposal 75%) right for you, and should any start in Best case or
  Commit rather than Pipeline?
- Salesforce converts every currency into one forecast currency. Tohyee
  keeps currencies apart (MC68). Do you want forecasts converted to NZD
  too (at which rate: today's, or the rate on the close date)?
- Quotas are in NZD and only NZD Closed counts toward them. Should foreign
  currency won work count (converted), and do you want quotas per quarter
  as well as per month?
- Salesforce lets managers adjust their team's forecast figures and
  forecasts roll up a role hierarchy. Do you want teams/managers and
  adjustments (a later stage), or is per-owner enough?

## Notes, files and history

Journals, sales invoices, bills, sales credit notes, supplier credit notes and
contacts each have **notes**, **files** and a **history**. None of them posts
anything or changes a document's figures, so they work on drafts, approved
and voided documents, and in locked periods. Decided with Jess (28 Sep 2026):

- **Files are stored in the organisation's own database**, so a backup of that
  database includes them. Allowed: PDF, JPG, PNG, HEIC, Word (.doc, .docx),
  Excel (.xls, .xlsx) and CSV, **10 MB** each at most, up to 100 files per
  record. The type is checked from the file's contents as well as its name: a
  file named `receipt.pdf` that isn't a PDF is refused.
- **Notes can be edited or deleted** by the person who wrote them or an admin
  (or owner), and the history keeps what they said before.
- Viewers can read notes, download files and see the history. Bookkeepers and
  above can add notes and files. A file can be removed by the person who added
  it or an admin: its contents are deleted from the database (so a file added
  by mistake is really gone), but the history keeps its name, size, who added
  it and who removed it.
- The **history** lists, oldest first, who did what and when: the record's own
  events (created, edited, approved, voided...), events on things attached to
  it (payments, credit applied, refunds), and notes and files added, edited or
  removed.

Examples use INV-0001 (I1, a draft then approved), with Jess as a bookkeeper,
Ana as an admin and Vic as a viewer.

- **NF1** Jess adds the note "Customer asked for 14-day terms" to INV-0001.
  It shows with her email and the time. The history has "Note added" by Jess.
  Nothing is posted; the invoice's total and status don't change.
- **NF2** Retrying NF1 with the same idempotency key returns the same note
  (no second note); the same key with different text is refused.
- **NF3** A note must have 1-5,000 characters after trimming spaces; an
  empty note or one of 5,001 characters is refused.
- **NF4** Jess edits her note to "Customer asked for 20-day terms". The note
  shows the new text and "edited". The history has "Note edited" with the old
  and new text. Editing with an out-of-date version (someone changed it in
  the meantime) is refused: "This note was changed by someone else. Reload
  and try again."
- **NF5** Ana (admin) can edit or delete Jess's note. Another bookkeeper
  can't ("Only the person who wrote a note, or an admin, can change it"). Vic
  (viewer) can read notes but can't add, edit or delete them.
- **NF6** Deleting the note removes it from the notes list; the history keeps
  "Note deleted" with the text it had.
- **NF7** Jess attaches `receipt.pdf` (a real PDF, 250 KB) to bill B1. It
  lists with its name, type, size, who added it and when, and downloads as
  the same bytes. The history has "File added: receipt.pdf".
- **NF8** Refused: an 11 MB PDF ("Files can be at most 10 MB"); an empty file;
  `notes.txt` and `setup.exe` (type not allowed); `photo.png` whose contents
  are a PDF ("doesn't look like a PNG"). A record with 100 files refuses the
  101st.
- **NF9** Retrying NF7 with the same idempotency key returns the same file;
  the same key with a different file is refused.
- **NF10** Jess removes `receipt.pdf`. It's gone from the list and can't be
  downloaded; the history keeps "File removed: receipt.pdf (250 KB)" by Jess.
  Another bookkeeper can't remove a file Jess added; Ana can.
- **NF11** INV-0001's history, after it's approved, paid 50.00, credited
  23.00 from CN-0001, and given NF1's note, lists: invoice
  created, invoice approved, payment recorded 50.00, credit applied 23.00,
  note added, in the order they happened, each with who did it.
- **NF12** Deleting a draft invoice, bill, credit note or supplier credit note
  deletes its notes and its files' contents too.
- **NF13** Contacts and journals work the same way: a note on contact Kobe
  Ltd, and a file on journal #1 (e.g. the signed board minute behind it).
- **NF14** A note or file for a record that doesn't exist (e.g. invoice
  999999) is refused as not found, and an unknown record type is refused.

## Aged payables (examples not yet approved by Jess)

Written overnight from Xero's aged payables and NZ practice, as the mirror of
aged receivables (RC9-RC11); Jess hasn't approved them yet. What the
organisation owes each supplier as at a date: each approved bill's amount
due (its total less supplier payments and supplier credit applied on or
before the date, not voided or removed by then), put in a bucket by days
past its **due date** (current, 1-30, 31-60, 61-90, over 90; a bill due on
the date is current), less supplier credit notes not yet applied or
refunded. Bills dated after the date, or voided on or before it, don't
count. Supplier overpayments and prepayments aren't built, so supplier
credit notes are the only credit. The total equals accounts payable (2000)
on the balance sheet at the date; the report shows the ledger balance
beside it and any difference. Viewers can see it. Suppliers have no parents,
so there's no roll-up.

Setup: GST 15%. Paw Supplies: bill PS-101, 200.00 + GST = **230.00**, dated
1 Mar 2026, due 31 Mar, with **30.00** paid on 10 Apr. Kiwi Freight: bill
KF-1, 300.00 + GST = **345.00**, dated 1 May, due 15 May; bill KF-2,
100.00 + GST = 115.00, dated 1 May, due 15 May, voided 10 May; supplier
credit note KF-CR1, 20.00 + GST = **23.00**, dated 1 Jun, not applied.
Rata Print: bill RP-1, 100.00 + GST = **115.00**, dated 20 Jun, due 20 Jul;
RP-2, 200.00 + GST = **230.00**, dated 21 Jul, due 20 Aug; RP-3 dated
5 Aug.

- **AGP1** As at **31 July 2026**: PS-101 **200.00** (122 days, over 90);
  KF-1 **345.00** (77 days, 61-90) and KF-CR1 credit **23.00**; RP-1
  **115.00** (11 days, 1-30); RP-2 **230.00** (current). KF-2 (voided) and
  RP-3 (dated later) don't count. Totals: current **230.00**, 1-30
  **115.00**, 31-60 **0.00**, 61-90 **345.00**, over 90 **200.00**, credit
  **23.00**, total **867.00**, the same as account 2000 on the balance sheet
  at 31 July 2026 (difference **0.00**). Rows by name: Kiwi Freight
  **322.00**, Paw Supplies **200.00**, Rata Print **345.00**; each opens to
  its bills and credit.
- **AGP2** As at **30 June 2026**: RP-1 is current (**115.00**), KF-1 is 46
  days overdue (31-60, **345.00**), PS-101 91 days (over 90, **200.00**),
  credit **23.00**, total **637.00** (= 2000 at 30 June).
- **AGP3** Later changes don't rewrite an earlier date: KF-CR1's 23.00
  applied to KF-1 on 5 Aug leaves Kiwi Freight at **322.00** as at 31 July
  (345.00 due, 23.00 credit) and at 5 Aug (**322.00** due, no credit).
  Voiding PS-101's payment on 10 Aug leaves Paw Supplies at **200.00** as
  at 31 July; as at 10 Aug it's **230.00**.

### Not supported yet (refused rather than guessed)

- Ageing by bill date instead of due date (Xero offers both; this uses the
  due date, like aged receivables).
- Supplier overpayments and prepayments (not built, waiting on Jess's GST
  decision), and parent suppliers.

## Account transactions (examples not yet approved by Jess)

Written overnight from Xero's account transactions report (general ledger
detail); Jess hasn't approved them yet. For one account, or every account,
and a date range: the **opening balance** (every posting before the start
date), each **posted journal line** in the range in date order (date, the
source with a link to it, description, contact, debit, credit and the
running balance), and the **closing balance**. Balances are debits less
credits, so a credit balance is negative (shown as "Cr" on screen). A
balance sheet account's closing balance is its trial balance line at the
end date; since the trial balance follows NetSuite (TB1-TB4), an income or
expense account's trial balance line is its debits less credits from the
first day of the financial year, and retained earnings' is its closing
balance plus earlier years' profit (worked out, never posted, so never a
line here). In ATX1-ATX3 nothing was posted before the financial year, so
every closing balance is the trial balance line.
Voids and corrections are their own lines on their own dates; nothing is
netted off. Without a start date the range starts at the beginning of the
end date's financial year. With Advanced reporting's tracking on, a
**tracking filter** (a value and everything under it, like the custom
profit and loss, TC8) keeps only lines tagged with it, opening balance
included. With every account, accounts with no balance and no lines are left
out. Viewers can see it.

Setup (31 March year end, GST 15%): a manual journal OPEN on 15 Mar 2026,
Dr 1000 **5,000.00** / Cr 3000 **5,000.00**. INV-0001 to Kobe Ltd, 100.00 +
GST = **115.00**, dated 10 Apr; paid **115.00** into 1000 on 20 Apr. Bill
PS-101 from Paw Supplies, 200.00 + GST = **230.00** to 6010, dated 25 Apr
(approved by a bookkeeper); paid **230.00** from 1000 on 15 May. INV-0002 to
Kobe Ltd, 50.00 + GST = **57.50**, dated 30 Apr, voided 5 May.

- **ATX1** Account 1000, 1 Apr - 31 May 2026: opening **5,000.00**; 20 Apr
  "Payment on invoice INV-0001", Kobe Ltd, debit **115.00**, balance
  **5,115.00**; 15 May "Payment of bill PS-101", Paw Supplies, credit
  **230.00**, balance **4,885.00**; closing **4,885.00**, debits **115.00**,
  credits **230.00**. The trial balance at 31 May has 1000 at a debit of
  4,885.00, and 5,000.00 + 115.00 - 230.00 = 4,885.00. Each line links to
  its invoice or bill.
- **ATX2** Account 4000, same range: opening **0.00**; 10 Apr "Invoice
  INV-0001" credit **100.00**, balance **-100.00**; 30 Apr "Invoice
  INV-0002" credit **50.00**, balance **-150.00**; 5 May "Void of invoice
  INV-0002" debit **50.00**, balance **-100.00**; closing **-100.00** (the
  trial balance's credit of 100.00).
- **ATX3** Every account, to 31 May with no start date (so from **1 Apr
  2026**): 1000 **4,885.00**, 1100 **0.00** (four lines), 2000 **0.00**,
  2100 **15.00** (Cr 15.00, Dr 30.00, Cr 7.50, Dr 7.50), 3000
  **-5,000.00** (opening only, no lines), 4000 **-100.00**, 6010
  **200.00**; nothing else is listed. Debits and credits in the range are
  both **805.00** (the six journals' totals), and every closing balance
  matches the trial balance at 31 May.
- **ATX4** Tracking (Advanced reporting on; Location Otago > Dunedin, and
  Canterbury): INV-0001 of 12 May has a line of 100.00 tagged Dunedin and a
  line of 40.00 tagged Canterbury, both to 4000. Account 4000 filtered to
  Location: **Otago**: one line, credit **100.00**, closing **-100.00**;
  filtered to Canterbury: credit **40.00**; unfiltered: both lines,
  closing **-140.00**. A value from another category is refused.
- **ATX5** Corrections: a manual journal "Fees" on 1 May, Dr 6010 **80.00** /
  Cr 1000 80.00, corrected on 10 May to 6100. Account 6010 for May: opening
  **200.00** (PS-101); 1 May "Manual journal Fees" debit **80.00**
  (**280.00**); 10 May "Reversal REV-Fees" credit **80.00** (**200.00**);
  closing **200.00**. Account 6100: 10 May "Replacement Fees" debit
  **80.00**. Each links to its journal.

### Not supported yet (refused rather than guessed)

- Filtering by contact or by source type, and exporting to CSV or Excel
  (the browser's print works).
- Foreign-currency amounts (journals are in the base currency).

## Journal report (examples not yet approved by Jess)

Written overnight from Xero's journal report; Jess hasn't approved it yet.
Every journal posted in a date range, oldest first (by date, then the order
they were posted), each with its lines (account, description, debit,
credit, tracking), where it came from (the document, payment, refund or
bank transaction, with a link, or the journal itself), and who posted it
and when. "Who" is the signed-in user stored on the journal when it's
posted, the same person as its `ledger.journal_posted` audit event; for a
document that's whoever approved, paid, voided or refunded it. Each journal
balances, so the report's debits equal its credits. At most 2,000 journals
are listed; the report says when there are more and asks for a shorter
range. Viewers can see it.

Setup: the account transactions setup (ATX).

- **JR1** 1 Apr - 31 May 2026: six journals, in order: 10 Apr "Invoice
  INV-0001" (Dr 1100 115.00 / Cr 4000 100.00 / Cr 2100 15.00); 20 Apr
  "Payment on invoice INV-0001" (Dr 1000 / Cr 1100 115.00); 25 Apr "Bill
  PS-101" (Dr 6010 200.00 / Dr 2100 30.00 / Cr 2000 230.00), posted by the
  **bookkeeper** who approved it; 30 Apr "Invoice INV-0002" (57.50); 5 May
  "Void of invoice INV-0002" (57.50 the other way); 15 May "Payment of bill
  PS-101" (230.00). Debits and credits both **805.00**. Each journal's
  "posted by" is the same user as its audit event.
- **JR2** From 1 Mar 2026 the OPEN journal (15 Mar, **5,000.00**, "Manual
  journal OPEN") comes first and the totals are **5,805.00**. 1-30 June has
  no journals (totals **0.00**). A start date after the end date is refused.
- **JR3** Corrections list the reversal and the replacement as their own
  journals (ATX5): 1 May "Manual journal Fees", 10 May "Reversal REV-Fees"
  and "Replacement Fees".

## GST audit report (examples not yet approved by Jess)

Step 5 of the NetSuite-style plan (TODO item 8), written overnight from
NetSuite's GST audit trail and IRD's record-keeping rules (records must show
how each return was worked out); Jess hasn't approved it yet. For a GST
period on the organisation's basis (or a filed return, as it was filed), it
lists every document and amount behind Box 5, Box 6 and Box 11, the Box 9
and Box 13 adjustments, and the boxes worked out from them (7, 8, 10, 12, 14,
15). It doesn't count anything itself: it groups the GST return's own counted
lines (G1-G22) into one entry per document per event (approved, voided, or
each payment, credit or refund on the payments and hybrid bases, with what
was settled of the document's total), so each box's list adds up to the box
to the cent. Lines left out of every box (no tax, exempt, out of scope,
zero-rated purchases) are listed separately. Viewers can see it.

Setup (invoice basis, Apr-May 2026; GST 15% and zero rated): INV-0001
(I1, **115.00**) 10 Apr; INV-0002 (I5: 100.00 standard + 50.00 zero rated,
**165.00**) 12 Apr; INV-0003 (no tax, **80.00**) 14 Apr; INV-0004
(**115.00**) 20 Apr, voided 15 May; CN-0001 (**23.00**) 5 May; spend money
**57.50** including GST (petrol) 3 Apr; bill S-1 (B1, **230.00**) 12 Apr;
supplier credit note CR-7 (**46.00**) 16 Apr.

- **GA1** Box 5 **257.00**: INV-0001 115.00, INV-0002 165.00 (2 lines),
  INV-0004 115.00 (approved 20 Apr) and **-115.00** (voided 15 May),
  CN-0001 **-23.00**. Box 6 **50.00**: INV-0002 50.00. Box 7 **207.00**,
  Box 8 **27.00**. Box 11 **241.50**: the spend money 57.50, S-1 230.00,
  CR-7 **-46.00**; Box 12 **31.50**. Box 15 **-4.50**. Left out: INV-0003
  **80.00**. Every figure equals the GST return for the same period.
- **GA2** With a Box 9 adjustment "Bad debt recovered" **3.00** and a Box 13
  "Change of use" **1.50**: both listed; Box 10 **30.00**, Box 14
  **33.00**, Box 15 **-3.00**, the same as the return with them.
- **GA3** Payments basis (G11): I5 dated 10 Apr and paid **82.50** on
  15 Apr; B1 paid **115.00** on 20 May. Box 5 **82.50**: one entry
  "Customer payment" of 82.50 settled of 165.00; Box 6 **25.00**; Box 11
  **115.00** ("Supplier payment", 115.00 of 230.00); Box 15 **-7.50**. On
  the hybrid basis the same documents give Box 5 **165.00** (INV-0001
  approved), Box 6 **50.00**, Box 11 **115.00**, Box 15 **0.00**.
- **GA4** A filed return is audited as it was filed: with I1 and B1 filed
  for Apr-May, a bill for **115.00** dated 10 May approved afterwards isn't
  in the filed return's Box 11 list (**230.00**, one entry), but is in the
  list worked out now (**345.00**, two entries).

### Not supported yet (refused rather than guessed)

- Adjustments are listed as typed (description and amount); there's no
  document behind them to link to.
- Exporting the audit report to a file (the browser's print works).

## Customer statements (examples not yet approved by Jess)

Written overnight from Xero's customer statements; Jess hasn't approved them
yet. Two kinds, for one customer:

- **Activity**, for a date range: the balance owed the day before the start
  (the same figure aged receivables gives at that date), each invoice,
  credit note, payment, refund and their voids in the range in date order,
  what each adds to or takes off the balance, and the closing balance.
  Payments are the whole amount received (an overpayment is part of it); a
  payment for several invoices is one line. Applying credit or an
  overpayment to an invoice moves nothing between the customer and the
  organisation, so it isn't a line.
- **Outstanding**, as at a date: each invoice still owed (its total and
  what's left), and each credit note or overpayment with credit not yet
  used (as a negative amount), and the balance.

Both end with the balance **aged** as at the statement's (end) date by each
invoice's due date (current, 1-30, 31-60, 61-90, over 90), less unused
credit, the same buckets as aged receivables. With **include
sub-customers**, a parent's statement covers it and every customer under it
(RC8), each line naming its customer. A contact that isn't a customer is
refused. Statements are printed (or saved as PDF) with the browser's print;
emailing them isn't built. Viewers can see them.

Setup (GST 15%): Kobe Group Ltd is the parent of Kobe Auckland and Kobe
Dunedin. Kobe Auckland: INV-0001 **230.00** dated 15 May 2026, due 15 Jun;
INV-0002 **115.00** dated 1 Jun, due 1 Jul; a payment of **100.00** on
INV-0001 on 10 Jun; CN-0001 **23.00** on 12 Jun (not applied); INV-0003
**57.50** dated 15 Jun, voided 20 Jun; a payment of **125.00** on INV-0002
on 25 Jun (**10.00** of it an overpayment); **11.50** of CN-0001 refunded on
28 Jun. Kobe Dunedin: INV-0004 **115.00** dated 20 Jun, due 20 Jul.

- **CST1** Kobe Auckland's activity statement, 1-30 June 2026: opening
  **230.00**; 1 Jun Invoice INV-0002 +115.00 (**345.00**); 10 Jun Payment
  on INV-0001 -100.00 (**245.00**); 12 Jun Credit note CN-0001 -23.00
  (**222.00**); 15 Jun Invoice INV-0003 +57.50 (**279.50**); 20 Jun Invoice
  INV-0003 voided -57.50 (**222.00**); 25 Jun Payment on INV-0002 -125.00
  (**97.00**); 28 Jun Refund of credit note CN-0001 +11.50 (**108.50**).
  Added **184.00**, taken off **305.50**, closing **108.50**. Ageing at
  30 June: 1-30 **130.00** (INV-0001, 15 days), credit **21.50**, total
  **108.50**, the same as Kobe Auckland on aged receivables at 30 June.
- **CST2** Kobe Auckland's outstanding statement as at 30 June 2026:
  INV-0001 (230.00, **130.00** left, 15 days overdue); CN-0001 (23.00,
  **-11.50**); overpayment on INV-0002 (10.00, **-10.00**); balance
  **108.50**, with the same ageing.
- **CST3** Kobe Group Ltd with sub-customers, 1-30 June: opening **230.00**
  (Kobe Auckland's); the CST1 lines plus 20 Jun Invoice INV-0004 +115.00
  (Kobe Dunedin); closing **223.50**; ageing current **115.00**, 1-30
  **130.00**, credit **21.50**, total **223.50**, the same as Kobe Group
  Ltd's rolled-up total on aged receivables at 30 June. Without
  sub-customers, Kobe Group Ltd's own statement is opening **0.00**, no
  lines, closing **0.00**.
- **CST4** Kobe Dunedin, 1-31 July: INV-0005 **57.50** dated 1 Jul, due
  31 Jul; one payment of **172.50** for INV-0004 and INV-0005 on 5 Jul,
  voided 8 Jul. Opening **115.00**; 1 Jul Invoice INV-0005 +57.50
  (**172.50**); 5 Jul Payment -172.50 (**0.00**); 8 Jul Payment voided
  +172.50 (**172.50**); closing **172.50**; ageing at 31 July: current
  **57.50**, 1-30 **115.00** (11 days), total **172.50**.
- **CST5** Refused: a statement for Paw Supplies (a supplier only: "isn't a
  customer"), and a start date after the end date. A viewer can open both
  kinds.

### Not supported yet (refused rather than guessed)

- Emailing statements (server email is only set up for security messages;
  needs Jess's decision), and statements for several customers at once.
- Foreign-currency statements (invoices are in the base currency).
- Showing credit and overpayments applied to invoices as lines (they don't
  change the balance, so they're left out, as in Xero's activity statement).

## Quotes (examples not yet approved by Jess)

Written overnight from Xero's quotes; Jess hasn't approved them yet. A quote
has the same lines as an invoice (items, units, price levels, tracking,
custom fields, tax exclusive, inclusive or no tax) and the same line maths
(I1-I6), plus an optional expiry date and terms. Quotes **post nothing**.

- A **draft** can be edited, copied and deleted.
- **Finalising** checks it again, gives it the next number (`QU-0001`,
  `QU-0002`, ...) from its own counter, with no gaps, and locks it: the
  database refuses changing a finalised quote or its lines, or deleting it.
- A finalised quote is then **accepted** or **declined**, once.
  **Accepting** is the step that makes the invoice: a draft invoice for the
  same customer carrying the quote's lines, amounts, custom fields and
  salesperson, dated the day chosen, due on the date given or else the
  customer's payment terms, with the quote's reference (or its number). The
  quote and invoice are linked both ways. **Declining** closes it.
- **Expired** isn't stored: a finalised quote past its expiry date shows as
  expired (and in its own list). It can still be accepted, as in Xero.
- There's no "sent" status: nothing sends quotes yet. Printing is
  "Print or save as PDF" (PD8).

Setup (GST 15%): customer Kobe Cafe with payment terms "20th of the
following month" and billing address "12 George St, Dunedin 9016".

- **QT1** Draft quote to Kobe Cafe dated 15 Jul 2026, expiring 14 Aug 2026,
  tax exclusive: 2 x Paw print pendant at **120.00** (GST) and 1 x Engraving
  at **35.00** (GST). Net **275.00**, GST **41.25**, total **316.25**. No
  journal is posted and it has no number.
- **QT2** Finalising QT1 makes it **QU-0001**; its lines and totals can't be
  changed (refused, and the database refuses too), and it can't be deleted.
  A second draft whose customer has since been archived is refused on
  finalising and stays a draft; the next quote finalised is **QU-0002** (no
  gap).
- **QT3** Accepting QU-0001 with invoice date 20 Jul 2026 makes a draft
  invoice to Kobe Cafe dated **20 Jul 2026**, due **20 Aug 2026** (terms),
  reference **QU-0001**, with the same two lines and total **316.25**. The
  quote is accepted and points to the invoice; the invoice points back to
  QU-0001. Accepting again with the same key returns the same invoice.
  Approving that invoice posts INV-0001: Dr 1100 **316.25** / Cr 4000
  **275.00** / Cr 2100 **41.25**, the same as any invoice.
- **QT4** Declining QU-0002 closes it; accepting it is then refused ("already
  declined"), and so is declining QU-0001 once accepted.
- **QT5** Expired: a finalised quote expiring 31 Jul 2026 shows as expired on
  1 Aug 2026 but not on 31 Jul; accepted or declined quotes, drafts and
  quotes without an expiry date never do.
- **QT6** Copying QU-0001 (quote date 15 Jul, expiry 14 Aug, 30 days) to
  1 Sep 2026 makes a new draft dated **1 Sep 2026** expiring **1 Oct
  2026**, with the same customer, lines and total **316.25**, no number, and
  "copied from" QU-0001. A copy is checked like a new quote: once Kobe Cafe
  is archived, copying QU-0001 again is refused.
- **QT7** The draft invoice made by accepting QU-0001 can't be deleted (so
  the quote keeps its invoice); it can be edited or approved and voided.
- **QT8** Refused: accepting or declining a draft, finalising twice, a quote
  with no lines, an expiry date before the quote date. A viewer can see and
  print quotes but not save them.

### Not supported yet (refused rather than guessed)

- Sending or emailing quotes (so no "sent" status), customer online
  acceptance, and quote templates or themes.
- Accepting part of a quote, or invoicing a quote in stages (deposits,
  progress invoicing): accepting makes one invoice for the whole quote.
- Linking a quote to a CRM opportunity. A won opportunity still makes its
  own invoice (CRM5).
- (Foreign-currency quotes are built: MC25.)

## Sales orders (examples not yet approved by Jess)

Written from NetSuite's sales orders, as Jess asked (NetSuite where it has an
answer, otherwise Xero; Xero has no sales orders). Jess hasn't approved
them yet. Stage 1 is the order and invoicing from it; stock isn't reserved
and there are no deliveries yet. NetSuite help pages followed (the agent's
sandbox can't open docs.oracle.com, so they were read through web search
summaries of the pages):

- "Sales Orders" (chapter_N1215966) and "Creating Sales Orders": a sales
  order is a customer's order of items; it posts nothing to the general
  ledger until it's billed (and fulfilled).
- "Viewing the Status of Sales Orders" (section_N1220604): Pending
  Approval, Pending Fulfillment, Partially Fulfilled, Pending
  Billing/Partially Fulfilled, Pending Billing, Billed, Closed, Cancelled.
- "Billing or Invoicing a Sales Order" (section_N1240951), "Invoicing Sales
  Orders" (section_N1219162) and "Invoicing Individual Line Items"
  (article_0518111425): the invoice is made from the order, carries its
  lines, can be for part of the order, and the order keeps the quantity
  billed per line.
- "Closing a Sales Order" (section_4698204292) and "Closing Line Items on
  Sales Orders" (section_N1220357): closing stops anything more being
  billed (or fulfilled) on lines not yet done.
- "Converting an Estimate to a Sales Order" (section_N1073352): an
  estimate (quote) becomes a sales order carrying its lines.
- "Currency on Customer Transactions": a transaction made from another
  keeps the original's currency (also cited for MC25).

A sales order goes to a **customer** and has the same lines as an invoice
or quote (items, units, price levels, tracking, custom fields, salesperson,
tax exclusive, inclusive or no tax) with the same line rules and maths
(I1-I6). It has an **order date**, an optional **expected date** (not
before the order date), a reference and a memo. A sales order **posts
nothing** to the ledger and doesn't change stock or GST. It's in the
customer's currency (MC1) with no exchange rate; each invoice gets its own
rate (MC25).

- A **draft** can be edited and deleted.
- **Approving** checks it again as an invoice would be checked (an active
  customer, accounts, tax codes, items, required tracking and custom
  fields), gives it the next number (`SO-0001`, `SO-0002`, ...) from its own
  counter, with no gaps, and **locks** it: the database refuses changing an
  approved order or its lines, or deleting it. Following NetSuite, a draft
  is "pending approval" and isn't billable.
- **Invoice** makes a **draft invoice** to the same customer for what's left
  on each line (ordered less what's on invoices that aren't voided, drafts
  included), or less if the person reduces a quantity (zero leaves the line
  off). It carries the line's description, price, account, tax code, item,
  unit, tracking and custom fields, and the order's salesperson, custom
  fields and reference (or its number). It's dated the day chosen and due
  on the date given or else the customer's payment terms. Each invoice line
  points back to its order line and the invoice to its order. The draft is
  then edited and approved like any invoice; **cost of sales is still
  posted when the invoice is approved** (ST1), since there are no
  deliveries yet.
- **Invoiced** is worked out from the linked invoices, never stored or
  typed: per line, what's on **approved** invoices is invoiced and what's on
  **draft** invoices is shown separately. Voiding an invoice, or deleting a
  draft, gives its quantities back.
- A linked invoice line keeps its order line's **item and unit**, the
  invoice keeps its **customer**, and the invoices that aren't voided never
  add up to **more than was ordered** on a line (anything extra goes on a
  line of its own). The database refuses all three too.
- **Status** is worked out, following NetSuite's: **draft** (NetSuite's
  Pending Approval), **pending billing** (approved, nothing invoiced),
  **partly billed** (some invoiced; NetSuite's "Partially Fulfilled" family
  needs deliveries, which stage 1 hasn't got), **billed** (approved
  invoices cover every line), **closed** and **cancelled**. Only closed and
  cancelled are stored, as they're decisions, not figures.
- **Closing** an approved order means nothing more will be invoiced. It's
  refused once billed (nothing left), and while it has draft invoices
  (approve or delete them first). Voiding an invoice of a closed order is
  still allowed; the order stays closed.
- **Cancelling** an approved order is allowed only while it has no invoices
  other than voided ones (drafts count). Drafts are deleted, not cancelled;
  a closed order can't be cancelled.
- A finalised quote can be **accepted as a sales order** instead of as an
  invoice (NetSuite's estimate to sales order): a draft order to the same
  customer, dated the day chosen, with the quote's lines, custom fields,
  salesperson and reference (or its number). The quote is accepted and the
  two point to each other; the draft order can't be deleted (as QT7).

Setup (GST 15%): organisation Glimmers with Advanced features on; customer
**Kobe Cafe** with payment terms "20th of the following month"; item
**WIDGET** "Widget" (stock, sale price **12.00** to 4000, purchase price
5.00 to 1400, GST) with 20 bought on 1 Jul 2026 at **5.00** (100.00) on an
approved bill; item **GIFTBOX** "Gift box" (non-stock, sale price **4.00**
to 4000, GST).

- **SO1** A draft sales order to Kobe Cafe dated 1 Aug 2026, expected
  15 Aug 2026, reference **KC-PO-77**, memo "Deliver to the Octagon shop",
  tax exclusive, with lines of only WIDGET x 10 and GIFTBOX x 50, is filled
  in as "Widget" 10 x **12.00** to 4000 (120.00) and "Gift box" 50 x
  **4.00** to 4000 (200.00): net **320.00**, GST **48.00**, total
  **368.00**. It has no number, posts no journal, and stock is still 20
  Widgets worth 100.00. An expected date before the order date is refused.
- **SO2** Approving SO1 makes it **SO-0001**, **pending billing**, with 0
  invoiced and 10 and 50 left; editing or deleting it is refused (and the
  database refuses changing it or its lines). Still no journal, stock is
  still 20 worth 100.00, and the GST return for August 2026 is unchanged
  (nothing). A second draft to a customer that has since been archived is
  refused on approval and stays a draft; the next order approved is
  **SO-0002** (no gap).
- **SO3** Invoicing SO-0001 on 5 Aug 2026 makes a draft invoice to Kobe
  Cafe dated **5 Aug 2026**, due **20 Sep 2026** (terms), reference
  **KC-PO-77**, with 10 Widget @ 12.00 and 50 Gift box @ 4.00, total
  **368.00**, from SO-0001, each line linked to its order line. SO-0001
  shows 10 and 50 on draft invoices, 0 invoiced, nothing left, and is still
  **pending billing**; invoicing it again is refused ("nothing left to
  invoice"). The same request retried with the same key returns the same
  invoice. Approving it posts INV-0001: Dr 1100 **368.00** / Cr 4000
  **320.00** / Cr 2100 **48.00** and cost of sales Dr 5000 **50.00** / Cr
  1400 **50.00** (10 Widgets at 5.00), leaving 10 Widgets worth 50.00.
  SO-0001 then shows 10 and 50 invoiced and is **billed**.
- **SO4** A part invoice: invoicing SO-0001 on 5 Aug 2026 for 6 Widgets and
  20 Gift boxes makes a draft with Widget 72.00 and Gift box 80.00: net
  **152.00**, GST **22.80**, total **174.80**. Approved, it posts Dr 1100
  **174.80** / Cr 4000 **152.00** / Cr 2100 **22.80** and Dr 5000 **30.00**
  / Cr 1400 **30.00**. SO-0001 shows 6 of 10 and 20 of 50 invoiced, 4 and
  30 left, and is **partly billed**. Invoicing it again on 20 Aug 2026
  makes a draft for the rest, 4 Widgets (48.00) and 30 Gift boxes (120.00):
  net **168.00**, GST **25.20**, total **193.20**, due 20 Sep 2026. Once
  that's approved SO-0001 is **billed** (174.80 + 193.20 = 368.00).
- **SO5** Voiding the second invoice of SO4 (193.20) on 21 Aug 2026 gives
  its 4 and 30 back: SO-0001 is **partly billed** again with 4 and 30 left,
  and invoicing again makes a new draft for them. Deleting that draft gives
  them back too (still 4 and 30 left).
- **SO6** Over-invoicing is refused. Asking the Invoice action for 5
  Widgets when 4 are left is refused ("only 4 left to invoice"). On SO3's
  draft invoice, 11 Widgets is refused (only 10 were ordered); on SO4's
  second draft, 5 Widgets is refused ("6 of it is on other invoices, so at
  most 4 can be invoiced here"). Changing a linked line's item, changing
  the invoice's customer, and an invoice line naming an order line on an
  invoice that wasn't made from that order are all refused (the database
  refuses them too). Two changes at the same moment that each fit but
  together go over take turns, and the second is refused, in the database
  as well. A line of its own, "Freight" 15.00 to 4000, can be
  added to the invoice, and a linked line's price can be changed to 11.50
  (the invoice posts 11.50; the order keeps 12.00, since invoiced counts
  quantities).
- **SO7** Closing: after SO4's first invoice is approved (6 and 20
  invoiced), closing SO-0001 makes it **closed**, still showing 4 and 30
  not invoiced; invoicing it is then refused, and so is cancelling it.
  Voiding that invoice is still allowed and SO-0001 stays **closed** (now 0
  invoiced). Closing is refused for a draft, for an order with a draft
  invoice (the database refuses too), and for a billed order.
- **SO8** Cancelling: an approved order with no invoices is **cancelled**
  and can't then be invoiced or closed. A draft can't be cancelled (it's
  deleted instead). An order with a draft invoice can't be cancelled
  (refused, and the database refuses too); after the draft is deleted it
  can. An order with an approved invoice can't be cancelled; once that
  invoice is voided it can.
- **SO9** From a quote: QU-0001 (QT1: 2 x Paw print pendant at 120.00 and
  1 x Engraving at 35.00, total **316.25**) accepted as a sales order on
  16 Jul 2026 makes a draft sales order to Kobe Cafe dated **16 Jul 2026**,
  reference **QU-0001**, with the same two lines and total **316.25**. The
  quote is accepted and points to the order; the order points back to
  QU-0001. Accepting it again (as an order or an invoice) is refused
  ("already accepted"), the same request retried with the same key returns
  the same order, and the draft order can't be deleted. Accepting a draft
  quote as an order is refused. Approved as SO-0001 and invoiced on 20 Jul
  2026, the draft invoice has reference QU-0001 and total **316.25**.
- **SO10** Foreign currency: Acme Inc (USD). A sales order dated 1 Aug 2026
  for 3 x "Consulting day" at **USD 100.00** to 4000, tax code ZERO, total
  **USD 300.00**, approved as SO-0001, has no exchange rate and posts
  nothing. Invoicing 2 of them on 10 Aug 2026 at a typed rate of **1.65**
  makes a USD draft invoice of **USD 200.00** (NZD **330.00**); approved, it
  posts Dr 1100 **330.00** / Cr 4000 **330.00**. SO-0001 is **partly
  billed** with 1 left. Invoicing the rest on 20 Aug 2026 at **1.60** makes
  **USD 100.00** (NZD **160.00**); once approved SO-0001 is **billed**.
  Acme's currency can't then be changed (the order counts, like a quote).
- **SO11** Period locks: with the lock date 31 Jul 2026, a sales order
  dated 20 Jul 2026 can still be saved and approved (it posts nothing), and
  invoicing it on 25 Jul 2026 makes a draft, but approving that invoice is
  refused because 25 Jul 2026 is locked. With the draft deleted, invoicing
  on 3 Aug 2026 and approving works, and the order is **billed**.
- **SO12** Saving, approving, invoicing, closing and cancelling each return
  the original when retried with the same key, and are refused (409) with
  the same key and different content. A sales order with no lines is
  refused. The list filters by status (draft, pending billing, partly
  billed, billed, closed, cancelled). A viewer can list and open sales
  orders and see their invoices but not save, approve, close, cancel or
  invoice them.

### Not supported yet (refused rather than guessed)

- Reserving stock (committed quantities), deliveries (fulfilment), and
  moving cost of sales to delivery: later stages. Until then cost of sales
  is posted when the invoice is approved.
- Making sales orders from won CRM opportunities, and Shopify orders.
- **Line discounts**: invoices and quotes have no discount field (price
  levels give customer prices instead), so neither do sales orders.
- Editing an approved order, closing single lines, and reopening a closed
  order.
- Invoicing more than was ordered on a line (put the extra on a line of its
  own); cancelling an order with invoices that aren't voided; closing an
  order with draft invoices.
- Credit notes don't give quantity back to the order; only voiding the
  invoice (or deleting a draft) does.
- Printing and emailing sales orders, deposits against an order, credit
  limit holds, and accepting part of a quote as an order.
- Notes and files on sales orders.

### Questions for Jess (sales orders), decided

Decided on 2 Oct 2026: decisions 275-280. What was asked is kept below.

1. Should accepting a quote make a sales order by default now (NetSuite's
   estimate to sales order), with "accept as invoice" kept for quick sales?
2. Line discounts: add a discount (percent or amount) to invoice, quote and
   sales order lines together, or keep price levels only?
3. Closing: should closing be per line (as NetSuite does) and should a
   closed order be reopenable? Should voiding an invoice of a closed order
   reopen it?
4. Should approved orders be editable (NetSuite allows it; Tohyee locks
   them like purchase orders), and if so what may change once invoiced?
5. Should a credit note made from an order's invoice give the quantity back
   to the order (NetSuite uses return authorisations for that)?
6. Status names: "partly billed" stands in for NetSuite's "Pending
   Billing/Partially Fulfilled" until deliveries exist. Keep "billed" or say
   "invoiced"?

## Repeating invoices (examples not yet approved by Jess)

Written overnight from Xero's repeating invoices; Jess hasn't approved them
yet. A **template** holds a customer, invoice lines (as on an invoice), how
often (every N weeks or months), a start date, an optional end date, the due
date (the customer's payment terms, or N days after the invoice date) and
whether each invoice is **saved as a draft** or **approved**. Templates post
nothing.

- **Dates**: every N weeks is the start date plus 7 x N days each time.
  Every N months keeps the start date's day; a day the month doesn't have
  falls on the month's last day, and later months go back to the day (each
  date is worked out from the start date, not the date before).
- **The job** runs every hour on the server (and "Run now" on a template):
  for each active template it makes every scheduled date up to today that
  hasn't been made yet, oldest first. Each date gets one invoice dated that
  day, recorded in the template's history with a database key on (template,
  date), so running twice, or two runs at once, never makes two.
- **Approve automatically** approves each invoice as a person would: period
  locks, required tracking and custom fields and the credit limit apply. A
  refused approval leaves the draft and records why in the template's
  history. If the invoice can't be made at all (say the customer is
  archived), the template shows the error and tries that date again next
  run.
- **Pause** stops the job making invoices; **resume** carries on from the
  resume date (dates while it was paused aren't made). **End** is final.
  A template past its end date with every date made ends itself.

Setup (GST 15%): customer Kobe Cafe; each template has one line, 1 x
Monthly retainer at **100.00** tax exclusive (GST) to 4000, so each invoice
is **115.00**.

- **RI1** Monthly from 31 Jan 2026 falls on **31 Jan, 28 Feb, 31 Mar,
  30 Apr, 31 May** 2026. Saving the template posts nothing and makes no
  invoice.
- **RI2** Saved as drafts, due 20 days after: the job run on 5 Mar 2026
  makes two draft invoices, dated **31 Jan** (due 20 Feb) and **28 Feb** (due
  20 Mar), in that order, each 115.00, and the history lists both. Nothing
  is posted. The next date is **31 Mar 2026**.
- **RI3** Running again on 5 Mar 2026 makes nothing more; running on 31 Mar
  makes just the 31 Mar invoice, even when two runs start at once. The
  hourly job runs each template in its own transaction: with a second
  template for Paw Walkers (since archived), the job run on 5 Mar makes
  Kobe Cafe's two invoices and records "Paw Walkers is archived..." on the
  other template; running it again makes nothing more.
- **RI4** Approve automatically: the job run on 5 Mar 2026 makes and
  approves **INV-0001** (31 Jan) and **INV-0002** (28 Feb), each posting Dr
  1100 **115.00** / Cr 4000 **100.00** / Cr 2100 **15.00** on its own date.
- **RI5** Every 2 weeks from Monday 5 Jan 2026 ending 2 Feb 2026: **5 Jan,
  19 Jan, 2 Feb**. Run on 10 Feb it makes those three and the template
  ends itself.
- **RI6** Every 3 months from 31 Aug 2026: **31 Aug, 30 Nov** 2026, **28 Feb
  2027**, **31 May 2027**. Every month from 29 Jan 2028 (a leap year):
  **29 Jan, 29 Feb, 29 Mar**.
- **RI7** The RI2 template paused on 5 Mar: a run on 5 May makes nothing.
  Resumed on 10 May: the 31 Mar and 30 Apr dates are never made, and the
  next is **31 May 2026**. Ended: nothing more is made, and changing or
  resuming it is refused.
- **RI8** Changing the template's unit price to 120.00 on 5 Mar makes the
  31 Mar invoice **138.00**; the 31 Jan and 28 Feb invoices keep 115.00.
- **RI9** Approve automatically with the period locked to 31 Jan 2026: run on
  5 Mar, the 31 Jan invoice is **left as a draft** with "Left as a draft:
  2026-01-31 is in a locked period..." in the history, and 28 Feb is approved
  as **INV-0001**. With Advanced reporting, a credit limit of **150.00** set
  to block: the 31 Jan invoice is approved (115.00) and the 28 Feb one is
  left as a draft with the credit limit message. With Kobe Cafe archived,
  nothing is made, the template shows "Kobe Cafe is archived..." and the
  next run tries 31 Jan again.
- **RI10** Deleting the 31 Jan draft that RI2 made keeps the history line
  (shown as deleted), and later runs don't make 31 Jan again.

### Not supported yet (refused rather than guessed)

- Emailing each invoice (Xero's "approve for sending"): server email is only
  set up for security messages.
- Daily, yearly or "end of month" schedules (Xero has these); weeks and
  months cover them except daily.
- Placeholders in descriptions (Xero's [Month] [Year]).
- Approving foreign-currency invoices automatically (they're saved as
  drafts, MC26).

## Repeating bills (examples not yet approved by Jess)

Written from Xero's repeating bills (and NetSuite's memorized bills); Jess
hasn't approved them yet. The purchases twin of repeating invoices, made by
the same scheduler (`src/lib/repeating/runner.ts`), so the dates, the hourly
job, "Run now", catching up missed dates, pause, resume and end work exactly
as in RI1-RI10. A **template** holds a supplier, bill lines (the bill line
rules: B1-B4, items fill the supplier's price as in IT6, stock items as in
ST1), a **supplier invoice number pattern**, a **due date rule**, how often,
a start date, an optional end date, and whether each bill is **saved as a
draft** or **approved**. Templates post nothing; approved bills post as in
B1, and **nothing is ever paid automatically**.

- **Supplier invoice numbers**: an approved bill needs one, and a supplier
  can't have two bills that aren't voided with the same number (B5). So the
  template can hold a pattern: **{date}** becomes the bill date (2026-01-31),
  **{month}** its month (2026-01) and **{n}** the bill's number in the
  template's history (1, 2, 3...; history rows are never deleted, so it
  never repeats). A pattern needs {date} or {n}, or {month} on a monthly
  schedule; otherwise it's refused. If the supplier already has a bill with
  the number (perhaps the same bill entered by hand), the bill isn't made:
  the template shows the error and tries that date again next run. Or the
  pattern is **left empty** (RB11, decided 1 Oct 2026 following NetSuite,
  where a vendor bill's reference number is optional): each bill is then a
  **draft without a number**, to be completed when the supplier's real
  invoice arrives, so such a template can't approve automatically.
- **Due dates**: the supplier's payment terms (RB12, SPT3), or one of Xero's
  bill rules: N days after the bill date, N days after the end of the
  bill's month, or day N (1-31) of the following month (a day the month
  doesn't have becomes its last day).
- **Stock items** are allowed, as on any bill. Once locations are in use
  each stock line needs a Location, checked when the template is saved.
  Approving moves the stock in (ST1); if the approval is refused (e.g.
  stock has moved after that date), the bill is left as a draft with the
  reason, as for any refused approval.
- **Approve automatically** approves each bill as a person would: period
  locks, required tracking and custom fields and stock rules apply. A
  refused approval leaves the draft and records why in the history.

Setup (GST 15%): supplier Harbour Property Ltd; the template has one line,
1 x Office rent at **1,000.00** tax exclusive (GST) to 6150 Rent, supplier
invoice number **RENT-{month}**, monthly from **31 Jan 2026**, due the
**20th of the following month**, saved as drafts, so each bill is
**1,150.00**.

- **RB1** Saving the template posts nothing and makes no bill; its next
  bill is 31 Jan 2026, numbered **RENT-2026-01**. A pattern with no
  placeholder ("RENT"), {month} on a weekly schedule, due day 0 of the
  following month, and a contact that's only a customer are refused.
- **RB2** The job run on 5 Mar 2026 makes two draft bills: **31 Jan**,
  **RENT-2026-01**, due **20 Feb**; and **28 Feb**, **RENT-2026-02**, due
  **20 Mar**; each 1,000.00 + GST 150.00 = **1,150.00** to 6150. Nothing is
  posted. Each bill links back to the template and date; the next is
  **31 Mar 2026, RENT-2026-03**.
- **RB3** Pattern **Invoice {n}**, due **30 days after** the bill date:
  31 Jan is **Invoice 1** due **2 Mar 2026**, 28 Feb is **Invoice 2** due
  **30 Mar 2026**. Southern Cleaning, 1 x 46.00 tax inclusive to 6030,
  pattern **SC {date}**, due **7 days after the end of the bill month**:
  **SC 2026-01-31** due **7 Feb**, **SC 2026-02-28** due **7 Mar**, each
  **46.00** (GST 6.00, as B2).
- **RB4** Running again on 5 Mar makes nothing; two runs at once on 31 Mar
  make just RENT-2026-03. With a second template for Old Landlord (since
  archived), the hourly job run on 5 Mar makes Harbour's two bills and
  records "Old Landlord is archived..." on the other; running again makes
  nothing more.
- **RB5** Approve automatically: run on 5 Mar 2026, RENT-2026-01 and
  RENT-2026-02 are approved, each posting **Dr 6150 1,000.00 / Dr 2100
  150.00 / Cr 2000 1,150.00** on its own date (31 Jan, 28 Feb). Each is
  **unpaid** with **1,150.00** due; no supplier payment is recorded.
- **RB6** Changing the unit price to 1,050.00 on 5 Mar makes the 31 Mar
  bill **1,207.50** (1,050.00 + GST 157.50); the January and February bills
  keep 1,150.00.
- **RB7** Stock (Advanced features on, location Dunedin): Paw Supplies'
  price for WIDGET is 4.80. A template of 10 x WIDGET, pattern **PS-{n}**,
  monthly from 15 Jan 2026, due 20 days after, approved: without a Location
  it's refused ("WIDGET is a stock item, so it needs a Location"); at
  Dunedin the item fills 4.80 and 1400, so the line is **48.00**. Run on
  20 Feb 2026: **PS-1** (15 Jan, due 4 Feb) and **PS-2** (15 Feb, due
  7 Mar), each **Dr 1400 48.00 / Dr 2100 7.20 / Cr 2000 55.20**; WIDGET at
  Dunedin is **20** units worth **96.00**, equal to 1400.
- **RB8** Paused on 5 Mar: a run on 5 May makes nothing. Resumed on 10 May:
  the next is **31 May 2026, RENT-2026-05**; March and April are never
  made. Ended: nothing more is made, and changing or resuming it is refused.
  Every 2 weeks from 5 Jan 2026 to 2 Feb 2026 with pattern **W{n}**: run on
  10 Feb makes **W1, W2, W3** (5 Jan, 19 Jan, 2 Feb) and the template ends
  itself.
- **RB9** Approve automatically with the period locked to 31 Jan 2026: run
  on 5 Mar, RENT-2026-01 is **left as a draft** with "Left as a draft:
  2026-01-31 is in a locked period..." in the history, and RENT-2026-02 is
  approved. Separately, with a draft bill from Harbour numbered
  **rent-2026-01** typed by hand: the run makes nothing, and the template
  shows "2026-01-31: Harbour Property Ltd already has a bill with the
  invoice number rent-2026-01..." and stays at 31 Jan. Once that bill is
  deleted, the next run makes and approves both.
- **RB10** With pattern **R{n}**, deleting the 31 Jan draft (R1) keeps the
  history line (shown as deleted), 31 Jan isn't made again, and the 28 Feb
  bill is **R2**. A draft made by a template can be approved by hand like
  any other. A viewer can't run a template.
- **RB11** The template with the number pattern **left empty**: saved, its
  next bill has no number. Approving automatically is refused ("Bills
  without a supplier's invoice number are saved as drafts, so give a number
  pattern to approve them automatically, or save them as drafts."), also
  when changing it and by the database. Run on 5 Mar 2026 it makes two
  drafts **without a number**: 31 Jan due 20 Feb and 28 Feb due 20 Mar, each
  **1,150.00**; nothing is posted. Approving January's is refused until the
  number from Harbour's real invoice, **HP-10442**, is typed; then it posts
  Dr 6150 1,000.00 / Dr 2100 150.00 / Cr 2000 1,150.00 on 31 Jan 2026. Giving
  the template the pattern RENT-{month} afterwards makes the next one
  **RENT-2026-03**.
- **RB12** (SPT3) Due **by the supplier's payment terms**: refused while
  Harbour has none ("This supplier has no payment terms, so choose a number
  of days..."). With Harbour on "20th of the following month" the run on
  5 Mar 2026 makes RB2's two bills (due **20 Feb** and **20 Mar**). With
  Harbour's terms then taken away, the next run makes nothing and the
  template shows "Harbour Property Ltd no longer has payment terms...".

### Not supported yet (refused rather than guessed)

- Paying bills automatically (Xero doesn't either); approved bills wait in
  "Awaiting payment" like any other.
- Bills made from a purchase order, approving foreign-currency bills
  automatically (they're saved as drafts, MC27), and daily,
  yearly or "day N of the current month" rules.
- Placeholders in line descriptions (Xero's [Month] [Year]).

### Questions for Jess (repeating bills), decided

Decided on 2 Oct 2026: decision 285. What was asked is kept below.

- When the number is already taken by a bill entered by hand, the template
  stops at that date (it may be the same bill). Should it skip that date
  instead, or make the bill with a suffix?

Decided (following NetSuite, 1 Oct 2026):

- Supplier invoice numbers: patterns work as built, and a template can
  leave the pattern empty so its bills are drafts without a number, typed
  from the supplier's real invoice before approving (RB11, B9). An approved
  bill still needs a number that's unique for its supplier (B5), so the
  ledger and GST audit trail are unchanged. NetSuite's Reference No. is
  optional (it only warns about a duplicate); Tohyee keeps the stricter
  rule for approved bills.
- Suppliers have payment terms (NetSuite vendors have a Terms field), used
  by bills, repeating bills and copy to bill (SPT1-SPT5, RB12).

## Printed invoices, credit notes and quotes (examples not yet approved by Jess)

Written overnight from Xero's invoice PDFs and IRD's taxable supply
information rules (in force from 1 April 2023); Jess hasn't approved them
yet. Each invoice, credit note and quote has a print page with "Print or
save as PDF" (the browser's print, as for statements). It stores and posts
nothing, and anyone who can see the document can print it. Settings has
three new fields for it: the organisation's **postal address**, **GST
number** and **payment details** (e.g. the bank account to pay into).

What appears when:

| Document | Heading | GST number | GST shown |
| --- | --- | --- | --- |
| Approved invoice, organisation has a GST number, amounts have tax | **Tax invoice** | Yes | Exclusive: a GST line; inclusive: "Total includes GST of $x" |
| Approved invoice, no GST number in Settings, or no-tax amounts | **Invoice** | No | None (no-tax), or as above |
| Draft invoice | **Draft invoice** (no number) | No | As above |
| Voided invoice | **Voided invoice** | No | As above |
| Approved credit note (same rules) | **Credit note** | When a tax credit note | As above |
| Quote | **Quote** (**Draft quote** before finalising) | No (not a tax document) | As above |

Every printed document shows the organisation's name and address, the
customer's name and billing address, the date, each line's description,
quantity, unit price, GST rate and amount, the subtotal, GST and total.
Invoices add the due date, and once approved, what's been paid or credited,
the amount due and the payment details. Quotes add the expiry date and
terms. Over **$1,000** including GST, a tax invoice or credit note must
identify the buyer by more than their name. Tohyee prints the customer's
billing address for this; if the customer has none the screen says so (the
paper can still be printed). Whether an email address, phone number or NZBN
should be printed instead is a question for Jess. If an invoice charges GST
but Settings has no GST number, the screen warns that it isn't a tax
invoice.

Setup: the organisation "Glimmers" with postal address "PO Box 5, Dunedin",
GST number **123-456-789** and payment details "Pay into 12-3456-7890123-00
with your invoice number"; customer Kobe Cafe with billing address "12
George St, Dunedin 9016"; customer Paw Walkers with no address; GST 15%.

- **PD1** INV-0001 (QT3's invoice, 316.25, approved): heading **Tax
  invoice**, number INV-0001, date 20 Jul 2026, due 20 Aug 2026, Glimmers,
  PO Box 5, GST number **123-456-789**, Kobe Cafe and its address, the two
  lines, subtotal **275.00**, GST **41.25**, total **316.25**, paid
  **0.00**, amount due **316.25**, and the payment details.
- **PD2** After a payment of 100.00 on INV-0001: paid **100.00**, amount
  due **216.25**.
- **PD3** An approved tax-inclusive invoice to Kobe Cafe for 1 x
  **1,150.00**: **Tax invoice**, total **1,150.00**, "Total includes GST of
  **150.00**", no separate GST line; over $1,000 so the buyer's address is
  required, and Kobe Cafe has one, so no warning.
- **PD4** The same invoice to Paw Walkers, who has no address, email or
  phone: the screen warns that a tax invoice over $1,000 needs an
  identifier for the customer. With an email address
  (hello@pawwalkers.test) on the contact there's no warning and the email
  is printed under the name (decision 270: IRD accepts an address, phone,
  email, trading name, NZBN or website). At **1,000.00** exactly (1 x
  1,000.00 tax inclusive, GST 130.43) there's no warning.
- **PD5** A draft invoice prints **Draft invoice** with no number, no GST
  number and no payment details; a voided invoice prints **Voided invoice**.
- **PD6** With no GST number in Settings, INV-0001 prints **Invoice**, no
  GST number, and the screen warns it isn't a tax invoice. A no-tax invoice
  prints **Invoice** with no GST lines and no warning.
- **PD7** An approved credit note CN-0001 to Kobe Cafe for 1 x 35.00
  exclusive: **Credit note**, GST number shown, subtotal 35.00, GST 5.25,
  total **40.25**, no due date and no payment details.
- **PD8** QU-0001: **Quote**, expiry 14 Aug 2026, terms, GST **41.25** and
  total **316.25**, no GST number and no payment details. A viewer can print
  it. Printing never posts a journal.

### Not supported yet (refused rather than guessed)

- Emailing documents, a logo and custom layouts (themes), and server-made
  PDF files: the browser's print makes the PDF.
- Printing several documents at once.
- Printing bills and supplier credit notes (they're the supplier's papers).

### Questions for Jess (quotes, repeating invoices and printed documents), decided

Decided on 2 Oct 2026: decisions 270-274 (the buyer's identifier can be an email or phone, PD4). What was asked is kept below.

- Tax invoices over $1,000: Tohyee treats the billing address as the
  buyer's identifier and warns when there isn't one. Should an email
  address, phone number or NZBN count instead (and be printed)?
- Should approved invoices keep the heading **Tax invoice** (as Xero
  prints), or just **Invoice** with the GST number? The heading isn't
  relied on for anything else.
- Quotes have no "sent" status because nothing sends them. When emailing
  is built, should sending be what moves a quote on (as in Xero), and
  should finalising stay a separate step?
- Repeating invoices: should changing how often or the first date on a
  template that has already made invoices start the new schedule from
  today (as built), or ask?
- Should a repeating invoice run that's left as a draft (approval refused)
  notify someone, e.g. by email to the organisation's admins?

## Purchase orders (examples not yet approved by Jess)

Written overnight from Xero's purchase orders (draft, approve, copy to bill,
billed) and NetSuite's billing of purchase orders in parts; Jess hasn't
approved them yet. A purchase order goes to a **supplier** and has the same
lines as a bill (items, units, tracking, custom fields, tax exclusive,
inclusive or no tax) with the same line rules and maths (B1-B4): picking an
item fills the supplier's price (IT6), stock items go to the inventory
account (ST1). It also has an optional **delivery date**, **delivery
address** and **delivery instructions**, and a reference. Purchase orders
**post nothing** to the ledger.

- A **draft** can be edited and deleted.
- **Approving** checks it again as a bill would be checked (an active
  supplier, accounts, tax codes, items, required tracking and custom
  fields), gives it the next number (`PO-0001`, `PO-0002`, ...) from its own
  counter, with no gaps, and **locks** it: the database refuses changing an
  approved purchase order or its lines, or deleting it.
- **Copy to bill** makes a **draft bill** from the same supplier with what's
  left to bill on each line (ordered less what's on bills that aren't
  voided, drafts included), carrying the line's description, price,
  account, tax code, item, unit, tracking and custom fields. Each bill line
  points back to its purchase order line and the bill to its purchase
  order. The supplier's invoice number is typed; the due date is typed or,
  left blank, comes from the supplier's payment terms (SPT4). The draft bill can then
  be edited like any bill (fewer items delivered, a different price), and
  approving it posts the bill's journal as usual. **Stock comes in on the
  bill** (ST1); there's no separate goods received step.
- **Billed** is worked out from the linked bills, never stored or typed:
  per line, what's on **approved** bills is billed and what's on **draft**
  bills is shown separately. A purchase order is **billed** once approved
  bills cover every line. Voiding a bill, or deleting a draft one, puts its
  quantities back.
- A linked bill line keeps its purchase order line's **item and unit**, the
  bill keeps its **supplier**, and the bills that aren't voided never add
  up to **more than was ordered** on a line (anything extra goes on a line
  of its own). The database refuses all three too.
- **Cancelling** an approved purchase order is allowed only while it has no
  bills other than voided ones; it's then closed. Drafts are deleted, not
  cancelled.
- Printing is "Print or save as PDF", like quotes.

Setup (GST 15%): organisation Glimmers, postal address "PO Box 5, Dunedin";
supplier **Paw Supplies**, address "4 Wharf St, Port Chalmers"; item
**WIDGET** (stock, purchase price **5.00**, account 1400, GST) and item
**GIFTBOX** "Gift box" (non-stock, purchase price **2.00**, account 5100,
GST). No locations.

- **PO1** A draft purchase order to Paw Supplies dated 1 Jul 2026, delivery
  date 10 Jul 2026 to "12 Stuart St, Dunedin 9016", tax exclusive, with
  lines of only WIDGET x 10 and GIFTBOX x 100, is filled in as "Widget" 10 x
  **5.00** to 1400 (50.00) and "Gift box" 100 x **2.00** to 5100 (200.00):
  net **250.00**, GST **37.50**, total **287.50**. No journal is posted and
  it has no number. A delivery date before the order date is refused. With
  Advanced reporting on and Paw's own price of 4.80 for WIDGET (IT6), WIDGET
  fills at **4.80**.
- **PO2** Approving PO1 makes it **PO-0001**; editing it is refused (and the
  database refuses changing it or its lines), and so is deleting it. Still
  no journal. A second draft to a supplier that has since been archived is
  refused on approval and stays a draft; the next one approved is
  **PO-0002** (no gap).
- **PO3** Copying PO-0001 to a bill dated 12 Jul 2026, due 20 Aug 2026,
  supplier invoice **PS-101**, makes a draft bill from Paw Supplies with 10
  Widget @ 5.00 to 1400 and 100 Gift box @ 2.00 to 5100, total **287.50**,
  from PO-0001, each line linked to its purchase order line. PO-0001 shows
  10 and 100 on draft bills, 0 billed, nothing left, and is still
  **approved**; copying it again is refused ("already on bills"). The same
  copy retried with the same key returns the same bill. Approving the bill
  posts Dr 1400 **50.00** / Dr 5100 **200.00** / Dr 2100 **37.50** / Cr
  2000 **287.50** and brings in 10 Widgets worth 50.00 (ST1); PO-0001 then
  shows 10 and 100 billed and is **billed**.
- **PO4** Billing in parts: PO-0001 copied to bill PS-201, edited to 6
  Widgets and 40 Gift boxes (a part delivery) and approved, posts Dr 1400
  **30.00** / Dr 5100 **80.00** / Dr 2100 **16.50** / Cr 2000 **126.50**.
  PO-0001 shows 6 of 10 and 40 of 100 billed, 4 and 60 left, and is still
  approved. Copying again (PS-202) makes a draft with 4 Widgets (20.00) and
  60 Gift boxes (120.00): net **140.00**, GST **21.00**, total **161.00**.
  Once that's approved PO-0001 is **billed** (126.50 + 161.00 = 287.50).
- **PO5** Voiding PS-202 (after PO4) puts its 4 and 60 back: PO-0001 is
  approved again with 4 and 60 left, and copying again makes a new draft
  for them. Deleting that draft puts them back too.
- **PO6** On PS-201's draft, 11 Widgets is refused (only 10 were ordered);
  on PS-202's draft after PS-201 was approved with 6, 5 Widgets is refused
  ("at most 4"). Changing a linked line's item, changing the bill's
  supplier, and a bill line naming a purchase order line on a bill that
  wasn't copied from that purchase order are all refused (the database
  refuses them too). A line of its own, Freight 15.00 to 6010, can be
  added to the bill, and a linked line's price can be changed to 5.20 (the
  bill posts 5.20; the purchase order keeps 5.00, since billed counts
  quantities).
- **PO7** Cancelling: an approved purchase order with no bills is
  cancelled and can't then be copied to a bill. A draft can't be cancelled
  (it's deleted instead). A purchase order with a draft bill can't be
  cancelled (refused, and the database refuses too); after the draft bill
  is deleted it can.
- **PO8** Printing PO-0001: headed **Purchase order**, order number
  PO-0001, order date 1 Jul 2026, delivery date 10 Jul 2026, "Deliver to 12
  Stuart St, Dunedin 9016", Paw Supplies and its address, Glimmers and PO
  Box 5, the two lines, subtotal **250.00**, GST **37.50**, total
  **287.50**, and no GST number or payment details (it isn't a tax
  document). A draft prints **Draft purchase order** with no number; a
  cancelled one **Cancelled purchase order**. A viewer can print it.
  Printing never posts a journal.
- **PO10 Closing the rest** (decision 281; Xero's "mark as billed",
  NetSuite's close). After PO4's PS-201 is approved (6 of 10 Widgets and 40
  of 100 Gift boxes billed), the supplier says the rest won't come.
  Closing PO-0001 makes it **closed**: 6 and 40 billed, nothing left to
  bill (the 4 and 60 are no longer on order), and copying it to a bill is
  refused. No journal is posted. Refused: closing a draft, a cancelled or a
  fully billed purchase order, and closing while a draft bill from it
  exists (delete or approve the draft first). Voiding PS-201 afterwards is
  allowed (its 6 and 40 go back to unbilled) and the purchase order stays
  closed. Retried with the same key, closing returns the same purchase
  order.
- **PO9** Saving, approving, copying to a bill and cancelling each return
  the original when retried with the same key, and are refused (409) with
  the same key and different content. A viewer can list and open purchase
  orders but not save them. Across PO1-PO8 the only journals are the
  bills'.

### Not supported yet (refused rather than guessed)

- Emailing purchase orders (so no "sent" status), and Xero's separate
  "awaiting approval" step: a bookkeeper saves and approves.
- Changing an approved purchase order (Xero allows editing): cancel it, if
  it has no bills, and make a new one.
- Closing a part-billed purchase order when the rest will never come (Xero's
  "mark as billed"): it stays approved with what's left shown. Billing more
  than was ordered on a line (put the extra on a line of its own).
- Receiving goods without a bill (goods received notes, NetSuite's item
  receipts): stock comes in when the bill is approved (ST1).
- Copying a purchase order to a new purchase order, making one from a sales
  invoice or quote. (Foreign-currency purchase orders are built: MC28.)

### Questions for Jess (purchase orders), decided

Decided on 2 Oct 2026: decisions 281-284. What was asked is kept below.

- A part-billed purchase order whose rest will never arrive stays
  "approved" with what's left showing. Should there be a way to close it
  (Xero's "mark as billed"), and should that be allowed only when nothing is
  on a draft bill?
- Should approved purchase orders be editable (Xero allows it) as long as
  nothing has been billed, rather than cancel and make a new one?
- Should a bill be allowed to take more than was ordered on a purchase order
  line (the supplier sent extra), or is a separate line right, as built?
- New purchase orders start with the organisation's postal address as the
  delivery address. Would a separate "delivery address" setting (a shop or
  warehouse) be better?

## Stock transfers between locations (examples not yet approved by Jess)

Written overnight from NetSuite's inventory transfers and the weighted
average rules already approved (W1-W12, ST1-ST12); Jess hasn't approved
them yet. A transfer moves a quantity of a **stock item** (in its base
unit) from one location to another on a date:

- It leaves the **from** location at that location's weighted average,
  exactly as stock going out does (W1-W4): quantity x value / quantity on
  hand, rounded once to cents, and the **whole remaining value** when
  everything left there is moved. It arrives at the **to** location at that
  same value, so the to-location's average becomes a mix of the two.
- The inventory account's **total never changes**, and nothing goes to cost
  of sales. Because bills tag their inventory lines with the line's
  Location (ST1), the inventory account does carry Location tags, so a
  transfer posts one journal on its date that moves the value between the
  locations: **Dr 1400 tagged with the to-location / Cr 1400 tagged with the
  from-location**. Its two stock movements ("transferred out" and
  "transferred in") point at that journal and at the transfer. (Cost of
  sales lines on 1400 aren't tagged, ST2, so 1400 by Location in the ledger
  doesn't yet equal stock by location; that's a question for Jess below.)
- The **negative stock** setting applies to the from-location as it does to
  sales (ST9-ST11). Stock can't come into a location that's **below zero**
  by transfer, since only a bill costs a shortfall (ST10).
- Transfers are never changed or deleted (the database refuses); a
  transfer back undoes one. The period lock applies to the date.

Setup: Advanced reporting on, Location values Dunedin, Auckland and
Christchurch; WIDGET (stock, purchase price 5.00); negative stock off.

- **TR1** After a bill of 10 WIDGET @ 5.00 into Dunedin (ST1: Dunedin 10
  worth 50.00), transferring **4** from Dunedin to Auckland on 15 Jun 2026
  moves **20.00**: journal on 15 Jun Dr 1400 [Auckland] **20.00** / Cr 1400
  [Dunedin] **20.00**. Dunedin **6 worth 30.00**, Auckland **4 worth
  20.00**; 1400 still **50.00**; no cost of sales. The movements show
  Dunedin -4 (-20.00) and Auckland +4 (+20.00), both with that journal.
- **TR2** A bill of 3 @ 3.3333 into Dunedin (10.00): transferring 1 moves
  **3.33**, then transferring the other 2 moves the remaining **6.67**
  (W3, W4). Dunedin 0 worth 0.00; Auckland 3 worth **10.00**.
- **TR3** Dunedin 10 worth 50.00 and Auckland 10 worth 70.00: transferring
  4 from Dunedin makes Auckland **14 worth 90.00**; selling 1 from Auckland
  then costs **6.43** (90.00 / 14), leaving Auckland 13 worth 83.57.
  Dunedin stays 6 worth 30.00.
- **TR4** Dunedin 2 worth 10.00, negative stock off: transferring 3 is
  **refused** ("Only 2 on hand"). With negative stock on it moves **15.00**
  (3 at the 5.00 average), leaving Dunedin **-1 worth -5.00** and Auckland
  3 worth 15.00; a transfer back into Dunedin while it's below zero is
  refused.
- **TR5** Refused, with nothing moved: the same location at both ends, a
  quantity of 0, a non-stock item, a date before the item's latest
  movement at either location (backdating, as W's rules), an archived
  destination, a date in a locked period, and an organisation with no
  locations set up.
- **TR6** A retry with the same key returns the same transfer; the same
  key with a different quantity is refused (409). After TR1's transfer the
  bill into Dunedin can't be voided (its stock has moved since, ST4's
  rule). A viewer can list transfers but not make one. Across TR1-TR6
  stock equals account 1400 to the cent (tested).

### Not supported yet (refused rather than guessed)

- Voiding or editing a transfer: make a transfer back.
- Transfers in transit (NetSuite's transfer orders with a ship and receive
  step), several items in one transfer, and transfers in a unit other than
  the item's base unit.
- Backdated transfers (as for every stock movement).

### Questions for Jess (stock transfers), decided

Decided on 2 Oct 2026: decisions 286-287. What was asked is kept below.

- Transfers post a journal between locations on 1400 (Dr to-location / Cr
  from-location) because bills tag 1400 by Location. Cost of sales lines
  on 1400 aren't tagged by location (ST2), so 1400 filtered by Location in
  the ledger won't equal the stock report by location. Should all 1400
  lines carry the location (a change to ST2's journals), or should
  transfers post nothing and stock by location live only in the stock
  report?
- Should a transfer into a location that's below zero be allowed (filling
  the shortfall at the transferred cost, with the difference to cost of
  sales like ST10), rather than refused?

## Budgets (examples not yet approved by Jess)

Written overnight from Xero's budget manager; Jess hasn't approved them yet.
Every organisation has an **overall budget**, which can't be archived, and
can add **named budgets**, each optionally for **one tracking value** (a
Department, or a not-for-profit's grant or segment as a custom segment). A
budget holds an **amount per profit and loss account per month**, in the
account's natural direction (income as credits, costs as debits, so both are
typed as positive amounts), with at most the currency's decimal places.
Budgets **post nothing** and never change a ledger figure.

- Amounts are typed, or **quick filled** for chosen accounts over chosen
  months: the **same amount each month**, optionally changing by a % each
  month (worked out exactly and rounded once per month, so rounding never
  compounds, like Xero's "adjust by % each month"), or **last year's
  actuals** for the same months (filtered to the budget's tracking value
  when it has one), optionally changed by a % (each month rounded once,
  halves away from zero). A quick fill replaces those months' amounts.
- Only **profit and loss accounts** (revenue, other income, direct costs,
  expenses, depreciation) take budget amounts; the database refuses others.
- Budgets are **archived**, never deleted (the database refuses deleting a
  budget or an amount; an amount is set to 0.00 instead). An archived budget
  can't change until it's brought back. Names are unique among budgets that
  aren't archived, ignoring case. A budget's tracking value never changes.
- Every change of amounts is in the history with the amounts before and
  after, and who changed them. Budgets are saved against the version that was
  loaded, so two people can't overwrite each other's changes.
- **Budget vs actual** (Reporting): for whole months, each profit and loss
  account's actual (from the ledger, like the profit and loss, and only lines
  tagged with the budget's value or one under it when it has one), budget,
  **variance** (actual less budget) and **variance %** (variance / budget,
  1 decimal place, halves away from zero, blank when the budget is 0.00),
  with section totals, gross profit and net profit. A positive variance on a
  cost means it's **over** budget.
- **Budget column in custom reports** (TODO item 4): a profit and loss custom
  report can show a chosen budget for its first period, and an **actual less
  budget** column. A published copy keeps the budget figures as they were.

Setup: the starting chart, a 31 March year end, Advanced reporting on,
Department values Retail and Wholesale, and these journals (through 1000;
the 4000 lines tagged as shown, everything else untagged):

| Date | Journal |
| --- | --- |
| 1 Apr, 1 May, 1 Jun 2025 | Dr 6150 Rent 500.00 / Cr 1000 (each) |
| 10 Apr 2025 | Dr 1000 1,000.00 / Cr 4000 700.00 (Retail) / Cr 4000 300.00 (Wholesale) |
| 12 May 2025 | Dr 1000 1,200.00 / Cr 4000 1,200.00 (Retail) |
| 9 Jun 2025 | Dr 1000 800.00 / Cr 4000 800.00 (Wholesale) |
| 1 Apr, 1 May, 1 Jun 2026 | Dr 6150 500.00 / Cr 1000 (each) |
| 10 Apr 2026 | Dr 1000 1,100.00 / Cr 4000 800.00 (Retail) / Cr 4000 300.00 (Wholesale) |
| 12 May 2026 | Dr 1000 1,000.00 / Cr 4000 1,000.00 (Retail) |
| 8 Jun 2026 | Dr 1000 1,300.00 / Cr 4000 1,000.00 (Retail) / Cr 4000 300.00 (Wholesale) |
| 20 Jun 2026 | Dr 6010 Accounting fees 250.00 / Cr 1000 |

- **BU1** A new organisation has one budget, **Overall budget**, which
  can't be archived (the database refuses too). A named budget "Retail
  plan" for Department: Retail is added; a second "retail plan" is refused
  while the first isn't archived. With Advanced reporting off a budget can't
  have a tracking value, and an archived value can't be chosen. Archiving
  Retail plan moves it to the archived list; while archived its amounts
  can't change; bringing it back works. The database refuses deleting a
  budget and changing its tracking value. No journals are posted.
- **BU2** Typing the overall budget's amounts: 4000 Apr 2026 **1,000.00**,
  May **1,000.00**, Jun **1,200.00**; 6150 **500.00** for each of Apr-Jun
  2026; 6010 Jun 2026 **200.00**. The grid for 12 months from Apr 2026 shows
  4000's total **3,200.00** and a total for Apr of **1,500.00**. The history
  shows each amount changed from 0.00. Refused, with nothing saved: account
  1000 (not a profit and loss account; the database refuses too), 10.005
  (three decimal places), a month "2026-13", the same account and month
  twice, and a save against an older version. The database refuses deleting
  an amount.
- **BU3** Quick fill, same amount: 6150 at **500.00** for 12 months from
  Apr 2026 makes every month 500.00 (total **6,000.00**). With **+2%** each
  month the first six months are **500.00, 510.00, 520.20, 530.60, 541.22,
  552.04** (500.00 x 1.02^n, each rounded once).
- **BU4** Quick fill, last year's actuals, Apr-Jun 2026 on the overall
  budget: 4000 becomes **1,000.00, 1,200.00, 800.00**; with **+10%**,
  **1,100.00, 1,320.00, 880.00**; 6150 with **-5%**, **475.00** each month.
  On Retail plan (Department: Retail) 4000 becomes **700.00, 1,200.00,
  0.00**, only last year's Retail lines.
- **BU5** Budget vs actual, the overall budget (BU2), Apr-Jun 2026:

  | Row | Actual | Budget | Variance | % |
  | --- | ---: | ---: | ---: | ---: |
  | 4000 Sales | 3,400.00 | 3,200.00 | 200.00 | 6.3 |
  | Gross profit | 3,400.00 | 3,200.00 | 200.00 | 6.3 |
  | 6010 Accounting fees | 250.00 | 200.00 | 50.00 | 25.0 |
  | 6150 Rent | 1,500.00 | 1,500.00 | 0.00 | 0.0 |
  | Expenses | 1,750.00 | 1,700.00 | 50.00 | 2.9 |
  | Net profit | 1,650.00 | 1,500.00 | 150.00 | 10.0 |

  For June alone: Sales **1,300.00 / 1,200.00 / 100.00 / 8.3**, Expenses
  **750.00 / 700.00 / 50.00 / 7.1**, Net profit **550.00 / 500.00 / 50.00 /
  10.0**. An account with actuals and no budget shows a blank %. A 'from'
  month after the 'to' month is refused.
- **BU6** Budget vs actual for Retail plan with 4000 at **900.00** for each
  of Apr-Jun 2026: actual **2,800.00** (Retail lines only: 800.00 + 1,000.00
  + 1,000.00), budget **2,700.00**, variance **100.00**, **3.7**%. Rent and
  fees aren't tagged Retail, so they aren't in it; net profit **2,800.00 /
  2,700.00 / 100.00 / 3.7**.
- **BU7** A custom profit and loss (CR1) for June 2026 with a budget column
  (the overall budget, BU2) and actual less budget: Revenue **1,300.00 |
  1,200.00 | 100.00**, Expenses **750.00 | 700.00 | 50.00**, Net profit
  **550.00 | 500.00 | 50.00**. With one quarterly column (Apr-Jun 2026) the
  budget column is the three months: Revenue budget **3,200.00**, Net profit
  **1,650.00 | 1,500.00 | 150.00**. Publishing keeps the figures: after June's
  4000 budget changes to 1,250.00 the draft's Revenue budget is **1,250.00**
  and the published copy's still **1,200.00**. Refused: a budget column on a
  balance sheet, an actual less budget column without a budget column, and a
  budget that doesn't exist.
- **BU8** Viewers can list and open budgets and budget vs actual; only
  bookkeepers and admins can add, change, fill and archive them. Across
  BU1-BU8 budgets post no journals.

### Not supported yet (refused rather than guessed)

- **Balance sheet budgets** (Xero has them): budgets hold profit and loss
  accounts only, and the database refuses others.
- A budget for **more than one tracking value** (Xero allows two
  categories): one value per budget.
- Importing and exporting budgets (Xero's CSV), and budget columns on the
  standard profit and loss (they're on custom reports and budget vs actual).
- A budget column for a period other than the custom report's first column,
  and a year to date budget column.

### Questions for Jess (budgets), decided

Decided on 2 Oct 2026: decisions 288-290. What was asked is kept below.

- Variance is actual less budget for every row, so on costs a positive
  variance is over budget. Would you rather costs show budget less actual
  (so positive is always good), as some reports do?
- Should budgets also cover balance sheet accounts, as Xero's do?
- Is one tracking value per budget enough for grants and segments, or do
  you need a budget for a combination (e.g. a Department and a Grant)?

## Expense claims (approved by Jess, 5 Oct 2026)

Written overnight from Xero's (older) expense claims and Tohyee's own bill
and supplier payment rules (B1-B8, SP1-SP8); approved by Jess on 5 Oct 2026,
with the mileage examples (MI1-MI7).
A member (bookkeeper or above) enters the **receipts** they paid for
themselves: date, supplier's name, description, account, tax code and the
amount **including GST**, with optional tracking, and attaches photos or
PDFs of the receipts as files (NF7). The claim is theirs: who made it comes
from the sign-in, never the form.

- A **draft** can be changed or deleted by its claimant only. Receipts go to
  the accounts a bill line can use (B1), except the inventory account (stock
  comes in on bills) and expense claims payable. GST is worked out and
  rounded per receipt from the tax inclusive amount, as on bills (B2). A
  receipt with **no tax code** has no GST: that's how a receipt that isn't a
  valid GST receipt (or a supplier that isn't GST registered) is entered.
- **Submitting** sends it for approval; it then can't be changed (the
  database refuses) until it's approved or declined.
- **Declining** (bookkeeper or above) returns a submitted claim to its
  claimant as a draft, with a reason; it posts nothing.
- **Approving** (bookkeeper or above, but not your own claim unless you're an
  admin or owner) posts one journal on the **claim date** (typed, on or after
  the latest receipt): Dr each receipt's account for its amount excluding GST
  (one line per account and set of tags), Dr GST (2100) for the GST, Cr
  **Expense claims payable** (2010, a new system account; organisations that
  already had a 2010 get the next free code) for the total. Its reference is
  `CLAIM-` and the claim's id.
- **Paying** (in full or in part) posts Dr expense claims payable / Cr the
  bank account on the payment date, like a supplier payment (SP1); it can't
  be more than what's due or dated before the claim. A payment can be voided
  (the exact reversal). What's paid and due is worked out from the payments.
  The bank line matches a statement line in reconciliation like any payment.
- **Voiding** an approved claim with no active payments posts the exact
  reversal on the void date (the database refuses voiding one with active
  payments). Locked periods apply to approving, paying and voiding.
- The **GST return** counts claims like bills: on the invoice basis on the
  claim date (and back on the void date), on the payments and hybrid bases
  when they're paid, each receipt in proportion. Receipts with no tax code
  are left out of the boxes. Filed lines from claims have no contact; they
  show the claimant.
- Claim journals can't be corrected in the ledger; the claim is voided.

Setup: the starting chart, tax code GST (15%), members Jess (owner), Aroha
and Sam (bookkeepers) and a viewer. Sam's claim "June market trip":

| Receipt | Supplier | Account | Tax | Amount | GST | Net |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 3 Jun 2026 | Z Energy, fuel | 6120 Motor vehicle expenses | GST | 69.00 | 9.00 | 60.00 |
| 5 Jun 2026 | Paper Plus, printer paper | 6140 Printing and stationery | GST | 23.00 | 3.00 | 20.00 |
| 6 Jun 2026 | Farmers market, parking | 6180 Travel - national | none | 8.00 | 0.00 | 8.00 |

- **EC1** The draft's total is **100.00**, GST **12.00**, excluding GST
  **88.00**, and posts nothing. Refused: receipts to 1400 (stock), 1000
  (bank), 2010 (expense claims payable) and 2100 (GST), an amount of 0.00 or
  1.001, an unknown tax code, no supplier name. Aroha can't change or delete
  Sam's draft; Sam can (without the parking, 92.00 / GST 12.00). A new
  organisation has 2010 Expense claims payable; an existing one whose 2010 is
  taken gets 2011.
- **EC2** A claim with no receipts can't be submitted. Once submitted it
  can't be changed or deleted (the database refuses changing its receipts
  or deleting it), and it's listed as awaiting approval. Nothing is posted.
- **EC3** Aroha approves it with claim date **10 Jun 2026**: journal
  `CLAIM-n` on 10 Jun, Dr 6120 **60.00** / Dr 6140 **20.00** / Dr 6180
  **8.00** / Dr 2100 **12.00** / Cr 2010 **100.00**. Due **100.00**,
  **unpaid**. Sam (a bookkeeper) can't approve his own claim; Jess (owner)
  can approve hers. A claim date of 5 Jun (before the 6 Jun receipt) is
  refused. A retry with the same key returns the same claim; the same key
  with another date is refused. The database refuses changing an approved
  claim.
  The journal's description is "Expense claim CLAIM-n from Sam" and its
  expense and 2010 lines say "Sam": the claimant's **name**, not their
  email (the email only if they can't be found); paying is "Payment of
  expense claim CLAIM-n to Sam". Journals posted before this was changed
  keep the email they were posted with (posted history isn't rewritten).
- **EC4** Paying **100.00** from 1000 on 15 Jun 2026 posts Dr 2010
  **100.00** / Cr 1000 **100.00**: due **0.00**, **paid**, 2010 back to
  **0.00**. A statement line of -100.00 on 15 Jun matches that bank line
  exactly and reconciles.
- **EC5** Paying **40.00** leaves **60.00** due (**part paid**, awaiting
  payment); 60.01 and a payment dated 9 Jun (before the claim date) are
  refused (the database refuses paying more than the total too); 60.00 more
  makes it **paid**, and a retry with the same key returns the same payment.
  Voiding the 60.00 payment on 20 Jun posts Dr 1000 **60.00** / Cr 2010
  **60.00**; due **60.00** again. A second void, and deleting a payment, are
  refused.
- **EC6** Declining needs a reason. Aroha declines it ("Parking isn't
  claimable"): it's a **draft** again showing the reason, who declined it
  and when. Sam removes the parking and resubmits (**92.00**); it can then
  be approved. Declining a draft or an approved claim is refused. The
  claim's history shows it was made, submitted, declined and approved.
- **EC7** Voiding the approved claim while it has an active payment is
  refused ("Void its payments first"); after the payment is voided, voiding
  on 30 Jun posts Dr 2010 **100.00** / Cr 6120 **60.00** / Cr 6140 **20.00**
  / Cr 6180 **8.00** / Cr 2100 **12.00**. A second void, a void dated before
  the claim date and paying a voided claim are refused.
- **EC8** With the period locked to 30 Jun, approving with claim date 10 Jun
  is refused and the claim stays submitted; approving on 1 Jul works; with
  the lock moved to 1 Jul, paying and voiding on 1 Jul are refused. Only the
  approval posted.
- **EC9** With Department required, submitting a claim whose receipt has
  no Department is refused ("Line 1 needs a Department"); a receipt tagged
  Retail posts its 6120 line tagged Retail, and the GST and 2010 lines
  untagged.
- **EC10** GST return for June 2026, invoice basis: the claim counts on 10
  Jun, Box 11 **92.00** (69.00 + 23.00; the parking has no tax code and is
  left out), Box 12 **12.00**; each line shows the supplier and description
  and the claimant; filed, its lines keep the claimant and no contact.
  Payments basis for July: nothing until it's paid; after **40.00** is paid
  on 15 Jul, Box 11 **36.80** and Box 12 **4.80** (40% of each receipt). A
  second claim approved and voided in June adds nothing.
- **EC11** A PDF of a receipt attached to the claim is listed with it.
  Viewers can list and open claims but can't make them (403); a claim made
  through the API belongs to whoever is signed in.
- **EC12** The approval and payment journals can't be corrected in the
  ledger (void the claim or the payment), and account transactions for 2010
  show them as "Expense claim CLAIM-n" and "Payment of expense claim
  CLAIM-n", linking to the claim.
- **EC13 The supplier's GST number over $200** (decision 293; IRD: taxable
  supply information over $200 shows the seller's GST number). Sam's claim
  "Conference" has two receipts from **Noel Leeming** on 12 Jun 2026, a
  monitor **172.50** (GST 22.50) and a cable **34.50** (GST 4.50): together
  **207.00**, over $200, with GST claimed. Approving it is refused: "Noel
  Leeming's receipt of 12 Jun 2026 is over $200 with GST claimed, so the
  supplier's GST number from the receipt is needed (IRD's taxable supply
  information). Enter it on the receipt, or claim no GST." With the GST
  number **123-456-789** entered on either receipt (stored as 123456789) it's
  approved. A receipt of **200.00** exactly, or one with no tax code, needs
  no GST number. A GST number that isn't 8 or 9 digits is refused.

### Not supported yet (refused rather than guessed)

- **Viewers making their own claims** (Xero's "submit only" role): only
  bookkeepers and above can make claims, since viewers can't change
  anything today.
- **Mileage claims** (a rate per kilometre), **foreign-currency receipts**,
  and receipts on **stock items** (they come in on bills).
- **One payment for several claims** (a batch), and paying claims through a
  bank file.
- Checking what a valid GST receipt needs (IRD's taxable supply
  information: the supplier's GST number over $200, and so on): the claimant
  or approver chooses "No GST" when it isn't one.
- Changing an approved claim: void it (with no payments) and make a new
  one.

### Questions for Jess (expense claims), decided

Decided on 2 Oct 2026: decisions 291-295. What was asked is kept below.

- Should staff who otherwise only view the books be able to make their own
  claims (a new "submit only" role, like Xero's)?
- A bookkeeper can't approve their own claim, but an admin or owner can
  (so a one-person organisation still works). Is that right, or should
  nobody approve their own claim?
- Should Tohyee check the GST receipt rules (e.g. require the supplier's
  GST number on receipts over $200) before GST is claimed?
- Is 2010 "Expense claims payable" a good code, or would you rather claims
  go to accounts payable (2000) as Xero's newer expenses do?
- Should the claim date default to the approval date (as built) or the
  latest receipt's date?

## Bills inbox, reading documents, duplicate bills and mileage (approved by Jess, 5 Oct 2026)

Item 3 of the Xero add-ons plan, after Dext (Jess, 5 Oct 2026: reading
receipts and bills is done by **the AI connected in Tohyee's AI section only**,
decisions 339-348; nothing new is installed; without a connected AI,
documents are stored and typed in by hand). Tohyee itself calls no AI: the
person's own AI connects to Tohyee and uses its tools (decision 339), so a
document is only ever sent to an AI the organisation chose and connected.

### Bills inbox

- Each organisation has a **bills inbox**: supplier bills and receipts that
  have arrived but aren't bills yet. Files come in three ways: uploaded by
  hand (several at once), from a **mailbox folder or Gmail label** (the
  same connections as automatic statement files, BF7: the admin's own CRM
  mailbox or IMAP with an app password; PDF and image attachments are
  taken, other files ignored), or added by the connected AI. Files are the
  kinds a bill can have (NF7: PDF, JPG, PNG, HEIC), up to 10 MB each.
- An inbox item is a file with where it came from (uploaded by whom, or the
  email's sender, subject and date). It's **waiting** until a bill is made
  from it, or someone removes it with a reason (kept in the history, like a
  removed file, NF). Nothing is posted by the inbox itself.
- **Making a bill from an item** opens a new draft bill with the file
  attached (NF7) and the item marked as used by that bill. The supplier's
  defaults fill the lines as for any new bill (SD1-SD3). Typing it in by
  hand always works.
- **With a connected AI** (a key at the draft level or above, decision 346),
  the AI can list the inbox, read an item's file, and **create a draft bill
  from an item**: supplier (an existing contact, or a new supplier it
  names), the supplier's invoice number, dates, lines, amounts and tax
  codes. It's a draft like any other: someone checks it against the file
  and approves it (or a post-level key's owner does, decision 346). The
  draft records that the AI made it (decision 348) and from which item.
- Bookkeepers and above use the inbox; viewers see it.

Setup: Kauri Supplies (supplier, default purchase account 6010, GST); a
connected AI key at the draft level owned by Jess (admin).

- **BI1** Jess uploads `kauri-K-200.pdf` and `cafe.jpg`. The inbox shows two
  waiting items with who uploaded them and when. Nothing is posted.
- **BI2** A rule in Jess's mailbox files supplier emails into the label
  `Bills`, linked to the inbox. An email from accounts@kauri.co.nz with
  `K-201.pdf` and `logo.png` arrives: the check adds **both** (they're image
  and PDF files), each showing the sender and subject; a `.docx` attachment
  is ignored. Each message is read once (as BF7).
- **BI3** From the `kauri-K-200.pdf` item, a bookkeeper makes a bill: a new
  draft for Kauri Supplies with the file attached and one line on 6010 with
  GST (the supplier's defaults). They type invoice number K-200, 1 Oct
  2026, 200.00 + GST 30.00 = **230.00**, and approve it (B1-B3). The item
  shows "Made into bill K-200" and leaves the waiting list.
- **BI4** Jess's AI lists the inbox, reads `K-201.pdf` and calls
  `create_draft_bill_from_inbox_item` with Kauri Supplies, K-201, 3 Oct 2026,
  one line "Timber" 400.00 on 6010 with GST. Tohyee makes the draft (460.00)
  with the file attached, marked "drafted by AI key 'Claude'", and the item
  shows the draft. Nothing is posted until someone approves it.
- **BI5** With no AI connected, the same item is turned into a bill by hand
  (BI3); nothing tells the person to connect one.
- **BI6** `logo.png` isn't a bill: a bookkeeper removes it, reason "Email
  signature". It leaves the waiting list; the history keeps who removed it,
  when and why.
- **BI7** An AI key at the read level can list and read the inbox but not
  make drafts (decision 346); a viewer can see the inbox but not change it.

### Duplicate bills

Today a supplier can't have two bills with the same invoice number (B5,
ignoring case and spaces). Like Dext's duplicate check, Tohyee also
**warns** about likely duplicates it can't be sure of, and asks before
approving one:

- **DU1** The same file arrives twice (the same contents, SHA-256, NF7): the
  second inbox item says "Same file as item 12, made into bill K-200".
- **DU2** A draft for Kauri Supplies of **230.00** dated 2 Oct, invoice
  number "K200A", is saved. It's a different number, so B5 doesn't stop it,
  but bill K-200 is the same supplier and total within 7 days: the draft
  shows "Possibly the same as K-200 (230.00, 1 Oct)". Approving it asks
  "Approve anyway?"; saying yes approves it, and the history says who
  approved it despite the warning.
- **DU3** A bill for a different supplier with invoice number K-200 and the
  same total 230.00 (perhaps the supplier was entered twice) is also warned
  about: "Another supplier has a bill K-200 for the same amount".
- **DU4** Same supplier, same total, 40 days apart (a monthly charge): no
  warning.
- **DU5** The connected AI is told about the warning when it creates a draft
  (the tool's answer includes it), and can't approve past it: approving
  anyway needs a person.

### Mileage on expense claims

Like Dext's mileage: an expense claim (EC1-EC12) can have **mileage lines**
as well as receipts, paid at the IRD kilometre rates.

- **Kilometre rates are a setting**, per income year (1 April - 31 March)
  and vehicle type, entered by an admin. IRD publishes them after the year
  ends; Tohyee starts with the rates IRD published for 2025-26 (OS 19/04,
  in force 4 June 2026): petrol **1.20** (tier 1) / **0.37** (tier 2),
  diesel 1.30 / 0.38, petrol hybrid 0.90 / 0.24, electric 1.22 / 0.23 per
  km. Tier 1 is for the first 14,000 km of a vehicle's travel in a year.
- A mileage line has a date, from, to, purpose, kilometres (one decimal
  place), the vehicle type and the account (default 6120 Motor vehicle
  expenses). Its amount is kilometres times the rate, rounded to the cent.
- **Which year's rates:** the line's income year's rates when an admin has
  entered them; otherwise the latest rates entered, and the line says so
  (question 2).
- **Tier 2:** once a claimant's mileage lines for one vehicle type in an
  income year pass **14,000 km**, the rest are at the tier 2 rate (question
  3). Tohyee can't know a vehicle's private travel, which IRD's threshold
  counts.
- **GST:** mileage lines have no GST (question 4).

Setup: the 2025-26 rates above; no 2026-27 rates entered (IRD hasn't
published them); Mere is a bookkeeper.

- **MI1** An admin sees the 2025-26 rates, can add 2026-27 rates when IRD
  publishes them, and can't change a year's rates once an approved claim
  used them (the claim keeps the rate it was approved at).
- **MI2** Mere adds a mileage line to a claim: 3 Oct 2026, Office to Kobe
  Ltd and back, "Client meeting", **123.4 km**, petrol. There are no 2026-27
  rates, so it uses 2025-26's 1.20: **148.08**, and says "2025-26 rates
  (2026-27 not entered)". No GST.
- **MI3** Mere's petrol mileage lines in the 2026-27 year already total
  13,950 km; a new 120 km line is **50 km x 1.20 + 70 km x 0.37 = 85.90**,
  showing both parts.
- **MI4** 80 km in an electric car: 80 x 1.22 = **97.60**.
- **MI5** Approving the claim (EC) posts the mileage like a receipt: debit
  6120 with 148.08, credit expense claims payable; no GST.
- **MI6** If an admin enters 2026-27 rates later, claims already approved
  keep the 2025-26 rate; drafts are worked out again with the new rates.
- **MI7** Kilometres of 0, negative, or more than 2,000 on one line are
  refused ("Split long trips into days").

**Questions for Jess (bills inbox, duplicates and mileage), decided** (Jess
chose the proposed answers on 5 Oct 2026 and approved the examples the same
day):
1. Documents are read **only by the person's connected AI using Tohyee's
   tools**; Tohyee never sends a document to an AI itself.
2. When a year's kilometre rates aren't published, the **latest rates
   entered** are used and the line says so.
3. Tier 2 after **14,000 km of a claimant's mileage lines** per vehicle type
   per income year; an admin can override the tier on a line.
4. **No GST on mileage lines**, until Jess or her accountant say otherwise.
5. Duplicate warnings **warn and ask, never block**; the AI can't approve
   past one.
6. The expense claim examples EC1-EC12 are approved too.

Not supported yet: reading a document without a connected AI (no OCR is
built in), receipts in the inbox becoming expense claim receipts (bills
only for now), approval workflows (stage 5), supplier statements, and
mileage for vehicles owned by the organisation (that's fringe benefit tax,
not a reimbursement).

## Online invoice payments with Stripe (approved by Jess, 5 Oct 2026)

Item 4 of the Xero add-ons plan, part 1 (PayPal is part 2, written once this
is built). Like Xero's Stripe "Pay now": an approved invoice carries a link
the customer pays by card on Stripe's own page, and Tohyee records the
payment by itself. It builds on Stripe as a bank feed (ST1-ST10): the same
Stripe connection (Jess, answer 8: one connection per provider serves its
feed and its payments), and the same bank account (e.g. 1050 Stripe), which
acts as the clearing account. Card fees and payouts keep arriving through the
feed exactly as ST3 and ST8 describe; this part adds no new way of posting
them.

How it works (checked against Stripe's API reference on 5 Oct 2026; not
tried with a real Stripe account):

- **The payment link.** For an approved invoice with something due, Tohyee
  creates a Stripe **Payment Link** (`POST /v1/payment_links`) with one line,
  "Invoice INV-0010", for the **amount due in the invoice's currency**
  (`line_items[0][price_data]`, quantity 1), limited to **one completed
  payment** (`restrictions[completed_sessions][limit]=1`), with the invoice's
  id in its metadata and the payment description "Payment for INV-0010"
  (`payment_intent_data[description]`), which is what the feed line then
  says (ST3). Nothing about the customer is sent to Stripe; Stripe's page
  asks the customer for their card. The link (`https://buy.stripe.com/...`)
  doesn't expire.
- **Where it appears:** "Pay now" with the link in the invoice email and on
  the PDF, and a "Copy payment link" button on the invoice. The link is
  made the first time it's needed (emailing, printing or copying), not on
  approval, so invoices never sent don't create links.
- **When the amount due changes** (a payment recorded by hand, a credit note
  or overpayment applied), the link is switched off in Stripe
  (`active=false`; anyone opening it sees "This invoice has been paid or
  has changed. Use the latest link from <organisation>.") and a new one is
  made the next time it's needed. Paying, voiding or deleting the invoice
  switches it off too: at once when it's done on the invoice's page, and
  otherwise at the next check.
- **Seeing payments.** Tohyee isn't usually reachable from the internet, so
  it doesn't wait for Stripe to call it (no webhooks): every 15 minutes, and
  with Check now, it asks Stripe for each open link's completed Checkout
  Sessions (`GET /v1/checkout/sessions?payment_link=...&status=complete`).
  A session that's **paid** (`payment_status` `paid`) becomes a **customer
  payment** on the invoice, recorded as any payment is (CP1-CP8):
  - date: the date of Stripe's charge in the organisation's time zone, the
    same date the feed gives its line (ST3);
  - amount: what was paid, in the invoice's currency;
  - into the bank account linked to the Stripe balance the money went to
    (ST2), usually 1050 Stripe;
  - reference: "Stripe" and the payment's id.
  Each session is recorded once (Tohyee keeps the session id). A payment
  method that settles later (a bank debit) is recorded when Stripe says it's
  paid.
- Online payments need the Stripe feed's balance link (ST2) for the
  currency the money lands in; without one, Tohyee doesn't guess an
  account: it shows "A Stripe payment for INV-0010 (115.00) arrived, but no
  bank account is linked to Stripe's NZD balance" until one is linked.

Setup: the ST setup (1050 Stripe linked to the NZD balance; base currency
NZD); Kobe Ltd with INV-0010 for 115.00 including GST, due 20 Oct 2026; the
organisation is Aroha Ltd; online payments turned on.

- **PN1** An admin turns on "Pay now with Stripe" (Settings, Online
  payments). Without a Stripe connection it's refused: "Connect Stripe
  first (Bank accounts, Stripe)." The audit history says who turned it on.
  Bookkeepers and viewers see whether it's on; only admins change it.
- **PN2** INV-0010 is emailed. Tohyee makes a Payment Link for **NZD
  115.00**, "Invoice INV-0010", limited to one payment, and the email and
  PDF say "Pay now by card: https://buy.stripe.com/...". Nothing is
  posted; a viewer printing it doesn't make a link.
  Emailing or printing it again uses the same link. A draft invoice, or one
  with nothing due, gets no link.
- **PN3** Kobe Ltd pays by card on 1 Oct 2026 at 10:15. At the next check
  the session is complete and paid, NZD 115.00. Tohyee records a payment
  of **115.00** on INV-0010 dated **1 Oct 2026** into **1050**, reference
  "Stripe pi_3Q...": Dr 1050 Stripe 115.00 / Cr 1100 Accounts receivable
  115.00. INV-0010 is **paid** and its link is switched off. The invoice's
  history says "Paid online with Stripe". Checking again records nothing
  more.
- **PN4** The feed then brings ST3's lines into 1050: **+115.00** "Payment
  for INV-0010" matches PN3's payment (BK4) and is
  reconciled with OK, so the money is counted once; **-3.41** "Stripe fees"
  is coded as any fee line (a bank rule, BR). The payout (ST8) is a transfer
  to 1000 as before.
- **PN5** INV-0011 for 230.00 has been emailed with its link. Kobe Ltd pays
  100.00 by bank transfer, recorded by hand. The 230.00 link is switched
  off in Stripe, and the next email, print or copy makes a new link for
  **130.00**. Someone opening the old link sees Stripe's "This invoice has
  been paid or has changed. Use the latest link from Aroha Ltd." The
  customer can't choose
  to pay part: the link is always for the whole amount due.
- **PN6** INV-0012 (115.00) is paid by bank transfer and recorded by hand at
  9:00; at 9:05, before the next check switched the link off, Kobe Ltd also
  pays it by card. Tohyee records the card payment anyway, because the money
  did arrive: it's an **overpayment** of **115.00** on Kobe Ltd's account
  (OP4), credit to apply to another invoice or refund, and the invoice shows
  "Paid twice: 115.00 is credit on Kobe Ltd's account".
- **PN7** INV-0020 to a US customer is **USD 50.00**, approved at 1.65
  (NZD 82.50). Its link is in **USD 50.00**. The customer pays; Stripe
  converts it into the NZD balance as **NZD 85.00** (ST4, Stripe's rate
  1.70). Tohyee records a payment of **USD 50.00** into 1050 at the rate
  that gives exactly Stripe's NZD 85.00 (85.00 / 50.00 = 1.7; worked to 8
  decimal places when it doesn't divide evenly), so the payment and the feed
  line agree to the cent: Dr 1050 85.00 / Cr 1100 82.50 (USD 50.00 at 1.65)
  / Cr **7020 Realised currency gains and losses 2.50**, as any foreign
  payment into the base currency (MC6). If the organisation also has a USD Stripe balance linked
  to a USD bank account and the money lands there, the payment goes into
  that account in USD with no conversion.
- **PN8** INV-0010 is refunded in Stripe's dashboard on 3 Oct (Tohyee never
  refunds: it only ever takes money in). The feed brings **-115.00** (ST5).
  Tohyee doesn't change the invoice by itself: the bookkeeper makes a credit
  note for INV-0010 and refunds it from 1050 (CN8), which the -115.00
  line matches.
- **PN9** A card payment is disputed (ST6). The feed brings the dispute and
  its fee; the invoice stays paid. Whoever reconciles decides (a credit note
  if the dispute is lost, for example). Tohyee doesn't watch disputes.
- **PN10** INV-0013 is voided while its link is open: the link is switched
  off. If a payment still arrives for a voided or deleted invoice (paid in
  the minutes before the switch-off), Tohyee records nothing and shows
  "A Stripe payment of 115.00 arrived for INV-0013, which is voided. Refund
  it in Stripe, or record it as a payment or overpayment by hand." The feed
  line is there to reconcile either way.
- **PN11** Turning online payments off, or disconnecting Stripe, switches
  off every open link first (each one it can't reach is listed). Payments
  already recorded stay. Emails and PDFs stop saying "Pay now".
- **PN12** Who: admins turn it on and off; bookkeepers and admins copy links
  and press Check now; viewers see an invoice's link and whether it was
  paid online. Each link and each recorded payment is in the invoice's
  history.

Payments are recorded on the payment date like any other, so GST on the
payments basis counts them then, and on the invoice basis nothing changes.

**Questions for Jess (online payments with Stripe), decided** (Jess chose
every proposed answer and approved the examples on 5 Oct 2026):
1. Taking payments needs the **restricted key** (ST1, read only) to also
   **write payment links** (and the price and product each link makes).
   Proposed: accept a restricted key with those permissions (they can only
   take money in), still refuse full secret keys, and say so on the screen.
   The exact permission names haven't been checked with a real account.
2. **No webhooks for now**: Tohyee checks every 15 minutes and with Check
   now, even when remote access is on. Proposed: yes; webhooks later if
   payments need to show faster.
3. **Paid twice** (PN6): record the extra as an overpayment on the
   customer's account. Proposed: yes.
4. **A payment for a voided invoice** (PN10): a notice only, nothing
   recorded. Proposed: yes.
5. **Which invoices offer Pay now**: every approved invoice with something
   due, in any currency Stripe takes, with a tick on the invoice to leave it
   off (e.g. a large contract paid by bank transfer). Proposed: yes.
6. **Card fees**: always the organisation's cost (from the feed), never
   added to what the customer pays. Proposed: yes (surcharges aren't
   allowed for every card scheme anyway).
7. **Saved cards** (charging a customer's card again without them): not in
   this part. Proposed: later, if wanted.

Tests: `tests/integration/online-payments-stripe.test.ts`.

Not supported in this part: PayPal (part 2), webhooks, saved cards and
automatic charging, surcharges, refunds started from Tohyee, partial
payments chosen by the customer, and Stripe's own invoices or tax.

## Online invoice payments with PayPal (approved by Jess, 5 Oct 2026)

Item 4 of the Xero add-ons plan, part 2, after Stripe (PN1-PN12). The
organisation's existing PayPal connection (PP1-PP10; Jess, answer 8: one
connection per provider) is used, and the same PayPal bank account (e.g.
1060 PayPal) is the clearing account: PayPal's fees, refunds and
withdrawals keep arriving through the feed exactly as PP3-PP8 describe.

**Why PayPal invoices, not PayPal payment links** (checked against PayPal's
developer documentation on 5 Oct 2026; not tried with a real PayPal
account): PayPal's payment links API (`/v1/checkout/payment-resources`)
documents no way to find the payments made through a link, so Tohyee
couldn't record them. PayPal's **Invoicing API** (`/v2/invoicing/invoices`)
keeps each invoice's status and its payments, so Tohyee can. So, for Pay
now with PayPal, Tohyee makes a copy of the invoice in the organisation's
own PayPal account and links to PayPal's page for it (question 1). Orders
(PayPal Checkout) aren't used: their approval links expire after hours, and
Tohyee's own pages usually can't be reached from the internet.

How it works:

- **The PayPal invoice.** When a bookkeeper or admin emails, prints or
  copies an approved invoice with something due, Tohyee creates a PayPal
  invoice (`POST /v2/invoicing/invoices`): the same invoice number, the
  invoice's currency, one item "Invoice INV-0011" for the **amount due**,
  partial payments off (`configuration.allow_partial_payment` false), and
  no customer email address, so PayPal never emails the customer. It then
  makes it payable without sending it (`POST .../send` with
  `send_to_recipient` false), and the link is the invoice's
  `detail.metadata.recipient_view_url`. The customer pays on PayPal's page
  with PayPal (or a card, where PayPal offers it).
- **Where it appears:** beside Stripe's (both when both are on), as "Pay with
  PayPal" in the email, on the PDF and on the invoice (question 3).
- **Seeing payments.** Every 15 minutes and with Check now, Tohyee reads
  each open PayPal invoice (`GET /v2/invoicing/invoices/{id}`). Each new
  `payments.transactions` entry paid through PayPal is recorded once (by its
  `payment_id`) as a customer payment, as PN3: dated `payment_date`, for its
  amount, into the bank account linked to PayPal's balance in the invoice's
  currency (PP2), reference "PayPal" and the payment id.
- **Only invoices in a currency whose PayPal balance is linked** offer Pay
  with PayPal (question 2). A USD invoice offers it only when PayPal's USD
  balance is linked to a USD bank account (e.g. 1070); Tohyee never guesses
  a conversion rate. (PayPal converting a balance later is PP5's transfer.)
- **When the amount due changes**, or the invoice is paid, voided or deleted,
  Tohyee cancels the PayPal invoice (`POST .../cancel`, no notification) and
  makes a new one the next time it's needed, as PN5.

Setup: the PP setup (1060 PayPal linked to NZD, 1070 PayPal USD linked to
USD); Kobe Ltd with INV-0011 for 115.00 due 20 Oct 2026; Acme Inc (USD);
Pay with PayPal turned on; Stripe (PN) off.

- **PPN1** An admin turns on "Pay with PayPal" (Settings, Online payments).
  Without a PayPal connection it's refused: "Connect PayPal first (Bank
  accounts, PayPal)." If PayPal refuses to make invoices for the app (the
  app doesn't have Invoicing), the first email or copy shows PayPal's
  message and the invoice goes without the link.
- **PPN2** INV-0011 is emailed: Tohyee makes PayPal invoice INV-0011 for
  **NZD 115.00** and the email and PDF say "Pay with PayPal:" and PayPal's link to it. PayPal sends the customer
  nothing. Nothing is posted. Emailing it again uses the same one.
- **PPN3** Kobe Ltd pays it with PayPal on 1 Oct 2026. At the next check the
  PayPal invoice is PAID with one transaction `{payment_id "1AB",
  payment_date "2026-10-01", amount NZD 115.00, method PAYPAL}`. Tohyee
  records a payment of **115.00** on INV-0011 dated **1 Oct 2026** into
  **1060**, reference "PayPal 1AB": Dr 1060 115.00 / Cr 1100 115.00.
  INV-0011 is **paid**. Checking again records nothing more.
- **PPN4** The PayPal feed then brings PP3's lines into 1060: **+115.00**
  matches PPN3's payment (BK4) and **-4.12** "PayPal fees" is coded as any
  fee line.
- **PPN5** INV-0012 for 230.00 has its PayPal invoice; 100.00 is paid by
  bank transfer and recorded by hand. Tohyee cancels the PayPal invoice
  and the next email makes a new one for **130.00**, numbered
  INV-0012-2 (PayPal keeps a cancelled invoice's number). The customer
  can't pay part of it on PayPal's page.
- **PPN6** Paid by hand and through PayPal (as PN6): the PayPal payment is
  recorded anyway as an **overpayment** on the customer's account, and the
  invoice says "Paid twice".
- **PPN7** INV-0020 for **USD 50.00** to Acme Inc: PayPal's USD balance is
  linked to 1070, so it offers Pay with PayPal in USD. Paid: Tohyee records
  USD 50.00 into **1070** (a USD account, so no conversion), at the
  payment date's rate as any USD payment into a USD account (MC5), with
  any difference from the invoice's rate on 7020. If PayPal's USD balance weren't linked, the
  invoice wouldn't offer Pay with PayPal: "Link PayPal's USD balance to a
  bank account first."
- **PPN8** A payment for a voided invoice (paid in the minutes before the
  cancel) is a notice only, as PN10; refunds and chargebacks come in only
  through the feed, as PN8-PN9. Tohyee never refunds through PayPal.
- **PPN9** Turning Pay with PayPal off, or disconnecting PayPal, cancels
  every open PayPal invoice first (listing any PayPal couldn't be reached
  for). Payments already recorded stay.
- **PPN10** Who: as PN12. An invoice's "Leave Pay now off" tick (PN, question
  5) leaves off both Stripe and PayPal.

**Questions for Jess (online payments with PayPal), decided** (Jess chose
every proposed answer and approved the examples on 5 Oct 2026):
1. Use **PayPal's invoices** (a copy in the organisation's own PayPal
   account, with PayPal's page to pay it) rather than payment links, so
   Tohyee can see each payment. Proposed: yes.
2. **Only invoices in a currency whose PayPal balance is linked** offer Pay
   with PayPal; Tohyee never guesses a rate. Proposed: yes.
3. With Stripe and PayPal both on, the email and PDF show **both links**.
   Proposed: yes.
4. The PayPal invoice has **one line for the amount due** (not every line,
   and no GST of its own), and **no customer email address**, so PayPal
   doesn't email or remind the customer. Proposed: yes.
5. The answers for Stripe (overpayments, notices for voided invoices, no
   surcharges, no saved cards, every invoice unless left off, checking every
   15 minutes) apply to PayPal too. Proposed: yes.

Tests: `tests/integration/online-payments-paypal.test.ts`.

Not supported in this part: PayPal Checkout (orders), PayPal's own invoice
emails and reminders, partial payments chosen by the customer, refunds
from Tohyee, and recording a PayPal payment PayPal converted into another
currency.

## Approval workflows (approved by Jess, 5 Oct 2026)

Item 5 of the Xero add-ons plan, like ApprovalMax (and NetSuite's approval
routing): rules that send a bill or purchase order through one or more
approval steps before it's approved, with the budget shown at approval, an
email to each approver, and the history of who approved what. Today a
bookkeeper approves a draft in one step; that stays exactly as it is when
no rule applies.

How it works:

- **Rules** (admins, Settings, Approval rules) are per document type:
  bills, purchase orders and expense claims (question 1). A rule has
  **conditions** (all must hold: total at least an amount, in the base
  currency; the supplier, or for a claim the claimant; an account on any
  line; a tracking value on any line) and **steps** in
  order. Each step names **approvers** (members, bookkeeper or above) and
  whether **any one** or **all** of them must approve. Rules are checked in
  their order; the first that matches is used. A document no rule matches
  is approved as today.
- **Submitting.** A draft that a rule matches can't be approved directly:
  "This bill needs approval (rule: Over $1,000). Submit it for approval."
  Submitting freezes it: it stays a draft (it posts nothing) but can't be
  edited, and step 1's approvers are asked. Editing it means withdrawing
  it first, which ends the request; submitting again starts from step 1
  (question 5).
- **Approving.** An approver of the current step approves or declines (with
  a reason). When a step is done, the next step's approvers are asked.
  When the last step is done the document is **approved as today** (a bill
  posts on its bill date, B1-B3; a purchase order becomes approved, PO2),
  by the last approver, with the period and other checks as usual; if those
  checks refuse it (a locked period), the request waits and says why. A
  decline sends it back to draft with the reason, for the person who
  submitted it.
- **Nobody approves their own** (question 4): whoever submitted (or made)
  the document can't approve any step of it, whatever their role.
- **Budget at approval** (question 3): the approval page shows, for each
  profit and loss account on the document (and its tracking value, if a
  budget has one), the month's budget (BU), what's been spent so far in the
  month (the ledger, like budget vs actual), this document, and what's
  left, with "Over budget by 150.00" in red. It's shown, never blocks.
- **Asking approvers.** The approvals page (Purchases, Approvals) lists
  what's waiting for the signed-in person. Each approver is also emailed
  (through the organisation's email, if it's set up) with the document,
  its total and a link to the approval page. **Following the link needs
  signing in to Tohyee as that person** (question 2): nothing can be
  approved from the email alone. The link only works where Tohyee can be
  reached (the office network, or remote access).
- **History.** Every submit, approval, decline, withdrawal and the final
  approval is in the document's history (who, when, which step, the
  reason), and the approval page shows the steps with who did each.
- **Connected AI** (decisions 346-348): an AI key can submit a document it
  drafted (draft level and above) but can't approve or decline a step
  (question 6): `approve_bill` on a document under a rule says it needs a
  person's approval.
- A repeating bill set to approve (RB) that a rule matches is submitted for
  approval instead, and its run says so.

Setup: Jess (owner), Mere and Tama (bookkeepers), Ana (admin); Kauri
Supplies; the overall budget for 6010 Accounting fees in October 2026 is
1,000.00 and 900.00 has been spent; Department values Retail and Wholesale.
Rule **"Over $1,000"** for bills: total at least 1,000.00; step 1 any one
of Tama or Ana; step 2 all of Jess.

- **AW1** An admin adds the rule. Refused: no steps; a step with no
  approvers; a viewer as an approver; an amount below 0. A bookkeeper can
  see the rules but not change them. The history says who changed a rule.
- **AW2** Mere's draft bill from Kauri for **460.00** doesn't match the
  rule: she approves it directly, as today (B1).
- **AW3** Mere's draft bill K-300 for **1,150.00** (1,000.00 + GST, 6010)
  matches. Approving it directly is refused: "This bill needs approval
  (rule: Over $1,000). Submit it for approval." She submits it: it's still
  a draft, nothing is posted, and editing it is refused ("Withdraw it from
  approval first"). Tama and Ana are asked (the approvals page and an
  email each); Jess isn't yet.
- **AW4** The approval page shows the budget: 6010 October budget
  **1,000.00**, spent **900.00**, this bill **1,000.00** (excluding GST),
  left **-900.00**: "Over budget by 900.00". Approving isn't blocked.
- **AW5** Tama approves step 1. Ana is no longer asked (any one of them).
  Step 2: Jess is asked. Jess approves: K-300 is **approved** and posted on
  its bill date, Dr 6010 1,000.00 / Dr GST 150.00 / Cr accounts payable
  1,150.00, approved by Jess. The history lists submitted (Mere), step 1
  approved (Tama), step 2 approved (Jess), bill approved.
- **AW6** Mere can't approve her own submitted bill at any step, even if
  she were an approver; neither can Jess approve a bill she made herself.
  A step whose only approver is the submitter can never be done, so saving
  a rule warns when a step has one approver, and the approval page says
  "Only Jess can approve this step, and Jess submitted it": an admin then
  changes the rule's approvers, and the request continues with them.
- **AW7** Ana declines step 1 of another bill with the reason "Wrong
  supplier". It goes back to Mere as a draft she can edit, showing the
  reason. Submitting again starts at step 1.
- **AW8** Mere withdraws a submitted bill to fix a line: it's an ordinary
  draft again; approvals already given are dropped (they're in the history).
- **AW9** A step of "all of Tama and Ana": both must approve before step 2;
  the page shows who has and who hasn't.
- **AW10** The period is locked to 30 September when Jess approves step 2
  of a bill dated 28 September: the approval is refused as any approval
  would be (period locks), and the request stays at step 2, saying why.
  After the lock date is changed (or the bill re-dated: withdraw, edit,
  resubmit), Jess approves again.
- **AW11** A rule for purchase orders "Tama for Retail": any line tagged
  Department: Retail, one step with Tama. A purchase order with a Retail
  line goes to Tama; once approved it's an approved purchase order (PO2) and
  can be billed. Rules are tried in order: a bill matching two rules uses
  the first.
- **AW12** The email to Tama has the bill's supplier, number, total and a
  link to its approval page. Opening the link signed out shows the sign-in
  page, then the approval page. The link can't approve anything by itself,
  and opening it as another member shows "Waiting for Tama or Ana" with no
  buttons.
- **AW13** Jess's AI key (post level) drafts a 1,150.00 bill and submits it
  (allowed). Its `approve_bill` is refused: "This bill needs a person's
  approval (rule: Over $1,000)." The AI can list what's waiting but not
  approve or decline.
- **AW14** A repeating bill set to approve, whose bill matches the rule, is
  submitted instead; its run shows "Submitted for approval (rule: Over
  $1,000)".

**Expense claims** (question 1) already have a submit step (EC2). With a
rule, submitting a claim starts the rule's steps instead of waiting for any
bookkeeper (EC3), and declining a step is EC6's decline.

- **AW15** Rule "Claims over $300" for expense claims: total at least
  300.00; one step, any one of Ana or Jess. Tama's claim for **345.00** is
  submitted (EC2): it's waiting for Ana or Jess. Mere (a bookkeeper, not an
  approver) can't approve it, though without a rule she could (EC3).
- **AW16** Ana approves the step, choosing the claim date as EC3's approver
  does: the claim is **approved** and posted as EC3 (Dr each account and
  GST / Cr expense claims payable), approved by Ana. If Ana declines with a
  reason instead, it goes back to Tama as a draft with the reason, exactly
  as EC6.
- **AW17** Jess's own claim for 400.00 matches the rule: Jess can't approve
  it (nobody approves their own, question 4, even an owner, although
  without a rule EC3 lets an owner approve their own); Ana does. A claim for
  120.00 matches no rule and is approved as EC3 today. Tama can withdraw a
  submitted claim back to draft (as AW8).

**Questions for Jess (approval workflows), decided** (Jess, 5 Oct 2026:
expense claims too for question 1, the proposed answer for every other
question, and the examples approved):
1. **Which documents:** bills, purchase orders **and expense claims**
   (Jess). Sales invoices and journals aren't included.
2. **Approving from an email:** the email links to Tohyee and the approver
   **must sign in**; nothing is approved from the email alone. The link only
   works where Tohyee can be reached (office network or remote access).
   Proposed: yes (no single-use "approve" links that work without signing
   in).
3. **Budget at approval:** shown, never blocks; the overall budget, or a
   budget for the line's tracking value when there is one. Proposed: yes.
4. **Nobody approves their own document** in a workflow, whatever their
   role (owners included). Proposed: yes.
5. **Editing a submitted document** needs withdrawing it, and submitting
   again starts from step 1. Proposed: yes.
6. **The connected AI can submit but never approve or decline a step.**
   Proposed: yes.
7. **Amounts in rules** are compared in the base currency (a USD bill at
   its rate). Proposed: yes.

Not supported in this part: approving from a single-use link without
signing in, delegating approvals while someone's away, reminders and
escalation after a time, approval rules for sales invoices or journals,
approval by text message, and blocking over-budget documents.

Built (decisions 424-431, tenant migration 0100). Test:
`tests/integration/approval-workflows.test.ts` (AW1-AW17).

## Cash flow forecast (approved by Jess, 5 Oct 2026)

Item 6 of the Xero add-ons plan, part 1. It works like NetSuite's Cash 360
(and Xero's short-term cash flow): what's expected to come into and go out of
the bank, worked out from what's already in the books. It **posts nothing**.
The only thing it stores is the forecast items a person adds.

How it works (proposed, following Cash 360):

- **Start:** the ledger balance of the chosen bank accounts today, in the
  business time zone. All bank accounts are chosen by default; credit cards
  can be added.
- **Periods:** days, weeks (Monday to Sunday) or months, counted from the
  period with today in it, for 3 months by default (Cash 360's default),
  up to 12. Each period shows money in, money out, the net and the closing
  balance. The lowest closing balance is pointed out, and so is the first
  period that closes below zero.
- **Money in:**
  - Approved sales invoices with something still due, after payments and
    credit, on their due date. Overdue ones go in the first period, marked
    overdue. Cash 360 also puts open invoices in by due date, and Tohyee
    doesn't predict late payment.
  - Repeating invoices due to be made, for their total, on the due date their
    template gives them.
  - Ticked: approved **sales orders**, for what's not yet invoiced, on their
    expected date (else their order date) plus the customer's payment terms.
- **Money out:**
  - Approved bills, in the same way as invoices.
  - Repeating bills.
  - Approved expense claims still to be paid. They have no due date, so they
    go in the first period.
  - Ticked: approved **purchase orders**, for what's not yet billed, on their
    delivery date (else their order date) plus the supplier's payment terms.
- **Account averages** (Cash 360's account categories): for chosen accounts
  (e.g. 6200 Wages), the average daily movement over the last 3 or 6 whole
  months. Each period gets that daily amount times its number of days,
  rounded per period. This is how wages get in without Tohyee guessing pay
  days. (Built: the GST account's movement nets GST collected against GST
  paid, so it doesn't measure GST payments; GST is a forecast item, decision
  434.)
- **Forecast items** (Cash 360's additional values; bookkeepers add them):
  money in or out, with a date and an amount, once or repeating every week
  or month until a date. For example, "GST payment".
- **Other currencies:** an amount due in another currency is converted at
  the latest rate on or before today: the exchange rates list's rate, or else
  the last rate used. Tohyee never guesses a rate. With no rate, the amount
  is left out and listed.
- **Drafts:** draft invoices and bills are left out unless "include drafts"
  is ticked, and then they're marked as drafts.
- **Drill-down and export:** every amount opens the documents it's made of.
  The forecast is exported like other reports (CSV, Excel, PDF).

Setup:

- Kowhai Ltd, NZD. Today is **Monday 5 Oct 2026**.
- Bank accounts: 1000 Business account **12,000.00** and 1010 Savings
  **5,000.00**, so the forecast starts at **17,000.00**.
- Weekly periods, 13 weeks: week 1 is 5-11 Oct, week 2 is 12-18 Oct, and so
  on to week 13, 28 Dec-3 Jan.
- The exchange rates list has a USD rate of 1.6500 NZD per USD from 1 Oct.

- **CF1** Money in from invoices:
  - INV-0101 Aroha Cafe, due 30 Sep, **2,300.00** still due: week 1,
    marked overdue.
  - INV-0102 Kobe Ltd, due 15 Oct, **1,150.00**: week 2.
  - INV-0103 Pacific Co, USD 1,000.00 due 20 Oct: **1,650.00** at 1.6500,
    week 3.
  - INV-0104 Tui Ltd, total 2,000.00 with 500.00 paid, due 31 Oct:
    **1,500.00**, week 4.
  - A voided invoice and a paid one aren't in the forecast.
- **CF2** Money out from bills and claims:
  - K-301 Kauri, **460.00** due 9 Oct: week 1.
  - K-300 Kauri, **1,150.00** due 20 Oct: week 3.
  - Approved claim CLAIM-12, **345.00** unpaid: week 1.
- **CF3** Repeating documents:
  - A repeating invoice to Aroha Cafe, 575.00 a month from 1 Nov, due 20
    days after it's made: **575.00** on 21 Nov (week 7) and on 21 Dec
    (week 12).
  - A repeating bill for rent, 2,300.00 on the 1st of each month, due the
    same day: 1 Nov (week 4), 1 Dec (week 9) and 1 Jan 2027 (week 13).
  - A paused template isn't in the forecast. A template that ends on 30 Nov
    gives only 1 Nov.
- **CF4** Mere adds a forecast item "GST payment": money out, **3,200.00**
  on 28 Oct (week 4). The history says who added and changed it.
- **CF5** The forecast:

  | Week | In | Out | Closing |
  | --- | ---: | ---: | ---: |
  | 1 (5-11 Oct) | 2,300.00 | 805.00 | 18,495.00 |
  | 2 | 1,150.00 | 0.00 | 19,645.00 |
  | 3 | 1,650.00 | 1,150.00 | 20,145.00 |
  | 4 | 1,500.00 | 5,500.00 | 16,145.00 |
  | 5, 6 | 0.00 | 0.00 | 16,145.00 |
  | 7 | 575.00 | 0.00 | 16,720.00 |
  | 8 | 0.00 | 0.00 | 16,720.00 |
  | 9 | 0.00 | 2,300.00 | 14,420.00 |
  | 10, 11 | 0.00 | 0.00 | 14,420.00 |
  | 12 | 575.00 | 0.00 | 14,995.00 |
  | 13 (28 Dec-3 Jan) | 0.00 | 2,300.00 | **12,695.00** |

  Lowest closing balance: **12,695.00**, in week 13. Shown by month instead,
  the same amounts give October in 6,600.00 / out 5,155.00 (rent on 1 Nov is
  in November).
- **CF6** Account average for 6200 Wages over the last 3 months: July,
  August and September 2026 (92 days) total 36,800.00, which is **400.00 a
  day**. That's **2,800.00** out each week (12,400.00 in October by month).
  Week 13 now closes at 12,695.00 - 36,400.00 = **-23,705.00**. The first
  week below zero is week 6 (9-15 Nov), which closes at **-655.00**.
- **CF7** "Include sales orders and purchase orders" ticked:
  - SO-0004 to Kobe Ltd, 2,300.00 with 1,150.00 already invoiced, expected
    1 Oct; Kobe's terms are 20th of the next month. **1,150.00** comes in on
    20 Nov (week 7).
  - PO-0007 from Kauri, 920.00 with nothing billed, delivery 14 Oct, with
    supplier terms of 14 days. **920.00** goes out on 28 Oct (week 4).
  - Both are marked as from orders.
- **CF8** "Include drafts" ticked: a draft invoice to Kobe for 400.00 due 8
  Oct adds 400.00 to week 1, marked as a draft. A USD invoice when there's
  no USD rate at all is left out and listed: "INV-0105 (USD 300.00): no USD
  exchange rate to convert it."
- **CF9** Viewers can see the forecast; only bookkeepers add forecast items
  and choose the accounts to average. The connected AI (any level) can read
  it with `cash_flow_forecast`.

Built (decisions 432-436, tenant migration 0101). Test:
`tests/integration/cash-flow-forecast.test.ts` (CF1-CF9).

## Consolidation (approved by Jess, 5 Oct 2026)

Item 6, part 2. It works like NetSuite OneWorld and Syft's consolidations:
one profit and loss and balance sheet for a group of organisations on the
same Tohyee server. The organisations can be in **different currencies and
have different year ends**. Everything is converted into the group's
currency and intercompany amounts are eliminated.

Jess's answers (5 Oct 2026):

- Only organisations on the same server, with eliminations.
- Only people who are members of every organisation in it can see it.
- Organisations with different year ends and currencies can still be
  consolidated, so one report covers the whole group across all countries,
  as in NetSuite.

A consolidation posts nothing in any organisation's books. Its exchange
rates and elimination adjustments live only in the consolidation.

How it works (proposed):

- **The group:**
  - A consolidation group has a name, a **parent organisation** and the other
    organisations in it.
  - It's made by someone who is an admin or owner of every organisation in
    it.
  - It's seen by anyone who is a member (viewer or above) of every one.
    Someone who stops being a member of one stops seeing it.
- **The group's currency and year:**
  - The group reports in the parent's base currency, with the parent's year
    end.
  - Members with another year end are fine. Every report is worked out from
    each member's ledger by date, so "this year" and "current year earnings"
    always mean the group's year, whatever the member's own year end. (This
    is how NetSuite lines subsidiaries' periods up to the parent's calendar.)
- **Daily rates come in from the European Central Bank** (Jess, 5 Oct 2026;
  NetSuite's Currency Exchange Rate Integration does the same with its own
  providers). An admin turns this on for an organisation. Each working day
  Tohyee reads the ECB's euro reference rates and adds a rate for each
  foreign currency the organisation uses to its exchange rates list (MC48),
  with the source "European Central Bank".
  - Rates against the organisation's base currency are worked out through
    the euro: NZD per AUD = (NZD per EUR) / (AUD per EUR), rounded to 6
    decimal places.
  - A rate someone typed for a date is never replaced.
  - The ECB publishes about 30 currencies, once each working day, and says
    its rates are for information. A currency it doesn't publish is typed in
    as today.
- **Consolidation exchange rates** (NetSuite's consolidated exchange rates)
  are worked out by Tohyee, for each member currency and month, from the
  parent's exchange rates list (group currency per 1 unit of the member's
  currency):
  - **Current:** the rate in effect on the last day of the month.
  - **Average:** the member's profit and loss amounts in the month, each
    times the rate on its date, divided by their total (NetSuite's weighted
    average).
  - **Historical:** the same, using the member's equity amounts (capital,
    drawings).
  - A month with no amounts of a kind needs no rate of that kind.
  - An admin can change a month's rates, with a reason. A changed rate isn't
    worked out again, and the history keeps both.
  - A report that needs a rate the list doesn't have is refused, and the
    refusal lists the dates.
- **Budget exchange rates** (NetSuite's budget exchange rates table; Jess,
  5 Oct 2026): one rate per member currency per month, typed in or imported.
  Budgets hold only profit and loss accounts, so one rate a month is enough.
  These rates convert each member's budget for the **consolidated budget vs
  actual**. Actuals use the consolidation rates.
- **Translation** (as NetSuite and IAS 21: current, average and historical
  rates by account class):
  - **Profit and loss:** each month at that month's average rate.
  - **Assets and liabilities:** at the current rate of the report date's
    month.
  - **Equity** (capital, drawings): each month's postings at that month's
    historical rate.
  - **Earnings:** the sum of the translated profit and loss.
  - The difference left over is the **foreign currency translation reserve**,
    on its own line in equity.
- **Accounts:** they're matched by code across the organisations and shown
  with the parent's name for the code. This is the nearest Tohyee can get to
  NetSuite's one shared chart. Each report has a column per organisation (in
  the group currency), an eliminations column and the consolidated total. A
  member's column can also be shown in its own currency.
- **Intercompany** (NetSuite's intercompany accounts, with "Eliminate
  Intercompany Transactions" ticked):
  - In each organisation, an admin marks the accounts that hold amounts with
    another group member, naming that member.
  - What members owe each other in accounts receivable and payable is found
    from the contact each organisation links to the other organisation.
  - All of these are eliminated.
  - If the two sides don't agree, both are still eliminated. The difference
    shows on its own line, "Intercompany differences (check these)", with a
    warning, so the balance sheet still balances and nothing is hidden
    (question 1). This includes differences from exchange rates.
- **Elimination adjustments** (bookkeepers of every organisation): lines by
  account code and organisation, with a date and a description. For example,
  the investment in a subsidiary against its share capital. They're in the
  group currency and post nothing in any organisation.
- **Ownership:** only wholly owned members are supported, so there's no
  minority interest. Standard NetSuite doesn't work minority interest out
  either; it's done there with journals or an add-on (question 2).

Setup:

- **Kowhai Holdings Ltd** (the parent): NZD, 31 March year end.
- **Kowhai Retail Ltd**: NZD, 31 March year end.
- **Kowhai Pty Ltd**: AUD, **30 June** year end.
- All three are on the same server.
- Jess is the owner of all three. Mere is a bookkeeper of Retail only.
- Holdings and Retail:
  - Holdings lent Retail 10,000.00 (Holdings 1150 Loan to Kowhai Retail;
    Retail 2150 Loan from Kowhai Holdings).
  - Holdings invested 4,000.00 in Retail's shares (Holdings 1160 Investment
    in Kowhai Retail; Retail 3000 Owner funds introduced 4,000.00).
  - Holdings invoices Retail a management fee of 1,000.00 + GST each month
    (Holdings 4150 Management fees; Retail 6250 Management fees).
  - October's fee, 1,150.00, is unpaid. Holdings' contact "Kowhai Retail
    Ltd" and Retail's contact "Kowhai Holdings Ltd" are linked to each
    other's organisation.
- Kowhai Pty Ltd started on 1 Sep 2026, when AUD 9,000.00 of capital was
  paid in (3000). In October it sold AUD 5,000.00 (4000) and spent
  AUD 3,000.00 (6200), all through its bank.
- Holdings' exchange rates list (from the ECB) has, in NZD per AUD,
  1.1000 for every day in September, 1.1200 for 1-30 October and 1.1500 on
  31 October.

- **CO1** Jess makes "Kowhai group" with Holdings as the parent, so it
  reports in NZD with a 31 March year end.
  - Kowhai Pty Ltd joins although its currency (AUD) and year end
    (30 June) differ.
  - Mere can't see the group, because she isn't a member of Holdings. A
    viewer of all three can.
  - Someone who isn't an admin of Kowhai Pty Ltd can't add it.
- **CO2** Holdings marks 1150 and 4150 as intercompany with Retail. Retail
  marks 2150 and 6250 as intercompany with Holdings.
- **CO3** Consolidation rates for AUD:
  - September: current 1.1000; historical 1.1000 (the capital paid in on
    1 Sep); no average, because there was no profit or loss.
  - October: current **1.1500** (31 Oct); average **1.1200**, which is
    (5,000.00 x 1.1200 + 3,000.00 x 1.1200) / 8,000.00. Had the sales been on
    a day at 1.1100 and the wages on a day at 1.1400, the average would have
    been (5,000.00 x 1.1100 + 3,000.00 x 1.1400) / 8,000.00 = **1.121250**.

  Kowhai Pty Ltd's October profit and loss, translated at 1.1200:
  - Sales AUD 5,000.00 = **5,600.00**.
  - Wages AUD 3,000.00 = **3,360.00**.
  - Net profit AUD 2,000.00 = **2,240.00**.
  - If Holdings' list had no AUD rate on or before 10 Oct, the report would
    be refused: "Holdings' exchange rates list has no AUD rate for 10 Oct
    2026."
- **CO4** Consolidated profit and loss, October 2026 (NZD):

  | Account | Holdings | Retail | Pty (NZD) | Eliminations | Consolidated |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | 4000 Sales | | 20,000.00 | 5,600.00 | | 25,600.00 |
  | 4150 Management fees | 1,000.00 | | | -1,000.00 | 0.00 |
  | 5000 Cost of goods sold | | 8,000.00 | | | 8,000.00 |
  | 6010 Accounting fees | 200.00 | | | | 200.00 |
  | 6200 Wages and salaries | | 6,000.00 | 3,360.00 | | 9,360.00 |
  | 6250 Management fees | | 1,000.00 | | -1,000.00 | 0.00 |
  | **Net profit** | **800.00** | **5,000.00** | **2,240.00** | **0.00** | **8,040.00** |

- **CO5** Kowhai Pty Ltd's balance sheet at 31 Oct 2026, translated:
  - Bank AUD 11,000.00 at the month-end rate 1.1500 = **12,650.00**.
  - Capital AUD 9,000.00 at September's historical rate 1.1000 (the month
    it was paid in) = **9,900.00**.
  - Current year earnings 2,240.00 (CO3; no profit or loss in September).
  - Foreign currency translation reserve 12,650.00 - 9,900.00 - 2,240.00 =
    **510.00**.
  - Its own year started on 1 July, but in the group, "current year" means
    the group's year, from 1 April 2026.
- **CO6** Consolidated balance sheet at 31 Oct 2026, before adjustments:
  - Holdings: 1000 bank 4,800.00, 1100 receivable 1,150.00 (all from
    Retail), 1150 loan 10,000.00 and 1160 investment 4,000.00, totalling
    19,950.00; GST 150.00, 3000 19,000.00 and current year earnings 800.00.
  - Retail: bank 17,000.00 and 1410 goods for resale 3,000.00 (bought
    outside the stock records; 1400 only moves with stock items), totalling
    20,000.00; 2000 payable 1,150.00 (all to Holdings), 2100 GST -150.00
    (claimable on Holdings' fee, on the GST liability account), 2150 loan
    10,000.00, 3000 4,000.00 and current year earnings 5,000.00. (Corrected 5 Oct 2026 when built: as first written,
    Retail's bank was 17,150.00 with no GST, which doesn't follow from the
    setup; the totals were the same.)
  - Kowhai Pty Ltd as in CO5.
  - Eliminated: the loan (10,000.00 on each side) and what's owed (1,150.00
    on each side). Both organisations' GST (Holdings owes 150.00, Retail can
    claim 150.00) is on 2100, so it nets to 0.00.
  - Consolidated assets: bank **34,450.00**, goods for resale **3,000.00**
    and investment **4,000.00**, totalling **41,450.00**.
  - Consolidated liabilities and equity: GST **0.00**, 3000 **32,900.00**,
    current year earnings **8,040.00** and foreign currency translation
    reserve **510.00**, totalling **41,450.00**.
- **CO7** Jess adds the elimination adjustment "Investment in Retail" at 31
  Oct 2026: Dr Retail 3000 4,000.00 / Cr Holdings 1160 4,000.00.
  - The consolidated balance sheet is now assets **37,450.00** = 3000
    **28,900.00** + earnings **8,040.00** + reserve **510.00**.
  - Refused: an adjustment that doesn't balance; an account code an
    organisation doesn't have; an adjustment by Mere, who isn't a bookkeeper
    of Holdings (to her the group doesn't exist).
  - Nothing is posted in any organisation.
- **CO8** Different year ends: the consolidated profit and loss for the
  group's year to date, 1 Apr-31 Oct 2026, includes Kowhai Pty Ltd's
  September and October (each at its own month's average rate), although
  Pty's own year started on 1 July. A report for 1 Jul 2026-30 Jun 2027 can
  be run too: any dates work, and only the "year" totals follow the
  parent's year.
- **CO9** Differences: if Retail had recorded the loan as 9,950.00, with
  50.00 put elsewhere, both sides are still eliminated. "Intercompany
  differences (check these)" shows **50.00**, with "Holdings 1150 10,000.00
  and Retail 2150 9,950.00 don't agree". It's an asset line when the difference is a debit
  (as here) and a liability line when it's a credit, so the totals are
  41,500.00 on both sides.
- **CO10** The connected AI can read a consolidation (question 3, Jess):
  `list_consolidations` and `consolidated_report` show the groups whose
  every organisation the key's owner can see, as they'd see them. It can't
  change groups, rates or adjustments.
- **CO11** Consolidated budget vs actual, October 2026: Kowhai Pty Ltd's
  overall budget for 4000 Sales is AUD 4,500.00 and its October budget rate
  is **1.1000**, so its budget is **4,950.00**. Its actual is 5,600.00 (CO3).
  With Retail's 4000 budget of 18,000.00, the group's 4000 budget is
  **22,950.00** against an actual of **25,600.00**.
- **FX1** Holdings (NZD) turns on ECB rates. The ECB's rates for 5 Oct 2026
  are, per EUR, NZD 1.9000 and AUD 1.7000, so Holdings' list gets AUD
  **1.117647** on 5 Oct, from "European Central Bank". A rate Jess typed for
  5 Oct stays, and the ECB one isn't added. Weekends and ECB holidays get
  no rate; the rate before them applies (MC48). Kowhai Pty Ltd (AUD) gets
  NZD 1.7000 / 1.9000 = **0.894737** for 5 Oct. If the ECB can't be reached,
  the next run tries again, and the settings show when the last rates came
  in.

Built (decisions 437-445, core migration 0007, tenant migration 0102).
Test: `tests/integration/consolidation.test.ts` (CO1-CO11, FX1). AI
commentary is item 6 part 3.

**AI commentary** (item 6): the plan says "AI commentary as a suggestion
only". NetSuite 2025.1 writes explanations of variances and trends next to
its reports with its own built-in AI. Tohyee has no built-in AI, only the
connected one (decisions 339-348). Proposed: the connected AI can save a
commentary on a forecast or consolidated report. It's shown as "Suggested by
Jess's AI key Claude, not checked" until a person edits or accepts it, and
it can be removed (question 5).

- **AC1 (the forecast):** Jess's AI key Claude (draft level) reads the
  forecast and suggests "Cash dips in week 6 when GST is paid." for
  "Weeks from 5 Oct 2026 to 3 Jan 2027". It shows as **Suggested by Jess's
  AI key Claude, not checked**. Vic (viewer) can read it but not accept or
  add one. Mere (bookkeeper) edits it to "Cash dips in week 6 when GST of
  4,200.00 is paid." and accepts it: it then shows who suggested it and
  that Mere checked it. Mere's own commentary is accepted when written. A
  removed one disappears from the report but is kept with who removed it.
  A read-only key can't suggest one.
- **AC2 (a group):** the same key suggests "Management fees eliminate." on
  the group's October profit and loss. Vic (viewer of every member) reads
  it but can't accept or add; Mere, who isn't in every member, can't see the
  group at all. Jess accepts it as it is and writes her own on the balance
  sheet. The amounts in the reports never change.

Built (decision 446, core migration 0008, tenant migration 0103). Test:
`tests/integration/report-commentary.test.ts` (AC1, AC2).

**Questions for Jess (cash flow forecast and consolidation), decided**
(Jess, 5 Oct 2026: show differences, wholly owned only, AI commentary as a
suggestion, forecast like Cash 360, the AI can read groups, rates from the
ECB with budget rates typed, and the examples approved):
1. **Intercompany amounts that don't agree:** show the difference on its
   own line (proposed), or refuse to show the report until they agree? (We
   couldn't find what NetSuite does here.)
2. **Members not wholly owned:** not supported for now (proposed), as in
   standard NetSuite?
3. **The connected AI and consolidations:** Jess: a key can read the groups
   its owner can see.
4. **Consolidation rates:** Jess: rates come in (from the ECB), and the
   consolidation, current and historical rates are worked out from them, as
   in NetSuite, with budget exchange rates typed per month.
5. **AI commentary:** saved as a labelled suggestion that a person accepts,
   edits or removes (proposed)?

## Fixed assets (examples not yet approved by Jess)

Written overnight from Xero's fixed asset register and NZ practice; Jess
hasn't approved them yet. **Tohyee has no built-in IRD depreciation rates,
asset classes, low-value thresholds, pool or building rules.** The
organisation types the method and annual rate for each asset type (and can
change them per asset); check IRD's current rates and rules before entering
them. The rates below are just the example's.

- **Asset types** (admins) say which accounts an asset uses: its **asset
  account** (cost) and **accumulated depreciation account** (fixed or
  non-current asset accounts, not the same one), and its **depreciation
  expense account** (an expense account), with a default method and rate.
  Types are archived, never deleted, and their accounts can't change once
  they have assets. The starting chart already has 1600-1650 and 6300
  Depreciation; new system accounts **7030 Gain or loss on disposal of fixed
  assets** and **7040 Capital gains on disposal of fixed assets** (other
  income) are the default for disposals (existing organisations get them at
  that code or the next free one).
- **Registering an asset posts nothing**: its cost is already in the ledger
  from the bill, bank transaction or opening journal that bought it. An
  asset can name the **approved bill line** it came from (on its type's
  asset account); the cost defaults to what's left of the line excluding GST,
  and assets from one line never cost more than it. A bill with a registered
  asset can't be voided until the asset is archived. Numbers are
  `FA-0001`, with no gaps. An asset brought in from another register has an
  **opening balance date** (a month end) and the **accumulated depreciation**
  at that date; depreciation starts the month after.
- **Methods**, charged in whole months: **diminishing value (DV)** is the
  book value at the start of the financial year (or when the asset's
  depreciation started, if later) x rate x months / 12; **straight line
  (SL)** is cost x rate x months / 12; **no depreciation** (e.g. land) charges
  nothing. Neither takes the book value below the **residual value** (0
  unless set). Each financial year's figure so far is rounded once, half
  away from zero, and a run charges it less what's already been charged that
  year, so monthly runs add up exactly to one run for the year (a run
  spanning two financial years rounds once for each).
- **Part months** are a setting (admins). The month an asset is bought
  **counts as a whole month** (the default: our understanding of IRD's
  guidance is that the month of purchase counts in full, but check it) or
  isn't depreciated. The month it's disposed of **isn't depreciated** (the
  default) or counts as a whole month. Changing them affects only
  depreciation worked out afterwards.
- A **depreciation run** (bookkeepers) to a month end charges each
  registered asset for the months since it was last charged (so an asset
  registered late catches up) and posts **one journal** on the month end,
  reference `DEP-YYYY-MM`: Dr depreciation expense / Cr accumulated
  depreciation, one pair per asset type (and set of tracking tags, from the
  asset), types in name order. Runs go forward: each is after the last
  active run; none in a locked period. The **latest** run can be **rolled
  back** (the exact reversal on its own date, which must be open), then run
  again. Idempotent.
- A **disposal** (bookkeepers) of a registered asset, dated after the last
  run (roll the run back to dispose earlier), posts on the disposal date:
  depreciation for the months since it was last charged (by the disposal
  month setting), Dr accumulated depreciation / Cr cost to take it off, Dr
  the **proceeds** excluding GST out of the account the sale was coded to
  (any account but bank, card, receivables, payables, GST, expense claims
  payable and stock), and the difference: proceeds above book value up to
  cost are **depreciation recovered** (Cr the gain or loss account), above
  cost a **capital gain** (Cr the capital gain account), below book value a
  **loss** (Dr the gain or loss account). A write-off has no proceeds. An
  asset is disposed of once; the disposal can be **undone** (the exact
  reversal on the disposal date), and a run it was worked out from can't be
  rolled back until it is.
- After depreciation or a disposal, only an asset's name, description and
  tracking change; before, anything can, and an asset registered by mistake
  is archived (never deleted). Runs, disposals and their journals can't be
  corrected in the ledger.
- The **register** as at a date lists each asset held with cost,
  accumulated depreciation, book value and this financial year's
  depreciation, grouped by type with totals; assets disposed of this year
  apart with their gain or loss; and, per asset and accumulated depreciation
  account, the register beside the ledger balance and the difference
  (e.g. from a manual journal to one of them).

Setup: the starting chart, 31 March year end, tax code GST (15%), Jess
(owner) and Aroha (bookkeeper). Asset types:

| Type | Asset | Accumulated | Expense | Default |
| --- | --- | --- | --- | --- |
| Computer equipment | 1620 | 1630 | 6300 | DV 50% |
| Motor vehicles | 1640 | 1650 | 6300 | DV 30% |
| Office equipment | 1600 | 1610 | 6300 | SL 20% |

Assets:

| Asset | Bought | Cost | Method | How the cost got to the ledger |
| --- | --- | ---: | --- | --- |
| FA-0001 Laptop | 10 May 2026 | 2,000.00 | DV 50% | PB Tech bill PB-7781, 2,300.00 incl. GST to 1620 |
| FA-0002 Desk | 1 Apr 2026 | 1,200.00 | SL 20% | journal Dr 1600 / Cr 1000 |
| FA-0003 Printer | 1 Jul 2023 | 1,500.00 | DV 40% (not the type's) | opening journal 31 Mar 2026: Dr 1600 1,500.00 / Cr 1610 900.00 / Cr 3000 600.00; opening accumulated depreciation 900.00 at 31 Mar 2026 |
| FA-0004 Ute | 20 Jun 2026 | 30,000.00 | DV 30% | journal Dr 1640 / Cr 2800, registered after the May run |

- **FA1** Types as above; also Land (no depreciation, no rate). Refused: an
  asset account that isn't a fixed asset account (6070), the same account
  for cost and accumulated depreciation, an expense account that isn't an
  expense (1000), a rate of 0 or 101, no rate for DV, a rate for no
  depreciation, a second active "Motor vehicles". A bookkeeper can't add
  types (403); a viewer can list them. Types can't be deleted (archived). A
  new organisation has 7030 and 7040; an existing one whose 7030 is taken
  gets 7031 and 7040, and the settings default to "whole month" and "not
  depreciated".
- **FA2** Registering the laptop from its bill line: cost **2,000.00** (the
  line excluding GST), bought **10 May 2026** (the bill date), DV 50% (the
  type's), `FA-0001`, book value **2,000.00**; no journal is posted and 1620
  stays **2,000.00**. Refused: a cost of 2,000.01 from that line, the line
  for a Motor vehicles asset (it's on 1620), and once registered any more
  from the line (the database refuses too). Voiding the bill is refused
  ("registered as fixed asset FA-0001"); after archiving the asset it can
  be voided. Typed in, refused: no cost, no purchase date, a residual value
  above the cost, opening depreciation with no date, an opening date that
  isn't a month end or is before the purchase, opening depreciation above
  the cost, DV/SL with no rate. The desk is `FA-0002` (no gap), a section of
  land with no depreciation `FA-0003`. A retry with the same key returns the
  same asset.
- **FA3** Run to **31 May 2026**: laptop May **83.33** (2,000.00 x 50% x
  1/12 = 83.333...), desk Apr-May **40.00** (1,200.00 x 20% x 2/12), printer
  Apr-May **40.00** (600.00 book value x 40% x 2/12). Journal `DEP-2026-05`
  on 31 May: Dr 6300 **83.33** / Cr 1630 **83.33** / Dr 6300 **80.00** / Cr
  1610 **80.00**, total **163.33**. Laptop book value **1,916.67**; printer
  accumulated **940.00**. A run to 15 Jun is refused (not a month end). In
  the maths: a printer run straight to 30 Apr 2027 charges **240.00** for
  the year to 31 Mar 2027 and **12.00** for April 2027 (360.00 x 40% x
  1/12); a tool costing 1,000.00, residual 400.00, SL 50%, charges 500.00,
  then 83.33, then **16.67** (not 41.67), then 0.00.
- **FA4** After registering the ute, run to **30 Jun 2026**: laptop
  **83.34** (2 months so far 166.67, less 83.33), desk **20.00**, printer
  **20.00**, ute **750.00** (30,000.00 x 30% x 1/12; June counts in full).
  Journal: Dr 6300 **83.34** / Cr 1630 / Dr 6300 **750.00** / Cr 1650 / Dr
  6300 **40.00** / Cr 1610, total **873.34**. A retry returns the same run;
  the key for another date is refused. Refused: another run to 30 Jun or 31
  May (the database refuses an earlier run too), deleting a run, changing
  its lines, and a run to 31 Jul once July is locked.
- **FA5** Rolling back May while June stands is refused. Rolling back June
  posts `VOID-DEP-2026-06` on **30 Jun**: the exact reversal (Dr 1630
  **83.34** / Cr 6300, Dr 1650 **750.00** / Cr 6300, Dr 1610 **40.00** / Cr
  6300); 1650 is **0.00**; a second rollback is refused; running June again
  gives **873.34**. With June locked, rolling that run back is refused.
- **FA6** A **monitor** (FA-0005, Computer equipment, 600.00, bought 20 May
  2026) registered after the June run. Run to **31 Aug 2026** (two months):
  laptop **166.66** (4 months 333.33 less 166.67; the same as 83.33 +
  83.33 monthly), desk **40.00**, printer **40.00**, ute **1,500.00**,
  monitor May-Aug **100.00** (catching up). Journal: Dr 6300 **266.66** / Cr
  1630, Dr 6300 **1,500.00** / Cr 1650, Dr 6300 **80.00** / Cr 1610, total
  **1,846.66**.
- **FA7** With "the month an asset is bought isn't depreciated": the ute
  gets nothing in June (a run with nothing to post posts no journal) and
  **750.00** in July. Either run can be rolled back.
- **FA8** After runs to 31 May, 30 Jun and 31 Aug (no monitor), the ute's
  accumulated depreciation is **2,250.00** (750.00 + 1,500.00). It's sold on
  **15 Sep 2026** for 28,750.00 incl. GST, invoiced (here journalled) to 4100
  Other revenue: proceeds **25,000.00** excluding GST, cleared from 4100.
  September isn't depreciated (the default). Book value **27,750.00**, loss
  **2,750.00**. Journal `FA-0004` on 15 Sep: Dr 1650 **2,250.00** / Cr 1640
  **30,000.00** / Dr 4100 **25,000.00** / Dr 7030 **2,750.00**; 1640, 1650
  and 4100 are back to **0.00**. Refused: a disposal dated 31 Aug (on or
  before the last run: roll it back first), proceeds with no account, 1000
  or 1100 as the proceeds account, 1600 as the gain or loss account, a
  proceeds account with no proceeds, disposing of it again. The September
  run leaves it out, and the register at 30 Sep lists it as disposed on 15
  Sep, proceeds **25,000.00**, gain (loss) **-2,750.00**, depreciation this
  year **2,250.00**, with 1640 and 1650 at **0.00** on both sides. With
  "the disposal month counts" instead, September's **750.00** is charged
  first: Dr 6300 **750.00** / Cr 1650 **750.00** / Dr 1650 **3,000.00** /
  Cr 1640 **30,000.00** / Dr 4100 **25,000.00** / Dr 7030 **2,000.00**.
- **FA9** The desk (accumulated **100.00**, book value **1,100.00**) sold
  on 20 Sep 2026 for **1,300.00**: Dr 1610 **100.00** / Cr 1600 **1,200.00**
  / Dr 4100 **1,300.00** / Cr 7030 **100.00** (depreciation recovered) / Cr
  7040 **100.00** (capital gain). The printer (accumulated **1,000.00**, book
  value **500.00**) sold for **700.00**: Dr 1610 **1,000.00** / Cr 1600
  **1,500.00** / Dr 4100 **700.00** / Cr 7030 **200.00** (depreciation
  recovered, no capital gain).
- **FA10** The laptop written off on **10 Oct 2026**: September is
  charged, **83.34** (5 months 416.67 less 333.33), so accumulated
  **416.67**, book value **1,583.33**, all a loss. Journal "Write-off of
  FA-0001 Laptop": Dr 6300 **83.34** / Cr 1630 **83.34** / Dr 1630 **416.67**
  / Cr 1620 **2,000.00** / Dr 7030 **1,583.33**.
- **FA11** With the ute sold (FA8), rolling back the August run is refused
  ("Undo the disposal of FA-0004 first"); deleting the disposal and changing
  the ute's cost are refused. Undoing it posts `VOID-FA-0004` on **15 Sep**
  (Cr 1650 **2,250.00** / Dr 1640 **30,000.00** / Cr 4100 **25,000.00** / Cr
  7030 **2,750.00**); the ute is registered again, depreciated to 31 Aug,
  book value **27,750.00**; a second undo is refused; the September run
  charges it **750.00**. The desk written off on 5 Oct blocks rolling back
  September until that's undone too.
- **FA12** With Advanced reporting on and the ute tagged Department Farm,
  a run straight to 30 Jun posts Dr 6300 **166.67** / Cr 1630 (untagged),
  Dr 6300 **750.00** / Cr 1650 (both tagged Farm), Dr 6300 **120.00** / Cr
  1610 (untagged); every line of its disposal is tagged Farm.
- **FA13** The register as at **30 Jun 2026** (after FA4), year from 1 Apr
  2026:

  | Asset | Cost | Accumulated | Book value | This year |
  | --- | ---: | ---: | ---: | ---: |
  | Computer equipment: FA-0001 Laptop | 2,000.00 | 166.67 | 1,833.33 | 166.67 |
  | Motor vehicles: FA-0004 Ute | 30,000.00 | 750.00 | 29,250.00 | 750.00 |
  | Office equipment: FA-0002 Desk | 1,200.00 | 60.00 | 1,140.00 | 60.00 |
  | Office equipment: FA-0003 Printer | 1,500.00 | 960.00 | 540.00 | 60.00 |
  | Office equipment total | 2,700.00 | 1,020.00 | 1,680.00 | 120.00 |
  | **Total** | **34,700.00** | **1,936.67** | **32,763.33** | **1,036.67** |

  Ledger: 1600 **2,700.00**, 1610 **1,020.00** (credit), 1620 **2,000.00**,
  1630 **166.67**, 1640 **30,000.00**, 1650 **750.00**, each with no
  difference. As at 31 May (no ute, no June run): cost **4,700.00**,
  accumulated **1,063.33**. After a manual journal Dr 6130 50.00 / Cr 1600
  50.00 on 30 Jun, 1600 shows register **2,700.00**, ledger **2,650.00**,
  difference **-50.00**. Viewers can open it.
- **FA14** Before any run the desk's cost and name can change; after the
  May run, changing its cost or rate is refused ("only its name,
  description and tracking") while its description can change; the laptop
  can't be archived (not even directly in the database) or deleted, and the
  type's asset account can't change. A viewer can list runs but can't run
  depreciation (403). The run and disposal journals can't be corrected in
  the ledger, and account transactions for 1610 show "Depreciation run
  DEP-2026-05" (linking to the depreciation screen) and "Disposal of
  FA-0002" (linking to the asset).
- **FA15** (decision 337, not yet approved by Jess) Depreciation can be run
  up to the end of the current month (in the business time zone), not
  later: on 2 Oct 2026 a run to 31 Mar 2027 is refused ("Depreciation can
  be run up to the end of this month (31 Oct 2026)"), so this year's
  figures don't include months that haven't happened. An asset registered
  after a run that covers its purchase month still catches up in the next
  run (FA6). Test: `tests/integration/fixed-assets.test.ts` (FA4).

### Not supported yet (refused rather than guessed)

- **Built-in IRD rates, asset classes, low-value asset write-offs, pooling
  and building rules**: the organisation enters rates and methods; a
  low-value item is simply expensed on the bill.
- **Tax and book depreciation side by side** (Xero's tax/book views): one
  set of depreciation is kept.
- Depreciating by days, or part months other than the two settings; changing
  an asset's method or rate after it's depreciated (roll back its runs
  first); revaluations and impairments; partial disposals and splitting an
  asset.
- Disposing of an asset before the last run without rolling the run back,
  and GST on the sale (the sale is invoiced as usual; the disposal clears
  its amount excluding GST).
- Registering assets from bank transactions, expense claims or journals by
  link (they're typed in with their cost).

### Questions for Jess (fixed assets), decided

Decided on 2 Oct 2026: decision 296 (folded into the ERP fixed assets plan). What was asked is kept below.

- Should the month an asset is bought count as a whole month (as built,
  the default), and the disposal month not be depreciated (the default)?
  Please check both against IRD's current guidance and your practice.
- IRD has its own rules for depreciation in the year an asset is disposed
  of (please check them): should Tohyee keep a separate tax depreciation
  figure beside the book one, or is one set enough for now?
- Is 7030/7040 right for gains, losses and capital gains, or should
  depreciation recovered go to its own account (it's taxable income, while
  a capital gain usually isn't)?
- Should low-value assets (under IRD's current threshold) be offered as an
  immediate write-off when registering, and should pooling be built?
- Should a run be allowed to skip a month (as built, a run covers every
  month since the last one, so nothing is skipped), or must runs be monthly?

## Projects and time tracking (examples not yet approved by Jess)

Written overnight from Xero Projects; Jess hasn't approved them yet. A
**project** is work for one **customer**: a name, an optional **estimate**
(money, excluding GST) and an optional **deadline**. It is **In progress**
or **Closed**, and only the Close and Reopen actions change that. Projects,
their tasks, time and expenses **post nothing**; only the invoices made
from them do (as ordinary invoices, I1-I9).

- **Tasks** have a **charge type**: **hourly** (a rate per hour), **fixed
  price** (billed once, whole) or **non-chargeable** (never billed), and an
  optional estimate in hours and minutes. Tasks are archived, never deleted.
  A task's charge type, and a fixed task's price, can't change once
  something on it has been invoiced (an hourly rate can: what's invoiced
  keeps its amount).
- **Time entries**: a member, a date, a task, a **duration stored as whole
  minutes** (entered as hours and minutes, 1 minute to 24 hours) and a
  description. Bookkeepers enter their own time; admins and owners can also
  enter and change time for another member of the organisation.
- **Staff cost rates** (admins set them, per member, per hour, 0.00 if not
  set) give each entry its **cost**: minutes x cost rate / 60, rounded to
  the cent (half away from zero) per entry. The rate is copied onto the
  entry when it's entered, so a later change of rate doesn't change earlier
  entries. Costs are for profitability only and never post to the ledger.
- **Expenses** are **linked, not re-posted**: an approved bill's line, an
  approved expense claim's receipt or a spend money line is linked to a
  project with its cost **excluding GST** (the line's net amount), a
  **chargeable** flag and an optional **markup %**. Only lines coded to
  expense or direct cost accounts count (PJ13); a fixed asset bought or a
  prepayment isn't a project cost. A line can be on one
  project at a time. Its **charge** is cost x (100 + markup) / 100, rounded
  to the cent. Stock lines (the inventory account) aren't linked: stock is
  costed when it's sold. While linked, the bill, claim or spend money can't
  be voided (the database refuses); remove the link first (only while it
  isn't invoiced).
- **Unbilled** means: time on hourly tasks, fixed price tasks (not archived)
  and chargeable expenses that aren't on an invoice that isn't voided, and
  haven't been written off.
- **Invoice**: the chosen unbilled items become one **draft sales
  invoice** for the project's customer, to one revenue account and tax code
  chosen when invoicing (tax exclusive; no tax code means no tax), due by the
  customer's payment terms unless a due date is given. Lines, in this
  order: per hourly task, its chosen time at the task's current rate (the
  quantity is the hours when they're exact to 4 decimal places, else 1 at
  the amount, minutes x rate / 60 rounded to the cent); per fixed task, 1 at
  its price; per expense, 1 at its charge. Each item is linked to the
  invoice so it can't be invoiced twice (the database refuses). **Voiding**
  the invoice, or **deleting** the draft, makes its items unbilled again.
  The draft can be edited like any invoice; its items stay linked to it.
- **Closing** is refused while anything is unbilled or a project invoice is
  still a draft, unless the unbilled items are **written off** as part of
  closing (they're then never billed, and stay written off if the project
  is reopened). A closed project takes no new tasks, time, expenses or
  invoices, and its invoices can't be voided or deleted until it's reopened
  (the database refuses all of these).
- **Profitability** per project: **invoiced** (the approved project
  invoices' totals excluding GST), **costs** (linked expenses at cost plus
  time at cost), **profit** (invoiced less costs), what's **on draft
  invoices**, **unbilled** time, fixed prices and expenses, **written off**,
  and the **estimate** against invoiced plus unbilled; per task, estimated
  against actual hours. The **time report** lists entries in a date range,
  by person, project and task, with hours and cost.
- A project is in its **customer's currency**: for a customer in another
  currency, its rates, prices, estimate and invoices are in it, while costs
  and profit stay NZD (MC61-MC70).

Setup (GST 15%): customer **Harbour Cafe** (payment terms 20th of the
following month), supplier **Paw Supplies**; members Jess (owner), Aroha
and Sam (bookkeepers) and a viewer. Jess sets **staff cost rates**: Jess
**40.00**, Aroha **30.00** an hour (Sam none). Project **Cafe rebrand** for
Harbour Cafe, estimate **2,000.00**, deadline 31 Aug 2026, with tasks
**Design** (hourly, **90.00**, estimate 10 h), **Photography** (fixed price
**600.00**) and **Admin** (non-chargeable).

| Date | Who | Task | Time | Minutes | Cost |
| --- | --- | --- | --- | ---: | ---: |
| 1 Jul 2026 | Jess | Design | 2 h 30 min | 150 | 100.00 |
| 2 Jul 2026 | Aroha | Design | 1 h 15 min | 75 | 37.50 |
| 3 Jul 2026 | Jess | Admin | 45 min | 45 | 30.00 |
| 3 Jul 2026 | Aroha | Photography | 4 h | 240 | 120.00 |

| Expense | Account | Net (cost) | Chargeable | Markup | Charge |
| --- | --- | ---: | --- | ---: | ---: |
| Bill PS-300, 4 Jul, "Printing of menus" 200.00 + GST | 6140 | 200.00 | yes | 10% | 220.00 |
| Aroha's claim, 5 Jul, Z Energy "Fuel to shoot" 69.00 incl. GST | 6120 | 60.00 | no | | |
| Spend money, 6 Jul, "Props" 46.00 incl. GST | 6070 | 40.00 | yes | 0% | 40.00 |

- **PJ1** Creating Cafe rebrand posts nothing; it's **In progress** and
  listed under Harbour Cafe. Refused: a contact that isn't a customer, an
  archived customer, no name, an estimate of -1.00 or 1.005, a status
  typed in (there's no such field; only Close and Reopen change it). A
  retry with the same key returns the same project; the same key with a
  different name is refused. Projects can't be deleted (the database
  refuses).
- **PJ2** Tasks: Design stores rate 90.00 and an estimate of **600**
  minutes (10 h). Refused: an hourly task with no rate, a non-chargeable
  task with a rate, a fixed price of 600.005 or 0.00. Archiving Admin keeps
  it (deleting is refused by the database) and new time on it is then
  refused; its existing time still counts.
- **PJ3** Time: Jess's 2 h 30 min is stored as **150** minutes with cost
  rate 40.00 and cost **100.00**; Aroha's 1 h 15 min, **75** minutes, cost
  **37.50**. Refused: 0 minutes, 24 h 1 min, 1.5 minutes, a date that isn't
  a date, a task from another project. Aroha (bookkeeper) can't enter or
  change time for Jess, or set cost rates; Jess (owner) can enter time for
  Aroha, but not for someone who isn't a member. Sam's time costs **0.00**
  (no rate). After Jess changes her rate to 50.00, her earlier entry still
  costs 100.00 and a new 1 h entry costs 50.00. No journal is posted.
- **PJ4** Expenses: linking the bill line, the receipt and the spend money
  line gives costs **200.00**, **60.00** and **40.00** (excluding GST) and
  charges **220.00** (10% markup) and **40.00**; the fuel isn't chargeable.
  Refused: a line of a draft bill, the same line on a second project (the
  database refuses too), a receive money line, a stock line (1400), a markup
  of -5 or 10.001. Voiding bill PS-300 while it's linked is refused (the
  database refuses); after removing the link it can be voided. Linking
  posts nothing.
- **PJ5** Unbilled after PJ3 and PJ4: Design 225 minutes (3 h 45 min) x
  90.00 / 60 = **337.50**, Photography **600.00**, expenses **260.00**
  (220.00 + 40.00): **1,197.50** in all. The Admin time and the fuel are
  costs only.
- **PJ6** Invoicing everything unbilled on 10 Jul 2026 to 4000 with GST
  makes a **draft invoice** for Harbour Cafe, due **20 Aug 2026** (its
  terms), with lines "Design (3 h 45 min)" 3.75 x **90.00** = **337.50**,
  "Photography" 1 x **600.00**, "Printing of menus" 1 x **220.00**, "Props"
  1 x **40.00**: subtotal **1,197.50**, GST **179.63** (50.63 + 90.00 + 33.00
  + 6.00, per line), total **1,377.13**. Nothing is posted until it's
  approved, which posts Dr 1100 **1,377.13** / Cr 4000 **1,197.50** / Cr
  2100 **179.63** as for any invoice. Unbilled is then **0.00**; invoicing
  any of those items again is refused ("already on invoice"), and the
  database refuses linking them twice. The same request retried with the
  same key returns the same invoice; the same key with other items is
  refused. Invoicing nothing, a non-chargeable task's time, or a fixed
  price task's time (the price is billed, not the time) is refused.
- **PJ7** Durations that aren't exact hours to 4 decimal places: 10 minutes
  of Design is invoiced as "Design (10 min)" 1 x **15.00** (10 x 90.00 /
  60); 12 minutes as 0.2 x 90.00 = **18.00**.
- **PJ8** Deleting PJ6's draft invoice makes all **1,197.50** unbilled
  again. Invoiced again, approved and then voided on 15 Jul, the items are
  unbilled again and can be invoiced a third time. While on an invoice that
  isn't voided, a time entry can't be changed or removed and an expense's
  markup, chargeable flag or link can't be changed (the database refuses
  them too); after the void they can.
- **PJ9** Profitability. Before invoicing: invoiced **0.00**, costs
  **587.50** (time **287.50** + expenses **300.00**), profit **-587.50**,
  unbilled **1,197.50**. With PJ6's draft: **1,197.50** on draft invoices,
  invoiced still 0.00. Once approved: invoiced **1,197.50**, profit
  **610.00**, unbilled **0.00**; estimate **2,000.00** against invoiced plus
  unbilled 1,197.50, **802.50** left. Design: estimated 10 h, actual **3 h 45
  min**.
- **PJ10** Closing: refused while 1,197.50 is unbilled, and while the
  project invoice is a draft; once it's approved the project closes. A
  closed project refuses new tasks, time, expenses and invoicing, and
  voiding its invoice is refused until it's reopened (the database refuses
  all of these). Reopened, 30 minutes more Design (**45.00**) is entered;
  closing is refused, then closing **with write-off** closes it and marks
  that entry written off: unbilled **0.00**, written off **45.00**, its cost
  (15.00 at Aroha's rate) still counts. Reopened again, the entry stays
  written off and invoicing it is refused.
- **PJ11** Time report for July 2026: Jess **3 h 15 min** (195 minutes,
  cost 130.00), Aroha **5 h 15 min** (315 minutes, cost 157.50); by task
  Design 3 h 45 min, Photography 4 h, Admin 45 min; total **8 h 30 min**,
  cost **287.50**. For 1-2 Jul only: 3 h 45 min. Filtered to Aroha: 5 h 15
  min. A removed entry isn't listed.
- **PJ12** A viewer can list and open projects and run both reports but
  can't create, change or invoice anything (403). Every command that creates
  something is idempotent. Across PJ1-PJ11 the only journals are the bill's,
  the claim's, the spend money's and the approved invoices' (and their
  voids).
- **PJ13** Only lines coded to a **profit and loss cost account** (the
  expense class: expense, direct costs and depreciation types) are project
  expenses. Bill PS-302 from Paw Supplies on 8 Jul 2026 (approved) has
  "Laptop for design work" **1,500.00** + GST to **1620 Computer
  equipment** (a fixed asset), "Design software" **50.00** + GST to 6040
  and "Courier for proofs" **30.00** + GST to 5100 (direct costs); spend
  money on 8 Jul pays "Insurance paid ahead" 115.00 incl. GST to **1200
  Prepayments**. "Add to project" offers only the software and the courier.
  Linking the laptop is refused ("That line is coded to 1620 Computer
  equipment, a fixed asset account, not an expense. Only lines coded to
  expense or direct cost accounts can go on a project.") and so is the
  prepayment (1200, a current asset); nothing is linked. The software then
  links at cost **50.00** and the courier at **30.00**. (Stock on 1400 is
  refused with its own reason, PJ4; GST, bank and accounts payable can't be
  on these lines at all.) Lines already linked before this rule stay linked.

### Not supported yet (refused rather than guessed)

- **Deposits and progress billing**, invoicing part of a fixed price, and
  invoicing time at a per-person rate (the task's rate is used).
- A **start/stop timer**: time is entered as hours and minutes.
- Undoing a **write-off**, or writing items off other than when closing.
- Linking **draft bills**, supplier credit notes, purchase orders, manual
  journals, receive money or stock lines to projects. (Projects in a
  customer's other currency are built, MC61-MC70, but their expenses are
  costs only, MC63, and currencies without cents are refused, MC70.)
- **Tracking the project in the ledger**: a project isn't a tracking or
  custom segment value, and linking an expense doesn't change its posted
  lines (posted history is append-only). Organisations that want the
  ledger split by project can add a "Project" custom segment (CS1) and tag
  lines themselves.
- Notes and files on projects; time entries for people who aren't members
  of the organisation (e.g. contractors without a login).

### Questions for Jess (projects), decided

Decided on 2 Oct 2026: decisions 297-305. What was asked is kept below.

- Invoice lines for time: the quantity is the hours when they're exact to 4
  decimal places, else 1 line at the amount (PJ7). Would you rather Tohyee
  round time to 6 or 15 minutes when invoicing, as some firms do?
- Should staff who only record time (no bookkeeping) get a "time only"
  role? As built, entering time needs a bookkeeper.
- Is closing with write-off the right way to finish a project with
  unbilled work, and should a write-off be undoable when it's reopened?
- Should invoiced income include credit notes against project invoices
  (not linked yet), and should profitability be for a date range rather
  than the project's life?
- Should a project automatically tag its invoice lines with a "Project"
  custom segment value, so the profit and loss can be split by project?
- Projects and opportunities in another currency (MC61-MC70, following
  NetSuite): should expenses be chargeable on a USD project, and if so
  converted at which rate (the bill's, the invoice's, or a fixed one)? As
  built they're costs only (MC63).
- A won opportunity for a company in another currency makes a zero-rated
  (ZERO) draft invoice (MC69), since standard-rated GST isn't built for
  foreign-currency documents (multi-currency question 1). Right for your
  overseas customers, or would you rather it had no GST code until someone
  picks one?
- A customer's currency can't change once it has any project or
  opportunity, even a lost one or an empty project (MC61, as quotes do,
  MC25). Should it be allowed while they have nothing on them?
- Projects in currencies without cents (JPY, XPF) are refused (MC70). Needed?

## Bringing in existing books (examples not yet approved by Jess)

Accountants bring an organisation's existing books into Tohyee instead of
starting from nothing (Accounting > Settings > **Import and export**, admins
and owners). It follows NetSuite's import assistant, as Jess asked: for each
file, upload a CSV or Excel (.xlsx) file, map its columns to fields (matched
from the headings, and remembered per organisation for next time), check it
(every row, with each problem named by row), then import it in one
transaction. **If any row is refused, nothing in that file is imported.**
There are two presets: Tohyee's own columns (what the exports write), and
"From another accounting system (Xero-style export)", which knows the
headings of Xero's standard exports (`*ContactName`, `InvoiceAmountDue`, ...).
The preset is labelled neutrally; no other product is named on screen.

The steps, in order: 1 chart of accounts, 2 contacts, 3 products and
services, 4 opening balances (trial balance and stock) and 5 open invoices
and bills, posted together as at the **conversion date**, then 6 a final
check and the period lock. Tests: `tests/integration/import.test.ts`
(IM1-IM21), `tests/unit/import-fields.test.ts` (column matching) and
`tests/unit/opening-gst.test.ts` (GST in open documents).

**Running a step again.** Accounts and products and services are matched by
code, contacts by name (ignoring case). A match is updated from the columns
that have something in them (a blank cell changes nothing); anything else is
added; nothing is ever deleted or archived. Opening balances (steps 4 and 5)
are brought in **once**: a second import is refused, and a retry of the
same request returns the first (IM14). Mistakes found later are corrected
with a journal after the conversion date (or after reopening the period on
Period close), or by
voiding an opening invoice or bill.

**How opening balances post (IM6).** The trial balance is posted as one
journal dated the conversion date, origin "Opening balances", which can't be
corrected like a manual journal. Accounts receivable, accounts payable and
inventory aren't posted from the trial balance, because the open invoices,
open bills and stock on hand make them up: their trial balance lines go to
**3900 Opening balance** instead, an equity account (decided with Jess,
30 Sep 2026: equity and named like NetSuite's "Opening Balance" account;
Xero calls its equivalent "Historical Adjustment", and importing either name
maps to it). Each open
invoice then posts Dr accounts receivable / Cr 3900, each open bill Dr 3900 /
Cr accounts payable, and the stock Dr inventory / Cr 3900, all dated the
conversion date. So 3900 ends at 0.00, and accounts receivable, accounts
payable and inventory equal their sub-ledgers without being counted twice.
(Xero's conversion balances do the same with invoices entered before the
conversion date and its Historical Adjustment account; NetSuite posts to its
Opening Balance equity account.) This means:

- The trial balance must balance, and accounts receivable must equal the
  open invoices, accounts payable the open bills and inventory the stock
  values, to the cent. Otherwise nothing is posted and the difference is
  shown (IM8, IM9).
- Nothing may already be posted on or before the conversion date, and the
  conversion date must be in an open period.
- Open invoices and bills are one row each: the number, contact, date, due
  date, **amount still owed including GST**, and the **GST in it** (decided
  with Jess, 30 Sep 2026: like Xero, where outstanding invoices at the
  conversion are the original invoices with their GST). They keep their
  date, due date and number (not Tohyee's INV sequence, IM10) and are marked
  as opening balances. Approving or voiding one never counts in a GST
  return, since it was issued before the conversion; on the bases where GST
  counts when paid (the payments basis, and purchases on the hybrid basis),
  a payment or credit after the conversion counts its share of the GST,
  exactly like any invoice or bill paid on that basis (the same proportional
  rule, G11). On the invoice basis the GST was returned before the
  conversion, so it's never returned again (IM11, IM13, IM18, IM19). They
  never count in sales by salesperson. They can be paid, credited and
  voided like any other invoice or bill (IM12); voiding one reverses it to
  3900, where the accountant clears it with a journal.
- The GST is given as a GST column (the GST in what's still owed; or, with
  the invoice's total, the whole invoice's GST, from which the GST in what's
  owed is worked out in proportion), or a GST code (with GST: 3/23 of what's
  owed), IM20. Where GST counts when paid, every row needs one (0.00 if
  there's none); elsewhere it's optional.
- The GST line of the trial balance is posted to 2100 as a balance only:
  journals never count in a GST return. **It includes the GST in the open
  invoices and bills**, as Xero's GST account does (Xero puts unpaid GST on
  outstanding invoices in the GST account at the conversion) and as
  Tohyee's own does for every invoice (GST goes to 2100 when an invoice is
  approved, on every basis; the GST return decides when it's reported). So
  the open invoices' and bills' journals post no GST (Dr accounts receivable
  / Cr 3900 of the amount including GST, as before), and the check shows how
  2100 splits (IM17): on the payments basis, 2100 = what the GST returns up
  to the conversion left to pay + GST in the open invoices (not yet
  returned) - GST in the open bills (not yet claimed).
- Stock is a quantity and a value per item (and per location once stock is
  kept by location). It comes in as a receipt at that value exactly (3
  worth 10.00 is 10.00, not 3 x 3.33), dated the conversion date.
- Bank accounts take their balance from the trial balance. That opening
  line is the bank's balance at the conversion date, so the bank
  reconciliation report and matching leave it out (IM15); statement lines
  from before the conversion date aren't expected.
- Foreign-currency accounts, unused credit notes and overpayments (a
  negative amount owed) aren't supported in opening balances yet (refused).

The main example: **Tui Traders Ltd**, starting chart of accounts, GST on
the invoice basis, customers Kobe Ltd and Harbour Cafe, supplier Kauri
Supplies, stock items MUG and VASE, converting at **31 March 2026**.

Trial balance at 31 Mar 2026 (columns Account code, Account, Debit, Credit;
a last row "Total" with no code is left out):

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1000 Business bank account | 12,450.00 | |
| 1100 Accounts receivable | 1,725.00 | |
| 1400 Inventory | 810.00 | |
| 1600 Office equipment | 3,000.00 | |
| 2000 Accounts payable | | 460.00 |
| 2100 GST | | 1,380.00 |
| 3000 Owner funds introduced | | 10,000.00 |
| 3200 Retained earnings | | 6,145.00 |
| **Total** | **17,985.00** | **17,985.00** |

Open invoices: **INV-0107** Kobe Ltd, 15/03/2026, due 20/04/2026,
**1,150.00**; **INV-0112** Harbour Cafe, 28/03/2026, due 20/04/2026,
**575.00**. Open bill: **K-311** Kauri Supplies, 20/03/2026, due
20/04/2026, **460.00**. Stock: MUG 40 worth **800.00**; VASE 3 worth
**10.00**.

- **IM1** The starting chart of accounts has **3900 Opening balance**
  (equity, "Used by Tohyee"); an organisation without one gets it at 3900,
  or the next free code up to 3999, the first time opening balances are
  posted. It's the account the three sub-ledger lines clear through, and is
  0.00 once they're posted (IM7). It can't have a balance of its own in the
  imported trial balance.
- **IM2** Chart of accounts, Xero-style file:

  ```
  *Code,*Name,*Type,*Tax Code,Description
  200,Sales,Revenue,15% GST on Income,
  610,Accounts Receivable,Current Asset,No GST,
  6000,Advertising,Overhead,GST on Expenses,
  7500,Donations,Expense,No GST,Gifts to charities
  ```

  Check: 200 **added** (Revenue, GST code GST); 610 is Tohyee's accounts
  receivable account, so **1100 is re-coded 610** and keeps its role (and
  its type); 6000 **updated** (renamed Advertising, usual GST code GST); 7500
  **added** (Expense, NONE, with its description). Importing it: 2 added, 2
  updated. Importing the same file again: 4 unchanged. Types are read from
  Tohyee's names and the other system's (Overhead is Expense, Sales is
  Revenue, Prepayment is Current asset, and so on); tax codes from their
  code or label, or names like "15% GST on Income" (GST), "Zero Rated"
  (ZERO), "Exempt Expenses" (EXEMPT) and "No GST" (NONE); "GST on Imports"
  is refused.
- **IM3** Refusals: `1000,Business bank account,Current asset` (1000 is the
  bank account Tohyee uses, so its type stays Bank), `8000,Sundry income,`
  (a new account needs a type) and `8100,Rent received,Other income`. The
  check names row 2 and row 3; importing is refused and **8100 isn't added
  either**. The same code twice in one file is refused on the later row.
- **IM4** Contacts, Xero-style file with no customer or supplier columns,
  "mark new contacts as" customer and supplier:

  ```
  *ContactName,EmailAddress,POAddressLine1,POCity,POPostalCode,TaxNumber
  Kobe Ltd,accounts@kobe.co.nz,1 Queen Street,Auckland,1010,123-456-789
  Harbour Cafe,,,,,
  ```

  Kobe Ltd is added as a customer and supplier with billing address "1 Queen
  Street / Auckland / 1010" (one line each) and GST number 123456789.
  Importing `KOBE LTD,hello@kobe.co.nz` later updates Kobe Ltd's email and
  leaves everything else. With Tohyee's columns, "Payment terms" is matched
  to the organisation's terms by name ("20th of the following month") and a
  custom field column (Advanced reporting) to its field; a list field's
  option by its name. A row with an email of "not-an-email" refuses the
  whole file.
- **IM5** Products and services, Xero-style file: `MUG` with
  InventoryAssetAccount 1400 becomes a **stock** item (purchase account
  1400); `DELIVERY` with only a sale price of 12.50 and sales account 4000
  becomes a **service**; `BOX` with a purchase price becomes **non-stock**.
  "15% GST on Income" and "15% GST on Expenses" are GST. Quantities in the
  file are ignored: stock on hand comes with the opening balances.
- **IM6** Posting Tui Traders' opening balances makes, all dated 31 Mar
  2026:
  - the opening journal (reference OPENING, origin "Opening balances"):
    Dr 1000 **12,450.00**, Dr 3900 **1,725.00** (1100, held by the open
    invoices), Dr 3900 **810.00** (1400, held by the opening stock), Dr 1600
    **3,000.00** / Cr 3900 **460.00** (2000, held by the open bills), Cr
    2100 **1,380.00**, Cr 3000 **10,000.00**, Cr 3200 **6,145.00**; total
    **17,985.00**;
  - INV-0107: Dr 1100 **1,150.00** / Cr 3900 1,150.00; INV-0112: Dr 1100
    **575.00** / Cr 3900 575.00 (each approved, one line "Owed at
    2026-03-31 (opening balance)" of 1,150.00 or 575.00, no GST);
  - K-311: Dr 3900 **460.00** / Cr 2000 460.00;
  - stock receipts: MUG 40 at **800.00** (unit cost 20.00) and VASE 3 at
    **10.00** (not 9.99), each Dr 1400 / Cr 3900.
- **IM7** The trial balance at 31 Mar 2026 is exactly the imported one: 1000
  12,450.00 Dr, 1100 1,725.00 Dr, 1400 810.00 Dr, 1600 3,000.00 Dr, 2000
  460.00 Cr, 2100 1,380.00 Cr, 3000 10,000.00 Cr, 3200 6,145.00 Cr, and 3900
  **0.00**. The final check shows each account's imported and Tohyee
  balance side by side, all matching; locking up to 31 Mar 2026 (the
  ordinary period lock) then refuses anything dated on or before it.
  Aged receivables at 31 Mar 2026: Kobe Ltd 1,150.00 and Harbour Cafe
  575.00 (current, due 20 Apr), total **1,725.00** = 1100. Aged payables:
  Kauri Supplies **460.00** = 2000. Stock on hand: MUG 40 worth 800.00,
  VASE 3 worth 10.00, total **810.00** = 1400.
- **IM8** INV-0112 at **500.00** instead: refused, "Accounts receivable
  (1100) is 1,725.00 in the trial balance, but the open invoices add up to
  1,650.00: a difference of 75.00". Nothing is posted.
  The same for accounts payable against the open bills, and inventory
  against the stock values.
- **IM9** 3200 at **6,110.00** instead: refused, "debits 17,985.00, credits
  17,950.00, a difference of 35.00". Nothing is posted.
- **IM10** Numbers: INV-0107 and INV-0112 keep their numbers. If an opening
  invoice is numbered **INV-0001**, the first invoice approved in Tohyee is
  **INV-0002** (the counter passes over numbers opening invoices have). An
  opening invoice with a number already in Tohyee is refused.
- **IM11** GST: the first return after the conversion, 1 Apr - 31 May 2026
  (invoice basis), with a new invoice I1 (100.00 + GST 15.00) dated 10 Apr
  and INV-0107 paid in full on 20 Apr: Box 5 **115.00**, Box 8 **15.00**,
  and only I1 is in its lines. A return for 1 Feb - 31 Mar 2026 in Tohyee
  has no lines either (the opening invoices and bill are left out, and the
  opening journal never counts). 2100 at 31 May: 1,380.00 + 15.00 =
  **1,395.00** Cr. Opening invoices are left out of sales by salesperson.
  The same with the GST columns of IM17 (INV-0107 carrying 150.00 of GST):
  on the invoice basis that GST was returned before the conversion, so
  paying INV-0107 still counts nothing.
- **IM12** Paying later: INV-0107 paid 1,150.00 on 20 Apr 2026 from 1000
  posts Dr 1000 / Cr 1100 1,150.00 and the invoice is paid; K-311 paid
  460.00 on 22 Apr posts Dr 2000 / Cr 1000. Aged receivables at 30 Apr:
  Harbour Cafe **575.00** (10 days overdue). Kobe Ltd's activity statement
  for April starts with a balance of **1,150.00** (INV-0107) and ends at
  0.00 after the payment.
- **IM13** GST basis: on the **payments basis**, the IM6 files (no GST
  column) are refused row by row: "Invoice INV-0107 needs its GST: this
  organisation accounts for GST on sales when they're paid (the payments
  basis), so the GST in what's still owed is returned when it's paid. Map a
  GST column (0.00 if there's none) or a GST code." (and the same for
  INV-0112 and bill K-311). With IM17's GST columns they're accepted. On the
  **hybrid basis** only the bill needs its GST (sales count when approved,
  so the invoices' GST was returned before the conversion); on the
  **invoice basis** neither does.
- **IM14** Once only: a second opening balances import is refused ("already
  brought in as at 2026-03-31"); retrying the first with the same key and
  files returns it (nothing new). Something already posted on or before
  the conversion date refuses the import.
- **IM15** Bank reconciliation: a statement for 1000 with one line, 2 Apr
  2026, -46.00, running balance **12,404.00**, reconciled to a spend money
  of 46.00 on 2 Apr. The report as at 30 Apr: Tohyee **12,404.00**, nothing
  in Tohyee that isn't on the statement (the opening line isn't an item),
  statement balance 12,404.00, fully explained. The opening line is never
  offered as a match for a statement line.
- **IM16** Export: the chart of accounts, contacts, and products and
  services download as CSV with Tohyee's column headings (for example
  `Code,Name,Type,GST code,Description`), and importing an exported file
  back changes nothing (every row unchanged).

- **IM17** A **payments-basis** conversion: Tui Traders as above, but on
  the payments basis, with the GST in each open document:

  ```
  Invoice number,Customer,Invoice date,Due date,Amount due,GST
  INV-0107,Kobe Ltd,15/03/2026,20/04/2026,1150.00,150.00
  INV-0112,Harbour Cafe,28/03/2026,20/04/2026,575.00,75.00
  ```

  and bill K-311 460.00 with GST **60.00**. Everything posts exactly as in
  IM6 (the journals don't post GST again): INV-0107 is one line "Owed at
  2026-03-31 (opening balance)", GST code GST, 1,150.00 including GST
  **150.00** (subtotal 1,000.00), and its journal is Dr 1100 1,150.00 / Cr
  3900 1,150.00. The trial balance at 31 Mar is exactly IM7's (2100
  1,380.00 Cr, 3900 0.00). The check shows how 2100 splits:

  | GST (2100) at 31 Mar 2026, payments basis | |
  | --- | ---: |
  | GST account in the trial balance (owed to IRD) | 1,380.00 |
  | GST in the open invoices (not yet returned) | 225.00 |
  | GST in the open bills (not yet claimed) | 60.00 |
  | **Owed from GST returns up to 31 Mar** (1,380.00 - 225.00 + 60.00) | **1,215.00** |

  So the old system's GST account (like Xero's, and Tohyee's own) already
  holds the 225.00 still to be returned and the 60.00 still to be claimed;
  the 1,215.00 should be what the returns up to 31 Mar left to pay. The
  Feb-Mar 2026 return in Tohyee has no lines.
- **IM18** The first GST return after it, 1 Apr - 31 May 2026, payments
  basis. I1 (Harbour Cafe, 100.00 + GST 15.00) approved 10 Apr and not
  paid; INV-0107 paid in full, **1,150.00** on 20 Apr; INV-0112 part paid,
  **230.00** on 25 May; K-311 paid in full, **460.00** on 22 Apr. Counted:
  INV-0107 1,150.00 (GST 150.00); INV-0112 230.00, its share of 575.00 (GST
  230.00 x 75.00 / 575.00 = **30.00**); K-311 460.00 (GST 60.00). I1 isn't
  counted (not paid). Box 5 **1,380.00**, Box 6 **0.00**, Box 7
  **1,380.00**, Box 8 = 1,380.00 x 3/23 = **180.00**, Box 11 **460.00**,
  Box 12 **60.00**, Box 15 **120.00** (to pay). GST on transactions: sales
  180.00, purchases 60.00. 2100 at 31 May: 1,380.00 + I1's 15.00 =
  **1,395.00** Cr = 1,215.00 (returns to 31 Mar) + 120.00 (this return) +
  60.00 not yet returned (INV-0112's 345.00 still owed has 45.00 of GST, and
  I1 15.00). INV-0112's other 345.00 paid on 10 Jun counts in Jun-Jul: Box 5
  **345.00**, Box 8 **45.00**.
- **IM19** The same on the **hybrid basis**: the opening invoices' GST was
  returned before the conversion (sales count when approved), so paying
  INV-0107 and INV-0112 counts nothing; I1 counts when approved and K-311
  when paid. Apr-May: Box 5 **115.00**, Box 8 **15.00**, Box 11 **460.00**,
  Box 12 **60.00**, Box 15 **-45.00** (a refund). 2100 splits as 1,380.00 +
  60.00 (not yet claimed) = **1,440.00** owed from the returns up to 31 Mar.
- **IM20** Ways to give the GST (payments basis):
  - a **GST code** without an amount: INV-0112 575.00 with "15% GST on
    Income" (or GST) has GST 575.00 x 3/23 = **75.00**; with ZERO it has
    0.00 (counted in Box 6 when paid);
  - another system's export with the **whole invoice's** total and GST
    (`Total`, `TaxTotal`) and what's still owed (`InvoiceAmountDue`), a row
    per invoice line: INV-0112 total 805.00, GST 105.00, owed 575.00 has
    575.00 x 105.00 / 805.00 = **75.00** in what's owed (the rows for its
    other lines are the same invoice, left out);
  - **less than 3/23** of what's owed: K-311 460.00 with GST 30.00 becomes
    two lines, **230.00** with GST (30.00 x 23 / 3, GST 30.00) and
    **230.00** with no GST (out of scope). Paying it in full counts Box 11
    **230.00**, Box 12 **30.00**, and the 2100 split shows 30.00 not yet
    claimed (1,185.00 from the returns);
  - up to **0.05** from 3/23 is taken as line-by-line rounding: 460.00 with
    GST 60.04 is one line with GST 60.04;
  - refused: GST 70.00 on 460.00 ("The GST (70.00) is more than GST at 15%
    on what's owed would be (60.00)."), GST with a code that has none ("The
    GST is 60.00 but the GST code ZERO has no GST."), negative GST, and a
    total less than what's owed.
- **IM21** The conversion account for organisations that had the old one:
  migration 0036 changes **2990 Conversion clearing** (current liability)
  to **3900 Historical adjustment** (equity; the next free code up to 3999
  if 3900 is taken; the name only if it was still "Conversion clearing"),
  and migration 0038 then renames it **Opening balance** if it still has
  that starting name
  when nothing is posted to it. If something is (opening balances already
  brought in), it's left as it is, because an account's class can't change
  once it has postings; it's still used and still 0.00. Organisations with
  no conversion account get 3900 Opening balance. Importing a chart
  of accounts with `840,Historical Adjustment,Current Liability` (Xero's)
  re-codes 3900 to 840, named Historical Adjustment, and it **stays Equity**
  ("it stays Equity, not Current liability") rather than refusing the file.

### Not supported yet (refused rather than guessed)

- Opening balances on **foreign-currency accounts**.
- **Unused credit notes, overpayments and prepayments** at the conversion
  date (a negative amount owed).
- Open invoices and bills **brought in line by line** with their original
  accounts: each is one line (two when its GST is less than 3/23) on 3900,
  with the GST in what's still owed. Box 6 counts a zero-rated part only
  when its row has the ZERO code; the rest of a split document is treated as
  having no GST.
- A **GST account kept elsewhere** in the old system (GST on unpaid invoices
  in a separate account): add it to the GST line of the trial balance.
- **Unpresented payments and deposits** at the conversion date: the bank
  account's opening balance is taken as what the bank's statement said.
- Several **conversion dates** (for example bringing in history month by
  month), and importing **transactions** (invoices, bills and journals
  from before the conversion date, other than what's still owed).
- Contacts' **people**, customer groups, price levels and credit limits,
  items' units, price level prices, suppliers and kits, and payment terms
  from another system's day-and-term columns. Suppliers' payment terms
  (SPT1) aren't imported yet: the "Payment terms" column sets a customer's.

### Questions for Jess (bringing in existing books), decided

Decided on 2 Oct 2026: decisions 312-315. What was asked is kept below.

Decided with Jess (30 Sep 2026): open invoices and bills carry their GST, as
in Xero (IM13, IM17-IM20), and the conversion account is equity (IM1, IM21).
Also decided, following NetSuite: the trial balance's GST line is taken as
already including the GST in the open invoices and bills (NetSuite
migrations load open invoices and bills without tax, against an equity
opening balance account, so the tax balance comes only from the trial
balance), and the conversion account is named "Opening balance" (NetSuite's
name), code 3900 (NetSuite doesn't fix a number).

- **Rounding allowance**: GST within 0.05 of 3/23 of what's owed is one
  standard-rated line; more than 0.05 less is split in two (IM20). Is 0.05
  right?
- **Bank balances**: should the bank account's opening balance be the
  ledger balance (as built) with unpresented items entered as opening
  transactions, as in Xero?
- Is matching another system's "Accounts Receivable" (and Accounts Payable,
  GST, Inventory, Retained Earnings) to Tohyee's own account by name, and
  re-coding Tohyee's account to the other system's code, what you want?
- Should contacts without customer or supplier columns default to both
  (the screen's default for the other-system preset)?

## Year end and period close (examples not yet approved by Jess)

Written from NetSuite's documentation (Jess's standing rule: follow NetSuite
for design): "Year-End Closing" (NetSuite closes the year automatically once
all of its periods are closed, and doesn't post net income to retained
earnings, "because doing so would zero the past income statements"),
"Period Close Checklist" (lock, check, then close, period by period) and
"Reopening a Closed Period" (a justification is required and saved, and any
later closed periods are reopened automatically). Jess hasn't approved these
yet. Tests: `tests/integration/period-close.test.ts` (YE1-YE4, TB1-TB4, PC1-PC12)
and `tests/unit/financial-year.test.ts` (the month and year dates).

**Retained earnings, without a closing journal.** Nothing is posted at a
year end. The balance sheet works profit out when it runs (P2):

- **Current year earnings**: income less expenses from the first day of the
  financial year the balance sheet date is in, to that date.
- **Retained earnings**: the retained earnings account's own balance (3200
  in the starting chart; whichever account is marked as retained earnings)
  plus all profit before the start of that financial year. It's one line;
  3200 isn't listed separately among the equity accounts.

So a year's profit moves from current year earnings into retained earnings
on the first day of the next financial year. The profit and loss is
unchanged (P3). Custom reports (CR6) keep their "Earnings from previous
years" row and 3200 in the equity accounts group; together they're the same
retained earnings.

**Trial balance** (decided 1 Oct 2026, following NetSuite's [Trial Balance
Report](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1520986.html):
"For income statement accounts ... the Trial Balance report includes only
transactions posted from the beginning of the ... year up to the As of
date", and "Retained earnings are reported in the Trial Balance report as
the sum of cumulative net income and amounts posted directly to the retained
earnings account"). As at a date:

- balance sheet accounts (assets, liabilities, equity) show every posting
  to the date, as before;
- income and expense accounts (revenue, other income, direct costs,
  expenses, depreciation) show only the postings from the first day of the
  financial year the date is in;
- the retained earnings account (3200) shows its own postings plus the
  profit of every earlier financial year: the same figure as the balance
  sheet's retained earnings (P2). It's shown even when 3200 has no
  postings of its own, and says how much of it is earlier years' profit.
  That part is worked out, not posted (NetSuite: "a calculated reporting
  value that's not recorded in the account register"), so it isn't in
  3200's account transactions.

So the trial balance still balances, and it matches the balance sheet and
the profit and loss: its income and expense lines are the profit and loss
for the financial year to date. How the other reports tie to it:

- **Account transactions** (ATX) keep every posting, as NetSuite's account
  registers do. A balance sheet account's closing balance is its trial
  balance line; an income or expense account's trial balance line is its
  debits less credits from the first day of the financial year (TB2);
  3200's is its closing balance plus earlier years' profit (TB3).
- **Custom reports**, **Home** and the **period close checks** don't use
  the trial balance: custom reports and budgets use the same account totals
  as the profit and loss and balance sheet (CR9), Home uses bank balances
  and the documents, and the period close checks use balance sheet accounts
  (bank, 1100, 2000, 1400, 3900) at the month end, which are unchanged.
- **Bringing in existing books** (IM7): the final check compares each
  account's balance at the conversion date (every posting to it) with the
  imported trial balance. Nothing can be posted before the conversion date,
  and the opening journal is dated the conversion date, so it's the only
  posting and falls in the financial year the conversion date is in. So an
  imported income or expense line (a conversion part way through a year,
  with the year's profit and loss so far) shows the same on the new trial
  balance at the conversion date as in the check, and the check still
  compares like with like. From the first day of the next financial year it
  moves into retained earnings, like any other year's profit.

Setup for TB1-TB4: the YE setup below (31 March year end; 10,000.00 capital
on 1 Apr 2025, sales 15,000.00 on 10 Jul 2025, fees 2,654.33 on 20 Feb 2026
and sales 1,000.00 on 15 Apr 2026). Tests: `tests/integration/period-close.test.ts`.

- **TB1** At 31 Mar 2026: 1000 **22,345.67** Dr, 3000 **10,000.00** Cr,
  4000 **15,000.00** Cr, 6010 **2,654.33** Dr; **25,000.00** each side. No
  retained earnings line (3200 has no postings and there's no earlier year).
- **TB2** At 1 Apr 2026: 1000 22,345.67 Dr, 3000 10,000.00 Cr, **3200
  Retained earnings 12,345.67 Cr** (all of it earlier years' profit, the same
  as the balance sheet), and no 4000 or 6010 line (nothing this year);
  22,345.67 each side. At 30 Apr 2026 (YE2): 1000 **23,345.67** Dr, 3000
  10,000.00 Cr, 3200 **12,345.67** Cr, 4000 **1,000.00** Cr; 23,345.67 each
  side. 4000's account transactions for 1-30 Apr 2026 still open at
  15,000.00 Cr and close at 16,000.00 Cr; their credits in the period,
  **1,000.00**, are its trial balance line.
- **TB3** After YE3's dividend (Dr 3200 500.00 / Cr 1000 on 20 Apr 2026), at
  30 Apr 2026: 1000 **22,845.67** Dr, 3000 10,000.00 Cr, 3200 **11,845.67**
  Cr (-500.00 posted + 12,345.67 earlier years), 4000 1,000.00 Cr;
  22,845.67 each side. 3200's account transactions close at 500.00 Dr.
- **TB4** With the year end changed to 30 June (YE4), at 30 Apr 2026 the
  year started 1 Jul 2025, so there's no earlier years' profit: 1000
  22,845.67 Dr, 3000 10,000.00 Cr, 3200 **500.00 Dr**, 4000 **16,000.00**
  Cr, 6010 **2,654.33** Dr; **26,000.00** each side.

**Periods.** Periods are calendar months; financial years end on the chosen
month (Settings). Accounting › Period close lists each financial year with
its months, newest first, from the first month with postings (or the lock
date, if earlier) to this month:
**Open**, **Closed**, or **Partly locked** (the import's lock at a
conversion date in the middle of a month). A financial year is **closed**
when its last month is.

**Closing a month** runs its checklist, then locks it: the lock date moves
to the month's last day, so nothing dated on or before it can be posted,
approved, voided or corrected (L1-L4; PostgreSQL refuses such journals too).
Months are closed **in order**: a month can't be closed while an earlier
month with postings is open (months without postings in between close with
it, and its checks cover everything from the day after the lock date).
Every check posts nothing and is worked out from the books each time; each
is **Pass**, **Needs attention** or **Not applicable**, with links to fix it:

| Check | Passes when |
| --- | --- |
| Bank accounts reconciled | For each bank and credit card account with anything on or before the month end: the bank reconciliation report at the month end (BK20) knows the statement balance, has no statement lines on or before it left unreconciled, and is fully explained. Payments not yet on the statement are fine |
| No drafts left in the period | No draft invoices, credit notes, bills or supplier credit notes, and no draft or submitted expense claims, dated from the day after the lock date to the month end |
| Depreciation run to the period end | With fixed assets registered by the month end: depreciation has been run to it, or a run to it would charge nothing (FA3) |
| Foreign-currency balances revalued | Every foreign-currency account with a balance at the month end is in an FX revaluation dated the month end (F1-F7) |
| Stock equals the inventory account | Stock on hand (all stock movements to the month end) equals 1400 at the month end |
| No stock below zero | No item (at any location) is below zero at the month end (NetSuite's "Review negative inventory"; ST10) |
| Receivables equal accounts receivable | Aged receivables' total at the month end equals 1100 |
| Payables equal accounts payable | Aged payables' total at the month end equals 2000 (AGP1) |
| GST returns filed | Every GST period after the latest filed return that ends by the month end is filed: periods by the GST period setting (GP5), or without one the same length as the latest filed return (H4). With no return filed: needs attention if there's a GST number, otherwise not applicable |
| Opening balance account at 0.00 | 3900 Opening balance (IM1) is 0.00 at the month end |

Bookkeepers can close a month whose checks all pass (or don't apply). With
checks needing attention only an **owner or admin** can close it, after
ticking that they've reviewed them; the checks they accepted are recorded
in the audit log with the close. Closing a month that's already closed
changes nothing.

**Reopening** (owners and admins only) needs a reason. It moves the lock
date to the day before the month starts, so **every later closed month
reopens too**, as in NetSuite. The reason, who did it and the lock date before and after
are in the audit log and in the page's history. Reopening an open month
changes nothing.

**One lock, one screen.** Period close replaces the old lock date and unlock
window on Settings (Settings now just says what's closed and links here).
The unlock window is gone: on upgrade, an open unlock window becomes a
reopening from its first day (what reopening that month does now), recorded
in the audit log. The import's last step still locks up to the conversion
date. Moving the lock date earlier any other way also needs a reason (L3).

**Changing the financial year end** is refused while a financial year with
postings is closed (its retained earnings and current year earnings would
move); reopen it first.

Setup for YE1-YE4 and PC1: the starting chart, a 31 March year end, and
these journals:

| Date | Journal |
| --- | --- |
| 1 Apr 2025 | Dr 1000 10,000.00 / Cr 3000 Owner funds introduced 10,000.00 |
| 10 Jul 2025 | Dr 1000 15,000.00 / Cr 4000 Sales 15,000.00 |
| 20 Feb 2026 | Dr 6010 Accounting fees 2,654.33 / Cr 1000 2,654.33 |
| 15 Apr 2026 | Dr 1000 1,000.00 / Cr 4000 1,000.00 |

The year ending 31 Mar 2026 made a profit of 15,000.00 - 2,654.33 =
**12,345.67**.

- **YE1** Balance sheet at 31 Mar 2026: 1000 **22,345.67**; 3000
  **10,000.00**; Retained earnings **0.00**; Current year earnings
  (since 1 Apr 2025) **12,345.67**; total equity **22,345.67**. The profit
  and loss without a start date, to 31 Mar 2026, covers 1 Apr 2025 - 31 Mar
  2026 and shows net profit **12,345.67**.
- **YE2** At 1 Apr 2026: Retained earnings **12,345.67**, Current year
  earnings **0.00**, total equity 22,345.67. At 30 Apr 2026: Retained
  earnings **12,345.67**, Current year earnings **1,000.00**, 1000 and total
  equity **23,345.67**; the profit and loss to 30 Apr 2026 starts on 1 Apr
  2026 and shows **1,000.00**. No journal is posted at the year end (still
  4). The trial balance at 30 Apr 2026 is TB2's.
- **YE3** After a journal on 20 Apr 2026, Dr 3200 500.00 / Cr 1000 500.00
  (a dividend out of retained earnings): at 30 Apr 2026 Retained earnings
  is **11,845.67** (-500.00 + 12,345.67), 3200 isn't listed among the equity
  accounts (only 3000 10,000.00), Current year earnings 1,000.00, 1000 and
  total equity **22,845.67**.
- **YE4** With nothing closed, changing the year end to 30 June (after YE3):
  at 30 Apr 2026 the year started 1 Jul 2025, so Retained earnings is
  **-500.00** and Current year earnings **13,345.67** (15,000.00 - 2,654.33
  + 1,000.00); total equity still 22,845.67. Back to 31 March, then closing
  April 2025, July 2025, February 2026 and March 2026 (as the owner,
  accepting the bank check: there's no statement) closes the year ending
  31 Mar 2026. Changing the year end is then **refused** ("The financial
  year ending 31 Mar 2026 is closed"). After reopening March 2026 (reason
  "Balance date change") the lock is 28 Feb 2026, no year with postings is
  closed, and the change is allowed.
- **PC1** Periods on 10 May 2026 (before anything is closed): the year
  ending 31 Mar 2027 (May 2026, April 2026) and the year ending 31 Mar 2026
  (March 2026 back to April 2025), all Open; April 2025, July 2025, February
  2026 and April 2026 have postings. Only April 2025 can be closed (it's the
  next to close). After closing it (lock 30 Apr 2025), May, June and July
  2025 can be closed; closing March 2026 is **refused** ("Close July 2025
  first"). After closing July 2025, February 2026 and March 2026, the year
  ending 31 Mar 2026 is **Closed** (May and June 2025 are closed too) and
  April 2026 is next; the close of March 2026 is recorded as closing the
  financial year.

The rest start from a new organisation (starting chart, 31 March year end,
no GST number) with Kobe Ltd (customer) and Paw Supplies (supplier), and
look at the checklist for June 2026. A check not mentioned passes or
doesn't apply.

- **PC2** Drafts: a draft invoice to Kobe Ltd on 12 Jun 2026 (100.00 + GST
  = **115.00**), a draft bill from Paw Supplies on 20 Jun 2026 (200.00 +
  GST = **230.00**) and a draft invoice on 1 Jul 2026: "No drafts left in
  the period" needs attention, listing "Invoice, 12 Jun 2026: Kobe Ltd,
  115.00" and "Bill, 20 Jun 2026: Paw Supplies, 230.00", each linking to
  it (the July draft isn't listed). A bookkeeper closing June is
  **refused**. After approving the invoice and deleting the bill it passes,
  and the bookkeeper closes June (lock 30 Jun 2026).
- **PC3** Bank: a journal on 1 Jun 2026, Dr 1000 1,000.00 / Cr 3000. With no
  statement: needs attention ("No statement balance is known at 30 Jun
  2026: no bank statement or feed covers that date, so Tohyee can't check
  this account against the bank. Import the statement to that date, or, if
  this account has no statements (cash, a loan or a clearing account), an
  owner or admin can accept this warning when closing."). It stays a
  warning, not a block (decided 1 Oct 2026, following NetSuite: its period
  close checklist, [Closing Tasks and Their
  Dependencies](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4317009345.html),
  has no bank reconciliation task at all, so a missing statement never
  stops a close). After importing this statement and matching the 1 Jun line to the
  journal:

  ```
  Date,Amount,Payee,Particulars,Code,Reference,Balance
  01/06/2026,1000.00,J KELLY,CAPITAL,,,1000.00
  28/06/2026,-12.00,MONTHLY FEE,,,,988.00
  02/07/2026,-50.00,Z ENERGY,,,,938.00
  ```

  it still needs attention: "1 statement line on or before 30 Jun 2026 not
  reconciled (-12.00)". After coding the fee as spend money (6010, No GST)
  it passes: the account is reconciled to 30 Jun 2026 (the 2 Jul line is
  later and doesn't count).
- **PC4** Depreciation: a journal on 1 Jun 2026, Dr 1600 1,200.00 / Cr 3000,
  and a desk registered as Office equipment (straight line 20%) bought
  1 Jun 2026 for 1,200.00: needs attention ("Depreciation of 20.00 to 30
  Jun 2026 hasn't been run (never run)"). After running depreciation to
  30 Jun 2026 it passes. With no fixed assets it doesn't apply.
- **PC5** FX: 1000 set to USD, and a journal on 1 Jun 2026, Dr 1000 1,600.00
  (USD 1,000.00 at 1.6) / Cr 3000: "Foreign-currency balances revalued"
  needs attention, listing 1000. After revaluing it on 30 Jun 2026 at
  1.6543 (F2: 1,654.30) it passes. (The bank check needs attention too:
  there's no statement.)
- **PC6** Stock: with negative stock on, a bill on 1 Jun 2026 for 2 Widgets
  @ 5.00 and an invoice on 10 Jun for 3 @ 12.00 (ST10): "No stock below
  zero" needs attention (WIDGET, -1 on hand) and "Stock equals the
  inventory account" passes (-5.00 each). After a bill on 20 Jun for 4 @
  6.00 both pass: stock **18.00** equals 1400.
- **PC7** Receivables and payables: the invoice of PC2 approved (115.00) and
  the bill approved (230.00): both pass. A manual journal on 15 Jun 2026,
  Dr 1100 50.00 / Cr 4000 50.00, makes receivables need attention
  ("Aged receivables 115.00 but 1100 Accounts receivable 165.00 at 30 Jun
  2026 (difference -50.00)"); a journal on 16 Jun reversing it makes it
  pass again.
- **PC8** GST: with a GST number set and no GST return filed, it needs
  attention; without a GST number it doesn't apply. With no GST period
  setting, after filing the return for 1 Apr - 31 May 2026 (two months),
  June passes ("Filed to 31 May 2026. No GST period setting, ...": the next
  return, June-July, ends after 30 Jun), and July needs attention: "1 Jun
  2026 to 31 Jul 2026" isn't filed. With a setting, see GP5.
- **PC9** Opening balance: a journal on 10 Jun 2026, Dr 6010 100.00 / Cr
  3900 100.00: needs attention ("3900 Opening balance is 100.00 Cr at 30
  Jun 2026"). After Dr 3900 100.00 / Cr 3000 100.00 on 11 Jun it passes.
- **PC10** Closing: with only a journal on 10 Jun 2026 (Dr 6010 50.00 / Cr
  3000 50.00) every check passes or doesn't apply, and a **bookkeeper**
  closes June: the lock date is 30 Jun 2026, the audit log has the close
  (no warnings accepted), and posting on 30 Jun is refused, by Tohyee and
  by PostgreSQL (a journal inserted directly). Closing June again changes
  nothing; a viewer can't close. With a draft invoice dated 5 Jul 2026 a
  bookkeeper can't close July; the owner can't without confirming; the owner
  confirming closes it (lock 31 Jul 2026) and the audit log lists "No drafts
  left in the period" as accepted.
- **PC11** In order: journals on 10 Jun and 10 Jul 2026 (Dr 6010 / Cr 3000):
  closing July is **refused** ("Close June 2026 first"); closing May 2026
  (no postings) works, then June, then July.
- **PC12** Reopening, after PC11 (closed to 31 Jul 2026): a bookkeeper
  can't reopen, and an admin can't without a reason. The owner reopening
  June with "Missing supplier bill" moves the lock to **31 May 2026**, so
  June and July are both open and 15 Jul 2026 posts again; the audit log
  has the reason. Reopening June again changes nothing. Reopening May moves
  the lock to 30 Apr 2026.

### Not supported yet (refused rather than guessed)

- Locking only sales or only purchases (NetSuite's "Lock A/R" and "Lock
  A/P") before closing: a period is open or closed for everything.
- Closing several months with postings in one go: each is closed in turn.
- Changes that don't touch the ledger in a closed period (NetSuite's "Allow
  non-G/L changes"): drafts dated in a closed period can still be edited,
  but not approved.

### Questions for Jess (year end and period close), decided

Decided on 2 Oct 2026: decision 316. What was asked is kept below.

- Should a bookkeeper be able to close a month when every check passes (as
  built), or only owners and admins, like the old lock date?

Decided (following NetSuite, 1 Oct 2026):

- **Trial balance**: NetSuite's (TB1-TB4). Income and expense accounts show
  this financial year to date, and earlier years' profit is in retained
  earnings, the same figure as the balance sheet's. Account transactions
  keep every posting, as NetSuite's account registers do.
- **No statement imported** for a bank account stays a warning that an
  owner or admin can accept when closing (PC3), with wording that says so;
  NetSuite's close checklist has no bank reconciliation task.
- **GST check**: uses the GST period setting (GP1-GP6) when it's set, and
  the latest filed return's length only when it isn't.

## R&D Tax Incentive (examples not yet approved by Jess)

Stage R1 of the RDTI plan in [HANDOVER.md](HANDOVER.md): what Tohyee should
**record** and **report** for New Zealand's Research and Development Tax
Incentive, written so Jess can approve it before anything is built (R2: the
activity register and tagging; R3: the claim report). **Nothing in this
section was built in R1.** Stage R2 (the register, approvals, tagging and
asset usage) is now built and tested: RD1-RD3, RD8, RD9, RD11-RD13 and
RD21-RD23 in `tests/integration/rd.test.ts` (and RD21-RD22's flag on screen in
`tests/unit/rd-screens.test.ts`), RD7's hook (an allocation line naming an
activity) there too. Stage R3 (the claim report) is built on its branch:
RD3's credit rule, RD4, RD7, RD10, RD16-RD20 and RD23-RD27, plus the new
examples RD28-RD42 at the end of this section, which say how R3 does payroll
without timesheets, overhead rules, the overseas limit across categories,
feedstock and commercial production, deadlines and exports. Timesheets came
with payroll P9 (TS1-TS11 in "Timesheets" below; RD5's split on P3's
figures is TS7); RD6's spreading of leave and RD22's reallocation still
aren't built; grants (RD15) are
tagged ineligible as in R2; feedstock values (RD14) aren't supported yet.
The examples are still waiting for Jess. Every rule below cites
where it comes from. Where the guidance was unclear or left a choice, Jess
asked Claude to research it and decide; those are decisions 30-50 in
[DECISIONS.md](DECISIONS.md), applied in the examples below and listed at the
end. The rule for each of them: never overstate a claim.

What Tohyee will and won't do:

- It **records** R&D activities, which costs and hours belong to them, and
  who entered each record and when, and it **adds up** the figures the
  supplementary return asks for.
- It **doesn't decide** whether work is R&D. IRD decides that when it
  approves activities (IR1240 p 19, p 108), and Tohyee never says an
  activity "qualifies".
- It **doesn't file** anything with IRD: the general approval application
  and the supplementary return are filed in myIR (IR1240 p 103-104).

### Sources (all read 1 October 2026)

- IRD, **Research and Development Tax Incentive: Guidance, IR1240, April
  2026** (141 pages, "What's new December 2025"):
  <https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir1200---ir1299/ir1240/ir1240.pdf>.
  The link in the task described an April 2025 version; on 1 Oct 2026 the
  same address serves the April 2026 version, which is the one cited
  throughout as "IR1240 p N" (the page number printed on the page).
- IRD, **Research and development supplementary return guide, IR1060,
  November 2022**:
  <https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir1000---ir1099/ir1060/ir1060-2022.pdf>.
- IRD web pages under <https://www.ird.govt.nz/research-and-development>:
  "Research and development tax incentive" (updated 9 Apr 2026), "R&D tax
  incentive due dates"
  (`.../tax-incentive/research-and-development-tax-incentive-due-dates`,
  updated 1 Apr 2026), "Claiming the R&D tax incentive"
  (`.../tax-incentive/claiming`, updated 13 Apr 2026), "R&D supplementary
  return" (`.../claiming/supplementary-return`, updated 30 Apr 2021) and
  "About R&D tax incentive credits" (updated 9 Apr 2026).
- **Income Tax Act 2007**, subpart LY (sections LY 1-LY 9) and section DI 5,
  consolidation as at 7 May 2026; **Tax Administration Act 1994**, sections
  33E, 68CB and 68CC, consolidation as at 1 May 2026. legislation.govt.nz
  returned an empty response (HTTP 202) to every request from the agent's
  sandbox on 1 Oct 2026, so the Acts were read from the GitHub mirror
  [jonnonz1/nz-statute-book](https://github.com/jonnonz1/nz-statute-book),
  which is **not** an official copy. Its Schedule 21B is empty, so Schedule
  21B clauses are cited through IR1240. Check the cited sections on
  legislation.govt.nz before R2 is built.
- The amending Acts named under "What changed in 2025 and 2026" below, from
  the same mirror.

Short forms: "LY 4(1)" is a section of the Income Tax Act 2007; "TAA 68CB" a
section of the Tax Administration Act 1994; "Sch 21B A cl 2" and "Sch 21B B
cl 11" are clauses of Part A (eligible) and Part B (ineligible) of Schedule
21B of the Income Tax Act 2007.

### What changed in 2025 and 2026, and which income years it applies to

- **General approval due date.** For a 31 March balance date it moved from
  the 7th day of the 2nd month after the income year (**7 May**) to the
  last day of the 3rd month (**30 June**) (TAA 68CB(2B), as amended by the
  Taxation (Annual Rates for 2024–25, Emergency Response, and Remedial
  Measures) Act 2025 s 173, in force 1 April 2025 under its s 2(34)). IRD's
  due dates page shows "Before 1 April 2025: 7 May / From 1 April 2025: 30
  June", and IR1240 p 19 and p 119 use 30 June (p 119's example for the
  2024-25 year: "prior to 30 June 2025"). So 30 June applies to the
  **2024-25 income year and later**; earlier years are closed and Tohyee
  doesn't need the old date.
- **Restructured, same deadlines.** The Taxation (Annual Rates for 2025–26,
  Compliance Simplification, and Remedial Measures) Act 2026 s 196 rewrote
  parts of TAA 68CB from 1 April 2026; the deadlines used below are the same
  before and after.
- **Investment boost (DI 5).** The Taxation (Budget Measures) Act 2025 s 15
  (in force 22 May 2025, s 2(2)) changed Sch 21B A cl 1 to "depreciation
  loss and amounts deductible under section DI 5", so the new 20% investment
  deduction on assets available for use from 22 May 2025 can be eligible
  R&D expenditure to the extent the asset is used for R&D, from the
  **2025-26 income year** for 31 March balance dates. IR1240 April 2026 doesn't
  mention DI 5 anywhere. Tohyee doesn't calculate DI 5: the deduction is
  entered per asset with its tax depreciation and counts as depreciation
  (RD11; decision 33, not yet checked against the Act on
  legislation.govt.nz).
- Nothing found changes the 15% rate, the $50,000 minimum, the $120 million
  maximum or the 10% overseas limit; they're as in LY 4 and LY 7 (consolidation
  as at 7 May 2026) and IR1240 April 2026. IRD's "Research and development tax
  incentive" page (9 Apr 2026) says the same.

### The example company

**Kea Sensors Ltd**: a company, GST registered, 31 March balance date. The
examples are for its **2026-27 income year** (1 Apr 2026 - 31 Mar 2027)
unless they say otherwise. Its R&D project is "Low-power soil sensor", run
by two employees, **Hana** and **Ben**. Jess is the owner, Sam the
bookkeeper. All amounts are NZD, excluding GST.

### The R&D activity register

An **R&D activity** is a record in its own register (not a tracking
category value, because it needs links, approvals and a place). It has:

- a **project**: IRD's grouping of related core and supporting activities,
  which is the level the supplementary return asks for expenditure (IR1240
  p 104, p 109);
- a **name** and the **descriptions IRD asks for** in the general approval
  application: purpose and uncertainty, why it couldn't be resolved from
  publicly available knowledge, the systematic approach, and for supporting
  activities why they were required for the core activity (IR1240 p 104);
- its **type**: **core** (an activity using a systematic approach to
  resolve scientific or technological uncertainty, performed in New
  Zealand; LY 2(1); IR1240 p 11) or **supporting** (only or main purpose of
  supporting a core activity, and required for and integral to it; LY 2(3);
  IR1240 p 12, p 37-39). A supporting activity is **linked to the core
  activity or activities** it supports (one supporting activity may support
  several, decision 39);
- **where it's performed**: New Zealand, or overseas. Only supporting
  activities can be overseas, and an overseas supporting activity is its
  own activity linked to a core activity (LY 2(1)(c); IR1240 p 12,
  p 69-70);
- its **approval**: the kind (general approval, or criteria and
  methodologies approval for significant performers, TAA 68CB and 68CC;
  IR1240 p 19, p 108, p 113), the reference IRD gives, the date of IRD's
  letter, the **income years** it covers (general approval can cover the
  activities for up to 3 years, TAA 68CB(2); IR1240 p 108), and the letter
  attached as a file. The letter is **required**: approval details can't be
  saved without it (decision 40).

- **RD1** Register core activity **C1** "Prototype and field-test a
  low-power soil-moisture sensor": project "Low-power soil sensor", core,
  performed in New Zealand. Registering an activity posts nothing and
  changes no amount. Hana can tag time to C1 from the day it's registered,
  with a warning while no approval is entered (RD3).
- **RD2** Register supporting activity **S1** "Literature and patent search
  for low-power sensing" (New Zealand), linked to C1, and **S2** "Sensor
  calibration at Calibra Labs, Australia" (overseas), linked to C1.
  Refused: a **core** activity performed overseas ("Core R&D must be
  performed in New Zealand"; LY 2(1)(c)); a supporting activity with **no
  core activity**; a supporting activity linked to **another supporting
  activity**. S1 could also be linked to a second core activity C2 if the
  search served both (decision 39); each cost line is still tagged to one
  activity, so S1's costs are counted once.
- **RD3** Approval: on 20 May 2027 Jess enters "General approval", IRD's
  reference, the letter dated 18 May 2027, years **2026-27 to 2028-29**, and
  attaches the letter, for C1, S1 and S2. Without the letter attached the
  approval isn't saved (decision 40). The register shows the reference as
  "entered by Jess on 20 May 2027 from IRD's letter; not checked with IRD"
  (Tohyee can't check it). Tagging costs to C1, S1 and S2 before then is
  allowed, with the warning "no approval entered for 2026-27" on each tag
  (decision 47). The claim report gives credit only for activities with an
  approval covering the year: until one covering 2026-27 is entered, it
  lists C1, S1 and S2 as "no approval entered for 2026-27" and their costs
  earn no credit; after 30 June 2027 (the deadline, RD24) it adds
  "claimable only if general approval was applied for by 30 June 2027"
  (TAA 68CB(2B); IR1240 p 19: without that, "you will not be able to claim
  R&D tax credits for that year").
- **RD4** Supporting work in another year: S1's search started in
  **March 2026** (the 2025-26 year, before C1's work began in April), and 600.00 of Hana's
  pay was tagged to S1 then. Supporting activity done in the income year
  before a core activity can be claimed in the core activity's year
  (LY 5(1)(ab)(i); IR1240 p 118-119) if the general approval covers it
  (TAA 68CB(2)). So the 2025-26 report shows the 600.00 as "supporting
  activity before its core activity: claim with 2026-27", and the 2026-27
  report includes it. If no core activity happens, it can't be claimed: a
  year with only supporting activities claims nothing (IR1240 p 38).
  Supporting work done in the year **after** the core activity's year is
  claimed in the core activity's year by varying the approval (LY
  5(1)(ab)(ii); TAA 68CB(7B); IR1240 p 119), see RD24.
- Changing an activity's descriptions, type or place keeps the old version
  in its history (who, when). A **material change** to an approved activity
  needs a variation from IRD (TAA 68CB(3B), (7); IR1240 p 109-112), so
  Tohyee shows "changed since approval was entered" on the activity and in
  the claim report, and the supplementary return's "no material change"
  declaration (RD27) can't be prefilled as "no change".

### Tagging costs to activities

A **tag** links a posted cost line to an activity, with a **share** (a % or
hours), a **category** (below) and, when it's not eligible, an **ineligible
reason** (next part). Like tracking categories, tags **never change an
amount, an account or a GST box** and post nothing; posted journals stay as
they are.

- **The amount is always excluding GST.** The R&D figure is the line's
  amount as posted to its expense (or asset) account; the GST posted to the
  GST account is never part of it (LY 1(6) applies the GST rule in DB 2;
  IR1240 p 75: "the amount of your GST input credit claimed must be deducted").
  When an organisation isn't GST registered, or a line has no GST, the
  whole amount is the cost (IR1240 p 75 only removes GST "if you are GST
  registered").
- **Categories** are the supplementary return's (IR1240 p 104; IR1060):
  **employee related costs**, **materials, consumables and overheads**,
  **R&D tax depreciation**, **contract expenditure**, and **approved
  research provider** (kept separate and counted once). The types of
  eligible expenditure are in Sch 21B A cl 1-3 (IR1240 p 15, p 62-64).
- **Flags** the return asks about (IR1240 p 105): **overseas**,
  **commercial production**, **internal software development** and
  **feedstock**.
- **Expenditure counts when it's incurred**: when Kea is definitively
  committed to it and it can be reliably estimated (IR1240 p 15). Tohyee
  uses the posting date of the bill, expense claim, pay run or depreciation.
- **Apportionment** must use an appropriate, documented method with an
  audit trail (IR1240 p 15, p 63, p 100, p 102). IR1240 p 15 lists time %,
  floor area, days or units of usage, volume, unit sales, dollar value and
  activity-based costing.
- Per-employee figures (RD5-RD7) are payroll details, so only people with
  payroll access (HANDOVER P1b) see them; everyone else sees employee
  related costs per activity as totals.

**Employee costs** (Sch 21B A cl 3; IR1240 p 63-64). Eligible pay includes
salary and wages including allowances, bonuses, employee share schemes,
recruitment and relocation, overtime, holiday pay, long-service pay and
superannuation contributions (IR1240 p 63), but only the share for time on
R&D (IR1240 p 64). Unpaid time can't be claimed (IR1240 p 64). Only the
costs IRD lists count (decision 36): **ACC levies, FBT and other employer
costs are left out** and are never tagged as employee related costs. Tohyee's
pay runs (P3) post each employee's cost split by their default allocation
(P1b) unless timesheets (P9) cover the hours; R&D uses the **posted pay run's
tags**, never a payroll calculation of its own (decision 37).

- **RD5** Timesheet split. Hana's fortnightly pay run to 12 Jul 2026 posts
  gross salary **2,400.00** and employer KiwiSaver contribution **72.00**
  (as the pay run posts them): cost **2,472.00**. Her approved timesheet has
  80 hours: **48 h C1**, **4 h S1**, **28 h** other work.
  - C1: 2,472.00 × 48 / 80 = **1,483.20**
  - S1: 2,472.00 × 4 / 80 = **123.60**
  - not R&D: 2,472.00 − 1,483.20 − 123.60 = **865.20**

  Each R&D share is rounded **down** to the cent and the remainder goes to
  non-R&D, so the parts add up to the pay and R&D is never overstated
  (decision 50). Here the shares are exact. Had the same pay covered 77 hours
  (48 h C1, 4 h S1, 25 h other):
  - C1: 2,472.00 × 48 / 77 = 1,540.987… → **1,540.98**
  - S1: 2,472.00 × 4 / 77 = 128.415… → **128.41**
  - not R&D: 2,472.00 − 1,540.98 − 128.41 = **802.61**

  An ACC levy invoice paid for Hana isn't part of the 2,472.00 and isn't
  tagged (decision 36). Across the year's 26 pays her timesheets give
  **C1 36,500.00** and **S1 1,300.00**.
- **RD6** Leave and training (IR1240 p 64, Zach). Ben's cost for the year
  is **39,000.00**: 23 weeks on C1, 2 weeks on a project management course
  for all his work, 4 weeks annual leave and 23 weeks other work. Time that
  relates to both R&D and other work is taken out first: R&D share 23 / 46
  = 50%; then 50% of the course (1 week) and leave (2 weeks) count, so
  (23 + 1 + 2) / 52 = 26 / 52 = 50% and **C1 gets 39,000.00 × 50% =
  19,500.00**. Tohyee spreads leave and training over the year this way, not
  per pay (decision 35): worked per pay, leave in a fortnight with no R&D
  would count nothing and the answer would depend on when the leave was
  taken.
- **RD7** No timesheet (a variation; in Kea's totals every pay has a
  timesheet). If Hana's 1 Mar 2027 pay has no timesheet, P3 splits it by her
  default allocation (say 60% C1, set by Jess on 1 Apr 2026): C1 2,472.00 ×
  60% = 1,483.20. A default split counts only when it's **100% R&D**
  (decision 34), so the report lists the 1,483.20 under "default split, no
  time record" and leaves it **out of the total**; Jess can see it but it
  earns no credit. An employee on R&D full time whose default allocation is
  100% C1 does count without a timesheet (IR1240 p 100 accepts monthly
  records for staff on R&D full time).

**Goods and services, including overheads** (Sch 21B A cl 2; IR1240 p 63).

- **RD8** Bill from Sensor Parts Ltd, 20 Jul 2026: "Capacitive sensor
  components for prototypes" **4,000.00 + GST 600.00 = 4,600.00**, to an
  expense account. Tagged 100% C1, materials, consumables and overheads:
  **4,000.00** counts; the 600.00 GST never does. If Kea weren't GST
  registered the line would post 4,600.00 and 4,600.00 would count.
  Tohyee deducts the GST it actually posted for the line (rounded per line, as on
  invoices and bills); IR1240 p 75's example deducts 1,304.34 from 10,000.00 where Tohyee
  would post 1,304.35, so its figure would be 8,695.65 rather than
  IRD's 8,695.66.

  Goods not used by the end of the year aren't eligible for that year
  (IR1240 p 63; decision 41). Had **1,000.00** of these components still
  been unused on 31 Mar 2027 (Hana marks the tag "not used by year end",
  stamped with who and when), only 4,000.00 − 1,000.00 = 3,000.00 would
  count for 2026-27, and the report would list the 1,000.00 to be tagged in
  the year they're used. (Not in Kea's totals: all were used.)
- **RD9** Expense claim: Hana's receipt of 5 Aug 2026 from Garden Centre
  (GST number 111-222-333, needed over $200, EC13), "Potting mix and pots
  for soil trials", **230.00 including GST** with the GST tax code:
  posts 200.00 to expense and 30.00 GST. Tagged C1: **200.00** counts.
  (Stage R2 behaviour, not part of the example: if the claim's journal is
  later corrected in the ledger, the receipt's tag stops counting and is
  listed as reversed, and the replacement journal's lines can't be tagged,
  because only a manual journal or a correction of one is tagged; so the
  200.00 is never counted twice.)
- **RD10** Overheads by floor area (IR1240 p 15, p 63). Rent is **4,000.00
  + GST** a month for 200 m²; the lab is 30 m² and used only for R&D. Tohyee
  has one overhead rule, **"% of an account"**, and its **basis is
  required**, chosen from IR1240 p 15's list (time, floor area, usage,
  volume, unit sales, dollar value, activity-based costing), with the
  calculation attached (decision 46). Jess sets the rule on the rent
  account: **15% to C1 from 1 Apr 2026, basis floor area, 30 m² of 200 m²**,
  with the floor plan attached. A rule with no basis or no attachment isn't
  saved. Each rent line dated in the period gets the tag: 4,000.00 × 15% =
  **600.00 a month**, 600.00 × 12 = **7,200.00 for the year**. The rule shows
  who set it and when; changing it starts a new period and keeps the old
  one (RD23).

So C1's materials, consumables and overheads are 4,000.00 + 200.00 +
7,200.00 = **11,400.00**.

**Depreciation** (Sch 21B A cl 1; IR1240 p 62).

- **RD11** Oscilloscope **FA-0007**, bought on a bill on 1 Apr 2026 for
  **6,000.00 + GST**. The bill line is **capital** and isn't eligible (Sch
  21B B cl 2; IR1240 p 76): it can only be tagged C1 as "ineligible:
  acquiring depreciable property". R&D uses **tax depreciation, entered per
  asset for the year**, never the book depreciation Tohyee's fixed assets
  post (decision 33; Tohyee has no IRD rates, see the fixed asset examples).
  Its 2026-27 book depreciation of **1,500.00** (the rate Kea typed for the
  asset type) is ignored. For FA-0007's 2026-27 year Kea enters, from its
  tax workings:
  - Investment Boost (DI 5): 20% × 6,000.00 = **1,200.00**, which counts as
    depreciation (decision 33; checked against schedule 21B part A cl 1
    on 1 Oct 2026);
  - tax depreciation: **1,200.00** (say 25% diminishing value on the
    6,000.00 − 1,200.00 = 4,800.00 left after the boost; Tohyee doesn't
    check the rate);
  - total 1,200.00 + 1,200.00 = **2,400.00**, stamped with who entered it
    and when.

  Kea keeps a **usage log**: 300 hours on C1 and 600 hours on other work;
  idle time doesn't count (IR1240 p 62: share of use, not availability). C1
  gets 2,400.00 × 300 / (300 + 600) = 2,400.00 × 300 / 900 = **800.00**,
  category R&D tax depreciation. (Using book depreciation would have given
  1,500.00 × 300 / 900 = 500.00.)

**Contracts** (LY 6; IR1240 p 68-69).

- **RD12** NZ contractor: Soil Lab NZ Ltd (not associated) analyses C1's
  field samples, bill **3,100.00 + GST**. Eligible contract expenditure is
  the contract amount less the contractor's own ineligible expenditure (LY
  6; IR1240 p 68-69). Soil Lab's statement (attached) says none of its
  costs are ineligible, so **3,100.00** counts. Had it said 400.00 of its
  costs were ineligible, 2,700.00 would count. For an associated contractor
  the lesser of what's paid and the contractor's costs counts (IR1240
  p 69).
- **RD13** Overseas: Calibra Labs Pty Ltd, Australia, bill
  **AUD 8,100.00**, no GST, posted at the bill's rate (1 NZD = 0.90 AUD) as
  **9,000.00**. Tagged S2, contract expenditure, overseas: foreign R&D
  expenditure, limited in RD18. Goods bought overseas and used in New
  Zealand aren't foreign (IR1240 p 70, p 96); payments for work done in New
  Zealand by a non-resident are foreign R&D expenditure (LY 7(1); IR1240
  p 70), so contacts and employees need a "non-resident" flag. Foreign
  currency is counted at the **bill's rate**, and realised exchange gains
  and losses are left out (decision 42): Kea pays the bill on 15 Aug 2026 at
  1 NZD = 0.88 AUD, so the payment is AUD 8,100.00 ÷ 0.88 = 9,204.545… =
  **9,204.55** and the realised exchange loss is 9,204.55 − 9,000.00 =
  **204.55**. The loss isn't tagged; S2 stays at **9,000.00**.

### Eligible and ineligible expenditure

A cost line tagged to an activity is either **eligible** in one of the
categories above or **ineligible** with a reason. Ineligible tags are kept
because IR1060's evaluation section asks for "ineligible expenditure on R&D",
and so Jess can see what was left out. The reasons are Schedule 21B Part B
(IR1240 p 16, p 74-84) plus the rules in LY 5:

| Reason | Source | Kea example or how Tohyee handles it |
| --- | --- | --- |
| GST input tax | LY 1(6); IR1240 p 75 | Never in the amount (RD8). |
| Someone else's eligible expenditure | LY 5(3); IR1240 p 74 | A cost recharged to Kea that another claimant claims. |
| Over the $120 million maximum | Sch 21B B cl 1; LY 4(3); IR1240 p 72-73, p 76 | RD16. |
| Under the $50,000 minimum (not an approved research provider) | Sch 21B B cl 24; LY 4(1); IR1240 p 72, p 76 | RD17-RD19. |
| Acquiring depreciable property | Sch 21B B cl 2; IR1240 p 76 | Oscilloscope 6,000.00 (RD11). IR1240 p 76: depreciable property costing more than $1,000. |
| Cost of depreciable tangible property (except prototypes used solely for R&D) | Sch 21B B cl 3; IR1240 p 76-77 | |
| Depreciation where the cost was already eligible; pooled property; loss on sale below adjusted tax value | Sch 21B B cl 4-6; IR1240 p 77-78 | |
| Associates: depreciation, profit margins, leases above market | Sch 21B B cl 7-9; IR1240 p 78 | |
| Mining | Sch 21B B cl 3B; IR1240 p 79 | |
| Acquiring land (rent is eligible) | Sch 21B B cl 10; IR1240 p 79 | Kea's rent is eligible (RD10). |
| Interest and financing | Sch 21B B cl 11-12; IR1240 p 79 | Interest on Kea's bank loan for the project, **1,200.00**. |
| Working out the entitlement | Sch 21B B cl 13; IR1240 p 79 | Accountant's fee to prepare the claim, **1,800.00 + GST**. |
| Corporate governance | Sch 21B B cl 13B; IR1240 p 79 | Board meeting costs. |
| Intangible property other than software (e.g. royalties) | Sch 21B B cl 14; IR1240 p 80 | A patent licence fee. |
| Bespoke software; internal software development over $25 million | Sch 21B B cl 15-16; IR1240 p 80, p 85 | |
| Above market value; gifts; ineligible technology | Sch 21B B cl 17-19; IR1240 p 80-82 | Vouchers given to trial participants can be eligible (IR1240 p 82). |
| Commercialisation | Sch 21B B cl 20; IR1240 p 79 | After C1 ends, a trade show stand to sell the sensor. |
| Decommissioning; remediating land | Sch 21B B cl 20B-20C; IR1240 p 80 | |
| Government and local authority grants (including co-funding) | Sch 21B B cl 21; IR1240 p 82-84 | RD15. |
| Feedstock, to the extent of the output's value | Sch 21B B cl 22; IR1240 p 81-82 | RD14. |
| Expenditure that gets a foreign R&D tax credit | Sch 21B B cl 23; IR1240 p 84 | |
| Overseas expenditure over the 10% limit | LY 7; IR1240 p 69-71 | 866.67 of S2 (RD16). |
| In commercial production, other than employee and additional costs | LY 5(1)(c); IR1240 p 64-68 | Not supported yet (Tohyee can't judge "additional"). |
| Goods not used, or services not performed, by the end of the year | IR1240 p 63 | Ineligible for that year; listed to be tagged in the year they're used (RD8; decision 41). |
| Unpaid time | IR1240 p 64 | Not a cost in Tohyee, so never tagged. |
| Realised exchange gains and losses | Decision 42 | Not tagged; foreign lines count at the bill's rate (RD13). |

ACC levies, FBT and other employer costs IRD doesn't list aren't tagged at
all (decision 36), so they aren't in this list either.

So Kea's ineligible amounts tagged to C1 in 2026-27 are 6,000.00 +
1,200.00 + 1,800.00 = **9,000.00**, plus 866.67 of S2 over the overseas
limit.

- **RD14** Feedstock (a different year, not in Kea's totals). Inputs
  transformed in a trial batch cost **2,500.00** (components 2,000.00 and
  the trial's electricity 500.00); the 20 trial sensors are sold to Harbour Farms on an
  invoice for **1,000.00 + GST**. Eligible feedstock inputs are reduced by
  the output's value: 2,500.00 − 1,000.00 = **1,500.00**; staff and
  depreciation aren't feedstock inputs and aren't reduced (IR1240
  p 81-82). Unsold output is valued at its market value at the end of the
  income year (IR1240 p 81), which Tohyee can't work out: the report asks for it (with who
  entered it and when) and shows the worksheet IR1240 p 102 asks for.
- **RD15** Grant (a different year): a 10,000.00 government grant pays
  for part of Ben's R&D salary. Expenditure funded by the grant is
  ineligible (Sch 21B B cl 21; IR1240 p 82-84), so of Ben's 19,500.00,
  **9,500.00** counts. Co-funding and own spending the grant agreement
  requires are ineligible too (IR1240 p 82-83). When the grant contract
  doesn't say what the grant pays for, the claimant can choose to apply it
  to ineligible expenditure (IR1240 p 84, L Co); Tohyee records
  which costs the grant was applied to (a tag "grant-funded", with the
  grant contract attached) and doesn't decide that for you.

### Limits and the credit

- The credit is **15%** of total eligible R&D expenditure: LY 4(2)
  "0.15 × total eligible R&D expenditure"; IR1240 p 3, p 13. It's **rounded
  down to the cent** (decision 32).
- **Maximum**: total eligible expenditure is capped at **$120 million** (or a
  higher amount IRD approves) (LY 4(3); IR1240 p 72-73).
- **Minimum**: eligible expenditure must be **$50,000 or more** for the
  year, unless it's on an approved research provider, which counts
  whatever the amount (LY 4(1)(a)-(b); IR1240 p 72, p 76, p 89). Exactly
  50,000.00 qualifies (RD19), and the minimum is tested **after** the
  overseas limit (RD18).
- **Overseas limit**: foreign R&D expenditure counts only up to 10% of
  total eligible R&D expenditure, i.e. at most 0.1 × NZ eligible ÷ 0.9 (LY
  7(5)-(6); IR1240 p 71, SA Co), **rounded down to the cent** (decision 32).
- Only activities with an **approval covering the year** earn credit (RD3;
  decision 47).
- Expenditure on approved research providers isn't subject to the
  refundability cap (IR1240 p 89); refundability is out of scope here.

- **RD16** Kea's 2026-27 year:

  | Activity | Employee related | Materials, consumables and overheads | Depreciation | Contract | Total |
  | --- | --- | --- | --- | --- | --- |
  | C1 core, NZ | 56,000.00 (Hana 36,500.00, Ben 19,500.00) | 11,400.00 | 800.00 | 3,100.00 | 71,300.00 |
  | S1 supporting, NZ | 1,900.00 (Hana: 1,300.00 + 600.00 from 2025-26, RD4) | | | | 1,900.00 |
  | **NZ eligible** | 57,900.00 | 11,400.00 | 800.00 | 3,100.00 | **73,200.00** |
  | S2 supporting, overseas | | | | 9,000.00 spent, **8,133.33** counts | 8,133.33 |
  | **Total eligible** | 57,900.00 | 11,400.00 | 800.00 | 11,233.33 | **81,333.33** |

  C1: 56,000.00 + 11,400.00 + 800.00 + 3,100.00 = 71,300.00. NZ eligible:
  71,300.00 + 1,900.00 = 73,200.00.

  Overseas limit: 0.1 × 73,200.00 ÷ 0.9 = 8,133.333… → rounded down to the
  cent, **8,133.33** (decision 32), so 9,000.00 − 8,133.33 = **866.67** of
  S2 doesn't count. Total eligible: 73,200.00 + 8,133.33 = **81,333.33**.
  Check: 10% of 81,333.33 is 8,133.333, and 8,133.33 is not more than that.
  S2 is all contract expenditure, so the whole 866.67 comes off contract;
  had S2 spent in more than one category, the 866.67 would come off each in
  proportion to what it spent there (decision 43).

  The minimum is tested on the total **after** the overseas limit (RD18;
  decision 31): 81,333.33 is at least 50,000.00 and under 120,000,000.00.
  C1, S1 and S2 have an approval covering 2026-27 (RD3).
  **Credit: 0.15 × 81,333.33 = 12,199.9995 → rounded down to the cent,
  12,199.99** (decision 32).
- **RD17** Approved research provider (2027-28, a different year, like
  IR1240 p 72 "Hannah"): Kea's own eligible expenditure is **10,000.00**
  and it pays an approved research provider **20,000.00** (after the
  provider's own ineligible costs, LY 6). Total 30,000.00 is under
  50,000.00, so only the provider's **20,000.00** counts: credit **3,000.00**.
  The return must then name the provider and give its IRD number (IR1060).
- **RD18** Overseas limit before the minimum: NZ eligible **44,100.00**
  and foreign **6,000.00**. Limit 0.1 × 44,100.00 ÷ 0.9 = **4,900.00**, so
  total eligible is 44,100.00 + 4,900.00 = **49,000.00**: under 50,000.00,
  **no credit**. Counting the foreign spend in full would give 44,100.00 +
  6,000.00 = 50,100.00, over the minimum. Tohyee uses 49,000.00: LY 4(1)(a)
  tests "eligible expenditure", and IR1240 p 14 says the excess over the
  limit isn't eligible (decision 31). The report shows "under the $50,000
  minimum after the overseas limit".
- **RD19** Exactly 50,000.00 **qualifies** (decision 30): LY 4(1)(a) and
  IR1240 p 13 say "$50,000 or more" and IRD's web page "at least", even
  though IR1240 p 17 says "more than" and p 72 "must exceed". Credit 0.15 ×
  50,000.00 = **7,500.00**. 49,999.99 doesn't qualify.
- **RD20** Rounding, always **down to the cent** so a claim is never
  overstated (decision 32):
  - credit: total eligible **50,000.05** gives 0.15 × 50,000.05 =
    7,500.0075 → **7,500.00**;
  - overseas limit: NZ eligible **50,000.00** gives 0.1 × 50,000.00 ÷ 0.9 =
    5,555.555… → **5,555.55** (IR1240 p 71's SA Co shows its limit in whole
    dollars, 55,556, rounded up; Tohyee's figure is never more than the
    limit). Check: 10%
    of 50,000.00 + 5,555.55 = 55,555.55 is 5,555.555, and 5,555.55 is not
    more than that.

What Tohyee can't see: an organisation and its **associates** share the
$120 million maximum (IR1240 p 72-73), and each
organisation in Tohyee is its own database, so the report only shows a
reminder to check this, never a combined figure. When a year's eligible
expenditure passes $2 million the report notes that the significant
performer (criteria and methodologies) route exists (TAA 68CC; IR1240 p 19,
p 113); Tohyee doesn't support it.

### Contemporaneous records

IR1240 wants records made **at the time** of the R&D, not backdated or
created at the end of the year or project; their credibility is better if
they show the author and the date of creation (IR1240 p 19, p 97, p 100).
There's no fixed frequency: the test is whether it gives confidence the
record is reliable, and weekly or fortnightly estimates, or monthly records
for staff on R&D full time, can do (IR1240 p 100). Usage of materials and
equipment should be recorded at the time, and apportionment needs an audit
trail (IR1240 p 100). Records are kept for 7 years after the end of the tax
year (IR1240 p 17, p 101).

So every R&D record (activity, time entry, timesheet approval, tag, usage
log entry, apportionment rule, approval details) stores:

- **who**: the signed-in user, never a name from the request;
- **when entered**: the server's time when it's saved, which nobody can type
  or change;
- **the date of the work** it describes, which the person enters;
- for edits and removals, **history**: the old and new values, who and when.
  A removed record stays in history and drops out of the totals.

The claim report shows how long after the work each record was entered and
marks records changed after they were first entered. Records entered **more
than 14 days** after the work are flagged (decision 38). Late or changed
records aren't refused (IR1240 sets no fixed rule) but are listed
separately with their hours and cost so Jess can decide whether to claim
them.

- **RD21** On time: Hana enters 6 h on C1 for Wed 1 Jul 2026 on Fri 3 Jul
  2026 at 09:14. The report shows "entered 2 days after the work"; 2 is not
  more than 14, so it isn't flagged.
- **RD22** Late (a variation; in Kea's totals every pay has a timesheet):
  on 16 Mar 2027 Hana enters 40 h on C1 for the week of 10-14 Aug 2026. The
  report shows "entered **214 days** after the work (14 Aug 2026)" (17 days
  left in August + 30 + 31 + 30 + 31 + 31 + 28 + 16 = 214), over 14 days, so
  it's flagged. The pay for that fortnight was posted in August with the
  default split (60% C1), so the R&D figures use the **posted pay run's
  tags** (decision 37): the 60% split is listed under "default split, no
  time record" and left out of the total (RD7). The timesheet is listed
  under "entered late": 40 h × 30.90 an hour (2,472.00 ÷ 80) =
  **1,236.00**, not in the total. It counts only if someone with payroll
  access reallocates the posted pay's tags, which is a change with history
  (who, when, old and new split); the reallocated line still shows "entered
  late".
- **RD23** Changed: on 20 Jul 2026 Hana changes her 1 Jul entry from 6 h to
  7 h. History: "6 h, entered 3 Jul 2026 09:14 by Hana; changed to 7 h on 20
  Jul 2026 by Hana". The report uses 7 h and marks it "changed 17 days after
  entry". Jess changing the rent rule of RD10 from 15% to 20% on 25 Mar
  2027 with effect from 1 Apr 2026 is shown the same way: the report gives
  both figures (7,200.00 and 9,600.00), who changed it and when, and marks
  the rule "changed after the period it covers".

Files attached to R&D records (approval letters, statements, floor plans,
depreciation workings) are part of these records and are **kept for 7 years
after the end of the income year** (decision 45): for 2026-27, until 31 Mar
2034. A file can be **replaced**, with the old one kept in history (who
replaced it and when), but **not deleted**.

### Deadlines for a 31 March balance date

Reminders Tohyee shows owners and admins for Kea's **2026-27** year (no-agent
dates, RD24):

| Reminder | Due | Source |
| --- | --- | --- |
| Criteria and methodologies approval (significant performers only) | 30 Sep 2026 for 2026-27 (passed); 30 Sep 2027 for 2027-28 | TAA 68CC(3); IR1240 p 19, p 113; IRD due dates page |
| Approval to exceed the $120 million maximum | 7 May 2027 | IR1240 p 73 |
| **General approval** application, including supporting activity in the year before | **Wed 30 Jun 2027** | TAA 68CB(2B); IR1240 p 19, p 108, p 119; IRD due dates page |
| Variation for a material change to an approved activity | Wed 30 Jun 2027 | TAA 68CB(7); IR1240 p 111 |
| Income tax return, without a tax agent's extension | Wed 7 Jul 2027 | IR1060 |
| **R&D supplementary return**: 30 days after the income tax return's due date | **Fri 6 Aug 2027** | TAA 33E; IR1240 p 9, p 103; IR1060; IRD due dates page |
| Variation to add supporting activity done in the following year (2027-28) | Fri 30 Jun 2028 | TAA 68CB(7B); IR1240 p 119 |
| Latest the income tax return can be filed for the credit to count: 1 year after its due date | Fri 7 Jul 2028 | LY 3(2)(a); IR1240 p 103 |

- **RD24** These dates are worked from the balance date: the last day of
  the 3rd month after the year (general approval), 30 days after the income
  tax return's due date (supplementary return) and the last day of the 15th
  month (following-year supporting activity variation). For a **30
  September** balance date general approval is due **15 January** (IR1240
  p 19). With a **tax agent's extension of time** the supplementary return
  is due 30 days after the extended due date (IR1240 p 103: return due 31
  Mar 2026 → supplementary return 30 Apr 2026, and the income tax return
  filed by 31 Mar 2027). Tohyee shows **only the no-agent dates**, with the
  note "If you have a tax agent or an extension of time, your income tax
  return, R&D supplementary return and last filing date are later; check
  with your agent" (decision 49). Late applications and returns can't be
  accepted and the claim is declined (IR1240 p 104; IRD due dates page);
  a due date on a weekend or public holiday moves to the next working day
  (IRD due dates page). Both returns must be filed electronically (IR1240
  p 104).
- **RD25** The reminders say what's due and link to myIR; they don't record
  that anything was filed. A reminder stops when its date has passed or, for
  general approval, when approval details covering the year are entered
  (RD3). Reminders show **from 60 days before** each date, to **owners and
  admins** (decision 48): general approval due Wed 30 Jun 2027 shows from
  Sat 1 May 2027 (30 Jun − 60 days); the supplementary return due Fri 6 Aug
  2027 shows from Mon 7 Jun 2027.

### The claim report (what R3 must produce)

The supplementary return asks for these (IR1240 p 103-105; IR1060; IRD
"R&D supplementary return" page), **per project**:

- expenditure by category: materials, consumables and overheads; R&D tax
  depreciation; employee related costs; contract expenditure; approved
  research provider (separately, counted once);
- the % of eligible expenditure on **core** activities (supporting is the
  rest);
- how much relates to **overseas** R&D, **internal software development**,
  **feedstock** (and how far it exceeds the output's market value) and
  **commercial production**;
- the declaration that core and supporting activities haven't materially
  changed since approval, or what changed;
- for joint ventures and partnerships the parties, their IRD numbers and
  shares, and whether an associated person also claims (IR1240 p 72-73,
  p 105);

and for the return as a whole: the approved research providers' names and
IRD numbers when the total is under $50,000; whether a refund is wanted and
the labour-related taxes for the refundability cap (PAYE, ESCT and FBT;
IR1060); the evaluation questions (including the previous year's R&D
expenditure and ineligible expenditure on R&D, which aren't part of the
claim); and the credit for the income tax return's R&D tax credit field
(IR1240 p 103).

- **RD26** Kea's 2026-27 report, project "Low-power soil sensor":

  | Figure | Amount |
  | --- | --- |
  | Materials, consumables and overheads | 11,400.00 |
  | R&D tax depreciation (including Investment Boost) | 800.00 |
  | Employee related costs | 57,900.00 |
  | Contract expenditure (NZ 3,100.00 + overseas 8,133.33) | 11,233.33 |
  | of which overseas (9,000.00 spent, 866.67 over the limit) | 8,133.33 |
  | Approved research provider | 0.00 |
  | **Total eligible R&D expenditure** | **81,333.33** |
  | Core activities' share: 71,300.00 / 81,333.33 | 87.66% |
  | Of which internal software development, feedstock, commercial production | 0.00 each |
  | Of which supporting activity from 2025-26 (RD4) | 600.00 |
  | Ineligible expenditure tagged to R&D | 9,000.00 (and 866.67 over the overseas limit) |
  | Listed, not counted: default split, no time record; entered late; not used by year end | 0.00 each |
  | **R&D tax credit** | **12,199.99** |

  Check: 11,400.00 + 800.00 + 57,900.00 + 11,233.33 + 0.00 = 81,333.33.
  The overseas amount stays in the category it was spent in, with an "of
  which overseas" line (decision 43). Core %: 71,300.00 ÷ 81,333.33 × 100 =
  87.6639…% → to two decimals, rounded down, **87.66%** (decision 44);
  supporting is the rest, 1,900.00 + 8,133.33 = 10,033.33. Labour-related
  taxes come from payroll (P10) once it's built; Tohyee has no FBT, so the
  report leaves that for the return.
- **RD27** Every figure drills down to the lines and records behind it (who
  tagged what, when), with the apportionment rules and their bases, the
  hours per employee per activity with the hourly cost, exchange rates for
  foreign lines and the feedstock worksheet, which is the worksheet
  "reconciling" the claim that IR1240 p 101-102 lists. The report
  reconciles to the ledger: tagged amounts add up to the posted lines. The
  "no material change" declaration isn't prefilled when an activity changed
  after its approval was entered (RD3). Exporting the report saves the file
  in the organisation with who exported it and when, so later changes to
  the year's records show as differences from the last export; Tohyee has
  no "filed" status for anyone to type.

### How NetSuite and Xero do it

Neither documents a New Zealand RDTI feature that the agent could find on 1
Oct 2026. The sandbox couldn't open netsuite.com, docs.oracle.com, xero.com
or central.xero.com, so this is from search results only:

- **Xero**: Xero Central's "Track payroll expenditure in Xero"
  (<https://central.xero.com/s/article/Payroll-tracking-in-Xero>) describes
  tracking categories on payroll through employee groups and timesheet
  categories; Xero Projects tracks time and costs per project. R&D would be
  a tracking category or a project.
- **NetSuite**: no help topic on R&D tax credits found; third-party
  consultants describe the US credit (Form 6765) using projects, classes and
  custom segments.

Tohyee's proposal is closest to NetSuite's custom segments (CS1) and Xero's
tracking: a tag on cost lines. The activity is its own register because it
needs core and supporting links, places, approvals and record stamps that a
category value can't hold.

### Not supported yet (refused rather than guessed)

- Deciding whether an activity is R&D, or whether a cost is "additional"
  in commercial production (LY 5(1)(c)): the report lists commercial
  production tags for Jess.
- Refundability (the labour-related tax cap and the refund), carrying
  credits forward and shareholder continuity, credit ordering, imputation
  credits and provisional tax (IR1240 p 19-20).
- Significant performers: criteria and methodologies approval and R&D
  certificates (TAA 68CC; IR1240 p 113).
- Joint ventures, partnerships, look-through companies and consolidated
  groups (IR1240 p 105-106); associates' combined figures.
- Ineligible entities (LY 3(2): e.g. Crown research institutes, tertiary
  education organisations, Callaghan Innovation Growth Grant recipients,
  R&D contractors): the organisation decides whether it can claim.
- The internal software development $25 million cap (Sch 21B B cl 16).
- Feedstock market values and the year-end valuation of unsold output.
- Calculating tax depreciation or Investment Boost (DI 5): they're entered
  per asset for the year (RD11; decision 33).
- A tax agent's extended due dates: only the no-agent dates are shown, with
  a note (RD24; decision 49).
- GST adjustments for a change of use (IR1240 p 75, James).
- Approved research provider status, the R&D loss tax credit, and levy
  bodies.
- Filing in myIR; payroll calculations.

### Decided (R&D Tax Incentive)

Decided 1 Oct 2026 on Jess's instruction to research and make the call; see
`docs/DECISIONS.md` (decisions 30-50) for sources. The examples above follow
them; Jess hasn't approved the examples yet.

- **Exactly $50,000.00 qualifies** (RD19; decision 30).
- **The minimum is tested after the 10% overseas limit** (RD18; 31).
- **Overseas limit and credit rounded down to the cent** (RD16, RD20; 32).
- **Tax depreciation, entered per asset for the year and split by its usage
  log; Investment Boost counts as depreciation**; never book depreciation
  (RD11; 33, checked against schedule 21B part A cl 1 on 1 Oct 2026).
- **A default % split counts only when it's 100% R&D**; any other is listed
  as "default split, no time record" and left out (RD7; 34).
- **Leave and training are spread over the year** (RD6; 35).
- **Employee costs are only those IRD lists**; ACC levies, FBT and other
  employer costs are left out (RD5; 36).
- **Only the posted pay run's tags count**; a late timesheet is listed as
  "entered late" and changing it is a reallocation with history (RD22; 37).
- **Records entered more than 14 days after the work are flagged** (RD21,
  RD22; 38).
- **One supporting activity may support several core activities**; each
  cost line is tagged to one activity (RD2; 39).
- **Approval reference stored with the letter attached (required), marked
  "not checked with IRD"** (RD3; 40).
- **Goods not used by year end are ineligible for that year** and listed to
  tag in the year they're used (RD8; 41).
- **Foreign currency at the bill's rate; realised exchange gains and losses
  left out** (RD13; 42).
- **Overseas spending stays in its category with an "of which overseas"
  line**; a limit reduction is spread in proportion (RD16, RD26; 43).
- **Core % to two decimals, rounded down** (RD26; 44).
- **Files on R&D records kept 7 years after the year**; replaceable with
  history, not deletable (45).
- **One "% of an account" overhead rule with a required basis** from IR1240
  p 15's list and the calculation attached (RD10; 46).
- **Tagging allowed without an approval, with a warning**; credit only for
  activities with an approval covering the year (RD3; 47).
- **Deadline reminders from 60 days before, to owners and admins** (RD25;
  48).
- **Only the no-agent due dates, with a note** about agents and extensions
  (RD24; 49).
- **Payroll split: each R&D share rounded down to the cent, the remainder to
  non-R&D** (RD5; 50).

### Stage R3: the claim report (examples RD28-RD42)

What stage R3 builds, in the order the report works it out (Tax › R&D claim
report). It's **read-only**: it posts nothing and changes no amount, and it
never says an activity "qualifies". Rules already pinned down above (RD3,
RD4, RD7, RD10, RD16-RD27, decisions 30-50) are followed as written; where
they left a choice, the call is a new decision (66-75 in
[DECISIONS.md](DECISIONS.md)). Extra sources read for R3:

- IRD, "R&D tax incentive due dates"
  (<https://www.ird.govt.nz/research-and-development/tax-incentive/research-and-development-tax-incentive-due-dates>,
  last updated 1 Apr 2026, read 1 Oct 2026): general approval "due no later
  than the last day of the 3rd month following the end of the 1st income
  year" (31 March balance date: 30 June; 30 September: 15 January);
  criteria and methodologies "due the last day of the 6th month before the
  end of the 1st income year" (31 March: 30 September the year before);
  supplementary return "due within 30 days after your income tax return due
  date" (31 March: 6 August; 30 September: 14 February); "If a due date falls
  on a weekend or public holiday, it will be considered on time if we
  receive your application on the next business day."
- IRD, "Eligible expenditure"
  (<https://www.ird.govt.nz/research-and-development/tax-incentive/eligibility/eligible-expenditure>,
  last updated 28 Apr 2021, read 1 Oct 2026): employee costs are "salaries and
  wages, bonuses, employee share schemes, employee recruitment and relation
  costs, overtime, holiday and long-service pay, superannuation
  contributions"; in commercial production "the amount you can claim is
  limited to expenditure in relation to your employee's contribution to the
  R&D" and expenditure "you can show is additional"; "Expenditure incurred
  with an approved research provider is not subject to the minimum
  threshold."
- IR1240 p 63-64 and LY 5(1)(c), LY 7 as saved in
  `docs/sources/ir1240-pages-49-on.md` and
  `docs/sources/income-tax-act-ly-and-esct.md` (read 1 Oct 2026).

The examples use Kea Sensors Ltd's 2026-27 year again, with a payroll:
**Hana Rewi** (salary 62,400.00, fortnightly, KiwiSaver with a 3.5%
employer contribution), **Ben Tait** (salary 52,000.00, fortnightly, not in
KiwiSaver) and **Mere Ngata** (salary 70,000.00, fortnightly, not in
KiwiSaver). Jess has payroll access; Sam the bookkeeper and Vic the viewer
don't.

**Payroll without timesheets** (RD5-RD7, RD22; decisions 34, 36, 37, 50,
56, 57). Pay runs (P3) post each employee's pay split by their cost
allocation and keep the per-employee split; timesheets (P9) aren't built, so
R3 works from **the allocation the pay run used**, never from a payroll
calculation of its own (decision 37). An employee's R&D share counts only
when the allocation is **100% R&D** (decision 34); otherwise it's listed as
"default split, no time record" and left out. (Since payroll P9, pay runs
keep the shares they split pay by, approved timesheets count for the days
they cover (TS5-TS9), and the screen says "Pay counts from approved
timesheets for the days they cover; for other days, only when the
employee's cost allocation is 100% R&D." RD28-RD32 are pays with no
timesheet, so they're unchanged.)

- **RD28** Full-time R&D, from the allocation. Hana's allocation from 1 Apr
  2026 is 100% C1. Kea's fortnightly pay run for 6-19 Jul 2026, paid 22 Jul
  2026, posts her ordinary time **2,400.00** (62,400.00 ÷ 26), employer
  KiwiSaver **84.00** (3.5% of 2,400.00, before ESCT, as the pay run posts
  it) and a **50.00** reimbursement for soil test kits she bought. Her R&D
  cost is 2,400.00 + 84.00 = **2,484.00**, all C1, employee related costs
  (100% of 2,484.00, rounded down to the cent: decision 50). The 50.00
  reimbursement isn't pay, so it isn't an employee cost (IR1240 p 63's list;
  decision 66) and isn't counted; it's a goods cost, which a pay run line
  can't be tagged as yet. ACC levies aren't in a pay run at all (decision
  36).
- **RD29** Part-time on R&D, no time record (RD7 as built). Ben's allocation
  from 1 Apr 2026 is **60% C1** and **40% Operations** (a department, not
  R&D). The same pay run posts his ordinary time **2,000.00** (52,000.00 ÷
  26). His C1 share 2,000.00 × 60% = **1,200.00** is listed under "default
  split, no time record" and **left out** of the total (decision 34).
- **RD30** 100% R&D across two activities. Mere's allocation from 1 Apr 2026
  is **70% C1** and **30% S1**. The pay run posts her ordinary time
  **2,692.31** (70,000.00 ÷ 26 = 2,692.307… rounded by the pay run). Each R&D
  share is rounded down (decision 50):
  - C1: 2,692.31 × 70% = 1,884.617 → **1,884.61**
  - S1: 2,692.31 × 30% = 807.693 → **807.69**
  - not R&D: 2,692.31 − 1,884.61 − 807.69 = **0.01**

  Both count: the allocation is 100% R&D. (The pay run's own journal split,
  which shares cents out so the lines add up, gives 1,884.62 and 807.69; R&D
  uses the rounded-down shares so it's never overstated.)
- **RD31** A later allocation doesn't change a posted pay. On a later day
  Jess adds an allocation for Hana effective from **1 Apr 2026** of 50% C1
  and 50% Operations (backdated). The 22 Jul pay was approved before it was
  entered, so it keeps the allocation it was posted with: Hana's 2,484.00
  still counts (decision 67). Pay runs approved after the new allocation
  was entered use it.
- **RD32** Late records. A pay counts from the allocation it used; that
  allocation was **entered** (the server's date it was saved) some days
  after the pay period ended. When that's more than 14 days, the pay is
  flagged "entered late" like a tag (decision 38): an allocation entered on
  1 Oct 2026 for the period ending 19 Jul 2026 is "entered 74 days after the
  pay period" (12 days left in July + 31 + 30 + 1 = 74) and flagged; it still
  counts, and the report lists it so Jess can decide (decision 67). An
  allocation entered before the period ended is "entered before the pay
  period ended" and never flagged.
- **RD33** Payroll access (decision 6; P1b). Jess (payroll access) sees each
  pay: "Hana Rewi, PAYRUN-1 paid 22 Jul 2026: 2,484.00 to C1". Sam and Vic
  see C1's **employee related costs as one total** (2,484.00 + 1,884.61 =
  4,368.61 from payroll) and S1's (807.69), and the "default split, no
  time record" **total** (1,200.00), but no employee's name or pay. The CSV
  export follows the same rule: per-employee rows only for people with
  payroll access. A department total that's one person's pay is accepted
  (decision 6), and so is an activity total.

**Overhead rules** (RD10, RD23; decisions 46, 68). Set under the claim
report, by bookkeepers and above. A rule is "**% of an account** to an
activity, from a date (to a date)", with a **basis** from IR1240 p 15's list
and a **description of the calculation** (e.g. "lab 30 m² of 200 m²"), and
the **workings attached**: without the basis, the description or the file it
isn't saved. It's applied **when the report runs** to every posted line on
the account dated in the rule's period (bills, expense claims, spend money and
manual journals, excluding GST, as tags are), rounded down per line. It posts
nothing and adds no tag.

- **RD34** Rent. Kea's rent account (6150) has bills from Harbour Property
  Ltd dated **1 Apr**, **1 May** and **1 Jun 2026**, each **4,000.00 + GST
  600.00**. Jess sets "15% of 6150 Rent to C1 from 1 Apr 2026, basis floor
  area, lab 30 m² of 200 m²" with the floor plan attached. Each line gives
  4,000.00 × 15% = **600.00**; 600.00 × 3 = **1,800.00** to C1, materials,
  consumables and overheads. (RD10's full year is 7,200.00; the tests use
  three months.) Refused:
  - no basis, no description, or no file ("Attach the workings that show
    how the % was worked out (IR1240 p 15, p 102).");
  - a second rule on 6150 that would take the account over 100% on any day
    (e.g. 90% to S1 from 1 May 2026: 15% + 90% = 105%);
  - a second rule for C1 on 6150 overlapping the first;
  - an account that isn't an expense account, or a book depreciation account
    (decision 33).

  A rent bill dated **1 Jul 2026** that Sam has **tagged** by hand (20% to
  S1: **800.00**) keeps its tag: the rule skips lines with their own tag and
  lists them as "has its own tag", so a line is never counted twice
  (decision 68). The 1 Jul line counts 800.00 to S1, not 600.00 to C1.
- **RD35** Changing a rule (RD23 as built). Jess changes the rule to **20%**
  with effect from the **same date, 1 Apr 2026**, attaching new workings.
  Tohyee keeps the 15% rule (marked "replaced", with who and when) and adds
  the 20% one linked to it. C1 now gets 4,000.00 × 20% = 800.00 a line,
  **2,400.00** for the three bills, and the report shows "**previously
  1,800.00** under the rule entered by Jess on …; changed after the period
  it covers began". Changed with effect from a **later** date (say 20% from
  1 Jun 2026), the 15% rule ends on 31 May 2026 and stays in force before
  then: 600.00 + 600.00 + 800.00 = **2,000.00**. Ending a rule sets its last
  day; nothing is deleted. Each rule is stamped with who entered it and when,
  and a rule entered more than 14 days after the start of its period is
  flagged "entered late" (decision 38).

**The overseas limit across categories** (RD16; decision 43, 70).

- **RD36** Had S2 (overseas) spent **5,000.00** on contract expenditure and
  **4,000.00** on materials (9,000.00 in all), with NZ eligible 73,200.00,
  the limit is still 0.1 × 73,200.00 ÷ 0.9 → **8,133.33**. It's shared
  between the two in proportion to what was spent, each rounded down to the
  cent, and the cents left over go to the largest remainder (the earlier
  category first on a tie), so the parts add up to the limit exactly
  (decision 70):
  - contract: 5,000.00 × 8,133.33 ÷ 9,000.00 = 4,518.5166… → 4,518.51
  - materials: 4,000.00 × 8,133.33 ÷ 9,000.00 = 3,614.8133… → 3,614.81
  - 4,518.51 + 3,614.81 = 8,133.32, so the 0.01 left goes to contract
    (remainder 0.0066… is larger than 0.0033…): **4,518.52** and
    **3,614.81**, total 8,133.33.

  Over the limit: contract 5,000.00 − 4,518.52 = **481.48**, materials
  4,000.00 − 3,614.81 = **385.19**, together 866.67 as in RD16.

**Supporting activities and the core activity's year** (RD4; LY 5(1)(ab);
IR1240 p 38, p 118-119; decision 69).

- **RD37** RD4 as built. S1 supports C1 only, and C1's first income year is
  2026-27. S1's 600.00 tagged on **15 Mar 2026** (2025-26) shows in the
  **2025-26** report as "supporting activity before its core activity: claim
  with 2026-27" (not counted there), and the **2026-27** report counts it
  with S1's employee related costs and shows "of which supporting activity
  from 2025-26: 600.00". Only the year immediately before counts.
- **RD38** No core activity in the year. Supporting activity **S3** "Sensor
  housing materials survey" supports core activity **C2**, which has no
  approval for 2026-27; S3 itself is in an approval. S3's **450.00** tagged
  in 2026-27 is listed as "supporting activity: none of the core activities
  it supports has an approval for 2026-27" and **not counted** (IR1240 p 38:
  a year with only supporting activity claims nothing; decision 69).

**Feedstock and commercial production** (RD14; LY 5(1)(c); Sch 21B B cl 22;
decision 71).

- **RD39** A tag flagged **feedstock** (trial-batch components **2,500.00**,
  materials) is listed as "feedstock: the output's value isn't recorded, so
  it isn't counted" and **left out**: eligible feedstock is only the part
  over the output's value (IR1240 p 81-82) and Tohyee can't record that yet.
  A tag flagged **commercial production** on materials (**1,000.00**) is
  listed and left out: in commercial production only an employee's
  contribution, or costs shown to be additional, count (LY 5(1)(c); IRD's
  eligible expenditure page), and Tohyee can't judge "additional". A
  commercial production tag on **employee related costs** (**500.00**)
  counts, and shows as "of which commercial production: 500.00".

**The claim** (RD16-RD20, RD26; decisions 30-32, 44, 47, 72). The report
works it out in this order, from the counted amounts of activities with an
approval covering the year:

1. NZ eligible: everything counted that isn't overseas;
2. the overseas limit (RD16, RD20) and its spread (RD36);
3. total eligible = NZ + overseas within the limit;
4. the minimum (RD18, RD19): $50,000.00 or more → the total is claimed;
   under it, only approved research provider expenditure is (RD17);
5. the maximum: at most $120,000,000.00 is claimed (LY 4(3));
6. the credit: 15% of what's claimed, rounded down to the cent (RD20);
7. per project, the return's figures (RD26), with the core share rounded
   down to two decimals.

- **RD40** The maximum (a different, made-up organisation). NZ eligible
  **130,000,000.00**: claimed **120,000,000.00**, credit 0.15 ×
  120,000,000.00 = **18,000,000.00**, and the report shows "**10,000,000.00
  over the $120 million maximum**; an organisation and its associates share
  the maximum (IR1240 p 72-73); approval to exceed it is due 7 May". The
  figures by category stay as spent (decision 72); the return's total is
  the claimed amount.

**Deadlines** (RD24, RD25; decisions 48, 49, 73). Worked out for a **31
March balance date** only; any other balance date shows "Tohyee works these
dates out only for a 31 March balance date; see IRD's due dates page" and
no dates (decision 73).

- **RD41** For **2027-28** (1 Apr 2027 - 31 Mar 2028): general approval
  **Fri 30 Jun 2028**; income tax return Fri 7 Jul 2028; the supplementary
  return is due 30 days after the return's due date, **Sun 6 Aug 2028**,
  shown as "Sun 6 Aug 2028 (on time if received Mon 7 Aug 2028)"; approval
  to exceed the maximum Sun 7 May 2028 (on time Mon 8 May 2028); criteria
  and methodologies Thu 30 Sep 2027; following-year supporting variation Sat
  30 Jun 2029 (Mon 2 Jul 2029); last filing date for the credit Sat 7 Jul
  2029 (Mon 9 Jul 2029). Weekends move to the next business day (IRD's due
  dates page); **public holidays aren't checked**, as in payroll's IRD due
  dates, and the report says so. Each date is worked from the date before
  it's moved (6 Aug is 30 days after 7 Jul whatever day 7 Jul is). All the
  dates are listed on the claim report for everyone who can see it.

  **Reminders** (RD25) are shown to owners and admins on the home page and
  the claim report, for **general approval** (until approval details
  covering the year are entered), the **supplementary return**, and the
  **variation for a material change** (only while an activity with costs in
  the year shows "changed since approval was entered"), each from 60 days
  before its date until the date (as moved) has passed, and only for an
  organisation with R&D activities. For **2026-27**: on **30 Apr 2027** none
  show; on **1 May 2027** "General approval for 2026-27 due Wednesday 30 Jun
  2027" shows; once an approval covering 2026-27 is entered it stops; on **7 Jun
  2027** "R&D supplementary return for 2026-27 due Friday 6 Aug 2027" shows; on
  **7 Aug 2027** it has passed and stops. The other dates (criteria and
  methodologies, approval to exceed the maximum, the following-year
  variation, the income tax return and the last filing date) are in the
  list but not reminded about (decision 73).

**Exporting** (RD27; decision 74).

- **RD42** Jess exports the 2026-27 report as CSV. Tohyee records the export
  (who, when, the income year and the report's summary figures: by project
  and category, the total, the overseas limit and the credit, but **no
  employee's pay**) in the R&D history, and the CSV downloads. Sam then tags
  another bill line 1,000.00 to C1. The report shows "Exported by Jess on …;
  changed since: Materials, consumables and overheads (Low-power soil
  sensor) X → X + 1,000.00, Total eligible …, R&D tax credit …". There's no
  "filed" status. The CSV has one row per figure (section, project,
  activity, category, amount) and the drill-down lines; rows naming an
  employee only for someone with payroll access.

Who sees what: the claim report, like tagged costs, is for **viewers and
above** (decision 75); per-employee pay only with payroll access (RD33);
reminders only for owners and admins (decision 48). Overhead rules are set
by bookkeepers and above.

Not built in R3 (refused rather than guessed): timesheets (built since in
payroll P9: TS5-TS9 replace the "100% R&D only" rule where timesheets
exist), RD6's spreading of leave and RD22's reallocation to a late
timesheet;
reimbursements in a pay run as goods costs; feedstock output values (RD14);
deciding "additional" costs in commercial production; supporting activity in
the year after the core activity's year (LY 5(1)(ab)(ii), by variation);
non-resident employees' pay as foreign expenditure (an allocation to an
overseas activity is overseas; nothing else is); refundability and the
labour-related taxes; the previous year's figures for the evaluation
questions; deadlines for balance dates other than 31 March; public holidays
in due dates; associates' combined maximum.

### Questions for Jess (claim report), decided

Decided on 2 Oct 2026: decisions 220-223 (part-time staff settled by timesheets; reimbursements and feedstock later stages; exports keep summary figures). What was asked is kept below.

1. **Part-time R&D staff until timesheets exist.** Now an employee whose
   allocation isn't 100% R&D earns no credit at all (decision 34), so for
   Kea's Ben the report lists 1,200.00 and claims nothing. Is that what you
   want until timesheets (P9) are built, or should payroll P9 come before
   anyone relies on the report?
2. **Reimbursements in a pay run** (RD28) aren't counted anywhere. Should a
   later stage let them be tagged as materials, like an expense claim's
   receipts?
3. **Feedstock** (RD39): should a later stage record the output's value at
   year end (who entered it and when) so the part over it can be claimed?
4. **Exports** (RD42) keep the summary figures, not the CSV file itself, so
   no employee's pay ends up in a file every viewer can open. Do you want the
   file kept too, visible only to people with payroll access?

## NZ payroll: IRD rates and calculations (examples not yet approved by Jess)

Stage P2 of payroll (#60). Jess hasn't approved these. They cover IRD's
rates and the calculations for **one ordinary pay**; there are no pay runs,
journals or payslips yet. Every figure comes from IRD's **Payroll
Calculations & Business Rules Specification** ("the spec") for the pay
date's tax year, read on 1 Oct 2026 (the 2025-26 edition, version 1.0 of 1
April 2025, and the 2026-27 edition, version 1.0 of 24 March 2026). The
documents' names, editions, URLs and SHA-256 hashes are in
`src/lib/payroll/rates/2025-26.ts` and `2026-27.ts`. The examples are
IRD's own wherever IRD gives one: from the spec, the PAYE deduction tables
**IR340** (weekly and fortnightly) and **IR341** (four-weekly and monthly),
April 2025 and April 2026 editions, the **IR335** Employer's guide
(September 2026) and the **KS4** KiwiSaver employer guide (April 2026).
Page numbers are the printed ones. "Truncate" means drop the digits, as
IRD's rules say: never round.

Tests: `tests/unit/payroll-rates.test.ts` (PR1, and checks on the data
files), `tests/unit/payroll-calculations.test.ts` (PR2-PR15) and
`tests/unit/payroll-ird-tables.test.ts` (PR16).

- **PR1 Rates by pay date.** Each edition covers pay dates 1 April to 31
  March: a pay dated 31 Mar 2026 uses 2025-26 rates and one dated 1 Apr 2026
  uses 2026-27 rates. Each value in a file also has its own date range, so a
  rate IRD changes part way through a year is a second entry. Pay dates
  before 1 Apr 2025 or after 31 Mar 2027 are refused ("Not supported yet
  (refused rather than guessed): Tohyee has no IRD payroll rates for pay
  dates on 2027-04-01"), never carried forward.
  Rates in the files (spec section 2 and 5):

  | | 2025-26 | 2026-27 |
  | --- | --- | --- |
  | Income tax (from 31 July 2024, both) | 10.5% to $15,600; 17.5% to $53,500 (less $1,092.00); 30% to $78,100 (less $7,779.50); 33% to $180,000 (less $10,122.50); 39% above (less $20,922.50) | same |
  | ACC earners' levy | 1.67%, maximum liable earnings $152,790, maximum levy $2,551.59 | 1.75%, $156,641, $2,741.22 |
  | IETC (ME codes) | $520 from $24,000; reduces by 13c a dollar above $66,000; none from $70,000 | same |
  | Secondary codes SB, S, SH, ST, SA | 10.5%, 17.5%, 30%, 33%, 39% plus the levy (12.17%, 19.17%, 31.67%, 34.67%, 40.67%) | plus the levy (12.25%, 19.25%, 31.75%, 34.75%, 40.75%) |
  | ND, NSW, CAE and EDW | 45%, 10.5%, 17.5%, 17.5% plus the levy (46.67%, 12.17%, 19.17%) | plus the levy (46.75%, 12.25%, 19.25%) |
  | Student loan | 12% over $24,128 a year: $464 a week, $928 a fortnight, $1,856 four-weekly, $2,010.66 a month | same |
  | KiwiSaver employee rates | 3% (default), 4%, 6%, 8%, 10% | 3.5% (default), 4%, 6%, 8%, 10%; 3% with a temporary rate reduction |
  | KiwiSaver employer minimum | 3% | 3.5% (3% allowed with a temporary rate reduction) |
  | ESCT (from 1 April 2025, both) | 10.5% to $18,720; 17.5% to $64,200; 30% to $93,720; 33% to $216,000; 39% above | same |

- **PR2 M and M SL (spec 5.2).** IRD's ESS example 4 (2026-27 spec page 42;
  2025-26 spec page 37): tax code M SL, four-weekly salary $3,500.00.
  Annual income $3,500 x 13 = $45,500 (cents dropped). Tax $45,500 x 17.5% -
  $1,092 = $6,870.50; ACC levy $45,500 x 1.75% = $796.25; total $7,666.75; a
  week $7,666.75 / 52 = $147.4375, truncated **$147.43**; four-weekly
  $147.43 x 52 / 13 = **$589.72 PAYE**, as IRD shows. With the 2025-26
  levy (1.67%, $759.85) the same pay is $146.73 a week and **$586.92**, as
  the 2025-26 spec shows. M SL's PAYE is the same as M's.
- **PR3 More M pays from IRD.** Weekly, 2025-26: $500.03 is **$74.85** and
  $515.03 is **$77.72** (spec 5.20.2: the RD 68 example, 2025-26 page 83);
  $600.00 is **$94.02** (KS4 page 11). Weekly, 2026-27: $600.00 is **$94.50**
  (IR340 April 2026 page 20); $880.00 is **$148.40** (IR335 page 28, Lani).
  Fortnightly, 2026-27: $2,000.00 is **$343.00** (IR340 page 128).
- **PR4 ACC earners' levy.** The annual levy is annual income x the rate,
  not rounded, below the maximum liable earnings, and the maximum levy from
  it (spec 5.2 step 4): 2026-27, $45,500 is **796.25**, $156,640 is
  **2741.2** and $156,641 or more is **2741.22**; 2025-26, $45,500 is
  **759.85** and $26,001 is **434.2167**. Annual income must be whole
  dollars. IRD's rules include the levy in PAYE and never split a pay's PAYE
  into tax and levy, so neither does Tohyee. Above the maximum: IR341 April
  2026 page 103, four-weekly $15,504.00 on M: annual $201,552, tax
  $57,682.78 + levy $2,741.22 = $60,424.00, $1,162.00 a week, **$4,648.00**
  four-weekly, as IRD's example shows.
- **PR5 ME (spec 5.3).** As M, less the IETC. Weekly, 2026-27: $600.00 is
  annual $31,200, IETC $520: ($4,368.00 + $546.00 - $520) / 52 =
  **$84.50** (IR340 page 20). $1,280.00 is annual $66,560, IETC $520 - $560
  x 13% = $447.20: **$248.19** against M's $256.79 (IR340 page 37). From
  $70,000 a year ME is the same as M ($3,013.00 a week: **$852.34** both,
  IR340 page 81).
- **PR6 Secondary codes (spec 5.6).** Pay truncated to whole dollars x (the
  code's rate + the levy), truncated to cents; no annualising. IR340 April
  2026 page 213, weekly $457.00: SB **55.98**, S **87.97**, SH **145.09**, ST
  **158.80**, SA **186.22**. IR341 April 2026 page 286: four-weekly
  $15,504.00 on SA is $15,504 x 40.75% = **$6,317.88**. Each SL code's PAYE
  is the same as its code without SL.
- **PR7 ND (spec 5.8).** 46.75% of whole dollars in 2026-27: IR335 page 13,
  Brad's $860 week is **$402.05**. In 2025-26 (46.67%) the same pay is
  **$401.36**.
- **PR8 NSW (spec 5.5).** 10.5% plus the levy, on whole dollars: Mike's
  $960.00 in 2026-27 is $100.80 tax + $16.80 levy = **$117.60** (2026-27 spec
  page 26); his $800.00 in 2025-26 is $84.00 + $13.36 = **$97.36** (2025-26
  spec page 20).
- **PR9 CAE and EDW (spec 5.7).** 17.5% plus the levy, on whole dollars:
  $457.89 is $457 x 19.25% = **$87.97** in 2026-27 and $457 x 19.17% =
  **$87.60** in 2025-26.
- **PR10 Student loan on main income (spec 5.4).** Pay truncated to whole
  dollars; nothing at or below the pay period threshold; otherwise 12% of
  the excess, truncated to cents. Four-weekly $3,500.00: ($3,500 - $1,856) x
  12% = **$197.28** (ESS example 4, both years). Weekly $464.00 is **0.00**,
  $464.99 is **0.00** (cents dropped) and $465.00 is **0.12** (IR340 April
  2026 page 17). Monthly $2,600.00: ($2,600 - $2,010.66) x 12% = $70.7208,
  **$70.72** (IR341 April 2026 page 116). Four-weekly $15,504.00:
  **$1,637.76** (IR341 page 103).
- **PR11 Student loan on secondary income (spec 5.6).** 12% of whole
  dollars, no threshold: weekly $457.00 on S SL is **$54.84** (IR340 page
  213); four-weekly $15,504.00 on SA SL is **$1,860.48** (IR341 page 286).
  Codes without SL (M, ME, SB-SA, ND, NSW, CAE, EDW) deduct **0.00**.
- **PR12 KiwiSaver employee deductions.** Gross (with its cents) x the rate,
  truncated to cents: 4% of $500.03 is $20.00012, **$20.00** (spec 5.20.2);
  3.5% of $3,500.00 is **$122.50** (ESS example 4); 3.5% of $600.00 is
  **$21.00** (KS4 page 11); 3.5% of $465.00 is $16.275, **$16.27** (IR340
  page 17). Only IRD's rates are accepted: 3.5% is refused for a pay dated
  in 2025-26; in 2026-27, 3% is refused unless the employee has a temporary
  rate reduction (then only 3% is accepted).
- **PR13 KiwiSaver employer contributions.** Gross x the rate, truncated to
  cents: 3% of $500.03 is $15.0009, **$15.00** (spec 5.20.2, 2025-26); 3.5% of
  $2,600.00 is **$91.00** (KS4 page 12); 10% of $800.00 is **$80.00** (IR335
  page 28). Below the minimum is refused: 3% for a pay dated 1 Apr 2026 or
  later, unless the employee has a temporary rate reduction (KS4 page 16:
  the employer can then reduce to 3%). Higher (voluntary) rates are allowed.
- **PR14 ESCT rate.** The ESCT rate threshold amount (last year's salary or
  wages plus gross employer contributions, or the employer's estimate) is an
  input; Tohyee doesn't estimate it. $54,216.00 is **17.5%** (spec 5.21.1);
  $14,425.88 is **10.5%**, $23,577.43 and $38,625.00 are **17.5%** (spec
  5.21.2); $48,300 is **17.5%** and $72,450 is **30%** (IR335 page 27).
  $18,720.00 is 10.5% and $18,721.00 is 17.5%; $18,720.50 falls between two
  of IRD's bands and is refused. $216,001 is 39%.
- **PR15 ESCT on a contribution (spec 5.21.3).** The contribution truncated
  to whole dollars x the ESCT rate, truncated to cents; the net contribution
  is the contribution with its cents less the ESCT. $122.50 at 17.5%: $122 x
  17.5% = **$21.35**, net **$101.15** (ESS example 4, 2026-27); $105.00 at
  17.5%: **$18.37**, net **$86.63** (2025-26). $79.04 at 17.5%: $79 x 17.5% =
  $13.825, **$13.82**, and $39.52: **$6.82** (spec 5.21.4). $24.00 at 17.5%:
  **$4.20**, net **$19.80** (spec 5.21.5). $91.00 at 17.5%: **$15.92**, net
  **$75.08**, and $91.17: **$15.92**, net **$75.25** (IR341 April 2026 pages
  116-117).
- **PR16 IRD's PAYE tables.** 976 rows of IR340 and IR341 (April 2025 and
  April 2026; every 97th row of each table, its last row and the rows either
  side of each tax, levy, IETC and student loan threshold) are in
  `tests/fixtures/ird-paye-tables.json` with their page numbers. For each
  row Tohyee's M, ME and SL (or SB-SA and SL), KiwiSaver at every rate, and
  net employer contribution and ESCT at every ESCT rate match IRD's figures
  exactly.

### Not supported yet (refused rather than guessed)

- Pay dates outside 1 Apr 2025 to 31 Mar 2027 (no edition covers them).
- Tax codes STC (tailored tax codes, which need the IR23 certificate's
  rate) and WT (schedular payments); student loan special deduction rates
  (SDR), Commissioner (SLCIR) and voluntary (SLBOR) deductions.
- Pay frequencies other than weekly, fortnightly, four-weekly and monthly.
- Gross pay, contributions or threshold amounts below zero.
- ESCT rate threshold amounts between two bands (e.g. $18,720.50).

Not built in this stage (not refusals: there's no function for them yet):
extra pays (bonuses, lump sums, back pay, pay on leaving), employee share
schemes, employer contributions taxed as salary (RD 68), estimating the
ESCT rate threshold amount, which employees must have employer
contributions (under 16 or over 65, savings suspensions, complying funds),
payroll giving, child support. Pay runs, journals, payslips and payday
filing are later stages.

### Decided (NZ payroll rates)

Decided 1 Oct 2026 on Jess's instruction to research and make the call; see
`docs/DECISIONS.md` (decisions 1-5) for sources.

- **Out-of-date IRD examples.** The 2026-27 spec's RD 68 example (page 88)
  and KS4 (April 2026, page 11) still show 2025-26 figures; the tests use
  them for 2025-26 only.
- **ESCT rounding** follows the spec (5.20.6, 5.21.3) and IR341: the
  contribution in whole dollars, truncated ($15.92, net $75.08), not KS4's or
  IR335's rounded worked examples.
- **The 3.5% employer minimum** applies to every pay dated 1 April 2026 or
  later, even if most of its period was in March. The spec also says "first
  full pay", but IRD's KiwiSaver changes page settles it: "all pay days from
  1 April ... even if your pay period covers before and after 1 April".
- **Every rate is picked by the pay date**, PAYE included (IR340 Aug 2024
  applied new rates to pay "paid on or after 31 July 2024").
- **ESCT threshold amounts between bands** (e.g. $18,720.50) stay refused;
  IRD's bands are whole dollars, so enter a whole-dollar estimate.
- **4% from 1 April 2028** (spec 2.3) will come with the edition that covers
  it.

## NZ payroll — pay runs (examples not yet approved by Jess)

Stage P3 of payroll (#60). Jess hasn't approved these. A **pay run** pays
one pay group for one pay period: a draft gets a line per employee from
their pay rate, people running pay add earnings and deductions, Tohyee
calculates PAYE, student loan, KiwiSaver and ESCT with the P2 functions
(rates by pay date, decision 1), and **approving** posts **one journal**
dated the pay date, with each employee's costs split by their cost
allocation on the pay date. Approved pay runs are never changed; voiding
posts the exact reversal. Paying wages and IRD (P4), payslips (P5),
payday filing (P6), leave (P8), timesheets (P9) and payroll reports (P10)
are later stages.

Sources, law first: IRD's **Payroll Calculations & Business Rules
Specification 2026-27** ("the spec", the edition in
`src/lib/payroll/rates/2026-27.ts`) for what each kind of pay is subject
to: PAYE is on taxable earnings, including all taxable allowances, and not
on non-taxable allowances or reimbursements (spec 5.7, 5.11: "Exclude
non-taxable amounts"); IRD's PAYE includes the ACC earners' levy and the
student loan deduction is on the same pay (5.2, 5.4); KiwiSaver deductions
and employer contributions are on gross salary or wages, which includes
overtime and "any other remuneration" but not reimbursements or
accommodation allowances (4.5.1); ESCT is on the employer's contribution
(5.20-5.21). The figures in PRUN3 are the spec's own (Employee Share
Scheme example 4, page 42, the pay before the ESS amount). Then
NetSuite for how pay items and pay runs post: each payroll item has its own
expense or liability account and committing a payroll batch posts gross
wages to expense, withholdings and employer contributions to liabilities and
net pay as owed to employees
([Creating Payroll Items](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1556724572.html),
[Payroll Item Types](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/bridgehead_N931377.html),
[Viewing Payroll Batches](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N948008.html));
paycheck lines take each employee's Department, Class and Location
(PE3-PE6). Where NetSuite (a US payroll) has no NZ answer, Xero Payroll NZ:
earnings rates, deductions and reimbursements as pay items
([Add a custom pay item](https://central.xero.com/s/article/Add-a-custom-pay-item),
[About deductions](https://central.xero.com/0/article/About-deductions)),
and draft, approve and post a pay run
([Process a pay run and pay employees](https://central.xero.com/0/article/Process-a-pay-run-and-pay-employees-NZ)).
The agent sandbox couldn't open docs.oracle.com or Xero Central, so those
pages were found by web search and not read in full; check them before
approving.

Tests: `tests/unit/payroll-pay-calculation.test.ts` (the pure per-employee
calculation, PRUN1-PRUN4, PRUN8) and
`tests/integration/payroll-pay-runs.test.ts` (PRUN1-PRUN11, against
PostgreSQL and the API routes).

### Pay items (set-up)

Each pay item has a category, a kind, its account, and its tax treatment.
The kinds and their treatment follow the spec; admins pick a kind, a name and
an account, and (for allowances) whether it's taxable and whether it counts
for KiwiSaver. Taxable means subject to PAYE, the ACC earners' levy and the
student loan deduction together (IRD's PAYE includes the levy, and the
student loan deduction is on all PAYE income); there's no kind that is only
some of those.

| Pay item (starting set) | Category | Kind | Account | PAYE, ACC levy, student loan | KiwiSaver | ESCT |
| --- | --- | --- | --- | --- | --- | --- |
| Ordinary time | Earnings | Ordinary time (hours x rate, or the salary for the period) | 6200 Wages and salaries | Yes | Yes | — |
| Overtime | Earnings | Overtime, hours x hourly rate x 1.5 | 6200 Wages and salaries | Yes | Yes | — |
| Allowance (taxable) | Earnings | Allowance, an amount | 6200 Wages and salaries | Yes | Yes | — |
| Holiday pay | Earnings | Holiday pay, an amount typed for now (stage P8 calculates it) | 6200 Wages and salaries | Yes | Yes | — |
| Reimbursement | Earnings | Reimbursement of actual costs, an amount | 6070 General expenses | No | No | — |
| Union fees | Deduction | After-tax deduction, an amount | 2250 Payroll deductions payable | — | — | — |
| KiwiSaver employer contribution | Employer contribution | KiwiSaver employer contribution, calculated | 6210 KiwiSaver employer contributions | No (ESCT instead) | — | Yes |

New organisations also get these liability accounts, and existing ones get
them at the code shown or the next free code after it: **2200 PAYE
payable** (marked as the PAYE account, including the ACC earners' levy),
**2210 KiwiSaver payable** (employee deductions and employer contributions
net of ESCT), **2220 ESCT payable**, **2230 Student loan payable**, **2240
Wages payable** (net pay owed to employees until it's paid, P4) and **2250
Payroll deductions payable**.

- **PRUN10 Pay items.** Every organisation starts with the set above. Mere
  (an admin with payroll access) adds "Tool allowance", an allowance,
  taxable, counting for KiwiSaver, to 6200; and "Meal allowance
  (non-taxable)", an allowance that isn't taxable, to 6200 (an allowance
  that isn't taxable doesn't count for KiwiSaver either). Ben (a bookkeeper
  with payroll access) can see pay items but can't add or change them
  (admins only). Earnings and employer contributions go to expense or
  direct costs accounts; deductions to liability accounts. Names are unique.
  Ordinary time and the KiwiSaver employer contribution can't be archived or
  changed except their name and account; other items can be archived, which
  keeps them on earlier pay runs. Refused (see PRUN8): leave, child
  support, payroll giving, employer contributions other than KiwiSaver, a
  reimbursement that is taxed, and a taxable item that isn't subject to the
  ACC earners' levy or student loan (other than Redundancy, P12). Extra
  pays, back pay and final pays came in P12 (XP1-XP14).

### Drafts

- **PRUN11 A draft.** Ben creates a pay run for pay group "Fortnightly
  salaries" for the period **28 Sep 2026 to 11 Oct 2026**, pay date **14 Oct
  2026**. The period is the group's frequency long (7, 14 or 28 days; a
  monthly period is a calendar month starting on the 1st). The draft has a
  line per employee in the group who isn't archived, started on or before
  11 Oct 2026 and hadn't finished before 28 Sep 2026: an employee on a
  salary gets Ordinary time of their annual salary divided by 52, 26, 13 or
  12, rounded half up to the cent (70,000.00 / 26 = 2,692.3077 → **2,692.31**);
  an hourly employee gets Ordinary time of their ordinary hours a week x 1,
  2 or 4 weeks at their hourly rate (a monthly hourly employee starts at 0
  hours to fill in). Hours x rate is rounded half up to the cent. The rate
  is the one in effect for the period (PE7). A second pay run for the same
  group and period start is refused unless the first was voided. A draft
  calculates from the employee's current details every time it's opened, so
  a fixed tax code or KiwiSaver rate shows straight away; approving keeps a
  copy of what it was calculated from. Drafts can be deleted, and an
  employee can be left out of a draft.

### Worked pay runs

- **PRUN1 Fortnightly salaries, split 60/40.** Pay group "Fortnightly
  salaries", period 28 Sep to 11 Oct 2026, pay date 14 Oct 2026 (2026-27
  rates).

  | | Hemi Walker | Kiri Tane | Total |
  | --- | --- | --- | --- |
  | Pay | $70,000.00 a year | $52,000.00 a year | |
  | Tax code, KiwiSaver | M; enrolled, 3.5% employee, 3.5% employer, ESCT 30% | M; not enrolled | |
  | Cost allocation on 14 Oct 2026 | 60% Sales, 40% Operations | 100% Sales | |
  | Ordinary time (gross) | 2,692.31 | 2,000.00 | 4,692.31 |
  | PAYE (incl. ACC earners' levy) | 555.58 | 343.00 | 898.58 |
  | Student loan | 0.00 | 0.00 | 0.00 |
  | KiwiSaver employee (3.5%) | 94.23 | 0.00 | 94.23 |
  | After-tax deductions | 0.00 | 0.00 | 0.00 |
  | **Net pay** | **2,042.50** | **1,657.00** | **3,699.50** |
  | KiwiSaver employer (3.5%, gross) | 94.23 | 0.00 | 94.23 |
  | ESCT (30% of $94) | 28.20 | 0.00 | 28.20 |
  | KiwiSaver employer, net of ESCT | 66.03 | 0.00 | 66.03 |
  | **Employer cost** (gross + employer KiwiSaver) | **2,786.54** | **2,000.00** | **4,786.54** |

  Hemi's ESCT rate is 30% because his ESCT rate threshold amount is
  $70,000 + 3.5% = $72,450 (spec 5.21.1, the 30% band is $64,201 to
  $93,720). Kiri's PAYE is IR340's fortnightly row for $2,000. Hemi's costs
  are split 60/40 with the largest-remainder rule (PE3): ordinary time
  2,692.31 → **1,615.39** Sales and **1,076.92** Operations; KiwiSaver
  employer 94.23 → **56.54** Sales and **37.69** Operations.

  Approving posts one journal, PAYRUN-1, dated 14 Oct 2026, origin
  "payroll", description "Pay run PAYRUN-1: Fortnightly salaries, 28 Sep
  2026 to 11 Oct 2026". Lines are by pay item, account and tracking, never
  by employee:

  | Account | Description | Department | Debit | Credit |
  | --- | --- | --- | --- | --- |
  | 6200 Wages and salaries | Ordinary time | Sales | 3,615.39 | |
  | 6200 Wages and salaries | Ordinary time | Operations | 1,076.92 | |
  | 6210 KiwiSaver employer contributions | KiwiSaver employer contribution | Sales | 56.54 | |
  | 6210 KiwiSaver employer contributions | KiwiSaver employer contribution | Operations | 37.69 | |
  | 2200 PAYE payable | PAYE | | | 898.58 |
  | 2210 KiwiSaver payable | KiwiSaver | | | 160.26 |
  | 2220 ESCT payable | ESCT | | | 28.20 |
  | 2240 Wages payable | Net pay | | | 3,699.50 |
  | **Total** | | | **4,786.54** | **4,786.54** |

  KiwiSaver payable is the employee's 94.23 plus the employer's 66.03 net.
  Tohyee also keeps, for people with payroll access only, each employee's
  share of each debit line (Hemi's 1,615.39, Kiri's 2,000.00 and so on), so
  the split can be checked and later reports can use it.

- **PRUN2 Hourly, overtime, an allowance, a deduction and a
  reimbursement.** Sione Fifita is paid weekly in pay group "Weekly wages":
  $22.50 an hour, 32 ordinary hours a week, tax code M, KiwiSaver 4%
  employee and 3.5% employer, ESCT 17.5% (threshold about $37,440 +
  3.5%), union fees, allocation 100% Operations on project "Cafe rebrand".
  Period 5 Oct to 11 Oct 2026, pay date 14 Oct 2026.

  | Pay item | Hours x rate | Amount |
  | --- | --- | --- |
  | Ordinary time | 32 x 22.50 | 720.00 |
  | Overtime | 4 x 33.75 (22.50 x 1.5) | 135.00 |
  | Tool allowance (taxable, counts for KiwiSaver) | | 25.00 |
  | Reimbursement (fuel receipt, not taxable) | | 42.60 |
  | **Gross** | | **922.60** |
  | Taxable earnings (and KiwiSaver earnings) | | 880.00 |
  | PAYE (IR335's weekly $880.00 example, Lani) | | 148.40 |
  | KiwiSaver employee (4% of 880.00) | | 35.20 |
  | Union fees | | 8.50 |
  | **Net pay** (922.60 − 148.40 − 35.20 − 8.50) | | **730.50** |
  | KiwiSaver employer (3.5% of 880.00) | | 30.80 |
  | ESCT (17.5% of $30) | | 5.25 |
  | KiwiSaver employer net | | 25.55 |
  | **Employer cost** (922.60 + 30.80) | | **953.40** |

  Journal PAYRUN-2, 14 Oct 2026: Dr 6200 "Ordinary time (project Cafe
  rebrand)" 720.00, Dr 6200 "Overtime (project Cafe rebrand)" 135.00, Dr
  6200 "Tool allowance (project Cafe rebrand)" 25.00, Dr 6070
  "Reimbursement (project Cafe rebrand)" 42.60, Dr 6210 "KiwiSaver employer
  contribution (project Cafe rebrand)" 30.80, all tagged Operations; Cr 2200
  PAYE 148.40, Cr 2210 KiwiSaver 60.75 (35.20 + 25.55), Cr 2220 ESCT 5.25,
  Cr 2250 "Union fees" 8.50, Cr 2240 Net pay 730.50; total **953.40**.
  Journal lines have no project column, so the project is in the line's
  description and on the payroll posting kept with the pay run.
  **Rounding:** 3.3 hours of overtime is 3.3 x 33.75 = 111.375 →
  **111.38** (half up, once, on hours x rate).

- **PRUN3 Student loan and KiwiSaver 3.5% employer with ESCT (IRD's
  figures).** Aroha Ngata, four-weekly, $3,500.00 a period ($45,500.00 a
  year), tax code M SL, KiwiSaver 3.5% and 3.5% employer, ESCT 17.5%,
  allocation 100% Sales. Pay group "Four-weekly", period 14 Sep to 11 Oct
  2026, pay date 14 Oct 2026. The spec's ESS example 4 (page 42) has the
  same pay before its share-scheme amount: PAYE **589.72**, student loan
  **197.28**, KiwiSaver employee **122.50**, employer gross 122.50, ESCT
  **21.35**, employer net **101.15**. Net pay 3,500.00 − 589.72 − 197.28 −
  122.50 = **2,590.50**; employer cost **3,622.50**. Journal: Dr 6200
  Ordinary time Sales 3,500.00, Dr 6210 Sales 122.50; Cr 2200 PAYE 589.72,
  Cr 2230 Student loan 197.28, Cr 2210 KiwiSaver 223.65 (122.50 + 101.15),
  Cr 2220 ESCT 21.35, Cr 2240 Net pay 2,590.50; total 3,622.50. If Aroha's
  student loan box is ticked but her tax code is M (or the other way
  round), the pay run refuses to calculate her: "Aroha Ngata has a student
  loan but tax code M has no SL. Fix their tax code or student loan under
  Employees." (IRD's student loan deduction follows the tax code, 5.4.)

- **PRUN4 Pay date 1 April 2026, across the KiwiSaver change (decision 2).**
  Hemi (as PRUN1, but set up in March with KiwiSaver **3%** employee and **3%**
  employer, the 2025-26 defaults), pay group "Fortnightly salaries", period
  **19 Mar to 1 Apr 2026**. With pay date **1 Apr 2026** the 2026-27 rates
  apply to the whole pay, even though most of the period is in March: the
  draft shows Hemi's problem "3% isn't a KiwiSaver employee rate on
  2026-04-01: use 3.5%, 4%, 6%, 8%, 10%." and approving is refused. (The
  3% employer rate is also refused: "The compulsory KiwiSaver employer
  contribution on 2026-04-01 is at least 3.5%.") Tohyee doesn't move him to
  3.5% by itself (question for Jess). With the pay date moved to **31 Mar
  2026** (2025-26 rates) the same pay calculates: PAYE **553.44**, KiwiSaver
  employee 3% **80.76**, employer 3% **80.76**, ESCT 30% **24.00** (of $80;
  threshold $70,000 + 3% = $72,100), employer net **56.76**, net pay
  **2,058.11**. After Hemi's rates are updated to 3.5%/3.5%, pay date 1 Apr
  2026 gives PRUN1's figures for Hemi: PAYE 555.58, KiwiSaver 94.23 and
  94.23, ESCT 28.20, net pay 2,042.50.

### Approving, locks and voiding

- **PRUN5 Approving in a locked period is refused.** The lock date is 31 Oct
  2026 and a draft pay run has pay date 28 Oct 2026. Approving is refused
  with "2026-10-28 is in a locked period (locked up to 2026-10-31). Use a
  later date, or ask an owner or admin to reopen the period on Period
  close."; the pay run stays a draft and no journal is posted.

- **PRUN6 Void.** PRUN1's pay run is voided on **20 Oct 2026**: Tohyee posts
  journal VOID-PAYRUN-1 dated 20 Oct 2026, the exact reversal of PAYRUN-1
  (every line, tag and description, debit and credit swapped, total
  4,786.54), marked as PAYRUN-1's reversal, and the pay run becomes Voided.
  A void date before the pay date is refused ("The void date can't be before
  the pay date (2026-10-14)."), and so is a void date in a locked period.
  Approved and voided pay runs can't be edited, deleted or approved again
  ("PAYRUN-1 is approved, so it can't be changed. Void it and run the pay
  again."); the database refuses it too. After the void, a new pay run for
  the same group and period can be created. The journals can't be corrected
  from the ledger ("posted by a pay run … void the pay run").

- **PRUN7 Approver must be different (optional).** Under Payroll › Pay
  items, an admin can turn on "The person who approves a pay run must be
  different from whoever prepared it". With it on, Ben (who created or
  changed the draft) is refused: "You prepared this pay run, so someone else
  has to approve it." Jess, who didn't touch it, can approve. With it off
  (the default), Ben can approve his own pay run. Who prepared and approved
  is taken from the signed-in user, never from the request.

### Refused and access

- **PRUN8 Refused rather than guessed.** Each of these is refused with "Not
  supported yet (refused rather than guessed)" and what it is:
  - pay items for leave (Holidays Act, stage P8; holiday pay is a typed
    amount for now), child support, payroll giving, and employer
    contributions other than KiwiSaver (extra pays, back pay and final pays
    came in P12, XP1-XP14);
  - someone on a salary who **starts after the period starts** or (since
    P12) **finishes before it ends** (part of a period); a **pay rate that
    changes inside the period**; a monthly
    period that doesn't start on the 1st. A finish date or pay rate change
    inside the period entered after the draft was made shows as that
    employee's problem on the draft, so it can't be approved. Someone
    moved to another pay group isn't paid twice: a pay run for days they're
    already paid for on another pay run (not voided) is refused ("Moe Mover
    is already paid for 2026-10-05 to 2026-10-11 on PAYRUN-7. Take them off
    one of the pay runs (or void it).");
  - calculating an employee whose tax code the rates don't support (STC,
    WT; from P2), whose student loan box disagrees with their tax code, or
    whose employer KiwiSaver contribution has no ESCT rate set;
  - negative amounts (corrections and back pay), and approving a pay run
    where anyone's net pay would be below zero.
  The draft shows each employee's problem; approving is refused until
  they're fixed.

- **PRUN9 Payroll access and what others see (decision 6).** Everything about
  pay items and pay runs (reading them too) needs payroll access and at
  least the bookkeeper role; Ben without payroll access gets "You need
  payroll access to see payroll…" (403). Pay run journals show only totals
  by account and tracking: line descriptions are pay item names (and a
  project), never employee names, and the per-employee split is only on the
  pay run. Audit events (pay run created, changed, approved, voided; pay
  item added or changed) never contain IRD numbers, bank accounts or pay
  amounts, and the "journal posted" audit event for a pay run leaves out its
  total.

### Questions for Jess (pay runs), decided

Decided on 2 Oct 2026: decisions 234-246. What was asked is kept below.

1. **KiwiSaver 3% → 3.5% on 1 April 2026.** Tohyee refuses a pay dated on or
   after 1 April at 3% (PRUN4) rather than moving people to 3.5% itself.
   Should it offer to update them?
2. **Pay rate changes inside a period** are refused (PRUN8); should Tohyee
   pro-rate by days, by working days or by hours?
3. **Allocation date.** Costs are split by the allocation on the **pay
   date**, as the task says, not the period end. Agreed?
4. **Salary per period** is annual / 52, 26, 13 or 12 rounded half up; hours
   x rate rounded half up. IRD truncates PAYE and contributions but says
   nothing about the pay itself. Agreed?
5. **Separate IRD liability accounts** (PAYE, KiwiSaver, ESCT, student loan),
   or one "PAYE and deductions payable" as some NZ charts have?
6. **Projects** go in the journal line's description (journal lines have no
   project field) and on the payroll postings. Enough until project costing
   reads payroll?
7. **Monthly hourly employees** start at 0 hours. Should it be weekly hours x
   52 / 12?
8. **Approver rule** covers whoever created or changed the draft. Should it
   also apply to admins and owners?
9. **One journal line per pay item** (e.g. Ordinary time and Overtime both on
   6200 are separate lines). Or one line per account?
10. **Monthly periods** must be calendar months. Do any clients pay monthly
    on other days (e.g. the 15th to the 14th)?
11. **Pay date before the period ends** (paying in advance) is allowed; a
    pay date before the period starts is refused. Agreed?
12. **Leaving someone out of a draft** can't be undone on that draft (delete
    the draft and start again). Is a way to add someone back needed?
13. **Splitting one pay item differently** from the employee's allocation
    (e.g. overtime always to one department) isn't built. Needed before
    timesheets (P9)?

## NZ payroll — paying wages and IRD (examples not yet approved by Jess)

Stage P4 of payroll (#60). Jess hasn't approved these. An approved pay run
(P3) leaves net pay owing to employees on **2240 Wages payable** and the
deductions owing to IRD on **2200 PAYE payable** (including the ACC
earners' levy), **2230 Student loan payable**, **2210 KiwiSaver payable**
(employee deductions and employer contributions net of ESCT) and **2220
ESCT payable**. P4 records the money leaving the bank for both: a **wage
payment** (Dr 2240, Cr the bank) from a pay run, and an **IRD payroll
payment** (Dr each liability, Cr the bank) for an IRD period. Each posts
one journal (origin "payroll"), so period locks apply, its bank line can be
matched to a statement line like any other payment, and it's undone by
voiding it (the exact reversal), never by correcting the journal.

Sources, law first. **IRD**, [Paying deductions to Inland
Revenue](https://www.ird.govt.nz/employing-staff/payday-filing/paying-deductions-to-inland-revenue)
(last updated 23 Mar 2026, read 1 Oct 2026): "If your gross annual PAYE
and ESCT is less than $500,000 you: need to pay deductions monthly, by the
20th of the following month"; above $500,000 "twice a month": wages paid
1st-15th "By the 20th of the same month", wages paid 16th-end of month "By
the 5th of the following month. Note: For period 16-31 December pay by 15
January not 5 January"; one payment to the EMP account can cover "pay as you
earn, child support deductions, KiwiSaver deductions, KiwiSaver
contributions, student loan deductions, Employer Superannuation
Contribution". IRD, [When to pay](https://www.ird.govt.nz/managing-my-tax/make-a-payment/when-to-pay)
(last updated 1 Apr 2026): "For due dates that fall on a weekend or public
holiday, we need to receive your payment on or before the next working
day." Employment information is a different deadline ("within 2 working
days of each payday" when filing electronically,
[Payday filing](https://www.ird.govt.nz/employing-staff/payday-filing),
last updated 24 Feb 2026); filing it is stage P6, not here. Then
**NetSuite** for paying liabilities: Pay Payroll Liabilities lists what's
owing by payroll item for a date range and lets you tick the items to pay,
so part payments are allowed
([Making Payroll Liability Payments](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N954201.html)).
NetSuite pays wages when a payroll batch is committed (US direct deposit),
which has no NZ answer, so **Xero Payroll NZ** for wages: the pay run's net
pay sits on Wages payable and the bank payment is coded to Wages payable,
not wages expense ([a Xero partner's guide](https://www.livingbusiness.co.nz/blog/reconcile-wages-in-xero-payroll);
Xero Central couldn't be opened by the agent's tools).

Tests: `tests/unit/payroll-ird-due-dates.test.ts` (IRD periods and due
dates, PPAY4, PPAY9) and `tests/integration/payroll-payments.test.ts`
(PPAY1-PPAY12, against PostgreSQL and the API routes).

The figures come from **PRUN1** (pay run PAYRUN-1, Fortnightly salaries,
pay date 14 Oct 2026: Hemi Walker net 2,042.50, Kiri Tane net 1,657.00,
total **3,699.50**; PAYE 898.58, KiwiSaver 160.26, ESCT 28.20) and **PRUN3**
(Aroha Ngata, Four-weekly, pay date 14 Oct 2026, its pay run is PAYRUN-2
here: net **2,590.50**; PAYE 589.72, student loan 197.28, KiwiSaver
223.65, ESCT 21.35). The bank account is **1000** (base currency NZD).

### Paying wages

- **PPAY1 Pay PRUN1's net wages in one payment.** On PAYRUN-1, Ben (a
  bookkeeper with payroll access) pays the wages: payment date **14 Oct
  2026**, from **1000**, amount **3,699.50** (the screen fills in what's
  unpaid). Tohyee posts journal **WAGES-1** dated 14 Oct 2026, origin
  "payroll", description "Wages paid for pay run PAYRUN-1: Fortnightly
  salaries, 2026-09-28 to 2026-10-11":

  | Account | Description | Debit | Credit |
  | --- | --- | --- | --- |
  | 2240 Wages payable | Net pay | 3,699.50 | |
  | 1000 Bank | Net pay | | 3,699.50 |

  PAYRUN-1 then shows net pay 3,699.50, paid 3,699.50, **unpaid 0.00**,
  and the payment in its list. Refused: 3,699.51 before the payment ("That's
  more than the 3,699.50 of net pay left to pay on PAYRUN-1."), and 0.01
  after it ("PAYRUN-1's net pay is already paid in full."); a payment dated
  **13 Oct 2026**, before the pay date ("The payment date can't be before
  PAYRUN-1's pay date (2026-10-14)."); a payment on a draft or voided pay
  run; a payment from an account that isn't a bank or credit card account,
  is archived, or isn't in NZD (as for supplier payments). PAYRUN-2's net
  pay is paid the same way: **WAGES-4**, 14 Oct 2026, 2,590.50.

- **PPAY2 Paying each employee separately (for matching).** When the bank
  shows one line per person, wages can be paid per employee instead. After
  WAGES-1 is voided (PPAY3), Ben pays PAYRUN-1 per employee on 14 Oct 2026:
  Hemi Walker **2,042.50** (WAGES-2) and Kiri Tane **1,657.00** (WAGES-3).
  Each journal is Dr 2240 / Cr 1000 for that amount with line description
  "Net pay" and journal description "Wages paid for pay run PAYRUN-1:
  Fortnightly salaries, 2026-09-28 to 2026-10-11 (one employee)": **never
  the employee's name** (decision 6), since anyone who can see the bank
  account sees its journal lines. The pay run's payment list (payroll access
  only) shows whose each one is. Refused: Hemi 2,042.51 ("That's more than
  the 2,042.50 of Hemi Walker's net pay left to pay on PAYRUN-1."); someone
  who isn't on the pay run; and mixing the two ways on one pay run, because
  a payment for the whole run can't say whose pay it was: "PAYRUN-1 is being
  paid per employee. Pay the rest per employee too, or void those payments
  first." (and the other way round, "PAYRUN-1 is being paid as a whole...").
  Part payments are allowed either way, up to what's unpaid.

- **PPAY3 Voiding a wage payment, and the order of undoing.** With WAGES-1
  active, voiding PAYRUN-1 is refused: "PAYRUN-1 has wage payments
  (WAGES-1). Void them first." (the database refuses it too). Ben voids
  WAGES-1 dated **14 Oct 2026**: journal **VOID-WAGES-1**, the exact
  reversal (Dr 1000 3,699.50 / Cr 2240 3,699.50), marked as WAGES-1's
  reversal; PAYRUN-1 is unpaid 3,699.50 again. A void date before the
  payment date is refused, and so is a payment voided twice. A payment
  reconciled with a bank statement line can't be voided until it's
  unreconciled (PPAY7). Once no active payments are left, the pay run can be
  voided (PPAY12).

### Paying IRD

- **PPAY4 What's owing to IRD for October 2026.** The organisation pays IRD
  **monthly** (Payroll › Pay items, "How often you pay IRD": monthly, or
  twice a month for employers whose gross annual PAYE and ESCT is
  $500,000 or more; IRD tells the employer which, Tohyee doesn't guess).
  An IRD period counts approved pay runs (not voided) **by pay date**, as
  IRD's rule does ("wages paid 1st-15th"). PAYRUN-1 and PAYRUN-2 are both
  paid on 14 Oct 2026, so Payroll › IRD payments shows for **1 Oct to 31
  Oct 2026**, **due Friday 20 Nov 2026**:

  | Liability | Account | PAYRUN-1 | PAYRUN-2 | Owing |
  | --- | --- | --- | --- | --- |
  | PAYE (incl. ACC earners' levy) | 2200 | 898.58 | 589.72 | **1,488.30** |
  | Student loan | 2230 | 0.00 | 197.28 | **197.28** |
  | KiwiSaver (employee and employer) | 2210 | 160.26 | 223.65 | **383.91** |
  | ESCT | 2220 | 28.20 | 21.35 | **49.55** |
  | **Total** | | 1,087.04 | 1,032.00 | **2,119.04** |

  The amounts are the pay runs' own credits to those accounts (their stored
  totals), so they always agree with the journals. After-tax deductions
  such as union fees (2250) aren't paid to IRD and aren't listed. Child
  support isn't supported yet (PRUN8), so there's none to pay.

- **PPAY5 A part payment, then the rest.** On **19 Nov 2026** Ben pays
  **PAYE 1,000.00** only, from 1000: journal **IRD-1**, description "IRD
  payroll payment for 2026-10-01 to 2026-10-31": Dr 2200 "PAYE" 1,000.00,
  Cr 1000 "IRD payroll payment" 1,000.00. October then shows PAYE paid
  1,000.00, owing **488.30**, total owing **1,119.04**. On **20 Nov 2026**
  he pays the rest in one payment, **IRD-2**:

  | Account | Description | Debit | Credit |
  | --- | --- | --- | --- |
  | 2200 PAYE payable | PAYE | 488.30 | |
  | 2230 Student loan payable | Student loan | 197.28 | |
  | 2210 KiwiSaver payable | KiwiSaver | 383.91 | |
  | 2220 ESCT payable | ESCT | 49.55 | |
  | 1000 Bank | IRD payroll payment | | 1,119.04 |

  October is then owing 0.00 on every liability. The payment date can't be
  before the period starts (1 Oct 2026). Paying after the due date is
  allowed (the screen shows it as late); Tohyee doesn't work out IRD's
  late payment penalties or interest.

- **PPAY6 Overpaying is refused.** Before IRD-2, paying PAYE **488.31** for
  October is refused: "That's more than the 488.30 of PAYE owing for
  2026-10-01 to 2026-10-31." After IRD-2, any amount is refused the same
  way, with 0.00. Paying for **November 2026**, with no pay runs, is refused
  ("Nothing is owing to IRD for 2026-11-01 to 2026-11-30."), and so is a
  period that isn't one of IRD's: for a monthly payer a period must start
  on the 1st ("For monthly IRD payments the period starts on the 1st of a
  month."). Each liability is checked on its own: a payment that's right in
  total but too much on one liability is refused.

- **PPAY7 Matching to the bank statement.** The bank statement for 1000 has
  **14 Oct 2026, -2,042.50**, **14 Oct 2026, -1,657.00** and **20 Nov 2026,
  -1,119.04**. On the -2,042.50 line, Tohyee suggests WAGES-2's bank line
  first (exact amount, origin "Payroll", reference WAGES-2, description "Net
  pay"), and matching it reconciles the line and posts nothing, like any
  match (BK4). The -1,119.04 line is matched to IRD-2 the same way. While
  matched, voiding WAGES-2 or IRD-2 is refused ("This is reconciled with a
  bank statement line ... Unreconcile it first"); unreconcile, then void.

- **PPAY8 Period locks.** With the lock date at **31 Oct 2026**, a wage
  payment dated **30 Oct 2026** is refused ("2026-10-30 is in a locked
  period (locked up to 2026-10-31). Use a later date, or ask an owner or
  admin to reopen the period on Period close."), and so is voiding a payment
  with a void date in the locked period and an IRD payment dated 30 Oct
  2026. Nothing is posted. Dated 2 Nov 2026, the same wage payment (or a
  void) is accepted: the pay run's journal stays in October and the payment
  is in November.

- **PPAY9 IRD's due dates.** From IRD's rules above, worked out per period:

  | Pays IRD | Period (by pay date) | Due | Day |
  | --- | --- | --- | --- |
  | monthly | 1 Oct to 31 Oct 2026 | 20 Nov 2026 | Friday |
  | monthly | 1 Nov to 30 Nov 2026 | 20 Dec 2026 | Sunday: IRD accepts it on Monday **21 Dec 2026** |
  | monthly | 1 Dec to 31 Dec 2026 | 20 Jan 2027 | Wednesday |
  | twice a month | 1 Oct to 15 Oct 2026 | 20 Oct 2026 | Tuesday |
  | twice a month | 16 Oct to 31 Oct 2026 | 5 Nov 2026 | Thursday |
  | twice a month | 16 Nov to 30 Nov 2026 | 5 Dec 2026 | Saturday: Monday **7 Dec 2026** |
  | twice a month | 16 Dec to 31 Dec 2026 | **15 Jan 2027** (not 5 Jan) | Friday |

  A due date on a Saturday or Sunday shows the Monday after as "IRD accepts
  payment by". Public holidays aren't checked (Tohyee has no list of them
  yet), so the screen says "If that day is a public holiday, IRD accepts
  payment on the next working day." The due date is shown, not enforced.
  For a twice-monthly payer, October 2026's pay runs on 14 Oct are in **1-15
  Oct 2026, due 20 Oct 2026**. If the frequency changes, a new payment for
  a period that overlaps one with active IRD payments but isn't the same
  period is refused ("IRD-3 already pays 2026-10-01 to 2026-10-31. Pay that
  period, or void IRD-3 first.").

### Access, privacy and order

- **PPAY10 Payroll access, decision 6 and the audit trail.** Paying wages
  and IRD, and seeing either screen, needs the bookkeeper role and payroll
  access: Noah (a bookkeeper without it) gets "You need payroll access to
  see payroll…" (403), as does a viewer; changing how often IRD is paid
  needs an admin. Journal lines and their descriptions never name an
  employee (only "Net pay", the liability names and the WAGES-n, IRD-n and
  PAYRUN-n references), so viewers see payroll in the ledger and the bank
  only as these totals. Audit events for wage and IRD payments (recorded,
  voided) hold the pay run, period, dates, bank account code, journal and
  whether it was one employee's pay, never an amount, a bank account number
  or an IRD number; the "journal posted" event leaves out the total for
  payroll journals (PRUN9).

- **PPAY11 Refused rather than guessed.**
  - **A bank file for paying wages** (a direct credit or batch payment
    file): not made in P4. Stage P5 makes ANZ, ASB and BNZ files
    (PBF1-PBF7); supplier batch payments still don't make one.
  - **Child support** and **payroll giving** (not deducted yet, PRUN8).
  - Working out **IRD's penalties and interest** for late payment, and
    **IRD's direct debit** or other ways of paying.
  - Paying wages **before the pay date** (a direct credit that leaves the
    day before): the payment is dated the pay date or later; a bank line a
    day or two earlier can still be matched to it (60-day window).
  - **Foreign-currency bank accounts** for wages or IRD.

- **PPAY12 Undoing in order.** Each step needs the one after it undone
  first: a **pay run** can't be voided while it has active wage payments
  (PPAY3) or while an active IRD payment pays the period its pay date is in
  ("IRD-1, IRD-2 pay 2026-10-01 to 2026-10-31, which includes PAYRUN-2's
  pay date. Void them first."), and a payment matched to a bank line can't
  be voided until it's unreconciled (PPAY7). Voiding PAYRUN-2 on **25 Nov
  2026** therefore goes: unreconcile the -1,119.04 line; void IRD-2 and
  IRD-1 (25 Nov 2026); void WAGES-4 (already voided in PPAY8 here); then
  void PAYRUN-2. October then owes PAYRUN-1's deductions only: PAYE 898.58,
  student loan 0.00, KiwiSaver 160.26, ESCT 28.20, total **1,087.04**.

### Questions for Jess (paying wages and IRD), decided

Decided on 2 Oct 2026: decisions 247-253 (question 3 still to check against IRD's IR328; question 4 waits for the Tax Administration Act's "working day"). What was asked is kept below.

1. **Bank files.** Which NZ bank batch formats should Tohyee make for
   wages (and supplier payments): ASB, ANZ, BNZ, Westpac, Kiwibank? Each has
   its own; none is built, so P4 makes no file.
2. **Monthly or twice a month** is a setting chosen by the organisation, as
   IRD tells each employer. Should Tohyee warn when the year's PAYE and
   ESCT pass $500,000? (IRD's page says "less than" and "more than"
   $500,000 and doesn't say which side exactly $500,000 is on.)
3. **December for monthly payers**: IRD's page gives 15 January only for
   twice-monthly payers' 16-31 December; monthly payers' December is shown
   as due 20 January, following the page. Please confirm against IRD's
   IR328 calendar.
4. **Public holidays** move a due date to the next working day; Tohyee
   moves weekends only, until it has a dated list of public holidays (P8).
5. **Voiding a pay run IRD has already been paid for** is refused until the
   IRD payment is voided (PPAY12). Should it instead leave a credit with
   IRD to use in a later period?
6. **Paying wages before the pay date** is refused (PPAY11). Allow it a few
   days early?
7. **Paid as a whole or per employee, not both** on one pay run (PPAY2).
   OK?

## NZ payroll — bank files for paying wages (examples not yet approved by Jess)

Part of payroll stage P5 (#60). Jess hasn't approved these. After a pay run
is approved (P3), Tohyee can make a **direct credit file** of the net wages
still to pay, in the format the organisation's bank takes, to upload in the
bank's business internet banking. Making a file **posts nothing and marks
nothing paid**: the money is recorded as paid with a wage payment (P4,
PPAY1-PPAY2), which is the screen's next step ("Make bank file", then
"Record as paid").

Sources, each bank's own published specification (summaries in
`docs/sources/nz-bank-direct-credit-formats.md`, re-read on the banks'
sites on 1 Oct 2026):

- **ANZ** "Domestic extended format"
  ([anz.co.nz](https://www.anz.co.nz/banking-with-anz/ways-to-bank/guides/domestic-extended-format/),
  no version or date shown): comma-separated, CR LF after each record;
  header `1`, transactions `2`, control `3`. The page's own example header is
  `1,,,,,,20060725,20060725,` (fields 2 to 6 empty, due date then creation
  date YYYYMMDD, and a comma at the end) and its control record example is
  `3, 503400,4,70192802466`. Transaction code **50** (the only one the page
  gives). Account numbers 16 digits with a 3-digit suffix ("00→000, 25→025";
  the suffix can't be more than 99). Amount in cents, up to 11 digits. The
  other party's reference and analysis code are marked required; the hash
  total is the sum of each account's branch (4) and base number (7),
  dropping the extra digits on the left past 11.
- **ASB** FastNet Business "Standard Bulk Payments", **MT9** fixed-length
  format ([FastNet Business File Formats Technical Guide, November 2012](https://www.asb.co.nz/content/dam/asb/documents/banking-with-asb/2012/asb-fnb-file-formats-technical-guide-nov-2012.pdf),
  section 2). Every record 160 characters, padded with spaces; "The header
  and all detail records must be completed with a carriage return. The
  carriage return at the end of the trailer record is optional." Header:
  file type `12`, the payer's bank (2), branch (4), unique number (7) and
  suffix ("01 expressed as 01¤", a space after a 2-digit suffix), due date
  DDMMCCYY then 5 spaces ("Correct"), client short name X(20), 109 spaces.
  Detail: `13`, the payee's bank, branch, unique number and suffix ("01
  expressed as 001"), transaction code **052** (salary/wages), amount
  9(10) "Align right and pad to the left with zeros", payee name X(20),
  internal reference X(12) (not sent to the bank), payee code, payee
  reference and payee particulars X(12), 1 space, payer name X(20), payer
  code, reference and particulars X(12), 4 spaces. Trailer: `13`, `99`,
  the check total 9(11) ("the sum of all the detail records' branch and
  unique numbers. If the number exceeds 11 characters, the remaining
  characters are not used. For example, if the sum is 123456789123, then
  the import file check total is shortened to 23456789123."), 6 spaces, the
  total amount 9(10), 129 spaces. Characters allowed: letters, numerals,
  spaces and `( ) * + - = ? [ ] _ { } ~ / & , . '`. ASB's CSV format isn't
  made (MT9 is ASB's preferred format and is fully specified).
- **BNZ** Internet Banking for Business "Payment file format guide"
  ([PDF, October 2024](https://www.bnz.co.nz/assets/business-banking-help-support/internet-banking/ib4b-file-format-guide.pdf)),
  file type **7** (direct credit; payroll is the same layout): comma
  delimited, "Each record must terminate with a carriage return line feed
  character (CRLF)", no trailing spaces, no commas in fields, extension
  `.afi` or `.txt`. Header `1,,,,<your account>,7,<due YYMMDD>,<created
  YYMMDD>,<indicator>` (the due date "cannot be earlier than today"; the
  indicator blank = one line on your statement for the whole file, I = a
  line per payment with your own details); transactions with code **52**
  (payroll; one code for the whole file), amount in cents, other party
  name (required), reference, code, a blank alpha reference, particulars,
  your name (required), your code, reference and particulars; control
  `3,<total>,<count>,<hash>` where the hash is the sum of digits 3 to 13 of
  each account, the rightmost 11 digits kept, "If the number is less than
  eleven digits then zero fill to eleven".
- **Westpac** and **Kiwibank**: no field-level specification is published
  on their own sites (Westpac One Business lists the formats it accepts;
  Kiwibank says files can be uploaded but doesn't publish a layout). Both
  are **refused rather than guessed**.

What goes on the statements (the same for every bank): the payee's
**particulars** are `Wages`, their **code** the pay run's reference
(`PAYRUN-1`) and their **reference** the pay date (`2026-10-14`); the
organisation's own statement details are the same three, and its name is
the organisation's name. Text is cut to the field's length (12, or 20 for
names) with trailing spaces removed; macrons are written without them
(Ōtepoti → Otepoti); any other character outside ASB's list above (a comma
included) is refused rather than changed.

Account numbers are checked before any file is made: bank (2 digits),
branch (4), account (7) and suffix (2 or 3), written with or without
hyphens or spaces (15 or 16 digits). Tohyee doesn't check the banks' check
digits (question 3 below).

The figures are PRUN1's and PRUN3's (PAYRUN-1: Kiri Tane net **1,657.00**,
Hemi Walker net **2,042.50**, total **3,699.50**; PAYRUN-2: Aroha Ngata net
**2,590.50**, pay date 14 Oct 2026). Employees are listed by last name.
The organisation is **Harbour Cafe Ltd**; the file is made on **13 Oct
2026** with due date **14 Oct 2026** (the pay date, unless changed).

| Employee | Bank account | Branch and account (hash part) |
| --- | --- | --- |
| Kiri Tane | 12-3191-0654321-01 | 31910654321 |
| Hemi Walker | 01-0242-0123456-00 | 02420123456 |
| Aroha Ngata | 02-0108-0987654-000 | 01080987654 |

PAYRUN-1's hash total is 31,910,654,321 + 2,420,123,456 = **34330777777**.

Tests: `tests/unit/payroll-bank-files.test.ts` (the files byte for byte,
hash totals, account numbers: PBF1-PBF4, PBF6) and
`tests/integration/payroll-bank-files.test.ts` (PBF1-PBF7 against
PostgreSQL and the API routes).

- **PBF1 ANZ file for PAYRUN-1.** Bank account 1000 is set up (Settings ›
  Bank files) with the format "ANZ domestic extended" and the account
  number 01-0505-0111222-00 (ANZ's file doesn't carry it). Ben (a
  bookkeeper with payroll access) makes the file on PAYRUN-1, from 1000,
  due 14 Oct 2026. The file, `PAYRUN-1 ANZ 2026-10-14.csv`, each line ending
  CR LF:

  ```
  1,,,,,,20261014,20261013,
  2,1231910654321001,50,165700,Kiri Tane,2026-10-14,PAYRUN-1,,Wages,Harbour Cafe Ltd,PAYRUN-1,2026-10-14,Wages
  2,0102420123456000,50,204250,Hemi Walker,2026-10-14,PAYRUN-1,,Wages,Harbour Cafe Ltd,PAYRUN-1,2026-10-14,Wages
  3,369950,2,34330777777
  ```

  Fields in a transaction: account, code 50, cents, name, reference, analysis
  code, alpha reference (blank), particulars, the organisation's name,
  analysis code, reference, particulars. The screen shows 2 payments,
  3,699.50, hash total 34330777777. PAYRUN-1 still shows **unpaid
  3,699.50** and no journal is posted.

- **PBF2 ASB MT9 file for PAYRUN-1.** Bank account 1010 "ASB cheque" is set
  up as "ASB FastNet MT9", account number 12-3011-0333444-00. The file
  `PAYRUN-1 ASB 2026-10-14.txt` has four records of exactly 160 characters,
  each followed by CR (shown with `·` for each space and the record's
  pieces split up):

  | Record | Pieces |
  | --- | --- |
  | Header | `12` `12` `3011` `0333444` `00·` `14102026·····` `Harbour·Cafe·Ltd····` + 109 spaces |
  | Kiri | `13` `12` `3191` `0654321` `001` `052` `0000165700` `Kiri·Tane···········` `PAYRUN-1····` `PAYRUN-1····` `2026-10-14··` `Wages·······` `·` `Harbour·Cafe·Ltd····` `PAYRUN-1····` `2026-10-14··` `Wages·······` `····` |
  | Hemi | `13` `01` `0242` `0123456` `000` `052` `0000204250` `Hemi·Walker·········` `PAYRUN-1····` `PAYRUN-1····` `2026-10-14··` `Wages·······` `·` `Harbour·Cafe·Ltd····` `PAYRUN-1····` `2026-10-14··` `Wages·······` `····` |
  | Trailer | `13` `99` `34330777777` `······` `0000369950` + 129 spaces |

  The detail's pieces are: payee bank, branch, unique number, suffix,
  transaction code, cents, payee name, internal reference, payee code,
  payee reference, payee particulars, a space, payer name, payer code,
  payer reference, payer particulars, 4 spaces.

- **PBF3 BNZ file for PAYRUN-1.** Bank account 1020 "BNZ wages" is set up
  as "BNZ IB4B", account number 02-0100-0555666-000. Made with "one line on
  our statement for the whole file" (the indicator blank), the file
  `PAYRUN-1 BNZ 2026-10-14.txt`, each line ending CR LF:

  ```
  1,,,,0201000555666000,7,261014,261013,
  2,1231910654321001,52,165700,Kiri Tane,2026-10-14,PAYRUN-1,,Wages,Harbour Cafe Ltd,PAYRUN-1,2026-10-14,Wages
  2,0102420123456000,52,204250,Hemi Walker,2026-10-14,PAYRUN-1,,Wages,Harbour Cafe Ltd,PAYRUN-1,2026-10-14,Wages
  3,369950,2,34330777777
  ```

  With "a line on our statement for each employee" the header ends `,I`
  instead (`1,,,,0201000555666000,7,261014,261013,I`) and nothing else
  changes. A due date before the day the file is made is refused: "BNZ
  won't take a due date before the day the file is made (2026-10-13)."

- **PBF4 One employee, and the hash total's zeros.** PAYRUN-2 (Aroha Ngata
  only, 2,590.50). BNZ, a line each: 

  ```
  1,,,,0201000555666000,7,261014,261013,I
  2,0201080987654000,52,259050,Aroha Ngata,2026-10-14,PAYRUN-2,,Wages,Harbour Cafe Ltd,PAYRUN-2,2026-10-14,Wages
  3,259050,1,01080987654
  ```

  BNZ zero-fills the hash total to 11 digits (01080987654). ANZ's page gives
  the hash total a maximum of 11 digits and writes its other numbers
  without leading zeros, so ANZ's control record is `3,259050,1,1080987654`;
  ASB's check total is a fixed 9(11) field, `01080987654`. When the hash
  total is more than 11 digits, the digits on the left are dropped by all
  three (ASB's own example: 123456789123 → 23456789123).

- **PBF5 What's left to pay, then "Record as paid".** The file has each
  employee's **unpaid net pay**: all of it before any payment; after
  per-employee payments (PPAY2), only what each still has unpaid. Ben pays
  Hemi's 2,042.50 per employee (a WAGES payment, PPAY2); the ANZ file for
  PAYRUN-1 then has Kiri only: `3,165700,1,31910654321`. Ben uploads it and
  records Kiri's 1,657.00 as paid; making a file again is refused: "Nothing
  is left to pay on PAYRUN-1." A pay run paid **in part as a whole**
  (PPAY1) can't say whose pay is left, so it's refused: "PAYRUN-1 has been
  paid in part as a whole, so Tohyee can't tell whose pay is left. Void
  that payment, or pay the rest in your bank's own screens." Employees with
  nothing to pay are left out.

- **PBF6 Refused rather than guessed.** Each of these makes no file:
  - **Westpac** and **Kiwibank**: "Not supported yet (refused rather than
    guessed): Westpac doesn't publish a field-level specification of its
    payment files. Ask Westpac for it." (and the same for Kiwibank). Settings
    › Bank files doesn't offer them, and says why.
  - an employee with **no bank account**: "Kiri Tane has no bank account.
    Add it under Payroll › Employees."; one that **isn't an NZ bank account
    number**: "Kiri Tane's bank account isn't a New Zealand bank account
    number (bank 2 digits, branch 4, account 7, suffix 2 or 3). Fix it under
    Payroll › Employees." The number itself isn't repeated in the message.
  - a **3-digit suffix over 99** on an ANZ or BNZ file (ANZ: "can't exceed
    99"; BNZ's 16-digit form is a 2-digit suffix with a zero in front):
    "Kiri Tane's account suffix 100 can't go in an ANZ file (ANZ takes
    suffixes up to 99)."
  - a name or text with a character outside the allowed list: "Kiri Tane's
    name has characters a bank file can't carry (@). Change it under
    Payroll › Employees."
  - a bank account that isn't set up for bank files: "Set up 1000 (Bank)
    for bank files first: an admin enters its account number and bank under
    Settings › Bank files."; a foreign-currency account; a draft or voided
    pay run ("PAYRUN-3 is a draft, so it has no bank file. Approve it
    first.").
  - an amount past the field (ANZ 11 digits, ASB 10, BNZ 12) or more than
    the file can hold (ANZ 99,999 payments, the 5-digit count; BNZ 99,998).
  - ASB's **CSV** format (its page 49 wasn't read; MT9 is fully specified).

- **PBF7 Settings, access and privacy.** Settings › Bank files lists each
  NZD bank account with its account number and format; only admins change
  them (bookkeepers can see them), and the number is checked as above.
  Making a file needs the bookkeeper role and payroll access (Noah, a
  bookkeeper without it, gets "You need payroll access to see payroll…",
  403). Employees' bank accounts are decrypted only while the file is made,
  inside that check, and are never logged or written to the audit log: the
  audit event "payroll_bank_file.made" holds the pay run, the bank
  account's code, the format, the due date and how many payments, never an
  amount or an account number (decision 6, PPAY10).

### Questions for Jess (bank files), decided

Decided on 2 Oct 2026: decisions 254-259 (questions 1, 2 and 5 still need a test upload with each bank). What was asked is kept below.

1. **ANZ's examples** end the header with a comma (`...,20060725,`) and put
   a space in the control record's total (`3, 503400,...`). Tohyee follows
   the header example and writes the total without the space (it's a
   number field). Please check one upload with ANZ.
2. **Leading zeros**: ANZ's page doesn't say whether the hash total is
   zero-filled (Tohyee doesn't, PBF4); ASB's check total is a fixed 9(11)
   field, which Tohyee zero-fills. And ASB says each record ends with "a
   carriage return": Tohyee writes CR only, not CR LF. Confirm with a test
   upload?
3. **Check digits**: the banks' check-digit rules for account numbers
   aren't in the sources, so only the shape is checked. Should Tohyee check
   them (the published algorithm would need a source)?
4. **Statement details**: particulars "Wages", code PAYRUN-n, reference the
   pay date. Would clients rather have the employee's own code (e.g. a
   staff number)?
5. **ANZ transaction code**: the page gives only 50 (standard credit), so
   ANZ files use 50, not 52 (payroll). Ask ANZ?
6. **Westpac and Kiwibank**: ask each bank for its specification, or wait?

## NZ payroll — payslips (examples not yet approved by Jess)

Payroll stage P5 (#60). Jess hasn't approved these. A **payslip** is made
for each employee on an **approved** pay run, from what the pay run kept
when it was approved, as a page to print, a PDF to download, or an email
to the employee with the PDF attached. Nothing is posted or changed.

Sources, law first:

- **Holidays Act 2003 s 81(2)** (holiday and leave record, from
  `docs/sources/holidays-act-2003.md`, read on legislation.govt.nz 1 Oct
  2026): "(a) the name of the employee: (b) the date on which the
  employee's employment commenced: (c) the number of hours worked each day
  in a pay period and the pay for those hours", then leave entitlements and
  leave taken (d)-(p); s 81(5): it "may be kept so as to form part of the
  wages and time record required to be kept under section 130 of the
  Employment Relations Act 2000"; s 82: the employee can ask for a copy.
- **Employment Relations Act 2000 s 130** (wages and time record): **not
  confirmed**. legislation.govt.nz returned 403 to our tools on 1 Oct 2026
  and the section isn't in `docs/sources/`. Employment NZ's
  [Record-keeping](https://www.employment.govt.nz/starting-employment/rights-and-responsibilities/record-keeping)
  page (updated 6 Nov 2025) summarises it as "the days the employee worked
  and the number of hours worked on those days" and "the wages paid in each
  pay period and how these have been calculated", kept for 6 years.
- **Employment NZ**, [Payslips](https://www.employment.govt.nz/pay-and-hours/pay-and-wages/payslips)
  (updated 4 Dec 2024): an employer doesn't have to give a payslip unless
  the employment agreement says so; without one the employee can ask for
  their wages and time and holiday and leave records. A payslip "may
  contain" name, start date, the bank account "if they're paid directly into
  their bank account", the pay date and pay period, leave balances, the pay
  rate, allowances, deductions, reimbursements, gross and net pay for the
  period and for the year to date, and the hours worked.
- Then **Xero Payroll NZ** for the layout (earnings, deductions, employer
  contributions, year to date); NetSuite (a US payroll) has no NZ payslip.

What a payslip shows, and why:

| On the payslip | Why |
| --- | --- |
| Employer's name; employee's name and start date | HA s 81(2)(a), (b) |
| Pay period, pay frequency and pay date | ERA s 130 as summarised by Employment NZ; Employment NZ payslips |
| Each earnings line: pay item, hours and rate (where it has them), amount; total hours | HA s 81(2)(c) (hours in the period and their pay); "how these have been calculated" |
| Gross pay; PAYE (including the ACC earners' levy); student loan; KiwiSaver employee (with the rate); other deductions by name; reimbursements (not taxed) | Wages paid and how they were calculated; Wages Protection Act s 4-5 (deductions) |
| Net pay and the bank account it's paid into, masked to its last 3 digits | Employment NZ payslips; masked for privacy |
| Employer KiwiSaver contribution and ESCT | Xero's payslip; IRD spec 5.20-5.21 |
| Year to date for the tax year (1 April to 31 March, by pay date) | Employment NZ payslips ("for the year to date") |
| Tax code | So the employee can check their PAYE |

Not on the payslip yet: **leave balances** (there's no leave until stage
P8) and **hours worked each day** (HA s 81(2)(c); there are no timesheets
until P9, so only the period's hours show). The IRD number isn't shown.

Tests: `tests/unit/payroll-payslips.test.ts` (the bank account mask, the
tax year and the year-to-date sums) and
`tests/integration/payroll-payslips.test.ts` (PSLIP1-PSLIP6 against
PostgreSQL, the API routes, the PDF and a real SMTP server).

- **PSLIP1 Hemi's payslip for PAYRUN-1** (PRUN1's figures).

  | | |
  | --- | --- |
  | Employer | Harbour Cafe Ltd |
  | Employee | Hemi Walker, started 1 Apr 2026 |
  | Pay period | 28 Sep 2026 to 11 Oct 2026 (fortnightly) |
  | Pay date | 14 Oct 2026 |
  | Tax code | M |

  | Earnings | Hours | Rate | Amount |
  | --- | --- | --- | --- |
  | Ordinary time | | | 2,692.31 |
  | **Gross pay** | | | **2,692.31** |

  | Deductions | Amount |
  | --- | --- |
  | PAYE (incl. ACC earners' levy) | 555.58 |
  | KiwiSaver employee (3.50%) | 94.23 |
  | **Net pay** | **2,042.50** |

  Paid into **-****-******6-00 (the bank account 01-0242-0123456-00 with
  everything but its last 3 digits hidden). Employer contributions:
  KiwiSaver employer (3.50%) 94.23, ESCT 28.20 (so 66.03 goes to his
  KiwiSaver). Lines that are 0.00 (student loan, other deductions) are
  left out. Year to date (1 Apr 2026 to 31 Mar 2027): gross 2,692.31, PAYE
  555.58, student loan 0.00, KiwiSaver employee 94.23, other deductions
  0.00, net pay 2,042.50, employer KiwiSaver 94.23, ESCT 28.20.

- **PSLIP2 Year to date.** A second fortnightly pay run, **PAYRUN-3**,
  period 12 Oct to 25 Oct 2026, pay date 28 Oct 2026, pays Hemi and Kiri
  the same again. Hemi's PAYRUN-3 payslip's year to date: gross
  **5,384.62**, PAYE **1,111.16**, KiwiSaver employee **188.46**, net pay
  **4,085.00**, employer KiwiSaver **188.46**, ESCT **56.40**; Kiri's:
  gross **4,000.00**, PAYE **686.00**, net pay **3,314.00**. The year to
  date counts approved pay runs (not voided ones) with a pay date in the
  same tax year, up to this pay run (on the same pay date, by pay run
  number), so PAYRUN-1's payslip still shows PSLIP1's year to date. If
  PAYRUN-3 is voided it has no payslip ("PAYRUN-3 is voided, so it has no
  payslips."), and a new PAYRUN-4 for the same period gives the same year
  to date as PAYRUN-3 did (the voided one isn't counted). A draft has no
  payslips either ("PAYRUN-4 is a draft, so it has no payslips. Approve it
  first."). The tax year runs 1 April to 31 March: a pay dated 31 Mar 2027
  is in 2026-27 and one dated 1 Apr 2027 starts 2027-28.

- **PSLIP3 Hours, an allowance, a reimbursement and a deduction** (PRUN2's
  figures). Sione Fifita, weekly, 5 Oct to 11 Oct 2026, pay date 14 Oct
  2026, tax code M, KiwiSaver 4%:

  | Earnings | Hours | Rate | Amount |
  | --- | --- | --- | --- |
  | Ordinary time | 32.00 | 22.50 | 720.00 |
  | Overtime | 4.00 | 33.75 | 135.00 |
  | Tool allowance | | | 25.00 |
  | Reimbursement: Fuel receipt (not taxed) | | | 42.60 |
  | **Gross pay** (36.00 hours) | | | **922.60** |

  Deductions: PAYE (incl. ACC earners' levy) 148.40, KiwiSaver employee
  (4.00%) 35.20, Union fees 8.50; **net pay 730.50**. Employer KiwiSaver
  (3.50%) 30.80, ESCT 5.25.

- **PSLIP4 Print and PDF.** The payslip page (Payroll › Pay runs ›
  PAYRUN-1 › Payslips › Hemi Walker) has Print and Download PDF. The PDF,
  `Payslip Hemi Walker 2026-10-14.pdf`, shows the same items and figures
  as the page (written by the same PDF pieces as invoices).

- **PSLIP5 Email.** Hemi's email address is hemi@harbourcafe.test; Kiri has
  none. Ben emails PAYRUN-1's payslips: Hemi's is queued to
  hemi@harbourcafe.test with the subject "Payslip for 14 Oct 2026 from
  Harbour Cafe Ltd" and the message "Kia ora Hemi, Your payslip for 28 Sep
  2026 to 11 Oct 2026, paid on 14 Oct 2026, is attached. Harbour Cafe Ltd"
  (no amounts in the email itself, so the stored message and the audit log
  never hold pay), and sent by the email job from the organisation's email
  account with the PDF attached; Kiri is skipped: "Kiri Tane has no email
  address. Add it under Payroll › Employees.". Emailing only Kiri is
  refused with that message. The audit log records on the pay run that a
  payslip email was queued and then sent, with the employee, the address,
  the subject and the attachment's name, never the payslip's figures. A
  draft pay run's payslips can't be emailed, and with no email account set
  up it's refused (503) as for invoices. The PDF is written when the email
  is sent, as the person who asked, so someone who has lost payroll access
  by then doesn't send it.

- **PSLIP6 Access.** Payslips (seeing, printing, downloading, emailing)
  need the bookkeeper role and payroll access: Noah (a bookkeeper without
  it) gets "You need payroll access to see payroll…" (403) and a viewer
  "This needs the bookkeeper role or higher in this organisation." (403).
  There's no employee self-service portal: employees get their payslip by
  email or on paper.

- **PSLIP7 The account it was paid into** (decision 262). Approving a pay
  run keeps each employee's bank account with their pay (encrypted). After
  Hemi changes his account to 12-3456-7654321-00, his PAYRUN-1 payslip
  still shows the account that pay went into, **\*\*-\*\*\*\*-\*\*\*\*\*\*6-00**; a later
  pay run's payslip shows the new one, **\*\*-\*\*\*\*-\*\*\*\*\*\*1-00**. Pays approved
  before this was kept show the employee's current account, as before.

### Questions for Jess (payslips), decided

Decided on 2 Oct 2026: decisions 260-264 (ERA s 130 still to be saved to `docs/sources/`). What was asked is kept below.

1. **ERA s 130**: its wording couldn't be read (legislation.govt.nz
   blocks our tools). Please save the section to `docs/sources/` so the
   payslip can be checked against it.
2. **Hours each day** (HA s 81(2)(c)) need timesheets (P9). Until then only
   the period's hours show. OK?
3. **The bank account** shown is the employee's current one (the pay run
   doesn't keep a copy). Should a pay run keep the account it paid into?
4. Should payslips show the **IRD number** or an **employee number**
   (Employment NZ lists both as things a payslip may show)?
5. Should the payslip email's text be editable (a template, like
   invoices)? It's fixed now so pay never ends up in a stored message.

## Payday filing file (examples not yet approved by Jess)

Stage P6 of payroll (#60). Jess hasn't approved these. From an **approved**
pay run Tohyee makes IRD's **employment information (EI) file**, a CSV file
to upload in myIR (myIR › Employment information › file upload), and shows
when it's due. Making the file posts nothing to the ledger and marks
nothing as filed (decision 65).

Sources, law first: IRD's **Payday Filing File Upload Specification
2026-27** ("version 2027", July 2026), its section 3.4 (the EI file, header
record `HEI2` and employee records `DEI`), summarised field by field in
`docs/sources/ird-payday-filing-file-spec.md`, with what couldn't be read
(the appendix: attribute definitions, the tax code table and the IRD number
check). Due dates: spec 3.4 and IRD's
[Payday filing](https://www.ird.govt.nz/employing-staff/payday-filing) page
("within 2 working days of each payday", last updated 24 Feb 2026, read
2 Oct 2026). The design calls are decisions 56-65 in `docs/DECISIONS.md`
(NetSuite has no NZ payroll; Xero files each pay run straight to IRD). The
figures are PRUN1-PRUN3's. **No file here has been through myIR yet**: run
one through myIR's "Check your employment information file" service
(spec 2.5) before approving.

Tests: `tests/unit/payroll-payday-filing.test.ts` (the file byte for byte,
due dates, settings checks) and `tests/integration/payroll-payday-filing.test.ts`
(made from approved pay runs through the API).

The examples use these **payroll settings** (Payroll › Pay items › Payday
filing, admins with payroll access, decision 62): employer IRD number
**123-123-123** (IRD's own example number), payroll contact **Mere Tipene**,
work phone **03 477 1234** (kept as `034771234`), email
**payroll@harbourcafe.co.nz**. Tohyee's version is 0.3.1, so the package
identifier is `Tohyee_Tohyee_v0.3.1`. Employees' IRD numbers: Kiri Tane
87-654-321, Hemi Walker 123-456-789, Sione Fifita 100-200-300, Aroha Ngata
112-233-445, Sina Fifita 100-200-301 (none checked with IRD's modulus 11
rule).

How the file is written (decisions 57-61): one header line then one line
per employee in the pay run's order (last name, first name), fields
separated by commas, each line ending CR LF (including the last). Dates
are `CCYYMMDD`. Amounts and hours are in hundredths with no decimal point
and no padding (2,692.31 → `269231`, 36 hours → `3600`, nil → `0`).
Gross earnings are **taxable** earnings; fields for things Tohyee doesn't
do yet are 0 and the child support code is blank. (Since P12, field 13 has
redundancy and field 14 the lump sum indicator: XP9, XP13.) The file is named
`EI-<pay date>-<pay run>.csv`.

- **PF1 Fortnightly salaries (PRUN1).** PAYRUN-1, Fortnightly salaries,
  period 28 Sep to 11 Oct 2026, pay date Wednesday 14 Oct 2026. File
  `EI-20261014-PAYRUN-1.csv`:

  ```
  HEI2,123123123,20261014,N,N,,Mere Tipene,034771234,payroll@harbourcafe.co.nz,2,469231,0,0,89858,0,0,0,0,0,9423,6603,2820,108704,0,0,0,Tohyee_Tohyee_v0.3.1,0001
  DEI,087654321,Kiri Tane,M,,,20260928,20261011,FT,0,200000,0,0,0,34300,0,0,,0,0,0,0,0,0,0,0,0
  DEI,123456789,Hemi Walker,M,,,20260928,20261011,FT,0,269231,0,0,0,55558,0,0,,0,0,0,9423,6603,2820,0,0,0
  ```

  Header: 2 employee lines; total gross 2,000.00 + 2,692.31 = **4,692.31**;
  PAYE 343.00 + 555.58 = **898.58**; KiwiSaver deductions **94.23**; net
  employer contributions **66.03** (94.23 less ESCT); ESCT **28.20**; total
  amounts deducted 898.58 + 94.23 + 66.03 + 28.20 = **1,087.04** (what
  PAYRUN-1 owes IRD in PPAY12). Pay cycle `FT`; hours 0 because
  both are on a salary (decision 59). Kiri's 8-digit IRD number gets a
  leading 0. Final return N, nil return N, no PAYE intermediary.

- **PF2 Hourly, overtime, allowance, reimbursement and a deduction
  (PRUN2).** PAYRUN-2, Weekly wages, period 5 to 11 Oct 2026, pay date
  14 Oct 2026. Sione's lines: 32 hours ordinary time, 4 hours overtime,
  Tool allowance 25.00, Reimbursement 42.60, Union fees 8.50. File
  `EI-20261014-PAYRUN-2.csv`:

  ```
  HEI2,123123123,20261014,N,N,,Mere Tipene,034771234,payroll@harbourcafe.co.nz,1,88000,0,0,14840,0,0,0,0,0,3520,2555,525,21440,0,0,0,Tohyee_Tohyee_v0.3.1,0001
  DEI,100200300,Sione Fifita,M,,,20261005,20261011,WK,3600,88000,0,0,0,14840,0,0,,0,0,0,3520,2555,525,0,0,0
  ```

  Hours paid **36.00** (32 + 4; the allowance and reimbursement are
  amounts). Gross earnings **880.00**, the taxable earnings: the 42.60
  reimbursement isn't taxable so it's left out (spec field 11), and the
  union fees are an after-tax deduction IRD isn't told about. PAYE 148.40,
  KiwiSaver 35.20, net employer 25.55, ESCT 5.25; total deducted
  148.40 + 35.20 + 25.55 + 5.25 = **214.40**.

- **PF3 Student loan (PRUN3).** PAYRUN-3, Four-weekly, period 14 Sep to
  11 Oct 2026, pay date 14 Oct 2026. File `EI-20261014-PAYRUN-3.csv`:

  ```
  HEI2,123123123,20261014,N,N,,Mere Tipene,034771234,payroll@harbourcafe.co.nz,1,350000,0,0,58972,0,0,19728,0,0,12250,10115,2135,103200,0,0,0,Tohyee_Tohyee_v0.3.1,0001
  DEI,112233445,Aroha Ngata,M SL,,,20260914,20261011,4W,0,350000,0,0,0,58972,0,0,,19728,0,0,12250,10115,2135,0,0,0
  ```

  Tax code `M SL` as stored (the spec's own example writes it that way).
  Student loan **197.28** goes in its own field, not in PAYE. Total
  deducted 589.72 + 197.28 + 122.50 + 101.15 + 21.35 = **1,032.00**.

- **PF4 Three pay runs on one pay date.** PF1, PF2 and PF3 all have pay
  date 14 Oct 2026. Each pay run makes its own file with its own header
  totals; IRD accepts several EIs for one paydate (decision 56). Uploading
  all three files tells IRD about gross earnings of 4,692.31 + 880.00 +
  3,500.00 = **9,072.31** and deductions of 1,087.04 + 214.40 + 1,032.00 =
  **2,333.44** for 14 Oct 2026. Making a file again gives the same bytes
  (unless the payroll settings or an employee's IRD number changed since).

- **PF5 A new employee in the pay period.** Sina Fifita starts on
  **Wednesday 7 Oct 2026** in pay group "Weekly casuals", paid exactly as
  Sione in PF2 (same rate, lines, KiwiSaver and ESCT rate), so the figures
  are PF2's. PAYRUN-4, period 5 to 11 Oct 2026, pay date 14 Oct 2026. Her
  line has the start date in field 5 because it's inside her pay period:

  ```
  DEI,100200301,Sina Fifita,M,20261007,,20261005,20261011,WK,3600,88000,0,0,0,14840,0,0,,0,0,0,3520,2555,525,0,0,0
  ```

  The payday filing card also lists her under "Starting in this pay
  period": IRD wants a new employee's details (address and date of birth
  if given) "on or before a new employee's first payday", and Tohyee
  doesn't make the employee details file (decision 64), so they're entered
  in myIR. Someone who started before the period (Sione) has field 5
  blank.

- **PF6 Due dates.** Due 2 working days after the pay date (Tax
  Administration Act s 23E(2)(b)), working days as the Income Tax Act's s
  YA 1 defines them: not weekends, Waitangi Day, Good Friday, Easter
  Monday, Anzac Day, the Sovereign's birthday, Matariki or Labour Day (nor
  the Monday after Waitangi or Anzac Day on a weekend), nor 25 December to
  15 January (decision 326, replacing decision 63's weekends only):

  | Pay date | Due | Note |
  | --- | --- | --- |
  | Wed 14 Oct 2026 | **Fri 16 Oct 2026** | |
  | Fri 23 Oct 2026 | **Wed 28 Oct 2026** | Mon 26 Oct is Labour Day |
  | Sat 24 Oct 2026 | **Wed 28 Oct 2026** | Tuesday and Wednesday are the 2 working days |
  | Fri 30 Oct 2026 | **Tue 3 Nov 2026** | |
  | Wed 23 Dec 2026 | **Mon 18 Jan 2027** | Thu 24 Dec, then nothing until Mon 18 Jan |
  | Fri 19 Mar 2027 | **Tue 23 Mar 2027** | Otago's anniversary day (Mon 22 Mar) is a working day for tax |
  | Fri 23 Apr 2027 | **Wed 28 Apr 2027** | Anzac Day is a Sunday, so Mon 26 Apr isn't a working day |

  The card says: "Due within 2 working days after the pay date (Tax
  Administration Act s 23E). Working days leave out weekends, the national
  public holidays (not anniversary days) and 25 December to 15 January." A
  year Tohyee has no public holiday dates for (2028 on) counts its movable
  holidays as working days, so the date shown is never later than IRD's.
  Paper filers' 10 working days aren't shown (a file is electronic).

- **PF7 Settings and refused files.** Making a file is refused, with what
  to do, when:
  - the pay run is a **draft** ("PAYRUN-5 is a draft, so it has no
    employment information file. Approve it first.") or **voided**
    ("PAYRUN-1 is voided, so it has no employment information file. If you
    filed it, amend it in myIR.");
  - the **payday filing settings** aren't filled in ("Set up payday
    filing first: an admin enters the employer's IRD number and the
    payroll contact under Payroll › Pay items.").
  Saving the settings refuses: an employer IRD number that isn't 8 or 9
  digits, or is all zeros; a contact name over 20 characters or with a
  comma; a phone that isn't 1 to 12 letters and digits once spaces,
  dashes, brackets and a leading + are dropped (`03 477 1234` →
  `034771234`); an email over 60 characters, without `@` and a domain,
  with two dots in a row, or with characters other than A-Z, a-z, 0-9,
  @, -, _ and . (IRD's list). An 8-digit employer IRD number (`49-091-850`)
  is written `049091850`. A comma in an employee's name becomes a
  space, with spaces collapsed (last name typed "Tane, Jr" → "Kiri Tane
  Jr"), because an approved pay run can't be changed (decision 60).

- **PF8 Access, and nothing posted.** Making the file and reading the
  settings need payroll access and the bookkeeper role (decision 6); Noah
  (bookkeeper, no payroll access) gets "You need payroll access to see
  payroll…" (403), Vic (viewer) 403. Only admins with payroll access change
  the settings. Making a file posts no journal and changes nothing on the
  pay run. It writes one audit event, "payroll_payday_filing.made", with
  the pay run, file name, number of employee lines and the file's SHA-256,
  never an amount or IRD number.

- **PF9 Not built (refused rather than guessed).**
  - The **employee details file** (HED2/DED/TED) for new and departing
    employees (decision 64).
  - **Amendments** to an EI already filed (the spec's EI amendments file,
    3.5): amend in myIR. Voiding a pay run doesn't tell IRD.
  - **Filing straight to IRD** (IRD's gateway services, as Xero does): it
    needs IRD's onboarding as a software provider.
  - Child support, SLCIR/SLBOR, payroll giving, extra pays (lump sum
    indicator), schedular payments, the Employee Share Scheme and prior
    period adjustments: Tohyee doesn't pay these yet (PRUN8), so their
    fields are 0.

### Questions for Jess (payday filing file), decided

Decided on 2 Oct 2026: decisions 265-269 (question 1, a test in myIR, is still for Jess). What was asked is kept below.

1. **Try a file in myIR.** Please run PF1's file (or a real pay run's)
   through myIR's "Check your employment information file" service. It
   checks things the spec's appendix (not read) defines: whether amounts
   in cents without a decimal point, CR LF line endings, a final CR LF,
   macrons in names and 3.5% KiwiSaver deductions are accepted.
2. **Employee details file.** Do you want Tohyee to make it? That needs
   employee addresses split into street, suburb, city and post code, a
   mobile and a daytime phone, and each new employee's KiwiSaver
   eligibility (NE, EE or EA) and status (AE, AK, OK, NK or CT).
3. **One file per pay run** (decision 56), or one file per pay date
   combining pay runs (IRD allows both)?
4. **Employer IRD number** is its own setting. Should it start from the GST
   number when that's set?
5. **Hours paid** for salaried staff are 0 (decision 59). Would you rather
   use their usual hours for the period?

## Timesheets (examples not yet approved by Jess)

Stage P9 of payroll (#60), built by Claude on 2 Oct 2026; Jess hasn't
approved these. A **timesheet** is one employee's hours for one week
(Monday to Sunday), by day, against an **R&D activity**, a **Department**,
a **project**, a combination of those, or "**other work**" (spread by the
employee's default cost allocation). Each entry is stamped by the database
with who entered it and when, and changing it keeps the old entry. Someone
**approves** it; approval locks it, and from then on pay runs approved
afterwards split the employee's pay by its hours for the days it covers
instead of by their default allocation, and the R&D claim takes the
employee's R&D share from it (it's the contemporaneous record IR1240
p 100 asks for). Timesheets show **hours only, never pay**. Decisions
91-101 in [DECISIONS.md](DECISIONS.md) say why each rule is as it is.

Sources (law first):

- **Holidays Act 2003 s 81(2)(c)**: the holiday and leave record must show
  "the number of hours worked each day in a pay period and the pay for
  those hours" (`docs/sources/holidays-act-2003.md`, read 1 Oct 2026).
  Employment NZ's
  [Record-keeping](https://www.employment.govt.nz/starting-employment/rights-and-responsibilities/record-keeping)
  page (last modified 6 Nov 2025, read 2 Oct 2026) says wage and time
  records must show "the days the employee worked and the number of hours
  worked on those days", kept "for 6 years (even if the employee has
  left)", and employees can see their records. The Employment Relations
  Act 2000 s 130 itself couldn't be read (legislation.govt.nz blocks our
  tools), so it's cited through Employment NZ.
- **IR1240 p 100** (April 2026, `docs/sources/ir1240-pages-49-on.md`):
  records "should be kept on a contemporaneous or timely basis"; time
  "regularly estimated and reported … for example on a weekly or
  fortnightly basis"; "If the expenditure on eligible activities is
  apportioned, the basis for apportionment must be reasonable and be
  supported by an audit trail." IR1240 p 64: only the share of pay for
  time on R&D counts.
- **NetSuite** [Approving or Rejecting a Time Transaction](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N907404.html)
  (read 2 Oct 2026): "If no time approver is selected, then the employee's
  supervisor approves time entries"; statuses Open, Pending Approval,
  Approved, Rejected; "Time approvers can't edit or delete existing time
  entries". NetSuite's [Weekly Timesheets](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4671374137.html)
  capture "time entries in a weekly format".
- **Xero** [Payroll timesheets](https://www.xero.com/nz/accounting-software/payroll/timesheet/)
  (read 2 Oct 2026): "Your employees fill in and submit timesheets";
  "Once you've approved your employees' timesheets, this data
  automatically syncs with … payroll … ready for your pay runs."

Tests: `tests/unit/payroll-timesheets.test.ts` (the pure week, weights,
split and lateness rules: TS2, TS3, TS5-TS8) and
`tests/integration/payroll-timesheets.test.ts` (TS1-TS11, against
PostgreSQL and the API routes).

**The example company** is Kea Sensors Ltd from the R&D examples (RD28):
advanced features on, a Department "Operations", R&D activities **C1**
(core) and **S1** (supporting C1), both with a general approval covering
2026-27, and a project **Taieri soil survey** for its customer Taieri
Growers Ltd. Pay group "Fortnightly salaries", period **6-19 Jul 2026**,
pay date **22 Jul 2026**:

| Employee | Pay | Default cost allocation from 1 Apr 2026 |
| --- | --- | --- |
| Hana Rewi | salary 62,400.00 (2,400.00 a fortnight), KiwiSaver employer 3.5% (84.00) | 100% C1 |
| Ben Tait | salary 52,000.00 (2,000.00 a fortnight), not in KiwiSaver | 60% C1, 40% Operations |

Members: **Jess** (owner, payroll access), **Sam** (bookkeeper, no payroll
access), **Ana** (admin, no payroll access), **Ben** (viewer; Ben Tait's
own login) and **Vic** (viewer).

### Setting up, entering and history

- **TS1 Who enters and who approves.** Jess (payroll access) links the
  employee Ben Tait to Ben's login and makes **Sam** Ben's **timesheet
  approver** (Payroll › Timesheets › People). Ben (a viewer) can then open
  and fill in **his own** timesheets, and only his; Sam can open Ben's
  timesheets and approve or reject them, but can't change their hours;
  Jess can open, fill in and approve anyone's. Refused: linking a login
  that's already linked to another employee ("Ben is already linked to
  Hana Rewi"), someone who isn't a member, an approver below bookkeeper
  ("A timesheet approver needs the bookkeeper role or higher"), and Sam
  or Ben making either change (payroll access only, 403). With no approver
  set, the member linked to the employee's **reports-to** manager (P1b)
  approves, as NetSuite's supervisor does; people with payroll access
  always can.
- **TS2 A week.** On Fri **10 Jul 2026** Ben fills in the week starting
  **Mon 6 Jul 2026**, and on Fri **17 Jul** the week starting **Mon 13
  Jul**:

  | Row | Mon | Tue | Wed | Thu | Fri | Week |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: |
  | 6-12 Jul: C1 | 8.00 | 8.00 | 4.00 | | | 20.00 |
  | 6-12 Jul: Department Operations | | | 4.00 | 8.00 | 8.00 | 20.00 |
  | 13-19 Jul: C1 | 8.00 | 8.00 | | | | 16.00 |
  | 13-19 Jul: Department Operations | | | 8.00 | 4.00 | | 12.00 |
  | 13-19 Jul: project Taieri soil survey | | | | 4.00 | 8.00 | 12.00 |

  Each week totals **40.00** hours; the fortnight **80.00** (C1 36.00,
  Operations 32.00, Taieri soil survey 12.00). Every entry stores its
  date, row, hours, who entered it and **when, set by the database** (an
  "enteredAt" in the request is ignored). The 8.00 h for Mon 6 Jul,
  entered 10 Jul, is "entered 4 days after the work". Hours are decimals
  to 2 places (7.5 h is 7.50; 7 h 20 min is entered as 7.33). If Ben is
  linked to a member who records project time (PJ3), "Fill from project
  time" suggests rows from that week's project time (minutes ÷ 60, to 2
  places): suggestions only, saved and stamped like any entry.
- **TS3 Changing an entry keeps the old one; late entries are flagged.**
  On **11 Jul** Ben changes Wed 8 Jul C1 from 4.00 to **3.50** and adds
  **0.50** to Operations. The 4.00 entry isn't changed: it's marked
  "replaced" (by Ben, 11 Jul) and a new 3.50 entry is stamped 11 Jul. The
  timesheet's history shows "C1, Wed 8 Jul: 4.00 h entered 10 Jul 2026 by
  Ben; changed to 3.50 h on 11 Jul 2026 by Ben". Clearing a cell marks its
  entry "removed"; nothing is ever deleted (the database refuses). Had Ben
  entered Mon 13 Jul's 8.00 h on **Wed 5 Aug 2026**, it's "entered **23
  days** after the work" (18 days left in July + 5), more than 14, so it's
  flagged **entered late** (decision 38); it still counts. (The rest of
  these examples use TS2's hours as first entered.)

### Submitting and approving

- **TS4 Submit, approve, reject, reopen.** Ben **submits** the week of 6
  Jul: it can't be changed now (by anyone), and Sam sees it under "To
  approve". Ben can't approve his own ("Someone else approves your
  timesheet."), and neither can Vic or Ana (403: they can't see it). Sam
  **rejects** it with the reason "Wednesday's Operations hours look
  short": it's a draft again, Ben corrects it and submits again. Sam
  **approves** it: its entries are locked (the database refuses new,
  changed or removed entries on a submitted or approved timesheet) and
  pay runs approved from now on use it. Only someone with payroll access
  can **reopen** an approved timesheet (with a reason, back to draft),
  and not once a pay run that isn't voided has used it (TS9). Submitting
  an empty week is refused ("There are no hours to submit."). Every step
  is in the timesheet's history and the audit log, with who and when.
  Approving posts nothing.

### What pay runs do with approved timesheets

When a pay run is **approved**, each employee's costs are split by the
**approved timesheets covering days in the pay period** instead of their
default allocation, for those days only:

- A day is **covered** when it's in the pay period and in the week of a
  timesheet that's approved when the pay run is approved (and the
  timesheet has hours in the period). Of a period of **P** days, **c** are
  covered; **H** is the covered hours, **hₜ** those on each row and **h₀**
  those on "other work".
- Each timesheet row gets the weight **c × hₜ × 100**; each line of the
  default allocation in effect on the pay date gets **((P − c) × H + c ×
  h₀) × its %**. The weights add up to **P × H × 100**. With no covered
  hours (H = 0) the whole pay is split by the allocation, as before.
- Each pay item's amount is split in proportion to the weights with PE3's
  rule: cut to cents, leftover cents to the largest part cut off, the
  earlier share first on a tie. Timesheet rows come first, ordered by R&D
  activity code, then Department, then project; then the allocation's
  lines in their order. Journal lines are still totalled by pay item,
  account and tracking (never by employee), and a row's Department is its
  tracking tag (a row with only an R&D activity or a project has none, as
  an allocation line with only those has none).
- The pay run keeps each employee's shares (source, hours, weight,
  Department, project, R&D activity) with its postings, for people with
  payroll access. **PAYE, KiwiSaver, student loan and ESCT don't change**:
  only where the cost is charged (and, for hourly staff, TS8's hours).

- **TS5 Fully covered.** Both of Ben's weeks are approved before the pay
  run is approved: P = 14, c = 14, H = 80.00. Ben's ordinary time
  **2,000.00** is split C1 2,000.00 × 36 / 80 = **900.00**, Operations
  2,000.00 × 32 / 80 = **800.00**, Taieri soil survey 2,000.00 × 12 / 80
  = **300.00**; his 60/40 allocation isn't used. Journal debits for Ben:
  6200 "Ordinary time" (no tag) **900.00**, 6200 "Ordinary time"
  Operations **800.00**, 6200 "Ordinary time (project Taieri soil survey)"
  (no tag) **300.00** (in the pay run's journal, Ben's untagged 900.00 and
  Hana's untagged ordinary time 2,400.00 are one line of **3,300.00**, since
  lines are totalled by pay item, account and tracking). Ben's shares: C1
  36.00 h (45.0000%), Operations
  32.00 h (40.0000%), Taieri soil survey 12.00 h (15.0000%), all from the
  timesheet. **R&D:** C1 gets 2,000.00 × 36 / 80 = **900.00**, counted as
  employee related costs (a timesheet is a time record, so decision 34's
  100% rule doesn't apply); before timesheets the report listed 1,200.00
  as "default split, no time record" and counted nothing (RD29).
- **TS6 Partly covered.** Only the week of 6 Jul is approved when the pay
  run is approved (the week of 13 Jul is still submitted). P = 14, c = 7,
  H = 40.00 (C1 20.00, Operations 20.00), h₀ = 0. Weights: timesheet C1 7
  × 20 × 100 = **14,000**, timesheet Operations **14,000**, allocation C1
  (7 × 40 + 0) × 60 = **16,800**, allocation Operations (7 × 40) × 40 =
  **11,200**; total 14 × 40 × 100 = 56,000. Ordinary time 2,000.00:
  timesheet C1 **500.00**, timesheet Operations **500.00**, allocation C1
  **600.00**, allocation Operations **400.00**. Journal for Ben: 6200
  "Ordinary time" (no tag) **1,100.00** (500.00 + 600.00, same account and
  tracking; with Hana's 2,400.00 the journal line is **3,500.00**),
  Operations **900.00**. **R&D:** C1 500.00 from the timesheet
  counts; C1 600.00 from the 60% allocation is listed as "default split,
  no time record" and left out (decision 34 for the days with no time
  record).
- **TS7 Cents and rounding (RD5 on P3's figures).** Hana's approved
  timesheets for the fortnight have **80.00** h: **C1 48.00**, **S1 4.00**,
  **Operations 28.00**. Her ordinary time 2,400.00 splits 1,440.00 /
  120.00 / 840.00 and employer KiwiSaver 84.00 splits 50.40 / 4.20 /
  29.40, cost **2,484.00**. R&D (each share rounded down, decision 50): C1
  2,484.00 × 48 / 80 = **1,490.40**, S1 2,484.00 × 4 / 80 = **124.20**,
  not R&D 869.40; both count although her allocation is 100% C1 (the
  timesheet is used instead). Had the fortnight been **77.00** h (C1 48,
  S1 4, Operations 25):
  - journal split of 2,400.00: exact 1,496.1038…, 124.6753…, 779.2207…;
    cut to 1,496.10 + 124.67 + 779.22 = 2,399.99; the cent goes to S1
    (0.0053 cut off, the largest): **1,496.10, 124.68, 779.22**;
  - of 84.00: exact 52.3636…, 4.3636…, 27.2727…; cut to 52.36 + 4.36 +
    27.27 = 83.99; C1 and S1 tie (0.0036…), so the earlier, C1, gets the
    cent: **52.37, 4.36, 27.27**;
  - R&D, rounded down from the cost 2,484.00: C1 2,484.00 × 48 / 77 =
    1,548.4675… → **1,548.46**, S1 2,484.00 × 4 / 77 = 129.0389… →
    **129.03**, not R&D **806.51**. (The journal's C1 total is 1,496.10 +
    52.37 = 1,548.47; R&D uses the rounded-down share so it's never
    overstated, as in RD30.)
- **TS8 Hourly pay from timesheets.** Sione Fifita is paid weekly in pay
  group "Weekly wages", **22.50** an hour, 32 ordinary hours a week, tax
  code M, not in KiwiSaver, allocation 100% Operations. His approved
  timesheet for the week of 6 Jul has **36.50** h: Operations 7.50 a day
  Mon-Thu (30.00) and C1 **6.50** on Fri. A draft pay run for **6-12 Jul
  2026** (pay date 15 Jul) made **after** that approval gives him Ordinary
  time **36.50 × 22.50 = 821.25**, described "From approved timesheets",
  instead of 32 × 22.50 = 720.00; PAYE and the rest are calculated on
  821.25 as P3 always does. Approving splits the 821.25 Operations
  821.25 × 30 / 36.5 = **675.00**, C1 821.25 × 6.5 / 36.5 = **146.25**;
  R&D counts **146.25** to C1. Only an hourly employee whose **every day**
  of the period is covered gets their hours from timesheets, and only
  Ordinary time (hours over 32 aren't made overtime: that depends on the
  employment agreement); a period not fully covered (the week of 13 Jul,
  not approved) gets 32 × 22.50 = **720.00** as in PRUN11. Hours are taken
  when the draft is made; a timesheet approved later still changes the
  split when the pay run is approved but not the hours (edit the draft's
  hours, or delete and start it again). Salaried pay never changes.

### Locks, late approval and access

- **TS9 Locks and timesheets approved after the pay run.** In TS6 the pay
  run (PAYRUN-1) used the week of 6 Jul. Reopening that timesheet is then
  refused ("PAYRUN-1 used this timesheet, so it can't be reopened. Void
  PAYRUN-1 first."), and the database refuses it too; after PAYRUN-1 is
  voided it can be reopened. The week of 13 Jul, approved **after**
  PAYRUN-1, isn't used by it: the posted pay keeps its split (decision
  37), and the claim report says "Ben Tait: the timesheet for the week of
  Monday 13 Jul 2026 was approved after PAYRUN-1, so its 16.00 R&D hours
  aren't used (decision 37)." (people without payroll access see "1
  timesheet was approved after its pay run, so its R&D hours aren't used
  (decision 37)." with no name). That timesheet can
  still be reopened, since no pay run used it. A pay run approved later
  for the next period uses whichever of its days fall in that period.
  Reallocating a posted pay to a late timesheet (RD22) isn't built.
- **TS10 Access and privacy.** Timesheet screens and APIs show hours,
  rows, who and when, never pay rates or amounts; the split in money is
  only on the pay run (payroll access). Ben sees only his own; Sam only
  those he approves; Jess everyone's; Vic and Ana nobody's (403, "You can
  only see your own timesheets, the ones you approve, or everyone's with
  payroll access."). Who did each step comes from the signed-in user,
  never the request. Audit events record the employee, the week and the
  step, not hours.
- **TS11 Refused.** Each of these is refused and nothing is saved: hours
  of 0, 24.01, 7.333 or "abc"; a day whose rows total more than 24.00; a
  date outside the timesheet's week; a day before Ben's start date or
  after his finish date; a week that doesn't start on a Monday; an
  archived R&D activity, a closed project, a value that isn't a
  Department; two rows with the same R&D activity, Department and
  project; a timesheet for an archived employee; a second timesheet for
  the same employee and week (the first is returned); changing a
  submitted or approved timesheet; approving one that isn't submitted;
  saving over a newer version ("Ben's timesheet was changed by someone
  else. Reload it."). Leave on timesheets (P8) and overtime from
  timesheets are refused rather than guessed.

### Not supported yet (refused rather than guessed)

- **Leave** on timesheets (annual, sick, public holidays): stage P8. Until
  then a week of leave is a week with fewer hours (or none), and TS6's
  rule spreads the uncovered days by the allocation.
- **Overtime from timesheets**: hours over the ordinary hours aren't
  turned into overtime (it depends on the agreement); add overtime on the
  pay run.
- **Reallocating a posted pay** to a timesheet approved after it (RD22's
  "reallocation with history"): listed in the claim report, not built.
- Copying approved project hours into **project time** (to invoice them):
  "Fill from project time" goes the other way only.
- A start/stop timer, mobile clock-in, and timesheets for people who aren't
  employees (contractors).

- **TS12 Another first day of the week** (decision 192). A new
  organisation sets its timesheet weeks to start on **Sunday** (Payroll ›
  Pay items › Weeks; admins). Its first timesheet for an employee is the
  week **Sun 4 Oct to Sat 10 Oct 2026**; a timesheet starting Mon 5 Oct is
  refused ("A timesheet week starts on a Sunday."), and opening the week of
  Wed 7 Oct shows the week starting Sun 4 Oct. Once it has a timesheet,
  changing the first day is refused ("Timesheets already start on a
  Sunday, so the first day of the week can't change"). Kea Sensors (TS1-TS9)
  keeps Monday, the default.

### Questions for Jess (timesheets), decided

Decided on 2 Oct 2026 by law → NetSuite → Xero, as Jess asked: decisions 192-198 in `docs/DECISIONS.md` (1: the first day of the week is a setting, TS12; 2-7: kept as built, each with its reason). What was asked is kept below.

1. **Week start.** Timesheets run Monday to Sunday (decision 92). Do any
   clients need another day, or timesheets per pay period as Xero does?
2. **Viewers fill in their own timesheets** (decision 95), so staff who
   only enter time can be viewers. OK, or do you want a "time only" role
   (the projects question too)?
3. **Approvers can't change hours** (NetSuite; decision 96); they reject
   with a reason. Xero lets the approver correct and approve. Which?
4. **Part-covered pay periods** are split by calendar days covered (TS6).
   Would working days be better for monthly salaries?
5. **Hourly pay from timesheets** only when every day of the period is
   covered, Ordinary time only (TS8). Should hours over the ordinary hours
   become overtime, and should a timesheet approved after the draft update
   the draft's hours?
6. **Project hours**: should approved project hours also become project
   time entries (to invoice them and show them in profitability)?
7. **A late timesheet after the pay was posted** (TS9, RD22): build the
   reallocation of the posted pay's R&D share, or keep listing it?

## Payroll reports (examples not yet approved by Jess)

Stage P10 of payroll (#60), built by Claude on 2 Oct 2026; Jess hasn't
approved these. **Payroll › Reports** has six reports, all read-only (they
post nothing and change nothing), all for people with **payroll access**
(and the bookkeeper role or higher): labour cost, the payroll summary, the
reconciliation to the ledger, headcount and FTE, each employee's earnings
history, and the PAYE, KiwiSaver and student loan summary. Every figure
comes from **approved pay runs' stored figures** (what approving kept:
each employee's totals, lines and postings) and the **shares each pay run
used** to split its costs (the default allocation, P3, or approved
timesheets, P9); nothing is recalculated from today's rates, allocations
or timesheets. Dates are **pay dates** (decision 102). Each report can be
exported as CSV; an export is recorded in the audit log without any
figures (decision 109). Decisions 102-111 in [DECISIONS.md](DECISIONS.md)
say why each rule is as it is.

Sources: there's no law on payroll reports beyond keeping the records
(Holidays Act s 81, the wage and time record, the payday filing rules);
IRD's rules decide the PAYE, KiwiSaver and student loan figures (decision
58, PF1-PF4) and IRD periods by pay date (PPAY4). Then **NetSuite**: "The
Payroll Summary report displays the sum of paycheck amounts for each
payroll item within the specified date range. The items are grouped by
payroll item type."
([Payroll Summary Report](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N962618.html));
the Payroll Summary by Employee report "lists amounts for earnings,
employee-paid taxes, other deductions, company contributions, and does the
gross-to-net calculation" and "can group employees by department or roll up
payroll activity for each department into a single line"
([Payroll Summary by Employee](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N962835.html));
the Payroll Liability report shows "your total unpaid liability for each
payroll item" and "does not include previously paid liability"
([Payroll Liability Report](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N960606.html));
the Payroll Journal report "lists the journal entries made for each
paycheck"
([Payroll Journal Report](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N962405.html));
all read 2 Oct 2026. NetSuite has no headcount or FTE report in that list
([Payroll Reports and Workbooks](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_N959965.html)).
**Xero** Payroll NZ has a "Payroll Activity Summary" and a "Payroll
Employee Summary" report, but Xero Central's pages
([Payroll Activity Summary report](https://central.xero.com/0/article/Payroll-Activity-Summary-report))
load with script and couldn't be read by our tools on 2 Oct 2026, so
nothing here rests on what they say (**unverified**).

Tests: `tests/unit/payroll-reports.test.ts` (the pure rules: FTE, months,
grouping and CSV) and `tests/integration/payroll-reports.test.ts`
(PREP1-PREP8, against PostgreSQL and the API routes).

**The example company** is Harbour Cafe Ltd from the pay run examples:
advanced features on, Departments **Sales** and **Operations**, the project
**Cafe rebrand**, the "Tool allowance" pay item (PRUN10), payday filing set
up as in PF1, paying IRD monthly, bank account **1000**. Allocations: Hemi
Walker 60% Sales, 40% Operations; Kiri Tane 100% Sales; Sione Fifita 100%
Operations on Cafe rebrand; Aroha Ngata 100% Sales. In **October 2026**:

| Pay run | Pay group | Pay date | What it is | Status |
| --- | --- | --- | --- | --- |
| PAYRUN-1 | Fortnightly salaries | 14 Oct 2026 | PRUN1 (Hemi and Kiri) | approved, its EI file made on 14 Oct (PF1), then **voided on 20 Oct 2026** (PRUN6) |
| PAYRUN-2 | Weekly wages | 14 Oct 2026 | PRUN2 (Sione) | approved, EI file made |
| PAYRUN-3 | Four-weekly | 14 Oct 2026 | PRUN3 (Aroha) | approved, EI file made |
| PAYRUN-4 | Fortnightly salaries | 14 Oct 2026 | PRUN1 run again after the void: the same figures | approved 20 Oct, **no EI file made yet** |

Wages paid (P4): **WAGES-1** PAYRUN-2's 730.50 on 14 Oct, **WAGES-2**
PAYRUN-3's 2,590.50 on 14 Oct, **WAGES-3** PAYRUN-4's 3,699.50 on 21 Oct.
IRD paid for October on **20 Nov 2026** (**IRD-1**, 2,333.44: PAYE
1,636.70, student loan 197.28, KiwiSaver 444.66, ESCT 54.80). One manual
journal, **ACCRUAL-OCT** on 31 Oct 2026: Dr 6200 Wages and salaries 500.00,
Cr 2240 Wages payable 500.00 ("Wages accrued 26-31 Oct").

### Labour cost

Labour cost is what approved pay runs **charged** (their postings: each
employee's share of each debit line of the pay run's journal), for
earnings and the employer KiwiSaver contribution (gross, ESCT included, as
posted), **not reimbursements**, which are shown on their own line
(decision 103). Grouped by Department, project, R&D activity, pay item or
employee, with a column for each pay item, and filtered by any of
Department, project, R&D activity, employee and pay item together. The
Department, project and R&D activity are those of the share each posting
came from (decision 104).

- **PREP1 Labour cost by Department, October 2026.** 1-31 Oct 2026, by
  Department. PAYRUN-1 is voided, so it's left out (PAYRUN-4 has the same
  figures); the screen lists it under "Voided pay runs, not counted".

  | Department | Ordinary time | Overtime | Tool allowance | KiwiSaver employer contribution | Labour cost |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Operations | 1,796.92 | 135.00 | 25.00 | 68.49 | **2,025.41** |
  | Sales | 7,115.39 | | | 179.04 | **7,294.43** |
  | **Total** | **8,912.31** | **135.00** | **25.00** | **247.53** | **9,319.84** |

  Sales: ordinary time Hemi 1,615.39 (60%) + Kiri 2,000.00 + Aroha
  3,500.00 = 7,115.39; employer KiwiSaver Hemi 56.54 + Aroha 122.50 =
  179.04. Operations: Hemi 1,076.92 (40%) + Sione 720.00 = 1,796.92;
  Sione's overtime 135.00 and tool allowance 25.00; employer KiwiSaver Hemi
  37.69 + Sione 30.80 = 68.49. **Reimbursements (not labour cost): 42.60**
  (Sione's fuel, Operations). Labour cost plus reimbursements, 9,362.44, is
  the three pay runs' employer cost (4,786.54 + 953.40 + 3,622.50) and
  their journals' debits.
  - **By project**: Cafe rebrand **910.80** (720.00 + 135.00 + 25.00 +
    30.80), No project **8,409.04**; total 9,319.84.
  - **By pay item**: Ordinary time 8,912.31, Overtime 135.00, Tool
    allowance 25.00, KiwiSaver employer contribution 247.53.
  - **By employee**: Aroha Ngata 3,622.50, Hemi Walker 2,786.54, Kiri Tane
    2,000.00, Sione Fifita 910.80.
  - **Filters together**: Department Operations and pay item Ordinary time
    gives **1,796.92**; employee Hemi Walker by Department gives Operations
    **1,114.61** (1,076.92 + 37.69), Sales **1,671.93** (1,615.39 +
    56.54), total 2,786.54; Department Sales and project Cafe rebrand gives
    nothing ("No labour cost matches").
  - Groups are in name order with "No Department" (or "No project", "No
    R&D activity") last; pay item columns are in the pay items' order and
    only those with an amount are shown.

- **PREP2 Labour cost by R&D activity, from timesheet shares (TS5).** Kea
  Sensors Ltd (the timesheet examples): pay run for 6-19 Jul 2026, pay date
  22 Jul 2026, with both of Ben Tait's weeks approved first (TS5). Hana
  Rewi's pay was split by her allocation (100% C1); Ben's by his
  timesheets, not his 60/40 allocation. 1-31 Jul 2026, by R&D activity:

  | R&D activity | Ordinary time | KiwiSaver employer contribution | Labour cost |
  | --- | ---: | ---: | ---: |
  | C1 Prototype and field-test a low-power soil-moisture sensor | 3,300.00 | 84.00 | **3,384.00** |
  | No R&D activity | 1,100.00 | | **1,100.00** |
  | **Total** | **4,400.00** | **84.00** | **4,484.00** |

  C1 is Hana's 2,400.00 + 84.00 and Ben's 900.00 (36 of his 80 timesheet
  hours); "No R&D activity" is Ben's Operations 800.00 and Taieri soil
  survey 300.00. By Department: Operations **800.00**, No Department
  **3,684.00**. By project: Taieri soil survey **300.00**, No project
  **4,184.00**. Filtered to C1 and Ben Tait: **900.00**. Had Ben's
  timesheets been approved after the pay run (TS9), the report would still
  show what was posted (his allocation's 1,200.00 to C1): it reads the
  shares the pay run kept, never today's timesheets or allocation. These
  are what was charged, not the R&D claim: the claim (Tax › R&D claim
  report) rounds each R&D share down and applies decision 34's 100% rule
  (TS5-TS7).

  Pay runs approved before timesheets (P9) kept no shares: their
  Department is the posting's Department tag and their project the
  posting's project, and their R&D activity shows as "Not recorded (pay
  run approved before timesheets)" (decision 104).

### Payroll summary

- **PREP3 Payroll summary, October 2026.** Each approved pay run paid
  1-31 Oct 2026 with its stored totals, gross to net and the employer's
  costs, then the totals, then the totals by pay item:

  | | PAYRUN-2 | PAYRUN-3 | PAYRUN-4 | **Total** |
  | --- | ---: | ---: | ---: | ---: |
  | Pay group | Weekly wages | Four-weekly | Fortnightly salaries | |
  | Employees | 1 | 1 | 2 | 4 |
  | Gross | 922.60 | 3,500.00 | 4,692.31 | **9,114.91** |
  | of which taxable | 880.00 | 3,500.00 | 4,692.31 | **9,072.31** |
  | of which not taxable | 42.60 | 0.00 | 0.00 | **42.60** |
  | PAYE (incl. ACC earners' levy) | 148.40 | 589.72 | 898.58 | **1,636.70** |
  | Student loan | 0.00 | 197.28 | 0.00 | **197.28** |
  | KiwiSaver employee | 35.20 | 122.50 | 94.23 | **251.93** |
  | Other deductions | 8.50 | 0.00 | 0.00 | **8.50** |
  | **Net pay** | 730.50 | 2,590.50 | 3,699.50 | **7,020.50** |
  | KiwiSaver employer (gross) | 30.80 | 122.50 | 94.23 | **247.53** |
  | ESCT | 5.25 | 21.35 | 28.20 | **54.80** |
  | KiwiSaver employer, net of ESCT | 25.55 | 101.15 | 66.03 | **192.73** |
  | **Employer cost** | 953.40 | 3,622.50 | 4,786.54 | **9,362.44** |

  Gross less PAYE, student loan, KiwiSaver and deductions is net pay
  (9,114.91 − 1,636.70 − 197.28 − 251.93 − 8.50 = 7,020.50); employer
  cost is gross plus the employer KiwiSaver contribution (9,114.91 +
  247.53). By pay item: Ordinary time **8,912.31** (32.00 hours, Sione's;
  salaries are amounts), Overtime **135.00** (4.00 hours), Tool allowance
  **25.00**, Reimbursement **42.60**, Union fees (deduction) **8.50**,
  KiwiSaver employer contribution **247.53**. "Voided pay runs, not
  counted": PAYRUN-1, pay date 14 Oct 2026, voided 20 Oct 2026. With the
  employee filter Sione Fifita, only his figures (PAYRUN-2's column) are
  counted. The other filters (Department, project, R&D activity) don't
  apply: PAYE and net pay aren't split by Department (decision 105).

### Reconciliation to the ledger

- **PREP4 Payroll against the ledger, October 2026.** For each payroll
  account (each pay item's account, the accounts approved pay runs
  posted to, and the PAYE, student loan, KiwiSaver, ESCT and wages
  payable accounts), the **payroll figure** for 1-31 Oct 2026 against the
  account's **ledger movement** in the same dates, the difference, and
  every journal that explains it (decision 106). Expense accounts are
  debits less credits; liability accounts credits less debits. The payroll
  figure is: for expense accounts, the postings of approved pay runs paid
  in the dates; for IRD liabilities, what those pay runs credited less IRD
  payments dated in the dates; for wages payable, their net pay less wage
  payments dated in the dates; for deduction accounts, the deductions.

  | Account | Payroll | Ledger | Difference | Explained by |
  | --- | ---: | ---: | ---: | --- |
  | 6070 General expenses | 42.60 | 42.60 | 0.00 | |
  | 6200 Wages and salaries | 9,072.31 | 9,572.31 | **500.00** | PAYRUN-1 (voided pay run) 4,692.31; VOID-PAYRUN-1 (voided pay run) −4,692.31; Manual journal ACCRUAL-OCT 500.00 |
  | 6210 KiwiSaver employer contributions | 247.53 | 247.53 | 0.00 | PAYRUN-1 94.23; VOID-PAYRUN-1 −94.23 |
  | 2200 PAYE payable | 1,636.70 | 1,636.70 | 0.00 | PAYRUN-1 898.58; VOID-PAYRUN-1 −898.58 |
  | 2210 KiwiSaver payable | 444.66 | 444.66 | 0.00 | PAYRUN-1 160.26; VOID-PAYRUN-1 −160.26 |
  | 2220 ESCT payable | 54.80 | 54.80 | 0.00 | PAYRUN-1 28.20; VOID-PAYRUN-1 −28.20 |
  | 2230 Student loan payable | 197.28 | 197.28 | 0.00 | |
  | 2240 Wages payable | 0.00 | 500.00 | **500.00** | PAYRUN-1 3,699.50; VOID-PAYRUN-1 −3,699.50; Manual journal ACCRUAL-OCT 500.00 |
  | 2250 Payroll deductions payable | 8.50 | 8.50 | 0.00 | |

  Wages payable's payroll figure is net pay 7,020.50 less WAGES-1, WAGES-2
  and WAGES-3 (7,020.50) = 0.00. KiwiSaver payable's 444.66 is the
  employees' 251.93 plus the employer's 192.73 net. **Not explained: 0.00
  on every account.** The journals from the counted pay runs (PAYRUN-2,
  -3, -4) and payments (WAGES-1 to -3) aren't listed: they are the payroll
  figure. A journal on a payroll account from anything else is listed with
  its date, reference, where it came from and its amount on that account:
  a voided pay run or payment (both its journals, which cancel when both
  fall in the dates), a manual journal, or another document (a bill coded
  to 6070, say, which shows that 6070 is also used outside payroll). If a
  difference isn't covered by those journals (for example a deduction pay
  item whose account was changed after pay runs used the old one), the
  rest is shown as **not explained**, with that reason as a hint.
  For **1 Oct to 30 Nov 2026**, IRD-1 (20 Nov) counts too: PAYE's payroll
  figure is 1,636.70 − 1,636.70 = 0.00 and so is its ledger movement, and
  likewise student loan, KiwiSaver and ESCT.

### Headcount and FTE

FTE is an employee's usual weekly hours ÷ the **standard week** (40.00
hours unless another is entered on the report), to 4 decimal places,
rounded half up, at most 1.0000. Employees on a salary have no usual hours
in Tohyee, so they count as **1.0000, marked "assumed (salary)"**
(decision 107). Who's employed on a date is from their start and finish
dates; their usual hours from the pay rate in effect on that date (PE7);
their Department from the allocation in effect on that date: FTE is split
by its percentages, and headcount goes to the Department with the biggest
share (the first line if two are equal), as on the employee list.

- **PREP5 Headcount and FTE.** Sione Fifita's finish date is set to **15
  Nov 2026**, and **Tama Rangi** (hourly, **20.00** hours a week, 100%
  Operations, Weekly wages) starts on **2 Nov 2026**.

  **At 14 Oct 2026** (standard week 40.00):

  | Employee | Pay | Usual hours | FTE | Department |
  | --- | --- | ---: | ---: | --- |
  | Aroha Ngata | salary | | 1.0000 (assumed) | Sales |
  | Hemi Walker | salary | | 1.0000 (assumed) | Sales 60%, Operations 40% |
  | Kiri Tane | salary | | 1.0000 (assumed) | Sales |
  | Sione Fifita | hourly | 32.00 | 0.8000 | Operations |
  | **Total** | | | **3.8000**, headcount **4** | |

  By Department: Sales headcount **3**, FTE **2.6000** (Hemi 0.6000 +
  Kiri 1.0000 + Aroha 1.0000); Operations headcount **1**, FTE **1.2000**
  (Hemi 0.4000 + Sione 0.8000). With a standard week of **37.50**, Sione is
  32 ÷ 37.5 = 0.85333… → **0.8533** and the total **3.8533**. Someone on
  45.00 hours counts **1.0000**.

  **By month, October to November 2026** (each month's figures at its last
  day):

  | Month | Headcount | FTE | Started | Finished | Paid in the month |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Oct 2026 | 4 | 3.8000 | 0 | 0 | 4 |
  | Nov 2026 | 4 | 3.5000 | 1 (Tama Rangi) | 1 (Sione Fifita) | 0 |

  November: Hemi, Kiri and Aroha 1.0000 each and Tama 20 ÷ 40 = 0.5000;
  Sione finished on 15 Nov. "Paid in the month" counts the employees on
  approved pay runs paid in it (none in November here). An archived
  employee with no finish date is still counted and is flagged "archived
  but no finish date" so it can be fixed.

### Employee earnings history

- **PREP6 Earnings history, October 2026.** For each employee (or one,
  with the employee filter), each approved pay run paid in the dates: pay
  date, pay run, period, each pay item line as stored (hours × rate or an
  amount), then gross, taxable, PAYE, student loan, KiwiSaver, deductions,
  net pay, employer KiwiSaver, ESCT and employer cost, and the employee's
  totals. Names are as kept on each pay run. **Sione Fifita**:

  | Pay date | Pay run | Period | Pay item | Hours | Rate | Amount |
  | --- | --- | --- | --- | ---: | ---: | ---: |
  | 14 Oct 2026 | PAYRUN-2 | 5-11 Oct 2026 | Ordinary time | 32.00 | 22.50 | 720.00 |
  | | | | Overtime | 4.00 | 33.75 | 135.00 |
  | | | | Tool allowance | | | 25.00 |
  | | | | Reimbursement (Fuel receipt) | | | 42.60 |
  | | | | Union fees (deduction) | | | 8.50 |

  Gross 922.60, taxable 880.00, PAYE 148.40, student loan 0.00, KiwiSaver
  35.20, deductions 8.50, **net pay 730.50**, employer KiwiSaver 30.80,
  ESCT 5.25, **employer cost 953.40**. **Hemi Walker**: PAYRUN-4 only
  (14 Oct 2026, Ordinary time 2,692.31; gross 2,692.31, PAYE 555.58,
  KiwiSaver 94.23, net pay 2,042.50, employer KiwiSaver 94.23, ESCT 28.20,
  employer cost 2,786.54); PAYRUN-1 is listed as voided, not counted. With
  the pay item filter Overtime, only Sione's overtime line is shown and his
  totals are unchanged (they're the pay run's stored totals).

### PAYE, KiwiSaver and student loan

- **PREP7 By month, tied to the payday filing files and IRD payments.**
  For each month (by pay date), what approved pay runs deducted and owe IRD,
  which is what each pay run's employment information file says (decision
  58: the same stored figures), and what was paid to IRD for the IRD
  periods in that month (decision 108). October 2026, paying IRD monthly:

  | | Deducted (EI files) | Paid to IRD (IRD-1, 20 Nov) | Owing |
  | --- | ---: | ---: | ---: |
  | Taxable gross earnings | 9,072.31 | | |
  | PAYE (incl. ACC earners' levy) | 1,636.70 | 1,636.70 | 0.00 |
  | Student loan | 197.28 | 197.28 | 0.00 |
  | KiwiSaver employee deductions | 251.93 | | |
  | KiwiSaver employer, net of ESCT | 192.73 | | |
  | KiwiSaver together | 444.66 | 444.66 | 0.00 |
  | ESCT | 54.80 | 54.80 | 0.00 |
  | **Total deducted** | **2,333.44** | **2,333.44** | **0.00** |

  2,333.44 is PF4's total for 14 Oct 2026 and PPAY4's shape. IRD pays
  KiwiSaver as one liability, so it's compared together. The month lists
  each pay run's file: PAYRUN-2 and PAYRUN-3 "file made", **PAYRUN-4 "no
  employment information file made in Tohyee"**, and **PAYRUN-1 "voided
  after its file was made: amend the employment information in myIR"**
  (from the audit log's "payroll_payday_filing.made" events; Tohyee
  doesn't know what was uploaded, decision 65). Before IRD-1, October owes
  2,333.44 and the due date 20 Nov 2026 is shown. November 2026 has nothing
  deducted or paid. For a twice-monthly payer, a month's paid figure is the
  IRD payments for both of its halves.

### Access, exports and refusals

- **PREP8 Access, exports and what's refused.** Every report and export
  needs the bookkeeper role and payroll access: Noah (bookkeeper, no
  payroll access) and Vic (viewer) get "You need payroll access to see
  payroll…" (403); Mere (admin with payroll access) can. People without
  payroll access see payroll only in the ledger, as totals by pay item,
  account and Department (decision 6). Exporting a report gives a CSV file
  (`payroll-labour-cost-2026-10-01-to-2026-10-31.csv` for PREP1; one row
  per line shown, amounts as plain numbers) and records one audit event,
  "payroll_report.exported", with the report, the dates, the filters'
  record ids, the number of rows and the file's SHA-256, **never an amount
  or a name**. Running or exporting a report posts nothing. Refused with a
  reason: a start date after the end date ("The start date must be on or
  before the end date."); a range over 5 years ("Choose 5 years or less.");
  a standard week of 0, over 168 hours or with more than 2 decimals; an
  unknown report, Department, project, R&D activity, employee or pay item.

### Not built yet (refused rather than guessed)

- **Leave reports** (balances, liability by Department): stage P8.
- **Budgets for wages** (workforce budgets): stage P11.
- Reports **by pay period** (accruing pay to the period it was earned in)
  rather than by pay date.
- **Hours** by Department or activity from timesheets on the labour cost
  report (the timesheets screen has them).
- A view of department totals for people without payroll access beyond
  the profit and loss (decision 105).
- Recording that an employment information file was **uploaded** or
  accepted by IRD (decision 65).

- **PREP9 Saved standard week and salaried usual hours** (decisions 199,
  200). From PREP5's people at 14 Oct 2026: Kiri Tane (salary) gets leave
  settings with a fixed usual week of 7.5 hours Monday to Thursday,
  **30.00** hours; she now counts 30 ÷ 40 = **0.7500**, not assumed, and the
  total is 3.8000 − 1.0000 + 0.7500 = **3.5500**. An admin saves a
  standard week of **37.50** (Payroll › Pay items › Weeks); the report with
  no week typed then uses it: Kiri 30 ÷ 37.5 = **0.8000**, Sione 32 ÷ 37.5
  = **0.8533**, Aroha and Hemi 1.0000 assumed, total **3.6533**. A week typed
  on the report (40) is still used for that report.

### Questions for Jess (payroll reports), decided

Decided on 2 Oct 2026: decisions 199-205 (1: the standard week is saved per organisation; 2: usual hours come from the usual week, PREP9; 3-7: kept as built). What was asked is kept below.

1. **Standard week.** FTE uses 40.00 hours a week unless another is typed
   on the report. Should each organisation save its own (and could it
   differ by pay group)?
2. **Salaried staff's hours.** Salaried employees count as 1.0000 FTE
   ("assumed") because Tohyee doesn't record their usual hours. Add usual
   hours to salaried employees' pay rates so part-time salaries count
   properly?
3. **FTE over 1.** Someone on 45 hours counts 1.0000, not 1.1250. OK?
4. **Reimbursements** are left out of labour cost (shown on their own
   line). Agreed?
5. **Pay date or pay period?** Every report is by pay date (as IRD and the
   ledger are). Do you want labour cost by the period worked as well?
6. **Pay runs approved before timesheets** show "R&D activity not
   recorded" here; the R&D claim works their R&D share out from the
   allocation they used (decision 67). Should labour cost do the same?
7. **Exports** record who exported what and when, without figures. Should
   exports also need a second permission?

## Workforce budgets (examples not yet approved by Jess)

Stage P11 of payroll (#60), built by Claude on 2 Oct 2026; Jess hasn't
approved these. **Payroll › Workforce budget** budgets wages by **employee**
or by **position** (a job not filled yet, NetSuite/Oracle's "to be hired")
and month, and **feeds** the wages and employer KiwiSaver amounts, split by
Department, into the existing budgets (BU1-BU8). Workforce budgets post
nothing. Decisions 112-123 in [DECISIONS.md](DECISIONS.md) say why each rule
is as it is.

Sources: NetSuite Planning and Budgeting says "Planning and Budgeting
currently supports only the Financials module. A Workforce module is not
currently available"
([NetSuite Planning and Budgeting](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_8124016549.html),
read 2 Oct 2026), so these follow Oracle's own Planning Workforce module,
which NetSuite Planning and Budgeting is built on: a hiring requisition
has a "Number of requisitions", an "FTE value for each", a "Start Date and
optionally the End Date to set when the requisition's expenses are to be
included in expense calculations", the job, "Salary Basis and Rate" and a
"Merit Month"
([Adding Hiring Requisitions](https://docs.oracle.com/en/cloud/saas/planning-budgeting-cloud/epbug/wf_adding_hiring_requisitions_100x94fdd820.html));
and "the data maps push data to the correct accounts" from Workforce to
Financials, mapped by entity
([Customizing the Mapping for Integration between Workforce and Financials](https://docs.oracle.com/en/cloud/saas/planning-budgeting-cloud/epbca/wf_fin_integration.html)),
both read 2 Oct 2026. **Xero**'s budget manager has no workforce or
headcount budgeting that we know of; Xero Central couldn't be read by our
tools (**unverified**).

Tests: `tests/unit/payroll-workforce-budget.test.ts` (the monthly maths,
WB1 and WB2's splits) and `tests/integration/payroll-workforce-budgets.test.ts`
(WB1-WB7 against PostgreSQL and the API routes).

**The rules**

- A workforce budget has a name, a first month and 1 to 24 months, and
  lines. A line is **an employee** or **a position** (a name such as
  "Barista (to be hired)"), from a start month to an optional end month,
  both whole months inside the workforce budget's months (decision 114).
- Pay: **salary** (annual salary × FTE, FTE more than 0 and at most 1, 4
  decimals) or **hourly** (hourly rate × hours a week × 52 ÷ 12), with
  **pay rises from a month** (the new annual salary or hourly rate from that
  month on; decision 116). An employee line starts with the employee's pay
  rate in effect on its first month's 1st day (their first rate if they
  haven't started), and their employer KiwiSaver rate if enrolled (0
  otherwise); after that the line is what's typed.
- **Employer KiwiSaver** = the month's wages × the line's employer rate,
  **truncated** to the cent as pay runs do (decision 118). **ESCT is not
  extra cost**: it's deducted from the employer contribution and paid to IRD
  for the employee, so the contribution (gross, ESCT included) is the whole
  cost, as pay runs post it (decision 103).
- **Rounding** (decision 115): each line's wages for a month are worked
  out exactly and **rounded once, half up, to the cent**; KiwiSaver is
  then worked out from that rounded figure. Each of the two is then split
  by the line's percentages with `splitByPercentages` (PE3: parts cut to
  cents, the cents left over to the largest remainders), and every total
  adds those split parts, so Departments always add up to the whole.
- **Split** (decision 117): an employee line by the employee's **cost
  allocation in effect on the 1st of each month** (PE6), all of it (Class,
  Location and project as well as Department); with no allocation yet, all
  to "No Department". A position line by its **own split**: lines of a %
  with a Department and optionally a project, totalling 100.00%.
- **Accounts** (decision 119): wages to the **Ordinary time** pay item's
  account (6200 Wages and salaries in the starting chart) and employer
  KiwiSaver to the **KiwiSaver employer contribution** pay item's account
  (6210).
- **Feeding budgets** (decisions 113, 120, 121): a workforce budget feeds
  the budgets chosen on it; a budget is fed by at most one workforce
  budget. A budget for a Department, Class or Location value gets only the
  split parts tagged with that value or one under it; a budget with no
  tracking value gets everything. In each fed budget the workforce budget
  **owns** the wages and KiwiSaver accounts for every one of its months
  (zero included): those amounts are written by the workforce budget, marked
  "From workforce budget <name>" on the budget, and can't be typed or quick
  filled (the database refuses too). They're rewritten every time the
  workforce budget is saved and when someone with payroll access presses
  **Update budgets** (allocations change on their own, so the screen says
  when the fed amounts differ from today's figures). Each rewrite is in the
  budget's history like any other change. Taking a budget off the list
  leaves its amounts as they are, as ordinary typed amounts.
- **Access** (decision 122): workforce budgets (per-employee lines, rates
  and figures) need payroll access and the bookkeeper role. What they feed
  is ordinary budget amounts by account, month and tracking value, which
  anyone who can see budgets sees (decision 6: Department totals are fine).
  The workforce budget's own audit events have no amounts and no names.
- **Budget vs actual for wages** (decision 123): per month and Department,
  the workforce budget's wages plus KiwiSaver against P10's **labour cost**
  (PREP1: approved pay runs' earnings and employer KiwiSaver, not
  reimbursements, by **pay date**), variance actual less budget.

**The example company** is Harbour Cafe Ltd (the pay run and payroll report
examples): advanced features on, Departments **Sales** and **Operations**,
the project **Cafe rebrand**. Employees: **Hemi Walker**, salary 70,000.00,
KiwiSaver enrolled at 3.5% employer, allocation 60% Sales / 40% Operations;
**Kiri Tane**, salary 52,000.00, not in KiwiSaver, 100% Sales; **Sione
Fifita**, hourly 22.50 for 32 hours a week, KiwiSaver 3.5% employer, 100%
Operations on Cafe rebrand. Budgets: **Overall budget**, **Sales plan**
(Department: Sales) and **Operations plan** (Department: Operations).

- **WB1 Lines and monthly figures.** Workforce budget **"Wages Oct 2026 -
  Mar 2027"**, 6 months from Oct 2026, feeding all three budgets:

  | Line | Pay | Months | Wages a month | Employer KiwiSaver a month |
  | --- | --- | --- | ---: | ---: |
  | Hemi Walker | salary 70,000.00, FTE 1; rise to 73,500.00 from Jan 2027 | Oct-Mar | Oct-Dec **5,833.33**; Jan-Mar **6,125.00** | Oct-Dec **204.16**; Jan-Mar **214.37** |
  | Kiri Tane | salary 52,000.00, FTE 1 | Oct-Mar | **4,333.33** | 0.00 (not in KiwiSaver) |
  | Sione Fifita | hourly 22.50 × 32 hours | Oct-Mar | **3,120.00** | **109.20** |
  | Barista (to be hired), position | hourly 24.00 × 25 hours, 3.5%, 50% Sales / 50% Operations | Jan-Mar | **2,600.00** | **91.00** |

  70,000.00 ÷ 12 = 5,833.333… → 5,833.33 (half up); 5,833.33 × 3.5% =
  204.16655 → **204.16** (truncated). 73,500.00 ÷ 12 = 6,125.00; × 3.5% =
  214.375 → **214.37**. 52,000.00 ÷ 12 = 4,333.33. 22.50 × 32 × 52 ÷ 12 =
  3,120.00; × 3.5% = 109.20. 24.00 × 25 × 52 ÷ 12 = 2,600.00; × 3.5% =
  91.00. Adding Hemi's line fills in salary 70,000.00 and 3.5% from his
  records. Totals: wages Oct-Dec **13,286.66** a month, Jan-Mar
  **16,178.33** a month, six months **88,394.97**; employer KiwiSaver
  Oct-Dec **313.36**, Jan-Mar **414.57**, six months **2,183.79**.
  Nothing is posted (no journals).

- **WB2 Split by Department and fed into the budgets.** Hemi's 5,833.33 by
  60/40: 3,499.998 and 2,333.332 cut to 3,499.99 and 2,333.33, the cent
  left goes to Sales (larger remainder): **3,500.00 / 2,333.33**. His
  204.16: 122.496 / 81.664 → **122.50 / 81.66**. January: 6,125.00 →
  **3,675.00 / 2,450.00**; 214.37: 128.622 / 85.748 → **128.62 / 85.75**.
  The Barista's 2,600.00 → 1,300.00 / 1,300.00 and 91.00 → 45.50 / 45.50.

  | Budget | Account | Oct, Nov, Dec 2026 (each) | Jan, Feb, Mar 2027 (each) |
  | --- | --- | ---: | ---: |
  | Sales plan | 6200 Wages and salaries | **7,833.33** (3,500.00 + 4,333.33) | **9,308.33** (3,675.00 + 4,333.33 + 1,300.00) |
  | Sales plan | 6210 KiwiSaver employer | **122.50** | **174.12** (128.62 + 45.50) |
  | Operations plan | 6200 | **5,453.33** (2,333.33 + 3,120.00) | **6,870.00** (2,450.00 + 3,120.00 + 1,300.00) |
  | Operations plan | 6210 | **190.86** (81.66 + 109.20) | **240.45** (85.75 + 109.20 + 45.50) |
  | Overall budget | 6200 | **13,286.66** | **16,178.33** |
  | Overall budget | 6210 | **313.36** | **414.57** |

  The Overall budget had 6200 Oct 2026 typed as **10,000.00** before; it
  becomes 13,286.66 and its history shows 10,000.00 → 13,286.66. Each of
  those cells shows "From workforce budget Wages Oct 2026 - Mar 2027" and
  is read-only. Typing 6200 Oct 2026 on Sales plan, or quick filling 6210
  for 12 months from Oct 2026, is refused ("comes from the workforce
  budget"), and the database refuses changing a fed amount outside the
  workforce budget. 6200 Sep 2026 and Apr 2027 (outside its months) and
  6150 Rent in any month can still be typed.

- **WB3 Changes rewrite the fed amounts.** The Barista's start moves to
  Feb 2027 and the workforce budget is saved: January becomes Overall
  6200 **13,578.33**, 6210 **323.57**; Sales plan 6200 **8,008.33**, 6210
  **128.62**; Operations plan 6200 **5,570.00**, 6210 **194.95**
  (February and March unchanged). Then Kiri gets a new allocation, 100%
  Operations from 1 Feb 2027: the screen says the fed budgets are **out of
  date** (today's figures differ) without changing them; **Update
  budgets** moves Kiri's 4,333.33 for Feb and Mar from Sales plan to
  Operations plan: Sales plan 6200 Feb **4,975.00** (3,675.00 + 1,300.00),
  Operations plan 6200 Feb **11,203.33** (2,450.00 + 3,120.00 + 1,300.00
  + 4,333.33); the Overall budget doesn't change. After that it says
  they're up to date.

- **WB4 Taking a budget off.** Operations plan is taken off the list: its
  6200 and 6210 amounts stay as they were (Oct **5,453.33**) and can be
  typed again; the others keep being fed. Refused: adding a budget that
  another workforce budget feeds, an archived budget, and a budget for a
  custom segment value (payroll doesn't tag custom segments).

- **WB5 Budget vs actual for wages, October 2026.** One approved pay run
  for Hemi and Kiri, fortnightly, pay date 14 Oct 2026 (PRUN1's figures:
  Hemi 2,692.31 wages and 94.23 KiwiSaver split 60/40, Kiri 2,000.00):

  | Department | Budget (wages + KiwiSaver) | Actual (labour cost, PREP1) | Variance |
  | --- | ---: | ---: | ---: |
  | Operations | 5,644.19 (5,453.33 + 190.86) | 1,114.61 | **-4,529.58** |
  | Sales | 7,955.83 (7,833.33 + 122.50) | 3,671.93 (1,671.93 + 2,000.00) | **-4,283.90** |
  | **Total** | **13,600.02** | **4,786.54** | **-8,813.48** |

  November 2026 shows the same budget with actual 0.00. Labour cost counts
  every earnings pay item (overtime and allowances too), so a variance can
  come from pay the workforce budget doesn't plan.

- **WB6 Access.** Ben (bookkeeper, payroll access) can do all of WB1-WB5.
  Noah (bookkeeper, no payroll access) and Ana (admin, no payroll access)
  get 403 from every workforce budget call and don't see the screen's
  figures; Noah and Vic (viewer) see Sales plan's 6200 Oct **7,833.33**
  marked "From workforce budget" on the budget and in budget vs actual,
  with no names. The audit events `payroll_workforce_budget.*` have no
  amounts and no names; the budgets' own `budget.amounts_changed` events
  have the account totals as for any budget change.

- **WB7 Refused, with nothing saved.** A line ending before it starts or
  outside the workforce budget's months; a pay rise in a month outside the
  line or not after its start month; a salary FTE of 0 or 1.5; an hourly
  line without hours; a KiwiSaver rate over 100; a position's split not
  totalling 100.00%; the same employee twice; an archived employee; more
  than 24 months; a save against an older version (someone else changed
  it); a budget fed by another workforce budget.

### Not supported yet (refused rather than guessed)

- Part months (a start or finish on the 15th counts the whole month), more
  than one person per position line, overtime, allowances, holiday pay, ACC
  levies and other on-costs, and any employer KiwiSaver minimum rate after
  the rates Tohyee holds (2026-27): the rate is what's typed on the line.

### Questions for Jess (workforce budgets), decided

Decided on 2 Oct 2026: decisions 206-211 (all kept as built for now; on-costs need their own examples). What was asked is kept below.

1. **Part months**: should a line starting on 15 Jan count half of
   January (by days), rather than the whole month?
2. **Pay rate changes**: an employee line keeps the pay it started with
   plus the rises typed on it. Should a later pay rate on the employee's
   record (P1b) flow into the workforce budget automatically?
3. **KiwiSaver 4%**: the employer minimum is legislated to go up on
   1 Apr 2028, but Tohyee only holds IRD's rates to 2026-27, so the rate on
   each line is what's used. Add a planned rate change, or type it as a
   rise?
4. **On-costs**: budget holiday pay accrual, ACC levies or overtime too?
5. **Positions**: one line per person, or a "number of people" as Oracle's
   requisitions have?
6. **Actuals by pay date**: compare by month of pay date (as P10), or by
   the period worked?

## Extra pays, back pay and final pays (examples not yet approved by Jess)

Stage P12 of payroll (#60), built by Claude on 2 Oct 2026; Jess hasn't
approved these. Bonuses and other lump sums, back pay and the extra pays on
an employee's last pay are taxed under IRD's **extra pay** rules instead of
the ordinary PAYE calculation, and reported in the pay they're paid in.
Decisions 124-137 in [DECISIONS.md](DECISIONS.md) say why each rule is as
it is. Holiday pay owed on finishing was **not calculated** until leave
(P8) was built (XP12); since P8 (2 Oct 2026) Tohyee works it out for
employees whose leave it keeps (HL15, HL16; decision 150), and it stays
typed, as XP12 shows, only for employees whose leave it doesn't keep.

Sources, law first (all read 2 Oct 2026 through Claude's web fetch tool,
which returns IRD's PDFs through a summarising model, so wording below is
ours and each figure was asked for separately; check the PDFs before
approving):

- IRD's **Payroll Calculations & Business Rules Specification 2026-27**
  ("the spec", the edition in `src/lib/payroll/rates/2026-27.ts`), section
  **5.11 Extra pay (lump sum)** (5.11.1 primary income, 5.11.2 secondary
  income, 5.11.3 lowest rate flag, from page 43) and **5.12 Taxation when
  employment ends**; section **4.5.1** for what counts for KiwiSaver
  ("bonuses, commissions, gratuities, overtime payments, and any other
  remuneration"; not "Redundancy payments").
  - 5.11.1 step 2 (student loan): "Calculate pay for pay period, including
    normal pay and extra pay. Include lump sum payments which are paid as
    annual or special bonuses, retiring or redundancy payments, gratuities
    or back pay. Exclude non-taxable amounts", then the usual threshold,
    truncating to whole dollars and the deduction to cents.
  - Step 3.1: "the value of the PAYE income payments made in the four weeks
    prior to, and inclusive of the day on which the extra pay is paid",
    not including "any other amounts of extra pay"; four weekly pays, two
    fortnightly pays or one four-weekly pay × 13, one monthly pay × 12,
    "other circumstances" all payments in the four weeks × 13. Step 3.2:
    "Drop cents from the grossed-up amount". Steps 3.3-3.11: the rate from
    the grossed-up amount: up to $15,600 10.5%; $15,601-$53,500 17.5%;
    $53,501-$78,100 30%; $78,101-$180,000 33%; over $180,000 39% (the
    income tax brackets). The extra pay × the rate, "Do not round".
  - Step 4 (ACC earners' levy, 1.75%, maximum liable earnings $156,641):
    4.1 redundancy, retirement allowance or ESS: $0.00; 4.2 grossed-up
    amount not over $156,641: extra pay × 1.75%; 4.3 annualised income
    not over $156,641 and grossed-up over it: ($156,641 − annualised) ×
    1.75%; 4.4 annualised over $156,641: $0.00.
  - Step 5: "5.1 Add ACC Earners' Levy and tax deducted. Do not round this
    figure. 5.2 Truncate amount to whole cents."
  - 5.11.2: the same with the code's **low threshold amount** added to the
    annualised income: SB $0, S $15,601, SH $53,501, ST $78,101,
    SA $180,001.
  - 5.11.3: if "the lowest rate of tax was used in the calculation of the
    tax on an extra pay amount", enter "1" on the electronic return (the
    employment information file's field 14, `docs/sources/ird-payday-filing-file-spec.md`).
  - 5.12: "if the extra pay includes an amount that arises from the ending
    of the employee's employment", the tax is on the extra pay plus "the
    annualised value of the PAYE income payments for the last 2 pay periods
    before the PAYE income payment for the extra pay", the "two most recent
    paid pay periods", payments made out of cycle not included: weekly
    × 26, fortnightly × 13, four-weekly × 6.5, monthly × 6; then the same
    rate, levy and truncation steps.
- IRD's **Employer's guide IR335** (September 2026, pages 37-42): extra
  pays include "annual bonuses, special bonuses, retiring payments,
  redundancy payments, back pay, holiday pay paid in addition to the
  regular pay for the pay period, exit inducement payments, gratuities,
  payments for accepting restrictive covenants, employee share scheme
  benefits"; "Overtime or any regular payments are not lump sum payments";
  "Unless the lump sum payment is for redundancy, deduct and pay employee
  KiwiSaver deductions, net employer contributions and ESCT as usual"; and
  an employee "may ask you to tax their lump sum payment at a higher rate".
- IRD's pages
  [Lump sum payments](https://www.ird.govt.nz/employing-staff/payday-filing/non-standard-filing-of-employment-information/lump-sum-payments)
  (last updated 27 Jan 2026: back pay, including backpaid holiday pay, is
  a lump sum, reported in the period it's paid),
  [Calculate PAYE for a lump sum payment](https://www.ird.govt.nz/employing-staff/payday-filing/non-standard-filing-of-employment-information/lump-sum-payments/calculate-paye-for-a-lump-sum-payment)
  (18 May 2026: "CAE/EDW: use the lump sum method"; "NSW, ND and
  tailored tax codes: use the usual rate") and
  [... at end of employment](https://www.ird.govt.nz/employing-staff/payday-filing/non-standard-filing-of-employment-information/lump-sum-payments/calculate-paye-for-a-lump-sum-payment-end-of-employment)
  (20 Apr 2026: "you must calculate other lump sum payments together with
  the lump sum paid when an employee ends employment").
- NetSuite has no New Zealand payroll, so it has no answer here. Xero
  Payroll NZ's help pages load by script and couldn't be read
  (**unverified**).

Tests: `tests/unit/payroll-extra-pays.test.ts` (IRD's examples, XP1-XP7,
and the pure per-employee calculation) and
`tests/integration/payroll-extra-pays.test.ts` (XP8-XP14, against
PostgreSQL and the API routes).

### Pay items (set-up)

Admins with payroll access add these kinds under Payroll › Pay items, each
with its own account (decision 125):

| Kind | Taxed as | PAYE | ACC levy | Student loan | KiwiSaver, ESCT | Where |
| --- | --- | --- | --- | --- | --- | --- |
| Extra pay (bonus, gratuity, lump sum) | Extra pay (5.11) | Yes | Yes | Yes | Yes | Any pay that isn't a final pay with a termination item |
| Back pay | Extra pay (5.11) | Yes | Yes | Yes | Yes | Typed, or worked out from pay rate history (XP10) |
| Holiday pay on finishing (worked out outside Tohyee) | End of employment (5.12) | Yes | Yes | Yes | Yes | Only on a final pay (XP12) |
| Redundancy | End of employment (5.12) | Yes | No (step 4.1) | Yes (step 2) | No (4.5.1) | Only on a final pay (XP13) |

A regular bonus or commission (paid every pay) isn't an extra pay (IR335):
it's an allowance.

### IRD's own examples (pure calculation)

The calculation's input is the extra pay, the part of it liable for the
ACC levy, the annualised income (before the low threshold) and the tax
code; its output is the tax on the extra pay (levy included), the rate and
whether the lowest rate was used. All on pay dates in 2026-27.

- **XP1 Bonus, levy partly over the maximum (spec 5.11.1 example 1).**
  Tax code M. Last four weeks $10,000.00, bonus $30,000.56. Annualised
  $10,000.00 × 13 = $130,000.00; grossed-up $160,000.56 → $160,000 → 33%.
  Tax $30,000.56 × 33% = $9,900.1848. Levy: annualised $130,000 is under
  $156,641 and grossed-up over it, so ($156,641 − $130,000) × 1.75% =
  $466.2175. **Total $10,366.40** (step 5: $10,366.4023 truncated once).
  **Conflict found:** IRD's printed example truncates each part and adds
  them, "$9,900.18" + "$466.21" "= $10,366.39", one cent less than its own
  steps 5.1-5.2. Tohyee follows the steps (decision 127); question 1.
- **XP2 Bonus at 39%, no levy (example 2).** Last four weeks $15,000.00,
  bonus $15,000.00: annualised $195,000 is over $156,641, so no levy;
  grossed-up $210,000 → 39%. **Total $5,850.00.**
- **XP3 Signing bonus with no pay before it (example 3).** No PAYE income
  payments in the four weeks: annualised $0; bonus $10,000.00 →
  grossed-up $10,000 → 10.5% = $1,050.00; levy $10,000 × 1.75% =
  $175.00. **Total $1,225.00**, net $8,775.00, **lowest rate used**
  (EI field 14 = 1, XP9).
- **XP4 Secondary code SH (5.11.2 example 1).** Last four weeks $500.00,
  bonus $1,000.00. $500 × 13 = $6,500 + SH's low threshold $53,501 =
  $60,001; grossed-up $61,001 → 30% = $300.00; levy $17.50 (grossed-up
  under $156,641). **Total $317.50.**
- **XP5 Secondary code ST, levy partly over the maximum (5.11.2
  example 2).** Two fortnightly pays $2,300 + $2,395 = $4,695 × 13 =
  $61,035 + $78,101 = $139,136; bonus $40,000.00; grossed-up $179,136 →
  33% = $13,200.00; levy ($156,641 − $139,136) = $17,505 × 1.75% =
  $306.3375. **Total $13,506.33** (the spec prints $13,506.33; the two
  ways of truncating agree here).
- **XP6 End of employment (5.12 examples and IR335 page 40).**
  - Connor, weekly, redundancy $1,000.00, last two paid weeks $550 and
    $650: ($1,200) × 26 = $31,200; grossed-up $32,200 → 17.5% = $175.00;
    redundancy has no levy. **Total $175.00.**
  - Kelvin, weekly, $2,000.00 on leaving; the weeks ended 5 May $600 and
    12 May $500 are his two most recent *paid* periods (19 May was unpaid
    leave, $0, and 26 May is the final pay itself): $1,100 × 26 =
    $28,600; grossed-up $30,600 → 17.5% = $350.00 + levy $35.00.
    **Total $385.00.**
  - Tama (IR335), weekly, $400.00 on leaving, last two pays $1,000 +
    $1,000 × 26 = $52,000; grossed-up $52,400 → 17.5% + 1.75% =
    **$77.00.**
- **XP7 The rest of the pay (IR335 pages 40 and 42, and the codes).**
  - Heidi (IR335 page 40): last four weeks $6,150 × 13 = $79,950 + bonus
    $1,000 = $80,950 → 33% + 1.75%: **$347.50.**
  - Rama (IR335 page 42), fortnightly, M SL: pay $1,700.00 + taxable
    allowance $100.00 + lump sum $10,100.00. **Student loan on the pay for
    the period, extra pay included**: $11,900 − $928 = $10,972 × 12% =
    **$1,316.64**. (IR335 doesn't print Rama's tax; with his two
    fortnights at $1,800.00 the extra pay's tax is $3,600 × 13 = $46,800
    + $10,100 = $56,900 → 30% = $3,030.00 + levy $176.75 = $3,206.75, and
    the ordinary PAYE on $1,800.00 is $304.50, so PAYE is $3,511.25.)
  - **ND**: the usual flat rate, not the extra pay method (IRD's lump sum
    page): a $1,000.00 bonus at 45% + 1.75% = **$467.50**, lowest rate
    not flagged. **NSW** likewise at 10.5% + 1.75%.
  - **ME** is primary income (5.11.1 step 1 names ME SL) and gets no
    independent earner tax credit on the extra pay: Heidi on ME also pays
    $347.50.

### Extra pays and back pay in a pay run

Weekly wages, periods Monday to Sunday, paid the Wednesday after: week 1
5-11 Oct 2026 paid 14 Oct, week 2 12-18 Oct paid 21 Oct, week 3 19-25 Oct
paid 28 Oct, week 4 26 Oct-1 Nov paid 4 Nov. Weeks 1-3 are approved
before week 4 is made. Accounts: every pay item to 6200 Wages and salaries.
Mere (admin, payroll access) adds "Bonus" (Extra pay), "Back pay" (Back
pay), "Holiday pay on finishing" and "Redundancy".

- **XP8 A bonus in a normal pay (Heidi).** Heidi is salaried at $79,950
  a year ($1,537.50 a week), tax code M, KiwiSaver 3.5% / 3.5%, ESCT 30%.
  Weeks 1-3: $1,537.50 each, PAYE $339.61. Week 4: ordinary time
  $1,537.50 and a Bonus line $1,000.00. The four weeks to and including
  4 Nov hold four weekly pays (14, 21 and 28 Oct and this one): $6,150.00
  × 13 = $79,950.00 (the bonus isn't in it).
  | | Amount |
  | --- | --- |
  | Gross | $2,537.50 |
  | PAYE: ordinary pay $339.61 + extra pay $347.50 (33%) | $687.11 |
  | KiwiSaver employee, 3.5% of $2,537.50 | $88.81 |
  | Net pay | $1,761.58 |
  | KiwiSaver employer $88.81, ESCT ($88 × 30%) $26.40, net $62.41 | |
  The pay run shows "Extra pay $1,000.00 taxed at 33% (IRD's extra pay
  rules, four weeks' pay annualised: $79,950.00)". The journal debits
  Ordinary time and Bonus on separate lines (6200), as any pay item; P10's
  labour cost and payroll summary show Bonus as its own pay item.
- **XP9 Signing bonus in a first pay (Sam).** Sam starts 26 Oct, hourly.
  Week 4's draft has his ordinary time; Ben replaces it with one Bonus line
  $10,000.00 ("Signing bonus"). No PAYE income payments in the four weeks
  (his pay run has no ordinary pay): PAYE $1,225.00 (XP3), net
  $8,775.00. **EI file: field 14 (lump sum indicator) is 1** for Sam and 0
  for everyone else; his gross earnings include the bonus.
- **XP10 Back pay from a pay rate change (Rāwiri).** Rāwiri is hourly,
  $30.00 for 40 hours, tax code M. Weeks 1-3 paid $1,200.00 each (PAYE
  $231.39). After week 3 is approved, his new rate of $32.00 from 12 Oct
  (week 2) is added under Employees. Week 4's draft pays $32.00 × 40 =
  $1,280.00. **Add back pay** (pay item Back pay, the $32.00 rate):
  Tohyee finds the approved pay periods the rate covers that were paid at
  less (weeks 2 and 3, not week 1), and adds a line for each:
  - "Back pay for PAYRUN-2 (12 Oct to 18 Oct 2026): 40.00 h at $32.00
    instead of $30.00" $80.00;
  - the same for PAYRUN-3 (19-25 Oct) $80.00.
  Back pay is an extra pay (IR335), so: four weeks $1,200 × 3 + $1,280 =
  $4,880 × 13 = $63,440 + $160 = $63,600 → 30%: $48.00 + levy $2.80 =
  $50.80. PAYE $256.79 + $50.80 = **$307.59**; net **$1,132.41**.
  Adding back pay again on the same draft, or on a later draft once week 4
  is approved, is refused ("Not supported yet (refused rather than
  guessed): a second back pay for PAYRUN-2: Rāwiri Backpay already has back
  pay for it on PAYRUN-4."). Editing the employee's other lines keeps the back pay lines;
  "Remove back pay" takes them off. Back pay is worked out for **Ordinary
  time** (hours × the new rate, or the new salary for the period) and
  **Overtime paid at the old rate × its multiplier**; allowances aren't
  changed by a pay rate.
- **XP11 What back pay refuses.** "Not supported yet (refused rather than
  guessed)": a pay period with **holiday pay** in it (holiday pay on back
  pay needs leave, P8); a rate that starts **part-way through** a paid
  period; a rate **lower** than what was paid; a **change of basis**
  (hourly to salary); overtime at a typed rate; a period that already had
  back pay. A rate that starts on or after this draft's period owes no back
  pay ("No back pay is owed for that pay rate").

### Final pays

- **XP12 Holiday pay on finishing, worked out outside Tohyee (Tama).**
  Tama is hourly, $25.00 for 40 hours, tax code M; his finish date is
  1 Nov (week 4's last day). Drafts now include people finishing in the
  period (P3 refused them). Weeks 1-3: $1,000.00 each. Week 4: ordinary
  time $1,000.00 and "Holiday pay on finishing" $400.00, typed. The screen
  and payslip say **"Final pay: employment finishes on 1 Nov 2026.
  Tohyee doesn't keep Tama Finishing's leave, so holiday pay owed on
  finishing isn't calculated by Tohyee; work it out outside Tohyee and add
  it as Holiday pay on finishing."** (Changed 2 Oct 2026 by P8: the note
  said Tohyee didn't calculate it "until leave (P8) is built". Tama has no
  usual week in Tohyee, so his leave isn't kept; decision 150.) Because the extra pay arises from his employment ending,
  the end-of-employment rule applies: his last two paid periods before
  this one (weeks 2 and 3) $2,000 × 26 = $52,000 + $400 → 19.25%:
  **$77.00** (XP6). PAYE $171.50 + $77.00 = $248.50; net $1,151.50.
  **EI file: field 6 (finish date) is 20261101.** Tohyee doesn't stop the
  pay run being approved without holiday pay (that would need a typed
  "handled" tick, which Tohyee doesn't add, decision 135).
- **XP13 Redundancy (Connor).** Connor is hourly, $25.00, KiwiSaver
  3.5% / 3.5%, ESCT 17.5%; weeks 1-3 paid 22, 22 and 26 hours ($550,
  $550, $650). He finishes on Wednesday 28 Oct, so week 4's draft gives
  him **0 hours** with "Final pay: enter the hours worked to 28 Oct 2026"
  (a salaried employee finishing before the period ends is refused, as a
  part period). Ben enters 10 hours ($250.00) and Redundancy $1,000.00.
  Last two paid periods: $550 + $650 (XP6) → $175.00, no levy.
  | | Amount |
  | --- | --- |
  | Gross | $1,250.00 |
  | PAYE: ordinary $30.62 + extra pay $175.00 (17.5%) | $205.62 |
  | KiwiSaver employee, 3.5% of $250.00 (not the redundancy) | $8.75 |
  | Net pay | $1,035.63 |
  | KiwiSaver employer $8.75, ESCT $1.40, net $7.35 | |
  EI field 6 is 20261028. Redundancy isn't an R&D employee cost
  (IR1240's list has no redundancy), unlike Bonus, Back pay and Holiday
  pay on finishing.
- **XP14 Kelvin's unpaid week.** Kelvin, hourly $25.00: week 1 24 hours
  ($600), week 2 20 hours ($500), week 3 his ordinary time is set to
  $0.00 (unpaid leave); final pay week 4 (finishing 1 Nov) 22 hours
  ($550.00) and Holiday pay on finishing $2,000.00. The last two **paid**
  periods are weeks 2 and 1: $1,100 × 26 = $28,600 → $385.00 (XP6). PAYE
  $84.87 + $385.00 = $469.87.
- **XP15 Other circumstances** (decision 213; spec 2026-27 5.11.1 step
  3.1: "In other circumstances, add all PAYE income payments made to the
  employee in the four weeks prior and multiply by 13"). Nia New, hourly
  $25.00, weekly, tax code M, starts Mon 19 Oct 2026: week 1 (19-25 Oct)
  40 hours, $1,000.00; week 2 (26 Oct-1 Nov, paid Wed 4 Nov) 40 hours,
  $1,000.00 and a Bonus of $500.00. The four weeks to 4 Nov hold two weekly
  pays, not four, so it's "other circumstances": ($1,000.00 + $1,000.00) ×
  13 = **$26,000.00**; plus the bonus, $26,500, taxed at 17.5% plus the ACC
  earners' levy 1.75%: $500.00 × 19.25% = **$96.25**. With only **one** pay
  period paid (a first week's pay with a bonus) it's still refused: note 4
  says that pay "is the amount to be annualised" but not how.

### Not supported yet (refused rather than guessed)

Each is refused with "Not supported yet (refused rather than guessed)" and
what it is; on a draft it's that employee's problem, so the pay run can't
be approved until it's fixed:

- an extra pay when only one pay period was paid in the four weeks
  (weekly or fortnightly; note 4 doesn't say how it's annualised), or
  pays of another frequency (two or more pays of the right frequency
  that aren't the usual pattern are "other circumstances", XP15);
- an end-of-employment extra pay with fewer than two paid periods before
  the final pay, or one of them at another frequency;
- an extra pay or back pay on a final pay without holiday pay on finishing
  or redundancy (whether it "arises from the ending" decides the method);
  holiday pay on finishing or redundancy on a pay that isn't the
  employee's final pay;
- extra pays for CAE and EDW codes (IRD says use the lump sum method but
  not with which threshold), STC (already refused), redundancy for ND and
  NSW (their flat rate includes the levy);
- redundancy with other extra pays when the ACC levy's maximum falls inside
  them (which part uses the room under the maximum isn't said);
- a higher rate the employee asks for (IR335 allows it; not built);
- a separate pay run just for an extra pay (one pay run per pay group and
  period, decision 124), and anything paid after the final pay;
- holiday pay on back pay (still refused after P8, decision 152); back pay
  cases in XP11. (Calculating holiday pay owed on finishing came in P8.)

### Questions for Jess (extra pays, back pay and final pays), decided

Decided on 2 Oct 2026: decisions 212-219 (IRD's steps kept; short windows, bonuses on final pays without a termination item and elected rates stay refused until IRD's guidance is read; separate extra-pay pay runs wanted, a later stage). What was asked is kept below.

1. **One cent in IRD's example (XP1).** IRD's steps add the tax and the
   levy and truncate once ($10,366.40); its printed example truncates each
   ($10,366.39). Tohyee follows the steps. Ask IRD, or follow the example?
2. **Short four-week windows.** A weekly employee with only two pays in
   the four weeks is refused. Should Tohyee use IRD's "other
   circumstances" rule (all payments × 13), or annualise the pays it has?
3. **Extra pays on a final pay** without a termination item are refused.
   Is a bonus paid in someone's last pay usually "arising from the ending"
   (end-of-employment rule), or should the person running pay choose?
4. **Holiday pay on finishing** is typed and labelled "worked out outside
   Tohyee" until P8. Is that enough, or should final pays wait for P8?
   (Since P8 Tohyee works it out where it keeps the leave; typed only
   where it doesn't, decision 150.)
5. **Back pay for holiday pay periods** is refused until P8. Would you
   rather it paid back pay on the ordinary time and flagged the holiday
   pay? (Still refused after P8, decision 152; the leave question was
   decided on 2 Oct 2026, decision 171: refused, because the law doesn't
   say whether a backdated rise changes holiday pay already paid. Paying
   only the ordinary time would leave that unanswered, so it stays
   refused too.)
6. **Hourly leavers start at 0 hours** when they finish before the period
   ends (starters still get the full period's hours, as P3 did). Agreed?
7. **Separate extra-pay pay runs** (a bonus paid on a different day) aren't
   possible. Needed?
8. **A higher rate on request** (IR335): add a per-employee elected rate?

## Holidays Act leave (examples not yet approved by Jess)

**What gets built.** Tohyee builds this for the **Holidays Act 2003** as one
dated rule-set that ends at each employee's first pay period starting on or
after **6 Aug 2028**, when the **Employment Leave Act 2026** takes over, and
stores **hours on every leave entry** (as well as days or weeks, the rate
used and its inputs) so balances can move to the new law. The new law can't
be followed early
([MBIE, Holidays Act reform: Employment Leave Act](https://www.mbie.govt.nz/business-and-employment/employment-and-skills/employment-legislation-reviews/holidays-act-reform-employment-leave-act)).
The questions these examples raised were decided on 1 Oct 2026: see
"Decided (Holidays Act leave)" at the end of this section and
`docs/DECISIONS.md`, decisions 7-29.

Stage P7 of NZ payroll (#60) planned these; **stage P8 built them on 2 Oct
2026** (branch `claude/payroll-p8-leave`, tenant migration 0070), because
Jess said to go ahead and build leave on these examples and decisions 7-29
before approving them. They are still **not approved by Jess**. Design
calls the examples and decisions 7-29 didn't settle are decisions 138-167
in `docs/DECISIONS.md`. The questions building raised were decided on 2
Oct 2026 (decisions 168-181; "Decided (leave build)" at the end of this
section), which added examples HL43-HL54. Where building showed an example
was wrong or unclear, the text is corrected with a note saying so.

Tests: `tests/unit/payroll-leave.test.ts` (the pure calculations: HL1-HL8,
HL10-HL16, HL20-HL27, HL30-HL33, HL42, decision 7),
`tests/unit/payroll-leave-opening.test.ts` and
`tests/integration/payroll-leave-opening.test.ts` (opening balances,
HL43-HL48, and HL52's liability figures),
`tests/integration/payroll-leave-requests.test.ts` (leave requests,
HL49-HL51), `tests/unit/payroll-leave-liability.test.ts` and
`tests/integration/payroll-leave-liability.test.ts` (posting the
liability, HL52-HL56) and
`tests/integration/payroll-leave.test.ts` (the database flows, with the
examples' own figures where Tohyee's records can hold them: Ben's usual
pay, public holidays, Labour Day worked, sick leave, alternative holidays,
holiday pay on finishing; Aroha's holidays, cash-up, bereavement, family
violence leave and balances; Eru's holidays in advance and leaving; Fiona (HL25, HL32);
Cara's ADP and the decision for her; unpaid leave; records, payslips, the
liability report, the EI file and the API).

**Which law.** On 1 Oct 2026 the **Holidays Act 2003** is in force. Section
numbers below (s16, s21 and so on) are that Act's, from the official
consolidation **as at 20 December 2023**
([legislation.govt.nz, Holidays Act 2003](https://www.legislation.govt.nz/act/public/2003/0129/latest/DLM236387.html)).
A search on 1 Oct 2026 found no later version.

**Due to change.** The **Employment Leave Act 2026** (2026 No 48, Royal
assent 6 August 2026) replaces the Holidays Act 2003 from **6 August 2028**
(for each employee, from the start of their first pay period starting on or
after that date). Under it leave is counted in hours and builds up from the
start of employment, instead of the 12-month and 6-month waits below.
Sources: [MBIE, Holidays Act reform: Employment Leave Act](https://www.mbie.govt.nz/business-and-employment/employment-and-skills/employment-legislation-reviews/holidays-act-reform-employment-leave-act),
[Employment NZ, Employment Leave Act 2026](https://www.employment.govt.nz/news-and-updates/employment-leave-act-2026)
and [the Act](https://www.legislation.govt.nz/act/public/2026/48/en/latest/)
(found 1 Oct 2026). Nothing here covers the new Act, and no example uses a
date on or after 6 Aug 2028. Anything P8 builds for the 2003 Act will stop
applying then (decision 7).

**How the sources were read (please check them).** The computer these
were written on couldn't open legislation.govt.nz, employment.govt.nz,
mbie.govt.nz, Xero Central or NetSuite's help directly, so:

- the Act's wording was read on 1 Oct 2026 from a copy of the 20 December
  2023 consolidation (the `jonnonz1/nz-statute-book` repository on GitHub,
  `acts/public/2003/holidays-act-2003.md`). Every rule below comes from a
  section of the Act, except where an example says it follows Employment NZ
  guidance or a numbered decision in `docs/DECISIONS.md`;
- Employment NZ and MBIE pages were found and summarised through a web
  search on 1 Oct 2026, so their exact wording wasn't seen. Links are given;
  where guidance seems to go further than the Act, the example names the
  decision that settles it;
- Xero Central articles were read on 1 Oct 2026 from undated copies (the
  `web-arena-x/webarena-infinity` repository, `apps/user-manuals/xero/payroll/`),
  each giving its Xero Central address. Xero may have changed them since.

Please open the linked pages before approving.

**NetSuite and Xero** (Jess's rule: follow NetSuite where it has an
answer, otherwise Xero). NetSuite's help covers general time-off plans
(accrual per period or per hour worked, in hours or days, with carryover
limits: [Time-Off Management Setup](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4607408864.html),
[Time-Off Rules](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1494524322.html))
but says nothing about the Holidays Act's pay rates; NZ payroll on NetSuite
comes from another company's add-on, not NetSuite's help. So **Xero Payroll
NZ** is followed where the Act leaves room. Xero Central articles used
(read 1 Oct 2026 as above):

- [How annual leave rates are calculated](https://central.xero.com/s/article/Understand-how-annual-leave-rates-are-calculated)
  and [Calculate an employee's four week average ordinary weekly pay](https://central.xero.com/s/article/How-to-manually-calculate-annual-leave-rates)
- [How holiday pay and annual leave works](https://central.xero.com/s/article/Manage-annual-leave-and-holiday-pay-for-employees)
- [Cash up an employee's annual leave](https://central.xero.com/s/article/Cash-up-an-employee-s-annual-leave)
- [Delete an employee or end their employment](https://central.xero.com/s/article/Delete-an-employee-and-end-their-employment)
  (final pay)
- [Process employee sick leave](https://central.xero.com/s/article/Manage-sick-leave-for-employees)
  and [Leave for employees working irregular hours explained](https://central.xero.com/s/article/Leave-for-employees-working-irregular-hours-explained)
- [Pay an employee for working a public holiday](https://central.xero.com/s/article/Pay-an-employee-for-working-a-public-holiday)
- [Track leave in days](https://central.xero.com/s/article/Track-leave-in-days)

Employment NZ pages used (found 1 Oct 2026 as above):
[Annual holidays](https://www.employment.govt.nz/leave-and-holidays/annual-holidays),
[Managing annual holidays](https://www.employment.govt.nz/leave-and-holidays/annual-holidays/managing-annual-holidays),
[Sick leave](https://www.employment.govt.nz/leave-and-holidays/sick-leave),
[Public holidays rights for employees](https://www.employment.govt.nz/leave-and-holidays/public-holidays/public-holidays-rights-for-employees),
[Factors to use to decide whether a day is an otherwise working day](https://www.employment.govt.nz/assets/uploads/documents/leave-and-holidays/Factors-to-use-to-decide-whether-a-day-is-an-otherwise-working-day.pdf),
[Alternative holidays](https://www.employment.govt.nz/leave-and-holidays/public-holidays/alternative-holidays),
[Relevant daily pay vs average daily pay](https://www.employment.govt.nz/assets/uploads/documents/pay-and-hours/Relevant-daily-pay-vs-average-daily-pay.pdf),
[Final pay](https://www.employment.govt.nz/pay-and-hours/pay-and-wages/final-pay),
[Holidays Act guidance tools: termination pay](https://www.employment.govt.nz/assets/uploads/documents/pay-and-hours/Holiday-Act-Guidance-tools-Termination-Pay.pdf)
and [Deductions and premiums](https://www.employment.govt.nz/pay-and-hours/pay-and-wages/deductions).

**The people in the examples.** Everyone is paid weekly, for pay periods
Monday to Sunday.

| Who | Pay | Usual week | Started |
| --- | --- | --- | --- |
| Aroha | Salary 62,400.00 a year (1,200.00 a week); a bonus of 2,600.00 each December that her agreement binds the employer to pay if targets are met | Mon-Fri, 8 hours a day | Tue 1 Apr 2025 |
| Ben | 28.00 an hour, **30.00 from Mon 15 Jun 2026**; 5 hours' overtime at time and a half every Thursday (rostered); shift allowance 10.00 for each shift worked | Mon-Fri, 8 hours a day, plus the Thursday overtime | Mon 3 Mar 2025; last day Fri 18 Dec 2026 |
| Cara | Permanent, hours and days vary week to week (not casual) | Varies | 2024 |
| Dan | 25.00 an hour, **32.00 for the 4 weeks before his leave** | Mon-Fri, 8 hours a day | 2025 |
| Eru | 25.00 an hour (1,000.00 a week) | Mon-Fri, 8 hours a day | Mon 6 Apr 2026; last day Fri 26 Feb 2027 |
| Fiona | 27.00 an hour, part-time | Tue, Wed, Thu, 6 hours a day | 2025 |
| George | Casual, as needed; often works Saturdays | Varies | 2026 |

**Rounding.** Rates are kept exact; each payment is rounded to cents once
(R3; decision 26). Xero also keeps rates unrounded (its example shows an
average weekly earnings figure of $843.137255). A payment already rounded
and paid (for example holiday pay) counts in later gross earnings at the
amount paid.

### The pay rates

- **HL1 Ordinary weekly pay (OWP), salary** (s8(1)). Aroha's OWP is her
  pay for an ordinary working week: **1,200.00**. Her December bonus isn't a
  regular part of her pay, so it's left out (s8(1)(c)(i)); so is employer
  KiwiSaver (s8(1)(c)(v)).
- **HL2 OWP with regular overtime and an allowance** (s8(1)(b)). Ben's
  overtime is rostered every week, so it's a regular part of his pay
  (s8(1)(b)(ii)). From 15 Jun 2026: 40 × 30.00 = 1,200.00, overtime 5 × 45.00
  = 225.00, shift allowance 5 × 10.00 = 50.00: OWP **1,475.00**. If his
  overtime were occasional it would be left out (s8(1)(c)(ii)) and his OWP
  would be 1,250.00. Xero counts "regular allowances" and "regular overtime"
  in OWP and takes them from the employee's pay template. Tohyee does the
  same: each pay item on Ben's usual pay is marked regular or not, and the
  person running pay can change it in a pay run (decision 11).
- **HL3 OWP by the four-week formula** (s8(2)). Where OWP can't be worked
  out under s8(1) (Cara's hours vary), OWP = (a − b) ÷ 4: a is gross
  earnings for the 4 calendar weeks before the end of the last pay period
  before the calculation, and b is the irregular incentive payments,
  irregular overtime and one-off payments in them (s8(1)(c)(i)-(iii)).
  Cara's last 4 weeks: gross 3,600.00, of which a one-off payment 200.00
  and irregular overtime 120.00. OWP = (3,600.00 − 320.00) ÷ 4 =
  **820.00**. Xero's four-week page uses this when "weekly days and hours
  vary significantly". Tohyee always works this figure out and shows it,
  for Aroha and Ben too, but uses it only where OWP can't be worked out
  under s8(1), as for Cara (decision 12).
- **HL4 Average weekly earnings (AWE), with a pay rise, overtime, an
  allowance and a bonus** (s5 "average weekly earnings", s14). AWE is 1/52
  of gross earnings for the 12 months. Tohyee uses the **12 calendar
  months ending at the end of the last pay period** (the Act's wording;
  decision 10), not the last 52 weeks of pay periods. For Ben's last day
  that pay period ends Sun 13 Dec 2026, so the 12 months are **Sun 14 Dec
  2025 to Sun 13 Dec 2026**: the 52 pay periods from Mon 15 Dec 2025, plus
  Sun 14 Dec 2025, the last day of the pay period before them. Pay for a
  pay period only partly inside the 12 months counts for the hours worked
  on the days inside them; Ben doesn't work Sundays, so that day adds
  nothing. (Counting the whole 8-14 Dec 2025 pay period would catch a 53rd
  week and overstate his AWE.)

  | Gross earnings (s14) | Amount |
  | --- | --- |
  | Ordinary time, 26 weeks at 28.00 (including paid holidays and leave in those weeks, s14(a)(iii)) | 29,120.00 |
  | Ordinary time, 26 weeks at 30.00 (likewise) | 31,200.00 |
  | Overtime, 26 × 5 hours at 42.00 (s14(a)(v)) | 5,460.00 |
  | Overtime, 26 × 5 hours at 45.00 | 5,850.00 |
  | Shift allowance, 245 shifts at 10.00 (s14(a)(ii)) | 2,450.00 |
  | Bonus his agreement binds the employer to pay (s14(a)(iv)) | 3,000.00 |
  | **Total** | **77,080.00** |

  Left out: a 120.00 reimbursement for tools he bought (actual costs,
  s14(c)(i)), employer KiwiSaver (s14(c)(iii)) and a 100.00 Christmas
  voucher the employer didn't have to give (discretionary, s14(b)(i)).
  AWE = 77,080.00 ÷ 52 = **1,482.3077** (1,482.31). It mixes both pay
  rates; OWP uses only the rate on the day (HL5).
- **HL5 A pay rise just before leave: OWP wins.** Dan's 12 calendar months
  (52 pay periods plus a Sunday he didn't work, as in HL4): 48 weeks at
  1,000.00 and 4 at 1,280.00 = 53,120.00, so AWE = 53,120.00 ÷ 52 =
  **1,021.54**. His OWP at
  the start of his leave is 40 × 32.00 = **1,280.00**. A week's annual
  holiday is paid at the greater (s21(2)(b)): **1,280.00**. After a pay cut
  it works the other way and AWE protects the employee.
- **HL6 Relevant daily pay (RDP)** (s9). What the employee would have been
  paid had they worked that day, including overtime and incentive payments
  they'd have had that day (s9(1)(b)), not employer KiwiSaver (s9(1)(c)).
  For a public holiday it doesn't include the extra half (s9(3)).
  - Ben, a Wednesday: 8 × 30.00 + 10.00 = **250.00**.
  - Ben, a Thursday: 8 × 30.00 + 5 × 45.00 + 10.00 = **475.00**.
  - Ben, a Saturday: not a working day, so no RDP.
  - Aroha, any weekday: 1,200.00 ÷ 5 = **240.00**.
- **HL7 Average daily pay (ADP)** (s9A). The employer may use ADP instead
  of RDP if RDP can't practicably be worked out, or the employee's daily pay
  varies within the pay period (s9A(1)). ADP = gross earnings for the 52
  calendar weeks before the end of the last pay period ÷ the number of whole
  or part days worked or on paid holidays or leave in them (s9A(2)). Cara:
  41,600.00 ÷ 208 days = **200.00**. Days she didn't work and wasn't paid
  for aren't counted. Unlike AWE, ADP keeps the 52 calendar weeks, because
  s9A(2) says so. Like AWE, ADP is slow to reflect a pay rise. Xero lets you
  switch between RDP and ADP on the payslip to compare them. In Tohyee RDP
  or ADP is **set per employee**, with the reason for ADP recorded (Cara:
  "daily pay varies within the pay period"), and can be changed in a pay
  run. ADP is offered only for the two reasons in s9A(1) (decision 13).
- **HL8 Units.** Annual holidays are an entitlement in **weeks** (s16);
  sick, bereavement and alternative holidays are in **days** (s65, s70,
  s56). The employer and employee agree what genuinely makes up a working
  week (s17): Aroha's is 5 days of 8 hours, Fiona's 3 days of 6 hours. Xero
  keeps every balance in **hours** ("Leave can only be accrued and displayed
  in hours", Track leave in days). Tohyee keeps the Act's units and stores
  the **hours on every leave entry**, worked out from the agreed week, and
  shows days and hours alongside (decision 8). Aroha's 4 weeks is 20 days
  or 160 hours; Fiona's is 12 days or 72 hours.

### Annual holidays

- **HL10 Entitlement** (s16). After each completed 12 months of continuous
  employment, at least 4 weeks' paid annual holidays (s16(1)).
  - Aroha started Tue 1 Apr 2025, completed 12 months at the end of Tue 31
    Mar 2026, and is entitled to **4 weeks on Wed 1 Apr 2026**, then 4 more
    each 1 April. For Fiona, 4 weeks is 12 of her working days (s17).
  - An entitlement doesn't lapse: it stays until it's taken or paid out
    (s16(4)), and the employer must let it be taken within 12 months of it
    arising (s18(1)), so balances can build up past 4 weeks.
  - Unpaid leave of 1 week or less counts towards the 12 months
    (s16(2)(a)(vi)); longer unpaid leave doesn't, unless agreed
    (s16(2)(b)). Had Aroha taken unpaid leave from Mon 2 to Sun 22 Feb 2026
    (3 weeks), that single period is longer than 1 week, so none of it
    counts: her anniversary moves by the whole 21 days, from Wed 1 Apr to
    **Wed 22 Apr 2026** (decision 14, following the Act's wording). Her AWE
    divisor stays 52.
  - If they agree, in writing, to count the whole 3 weeks, Tohyee records
    the agreement, the anniversary stays **Wed 1 Apr 2026** and her AWE
    divisor drops from 52 to **50** (the weeks over 1 week, s16(3)). Without
    a recorded agreement the divisor isn't cut. Xero's example lowers the
    divisor for unpaid weeks without mentioning an agreement; Tohyee doesn't
    follow it there.
- **HL11 Taking annual holidays** (s21). Aroha takes Mon 13 to Fri 17 Jul
  2026 (1 week). Paid at the greater of OWP at the start of the holiday
  (1,200.00) and AWE for the 12 calendar months to the end of the last pay
  period before it (Sun 13 Jul 2025 to Sun 12 Jul 2026, decision 10: 52 ×
  1,200.00 + her December 2025 bonus 2,600.00 = 65,000.00; the Sunday at
  the start adds nothing; ÷ 52 = 1,250.00): **1,250.00**. (Corrected 2 Oct
  2026 while building: the example had Mon 6 to Fri 10 Jul 2026, but Fri
  10 Jul 2026 is Matariki, a public holiday that would have been paid as
  one, not as an annual holiday (s 40(1); HL13). Moved a week later so the
  figures here and in HL12, HL13 and HL42 stand.) It's paid before
  the holiday unless they agree it's paid in the usual pay (s27(1)). Balance
  4 → **3 weeks** (the entry stores 40 hours). Xero likewise works the rate out for the period the leave is
  taken in, not the one it's paid in.
- **HL12 Cashing up** (s28A-s28F). On Mon 10 Aug 2026 Aroha asks in
  writing to be paid out 1 week; her employer agrees in writing (s28A(2),
  (3)). Both are attached to the cash-up, and Tohyee records the amount,
  the portion (1 week, 40 hours) and the date; it won't save a cash-up
  without them (decision 29). Paid at the s21(2) rate (s28B(1)(a)): OWP
  1,200.00; AWE for Sun 10 Aug 2025 to Sun 9 Aug 2026 (decision 10) = (51 ×
  1,200.00 + 1,250.00 holiday pay from HL11 + 2,600.00 bonus) ÷ 52 =
  65,050.00 ÷ 52 = **1,250.96**. Paid **1,250.96** as soon as practicable
  (s28B(1)(b)). Balance 3 → **2 weeks**.
  - Refused: a second week cashed up in the same entitlement year (1 Apr
    2026 to 31 Mar 2027; at most 1 week a year, s28A(2)(b)); cashing up when
    the organisation has a policy not to (s28E); cashing up annual holidays
    taken in advance (not yet an entitlement, s28A(1)). Tohyee never starts
    a cash-up itself: the employee asks (s28C, s28D).
  - Part of a week can be cashed up: 3 days (24 of her 40 hours) = 0.6 week
    = 0.6 × 65,050.00 ÷ 52 = **750.58**, and the rest of the week later in
    the same year. Tohyee keeps the total cashed up in the entitlement year
    and refuses anything over 1 week (decision 29).
  - The cash-up isn't gross earnings (s14(c)(iv)), so it doesn't raise
    later AWE, ADP or 8% figures: Aroha's AWE in HL13 is 65,050.00 ÷ 52, not
    66,300.96 ÷ 52. Xero: "Cashed up annual leave payments aren't included
    in the employee's gross earnings and won't accrue holiday pay."
- **HL13 Public holidays during annual holidays** (s40(1)). Aroha books Mon
  22 Mar to Fri 2 Apr 2027. Her anniversary day is **Wellington's, Mon 25
  Jan 2027** (Employment NZ), outside these dates (decision 180). (Clarified
  2 Oct 2026 while building: Otago's, Mon 22 Mar 2027, or Southland's, Tue
  30 Mar 2027, would add a public holiday inside them.) Across two pay periods each pays its days at the rate worked out
  for the holiday's start: 4 days (32 hours, 0.8 week) and Good Friday in
  the first, Easter Monday and 4 days in the second, **1,000.77** each. Good Friday (26 Mar) and Easter Monday (29 Mar)
  are public holidays, not annual holidays: each is paid at her RDP, 240.00,
  so **480.00**. The other **8 days** are annual holidays: 64 hours ÷ her
  usual 40 a week = **1.6 weeks**, paid at the greater of OWP 1,200.00
  and AWE for Sun 22 Mar 2026 to Sun 21 Mar 2027 (decision 10: 51 ×
  1,200.00 + 1,250.00 + December 2026 bonus 2,600.00 = 65,050.00; the
  cash-up is left out) ÷ 52 = 1,250.96: 1.6 × 65,050.00 ÷ 52 =
  **2,001.54**. Balance 2 → 0.4 weeks, then **4.4 weeks** on Thu 1 Apr 2027
  when her next 4 weeks arise.
  - **Part weeks are valued by hours** (decision 9): the weekly rate ÷ usual
    weekly hours × that day's hours, and the same share of a week comes off
    the balance. Aroha's days are all 8 hours, so it's the same as counting
    days. Ben's aren't: his usual week is 45 hours (8 a day plus 5 hours'
    overtime on Thursday). Had he taken single days at the weekly rate in
    HL16 (AWE 77,080.00 ÷ 52, more than his OWP 1,475.00), a Thursday (13
    hours) would be 77,080.00 × 13 ÷ (52 × 45) = **428.22** and 13 ÷ 45 =
    **0.2889 week** off his balance; a Wednesday (8 hours) 77,080.00 × 8 ÷
    (52 × 45) = **263.52** and **0.1778 week**. Four Wednesday-type days and
    a Thursday make the whole week: 4 × 263.5214 + 428.2222 = 1,482.3077.
    Counting days instead (÷ 5) would pay 296.46 for each.
- **HL14 Annual holidays in advance** (s20, s22). Eru's employer lets him
  take Mon 15 to Fri 19 Feb 2027 before his first anniversary (Tue 6 Apr
  2027). Paid at the greater of OWP (1,000.00) and AWE over the time he's
  worked, with the divisor cut to the whole or part weeks worked (s22(2)(b)(ii)(B),
  s22(3)): Mon 6 Apr 2026 to Sun 14 Feb 2027 is **45 weeks**, gross
  45 × 1,000.00 + 1,500.00 occasional overtime in December 2026 =
  46,500.00, so AWE = 46,500.00 ÷ 45 = **1,033.33**. Paid **1,033.33**.
  His balance shows **−1 week** (taken in advance); had he stayed, he'd have
  3 weeks left on 6 Apr 2027. The Act only says "an agreed portion", so
  Tohyee sets **no hard limit** (decision 15). It warns when leave in
  advance goes above what's been earned since the anniversary (or start):
  Mon 6 Apr 2026 to Mon 15 Feb 2027 is 315 days, and 315 ÷ 365 × 4 weeks =
  **3.45 weeks**, so 1 week gives no warning. Whenever leave is taken in
  advance, Tohyee prompts for the written agreement that lets the employer
  recover it if he leaves (HL15). Xero shows a cautious "available to take
  in advance" estimate on the same basis, rounded down to whole days.
- **HL15 Leaving before 12 months** (s23). Eru leaves on Fri 26 Feb 2027.
  He's paid **8% of his gross earnings since he started**, less holiday pay
  for annual holidays taken in advance (s23(2)). Gross earnings: 46,500.00
  + 1,033.33 (the week in advance is holiday pay, so it counts,
  s14(a)(iii)) + 1,000.00 (22-26 Feb) = 48,533.33. 8% = 3,882.67, less
  1,033.33 = **2,849.34**, paid in his final pay (s27(2)). He has no
  untaken entitlement, so there are no s40(3) public holidays to add.
  - If the leave taken in advance had been worth more than the 8%, Tohyee
    takes the difference off his final pay **only with his written consent
    attached**; without it the deduction is refused (Wages Protection Act
    1983 s 5(1), checked 1 Oct 2026; Employment NZ, Deductions and premiums;
    decision 16). Xero takes it off the final pay without asking; Tohyee
    doesn't follow it there. (Corrected 2 Oct 2026 while building: Tohyee
    doesn't make that deduction yet, even with consent, because how the
    recovered holiday pay is taxed (less gross pay, or an after-tax
    deduction) has no worked example: the final pay pays no holiday pay
    and a note gives the amount over the 8% and says it can be deducted
    only with written consent; refused rather than guessed, decision 150,
    question 3, now decision 170: still refused.)
- **HL16 Leaving after an entitlement has arisen** (s24, s25, s26, s40(3)).
  Ben leaves on Fri 18 Dec 2026. His last entitlement arose Tue 3 Mar 2026
  (4 weeks) and he's taken 2 weeks of it.
  1. **Untaken entitlement** (s24): 2 weeks (90 hours, stored with
     the entry) at the greater of OWP on his last day (1,475.00, HL2) and AWE
     for the 12 calendar months to the end of the last pay period before it
     (Sun 14 Dec 2025 to Sun 13 Dec 2026, HL4: 1,482.3077): 2 × 77,080.00 ÷
     52 = **2,964.62**.
  2. **Public holidays in that untaken time** (s40(3)): had Ben taken his
     10 days straight after leaving, from Mon 21 Dec 2026, they'd have run
     to Thu 7 Jan 2027, skipping Christmas Day (Fri 25 Dec), Boxing Day
     (Sat 26 Dec, his holiday is Mon 28 Dec, s45(1)(b)), New Year's Day (Fri
     1 Jan) and 2 January (Sat, his holiday is Mon 4 Jan). All four would
     have been working days for him, so each is paid at the RDP for that
     holiday's weekday (a Friday or a Monday) at his last pay rate, 8 ×
     30.00 + 10.00 = 250.00 (decision 18; ADP instead if he were set to ADP
     under decision 13): 4 × 250.00 = **1,000.00**. Xero's final pay page
     says the same.
  3. **8% since his last anniversary** (s25): gross earnings from 3 Mar to
     18 Dec 2026 were 62,180.00 (wages, overtime, allowances and the holiday
     pay for the 2 weeks he took). The untaken entitlement in 1 is added
     (s26(a)), and so is the pay for the public holidays in 2, because
     gross earnings include "the payment for the public holiday"
     (Employment NZ guidance; decision 17): 62,180.00 + 2,964.62 +
     1,000.00 = 66,144.62; 8% = 5,291.5696 = **5,291.57**. (Leaving the
     public holidays out would have given 5,211.57.)
  4. His alternative holiday was taken on 12 Nov (HL33), and sick leave
     isn't paid out (s67), so nothing else.

  Holiday pay in his final pay: 2,964.62 + 1,000.00 + 5,291.57 =
  **9,256.19** (s27(2)). Xero's final pay pays the annual leave balance
  plus its running 8% "holiday pay" since the last anniversary.

### Sick leave and bereavement leave

- **HL20 When it starts** (s63, s65). After 6 months' current continuous
  employment (s63(1)(a)), 10 days' sick leave for each 12 months from then
  (s63(2)(a), s65(2)). Aroha (started Tue 1 Apr 2025) completed 6 months at
  the end of Tue 30 Sep 2025: **10 days on Wed 1 Oct 2025**, 10 more on Thu
  1 Oct 2026, and so on. Bereavement leave starts on the same day (s63).
  Before then, only if they agree to leave in advance; sick leave taken in
  advance comes off the next entitlement (s63(3)). Xero adds sick leave
  "annually after 6 months" at the pay run that includes the date.
- **HL21 Employees without 6 months' continuous employment** (s63(1)(b)).
  Built for employees marked casual, from approved timesheets (decision
  145).
  George, a casual, is entitled if over 6 months he worked an average of at
  least 10 hours a week, and at least 1 hour in every week or at least 40
  hours in every month. 312 hours over 26 weeks (12 a week on average) with
  some work every week: entitled from the end of those 6 months
  (s63(2)(b)). With one week of no work, the weekly test fails and the
  monthly test decides. The Act doesn't define "month"; Tohyee uses
  calendar months (decision 20), so George needs at least 40 hours in each
  calendar month of the 6 months.
- **HL22 Carrying sick leave over** (s66). Aroha used 3 days in the year to
  30 Sep 2026, so 7 carry over: **17 days** on 1 Oct 2026. If she uses none
  by 30 Sep 2027, up to 10 carry over to a maximum of 20 (s66(2)): **20
  days** on 1 Oct 2027, and 7 lapse. Unused sick leave isn't paid out when
  employment ends (s67).
- **HL23 Paying sick leave** (s71, s72). Ben is sick Wed 4 and Thu 5 Nov
  2026: RDP 250.00 + 475.00 = **725.00** (s71(1)), paid in that week's pay
  (s72(1)); **2 days** come off his balance. A sick Saturday isn't a working
  day for him: no pay, nothing off the balance. If he's away 3 or more
  consecutive calendar days the employer may ask for proof (s68(1)) and may
  hold the pay until it's given (s72(2)).
  - **Part of a day** (decision 19). Had Ben gone home sick at noon on Wed
    18 Nov 2026 after 4 of his 8 hours, **1 whole day** comes off his
    balance by default (the Act counts days; the entry stores 8 hours) and
    his pay for the day is still his RDP, 250.00: 4 hours worked (120.00)
    and the shift allowance (10.00) as usual, plus 4 hours' sick leave
    (120.00). Only where an agreement for part days is recorded for him
    does **0.5 day** (4 hours) come off instead, with the same pay.
- **HL24 Sick leave at ADP** (s9A). Cara's daily pay varies within the pay
  period, so she's set to ADP, with that reason recorded (decision 13):
  **200.00** a day (HL7). Xero's example
  for an employee with uneven days: Moana's 10-hour Thursday on sick leave
  is paid as 10 hours (her RDP for that day), not as her 7-hour "standard"
  day.
- **HL25 Sick leave and annual holidays** (s36, s38, s39). Sick during
  annual holidays: those days can be sick leave if the employer agrees
  (s36). Sick before booked annual holidays: the employer must let those
  days be sick leave (s38). Sick leave used up: the employer can't make the
  employee use annual holidays, but may agree if the employee asks (s39).
- **HL26 Bereavement leave** (s69, s70, s71). Aroha's grandmother dies; she
  takes Mon 9 to Wed 11 Nov 2026: **3 days** (s69(2)(a)(v), s70(1)(a)) at
  RDP 240.00 = **720.00**. It doesn't come off her sick leave, and there's
  no yearly balance: each bereavement has its own days, and two at the same
  time give 3 days each (s70(2)). A miscarriage or still-birth is also 3
  days (s69(2)(c), (d)). For anyone else's death it's **1 day**, if the
  employer accepts the employee has suffered a bereavement (s69(2)(b), with
  the factors in s69(3)). Bereavement during annual holidays must be
  allowed instead of annual holidays (s37). Not paid out when employment
  ends.
- **HL27 Family violence leave** (s72A-s72J; decision 27). Built with sick
  leave, as its own balance: 10 days for each 12 months from the same date
  as sick leave (HL20; Aroha's arose on Thu 1 Oct 2026), paid like sick
  leave at RDP or ADP (s72I), and not carried over (s72H). Aroha takes Tue
  1 and Wed 2 Dec 2026: **2 days** at RDP 240.00 = **480.00**, and her
  family violence balance goes 10 → **8 days** (16 hours stored); her sick
  leave balance doesn't change. Its records are kept private: only people
  with payroll access see them.

### Public holidays and alternative holidays

- **HL30 Otherwise a working day** (s12, s49). A public holiday is paid only
  if it would otherwise have been a working day for the employee. Labour
  Day, Mon 26 Oct 2026:
  - Aroha (Mon-Fri) doesn't work it: paid her RDP, **240.00** (s49).
  - Fiona (Tue-Thu) doesn't work Mondays: **no pay**.
  - Cara (varies): if it's not clear, employer and employee consider her
    agreement, work patterns, rosters, whether she works only when work is
    available, what both reasonably expected, and whether she'd have worked
    but for the holiday (s12(2), (3)); any time she'd otherwise have worked
    makes it a working day (s12(4)); a Labour Inspector decides if they
    can't agree (s13). Employment NZ's factors sheet says to weigh these
    together, not apply a formula. Tohyee can't decide this on its own: it
    suggests from Cara's recent weeks (for example, she worked 3 of the
    last 4 Mondays) and the person running pay confirms or changes it, and
    the decision is recorded with the holiday (decision 21). Tohyee
    suggests "yes" from 2 of the last 4 (decision 146); until the decision
    is recorded the pay run can't be approved. Xero assigns
    each employee a "holiday group" and adds public holidays in pay periods
    automatically.
- **HL31 Which day is the holiday** (s44, s45, s45A). For an employee who
  doesn't work weekends (Aroha), 2026-27: Christmas Day **Fri 25 Dec**;
  Boxing Day falls on Sat 26 Dec, so **Mon 28 Dec** (s45(1)(b)); New Year's
  Day **Fri 1 Jan**; 2 January is a Saturday, so **Mon 4 Jan**; Waitangi Day
  is Sat 6 Feb, so **Mon 8 Feb** (s45A(1)(b)); Good Friday **26 Mar**;
  Easter Monday **29 Mar**; ANZAC Day is Sun 25 Apr, so **Mon 26 Apr**; the
  Sovereign's birthday **Mon 7 Jun 2027** (the first Monday in June,
  s44(1)(i)). For George, who would otherwise
  work Saturday 26 Dec, Boxing Day stays **Sat 26 Dec** (s45(1)(a)). Two
  holidays on the same day count as one (s44(4)). Matariki's date comes from
  Schedule 1 of Te Kāhui o Matariki Public Holiday Act 2022 and anniversary
  days from local observance (s44(1)(ia), (k)). (Added 2 Oct 2026 while
  building: Tohyee has Employment NZ's dates for 2025-2027, Matariki
  included (Fri 25 Jun 2027 in this list), decision 162; s 45 moves a
  holiday that falls on a Saturday to the Monday and on a Sunday to the
  Tuesday, so Christmas 2027 (Saturday) is Mon 27 Dec and Boxing Day
  (Sunday) Tue 28 Dec. 2028 isn't published yet; it's added when it is,
  decision 179.)
  Public holiday dates are kept as dated data with their source, like the
  IRD rates in P2. Anniversary day is set per employee, defaulting from the
  organisation's; if not agreed, it's the one for the province where they
  usually work (decision 22). Xero "Mondayises the holiday for you".
- **HL32 Working on a public holiday** (s50, s56). Ben works his usual 8
  hours on Labour Day, Mon 26 Oct 2026, an otherwise working day. His RDP
  for the time worked is 8 × 30.00 + 10.00 = 250.00. He's paid the greater
  of (a) that plus half again, **375.00**, or (b) that, 250.00 (s50(1)):
  **375.00**, and gets an **alternative holiday** (s56).
  - If his agreement paid double time on public holidays (an identifiable
    penal rate of 30.00 an hour): (a) still leaves the penal rate out, 250.00
    × 1.5 = 375.00 (s50(1)(a), (2)); (b) is his RDP for the time with it,
    8 × 60.00 + 10.00 = 490.00. Paid **490.00**.
  - Fiona works 6 hours on Labour Day, not otherwise a working day for her:
    6 × 27.00 × 1.5 = **243.00** (s48(1)(b), s50) and **no** alternative
    holiday (s56(1)(a)).
  - Ben works only 4 of his 8 hours: (4 × 30.00 + 10.00) × 1.5 = **195.00**,
    and still a whole alternative holiday (s57(1)(c)). Nothing is added
    automatically for the 4 hours he didn't work (decision 23); where his
    agreement gives more, the person running pay can type the extra in.
  - Ben is rostered on Labour Day but is sick: the day stays a public
    holiday, paid at RDP **250.00** (s49), not time and a half, no
    alternative holiday, and no sick leave used (s61A).
  - Pay for a public holiday goes in the pay for the period it falls in
    (s55). Xero adds a "time and a half" pay item and an alternative holiday
    accrual by hand.
- **HL33 Alternative holidays** (s56, s57, s60, s61). Ben's alternative
  holiday arose on Mon 26 Oct 2026 (the record keeps that date,
  s81(2)(k)). It's a whole working day off, on a day that would otherwise be
  a working day and isn't a public holiday (s57(1)); if they can't agree
  when, the employer sets it with 14 days' notice (s57(2), (3)).
  - He takes it on **Thu 12 Nov 2026**: paid his RDP for that day, **475.00**
    (s60(1)), including his regular Thursday overtime. On a Wednesday it
    would have been 250.00.
  - Had it still been untaken when he left on Fri 18 Dec 2026, it would be
    paid at his RDP for his last day (a Friday), **250.00**, in his final
    pay (s60(2)(b)).
  - Exchanging it for money (s61): only if Ben asks, only once 12 months
    have passed since it arose (from 26 Oct 2027), and only if the employer
    agrees, for "the amount agreed" (s61(3)). The Act gives no formula, so
    Tohyee defaults the amount to his RDP (or ADP, decision 13) for the
    exchange date, which can be changed to the amount agreed, and the
    agreement is recorded (decision 24). Had he stayed and exchanged it on
    Wed 27 Oct 2027 at his current rates, the default would be his
    Wednesday RDP, 8 × 30.00 + 10.00 = **250.00**.
  - Alternative holidays are counted in **days**, with that day's hours
    stored (decision 25): taking it on Thu 12 Nov uses **1 day** (13 hours
    stored); on a Wednesday it would be 1 day (8 hours). Xero keeps them in
    hours, adding the "standard number of hours for a day" (8 for Ben),
    which would leave him 5 hours short on a Thursday.

### Holiday and leave records

- **HL40 What the record must hold** (s81(2)). For each employee, kept in
  writing or so it can easily be printed (s81(3)), for at least **6 years**
  after each entry (s81(4)), and shown or copied when the employee, their
  representative, their union or a Labour Inspector asks (s82). Where
  Tohyee would get each item:

  | s81(2) | Item | From |
  | --- | --- | --- |
  | (a), (b) | Name; date employment started | Employee record (P1) |
  | (c) | Hours worked each day in a pay period and the pay for them (or the agreed usual hours, s81(3A)) | Pay runs (P3) |
  | (d), (e) | Current annual holiday entitlement; date last entitled | Leave balances (P8) |
  | (f) | Current sick leave entitlement | Leave balances (P8) |
  | (g), (h) | Dates of annual holidays, sick, bereavement and family violence leave taken, and the pay for them | Leave taken (P8) and pay runs |
  | (ha), (hb) | How much annual holiday was cashed up each entitlement year, with dates and amounts | Cash-ups (P8) |
  | (i), (j) | Dates of public holidays worked, the pay for them and the hours worked | Pay runs |
  | (ja) | Public holidays transferred (s44A, s44B) | Not supported yet |
  | (k) | Date each alternative holiday arose | Leave balances (P8) |
  | (l) | Dates of, and pay for, public and alternative holidays not worked but paid | Pay runs |
  | (m) | Cash value of board or lodgings | Not supported yet |
  | (n) | Payments in exchange for alternative holidays (s61(3)) | P8 |
  | (o), (p) | Date employment ended; holiday pay on termination | Employee record (P1); final pay (P8) |

  Posted pay and leave are never edited (corrections are new entries), and
  employees are archived, never deleted, so the 6 years are kept. If the
  record isn't kept, the Employment Relations Authority may accept the
  employee's statements as proved (s83), so it has to be complete.
- **HL41 Ben's record** after the examples above (a printable page per
  employee, with a CSV export):

  | Date | Entry | Amount |
  | --- | --- | --- |
  | 3 Mar 2025 | Employment started | |
  | 3 Mar 2026 | Entitled to 4 weeks' annual holidays | |
  | 26 Oct 2026 | Worked Labour Day, 8 hours; alternative holiday arose | 375.00 |
  | 4-5 Nov 2026 | Sick leave, 2 days | 725.00 |
  | 12 Nov 2026 | Alternative holiday taken | 475.00 |
  | 18 Dec 2026 | Employment ended; holiday pay on termination (2 weeks untaken, 4 public holidays, 8%) | 9,256.19 |

  (His 2 weeks' annual holidays earlier in 2026 and his sick leave
  entitlement would also be listed.)
- **HL42 Balances shown for Aroha** on Thu 1 Apr 2027: annual holidays
  **4.4 weeks** (22 days of her week; last entitled 1 Apr 2027; 1 week
  cashed up in the year to 31 Mar 2027); sick leave **17 days** less any
  taken since 1 Oct 2026; family violence leave **8 days** (HL27); no
  bereavement balance. Like Xero, Tohyee also shows a running "holiday pay"
  amount, 8% of gross earnings since the last anniversary: what she'd be
  owed for the part year if she left. On 1 Apr 2027 hers starts again from
  **0.00**. For Ben on his last day, before his final pay, it was 8% ×
  62,180.00 = **4,974.40** (HL16, step 3, before the untaken entitlement
  and public holidays are added). These are shown on a leave liability
  report; posting leave liability to the ledger waits for its own approved
  worked example (decision 28).

### Opening balances, leave requests and posting the liability (added 2 Oct 2026, not yet approved by Jess)

Written on 2 Oct 2026 for decisions 168, 169 and 177 (the leave build's
questions 1, 2 and 10). Like the examples above they're **not approved by
Jess**.

**Hemi** joins the people above: 30.00 an hour, Monday to Friday, 8 hours a
day (OWP 1,200.00, RDP 240.00 a day), paid weekly for pay periods Monday to
Sunday, set to RDP, anniversary day Otago's, with annual holidays paid in
the pay for the period they're taken (s 27(1)(a)); started **Mon 4 Mar
2024**. His
employer moves payroll to Tohyee from the pay period starting **Mon 5 Oct
2026**.

- **HL43 Entering opening balances** (decision 168). Someone with payroll
  access enters Hemi's opening balances **as at Sun 4 Oct 2026** (the last
  day before Tohyee's first pay period for him), with where they came from
  ("Previous payroll's leave and earnings reports at 4 Oct 2026") and those
  reports attached (both required):
  - annual holidays **2.5 weeks** (100 hours of his 40-hour week); last
    entitled **Wed 4 Mar 2026**; **0.5 week** already cashed up in that
    entitlement year (June 2026); nothing taken in advance;
  - sick leave **14 days**; family violence leave **10 days**;
  - one untaken alternative holiday that arose on **Mon 27 Oct 2025** (he
    worked Labour Day);
  - his earnings for the 12 months, one row per weekly pay period of the
    previous payroll, **Mon 6 Oct 2025 to Sun 4 Oct 2026** (52 rows, no
    gaps, ending on the opening date): 1,200.00 and 5 days each, except
    27 Oct-2 Nov 2025, **1,320.00** (Labour Day worked at time and a half),
    and 15-21 Dec 2025, **2,200.00** (a 1,000.00 bonus his agreement binds
    the employer to pay, entered as irregular). The June cash-up isn't
    gross earnings (s 14(c)(iv)), so it isn't in the rows. Total
    **63,520.00**, 260 days.

  Shown on Mon 5 Oct 2026: annual holidays 2.5 weeks, last entitled 4 Mar
  2026, next 4 Mar 2027, 0.5 week cashed up this entitlement year (so at
  most 0.5 week more until Wed 3 Mar 2027, s 28A(2)(b)); sick leave 14
  days, last entitled Fri 4 Sep 2026 (6 months after the start and each 12
  months, s 63(2)(a)); family violence leave 10 days; 1 alternative
  holiday. The running 8% since 4 Mar 2026 (HL42): Wed 4 to Sun 8 Mar is
  part of the 2-8 Mar row, 24 of its 40 usual hours, so 1,200.00 × 24 ÷ 40
  = 720.00, plus the 30 rows from 9 Mar, 36,000.00: 36,720.00 × 8% =
  **2,937.60**. Hemi isn't refused any more (decision 143 no longer applies
  to him). Had Tohyee already paid him for 21 Sep-4 Oct 2026 with P3's
  typed "Holiday pay", the opening balances at 4 Oct would cover those pay
  runs and his rows would end on Sun 20 Sep 2026, the day before them.
- **HL44 Annual holidays after opening balances.** Tohyee's first pay run
  for Hemi, 5-11 Oct 2026, pays 1,200.00 and is approved. He takes **Mon 12
  to Fri 16 Oct 2026** (1 week, 40 hours). OWP 1,200.00; AWE for Sun 12 Oct
  2025 to Sun 11 Oct 2026 (decision 10): the opening rows from 13 Oct 2025
  (51 rows, 62,320.00; the 6-12 Oct 2025 row has only its Sunday inside,
  which he doesn't work, so it adds nothing) and Tohyee's 5-11 Oct
  (1,200.00) = 63,520.00 ÷ 52 = **1,221.54**, more than OWP: paid
  **1,221.54**. Balance 2.5 → **1.5 weeks**.
- **HL45 Sick leave after opening balances.** Hemi is sick Wed 21 Oct
  2026: RDP **240.00**; sick leave 14 → **13 days**. If he used no more,
  on Sat 4 Sep 2027 at most 10 would carry over: **20 days**, and 3 lapse
  (s 66(2)).
- **HL46 An alternative holiday from the opening balances.** He takes it
  on Thu 22 Oct 2026: RDP **240.00**, 1 day (8 hours); it uses the one that
  arose on 27 Oct 2025 (decision 147) and none are left. (Had he kept it,
  he could have asked to exchange it from Tue 27 Oct 2026, s 61(2)(a).)
- **HL47 Leaving after opening balances.** Hemi's last day is **Fri 30 Oct
  2026**. His final pay, 26 Oct-1 Nov 2026, pays Labour Day (Mon 26 Oct,
  not worked, RDP 240.00, s 49) and Tue-Fri worked (960.00): 1,200.00.
  Holiday pay on finishing:
  1. **Untaken entitlement** (s 24): 1.5 weeks at the greater of OWP on his
     last day (1,200.00) and AWE for Sun 26 Oct 2025 to Sun 25 Oct 2026:
     the 49 opening rows from 27 Oct 2025 (59,920.00) and Tohyee's
     1,200.00 + 1,221.54 + 1,200.00 = 63,541.54 ÷ 52 = 1,221.95: 1.5 ×
     63,541.54 ÷ 52 = **1,832.93**.
  2. **Public holidays in that time** (s 40(3)): 60 hours from Mon 2 Nov
     2026 run to Wed 11 Nov; none falls in them for Otago: **0.00**.
  3. **8% since his last anniversary** (s 25, s 26): Wed 4 Mar to Fri 30
     Oct 2026: 720.00 + 36,000.00 from the opening rows (HL43), Tohyee's
     3,621.54 for 5-25 Oct and the final pay's 1,200.00 = 41,541.54, plus
     the untaken entitlement 1,832.93 = 43,374.47; 8% = **3,469.96**.
  4. No alternative holidays left (HL46); sick leave isn't paid out (s 67).

  Holiday pay on finishing **5,302.89**, each part a line as in HL16.
- **HL48 Refused rather than guessed (opening balances).**
  - Opening balances as at **Wed 7 Oct 2026**, inside the pay period 5-11
    Oct: the pay run for that period refuses Hemi's leave until they're as
    at the end of a pay period (Sun 4 or Sun 11 Oct).
  - Earnings rows with a gap (no row for 12-18 Jan 2026), rows that
    overlap each other, a row after the opening date, or a row covering a
    pay period Tohyee has already approved for him: not saved.
  - A negative annual balance without the holiday pay paid in advance, or
    that amount with a balance that isn't negative: not saved. Nor a
    positive annual balance before 12 months' employment, or positive sick
    or family violence days before 6 months (there's no entitlement yet;
    only leave taken in advance, a negative balance, s 63(3)).
  - Opening balances for an employee set to casual (s 63(1)(b)'s hours test
    needs approved timesheets for the 6 months, decision 145): not saved.
  - Replacing the opening balances after an approved pay run has paid Hemi
    leave (HL44's PAYRUN): refused until that pay run is voided.
  - P3's typed "Holiday pay" on a pay run for a period ending after the
    opening date: leave stays refused for him (Tohyee doesn't know what it
    was for).
  - Rows only from Mon 5 Jan 2026: HL44's AWE needs pay from Sun 12 Oct
    2025, so the holiday is refused, naming that date.
  - Someone set to ADP whose 52 calendar weeks start part way through an
    opening row (rows by month, say): refused, as the days worked in part
    of a row aren't known; enter the rows by pay period.

**Leave requests** (decision 169). Aroha (HL1) has a login linked to her
employee record and no payroll access; her reports-to manager, Wiremu,
has a bookkeeper login and no payroll access.

- **HL49 Asking for leave and approving it.** On Mon 1 Feb 2027 Aroha asks
  for annual holidays **Mon 1 to Fri 5 Mar 2027**. Tohyee shows her the
  days (5) and hours (40) from her usual week and her annual holiday
  balance in weeks and hours, never an amount of money. Wiremu sees the
  request with her name, the dates, the type and the hours, approves it,
  and Tohyee books the leave as him (LEAVE-n, linked to the request): the
  pay run for 1-7 Mar 2027 pays it at the s 21(2) rate, as in HL11.
- **HL50 Changing, withdrawing and rejecting.** Before it's decided, Aroha
  changes the request to Mon 1 to Wed 3 Mar (24 hours) or withdraws it. A
  rejection needs a reason, which she sees; a rejected request stays as it
  was (she asks again if she wants to).
- **HL51 Refused (leave requests).**
  - Wiremu approving a request of his own, or anyone approving who isn't
    the employee's timesheet approver, their reports-to manager's login or
    someone with payroll access.
  - A request for days that aren't working days for her, or that the
    booking would refuse (another booking on the same days, a
    bereavement over its days): the approval is refused with the
    booking's reason, and the request stays waiting.
  - Changing or withdrawing a request once it's decided; cancelling an
    approved request is cancelling its booking, by someone with payroll
    access, and never once an approved pay run has paid it.
  - Family violence leave is asked for and shown to the approver as
    "Special leave" (decision 27).
  - Someone whose leave Tohyee doesn't keep (no usual week, or decision
    143 without opening balances): the request can't be made.

**Posting the leave liability** (decision 177; designed as the acceptance
tests for the build, **built on 2 Oct 2026** with decisions 182-187, which
added HL55 and HL56). The organisation has a "Leave expense" account
(6220) and an "Employee entitlements" current liability account (2260),
chosen under Payroll › Pay items; Hemi's cost allocation is 100% to the
Workshop Department. Postings are LEAVELIAB-1, -2 and so on, made under
Payroll › Leave › Liability by someone with payroll access and the
bookkeeper role.

- **HL52 The first posting.** After HL44's first pay run (period ending
  Sun 11 Oct 2026), the liability report at Sun 11 Oct 2026 shows Hemi's
  annual holidays 2.5 weeks × 1,221.54 (AWE 63,520.00 ÷ 52) = **3,053.85**,
  the running 8% since 4 Mar 2026 to 11 Oct, (36,720.00 + 1,200.00) × 8% =
  **3,033.60**, and 1 alternative holiday at OWP 1,200.00 ÷ 5 = **240.00**:
  **6,327.45**. Nothing was posted before, so the journal dated 11 Oct
  2026 is Dr Leave expense 6,327.45 (Workshop) / Cr Employee entitlements
  6,327.45 (Workshop), described "Leave liability at 11 Oct 2026", never
  naming Hemi.
- **HL53 Finished, final pay not yet paid** (rewritten for decision 189).
  Hemi's last day is Fri 30 Oct 2026 and his final pay (26 Oct-1 Nov) is
  approved with pay date Wed 4 Nov. At Sat 31 Oct he has finished but isn't
  paid yet, so he stays in the report at the holiday pay on finishing on
  that final pay: untaken annual holidays 1.5 weeks × 1,221.95 = 1,832.93
  (s 24) and 8% of gross earnings since 4 Mar 2026, 3,469.96 (s 25):
  **5,302.89**. Hemi isn't enrolled in KiwiSaver, so there's no employer
  KiwiSaver on it. With LEAVELIAB-2 voided (HL55), LEAVELIAB-3 at 31 Oct
  measures from LEAVELIAB-1: 5,302.89 − 6,327.45 = −1,024.56, so Dr
  Employee entitlements 1,024.56 / Cr Leave expense 1,024.56 (Workshop).
  Sick, bereavement and family violence leave are never in it (decision
  188).
- **HL54 Refused or undone (posting).** A posting dated before the last
  one; a posting while any employee's row in the report has a problem
  (it names them); a posting without the two accounts set. A posting is
  never edited: voiding it posts the reversing journal, and the next
  posting measures from the last one not voided. (Built: also a posting
  in a locked period; voiding a posting that a later one measured from,
  "Void it first"; a void date before the posting's date; and correcting
  its journal in the ledger. Decisions 182, 183.)
- **HL55 A posting after leave is taken, then voided** (decisions 182,
  183). After the pay run for 12-18 Oct 2026 (HL44's week of annual
  holidays, 1,221.54 to wages), the report at Sun 18 Oct 2026 shows Hemi's
  annual holidays 1.5 weeks at AWE for Sun 19 Oct 2025 to Sun 18 Oct 2026:
  the opening rows from 20 Oct 2025 (50 rows, 61,120.00; the 13-19 Oct
  2025 row has only its Sunday inside) and Tohyee's 1,200.00 + 1,221.54 =
  63,541.54 ÷ 52 = 1,221.95, so 1.5 × 63,541.54 ÷ 52 = **1,832.93**; the
  running 8% since 4 Mar 2026, (36,720.00 + 1,200.00 + 1,221.54) × 8% =
  39,141.54 × 8% = **3,131.32**; and the alternative holiday (taken 22
  Oct) still **240.00**: **5,204.25**. The posting LEAVELIAB-2 measures
  from LEAVELIAB-1 (HL52): 5,204.25 − 6,327.45 = −1,123.20, so Dr Employee
  entitlements 1,123.20 / Cr Leave expense 1,123.20 (Workshop). Posting
  again at 18 Oct is refused: "Nothing to post". LEAVELIAB-2 is then
  voided on 18 Oct (VOID-LEAVELIAB-2, the exact reversal); voiding
  LEAVELIAB-1 first is refused, because LEAVELIAB-2 measured from it. With
  LEAVELIAB-2 voided, HL53's posting at 31 Oct (LEAVELIAB-3) measures from
  LEAVELIAB-1 (and HL57's brings the account to 0.00).
- **HL56 The accounts** (decision 184). An admin with payroll access sets
  them under Payroll › Pay items. Refused: Employee entitlements (2260) as
  the leave expense ("isn't an expense account"), Term loan (2800, a
  non-current liability) or Wages payable (2240, a control account) as
  the employee entitlements account, and a bookkeeper changing them.
  While LEAVELIAB-1 has left 6,327.45 in 2260, changing the employee
  entitlements account to 2270 is refused; after LEAVELIAB-4 (HL57) brings
  it to 0.00 it's allowed. The leave expense account can change at any time (to
  6200 and back): it only moves where later changes go.

- **HL57 The final pay is paid** (decision 189). At Wed 4 Nov 2026, the
  final pay's pay date, Hemi drops out of the report (the final pay's
  journal of 4 Nov has the holiday pay as wages). LEAVELIAB-4 at 4 Nov:
  0.00 − 5,302.89, Dr Employee entitlements 5,302.89 / Cr Leave expense
  5,302.89 (Workshop). The Employee entitlements account is then 0.00:
  6,327.45 − 1,123.20 + 1,123.20 − 1,024.56 − 5,302.89. Mere (HL54), who
  finished on 12 Oct and was never paid by a pay run in Tohyee, isn't in
  the report at either date.

The next examples use another organisation, with the same two accounts and
an Office Department. **Tama** starts Mon 28 Sep 2026: hourly at 30.50 for 8
hours Monday to Friday (OWP 1,220.00), paid weekly in Tohyee from his first
week (so Tohyee keeps his leave from the start, with no opening balances),
100% to Office, enrolled in KiwiSaver at 3.5% employee and 3.5% employer,
ESCT 17.5%. His first two weeks (28 Sep-4 Oct, paid 7 Oct; 5-11 Oct, paid
14 Oct) are approved pay runs of 1,220.00 each.

- **HL58 Finished, no final pay approved** (decision 189). Tama's last day
  is Fri 16 Oct 2026; the pay run for 12-18 Oct is still a draft. The
  report at Sun 18 Oct has his row with the problem "Tama Liability
  finished on 16 Oct 2026 and their final pay isn't approved yet. Approve
  the pay run that includes 16 Oct 2026 (their final pay) first.", and
  posting at 18 Oct is refused naming him.
- **HL59 Employer KiwiSaver on the leave** (decision 190). The report at Sun
  11 Oct shows Tama's running 8% (1,220.00 + 1,220.00) × 8% = **195.20** (no
  annual holidays yet, no alternative holidays) and employer KiwiSaver
  195.20 × 3.5% = 6.832, truncated to **6.83**. LEAVELIAB-1 at 11 Oct: Dr
  Leave expense 195.20 / Cr Employee entitlements 195.20 ("Leave expense"
  and "Employee entitlements"), and Dr Leave expense 6.83 / Cr Employee
  entitlements 6.83 (both "Employer KiwiSaver on leave"), all tagged
  Office. The posting keeps 195.20 and 6.83 for Office; its total and
  change are 202.03.
- **HL60 KiwiSaver on holiday pay on finishing** (decisions 189, 190). The
  final pay for 12-18 Oct (pay date Wed 21 Oct) is approved: usual pay to
  his last day 1,220.00, and holiday pay on finishing 8% of 3 × 1,220.00 =
  **292.80** (s 23: less than a year, so no untaken entitlement; Labour Day
  is after his last day). At Sun 18 Oct the report has Tama at 292.80 and
  KiwiSaver 292.80 × 3.5% = 10.248, truncated to **10.24** (rounding would
  give 10.25). LEAVELIAB-2 at 18 Oct measures from LEAVELIAB-1: leave
  292.80 − 195.20 = 97.60 and KiwiSaver 10.24 − 6.83 = 3.41, so Dr Leave
  expense 97.60 / Cr Employee entitlements 97.60 and Dr Leave expense 3.41
  / Cr Employee entitlements 3.41 (Employer KiwiSaver on leave), Office;
  the posting's change is 101.01. At Wed 21 Oct he's paid and drops out:
  LEAVELIAB-3, Dr Employee entitlements 292.80 / Cr Leave expense 292.80
  and Dr Employee entitlements 10.24 / Cr Leave expense 10.24, change
  −303.04; the account is then 0.00.
- **HL61 The month-end reminder** (decision 191). Before any posting, on
  Thu 15 Oct 2026 there's no reminder (the latest month end is 30 Sep, and
  no approved pay run's period end or pay date is on or before it); on Sun
  1 Nov 2026 a bookkeeper with payroll access sees "Post the leave
  liability at 31 Oct 2026: pay runs have been approved since nothing was
  posted". Once LEAVELIAB-3 is posted at 21 Oct, on Sun 1 Nov there's none
  (no approved pay run's period end or pay date is after 21 Oct). A
  bookkeeper without payroll access, and a viewer, never see it.

### Not supported yet (refused rather than guessed)

- Anything under the **Employment Leave Act 2026** (from 6 Aug 2028).
- Closedown periods (s29-s35).
- Transferring public holidays (s44A-s44C), and the record of it
  (s81(2)(ja)).
- Being on call on a public holiday (s59).
- Paying 8% with each pay (s28) for fixed-term employees under 12 months or
  very irregular work.
- Board or lodgings (s10), home and community support travel payments
  (s10A).
- ACC weekly compensation and first week compensation alongside sick leave
  (s71(2)-(4)); parental leave and volunteers leave in the 12 months
  (s16(2)).
- More than the minimums (for example a fifth week), and special rates in
  employment agreements (s8(3), s9(2)).
- Labour Inspector determinations (s11, s13, s17(2), s28F, s54), and
  re-employment within a month (s85).
- Posting a leave liability to the ledger: **built on 2 Oct 2026**
  (decisions 177, 182-191, HL52-HL61). Sick leave carried over stays out
  (decision 188: material only where it can be taken as annual leave,
  which the Act doesn't allow); an organisation whose agreements allow it
  journals its own estimate.

### Decided (Holidays Act leave)

Jess asked Claude to research these questions and make the calls (1 Oct
2026). Each decision, with its source, is in `docs/DECISIONS.md`
("Holidays Act leave" and "The new leave law"); the examples above follow
them. The examples themselves still need Jess's approval.

- **7** Build for the 2003 Act now, as a dated rule-set ending at each
  employee's first pay period starting on or after 6 Aug 2028.
- **8** Entitlements in the Act's units (weeks, days), with hours stored on
  every entry (HL8).
- **9** Part weeks with unequal days valued by hours (HL13).
- **10** AWE over the 12 calendar months ending at the end of the last pay
  period (HL4, HL11-HL13, HL16).
- **11** "Regular" items marked on the usual pay, changeable in a pay run
  (HL2).
- **12** The four-week OWP always worked out and shown, used only when OWP
  can't be worked out (HL3).
- **13** RDP or ADP set per employee, with the reason for ADP recorded (HL7,
  HL24).
- **14** Unpaid leave of more than a week (a single period) moves the
  anniversary by its whole length unless a written agreement to count it
  is recorded, which cuts the AWE divisor instead (HL10). (Corrected 2 Oct
  2026 while building: this summary still had the earlier call, "only by
  the part beyond one week", which decision 14 replaced on 1 Oct 2026.)
- **15** No hard limit on holidays in advance; a warning above what's been
  earned, and a prompt for the written agreement (HL14).
- **16** Advance leave worth more than the 8% is deducted only with written
  consent attached (HL15).
- **17** The 8% on leaving includes the s40(3) public holidays (HL16).
- **18** Those holidays paid at each holiday's weekday RDP at the last pay
  rate, or ADP (HL16).
- **19** Part-day sick leave takes a whole day unless a part-day agreement
  is recorded (HL23).
- **20** "Month" in the hours test means calendar month (HL21).
- **21** Otherwise a working day: Tohyee suggests, the person running pay
  confirms, and it's recorded (HL30).
- **22** Public holiday dates as dated data; anniversary day per employee,
  defaulting from the organisation (HL31).
- **23** Working part of a public holiday: time and a half for the time
  worked and an alternative holiday, nothing automatic for the rest (HL32).
- **24** Exchanging an alternative holiday defaults to RDP (or ADP) on the
  exchange date, editable, with the agreement recorded (HL33).
- **25** Alternative holidays counted in days, with that day's hours stored
  (HL33).
- **26** Exact rates; each payment rounded once to cents.
- **27** Family violence leave included with sick leave, records kept
  private (HL27).
- **28** Leave liability and the running 8% shown as a report; posting to
  the ledger waits for its own example (HL42). (Since 2 Oct 2026 posted:
  decision 177, HL52-HL56.)
- **29** Cash-ups need the written request and answer attached, and the
  one-week limit is enforced (HL12).

### Built, and refused rather than guessed (leave build)

Each refusal says "Not supported yet (refused rather than guessed)" and
what it is. As well as the list above:

- leave for anyone whose first sick or annual entitlement arose before
  Tohyee's first pay run for them, or who was paid P3's typed holiday pay,
  and any calculation needing earnings from before Tohyee, **unless they
  have opening balances** (decision 143; since 2 Oct 2026 decision 168,
  HL43-HL48, built); their holiday pay on finishing stays typed;
- with opening balances: casual employees, an opening date inside a pay
  period, gaps or overlaps in the earnings rows, typed holiday pay after
  the opening date, ADP over a row only partly inside the 52 weeks, and
  leave needing earnings from before the first row (HL48);
- deducting advance holiday pay worth more than the 8% (HL15, decision 150);
- back pay for a pay period with leave or holiday pay in it (decision 152);
- paying annual holidays before they're taken, without the s 27(1)(a)
  agreement (decision 157);
- leave settings that change part way through a pay period (decision 142);
- relevant daily pay for a public holiday for someone whose hours vary
  (use ADP), and the s 40(3) public holidays for someone whose hours vary;
- public holidays in years Tohyee has no dates for (2028 on, decision 162);
- employees booking their own leave (decision 164): **built on 2 Oct 2026
  as leave requests** (decision 169, HL49-HL51), approved by their
  approver or payroll access;
- posting the leave liability to the ledger: designed (decision 177,
  HL52-HL54) and **built on 2 Oct 2026** (decisions 182-187, HL52-HL56).

### Decided (leave build)

Jess asked Claude to "look up what you need to and make the calls
yourself" (2 Oct 2026). Each call, with its sources, is a decision in
`docs/DECISIONS.md` ("The leave build's questions, decided"). What was
asked is kept under each.

1. **Opening balances: yes, built** (decision 168; examples HL43-HL48).
   Asked: "Tohyee keeps leave only from its own pay runs, so anyone
   employed before an organisation started payroll in Tohyee is refused
   (decision 143). Most organisations will need opening balances (annual
   weeks and the date last entitled, sick days, alternative holidays) and
   the earlier 12 months' gross earnings and days worked. Shall we write
   worked examples for them next?"
2. **Employees' own leave requests: yes, like P9's timesheets** (decision
   169; examples HL49-HL51). Asked: "Employees' own leave requests (like
   P9's timesheets: hours only, approved by a manager)? Decision 164 left
   them out."
3. **Advance holiday pay over the 8%: still refused**, because IRD's tax
   treatment of the recovery couldn't be confirmed (decision 170). Asked:
   "Advance holiday pay over the 8% on leaving (HL15): with written
   consent, take it off gross pay (as Xero) or as an after-tax deduction?"
4. **Back pay over periods with leave: still refused**; the law doesn't
   say whether a backdated rise changes holiday pay already paid
   (decision 171). Asked: "Back pay over periods with leave (XP question
   5): pay the leave difference at the new rate, or keep refusing?"
5. **Paying annual holidays before they're taken: not built**; the s 27(1)
   agreement is recorded instead (decision 172). Asked: "Paying annual
   holidays before they're taken (s 27(1)): needed, or will every employee
   agree to be paid in the usual pay (decision 157)?"
6. **"Otherwise a working day" from 2 of the last 4 weeks: kept as a
   suggestion only**, with Employment NZ's other factors shown beside it
   (decision 173). Asked: "Suggesting 'otherwise a working day' from 2 of
   the last 4 weeks (decision 146): right?"
7. **Hours beyond the usual day on a public holiday: as built** (decision
   174). Asked: "Hours worked on a public holiday beyond the usual day at
   the ordinary rate, time and a half (decision 140): right?"
8. **The usual pay from the usual week: as built** (decision 175). Asked:
   "The usual pay from the usual week replaces P3's Ordinary time for
   people with a fixed week, and gives leavers their usual hours to the
   finish date (decision 148). Agreed?"
9. **Redundancy isn't gross earnings: as built** (decision 176). Asked:
   "Redundancy isn't gross earnings for holiday pay, following Employment
   NZ's view (decision 139). Agreed?"
10. **Posting the liability: yes, designed, built next** (decision 177;
    examples HL52-HL54; built 2 Oct 2026 with decisions 182-187 and
    HL55-HL56). Asked: "The liability report values alternative
    holidays at a usual day's OWP (decision 153); posting the liability
    still waits for its own example (decision 28). Want posting next?"
11. **The anniversary day must be chosen: as built** (decision 178).
    Asked: "Anniversary day must be chosen for the organisation (or the
    employee) before public holidays are paid. Fine?"
12. **2028's public holidays: not added until Employment NZ publishes
    them** (decision 179). Asked: "2028's public holidays aren't published
    yet; they'll need adding before pay periods in 2028 (the Holidays Act
    runs to 6 Aug 2028)."
13. **Aroha's anniversary day is Wellington's** (Mon 25 Jan 2027; decision
    180; HL13 says so). Asked: "Aroha's anniversary day in HL13: which
    region? Otago's (Mon 22 Mar 2027) falls in her booking."
14. **Cash-ups at the rate on the date agreed: as built** (decision 181).
    Asked: "Cash-ups at the rate on the date agreed (HL12, decision 158),
    not the date paid: right?"


### Questions for Jess (posting the leave liability), decided

Jess asked for open questions to be decided by law, then NetSuite, then
Xero (decisions 188-191 in `docs/DECISIONS.md`). What was asked is kept
under each.

1. **Sick leave carried over: kept out** (decision 188; PBE IPSAS 39 para
   17). Asked: "Add a typed estimate per organisation, or keep it out?"
2. **Finished, final pay not yet paid: kept in the report until the final
   pay's pay date** (decision 189; HL53, HL57, HL58). Asked: "Keep finished
   employees in the report until their final pay is approved, or accept
   the cut-off?"
3. **Employer KiwiSaver on the leave: added** (decision 190; HL59, HL60).
   Asked: "The employer KiwiSaver contribution that will be paid on the
   leave isn't in the liability. Add it?"
4. **Month-end reminder: yes, on the home page** (decision 191; HL61).
   Asked: "Should Tohyee remind (or offer) a posting at each month end or
   on Period close?"

## Analytics: Tohyee's own books and CRM (examples AB1-AB10, approved with Jess's answers 3 Oct 2026)

Step 2 of [ANALYTICS-REVIEW.md](ANALYTICS-REVIEW.md) (decision 359): a fixed,
documented set of tables copied from the organisation's own database into its
analytics file, so dashboards can show the books beside CSV data. Nothing is
posted or changed.

Jess's answers (3 Oct 2026): the data comes from the organisation's own
database and must be **the same data** (every row and amount as it is
there); the analytics figures don't have to be made to match report totals.
Whether a figure shows as positive or negative is decided by the dashboard
tile and the dataset, not built into the copy. Pay run lines are copied
without employee names.

**Rules:**

- The copy is taken in one read-only transaction, so every table is from the
  same moment. It's refreshed nightly with the CSV sources (after 04:00) and
  by "Refresh now"; between refreshes the tables don't change, and the Data
  sources page shows when they were copied.
- Table names start with `tohyee_` and stay the same between versions (new
  columns can be added; none are renamed or removed). CSV sources can't use
  the `tohyee_` prefix.
- Money is exact (`DECIMAL(18,2)`), in the organisation's currency (foreign
  documents at their base amounts, as the ledger has them), with the
  document's own currency and amount alongside.
- **`tohyee_ledger_lines`**: one row per posted journal line, with the
  posting date, journal number, source (invoice, bill, bank, manual journal
  and so on), account code, name, class and type, contact, description,
  tracking (one column per tracking category), debit, credit and `amount`
  (debit - credit). Lines of pay run journals have no contact and the
  description "Pay run" (no employee names).
- **`tohyee_invoices`, `tohyee_invoice_lines`, `tohyee_bills`,
  `tohyee_bill_lines`**: approved and voided documents (never drafts), with
  status, dates, contact, net, GST and total, and each line's item, account,
  tax code and tracking.
- **`tohyee_contacts`** (with address, region and custom fields as columns)
  and **`tohyee_items`**.
- With the CRM on: **`tohyee_crm_companies`**, **`tohyee_crm_opportunities`**
  (stage, amount, expected close, owner, won/lost) and
  **`tohyee_crm_activities`**.
- A dashboard value can be shown **the other way round** (each amount
  negated), so credits such as sales can show as positive.

Setup: the journals under "Custom reports" (CR1): owner funds 5,000.00 on
1 Mar 2026; sales of 500.00 (20 Mar), 1,000.00 (10 Apr), 1,500.00 (12 May)
and 1,200.00 (8 Jun); accounting fees 100.00 (15 Apr) and 250.00 (20 Jun);
cost of goods sold 400.00 (13 May) and 300.00 (9 Jun); interest 20.00
(30 Jun). All through 1000 Business bank account.

- **AB1** After a refresh, `tohyee_ledger_lines` has **20** rows (10
  journals, 2 lines each), each with the same date, account, debit and
  credit as in the ledger, and the sum of `amount` is **0.00**.
- **AB2** The 4000 Sales lines for June 2026 sum to `amount` **-1,200.00**
  (a credit); shown the other way round, **1,200.00**.
- **AB3** Lines for 5000 Cost of goods sold in June sum to **300.00**.
- **AB4** 4000 Sales by month, the other way round: Mar 2026 **500.00**, Apr
  **1,000.00**, May **1,500.00**, Jun **1,200.00**.
- **AB5** Lines for 1000 Business bank account up to 30 Jun 2026 sum to
  **8,170.00**.
- **AB6** Invoice I1 (2 x 50.00 at 15% exclusive): `tohyee_invoices` has net
  **100.00**, GST **15.00**, total **115.00**, status approved. A draft
  invoice isn't copied. A voided invoice is copied with status voided and
  its void date; its ledger lines (the posting and the reversal) are both in
  `tohyee_ledger_lines`, so they net to 0.00.
- **AB7** A zero-rated USD invoice for USD 100.00 at **1.60** (as in the
  foreign-currency examples, MC): net in the organisation's currency
  **160.00**, with currency **USD** and amount **100.00** alongside.
- **AB8** Posting a new sales journal of 300.00 on 1 Jul 2026 doesn't change
  the copied tables until the next refresh; after it, the July 4000 Sales
  lines sum to **-300.00**.
- **AB9** With the CRM off, no CRM tables are copied (and any from before
  are removed). With it on, an opportunity of 5,000.00 in stage Proposal is
  copied with its stage, amount and expected close date.
- **AB10** A pay run's wages journal is copied as lines on the wages and
  bank (or wages payable) accounts with no contact and the description
  "Pay run".

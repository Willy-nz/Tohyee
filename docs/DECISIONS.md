# Decisions (1 October 2026)

Jess asked Claude to research the open questions on payroll rates, payroll
access, Holidays Act leave and the R&D Tax Incentive and "make the call
yourself", building leave "with the new rules in mind" (1 Oct 2026). These are
those calls, with the source for each. The law always wins over this file: if
an official source says otherwise, change the decision, the example and the
test together.

Marked **(unverified)**: the official text couldn't be read
(legislation.govt.nz returned 403 to our tools), so the decision rests on
IRD, MBIE or Employment NZ guidance, or is a design choice. Check these
before relying on them.

On 1 Oct 2026 the official texts were read in Jess's Chrome and the
relevant parts saved under `docs/sources/` (Holidays Act 2003, Employment
Leave Act 2026, Income Tax Act 2007 subpart LY, schedule 21B and schedule 1
part D, Wages Protection Act 1983 s 5, IR1240 April 2026, and the banks'
direct credit file formats). Points checked are marked "(checked against
<source> on 1 Oct 2026)". Where the text says something different from a
decision, the decision is left as it was and a **Conflict found:** note
says what the text says.

## The new leave law

- The **Employment Leave Act 2026** (2026/48, Royal assent 6 Aug 2026)
  replaces the Holidays Act 2003 from **6 Aug 2028**, for each employee from
  their first pay period starting on or after that date. Employers must follow
  the Holidays Act until then and **can't follow the new law early**. Leave
  under the new Act builds up in hours on standard hours, with a 12.5% leave
  compensation payment on additional and casual hours and one hourly leave
  rate. Until Aug 2029, where agreements aren't updated the employee gets
  whichever entitlement is more favourable. Sources:
  [MBIE](https://www.mbie.govt.nz/business-and-employment/employment-and-skills/employment-legislation-reviews/holidays-act-reform-employment-leave-act),
  [Employment NZ](https://www.employment.govt.nz/news-and-updates/employment-leave-act-2026),
  [guidance for payroll software](https://www.employment.govt.nz/leave-and-holidays/changes-to-leave-coming-in-2028/how-payroll-software-providers-can-get-ready-for-the-changes-coming-in-2028).
  Details of the final Act **(checked against the Employment Leave Act 2026
  as enacted, `docs/sources/employment-leave-act-2026.md`, on 1 Oct 2026)**:
  in force 6 Aug 2028 (s 2(1)), repealing the Holidays Act (s 150); an
  existing employer needn't comply for an employee until "the start of the
  employee's first pay period that starts on or after the commencement date"
  (sch 1 cl 6); annual leave accrues at "not less than 0.0769 of an hour ...
  for each standard hour or part of a standard hour" (s 24(1)); sick leave at
  "not less than 0.0385 of an hour" (s 73(1)), to "a maximum of 160 hours"
  (s 75(1)); the leave compensation payment (LCP) is "not less than 12.5% of
  the employee's ordinary hourly rate for each relevant hour" (s 126(1));
  previous annual holidays and sick leave are converted to hours on the
  commencement date by formula (sch 1 cl 11-12, 17-18: weeks × ordinary
  weekly hours, days × ordinary daily hours, with pro-rated "type B"
  amounts and 93-day averages); family violence leave is 10 days a year
  from the start date, not carried forward (s 103, s 108). The "more
  favourable agreement" rule runs from 6 Aug 2028 to the day before
  6 Aug 2029 and stops once the agreement is updated (sch 1 cl 8). MBIE's
  technical guidance is still due Nov 2026 to Jan 2027.

## Payroll rates (examples PR1-PR16)

1. **Rates are picked by pay date**, not pay period. IRD's IR340 (Aug 2024)
   applied the new rates to pay "paid on or after 31 July 2024".
2. **The 3.5% KiwiSaver employer minimum applies to every pay dated on or
   after 1 April 2026**, even if the pay period started before. IRD
   [KiwiSaver changes](https://www.ird.govt.nz/kiwisaver-changes); payroll
   specification 2026-27 sections 2.3 and 4.3.
3. **ESCT follows the specification**: the contribution in whole dollars,
   truncated (spec 5.10.1; IR341 Apr 2026).
4. **ESCT threshold amounts with cents stay refused**; enter whole dollars.
   IRD prints the bands in whole dollars. (Design choice. The Act's bands
   are also in whole dollars, "$0 – $18,720", "$18,721 – $64,200" and so on,
   applied to "the last dollar of the amount of the ESCT rate threshold
   amount"; the Act doesn't say how an amount with cents is treated:
   checked against Income Tax Act 2007 sch 1 part D cl 1, table 1, on
   1 Oct 2026.)
5. **IRD example figures that are still 2025-26 figures are tested against
   2025-26 only.**

## Payroll access (examples PE9-PE13)

6. **Only the organisation's first owner has payroll access to start with;**
   any other admin, owner included, needs it given. NetSuite has an
   "Administrator - No HR/Employee Access" role for the same reason.
   Moving someone below bookkeeper or removing them takes access away (PE13).
   Department totals in the profit and loss may show one person's pay where a
   department has one person: Jess is fine with that (1 Oct 2026).

## Holidays Act leave (examples HL1-HL42)

Approach: build for the **Holidays Act 2003** now, as one dated rule-set
that ends at each employee's first pay period on or after 6 Aug 2028, and
design it for the switch: every leave entry stores hours as well as days or
weeks, the rate source and its inputs, and any agreement; hours worked are
recorded per pay period so standard, additional and casual hours can be split
later; anniversary dates are kept. The Employment Leave Act is built as a
second rule-set only after MBIE's technical and balance-conversion guidance
is out, and never applies before 6 Aug 2028. Employment NZ guidance pages are
linked in each example. Section numbers are **(checked against the
Holidays Act 2003, version as at 20 Dec 2023, `docs/sources/holidays-act-2003.md`,
on 1 Oct 2026)**: OWP s 8; RDP s 9; ADP s 9A; AWE s 5 ("1/52 of an
employee's gross earnings") with s 14 (gross earnings) and s 21(2)(b)(ii);
otherwise working day s 12 (s 13 Labour Inspector); entitlement and unpaid
leave s 16; holidays in advance s 20 and s 22 (there is no s 20A);
termination s 23-s 26; cash-up s 28A-s 28F; public holidays on termination
s 40(2)-(3); public holiday not worked s 49, worked s 50 (s 51-s 54 are
about agreements); alternative holidays s 56, s 57, s 59-s 61 (s 58
repealed); sick and bereavement leave s 63-s 72; family violence leave
s 72A-s 72J (not s 72N); records s 81, s 82.

7. **Build for the 2003 Act now** (option a), designed for the switch as
   above.
8. **Entitlements in the Act's units (weeks for annual holidays, days for
   sick and bereavement), with hours stored on every entry.**
9. **Part weeks with unequal days: by hours** (weekly rate ÷ usual weekly
   hours × that day's hours). Design choice, as Xero does; it matches 2028.
10. **AWE over the 12 calendar months ending at the end of the last pay
    period** (the Act's wording), not the last 52 weeks. (Checked against
    Holidays Act s 21(2)(b)(ii), "the 12 months immediately before the end
    of the last pay period before the annual holiday", and s 5, on
    1 Oct 2026.)
11. **"Regular" items in OWP are marked on the usual pay template** and can be
    changed in a pay run (as Xero).
12. **The four-week OWP figure is always worked out and shown**, but used
    only when OWP can't be worked out. (Checked against Holidays Act s 8(2),
    "If it is not possible to determine an employee's ordinary weekly pay
    under subsection (1)", on 1 Oct 2026.)
13. **RDP or ADP is set per employee, with the reason for ADP recorded**, and
    can be changed in a pay run. ADP may be used only where RDP isn't
    practicable or daily pay varies. (Checked against Holidays Act s 9A(1):
    "not possible or practicable to determine ... relevant daily pay" or
    "daily pay varies within the pay period when the holiday or leave
    falls", on 1 Oct 2026.)
14. **Unpaid leave: a single period of unpaid leave longer than one week
    doesn't count towards the 12 months at all**, so the anniversary moves by
    the whole period, unless the employer and employee agree in writing that
    it counts (Holidays Act s 16(2)(a)(vi) and (b): unpaid leave "for a
    period of no more than 1 week" counts; "unless otherwise agreed, does not
    include any other unpaid leave"). Where it's agreed to count, the
    anniversary doesn't move and the AWE divisor is reduced by the weeks over
    one week (s 16(3)); without a recorded agreement the divisor isn't
    reduced (not as Xero does). Changed 1 Oct 2026 after reading the Act: the
    earlier call (move only by the part beyond a week) didn't match its
    wording. Source: `docs/sources/holidays-act-2003.md`. HL10 follows this.
15. **No hard limit on holidays in advance**; a warning above what's been
    earned since the anniversary, and a prompt for the written agreement to
    recover it. (Checked against Holidays Act s 20, "An employer may allow
    an employee to take an agreed portion of the employee's annual holidays
    entitlement in advance", on 1 Oct 2026: no limit in the Act.)
16. **Advance leave worth more than the 8% on leaving is deducted only with
    the written consent attached**; otherwise refused (Wages Protection Act
    1983 s 5(1), checked against the Act, version as at 27 Nov 2025, on
    1 Oct 2026: deductions "for a lawful purpose ... (a) with the written
    consent of the worker (including consent in a general deductions clause
    in the worker's employment agreement); or (b) on the written request of
    the worker"). Note from the Act: consent in a general deductions clause
    counts, but s 5(1A) requires "first consulting the worker" before a
    specific deduction under it, s 5(2) lets the worker withdraw consent in
    writing, and s 5A forbids a deduction that "is unreasonable".
17. **The 8% on leaving includes the s40(3) public holidays** (Employment NZ:
    gross earnings include "the payment for the public holiday"). (Checked
    against Holidays Act s 14(a)(iii), s 25(2), s 26 and s 40(2)-(3) on
    1 Oct 2026. s 40(3) applies only where the employee "is entitled to
    annual holidays" and hasn't taken them all (s 40(2)), i.e. alongside
    s 24, as in HL16.)
18. **Those public holidays are paid at each holiday's weekday RDP at the last
    pay rate**, or ADP under decision 13. (s 40(3) says only that the
    employee "is entitled to be paid for a public holiday"; RDP/ADP is s 49.
    Checked on 1 Oct 2026; the "last pay rate" part is a design choice.)
19. **Part-day sick leave takes a whole day by default**; a part day only
    where an agreement is recorded for that employee.
20. **"Month" in the hours test means calendar months.** (Holidays Act
    s 63(1)(b)(ii) and s 72D(1)(b)(ii) say "no less than 40 hours in every
    month"; the Act doesn't define month. Checked 1 Oct 2026; the Legislation
    Act's definition wasn't read.)
21. **Otherwise a working day: Tohyee suggests from recent weeks and the
    person running pay confirms**, and the decision is recorded. (Checked
    against Holidays Act s 12 on 1 Oct 2026. Note from the Act: s 12(2) has
    "the employer and employee" weigh the s 12(3) factors "with a view to
    reaching agreement", and a Labour Inspector decides if they can't
    (s 13); s 12(4): any amount of time on a public holiday makes it an
    otherwise working day.)
22. **Public holiday dates are dated data with sources; anniversary day is set
    per employee, defaulting from the organisation** (if not agreed, the
    province where they usually work).
23. **Working part of a public holiday: time and a half for the time worked
    plus an alternative holiday; nothing automatic for the rest of the day.**
    (Checked against Holidays Act s 49, s 50(1) and s 56(1)-(2) on
    1 Oct 2026: s 49 pays RDP only "If an employee does not work on a public
    holiday".)
    A typed extra is allowed where an agreement gives one.
24. **Exchanging an alternative holiday defaults to RDP (or ADP) on the
    exchange date, editable, with the agreement recorded.** (Checked against
    Holidays Act s 61 on 1 Oct 2026: the request "may be made only if 12
    months have passed since the employee's entitlement to the alternative
    holiday arose" and the employer pays "the amount agreed"; HL33 already
    applies the 12 months.)
25. **Alternative holidays are counted in days, with that day's hours
    stored.** (s 57(1)(c): "a whole working day off work ... regardless of
    the amount of time the employee actually worked on the public holiday";
    checked 1 Oct 2026.)
26. **Exact rates; each payment rounded once to cents.** Under the
    Employment Leave Act 2026 (from 6 Aug 2028) leave accrues at "not less
    than" 0.0769 hour of annual leave (s 24(1)) and 0.0385 hour of sick
    leave (s 73(1)) per standard hour; the Act has no rounding rule and its
    own example keeps five decimals (2.88375), so accrued hours will be kept
    to at least five decimals and never rounded down. (Corrected 1 Oct 2026:
    an earlier note said "rounds up", which isn't in the Act. Source:
    `docs/sources/employment-leave-act-2026.md`.)
27. **Family violence leave is included with sick leave**, with its records
    kept private. (Checked against Holidays Act s 72C, s 72D, s 72H, s 72I on
    1 Oct 2026: its own 10 days a year, not carried forward, paid at RDP or
    ADP; HL27 keeps it as a separate balance.)
28. **Leave liability is shown as a report with the running 8% now**; posting
    it to the ledger waits for its own approved worked example.
29. **Cash-ups need the written request and the written answer attached**;
    record the amount, the portion and the date, and enforce the one-week
    limit. (Checked against Holidays Act s 28A(2)-(3), s 28B and s 81(2)(ha),
    (hb) on 1 Oct 2026: request "must be in writing", "a maximum of 1 week
    ... in each entitlement year", the employer must "advise the employee in
    writing", paid "in accordance with section 21(2)".)

## R&D Tax Incentive (examples RD1-RD27)

Rule for every choice: never overstate a claim. Sources: IRD
[IR1240](https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir1200---ir1299/ir1240/ir1240.pdf)
(April 2026; the pages cited here re-read on 1 Oct 2026, see
`docs/sources/ir1240-pages-49-on.md`),
[eligible expenditure](https://www.ird.govt.nz/research-and-development/tax-incentive/eligibility/eligible-expenditure),
[due dates](https://www.ird.govt.nz/research-and-development/tax-incentive/research-and-development-tax-incentive-due-dates).
The Income Tax Act subpart LY text is **(checked against the Income Tax Act
2007, version as at 4 Sep 2026, `docs/sources/income-tax-act-ly-and-esct.md`,
on 1 Oct 2026)**: the credit is "0.15 × total eligible R & D expenditure"
(LY 4(2)), capped at $120 million (LY 4(3)).

30. **Exactly $50,000 qualifies** (IR1240 p 13 "$50,000 or more"; IRD's page
    "at least"). (Checked against LY 4(1)(a), "is $50,000 or more for the
    year", on 1 Oct 2026. IR1240 p 17 "more than $50,000" and p 72 "must
    exceed $50,000" differ from the Act; the Act governs.)
31. **The minimum is tested after the 10% overseas limit** (IR1240 p 14: the
    excess isn't eligible). (Checked against LY 4(1)(a), LY 5(2)(b) and
    LY 7(2), (5) on 1 Oct 2026: foreign expenditure is eligible only "to the
    extent the amount is less than or equal to the lesser of" the actual
    amount and "0.1 × total NZ R & D expenditure ÷ 0.9", and LY 4(1)(a)
    tests eligible expenditure.)
32. **The overseas limit and the credit are rounded down to the cent.**
33. **Tax depreciation, entered per asset for the year and split by its usage
    log; Investment Boost counts as depreciation** (Budget Measures Bill
    (No 2) commentary; checked against the Act on 1 Oct 2026: schedule 21B
    part A cl 1 makes eligible "Depreciation loss and amounts deductible
    under section DI 5 for an item of depreciable property to the extent to
    which the depreciable property is used in performing a research and
    development activity"; DI 5 is the "New investment asset deduction").
    Never book depreciation.
34. **A default % split counts only when it's 100% R&D** (full-time R&D
    staff). Any other default split is listed as "default split, no time
    record" and left out of the total.
35. **Leave and training are spread over the year** (IR1240's Zach example,
    p 64, checked 1 Oct 2026).
36. **Employee costs are only those IRD lists** (pay, bonuses, share schemes,
    recruitment, relocation, overtime, holiday and long-service pay,
    superannuation including employer KiwiSaver). ACC levies, FBT and other
    employer costs are left out. (IR1240 p 63 list checked 1 Oct 2026.)
37. **Only the posted pay run's tags count.** A late timesheet shows under
    "entered late"; changing it is a reallocation with history.
38. **Records entered more than 14 days after the work are flagged.**
39. **One supporting activity may support several core activities**; each
    cost line is still tagged to one activity.
40. **The approval reference is stored with the approval letter attached
    (required), marked "not checked with IRD".**
41. **Goods not used by year end are ineligible for that year**; the report
    lists them to be tagged in the year they're used.
42. **Foreign currency at the bill's rate; realised exchange gains and losses
    are left out.**
43. **Overseas spending stays in the category it was spent in, with an "of
    which overseas" line**; any limit reduction is spread in proportion.
44. **Core % to two decimals, rounded down.**
45. **Files on R&D records are kept 7 years after the year** (IR1240 p 17,
    p 101: "keep records for 7 years after the end of the tax year they
    relate to", checked 1 Oct 2026); they can be
    replaced (history kept) but not deleted.
46. **One "% of an account" overhead rule, with a required basis from IR1240's
    list** (time, floor area, usage, volume, unit sales, dollar value,
    activity-based costing) and the calculation attached. (List checked
    against IR1240 p 15 on 1 Oct 2026.)
47. **Tagging is allowed without an approval, with a warning**; the claim
    report gives credit only for activities with an approval covering the
    year.
48. **Deadline reminders from 60 days before, to owners and admins.**
49. **Only the no-agent due dates are shown, with a note** that an agent or
    extension makes them later.
50. **Payroll split for R&D: each R&D share rounded down to the cent, the
    remainder to non-R&D.**

## Shopify and other sales platforms (examples SPC1-SPC10 and later)

Answered 1 Oct 2026 ("do what a normal / big ERP would do"), with the
connection details checked against Shopify's docs.

51. **How a store connects: both kinds of app are supported.** Since
    1 January 2026 stores can't create new custom apps in the Shopify admin
    (those gave a fixed Admin API access token). New apps are made in
    Shopify's Dev Dashboard and connect with a client ID and secret,
    exchanged for an Admin API token with the client credentials grant
    (`POST https://{shop}.myshopify.com/admin/oauth/access_token`, tokens
    last 24 hours, so Tohyee refreshes them). That grant only works for an
    app and store owned by the same Shopify organisation. Tohyee accepts an
    existing admin-app token or a Dev Dashboard client ID and secret.
    Connecting stores owned by someone else (a bookkeeper connecting a
    client's store) needs Shopify's authorization code grant: a later stage.
    Sources: [client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant),
    [Shopify dev forum](https://community.shopify.dev/t/how-to-get-admin-api-tokens-using-apps-in-dev-dashboard/29472).
52. **Orders reach the accounts per order, ERP style** (as NetSuite's
    Shopify connectors do): each Shopify order becomes a sales order; a paid
    order is invoiced and its payment received into a "Shopify clearing"
    account; refunds become credit notes and refunds; each Shopify payout is
    a transfer from the clearing account to the bank, with Shopify's fees as
    an expense, so payouts match the bank feed.
53. **Tax comes from Shopify's own tax lines**, mapped to Tohyee tax codes,
    using Shopify's "taxes included" flag to work out GST-exclusive amounts.
    An organisation that isn't GST registered records no GST (the Glimmers
    store isn't GST registered). Untaxed products use a zero-rated or exempt
    code chosen in the connection's settings.
54. **Products with tracked inventory become stock items**; others become
    non-stock items. Stock levels come from Tohyee's own movements (invoices
    from Shopify orders move stock). Sending stock levels back to Shopify
    needs write access and is a later stage.
55. **A customer's country comes across** onto the contact. Overseas
    customers get the export tax code only when the organisation's existing
    "Foreign Trade" setting is on (examples EX3, EX4), so it's switched per
    organisation.

## CRM opportunity stages and forecasts (examples CRMS1-CRMS11)

Jess wants a Salesforce-level CRM (2 Oct 2026): follow Salesforce where it
has an answer, then Twenty or HubSpot. help.salesforce.com pages couldn't be
read by our tools (they load with script), so the Salesforce sources are
its Trailhead modules, one Salesforce knowledge article and a Salesforce Ben
guide, all fetched on 2 Oct 2026. Calls marked **(unverified)** rest on how
Salesforce is generally known to behave and should be checked against
Salesforce's own help before relying on them. HubSpot's knowledge base
refused our fetches, so nothing here rests on it.

76. **Stages are the organisation's own list**, each with a name, an order,
    a type (Open, Closed won, Closed lost), a default probability and a
    forecast category, as Salesforce's Stage picklist values: "Type ...
    Probability ... Forecast Category" are set for each stage
    ([Trailhead: Create and manage stages and sales processes](https://trailhead.salesforce.com/content/learn/projects/create-an-opportunity-record-type-for-npsp/create-and-manage-stages-and-sales-processes));
    the three types are Open, Closed/Won and Closed/Lost
    ([Salesforce Ben, updated 19 Oct 2023](https://www.salesforceben.com/complete-guide-tutorial-to-salesforce-opportunity-stages/)).
    Probabilities are whole per cents, as Salesforce's Probability (%) field.
77. **A stage has a fixed key** (Salesforce's picklist API name, separate
    from its label). The six existing stages keep their keys (`new` ...
    `lost`), so every saved opportunity, API call and history entry keeps
    working; a new stage's key is made from its first name.
78. **Starting probabilities** New 10%, Screening 20%, Meeting 50%,
    Proposal 75%, Won 100%, Lost 0%, every open stage in Pipeline: the
    probabilities of the Salesforce standard stages nearest in meaning
    (Prospecting 10%, Needs Analysis 20%, Value Proposition 50%,
    Proposal/Price Quote 75%, Closed Won 100%, Closed Lost 0%)
    **(unverified)**. Jess is asked to confirm them.
79. **Forecast category rules**: a Closed lost stage is Omitted ("Any stage
    with a Type of Closed/Lost must be set to Omitted",
    [Salesforce knowledge article 000232642](https://help.salesforce.com/s/articleView?id=000232642&language=en_US&type=1)),
    and 0%; a Closed won stage is Closed and 100%; an Open stage is never
    Closed (Closed is "the total for closed-won opportunities",
    [Salesforce for Beginners, O'Reilly](https://www.oreilly.com/library/view/salesforce-for-beginners/9781838986094/1d32a37d-da56-4684-9334-41b9044fba4c.xhtml)).
    The won-is-100% and open-never-Closed parts are **(unverified)**.
80. **An opportunity's probability and forecast category can be changed
    without changing its stage**, within rule 79: "Salesforce adds a
    probability based on the stage selected. If the probability isn't
    accurate, you can change it"
    ([Trailhead: Work your opportunities](https://trailhead.salesforce.com/content/learn/modules/leads_opportunities_lightning_experience/work-your-opportunities));
    "users can change the mapped category on an Opportunity without changing
    the stage" ([Salesforce Ben, updated 27 Dec 2023](https://www.salesforceben.com/forecast-categories-in-salesforce-everything-you-need-to-know/)).
    **Moving to another stage sets both to the new stage's defaults** unless
    they're sent in the same save, as Salesforce does when the stage changes
    **(unverified)**.
81. **Stages are archived, never deleted**, as Salesforce deactivates
    picklist values and record types here are archived (CRT2). An archived
    stage keeps its opportunities but can't be chosen. At least one active
    Open, Closed won and Closed lost stage must stay, so opportunities can
    always be opened, won and lost. **A stage's type can't change while
    opportunities are in it** (a design call: otherwise invoiced or
    forecast opportunities would silently change meaning).
82. **The invoice follows the stage type**: only an opportunity in a Closed
    won stage makes an invoice, whatever the stage is called, and "open"
    everywhere means a stage of type Open. The database enforces that an
    invoiced opportunity is in a Closed won stage.
83. **Stage history comes from the audit history**, not a new table: a row
    whenever the stage, amount, probability, forecast category or expected
    close date changes, with who and when, newest first, after
    Salesforce's Stage History related list (field list **(unverified)**).
    Changes made before the upgrade show without a probability or category,
    which weren't kept.
84. **Sales processes** belong to opportunity record types: "a filtered list
    of opportunity stages" ([Trailhead: Create and manage stages and sales processes](https://trailhead.salesforce.com/content/learn/projects/create-an-opportunity-record-type-for-npsp/create-and-manage-stages-and-sales-processes)).
    A type without one uses every active stage. A process needs at least one
    stage of each type. An opportunity already in a stage its process
    doesn't list can still be saved without moving.
85. **Forecast totals are Salesforce's cumulative rollups**: "the Best Case
    category includes all the best case opportunities, plus the
    opportunities in the Most Likely, Commit, and Closed categories"
    ([Trailhead: Configure Sales Forecasting](https://trailhead.salesforce.com/content/learn/modules/sales-forecasting/configure-sales-forecasting-in-salesforce));
    "Best Case – Best Case + Commit + Closed" and "Open Pipeline – Pipeline
    + Best Case + Commit" ([Salesforce Ben](https://www.salesforceben.com/forecast-categories-in-salesforce-everything-you-need-to-know/)).
    So Closed = Closed; Commit = Commit + Closed; Best case = Best case +
    Commit + Closed; Open pipeline = Pipeline + Best case + Commit. Omitted
    is in none. Salesforce's optional "Most Likely" category isn't offered.
86. **Forecasts are by expected close date, per month or per quarter, per
    owner**, as Salesforce's opportunity forecast by close date. Quarters
    follow the organisation's financial year (Salesforce uses the fiscal
    year). Opportunities without a close date are left out and counted;
    ones without an owner show as "No owner".
87. **Currencies are never added together** in a forecast: a row per
    currency, as Home and the pipeline (MC68, CRM10). Salesforce converts to
    one forecast currency; whether to do that is a question for Jess.
88. **Weighted amount = amount × probability, rounded half up to the
    currency's smallest unit for each opportunity, then added**, so the
    drill-down rows add up to the total. Weighted pipeline counts open
    opportunities not Omitted (Salesforce's expected revenue on the
    pipeline).
89. **Quotas are per owner per month in the base currency**, set by admins
    (Salesforce quotas are per user per forecast period); a quarter's quota
    is its months' added. Attainment is Closed in the base currency ÷ quota,
    as a percentage to 2 decimal places, rounded half up.
90. **Forecasts are read-only and worked out live**; Salesforce's manager
    adjustments, forecast hierarchy and submitted snapshots are a later
    stage (none of them would be a status typed in: they'd need the
    hierarchy built first).

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
  Details of the final Act's accrual rates, sick leave cap and balance
  conversion are **(unverified)**; MBIE's technical guidance is due
  Nov 2026 to Jan 2027.

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
   IRD prints the bands in whole dollars. (Design choice; the Act's band
   wording is unverified.)
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
linked in each example. Section numbers are **(unverified)** against the
official text.

7. **Build for the 2003 Act now** (option a), designed for the switch as
   above.
8. **Entitlements in the Act's units (weeks for annual holidays, days for
   sick and bereavement), with hours stored on every entry.**
9. **Part weeks with unequal days: by hours** (weekly rate ÷ usual weekly
   hours × that day's hours). Design choice, as Xero does; it matches 2028.
10. **AWE over the 12 calendar months ending at the end of the last pay
    period** (the Act's wording), not the last 52 weeks.
11. **"Regular" items in OWP are marked on the usual pay template** and can be
    changed in a pay run (as Xero).
12. **The four-week OWP figure is always worked out and shown**, but used
    only when OWP can't be worked out.
13. **RDP or ADP is set per employee, with the reason for ADP recorded**, and
    can be changed in a pay run. ADP may be used only where RDP isn't
    practicable or daily pay varies.
14. **Unpaid leave: the anniversary moves only by the unpaid leave beyond one
    week.** The AWE divisor is reduced only where an agreement to keep the
    anniversary is recorded (not as Xero does).
15. **No hard limit on holidays in advance**; a warning above what's been
    earned since the anniversary, and a prompt for the written agreement to
    recover it.
16. **Advance leave worth more than the 8% on leaving is deducted only with
    the written consent attached**; otherwise refused (Wages Protection Act
    1983, **unverified** section).
17. **The 8% on leaving includes the s40(3) public holidays** (Employment NZ:
    gross earnings include "the payment for the public holiday").
18. **Those public holidays are paid at each holiday's weekday RDP at the last
    pay rate**, or ADP under decision 13.
19. **Part-day sick leave takes a whole day by default**; a part day only
    where an agreement is recorded for that employee.
20. **"Month" in the hours test means calendar months.**
21. **Otherwise a working day: Tohyee suggests from recent weeks and the
    person running pay confirms**, and the decision is recorded.
22. **Public holiday dates are dated data with sources; anniversary day is set
    per employee, defaulting from the organisation** (if not agreed, the
    province where they usually work).
23. **Working part of a public holiday: time and a half for the time worked
    plus an alternative holiday; nothing automatic for the rest of the day.**
    A typed extra is allowed where an agreement gives one.
24. **Exchanging an alternative holiday defaults to RDP (or ADP) on the
    exchange date, editable, with the agreement recorded.**
25. **Alternative holidays are counted in days, with that day's hours
    stored.**
26. **Exact rates; each payment rounded once to cents.** (Under the 2028 Act,
    building up leave rounds up.)
27. **Family violence leave is included with sick leave**, with its records
    kept private.
28. **Leave liability is shown as a report with the running 8% now**; posting
    it to the ledger waits for its own approved worked example.
29. **Cash-ups need the written request and the written answer attached**;
    record the amount, the portion and the date, and enforce the one-week
    limit.

## R&D Tax Incentive (examples RD1-RD27)

Rule for every choice: never overstate a claim. Sources: IRD
[IR1240](https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir1200---ir1299/ir1240/ir1240.pdf)
(April 2026; pages after 49 not re-checked),
[eligible expenditure](https://www.ird.govt.nz/research-and-development/tax-incentive/eligibility/eligible-expenditure),
[due dates](https://www.ird.govt.nz/research-and-development/tax-incentive/research-and-development-tax-incentive-due-dates).
The Income Tax Act subpart LY text is **(unverified)**.

30. **Exactly $50,000 qualifies** (IR1240 p 13 "$50,000 or more"; IRD's page
    "at least").
31. **The minimum is tested after the 10% overseas limit** (IR1240 p 14: the
    excess isn't eligible).
32. **The overseas limit and the credit are rounded down to the cent.**
33. **Tax depreciation, entered per asset for the year and split by its usage
    log; Investment Boost counts as depreciation** (Budget Measures Bill
    (No 2) commentary, **unverified** against the Act). Never book
    depreciation.
34. **A default % split counts only when it's 100% R&D** (full-time R&D
    staff). Any other default split is listed as "default split, no time
    record" and left out of the total.
35. **Leave and training are spread over the year** (IR1240's Zach example).
36. **Employee costs are only those IRD lists** (pay, bonuses, share schemes,
    recruitment, relocation, overtime, holiday and long-service pay,
    superannuation including employer KiwiSaver). ACC levies, FBT and other
    employer costs are left out.
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
45. **Files on R&D records are kept 7 years after the year**; they can be
    replaced (history kept) but not deleted.
46. **One "% of an account" overhead rule, with a required basis from IR1240's
    list** (time, floor area, usage, volume, unit sales, dollar value,
    activity-based costing) and the calculation attached.
47. **Tagging is allowed without an approval, with a warning**; the claim
    report gives credit only for activities with an approval covering the
    year.
48. **Deadline reminders from 60 days before, to owners and admins.**
49. **Only the no-agent due dates are shown, with a note** that an agent or
    extension makes them later.
50. **Payroll split for R&D: each R&D share rounded down to the cent, the
    remainder to non-R&D.**

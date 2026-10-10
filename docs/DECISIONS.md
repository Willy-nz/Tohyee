# Decisions (1 October 2026; added to on 2 October 2026)

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

## Payday filing file (examples PF1-PF9)

Made by Claude on 2 Oct 2026 while building payroll stage P6, by the rule
law → IRD's specification → NetSuite → Xero. Source for the file:
IRD's *Payday Filing File Upload Specification* 2026-27 ("version 2027",
July 2026), summarised in `docs/sources/ird-payday-filing-file-spec.md`
with what couldn't be read. NetSuite has no New Zealand payroll, so it has
no answer on any of these. Xero Payroll NZ files employment information
"automatically every time a pay run is completed"
([Xero, Payday filing](https://www.xero.com/nz/accounting-software/payroll/payday-filing/),
read 2 Oct 2026); it files through IRD's gateway, not a file, so it
answers only decision 56.

56. **One employment information (EI) file per approved pay run.** IRD's
    spec: "Multiple EIs can be filed for the same paydate." Xero files each
    pay run as it's completed. Drafts and voided pay runs are refused.
57. **Amounts and hours in hundredths with no decimal point; CR LF after
    every line; UTF-8; names as typed.** The spec's attribute definitions
    (appendix 5.1) couldn't be read; its example file writes money as whole
    cents (`143257`) and "Hours paid" says "37.5 hours = 3750". No line
    terminator or character set was found, so Tohyee ends each line with
    CR LF (what Notepad saves, which IRD recommends) and keeps macrons.
    **(unverified)** until a file passes myIR's "Check your employment
    information file" service.
58. **What goes in each field** (all from the approved pay run's stored
    figures): gross earnings = taxable earnings (spec field 11: "taxable
    gross earnings ... Non-taxable allowances not included", so
    reimbursements and non-taxable allowances are left out); PAYE includes
    the ACC earners' levy (payroll spec 5.2, as in PRUN1); student
    loan, KiwiSaver deductions, net employer KiwiSaver contributions and
    ESCT as calculated. Fields for things Tohyee refuses (PRUN8) are 0:
    prior period adjustments, lump sum indicator, child support (code left
    blank), SLCIR, SLBOR, payroll donations, family tax credits and the
    Employee Share Scheme. **Earnings not liable for the ACC earners' levy
    are 0**: every taxable pay item is subject to the levy (PRUN10), and the
    field "excludes earnings over maximum liable threshold". (Since P12 the
    lump sum indicator and redundancy, which isn't liable for the levy, are
    filled in: decision 129.)
59. **Hours paid = the hours on the employee's earnings lines** (lines
    entered as hours × rate: ordinary time, overtime and so on); lines
    entered as an amount (a salary, allowances) add none, so salaried
    staff show 0, which the spec allows ("default 0 if not held").
60. **Employee name: the name kept on the approved pay run, "first last",
    with any comma replaced by a space** (the spec forbids embedded commas;
    an approved pay run can't be changed, so refusing would leave no way to
    file). **IRD number: the employee's current one**, 8 digits written with
    a leading 0 (as in the spec's example `074444444`). Tohyee doesn't run
    IRD's modulus 11 check (spec 5.8 wasn't read); myIR does.
    **Tax code as stored** (`M SL`, as in the spec's example).
61. **Start and finish dates only when they fall inside that employee's pay
    period** (spec fields 5 and 6). Since P12 a final pay's finish date is
    the one kept when the pay run was approved (decision 134).
62. **Header details are payroll settings**: the employer's IRD number and
    the payroll contact's name (up to 20 characters), work phone (up to 12
    letters and digits; spaces and punctuation dropped) and email (up to
    60, IRD's characters only), set by admins with payroll access under
    Payroll › Pay items. The employer's IRD number is its own setting, not
    the GST number, because not every employer is GST registered. Final
    return is always N (stopping employing is a myIR matter) and nil return
    is N (an approved pay run always has someone on it) and the PAYE intermediary is blank. Package
    identifier `Tohyee_Tohyee_v<version>` (the spec's "Vendor_Package_v1.0"
    shape, no employer information); IR form version `0001`.
63. **Due date: the pay date plus 2 working days, skipping Saturdays and
    Sundays but not public holidays** (spec 3.4 and IRD's "Payday filing"
    page: "within 2 working days of each payday"). Tohyee has no list of
    public holidays yet (as P4's IRD payment due dates), so the date it
    shows is never later than IRD's; the screen says public holidays aren't
    counted. The Tax Administration Act's definition of "working day" wasn't
    read **(unverified)**. (Replaced by decision 326 on 2 Oct 2026.)
64. **No employee details file yet.** The spec has one (HED2/DED/TED), but
    Tohyee's employee record has the address as one block of text (the file
    needs it split into street, suburb, city, post code and country), one
    phone number (the file needs mobile and daytime, each with a country
    code) and no KiwiSaver eligibility code, and how tax codes are written
    in TED records wasn't clear from what could be read (`TED,M` and
    `TED,SL` in the example). Refused rather than guessed: the payday filing
    card lists the employees who start in the pay period, so their details
    can be entered in myIR (question for Jess).
65. **Making a file posts nothing and records only an audit event**: the
    file name, the SHA-256 of the file and the number of employee lines,
    never amounts or IRD numbers. There's no "filed" tick (Tohyee can't
    know the upload worked); myIR is the record of what was filed.

## R&D claim report, stage R3 (examples RD28-RD42)

Made 2 Oct 2026 by Claude while building R3, on Jess's standing instruction
to decide by the law first, then NetSuite, then Xero (neither documents a New
Zealand RDTI feature: see "How NetSuite and Xero do it" in the R&D examples),
and never to overstate a claim. Sources read 1 Oct 2026: IRD's
[due dates](https://www.ird.govt.nz/research-and-development/tax-incentive/research-and-development-tax-incentive-due-dates)
page (updated 1 Apr 2026), IRD's
[eligible expenditure](https://www.ird.govt.nz/research-and-development/tax-incentive/eligibility/eligible-expenditure)
page (updated 28 Apr 2021), and the saved extracts of IR1240 and subpart LY
in `docs/sources/`.

66. **Pay items that count as employee costs**: ordinary time, overtime,
    allowances, holiday pay and the employer KiwiSaver contribution (gross,
    before ESCT, as the pay run posts it). Reimbursements and deductions
    don't. IR1240 p 63 and IRD's eligible expenditure page list "salaries
    and wages, bonuses, employee share schemes, employee recruitment and
    relation costs, overtime, holiday and long-service pay, superannuation
    contributions"; a reimbursement repays a cost the employee paid and
    isn't pay (RD28).
67. **A pay's R&D share comes from the allocation the pay run used**: the
    employee's latest allocation effective on the pay date that was entered
    before the pay run was approved. An allocation entered later, even if
    backdated, doesn't change a posted pay (decision 37: the posted pay
    run's tags count; RD31). Decision 34's 100% rule is applied per pay.
    A pay is flagged "entered late" when that allocation was entered more
    than 14 days after the pay period ended (decision 38; RD32); it still
    counts and is listed. Until timesheets (P9) exist this is the only time
    record, and the report says so.
68. **Overhead rules are applied when the report runs**, never posted or
    turned into tags. A line with its own tag keeps its tag and the rule
    skips it (a line is never counted twice). On any day an account's rules
    total at most 100%, with one rule per activity. Changing a rule adds a
    new rule linked to the old: from the same start date the old one is
    marked replaced; from a later date it ends the day before. The report
    shows the replaced rule's figure next to the new one and marks a change
    made after the rule's period began (RD23, RD35). Workings must be
    attached (decision 46; IR1240 p 15, p 102: "Be prepared to explain the
    basis ... and the calculation method").
69. **Supporting activity counts only in a year when a core activity it
    supports has an approval covering that year**; otherwise it's listed and
    left out (IR1240 p 38; LY 5(1)(ab)). Its costs in the income year
    immediately before the first income year of every core activity it
    supports move to that first year (RD4, RD37; LY 5(1)(ab)(i); IR1240
    p 118-119). Supporting activity in the year after (LY 5(1)(ab)(ii), by
    variation) isn't supported yet.
70. **The overseas limit is shared across the overseas amounts in proportion,
    rounded down, with the leftover cents to the largest remainders** (the
    earlier first on a tie), so the parts add up to exactly the limit
    (decision 43; RD36). The limit itself is still rounded down (decision 32).
71. **Feedstock and commercial production are listed and left out where
    Tohyee can't work out the eligible part**: feedstock-flagged tags
    (eligible only over the output's value, Sch 21B B cl 22; IR1240 p 81-82)
    and commercial production tags other than employee related costs
    (LY 5(1)(c): only an employee's contribution, or costs shown to be
    additional, count; IRD's eligible expenditure page). Commercial
    production tags on employee related costs count (RD39).
72. **Over the $120 million maximum, $120 million is claimed** (LY 4(3)) and
    the amount over it is shown; the figures by category aren't scaled down
    (RD40). The associates' shared maximum is only a reminder.
73. **Deadlines are worked out only for a 31 March balance date**: IRD's
    page gives 15 January (not the last day of the 3rd month) for a 30
    September balance date, so other balance dates need rules Tohyee
    doesn't have; it says so rather than guessing. A date on a weekend is
    shown with the next Monday ("considered on time if we receive your
    application on the next business day", IRD's due dates page); public
    holidays aren't checked (as in payroll's IRD due dates). Each date is
    worked from the unmoved date before it. Reminders (decision 48) cover
    general approval, the supplementary return and the material change
    variation; the other dates are listed only (RD41).
74. **An export keeps the report's summary figures, not the file**: who
    exported, when, the year, and the figures by project and category, the
    total, the overseas limit and the credit, in the R&D history, with no
    employee's pay, so no payroll detail ends up where every viewer can read
    it (decision 6). The report shows what changed since the last export.
    Nothing records a "filed" status (RD42).
75. **The claim report is for viewers and above**, like tagged costs; each
    employee's pay is shown only to people with payroll access, and others
    see employee related costs per activity and the "default split" total
    (decision 6 accepts a total that's one person's pay; RD33). Overhead
    rules are set by bookkeepers and above, like tags.

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

## Timesheets, payroll stage P9 (examples TS1-TS11)

Made 2 Oct 2026 by Claude while building P9, by the rule law → NetSuite →
Xero (decisions 76-90 are kept for the CRM branch). Sources: Holidays Act
2003 s 81(2)(c) ("the number of hours worked each day in a pay period and
the pay for those hours", `docs/sources/holidays-act-2003.md`); Employment
NZ's [Record-keeping](https://www.employment.govt.nz/starting-employment/rights-and-responsibilities/record-keeping)
page (last modified 6 Nov 2025, read 2 Oct 2026: "the days the employee
worked and the number of hours worked on those days", kept 6 years, and
employees can see them; the Employment Relations Act s 130 itself wasn't
read **(unverified)**); IR1240 p 64 and p 100 (`docs/sources/ir1240-pages-49-on.md`);
NetSuite's [Approving or Rejecting a Time Transaction](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N907404.html)
and [Weekly Timesheets](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4671374137.html);
Xero's [payroll timesheets](https://www.xero.com/nz/accounting-software/payroll/timesheet/)
page (all read 2 Oct 2026).

91. **Timesheets are their own record that names the same projects, not
    project time entries.** NetSuite has one time record for project
    billing and payroll, but Tohyee's project time follows Xero Projects
    (PJ3): it belongs to a member (a login), needs a task, can be changed
    until it's invoiced and keeps no history, while payroll needs hours per
    employee per day (s 81(2)(c)), for people without a login, against a
    Department or R&D activity as well, stamped and never overwritten (IR1240
    p 100). Changing project time's rules would change PJ1-PJ13. Xero keeps
    payroll timesheets apart from Projects time too. What's reused: the
    projects (and the Department and R&D activity lists) as rows, and "Fill
    from project time", which suggests a week's rows from the linked
    member's project time (TS2). Whether approved project hours should also
    become project time is a question for Jess.
92. **One timesheet per employee per week, Monday to Sunday.** NetSuite's
    weekly timesheets start on its "first day of week" preference; Tohyee
    has no such setting, so the ISO week (Monday) is used. A pay period
    uses each day of the weeks it overlaps (TS6).
93. **Hours are decimals to 2 places**, more than 0 and at most 24 an
    entry, and a day's rows at most 24 together, through
    `src/lib/money/decimal.ts`. A row is an R&D activity, a Department, a
    project, any combination of them, or "other work" (spread by the
    default allocation). The pay run's line quantity and IRD's "hours paid"
    are already hundredths of an hour (decision 57).
94. **The database stamps every entry** with who entered it and when
    (`entered_at` is set by PostgreSQL and can't be typed or changed). A
    change marks the old entry "replaced" and adds a new one; clearing a
    cell marks it "removed"; nothing is deleted. Entries are flagged
    "entered late" more than 14 days after the work (decision 38) and still
    count. IR1240 p 100: records "kept on a contemporaneous or timely
    basis" and apportionment "supported by an audit trail".
95. **Employees fill in their own timesheets without payroll access**,
    deliberately: an employee linked to a member's login (any role,
    viewers included) can enter and submit their own; people with payroll
    access can for anyone. Timesheets show hours only, never a rate or an
    amount, so no pay detail reaches someone without payroll access
    (decision 6). Employment NZ: employees can see their records. Linking
    a login and choosing the approver need payroll access.
96. **Who approves: the employee's timesheet approver, else the member
    linked to their reports-to manager, and anyone with payroll access;
    never their own.** NetSuite: "If no time approver is selected, then the
    employee's supervisor approves time entries". An approver needs the
    bookkeeper role or higher (approving changes where pay is charged).
    Approvers can't change hours: they reject with a reason (NetSuite:
    "Time approvers can't edit or delete existing time entries"; Xero lets
    them correct, a question for Jess).
97. **Draft → submitted → approved, rejected back to draft with a reason;
    an approved timesheet is reopened only by someone with payroll access,
    and never once a pay run that isn't voided has used it** (the database
    refuses it). Submitted and approved timesheets can't change. Approving
    posts nothing; its effect is on pay runs approved afterwards and the R&D
    claim. Every step is in the timesheet's history and the audit log.
98. **Pay runs split cost by approved timesheets for the days they cover,
    and by the default allocation for the rest** (TS5, TS6). The
    timesheets are the ones approved when the pay run is approved; covered
    days are the pay period's days in their weeks, by calendar day; the
    weights are c × hours × 100 per row and ((P − c) × H + c × other
    hours) × % per allocation line; amounts are split with PE3's
    largest-remainder rule. The pay run keeps the shares (source, hours,
    weight, tags, R&D activity) and the timesheets it used. PAYE, KiwiSaver,
    student loan and ESCT aren't touched. A Department, Class or Location
    the organisation requires on expense lines is still required, so a row
    without a Department in such an organisation stops the pay run with
    the reason.
99. **Approved timesheets give hourly employees their Ordinary time hours
    when every day of the pay period is covered** (TS8), when the draft is
    made. Xero: approved timesheets are "ready for your pay runs"; NetSuite's
    payroll adds approved time to paychecks. Only Ordinary time (overtime
    depends on the agreement, and leave is P8); salaried pay is never
    changed; a part-covered period uses the usual hours.
100. **For the R&D claim, timesheet hours are the time record.** A pay's
     R&D share from a timesheet is the cost × that activity's weight ÷ all
     weights, rounded down to the cent (decision 50), and counts whatever
     the %; the share from the default allocation for uncovered days still
     counts only when the allocation is 100% R&D (decision 34). The claim
     reads the shares the pay run kept, so a timesheet approved after the
     pay was posted doesn't change it (decision 37): it's listed by name
     for people with payroll access, as a count for others. Pay runs
     approved before this version keep R3's way (decision 67). The R3
     screen's "Timesheets aren't built yet" note is replaced.
101. **A pay run posting's percentage is kept to 4 decimal places** (it was
     2), since a timesheet's share of a pay (36 of 80 hours = 45%, but 6.5
     of 36.5 = 17.8082…%) is rarely a whole hundredth; the amounts are
     split from the exact weights, so the percentage is for display only.

## Payroll reports, payroll stage P10 (examples PREP1-PREP8)

Made 2 Oct 2026 by Claude while building P10, by the rule law → NetSuite →
Xero. No law prescribes payroll reports; IRD's rules fix what PAYE,
KiwiSaver and student loan are and that IRD periods go by pay date
(decisions 1, 58; PPAY4). NetSuite's payroll reports (read 2 Oct 2026):
[Payroll Summary](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N962618.html)
("the sum of paycheck amounts for each payroll item within the specified
date range ... grouped by payroll item type"),
[Payroll Summary by Employee](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N962835.html)
("does the gross-to-net calculation", "can group employees by department"),
[Payroll Liability](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N960606.html)
("total unpaid liability for each payroll item"),
[Payroll Journal](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N962405.html)
("the journal entries made for each paycheck") and the
[list of payroll reports](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_N959965.html),
which has no headcount or FTE report. Xero Central's payroll report pages
load with script and couldn't be read (**unverified**), so Xero answers
none of these.

102. **Reports read approved pay runs' stored figures, by pay date.**
     Each employee's totals, lines and postings as approving kept them, and
     the shares the pay run used (P3 allocation or P9 timesheets); nothing
     is recalculated from today's rates, allocations or timesheets. A date
     range means pay dates in it, as NetSuite's paycheck date range, IRD's
     periods (PPAY4) and the pay run's journal (dated the pay date).
     Drafts are left out; voided pay runs are left out and listed as
     "voided, not counted" (PREP1, PREP3).
103. **Labour cost is what pay runs charged for earnings and the employer
     KiwiSaver contribution, not reimbursements.** The postings (each
     employee's share of each debit line of the journal), with employer
     KiwiSaver gross (ESCT is part of it, as posted). A reimbursement repays
     a cost the employee paid (decision 66), so it's shown on its own line,
     and labour cost plus reimbursements equals the pay runs' employer cost
     and their journals' debits (PREP1). Question for Jess.
104. **Department, project and R&D activity come from the share each
     posting came from** (payroll_pay_run_shares, decision 98), so a
     timesheet's split shows as posted (PREP2). Pay runs approved before P9
     kept no shares: their Department is the posting's Department tag and
     their project the posting's project; their R&D activity is shown as
     "Not recorded (pay run approved before timesheets)" rather than
     re-derived (the R&D claim does that under decision 67; question for
     Jess).
105. **Payroll reports need payroll access and the bookkeeper role, with
     no other view.** Decision 6 lets everyone else see payroll only in the
     ledger, as totals by account, pay item and Department; it defines no
     payroll report for them, so none is added. Filters: labour cost takes
     Department, project, R&D activity, employee and pay item together; the
     payroll summary and the PAYE summary only employee (PAYE and net pay
     aren't split by Department); earnings history employee and pay item;
     headcount Department (people whose biggest allocation line on the date
     is that Department, or one under it) and employee.
106. **The reconciliation compares period movements, account by account,
     and lists the journals that explain the difference.** Payroll accounts
     are each pay item's account, the accounts approved pay runs posted to
     in the dates, and the PAYE, student loan, KiwiSaver, ESCT and wages
     payable accounts. The payroll figure is the counted pay runs' postings
     (expenses), their credits less IRD payments dated in the dates (IRD
     liabilities), their net pay less wage payments dated in the dates
     (wages payable) and their deductions (deduction accounts). The ledger
     figure is the account's movement over the same dates (debits less
     credits for expenses, credits less debits for liabilities, as the
     trial balance). Every journal on the account in the dates that isn't
     a counted pay run's or an active payment's is listed with where it came
     from (voided pay run or payment, manual journal, another document); any
     difference those don't cover is shown as "not explained". NetSuite's
     Payroll Journal and Liability reports give the pieces; it has no single
     reconciliation, so this is a design choice (PREP4).
107. **FTE = usual weekly hours ÷ a standard week, at most 1.** The
     standard week is 40.00 hours unless another (more than 0, at most 168,
     2 decimals) is entered on the report; it isn't stored (question for
     Jess). No NZ law defines FTE or a full-time week (the Minimum Wage
     Act's 40-hour default couldn't be read, **unverified**). FTE is
     rounded half up to 4 places, and totals add the rounded figures.
     Usual hours are the pay rate's ordinary hours in effect on the date
     (PE7); salaried employees have none, so they count as 1.0000, marked
     "assumed (salary)". Who's employed is from start and finish dates (an
     archived employee without a finish date is counted and flagged). By
     Department: FTE split by the allocation in effect on the date, and
     headcount to its biggest line (the first if two are equal, as the
     employee list's primary Department). By month: figures at the month's
     last day, starters and leavers in the month, and employees paid on
     approved pay runs in it (PREP5).
108. **PAYE, KiwiSaver and student loan by month tie to the employment
     information files and IRD payments.** Deducted = the counted pay runs'
     stored figures, which is what their EI files contain (decision 58), by
     the month of the pay date. Whether a file was made comes from the audit
     log ("payroll_payday_filing.made"); Tohyee can't know what was uploaded
     (decision 65), so it says "file made" or "no file made in Tohyee", and
     flags a voided pay run that had a file made (amend in myIR). Paid =
     active IRD payments for IRD periods in the month (both halves for a
     twice-monthly payer), KiwiSaver as one figure since IRD pays it as one
     (PREP7).
109. **An export is a CSV of what's shown, audited without figures**: one
     audit event "payroll_report.exported" with the report, dates, the
     filters' record ids, the row count and the file's SHA-256, never an
     amount or a name (as P6's file event, decision 65, and so no payroll
     detail reaches the audit log that admins without payroll access can
     read). Amounts are plain numbers with 2 decimals; CR LF line ends;
     cells starting with =, +, - or @ that aren't numbers are prefixed with
     an apostrophe so spreadsheets don't run them.
110. **Names are as kept on each pay run** (decision 60), so a renamed
     employee's history shows the name each payslip had; filters and
     headcount use today's name.
111. **A report covers at most 5 years** of pay dates, to keep it fast and
     its export a sensible size (a design choice).

## Workforce budgets, payroll stage P11 (examples WB1-WB7)

Made 2 Oct 2026 by Claude while building P11, by the rule law → NetSuite →
Xero. No law says how to budget wages; IRD's rules decide what employer
KiwiSaver and ESCT are (decisions 2-3). NetSuite Planning and Budgeting
"currently supports only the Financials module. A Workforce module is not
currently available"
([NetSuite Planning and Budgeting](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_8124016549.html),
read 2 Oct 2026), so NetSuite's answer is taken from Oracle's Planning
Workforce module, the platform NetSuite Planning and Budgeting is built on:
[Adding Hiring Requisitions](https://docs.oracle.com/en/cloud/saas/planning-budgeting-cloud/epbug/wf_adding_hiring_requisitions_100x94fdd820.html)
(number of requisitions, "FTE value for each", "Start Date and optionally
the End Date to set when the requisition's expenses are to be included in
expense calculations", "Salary Basis and Rate", "Merit Month") and
[Customizing the Mapping for Integration between Workforce and Financials](https://docs.oracle.com/en/cloud/saas/planning-budgeting-cloud/epbca/wf_fin_integration.html)
("the data maps push data to the correct accounts", mapped by entity), both
read 2 Oct 2026. Xero's budget manager has no workforce budgeting that we
know of; Xero Central couldn't be read (**unverified**).

112. **Follow Oracle Planning Workforce, as NetSuite has no workforce
     module of its own.** Employees and planned positions ("to be hired")
     are budgeted by month and pushed into the financial budget by account
     and Department (WB1, WB2).
113. **Workforce budgets write budget amounts, not a figure shown
     alongside.** Oracle pushes workforce expense into the financial plan's
     accounts, so budget vs actual, custom report budget columns and
     department budgets all see it without changes. The written amounts are
     marked with the workforce budget that owns them, can't be typed or
     quick filled (the app refuses, and a database trigger refuses any
     change to an owned amount unless the workforce budget's own rewrite is
     running), and are rewritten on every save of the workforce budget and
     on "Update budgets" (WB2, WB3).
114. **Lines by employee or position, in whole months.** Start and end
     months inside the workforce budget's 1-24 months; salary = annual
     salary × FTE ÷ 12 (FTE more than 0, at most 1, 4 decimals); hourly =
     rate × hours a week × 52 ÷ 12 (52 weeks, as IRD's annualising of a
     weekly pay). Part months count whole (question for Jess) (WB1, WB7).
115. **Rounding: once per line per month.** Wages rounded half up to the
     cent; employer KiwiSaver from that rounded figure, truncated to the
     cent like pay runs (spec 5.20.2, `kiwiSaverEmployerContribution`);
     each split with `splitByPercentages` (PE3) and every total adds the
     split parts, so Departments add up to the whole (WB1, WB2).
116. **An employee line copies the employee's pay when it's added**
     (the pay rate in effect on the first month's 1st, else their first
     rate; the employer KiwiSaver rate if enrolled, else 0); after that the
     line's own figures and its **pay rises from a month** (Oracle's merit
     month) are used. Later pay rates on the employee aren't followed
     (question for Jess) (WB1).
117. **Split: an employee by their cost allocation in effect on the 1st of
     each month** (PE6), read when figures are worked out; a position by
     its own % split (Department and optional project, totalling 100.00%).
     Because allocations change without the workforce budget being saved,
     the screen compares the fed amounts with today's figures and says
     "out of date"; this is worked out, never a stored status (WB3).
118. **Employer KiwiSaver is the line's employer rate; ESCT adds no cost.**
     ESCT is deducted from the employer's contribution (decision 3), so the
     gross contribution is the whole cost, as pay runs post it (decision
     103). No future minimum rate is assumed beyond IRD's rate files
     (question for Jess about 1 Apr 2028) (WB1).
119. **Accounts: the Ordinary time pay item's account for wages and the
     KiwiSaver employer contribution pay item's account for KiwiSaver**
     (the system pay items, PRUN10). Without an account on either, saving
     is refused (WB1).
120. **A workforce budget feeds the budgets chosen on it; a budget is fed
     by at most one.** A budget for a Department, Class or Location value
     gets the split parts tagged with that value or one under it; a budget
     without a value gets all; custom segment budgets and archived budgets
     are refused (payroll doesn't tag custom segments) (WB2, WB4).
121. **The workforce budget owns the wages and KiwiSaver accounts for all
     its months in each fed budget**, zeros included, so it's clear where
     every wages figure came from; a typed amount there is replaced (the
     budget's history shows before and after). Taking a budget off the list
     releases its amounts as they are (they become ordinary typed amounts)
     (WB2, WB4). A fed budget that's later archived is skipped, as
     archived budgets can't change.
122. **Workforce budgets need payroll access and the bookkeeper role**
     (decision 105); the fed amounts are ordinary budget amounts by
     account, month and tracking value, visible to whoever sees budgets
     (decision 6). Workforce budget audit events record no amounts and no
     names (as decision 109) (WB6).
123. **Budget vs actual for wages compares with P10's labour cost by
     Department and month of pay date** (decisions 102-104): earnings and
     employer KiwiSaver, not reimbursements; variance = actual less budget,
     as budgets (BU5) (WB5).

## Extra pays, back pay and final pays, payroll stage P12 (examples XP1-XP14)

Made 2 Oct 2026 by Claude while building P12, by the rule law → NetSuite →
Xero. The law here is IRD's: the *Payroll Calculations & Business Rules
Specification* 2026-27 sections 4.5.1, 5.11 (extra pay) and 5.12
(taxation when employment ends), the Employer's guide IR335 (September
2026, pages 37-42) and IRD's lump sum pages (quoted under "Extra pays,
back pay and final pays" in `docs/ACCOUNTING-EXAMPLES.md`). They were read
through a summarising fetch tool, not saved; the figures were asked for
one by one and IRD's own examples are the tests. NetSuite has no New
Zealand payroll, so it answers none of these; Xero Payroll NZ's help pages
load by script and couldn't be read (**unverified**).

124. **An extra pay is a line in the employee's pay run for the period**,
     not a pay run of its own. IRD lets either happen, but its student
     loan step works on "pay for pay period, including normal pay and
     extra pay" (spec 5.11.1 step 2), and Tohyee has one pay run per pay
     group and period (P3). A bonus paid on another day isn't possible yet
     (question for Jess).
125. **Four new pay item kinds**: Extra pay (bonuses, gratuities, lump
     sums), Back pay, Holiday pay on finishing (worked out outside Tohyee)
     and Redundancy, each with its own account, added by admins. The kind
     fixes the treatment: all are taxed; redundancy has no ACC earners'
     levy (step 4.1) and doesn't count for KiwiSaver (4.5.1; IR335 "Unless
     the lump sum payment is for redundancy"), the others count. Regular
     bonuses and commission aren't extra pays (IR335: "any regular payments
     are not lump sum payments") and stay allowances. The P3 typed
     "Holiday pay" item is unchanged (leave taken in the period).
126. **The four weeks are the pay dates from 27 days before the extra pay
     to its own pay date** ("the four weeks prior to, and inclusive of the
     day on which the extra pay is paid"), from approved pay runs and this
     one, the taxable earnings less any extra pays. A pay with no regular
     taxable pay isn't counted. Four weekly, two fortnightly, one
     four-weekly pay → × 13; one monthly pay → × 12; none → $0 (spec
     example 3). Any other pattern, or a pay of another frequency, is
     refused: IRD's "other circumstances" rule (all payments × 13) and its
     "only one pay period" sentence disagree for a short window (question
     for Jess).
127. **Tax on an extra pay follows the spec's steps exactly**: grossed-up
     = annualised (plus the low threshold for a secondary code) + the
     extra pay, cents dropped; the rate is the income tax bracket the
     grossed-up amount falls in (the rates file's brackets, which are
     IRD's extra pay table); extra pay × rate and the levy (steps 4.1-4.4,
     the rates file's levy rate and maximum) are added unrounded and the
     total truncated to cents (steps 5.1-5.2). **Conflict found:** IRD's
     printed example 1 truncates the tax and the levy separately
     ($10,366.39 instead of $10,366.40); the steps are followed and the
     test records the difference (XP1, question for Jess). The ordinary pay
     in the same pay is taxed as before; PAYE is the two added.
128. **Tax codes.** M and ME use 5.11.1 (ME gets no independent earner
     credit on the extra pay: the spec's extra pay steps have none);
     secondary codes use 5.11.2 with their low threshold, which is the
     start of the bracket at the code's rate (SB $0, S $15,601, SH $53,501,
     ST $78,101, SA $180,001, as IRD prints them, tested); ND and NSW use
     their usual flat rate on the extra pay (IRD's lump sum page; spec
     5.5 and 5.8: the flat rate "also applies to extra pays"), not
     flagged as lowest rate; CAE and EDW are refused (IRD says use the
     lump sum method, not with which threshold); STC stays refused.
129. **The lump sum indicator (EI field 14) is 1 when the extra pay's tax
     rate was the lowest bracket's rate** (spec 5.11.3), worked out and
     kept on the approved pay run per employee. **Field 13 (earnings not
     liable for the ACC earners' levy) is the redundancy in the pay**, the
     only taxed pay that isn't levied (step 4.1); earnings over the levy's
     maximum stay out of it, as the field says (decision 58).
130. **The end-of-employment rule applies when a final pay has Holiday pay
     on finishing or Redundancy**, and then to every extra pay in that pay
     (IRD: "calculate other lump sum payments together with the lump sum
     paid when an employee ends employment"). Its base is the last two
     approved pay runs for the employee whose period ended before this
     one's started and that paid regular taxable pay (Kelvin's unpaid week
     is skipped, spec 5.12 example 2), × 26, 13, 6.5 or 6. Fewer than two,
     or another frequency, is refused (the spec's one-period sentence gives
     no multiplier). An Extra pay or Back pay on a final pay without one of
     those items is refused (whether it "arises from the ending" decides
     the rule; question for Jess), and those two items on a pay that isn't
     the employee's final pay are refused.
131. **Redundancy with other extra pays** is calculated together; the
     levy is on the levy-liable part, and refused only when the levy's
     maximum falls between the annualised income and the grossed-up
     amount (which part uses the room under the maximum isn't said).
     Redundancy for ND and NSW is refused (their flat rate includes the
     levy).
132. **Student loan, KiwiSaver and ESCT on extra pays as on any pay**:
     student loan on the period's pay including extra pays and redundancy
     (5.11.1 step 2; IR335's Rama example); KiwiSaver deductions, employer
     contributions and ESCT on everything that counts for KiwiSaver, so
     not redundancy (4.5.1; IR335).
133. **Back pay is worked out from pay rate history** (P1b) for approved
     pay runs: choose a pay rate and a Back pay item; every approved pay
     period on or after the rate's start, before this draft's period, whose
     rate in effect is now that rate, gets a line: Ordinary time hours ×
     the new rate less what was paid (each rounded half up as PRUN2), or
     the new salary for the period less what was paid; Overtime paid at
     the old rate × its multiplier at the new rate × the multiplier. It's
     an extra pay (IR335; IRD's lump sum page: reported in the period it's
     paid). Refused: holiday pay in the period (still refused after P8: decision 152), a rate starting
     part-way through a paid period, a lower rate, a change of basis,
     overtime at another rate, a period already back-paid (the line keeps
     the pay run it's for, and approving checks no other approved pay run
     has paid it). NetSuite and Xero couldn't answer how back pay is
     worked out (see above), so this is a design choice.
134. **Final pays**: drafts include employees who finish in the period
     (P3 refused them); an hourly employee finishing before the period
     ends starts at 0 hours with a note to enter the hours (timesheets
     covering every day to the finish date give the hours, as TS8); a
     salaried one is refused as a part period, as starters are. The finish
     date goes in the EI file (decision 61). Nothing is paid after a final
     pay: later drafts leave the employee out (as before).
135. **Holiday pay owed on finishing isn't calculated until leave (P8) is
     built.** The honest minimum: a final pay can include a typed "Holiday
     pay on finishing" amount, labelled as worked out outside Tohyee and
     taxed by the end-of-employment rule; the pay run screen and payslip
     always say Tohyee didn't calculate it. Approving isn't blocked: the
     only way to block would be a typed "handled" tick, which the rules
     forbid ("Don't add features that only record a status someone types
     in") (question for Jess). (Since P8, 2 Oct 2026, only for employees
     whose leave Tohyee doesn't keep: decision 150.)
136. **Reports, journals and R&D**: new items post like any pay item (own
     account, own journal line) and count as labour cost in P10. For the
     R&D claim, Extra pay, Back pay and Holiday pay on finishing count as
     employee costs (IR1240 p 63 lists "bonuses", salaries and wages,
     "holiday and long-service pay"); Redundancy doesn't (not in IRD's
     list) (decisions 36, 66).
137. **An employee's request for a higher rate on extra pays** (IR335 page
     40) isn't built; it's listed as refused (question for Jess).

## Holidays Act leave build, payroll stage P8 (examples HL1-HL42)

Made 2 Oct 2026 by Claude while building P8 on decisions 7-29, by the rule
law → NetSuite → Xero (Jess said to go ahead and build leave on HL1-HL42;
the examples still need her approval). The law is the Holidays Act 2003
(`docs/sources/holidays-act-2003.md`, and s 17-s 19, s 27, s 28, s 36-s 39,
s 44-s 48, s 61A read on 2 Oct 2026 from the same consolidation as at 20
Dec 2023 in the `jonnonz1/nz-statute-book` repository). IRD and Employment
NZ pages were read on 2 Oct 2026 through Claude's summarising fetch tool
(quotes as it returned them; check the pages):
IRD [Taxing holiday pay](https://www.ird.govt.nz/employing-staff/deductions-from-income/taxing-holiday-pay)
(last updated 2 Jun 2020), [Holiday pay paid in advance](https://www.ird.govt.nz/employing-staff/payday-filing/non-standard-filing-of-employment-information/holiday-pay-paid-in-advance)
(12 Aug 2025), [Lump sum payments](https://www.ird.govt.nz/employing-staff/payday-filing/non-standard-filing-of-employment-information/lump-sum-payments)
(27 Jan 2026) and the [Commissioner's operational position on calculating PAYE on holiday pay](https://www.taxtechnical.ird.govt.nz/operational-positions/commissioners-operational-position-on-calculating-paye-on-holiday-pay)
(11 Mar 2016); Employment NZ [Calculating holiday and leave pay](https://www.employment.govt.nz/pay-and-hours/pay-and-wages/leave-and-holiday-pay/calculating-holiday-and-leave-pay)
(last modified 7 Aug 2026), [Public holidays and anniversary dates](https://www.employment.govt.nz/leave-and-holidays/public-holidays/public-holidays-and-anniversary-dates)
(25 Sep 2026) and [Previous years](https://www.employment.govt.nz/leave-and-holidays/public-holidays/previous-years-public-holidays-and-anniversary-dates);
Te Papa's [Dates for the Matariki public holiday](https://tepapa.govt.nz/discover-collections/read-watch-play/matariki-maori-new-year/dates-for-matariki-public-holiday).
NetSuite's help has no New Zealand holiday pay rules (see the HL section);
Xero Central couldn't be read again, so where Xero is cited it's from the
HL section's earlier reading.

138. **Leave pay items come with the organisation, one of each kind**
     (Annual leave, Sick leave, Bereavement leave, Special leave, Public
     holiday, Public holiday worked, Alternative holiday, Annual leave
     cashed up, Alternative holiday paid out, Holiday pay owed on
     finishing), to the wages account (6200) to start with, so journals
     and P10's reports show each kind apart; admins can rename them and
     change their accounts, never archive them or type their lines. Family
     violence leave's item is called "Special leave" so payslips, journals
     and reports don't say what it is (decision 27). Migration 0070 adds
     them (a name already used gets " (2)").
139. **Gross earnings for holiday pay (s 14) are marked on each pay item**
     (`counts_for_holiday_pay`): taxable earnings count; reimbursements,
     non-taxable allowances, redundancy and cash-ups don't. Redundancy
     follows Employment NZ: "The law does not say if redundancy payments
     are included in gross earnings. Our view is that redundancy would
     generally be received as compensation and not earnings." Cash-ups:
     s 14(c)(iv). An extra pay or allowance the agreement doesn't bind the
     employer to pay is marked "discretionary" when it's added (s 14(b)(i);
     HL4's Christmas voucher); it can't change later. Earnings count in the
     pay period of the pay run that paid them (a December bonus, back pay).
     Holiday pay on finishing isn't counted again after the end.
140. **Hours worked on a public holiday beyond the usual day** are paid at
     the ordinary hourly rate as part of "the portion of ... relevant daily
     pay ... that relates to the time actually worked" (s 50(1)), then time
     and a half; anything more an agreement gives is typed (decision 23).
141. **Leave is worked out on drafts, kept as lines, and counts when the pay
     run is approved.** A draft's leave lines (source "leave") carry the
     dates, hours, units, whether it's in advance and the rate's inputs;
     they're worked out when the draft is made and again whenever a
     booking, decision, cash-up, exchange or setting changes ("Update
     leave"). Approving works them out again and refuses if anything
     changed, so what's approved is what the records say. Balances count
     only approved pay runs; a voided pay run's leave doesn't count, and a
     booking an approved pay run paid can't be cancelled until it's voided.
     Typing leave items is refused; for an employee whose leave Tohyee
     keeps, typing P3's "Holiday pay" or "Holiday pay on finishing" is too.
142. **Leave settings are dated rows, never changed**: the usual week (each
     weekday's ordinary hours and usual overtime and allowances, all
     regular), or "varies" with the agreed week in hours and days (s 17);
     RDP or ADP with the s 9A(1) reason; the s 27(1)(a) agreement to pay
     annual holidays in the pay for the period they're taken; a part-day
     sick leave agreement (decision 19); continuous or casual (s 63(1)(b));
     the anniversary day region (decision 22). A setting that starts part
     way through a pay period is refused on that pay run.
143. **Tohyee keeps an employee's leave only from its own pay records**
     (since 2 Oct 2026, or from opening balances: decision 168).
     Opening leave balances and earnings from before Tohyee have no worked
     example, so leave is refused (as "Not supported yet") for someone
     whose first sick or annual entitlement arose before Tohyee's first pay
     run for them, for anyone paid P3's typed "Holiday pay" on an approved
     pay run, and for any calculation needing earnings from before that
     first pay run. Holiday pay on finishing stays typed for them (decision
     150). A rate needing the pay period before (AWE, ADP) also waits for
     that period's pay run to be approved.
144. **A pay period only partly inside an AWE, ADP or four-week window
     counts for its hours inside** (HL4): the day's approved timesheet hours
     in weeks with an approved timesheet, else the usual week's hours;
     refused for hours that vary without timesheets. Rates are kept to 10
     decimal places, which is exact for every cent paid (decision 26).
145. **The hours test (s 63(1)(b); HL21)**: weeks are 7-day blocks from the
     start of the 6 months; a calendar month only partly inside them needs
     its share of 40 hours (decision 20 left partial months open). A casual
     is entitled at the end of the first 6 months that meet the test on
     approved timesheets, then each 12 months while the 6 months before
     still meet it ("as long as the circumstances ... continue to apply",
     s 63(2)(b)).
146. **Otherwise a working day (decision 21): Tohyee suggests "yes" when the
     employee worked the same weekday in at least 2 of the 4 weeks before**
     (from approved timesheets), and the person running pay records the
     decision with the suggestion. A fixed usual week decides it without
     asking (s 12(2) applies only "If it is not clear"). Approved timesheet
     hours on a public holiday count as hours worked on it unless a
     decision says otherwise. A decision can't change once an approved pay
     run covers the day.
147. **Alternative holidays are used oldest first** (taken, exchanged or
     paid out), and a booking needs one that isn't already booked.
148. **The usual pay comes from the usual week.** For an employee with a
     fixed usual week a draft's Ordinary time, regular overtime and
     allowances are made day by day for the days worked, leaving out leave,
     public holidays (paid by their own lines) and the part of a part day
     not worked; a salary is the period's salary × the share of the usual
     ordinary hours paid. An hourly employee finishing part way through a
     period gets their usual hours to the finish date (P12 gave 0 hours);
     one whose every day is covered by approved timesheets gets the
     timesheets' hours less hours on public holidays (P9). Hours that vary
     keep P3's or P9's Ordinary time, with a note to enter the hours.
149. **Typing an employee's lines by hand takes the usual pay over** unless
     "keep the usual pay" is ticked; Tohyee then stops changing it and
     notes that leave wasn't taken off it.
150. **Holiday pay owed on finishing is worked out by Tohyee** for an
     employee whose leave it keeps: lines of the system "Holiday pay owed on
     finishing" item for the untaken entitlement (s 24), the public holidays
     it would have covered (s 40(3)), the 8% (s 25 or s 23) and untaken
     alternative holidays (s 60(2)(b)), taxed by IRD's end-of-employment
     rule (decision 130). The typed "Holiday pay on finishing (worked out
     outside Tohyee)" stays only where Tohyee doesn't keep the leave
     (decision 143); HL examples don't need it. Advance holiday pay worth
     more than the 8% isn't deducted even with consent: how the recovery is
     taxed has no worked example (a note says so; question for Jess).
     Supersedes decision 135 for kept employees.
151. **Tax on leave follows IRD's operational position on holiday pay**:
     "Holiday pay that is linked to the work days within the pay period is
     treated as salary or wages", so leave and public holidays paid in the
     period they're taken are regular pay; cash-ups are extra pays (the
     position: "should continue to be treated as an 'extra pay'"; IRD's lump
     sum page: "cashed in annual leave"); an alternative holiday exchanged
     for money is "holiday pay paid in addition to the regular pay for the
     pay period" (IR335), so an extra pay too. P3's typed "Holiday pay"
     stays regular pay and is relabelled "for leave in this pay period";
     holiday pay paid in advance of the period isn't built (decision 157).
152. **Back pay for a pay period with leave or holiday pay in it stays
     refused.** By law back pay is gross earnings in the period it's paid
     (it raises later AWE), and a backdated rate raises the ordinary weekly
     pay that holidays taken after it were paid at; paying that difference
     needs a worked example (XP question 5).
153. **The leave liability report** (decision 28) values the annual
     holidays entitled to (a positive balance) at the greater of OWP at the
     date and AWE to the last approved pay period on or before it, adds the
     running 8% of gross earnings since the last anniversary to that pay
     period, and untaken alternative holidays at OWP ÷ the usual days a
     week; by the Department on the biggest line of the cost allocation at
     the date. Shown and exported only; nothing is posted.
154. **The EI file's hours paid include leave and public holiday hours** in
     the period ("hours paid for the paydate"); not cash-ups, exchanges or
     holiday pay on finishing.
155. **Leave pay is an R&D employee cost** (IR1240 p 63: salary and wages,
     "holiday and long-service pay").
156. **Payslips show leave balances at the end of the period**: annual
     holidays in weeks and hours, sick leave in days, untaken alternative
     holidays; never family violence leave (decision 27).
157. **Annual holidays are paid in the pay for the period they're taken
     only with the s 27(1)(a) agreement recorded**; without it they're
     refused (paying before the holiday, s 27(1), isn't built).
158. **A cash-up is paid at the s 21(2) rate on the date it was agreed**
     (HL12) in the first draft whose period ends on or after that date;
     cash-ups agreed but not yet paid count against the 1 week.
159. **Annual holidays are one line per booking per pay period**, split
     into the part covered by the balance and the part in advance, worked
     out day by day against the balance on each day (so a new entitlement
     during the leave covers the days after it, HL13). Sick, bereavement,
     family violence leave and alternative holidays are a line per day.
160. **Bereavement leave has no balance**: each booking is one bereavement,
     at most 3 or 1 working days (s 70(1)); before 6 months only with leave
     in advance agreed.
161. **Sick or family violence leave beyond the balance stops the pay run**
     unless the booking records that leave in advance was agreed (s 63(3),
     s 72D(3)); unpaid sick leave is recorded as unpaid leave.
162. **Public holiday dates are 2025-2027**, as Employment NZ publishes them
     (2028 isn't published yet); a pay period touching a year Tohyee
     doesn't have is refused until it's added.
163. **The holiday and leave record (s 81(2))** lists employment start and
     end, each entitlement, leave with dates, hours and pay, cash-ups,
     public holidays worked and paid, alternative holidays arising and
     their use, and holiday pay on finishing, with each pay period's hours
     and pay (s 81(2)(c)); CSV export audited without figures. (ja) and (m)
     aren't supported (no transfers, no board).
164. **Employees' own leave requests aren't built in P8** (built since as
     leave requests, decision 169): booking leave
     needs payroll access, because a booking changes pay and family
     violence leave must stay private. P9's employee self-service could be
     followed later (question for Jess).
165. **A part day's pay** is RDP less the pay for the time worked (HL23);
     with ADP, ADP × the hours off ÷ the day's hours.
166. **Leave for someone whose hours vary** is booked with the hours each
     day; annual holidays are those hours ÷ the agreed week's hours (s 17).
167. **The AWE divisor cut for agreed unpaid leave** is the whole or part
     weeks over one week of the part of the leave inside the 12 months.

## The leave build's questions, decided (2 Oct 2026; decisions 168-181)

Jess asked Claude to "look up what you need to and make the calls
yourself" on the 14 "Questions for Jess (leave build)" at the end of the HL
section of `docs/ACCOUNTING-EXAMPLES.md`, by the rule law → NetSuite →
Xero, never guessing a rule and never overstating. One decision per
question, in the questions' order. The examples they lead to (HL43 on)
still need her approval; none is marked approved.

How the sources were read on 2 Oct 2026: legislation.govt.nz, ird.govt.nz
and employment.govt.nz refuse direct downloads from this computer, so the
Acts are quoted from the extracts saved under `docs/sources/` on 1 Oct 2026,
and web pages were read through Claude's summarising fetch tool (its
quotes, as it returned them; check the pages). Pages read that way:
Employment NZ [Public holidays and anniversary dates](https://www.employment.govt.nz/leave-and-holidays/public-holidays/public-holidays-and-anniversary-dates)
(last modified 25 Sep 2026), [Calculating holiday and leave pay](https://www.employment.govt.nz/pay-and-hours/pay-and-wages/leave-and-holiday-pay/calculating-holiday-and-leave-pay)
(7 Aug 2026), [Annual holiday pay](https://www.employment.govt.nz/pay-and-hours/pay-and-wages/leave-and-holiday-pay/annual-holiday-pay)
(7 Aug 2026), [Final pay](https://www.employment.govt.nz/pay-and-hours/pay-and-wages/final-pay)
(2 Sep 2026), [Managing public holidays as an employer](https://www.employment.govt.nz/leave-and-holidays/public-holidays/managing-public-holidays-as-an-employer)
(7 Aug 2026) and [Cashing up annual holidays](https://www.employment.govt.nz/leave-and-holidays/annual-holidays/cashing-up-annual-holidays);
IRD's [Employer's guide IR335](https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir300---ir399/ir335/ir335.pdf)
(April 2026) and the officials' [regulatory impact statement on PAYE error correction](https://www.taxpolicy.ird.govt.nz/-/media/project/ir/tp/publications/2019/2019-ria-paye-error-correction/2019-ria-paye-error-correction-pdf.pdf)
(2019); NetSuite's help [Time-Off Management Setup](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4607408864.html),
[Time-Off Management Overview](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1519931238.html),
[Time-Off Management for Employees or Managers](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1503583942.html)
and [Canceling Time-Off Requests](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1509720113.html);
the External Reporting Board's [NZ IAS 19](https://www.xrb.govt.nz/dmsdocument/272/)
(incorporating amendments to 28 Feb 2014); Te Papa's [Dates for the
Matariki public holiday](https://tepapa.govt.nz/discover-collections/read-watch-play/matariki-maori-new-year/dates-for-matariki-public-holiday).
Xero Central articles were read from the same undated copies as before
(the `web-arena-x/webarena-infinity` repository,
`apps/user-manuals/xero/payroll/`), each named with its Xero Central
address below; Xero may have changed them since.

168. **Opening leave balances: yes, built (question 1).** Anyone moving from
     another payroll needs them, and the Act needs the earlier earnings:
     AWE is 1/52 of "gross earnings" for "the 12 months immediately before
     the end of the last pay period" (s 5, s 21(2)(b)(ii)), ADP uses "the
     52 calendar weeks" before it (s 9A(2)), and the 8% on leaving uses
     gross earnings "since the employee last became entitled" (s 25(2)).
     Xero asks for the same things: leave balances per leave type with
     "the Date when entitled to annual leave" and sick leave's date, the
     alternative holiday balance "from your previous payroll system"
     ([Set up a permanent employee's leave entitlements](https://central.xero.com/s/article/Set-up-a-permanent-employee-s-leave-entitlements-and-opening-balances)),
     and past earnings per pay period: "Pay period end dates", "Days
     paid", "Unpaid weeks", "Gross earnings", "for the last 12 months (or
     from when they started work)" ([Enter past earnings from another
     payroll system](https://central.xero.com/s/article/Transfer-past-earnings-from-your-previous-payroll-system)).
     NetSuite's help has nothing on New Zealand holiday pay. So Tohyee
     keeps, once per employee, entered by someone with payroll access with
     where the figures came from and the previous system's report attached
     (both required; audited; kept like other leave files, s 81(4)):
     - the **opening date**: balances as at the end of that day, the last
       day before the first pay period whose leave Tohyee keeps;
     - **annual holidays**: the balance in weeks (negative when taken in
       advance), the date the employee last became entitled (none if not
       yet 12 months), the weeks already cashed up in that entitlement
       year (s 28A(2)(b)), and, when the balance is negative, the holiday
       pay already paid for the holidays taken in advance (s 23(2)(a),
       s 25(2)(a));
     - **sick leave** and **family violence leave** balances in days (their
       dates follow from the start date, s 63(2)(a); refused for casual
       employees, whose hours test needs approved timesheets, s 63(1)(b));
     - each **untaken alternative holiday** and the date it arose (s 61,
       s 81(2)(k));
     - the **earlier earnings**, one row per pay period of the previous
       payroll (Xero's layout), each with its dates, gross earnings (s 14),
       the part that's irregular or one-off (s 8(2) "b"), and the days
       worked or on paid leave (s 9A(2)); rows run without gaps to the
       opening date (or to Tohyee's first approved pay period for the
       employee). Xero's "unpaid weeks" column isn't copied: unpaid leave
       is recorded as unpaid leave, and only an agreement to count it cuts
       the AWE divisor (decision 14).
     Tohyee then uses them exactly as its own records: the opening balances
     at the end of the opening date, later entitlements from the last
     entitlement date (s 16(1)) and the start date (s 63(2)(a)), the
     earnings rows inside AWE, ADP, four-week and 8% windows (a row only
     partly inside counts by hours, as decision 144 does; for ADP a row
     must be wholly inside, or it's refused and the rows should be by pay
     period). Typed holiday pay (P3) on pay runs ending on or before the
     opening date is covered by the opening balances, which removes
     decision 143's refusal for employees who have them. An opening
     balance can be replaced (the old one kept) until an approved pay run
     has paid leave for the employee; after that, void that pay run first.
     Refused: an opening date inside a pay period Tohyee works out, typed
     holiday pay after it, earnings rows that overlap Tohyee's own pay
     periods or each other, or leave the rows don't reach back far enough
     for (named in the refusal). Examples HL43-HL48. Built 2 Oct 2026
     (tenant migration 0071).
169. **Employees' own leave requests: yes, built like P9's timesheets
     (question 2).** NetSuite: "You can create and submit time-off requests
     using the Book Time Off button in the Time-Off portlet on your Employee
     Center home page", "Managers can review and approve time-off requests",
     "you can cancel pending and approved time-off requests", but
     "Approved time-off requests that are associated with a locked
     timesheet can't be canceled". Xero Me does the same, with "Authorised
     to approve leave" employees and payroll admins approving, and
     "Xero automatically includes approved leave requests in the next pay
     run" ([Approve, reject or edit a leave request as a payroll admin](https://central.xero.com/s/article/Approve-leave-as-a-Payroll-Admin)).
     So: an employee linked to their login asks for leave (dates, the type
     from a short list, hours each day where their hours vary, a note); it
     shows **hours and days only, never pay or balances in dollars**; they
     can change or withdraw it until it's decided; the approver is the
     employee's timesheet approver, else their reports-to manager's login,
     or anyone with payroll access, never the employee themselves (decision
     96); a rejection needs a reason. Approving books the leave (a booking
     like decision 141's, made by the approver and linked to the request),
     so the next pay run pays it; anything the booking would refuse
     refuses the approval with the same reason. Family violence leave is
     asked for and shown to the approver as "Special leave" (decision 27).
     Cancelling once approved is the booking's cancel, by payroll access,
     and never after an approved pay run paid it. Examples HL49-HL51.
     Built 2 Oct 2026 (Payroll › Leave requests; tenant migration 0071).
170. **Advance holiday pay over the 8% stays refused (question 3).** The
     law allows the deduction only "with the written consent of the
     worker" (Wages Protection Act 1983 s 5(1)(a); s 23(2) and s 25(2) only
     subtract advance holiday pay from the 8%, down to nil). How the
     recovery is taxed couldn't be confirmed from IRD: IR335 (April 2026)
     has nothing on recovering holiday pay paid in advance or on wages
     repaid, and the 2019 regulatory impact statement on PAYE error
     correction only says that before 2019 "Some employers ... seek a
     refund of PAYE and other deductions, when they obtain agreement from
     the employee that the net amount will be repaid", for overpayments
     made in error, which advance holiday pay isn't. PayHero (a NZ payroll)
     adds "'Annual Leave Taken in Advance' pay lines ... to deduct the
     amounts owing" "at the same rate it was originally paid at" without
     saying how they're taxed ([Final Pay](https://support.payhero.co.nz/hc/en-us/articles/360002666936-Final-Pay));
     Employment NZ's Final pay page doesn't cover it. Without IRD's
     treatment Tohyee keeps the note (the amount over the 8%, deductible
     only with written consent) and refuses the deduction (decision 150
     stands). Ask IRD (or an accountant) whether recovering it in the same
     tax year reduces the final pay's gross (PAYE income) or is an
     after-tax deduction, and what happens across a tax year.
171. **Back pay over periods with leave stays refused (question 4).**
     s 21(2)(b)(i) uses "ordinary weekly pay as at the beginning of the
     annual holiday", which is "the amount of pay that the employee
     receives under his or her employment agreement for an ordinary
     working week" (s 8(1)(a)); whether a later agreement to backdate a
     rise changes that amount for holidays already taken isn't said by the
     Act, by Employment NZ's Annual holiday pay or Calculating holiday and
     leave pay pages (neither mentions back pay), or by the Holidays Act
     Taskforce's final report (2019). The rule isn't clear, so decision 152
     stands: back pay for a pay period with leave or holiday pay in it is
     refused, with the reason. (Back pay itself still counts as gross
     earnings in the period it's paid, decision 139.)
172. **Paying annual holidays before they're taken stays not built
     (question 5).** s 27(1) pays annual holiday pay before the holiday
     unless the employment agreement or the employee agrees to it being
     paid in the pay that relates to the period of the holiday; Tohyee
     records that agreement per employee (decision 142) and refuses annual
     holidays without it (decision 157), so nobody is paid the wrong way;
     the refusal says to record the agreement. Xero's only "in advance"
     help is paying whole pay runs early ([Process pay runs in advance](https://central.xero.com/s/article/Process-holiday-pay-runs-in-advance)),
     which Tohyee can already do by approving a pay run with a later pay
     date. Build it only if an organisation needs it.
173. **"Otherwise a working day" stays a suggestion from 2 of the last 4
     weeks (question 6)**, and the screen now says it's only a suggestion.
     Employment NZ (Managing public holidays as an employer): "You and
     your employee must consider all these factors when trying to reach an
     agreement. For example, you cannot just rely on one and then conclude
     that the day is not an otherwise working day", and it sets no
     frequency rule. Tohyee's figure is one factor (s 12(3)(b), work
     patterns); the person recording the decision is reminded of the
     others (s 12(3): the agreement, rosters, working only when work is
     available, reasonable expectations, whether they'd have worked but
     for the holiday), and the decision is theirs (decision 21).
174. **Hours worked on a public holiday beyond the usual day: the ordinary
     rate, then time and a half (question 7)**, as decision 140: s 50(1)(a)
     pays "the portion of the employee's relevant daily pay or average
     daily pay (less any penal rates) that relates to the time actually
     worked on the day plus half that amount again", and relevant daily pay
     includes "payments for overtime if those payments would have otherwise
     been received had the employee worked on the day concerned"
     (s 9(1)(b)(ii); checked against `docs/sources/holidays-act-2003.md`).
     Unchanged.
175. **The usual pay from the usual week (question 8)**, as decision 148:
     unchanged. Xero likewise pays from a pay template of regular earnings
     and a working pattern ([Set regular earnings and a working pattern for
     an employee](https://central.xero.com/s/article/Set-regular-earnings-and-a-working-pattern-for-an-employee)).
176. **Redundancy isn't gross earnings for holiday pay (question 9)**, as
     decision 139. Employment NZ (Calculating holiday and leave pay, read
     2 Oct 2026, last modified 7 Aug 2026): "The law does not say if
     redundancy payments are included in gross earnings. Our view is that
     redundancy would generally be received as compensation and not
     earnings." Unchanged.
177. **Post the leave liability to the ledger: yes, designed now, built
     next (question 10).** NZ IAS 19 para 11: "When an employee has
     rendered service to an entity during an accounting period, the entity
     shall recognise the undiscounted amount of short-term employee
     benefits expected to be paid in exchange for that service", para 13
     for "paid absences", and para 16: "measure the expected cost of
     accumulating paid absences as the additional amount that the entity
     expects to pay as a result of the unused entitlement that has
     accumulated at the end of the reporting period". (PBE IPSAS 39, for
     not-for-profits, has the same rules for short-term employee benefits:
     not read here, **unverified**; read on 2 Oct 2026 for the build,
     decision 187.) NetSuite has no NZ leave; Xero NZ only
     reports it ([Leave Liability report](https://central.xero.com/s/article/Employee-Leave-Liability-report):
     "summarises what you owe an employee on a specific date"), leaving the
     journal to the bookkeeper. Design: "Post leave liability" at a date
     (payroll access and the bookkeeper role), one journal for the change
     since the last posting: the liability report's total at that date
     (annual holidays entitled, the running 8%, alternative holidays,
     decision 153) less the total last posted, Dr a leave expense account
     and Cr an employee entitlements liability account, split by the
     report's Departments, never naming employees; a posting can be voided
     with a reversing journal, never edited. Sick, bereavement and family
     violence leave aren't accrued: they don't vest and lapse or cap
     (s 66, s 72H), and para 16 measures only what the entity "expects to
     pay" because of unused entitlement, which needs an estimate Tohyee
     can't make. Leave paid in pay runs keeps posting to wages (decision
     138); the next liability posting takes the fall. Examples HL52-HL54;
     the liability report's valuation of alternative holidays at a usual
     day's OWP (decision 153) stays.
178. **The anniversary day must be chosen before public holidays are paid
     (question 11)**, as decision 22: the Act's anniversary day is the one
     observed locally (s 44(1)(k), as HL31 reads it; that section isn't in
     the saved extract) and Employment NZ says that for someone working
     away from home "you and the employee should agree which Anniversary
     Day will be observed". Tohyee can't pick it. Unchanged.
179. **2028's public holidays aren't added yet (question 12).** Employment
     NZ's page (last modified 25 Sep 2026) lists 2026 and 2027 only.
     Anniversary days aren't set by any Act (they're the day observed
     locally) and every employee needs one (decision 178), so a year
     without them can't be paid; national dates alone would change nothing.
     What is fixed by law for the part of 2028 the Holidays Act covers (to
     the first pay period on or after 6 Aug 2028): New Year's Day and
     2 January (Saturday and Sunday in 2028, so Monday 3
     and Tuesday 4 January for most, s 45), Waitangi Day (6 February, a
     Sunday: Monday 7 February, s 45A), Good Friday and Easter Monday,
     ANZAC Day (Tuesday 25 April), the Sovereign's birthday (the first
     Monday in June, s 44(1)(i)) and Matariki, **Friday 14 July 2028** in
     Te Papa's list of the dates the Matariki Advisory Committee set
     (Schedule 1 of Te Kāhui o Matariki Public Holiday Act 2022 couldn't be
     read: legislation.govt.nz refused). Add 2028 to
     `src/lib/payroll/leave/public-holiday-dates.ts` when Employment NZ
     publishes it, checking these; until then a pay period touching 2028
     is refused (decision 162). HANDOVER has the reminder.
180. **Aroha's anniversary day in HL13 is Wellington's (question 13):**
     Monday 25 January 2027 (Employment NZ, read 2 Oct 2026), outside her
     booking of 22 March to 2 April 2027. Otago's (Monday 22 March 2027)
     and Southland's (Tuesday 30 March 2027) fall in it. The tests already
     set her to Wellington; HL13 now says so.
181. **Cash-ups at the s 21(2) rate on the date agreed (question 14)**, as
     decision 158. s 28B(1) pays the portion "in accordance with section
     21(2)" and "as soon as practicable after the employer has agreed to
     the employee's request"; Employment NZ (Cashing up annual holidays)
     says the payment "must be at least the same amount as if the employee
     had taken the holidays" and is "usually the next pay day". The
     agreement is the cash-up's event, the way the start of the holiday is
     for s 21(2), so OWP is taken at the date agreed and AWE to the end of
     the last pay period before it. Unchanged.

## Posting the leave liability, built (2 Oct 2026; decisions 182-187; examples HL52-HL56)

Decision 177 and HL52-HL54 settled what the journal is. Building it left
the calls below, made by the rule law → NetSuite → Xero. Neither NetSuite
(no NZ leave) nor Xero NZ (the [Leave Liability report](https://central.xero.com/s/article/Employee-Leave-Liability-report)
only reports; the journal is the bookkeeper's) posts it, so beyond the
standards these follow how Tohyee's other payroll postings behave (pay
runs, wage and IRD payments: P3, P4). HL55 and HL56 were added for them;
like HL52-HL54 they're **not approved by Jess**.

182. **A posting is the change since the last posting not voided, by
     Department.** For each Department the report's total at the date
     less what that posting left for it; Departments only in the earlier
     posting fall to 0.00 (HL53). The journal is dated the posting's date,
     reference LEAVELIAB-n, described "Leave liability at 11 Oct 2026",
     lines "Leave expense" and "Employee entitlements" (HL52). A date
     before the last posting not voided is refused (the same date is
     allowed, after a pay run is voided and approved again, say); a date
     when nothing has changed is refused as "Nothing to post" (HL55), so
     there are no empty journals. When only the split between Departments
     changed, the journal moves it and the posting's change is 0.00.
     Adjusting by the change (not reversing the last posting and posting
     the whole liability again) is what decision 177 asked for and keeps
     one journal per date.
183. **Undone in order, never edited (HL54, HL55).** Only the latest
     posting not voided can be voided (the later one measured from it),
     like wage payments before their pay run (PPAY12): the exact reversal
     of its journal on the void date, which can't be before the posting's
     date or in a locked period. The next posting then measures from the
     one before it. The ledger refuses to correct these journals (as pay
     runs' journals), and the database refuses changes and deletes except
     voiding.
184. **The accounts are payroll settings, set by admins** (Payroll › Pay
     items, beside the other payroll settings), like pay items' accounts
     (PRUN10). The leave expense is an expense or direct costs account;
     the employee entitlements account a current liability (para 11 of
     NZ IAS 19 and PBE IPSAS 39 recognises a liability; asking for a
     current one because the benefits are short-term is a design choice);
     neither a control account, both in the base currency. Each posting
     keeps the accounts it used. The employee entitlements account can't
     change while the last posting not voided left a liability in it
     (the next posting would measure from a balance in another account);
     post to 0.00 or void first (HL56). The leave expense account can
     change at any time: it only moves where later changes go.
185. **Departments are the report's (decision 153: the biggest line of the
     cost allocation at the date), as tracking tags on both lines** when
     advanced features are on, so profit and loss and the balance sheet by
     Department both see it (HL52 tags both). With advanced features off
     every Department is one untagged pair of lines. When expense lines
     need a Department and someone in the report has none, the posting is
     refused naming them (as pay runs do, PRUN1).
186. **Who and what's recorded.** Posting and voiding need payroll access
     and the bookkeeper role (as payroll reports, decision 105); viewing
     the postings needs the same, as they hold totals by Department, which
     can be one person's. Audit events record the reference, date,
     journal and number of Departments, never an amount, and the journal's
     own audit event leaves its total out (origin payroll, as PRUN9).
187. **What's in the liability (checked).** PBE IPSAS 39 (XRB, issued May
     2017, amended to 28 Feb 2025, [dmsdocument/5446](https://www.xrb.govt.nz/dmsdocument/5446/),
     read 2 Oct 2026 through the summarising fetch tool, its quotes as
     returned) has the same rules as NZ IAS 19: para 11 recognises "the
     undiscounted amount of short-term employee benefits expected to be
     paid in exchange for that service", para 13 accumulating paid
     absences "when the employees render service that increases their
     entitlement", para 16 measures "the additional amount that the entity
     expects to pay as a result of the unused entitlement that has
     accumulated at the end of the reporting period". So not-for-profits
     post the same journal; decision 177's "unverified" is lifted for
     these paragraphs. Para 15 says accumulating absences that don't vest
     (sick leave carried over) are an obligation too, measured for the
     chance they're used: Tohyee still leaves sick leave out (decision 177:
     the estimate is the organisation's); that's a question for Jess. The
     posting is refused while any row of the report has a problem (HL54),
     so a part of the liability is never quietly left out. Someone who
     finished on or before the date isn't in the report (what they're
     owed is in their final pay), as built in P8. (Replaced by decision
     189: they stay in until their final pay is paid. Sick leave: decision
     188.)

## The leave liability's four questions, decided (2 Oct 2026; decisions 188-191; examples HL53, HL57-HL61)

The questions left after posting the leave liability was built ("Questions
for Jess (posting the leave liability)" at the end of the HL section),
decided by the rule law → NetSuite → Xero, as Jess asked. Neither NetSuite
nor Xero NZ posts a leave liability (decision 182's preamble), so these
follow the standard. PBE IPSAS 39 (XRB, [dmsdocument/5446](https://www.xrb.govt.nz/dmsdocument/5446/))
was read again on 2 Oct 2026 through the summarising fetch tool; quotes are
as it returned them, so check them against the PDF (they match NZ IAS 19's
paragraphs of the same numbers). The examples are **not approved by Jess**.

188. **Sick leave stays out of the liability (question 1), documented, not
     built.** Para 17: "a sick leave obligation is likely to be material
     only if there is a formal or informal understanding that unused paid
     sick leave may be taken as paid annual leave." The Holidays Act 2003
     doesn't let sick leave be taken as annual holidays, so for most
     organisations there's no material obligation and nothing to estimate.
     An organisation whose own agreements do allow it has to journal its
     own estimate by hand; the liability screen says so. Bereavement and
     family violence leave don't accumulate (para 13(b): recognised when
     the absence occurs), so they stay out too.
189. **Finished employees stay in the liability until their final pay is
     paid (question 2; HL53, HL57, HL58).** Para 11 recognises the benefits
     expected to be paid for service already given, "after deducting any
     amount already paid". Someone who has finished but whose final pay's
     pay date is after the posting's date is still owed their holiday pay
     on finishing, and no account holds it until the final pay's journal.
     So the report keeps everyone who finished before its date until an
     approved pay run that includes their finish date (their final pay) is
     dated on or before it, valued at the **holiday pay on finishing on
     that final pay**: Tohyee's lines (s 23-s 26, s 40(3), s 60(2)(b)) and
     any typed "Holiday pay on finishing (worked out outside Tohyee)". With
     no approved final pay yet, the row is a problem, which stops the
     posting (decision 187: never quietly left out) and says to approve the
     final pay. Someone who finished and was never paid by an approved pay
     run in Tohyee has nothing to wait for and is left out (as before).
     HL53's figures are rewritten: Hemi is in at 31 Oct at 5,302.89.
190. **Employer KiwiSaver on the leave is included (question 3; HL59,
     HL60).** Para 9(a) counts social security contributions as short-term
     benefits, and para 53 recognises "the contribution payable to a
     defined contribution plan in exchange for that service". Employer
     KiwiSaver is paid on holiday pay (Tohyee's leave and holiday pay on
     finishing items count for KiwiSaver), so the liability includes it:
     for each employee whose KiwiSaver status is "enrolled" (their status
     now: it isn't dated), their employer rate × their liability,
     truncated to cents as each pay's contribution is (spec 5.20.2,
     `kiwiSaverEmployerContribution`). It's gross, before ESCT: ESCT is
     taken out of the employer's contribution and is part of its cost.
     It's posted as its own pair of lines, described "Employer KiwiSaver
     on leave", to the same two accounts (so decision 184's guard on the
     employee entitlements account covers it), measured from the last
     posting the same way (decision 182), and kept by Department on each
     posting (tenant migration 0073). Postings before 0073 measured none,
     so the first posting after it adds the KiwiSaver in full. Not in it:
     ACC levies (paid by the employer on liable earnings later, not per
     pay) and the employee's own KiwiSaver (part of the gross).
191. **A month-end reminder, worked out from the postings (question 4;
     HL61).** On the home page, beside the R&D reminders, people with the
     bookkeeper role and payroll access see "Post the leave liability at
     31 Oct 2026" when, for the latest month end before today, an approved
     pay run's period end or pay date falls after the last posting not
     voided (or there's no posting) and on or before that month end, and
     some employee has leave settings. Nothing is typed or ticked: posting
     at or after the month end, or voiding, changes it. It doesn't work
     out the liability itself (that would run the report on every home
     page), so in the rare month where pay runs leave the liability
     unchanged, posting says "Nothing to post" and the reminder stays until
     the next month end. It isn't a Period close check: those are for
     bookkeepers without payroll access too, and a warning there would
     stop them closing.

## Payroll and R&D questions, decided (2 Oct 2026; decisions 192-224)

Jess asked (2 Oct 2026) for the open questions to be decided by law →
NetSuite → Xero rather than left for her. These are the "Questions for
Jess" under TS11 (timesheets), PREP8 (payroll reports), the WB section
(workforce budgets), the XP section (extra pays) and RD42 (the R&D claim).
What's built for each is said; "kept" means as built, with the reason.
The examples these touch are **not approved by Jess**.

### Timesheets (TS questions 1-7)

192. **The first day of the week is an organisation setting** (question 1;
     replaces decision 92's fixed Monday). NetSuite: "Select the day of the
     week your company uses as the first day of the business week. The day
     you select is reflected on time tracking forms and on reports"
     ([Setting Up Time Tracking Preferences](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N902575.html),
     read 2 Oct 2026). Monday unless changed; it can only change while the
     organisation has no timesheets (changing it would cut existing weeks
     in two). Timesheets per pay period (Xero) aren't built: NetSuite's
     weekly sheet comes first.
193. **Viewers keep filling in their own timesheets** (question 2, kept;
     decision 95). No "time only" role: the viewer role already sees no pay
     and can't post, and NetSuite's employees also enter their own time.
194. **Approvers still can't change hours** (question 3, kept; decision
     96): NetSuite's rule ("Time approvers can't edit or delete existing
     time entries") comes before Xero's.
195. **Part-covered pay periods stay split by calendar days** (question 4,
     kept; decision 98). Working days would need everyone's usual week,
     which only employees with leave settings have; the share is a cost
     split, not pay, so the simpler rule stays.
196. **Ordinary time only from timesheets; no automatic overtime**
     (question 5, kept). When hours become overtime and at what rate is
     set by each employment agreement (NZ law sets no overtime rate, as far
     as known: Employment NZ's guidance wasn't read this session,
     **unverified**), so Tohyee doesn't guess it; overtime stays
     a typed line. Drafts are worked out live, so a timesheet approved
     before the pay run is approved is used (decision 98).
197. **Approved project hours don't become project time automatically**
     (question 6, kept; decision 91). NetSuite has one time record, but
     Tohyee's project time follows Xero Projects (a member's login, a task,
     changeable until invoiced), which a timesheet row doesn't have.
     "Fill from project time" stays the link between them.
198. **A late timesheet after the pay is posted is listed, not
     reallocated** (question 7, kept; decision 37, RD22). Posted pay runs
     are never changed (append-only); the R&D claim lists the timesheet as
     approved after its pay run. Reallocating would need a correcting
     journal per pay run with its own example.

### Payroll reports (PREP questions 1-7)

199. **The standard week is saved per organisation** (question 1). 40.00
     hours unless an admin with payroll access changes it (Payroll › Pay
     items, beside the other payroll settings); a report can still use
     another for one run. Not per pay group: FTE compares people across
     groups, so one week is needed.
200. **Salaried employees' usual hours come from their usual week**
     (question 2). Decision 107 counted every salary as 1.0000 "assumed".
     Since P8 an employee with leave settings has a usual week (hours each
     day); when it's a fixed week on the date, its hours are their usual
     hours, for salaried and hourly employees alike (it's what their leave
     is paid on). Without one, an hourly employee uses the pay rate's
     ordinary hours (as before) and a salaried one counts 1.0000, assumed.
201. **FTE stays capped at 1** (question 3, kept; decision 107): FTE is a
     share of one full-time position.
202. **Reimbursements stay out of labour cost** (question 4, kept): they
     repay the employee's spending; they aren't pay for work.
203. **By pay date only** (question 5, kept; decision 102): it's what IRD
     and the ledger use. By period worked would need its own example.
204. **Pay runs approved before timesheets keep showing "Not recorded"**
     (question 6, kept; decision 104). Only pay runs approved before P9 was
     merged (2 Oct 2026) have no shares, and Tohyee has no users yet, so no
     real organisation has any; working them out from the allocation (as
     the R&D claim does, decision 67) would be code with nothing to apply
     to. If one turns up, use decision 67's rule.
205. **No second permission for exports** (question 7, kept; decision
     109): payroll access already limits who sees the figures, and the
     audit log records each export.

### Workforce budgets (WB questions 1-6)

206. **Whole months stay** (question 1, kept): budgets are monthly. A
     part-month start is entered as a later start month, or the month's
     amount adjusted with a rise. Prorating by days would need its own
     example.
207. **A later pay rate on the employee doesn't change the budget by
     itself** (question 2, kept): a budget is a plan saved at a point in
     time; "Update budgets" (P11) already rewrites the figures when the
     person running it chooses.
208. **The KiwiSaver employer rate stays as typed on each line** (question
     3, kept): Tohyee only holds IRD's published rates (to 2026-27); the
     April 2028 rise is typed as a rise until IRD's specification for that
     year is added (never guessed).
209. **No on-costs yet** (question 4): holiday pay accrual, ACC levies and
     overtime each need their own worked example; ACC levies aren't paid
     per pay. Not built.
210. **One line per person** (question 5, kept): each line is one
     employee or one position, so the budget can follow people.
211. **Actuals by pay date** (question 6, kept), the same as decision 203.

### Extra pays, back pay and final pays (XP questions 1-8)

212. **IRD's steps, not its printed example** (question 1, kept; decision
     126): the specification's steps are the rule; the one-cent difference
     in the printed example 1 stays a question for IRD, for Jess to ask.
213. **Short four-week windows: IRD's "other circumstances" rule, built**
     (question 2; XP15). The 2026-27 specification (Payroll Calculations
     & Business Rules Specification, 1 April 2026 to 31 March 2027,
     version 1.0, 24 March 2026; s 5.11.1 read on 2 Oct 2026 in Chrome with
     pdf.js on an ird.govt.nz page) s 5.11.1 step 3.1 lists the usual
     patterns (four weekly pays × 13, two fortnightly × 13, one four-weekly
     × 13, one monthly × 12), then: "In other circumstances, add all PAYE
     income payments made to the employee in the four weeks prior and
     multiply by 13." Note 4 covers only one pay period paid before the
     extra pay ("the amount paid for that pay period is the amount to be
     annualised") without saying how, so that case stays refused; two or
     more pays of the right frequency that aren't the usual pattern use ×
     13. The window is the four weeks to the extra pay's pay date,
     inclusive; other extra pays in it are left out (as P12 already did).
214. **An extra pay on a final pay without a termination item stays
     refused** (question 3): whether a bonus arises from the ending decides
     IRD's method; a choice for the person running pay would need IRD's
     guidance on how to decide, not read this session.
215. **Holiday pay on finishing: as built** (question 4; decision 150):
     Tohyee works it out where it keeps the leave; typed only where it
     doesn't.
216. **Back pay over holiday pay periods stays refused** (question 5;
     decision 171).
217. **Hourly leavers: as built** (question 6; decision 148 gives leavers
     their usual hours to the finish date).
218. **Separate extra-pay pay runs: wanted, not built** (question 7).
     NetSuite runs off-cycle payrolls, so a later stage adds an "extra
     pays only" pay run on its own pay date, with its own examples.
219. **A higher rate on request: not built yet** (question 8). The same
     summarised read of the specification (decision 213) says "The
     employee can notify their employer to choose a higher tax rate" (s
     5.11.1 note 2; Income Tax Act s RD 10(2)), with elected rates of
     17.5%, 30%, 33% or 39% for primary and secondary extra pays. It's
     wanted (it's the employee's right). Step 3.4 of s 5.11.1 (read 2 Oct
     2026 in Chrome): "If the employee has elected to have extra pays
     deducted at a higher rate, the tax rate is either 17.5%, 30%, 33% or
     39% whichever they have elected." Still to read before building:
     5.11.2's secondary steps and whether an election applies on
     termination (5.12). The next extra pay item to build.

### R&D claim (RD42 questions 1-4)

220. **Part-time R&D staff earn credit from approved timesheets**
     (question 1): settled by P9 (TS5-TS9); without timesheets only a 100%
     R&D allocation counts (decision 34).
221. **Reimbursements on pay runs stay out of the claim** (question 2).
     Tagging them as materials is a later stage with its own example.
222. **Feedstock: not built** (question 3). Recording the output's value
     at year end is a later stage with its own example (IR1240's feedstock
     rules).
223. **Exports keep the summary figures, not the file** (question 4, kept;
     decision 74): a kept file would hold each employee's pay.
224. **Where these replace earlier decisions**: 192 replaces 92's Monday;
     199 and 200 replace 107's unstored week and "assumed" salaries where
     there's a usual week.

## Earlier payroll questions, decided (2 Oct 2026; decisions 225-269)

The "Questions for Jess" lists for payroll stages P1b-P6 (allocation, pay
runs, paying wages and IRD, bank files, payslips, the payday filing file),
decided by law → NetSuite → Xero as Jess asked, or marked as answered by a
later stage. "Kept" means as built, with the reason. Some stay with Jess
because only she, a bank or IRD can answer them; those are listed at the
end of each group.

### Allocation, pay rates and payroll access (after PE13)

225. **A pay period spanning an allocation change is charged by the
     allocation on the pay date** (kept, PRUN3): the journal is dated the
     pay date. Since P9, approved timesheets split by the days they cover.
226. **A rate dated before the last posted pay run becomes back pay**
     (answered by P12: back pay from pay rate history, XP5-XP7). An
     allocation dated earlier changes only pay runs approved afterwards;
     posted pay runs are never changed.
227. **One employee group per employee** (kept; Xero's employee group).
228. **A pay group's frequency must match the employee's** (kept): it
     catches a mismatch rather than silently changing someone's pay.
229. **The last person with payroll access can't be removed, even by an
     owner** (kept): someone must always be able to run payroll; an owner
     can give themselves access first.
230. **Payroll needs the bookkeeper role as well as payroll access** (kept;
     decision 105): a viewer can't post.
231. **Leftover cents go by largest remainder, the earlier line on a tie**
     (kept, PE3): the usual fair rounding, and it never moves more than a
     cent per line.
232. **Allocation lines need a Department, Class, Location or project**
     (kept, PE5): an untagged line says nothing about where the cost goes.
233. **Access stays recorded when someone is moved down to viewer** (kept):
     it's unused while they're a viewer (decision 230), and moving them back
     up shouldn't silently restore or lose it without an admin seeing it.

### Pay runs (after PRUN11)

234. **KiwiSaver 3% isn't changed to 3.5% by Tohyee** (question 1, kept):
     the rate is the employee's choice (or a temporary rate reduction IRD
     approved), so the pay run refuses 3% after 1 April 2026 and the person
     running pay updates the employee.
235. **Pay rate changes inside a period stay refused** (question 2, kept):
     prorating by days, working days or hours depends on the agreement.
236. **Costs split by the allocation on the pay date** (question 3, kept;
     decision 225).
237. **Salary per period and hours × rate rounded half up** (question 4,
     kept): IRD truncates only PAYE and contributions.
238. **Separate IRD liability accounts** (question 5, kept): IRD's payments
     and the PAYE summary report them separately; NetSuite keeps a
     liability per payroll item.
239. **Projects: answered by P3 and P9**: postings carry the project tag
     and timesheet shares carry projects to labour cost (PREP2).
240. **Monthly hourly employees: answered by P8 and P9**: the usual pay
     from the usual week (decision 148) or approved timesheets give the
     hours.
241. **The approver rule applies to everyone, admins and owners
     included** (question 8, kept as built): a control that the most
     senior people can skip isn't one.
242. **One journal line per pay item** (question 9, kept): NetSuite posts
     by payroll item, and it lets the ledger show overtime apart from
     ordinary time.
243. **Monthly periods are calendar months** (question 10, kept for now):
     other monthly cycles (15th to 14th) need their own example; not
     built.
244. **Paying in advance allowed; a pay date before the period starts
     refused** (question 11, kept).
245. **Adding someone back to a draft: not built** (question 12): delete
     the draft and start again.
246. **A pay item split differently from the allocation: answered by P9**
     (question 13): timesheets split by what was worked; a fixed per-item
     override isn't built.

### Paying wages and IRD (after PPAY12)

247. **Bank files: answered by P5** (question 1): ANZ, ASB and BNZ from
     their published specifications; Westpac and Kiwibank wait for theirs.
248. **No warning at $500,000** (question 2, kept): IRD tells each employer
     how often to pay; the setting follows IRD's letter.
249. **December for monthly payers stays 20 January, as IRD's page showed**
     (question 3, kept): still to check against IRD's IR328 calendar
     (Jess).
250. **Public holidays in IRD payment due dates: still weekends only**
     (question 4). "Working day" for tax has since been read (decision
     326), but which rule moves a payment due on a non-working day, and to
     when, wasn't found; IRD's own 16-31 December rule (15 January) is
     already built. Not built until that rule is read.
251. **Voiding a pay run IRD has been paid for stays refused** until the
     IRD payment is voided (question 5, kept): a credit with IRD is IRD's to
     give.
252. **Wages can't be paid before the pay date** (question 6, kept): the
     wage payment is dated the payment; paying early would mean the pay run
     dated after its own payment.
253. **A pay run is paid as a whole or per employee, not both** (question
     7, kept).

### Bank files (after PBF7)

254. **ANZ's header comma and total without a space** (question 1, kept as
     built): still for Jess to check with one upload.
255. **Zero-filling and CR line endings** (question 2, kept as built):
     still for Jess to confirm with a test upload.
256. **Account numbers are checked for shape only** (question 3, kept):
     the banks' check-digit rules need a published source first.
257. **Particulars "Wages", code PAYRUN-n, reference the pay date**
     (question 4, kept); an employee's own code is a later option.
258. **ANZ transaction code 50** (question 5, kept): the only code on
     ANZ's page.
259. **Westpac and Kiwibank wait for their specifications** (question 6,
     kept).

### Payslips (after PSLIP6)

260. **ERA s 130: read on 2 Oct 2026** (question 1; decision 326):
     it's the wages and time record, not payslip content.
261. **Hours each day: answered by P9** (question 2): approved timesheets
     record them (s 81(2)(c)).
262. **The payslip shows the account the pay went into** (question 3):
     approving a pay run keeps each employee's bank account (encrypted)
     with their pay (PSLIP7, tenant migration 0078); pays approved before
     that show the employee's current account.
263. **Neither the IRD number nor an employee number** on payslips
     (question 4, kept): neither is required, and leaving the IRD number off
     keeps it out of emails.
264. **The payslip email's text stays fixed** (question 5, kept): no pay
     figure ever sits in a stored message.

### Payday filing file (after PF9)

265. **Try a file in myIR** (question 1): still for Jess.
266. **The employee details file: a later stage** (question 2): it needs
     split addresses, phones and KiwiSaver codes on employees first.
267. **One file per pay run** (question 3, kept; decision 56).
268. **The employer IRD number stays its own setting** (question 4, kept):
     a GST number is usually the same number, but it may not be (an
     organisation in a GST group, say), so it isn't copied.
269. **Salaried hours paid stay 0 unless lines carry hours** (question 5,
     kept; decision 59): IRD's spec allows "0 if not held". Leave lines
     carry hours since P8.

## Accounting questions, decided (2 Oct 2026; decisions 270-325)

The remaining "Questions for Jess" lists, decided by law → NetSuite → Xero
as Jess asked. IRD's [taxable supply information](https://www.ird.govt.nz/gst/tax-invoices-for-gst/how-tax-invoices-for-gst-work)
page was read on 2 Oct 2026 through the summarising fetch tool (quotes as
returned). "Kept" means as built, with the reason; "later" means wanted but
needing its own worked examples first.

### Printed documents, quotes and repeating invoices

270. **Over $1,000 the buyer's identifier can be any of IRD's: an address
     (physical or postal), phone number, email address, trading name (if
     different), NZBN or website** (IRD's list). Tohyee prints the billing
     address, else the contact's email, else their phone, and warns only
     when the contact has none of them (PD4). Built.
271. **Approved invoices keep the heading "Tax invoice"** (kept): IRD's page
     no longer needs the words, but they do no harm and match Xero.
272. **Quotes: sending will move a quote on once emailing quotes is built**
     (Xero); finalising stays its own step until then (kept).
273. **Changing a repeating invoice's schedule starts it from today** (kept).
274. **A repeating invoice left as a draft isn't emailed to anyone**
     (kept): the draft says why it wasn't approved (MC52); notifying admins
     by email is later.

### Sales orders (the unlabelled list after SO examples)

275. **Accepting a quote offers both, as built**: "Accept" makes the
     invoice and "Accept as sales order" (NetSuite's estimate to sales
     order) sits beside it. Making the sales order the default would push
     every small organisation through an extra step; organisations that
     use sales orders choose it.
276. **Line discounts: later** (NetSuite uses discount items, Xero a line
     %); price levels for now.
277. **Closing is per order** (kept); per-line closing and reopening are
     later.
278. **Approved orders stay locked** (kept, like purchase orders): change by
     closing and making another.
279. **A credit note doesn't give quantity back to the order** (kept):
     NetSuite uses return authorisations, a later stage.
280. **"Partly billed" stays** (kept).

### Purchase orders

281. **A part-billed purchase order can be closed** ("Close the rest";
     Xero's "mark as billed", NetSuite's close), when nothing is on a draft
     bill: what's left no longer shows as on order. Built (PO10, tenant
     migration 0076): posts nothing; its approved bills can still be voided
     and it stays closed; no new bills come from it.
282. **Approved purchase orders stay locked** (kept): cancel and copy.
283. **Extra delivered goes on a separate bill line** (kept).
284. **The delivery address starts as the postal address** (kept); a
     delivery address setting is later.

### Repeating bills

285. **A taken number stops the template at that date** (kept): it may be
     the same bill, so the person checks.

### Stock transfers

286. **Transfers keep posting between locations on 1400; cost of sales
     lines stay untagged** (kept): changing ST2's journals needs its own
     example. The stock report by location is the source of truth.
287. **A transfer into a location below zero stays refused** (kept).

### Budgets

288. **Variance is actual less budget for every row** (kept): one rule,
     shown with a sign.
289. **Budgets for balance sheet accounts: later** (Xero has them).
290. **One tracking value per budget** (kept); combinations are later.

### Expense claims

291. **No "submit only" role yet** (kept): Xero's submit-only role is
     later, with the projects and timesheet questions about a "time only"
     role (decisions 193, 298).
292. **Admins and owners can approve their own claims** (kept): a
     one-person organisation must still work; bookkeepers can't.
293. **Receipts over $200 need the supplier's GST number to claim GST**
     (IRD's page: the GST number is required over $200, not at $200 or
     less). Built (EC13, tenant migration 0077): a receipt has the
     supplier's GST number, and approving is refused while a supplier's
     receipts on one day add up to more than $200 with GST claimed and none
     of them has it.
294. **2010 Expense claims payable stays** (kept).
295. **The claim date defaults to the approval date** (kept).

### Fixed assets

296. **The five fixed asset questions are folded into the ERP fixed assets
     plan** (docs/TODO.md, list of 2 Oct 2026, item 4;
     `docs/sources/nz-fixed-assets-reporting-changes.md`): tax depreciation
     beside book, depreciation recovered to its own account, low-value
     write-offs and pooling, and IRD's disposal-year rules all belong
     there. As built until then.

### Projects

297. **Time invoices at exact hours** (kept): rounding to 6 or 15 minutes
     is a firm's choice; later as a setting.
298. **No "time only" role** (kept; decision 193's reasoning).
299. **Closing with a write-off stays; reopening doesn't undo it** (kept):
     the write-off is posted history.
300. **Profitability for the project's life** (kept); date ranges and
     credit notes linked to projects are later.
301. **No automatic "Project" segment** (kept): projects already tag
     lines.
302. **Foreign projects: costs only** (kept, MC63).
303. **A won foreign opportunity's draft invoice is zero-rated** (kept,
     MC69; the person can change it before approving).
304. **A customer's currency stays fixed once they have a project or
     opportunity** (kept, as quotes).
305. **Currencies without cents stay refused for projects** (kept).

### Multi-currency

306. **A USD tax invoice shows its GST in USD only** (kept): IRD's page
     read doesn't say GST must also be shown in NZD (**unverified**:
     the GST Act wasn't read).
307. **Payments basis, part-paid foreign sales: still refused** (question
     2): it's a GST rule, and IRD's guidance on it wasn't read.
308. **No automatic exchange rate feed** (question 6, kept): rates are
     typed or pasted; a free RBNZ feed is later.
309. **Refunds treated like payments** (question 7, kept).
310. **Stock on a foreign bill at the bill's rate** (question 11, kept;
     NetSuite's variance needs item receipts Tohyee doesn't have).
311. **The reverse charge on imported services stays refused** (kept;
     exports question 3).

### Bringing in existing books

312. **The 0.05 GST rounding allowance stays** (kept).
313. **A bank account's opening balance is its ledger balance** (kept, as
     Xero); entering unpresented items as opening transactions is later.
314. **Control accounts matched by name and re-coded** (kept): needed for
     any system's file, which is what Jess wants (TODO item 5).
315. **Contacts without customer or supplier columns are both** (kept).

### Year end and period close

316. **A bookkeeper can close a month when every check passes** (kept);
     warnings still need an owner or admin.

### Sales platform connections (Shopify)

317. **Guest checkouts go to one contact chosen on the connection**
     ("Shopify customers", say), as some connectors do; refused until one
     is chosen. Whether the order is an export
     comes from the order's own billing country, not that contact. Built
     (SPC24).
318. **Payouts with chargebacks, reserves or other kinds stay refused**
     (kept): where a chargeback goes needs its own example. Replaced for
     chargebacks and reserves by decisions 448-450 (5 Oct 2026).
319. **Adjustments go to the fees account** (kept).
320. **A paid order is invoiced on the day it was paid** (kept): that's
     when the sale is settled; the sales order keeps the order's date.
321. **Refund line subtotals include tax on taxes-included orders** (kept,
     still to check with one real refund; Jess).
322. **Shipping goes to the shipping account chosen in settings** (kept;
     it can already be its own account).

### CRM stages and forecasts

323. **The starting probabilities stay** (kept; Jess can change them under
     CRM › Stages).
324. **Forecasts keep currencies apart and quotas count NZD only** (kept;
     MC68): converting needs a rate rule, later.
325. **Per-owner forecasts** (kept); teams and manager adjustments later.

### Working days for tax (decision 326)

326. **The payday filing due date counts tax working days** (PF6; replaces
     decision 63). The Tax Administration Act 1994 s 23E(2)(b) gives
     "within 2 working days after payday"; the Act has no definition of
     working day, so s 3(2) takes the Income Tax Act 2007's (s YA 1): not a
     Saturday, Sunday, Waitangi Day, Good Friday, Easter Monday, Anzac Day,
     the Sovereign's birthday, Matariki or Labour Day, nor the Monday after
     Waitangi or Anzac Day when it falls on a weekend, nor 25 December to
     15 January. Anniversary days and the Holidays Act's Christmas and New
     Year transfers aren't in it. Read on 2 Oct 2026 in Chrome
     (`docs/sources/working-day-tax.md`). The movable dates come from P8's
     public holiday data (2025-2027); later years count them as working
     days until added, so the date shown is never later than IRD's. ERA s
     130 was read the same day (`docs/sources/employment-relations-act-s130.md`):
     it's the wages and time record (hours each day and the pay for them,
     kept 6 years, given to the employee on request), not a list of what a
     payslip must show, so decision 260's question is answered: the
     payslip follows Holidays Act s 81 and Employment NZ's guidance, and
     P9's timesheets and the usual week (s 130(1B)) keep the hours.

### A won opportunity to a sales order (decision 327)

327. **A won opportunity can make a draft sales order instead of an
     invoice** (CRM5b; the handover's "won opportunity → sales order", not
     built until now). NetSuite turns an opportunity into a sales order;
     Tohyee keeps the invoice too (CRM5), so the opportunity offers both
     and keeps whichever was made: one or the other, never both (the
     database refuses both). The sales order's line, account and tax code
     follow the invoice's rules (EX15), dated today, in the company's
     currency with no rate (SO10); it posts nothing and is approved and
     invoiced like any sales order. Once made, the opportunity's stage and
     company are fixed, as with an invoice. Tenant migration 0079.

### Updates and server stats (decisions 328 to 332)

Jess asked (2 Oct 2026) for the server to check for updates by itself,
notify when one is out, and update without breaking anyone ("migrate the
server to the updated version so it doesn't break them"), and for
performance and usage stats like a media server's dashboard. She chose **notify, then one-click
install** (like a media server) and **stats in the Windows server app only**. These
are server features, not accounting, so they have tests rather than worked
examples.

328. **Tohyee checks GitHub for a new release by itself**: a minute after
     it starts, then every 24 hours (and "Check now" any time). The answer
     is kept in memory only (it's GitHub's, not Tohyee's). The tray icon
     asks the server hourly over the local-only address, without signing
     in (`GET /api/updates/status`, counts only, no organisation names),
     shows a Windows notification once per version each time it starts,
     and adds "Install Tohyee vX…" to its menu. The server settings pages
     show a banner to server admins. Off with `TOHYEE_UPDATE_CHECK=off`.
329. **Install backs everything up first** (`POST /api/admin/updates/prepare`):
     it checks GitHub again, refuses if a newer version than the one the
     person agreed to has come out, then backs up every organisation and
     the server's own database (backup runs marked `update`, core migration
     0004). If any backup fails, nothing is downloaded or installed and the
     failures are shown. The backups are the way back: the start-up
     upgrades refuse to run an older version against an upgraded database,
     so an update can't be undone by reinstalling the old version, only by
     restoring these backups (as a copy).
330. **Each server start is recorded** (core table `server_starts`,
     append-only, written by the server as it starts, never typed in): the
     version, the version before it, the core upgrades applied, and how
     many organisations were checked, upgraded and blocked (with each
     blocked one's error). After an update this is how the server app
     knows the new version came up and whether any organisation's upgrade
     failed. An organisation whose upgrade fails is still blocked (not
     half-upgraded: each migration is all or nothing), as before; the
     Updates page lists blocked organisations with their errors.
331. **The download is checked before it's run.** The server hands the app
     the release's `TohyeeSetup-<version>.exe` (only from Tohyee's GitHub
     releases) and its SHA-256: GitHub's own digest of the file if the
     release has one, otherwise the `.sha256` file the release build
     uploads beside it. With neither, Install is refused and the person is
     told to download it from the release page. The app downloads it,
     compares the SHA-256, deletes it on a mismatch, then runs it with
     `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /RESTARTTRAY=yes` (Windows
     asks for permission) and logs to Tohyee's logs folder. The installer
     stops the services and the app, replaces the program, starts Tohyee
     (which upgrades each organisation as it starts) and, because of
     `/RESTARTTRAY=yes`, starts the app again. A note in the person's local
     app data says what was being installed; the restarted app waits for
     the server, reads the start record and shows a notification: all
     organisations working, some blocked (click for details), or the
     update didn't finish within 20 minutes (with the log's location).
     The SHA-256 protects against a broken or tampered download, but comes
     from the same GitHub release as the installer, so it doesn't protect
     against someone who controls the GitHub account; the installer isn't
     code-signed yet (unverified whether that's wanted; not decided here).
     On Linux and Docker the Updates page says how to update by hand, as
     before.
332. **Stats, in the Windows server app only** (Jess's choice). Once a
     minute the server samples the computer's CPU and memory, Tohyee's own
     CPU and memory, API requests (count, average and slowest time, server
     errors), people who made a signed-in request in the last 5 minutes,
     and database connections, and keeps 24 hours in memory (a restart
     starts again; nothing is stored). Database sizes (the server's and
     each organisation's) are measured every 15 minutes; disk space is
     read for the disks holding Tohyee's program and the backup folder.
     The app's Stats page shows the figures now, graphs over 1, 6 or 24
     hours, disks, database sizes and what the server runs on, refreshing
     every 15 seconds. Only counts are kept about people, never who. Off
     with `TOHYEE_SERVER_STATS=off`.

### Tonight's try-out fixes (decisions 333 to 338)

From Claude using Tohyee on Jess's server on 2 Oct 2026 (docs/TODO.md);
Jess asked for them all to be done. Decided by law, then NetSuite, then
Xero, as she asked.

333. **Default payment terms for invoices and for bills** (examples DT1,
     DT2). No law sets them. Xero has a default due date for sales
     invoices and one for bills in its invoice settings; NetSuite has a
     default terms preference. So the organisation can choose one of its
     payment terms for each (Settings › Payment terms and customers ›
     Default terms); a contact's own terms win; with neither, the due date
     is typed, and the invoice or bill now says so plainly instead of
     only the browser's "Please fill out this field". Tenant migration
     0080.
334. **A new customer or supplier can be added from the invoice or bill**
     ("+ New customer…" / "+ New supplier…" in the list: name, email, GST
     number), as Xero lets you type a new contact there. Not accounting;
     recorded so it isn't undone.
335. **The GST return opens on the two months that ended last month** when
     there's no GST period setting and no filed return, instead of the
     period still going. With a setting or a filed return it already
     opens on the right one (GP4). The two-month periods' alignment
     depends on the organisation's registration, which Tohyee can't know
     without the setting, so the page still asks for it.
336. **Registering an asset after a run that covered its purchase month
     stays allowed and catches up in the next run** (FA6, kept). A refusal
     (as Xero does) was tried and dropped because FA6 already decides it
     NetSuite's way. What went wrong in BigDog was the run into the future
     (decision 337), which put the catch-up in the wrong year.
337. **Depreciation can't be run past the end of the current month**
     (example FA15). Depreciation is for the months used; posting months
     that haven't happened puts them in this year's profit and loss. Rolling
     back is unchanged.
338. **New products and services start with the first revenue account and
     the standard GST code for sales** (as new invoice lines already do), so
     picking one on an invoice fills them in. They can be changed or
     cleared. Purchases stay blank.

### Connect your own AI (decisions 339 to 345)

Jess asked for an "AI" heading in Tohyee "to bring in your AI", and chose
"Connect your own AI: add your Claude/ChatGPT … or connect it as a tool
(MCP) so it can read the books and answer questions" (2 Oct 2026). This
builds the MCP route, read-only to start. The page is
`/operations/ai`; the top bar's "AI" menu item is being added separately
with the top bar redesign.

339. **Tohyee is an MCP server that people's own AI connects to.** MCP (the
     Model Context Protocol) is what Claude (Desktop, Claude.ai custom
     connectors, Claude Code), ChatGPT connectors and many other AI apps
     use to call tools, so one endpoint (`POST /api/mcp`) serves them all
     and Tohyee needs no AI provider account, API key or model of its own:
     the person's AI does the thinking, under their own account and terms,
     and asks Tohyee for figures. Nothing is sent to an AI service unless
     the person connects one. The page says that what the AI reads goes to
     that AI service.
340. **Personal AI keys, per person per organisation, hashed.** A key is
     `tohyee_ai_` followed by 32 random bytes as base64url, shown once when
     it's made; the core database keeps only its SHA-256 (hex), the first 8
     characters after the prefix (to tell keys apart), its name, who made
     it and when, when it was last used and when it was revoked
     (`ai_access_tokens`, core migration 0005). Keys live in the core
     database next to sessions because they identify a person, like a
     session; no accounting data is kept there. A key is for one
     organisation only, so a bookkeeper with several clients makes one key
     per client and an AI can never mix books.
341. **When a key works.** Only while it isn't revoked, its owner's login is
     active and they're still a member of that organisation (looked up on
     every request, so it carries their *current* role); the organisation
     must be ready, as for any request. Removing someone from an
     organisation revokes their keys for it, so adding them back doesn't
     revive old keys. Keys are revoked, never deleted, so the list shows
     what was made. At most 10 keys that aren't revoked per person per
     organisation. Making and revoking keys are recorded in the core audit
     trail (`ai_access_token.created` / `.revoked`, with the key's name and
     start, never the key). Only the owner of a key sees or revokes it;
     admins can remove a person, which revokes theirs. Any member (viewer
     and up) can make keys for themselves, since a key can do no more than
     what they can already do themselves (its level is capped by their role,
     decision 346).
342. **Read-only, enforced by PostgreSQL** (for the read tools; since decision
     346 a key can also be allowed to make drafts and post). Every read tool call runs in its own
     transaction on the organisation's database with `set transaction read
     only` (`withOrganisationTransaction(..., { readOnly: true })`), so an
     insert, update, delete, `nextval` or `select ... for update` fails
     whatever the code does. The tools reuse the services the screens
     call: the organisation's settings, chart of accounts, profit and loss,
     balance sheet, trial balance, aged receivables and payables, invoices,
     bills, contacts, account transactions and the GST return worked out
     for a period (nothing filed or stored). The only new queries find an
     invoice by its number and a bill by the supplier's invoice number.
     **No payroll**: pay, employees, leave and payroll reports are left out
     whatever the person's payroll access (journal lines on wages accounts
     are in account transactions, as for any viewer; they never name
     anyone, decision 6). Every tool is listed with MCP's `readOnlyHint`.
     Writing (drafting an invoice, coding a bank line) would be a later
     decision, with its own approval step.
343. **Bounded answers and a light rate limit.** Lists are capped (invoices
     and bills 50 by default, at most 200; contacts 100, at most 500;
     account transaction lines 200, at most 1,000; aged report rows 300 with
     50 documents each; document lines 300), and any answer over 200,000
     characters of JSON is refused with a hint to narrow it, so an AI can't
     pull megabytes. Each key can make 120 requests a minute, counted in
     memory (a restart starts again; one server process). A refused
     request gets HTTP 429.
344. **MCP as Tohyee speaks it.** The "Streamable HTTP" transport in its
     simplest stateless form: each POST carries one JSON-RPC 2.0 message
     (or a batch, as 2025-03-26 allowed) and gets one `application/json`
     answer; notifications get 202 with no body; GET and DELETE get 405
     (no event stream, no `Mcp-Session-Id`). Methods: `initialize` (echoes
     a supported protocol version, 2025-11-25, 2025-06-18, 2025-03-26 or
     2024-11-05, else answers 2025-06-18; capabilities `tools` only;
     `serverInfo` name `tohyee` and the app version), `ping`, `tools/list`,
     `tools/call`, and empty `resources/list` and `prompts/list`. An
     `MCP-Protocol-Version` header naming an unknown version gets 400. A
     tool's own failure (a bad date, an invoice that isn't there) is a
     normal result with `isError: true` and the message, so the AI can
     correct itself; an unknown tool is JSON-RPC error -32602. Built from
     the specification as we understand it; not yet tried against each AI
     app (see the handover).
345. **Authentication is the key alone.** `/api/mcp` accepts only
     `Authorization: Bearer tohyee_ai_…`; it ignores session cookies, so a
     signed-in browser can't use it and a session token isn't a key. It has
     no same-origin check because AI services call it from elsewhere; it
     sends no CORS headers, so a web page on another site can't call it
     with a key from a visitor's browser. Every refusal (no key, unknown,
     revoked, owner left or disabled) is the same 401 with
     `WWW-Authenticate: Bearer`. It's the second route, after the sales
     platform webhook, that doesn't use a session. There's no OAuth sign-in
     yet: AI services that only accept OAuth connectors can't connect
     until there is (the page says so). `last_used_at` is updated at most
     once a minute; individual reads aren't written to the audit trail,
     like reading a report on screen isn't.

### AI that drafts and posts, and draft journals (decisions 346 to 352)

Jess, on the read-only first version (3 Oct 2026): "Why can't it draft
journals? Should be able to do anything if you want it to except delete too
much." So keys get an access level, the AI can make drafts and post them,
and manual journals get drafts (Xero has draft manual journals). This
widens decision 342: read tools stay read-only; the new tools write.

346. **Each AI key has an access level, chosen when it's made.** "Look only"
     (`read`, the default), "Make drafts" (`draft`: also add and edit
     contacts, and make and edit draft invoices, bills and journals; nothing
     posts) and "Make and post" (`post`: also approve invoices and bills,
     post draft journals and record payments). Stored on the key
     (`ai_access_tokens.access_level`, in core migration 0005, which wasn't
     released yet). The level is capped by the person's role every time the
     key is used, with the same role the screens' routes need: making
     contacts and drafts, approving, posting and recording payments all need
     bookkeeper or higher, so a viewer's key only ever looks, whatever level
     it was made with (and gains its level if the person is later made a
     bookkeeper; the page says so). `tools/list` shows only the tools the key
     may use now; calling any other is refused with a message saying which
     level and role it needs.
347. **The AI never deletes.** No tool deletes, voids, archives, rolls back,
     refunds, removes, unreconciles or reopens anything, not even a draft,
     at any level; there are no such tools and the write tools take no flag
     that does it (e.g. `update_contact` can't archive). Approving an invoice
     or bill, posting a journal and recording a payment can only be undone by
     a person in Tohyee (void, correct). Jess said "except delete too much";
     we took "never delete" because a deletion by an AI is the one thing a
     person can't check and put right afterwards.
348. **Write tools act as the person, through the key, and say so.** The
     tools are `create_contact`, `update_contact`, `create_draft_invoice`,
     `update_draft_invoice`, `create_draft_bill`, `update_draft_bill`,
     `create_draft_journal`, `update_draft_journal` (draft level) and
     `approve_invoice`, `approve_bill`, `post_draft_journal`,
     `record_invoice_payment`, `record_bill_payment` (post level), plus the
     read tools `list_draft_journals` and `get_draft_journal`. Each calls the
     service the screen uses (same checks; payments only into bank and card
     accounts, as CP8), in a normal transaction (read tools stay read-only),
     as the key's owner, so records show the person (`created_by_email` and
     so on). The key is added to every audit event the call writes
     (`details.via`, e.g. `AI key "Claude on my laptop"`), so a record's
     history shows "Jess via AI key …"; drafts also keep it in their own
     columns. Creating, approving and paying take an optional idempotency
     key kept per AI key (command source `ai-<key id>`); left out, one is made
     up, so only a call that sends the same key is safe to retry. Edits
     don't take one: the same edit twice gives the same result.
349. **Draft manual journals, like Xero's** (examples MJD1-MJD9, tenant
     migration 0081). `ledger_journal_drafts` and `..._lines` hold what a
     manual journal holds (date, reference, description, custom fields;
     lines with account, description, debit or credit, tracking, custom
     fields and a typed foreign amount and rate; journals have no tax
     codes), who saved, changed and posted it (and through which AI key), a
     status (draft or posted) and the posted journal's id. A draft posts
     nothing and isn't in any report.
350. **A draft is checked like a journal when it's saved**: two or more
     lines, each a debit or a credit, debits equal to credits, amounts in
     cents, active accounts that exist. The checks that depend on the day it
     posts (the period being open, required tracking and custom fields, the
     inventory account, foreign amounts against their rates) run when it's
     posted. Xero may let an unbalanced draft be saved (unverified); Tohyee
     doesn't, so every draft can be posted as it stands and an AI can't
     leave half-made journals.
351. **Posting a draft goes through the usual path, exactly once.** It calls
     `postJournal` (origin manual, command source `journal-draft`,
     idempotency key `journal-draft-<id>`) with the draft locked, then
     marks it posted with the journal's id, who posted it and when. Posting
     a posted draft returns the same journal. If posting is refused (a
     locked period, MJD6) nothing changes and it stays a draft. The journal
     is posted by the person who posts the draft. A posted draft can't be
     changed or deleted; the database refuses it too. Corrections are made
     to the journal (C1), not the draft.
352. **People can delete drafts; screens.** Bookkeepers and up can save,
     edit, post and delete drafts (viewers can see them), the same role as
     posting a journal. The journal page has "Save as draft" beside "Post
     journal", and a "Draft journals" list (shown when there are any) with
     Edit, Post and Delete, which is less disruptive than a new page or
     tabs. Deleting a draft is allowed because nothing was posted; AI keys
     can't (decision 347).

### Analytics (decisions 353 to 362)

Jess wants analytics next ("might actually be able to use that at work"):
data in like Looker Studio, reports like Power BI, a folder of CSV files on
the server (up to about 1M rows) reloaded daily, Tohyee's own books and CRM,
and report emails from Google, Meta and others saved into that folder. The
review behind these is `docs/ANALYTICS-REVIEW.md` (3 Oct 2026). Her answers
the same day: analytics is per organisation when it's turned on; clients
see only what's shared with them and must sign in, as for accounting; use
GitHub's coding agent for parts of the build; mailbox choices to be decided
when that step comes.

353. **Analytics is a module switched on per organisation**, like the CRM
     (`analytics_enabled` in the organisation's settings). No organisation
     sees another's analytics. Reporting across client organisations (for
     practices) is left for later and needs its own decision.
354. **Each organisation's analytics data is one DuckDB file** beside its
     database in Tohyee's data folder, not in PostgreSQL, so loaded CSVs
     never grow the organisation's database or its backups. DuckDB (MIT)
     runs inside the server through `@duckdb/node-api`; nothing else is
     installed. Tested 3 Oct 2026: 1M CSV rows load in under a second and
     the report queries take 12-44 ms.
355. **Definitions live in the organisation's PostgreSQL database; data is
     rebuildable.** Sources, column types, load settings, shaping steps,
     measures, reports, dashboards and sharing are kept in PostgreSQL (backed
     up and restored with the organisation). The DuckDB file holds only
     loaded data and can always be rebuilt by loading again.
356. **Money is never loaded as a floating-point number.** When a source is
     set up, its columns' types are confirmed (detected types shown as a
     preview); money columns load as `DECIMAL(18,2)` (or more places where
     confirmed) and quantities as `DECIMAL(18,4)`. In the 3 Oct test,
     DuckDB's own guess (double) gave a total that changed in the 7th
     decimal place between runs; decimals were exact and matched
     PostgreSQL to the cent.
357. **A load replaces a table only when it succeeds.** Each load writes a
     new table and swaps it in at the end; a failed or partly read file
     leaves yesterday's table in place. Loads run nightly and on demand.
     Every load is recorded by the loader (source, file, rows, time taken,
     error), never typed in.
358. **The source folder is chosen by a server admin.** Organisation owners
     and admins set up sources inside it, but the folder on the server's disk
     is a server setting, so an organisation can't point Tohyee at other
     folders on the server.
359. **Tohyee's own data is copied, not queried live.** A fixed, documented
     set of tables (journal lines with accounts and periods, invoices and
     bills with lines, contacts, items, CRM records and activities) is
     copied from the organisation's database in a read-only transaction
     using Tohyee's own PostgreSQL driver (DuckDB's PostgreSQL plug-in
     downloads itself and isn't used). Column names stay stable between
     versions. Figures that must agree with Tohyee's reports (sales, gross
     margin) need worked examples before this is built.
360. **Clients see analytics only by signing in**, the same as for the
     books, and only the dashboards shared with them. This needs a new
     access ("report viewer") that sees nothing else of the organisation; no
     public links.
361. **Charts with Apache ECharts, pivot tables with Perspective** (both
     Apache-2.0). Metabase, Superset, Lightdash and Redash aren't bundled
     (each needs Java, Python or Docker), and Elastic-licensed tools
     (Airbyte, dbt Fusion) can't be. Their licence and NOTICE files ship with
     the installer.
362. **Report emails come from a chosen folder or label in a mailbox Tohyee
     can already read.** Tohyee saves CSV, Excel and zipped CSV attachments
     into the organisation's source folder, remembers which messages it has
     saved, and never moves, marks or deletes mail. Which mailboxes (Google
     Workspace, personal Gmail, Microsoft 365, Outlook.com) and how
     (Google/Microsoft app or IMAP app password) is decided before that step
     is built: a Google app in "Testing" loses access after 7 days, which
     affects personal Gmail (and the CRM email sync now).

### GST late claims (decisions 363 to 366)

Jess's issue #88: a change dated in a period whose return was filed was
ignored by every later return. She asked to follow Xero, and to show IRD's
rules rather than enforce them ("just say IRD says this but if you want we
can"; practices "just jammed it into sales or expenses"). Examples LG1-LG7,
approved 3 Oct 2026.

363. **Late claims are worked out, not typed in.** For every return filed for
     an earlier period, Tohyee works that period out again on its own basis
     and compares it with what was filed plus what later returns have
     claimed for it. A line now there that isn't accounted for is a late
     claim; a line that was counted and has since gone is taken back off.
     Each transaction is one claim.
364. **Late claims count in the ordinary boxes and are included by
     default** (sales in Box 5/6, purchases in Box 11), like Xero's. Each can
     be unticked; an unticked one is offered again in the next return. The
     filed return they belong to keeps showing "Changed since filed" and
     lists what later returns claimed.
365. **IRD's rules are notes, never blocks.** A missed purchase more than 2
     years before the return's end says "IRD says GST on purchases more than
     2 years old can only be claimed in a few cases" (GST Act s20(3)). When
     the other included late claims add up to more than $1,000 of GST (each
     claim's GST, either way), they say "IRD says changes over $1,000 (or
     over the lower of $10,000 and 2% of output tax) should be fixed by
     amending the earlier return" (TAA s113A). The 2% alternative is quoted,
     not worked out, since nothing is blocked.
366. **Filing stores late claims with the return that included them**
     (tenant migration 0084: `late_from_return_id`, `late_reversal` on
     `gst_return_lines`), with their own dates, so they're never counted
     twice and the filed return's boxes still add up from its lines. Which
     claims were left out is part of the filing request (and its retry
     check).

### Analytics: the books and CRM (decision 367)

367. **The books are copied as they are** (examples AB1-AB10, Jess's
     answers 3 Oct 2026). Each organisation's analytics gets `tohyee_*`
     tables read from its own database in one read-only transaction: ledger
     lines, invoices and bills with their lines, contacts, items, and with the
     CRM on, companies, opportunities and activities. It's the same data,
     row for row. Nothing is worked out to match a report, and amounts keep
     the ledger's sign (debit less credit); a dashboard value can be shown
     "the other way round". Tracking categories and custom fields become
     columns. Pay run lines have no contact and say "Pay run" (no employee
     names). It's copied nightly with the CSV sources, for every
     organisation with Analytics on, and by Refresh now (admins and
     owners); the tables are swapped in together only when all have loaded.
     CSV sources can't use `tohyee_` names.

### Analytics: sharing with clients (decision 368)

368. **Report viewers see only the dashboards shared with them** (decision
     360 built). "Report viewer" is a new organisation access, ranked below
     viewer, so every existing screen and API that needs viewer or more
     refuses it; it only opens the Analytics app. Bookkeepers and up share a
     dashboard with chosen report viewers (tenant migration 0085,
     `analytics_dashboard_shares`; core migration 0006 allows the role); only
     an organisation's report viewers can be chosen, and each change is
     audited. A report viewer can't see the tables, sources or books, or ask
     its own questions: it only runs a shared dashboard's saved tiles, and
     only slices by that dashboard's own slicers (other filters are
     dropped). A dashboard that isn't shared with them is "not found".

### Reports: saving transaction reports as custom (decision 369)

369. **Account transactions, aged receivables and payables, sales by
     salesperson and the journal report can be saved as custom reports**
     (examples CR11-CR15, issue #89, tenant migration 0086), like Xero's
     "Save as custom", with columns from NetSuite's three kinds of custom
     field. Contact and document columns go on every one of these reports;
     line fields and tracking only where a row is one ledger line, so a cell
     never mixes lines. Drafts show contacts as they are now; published
     reports keep what they showed. Anything more (items by category, say)
     is for Analytics, not more report options (Jess, 3 Oct 2026).
### Analytics: shaping (decision 370)

370. **Shaped tables are set up by admins, like data sources** (issue #108,
     tenant migration 0087). Steps are chosen from a fixed list (no typed
     SQL); averages and division are worked out exactly in millionths,
     because DuckDB divides decimals as floating point, and float columns
     can't be summed or calculated until their type is changed. A shape
     can have at most five merge and append steps. Changing or rebuilding a
     shape rebuilds the shapes built on it; when one fails, those are left as
     they were with the reason. A source or shape that another shape uses
     can't be removed. Dashboard averages use the same exact sum.
### Analytics: report emails (decision 371)

371. **Report emails (decision 362) are checked once a night, before the
     reload** (issue #109, tenant migration 0088), and by Check now. One
     message that can't be read never stops a check; a message that keeps
     failing is tried three times in all and left with its reason. IMAP
     servers must be on the internet, not this server's network, and a saved
     password is only sent to the server and user it was saved for. Only the
     person who set a mailbox up can change or check it (it uses their
     connection); any admin can remove it. Replacing files is the default,
     since a data source loads one file by name. Excel attachments wait until
     the loader can read Excel.

### UI review 2026: top bar, dashboard frame and Home (decision 372)

372. **The top bar and Home move to one reusable page-dashboard pattern**
     (issue #115, tenant migration 0089). Accounting now uses one apps
     launcher button and the menus Home, Sales, Purchases, Banking, Payroll,
     Reports and Accountant (Contacts under Sales/Purchases; Accounting and
     Tax combined under Accountant). Non-blocking warnings (for example the
     backup-key reminder and bank-feed reconnect notices) move to a bell with
     a dot; blocking warnings stay banners. Home becomes a four-tile dashboard
     (Cash in bank, Money owed to you, Bills to pay, Next GST return), with
     net profit by month, a To do card and recent activity lines. Dashboard
     hide/show and tile choices are saved per person and per page in
     `dashboard_preferences`.

### Search everything (decision 373)

373. **Ctrl K searches records as well as pages** (issue #116, Jess 4 Oct
     2026, `docs/UI-REVIEW-2026.md`). Records come first, then pages:
     contacts, sales and purchase documents, payments, bank lines, manual
     journals, items, accounts, fixed assets, and with the CRM on, CRM
     people, companies and opportunities.
     - **Matching:** by name, number, reference, email, phone, an amount or a
       date, with "inv", "bill" and "c:" prefixes.
     - **Limits:** at most five of each kind, from two characters.
     - **Access:** it searches only the current organisation, at viewer and
       up. Report viewers get only the names of dashboards shared with them.
       Payroll employees aren't searched.
     - **No indexes yet:** a plain `like` over the words is fast enough for the
       sizes Tohyee is used at; add indexes if that changes.

### Pinned Analytics tiles (decision 374)

374. **A dashboard tile can be pinned to a page with a dashboard frame**
     (issue #119, step 3 of `docs/UI-REVIEW-2026.md`, no migration). Today
     that's only Home; the pages are listed once, in
     `src/lib/dashboard/pages.ts`, so Sales, Purchases, Banking and CRM home
     can be added there.
     - **Stored as a reference:** `analytics:<dashboard id>:<tile id>` in the
       person's own `dashboard_preferences.tiles` for that page, next to the
       default tile ids, still at most four tiles. Nothing of the tile is
       copied. A reference is only read in the organisation it's saved in,
       so it can never name another organisation's dashboard.
     - **Access is checked on every load, not only when pinning.** The page's
       tiles are filtered to the defaults plus the tiles of the dashboards the
       person can open now (a report viewer: only those shared with them,
       decision 368). A pin from a dashboard that's deleted, unshared or no
       longer has the tile, or while Analytics is off, quietly drops off
       (the defaults show if nothing is left); the saved row isn't rewritten,
       so sharing again or switching Analytics back on brings it back, even
       if the person saves the page's tiles in the meantime (decision 378). Saving a reference
       the person can't open is refused as not found (so dashboards can't be
       probed); while Analytics is off, pinning is refused.
     - **Shown through the dashboard query path** (`dashboardId` + `tileId`),
       with the dashboard's own dates and no slicers: a key figure, a small
       chart, or a table's first rows. It has a dashed edge and "From
       <dashboard name>", and opens the dashboard.
     - **Pin to page** is on each tile in Analytics (not while the dashboard
       is being edited); a full page offers to replace one of its tiles. It
       only lists pages the person can open, so report viewers (who can't
       open Home) don't see it.
       Customise lists the page's defaults and the person's pinned tiles.

### Analytics: dashboard pivot tables (decision 375)

375. **A pivot is a saved, read-only dashboard tile** (issue #120). It has one
     to five row fields, zero or one column field, and one to six sum, count,
     average, minimum or maximum values. Date fields group by month, quarter or
     year, as charts do. DuckDB groups the loaded data on the server (grouping
     sets) and returns only pivot cells, with subtotals and grand totals; more
     than 2,000 value cells, totals included, is refused with "Too many rows
     and columns; filter or group further". Rows sort by their fields, each
     group followed by its subtotal, the grand total last; columns sort by
     value. Each cell can open at most 500 matching rows, showing only the
     saved tile's fields (rows, column, values and date). Report viewers can
     run and drill only pivots on dashboards shared with them, with the same
     slicer restrictions as other tiles.
     - Money remains DECIMAL and averages use `exactAverageSql`; every
       subtotal and total is worked out by DuckDB from the underlying rows
       (an average total is the average of the rows, not of the averages),
       never added up in the browser.
     - An accessible HTML table rather than Perspective (which decision 361
       planned): the browser only ever gets at most 2,000 finished cells, so
       Perspective's browser-side engine would have nothing to do but re-add
       them; the current viewer (`@perspective-dev/viewer` 5.5) is 14 MB
       unpacked plus a WASM engine, and its toolbar would need locking down
       to stay read-only. Revisit it for an interactive explore view.
     - CSV and Excel go through the standard report export
       (`/api/reports/export`, report `analytics-pivot`), which report viewers
       may use for pivots only (no PDF; the file is made from what their page
       already shows). Values with more than 15 significant digits, which
       Excel can't hold exactly, go into the workbook as decimal text (this
       applies to every report export).
     - Theme previews: [light](screenshots/analytics-pivot-light.png) and
       [dark](screenshots/analytics-pivot-dark.png).

### Analytics: Excel files (decision 376)

376. **Analytics loads Excel workbooks (.xlsx), and report emails save them**
     (issue #121; tenant migration 0090).
     - **One sheet per source**, chosen at setup (the first visible tab by default)
       and stored on the source (`analytics_sources.sheet_name`). Chart
       sheets aren't offered. Hidden sheets are offered, marked "(hidden)",
       but the default is the first visible tab (Jess, Oct 2026). Setup shows the sheet names and the first rows,
       as for a CSV; the preview reads only the first 20,481 rows.
     - **Same path as a CSV:** the sheet is copied out as CSV text and loaded
       by the CSV loader, so every value is text first and then cast to the
       confirmed type (money `DECIMAL(18,2)`), in a staging table swapped in
       only when the whole sheet loads, with the same errors. The first row
       with a value holds the headings; empty rows are skipped; a value to
       the right of the last heading fails the load (as an extra column in a
       CSV does). The copy sits in the organisation's own work folder
       (`<id>.work`, the only part of the analytics folder its DuckDB may
       read, decision 377) and is deleted afterwards; a copy left by a crash
       is cleared on the next load once it's an hour old.
     - **Values as written:** a number is written as the shortest text that
       reads back as the same number, then rounded by the column type, so
       0.1 + 0.2 (stored as 0.30000000000000004) loads as 0.30 and 2.675 as
       2.68 (half away from zero). A percentage loads as its value (15% is
       0.15). Date-formatted cells, including formula results, load as dates
       or date-times in the 1900 or 1904 date system. Formulas load Excel's
       last worked-out result; an error result loads as text (`#ERROR!`,
       `#DIV/0!`) so a number column fails rather than guessing (Jess
       confirmed both, Oct 2026). Merged cells
       have their value in the top-left cell only.
     - **Read safely:** ExcelJS (MIT, already used for report exports) reads
       the sheet as a stream. Workbooks are capped at 50 MB. Every ZIP entry
       is unpacked and counted before reading (250 MB in all, no entry more
       than 1,000 times its packed size, 2,000 entries, 64 MB of shared text), and
       ExcelJS is given a stream Tohyee builds of only the parts it needs, so
       entries the ZIP's directory doesn't list are never read. DuckDB's
       Excel extension isn't used (it downloads at run time).
     - **Refused with a reason:** old `.xls`, `.xlsm`, an `.xlsx` that holds
       macros or is a binary workbook, and password-protected workbooks.
     - **Report emails** save `.xlsx` attachments as they came, after the
       same ZIP checks, within the 25 MB attachment and 100 MB check limits
       (the unpacked size counts against the check).

### Analytics: what DuckDB may touch (decision 377)

377. **Each organisation's analytics database may only read its own source
     folder and its own work folder** (`<analytics folder>/<id>.work`, which
     also holds DuckDB's temporary files), never the analytics folder as a
     whole, because that holds every organisation's file. That can't be switched off
     afterwards (`allowed_directories`, `enable_external_access = false`,
     `lock_configuration`). File checks use a throwaway database limited the
     same way. Tohyee builds all of its own SQL, so this is defence in depth.
     It means no query can read other files on the server, another
     organisation's folder, or install extensions.
     - When a server admin changes the folder (server app, command line or
       web), the database is reopened with the new folder the next time
       it's used.
     - Shaping previews stop after 10 seconds.
     - The first version allowed the whole analytics folder, which would have
       let one organisation's query attach another's file; fixed before
       release, with a test.

### Pinned tiles: kept while hidden (decision 378)

378. **Saving a page's tiles keeps pins that are hidden at the time**
     (Analytics off, or the dashboard no longer shared with the person), in
     their old places, as long as the dashboard and the tile still exist.
     A pin whose dashboard or tile was deleted goes for good. At most 8 hidden
     pins are kept per page. While hidden, a pin's slot isn't refilled: the
     page just shows fewer tiles (Jess, Oct 2026).

### Analytics: a time limit on every question (decision 379)

379. **Every Analytics question stops after 30 seconds**: dashboard tiles,
     pivot tables, drill-ins, pinned tiles and exports (shaping previews keep
     their 10 seconds). The tile says it was stopped and suggests filtering or
     grouping by fewer fields, rather than tying up the server (Jess, Oct 2026).
     Jess also confirmed that report viewers may drill into up to 500 rows of
     a tile's own fields and export pivot tiles to CSV and Excel (decision 375).


### Bank rules with several conditions and split lines (decisions 380-383)

Stage 1 of the Xero add-ons plan ([XERO-ADDONS-PLAN.md](XERO-ADDONS-PLAN.md)),
examples BR1-BR10, approved by Jess on 5 Oct 2026; tenant migration 0091.
Jess asked Claude to decide the open questions (5 Oct 2026: "do what you
think is best").

380. **A bank rule has conditions joined by all or any, and one or more
     lines** (like Xero's bank rules; NetSuite's bank feed rules also set
     the classification segments): text conditions *contains*, *equals* or
     *starts with* on payee, description, particulars, code, reference or
     any of them, ignoring case and extra spaces; amount conditions
     *equals*, *at least*, *at most* or *between*; up to 10 conditions and
     20 lines. Lines are fixed amounts (taken first) then percentages of
     what's left, adding up to exactly 100%, each with an account, GST code,
     description and tracking. The contact is a chosen one or "the contact
     named like the payee" (as bulk coding finds one). The first active rule
     by priority that matches **and fits** is suggested; a rule whose fixed
     amounts are more than the line doesn't fit. **Rules only suggest**:
     nothing posts until OK (Jess, 5 Oct 2026, no "post automatically").
     Existing rules became one *contains* condition and one 100% line.
381. **A rule's lines include GST**: each is a share of the statement line,
     so a line with a GST code is tax inclusive and one without has no tax.
     The rule's old "amounts are" setting is gone, because "tax exclusive"
     can't add up to the statement line.
382. **Percentages are split in cents the way payroll allocations are**
     (`splitByPercentages`): each share rounded down to the cent, leftover
     cents one at a time to the shares that lost most, earliest first on a
     tie, so the lines always add up exactly. Xero's help doesn't say how it
     rounds; one rule for all of Tohyee's splits is easier to check.
383. **Amount conditions ignore the sign** (money in or out is chosen
     separately); **a percentage line that comes to 0.00 is left out**
     (fixed amounts took the whole line); **"the contact named like the
     payee" stays a contact choice**, and a suggestion with no such contact
     isn't confident and can't be OK'd until one is chosen. Negative
     percentages (which Xero allows) are refused.
     - Screenshots: the rule form ([light](screenshots/bank-rule-split-light.png),
       [dark](screenshots/bank-rule-split-dark.png)) and a split suggestion
       on the reconcile screen ([light](screenshots/bank-rule-reconcile-light.png)).

### A contact's default account and tracking (decision 384)

384. **Contacts have a default purchase account and tracking, and a default
     sales account and tracking** (examples SD1-SD3, approved by Jess on
     5 Oct 2026; tenant migration 0091), like Xero's contact "Purchase
     defaults" and "Sales defaults" and NetSuite's vendor default expense
     account. The purchase account must be one a bill line can use, the
     sales account a revenue account. New bill, supplier credit note and
     spend money lines start with the purchase defaults; new invoice, sales
     credit note and receive money lines with the sales defaults (lines
     nobody has filled in yet; filled-in lines are kept). Bulk coding uses
     them for a line with no account. An archived account or tracking value
     is kept on the contact but not used. Bank rules don't use them (their
     lines say their own account). Screenshot:
     [the contact's defaults](screenshots/contact-defaults-dark.png).

### Automatic statement files (decisions 385-387)

385. **A bank or credit card account can have feeds that bring statement
     files in by themselves** (examples BF1-BF10, approved by Jess on
     5 Oct 2026; tenant migration 0092), like the OCA bank-statement-import
     modules for Odoo, for banks with no feed Tohyee can use. A **folder
     feed** reads one subfolder of the organisation's bank files folder; a
     **mailbox feed** reads one mailbox folder or Gmail label, through the
     admin's own CRM Gmail or Microsoft mailbox or IMAP with an app password
     (stored encrypted), kept with the feed so it doesn't need Analytics.
     Each file goes through the same importers and duplicate rules as a file
     imported by hand, and nothing is posted. A file is read again only when
     its name or contents change (SHA-256), each mail message once; what a
     place has given an account is kept when the feed is removed, so linking
     it again doesn't import old files twice. Feeds are checked every 6 hours
     by default (1 to 24, as Akahu; Jess, 5 Oct 2026) and with Check now;
     the schedule looks for due feeds every 15 minutes
     (`TOHYEE_FILE_FEEDS_SCHEDULER=off` turns it off). Admins set feeds up,
     bookkeepers check them, viewers see the last check. Tohyee gives out no
     email addresses of its own: Jess won't run a relay.
386. **A server admin chooses each organisation's bank files folder** (Jess,
     5 Oct 2026), as Analytics folders (decision 358): the server app's
     "Bank files folders" page, `/api/admin/bank-file-folders` or
     `admin bank folder --id ORG --folder PATH`. Organisation admins pick a
     subfolder by name; names with separators or `..`, and links that lead
     outside the folder, are refused. Organisations see subfolder names,
     never the server path. Files are only read, never moved or deleted.
387. **CSV and Excel files from a feed use the account's saved column layout
     strictly** (Jess, 5 Oct 2026): the first file of a kind is imported by
     hand, and a file whose columns don't match waits with "Columns don't
     match the last file imported by hand." Tohyee doesn't guess columns for
     a file nobody looked at. Importing it by hand once saves the new layout.
     - Screenshots: the Bank feed tab ([light](screenshots/bank-file-feeds-light.png),
       [dark](screenshots/bank-file-feeds-dark.png), [phone](screenshots/bank-file-feeds-phone.png))
       and the server's [Bank files folders](screenshots/bank-files-folders-dark.png).

### SimpleFIN bank feeds (decisions 388-391)

388. **SimpleFIN is a second bank feed, for overseas accounts** (examples
     SF1-SF10, approved by Jess on 5 Oct 2026; tenant migration 0093). Each
     organisation connects its **own** SimpleFIN Bridge account (it pays
     SimpleFIN; no relay) by pasting a setup token, which Tohyee claims once;
     the access URL it gets back holds the credentials and is stored
     encrypted, and deleted on disconnect. One connection per organisation
     (Jess: one connection per provider). NZ banks stay with Akahu. Checked
     against the protocol page, the Bridge's developer guide and its public
     demo on 5 Oct 2026; not tried with a real bank.
389. **A SimpleFIN account's currency must be the bank account's**, so a USD
     account can feed a USD bank account (FXB10), unlike Akahu. An account
     with an Akahu feed can't also have a SimpleFIN one (one feed per
     account, so the same transaction can't arrive twice under two ids).
390. **A line's date is SimpleFIN's `posted` time in the linked account's
     time zone** (Jess, 5 Oct 2026), defaulting to the organisation's: the
     protocol gives a moment, not the bank's date. Lines are kept as first
     received (Jess, as Akahu), carry
     `simplefin:<account id>:<transaction id>`, and pending transactions wait
     until they post. Amounts must be to the cent; anything else is skipped
     and listed with its reason. The account's balance and balance date
     become the statement balance as SimpleFIN sends it; for a credit card
     its sign hasn't been checked with a real card.
391. **Tohyee keeps under the Bridge's 24 requests a day**: one sync asks for
     every account at once, in 90-day pieces the first time and from 10 days
     before the last line (or last good sync) after that; every request is
     recorded. **Sync now stops at 20 in 24 hours** (Jess, 5 Oct 2026); the
     schedule (every 6 hours by default, 1-24, in the quarter hour after a
     minute picked at random per organisation, as the guide asks) stops at
     24. `TOHYEE_SIMPLEFIN_SCHEDULER=off` turns the schedule off.
     - Screenshots: the connection on Bank accounts ([dark](screenshots/simplefin-connection-dark.png)),
       a linked USD account's Bank feed tab ([light](screenshots/simplefin-feed-light.png),
       [phone](screenshots/simplefin-feed-phone.png)) and its lines ([light](screenshots/simplefin-lines-light.png)).

### Stripe as a bank feed (decisions 392-395)

392. **An organisation's Stripe balance is a bank account in Tohyee**
     (examples ST1-ST10, approved by Jess on 5 Oct 2026; tenant migration
     0094), as in Xero's Stripe feed. Each balance currency links to a bank
     account in that currency; every balance transaction becomes a line for
     its gross amount, and Stripe's fees a line of their own, so charges
     can be matched to invoices, fees coded, and payouts reconciled as
     transfers. Nothing is posted. One connection per organisation. Taking
     payments through Stripe is stage 4. Checked against Stripe's API
     reference on 5 Oct 2026; not tried with a real Stripe account.
393. **Only restricted keys are accepted** (Jess, 5 Oct 2026): `rk_live_` or
     `rk_test_`, checked by reading the balance, stored encrypted and deleted
     on disconnect. Full secret keys (`sk_...`) are refused, because they can
     move money. The exact permission names a restricted key needs haven't
     been checked with a real account.
394. **Every balance transaction comes in when it's created**, pending or
     not (Jess), dated in the organisation's time zone (Jess), so the lines
     always add up to Stripe's balance (available plus pending), which is the
     statement balance. A charge Stripe converted from another currency is in
     the balance currency, its description giving the original amount and
     Stripe's rate (from the expanded source).
395. **The tax part of Stripe's fees is its own line** (`fee_details` type
     `tax`, Jess, 5 Oct 2026), and Tohyee never picks its GST code: Stripe's
     NZ help says GST applies to "certain" fees without saying which. An
     account has one feed: Akahu, SimpleFIN or Stripe. Syncs run every 6
     hours by default (1-24) and with Sync now, from a day before the last
     line; `TOHYEE_STRIPE_SCHEDULER=off` turns the schedule off.
     - Screenshots: a Stripe account's lines ([light](screenshots/stripe-lines-light.png)),
       its Bank feed tab ([dark](screenshots/stripe-feed-dark.png)) and the connection
       on Bank accounts ([phone](screenshots/stripe-connection-phone.png)).

### PayPal as a bank feed (decisions 396-399)

396. **An organisation's PayPal balance is a bank account in Tohyee**
     (examples PP1-PP10, approved by Jess on 5 Oct 2026; tenant migration
     0095), as Stripe's (decision 392): each PayPal currency links to a bank
     account in that currency, each completed transaction is a line for its
     gross amount, and its fee a line with PayPal's sign (charged fees
     debits, returned fees credits). Payer name, subject and invoice id go on
     the line. Nothing is posted. One connection per organisation, read with
     PayPal's Transaction Search API (31 days per request; up to three hours'
     delay, so later syncs look back three days). Checked against PayPal's
     API specification and event code reference on 5 Oct 2026; not tried
     with a real PayPal account.
397. **The live app's client secret is accepted although it isn't read-only**
     (Jess, 5 Oct 2026): PayPal offers no read-only credentials. It's stored
     encrypted, used only for Transaction Search and balances, deleted on
     disconnect, and the connect screen says plainly that it could send
     money. Sandbox credentials fail against the live API and are refused.
398. **Pending and denied PayPal transactions are left out** until PayPal
     completes them (Jess); reversed ones (`V`) stay, their reversal coming
     as its own transaction. **Holds come in like everything else** (Jess),
     so the lines add up to PayPal's balance; whether PayPal's
     `total_balance` counts held money hasn't been checked.
399. **PayPal lines are dated as PayPal dates them** (Jess): the date part of
     `transaction_initiation_date`, which is in the PayPal account's own time
     zone, so lines match PayPal's statements. An account has one feed:
     Akahu, SimpleFIN, Stripe or PayPal. Syncs run every 6 hours by default
     (1-24) and with Sync now; `TOHYEE_PAYPAL_SCHEDULER=off` turns the
     schedule off.
     - Screenshots: a PayPal account's lines ([light](screenshots/paypal-lines-light.png),
       [phone](screenshots/paypal-lines-phone.png)) and its Bank feed tab
       ([dark](screenshots/paypal-feed-dark.png)).

### Wise as a bank feed (decisions 400-403)

400. **Each currency balance of an organisation's Wise business account is a
     bank account in Tohyee** (examples WI1-WI10, approved by Jess on
     5 Oct 2026; tenant migration 0096), read from Wise's balance statements
     (COMPACT, at most 469 days per request): money received, card payments,
     transfers, conversions and fees, with the payer or merchant, the payment
     reference and Wise's running balance on each line. Nothing is posted.
     One connection per organisation, using its business profile. Checked
     against Wise's API reference and personal token guide (docs.wise.com,
     the 2026Q4 API) on 5 Oct 2026; not tried with a real Wise account.
401. **The personal API token is accepted although it isn't read-only**
     (Jess, 5 Oct 2026): it could create and fund transfers. It's stored
     encrypted, used only to read profiles, balances and statements, deleted
     on disconnect, and the connect screen says so plainly. **Only accounts
     based in the US, Canada, Australia, New Zealand, Singapore or Malaysia**
     can be read (Wise's rule for personal tokens); others fail with Wise's
     reason, and can use automatic statement files with Wise's CAMT.053
     statements instead.
402. **Wise's fee goes on its own line only when Wise's running balance
     confirms how** (Jess): if the balance moved by the amount, the amount
     includes the fee; if by the amount less the fee, it doesn't. Otherwise
     (the first transaction read has nothing before it to compare with) the
     amount is one line saying the fee wasn't split. A fee line only ever
     comes with its own transaction's line, so a transaction first brought
     in unsplit never gets its fee counted twice. WI8 was corrected after
     approval to say this; as first written it claimed an unsplit line would
     still add up to Wise's balance, which isn't so if Wise's amount leaves
     the fee out.
403. **Wise lines are dated in the organisation's time zone** (Jess), from
     Wise's UTC times. An account has one feed: Akahu, SimpleFIN, Stripe,
     PayPal or Wise. Syncs run every 6 hours by default (1-24) and with Sync
     now, from three days before the last line; `TOHYEE_WISE_SCHEDULER=off`
     turns the schedule off.
     - Screenshots: a Wise account's lines ([light](screenshots/wise-lines-light.png)),
       its Bank feed tab ([dark](screenshots/wise-feed-dark.png), [phone](screenshots/wise-feed-phone.png))
       and the connection on Bank accounts ([light](screenshots/wise-connection-light.png)). An
       account with a SimpleFIN, Stripe, PayPal or Wise feed no longer offers to link Akahu.

### Bills inbox, duplicate bills and mileage (decisions 404-413)

404. **Each organisation has a bills inbox** (examples BI1-BI7, approved by
     Jess on 5 Oct 2026; tenant migration 0097): PDF, JPG, PNG and HEIC
     files up to 10 MB (the kinds a bill can have, NF7), kept in the
     organisation's own database (`bill_inbox_items`) so its backup has
     them. An item is waiting, made into a bill, or removed with a reason;
     removing drops the file and keeps the row for the history. Making a bill
     saves the draft, attaches the file to it (`record_attachments`) and
     marks the item, in one transaction; deleting that draft puts the item
     back on the waiting list. Nothing in the inbox posts. Bookkeepers and
     above change it; viewers see it.
405. **Mailboxes read into the inbox use the same connections as automatic
     statement files** (BF7): an admin's own CRM Gmail or Microsoft mailbox,
     or IMAP with an app password stored encrypted, reading one folder or
     label as that admin, every hour by default (1-24) and with Check now;
     `TOHYEE_BILL_INBOX_SCHEDULER=off` turns the schedule off. Each message is
     read once (remembered by place, so setting the mailbox up again doesn't
     read old mail twice); its PDF and picture attachments become items with
     the sender and subject (Gmail's headers, Microsoft Graph's `from` and
     `subject`, IMAP's envelope), other files are ignored, and one that isn't
     really that kind of file or is over 10 MB is skipped and counted.
406. **Documents are read only by the organisation's own connected AI**
     (question 1): Tohyee never sends a document anywhere and has no OCR.
     The MCP tools `list_bill_inbox` and `read_bill_inbox_item` are at the
     read level; the second answers with the item's details as text and the
     file itself, as MCP image content for JPG and PNG and an embedded
     resource (`blob`) for PDF and HEIC. `create_draft_bill_from_inbox_item`
     and `add_bill_inbox_item` are at the draft level. A draft made by the AI
     is like any other draft: the history shows the key it came through
     (decision 348) and the item shows it too.
407. **Kilometre rates are a setting per income year and vehicle type**
     (examples MI1-MI7, approved by Jess on 5 Oct 2026): petrol, diesel,
     petrol hybrid and electric, tier 1 and tier 2, entered by admins for all
     four types at once. Tohyee starts with the rates IRD published for
     2025-26 (operational statement OS 19/04: petrol 1.20 / 0.37, diesel
     1.30 / 0.38, petrol hybrid 0.90 / 0.24, electric 1.22 / 0.23). A year's
     rates can't change once an approved (or since voided) claim used them.
     When a line's own year has no rates, the latest rates entered are used
     and the line says so (question 2).
408. **A mileage line is a line of the expense claim** (`kind = 'mileage'`
     on `expense_claim_receipts`): date, from, to, purpose, kilometres (more
     than 0, at most 2,000, one decimal place), vehicle type and account
     (6120 Motor vehicle expenses by default in the editor). Its amount is
     tier 1 km x tier 1 rate + tier 2 km x tier 2 rate, rounded to the cent,
     with no GST (question 4); the rates, kilometres per tier and note are
     kept on the line. Approving posts it like a receipt.
409. **Tier 2 starts after 14,000 km of a claimant's mileage lines per
     vehicle type in an income year** (question 3), counting their submitted
     and approved claims, then this claim's earlier lines (by date, then line
     order); drafts and voided claims don't count. Tohyee can't know a
     vehicle's private travel, which IRD's threshold counts. An admin can put
     a draft claim's line all on tier 1 or tier 2; that stays when the
     claimant saves the same line again (same place, date, kilometres and
     vehicle type) and is dropped if they change it.
410. **Draft claims' mileage is worked out again** when an admin saves
     kilometre rates and when the claim is submitted; submitted and approved
     claims keep the amounts they were sent with (MI6), and approving checks
     the stored amounts rather than working them out again.
411. **Likely duplicate bills are warned about, never blocked** (examples
     DU1-DU5, question 5): another bill from the same supplier with the same
     total and currency dated within 7 days either side (7 counts), or a bill
     from another supplier with the same invoice number (compared as B5 does)
     and total. Drafts count; voided bills don't. Bills made by the same
     repeating bill aren't warned about each other (a weekly charge), including
     while the repeating bill approves one it has just made.
412. **Approving a bill with a warning needs the person to say so**
     (`approveDespiteWarnings`): otherwise it's refused with the warnings,
     and the bill page asks "Approve anyway?". The approval's history entry
     lists the warnings it was approved despite. The AI's `approve_bill`
     never sends it (DU5): the AI is told of the warnings when it drafts and
     must leave the approval to a person. A repeating bill set to approve
     leaves such a bill as a draft with the warning as its reason.
413. **The same file twice is spotted by its SHA-256** (DU1): an inbox item
     lists earlier items with the same contents (and what became of them)
     and bills the same file is attached to.
     - Screenshots: the bills inbox ([light](screenshots/bills-inbox-light.png),
       [phone](screenshots/bills-inbox-phone.png)), making a bill from a file
       ([dark](screenshots/bills-inbox-new-bill-dark.png)), a likely duplicate
       ([light](screenshots/bill-duplicate-light.png), [phone](screenshots/bill-duplicate-phone.png)),
       an expense claim with mileage ([light](screenshots/expense-mileage-light.png),
       [editing, dark](screenshots/expense-mileage-edit-dark.png), [phone](screenshots/expense-mileage-phone.png))
       and kilometre rates ([light](screenshots/kilometre-rates-light.png),
       [phone](screenshots/kilometre-rates-phone.png)).

### Online invoice payments with Stripe (decisions 414-419)

414. **Pay now uses Stripe payment links** (examples PN1-PN12, approved by
     Jess on 5 Oct 2026; tenant migration 0098), made with the
     organisation's existing Stripe connection (Jess, answer 8). Each link is
     for one invoice's amount due in its currency (an inline price, Stripe API
     version 2025-07-30.basil or later), at most one completed payment, with
     the invoice's id in its metadata and "Payment for INV-..." as the
     payment's description, so the feed's charge line says which invoice it
     paid. Nothing about the customer is sent to Stripe. Links don't expire;
     they're made the first time a bookkeeper or admin emails, prints or
     copies the invoice (a viewer printing it only sees one that exists), and
     a link that no longer matches the amount due is switched off and
     replaced. Checked against Stripe's API reference on 5 Oct 2026; not
     tried with a real Stripe account.
415. **The restricted key may also write payment links** (Jess, question 1):
     they only take money in. Full secret keys are still refused. The key
     needs read access to Checkout Sessions too; the exact permission names
     haven't been checked with a real account.
416. **Tohyee asks Stripe; Stripe doesn't call Tohyee** (question 2): every
     15 minutes and with Check now, each open link's completed checkout
     sessions (and those of links closed in the last 48 hours, for a payment
     made just before) are read with the payment, charge and balance
     transaction expanded. `TOHYEE_ONLINE_PAYMENTS_SCHEDULER=off` turns the
     schedule off.
417. **A paid session is a customer payment**, recorded once (by session id)
     through the same code as a payment typed in: dated by the charge in the
     organisation's time zone, into the bank account linked to the Stripe
     balance the money went to, with "Stripe" and the payment's id as the
     reference. A foreign-currency invoice paid into the base-currency
     balance is recorded at the rate (8 decimal places) that gives exactly
     Stripe's converted amount, so it matches the feed line to the cent
     (PN7). Paying more than is due is an overpayment on the customer's
     account (question 3, PN6).
418. **What Tohyee can't record is a notice for a person** (question 4):
     a payment for a voided, draft or deleted invoice, a payment into a
     balance in neither the invoice's nor the base currency, or one that the
     payment rules refuse (a locked period). A payment whose balance has no
     linked bank account waits as a notice and is tried again at each check.
     Notices are put away by a bookkeeper. Tohyee never refunds or charges:
     refunds and disputes come in only through the feed (PN8, PN9).
419. **Pay now is on every approved invoice with something due** (question
     5), unless left off on that invoice; card fees are never added to what
     the customer pays (question 6); saved cards are for later (question 7).
     Turning it off or disconnecting Stripe switches open links off first,
     listing any Stripe couldn't be reached for.
     - Screenshots: Settings, Online payments ([light](screenshots/online-payments-light.png),
       [phone](screenshots/online-payments-phone.png)), an invoice's Pay now card
       ([dark](screenshots/pay-now-invoice-dark.png), [phone](screenshots/pay-now-invoice-phone.png))
       and an invoice paid online ([light](screenshots/pay-now-paid-light.png)).

### Pay with PayPal (decisions 420-423)

420. **Pay with PayPal uses PayPal's own invoices** (examples PPN1-PPN10,
     approved by Jess on 5 Oct 2026; tenant migration 0099), because PayPal's
     payment links API documents no way to find the payments made through a
     link. Tohyee makes a PayPal invoice in the organisation's own account
     with the invoice's number, one item for the amount due, partial
     payments and tips off, and no customer address, then makes it payable
     without sending it (`send_to_recipient` false), so PayPal never emails
     the customer; the link is its `recipient_view_url`. PayPal keeps a
     cancelled invoice's number, so a replacement is numbered INV-0012-2.
     The app needs Invoicing; without it, emails and printing go ahead
     without the link and Copy shows PayPal's message. Checked against
     PayPal's developer documentation on 5 Oct 2026; not tried with a real
     PayPal account.
421. **Only invoices in a currency whose PayPal balance is linked offer it**
     (question 2), and the payment goes into that bank account in the
     invoice's currency; Tohyee never guesses a conversion rate. With Stripe
     also on, emails and PDFs show both links (question 3).
422. **PayPal payments are recorded by the same code as Stripe's** (decision
     417): each new transaction on an open (or recently closed) PayPal
     invoice, once by its `payment_id`, dated its `payment_date`, reference
     "PayPal" and the id. Payments typed into PayPal by hand (`type`
     EXTERNAL) are left out. Overpayments, notices and dismissing them are as
     Stripe's (question 5).
423. **A PayPal invoice no longer right is cancelled** without notifying
     anyone (the amount due changed, the invoice paid or voided, Pay now left
     off or turned off, PayPal disconnected), unless PayPal has already
     finished with it (paid, cancelled or refunded), when Tohyee just closes
     its link. Checks run every 15 minutes and with Check now, alongside
     Stripe's; `TOHYEE_ONLINE_PAYMENTS_SCHEDULER=off` turns both off.
     - Screenshots: Settings, Online payments with both on ([dark](screenshots/pay-with-paypal-settings-dark.png),
       [phone](screenshots/pay-with-paypal-settings-phone.png)) and an invoice's Stripe and PayPal links
       ([light](screenshots/pay-with-paypal-invoice-light.png), [phone](screenshots/pay-with-paypal-invoice-phone.png)).


### Approval workflows (decisions 424-431)

424. **Approval rules are per document type: bills, purchase orders and
     expense claims** (examples AW1-AW17, approved by Jess on 5 Oct 2026;
     tenant migration 0100). A rule's conditions must all hold (total at
     least an amount, the supplier or claimant, an account on any line, a
     tracking value on any line); rules are tried in their order and the
     first that matches is used. Admins add, change, reorder and archive
     rules (never delete them); everyone can see them. Totals are compared
     in the base currency (question 7): a bill's base total, and a foreign
     purchase order at the exchange rates list's rate for its order date
     (a purchase order has no rate of its own); with no rate, submitting is
     refused and says to add one.
425. **A tracking value condition matches lines tagged with the value or a
     value under it**, as reports filter (TC8). The examples only tag the
     value itself (AW11); this is our reading for nested values.
426. **A waiting request follows its rule as it is now** (AW6): an "any
     one" step is done once anyone approved it at that step (someone since
     removed from the rule still counts), an "all" step when every current
     approver has. Approvals are kept per step number in
     `approval_actions`, so an admin changing a stuck step's approvers lets
     the request carry on. Requests and actions are never changed or
     deleted once finished (database triggers).
427. **Nobody approves a document they submitted or made** (question 4):
     the submitter, a bill's or purchase order's creator, and a claim's
     claimant, whatever their role. Saving a rule warns about a step with
     one approver (or "all of" approvers), since it can't be done for that
     person's documents; the approval page says who's stuck.
428. **The last approval approves the document exactly as today**, by the
     last approver (B1-B3, PO2, EC3): a claim's last approver chooses the
     claim date, and a bill's sees any duplicate warning and approves anyway
     there (DU2). If that approval is refused (a locked period, AW10), the
     step's approval is rolled back (a savepoint), the request keeps the
     reason (`last_error`), and the route answers 409 after committing it.
     Approving a document a rule matches, or one waiting, is refused
     everywhere else, including repeating bills (submitted instead, run
     outcome `submitted`, AW14) and the connected AI (`approve_bill` says it
     needs a person's approval; `submit_for_approval` and `list_approvals`
     are its tools; it never approves or declines a step).
429. **Withdrawing**: a bill or purchase order by its submitter or an admin;
     a claim only by its claimant (AW8, AW17). Declining needs a reason and
     sends a claim back exactly as EC6. The examples only show the
     submitter withdrawing; letting admins withdraw bills and purchase
     orders is our call, so a stuck document can be freed without its
     submitter.
430. **Approvers are emailed through the organisation's own email** by the
     email job (`approval_emails`, retried like document emails; a failure
     shows on the approval page and holds nothing up). The email is plain
     text with the document, its total and a link to
     `/login?next=/operations/purchases/approvals/{id}/in/{organisation}`,
     which opens after signing in as that person and approves nothing by
     itself (question 2). The link uses the address the submitter's request
     came in on (the remote access public address when set); a repeating
     bill or the AI uses the remote access address, or with none the email
     says to open Tohyee's Approvals page.
431. **The budget at approval** (question 3) is for the month of the bill
     date, order date or a claim's latest receipt: for each profit and loss
     account on the document, the budget of a line's tracking value when one
     has a budget, otherwise the overall budget; what's posted to the
     account in that whole month (filtered to the budget's tracking value);
     this document excluding GST in the base currency; and what's left, with
     "Over budget by" when it's negative. Shown only; it never blocks.
     - Screenshots: Settings, Approval rules ([light](screenshots/approval-rules-light.png),
       [phone](screenshots/approval-rules-phone.png)), an approval page with the budget
       ([dark](screenshots/approval-request-dark.png), [phone](screenshots/approval-request-phone.png))
       and a bill waiting for approval ([light](screenshots/approval-bill-light.png)).

### Cash flow forecast (decisions 432-436)

432. **The cash flow forecast follows NetSuite's Cash 360** (examples CF1-CF9,
     approved by Jess on 5 Oct 2026; tenant migration 0101). It starts from
     the ledger balance today (business time zone) of the chosen bank
     accounts (all active bank accounts by default; cards can be ticked) and
     shows days (from today), weeks (Monday to Sunday) or months, about 3
     months by default (31 days, 13 weeks or 3 months), at most 92 days, 52
     weeks or 12 months. Open invoices and bills (what's due after payments
     and credit) go on their due dates; anything due before the first
     period, unpaid expense claims (no due date), and repeating documents
     made late go in the first period, overdue ones marked. Repeating
     invoices and bills give their total on the due date their template
     gives. It posts nothing and is worked out each time.
433. **Another currency** is converted at the latest rate on or before today:
     the exchange rates list, else the last rate used (`lastRateFor`, as
     MC3/MC48). With no rate the amount is left out and listed, never
     guessed.
434. **Account averages** are an account's net movement over the last 3 or 6
     whole months before this month (debits less credits for money out,
     credits less debits for money in; nothing when that's negative),
     divided by the days in those months, times each period's days, rounded
     per period. Bank, card, accounts receivable and payable accounts can't
     be averaged (their money is already in the forecast). An account whose
     bills are also open is counted twice if averaged, so the screen warns.
     The examples suggested GST as an average, but the GST account's net
     movement offsets GST collected against GST paid, so it doesn't measure
     payments to IRD: GST is a forecast item.
435. **Sales and purchase orders** (ticked): an approved order's total less
     the invoices or bills made from it that aren't voided (drafts
     included), on its expected or delivery date (else its order date) plus
     the customer's or supplier's payment terms (or on that date with
     none). Drafts (ticked) give their total on their due date.
436. **Forecast items** are kept with a version (two people can't overwrite
     each other) and removed by archiving, with who added, changed and
     removed each in the history. The connected AI reads the forecast
     (`cash_flow_forecast`, any level) but can't add items.
     - Screenshots: the forecast ([light](screenshots/cash-flow-light.png), [dark](screenshots/cash-flow-dark.png),
       [phone](screenshots/cash-flow-phone.png)).

### Consolidation and ECB rates (decisions 437-445)

437. **Daily rates come from the European Central Bank** (FX1, Jess, 5 Oct
     2026), like NetSuite's Currency Exchange Rate Integration but without
     its contracted providers (Tohyee has no relay service). An admin turns
     it on per organisation; every hour Tohyee checks organisations last
     checked more than 6 hours ago, reads the ECB's public 90-day file
     (`eurofxref-hist-90d.xml`, free, no account, reuse with attribution,
     "for information") and adds, for each day since it was turned on (and
     always the latest day), a rate for each foreign currency the
     organisation uses (contacts, accounts, documents, the list) or names as
     an extra, worked out through the euro and rounded to 6 decimal places.
     A rate already in the list for that currency and date is never
     replaced. `TOHYEE_ECB_RATES_SCHEDULER=off` turns the job off.
438. **Consolidation groups live in the core database** (core migration
     0007): a group, its members, changed rates, budget rates and
     elimination adjustments. Nothing is posted in any organisation; each
     report reads every member's own database as the signed-in person. A
     group is made and changed by an admin or owner of every organisation in
     it and seen by a member (viewer or above, not report viewer) of every
     one; to anyone else it doesn't exist (not found).
439. **Translation follows NetSuite's consolidated exchange rates** (Jess:
     different currencies and year ends, like NetSuite): from the parent's
     exchange rates list (the rate on or before each date), current = the
     rate on the report date (the month's end for the rates screen); average
     = the month's profit and loss amounts (debits plus credits) each times
     its day's rate, over their total; historical = the same with equity
     postings. Profit and loss is translated month by month at the average,
     assets and liabilities at the current rate, equity month by month at
     the historical rate, each rounded to cents per account and month; the
     remainder is the foreign currency translation reserve. A rate missing
     from the list refuses the report and names the dates. An admin can
     change a month's rate with a reason (kept with who and when); changed
     rates apply to every member in that currency.
440. **Intercompany** (NetSuite's intercompany accounts and entities): in
     each organisation an admin marks accounts held with another group
     organisation (not bank, card, receivable or payable accounts) and links
     one contact to each other organisation; open receivables and payables
     with that contact (from the aged reports' figures at the date) are
     eliminated from accounts receivable and payable. Marks with an
     organisation outside the group are ignored.
441. **Eliminations never change profit or net assets**: each eliminated
     amount is taken off its account, and what the two sides don't agree on
     (per pair of organisations, intercompany accounts and what's owed each
     compared on their own) goes back on an "Intercompany differences (check
     these)" line (in the profit and loss; in the balance sheet as an asset
     when a debit, a liability when a credit) with a notice naming the
     amounts (CO9, question 1).
442. **Earnings follow the group's year** (the parent's year end): current
     year earnings are the translated profit since the group's year start,
     retained earnings (previous years) everything before, whatever each
     member's own year end (CO8).
443. **Accounts are matched by code** and named as in the parent's chart
     (else the first member's). Elimination adjustments are balanced lines
     by organisation and account code in the group's currency, checked
     against that organisation's chart, made and removed by a bookkeeper or
     above of every organisation; a profit and loss code in an adjustment
     goes into earnings in the balance sheet.
444. **Budget vs actual** uses each member's overall budget at the month's
     typed budget exchange rate (one per currency and month; budgets hold
     only profit and loss) against the consolidated actuals; a missing
     budget rate refuses it and names the months.
445. **The connected AI reads consolidations** (Jess): `list_consolidations`
     and `consolidated_report` work as the key's owner, showing only groups
     whose every organisation the owner can see. Only wholly owned members
     (no minority interest, as standard NetSuite).
     - Screenshots: a consolidated balance sheet ([light](screenshots/consolidation-light.png),
       [dark](screenshots/consolidation-dark.png), [phone](screenshots/consolidation-phone.png)).

### Report commentary (decision 446)

446. **AI commentary is a suggestion only** (Jess, 5 Oct 2026; NetSuite
     2025.1 writes variance explanations with its own built-in AI, Tohyee
     has none, so only the connected AI of decisions 339-348 writes them).
     The draft-level tool `suggest_report_commentary` saves a commentary on
     the cash flow forecast (in the organisation's database, tenant
     migration 0103) or on a group's consolidated profit and loss or balance
     sheet (in the core database with the group, core migration 0008). It
     shows as "Suggested by Jess's AI key Claude, not checked" until a
     bookkeeper or above (of every member, for a group) accepts it, as it
     is or edited, or removes it. Commentary a person writes is accepted
     when written. Removed commentary is kept with who removed it, and every
     change is in the audit log. Viewers can read it. Tohyee never shows a
     suggestion as checked, and nothing in it changes the report.
     - Screenshots: the commentary card on the forecast ([light](screenshots/commentary-light.png),
       [dark](screenshots/commentary-dark.png), [phone](screenshots/commentary-phone.png)).

### Shopify chargebacks and reserves (decisions 447-450)

447. **No summary mode** (Jess, 5 Oct 2026): each Shopify order keeps its
     own invoice, paid into the clearing account, and a payout moves the
     net to the bank (SPC15), as NetSuite does. A2X's one-summary-per-payout
     isn't built. WooCommerce is the next platform (item 7 part 2).
448. **Chargebacks go to a chargebacks account** (Jess, replacing decision
     318 for chargebacks): the disputed amount (`DISPUTE_WITHDRAWAL`) goes
     on the payout's spend money to the expense account chosen in the
     settings, the chargeback fee (`CHARGEBACK_FEE`) to the fees account; a
     won dispute (`DISPUTE_REVERSAL`) and a fee given back
     (`CHARGEBACK_FEE_REFUND`) come back on a receive money. The order's
     invoice, sales and GST stay as they are. Whether GST on a lost
     chargeback can be claimed back is open: Jess is checking with IRD, and
     Tohyee does nothing to GST until then.
449. **Reserves go to a reserve account** (Jess, replacing decision 318 for
     reserves): money held (`RESERVED_FUNDS`) is a transfer from the
     clearing account to the bank account chosen as the reserve account,
     and money released (`RESERVED_FUNDS_REVERSAL`) a transfer back, so the
     reserve account shows what Shopify holds.
450. **Shopify's type names are read, not trusted** (Jess: build now, check
     a real payout later): Shopify names these types without saying what
     they do, so each is posted only with the sign Tohyee expects
     (withdrawals and fees negative, reversals and refunds positive); the
     other sign, `CHARGEBACK_HOLD`, `CHARGEBACK_HOLD_RELEASE` (Jess: keep
     refusing), `RESERVED_FUNDS_WITHDRAWAL` and every other type still
     refuse the payout. A payout needing an account not chosen yet is
     logged and tried again at each sync, so it posts once the account is
     chosen (SPC30).
     - Screenshots: the chargebacks and reserve settings ([light](screenshots/shopify-chargebacks-light.png),
       [dark](screenshots/shopify-chargebacks-dark.png), [phone](screenshots/shopify-chargebacks-phone.png)).

### WooCommerce orders (decisions 451-455)

451. **WooCommerce is the second sales platform** (Jess, 5 Oct 2026), on the
     same connector framework as Shopify: a REST API v3 key made in the
     store, over https only; webhooks (`order.created`, `order.updated`)
     signed with a secret Tohyee makes, which need a key with write access
     (with a read key the catch-up sync brings orders in). No customer or
     product sync: customers are matched by email, lines by SKU (Jess:
     enough for now).
452. **Each payment method is mapped to an account** (Jess, following
     NetSuite's payment method mapping): an order's payment is recorded
     into the bank account chosen for its WooCommerce payment method (e.g.
     Stripe into the Stripe feed's account, so the feed's line matches the
     payment), and refunds are paid back from it. A method seen on an order
     but not chosen yet holds the order, which is tried again each sync.
453. **Bank transfers are invoiced at once and left owing** (Jess): an
     order placed with a "left owing" method is invoiced on its order date
     with nothing paid, for the bank feed to match; Tohyee never records a
     payment for it. A refund before it's paid is credited against what's
     owed. Cancelled with nothing paid against it, the invoice is voided
     (Jess); otherwise it's logged for a person.
454. **WooPayments goes through a clearing account** (Jess): its payments
     go into a bank account like any card gateway, and its deposits are
     reconciled by hand (there's no documented API for them).
455. **WooCommerce's amounts are before tax**: line and shipping totals
     come with their tax beside them, so invoices are tax exclusive and
     must come to the order's total. Surcharges (`fee_lines`) are refused
     for now (Jess), like another currency.
     - Screenshots: the payment method settings ([light](screenshots/woocommerce-light.png),
       [dark](screenshots/woocommerce-dark.png), [phone](screenshots/woocommerce-phone.png)).

### Review fixes, 5 Oct 2026 (decisions 456-460)

From the project review of 4 Oct 2026 (#158); issues #130-#138, #143,
#146, #148, #149 and #157 are fixed in this change.

456. **Sign-in tries are counted before they're checked** (#130): each
     password and two-step code takes a try in one conditional update, so
     tries sent at once can't go past the limits (5 per pending sign-in,
     10 per account, 5 passwords). An email with no account gets the same
     "too many attempts" answer after 5 tries, so it can't be told apart.
     There's also a per-address limit of 30 sign-in tries a minute, only
     when a proxy says the address.
457. **The two-step reset email needs the server's public address** (#131,
     Jess): the link only uses the configured address (Settings › Remote
     access), never the request's Host. Without one the email reset isn't
     offered and a server admin resets two-step.
458. **Password and two-step resets revoke the person's AI keys** (#132,
     Jess: always): changing or resetting a password, or resetting
     two-step, stops every AI key the person made, in every organisation.
459. **Each browser tab keeps its own organisation** (#143, Jess): the
     tab's choice stays in that tab; a new tab starts on the last one
     chosen. Switching organisation starts the page and its forms afresh.
460. **An email that may have gone isn't sent again by itself** (#146): only
     a send that certainly didn't reach the provider is retried; a timeout
     or dropped connection after the message was handed over, or Google's
     answer without the message's id, says to check the Sent folder first.

### Review fixes, payroll, 5 Oct 2026 (decisions 461-464)

Issues #139-#142, each with an example Jess approved on 5 Oct 2026.

461. **A bank file pays the account kept at approval** (#139, PBF8, Jess:
     "use the approved one, warn"): approving keeps each employee's bank
     account with their pay; the bank file pays that one and warns, masked,
     when the employee's account has changed since. Pay runs approved
     before accounts were kept use the current account, as before.
462. **Changing an employee counts as preparing their drafts** (#140,
     PRUN7b): with "approver must be different" on, whoever changes a draft
     pay run's employee's tax code, student loan, KiwiSaver status or
     rates, temporary rate reduction, ESCT rate, bank account or pay rate
     can't approve it (tenant migration 0106, `details_changed_by`).
     Changes before the draft existed, or to people not on it, don't count.
463. **KiwiSaver temporary rate reduction** (#141, PR13b): set under
     Employees with the dates on IRD's approval; pays dated within them
     take the reduced rates (3%/3% from 1 April 2026), and approving keeps
     the dates with the pay (tenant migration 0107). Pays outside the dates
     use the normal rules. The employee PATCH route also now saves the ESCT
     rate, which the employee screen sent but the route dropped.
     - Screenshots: the employee form ([light](screenshots/kiwisaver-reduction-light.png),
       [dark](screenshots/kiwisaver-reduction-dark.png), [phone](screenshots/kiwisaver-reduction-phone.png)).
464. **Salary back pay refuses a period not paid in full** (#142, XP11b,
     Jess: refuse rather than pro-rate): when the period's ordinary pay
     isn't the full salary at the rate before the new one, back pay is
     refused and the user adds it as an amount. The message uses the full
     name and "their", not the example's "her", because Tohyee doesn't
     know employees' pronouns.

### Review fixes, part 3, 6 Oct 2026 (decisions 465-473)

Issues #144, #145, #147, #150, #151, #153, #154 (not signing), #155 and
#156 from the review of 4 Oct 2026 (#158). Still open: #152 (needs Windows
testing) and #154's code signing (later, Jess).

465. **Security headers** (#144): every page is sent `frame-ancestors
     'self'`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: same-origin`
     and `nosniff`, so another install on the shared address domain can't
     frame Tohyee. `'self'` rather than `'none'` because the bills inbox
     previews a stored PDF in a same-origin frame. A full content security
     policy (scripts and styles) needs nonces and is a later step; adding
     the shared domain to the Public Suffix List is Jess's to submit.
466. **Organisations' SMTP servers** (#145, Jess: a server-admin switch):
     only ports 25, 465, 587 and 2525, and only public addresses, checked
     when saving and again on connecting (to the address checked), unless a
     server admin turns on "Allow local mail relay" (Server settings ›
     Email, or `email local-relay --on`). Unencrypted SMTP only to
     localhost with the switch on. The remote server's reply is no longer
     shown to the organisation, only logged. Existing installs relaying
     through a local mail server need the switch turned on.
     - Screenshots: Server settings › Email ([light](screenshots/local-mail-relay-light.png),
       [dark](screenshots/local-mail-relay-dark.png), [phone](screenshots/local-mail-relay-phone.png)).
467. **Akahu re-reads 30 days** (#147, BK29, Jess: deleted lines stay
     deleted, for every API feed): late-settling transactions are picked up;
     a line deleted from an Akahu, SimpleFIN, Stripe, PayPal or Wise feed is
     never brought back by the feed. Lines from files imported by hand still
     come back when the file is imported again (BK12, BF6). Akahu amounts go
     through the decimal module; a sub-cent amount is refused, not rounded.
     The credit card balance's sign is unchanged until Akahu's convention
     is confirmed.
468. **Analytics limits** (#150): DuckDB is capped at 1 GiB of memory and 2
     GiB of spill files, and a shaped-table build at 5 minutes (keeping the
     last copy); `TOHYEE_ANALYTICS_MEMORY_LIMIT`, `_TEMP_LIMIT` and
     `_BUILD_SECONDS` change them. The books copy is read in batches of
     5,000 rows.
469. **No transfer out across a revaluation; revaluations can be voided**
     (#151, FXB12, Jess: refuse, and let a revaluation be voided): voiding
     reverses both journals, for the whole run, on their own dates (period
     locks apply), refused once a later revaluation of the same account and
     currency exists. The void is kept in its own append-only table (tenant
     migration 0108), so revaluation runs stay append-only. A voided
     revaluation counts nowhere, period close included.
     - Screenshots: Past revaluations with Void and a voided run ([light](screenshots/fx-revaluation-void-light.png),
       [dark](screenshots/fx-revaluation-void-dark.png), [phone](screenshots/fx-revaluation-void-phone.png)).
470. **One revaluation at a time for every account** (#151, FXB13), as for
     receivables and payables; and statement lines in currencies without
     cents (JPY, XPF) can be coded (FXB14). Organisations whose own currency
     has no cents still aren't supported.
471. **Release supply chain** (#154, Jess: signing later): release workflows
     run with read-only tokens except the jobs that publish, never
     overwrite a release's files, and pin Visual C++ and Inno Setup by
     SHA-256; update checks time out after 15 seconds. The tray screenshots
     job keeps its own write token on pull requests (Jess) but runs no repo
     code.
472. **Docker zip backups** (#153, Jess: encrypted): Backup-Tohyee runs
     Tohyee's encrypted backup instead of a plain dump to Documents, and the
     nightly backups go to a `backups` folder beside the compose file rather
     than inside Docker. Not yet tried on Windows.
473. **Build and packaging** (#155, #156): the standalone build no longer
     copies the whole repository (books, backups, docs); `.dockerignore`
     leaves out data folders; the development compose file binds PostgreSQL
     to localhost and drops the unused Redis; the Windows build refuses a
     PostgreSQL major-version change until an upgrade path exists; the
     relay is checked in CI.

### Windows install: ordinary database logins and a private data folder (decision 474)

474. **Windows install runs Tohyee with ordinary database logins, and only
     Administrators and SYSTEM can open its data folder** (#152, Jess: keep
     the service on SYSTEM for now). The installer makes `tohyee_admin`
     (NOSUPERUSER CREATEDB: owns the databases, runs migrations,
     `DATABASE_ADMIN_URL`) and `tohyee_app` (data access only,
     `DATABASE_URL`), with their passwords in `tohyee.env`
     (`TOHYEE_DB_ADMIN_PASSWORD`, `TOHYEE_DB_APP_PASSWORD`). initdb's
     superuser is used only while installing, so the app can't run programs
     or read files through PostgreSQL. An update hands existing databases
     and everything in them to `tohyee_admin` (`installer/windows/
     database-owner.sql`; REASSIGN OWNED can't be used on initdb's
     superuser), tested in `tests/integration/windows-database-logins.test.ts`.
     The whole `%ProgramData%\Tohyee` folder now belongs to Administrators,
     with permissions reset on every install or update, so a folder made
     beforehand by another user is taken back; PostgreSQL's service
     (Network Service) keeps access to `pgdata`, and `tray.ini` stays
     readable by everyone for the tray app. The Start menu's "Tohyee logs"
     shortcut now needs an administrator. The Docker zip still runs as
     PostgreSQL's superuser inside its container.
     - Not done: running the Tohyee service as something other than SYSTEM.
       A restricted account couldn't write to backup or analytics folders in
       someone's own profile (OneDrive) unless each folder were granted to it
       (Jess, 8 Oct 2026: keep SYSTEM for now).

### Warmer look and Home (decision 475)

475. **Warm colours and a clearer Home, keeping the top bar** (PR #184,
     Jess, 8 Oct 2026: keep the top bar, not a sidebar). Warmer off-white
     colours, stronger input borders, flatter cards, a serif page title
     (Georgia until a serif font file is added), and on Home: a greeting
     with the financial year, the cash figure first, one "Needs attention"
     list, recent activity and a bank accounts panel (at most 5 accounts,
     failed feeds first). A GST estimate that can't be worked out shows
     "Unavailable" rather than 0.00. The spec's sidebar isn't used
     (`docs/UI-IMPLEMENTATION.md`). Home's greeting has a faint stylised
     drawing of the Southern Alps traced from Jess's own photo (Lake
     Pukaki towards Aoraki), in the theme colour, hidden on phones. The
     line of technical notes above Home's figures was left out (too much
     information), and the top bar tightens from 1,520px so the CRM's
     nine links fit at 1,440px.

### Blue instead of green (decision 476)

476. **Blue colours, and a clearer Aoraki on Home** (Jess, 8 Oct 2026:
     "change it to blue shades"; the first mountain drawing wasn't
     recognisable). The accent is a deep blue (#1f5fae light, #5b9cf0
     dark) and the greys are cool slate rather than green-tinged; status
     colours (green for done, red for overdue) are unchanged, as are the
     chart series colours. Home's greeting has a flat illustration of
     Aoraki / Mt Cook from Lake Pukaki, drawn from Jess's photo: the sharp
     summit, a sunlit snow face with rock ribs, the shadowed east face,
     foothills and the lake, in shades of the accent blended with the page
     colour so it suits light and dark. Not yet changed: printed
     documents and emails, the Windows server app and the website.

### Aoraki photo on Home (decision 477)

477. **Jess's photo of Aoraki, tinted blue, behind Home's greeting**
     (Jess, 8 Oct 2026: chose ChatGPT's photo approach over the drawing,
     but "too grey"). Only the mountain strip is stored
     (`public/images/aoraki-strip.jpg`, 700x202, no metadata), never the
     whole photo, which shows a number plate, browser tabs and an
     Instagram name; PR #188, which committed the whole photo, was closed.
     The strip is shown in the theme's blue (luminosity blend with
     `--accent`) at 35%, fading in from the left and out at the bottom,
     and hidden on phones. The faint vertical stripes come from the source
     being a photo of a screen; the original image file would remove them.

### Not registered for GST (decision 478)

478. **Registration is a switch with dates, on by default** (#180, examples
     NR1-NR8 approved by Jess, 8 Oct 2026). `organisation_settings` gets
     `gst_registered` (default true) and optional inclusive
     `gst_registered_from` and `gst_registered_until` (migration 0109); a
     blank "from" means from the start. Whether GST applies is decided by
     the document's own date, so registering or deregistering never changes
     an approved document (NR7). Changed from the draft NR8, which made an
     organisation without a GST number not registered: many organisations
     (and most tests) have GST in their books without a number typed in
     Settings, so registration defaults to on, and the upgrade only turns
     it off where there's no number and nothing has ever been posted to the
     GST account. Turning registration on asks for the number; dates that
     would leave GST already posted outside them are refused, so
     deregistering means setting the end date, not switching off. A blank
     tax code is still refused on tax-exclusive or inclusive lines (the
     editors start unregistered organisations on No GST amounts); an
     item's GST code isn't copied onto the line while not registered.

### Where exchange rates come from (decision 479)

479. **ECB, uploaded rate sets or typed only** (#183, examples FX2-FX9
     approved by Jess, 8 Oct 2026: "a way to upload and set as the exchange
     rates for a period"). The source is kept with the ECB settings
     (`ecb_rate_settings.rate_source`, migration 0110); choosing ECB turns
     its daily job on and anything else turns it off, so the existing ECB
     switch and the source can't disagree. Existing organisations with the
     ECB on start on ECB, the rest on typed only, which is how they already
     worked. An uploaded set's rates are ordinary entries in the exchange
     rates list, tied to the set and effective from its period's start, but
     used only up to its period's end (no other entry has an end). While
     sets are the source, only a set covering the date counts: no other
     list entry and no last rate used, so October's rates never carry into
     November (FX5); the same rule gives payments and statement lines their
     starting rate. Rates in a file quoted as foreign currency per NZD 1 are
     turned round to 6 decimal places (as FX3 says). Sets
     are never changed or deleted; replacing one marks it replaced and
     archives its rates. Documents record where their rate came from as
     text ("Typed", "ECB", the set's name, "Exchange rates list", "Last
     rate used") so the record survives a set being replaced; an edit that
     keeps the saved rate keeps its source. Inland Revenue's guidance
     ([Overseas currency conversion to NZ dollars](https://www.ird.govt.nz/managing-my-tax/overseas-currency-conversion-to-nz-dollars),
     checked 8 Oct 2026) is why a change of source asks for a reason, kept
     in `exchange_rate_source_changes`. No RBNZ feed: its site may block
     automatic downloads, so its rates come in as an uploaded file.

### Accounting as a module (decision 480)

480. **Accounting can be off; modules are chosen when an organisation is
     created** (#181, examples MOD2-MOD7 approved by Jess, 8 Oct 2026).
     `organisation_settings.accounting_enabled` (default on, so existing
     organisations don't change, MOD7; migration 0111) with database checks
     that one of Accounting, CRM or Analytics is on and that Advanced
     reporting and Not-for-profit are off without Accounting (MOD5). "Tax"
     is the GST registration switch from #180, not another flag. The
     server admin's "New organisation" form sends the modules; they're
     applied as a settings change once the database is ready. Turning
     Accounting off keeps everything: background jobs skip the
     organisation through one SQL condition in their "what's due" queries,
     and pick up from where they stopped (feeds re-read from their last
     sync; repeating templates make every missed date). Sales platform
     webhooks are answered 200 but not recorded while it's off, so the
     platform doesn't drop the address and the catch-up sync brings the
     orders in later. The Modules page lives at `/operations/modules` and
     opens from the account menu in every app; with Accounting off, it,
     the profile and members pages are the only Accounting pages that
     open. Only the CRM's invoice and sales order actions are refused on
     the server; other Accounting API routes still work for anyone calling
     them directly. That gap is known (told to Jess) and can be closed
     later by checking the switch in the Accounting API routes.

### Several bank feed logins (decision 481)

481. **Several named logins per bank feed provider** (#182, examples
     BK30-BK37 approved by Jess, 8 Oct 2026; replaces decision 388's "one
     connection per provider", and the "one connection per organisation"
     in decisions 392, 396 and 400). Each provider's connections table
     keeps any number of active logins, each with a name unique among them
     (migration 0112 drops the one-active-connection indexes; existing
     connections are named after the provider). Akahu feeds now record
     their login (`bank_account_settings.akahu_connection_id`) and Akahu
     logins keep a `token_problem`; the other providers' links already had
     a connection. Every command that acts on a login takes its id, and
     with a single login it can be left out, so single-login organisations
     and the existing API work as before. One feed per account (decision
     389) stays, and an Akahu or SimpleFIN account (a joint account seen by
     two logins) can still be linked to only one Tohyee account; Stripe,
     PayPal and Wise allow one link per currency per login. Online
     payments use the first Stripe or PayPal login. The SimpleFIN request
     limit (decision 391) is still counted per organisation.

### Direct debit with GoCardless (decision 482)

482. **Direct debit with GoCardless, BECS NZ** (stage 10, examples GC1-GC10
     approved by Jess with the suggestions, 8 Oct 2026; tenant migration
     0113). One GoCardless connection per organisation, with its own
     access token stored encrypted (live or sandbox). A customer's
     authority is asked for with a GoCardless billing request and its
     hosted page; Tohyee never sees bank details. Every approved invoice
     in the base currency for a customer with an active authority is
     collected on its due date unless ticked "don't collect this one";
     the collection is asked for three days before, for the amount due
     then, with an idempotency key per invoice and attempt. A check every
     15 minutes (and Check now) follows each collection: confirmed, it's
     recorded as a customer payment into the clearing bank account;
     failed or charged back, that payment is voided and the invoice is
     due again. There's no automatic retry: "Try again" asks GoCardless to
     retry (at most three times). A collection the invoice no longer needs
     (voided, ticked, or less is due) is cancelled if GoCardless still
     can; otherwise the invoice says so. Paid payouts are posted as one
     journal (Dr payout bank account, Dr fees, Cr clearing account), once
     each, with fees posted without GST until it's known whether
     GoCardless's NZ fees include GST. The scheduler is off while
     Accounting is off and with TOHYEE_GOCARDLESS_SCHEDULER=off. Not done:
     GoCardless webhooks (the check polls instead, as the other
     providers), reading GoCardless's events for the reason a payment
     failed, and foreign-currency invoices.

### Remote access hardening (decision 483)

483. **Remote access hardening, part 1** (#208 items 3-6, 9 Oct 2026, from
     the safety review Jess asked for).
     - **Sign-in address:** the per-address sign-in limit and the address
       saved with a session use the last X-Forwarded-For entry that isn't
       this computer (the one the nearest proxy wrote), not the first,
       which a visitor could change on every try.
     - **Emailed two-step reset:** wrong passwords there now count towards
       the account's lockout (shared `claimPasswordTry`), and it and setup
       have the per-address limit too.
     - **Server settings address:** it refuses requests carrying a proxy's
       headers or addressed to anything but 127.0.0.1 or localhost, so
       pointing a tunnel route at it doesn't reach server settings.
     - **Without `TOHYEE_SECRET_KEY`** (no two-step sign-in), sign-ins and
       sessions that came through remote access (Cloudflare's headers, or a
       Tailscale Funnel `*.ts.net` address) are refused, and the server
       app's Home flags remote access left on.
     - **HSTS:** `Strict-Transport-Security: max-age=31536000` on every
       response, without `includeSubDomains`.

     Not checked against a real tunnel: that Cloudflare's tunnel and
     Tailscale Funnel add the visitor's address at the end of
     X-Forwarded-For. If Funnel doesn't, the per-address limit behind
     Funnel is as before (the per-account lockout still applies).

### Setup links instead of passwords (decision 484)

484. **New logins get a setup link** (#208 item 2, 9 Oct 2026; Jess: "local
     network only" doesn't work because new users may be miles from the
     server, and she agreed to setup links).
     - **Creating a login:** with two-step sign-in on (the server has its
       secret key), a server admin no longer chooses a password. Adding a
       login, or resetting someone's two-step sign-in, makes a one-time
       setup link valid for 7 days (core migration 0009,
       `user_setup_links`, only a hash kept).
     - **Sending it:** it's emailed when the server can send email, and can
       always be copied (server app, `/server/users`, `tohyee-admin users
       create | reset-two-step | setup-link`). It starts with remote
       access's public address, or this computer's name with a note that it
       only works on the local network.
     - **Using it:** at `/login/setup-account` the person chooses their
       password and goes straight on to set up their authenticator app.
       Making a new link retires the old one.
     - **Sign-in:** a correct password for a login without two-step is now
       refused ("open the setup link…") instead of starting two-step set-up,
       so a stolen password can't register someone else's authenticator.
     - **Still possible:** the first admin (`SETUP_TOKEN`), the emailed
       lost-phone reset (password plus email) and the changed-secret-key
       path start set-up as before.
     - **Without the secret key:** nothing changes; there's no two-step
       sign-in, and admins set temporary passwords as before.
     - **On upgrade:** existing logins that never set up two-step need a
       setup link ("Send setup link" on the Users page).

### Handing an organisation over (decision 485)

485. **A server admin can hand an organisation over** (#208, Jess 9 Oct
     2026: the main admin should be able to recover any organisation, as
     people forget passwords or die and the accounting data mustn't be lost).
     - **Why it's needed:** today, if an organisation's only owner can't act,
       nobody can make a new owner, and the only workaround is signing in as
       them.
     - **What it does:** a server admin, on the server computer only, names
       a login and a reason, and after a **7-day wait** that person becomes
       an owner (an existing role is raised to owner; nobody loses access).
       Core migration 0010, `organisation_handovers`. The 15-minute
       scheduler can be turned off with `TOHYEE_HANDOVER_SCHEDULER=off`.
     - **Who's told:** the organisation's owners and admins are emailed at
       once, see it on the Members page and in the top bar, and any of them
       can cancel it. So can a server admin.
     - **Not to yourself:** a server admin can't hand an organisation to
       themselves (Jess). It's recorded in the server's log and in the
       organisation's own history.
     - **Why 7 days:** Jess asked for whatever suits a server with perhaps
       100 client organisations, where the server admin is an outsider to
       each. The wait protects clients from a mistake or a misused admin
       account and costs little in a genuine case.
     - **Still possible:** two server admins acting together could hand
       organisations to each other. Having a second server admin is still
       advised.
     - **Architecture:** this is the one deliberate exception to "being a
       server admin doesn't give access to any organisation's books".

### The Windows service runs as its own account (decision 486)

486. **The Tohyee service runs as `NT SERVICE\Tohyee`, not SYSTEM** (#208
     item 7 and #152, Jess 9 Oct 2026). Before, a flaw in Tohyee or in its
     cloudflared would have given control of the whole computer. Now the
     service runs as its own Windows virtual account (no password; set with
     `sc.exe config` by the installer).
     - **What the installer gives it:** read on the program folder and its
       service settings, and write on its logs, backups, analytics data and
       a temporary folder (`TEMP` points there, not at the account's
       profile).
     - **Chosen folders:** a backup folder in OneDrive, say, or analytics
       and bank files folders. Jess's suggestion: backups go in a folder,
       so give the service that folder.
       - The server app gives the service access when a backup or analytics
         folder is chosen; it runs as the person, who owns their own
         folders.
       - `tohyee-admin` does the same for `backups set --folder`,
         `analytics folder` and `bank folder`.
       - The installer gives it every folder already chosen, so an update
         keeps backups working.
     - **Error messages:** when the service still can't use a folder, they
       give the `icacls` command.
     - **Readable checks:** folder checks now really list the folder;
       `fs.accessSync(R_OK)` doesn't look at Windows permissions.
     - **"Use Google Drive"** sits beside "Use OneDrive". It finds Google
       Drive for desktop's "My Drive" in the person's profile ("Mirror
       files", a real folder that works like OneDrive). If Google Drive is
       streaming files on its own drive letter (which belongs to whoever is
       signed in, so the service may not be able to use it), it says to
       switch to "Mirror files".
     - **Not tested here:** the Windows install test checks the account and
       the analytics folder; streaming mode and a real Google Drive haven't
       been tried.

### The sign-in monitor (decision 487)

487. **Sign-ins are recorded and suspicious ones reported** (#208 item 1,
     Jess 9 Oct 2026: no country lookup; report, don't block).
     - **What's recorded:** every sign-in attempt (password, authenticator
       code, backup code, setup link, emailed reset, first admin), with its
       outcome, the address (the one the nearest proxy wrote), the browser,
       and whether it came through remote access. Core migration 0011,
       `sign_in_events`, kept for a year. The per-address rate-limit brake
       isn't recorded.
     - **What's flagged:**
       - a successful sign-in from a browser that login hasn't used before,
         or from a new address through remote access
       - 3 or more failures for one login within 15 minutes (once per
         window)
       - failures for 5 or more different logins from one address within 15
         minutes
       - a locked login
       - a backup code used
       - an emailed two-step reset
       - a server admin signing in through remote access
     - **Who's told:** flags are emailed to the server admins, and to the
       person for the ones about their own login, when the server can send
       email. They show in the server app (Sign-ins page, a badge, and
       Home's Needs attention until "I've looked") and at `/server/sign-ins`.
     - **What's not done:** nothing is blocked, and there's no country lookup
       or unusual-hours flag. Repeated failures still lock the login, as
       before.
     - **Where you're signed in:** people see their sessions (browser,
       address, last used) on Your account and can sign one out, or all the
       others. Server admins can sign anyone out everywhere (server app and
       `/server/users`).

### Full access AI keys and bank reconciliation tools (decision 488)

488. **A fourth AI key level, "Full access", that reconciles bank lines**
     (#205, 9 Oct 2026; the undo's void date chosen by Jess: the line's
     date). Examples AIB1-AIB8.
     - **Who:** only an Owner can make one, after ticking a warning (the API
       needs `confirmFullAccess: true`). Core migration 0012 allows the
       level. Like the others it's capped by the owner's role when used: an
       Owner's key is Full access; anyone else's works as Make and post or
       less.
     - **What it adds:** match_bank_line, create_and_match,
       transfer_and_match, apply_bank_rule, bulk_reconcile (at most 100 lines
       a call, each done or refused on its own), create_bank_rule and
       update_bank_rule. Each sends the same command the reconcile screen
       does, so it posts what a person's click would and respects locked
       periods, GST and currencies. Matching an adjustment or splitting one
       transaction across lines is left to people for now.
     - **Reading** (any level): list_bank_accounts, list_bank_lines (with
       dates, status, text or amount, paged), get_bank_line (with the reconcile
       screen's suggestions), list_bank_rules, get_bank_rule and
       reconciliation_summary.
     - **Never:** no tool excludes a line, deletes an import, voids, or
       deletes or switches off a rule; update_bank_rule keeps a rule on or off
       as it was.
     - **The one undo:** unmatch_bank_line, for a reconciliation the same
       key made within 24 hours in an unlocked period. When it made spend
       money, receive money or a transfer, that's voided on the line's date
       (so the period is as if it never happened); a transfer's other side is
       unreconciled first if this key matched it. Payments made by paying
       invoices or bills stay for a person to void. Anything else is refused
       with "a person must unreconcile it".
     - **Idempotency:** the tools take `idempotencyKey` (up to 80
       characters; #205 called it `clientRequestId`, named like the other AI
       tools here). Bulk calls add the line id to it for each line.
     - **Not yet:** the rest of #205 section 4 (other Full access actions
       outside banking).

### Full access outside banking (decision 489)

489. **A Full access key also does day-to-day accounting outside banking**
     (#205 section 4, 9 Oct 2026). Examples AIF1-AIF6.
     - **Added (Full access):** make, edit and approve sales and supplier
       credit notes, apply them and record refunds; apply and refund customer
       overpayments; make, edit and finalise quotes; make, edit and approve
       sales and purchase orders; make and edit repeating invoices and bills;
       approve and pay expense claims; add and edit items, accounts, tracking
       categories and options, and fixed assets; make budgets and set their
       amounts; run depreciation. Each calls the screen's own service.
     - **Reading** (any level): credit notes, supplier credit notes,
       overpayments, quotes, sales and purchase orders, repeating invoices and
       bills, items, tracking, fixed assets and their types, a depreciation
       preview, and budgets. Expense claims (people's own spending) only with
       Full access, read-only.
     - **Approval rules:** a purchase order, bill or expense claim an
       approval rule covers is approved by people only, as AW13 (Jess, 9 Oct
       2026: keep people-only, not "approve where the owner is an approver").
     - **Never:** delete, void, archive, switch off (no tool takes
       `isActive`, and edits keep it as it was), pause or stop a repeating
       document, dispose of an asset, roll back a depreciation run, accept or
       decline a quote, close or cancel an order, payroll, lock dates, GST
       filing, users, roles, keys or settings. Refunds are recorded only at
       Full access (decision 347's "never refunds" stays for the lower
       levels).
     - **Notes:** bills from the bills inbox were already covered (BI4,
       approve_bill). Tracking needs the Advanced reporting module switched
       on, as on the screen. create_account has no idempotency key; a retry
       is refused because the code is taken.

### Remote access, written down (decision 490)

490. **How remote access works, and who can see the traffic** (#208 item 8,
     9 Oct 2026; the ways themselves were decided with Jess on 30 Sep 2026
     and are in FEATURES). Recorded here because DECISIONS had no entry.
     - **Three ways, one at a time:** a Tohyee address (a Cloudflare Worker
       the project runs makes a Cloudflare tunnel for the server; see
       `relay/README.md`), your own domain on Cloudflare (Connect to
       Cloudflare, or a pasted tunnel token), or Tailscale Funnel. None needs
       a port opened on the router.
     - **Who can see the traffic:** with either Cloudflare way, Cloudflare
       decrypts traffic on its network (its privacy policy applies), and for
       a Tohyee address whoever runs the Tohyee address's Cloudflare account
       decides where the address points. Tailscale's Funnel relay doesn't
       decrypt it (Tailscale's Funnel documentation); TLS ends on this
       computer. The Remote access pages say so.
     - **Guards (decisions 483-487):** remote access only with two-step
       sign-in in force; server settings refuse anything that came through a
       proxy; the client address is the nearest proxy's; sign-ins through
       remote access are logged and flagged.
     - **Smaller items:** through remote access `/api/health` answers only
       `{"status": "ok"}` (or "degraded"), not the version or the database's
       state; the server app deletes cloudflared's `cert.pem` (an API token for
       the domain) and tunnel credentials when it starts, in case Connect to
       Cloudflare was interrupted.

### CRM sales roles and teams (decision 491)

491. **Sales reps and managers use the CRM only** (#216 stage 1, Jess 10 Oct
     2026).
     - **Roles:** `sales_rep` and `sales_manager` (core migration 0013),
       ranked below `report_viewer` so nothing of the books, payroll,
       analytics or settings lets them in; the CRM's routes admit them
       through `withCrm`. They have no AI keys or payroll access.
     - **What they see:** every company and person, a shared address book
       (Jess: "all companies and people, own deals and leads"); a rep only
       the deals and tasks they own or are assigned, their own forecast, and
       activities except those on a deal they can't see; a manager also the
       members' of the teams they manage. Others' records are "not found".
       A rep can't give a deal or task to anyone else; a manager only within
       their teams.
     - **No books:** no invoices, credit notes, bills or payments on a
       company's page or timeline, no invoice on a deal, and making an
       invoice or sales order from a won deal stays with bookkeepers. A sales
       role adds a company as a prospect with its name, email, phone,
       address, owner and CRM fields, changes only those, and doesn't
       archive; it can add notes and files on a company.
     - **Teams:** admins and owners make them (Jess: "admins make teams"),
       each with one manager; a person is in one team at most (tenant
       migration 0114). Removing a team leaves everyone's records as they
       are.
     - **Search:** a sales role finds companies, people and its own deals.
     - Viewers and up see and change the CRM as before.

### CRM leads (decision 492)

492. **Leads are their own records, worked then converted** (#216 stage 1,
     Jess 10 Oct 2026: "a separate Lead record", typed in, imported, from a
     web form and from emails).
     - **Statuses:** new, working, unqualified (with a reason) and
       converted. A converted lead doesn't change; an unqualified one is set
       back to working before converting. Leads are never deleted (tenant
       migration 0115).
     - **Owner:** whoever adds or imports it unless they choose someone; web
       form and email leads start unassigned and "to review". A rep sees
       their own; a manager their teams' and unassigned ones; viewers and up
       all (`seesLead`).
     - **Converting:** into an existing company or a new prospect named as
       the lead's company; an existing person there or a new one from the
       lead; and, unless left out, a new opportunity owned by the lead's
       owner with that person as point of contact. The lead's tasks and
       activities keep their lead and also get the company and person, so
       its history shows on them. Converting again returns what it made.
     - **Importing:** a CSV or Excel file whose first row is headings
       (Name or First and Last name, Company, Email, Phone, Job title,
       Source, Notes; common other spellings too), at most 2,000 rows. Each
       row is its own: a bad row or one whose email is already an open lead
       is skipped with the reason; the same file with the same key again adds
       nothing.
     - The web form and email come next (decision 493); finding and merging
       duplicates after that.

### Leads from a web form and from email (decision 493)

493. **Web form and email leads arrive unassigned, to review** (#216 stage
     1; Jess 10 Oct 2026: web form and emails to an address; spam handled
     with a hidden trap field and a rate limit, no outside service).
     - **Web form:** admins add forms on CRM › Leads (a name and an optional
       thank-you page). Each has a random 40-character key; the website's
       form posts to `/api/lead-forms/<organisation>/<key>` at the server's
       remote access address, and Tohyee shows the HTML to paste once remote
       access is on. A form can be switched off. Name (or first and last),
       company, email, phone, job title and message are read; other fields
       go into the lead's notes as "field: value".
     - **Spam:** a hidden `website_url` field only robots fill in (they're
       thanked and nothing is kept), at most 5 sends from one address in 10
       minutes and 60 per form an hour (kept in memory, so a restart starts
       again), the same submission twice in a minute makes one lead, and
       every web lead waits "to review". Unknown keys, switched-off forms and
       organisations without the CRM all get the same "not taking messages".
     - **Email:** admins link a mailbox folder or Gmail label (their own
       CRM mailbox, or IMAP with an app password), read like the bills
       inbox: each email once, never moved, marked or deleted. The sender
       becomes the lead (name and email), the subject and the start of the
       text (Gmail's snippet, Microsoft's preview; none over IMAP) its notes.
       An email from someone who's already an open lead is added to that
       lead as a note instead. Checked every 1-24 hours, or Check now.
     - **Who sees them:** nobody owns them yet, so sales managers, and
       viewers and up, see them (reps don't) until someone takes them.
     - **Not checked against real services:** the form against a real
       website through a real tunnel, and the mailboxes against real Gmail,
       Microsoft and IMAP accounts.

494. **Duplicates: merge CRM-only companies, link ones with accounting
     records** (#216 stage 1; Jess 10 Oct 2026: "merge CRM-only; link if
     invoiced").
     - **Suggested:** companies whose names match once case, accents,
       punctuation and endings like Ltd, Limited, NZ and Co are ignored, or
       that share an email or a phone number (digits only, +64 read as 0);
       people with the same email, or the same name at the same company.
       Archived and merged records, and pairs someone has reviewed, aren't
       suggested again. Adding a company or a lead shows similar companies,
       people and open leads (only leads the person can see) as a warning;
       it never stops the save.
     - **Merging a company:** only one with nothing in the books can be
       merged away. "In the books" means any reference to it outside the
       CRM, found from the database's foreign keys, so a new table that
       refers to companies counts automatically. Its people, deals, tasks,
       activities, converted leads and email links move to the one kept;
       the kept one's empty email, phone and postal address are filled from
       it; its primary person stops being primary if the kept company has
       one. It's archived with `merged_into_contact_id` pointing at the one
       kept. Its notes and files stay on it, because notes and file records
       can't be changed (NF rules); the archived company says where it went.
       No journal, invoice or balance changes, so there's no accounting
       example.
     - **Both have accounting records:** they can't be merged; they're
       marked as the same customer, and each company's page links to the
       other. Merging customers with invoices (moving invoices, statements
       and balances) would change the books and isn't built.
     - **People:** merged only within the same company and only when nothing
       outside the CRM refers to the one merged away; deals, tasks,
       activities, converted leads and email links move; blanks are filled.
       People at different companies can be marked as not duplicates.
     - **Who:** anyone who can change CRM records can mark pairs; merging
       archives a record, so it needs the bookkeeper role or higher (not
       sales reps or managers).

495. **Follow-up rules make tasks, once each** (#216 stage 2; Jess 10 Oct
     2026: all four rules, reminders in Tohyee only).
     - **Rules:** admins and owners add them on CRM › Follow-ups. A rule's
       kind is fixed once made; its name, stage, days and task title can
       change, and it can be switched off.
       - *A new lead arrives:* a task for the lead's owner, due in N days
         (0 = the same day). A lead nobody owns gets one task for each sales
         team manager, or one with nobody assigned when there are no teams.
       - *A deal reaches a stage* (an open one): a task for the deal's
         owner, due N days after it got there. Reaching it again after
         leaving makes a new task; other changes while it stays there don't.
       - *A deal goes quiet:* an open deal with no call, meeting or note, no
         task done and no change by a person for N days (at least 1) gets a
         reminder for its owner, due that day. Once per quiet spell: the
         next one only after something happens and it goes quiet again.
       - *A task is overdue* by N days (at least 1): a task for the
         assignee's sales team manager, once per due date. Tasks of people
         who aren't in a team, or who manage it, are left alone.
     - **Only from when the rule was made:** a lead or a stage change from
       before the rule is ignored, so adding a rule doesn't flood people
       with tasks. Quiet deals and overdue tasks are judged as they stand.
     - **Once each:** every run is kept with a key for its rule and event
       (unique), and the task is made in the same transaction; checks for
       one organisation take turns. A check that runs twice, or two at
       once, never makes a second task. A deal with no owner is recorded as
       skipped, with the reason, instead of making a task.
     - **When:** every 15 minutes while the server runs
       (`TOHYEE_FOLLOW_UP_SCHEDULER=off` turns it off), or Run now. Dates
       are in the business time zone. Nothing is emailed: tasks show on
       the person's task list and CRM home.

496. **Sales emails go from the rep's own mailbox, only when they press
     Send** (#216 stage 2; Jess 10 Oct 2026: the rep's own mailbox; sequences
     make tasks and the rep sends).
     - **Allowing sending:** a member's connected CRM mailbox reads only,
       as before. "Allow sending" signs in again asking for reading plus
       Gmail's gmail.send or Microsoft's Mail.Send; if the sign-in comes
       back without sending (the box unticked), nothing changes and it says
       so. Only the mailbox's own member can send from it.
     - **What can be sent:** one plain-text email to one person: a lead
       (not a converted one), a person, or a deal's point of contact (or a
       person at the deal's company). No attachments, HTML, tracking or
       bulk sending. A sales rep can email only leads and deals they can
       see (decision 491); everyone sees all people.
     - **Templates:** admins and owners write them, with merge fields
       {{first_name}}, {{last_name}}, {{full_name}}, {{company}}, {{deal}},
       {{my_name}} and {{my_email}}; an unknown one is refused when saved,
       and one left in an email is refused when sending. The sender sees
       and can change the filled-in words first.
     - **Don't email:** a lead or person can be marked; Tohyee then refuses
       to send them one.
     - **Once:** every send has an idempotency key. The send is recorded
       before the network call, the call happens outside any transaction,
       and the result is recorded after. A retry with the same key returns
       the result. A clear failure (an error back from Google or Microsoft,
       or no sign-in) can be tried again; one with no clear answer (a
       timeout after handing it over) is marked "may have been sent" and is
       never retried, as for documents (#146).
     - **Logged:** a sent email becomes a note on the lead, person or deal
       ("Email: subject", who it went to and from, and the words). If mail
       sync also picks up the same email from the Sent folder, it can show
       twice on a person's or company's timeline.
     - **Not checked against real services:** Gmail and Microsoft 365
       sending were tested against pretend providers only.

497. **Sequences make tasks; nothing is sent by itself** (#216 stage 2;
     Jess 10 Oct 2026: "make tasks; rep sends").
     - **Steps:** admins and owners set out up to 30 steps on days counted
       from the start (day 0 is the day someone's added): an email (a task
       to send a chosen template), a call, or another task. Steps are in day
       order. They can't change while anyone is part-way through; make a
       new sequence instead. A sequence can be switched off (no one new can
       be added; those in it carry on).
     - **Adding someone:** a lead, a person or a deal, by anyone who can
       change CRM records and can see it (decision 491). Only once at a time
       per sequence. Tasks go to the lead's or deal's owner, else to whoever
       added it.
     - **Tasks:** each step becomes a task on its day (checked with the
       follow-up rules every 15 minutes; day 0 straight away), due that
       day, once each. Email steps are skipped for someone marked "Don't
       email" (decision 496), and say so.
     - **Stops by itself** when a lead is unqualified or converted, a deal
       is won or lost, a person is archived, or they reply: an email from
       their address synced from a member's mailbox after they were added,
       or for a lead, an email from them into a lead mailbox (decision 493).
       Replies only count if a mailbox that receives them is connected.
       Anyone who can see it can stop it. Tasks already made stay.
     - **Merging people** (decision 494) moves their sequences; if both are
       in the same one, the merged-away person's is stopped.

498. **Campaigns: one source each, costs for reports only** (#216 stage 2;
     Jess 10 Oct 2026: one source campaign; budget and cost; members added
     by hand, in bulk, by a form or mailbox, or by an import; added, sent,
     responded).
     - **Campaigns:** admins and owners add them (name, kind, planned /
       active / finished, dates, budget, actual cost, description). Anyone
       in the CRM sees them.
     - **Source:** each lead and each deal has at most one source campaign,
       set by hand, by the web form or lead mailbox it came in through, or
       by choosing one when importing. A deal made from a lead keeps the
       lead's. Changing a deal's source moves it; it's never in two.
     - **Members:** leads and people, added from the Leads list (several at
       once), a lead's or person's page, or automatically with the source.
       "Added", then "sent" once a sales email (decision 496) went to them
       after they were added, and "responded" once they reply (a synced
       email from their address, or for a lead an email into a lead
       mailbox), or when they came in through the campaign's form or
       mailbox. Anyone can set it by hand. A lead's reply is only noticed
       through a lead mailbox, because mail sync keeps only emails with
       people and companies (MAIL3). Merging two people in the same
       campaign keeps one membership.
     - **Costs:** budget and actual cost are typed in, in the base
       currency, for the report: cost per lead (cost ÷ leads it was the
       source of) and per won deal (cost ÷ won deals). When no actual cost
       is entered, the budget is used and the report says so. Nothing is
       posted to the books, so there's no accounting example.
     - **Report:** members by status; leads it was the source of (open,
       converted, unqualified); deals (open, won, lost) with won and open
       amounts per currency, never added across currencies (as forecasts,
       CRMS11). A sales rep or manager sees only their own leads and deals
       counted (decision 491).

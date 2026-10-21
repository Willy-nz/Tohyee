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
     built.** Corrected on 19 October 2026 (#310 item 4; decision 564).
     The reasoning was wrong: it read para 17's "a sick leave obligation is
     likely to be material only if there is a formal or informal
     understanding that unused paid sick leave may be taken as paid annual
     leave" as the test. Paras 16-17 measure accumulating paid absences at
     the additional amount expected to be paid because of the unused
     entitlement carried over, and the standard's own example recognises
     a liability for sick days expected to be used beyond the new
     entitlement, with no annual leave conversion. Whether that's material
     is each organisation's judgement, so Tohyee now takes an assessment
     (decision 564) rather than leaving it out. Bereavement and family
     violence leave don't accumulate (para 13(b): recognised when the
     absence occurs), so they stay out.
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
441. **Automatic eliminations never change profit or net assets**: each
     eliminated amount is taken off its account, and what the two sides
     don't agree on (per pair of organisations, intercompany accounts and
     what's owed each compared on their own) goes back on an "Intercompany
     differences (check these)" line (in the profit and loss; in the balance
     sheet as an asset when a debit, a liability when a credit) with a
     notice naming the amounts (CO9, question 1). This is only the
     automatic matching: an elimination adjustment (decision 443) can and
     sometimes must change them, such as unrealised profit in stock (CO12,
     decision 563). Corrected in #310.
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

650. **Bulk reassignment, with a preview** (#216 stage 1's last item; Codex,
     delegated by owner, 20 October 2026, #360 item 17: bulk reassignment
     first). Xero has no CRM, so this follows Salesforce's Mass Transfer
     Records and HubSpot's bulk Assign. CRM › Settings › Reassign records.
     - **Choose:** from a person, someone who has left, or nobody; to a
       member who can use the CRM and can sign in; and what kinds. **See
       what will move** lists every record (up to 2,000 of each kind), and
       anything can be unticked before **Move**.
     - **What moves:** leads that aren't converted (a converted lead
       doesn't change, decision 492); companies they own; open deals, and
       won and lost ones only when ticked (their wins then count for the new
       owner on forecasts and the dashboard, which work from the owner as it
       is now); tasks that aren't done (done tasks stay with whoever did
       them); and active sequences whose next step tasks go to them. People
       have no owner (decision 491), so only their open tasks and sequences
       move. From nobody: unassigned leads, deals and tasks, never
       companies (most of the books' contacts have no owner).
     - **Who:** admins, owners and bookkeepers, anyone's; a sales manager
       only between themselves and the people in their teams (and
       unassigned leads, which they see); not sales reps or viewers. The
       same checks run again when moving.
     - **History:** each record moved gets its own history line ("Moved to
       someone else with Reassign records", who and when), and the move a
       line of its own, listed on the page as Recent moves. A record that
       changed hands, was converted, closed or done after the preview is
       left alone and counted as skipped, so moving the same list twice
       moves nothing more. Moving a deal is a change by a person, so it
       starts a new quiet spell for "a deal goes quiet" (decision 495). No
       journal, invoice or balance changes, so there's no accounting
       example.
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

651. **A reply from a lead or person becomes a follow-up task** (#216; Codex,
     delegated by owner, 20 October 2026, #360 item 17: lead/reply handling;
     examples MAIL10, RPL1-RPL5, not yet reviewed). Xero has no CRM;
     HubSpot and Salesforce both unenrol someone who replies and tell the
     owner, so the owner gets a task (reminders stay in Tohyee, decision
     495). Already there and kept: sequences stop on a reply (decision 497)
     and campaign members become "responded" (decision 498).
     - **Leads' emails are kept:** mail sync now also keeps emails and
       meetings with a lead that isn't converted, linked to the lead and
       shown on its page, under the same mailbox privacy (MAIL7). Until now a
       lead's reply was only noticed through a lead mailbox (decision 498's
       note). Converting the lead links them to its new person and company.
     - **What's a reply:** an email from their address (synced from a
       member's mailbox, or for a lead into a lead mailbox) after a sales
       email went to them from Tohyee in the 30 days before, or while
       they're in a sequence (on a deal: its point of contact).
     - **The task:** "Reply from <name>: <subject>", due today, for the
       lead's owner, else whoever sent the email or added them to the
       sequence (on a deal, its owner). Someone who has left or can't use the
       CRM isn't given it; it's then unassigned. The subject is left out
       when the mailbox shows only that something happened, unless the task
       is for that mailbox's own member.
     - **Once:** one task per sales email or sequence answered, so a thread
       going back and forth makes one; a new email and a new reply make
       another. Each reply is kept as handled (unique, in the task's
       transaction), so checking twice never makes two. Checked straight
       after each mail sync and with the follow-up rules every 15 minutes.
     - **Not flooding:** replies synced before this version, and replies
       received over 7 days ago, are left alone.
     - Nothing is sent: outbound sequences stay person-confirmed (decision
       497). The lead's status doesn't change by itself.
     - **Not checked against real services:** Gmail and Microsoft 365, as
       for decisions 493 and 496; tested with pretend providers only.
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
       people and companies (MAIL3); since decision 651 it keeps leads'
       too. Merging two people in the same
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

499. **Team forecasts: roll-ups, adjustments and snapshots** (#216 stage 3;
     Jess 10 Oct 2026; replaces the "later" in decision 325).
     - **Teams:** a sales team's figures are its members' and its manager's
       added up, per period and per currency. Currencies are never added
       together or converted (decision 324, kept). Its quota is its people's
       quotas added (base currency). Managers see their own teams; viewers
       and up see every team; reps see no team rows.
     - **Adjustments:** a person's team manager, or an admin or owner, can
       set a different Commit or Best case for one person, period and
       currency, with a reason (required). Managers can't adjust their own.
       The deals don't change. Every change is kept and shown (who, when,
       why); the newest counts; clearing it goes back to the deals' figure.
       Team rows and submitted forecasts show the adjusted figures with the
       deals' own beside them.
     - **Submitted forecasts:** for one period, a person submits their own,
       a manager their team's (or a member's), an admin everyone's. Its
       figures (Closed, Commit, Best case, Open pipeline, weighted, count,
       the adjusted figures and quota, per currency) are kept as they were,
       with an optional note. Later changes to deals don't change it. Reps
       see their own, managers their team's and members', viewers and up
       all.

500. **The standard sales dashboard and its definitions** (#216 stage 3;
     Jess 10 Oct 2026: win rate by close, conversion of leads added, cycle
     from deal added to won). CRM › Dashboard, by month or quarter of the
     financial year (6 months or 4 quarters ending with today's by
     default), worked out from the records each time:
     - **Lead conversion:** of the leads added in a period, how many have
       been converted so far; also by how they came in.
     - **Closed on:** the day a deal moved into the Closed won or lost stage
       it's in now, from its stage history, not its expected close date
       (which Tohyee doesn't change when a deal is won).
     - **Win rate:** won ÷ (won + lost) for deals closed in the period, with
       the won amounts per currency.
     - **Sales cycle:** days from the deal being added to its closed-on
       day, for deals won in the period: average and median, to 1 place.
     - **Stage ageing:** open deals today by stage: how many, their amounts
       per currency, and the average and longest days since they got to
       the stage they're in.
     - **Activity:** calls, meetings and notes by who logged them, tasks by
       who they're assigned to when done, and sales emails by who sent
       them, per period. Ones Tohyee made itself (lead mailbox notes) don't
       count.
     - **Quota attainment:** the forecast's own figure (CRMS10), so the two
       pages agree.
     - **Campaigns:** leads added and deals won in the periods by their
       source campaign (decision 498).
     - Sales reps and managers see only their own (or their teams') figures
       (decision 491). Amounts are never added across currencies. Counts of
       deals open the deals behind them.
652. **The CRM's reporting tables in Analytics** (#216; Codex, delegated by
     owner, 20 October 2026, #360 item 17: reporting datasets; example AB11,
     not yet reviewed). The books and CRM copy (AB1-AB10, decision 367)
     gains `tohyee_crm_leads`, `tohyee_crm_campaigns`,
     `tohyee_crm_campaign_members`, `tohyee_crm_sequences`,
     `tohyee_crm_sequence_enrolments`, `tohyee_crm_sales_emails`,
     `tohyee_crm_deal_products` and `tohyee_crm_tasks`, each with a plain
     name and description in Analytics, and two columns more on existing
     tables (an opportunity's `source_campaign`; an activity's opportunity,
     lead and person ids). Columns are only added, as AB's rules say.
     - **As recorded:** rows as they are in the CRM, nothing worked out to
       match the dashboard (as AB's rules); campaign budget and cost, and
       deal product amounts, exact (excluding GST, in the deal's currency,
       never converted, decision 324).
     - **Left out:** leads' email addresses and phone numbers, and sales
       emails' addresses, subjects and words. Reports count and group;
       mailbox content stays out of shared analytics (as #360 item 10 for
       private mail). Sales emails still being sent aren't copied.
     - **Who sees them:** as the existing CRM tables. Analytics is for
       viewers and up, who already see every CRM record (decision 491);
       sales reps and managers have no Analytics; report viewers see only
       the dashboards shared with them. Per-owner filtering inside Analytics
       isn't built, because nobody who reaches it is limited to their own
       records.
     - Copied only while the CRM is on (AB9); with Accounting off, only the
       `tohyee_crm_*` tables.
501. **Discounts on sales lines** (DS1-DS6; Jess 10 Oct 2026: "add
     discounts to invoices too", sales lines only, examples approved).
     - Invoices, quotes, sales orders, repeating invoices and sales credit
       notes have a "Disc %" on each line, 0 to 100 with up to 2 decimal
       places. Bills, purchase orders, supplier credit notes and expense
       claims don't.
     - Line amount = quantity x unit price x (1 - discount), rounded once
       (`src/lib/invoices/amounts.ts`, the one place line maths lives); GST
       is worked out on that, per line, as before. Revenue is credited with
       the discounted net; there's no separate discounts account.
     - Only a discounted line can come to 0.00 (100% off); a document that
       comes to 0.00 in all is refused, as before.
     - Copying keeps it: quote to invoice, sales order to invoice, repeating
       invoice to invoice, invoice to credit note.
     - The editors, the document pages, printed and PDF documents show a
       "Disc %" column when any line has one. The AI tools take
       `discountPercent` on sales document lines.
     - A line with no discount saves and hashes exactly as before, so
       retries of older requests still match.

502. **Deal products and quotes win the deal** (DS7-DS9; Jess 10 Oct 2026:
     optional lines, the amount from them; quote from the deal, accepting
     wins it, a new revision replaces the open one).
     - **Products:** a deal can have up to 100 lines: an item (optional), a
       description, quantity, unit price and discount, excluding GST. A
       line with an item can leave its description and price blank (the
       item's name and sale price; a deal in another currency needs a
       typed price). With lines, the deal's amount is their total, through
       the usual deal update (so the stage history keeps it) and can't be
       typed; removing every line lets it be typed again. A closed deal's
       products don't change. Sales reps can set products.
     - **Make quote** (bookkeeper or higher, as quotes are in the books):
       a draft quote for the deal's company with its lines, tax exclusive;
       item lines take the item's account and tax code, others the first
       revenue account and the company's (or the standard) GST code. A deal
       with no products quotes its name and amount as one line. A prospect
       becomes a customer. A retry with the same key returns the same quote.
     - **New revision:** a deal has at most one open quote; making another
       deletes the open draft, or declines the open finalised quote (its
       history says it was replaced).
     - **Accepting** a quote made from a deal (as an invoice or a sales
       order) moves the deal to the first active Closed won stage of its
       sales process and links the invoice or order. It never stops the
       quote being accepted: with the CRM off, a deal that already has a
       document, no won stage, or a page layout that won't let it move, the
       deal is left and its history says why.
     - Sales reps and managers see a deal's products but not its quotes.
653. **Account plans** (#216 stage 4; Codex, delegated by owner, 20 October
     2026, #360 item 17: account plans and renewal reminders). Xero has
     nothing like it; this follows Salesforce's account plans (objectives,
     relationship map, actions) and HubSpot's buying roles. On a company's
     Related tab (tenant migration 0175).
     - **One plan per company:** "where things stand" (up to 4,000
       characters); goals in order (up to 50), each with an optional target
       date and open, achieved or dropped; and the part each of its people
       plays (decision maker, budget holder, champion, influencer, user,
       blocker, other) with a short note.
     - **Next steps are tasks:** the company's open tasks, with their owner
       and due date, rather than a second list that wouldn't show on anyone's
       task list. The plan also shows the company's open deals and renewals
       in the next year (and the last 30 days).
     - **Who:** companies are a shared address book (decision 491), so
       everyone in the CRM sees a company's plan and anyone who can change
       CRM records can change it; the deals, renewals and tasks on it are
       only those the person sees. Saving is kept in the company's history.
     - Not built: Salesforce's SWOT and org-chart drawing, and plans for
       a group of companies (#200).
654. **Renewal dates and reminders** (#216 stage 4; same delegation).
     - **Dates:** a deal and each of its products can have a renewal date,
       set on the deal's Renewals card by whoever can change the deal, on
       any deal that isn't lost (renewals mostly follow a win, when the
       products can no longer change). A product keeps its date when the
       products are saved again. CRM only: nothing in the books changes, so
       there's no accounting example; contract or subscription accounting
       stays separate, as the issue says.
     - **Reminder:** a fifth follow-up rule (decision 495), "A renewal is
       coming up": N days before a renewal date (0-365), a task for the
       deal's owner, once per deal and date (the deal's and its products'
       on the same date make one task, naming the products). Dates from
       before the rule was made are ignored; moving a date to next year
       makes a new reminder when that comes near. A deal with no owner is
       skipped, with the reason. As HubSpot's renewal-date workflows.
     - Not built: making the renewal deal itself (Salesforce CPQ's
       automatic renewal opportunities); Jess can decide later.
503. **Livestock (#221) stage 1** (Jess 11 Oct 2026). Examples LV1-LV12
     are approved as written.
     - **First release:** dairy cattle, beef cattle and sheep.
     - **Herd scheme revaluation:** each organisation chooses where it goes,
       either profit and loss (its own non-taxable line) or an equity
       reserve (LV12).
     - **NSC mature group:** averaging only (no FIFO yet).
     - **Agent account sales:** one sales document with its deductions
       (LV7).
     - **Livestock on hand** is a non-current asset.
     - **NSC mature group:** rising two-year and older.
     - **Elections:** each farm's method by class, with the year elected and
       evidence attached. Tohyee files nothing with IRD.
     - **Opening position:** class, head count and value, from last year's
       workpaper.
     - **Still open:** anything in IRD OS 25/02, which hasn't been read.
       Those cases are refused.
504. **Livestock ageing happens at the start of each year, worked out**
     (#221 stage 2; built 11 Oct 2026 from LV1).
     - **When:** at the start of each income year, every class's closing
       head moves to the next class. During the year, classes say what each
       animal will be at balance date. Births go into the rising one-year
       classes.
     - **Worked out, not stored:** a late entry flows through, and ageing
       can't run twice. LV1's figures are unchanged.
     - **Mixed-age ewes:** how many turn rising five is entered per year.
     - **Head counts:** a movement can't take a class below zero on any
       date, ageing included. Stock held for others is kept apart.
     - **Locks:** movements respect the lock date. Stage 3 also locks years
       with an approved valuation.
505. **Livestock year-end valuation** (#221 stage 3; built 11 Oct 2026 from
     LV4-LV12).
     - **Approval:** an admin approves, posting one journal at the year end.
       Last year's valuation must be approved first. The livestock
       account's balance must equal the opening value.
     - **Locked once approved:** a year's movements, opening, rates and
       elections can't change. Replacing reverses the journal.
     - **Rates:** IRD's 2026 NAMV and NSC come with Tohyee, with their
       source.
     - **Income year:** taken from the balance date. April to September
       belongs to the 31 March before; October to March to the next (to be
       confirmed by Jess).
     - **Elections:** by kind, not by class.
     - **NSC:** mature stock that leaves comes out at the opening average,
       before intake and purchases join, as LV6.
506. **Livestock account sales, beef males under NSC, management
     valuations** (#221; Jess 11 Oct 2026, LV13-LV20 approved).
     - **Account sales:** the agent's account sale is the farmer's tax
       invoice (buyer-created). Tohyee issues none of its own. The net is
       owed by the agent and matched when paid.
     - **Beef males under NSC:** non-breeding beef males add NSC until
       rising three, then join the mature group.
     - **Management valuations:** monthly, report only to start with.
507. **How account sales are kept** (built 11 Oct 2026 from LV13-LV16).
     - **Documents:** an invoice to the agent, a bill from the agent, and
       a contra through 1090 Stock agent contra. Together they give LV13's
       net, so GST returns, payments and receivables work as they do.
     - **Numbering:** the invoice takes Tohyee's invoice number, with the
       agent's number as its reference. Jess to confirm.
508. **Livestock stage 4** (#221; Jess 12 Oct 2026, LV21-LV24 approved).
     - **Rules:** from IRD OS 25/02 (31 Mar 2025).
     - **Kinds:** deer (red/wapiti/elk and other breeds) and goats
       (Angora, cashmere/cashgora, dairy) added. Pigs left out.
     - **Herd scheme:** male breeding stock valued at NAMV. A herd value
       ratio (0.9-1.3, or 0.3 for Chatham Islands sheep and beef) is
       recorded with the election.
     - **NSC:** bought young stock at cost, blended.
     - **Mixed methods:** a kind can be under NSC with its male breeding
       stock in the herd scheme (LV26, approved).
     - **High-priced livestock:** each animal carries IRD's depreciation
       rate and its source, typed by the accountant (LV25, approved).
509. **How stage 4 is kept** (built 12 Oct 2026 from LV21-LV26).
     - **Elections:** a herd value ratio and "male breeding stock in the
       herd scheme" are part of the election.
     - **High-priced animals:** each has its own record, with IRD's rate
       and its source. It's valued apart from its class, straight line on
       cost from the year after it's bought, until it reverts.
     - **NSC rates:** stored by IRD's kinds (deer, goats meat and fibre,
       goats dairy).

510. **Jobs and visits are part of Projects** (built 12 Oct 2026 from
     JV1-JV9, #196 stage 8).
     - **A job is a project with a site.** There's no separate jobs
       ledger: visits put time on the project's tasks and materials go on
       its invoice, so profitability and invoicing work as for any
       project.
     - **Visits are for members.** Hours count only once the person
       confirms them (Jess, 8 Oct 2026).
     - **Materials leave stock on the invoice,** as ServiceM8 does with
       Xero (Jess, 12 Oct 2026). They're item lines, so the existing
       stock rules (ST1) post the cost.
     - **Calendar is a file, one way.** The CRM calendar connection only
       reads today, so visits are offered as an .ics download instead.
     - **Reminders stay in Tohyee.** No text or email to the customer.

511. **Rosters are planned cost, not pay** (built 12 Oct 2026 from RS1-RS4,
     #196 stage 9).
     - **Areas carry a weekly budget.** Workforce budgets are monthly, so a
       roster's weekly budget is typed on its area until Jess says how the
       two should connect.
     - **Cost is wages plus employer KiwiSaver** (Jess, 12 Oct 2026), at the
       pay rate on the shift's date. It's an estimate; pay runs still work
       out what's paid.
     - **Unavailability needs a reason; leave only warns.** Leave comes from
       leave bookings, and its kind is never shown on a roster.
     - **Employees see what was published.** Changes wait for "Publish
       changes".

512. **Clocking in uses a device key and PINs** (built 12 Oct 2026 from
     RS5-RS8).
     - **No one signs in on the shop device.** A device key in a cookie
       lets it clock people in and out only. Leaving a manager signed in on
       a shared tablet would expose the books.
     - **PINs are hashed and lock after five wrong tries,** because a
       4-digit PIN is easy to guess.
     - **Clocked time is timesheet input, not pay.** It goes onto the
       timesheet as other work, marked from clock-in, and is approved like
       any timesheet. A submitted or approved week is never changed by a
       clock-out.
     - **A missed clock-out blocks the next clock-in** until a manager
       enters the out time with a reason. This stops a 30-hour shift
       reaching a timesheet.

513. **Income years follow IRD's numbering for every balance date**
     (13 Oct 2026, #243; Jess: "go with what you think").
     - **The rule:** an early balance date (October to March) counts toward
       the tax year ending the following 31 March, and a late one (April to
       September) toward the one before. IRD's examples in SPS 08/04
       confirm it: the year to 30 November 2006 is 2006-07.
     - **What changed:** livestock already did this. R&D numbered by the
       calendar year of the balance date, so for October to December year
       ends it was a year behind. It now matches.
     - **Saved data:** migration 0132 moves those organisations' saved R&D
       years (activities, approvals, tax depreciation) forward one. Labels
       are always "2025-26" style, a calendar year end included.
     - **Two livestock answers kept as built:**
       - Agent account sales take Tohyee's invoice numbers, with the
         agent's number as the reference.
       - Changes to an approved year are refused until it's replaced.

514. **Farming starts from files, private email and plain shapes** (13 Oct
     2026, #249 stage 0; Jess).
     - **Storage:** each organisation's own PostgreSQL and DuckDB, with no
       new server.
     - **Email is its own feature for everyone** (#250). It's private to the
       owner who connects it, and is shared only when the owner files an
       item or approves a rule.
     - **Fertiliser is expensed when bought.** Applying it posts nothing and
       records quantity, nutrients and the paddock's cost share (FB1-FB8).
       Spreading bills are shared by hectares for reports. Accounts 6310
       Fertiliser and lime and 6320 Fertiliser spreading. Tax spreading
       (s EJ 3) is left to the tax return.
     - **No PostGIS in stage 1.** Paddock boundaries are versioned GeoJSON
       in PostgreSQL, with area and validity worked out in TypeScript. The
       Windows installer's EDB binaries and the Docker `postgres:17` image
       have no PostGIS; adding it is later packaging work.


515. **Aerial imagery is the organisation's own LINZ key; farm data goes into
     analytics as recorded** (13 Oct 2026, #249; Jess said to go ahead).
     - **Imagery:** LINZ Basemaps aerial tiles, drawn under the paddock
       outlines in Web Mercator. Each organisation's admin pastes its own
       key from basemaps.linz.govt.nz; Tohyee doesn't ship one. The browser
       loads the tiles straight from LINZ, and Tohyee stores and proxies
       nothing, so no caching question arises.
     - **Key exposure:** the key reaches every browser that shows the map.
       It isn't treated as a secret.
     - **LINZ's terms, checked 13 Oct 2026:** Basemaps is currently free.
       A standard key needs no registration, expires after 90 days, and is
       limited to 1,000 tiles a minute and 1,000,000 a month. Developer
       keys are issued on request. The terms say nothing about caching.
     - **Attribution:** shown whenever imagery is, worded as LINZ's own
       example, with a note that imagery isn't proof of ownership.
     - **Analytics:** while Farming is on, `tohyee_farm_*` tables are copied
       with the books, row for row as recorded. Paddock costs stay with the
       fertiliser planner; these tables carry bill ids and line numbers so
       a report can join `tohyee_bill_lines`.

516. **Soil tests are kept as the lab reported them** (13 Oct 2026, #249
     stage 2; Jess said to keep going).
     - **What a test is:** one sample on one paddock on a date. Each result
       keeps the lab's text (so "<0.5" isn't lost), a number when it is
       one (up to 4 decimal places), and the lab's unit. Units are never
       converted.
     - **No advice:** Tohyee doesn't judge whether a level is high or low,
       or whether a test is too old. The summary shows the latest test and
       how long ago it was, and flags paddocks never tested.
     - **Importing:** CSV or .xlsx, one row per sample. Columns are matched
       by heading, with any unit in brackets after the heading kept. The
       person checks and can change the matching before anything is saved.
       With no paddock column, the sample name is matched to a paddock.
       The same file can't be imported twice.
     - **Not yet checked against a real lab file:** the matching was built
       without a real NZ lab export, so a real Hill Labs or ARL file needs
       checking.
     - **Lab reports:** attached to the test through the existing notes and
       files (record type `soil_test`).
     - **History:** a split leaves tests on the old paddock, as fertiliser
       applications are (FB7).
     - **Analytics:** results are copied as `tohyee_farm_soil_results`.

517. **Paddock shapes come in from any common file, or are drawn in Tohyee**
     (14 Oct 2026, #249; Jess said to keep going).
     - **Files read:** GeoJSON, KML and KMZ (Google Earth and most farm
       mapping apps) and zipped shapefiles. They're read in Tohyee's own
       code: `saxes` for KML, already installed with ExcelJS and now a
       direct dependency, and `yauzl` for zips. No GIS library is added.
     - **Projections:** NZTM2000 shapes are converted with Krüger's series
       to n⁴. The tests compare it with PROJ to within a millimetre.
       NZGD2000 is treated as WGS84 (about a metre's difference). Other
       projections, such as the old NZ Map Grid, are refused with a plain
       message, not guessed. A shapefile must come with its .prj file.
     - **Drawing:** paddocks are drawn on the map by tapping corners, with
       pan, zoom and "My location" (the browser's own location, only when
       asked). An outline that crosses itself can't be saved. An overlap
       with another paddock is a warning, not a refusal, since real
       boundaries are sometimes drawn that way. Redrawing adds a boundary
       version and keeps the old one.

518. **Published rosters can email staff their shifts; the weekly budget
     stays typed** (14 Oct 2026, RS4 and #196; Jess chose "keep typing it").
     - **What's sent:** when publishing, "Email staff their shifts" emails
       each employee their own shifts for that week. A later publish
       emails only those whose shifts changed, including anyone taken off.
     - **Content:** plain text, the business time zone, and no pay figures.
     - **How it's sent:** through the organisation's email, by the same
       queue as approval emails. Approval and roster emails now share one
       sender (`src/lib/email/notices.ts`). Tenant migration 0137.
     - **Not emailed:** anyone without an email address, or everyone when
       email isn't set up, is listed. Publishing still goes ahead.
     - **Weekly budget:** typed on the roster area, not taken from the
       monthly workforce budget.

519. **Dates are typed day first, with shorthand; Ctrl/Cmd+Enter saves**
     (14 Oct 2026, #258).
     - **Where:** transaction-entry date fields (45 of them) use
       `DateInput` (`src/lib/date-entry.ts`) instead of the browser's date
       field. Other date fields keep the browser's own.
     - **What's accepted:** dates day first, digits only, today, +N days,
       +Nw weeks, and +Nm for the Nth of the following month (NZ trade
       terms, the last day if shorter). Impossible dates are refused, not
       rolled over.
     - **Keys:** Ctrl/Cmd+Enter clicks the form's first enabled submit
       button. Enter in a line table moves to the next field. A field that
       handles Enter itself is left alone.
     - **Later (14 Oct 2026):** every other date field uses `DateInput`
       too (decision 525).

520. **A feed with no sync tried for 2 days is "not syncing"** (14 Oct 2026,
     #258).
     - **Why attempts, not successes:** every provider records each attempt
       time (successful or not), so no attempt for 48 hours means syncing
       has stopped, not failed. That's shown on the account's feed badge
       and counted in the top bar.
     - **Failed feeds:** these already have their own notice, which now
       counts all five providers.
     - **Not built:** a re-authorisation email to the login's owner. Akahu
       personal-app tokens are pasted in by an admin, and logins have no
       owner field.

521. **Transfers between your own accounts are suggested, and both sides can
     be reconciled at once** (14 Oct 2026, #258).
     - **What's suggested:** for a statement line, unreconciled lines on the
       organisation's other active bank or card accounts, in the same
       currency, for the opposite amount, within 2 days, are listed on the
       Transfer tab. That tab opens first when there's no exact match or
       invoice or bill.
     - **Both at once:** choosing one sends `otherLineId` with the
       transfer. The other line is matched to the transfer's journal line
       in the same transaction, as the AI tool does (AIB3). If that match
       fails, nothing is saved.
     - **Not covered:** transfers between currencies still need both amounts
       and are matched separately.

522. **The year-end accountant pack is a ZIP of the existing reports**
     (14 Oct 2026, #258).
     - **Built on the server:** the files come from `trialBalance`,
       `profitAndLoss`, `balanceSheet`, `accountTransactions` and
       `bankReconciliationReport`, written with the report export's own CSV
       and PDF writers. Viewers and above can download it, like the reports
       themselves.
     - **ZIP writer:** a small one in Tohyee (`src/lib/zip/write.ts`) using
       Node's own deflate and CRC-32. No library is added.
     - **File name:** the organisation's name, in ASCII in the plain header
       and exact (UTF-8) in `filename*`.

523. **A joint account is recognised by its bank account number too** (14 Oct
     2026, #257).
     - **What's stored:** linking an Akahu account stores the account
       number Akahu reports, as digits. NZ numbers get a 3-digit suffix, so
       -00 and -000 match. A unique index stops the same number being
       linked to two Tohyee accounts.
     - **Why:** this backs up BK36 for logins that give a joint account
       different Akahu ids.
     - **Where the number comes from:** the server fetches it from Akahu
       when linking (tenant migration 0138), so it isn't trusted from the
       browser.
     - **Existing links:** these have no number until they're linked again,
       so they're only checked by Akahu id.

524. **Balance sheet current and non-current subtotals** (14 October 2026,
     #259).
     - **What changed:** the balance sheet splits assets and liabilities
       into current and non-current, each with a subtotal, and shows net
       assets (total assets less total liabilities). The accountant pack's
       balance sheet CSV does the same. Worked example P4, not yet approved.
     - **How accounts are split:** by account type. Bank, current asset,
       inventory, credit card and current liability are current. Fixed
       asset, non-current asset and non-current liability are non-current.
       To move an account, change its type.
     - **Totals:** no total changes, only the layout.
     - **Dates:** the report page's date boxes now use the keyboard date
       field (decision 519), so they show dd/mm/yyyy.

525. **Every date field is typed day first** (14 October 2026, #258).
     - **What changed:** the 119 date fields that still used the browser's
       own date field now use `DateInput`, as transaction entry did
       (decision 519). The browser's field takes its format from the
       computer's settings, so it could show US dates (10/14/2026).
     - **min and max:** the browser's field refused a form with a date
       outside min or max (a due date before its invoice date, a holiday
       outside its pay period). `DateInput` keeps that rule with the
       field's validity, and it also refuses a form while a typed date
       can't be read.
     - **Checked:** pressing Enter in a date field that saves its form
       sends the newly typed date.

526. **Statement of changes in equity and statement of cash flows** (14 October
     2026, #259).
     - **Who decided:** Jess said to go with Claude's judgement. Examples
       SCE1, SCE2 and SCF1-SCF4 aren't reviewed yet.
     - **Changes in equity:** one column. Opening equity (the balance sheet
       the day before), the period's profit, each equity account's movement
       by its name, then closing equity. It's checked against the balance
       sheet.
     - **Cash flows:** indirect method, built from journal lines in the
       period. Cash is the bank accounts. Current assets and liabilities are
       operating; that includes GST, credit cards and payroll liabilities.
       Fixed and non-current assets are investing. Non-current liabilities
       and equity are financing.
     - **Non-cash items:** journals from depreciation runs, livestock
       valuations and exchange revaluations are taken back out as non-cash.
       A hand-entered journal with a depreciation account and no bank line
       counts as depreciation. A fixed asset disposal's gain or loss moves
       to investing as proceeds. Opening-balance journals count as cash at
       the start.
     - **Interest:** stays in operating. NZ IFRS 18 moves interest paid to
       financing for periods from 1 Jan 2027, but special purpose reports
       for small businesses aren't bound by it.
     - **Known limits:**
       - a loan's current portion in a current liability account counts as
         operating;
       - a term deposit only counts as cash if it's set up as a bank
         account;
       - disposal proceeds still owed count as investing straight away.
     - **Where:** Reports > Changes in equity and Cash flows, and both are in
       the year-end pack.

527. **Killed for rations** (14 October 2026, #259).
     - **Who decided:** Jess said to go with Claude's judgement. Examples
       RAT1-RAT4 aren't reviewed yet.
     - **What it is:** a livestock movement, "Killed for rations", with its
       own column in the head count (not a death). It's for the owner's
       household or for staff.
     - **The owner's rations:** income at market value (IR3F: private use
       of produce at market value). This is the only movement that posts:
       Dr Owner drawings, Cr Livestock rations (private use) 7070, on the
       movement's date (origin `livestock_rations`, tenant migration 0139).
       The accounts are made the first time and can be changed in
       Livestock settings. Voiding reverses it on the same date.
     - **Staff rations:** post nothing and take no value. The lower closing
       stock is the cost, like stock used in the business.
     - **GST:** not posted. Claude couldn't confirm the GST treatment, so a
       rural accountant should check it before this is relied on.
     - **Cash flows:** the owner's rations are income with no cash, so
       they're taken back out of operating, and the drawings aren't shown
       in financing.

528. **Landed cost spread across a bill's stock** (14 October 2026, #259).
     - **Who decided:** Jess said to go with Claude's judgement. Examples
       LDC1-LDC5 aren't reviewed yet.
     - **What it does:** on an approved bill that received stock, "Landed
       cost" spreads freight, duty or insurance from another bill (excluding
       GST) over that stock, by value (the default) or by quantity. Shares
       are rounded to the cent and add up exactly; a leftover cent goes to
       the largest line.
     - **Stock already sold:** for each line, the share of what the bill
       received that's still on hand goes onto the stock (a landed_cost
       movement, Dr inventory). The rest goes to cost of sales. Both credit
       the account the cost was coded to on its own bill (Freight inwards,
       say), so nothing is counted twice.
     - **GST:** import GST is claimed back, so it's never stock cost.
       Customs duty, freight and insurance are.
     - **Records:** allocations are kept, and can't be changed, in
       `landed_cost_allocations` and its lines (tenant migration 0140).
       After an allocation, the bill can't be voided without re-costing,
       like any bill whose stock has moved since.
     - **Not built:** undoing an allocation (post a stocktake adjustment or
       journal instead), and allocating by weight (items have no weight).

529. **Recoding a posted line** (14 October 2026, #258, #259).
     - **Who decided:** Jess said to go with Claude's judgement. Examples
       RCD1-RCD6 aren't reviewed yet.
     - **What changes:** only a line's account and tracking, on an approved
       invoice or bill or a posted bank transaction, with a reason. Its
       amount, GST code, contact and control accounts never change, so a
       filed GST return isn't affected.
     - **The journal:** a correcting journal (origin `recode`) on the
       document's own date moves the line's base-currency net amount from
       the old account and tracking to the new. The document line is then
       updated so the document matches the ledger.
     - **The database:** the line guards allow this one change only while
       the recode sets `tohyee.recoding` for its transaction; any other
       change to a posted line is still refused. Recodes are kept, and can't
       be changed, in `document_recodes` (tenant migration 0141).
     - **Why the original date:** the profit and loss for that period ends
       up right. Because the journal is dated then, the period must be after
       the lock date; for a locked period, use a journal in an open period.
     - **Refused:** stock lines (they moved stock); fixed asset accounts
       (use the register); control accounts (bank, card, receivables,
       payables, GST, stock); drafts and voided documents.
     - **Not built:** credit notes, which are voided and re-entered.

530. **The GST return shows how a part payment's GST was worked out** (14
     October 2026, #258).
     - **What's shown:** on the payments and hybrid bases, a line counted
       because of a settlement has its GST as an expandable cell: amount paid
       ÷ document total = share; share × the line's GST = the working. When
       the counted GST differs by the leftover cent (G12), the cell says the
       cent went on the largest line so the lines add up.
     - **The figures:** nothing changes in how they're worked out. Lines
       worked out now carry `lineGst` (the line's whole GST). Filed returns
       keep only the share, so their lines show the GST without the working.

531. **Farm benchmarks** (14 October 2026, #259).
     - **Who decided:** Jess said to keep going. Examples FK1-FK4 aren't
       reviewed yet.
     - **What it is:** Farm > Benchmarks shows the year's gross farm revenue
       (its revenue accounts), farm working expenses by group, and the
       operating surplus (revenue less working expenses). Each is shown in
       total and per kg of milk solids, effective hectare, peak cow milked
       and stock unit.
     - **The groups:** 18 groups based on common NZ dairy farm working
       expense categories (wages, animal health, breeding, farm dairy,
       electricity, feed, grazing, fertiliser, irrigation, regrassing, weed
       and pest, vehicles, repairs, freight, administration, insurance,
       rates, other).
     - **What counts:** only expense accounts someone puts in a group are
       working expenses. Accounts left out are listed with their amounts, so
       nothing is dropped silently. Depreciation, interest, rent and tax
       should stay out.
     - **The year's figures:** entered per financial year
       (`farm_year_figures`, tenant migration 0142). Effective hectares
       starts from the active paddocks. A figure that isn't entered gives no
       per-unit column rather than a guess.
     - **Not built:** per-farm splits (the ledger is per organisation), a
       stock unit calculator, and comparison with industry averages.

532. **Year-end financial statements with notes** (14 October 2026, #259).
     - **Who decided:** Jess said to keep going. Examples FS1-FS3 aren't
       reviewed yet.
     - **What it is:** Accountant > Financial statements gives one PDF of
       special purpose statements: a cover and contents, then the
       statements of financial performance, financial position (current
       and non-current, net assets), changes in equity and cash flows, each
       with last year beside it, matched by account. Notes come last. It's
       also in the year-end pack.
     - **The notes:** the organisation's own, edited in Tohyee and kept in
       `financial_statement_notes` (tenant migration 0143). Until they're
       saved, drafts are offered to suit the organisation (GST registered
       or not, stock, fixed assets, livestock), with [square brackets] where
       the preparer must fill in or confirm. The PDF marks them "DRAFT".
       The drafts are a starting point, not advice: they need checking by
       the preparer.
     - **Not built:** Tier 3 and Tier 4 public benefit entity formats (they
       need a statement of service performance and their own layouts),
       a directors' or trustees' approval page, and audit reports.

533. **The AI's farm workspace** (14 October 2026).
     - **Bring your own AI:** Jess confirmed it. People chat with their own
       AI in its own app (Claude, ChatGPT and others), connected by an AI key
       as before (decision 339). Tohyee has no chat box and calls no AI
       itself.
     - **What it adds:** 13 read tools and 6 "Make drafts" tools, and
       screens to see what the AI makes. The workspace is in tenant
       migration 0144:
       - the farm notebook (`farm_notebook`);
       - files left for the AI (`ai_files`, up to 10 MB each);
       - the AI's own tables (`ai_datasets`, `ai_dataset_rows`, values as
         typed JSON with numbers as exact decimal text, totalled in
         numeric);
       - dashboards over them (`ai_dashboards`);
       - suggested livestock movements (`livestock_suggestions`).
     - **The AI organises messy data its own way:** it decides its tables
       and columns, and Tohyee checks each row against them.
     - **Livestock:** the AI only reads official records. Movements it finds
       are suggestions a person accepts (recorded with every check) or
       declines, because they feed the IRD livestock valuation.
     - **Staff:** depends who's asking (Jess's choice). Names, jobs and
       dates are given to everyone; pay only when the key's owner has
       payroll access; IRD numbers, bank accounts and dates of birth never.
       This narrows decision 342 ("no payroll") rather than reversing it.
     - **Never deletes:** the AI can replace rows in its own tables and
       replace its own dashboards, but only people archive notes, files,
       tables and dashboards. Nothing in the books changes.
     - **Not built:** reading PDFs or photos left for the AI (save them as
       CSV, Excel or text), and dashboards straight over the books (the AI
       copies what it needs into its tables).

534. **Remote access hardening** (15 October 2026). From an internal
     security review; each change has a test.
     - **Request bodies:** the public lead form and the MCP endpoint read
       their bodies through `readLimitedBytes` (`src/lib/net/limited-body.ts`),
       which stops at the limit however the body is sent (64 KB for a form,
       2 MB for MCP). A lead form's thank-you page must be https, and a
       saved http one is no longer redirected to.
     - **AI keys:** 30 wrong keys a minute from one address and that address
       waits a minute (429).
     - **Visitor addresses:** `clientAddress` skips every way of writing
       this computer (127.x, ::1, 0:0:0:0:0:0:0:1, ::ffff:127.x), entries
       that aren't addresses, and proxies listed in
       `TOHYEE_TRUSTED_PROXIES`.
       - Not done: `next start` can't see the connection's own address, so
         with Tohyee's port opened straight to the internet (no tunnel or
         proxy) a visitor's own X-Forwarded-For is all there is. That
         set-up isn't supported; the tunnels Tohyee offers are.
       - Not done: preferring `cf-connecting-ip`. Cloudflare already adds
         the visitor's address to the end of X-Forwarded-For, which is what
         Tohyee reads; a direct visitor could send `cf-connecting-ip`
         themselves.
     - **What counts as remote access** (two-step needed without the secret
       key): as well as Cloudflare and Tailscale, any request whose Host or
       X-Forwarded-Host is a public name or address, or whose
       X-Forwarded-For has a public address. Local means localhost,
       private and link-local addresses, one-word names, and names ending
       .local, .lan, .home, .home.arpa, .internal, .localdomain or .test.
       A server reached on the local network by a public domain name (split
       DNS) now counts as remote, so it needs `TOHYEE_SECRET_KEY`.
     - **Tohyee address service:** moving an existing address to a different
       port needs that address's release key; the Tohyee server sends it
       when it has one. The same install asking again on the same port
       still gets its address back without the key, so a server that lost
       its key can recover (and the Windows app keeps working). Requiring
       the key for every re-issue is a choice for Jess: it would stop that
       recovery.
     - **Outgoing calls to typed-in addresses:** WooCommerce stores and
       SimpleFIN Bridges go through `publicFetch`, which checks the
       addresses when each connection is made and connects to a checked
       one; IMAP mailboxes connect to the address they were checked at,
       with the name for TLS, on every connection including attachment
       reads. Store addresses can't be local and can only use port 443 or
       8443. SimpleFIN answers are capped at 10 MB, platform answers at
       20 MB.
     - **Workbooks left for the AI:** checked with `checkXlsxArchive`
       before ExcelJS opens them (at most 64 MB unpacked), on upload and on
       reading; .xlsm is no longer accepted. They're still read inside the
       tool's read-only transaction; the check bounds the work.
     - **Origins:** without a public address set, links and OAuth returns
       use the Host the request came to, never X-Forwarded-Host. OAuth
       returns through remote access use the public address.
     - **Already in place:** the setup-link check (`GET
       /api/auth/setup-account`) has been rate-limited since it was built
       (decision 484).

535. **Price changes on repeating invoices** (15 October 2026). Jess asked
     for it after seeing a Xero add-on that bulk-changes repeating invoice
     prices, and asked for the open questions to be answered for her.
     Examples RP1-RP8 (not yet approved), tenant migration 0145.
     - **Decided for Jess:** the change applies to the unit price as entered
       (the GST-inclusive price on an inclusive template), and rounding
       rounds that same price; a line's discount percent stays; the item's
       price in Products and services isn't changed; repeating bills
       aren't included.
     - **From a date:** a template changes straight away when its next
       invoice is dated on or after the change; otherwise the change waits
       and is made by the job just before the first invoice dated on or
       after it, so catching up earlier dates keeps the old price.
     - **Safe to come back to:** each line remembers its old and new price.
       A line edited since is left alone, with why. Undo cancels what's
       waiting and puts back old prices only on lines still at the new one.
     - Templates post nothing, so neither does a price change.

536. **Tier 3 and Tier 4 not-for-profit performance reports** (15 October
     2026). Jess said to use judgement on what's next; her bookkeeping
     clients are clubs and charities. Examples NPR1-NPR10 (not yet
     reviewed), tenant migration 0146, from XRB's Tier 3 and Tier 4 (NFP)
     standards for periods from 1 April 2024 and Charities Services' Tier 4
     template.
     - **Format per organisation:** special purpose (as before), Tier 3 or
       Tier 4. The year-end PDF, on screen and in the accountant pack,
       follows the choice. Tohyee doesn't work out the tier.
     - **Categories:** every account in one of XRB's minimum categories,
       chosen or suggested from its type. The screen counts suggestions.
     - **Cash by what it was for:** each cash movement takes the category
       of the other side of the entry; customer and supplier payments take
       the categories of the invoice or bill lines they paid, in
       proportion. Credit cards count as cash. GST is one net line.
     - **Choices made for Jess, to check:** capital grants show under
       "General grants received" in Tier 4 (the template has no capital
       grants line); capital received from or paid to owners, rare for a
       not-for-profit, has its own Tier 4 "other activities" lines as the
       template has none; inventory bought counts as commercial payments;
       opening balance journals count as cash movements in the year they're
       dated (changed by decision 538: now their own line, NPR11).
     - **Not built:** grant registers and deferral of conditional grants
       (the report shows what the books say), consolidated or group
       reports, audit or review reports, and filing with Charities
       Services.

537. **Follow Xero or NetSuite until a real person says otherwise** (15
     October 2026). Jess: "The questions are a lot and i would rather just
     go with what xero/netsuite do until a real person says otherwise."
     - Where an accounting or behaviour question would otherwise wait for
       Jess, Tohyee does what Xero does (or NetSuite, where Xero has no
       equivalent, such as multi-entity), writes the worked example and
       test first as before, and marks the example "as Xero does, not yet
       reviewed" with the date.
     - It doesn't apply where the law decides (tax, payroll, employment),
       where the change can't be undone, or where Xero and NetSuite differ
       in a way that matters; those still go to Jess.
     - When Jess, her accountant or a real user disagrees, their answer
       wins and the example is updated.

538. **Rough edges from using Tohyee as a bookkeeper would** (issue #284,
     15 October 2026). Under decision 537:
     - **Free and negative sales lines** (ZN1-ZN4, tenant migration 0147):
       invoices, quotes, sales orders and repeating invoices accept a 0.00
       line (shown, posts nothing) and negative lines, as Xero does. The
       document total must still be above zero; a negative total is a
       credit note. A negative line on its own account is a debit there.
       Bills followed in decision 539.
     - **Opening balances in performance reports** (NPR11): a journal
       entered as opening balances, or with a line on retained earnings or
       conversion clearing, shows its cash on its own line rather than as
       operating receipts or a purchase of equipment, as Xero keeps
       conversion balances out of cash flows.
     - **Copy last week on rosters** (RS9), as Deputy and Xero do.
     - **Screens:** AI dashboard numbers show at most two decimal places,
       pie and donut labels wrap instead of being cut off, single-number
       tiles sit in a compact row, and wide tiles span the row; farm
       benchmarks open on the last finished year; the aerial imagery
       warning shows above the map; form fields that were meant to sit side
       by side (price changes, livestock) now do; the financial statements
       page folds its long sections; the categories list hides accounts
       nothing has been posted to until asked.

539. **Free and negative lines on bills** (15 October 2026, Jess: "Yes add
     that"). Examples ZN5-ZN8 (as Xero does, not yet reviewed), tenant
     migration 0148.
     - Bills, purchase orders and repeating bills accept 0.00 and negative
       lines; the total must be above zero, otherwise it's a supplier
       credit note. A negative line on its own account credits it.
     - Stock items on bills can't be free or negative: the line sets the
       stock's cost. Bill lines still can't go to revenue accounts.
     - A document's GST total can now be below zero (a negative line with
       GST and the rest exempt), on sales documents as well; it posts to
       the other side of the GST account. The database had refused it.

540. **A general ledger brought in as history** (15 October 2026). Jess
     wants to test Tohyee with a year of her family farm's MYOB books and
     chose one journal per transaction, hidden from the journal list
     ("Yea hidden from manual jnl list like you suggested"). Examples
     IM22-IM28 (as NetSuite's journal import does, not yet reviewed),
     tenant migration 0149.
     - Rows with the same date and ID# are one journal (origin `history`),
       after the opening balances' date and outside locked periods. All or
       nothing; each journal must balance; accounts must exist.
     - A transaction (date and ID#) can't be imported twice.
     - Lines post straight to the accounts named, including accounts
       receivable, payable and inventory; open invoices, bills and stock
       records don't change. No GST codes, so GST returns leave them out.
     - Not built: undo, foreign currency, tracking and contacts on lines.
     - Real data stays in Jess's own organisation; nothing from it goes
       into the repository or its tests.

541. **Hardening after an outside review** (15 October 2026). Jess passed
     on a review of six points; Claude checked each against the code. Done:
     - Outgoing connections: the check that an address is on the internet
       now reads every way an IPv6 address can be written, including IPv4
       carried inside IPv6, and refuses more special-purpose ranges. The
       documentation ranges still count as public (they stand in for
       public addresses in examples and tests).
     - Writes with a session cookie but neither Origin nor Sec-Fetch-Site
       are refused (scripts without a session are unaffected).
     - The server settings address refuses requests a browser marks as
       coming from another website.
     - Stored secrets are encrypted with their own HKDF-derived key (v2);
       v1 secrets still open, and keyed digests are unchanged.
     - Not changed: how the visitor's address is read (decision 534 still
       stands), and the address service's recovery without the release key
       (decision 534; Jess chose to keep it on 15 October 2026).

542. **Remote access pauses itself when someone is guessing** (15 October
     2026). Jess wants to use Tailscale Funnel to show Tohyee and try it at
     work, and chose "auto pause on attack" from the options offered.
     - 20 failed (or locked) sign-ins through remote access within 10
       minutes, counting every login and address together, pause remote
       access for an hour; again within a day doubles it (2, 4… up to 24
       hours). The per-address limit and per-login lockout catch one
       guesser; this catches many addresses guessing at once.
     - While paused, signing in and anything needing a session through
       remote access are refused with a message saying until when; the
       local network is unaffected, and so are public links that need no
       sign-in (Pay now, lead forms, webhooks).
     - Refusals while paused don't count, so a pause can't extend itself;
       after it ends (or is resumed), it takes a fresh 20 failures to pause
       again.
     - Server admins are emailed; the pause and any resume are in the admin
       audit log. Resuming early is on the server computer only.
     - Tohyee can't switch Funnel or the Cloudflare tunnel off (they run
       outside it); it refuses what comes through them.

543. **An unreadable authenticator key no longer resets with the password**
     (16 October 2026). From a review Jess passed on: "A password alone
     should not authorise replacing it." Before, if the server's
     TOHYEE_SECRET_KEY changed so a login's authenticator key couldn't be
     read, the right password started two-step set-up again, so for that
     moment the password alone was enough to sign in.
     - Now the key is kept and an authenticator code is refused with a
       message saying what to do. A backup code still signs in; otherwise
       it's the existing recovery for a lost phone: the emailed reset link,
       or a server admin on the server computer (Users, or the admin CLI's
       `users reset-two-step`).
     - Each refusal is in the admin audit log and the sign-in monitor.
     - Putting the right key back makes the same authenticator work again.

544. **Credit that could be used** (16 October 2026). Jess asked about a
     tool that finds unapplied credit notes in Xero files and said "Ok sure"
     to nudges in Tohyee. Bills and invoices already showed a contact's
     unused credit. Added (PC13, chosen by Claude, not yet reviewed):
     - A period close check: a contact with credit left (supplier credit
       notes; customer credit notes and overpayments) and something due in
       the same currency, both on or before the month end, is a warning an
       owner or admin can close past. Credit with nothing due passes.
     - The Pay bills and Receive payments screens show the chosen contact's
       unused credit before anything is paid.

545. **Income tax, stage 1** (16 October 2026). Jess asked for a tax module
     that forecasts tax and makes NZ tax returns (#292) and agreed the first
     slice: companies and sole traders, tax treatment per account, taxable
     income, standard provisional tax, end-of-year tax, and typing in IRD's
     figures. Tax is law, so the examples (ITX1-ITX10) come from IRD's
     published rules, not from Xero, and stay "not yet reviewed" until Jess or
     Will checks them. Chosen by Claude for this stage, not yet reviewed:
     - Only a 31 March balance date and income years 2025 onwards; other
       cases say they aren't supported rather than guessing.
     - Only owners and admins see income tax (a sole trader's other income is
       personal).
     - Book depreciation stands in for tax depreciation until the tax
       depreciation register is built; the screen says so.
     - IRD figures and payments to IRD are typed (labelled "typed from IRD");
       Tohyee's own figures are labelled estimates. Nothing posts, files,
       pays or elects a provisional tax option.
     - Next: tax depreciation register with Investment Boost, IR10, the
       imputation credit account, reading IRD documents with AI and a
       person checking, and picking IRD payments from the bank.

546. **Tax depreciation and Investment Boost** (16 October 2026). Jess said
     "Ok lets go" to the next income tax stage. Chosen by Claude, from IRD's
     pages and not yet reviewed (ITX11-ITX18):
     - Tax details sit on fixed assets in the existing register; book
       depreciation keeps posting. Tohyee has no list of IRD rates: the rate
       is typed from IRD's rate finder.
     - Where IRD's pages are silent, Tohyee rounds each year's depreciation
       half up to the cent, reduces the ATV by the full depreciation of a
       part-private asset, and scales recovered amounts and losses by
       business use. These readings are flagged on the screen.
     - Only owners and admins, like the rest of income tax.

547. **The IR10 from the books** (16 October 2026). Jess said "Cool do that"
     to the IR10 next. Chosen by Claude from IRD's IR10 form and IR10G guide,
     not yet reviewed (ITX19-ITX24): each account is given an IR10 box with
     defaults by type and for Tohyee's starting chart; drawings, dividends
     paid and current accounts are marked on accounts; amounts keep cents;
     box 26 (exceptional items) is left blank; box 58's sign is credit
     positive. Shown for finished income years only; nothing is filed.

548. **The imputation credit account** (16 October 2026). Jess said "Ok" to
     the next tax stage. Chosen by Claude from IRD's IR274, not yet reviewed
     (ITX25-ITX29): companies only; income tax paid comes from the payments
     already typed on the Income tax page; dividends, refunds, RWT and other
     entries are typed; credits over 28/72 of a dividend are refused and a
     ratio different from the year's first dividend is flagged; a debit
     balance at 31 March shows further income tax and 10% penalty due 20
     June. Shareholder continuity debits aren't worked out.

549. **IRD documents read by the connected AI** (16 October 2026). Jess said
     "Ok" to the next tax stage; she'd asked for IRD figures to come in
     "manually or with AI and human checks". Chosen by Claude following the
     bills inbox (decisions 339-348), not yet reviewed (ITX30-ITX35): IRD
     files are uploaded by owners and admins; the organisation's own AI can
     read them and propose figures only when its key's owner is an owner or
     admin; nothing changes until a person accepts a proposal. Tohyee calls
     no AI and never touches myIR.

550. **IRD payments picked from the books** (16 October 2026). Jess said "ok
     sounds good". Chosen by Claude, not yet reviewed (ITX36-ITX40): owners
     and admins choose the accounts IRD income tax payments are coded to;
     debits to them paid from a bank or credit card are offered with a
     suggested income year from the date, and counting one links it so it
     can't count twice. Refunds are listed, not counted.

551. **Income tax for other balance dates** (17 October 2026). Jess said "ok
     keep going". From IRD's SPS 24/01 and the Income Tax Act 2007 schedule
     3 part A (ITX41-ITX43, not yet reviewed): income years follow the
     early/late balance date rule R&D already uses; provisional tax is due
     on the 28th of the 5th, 9th and 13th months after the balance date (28
     December is 15 January, 28 April is 7 May). The end-of-year tax date for
     April to September balance dates isn't shown until Jess or Will
     confirms which February (and April) it is.

552. **Use-of-money interest estimate** (17 October 2026). Jess said "Ok keep
     going". From IRD's pages, not yet reviewed (ITX44-ITX48): IRD's dated
     rates; simple daily interest over 365 days; days from the day after the
     due date (or the next business day) to the payment day; the $60,000
     rules for the standard option; no interest on $100 or less; payments
     to the earliest amount due. Overpayment interest isn't worked out.
553. **IR4 income and tax boxes** (17 October 2026). Jess said "Use my
     computer to download them"; Claude downloaded IRD's 2026 IR4 and IR3
     forms and IR3 guide into her Downloads folder and read the IR4. The
     Income tax page fills the IR4's boxes 20B-30L for a company once its
     income year has ended, using only the arithmetic the form prints
     (ITX50-ITX53, not yet reviewed). Boxes Tohyee has no figures for
     (donations, group losses, overseas tax, imputation credits received,
     RLWT, the foreign investor tax credit) are 0.00 with a note; the typed
     tax credits go in 30I. The cents on 30A are kept because the form
     doesn't say whether to drop or round them. Nothing is filed.
554. **IR3 income boxes and tax worksheet** (17 October 2026). Jess said
     "Ok keep going". From IRD's 2026 IR3 form and IR3 guide, read in her
     Chrome, not yet reviewed (ITX54-ITX57): a sole trader's Income tax page
     fills IR3 boxes 24-32 and the guide's Question 36 worksheet once the
     income year has ended. The typed other income is shown on its own line
     for the person to put in the right box. IETC, PIE, the ACC earners'
     levy, Working for Families and student loans aren't worked out. The
     IR4 guide, read the same day, confirms box 27 = 25 - 26B.
555. **Imputation credits and overseas tax typed apart** (17 October 2026).
     Claude asked whether Tohyee should record imputation credits and
     overseas tax paid separately from RWT; Jess said "Yes". Each income
     year now has three credit figures, applied in the IR4 and IR3's order
     (ITX58-ITX61, not yet reviewed): overseas tax and imputation credits
     bring the tax to nil but no further; the rest is refundable. A
     company's excess imputation credits become a loss (÷ 0.28); an
     individual's carry forward as credits. Figures already typed as tax
     credits aren't split automatically, because Tohyee can't tell what
     they were. The connected AI can propose the two new figures.
556. **Next year's provisional tax on the returns; imputation credits
     brought forward** (17 October 2026). Claude offered both; Jess said
     "Yes do those things". From the 2026 IR4 and IR3 guides, not yet
     reviewed (ITX62-ITX65): the IR4's box 33 and IR3's box 39 show the
     standard option (RIT plus 5%) when the RIT is more than 5,000.00; an
     individual types excess imputation credits brought forward from IRD's
     letter, and Tohyee compares it with its own figure for last year. The
     cents on the provisional tax amount are kept for now.
557. **Jess's answers to the income tax questions** (17 October 2026).
     Claude asked; Jess chose answers. Drop the cents (not round) on IR4 30A
     and 33B, IR3 worksheet box 1 and 39B, and every IR10 box, and work the
     tax out on whole dollars. End-of-year tax for April to September
     balance dates is due in February (April with a tax agent) of the
     calendar year after the balance date. Confirmed as built: $78,100 for
     the 33% band; ATV down by the full depreciation for part-private
     assets; IR10 box 58 with money owed to the owners positive; interest
     ÷ 365 with the payment day charged; the imputation loss rounded to the
     cent; unused overseas tax lost. Still for Will: the "paid towards" rule
     for a late-filed return (ITX6). The worked examples go into a document
     for Will to review (ITX66).
558. **Provisional tax shortfalls counted once** (18 October 2026). A
     review comment on issue #292 found the late-filed schedule's year total
     added up what's due, counting a caught-up shortfall twice. Jess said
     "Yes" to fixing it. Each instalment now has a cumulative target: its
     own share, what's due (with any shortfall caught up), and the year's
     total is the last target (ITX6). The extension-of-time point from the
     same review waits for Jess or Will.
559. **Pasture and feed records** (19 October 2026). Claude offered pasture
     and feed records, AI read tools for farm data and a Farming API for
     people's own apps; Jess said "Yea do those". #249 stage 4 (PF1-PF8,
     not yet reviewed): cover readings (typed or imported, satellite and
     model labelled as estimates), growth only between same-method readings
     with no grazing between, the farm's area-weighted cover and feed wedge
     on a date, grazings with what was eaten, and supplements fed in kg DM
     without converting units. Records only: no cover judged, no feed plan
     or target, nothing posts. Stored in the organisation's PostgreSQL and
     copied to its analytics file, as decided for #249.
560. **The AI reads soil, fertiliser and pasture data** (19 October 2026).
     The second of the three Jess agreed to (decision 559). Read-only tools
     for soil tests, fertiliser products and plans, pasture cover,
     readings, grazings and supplements, and a fertiliser "what if" that
     works out tonnes, nutrients and cost for a rate the person or AI
     gives, saving nothing (AIW10-AIW14, not yet reviewed). Tohyee doesn't
     suggest rates or judge results; the tool descriptions tell the AI so.
     Farming's viewers and up can use them, as on the screens.
561. **A Farming API for people's own apps** (19 October 2026). The third of
     the three Jess agreed to (decision 559), following #249 section 5.
     `/api/farm-apps/v1` with per-person app keys (`tohyee_app_…`, only the
     SHA-256 kept, in the core database like AI keys) and five scopes: read
     farm, soil and pasture; record soil samples and pasture readings
     (bookkeeper or higher, checked at use). Keys only, never cookies, so
     it answers browsers on any site (CORS). Records say which app made
     them. An OpenAPI 3.1 contract, a guide (docs/FARM-APPS.md) and a
     one-file soil sampling app. New: soil samples taken in the field
     (FA4). Photos aren't taken yet. FA1-FA8, not yet reviewed.
562. **Provisional tax: the extension-of-time condition** (19 October 2026).
     From issue #310; Jess chose "as IRD's page says". Two years ago plus
     10% applies only with an extension of time to file (Tohyee's tax
     agent's extension setting); without one, last year's RIT plus 5%
     applies however late the return is, from Tohyee's estimate until IRD's
     figure is typed (ITX67). Supersedes the open point in decision 558.
563. **Unrealised profit is taken out by an adjustment** (19 October 2026).
     #310 pointed out that decision 441 read as if consolidation never
     changes profit, which isn't right when one group company sells to
     another at a profit and the goods (or an asset) are still in the group.
     Jess: "Fix wording and support it". Decision 441 now says it's only the
     automatic matching. Tohyee doesn't work out unrealised profit itself
     (it would need to know what's still on hand and its cost); the
     accountant types an elimination adjustment, which reduces consolidated
     profit and the asset (CO12, not yet reviewed).
564. **Expected sick leave in the leave liability** (19 October 2026). #310
     item 4; Jess: "Fix wording and add it" (decision 188 corrected).
     Someone with payroll access records, per employee and from a date,
     the sick days expected to be taken from carried-over leave beyond
     new entitlements, with a reason (none needed for 0, which takes it
     out). The latest assessment on or before the report's date applies;
     it's never more than the employee's sick leave balance at that date,
     valued at a usual day's pay (ordinary weekly pay ÷ usual days, as
     alternative holidays, decision 153), and is part of each employee's
     total, so the employer KiwiSaver (decision 190), the Departments and
     the posting (decision 177) include it. Refused above the balance on
     the assessment's date. Assessments are kept, never edited. Tohyee
     doesn't estimate the days: that judgement (and whether it's material)
     is the organisation's. Finished employees aren't paid sick leave, so
     it doesn't apply to them. HL62, tenant migration 0160, not yet
     reviewed.
565. **Tax form cents stay dropped, marked unconfirmed** (19 October 2026).
     #310 item 6 asked for decision 557's rule to be checked field by field.
     Jess: "Keep dropping cents". What IRD's material says, as read on 17
     October 2026: the IR4 form prints 30A in whole dollars, and neither
     the IR4 nor the IR3 guide says whether to round or drop the cents;
     the IR10 form wasn't checked for it. So the rule is Jess's choice,
     not a confirmed IRD rule, for every field it covers: IR4 30A and 33B, IR3
     worksheet box 1 and 39B, and every IR10 box. As built: cents are
     dropped towards zero (a loss of 12,000.75 is -12,000), tax is worked
     out on the whole dollars of taxable income, the boxes after 30A (IR4)
     and box 1 (IR3) keep cents, and each IR10 box drops its own cents
     with the checks using the figures with cents (ITX66, ITX68). IRD's
     electronic filing specification wasn't read. Not yet reviewed by an
     accountant.
566. **Livestock is current or non-current per class** (19 October 2026).
     #310 item 2: decision 503's answer "non-current asset" for all
     livestock doesn't fit stock held for sale (NZ IAS 1 para 66). Jess:
     "Choose per class". Each class is current or non-current, non-current
     unless chosen (so nothing changes for farms that don't choose). The
     next valuation approved moves the current classes' closing value
     (with their high-priced animals) to a current asset account, 1490
     Livestock on hand (current), made when a class is first made
     current: the move is that value less what the account already holds.
     Approved years are never re-posted; a replaced valuation's reversal
     takes its move back. LV27, tenant migration 0161, not yet reviewed.
567. **The herd scheme revaluation follows the reporting basis** (19 October
     2026). #310 item 3; Jess: "Tie it to reporting basis". A livestock
     setting says whether the farm's statements are special purpose (tax
     basis, the default) or general purpose (NZ IFRS or PBE Standards).
     Special purpose keeps LV12's choice, stated as the farm's policy in
     the draft livestock note. General purpose allows only profit and
     loss (NZ IAS 41 para 26; enforced in the database too), and the
     valuation notes that its tax values aren't fair value less costs to
     sell. Tohyee doesn't measure fair value; the accountant adjusts. It's
     a livestock setting rather than the performance report's format
     (decision 532), which covers special purpose and Tier 3 and 4 only.
     LV28, not yet reviewed.
568. **Reads don't make things when another site started them** (19 October
     2026). From a review Jess passed on (Gemini's); Jess said do it.
     Printing, the PDF and the email dialog make an invoice's payment link
     first (PN2, PPN2). Those are reads (GET), which the cross-site write
     check (assertSameOrigin) doesn't cover, so now they only make one when
     the browser says the request came from Tohyee itself or was typed
     ("same-origin" or "none" in Sec-Fetch-Site, or no header); otherwise
     they show what already exists. Pages also only submit forms to Tohyee
     and only load images from Tohyee, data: and blob: addresses and LINZ's
     aerial tiles. The PDF responses' policy isn't tightened: whether
     `object-src` or `default-src` limits break the browsers' built-in PDF
     viewers (and the bills inbox's PDF frame) couldn't be checked here.
569. **IR10 drawings and dividends leave out year-end clearing journals**
     (19 October 2026). From the same review (Gemini's); Jess said do it.
     Boxes 56 and 57 were the net movement on the accounts, so a 31 March
     journal closing drawings into equity made box 57 blank. A journal
     that credits a drawings or dividends paid account and debits only
     equity or current accounts is now treated as clearing, and it and its
     reversal are left out; anything else counts (ITX69). How Xero's IR10
     treats this wasn't checked; not yet reviewed. Also noted
     (no change): depreciation recovered on an asset brought in with an
     opening ATV assumes the same business-use percentage in earlier years
     (ITX17).
570. **A farm calendar from email** (19 October 2026). Issue #319 (written
     by ChatGPT, whose code couldn't be published); Jess: "just look at the
     issue and make it from that". Farm › Farm calendar: Today, Week,
     Month and Needs checking, filtered by farm and sender, from emails in
     a member's own Gmail or Microsoft mailbox. Fixed text rules, not AI
     (FC2-FC12): New Zealand day-month dates worked out from the email's
     day, times, tentative wording, moved and cancelled bookings (the
     earlier item in the conversation or from the sender), quoted replies
     skipped, each email read once, one item per kind and date. The
     history (30-365 days, 90 by default) is read in steps, newest first,
     150 emails a check, every 15 minutes (TOHYEE_FARM_MAIL_SCHEDULER=off
     stops it). Neither Xero nor NetSuite has this, so the rules are
     Claude's. Not included, as #319 said: attachments, team sharing,
     repeating arrangements, writing to other calendars. FC1-FC16, tenant
     migration 0162, not yet reviewed; not tried with a real mailbox.
571. **Farm mail is private to the member who connects it** (19 October
     2026), as Jess asked for email import ("mail must stay private to the
     person who connects it"). Mailboxes and their items are only ever
     read or changed by their own member: admins and owners don't see
     them, and someone else's is "not found". Read-only scopes
     (gmail.readonly, Mail.Read); the email's text is read and thrown
     away, keeping only each arrangement's sentence, the subject, the
     sender and a link, and only the id and date of emails with nothing in
     them. Audit events don't name the mailbox. Disconnecting, or the
     member leaving the organisation, deletes the tokens and everything
     read. It uses the organisation's Google or Microsoft app (Settings ›
     Email) with its own sign-in address, /api/farming/mail/callback, so a
     farm mailbox token can't read calendars or send.
572. **What a person checked stays as they left it** (19 October 2026).
     Correcting or confirming an item marks it checked: it leaves Needs
     checking, and a later email that would move or cancel it makes a new
     item in Needs checking instead (FC14). People can hide an item ("Not
     a farm arrangement") or say one replaces another. Moved and cancelled
     items are kept, faded, so it's clear what happened.
573. **Your own farm calendar items, and repeats** (19 October 2026). Jess
     chose own items, repeats, sharing and a calendar link from what the
     farm calendar didn't do. Members can add items by hand (any of the
     six kinds or Other, with private notes); they're checked from the
     start. Any dated item can repeat every 1, 2 or 4 weeks or every month
     until an optional end date; a monthly repeat falls on the last day of
     shorter months, as Outlook does. A date can be skipped, but one date
     of a series can't be changed on its own. Repeats aren't read from
     email wording. FC17-FC19, tenant migration 0163, not yet reviewed.
574. **Sharing farm calendar items is a choice per item, after a preview**
     (19 October 2026). Decision 571 keeps mail private, so nothing is
     shared unless its member shares that item, after seeing exactly what
     the team will see: what, kind, date, times, tentative, farm, repeat
     and who shared it, never the sender, subject, email sentence, link,
     notes or mailbox. Every member of the organisation sees shared items,
     read-only; sharing checks the item so a later email doesn't change it.
     FC20, FC21.
575. **A private calendar link** (19 October 2026). Each member can have
     one iCalendar (.ics) link for Google, Apple or Outlook to subscribe
     to, carrying what their farm calendar shows from 60 days back, with no
     email content or notes. Only a hash of it is stored, so it's shown
     once; making a new one stops the old. It answers "not found" alike
     for a wrong, replaced or turned-off link, a member who has left, or
     Farming turned off, and is limited to 60 requests an hour. FC22, FC23.
584. **A farm mailbox reads only the folders its member ticks** (20 October
     2026). Issue #340: Jess's farm mail shares a mailbox with mail for her
     mum's company directorships, which must not come into Tohyee at all.
     Each farm mailbox reads only the Outlook folders or Gmail labels its
     member ticks (Gmail's Inbox and their own labels are offered; Sent,
     Spam, Trash, Drafts and categories aren't), each with its subfolders
     if asked, and nothing until at least one is ticked: there's no "whole
     mailbox" choice. The same read-only scopes list them (gmail.readonly,
     Mail.Read). Folder names are private like the rest (decision 571):
     only the member sees them, and audit events give counts only. Tohyee
     keeps, for each email read, only the ids of the chosen folders it was
     in. Outlook nests folders; Gmail nests labels by name ("Farm/LIC"), so
     a label's subfolders are the labels named under it. Neither Xero nor
     NetSuite reads farm mail, so the rules are Claude's, following #340.
     FC25, FC26, FC29, tenant migration 0164, not yet reviewed; not tried
     with a real mailbox.
585. **What leaves the chosen folders leaves Tohyee** (20 October 2026).
     Taking a folder off deletes, straight away, every item taken from
     emails that were only in that folder, shared ones included. An email
     moved out of the chosen folders (or in a folder deleted in Outlook or
     Gmail) is dropped at the next check the same way; one moved in is read
     at the next check if it's no older than the read-back date. A dropped
     email's effects on other items are undone: a booking it moved or
     cancelled is back as it was, and an email that only added to an item
     it made is read again. Privacy comes first here, so an item the member
     checked or shared goes too when its email leaves. Each check lists the
     chosen folders' emails back to the read-back date (at most 2,000 per
     folder, newest first); in a folder with more, only the newest 2,000
     are read and only emails newer than those can be known to have left.
     FC27, FC28, FC29.
586. **Mailboxes connected before folders stop until folders are chosen**
     (20 October 2026). Migration 0164 can't know which folder each earlier
     email came from without asking the mailbox, and deleting a member's
     items in a migration can't be undone, so it deletes nothing: those
     mailboxes stop being read, the farm calendar says so with Choose
     folders, and at the first check after folders are chosen anything not
     in them is removed (FC28). Disconnecting still deletes it all at once.
     FC30.
587. **Farm organisations get a farm Home** (20 October 2026). Issue #341,
     from Jess. With Farming on, Home is a farm dashboard built from records
     Tohyee already keeps: the farm calendar (only as the person looking
     sees it, decision 571), stock, pasture and feed, fertiliser, farm
     working expenses per unit, a small Money card and the farm notebook.
     Cards with nothing to show are hidden rather than showing zeros. The
     business Home is a link away (Business overview). Xero has no farm
     Home, so it follows Xero's Home for look and the issue for content.
     FH1-FH6, FH8, not yet reviewed.
588. **The farm Home is customised like Home** (20 October 2026). It's a
     second page in the dashboard frame (decision 372): per-person cards,
     order and Hide, saved in the same preferences, with Analytics tiles
     pinned alongside (decision 374). It shows up to 10 cards, not Home's
     4, so each page now has its own limit. Pin to page offers it only when
     Farming is on. FH7.
589. **What the farm Home leaves out** (20 October 2026). No card is made
     up where Tohyee has no records: production and income (milk solids are
     entered only yearly), FWE against budget, soil tests due (soil tests
     have no "due" rule on purpose) and income tax due. There are no
     different default cards per role: Tohyee's roles don't say who is farm
     staff or the accountant, and guessing from bookkeeper or viewer would
     be wrong as often as right. Everyone starts with the same cards and
     uses Customise. No card shows payroll figures. (Starting cards by kind
     of person are now decision 660; on the farm Home everyone still starts
     the same.)
576. **Analytics shows money and value names the way people read them**
     (20 October 2026). Issues #328-#330, found building a dashboard.
     Negative money in Analytics tables, key figures and pivot tables shows
     its minus first, -$27.00, as Tohyee shows negatives everywhere else
     (the minus before the figure; no brackets). Charts' tooltips and axes
     already did. A value's label follows its column and calculation
     ("Amount", "Average net", "Count of invoices") until someone types
     their own, which then stays; a label still matching what Tohyee
     filled in (including the column name and "Rows" that earlier versions
     used) counts as not typed. "+ Create report" needing two clicks
     couldn't be made to happen here (tried after leaving a dashboard by
     the top bar, the logo, Back and a fresh load, with charts, open
     slicers and a slowed-down browser); two things that could cause it
     are fixed: Analytics pages no longer swap themselves for "Loading…"
     while they check Analytics is still on each time they open, and a
     slicer's list no longer leaves a click listener on the page each time
     it's opened and closed with its own button. Not yet reviewed.
577. **Analytics in plain words, with date presets** (20 October 2026).
     Issue #336. Pickers show sources and columns by plain names, grouped by
     where they come from ("Invoices › Net", "Ledger › Account class"),
     with the real name in a tooltip and beside each field in the field
     list; the data source picker says in a sentence what each Tohyee table
     holds. Saved dashboards keep the real names. Beside From and To,
     Dates offers This month, Last month, This quarter, This financial
     year, Last financial year, Last 12 months and All time. Financial
     years follow the organisation's balance date (31 March unless
     changed), and quarters are quarters of that year, so with 31 March
     they're the calendar quarters (whether Xero's "This quarter" does the
     same wasn't checked). Last 12 months is this month so far and the 11
     whole months before it, so a chart by month doesn't start with part
     of a month. "Keep these dates" with a preset chosen keeps the preset,
     so the dashboard (and its tiles pinned to Home) moves on with the
     calendar; today is the server's (New Zealand) date. Yes/No columns
     show Yes and No in tables, charts, slicers and filters and are still
     sent as true and false. "Date range applies to" keeps starting on the
     source's first date (invoice date, bill date, posting date). Not yet
     reviewed.
578. **More tests for tile filters, and "or"** (20 October 2026). Issue
     #332. A tile's filters offer the tests that fit the column: is one of
     and is not one of (ticked from the column's own values, up to 500),
     is blank and is not blank (empty or spaces-only text counts as
     blank), between (both ends included) for numbers and dates, and for
     dates: in the last N days (today and the N-1 days before), in the
     last N months (this month so far and the N-1 whole months before, as
     Last 12 months in decision 577), in this financial year and in last
     financial year (from the balance date). Relative dates are worked out
     each time the tile runs, from the server's today. Each filter after
     the first can join the one before with "or": filters joined that way
     are a group where one passing is enough, and groups are joined with
     "and" (as Looker Studio's filter clauses work). Like "is not", "is not
     one of" leaves out blank rows; add "or is blank" to keep them. Filters
     saved with the earlier tests keep working on any column; the new
     tests are checked against the column's type. A tile's filters don't
     move with "and last year" (as before). Not yet reviewed.
598. **The Home header uses Jess's own Aoraki photo** (20 October 2026).
     Jess supplied a better photo in #339. Only the mountains, sky and lake
     are used (a plain crop, not AI-restored): the car, shelter, sign and
     fence are left out of the app. Everything else about the watermark
     stays as before. See docs/AORAKI-RESTORATION.md.
580. **Sub-headings in long menu columns, and an All settings page**
     (20 October 2026). Issue #338 (Jess, 19 Oct 2026: the Accountant menu
     was hard to scan). Any top-bar menu column of more than seven links
     now has small grey sub-headings, one level below the column heading,
     so each run is two to six links; each sub-heading is a labelled group
     for screen readers. The Accountant menu follows the issue's grouping,
     except Account sales, which sits under Livestock rather than Fixed
     assets because it's the stock agent's livestock sale statement. Sales,
     Purchases, Payroll, Farm and Reports got the same treatment where a
     column was long. Settings moved to an **All settings** page of cards,
     like Xero's Settings page, keeping the same role and module rules;
     the menu keeps the five most used (Organisation settings, People and
     roles, Email, Sales platforms, Import and export) and All settings,
     and the search (Ctrl K) still finds every setting. Links for modules
     that are off were already hidden (MOD1); a sub-heading left empty
     disappears with them. R&D has no on/off switch yet, so it still
     always shows; adding one is a separate change.
581. **The CRM's top bar, grouped** (20 October 2026). Issue #342 (Jess:
     "There is too much up the top in the CRM"). The 17 tabs become seven,
     using the same dropdown menus as Accounting's top bar: Home, Contacts
     (Companies, People), Sales (Leads, Pipeline, Forecasts), Tasks,
     Dashboard, More (Marketing: Campaigns, Sequences, Follow-ups; Email:
     Email and calendar, Email templates) and Settings (Team and data:
     Teams, Duplicates; Customise: Record types, Stages; Integrations).
     Every page keeps its address and the role it needed; a dropdown with
     nothing left for someone's role isn't shown. The issue suggested
     calling the Dashboard tab "Reports"; it stays "Dashboard" because
     that's the page's title and its only report.
582. **Shopify from the CRM** (20 October 2026), also #342. CRM › Settings ›
     Integrations › "Sales platforms (Shopify)" opens the existing Settings
     › Sales platforms page, which is not copied. It shows while Accounting
     is on, because Shopify's orders post there and that page is an
     Accounting page, and never to sales reps and managers (decision 491).
     CRM Home ends with a short card from the same connections: each
     connected or paused store with its last sync and last error, or, for
     an admin with no store connected, "Connect Shopify". Non-admins with
     no store see nothing, because only admins can connect. The card says
     the connection hasn't been tried with a real Shopify store yet.
590. **How a chart looks is saved on its tile** (20 October 2026, issues
     #331 and #333 from Jess's BigDog dashboard; Power BI and Looker Studio
     as the reference, as the issue says). A Format section in the chart
     panel: colours, data labels, legend, axes (titles, gridlines, lowest
     and highest, start at zero, log scale), a number format per value,
     stacking (side by side, stacked, 100% stacked), smooth lines, dots on
     lines, a donut's total in the middle, and the card (title shown or
     not, a subtitle or note, plain, shaded or no background, border).
     It's kept in the dashboard's `tiles` (no migration) and checked when
     saved: unknown settings are dropped and wrong values refused. Every
     setting is optional and left out means the chart looks as before, so
     Reset to default removes them. The preview changes as settings
     change. "Horizontal vs vertical" is the existing Columns and Bars;
     bars now read top to bottom in the tile's order (they were drawn
     bottom up). Pinned tiles use the same format.
591. **Chart colours come only from the checked set** (20 October 2026).
     A value's colour is picked by name from the eight series colours
     (`--chart-1` to `--chart-8`), not as any colour, so it changes with
     the light and dark themes and stays apart for colour-blind readers.
     Colour sets: Tohyee (blue first, the default), Tohyee blues (four
     steps of one blue, `--chart-blues-1` to `4`; a chart with more values
     uses the full set), Orange first and Green first. Each order was run
     through the data-visualisation colour validator in both themes (light
     on #ffffff, dark on #121925): the re-orderings pass every adjacent
     colour-vision and normal-vision check, and the blues pass as an
     ordered ramp. "A colour for each group" (columns and bars with one
     value) uses up to eight groups and otherwise one colour. "Red when
     below zero" uses `--chart-negative` (#d03b3b light, #e66767 dark,
     both over 4.5:1). A greys-with-one-highlight set was tried and left
     out: its grey failed the checks.
592. **A second axis, because Jess asked for it** (20 October 2026, #331).
     Chart guidance (and the earlier "one axis only" comment in the code)
     says two scales mislead, but a count beside dollars is unreadable on
     one, which is the issue. Each value of Columns and line, Line and Area
     can go on the left or right axis, and Columns and line can show each
     value as columns or a line. The right axis has its own scale (title,
     bounds, start at zero, log) and takes the number format of its first
     value. To keep it honest, the right axis draws no gridlines of its
     own, and the legend names its values "(right axis)".
593. **Number formats are for showing only** (20 October 2026, #333).
     Each value has its own format: automatic (dollars for money columns,
     otherwise a plain number), dollars, a percentage (0.25 shows as 25%)
     or plain; 0-4 decimal places or automatic; short ($1.5K) or full;
     thousands separator; and, for key figures, words before or after.
     Values arrive as exact decimal strings and are only turned into
     numbers to be drawn or shown; nothing is added up from them (a
     donut's total is added exactly). Axes stay short unless turned off;
     tooltips are full. A 100% stacked chart draws each value's share of
     the group, with the amount and share in the tooltip.
594. **Key figures compare with the previous period, last year or a
     target** (20 October 2026, #334; Power BI's card and Looker Studio's
     scorecard as the reference). A key figure is one total, so "and last
     year" now works without a grouping, and so does "previous period":
     the same question asked of other dates. The previous period is the
     same length just before the dashboard's dates; a range of whole
     months moves back by that many months (October against September,
     the year to 31 March against the year before), any other range by
     its number of days. Last year is the same dates a year before, month
     ends kept. Without both dashboard dates there's nothing to compare
     with, and the tile says so. A target is a number typed on the tile.
595. **How a key figure's change is shown** (20 October 2026, #334). The
     change is the figure less the comparison, and the percentage is the
     change over the comparison's size (rounded half up to 1 place; none
     when the comparison is zero), both worked out exactly. An arrow and
     the word Up or Down show the direction, green when it's good news and
     red when not; "Down is good" (e.g. expenses) swaps them, so colour is
     never the only sign. The amount, the percentage or both can be shown.
     The optional trend underneath is the first value by month for the
     latest 24 months in the dashboard's dates, also read out as text for
     screen readers. The number uses the value's format (#333), including
     words before or after it (e.g. "customers").
596. **Dashboard layout: widths, heights, copies, text cards, drag**
     (20 October 2026, #335; Power BI and Looker Studio as the reference).
     A dashboard is a twelve-column grid: a tile is a quarter, a third, a
     half, two-thirds or the full width, so four key figures fit a row.
     On narrower screens quarters and thirds become halves, and on phones
     everything is full width. Charts are Small, Medium or Large (220, 340
     or 480 pixels high). Duplicate puts a copy (a new id, "(copy)" on the
     title) straight after the tile; a saved list where two tiles share an
     id gives the second a new one, so pins still find the right tile. Text
     cards are a heading and plain-text notes (up to 2,000 characters,
     blank lines between paragraphs; no formatting or links, so nothing in
     them can run); they have no question, so they can't be pinned. In
     edit mode a tile can be dragged onto another's place, or clicked to
     open it; the up and down arrows and the Edit button stay as the
     keyboard and touch way to do the same. A dashboard holds up to 40
     tiles (was 24), counting text cards.
597. **Calculated values, saved values and report templates** (20 October
     2026, #337; Power BI's measures as the reference, as the issue says).
     A calculated value is a formula over the chart's other values by name,
     e.g. `[Sales] - [Costs]` or `[Gross profit] / [Sales]`, with numbers,
     + - * /, brackets and `days` (the days in the dashboard's dates). It's
     parsed by Tohyee's own small parser (never run as code) and worked out
     by DuckDB in exact decimals: dividing goes through whole millionths
     like averages do (6 places, rounded half up), dividing by zero gives no
     value, and a value with no rows counts as zero. It's money when it only
     adds and takes away money. A value can also have its own conditions
     (only rows where...) and be a balance (everything to the To date,
     whatever the From date; not with a date grouping). Any value can be
     saved on its data source under a name (tenant migration 0165,
     `analytics_measures`) for other charts to add; a chart keeps its own
     copy, so removing or renaming a saved value doesn't break charts. The
     books copy has eleven built-in values (BM1-BM4, as Xero does, not yet
     reviewed), which needed the ledger copy to say which accounts are the
     receivable and payable control accounts (`system_account`). Creating
     a report can start from a template (Business overview, Sales &
     customers, Profit & loss, CRM pipeline, Farm): ordinary tiles over the
     books copy dated over the last twelve months, offered when the tables
     they need are copied. Not built: asking the AI to build a dashboard
     (optional in the issue).
599. **One chart look for the whole of Tohyee** (20 October 2026). Jess
     asked to change "the colours and look of the graphs", all of them.
     Xero is the reference for the look: calm, plenty of white space, one
     blue doing most of the work. Every chart now takes its colours from
     one shared theme, `src/lib/charts/theme.ts`, which matches the
     `--chart-*` variables in `globals.css` (a test checks they agree).
     It has eight series colours in a fixed order, four Tohyee blues, a
     one-blue scale light to dark, a below/above pair (orange and blue with
     a grey middle) and status colours (good, warning, and the red used
     for "red when below zero") that are never used as a series colour.
     The series colours are the same eight names as before (blue, orange,
     aqua, yellow, pink, green, purple, red), so saved per-chart choices
     (#333) still work and just pick up the new shade; the first is
     Tohyee's own accent blue. Light: #1f5fae, #d66919, #009e98, #e2a520,
     #d4679f, #057836, #694daf, #ba3e3c. Dark: #518fe9, #cf630d, #05908a,
     #bd8703, #cd6199, #17843f, #7f65ca, #c04442. Tohyee blues: light
     #004085, #1f5fae, #5388cd, #7ab0f9; dark #b4d4fe, #70adfe, #4c87d5,
     #215da7. Each colour set (Tohyee, Orange first, Green first) was run
     through the data-visualisation colour validator in both themes, on
     the plain card (#ffffff / #121925) and the shaded card (#eef1f5 /
     #0f1520): every set passes the lightness, strength, colour-blind
     (worst neighbouring pair 15.1 light, 12.9 dark for the default set;
     the target is 8) and normal-vision checks (worst 22.7 light, 20.4
     dark; the floor is 15). The first three colours also pass when every
     pair is compared (for charts where any two can sit side by side). In
     light mode the yellow is under 3:1 against white (2.18), as yellows
     are; every chart has its table for screen readers and the tooltip, so
     values never depend on telling that colour apart. The blues pass as an
     ordered scale in both themes. The first try at the dark aqua sat just
     under the normal-vision floor beside the blue (15.0) and was darkened.
600. **How chart marks are drawn** (20 October 2026). Columns and bars are
     at most 24px thick (16px on a pinned tile) with a 4px rounded end at
     the value's end (the bottom for a negative column), square on the
     baseline; stacked segments have a 2px gap in the card's colour and
     only the outer segment is rounded. Lines are 2px with round ends;
     dots are 8px with a 2px ring in the card's colour, shown when there
     are 12 points or fewer (3 on a pinned tile), and always on hover;
     a saved "dots on lines" choice still wins. Areas are a light wash of
     the line's colour (12%, 22% stacked) instead of the old solid fill,
     which hid the values behind it. Gridlines are solid hairlines one step
     off the card; the value axis has no line; the zero line is a little
     darker. Text uses text colours, never a series colour; labels inside
     a coloured column are white or dark, whichever reads. A legend shows
     only for two or more values (unchanged). Pie and donut labels sit at
     the card's edges and wrap, so long names aren't cut off. Axis labels
     are kept inside the card by the chart itself rather than by guessed
     margins, and short axis numbers keep one decimal so steps like 3.5K
     and 4K don't both read "4K". Big single numbers (key figures) use
     ordinary, not fixed-width, digits.
601. **The same look outside Analytics** (20 October 2026). Every
     tooltip has the same layout: the month or group in muted text, then
     each value with a short key in its colour (a line for lines, a square
     for columns), the name, and the amount in bold; columns get a faint
     band behind the hovered group, lines a thin crosshair. The cash flow
     forecast uses the chart blue, gridlines and tooltip, a light wash
     under the line, the shared red for below zero, and a solid crosshair
     (it was dashed). Key figure trend lines are in a quiet grey with the
     latest month as a blue dot. The pasture feed wedge's bars now start
     from one baseline in the chart blue (they were grey and lined up on
     their right ends). Home's net profit chart uses the shared colours
     (it had its own). Paddock maps and icons aren't charts and are
     unchanged.
602. **External databases as Analytics sources** (20 October 2026; Jess
     asked "Can you connect an sql server to analytics?" and chose all of
     Microsoft SQL Server, PostgreSQL and MySQL; Power BI and Looker Studio
     as the reference for the flow). In Analytics › Data sources an admin
     or owner adds a connection (server, port or SQL Server instance,
     database, user, password, encryption), which is tested before it's
     saved (tenant migration 0166, `analytics_db_connections`). A source then
     reads one table or view, or one typed SELECT, through that connection:
     its columns are previewed with their types and first 20 rows, confirmed
     like a file's, and loaded into the organisation's own DuckDB copy. A
     source's database, connection and table name can't change afterwards
     (set up a new source instead); what it reads, its columns, row limit
     and nightly reload can. Database sources reload nightly after 04:00 and
     on demand, recorded in the same load history as files (`file_name`
     holds "Connection › schema.table" or "Connection › query"), and need no
     analytics folder. A connection used by a source can't be removed.
     Viewers see database sources like file sources, but not their typed
     queries or the connections. Connections are made from the Tohyee
     server, so a database on the office network is the normal case. Not
     built: Looker Studio or Power BI connectors (Jess: Tohyee will have
     better reporting), other databases, Windows (integrated) sign-in for
     SQL Server, and incremental loads (each load reads everything again).
603. **Database sources only ever read** (20 October 2026). Three layers.
     (1) A typed query must be one SELECT or WITH ... SELECT, checked by
     Tohyee's own scanner: comments are removed before checking and the
     cleaned text is what's sent (so MySQL's `/*! */` can't hide anything),
     a semicolon may only end it, and words that change data or reach
     outside the database (INSERT, UPDATE, DELETE, MERGE, DROP, CREATE,
     ALTER, TRUNCATE, GRANT, EXEC, CALL, COPY, INTO, LOCK, SET, DECLARE,
     WAITFOR, OPENROWSET, OUTFILE ...) are refused outside quotes, as are
     calls to functions that write, lock or read the server's files
     (nextval, pg_read_file, pg_advisory_*, dblink, lo_*, load_file,
     get_lock ...) and FOR UPDATE/SHARE. (2) Tohyee wraps every query in its
     own SELECT of the chosen columns, which also makes most non-SELECT
     text invalid SQL. (3) PostgreSQL sessions start with
     `default_transaction_read_only` on and each read runs after `SET
     TRANSACTION READ ONLY`; MySQL sessions are `SET SESSION TRANSACTION
     READ ONLY` and each read is `START TRANSACTION READ ONLY`. SQL Server
     has no read-only session, so the screen says to use a login with only
     read rights (e.g. `db_datareader`) and every query is the checked
     single SELECT. All three screens recommend a read-only user. Limits:
     connecting stops after 15 seconds; previews, tests and table lists
     after 30 seconds; a load after 10 minutes in all
     (`TOHYEE_ANALYTICS_DATABASE_SECONDS`), with each database's own
     statement time limit set too (`statement_timeout`,
     `max_execution_time`, the SQL Server request timeout). A source has a
     row limit (1,000,000 unless changed, at most 5,000,000); a load that
     finds more rows fails and keeps the last copy, rather than loading
     part of the data and giving wrong totals. Rows are read 2,000 at a
     time (a PostgreSQL cursor, MySQL and SQL Server streams) so memory
     stays bounded.
604. **Database passwords and where they can go** (20 October 2026). The
     password is encrypted with the server's key (src/lib/secrets, as for
     IMAP and bank feeds), read only on the server to connect, and never
     sent to the browser, written to the audit trail (which records where
     a connection points and whether the password changed) or logged. Only
     admins and owners can add, change, test, list or remove connections
     and preview their tables, as with every other source setup. A saved
     password is reused only for the same server, port, instance, database
     and user: changing any of those needs it typed again, so a connection
     can't be repointed to send the saved password somewhere else. Tohyee
     doesn't follow redirects: a SQL Server that sends the client on to
     another server after login (Azure redirects, availability-group
     routing) is refused, through Tohyee's own TCP connector. MySQL
     connections turn off LOAD DATA LOCAL (so a server can't ask for files
     on the Tohyee server) and multiple statements. Tohyee's own PostgreSQL
     databases (the server's and every organisation's, by name) can't be
     connected to, so an admin of one organisation can't read another's
     even with a login for it. Errors while connecting are reported as plain
     kinds (server not found, nothing answering, wrong password, no such
     database, certificate couldn't be checked, no encryption, timed out)
     without the driver's text; once connected, a query's error shows the
     database's first line about it (up to 300 characters), which is about
     the admin's own query. Encryption choices: Don't encrypt; Encrypt
     without checking the certificate (default for PostgreSQL and MySQL;
     SQL Server's "trust server certificate"); Encrypt and check the
     certificate (default for SQL Server, as Power BI does). The drivers are
     `pg` (already used), `mysql2` (MIT) and `mssql` with `tedious` (MIT),
     all compatible with AGPLv3, loaded only on the server and only when a
     database source is used.
605. **Database column types in DuckDB** (20 October 2026). The database
     says what each column is, so nothing is guessed from values: whole
     numbers load as whole numbers; exact decimals as Money when they have
     up to two places, Quantity for three or four places on a quantity-like
     name, otherwise Number (whole when they have none); PostgreSQL
     `money` and SQL Server `money`/`smallmoney` as Money; floating-point
     columns as Number (they're approximate at the source); dates as
     dates; date-times (with or without a time zone) as Date and time in
     local time (PostgreSQL sessions use the business time zone, SQL
     Server's `datetimeoffset` keeps its own local time, and the offset is
     dropped); booleans, SQL Server `bit` and MySQL `TINYINT(1)`/`BIT(1)` as
     Yes / no; everything else as text. Binary data (bytea, BLOB,
     VARBINARY, images, map shapes) can't be loaded. People confirm or
     change each type, as for files. Values travel as text so decimals
     stay exact: PostgreSQL's raw text, MySQL with decimals, big numbers and
     dates as strings, and SQL Server decimals, money, floats and dates
     converted to text in Tohyee's outer SELECT (its driver would otherwise
     turn decimals into floating-point numbers). DuckDB then converts each
     column exactly as it does for a CSV (blank becomes empty, a value that
     isn't the type fails the load); MySQL's zero dates load as blank.
     Table and column names follow the friendly-name work (#336):
     `dbo.SalesOrders` suggests `sales_orders`, `CustomerName` becomes
     `customer_name`, shown as "Customer name".
606. **Google Analytics as a data source: signing in and who can**
     (20 October 2026; Jess asked for "Google analytics for websites to
     tohyee"; Looker Studio's Google Analytics connector as the reference).
     An admin or owner signs in with Google through the organisation's own
     Google app (Settings › Email), on its own return address
     (`/api/analytics/google/callback`, which the app must list). Tohyee asks
     only for `analytics.readonly`, plus `openid` and `userinfo.email` to show
     which Google account connected; a sign-in where the Analytics box was
     unticked is refused. The sign-in is the organisation's, not the admin's
     own (unlike farm mail, decision 571): one connection per organisation,
     its tokens encrypted with TOHYEE_SECRET_KEY, the Google address shown
     only to admins and owners. Everyone in the organisation sees that it's
     connected, which property and the last load. After signing in, the admin
     picks one GA4 property from the Admin API's account summaries (every
     page); only a property Google lists for that account can be chosen. The
     help says plainly what an admin sets up in Google Cloud: the Analytics
     Data and Admin APIs enabled, the scope added to the consent screen, the
     return address, and that while the app's publishing status is Testing
     Google ends each sign-in after seven days (Google's "Using OAuth 2.0"
     page, refresh token expiration), so it has to be connected again until
     the app is published. Tested against canned Google responses only; it
     hasn't been tried against a real GA4 property.
607. **Which Google Analytics data is loaded, and how** (20 October 2026).
     Five daily reports from the Data API's `runReport`, each its own table
     with plain names: `google_analytics_daily` (active users, new users,
     sessions, engaged sessions, page views, engagement rate, key events,
     revenue), `_traffic` (session channel group, source and medium),
     `_pages` (page path and title), `_countries` and `_devices`. GA4's
     current names are used (`keyEvents`, which replaced `conversions` in
     May 2024; `screenPageViews`; `totalRevenue`). Google's numbers arrive as
     text and are turned into exact decimals without a binary number:
     counts as whole numbers, engagement rate to 6 places, key events and
     revenue to 2 (revenue is in the property's currency, which Google
     reports and Tohyee shows). Users are counted per day, as Google gives
     them, so adding days counts a returning visitor more than once; the
     tables' descriptions say so. Pages are asked for 50,000 rows at a time
     (offset and limit), each next page starting after the rows that came;
     a report over 500,000 rows isn't loaded ("load fewer months"). Every
     report is read before anything is written, then all five tables are
     swapped in together, so a failed load keeps the last copy. The
     `google_analytics_` prefix is kept for these tables: CSV sources and
     shaped tables can't use it.
608. **History, refreshing and Google's limits** (20 October 2026). 13
     months by default (this month and the same month last year, whole),
     1 to 60 adjustable. Loaded nightly after 4am with the other sources
     (switchable off) and by Refresh now, each load in the load history as
     "Google Analytics". Google's quota answers (429 / RESOURCE_EXHAUSTED)
     aren't retried, since its limits are per hour and per day (Google's
     Data API quotas page): the load fails with a plain message and the
     next nightly load tries again. 500 and 503 are retried twice after a
     short wait. A disabled API, an account without access to the property
     and a refused sign-in each have their own message. When Google refuses
     the stored sign-in (expired or withdrawn), the connection is marked to
     connect again and the nightly load leaves it alone until an admin does.
     Changing the property drops the old property's tables. Disconnecting
     deletes the tokens and the connection, asks Google to withdraw the
     sign-in, and drops every `google_analytics_*` table; the load history
     stays, as when a source is removed, and it's refused while a shaped
     table is built from the data.
609. **A Website report template** (20 October 2026). Visitors, sessions,
     page views and engagement rate (engaged sessions over sessions for the
     dates chosen, not an average of daily rates) as key figures against the
     previous period; visitors and sessions by month, beside invoiced sales
     by month when the books are copied (dashboards chart one table per
     tile, so they sit side by side rather than on one chart); sessions by
     channel; top pages; and sessions by device. Offered once Google
     Analytics has loaded.
610. **A private copy of an Owner's mail uses the farm calendar's
     connection** (20 October 2026). Issue #250, with #340 (Jess: her
     mailbox also holds her mum's company directorship mail, which "must
     not come into Tohyee at all — not even privately", and the folder
     choice should be "one place to set it"). So #250's "import all
     folders" is overridden: My mail (the user menu, Owners only) reads
     only the Outlook folders or Gmail labels ticked on the mailbox's one
     folder choice, and nothing until one is ticked. A mailbox is one
     connection whichever screen made it (one sign-in address,
     /api/farming/mail/callback, one set of tokens, one choice), with an
     Owner-only switch, "Keep a private copy of these emails for me and my
     AI". A second, separate connection was considered and turned down: it
     would mean a second folder choice to keep right, which is how
     directorship mail could get in. My mail works in every organisation,
     Farming on or not. A mailbox connected from My mail isn't read for
     the farm calendar unless it's connected there too; the farm calendar
     otherwise works exactly as before. Neither Xero nor NetSuite keeps
     people's mail, so the rules are Claude's. PM1, PM2, PM14, tenant
     migration 0168, not yet reviewed; not tried with a real mailbox.
611. **Only the Owner who turned it on can read their copy, through one
     door** (20 October 2026). Every listing, search, conversation,
     attachment, folder list, switch, sync and deletion goes through one
     access layer (src/lib/private-mail/access.ts) that reads the person's
     role from the server's own records at that moment and limits every
     query to rows with their owner_user_id. Everyone else gets "not
     found", the same as for nothing: admins, other Owners, accountants,
     report viewers, server admins (who see organisations only as
     members), farm app keys and AI keys (until #250 part 2's scope). The
     owner never changes: the database refuses it, and a role change,
     handover or restore gives nobody else access. An owner who stops being
     an Owner, leaves or has their login turned off can't read it, and it
     isn't synced, until they're an Owner again; leaving deletes the
     connection as it does for the farm calendar (FC15), and the copy stays
     unread until they delete it. PM7, PM8.
612. **The mail is encrypted with a key of its own** (20 October 2026).
     Each copy has a random 256-bit key, stored only encrypted with the
     server's TOHYEE_SECRET_KEY (src/lib/secrets.ts). Subjects, people,
     snippets, links, text, attachment names and files are encrypted with
     it (AES-256-GCM, each value tied to its copy, kind and email). Plain:
     the provider's ids, dates, sizes, attachment counts and folder ids,
     for duplicates, order and coverage. Emails are kept as text (HTML is
     turned into text, as the farm calendar does), so nothing from an
     email runs in Tohyee; attachments are only ever downloaded, never
     shown in Tohyee's pages. docs/PRIVATE-MAIL.md says plainly that
     whoever controls the server, its code and its key can read the mail:
     this protects from other Tohyee users and from a copy of the database
     alone, and isn't end-to-end.
613. **Search uses keyed word tokens** (20 October 2026). Each email's
     words (subject, people, text, attachment names; lower case, accents
     off, 2-40 letters or digits, at most 4,000) are stored as HMAC-SHA256
     digests with the copy's key, in an indexed array; a search finds
     emails with every word, plus from:address and to:address. Whole words
     only, no suggestions, and the words are sent in a POST so they're
     never in an address or a proxy's log. Someone with the database alone
     can see which emails share a word and how often a digest appears, not
     the words (docs/PRIVATE-MAIL.md). Chosen over full-text search in
     PostgreSQL, which would keep the words readable in the index.
614. **Copying: the read-back window, resumable, no duplicates, the farm
     calendar's move rules** (20 October 2026). The copy reads back to the
     mailbox's read-back date (30-365 days before it was connected). Each
     sync lists the ticked folders' emails back to then (newest first, at
     most 10,000 per folder, saying so when a folder has more), copies up
     to 300 emails and 200 MB of attachments not copied yet, each committed
     on its own (so an interrupted first copy carries on where it stopped,
     and an email is never copied twice), then drops emails that left the
     ticked folders to another folder and copies emails moved in, as
     decision 585 does for the farm calendar; an email deleted in the
     mailbox is kept (decision 616). Unticking a folder deletes at once
     what was copied only from it. Syncs run every 15 minutes after the farm
     calendar's checks (TOHYEE_FARM_MAIL_SCHEDULER=off stops both), and on
     Sync now. Three failed syncs in a row stop it until it's switched
     off and on or the mailbox is connected again. My mail shows progress ("1,234 of 5,000 emails
     copied"), the dates copied, the read-back date, the last sync and the
     last error. PM3, PM6.
615. **What isn't copied, shown on My mail** (20 October 2026; drafts,
     junk and trash by Codex, delegated by owner, 20 October 2026, #360
     item 8: "exclude drafts, junk/spam and trash by default, show
     exclusions clearly and allow explicit opt-in"; #360's "import sent and
     archived mail by default" gives way to Jess's own #340: only ticked
     folders are read). Folders not ticked; Gmail's Sent, Drafts, Spam and
     Trash unless ticked (a draft or binned email carrying a ticked label
     isn't copied either, unless Drafts or Trash is ticked) (they're
     offered on My mail only, marked "for your private copy only", and the
     farm calendar never reads them, even when ticked; Outlook's are
     ordinary folders, as they already were for the farm calendar); Gmail
     mail with no label (archived), which no label holds; email older than
     the read-back date; all but the newest 10,000 in a bigger folder;
     attachment files over 20 MB and linked Outlook items (their name and
     size are kept); pictures and formatting. Nothing is claimed beyond
     what was copied. PM2, PM4, PM5.
616. **Off, disconnect and delete are three things; the copy is an
     archive** (20 October 2026; Codex, delegated by owner, 20 October
     2026, #360 item 9). Switching the copy off stops copying and keeps
     it. Disconnecting stops syncing (it deletes the tokens and folder
     choice, and the farm calendar's items as FC15) and keeps the imported
     history, not copying; connecting the same mailbox again carries on the
     same history. **Delete imported history** is the separate, explicit
     step: every email, attachment and search token goes at once, leaving
     the connection. Backups made before keep it (encrypted) until they age
     out: the newest of each of 14 days and the first of each of 12 months,
     so about 12 months; My mail says so rather than promising it's gone
     from every backup. An email deleted in Gmail or Outlook (gone, or in
     Gmail's Trash or Outlook's Deleted Items) is kept and shown "deleted in
     the mailbox", as #360 asks, and explained on My mail beside Connect; one
     moved to a folder that isn't ticked is removed, and unticking a folder
     still deletes what came from it, as Jess's #340 says. Telling the two
     apart takes one read of the email's ids (at most 300 a sync). Nothing
     is ever changed in the mailbox. PM6, PM12, PM13.
617. **Nothing about the mail leaves the copy** (20 October 2026; the
     store choice matches Codex, delegated by owner, 20 October 2026, #360
     item 10: an owner-specific private store and index in the existing
     PostgreSQL, no bodies or summaries in shared analytics, no extra SQL
     server, no claim of protection from a hostile host operator). The audit
     trail records only that a copy was started, stopped or deleted, with
     no details; the farm calendar's events stay as they were (counts of
     folders, no names). A failed sync logs only the organisation. Nothing
     goes to notifications, Analytics or DuckDB, general search, reports or
     exports, and a test checks no other part of Tohyee names the private
     tables. Filing an attachment into shared data (the bills inbox, soil
     tests), with a preview of what becomes visible, is #250's next part
     and isn't built. PM7.
618. **The AI reads an Owner's mail only through their own Look only key**
     (20 October 2026). #250 part 2: "a private-mail scope that only the
     owner's own key can be given". On My mail (Your AI) the copy's Owner
     ticks which of their own working AI keys in this organisation may
     search and read it; nobody can tick anyone else's (another Owner's
     key is "not found"), and only Look only keys can have it, so an AI
     reading the mail can't write anything from it into Tohyee's shared
     records (its calls run read-only). The scope is kept in the
     organisation's database (tenant migration 0169, private_mail_ai_keys:
     the key's id and its Owner), not on the key, so no core migration was
     needed. The MCP server offers search_my_mail and read_my_mail only to
     such a key while its Owner is an Owner; other keys don't learn the
     tools exist ("Unknown tool"), and every call goes through the same
     access layer as My mail (decision 611), which checks the scope again.
     Revoking the key, taking the tick off or the Owner losing the role
     stops it at once. Answers cite each email (subject, sender, date, My
     mail message id) and the server tells the AI to say which it used and
     never pass it on. Tohyee has no shared AI conversations, so there's
     nowhere else for an answer to be kept. PM15-PM19, not yet reviewed.
619. **What the AI tools don't do** (20 October 2026). They give the text
     and attachment names, not attachment files; they don't file anything
     into shared data (that's #250's next part, with a preview); and they
     can't stop an AI service outside Tohyee from keeping what it was told:
     that's between the Owner and their AI provider, and My mail says the
     key is for the Owner's own AI only.
630. **A co-op share register for farms** (20 October 2026, #327).
     - **Who decided:** Codex, delegated by owner, 20 October 2026 (issue
       #360, item 15). Examples CSR1-CSR10 aren't reviewed yet.
     - **What it is:** Farm > Co-op shares. One holding per co-op and share
       class (case doesn't matter), each with its movements and its
       dividends, rebates and retentions as the co-op's statements show
       them. Tables `coop_shareholdings`, `coop_share_movements` and
       `coop_share_distributions` (tenant migration 0172). It's factual:
       Tohyee adds up what was entered; it doesn't value shares, post to
       the ledger or work out what a co-op requires. Farming must be on.
       Viewers read; bookkeepers and up change it.
     - **Mistakes:** entries are removed, never deleted or edited, and the
       history keeps them. A holding can be removed only once it has no
       entries.
631. **Share movements, opening and closing** (20 October 2026, #327).
     - **Who decided:** Codex, delegated by owner, 20 October 2026.
     - **Kinds:** brought forward, bought or issued for payment, issued
       without payment (bonus shares, shares for a rebate or retention),
       sold/surrendered/redeemed, and adjustment. Quantities and values are
       entered as positive numbers; a sale is stored negative. An
       adjustment takes signed numbers.
     - **Opening and closing:** opening is everything dated before the
       financial year; closing is opening plus the year's movements. Values
       are as entered (usually cost), to the cent; quantities to 4 places,
       summed only within a holding.
     - **Brought forward:** one per holding, dated on or before every other
       movement, so a register can start from last year's accounts.
     - **Never below nothing:** after every change the running quantity and
       value, in date order over all movements, must stay at or above zero,
       so a sale beyond the holding, or removing a purchase a later sale
       relies on, is refused.
632. **Dividends, rebates, retentions and source statements** (20 October
     2026, #327).
     - **Who decided:** Codex, delegated by owner, 20 October 2026.
     - **Apart:** dividends, rebates and retentions are separate kinds with
       separate totals, and none of them changes the shares' value. Only
       dividends carry imputation credits. A rebate paid in shares is a
       rebate plus a separate "issued without payment" movement; the two
       aren't linked, so Tohyee doesn't decide how a rebate splits between
       cash, shares and retention.
     - **Statements:** each movement and payment names its source: a
       reference, a file on the holding (the existing record files, record
       type `coop_shareholding`), or both. One of them is required. Only the
       holding's own current files can be chosen.
633. **The register in the year-end pack; what's left out** (20 October
     2026, #327).
     - **Who decided:** Codex, delegated by owner, 20 October 2026.
     - **In the pack:** when farming is on and there's a holding, the
       year-end pack has `Co-op shares.csv` (a shares table and a dividends,
       rebates and retentions table, with totals) and a `Co-op share
       statements` folder with the files the year's entries name, each
       name starting with its file number. Removed files aren't included.
     - **Not built:** ledger links and proposed postings (they need their
       own worked examples and tests first, as #360 item 15 says); a
       Fonterra share standard (minimum shares) calculator, deferred until
       its effective-dated rules are verified; share valuation; and the tax
       treatment of dividends, rebates and retentions.

### Owner-delegated answers (issue #360, 20 October 2026; decisions 634-639)

On 20 Oct 2026 Jess asked Codex to answer all the outstanding questions
using its judgement, and approved posting the answers for Claude (issue
#360). These are recorded with the attribution "Codex, delegated by owner,
20 October 2026". They're product choices. They don't claim an accountant
signed anything off, a provider was tested, access was bought or the law was
verified. Jess's own explicit decisions win where they differ. Items
recorded elsewhere or being built at the same time:
- Item 7 (ITX6 and RAT1, from the 20 Oct comment on #292): being built.
- Items 8-10 (private farm mail, #250): being built.
- Items 11-13 (groups, #200): being built.
- Item 15 (co-op shares, #327): decisions 630-633, in that PR.
- Item 17 (CRM next, #216): being built.

634. **Tax: what comes first** (20 October 2026, #292, #201; #360 items
     1-6).
     - **Who decided:** Codex, delegated by owner, 20 October 2026.
     - **Order:** the organisation's own tax workspace first, then a
       permission-aware overview across clients. A full practice manager
       isn't a prerequisite (see 638). Finish and check IR4, IR3 and IR10
       first, then trusts, then partnerships and LTCs, each sourced and
       tested on its own. Company calculations are never run silently for
       an entity they don't fit.
     - **Inputs:** imports and reviewable forecasts first: CSV or Excel
       through mapping and preview; PDFs kept as sources, with any figures
       read from them needing review. A live IRD connection is a parallel
       workstream needing IRD's approval, not a blocker.
     - **Filing and payments:** prepare and export only. No automatic
       filing, elections, payments or tax-pooling purchases.
     - **Privacy:** a taxpayer's inputs are private by default and shared
       with an accountant only by choice. Turning on Tax or group reporting
       doesn't expose their mailbox or unrelated personal income.
     - **Tax pooling:** comparisons stay provider-neutral, with dated quotes
       typed in. No paid partner is chosen and no API is promised.
     - **Already settled:** the extension-of-time choice (562). Rounding
       (565) and the narrow sole-trader homekill GST case stay technical
       checks.
635. **Farm data providers** (20 October 2026, #249; #360 item 14).
     - **Who decided:** Codex, delegated by owner, 20 October 2026.
     - File imports stay the reliable baseline. For private connectors,
       Pasture.io comes first, then LIC. No paid aggregator or new weather
       service without a concrete need, documented terms and actual access.
       Choosing a default can't stand in for a provider's access or a
       farmer's consent.
636. **Pigs and specialist livestock** (20 October 2026, #243; #360 item
     16).
     - **Who decided:** Codex, delegated by owner, 20 October 2026.
     - Pigs stay deferred (decision 508's list leaves them out). Finishing
       the cattle and sheep workflows and reconciling them with real data
       comes first. Unsupported transfers, bailments and valuation cases
       stay refused until their rules and examples are verified. There's no
       generic fallback valuation.
637. **Which sales platform next** (20 October 2026, #196; #360 item 18).
     - **Who decided:** Codex, delegated by owner, 20 October 2026.
     - Check and finish Shopify first, then WooCommerce's gaps. Square is
       the next new sales connector. Accounting stays per order, and CRM,
       order and invoice revenue is never counted twice. This is a
       priority, not a claim of provider access.
     - Later: Jess left Square out on 20 October 2026 (decision 667).
638. **Practice manager stays unbuilt** (20 October 2026; #360 item 19).
     - **Who decided:** Jess. Her own instruction, "Dont do practice
       manager" (parked since 3 Oct 2026, PR #91), stands over #360 item 19.
       Item 19 outlined a first slice (client directory linked to
       organisations, templated jobs, task owners and deadlines, document
       requests, then WIP and time billing). That outline is kept in the
       issue for the history only and isn't built.
     - Tax's multi-client overview (634) doesn't depend on it.
639. **Default dashboards** (20 October 2026; #360 item 20).
     - **Who decided:** Codex, delegated by owner, 20 October 2026.
     - **Owner:** cash, overdue receivables and payables, and work needing
       attention.
     - **Sales:** pipeline, conversion and next actions.
     - **Farming:** today's work, missing or stale records, and a seasonal
       cash view.
     - The practice dashboard (jobs and deadlines) isn't built, since
       practice manager isn't (638).
     - Existing dashboards are reused, and drilling through to the records
       comes before adding more tiles.
660. **Which dashboard and cards a person starts with** (20 October 2026;
     #360 item 20, Codex, delegated by owner, 20 October 2026). Tohyee's
     roles don't say who is "sales" or "farm staff", so the default goes by
     what Tohyee does know: the person's role and the organisation's modules
     and records (`homeKindFor` and `defaultTilesFor` in
     `src/lib/dashboard/defaults.ts`). A **sales rep or manager** (decision
     491) gets the sales dashboard, the CRM's Home, as they only have the
     CRM. Otherwise **Farming on** gives the farm Home (FH1), for every role,
     since the roles still can't tell farm staff from the accountant
     (decision 589). Everyone else gets the **owner's** Home. Within a page:
     Home starts with Cash in bank, Owed to you and Bills to pay, then Next
     GST return when registered for GST; when not, Jobs if any project is a
     job, else Sales pipeline if the CRM is on. The farm Home starts with
     today's work, records to catch up on and the season's cash, then the
     farm's records. The CRM Home starts a sales rep on their next actions
     and own opportunities, and a manager (and anyone else) on the pipeline
     and conversion. **A person's own choice always wins**: the starting
     cards are used only until they save their own in Customise, which says
     where the starting cards came from and offers **Go back to the starting
     cards** (removing their saved choice). Practice manager dashboards
     aren't built (Jess: "Dont do practice manager"). Xero's Home is one
     layout for everyone and Power BI and Looker Studio have no per-role
     starting dashboards, so this is our own rule. HD1-HD5, not yet reviewed.
661. **The owner's Home shows overdue both ways** (20 October 2026; #360
     item 20, Codex, delegated by owner, 20 October 2026). Bills to pay shows
     the overdue amount in red beside the bills due this week, as Owed to you
     already shows overdue invoices, and Needs attention lists overdue bills
     (to Aged payables) as it lists overdue invoices (to Aged receivables).
     Each opens the report with the documents behind it; no new tiles. HD2.
662. **The CRM Home is a sales dashboard; Home can show jobs and sales**
     (20 October 2026; #360 item 20, Codex, delegated by owner, 20 October
     2026). The CRM Home gets the dashboard frame (decision 372): six cards,
     per person, up to 8 with Customise and Hide. **Pipeline**: open
     opportunities by stage, with count, amount per currency and longest in
     stage, linking to the pipeline and the sales dashboard's drill-through.
     **Conversion**: last and this quarter of the financial year, leads
     converted of those added, won of those closed and the amount won
     (definitions as decision 500). **Next actions**: the person's own tasks
     due today or before, their open opportunities past the expected close
     date, and their open ones with no task still to do, five of each with
     the count, each linking to its record. Then the CRM's own three
     (CRM10). A rep or manager sees only their own (or their teams')
     pipeline and conversion (decision 491); next actions are always the
     person's own. Opportunity names on My open opportunities now link to
     the opportunity. Home offers two more tiles: **Jobs** (open jobs, those
     with a visit in the next seven days, those with none booked, and
     services due; offered once there's a job) and **Sales pipeline** (the
     open amount and this quarter's win rate; offered with the CRM on).
     SD1-SD6, not yet reviewed.
663. **The farm Home's today's work, records to catch up on and the
     season's cash** (20 October 2026; #360 item 20, Codex, delegated by
     owner, 20 October 2026). This week on the farm says "Nothing on today"
     when today is empty, so today's work comes first. **Records to catch up
     on** lists what's missing or out of date, each with the page that fixes
     it: a farm walk more than 14 days old (only for a farm that has
     readings, so farms that don't do farm walks aren't nagged; DairyNZ
     suggests weekly walks in spring, so two weeks is generous); paddocks
     with no cover reading on such a farm; a finished season with farm
     working expenses but none of kg MS, hectares, cows or stock units;
     bank lines to reconcile and feeds to reconnect (out-of-date books make
     the cash view wrong); AI-suggested stock movements waiting; and the
     person's own calendar items needing checking (decision 571: never
     anyone else's). **Cash this season** is the financial year month by
     month: money in and out of the active bank accounts (credit cards left
     out, as Cash in bank does) from the ledger up to today, each journal
     netted first so a transfer between two bank accounts is neither; the
     balance at each month's end; then the cash flow forecast's (CF1-CF9)
     month ends to the season's end, with the lowest expected balance and
     the first month expected below zero. It links to the cash flow
     forecast. The season is the financial year (dairy farms usually end
     theirs on 31 May, the season's end). FH9-FH11, not yet reviewed.
664. **The dashboard preferences API** (20 October 2026). GET and PUT also
     return the person's starting cards for the page (`defaultTiles`), their
     kind (`owner`, `sales` or `farming`) and whether the tiles are their
     own (`customised`); DELETE removes their saved choice. Every card a page
     offers can be saved, not only its starting ones. The CRM Home's
     preferences go through the CRM's access check, so sales reps and
     managers can keep their own; Home's and the farm Home's still refuse
     them. HD5.
620. **Provisional tax payments are allocated, not dated into instalments**
     (Codex, delegated by owner (via Will), 20 October 2026; the 20 Oct
     comment on #292, section 1). Confirmed excess towards instalment 1
     reduces what instalment 2 needs: the cap at instalment 1's calculated
     amount is gone (ITX6, ITX6A: 12,367.60 - 6,000.00 = 6,367.60). A
     payment counts against an instalment only through an allocation, and
     its date alone doesn't make it any instalment's (IRD applies payments as
     the taxpayer directs). Each allocation has a status: confirmed by IRD
     (it must name an IRD document, so it isn't a status someone just
     types), allocated by a person with the evidence typed beside it, or a
     forecast assumption. Payments with neither of the first two are
     awaiting reconciliation, and the page says how much. Existing payments
     start awaiting reconciliation: they were never allocated. The year's
     paid total (end-of-year tax, IR3/IR4) still counts every payment once,
     whether allocated or not. Examples ITX6A-ITX6H, as delegated, not yet
     reviewed by an accountant.
621. **Scheduled, paid, allocated and still needed are kept apart**
     (Codex, delegated by owner (via Will), 20 October 2026). Each
     instalment shows its worked-out amount, what's allocated to it (and
     how much of that was late, by IRD's effective date), and the cash
     still needed by its date: the cumulative target less what's allocated
     to it and earlier instalments, never below nil. More than the target is
     a credit carried forward, never a negative demand. A payment keeps its
     bank date and gets IRD's effective date once known; until then the
     bank date stands in and the page says so. Use-of-money interest counts
     only confirmed and evidenced allocations, from the effective date.
     Forecast assumptions (including "an earlier instalment not due yet is
     paid as worked out") are labelled on the instalment and never treated
     as paid.
622. **A payment counts once, and a reversed one not at all** (Codex,
     delegated by owner (via Will), 20 October 2026). Allocations can't add
     up to more than the payment (checked under a row lock, and again in
     the rules). A payment counted from the books whose journal is reversed
     later counts for nothing: not in instalments, the year's total or the
     imputation credit account, and it can't be allocated. The annual-total
     fix from 17 Oct 2026 (ITX6: the total is the last cumulative target,
     not the sum of what's due) stays, with its test.
623. **Reallocating keeps the history** (Codex, delegated by owner (via
     Will), 20 October 2026). Changing where a payment goes, or taking an
     allocation off, needs a reason; the old allocation is kept, marked
     replaced, with who and when, and the audit log has both. Removing a
     typed payment still removes its allocations with it (the audit log
     keeps them). Per #360, nothing is filed or paid to IRD: Tohyee only
     works out and shows. Credits IRD transfers in from other years or tax
     types aren't their own kind of payment yet.
665. **Shopify checked against Admin API 2026-10** (20 October 2026;
     Codex, delegated by owner, 20 October 2026: "validate and finish
     Shopify first", issue #360 item 18). Without a real store, the
     connector was read against Shopify's current pages and three things
     changed: the API version is 2026-10, the latest stable version
     (shopify.dev/docs/api/usage/versioning; its release notes list no
     change to anything Tohyee reads except a new `CURRENCY_CONVERSION`
     balance transaction type, which payouts refuse like any type they
     don't know); webhooks are subscribed with `uri`, since `callbackUrl`
     is deprecated (shopify.dev/changelog/consolidate-webhook-graphql-surfaces);
     and a payout's balance transactions are also checked against their
     `associatedPayout`, as Shopify's staff suggest, so one that says it
     belongs to another payout is left out and the payout's total check
     catches anything missing. When Shopify withholds protected customer
     data (names, emails, phones, addresses) it answers with an error in an
     otherwise good reply (shopify.dev/docs/apps/launch/protected-customer-data);
     the sync stops and says what to turn on in the app's settings rather
     than matching customers by a blank email. Unchanged after checking:
     webhook signatures (base64 HMAC-SHA256 of the raw body with the app's
     secret) and duplicates (by `X-Shopify-Webhook-Id`; `X-Shopify-Event-Id`
     is shared by different deliveries of one action, so it isn't used),
     and paging (cursors, `hasNextPage`). Still not tried against a real
     store.
666. **WooCommerce refund lines say which order line they refund**
     (20 October 2026; Codex, delegated by owner, 20 October 2026: "then
     existing WooCommerce gaps"). A refund line's `_refunded_item_id` meta
     (shown in WooCommerce's REST API refund example) is the order line it
     refunds, and refunded shipping has the same. Tohyee used to match a
     refund line to the first order line with the same product, which is
     wrong when a product is on two lines at different prices; it now uses
     `_refunded_item_id`, and the product only when a refund line doesn't
     have it. The other WooCommerce gaps listed in FEATURES stay as Jess
     decided on 5 October 2026: surcharges refused for now, and no product
     or customer sync (email and SKU matching is enough). WooPayments
     deposits are still reconciled by hand: no documented API for them was
     found. Refunds of an amount only (no items) are still refused, as for
     Shopify.
667. **Square left out** (20 October 2026). Square was built as the next
     sales connector under the delegated answer in #360 item 18, then left
     out on Jess's decision of 20 October 2026 ("Leave Square out"):
     Square doesn't take card payments in New Zealand (its developer docs
     list Australia, Canada, France, Ireland, Japan, Spain, the UK and the
     US). None of it was merged. Decisions 668 and 669 are unused.
624. **Homekill is one yearly adjustment by the accountant** (Jess, 20
     October 2026, on #371: "Home kill the accountant just does a jnl
     adjustment like 500 bucks"; asked to choose, "One yearly adjustment").
     This replaces the per-event GST assessment from Codex's 20 Oct
     recommendation on #292 before it was merged. The owner's rations
     (homekill) are head counts only and post nothing. Once a year a
     bookkeeper or above enters the amount they choose, its basis
     (required), and on a GST-registered date whether GST applies and
     whether the amount includes it. Examples RAT1, RAT3-RAT10, not yet
     reviewed. Staff rations (RAT2) are unchanged.
625. **How the homekill adjustment posts** (Jess, 20 October 2026). Dr
     owner drawings or current account (the drawings account in Livestock
     settings), Cr rations income, and Cr GST when GST applies (1,100.00
     excluding GST: 1,265.00 / 1,100.00 / 165.00; including GST: 143.48 GST,
     956.52 income), on the balance date or a date in the year. One active
     adjustment a year: a different amount means voiding it with a reason
     (reversed on its own date) and entering another. Origin
     `livestock_rations`, so the cash flow statement treats it as non-cash.
     No debit to GST and no bank line.
626. **The homekill adjustment in the GST return** (Jess, 20 October 2026).
     With GST it's a sales line on its date on every GST basis (Box 5,
     HOMEKILL-<year end>), so it's in the return for that date's period.
     Voided after its return is filed, the next return takes it back off
     through the existing late claims. Filed returns are never rewritten.
     There's no per-event assessment and no "not assessed" listing.
627. **Rations posted per event before 20 October 2026** (Jess, 20 October
     2026). Journals the old RAT1 posted for each owner's rations movement
     stay as they are. The homekill card shows how much was posted that way
     in the year, so it isn't counted again in the yearly amount. Voiding
     such a movement still reverses its journal. The year's head count beside
     the adjustment is for information only: the amount is the accountant's.

### Group workspace (decisions 640-647)

From #200 stage 1, with the owner-delegated answers in #360 items 11-13
(Codex, delegated by owner, 20 October 2026). Where those answers left a
detail open, NetSuite OneWorld is the reference (Xero has no groups); the
accounting example is marked not yet reviewed.

640. **Members have dates** (20 October 2026; Codex, delegated by owner).
     Each stay of an organisation in a consolidation group has a first day
     and a last day, both included (blank: from the start, still in). Core
     migration 0015. Taking an organisation out on the Group tab ends its
     stay yesterday rather than deleting it; putting it back starts a new
     stay today; stays never overlap. An admin of every member can set the
     dates. The parent has no dates (it's in every report), and the steward
     (decision 641) can't be given a last day. A consolidated report
     includes the members in the group on its date (the balance sheet's
     as-at date, the profit and loss's end date). A profit and loss or
     budget vs actual whose dates cross a day a member joined or left is
     refused and names the dates (CO13): Tohyee doesn't split a member's
     results at that day, since that's acquisition and disposal accounting,
     which isn't built. To see a group you must be a member of every
     organisation that hasn't left; a report dated while a since-departed
     member was in also needs you to see that one, or it's refused. Groups
     with no dates (all existing ones) behave exactly as before.
641. **A steward keeps the group's new records** (20 October 2026; Codex,
     delegated by owner). Each group names a member, the parent unless
     changed, whose own database holds the group's business records:
     customer links, stage mappings and saved reports (tenant migration
     0173). The core database only records which organisation is the
     steward. This settles the conflict #200 found between the agent
     instructions ("core never holds accounting data") and decisions 438
     and 446 (consolidation rates, adjustments and commentary are in core):
     those existing records stay in core for now, as documented, and
     nothing new goes there. Changing steward is refused while the steward
     holds any of the group's records, because moving them isn't built
     (decision 646). The steward can't leave the group while it's steward.
642. **Customers are linked by a person, never merged** (20 October 2026;
     Codex, delegated by owner; NetSuite's shared customers without
     merging). A group customer links one contact in each of two or more
     members; a bookkeeper or above of every member makes or changes it. A
     contact is in at most one group customer per group. Each contact stays
     its own record in its own organisation and nothing about it changes.
     Tohyee never links contacts because their names or emails match, and
     doesn't suggest links: the person searches each organisation and picks.
     Names are read from each member when shown, never copied to the
     steward. Unlinking keeps the link with who unlinked it. A link to an
     organisation that has left is shown as such and left out of totals; if
     the person can't see that organisation it's hidden and counted.
643. **Different stages need a person's mapping** (20 October 2026; Codex,
     delegated by owner). The workspace combines the pipeline by stage only
     when every stage in use either has a mapping (which group stage it
     counts as, chosen by an admin of every member) or has the same key,
     name and type in every member with the CRM on and no mapping anywhere.
     Otherwise it lists the unmapped stages and shows no combined stage
     figures. Mappings change nothing in any organisation. Accounts are
     still combined by code (decision 443); mapping different charts of
     accounts isn't built.
644. **CRM amounts stay in their currency** (20 October 2026; Codex,
     delegated by owner). Pipeline and what linked customers owe are added
     up per currency, the group's first, never across currencies (as MC68).
     The person can choose "Also translated into" the group's currency: each
     currency's total times the consolidation's current rate on the date
     (decision 439: the parent's exchange rates list, or a month's changed
     current rate), rounded half up to cents, then added; the figure always
     shows its label and the rates used, and a currency with no rate is left
     out and named. It's not an accounting figure. Pipeline is open
     opportunities now (the CRM keeps no past amounts).
645. **The workspace, who sees it, and its copies** (20 October 2026; Codex,
     delegated by owner). Reports, Consolidation, a group, Workspace (the
     first tab): the members on a date with their dates, the consolidated
     revenue and net profit for the group's year to date (the existing
     consolidated profit and loss, unchanged, so it reconciles to that tab),
     each member's share, what each member's customers owe (its own
     currency), the pipeline per currency and by stage, and linked
     customers. Each member's part is read from its own database as the
     signed-in person. A member with the CRM or Accounting off, or one that
     can't be read, is named in a "Not everything in the group is included"
     notice, so a partial result never passes for the whole group. Each
     person's result is kept for up to a minute as a copy keyed by who they
     are, when each of their memberships was made and their role in every
     member, the group's version and the members' dates; access is checked
     before any copy is used, and every change to the group, its members,
     steward, customer links or stage mappings drops the group's copies.
     Saved reports (Save a copy on the profit and loss and balance sheet;
     bookkeepers of every member) keep the figures, the members with their
     dates, the group's version and who saved it, in the steward's database,
     append-only. They're shown only to someone who can see the group and
     every organisation in the saved report, so they survive a member
     leaving, with their provenance, but disappear for anyone who loses
     access to one of their organisations.
646. **Moving existing consolidation records: a plan, tested, not done**
     (20 October 2026; Codex, delegated by owner: "record and test a
     migration plan before moving anything"). `src/lib/consolidation/move-plan.ts`
     reads a group's rows in core (rate overrides, budget rates, adjustments
     and their lines, commentaries), maps each to the steward table it would
     go to and back, and checks the row counts and checksums agree. It
     writes nothing. The steps are in docs/ARCHITECTURE.md ("Moving a
     group's records"). The move itself, and changing steward when records
     exist, wait for a separate decision.
647. **Flat groups, not tax groups** (20 October 2026; Codex, delegated by
     owner). Groups have no sub-groups, and choosing members implies no
     ownership percentage, minority interest, acquisition or disposal
     accounting (decision 445: wholly owned members only). Being in a group
     isn't a tax consolidation election or a GST group: the workspace and
     the group's settings say so, and no tax figure is combined.

### Report themes, chart type defaults and the format painter (#376 phase 1; decisions 668-671)

668. **Tohyee's look stays the default; Analytics reports can choose
     another** (20 October 2026, #376; settled as the issue proposes, at
     the lead's direction, not yet confirmed by Jess). Decision 599 says
     one chart look for the whole of Tohyee, and Power BI-style formatting
     means people change that look. So: the Tohyee theme is the default
     and is what every chart outside Analytics uses (Home, pinned tiles,
     cash flow, farm pages). An Analytics report can choose another
     built-in theme or one of its organisation's own, and later phases
     add per-visual overrides on top. A theme is applied as CSS variables
     (`--chart-*` and `--report-*`) on the report's tiles and the chart
     editor's preview only, so the rest of the page keeps Tohyee's look,
     and a report on the Tohyee theme gets no variables at all (it looks
     exactly as before). Any hex colour is allowed. Every theme goes
     through the same checks as decision 599, ported to TypeScript
     (`src/lib/charts/colour-check.ts`, same thresholds and colour-vision
     simulation; it reproduces 599's figures): lightness band, chroma,
     colour-blind and normal-vision distance between neighbouring colours,
     contrast of each colour and of the text against the card. Failing a
     check warns, it never blocks saving. Light and dark still follow the
     computer and the user menu: every theme has both, and a theme given in
     light only gets dark worked out (each colour keeps its hue at a
     dark-mode lightness; surfaces and text from Tohyee's dark ones), then
     checked like any other.
669. **Six built-in themes** (20 October 2026). Tohyee (the default),
     Harbour (sea blues first, system font, soft shadow, rounder cards),
     Kōwhai (gold first, Georgia, warm paper card), Bush (greens and earth),
     Bright (the data-visualisation reference palette) and Strong contrast
     (darker colours, black or white text, 2px borders, 13px labels). Each
     colour order was chosen by trying every order with its first colour
     fixed and keeping the one with the most separation that passed every
     check in both modes. Worst neighbouring pair, colour-blind / normal
     vision (target 8 / floor 15): Tohyee 15.1/22.7 light, 12.9/20.4 dark;
     Harbour 10.3/23.6, 9.0/19.2; Kōwhai 12.4/26.5, 11.8/23.3; Bush
     13.6/19.5, 9.1/17.1; Bright 9.1/19.6, 8.4/19.3; Strong contrast
     9.9/23.8, 8.7/24.4. Under 3:1 against the light card, as with
     Tohyee's own yellow: Harbour's and Bush's yellows and Bright's aqua,
     yellow and pink (every chart has its table for screen readers and
     tooltips). A unit test keeps them passing.
670. **An organisation's own themes** (20 October 2026; tenant migration
     0176, `analytics_themes`). In a report's edit mode, Theme opens the
     theme list and "New theme from <current>" opens the editor: up to 12
     series colours (any hex, for light and dark, with "Work out dark from
     light"), page and card backgrounds, text and muted text, a font from a
     safe list (Tohyee's Inter, system, Arial, Verdana, Trebuchet, Georgia),
     title, label and axis text sizes, and the card's corner radius, border
     width, shadow and padding, with a live preview in light or dark and
     the colour checks. Saved themes belong to the organisation (bookkeepers
     and up save, change or remove them, as for reports; viewers can list
     them) and are checked by `parseReportTheme` (unknown settings dropped,
     wrong values refused) before they're stored or put on a page. Changing
     one changes every report using it. One a report uses can't be removed
     (choose another theme for those reports first), so a report never
     loses its look by surprise. Themes export as a JSON file and import
     from one (the same checks; an import opens in the editor to save).
     The report's choice is kept in its settings (`theme`: a built-in id or
     `custom:<id>`; nothing for Tohyee) and read with the report, so report
     viewers see it too.
671. **Chart type defaults and the format painter** (20 October 2026;
     Power BI's "set as default for this visual type in this report" and
     its format painter). In a chart's Format section, "Set as default for
     columns in this report" keeps what the chart looks like as the
     report's default for that chart type (in the report's settings,
     `visualDefaults`, checked like a tile's format); every chart of that
     type in the report draws with it, and a tile's own settings go over it
     one by one. Reset to default then means the report's default. Pinned
     tiles use the defaults too (but not the theme, decision 668). In edit
     mode each chart has Copy format; the other charts then show Paste
     format, which gives them the same format and saves the report, until
     Done pasting. Neither copies a key figure's target: that's a number
     about the data, not how it looks.
672. **A colour chosen on a chart gets a dark version** (20 October 2026,
     #376). Power BI and Looker Studio have no dark mode, so a colour typed
     on a chart is one hex. Tohyee follows the computer's light or dark, so
     on a dark card each chosen colour is drawn as a dark version worked out
     the way a theme's dark colours are (decision 668): a mark (a value's or
     group's colour, a reference line, a border) keeps its hue at a
     dark-mode lightness unless it already reads there; a background (the
     card, the plot area, behind the title, gridlines) becomes a dark tint
     of its hue; text that would be under 4.5:1 on the dark card is
     lightened. Light mode shows the colour exactly as chosen. Cards use
     CSS `light-dark()` with both. The colour checks warn about a chosen
     colour under 3:1 against the card, or too close to its neighbour for
     colour-blind or normal vision, in light (as chosen) and dark (as drawn).
673. **Formatting each chart** (20 October 2026, #376 phase 1; Power BI's
     format pane and Looker Studio's style tab as the reference). New
     settings, all optional and checked by `parseChartFormat` (unknown
     dropped, wrong values refused, so saved charts are unchanged): the
     title's size, weight, italic, colour, alignment and a colour behind it,
     and the subtitle's; the card's colour and how solid it is, border
     colour and width, corners, shadow and padding; any colour for a value
     (over the named colour; Reset goes back to the theme) and for chosen
     groups (pie, donut, or columns and bars with one value); data labels'
     size, colour and their own number format, which labels show (all,
     only where they fit, first and last), and a pie's name, value and
     percentage in any mix; each axis shown or hidden, text size, colour,
     angle and reversed, the value axis's own number format and step, the
     group axis's label interval and, for dates, a from and to date; the
     legend in any side or corner with its own size and a title; gridlines
     solid, dashed or dotted in a chosen colour; a plot area colour;
     tooltips off, a total of the values (added exactly), and each value
     shown, left out of the tooltip or only in it (then it isn't drawn, so
     it doesn't stretch the axis); up to 8 reference lines (a fixed value,
     a target, the average, median, lowest, highest or a percentile of a
     value, or a shaded band), labelled; a straight trend line per value
     and a forecast that carries it on for 1 to 12 groups (a least-squares
     line on the drawn figures, shown dashed, not a forecasting model);
     column thickness, the gap between groups and square or rounded ends;
     and each line's width, style, step and dots. Reference lines,
     percentiles (interpolated, as a spreadsheet's PERCENTILE.INC) and trends
     are worked out from display numbers: they're positions on a chart,
     never figures in the books.
674. **Key figure formatting** (20 October 2026, #376 phase 1; Power BI's
     card and new card visual, Looker Studio's scorecard). The number can be
     small, medium, large, extra large or an exact size (16-96 pixels; it
     shrinks to fit a narrow card or phone), any colour, left, centred or
     right, bold or not, with the value's name above or below it. Its
     colour can instead come from rules on its value (up to six, "at least",
     "more than", "at most", "less than" or "exactly" a number, the first
     match wins), compared exactly in decimals like the change itself, or
     from the comparison: green when it's good news and red when not, with
     the arrow and Up or Down still there so colour is never the only
     sign. An arrow or a dot can sit by the number. The trend underneath
     can be a line, an area or columns in any colour. "Every value as its
     own number" shows all the tile's values side by side, each named
     (Power BI's multi-row card); a value's previous period or last year
     stays with the first value's change. As with charts, a chosen colour
     gets a dark version in dark mode (decision 672). The format painter
     and chart type defaults copy all of this except the target.
675. **Conditional formatting and table styles** (20 October 2026, #376
     phase 1; Power BI's conditional formatting and table/matrix style, as
     the issue says). In a table or pivot, each value's cells can have
     their background or text coloured by a two- or three-colour scale
     (from the column's lowest to highest; the middle colour sits halfway),
     by rules (up to six, compared exactly in decimals, first match wins)
     or from a field holding colours (the group column: #rrggbb or a few
     colour names, anything else left plain). Text on a coloured cell is
     picked to read on it (white or near-black) unless a text colour was
     chosen. Data bars grow from zero across the column's range; icons mark
     the highest, middle and lowest thirds with a different shape as well
     as colour (arrows, or circle, diamond and square), with the words for
     screen readers. In a pivot only the detail rows are coloured, and the
     range comes from them, so subtotals don't flatten the scale. Charts can
     have colour rules too (columns and dots), e.g. red below a target,
     for every value or one. Table and pivot style: header background and
     text colours, banded rows and their colour, gridlines (rows and
     columns, rows only, none), text size, narrowest column width, wrapping
     long text, a totals row for tables (totals and counts added exactly;
     averages, smallest, largest, distinct counts and calculated values left
     blank, because adding them up would be wrong; "Total of the rows
     shown" when the table was cut at 5,000 rows), the pivot's grand total
     on or off, totals bold or shaded, and pivot subtotals per row field
     level. Colours follow decision 672 in dark mode. Exports are unchanged
     (they're the figures, not the look). While building this, numbers of
     a thousand or more in tables were found showing four decimal places
     (1,203.0000); they now drop the trailing zeros like smaller numbers.

### More visuals (#376 phase 2; decisions 676-689)

676. **Waterfall, funnel, gauge and bullet chart** (21 October 2026, #376
     phase 2; Power BI's visuals of the same names, as the issue names
     Power BI and Looker Studio as the references; not yet reviewed by
     Jess). They are new tile visuals beside the ten already there, saved
     the same way, so existing reports are unchanged. A waterfall and a
     funnel show one value grouped by something; a gauge shows one total
     (it can't be grouped) and a bullet chart one total or one bar per
     group; both can take a second value as the target, or a typed
     target. Neither compares with last year or the previous period (the
     target is their comparison). The waterfall works out each bar's start
     and end, and the total bar, exactly in decimals (a bridge must add up
     to the cent); only the drawing turns them into numbers. Rises use the
     value's colour (the theme's first) and falls the theme's second, which
     in Tohyee's theme are the diverging pair's blue and orange (decision
     599); the total is the muted grey. As Power BI, the total bar is on
     and can be named or turned off; thin hairlines join the bars. The
     funnel keeps the tile's order (Order by) rather than sorting itself,
     and shows each stage's share of the first stage (Power BI's default)
     or of the stage before. The gauge runs from 0 to twice the value
     (Power BI) unless a range is chosen; with a target it runs a little
     past the target or the value instead, so the target is never off the
     dial. The bullet chart follows Stephen Few's design (as Power BI's
     bullet visual does): grey bands at percentages of each group's target
     (60% and 80% unless changed; up to three), the last running on to
     120% of the target or the value, a thin bar for the value and an
     upright line for the target. All four use the report theme,
     `parseChartFormat` for their settings (unknown dropped, bad refused),
     colour rules and per-group colours, number formats and data labels.
677. **Targets and ranges aren't part of a copied look** (21 October 2026).
     Like the key figure's target (decision 671), a gauge's range and
     target and a bullet chart's typed target are numbers about the data,
     so the format painter and chart type defaults leave them out, and
     pasting keeps the tile's own.

### The access contract for Analytics outputs (#387; decision 697)

697. **Every Analytics output uses the report viewer's server-side scope;
     a slicer lists only what the tiles show** (21 October 2026, #387;
     settled as the review proposes, at the lead's direction, not yet
     confirmed by Jess). The contract is written out in
     ANALYTICS-STUDIO.md ("Who can see what") and tested: figures,
     tooltips, totals and comparisons come from the saved tile's answer;
     drill-through gives only the pivot's own fields; CSV and Excel are
     made from what the page already has; pinned tiles go through the same
     query path and hide when unshared; addresses and `?edit=1` grant
     nothing; there are no caches and no scheduled outputs yet (a future
     one runs as its recipient, checked at send time). Checking it found
     one gap: a report viewer's slicer listed every value of the column in
     the whole table, so a report showing only web sales still named the
     regions and notes of shop sales. A report viewer's slicer now lists
     the distinct values in the rows each tile (on a table with that field)
     reads after the tile's own filters, ignoring dates (the viewer can
     change them) and up to 500. Viewers and up still get the whole column,
     since they can query the table anyway. No row-level rules were added
     (phase 5).

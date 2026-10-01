# IRD payday filing file upload specification — field summary

Read 1 Oct 2026 with Claude's web fetch tool (the session's shell couldn't
download from ird.govt.nz: the proxy refused it, so the PDF wasn't saved).
The fetch tool returned the PDF's text through a summarising model: the
field tables below came back as tables and were cross-checked against the
spec's own example file (field counts and positions agree), but the wording
is a summary in our own words, not a copy. Check IRD's current PDF before
relying on a detail, and run a real file through myIR's "Check your
employment information file" service (spec 2.5) before using it for a
client.

- **Document:** Inland Revenue, *Payday Filing File Upload Specification*,
  version "2027" (covers 1 April 2026 to 31 March 2027), dated July 2026.
  URL: https://www.ird.govt.nz/-/media/project/ir/home/documents/digital-service-providers/iir-file-upload-specification/payday-filing-file-upload-specification-2026-2027.pdf?modified=20260713005039
  Linked from IRD's page "Payday filing through file upload services":
  https://www.ird.govt.nz/digital-service-providers/services-catalogue/returns-and-information/payday-filing/payday-filing-through-file-upload-services
- **Companion:** *Payday Software Developers Casebook* V1.1, 24/03/2026
  (1 April 2026 to 31 March 2027),
  https://www.ird.govt.nz/-/media/project/ir/home/documents/digital-service-providers/iir-file-upload-specification/payday-software-developers-casebook-2026-27.pdf?modified=20260331221250 .
  Only its scenarios section came back; it calls the file upload spec and
  the Payroll Calculations & Business Rules Spec the "documents of truth".
- **Contents** (spec): 1 Introduction; 2 Electronic filing requirements (2.4
  messages and validations in myIR, 2.5 check your employment information
  file); 3 Payday filing (3.1 employee details filing, 3.2 employee details
  CSV file, 3.3 employee details Excel file, 3.4 employer information filing
  [the EI file], 3.5 EI amendments file); 4 KiwiSaver online forms; 5
  Appendix (5.1 myIR format and layout, 5.2 pay cycle, paydate, pay period,
  5.3 tax codes, 5.4 countries, 5.5 unit types, 5.6 titles, 5.7 KiwiSaver
  status codes, 5.8 IRD number validation, 5.9 change log).

**Not reached:** the fetch tool's text stopped at section 3.5.5, so the
appendix (5.1 attribute definitions such as PDEC and DEC, 5.3 the tax code
table, 5.8 IRD number validation, 5.9 change log) wasn't read. What's said
below about how amounts are written comes from the spec's example file and
field notes, not from a definition.

## Due dates

- Spec 3.4: the EI is due "2 working days after the paydate for electronic
  filers or 10 working days after the paydate for paper filers"; if the due
  date "falls on a weekend or public holiday, then the due date becomes the
  next working day".
- IRD, "Payday filing" (https://www.ird.govt.nz/employing-staff/payday-filing,
  last updated 24 Feb 2026, read 1 Oct 2026): electronic filers "need to file
  employment information within 2 working days of each payday"; paper
  filers within 10 working days.
- Employee details (spec 3.1): expected "no later than the next filing of
  employment information" but can be sent earlier. IRD, "Filing employment
  information electronically"
  (https://www.ird.govt.nz/employing-staff/payday-filing/filing-employment-information-electronically,
  last updated 26 Nov 2024): a new employee's address and date of birth (if
  given) "on or before a new employee's first payday"; a leaver's finish
  date "on or before an employee's last day".
- Neither page defines a working day. The Tax Administration Act's
  definition wasn't read.

## File format (employment information, spec 3.4)

- A CSV file: one header record then one or more employee records (3.4.1).
  Fields separated by commas; empty optional fields are left empty between
  commas (spec example). No quoting rules are given, and names "must not
  include embedded commas". No file name, extension rule, line terminator,
  character set or maximum number of lines was found.
- 2.4: myIR validates file format, required fields, field formats and
  lengths. IRD doesn't recommend opening the file in Excel before uploading
  ("Excel will add extra comma(s) to the end of each line").
- Amounts: the example file writes money as whole cents with no decimal
  point (e.g. `143257`), and "Hours paid" says "two decimal places; e.g.
  37.5 hours = 3750". Read as: amounts and hours × 100, no decimal point, no
  padding. Dates are CCYYMMDD. IRD numbers are 9 digits (the example has
  `074444444`, an 8-digit number with a leading 0).
- "Multiple EIs can be filed for the same paydate. Multiple EIs for a single
  paydate can also be consolidated into a single paydate EI." (spec)
- 3.4.2: until an employee's IRD number is supplied, the tax code is ND and
  PAYE is at the ND rate; the IRD number field is then `000000000`.

### HEI2 — header record (28 fields)

| # | Field | Attribute, size | Req. | Notes (summary) |
| --- | --- | --- | --- | --- |
| 1 | Header record indicator | ALPHA 4 | R | `HEI2` |
| 2 | Employer IRD number | IRD 9 | R | 9 digits, not 000000000 |
| 3 | Paydate | DATE 8 | R | "the day on which an employer makes a PAYE income payment to an employee"; CCYYMMDD |
| 4 | Final return for employer | ALPHA 1 | R | Y or N; Y when the employer has stopped employing |
| 5 | Nil return indicator | ALPHA 1 | R | Y or N; if Y no other details needed |
| 6 | PAYE intermediary IRD number | IRD 9 | O | blank if none |
| 7 | Name of payroll contact person | ANAM 20 | R | "first name surname"; no embedded commas |
| 8 | Payroll contact work phone number | ANUM 12 | R | daytime work number; no commas |
| 9 | Email of payroll contact person | EMAIL 60 | R | A-Z a-z 0-9 @ - _ . ; must contain "@domain"; no double periods |
| 10 | Total employee lines | NUM 14 | R | number of DEI lines |
| 11 | Total gross earnings | PDEC 14 | R | sum of field 11 of the DEI lines (excludes Employee Share Scheme) |
| 12 | Total prior period gross adjustments | DEC 14 | R | |
| 13 | Total earnings not liable for ACC earners' levy | PDEC 14 | R | |
| 14 | Total PAYE / tax | PDEC 14 | R | can't exceed total gross |
| 15 | Total prior period PAYE adjustment | DEC 14 | R | |
| 16 | Total child support deductions | PDEC 14 | R | |
| 17 | Total student loan deductions | PDEC 14 | R | |
| 18 | Total SLCIR deductions | PDEC 14 | R | |
| 19 | Total SLBOR deductions | PDEC 14 | R | |
| 20 | Total KiwiSaver deductions | PDEC 14 | R | |
| 21 | Total net KiwiSaver employer contributions | PDEC 14 | R | excluding ESCT |
| 22 | Total ESCT deducted | PDEC 14 | R | |
| 23 | Total amounts deducted | PDEC 14 | R | PAYE + child support + student loan + KiwiSaver deductions + net employer contributions + ESCT + SLCIR + SLBOR |
| 24 | Total tax credits for payroll donations | PDEC 14 | R | |
| 25 | Total family tax credits | PDEC 14 | R | 0 unless the data is from Work and Income |
| 26 | Total Employee Share Scheme | PDEC 14 | R | |
| 27 | Payroll package and version identifier | ANAM 80 | R | e.g. `Vendor_Package_v1.0`; unique per developer/package/version; no employer information |
| 28 | IR form version number | NUM 4 | R | `0001` |

### DEI — employee record (27 fields)

| # | Field | Attribute, size | Req. | Notes (summary) |
| --- | --- | --- | --- | --- |
| 1 | Detail record indicator | ALPHA 3 | R | `DEI` |
| 2 | Employee IRD number | IRD 9 | R | modulus 11 checked; `000000000` if not supplied |
| 3 | Employee name | ANAM 255 | R | "firstname lastname" preferred; no embedded commas |
| 4 | Employee tax code | RANGE 5 | R | from the table in 5.3 (not read); the example has `M` and `M SL` |
| 5 | Employment start date | DATE 8 | O | only if it's in the pay period reported |
| 6 | Employment finish date | DATE 8 | O | only if it's in the pay period reported |
| 7 | Employee pay period start date | DATE 8 | R | first day of the period the employee was paid for |
| 8 | Employee pay period end date | DATE 8 | R | last day of that period |
| 9 | Employee pay cycle | ANUM 2 | R | WK weekly, FT fortnightly, 4W four-weekly, MT monthly, DA daily, AH ad hoc/irregular, HM half-monthly |
| 10 | Hours paid | PDEC 8 | R | hours paid for the paydate, two decimal places (37.5 = 3750); 0 if not held |
| 11 | Gross earnings and/or schedular payments | PDEC 14 | R | "taxable gross earnings ... Non-taxable allowances not included"; excludes ESS |
| 12 | Prior period gross adjustments | DEC 14 | R | negatives allowed, can't take the line below zero |
| 13 | Earnings and/or schedular payments not liable for ACC earners' levy | PDEC 14 | R | "excludes earnings over maximum liable threshold"; equals gross for schedular payments |
| 14 | Lump sum (extra pay) indicator | PDEC 1 | R | 1 if a lump sum taxed at the lowest rate was paid, else 0 |
| 15 | PAYE / tax | PDEC 14 | R | excludes student loan and child support |
| 16 | Prior period PAYE adjustment | DEC 14 | R | |
| 17 | Child support deductions | PDEC 14 | R | 0 unless a liable parent |
| 18 | Child support code | RANGE 1 | O | blank, or C, A, P, S, D, O |
| 19 | Student loan deductions | PDEC 14 | R | |
| 20 | SLCIR deductions | PDEC 14 | R | |
| 21 | SLBOR deductions | PDEC 14 | R | |
| 22 | KiwiSaver deductions | PDEC 14 | R | the note returned says "Must be one of 0, 3%, 4%, 6%, 8% or 10% of the employee's taxable gross earnings" — 3.5% (the default from 1 April 2026) isn't in that list; unverified whether myIR warns on 3.5% |
| 23 | Net KiwiSaver employer contributions | PDEC 14 | R | excluding ESCT |
| 24 | ESCT deducted | PDEC 14 | R | |
| 25 | Tax credits for payroll donations | PDEC 14 | R | |
| 26 | Family tax credits | PDEC 14 | R | 0 unless the employer is Work and Income |
| 27 | Employee Share Scheme | PDEC 14 | R | also counted in field 13 |

### The spec's example (3.4.4)

IRD says "the example is intended to show the layout of the file —
calculated figures may not be accurate" (its header totals don't add up to
its lines). First two lines:

```
HEI2,123123123,20190522,N,N,,Bill Smith,041234567,payroll@email.com,4,143257,5000,2000,47024,40,0,16671,0,5750,85500,83660,2560,147100,2500,0,22500,vendor_package_v1.0,0001
DEI,111111111,Brown John,M,,,20190407,20190414,WK,3050,56875,0,0,0,34687,0,0,,0,0,0,4550,3565,756,0,0,0
```

and a student loan employee's tax code written `M SL`:

```
DEI,075555555,French Carol,M SL,,,20190407,20190414,WK,2500,45678,2567,0,0,32785,1456,0,,2687,0,0,0,0,0,0,0,0
```

## Employee details file (spec 3.2, 3.3) — not built

Records: `HED2` header (employer IRD number, payroll package identifier,
number of DED lines); `DED` per employee (41 fields: IRD number, name on
the EI, title, first, middle and last names, date of birth, start date
(required), end date, KiwiSaver eligibility NE/EE/EA, new employee
KiwiSaver status AE/AK/OK/NK/CT, exempt income, email, mobile and daytime
phone each with an ISO 3166 alpha-3 country and extension, a structured
address (country, unit type and number, floor, building, street, suburb,
city, post code, state), KiwiSaver opt-out with bank account, signed date
and late opt-out reason); `TED` tax code records, at least one per active
employee. The example shows a student loan employee with two TED records,
`TED,M` and `TED,SL`, while a business rule returned as "only one primary
code (M, MSL, ME, or MESL)" — so how tax codes are written in TED isn't
clear from what was read. Tax codes not re-sent are "assumed to be no
longer active". The change log mentions "October 2026 changes: The employee
first name and last name validations have been updated for the Employee
Details file."

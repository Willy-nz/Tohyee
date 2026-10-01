# IRD payroll rates

These files hold IRD's national payroll figures (PAYE, ACC earners' levy,
student loan, KiwiSaver, ESCT). They're the same for every organisation, so
they live here in the code rather than in an organisation's database. Each
release of Tohyee carries the figures it was tested with.

- `types.ts`: the shape of an edition.
- `2025-26.ts`, `2026-27.ts`: one file per edition of IRD's
  [Payroll Calculations and Business Rules Specification](https://www.ird.govt.nz/digital-service-providers/services-catalogue/returns-and-information/payday-filing/payroll-calculations-and-business-rules).
- `index.ts`: `PAYROLL_RATE_EDITIONS` (every edition, oldest first) and
  `payrollRatesOn(payDate)`, which picks the figures in effect on a pay date.
  Pay dates outside every edition are refused.

The calculations that use the figures are in `../calculations.ts`. They
never contain a rate themselves.

## Rules

- Every figure comes from an IRD document, never from memory or a third-party
  summary. Each dated value has a `source` (section and page of the
  specification, as printed).
- Each edition records the specification and the documents used to check it
  (IR340, IR341, IR335, KS4): name, number, edition, URL, the date we read it
  and the SHA-256 of the PDF we read.
- Values are strings, read with `src/lib/money/decimal.ts`. Rates are
  percentages ("17.5" means 17.5%). Amounts are dollars as IRD prints them.
- Released editions are history: don't change a figure in one unless IRD
  republishes it, and then say so in the PR.

## Adding a new tax year

IRD usually publishes the next specification in February or March. For
2027-28:

1. Download the new specification PDF, and the new IR340 and IR341 (PAYE
   deduction tables), IR335 (employer's guide) and KS4 (KiwiSaver employer
   guide). Note the date you read them. `sha256sum file.pdf` gives the hash.
   IRD's "current" URLs (for example the specification's) start pointing at
   the new edition, so record the URL you used and keep the old files'
   entries as they are.
2. Copy the latest file: `cp 2026-27.ts 2027-28.ts`. Rename the export to
   `RATES_2027_28`.
3. Change `id`, `from` and `to` (1 April to 31 March), and every dated
   value's `from` and `to`.
4. Update `specification` and `crossChecks`: document name, edition (as
   printed on the cover), URL, `read` date and `sha256`.
5. Go through the specification's "Rate Updates and Legislation Changes"
   (section 2 in 2026-27), "Student Loans" (3), "KiwiSaver" (4) and
   "Calculation Details" (5), and check every number in the file against it, changing the
   ones that differ and every `source` (section and page):
   - `incomeTax`: bracket limits, rates and the "subtract" amounts printed
     in the PAYE calculation steps (5.2 step 3 in 2026-27).
   - `accEarnersLevy`: levy rate, maximum liable earnings and maximum levy.
   - `independentEarnerTaxCredit`: thresholds, amount and abatement rate.
   - `secondaryTaxRates` (SB, S, SH, ST, SA) and `flatTaxRates` (ND, NSW,
     CAE, EDW): the income tax rate only. The levy is added by the
     calculation, so check that rate + levy equals the combined rate the
     specification prints.
   - `studentLoan`: annual threshold, rate and the four pay-period
     thresholds.
   - `kiwiSaver`: allowed employee rates, default rate, employer minimum and
     the temporary rate reduction rates.
   - `esct`: the threshold bands and rates.
6. If IRD changes a figure part way through the year, give that value two
   dated entries (for example 1 April to 31 July, 1 August to 31 March),
   each with its own source. `payrollRatesOn` picks by pay date, and the
   tests check every value covers the year exactly once.
7. Add the new file to `PAYROLL_RATE_EDITIONS` in `index.ts`.
8. Tests (write them before trusting the file):
   - `tests/unit/payroll-rates.test.ts`: add the new year to the list of
     edition ids, the "combined rates" and "KiwiSaver rates by year"
     checks, and PR1's edition lookup.
   - `tests/unit/payroll-calculations.test.ts`: add every worked example the
     new specification prints with numbers (in 2026-27: ESS example 4 in
     5.10, Mike's NSW example in 5.5, the RD 68 example in 5.20.2, and the
     ESCT examples in 5.21), and the examples in IR335 and KS4. Check each
     example's figures are really that year's (the 2026-27 specification
     reprints some 2025-26 figures; see PR3 in the docs).
   - `tests/fixtures/ird-paye-tables.json`: add sample rows from the new
     IR340 and IR341 (including rows either side of each bracket limit, the
     levy maximum and the student loan threshold), with a pay date in the
     new year (the test checks every edition has all eight tables).
     `tests/unit/payroll-ird-tables.test.ts` checks every row; update its
     expected numbers of tables and rows and its list of table editions.
9. Add worked examples for anything new to the "NZ payroll" section of
   `docs/ACCOUNTING-EXAMPLES.md` (not approved until Jess approves them), and
   anything the new rules don't clearly specify to its "Not supported yet"
   list. Code should refuse those with "Not supported yet (refused rather
   than guessed)".
10. Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`.

If the new specification changes how something is calculated (not just a
figure), that is a code change in `../calculations.ts`, with a worked example
and a test first.

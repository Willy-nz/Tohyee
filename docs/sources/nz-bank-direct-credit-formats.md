# NZ bank direct credit (bulk payment) file formats — summary

Read 1 Oct 2026 in Chrome (Claude in Chrome), on each bank's own website.
These are summaries in our own words, with the URL, not copies of the banks'
documents. Check the bank's current document before building an export.

Common ground across the NZ formats read: amounts in cents with no decimal
point (except ASB CSV and Westpac PaymentsPlus, which allow or require a
decimal point); payee statement details are Particulars, Code and Reference
of up to 12 characters each; payee name up to 20 characters; account numbers
written as bank (2) + branch (4) + base (7) + suffix (2 or 3), 15 or 16
digits; a control/trailer record with the total in cents, a count and a hash
total built from the branch and base account numbers, with overflow beyond 11
digits dropped on the left. Transaction code 50 (standard credit) or 52
(payroll/salary) where the format has one.

## ANZ NZ — "Domestic extended format" (MTS, comma-delimited)

- URL: https://www.anz.co.nz/banking-with-anz/ways-to-bank/guides/domestic-extended-format/
  (ANZ also lists a plainer "domestic format" at
  https://www.anz.co.nz/banking-with-anz/ways-to-bank/guides/domestic-format/ ,
  not read.) No version or date shown on the page.
- File: a header record, one or more transaction records, a control record
  (with hash total). Comma-separated, no commas inside fields, each line ends
  CR LF. Records may vary in length.
- Header (record type 1): subscriber ID, batch number, a null field,
  subscriber's account number and batch type may all be empty; batch due date
  and batch creation date are required, 8 digits YYYYMMDD.
- Transaction (record type 2): account number 15 or 16 digits
  (BBBBBBAAAAAAASS or BBBBBBAAAAAAASSS; a 2-digit suffix is widened to 3,
  suffix can't exceed 99); transaction code 2 digits, 50 = standard credit;
  amount up to 11 digits in cents; other party name up to 20 (required); other
  party reference up to 12 and analysis code up to 12 (marked required); other
  party alpha reference up to 12 (unused but must be allowed for); other party
  particulars up to 12; subscriber name up to 20; subscriber's analysis code,
  reference and particulars up to 12 each (optional).
- Control (record type 3): batch total in cents (up to 11 digits); number of
  transactions (up to 5 digits); hash total 11 digits = sum of branch (4) and
  base account number (7) of each transaction, ignoring bank and suffix; for
  an 8-digit base, drop its leftmost digit; if over 11 digits, drop the extra
  digits on the left.

## ASB — FastNet Business "Standard Bulk Payments" (MT9 fixed-length or CSV)

- URL (document page): https://www.asb.co.nz/documents/banking-with-asb/fastnet-business-file-formats-technical-guide.html
  PDF: https://www.asb.co.nz/content/dam/asb/documents/banking-with-asb/2012/asb-fnb-file-formats-technical-guide-nov-2012.pdf
- Version: "FastNet Business File Formats Technical Guide", issued November
  2012 (page dated 01-Nov-2012), section 2 Bulk Payments, pages 40-48. Text
  extracted in the browser; page 49 (the last CSV fields) wasn't captured.
- Direct credit, payroll and creditor bulk payments share one format. ASB
  prefers MT9.
- MT9: every record 160 characters, fixed length, fillers space-filled, CR at
  the end of each record (optional after the trailer).
  - Header: file type 12 (direct credit); payer bank (2), branch (4), unique
    number (7), suffix (3: a 2-digit suffix padded on the right, e.g. "01 ");
    due date DDMMYY + 7 spaces or DDMMCCYY/CCYYMMDD + 5 spaces; client short
    name X(20) (optional, not used); filler 109 spaces.
  - Detail: record type 13; payee bank (2), branch (4), unique number (7),
    suffix (3: e.g. 001 or "01 "); transaction code 3 digits, 051 credits, 052
    salary/wages; amount 9(10) in cents, zero-padded; payee name X(20); internal
    reference X(12) (not sent to the bank); payee code X(12); payee reference
    X(12); payee particulars X(12); 1 space; payer name X(20) (not used); payer
    code, payer reference, payer particulars X(12) each (optional); 4 spaces.
    Text fields padded right with spaces; allowed characters are letters,
    digits, space and ( ) * + - = ? [ ] _ { } ~ / & , . '
  - Trailer: record type 13, key 99; import file check total 9(11) = sum of
    each detail record's branch and unique numbers, truncated on the left to
    11 digits (only checked when filled in); 6 spaces; total amount 9(10) in
    cents; 129 spaces.
- CSV: one line per payment, carriage return after each line except
  optionally the last. Fields: payment name (≤20, same on every line); date
  (DD/MM/YY, DD/MM/CCYY or CCYY/MM/DD preferred; same on every line);
  deduction account (15, 16 or 19 digits, hyphens optional; same on every
  line); amount (decimal point optional, otherwise cents); payee particulars,
  code and reference (≤12 each, may be empty); destination account; payer
  particulars (≤12); further payer fields on page 49 (not read).
- Re-read 1 Oct 2026 (the PDF through WebFetch, for payroll P5): MT9 header
  suffix "Acceptable: 01 expressed as 010 Better: 01 expressed as 01¤";
  due date "Correct: DDMMCCYY¤¤¤¤¤"; detail amount "Align right and pad to
  the left with zeros. Correct: $123.45 expressed as 0000012345"; check
  total "If the number exceeds 11 characters, the remaining characters are
  not used. For example, if the sum is 123456789123, then the import file
  check total is shortened to 23456789123", and "FastNet Business only
  validates this field when it is populated"; client short name and payer
  name "not used by FastNet Business". The guide gives no complete example
  MT9 lines. CSV fields 9-12 as the tool read them: payer particulars, payer
  code, payer reference (≤12 each) and payee name (≤32); not used, as MT9 is
  what Tohyee makes.

## BNZ — Internet Banking for Business (IB4B) "Direct Credits" / "Payroll" file

- URL: https://www.bnz.co.nz/assets/business-banking-help-support/internet-banking/ib4b-file-format-guide.pdf
  (linked from https://www.bnz.co.nz/business-banking/support/internet-banking-for-business/payments-and-direct-debits/payroll-and-direct-credit-payments )
- Version: "Internet Banking for Business — Payment file format guide",
  29 pages; back page code "(14728) 099376 10-24" (October 2024).
- Comma-delimited ASCII, extension .afi or .txt, CR LF after each record,
  no trailing spaces, no commas in fields; one header, one or more
  transactions, one control record; up to 99,998 transactions (bulk) or
  49,999 (individualised); amounts must be greater than zero. Payroll is the
  same layout as direct credit.
- Header (1): three spare fields left blank; your account number 15 or 16
  digits (no spaces or hyphens); file type 7 (direct credit); due date YYMMDD
  (not before today, not more than a year ahead); creation date YYMMDD;
  bulk/individual indicator: blank = one bulk line on your statement, C =
  individual with details copied from the payee, I = individual with your own
  details per line, O = individual with the first line's details for all.
  Example: `1,,,,0201000123456000,7,131124,131120,`
- Transaction (2): payee account (15 or 16 digits) or NZ credit card; code 50
  or 61 standard credit, 52 payroll (one code for the whole file); amount in
  cents (≤12 digits); payee name A(20) required; payee reference, payee code
  (≤12 each, optional); alpha reference (spare, blank); payee particulars
  (≤12); your name A(20) required; your code, your reference, your
  particulars (≤12 each). Longer text is truncated at 12.
  Example: `2,0209850999088025,50,1688,John Smith,AZ100364C,,,,ACME CORPORATION,,,`
- Control (3): total in cents (≤12); count (≤6); hash total 11 digits = sum of
  digits 3 to 13 of each payee account (the branch and 7-digit base: first two
  and last two or three digits ignored), keep the rightmost 11 digits, zero
  fill on the left. Example: `3,14198,152,19707998176`

## Westpac NZ — Westpac One Business payment file upload

- URL: https://www.westpac.co.nz/help/upload-a-payment-file-in-w1b/
- Westpac One Business detects the format automatically and accepts:
  Payment Fixed length (COL Fixed Length / Deskbank Fixed Length), Payment CSV
  (COL CSV / Deskbank CSV), BACHO, PAIN008 V2, PAIN001 V3, Qvalent NZ Payment
  Import CSV, Qvalent Flat File. The PC1 format from Business Online is no
  longer supported. An option shows each payment as a separate statement
  line.
- No field-level specification for the Deskbank / COL formats was found on
  westpac.co.nz in this session.
- The one published specification found is Westpac Group's PaymentsPlus "New
  Zealand payment import CSV", version 4:
  https://paymentsplus.westpac.com.au/docs/file-formats/new-zealand-payment-import-csv/
  (a corporate payables service; "Qvalent NZ Payment Import CSV" in the list
  above appears to be this format, not confirmed). Every field quoted;
  records H header (customer code from Westpac, customer name, file
  reference, scheduled date DDMMCCYY, currency NZD, version 4), E EFT payment
  (payer reference ≤15, amount with decimal point DDDD.CC up to 9999999.99,
  payee analysis ≤12 required, payee particulars ≤12, bank 2, branch 4,
  account 7, suffix 2, account name ≤20, funding bank/branch/account/suffix),
  optional R remittance and I invoice records, T trailer (payment count, total
  with decimal point). Needs a Westpac customer code, so it isn't a general
  payroll file.

## Kiwibank — internet banking for business batch upload

- URL: https://www.kiwibank.co.nz/business-banking/pay-get-paid/making-payments/bulk-payments/
- Kiwibank says you can export a file from accounting software and upload it
  as a batch payment from Business Edge and Business Performer accounts, but
  no file format specification was found on kiwibank.co.nz in this session.
  Kiwibank doesn't appear to publish one publicly; ask Kiwibank for it.

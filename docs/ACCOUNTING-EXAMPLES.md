# Accounting worked examples

These are the acceptance examples for posting and stock behaviour. Each one
has real numbers and a matching automated test, so "approved" means "a test
proves it". Test names start with the example IDs they cover:

- `tests/unit/decimal.test.ts` (R1, R3), `tests/unit/costing.test.ts`
  (W1-W12, pure costing maths) and `tests/unit/invoice-amounts.test.ts`
  (I1-I6 and B1-B4, pure invoice and bill maths; CP1, CP2 and CP4 paid
  status)
- `tests/integration/ledger.test.ts` (R2, R4, R5, L1-L4, C1-C5, C7, D1, D2,
  P1-P3), `tests/integration/inventory-fx.test.ts` (W1, W2, W7, W8, C6, D3,
  F1-F7), `tests/integration/auth-routes.test.ts` (D1, D2 over HTTP),
  `tests/integration/contacts.test.ts` (D1, D2 for contacts),
  `tests/integration/invoices.test.ts` (I1-I9, D1, D2 for invoices),
  `tests/integration/customer-payments.test.ts` (CP1-CP8),
  `tests/integration/bills.test.ts` (B1-B8, D1, D2 for bills) and
  `tests/integration/supplier-payments.test.ts` (SP1-SP8), all against a real
  PostgreSQL database

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
  `NZD` organisation is refused.

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
- **Negative stock**: always refused. Migrated negative balances aren't
  supported.
- **Late landed cost allocated partly to already-sold stock**: landed cost is
  added to the stock currently on hand only.

## Locked periods

With a lock date of 31 Mar 2026:

- **L1** 1 Apr 2026 posts. (Regression check: an earlier version rejected
  every date once any lock was set, because it compared a Date object with a
  string.)
- **L2** 31 Mar 2026 and 10 Feb 2026 are refused.
- **L3** With an unlock window of 1-28 Feb 2026, 10 Feb 2026 posts and
  15 Jan 2026 is still refused.
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
  only when their balance has the normal sign.

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
  notes come later.
- **Correcting an approved invoice**: it can't be edited, and its journals
  can't be corrected in the ledger. Void it and raise a new one.
- **Foreign-currency invoices**: invoices are in the base currency only.

## Customer payments

A customer payment is money received against one approved sales invoice.
Recording it posts one journal dated the payment date: Dr the bank account the
money went into / Cr accounts receivable (1100). The bank account must be an
active account of type bank. Amounts must be more than zero, with at most
2 decimal places.

An invoice's amount due is its total less its active (not voided) payments.
Its paid status is **unpaid** (nothing paid), **part paid** or **paid**
(nothing due). Both are worked out from the payments every time; they're
never stored or typed in.

- **CP1** INV-0001 for 115.00 (I1). Pay 115.00 into 1000: the journal is
  Dr 1000 115.00 / Cr 1100 115.00, dated the payment date. Amount due
  **0.00**; status **paid**.
- **CP2** The same invoice paid 50.00, then 65.00: amount due **65.00** and
  **part paid** after the first; **0.00** and **paid** after the second.
- **CP3** Paying 115.01 against a 115.00 invoice is refused (no overpayments
  yet). Paying a draft or a voided invoice is refused. Amounts must be more
  than zero with at most 2 decimal places: 0.00, -5.00 and 10.001 are
  refused.
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

- **Overpayments and prepayments**: a payment can't be more than the amount
  due, and it can't be dated before the invoice date (until then accounts
  receivable would be in credit, which is a prepayment).
- **One payment for several invoices**: each payment is against exactly one
  invoice.
- **Foreign-currency bank accounts**: payments go into bank accounts in the
  base currency only.
- **Correcting a payment**: its journals can't be corrected in the ledger.
  Void the payment and record it again. A void can't be dated before the
  payment.

## Bills

A bill is an invoice from a supplier. Bills work like sales invoices the
other way round: the same amounts modes (tax exclusive, tax inclusive or no
tax), the same line maths and the same per-line GST rounding, from the same
code (`src/lib/invoices/amounts.ts`, see "Sales invoices").

- The supplier must be an active contact marked as a supplier. The
  supplier's invoice number is required, and a supplier can't have two bills
  that aren't voided with the same number, ignoring case and spaces.
- Line accounts are active, base-currency accounts of type expense or direct
  costs, or asset accounts, but not bank, accounts receivable, accounts
  payable or GST. Tax codes come from the same list as invoices.
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

### Not supported yet (refused rather than guessed)

- **Paying bills other than one at a time**: supplier payments (see
  "Supplier payments" below) pay one bill each, from a base-currency bank
  account, and have their own list of what isn't supported yet.
- **Negative or zero lines** (discounts, supplier credit notes): the same
  rules as invoices.
- **Correcting an approved bill**: it can't be edited, and its journal can't
  be corrected in the ledger. Void it and enter it again. A void can't be
  dated before the bill.
- **Foreign-currency bills**: bills are in the base currency only, and lines
  can't go to foreign-currency accounts.

## Supplier payments

A supplier payment is money paid against one approved bill. It's the mirror
of a customer payment. Recording it posts one journal dated the payment date:
Dr accounts payable (2000) / Cr the bank account the money came from. The bank
account must be an active, base-currency account of type bank. Amounts must be
more than zero, with at most 2 decimal places.

A bill's amount due is its total less its active (not voided) payments. Its
paid status is **unpaid** (nothing paid), **part paid** or **paid** (nothing
due). Both are worked out from the payments every time; they're never stored
or typed in.

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

- **One payment for several bills**: each payment is against exactly one
  bill.
- **Overpayments and prepayments to suppliers**: a payment can't be more than
  the amount due, and it can't be dated before the bill date.
- **Foreign-currency bank accounts**: payments are made from bank accounts in
  the base currency only.
- **Batch payments and bank files** (e.g. ABA): each payment is recorded on
  its own, and no bank file is made.
- **Correcting a payment**: its journals can't be corrected in the ledger.
  Void the payment and record it again.

## Reports

The financial year ends on the last day of a month chosen in Settings
(default: 31 March, NZ's standard balance date). There are no year-end closing
journals; the balance sheet works profit out when it runs.

- **P1** The trial balance always balances; totals of debits = credits.
- **P2** Balance sheet: assets = liabilities + equity + earnings from previous
  years + current year earnings. With a 31 March year end, a balance sheet at
  31 Dec 2026 counts profit from 1 Apr 2026 as current year earnings. Sales of
  7.00 on 20 Jan and 5.00 on 10 Feb 2026 belong to the year that ended
  31 Mar 2026, so they show as **12.00** of earnings from previous years. With
  a December year end the same sheet shows **0.00** from previous years.
- **P3** Profit and loss: net profit = income - cost of sales + other
  income - expenses. Without a start date it covers the financial year to
  date, and then equals the balance sheet's current year earnings.

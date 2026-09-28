# Accounting worked examples

These are the acceptance examples for posting and stock behaviour. Each one
has real numbers and a matching automated test, so "approved" means "a test
proves it". Test names start with the example IDs they cover:

- `tests/unit/decimal.test.ts` (R1, R3), `tests/unit/costing.test.ts`
  (W1-W12, pure costing maths) and `tests/unit/invoice-amounts.test.ts`
  (I1-I6 and B1-B4, pure invoice and bill maths; CP1, CP2 and CP4 paid
  status; CN2, CN10 credit note maths and CN2-CN4, CN6-CN8 credit and paid
  status) and `tests/unit/gst-return.test.ts` (G1, G2, G5-G9, G11, G12,
  G20, G21, pure GST return maths, periods, shares and basis changes)
- `tests/integration/ledger.test.ts` (R2, R4, R5, L1-L4, C1-C5, C7, D1, D2,
  P1-P3), `tests/integration/inventory-fx.test.ts` (W1, W2, W7, W8, C6, D3,
  F1-F7), `tests/integration/auth-routes.test.ts` (D1, D2 over HTTP),
  `tests/integration/contacts.test.ts` (D1, D2 for contacts),
  `tests/integration/invoices.test.ts` (I1-I9, D1, D2 for invoices),
  `tests/integration/customer-payments.test.ts` (CP1-CP8),
  `tests/integration/customer-overpayments.test.ts` (OP1-OP11),
  `tests/integration/multi-payments.test.ts` (MP1-MP10, SMP1-SMP6),
  `tests/integration/bills.test.ts` (B1-B8, D1, D2 for bills) and
  `tests/integration/supplier-payments.test.ts` (SP1-SP8) and
  `tests/integration/credit-notes.test.ts` (CN1-CN12) and
  `tests/integration/supplier-credit-notes.test.ts` (SCN1-SCN12) and
  `tests/integration/gst-returns.test.ts` (G1-G9) and
  `tests/integration/gst-bases.test.ts` (G10-G22) and
  `tests/integration/record-extras.test.ts` (NF1-NF14) and
  `tests/integration/home.test.ts` (H1-H4) and
  `tests/integration/custom-reports.test.ts` (CR1-CR10), all against a real
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
  the customer with a sales credit note instead (CN1-CN12).
- **Correcting an approved invoice**: it can't be edited, and its journals
  can't be corrected in the ledger. Void it and raise a new one.
- **Foreign-currency invoices**: invoices are in the base currency only.

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
- **Foreign-currency bank accounts**: payments go into bank accounts in the
  base currency only.
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
  account of type bank. A refund can be voided once, which posts the exact
  reversal.
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
- **Foreign-currency** payments and invoices.
- **Correcting an overpayment refund**: its journals can't be corrected in
  the ledger. Void the refund and record it again.

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
- **Negative or zero lines** (e.g. discounts): the same rules as invoices.
  Credit from a supplier is a supplier credit note (SCN1-SCN12).
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
  base-currency account of type bank. A refund can be voided once, which posts
  the exact reversal on the void date.
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
  active, base-currency account of type bank. It posts Dr the bank account /
  Cr 2000 on the refund date (on or after the credit note date). A refund can
  be voided once, which posts the exact reversal on the void date.
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

### Not supported yet (refused rather than guessed)

- **Foreign-currency bank accounts** can't take statement lines.
- **Splitting a journal line** across several statement lines.
- **Older Excel files** (.xls): save them as .xlsx or CSV.

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
  column's period ends in). A budget column comes later, with budgets.
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

### Home

Home shows a card for each bank account, money owed to you, bills to pay and
the next GST return. It's worked out whenever it's opened, posts nothing, and
viewers can see it. "Today" is the date in the business time zone
(Pacific/Auckland unless `TOHYEE_TIME_ZONE` says otherwise).

- **H1** Bank accounts: one card for each active bank or credit card account,
  with its balance in Tohyee (the ledger), its statement balance if any, and
  "Reconcile N items" for its unreconciled statement lines (excluded lines
  don't count), or "All reconciled". Archived accounts aren't shown.
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
  the same length. With Feb-Mar 2026 filed, it's **1 Apr - 31 May 2026**,
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
    left out (no GST to claim).
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

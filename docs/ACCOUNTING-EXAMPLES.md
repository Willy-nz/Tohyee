# Accounting worked examples

These are the acceptance examples for posting and stock behaviour. Each one
has real numbers and a matching automated test, so "approved" means "a test
proves it". Test names start with the example IDs they cover:

- `tests/unit/decimal.test.ts` (R1, R3), `tests/unit/costing.test.ts`
  (W1-W12, pure costing maths) and `tests/unit/invoice-amounts.test.ts`
  (I1-I6 and B1-B4, pure invoice and bill maths; CP1, CP2 and CP4 paid
  status; CN2, CN10 credit note maths and CN2-CN4, CN6-CN8 credit and paid
  status) and `tests/unit/gst-return.test.ts` (G1, G2, G5-G9, pure GST
  return maths and periods)
- `tests/integration/ledger.test.ts` (R2, R4, R5, L1-L4, C1-C5, C7, D1, D2,
  P1-P3), `tests/integration/inventory-fx.test.ts` (W1, W2, W7, W8, C6, D3,
  F1-F7), `tests/integration/auth-routes.test.ts` (D1, D2 over HTTP),
  `tests/integration/contacts.test.ts` (D1, D2 for contacts),
  `tests/integration/invoices.test.ts` (I1-I9, D1, D2 for invoices),
  `tests/integration/customer-payments.test.ts` (CP1-CP8),
  `tests/integration/customer-overpayments.test.ts` (OP1-OP11),
  `tests/integration/bills.test.ts` (B1-B8, D1, D2 for bills) and
  `tests/integration/supplier-payments.test.ts` (SP1-SP8) and
  `tests/integration/credit-notes.test.ts` (CN1-CN12) and
  `tests/integration/supplier-credit-notes.test.ts` (SCN1-SCN12) and
  `tests/integration/gst-returns.test.ts` (G1-G9), all against a real
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
- **One payment for several invoices**: each payment is against exactly one
  invoice.
- **Foreign-currency bank accounts**: payments go into bank accounts in the
  base currency only.
- **Correcting a payment**: its journals can't be corrected in the ledger.
  Void the payment and record it again. A void can't be dated before the
  payment.

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
- **OP9** A GST return for the period with OP1, an application and a refund
  in it has the same boxes and lines as one with only the invoices.
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

Bank feeds come from Akahu (NZ open finance). A server admin sets up the
Akahu app once for the server: its App ID token, and either a personal-app
user token (the admin's own bank logins) or the App secret for Akahu's OAuth
consent flow, where each organisation connects its own banks. Tokens are
stored encrypted with the server's `TOHYEE_SECRET_KEY`. An organisation then
links each Akahu account to one of its bank or credit card accounts, with a
start date for the history to bring in.

- Syncing reads settled transactions only (pending ones wait until they
  settle) from two days before the last line it brought in (lines already
  there are skipped by Akahu's id), or from the start date the first time, as far back as Akahu and the bank allow. Network calls
  happen outside database transactions; each account's lines are then added
  in one transaction.
- Akahu's amount is signed the same way as statement lines (negative is money
  out). Its date is converted to the New Zealand date. Particulars, code,
  reference and the merchant name come across when Akahu has them.
- Accounts sync on a schedule (every 6 hours by default) and on demand. A
  failed sync keeps the error on the account and changes nothing.

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

## GST return

The GST return is New Zealand's GST101A (boxes 5-15), worked out on the
**invoice basis** from approved documents. Nothing is typed in except the
Box 9 and Box 13 adjustments.

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
  refused. An organisation on the payments or hybrid basis is refused with
  "GST returns on the payments and hybrid bases aren't built yet." A
  standard-rated line at a rate other than 15% in the period is refused,
  naming its document.

### Not supported yet (refused rather than guessed)

- **Payments and hybrid bases**: refused with the message in G9; they come
  next.
- **Amending a filed return**: a filed return can't be changed. "Changed since
  filed" shows what's different; correcting it with IRD is done outside
  Tohyee.
- **Imported goods** (GST paid to Customs): there's nowhere to record it yet.
- **Recording the GST payment or refund to IRD**: filing posts no journal.
- **Filing to IRD electronically**: "Mark as filed" records that you filed the
  return yourself (through myIR), with the figures it had at the time.
- **Other GST rates**: standard-rated lines must be at 15%.

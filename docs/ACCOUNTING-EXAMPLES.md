# Accounting worked examples

These are the acceptance examples for posting and stock behaviour. Each one
has real numbers and a matching automated test, so "approved" means "a test
proves it". Test names start with the example IDs they cover:

- `tests/unit/decimal.test.ts` (R1, R3), `tests/unit/costing.test.ts`
  (W1-W12 and ST10, ST11, pure costing maths) and `tests/unit/invoice-amounts.test.ts`
  (I1-I6 and B1-B4, pure invoice and bill maths; CP1, CP2 and CP4 paid
  status; CN2, CN10 credit note maths and CN2-CN4, CN6-CN8 credit and paid
  status) and `tests/unit/gst-return.test.ts` (G1, G2, G5-G9, G11, G12,
  G20, G21, pure GST return maths, periods, shares and basis changes) and
  `tests/unit/item-pricing.test.ts` (IT2, IT4-IT6, pure item price and
  unit maths)
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
  `tests/integration/custom-reports.test.ts` (CR1-CR10) and
  `tests/integration/tracking.test.ts` (TC1-TC10) and
  `tests/integration/custom-fields.test.ts` (CS1-CS3, CF1-CF10) and
  `tests/integration/salespeople.test.ts` (SR1-SR8) and
  `tests/integration/customers.test.ts` (RC1-RC12) and
  `tests/integration/items.test.ts` (IT1-IT9) and
  `tests/integration/stock.test.ts` (ST1-ST12) and
  `tests/integration/crm.test.ts` (MOD1, CRM1-CRM9) and
  `tests/integration/crm-mail.test.ts` (MAIL1-MAIL9) and
  `tests/integration/reports-ledger.test.ts` (AGP1-AGP3, ATX1-ATX5,
  JR1-JR3) and `tests/integration/gst-audit.test.ts` (GA1-GA4) and
  `tests/integration/customer-statements.test.ts` (CST1-CST5) and
  `tests/integration/quotes.test.ts` (QT1-QT8) and
  `tests/integration/repeating-invoices.test.ts` (RI1-RI10) and
  `tests/integration/printed-documents.test.ts` (PD1-PD8) and
  `tests/integration/purchase-orders.test.ts` (PO1-PO9) and
  `tests/integration/stock-transfers.test.ts` (TR1-TR6) and
  `tests/integration/budgets.test.ts` (BU1-BU8) and
  `tests/integration/expense-claims.test.ts` (EC1-EC12) and
  `tests/integration/fixed-assets.test.ts` (FA1-FA14) and
  `tests/integration/projects.test.ts` (PJ1-PJ13) and
  `tests/integration/bank-quick.test.ts` (BK17-BK25) and
  `tests/integration/bank-split.test.ts` (BK26-BK28) and
  `tests/integration/bank-foreign.test.ts` (FXB1-FXB11) and
  `tests/integration/import.test.ts` (IM1-IM16), all against
  a real PostgreSQL database; `tests/unit/ageing.test.ts` has the pure
  ageing maths (AGP1, CST1), `tests/unit/repeating-schedule.test.ts` the
  repeating dates (RI1, RI5, RI6) and `tests/unit/tax-invoice.test.ts` what
  a printed document is headed and shows (QT5, PD3-PD7), and
  `tests/unit/fixed-asset-depreciation.test.ts` the depreciation and
  disposal maths (FA3, FA4, FA6-FA10), and `tests/unit/project-amounts.test.ts`
  the project time and markup maths (PJ3-PJ7), and
  `tests/unit/foreign-currency.test.ts` the conversion, carrying value,
  rate and file currency pieces of FXB2-FXB10, and
  `tests/unit/import-fields.test.ts` the import column matching (IM2-IM5, IM16)

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
  `NZD` organisation is refused. (Lines on foreign-currency accounts carry
  their foreign amount as well: FXB1-FXB11.)

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
- **Negative stock**: refused unless the organisation allows it (ST9-ST12).
- **Late landed cost allocated partly to already-sold stock**: landed cost is
  added to the stock currently on hand only.

## Stock tracking (items on documents)

Approved by the owner (30 Sep 2026) as ST1-ST12. Stock items (IT1) on bills,
invoices and credit notes move stock, costed at weighted average (W1-W12),
in the same transaction as the document's journal. GST 15%. Accounts: 1100
accounts receivable, 1400 inventory, 2000 accounts payable, 2100 GST, 4000
sales, 5000 cost of goods sold.

- **Per location**: the weighted average is kept per item and **location**.
  A location is a value of the Location tracking category (TC1); a stock
  line's location is its Location tag. Once the Location category has any
  values, every stock line needs one to be approved; until then (or in an
  organisation that never uses locations) each item has **one default
  pool**. Stock entered on the Stock screen can name a location too.
- **Stock lines on bills and supplier credit notes** go to the inventory
  account (1400), and nothing else can: a stock item on another account, or
  a non-stock line on 1400, is refused, and so are manual journals and
  corrections that touch 1400, and stock movements to any other account. So
  stock always equals account 1400 to the cent.
- **Cost of sales** is posted when the invoice is approved, dated the
  invoice date (there are no sales orders or fulfilment yet), in the
  invoice's own journal: Dr 5000 / Cr 1400, the 5000 line tagged like the
  invoice line.
- **Units** (IT5): stock is kept in the item's base unit. **Kits** (IT7):
  selling a kit takes each stock item in it out of stock; its income goes to
  the kit's income account.
- **Voiding** puts stock back exactly: an invoice's stock comes back at the
  value it went out at, and a bill's goes back out at the value it came in
  at. A bill (or sales credit note) whose stock has moved since can't be
  voided yet (that needs re-costing later movements). Backdating is refused
  as before.
- **Negative stock** is a setting per organisation, **off** by default.

| ID | What happens | Journal |
| --- | --- | --- |
| ST1 | Bill: 10 Widgets @ 5.00 + GST into Dunedin | Dr 1400 **50.00** / Dr 2100 **7.50** / Cr 2000 **57.50**. Dunedin holds 10 worth **50.00** |
| ST2 | After ST1, invoice: 4 Widgets @ 12.00 + GST from Dunedin | Dr 1100 **55.20** / Cr 4000 **48.00** / Cr 2100 **7.20**, and Dr 5000 **20.00** / Cr 1400 **20.00**, all on the invoice date. Dunedin: 6 worth 30.00 |
| ST3 | Dunedin 10 @ 5.00 and Auckland 10 @ 7.00; invoice 1 Widget @ 12.00 from Auckland | Cost of sales **7.00** (not 6.00): Dr 5000 7.00 / Cr 1400 7.00. Auckland 9 worth 63.00; Dunedin unchanged |
| ST4 | Void ST2's invoice | Dr 4000 48.00 / Dr 2100 7.20 / Cr 1100 55.20 and Dr 1400 **20.00** / Cr 5000 **20.00** on the void date. Dunedin back to 10 worth 50.00 |
| ST5 | After ST2, bill 6 more @ 8.00 (Dunedin 12 worth 78.00, average 6.50); credit note returning 1 of ST2's 4, from that invoice, @ 12.00 + GST | Dr 4000 12.00 / Dr 2100 1.80 / Cr 1100 13.80 and Dr 1400 **5.00** / Cr 5000 **5.00** (the original 5.00, not 6.50). Dunedin 13 worth 83.00. Returning 4 more from that invoice is refused (only 3 left); the invoice can't be voided until the credit note is; voiding the credit note takes the unit out again at 5.00 |
| ST6 | Invoice and bill lines for a service and a non-stock item | No 1400 or 5000 lines; no stock moves |
| ST7 | Widget has "Box of 12"; after a bill of 30 each @ 5.00, invoice 2 Box of 12 | 24 each leave stock: Dr 5000 **120.00** / Cr 1400 **120.00**; 6 left worth 30.00 |
| ST8 | Gift set = 1 Widget + 2 Candles (Widget 5.00, Candle 2.00 each on hand); invoice 1 Gift set @ 30.00 + GST | Dr 1100 34.50 / Cr 4100 **30.00** (the kit's income account) / Cr 2100 4.50, and Dr 5000 **9.00** / Cr 1400 **9.00**; 1 Widget and 2 Candles leave stock |
| ST9 | Negative stock off; 2 on hand; invoice 3 | Approval **refused** ("Stock can't go negative"); the draft stays a draft and no number is used |
| ST10 | Negative stock on; 2 on hand worth 10.00; invoice 3, then bill 4 @ 6.00 | Invoice: Dr 5000 **15.00** / Cr 1400 **15.00**, leaving **-1 worth -5.00**. Bill: Dr 1400 24.00 / Dr 2100 3.60 / Cr 2000 27.60 and Dr 5000 **1.00** / Cr 1400 **1.00** on the bill date, leaving **3 worth 18.00** |
| ST11 | Negative stock on; item never received here, purchase price 4.00; invoice 2 | Costed at 4.00: Dr 5000 **8.00** / Cr 1400 **8.00**, leaving -2 worth -8.00. With no purchase price it's **refused** ("no cost to use for it") |
| ST12 | After ST10's invoice (before the bill) turn negative stock off | **Refused** while anything is below zero; allowed once the bill has brought it back to 3 |

- **ST10 rule**: stock coming in while below zero first fills the shortfall;
  the filled units' share of what came in, less the value they went out at,
  goes to cost of sales on the receipt's date. If it doesn't fill the whole
  shortfall, the stock value moves by the issued value of the units filled
  and the rest goes to cost of sales. With nothing on hand, stock going out
  is costed at the last cost it came in at there, else the item's purchase
  price (ST11); already below zero, at the current average.
- **Supplier credit notes** returning stock take it out at the location's
  average (W's supplier return); the line's net amount is credited to 1400,
  and any difference between it and the stock's value goes to cost of
  sales. After ST5 (the credit note voided, Dunedin 12 worth 78.00), a
  supplier credit note for 2 Widgets @ 8.00 + GST posts Dr 2000 **18.40** /
  Cr 1400 **16.00** / Cr 2100 **2.40**, and Dr 1400 **3.00** / Cr 5000
  **3.00** (they were carried at 6.50 each), leaving 10 worth 65.00.
- **Transfers between locations**: see "Stock transfers between locations"
  (TR1-TR6, not yet approved by Jess).
- **Stock equals the ledger**: across ST1-ST11 the stock report's total
  equals account 1400 on the trial balance, to the cent (tested).

### Not supported yet (refused rather than guessed)

- **Voiding a bill or sales credit note whose stock has moved since**:
  refused (it needs later movements re-costed).
- **Credit notes returning stock without the invoice it was sold on**:
  refused; the credit note names the invoice (to restock at the sale's
  cost). A price adjustment is a line without the item.
- **Returning a kit on a credit note**: its parts come back at their sale's
  cost, from the same invoice.
- **Bins, lots and serial numbers, assemblies**, and receiving stock without
  a bill (use a stock movement).

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

Since foreign-currency lines keep their foreign amount (FXB1-FXB11), the
USD 1,000.00 is in the ledger too (the journal booking it gives USD 1,000.00
at 1.6), so it needn't be typed; typing it is still allowed if it agrees,
and it's still typed for accounts with postings from before (FXB7).

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
- Tax codes: every organisation starts with the standard NZ codes, like
  Xero: **GST** "GST (15%)" (standard, 0.15), **ZERO** "Zero rated"
  (zero rated, 0), **EXEMPT** "Exempt" (exempt, 0) and **NONE** "No GST"
  (out of scope, 0), all in effect from **1 Oct 2010** (when GST became
  15%). So a document dated 30 Sep 2010 with GST is refused ("isn't in
  effect"). Organisations made before this change that had no tax codes at
  all were given the same four (migration 0031); one that already had any
  codes was left alone (`tests/integration/provisioning.test.ts`). The
  examples in this document use these seeded codes.

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
  payable or GST. The inventory account (1400) takes only stock item lines,
  and stock item lines only go there (ST1). Tax codes come from the same list
  as invoices.
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

### One-click matching ("OK") (examples not yet approved by Jess)

Like Xero's "OK" button. For each unreconciled line, Tohyee looks for
**candidates with the line's exact amount**:

- a posted journal line on the line's account, on the same side (money in is
  a debit), not reconciled, dated within 60 days of the line, and not a
  reversal or reversed (a voided payment's lines never count); and
- for money in, an approved invoice whose amount due is exactly the line's
  amount; for money out, an approved bill whose amount due is exactly the
  line's amount (without its minus sign). The invoice or bill must be dated on
  or before the line, since a payment can't be dated before it.

The suggestion is **confident**, and shown highlighted with an **OK** button,
when the line has exactly one candidate and no other unreconciled line on the
same account has that candidate too. When a line has no candidates at all, a
bank rule that applies (BK10) is a confident suggestion. Anything else shows
no OK button: two or more candidates (a tie) are listed on the line to choose
from, and two lines competing for one candidate are left for a person to
decide. OK posts exactly what choosing the suggestion by hand posts (BK4, BK5,
BK10), through the same reconcile command.

- **BK17** After BK1: the +115.00 line has one candidate, INV-0001 (115.00
  due, dated 10 May): confident, "Pay INV-0001". The -46.00 line has no
  candidates and no rule: no suggestion; with the BK10 rule it's confident
  (spend money to Z Energy, 6120). The -500.00 line has none. Then:
  - a second approved invoice to Kobe Ltd for 115.00 (INV-0002, 12 May) makes
    the +115.00 line a **tie** (2 candidates): no OK;
  - instead, a second +115.00 line on 25 May makes both lines **compete** for
    INV-0001: neither has an OK;
  - a customer payment of 115.00 into 1000 on 19 May (INV-0001 is then paid)
    makes the payment's journal line the one candidate: confident "match";
    once that payment is voided it's no longer a candidate;
  - with the BK10 rule, a spend money of 46.00 to Z Energy already posted on
    21 May wins over the rule: the suggestion is to match it, so nothing is
    posted twice;
  - an invoice for 115.00 dated 21 May (after the 20 May line) is not a
    candidate.
- **BK18** OK on the +115.00 line, shown as "Pay INV-0001", records a
  customer payment of 115.00 dated 20 May into 1000 (Dr 1000 115.00 / Cr 1100
  115.00) and reconciles the line; INV-0001 is paid. OK on the -46.00 line
  with the BK10 rule posts Dr 6120 40.00 / Dr 2100 6.00 / Cr 1000 46.00. If
  the suggestion shown has changed (e.g. INV-0001 was paid meanwhile), OK is
  refused (409) and nothing is posted. Retrying with the same key returns the
  same reconciled line. Viewers can't OK (403).
- **BK19** "OK all confident matches" on 1000 after BK1 with the BK10 rule and
  the period locked up to 20 May: the -46.00 line is reconciled (succeeded);
  the +115.00 line is refused with "2026-05-20 is in a locked period (locked
  up to 2026-05-20)…" (failed); the -500.00 line isn't included (not
  confident). The result is **1 succeeded, 1 failed**, each line in its own
  transaction, so the failure doesn't undo the success. Retrying the same
  request returns the -46.00 line as already done and posts nothing more.

### Bank reconciliation report (examples not yet approved by Jess)

For one bank or credit card account as at a date (Reporting › Bank
reconciliation, also linked from the account). It posts nothing.

- **Balance in Tohyee**: the account's journal lines dated on or before the
  date (debits less credits).
- **In the bank, not yet in Tohyee**: unreconciled statement lines dated on
  or before the date, plus any part of a reconciled line (dated on or before
  it) that was matched to a journal line dated after it.
- **In Tohyee, not yet on the statement**: the account's journal lines dated
  on or before the date that aren't reconciled to a statement line dated on
  or before it (unpresented payments, deposits not yet cleared). A payment
  reconciled to a line after the date is still listed, with that line's date.
  A payment or bank transaction voided on or before the date isn't listed
  when neither it nor its reversal is reconciled, since the two cancel out.
- **Statement balance these explain** = balance in Tohyee + in the bank not
  in Tohyee - in Tohyee not on the statement.
- **Statement balance**: Tohyee doesn't store a statement's closing balance,
  so it's worked out from the latest of (a) the bank's running balance on the
  latest statement line (not deleted) dated on or before the date that has
  one, the last brought in that day, taken as that day's closing balance, and
  (b) the bank feed's balance (BK16), as at the end of the New Zealand day it
  was fetched, if that's on or before the date; plus the unreconciled and
  reconciled lines dated after it up to the date. With neither it's **not
  known**. Excluded lines are never added (they're duplicates or not the
  organisation's), though an excluded line's running balance still counts,
  since it's the bank's figure.
- **Not explained** = statement balance - the balance the items explain. The
  report says "Fully explained" only when that's 0.00.

Setup as above, with this statement imported into 1000 (it has the bank's
running balance):

```
Date,Amount,Payee,Particulars,Code,Reference,Balance
01/05/2026,1000.00,J KELLY,CAPITAL,,,1000.00
20/05/2026,115.00,KOBE LTD,INV-0001,,,1115.00
21/05/2026,-46.00,Z ENERGY,,,,1069.00
28/05/2026,-12.00,MONTHLY FEE,,,,1057.00
02/06/2026,-230.00,KAURI SUPPLIES,K-100,,,827.00
```

In Tohyee: a manual journal on 1 May, Dr 1000 1,000.00 / Cr 3000 1,000.00,
matched to the 1 May line; INV-0001 paid from the 20 May line (BK5); the
BK6 spend money from the 21 May line; a supplier payment of B1, 230.00 on
30 May from 1000, matched to the 2 June line; and receive money of 57.50
from Kobe Ltd on 31 May (4000, GST inclusive), not reconciled. The 28 May fee
isn't reconciled.

- **BK20** As at 31 May 2026: balance in Tohyee **896.50** (1,000.00 +
  115.00 - 46.00 - 230.00 + 57.50). In the bank, not in Tohyee: 28 May
  MONTHLY FEE **-12.00**. In Tohyee, not on the statement: the 30 May
  supplier payment **-230.00** (on the statement 2 June) and the 31 May
  receive money **57.50**, total **-172.50**. Explained: 896.50 - 12.00 +
  172.50 = **1,057.00**. Statement balance **1,057.00**, the running balance
  on the 28 May line: fully explained. As at 30 June 2026: statement
  **827.00** (the 2 June line), Tohyee 896.50, in the bank -12.00, in Tohyee
  57.50: 896.50 - 12.00 - 57.50 = 827.00, fully explained. As at 25 May:
  statement and Tohyee both **1,069.00**, no items. A spend money of 20.00
  (6120, no GST) on 29 May, voided on 30 May, changes nothing as at 31 May
  (neither it nor the reversal is listed); as at 29 May it's listed: Tohyee
  **1,049.00**, in the bank -12.00, in Tohyee -20.00, 1,049.00 - 12.00 +
  20.00 = **1,057.00**, fully explained.
- **BK21** Where the statement balance comes from:
  - Only BK1's file (no running balances) and no bank feed: as at 31 May the
    statement balance is **not known**; the items (115.00, -46.00, -500.00,
    total -431.00) still show, explaining a statement balance of
    **-431.00**, and the report doesn't say "Fully explained".
  - The same with a bank feed balance of **69.00** fetched at 10:00 on
    21 May (New Zealand time): as at 31 May the statement balance is 69.00
    plus the one line after 21 May (-500.00) = **-431.00**, fully explained.
    As at 20 May the feed balance is later than the date, so the balance is
    not known.
  - In BK20, excluding the 28 May fee line (as if it were a duplicate): as at
    31 May the items explain **1,069.00** but the statement balance is still
    1,057.00, so **-12.00 is not explained** and the report says so.

### Bulk coding ("cash coding") (examples not yet approved by Jess)

Like Xero's cash coding. On one bank or credit card account, tick several
unreconciled lines and give them an account, a GST code (or no GST), and
optionally a contact, a description and tracking, either for all the ticked
lines at once or line by line (a line's own value wins). Saving does each line
exactly as if it were reconciled on its own as a bank transaction (BK6, BK7):
spend money for money out, receive money for money in, for the line's full
amount, dated the line date, one line to the chosen account, reconciled to
the statement line.

- With a GST code the line's amount includes GST (tax inclusive); with none
  there's no GST.
- With no contact chosen, the line's contact is the active contact whose
  name is the line's payee (or, with no payee, its description), ignoring
  case and extra spaces. With no such contact the line is refused.
- With no description, each transaction line is described as the statement
  line is.
- Each line is done in its own database transaction, so a line that's refused
  (a locked period, no account, no contact, already reconciled, on another
  account) doesn't stop the others. The result lists every line with what
  happened or why it was refused.
- Retrying the same request (same idempotency key) returns the lines already
  done without posting them again; the same key with different content is
  refused for those lines (409).

Setup as above, plus the contact ANZ, and this statement imported into 1000:

```
Date,Amount,Payee,Particulars,Code,Reference
21/05/2026,-46.00,Z ENERGY,,,
24/05/2026,-11.50,Z ENERGY,,,
26/05/2026,-69.00,Z ENERGY,,,
28/05/2026,-12.00,MONTHLY FEE,,,
```

- **BK22** Tick the three Z ENERGY lines and the MONTHLY FEE line. For all:
  6120 Motor vehicle expenses, GST, no contact, description "Fuel". For the
  MONTHLY FEE line only: 6020 Bank fees, no GST, contact ANZ, description
  "Account fee". Saving posts four spend money transactions, each reconciled
  to its line (4 succeeded, 0 failed):
  - 21 May, Z Energy, Fuel: Dr 6120 40.00 / Dr 2100 6.00 / Cr 1000 46.00;
  - 24 May, Z Energy, Fuel: Dr 6120 10.00 / Dr 2100 1.50 / Cr 1000 11.50;
  - 26 May, Z Energy, Fuel: Dr 6120 60.00 / Dr 2100 9.00 / Cr 1000 69.00;
  - 28 May, ANZ, Account fee: Dr 6020 12.00 / Cr 1000 12.00.

  They add **126.50** to the May GST return's Box 11 and **16.50** to its
  purchases GST, as four separate BK6s would. 1000's "reconcile" count is
  **0**.
- **BK23** One bad line doesn't stop the others. With the period locked up
  to 21 May, tick all four lines with 6120, GST and no contact for all:
  - 21 May: refused, "2026-05-21 is in a locked period (locked up to
    2026-05-21)…";
  - 24 May and 26 May: spend money as in BK22 (described "Z ENERGY", the
    line's own description), reconciled;
  - 28 May: refused, "No contact was chosen, and there's no contact called
    “MONTHLY FEE”…".

  The result is **2 succeeded, 2 failed**, and exactly 2 journals are
  posted. Retrying the same request posts nothing more: the 24 and 26 May
  lines come back as already done, the other two are refused again. The same
  key with 6130 instead of 6120 is refused (409) for the 24 and 26 May lines.
  After unlocking, a new request for the 21 May line (6120, GST, no
  contact) and the 28 May line (6020, no GST, contact ANZ) reconciles both.
  A line with no account, for all or its own, is refused with "Choose an
  account for this line"; a line on another account or already reconciled is
  refused; viewers can't cash code (403).

### Small differences when matching (examples not yet approved by Jess)

Like Xero's adjustment. When matching a line (BK4) or paying invoices or
bills from it (BK5) and the amounts differ slightly (a merchant fee taken
off a deposit, a customer rounding up), the difference can be recorded in
the same step as an **adjustment** to an account the person chooses, with an
optional GST code. There's no limit on the difference, but the account must
be chosen.

- The adjustment is a bank transaction (BK6, BK7) for the difference: spend
  money when the line is less than what it's matched with (money in) or more
  than it (money out), otherwise receive money; dated the line date, one line
  to the chosen account, tax inclusive with a GST code or no GST without one,
  described as given ("Adjustment" if not). Its contact is the one chosen, or
  when paying, the first invoice's or bill's contact; when matching, a
  contact must be chosen.
- Payments are recorded for the amounts given (usually the full amount due),
  not the line's amount. The line is reconciled to the payments or matched
  journal lines **and** the adjustment, which together add up to it exactly.
- It all happens in one database transaction with the reconciliation: if
  anything is refused (a locked period, no account), nothing is posted.
- Unreconciling (BK11) leaves the payment and the adjustment; void them
  separately. The adjustment counts in the GST return like any bank
  transaction.

Setup as above (INV-0001 115.00 due, B1 230.00 due, both 10 May 2026).

- **BK24** Recording a difference:
  - A **+113.50** line on 20 May (INV-0001 less a 1.50 merchant fee). Pay
    INV-0001 **115.00** with an adjustment to 6020 Bank fees, no GST,
    "Merchant fee": a customer payment of 115.00 dated 20 May (Dr 1000
    115.00 / Cr 1100 115.00) and spend money to Kobe Ltd dated 20 May (Dr
    6020 1.50 / Cr 1000 1.50). The line is reconciled to both (115.00 -
    1.50 = 113.50). INV-0001 is **paid**, amount due **0.00**. The spend
    money is in no GST box.
  - A **+115.50** line on 20 May instead (the customer paid 0.50 over). Pay
    INV-0001 **115.00** with an adjustment to 4100 Other revenue, GST:
    receive money from Kobe Ltd of 0.50, GST inclusive: Dr 1000 0.50 / Cr
    4100 0.43 / Cr 2100 0.07. It adds **0.50** to Box 5. INV-0001 is paid
    with no overpayment.
  - A **-231.50** line on 21 May (B1 plus a 1.50 payment fee). Pay B1
    **230.00** with an adjustment to 6020, no GST: a supplier payment (Dr
    2000 230.00 / Cr 1000 230.00) and spend money to Kauri Supplies (Dr 6020
    1.50 / Cr 1000 1.50). B1 is paid.
  - Matching: a customer payment of 115.00 into 1000 on 19 May is already
    recorded. The +113.50 line on 20 May is matched to it with an adjustment
    to 6020, no GST, contact Kobe Ltd: only the spend money (Dr 6020 1.50 /
    Cr 1000 1.50) is posted, and the line is reconciled to the payment and
    the spend money.
- **BK25** What's refused, with nothing posted:
  - an adjustment with no account: "Choose the account for the 1.50
    difference.";
  - matching with an adjustment and no contact: "Choose a contact for the
    1.50 adjustment.";
  - an adjustment when the amounts already add up to the line: "…already
    add up to the line, so there's no difference for an adjustment.";
  - an adjustment with a bank transaction or a transfer;
  - an adjustment to 1100 Accounts receivable (as for any bank transaction);
  - with the period locked up to 20 May, paying INV-0001 from the +113.50
    line with an adjustment: refused, and neither the payment nor the
    adjustment is posted.

  Retrying the BK24 payment with an adjustment with the same key returns
  the reconciled line and posts nothing more; the same key with another
  account is refused (409). Unreconciling it leaves the payment and the
  spend money; after that the spend money can be voided on its own.

### One transaction on several statement lines (examples not yet approved by Jess)

Sometimes the bank shows one payment or deposit as two or more lines (a
customer's payment split into two transfers, a deposit the bank credited in
parts). **Splitting** reconciles several statement lines together against
**one** posted journal line on the account. (The other way round, one
statement line for several posted transactions, such as a deposit of several
cheques, is ordinary matching, BK4.)

- The lines must be unreconciled, on the same account, all money in or all
  money out, each dated within 60 days of the journal line, and add up to it
  **exactly**. The journal line must not be reconciled already. Nothing is
  posted.
- Each line is reconciled to **its part** of the journal line (its own
  amount). The lines stay tied together: unreconciling any one of them
  unreconciles all of them, posting nothing, and is refused if any of them
  is in a locked period.
- There's **no adjustment** (BK24) when splitting: if the lines don't add up
  to the transaction exactly, it's refused. Record the difference as its own
  bank transaction first, or match instead.
- One-click OK (BK17) never suggests a split: a line that's only part of a
  transaction has no candidate with its exact amount, so it's never
  confident, and a journal line in a split is no longer a candidate for
  anything. Bulk coding (BK22) refuses a line in a split as already
  reconciled.

Setup as above, plus receive money of **300.00** from Kobe Ltd on 20 May,
4000 Sales, no GST: Dr 1000 300.00 / Cr 4000 300.00 (journal line **J**
on 1000), and this statement imported into 1000:

```
Date,Amount,Payee,Particulars,Code,Reference,Balance
20/05/2026,200.00,KOBE LTD,PART 1,,,200.00
03/06/2026,100.00,KOBE LTD,PART 2,,,300.00
```

- **BK26** Splitting J across the 20 May +200.00 line and the 3 June
  +100.00 line posts nothing and reconciles both lines: the 20 May line to
  **200.00** of J and the 3 June line to **100.00** of J, each showing the
  split (J's 300.00 and both lines). 1000's "reconcile" count is **0**.
  The receive money can't be voided while they're reconciled ("unreconcile
  it first"). Retrying with the same idempotency key returns the same
  result and posts nothing; the same key with a different journal line is
  refused (409).
- **BK27** Refused, with nothing reconciled:
  - lines of +200.00 and +50.00 against J: "The chosen statement lines add
    up to 250.00, but the transaction is 300.00. They must add up to it
    exactly.";
  - only one line: "Choose at least two statement lines…" (match it
    instead);
  - a money-in line with a money-out line: "…all money in or all money
    out.";
  - a line on 1010, or one already reconciled, or J already reconciled;
  - a line dated more than 60 days from J;
  - with an adjustment: "An adjustment isn't available when splitting…";
  - with the period locked up to 20 May: refused ("2026-05-20 is in a
    locked period…"), and the 3 June line isn't reconciled either.
- **BK28** After BK26:
  - **Unreconciling** the 3 June line unreconciles the 20 May line too:
    both are unreconciled, nothing is posted, the receive money stays and
    can then be voided. With the period locked up to 20 May, unreconciling
    the 3 June line is refused (the 20 May line is in the locked period)
    and both stay reconciled. Retrying with the same key returns the same
    result.
  - **One-click OK**: with both lines unreconciled and J posted, neither
    line has a candidate (neither is 300.00), so neither is confident.
    After BK26, a new +300.00 line on 25 May has no candidate either (J is
    reconciled).
  - **Bulk coding** the 20 May line after BK26 is refused: "This line is
    already reconciled."
  - **Bank reconciliation report** (BK20) as at 31 May: balance in Tohyee
    **300.00**; in the bank, not in Tohyee: nothing; in Tohyee, not on the
    statement: the **100.00** of J that's on the 3 June line (shown with
    that date). Explained: 300.00 - 100.00 = **200.00**, the running balance
    on the 20 May line: fully explained. As at 30 June: nothing outstanding,
    statement and Tohyee both **300.00**. If J were dated 2 June instead (and
    the lines 30 May and 3 June), as at 31 May the 30 May line's **200.00**
    is in the bank, not in Tohyee (matched to a journal dated after the
    date).

### Foreign-currency bank accounts (examples not yet approved by Jess)

A bank or credit card account can be in a foreign currency (its currency in
the chart of accounts, e.g. USD). Following NetSuite, which keeps every
transaction in both currencies:

- **Every journal line on a foreign-currency account has both amounts**: the
  foreign amount, the NZD (base) amount and the exchange rate (NZD per 1
  unit of the foreign currency). The foreign amount is on the same side as
  the NZD amount (a debit of NZD 1,654.30 is a debit of USD 1,000.00). The
  database refuses a line on a foreign-currency account without a foreign
  amount in that currency, and a foreign amount on an NZD account. Lines
  posted before Tohyee kept foreign amounts keep only their NZD amount.
- **Rates** have up to 8 decimal places. NZD amount = foreign amount x rate,
  worked out with the full rate and rounded once to cents, half away from
  zero (R3). The database checks this for every line posted at a rate.
- An account's **foreign balance** is its opening foreign balance (below),
  if any, plus its lines' foreign amounts (debits less credits); its **NZD
  balance** is the usual ledger balance. Statement lines, matching and the
  bank reconciliation report use the foreign balance and foreign amounts;
  NZD is shown beside them.
- **Opening foreign balance.** An account that already has NZD-only
  postings needs its foreign balance entered **once**, as at a date on or
  after its last NZD-only posting, before it can take statement lines or
  new postings. It records that the NZD balance at that date is that many
  units of foreign currency; it posts nothing. Afterwards nothing can be
  posted to the account dated on or before that date. The foreign balance
  must have the same sign as the NZD balance (both zero, both money in the
  account, or both owed). Accounts with no postings don't need one.
- **The rate shown on a statement line** is the last rate used for its
  currency on or before the line's date: the latest of a rate a posted line
  in that currency was converted at (spend or receive money, a transfer
  into a foreign account, a manual journal) and a revaluation's closing rate
  for that currency (by date; on the same date, the one entered last). The
  line shows its NZD value at that rate. It's filled in and can be changed.
  With no such rate, the rate must be typed. Rates of money leaving at its
  carrying value (transfers out) aren't market rates and aren't used.
- **Spend and receive money** on a foreign account are in the account's
  currency, converted at the rate given (or the one shown). Only zero-rated
  (ZERO), exempt (EXEMPT) and no-GST (NONE) codes, or no tax code, can be
  used: standard-rated GST on foreign-currency transactions isn't supported
  yet. Several lines are allowed when each line's NZD amount (rounded on its
  own) adds up to the NZD amount of the total; otherwise it's refused. In the
  GST return and project costs they count at their NZD amounts.
- **Transfers** between an NZD account and a foreign account: the NZD side is
  what really moved, so it's given in NZD and in the foreign currency.
  - **Out of a foreign account**: the foreign amount leaves at its **carrying
    value** = the account's NZD balance x foreign amount / foreign balance, on
    the transfer date, rounded once to cents; taking everything left takes
    the whole remaining NZD balance (the weighted-average stock approach,
    W1-W4). The NZD account gets the NZD received, and the difference goes to
    **7020 Realised currency gains and losses** (a gain is a credit). A
    transfer out can't take more than the foreign balance.
  - **Into a foreign account**: booked at the NZD that left; the rate stored
    is NZD / foreign amount (8 decimal places, for information).
  - Nothing but a revaluation can be posted to a foreign account dated
    before its latest transfer out (its carrying value would change); post
    in date order.
    Transfers between two foreign-currency accounts aren't supported yet.
- **Revaluation** (F1-F7) of an account whose foreign balance is known uses
  it; typing a different foreign balance is refused. Its lines on the account
  have a foreign amount of 0.00 (only the NZD value changes) at the closing
  rate. Accounts without a known foreign balance still have it typed.
- **Imports** record each line's currency: the file's, when it says (OFX
  CURDEF, CAMT.053 Ccy, MT940 balances, a CSV or Excel currency column),
  otherwise the account's. A file in another currency is refused. **Akahu
  bank feeds can't be linked to foreign-currency accounts**: Akahu's
  transactions don't say their currency.
- **Invoices and bills are in NZD**, so paying them from a foreign-currency
  statement line is refused, and one-click OK never suggests them for one.
  Adjustments (BK24) aren't available on foreign-currency lines yet.

Setup as above, plus 1030 **USD account** (bank, USD), the customer Etsy and
the supplier Amazon Web Services. 1030 was set to USD before Tohyee kept
foreign amounts, and has one posting from then: a manual journal on 1 Jun
2026, Dr 1030 1,600.00 / Cr 3000 1,600.00 (USD 1,000.00 received, but only the
NZD was kept). This statement is imported into 1030 (after FXB1):

```
Date,Amount,Payee,Particulars,Code,Reference,Balance
03/07/2026,1000.00,ETSY PAYMENTS,,,,2000.00
05/07/2026,-50.00,AMAZON WEB SERVICES,,,,1950.00
10/07/2026,-500.00,TRANSFER TO NZD,,,,1450.00
20/07/2026,610.00,TRANSFER FROM NZD,,,,2060.00
05/08/2026,-2060.00,TRANSFER TO NZD,,,,0.00
```

- **FXB1** Opening foreign balance. Before it's entered, importing that file
  into 1030, or posting to 1030, is refused: "Account 1030 (USD account) has
  postings from before Tohyee kept foreign amounts. Enter its USD balance as
  at a date (its opening foreign balance) first." Entering **USD 1,000.00 as
  at 30 Jun 2026** records USD 1,000.00 = NZD **1,600.00** (1030's NZD balance
  on 30 Jun) and posts nothing; the trial balance doesn't change. 1030's
  balance is then USD 1,000.00 / NZD 1,600.00. Refused: a second opening
  balance for 1030; one dated before 1 Jun (before its last NZD-only
  posting); USD -1,000.00 (the other sign); one for 1000 (an NZD account) or
  for a USD account with no postings ("doesn't need one"); and afterwards, a
  manual journal on 1030 dated 30 Jun 2026 or earlier. Retrying with the
  same idempotency key returns the same opening balance.
- **FXB2** Receive USD 1,000.00 at 1.6543. The 3 Jul line (+1,000.00) shows no
  rate (none has been used for USD yet), so one must be typed; without it
  it's refused ("Type the exchange rate…"). Receive money from Etsy, 4000
  Sales, ZERO, at **1.6543**: NZD **1,654.30** (1,000.00 x 1.6543). Journal on
  3 Jul: Dr 1030 1,654.30 (USD 1,000.00 at 1.6543) / Cr 4000 1,654.30. The
  line is reconciled. It adds **1,654.30** to Box 5 and Box 6 of the July GST
  return. 1030: USD 2,000.00 / NZD 3,254.30.
- **FXB3** Spend USD 50.00 at 1.66. The 5 Jul line (-50.00) shows the last
  USD rate, **1.6543** (FXB2), and NZD **-82.72** (50.00 x 1.6543 = 82.715,
  rounded half away from zero). Changing the rate to **1.66**: spend money to
  Amazon Web Services, 6040 Software and subscriptions, no GST, NZD **83.00**.
  Journal on 5 Jul: Dr 6040 83.00 / Cr 1030 83.00 (USD 50.00 at 1.66). In no
  GST box. 1030: USD 1,950.00 / NZD 3,171.30. The next line now shows 1.66.
- **FXB4** What's refused on foreign-currency spend and receive money, with
  nothing posted:
  - the 5 Jul line with tax code GST: "GST on foreign-currency spend and
    receive money isn't supported yet. Use zero-rated (ZERO), exempt
    (EXEMPT) or no GST (NONE)…";
  - two lines of USD 10.01 at 1.5 (15.015 → 15.02 each, 30.04; but USD 20.02
    x 1.5 = 30.03): "…the lines come to NZD 30.04 but the total is NZD
    30.03…". Two lines of USD 30.00 and USD 20.00 at 1.66 (49.80 + 33.20 =
    83.00 = USD 50.00 x 1.66) are allowed;
  - a rate of 0, or with more than 8 decimal places;
  - a bank transaction in USD on 1000 (an NZD account) is still refused.
- **FXB5** Transfer out: from the 10 Jul line (-500.00), a transfer to 1000,
  NZD **820.00** received. Carrying value = 3,171.30 x 500.00 / 1,950.00 =
  813.1538… → **813.15**, so the gain is 820.00 - 813.15 = **6.85**. Journal on
  10 Jul: Dr 1000 820.00 / Cr 1030 813.15 (USD 500.00 at carrying value) /
  Cr 7020 6.85. 1030: USD 1,450.00 / NZD 2,358.15. A +820.00 line on 1000 on 10
  Jul matches the 1000 journal line (BK4). Transferring USD 1,450.01 is
  refused (more than the foreign balance); a transfer from 1030 without the
  NZD received is refused.
- **FXB6** Transfer in: from a -1,000.00 line on 1000 on 20 Jul, a transfer to
  1030, USD **610.00** received. Journal on 20 Jul: Dr 1030 1,000.00 (USD
  610.00, rate 1.63934426) / Cr 1000 1,000.00. The 20 Jul +610.00 line on 1030
  then **matches** the 1030 journal line (USD 610.00), posting nothing. 1030:
  USD 2,060.00 / NZD 3,358.15. Now a spend money on 1030 dated 9 Jul (before
  the FXB5 transfer out) is refused.
- **FXB7** Revaluation on 31 Jul 2026 at 1.64 (reversal 1 Aug), with no
  foreign balance typed: the foreign balance is USD **2,060.00** from the
  ledger; revalued 2,060.00 x 1.64 = **3,378.40**; carrying **3,358.15**;
  Dr 1030 20.25 (USD 0.00 at 1.64) / Cr 7000 20.25, reversed on 1 Aug.
  Typing USD 2,000.00 for 1030 is refused ("…the ledger has USD 2,060.00…").
  The bank reconciliation report for 1030 as at 31 Jul: balance in Tohyee
  **USD 2,060.00** (NZD 3,378.40), statement balance **USD 2,060.00** (the 20
  Jul line's running balance), nothing outstanding: fully explained. The 5 Aug
  line now shows the rate **1.64** (the revaluation, later than the 20 Jul
  transfer's 1.63934426).
- **FXB8** Transfer everything left: from the 5 Aug line (-2,060.00), a
  transfer to 1000, NZD **3,400.00** received. After the 1 Aug reversal 1030's
  NZD balance is 3,358.15, and all USD 2,060.00 is leaving, so the carrying
  value is the whole **3,358.15** and the gain **41.85**: Dr 1000 3,400.00 /
  Cr 1030 3,358.15 (USD 2,060.00) / Cr 7020 41.85. 1030: USD 0.00 / NZD 0.00.
  With NZD 3,300.00 received instead it would be a loss of 58.15: Dr 7020
  58.15.
- **FXB9** Invoices and bills: a +115.00 line on 1030 can't pay INV-0001 (NZD):
  "…Invoices and bills are in NZD, so they can't be paid from a USD
  statement line yet…"; one-click OK suggests no invoice for it, and an
  adjustment on it is refused. Voiding the FXB3 spend money (after
  unreconciling) posts its exact reversal, foreign amount included.
- **FXB10** Imports: a CSV with a Currency column saying NZD, into 1030, is
  refused: "This file is in NZD, but 1030 (USD account) is in USD. Nothing was
  imported."; an OFX file with CURDEF USD into 1000 is refused the same way.
  The file above (no currency column) is recorded in USD. An Akahu feed
  can't be linked to 1030 ("…Akahu's transactions don't say their
  currency…").
- **FXB11** After FXB1-FXB8 the trial balance as at 31 Aug 2026 still balances
  in NZD: 1030 **0.00**, 7020 **48.70** credit (6.85 + 41.85), 7000 nothing
  (the revaluation was reversed), 4000 1,754.30 credit (FXB2's 1,654.30 and
  INV-0001's 100.00), 6040 83.00 debit.

### Not supported yet (refused rather than guessed)

- **Akahu bank feeds for foreign-currency accounts**: Akahu's transaction
  data has no currency, so a feed can't be linked to one (FXB10). Import
  statement files instead.
- **Standard-rated GST on foreign-currency spend and receive money** (FXB4),
  paying NZD invoices or bills from a foreign-currency line (FXB9), and
  adjustments on foreign-currency lines.
- **Transfers between two foreign-currency accounts**, and posting to a
  foreign-currency account dated before its latest transfer out (FXB6).
- **Splitting with an adjustment**: the statement lines must add up to the
  transaction exactly (BK27).
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
  column's period ends in). A profit and loss can also have a budget
  column and an actual less budget column (see "Budgets", BU7).
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
    left out (no GST to claim). Confirmed with the owner (29 Sep 2026): only
    zero-rated sales are reported (Box 6); zero-rated purchases stay out of
    Box 11.
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

## Tracking categories (advanced features)

For bigger organisations (decided with the owner, 29 Sep 2026, after looking
at NetSuite's classifications): an organisation setting, **Advanced (ERP)
features**, off by default, turns on **tracking categories**: Department,
Class and Location to begin with (more of the organisation's own come
later). Each category holds a **tree of values** (e.g. Location: Otago >
Dunedin). Lines of sales invoices, bills, sales and supplier credit notes,
spend and receive money, and manual journals can be tagged with one value per
category, and the posted journal lines keep the tags, so reports can split
or filter by them. Tags only describe lines; they never change an amount,
an account or a GST box.

- Only lines that users write are tagged: each document line's income,
  expense or other account line in the journal carries that document line's
  tags. Accounts receivable, accounts payable, GST and bank lines are never
  tagged. When an invoice (bill, credit note, spend or receive money) has
  several lines on the same account, they're posted as one journal line only
  if their tags are the same.
- A category can be **required**: then every line on an income or expense
  account needs a value from it before it can be approved or posted (drafts
  can still be saved without). Lines on balance sheet accounts never need
  one.
- Values are renamed, moved under another value, or archived, never deleted.
  An archived value can't be chosen for a new line but stays on old ones.
  Names are unique among a value's siblings (ignoring case), and a value can't
  sit under itself or its own children.
- Voiding and corrections copy the tags onto the reversing lines, so a voided
  document nets to zero in every column.
- Turning the setting off hides the fields, the categories page and the
  split and filter options; tags already on lines are kept, and come back
  when it's turned on again.

Setup: advanced features on; Department values Retail and Wholesale; Class
values Jewellery and Kits; Location values Otago (with Dunedin and
Queenstown under it) and Canterbury (with Christchurch under it). Tax code
GST (15%); dates in June 2026.

- **TC1** A new organisation has advanced features off, and the categories
  Department, Class and Location with no values. With the setting off, a
  line's tags are refused ("Advanced features are off"). Turning it on and
  off is recorded in the history. A draft tagged while it was on can still
  be edited and approved with the switch off: the tags it already had are
  kept, but no new ones can be added.
- **TC2** Values: "Dunedin" can be added under Otago and under Canterbury
  (different parents), but a second "dunedin" under Otago is refused; moving
  Otago under Dunedin is refused (it's its own child); a value can't be
  deleted, only archived; an archived value is refused on a new line
  ("Queenstown is archived") and still shows on lines that already have it.
- **TC3** Invoice (tax exclusive) with 100.00 to 4000 tagged Retail /
  Jewellery / Dunedin and 50.00 to 4000 tagged Wholesale / Kits /
  Christchurch posts Dr 1100 **172.50** / Cr 4000 **100.00** (Retail,
  Jewellery, Dunedin) / Cr 4000 **50.00** (Wholesale, Kits, Christchurch) /
  Cr 2100 **22.50** (no tags). Two lines of 30.00 and 20.00 to 4000 with the
  same tags are posted as one 50.00 line. The GST return is the same as
  without tags.
- **TC4** Bill (tax exclusive) with 40.00 to 6010 tagged Retail / Dunedin
  and 60.00 to 6010 with no tags posts Dr 6010 **40.00** (Retail, Dunedin) /
  Dr 6010 **60.00** / Dr 2100 **15.00** / Cr 2000 **115.00**. Voiding it
  posts the same lines the other way round, with the same tags.
- **TC5** A manual journal Dr 6010 25.00 (Retail) / Cr 1000 25.00 posts
  with the tag on the 6010 line. A tag with a value from the wrong category
  (Department: Dunedin) is refused. A correction's reversal keeps the
  original tags; its replacement can have different ones, and can keep a
  value the original had even if that value has since been archived.
- **TC6** With Department required: approving the TC3 invoice with its
  second line untagged is refused ("Line 2 needs a Department"), but the
  draft saves; the TC4 bill's 60.00 line is refused the same way; a manual
  journal line to 6010 without a Department is refused, while its 1000 line
  (a bank account) needs nothing. With the requirement off again, all of
  them work.
- **TC7** Profit and loss for June 2026 with TC3's invoice and TC4's bill,
  **split by Department**: Revenue Retail **100.00**, Wholesale **50.00**,
  Not set **0.00**, Total **150.00**; Expenses Retail **40.00**, Wholesale
  **0.00**, Not set **60.00**, Total **100.00**; Net profit Retail **60.00**,
  Wholesale **50.00**, Not set **-60.00**, Total **50.00** (the same as the
  profit and loss without a split). **Split by Location**, values under a
  top-level value count in its column: Revenue Otago **100.00**, Canterbury
  **50.00**; Expenses Otago **40.00**, Not set **60.00**; Net profit Otago
  **60.00**, Canterbury **50.00**, Not set **-60.00**.
- **TC8** A custom report (CR1) **filtered** to Location Otago counts only
  lines tagged Otago or a value under it: June Revenue **100.00**, Expenses
  **40.00**, Net profit **60.00**. The filter is shown on the report and kept
  in a published copy. A balance sheet can't be filtered (its AR, AP, GST
  and bank lines aren't tagged).
- **TC9** Voiding the TC3 invoice in June: split by Department, Revenue is
  **0.00** in every column.
- **TC10** A sales credit note, a supplier credit note and spend and receive
  money carry line tags the same way as TC3 and TC4 (credit note 20.00 to
  4000 tagged Retail posts Dr 4000 **20.00** (Retail)); payments, refunds,
  transfers and bank reconciliation never add tags.

## Custom segments and custom fields (advanced features)

The owner asked (29 Sep 2026) for these to work the way NetSuite's custom
segments and custom fields do
([custom segments](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4732448748.html),
[custom field types](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2842731.html)),
and like tracking categories they only show while **Advanced (ERP)
features** is on.

**Custom segments** are tracking categories an admin adds alongside
Department, Class and Location (for example "Grant" or "Project"). They
behave exactly like those three (TC1-TC10): a tree of values, optional or
required, on every line, posted onto the journal lines, and used to split and
filter the profit and loss. Like NetSuite's segments with "GL impact" they
always reach the ledger. A segment is never deleted: it can be archived,
which hides it from new lines (lines that already have it keep it, and
reports still show them), and brought back. Up to 20 segments of the
organisation's own.

**Custom fields** hold extra information that never reaches the ledger or
the GST return: they change no amount, account, tag or box, and the
profit and loss is the same with or without them. Each field has:

- a **label** (unique among fields for the same kind of record, ignoring
  case) and optional **help text**;
- **what it's on**, fixed once created, one of: **contacts** (customers,
  suppliers or both, like NetSuite's entity fields), **documents** (the top
  of an invoice, bill, sales or supplier credit note, spend or receive money
  or a manual journal, like its transaction body fields), or **lines**
  (each line of those, like its transaction column fields). A document or
  line field says which of those six it's used on;
- a **type**, fixed once created: text (up to 300 characters), long text (up
  to 4,000), whole number, decimal number (up to 6 decimal places), money
  (2 decimal places), percent (0 to 100, up to 2 decimal places), date,
  check box, list (one of its options), multiple select (any of its
  options), email address, phone number or web address (http or https). Up to
  15 digits before the point. Lists keep their options, which can be added,
  renamed and archived, never deleted;
- **required** (not for check boxes), a **default value** filled in on new
  records, and **show in list** (shown as a column on the list of those
  records);
- it can be **archived** (hidden from new records; values already saved stay
  and still show) and brought back, never deleted. Up to 100 fields.

Rules for values:

- Values are checked against the field's type, and a list or multiple
  select value must be one of its options (an archived option only if the
  record already had it). Blank means "not set": an empty text, no number,
  no date, an unticked check box and no options are all not set.
- A required contact field is needed whenever the contact is saved. A
  required document or line field is needed when the document is approved
  or posted (drafts still save), the same as required segments; a required
  line field is only needed on lines to income and expense accounts.
- Values are part of a draft, so they can be changed until it's approved;
  after that they're fixed with the rest of the document. A contact's
  values can be changed at any time, and the change is in its history.
- A new record starts with each active field's default. Leaving the values
  out when saving an existing record keeps what it had.
- With the setting off, fields are hidden; a record keeps the values it
  had and can still be saved with them, but can't be given new ones.
- A sales credit note started from an invoice (and a supplier credit note
  from a bill) copies the values of fields that are used on both; a
  correction of a manual journal starts with the original's values.
  Reversals and voids don't carry custom fields (they never reach the
  ledger).

Setup: advanced features on. Fields: contact field "Pet name" (text, on
customers); contact field "Channel" (list: Shopify, Market, Wholesale; on
customers, required, shown in the list); document field "Engraving
proof sent" (check box, on invoices); document field "Grant code" (text, on
bills and spend money, default "GEN"); document field "Approved by" (text,
on journals); line field "Engraving text" (text, on invoice and credit note
lines, required); line field "Hours" (decimal number, on bill and journal
lines).

- **CS1** Adding a segment "Grant" with values "Lotteries" and "Council" puts a fourth select on every line.
  An invoice with 100.00 to 4000 tagged Grant: Lotteries posts Cr 4000
  **100.00** tagged with it, and the profit and loss split by Grant shows
  Lotteries **100.00**. A second segment called "grant" is refused (names
  are unique ignoring case, across all categories).
- **CS2** Archiving "Grant": new lines can't be tagged with it ("Grant is
  archived"), the CS1 invoice keeps its tag, the split by Grant still shows
  **100.00**, and a draft that already had it can still be approved.
  Bringing it back makes it usable again. Department, Class and Location
  can't be archived, and a segment can't be deleted.
- **CS3** A 21st segment of the organisation's own is refused.
- **CF1** Field set-up: a second field labelled "pet name" on contacts is
  refused, but "Pet name" on lines is fine; a field's type and what it's on
  can't be changed; a required check box is refused; a list needs at least
  one option; a default must be a valid value ("GEN" is fine for text, "abc"
  isn't for a decimal number); a field can't be deleted, only archived.
- **CF2** Values by type: text over 300 characters, "12.5" for a whole
  number, "1.1234567" for a decimal (7 places), "12.345" for money, "101"
  for a percent, "2026-02-30" for a date, "Etsy" for Channel, "not an email"
  for an email and "ftp://x" for a web address are each refused, naming the
  field ("Channel: choose one of its options."). "1,234.50" is refused for
  money (no thousands separators). Valid values are stored as typed: money
  "12.50", decimal "3.25", whole number "12", percent "12.5", check box
  true.
- **CF3** Contacts: a new customer gets Channel's default if it has one;
  saving a customer without Channel is refused ("Channel is required"),
  while a supplier-only contact doesn't need it (Channel is on customers
  only) and can't be given "Pet name". The customer list shows a Channel
  column; changing Kobe Ltd's Channel from Market to Shopify is recorded in
  its history.
- **CF4** Invoice: a draft with "Engraving proof sent" ticked and line 1
  "Engraving text" = "Kobe" but line 2 blank saves; approving it is refused
  ("Line 2 needs Engraving text"); filling it in lets it approve. The posted
  journal is Dr 1100 / Cr 4000 / Cr 2100 exactly as without fields, with no
  custom fields on the journal lines. After approval the values can't be
  changed.
- **CF5** Bill: a new bill gets "Grant code" = "GEN" by default; a line with
  "Hours" = 2.5 saves; "Engraving text" (not used on bills) is refused on a
  bill line ("Engraving text isn't used on bill lines").
- **CF6** Credit note from the CF4 invoice copies "Engraving text" (used on
  credit note lines) but not "Engraving proof sent" (invoices only).
- **CF7** Archiving "Pet name": it's hidden from new contacts and the
  contact editor, but Kobe Ltd still shows and keeps "Pet name: Rex", and
  can be saved with it. Archiving the "Market" option: Kobe Ltd (Market)
  keeps it; a new customer can't choose it.
- **CF8** With the setting off, saving Kobe Ltd with its existing values
  works; giving it a new "Pet name" is refused.
- **CF9** Manual journal: "Approved by" and a line's "Hours" are stored
  with the journal; a correction starts with the original's values and the
  replacement keeps what was entered; the reversal has none.
- **CF10** Spend money reconciled from a bank line with "Grant code" =
  "LOT-22" keeps it; a receive-money transaction doesn't get "Grant code"
  (it's on spend money only).

## Salespeople (advanced features)

The owner asked (29 Sep 2026) for salespeople to work the way NetSuite's
sales reps do
([marking a sales rep](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1039206.html),
[Sales by Sales Rep Summary](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1117863.html)).
NetSuite's help doesn't say how every detail works, so where it's silent the
rules below are our choice. Like tracking categories, salespeople only show
while **Advanced (ERP) features** is on.

- A **salesperson** has a name (unique, ignoring case) and an optional
  email. Salespeople are archived, never deleted. (In NetSuite they're
  employees ticked as sales reps; Tohyee has no employee records yet.)
- A **customer** can have a default salesperson. A **sales invoice** and a
  **sales credit note** each have one salesperson (or none). A new invoice
  or credit note gets the customer's default when none is sent; a credit
  note started from an invoice gets the invoice's salesperson. It can be
  changed while the document is a draft and is fixed once approved.
  Changing a customer's default doesn't change documents already saved.
- The salesperson never changes an amount, an account or a GST box. Team
  selling (splitting a sale between several salespeople) and commissions
  aren't built.
- An archived salesperson can't be chosen for a new document, and an
  archived default isn't applied; a draft that already has them keeps them
  and can be approved. With the setting off, documents keep their
  salesperson but can't be given a new one.
- **Sales by salesperson** (a report for a date range), one row per
  salesperson plus "Not set", amounts excluding GST: **Invoices** is how
  many invoices are dated in the range (approved, including ones voided
  later); **Sales** is those invoices' amounts excluding GST, less invoices
  voided in the range (on their void date); **Credit notes** is the same for
  sales credit notes; **Net sales** is Sales less Credit notes. Drafts never
  count. Each row opens to the documents behind it. The total net sales
  equals the income that invoices and credit notes posted in the range.

Setup: advanced features on; salespeople Aroha and Ben; customer Kobe Ltd
with default salesperson Aroha; customer Rata Ltd with none; GST 15%.

- **SR1** A new invoice for Kobe Ltd with no salesperson sent gets Aroha;
  one sent with Ben keeps Ben; one for Rata Ltd has none. A second
  salesperson called "aroha" is refused, and a salesperson can't be
  deleted.
- **SR2** Kobe's invoice for 100.00 (tax exclusive) with Aroha posts
  Dr 1100 **115.00** / Cr 4000 **100.00** / Cr 2100 **15.00**, exactly as
  without a salesperson. After approval its salesperson can't be changed.
- **SR3** June 2026: invoice 1 Kobe/Aroha 100.00, invoice 2 Kobe/Ben
  200.00, invoice 3 Rata/none 50.00 (all tax exclusive), a credit note from
  invoice 1 for 20.00 (it gets Aroha), and a draft invoice for 999.00 with
  Ben. Sales by salesperson for June: Aroha invoices **1**, sales
  **100.00**, credit notes **20.00**, net **80.00**; Ben **1**, **200.00**,
  **0.00**, **200.00**; Not set **1**, **50.00**, **0.00**, **50.00**; total
  **3**, **350.00**, **20.00**, **330.00**, the same as June's income on
  4000.
- **SR4** Voiding invoice 2 on 5 July 2026: June is unchanged; July shows
  Ben invoices **0**, sales **-200.00**, net **-200.00**.
- **SR5** A tax inclusive invoice for 115.00 with Aroha counts **100.00**.
- **SR6** Archiving Ben: a new invoice with Ben is refused ("Ben is
  archived"); the draft that already had Ben keeps him and can be approved.
  Archiving Aroha: a new invoice for Kobe gets no salesperson. Changing
  Kobe's default to Ben (restored) doesn't change invoice 1.
- **SR7** With the setting off, a new invoice for Kobe gets no salesperson,
  and one sent with Aroha is refused; a draft that already had Aroha keeps
  her.
- **SR8** The June report's Aroha row lists invoice 1 (100.00) and the
  credit note (20.00).

## Richer customers (advanced features)

The owner asked (29 Sep 2026) for richer customers, step 4 of the
NetSuite-style plan, choosing all five parts below. They follow NetSuite's
customer record
([terms](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1418163.html),
[credit limits](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1415896.html),
[customer categories, price levels](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1412993.html),
[sub-customers](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1413598.html))
and, for payment terms, Xero's. Where they're silent the rules below are our
choice.

- **Payment terms are for everyone** (Xero has them for every
  organisation), not only with **Advanced (ERP) features** on. Each term is
  one of: N days after the invoice date, N days after the end of the
  invoice's month, or day N of the following month (NetSuite's date-driven
  terms; a day the month doesn't have becomes its last day). A new
  organisation starts with Due on receipt, 7 days, 14 days, 30 days, 20th of
  the following month, and 30 days after the end of the month. A customer
  has a default term; a new invoice sent without a due date gets it from the
  term. The due date can still be changed while the invoice is a draft.
  Changing or archiving a term, or a customer's term, never changes a saved
  invoice.
- The **billing address** is the old postal address (nothing moves); a
  customer also has a **delivery address**. Both are for everyone.
- **Contact people** are the CRM's people at the company (there's one list,
  not two): name, job title (their role), email and phone, and one of them
  can be the **primary contact** for invoices. They can be managed while the
  CRM or Advanced reporting is on.
- With Advanced reporting on, a customer can have a **credit limit**, a
  **customer group** (NetSuite's customer categories), a default **price
  level** and a **parent customer**. Groups and price levels are lists that
  are archived, never deleted. A price level is a percent on (a markup) or
  off (a discount) the base price; nothing is priced from it until items
  arrive, so invoices don't change.
- **Credit limit check**: when an invoice is approved, the customer's
  balance (their approved invoices' amounts due, less credit notes and
  overpayments not yet used or refunded) plus the invoice's total is compared
  with their limit. Going over it is either a **warning** (the default: the
  invoice is approved and the warning is shown and kept in its history) or
  **blocked** (refused with a message; the draft stays as it was and no
  number is used), set per organisation. Exactly at the limit is fine. No
  limit means no check, and with Advanced reporting off nothing is checked.
  The limit is the customer's own, not shared with its parent or subs.
- **Parent customers**: both must be customers, a customer can't be its own
  parent or under one of its own subs, and a tree is at most 4 levels deep
  (the database refuses otherwise). A customer with subs must stay a
  customer.
- **Aged receivables** (a new report, for everyone): what each customer owes
  as at a date, by days past each invoice's due date (current, 1-30, 31-60,
  61-90, over 90), less credit not yet used, worked out from the documents
  as they stood on that date. Its total equals accounts receivable on the
  balance sheet on that date. With **roll-up**, a parent shows the total of
  itself and everything under it, with its subs indented beneath. Customer
  statements don't exist yet, so there's no statement roll-up.

Setup: Advanced reporting on; GST 15%; the six starting payment terms.

- **RC1** Customer Kobe Ltd has "20th of the following month". A new invoice
  dated 15 June 2026 sent without a due date is due **20 July 2026**; one
  dated 31 December 2026 is due **20 January 2027**; one sent with a due
  date of 30 June 2026 keeps it, and the draft's due date can be changed to
  1 August 2026. With "30 days" the 15 June invoice is due **15 July 2026**,
  with "30 days after the end of the month" **30 July 2026**, and with "Due
  on receipt" **15 June 2026**. A term "31st of the following month" on an
  invoice dated 10 January 2026 gives **28 February 2026**. For a customer
  with no terms the due date is still required. This works with Advanced
  reporting off.
- **RC2** A second term called "30 DAYS" is refused, and terms can't be
  deleted. Archiving "30 days": it can't be chosen for a customer, and a
  customer already on it keeps it but new invoices need a due date typed.
  Changing Kobe's term to "7 days" doesn't change its saved invoices.
- **RC3** (warn) Kobe has a credit limit of **1,000.00**. Invoice A for
  500.00 + GST = **575.00** is approved and unpaid. Approving invoice B for
  400.00 + GST = **460.00** takes Kobe to **1,035.00**: B is approved (and
  posts Dr 1100 460.00 / Cr 4000 400.00 / Cr 2100 60.00 as usual) with the
  warning "Kobe Ltd owes 575.00, so this invoice for 460.00 takes them to
  1035.00, 35.00 over their credit limit of 1000.00."
- **RC4** (block) The same with the setting on block: approving B is
  refused with that message, B stays a draft and INV-0002 is still unused.
  After a payment of **100.00** on A, Kobe owes **475.00**; 475.00 + 460.00
  = **935.00**, so B is approved as INV-0002.
- **RC5** Credit counts: with A (575.00) approved, a credit note for
  100.00 + GST = **115.00** not yet applied, and a payment of 690.00 on a
  third invoice of 575.00 (an overpayment of **115.00** left), Kobe owes
  575.00 - 115.00 - 115.00 = **345.00**, so B (460.00) takes them to
  **805.00**, under 1,000.00. With a limit of exactly 805.00 B is approved
  with no warning; at 804.99 it's over by 0.01. With no limit, or with
  Advanced reporting off, nothing is checked.
- **RC6** A contact saved with a postal address keeps it as its billing
  address; a delivery address "12 Wharf St, Dunedin 9016" is saved beside
  it. People Aroha (primary) and Ben work at Kobe Ltd: Kobe's primary
  contact is Aroha. Making Ben primary takes it from Aroha. An archived
  person, or someone at no company, can't be primary; archiving the primary
  person leaves the company with none. People can be added with only
  Advanced reporting on, and are refused with both it and the CRM off.
- **RC7** Customer groups Retail and Wholesale; price levels "Wholesale"
  **-10** (10% off) and "Trade plus" **5** (5% on). Kobe is in Wholesale
  with price level Wholesale; its invoices' amounts are unchanged. A price
  level of -100 or 1000.01 is refused, names are unique ignoring case, an
  archived group or level can't be chosen (a customer already on it keeps
  it), and neither can be deleted.
- **RC8** Kobe Group Ltd is the parent of Kobe Auckland and Kobe Dunedin,
  and Kobe Dunedin of Kobe Mosgiel (3 levels). Making Kobe Group Ltd a sub
  of Kobe Mosgiel is refused (a loop), as is a customer as its own parent
  and a supplier-only parent. Kobe Mosgiel can have a sub, Kobe Mosgiel
  North (4 levels), but a sub of that is refused (5 levels). Kobe Group Ltd
  can't stop being a customer while it has subs.
- **RC9** Aged receivables as at **31 July 2026**: Rata Ltd's invoice of
  460.00 due 31 March 2026 with 60.00 paid (**400.00**, 122 days, over 90);
  Kobe Auckland's invoice of **345.00** due 15 May 2026 (77 days, 61-90) and
  its unused credit note of **23.00**; Kobe Dunedin's invoice of **115.00**
  due 20 July 2026 (11 days, 1-30) and **230.00** due 20 August 2026
  (current). Kobe Mosgiel's invoice dated 5 August 2026, and Kobe
  Auckland's invoice voided on 10 May 2026, don't count. Totals: current **230.00**, 1-30 **115.00**, 31-60 **0.00**, 61-90
  **345.00**, over 90 **400.00**, credit **23.00**, total **1,067.00**, the
  same as account 1100 on the balance sheet at 31 July 2026. Rows: Kobe
  Auckland **322.00**, Kobe Dunedin **345.00**, Rata Ltd **400.00**.
- **RC10** With roll-up (the tree from RC8): Kobe Group Ltd (nothing of its
  own) shows current 230.00, 1-30 115.00, 61-90 345.00, credit 23.00, total
  **667.00**, with Kobe Auckland (322.00) and Kobe Dunedin (345.00) beneath
  it; Kobe Mosgiel owes nothing and isn't shown; Rata Ltd **400.00**. The
  grand total is still **1,067.00**.
- **RC11** As at **30 June 2026** (the same documents): Kobe Dunedin's
  first invoice is current (115.00), Kobe Auckland's is 46 days overdue
  (31-60, 345.00), Rata's 91 days (over 90, 400.00), credit 23.00, total
  **837.00**. Voiding Rata's payment on 10 August 2026 doesn't change the
  report as at 31 July; as at 10 August Rata owes **460.00**.
- **RC12** With Advanced reporting off: customers keep their credit limit,
  group, price level and parent, but new ones can't be set ("Advanced
  reporting is off"), and approving over a limit is neither warned nor
  blocked. Payment terms and delivery addresses still work.

### Not supported yet (refused rather than guessed)

- Credit limits shared across a parent and its subs (each customer's limit
  is its own). Prices from price levels arrived with items (IT4).
- Holding orders over the limit (there are no sales orders yet) or
  checking the limit when a draft is saved (only approving is checked).
- Customer statements (and so their roll-up); only aged receivables rolls
  up.
- Terms with early-payment discounts (NetSuite's "2% 10 Net 30").

## Products and services (items)

The owner asked (29 Sep 2026) for items, step 4 of the NetSuite-style plan
continued: a products and services list like
[Xero's items](https://central.xero.com/s/article/Add-an-item), with
[NetSuite's](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_N2093617.html)
item types, units of measure, price levels, vendor prices and kits. Where
they're silent the rules below are our choice.

- **Every organisation** has the item list (Xero has it for everyone): a
  **code** (unique, ignoring case, archived items included), a name, an
  optional description, a **sale price** and a **purchase price** (excluding
  GST, for the base unit, up to 4 decimal places), an **income account**
  (revenue), a **purchase account** (the bill line rules), and **sales** and
  **purchase tax codes**. Items are archived, never deleted.
- **Types**: **service**, **non-stock** and **stock** for everyone; **kit**
  (a bundle of other items) only with **Advanced reporting** on. A stock item
  only records its type in this step: nothing moves stock or posts cost of
  sales until stock tracking (ST1-ST12). An item's type can't change once a
  document line uses it.
- **Picking an item** on an invoice, bill or credit note line fills its
  description (the item's description, else its name), unit price, account
  and tax code, which stay editable on a draft. The API does the same for
  any of those left blank on a line with an item. Lines without an item work
  as before. Amounts, GST and journals are worked out from the line exactly
  as before; the item only fills it in.
- With **Advanced reporting** on (NetSuite's extras):
  - **Units of measure**: an item counts in its **base unit** (default
    "each"; e.g. kg) and can have other units that are a fixed multiple of
    it ("Box of 12" = 12 each). A line records the unit it's in, and its
    quantity in the base unit is worked out exactly (quantity x the unit's
    size) and stored with it. A unit's size never changes (lines use it);
    units are renamed or archived. An item can start sales and purchases in
    one of its units; the price filled in is the base price x the unit's
    size.
  - **Price levels** (from richer customers, RC7) price items: an item's
    price for a level is its sale price adjusted by the level's percent,
    rounded once to cents, half away from zero, unless the item has its own
    price for that level. Picking an item on an invoice or credit note for a
    customer with a default price level fills that price.
  - **Supplier prices**: per item, suppliers with their price and their own
    code for it, at most one **preferred**. Picking an item on a bill or
    supplier credit note fills that supplier's price, else the item's
    purchase price.
  - **Kits**: a kit lists other items and quantities. Kits can't be inside
    kits (NetSuite's kits can; costing a kit of kits needs a decision, so
    it's refused), and kits are sold, not bought.
  - Turning Advanced reporting off keeps an item's units, level prices,
    supplier prices and kit parts, and documents keep their lines, but new
    ones can't be set and prices come from the item's own sale and purchase
    prices.

Setup: GST 15%; supplier Paw Supplies; customers Kobe Ltd and Rata Ltd.
Item **WIDGET** "Widget", stock, sale price **12.00**, purchase price
**5.00**, income 4000, purchase account 1400, GST both ways.

- **IT1** With Advanced reporting off, WIDGET, a service item "Engraving"
  and a non-stock item "Gift box" can be added. A second item coded
  "widget" is refused (codes ignore case). Archiving WIDGET keeps it; it
  can't be deleted (the database refuses) or picked on a new line, but a
  draft that already has it can still be saved and approved. Once a line
  uses WIDGET its type can't change. A retry with the same key returns the
  same item; the same key with a different item is refused (409); a viewer
  can't add items.
- **IT2** An invoice to Kobe with a line of only WIDGET and quantity **4**
  is filled in as "Widget", 4 x **12.00** to 4000 with GST. Approving posts
  Dr 1100 **55.20** / Cr 4000 **48.00** / Cr 2100 **7.20**, as any invoice
  line does (and, since stock tracking, its cost of sales, ST2). On a draft the price can be changed to 11.50 (net 46.00) and is
  kept. A line without an item still works. A sales credit note filled from
  WIDGET works the same way.
- **IT3** A bill from Paw Supplies with a line of only "Gift box" (purchase
  price **2.00**, account 5100, GST) and quantity 10 is filled in and
  approves as Dr 5100 **20.00** / Dr 2100 **3.00** / Cr 2000 **23.00**. A
  supplier credit note filled from it works the same way.
- **IT4** (Advanced reporting on) Price levels "Wholesale" **-10** and "Trade
  plus" **5** (RC7). Kobe has Wholesale, Rata Trade plus, and a third
  customer none. WIDGET picked for Kobe is **10.80** (12.00 x 0.90), for Rata
  **12.60** (12.00 x 1.05) and for the third customer **12.00**. A sale price
  of **9.99** gives **8.99** (8.991) and **10.49** (10.4895). With WIDGET's
  own Wholesale price of **10.00**, Kobe gets **10.00**. With Advanced
  reporting off, Kobe gets **12.00**.
- **IT5** (Advanced reporting on) WIDGET gets the unit "Box of 12" (12
  each). An invoice line of **2** "Box of 12" is filled at **144.00** a box
  (12.00 x 12), comes to **288.00** and records **24** each. Quantities are
  exact: 0.3333 of a "Pack of 3" is **0.9999** each. A unit's size can't be
  changed (the database refuses too), a unit of another item is refused,
  and a unit named like the base unit is refused. With Advanced reporting
  off, units can't be added.
- **IT6** (Advanced reporting on) WIDGET's suppliers: Paw Supplies at
  **4.80** (their code PS-W1, preferred) and Otago Wholesale with no price.
  WIDGET on a bill from Paw is filled at **4.80**; from Otago Wholesale at
  **5.00** (the item's purchase price). Two preferred suppliers, or a
  customer-only contact as a supplier, are refused.
- **IT7** (Advanced reporting on) Kit "GIFT-SET" = 1 WIDGET + 2 CANDLE,
  sale price 30.00. An invoice line of one GIFT-SET is filled at **30.00**
  to its income account. A kit inside a kit, a kit with no parts, a kit on
  a bill, and making a kit's part into a kit are all refused. (Its cost of
  sales and stock come with stock tracking, ST8.)
- **IT8** With Advanced reporting off: kits, units, level prices and
  supplier prices can't be set ("Advanced reporting is off"); an item that
  already has them keeps them.
- **IT9** The items API: listing (viewer), adding and changing (bookkeeper),
  and "what picking an item fills" (`/api/items/line-defaults`) give the
  same answers as IT2-IT6.

### Not supported yet (refused rather than guessed)

- Kits inside kits, and kits on bills or supplier credit notes.
- Changing a unit's size or an item's type once used; archive and add new.
- Quantity price breaks, prices in other currencies, and item images.
- Assemblies (building stock from parts) and item variants.

## Modules and the CRM

Decided with the owner (29 Sep 2026): Tohyee has four modules: **Accounting**
and **Tax** (always on), **CRM** and **Advanced reporting** (each switched on
per organisation in Settings). Advanced reporting is the existing
"advanced features" switch: tracking categories and segments, custom fields,
salespeople and their reports. The CRM follows
[Twenty](https://github.com/twentyhq/twenty) (AGPL-3.0, the same licence as
Tohyee): its companies, people, opportunities, tasks, notes and timeline,
built into Tohyee rather than run alongside it.

- **MOD1** A new organisation has the CRM and Advanced reporting off. Turning
  either on or off is recorded in the history. With the CRM off its menu and
  screens are hidden and its commands are refused ("The CRM is off"); what
  was entered is kept.

**Companies** are Tohyee's contacts, so the CRM and the accounts share one
list. As well as customer and supplier, a contact can be a **prospect**
(someone you hope to sell to). A contact must be at least one of the three;
a prospect-only contact can't be put on an invoice, bill or credit note
until it's marked as a customer, and only the CRM can make one.

**People** work at a company (or at none): first and last name, job title,
email and phone. People are archived, never deleted.

**Opportunities** (deals) have a name, a company, a point of contact (one of
its people), an owner (a member of the organisation), an amount excluding
GST, an expected close date and a **stage**: New, Screening, Meeting,
Proposal, Won or Lost (Twenty's stages, with its "Customer" called Won, and
Lost added). Stages change freely until an opportunity has made an invoice.
A **won opportunity can make a draft invoice** for its company: one line with
the opportunity's name and amount, the first active revenue account and the
standard GST code, dated today and due on the customer's payment terms (in
20 days if they have none, RC1), which is then edited and
approved like any other. Making it marks a prospect as a customer too. An
opportunity makes at most one invoice.

**Tasks** have a title, optional details, a due date, an assignee (a
member), a status (To do, In progress, Done) and can be about a company, a
person or an opportunity. **Activities** record a call, a meeting or a note
on a company, person or opportunity, with when it happened. Tasks and
activities are edited but never deleted (a task is marked done; an activity
can be corrected, and the change is in the history).

A company's **timeline** lists, newest first: its activities, tasks,
opportunities (created and stage changes), and its approved invoices, credit
notes, customer payments, bills and supplier payments, each linking to it.

None of the CRM posts anything except the draft invoice, which posts only
when approved.

- **CRM1** Adding Mānuka Vets as a prospect (not a customer or supplier)
  works with the CRM on and is refused with it off; a draft invoice for it is
  refused ("isn't marked as a customer"). A contact that's none of the three
  is refused.
- **CRM2** People: Aroha Ngata (Practice manager, aroha@manukavets.nz) at
  Mānuka Vets. A person's company must be an existing contact; an email must
  look like one. A person can't be deleted, only archived.
- **CRM3** Opportunity "Memorial paw prints 2027" for Mānuka Vets, 2,400.00,
  closing 2026-12-15, point of contact Aroha, owner Jess, stage New. The
  point of contact must work at that company. The amount can't be negative.
- **CRM4** Moving it New → Proposal → Lost → Proposal works and each move is
  in the history (the timeline shows "Proposal → Lost").
- **CRM5** Marking it Won and making the invoice: a draft invoice for Mānuka
  Vets dated today, one line "Memorial paw prints 2027" 1 × 2,400.00 to 4000
  with GST (15%), total **2,760.00**; Mānuka Vets is now a customer (still a
  prospect too); nothing is posted until the draft is approved. Making the
  invoice again returns the same invoice; an opportunity that isn't Won
  can't make one; once it has an invoice its stage can't change.
- **CRM6** Tasks: "Send sample kit" due 2026-10-01 for Jess about the
  opportunity, To do → Done. The assignee must be a member of the
  organisation. A task can't be deleted.
- **CRM7** Activities: a call with Aroha on 2026-09-28 10:00 ("Talked about
  pricing"), a meeting and a note on Mānuka Vets. An activity must be about
  something (a company, person or opportunity).
- **CRM8** Mānuka Vets' timeline after CRM3-CRM7 and approving the CRM5
  invoice lists, newest first, the approved invoice, the task, the
  activities and the opportunity's events, and the company's list shows 1
  open task and the open pipeline total **0.00** (the only opportunity is
  won; open means not Won or Lost).
- **CRM9** The pipeline board groups open and closed opportunities by stage
  with a total per stage (amounts excluding GST).

## CRM email and calendar sync

The owner asked (29 Sep 2026) for email and calendar sync in the first round of
the CRM; the details follow Twenty's connected accounts:
each member of an organisation can connect their own **Gmail** or
**Microsoft 365** mailbox and calendar, and emails and meetings with people
the CRM knows show on those people's and companies' timelines. Like Akahu,
each organisation uses its own Google or Microsoft app: an admin enters its
client ID and secret (stored encrypted, never shown again), and the page
shows the redirect address to register with Google or Microsoft. Tohyee asks
for read-only access (Gmail and Google Calendar read-only; Microsoft
Mail.Read and Calendars.Read, plus offline access), never sends or changes
anything, and needs TOHYEE_SECRET_KEY to store the tokens.

- Only emails and meetings with at least one **known participant** are
  kept: someone whose address is a CRM person's email or a contact's email
  (ignoring case), other than the mailbox's owner. Everything else is never
  stored. A participant counts once however many times they appear.
- Each kept email records who it was from and to, when, whether it was
  sent or received, its subject and a short preview (at most 300
  characters); never the full body or attachments. Each kept meeting
  records its title, start, end, location and attendees.
- Each connected account chooses what the rest of the team sees:
  **subject and preview** (the default) or **only that it happened** (who
  and when, with "(private)" for the subject and no preview). The owner of
  the account always sees everything that was kept.
- Syncs run every 15 minutes, or on "Sync now". The first sync looks back
  30 days (emails) and 30 days either side of today (meetings); later syncs
  fetch what's new since the last one. An email or meeting already kept is
  never kept twice (it's matched by the provider's id); a changed meeting is
  updated.
- Disconnecting deletes the account's tokens and everything it synced (the
  copies in Tohyee, never the mailbox). A failed sync is recorded with its
  error and retried next time; three failures in a row pause the account
  until it's reconnected.
- The CRM must be on to connect or sync.

Setup: CRM on; company Mānuka Vets (hello@manukavets.nz) with person Aroha
Ngata (aroha@manukavets.nz); Jess connects jess@glimmers.nz.

- **MAIL1** Settings: saving a Google client ID and secret stores the secret
  encrypted and shows it only as "saved"; without TOHYEE_SECRET_KEY saving is
  refused. Only admins can change it; the redirect address shown ends in
  /api/crm/mail/callback.
- **MAIL2** Connecting: the Google sign-in address carries the client ID,
  the redirect address, read-only scopes, offline access and a one-time
  state; the callback with that state stores the account (jess@glimmers.nz,
  Google) with encrypted tokens. A callback with an unknown, used or
  expired (over 15 minutes) state, or from another signed-in user, is
  refused.
- **MAIL3** First sync of Gmail with three emails: from
  aroha@manukavets.nz to Jess ("Paw print order"), from Jess to
  hello@manukavets.nz ("Quote"), and from newsletter@shop.example to Jess.
  The first two are kept (received and sent), linked to Aroha and to
  Mānuka Vets; the newsletter isn't stored at all.
- **MAIL4** Syncing again with the same emails keeps nothing new; a fourth
  email to aroha@manukavets.nz is added.
- **MAIL5** Calendar: a meeting "Clinic visit" with aroha@manukavets.nz is
  kept and linked to Aroha and Mānuka Vets; a meeting with only Jess isn't;
  moving the clinic visit an hour later updates it.
- **MAIL6** Mānuka Vets' timeline shows the two emails and the meeting,
  with subject and preview, newest first, among its other entries.
- **MAIL7** Setting Jess's account to "only that it happened": other
  members see "(private)" and no preview; Jess still sees the subject.
- **MAIL8** Microsoft 365 works the same way (Graph messages and calendar
  view), matched and linked the same.
- **MAIL9** Disconnecting removes the account and its synced emails and
  meetings from the timeline. Three failed syncs in a row pause it with the
  last error shown.

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

## Aged payables (examples not yet approved by Jess)

Written overnight from Xero's aged payables and NZ practice, as the mirror of
aged receivables (RC9-RC11); Jess hasn't approved them yet. What the
organisation owes each supplier as at a date: each approved bill's amount
due (its total less supplier payments and supplier credit applied on or
before the date, not voided or removed by then), put in a bucket by days
past its **due date** (current, 1-30, 31-60, 61-90, over 90; a bill due on
the date is current), less supplier credit notes not yet applied or
refunded. Bills dated after the date, or voided on or before it, don't
count. Supplier overpayments and prepayments aren't built, so supplier
credit notes are the only credit. The total equals accounts payable (2000)
on the balance sheet at the date; the report shows the ledger balance
beside it and any difference. Viewers can see it. Suppliers have no parents,
so there's no roll-up.

Setup: GST 15%. Paw Supplies: bill PS-101, 200.00 + GST = **230.00**, dated
1 Mar 2026, due 31 Mar, with **30.00** paid on 10 Apr. Kiwi Freight: bill
KF-1, 300.00 + GST = **345.00**, dated 1 May, due 15 May; bill KF-2,
100.00 + GST = 115.00, dated 1 May, due 15 May, voided 10 May; supplier
credit note KF-CR1, 20.00 + GST = **23.00**, dated 1 Jun, not applied.
Rata Print: bill RP-1, 100.00 + GST = **115.00**, dated 20 Jun, due 20 Jul;
RP-2, 200.00 + GST = **230.00**, dated 21 Jul, due 20 Aug; RP-3 dated
5 Aug.

- **AGP1** As at **31 July 2026**: PS-101 **200.00** (122 days, over 90);
  KF-1 **345.00** (77 days, 61-90) and KF-CR1 credit **23.00**; RP-1
  **115.00** (11 days, 1-30); RP-2 **230.00** (current). KF-2 (voided) and
  RP-3 (dated later) don't count. Totals: current **230.00**, 1-30
  **115.00**, 31-60 **0.00**, 61-90 **345.00**, over 90 **200.00**, credit
  **23.00**, total **867.00**, the same as account 2000 on the balance sheet
  at 31 July 2026 (difference **0.00**). Rows by name: Kiwi Freight
  **322.00**, Paw Supplies **200.00**, Rata Print **345.00**; each opens to
  its bills and credit.
- **AGP2** As at **30 June 2026**: RP-1 is current (**115.00**), KF-1 is 46
  days overdue (31-60, **345.00**), PS-101 91 days (over 90, **200.00**),
  credit **23.00**, total **637.00** (= 2000 at 30 June).
- **AGP3** Later changes don't rewrite an earlier date: KF-CR1's 23.00
  applied to KF-1 on 5 Aug leaves Kiwi Freight at **322.00** as at 31 July
  (345.00 due, 23.00 credit) and at 5 Aug (**322.00** due, no credit).
  Voiding PS-101's payment on 10 Aug leaves Paw Supplies at **200.00** as
  at 31 July; as at 10 Aug it's **230.00**.

### Not supported yet (refused rather than guessed)

- Ageing by bill date instead of due date (Xero offers both; this uses the
  due date, like aged receivables).
- Supplier overpayments and prepayments (not built, waiting on Jess's GST
  decision), and parent suppliers.

## Account transactions (examples not yet approved by Jess)

Written overnight from Xero's account transactions report (general ledger
detail); Jess hasn't approved them yet. For one account, or every account,
and a date range: the **opening balance** (every posting before the start
date), each **posted journal line** in the range in date order (date, the
source with a link to it, description, contact, debit, credit and the
running balance), and the **closing balance**. Balances are debits less
credits, so a credit balance is negative (shown as "Cr" on screen); each
account's closing balance is its trial balance line at the end date, and
its debits less credits are the trial balance's movement over the range.
Voids and corrections are their own lines on their own dates; nothing is
netted off. Without a start date the range starts at the beginning of the
end date's financial year. With Advanced reporting's tracking on, a
**tracking filter** (a value and everything under it, like the custom
profit and loss, TC8) keeps only lines tagged with it, opening balance
included. With every account, accounts with no balance and no lines are left
out. Viewers can see it.

Setup (31 March year end, GST 15%): a manual journal OPEN on 15 Mar 2026,
Dr 1000 **5,000.00** / Cr 3000 **5,000.00**. INV-0001 to Kobe Ltd, 100.00 +
GST = **115.00**, dated 10 Apr; paid **115.00** into 1000 on 20 Apr. Bill
PS-101 from Paw Supplies, 200.00 + GST = **230.00** to 6010, dated 25 Apr
(approved by a bookkeeper); paid **230.00** from 1000 on 15 May. INV-0002 to
Kobe Ltd, 50.00 + GST = **57.50**, dated 30 Apr, voided 5 May.

- **ATX1** Account 1000, 1 Apr - 31 May 2026: opening **5,000.00**; 20 Apr
  "Payment on invoice INV-0001", Kobe Ltd, debit **115.00**, balance
  **5,115.00**; 15 May "Payment of bill PS-101", Paw Supplies, credit
  **230.00**, balance **4,885.00**; closing **4,885.00**, debits **115.00**,
  credits **230.00**. The trial balance at 31 May has 1000 at a debit of
  4,885.00, and 5,000.00 + 115.00 - 230.00 = 4,885.00. Each line links to
  its invoice or bill.
- **ATX2** Account 4000, same range: opening **0.00**; 10 Apr "Invoice
  INV-0001" credit **100.00**, balance **-100.00**; 30 Apr "Invoice
  INV-0002" credit **50.00**, balance **-150.00**; 5 May "Void of invoice
  INV-0002" debit **50.00**, balance **-100.00**; closing **-100.00** (the
  trial balance's credit of 100.00).
- **ATX3** Every account, to 31 May with no start date (so from **1 Apr
  2026**): 1000 **4,885.00**, 1100 **0.00** (four lines), 2000 **0.00**,
  2100 **15.00** (Cr 15.00, Dr 30.00, Cr 7.50, Dr 7.50), 3000
  **-5,000.00** (opening only, no lines), 4000 **-100.00**, 6010
  **200.00**; nothing else is listed. Debits and credits in the range are
  both **805.00** (the six journals' totals), and every closing balance
  matches the trial balance at 31 May.
- **ATX4** Tracking (Advanced reporting on; Location Otago > Dunedin, and
  Canterbury): INV-0001 of 12 May has a line of 100.00 tagged Dunedin and a
  line of 40.00 tagged Canterbury, both to 4000. Account 4000 filtered to
  Location: **Otago**: one line, credit **100.00**, closing **-100.00**;
  filtered to Canterbury: credit **40.00**; unfiltered: both lines,
  closing **-140.00**. A value from another category is refused.
- **ATX5** Corrections: a manual journal "Fees" on 1 May, Dr 6010 **80.00** /
  Cr 1000 80.00, corrected on 10 May to 6100. Account 6010 for May: opening
  **200.00** (PS-101); 1 May "Manual journal Fees" debit **80.00**
  (**280.00**); 10 May "Reversal REV-Fees" credit **80.00** (**200.00**);
  closing **200.00**. Account 6100: 10 May "Replacement Fees" debit
  **80.00**. Each links to its journal.

### Not supported yet (refused rather than guessed)

- Filtering by contact or by source type, and exporting to CSV or Excel
  (the browser's print works).
- Foreign-currency amounts (journals are in the base currency).

## Journal report (examples not yet approved by Jess)

Written overnight from Xero's journal report; Jess hasn't approved it yet.
Every journal posted in a date range, oldest first (by date, then the order
they were posted), each with its lines (account, description, debit,
credit, tracking), where it came from (the document, payment, refund or
bank transaction, with a link, or the journal itself), and who posted it
and when. "Who" is the signed-in user stored on the journal when it's
posted, the same person as its `ledger.journal_posted` audit event; for a
document that's whoever approved, paid, voided or refunded it. Each journal
balances, so the report's debits equal its credits. At most 2,000 journals
are listed; the report says when there are more and asks for a shorter
range. Viewers can see it.

Setup: the account transactions setup (ATX).

- **JR1** 1 Apr - 31 May 2026: six journals, in order: 10 Apr "Invoice
  INV-0001" (Dr 1100 115.00 / Cr 4000 100.00 / Cr 2100 15.00); 20 Apr
  "Payment on invoice INV-0001" (Dr 1000 / Cr 1100 115.00); 25 Apr "Bill
  PS-101" (Dr 6010 200.00 / Dr 2100 30.00 / Cr 2000 230.00), posted by the
  **bookkeeper** who approved it; 30 Apr "Invoice INV-0002" (57.50); 5 May
  "Void of invoice INV-0002" (57.50 the other way); 15 May "Payment of bill
  PS-101" (230.00). Debits and credits both **805.00**. Each journal's
  "posted by" is the same user as its audit event.
- **JR2** From 1 Mar 2026 the OPEN journal (15 Mar, **5,000.00**, "Manual
  journal OPEN") comes first and the totals are **5,805.00**. 1-30 June has
  no journals (totals **0.00**). A start date after the end date is refused.
- **JR3** Corrections list the reversal and the replacement as their own
  journals (ATX5): 1 May "Manual journal Fees", 10 May "Reversal REV-Fees"
  and "Replacement Fees".

## GST audit report (examples not yet approved by Jess)

Step 5 of the NetSuite-style plan (TODO item 8), written overnight from
NetSuite's GST audit trail and IRD's record-keeping rules (records must show
how each return was worked out); Jess hasn't approved it yet. For a GST
period on the organisation's basis (or a filed return, as it was filed), it
lists every document and amount behind Box 5, Box 6 and Box 11, the Box 9
and Box 13 adjustments, and the boxes worked out from them (7, 8, 10, 12, 14,
15). It doesn't count anything itself: it groups the GST return's own counted
lines (G1-G22) into one entry per document per event (approved, voided, or
each payment, credit or refund on the payments and hybrid bases, with what
was settled of the document's total), so each box's list adds up to the box
to the cent. Lines left out of every box (no tax, exempt, out of scope,
zero-rated purchases) are listed separately. Viewers can see it.

Setup (invoice basis, Apr-May 2026; GST 15% and zero rated): INV-0001
(I1, **115.00**) 10 Apr; INV-0002 (I5: 100.00 standard + 50.00 zero rated,
**165.00**) 12 Apr; INV-0003 (no tax, **80.00**) 14 Apr; INV-0004
(**115.00**) 20 Apr, voided 15 May; CN-0001 (**23.00**) 5 May; spend money
**57.50** including GST (petrol) 3 Apr; bill S-1 (B1, **230.00**) 12 Apr;
supplier credit note CR-7 (**46.00**) 16 Apr.

- **GA1** Box 5 **257.00**: INV-0001 115.00, INV-0002 165.00 (2 lines),
  INV-0004 115.00 (approved 20 Apr) and **-115.00** (voided 15 May),
  CN-0001 **-23.00**. Box 6 **50.00**: INV-0002 50.00. Box 7 **207.00**,
  Box 8 **27.00**. Box 11 **241.50**: the spend money 57.50, S-1 230.00,
  CR-7 **-46.00**; Box 12 **31.50**. Box 15 **-4.50**. Left out: INV-0003
  **80.00**. Every figure equals the GST return for the same period.
- **GA2** With a Box 9 adjustment "Bad debt recovered" **3.00** and a Box 13
  "Change of use" **1.50**: both listed; Box 10 **30.00**, Box 14
  **33.00**, Box 15 **-3.00**, the same as the return with them.
- **GA3** Payments basis (G11): I5 dated 10 Apr and paid **82.50** on
  15 Apr; B1 paid **115.00** on 20 May. Box 5 **82.50**: one entry
  "Customer payment" of 82.50 settled of 165.00; Box 6 **25.00**; Box 11
  **115.00** ("Supplier payment", 115.00 of 230.00); Box 15 **-7.50**. On
  the hybrid basis the same documents give Box 5 **165.00** (INV-0001
  approved), Box 6 **50.00**, Box 11 **115.00**, Box 15 **0.00**.
- **GA4** A filed return is audited as it was filed: with I1 and B1 filed
  for Apr-May, a bill for **115.00** dated 10 May approved afterwards isn't
  in the filed return's Box 11 list (**230.00**, one entry), but is in the
  list worked out now (**345.00**, two entries).

### Not supported yet (refused rather than guessed)

- Adjustments are listed as typed (description and amount); there's no
  document behind them to link to.
- Exporting the audit report to a file (the browser's print works).

## Customer statements (examples not yet approved by Jess)

Written overnight from Xero's customer statements; Jess hasn't approved them
yet. Two kinds, for one customer:

- **Activity**, for a date range: the balance owed the day before the start
  (the same figure aged receivables gives at that date), each invoice,
  credit note, payment, refund and their voids in the range in date order,
  what each adds to or takes off the balance, and the closing balance.
  Payments are the whole amount received (an overpayment is part of it); a
  payment for several invoices is one line. Applying credit or an
  overpayment to an invoice moves nothing between the customer and the
  organisation, so it isn't a line.
- **Outstanding**, as at a date: each invoice still owed (its total and
  what's left), and each credit note or overpayment with credit not yet
  used (as a negative amount), and the balance.

Both end with the balance **aged** as at the statement's (end) date by each
invoice's due date (current, 1-30, 31-60, 61-90, over 90), less unused
credit, the same buckets as aged receivables. With **include
sub-customers**, a parent's statement covers it and every customer under it
(RC8), each line naming its customer. A contact that isn't a customer is
refused. Statements are printed (or saved as PDF) with the browser's print;
emailing them isn't built. Viewers can see them.

Setup (GST 15%): Kobe Group Ltd is the parent of Kobe Auckland and Kobe
Dunedin. Kobe Auckland: INV-0001 **230.00** dated 15 May 2026, due 15 Jun;
INV-0002 **115.00** dated 1 Jun, due 1 Jul; a payment of **100.00** on
INV-0001 on 10 Jun; CN-0001 **23.00** on 12 Jun (not applied); INV-0003
**57.50** dated 15 Jun, voided 20 Jun; a payment of **125.00** on INV-0002
on 25 Jun (**10.00** of it an overpayment); **11.50** of CN-0001 refunded on
28 Jun. Kobe Dunedin: INV-0004 **115.00** dated 20 Jun, due 20 Jul.

- **CST1** Kobe Auckland's activity statement, 1-30 June 2026: opening
  **230.00**; 1 Jun Invoice INV-0002 +115.00 (**345.00**); 10 Jun Payment
  on INV-0001 -100.00 (**245.00**); 12 Jun Credit note CN-0001 -23.00
  (**222.00**); 15 Jun Invoice INV-0003 +57.50 (**279.50**); 20 Jun Invoice
  INV-0003 voided -57.50 (**222.00**); 25 Jun Payment on INV-0002 -125.00
  (**97.00**); 28 Jun Refund of credit note CN-0001 +11.50 (**108.50**).
  Added **184.00**, taken off **305.50**, closing **108.50**. Ageing at
  30 June: 1-30 **130.00** (INV-0001, 15 days), credit **21.50**, total
  **108.50**, the same as Kobe Auckland on aged receivables at 30 June.
- **CST2** Kobe Auckland's outstanding statement as at 30 June 2026:
  INV-0001 (230.00, **130.00** left, 15 days overdue); CN-0001 (23.00,
  **-11.50**); overpayment on INV-0002 (10.00, **-10.00**); balance
  **108.50**, with the same ageing.
- **CST3** Kobe Group Ltd with sub-customers, 1-30 June: opening **230.00**
  (Kobe Auckland's); the CST1 lines plus 20 Jun Invoice INV-0004 +115.00
  (Kobe Dunedin); closing **223.50**; ageing current **115.00**, 1-30
  **130.00**, credit **21.50**, total **223.50**, the same as Kobe Group
  Ltd's rolled-up total on aged receivables at 30 June. Without
  sub-customers, Kobe Group Ltd's own statement is opening **0.00**, no
  lines, closing **0.00**.
- **CST4** Kobe Dunedin, 1-31 July: INV-0005 **57.50** dated 1 Jul, due
  31 Jul; one payment of **172.50** for INV-0004 and INV-0005 on 5 Jul,
  voided 8 Jul. Opening **115.00**; 1 Jul Invoice INV-0005 +57.50
  (**172.50**); 5 Jul Payment -172.50 (**0.00**); 8 Jul Payment voided
  +172.50 (**172.50**); closing **172.50**; ageing at 31 July: current
  **57.50**, 1-30 **115.00** (11 days), total **172.50**.
- **CST5** Refused: a statement for Paw Supplies (a supplier only: "isn't a
  customer"), and a start date after the end date. A viewer can open both
  kinds.

### Not supported yet (refused rather than guessed)

- Emailing statements (server email is only set up for security messages;
  needs Jess's decision), and statements for several customers at once.
- Foreign-currency statements (invoices are in the base currency).
- Showing credit and overpayments applied to invoices as lines (they don't
  change the balance, so they're left out, as in Xero's activity statement).

## Quotes (examples not yet approved by Jess)

Written overnight from Xero's quotes; Jess hasn't approved them yet. A quote
has the same lines as an invoice (items, units, price levels, tracking,
custom fields, tax exclusive, inclusive or no tax) and the same line maths
(I1-I6), plus an optional expiry date and terms. Quotes **post nothing**.

- A **draft** can be edited, copied and deleted.
- **Finalising** checks it again, gives it the next number (`QU-0001`,
  `QU-0002`, ...) from its own counter, with no gaps, and locks it: the
  database refuses changing a finalised quote or its lines, or deleting it.
- A finalised quote is then **accepted** or **declined**, once.
  **Accepting** is the step that makes the invoice: a draft invoice for the
  same customer carrying the quote's lines, amounts, custom fields and
  salesperson, dated the day chosen, due on the date given or else the
  customer's payment terms, with the quote's reference (or its number). The
  quote and invoice are linked both ways. **Declining** closes it.
- **Expired** isn't stored: a finalised quote past its expiry date shows as
  expired (and in its own list). It can still be accepted, as in Xero.
- There's no "sent" status: nothing sends quotes yet. Printing is
  "Print or save as PDF" (PD8).

Setup (GST 15%): customer Kobe Cafe with payment terms "20th of the
following month" and billing address "12 George St, Dunedin 9016".

- **QT1** Draft quote to Kobe Cafe dated 15 Jul 2026, expiring 14 Aug 2026,
  tax exclusive: 2 x Paw print pendant at **120.00** (GST) and 1 x Engraving
  at **35.00** (GST). Net **275.00**, GST **41.25**, total **316.25**. No
  journal is posted and it has no number.
- **QT2** Finalising QT1 makes it **QU-0001**; its lines and totals can't be
  changed (refused, and the database refuses too), and it can't be deleted.
  A second draft whose customer has since been archived is refused on
  finalising and stays a draft; the next quote finalised is **QU-0002** (no
  gap).
- **QT3** Accepting QU-0001 with invoice date 20 Jul 2026 makes a draft
  invoice to Kobe Cafe dated **20 Jul 2026**, due **20 Aug 2026** (terms),
  reference **QU-0001**, with the same two lines and total **316.25**. The
  quote is accepted and points to the invoice; the invoice points back to
  QU-0001. Accepting again with the same key returns the same invoice.
  Approving that invoice posts INV-0001: Dr 1100 **316.25** / Cr 4000
  **275.00** / Cr 2100 **41.25**, the same as any invoice.
- **QT4** Declining QU-0002 closes it; accepting it is then refused ("already
  declined"), and so is declining QU-0001 once accepted.
- **QT5** Expired: a finalised quote expiring 31 Jul 2026 shows as expired on
  1 Aug 2026 but not on 31 Jul; accepted or declined quotes, drafts and
  quotes without an expiry date never do.
- **QT6** Copying QU-0001 (quote date 15 Jul, expiry 14 Aug, 30 days) to
  1 Sep 2026 makes a new draft dated **1 Sep 2026** expiring **1 Oct
  2026**, with the same customer, lines and total **316.25**, no number, and
  "copied from" QU-0001. A copy is checked like a new quote: once Kobe Cafe
  is archived, copying QU-0001 again is refused.
- **QT7** The draft invoice made by accepting QU-0001 can't be deleted (so
  the quote keeps its invoice); it can be edited or approved and voided.
- **QT8** Refused: accepting or declining a draft, finalising twice, a quote
  with no lines, an expiry date before the quote date. A viewer can see and
  print quotes but not save them.

### Not supported yet (refused rather than guessed)

- Sending or emailing quotes (so no "sent" status), customer online
  acceptance, and quote templates or themes.
- Accepting part of a quote, or invoicing a quote in stages (deposits,
  progress invoicing): accepting makes one invoice for the whole quote.
- Linking a quote to a CRM opportunity. A won opportunity still makes its
  own invoice (CRM5).
- Foreign-currency quotes.

## Repeating invoices (examples not yet approved by Jess)

Written overnight from Xero's repeating invoices; Jess hasn't approved them
yet. A **template** holds a customer, invoice lines (as on an invoice), how
often (every N weeks or months), a start date, an optional end date, the due
date (the customer's payment terms, or N days after the invoice date) and
whether each invoice is **saved as a draft** or **approved**. Templates post
nothing.

- **Dates**: every N weeks is the start date plus 7 x N days each time.
  Every N months keeps the start date's day; a day the month doesn't have
  falls on the month's last day, and later months go back to the day (each
  date is worked out from the start date, not the date before).
- **The job** runs every hour on the server (and "Run now" on a template):
  for each active template it makes every scheduled date up to today that
  hasn't been made yet, oldest first. Each date gets one invoice dated that
  day, recorded in the template's history with a database key on (template,
  date), so running twice, or two runs at once, never makes two.
- **Approve automatically** approves each invoice as a person would: period
  locks, required tracking and custom fields and the credit limit apply. A
  refused approval leaves the draft and records why in the template's
  history. If the invoice can't be made at all (say the customer is
  archived), the template shows the error and tries that date again next
  run.
- **Pause** stops the job making invoices; **resume** carries on from the
  resume date (dates while it was paused aren't made). **End** is final.
  A template past its end date with every date made ends itself.

Setup (GST 15%): customer Kobe Cafe; each template has one line, 1 x
Monthly retainer at **100.00** tax exclusive (GST) to 4000, so each invoice
is **115.00**.

- **RI1** Monthly from 31 Jan 2026 falls on **31 Jan, 28 Feb, 31 Mar,
  30 Apr, 31 May** 2026. Saving the template posts nothing and makes no
  invoice.
- **RI2** Saved as drafts, due 20 days after: the job run on 5 Mar 2026
  makes two draft invoices, dated **31 Jan** (due 20 Feb) and **28 Feb** (due
  20 Mar), in that order, each 115.00, and the history lists both. Nothing
  is posted. The next date is **31 Mar 2026**.
- **RI3** Running again on 5 Mar 2026 makes nothing more; running on 31 Mar
  makes just the 31 Mar invoice, even when two runs start at once. The
  hourly job runs each template in its own transaction: with a second
  template for Paw Walkers (since archived), the job run on 5 Mar makes
  Kobe Cafe's two invoices and records "Paw Walkers is archived..." on the
  other template; running it again makes nothing more.
- **RI4** Approve automatically: the job run on 5 Mar 2026 makes and
  approves **INV-0001** (31 Jan) and **INV-0002** (28 Feb), each posting Dr
  1100 **115.00** / Cr 4000 **100.00** / Cr 2100 **15.00** on its own date.
- **RI5** Every 2 weeks from Monday 5 Jan 2026 ending 2 Feb 2026: **5 Jan,
  19 Jan, 2 Feb**. Run on 10 Feb it makes those three and the template
  ends itself.
- **RI6** Every 3 months from 31 Aug 2026: **31 Aug, 30 Nov** 2026, **28 Feb
  2027**, **31 May 2027**. Every month from 29 Jan 2028 (a leap year):
  **29 Jan, 29 Feb, 29 Mar**.
- **RI7** The RI2 template paused on 5 Mar: a run on 5 May makes nothing.
  Resumed on 10 May: the 31 Mar and 30 Apr dates are never made, and the
  next is **31 May 2026**. Ended: nothing more is made, and changing or
  resuming it is refused.
- **RI8** Changing the template's unit price to 120.00 on 5 Mar makes the
  31 Mar invoice **138.00**; the 31 Jan and 28 Feb invoices keep 115.00.
- **RI9** Approve automatically with the period locked to 31 Jan 2026: run on
  5 Mar, the 31 Jan invoice is **left as a draft** with "Left as a draft:
  2026-01-31 is in a locked period..." in the history, and 28 Feb is approved
  as **INV-0001**. With Advanced reporting, a credit limit of **150.00** set
  to block: the 31 Jan invoice is approved (115.00) and the 28 Feb one is
  left as a draft with the credit limit message. With Kobe Cafe archived,
  nothing is made, the template shows "Kobe Cafe is archived..." and the
  next run tries 31 Jan again.
- **RI10** Deleting the 31 Jan draft that RI2 made keeps the history line
  (shown as deleted), and later runs don't make 31 Jan again.

### Not supported yet (refused rather than guessed)

- Emailing each invoice (Xero's "approve for sending"): server email is only
  set up for security messages.
- Daily, yearly or "end of month" schedules (Xero has these); weeks and
  months cover them except daily.
- Placeholders in descriptions (Xero's [Month] [Year]).
- Foreign-currency templates.

## Printed invoices, credit notes and quotes (examples not yet approved by Jess)

Written overnight from Xero's invoice PDFs and IRD's taxable supply
information rules (in force from 1 April 2023); Jess hasn't approved them
yet. Each invoice, credit note and quote has a print page with "Print or
save as PDF" (the browser's print, as for statements). It stores and posts
nothing, and anyone who can see the document can print it. Settings has
three new fields for it: the organisation's **postal address**, **GST
number** and **payment details** (e.g. the bank account to pay into).

What appears when:

| Document | Heading | GST number | GST shown |
| --- | --- | --- | --- |
| Approved invoice, organisation has a GST number, amounts have tax | **Tax invoice** | Yes | Exclusive: a GST line; inclusive: "Total includes GST of $x" |
| Approved invoice, no GST number in Settings, or no-tax amounts | **Invoice** | No | None (no-tax), or as above |
| Draft invoice | **Draft invoice** (no number) | No | As above |
| Voided invoice | **Voided invoice** | No | As above |
| Approved credit note (same rules) | **Credit note** | When a tax credit note | As above |
| Quote | **Quote** (**Draft quote** before finalising) | No (not a tax document) | As above |

Every printed document shows the organisation's name and address, the
customer's name and billing address, the date, each line's description,
quantity, unit price, GST rate and amount, the subtotal, GST and total.
Invoices add the due date, and once approved, what's been paid or credited,
the amount due and the payment details. Quotes add the expiry date and
terms. Over **$1,000** including GST, a tax invoice or credit note must
identify the buyer by more than their name. Tohyee prints the customer's
billing address for this; if the customer has none the screen says so (the
paper can still be printed). Whether an email address, phone number or NZBN
should be printed instead is a question for Jess. If an invoice charges GST
but Settings has no GST number, the screen warns that it isn't a tax
invoice.

Setup: the organisation "Glimmers" with postal address "PO Box 5, Dunedin",
GST number **123-456-789** and payment details "Pay into 12-3456-7890123-00
with your invoice number"; customer Kobe Cafe with billing address "12
George St, Dunedin 9016"; customer Paw Walkers with no address; GST 15%.

- **PD1** INV-0001 (QT3's invoice, 316.25, approved): heading **Tax
  invoice**, number INV-0001, date 20 Jul 2026, due 20 Aug 2026, Glimmers,
  PO Box 5, GST number **123-456-789**, Kobe Cafe and its address, the two
  lines, subtotal **275.00**, GST **41.25**, total **316.25**, paid
  **0.00**, amount due **316.25**, and the payment details.
- **PD2** After a payment of 100.00 on INV-0001: paid **100.00**, amount
  due **216.25**.
- **PD3** An approved tax-inclusive invoice to Kobe Cafe for 1 x
  **1,150.00**: **Tax invoice**, total **1,150.00**, "Total includes GST of
  **150.00**", no separate GST line; over $1,000 so the buyer's address is
  required, and Kobe Cafe has one, so no warning.
- **PD4** The same invoice to Paw Walkers: the screen warns that a tax
  invoice over $1,000 needs the customer's address. At **1,000.00** exactly
  (1 x 1,000.00 tax inclusive, GST 130.43) there's no warning.
- **PD5** A draft invoice prints **Draft invoice** with no number, no GST
  number and no payment details; a voided invoice prints **Voided invoice**.
- **PD6** With no GST number in Settings, INV-0001 prints **Invoice**, no
  GST number, and the screen warns it isn't a tax invoice. A no-tax invoice
  prints **Invoice** with no GST lines and no warning.
- **PD7** An approved credit note CN-0001 to Kobe Cafe for 1 x 35.00
  exclusive: **Credit note**, GST number shown, subtotal 35.00, GST 5.25,
  total **40.25**, no due date and no payment details.
- **PD8** QU-0001: **Quote**, expiry 14 Aug 2026, terms, GST **41.25** and
  total **316.25**, no GST number and no payment details. A viewer can print
  it. Printing never posts a journal.

### Not supported yet (refused rather than guessed)

- Emailing documents, a logo and custom layouts (themes), and server-made
  PDF files: the browser's print makes the PDF.
- Printing several documents at once.
- Printing bills and supplier credit notes (they're the supplier's papers).

### Questions for Jess (quotes, repeating invoices and printed documents)

- Tax invoices over $1,000: Tohyee treats the billing address as the
  buyer's identifier and warns when there isn't one. Should an email
  address, phone number or NZBN count instead (and be printed)?
- Should approved invoices keep the heading **Tax invoice** (as Xero
  prints), or just **Invoice** with the GST number? The heading isn't
  relied on for anything else.
- Quotes have no "sent" status because nothing sends them. When emailing
  is built, should sending be what moves a quote on (as in Xero), and
  should finalising stay a separate step?
- Repeating invoices: should changing how often or the first date on a
  template that has already made invoices start the new schedule from
  today (as built), or ask?
- Should a repeating invoice run that's left as a draft (approval refused)
  notify someone, e.g. by email to the organisation's admins?

## Purchase orders (examples not yet approved by Jess)

Written overnight from Xero's purchase orders (draft, approve, copy to bill,
billed) and NetSuite's billing of purchase orders in parts; Jess hasn't
approved them yet. A purchase order goes to a **supplier** and has the same
lines as a bill (items, units, tracking, custom fields, tax exclusive,
inclusive or no tax) with the same line rules and maths (B1-B4): picking an
item fills the supplier's price (IT6), stock items go to the inventory
account (ST1). It also has an optional **delivery date**, **delivery
address** and **delivery instructions**, and a reference. Purchase orders
**post nothing** to the ledger.

- A **draft** can be edited and deleted.
- **Approving** checks it again as a bill would be checked (an active
  supplier, accounts, tax codes, items, required tracking and custom
  fields), gives it the next number (`PO-0001`, `PO-0002`, ...) from its own
  counter, with no gaps, and **locks** it: the database refuses changing an
  approved purchase order or its lines, or deleting it.
- **Copy to bill** makes a **draft bill** from the same supplier with what's
  left to bill on each line (ordered less what's on bills that aren't
  voided, drafts included), carrying the line's description, price,
  account, tax code, item, unit, tracking and custom fields. Each bill line
  points back to its purchase order line and the bill to its purchase
  order. The supplier's invoice number and due date are typed, as on every
  bill (suppliers have no payment terms in Tohyee). The draft bill can then
  be edited like any bill (fewer items delivered, a different price), and
  approving it posts the bill's journal as usual. **Stock comes in on the
  bill** (ST1); there's no separate goods received step.
- **Billed** is worked out from the linked bills, never stored or typed:
  per line, what's on **approved** bills is billed and what's on **draft**
  bills is shown separately. A purchase order is **billed** once approved
  bills cover every line. Voiding a bill, or deleting a draft one, puts its
  quantities back.
- A linked bill line keeps its purchase order line's **item and unit**, the
  bill keeps its **supplier**, and the bills that aren't voided never add
  up to **more than was ordered** on a line (anything extra goes on a line
  of its own). The database refuses all three too.
- **Cancelling** an approved purchase order is allowed only while it has no
  bills other than voided ones; it's then closed. Drafts are deleted, not
  cancelled.
- Printing is "Print or save as PDF", like quotes.

Setup (GST 15%): organisation Glimmers, postal address "PO Box 5, Dunedin";
supplier **Paw Supplies**, address "4 Wharf St, Port Chalmers"; item
**WIDGET** (stock, purchase price **5.00**, account 1400, GST) and item
**GIFTBOX** "Gift box" (non-stock, purchase price **2.00**, account 5100,
GST). No locations.

- **PO1** A draft purchase order to Paw Supplies dated 1 Jul 2026, delivery
  date 10 Jul 2026 to "12 Stuart St, Dunedin 9016", tax exclusive, with
  lines of only WIDGET x 10 and GIFTBOX x 100, is filled in as "Widget" 10 x
  **5.00** to 1400 (50.00) and "Gift box" 100 x **2.00** to 5100 (200.00):
  net **250.00**, GST **37.50**, total **287.50**. No journal is posted and
  it has no number. A delivery date before the order date is refused. With
  Advanced reporting on and Paw's own price of 4.80 for WIDGET (IT6), WIDGET
  fills at **4.80**.
- **PO2** Approving PO1 makes it **PO-0001**; editing it is refused (and the
  database refuses changing it or its lines), and so is deleting it. Still
  no journal. A second draft to a supplier that has since been archived is
  refused on approval and stays a draft; the next one approved is
  **PO-0002** (no gap).
- **PO3** Copying PO-0001 to a bill dated 12 Jul 2026, due 20 Aug 2026,
  supplier invoice **PS-101**, makes a draft bill from Paw Supplies with 10
  Widget @ 5.00 to 1400 and 100 Gift box @ 2.00 to 5100, total **287.50**,
  from PO-0001, each line linked to its purchase order line. PO-0001 shows
  10 and 100 on draft bills, 0 billed, nothing left, and is still
  **approved**; copying it again is refused ("already on bills"). The same
  copy retried with the same key returns the same bill. Approving the bill
  posts Dr 1400 **50.00** / Dr 5100 **200.00** / Dr 2100 **37.50** / Cr
  2000 **287.50** and brings in 10 Widgets worth 50.00 (ST1); PO-0001 then
  shows 10 and 100 billed and is **billed**.
- **PO4** Billing in parts: PO-0001 copied to bill PS-201, edited to 6
  Widgets and 40 Gift boxes (a part delivery) and approved, posts Dr 1400
  **30.00** / Dr 5100 **80.00** / Dr 2100 **16.50** / Cr 2000 **126.50**.
  PO-0001 shows 6 of 10 and 40 of 100 billed, 4 and 60 left, and is still
  approved. Copying again (PS-202) makes a draft with 4 Widgets (20.00) and
  60 Gift boxes (120.00): net **140.00**, GST **21.00**, total **161.00**.
  Once that's approved PO-0001 is **billed** (126.50 + 161.00 = 287.50).
- **PO5** Voiding PS-202 (after PO4) puts its 4 and 60 back: PO-0001 is
  approved again with 4 and 60 left, and copying again makes a new draft
  for them. Deleting that draft puts them back too.
- **PO6** On PS-201's draft, 11 Widgets is refused (only 10 were ordered);
  on PS-202's draft after PS-201 was approved with 6, 5 Widgets is refused
  ("at most 4"). Changing a linked line's item, changing the bill's
  supplier, and a bill line naming a purchase order line on a bill that
  wasn't copied from that purchase order are all refused (the database
  refuses them too). A line of its own, Freight 15.00 to 6010, can be
  added to the bill, and a linked line's price can be changed to 5.20 (the
  bill posts 5.20; the purchase order keeps 5.00, since billed counts
  quantities).
- **PO7** Cancelling: an approved purchase order with no bills is
  cancelled and can't then be copied to a bill. A draft can't be cancelled
  (it's deleted instead). A purchase order with a draft bill can't be
  cancelled (refused, and the database refuses too); after the draft bill
  is deleted it can.
- **PO8** Printing PO-0001: headed **Purchase order**, order number
  PO-0001, order date 1 Jul 2026, delivery date 10 Jul 2026, "Deliver to 12
  Stuart St, Dunedin 9016", Paw Supplies and its address, Glimmers and PO
  Box 5, the two lines, subtotal **250.00**, GST **37.50**, total
  **287.50**, and no GST number or payment details (it isn't a tax
  document). A draft prints **Draft purchase order** with no number; a
  cancelled one **Cancelled purchase order**. A viewer can print it.
  Printing never posts a journal.
- **PO9** Saving, approving, copying to a bill and cancelling each return
  the original when retried with the same key, and are refused (409) with
  the same key and different content. A viewer can list and open purchase
  orders but not save them. Across PO1-PO8 the only journals are the
  bills'.

### Not supported yet (refused rather than guessed)

- Emailing purchase orders (so no "sent" status), and Xero's separate
  "awaiting approval" step: a bookkeeper saves and approves.
- Changing an approved purchase order (Xero allows editing): cancel it, if
  it has no bills, and make a new one.
- Closing a part-billed purchase order when the rest will never come (Xero's
  "mark as billed"): it stays approved with what's left shown. Billing more
  than was ordered on a line (put the extra on a line of its own).
- Receiving goods without a bill (goods received notes, NetSuite's item
  receipts): stock comes in when the bill is approved (ST1).
- Copying a purchase order to a new purchase order, making one from a sales
  invoice or quote, and foreign-currency purchase orders.

### Questions for Jess (purchase orders)

- A part-billed purchase order whose rest will never arrive stays
  "approved" with what's left showing. Should there be a way to close it
  (Xero's "mark as billed"), and should that be allowed only when nothing is
  on a draft bill?
- Should approved purchase orders be editable (Xero allows it) as long as
  nothing has been billed, rather than cancel and make a new one?
- Should a bill be allowed to take more than was ordered on a purchase order
  line (the supplier sent extra), or is a separate line right, as built?
- New purchase orders start with the organisation's postal address as the
  delivery address. Would a separate "delivery address" setting (a shop or
  warehouse) be better?

## Stock transfers between locations (examples not yet approved by Jess)

Written overnight from NetSuite's inventory transfers and the weighted
average rules already approved (W1-W12, ST1-ST12); Jess hasn't approved
them yet. A transfer moves a quantity of a **stock item** (in its base
unit) from one location to another on a date:

- It leaves the **from** location at that location's weighted average,
  exactly as stock going out does (W1-W4): quantity x value / quantity on
  hand, rounded once to cents, and the **whole remaining value** when
  everything left there is moved. It arrives at the **to** location at that
  same value, so the to-location's average becomes a mix of the two.
- The inventory account's **total never changes**, and nothing goes to cost
  of sales. Because bills tag their inventory lines with the line's
  Location (ST1), the inventory account does carry Location tags, so a
  transfer posts one journal on its date that moves the value between the
  locations: **Dr 1400 tagged with the to-location / Cr 1400 tagged with the
  from-location**. Its two stock movements ("transferred out" and
  "transferred in") point at that journal and at the transfer. (Cost of
  sales lines on 1400 aren't tagged, ST2, so 1400 by Location in the ledger
  doesn't yet equal stock by location; that's a question for Jess below.)
- The **negative stock** setting applies to the from-location as it does to
  sales (ST9-ST11). Stock can't come into a location that's **below zero**
  by transfer, since only a bill costs a shortfall (ST10).
- Transfers are never changed or deleted (the database refuses); a
  transfer back undoes one. The period lock applies to the date.

Setup: Advanced reporting on, Location values Dunedin, Auckland and
Christchurch; WIDGET (stock, purchase price 5.00); negative stock off.

- **TR1** After a bill of 10 WIDGET @ 5.00 into Dunedin (ST1: Dunedin 10
  worth 50.00), transferring **4** from Dunedin to Auckland on 15 Jun 2026
  moves **20.00**: journal on 15 Jun Dr 1400 [Auckland] **20.00** / Cr 1400
  [Dunedin] **20.00**. Dunedin **6 worth 30.00**, Auckland **4 worth
  20.00**; 1400 still **50.00**; no cost of sales. The movements show
  Dunedin -4 (-20.00) and Auckland +4 (+20.00), both with that journal.
- **TR2** A bill of 3 @ 3.3333 into Dunedin (10.00): transferring 1 moves
  **3.33**, then transferring the other 2 moves the remaining **6.67**
  (W3, W4). Dunedin 0 worth 0.00; Auckland 3 worth **10.00**.
- **TR3** Dunedin 10 worth 50.00 and Auckland 10 worth 70.00: transferring
  4 from Dunedin makes Auckland **14 worth 90.00**; selling 1 from Auckland
  then costs **6.43** (90.00 / 14), leaving Auckland 13 worth 83.57.
  Dunedin stays 6 worth 30.00.
- **TR4** Dunedin 2 worth 10.00, negative stock off: transferring 3 is
  **refused** ("Only 2 on hand"). With negative stock on it moves **15.00**
  (3 at the 5.00 average), leaving Dunedin **-1 worth -5.00** and Auckland
  3 worth 15.00; a transfer back into Dunedin while it's below zero is
  refused.
- **TR5** Refused, with nothing moved: the same location at both ends, a
  quantity of 0, a non-stock item, a date before the item's latest
  movement at either location (backdating, as W's rules), an archived
  destination, a date in a locked period, and an organisation with no
  locations set up.
- **TR6** A retry with the same key returns the same transfer; the same
  key with a different quantity is refused (409). After TR1's transfer the
  bill into Dunedin can't be voided (its stock has moved since, ST4's
  rule). A viewer can list transfers but not make one. Across TR1-TR6
  stock equals account 1400 to the cent (tested).

### Not supported yet (refused rather than guessed)

- Voiding or editing a transfer: make a transfer back.
- Transfers in transit (NetSuite's transfer orders with a ship and receive
  step), several items in one transfer, and transfers in a unit other than
  the item's base unit.
- Backdated transfers (as for every stock movement).

### Questions for Jess (stock transfers)

- Transfers post a journal between locations on 1400 (Dr to-location / Cr
  from-location) because bills tag 1400 by Location. Cost of sales lines
  on 1400 aren't tagged by location (ST2), so 1400 filtered by Location in
  the ledger won't equal the stock report by location. Should all 1400
  lines carry the location (a change to ST2's journals), or should
  transfers post nothing and stock by location live only in the stock
  report?
- Should a transfer into a location that's below zero be allowed (filling
  the shortfall at the transferred cost, with the difference to cost of
  sales like ST10), rather than refused?

## Budgets (examples not yet approved by Jess)

Written overnight from Xero's budget manager; Jess hasn't approved them yet.
Every organisation has an **overall budget**, which can't be archived, and
can add **named budgets**, each optionally for **one tracking value** (a
Department, or a not-for-profit's grant or segment as a custom segment). A
budget holds an **amount per profit and loss account per month**, in the
account's natural direction (income as credits, costs as debits, so both are
typed as positive amounts), with at most the currency's decimal places.
Budgets **post nothing** and never change a ledger figure.

- Amounts are typed, or **quick filled** for chosen accounts over chosen
  months: the **same amount each month**, optionally changing by a % each
  month (worked out exactly and rounded once per month, so rounding never
  compounds, like Xero's "adjust by % each month"), or **last year's
  actuals** for the same months (filtered to the budget's tracking value
  when it has one), optionally changed by a % (each month rounded once,
  halves away from zero). A quick fill replaces those months' amounts.
- Only **profit and loss accounts** (revenue, other income, direct costs,
  expenses, depreciation) take budget amounts; the database refuses others.
- Budgets are **archived**, never deleted (the database refuses deleting a
  budget or an amount; an amount is set to 0.00 instead). An archived budget
  can't change until it's brought back. Names are unique among budgets that
  aren't archived, ignoring case. A budget's tracking value never changes.
- Every change of amounts is in the history with the amounts before and
  after, and who changed them. Budgets are saved against the version that was
  loaded, so two people can't overwrite each other's changes.
- **Budget vs actual** (Reporting): for whole months, each profit and loss
  account's actual (from the ledger, like the profit and loss, and only lines
  tagged with the budget's value or one under it when it has one), budget,
  **variance** (actual less budget) and **variance %** (variance / budget,
  1 decimal place, halves away from zero, blank when the budget is 0.00),
  with section totals, gross profit and net profit. A positive variance on a
  cost means it's **over** budget.
- **Budget column in custom reports** (TODO item 4): a profit and loss custom
  report can show a chosen budget for its first period, and an **actual less
  budget** column. A published copy keeps the budget figures as they were.

Setup: the starting chart, a 31 March year end, Advanced reporting on,
Department values Retail and Wholesale, and these journals (through 1000;
the 4000 lines tagged as shown, everything else untagged):

| Date | Journal |
| --- | --- |
| 1 Apr, 1 May, 1 Jun 2025 | Dr 6150 Rent 500.00 / Cr 1000 (each) |
| 10 Apr 2025 | Dr 1000 1,000.00 / Cr 4000 700.00 (Retail) / Cr 4000 300.00 (Wholesale) |
| 12 May 2025 | Dr 1000 1,200.00 / Cr 4000 1,200.00 (Retail) |
| 9 Jun 2025 | Dr 1000 800.00 / Cr 4000 800.00 (Wholesale) |
| 1 Apr, 1 May, 1 Jun 2026 | Dr 6150 500.00 / Cr 1000 (each) |
| 10 Apr 2026 | Dr 1000 1,100.00 / Cr 4000 800.00 (Retail) / Cr 4000 300.00 (Wholesale) |
| 12 May 2026 | Dr 1000 1,000.00 / Cr 4000 1,000.00 (Retail) |
| 8 Jun 2026 | Dr 1000 1,300.00 / Cr 4000 1,000.00 (Retail) / Cr 4000 300.00 (Wholesale) |
| 20 Jun 2026 | Dr 6010 Accounting fees 250.00 / Cr 1000 |

- **BU1** A new organisation has one budget, **Overall budget**, which
  can't be archived (the database refuses too). A named budget "Retail
  plan" for Department: Retail is added; a second "retail plan" is refused
  while the first isn't archived. With Advanced reporting off a budget can't
  have a tracking value, and an archived value can't be chosen. Archiving
  Retail plan moves it to the archived list; while archived its amounts
  can't change; bringing it back works. The database refuses deleting a
  budget and changing its tracking value. No journals are posted.
- **BU2** Typing the overall budget's amounts: 4000 Apr 2026 **1,000.00**,
  May **1,000.00**, Jun **1,200.00**; 6150 **500.00** for each of Apr-Jun
  2026; 6010 Jun 2026 **200.00**. The grid for 12 months from Apr 2026 shows
  4000's total **3,200.00** and a total for Apr of **1,500.00**. The history
  shows each amount changed from 0.00. Refused, with nothing saved: account
  1000 (not a profit and loss account; the database refuses too), 10.005
  (three decimal places), a month "2026-13", the same account and month
  twice, and a save against an older version. The database refuses deleting
  an amount.
- **BU3** Quick fill, same amount: 6150 at **500.00** for 12 months from
  Apr 2026 makes every month 500.00 (total **6,000.00**). With **+2%** each
  month the first six months are **500.00, 510.00, 520.20, 530.60, 541.22,
  552.04** (500.00 x 1.02^n, each rounded once).
- **BU4** Quick fill, last year's actuals, Apr-Jun 2026 on the overall
  budget: 4000 becomes **1,000.00, 1,200.00, 800.00**; with **+10%**,
  **1,100.00, 1,320.00, 880.00**; 6150 with **-5%**, **475.00** each month.
  On Retail plan (Department: Retail) 4000 becomes **700.00, 1,200.00,
  0.00**, only last year's Retail lines.
- **BU5** Budget vs actual, the overall budget (BU2), Apr-Jun 2026:

  | Row | Actual | Budget | Variance | % |
  | --- | ---: | ---: | ---: | ---: |
  | 4000 Sales | 3,400.00 | 3,200.00 | 200.00 | 6.3 |
  | Gross profit | 3,400.00 | 3,200.00 | 200.00 | 6.3 |
  | 6010 Accounting fees | 250.00 | 200.00 | 50.00 | 25.0 |
  | 6150 Rent | 1,500.00 | 1,500.00 | 0.00 | 0.0 |
  | Expenses | 1,750.00 | 1,700.00 | 50.00 | 2.9 |
  | Net profit | 1,650.00 | 1,500.00 | 150.00 | 10.0 |

  For June alone: Sales **1,300.00 / 1,200.00 / 100.00 / 8.3**, Expenses
  **750.00 / 700.00 / 50.00 / 7.1**, Net profit **550.00 / 500.00 / 50.00 /
  10.0**. An account with actuals and no budget shows a blank %. A 'from'
  month after the 'to' month is refused.
- **BU6** Budget vs actual for Retail plan with 4000 at **900.00** for each
  of Apr-Jun 2026: actual **2,800.00** (Retail lines only: 800.00 + 1,000.00
  + 1,000.00), budget **2,700.00**, variance **100.00**, **3.7**%. Rent and
  fees aren't tagged Retail, so they aren't in it; net profit **2,800.00 /
  2,700.00 / 100.00 / 3.7**.
- **BU7** A custom profit and loss (CR1) for June 2026 with a budget column
  (the overall budget, BU2) and actual less budget: Revenue **1,300.00 |
  1,200.00 | 100.00**, Expenses **750.00 | 700.00 | 50.00**, Net profit
  **550.00 | 500.00 | 50.00**. With one quarterly column (Apr-Jun 2026) the
  budget column is the three months: Revenue budget **3,200.00**, Net profit
  **1,650.00 | 1,500.00 | 150.00**. Publishing keeps the figures: after June's
  4000 budget changes to 1,250.00 the draft's Revenue budget is **1,250.00**
  and the published copy's still **1,200.00**. Refused: a budget column on a
  balance sheet, an actual less budget column without a budget column, and a
  budget that doesn't exist.
- **BU8** Viewers can list and open budgets and budget vs actual; only
  bookkeepers and admins can add, change, fill and archive them. Across
  BU1-BU8 budgets post no journals.

### Not supported yet (refused rather than guessed)

- **Balance sheet budgets** (Xero has them): budgets hold profit and loss
  accounts only, and the database refuses others.
- A budget for **more than one tracking value** (Xero allows two
  categories): one value per budget.
- Importing and exporting budgets (Xero's CSV), and budget columns on the
  standard profit and loss (they're on custom reports and budget vs actual).
- A budget column for a period other than the custom report's first column,
  and a year to date budget column.

### Questions for Jess (budgets)

- Variance is actual less budget for every row, so on costs a positive
  variance is over budget. Would you rather costs show budget less actual
  (so positive is always good), as some reports do?
- Should budgets also cover balance sheet accounts, as Xero's do?
- Is one tracking value per budget enough for grants and segments, or do
  you need a budget for a combination (e.g. a Department and a Grant)?

## Expense claims (examples not yet approved by Jess)

Written overnight from Xero's (older) expense claims and Tohyee's own bill
and supplier payment rules (B1-B8, SP1-SP8); Jess hasn't approved them yet.
A member (bookkeeper or above) enters the **receipts** they paid for
themselves: date, supplier's name, description, account, tax code and the
amount **including GST**, with optional tracking, and attaches photos or
PDFs of the receipts as files (NF7). The claim is theirs: who made it comes
from the sign-in, never the form.

- A **draft** can be changed or deleted by its claimant only. Receipts go to
  the accounts a bill line can use (B1), except the inventory account (stock
  comes in on bills) and expense claims payable. GST is worked out and
  rounded per receipt from the tax inclusive amount, as on bills (B2). A
  receipt with **no tax code** has no GST: that's how a receipt that isn't a
  valid GST receipt (or a supplier that isn't GST registered) is entered.
- **Submitting** sends it for approval; it then can't be changed (the
  database refuses) until it's approved or declined.
- **Declining** (bookkeeper or above) returns a submitted claim to its
  claimant as a draft, with a reason; it posts nothing.
- **Approving** (bookkeeper or above, but not your own claim unless you're an
  admin or owner) posts one journal on the **claim date** (typed, on or after
  the latest receipt): Dr each receipt's account for its amount excluding GST
  (one line per account and set of tags), Dr GST (2100) for the GST, Cr
  **Expense claims payable** (2010, a new system account; organisations that
  already had a 2010 get the next free code) for the total. Its reference is
  `CLAIM-` and the claim's id.
- **Paying** (in full or in part) posts Dr expense claims payable / Cr the
  bank account on the payment date, like a supplier payment (SP1); it can't
  be more than what's due or dated before the claim. A payment can be voided
  (the exact reversal). What's paid and due is worked out from the payments.
  The bank line matches a statement line in reconciliation like any payment.
- **Voiding** an approved claim with no active payments posts the exact
  reversal on the void date (the database refuses voiding one with active
  payments). Locked periods apply to approving, paying and voiding.
- The **GST return** counts claims like bills: on the invoice basis on the
  claim date (and back on the void date), on the payments and hybrid bases
  when they're paid, each receipt in proportion. Receipts with no tax code
  are left out of the boxes. Filed lines from claims have no contact; they
  show the claimant.
- Claim journals can't be corrected in the ledger; the claim is voided.

Setup: the starting chart, tax code GST (15%), members Jess (owner), Aroha
and Sam (bookkeepers) and a viewer. Sam's claim "June market trip":

| Receipt | Supplier | Account | Tax | Amount | GST | Net |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 3 Jun 2026 | Z Energy, fuel | 6120 Motor vehicle expenses | GST | 69.00 | 9.00 | 60.00 |
| 5 Jun 2026 | Paper Plus, printer paper | 6140 Printing and stationery | GST | 23.00 | 3.00 | 20.00 |
| 6 Jun 2026 | Farmers market, parking | 6180 Travel - national | none | 8.00 | 0.00 | 8.00 |

- **EC1** The draft's total is **100.00**, GST **12.00**, excluding GST
  **88.00**, and posts nothing. Refused: receipts to 1400 (stock), 1000
  (bank), 2010 (expense claims payable) and 2100 (GST), an amount of 0.00 or
  1.001, an unknown tax code, no supplier name. Aroha can't change or delete
  Sam's draft; Sam can (without the parking, 92.00 / GST 12.00). A new
  organisation has 2010 Expense claims payable; an existing one whose 2010 is
  taken gets 2011.
- **EC2** A claim with no receipts can't be submitted. Once submitted it
  can't be changed or deleted (the database refuses changing its receipts
  or deleting it), and it's listed as awaiting approval. Nothing is posted.
- **EC3** Aroha approves it with claim date **10 Jun 2026**: journal
  `CLAIM-n` on 10 Jun, Dr 6120 **60.00** / Dr 6140 **20.00** / Dr 6180
  **8.00** / Dr 2100 **12.00** / Cr 2010 **100.00**. Due **100.00**,
  **unpaid**. Sam (a bookkeeper) can't approve his own claim; Jess (owner)
  can approve hers. A claim date of 5 Jun (before the 6 Jun receipt) is
  refused. A retry with the same key returns the same claim; the same key
  with another date is refused. The database refuses changing an approved
  claim.
  The journal's description is "Expense claim CLAIM-n from Sam" and its
  expense and 2010 lines say "Sam": the claimant's **name**, not their
  email (the email only if they can't be found); paying is "Payment of
  expense claim CLAIM-n to Sam". Journals posted before this was changed
  keep the email they were posted with (posted history isn't rewritten).
- **EC4** Paying **100.00** from 1000 on 15 Jun 2026 posts Dr 2010
  **100.00** / Cr 1000 **100.00**: due **0.00**, **paid**, 2010 back to
  **0.00**. A statement line of -100.00 on 15 Jun matches that bank line
  exactly and reconciles.
- **EC5** Paying **40.00** leaves **60.00** due (**part paid**, awaiting
  payment); 60.01 and a payment dated 9 Jun (before the claim date) are
  refused (the database refuses paying more than the total too); 60.00 more
  makes it **paid**, and a retry with the same key returns the same payment.
  Voiding the 60.00 payment on 20 Jun posts Dr 1000 **60.00** / Cr 2010
  **60.00**; due **60.00** again. A second void, and deleting a payment, are
  refused.
- **EC6** Declining needs a reason. Aroha declines it ("Parking isn't
  claimable"): it's a **draft** again showing the reason, who declined it
  and when. Sam removes the parking and resubmits (**92.00**); it can then
  be approved. Declining a draft or an approved claim is refused. The
  claim's history shows it was made, submitted, declined and approved.
- **EC7** Voiding the approved claim while it has an active payment is
  refused ("Void its payments first"); after the payment is voided, voiding
  on 30 Jun posts Dr 2010 **100.00** / Cr 6120 **60.00** / Cr 6140 **20.00**
  / Cr 6180 **8.00** / Cr 2100 **12.00**. A second void, a void dated before
  the claim date and paying a voided claim are refused.
- **EC8** With the period locked to 30 Jun, approving with claim date 10 Jun
  is refused and the claim stays submitted; approving on 1 Jul works; with
  the lock moved to 1 Jul, paying and voiding on 1 Jul are refused. Only the
  approval posted.
- **EC9** With Department required, submitting a claim whose receipt has
  no Department is refused ("Line 1 needs a Department"); a receipt tagged
  Retail posts its 6120 line tagged Retail, and the GST and 2010 lines
  untagged.
- **EC10** GST return for June 2026, invoice basis: the claim counts on 10
  Jun, Box 11 **92.00** (69.00 + 23.00; the parking has no tax code and is
  left out), Box 12 **12.00**; each line shows the supplier and description
  and the claimant; filed, its lines keep the claimant and no contact.
  Payments basis for July: nothing until it's paid; after **40.00** is paid
  on 15 Jul, Box 11 **36.80** and Box 12 **4.80** (40% of each receipt). A
  second claim approved and voided in June adds nothing.
- **EC11** A PDF of a receipt attached to the claim is listed with it.
  Viewers can list and open claims but can't make them (403); a claim made
  through the API belongs to whoever is signed in.
- **EC12** The approval and payment journals can't be corrected in the
  ledger (void the claim or the payment), and account transactions for 2010
  show them as "Expense claim CLAIM-n" and "Payment of expense claim
  CLAIM-n", linking to the claim.

### Not supported yet (refused rather than guessed)

- **Viewers making their own claims** (Xero's "submit only" role): only
  bookkeepers and above can make claims, since viewers can't change
  anything today.
- **Mileage claims** (a rate per kilometre), **foreign-currency receipts**,
  and receipts on **stock items** (they come in on bills).
- **One payment for several claims** (a batch), and paying claims through a
  bank file.
- Checking what a valid GST receipt needs (IRD's taxable supply
  information: the supplier's GST number over $200, and so on): the claimant
  or approver chooses "No GST" when it isn't one.
- Changing an approved claim: void it (with no payments) and make a new
  one.

### Questions for Jess (expense claims)

- Should staff who otherwise only view the books be able to make their own
  claims (a new "submit only" role, like Xero's)?
- A bookkeeper can't approve their own claim, but an admin or owner can
  (so a one-person organisation still works). Is that right, or should
  nobody approve their own claim?
- Should Tohyee check the GST receipt rules (e.g. require the supplier's
  GST number on receipts over $200) before GST is claimed?
- Is 2010 "Expense claims payable" a good code, or would you rather claims
  go to accounts payable (2000) as Xero's newer expenses do?
- Should the claim date default to the approval date (as built) or the
  latest receipt's date?

## Fixed assets (examples not yet approved by Jess)

Written overnight from Xero's fixed asset register and NZ practice; Jess
hasn't approved them yet. **Tohyee has no built-in IRD depreciation rates,
asset classes, low-value thresholds, pool or building rules.** The
organisation types the method and annual rate for each asset type (and can
change them per asset); check IRD's current rates and rules before entering
them. The rates below are just the example's.

- **Asset types** (admins) say which accounts an asset uses: its **asset
  account** (cost) and **accumulated depreciation account** (fixed or
  non-current asset accounts, not the same one), and its **depreciation
  expense account** (an expense account), with a default method and rate.
  Types are archived, never deleted, and their accounts can't change once
  they have assets. The starting chart already has 1600-1650 and 6300
  Depreciation; new system accounts **7030 Gain or loss on disposal of fixed
  assets** and **7040 Capital gains on disposal of fixed assets** (other
  income) are the default for disposals (existing organisations get them at
  that code or the next free one).
- **Registering an asset posts nothing**: its cost is already in the ledger
  from the bill, bank transaction or opening journal that bought it. An
  asset can name the **approved bill line** it came from (on its type's
  asset account); the cost defaults to what's left of the line excluding GST,
  and assets from one line never cost more than it. A bill with a registered
  asset can't be voided until the asset is archived. Numbers are
  `FA-0001`, with no gaps. An asset brought in from another register has an
  **opening balance date** (a month end) and the **accumulated depreciation**
  at that date; depreciation starts the month after.
- **Methods**, charged in whole months: **diminishing value (DV)** is the
  book value at the start of the financial year (or when the asset's
  depreciation started, if later) x rate x months / 12; **straight line
  (SL)** is cost x rate x months / 12; **no depreciation** (e.g. land) charges
  nothing. Neither takes the book value below the **residual value** (0
  unless set). Each financial year's figure so far is rounded once, half
  away from zero, and a run charges it less what's already been charged that
  year, so monthly runs add up exactly to one run for the year (a run
  spanning two financial years rounds once for each).
- **Part months** are a setting (admins). The month an asset is bought
  **counts as a whole month** (the default: our understanding of IRD's
  guidance is that the month of purchase counts in full, but check it) or
  isn't depreciated. The month it's disposed of **isn't depreciated** (the
  default) or counts as a whole month. Changing them affects only
  depreciation worked out afterwards.
- A **depreciation run** (bookkeepers) to a month end charges each
  registered asset for the months since it was last charged (so an asset
  registered late catches up) and posts **one journal** on the month end,
  reference `DEP-YYYY-MM`: Dr depreciation expense / Cr accumulated
  depreciation, one pair per asset type (and set of tracking tags, from the
  asset), types in name order. Runs go forward: each is after the last
  active run; none in a locked period. The **latest** run can be **rolled
  back** (the exact reversal on its own date, which must be open), then run
  again. Idempotent.
- A **disposal** (bookkeepers) of a registered asset, dated after the last
  run (roll the run back to dispose earlier), posts on the disposal date:
  depreciation for the months since it was last charged (by the disposal
  month setting), Dr accumulated depreciation / Cr cost to take it off, Dr
  the **proceeds** excluding GST out of the account the sale was coded to
  (any account but bank, card, receivables, payables, GST, expense claims
  payable and stock), and the difference: proceeds above book value up to
  cost are **depreciation recovered** (Cr the gain or loss account), above
  cost a **capital gain** (Cr the capital gain account), below book value a
  **loss** (Dr the gain or loss account). A write-off has no proceeds. An
  asset is disposed of once; the disposal can be **undone** (the exact
  reversal on the disposal date), and a run it was worked out from can't be
  rolled back until it is.
- After depreciation or a disposal, only an asset's name, description and
  tracking change; before, anything can, and an asset registered by mistake
  is archived (never deleted). Runs, disposals and their journals can't be
  corrected in the ledger.
- The **register** as at a date lists each asset held with cost,
  accumulated depreciation, book value and this financial year's
  depreciation, grouped by type with totals; assets disposed of this year
  apart with their gain or loss; and, per asset and accumulated depreciation
  account, the register beside the ledger balance and the difference
  (e.g. from a manual journal to one of them).

Setup: the starting chart, 31 March year end, tax code GST (15%), Jess
(owner) and Aroha (bookkeeper). Asset types:

| Type | Asset | Accumulated | Expense | Default |
| --- | --- | --- | --- | --- |
| Computer equipment | 1620 | 1630 | 6300 | DV 50% |
| Motor vehicles | 1640 | 1650 | 6300 | DV 30% |
| Office equipment | 1600 | 1610 | 6300 | SL 20% |

Assets:

| Asset | Bought | Cost | Method | How the cost got to the ledger |
| --- | --- | ---: | --- | --- |
| FA-0001 Laptop | 10 May 2026 | 2,000.00 | DV 50% | PB Tech bill PB-7781, 2,300.00 incl. GST to 1620 |
| FA-0002 Desk | 1 Apr 2026 | 1,200.00 | SL 20% | journal Dr 1600 / Cr 1000 |
| FA-0003 Printer | 1 Jul 2023 | 1,500.00 | DV 40% (not the type's) | opening journal 31 Mar 2026: Dr 1600 1,500.00 / Cr 1610 900.00 / Cr 3000 600.00; opening accumulated depreciation 900.00 at 31 Mar 2026 |
| FA-0004 Ute | 20 Jun 2026 | 30,000.00 | DV 30% | journal Dr 1640 / Cr 2800, registered after the May run |

- **FA1** Types as above; also Land (no depreciation, no rate). Refused: an
  asset account that isn't a fixed asset account (6070), the same account
  for cost and accumulated depreciation, an expense account that isn't an
  expense (1000), a rate of 0 or 101, no rate for DV, a rate for no
  depreciation, a second active "Motor vehicles". A bookkeeper can't add
  types (403); a viewer can list them. Types can't be deleted (archived). A
  new organisation has 7030 and 7040; an existing one whose 7030 is taken
  gets 7031 and 7040, and the settings default to "whole month" and "not
  depreciated".
- **FA2** Registering the laptop from its bill line: cost **2,000.00** (the
  line excluding GST), bought **10 May 2026** (the bill date), DV 50% (the
  type's), `FA-0001`, book value **2,000.00**; no journal is posted and 1620
  stays **2,000.00**. Refused: a cost of 2,000.01 from that line, the line
  for a Motor vehicles asset (it's on 1620), and once registered any more
  from the line (the database refuses too). Voiding the bill is refused
  ("registered as fixed asset FA-0001"); after archiving the asset it can
  be voided. Typed in, refused: no cost, no purchase date, a residual value
  above the cost, opening depreciation with no date, an opening date that
  isn't a month end or is before the purchase, opening depreciation above
  the cost, DV/SL with no rate. The desk is `FA-0002` (no gap), a section of
  land with no depreciation `FA-0003`. A retry with the same key returns the
  same asset.
- **FA3** Run to **31 May 2026**: laptop May **83.33** (2,000.00 x 50% x
  1/12 = 83.333...), desk Apr-May **40.00** (1,200.00 x 20% x 2/12), printer
  Apr-May **40.00** (600.00 book value x 40% x 2/12). Journal `DEP-2026-05`
  on 31 May: Dr 6300 **83.33** / Cr 1630 **83.33** / Dr 6300 **80.00** / Cr
  1610 **80.00**, total **163.33**. Laptop book value **1,916.67**; printer
  accumulated **940.00**. A run to 15 Jun is refused (not a month end). In
  the maths: a printer run straight to 30 Apr 2027 charges **240.00** for
  the year to 31 Mar 2027 and **12.00** for April 2027 (360.00 x 40% x
  1/12); a tool costing 1,000.00, residual 400.00, SL 50%, charges 500.00,
  then 83.33, then **16.67** (not 41.67), then 0.00.
- **FA4** After registering the ute, run to **30 Jun 2026**: laptop
  **83.34** (2 months so far 166.67, less 83.33), desk **20.00**, printer
  **20.00**, ute **750.00** (30,000.00 x 30% x 1/12; June counts in full).
  Journal: Dr 6300 **83.34** / Cr 1630 / Dr 6300 **750.00** / Cr 1650 / Dr
  6300 **40.00** / Cr 1610, total **873.34**. A retry returns the same run;
  the key for another date is refused. Refused: another run to 30 Jun or 31
  May (the database refuses an earlier run too), deleting a run, changing
  its lines, and a run to 31 Jul once July is locked.
- **FA5** Rolling back May while June stands is refused. Rolling back June
  posts `VOID-DEP-2026-06` on **30 Jun**: the exact reversal (Dr 1630
  **83.34** / Cr 6300, Dr 1650 **750.00** / Cr 6300, Dr 1610 **40.00** / Cr
  6300); 1650 is **0.00**; a second rollback is refused; running June again
  gives **873.34**. With June locked, rolling that run back is refused.
- **FA6** A **monitor** (FA-0005, Computer equipment, 600.00, bought 20 May
  2026) registered after the June run. Run to **31 Aug 2026** (two months):
  laptop **166.66** (4 months 333.33 less 166.67; the same as 83.33 +
  83.33 monthly), desk **40.00**, printer **40.00**, ute **1,500.00**,
  monitor May-Aug **100.00** (catching up). Journal: Dr 6300 **266.66** / Cr
  1630, Dr 6300 **1,500.00** / Cr 1650, Dr 6300 **80.00** / Cr 1610, total
  **1,846.66**.
- **FA7** With "the month an asset is bought isn't depreciated": the ute
  gets nothing in June (a run with nothing to post posts no journal) and
  **750.00** in July. Either run can be rolled back.
- **FA8** After runs to 31 May, 30 Jun and 31 Aug (no monitor), the ute's
  accumulated depreciation is **2,250.00** (750.00 + 1,500.00). It's sold on
  **15 Sep 2026** for 28,750.00 incl. GST, invoiced (here journalled) to 4100
  Other revenue: proceeds **25,000.00** excluding GST, cleared from 4100.
  September isn't depreciated (the default). Book value **27,750.00**, loss
  **2,750.00**. Journal `FA-0004` on 15 Sep: Dr 1650 **2,250.00** / Cr 1640
  **30,000.00** / Dr 4100 **25,000.00** / Dr 7030 **2,750.00**; 1640, 1650
  and 4100 are back to **0.00**. Refused: a disposal dated 31 Aug (on or
  before the last run: roll it back first), proceeds with no account, 1000
  or 1100 as the proceeds account, 1600 as the gain or loss account, a
  proceeds account with no proceeds, disposing of it again. The September
  run leaves it out, and the register at 30 Sep lists it as disposed on 15
  Sep, proceeds **25,000.00**, gain (loss) **-2,750.00**, depreciation this
  year **2,250.00**, with 1640 and 1650 at **0.00** on both sides. With
  "the disposal month counts" instead, September's **750.00** is charged
  first: Dr 6300 **750.00** / Cr 1650 **750.00** / Dr 1650 **3,000.00** /
  Cr 1640 **30,000.00** / Dr 4100 **25,000.00** / Dr 7030 **2,000.00**.
- **FA9** The desk (accumulated **100.00**, book value **1,100.00**) sold
  on 20 Sep 2026 for **1,300.00**: Dr 1610 **100.00** / Cr 1600 **1,200.00**
  / Dr 4100 **1,300.00** / Cr 7030 **100.00** (depreciation recovered) / Cr
  7040 **100.00** (capital gain). The printer (accumulated **1,000.00**, book
  value **500.00**) sold for **700.00**: Dr 1610 **1,000.00** / Cr 1600
  **1,500.00** / Dr 4100 **700.00** / Cr 7030 **200.00** (depreciation
  recovered, no capital gain).
- **FA10** The laptop written off on **10 Oct 2026**: September is
  charged, **83.34** (5 months 416.67 less 333.33), so accumulated
  **416.67**, book value **1,583.33**, all a loss. Journal "Write-off of
  FA-0001 Laptop": Dr 6300 **83.34** / Cr 1630 **83.34** / Dr 1630 **416.67**
  / Cr 1620 **2,000.00** / Dr 7030 **1,583.33**.
- **FA11** With the ute sold (FA8), rolling back the August run is refused
  ("Undo the disposal of FA-0004 first"); deleting the disposal and changing
  the ute's cost are refused. Undoing it posts `VOID-FA-0004` on **15 Sep**
  (Cr 1650 **2,250.00** / Dr 1640 **30,000.00** / Cr 4100 **25,000.00** / Cr
  7030 **2,750.00**); the ute is registered again, depreciated to 31 Aug,
  book value **27,750.00**; a second undo is refused; the September run
  charges it **750.00**. The desk written off on 5 Oct blocks rolling back
  September until that's undone too.
- **FA12** With Advanced reporting on and the ute tagged Department Farm,
  a run straight to 30 Jun posts Dr 6300 **166.67** / Cr 1630 (untagged),
  Dr 6300 **750.00** / Cr 1650 (both tagged Farm), Dr 6300 **120.00** / Cr
  1610 (untagged); every line of its disposal is tagged Farm.
- **FA13** The register as at **30 Jun 2026** (after FA4), year from 1 Apr
  2026:

  | Asset | Cost | Accumulated | Book value | This year |
  | --- | ---: | ---: | ---: | ---: |
  | Computer equipment: FA-0001 Laptop | 2,000.00 | 166.67 | 1,833.33 | 166.67 |
  | Motor vehicles: FA-0004 Ute | 30,000.00 | 750.00 | 29,250.00 | 750.00 |
  | Office equipment: FA-0002 Desk | 1,200.00 | 60.00 | 1,140.00 | 60.00 |
  | Office equipment: FA-0003 Printer | 1,500.00 | 960.00 | 540.00 | 60.00 |
  | Office equipment total | 2,700.00 | 1,020.00 | 1,680.00 | 120.00 |
  | **Total** | **34,700.00** | **1,936.67** | **32,763.33** | **1,036.67** |

  Ledger: 1600 **2,700.00**, 1610 **1,020.00** (credit), 1620 **2,000.00**,
  1630 **166.67**, 1640 **30,000.00**, 1650 **750.00**, each with no
  difference. As at 31 May (no ute, no June run): cost **4,700.00**,
  accumulated **1,063.33**. After a manual journal Dr 6130 50.00 / Cr 1600
  50.00 on 30 Jun, 1600 shows register **2,700.00**, ledger **2,650.00**,
  difference **-50.00**. Viewers can open it.
- **FA14** Before any run the desk's cost and name can change; after the
  May run, changing its cost or rate is refused ("only its name,
  description and tracking") while its description can change; the laptop
  can't be archived (not even directly in the database) or deleted, and the
  type's asset account can't change. A viewer can list runs but can't run
  depreciation (403). The run and disposal journals can't be corrected in
  the ledger, and account transactions for 1610 show "Depreciation run
  DEP-2026-05" (linking to the depreciation screen) and "Disposal of
  FA-0002" (linking to the asset).

### Not supported yet (refused rather than guessed)

- **Built-in IRD rates, asset classes, low-value asset write-offs, pooling
  and building rules**: the organisation enters rates and methods; a
  low-value item is simply expensed on the bill.
- **Tax and book depreciation side by side** (Xero's tax/book views): one
  set of depreciation is kept.
- Depreciating by days, or part months other than the two settings; changing
  an asset's method or rate after it's depreciated (roll back its runs
  first); revaluations and impairments; partial disposals and splitting an
  asset.
- Disposing of an asset before the last run without rolling the run back,
  and GST on the sale (the sale is invoiced as usual; the disposal clears
  its amount excluding GST).
- Registering assets from bank transactions, expense claims or journals by
  link (they're typed in with their cost).

### Questions for Jess (fixed assets)

- Should the month an asset is bought count as a whole month (as built,
  the default), and the disposal month not be depreciated (the default)?
  Please check both against IRD's current guidance and your practice.
- IRD has its own rules for depreciation in the year an asset is disposed
  of (please check them): should Tohyee keep a separate tax depreciation
  figure beside the book one, or is one set enough for now?
- Is 7030/7040 right for gains, losses and capital gains, or should
  depreciation recovered go to its own account (it's taxable income, while
  a capital gain usually isn't)?
- Should low-value assets (under IRD's current threshold) be offered as an
  immediate write-off when registering, and should pooling be built?
- Should a run be allowed to skip a month (as built, a run covers every
  month since the last one, so nothing is skipped), or must runs be monthly?

## Projects and time tracking (examples not yet approved by Jess)

Written overnight from Xero Projects; Jess hasn't approved them yet. A
**project** is work for one **customer**: a name, an optional **estimate**
(money, excluding GST) and an optional **deadline**. It is **In progress**
or **Closed**, and only the Close and Reopen actions change that. Projects,
their tasks, time and expenses **post nothing**; only the invoices made
from them do (as ordinary invoices, I1-I9).

- **Tasks** have a **charge type**: **hourly** (a rate per hour), **fixed
  price** (billed once, whole) or **non-chargeable** (never billed), and an
  optional estimate in hours and minutes. Tasks are archived, never deleted.
  A task's charge type, and a fixed task's price, can't change once
  something on it has been invoiced (an hourly rate can: what's invoiced
  keeps its amount).
- **Time entries**: a member, a date, a task, a **duration stored as whole
  minutes** (entered as hours and minutes, 1 minute to 24 hours) and a
  description. Bookkeepers enter their own time; admins and owners can also
  enter and change time for another member of the organisation.
- **Staff cost rates** (admins set them, per member, per hour, 0.00 if not
  set) give each entry its **cost**: minutes x cost rate / 60, rounded to
  the cent (half away from zero) per entry. The rate is copied onto the
  entry when it's entered, so a later change of rate doesn't change earlier
  entries. Costs are for profitability only and never post to the ledger.
- **Expenses** are **linked, not re-posted**: an approved bill's line, an
  approved expense claim's receipt or a spend money line is linked to a
  project with its cost **excluding GST** (the line's net amount), a
  **chargeable** flag and an optional **markup %**. Only lines coded to
  expense or direct cost accounts count (PJ13); a fixed asset bought or a
  prepayment isn't a project cost. A line can be on one
  project at a time. Its **charge** is cost x (100 + markup) / 100, rounded
  to the cent. Stock lines (the inventory account) aren't linked: stock is
  costed when it's sold. While linked, the bill, claim or spend money can't
  be voided (the database refuses); remove the link first (only while it
  isn't invoiced).
- **Unbilled** means: time on hourly tasks, fixed price tasks (not archived)
  and chargeable expenses that aren't on an invoice that isn't voided, and
  haven't been written off.
- **Invoice**: the chosen unbilled items become one **draft sales
  invoice** for the project's customer, to one revenue account and tax code
  chosen when invoicing (tax exclusive; no tax code means no tax), due by the
  customer's payment terms unless a due date is given. Lines, in this
  order: per hourly task, its chosen time at the task's current rate (the
  quantity is the hours when they're exact to 4 decimal places, else 1 at
  the amount, minutes x rate / 60 rounded to the cent); per fixed task, 1 at
  its price; per expense, 1 at its charge. Each item is linked to the
  invoice so it can't be invoiced twice (the database refuses). **Voiding**
  the invoice, or **deleting** the draft, makes its items unbilled again.
  The draft can be edited like any invoice; its items stay linked to it.
- **Closing** is refused while anything is unbilled or a project invoice is
  still a draft, unless the unbilled items are **written off** as part of
  closing (they're then never billed, and stay written off if the project
  is reopened). A closed project takes no new tasks, time, expenses or
  invoices, and its invoices can't be voided or deleted until it's reopened
  (the database refuses all of these).
- **Profitability** per project: **invoiced** (the approved project
  invoices' totals excluding GST), **costs** (linked expenses at cost plus
  time at cost), **profit** (invoiced less costs), what's **on draft
  invoices**, **unbilled** time, fixed prices and expenses, **written off**,
  and the **estimate** against invoiced plus unbilled; per task, estimated
  against actual hours. The **time report** lists entries in a date range,
  by person, project and task, with hours and cost.

Setup (GST 15%): customer **Harbour Cafe** (payment terms 20th of the
following month), supplier **Paw Supplies**; members Jess (owner), Aroha
and Sam (bookkeepers) and a viewer. Jess sets **staff cost rates**: Jess
**40.00**, Aroha **30.00** an hour (Sam none). Project **Cafe rebrand** for
Harbour Cafe, estimate **2,000.00**, deadline 31 Aug 2026, with tasks
**Design** (hourly, **90.00**, estimate 10 h), **Photography** (fixed price
**600.00**) and **Admin** (non-chargeable).

| Date | Who | Task | Time | Minutes | Cost |
| --- | --- | --- | --- | ---: | ---: |
| 1 Jul 2026 | Jess | Design | 2 h 30 min | 150 | 100.00 |
| 2 Jul 2026 | Aroha | Design | 1 h 15 min | 75 | 37.50 |
| 3 Jul 2026 | Jess | Admin | 45 min | 45 | 30.00 |
| 3 Jul 2026 | Aroha | Photography | 4 h | 240 | 120.00 |

| Expense | Account | Net (cost) | Chargeable | Markup | Charge |
| --- | --- | ---: | --- | ---: | ---: |
| Bill PS-300, 4 Jul, "Printing of menus" 200.00 + GST | 6140 | 200.00 | yes | 10% | 220.00 |
| Aroha's claim, 5 Jul, Z Energy "Fuel to shoot" 69.00 incl. GST | 6120 | 60.00 | no | | |
| Spend money, 6 Jul, "Props" 46.00 incl. GST | 6070 | 40.00 | yes | 0% | 40.00 |

- **PJ1** Creating Cafe rebrand posts nothing; it's **In progress** and
  listed under Harbour Cafe. Refused: a contact that isn't a customer, an
  archived customer, no name, an estimate of -1.00 or 1.005, a status
  typed in (there's no such field; only Close and Reopen change it). A
  retry with the same key returns the same project; the same key with a
  different name is refused. Projects can't be deleted (the database
  refuses).
- **PJ2** Tasks: Design stores rate 90.00 and an estimate of **600**
  minutes (10 h). Refused: an hourly task with no rate, a non-chargeable
  task with a rate, a fixed price of 600.005 or 0.00. Archiving Admin keeps
  it (deleting is refused by the database) and new time on it is then
  refused; its existing time still counts.
- **PJ3** Time: Jess's 2 h 30 min is stored as **150** minutes with cost
  rate 40.00 and cost **100.00**; Aroha's 1 h 15 min, **75** minutes, cost
  **37.50**. Refused: 0 minutes, 24 h 1 min, 1.5 minutes, a date that isn't
  a date, a task from another project. Aroha (bookkeeper) can't enter or
  change time for Jess, or set cost rates; Jess (owner) can enter time for
  Aroha, but not for someone who isn't a member. Sam's time costs **0.00**
  (no rate). After Jess changes her rate to 50.00, her earlier entry still
  costs 100.00 and a new 1 h entry costs 50.00. No journal is posted.
- **PJ4** Expenses: linking the bill line, the receipt and the spend money
  line gives costs **200.00**, **60.00** and **40.00** (excluding GST) and
  charges **220.00** (10% markup) and **40.00**; the fuel isn't chargeable.
  Refused: a line of a draft bill, the same line on a second project (the
  database refuses too), a receive money line, a stock line (1400), a markup
  of -5 or 10.001. Voiding bill PS-300 while it's linked is refused (the
  database refuses); after removing the link it can be voided. Linking
  posts nothing.
- **PJ5** Unbilled after PJ3 and PJ4: Design 225 minutes (3 h 45 min) x
  90.00 / 60 = **337.50**, Photography **600.00**, expenses **260.00**
  (220.00 + 40.00): **1,197.50** in all. The Admin time and the fuel are
  costs only.
- **PJ6** Invoicing everything unbilled on 10 Jul 2026 to 4000 with GST
  makes a **draft invoice** for Harbour Cafe, due **20 Aug 2026** (its
  terms), with lines "Design (3 h 45 min)" 3.75 x **90.00** = **337.50**,
  "Photography" 1 x **600.00**, "Printing of menus" 1 x **220.00**, "Props"
  1 x **40.00**: subtotal **1,197.50**, GST **179.63** (50.63 + 90.00 + 33.00
  + 6.00, per line), total **1,377.13**. Nothing is posted until it's
  approved, which posts Dr 1100 **1,377.13** / Cr 4000 **1,197.50** / Cr
  2100 **179.63** as for any invoice. Unbilled is then **0.00**; invoicing
  any of those items again is refused ("already on invoice"), and the
  database refuses linking them twice. The same request retried with the
  same key returns the same invoice; the same key with other items is
  refused. Invoicing nothing, a non-chargeable task's time, or a fixed
  price task's time (the price is billed, not the time) is refused.
- **PJ7** Durations that aren't exact hours to 4 decimal places: 10 minutes
  of Design is invoiced as "Design (10 min)" 1 x **15.00** (10 x 90.00 /
  60); 12 minutes as 0.2 x 90.00 = **18.00**.
- **PJ8** Deleting PJ6's draft invoice makes all **1,197.50** unbilled
  again. Invoiced again, approved and then voided on 15 Jul, the items are
  unbilled again and can be invoiced a third time. While on an invoice that
  isn't voided, a time entry can't be changed or removed and an expense's
  markup, chargeable flag or link can't be changed (the database refuses
  them too); after the void they can.
- **PJ9** Profitability. Before invoicing: invoiced **0.00**, costs
  **587.50** (time **287.50** + expenses **300.00**), profit **-587.50**,
  unbilled **1,197.50**. With PJ6's draft: **1,197.50** on draft invoices,
  invoiced still 0.00. Once approved: invoiced **1,197.50**, profit
  **610.00**, unbilled **0.00**; estimate **2,000.00** against invoiced plus
  unbilled 1,197.50, **802.50** left. Design: estimated 10 h, actual **3 h 45
  min**.
- **PJ10** Closing: refused while 1,197.50 is unbilled, and while the
  project invoice is a draft; once it's approved the project closes. A
  closed project refuses new tasks, time, expenses and invoicing, and
  voiding its invoice is refused until it's reopened (the database refuses
  all of these). Reopened, 30 minutes more Design (**45.00**) is entered;
  closing is refused, then closing **with write-off** closes it and marks
  that entry written off: unbilled **0.00**, written off **45.00**, its cost
  (15.00 at Aroha's rate) still counts. Reopened again, the entry stays
  written off and invoicing it is refused.
- **PJ11** Time report for July 2026: Jess **3 h 15 min** (195 minutes,
  cost 130.00), Aroha **5 h 15 min** (315 minutes, cost 157.50); by task
  Design 3 h 45 min, Photography 4 h, Admin 45 min; total **8 h 30 min**,
  cost **287.50**. For 1-2 Jul only: 3 h 45 min. Filtered to Aroha: 5 h 15
  min. A removed entry isn't listed.
- **PJ12** A viewer can list and open projects and run both reports but
  can't create, change or invoice anything (403). Every command that creates
  something is idempotent. Across PJ1-PJ11 the only journals are the bill's,
  the claim's, the spend money's and the approved invoices' (and their
  voids).
- **PJ13** Only lines coded to a **profit and loss cost account** (the
  expense class: expense, direct costs and depreciation types) are project
  expenses. Bill PS-302 from Paw Supplies on 8 Jul 2026 (approved) has
  "Laptop for design work" **1,500.00** + GST to **1620 Computer
  equipment** (a fixed asset), "Design software" **50.00** + GST to 6040
  and "Courier for proofs" **30.00** + GST to 5100 (direct costs); spend
  money on 8 Jul pays "Insurance paid ahead" 115.00 incl. GST to **1200
  Prepayments**. "Add to project" offers only the software and the courier.
  Linking the laptop is refused ("That line is coded to 1620 Computer
  equipment, a fixed asset account, not an expense. Only lines coded to
  expense or direct cost accounts can go on a project.") and so is the
  prepayment (1200, a current asset); nothing is linked. The software then
  links at cost **50.00** and the courier at **30.00**. (Stock on 1400 is
  refused with its own reason, PJ4; GST, bank and accounts payable can't be
  on these lines at all.) Lines already linked before this rule stay linked.

### Not supported yet (refused rather than guessed)

- **Deposits and progress billing**, invoicing part of a fixed price, and
  invoicing time at a per-person rate (the task's rate is used).
- A **start/stop timer**: time is entered as hours and minutes.
- Undoing a **write-off**, or writing items off other than when closing.
- Linking **draft bills**, supplier credit notes, purchase orders, manual
  journals, receive money or stock lines to projects; foreign-currency
  projects.
- **Tracking the project in the ledger**: a project isn't a tracking or
  custom segment value, and linking an expense doesn't change its posted
  lines (posted history is append-only). Organisations that want the
  ledger split by project can add a "Project" custom segment (CS1) and tag
  lines themselves.
- Notes and files on projects; time entries for people who aren't members
  of the organisation (e.g. contractors without a login).

### Questions for Jess (projects)

- Invoice lines for time: the quantity is the hours when they're exact to 4
  decimal places, else 1 line at the amount (PJ7). Would you rather Tohyee
  round time to 6 or 15 minutes when invoicing, as some firms do?
- Should staff who only record time (no bookkeeping) get a "time only"
  role? As built, entering time needs a bookkeeper.
- Is closing with write-off the right way to finish a project with
  unbilled work, and should a write-off be undoable when it's reopened?
- Should invoiced income include credit notes against project invoices
  (not linked yet), and should profitability be for a date range rather
  than the project's life?
- Should a project automatically tag its invoice lines with a "Project"
  custom segment value, so the profit and loss can be split by project?

## Bringing in existing books (examples not yet approved by Jess)

Accountants bring an organisation's existing books into Tohyee instead of
starting from nothing (Accounting > Settings > **Import and export**, admins
and owners). It follows NetSuite's import assistant, as Jess asked: for each
file, upload a CSV or Excel (.xlsx) file, map its columns to fields (matched
from the headings, and remembered per organisation for next time), check it
(every row, with each problem named by row), then import it in one
transaction. **If any row is refused, nothing in that file is imported.**
There are two presets: Tohyee's own columns (what the exports write), and
"From another accounting system (Xero-style export)", which knows the
headings of Xero's standard exports (`*ContactName`, `InvoiceAmountDue`, ...).
The preset is labelled neutrally; no other product is named on screen.

The steps, in order: 1 chart of accounts, 2 contacts, 3 products and
services, 4 opening balances (trial balance and stock) and 5 open invoices
and bills, posted together as at the **conversion date**, then 6 a final
check and the period lock. Tests: `tests/integration/import.test.ts`
(IM1-IM21), `tests/unit/import-fields.test.ts` (column matching) and
`tests/unit/opening-gst.test.ts` (GST in open documents).

**Running a step again.** Accounts and products and services are matched by
code, contacts by name (ignoring case). A match is updated from the columns
that have something in them (a blank cell changes nothing); anything else is
added; nothing is ever deleted or archived. Opening balances (steps 4 and 5)
are brought in **once**: a second import is refused, and a retry of the
same request returns the first (IM14). Mistakes found later are corrected
with a journal after the conversion date (or in an unlock window), or by
voiding an opening invoice or bill.

**How opening balances post (IM6).** The trial balance is posted as one
journal dated the conversion date, origin "Opening balances", which can't be
corrected like a manual journal. Accounts receivable, accounts payable and
inventory aren't posted from the trial balance, because the open invoices,
open bills and stock on hand make them up: their trial balance lines go to
**3900 Opening balance** instead, an equity account (decided with Jess,
30 Sep 2026: equity and named like NetSuite's "Opening Balance" account;
Xero calls its equivalent "Historical Adjustment", and importing either name
maps to it). Each open
invoice then posts Dr accounts receivable / Cr 3900, each open bill Dr 3900 /
Cr accounts payable, and the stock Dr inventory / Cr 3900, all dated the
conversion date. So 3900 ends at 0.00, and accounts receivable, accounts
payable and inventory equal their sub-ledgers without being counted twice.
(Xero's conversion balances do the same with invoices entered before the
conversion date and its Historical Adjustment account; NetSuite posts to its
Opening Balance equity account.) This means:

- The trial balance must balance, and accounts receivable must equal the
  open invoices, accounts payable the open bills and inventory the stock
  values, to the cent. Otherwise nothing is posted and the difference is
  shown (IM8, IM9).
- Nothing may already be posted on or before the conversion date, and the
  conversion date must be in an open period.
- Open invoices and bills are one row each: the number, contact, date, due
  date, **amount still owed including GST**, and the **GST in it** (decided
  with Jess, 30 Sep 2026: like Xero, where outstanding invoices at the
  conversion are the original invoices with their GST). They keep their
  date, due date and number (not Tohyee's INV sequence, IM10) and are marked
  as opening balances. Approving or voiding one never counts in a GST
  return, since it was issued before the conversion; on the bases where GST
  counts when paid (the payments basis, and purchases on the hybrid basis),
  a payment or credit after the conversion counts its share of the GST,
  exactly like any invoice or bill paid on that basis (the same proportional
  rule, G11). On the invoice basis the GST was returned before the
  conversion, so it's never returned again (IM11, IM13, IM18, IM19). They
  never count in sales by salesperson. They can be paid, credited and
  voided like any other invoice or bill (IM12); voiding one reverses it to
  3900, where the accountant clears it with a journal.
- The GST is given as a GST column (the GST in what's still owed; or, with
  the invoice's total, the whole invoice's GST, from which the GST in what's
  owed is worked out in proportion), or a GST code (with GST: 3/23 of what's
  owed), IM20. Where GST counts when paid, every row needs one (0.00 if
  there's none); elsewhere it's optional.
- The GST line of the trial balance is posted to 2100 as a balance only:
  journals never count in a GST return. **It includes the GST in the open
  invoices and bills**, as Xero's GST account does (Xero puts unpaid GST on
  outstanding invoices in the GST account at the conversion) and as
  Tohyee's own does for every invoice (GST goes to 2100 when an invoice is
  approved, on every basis; the GST return decides when it's reported). So
  the open invoices' and bills' journals post no GST (Dr accounts receivable
  / Cr 3900 of the amount including GST, as before), and the check shows how
  2100 splits (IM17): on the payments basis, 2100 = what the GST returns up
  to the conversion left to pay + GST in the open invoices (not yet
  returned) - GST in the open bills (not yet claimed).
- Stock is a quantity and a value per item (and per location once stock is
  kept by location). It comes in as a receipt at that value exactly (3
  worth 10.00 is 10.00, not 3 x 3.33), dated the conversion date.
- Bank accounts take their balance from the trial balance. That opening
  line is the bank's balance at the conversion date, so the bank
  reconciliation report and matching leave it out (IM15); statement lines
  from before the conversion date aren't expected.
- Foreign-currency accounts, unused credit notes and overpayments (a
  negative amount owed) aren't supported in opening balances yet (refused).

The main example: **Tui Traders Ltd**, starting chart of accounts, GST on
the invoice basis, customers Kobe Ltd and Harbour Cafe, supplier Kauri
Supplies, stock items MUG and VASE, converting at **31 March 2026**.

Trial balance at 31 Mar 2026 (columns Account code, Account, Debit, Credit;
a last row "Total" with no code is left out):

| Account | Debit | Credit |
| --- | ---: | ---: |
| 1000 Business bank account | 12,450.00 | |
| 1100 Accounts receivable | 1,725.00 | |
| 1400 Inventory | 810.00 | |
| 1600 Office equipment | 3,000.00 | |
| 2000 Accounts payable | | 460.00 |
| 2100 GST | | 1,380.00 |
| 3000 Owner funds introduced | | 10,000.00 |
| 3200 Retained earnings | | 6,145.00 |
| **Total** | **17,985.00** | **17,985.00** |

Open invoices: **INV-0107** Kobe Ltd, 15/03/2026, due 20/04/2026,
**1,150.00**; **INV-0112** Harbour Cafe, 28/03/2026, due 20/04/2026,
**575.00**. Open bill: **K-311** Kauri Supplies, 20/03/2026, due
20/04/2026, **460.00**. Stock: MUG 40 worth **800.00**; VASE 3 worth
**10.00**.

- **IM1** The starting chart of accounts has **3900 Opening balance**
  (equity, "Used by Tohyee"); an organisation without one gets it at 3900,
  or the next free code up to 3999, the first time opening balances are
  posted. It's the account the three sub-ledger lines clear through, and is
  0.00 once they're posted (IM7). It can't have a balance of its own in the
  imported trial balance.
- **IM2** Chart of accounts, Xero-style file:

  ```
  *Code,*Name,*Type,*Tax Code,Description
  200,Sales,Revenue,15% GST on Income,
  610,Accounts Receivable,Current Asset,No GST,
  6000,Advertising,Overhead,GST on Expenses,
  7500,Donations,Expense,No GST,Gifts to charities
  ```

  Check: 200 **added** (Revenue, GST code GST); 610 is Tohyee's accounts
  receivable account, so **1100 is re-coded 610** and keeps its role (and
  its type); 6000 **updated** (renamed Advertising, usual GST code GST); 7500
  **added** (Expense, NONE, with its description). Importing it: 2 added, 2
  updated. Importing the same file again: 4 unchanged. Types are read from
  Tohyee's names and the other system's (Overhead is Expense, Sales is
  Revenue, Prepayment is Current asset, and so on); tax codes from their
  code or label, or names like "15% GST on Income" (GST), "Zero Rated"
  (ZERO), "Exempt Expenses" (EXEMPT) and "No GST" (NONE); "GST on Imports"
  is refused.
- **IM3** Refusals: `1000,Business bank account,Current asset` (1000 is the
  bank account Tohyee uses, so its type stays Bank), `8000,Sundry income,`
  (a new account needs a type) and `8100,Rent received,Other income`. The
  check names row 2 and row 3; importing is refused and **8100 isn't added
  either**. The same code twice in one file is refused on the later row.
- **IM4** Contacts, Xero-style file with no customer or supplier columns,
  "mark new contacts as" customer and supplier:

  ```
  *ContactName,EmailAddress,POAddressLine1,POCity,POPostalCode,TaxNumber
  Kobe Ltd,accounts@kobe.co.nz,1 Queen Street,Auckland,1010,123-456-789
  Harbour Cafe,,,,,
  ```

  Kobe Ltd is added as a customer and supplier with billing address "1 Queen
  Street / Auckland / 1010" (one line each) and GST number 123456789.
  Importing `KOBE LTD,hello@kobe.co.nz` later updates Kobe Ltd's email and
  leaves everything else. With Tohyee's columns, "Payment terms" is matched
  to the organisation's terms by name ("20th of the following month") and a
  custom field column (Advanced reporting) to its field; a list field's
  option by its name. A row with an email of "not-an-email" refuses the
  whole file.
- **IM5** Products and services, Xero-style file: `MUG` with
  InventoryAssetAccount 1400 becomes a **stock** item (purchase account
  1400); `DELIVERY` with only a sale price of 12.50 and sales account 4000
  becomes a **service**; `BOX` with a purchase price becomes **non-stock**.
  "15% GST on Income" and "15% GST on Expenses" are GST. Quantities in the
  file are ignored: stock on hand comes with the opening balances.
- **IM6** Posting Tui Traders' opening balances makes, all dated 31 Mar
  2026:
  - the opening journal (reference OPENING, origin "Opening balances"):
    Dr 1000 **12,450.00**, Dr 3900 **1,725.00** (1100, held by the open
    invoices), Dr 3900 **810.00** (1400, held by the opening stock), Dr 1600
    **3,000.00** / Cr 3900 **460.00** (2000, held by the open bills), Cr
    2100 **1,380.00**, Cr 3000 **10,000.00**, Cr 3200 **6,145.00**; total
    **17,985.00**;
  - INV-0107: Dr 1100 **1,150.00** / Cr 3900 1,150.00; INV-0112: Dr 1100
    **575.00** / Cr 3900 575.00 (each approved, one line "Owed at
    2026-03-31 (opening balance)" of 1,150.00 or 575.00, no GST);
  - K-311: Dr 3900 **460.00** / Cr 2000 460.00;
  - stock receipts: MUG 40 at **800.00** (unit cost 20.00) and VASE 3 at
    **10.00** (not 9.99), each Dr 1400 / Cr 3900.
- **IM7** The trial balance at 31 Mar 2026 is exactly the imported one: 1000
  12,450.00 Dr, 1100 1,725.00 Dr, 1400 810.00 Dr, 1600 3,000.00 Dr, 2000
  460.00 Cr, 2100 1,380.00 Cr, 3000 10,000.00 Cr, 3200 6,145.00 Cr, and 3900
  **0.00**. The final check shows each account's imported and Tohyee
  balance side by side, all matching; locking up to 31 Mar 2026 (the
  ordinary period lock) then refuses anything dated on or before it.
  Aged receivables at 31 Mar 2026: Kobe Ltd 1,150.00 and Harbour Cafe
  575.00 (current, due 20 Apr), total **1,725.00** = 1100. Aged payables:
  Kauri Supplies **460.00** = 2000. Stock on hand: MUG 40 worth 800.00,
  VASE 3 worth 10.00, total **810.00** = 1400.
- **IM8** INV-0112 at **500.00** instead: refused, "Accounts receivable
  (1100) is 1,725.00 in the trial balance, but the open invoices add up to
  1,650.00: a difference of 75.00". Nothing is posted.
  The same for accounts payable against the open bills, and inventory
  against the stock values.
- **IM9** 3200 at **6,110.00** instead: refused, "debits 17,985.00, credits
  17,950.00, a difference of 35.00". Nothing is posted.
- **IM10** Numbers: INV-0107 and INV-0112 keep their numbers. If an opening
  invoice is numbered **INV-0001**, the first invoice approved in Tohyee is
  **INV-0002** (the counter passes over numbers opening invoices have). An
  opening invoice with a number already in Tohyee is refused.
- **IM11** GST: the first return after the conversion, 1 Apr - 31 May 2026
  (invoice basis), with a new invoice I1 (100.00 + GST 15.00) dated 10 Apr
  and INV-0107 paid in full on 20 Apr: Box 5 **115.00**, Box 8 **15.00**,
  and only I1 is in its lines. A return for 1 Feb - 31 Mar 2026 in Tohyee
  has no lines either (the opening invoices and bill are left out, and the
  opening journal never counts). 2100 at 31 May: 1,380.00 + 15.00 =
  **1,395.00** Cr. Opening invoices are left out of sales by salesperson.
  The same with the GST columns of IM17 (INV-0107 carrying 150.00 of GST):
  on the invoice basis that GST was returned before the conversion, so
  paying INV-0107 still counts nothing.
- **IM12** Paying later: INV-0107 paid 1,150.00 on 20 Apr 2026 from 1000
  posts Dr 1000 / Cr 1100 1,150.00 and the invoice is paid; K-311 paid
  460.00 on 22 Apr posts Dr 2000 / Cr 1000. Aged receivables at 30 Apr:
  Harbour Cafe **575.00** (10 days overdue). Kobe Ltd's activity statement
  for April starts with a balance of **1,150.00** (INV-0107) and ends at
  0.00 after the payment.
- **IM13** GST basis: on the **payments basis**, the IM6 files (no GST
  column) are refused row by row: "Invoice INV-0107 needs its GST: this
  organisation accounts for GST on sales when they're paid (the payments
  basis), so the GST in what's still owed is returned when it's paid. Map a
  GST column (0.00 if there's none) or a GST code." (and the same for
  INV-0112 and bill K-311). With IM17's GST columns they're accepted. On the
  **hybrid basis** only the bill needs its GST (sales count when approved,
  so the invoices' GST was returned before the conversion); on the
  **invoice basis** neither does.
- **IM14** Once only: a second opening balances import is refused ("already
  brought in as at 2026-03-31"); retrying the first with the same key and
  files returns it (nothing new). Something already posted on or before
  the conversion date refuses the import.
- **IM15** Bank reconciliation: a statement for 1000 with one line, 2 Apr
  2026, -46.00, running balance **12,404.00**, reconciled to a spend money
  of 46.00 on 2 Apr. The report as at 30 Apr: Tohyee **12,404.00**, nothing
  in Tohyee that isn't on the statement (the opening line isn't an item),
  statement balance 12,404.00, fully explained. The opening line is never
  offered as a match for a statement line.
- **IM16** Export: the chart of accounts, contacts, and products and
  services download as CSV with Tohyee's column headings (for example
  `Code,Name,Type,GST code,Description`), and importing an exported file
  back changes nothing (every row unchanged).

- **IM17** A **payments-basis** conversion: Tui Traders as above, but on
  the payments basis, with the GST in each open document:

  ```
  Invoice number,Customer,Invoice date,Due date,Amount due,GST
  INV-0107,Kobe Ltd,15/03/2026,20/04/2026,1150.00,150.00
  INV-0112,Harbour Cafe,28/03/2026,20/04/2026,575.00,75.00
  ```

  and bill K-311 460.00 with GST **60.00**. Everything posts exactly as in
  IM6 (the journals don't post GST again): INV-0107 is one line "Owed at
  2026-03-31 (opening balance)", GST code GST, 1,150.00 including GST
  **150.00** (subtotal 1,000.00), and its journal is Dr 1100 1,150.00 / Cr
  3900 1,150.00. The trial balance at 31 Mar is exactly IM7's (2100
  1,380.00 Cr, 3900 0.00). The check shows how 2100 splits:

  | GST (2100) at 31 Mar 2026, payments basis | |
  | --- | ---: |
  | GST account in the trial balance (owed to IRD) | 1,380.00 |
  | GST in the open invoices (not yet returned) | 225.00 |
  | GST in the open bills (not yet claimed) | 60.00 |
  | **Owed from GST returns up to 31 Mar** (1,380.00 - 225.00 + 60.00) | **1,215.00** |

  So the old system's GST account (like Xero's, and Tohyee's own) already
  holds the 225.00 still to be returned and the 60.00 still to be claimed;
  the 1,215.00 should be what the returns up to 31 Mar left to pay. The
  Feb-Mar 2026 return in Tohyee has no lines.
- **IM18** The first GST return after it, 1 Apr - 31 May 2026, payments
  basis. I1 (Harbour Cafe, 100.00 + GST 15.00) approved 10 Apr and not
  paid; INV-0107 paid in full, **1,150.00** on 20 Apr; INV-0112 part paid,
  **230.00** on 25 May; K-311 paid in full, **460.00** on 22 Apr. Counted:
  INV-0107 1,150.00 (GST 150.00); INV-0112 230.00, its share of 575.00 (GST
  230.00 x 75.00 / 575.00 = **30.00**); K-311 460.00 (GST 60.00). I1 isn't
  counted (not paid). Box 5 **1,380.00**, Box 6 **0.00**, Box 7
  **1,380.00**, Box 8 = 1,380.00 x 3/23 = **180.00**, Box 11 **460.00**,
  Box 12 **60.00**, Box 15 **120.00** (to pay). GST on transactions: sales
  180.00, purchases 60.00. 2100 at 31 May: 1,380.00 + I1's 15.00 =
  **1,395.00** Cr = 1,215.00 (returns to 31 Mar) + 120.00 (this return) +
  60.00 not yet returned (INV-0112's 345.00 still owed has 45.00 of GST, and
  I1 15.00). INV-0112's other 345.00 paid on 10 Jun counts in Jun-Jul: Box 5
  **345.00**, Box 8 **45.00**.
- **IM19** The same on the **hybrid basis**: the opening invoices' GST was
  returned before the conversion (sales count when approved), so paying
  INV-0107 and INV-0112 counts nothing; I1 counts when approved and K-311
  when paid. Apr-May: Box 5 **115.00**, Box 8 **15.00**, Box 11 **460.00**,
  Box 12 **60.00**, Box 15 **-45.00** (a refund). 2100 splits as 1,380.00 +
  60.00 (not yet claimed) = **1,440.00** owed from the returns up to 31 Mar.
- **IM20** Ways to give the GST (payments basis):
  - a **GST code** without an amount: INV-0112 575.00 with "15% GST on
    Income" (or GST) has GST 575.00 x 3/23 = **75.00**; with ZERO it has
    0.00 (counted in Box 6 when paid);
  - another system's export with the **whole invoice's** total and GST
    (`Total`, `TaxTotal`) and what's still owed (`InvoiceAmountDue`), a row
    per invoice line: INV-0112 total 805.00, GST 105.00, owed 575.00 has
    575.00 x 105.00 / 805.00 = **75.00** in what's owed (the rows for its
    other lines are the same invoice, left out);
  - **less than 3/23** of what's owed: K-311 460.00 with GST 30.00 becomes
    two lines, **230.00** with GST (30.00 x 23 / 3, GST 30.00) and
    **230.00** with no GST (out of scope). Paying it in full counts Box 11
    **230.00**, Box 12 **30.00**, and the 2100 split shows 30.00 not yet
    claimed (1,185.00 from the returns);
  - up to **0.05** from 3/23 is taken as line-by-line rounding: 460.00 with
    GST 60.04 is one line with GST 60.04;
  - refused: GST 70.00 on 460.00 ("The GST (70.00) is more than GST at 15%
    on what's owed would be (60.00)."), GST with a code that has none ("The
    GST is 60.00 but the GST code ZERO has no GST."), negative GST, and a
    total less than what's owed.
- **IM21** The conversion account for organisations that had the old one:
  migration 0036 changes **2990 Conversion clearing** (current liability)
  to **3900 Historical adjustment** (equity; the next free code up to 3999
  if 3900 is taken; the name only if it was still "Conversion clearing"),
  and migration 0038 then renames it **Opening balance** if it still has
  that starting name
  when nothing is posted to it. If something is (opening balances already
  brought in), it's left as it is, because an account's class can't change
  once it has postings; it's still used and still 0.00. Organisations with
  no conversion account get 3900 Opening balance. Importing a chart
  of accounts with `840,Historical Adjustment,Current Liability` (Xero's)
  re-codes 3900 to 840, named Historical Adjustment, and it **stays Equity**
  ("it stays Equity, not Current liability") rather than refusing the file.

### Not supported yet (refused rather than guessed)

- Opening balances on **foreign-currency accounts**.
- **Unused credit notes, overpayments and prepayments** at the conversion
  date (a negative amount owed).
- Open invoices and bills **brought in line by line** with their original
  accounts: each is one line (two when its GST is less than 3/23) on 3900,
  with the GST in what's still owed. Box 6 counts a zero-rated part only
  when its row has the ZERO code; the rest of a split document is treated as
  having no GST.
- A **GST account kept elsewhere** in the old system (GST on unpaid invoices
  in a separate account): add it to the GST line of the trial balance.
- **Unpresented payments and deposits** at the conversion date: the bank
  account's opening balance is taken as what the bank's statement said.
- Several **conversion dates** (for example bringing in history month by
  month), and importing **transactions** (invoices, bills and journals
  from before the conversion date, other than what's still owed).
- Contacts' **people**, customer groups, price levels and credit limits,
  items' units, price level prices, suppliers and kits, and payment terms
  from another system's day-and-term columns.

### Questions for Jess (bringing in existing books)

Decided with Jess (30 Sep 2026): open invoices and bills carry their GST, as
in Xero (IM13, IM17-IM20), and the conversion account is equity (IM1, IM21).
Also decided, following NetSuite: the trial balance's GST line is taken as
already including the GST in the open invoices and bills (NetSuite
migrations load open invoices and bills without tax, against an equity
opening balance account, so the tax balance comes only from the trial
balance), and the conversion account is named "Opening balance" (NetSuite's
name), code 3900 (NetSuite doesn't fix a number).

- **Rounding allowance**: GST within 0.05 of 3/23 of what's owed is one
  standard-rated line; more than 0.05 less is split in two (IM20). Is 0.05
  right?
- **Bank balances**: should the bank account's opening balance be the
  ledger balance (as built) with unpresented items entered as opening
  transactions, as in Xero?
- Is matching another system's "Accounts Receivable" (and Accounts Payable,
  GST, Inventory, Retained Earnings) to Tohyee's own account by name, and
  re-coding Tohyee's account to the other system's code, what you want?
- Should contacts without customer or supplier columns default to both
  (the screen's default for the other-system preset)?

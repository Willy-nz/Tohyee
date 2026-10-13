# Draft worked examples for #257–#259 (awaiting Jess)

Nothing in this file is built. AGENTS.md says accounting behaviour needs an
approved worked example first. Once an example is approved, it moves into
`docs/ACCOUNTING-EXAMPLES.md` with a test and gets built. Where the right
treatment is a judgement call, this file asks a question instead of guessing.

## One set of books for SCE1 and CF1

The financial year runs 1 Apr 2026 to 31 Mar 2027, starting from nothing.
GST is left out to keep the numbers simple (see question CF-Q1).

| # | What happened | Debit | Credit | Amount |
|---|---|---|---|---|
| 1 | Owner puts money in | 1000 Bank | 3000 Owner funds introduced | 5,000.00 |
| 2 | Term loan drawn | 1000 Bank | 2800 Term loan | 1,500.00 |
| 3 | Computer bought for cash | 1620 Computer equipment | 1000 Bank | 2,000.00 |
| 4 | Sales invoiced | 1100 Accounts receivable | 4000 Sales | 3,000.00 |
| 5 | Customers pay part | 1000 Bank | 1100 Accounts receivable | 2,200.00 |
| 6 | Expense bills | 6010 Accounting fees | 2000 Accounts payable | 1,350.00 |
| 7 | Bills paid in part | 2000 Accounts payable | 1000 Bank | 1,050.00 |
| 8 | Depreciation | 6300 Depreciation | 1630 Accumulated depreciation | 400.00 |
| 9 | Owner drawings | 3100 Owner drawings | 1000 Bank | 300.00 |

Net profit is 3,000.00 − 1,350.00 − 400.00 = **1,250.00**. The bank ends the
year on **5,350.00**.

### SCE1 Statement of changes in equity (draft)

| | Amount |
|---|---|
| Equity at 1 Apr 2026 | 0.00 |
| Net profit for the year | 1,250.00 |
| Owner funds introduced (3000) | 5,000.00 |
| Owner drawings (3100) | (300.00) |
| **Equity at 31 Mar 2027** | **5,950.00** |

Closing equity equals total equity on the balance sheet at 31 Mar 2027.
Opening equity equals total equity on the balance sheet the day before the
year starts.

- **SCE-Q1:** one column, or one column per equity account (owner funds,
  drawings, retained earnings, and reserves such as a livestock revaluation
  reserve)?
- **SCE-Q2:** each equity account's movements would be listed by the
  account's name. Is that enough, or do some accounts need fixed labels
  (for example "Capital introduced" for 3000)?

### CF1 Statement of cash flows, indirect method (draft)

| | Amount |
|---|---|
| Net profit | 1,250.00 |
| Add back depreciation (non-cash) | 400.00 |
| Increase in accounts receivable | (800.00) |
| Increase in accounts payable | 300.00 |
| **Net cash from operating activities** | **1,150.00** |
| Purchase of fixed assets | (2,000.00) |
| **Net cash from investing activities** | **(2,000.00)** |
| Owner funds introduced | 5,000.00 |
| Term loan drawn | 1,500.00 |
| Owner drawings | (300.00) |
| **Net cash from financing activities** | **6,200.00** |
| **Net increase in cash** | **5,350.00** |
| Cash at 1 Apr 2026 | 0.00 |
| **Cash at 31 Mar 2027** | **5,350.00** |

Proposed rule: cash means the bank accounts. Movements in current assets and
liabilities count as operating. Fixed and non-current assets count as
investing. Non-current liabilities and equity count as financing.

- **CF-Q1 GST:** should GST payable or refundable count as an operating
  working capital movement?
- **CF-Q2 Credit cards:** are credit card accounts cash (netted against the
  bank), or an operating liability?
- **CF-Q3 Interest:** is interest paid operating or financing? (NZ IFRS
  allows either.)
- **CF-Q4 Disposals and revaluations:** should a fixed asset sale show its
  proceeds under investing, with the gain or loss added back? Should a
  livestock revaluation (Herd Scheme) be added back as non-cash?
- **CF-Q5 Term deposits:** are they cash or investing?

## Questions only (no numbers yet)

### Killed for rations (livestock)

- **KR-Q1:** what value does an animal killed for the household or staff
  rations go out at: its book value under the valuation scheme, or market
  value? I'm not sure what IRD requires here, so I'd rather you tell me.
- **KR-Q2:** what is the double entry? For example, debit drawings (owner's
  rations) or wages/staff costs (staff rations), credit livestock on hand?
  Is the value taxable income, and is there GST on it?
- **KR-Q3:** should it count as a death in the tally reconciliation, or have
  its own line?

### Landed cost allocation

- **LC-Q1:** how should freight, duty and insurance on an import be split
  across the lines: by value, quantity, weight, or chosen per shipment?
- **LC-Q2:** if the costs arrive on a separate bill after some stock has
  been sold, should the sold share go to cost of sales or adjust the
  remaining stock?
- **LC-Q3:** should duty paid to Customs on one bill, and import GST, be
  handled differently from freight?

### Recoding posted invoices, bills and bank transactions

- **RC-Q1:** should recoding post a reversing journal plus a new one dated
  the same as the original, or the date of the change?
- **RC-Q2:** should it be allowed before the lock date only, and is a
  reason required?
- **RC-Q3:** may it change only the account and tracking, or the GST code
  too? A GST code change can alter a GST return that's already been filed.

# Fixed assets: NZ reporting and tax changes, about 2016 to 2026

Research for the ERP-level fixed assets work (docs/TODO.md, list of 2
October 2026, item 4). Jess asked (2 Oct 2026) to "look at nz reporting
changes for gaap in the last 10 years and make sure any difficult things
are taken into account".

Read on 2 Oct 2026, mostly through a summarising fetch tool, so the quotes
are as it returned them: **check them against the real pages before
relying on them.** Anything marked (unverified) wasn't confirmed from a
source in this session.

## Accounting standards (NZ GAAP)

| When | Standard | Who | What it means for Tohyee |
| --- | --- | --- | --- |
| Periods from 1 Jan 2019 (unverified: NZ IFRS 16 para C1 wasn't shown) | **NZ IFRS 16 Leases** ([XRB](https://standards.xrb.govt.nz/standards-navigator/nz-ifrs-16/)) | For-profit Tier 1 and 2 | Lessees put leases on the balance sheet: a right-of-use asset and a lease liability at commencement; the asset is depreciated to the earlier of its useful life and the lease term; the liability takes interest and is reduced by payments, and is remeasured when the lease is modified. Short-term and low-value leases can be expensed instead. Needs a lease register with schedules, not just an asset. |
| Periods from 1 Jan 2022 | **NZ IAS 16 Proceeds before intended use** ([XRB](https://www.xrb.govt.nz/standards/accounting-standards/for-profit-entities/property-plant-and-equipment-proceeds-before-intended-use/)) | For-profit | Money from selling things made while testing an asset goes to income, never off the asset's cost. Matters for assets under construction. |
| Periods from 1 Jan 2024 | **Lease Liability in a Sale and Leaseback** (NZ IFRS 16 amendment; [XRB recently issued](https://www.xrb.govt.nz/standards/recently-issued/new-accounting-standards/)) | For-profit | Sale and leaseback: the seller-lessee doesn't book a gain on the right of use it keeps. Rare for Tohyee's users; refuse rather than guess. |
| Periods from 1 Apr 2024 (early from periods ending after 15 Jun 2023) | **New Tier 3 (NFP) Standard** ([XRB](https://www.xrb.govt.nz/dmsdocument/4952/)) | Not-for-profit Tier 3 | Property, plant and equipment can now be revalued (independent valuation, or rateable value for land and buildings) without opting up to Tier 2. So revaluations are needed even for small not-for-profits. |
| Periods from 1 Jan 2027 | **NZ IFRS 18 Presentation and Disclosure** ([XRB](https://www.xrb.govt.nz/standards/accounting-standards/for-profit-entities/nz-ifrs-18/)) | For-profit | Changes the profit and loss layout (operating, investing, financing). Affects where depreciation and disposal gains show, more than the asset register. |
| Not yet effective in NZ | **IPSAS 43 Leases**, **IPSAS 46 Measurement** (current operational value), held for sale (IPSAS 44) | Public benefit entities | The Audit Office's [guidance for 30 June 2026](https://ao.parliament.nz/2026/financial-reporting-by-pbe) says no new standards apply that year and these are future work, NZ dates not set. PBEs still use PBE IPSAS 17 (property, plant and equipment) and PBE IPSAS 13 (leases). Design for them, don't build them yet. |

Long-standing rules (not changes, but the hard parts any ERP-level register
has to handle):

- **Revaluation model** by class of asset (NZ IAS 16, PBE IPSAS 17): the
  revaluation reserve, depreciation on the revalued amount, and what happens
  to accumulated depreciation; reserves by class for PBEs.
- **Impairment** (NZ IAS 36; PBE IPSAS 21 and 26 for non-cash- and
  cash-generating assets) and its reversal.
- **Components**: significant parts depreciated separately; replacing a
  part derecognises the old one.
- **Held for sale** (NZ IFRS 5): stops depreciation.
- **Donated and vested assets** for not-for-profits and councils (PBE IPSAS
  23): recognised at fair value, with income.
- **Restoration and dismantling costs** (NZ IAS 37) in an asset's cost.
- **Assets under construction** and capitalising borrowing costs (NZ IAS
  23).
- **Deferred tax** (NZ IAS 12) for Tier 1 and 2 entities on the difference
  between book and tax values, which each building depreciation change
  below moved.

## Tax depreciation (IRD)

| When | Change | Source | What it means for Tohyee |
| --- | --- | --- | --- |
| 2011-12 income year | Buildings with an estimated useful life of 50 years or more: 0% | [IRD tax policy](https://www.taxpolicy.ird.govt.nz/-/media/d7671cf9077f4b709c9a56dbecf5f936.ashx?modified=20240314003326) | Rates are dated, by income year. |
| 2020-21 income year | Non-residential buildings back to 2% DV (1.5% SL) | same | |
| 17 Mar 2020 to 16 Mar 2021 | Low-value asset write-off threshold temporarily $5,000 (was under $500 before 17 Mar 2020) | [IRD, claiming depreciation](https://www.ird.govt.nz/income-tax/income-tax-for-businesses-and-organisations/types-of-business-expenses/depreciation/claiming-depreciation) | The threshold depends on the date acquired. |
| From 17 Mar 2021 | Low-value threshold $1,000; low-value assets can be pooled, at the lowest rate in the pool | same | Pooling (IRD's pooling cap wasn't read this session). |
| From 1 Apr 2024 (2024-25 income year) | Commercial building depreciation 0% again; earlier deductions still recovered if sold above tax book value; fit-out still depreciable | [IRD Tax Technical](https://www.taxtechnical.ird.govt.nz/overviews/depreciation); tax policy paper above | Buildings and fit-out separate; depreciation recovery on sale. |
| From 22 May 2025 | **Investment Boost**: 20% of the cost of new (or new to NZ) depreciable assets deducted up front, depreciation on the other 80%. Includes commercial and industrial buildings and improvements; excludes NZ-sourced second-hand assets, residential rental buildings, most fixed-life intangibles. No value limit | [IRD Investment Boost](https://www.ird.govt.nz/income-tax/income-tax-for-businesses-and-organisations/types-of-business-expenses/new-assets---investment-boost), [what you can claim](https://www.ird.govt.nz/income-tax/income-tax-for-businesses-and-organisations/types-of-business-expenses/new-assets---investment-boost/what--you-can-claim-with-investment-boost) | A tax-only deduction, so tax book value differs from accounting from day one. How recovery on sale works wasn't on the pages read: check IRD's Investment Boost guidance before building it. |

## What this means for the plan

An ERP-level register (following NetSuite's Fixed Assets Management, as
Jess asked) needs at least: separate **book and tax** depreciation with
dated IRD rates, low-value write-offs and pools, Investment Boost and
depreciation recovery; **revaluations** (with Tier 3 not-for-profits now
allowed); **impairment** and reversal; **components**; **assets under
construction**; **leases** under NZ IFRS 16 for for-profits (PBE leases
kept as now until the XRB adopts IPSAS 43); **held for sale**; donated
assets; transfers between locations and departments; and imports from any
accounting system's register. Each needs worked examples in
`docs/ACCOUNTING-EXAMPLES.md` and decisions before it's built.

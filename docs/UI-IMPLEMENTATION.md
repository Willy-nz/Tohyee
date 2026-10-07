# Warm UI implementation

This branch applies `TOHYEE-UI-SPEC.md` to the shared shell, Home and shared
presentation primitives. Routes, role filtering, dashboard preferences and
accounting services retain their existing behaviour.

## Implemented

- Warm light tokens, pounamu actions, Georgia heading fallback and existing
  self-hosted Inter. Financial values remain sans serif and tabular.
- **No sidebar (Jess, 8 Oct 2026: keep the top bar).** The spec's 232px
  sidebar was tried in this branch and taken out again. The menus, organisation
  picker and app switcher stay in the existing top bar, in their existing
  order and with their existing names ("Accountant", "New"). Wide screens
  (1800px and up) keep their 1,560px pages (2 Oct 2026).
- Full organisation name and financial year in Home's greeting. The greeting
  uses the browser's local time and updates each minute.
- Open financial strip, dominant bank total, one Needs attention list,
  flat recent activity and bank health loaded from Banking's existing API.
- Explicit GST estimate, payable/refundable direction, basis and period.
  Failed or unconfigured GST estimates display Unavailable instead of zero,
  and a zero estimate says "Nothing to pay so far".
- Home's bank panel shows at most 5 active accounts (failed feeds first),
  with "Showing 5 of N" and a link to Banking, since an organisation can
  have about a hundred.
- Existing entity-keyed forms and request-keyed loads are preserved. Phone
  navigation contains keyboard focus and restores it when dismissed.
- Shared panel, button, input, table and dialog presentation; existing dark
  tokens remain, with stronger dark control boundaries for contrast.

## Outstanding spec items

- **Historical cash flow and cash balance:** Home currently supplies accrual
  profit by month; the cash-flow service supplies a forecast. Neither is the
  actual historical series specified here. Home keeps Net profit by month,
  explicitly labelled accrual profit, with its reporting range and currency.
  A historical cash-flow implementation needs an approved worked example and
  tests under the project's accounting rules. No forecast or accrual values
  have been relabelled as actual cash flow, and no inactive toggle is shown.
- **Mountain watermark:** a crop of Jess's own photo of Aoraki (only the
  mountain strip is stored, `public/images/aoraki-strip.jpg`), tinted with
  the theme's blue at 35%, behind Home's greeting; hidden on phones
  (decision 477).
- **Source limitations:** current bank totals include the existing ledger
  postings rather than a historical date cutoff. They are labelled current
  ledger balances, separately from outstanding-document dates. Bank identifiers
  are account codes because the existing API does not expose account numbers;
  no masked numbers are invented. Recent activity supplies a posting date,
  not an event timestamp. A failed feed supplies its last attempt timestamp,
  so a previous successful update date is unavailable in that state.

## Verification

- Lint, TypeScript, unit tests and production build run locally.
- Four presentation regression tests cover unavailable GST, refundable
  estimates, period/basis labels and the attention-list limit/empty state.
- Browser fixture checks render the actual shell, Home and styles with mocked
  Next navigation and API responses: 1440, 1280, 1024, 768 and 390 CSS pixels;
  drawer focus containment/return; viewer Create permissions; slow organisation
  switching; long names; empty data; GST errors; disconnected feeds; large
  amounts and negative balances; light and dark palette contrast.
- A 720 CSS-pixel viewport checks reflow equivalent to a 1440px window at
  200% browser zoom. This is a reflow check, not browser zoom automation.
- Database integration tests are skipped locally without TEST_DATABASE_URL.
  Live reconciliation to detail screens remains a database/CI acceptance check.

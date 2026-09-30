# Tohyee implementation style guide

## Layout

- `src/app/api/**/route.ts`: HTTP only. Parse the request, call a service
  through `withOrganisation()` (or `requireAuth()` for server-level routes),
  return JSON. Wrap every handler in `route()` so errors become consistent
  JSON responses.
- `src/lib/<area>/`: business logic (`ledger`, `inventory`, `accounts`,
  `contacts`, `invoices`, `bills`, `reports`, `tax`, `organisations`, `users`,
  `auth`).
- `src/lib/db/`: connections, transactions, migrations, provisioning.
- `src/app/operations/**`: screens. Client components talk to the API with
  `api()` from `src/lib/client/api.ts`.
- Code that runs in the browser may import **types** from server modules, but
  **values** only from browser-safe modules (`money/decimal`, `money/currency`, `money/fx`, `fx/rate-text`,
  `accounts/types`, `auth/roles`, `tax/categories`, `tax/exports`, `tax/purchase-defaults`, `contacts/countries`, `invoices/amounts`,
  `bills/accounts`, `customers/terms`, `repeating/schedule`, `repeating/bill-rules`, `reports/gst-boxes`, `items/pricing`, `budgets/fill`, `fixed-assets/depreciation`, `projects/amounts`, `import/fields`, `financial-year`, `format`, `errors`, `documents/format`,
  `documents/tax-invoice`, `email/addresses`, `email/templates`).

## Organisation data

- Always go through `withOrganisation(request, organisationId, minimumRole, work)`
  in routes. Never build a connection string from request input.
- Services receive an `OrgTx` (one open transaction on the organisation's own
  database, plus `tx.actor` and `tx.baseCurrency`). Don't open other
  connections inside a service.
- Use `tx.actor` for "who did this". Never accept an operator or reviewer name
  from the request body.
- No network calls inside a transaction.

## Money, dates and numbers

- Use `src/lib/money/decimal.ts`. Never `Number()`, `parseFloat` or `toFixed`
  on money, quantities or rates.
- Money is stored with the currency's minor units (`toFixedString`).
- Dates are `YYYY-MM-DD` strings; validate with `parseIsoDate`.

## Errors

- Throw `ValidationError` (400), `NotFoundError` (404), `ConflictError` (409),
  `ForbiddenError` (403), `UnauthorizedError` (401) or `UnavailableError`
  (503) from `src/lib/errors.ts`. Messages are shown to people: say what's
  wrong and what to do.
- Unexpected errors become a generic 500 and are logged on the server.

## Idempotency

- Every command that creates something takes an `idempotencyKey`.
- Store a `request_hash` (see `src/lib/idempotency.ts`) with the key. Check
  for an existing row *first*; same hash returns the original, a different
  hash is a 409.

## Database changes

- Add a new migration to `src/lib/db/migrations/tenant.ts` (organisation
  databases) or `core.ts`. Never edit one that has been released.
- Keep the database enforcing the important rules (balance, append-only,
  non-negative stock), not only the app.

## Tests

- `npm test` runs everything; database tests need `TEST_DATABASE_URL`
  (a login that can `CREATE DATABASE`).
- Pure calculations get unit tests in `tests/unit`. Anything touching SQL
  gets an integration test in `tests/integration` against real PostgreSQL.
- Accounting behaviour must match a worked example in
  `docs/ACCOUNTING-EXAMPLES.md`, and the test should cite its ID (e.g. W3).
- CI runs lint, typecheck, tests and a production build on pull requests and
  pushes to `main`.

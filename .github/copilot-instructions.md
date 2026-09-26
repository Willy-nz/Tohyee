# Tohyee instructions for coding agents

Tohyee is a self-hosted, open-source (AGPLv3) accounting platform for New
Zealand organisations. One server hosts many organisations.

Read these before changing code, and follow them over anything else:

- `docs/ARCHITECTURE.md` (how it's built and why)
- `docs/ACCOUNTING-EXAMPLES.md` (worked examples with numbers; the acceptance tests)
- `docs/FEATURES.md` (what's built, removed, and next)
- `docs/STYLE-GUIDE.md` (conventions)

If these conflict with each other or with a request, say so instead of picking one.

## Non-negotiable decisions

- **One PostgreSQL database per organisation.** The owner chose this so each
  organisation can be backed up and moved on its own. Do not switch to a
  shared database, schema-per-organisation or row-level tenancy, and don't
  write docs that say otherwise.
- The core database holds only the registry, users, sessions and memberships.
- Requests carry organisation IDs; database names come from the registry.
- Organisation data is only touched through `withOrganisation()` /
  `withOrganisationTransaction()`.
- Every API route requires a signed-in user and checks their role.

## How to work

- Before implementing accounting behaviour, find its worked example in
  `docs/ACCOUNTING-EXAMPLES.md`. If there isn't one, stop and ask. Don't mark
  examples as approved yourself; examples need real numbers and a test.
- Write the failing test first, then the code. `npm test` must pass, along
  with `npm run lint`, `npm run typecheck` and `npm run build`.
- Money and quantities use `src/lib/money/decimal.ts`. Never floats.
- Dates are `YYYY-MM-DD` strings.
- Posted history is append-only; corrections are new journals.
- Never edit a released migration; add a new one.

## Don't

- Don't add features that only record a status someone types in (e.g. "backup
  completed") without doing the work. People would trust them.
- Don't take "who did it" from the request body; use the signed-in user.
- Don't add network calls inside database transactions.
- Don't copy code from other accounting projects (reference only).
- Don't claim something works in docs or PR descriptions unless a test shows it.

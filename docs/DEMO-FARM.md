# The demo farm

**Try the demo farm** (#437, decisions 855-869) gives anyone signed in their
own copy of **Kōwhai Dairies Ltd**, a made-up Otago dairy farm, like Xero's
demo company. Jess asked for it to be included for now and taken out later,
so it is kept in one place and behind one switch.

## What it is

- An ordinary organisation with its own database, flagged as the demo farm in
  the core registry (`organisations.demo_for_user_id` and the `demo_*`
  columns, core migration 0020). One each; it goes when its person does.
- Made in the background from the organisation menu (**Try the demo
  farm…**) or `tohyee-admin demo add --owner EMAIL`. The build enters about
  18 months of data month by month through Tohyee's own services (as the
  person, as if they'd typed it): settings, accounts and contacts, opening
  balances and fixed assets, milk invoices to a made-up co-op, bills, bank
  transactions, monthly bank statements imported and reconciled, two-monthly
  GST returns filed and paid, depreciation, payroll for two staff (when the
  server has `TOHYEE_SECRET_KEY`; payroll needs it), the herd's movements and
  year-end counts, two farms with paddock maps, farm walks, grazings,
  supplements, fertiliser plans and applications, soil tests, co-op shares,
  benchmark figures, a season budget, the farm calendar and notebook, and
  Analytics (the books copied in, a shaped table and four reports). It takes
  about 20-40 seconds on a typical server.
- The dates move with today: the books start on 1 June at least twelve months
  back (12 to 23 months of data), and the same day always gives the same farm
  (a seeded random number source).
- It never reaches outside Tohyee: its automatic jobs are paused for good
  (`jobs_paused_at`, which a server admin can't turn on for it), and sending
  email, mailbox, bank, IRD and other connections, and adding people, are
  refused for it (`src/lib/demo/guard.ts`). A **DEMO** badge shows in the top
  bar on every page.
- **Reset** deletes it and makes it again; **Delete** drops its database and
  Analytics file. Both ask first.

## The switch

Set `TOHYEE_DEMO_FARM=off` in the server's environment and restart: "Try the
demo farm" goes from the menu and adding one is refused. Demo farms already
made stay until deleted (`tohyee-admin demo list`, then
`tohyee-admin demo delete --owner EMAIL --yes`).

`TOHYEE_DEMO_FARM_TODAY` is for tests only: it makes the farm as if today
were that date.

## Taking it out

1. Delete any demo farms (`tohyee-admin demo list`, then
   `demo delete --owner EMAIL --yes` for each), or let the migration in step 4
   remove their registry rows (their databases would then be left behind).
2. Delete the folder `src/lib/demo/`, and these files that only use it:
   `src/app/api/demo-farm/route.ts`, `src/app/operations/demo-farm/page.tsx`,
   `src/components/demo-farm.tsx`, `src/components/demo-farm.module.css`,
   `tests/integration/demo-farm.test.ts`, `tests/unit/demo-farm.test.ts`
   and this file.
3. Take out the small hooks into the rest of Tohyee (search for `demo`):
   - `src/lib/api/http.ts`, `src/lib/analytics/http.ts` and the members and
     handover routes under `src/app/api/organisations/[organisationId]/`:
     the `assertDemoAllows` lines.
   - `src/lib/email/documents.ts` (`requireAccount`): the
     `assertNotDemoForEmail` line.
   - `src/lib/organisations/registry.ts`: the `demo` field, its two columns
     and the `demo_status` condition in `listMembershipsForUser`.
   - `src/lib/backups/service.ts`: `and demo_for_user_id is null` in
     `pausedOrganisations` and `resumeOrganisationJobs`.
   - `src/lib/auth/page-workspace.ts`, `src/components/workspace.tsx` and
     `src/components/app-shell.tsx` (+ `.module.css`): `isDemo`,
     `demoFarmEnabled`, the menu entry and `DemoBadge`.
   - `scripts/admin.ts`: the `demo` commands and their help;
     `scripts/build-admin.mjs` can keep its externals.
4. Add a core migration that drops the index `organisations_one_demo_each`,
   the constraint `organisations_demo_shape` and the `demo_*` columns
   (`demo_for_user_id`, `demo_status`, `demo_step`, `demo_percent`,
   `demo_error`, `demo_started_at`, `demo_updated_at`, `demo_build_ms`).
   Never edit migration 0020 itself.
5. Remove the demo farm from `docs/FEATURES.md`, `README.md` and
   `website/index.html`, and record the removal in `docs/DECISIONS.md`.

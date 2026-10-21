# Multi-farm review

Follow-up review: [issue #390](https://github.com/Willy-nz/Tohyee/issues/390).

The operational changes provide a compact shared farm selector across maps,
soil, pasture and fertiliser. The choice is stored per user, organisation and
browser tab. Invalid or archived choices prompt for a new choice instead of
silently switching properties. Forms remain keyed to the selected farm.
Boundary-import previews identify their destination, cannot be reused for a
different farm, and lock controls during file reads and requests. Direct
fertiliser plans identify their farm and return to that farm's plan list.

Home remains an all-farms overview: its money, livestock and performance
figures are organisation-wide. This change does not implement separate farm
books, farm-level authorisation, new integrations or consolidated entities.
One database per organisation remains unchanged. No production data is seeded.

The review issue covers allocation/reconciliation for farm-level financial
reporting, all-farms operational comparisons, permissions, ambiguous email
attribution, provider-ID mapping and performance profiling.

## Release checks

Run the new nine-farm database regression with PostgreSQL: identical paddock
names and identical imported files must retain separate identities/import
histories for every property. Unit coverage includes ninth-farm selection,
invalid/archived choices, separate users/organisations, blocked browser storage,
selector rendering and valid/invalid import deep links.

Before release, perform browser/mobile checks for navigating between farms,
user/organisation/tab switching, archived choices, direct plan/import links,
and failed/in-flight previews. Confirm private calendar records remain private
and organisation-wide accounting totals are unchanged. These checks are not
claimed as complete by the source review; see the PR for executed validation.

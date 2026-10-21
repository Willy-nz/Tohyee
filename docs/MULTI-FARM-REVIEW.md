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

## Release checks (run 21 October 2026, Claude)

- Database: `tests/integration/farming-paddocks.test.ts` run against local
  PostgreSQL 16, including the nine-farm scenario (same-named paddocks and
  the same file imported into each of nine farms keep separate identities
  and import histories; an archived farm refuses imports).
- Browser (a copy of the demo databases with eight made-up farms added to
  the pasture demo, one archived, and paddocks named 1 and 2 on each):
  the choice carries across maps, soil, pasture and fertiliser; a second
  tab keeps its own choice; switching organisation and back keeps each
  organisation's choice; an archived remembered farm, an archived link and
  a link to a farm that doesn't exist each ask for a farm with a warning;
  `?farm=` links open the right farm and carry to the other pages; a plan
  opened directly names its farm and returns to that farm's plans; import
  links honour a valid farm and refuse an archived one; a bad file and a
  failed recheck clear the old preview and show the error; the farm, file
  and check controls are locked while a check is running; changing the
  destination clears the preview. A second (made-up) member saw only the
  calendar item shared with the team, not the owner's private items.
  Light and dark, 1280 and 390 wide, with no sideways scrolling.
- Home's server code isn't changed here; its money, livestock and
  performance figures are organisation-wide. Note that performance "per
  hectare" divides by the total area of all active farms, so adding a farm
  changes it; see #390's farm-level reporting follow-up.

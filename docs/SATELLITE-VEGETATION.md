# Satellite vegetation

Free Sentinel-2 satellite pictures of your paddocks, worked into a
greenness index (NDVI), on the farm map and over time (#612, decisions
1520-1540).

**It shows greenness, not feed available.** It isn't a pasture cover
reading and Tohyee never turns it into kg DM/ha.

## What it can and can't do

- The satellites pass every few days. They can't see through cloud, so a
  daily check doesn't mean a daily picture. A cloudy week can mean no new
  picture.
- Each pixel is about 10 m × 10 m. A paddock needs at least about 20 clear
  pixels (0.2 ha) before its number is used. Small paddocks, lanes and
  narrow strips are flagged, because their pixels mix in the fence, the race
  or the next paddock.
- Cloud, cloud shadow, water and anything the satellite couldn't classify
  are left out and shown as grey stripes. Missing is never shown as zero and
  never filled in.
- Change between dates is only worked out over the part of a paddock that
  was clear on both dates.
- The aerial photos (LINZ) stay for detail. The satellite layer is a dated
  overlay on top.

## What it costs

The pictures are free (Copernicus Sentinel data licence). Fetching them uses
a free Copernicus account's monthly allowance of processing units. Tohyee
asks only for your paddocks' area and the bands it needs, and stops when it
reaches the budget you set (2,000 units and 1,000 requests a month to
start). It never switches to a paid service. The free allowance was 10,000
processing units a month when this was written; your Copernicus account's
own page has today's figure.

Pictures are kept on the server's disk (`TOHYEE_VEGETATION_DIR`), up to the
storage limit you set (500 MB to start), and removed after 120 days. The
numbers worked out from them stay.

## Not yet tried against the live service

Tohyee's build machine can't reach the Copernicus Data Space Ecosystem and
has no account there. The Copernicus connection was written from the public
documentation and forum answers and tested only with a pretend service.
Before relying on it, run the pilot checklist below on your own server.
These parts are unverified:

- the sign-in address
  (`identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token`)
  and the words it uses for an account that isn't activated;
- the catalogue search (`stac.dataspace.copernicus.eu/v1/search`): its cloud
  filter, its paging, and the property names for the processing baseline
  (`processing:version` or `s2:processing_baseline`);
- the Process API request (`sh.dataspace.copernicus.eu/api/v1/process`):
  the Web Mercator box, 16-bit PNG output with four bands, and
  `harmonizeValues`;
- the `x-processingunits-spent` header, and the provider's out-of-allowance
  answer;
- whether the monthly allowance follows the calendar month.

## Pilot checklist (for Jess, on the home server)

The plan asks for real measurements before more farms are added. None were
made here, so none are quoted. Run this on the server Tohyee runs on.

1. **One farm first.** Set up satellite vegetation (Farm › Map › Satellite
   vegetation) for one farm whose paddock boundaries you trust, including at
   least one small or narrow paddock.
2. **Test one farm.** In setup, or under "Provider and processing details",
   press **Test one farm**. Write down what it shows:
   - the picture size (pixels) and bytes;
   - the time to search, fetch and work it out;
   - the server's memory before and after;
   - the processing units Copernicus charged (if it says "estimate", the
     provider didn't report it: note that);
   - how much of the farm was clear.
3. **Look at the preview.** Do the paddock colours make sense against what
   you know of the paddocks on that date? Are the grey stripes where cloud
   was?
4. **Turn it on for that farm** and leave it a week. Then note, under
   "Provider and processing details": dates fetched, processing units and
   requests used this month, and pictures stored.
5. **Work out the nine-farm budget.** Units per picture × about 6-12 dates a
   month (more where two satellite paths overlap) × 9 farms, plus the first
   60 days of history once each. Keep it well under the free allowance, and
   set the budget in Tohyee a little above it.
6. **Check the server stays quick.** While the first 60 days are fetched for
   a farm, use the books as usual. If anything feels slow, say so: the
   worker can be made slower.
7. **Check it against the paddocks.** Before telling anyone else to use it,
   compare a few dates with what was on the ground (grazed, shut up,
   cropped). This is the plan's last acceptance step and can't be done in
   code.
8. **Only then** turn on more farms, a few at a time.

Report back the figures from steps 2 and 4: they replace guesses in this
page.

## Files and backups

| What | Where | Backed up? |
| --- | --- | --- |
| Connection, budgets, thresholds | organisation database (`vegetation_settings`; secret encrypted) | yes, nightly |
| Dates fetched and where they came from | organisation database (`vegetation_scenes`) | yes |
| Paddock numbers | organisation database (`vegetation_observations`, never changed or deleted) | yes |
| Jobs | organisation database (`vegetation_jobs`) | yes |
| Pictures (raw bands, map pictures) | `TOHYEE_VEGETATION_DIR`, one folder per organisation and farm | no: they can be fetched again |

The client secret is restored with the database and re-keyed like the other
connections (Server settings › Backups › restore).

## Turning it off

- One farm: Farm › Map › Satellite vegetation › that farm › Turn off.
- Everything: Disconnect. The secret is deleted and fetching stops; the
  numbers already worked out stay.
- On a server: `TOHYEE_VEGETATION_SCHEDULER=off` stops the worker.

## Sources

The documentation the Copernicus connection was written from (fetched
through search results; the documentation site itself couldn't be reached
from the build machine):

- Copernicus Data Space Ecosystem: APIs, STAC, Sentinel-2 L2A, Process API
  examples, Authentication and Quotas pages linked from #612.
- Sentinel Hub forum, "Sentinel-2 processing baseline changes and
  harmonizeValues" (DN = 10000 × reflectance with harmonised values).
- Copernicus forum, "Sentinel-2 baseline ≥04.00 offset" (scale 0.0001,
  offset −0.1 on raw STAC assets).
- Copernicus Data Space Ecosystem, "Sentinel Hub PU Calculator"
  (1 unit = 512 × 512 pixels, 3 bands, 16 bits or less; 10,000 units a
  month for a free account).
- sentinelhub-py documentation, "Retrieving information about processing
  units of requests" (`x-processingunits-spent`).
- Exploring the CDSE STAC catalogue (the catalogue address, collection and
  cloud filter).

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

## Setting it up (about 10 minutes)

Farm › Map › **Satellite vegetation** (owners and admins). One thing a
screen; your progress is saved, so you can stop at any step and come back.

**What you'll need:** an email address you can open now, a second tab for
the Copernicus website, your paddock boundaries in Tohyee, and about 10
minutes.

> The buttons on the Copernicus site may be named slightly differently:
> these steps were written from the Copernicus documentation and couldn't
> be checked against the live site.

### 1. Make a free Copernicus account

1. Open **dataspace.copernicus.eu**.
2. At the top right, choose **Login**. On the sign-in page, choose
   **Register**.
3. Fill in your name, email, a password and your country. If it asks what
   you'll use it for, choose something like *Agriculture*. Tick the terms
   and choose **Register**.
4. Open the email from Copernicus (look in junk mail too) and choose the
   link to **confirm your email address**. The account doesn't work until
   you do.
5. Sign in once at dataspace.copernicus.eu to check it works.

### 2. Make the key Tohyee uses (an OAuth client)

1. Open the **Sentinel Hub dashboard**
   (shapps.dataspace.copernicus.eu/dashboard) and sign in with the same
   account.
2. In the menu on the left, choose **User settings**.
3. Under **OAuth clients**, choose **Create** (it may be a **+** button).
4. Name it *Tohyee*. Leave it to never expire if you can, otherwise choose
   the longest. Choose **Create**.
5. **Copy the client ID and client secret now.** The secret is shown only
   once.

### 3. Paste it in and test it

Paste the **Client ID** and **Client secret** into Tohyee and press **Test
connection**. Nothing is saved until the test works. Then press **Save**.

| What the test says | What to do |
| --- | --- |
| Wrong client ID or secret | Check you copied the whole secret. If it's lost, make a new client (step 2) and use that. |
| The account isn't activated yet | Confirm your email (step 1.4), wait a few minutes, test again. |
| This month's free allowance is used up | It starts again next month. Nothing is charged. |
| Copernicus couldn't be reached | Check the server has internet access, then try again. |

The secret is kept encrypted on your server. Tohyee never shows it again,
and it isn't sent to your browser, the logs or the AI.

### 4. Choose a farm and check its paddocks

Pick one farm whose boundaries you trust. Tohyee shows its paddocks on a
map. The box around them (plus 50 m) is all that's sent to Copernicus: no
names, records, stock or money. Paddocks without a boundary get no numbers;
paddocks under 0.6 ha will be flagged small. Press **These boundaries are
right**.

### 5. Test one farm

Press **Test one farm**. Tohyee fetches the clearest picture of the last 30
days and shows a preview on the map, with what it downloaded, how long it
took, the server's memory and the processing units it used.

### 6. Set a budget

Processing units and requests a month, storage on the server, and how many
days to keep pictures. Tohyee stops at these limits and says so; it never
goes over and never switches to a paid service.

### 7. Turn it on

Press **Turn on satellite vegetation**.

### Done: what happens next

- The first pictures arrive within a day if it isn't cloudy. The last few
  weeks come first, a few at a time, so the books stay quick.
- After that it checks once a day. A new clear picture comes every few
  days, less often in cloudy weather.
- On the farm map, choose **Vegetation** (greenness) or **Change** (since
  the date before). Tap a paddock for its numbers and trend.
- If it pauses (budget used up, or the account stops working), the map and
  the Satellite vegetation page say why and what to do.

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

## Offline, Analytics, the AI

- **Offline:** a farm's offline map keeps the latest clear picture and up to
  3 earlier ones (2 MB at most), with their dates, legend and attribution,
  and each paddock's trend. Shown from the device, the map says so and
  since when. Wi-Fi-only downloads aren't built (browsers on iPhones can't
  tell Wi-Fi from mobile data).
- **Analytics:** `tohyee_farm_paddock_greenness`, a row a paddock a date.
  Like the other farm tables, only for members who see every farm.
- **The AI:** the read-only `paddock_greenness` tool. It gets the numbers,
  their dates, how clear they were and what makes them uncertain, and is
  told never to turn greenness into kg DM/ha. It never sees the connection.

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

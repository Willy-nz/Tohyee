# Tohyee on phones and tablets

Tohyee can be added to a phone or tablet's Home Screen from your own Tohyee
server. It opens your server with your usual sign-in, shows what your role
lets you use, and keeps the farm pages working when there's no signal
(issue #472, decisions 990-998).

**Not yet tried on a real iPhone or Android phone.** Everything here was
checked in Chromium on a computer, with the server switched off to stand in
for no signal, and again on 29 October 2026 in Chromium with a phone's
screen size and touch (no WebKit, so not Safari), its connection switched
off and a simulated GPS route for tractor mode (decisions 1046-1049). Stage 1 of #472 (a spike on real phones) is still to do:
offline reopening, storage limits and whether iOS clears them, the camera,
GPS, Wake Lock, and reaching the server through Remote access and Tailscale.

## Installing

Open **Get Tohyee on this device** (`/get-tohyee` on your server; also in
the account menu, the sign-in page and Farm › More). It works out the
browser and device and shows their steps first, then every other
browser's (decisions 1112-1113, #498):

- **iPhone or iPad, Safari:** tap **Share** (the square with an arrow; on
  iOS 26 it's in the **⋯** menu), then **Add to Home Screen**, then
  **Add**. Open Tohyee from the icon and sign in once more: iOS keeps the
  icon's sign-in separate from Safari's.
- **iPhone or iPad, Chrome, Edge or Firefox** (iOS 16.4 or later): their
  **Share** › **Add to Home Screen**. If it isn't there, use Safari.
- **Android, Chrome:** **Install** when offered, or ⋮ › **Add to Home
  screen** › **Install**.
- **Android, Firefox:** ⋮ › **Install** (some versions say **Add app to
  Home screen**), then drag the icon or tap **Add automatically**
  ([Mozilla's help](https://support.mozilla.org/en-US/kb/use-web-apps-firefox-android)).
- **Android, Samsung Internet:** the install icon in the address bar, or
  ☰ › **Add page to** › **Home screen**. **Edge:** ⋯ › **Add to phone**.
- **Computer, Chrome or Edge:** the install icon in the address bar.
- **Firefox on Windows:** **Add tab to taskbar** in the address bar, from
  version 143 where it's there. **Firefox on a Mac or Linux** can't
  install web apps: that's Firefox, not a fault; use Tohyee in the tab.
- **Safari on a Mac** (macOS Sonoma or later): File › **Add to Dock**.
- **A link opened inside Facebook, Messenger, Instagram or an email
  app:** open it in a browser first.

It's a web app added by the browser: there's no app-store app and no APK
to download. Chrome and Edge also offer an Install button on the page;
the written steps are always shown too, because other browsers don't.
There's no app store. The icon always opens the server it was added from;
to use another server, add it from that server's address (each keeps its
own copies).

### The address must use HTTPS

Phones only install a web app and keep it offline on an HTTPS address (or
`localhost` on the computer itself).

- **Remote access** (a Tohyee web address, or your own Cloudflare tunnel)
  is already HTTPS. Use that address.
- **Tailscale:** turn on HTTPS certificates (Tailscale admin console › DNS ›
  HTTPS Certificates) and share Tohyee with `tailscale serve`, then use its
  `https://<computer>.<tailnet>.ts.net` address. It stays private to your
  tailnet; nothing is opened to the internet.
- **A home-network address** like `http://192.168.1.20:3000` works in the
  browser but can't be installed or used offline.

## Farm on a phone

Farm is its own app (decisions 1110-1111): the app switcher, or the ☰
menu on a phone, moves between Accounting and Farm. The Farm tabs
(Today · Map · Log · Safety · More) are on every farm page, including one
opened from a link, after a reload or with no signal. More has the full
Farm menu, Effluent first. Safety's first card is **Emergency details**.

## Your location on the maps

Every farm map has **Use my location** (decisions 1115-1118). It shows
where you are as a blue dot with its accuracy, on this device only:
nothing is sent or shared. If location was blocked, the button says
**Location blocked: how to fix** and the steps for your browser are shown
with **Check again**. Browsers don't ask a second time once it's blocked.
The maps work without it. Tractor mode has **Check GPS** before Start,
and says it's limited: keep Tohyee open and the screen unlocked while
recording.

## What works without a connection

| | Offline |
|---|---|
| Farm › Today, Map, Log, Safety, More, Offline, Tractor mode (the pages) | Open, once Tohyee has been opened with a connection |
| Farms and paddocks, Pasture and feed, Soil tests, Farm calendar, Fertiliser plans, Farm notebook | Open the same way (decision 1056), showing what's kept |
| Your farms' information (below) | Kept automatically; shown as **last known** |
| Get Tohyee on this device | Opens |
| The books, reports, settings and everything else | Needs a connection; says so |
| Log: cover readings, mob in and out, feed, the farm walk | Kept on the device, sent later |
| Safety: report a hazard, near miss or incident (with photos) | Kept on the device, sent later |
| Safety: pre-start checks, marking your action done, signing an induction, signing in and out | Kept on the device, sent later |
| Tractor mode: recording a job, Finish | Kept on the device fix by fix, sent later |
| Effluent: start, shift and stop a run, pond readings (with photos), not applied today | Kept on the device, sent later |
| Approvals (releasing equipment, checking or closing actions) | Always need a connection |

### Farm information kept on the device

After you sign in with a connection, and whenever Tohyee is open with one,
every farm you can see is kept on the device by itself (decisions
999-1007). Nobody has to open each screen first. Farm › More › **Offline on
this device** shows each farm's parts, when each was kept and its size.

| Part | What's kept |
|---|---|
| Farms and settings | The farms you can see, which farm you were on, map settings, farm app tiles |
| Safety | Emergency details, hazards and no-go zones, reports and actions (never injury or medical details), what needs doing |
| Map and paddocks | Paddocks with boundaries and areas, and each paddock's own page; each paddock's last known cover, mob and grazing |
| Pasture, grazing and feed | Farm cover and wedge; every cover reading, grazing and feed record for the last 12 months (up to 20,000 each); mobs in now |
| Calendar and jobs | Your farm calendar, 12 months back to 3 months ahead (no email text); safety dates for the next 3 months |
| Equipment and checklists | Machines, checklists, last known status and recent checks; chemicals; tractor mode's machines and the farm's tractor jobs |
| Inductions and training | Inductions to read and sign, with the farm's hazards and emergency details; training |
| Effluent | Systems, ponds, blocks, no-apply zones and consent conditions; the last 30 days of runs, pond readings and days not applied |
| Fertiliser plans | The farm's plans and their applications; products (not for Farm staff) |
| Soil tests | Samples, results, the summary and each paddock's soil history |
| Farm notebook | The notebook (not for Farm staff) |
| Photos and documents | Small copies of safety photos (800 pixels); safety data sheets up to 2 MB |

Never kept on a device, whoever you are: injury and medical details and
restricted photos (even for owners), farm mail and the email text behind
calendar items, the books, and payroll.

What you see offline is the **last known** information: a notice under the
farm bar says when it was kept, that mobs, machinery, actions and who's on
site may have changed, and that lists and searches only cover what's kept.
Histories (readings, grazings, feed) page and filter by date and paddock on
the device as they do online, and say from which date they're kept. A
summary for a day earlier than the one kept (the farm's cover on a past
date) needs a connection (decisions 1054-1055). A farm is **Ready offline**
only when its information and all its screens are on the device.
If an update fails part way, the previous copy of that part stays. On the
Offline page you can keep 3 years of history or original photos for a farm,
update now, or remove a farm's copy (it's kept again at the next update).

Not kept yet: a separate livestock register (mobs come from grazings), and
farm contacts beyond the emergency details.

### Aerial photos without a signal

When the organisation has a LINZ key (Settings › Aerial photos for farm
maps), a phone or tablet keeps the aerial photos for each farm's area by
itself, after the farm information is updated (#485, decisions
1063-1065). Computers keep them only when you press **Keep aerial photos
on this device** on the Offline page.

- **What:** the paddocks' outline box plus 300 m, zoom 14 (the whole farm)
  to 18 (gateways and troughs). At most 1,500 photos a farm and 4,000 and
  100 MB on the device; a big farm keeps fewer close-up zooms. A 200 ha
  dairy farm is a few hundred photos, about 5-10 MB.
- **How:** straight from LINZ to the phone, one photo every 125 ms (well
  under LINZ's limit for standard keys), only what isn't kept already, at
  most every 12 hours. Tohyee's server never fetches or keeps photos.
- **Offline:** the map asks LINZ first and uses the kept copy when LINZ
  can't be reached (or the key has run out). Closer than zoom 18, or
  outside the farm's area, there's no photo offline; paddock outlines
  always show.
- **Same rules as the farm information:** only for the account signed in,
  only within the 14 days, deleted when you sign out or someone else signs
  in, and deleted when the key is removed. The Offline page shows how many
  are kept, their size, and Remove.
- Imagery © LINZ CC BY 4.0, shown on the map and the Offline page.
- **Not yet tried on a real phone or with LINZ itself** (LINZ couldn't be
  reached from where this was built): the tests use a pretend LINZ.

### Limits

- **14 days.** What's saved opens offline for 14 days after you last signed
  in with a connection. After that it's locked until you sign in again with
  a connection. Nothing waiting to be sent is lost.
- **A copy, not a backup.** The device keeps a copy for working away from a
  signal. Tohyee's backups are on the server.
- **One account per device.** When someone else signs in on the device, the
  previous person's saved pages and farm information are deleted first
  (their unsent work stays, only for them).
- **Signing out** deletes the saved pages and farm information. If anything
  isn't sent yet, Tohyee asks whether to send it first; whatever still
  can't go stays on the device, only for you, and goes at your next
  sign-in there.
- **Access removed on the server** can't reach a phone with no signal. It
  keeps what it had for up to 14 days, and the server refuses anything it
  sends after the session ended.
- **Another account signed in.** Work saved on the device is only ever sent
  as the account that made it. If someone else signs in in the same
  browser, an older tab stops sending and says so, and the work waits for
  its own account (decisions 1050-1051).
- **iPhone storage:** Apple may clear a web app's storage if it isn't used
  for a while. Not yet checked on a real iPhone.

## Statuses for work recorded on the device

- **Unsaved:** the device's storage wouldn't keep it (full or blocked). Keep
  the screen open until it's sent.
- **Saved on this device:** kept, not ready to send yet.
- **Waiting to send:** kept; it goes when Tohyee can be reached. Nobody has
  been told yet.
- **Synced:** Tohyee has it.
- **Needs attention:** Tohyee refused it (for example someone changed the
  record first). Check the reason, then fix it or let it go.

It's sent when a Tohyee page opens, when the connection comes back, when
the app comes back to the screen and every 30 seconds while anything
waits. Each record carries its own id, so sending it twice records it once.

### Safety without a signal

- **Emergency details and hazards** come from the farm information kept on
  the device, with their age shown. Call 111 always works.
- **Report something** works offline; photos are kept as small copies (and
  where the phone was, if you tick "Add where I am to the photo") and sent
  first.
- **Pre-start checks** are saved against the checklist version on the
  device. The machine shows **Checked on this device** until it's sent,
  and the machines are read again once it is. A failed critical check shows **Fault on this device** on the
  machine straight away: don't use it. Nobody has been told until it's
  sent; then Tohyee puts it out of use and makes the action. If the
  checklist changed meanwhile, the check needs doing again.
- **Signing an induction** is saved against the version you read; if it
  changed meanwhile, you're asked to read it again.
- **Signing in and out** keep the phone's time. Pending sign-ins aren't on
  Tohyee's On site list until they're sent: don't rely on it for a
  headcount.
- **Releasing a machine, checking or closing actions** always need a
  connection, because Tohyee checks who may do it at the time.

### Tractor mode without a signal

Tractor and spreader mode (decisions 1020-1030) records with or without a
signal, while Tohyee is on screen.

- **While recording**, each GPS fix is kept on the device as it arrives,
  in tractor mode's own store. If Tohyee closes, **Carry on** picks the job
  up. If the device's storage refuses a fix (it's full), **NOT SAVED ON
  THIS DEVICE** stays on screen with how many fixes are waiting, Tohyee
  keeps trying, and they're kept in order once there's room; the job isn't
  sent until its whole track is kept. If Tohyee closes first, the job's
  history shows the gap (decision 1057).
- **Finish** hands the job to the same list of work on this device as
  everything else, with the same statuses. **Send** and **Send later** both
  keep the product, rate and notes typed on Check and send; Send later
  just doesn't wait for the answer. It's sent once, whenever Tohyee
  can be reached. The tractor page shows each finished job's status; if
  Tohyee refuses one, it shows the reason, **Send again** and **Remove from
  this device**.
- **The track stays on the device** until Tohyee has it, even if the job is
  let go from the list of work.
- **Hazards and no-go zones** on the tractor map are the ones from when the
  job started. With no signal, if the farm's offline copy is newer (or the
  job started without them), the map shows that copy and says how long ago
  it was updated. They're a reminder only and may have changed.
- Starting a new job uses the machines kept in the farm's offline copy
  when there's no signal (decision 1056).

## For developers

- `public/sw.js` and `public/sw-rules.js`: the service worker (built files
  kept; farm pages fetched first, saved per server and account; the API is
  never cached by the worker). `public/sw-tiles.js`: LINZ aerial photos
  answered from the kept copies when LINZ can't be reached (#485).
- `src/lib/farming/imagery.ts` (the key's age, the farm's area and its
  tiles) and `src/lib/farming/imagery-device.ts` (checking a key in the
  browser, keeping and removing photos in Cache Storage).
- `src/lib/offline/idb.ts`: the `tohyee-offline` IndexedDB database.
- `src/lib/offline/queue.ts`: the queue. Usage:

  ```ts
  const queue = await openQueue({ server: location.origin, userId, organisationId });
  const { item, stored } = await queue.add({
    kind: "safety.report",            // what it is
    label: "Near miss: race",         // for lists
    farmId, farmName,                 // the farm it belongs to
    request: { method: "POST", path: "/api/farming/safety/reports", body },
    ready: true,                      // false: "Saved on this device" until markReady()
    blobs: { photo },                 // optional files, by name
  });
  queue.subscribe(() => render(queue.items({ farmId })));
  queue.shownStatus(item);            // unsaved | saved | waiting | synced | attention
  ```

  `organisationId` and `operationId` are added to the body when sent.
  `request.files: [{ blob: "photo", field: "contentBase64" }]` puts a blob
  into the body as base64; `request.refs: [{ path: ["files", "0", "id"],
  from: <earlier operationId>, field: ["file", "id"] }]` fills in an earlier
  item's answer and waits for it. `change()` and `putBlob()` work only
  before the first send; after that, make a new item. Approval kinds
  (`SERVER_ONLY_KINDS`) are refused. `OfflineSupport` (in every signed-in
  page) sends the queue; screens can call `queue.sync()` too.
- Tractor mode: `src/lib/farming/tractor-store.ts` keeps each fix as it
  arrives (database `tohyee-tractor`); `src/lib/farming/tractor-queue.ts`
  turns a finished job into one queue item (kind `tractor.job`, operation
  id = the job's id) with the track as a file sent as `trackBase64`
  (decisions 1028-1029), and picks the hazards shown (decision 1030).
- `src/lib/offline/device.ts`: platform and address checks, the service
  worker messages, the 14-day rule and one account per device.
- Farm packs: `src/lib/offline/pack-inventory.ts` (the parts and answering
  a read from them), `pack-server.ts` (built from the farm routes' own
  handlers), `pack-redact.ts` (what never goes in), `packs.ts` (keeping
  and reading them on the device), `GET /api/farming/offline-pack` and
  `/api/farming/offline-pack/file`. `api()` asks the pack when Tohyee
  can't be reached (`setOfflineReader`).

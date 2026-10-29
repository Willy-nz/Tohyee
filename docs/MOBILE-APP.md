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

It's a web app added by the browser, not an app-store app. Chrome and
Edge also offer an Install button on the page; the written steps are
always shown too, because other browsers don't. On Android there's also
an app to download (an APK): see [The Android app](#the-android-app). The icon always opens the server it was added from;
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
and says it's limited in a browser: keep Tohyee open and the screen
unlocked while recording. The Android app keeps recording with the screen
locked.

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

## Sharing your location with the farm (privacy)

Farm › Map › **People on the map** lets someone show the people who work on
that farm where they are (#498 item 7, decisions 1125-1134; not yet
reviewed by Jess). Privacy comes first:

- **Your choice, each time.** It's never on by default and no one else can
  turn it on for you. You press **Share my location…**, read the notice and
  choose how long: 1, 2, 4 (the default), 8 or 12 hours. It stops by itself
  at the time shown.
- **Only while Tohyee is open.** The browser's location is used only while
  Tohyee is open and on screen on that phone. Locking the phone, switching
  apps or closing the tab stops it; showing Tohyee again carries on until
  the end time. Nothing runs in the background.
- **Stop sharing** is on every farm page while you share. It deletes your
  position straight away.
- **Who sees it:** people in the same organisation who work on that farm
  (decision 744), checked by the server. No one in another farm or
  organisation can ask for it.
- **What's kept:** only your latest position, its accuracy and when it was
  taken. Each new one replaces the last, so there's no trail of where
  you've been.
- **How long:** deleted when you stop, when your time runs out (the server
  checks every 10 minutes) and never kept for more than 24 hours. If you
  stop working on that farm or leave the organisation, it's deleted then.
- **Never in:** exports, Analytics, AI tools, the audit trail, the offline
  farm pack, or Tohyee's backups (they leave the table's rows out). The
  database's own write-ahead log, and any disk or server snapshot taken
  outside Tohyee, can hold a position until they're recycled; that's
  unavoidable with PostgreSQL.
- **Starting and stopping** are recorded in the audit trail, not your
  positions.
- **Old positions say so.** A marker updated in the last 5 minutes is solid
  ("Updated 2 min ago"). Older is grey and dashed, "Last known … (not
  live)". If you're looking at the map with no signal, everything reads
  "not live". A rough fix (over 100 m) shows as an area, never a dot, and
  one over 2 km out isn't kept.
- **Staff privacy:** staff positions are personal information under the
  Privacy Act 2020. Tohyee shows this notice before anyone shares, but a
  farm may want a line about it in its own staff privacy statement. This
  isn't legal advice.

The notice shown before sharing (from `src/lib/farming/locations-shared.ts`):

> Tohyee keeps only where you were last seen, how accurate it was and when.
> No trail of where you've been. People in this organisation who work on
> this farm can see it on the farm map while you share. No one else can. It
> only sends while Tohyee is open on this phone. Locking the phone or
> switching apps stops it. Your position is deleted when you stop sharing or
> the time runs out, and never kept for more than 24 hours. It isn't in
> exports, backups, the offline farm pack or AI tools. Starting and stopping
> are recorded (not your positions). Sharing is your choice: you can stop at
> any time, and no one can turn it on for you.

**Not yet tried on a real phone**, like the rest of this page: checked in
Chromium with a phone's screen size and a simulated location.

## The Android app

Tohyee for Android (#502, decisions 1140-1152) is one app for everyone: the
first time, you type your Tohyee address and it opens your own server
inside the app. It's the same pages as the web app, from your server, so
it never falls behind the server, and the offline pages, farm information
and work saved on the phone all carry on inside it. **Not yet tried on a
real Android phone**: it's built and checked automatically (CI and tests),
not on a device. Not on the Play Store yet.

What it adds to the web app:

- **Tractor mode with the screen locked.** Recording carries on with the
  screen off or another app open, while Android shows "Tohyee is recording
  a tractor job". Location (While using the app) and notifications are
  asked for when you start a job, after Tohyee says why. Turning location
  off, a flat battery or swiping Tohyee away from recent apps still stops
  it, and that time is a gap.
- **Reminders as notifications**, if you turn them on (Get Tohyee on this
  device › Turn reminders on): shift the pods or irrigator at the time the
  run says, read the pond (each morning until it's read), Effluent's weekly
  checks, servicing and Effluent WoF, your own safety actions on their due
  day, and for admins the LINZ aerial photos key's reminder and expiry.
  Days arrive at 7 am. They're worked out by your server and set on the
  phone each time Tohyee opens, for the next two weeks; there's no push
  server, so they come without a signal too. Something already due isn't
  notified (it's on Today). Turning them off or signing out removes them.
- **The phone's camera and photo picker** where Tohyee takes photos
  (Safety, Effluent, pre-start faults): **Take a photo** or **Choose a
  photo**. The photo's time goes with it; where it was taken only when you
  tick "Add where I am".

Also: Android's back button closes an open dialog or goes back a page;
links to other websites open in the phone's browser.

### Installing it

Get Tohyee on this device (in a browser on the phone) has the steps under
**Android: download the app**:

1. Open [Tohyee's latest release](https://github.com/Willy-nz/Tohyee/releases/latest)
   on the phone and, under **Assets**, tap `Tohyee-<version>.apk`.
2. Tap **Open** when it's downloaded (or Files › Downloads).
3. Android says the phone "isn't allowed to install unknown apps from this
   source": tap **Settings**, turn on **Allow from this source**, go back,
   tap **Install**. "Unknown apps" means any app not from the Play Store;
   Android asks you to allow the browser to install it, so a website can't
   install anything without you.
4. If **Google Play Protect** warns that it doesn't know the app, that's
   because it isn't on the Play Store, not because it found something
   wrong. Tap **More details** › **Install anyway** once you're sure the
   file came from Tohyee's releases. Each release has a `.sha256` beside
   the APK to check the download.
5. Open Tohyee, type your Tohyee address, **Check**, **Open Tohyee**, sign in.
6. You can turn **Allow from this source** off again afterwards (Settings ›
   Apps › Special app access › Install unknown apps).

To update, install the newer APK over the old one; the address and what's
saved stay. `Tohyee-<version>-test.apk` is a test build (no release key):
it installs separately as "Tohyee (test)" and can't be updated to the real
app.

### The address

It must be HTTPS, as for the web app: your Remote access address, or a
Tailscale `https://….ts.net` address with the Tailscale app on and
connected. The app checks it answers as Tohyee (`GET /api/app/identify`)
before keeping it, and only ever opens that address. To change it: Get
Tohyee on this device › **Change Tohyee address** (what's saved on the
phone for the old address stays, for when you go back). If the server
can't be reached and nothing is saved yet, the app says so with **Try
again** and **Change Tohyee address**.

### Not in the app yet

- Downloading files from inside the app (exports, PDFs): use the browser.
- Connecting farm mail to Google or Microsoft: their sign-in opens in the
  phone's browser, so connect mail from a browser.
- The Play Store, iPhone, and push notifications.

### Signing the Android app (for whoever publishes releases)

Releases are signed with one key, kept in the repository's secrets. Make
it once, on your own computer (Java's `keytool`, which comes with any JDK
or Android Studio):

```sh
keytool -genkeypair -v -keystore tohyee-release.keystore -storetype PKCS12 \
  -alias tohyee -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Tohyee, O=Tohyee, C=NZ"
base64 -w0 tohyee-release.keystore > tohyee-release.keystore.b64   # macOS: base64 -i tohyee-release.keystore
```

Then in GitHub › the repository › Settings › Secrets and variables ›
Actions › **New repository secret**, add:

| Secret | What |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the contents of `tohyee-release.keystore.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | the password keytool asked for |
| `ANDROID_KEY_ALIAS` | `tohyee` (the `-alias`) |
| `ANDROID_KEY_PASSWORD` | the same password (a PKCS12 keystore has one); may be left out |

Keep the keystore and its password somewhere safe and backed up, never in
the repository: every later version must be signed with the same key, or
phones won't install it as an update. Delete the `.b64` copy once it's in
the secrets.

Without the secrets, a release gets the test build instead. The build job
never sees the secrets: it makes an unsigned APK, and a separate job that
runs only `scripts/sign-android-apk.sh` (the Android SDK's `zipalign` and
`apksigner`, no npm or Gradle) signs it. Pull requests and manual runs
check that script with a throwaway key.

To build a test APK from any branch: GitHub › Actions › **Android app** ›
**Run workflow** (it's under the run's Artifacts). Pull requests that
change the app build one too.

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
- The Android app (#502): `android/` (Capacitor 8; `MainActivity`,
  `TohyeeServer` and `TohyeeServerPlugin` keep and open the address),
  `android-shell/` (the bundled first-run and can't-reach pages;
  `npm run android:sync` builds its script and copies it and the plugins
  into `android/`), `capacitor.config.json`, and
  `.github/workflows/android-app.yml`. Web side: `src/lib/native/bridge.ts`
  (finding the app and its plugins), `location.ts` (tractor mode's
  background GPS), `notifications.ts` (planning and scheduling
  reminders), `camera.ts`, `server-address.ts` (the first-run check),
  `device-reminders.ts` (the server's reminders),
  `src/components/native-app.tsx` (back button, tapped reminders,
  refreshing) and `android-app.tsx` (the install steps and the app's
  settings). Building it locally needs JDK 21 and the Android SDK:
  `npm ci && npm run android:sync && cd android && ./gradlew assembleDebug`.
- `src/lib/offline/device.ts`: platform and address checks, the service
  worker messages, the 14-day rule and one account per device.
- Farm packs: `src/lib/offline/pack-inventory.ts` (the parts and answering
  a read from them), `pack-server.ts` (built from the farm routes' own
  handlers), `pack-redact.ts` (what never goes in), `packs.ts` (keeping
  and reading them on the device), `GET /api/farming/offline-pack` and
  `/api/farming/offline-pack/file`. `api()` asks the pack when Tohyee
  can't be reached (`setOfflineReader`).

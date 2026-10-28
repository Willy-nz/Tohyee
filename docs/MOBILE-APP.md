# Tohyee on phones and tablets

Tohyee can be added to a phone or tablet's Home Screen from your own Tohyee
server. It opens your server with your usual sign-in, shows what your role
lets you use, and keeps the farm pages working when there's no signal
(issue #472, decisions 990-998).

**Not yet tried on a real iPhone or Android phone.** Everything here was
checked in Chromium on a computer, with the server switched off to stand in
for no signal. Stage 1 of #472 (a spike on real phones) is still to do:
offline reopening, storage limits and whether iOS clears them, the camera,
GPS, Wake Lock, and reaching the server through Remote access and Tailscale.

## Installing

Open **Get Tohyee on this device** (`/get-tohyee` on your server; also in
the account menu, the sign-in page and Farm › More). It shows the steps for
the device you're on:

- **iPhone or iPad:** in Safari, tap **Share** (the square with an arrow),
  then **Add to Home Screen**, then **Add**. Open Tohyee from the icon and
  sign in once more: iOS keeps the icon's sign-in separate from Safari's.
- **Android:** in Chrome, tap **Install** (or ⋮ › **Install app**; some
  phones say **Add to Home screen**).
- **Computer:** in Chrome or Edge, click the install icon in the address
  bar.

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

## What works without a connection

| | Offline |
|---|---|
| Farm › Today, Map, Log, Safety, More, Offline (the pages) | Open, once Tohyee has been opened with a connection |
| Your farms' information (below) | Kept automatically; shown as **last known** |
| Get Tohyee on this device | Opens |
| The books, reports, settings and everything else | Needs a connection; says so |
| Log: cover readings, mob in and out, feed, the farm walk | Kept on the device, sent later |
| Safety: report a hazard, near miss or incident (with photos) | Kept on the device, sent later |
| Safety: pre-start checks, marking your action done, signing an induction, signing in and out | Kept on the device, sent later |
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
| Map and paddocks | Paddocks with boundaries and areas; each paddock's last known cover, mob and grazing |
| Pasture, grazing and feed | Farm cover and wedge; readings, grazings and feed for the last 12 months; mobs in now |
| Calendar and jobs | Your farm calendar, 12 months back to 3 months ahead (no email text) |
| Equipment and checklists | Machines, checklists, last known status and recent checks; chemicals |
| Inductions and training | Inductions to read and sign, with the farm's hazards and emergency details; training |
| Fertiliser plans | The farm's plans and their applications; products (not for Farm staff) |
| Soil tests | Samples, results and the summary |
| Farm notebook | The notebook (not for Farm staff) |
| Photos and documents | Small copies of safety photos (800 pixels); safety data sheets up to 2 MB |

Never kept on a device, whoever you are: injury and medical details and
restricted photos (even for owners), farm mail and the email text behind
calendar items, the books, and payroll.

What you see offline is the **last known** information: a notice under the
farm bar says when it was kept, that mobs, machinery, actions and who's on
site may have changed, and that lists and searches only cover what's kept.
If an update fails part way, the previous copy of that part stays. On the
Offline page you can keep 3 years of history or original photos for a farm,
update now, or remove a farm's copy (it's kept again at the next update).

Not kept yet: LINZ aerial imagery (whether it may be kept offline is for
the spike; paddock boundaries show without it), a separate livestock
register (mobs come from grazings), and farm contacts beyond the emergency
details.

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
  device. A failed critical check shows **Fault on this device** on the
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

## For developers

- `public/sw.js` and `public/sw-rules.js`: the service worker (built files
  kept; farm pages fetched first, saved per server and account; the API is
  never cached by the worker).
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
- `src/lib/offline/device.ts`: platform and address checks, the service
  worker messages, the 14-day rule and one account per device.
- Farm packs: `src/lib/offline/pack-inventory.ts` (the parts and answering
  a read from them), `pack-server.ts` (built from the farm routes' own
  handlers), `pack-redact.ts` (what never goes in), `packs.ts` (keeping
  and reading them on the device), `GET /api/farming/offline-pack` and
  `/api/farming/offline-pack/file`. `api()` asks the pack when Tohyee
  can't be reached (`setOfflineReader`).

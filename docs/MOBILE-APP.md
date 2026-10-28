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
| Farm › Today, Map, Log, Safety, More (the pages) | Open, once opened with a connection |
| Get Tohyee on this device | Opens |
| The books, reports, settings and everything else | Needs a connection; says so |
| Recording field work | Kept on the device and sent later (as each screen adds it) |
| Approvals (releasing equipment, checking or closing actions) | Always need a connection |

The farm information those pages show offline arrives with offline farm
packs (#472 stage 3). Until then, a farm page opened offline shows that
Tohyee can't be reached.

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

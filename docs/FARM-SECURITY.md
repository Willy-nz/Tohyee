# Farm security cameras

Issue #508, decisions 1216-1225; the camera post box, decisions 1226-1233. Farm › More › **Security**.

Tohyee keeps the photos and clips your cameras upload, shows them per farm
(or all farms), and lets you keep incidents and clean up the rest. It was
written for the **Reolink Go PT Plus** (battery, solar, 4G, SD card), but
**no camera was available when it was built**. Everything about the camera
side is from Reolink's help pages and other people's reports, not tested.
See [What's verified and what isn't](#whats-verified-and-what-isnt).

## How it works

1. An owner or admin adds each camera to a farm (Security › Cameras): a
   name, the model, where it is on the farm map, the time zone its clock is
   set to, and notes.
2. **Make upload login** gives that camera its own user name and password.
   Tohyee makes them; the password is shown once and kept only as a scrypt
   hash (like people's passwords). No Reolink account or cloud password is
   ever asked for or stored.
3. You type them into the Reolink app's FTP settings. The camera then sends
   each photo (JPEG) and clip (MP4) by FTPS, either to a **camera post
   box** that Tohyee collects from, or straight to Tohyee's own **camera
   upload receiver** (see [Getting camera uploads to Tohyee](#getting-camera-uploads-to-tohyee)).
4. Each file becomes an **event**: which camera, the camera's time (from the
   file name) and when Tohyee got it, photo or clip, and its size.
5. People with camera access see the events as photos and clips, can keep
   one as an incident with a note, download (with download access) and
   delete (with delete access). An hourly clean-up removes media older than
   the farm's retention, except kept events.

## Getting camera uploads to Tohyee

Decisions 1226-1233. Two ways:

| | **Camera post box** (most farms) | **Direct** |
| --- | --- | --- |
| What | A small rented online server. Cameras send to it; Tohyee collects from it every minute. | Cameras send straight to Tohyee at home. |
| Needs | A server from any provider (about $5-10 a month) | A public address at home, and ports forwarded on the router |
| Opens at home | Nothing. Tohyee only calls out. | The FTP port and 20 passive ports |
| Set up in | Farm › Security › **Post box** (owners and admins) | The server's settings ([below](#direct-uploads-setting-up-the-server)) |

### Why a post box

A 4G camera is out on the internet, not on the farm network. Tohyee's
remote access (the Tohyee address, Cloudflare, Tailscale Funnel) only
carries web pages, and many New Zealand connections share one public
address between customers. So most farms can't take uploads at home. The
post box has its own public address; Tohyee reaches out to it over
HTTPS, so nothing at home is opened.

### Setting one up (Farm › Security › Post box)

The screen walks through it, with why for each step:

1. **Why you need one.**
2. **Rent a small server:** Ubuntu 24.04, 1 CPU, 1 GB memory, about 20 GB
   disk, a public IPv4 address, in Sydney or Auckland if offered. Open TCP
   **21** (cameras log in), **50000-50019** (each file) and **8443**
   (Tohyee collects) in the provider's firewall. Any provider is fine; the
   screen names a few as examples, not recommendations.
3. **Paste the install command** on the server. It's for the same version
   as your Tohyee:
   `curl -fsSL https://raw.githubusercontent.com/Willy-nz/Tohyee/v<version>/postbox/install.sh | sudo bash -s -- --version <version>`.
   It installs Docker (Ubuntu's own packages), finds the server's public
   address (`--address` if it can't), writes `/opt/tohyee-postbox`, starts
   the image `ghcr.io/willy-nz/tohyee-postbox:<version>`, opens the ports
   in ufw if ufw is on, and shows a **pairing code**. Running it again is
   safe.
4. **Paste the pairing code** into Tohyee. It works once, within a day. A
   new one: `sudo docker exec tohyee-postbox node /app/postbox.cjs pairing-code`.
5. **Tohyee tests it** and shows what to type into the Reolink app: the
   post box's address, port 21, FTPS only, and each camera's user name
   (the password is the one shown when the login was made).

Afterwards the screen shows: connected or not, last heard from, last
collected, files waiting, the post box's free disk space, whether the
camera logins on it are up to date, and any problem. **Check now** collects
straight away; **Disconnect** forgets it (audited).

### How it works

- **The post box program** is in this repository (`postbox/main.ts`,
  `src/lib/camera-postbox/box/`). It runs Tohyee's own upload-only FTPS
  receiver, with the same checks as direct uploads (JPEG and MP4 only,
  size limit, ten wrong passwords locks an address out, connection
  limits), and a small HTTPS API for Tohyee.
- **Camera logins come from Tohyee.** There's no user list on the post
  box. Tohyee pushes each active camera's user name and **scrypt hash**
  (never a password) whenever they differ from the post box's, so making,
  replacing or removing a login (or archiving a camera) reaches the post
  box within a minute.
- **Pairing.** The install script shows a code with the post box's
  address, port, certificate fingerprint and a one-time secret. Tohyee
  makes a long random token, sends the post box only its SHA-256 (with the
  one-time secret), and keeps the token encrypted with the server's secret
  key, like other secrets.
- **The certificate.** Without a domain, the post box makes its own
  certificate (RSA 2048, ten years) and Tohyee **pins** its fingerprint
  from the code. Every connection checks it before anything is sent. A
  different certificate stops collection with a red "the post box's
  certificate changed" until it's paired again: if you didn't rebuild the
  post box, someone may be pretending to be it.
- **With a domain:** put a proper certificate's files on the server, set
  `POSTBOX_TLS_CERT`, `POSTBOX_TLS_KEY` and `POSTBOX_PUBLIC_NAME` in
  `/opt/tohyee-postbox/.env` (and mount the files into the container),
  restart, and pair with a new code. Tohyee then checks the certificate
  the normal way, so renewing it doesn't break anything. **Not tried.**
- **Files are locked on arrival.** Each file is sealed to Tohyee's public
  key (X25519, HKDF-SHA256, AES-256-GCM, a new key for every file). The
  post box keeps only the public key, so someone who takes the server
  can't open files waiting there. Not locked: the camera's user name,
  the file name, when it came, its size and SHA-256. The plain file is on
  the post box's disk for a moment while it's checked and sealed.
  Tohyee's key pair is kept across re-pairing, so files already waiting
  still open.
- **Collecting** (every minute; `TOHYEE_CAMERA_POSTBOX=off` stops it):
  Tohyee downloads each file, opens it, checks its size, SHA-256 and that
  it's a JPEG or MP4, and hands it to the same ingest as a direct upload
  (one event per camera and SHA-256, the camera's clock, retention). Only
  then does it tell the post box it has it, and the post box deletes it.
  If Tohyee stops in between, the file is still there; next time ingest
  says "already have it" and it's confirmed. Nothing lost, nothing doubled.
  A file that fails three times is left on the post box and reported.
  A file from a camera archived since it uploaded is dropped, as a direct
  upload would be.
- **Limits on the post box:** 600 requests a minute per address; ten
  wrong tokens or pairing secrets in 15 minutes locks the address out for
  15 minutes; JSON bodies up to 1 MB; at most 500 camera logins; uploads
  refused when under 1 GB is free; files not collected in 30 days are
  deleted (`POSTBOX_MAX_AGE_DAYS`).
- **Permissions:** only owners and admins (camera "set up") see or
  change the post box. Pairing and unpairing are audited.

### The post box's settings

In `/opt/tohyee-postbox/.env` (the install script writes the first three):

| Setting | What it does |
| --- | --- |
| `POSTBOX_PUBLIC_ADDRESS` | The server's public IPv4 address. Needed. |
| `POSTBOX_FTP_PUBLIC_PORT` | The port cameras use, default 21 (the program listens on 2121). |
| `POSTBOX_API_PUBLIC_PORT` | The port Tohyee uses, default 8443. |
| `POSTBOX_PASSIVE_PORTS` | The file transfer ports, default `50000-50019`. |
| `POSTBOX_MAX_FILE_MB` | Biggest file, default 200. |
| `POSTBOX_MIN_FREE_MB` | Refuse uploads below this much free disk, default 1024. |
| `POSTBOX_MAX_AGE_DAYS` | Delete files not collected in this many days, default 30. |
| `POSTBOX_TLS_CERT`, `POSTBOX_TLS_KEY`, `POSTBOX_PUBLIC_NAME` | A proper certificate for a domain name (see above). |

### Building it yourself

The image is published with each release (with `amd64` and `arm64`). To
build it from this repository instead:

```
docker build -f postbox/Dockerfile -t tohyee-postbox .
POSTBOX_PUBLIC_ADDRESS=<public IPv4> docker compose -f postbox/compose.yaml up -d --build
docker exec tohyee-postbox node /app/postbox.cjs pairing-code
```

Or run the install script with `--image <your image>`. Without Docker:
`npm ci && node scripts/build-postbox.mjs` makes `dist/tohyee-postbox.cjs`,
which needs only Node 22 and `openssl` (`POSTBOX_PUBLIC_ADDRESS=… node
dist/tohyee-postbox.cjs serve`).

### What's tested and what isn't

**Tested** (`tests/unit/camera-postbox-protocol.test.ts`,
`tests/unit/camera-postbox-box.test.ts`,
`tests/integration/camera-postbox.test.ts`): the post box program run in
the tests on local ports, with a stand-in camera (basic-ftp) and Tohyee's
own routes and collector: pairing once with the current code; a forged
fingerprint refused with nothing sent; a changed certificate stopping
collection; token and pairing lockouts; rate and size limits; logins
pushed as hashes and kept in step; sealing and opening (wrong key and
changed files refused, nothing readable on the post box's disk);
list, download and delete only after confirming with the right SHA-256;
Tohyee stopping between saving and confirming (no loss, one event);
archived cameras; unpairing; owner-and-admin-only routes and auditing.
CI builds the image, starts it and checks it answers and makes a code.

**Not tested:** a real rented server, the install script on a fresh
Ubuntu (only syntax and shellcheck), any provider's firewall, a Reolink
camera uploading to it over 4G (FTPS, passive ports through Docker), the
domain-certificate option, the `arm64` image, and the published image
(it's first built by the next release).

## Direct uploads: setting up the server

For a server with a public address at home. Camera uploads are **off** until the server's administrator turns them on.
They open a port to the internet, so they're never on by surprise.

| Setting | What it does |
| --- | --- |
| `TOHYEE_CAMERA_FTP_PORT` | The port cameras connect to, e.g. `2121`. Unset or `off`: no receiver. |
| `TOHYEE_CAMERA_FTP_TLS_CERT`, `TOHYEE_CAMERA_FTP_TLS_KEY` | PEM files for FTPS. Needed unless plain FTP is allowed. |
| `TOHYEE_CAMERA_FTP_ALLOW_PLAIN` | `on` allows plain FTP. The camera's password then crosses the network readable: only for a camera on the same network. |
| `TOHYEE_CAMERA_FTP_PASSIVE_PORTS` | Ports for the file transfers, default `50000-50019`. |
| `TOHYEE_CAMERA_FTP_PUBLIC_ADDRESS` | The public IPv4 address cameras reach the server at (for passive mode). Needed behind a router. |
| `TOHYEE_CAMERA_FTP_HOST` | The address to listen on, default `0.0.0.0`. |
| `TOHYEE_CAMERA_MAX_FILE_MB` | Biggest file taken, default 200 MB. |
| `TOHYEE_CAMERA_MEDIA_DIR` | Where photos and clips are kept. Default `camera-media` beside Tohyee (`C:\ProgramData\Tohyee\camera-media` on Windows, `/camera-media` in Docker). |
| `TOHYEE_CAMERA_CLEANUP` | `off` stops the hourly retention clean-up (don't, except on a test copy). |

Admins see "This server isn't taking camera uploads yet", with the reason,
on Security › Cameras until it's set up.

**Docker:** mount a volume at `/camera-media` and publish the FTP port and
the passive ports (`-p 2121:2121 -p 50000-50019:50000-50019`).
**Windows:** allow the same ports through Windows Firewall. The installer
doesn't do this yet.

**Backups:** the media folder is **not** in the nightly database backups.
Back it up separately if you need the photos and clips kept.

### The certificate

FTPS needs a certificate. A certificate for the server's public name (for
example from Let's Encrypt) is safest. Whether a Reolink camera checks the
certificate, or accepts a self-made one, **isn't known**: try it with the
first camera.

## Reaching the server directly from a 4G camera

Most farms should use a [camera post box](#getting-camera-uploads-to-tohyee)
instead. This is for direct uploads.

A 4G camera is on the internet, not your farm network, so it must reach
the server over the internet.

**Remote access (the Tohyee address, your own Cloudflare tunnel, or
Tailscale Funnel) can't carry the camera uploads.** Those pass web pages
(HTTP) to Tohyee. FTP is a different kind of connection, with a second
connection for each file:

- A Cloudflare Tunnel only carries other kinds of connection when the other
  end runs Cloudflare's own program (or with Cloudflare's paid Spectrum).
  A camera can't.
- Tailscale Funnel carries plain connections only on three ports, and FTP
  needs a separate port for each transfer.

What's needed instead (the server's administrator):

1. A public address for the farm's internet connection, and a way to find
   it: a fixed IP from the internet provider, or a dynamic DNS name. Many
   New Zealand providers (especially rural wireless and fibre plans) share
   one public address between customers (CGNAT); then ask the provider for
   your own public IP.
2. On the router, forward the FTP port and the passive ports to the server.
3. Set `TOHYEE_CAMERA_FTP_PUBLIC_ADDRESS` to that public IP.
4. Use FTPS (a certificate), not plain FTP.

Nothing in Tohyee opens the router or changes remote access. A camera on
the same network as the server (a Wi-Fi camera, say) needs none of this.

## Setting up a camera in the Reolink app

From Reolink's help page (not tried with a camera):

1. In the Reolink app, open the camera › **Settings** › **FTP** (on some
   models: Settings › Surveillance › FTP).
2. **FTP server:** the public address, with no `ftp://` and no port.
3. **Port:** the `TOHYEE_CAMERA_FTP_PORT` value.
4. **User name and password:** from Tohyee's **Make upload login**.
5. Turn on **FTPS only** (the app may call it "Don't allow plain
   unencrypted FTP").
6. **Transport mode:** Auto or Pasv. Tohyee only offers passive mode.
7. **Directory:** anything or empty. Tohyee only reads file names.
8. **File type:** video, pictures or both. **Overwrite file: No.**
   Tohyee refuses deleting and renaming, which "Overwrite" needs.
9. Choose what triggers uploads (motion, person, vehicle…) in the app.
10. Save, then use the app's FTP test, and check the event appears in
    Tohyee.

## What Tohyee does with an upload

- **Write-only.** A camera's login can only send files: listing shows
  nothing; reading, deleting, renaming, appending and active mode are
  refused. Folders the camera makes are pretend: nothing is made on disk,
  and file names never become paths.
- **Checked.** A file is taken only if its first bytes say JPEG
  (`FF D8 FF`) or MP4 (an `ftyp` box), whatever its name says. Over the
  size limit, it's thrown away and the camera is told.
- **Once.** The same file from the same camera (by its SHA-256) is one
  event; a resend after a dropped connection doesn't add another.
- **On disk, not in the database.** `<media folder>/<organisation>/camera-<id>/<month>/<sha256>.jpg`
  (or `.mp4`), with a small copy of each photo for the event list.
- **Logins.** Ten wrong passwords from one address in 15 minutes and it's
  refused for 15 minutes. At most 5 connections from one address and 50 in
  all. A login without FTPS is refused unless plain FTP is allowed.
- **The demo farm** takes no uploads and makes no upload logins.

## File names and the camera's clock

What Reolink's file names look like (from people using Reolink's FTP
upload; Reolink doesn't document it):

```
Driveway_01_20180510115044.mp4   device name, channel, YYYYMMDDHHMMSS, extension
K3TA_00_20220307125142.mp4
K3TA_00_20220307125217.jpg
NVR_00_20251002011659.mp4        an NVR's channel
```

- The date and time is the **camera's clock**, with no time zone. Tohyee
  reads it in the camera's time zone (set per camera; New Zealand by
  default), daylight saving included.
- Both times are kept: the camera's, and when Tohyee got the file.
  - Camera time more than 10 minutes ahead of Tohyee's: the clock is wrong,
    so the event is placed at when Tohyee got it, with "Check time".
  - Arrived more than 6 hours after the camera's time: kept at the camera's
    time, with "the camera may have been offline, or its clock is behind".
  - No date and time in the name: when Tohyee got it.
- **What was detected** (person, vehicle, animal) isn't in the file name,
  so every event says "Motion or unknown". Tohyee doesn't guess.
- A name that doesn't fit still arrives; only the time is missing.

## The screens

- **Events:** photos and clips as tiles (not a table), newest first, 60 at
  a time. Filter by camera, photos or clips, dates and kept. Each says
  **Photo only** or **Clip saved**. A photo never means a clip exists.
- **Cameras' last uploads** at the top: "No uploads from Runoff gate since
  Tuesday" when a camera's been quiet longer than its own setting (24 hours
  by default). Tohyee can't ask a sleeping camera how it is, so this is all
  it knows: a quiet camera may only mean nothing moved.
- **All farms:** one tick shows every farm you work on.
- **Cameras:** add, change, archive (removes its login; events stay), and
  make or replace upload logins. Place a camera on the farm map by tapping,
  or where you're standing.
- **Settings:** how many days media is kept on this farm (30 by default).
- **People and roles › Security cameras:** who besides owners and admins
  sees camera events.

## Who can do what

| | See | Download | Delete, stop keeping | Set up cameras, logins, retention, access |
| --- | --- | --- | --- | --- |
| Owner, admin | Yes | Yes | Yes | Yes |
| Given "See events" | Yes | | | |
| Given "See and download" | Yes | Yes | | |
| Given "See, download and delete" | Yes | Yes | Yes | |
| Everyone else | | | | |

- Only farm staff, viewers and bookkeepers can be given access. Sales and
  report-only roles can't.
- Always only on the farms the person works on (People and roles).
- Anyone who can see an event may keep it (an incident) with a note.
- Checked on the server for every route and every photo or clip address.
  A photo's address opened by someone without access is refused.
- **Audited:** giving and removing access, cameras added, changed and
  archived, upload logins made, replaced and removed, retention changes,
  keeping, un-keeping, every download, every delete, each clip's first play
  (where it starts, not every seek), and each clean-up (how many, per farm).
  Looking at photos isn't audited.

## Keeping, deleting and retention

- **Keep (incident):** keeps an event out of the clean-up, with a note.
- **Delete:** asks first, removes the event and its file for good, and is
  audited. A kept event must be un-kept first.
- **Clean-up:** every hour, events that arrived longer ago than the farm's
  retention and aren't kept are removed, then their files. It goes by when
  Tohyee got the file, so a wrong camera clock can't make media go early.

## Staff and visitors' privacy

Cameras record people. The Security page always says so and asks you to put
up signs and tell staff; its (i) has general information about the Privacy
Act 2020 and points to the Privacy Commissioner's CCTV guidance. It isn't
legal advice.

Tohyee has no staff tracking, face recognition or following anyone, and
won't add them.

## Not built

- **Fetching a clip from the camera's SD card on request.** Not available.
  Battery 4G Reolink cameras have no RTSP, ONVIF or HTTP API. Neolink and
  PyNeolink use Reolink's own protocol, are experimental, and nothing shows
  they list or download SD recordings over a mobile connection. There's no
  button for it; `src/lib/security-cameras/camera-fetch.ts` is where it
  would go once a library is proven with a real camera. Use the Reolink app
  to look at the card.
- **AI tags or summaries.** Not built. Tohyee itself calls no AI: your own
  AI app reads through Tohyee's AI tools, as it does for paddock photos
  (#503). Camera photos would need new AI tools that follow camera access
  and are audited, so it wasn't a small addition. Any later version must
  say which tags came from the camera and which from an AI.
- **Live view.** Use the Reolink app.
- **Backing up the media folder** with the nightly backups.
- **Choosing which detections upload** in Tohyee. That's in the Reolink app.

## What's verified and what isn't

**Tested in Tohyee's tests** (`tests/integration/farm-security-cameras.test.ts`,
`tests/unit/security-camera-*.test.ts`) with a stand-in FTP client
(basic-ftp), not a camera:

- FTPS uploads of photos and clips; plain FTP refused unless allowed
- Duplicates kept once; HTML pretending to be a JPEG refused; over-size
  files refused; nothing left in the incoming folder
- Wrong passwords refused; archived cameras and removed logins can't upload
- File name and time zone reading; clock checks; camera health text
- Permissions on every route and media address, farm by farm and level by
  level; another organisation gets nothing
- Clips played in byte ranges; downloads and deletes audited
- Keeping, deleting and the retention clean-up
- The demo farm's cameras

**Not verified (no camera):**

- That a Go PT Plus (hardware SD96 / SD15V11 / SD15V14 per Reolink's list)
  has FTP on your firmware, and which firmware
- Its exact file names and folders, and whether they change with firmware
- That it accepts Tohyee's FTPS (TLS versions, certificate checks), passive
  mode only, a user name of up to 43 characters (`organisation.random`) and
  a 20-character password
- Whether it can send video and photos for the same event, and what it does
  after being offline (does it send what it missed?)
- Upload delay, battery use and mobile data
- Carrier, APN and SIM: not chosen; test coverage on the farm first

The issue's hardware acceptance list (#508) stays open until a camera is
tried.

## Sources

Checked 2 November 2026.

- Reolink, [How to set up FTP for Reolink products](https://support.reolink.com/hc/en-us/articles/360020081034-How-to-set-up-FTP-for-Reolink-Products):
  the settings (server, port, user name, FTPS only, transport mode
  Auto/Port/Pasv, directory, "Generate subfolder by", file type, overwrite,
  max file size 10-1024 MB, post-record time). No file name pattern; "does
  not support SFTP".
- Reolink, [Which cameras/NVRs support FTP uploading](https://support.reolink.com/hc/en-us/articles/900000625446-Which-Cameras-NVRs-Support-FTP-Uploading):
  Go PT Plus listed by hardware version (SD96, SD15V11, SD15V14); no
  firmware notes.
- Reolink, [Does Reolink Go Ranger PT support FTP](https://support.reolink.com/hc/en-us/articles/26152220058777-Does-Reolink-Go-Ranger-PT-Support-FTP-/):
  "Don't allow plain unencrypted FTP" needs an FTPS server.
- Reolink community, [Add ability to choose file naming scheme](https://community.reolink.com/topic/398/add-ability-to-choose-file-naming-scheme):
  `Driveway_01_20180510115044.mp4`.
- Reolink community, [post 38953](https://community.reolink.com/post/38953):
  `NVR_00_20251002011659.mp4` (an NVR, 2025).
- [GsDublin/camerawatch](https://www.github.com/GsDublin/camerawatch):
  `K3TA_00_20220307125142.mp4`, `K3TA_00_20220307125217.jpg`.

## Why Tohyee has its own FTP receiver

The Node FTP servers checked (2 November 2026): **ftp-srv** (MIT) had its
last release in October 2023 and depends on old packages (`ip` 1.x,
`uuid` 3, `bunyan`); **@electerm/ftp-srv** and **ftp-srv-esm** are recent
forks with one maintainer each. A camera needs only a dozen commands, and
an upload-only server is safer with less in it, so Tohyee has its own
(`src/lib/security-cameras/ftp-receiver.ts`, Node's own `net` and `tls`, no
new dependency). It runs inside Tohyee, like the server settings address,
so it works the same in Docker, on Windows and on Linux. `basic-ftp` (MIT)
is used only in the tests.

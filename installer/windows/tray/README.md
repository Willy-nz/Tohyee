# Tohyee server app (Windows)

The icon by the clock that shows Tohyee is running, and the window for the
server settings. It talks to Tohyee's server settings address on this
computer only (`http://127.0.0.1:<admin port>`, see
`src/lib/server-admin/local.ts`), signed in as a server admin with two-step
sign-in. There's no browser involved.

- .NET Framework 4.8 and Windows Forms: Windows 10 and 11 include the
  framework, so nothing extra is installed.
- The installer builds it (`dotnet build TohyeeTray.csproj -c Release`, see
  `../build.ps1`), puts it in `<install dir>\tray`, adds "Tohyee server
  settings" to the Start menu and starts it when you sign in to Windows (the
  app's menu turns that off and on).
- It reads the ports from `%ProgramData%\Tohyee\tray.ini`, which the
  installer writes (defaults: 3000 for the books, 3001 for server settings).
- Restarting the services asks Windows for permission (UAC); the app itself
  runs as you. The tray menu's "Back up now" (and the Start menu's "Back up
  Tohyee", `TohyeeTray.exe --back-up`) opens the Backups page, after signing
  in, and runs the encrypted backups straight away.
- `TohyeeTray.exe --self-test <file>` checks it can reach Tohyee (the
  installer's CI test runs it, signed in with a test login).

## The window

A dark window in the style of a media server's app (`src/Theme.cs`): a
sidebar with the logo and the pages in groups (Home; People: Organisations,
Users; Keep safe: Backups, Updates; Connect: Remote access, Email,
Analytics; Server: Stats), a badge on a page when something there needs
attention, and each page a column of cards. Signed in as, Sign out and Open
Tohyee (the books) are at the bottom.

- **Home** (it opens here; redesigned from the mock-up Jess approved on 9 Oct
  2026): the title with the server's state beside it (running, version, how
  long it's been up when Windows lets the app see the service's process) and
  Open Tohyee; a **Needs attention** card, only when something does (the
  server isn't running, no backup key or no saved copy of it, a failed backup,
  nightly backups off, an update out or an organisation not upgraded, an
  organisation that couldn't be set up, remote access on but not connected),
  each with a button to its page; quick looks at the last backup, remote
  access, the organisations and email (click one to go to its page; grey bars
  until they load; two to a row in a narrow window); and the latest news as a
  short list, the conference with it.
- **Organisations**: as before, plus **Hand over…** for when an
  organisation's owners can't add a new owner (decision 485): a new owner
  after 7 days, which its owners and admins are told about and can cancel.
- **Email**: as before.
- **Users**: with two-step sign-in on, adding someone (or resetting their
  two-step sign-in) gives a one-time setup link to send them, emailed too
  when the server can send email; they choose their own password with it
  (decision 484). "Send setup link" makes a new one.
- **Stats**: CPU, memory, requests, people using Tohyee, disk space and
  database sizes, with graphs of the last 1, 6 or 24 hours (decision 332).
- **Updates**: what the server's daily check found, the last update and any
  blocked organisations; **Install** backs everything up, downloads and
  checks TohyeeSetup, and runs it silently (decisions 328-331). The tray
  icon shows a notification when an update is out, and after installing
  (`--after-update`) says how it went.
- **Backups**: nightly backups, the backup key, each organisation's last
  backup, and the backup files (restore as a copy). Until a saved copy of the
  key has been checked, the window opens on Backups with a reminder.
- **Analytics**: each organisation's CSV folder on this computer, whether
  Tohyee can read it, and Browse and Save for each organisation. Blank clears
  the folder. Tohyee only reads files there; it never changes or deletes them.
- **Remote access**: three ways to use Tohyee from anywhere, one at a time: a
  Tohyee address (recommended for most), your own domain (Cloudflare), and
  Tailscale Funnel. See below.

The logo is `assets/logo.svg` at the repository root. Windows Forms can't draw
SVG, so `assets/render-logo.py` renders it to `assets/tohyee.ico` (the app and
window icon) and two PNGs, all built into the exe as resources. The tray icon
is the logo with a status dot drawn over it: green when running, amber while
starting, red when stopped or unwell.

Sizes are in pixels at 100% and multiplied by the screen's scale
(`Theme.S`), since the app is DPI-aware.

## News

`src/NewsFeed.cs` shows Tohyee's GitHub releases
(`api.github.com/repos/Willy-nz/Tohyee/releases`) plus announcements from
`website/news.json`, which GitHub Pages publishes at
`https://willy-nz.github.io/Tohyee/news.json` (falling back to the raw file on
GitHub). Edit that file on main to post news without a release: items have a
`date` (YYYY-MM-DD), `title`, `body`, and optionally a `link` (https only) and
`"kind": "conference"` for the conference line. The app fetches at most every
four hours (GitHub allows 60 unauthenticated requests an hour), caches in
`%LocalAppData%\Tohyee\news-cache.json`, and says "Couldn't load news" when
it's offline with nothing cached.

## Remote access

`src/RemoteAccessPage.cs`. Three cards, in this order; only one way is on at
a time. Turning one on while another is on asks first, then turns the other
off (the server stops its Cloudflare connector; for Tailscale the app runs
`tailscale funnel --https=443 off`). Each way, once on, shows the address big
with a QR code (`src/QrCode.cs`, written for Tohyee, no packages), Copy
address, Open and Turn off, and needs two-step sign-in in force: the app
checks first and the server refuses otherwise, exactly as before. Every
network and program call runs off the UI thread with a time limit.

### 1. Tohyee address (recommended for most)

One click, no sign-up. **Get a Tohyee address** asks the server
(`POST /api/admin/remote-access/tohyee-address`), which asks the Tohyee
address service (`src/lib/remote/address-service.ts`) for this server's
address and a Cloudflare tunnel token, stores the token and the release key
encrypted, and runs Cloudflare's connector with it. The server makes the call
(not this app), so the command-line tool on Linux and Docker can do it too:
`remote-access address --on`. The service is `https://relay.tohyee.example`
unless `TOHYEE_ADDRESS_SERVICE_URL` is set in `tohyee.env` (the installer
passes it to the service). Until the service is running the card says "The
Tohyee address service isn't available yet". Turn off keeps the address for
next time; **Give this address back** releases it. The note says: "Run by the
Tohyee project. Your books still stay on this computer; the address service
never sees them."

### 2. Your own domain (Cloudflare)

Free for businesses; needs a domain on Cloudflare. `src/Cloudflare.cs` drives
the `cloudflared.exe` the installer ships (`<install dir>\cloudflared`), with
`HOME` set to `%LocalAppData%\Tohyee\cloudflare` so its files stay apart from
any other cloudflared set-up. **Connect to Cloudflare**:

1. `cloudflared tunnel login`: cloudflared opens
   `https://dash.cloudflare.com/argotunnel?…` in the browser (the app opens it
   only if cloudflared says it couldn't; **Open the sign-in page again** and
   **Cancel** are there while waiting). You sign in, click the domain and press
   Authorise; cloudflared saves `%LocalAppData%\Tohyee\cloudflare\.cloudflared\cert.pem`,
   and the app carries on when the command finishes with that file there (up
   to about 10 minutes).
2. Asks for the name (e.g. `books`) and domain (filled in from Cloudflare when
   it can: the zone id in `cert.pem`, looked up with
   `GET https://api.cloudflare.com/client/v4/zones/<id>`) and previews
   `https://books.example.nz`.
3. `cloudflared tunnel create --output json tohyee-books` (reuses the tunnel if
   one of that name exists), `cloudflared tunnel route dns <id> books.example.nz`
   (never overwrites an existing record; if Cloudflare added the name inside a
   different domain, it says so), and `cloudflared tunnel token <id>`.
4. Saves `{ method: "cloudflare", enabled: true, tunnelToken, publicUrl }` on
   the server, which runs `cloudflared tunnel run --url http://127.0.0.1:<port>`
   with the token. A tunnel made this way has no routes of its own, so `--url`
   is what sends its address to Tohyee (for dashboard-made tunnels Cloudflare's
   own routes replace it). Then deletes `cert.pem` and the tunnel credentials
   file: Tohyee only keeps the token (encrypted, on the server).

**Paste a tunnel token instead** keeps the old way: a tunnel made in
Cloudflare's dashboard, its token and public address.

### 3. Tailscale Funnel

The simplest set-up, but Tailscale's free plan is for non-commercial use only;
businesses need a paid Tailscale plan (from US$8 per user a month,
https://tailscale.com/pricing). `src/Tailscale.cs` drives Tailscale's own
command-line tool; Tohyee never sees or stores the Tailscale login.
**Set up Tailscale Funnel**:

1. Checks the server has two-step sign-in in force (the server enforces it
   again in step 4).
2. If Tailscale isn't installed: reads `https://pkgs.tailscale.com/stable/?mode=json`,
   downloads the MSI for this computer (amd64, arm64 or x86), checks it
   against the `.sha256` beside it, and runs
   `msiexec /i <msi> /qn /norestart TS_UNATTENDEDMODE=always TS_NOLAUNCH=yes`
   with UAC. Unattended mode keeps Tailscale connected when nobody is signed
   in to Windows, like Tohyee's own service.
3. If it isn't signed in: `tailscale up --unattended` (or `tailscale login
   --unattended` if Tailscale was set up with other options), opening the
   sign-in page it prints (only `*.tailscale.com` pages are opened).
4. Saves `{ method: "tailscale", enabled: true, publicUrl }` on the server
   (`PUT /api/admin/remote-access`), from `Self.DNSName` in
   `tailscale status --json`, so emailed links use that address.
5. `tailscale set --unattended`, then `tailscale funnel --bg --yes <port>`
   (the books' port from `tray.ini`; a port alone means `http://127.0.0.1:<port>`),
   opening the page Tailscale prints the first time to approve HTTPS/Funnel.
   `--bg` keeps it on across restarts.
6. Reads `tailscale funnel status --json` to check Funnel is on for that port.

**Turn off** runs `tailscale funnel --https=443 off` (or `tailscale funnel
reset` if that fails) and clears the address on the server.

Tailscale Funnel sends requests to `127.0.0.1:<port>` keeping the `Host`
header and adding `X-Forwarded-Host`, `X-Forwarded-Proto: https` and
`X-Forwarded-For` (Tailscale's `ipn/ipnlocal/serve.go`), so the server's
same-origin check and secure cookies work as they do behind Cloudflare
(`tests/integration/remote-access.test.ts`). Server settings can't be reached
through Funnel or a tunnel: they connect to the main port, not the local-only
admin one.

## Checking it on Linux (Mono)

Compile:

```sh
mcs -sdk:4.5 -langversion:7 -target:winexe -out:/tmp/TohyeeTray.exe \
  -win32icon:assets/tohyee.ico \
  -resource:assets/tohyee.ico,Tohyee.Tray.tohyee.ico \
  -resource:assets/logo-32.png,Tohyee.Tray.logo-32.png \
  -resource:assets/logo-128.png,Tohyee.Tray.logo-128.png \
  -r:System.Windows.Forms.dll -r:System.Drawing.dll -r:System.Net.Http.dll \
  -r:System.ServiceProcess.dll -r:System.Web.Extensions.dll -r:System.Core.dll src/*.cs
```

Pictures of every page with sample data (no server, no network), including
each Remote access state (`4-phone-1-choose` … `4-phone-7-tailscale-on`):

```sh
xvfb-run -a -s "-screen 0 1400x1000x24" mono /tmp/TohyeeTray.exe --demo-screenshots /tmp/tohyee-app/
TOHYEE_UI_SCALE=1.5 xvfb-run -a -s "-screen 0 1920x1200x24" mono /tmp/TohyeeTray.exe --demo-screenshots /tmp/tohyee-app-150/
```

Mono draws with DejaVu Sans instead of Segoe UI (wider), its own scroll bars,
check boxes and drop-downs, and a thin line after the last list column; the
layout is the same.

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
sidebar with the logo and the pages, and each page a column of cards.

- **Home** (it opens here): whether the server is running (version, and how
  long it's been up when Windows lets the app see the service's process),
  quick looks at phone access, the last backup and the organisations (click
  one to go to its page), the latest news and the conference card.
- **Organisations, Users, Email, Updates**: as before.
- **Backups**: nightly backups, the backup key, each organisation's last
  backup, and the backup files (restore as a copy). Until a saved copy of the
  key has been checked, the window opens on Backups with a reminder.
- **Phone access**: Tailscale Funnel (the easy way) and Cloudflare Tunnel
  (the advanced way, your own domain). See below.

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
`"kind": "conference"` for the conference card. The app fetches at most every
four hours (GitHub allows 60 unauthenticated requests an hour), caches in
`%LocalAppData%\Tohyee\news-cache.json`, and says "Couldn't load news" when
it's offline with nothing cached.

## Phone access with Tailscale Funnel

`src/Tailscale.cs` drives Tailscale's own command-line tool; Tohyee never sees
or stores the Tailscale login. **Set up phone access**:

1. Checks the server has two-step sign-in in force (the same rule as the
   Cloudflare Tunnel; the server enforces it again in step 4).
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
6. Reads `tailscale funnel status --json` to check Funnel is on for that port
   and shows the address, a QR code (`src/QrCode.cs`, written for Tohyee, no
   packages) and Copy address.

**Turn off phone access** runs `tailscale funnel --https=443 off` (or
`tailscale funnel reset` if that fails) and clears the address on the server.
Every Tailscale call runs off the UI thread with a time limit.

Tailscale Funnel sends requests to `127.0.0.1:<port>` keeping the `Host`
header and adding `X-Forwarded-Host`, `X-Forwarded-Proto: https` and
`X-Forwarded-For` (Tailscale's `ipn/ipnlocal/serve.go`), so the server's
same-origin check and secure cookies work as they do behind Cloudflare
(`tests/integration/remote-access.test.ts`). Server settings can't be reached
through Funnel: it connects to the main port, not the local-only admin one.

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

Pictures of every page with sample data (no server, no network):

```sh
xvfb-run -a -s "-screen 0 1400x1000x24" mono /tmp/TohyeeTray.exe --demo-screenshots /tmp/tohyee-app/
TOHYEE_UI_SCALE=1.5 xvfb-run -a -s "-screen 0 1920x1200x24" mono /tmp/TohyeeTray.exe --demo-screenshots /tmp/tohyee-app-150/
```

Mono draws with DejaVu Sans instead of Segoe UI (wider), its own scroll bars,
check boxes and drop-downs, and a thin line after the last list column; the
layout is the same.

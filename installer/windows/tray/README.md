# Tohyee server app (Windows)

The icon by the clock that shows Tohyee is running, and the window for the
server settings: organisations, users, remote access, email and updates. It
talks to Tohyee's server settings address on this computer only
(`http://127.0.0.1:<admin port>`, see `src/lib/server-admin/local.ts`), signed
in as a server admin with two-step sign-in. There's no browser involved.

- .NET Framework 4.8 and Windows Forms: Windows 10 and 11 include the
  framework, so nothing extra is installed.
- The installer builds it (`dotnet build TohyeeTray.csproj -c Release`, see
  `../build.ps1`), puts it in `<install dir>\tray`, adds "Tohyee server
  settings" to the Start menu and starts it when you sign in to Windows (the
  app's menu turns that off and on).
- It reads the ports from `%ProgramData%\Tohyee\tray.ini`, which the
  installer writes (defaults: 3000 for the books, 3001 for server settings).
- Restarting the services and the tray menu's "Back up now" (the older,
  unencrypted whole-server copy to Documents) ask Windows for permission
  (UAC); the app itself runs as you. The **Backups** tab is the built-in
  nightly backups: settings, status, back up now, restore as a copy, and the
  backup key (show it with your password, check your saved copy). Until a
  saved copy has been checked, the window opens on Backups with a reminder.
- `TohyeeTray.exe --self-test <file>` checks it can reach Tohyee (the
  installer's CI test runs it, signed in with a test login).

Checking it compiles on Linux (Mono):

```sh
mcs -sdk:4.8 -langversion:7 -target:winexe -out:/tmp/TohyeeTray.exe \
  -r:System.Windows.Forms.dll -r:System.Drawing.dll -r:System.Net.Http.dll \
  -r:System.ServiceProcess.dll -r:System.Web.Extensions.dll -r:System.Core.dll src/*.cs
```

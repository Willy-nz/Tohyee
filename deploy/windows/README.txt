TOHYEE ON WINDOWS WITH DOCKER DESKTOP
=====================================

Most people should use TohyeeSetup-<version>.exe from the release instead:
it needs no Docker. This zip is for people who already use Docker Desktop.

Tohyee runs inside Docker Desktop, together with its own PostgreSQL
database. Once installed it starts by itself whenever the computer restarts
and you sign in to Windows.


1. INSTALL DOCKER DESKTOP (once)
--------------------------------
- Download it from https://www.docker.com/products/docker-desktop/ and
  install it with the default options (it uses WSL 2; let it install that if
  it asks, then restart the computer).
- Start Docker Desktop and wait until it says it's running.
- In Docker Desktop, open Settings > General and make sure
  "Start Docker Desktop when you sign in to your computer" is ticked.
  This is what brings Tohyee back after a restart.


2. INSTALL TOHYEE
-----------------
- Extract this zip somewhere permanent, e.g. C:\Tohyee
  (not your Downloads folder, and not inside OneDrive).
- Double-click Install-Tohyee.cmd.
  The first time, it downloads Tohyee and PostgreSQL (a few minutes),
  starts them, and opens http://localhost:3000/setup in your browser.
- On the setup page, paste the setup token it shows (it's also copied to
  the clipboard) and create the first server admin login.

Then open Tohyee any time at http://localhost:3000


WHERE THINGS ARE KEPT
---------------------
- Your data: in Docker Desktop, in a volume called tohyee_postgres_data.
  Uninstalling Docker Desktop or deleting that volume deletes your data.
- Backups: in the backups folder next to these files (e.g. C:\Tohyee\backups),
  outside Docker Desktop, so they survive if Docker Desktop is reset or
  removed. See BACKUPS below.
- Passwords: %LOCALAPPDATA%\Tohyee\tohyee.env
  It holds the database password and the backup key (TOHYEE_SECRET_KEY).
  Keep it private, and keep a copy somewhere safe that ISN'T the backup
  folder (a password manager, say). Don't delete it: a new one won't open
  your existing data or your backups.


BACKUPS
-------
Tohyee backs up every night (2am by default): each organisation, and its own
database of users and settings, into the backup folder, one sub-folder per
organisation. The files are encrypted, checked after they're written, and
the last 14 daily and 12 monthly backups are kept.

To back up now (before an update, say), double-click Backup-Tohyee.cmd. It
makes the same encrypted backup, straight away.

The backup folder is the backups folder next to these files, unless you
choose another: set TOHYEE_BACKUP_FOLDER in tohyee.env (e.g.
TOHYEE_BACKUP_FOLDER=C:\Users\you\OneDrive\Tohyee backups) and run
Install-Tohyee.cmd again. A cloud-synced folder (OneDrive) gets copies off
this computer by itself; otherwise copy the folder to a USB drive or cloud
storage now and then. Don't delete this folder when you update Tohyee.

THE BACKUP KEY: backups are encrypted with this server's TOHYEE_SECRET_KEY
(in tohyee.env). Without it they can't be opened, so if this computer is
lost, so are your backups unless you kept a copy of the key. To see it and
save it (in a password manager, not with the backups), open a Command
Prompt in this folder and run:

  docker compose --env-file "%LOCALAPPDATA%\Tohyee\tohyee.env" exec tohyee node tohyee-admin.cjs backups key show

then check your saved copy (paste it when asked):

  docker compose --env-file "%LOCALAPPDATA%\Tohyee\tohyee.env" exec tohyee node tohyee-admin.cjs backups key check

Until someone has done that, Tohyee shows server admins a reminder.

RESTORING: restoring makes a copy of an organisation (with the same people)
next to the current one, so nothing is overwritten. In a Command Prompt in
this folder:

  docker compose --env-file "%LOCALAPPDATA%\Tohyee\tohyee.env" exec tohyee node tohyee-admin.cjs backups list
  docker compose --env-file "%LOCALAPPDATA%\Tohyee\tohyee.env" exec tohyee node tohyee-admin.cjs backups restore --file /backups/<organisation>/<file>.tohyee-backup

Inside Docker the backup folder is called /backups, so a file at
C:\Tohyee\backups\green-island\x.tohyee-backup is
/backups/green-island/x.tohyee-backup. To restore a backup kept elsewhere,
copy it into the backup folder first. "backups check --file ..." proves a
backup opens with this computer's key. On a new computer (a new key), add
--other-key to the restore and paste the old computer's key when asked.
Restoring the server's own database (the _server sub-folder) is a job for a
database administrator.

Before this version the nightly backups went to a Docker volume called
tohyee_backups instead. It's still there: once new backups show up in the
backup folder, you can save the old ones from Docker Desktop (Volumes >
tohyee_backups) if you want them, then delete the volume.


UPDATING TO A NEW RELEASE
-------------------------
Take a backup first (Backup-Tohyee.cmd). Download the new release's
Windows zip, extract it over the old folder (so the backups folder stays
where it is), and double-click its Install-Tohyee.cmd. Your data, backups
and passwords are kept.


USING TOHYEE FROM OTHER COMPUTERS ON YOUR NETWORK
-------------------------------------------------
By default only this computer can open Tohyee. To allow others:
- Open %LOCALAPPDATA%\Tohyee\tohyee.env in Notepad and change
  TOHYEE_LISTEN=127.0.0.1 to TOHYEE_LISTEN=0.0.0.0
- Run Install-Tohyee.cmd again. Allow it through Windows Firewall if asked.
- Other computers use http://<this computer's name>:3000
Don't open it to the internet without HTTPS in front of it.


STOPPING OR REMOVING TOHYEE
---------------------------
- Stop it: in Docker Desktop, Containers > tohyee > Stop.
  It stays stopped until you press Start (even after a restart).
- Remove it (keeps your data): in Docker Desktop, delete the tohyee
  container group. Your data volume stays until you delete it under Volumes.


GOOD TO KNOW
------------
- Tohyee starts after you sign in to Windows, not before.
- If the computer sleeps, Tohyee isn't reachable until it wakes.
- Locked out of the admin login? See "Locked out?" in the README on GitHub.

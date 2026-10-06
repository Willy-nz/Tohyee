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
- Passwords: %LOCALAPPDATA%\Tohyee\tohyee.env
  It holds the database password. Keep it private, and keep a copy with
  your backups. Don't delete it: a new one won't open your existing data.


BACKUPS
-------
Every night (2am) Tohyee backs up each organisation, encrypted with the
backup key, and checks each file after writing it.
- By default they go to a Docker volume called tohyee_backups. That's
  inside Docker Desktop, on the same disk as your data: uninstalling Docker
  Desktop deletes both. To keep them in a folder you can see (and copy off
  this computer, e.g. OneDrive), add a line such as
    TOHYEE_BACKUP_FOLDER=C:\Users\you\OneDrive\Tohyee backups
  to %LOCALAPPDATA%\Tohyee\tohyee.env and run Install-Tohyee.cmd again.
- Save a copy of the backup key somewhere safe that isn't the backup folder
  (a password manager). Without it the backups can't be opened. To see it:
    docker exec -it tohyee-tohyee-1 node tohyee-admin.cjs backups key show
  (in PowerShell or Command Prompt), then check your saved copy with
    docker exec -it tohyee-tohyee-1 node tohyee-admin.cjs backups key check
- To back up straight away:
    docker exec -it tohyee-tohyee-1 node tohyee-admin.cjs backups run
- To restore, as a copy that never overwrites the current books:
    docker exec -it tohyee-tohyee-1 node tohyee-admin.cjs backups list
    docker exec -it tohyee-tohyee-1 node tohyee-admin.cjs backups restore --file <a File shown by the list>
  ("help" lists the rest.)

Backup-Tohyee.cmd is different: it saves one file of everything (every
organisation, the logins and their sessions) to
Documents\Tohyee backups\tohyee-<date>.sql, and that file is NOT
encrypted. Anyone who can open it can read all your books. Keep it off
cloud-synced folders (Windows often syncs Documents to OneDrive), and
delete it once you've copied it somewhere private. Prefer the encrypted
backups above.


UPDATING TO A NEW RELEASE
-------------------------
Download the new release's Windows zip, extract it (it can replace the old
folder), and double-click its Install-Tohyee.cmd. Your data and passwords
are kept. Take a backup first.


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

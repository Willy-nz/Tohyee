# Backups and recovery: the design

Issue #389; decisions 730-739. This is the design for getting a Tohyee
server back after the computer, its disk or its Windows profile is lost. It
builds on what was already there (nightly encrypted backups, 14 daily and 12
monthly kept, a check after each backup, the backup key and restore as a
copy: see "Backups and restore" in `ARCHITECTURE.md`) rather than adding a
second backup system. It's built in three pull requests:

| Part | What | State |
| --- | --- | --- |
| 1 | Managed backups and an evidence-based status panel | Built (this PR) |
| 2 | A backup recovery key of its own, and the recovery kit | Designed here, next PR |
| 3 | The restore wizard for a replacement computer | Designed here, after part 2 |

Only standard, reviewed building blocks from Node's `crypto` are used:
AES-256-GCM, HKDF-SHA256, SHA-256 and scrypt. Nothing is invented.

## The keys

| Key | What it is | Where it lives | What it protects |
| --- | --- | --- | --- |
| Live secret key | `TOHYEE_SECRET_KEY` (48 random characters from the installer) | `tohyee.env` (Windows: `%ProgramData%\Tohyee`, admin and service only), or the server's environment | Stored secrets: every `*_ciphertext` column (bank feed tokens, mailbox tokens, IRD numbers, two-step sign-in keys, email passwords, private mail copy keys), and the recovery keys below |
| Backup recovery key, version n (part 2) | 32 random bytes made by the server; numbered 1, 2, 3 | The core database (`server_settings`, key `backup_recovery_keys`), encrypted with the live key | Every backup made while it's the current version |
| Older backup key (format 1) | HKDF-SHA256 of `TOHYEE_SECRET_KEY` ("tohyee backups v1") | Nowhere: worked out from the live key | Backups made before part 2 |
| File key | HKDF-SHA256(recovery key, a random 32-byte salt in the file) | Worked out when needed | One backup file |

Why a separate recovery key: today the only way to open a backup on another
computer is the whole `TOHYEE_SECRET_KEY`, the same key that protects every
stored secret on the running server. Keeping them apart means:

- the recovery kit holds one thing, made for one job, and never the
  environment file, the PostgreSQL passwords or the setup token;
- the recovery key can be replaced (a kit was lost or seen) without touching
  any stored secret, and the live key can later be replaced without making
  existing kits useless;
- backups stay unattended: the server holds the recovery key (encrypted with
  the live key), so nobody types a passphrase and nothing like OneDrive
  Personal Vault has to stay unlocked.

What the separation can't do: the server can open its own backups, so
someone who controls the running server can too. That's true of any backup
made without a person present. Windows-protected storage (DPAPI) was
considered for the live key and not used: a running service can always read
its own secrets, and DPAPI-protected values don't move to a new computer, so
it would add a second recovery problem without stopping that threat. The
environment file keeps its current permissions (decision 486).

## Backup file format 2 (part 2)

```
TOHYEE-BACKUP 2\n
{header as JSON}\n
12-byte IV | AES-256-GCM ciphertext of the pg_dump -Fc output | 16-byte tag
```

The header says what's inside without any key (organisation, database,
schema version, Tohyee version, when) plus:

- `recoveryKey: { version, id }`: which recovery key opens it (the id is a
  fingerprint, SHA-256 of a label and the key, never the key);
- `salt`: 32 random bytes; the file key is HKDF(recovery key, salt,
  "tohyee backup v2 data");
- `liveKey: { id, iv, tag, data }`: the live key the database's stored
  secrets were encrypted with, itself encrypted (AES-256-GCM) with
  HKDF(recovery key, salt, "tohyee backup v2 live key").

The whole header is the GCM additional data, so nothing in it can be changed
without the file failing its check. Format 1 files (`format.ts` before this
work) stay readable for good: the reader keeps both formats, and a
format 1 file is opened with the server's own `TOHYEE_SECRET_KEY` or the one
it was made with.

## Encrypted fields inside a restored database (part 3)

Decrypting a backup isn't enough: the restored database is full of values
encrypted with the old server's live key. A new computer has its own
`TOHYEE_SECRET_KEY` (the installer makes one), so those values can't be
read there. The restore therefore re-encrypts them before anyone can use
the copy:

1. The old live key comes from the backup itself (format 2: `liveKey` in
   the header, opened with the recovery key) or is the key given for a
   format 1 file (which is that server's `TOHYEE_SECRET_KEY`).
2. In the new database, every text column whose name ends in `_ciphertext`
   (the naming rule every stored secret follows) is read. Each value that
   opens with this server's key is left alone; each that opens with the old
   key is re-encrypted with this server's key; anything else is counted as
   unreadable. It's one transaction, before the copy is made ready.
3. The result is shown: how many values were re-encrypted, and which kinds
   of connection couldn't be read and need connecting again. The old live
   key isn't kept on the new server.

Private mail copies (decisions 612, 613) are covered by the same step:
only each copy's own key is stored encrypted with the live key, so
re-encrypting `data_key_ciphertext` keeps every message readable to its
owner. Keyed digests used for repeated requests (`keyedSecretHash`) aren't
re-keyed; they only stop a request being run twice within minutes.

## The recovery kit (part 2)

The kit is the current recovery key, its version, its id and when it was
made. Nothing else. A server admin gets it on the server computer only (the
local server settings address), after typing their password again; the
export is audited without the key. Two forms:

- **Recovery code**: the key in Crockford base32 with a 4-character check,
  grouped in fours (`RK1-XXXX-XXXX-...`). The check catches a mistyped
  character. Save it in a password manager, or print it and keep it
  somewhere safe offline.
- **Recovery file** (`.tohyee-recovery`, JSON): the code encrypted with
  AES-256-GCM under a key from scrypt (N = 2^17, r = 8, p = 1, 32-byte
  random salt) of a passphrase. The file's version, key id and date are in
  the clear and authenticated. The passphrase must be at least 14
  characters (the page can make one). The passphrase must be kept somewhere
  other than the file; losing every copy of it makes the file useless.

The file can go in ordinary OneDrive storage because it's encrypted, but the
passphrase must not. An optional random file name is offered for
convenience; it adds no security (anyone who can read the file can see what
it is and try it), the wizard recognises a kit by its contents, and nobody
has to remember the name. The extension stays `.tohyee-recovery`.

Guidance shown with it: a password manager's secure note or attachment is
the best home; a printed copy in a safe place is a good second. OneDrive
Personal Vault (personal Microsoft accounts only; free plans hold only a few
files) adds a second sign-in step but is part of the same Microsoft account
as the backups, so it isn't independent of them.

**Checking a kit**: a server admin pastes the code, or gives the file and its
passphrase. The server opens it and compares the key with the one it holds
for that version (timing-safe). Only a check that worked is recorded: the
version, the key id, when and by whom. This proves the copy was right when
it was checked, not that it still exists. A new recovery key version needs
its own check.

## Changing keys and keeping old backups (part 2)

- **New recovery key**: a server admin can make version n+1 (password
  again). New backups use it; the older versions stay on the server so its
  own older backups still open here. They're never deleted automatically.
  The status shows how many kept backups still need each older version, and
  until about when (retention keeps the first backup of each month for 12
  months). Keep the old kit until then.
- **Rotation can't recall copies**: if an old backup and its kit were taken
  together, a new key doesn't undo that. A new key only protects backups made
  from then on.
- **Moving to format 2**: nothing is converted. The first backup after the
  update makes recovery key version 1. Older format 1 files still need the
  older backup key (this server's `TOHYEE_SECRET_KEY`) on another computer,
  so its "Show / check the key" stays, labelled for older backups, while any
  format 1 file is kept.
- **The live key** isn't changed by any of this. Changing it is still not
  supported in the app (stored secrets would have to be re-encrypted, which
  the part 3 re-encryption makes possible later).

## Destinations and what "off-site" means (part 1)

- One backup folder, chosen in the server app, on the web page or with
  `backups set --folder`. Saving checks Tohyee can make, write and delete a
  file there, and shows what kind of place it is: a OneDrive, Google Drive,
  Dropbox or iCloud folder (worked out from the path), a network share, or a
  folder on this computer.
- **A file written into a synced folder isn't proof it reached the cloud.**
  Tohyee can't see whether OneDrive uploaded it (sync can be paused, signed
  out, out of storage, or only running while someone is signed in to
  Windows). So off-site is always shown as **not verified**, with what to
  check: the OneDrive icon, and the file on onedrive.com. The server app,
  which runs as the signed-in person, also warns when OneDrive isn't running.
- **Sync copies mistakes too**: deleting a backup, or ransomware scrambling
  the folder, reaches the cloud copy. OneDrive keeps earlier versions and a
  recycle bin for a while, which may help, but isn't a guarantee. The page
  recommends an independent copy now and then: a USB drive kept unplugged,
  or a second provider.
- **Space**: before each backup, the free space on the backup folder's disk
  is compared with the size of the last backups; when it's clearly too
  little the backup fails at once with a clear message, and nothing is
  deleted to make room.
- **Errors say what to do**: a missing folder or drive, no permission (with
  the `icacls` command on Windows), a full disk, a read-only drive, missing
  PostgreSQL tools.

## Keeping good copies (part 1)

- Each file is written as `.partial`, fully checked (decrypted, so its tag is
  checked, into `pg_restore --list`), then renamed. Its SHA-256 is recorded
  in `backup_runs`.
- Old files are pruned only after a new backup has been made and checked.
  Pruning only counts files whose header reads; a damaged file is never
  counted towards the 14 days or 12 months (so it can't push out a good
  one), and is never deleted by pruning either: it's reported instead.
- **Integrity checks**: once a week (and on request) the newest kept file of
  every database is read back from the folder and fully checked again, and
  its SHA-256 compared with the one recorded when it was made. This catches a
  file changed or damaged after it was written (by sync, a disk fault or
  ransomware). Each check is a row in `backup_checks`.

## What the status shows, and on what evidence (part 1, then 2 and 3)

| Line | Shown from | Never from |
| --- | --- | --- |
| Latest backup and its age, per database | `backup_runs` rows written by the code doing the backup | a file just being there |
| Last integrity check | `backup_checks` (integrity) rows | |
| Off-site | always "not verified" (nothing Tohyee can see proves an upload) | a write into a synced folder |
| Storage | the files in the folder and the disk's free space | |
| Recovery kit (part 2) | a successful check of a code or file, for the current key version | a box someone ticks |
| Last test restore (part 3) | `backup_checks` (test restore) rows | |

There's no "safe" or "fully recoverable" badge. The panel lists what's
missing or unproven (no kit checked, no test restore, off-site not
verified) instead.

## The restore wizard (part 3)

On the replacement computer: install Tohyee, make the first server admin,
open Server settings, Backups, Restore on this computer.

1. **Find the backups**: a folder on this computer (the OneDrive folder once
   OneDrive has downloaded it, a USB drive). Only `.tohyee-backup` files are
   read, and only their headers until a key is given.
2. **Choose one**: organisation, date, Tohyee version, file format and key
   version are shown.
3. **Give its recovery material**: nothing (this server made it), the
   recovery code, the recovery file and its passphrase, or (format 1) the old
   backup key.
4. **Check**: the whole file is decrypted (tag checked) into
   `pg_restore --list`, and its schema version compared with this server's.
   A newer backup is refused before anything is made.
5. **Restore as a new organisation** (the default ID is the original's when
   it isn't on this server, otherwise `<id>-<date>`). Existing organisations
   are never overwritten or deleted. Encrypted fields are re-encrypted (above).
6. **Automatic jobs stay paused** on the restored copy (email sending, bank
   and payment feeds, mailbox checks, repeating invoices, analytics loads)
   until a server admin turns them on, so it can't send the same invoices or
   import the same transactions as the original while both exist. Turning
   them on shows what will start and how many emails are waiting to go.
7. **Results and a cutover checklist**: what was checked (rows, files,
   encrypted values, private mail copies and their owners), what needs
   connecting again, and the steps: check the books, switch the old
   installation off, reconnect, turn jobs on, set up backups here and save
   this server's own recovery kit, keep the old backups and kit until they
   age out. The copies never synchronise.

**One organisation or the whole server**: restoring an organisation brings
its books, files and history. The people, their sign-ins and memberships
live in the server's own database; on a replacement computer they come back
with **Recover people from a server backup**: it opens the `_server` backup
the same way, adds each user who isn't on this server with the same ID,
password and two-step sign-in (its secret re-encrypted), and adds their
memberships for organisations here with the same ID. A person already on
this server under the same email with a different ID is reported, not
merged, unless their account here has no organisations and the server admin
chooses to replace it. It can be run again after more organisations are
restored. Server settings (email sending, remote access, folders) aren't
copied: the old tunnel token would compete with the original, and folder
paths differ; they're listed to set up again.

**Private mail stays its owner's** (#250): a private copy is restored still
owned by the same person (`owner_user_id`). The server admin who restores
becomes an Owner of the copy but still gets "not found" for anyone else's
private mail. If its owner isn't on this server, the copy is kept and nobody
can read it until that person's account is recovered.

**An interrupted restore** (power cut, restart) is recorded as running; when
the server starts again it's marked failed and the half-made database and
registry entry (still "pending") are removed. Nothing existing is touched.

**Test restore**: the same steps into a scratch database that's dropped
afterwards, recorded in `backup_checks`; the status shows the last one.

## Tested and not tested

Automated tests (vitest, against real PostgreSQL and real `pg_dump` /
`pg_restore` on Linux) are listed in each pull request. No real Windows
installer run, real OneDrive account or real disaster-recovery exercise
(a second computer restoring from OneDrive with only the kit) has been done
for any of this. The Windows installer workflow builds and installs on a
GitHub Windows runner; that isn't the same as a person recovering a server.

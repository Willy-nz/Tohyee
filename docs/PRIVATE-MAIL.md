# My mail: who can read a private mail copy

Issue #250; decisions 610-619; examples PM1-PM19. This says plainly what
protects an Owner's private copy of their own mail, and what doesn't.

## What it is

An organisation Owner can keep a private copy of their own Gmail or
Microsoft mailbox in Tohyee, for themselves and their own AI. It uses the
farm calendar's mailbox connection (one connection per mailbox, one choice
of folders, #340), so only the folders or labels the Owner ticked are ever
read, and nothing until they tick one. Access is read-only
(`gmail.readonly`, `Mail.Read`): Tohyee never sends, marks, moves or
deletes anything in the mailbox.

## Who is refused

All of these get "not found", the same answer as for a copy that doesn't
exist, on every route (listing, search, a conversation, an attachment,
folders, switching, syncing, deleting):

- other members of the organisation, whatever their role: admins, other
  Owners, bookkeepers and accountants, viewers, report viewers, sales roles;
- server admins (they see an organisation's data only as a member, and as
  a member they're refused like anyone else);
- anyone given the organisation later: a new Owner, a handover (decision
  485), a restored copy whose owner is someone else;
- custom apps (farm app keys) and AI keys, except a Look only AI key its
  own Owner gave the private-mail scope on My mail (decision 618);
- the copy's own owner once they stop being an Owner, leave the
  organisation or their login is turned off. Their copy is then left
  alone: not readable and not synced. It isn't given to anyone. If they
  become an Owner again, it's theirs again.

How it's enforced: every read and change goes through one access layer
(`src/lib/private-mail/access.ts`). It reads the person's role from the
server's own records at that moment and limits every query to rows whose
`owner_user_id` is theirs. The database refuses a change of
`owner_user_id`, and refuses a message or attachment whose owner isn't its
copy's owner (triggers in tenant migration 0168).

Nothing about the mail goes into the audit trail (only "copy started",
"stopped" or "deleted", with no details), the server log (a failed sync
logs only the organisation), notifications, Analytics or DuckDB, general
search, or reports. A unit test checks that no other part of Tohyee names
the private tables.

## The Owner's AI

On My mail, the Owner can tick which of their own Look only AI keys may
search and read the copy over MCP (`search_my_mail`, `read_my_mail`).
Only their own keys, only Look only (so nothing read can be written into
Tohyee), and the scope is checked again on every call by the same access
layer. Other keys aren't offered the tools. Answers cite each email.
Tohyee can't control what an AI service outside it keeps of what it was
told: that's between the Owner and their AI provider.

## How it's stored

In the organisation's own PostgreSQL database, like everything else:

| What | How |
| --- | --- |
| Subject, from, to, cc, bcc, snippet, link | Encrypted (AES-256-GCM) |
| The email's text | Encrypted |
| Attachment names and types | Encrypted |
| Attachment files (up to 20 MB each) | Encrypted |
| Search words and conversation | Keyed digests (HMAC-SHA256), see below |
| The provider's email id, date, size, number of attachments, which ticked folders it's in | Plain |
| The mailbox address and provider | Plain (as the farm calendar keeps them) |

Each copy has its own random 256-bit key. That key is stored only
encrypted with the server's `TOHYEE_SECRET_KEY` (`src/lib/secrets.ts`),
which lives in the server's environment, never in a database. Each value
is tied to its copy, its kind and its email, so it can't be moved to
another row and still open.

## How search works, and what the search index gives away

Each email's words (subject, people, text, attachment names) are turned
into short keyed digests with the copy's key and stored with the email.
A search turns its words into digests the same way and finds emails that
have all of them. Searches are whole words ("olsen", not "ols"), without
accents or case. "from:address" and "to:address" match people exactly.
There are no search suggestions, and the search words aren't kept or put
in a web address.

Someone who has the database but not `TOHYEE_SECRET_KEY` can't turn the
digests back into words. They can still see which emails share a word
(equal digests), how many distinct words an email has, and how often each
digest appears, which over a large mailbox could let a determined person
guess common words. They can also see the plain columns above: how many
emails there are, their dates and sizes, which are in the same
conversation, and how many attachments each has.

## What it doesn't protect against

**Someone who controls the server, Tohyee's code and `TOHYEE_SECRET_KEY`
can read the mail.** That includes whoever runs the server computer, its
database administrator if they also have the key, and anyone who changes
Tohyee's code on it. The server has to be able to decrypt the mail to sync
it unattended, search it and give it to the Owner's AI. This is
protection from other people in Tohyee and from a copy of the database on
its own. It isn't end-to-end encryption, and Tohyee doesn't claim it is.
Keys held only by the Owner (decrypted in their browser) would change
that, at the cost of unattended syncing and server-side AI, and would need
a recovery design first; it isn't built.

## Disconnecting, deleting and backups

- **Keep a private copy** off: copying stops; what was copied stays.
- **Disconnect**: the mailbox's tokens and folder choice are deleted (and
  what the farm calendar read from it). The copy stays, not copying, until
  deleted. Connecting the same mailbox again carries on the same copy.
- **Delete my copy**: every copied email, attachment and search digest is
  deleted at once. PostgreSQL reclaims the space in time (vacuum).
- **Backups**: an organisation backup made before the deletion still holds
  the copy (encrypted as above, and its key encrypted with the server's
  key, so the backup and `TOHYEE_SECRET_KEY` together can read it). Backups
  are kept for the newest of each of the last 14 days and the first of
  each of the last 12 months (`src/lib/backups/retention.ts`), so a deleted
  copy is gone from every backup about 12 months later. A backup file
  copied elsewhere is outside Tohyee's reach.
- **Restoring** a backup as a new organisation brings the copy with it,
  still owned by the same person; nobody else can read it there either.

## Not tried with a real mailbox

All of this is tested against made-up Gmail and Microsoft Graph replies.
It hasn't been tried with a real mailbox, so real-world limits (Gmail's
and Microsoft's request quotas, very large mailboxes, unusual messages)
haven't been seen yet.

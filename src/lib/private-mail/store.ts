import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import {
  type ClaimedFarmState,
  deleteMailbox,
  type fetchFarmMailConnection,
  mailboxAccessToken,
  saveFolderChoice,
  startFarmMailConnect,
  storeMailboxAccount,
} from "@/lib/farming/calendar";
import type { MailFolder } from "@/lib/farming/mail-providers";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { MailOwner, notFound } from "@/lib/private-mail/access";
import { type CopyKeys, copyKeys, newWrappedDataKey, open, openJson, queryTokens } from "@/lib/private-mail/crypto";
import { listPrivateFolders } from "@/lib/private-mail/providers";
import type { CopyState, DetachedCopy, MailAttachmentInfo, MailHit, MailMessage, MailPerson, MailThread, MyMail, MyMailbox } from "@/lib/private-mail/types";

/*
 * My mail: an Owner's private copy of their own mail (#250; examples
 * PM1-PM14, decisions 610-617). Everything here takes a MailOwner
 * (access.ts) and only ever touches rows whose owner_user_id is theirs.
 * Nothing here writes names, subjects, addresses, counts or folder names
 * to the audit trail or the server log.
 */

export type Envelope = {
  subject: string | null;
  from: MailPerson | null;
  to: MailPerson[];
  cc: MailPerson[];
  bcc: MailPerson[];
  snippet: string;
  webLink: string | null;
};

export type AttachmentMeta = { name: string; contentType: string; inline: boolean; notKept: "too_big" | "linked" | null };

/** A PostgreSQL timestamp's text ("2026-10-19 09:15:00+00") as ISO. */
function iso(value: string): string;
function iso(value: string | null): string | null;
function iso(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function idOf(input: unknown): string {
  const id = typeof input === "string" || typeof input === "number" ? String(input) : "";
  if (!/^[1-9][0-9]{0,18}$/.test(id)) throw notFound();
  return id;
}

type CopyRow = {
  id: string;
  account_id: string | null;
  provider: "google" | "microsoft";
  mailbox_email: string;
  copying: boolean;
  paused: boolean;
  last_sync_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  listed_count: number;
  listing_capped: boolean;
  copied: number;
  oldest: string | null;
  newest: string | null;
  attachments: number;
  not_kept: number;
  deleted_at_source: number;
};

const COPY_COLUMNS = `c.id::text, c.account_id::text, c.provider, c.mailbox_email, c.copying, c.paused, c.last_sync_at::text, c.last_success_at::text,
       c.last_error, c.listed_count, c.listing_capped,
       (select count(*)::int from private_mail_messages m where m.copy_id = c.id) as copied,
       (select min(m.sent_at)::text from private_mail_messages m where m.copy_id = c.id) as oldest,
       (select max(m.sent_at)::text from private_mail_messages m where m.copy_id = c.id) as newest,
       (select count(*)::int from private_mail_attachments a where a.copy_id = c.id) as attachments,
       (select count(*)::int from private_mail_attachments a where a.copy_id = c.id and a.content is null) as not_kept,
       (select count(*)::int from private_mail_messages m where m.copy_id = c.id and m.source_deleted_at is not null) as deleted_at_source`;

function toCopy(row: CopyRow): CopyState {
  return {
    id: row.id,
    copying: row.copying,
    paused: row.paused,
    lastSyncAt: iso(row.last_sync_at),
    lastSuccessAt: iso(row.last_success_at),
    lastError: row.last_error,
    copied: row.copied,
    listed: row.listed_count,
    listingCapped: row.listing_capped,
    oldest: iso(row.oldest),
    newest: iso(row.newest),
    attachments: row.attachments,
    attachmentsNotKept: row.not_kept,
    deletedAtSource: row.deleted_at_source,
  };
}

/** PM1, PM3: the owner's own mailboxes (every connection of theirs, whichever screen made it) and their copies. */
export async function myMail(tx: OrgTx, owner: MailOwner): Promise<MyMail> {
  owner.check(tx);
  const accounts = await tx.query<{ id: string; provider: "google" | "microsoft"; email: string; history_days: number; history_from: string; status: "active" | "paused"; farm_calendar: boolean }>(
    "select id::text, provider, email, history_days, history_from::text, status, farm_calendar from farm_mail_accounts where user_id = $1 order by email, farm_mail_accounts.id",
    [owner.userId],
  );
  const folders = await tx.query<{ id: string; account_id: string; external_id: string; name: string; include_subfolders: boolean; missing: boolean; private_only: boolean }>(
    `select f.id::text, f.account_id::text, f.external_id, f.name, f.include_subfolders, f.missing, f.private_only
       from farm_mail_folders f join farm_mail_accounts a on a.id = f.account_id
      where a.user_id = $1 order by f.private_only, lower(f.name), f.id`,
    [owner.userId],
  );
  const copies = await tx.query<CopyRow>(`select ${COPY_COLUMNS} from private_mail_copies c where c.owner_user_id = $1 order by c.mailbox_email, c.id`, [owner.userId]);
  const mailboxes: MyMailbox[] = accounts.rows.map((row) => {
    const copy = copies.rows.find((entry) => entry.account_id === row.id);
    return {
      id: row.id,
      provider: row.provider,
      email: row.email,
      historyDays: row.history_days,
      historyFrom: iso(row.history_from),
      status: row.status,
      farmCalendar: row.farm_calendar,
      folders: folders.rows
        .filter((folder) => folder.account_id === row.id)
        .map((folder) => ({ id: folder.id, externalId: folder.external_id, name: folder.name, includeSubfolders: folder.include_subfolders, missing: folder.missing, privateOnly: folder.private_only })),
      copy: copy ? toCopy(copy) : null,
    };
  });
  const detached: DetachedCopy[] = copies.rows.filter((row) => row.account_id === null).map((row) => ({ ...toCopy(row), provider: row.provider, email: row.mailbox_email }));
  return { mailboxes, detached };
}

/** The owner's own connection, or "not found". */
export async function ownAccount(tx: OrgTx, owner: MailOwner, idInput: unknown): Promise<string> {
  owner.check(tx);
  const id = idOf(idInput);
  const found = await tx.query("select 1 from farm_mail_accounts where id = $1 and user_id = $2", [id, owner.userId]);
  if (!found.rowCount) throw notFound();
  return id;
}

/** The owner's own copy, or "not found". */
async function ownCopy(tx: OrgTx, owner: MailOwner, idInput: unknown): Promise<{ id: string; keys: CopyKeys; email: string }> {
  owner.check(tx);
  const id = idOf(idInput);
  const found = await tx.query<{ id: string; data_key_ciphertext: string; mailbox_email: string }>(
    "select id::text, data_key_ciphertext, mailbox_email from private_mail_copies where id = $1 and owner_user_id = $2",
    [id, owner.userId],
  );
  const row = found.rows[0];
  if (!row) throw notFound();
  return { id: row.id, keys: copyKeys(row.id, row.data_key_ciphertext), email: row.mailbox_email };
}

/** PM1: starts connecting a mailbox from My mail (the farm calendar's connection, decision 610). */
export async function startMyMailConnect(tx: OrgTx, owner: MailOwner, input: { provider: unknown; historyDays?: unknown }, origin: string): Promise<{ url: string }> {
  owner.check(tx);
  return startFarmMailConnect(tx, { provider: input.provider, historyDays: input.historyDays }, origin, "private");
}

/**
 * PM1: stores a mailbox connected from My mail and turns its private copy
 * on. Nothing is copied until folders are ticked (PM2). Only an Owner
 * gets here; someone who stopped being one between starting and finishing
 * gets "not found".
 */
export async function savePrivateMailbox(
  tx: OrgTx,
  claimed: ClaimedFarmState,
  connection: Awaited<ReturnType<typeof fetchFarmMailConnection>>,
  now = new Date(),
): Promise<{ id: string; email: string }> {
  const owner = await MailOwner.of(tx);
  const id = await storeMailboxAccount(tx, claimed, connection, now, false);
  await setCopying(tx, owner, id, true);
  return { id, email: connection.email };
}

/**
 * PM1, PM12: the switch "Keep a private copy of these emails for me and my
 * AI". On makes the copy (with its own key) or carries on the one this
 * mailbox had before it was disconnected; off stops copying and keeps what
 * was copied, until "Delete imported history".
 */
export async function setCopying(tx: OrgTx, owner: MailOwner, accountInput: unknown, on: unknown): Promise<void> {
  const accountId = await ownAccount(tx, owner, accountInput);
  if (typeof on !== "boolean") throw new ValidationError("Say whether to keep a private copy.");
  const account = (await tx.query<{ provider: string; email: string }>("select provider, email from farm_mail_accounts where id = $1", [accountId])).rows[0];
  const existing = await tx.query<{ id: string }>("select id::text from private_mail_copies where account_id = $1 and owner_user_id = $2 for update", [accountId, owner.userId]);
  let copyId = existing.rows[0]?.id ?? null;
  if (on) {
    if (!copyId) {
      // The same mailbox's copy from before it was disconnected carries on (PM12).
      const detached = await tx.query<{ id: string }>(
        "select id::text from private_mail_copies where owner_user_id = $1 and provider = $2 and lower(mailbox_email) = lower($3) and account_id is null for update",
        [owner.userId, account.provider, account.email],
      );
      copyId = detached.rows[0]?.id ?? null;
      if (copyId) await tx.query("update private_mail_copies set account_id = $2 where id = $1", [copyId, accountId]);
      else {
        copyId = (
          await tx.query<{ id: string }>(
            "insert into private_mail_copies (owner_user_id, account_id, provider, mailbox_email, data_key_ciphertext) values ($1, $2, $3, $4, $5) returning id::text",
            [owner.userId, accountId, account.provider, account.email, newWrappedDataKey()],
          )
        ).rows[0].id;
      }
    }
    await tx.query("update private_mail_copies set copying = true, paused = false, failures = 0, last_error = null, updated_at = now() where id = $1", [copyId]);
  } else if (copyId) {
    await tx.query("update private_mail_copies set copying = false, updated_at = now() where id = $1", [copyId]);
  }
  if (copyId) {
    // No details: not the mailbox, folders or how many emails (decision 617).
    await writeAuditEvent(tx, { eventType: on ? "private_mail.copy_started" : "private_mail.copy_stopped", entityType: "private_mail_copy", entityId: copyId, details: {} });
  }
}

/**
 * PM13: "Delete imported history": every copied email, attachment and search token
 * goes now, whether or not the mailbox is still connected. The mailbox
 * isn't touched, and the connection (and the farm calendar) carry on.
 */
export async function deleteMyCopy(tx: OrgTx, owner: MailOwner, copyInput: unknown): Promise<void> {
  const copy = await ownCopy(tx, owner, copyInput);
  await tx.query("delete from private_mail_copies where id = $1 and owner_user_id = $2", [copy.id, owner.userId]);
  await writeAuditEvent(tx, { eventType: "private_mail.copy_deleted", entityType: "private_mail_copy", entityId: copy.id, details: {} });
}

/**
 * PM12: disconnecting from My mail is disconnecting the one connection:
 * tokens and folder choice go, and so does what the farm calendar read
 * from it (FC15). The private copy stays, not copying, until deleted.
 */
export async function disconnectMyMailbox(tx: OrgTx, owner: MailOwner, accountInput: unknown): Promise<void> {
  const accountId = await ownAccount(tx, owner, accountInput);
  await tx.query("update private_mail_copies set copying = false, updated_at = now() where account_id = $1 and owner_user_id = $2", [accountId, owner.userId]);
  await deleteMailbox(tx, accountId);
}

/** PM2: the folders to tick, from the mailbox now (network, no transaction). The caller checked it's the owner's. */
export async function myFolderChoices(organisation: OrganisationRecord, accountId: string): Promise<MailFolder[]> {
  const { access, token } = await mailboxAccessToken(organisation, accountId);
  return listPrivateFolders(access.provider, token);
}

/** PM2, PM6: the one folder choice, saved from My mail. */
export async function chooseMyFolders(tx: OrgTx, owner: MailOwner, accountInput: unknown, input: unknown, available: MailFolder[]): Promise<MyMail> {
  const accountId = await ownAccount(tx, owner, accountInput);
  await saveFolderChoice(tx, accountId, input, available, "all");
  return myMail(tx, owner);
}

/** "Sync now": the owner's own copy that's copying. */
export async function copyForSync(tx: OrgTx, owner: MailOwner, copyInput: unknown): Promise<string> {
  const copy = await ownCopy(tx, owner, copyInput);
  const row = (await tx.query<{ copying: boolean; paused: boolean; account_id: string | null }>("select copying, paused, account_id::text from private_mail_copies where id = $1", [copy.id])).rows[0];
  if (!row.account_id) throw new ValidationError("This copy's mailbox was disconnected. Connect it again to carry on copying.");
  if (!row.copying) throw new ValidationError("Copying is off for this mailbox. Turn it on first.");
  if (row.paused) throw new ValidationError("Copying stopped after failed syncs. Connect the mailbox again to carry on.");
  const folders = await tx.query("select 1 from farm_mail_folders where account_id = $1", [row.account_id]);
  if (!folders.rowCount) throw new ValidationError("Tick the folders to copy first: nothing is copied until you do.");
  return copy.id;
}

// Reading ------------------------------------------------------------------------------------------

type MessageRow = { id: string; copy_id: string; external_id: string; sent_at: string; envelope: Buffer; attachment_count: number; source_deleted: boolean; data_key_ciphertext: string };

function keysFor(cache: Map<string, CopyKeys>, row: { copy_id: string; data_key_ciphertext: string }): CopyKeys {
  let keys = cache.get(row.copy_id);
  if (!keys) {
    keys = copyKeys(row.copy_id, row.data_key_ciphertext);
    cache.set(row.copy_id, keys);
  }
  return keys;
}

export const SEARCH_LIMIT = 50;

/**
 * PM9: the owner's email, newest first, or what matches every word of
 * `query` (whole words; "from:address", "to:address"). Optionally one
 * copy, and before a point (for "More"). No suggestions, and the search
 * itself isn't kept.
 */
export async function searchMyMail(
  tx: OrgTx,
  owner: MailOwner,
  input: { query?: unknown; copyId?: unknown; before?: unknown; limit?: unknown },
): Promise<{ hits: MailHit[]; more: string | null }> {
  owner.check(tx);
  const query = typeof input.query === "string" ? input.query.slice(0, 500) : "";
  const limit = Math.min(SEARCH_LIMIT, Math.max(1, Number.isInteger(Number(input.limit)) ? Number(input.limit) : SEARCH_LIMIT));
  const params: unknown[] = [owner.userId];
  const where = ["c.owner_user_id = $1", "m.owner_user_id = $1"];
  if (input.copyId !== undefined && input.copyId !== null && input.copyId !== "") {
    params.push(idOf(input.copyId));
    where.push(`m.copy_id = $${params.length}`);
  }
  if (typeof input.before === "string" && input.before) {
    const [at, id] = input.before.split("|");
    if (!at || !Number.isFinite(Date.parse(at)) || !/^[1-9][0-9]{0,18}$/.test(id ?? "")) throw new ValidationError("That page of results has expired. Search again.");
    params.push(at, id);
    where.push(`(m.sent_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
  }
  const copies = query.trim() ? (await tx.query<{ id: string; data_key_ciphertext: string }>("select id::text, data_key_ciphertext from private_mail_copies where owner_user_id = $1", [owner.userId])).rows : [];
  if (query.trim()) {
    // Each copy has its own key, so its own tokens for the same words.
    const clauses: string[] = [];
    for (const copy of copies) {
      const tokens = queryTokens(copyKeys(copy.id, copy.data_key_ciphertext), query);
      if (!tokens.length) continue;
      params.push(copy.id, tokens);
      clauses.push(`(m.copy_id = $${params.length - 1} and m.search_tokens @> $${params.length}::text[])`);
    }
    if (!clauses.length) return { hits: [], more: null };
    where.push(`(${clauses.join(" or ")})`);
  }
  params.push(limit + 1);
  const rows = await tx.query<MessageRow>(
    `select m.id::text, m.copy_id::text, m.external_id, m.sent_at::text, m.envelope, m.attachment_count, m.source_deleted_at is not null as source_deleted, c.data_key_ciphertext
       from private_mail_messages m join private_mail_copies c on c.id = m.copy_id
      where ${where.join(" and ")}
      order by m.sent_at desc, m.id desc limit $${params.length}`,
    params,
  );
  const cache = new Map<string, CopyKeys>();
  const page = rows.rows.slice(0, limit);
  const hits = page.map((row) => {
    const envelope = openJson<Envelope>(keysFor(cache, row), "envelope", row.external_id, row.envelope);
    return { id: row.id, copyId: row.copy_id, sentAt: iso(row.sent_at), from: envelope.from, subject: envelope.subject, snippet: envelope.snippet, attachmentCount: row.attachment_count, deletedInMailbox: row.source_deleted };
  });
  const last = page[page.length - 1];
  return { hits, more: rows.rows.length > limit && last ? `${last.sent_at}|${last.id}` : null };
}

/** PM10: one email's conversation, oldest first, with its attachments' details. Someone else's is "not found". */
export async function readMyThread(tx: OrgTx, owner: MailOwner, messageInput: unknown): Promise<MailThread> {
  owner.check(tx);
  const id = idOf(messageInput);
  const found = await tx.query<{ copy_id: string; thread_key: string }>(
    "select m.copy_id::text, m.thread_key from private_mail_messages m join private_mail_copies c on c.id = m.copy_id where m.id = $1 and m.owner_user_id = $2 and c.owner_user_id = $2",
    [id, owner.userId],
  );
  if (!found.rows[0]) throw notFound();
  const copy = await ownCopy(tx, owner, found.rows[0].copy_id);
  const rows = await tx.query<{ id: string; external_id: string; sent_at: string; envelope: Buffer; body: Buffer; source_deleted: boolean }>(
    `select id::text, external_id, sent_at::text, envelope, body, source_deleted_at is not null as source_deleted from private_mail_messages
      where copy_id = $1 and owner_user_id = $2 and thread_key = $3 order by sent_at, private_mail_messages.id limit 200`,
    [copy.id, owner.userId, found.rows[0].thread_key],
  );
  const attachments = await tx.query<{ id: string; message_id: string; external_id: string; meta: Buffer; size_bytes: number; kept: boolean; message_external_id: string }>(
    `select a.id::text, a.message_id::text, a.external_id, a.meta, a.size_bytes, a.content is not null as kept, m.external_id as message_external_id
       from private_mail_attachments a join private_mail_messages m on m.id = a.message_id
      where a.copy_id = $1 and a.owner_user_id = $2 and a.message_id = any($3::bigint[]) order by a.id`,
    [copy.id, owner.userId, rows.rows.map((row) => row.id)],
  );
  const messages: MailMessage[] = rows.rows.map((row) => {
    const envelope = openJson<Envelope>(copy.keys, "envelope", row.external_id, row.envelope);
    const files: MailAttachmentInfo[] = attachments.rows
      .filter((attachment) => attachment.message_id === row.id)
      .map((attachment) => {
        const meta = openJson<AttachmentMeta>(copy.keys, "attachment-meta", `${attachment.message_external_id}/${attachment.external_id}`, attachment.meta);
        return { id: attachment.id, name: meta.name, contentType: meta.contentType, size: attachment.size_bytes, inline: meta.inline, kept: attachment.kept, notKept: attachment.kept ? null : meta.notKept };
      });
    return {
      id: row.id,
      sentAt: iso(row.sent_at),
      from: envelope.from,
      to: envelope.to,
      cc: envelope.cc,
      bcc: envelope.bcc,
      subject: envelope.subject,
      text: open(copy.keys, "body", row.external_id, row.body).toString("utf8"),
      webLink: envelope.webLink,
      attachments: files,
      deletedInMailbox: row.source_deleted,
    };
  });
  return { copyId: copy.id, mailbox: copy.email, messages };
}

/** PM11: one attachment's file, decrypted, for its owner only. */
export async function myAttachment(tx: OrgTx, owner: MailOwner, attachmentInput: unknown): Promise<{ name: string; contentType: string; content: Buffer }> {
  owner.check(tx);
  const id = idOf(attachmentInput);
  const found = await tx.query<{ copy_id: string; external_id: string; meta: Buffer; content: Buffer | null; message_external_id: string }>(
    `select a.copy_id::text, a.external_id, a.meta, a.content, m.external_id as message_external_id
       from private_mail_attachments a join private_mail_messages m on m.id = a.message_id join private_mail_copies c on c.id = a.copy_id
      where a.id = $1 and a.owner_user_id = $2 and c.owner_user_id = $2`,
    [id, owner.userId],
  );
  const row = found.rows[0];
  if (!row) throw notFound();
  const copy = await ownCopy(tx, owner, row.copy_id);
  const external = `${row.message_external_id}/${row.external_id}`;
  const meta = openJson<AttachmentMeta>(copy.keys, "attachment-meta", external, row.meta);
  if (!row.content) throw new ValidationError(meta.notKept === "linked" ? "That's a linked Outlook item: open it in Outlook." : "That attachment was too big to keep: open it in your mailbox.");
  return { name: meta.name, contentType: meta.contentType, content: open(copy.keys, "attachment", external, row.content) };
}

/**
 * For a restore or test restore (#389, decision 738): whose private mail
 * copies a restored database holds, as owner IDs only (nothing of any
 * email), so the wizard can say whether their owners are on this server.
 * Takes the restored database's own admin connection, not a person's.
 */
export async function privateMailCopyOwners(client: { query<T>(sql: string): Promise<{ rows: T[] }> }): Promise<string[]> {
  const exists = await client.query<{ ok: boolean }>("select to_regclass('public.private_mail_copies') is not null as ok");
  if (!exists.rows[0]?.ok) return [];
  return (await client.query<{ owner_user_id: string }>("select owner_user_id::text from private_mail_copies")).rows.map((row) => row.owner_user_id);
}

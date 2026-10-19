import { type OrgTx, withOrganisationTransaction, type Actor } from "@/lib/db/org-transaction";
import { mailboxAccessToken } from "@/lib/farming/calendar";
import { listFolderMailIds, type FolderListing, type MailFolder } from "@/lib/farming/mail-providers";
import { listAllOrganisations } from "@/lib/organisations/admin";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { isActiveOwner } from "@/lib/private-mail/access";
import { copyKeys, type CopyKeys, emailTokens, seal, sealJson, threadKey } from "@/lib/private-mail/crypto";
import { fetchPrivateAttachment, fetchPrivateMail, listPrivateFolders, MAX_ATTACHMENT_BYTES, type PrivateMail, decodeBase64Url } from "@/lib/private-mail/providers";
import type { AttachmentMeta, Envelope } from "@/lib/private-mail/store";
import { secretsAvailable } from "@/lib/secrets";

/*
 * Copying a mailbox into its owner's private copy (#250; PM2-PM8, decision
 * 614). Each sync lists the ticked folders' emails back to the read-back
 * date (newest first, at most 10,000 per folder), copies the ones not yet
 * copied (at most 300 emails and 200 MB of attachments a sync, newest
 * first, each committed as it's copied, so an interrupted first copy
 * carries on where it stopped and never copies an email twice), and drops
 * emails that left the ticked folders (decision 585's rules). It runs every
 * 15 minutes with the farm calendar's checks, and on "Sync now". Only
 * while the copy's owner is an Owner with an active login (PM8): otherwise
 * it's left alone, unread and uncopied. The server log never names the
 * mailbox, a folder or an email.
 */

export const PRIVATE_MAIL_ACTOR: Actor = { userId: null, email: "private-mail@tohyee" };
export const MAX_PRIVATE_IDS_PER_FOLDER = 10_000;
export const MAX_COPY_PER_SYNC = 300;
export const MAX_ATTACHMENT_BYTES_PER_SYNC = 200 * 1024 * 1024;
const PAUSE_AFTER_FAILURES = 3;

type CopyRow = { id: string; owner_user_id: string; account_id: string | null; copying: boolean; paused: boolean; data_key_ciphertext: string };

const syncing = new Set<string>();

export type SyncResult = { copied: number; removed: number; skipped?: "not_copying" | "suspended" | "no_folders" | "busy" };

async function loadCopy(organisation: OrganisationRecord, copyId: string): Promise<CopyRow | null> {
  return withOrganisationTransaction(organisation, PRIVATE_MAIL_ACTOR, async (tx) => {
    const found = await tx.query<CopyRow>(
      "select id::text, owner_user_id::text, account_id::text, copying, paused, data_key_ciphertext from private_mail_copies where id = $1",
      [copyId],
    );
    return found.rows[0] ?? null;
  });
}

/** Stores one email (and its kept attachments) in its own transaction; false if it was already there or the copy is gone. */
async function storeMail(
  organisation: OrganisationRecord,
  copy: CopyRow,
  keys: CopyKeys,
  mail: PrivateMail,
  folderIds: string[],
  files: Map<string, Buffer>,
): Promise<boolean> {
  return withOrganisationTransaction(organisation, PRIVATE_MAIL_ACTOR, async (tx) => {
    // Turned off, deleted or handed to nobody while this sync ran: stop.
    const still = await tx.query("select 1 from private_mail_copies where id = $1 and owner_user_id = $2 and copying and account_id = $3 for share", [copy.id, copy.owner_user_id, copy.account_id]);
    if (!still.rowCount) return false;
    const current = new Set((await tx.query<{ id: string }>("select id::text from farm_mail_folders where account_id = $1", [copy.account_id])).rows.map((row) => row.id));
    const folders = folderIds.filter((id) => current.has(id));
    if (!folders.length) return false;
    const envelope: Envelope = {
      subject: mail.subject,
      from: mail.from,
      to: mail.to,
      cc: mail.cc,
      bcc: mail.bcc,
      snippet: mail.text.replace(/\s+/g, " ").trim().slice(0, 200),
      webLink: mail.webLink,
    };
    const tokens = emailTokens(keys, {
      text: [mail.subject ?? "", mail.from?.name ?? "", mail.from?.email ?? "", ...[...mail.to, ...mail.cc, ...mail.bcc].flatMap((person) => [person.name ?? "", person.email]), mail.text, ...mail.attachments.map((file) => file.name)].join("\n"),
      from: mail.from ? [mail.from.email] : [],
      to: [...mail.to, ...mail.cc, ...mail.bcc].map((person) => person.email),
    });
    const inserted = await tx.query<{ id: string }>(
      `insert into private_mail_messages (copy_id, owner_user_id, external_id, thread_key, sent_at, folder_ids, envelope, body, size_bytes, attachment_count, search_tokens)
       values ($1, $2, $3, $4, $5, $6::bigint[], $7, $8, $9, $10, $11::text[])
       on conflict (copy_id, external_id) do nothing returning id::text`,
      [
        copy.id,
        copy.owner_user_id,
        mail.externalId,
        threadKey(keys, mail.threadId),
        mail.sentAt,
        folders,
        sealJson(keys, "envelope", mail.externalId, envelope),
        seal(keys, "body", mail.externalId, Buffer.from(mail.text, "utf8")),
        Math.max(0, Math.min(2_000_000_000, Math.round(mail.size))),
        mail.attachments.length,
        tokens,
      ],
    );
    const messageId = inserted.rows[0]?.id;
    if (!messageId) return false;
    for (const attachment of mail.attachments) {
      const external = `${mail.externalId}/${attachment.externalId}`;
      const meta: AttachmentMeta = { name: attachment.name, contentType: attachment.contentType, inline: attachment.inline, notKept: attachment.notKept };
      const file = files.get(attachment.externalId);
      await tx.query(
        `insert into private_mail_attachments (message_id, copy_id, owner_user_id, external_id, meta, content, size_bytes)
         values ($1, $2, $3, $4, $5, $6, $7) on conflict (message_id, external_id) do nothing`,
        [messageId, copy.id, copy.owner_user_id, attachment.externalId, sealJson(keys, "attachment-meta", external, meta), file ? seal(keys, "attachment", external, file) : null, file?.length ?? attachment.size],
      );
    }
    return true;
  });
}

/**
 * One sync of one copy (PM3-PM6). Network calls happen outside database
 * transactions; each email is committed on its own.
 */
export async function syncPrivateCopy(organisation: OrganisationRecord, copyId: string, now = new Date()): Promise<SyncResult> {
  if (syncing.has(`${organisation.id}/${copyId}`)) return { copied: 0, removed: 0, skipped: "busy" };
  syncing.add(`${organisation.id}/${copyId}`);
  try {
    const copy = await loadCopy(organisation, copyId);
    if (!copy || !copy.copying || copy.paused || !copy.account_id) return { copied: 0, removed: 0, skipped: "not_copying" };
    // PM8: only while its owner is an Owner with an active login.
    if (!(await isActiveOwner(organisation.id, copy.owner_user_id))) return { copied: 0, removed: 0, skipped: "suspended" };
    try {
      return await copyNow(organisation, copy, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await withOrganisationTransaction(organisation, PRIVATE_MAIL_ACTOR, (tx) =>
        tx.query(
          `update private_mail_copies set failures = failures + 1, last_error = $2, last_sync_at = $3,
                  paused = paused or failures + 1 >= $4, updated_at = now() where id = $1`,
          [copy.id, message.slice(0, 500), now.toISOString(), PAUSE_AFTER_FAILURES],
        ),
      );
      throw error;
    }
  } finally {
    syncing.delete(`${organisation.id}/${copyId}`);
  }
}

async function copyNow(organisation: OrganisationRecord, copy: CopyRow, now: Date): Promise<SyncResult> {
  const { access, token } = await mailboxAccessToken(organisation, copy.account_id!, now);
  // The connection is the owner's own; anything else is never read.
  if (access.userId !== copy.owner_user_id) return { copied: 0, removed: 0, skipped: "not_copying" };
  if (!access.folders.length) return { copied: 0, removed: 0, skipped: "no_folders" };
  const keys = copyKeys(copy.id, copy.data_key_ciphertext);
  const labels: MailFolder[] | null = access.provider === "google" ? await listPrivateFolders(access.provider, token) : null;
  const listings: Array<{ folderId: string; listing: FolderListing }> = [];
  for (const folder of access.folders) {
    const spamTrash = access.provider === "google" && (folder.externalId === "SPAM" || folder.externalId === "TRASH");
    const listing = await listFolderMailIds(
      access.provider,
      token,
      { externalId: folder.externalId, includeSubfolders: folder.includeSubfolders },
      new Date(access.historyFrom),
      MAX_PRIVATE_IDS_PER_FOLDER,
      labels,
      { includeSpamTrash: spamTrash, graphPageSize: 500 },
    );
    listings.push({ folderId: folder.id, listing });
  }
  const inFolders = new Map<string, Set<string>>();
  for (const { folderId, listing } of listings) for (const id of listing.ids) inFolders.set(id, (inFolders.get(id) ?? new Set()).add(folderId));
  const listed = [...inFolders.keys()];
  const stored = await withOrganisationTransaction(organisation, PRIVATE_MAIL_ACTOR, async (tx) => {
    const rows = await tx.query<{ external_id: string; sent_at: string }>("select external_id, sent_at::text from private_mail_messages where copy_id = $1 and external_id = any($2::text[])", [copy.id, listed]);
    return new Map(rows.rows.map((row) => [row.external_id, row.sent_at]));
  });
  let copied = 0;
  let fetched = 0;
  let bytes = 0;
  for (const id of listed) {
    if (stored.has(id)) continue;
    if (fetched >= MAX_COPY_PER_SYNC || bytes >= MAX_ATTACHMENT_BYTES_PER_SYNC) break;
    fetched += 1;
    const mail = await fetchPrivateMail(access.provider, token, id, access.email);
    const files = new Map<string, Buffer>();
    for (const attachment of mail.attachments) {
      if (attachment.notKept) continue;
      const inline = mail.inlineData.get(attachment.externalId);
      const file = inline !== undefined ? decodeBase64Url(inline) : await fetchPrivateAttachment(access.provider, token, mail.externalId, attachment.externalId);
      if (file.length > MAX_ATTACHMENT_BYTES) {
        attachment.notKept = "too_big";
        continue;
      }
      files.set(attachment.externalId, file);
      bytes += file.length;
    }
    if (await storeMail(organisation, copy, keys, mail, [...(inFolders.get(id) ?? [])], files)) copied += 1;
  }
  return withOrganisationTransaction(organisation, PRIVATE_MAIL_ACTOR, async (tx) => finishSync(tx, copy, listings, inFolders, stored, now, copied));
}

/** PM6, PM7: folder moves and deletions, as the farm calendar does them (decision 585), and what the sync found. */
async function finishSync(
  tx: OrgTx,
  copy: CopyRow,
  listings: Array<{ folderId: string; listing: FolderListing }>,
  inFolders: Map<string, Set<string>>,
  stored: Map<string, string>,
  now: Date,
  copied: number,
): Promise<SyncResult> {
  const still = await tx.query("select 1 from private_mail_copies where id = $1 and owner_user_id = $2 for update", [copy.id, copy.owner_user_id]);
  if (!still.rowCount) return { copied, removed: 0 };
  const current = new Set((await tx.query<{ id: string }>("select id::text from farm_mail_folders where account_id = $1", [copy.account_id])).rows.map((row) => row.id));
  for (const { folderId, listing } of listings) {
    if (current.has(folderId)) await tx.query("update farm_mail_folders set missing = $2 where id = $1", [folderId, listing.missing]);
  }
  const listed = [...inFolders.keys()];
  // When a folder had more than could be listed, only emails newer than the
  // oldest listed one copied (less a day) can be known to have left.
  let dropAfter: string | null = null;
  let dropNone = false;
  for (const { listing } of listings) {
    if (listing.complete) continue;
    const dates = listing.ids.map((id) => stored.get(id)).filter((date): date is string => Boolean(date));
    if (!dates.length) {
      dropNone = true;
      continue;
    }
    const oldest = new Date(new Date(dates.reduce((a, b) => (a < b ? a : b))).getTime() + 86_400_000).toISOString();
    if (dropAfter === null || oldest > dropAfter) dropAfter = oldest;
  }
  let removed = 0;
  if (!dropNone) {
    const gone = await tx.query(
      `delete from private_mail_messages
        where copy_id = $1 and not (external_id = any($2::text[])) and ($3::timestamptz is null or sent_at > $3::timestamptz)`,
      [copy.id, listed, dropAfter],
    );
    removed = gone.rowCount ?? 0;
  }
  for (const id of listed) {
    if (!stored.has(id)) continue;
    const folders = [...(inFolders.get(id) ?? [])].filter((folder) => current.has(folder));
    await tx.query("update private_mail_messages set folder_ids = $3::bigint[] where copy_id = $1 and external_id = $2 and folder_ids <> $3::bigint[]", [copy.id, id, folders]);
  }
  await tx.query(
    `update private_mail_copies set listed_count = $2, listing_capped = $3, last_sync_at = $4, last_success_at = $4, last_error = null, failures = 0, updated_at = now()
      where id = $1`,
    [copy.id, listed.length, listings.some(({ listing }) => !listing.complete), now.toISOString()],
  );
  return { copied, removed };
}

let running = false;

/** Every copy on the server that's copying, one at a time (every 15 minutes, after the farm calendar). */
export async function syncAllPrivateMail(): Promise<{ synced: number; failed: number }> {
  if (running || !secretsAvailable()) return { synced: 0, failed: 0 };
  running = true;
  let synced = 0;
  let failed = 0;
  try {
    for (const organisation of await listAllOrganisations()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      let ids: string[] = [];
      try {
        ids = await withOrganisationTransaction(organisation, PRIVATE_MAIL_ACTOR, async (tx) =>
          (
            await tx.query<{ id: string }>(
              `select c.id::text from private_mail_copies c
                where c.copying and not c.paused and c.account_id is not null
                  and exists (select 1 from farm_mail_folders f where f.account_id = c.account_id)
                order by c.last_sync_at nulls first, c.id`,
            )
          ).rows.map((row) => row.id),
        );
      } catch {
        continue;
      }
      for (const id of ids) {
        try {
          const result = await syncPrivateCopy(organisation, id);
          if (!result.skipped) synced += 1;
        } catch {
          failed += 1;
          // Never the mailbox, a folder or the provider's words (decision 617).
          console.warn(`[tohyee] A private mail sync failed in ${organisation.id}.`);
        }
      }
    }
    return { synced, failed };
  } finally {
    running = false;
  }
}

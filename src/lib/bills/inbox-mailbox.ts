import { ACCOUNTING_ON_SQL } from "@/lib/organisations/accounting-switch";
import { createHash } from "node:crypto";
import { assertPublicMailHost } from "@/lib/analytics/mail-host";
import { imapReportMessages, reportMessages } from "@/lib/analytics/report-email-providers";
import { writeAuditEvent } from "@/lib/audit";
import { FEED_ACTOR } from "@/lib/bank/akahu/sync";
import { addInboxItem, isInboxFileName } from "@/lib/bills/inbox";
import { reportMailboxToken } from "@/lib/crm/mail/service";
import { requireCrm } from "@/lib/crm/switch";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { ConflictError, ForbiddenError, HttpError, NotFoundError, ValidationError } from "@/lib/errors";
import { MAX_ATTACHMENT_BYTES } from "@/lib/records/file-types";
import { listAllOrganisations } from "@/lib/organisations/admin";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { requireId, requireString } from "@/lib/validation";

/**
 * Bills inbox mailboxes (BI2, decisions 404-406): a mailbox folder or Gmail
 * label read through an admin's own CRM Gmail or Microsoft mailbox, or IMAP
 * with an app password, the same connections as automatic statement files
 * (BF7). Each message is read once; its PDF and picture attachments become
 * inbox items with the sender and subject, and other files are ignored.
 */

export const DEFAULT_INBOX_HOURS = 1;
export const MAX_INBOX_FILES_PER_CHECK = 200;
const MAX_ERROR = 1000;

export type InboxMailbox = {
  id: string;
  mailKind: "crm" | "imap";
  mailAccountId: string | null;
  mailAccountEmail: string | null;
  imapHost: string | null;
  imapUsername: string | null;
  mailFolderId: string;
  mailFolderName: string;
  ownerUserId: string;
  yours: boolean;
  syncEveryHours: number;
  lastCheckAt: string | null;
  lastStatus: "ok" | "failed" | null;
  lastError: string | null;
  lastFilesAdded: number | null;
  lastFilesSkipped: number | null;
  createdByEmail: string | null;
};

type Row = {
  id: string;
  mail_kind: "crm" | "imap";
  mail_account_id: string | null;
  mail_account_email: string | null;
  imap_host: string | null;
  imap_username: string | null;
  imap_password_ciphertext: string | null;
  mail_folder_id: string;
  mail_folder_name: string;
  owner_user_id: string;
  sync_every_hours: number;
  last_check_at: string | null;
  last_status: "ok" | "failed" | null;
  last_error: string | null;
  last_files_added: number | null;
  last_files_skipped: number | null;
  lease_until: string | null;
  created_by_email: string | null;
};

const SELECT = `
  select m.id::text, m.mail_kind, m.mail_account_id::text, c.email as mail_account_email, m.imap_host, m.imap_username,
         m.imap_password_ciphertext, m.mail_folder_id, m.mail_folder_name, m.owner_user_id::text, m.sync_every_hours,
         m.last_check_at, m.last_status, m.last_error, m.last_files_added, m.last_files_skipped, m.lease_until, m.created_by_email
    from bill_inbox_mailboxes m
    left join crm_connected_accounts c on c.id = m.mail_account_id`;

function toMailbox(row: Row, userId: string | null): InboxMailbox {
  return {
    id: row.id,
    mailKind: row.mail_kind,
    mailAccountId: row.mail_account_id,
    mailAccountEmail: row.mail_account_email,
    imapHost: row.imap_host,
    imapUsername: row.imap_username,
    mailFolderId: row.mail_folder_id,
    mailFolderName: row.mail_folder_name,
    ownerUserId: row.owner_user_id,
    yours: row.owner_user_id === userId,
    syncEveryHours: row.sync_every_hours,
    lastCheckAt: row.last_check_at ? new Date(row.last_check_at).toISOString() : null,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastFilesAdded: row.last_files_added,
    lastFilesSkipped: row.last_files_skipped,
    createdByEmail: row.created_by_email,
  };
}

/** Where a mailbox reads from: the same place gives the same key, so a message is read once even if the mailbox is set up again. */
function locationOf(row: Pick<Row, "mail_kind" | "mail_account_id" | "imap_host" | "imap_username" | "mail_folder_id">): string {
  if (row.mail_kind === "crm") return `crm:${row.mail_account_id}:${row.mail_folder_id}`;
  return `imap:${(row.imap_host ?? "").toLowerCase()}:${row.imap_username}:${row.mail_folder_id}`;
}

async function mailboxRow(tx: OrgTx, idInput: unknown, lock = false): Promise<Row> {
  const id = requireId(idInput, "mailboxId");
  const found = await tx.query<Row>(`${SELECT} where m.id = $1 ${lock ? "for update of m" : ""}`, [id]);
  if (!found.rows[0]) throw new NotFoundError("Mailbox not found.");
  return found.rows[0];
}

function parseHours(input: unknown): number {
  if (input == null || input === "") return DEFAULT_INBOX_HOURS;
  const hours = Number(input);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw new ValidationError("Check every must be 1 to 24 hours.");
  return hours;
}

export async function listInboxMailboxes(tx: OrgTx): Promise<InboxMailbox[]> {
  const found = await tx.query<Row>(`${SELECT} order by m.id`);
  return found.rows.map((row) => toMailbox(row, tx.actor.userId));
}

async function ownConnectedAccount(tx: OrgTx, input: unknown): Promise<string> {
  await requireCrm(tx);
  const accountId = requireId(input, "mailAccountId");
  const found = await tx.query<{ user_id: string; status: string }>("select user_id::text, status from crm_connected_accounts where id = $1", [accountId]);
  if (!found.rows[0]) throw new NotFoundError("Connected mailbox not found.");
  if (found.rows[0].user_id !== tx.actor.userId) throw new ForbiddenError("Choose your own connected mailbox.");
  if (found.rows[0].status !== "active") throw new ConflictError("Reconnect this mailbox first.");
  return accountId;
}

function imapLogin(input: Record<string, unknown>): { host: string; username: string; password: string } {
  const host = requireString(input.imapHost, "IMAP host", { maxLength: 253 });
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) {
    throw new ValidationError("Enter the IMAP server's host name, without a URL or port.");
  }
  const username = requireString(input.imapUsername, "IMAP username", { maxLength: 320 });
  const password = input.imapPassword;
  if (typeof password !== "string" || !password || password.length > 1000 || /[\u0000\r\n]/.test(password)) {
    throw new ValidationError("Enter the mailbox's app password.");
  }
  return { host, username, password };
}

/** Links the inbox to a mailbox folder or label (BI2). Admins; it reads as them. */
export async function createInboxMailbox(tx: OrgTx, input: Record<string, unknown>): Promise<InboxMailbox> {
  if (!tx.actor.userId) throw new ForbiddenError("Sign in to set up a mailbox.");
  const mailKind = input.mailKind;
  if (mailKind !== "crm" && mailKind !== "imap") throw new ValidationError("Choose a connected mailbox or IMAP.");
  const folderId = requireString(input.mailFolderId, "mail folder", { maxLength: 500 });
  const folderName = requireString(input.mailFolderName, "mail folder name", { maxLength: 500 });
  const mailAccountId = mailKind === "crm" ? await ownConnectedAccount(tx, input.mailAccountId) : null;
  const login = mailKind === "imap" ? imapLogin(input) : null;
  if (login) await assertPublicMailHost(login.host);
  const hours = parseHours(input.syncEveryHours);
  const location = locationOf({ mail_kind: mailKind, mail_account_id: mailAccountId, imap_host: login?.host ?? null, imap_username: login?.username ?? null, mail_folder_id: folderId });
  const existing = await tx.query<Row>(SELECT);
  if (existing.rows.some((row) => locationOf(row) === location)) throw new ConflictError("The inbox already reads that folder.");
  const inserted = await tx.query<{ id: string }>(
    `insert into bill_inbox_mailboxes (mail_kind, mail_account_id, imap_host, imap_username, imap_password_ciphertext, mail_folder_id,
                                       mail_folder_name, owner_user_id, sync_every_hours, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id::text`,
    [
      mailKind,
      mailAccountId,
      login?.host ?? null,
      login?.username ?? null,
      login ? encryptSecret(login.password) : null,
      folderId,
      folderName,
      tx.actor.userId,
      hours,
      tx.actor.email,
    ],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "bill_inbox_mailbox.created",
    entityType: "bill_inbox_mailbox",
    entityId: id,
    details: { mailKind, folderName, syncEveryHours: hours },
  });
  return toMailbox(await mailboxRow(tx, id), tx.actor.userId);
}

export async function updateInboxMailbox(tx: OrgTx, idInput: unknown, input: { syncEveryHours?: unknown }): Promise<InboxMailbox> {
  const row = await mailboxRow(tx, idInput, true);
  const hours = parseHours(input.syncEveryHours);
  await tx.query("update bill_inbox_mailboxes set sync_every_hours = $2, updated_at = now() where id = $1", [row.id, hours]);
  await writeAuditEvent(tx, { eventType: "bill_inbox_mailbox.updated", entityType: "bill_inbox_mailbox", entityId: row.id, details: { syncEveryHours: hours } });
  return toMailbox(await mailboxRow(tx, row.id), tx.actor.userId);
}

/** Stops reading a mailbox. Its items stay, and so do the messages it read. */
export async function deleteInboxMailbox(tx: OrgTx, idInput: unknown): Promise<void> {
  const row = await mailboxRow(tx, idInput, true);
  if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw new ConflictError("This mailbox is being checked. Try again in a minute.");
  await tx.query("delete from bill_inbox_mailboxes where id = $1", [row.id]);
  await writeAuditEvent(tx, { eventType: "bill_inbox_mailbox.deleted", entityType: "bill_inbox_mailbox", entityId: row.id, details: { folderName: row.mail_folder_name } });
}

export type InboxMailCheck = { mailboxId: string; status: "ok" | "failed"; filesAdded: number; filesSkipped: number; error: string | null };

async function ownerEmail(userId: string): Promise<string | null> {
  const found = await coreQuery<{ email: string }>("select email from users where id = $1", [userId]);
  return found.rows[0]?.email ?? null;
}

/**
 * Checks one mailbox now (Check now, or the schedule): every message not
 * yet read, each in its own transaction. PDF and picture attachments become
 * inbox items; one that isn't really that kind of file, or is over 10 MB,
 * is skipped and counted. The message is then marked read (BI2).
 */
export async function checkInboxMailbox(organisation: OrganisationRecord, actor: Actor, idInput: unknown): Promise<InboxMailCheck> {
  const row = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const found = await mailboxRow(tx, idInput, true);
    if (found.lease_until && new Date(found.lease_until).getTime() > Date.now()) throw new ConflictError("This mailbox is already being checked.");
    await tx.query("update bill_inbox_mailboxes set lease_until = now() + interval '10 minutes' where id = $1", [found.id]);
    return found;
  });
  // It reads as the admin who set it up (their own mailbox), so the items show them.
  const readAs: Actor = { userId: row.owner_user_id, email: (await ownerEmail(row.owner_user_id)) ?? actor.email };
  const location = locationOf(row);
  let filesAdded = 0;
  let filesSkipped = 0;
  let error: string | null = null;
  try {
    const done = new Set(
      (
        await withOrganisationTransaction(organisation, readAs, (tx) =>
          tx.query<{ message_id: string }>("select message_id from bill_inbox_mail_seen where location = $1", [location]),
        )
      ).rows.map((entry) => entry.message_id),
    );
    const skip = (messageId: string) => done.has(messageId);
    let messages;
    if (row.mail_kind === "crm") {
      if (!row.mail_account_id) throw new ConflictError("The mailbox the inbox read has been disconnected. Set it up again.");
      const access = await reportMailboxToken(organisation, readAs, row.mail_account_id);
      messages = reportMessages(access.provider, access.token, row.mail_folder_id, skip);
    } else {
      await assertPublicMailHost(row.imap_host!);
      messages = imapReportMessages(
        { host: row.imap_host!, port: 993, username: row.imap_username!, password: decryptSecret(row.imap_password_ciphertext!) },
        row.mail_folder_id,
        skip,
      );
    }
    let files = 0;
    reading: for await (const message of messages) {
      if (done.has(message.id)) continue;
      let added = 0;
      for (const [index, attachment] of message.attachments.entries()) {
        if (!isInboxFileName(attachment.name)) continue;
        // The rest wait for the next check; this message is read again then (adding a file is idempotent).
        if (files >= MAX_INBOX_FILES_PER_CHECK) break reading;
        files += 1;
        if (attachment.size > MAX_ATTACHMENT_BYTES) {
          filesSkipped += 1;
          continue;
        }
        let content: Buffer;
        try {
          content = await attachment.read();
        } catch (caught) {
          if (caught instanceof HttpError) {
            filesSkipped += 1;
            continue;
          }
          throw caught;
        }
        try {
          const result = await withOrganisationTransaction(organisation, readAs, (tx) =>
            addInboxItem(tx, {
              source: "mailbox",
              idempotencyKey: `mail-${createHash("sha256").update(`${location}\u0000${message.id}\u0000${index}`).digest("hex").slice(0, 64)}`,
              fileName: attachment.name,
              content: new Uint8Array(content),
              via: "mailbox",
              mailboxId: row.id,
              emailFrom: message.from ?? null,
              emailSubject: message.subject ?? null,
              emailDate: message.receivedAt,
            }),
          );
          if (result.created) added += 1;
        } catch (caught) {
          if (!(caught instanceof ValidationError)) throw caught;
          filesSkipped += 1;
        }
      }
      filesAdded += added;
      // The message is done: it isn't read again, even with no bills in it.
      await withOrganisationTransaction(organisation, readAs, (tx) =>
        tx.query("insert into bill_inbox_mail_seen (location, message_id, files_added) values ($1, $2, $3) on conflict do nothing", [location, message.id, added]),
      );
      done.add(message.id);
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, MAX_ERROR) : "The check failed.";
  } finally {
    const status = error ? "failed" : "ok";
    await withOrganisationTransaction(organisation, actor, (tx) =>
      tx.query(
        `update bill_inbox_mailboxes set last_check_at = now(), last_status = $2, last_error = $3, last_files_added = $4, last_files_skipped = $5,
                lease_until = null where id = $1`,
        [row.id, status, error, filesAdded, filesSkipped],
      ),
    );
  }
  return { mailboxId: row.id, status: error ? "failed" : "ok", filesAdded, filesSkipped, error };
}

let running = false;

/** Checks every mailbox on the server that's due, one at a time. */
export async function checkDueInboxMailboxes(): Promise<{ checked: number; failed: number }> {
  if (running) return { checked: 0, failed: 0 };
  running = true;
  let checked = 0;
  let failed = 0;
  try {
    // Mailbox passwords and tokens need the server's secret key.
    if (!secretsAvailable()) return { checked, failed };
    for (const organisation of await listAllOrganisations()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      let due: string[] = [];
      try {
        due = (
          await withOrganisationTransaction(organisation, FEED_ACTOR, (tx) =>
            tx.query<{ id: string }>(
              `select id::text from bill_inbox_mailboxes
                where ${ACCOUNTING_ON_SQL} and (last_check_at is null or last_check_at < now() - make_interval(hours => sync_every_hours))
                  and (lease_until is null or lease_until < now())
                order by last_check_at nulls first`,
            ),
          )
        ).rows.map((entry) => entry.id);
      } catch {
        continue;
      }
      for (const id of due) {
        try {
          const result = await checkInboxMailbox(organisation, FEED_ACTOR, id);
          if (result.status === "failed") failed += 1;
          checked += 1;
        } catch {
          failed += 1;
        }
      }
    }
    return { checked, failed };
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Looks for due mailboxes every 15 minutes while the server runs. */
export function startBillInboxScheduler(): void {
  if (timer) return;
  const tick = () => {
    checkDueInboxMailboxes().catch((caught) => console.warn("[tohyee] Bills inbox mailboxes:", caught));
  };
  timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 2 * 60 * 1000).unref?.();
}

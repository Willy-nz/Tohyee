import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertPublicMailHost } from "@/lib/analytics/mail-host";
import { imapReportMessages, listImapFolders, listReportFolders, reportMessages } from "@/lib/analytics/report-email-providers";
import { writeAuditEvent } from "@/lib/audit";
import { FEED_ACTOR } from "@/lib/bank/akahu/sync";
import { bankFilesFolderStatus, organisationBankFilesFolder, resolveSubfolder } from "@/lib/bank/file-folders";
import { MAX_STATEMENT_FILE_BYTES } from "@/lib/bank/formats";
import { importStatementFromFeed } from "@/lib/bank/imports";
import { reportMailboxToken } from "@/lib/crm/mail/service";
import { requireCrm } from "@/lib/crm/switch";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { listAllOrganisations } from "@/lib/organisations/admin";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { requireId, requireString } from "@/lib/validation";

/**
 * Automatic statement files (BF1-BF10, decisions 385-387). A bank or credit
 * card account can have feeds that bring statement files in by themselves:
 *
 * - a **folder feed** reads one subfolder of the organisation's bank files
 *   folder (chosen by a server admin, decision 386);
 * - a **mailbox feed** reads one mailbox folder or Gmail label, through the
 *   member's own CRM Gmail or Microsoft mailbox, or IMAP with an app password.
 *
 * Each file goes through the statement importers (`importStatementFromFeed`),
 * so the duplicate rules are those of an import by hand, and nothing is
 * posted. What each place has given the account is remembered by file (or
 * message and attachment) name and contents, so a file is read again only
 * when it changes (BF3), and removing a feed doesn't forget it (BF10).
 */

export const DEFAULT_FEED_HOURS = 6;
export const MAX_FEED_FILES_PER_CHECK = 200;
const MAX_ERROR = 1000;

/** File names a feed reads; anything else (PDFs, pictures) is ignored (BF7). */
const STATEMENT_FILE = /\.(csv|txt|tsv|xlsx|xls|ofx|qfx|qbo|qif|xml|sta|mt940|940)$/i;

export type BankFileFeed = {
  id: string;
  accountId: string;
  kind: "folder" | "mailbox";
  /** Folder feeds: the subfolder's name. */
  subfolder: string | null;
  /** Mailbox feeds: how it reads mail, and which folder or label. */
  mailKind: "crm" | "imap" | null;
  mailAccountId: string | null;
  mailAccountEmail: string | null;
  imapHost: string | null;
  imapUsername: string | null;
  mailFolderId: string | null;
  mailFolderName: string | null;
  /** Whose mailbox it reads (the admin who set it up). */
  ownerUserId: string | null;
  yours: boolean;
  syncEveryHours: number;
  lastCheckAt: string | null;
  lastStatus: "ok" | "failed" | null;
  lastError: string | null;
  lastFilesRead: number | null;
  lastLinesAdded: number | null;
  createdByEmail: string | null;
};

export type FeedFileResult = {
  name: string;
  result: "imported" | "no_new" | "failed";
  reason: string | null;
  linesAdded: number;
  seenAt: string;
};

type FeedRow = {
  id: string;
  account_id: string;
  kind: "folder" | "mailbox";
  subfolder: string | null;
  mail_kind: "crm" | "imap" | null;
  mail_account_id: string | null;
  mail_account_email: string | null;
  imap_host: string | null;
  imap_username: string | null;
  imap_password_ciphertext: string | null;
  mail_folder_id: string | null;
  mail_folder_name: string | null;
  owner_user_id: string | null;
  sync_every_hours: number;
  last_check_at: string | null;
  last_status: "ok" | "failed" | null;
  last_error: string | null;
  last_files_read: number | null;
  last_lines_added: number | null;
  lease_until: string | null;
  created_by_email: string | null;
};

const SELECT = `
  select f.id::text, f.account_id::text, f.kind, f.subfolder, f.mail_kind, f.mail_account_id::text,
         c.email as mail_account_email, f.imap_host, f.imap_username, f.imap_password_ciphertext,
         f.mail_folder_id, f.mail_folder_name, f.owner_user_id::text, f.sync_every_hours,
         f.last_check_at, f.last_status, f.last_error, f.last_files_read, f.last_lines_added, f.lease_until, f.created_by_email
    from bank_file_feeds f
    left join crm_connected_accounts c on c.id = f.mail_account_id`;

function toFeed(row: FeedRow, userId: string | null): BankFileFeed {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    subfolder: row.subfolder,
    mailKind: row.mail_kind,
    mailAccountId: row.mail_account_id,
    mailAccountEmail: row.mail_account_email,
    imapHost: row.imap_host,
    imapUsername: row.imap_username,
    mailFolderId: row.mail_folder_id,
    mailFolderName: row.mail_folder_name,
    ownerUserId: row.owner_user_id,
    yours: row.owner_user_id !== null && row.owner_user_id === userId,
    syncEveryHours: row.sync_every_hours,
    lastCheckAt: row.last_check_at ? new Date(row.last_check_at).toISOString() : null,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastFilesRead: row.last_files_read,
    lastLinesAdded: row.last_lines_added,
    createdByEmail: row.created_by_email,
  };
}

/** Where a feed reads from, as its seen files are kept (BF10): the same place gives the same key. */
function locationOf(row: Pick<FeedRow, "kind" | "subfolder" | "mail_kind" | "mail_account_id" | "imap_host" | "imap_username" | "mail_folder_id">): string {
  if (row.kind === "folder") return `folder:${row.subfolder}`;
  if (row.mail_kind === "crm") return `mailbox:crm:${row.mail_account_id}:${row.mail_folder_id}`;
  return `mailbox:imap:${(row.imap_host ?? "").toLowerCase()}:${row.imap_username}:${row.mail_folder_id}`;
}

async function feedRow(tx: OrgTx, feedId: unknown, lock = false): Promise<FeedRow> {
  const id = requireId(feedId, "feedId");
  const result = await tx.query<FeedRow>(`${SELECT} where f.id = $1 ${lock ? "for update of f" : ""}`, [id]);
  if (!result.rows[0]) throw new NotFoundError("Feed not found.");
  return result.rows[0];
}

/** Checks a feed belongs to the account in the address, so a route can't act on another account's feed. */
export async function assertFeedOnAccount(tx: OrgTx, accountIdInput: unknown, feedIdInput: unknown): Promise<void> {
  const accountId = requireId(accountIdInput, "accountId");
  const row = await feedRow(tx, feedIdInput);
  if (row.account_id !== accountId) throw new NotFoundError("Feed not found.");
}

async function statementAccount(tx: OrgTx, accountIdInput: unknown): Promise<{ id: string; code: string }> {
  const accountId = requireId(accountIdInput, "accountId");
  const found = await tx.query<{ id: string; code: string; account_type: string }>(
    "select id::text, code, account_type from accounts where id = $1",
    [accountId],
  );
  const account = found.rows[0];
  if (!account || !["bank", "credit_card"].includes(account.account_type)) throw new NotFoundError("Bank account not found.");
  return account;
}

function parseHours(input: unknown): number {
  if (input == null || input === "") return DEFAULT_FEED_HOURS;
  const hours = Number(input);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw new ValidationError("Check every must be 1 to 24 hours.");
  return hours;
}

/** An account's feeds, for anyone who can see the account (BF9). */
export async function listFileFeeds(tx: OrgTx, accountIdInput: unknown): Promise<BankFileFeed[]> {
  const account = await statementAccount(tx, accountIdInput);
  const result = await tx.query<FeedRow>(`${SELECT} where f.account_id = $1 order by f.id`, [account.id]);
  return result.rows.map((row) => toFeed(row, tx.actor.userId));
}

/** The files a feed has read, newest first, for its "last check" details. */
export async function feedFiles(tx: OrgTx, feedIdInput: unknown, limit = 50): Promise<FeedFileResult[]> {
  const row = await feedRow(tx, feedIdInput);
  const result = await tx.query<{ item_key: string; result: FeedFileResult["result"]; reason: string | null; lines_added: number; seen_at: string }>(
    `select item_key, result, reason, lines_added, seen_at from bank_file_feed_seen
      where account_id = $1 and location = $2 and item_key not like '%/'
      order by seen_at desc limit $3`,
    [row.account_id, locationOf(row), limit],
  );
  return result.rows.map((entry) => ({
    name: entry.item_key.includes("/") ? entry.item_key.slice(entry.item_key.lastIndexOf("/") + 1) : entry.item_key,
    result: entry.result,
    reason: entry.reason,
    linesAdded: entry.lines_added,
    seenAt: new Date(entry.seen_at).toISOString(),
  }));
}

/**
 * Links an account to a subfolder of the organisation's bank files folder
 * (BF1, BF9). Admins. The subfolder must be a plain name that's really inside
 * the folder; with no folder chosen by a server admin, it's refused.
 */
export async function createFolderFeed(tx: OrgTx, organisationId: string, accountIdInput: unknown, input: { subfolder?: unknown; syncEveryHours?: unknown }): Promise<BankFileFeed> {
  const account = await statementAccount(tx, accountIdInput);
  const subfolder = requireString(input.subfolder, "subfolder", { maxLength: 255 });
  const root = await organisationBankFilesFolder(organisationId);
  if (!root) throw new ConflictError("A server admin needs to choose this organisation's bank files folder first.");
  if (!resolveSubfolder(root, subfolder)) throw new ValidationError(`"${subfolder}" isn't a folder inside the organisation's bank files folder.`);
  const clash = await tx.query("select 1 from bank_file_feeds where account_id = $1 and kind = 'folder' and subfolder = $2", [account.id, subfolder]);
  if (clash.rowCount) throw new ConflictError("This account already reads that folder.");
  const hours = parseHours(input.syncEveryHours);
  const inserted = await tx.query<{ id: string }>(
    `insert into bank_file_feeds (account_id, kind, subfolder, sync_every_hours, created_by_email)
     values ($1, 'folder', $2, $3, $4) returning id::text`,
    [account.id, subfolder, hours, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "bank_file_feed.created",
    entityType: "bank_file_feed",
    entityId: id,
    details: { accountCode: account.code, kind: "folder", subfolder, syncEveryHours: hours },
  });
  return toFeed(await feedRow(tx, id), tx.actor.userId);
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

/**
 * Links an account to a mailbox folder or Gmail label (BF7): the member's own
 * CRM Gmail or Microsoft mailbox, or IMAP (port 993, TLS) with an app
 * password, which is stored encrypted. Admins; the feed reads as them.
 */
export async function createMailboxFeed(tx: OrgTx, accountIdInput: unknown, input: Record<string, unknown>): Promise<BankFileFeed> {
  if (!tx.actor.userId) throw new ForbiddenError("Sign in to set up a mailbox feed.");
  const account = await statementAccount(tx, accountIdInput);
  const mailKind = input.mailKind;
  if (mailKind !== "crm" && mailKind !== "imap") throw new ValidationError("Choose a connected mailbox or IMAP.");
  const folderId = requireString(input.mailFolderId, "mail folder", { maxLength: 500 });
  const folderName = requireString(input.mailFolderName, "mail folder name", { maxLength: 500 });
  const mailAccountId = mailKind === "crm" ? await ownConnectedAccount(tx, input.mailAccountId) : null;
  const login = mailKind === "imap" ? imapLogin(input) : null;
  if (login) await assertPublicMailHost(login.host);
  const hours = parseHours(input.syncEveryHours);
  const inserted = await tx.query<{ id: string }>(
    `insert into bank_file_feeds (account_id, kind, mail_kind, mail_account_id, imap_host, imap_username, imap_password_ciphertext,
                                  mail_folder_id, mail_folder_name, owner_user_id, sync_every_hours, created_by_email)
     values ($1, 'mailbox', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id::text`,
    [
      account.id,
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
    eventType: "bank_file_feed.created",
    entityType: "bank_file_feed",
    entityId: id,
    details: { accountCode: account.code, kind: "mailbox", mailKind, folderName, syncEveryHours: hours },
  });
  return toFeed(await feedRow(tx, id), tx.actor.userId);
}

/** Changes how often a feed is checked (1-24 hours). Admins. */
export async function updateFileFeed(tx: OrgTx, feedIdInput: unknown, input: { syncEveryHours?: unknown }): Promise<BankFileFeed> {
  const row = await feedRow(tx, feedIdInput, true);
  const hours = parseHours(input.syncEveryHours);
  await tx.query("update bank_file_feeds set sync_every_hours = $2, updated_at = now() where id = $1", [row.id, hours]);
  await writeAuditEvent(tx, { eventType: "bank_file_feed.updated", entityType: "bank_file_feed", entityId: row.id, details: { syncEveryHours: hours } });
  return toFeed(await feedRow(tx, row.id), tx.actor.userId);
}

/** Removes a feed. Its imports stay, and so does what it had seen (BF10). Admins. */
export async function deleteFileFeed(tx: OrgTx, feedIdInput: unknown): Promise<void> {
  const row = await feedRow(tx, feedIdInput, true);
  if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw new ConflictError("This feed is being checked. Try again in a minute.");
  await tx.query("delete from bank_file_feeds where id = $1", [row.id]);
  await writeAuditEvent(tx, {
    eventType: "bank_file_feed.deleted",
    entityType: "bank_file_feed",
    entityId: row.id,
    details: { kind: row.kind, place: row.kind === "folder" ? row.subfolder : row.mail_folder_name },
  });
}

/** The subfolders an admin can link to, and whether a server admin has chosen a folder (BF9). */
export async function feedSubfolders(organisationId: string): Promise<{ chosen: boolean; readable: boolean; subfolders: string[] }> {
  return bankFilesFolderStatus(organisationId);
}

/** The folders or labels of the member's own connected mailbox, or of an IMAP login, to choose one. */
export async function feedMailFolders(organisation: OrganisationRecord, actor: Actor, input: Record<string, unknown>) {
  if (input.mailKind === "crm") {
    const accountId = await withOrganisationTransaction(organisation, actor, (tx) => ownConnectedAccount(tx, input.mailAccountId));
    const access = await reportMailboxToken(organisation, actor, accountId);
    try {
      return await listReportFolders(access.provider, access.token);
    } catch {
      throw new ValidationError("Couldn't list the mailbox's folders. Reconnect it and try again.");
    }
  }
  const login = imapLogin(input);
  await assertPublicMailHost(login.host);
  try {
    return await listImapFolders({ host: login.host, port: 993, username: login.username, password: login.password });
  } catch {
    throw new ValidationError("Couldn't list mailbox folders. Check the server, username and app password, then try again.");
  }
}

type Item = { key: string; name: string; read: () => Promise<Buffer>; size: number };

/** A file or attachment's verdict, or "seen" when this place already gave the account the same contents. */
async function takeItem(
  organisation: OrganisationRecord,
  actor: Actor,
  row: FeedRow,
  item: Item,
): Promise<{ result: "imported" | "no_new" | "failed" | "seen"; linesAdded: number }> {
  const location = locationOf(row);
  let bytes: Buffer | null = null;
  let tooLarge = item.size > MAX_STATEMENT_FILE_BYTES;
  if (!tooLarge) {
    bytes = await item.read();
    tooLarge = bytes.length > MAX_STATEMENT_FILE_BYTES;
  }
  // A file too big to read is remembered by its size, so it's tried again when that changes.
  const hash = createHash("sha256").update(tooLarge ? `too-large:${item.size}` : bytes!).digest("hex");
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    const seen = await tx.query(
      "select 1 from bank_file_feed_seen where account_id = $1 and location = $2 and item_key = $3 and content_hash = $4",
      [row.account_id, location, item.key, hash],
    );
    if (seen.rowCount) return { result: "seen" as const, linesAdded: 0 };
    const outcome = tooLarge
      ? { result: "failed" as const, reason: "The file is larger than 10 MB. Split it into smaller date ranges.", linesAdded: 0, importId: null }
      : await importStatementFromFeed(tx, row.account_id, {
          fileName: item.name,
          bytes: bytes!,
          feed: row.kind,
          key: `${row.account_id}:${createHash("sha256").update(`${location}\u0000${item.key}\u0000${hash}`).digest("hex")}`,
        });
    await tx.query(
      `insert into bank_file_feed_seen (account_id, location, item_key, content_hash, result, reason, import_id, lines_added)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.account_id, location, item.key, hash, outcome.result, outcome.reason?.slice(0, MAX_ERROR) ?? null, outcome.importId, outcome.linesAdded],
    );
    return { result: outcome.result, linesAdded: outcome.linesAdded };
  });
}

/** The statement files in a folder feed's subfolder, oldest first (by modified time, then name). */
function folderItems(folder: string): Item[] {
  const entries = fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.name.startsWith(".") && STATEMENT_FILE.test(entry.name));
  return entries
    .map((entry) => {
      const full = path.join(folder, entry.name);
      const stat = fs.statSync(full);
      return { name: entry.name, full, size: stat.size, modified: stat.mtimeMs };
    })
    .sort((left, right) => left.modified - right.modified || left.name.localeCompare(right.name))
    .map((file) => ({ key: file.name, name: file.name, size: file.size, read: async () => fs.promises.readFile(file.full) }));
}

export type FeedCheck = { feedId: string; status: "ok" | "failed"; filesRead: number; linesAdded: number; error: string | null };

/**
 * Checks one feed now (Check now, or the schedule): reads every file or
 * attachment it hasn't seen, oldest first, each in its own transaction, and
 * records the outcome on the feed. A check that can't reach its folder or
 * mailbox records the reason and reads nothing, so the files wait for the
 * next check (BF8).
 */
export async function checkFileFeed(organisation: OrganisationRecord, actor: Actor, feedIdInput: unknown): Promise<FeedCheck> {
  const row = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const found = await feedRow(tx, feedIdInput, true);
    if (found.lease_until && new Date(found.lease_until).getTime() > Date.now()) throw new ConflictError("This feed is already being checked.");
    await tx.query("update bank_file_feeds set lease_until = now() + interval '10 minutes' where id = $1", [found.id]);
    return found;
  });
  // A mailbox feed reads as the member who set it up (their own mailbox).
  const readAs: Actor =
    row.kind === "mailbox" && row.mail_kind === "crm" && row.owner_user_id
      ? { userId: row.owner_user_id, email: (await ownerEmail(row.owner_user_id)) ?? actor.email }
      : actor;
  let filesRead = 0;
  let linesAdded = 0;
  let error: string | null = null;
  try {
    const take = async (item: Item) => {
      const outcome = await takeItem(organisation, readAs, row, item);
      if (outcome.result === "seen") return;
      filesRead += 1;
      linesAdded += outcome.linesAdded;
    };
    if (row.kind === "folder") {
      const root = await organisationBankFilesFolder(organisation.id);
      if (!root) throw new ConflictError("A server admin needs to choose this organisation's bank files folder.");
      const folder = resolveSubfolder(root, row.subfolder!);
      if (!folder) throw new ConflictError(`Tohyee can't open the folder "${row.subfolder}". Check it still exists in the bank files folder.`);
      let items: Item[];
      try {
        items = folderItems(folder);
      } catch {
        throw new ConflictError(`Tohyee can't read the folder "${row.subfolder}".`);
      }
      for (const item of items.slice(0, MAX_FEED_FILES_PER_CHECK)) await take(item);
    } else {
      await checkMailbox(organisation, readAs, row, take);
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, MAX_ERROR) : "The check failed.";
  }
  const status = error ? "failed" : "ok";
  await withOrganisationTransaction(organisation, actor, async (tx) => {
    await tx.query(
      `update bank_file_feeds set last_check_at = now(), last_status = $2, last_error = $3, last_files_read = $4, last_lines_added = $5,
              lease_until = null
        where id = $1`,
      [row.id, status, error, filesRead, linesAdded],
    );
  });
  return { feedId: row.id, status, filesRead, linesAdded, error };
}

async function ownerEmail(userId: string): Promise<string | null> {
  const found = await coreQuery<{ email: string }>("select email from users where id = $1", [userId]);
  return found.rows[0]?.email ?? null;
}

/** Reads a mailbox feed's folder: every message not yet done, each statement attachment as an item (BF7). */
async function checkMailbox(organisation: OrganisationRecord, actor: Actor, row: FeedRow, take: (item: Item) => Promise<void>): Promise<void> {
  const location = locationOf(row);
  const done = new Set(
    (
      await withOrganisationTransaction(organisation, actor, (tx) =>
        tx.query<{ item_key: string }>("select item_key from bank_file_feed_seen where account_id = $1 and location = $2 and item_key like '%/'", [
          row.account_id,
          location,
        ]),
      )
    ).rows.map((entry) => entry.item_key.slice(0, -1)),
  );
  const skip = (messageId: string) => done.has(messageId);
  let messages;
  if (row.mail_kind === "crm") {
    if (!row.mail_account_id) throw new ConflictError("The mailbox this feed read has been disconnected. Set the feed up again.");
    const access = await reportMailboxToken(organisation, actor, row.mail_account_id);
    messages = reportMessages(access.provider, access.token, row.mail_folder_id!, skip);
  } else {
    await assertPublicMailHost(row.imap_host!);
    messages = imapReportMessages(
      { host: row.imap_host!, port: 993, username: row.imap_username!, password: decryptSecret(row.imap_password_ciphertext!) },
      row.mail_folder_id!,
      skip,
    );
  }
  let files = 0;
  for await (const message of messages) {
    if (done.has(message.id)) continue;
    for (const attachment of message.attachments) {
      if (!STATEMENT_FILE.test(attachment.name)) continue;
      if (files >= MAX_FEED_FILES_PER_CHECK) return;
      files += 1;
      await take({ key: `${message.id}/${attachment.name}`, name: attachment.name, size: attachment.size, read: attachment.read });
    }
    // The message is done: it isn't read again, even if it had no statement files.
    await withOrganisationTransaction(organisation, actor, (tx) =>
      tx.query(
        `insert into bank_file_feed_seen (account_id, location, item_key, content_hash, result)
         values ($1, $2, $3, $4, 'no_new') on conflict do nothing`,
        [row.account_id, location, `${message.id}/`, createHash("sha256").update(message.id).digest("hex")],
      ),
    );
    done.add(message.id);
  }
}

let running = false;

/** Checks every feed on the server that's due (not checked within its "check every" hours), one at a time. */
export async function checkDueFileFeeds(): Promise<{ checked: number; failed: number }> {
  if (running) return { checked: 0, failed: 0 };
  running = true;
  let checked = 0;
  let failed = 0;
  try {
    for (const organisation of await listAllOrganisations()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      let due: Array<{ id: string; kind: string; mail_kind: string | null }> = [];
      try {
        due = (
          await withOrganisationTransaction(organisation, FEED_ACTOR, (tx) =>
            tx.query<{ id: string; kind: string; mail_kind: string | null }>(
              `select id::text, kind, mail_kind from bank_file_feeds
                where (last_check_at is null or last_check_at < now() - make_interval(hours => sync_every_hours))
                  and (lease_until is null or lease_until < now())
                order by last_check_at nulls first`,
            ),
          )
        ).rows;
      } catch {
        continue;
      }
      for (const feed of due) {
        // Mailbox passwords and tokens need the server's secret key.
        if (feed.kind === "mailbox" && !secretsAvailable()) continue;
        try {
          const result = await checkFileFeed(organisation, FEED_ACTOR, feed.id);
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

/** Looks for due feeds every 15 minutes while the server runs. */
export function startFileFeedScheduler(): void {
  if (timer) return;
  const tick = () => {
    checkDueFileFeeds().catch((error) => console.warn("[tohyee] Statement file feeds:", error));
  };
  timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 90 * 1000).unref?.();
}

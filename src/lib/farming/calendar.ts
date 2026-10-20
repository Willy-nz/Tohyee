import { createHash, randomBytes } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { googleApp, microsoftApp } from "@/lib/crm/mail/service";
import { exchangeCode, MAIL_PROVIDERS, type MailProvider, mailboxAddress, type ProviderApp, refreshAccess, authorisationUrl } from "@/lib/crm/mail/providers";
import { parseIsoDate } from "@/lib/dates";
import { type Actor, assertOrganisationUsable, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { requireFarming } from "@/lib/farming/paddocks";
import { type FarmMail, FARM_GOOGLE_SCOPES, FARM_MICROSOFT_SCOPES, fetchFarmMail, type FolderListing, listFolderMailIds, listMailFolders, type MailFolder } from "@/lib/farming/mail-providers";
import { type CalendarItem, CALENDAR_KINDS, type ChosenFolder, type CalendarKind, calendarFeed, type FeedEvent, isRepeatDate, type Repeat, repeatDates, REPEATS, teamView } from "@/lib/farming/calendar-shared";
import { type Arrangement, type FarmMailKind, nzDay, readEmail } from "@/lib/farming/mail-rules";
import { RequestLimiter } from "@/lib/ai/limits";
import { coreQuery } from "@/lib/db/transactions";
import { listAllOrganisations } from "@/lib/organisations/admin";
import { getMembership, getOrganisation, type OrganisationRecord, parseOrganisationId } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { optionalString, requireOneOf, requireString } from "@/lib/validation";

export type { CalendarItem, ChosenFolder } from "@/lib/farming/calendar-shared";

/*
 * The farm calendar from email (#319; examples FC1-FC16, decisions
 * 570-572). Each member connects their own Gmail or Microsoft mailbox,
 * read-only; Tohyee reads its emails with fixed rules (mail-rules.ts) and
 * keeps only what each arrangement needs (sender, subject, the sentence, a
 * link). Everything here belongs to the member who connected it: every
 * query is limited to the signed-in member's mailboxes, admins included
 * (decision 571). Network calls happen outside database transactions.
 * Only the folders (Outlook) or labels (Gmail) the member chose are read,
 * and nothing until they choose one (#340; FC25-FC30, decisions 584-586).
 */

export const FARM_MAIL_CALLBACK_PATH = "/api/farming/mail/callback";
export const FARM_MAIL_ACTOR: Actor = { userId: null, email: "farm-mail@tohyee" };
const STATE_MINUTES = 15;
const PAUSE_AFTER_FAILURES = 3;
/** Emails read in one check, new and old together (the rest wait for the next check). */
const MAX_READ_PER_CHECK = 150;
/** Emails listed per chosen folder each check, newest first (FC29). */
export const MAX_IDS_PER_FOLDER = 2000;
/** Folders a mailbox can have chosen. */
const MAX_CHOSEN_FOLDERS = 50;

export type FarmMailbox = {
  id: string;
  provider: MailProvider;
  email: string;
  historyDays: number;
  defaultFarmId: string | null;
  status: "active" | "paused";
  lastCheckAt: string | null;
  lastError: string | null;
  /** Older history is still being read. */
  readingHistory: boolean;
  /** The folders or labels it reads (FC25); none means nothing is read. */
  folders: ChosenFolder[];
  items: number;
  /** Items from it shared with the farm team (they go if it's disconnected). */
  shared: number;
  /** Its member also keeps a private copy of these emails (#250): disconnecting stops that too. */
  privateCopy: boolean;
};

/** Where a mailbox sign-in was started: the farm calendar, or My mail's private copy (#250, decision 610). */
export type MailboxPurpose = "calendar" | "private";


function redirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${FARM_MAIL_CALLBACK_PATH}`;
}

function requireUser(tx: OrgTx): string {
  if (!tx.actor.userId) throw new ForbiddenError("Sign in to use the farm calendar.");
  return tx.actor.userId;
}

async function appFor(tx: OrgTx, provider: MailProvider): Promise<ProviderApp> {
  return provider === "google" ? googleApp(tx) : microsoftApp(tx);
}

function historyDays(input: unknown): number {
  if (input === undefined || input === null || input === "") return 90;
  const value = typeof input === "number" ? input : Number(input);
  if (!Number.isInteger(value) || value < 30 || value > 365) throw new ValidationError("Read back between 30 and 365 days.");
  return value;
}

async function farmIdOrNull(tx: OrgTx, input: unknown): Promise<string | null> {
  if (input === undefined || input === null || input === "") return null;
  const id = String(input);
  if (!/^[1-9][0-9]{0,18}$/.test(id)) throw new ValidationError("Choose a farm.");
  const found = await tx.query("select 1 from farms where id = $1", [id]);
  if (!found.rowCount) throw new NotFoundError("Farm not found.");
  return id;
}

// Connecting (FC1) ---------------------------------------------------------------------------

/** The provider's sign-in address, with a one-time state tied to this member, organisation and choices. */
export async function startFarmMailConnect(
  tx: OrgTx,
  input: { provider: unknown; historyDays?: unknown; defaultFarmId?: unknown },
  origin: string,
  purpose: MailboxPurpose = "calendar",
): Promise<{ url: string }> {
  // My mail checks its member is an Owner before it gets here (decision 611).
  if (purpose === "calendar") await requireFarming(tx);
  const userId = requireUser(tx);
  const provider = requireOneOf(input.provider, "provider", MAIL_PROVIDERS);
  if (!secretsAvailable()) throw new UnavailableError("The server has no TOHYEE_SECRET_KEY, so it can't store mailbox tokens.");
  const app = await appFor(tx, provider);
  const days = historyDays(input.historyDays);
  const farmId = purpose === "calendar" ? await farmIdOrNull(tx, input.defaultFarmId) : null;
  const state = `${tx.organisationId}.${randomBytes(24).toString("base64url")}`;
  await tx.query("delete from farm_mail_states where created_at < now() - interval '1 day'");
  await tx.query("insert into farm_mail_states (state, user_id, provider, history_days, default_farm_id, purpose) values ($1, $2, $3, $4, $5, $6)", [
    state,
    userId,
    provider,
    days,
    farmId,
    purpose,
  ]);
  return { url: authorisationUrl(provider, app, redirectUri(origin), state, provider === "google" ? FARM_GOOGLE_SCOPES : FARM_MICROSOFT_SCOPES) };
}

export type ClaimedFarmState = { provider: MailProvider; historyDays: number; defaultFarmId: string | null; app: ProviderApp; purpose: MailboxPurpose };

/** Checks the state (unused, under 15 minutes old, the same member) and marks it used, before the code is exchanged. */
export async function claimFarmMailState(tx: OrgTx, state: string): Promise<ClaimedFarmState> {
  const found = await tx.query<{
    user_id: string;
    provider: MailProvider;
    history_days: number;
    default_farm_id: string | null;
    fresh: boolean;
    used_at: string | null;
    purpose: MailboxPurpose;
  }>(
    `select user_id, provider, history_days, default_farm_id::text, created_at > now() - make_interval(mins => $2) as fresh, used_at, purpose
       from farm_mail_states where state = $1 for update`,
    [state, STATE_MINUTES],
  );
  const row = found.rows[0];
  if (!row || row.purpose === "calendar") await requireFarming(tx);
  if (!row || row.used_at || !row.fresh || row.user_id !== tx.actor.userId) {
    throw new ValidationError("That sign-in link has expired or was already used. Start connecting again.");
  }
  await tx.query("update farm_mail_states set used_at = now() where state = $1", [state]);
  return { provider: row.provider, historyDays: row.history_days, defaultFarmId: row.default_farm_id, app: await appFor(tx, row.provider), purpose: row.purpose };
}

/** Exchanges the code and finds the mailbox's address (network, no transaction). */
export async function fetchFarmMailConnection(claimed: ClaimedFarmState, code: string, origin: string) {
  const tokens = await exchangeCode(claimed.provider, claimed.app, code, redirectUri(origin), FARM_MICROSOFT_SCOPES);
  if (!tokens.refreshToken) throw new ValidationError("The sign-in didn't allow offline access, so Tohyee can't keep checking. Try connecting again.");
  const email = (await mailboxAddress(claimed.provider, tokens.accessToken)).toLowerCase();
  return { tokens, email };
}

/** Stores the mailbox (tokens encrypted). Reconnecting the same mailbox keeps what was read and starts it again. */
export async function saveFarmMailbox(
  tx: OrgTx,
  claimed: ClaimedFarmState,
  connection: Awaited<ReturnType<typeof fetchFarmMailConnection>>,
  now = new Date(),
): Promise<FarmMailbox> {
  await requireFarming(tx);
  const id = await storeMailboxAccount(tx, claimed, connection, now, true);
  return (await listFarmMailboxes(tx)).find((mailbox) => mailbox.id === id)!;
}

/**
 * Stores a mailbox connection (tokens encrypted) and returns its id. It's
 * one connection whichever screen it was made from (decision 610): the farm
 * calendar reads it when `farmCalendar` (or when it was connected there
 * before); My mail's private copy uses the same one.
 */
export async function storeMailboxAccount(
  tx: OrgTx,
  claimed: ClaimedFarmState,
  connection: Awaited<ReturnType<typeof fetchFarmMailConnection>>,
  now: Date,
  farmCalendar: boolean,
): Promise<string> {
  const userId = requireUser(tx);
  const { tokens, email } = connection;
  const existing = await tx.query<{ id: string; user_id: string }>("select id::text, user_id from farm_mail_accounts where provider = $1 and lower(email) = lower($2)", [claimed.provider, email]);
  if (existing.rows[0] && existing.rows[0].user_id !== userId) throw new ConflictError(`${email} is already connected by someone else in this organisation.`);
  const secrets = [encryptSecret(tokens.refreshToken!), encryptSecret(tokens.accessToken), new Date(now.getTime() + tokens.expiresInSeconds * 1000).toISOString()];
  let id: string;
  if (existing.rows[0]) {
    id = existing.rows[0].id;
    await tx.query(
      `update farm_mail_accounts set refresh_token_ciphertext = $2, access_token_ciphertext = $3, access_token_expires_at = $4,
              status = 'active', failures = 0, last_error = null, farm_calendar = farm_calendar or $5, updated_at = now() where id = $1`,
      [id, ...secrets, farmCalendar],
    );
    // A private copy stopped by failed syncs carries on with the new sign-in (decision 614).
    await tx.query("update private_mail_copies set paused = false, failures = 0, updated_at = now() where account_id = $1 and paused", [id]);
  } else {
    const historyFrom = new Date(now.getTime() - claimed.historyDays * 86_400_000).toISOString();
    const inserted = await tx.query<{ id: string }>(
      `insert into farm_mail_accounts (user_id, provider, email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at,
                                       history_days, history_from, checked_through, backfill_before, default_farm_id, farm_calendar)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11) returning id::text`,
      [userId, claimed.provider, email, ...secrets, claimed.historyDays, historyFrom, now.toISOString(), claimed.defaultFarmId, farmCalendar],
    );
    id = inserted.rows[0].id;
  }
  // Audited without the address: the mailbox is the member's own (decision 571).
  await writeAuditEvent(tx, { eventType: "farming.mailbox_connected", entityType: "farm_mail_account", entityId: id, details: { provider: claimed.provider } });
  return id;
}

// Mailboxes ---------------------------------------------------------------------------------

/** The signed-in member's own farm mailboxes; nobody else's, admins included (FC1). */
export async function listFarmMailboxes(tx: OrgTx): Promise<FarmMailbox[]> {
  await requireFarming(tx);
  const userId = requireUser(tx);
  const rows = await tx.query<{
    id: string;
    provider: MailProvider;
    email: string;
    history_days: number;
    default_farm_id: string | null;
    status: "active" | "paused";
    last_check_at: string | null;
    last_error: string | null;
    backfill_before: string | null;
    items: number;
    shared: number;
    private_copy: boolean;
  }>(
    `select a.id::text, a.provider, a.email, a.history_days, a.default_farm_id::text, a.status, a.last_check_at::text, a.last_error, a.backfill_before::text,
            (select count(*)::int from farm_calendar_items i where i.account_id = a.id and i.state <> 'dismissed') as items,
            (select count(*)::int from farm_calendar_items i where i.account_id = a.id and i.state <> 'dismissed' and i.shared_at is not null) as shared,
            exists (select 1 from private_mail_copies c where c.account_id = a.id and c.owner_user_id = a.user_id and c.copying) as private_copy
       from farm_mail_accounts a where a.user_id = $1 and a.farm_calendar order by a.email`,
    [userId],
  );
  // Gmail's Sent, Drafts, Spam and Trash are for the private copy only (decision 615).
  const folders = await tx.query<{ id: string; account_id: string; external_id: string; name: string; include_subfolders: boolean; missing: boolean }>(
    `select f.id::text, f.account_id::text, f.external_id, f.name, f.include_subfolders, f.missing
       from farm_mail_folders f join farm_mail_accounts a on a.id = f.account_id
      where a.user_id = $1 and not f.private_only order by lower(f.name), f.id`,
    [userId],
  );
  const chosen = (accountId: string): ChosenFolder[] =>
    folders.rows
      .filter((folder) => folder.account_id === accountId)
      .map((folder) => ({ id: folder.id, externalId: folder.external_id, name: folder.name, includeSubfolders: folder.include_subfolders, missing: folder.missing }));
  return rows.rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    email: row.email,
    historyDays: row.history_days,
    defaultFarmId: row.default_farm_id,
    status: row.status,
    lastCheckAt: row.last_check_at,
    lastError: row.last_error,
    readingHistory: row.backfill_before !== null && chosen(row.id).length > 0,
    folders: chosen(row.id),
    items: row.items,
    shared: row.shared,
    privateCopy: row.private_copy,
  }));
}

async function ownMailbox(tx: OrgTx, idInput: unknown): Promise<string> {
  await requireFarming(tx);
  const userId = requireUser(tx);
  const id = typeof idInput === "string" || typeof idInput === "number" ? String(idInput) : "";
  if (!/^[1-9][0-9]{0,18}$/.test(id)) throw new NotFoundError("Mailbox not found.");
  const found = await tx.query("select 1 from farm_mail_accounts where id = $1 and user_id = $2 and farm_calendar", [id, userId]);
  // Someone else's mailbox is "not found" too: it isn't theirs to know about.
  if (!found.rowCount) throw new NotFoundError("Mailbox not found.");
  return id;
}

/** The farm for items that name none, when there's more than one farm (FC11). */
export async function setMailboxFarm(tx: OrgTx, idInput: unknown, farmInput: unknown): Promise<FarmMailbox[]> {
  const id = await ownMailbox(tx, idInput);
  await tx.query("update farm_mail_accounts set default_farm_id = $2, updated_at = now() where id = $1", [id, await farmIdOrNull(tx, farmInput)]);
  return listFarmMailboxes(tx);
}

/** FC15: deletes the tokens and everything read from the mailbox; the mailbox itself is untouched. */
export async function disconnectFarmMailbox(tx: OrgTx, idInput: unknown): Promise<FarmMailbox[]> {
  const id = await ownMailbox(tx, idInput);
  await deleteMailbox(tx, id);
  return listFarmMailboxes(tx);
}

/**
 * Deletes a connection: its tokens, its folder choice and what the farm
 * calendar read. A private copy made from it stays, no longer copying,
 * until its owner deletes it (decision 616).
 */
export async function deleteMailbox(tx: OrgTx, id: string): Promise<void> {
  await tx.query("update farm_calendar_items set replaced_by = null where account_id = $1", [id]);
  await tx.query("delete from farm_mail_accounts where id = $1", [id]);
  await writeAuditEvent(tx, { eventType: "farming.mailbox_disconnected", entityType: "farm_mail_account", entityId: id, details: {} });
}

/** FC15: a member leaving the organisation has their farm mailboxes disconnected. */
export async function disconnectMemberFarmMail(organisation: OrganisationRecord, userId: string): Promise<number> {
  return withOrganisationTransaction(organisation, FARM_MAIL_ACTOR, async (tx) => {
    const ids = await tx.query<{ id: string }>("select id::text from farm_mail_accounts where user_id = $1", [userId]);
    for (const row of ids.rows) await deleteMailbox(tx, row.id);
    // FC20, FC23: their own items (and so what they shared) and their calendar link go too.
    await tx.query("update farm_calendar_items set replaced_by = null where user_id = $1", [userId]);
    await tx.query("delete from farm_calendar_items where user_id = $1", [userId]);
    await tx.query("delete from farm_calendar_links where user_id = $1", [userId]);
    return ids.rows.length;
  });
}

/** "Check now" for one of the member's own mailboxes. */
export async function mailboxForCheck(tx: OrgTx, idInput: unknown): Promise<string> {
  const id = await ownMailbox(tx, idInput);
  const row = await tx.query<{ status: string; folders: number }>(
    "select status, (select count(*)::int from farm_mail_folders f where f.account_id = a.id and not f.private_only) as folders from farm_mail_accounts a where id = $1",
    [id],
  );
  if (row.rows[0].status === "paused") throw new ConflictError("This mailbox is paused after failed checks. Connect it again to start checking.");
  if (row.rows[0].folders === 0) throw new ConflictError("Choose the folders Tohyee reads first: nothing is read until you do.");
  return id;
}

// Folders (FC25-FC30) -----------------------------------------------------------------------------

/** One of the member's own mailboxes, to list or choose its folders. */
export async function mailboxForFolders(tx: OrgTx, idInput: unknown): Promise<string> {
  return ownMailbox(tx, idInput);
}

/**
 * FC25: the mailbox's folders (Outlook) or labels (Gmail) to choose from,
 * fetched from the mailbox now (names and ids only, no email), and the ones
 * chosen. The route checks it's the member's own first.
 */
export async function mailboxFolderChoices(organisation: OrganisationRecord, accountId: string, now = new Date()): Promise<MailFolder[]> {
  const { account, app } = await loadAccount(organisation, accountId, false);
  const { token, refreshed } = await accessToken(account, app, now);
  if (refreshed) await storeRefreshed(organisation, account.id, refreshed, now);
  return listMailFolders(account.provider, token);
}

/** A connection as My mail's private copy reads it (#250): no Farming needed. The caller has checked whose it is. */
export type MailboxAccess = {
  id: string;
  userId: string;
  provider: MailProvider;
  email: string;
  status: "active" | "paused";
  historyFrom: string;
  /** Every chosen folder, the private-only ones included. */
  folders: Array<{ id: string; externalId: string; includeSubfolders: boolean; privateOnly: boolean }>;
};

async function loadMailboxAccess(organisation: OrganisationRecord, accountId: string) {
  return withOrganisationTransaction(organisation, FARM_MAIL_ACTOR, async (tx) => {
    const found = await tx.query<AccountRow & { status: "active" | "paused" }>(
      `select id::text, user_id, provider, email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at::text,
              history_from::text, checked_through::text, backfill_before::text, default_farm_id::text, farm_calendar, status
         from farm_mail_accounts where id = $1`,
      [accountId],
    );
    const account = found.rows[0];
    if (!account) throw new NotFoundError("Mailbox not found.");
    const folders = await tx.query<{ id: string; external_id: string; include_subfolders: boolean; private_only: boolean }>(
      "select id::text, external_id, include_subfolders, private_only from farm_mail_folders where account_id = $1 order by farm_mail_folders.id",
      [accountId],
    );
    return { account, folders: folders.rows, app: await appFor(tx, account.provider) };
  });
}

/**
 * The connection and a working access token, refreshed and stored when it
 * had expired (network outside any transaction). For My mail's private copy.
 */
export async function mailboxAccessToken(organisation: OrganisationRecord, accountId: string, now = new Date()): Promise<{ access: MailboxAccess; token: string }> {
  const { account, folders, app } = await loadMailboxAccess(organisation, accountId);
  const { token, refreshed } = await accessToken(account, app, now);
  if (refreshed) await storeRefreshed(organisation, account.id, refreshed, now);
  return {
    token,
    access: {
      id: account.id,
      userId: account.user_id,
      provider: account.provider,
      email: account.email,
      status: account.status,
      historyFrom: account.history_from,
      folders: folders.map((folder) => ({ id: folder.id, externalId: folder.external_id, includeSubfolders: folder.include_subfolders, privateOnly: folder.private_only })),
    },
  };
}

/**
 * FC25, FC26, FC27: the folders the mailbox reads, from `available` (as the
 * mailbox listed them just now). A folder taken off stops being read, and
 * everything taken from it alone is deleted now (FC27). Choosing none stops
 * reading altogether. Newly chosen folders are read at the next check, back
 * to the mailbox's read-back date.
 */
export async function chooseMailboxFolders(tx: OrgTx, idInput: unknown, input: unknown, available: MailFolder[]): Promise<FarmMailbox[]> {
  const id = await ownMailbox(tx, idInput);
  await saveFolderChoice(tx, id, input, available, "calendar");
  return listFarmMailboxes(tx);
}

/**
 * The one folder choice of a connection (#340, #250; decision 610), saved
 * from the farm calendar ("calendar": Gmail's private-only labels, which it
 * never offers, are left as they are) or from My mail ("all"). The caller
 * has checked the connection is the signed-in member's own.
 */
export async function saveFolderChoice(tx: OrgTx, id: string, input: unknown, available: MailFolder[], scope: "calendar" | "all"): Promise<void> {
  if (!Array.isArray(input)) throw new ValidationError("Choose the folders to read.");
  if (input.length > MAX_CHOSEN_FOLDERS) throw new ValidationError(`Choose at most ${MAX_CHOSEN_FOLDERS} folders.`);
  const wanted = new Map<string, boolean>();
  for (const entry of input as Array<{ id?: unknown; includeSubfolders?: unknown }>) {
    const externalId = typeof entry?.id === "string" ? entry.id : "";
    if (!externalId || !available.some((folder) => folder.id === externalId)) throw new ValidationError("That folder isn't in the mailbox any more. Open the list again.");
    wanted.set(externalId, entry.includeSubfolders === true);
  }
  const existing = await tx.query<{ id: string; external_id: string }>(
    `select id::text, external_id from farm_mail_folders where account_id = $1 ${scope === "calendar" ? "and not private_only" : ""} for update`,
    [id],
  );
  const removed = existing.rows.filter((row) => !wanted.has(row.external_id)).map((row) => row.id);
  if (removed.length) await removeFolders(tx, id, removed);
  let added = 0;
  for (const [externalId, includeSubfolders] of wanted) {
    const folder = available.find((entry) => entry.id === externalId)!;
    const saved = await tx.query<{ inserted: boolean }>(
      `insert into farm_mail_folders (account_id, external_id, name, include_subfolders, private_only) values ($1, $2, $3, $4, $5)
       on conflict (account_id, external_id) do update set name = excluded.name, include_subfolders = excluded.include_subfolders, missing = false, private_only = excluded.private_only
       returning (xmax = 0) as inserted`,
      [id, externalId, folder.path.slice(0, 500), includeSubfolders, folder.privateOnly === true],
    );
    if (saved.rows[0].inserted) added += 1;
  }
  // New folders are read from the read-back date at the next check.
  if (added) await tx.query("update farm_mail_accounts set backfill_before = coalesce(backfill_before, now()), updated_at = now() where id = $1", [id]);
  // Audited by count only: folder names are private (decision 571).
  await writeAuditEvent(tx, { eventType: "farming.mailbox_folders_chosen", entityType: "farm_mail_account", entityId: id, details: { folders: wanted.size, added, removed: removed.length } });
}

/** FC27: takes folders off a mailbox, deleting what was taken only from them. */
async function removeFolders(tx: OrgTx, accountId: string, folderIds: string[]): Promise<void> {
  const emptied = await tx.query<{ external_id: string; empty: boolean }>(
    `update farm_mail_seen set folder_ids = array(select unnest(folder_ids) except select unnest($2::bigint[]))
      where account_id = $1 and folder_ids && $2::bigint[]
      returning external_id, cardinality(folder_ids) = 0 as empty`,
    [accountId, folderIds],
  );
  // RETURNING gives the new row, so "empty" is after the folders were taken off.
  const gone = emptied.rows.filter((row) => row.empty).map((row) => row.external_id);
  if (gone.length) await dropEmails(tx, accountId, gone);
  // The private copy forgets them the same way (PM6, decision 614).
  const copied = await tx.query<{ id: string; empty: boolean }>(
    `update private_mail_messages m set folder_ids = array(select unnest(m.folder_ids) except select unnest($2::bigint[]))
       from private_mail_copies c
      where c.id = m.copy_id and c.account_id = $1 and m.folder_ids && $2::bigint[]
      returning m.id::text, cardinality(m.folder_ids) = 0 as empty`,
    [accountId, folderIds],
  );
  const uncopied = copied.rows.filter((row) => row.empty).map((row) => row.id);
  if (uncopied.length) await tx.query("delete from private_mail_messages where id = any($1::bigint[])", [uncopied]);
  await tx.query("delete from farm_mail_folders where account_id = $1 and id = any($2::bigint[])", [accountId, folderIds]);
}

/**
 * FC27, FC28: forgets emails as if they had never been read: their items
 * go (shared ones too), what they did to earlier items is undone (a move or
 * cancellation), and emails that only noted a deleted item are read again.
 */
async function dropEmails(tx: OrgTx, accountId: string, externalIds: string[]): Promise<void> {
  if (!externalIds.length) return;
  const gone = await tx.query<{ id: string; also: string[] }>(
    "select id::text, also_seen_external_ids as also from farm_calendar_items where account_id = $1 and external_id = any($2::text[])",
    [accountId, externalIds],
  );
  const goneIds = gone.rows.map((row) => row.id);
  // Earlier items they moved or cancelled are as they were before.
  await tx.query(
    `update farm_calendar_items set state = 'open', state_note = null, replaced_by = null, updated_at = now()
      where state = 'moved' and replaced_by = any($1::bigint[]) and not (id = any($1::bigint[]))`,
    [goneIds],
  );
  await tx.query(
    `update farm_calendar_items set state = 'open', state_note = null, cancelled_by_external_id = null, updated_at = now()
      where account_id = $1 and state = 'cancelled' and cancelled_by_external_id = any($2::text[])`,
    [accountId, externalIds],
  );
  // Other items stop counting them as another mention (FC9).
  await tx.query(
    `update farm_calendar_items
        set also_seen = greatest(0, also_seen - cardinality(array(select unnest(also_seen_external_ids) intersect select unnest($2::text[])))),
            also_seen_external_ids = array(select unnest(also_seen_external_ids) except select unnest($2::text[])), updated_at = now()
      where account_id = $1 and also_seen_external_ids && $2::text[]`,
    [accountId, externalIds],
  );
  // An email that only added to a deleted item is read again, so it can make its own.
  const reread = gone.rows.flatMap((row) => row.also).filter((external) => !externalIds.includes(external));
  if (reread.length) await tx.query("delete from farm_mail_seen where account_id = $1 and external_id = any($2::text[])", [accountId, reread]);
  await tx.query("update farm_calendar_items set replaced_by = null where replaced_by = any($1::bigint[])", [goneIds]);
  await tx.query("delete from farm_calendar_items where id = any($1::bigint[])", [goneIds]);
  await tx.query("delete from farm_mail_seen where account_id = $1 and external_id = any($2::text[])", [accountId, externalIds]);
}

// Reading (FC2-FC12) -------------------------------------------------------------------------

type AccountRow = {
  id: string;
  user_id: string;
  provider: MailProvider;
  email: string;
  refresh_token_ciphertext: string;
  access_token_ciphertext: string | null;
  access_token_expires_at: string | null;
  history_from: string;
  checked_through: string;
  backfill_before: string | null;
  default_farm_id: string | null;
  farm_calendar: boolean;
};

type ItemRow = { id: string; kind: FarmMailKind; title: string; item_date: string | null; thread_id: string | null; sender_email: string; checked_at: string | null };

function shortDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * The earlier item an email moves or cancels (FC7, FC8): the latest one of
 * the same kind in the same conversation, else from the same sender and
 * still to come (for a cancellation with a date, that date first).
 */
async function earlierItem(tx: OrgTx, accountId: string, mail: FarmMail, arrangement: Arrangement): Promise<ItemRow | null> {
  const columns = "id::text, kind, title, item_date::text, thread_id, sender_email, checked_at::text";
  const base = "account_id = $1 and kind = $2 and state = 'open' and change <> 'cancelled' and external_id <> $3";
  if (mail.threadId) {
    const inThread = await tx.query<ItemRow>(`select ${columns} from farm_calendar_items where ${base} and thread_id = $4 order by sent_at desc, farm_calendar_items.id desc limit 1`, [
      accountId,
      arrangement.kind,
      mail.externalId,
      mail.threadId,
    ]);
    if (inThread.rows[0]) return inThread.rows[0];
  }
  const fromSender = await tx.query<ItemRow>(
    `select ${columns} from farm_calendar_items where ${base} and lower(sender_email) = lower($4) and item_date >= $5
      order by ($6::date is not null and item_date = $6) desc, sent_at desc, farm_calendar_items.id desc limit 1`,
    [accountId, arrangement.kind, mail.externalId, mail.from.email, nzDay(mail.sentAt), arrangement.change === "cancelled" ? arrangement.date : null],
  );
  return fromSender.rows[0] ?? null;
}

async function farmFor(tx: OrgTx, account: AccountRow, arrangement: Arrangement): Promise<string | null> {
  if (arrangement.farmIds.length === 1) return arrangement.farmIds[0];
  if (arrangement.farmIds.length > 1) return null;
  const active = await tx.query<{ id: string }>("select id::text from farms where is_active order by farms.id limit 2");
  if (active.rows.length === 1) return active.rows[0].id;
  return account.default_farm_id;
}

async function insertItem(tx: OrgTx, account: AccountRow, mail: FarmMail, arrangement: Arrangement, reasons: string[]): Promise<string> {
  const inserted = await tx.query<{ id: string }>(
    `insert into farm_calendar_items (account_id, external_id, thread_id, sent_at, sender_email, sender_name, subject, web_link, kind, title,
                                      item_date, start_time, end_time, tentative, change, check_reasons, farm_id, excerpt, user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) returning id::text`,
    [
      account.id,
      mail.externalId,
      mail.threadId,
      mail.sentAt,
      mail.from.email,
      mail.from.name,
      mail.subject,
      mail.webLink,
      arrangement.kind,
      arrangement.title.slice(0, 200),
      arrangement.date,
      arrangement.startTime,
      arrangement.endTime,
      arrangement.tentative,
      arrangement.change,
      reasons,
      await farmFor(tx, account, arrangement),
      arrangement.excerpt,
      account.user_id,
    ],
  );
  return inserted.rows[0].id;
}

/** Applies one email's arrangements (FC7-FC9). */
async function applyMail(tx: OrgTx, account: AccountRow, mail: FarmMail, farms: Array<{ id: string; name: string }>): Promise<number> {
  let made = 0;
  for (const arrangement of readEmail({ subject: mail.subject, text: mail.text, sentAt: mail.sentAt, farms })) {
    const reasons = [...arrangement.checkReasons];
    if (arrangement.change === "new" && arrangement.date) {
      // FC9: the same kind on the same date from the same sender or conversation is made once.
      const same = await tx.query<{ id: string }>(
        `select id::text from farm_calendar_items where account_id = $1 and kind = $2 and item_date = $3 and state = 'open' and change <> 'cancelled'
            and (lower(sender_email) = lower($4) or ($5::text is not null and thread_id = $5)) limit 1`,
        [account.id, arrangement.kind, arrangement.date, mail.from.email, mail.threadId],
      );
      if (same.rows[0]) {
        await tx.query("update farm_calendar_items set also_seen = also_seen + 1, also_seen_external_ids = array_append(also_seen_external_ids, $2), updated_at = now() where id = $1", [
          same.rows[0].id,
          mail.externalId,
        ]);
        continue;
      }
    }
    if (arrangement.change === "moved" || arrangement.change === "cancelled") {
      const earlier = await earlierItem(tx, account.id, mail, arrangement);
      const sentDay = shortDay(nzDay(mail.sentAt));
      if (!earlier) {
        reasons.push(arrangement.change === "moved" ? "Says a booking moved, but there's no earlier one to replace" : "Says a booking is cancelled, but there's nothing to cancel");
      } else if (earlier.checked_at) {
        // FC14: what the member checked isn't changed by a later email.
        reasons.push(
          `Would ${arrangement.change === "moved" ? "move" : "cancel"} "${earlier.title}"${earlier.item_date ? ` on ${shortDay(earlier.item_date)}` : ""}, which you've checked`,
        );
      } else if (arrangement.change === "cancelled") {
        await tx.query("update farm_calendar_items set state = 'cancelled', state_note = $2, cancelled_by_external_id = $3, updated_at = now() where id = $1", [
          earlier.id,
          `Cancelled by an email on ${sentDay}`,
          mail.externalId,
        ]);
        made += 1;
        continue;
      } else {
        const id = await insertItem(tx, account, mail, arrangement, reasons);
        await tx.query("update farm_calendar_items set state = 'moved', state_note = $2, replaced_by = $3, updated_at = now() where id = $1", [
          earlier.id,
          arrangement.date ? `Moved to ${shortDay(arrangement.date)}` : "Moved",
          id,
        ]);
        made += 1;
        continue;
      }
    }
    await insertItem(tx, account, mail, arrangement, reasons);
    made += 1;
  }
  return made;
}

async function accessToken(account: AccountRow, app: ProviderApp, now: Date) {
  if (account.access_token_ciphertext && account.access_token_expires_at && new Date(account.access_token_expires_at).getTime() > now.getTime() + 60_000) {
    return { token: decryptSecret(account.access_token_ciphertext), refreshed: null };
  }
  const refreshed = await refreshAccess(account.provider, app, decryptSecret(account.refresh_token_ciphertext), FARM_MICROSOFT_SCOPES);
  return { token: refreshed.accessToken, refreshed };
}

type Refreshed = Awaited<ReturnType<typeof refreshAccess>>;

function refreshedValues(refreshed: Refreshed | null, now: Date): [string | null, string | null, string | null] {
  return [
    refreshed ? encryptSecret(refreshed.accessToken) : null,
    refreshed ? new Date(now.getTime() + refreshed.expiresInSeconds * 1000).toISOString() : null,
    refreshed?.refreshToken ? encryptSecret(refreshed.refreshToken) : null,
  ];
}

async function storeRefreshed(organisation: OrganisationRecord, accountId: string, refreshed: Refreshed, now: Date): Promise<void> {
  await withOrganisationTransaction(organisation, FARM_MAIL_ACTOR, (tx) =>
    tx.query(
      `update farm_mail_accounts set access_token_ciphertext = coalesce($2, access_token_ciphertext), access_token_expires_at = coalesce($3, access_token_expires_at),
              refresh_token_ciphertext = coalesce($4, refresh_token_ciphertext), updated_at = now() where id = $1`,
      [accountId, ...refreshedValues(refreshed, now)],
    ),
  );
}

type FolderRow = { id: string; external_id: string; include_subfolders: boolean };

async function loadAccount(organisation: OrganisationRecord, accountId: string, activeOnly: boolean) {
  return withOrganisationTransaction(organisation, FARM_MAIL_ACTOR, async (tx) => {
    await requireFarming(tx);
    const found = await tx.query<AccountRow>(
      `select id::text, user_id, provider, email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at::text,
              history_from::text, checked_through::text, backfill_before::text, default_farm_id::text, farm_calendar
         from farm_mail_accounts where id = $1 ${activeOnly ? "and status = 'active'" : ""}`,
      [accountId],
    );
    const account = found.rows[0];
    if (!account) throw new NotFoundError("Mailbox not found.");
    // The farm calendar never reads Gmail's private-only labels (decision 615).
    const folders = await tx.query<FolderRow>(
      "select id::text, external_id, include_subfolders from farm_mail_folders where account_id = $1 and not private_only order by farm_mail_folders.id",
      [accountId],
    );
    return { account, folders: folders.rows, app: await appFor(tx, account.provider) };
  });
}

/**
 * Checks one mailbox (FC9, FC26-FC29): lists each chosen folder's emails
 * back to the read-back date, newest first; reads the ones not read yet
 * (at most 150 a check, the rest next time); and drops emails that are no
 * longer in any chosen folder, with what was taken from them. Each email
 * is read once while it stays in a chosen folder. With no folder chosen,
 * nothing is read and nothing is asked of the mailbox.
 */
export async function checkFarmMailbox(organisation: OrganisationRecord, accountId: string, now = new Date()): Promise<{ read: number; items: number }> {
  const { account, folders, app } = await loadAccount(organisation, accountId, true);
  // A mailbox connected only from My mail isn't read for the farm calendar (decision 610).
  if (folders.length === 0 || !account.farm_calendar) return { read: 0, items: 0 };
  try {
    const { token, refreshed } = await accessToken(account, app, now);
    // Gmail's labels once a check: which still exist, and their sublabels.
    const labels = account.provider === "google" ? await listMailFolders(account.provider, token) : null;
    const listings: Array<{ folder: FolderRow; listing: FolderListing }> = [];
    for (const folder of folders) {
      listings.push({ folder, listing: await listFolderMailIds(account.provider, token, { externalId: folder.external_id, includeSubfolders: folder.include_subfolders }, new Date(account.history_from), MAX_IDS_PER_FOLDER, labels) });
    }
    // Which chosen folders each listed email is in, newest first per folder.
    const inFolders = new Map<string, Set<string>>();
    for (const { folder, listing } of listings) {
      for (const id of listing.ids) inFolders.set(id, (inFolders.get(id) ?? new Set()).add(folder.id));
    }
    const listed = [...inFolders.keys()];
    const seen = await withOrganisationTransaction(organisation, FARM_MAIL_ACTOR, async (tx) => {
      const rows = await tx.query<{ external_id: string; sent_at: string }>("select external_id, sent_at::text from farm_mail_seen where account_id = $1 and external_id = any($2::text[])", [
        account.id,
        listed,
      ]);
      return new Map(rows.rows.map((row) => [row.external_id, row.sent_at]));
    });
    /*
     * FC28: an email read before and no longer listed has left the chosen
     * folders, and is dropped. When a folder has more emails than are
     * listed, only emails newer than the oldest listed one it had read
     * (less a day, as Gmail and Outlook date emails a little differently)
     * can be known to have left.
     */
    let dropAfter: string | null = null;
    let dropNone = false;
    for (const { listing } of listings) {
      if (listing.complete) continue;
      const dates = listing.ids.map((id) => seen.get(id)).filter((date): date is string => Boolean(date));
      if (!dates.length) {
        dropNone = true;
        continue;
      }
      const oldest = new Date(new Date(dates.reduce((a, b) => (a < b ? a : b))).getTime() + 86_400_000).toISOString();
      if (dropAfter === null || oldest > dropAfter) dropAfter = oldest;
    }
    let budget = MAX_READ_PER_CHECK;
    let unread = 0;
    const mails: FarmMail[] = [];
    const seenOnly: string[] = [];
    for (const id of listed) {
      if (seen.has(id)) continue;
      if (budget <= 0) {
        unread += 1;
        continue;
      }
      budget -= 1;
      const mail = await fetchFarmMail(account.provider, token, id, account.email);
      if (mail) mails.push(mail);
      else seenOnly.push(id);
    }
    return await withOrganisationTransaction(organisation, FARM_MAIL_ACTOR, async (tx) => {
      // Folders taken off while this check ran don't count.
      const current = new Set((await tx.query<{ id: string }>("select id::text from farm_mail_folders where account_id = $1 and not private_only", [account.id])).rows.map((row) => row.id));
      const foldersOf = (id: string) => [...(inFolders.get(id) ?? [])].filter((folder) => current.has(folder));
      for (const { folder, listing } of listings) {
        await tx.query("update farm_mail_folders set missing = $2 where id = $1", [folder.id, listing.missing]);
      }
      if (!dropNone) {
        const left = await tx.query<{ external_id: string }>(
          `select external_id from farm_mail_seen
            where account_id = $1 and not (external_id = any($2::text[])) and ($3::timestamptz is null or sent_at > $3::timestamptz)`,
          [account.id, listed, dropAfter],
        );
        await dropEmails(tx, account.id, left.rows.map((row) => row.external_id));
      }
      // Emails still listed keep which chosen folders they're in (FC27).
      for (const id of listed) {
        if (seen.has(id)) await tx.query("update farm_mail_seen set folder_ids = $3::bigint[] where account_id = $1 and external_id = $2", [account.id, id, foldersOf(id)]);
      }
      const farms = (await tx.query<{ id: string; name: string }>("select id::text, name from farms where is_active order by farms.id")).rows;
      let items = 0;
      let read = 0;
      for (const mail of mails.sort((a, b) => a.sentAt.localeCompare(b.sentAt))) {
        const folderIds = foldersOf(mail.externalId);
        if (!folderIds.length) continue;
        const marked = await tx.query("insert into farm_mail_seen (account_id, external_id, sent_at, folder_ids) values ($1, $2, $3, $4::bigint[]) on conflict do nothing", [
          account.id,
          mail.externalId,
          mail.sentAt,
          folderIds,
        ]);
        if (!marked.rowCount) continue;
        read += 1;
        items += await applyMail(tx, account, mail, farms);
      }
      for (const id of seenOnly) {
        const folderIds = foldersOf(id);
        if (!folderIds.length) continue;
        await tx.query("insert into farm_mail_seen (account_id, external_id, sent_at, folder_ids) values ($1, $2, $3, $4::bigint[]) on conflict do nothing", [account.id, id, now.toISOString(), folderIds]);
      }
      const checkedThrough = now.toISOString() > account.checked_through ? now.toISOString() : account.checked_through;
      await tx.query(
        `update farm_mail_accounts
            set checked_through = $2, backfill_before = $3, last_check_at = $4, last_error = null, failures = 0,
                access_token_ciphertext = coalesce($5, access_token_ciphertext), access_token_expires_at = coalesce($6, access_token_expires_at),
                refresh_token_ciphertext = coalesce($7, refresh_token_ciphertext), updated_at = now()
          where id = $1`,
        [account.id, checkedThrough, unread > 0 ? (account.backfill_before ?? now.toISOString()) : null, now.toISOString(), ...refreshedValues(refreshed, now)],
      );
      return { read, items };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withOrganisationTransaction(organisation, FARM_MAIL_ACTOR, (tx) =>
      tx.query(
        `update farm_mail_accounts
            set failures = failures + 1, last_error = $2, last_check_at = $3,
                status = case when failures + 1 >= $4 then 'paused' else status end, updated_at = now()
          where id = $1`,
        [account.id, message.slice(0, 500), now.toISOString(), PAUSE_AFTER_FAILURES],
      ),
    );
    throw error;
  }
}

let running = false;

/** Checks every active farm mailbox on the server, one at a time (every 15 minutes). */
export async function checkAllFarmMail(): Promise<{ checked: number; failed: number }> {
  if (running || !secretsAvailable()) return { checked: 0, failed: 0 };
  running = true;
  let checked = 0;
  let failed = 0;
  try {
    for (const organisation of await listAllOrganisations()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      let ids: string[] = [];
      try {
        ids = await withOrganisationTransaction(organisation, FARM_MAIL_ACTOR, async (tx) => {
          const on = await tx.query<{ enabled: boolean }>("select enabled from farming_settings where id = true");
          if (on.rows[0]?.enabled !== true) return [];
          // FC25: a mailbox with no folder chosen isn't read at all.
          return (
            await tx.query<{ id: string }>(
              `select a.id::text from farm_mail_accounts a
                where a.status = 'active' and a.farm_calendar and exists (select 1 from farm_mail_folders f where f.account_id = a.id and not f.private_only)
                order by a.last_check_at nulls first, a.id`,
            )
          ).rows.map((row) => row.id);
        });
      } catch {
        continue;
      }
      for (const id of ids) {
        try {
          await checkFarmMailbox(organisation, id);
          checked += 1;
        } catch (error) {
          failed += 1;
          console.warn(`[tohyee] Farm mail check failed for ${organisation.id} mailbox ${id}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    return { checked, failed };
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startFarmMailScheduler(): void {
  if (timer) return;
  const tick = () => {
    checkAllFarmMail()
      .catch((error) => console.warn("[tohyee] Farm mail scheduler:", error))
      // Then the private copies (#250, decision 614), on the same 15 minutes.
      .then(() => import("@/lib/private-mail/sync"))
      .then((sync) => sync.syncAllPrivateMail())
      .catch(() => console.warn("[tohyee] Private mail sync stopped early."));
  };
  timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 3 * 60 * 1000).unref?.();
}

// The calendar (FC13, FC14, FC17-FC21) -------------------------------------------------------------

type CalendarRow = {
  id: string;
  user_id: string;
  source: "email" | "own";
  account_id: string | null;
  kind: CalendarKind;
  title: string;
  item_date: string | null;
  start_time: string | null;
  end_time: string | null;
  tentative: boolean;
  change: "new" | "moved" | "cancelled";
  state: CalendarItem["state"];
  state_note: string | null;
  check_reasons: string[];
  checked_at: string | null;
  farm_id: string | null;
  farm_name: string | null;
  sender_email: string | null;
  sender_name: string | null;
  subject: string | null;
  excerpt: string | null;
  web_link: string | null;
  sent_at: string | null;
  also_seen: number;
  notes: string | null;
  repeat: Repeat | null;
  repeat_until: string | null;
  repeat_skips: string[];
  shared_at: string | null;
  shared_by_name: string | null;
  updated_at: string;
};

const ITEM_COLUMNS = `i.id::text, i.user_id::text, i.source, i.account_id::text, i.kind, i.title, i.item_date::text, to_char(i.start_time, 'HH24:MI') as start_time,
       to_char(i.end_time, 'HH24:MI') as end_time, i.tentative, i.change, i.state, i.state_note, i.check_reasons, i.checked_at::text,
       i.farm_id::text, f.name as farm_name, i.sender_email, i.sender_name, i.subject, i.excerpt, i.web_link, i.sent_at::text, i.also_seen,
       i.notes, i.repeat, i.repeat_until::text, i.repeat_skips::text[] as repeat_skips, i.shared_at::text, i.shared_by_name, i.updated_at::text`;

const NEEDS_CHECKING = "(i.state = 'open' and i.checked_at is null and (i.item_date is null or cardinality(i.check_reasons) > 0))";

/** FC21: the member's own items, and what others shared; hidden ones aren't shown. */
const VISIBLE = "(i.user_id = $1 or i.shared_at is not null) and i.state <> 'dismissed'";

/** One item as `viewer` may see it (FC20): someone else's is only what the team sees. `date` is a repeat's date. */
function toItem(row: CalendarRow, viewer: string, date: string | null = row.item_date): CalendarItem {
  const needsChecking = row.state === "open" && row.checked_at === null && (row.item_date === null || row.check_reasons.length > 0);
  const item: CalendarItem = {
    id: row.id,
    key: row.repeat && date ? `${row.id}@${date}` : row.id,
    source: row.source,
    mine: true,
    mailboxId: row.account_id,
    kind: row.kind,
    title: row.title,
    date,
    startTime: row.start_time,
    endTime: row.end_time,
    tentative: row.tentative,
    change: row.change,
    state: row.state,
    stateNote: row.state_note,
    checkReasons: row.check_reasons,
    needsChecking,
    checked: row.checked_at !== null,
    farmId: row.farm_id,
    farmName: row.farm_name,
    senderEmail: row.sender_email,
    senderName: row.sender_name,
    subject: row.subject,
    excerpt: row.excerpt,
    webLink: row.web_link,
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    alsoSeen: row.also_seen,
    notes: row.notes,
    repeat: row.repeat,
    repeatFrom: row.repeat ? row.item_date : null,
    repeatUntil: row.repeat_until,
    repeatSkips: row.repeat_skips,
    shared: row.shared_at !== null,
    sharedByName: row.shared_by_name,
  };
  return row.user_id === viewer ? item : teamView(item, row.shared_by_name);
}

export type CalendarFilter = { farmId?: unknown; sender?: unknown };

function filters(input: CalendarFilter, params: unknown[]): string {
  let sql = "";
  if (input.farmId === "none") sql += " and i.farm_id is null";
  else if (input.farmId !== undefined && input.farmId !== null && input.farmId !== "") {
    params.push(String(input.farmId));
    sql += ` and i.farm_id::text = $${params.length}`;
  }
  if (typeof input.sender === "string" && input.sender.trim()) {
    // Only the member's own items: a shared item's sender isn't theirs to filter by (FC21).
    params.push(input.sender.trim().toLowerCase());
    sql += ` and i.user_id = $1 and lower(i.sender_email) = $${params.length}`;
  }
  return sql;
}

/** Items (and each repeat's dates) from `from` to `to`, as `userId` sees them. */
async function itemsInRange(tx: OrgTx, userId: string, from: string, to: string, input: CalendarFilter = {}, extra = ""): Promise<CalendarItem[]> {
  const params: unknown[] = [userId, from, to];
  const rows = await tx.query<CalendarRow>(
    `select ${ITEM_COLUMNS} from farm_calendar_items i left join farms f on f.id = i.farm_id
      where ${VISIBLE} ${extra}
        and ((i.repeat is null and i.item_date between $2 and $3)
             or (i.repeat is not null and i.item_date <= $3 and (i.repeat_until is null or i.repeat_until >= $2)))
        ${filters(input, params)}`,
    params,
  );
  const items: CalendarItem[] = [];
  for (const row of rows.rows) {
    if (!row.repeat) items.push(toItem(row, userId));
    else for (const date of repeatDates(row.item_date!, row.repeat, row.repeat_until, row.repeat_skips, from, to)) items.push(toItem(row, userId, date));
  }
  return items.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || (a.startTime ?? "").localeCompare(b.startTime ?? "") || Number(a.id) - Number(b.id));
}

/**
 * The calendar from `from` to `to` (FC13, FC21): the member's own items with
 * a date in the range and those others shared (dismissed ones aren't
 * shown), each repeat's dates, and the senders and farms to filter by.
 */
export async function farmCalendar(
  tx: OrgTx,
  input: { from: unknown; to: unknown } & CalendarFilter,
): Promise<{ items: CalendarItem[]; needsChecking: number; senders: Array<{ email: string; name: string | null }> }> {
  await requireFarming(tx);
  const userId = requireUser(tx);
  const from = parseIsoDate(input.from, "From");
  const to = parseIsoDate(input.to, "To");
  if (to < from) throw new ValidationError("To can't be before from.");
  if (Date.parse(to) - Date.parse(from) > 400 * 86_400_000) throw new ValidationError("Show at most a year at a time.");
  const items = await itemsInRange(tx, userId, from, to, input);
  const count = await tx.query<{ n: number }>(`select count(*)::int as n from farm_calendar_items i where i.user_id = $1 and ${NEEDS_CHECKING}`, [userId]);
  const senders = await tx.query<{ email: string; name: string | null }>(
    `select distinct on (lower(i.sender_email)) lower(i.sender_email) as email, i.sender_name as name
       from farm_calendar_items i
      where i.user_id = $1 and i.sender_email is not null and i.state <> 'dismissed' order by lower(i.sender_email), i.sent_at desc`,
    [userId],
  );
  return { items, needsChecking: count.rows[0].n, senders: senders.rows };
}

/** Needs checking (FC4, FC6, FC10, FC13): the member's own, oldest email first. */
export async function itemsToCheck(tx: OrgTx, input: CalendarFilter = {}): Promise<CalendarItem[]> {
  await requireFarming(tx);
  const userId = requireUser(tx);
  const params: unknown[] = [userId];
  const rows = await tx.query<CalendarRow>(
    `select ${ITEM_COLUMNS} from farm_calendar_items i left join farms f on f.id = i.farm_id
      where i.user_id = $1 and ${NEEDS_CHECKING} ${filters(input, params)} order by i.sent_at, i.id limit 500`,
    params,
  );
  return rows.rows.map((row) => toItem(row, userId));
}

function itemId(idInput: unknown): string {
  const id = typeof idInput === "string" || typeof idInput === "number" ? String(idInput) : "";
  if (!/^[1-9][0-9]{0,18}$/.test(id)) throw new NotFoundError("Calendar item not found.");
  return id;
}

/** One of the member's own items; someone else's (shared or not) is "not found" to change. */
async function ownItem(tx: OrgTx, idInput: unknown): Promise<CalendarRow> {
  await requireFarming(tx);
  const userId = requireUser(tx);
  const rows = await tx.query<CalendarRow>(
    `select ${ITEM_COLUMNS} from farm_calendar_items i left join farms f on f.id = i.farm_id
      where i.id = $1 and i.user_id = $2 for update of i`,
    [itemId(idInput), userId],
  );
  if (!rows.rows[0]) throw new NotFoundError("Calendar item not found.");
  return rows.rows[0];
}

async function ownItemShown(tx: OrgTx, id: string): Promise<CalendarItem> {
  return toItem(await ownItem(tx, id), requireUser(tx));
}

function timeOrNull(input: unknown, label: string): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input)) throw new ValidationError(`${label} must be a time like 09:30.`);
  return input;
}

type ItemInput = {
  date?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  kind?: unknown;
  title?: unknown;
  farmId?: unknown;
  notes?: unknown;
  repeat?: unknown;
  repeatUntil?: unknown;
};

type ItemValues = {
  date: string;
  startTime: string | null;
  endTime: string | null;
  kind: CalendarKind;
  title: string;
  farmId: string | null;
  notes: string | null;
  repeat: Repeat | null;
  repeatUntil: string | null;
};

/** The fields as given, or as they were (FC14, FC17, FC18). */
async function itemValues(tx: OrgTx, input: ItemInput, was: Partial<CalendarRow> = {}): Promise<ItemValues> {
  const date = input.date === undefined ? (was.item_date ?? null) : input.date === null || input.date === "" ? null : parseIsoDate(input.date, "Date");
  if (!date) throw new ValidationError(was.source === "email" ? 'Give it a date, or hide it with "Not a farm arrangement".' : "Give it a date.");
  const startTime = input.startTime === undefined ? (was.start_time ?? null) : timeOrNull(input.startTime, "Start");
  const endTime = input.endTime === undefined ? (was.end_time ?? null) : timeOrNull(input.endTime, "End");
  if (endTime && !startTime) throw new ValidationError("Give a start time with the end time.");
  if (startTime && endTime && endTime <= startTime) throw new ValidationError("The end has to be after the start.");
  const kind = input.kind === undefined ? (was.kind ?? "other") : requireOneOf(input.kind, "kind", CALENDAR_KINDS);
  const title = input.title === undefined ? was.title! : requireString(input.title, "What", { maxLength: 200 });
  const farmId = input.farmId === undefined ? (was.farm_id ?? null) : await farmIdOrNull(tx, input.farmId);
  const notes = input.notes === undefined ? (was.notes ?? null) : (optionalString(input.notes, "Notes", { maxLength: 2000 }) ?? null);
  const repeat = input.repeat === undefined ? (was.repeat ?? null) : input.repeat === null || input.repeat === "" ? null : requireOneOf(input.repeat, "repeat", REPEATS);
  let repeatUntil = input.repeatUntil === undefined ? (was.repeat_until ?? null) : input.repeatUntil === null || input.repeatUntil === "" ? null : parseIsoDate(input.repeatUntil, "Until");
  if (!repeat) repeatUntil = null;
  if (repeatUntil && repeatUntil < date) throw new ValidationError("The repeat can't end before it starts.");
  return { date, startTime, endTime, kind, title, farmId, notes, repeat, repeatUntil };
}

/** FC17: an item the member adds. It's theirs, checked, and never in Needs checking. */
export async function addCalendarItem(tx: OrgTx, input: ItemInput): Promise<CalendarItem> {
  await requireFarming(tx);
  const userId = requireUser(tx);
  if (input.title === undefined) throw new ValidationError("Say what it is.");
  const values = await itemValues(tx, input, { source: "own" });
  const inserted = await tx.query<{ id: string }>(
    `insert into farm_calendar_items (user_id, source, kind, title, item_date, start_time, end_time, farm_id, notes, repeat, repeat_until, checked_at)
     values ($1, 'own', $2, $3, $4, $5, $6, $7, $8, $9, $10, now()) returning id::text`,
    [userId, values.kind, values.title, values.date, values.startTime, values.endTime, values.farmId, values.notes, values.repeat, values.repeatUntil],
  );
  return ownItemShown(tx, inserted.rows[0].id);
}

/**
 * FC14, FC18: the member corrects (or just confirms) an item: date, times,
 * kind, title, farm, notes, repeat. It's then checked, out of Needs
 * checking, and a later email won't move or cancel it. For a repeat, it
 * changes every date (a new date moves its start).
 */
export async function checkCalendarItem(tx: OrgTx, idInput: unknown, input: ItemInput): Promise<CalendarItem> {
  const item = await ownItem(tx, idInput);
  if (item.state !== "open") throw new ConflictError("This item was moved, cancelled or hidden, so it can't be changed.");
  const values = await itemValues(tx, input, item);
  // Skipped dates that are no longer dates of the repeat are dropped.
  const skips = values.repeat ? item.repeat_skips.filter((skip) => isRepeatDate(values.date, values.repeat!, values.repeatUntil, skip)) : [];
  await tx.query(
    `update farm_calendar_items set item_date = $2, start_time = $3, end_time = $4, kind = $5, title = $6, farm_id = $7, notes = $8,
            repeat = $9, repeat_until = $10, repeat_skips = $11::date[], checked_at = now(), updated_at = now()
      where id = $1`,
    [item.id, values.date, values.startTime, values.endTime, values.kind, values.title, values.farmId, values.notes, values.repeat, values.repeatUntil, skips],
  );
  return ownItemShown(tx, item.id);
}

/** FC14: "Not a farm arrangement" hides an item, and stops sharing it. */
export async function dismissCalendarItem(tx: OrgTx, idInput: unknown): Promise<CalendarItem> {
  const item = await ownItem(tx, idInput);
  await tx.query("update farm_calendar_items set state = 'dismissed', state_note = 'Not a farm arrangement', shared_at = null, shared_by_name = null, updated_at = now() where id = $1", [
    item.id,
  ]);
  return ownItemShown(tx, item.id);
}

/** FC17: the member deletes an item they added. Items from email can only be hidden. */
export async function deleteCalendarItem(tx: OrgTx, idInput: unknown): Promise<void> {
  const item = await ownItem(tx, idInput);
  if (item.source !== "own") throw new ConflictError('Items read from email can\'t be deleted: use "Not a farm arrangement" to hide it.');
  await tx.query("update farm_calendar_items set replaced_by = null where replaced_by = $1", [item.id]);
  await tx.query("delete from farm_calendar_items where id = $1", [item.id]);
}

/** FC19: takes one date out of a repeat; the others stay. */
export async function skipCalendarDate(tx: OrgTx, idInput: unknown, dateInput: unknown): Promise<CalendarItem> {
  const item = await ownItem(tx, idInput);
  if (!item.repeat || !item.item_date) throw new ValidationError("Only a repeating item has dates to skip.");
  if (item.state !== "open") throw new ConflictError("This item was moved, cancelled or hidden, so it can't be changed.");
  const date = parseIsoDate(dateInput, "Date");
  if (!isRepeatDate(item.item_date, item.repeat, item.repeat_until, date)) throw new ValidationError("That isn't one of its dates.");
  if (repeatDates(item.item_date, item.repeat, item.repeat_until, [...item.repeat_skips, date], item.item_date, item.repeat_until ?? date).length === 0 && item.repeat_until) {
    throw new ValidationError("That's its only date left: delete or hide it instead.");
  }
  if (!item.repeat_skips.includes(date)) {
    await tx.query("update farm_calendar_items set repeat_skips = array_append(repeat_skips, $2::date), checked_at = coalesce(checked_at, now()), updated_at = now() where id = $1", [item.id, date]);
  }
  return ownItemShown(tx, item.id);
}

/** FC14: this item replaces an earlier one, which becomes Moved. */
export async function replaceCalendarItem(tx: OrgTx, idInput: unknown, replacesInput: unknown): Promise<CalendarItem> {
  const item = await ownItem(tx, idInput);
  const earlier = await ownItem(tx, replacesInput);
  if (earlier.id === item.id) throw new ValidationError("Choose a different item to replace.");
  if (item.state !== "open" || earlier.state !== "open") throw new ConflictError("Only items still on the calendar can replace or be replaced.");
  if (!item.item_date) throw new ValidationError("Give this item a date first.");
  await tx.query("update farm_calendar_items set state = 'moved', state_note = $2, replaced_by = $3, updated_at = now() where id = $1", [
    earlier.id,
    `Moved to ${shortDay(item.item_date)}`,
    item.id,
  ]);
  await tx.query("update farm_calendar_items set checked_at = now(), updated_at = now() where id = $1", [item.id]);
  return ownItemShown(tx, item.id);
}

async function memberName(userId: string): Promise<string> {
  const row = await coreQuery<{ display_name: string | null; email: string }>("select display_name, email from users where id = $1", [userId]);
  return row.rows[0]?.display_name?.trim() || row.rows[0]?.email || "A member";
}

/**
 * FC20: shares an item with everyone in the organisation (or stops). It's
 * checked by sharing, so only its member changes it. The team sees only
 * `teamView`, which the screen shows as the preview first.
 */
export async function shareCalendarItem(tx: OrgTx, idInput: unknown, share: unknown): Promise<CalendarItem> {
  const item = await ownItem(tx, idInput);
  if (share === false) {
    await tx.query("update farm_calendar_items set shared_at = null, shared_by_name = null, updated_at = now() where id = $1", [item.id]);
  } else {
    if (item.state !== "open") throw new ConflictError("Only items still on the calendar can be shared.");
    if (!item.item_date) throw new ValidationError("Give it a date before sharing it.");
    await tx.query("update farm_calendar_items set shared_at = now(), shared_by_name = $2, checked_at = coalesce(checked_at, now()), updated_at = now() where id = $1", [
      item.id,
      await memberName(item.user_id),
    ]);
  }
  await writeAuditEvent(tx, { eventType: share === false ? "farming.calendar_unshared" : "farming.calendar_shared", entityType: "farm_calendar_item", entityId: item.id, details: {} });
  return ownItemShown(tx, item.id);
}

/** Filters for screens: an optional string. */
export function optionalSender(input: unknown): string | undefined {
  return optionalString(input, "Sender", { maxLength: 320 }) ?? undefined;
}

// The calendar link (FC22, FC23) ------------------------------------------------------------------

export const CALENDAR_LINK_PATH = "/api/farming/calendar-link";
const FEED_DAYS_BACK = 60;
const feedLimiter = new RequestLimiter(60, 60 * 60 * 1000);

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export type CalendarLinkStatus = { on: boolean; createdAt: string | null; lastUsedAt: string | null };

export async function calendarLinkStatus(tx: OrgTx): Promise<CalendarLinkStatus> {
  await requireFarming(tx);
  const row = await tx.query<{ created_at: string; last_used_at: string | null }>("select created_at::text, last_used_at::text from farm_calendar_links where user_id = $1", [requireUser(tx)]);
  return { on: Boolean(row.rows[0]), createdAt: row.rows[0]?.created_at ?? null, lastUsedAt: row.rows[0]?.last_used_at ?? null };
}

/** FC22: a new private link (shown once); any earlier one stops working. */
export async function makeCalendarLink(tx: OrgTx, origin: string): Promise<CalendarLinkStatus & { url: string }> {
  await requireFarming(tx);
  const userId = requireUser(tx);
  const token = randomBytes(32).toString("base64url");
  await tx.query(
    `insert into farm_calendar_links (user_id, token_hash) values ($1, $2)
     on conflict (user_id) do update set token_hash = excluded.token_hash, created_at = now(), last_used_at = null`,
    [userId, hashToken(token)],
  );
  await writeAuditEvent(tx, { eventType: "farming.calendar_link_made", entityType: "farm_calendar_link", entityId: userId, details: {} });
  return { ...(await calendarLinkStatus(tx)), url: `${origin.replace(/\/+$/, "")}${CALENDAR_LINK_PATH}/${tx.organisationId}/${token}.ics` };
}

/** FC23: turns the link off. */
export async function turnOffCalendarLink(tx: OrgTx): Promise<CalendarLinkStatus> {
  await requireFarming(tx);
  await tx.query("delete from farm_calendar_links where user_id = $1", [requireUser(tx)]);
  await writeAuditEvent(tx, { eventType: "farming.calendar_link_off", entityType: "farm_calendar_link", entityId: tx.actor.userId!, details: {} });
  return calendarLinkStatus(tx);
}

/**
 * FC22, FC23: the calendar link's iCalendar text, or null ("not found")
 * alike for a wrong, replaced or turned-off link, a member who has left,
 * Farming off, an organisation that isn't usable, or too many requests.
 */
export async function calendarLinkFeed(organisationInput: string, fileInput: string, now = new Date()): Promise<string | null> {
  const token = /^([A-Za-z0-9_-]{43})\.ics$/.exec(fileInput)?.[1];
  if (!token) return null;
  let organisationId: string;
  try {
    organisationId = parseOrganisationId(organisationInput);
  } catch {
    return null;
  }
  const organisation = await getOrganisation(organisationId);
  if (!organisation) return null;
  try {
    assertOrganisationUsable(organisation);
  } catch {
    return null;
  }
  const hash = hashToken(token);
  if (!feedLimiter.take(`${organisationId}:${hash}`)) return null;
  const link = await withOrganisationTransaction(organisation, FARM_MAIL_ACTOR, async (tx) => {
    const on = await tx.query<{ enabled: boolean }>("select enabled from farming_settings where id = true");
    if (on.rows[0]?.enabled !== true) return null;
    return (await tx.query<{ user_id: string }>("select user_id::text from farm_calendar_links where token_hash = $1", [hash])).rows[0] ?? null;
  });
  if (!link || !(await getMembership(organisationId, link.user_id))) return null;
  const name = await memberName(link.user_id);
  return withOrganisationTransaction(organisation, { userId: link.user_id, email: "calendar-link@tohyee" }, async (tx) => {
    await tx.query("update farm_calendar_links set last_used_at = now() where user_id = $1", [link.user_id]);
    const from = new Date(now.getTime() - FEED_DAYS_BACK * 86_400_000).toISOString().slice(0, 10);
    // Moved ones are left out: their new date is its own item (FC22).
    const rows = await tx.query<CalendarRow>(
      `select ${ITEM_COLUMNS} from farm_calendar_items i left join farms f on f.id = i.farm_id
        where ${VISIBLE} and i.state in ('open', 'cancelled') and i.item_date is not null
          and ((i.repeat is null and i.item_date >= $2) or (i.repeat is not null and (i.repeat_until is null or i.repeat_until >= $2)))
        order by i.item_date, i.id`,
      [link.user_id, from],
    );
    const events: FeedEvent[] = rows.rows.map((row) => {
      const shown = toItem(row, link.user_id);
      return {
        uid: `farm-${organisationId}-${row.id}@tohyee`,
        kind: shown.kind,
        title: shown.title,
        date: row.item_date!,
        startTime: shown.startTime,
        endTime: shown.endTime,
        tentative: shown.tentative && !shown.checked,
        cancelled: row.state === "cancelled",
        farmName: shown.farmName,
        sharedByName: shown.mine ? null : shown.sharedByName,
        repeat: shown.repeat,
        repeatUntil: shown.repeatUntil,
        repeatSkips: row.repeat_skips,
        updatedAt: new Date(row.updated_at).toISOString(),
      };
    });
    return calendarFeed(events, `${name}'s farm calendar`, now);
  });
}

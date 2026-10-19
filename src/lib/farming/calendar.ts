import { randomBytes } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { googleApp, microsoftApp } from "@/lib/crm/mail/service";
import { exchangeCode, MAIL_PROVIDERS, type MailProvider, mailboxAddress, type ProviderApp, refreshAccess, authorisationUrl } from "@/lib/crm/mail/providers";
import { parseIsoDate } from "@/lib/dates";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { requireFarming } from "@/lib/farming/paddocks";
import { type FarmMail, FARM_GOOGLE_SCOPES, FARM_MICROSOFT_SCOPES, fetchFarmMail, listFarmMailIds } from "@/lib/farming/mail-providers";
import { type Arrangement, FARM_MAIL_KINDS, type FarmMailKind, nzDay, readEmail } from "@/lib/farming/mail-rules";
import { listAllOrganisations } from "@/lib/organisations/admin";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { optionalString, requireOneOf, requireString } from "@/lib/validation";

/*
 * The farm calendar from email (#319; examples FC1-FC16, decisions
 * 570-572). Each member connects their own Gmail or Microsoft mailbox,
 * read-only; Tohyee reads its emails with fixed rules (mail-rules.ts) and
 * keeps only what each arrangement needs (sender, subject, the sentence, a
 * link). Everything here belongs to the member who connected it: every
 * query is limited to the signed-in member's mailboxes, admins included
 * (decision 571). Network calls happen outside database transactions.
 */

export const FARM_MAIL_CALLBACK_PATH = "/api/farming/mail/callback";
export const FARM_MAIL_ACTOR: Actor = { userId: null, email: "farm-mail@tohyee" };
const STATE_MINUTES = 15;
const PAUSE_AFTER_FAILURES = 3;
/** Emails read in one check, new and old together (the rest wait for the next check). */
const MAX_READ_PER_CHECK = 150;
const MAX_IDS = 1000;

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
  items: number;
};

export type CalendarItem = {
  id: string;
  mailboxId: string;
  kind: FarmMailKind;
  title: string;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  tentative: boolean;
  change: "new" | "moved" | "cancelled";
  state: "open" | "moved" | "cancelled" | "dismissed";
  stateNote: string | null;
  checkReasons: string[];
  needsChecking: boolean;
  checked: boolean;
  farmId: string | null;
  farmName: string | null;
  senderEmail: string;
  senderName: string | null;
  subject: string | null;
  excerpt: string;
  webLink: string | null;
  sentAt: string;
  alsoSeen: number;
};

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
export async function startFarmMailConnect(tx: OrgTx, input: { provider: unknown; historyDays?: unknown; defaultFarmId?: unknown }, origin: string): Promise<{ url: string }> {
  await requireFarming(tx);
  const userId = requireUser(tx);
  const provider = requireOneOf(input.provider, "provider", MAIL_PROVIDERS);
  if (!secretsAvailable()) throw new UnavailableError("The server has no TOHYEE_SECRET_KEY, so it can't store mailbox tokens.");
  const app = await appFor(tx, provider);
  const days = historyDays(input.historyDays);
  const farmId = await farmIdOrNull(tx, input.defaultFarmId);
  const state = `${tx.organisationId}.${randomBytes(24).toString("base64url")}`;
  await tx.query("delete from farm_mail_states where created_at < now() - interval '1 day'");
  await tx.query("insert into farm_mail_states (state, user_id, provider, history_days, default_farm_id) values ($1, $2, $3, $4, $5)", [state, userId, provider, days, farmId]);
  return { url: authorisationUrl(provider, app, redirectUri(origin), state, provider === "google" ? FARM_GOOGLE_SCOPES : FARM_MICROSOFT_SCOPES) };
}

export type ClaimedFarmState = { provider: MailProvider; historyDays: number; defaultFarmId: string | null; app: ProviderApp };

/** Checks the state (unused, under 15 minutes old, the same member) and marks it used, before the code is exchanged. */
export async function claimFarmMailState(tx: OrgTx, state: string): Promise<ClaimedFarmState> {
  await requireFarming(tx);
  const found = await tx.query<{ user_id: string; provider: MailProvider; history_days: number; default_farm_id: string | null; fresh: boolean; used_at: string | null }>(
    `select user_id, provider, history_days, default_farm_id::text, created_at > now() - make_interval(mins => $2) as fresh, used_at
       from farm_mail_states where state = $1 for update`,
    [state, STATE_MINUTES],
  );
  const row = found.rows[0];
  if (!row || row.used_at || !row.fresh || row.user_id !== tx.actor.userId) {
    throw new ValidationError("That sign-in link has expired or was already used. Start connecting again.");
  }
  await tx.query("update farm_mail_states set used_at = now() where state = $1", [state]);
  return { provider: row.provider, historyDays: row.history_days, defaultFarmId: row.default_farm_id, app: await appFor(tx, row.provider) };
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
              status = 'active', failures = 0, last_error = null, updated_at = now() where id = $1`,
      [id, ...secrets],
    );
  } else {
    const historyFrom = new Date(now.getTime() - claimed.historyDays * 86_400_000).toISOString();
    const inserted = await tx.query<{ id: string }>(
      `insert into farm_mail_accounts (user_id, provider, email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at,
                                       history_days, history_from, checked_through, backfill_before, default_farm_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10) returning id::text`,
      [userId, claimed.provider, email, ...secrets, claimed.historyDays, historyFrom, now.toISOString(), claimed.defaultFarmId],
    );
    id = inserted.rows[0].id;
  }
  // Audited without the address: the mailbox is the member's own (decision 571).
  await writeAuditEvent(tx, { eventType: "farming.mailbox_connected", entityType: "farm_mail_account", entityId: id, details: { provider: claimed.provider } });
  return (await listFarmMailboxes(tx)).find((mailbox) => mailbox.id === id)!;
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
  }>(
    `select a.id::text, a.provider, a.email, a.history_days, a.default_farm_id::text, a.status, a.last_check_at::text, a.last_error, a.backfill_before::text,
            (select count(*)::int from farm_calendar_items i where i.account_id = a.id and i.state <> 'dismissed') as items
       from farm_mail_accounts a where a.user_id = $1 order by a.email`,
    [userId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    email: row.email,
    historyDays: row.history_days,
    defaultFarmId: row.default_farm_id,
    status: row.status,
    lastCheckAt: row.last_check_at,
    lastError: row.last_error,
    readingHistory: row.backfill_before !== null,
    items: row.items,
  }));
}

async function ownMailbox(tx: OrgTx, idInput: unknown): Promise<string> {
  await requireFarming(tx);
  const userId = requireUser(tx);
  const id = typeof idInput === "string" || typeof idInput === "number" ? String(idInput) : "";
  if (!/^[1-9][0-9]{0,18}$/.test(id)) throw new NotFoundError("Mailbox not found.");
  const found = await tx.query("select 1 from farm_mail_accounts where id = $1 and user_id = $2", [id, userId]);
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

async function deleteMailbox(tx: OrgTx, id: string): Promise<void> {
  await tx.query("update farm_calendar_items set replaced_by = null where account_id = $1", [id]);
  await tx.query("delete from farm_mail_accounts where id = $1", [id]);
  await writeAuditEvent(tx, { eventType: "farming.mailbox_disconnected", entityType: "farm_mail_account", entityId: id, details: {} });
}

/** FC15: a member leaving the organisation has their farm mailboxes disconnected. */
export async function disconnectMemberFarmMail(organisation: OrganisationRecord, userId: string): Promise<number> {
  return withOrganisationTransaction(organisation, FARM_MAIL_ACTOR, async (tx) => {
    const ids = await tx.query<{ id: string }>("select id::text from farm_mail_accounts where user_id = $1", [userId]);
    for (const row of ids.rows) await deleteMailbox(tx, row.id);
    return ids.rows.length;
  });
}

/** "Check now" for one of the member's own mailboxes. */
export async function mailboxForCheck(tx: OrgTx, idInput: unknown): Promise<string> {
  const id = await ownMailbox(tx, idInput);
  const row = await tx.query<{ status: string }>("select status from farm_mail_accounts where id = $1", [id]);
  if (row.rows[0].status === "paused") throw new ConflictError("This mailbox is paused after failed checks. Connect it again to start checking.");
  return id;
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
                                      item_date, start_time, end_time, tentative, change, check_reasons, farm_id, excerpt)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) returning id::text`,
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
        await tx.query("update farm_calendar_items set also_seen = also_seen + 1, updated_at = now() where id = $1", [same.rows[0].id]);
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
        await tx.query("update farm_calendar_items set state = 'cancelled', state_note = $2, updated_at = now() where id = $1", [earlier.id, `Cancelled by an email on ${sentDay}`]);
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

/**
 * Checks one mailbox (FC9): new emails since the last check, then older
 * history back to the chosen start, reading at most 150 emails a check.
 * Each email is read once; it's fetched, read and only its arrangements
 * kept.
 */
export async function checkFarmMailbox(organisation: OrganisationRecord, accountId: string, now = new Date()): Promise<{ read: number; items: number }> {
  const prepared = await withOrganisationTransaction(organisation, FARM_MAIL_ACTOR, async (tx) => {
    await requireFarming(tx);
    const found = await tx.query<AccountRow>(
      `select id::text, user_id, provider, email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at::text,
              history_from::text, checked_through::text, backfill_before::text, default_farm_id::text
         from farm_mail_accounts where id = $1 and status = 'active'`,
      [accountId],
    );
    const account = found.rows[0];
    if (!account) throw new NotFoundError("Mailbox not found.");
    return { account, app: await appFor(tx, account.provider) };
  });
  const { account, app } = prepared;
  try {
    const { token, refreshed } = await accessToken(account, app, now);
    const seenIds = async (ids: string[]) =>
      withOrganisationTransaction(organisation, FARM_MAIL_ACTOR, async (tx) => {
        const rows = await tx.query<{ external_id: string; sent_at: string }>("select external_id, sent_at::text from farm_mail_seen where account_id = $1 and external_id = any($2::text[])", [
          account.id,
          ids,
        ]);
        return new Map(rows.rows.map((row) => [row.external_id, row.sent_at]));
      });
    let budget = MAX_READ_PER_CHECK;
    const mails: FarmMail[] = [];
    const seenOnly: Array<{ id: string; sentAt: string }> = [];
    /**
     * Reads a window newest first, while the budget lasts. `oldest` is the
     * oldest date of the unbroken run read (or already seen) from the newest,
     * so the history can carry on below it next time.
     */
    const readWindow = async (after: Date, before: Date | null) => {
      const listed = await listFarmMailIds(account.provider, token, after, before, MAX_IDS);
      const seen = await seenIds(listed.ids);
      let oldest: string | null = null;
      let reachedEnd = true;
      for (const id of listed.ids) {
        let date = seen.get(id) ?? null;
        if (date === null) {
          if (budget <= 0) {
            reachedEnd = false;
            break;
          }
          budget -= 1;
          const mail = await fetchFarmMail(account.provider, token, id, account.email);
          if (mail) {
            mails.push(mail);
            date = mail.sentAt;
          } else {
            seenOnly.push({ id, sentAt: before ? before.toISOString() : now.toISOString() });
          }
        }
        if (date && (oldest === null || date < oldest)) oldest = date;
      }
      return { finished: reachedEnd && listed.complete, oldest };
    };
    // New mail first.
    const recent = await readWindow(new Date(new Date(account.checked_through).getTime() - 60 * 60 * 1000), null);
    let checkedThrough = recent.finished ? now.toISOString() : account.checked_through;
    // Then older history, newest first, a step at a time.
    let backfillBefore = account.backfill_before;
    if (backfillBefore && budget > 0) {
      const history = await readWindow(new Date(account.history_from), new Date(backfillBefore));
      if (history.finished) backfillBefore = null;
      else if (history.oldest && history.oldest < backfillBefore) backfillBefore = history.oldest;
    }
    return await withOrganisationTransaction(organisation, FARM_MAIL_ACTOR, async (tx) => {
      const farms = (await tx.query<{ id: string; name: string }>("select id::text, name from farms where is_active order by farms.id")).rows;
      let items = 0;
      for (const mail of mails.sort((a, b) => a.sentAt.localeCompare(b.sentAt))) {
        const marked = await tx.query("insert into farm_mail_seen (account_id, external_id, sent_at) values ($1, $2, $3) on conflict do nothing", [account.id, mail.externalId, mail.sentAt]);
        if (!marked.rowCount) continue;
        items += await applyMail(tx, account, mail, farms);
      }
      for (const entry of seenOnly) {
        await tx.query("insert into farm_mail_seen (account_id, external_id, sent_at) values ($1, $2, $3) on conflict do nothing", [account.id, entry.id, entry.sentAt]);
      }
      if (checkedThrough < account.checked_through) checkedThrough = account.checked_through;
      await tx.query(
        `update farm_mail_accounts
            set checked_through = $2, backfill_before = $3, last_check_at = $4, last_error = null, failures = 0,
                access_token_ciphertext = coalesce($5, access_token_ciphertext), access_token_expires_at = coalesce($6, access_token_expires_at),
                refresh_token_ciphertext = coalesce($7, refresh_token_ciphertext), updated_at = now()
          where id = $1`,
        [
          account.id,
          checkedThrough,
          backfillBefore,
          now.toISOString(),
          refreshed ? encryptSecret(refreshed.accessToken) : null,
          refreshed ? new Date(now.getTime() + refreshed.expiresInSeconds * 1000).toISOString() : null,
          refreshed?.refreshToken ? encryptSecret(refreshed.refreshToken) : null,
        ],
      );
      return { read: mails.length, items };
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
          return (await tx.query<{ id: string }>("select id::text from farm_mail_accounts where status = 'active' order by last_check_at nulls first, farm_mail_accounts.id")).rows.map((row) => row.id);
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
    checkAllFarmMail().catch((error) => console.warn("[tohyee] Farm mail scheduler:", error));
  };
  timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 3 * 60 * 1000).unref?.();
}

// The calendar (FC13, FC14) ------------------------------------------------------------------

type CalendarRow = {
  id: string;
  account_id: string;
  kind: FarmMailKind;
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
  sender_email: string;
  sender_name: string | null;
  subject: string | null;
  excerpt: string;
  web_link: string | null;
  sent_at: string;
  also_seen: number;
};

const ITEM_COLUMNS = `i.id::text, i.account_id::text, i.kind, i.title, i.item_date::text, to_char(i.start_time, 'HH24:MI') as start_time,
       to_char(i.end_time, 'HH24:MI') as end_time, i.tentative, i.change, i.state, i.state_note, i.check_reasons, i.checked_at::text,
       i.farm_id::text, f.name as farm_name, i.sender_email, i.sender_name, i.subject, i.excerpt, i.web_link, i.sent_at::text, i.also_seen`;

const NEEDS_CHECKING = "(i.state = 'open' and i.checked_at is null and (i.item_date is null or cardinality(i.check_reasons) > 0))";

function toItem(row: CalendarRow): CalendarItem {
  const needsChecking = row.state === "open" && row.checked_at === null && (row.item_date === null || row.check_reasons.length > 0);
  return {
    id: row.id,
    mailboxId: row.account_id,
    kind: row.kind,
    title: row.title,
    date: row.item_date,
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
    sentAt: new Date(row.sent_at).toISOString(),
    alsoSeen: row.also_seen,
  };
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
    params.push(input.sender.trim().toLowerCase());
    sql += ` and lower(i.sender_email) = $${params.length}`;
  }
  return sql;
}

/**
 * The calendar from `from` to `to` (FC13): the member's own items with a
 * date in the range (dismissed ones aren't shown), and the senders and farms
 * there are to filter by.
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
  const params: unknown[] = [userId, from, to];
  const rows = await tx.query<CalendarRow>(
    `select ${ITEM_COLUMNS} from farm_calendar_items i join farm_mail_accounts a on a.id = i.account_id left join farms f on f.id = i.farm_id
      where a.user_id = $1 and i.state <> 'dismissed' and i.item_date between $2 and $3 ${filters(input, params)}
      order by i.item_date, i.start_time nulls first, i.id`,
    params,
  );
  const count = await tx.query<{ n: number }>(
    `select count(*)::int as n from farm_calendar_items i join farm_mail_accounts a on a.id = i.account_id where a.user_id = $1 and ${NEEDS_CHECKING}`,
    [userId],
  );
  const senders = await tx.query<{ email: string; name: string | null }>(
    `select distinct on (lower(i.sender_email)) lower(i.sender_email) as email, i.sender_name as name
       from farm_calendar_items i join farm_mail_accounts a on a.id = i.account_id
      where a.user_id = $1 and i.state <> 'dismissed' order by lower(i.sender_email), i.sent_at desc`,
    [userId],
  );
  return { items: rows.rows.map(toItem), needsChecking: count.rows[0].n, senders: senders.rows };
}

/** Needs checking (FC4, FC6, FC10, FC13): oldest email first. */
export async function itemsToCheck(tx: OrgTx, input: CalendarFilter = {}): Promise<CalendarItem[]> {
  await requireFarming(tx);
  const params: unknown[] = [requireUser(tx)];
  const rows = await tx.query<CalendarRow>(
    `select ${ITEM_COLUMNS} from farm_calendar_items i join farm_mail_accounts a on a.id = i.account_id left join farms f on f.id = i.farm_id
      where a.user_id = $1 and ${NEEDS_CHECKING} ${filters(input, params)} order by i.sent_at, i.id limit 500`,
    params,
  );
  return rows.rows.map(toItem);
}

async function ownItem(tx: OrgTx, idInput: unknown): Promise<CalendarRow> {
  await requireFarming(tx);
  const userId = requireUser(tx);
  const id = typeof idInput === "string" || typeof idInput === "number" ? String(idInput) : "";
  if (!/^[1-9][0-9]{0,18}$/.test(id)) throw new NotFoundError("Calendar item not found.");
  const rows = await tx.query<CalendarRow>(
    `select ${ITEM_COLUMNS} from farm_calendar_items i join farm_mail_accounts a on a.id = i.account_id left join farms f on f.id = i.farm_id
      where i.id = $1 and a.user_id = $2 for update of i`,
    [id, userId],
  );
  if (!rows.rows[0]) throw new NotFoundError("Calendar item not found.");
  return rows.rows[0];
}

function timeOrNull(input: unknown, label: string): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input)) throw new ValidationError(`${label} must be a time like 09:30.`);
  return input;
}

/**
 * FC14: the member corrects (or just confirms) an item: date, times, kind,
 * title, farm. It's then checked, out of Needs checking, and a later email
 * won't move or cancel it.
 */
export async function checkCalendarItem(
  tx: OrgTx,
  idInput: unknown,
  input: { date?: unknown; startTime?: unknown; endTime?: unknown; kind?: unknown; title?: unknown; farmId?: unknown },
): Promise<CalendarItem> {
  const item = await ownItem(tx, idInput);
  if (item.state !== "open") throw new ConflictError("This item was moved, cancelled or hidden, so it can't be changed.");
  const date = input.date === undefined ? item.item_date : input.date === null || input.date === "" ? null : parseIsoDate(input.date, "Date");
  if (!date) throw new ValidationError("Give it a date, or hide it with \"Not a farm arrangement\".");
  const startTime = input.startTime === undefined ? item.start_time : timeOrNull(input.startTime, "Start");
  const endTime = input.endTime === undefined ? item.end_time : timeOrNull(input.endTime, "End");
  if (endTime && !startTime) throw new ValidationError("Give a start time with the end time.");
  if (startTime && endTime && endTime <= startTime) throw new ValidationError("The end has to be after the start.");
  const kind = input.kind === undefined ? item.kind : requireOneOf(input.kind, "kind", FARM_MAIL_KINDS);
  const title = input.title === undefined ? item.title : requireString(input.title, "Title", { maxLength: 200 });
  const farmId = input.farmId === undefined ? item.farm_id : await farmIdOrNull(tx, input.farmId);
  await tx.query(
    `update farm_calendar_items set item_date = $2, start_time = $3, end_time = $4, kind = $5, title = $6, farm_id = $7, checked_at = now(), updated_at = now()
      where id = $1`,
    [item.id, date, startTime, endTime, kind, title, farmId],
  );
  return toItem(await ownItem(tx, item.id));
}

/** FC14: "Not a farm arrangement" hides an item. */
export async function dismissCalendarItem(tx: OrgTx, idInput: unknown): Promise<CalendarItem> {
  const item = await ownItem(tx, idInput);
  await tx.query("update farm_calendar_items set state = 'dismissed', state_note = 'Not a farm arrangement', updated_at = now() where id = $1", [item.id]);
  return toItem(await ownItem(tx, item.id));
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
  return toItem(await ownItem(tx, item.id));
}

/** Filters for screens: an optional string. */
export function optionalSender(input: unknown): string | undefined {
  return optionalString(input, "Sender", { maxLength: 320 }) ?? undefined;
}

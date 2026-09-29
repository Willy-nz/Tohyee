import { randomBytes } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { crmEnabled, requireCrm } from "@/lib/crm/switch";
import type { OrgTx } from "@/lib/db/org-transaction";
import { type Actor, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { listAllOrganisations } from "@/lib/organisations/admin";
import { listMembers } from "@/lib/organisations/members";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { UnavailableError } from "@/lib/errors";
import {
  authorisationUrl,
  exchangeCode,
  listEvents,
  listMessages,
  MAIL_PROVIDERS,
  type MailProvider,
  mailboxAddress,
  type Participant,
  type ProviderApp,
  refreshAccess,
} from "@/lib/crm/mail/providers";
import { requireOneOf } from "@/lib/validation";

/**
 * CRM email and calendar sync (examples MAIL1-MAIL9), after Twenty's
 * connected accounts: each member connects their own Gmail or Microsoft 365
 * mailbox, and only emails and meetings with a person or company the CRM
 * knows are kept (subject, a short preview and who/when; never full bodies
 * or attachments). Network calls happen outside database transactions.
 */
export const CALLBACK_PATH = "/api/crm/mail/callback";
const STATE_MINUTES = 15;
const FIRST_SYNC_DAYS = 30;
const PAUSE_AFTER_FAILURES = 3;
export const SYNC_ACTOR: Actor = { userId: null, email: "mail-sync@tohyee" };

export type MailSettings = {
  google: { clientId: string | null; secretSaved: boolean };
  microsoft: { clientId: string | null; secretSaved: boolean; tenant: string };
  secretsAvailable: boolean;
  redirectPath: string;
};

export type ConnectedAccount = {
  id: string;
  userId: string;
  ownerName: string | null;
  provider: MailProvider;
  email: string;
  visibility: "subject" | "metadata";
  status: "active" | "paused";
  lastSyncAt: string | null;
  lastError: string | null;
  failures: number;
  messages: number;
  meetings: number;
  isMine: boolean;
};

type SettingsRow = {
  google_client_id: string | null;
  google_client_secret_ciphertext: string | null;
  microsoft_client_id: string | null;
  microsoft_client_secret_ciphertext: string | null;
  microsoft_tenant: string;
};

async function settingsRow(tx: OrgTx): Promise<SettingsRow> {
  const result = await tx.query<SettingsRow>(
    `select google_client_id, google_client_secret_ciphertext, microsoft_client_id, microsoft_client_secret_ciphertext, microsoft_tenant
       from crm_mail_settings where id = true`,
  );
  return result.rows[0];
}

export async function getMailSettings(tx: OrgTx): Promise<MailSettings> {
  const row = await settingsRow(tx);
  return {
    google: { clientId: row.google_client_id, secretSaved: Boolean(row.google_client_secret_ciphertext) },
    microsoft: { clientId: row.microsoft_client_id, secretSaved: Boolean(row.microsoft_client_secret_ciphertext), tenant: row.microsoft_tenant },
    secretsAvailable: secretsAvailable(),
    redirectPath: CALLBACK_PATH,
  };
}

function optionalText(input: unknown, what: string, max: number): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null || (typeof input === "string" && !input.trim())) return null;
  if (typeof input !== "string" || input.trim().length > max) throw new ValidationError(`${what} must be text of at most ${max} characters.`);
  return input.trim();
}

/**
 * Saves the organisation's Google and Microsoft app (MAIL1). A secret sent
 * blank keeps the saved one; the secret is stored encrypted and never
 * returned.
 */
export async function saveMailSettings(
  tx: OrgTx,
  input: { googleClientId?: unknown; googleClientSecret?: unknown; microsoftClientId?: unknown; microsoftClientSecret?: unknown; microsoftTenant?: unknown },
): Promise<MailSettings> {
  if (!secretsAvailable()) {
    throw new UnavailableError("The server has no TOHYEE_SECRET_KEY, so it can't store the app's secret. A server admin needs to set it first.");
  }
  const current = await settingsRow(tx);
  const googleClientId = optionalText(input.googleClientId, "The Google client ID", 300);
  const googleSecret = optionalText(input.googleClientSecret, "The Google client secret", 500);
  const microsoftClientId = optionalText(input.microsoftClientId, "The Microsoft client ID", 300);
  const microsoftSecret = optionalText(input.microsoftClientSecret, "The Microsoft client secret", 500);
  const tenant = optionalText(input.microsoftTenant, "The Microsoft tenant", 100);
  if (tenant && !/^[A-Za-z0-9.-]+$/.test(tenant)) throw new ValidationError("The Microsoft tenant is a domain or ID, like common or glimmers.onmicrosoft.com.");
  await tx.query(
    `update crm_mail_settings
        set google_client_id = $1, google_client_secret_ciphertext = $2, microsoft_client_id = $3,
            microsoft_client_secret_ciphertext = $4, microsoft_tenant = $5, updated_at = now()
      where id = true`,
    [
      googleClientId === undefined ? current.google_client_id : googleClientId,
      googleSecret ? encryptSecret(googleSecret) : googleClientId === null ? null : current.google_client_secret_ciphertext,
      microsoftClientId === undefined ? current.microsoft_client_id : microsoftClientId,
      microsoftSecret ? encryptSecret(microsoftSecret) : microsoftClientId === null ? null : current.microsoft_client_secret_ciphertext,
      tenant ?? current.microsoft_tenant,
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "crm.mail_settings_updated",
    entityType: "crm_mail_settings",
    entityId: tx.organisationId,
    details: {
      googleClientId: googleClientId === undefined ? current.google_client_id : googleClientId,
      googleSecretChanged: Boolean(googleSecret),
      microsoftClientId: microsoftClientId === undefined ? current.microsoft_client_id : microsoftClientId,
      microsoftSecretChanged: Boolean(microsoftSecret),
    },
  });
  return getMailSettings(tx);
}

async function providerApp(tx: OrgTx, provider: MailProvider): Promise<ProviderApp> {
  const row = await settingsRow(tx);
  const clientId = provider === "google" ? row.google_client_id : row.microsoft_client_id;
  const secret = provider === "google" ? row.google_client_secret_ciphertext : row.microsoft_client_secret_ciphertext;
  if (!clientId || !secret) {
    throw new ConflictError(`${provider === "google" ? "Google" : "Microsoft"} isn't set up yet. An admin needs to enter the app's client ID and secret first.`);
  }
  return { clientId, clientSecret: decryptSecret(secret), tenant: row.microsoft_tenant };
}

// ---------------------------------------------------------------------------
// Connecting (MAIL2)

function redirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${CALLBACK_PATH}`;
}

/** The provider's sign-in address, with a one-time state tied to this user and organisation. */
export async function startConnect(tx: OrgTx, providerInput: unknown, origin: string): Promise<{ url: string }> {
  await requireCrm(tx);
  const provider = requireOneOf(providerInput, "provider", MAIL_PROVIDERS);
  if (!tx.actor.userId) throw new ForbiddenError("Sign in to connect a mailbox.");
  if (!secretsAvailable()) throw new UnavailableError("The server has no TOHYEE_SECRET_KEY, so it can't store mailbox tokens.");
  const app = await providerApp(tx, provider);
  const state = `${tx.organisationId}.${randomBytes(24).toString("base64url")}`;
  await tx.query("delete from crm_oauth_states where created_at < now() - interval '1 day'");
  await tx.query("insert into crm_oauth_states (state, user_id, provider) values ($1, $2, $3)", [state, tx.actor.userId, provider]);
  return { url: authorisationUrl(provider, app, redirectUri(origin), state) };
}

/** The organisation a callback's state belongs to (its id comes first). */
export function organisationFromState(state: unknown): string {
  if (typeof state !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}\.[A-Za-z0-9_-]{20,}$/.test(state)) {
    throw new ValidationError("That sign-in link isn't valid. Start connecting again.");
  }
  return state.slice(0, state.indexOf("."));
}

type StateRow = { user_id: string; provider: MailProvider; fresh: boolean; used_at: string | null };

/**
 * Checks the state (unused, under 15 minutes old, the same signed-in user)
 * and marks it used. Runs before the code is exchanged, so a state can only
 * ever be used once.
 */
export async function claimState(tx: OrgTx, state: string): Promise<MailProvider> {
  const found = await tx.query<StateRow>(
    `select user_id, provider, created_at > now() - make_interval(mins => $2) as fresh, used_at
       from crm_oauth_states where state = $1 for update`,
    [state, STATE_MINUTES],
  );
  const row = found.rows[0];
  if (!row || row.used_at || !row.fresh || row.user_id !== tx.actor.userId) {
    throw new ValidationError("That sign-in link has expired or was already used. Start connecting again.");
  }
  await tx.query("update crm_oauth_states set used_at = now() where state = $1", [state]);
  return row.provider;
}

/** Everything needed to finish outside the database: the app for the provider. */
export async function appForProvider(tx: OrgTx, provider: MailProvider): Promise<ProviderApp> {
  await requireCrm(tx);
  return providerApp(tx, provider);
}

/** Exchanges the code and finds the mailbox address (network, no transaction). */
export async function fetchConnection(provider: MailProvider, app: ProviderApp, code: string, origin: string) {
  const tokens = await exchangeCode(provider, app, code, redirectUri(origin));
  if (!tokens.refreshToken) throw new ValidationError("The sign-in didn't allow offline access, so Tohyee can't keep syncing. Try connecting again.");
  const email = (await mailboxAddress(provider, tokens.accessToken)).toLowerCase();
  return { tokens, email };
}

/** Stores the connected account (tokens encrypted); reconnecting the same mailbox replaces its tokens. */
export async function saveConnection(
  tx: OrgTx,
  provider: MailProvider,
  connection: Awaited<ReturnType<typeof fetchConnection>>,
): Promise<ConnectedAccount> {
  const { tokens, email } = connection;
  const existing = await tx.query<{ id: string; user_id: string }>(
    "select id, user_id from crm_connected_accounts where provider = $1 and lower(email) = lower($2)",
    [provider, email],
  );
  if (existing.rows[0] && existing.rows[0].user_id !== tx.actor.userId) {
    throw new ConflictError(`${email} is already connected by someone else in this organisation.`);
  }
  const values = [
    encryptSecret(tokens.refreshToken!),
    encryptSecret(tokens.accessToken),
    new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
  ];
  let id: string;
  if (existing.rows[0]) {
    id = existing.rows[0].id;
    await tx.query(
      `update crm_connected_accounts
          set refresh_token_ciphertext = $2, access_token_ciphertext = $3, access_token_expires_at = $4, status = 'active',
              failures = 0, last_error = null, updated_at = now()
        where id = $1`,
      [id, ...values],
    );
  } else {
    const inserted = await tx.query<{ id: string }>(
      `insert into crm_connected_accounts (user_id, provider, email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [tx.actor.userId, provider, email, ...values],
    );
    id = inserted.rows[0].id;
  }
  await writeAuditEvent(tx, { eventType: "crm.mail_connected", entityType: "crm_connected_account", entityId: id, details: { provider, email } });
  const account = (await listAccounts(tx)).find((entry) => entry.id === id);
  if (!account) throw new NotFoundError("Connected account not found.");
  return account;
}

// ---------------------------------------------------------------------------
// Accounts

export async function listAccounts(tx: OrgTx): Promise<ConnectedAccount[]> {
  const result = await tx.query<{
    id: string;
    user_id: string;
    provider: MailProvider;
    email: string;
    visibility: "subject" | "metadata";
    status: "active" | "paused";
    last_sync_at: string | null;
    last_error: string | null;
    failures: number;
    messages: string;
    meetings: string;
  }>(
    `select a.id, a.user_id, a.provider, a.email, a.visibility, a.status, a.last_sync_at, a.last_error, a.failures,
            (select count(*) from crm_messages m where m.account_id = a.id)::text as messages,
            (select count(*) from crm_calendar_events e where e.account_id = a.id)::text as meetings
       from crm_connected_accounts a order by lower(a.email), a.id`,
  );
  const members = result.rows.length > 0 ? await listMembers(tx.organisationId) : [];
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    ownerName: members.find((member) => member.userId === row.user_id)?.displayName ?? null,
    provider: row.provider,
    email: row.email,
    visibility: row.visibility,
    status: row.status,
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null,
    lastError: row.last_error,
    failures: row.failures,
    messages: Number(row.messages),
    meetings: Number(row.meetings),
    isMine: row.user_id === tx.actor.userId,
  }));
}

async function ownAccount(tx: OrgTx, idInput: unknown, allowAdmin: boolean): Promise<{ id: string; user_id: string; email: string }> {
  const id = typeof idInput === "string" && /^[1-9]\d{0,17}$/.test(idInput) ? idInput : null;
  if (!id) throw new ValidationError("accountId is required.");
  const found = await tx.query<{ id: string; user_id: string; email: string }>("select id, user_id, email from crm_connected_accounts where id = $1", [id]);
  const account = found.rows[0];
  if (!account) throw new NotFoundError("Connected account not found.");
  if (account.user_id !== tx.actor.userId && !allowAdmin) throw new ForbiddenError("Only the person who connected this mailbox can change it.");
  return account;
}

/** What the rest of the team sees from this mailbox (MAIL7). */
export async function setVisibility(tx: OrgTx, idInput: unknown, visibilityInput: unknown): Promise<ConnectedAccount[]> {
  const account = await ownAccount(tx, idInput, false);
  const visibility = requireOneOf(visibilityInput, "visibility", ["subject", "metadata"] as const);
  await tx.query("update crm_connected_accounts set visibility = $2, updated_at = now() where id = $1", [account.id, visibility]);
  await writeAuditEvent(tx, { eventType: "crm.mail_visibility", entityType: "crm_connected_account", entityId: account.id, details: { visibility } });
  return listAccounts(tx);
}

/** Removes the account's tokens and everything it synced (MAIL9); the mailbox itself is untouched. */
export async function disconnect(tx: OrgTx, idInput: unknown, isAdmin: boolean): Promise<ConnectedAccount[]> {
  const account = await ownAccount(tx, idInput, isAdmin);
  await tx.query("delete from crm_connected_accounts where id = $1", [account.id]);
  await writeAuditEvent(tx, { eventType: "crm.mail_disconnected", entityType: "crm_connected_account", entityId: account.id, details: { email: account.email } });
  return listAccounts(tx);
}

// ---------------------------------------------------------------------------
// Syncing (MAIL3-MAIL5, MAIL8, MAIL9)

type Known = { people: Map<string, { personId: string; contactId: string | null }[]>; contacts: Map<string, string[]> };

async function knownAddresses(tx: OrgTx): Promise<Known> {
  const people = await tx.query<{ id: string; contact_id: string | null; email: string }>(
    "select id, contact_id, lower(email) as email from crm_people where email is not null",
  );
  const contacts = await tx.query<{ id: string; email: string }>("select id, lower(email) as email from contacts where email is not null");
  const known: Known = { people: new Map(), contacts: new Map() };
  for (const row of people.rows) known.people.set(row.email, [...(known.people.get(row.email) ?? []), { personId: row.id, contactId: row.contact_id }]);
  for (const row of contacts.rows) known.contacts.set(row.email, [...(known.contacts.get(row.email) ?? []), row.id]);
  return known;
}

/** The people and companies among the participants, not counting the mailbox's owner; each once. */
export function matchParticipants(known: Known, participants: Participant[], ownAddress: string): Array<{ personId: string | null; contactId: string | null }> {
  const links = new Map<string, { personId: string | null; contactId: string | null }>();
  const own = ownAddress.toLowerCase();
  for (const participant of participants) {
    const email = participant.email.toLowerCase();
    if (email === own) continue;
    for (const person of known.people.get(email) ?? []) links.set(`p${person.personId}`, { personId: person.personId, contactId: person.contactId });
    for (const contactId of known.contacts.get(email) ?? []) {
      if (![...links.values()].some((link) => link.contactId === contactId)) links.set(`c${contactId}`, { personId: null, contactId });
    }
  }
  return [...links.values()];
}

type AccountRow = {
  id: string;
  provider: MailProvider;
  email: string;
  refresh_token_ciphertext: string;
  access_token_ciphertext: string | null;
  access_token_expires_at: string | null;
  messages_synced_until: string | null;
  status: string;
};

/** Syncs one connected account; network calls happen between two short transactions. */
export async function syncAccount(organisation: OrganisationRecord, accountId: string, now = new Date()): Promise<{ messages: number; meetings: number }> {
  const prepared = await withOrganisationTransaction(organisation, SYNC_ACTOR, async (tx) => {
    if (!(await crmEnabled(tx))) throw new ConflictError("The CRM is off.");
    const found = await tx.query<AccountRow>(
      `select id, provider, email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, messages_synced_until, status
         from crm_connected_accounts where id = $1`,
      [accountId],
    );
    const account = found.rows[0];
    if (!account) throw new NotFoundError("Connected account not found.");
    return { account, app: await providerApp(tx, account.provider) };
  });
  const { account, app } = prepared;
  try {
    let accessToken = account.access_token_ciphertext ? decryptSecret(account.access_token_ciphertext) : null;
    let refreshed: { accessToken: string; refreshToken: string | null; expiresInSeconds: number } | null = null;
    if (!accessToken || !account.access_token_expires_at || new Date(account.access_token_expires_at).getTime() < now.getTime() + 60_000) {
      refreshed = await refreshAccess(account.provider, app, decryptSecret(account.refresh_token_ciphertext));
      accessToken = refreshed.accessToken;
    }
    const since = account.messages_synced_until
      ? new Date(new Date(account.messages_synced_until).getTime() - 60 * 60 * 1000)
      : new Date(now.getTime() - FIRST_SYNC_DAYS * 86_400_000);
    const messages = await listMessages(account.provider, accessToken, since);
    const events = await listEvents(
      account.provider,
      accessToken,
      new Date(now.getTime() - FIRST_SYNC_DAYS * 86_400_000),
      new Date(now.getTime() + FIRST_SYNC_DAYS * 86_400_000),
    );
    return await withOrganisationTransaction(organisation, SYNC_ACTOR, async (tx) => {
      const known = await knownAddresses(tx);
      let keptMessages = 0;
      let keptMeetings = 0;
      for (const message of messages) {
        const links = matchParticipants(known, [message.from, ...message.to], account.email);
        if (links.length === 0) continue;
        const direction = message.from.email.toLowerCase() === account.email.toLowerCase() ? "sent" : "received";
        const inserted = await tx.query<{ id: string }>(
          `insert into crm_messages (account_id, external_id, thread_id, direction, sent_at, from_email, from_name, to_emails, subject, preview)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           on conflict (account_id, external_id) do nothing returning id`,
          [
            account.id,
            message.externalId,
            message.threadId,
            direction,
            message.sentAt,
            message.from.email,
            message.from.name,
            message.to.map((p) => p.email),
            message.subject,
            message.preview,
          ],
        );
        const id = inserted.rows[0]?.id;
        if (!id) continue;
        keptMessages += 1;
        for (const link of links) {
          await tx.query("insert into crm_participant_links (message_id, person_id, contact_id) values ($1, $2, $3)", [id, link.personId, link.contactId]);
        }
      }
      for (const event of events) {
        const links = matchParticipants(known, event.attendees, account.email);
        if (links.length === 0) continue;
        const saved = await tx.query<{ id: string; inserted: boolean }>(
          `insert into crm_calendar_events (account_id, external_id, title, starts_at, ends_at, location, attendee_emails)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (account_id, external_id) do update
             set title = excluded.title, starts_at = excluded.starts_at, ends_at = excluded.ends_at, location = excluded.location,
                 attendee_emails = excluded.attendee_emails, updated_at = now()
           returning id, (xmax = 0) as inserted`,
          [account.id, event.externalId, event.title, event.startsAt, event.endsAt, event.location, event.attendees.map((a) => a.email)],
        );
        const { id, inserted } = saved.rows[0];
        if (inserted) keptMeetings += 1;
        await tx.query("delete from crm_participant_links where event_id = $1", [id]);
        for (const link of links) {
          await tx.query("insert into crm_participant_links (event_id, person_id, contact_id) values ($1, $2, $3)", [id, link.personId, link.contactId]);
        }
      }
      const newest = messages.reduce((max, m) => (m.sentAt > max ? m.sentAt : max), account.messages_synced_until ?? since.toISOString());
      await tx.query(
        `update crm_connected_accounts
            set messages_synced_until = greatest(coalesce(messages_synced_until, $2::timestamptz), $2::timestamptz),
                calendar_synced_at = $3, last_sync_at = $3, last_error = null, failures = 0,
                access_token_ciphertext = coalesce($4, access_token_ciphertext),
                access_token_expires_at = coalesce($5, access_token_expires_at),
                refresh_token_ciphertext = coalesce($6, refresh_token_ciphertext), updated_at = now()
          where id = $1`,
        [
          account.id,
          newest,
          now.toISOString(),
          refreshed ? encryptSecret(refreshed.accessToken) : null,
          refreshed ? new Date(now.getTime() + refreshed.expiresInSeconds * 1000).toISOString() : null,
          refreshed?.refreshToken ? encryptSecret(refreshed.refreshToken) : null,
        ],
      );
      return { messages: keptMessages, meetings: keptMeetings };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withOrganisationTransaction(organisation, SYNC_ACTOR, (tx) =>
      tx.query(
        `update crm_connected_accounts
            set failures = failures + 1, last_error = $2, last_sync_at = $3,
                status = case when failures + 1 >= $4 then 'paused' else status end, updated_at = now()
          where id = $1`,
        [account.id, message.slice(0, 500), now.toISOString(), PAUSE_AFTER_FAILURES],
      ),
    );
    throw error;
  }
}

/** "Sync now" for one of the signed-in user's accounts (or any, for an admin). */
export async function accountForSync(tx: OrgTx, idInput: unknown, isAdmin: boolean): Promise<string> {
  await requireCrm(tx);
  const account = await ownAccount(tx, idInput, isAdmin);
  const status = await tx.query<{ status: string }>("select status from crm_connected_accounts where id = $1", [account.id]);
  if (status.rows[0].status === "paused") throw new ConflictError("This mailbox is paused after failed syncs. Connect it again to start syncing.");
  return account.id;
}

let running = false;

/** Syncs every active connected account on the server, one at a time (every 15 minutes). */
export async function syncAllMail(): Promise<{ synced: number; failed: number }> {
  if (running || !secretsAvailable()) return { synced: 0, failed: 0 };
  running = true;
  let synced = 0;
  let failed = 0;
  try {
    for (const organisation of await listAllOrganisations()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      let ids: string[] = [];
      try {
        ids = await withOrganisationTransaction(organisation, SYNC_ACTOR, async (tx) =>
          (await crmEnabled(tx))
            ? (await tx.query<{ id: string }>("select id from crm_connected_accounts where status = 'active' order by last_sync_at nulls first")).rows.map((r) => r.id)
            : [],
        );
      } catch {
        continue;
      }
      for (const id of ids) {
        try {
          await syncAccount(organisation, id);
          synced += 1;
        } catch (error) {
          failed += 1;
          console.warn(`[tohyee] Mail sync failed for ${organisation.id} account ${id}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    return { synced, failed };
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startMailScheduler(): void {
  if (timer) return;
  const tick = () => {
    syncAllMail().catch((error) => console.warn("[tohyee] Mail sync scheduler:", error));
  };
  timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 2 * 60 * 1000).unref?.();
}

// ---------------------------------------------------------------------------
// On the timeline (MAIL6, MAIL7)

export type SyncedEmail = {
  id: string;
  direction: "sent" | "received";
  sentAt: string;
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  subject: string | null;
  preview: string | null;
  mailbox: string;
  private: boolean;
};

export type SyncedMeeting = {
  id: string;
  title: string | null;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  attendeeEmails: string[];
  mailbox: string;
  private: boolean;
};

/** A company's (or person's) synced emails and meetings, hidden to "(private)" where the mailbox's owner chose so and it isn't the viewer's. */
export async function syncedFor(
  tx: OrgTx,
  target: { contactId?: string | null; personId?: string | null },
): Promise<{ emails: SyncedEmail[]; meetings: SyncedMeeting[] }> {
  const params = [target.contactId ?? null, target.personId ?? null, tx.actor.userId ?? ""];
  const where = `(($1::bigint is not null and (l.contact_id = $1 or p.contact_id = $1)) or ($2::bigint is not null and l.person_id = $2))`;
  const emails = await tx.query<{
    id: string;
    direction: "sent" | "received";
    sent_at: string;
    from_email: string;
    from_name: string | null;
    to_emails: string[];
    subject: string | null;
    preview: string | null;
    mailbox: string;
    hidden: boolean;
  }>(
    `select distinct m.id, m.direction, m.sent_at, m.from_email, m.from_name, m.to_emails, m.subject, m.preview, a.email as mailbox,
            (a.visibility = 'metadata' and a.user_id <> $3) as hidden
       from crm_messages m
       join crm_connected_accounts a on a.id = m.account_id
       join crm_participant_links l on l.message_id = m.id
       left join crm_people p on p.id = l.person_id
      where ${where}
      order by m.sent_at desc limit 200`,
    params,
  );
  const meetings = await tx.query<{
    id: string;
    title: string | null;
    starts_at: string;
    ends_at: string | null;
    location: string | null;
    attendee_emails: string[];
    mailbox: string;
    hidden: boolean;
  }>(
    `select distinct e.id, e.title, e.starts_at, e.ends_at, e.location, e.attendee_emails, a.email as mailbox,
            (a.visibility = 'metadata' and a.user_id <> $3) as hidden
       from crm_calendar_events e
       join crm_connected_accounts a on a.id = e.account_id
       join crm_participant_links l on l.event_id = e.id
       left join crm_people p on p.id = l.person_id
      where ${where}
      order by e.starts_at desc limit 200`,
    params,
  );
  return {
    emails: emails.rows.map((row) => ({
      id: row.id,
      direction: row.direction,
      sentAt: new Date(row.sent_at).toISOString(),
      fromEmail: row.from_email,
      fromName: row.from_name,
      toEmails: row.to_emails,
      subject: row.hidden ? "(private)" : row.subject,
      preview: row.hidden ? null : row.preview,
      mailbox: row.mailbox,
      private: row.hidden,
    })),
    meetings: meetings.rows.map((row) => ({
      id: row.id,
      title: row.hidden ? "(private)" : row.title,
      startsAt: new Date(row.starts_at).toISOString(),
      endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null,
      location: row.hidden ? null : row.location,
      attendeeEmails: row.attendee_emails,
      mailbox: row.mailbox,
      private: row.hidden,
    })),
  };
}

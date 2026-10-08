import { writeAuditEvent } from "@/lib/audit";
import { lockStatementAccount } from "@/lib/bank/accounts";
import type { AkahuCredentials } from "@/lib/bank/akahu/client";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { newLoginName, optionalConnectionId, pickLogin } from "@/lib/bank/logins";
import { optionalString, requireId, requireString } from "@/lib/validation";

/**
 * Each organisation's own Akahu personal app (bank feeds, BK15). An
 * organisation admin creates a personal app at my.akahu.nz with the
 * organisation's own bank logins and enters its App ID token and user token
 * here. They're stored encrypted with the server's TOHYEE_SECRET_KEY, in the
 * organisation's own database, and never sent back to the browser.
 */
export const DEFAULT_SYNC_HOURS = 6;

/** One Akahu personal app (a "login", #182 BK30): its name, token hint and how often its accounts sync. */
export type AkahuLogin = {
  connectionId: string;
  name: string;
  appTokenHint: string;
  syncEveryHours: number;
  /** Why its tokens stopped working (BK33), until new ones are saved. */
  tokenProblem: string | null;
  createdAt: string;
  createdByEmail: string | null;
  /** The Tohyee accounts linked through it. */
  linkedAccounts: Array<{ accountId: string; code: string; name: string }>;
};

export type AkahuSettings = {
  configured: boolean;
  /** Every login, oldest first (BK30). */
  logins: AkahuLogin[];
  /** The first login's, as before several logins (#182). */
  appTokenHint: string | null;
  syncEveryHours: number;
  createdAt: string | null;
  createdByEmail: string | null;
  /** False when the server has no TOHYEE_SECRET_KEY, so tokens can't be stored. */
  secretsAvailable: boolean;
};

type ConnectionRow = {
  id: string;
  name: string;
  app_token_ciphertext: string;
  user_token_ciphertext: string;
  app_token_hint: string;
  sync_every_hours: number;
  token_problem: string | null;
  created_at: string;
  created_by_email: string | null;
};

async function activeConnections(tx: OrgTx, lock = false): Promise<ConnectionRow[]> {
  const result = await tx.query<ConnectionRow>(
    `select id::text, name, app_token_ciphertext, user_token_ciphertext, app_token_hint, sync_every_hours, token_problem, created_at, created_by_email
       from akahu_connections where status = 'active' order by id ${lock ? "for update" : ""}`,
  );
  return result.rows;
}

/** The login a command is for: the one chosen, or the only one (`pickLogin`). */
async function activeConnection(tx: OrgTx, connectionId?: unknown, lock = false): Promise<ConnectionRow | null> {
  return pickLogin(await activeConnections(tx, lock), connectionId, "akahu");
}

export async function getAkahuSettings(tx: OrgTx): Promise<AkahuSettings> {
  const rows = await activeConnections(tx);
  const linked = await tx.query<{ connection_id: string; account_id: string; code: string; name: string }>(
    `select s.akahu_connection_id::text as connection_id, a.id::text as account_id, a.code, a.name
       from bank_account_settings s join accounts a on a.id = s.account_id
      where s.akahu_account_id is not null and s.akahu_connection_id is not null order by a.code`,
  );
  const logins = rows.map(
    (row): AkahuLogin => ({
      connectionId: row.id,
      name: row.name,
      appTokenHint: row.app_token_hint,
      syncEveryHours: row.sync_every_hours,
      tokenProblem: row.token_problem,
      createdAt: row.created_at,
      createdByEmail: row.created_by_email,
      linkedAccounts: linked.rows
        .filter((link) => link.connection_id === row.id)
        .map((link) => ({ accountId: link.account_id, code: link.code, name: link.name })),
    }),
  );
  const first = rows[0];
  return {
    configured: rows.length > 0,
    logins,
    appTokenHint: first?.app_token_hint ?? null,
    syncEveryHours: first?.sync_every_hours ?? DEFAULT_SYNC_HOURS,
    createdAt: first?.created_at ?? null,
    createdByEmail: first?.created_by_email ?? null,
    secretsAvailable: secretsAvailable(),
  };
}

function hint(appToken: string): string {
  return `${appToken.slice(0, 10)}…${appToken.slice(-4)}`;
}

export type AkahuSettingsInput = { appToken?: unknown; userToken?: unknown; syncEveryHours?: unknown; connectionId?: unknown; name?: unknown };

/**
 * Checks the tokens someone typed (before anything is stored or sent to
 * Akahu). Blank tokens mean "keep the saved one", so they come back null.
 */
export function parseAkahuSettingsInput(input: AkahuSettingsInput): {
  appToken: string | null;
  userToken: string | null;
  syncEveryHours: number | null;
  connectionId: string | null;
} {
  const appToken = optionalString(input.appToken, "appToken", { maxLength: 200 });
  const userToken = optionalString(input.userToken, "userToken", { maxLength: 500 });
  if (appToken && !/^app_token_[A-Za-z0-9]+$/.test(appToken)) throw new ValidationError("The App ID token should start with app_token_.");
  if (userToken && !/^user_token_[A-Za-z0-9]+$/.test(userToken)) throw new ValidationError("The user token should start with user_token_.");
  let syncEveryHours: number | null = null;
  if (input.syncEveryHours != null && input.syncEveryHours !== "") {
    syncEveryHours = Number(input.syncEveryHours);
    if (!Number.isInteger(syncEveryHours) || syncEveryHours < 1 || syncEveryHours > 24) {
      throw new ValidationError("Sync every must be 1 to 24 hours.");
    }
  }
  return { appToken, userToken, syncEveryHours, connectionId: optionalConnectionId(input.connectionId) };
}

/**
 * The tokens to use after a save: the typed ones, or the saved ones of the
 * login being changed (`connectionId`) where left blank. A new login
 * (`adding`) needs both.
 */
export async function resolveAkahuTokens(
  tx: OrgTx,
  typed: { appToken: string | null; userToken: string | null; connectionId?: string | null },
  options: { adding?: boolean } = {},
): Promise<AkahuCredentials> {
  const row = (typed.appToken && typed.userToken) || options.adding ? null : await activeConnection(tx, typed.connectionId);
  const appToken = typed.appToken ?? (row ? decryptSecret(row.app_token_ciphertext) : null);
  const userToken = typed.userToken ?? (row ? decryptSecret(row.user_token_ciphertext) : null);
  if (!appToken) throw new ValidationError("Enter the App ID token from your Akahu personal app.");
  if (!userToken) throw new ValidationError("Enter the user token from your Akahu personal app.");
  return { appToken, userToken };
}

function requireSecrets(): void {
  if (!secretsAvailable()) {
    throw new UnavailableError(
      "This server has no TOHYEE_SECRET_KEY, so Akahu tokens can't be stored safely. The server admin needs to set it (32+ random characters) and restart Tohyee.",
    );
  }
}

/**
 * Saves an Akahu personal app (admins only; the route checks the tokens with
 * Akahu first and passes the accounts they can see as `visibleAccountIds`).
 * With `adding`, a new login named `name` (BK30); otherwise new tokens for
 * the login `connectionId` (or the only one, or a first one): its linked
 * accounts carry on with them (BK34), except any the new tokens can't see,
 * which stop with "This account isn't in … any more".
 */
export async function saveAkahuSettings(
  tx: OrgTx,
  credentials: AkahuCredentials,
  syncEveryHours: number | null,
  options: { adding?: boolean; connectionId?: string | null; name?: unknown; visibleAccountIds?: readonly string[] } = {},
): Promise<AkahuSettings> {
  requireSecrets();
  const previous = options.adding ? null : await activeConnection(tx, options.connectionId, true);
  const hours = syncEveryHours ?? previous?.sync_every_hours ?? DEFAULT_SYNC_HOURS;
  let connectionId: string;
  let name: string;
  if (previous) {
    connectionId = previous.id;
    name = previous.name;
    await tx.query(
      `update akahu_connections set app_token_ciphertext = $2, user_token_ciphertext = $3, app_token_hint = $4, sync_every_hours = $5, token_problem = null
        where id = $1`,
      [previous.id, encryptSecret(credentials.appToken), encryptSecret(credentials.userToken), hint(credentials.appToken), hours],
    );
  } else {
    name = await newLoginName(tx, "akahu", options.name);
    const inserted = await tx.query<{ id: string }>(
      `insert into akahu_connections (name, app_token_ciphertext, user_token_ciphertext, app_token_hint, sync_every_hours, created_by_email)
       values ($1, $2, $3, $4, $5, $6) returning id::text`,
      [name, encryptSecret(credentials.appToken), encryptSecret(credentials.userToken), hint(credentials.appToken), hours, tx.actor.email],
    );
    connectionId = inserted.rows[0].id;
  }
  let gone: string[] = [];
  if (previous && options.visibleAccountIds) {
    // BK34: accounts the new tokens can't see stop until they're linked again.
    const stopped = await tx.query<{ account_id: string }>(
      `update bank_account_settings
          set feed_active = false, last_sync_status = 'failed', last_sync_error = $3, updated_at = now()
        where akahu_connection_id = $1 and akahu_account_id is not null and not (akahu_account_id = any($2::text[]))
        returning account_id::text`,
      [connectionId, options.visibleAccountIds, `This account isn't in ${name} any more. Link it again to carry on.`],
    );
    gone = stopped.rows.map((row) => row.account_id);
  }
  await writeAuditEvent(tx, {
    eventType: "bank_feed.akahu_saved",
    entityType: "akahu_connection",
    entityId: connectionId,
    details: { name, appTokenHint: hint(credentials.appToken), syncEveryHours: hours, replaced: previous !== null, ...(gone.length ? { stoppedAccounts: gone } : {}) },
  });
  return getAkahuSettings(tx);
}

/**
 * Removes an Akahu login (BK35): its tokens are deleted and the accounts
 * linked through it stop their feeds. Their lines stay. Other logins are
 * untouched.
 */
export async function removeAkahuSettings(tx: OrgTx, connectionIdInput?: unknown): Promise<AkahuSettings> {
  const row = await activeConnection(tx, connectionIdInput, true);
  if (!row) return getAkahuSettings(tx);
  await tx.query("update akahu_connections set status = 'removed', removed_at = now(), removed_by_email = $2 where id = $1", [row.id, tx.actor.email]);
  const stopped = await tx.query(
    `update bank_account_settings
        set akahu_account_id = null, akahu_account_name = null, akahu_connection_name = null, akahu_connection_id = null,
            feed_active = false, updated_at = now()
      where akahu_connection_id = $1`,
    [row.id],
  );
  await writeAuditEvent(tx, {
    eventType: "bank_feed.akahu_removed",
    entityType: "akahu_connection",
    entityId: row.id,
    details: { name: row.name, unlinkedAccounts: stopped.rowCount ?? 0 },
  });
  return getAkahuSettings(tx);
}

/** A login's Akahu credentials (the chosen one, or the only one). Throws when there are none. */
export async function akahuCredentialsFor(
  tx: OrgTx,
  connectionId?: unknown,
): Promise<AkahuCredentials & { syncEveryHours: number; connectionId: string; name: string }> {
  requireSecrets();
  const row = await activeConnection(tx, connectionId);
  if (!row) {
    throw new ValidationError(
      "Bank feeds aren't set up for this organisation yet. An admin can add its Akahu personal app under Bank accounts → Akahu bank feeds.",
    );
  }
  return {
    appToken: decryptSecret(row.app_token_ciphertext),
    userToken: decryptSecret(row.user_token_ciphertext),
    syncEveryHours: row.sync_every_hours,
    connectionId: row.id,
    name: row.name,
  };
}

/** Every active login's credentials, for listing the accounts they can see (BK31). */
export async function allAkahuCredentials(tx: OrgTx): Promise<Array<AkahuCredentials & { connectionId: string; name: string; tokenProblem: string | null }>> {
  requireSecrets();
  return (await activeConnections(tx)).map((row) => ({
    appToken: decryptSecret(row.app_token_ciphertext),
    userToken: decryptSecret(row.user_token_ciphertext),
    connectionId: row.id,
    name: row.name,
    tokenProblem: row.token_problem,
  }));
}

/** The credentials and link for syncing one account: always its own login's (BK32). */
export async function akahuCredentialsForAccount(
  tx: OrgTx,
  accountId: string,
): Promise<{ credentials: AkahuCredentials; akahuAccountId: string; startDate: string; connectionId: string; loginName: string }> {
  const settings = await tx.query<{ akahu_account_id: string | null; feed_start_date: string | null; feed_active: boolean; akahu_connection_id: string | null }>(
    "select akahu_account_id, feed_start_date::text, feed_active, akahu_connection_id::text from bank_account_settings where account_id = $1",
    [accountId],
  );
  const link = settings.rows[0];
  if (!link?.akahu_account_id || !link.feed_active || !link.feed_start_date) {
    throw new ValidationError("This account isn't linked to a bank feed.");
  }
  if (!link.akahu_connection_id) throw new ValidationError("This account's Akahu login was removed. Link it again.");
  const login = await akahuCredentialsFor(tx, link.akahu_connection_id).catch((error: unknown) => {
    if (error instanceof NotFoundError) throw new ValidationError("This account's Akahu login was removed. Link it again.");
    throw error;
  });
  return {
    credentials: { appToken: login.appToken, userToken: login.userToken },
    akahuAccountId: link.akahu_account_id,
    startDate: link.feed_start_date,
    connectionId: login.connectionId,
    loginName: login.name,
  };
}

/** BK33: a login's tokens were refused, so its accounts say so until new tokens are saved. Other logins carry on. */
export async function markAkahuTokenProblem(tx: OrgTx, connectionId: string): Promise<string> {
  const row = (await tx.query<{ name: string }>("select name from akahu_connections where id = $1", [connectionId])).rows[0];
  const message = `${row?.name ?? "This Akahu login"} needs new tokens.`;
  await tx.query("update akahu_connections set token_problem = $2 where id = $1 and status = 'active'", [connectionId, message]);
  return message;
}

/** Links an Akahu account to a bank or credit card account, with the first date to bring in. */
export async function linkBankFeed(
  tx: OrgTx,
  accountIdInput: unknown,
  input: { akahuAccountId: unknown; akahuAccountName?: unknown; connectionName?: unknown; startDate: unknown; connectionId?: unknown },
): Promise<void> {
  const accountId = requireId(accountIdInput, "accountId");
  const akahuAccountId = requireString(input.akahuAccountId, "akahuAccountId", { maxLength: 100 });
  if (!/^acc_[A-Za-z0-9]+$/.test(akahuAccountId)) throw new ValidationError("That isn't an Akahu account id.");
  const startDate = parseIsoDate(input.startDate, "startDate");
  const account = await lockStatementAccount(tx, accountId, "feed");
  // BK36: one Tohyee account per Akahu account, even when two logins can both see it (a joint account).
  const taken = await tx.query<{ code: string; name: string }>(
    `select a.code, a.name from bank_account_settings s join accounts a on a.id = s.account_id
      where s.akahu_account_id = $1 and s.account_id <> $2`,
    [akahuAccountId, accountId],
  );
  if (taken.rows[0]) throw new ValidationError(`That Akahu account is already linked to ${taken.rows[0].code} ${taken.rows[0].name}.`);
  const other = await tx.query<{ feed: string }>(
    "select 'SimpleFIN' as feed from simplefin_links where account_id = $1 and active union all select 'Stripe' from stripe_links where account_id = $1 and active union all select 'PayPal' from paypal_links where account_id = $1 and active union all select 'Wise' from wise_links where account_id = $1 and active",
    [accountId],
  );
  if (other.rows[0]) throw new ValidationError(`${account.code} is linked to ${other.rows[0].feed}. Unlink it first.`);
  const login = await activeConnection(tx, input.connectionId);
  if (!login) throw new ValidationError("Add an Akahu login first (Bank accounts → Akahu bank feeds).");
  await tx.query(
    `update bank_account_settings
        set akahu_account_id = $2, akahu_account_name = $3, akahu_connection_name = $4, feed_start_date = $5,
            feed_active = true, last_sync_status = 'never', last_sync_error = null, akahu_connection_id = $6, updated_at = now()
      where account_id = $1`,
    [
      accountId,
      akahuAccountId,
      optionalString(input.akahuAccountName, "akahuAccountName", { maxLength: 200 }),
      optionalString(input.connectionName, "connectionName", { maxLength: 200 }),
      startDate,
      login.id,
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "bank_feed.linked",
    entityType: "account",
    entityId: accountId,
    details: { accountCode: account.code, akahuAccountId, startDate, login: login.name },
  });
}

/** Stops an account's bank feed. Lines already brought in stay. */
export async function unlinkBankFeed(tx: OrgTx, accountIdInput: unknown): Promise<void> {
  const accountId = requireId(accountIdInput, "accountId");
  const result = await tx.query(
    `update bank_account_settings
        set akahu_account_id = null, akahu_account_name = null, akahu_connection_name = null, akahu_connection_id = null,
            feed_active = false, updated_at = now()
      where account_id = $1`,
    [accountId],
  );
  if (result.rowCount === 0) throw new NotFoundError("This account has no bank feed.");
  await writeAuditEvent(tx, { eventType: "bank_feed.unlinked", entityType: "account", entityId: accountId });
}

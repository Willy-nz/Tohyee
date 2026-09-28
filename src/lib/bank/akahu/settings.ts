import { writeAdminAuditEvent, writeAuditEvent } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/guard";
import { lockStatementAccount } from "@/lib/bank/accounts";
import type { AkahuCredentials } from "@/lib/bank/akahu/client";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { ForbiddenError, NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { optionalString, requireId, requireOneOf, requireString } from "@/lib/validation";

/**
 * The server's Akahu app, set up once by a server admin (bank feeds, BK15):
 * - personal mode: the admin's own Akahu personal app (App ID token and user
 *   token). Only server admins can link its accounts to an organisation's
 *   bank accounts, because it reaches the admin's own bank logins.
 * - OAuth mode: a full Akahu app (App ID token and App secret). Each
 *   organisation connects its own banks through Akahu's consent screen.
 * Secrets are encrypted with TOHYEE_SECRET_KEY and never sent to the browser.
 */
export type AkahuMode = "personal" | "oauth";

export type AkahuServerSettings = {
  mode: AkahuMode | null;
  appTokenHint: string | null;
  hasUserToken: boolean;
  hasAppSecret: boolean;
  redirectUri: string | null;
  syncEveryHours: number;
  secretsAvailable: boolean;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

type StoredValue = { mode?: AkahuMode; appToken?: string; redirectUri?: string; syncEveryHours?: number };
type StoredSecrets = { userToken?: string; appSecret?: string };

export const DEFAULT_SYNC_HOURS = 6;

async function readStored(): Promise<{ value: StoredValue; secrets: StoredSecrets; updatedAt: string | null; updatedByEmail: string | null }> {
  const result = await coreQuery<{ value: StoredValue; secret_ciphertext: string | null; updated_at: string; updated_by_email: string | null }>(
    "select value, secret_ciphertext, updated_at, updated_by_email from server_settings where key = 'akahu'",
  );
  const row = result.rows[0];
  if (!row) return { value: {}, secrets: {}, updatedAt: null, updatedByEmail: null };
  let secrets: StoredSecrets = {};
  if (row.secret_ciphertext && secretsAvailable()) {
    try {
      secrets = JSON.parse(decryptSecret(row.secret_ciphertext)) as StoredSecrets;
    } catch {
      secrets = {};
    }
  }
  return { value: row.value ?? {}, secrets, updatedAt: row.updated_at, updatedByEmail: row.updated_by_email };
}

export async function getAkahuServerSettings(): Promise<AkahuServerSettings> {
  const stored = await readStored();
  const token = stored.value.appToken ?? null;
  return {
    mode: stored.value.mode ?? null,
    appTokenHint: token ? `${token.slice(0, 10)}…${token.slice(-4)}` : null,
    hasUserToken: Boolean(stored.secrets.userToken),
    hasAppSecret: Boolean(stored.secrets.appSecret),
    redirectUri: stored.value.redirectUri ?? null,
    syncEveryHours: stored.value.syncEveryHours ?? DEFAULT_SYNC_HOURS,
    secretsAvailable: secretsAvailable(),
    updatedAt: stored.updatedAt,
    updatedByEmail: stored.updatedByEmail,
  };
}

/** The decrypted server config, for syncs and OAuth. Throws when Akahu isn't set up. */
export async function akahuServerConfig(): Promise<{
  mode: AkahuMode;
  appToken: string;
  userToken: string | null;
  appSecret: string | null;
  redirectUri: string | null;
  syncEveryHours: number;
}> {
  if (!secretsAvailable()) {
    throw new UnavailableError("The server has no TOHYEE_SECRET_KEY, so bank feeds can't be used. A server admin needs to set it.");
  }
  const stored = await readStored();
  if (!stored.value.mode || !stored.value.appToken) {
    throw new UnavailableError("Bank feeds aren't set up on this server yet. A server admin can add the Akahu app under Server > Bank feeds.");
  }
  return {
    mode: stored.value.mode,
    appToken: stored.value.appToken,
    userToken: stored.secrets.userToken ?? null,
    appSecret: stored.secrets.appSecret ?? null,
    redirectUri: stored.value.redirectUri ?? null,
    syncEveryHours: stored.value.syncEveryHours ?? DEFAULT_SYNC_HOURS,
  };
}

/**
 * Saves the Akahu app (server admins only). Blank secrets keep the ones
 * already stored; `clear: true` removes everything.
 */
export async function updateAkahuServerSettings(
  auth: AuthContext,
  input: {
    mode?: unknown;
    appToken?: unknown;
    userToken?: unknown;
    appSecret?: unknown;
    redirectUri?: unknown;
    syncEveryHours?: unknown;
    clear?: unknown;
  },
): Promise<AkahuServerSettings> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can set up bank feeds.");
  if (input.clear === true) {
    await withCoreTransaction(async (client) => {
      await client.query("delete from server_settings where key = 'akahu'");
      await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
        eventType: "server.akahu_cleared",
        entityType: "server_setting",
        entityId: "akahu",
      });
    });
    return getAkahuServerSettings();
  }
  if (!secretsAvailable()) {
    throw new UnavailableError(
      "Set TOHYEE_SECRET_KEY (a random value of at least 32 characters) in the server's environment and restart Tohyee first, so the Akahu tokens can be stored encrypted.",
    );
  }
  const mode = requireOneOf(input.mode, "mode", ["personal", "oauth"] as const);
  const stored = await readStored();
  const appTokenInput = optionalString(input.appToken, "appToken", { maxLength: 200 });
  const appToken = appTokenInput ?? stored.value.appToken;
  if (!appToken) throw new ValidationError("Enter the Akahu App ID token.");
  if (!/^app_token_[A-Za-z0-9]+$/.test(appToken)) throw new ValidationError("The App ID token should start with app_token_.");
  const userToken = optionalString(input.userToken, "userToken", { maxLength: 500 }) ?? stored.secrets.userToken;
  const appSecret = optionalString(input.appSecret, "appSecret", { maxLength: 500 }) ?? stored.secrets.appSecret;
  if (userToken && !/^user_token_[A-Za-z0-9]+$/.test(userToken)) throw new ValidationError("The user token should start with user_token_.");
  let redirectUri = optionalString(input.redirectUri, "redirectUri", { maxLength: 500 }) ?? stored.value.redirectUri ?? null;
  if (mode === "personal" && !userToken) throw new ValidationError("A personal app needs its user token.");
  if (mode === "oauth") {
    if (!appSecret) throw new ValidationError("A full Akahu app needs its App secret.");
    if (!redirectUri) throw new ValidationError("A full Akahu app needs the redirect URL registered with Akahu.");
  }
  if (redirectUri) {
    let url: URL;
    try {
      url = new URL(redirectUri);
    } catch {
      throw new ValidationError("The redirect URL isn't a valid URL.");
    }
    if (url.protocol !== "https:" && url.hostname !== "localhost") throw new ValidationError("The redirect URL must use https.");
    if (!url.pathname.endsWith("/api/bank-feeds/akahu/callback")) {
      throw new ValidationError("The redirect URL must end with /api/bank-feeds/akahu/callback (this server's address first).");
    }
    redirectUri = url.toString();
  }
  const hoursRaw = input.syncEveryHours == null || input.syncEveryHours === "" ? stored.value.syncEveryHours ?? DEFAULT_SYNC_HOURS : Number(input.syncEveryHours);
  if (!Number.isInteger(hoursRaw) || hoursRaw < 1 || hoursRaw > 24) throw new ValidationError("Sync every must be 1 to 24 hours.");
  const value: StoredValue = { mode, appToken, redirectUri: redirectUri ?? undefined, syncEveryHours: hoursRaw };
  const secrets: StoredSecrets = { userToken: userToken ?? undefined, appSecret: appSecret ?? undefined };
  await withCoreTransaction(async (client) => {
    await client.query(
      `insert into server_settings (key, value, secret_ciphertext, updated_by_email, updated_at)
       values ('akahu', $1::jsonb, $2, $3, now())
       on conflict (key) do update set value = excluded.value, secret_ciphertext = excluded.secret_ciphertext,
                                       updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [JSON.stringify(value), encryptSecret(JSON.stringify(secrets)), auth.user.email],
    );
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "server.akahu_updated",
      entityType: "server_setting",
      entityId: "akahu",
      details: { mode, redirectUri, syncEveryHours: hoursRaw, userTokenChanged: Boolean(input.userToken), appSecretChanged: Boolean(input.appSecret) },
    });
  });
  return getAkahuServerSettings();
}

/**
 * The credentials an organisation uses: the admin's personal app (server
 * admins only), or the organisation's own OAuth consent. `connectionId` is
 * the consent used, when there is one.
 */
export async function akahuCredentialsFor(
  tx: OrgTx,
  auth: AuthContext | null,
): Promise<{ credentials: AkahuCredentials; connectionId: string | null; mode: AkahuMode }> {
  const config = await akahuServerConfig();
  if (config.mode === "personal") {
    if (auth && !auth.user.isServerAdmin) {
      throw new ForbiddenError("This server's bank feeds use the server admin's own Akahu app, so only a server admin can manage them.");
    }
    if (!config.userToken) throw new UnavailableError("The server's Akahu personal app has no user token.");
    return { credentials: { appToken: config.appToken, userToken: config.userToken }, connectionId: null, mode: "personal" };
  }
  const connection = await tx.query<{ id: string; token_ciphertext: string }>(
    "select id, token_ciphertext from akahu_connections where status = 'active' order by id desc limit 1",
  );
  const row = connection.rows[0];
  if (!row) throw new ValidationError("This organisation hasn't connected its banks through Akahu yet. Use Connect banks first.");
  return { credentials: { appToken: config.appToken, userToken: decryptSecret(row.token_ciphertext) }, connectionId: row.id, mode: "oauth" };
}

/** The credentials for syncing one linked account (no user: the scheduler, or a sync button). */
export async function akahuCredentialsForAccount(
  tx: OrgTx,
  accountId: string,
): Promise<{ credentials: AkahuCredentials; akahuAccountId: string; startDate: string; statementBalanceAt: string | null }> {
  const settings = await tx.query<{ akahu_account_id: string | null; akahu_connection_id: string | null; feed_start_date: string | null; feed_active: boolean }>(
    "select akahu_account_id, akahu_connection_id, feed_start_date::text, feed_active from bank_account_settings where account_id = $1",
    [accountId],
  );
  const link = settings.rows[0];
  if (!link?.akahu_account_id || !link.feed_active || !link.feed_start_date) {
    throw new ValidationError("This account isn't linked to a bank feed.");
  }
  const config = await akahuServerConfig();
  if (config.mode === "personal") {
    if (!config.userToken) throw new UnavailableError("The server's Akahu personal app has no user token.");
    return { credentials: { appToken: config.appToken, userToken: config.userToken }, akahuAccountId: link.akahu_account_id, startDate: link.feed_start_date, statementBalanceAt: null };
  }
  const connection = await tx.query<{ token_ciphertext: string; status: string }>(
    "select token_ciphertext, status from akahu_connections where id = $1",
    [link.akahu_connection_id],
  );
  const row = connection.rows[0];
  if (!row || row.status !== "active") throw new ValidationError("The Akahu consent this feed used was revoked. Connect banks again and relink.");
  return {
    credentials: { appToken: config.appToken, userToken: decryptSecret(row.token_ciphertext) },
    akahuAccountId: link.akahu_account_id,
    startDate: link.feed_start_date,
    statementBalanceAt: null,
  };
}

/** Links an Akahu account to a bank or credit card account, with the first date to bring in. */
export async function linkBankFeed(
  tx: OrgTx,
  accountIdInput: unknown,
  input: { akahuAccountId: unknown; akahuAccountName?: unknown; connectionName?: unknown; startDate: unknown; connectionId: string | null },
): Promise<void> {
  const accountId = requireId(accountIdInput, "accountId");
  const akahuAccountId = requireString(input.akahuAccountId, "akahuAccountId", { maxLength: 100 });
  if (!/^acc_[A-Za-z0-9]+$/.test(akahuAccountId)) throw new ValidationError("That isn't an Akahu account id.");
  const startDate = parseIsoDate(input.startDate, "startDate");
  const account = await lockStatementAccount(tx, accountId);
  const taken = await tx.query<{ account_id: string }>(
    "select account_id from bank_account_settings where akahu_account_id = $1 and account_id <> $2",
    [akahuAccountId, accountId],
  );
  if (taken.rows[0]) throw new ValidationError("That Akahu account is already linked to another bank account.");
  await tx.query(
    `update bank_account_settings
        set akahu_account_id = $2, akahu_account_name = $3, akahu_connection_name = $4, feed_start_date = $5,
            akahu_connection_id = $6, feed_active = true, last_sync_status = 'never', last_sync_error = null, updated_at = now()
      where account_id = $1`,
    [
      accountId,
      akahuAccountId,
      optionalString(input.akahuAccountName, "akahuAccountName", { maxLength: 200 }),
      optionalString(input.connectionName, "connectionName", { maxLength: 200 }),
      startDate,
      input.connectionId,
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "bank_feed.linked",
    entityType: "account",
    entityId: accountId,
    details: { accountCode: account.code, akahuAccountId, startDate },
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

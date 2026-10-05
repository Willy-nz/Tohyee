import { writeAuditEvent } from "@/lib/audit";
import { lockStatementAccount } from "@/lib/bank/accounts";
import type { AkahuCredentials } from "@/lib/bank/akahu/client";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { optionalString, requireId, requireString } from "@/lib/validation";

/**
 * Each organisation's own Akahu personal app (bank feeds, BK15). An
 * organisation admin creates a personal app at my.akahu.nz with the
 * organisation's own bank logins and enters its App ID token and user token
 * here. They're stored encrypted with the server's TOHYEE_SECRET_KEY, in the
 * organisation's own database, and never sent back to the browser.
 */
export const DEFAULT_SYNC_HOURS = 6;

export type AkahuSettings = {
  configured: boolean;
  appTokenHint: string | null;
  syncEveryHours: number;
  createdAt: string | null;
  createdByEmail: string | null;
  /** False when the server has no TOHYEE_SECRET_KEY, so tokens can't be stored. */
  secretsAvailable: boolean;
};

type ConnectionRow = {
  id: string;
  app_token_ciphertext: string;
  user_token_ciphertext: string;
  app_token_hint: string;
  sync_every_hours: number;
  created_at: string;
  created_by_email: string | null;
};

async function activeConnection(tx: OrgTx): Promise<ConnectionRow | null> {
  const result = await tx.query<ConnectionRow>(
    `select id, app_token_ciphertext, user_token_ciphertext, app_token_hint, sync_every_hours, created_at, created_by_email
       from akahu_connections where status = 'active'`,
  );
  return result.rows[0] ?? null;
}

export async function getAkahuSettings(tx: OrgTx): Promise<AkahuSettings> {
  const row = await activeConnection(tx);
  return {
    configured: row !== null,
    appTokenHint: row?.app_token_hint ?? null,
    syncEveryHours: row?.sync_every_hours ?? DEFAULT_SYNC_HOURS,
    createdAt: row?.created_at ?? null,
    createdByEmail: row?.created_by_email ?? null,
    secretsAvailable: secretsAvailable(),
  };
}

function hint(appToken: string): string {
  return `${appToken.slice(0, 10)}…${appToken.slice(-4)}`;
}

export type AkahuSettingsInput = { appToken?: unknown; userToken?: unknown; syncEveryHours?: unknown };

/**
 * Checks the tokens someone typed (before anything is stored or sent to
 * Akahu). Blank tokens mean "keep the saved one", so they come back null.
 */
export function parseAkahuSettingsInput(input: AkahuSettingsInput): {
  appToken: string | null;
  userToken: string | null;
  syncEveryHours: number | null;
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
  return { appToken, userToken, syncEveryHours };
}

/** The tokens to use after a save: the typed ones, or the saved ones where left blank. */
export async function resolveAkahuTokens(
  tx: OrgTx,
  typed: { appToken: string | null; userToken: string | null },
): Promise<AkahuCredentials> {
  const row = typed.appToken && typed.userToken ? null : await activeConnection(tx);
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
 * Saves the organisation's Akahu personal app (admins only; the route checks
 * the tokens with Akahu first). The previous tokens are removed. Linked
 * accounts carry on with the new tokens.
 */
export async function saveAkahuSettings(
  tx: OrgTx,
  credentials: AkahuCredentials,
  syncEveryHours: number | null,
): Promise<AkahuSettings> {
  requireSecrets();
  const previous = await activeConnection(tx);
  const hours = syncEveryHours ?? previous?.sync_every_hours ?? DEFAULT_SYNC_HOURS;
  await tx.query(
    "update akahu_connections set status = 'removed', removed_at = now(), removed_by_email = $1 where status = 'active'",
    [tx.actor.email],
  );
  const inserted = await tx.query<{ id: string }>(
    `insert into akahu_connections (app_token_ciphertext, user_token_ciphertext, app_token_hint, sync_every_hours, created_by_email)
     values ($1, $2, $3, $4, $5) returning id`,
    [encryptSecret(credentials.appToken), encryptSecret(credentials.userToken), hint(credentials.appToken), hours, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "bank_feed.akahu_saved",
    entityType: "akahu_connection",
    entityId: inserted.rows[0].id,
    details: { appTokenHint: hint(credentials.appToken), syncEveryHours: hours, replaced: previous !== null },
  });
  return getAkahuSettings(tx);
}

/** Removes the organisation's Akahu tokens. Linked accounts stay linked but can't sync until new tokens are saved. */
export async function removeAkahuSettings(tx: OrgTx): Promise<AkahuSettings> {
  const removed = await tx.query<{ id: string }>(
    "update akahu_connections set status = 'removed', removed_at = now(), removed_by_email = $1 where status = 'active' returning id",
    [tx.actor.email],
  );
  for (const row of removed.rows) {
    await writeAuditEvent(tx, { eventType: "bank_feed.akahu_removed", entityType: "akahu_connection", entityId: row.id });
  }
  return getAkahuSettings(tx);
}

/** The organisation's Akahu credentials. Throws when they aren't set up. */
export async function akahuCredentialsFor(tx: OrgTx): Promise<AkahuCredentials & { syncEveryHours: number }> {
  requireSecrets();
  const row = await activeConnection(tx);
  if (!row) {
    throw new ValidationError(
      "Bank feeds aren't set up for this organisation yet. An admin can add its Akahu personal app under Bank accounts → Akahu bank feeds.",
    );
  }
  return {
    appToken: decryptSecret(row.app_token_ciphertext),
    userToken: decryptSecret(row.user_token_ciphertext),
    syncEveryHours: row.sync_every_hours,
  };
}

/** The credentials and link for syncing one account. */
export async function akahuCredentialsForAccount(
  tx: OrgTx,
  accountId: string,
): Promise<{ credentials: AkahuCredentials; akahuAccountId: string; startDate: string }> {
  const settings = await tx.query<{ akahu_account_id: string | null; feed_start_date: string | null; feed_active: boolean }>(
    "select akahu_account_id, feed_start_date::text, feed_active from bank_account_settings where account_id = $1",
    [accountId],
  );
  const link = settings.rows[0];
  if (!link?.akahu_account_id || !link.feed_active || !link.feed_start_date) {
    throw new ValidationError("This account isn't linked to a bank feed.");
  }
  const { appToken, userToken } = await akahuCredentialsFor(tx);
  return { credentials: { appToken, userToken }, akahuAccountId: link.akahu_account_id, startDate: link.feed_start_date };
}

/** Links an Akahu account to a bank or credit card account, with the first date to bring in. */
export async function linkBankFeed(
  tx: OrgTx,
  accountIdInput: unknown,
  input: { akahuAccountId: unknown; akahuAccountName?: unknown; connectionName?: unknown; startDate: unknown },
): Promise<void> {
  const accountId = requireId(accountIdInput, "accountId");
  const akahuAccountId = requireString(input.akahuAccountId, "akahuAccountId", { maxLength: 100 });
  if (!/^acc_[A-Za-z0-9]+$/.test(akahuAccountId)) throw new ValidationError("That isn't an Akahu account id.");
  const startDate = parseIsoDate(input.startDate, "startDate");
  const account = await lockStatementAccount(tx, accountId, "feed");
  const taken = await tx.query<{ account_id: string }>(
    "select account_id from bank_account_settings where akahu_account_id = $1 and account_id <> $2",
    [akahuAccountId, accountId],
  );
  if (taken.rows[0]) throw new ValidationError("That Akahu account is already linked to another bank account.");
  const simplefin = await tx.query("select 1 from simplefin_links where account_id = $1 and active", [accountId]);
  if (simplefin.rowCount) throw new ValidationError(`${account.code} is linked to SimpleFIN. Unlink it first.`);
  await tx.query(
    `update bank_account_settings
        set akahu_account_id = $2, akahu_account_name = $3, akahu_connection_name = $4, feed_start_date = $5,
            feed_active = true, last_sync_status = 'never', last_sync_error = null, updated_at = now()
      where account_id = $1`,
    [
      accountId,
      akahuAccountId,
      optionalString(input.akahuAccountName, "akahuAccountName", { maxLength: 200 }),
      optionalString(input.connectionName, "connectionName", { maxLength: 200 }),
      startDate,
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
        set akahu_account_id = null, akahu_account_name = null, akahu_connection_name = null,
            feed_active = false, updated_at = now()
      where account_id = $1`,
    [accountId],
  );
  if (result.rowCount === 0) throw new NotFoundError("This account has no bank feed.");
  await writeAuditEvent(tx, { eventType: "bank_feed.unlinked", entityType: "account", entityId: accountId });
}

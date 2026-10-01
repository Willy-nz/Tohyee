import { randomBytes } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { createContact, updateContact } from "@/lib/contacts/service";
import { type Actor, type OrgTx, assertOrganisationUsable, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, HttpError, NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { ITEM_CODE_PATTERN, createItem, updateItem } from "@/lib/items/service";
import { dec, toPlainString } from "@/lib/money/decimal";
import { listAllOrganisations } from "@/lib/organisations/admin";
import { type OrganisationRecord, getOrganisation, parseOrganisationId } from "@/lib/organisations/registry";
import {
  type AccessToken,
  type ConnectorContext,
  type PlatformCustomer,
  type PlatformVariant,
  PlatformError,
  type SalesPlatformConnector,
} from "@/lib/sales-platforms/connector";
import { itemNameFor, mergeField, priceCopyable } from "@/lib/sales-platforms/merge";
import { shopifyConnector } from "@/lib/sales-platforms/shopify";
import {
  SALES_PLATFORMS,
  SALES_PLATFORM_LABELS,
  type SalesPlatform,
  type SalesPlatformConnection,
  type SyncLogAction,
  type SyncLogEntry,
  type SyncResult,
} from "@/lib/sales-platforms/types";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { optionalBoolean, requireId, requireOneOf } from "@/lib/validation";

/**
 * Sales platform connections (examples SPC1-SPC10 in
 * docs/ACCOUNTING-EXAMPLES.md): connecting a store, the catch-up sync,
 * webhooks and disconnecting. Customers become contacts and products'
 * variants become items; nothing here posts to the ledger.
 *
 * Like CRM mail sync, nothing calls the platform inside a database
 * transaction: what's needed is read in one short transaction, the platform
 * is called with nothing open, and the result is written in a second.
 */

const CONNECTORS: Record<SalesPlatform, SalesPlatformConnector> = { shopify: shopifyConnector };

/** Who the catch-up sync and webhooks act as (in the audit trail and the sync log). */
export const SALES_PLATFORM_ACTOR: Actor = { userId: null, email: "sales-platform-sync@tohyee" };

/** The command source of contacts and items brought in from a platform. */
const SOURCE = "sales-platform";
const PAUSE_AFTER_FAILURES = 3;
const LOG_PAGE = 200;

type ConnectionRow = {
  id: string;
  platform: SalesPlatform;
  store_domain: string;
  store_name: string | null;
  store_currency: string | null;
  prices_include_tax: boolean | null;
  auth_method: string;
  credentials_ciphertext: string | null;
  access_token_ciphertext: string | null;
  access_token_expires_at: string | null;
  webhook_key: string;
  webhook_subscription_ids: string[];
  webhooks_note: string | null;
  sync_customers: boolean;
  sync_products: boolean;
  status: "active" | "paused" | "disconnected";
  customers_synced_until: string | null;
  products_synced_until: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  failures: number;
  connected_by_email: string;
  connected_at: string;
  disconnected_by_email: string | null;
  disconnected_at: string | null;
};

const COLUMNS =
  "id, platform, store_domain, store_name, store_currency, prices_include_tax, auth_method, credentials_ciphertext, " +
  "access_token_ciphertext, access_token_expires_at, webhook_key, webhook_subscription_ids, webhooks_note, sync_customers, " +
  "sync_products, status, customers_synced_until, products_synced_until, last_sync_at, last_error, failures, connected_by_email, " +
  "connected_at, disconnected_by_email, disconnected_at";

const iso = (value: string | null): string | null => (value === null ? null : new Date(value).toISOString());

function toConnection(row: ConnectionRow): SalesPlatformConnection {
  return {
    id: row.id,
    platform: row.platform,
    storeDomain: row.store_domain,
    storeName: row.store_name,
    storeCurrency: row.store_currency,
    pricesIncludeTax: row.prices_include_tax,
    authMethod: row.auth_method,
    syncCustomers: row.sync_customers,
    syncProducts: row.sync_products,
    status: row.status,
    lastSyncAt: iso(row.last_sync_at),
    lastError: row.last_error,
    failures: row.failures,
    webhooksActive: row.webhook_subscription_ids.length > 0,
    webhooksNote: row.webhooks_note,
    connectedByEmail: row.connected_by_email,
    connectedAt: iso(row.connected_at)!,
    disconnectedByEmail: row.disconnected_by_email,
    disconnectedAt: iso(row.disconnected_at),
  };
}

function connectorFor(platform: string): SalesPlatformConnector {
  const connector = CONNECTORS[platform as SalesPlatform];
  if (!connector) throw new ValidationError(`Tohyee can't connect to ${platform} yet.`);
  return connector;
}

const label = (platform: SalesPlatform): string => SALES_PLATFORM_LABELS[platform];

export async function listConnections(tx: OrgTx): Promise<SalesPlatformConnection[]> {
  const result = await tx.query<ConnectionRow>(
    `select ${COLUMNS} from sales_platform_connections order by (status = 'disconnected'), id desc`,
  );
  return result.rows.map(toConnection);
}

async function readConnection(tx: OrgTx, idInput: unknown, options: { lock?: boolean } = {}): Promise<ConnectionRow> {
  const id = requireId(idInput, "connectionId");
  const result = await tx.query<ConnectionRow>(
    `select ${COLUMNS} from sales_platform_connections where id = $1${options.lock ? " for update" : ""}`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("That sales platform connection wasn't found.");
  return row;
}

function assertConnected(row: ConnectionRow): void {
  if (row.status === "disconnected") {
    throw new ConflictError(`This ${label(row.platform)} connection is disconnected. Connect the store again to sync it.`);
  }
}

type LogInput = {
  source: SyncLogEntry["source"];
  action: SyncLogAction;
  message: string;
  recordKind?: "customer" | "product_variant" | null;
  externalId?: string | null;
  contactId?: string | null;
  itemId?: string | null;
};

/**
 * Adds a line to the sync log. A skipped or failed record whose last line
 * says the same thing isn't logged again, so the catch-up sync doesn't fill
 * the log with the same line every 15 minutes (SPC4).
 */
async function writeLog(tx: OrgTx, connectionId: string, entry: LogInput): Promise<boolean> {
  const message = entry.message.length > 1000 ? `${entry.message.slice(0, 997)}...` : entry.message;
  if ((entry.action === "skipped" || entry.action === "failed" || entry.action === "kept") && entry.externalId) {
    const last = await tx.query<{ action: string; message: string }>(
      `select action, message from sales_platform_sync_log
        where connection_id = $1 and record_kind is not distinct from $2 and external_id = $3
        order by id desc limit 1`,
      [connectionId, entry.recordKind ?? null, entry.externalId],
    );
    if (last.rows[0]?.action === entry.action && last.rows[0].message === message) return false;
  }
  await tx.query(
    `insert into sales_platform_sync_log (connection_id, source, action, record_kind, external_id, contact_id, item_id, message, actor_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      connectionId,
      entry.source,
      entry.action,
      entry.recordKind ?? null,
      entry.externalId ?? null,
      entry.contactId ?? null,
      entry.itemId ?? null,
      message,
      tx.actor.email,
    ],
  );
  return true;
}

/** The sync log, newest first (viewers can read it). */
export async function listSyncLog(
  tx: OrgTx,
  connectionIdInput: unknown,
  options: { beforeId?: unknown } = {},
): Promise<{ connection: SalesPlatformConnection; entries: SyncLogEntry[] }> {
  const connection = await readConnection(tx, connectionIdInput);
  const beforeId = options.beforeId === undefined || options.beforeId === null || options.beforeId === "" ? null : requireId(options.beforeId, "beforeId");
  const result = await tx.query<{
    id: string;
    logged_at: string;
    source: SyncLogEntry["source"];
    action: SyncLogAction;
    record_kind: SyncLogEntry["recordKind"];
    external_id: string | null;
    contact_id: string | null;
    item_id: string | null;
    message: string;
    actor_email: string;
  }>(
    `select id, logged_at, source, action, record_kind, external_id, contact_id, item_id, message, actor_email
       from sales_platform_sync_log
      where connection_id = $1 and ($2::bigint is null or id < $2::bigint)
      order by id desc limit ${LOG_PAGE}`,
    [connection.id, beforeId],
  );
  return {
    connection: toConnection(connection),
    entries: result.rows.map((row) => ({
      id: row.id,
      loggedAt: iso(row.logged_at)!,
      source: row.source,
      action: row.action,
      recordKind: row.record_kind,
      externalId: row.external_id,
      contactId: row.contact_id,
      itemId: row.item_id,
      message: row.message,
      actorEmail: row.actor_email,
    })),
  };
}

// ---------------------------------------------------------------------------
// Credentials

function requireSecrets(): void {
  if (!secretsAvailable()) {
    throw new UnavailableError(
      "Connecting a sales platform needs TOHYEE_SECRET_KEY set on the server, so the store's credentials can be stored encrypted. Ask whoever runs the server.",
    );
  }
}

function credentialsOf(row: ConnectionRow): Record<string, string> {
  if (row.credentials_ciphertext === null) assertConnected({ ...row, status: "disconnected" });
  return JSON.parse(decryptSecret(row.credentials_ciphertext!)) as Record<string, string>;
}

function contextFor(row: ConnectionRow, now: Date): ConnectorContext {
  const cachedToken =
    row.access_token_ciphertext && row.access_token_expires_at
      ? { token: decryptSecret(row.access_token_ciphertext), expiresAt: iso(row.access_token_expires_at) }
      : null;
  return { storeDomain: row.store_domain, credentials: credentialsOf(row), cachedToken, now };
}

/** Columns for a short-lived token that's worth keeping (null for tokens that don't expire). */
function tokenColumns(token: AccessToken): [string | null, string | null] {
  return token.expiresAt ? [encryptSecret(token.token), token.expiresAt] : [null, null];
}

function refusedAsValidation(error: unknown, platform: SalesPlatform): unknown {
  if (error instanceof PlatformError && error.refused) {
    return new ValidationError(`${label(platform)} refused these credentials: ${error.message}`);
  }
  return error;
}

/**
 * The address the platform sends webhooks to, or null when this server
 * has no public https address (the platform couldn't reach it).
 */
function webhookAddress(origin: string | null, organisationId: string, webhookKey: string): string | null {
  if (!origin) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "[::1]" || /^(127|10)\./.test(host) || /^192\.168\./.test(host)) {
    return null;
  }
  return `${url.origin}/api/sales-platforms/webhooks/${organisationId}/${webhookKey}`;
}

const NO_WEBHOOKS_NOTE =
  "Webhooks aren't set up because this server has no public https address (Settings › Remote access), so the store couldn't reach it. The catch-up sync still runs every 15 minutes.";

/** Subscribes the platform's webhooks (network), then records the result. Never fails the caller. */
async function setUpWebhooks(
  organisation: OrganisationRecord,
  actor: Actor,
  row: ConnectionRow,
  context: ConnectorContext,
  token: AccessToken,
  origin: string | null,
): Promise<void> {
  const connector = connectorFor(row.platform);
  const address = webhookAddress(origin, organisation.id, row.webhook_key);
  let ids: string[] = [];
  let note: string | null = NO_WEBHOOKS_NOTE;
  let logMessage: string | null = null;
  if (address) {
    try {
      ids = await connector.registerWebhooks(context, token, address);
      note = null;
      logMessage = `Asked ${label(row.platform)} to send customer and product changes to this server as they happen (${ids.length} webhooks).`;
    } catch (error) {
      note = `Webhooks couldn't be set up: ${error instanceof Error ? error.message : String(error)}. The catch-up sync still runs every 15 minutes.`;
      logMessage = note;
    }
  }
  await withOrganisationTransaction(organisation, actor, async (tx) => {
    const current = await readConnection(tx, row.id, { lock: true });
    if (current.status === "disconnected") return;
    await tx.query(
      "update sales_platform_connections set webhook_subscription_ids = $2, webhooks_note = $3, updated_at = now() where id = $1",
      [row.id, ids, note?.slice(0, 1000) ?? null],
    );
    if (logMessage) await writeLog(tx, row.id, { source: "connection", action: "webhooks", message: logMessage });
  });
}

async function assertNotConnected(tx: OrgTx, platform: SalesPlatform, storeDomain: string): Promise<void> {
  const existing = await tx.query(
    "select 1 from sales_platform_connections where platform = $1 and lower(store_domain) = lower($2) and status <> 'disconnected'",
    [platform, storeDomain],
  );
  if (existing.rowCount) throw new ConflictError(`${storeDomain} is already connected.`);
}

// ---------------------------------------------------------------------------
// Connecting, testing, settings, disconnecting (SPC1, SPC9, SPC10)

/** Checks the credentials with the platform, then stores them encrypted (SPC1). */
export async function connectStore(
  organisation: OrganisationRecord,
  actor: Actor,
  body: Record<string, unknown>,
  options: { webhookOrigin: string | null; now?: Date },
): Promise<SalesPlatformConnection> {
  requireSecrets();
  const platform = requireOneOf(body.platform ?? "shopify", "platform", SALES_PLATFORMS);
  const connector = connectorFor(platform);
  const input = connector.parseConnectInput(body);
  const syncCustomers = optionalBoolean(body.syncCustomers, "syncCustomers") ?? true;
  const syncProducts = optionalBoolean(body.syncProducts, "syncProducts") ?? true;
  const now = options.now ?? new Date();

  // 1. A short read: is this store already connected? (No call to the store if so.)
  await withOrganisationTransaction(organisation, actor, (tx) => assertNotConnected(tx, platform, input.storeDomain));

  // 2. The store, with no transaction open.
  const context: ConnectorContext = { storeDomain: input.storeDomain, credentials: input.credentials, cachedToken: null, now };
  let token: AccessToken;
  let store: Awaited<ReturnType<SalesPlatformConnector["checkStore"]>>;
  try {
    token = (await connector.accessToken(context)).token;
    store = await connector.checkStore(context, token);
  } catch (error) {
    throw refusedAsValidation(error, platform);
  }

  // 3. Save it.
  const webhookKey = randomBytes(32).toString("base64url");
  const [tokenCiphertext, tokenExpiresAt] = tokenColumns(token);
  const row = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await assertNotConnected(tx, platform, input.storeDomain);
    let inserted;
    try {
      inserted = await tx.query<ConnectionRow>(
        `insert into sales_platform_connections (platform, store_domain, store_name, store_currency, prices_include_tax, auth_method,
                                                 credentials_ciphertext, access_token_ciphertext, access_token_expires_at, webhook_key,
                                                 sync_customers, sync_products, connected_by_email)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         returning ${COLUMNS}`,
        [
          platform,
          input.storeDomain,
          store.storeName.slice(0, 255),
          store.currency,
          store.pricesIncludeTax,
          input.authMethod,
          encryptSecret(JSON.stringify(input.credentials)),
          tokenCiphertext,
          tokenExpiresAt,
          webhookKey,
          syncCustomers,
          syncProducts,
          actor.email,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new ConflictError(`${input.storeDomain} is already connected.`);
      throw error;
    }
    const saved = inserted.rows[0];
    await writeLog(tx, saved.id, {
      source: "connection",
      action: "connected",
      message: `Connected ${store.storeName} (${input.storeDomain}). Its prices are in ${store.currency} and ${store.pricesIncludeTax ? "include" : "exclude"} tax. Syncing customers: ${syncCustomers ? "on" : "off"}; products: ${syncProducts ? "on" : "off"}.`,
    });
    await writeAuditEvent(tx, {
      eventType: "sales_platform.connected",
      entityType: "sales_platform_connection",
      entityId: saved.id,
      details: { platform, storeDomain: input.storeDomain, authMethod: input.authMethod, syncCustomers, syncProducts },
    });
    return saved;
  });

  // 4. Webhooks (network again, nothing open).
  await setUpWebhooks(organisation, actor, row, context, token, options.webhookOrigin);
  return withOrganisationTransaction(organisation, actor, async (tx) => toConnection(await readConnection(tx, row.id)));
}

/**
 * Checks the stored credentials still work and refreshes the store's name,
 * currency and tax setting. Sets up webhooks if they aren't yet and the
 * server now has a public https address.
 */
export async function testConnection(
  organisation: OrganisationRecord,
  actor: Actor,
  connectionIdInput: unknown,
  options: { webhookOrigin?: string | null; now?: Date } = {},
): Promise<{ ok: boolean; storeName: string | null; message: string; connection: SalesPlatformConnection }> {
  requireSecrets();
  const now = options.now ?? new Date();
  const row = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const found = await readConnection(tx, connectionIdInput);
    assertConnected(found);
    return found;
  });
  const connector = connectorFor(row.platform);
  const context = contextFor(row, now);
  let token: AccessToken | null = null;
  let store: Awaited<ReturnType<SalesPlatformConnector["checkStore"]>> | null = null;
  let failure: string | null = null;
  try {
    token = (await connector.accessToken(context)).token;
    store = await connector.checkStore(context, token);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    failure = error.message;
  }
  const message = store
    ? `The connection works: ${store.storeName}, prices in ${store.currency} ${store.pricesIncludeTax ? "including" : "excluding"} tax.`
    : `The connection test failed: ${failure}`;
  await withOrganisationTransaction(organisation, actor, async (tx) => {
    const current = await readConnection(tx, row.id, { lock: true });
    assertConnected(current);
    if (store && token) {
      const [tokenCiphertext, tokenExpiresAt] = tokenColumns(token);
      await tx.query(
        `update sales_platform_connections
            set store_name = $2, store_currency = $3, prices_include_tax = $4,
                access_token_ciphertext = $5, access_token_expires_at = $6, updated_at = now()
          where id = $1`,
        [row.id, store.storeName.slice(0, 255), store.currency, store.pricesIncludeTax, tokenCiphertext, tokenExpiresAt],
      );
    }
    await writeLog(tx, row.id, { source: "connection", action: "tested", message });
  });
  if (store && token && row.webhook_subscription_ids.length === 0 && options.webhookOrigin !== undefined) {
    await setUpWebhooks(organisation, actor, row, context, token, options.webhookOrigin);
  }
  const connection = await withOrganisationTransaction(organisation, actor, async (tx) => toConnection(await readConnection(tx, row.id)));
  return { ok: store !== null, storeName: store?.storeName ?? null, message, connection };
}

/** What to sync (admins). */
export async function updateConnectionSettings(tx: OrgTx, connectionIdInput: unknown, body: Record<string, unknown>): Promise<SalesPlatformConnection> {
  const row = await readConnection(tx, connectionIdInput, { lock: true });
  assertConnected(row);
  const syncCustomers = optionalBoolean(body.syncCustomers, "syncCustomers") ?? row.sync_customers;
  const syncProducts = optionalBoolean(body.syncProducts, "syncProducts") ?? row.sync_products;
  if (syncCustomers === row.sync_customers && syncProducts === row.sync_products) return toConnection(row);
  const updated = await tx.query<ConnectionRow>(
    `update sales_platform_connections set sync_customers = $2, sync_products = $3, updated_at = now() where id = $1 returning ${COLUMNS}`,
    [row.id, syncCustomers, syncProducts],
  );
  await writeLog(tx, row.id, {
    source: "connection",
    action: "settings",
    message: `Syncing customers: ${syncCustomers ? "on" : "off"}; products: ${syncProducts ? "on" : "off"}.`,
  });
  await writeAuditEvent(tx, {
    eventType: "sales_platform.settings_changed",
    entityType: "sales_platform_connection",
    entityId: row.id,
    details: { syncCustomers, syncProducts },
  });
  return toConnection(updated.rows[0]);
}

/**
 * Disconnects a store (SPC9): asks the platform to stop sending webhooks
 * (best effort), then removes the credentials and the links to the
 * platform's records. Contacts, items and the sync log are kept.
 */
export async function disconnectStore(organisation: OrganisationRecord, actor: Actor, connectionIdInput: unknown): Promise<SalesPlatformConnection> {
  const row = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const found = await readConnection(tx, connectionIdInput);
    assertConnected(found);
    return found;
  });
  let webhookProblem: string | null = null;
  if (row.webhook_subscription_ids.length > 0) {
    try {
      if (!secretsAvailable()) throw new Error("TOHYEE_SECRET_KEY isn't set");
      const connector = connectorFor(row.platform);
      const context = contextFor(row, new Date());
      const { token } = await connector.accessToken(context);
      await connector.removeWebhooks(context, token, row.webhook_subscription_ids);
    } catch (error) {
      webhookProblem = error instanceof Error ? error.message : String(error);
    }
  }
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    const current = await readConnection(tx, row.id, { lock: true });
    assertConnected(current);
    const removed = await tx.query("delete from sales_platform_mappings where connection_id = $1", [row.id]);
    const updated = await tx.query<ConnectionRow>(
      `update sales_platform_connections
          set status = 'disconnected', credentials_ciphertext = null, access_token_ciphertext = null, access_token_expires_at = null,
              webhook_subscription_ids = '{}', webhooks_note = null, disconnected_by_email = $2, disconnected_at = now(), updated_at = now()
        where id = $1
        returning ${COLUMNS}`,
      [row.id, actor.email],
    );
    const webhooks =
      webhookProblem === null
        ? ""
        : ` ${label(row.platform)}'s webhooks couldn't be removed (${webhookProblem}); any it still sends are refused. Remove the app in the store to stop them.`;
    await writeLog(tx, row.id, {
      source: "connection",
      action: "disconnected",
      message: `Disconnected ${row.store_domain}. The contacts and items brought in are kept; the store's credentials and ${removed.rowCount ?? 0} links to its records were removed.${webhooks}`,
    });
    await writeAuditEvent(tx, {
      eventType: "sales_platform.disconnected",
      entityType: "sales_platform_connection",
      entityId: row.id,
      details: { platform: row.platform, storeDomain: row.store_domain, linksRemoved: removed.rowCount ?? 0 },
    });
    return toConnection(updated.rows[0]);
  });
}

// ---------------------------------------------------------------------------
// Applying the platform's records (SPC2-SPC7)

type ApplyContext = {
  connection: Pick<ConnectionRow, "id" | "platform" | "store_currency" | "prices_include_tax">;
  source: "sync" | "webhook";
  counts: SyncResult;
};

type Mapping = {
  id: string;
  contact_id: string | null;
  item_id: string | null;
  synced_values: Record<string, string | null>;
  external_updated_at: string | null;
};

function emptyCounts(): SyncResult {
  return { created: 0, linked: 0, updated: 0, kept: 0, skipped: 0, failed: 0 };
}

async function findMapping(tx: OrgTx, connectionId: string, kind: "customer" | "product_variant", externalId: string): Promise<Mapping | null> {
  const result = await tx.query<Mapping>(
    `select id, contact_id, item_id, synced_values, external_updated_at
       from sales_platform_mappings where connection_id = $1 and record_kind = $2 and external_id = $3 for update`,
    [connectionId, kind, externalId],
  );
  return result.rows[0] ?? null;
}

/** A change older than the one already copied (a late webhook or an overlapping sync) changes nothing. */
function isOlder(updatedAt: string | null, mapping: Mapping): boolean {
  if (!updatedAt || !mapping.external_updated_at) return false;
  return new Date(updatedAt).getTime() < new Date(mapping.external_updated_at).getTime();
}

async function saveMapping(
  tx: OrgTx,
  connectionId: string,
  kind: "customer" | "product_variant",
  externalId: string,
  target: { contactId?: string; itemId?: string },
  values: Record<string, string | null>,
  updatedAt: string | null,
): Promise<void> {
  await tx.query(
    `insert into sales_platform_mappings (connection_id, record_kind, external_id, contact_id, item_id, synced_values, external_updated_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)
     on conflict (connection_id, record_kind, external_id) do update
        set synced_values = excluded.synced_values,
            external_updated_at = greatest(sales_platform_mappings.external_updated_at, excluded.external_updated_at),
            updated_at = now()`,
    [connectionId, kind, externalId, target.contactId ?? null, target.itemId ?? null, JSON.stringify(values), updatedAt],
  );
}

/** Runs one record's changes in a savepoint, so one bad record is logged and the rest carry on. */
async function applyOne(tx: OrgTx, context: ApplyContext, kind: "customer" | "product_variant", externalId: string, work: () => Promise<void>): Promise<void> {
  await tx.query("savepoint sales_platform_record");
  try {
    await work();
    await tx.query("release savepoint sales_platform_record");
  } catch (error) {
    await tx.query("rollback to savepoint sales_platform_record");
    await tx.query("release savepoint sales_platform_record");
    const expected = error instanceof HttpError || typeof (error as { code?: unknown }).code === "string";
    if (!expected) throw error;
    context.counts.failed += 1;
    await writeLog(tx, context.connection.id, {
      source: context.source,
      action: "failed",
      recordKind: kind,
      externalId,
      message: `${label(context.connection.platform)} ${kind === "customer" ? "customer" : "variant"} ${externalId} couldn't be copied: ${(error as Error).message}`,
    });
  }
}

type Merge = {
  changes: Record<string, string | null>;
  updatedText: string[];
  keptText: string[];
};

/** Decides each field with mergeField and describes the result for the log. */
function mergeFields(
  fields: Array<{ key: string; label: string; tohyee: string | null; incoming: string | null; same?: (a: string, b: string) => boolean }>,
  snapshot: Record<string, string | null> | undefined,
  platform: string,
): Merge {
  const merge: Merge = { changes: {}, updatedText: [], keptText: [] };
  for (const field of fields) {
    const last = snapshot === undefined || !(field.key in snapshot) ? undefined : snapshot[field.key];
    const decision = mergeField({ tohyee: field.tohyee, last, incoming: field.incoming, same: field.same });
    const show = (value: string | null) => (value === null ? "blank" : `"${value}"`);
    if (decision.kind === "apply") {
      merge.changes[field.key] = decision.value;
      merge.updatedText.push(`${field.label} ${show(field.tohyee)} → ${show(decision.value)}`);
    } else if (decision.kind === "keep") {
      merge.keptText.push(
        decision.changedInTohyee
          ? `Kept Tohyee's ${field.label} ${show(field.tohyee)}: it was changed in Tohyee, and ${platform} changed it to ${show(field.incoming)}.`
          : `Kept Tohyee's ${field.label} ${show(field.tohyee)} (${platform} has ${show(field.incoming)}).`,
      );
    }
  }
  return merge;
}

const sameIgnoringCase = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function logMerge(
  tx: OrgTx,
  context: ApplyContext,
  merge: Merge,
  record: { kind: "customer" | "product_variant"; externalId: string; contactId?: string; itemId?: string; what: string },
): Promise<void> {
  const target = { recordKind: record.kind, externalId: record.externalId, contactId: record.contactId ?? null, itemId: record.itemId ?? null };
  if (merge.updatedText.length > 0) {
    context.counts.updated += 1;
    await writeLog(tx, context.connection.id, {
      source: context.source,
      action: "updated",
      ...target,
      message: `Updated ${record.what}: ${merge.updatedText.join("; ")}.`,
    });
  }
  for (const text of merge.keptText) {
    if (await writeLog(tx, context.connection.id, { source: context.source, action: "kept", ...target, message: `${record.what}: ${text}` })) {
      context.counts.kept += 1;
    }
  }
}

async function skip(tx: OrgTx, context: ApplyContext, kind: "customer" | "product_variant", externalId: string, message: string): Promise<void> {
  context.counts.skipped += 1;
  await writeLog(tx, context.connection.id, { source: context.source, action: "skipped", recordKind: kind, externalId, message });
}

type ContactNow = { id: string; name: string; email: string | null; phone: string | null; is_customer: boolean; is_archived: boolean };

async function readContact(tx: OrgTx, id: string): Promise<ContactNow> {
  const result = await tx.query<ContactNow>("select id, name, email, phone, is_customer, is_archived from contacts where id = $1", [id]);
  return result.rows[0];
}

/** A customer (SPC2, SPC5, SPC7): linked by email, added, or skipped when unclear. */
async function applyCustomer(tx: OrgTx, context: ApplyContext, customer: PlatformCustomer): Promise<void> {
  const platform = label(context.connection.platform);
  const connectionId = context.connection.id;
  const snapshot = { name: customer.name, email: customer.email, phone: customer.phone };
  const who = customer.name ?? customer.email ?? `customer ${customer.externalId}`;
  const mapping = await findMapping(tx, connectionId, "customer", customer.externalId);

  const merge = async (contact: ContactNow, last: Record<string, string | null> | undefined) => {
    const result = mergeFields(
      [
        { key: "name", label: "name", tohyee: contact.name, incoming: customer.name },
        { key: "email", label: "email", tohyee: contact.email, incoming: customer.email, same: sameIgnoringCase },
        { key: "phone", label: "phone", tohyee: contact.phone, incoming: customer.phone },
      ],
      last,
      platform,
    );
    // A contact's name can't be blank.
    if ("name" in result.changes && result.changes.name === null) delete result.changes.name;
    const changes: Record<string, unknown> = { ...result.changes };
    if (!contact.is_customer) changes.isCustomer = true;
    if (Object.keys(changes).length > 0) await updateContact(tx, contact.id, changes);
    await logMerge(tx, context, result, { kind: "customer", externalId: customer.externalId, contactId: contact.id, what: `contact ${contact.name}` });
    await saveMapping(tx, connectionId, "customer", customer.externalId, { contactId: contact.id }, snapshot, customer.updatedAt);
  };

  if (mapping) {
    if (isOlder(customer.updatedAt, mapping)) return;
    const contact = await readContact(tx, mapping.contact_id!);
    if (contact.is_archived) {
      const changed = Object.entries(snapshot).some(([key, value]) => (mapping.synced_values[key] ?? null) !== value);
      if (changed) await skip(tx, context, "customer", customer.externalId, `Contact ${contact.name} is archived, so ${platform}'s changes to ${who} weren't copied.`);
      await saveMapping(tx, connectionId, "customer", customer.externalId, { contactId: contact.id }, snapshot, customer.updatedAt);
      return;
    }
    await merge(contact, mapping.synced_values);
    return;
  }

  if (customer.email) {
    const matches = await tx.query<ContactNow>(
      "select id, name, email, phone, is_customer, is_archived from contacts where not is_archived and lower(email) = lower($1) order by id",
      [customer.email],
    );
    if (matches.rows.length > 1) {
      await skip(
        tx,
        context,
        "customer",
        customer.externalId,
        `${platform} customer ${who} wasn't linked: there's more than one contact with the email ${customer.email} (${matches.rows.map((row) => row.name).join(", ")}).`,
      );
      return;
    }
    if (matches.rows.length === 1) {
      const contact = matches.rows[0];
      const linked = await tx.query<{ external_id: string }>(
        "select external_id from sales_platform_mappings where connection_id = $1 and contact_id = $2",
        [connectionId, contact.id],
      );
      if (linked.rows[0]) {
        await skip(tx, context, "customer", customer.externalId, `${platform} customer ${who} wasn't linked: contact ${contact.name} has the same email but is already linked to ${platform} customer ${linked.rows[0].external_id}.`);
        return;
      }
      context.counts.linked += 1;
      await writeLog(tx, connectionId, {
        source: context.source,
        action: "linked",
        recordKind: "customer",
        externalId: customer.externalId,
        contactId: contact.id,
        message: `Linked ${platform} customer ${who} to contact ${contact.name} (same email).`,
      });
      await merge(contact, undefined);
      return;
    }
  }

  if (!customer.name) {
    await skip(tx, context, "customer", customer.externalId, `${platform} customer ${customer.externalId} has no name, so no contact was added.`);
    return;
  }
  const clash = await tx.query<{ name: string }>("select name from contacts where not is_archived and lower(name) = lower($1) limit 1", [customer.name]);
  if (clash.rows[0]) {
    await skip(
      tx,
      context,
      "customer",
      customer.externalId,
      customer.email
        ? `${platform} customer ${customer.name} (${customer.email}) wasn't added: there's already a contact called ${clash.rows[0].name} with a different email. Give the contact the same email to link them.`
        : `${platform} customer ${customer.name} wasn't added: there's already a contact called ${clash.rows[0].name}, and ${platform} has no email to tell whether they're the same.`,
    );
    return;
  }
  const { contact } = await createContact(tx, {
    idempotencyKey: `sp-${connectionId}-customer-${customer.externalId}`,
    source: SOURCE,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    isCustomer: true,
  });
  context.counts.created += 1;
  await writeLog(tx, connectionId, {
    source: context.source,
    action: "created",
    recordKind: "customer",
    externalId: customer.externalId,
    contactId: contact.id,
    message: `Added contact ${contact.name} from ${platform} customer ${customer.externalId}.`,
  });
  await saveMapping(tx, connectionId, "customer", customer.externalId, { contactId: contact.id }, snapshot, customer.updatedAt);
}

type ItemNow = { id: string; code: string; name: string; sale_price: string | null; is_active: boolean };

const plainPrice = (value: string | null): string | null => (value === null ? null : toPlainString(dec(value)));

/** A product's variant (SPC3, SPC5, SPC6, SPC7): linked by SKU, added as a non-stock item, or skipped. */
async function applyVariant(tx: OrgTx, context: ApplyContext, variant: PlatformVariant): Promise<void> {
  const platform = label(context.connection.platform);
  const connectionId = context.connection.id;
  const name = itemNameFor(variant.productTitle, variant.variantTitle);
  const pricing = priceCopyable({
    storeCurrency: context.connection.store_currency,
    pricesIncludeTax: context.connection.prices_include_tax,
    baseCurrency: tx.baseCurrency,
  });
  let price: string | null = null;
  if (variant.price !== null) {
    try {
      price = plainPrice(variant.price);
    } catch {
      price = null;
    }
  }
  const snapshot: Record<string, string | null> = { name, sku: variant.sku, ...(pricing.copy ? { salePrice: price } : {}) };
  const mapping = await findMapping(tx, connectionId, "product_variant", variant.externalId);

  const merge = async (item: ItemNow, last: Record<string, string | null> | undefined) => {
    const result = mergeFields(
      [
        { key: "name", label: "name", tohyee: item.name, incoming: name },
        ...(pricing.copy ? [{ key: "salePrice", label: "sale price", tohyee: plainPrice(item.sale_price), incoming: price }] : []),
      ],
      last,
      platform,
    );
    if ("name" in result.changes && result.changes.name === null) delete result.changes.name;
    if (last !== undefined && "sku" in last && (last.sku ?? null) !== variant.sku) {
      result.keptText.push(`Kept the item's code ${item.code}: ${platform}'s SKU changed to ${variant.sku === null ? "nothing" : `"${variant.sku}"`}.`);
    }
    if (Object.keys(result.changes).length > 0) await updateItem(tx, item.id, result.changes);
    await logMerge(tx, context, result, { kind: "product_variant", externalId: variant.externalId, itemId: item.id, what: `item ${item.code}` });
    await saveMapping(tx, connectionId, "product_variant", variant.externalId, { itemId: item.id }, snapshot, variant.updatedAt);
  };

  if (mapping) {
    if (isOlder(variant.updatedAt, mapping)) return;
    const item = (await tx.query<ItemNow>("select id, code, name, sale_price::text, is_active from items where id = $1", [mapping.item_id])).rows[0];
    if (!item.is_active) {
      const changed = Object.entries(snapshot).some(([key, value]) => (mapping.synced_values[key] ?? null) !== value);
      if (changed) await skip(tx, context, "product_variant", variant.externalId, `Item ${item.code} is archived, so ${platform}'s changes to ${name} weren't copied.`);
      await saveMapping(tx, connectionId, "product_variant", variant.externalId, { itemId: item.id }, snapshot, variant.updatedAt);
      return;
    }
    await merge(item, mapping.synced_values);
    return;
  }

  if (!variant.sku) {
    await skip(tx, context, "product_variant", variant.externalId, `${platform} variant ${name} has no SKU, so it wasn't matched to an item or added.`);
    return;
  }
  if (!ITEM_CODE_PATTERN.test(variant.sku)) {
    await skip(
      tx,
      context,
      "product_variant",
      variant.externalId,
      `${platform} variant ${name} wasn't matched or added: its SKU "${variant.sku}" can't be an item code (1-50 letters, numbers, dots, dashes, slashes or underscores).`,
    );
    return;
  }
  const existing = (
    await tx.query<ItemNow>("select id, code, name, sale_price::text, is_active from items where lower(code) = lower($1) order by id limit 1", [variant.sku])
  ).rows[0];
  if (existing) {
    if (!existing.is_active) {
      await skip(tx, context, "product_variant", variant.externalId, `${platform} variant ${name} wasn't linked: item ${existing.code} has the same code but is archived.`);
      return;
    }
    const linked = await tx.query<{ external_id: string }>(
      "select external_id from sales_platform_mappings where connection_id = $1 and item_id = $2",
      [connectionId, existing.id],
    );
    if (linked.rows[0]) {
      await skip(tx, context, "product_variant", variant.externalId, `${platform} variant ${name} wasn't linked: item ${existing.code} is already linked to ${platform} variant ${linked.rows[0].external_id} with the same SKU.`);
      return;
    }
    context.counts.linked += 1;
    await writeLog(tx, connectionId, {
      source: context.source,
      action: "linked",
      recordKind: "product_variant",
      externalId: variant.externalId,
      itemId: existing.id,
      message: `Linked ${platform} variant ${name} (SKU ${variant.sku}) to item ${existing.code} (same code).`,
    });
    await merge(existing, undefined);
    return;
  }

  const { item } = await createItem(tx, {
    idempotencyKey: `sp-${connectionId}-variant-${variant.externalId}`,
    source: SOURCE,
    code: variant.sku,
    name,
    itemType: "non_stock",
    salePrice: pricing.copy ? price : null,
  });
  context.counts.created += 1;
  const priceText = pricing.copy
    ? price === null
      ? ""
      : ` at ${price}`
    : price === null
      ? ""
      : `; its price (${variant.price}) wasn't copied because ${pricing.reason}`;
  await writeLog(tx, connectionId, {
    source: context.source,
    action: "created",
    recordKind: "product_variant",
    externalId: variant.externalId,
    itemId: item.id,
    message: `Added non-stock item ${item.code} "${item.name}" from ${platform}${priceText}.`,
  });
  await saveMapping(tx, connectionId, "product_variant", variant.externalId, { itemId: item.id }, snapshot, variant.updatedAt);
}

async function applyRecords(
  tx: OrgTx,
  context: ApplyContext,
  records: { customers: readonly PlatformCustomer[]; variants: readonly PlatformVariant[] },
): Promise<void> {
  for (const customer of records.customers) {
    await applyOne(tx, context, "customer", customer.externalId, () => applyCustomer(tx, context, customer));
  }
  for (const variant of records.variants) {
    await applyOne(tx, context, "product_variant", variant.externalId, () => applyVariant(tx, context, variant));
  }
}

// ---------------------------------------------------------------------------
// The catch-up sync (SPC2-SPC6, SPC9)

function describeCounts(counts: SyncResult): string {
  const parts = [
    [counts.created, "added"],
    [counts.linked, "linked"],
    [counts.updated, "updated"],
    [counts.kept, "kept Tohyee's value"],
    [counts.skipped, "skipped"],
    [counts.failed, "failed"],
  ]
    .filter(([count]) => (count as number) > 0)
    .map(([count, text]) => `${count} ${text}`);
  return parts.join(", ");
}

/**
 * Copies what changed in the store since the last sync. Reads the
 * connection, calls the platform with nothing open, then writes. A
 * failure is recorded on the connection; after three in a row it's paused.
 */
export async function syncConnection(
  organisation: OrganisationRecord,
  connectionIdInput: unknown,
  actor: Actor = SALES_PLATFORM_ACTOR,
  now: Date = new Date(),
): Promise<SyncResult> {
  requireSecrets();
  const row = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const found = await readConnection(tx, connectionIdInput);
    assertConnected(found);
    return found;
  });
  const connector = connectorFor(row.platform);
  try {
    const context = contextFor(row, now);
    const { token } = await connector.accessToken(context);
    const changes = await connector.fetchChanges(context, token, {
      customers: row.sync_customers,
      products: row.sync_products,
      customersSince: iso(row.customers_synced_until),
      productsSince: iso(row.products_synced_until),
    });
    return await withOrganisationTransaction(organisation, actor, async (tx) => {
      const current = await readConnection(tx, row.id, { lock: true });
      assertConnected(current);
      const apply: ApplyContext = { connection: current, source: "sync", counts: emptyCounts() };
      await applyRecords(tx, apply, {
        customers: current.sync_customers ? changes.customers : [],
        variants: current.sync_products ? changes.variants : [],
      });
      for (const note of changes.notes) {
        await writeLog(tx, row.id, { source: "sync", action: "skipped", message: note });
      }
      const [tokenCiphertext, tokenExpiresAt] = tokenColumns(token);
      await tx.query(
        `update sales_platform_connections
            set customers_synced_until = greatest(customers_synced_until, $2::timestamptz),
                products_synced_until = greatest(products_synced_until, $3::timestamptz),
                last_sync_at = $4, last_error = null, failures = 0, status = 'active',
                access_token_ciphertext = $5, access_token_expires_at = $6, updated_at = now()
          where id = $1`,
        [row.id, changes.customersUntil, changes.productsUntil, now.toISOString(), tokenCiphertext, tokenExpiresAt],
      );
      const summary = describeCounts(apply.counts);
      if (summary !== "" || current.status === "paused") {
        await writeLog(tx, row.id, { source: "sync", action: "sync", message: `Synced ${row.store_domain}: ${summary || "nothing changed"}.` });
      }
      return apply.counts;
    });
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await withOrganisationTransaction(organisation, actor, async (tx) => {
      const current = await readConnection(tx, row.id, { lock: true });
      if (current.status === "disconnected") return;
      const updated = await tx.query<{ status: string }>(
        `update sales_platform_connections
            set failures = failures + 1, last_error = $2, last_sync_at = $3,
                status = case when failures + 1 >= $4 then 'paused' else status end, updated_at = now()
          where id = $1 returning status`,
        [row.id, message.slice(0, 1000), now.toISOString(), PAUSE_AFTER_FAILURES],
      );
      const paused = updated.rows[0].status === "paused" && current.status !== "paused";
      await writeLog(tx, row.id, {
        source: "sync",
        action: "failed",
        message: `The sync failed: ${message}${paused ? ` It's paused after ${PAUSE_AFTER_FAILURES} failures in a row; "Sync now" tries again.` : ""}`,
      });
    });
    throw error;
  }
}

let running = false;

/** Syncs every active connection on the server, one at a time (every 15 minutes). */
export async function syncAllSalesPlatforms(): Promise<{ synced: number; failed: number }> {
  if (running || !secretsAvailable()) return { synced: 0, failed: 0 };
  running = true;
  let synced = 0;
  let failed = 0;
  try {
    for (const organisation of await listAllOrganisations()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      let ids: string[] = [];
      try {
        ids = await withOrganisationTransaction(organisation, SALES_PLATFORM_ACTOR, async (tx) =>
          (await tx.query<{ id: string }>("select id from sales_platform_connections where status = 'active' order by last_sync_at nulls first, id")).rows.map(
            (row) => row.id,
          ),
        );
      } catch {
        continue;
      }
      for (const id of ids) {
        try {
          await syncConnection(organisation, id);
          synced += 1;
        } catch (error) {
          failed += 1;
          console.warn(`[tohyee] Sales platform sync failed for ${organisation.id} connection ${id}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    return { synced, failed };
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startSalesPlatformScheduler(): void {
  if (timer) return;
  const tick = () => {
    syncAllSalesPlatforms().catch((error) => console.warn("[tohyee] Sales platform sync scheduler:", error));
  };
  timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 2 * 60 * 1000).unref?.();
}

// ---------------------------------------------------------------------------
// Webhooks (SPC7, SPC8)

export type WebhookOutcome = { status: 200 | 400 | 401; message: string };

const REFUSED: WebhookOutcome = { status: 401, message: "Refused." };
const WEBHOOK_KEY_PATTERN = /^[A-Za-z0-9_-]{32,100}$/;

/**
 * Handles a webhook delivery. It authenticates only by the platform's
 * signature with the connection's secret: nothing is read from the body or
 * written until the signature over the raw body checks out. Every refusal
 * looks the same, so the address can't be probed.
 */
export async function receiveWebhook(
  organisationIdInput: string,
  webhookKey: string,
  headers: Headers,
  rawBody: Buffer,
): Promise<WebhookOutcome> {
  let organisationId: string;
  try {
    organisationId = parseOrganisationId(organisationIdInput);
  } catch {
    return REFUSED;
  }
  if (!WEBHOOK_KEY_PATTERN.test(webhookKey)) return REFUSED;
  const organisation = await getOrganisation(organisationId);
  if (!organisation || !organisation.isActive) return REFUSED;
  // Not ready yet (e.g. being upgraded): the platform tries again later.
  assertOrganisationUsable(organisation);
  if (!secretsAvailable()) throw new UnavailableError("Webhooks can't be checked without TOHYEE_SECRET_KEY.");

  // 1. Find the connection and its secret.
  const row = await withOrganisationTransaction(organisation, SALES_PLATFORM_ACTOR, async (tx) => {
    const result = await tx.query<ConnectionRow>(`select ${COLUMNS} from sales_platform_connections where webhook_key = $1 and status <> 'disconnected'`, [
      webhookKey,
    ]);
    return result.rows[0] ?? null;
  });
  if (!row) return REFUSED;
  const connector = connectorFor(row.platform);

  // 2. Check the signature, with nothing open.
  const delivery = connector.checkWebhook(headers, rawBody, connector.webhookSecret(credentialsOf(row)), row.store_domain);
  if (!delivery) return REFUSED;
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { status: 400, message: "The body isn't JSON." };
  }
  let records;
  try {
    records = connector.webhookRecords(delivery.topic, body);
  } catch (error) {
    if (error instanceof ValidationError) return { status: 400, message: error.message };
    throw error;
  }

  // 3. Apply it, once.
  return withOrganisationTransaction(organisation, SALES_PLATFORM_ACTOR, async (tx) => {
    const current = await readConnection(tx, row.id, { lock: true });
    if (current.status === "disconnected") return REFUSED;
    const fresh = await tx.query(
      `insert into sales_platform_webhook_deliveries (connection_id, delivery_id, topic) values ($1, $2, $3)
       on conflict do nothing returning delivery_id`,
      [row.id, delivery.deliveryId.slice(0, 200), delivery.topic.slice(0, 100)],
    );
    if (!fresh.rowCount) return { status: 200, message: "Already handled." };
    if (!records) return { status: 200, message: "Not a topic Tohyee handles." };
    if ((records.kind === "customers" && !current.sync_customers) || (records.kind === "variants" && !current.sync_products)) {
      return { status: 200, message: "Syncing these is switched off." };
    }
    const apply: ApplyContext = { connection: current, source: "webhook", counts: emptyCounts() };
    await applyRecords(tx, apply, records.kind === "customers" ? { customers: records.records, variants: [] } : { customers: [], variants: records.records });
    return { status: 200, message: "Done." };
  });
}

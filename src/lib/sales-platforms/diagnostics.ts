import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { listConnections } from "@/lib/sales-platforms/service";
import {
  ORDER_SCOPE,
  PAYOUT_SCOPES,
  SALES_PLATFORM_LABELS,
  type SalesPlatformConnection,
  type SyncLogAction,
  type SyncRecordKind,
} from "@/lib/sales-platforms/types";
import { optionalId } from "@/lib/validation";

/**
 * Read-only diagnostics for a sales platform connection (#532 part 3,
 * decisions 1247-1249), for a connected AI to answer "why didn't my products
 * (or orders) come in?" without guessing. Everything here only reads: it
 * doesn't call the platform, sync, reconnect, change settings or post.
 *
 * It never returns credentials, tokens, the webhook key or address, or who
 * connected the store; messages and errors pass through `redactSecrets`.
 * Kept in its own file so the connector code (service.ts) isn't touched.
 */

/** Actions that leave a record not brought in (yet). */
const PROBLEM_ACTIONS: readonly SyncLogAction[] = ["skipped", "failed", "waiting"];
/** Actions that brought a record in or kept it up to date. */
const DONE_ACTIONS: readonly SyncLogAction[] = ["created", "linked", "updated", "kept", "posted", "cancelled"];
/** Lines about the connection itself. */
const CONNECTION_ACTIONS: readonly SyncLogAction[] = ["connected", "tested", "settings", "webhooks", "disconnected", "sync"];

export const SYNC_LOG_OUTCOMES = { problem: PROBLEM_ACTIONS, done: DONE_ACTIONS, connection: CONNECTION_ACTIONS } as const;
export type SyncLogOutcome = keyof typeof SYNC_LOG_OUTCOMES;
export const SYNC_LOG_ACTIONS: readonly SyncLogAction[] = [...CONNECTION_ACTIONS, ...DONE_ACTIONS, ...PROBLEM_ACTIONS];
export const SYNC_RECORD_KINDS: readonly SyncRecordKind[] = ["customer", "product_variant", "order", "refund", "payout"];

/** The catch-up sync runs every 15 minutes; an active store not synced for an hour is behind. */
const STALE_AFTER_MS = 60 * 60 * 1000;
const LOG_DEFAULT = 50;
const LOG_MAX = 200;
const EXAMPLES_PER_REASON = 3;

/**
 * Removes anything secret-looking from text Tohyee shows the AI: web
 * addresses keep only their host (a webhook address carries its key),
 * platform tokens and keys (Shopify shpat_/shpss_/shpca_/shppa_, WooCommerce
 * ck_/cs_) and any other long unbroken run of key-like characters.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bhttps?:\/\/([^\s/"'<>)]+)[^\s"'<>)]*/gi, (_match, host: string) => `https://${host.replace(/^[^@]*@/, "")}/[removed]`)
    .replace(/\b(shp(?:at|ss|ca|pa)|ck|cs)_[A-Za-z0-9_-]{6,}/g, "[removed]")
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, "[removed]");
}

/**
 * A short reason code for a skipped, failed or waiting line, from Tohyee's
 * own messages, so an AI can count and tell apart why records weren't
 * brought in. "other" when it isn't one of these; the message always says.
 */
const REASONS: ReadonlyArray<[RegExp, string]> = [
  [/has no SKU/, "missing_sku"],
  [/SKU "[^"]*" can't be an item code/, "invalid_sku"],
  [/already linked to/, "already_linked"],
  [/is archived/, "archived_in_tohyee"],
  [/has no name/, "missing_name"],
  [/\bscopes?\b/i, "missing_scope"],
  [/isn't matched to a Tohyee tax code|no tax code for untaxed/, "tax_code_not_set"],
  [/Choose an? .* account|account in the .* settings/, "account_not_set"],
  [/before the start date/, "before_start_date"],
  [/isn't paid yet/, "not_paid_yet"],
  [/is a test order/, "test_order"],
  [/Tohyee only brings in (orders|payouts) in/, "other_currency"],
  [/gift card/, "gift_card"],
  [/(isn't|aren't) supported yet/, "not_supported"],
  [/\block(ed)?\b/i, "period_locked"],
  [/^The sync failed/, "sync_failed"],
];

export function problemReason(action: SyncLogAction, message: string): string | null {
  if (!PROBLEM_ACTIONS.includes(action)) return null;
  for (const [pattern, reason] of REASONS) if (pattern.test(message)) return reason;
  return action === "waiting" ? "waiting" : "other";
}

const hasPayouts = (connection: SalesPlatformConnection) => connection.platform === "shopify";

type ImportStatus = "off" | "on" | "setup_needed" | "not_available";

type Problems = Record<string, { count: number; examples: Array<{ externalId: string; loggedAt: string; message: string }> }>;

type Cursors = {
  customers_synced_until: string | null;
  products_synced_until: string | null;
  orders_synced_until: string | null;
  payouts_synced_until: string | null;
};

const iso = (value: string | null): string | null => (value === null ? null : new Date(value).toISOString());

/**
 * Records whose latest log line is a skip, failure or wait, by kind and
 * reason (a record brought in later has a later "done" line, so it drops
 * out). Uses the log's per-record index.
 */
async function openProblems(tx: OrgTx, connectionId: string): Promise<Partial<Record<SyncRecordKind, Problems>>> {
  const latest = await tx.query<{ record_kind: SyncRecordKind; external_id: string; action: SyncLogAction; message: string; logged_at: string }>(
    `select record_kind, external_id, action, message, logged_at
       from (select distinct on (record_kind, external_id) record_kind, external_id, action, message, logged_at
               from sales_platform_sync_log
              where connection_id = $1 and record_kind is not null and external_id is not null
              order by record_kind, external_id, sales_platform_sync_log.id desc) latest
      where action = any($2::text[])
      order by logged_at desc`,
    [connectionId, PROBLEM_ACTIONS],
  );
  const result: Partial<Record<SyncRecordKind, Problems>> = {};
  for (const row of latest.rows) {
    const reason = problemReason(row.action, row.message) ?? "other";
    const kind = (result[row.record_kind] ??= {});
    const entry = (kind[reason] ??= { count: 0, examples: [] });
    entry.count += 1;
    if (entry.examples.length < EXAMPLES_PER_REASON) {
      entry.examples.push({ externalId: row.external_id, loggedAt: iso(row.logged_at)!, message: redactSecrets(row.message) });
    }
  }
  return result;
}

const total = (problems: Problems | undefined) => Object.values(problems ?? {}).reduce((sum, entry) => sum + entry.count, 0);

/** What posting needs before it can run, as the settings screen checks it (SPC11, WC2). */
function missingPostingSettings(connection: SalesPlatformConnection, gstRegistered: boolean): string[] {
  const missing: string[] = [];
  if (hasPayouts(connection)) {
    if (!connection.clearingAccountCode) missing.push("clearing account");
    if (!connection.payoutAccountCode) missing.push("account payouts arrive in");
    if (!connection.feesAccountCode) missing.push("fees account");
  }
  if (!connection.salesAccountCode) missing.push("sales account");
  if (!connection.shippingAccountCode) missing.push("shipping account");
  if (!connection.startDate) missing.push("start date");
  if (gstRegistered && !connection.untaxedTaxCode) missing.push("tax code for untaxed sales");
  return missing;
}

/** The access scopes a Shopify connection needs, what for, and whether the store gave them. */
function scopeReport(connection: SalesPlatformConnection) {
  if (connection.platform !== "shopify") {
    return { applies: false, note: `${SALES_PLATFORM_LABELS[connection.platform]} connects with a REST API key; it has no access scopes to check.` };
  }
  const granted = new Set(connection.grantedScopes);
  const needed = [
    { scope: "read_customers", neededFor: "customers", neededNow: connection.syncCustomers },
    { scope: "read_products", neededFor: "products", neededNow: connection.syncProducts },
    { scope: ORDER_SCOPE, neededFor: "orders and refunds (posting to the accounts)", neededNow: connection.postToAccounts },
    ...PAYOUT_SCOPES.map((scope) => ({ scope, neededFor: "payouts (posting to the accounts)", neededNow: connection.postToAccounts })),
  ].map((entry) => ({ ...entry, granted: granted.has(entry.scope) }));
  return {
    applies: true,
    granted: connection.grantedScopes,
    needed,
    missingNow: needed.filter((entry) => entry.neededNow && !entry.granted).map((entry) => entry.scope),
    missingForPosting: needed.filter((entry) => !entry.granted && entry.neededFor.includes("posting")).map((entry) => entry.scope),
    note: "Granted scopes are as the store last said, when it was connected or tested.",
  };
}

async function connectionReport(tx: OrgTx, connection: SalesPlatformConnection, gstRegistered: boolean, now: Date) {
  const platform = SALES_PLATFORM_LABELS[connection.platform];
  const cursors = (
    await tx.query<Cursors>(
      "select customers_synced_until, products_synced_until, orders_synced_until, payouts_synced_until from sales_platform_connections where id = $1",
      [connection.id],
    )
  ).rows[0];
  const mapped = await tx.query<{ record_kind: string; count: string }>(
    "select record_kind, count(*)::text as count from sales_platform_mappings where connection_id = $1 group by record_kind",
    [connection.id],
  );
  const mappedCount = (kind: string) => Number(mapped.rows.find((row) => row.record_kind === kind)?.count ?? 0);
  const documents = await tx.query<{ record_kind: string; state: string; retry: boolean; count: string }>(
    "select record_kind, state, retry, count(*)::text as count from sales_platform_documents where connection_id = $1 group by record_kind, state, retry",
    [connection.id],
  );
  const documentCounts = (kind: string) => {
    const rows = documents.rows.filter((row) => row.record_kind === kind);
    const sum = (match: (row: (typeof rows)[number]) => boolean) => rows.filter(match).reduce((count, row) => count + Number(row.count), 0);
    return { done: sum((row) => row.state === "done"), open: sum((row) => row.state === "open"), cancelled: sum((row) => row.state === "cancelled"), toRetry: sum((row) => row.retry) };
  };
  const problems = await openProblems(tx, connection.id);
  const scopes = scopeReport(connection);
  const missingSettings = missingPostingSettings(connection, gstRegistered);
  const posts = connection.postToAccounts && connection.startDate !== null;
  const missingOrderScope = scopes.applies && !connection.grantedScopes.includes(ORDER_SCOPE);
  const missingPayoutScopes = scopes.applies ? PAYOUT_SCOPES.filter((scope) => !connection.grantedScopes.includes(scope)) : [];

  const lastSyncMs = connection.lastSyncAt ? Date.parse(connection.lastSyncAt) : null;
  const stale = connection.status === "active" && (lastSyncMs === null || now.getTime() - lastSyncMs > STALE_AFTER_MS);

  const stage1 = (kind: "customer" | "product_variant", on: boolean, until: string | null, what: string) => ({
    status: (on ? "on" : "off") as ImportStatus,
    ...(on ? {} : { why: `Syncing ${what} is turned off in this connection's settings, so ${platform}'s ${what} aren't read at all.` }),
    linked: mappedCount(kind),
    notBroughtIn: total(problems[kind]),
    problems: problems[kind] ?? {},
    syncedUpTo: iso(until),
  });

  const orderStatus: ImportStatus = !connection.postToAccounts ? "off" : !posts || missingSettings.length > 0 || missingOrderScope ? "setup_needed" : "on";
  const orderWhy =
    orderStatus === "off"
      ? `Posting to the accounts is turned off, so ${platform} orders, refunds and payouts aren't fetched or posted. This says nothing about whether the store has sales.`
      : orderStatus === "setup_needed"
        ? `Posting is on but can't run: ${[...missingSettings, ...(missingOrderScope ? [`the ${ORDER_SCOPE} scope`] : [])].join(", ")} missing.`
        : undefined;
  const payoutStatus: ImportStatus = !hasPayouts(connection)
    ? "not_available"
    : orderStatus !== "on"
      ? orderStatus
      : missingPayoutScopes.length > 0
        ? "setup_needed"
        : "on";
  const payoutWhy =
    payoutStatus === "not_available"
      ? `${platform} has no payouts to bring in.`
      : payoutStatus === "setup_needed" && orderStatus === "on"
        ? `The store hasn't given the app ${missingPayoutScopes.join(" and ")}, so payouts aren't brought in.`
        : orderWhy;

  return {
    connectionId: connection.id,
    platform: connection.platform,
    store: connection.storeName ?? connection.storeDomain,
    storeDomain: connection.storeDomain,
    status: connection.status,
    freshness: {
      lastSyncAt: connection.lastSyncAt,
      minutesSinceLastSync: lastSyncMs === null ? null : Math.max(0, Math.floor((now.getTime() - lastSyncMs) / 60000)),
      behind: stale,
      lastError: connection.lastError === null ? null : redactSecrets(connection.lastError),
      failuresInARow: connection.failures,
      webhooksActive: connection.webhooksActive,
      webhooksNote: connection.webhooksNote === null ? null : redactSecrets(connection.webhooksNote),
    },
    imports: {
      customers: stage1("customer", connection.syncCustomers, cursors.customers_synced_until, "customers"),
      products: stage1("product_variant", connection.syncProducts, cursors.products_synced_until, "products"),
      orders: {
        status: orderStatus,
        ...(orderWhy ? { why: orderWhy } : {}),
        ...documentCounts("order"),
        notBroughtIn: total(problems.order),
        problems: problems.order ?? {},
        fetchedUpTo: iso(cursors.orders_synced_until),
      },
      refunds: {
        status: orderStatus,
        ...documentCounts("refund"),
        notBroughtIn: total(problems.refund),
        problems: problems.refund ?? {},
      },
      payouts: {
        status: payoutStatus,
        ...(payoutWhy ? { why: payoutWhy } : {}),
        ...(hasPayouts(connection) ? { ...documentCounts("payout"), notBroughtIn: total(problems.payout), problems: problems.payout ?? {}, fetchedUpTo: iso(cursors.payouts_synced_until) } : {}),
      },
    },
    posting: {
      on: connection.postToAccounts,
      startDate: connection.startDate,
      missingSettings,
      accounts: {
        clearing: connection.clearingAccountCode,
        payoutsInto: connection.payoutAccountCode,
        fees: connection.feesAccountCode,
        sales: connection.salesAccountCode,
        shipping: connection.shippingAccountCode,
        chargebacks: connection.chargebacksAccountCode,
        reserve: connection.reserveAccountCode,
      },
      taxRates: connection.taxCodes,
      untaxedTaxCode: connection.untaxedTaxCode,
      guestCheckouts: connection.guestContactName ? `to ${connection.guestContactName}` : "refused",
      ...(connection.platform === "woocommerce"
        ? {
            paymentMethods: connection.paymentMethods.map((method) => ({
              method: method.method,
              title: method.title,
              goesTo: method.leftOwing ? "left owing" : method.accountCode ?? "not chosen",
            })),
          }
        : {}),
    },
    scopes,
    settings: {
      syncCustomers: connection.syncCustomers,
      syncProducts: connection.syncProducts,
      pricesIncludeTax: connection.pricesIncludeTax,
      storeCurrency: connection.storeCurrency,
    },
  };
}

/**
 * Each connection's state for diagnosis: which imports are on, posting and
 * its start date, scopes given against needed, links made, records not
 * brought in (by reason) and how fresh the last sync is. Viewers can read it,
 * as they can the connection and its log on screen.
 */
export async function salesPlatformDiagnostics(
  tx: OrgTx,
  options: { connectionId?: unknown; includeDisconnected?: boolean } = {},
  now: Date = new Date(),
) {
  const connectionId = optionalId(options.connectionId, "connectionId");
  const all = await listConnections(tx);
  const chosen = connectionId
    ? all.filter((connection) => connection.id === connectionId)
    : all.filter((connection) => options.includeDisconnected || connection.status !== "disconnected");
  if (connectionId && chosen.length === 0) throw new ValidationError("That sales platform connection wasn't found.");
  const { gstRegistered } = await getOrganisationSettings(tx);
  const connections = [];
  for (const connection of chosen) connections.push(await connectionReport(tx, connection, gstRegistered, now));
  return {
    connections,
    ...(connections.length === 0
      ? { note: all.length === 0 ? "No sales platform has been connected." : "No store is connected now; ask with includeDisconnected for earlier ones." }
      : {}),
  };
}

function listOf<T extends string>(input: unknown, allowed: readonly T[], field: string): T[] | null {
  if (input === undefined || input === null || input === "") return null;
  const values = Array.isArray(input) ? input : [input];
  for (const value of values) {
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      throw new ValidationError(`${field} must be one or more of: ${allowed.join(", ")}.`);
    }
  }
  return values as T[];
}

/**
 * The sync log, newest first, filtered by connection, action, record kind,
 * outcome (problem, done or connection) and platform ID, a page at a time:
 * pass `nextBeforeId` back as `beforeId` for older lines. Each skip, failure
 * or wait has a reason code (see `problemReason`).
 */
export async function readSyncLog(
  tx: OrgTx,
  options: { connectionId?: unknown; action?: unknown; recordKind?: unknown; outcome?: unknown; externalId?: unknown; beforeId?: unknown; limit?: unknown } = {},
) {
  const connectionId = optionalId(options.connectionId, "connectionId");
  const beforeId = optionalId(options.beforeId, "beforeId");
  const actions = listOf(options.action, SYNC_LOG_ACTIONS, "action");
  const kinds = listOf(options.recordKind, SYNC_RECORD_KINDS, "recordKind");
  const outcomes = listOf(options.outcome, Object.keys(SYNC_LOG_OUTCOMES) as SyncLogOutcome[], "outcome");
  const outcomeActions = outcomes ? outcomes.flatMap((outcome) => SYNC_LOG_OUTCOMES[outcome]) : null;
  const externalId = options.externalId === undefined || options.externalId === null || options.externalId === "" ? null : String(options.externalId).slice(0, 100);
  const raw = options.limit;
  const limit =
    typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? Math.min(raw, LOG_MAX) : typeof raw === "string" && /^\d+$/.test(raw) && Number(raw) > 0 ? Math.min(Number(raw), LOG_MAX) : LOG_DEFAULT;
  if (connectionId) {
    const found = await tx.query("select 1 from sales_platform_connections where id = $1", [connectionId]);
    if (!found.rowCount) throw new ValidationError("That sales platform connection wasn't found.");
  }
  const result = await tx.query<{
    id: string;
    connection_id: string;
    logged_at: string;
    source: string;
    action: SyncLogAction;
    record_kind: SyncRecordKind | null;
    external_id: string | null;
    contact_id: string | null;
    item_id: string | null;
    document_type: string | null;
    document_id: string | null;
    message: string;
  }>(
    `select l.id::text, l.connection_id::text, l.logged_at, l.source, l.action, l.record_kind, l.external_id,
            l.contact_id::text, l.item_id::text, l.document_type, l.document_id::text, l.message
       from sales_platform_sync_log l
      where ($1::bigint is null or l.connection_id = $1::bigint)
        and ($2::bigint is null or l.id < $2::bigint)
        and ($3::text[] is null or l.action = any($3::text[]))
        and ($4::text[] is null or l.action = any($4::text[]))
        and ($5::text[] is null or l.record_kind = any($5::text[]))
        and ($6::text is null or l.external_id = $6::text)
      order by l.id desc
      limit ${limit + 1}`,
    [connectionId, beforeId, actions, outcomeActions, kinds, externalId],
  );
  const more = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  return {
    entries: rows.map((row) => {
      const reason = problemReason(row.action, row.message);
      return {
        id: row.id,
        connectionId: row.connection_id,
        loggedAt: iso(row.logged_at)!,
        source: row.source,
        action: row.action,
        recordKind: row.record_kind,
        externalId: row.external_id,
        ...(reason ? { reason } : {}),
        message: redactSecrets(row.message),
        ...(row.contact_id ? { contactId: row.contact_id } : {}),
        ...(row.item_id ? { itemId: row.item_id } : {}),
        ...(row.document_type ? { documentType: row.document_type, documentId: row.document_id } : {}),
      };
    }),
    ...(more ? { nextBeforeId: rows[rows.length - 1].id } : { end: "No older lines match." }),
  };
}

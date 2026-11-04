import { type AiTool, schema } from "@/lib/ai/tools";
import { payoutMatchReport } from "@/lib/sales-platforms/payout-reconcile";
import { readSyncLog, salesPlatformDiagnostics, SYNC_LOG_ACTIONS, SYNC_LOG_OUTCOMES, SYNC_RECORD_KINDS } from "@/lib/sales-platforms/diagnostics";

/**
 * Sales platform diagnostics for a connected AI (#532 part 3, decisions
 * 1247-1249): Look only tools, so any key can use them, as any member can
 * see the connection and its log on screen. They only read; nothing here
 * calls the store, syncs, reconnects, changes settings or posts, and no
 * credential, token or webhook address is ever in an answer.
 */

const CONNECTION_ID = { type: "string", description: "A connection's id, from get_sales_platform_status. Leave out for every connection." };
const oneOrMany = (values: readonly string[], description: string) => ({
  description,
  anyOf: [
    { type: "string", enum: [...values] },
    { type: "array", items: { type: "string", enum: [...values] }, maxItems: values.length },
  ],
});

export const SALES_PLATFORM_READ_TOOLS: readonly AiTool[] = [
  {
    name: "get_sales_platform_status",
    title: "Sales platform status",
    description:
      "Each connected Shopify or WooCommerce store: whether customers and products sync (off means not read at all; customers scope buyers means only customers who have ordered come in, with their first order), whether posting orders, refunds and payouts to the accounts is on and from what start date, settings posting still needs, access scopes given against needed, how many records are linked, records not brought in by reason (e.g. same_name_needs_check, customer_not_linked, test_customer, missing_scope, unknown_payout_transaction, payout_refused_before_update) with examples, and how fresh the data is: lastSuccessfulSyncAt (the last sync that worked; lastSyncAt is the last attempt), behind (true while paused, failing or out of date), and needsReconnect when the store refuses Tohyee's login (a person reconnects it in Settings › Sales platforms). Read-only: it doesn't contact the store or change anything. Use list_sales_platform_log for the lines behind it.",
    inputSchema: schema({
      connectionId: CONNECTION_ID,
      includeDisconnected: { type: "boolean", description: "Also show disconnected stores. Default false." },
    }),
    level: "read",
    async run(tx, args) {
      return salesPlatformDiagnostics(tx, { connectionId: args.connectionId, includeDisconnected: args.includeDisconnected === true });
    },
  },
  {
    name: "list_sales_platform_log",
    title: "Sales platform sync log",
    description:
      "The sales platform sync log, newest first: what each sync and webhook did to each customer, product variant, order, refund and payout, with a reason code on every skip, failure or wait. Filter by connection, action, recordKind, outcome (problem = skipped, failed or waiting; done = brought in; connection = connecting, settings and sync summaries) or externalId (the store's ID). Up to 200 lines a page; pass nextBeforeId back as beforeId for older lines. Read-only.",
    inputSchema: schema({
      connectionId: CONNECTION_ID,
      action: oneOrMany(SYNC_LOG_ACTIONS, "Only these actions."),
      recordKind: oneOrMany(SYNC_RECORD_KINDS, "Only lines about these kinds of record."),
      outcome: oneOrMany(Object.keys(SYNC_LOG_OUTCOMES), "problem, done or connection."),
      externalId: { type: "string", description: "Only lines about this record (the store's ID)." },
      beforeId: { type: "string", description: "Only lines older than this line id (nextBeforeId from the last page)." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Lines a page. Default 50." },
    }),
    level: "read",
    async run(tx, args) {
      return readSyncLog(tx, args);
    },
  },
  {
    name: "list_sales_platform_payout_matches",
    title: "Sales platform payout matches",
    description:
      "Shopify payouts issued between two dates (default the last 30 days) with their settlement (gross sales, refunds, fees, adjustments, chargebacks, reserves, net), whether each is in the accounts and which bank line it's matched to (a payout with no settlement says why: not_paid_yet, posted_without_settlement or not_read); every unreconciled deposit on the payout account in those dates with a status (matched, combined, needs_choice, already_matched, payout_not_posted, missing_posting_setup, missing_settlement_data, unmatched), the reason, and the reconcile command a person could review; the clearing account's balance; and what GST registration means for each payout. Never matches on amount alone. Read-only: it doesn't reconcile, post or contact the store.",
    inputSchema: schema({
      connectionId: CONNECTION_ID,
      from: { type: "string", format: "date", description: "First payout or bank line date (YYYY-MM-DD). Default 30 days before to." },
      to: { type: "string", format: "date", description: "Last date (YYYY-MM-DD). Default today." },
    }),
    level: "read",
    async run(tx, args) {
      return payoutMatchReport(tx, { connectionId: args.connectionId, from: args.from, to: args.to });
    },
  },
];

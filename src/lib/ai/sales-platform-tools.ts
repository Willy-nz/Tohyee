import { boundedLimit, CURSOR, cursorOf, limitInput, pageByPosition, positionOf } from "@/lib/ai/limits";
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

type Item = Record<string, unknown>;

/**
 * Notes given once per answer (#579, decision 1382): a note that's the same
 * on every item that has it moves to `notes[name]` and off the items. One
 * that differs between items stays on each, as it says something about each.
 */
export function shareNotes(items: Item[], fields: Record<string, (item: Item) => [unknown, (item: Item) => void] | null>, notes: Record<string, unknown>): void {
  for (const [name, read] of Object.entries(fields)) {
    const found = items.map((item) => read(item)).filter((entry): entry is [unknown, (item: Item) => void] => entry !== null && entry[0] !== undefined);
    if (found.length === 0) continue;
    const first = JSON.stringify(found[0][0]);
    if (!found.every(([value]) => JSON.stringify(value) === first)) continue;
    notes[name] = found[0][0];
    items.forEach((item) => read(item)?.[1](item));
  }
}

const field = (key: string) => (item: Item): [unknown, (item: Item) => void] | null => (key in item ? [item[key], (target) => delete target[key]] : null);
const nested = (outer: string, key: string) => (item: Item): [unknown, (item: Item) => void] | null => {
  const inner = item[outer];
  if (!inner || typeof inner !== "object" || !(key in inner)) return null;
  return [(inner as Item)[key], (target) => delete (target[outer] as Item)[key]];
};

/** The payout report with each repeated note given once, and its payouts and deposits paged together. */
export function payoutPage(report: Item, args: Record<string, unknown>) {
  const notes: Record<string, unknown> = {};
  const payouts = (report.payouts as Item[]) ?? [];
  const deposits = (report.deposits as Item[]) ?? [];
  // GST: one note per status, not one per payout.
  const gst: Record<string, unknown> = {};
  for (const payout of payouts) {
    const entry = payout.gst as Item | undefined;
    if (entry && typeof entry.status === "string" && "note" in entry) {
      gst[entry.status] = entry.note;
      delete entry.note;
    }
  }
  if (Object.keys(gst).length > 0) notes.gstByStatus = gst;
  shareNotes(payouts, { whyNotInAccounts: field("whyNotInAccounts"), ordersNotInBooks: field("ordersNote") }, notes);
  shareNotes(
    payouts.filter((payout) => payout.settlement && typeof payout.settlement === "object" && Object.keys(payout.settlement as Item).length === 1),
    { noSettlement: nested("settlement", "note") },
    notes,
  );
  for (const payout of payouts) if (payout.settlement && typeof payout.settlement === "object" && Object.keys(payout.settlement as Item).length === 0) payout.settlement = null;
  shareNotes(deposits, { suggestion: nested("suggestion", "note") }, notes);
  shareNotes((report.clearingBalances as Item[]) ?? [], { clearingBalance: field("note") }, notes);
  const limit = boundedLimit(args.limit, 50, 200);
  const payoutRows = pageByPosition(payouts, args.cursor, limit);
  const depositRows = pageByPosition(deposits, args.cursor, limit);
  const more = payoutRows.more || depositRows.more;
  return {
    ...report,
    payouts: payoutRows.rows,
    deposits: depositRows.rows,
    notes,
    more,
    nextCursor: more ? String(positionOf(args.cursor) + limit) : null,
  };
}

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
      "The sales platform sync log, newest first: what each sync and webhook did to each customer, product variant, order, refund and payout, with a reason code on every skip, failure or wait. Filter by connection, action, recordKind, outcome (problem = skipped, failed or waiting; done = brought in; connection = connecting, settings and sync summaries) or externalId (the store's ID). Up to 200 lines a page. Read-only.",
    inputSchema: schema({
      connectionId: CONNECTION_ID,
      action: oneOrMany(SYNC_LOG_ACTIONS, "Only these actions."),
      recordKind: oneOrMany(SYNC_RECORD_KINDS, "Only lines about these kinds of record."),
      outcome: oneOrMany(Object.keys(SYNC_LOG_OUTCOMES), "problem, done or connection."),
      externalId: { type: "string", description: "Only lines about this record (the store's ID)." },
      limit: limitInput(50, 200),
      cursor: CURSOR,
      beforeId: { type: "string", description: "Old name for cursor; use cursor." },
    }),
    level: "read",
    async run(tx, args) {
      const log = (await readSyncLog(tx, { ...args, beforeId: cursorOf(args, "beforeId") })) as Awaited<ReturnType<typeof readSyncLog>> & { nextBeforeId?: string };
      return { entries: log.entries, more: log.nextBeforeId !== undefined, nextCursor: log.nextBeforeId ?? null };
    },
  },
  {
    name: "list_sales_platform_payout_matches",
    title: "Sales platform payout matches",
    description:
      "Shopify payouts issued between two dates (default the last 30 days) with their settlement (gross sales, refunds, fees, adjustments, chargebacks, reserves, net), whether each is in the accounts and which bank line it's matched to (a payout with no settlement says why: not_paid_yet, posted_without_settlement or not_read); every unreconciled deposit on the payout account in those dates with a status (matched, combined, needs_choice, already_matched, payout_not_posted, missing_posting_setup, missing_settlement_data, unmatched), the reason, and the reconcile command a person could review; the clearing account's balance; and each payout's GST status. A note that applies to every item is given once in notes (GST by status too). Never matches on amount alone. Read-only: it doesn't reconcile, post or contact the store.",
    inputSchema: schema({
      connectionId: CONNECTION_ID,
      from: { type: "string", format: "date", description: "First payout or bank line date (YYYY-MM-DD). Default 30 days before to." },
      to: { type: "string", format: "date", description: "Last date (YYYY-MM-DD). Default today." },
      limit: { ...limitInput(50, 200), description: "Payouts and deposits a page (each). Default 50, at most 200." },
      cursor: CURSOR,
    }),
    level: "read",
    async run(tx, args) {
      return payoutPage((await payoutMatchReport(tx, { connectionId: args.connectionId, from: args.from, to: args.to })) as unknown as Item, args);
    },
  },
];

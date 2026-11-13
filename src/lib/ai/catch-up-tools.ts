import { boundedLimit, CURSOR, limitInput, pageByPosition } from "@/lib/ai/limits";
import { roleAtLeast } from "@/lib/auth/roles";
import { type AiTool, DATE, schema } from "@/lib/ai/tools";
import { ID, IDEMPOTENCY, idempotencyKey } from "@/lib/ai/write-tools";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { requireId } from "@/lib/validation";
import { MAX_VOID_JOURNALS, planVoidJournals, voidJournals } from "@/lib/ledger/void-journals";
import { applyWhenSentToInvoiced, ordersToApplyWhenSent } from "@/lib/sales-platforms/apply-when-sent";
import { retryPayouts, syncConnection } from "@/lib/sales-platforms/service";
import { listHeldOrders, markHeldOrderSent } from "@/lib/sales-platforms/when-sent";

/**
 * AI tools for screen actions that had none (Will, 13 Nov 2026; decision
 * 1600: "add the AI tool for everything", area by area). Each calls the same
 * service as its screen, at the same role, so nothing here is new
 * behaviour; the screen's preview, where it has one, comes first. This first
 * set covers Shopify's Sales when sent, syncing a store, and voiding manual
 * journals. src/lib/ai/screen-coverage.ts lists every screen action and its
 * tool, or why it has none yet.
 */

const CONNECTION = ID("Shopify or WooCommerce connection (get_sales_platform_status)");

function needsRole(context: { role: Parameters<typeof roleAtLeast>[0] }, role: "bookkeeper" | "admin", what: string) {
  if (!roleAtLeast(context.role, role)) throw new ForbiddenError(`${what} is for ${role === "admin" ? "owners and admins" : "bookkeepers and up"}, as in Tohyee.`);
}

export const CATCH_UP_READ_TOOLS: AiTool[] = [
  {
    name: "list_orders_to_hold",
    title: "Orders invoiced before Sales when sent",
    description:
      "Shopify orders invoiced in full to sales before Sales when sent (revenue recognised when fulfilled) applied to them, that Shopify hasn't marked fully sent: Settings › Revenue recognition's list. Each with its invoice, date, Shopify's fulfilment status, total and whether it's already chosen. held is the Income in advance account, or null when Sales when sent is off for the store. Use apply_sales_when_sent to hold them.",
    level: "read",
    inputSchema: schema({ connectionId: CONNECTION, limit: limitInput(100, 500), cursor: CURSOR }, ["connectionId"]),
    async run(tx, args) {
      const { held, orders } = await ordersToApplyWhenSent(tx, args.connectionId);
      const page = pageByPosition(orders, args.cursor, boundedLimit(args.limit, 100, 500));
      return { held, total: orders.length, orders: page.rows, more: page.more, nextCursor: page.nextCursor };
    },
  },
  {
    name: "list_held_orders",
    title: "Orders with sales held until sent",
    description:
      "Shopify orders with sales still in Income in advance because they're not yet sent: Sales › To send's held amounts. Each with its invoice date, the amount held and the lines still to send. mark_order_sent counts one as sent.",
    level: "read",
    inputSchema: schema({ connectionId: CONNECTION, limit: limitInput(100, 500), cursor: CURSOR }, ["connectionId"]),
    async run(tx, args) {
      const connection = await tx.query("select 1 from sales_platform_connections where id = $1 and platform = 'shopify'", [requireId(args.connectionId, "connectionId")]);
      if (connection.rowCount === 0) throw new ValidationError("That isn't a Shopify store connected here.");
      const orders = await listHeldOrders(tx, String(args.connectionId));
      const page = pageByPosition(orders, args.cursor, boundedLimit(args.limit, 100, 500));
      return { total: orders.length, orders: page.rows, more: page.more, nextCursor: page.nextCursor };
    },
  },
];

export const CATCH_UP_WRITE_TOOLS: AiTool[] = [
  {
    name: "apply_sales_when_sent",
    title: "Apply Sales when sent to orders already invoiced",
    description:
      "Does what Apply Sales when sent to these orders does on Settings › Revenue recognition: marks the chosen orders so the next sync posts one journal per order, on its invoice date, moving what each still has to send from sales to Income in advance. The invoices and payments don't change; what's already sent isn't held. Give orderIds from list_orders_to_hold (its orderId). Sales when sent must be on for the store. Bookkeepers and up.",
    level: "post",
    inputSchema: schema(
      { connectionId: CONNECTION, orderIds: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string" }, description: "Shopify order ids (orderId from list_orders_to_hold)." } },
      ["connectionId", "orderIds"],
    ),
    async run(tx, args, context) {
      needsRole(context, "bookkeeper", "Applying Sales when sent");
      const result = await applyWhenSentToInvoiced(tx, { connectionId: args.connectionId, orderIds: args.orderIds });
      return { ...result, next: "They're held at the next sync. sync_sales_platform runs it now (owners and admins)." };
    },
  },
  {
    name: "mark_order_sent",
    title: "Mark a Shopify order as sent",
    description:
      "Mark as sent for an order Shopify never marked fulfilled: it counts as sent on sentOn, as a fulfilment would (its held sales move to sales and stock comes out on that date). Marking it fulfilled in Shopify works too. Bookkeepers and up.",
    level: "post",
    inputSchema: schema({ connectionId: CONNECTION, orderId: { type: "string", description: "The Shopify order id (list_held_orders)." }, sentOn: DATE }, ["connectionId", "orderId", "sentOn"]),
    async run(tx, args, context) {
      needsRole(context, "bookkeeper", "Marking an order sent");
      return { order: await markHeldOrderSent(tx, String(args.connectionId), args.orderId, args.sentOn) };
    },
  },
  {
    name: "sync_sales_platform",
    title: "Sync a Shopify or WooCommerce store now",
    description:
      "Sync now, as on the store's page: reads new and changed customers, products, orders, refunds and payouts from the store and posts them as its settings say. Nothing is posted twice. Owners and admins only, as in Tohyee. get_sales_platform_status and list_sales_platform_log show the result.",
    level: "post",
    minRole: "admin",
    inputSchema: schema({ connectionId: CONNECTION }, ["connectionId"]),
    // The store is called outside any transaction, as the screen does.
    async runSteps(_run, args, context) {
      needsRole(context, "admin", "Syncing a store");
      if (!context.organisation || !context.actor) throw new ValidationError("Syncing a store needs a connection to Tohyee.");
      return { result: await syncConnection(context.organisation, args.connectionId, context.actor) };
    },
    run(_tx, args, context) {
      return this.runSteps!(async () => {
        throw new ValidationError("Not used.");
      }, args, context);
    },
  },
  {
    name: "retry_sales_platform_payouts",
    title: "Try payouts again",
    description:
      "Try again for payouts not in the accounts: reads them from the store again and syncs. A payout already posted is never posted again. Owners and admins only, as in Tohyee.",
    level: "post",
    minRole: "admin",
    inputSchema: schema({ connectionId: CONNECTION }, ["connectionId"]),
    // The store is called outside any transaction, as the screen does.
    async runSteps(_run, args, context) {
      needsRole(context, "admin", "Trying payouts again");
      if (!context.organisation || !context.actor) throw new ValidationError("Trying payouts again needs a connection to Tohyee.");
      return retryPayouts(context.organisation, args.connectionId, context.actor);
    },
    run(_tx, args, context) {
      return this.runSteps!(async () => {
        throw new ValidationError("Not used.");
      }, args, context);
    },
  },
  {
    name: "void_journals",
    title: "Void manual journals",
    description:
      "Void on the Journals page, for any manual journal or correction's replacement, whoever posted it: each gets an exact reversal, linked to it, on its own date or voidDate, with the reason in its description; the original is kept. Up to 100 at once, all or none. Refused for a record's journal (void the record), in a locked period, when already voided or corrected, and when a line is reconciled with a bank statement line. First call it without previewHash: each journal, whether it can be voided and why not, and the effect by account. Then call it again with the same journalIds, voidDate and reason, the previewHash and a new idempotencyKey. Bookkeepers and up.",
    level: "full",
    inputSchema: schema(
      {
        journalIds: { type: "array", minItems: 1, maxItems: MAX_VOID_JOURNALS, items: { type: "string" }, description: "The journals' ids." },
        voidDate: { ...DATE, description: "Left out, each journal's own date." },
        reason: { type: "string", maxLength: 300, description: "Why, kept on each reversal." },
        previewHash: { type: "string", description: "From the preview. Left out, nothing changes and the preview is the answer." },
        idempotencyKey: IDEMPOTENCY,
      },
      ["journalIds"],
    ),
    async run(tx, args, context) {
      needsRole(context, "bookkeeper", "Voiding journals");
      if (args.previewHash == null || args.previewHash === "") {
        const plan = await planVoidJournals(tx, { journalIds: args.journalIds, voidDate: args.voidDate });
        const { hash, ...rest } = plan;
        return {
          preview: true,
          ...rest,
          previewHash: hash,
          next: plan.items.some((item) => item.blocked)
            ? "Some can't be voided (see blocked): leave them out and preview again."
            : "Check these are the journals the person asked to void. To go ahead, call void_journals again with the same journalIds, voidDate and reason, this previewHash and a new idempotencyKey.",
        };
      }
      return voidJournals(tx, {
        journalIds: args.journalIds,
        voidDate: args.voidDate,
        reason: args.reason,
        previewHash: args.previewHash,
        idempotencyKey: idempotencyKey(args.idempotencyKey),
        source: context.source,
      });
    },
  },
];

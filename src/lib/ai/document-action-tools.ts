import { roleAtLeast } from "@/lib/auth/roles";
import { type AiTool, DATE, type JsonSchema, schema, type ToolContext } from "@/lib/ai/tools";
import { ID, IDEMPOTENCY, idempotencyKey } from "@/lib/ai/write-tools";
import { setStatementLineExcluded } from "@/lib/bank/accounts";
import { okStatementLine } from "@/lib/bank/confident";
import { rejectProposalRows } from "@/lib/bank/coding-proposals";
import { deleteBankRule } from "@/lib/bank/rules";
import { voidBankTransaction, voidTransfer } from "@/lib/bank/transactions";
import { voidSupplierPayment } from "@/lib/bills/payments";
import { deleteBill, getBill, voidBill } from "@/lib/bills/service";
import { removeApplication } from "@/lib/credit-notes/applications";
import { voidRefund } from "@/lib/credit-notes/refunds";
import { deleteCreditNote, getCreditNote, voidCreditNote } from "@/lib/credit-notes/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError } from "@/lib/errors";
import { requestHash } from "@/lib/idempotency";
import { removeOverpaymentApplication, voidOverpaymentRefund } from "@/lib/invoices/overpayments";
import { voidPayment } from "@/lib/invoices/payments";
import { deleteInvoice, getInvoice, voidInvoice } from "@/lib/invoices/service";
import { voidPaymentBatch } from "@/lib/payments/batches";
import { refreshInvoiceLinks } from "@/lib/payments/links";
import { cancelPurchaseOrder, closePurchaseOrder, copyPurchaseOrderToBill, deletePurchaseOrder, getPurchaseOrder } from "@/lib/purchase-orders/service";
import { acceptQuote, acceptQuoteAsSalesOrder, copyQuote, declineQuote, deleteQuote, getQuote } from "@/lib/quotes/service";
import { cancelSalesOrder, closeSalesOrder, deleteSalesOrder, getSalesOrder, invoiceSalesOrder } from "@/lib/sales-orders/service";
import { removeSupplierCreditNoteApplication } from "@/lib/supplier-credit-notes/applications";
import { voidSupplierCreditNoteRefund } from "@/lib/supplier-credit-notes/refunds";
import { deleteSupplierCreditNote, getSupplierCreditNote, voidSupplierCreditNote } from "@/lib/supplier-credit-notes/service";

/**
 * AI tools for the sales, purchases and bank screens' actions (decision
 * 1600, part 2): voids, removals and deletes, and what moves a quote, sales
 * order or purchase order on. Each calls the screen's own service at the
 * screen's role (bookkeepers and up), so nothing here is new behaviour.
 *
 * Anything that voids, removes, deletes or excludes takes two calls, as Will
 * asked for "proper tools with previews": the first shows what it acts on
 * and a confirmHash, changing nothing; the second, with the same arguments,
 * the hash and a new idempotencyKey, does it.
 */

type Args = Record<string, unknown>;
export type Action = {
  name: string;
  /** The screen's role; bookkeepers and up unless it says otherwise. */
  role?: "bookkeeper" | "admin";
  title: string;
  description: string;
  /** "post" moves documents on; "full" voids, removes, deletes or excludes, after a confirmation. */
  level: "post" | "full";
  input: Record<string, JsonSchema>;
  required: string[];
  /** What a confirmation shows: the record it acts on. */
  shows?: (tx: OrgTx, args: Args) => Promise<unknown>;
  act: (tx: OrgTx, args: Args, command: { source: string; idempotencyKey: string }) => Promise<unknown>;
  /** Work done after the transaction, as the screen does (e.g. switching off a voided invoice's payment link). */
  after?: (args: Args, context: ToolContext) => Promise<void>;
};

const VOID_DATE = { ...DATE, description: "The date the reversal is posted on." };
const CONFIRM = { type: "string", description: "From the first call. Left out, nothing changes and the first call shows what it acts on." } as const;

function summary(record: unknown): Record<string, unknown> {
  if (!record || typeof record !== "object") return {};
  const keep = /^(id|status|contactName|total|amountDue|amountPaid|currencyCode|reference|[a-z]+Number|[a-z]+Date)$/;
  return Object.fromEntries(Object.entries(record as Record<string, unknown>).filter(([key, value]) => keep.test(key) && (typeof value !== "object" || value === null)));
}

function needsRole(context: ToolContext, title: string, role: "bookkeeper" | "admin") {
  if (!roleAtLeast(context.role, role)) throw new ForbiddenError(`${title} is for ${role === "admin" ? "owners and admins" : "bookkeepers and up"}, as in Tohyee.`);
}

export function tool(action: Action): AiTool {
  const role = action.role ?? "bookkeeper";
  const confirms = action.level === "full";
  const input: Record<string, JsonSchema> = { ...action.input, idempotencyKey: IDEMPOTENCY, ...(confirms ? { confirmHash: CONFIRM } : {}) };
  const steps = confirms
    ? " First call it without confirmHash: it shows what it acts on and changes nothing. Then call it again with the same arguments, the confirmHash and a new idempotencyKey."
    : "";
  const run = async (tx: OrgTx, args: Args, context: ToolContext) => {
    needsRole(context, action.title, role);
    if (confirms) {
      const { confirmHash, ...withKey } = args;
      const rest = Object.fromEntries(Object.entries(withKey).filter(([name]) => name !== "idempotencyKey"));
      const shows = action.shows ? summary(await action.shows(tx, rest)) : {};
      const hash = requestHash(`ai-${action.name}`, { rest, shows });
      if (confirmHash == null || confirmHash === "") {
        return { preview: true, actsOn: shows, confirmHash: hash, next: `Check this is what the person asked to ${action.title.toLowerCase()}. To go ahead, call ${action.name} again with the same arguments, this confirmHash and a new idempotencyKey.` };
      }
      if (confirmHash !== hash) throw new ConflictError("It has changed since the first call, or the arguments differ. Call it again without confirmHash.");
    }
    return action.act(tx, args, { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) });
  };
  return {
    name: action.name,
    title: action.title,
    description: `${action.description} ${role === "admin" ? "Owners and admins" : "Bookkeepers and up"}, as in Tohyee.${steps}`,
    ...(role === "admin" ? { minRole: "admin" as const } : {}),
    level: action.level,
    inputSchema: schema(input, action.required),
    run,
    ...(action.after
      ? {
          async runSteps(work, args, context) {
            const result = await work((tx) => run(tx, args, context));
            if (!(result && typeof result === "object" && "preview" in result)) await action.after!(args, context);
            return result;
          },
        }
      : {}),
  };
}

const voidDated = (fn: (tx: OrgTx, id: unknown, command: { source: string; idempotencyKey: string; voidDate: unknown }) => Promise<unknown>, key: string) =>
  (tx: OrgTx, args: Args, command: { source: string; idempotencyKey: string }) => fn(tx, args[key], { ...command, voidDate: args.voidDate });

export const DOCUMENT_ACTION_TOOLS: AiTool[] = [
  // Voids: an exact reversal on the void date, the record kept and marked voided.
  tool({
    name: "void_invoice",
    title: "Void an invoice",
    description: "Void on an approved invoice: reverses it on voidDate and keeps it, marked voided. Its payments must be voided or removed first, as on the screen; its online payment link is switched off.",
    level: "full",
    input: { invoiceId: ID("invoice"), voidDate: VOID_DATE },
    required: ["invoiceId", "voidDate"],
    shows: (tx, args) => getInvoice(tx, args.invoiceId),
    act: voidDated(voidInvoice, "invoiceId"),
    after: async (args, context) => {
      if (context.organisation && context.actor) await refreshInvoiceLinks(context.organisation, context.actor, args.invoiceId);
    },
  }),
  tool({
    name: "void_invoice_payment",
    title: "Void an invoice payment",
    description: "Void on a payment recorded against an invoice: reverses it on voidDate; the invoice is owing again.",
    level: "full",
    input: { invoiceId: ID("invoice"), paymentId: ID("payment"), voidDate: VOID_DATE },
    required: ["invoiceId", "paymentId", "voidDate"],
    shows: (tx, args) => getInvoice(tx, args.invoiceId),
    act: (tx, args, command) => voidPayment(tx, args.invoiceId, args.paymentId, { ...command, voidDate: args.voidDate }),
  }),
  tool({
    name: "void_bill",
    title: "Void a bill",
    description: "Void on an approved bill: reverses it on voidDate and keeps it, marked voided. Its payments must be voided or removed first, as on the screen.",
    level: "full",
    input: { billId: ID("bill"), voidDate: VOID_DATE },
    required: ["billId", "voidDate"],
    shows: (tx, args) => getBill(tx, args.billId),
    act: voidDated(voidBill, "billId"),
  }),
  tool({
    name: "void_bill_payment",
    title: "Void a bill payment",
    description: "Void on a payment recorded against a bill: reverses it on voidDate; the bill is owing again.",
    level: "full",
    input: { billId: ID("bill"), paymentId: ID("payment"), voidDate: VOID_DATE },
    required: ["billId", "paymentId", "voidDate"],
    shows: (tx, args) => getBill(tx, args.billId),
    act: (tx, args, command) => voidSupplierPayment(tx, args.billId, args.paymentId, { ...command, voidDate: args.voidDate }),
  }),
  tool({
    name: "void_credit_note",
    title: "Void a credit note",
    description: "Void on an approved sales credit note: reverses it on voidDate. Its applications and refunds must be removed or voided first.",
    level: "full",
    input: { creditNoteId: ID("credit note"), voidDate: VOID_DATE },
    required: ["creditNoteId", "voidDate"],
    shows: (tx, args) => getCreditNote(tx, args.creditNoteId),
    act: voidDated(voidCreditNote, "creditNoteId"),
  }),
  tool({
    name: "remove_credit_note_application",
    title: "Remove a credit note application",
    description: "Remove on a credit note applied to an invoice: the credit is available again and the invoice owing again, from removalDate.",
    level: "full",
    input: { creditNoteId: ID("credit note"), applicationId: ID("application"), removalDate: { ...DATE, description: "The date it comes off." } },
    required: ["creditNoteId", "applicationId", "removalDate"],
    shows: (tx, args) => getCreditNote(tx, args.creditNoteId),
    act: (tx, args, command) => removeApplication(tx, args.creditNoteId, args.applicationId, { ...command, removalDate: args.removalDate }),
  }),
  tool({
    name: "void_credit_note_refund",
    title: "Void a credit note refund",
    description: "Void on a refund paid from a sales credit note: reverses it on voidDate; the credit is available again.",
    level: "full",
    input: { creditNoteId: ID("credit note"), refundId: ID("refund"), voidDate: VOID_DATE },
    required: ["creditNoteId", "refundId", "voidDate"],
    shows: (tx, args) => getCreditNote(tx, args.creditNoteId),
    act: (tx, args, command) => voidRefund(tx, args.creditNoteId, args.refundId, { ...command, voidDate: args.voidDate }),
  }),
  tool({
    name: "void_supplier_credit_note",
    title: "Void a supplier credit note",
    description: "Void on an approved supplier credit note: reverses it on voidDate. Its applications and refunds must be removed or voided first.",
    level: "full",
    input: { creditNoteId: ID("supplier credit note"), voidDate: VOID_DATE },
    required: ["creditNoteId", "voidDate"],
    shows: (tx, args) => getSupplierCreditNote(tx, args.creditNoteId),
    act: voidDated(voidSupplierCreditNote, "creditNoteId"),
  }),
  tool({
    name: "remove_supplier_credit_note_application",
    title: "Remove a supplier credit note application",
    description: "Remove on a supplier credit note applied to a bill: the credit is available again and the bill owing again, from removalDate.",
    level: "full",
    input: { creditNoteId: ID("supplier credit note"), applicationId: ID("application"), removalDate: { ...DATE, description: "The date it comes off." } },
    required: ["creditNoteId", "applicationId", "removalDate"],
    shows: (tx, args) => getSupplierCreditNote(tx, args.creditNoteId),
    act: (tx, args, command) => removeSupplierCreditNoteApplication(tx, args.creditNoteId, args.applicationId, { ...command, removalDate: args.removalDate }),
  }),
  tool({
    name: "void_supplier_credit_note_refund",
    title: "Void a supplier credit note refund",
    description: "Void on a refund received for a supplier credit note: reverses it on voidDate.",
    level: "full",
    input: { creditNoteId: ID("supplier credit note"), refundId: ID("refund"), voidDate: VOID_DATE },
    required: ["creditNoteId", "refundId", "voidDate"],
    shows: (tx, args) => getSupplierCreditNote(tx, args.creditNoteId),
    act: (tx, args, command) => voidSupplierCreditNoteRefund(tx, args.creditNoteId, args.refundId, { ...command, voidDate: args.voidDate }),
  }),
  tool({
    name: "remove_overpayment_application",
    title: "Remove an overpayment application",
    description: "Remove on an overpayment applied to an invoice: the credit is available again, from removalDate.",
    level: "full",
    input: { paymentId: ID("overpayment"), applicationId: ID("application"), removalDate: { ...DATE, description: "The date it comes off." } },
    required: ["paymentId", "applicationId", "removalDate"],
    act: (tx, args, command) => removeOverpaymentApplication(tx, args.paymentId, args.applicationId, { ...command, removalDate: args.removalDate }),
  }),
  tool({
    name: "void_overpayment_refund",
    title: "Void an overpayment refund",
    description: "Void on a refund paid from an overpayment: reverses it on voidDate.",
    level: "full",
    input: { paymentId: ID("overpayment"), refundId: ID("refund"), voidDate: VOID_DATE },
    required: ["paymentId", "refundId", "voidDate"],
    act: (tx, args, command) => voidOverpaymentRefund(tx, args.paymentId, args.refundId, { ...command, voidDate: args.voidDate }),
  }),
  tool({
    name: "void_payment_batch",
    title: "Void a batch payment",
    description: "Void on a payment for several invoices (kind customer) or several bills (kind supplier): reverses the whole batch on voidDate.",
    level: "full",
    input: { kind: { type: "string", enum: ["customer", "supplier"] }, batchId: ID("payment batch"), voidDate: VOID_DATE },
    required: ["kind", "batchId", "voidDate"],
    act: (tx, args, command) => voidPaymentBatch(tx, args.kind === "supplier" ? "supplier" : "customer", args.batchId, { ...command, voidDate: args.voidDate }),
  }),
  tool({
    name: "void_bank_transaction",
    title: "Void a spend or receive money",
    description: "Void on a spend or receive money: reverses it on voidDate. A statement line it was reconciled with is unreconciled. To change its coding instead, use recode_bank_transactions.",
    level: "full",
    input: { bankTransactionId: ID("bank transaction"), voidDate: VOID_DATE },
    required: ["bankTransactionId", "voidDate"],
    act: voidDated(voidBankTransaction, "bankTransactionId"),
  }),
  tool({
    name: "void_bank_transfer",
    title: "Void a bank transfer",
    description: "Void on a transfer between bank accounts: reverses it on voidDate.",
    level: "full",
    input: { transferId: ID("transfer"), voidDate: VOID_DATE },
    required: ["transferId", "voidDate"],
    act: voidDated(voidTransfer, "transferId"),
  }),

  // Deletes: drafts only, as on the screens (an approved one is voided instead).
  ...(
    [
      ["delete_draft_invoice", "Delete a draft invoice", "invoiceId", "invoice", getInvoice, deleteInvoice],
      ["delete_draft_bill", "Delete a draft bill", "billId", "bill", getBill, deleteBill],
      ["delete_draft_credit_note", "Delete a draft credit note", "creditNoteId", "credit note", getCreditNote, deleteCreditNote],
      ["delete_draft_supplier_credit_note", "Delete a draft supplier credit note", "creditNoteId", "supplier credit note", getSupplierCreditNote, deleteSupplierCreditNote],
      ["delete_draft_quote", "Delete a draft quote", "quoteId", "quote", getQuote, deleteQuote],
      ["delete_draft_sales_order", "Delete a draft sales order", "salesOrderId", "sales order", getSalesOrder, deleteSalesOrder],
      ["delete_draft_purchase_order", "Delete a draft purchase order", "purchaseOrderId", "purchase order", getPurchaseOrder, deletePurchaseOrder],
    ] as const
  ).map(([name, title, key, what, get, remove]) =>
    tool({
      name,
      title,
      description: `Delete on a draft ${what}: it's gone, with nothing posted. Only a draft; an approved one is voided instead.`,
      level: "full",
      input: { [key]: ID(what) },
      required: [key],
      shows: (tx, args) => (get as (tx: OrgTx, id: unknown) => Promise<unknown>)(tx, args[key]),
      act: async (tx, args) => {
        await (remove as (tx: OrgTx, id: unknown) => Promise<unknown>)(tx, args[key]);
        return { deleted: true, [key]: String(args[key]) };
      },
    }),
  ),
  tool({
    name: "delete_bank_rule",
    title: "Delete a bank rule",
    description: "Delete on a bank rule: it no longer suggests or codes lines. What it already coded stays.",
    level: "full",
    input: { ruleId: ID("bank rule") },
    required: ["ruleId"],
    act: async (tx, args) => {
      await deleteBankRule(tx, args.ruleId);
      return { deleted: true, ruleId: String(args.ruleId) };
    },
  }),

  // Bank lines.
  tool({
    name: "exclude_statement_line",
    title: "Exclude a statement line",
    description: "Exclude (or, with excluded false, include again) a bank statement line, as on the screen: an excluded line isn't left to reconcile and posts nothing. For a duplicate or a line that isn't really there.",
    level: "full",
    input: { lineId: ID("statement line"), excluded: { type: "boolean", description: "true to exclude, false to include it again." } },
    required: ["lineId", "excluded"],
    act: (tx, args) => setStatementLineExcluded(tx, args.lineId, args.excluded === true),
  }),
  tool({
    name: "ok_statement_line",
    title: "OK a confident match",
    description: "OK on a statement line with a confident match: reconciles it with what Tohyee matched it to, as the screen does. Tohyee checks the match is still confident.",
    level: "full",
    input: { lineId: ID("statement line") },
    required: ["lineId"],
    act: (tx, args, command) => okStatementLine(tx, args.lineId, command),
  }),
  tool({
    name: "reject_bank_coding_rows",
    title: "Reject rows of a bank coding proposal",
    description: "Reject on rows of a bank coding proposal (list_bank_coding_proposals): they're not coded, with the reason kept. A person approves the rest in Tohyee.",
    level: "full",
    input: {
      proposalId: ID("proposal"),
      rows: { type: "array", minItems: 1, maxItems: 500, items: { type: "string" }, description: "The rows' ids." },
      reason: { type: "string", maxLength: 500 },
    },
    required: ["proposalId", "rows"],
    act: (tx, args) => rejectProposalRows(tx, args.proposalId, { rows: args.rows, reason: args.reason }),
  }),

  // Moving quotes, sales orders and purchase orders on.
  tool({
    name: "accept_quote",
    title: "Accept a quote and invoice it",
    description: "Accept on a finalised quote: it's accepted and a draft invoice made from it, dated invoiceDate. dueDate is needed when the customer has no payment terms.",
    level: "post",
    input: { quoteId: ID("quote"), invoiceDate: DATE, dueDate: DATE, exchangeRate: { type: "string", description: "For a quote in another currency." } },
    required: ["quoteId", "invoiceDate"],
    act: (tx, args, command) => acceptQuote(tx, args.quoteId, { ...command, invoiceDate: args.invoiceDate, dueDate: args.dueDate, exchangeRate: args.exchangeRate }),
  }),
  tool({
    name: "quote_to_sales_order",
    title: "Accept a quote as a sales order",
    description: "Accept as a sales order on a finalised quote: it's accepted and a sales order made from it, dated orderDate.",
    level: "post",
    input: { quoteId: ID("quote"), orderDate: DATE },
    required: ["quoteId", "orderDate"],
    act: (tx, args, command) => acceptQuoteAsSalesOrder(tx, args.quoteId, { ...command, orderDate: args.orderDate }),
  }),
  tool({
    name: "decline_quote",
    title: "Decline a quote",
    description: "Decline on a finalised quote: the customer said no. Nothing is posted.",
    level: "post",
    input: { quoteId: ID("quote") },
    required: ["quoteId"],
    act: (tx, args, command) => declineQuote(tx, args.quoteId, command),
  }),
  tool({
    name: "copy_quote",
    title: "Copy a quote",
    description: "Copy on a quote: a new draft quote with the same lines, dated quoteDate.",
    level: "post",
    input: { quoteId: ID("quote"), quoteDate: DATE },
    required: ["quoteId", "quoteDate"],
    act: (tx, args, command) => copyQuote(tx, args.quoteId, { ...command, quoteDate: args.quoteDate }),
  }),
  tool({
    name: "invoice_sales_order",
    title: "Invoice a sales order",
    description: "Invoice on an approved sales order: a draft invoice for what's left to invoice, or for the quantities in lines ([{ salesOrderLineId, quantity }], salesOrderLineId being a line's lineId from get_sales_order).",
    level: "post",
    input: {
      salesOrderId: ID("sales order"),
      invoiceDate: DATE,
      dueDate: DATE,
      exchangeRate: { type: "string" },
      lines: {
        type: "array",
        maxItems: 200,
        items: { type: "object", properties: { salesOrderLineId: { type: "string" }, quantity: { type: "string" } }, required: ["salesOrderLineId", "quantity"], additionalProperties: false },
      },
    },
    required: ["salesOrderId", "invoiceDate"],
    act: (tx, args, command) =>
      invoiceSalesOrder(tx, args.salesOrderId, { ...command, invoiceDate: args.invoiceDate, dueDate: args.dueDate, exchangeRate: args.exchangeRate, lines: args.lines }),
  }),
  tool({
    name: "close_sales_order",
    title: "Close a sales order",
    description: "Close on a sales order: nothing more will be invoiced from it.",
    level: "post",
    input: { salesOrderId: ID("sales order") },
    required: ["salesOrderId"],
    act: (tx, args, command) => closeSalesOrder(tx, args.salesOrderId, command),
  }),
  tool({
    name: "cancel_sales_order",
    title: "Cancel a sales order",
    description: "Cancel on a sales order with nothing invoiced: the customer isn't going ahead.",
    level: "post",
    input: { salesOrderId: ID("sales order") },
    required: ["salesOrderId"],
    act: (tx, args, command) => cancelSalesOrder(tx, args.salesOrderId, command),
  }),
  tool({
    name: "bill_purchase_order",
    title: "Copy a purchase order to a bill",
    description: "Copy to bill on an approved purchase order: a draft bill for what's left, dated billDate.",
    level: "post",
    input: { purchaseOrderId: ID("purchase order"), billDate: DATE, dueDate: DATE, supplierInvoiceNumber: { type: "string", maxLength: 100 }, exchangeRate: { type: "string" } },
    required: ["purchaseOrderId", "billDate", "supplierInvoiceNumber"],
    act: (tx, args, command) =>
      copyPurchaseOrderToBill(tx, args.purchaseOrderId, { ...command, billDate: args.billDate, dueDate: args.dueDate, supplierInvoiceNumber: args.supplierInvoiceNumber, exchangeRate: args.exchangeRate }),
  }),
  tool({
    name: "close_purchase_order",
    title: "Close a purchase order",
    description: "Close on a purchase order: nothing more will be billed from it.",
    level: "post",
    input: { purchaseOrderId: ID("purchase order") },
    required: ["purchaseOrderId"],
    act: (tx, args, command) => closePurchaseOrder(tx, args.purchaseOrderId, command),
  }),
  tool({
    name: "cancel_purchase_order",
    title: "Cancel a purchase order",
    description: "Cancel on a purchase order with nothing billed.",
    level: "post",
    input: { purchaseOrderId: ID("purchase order") },
    required: ["purchaseOrderId"],
    act: (tx, args, command) => cancelPurchaseOrder(tx, args.purchaseOrderId, command),
  }),
];

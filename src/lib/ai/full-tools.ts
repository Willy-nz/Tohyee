import { createAccount, updateAccount } from "@/lib/accounts/service";
import { boundedLimit } from "@/lib/ai/limits";
import { type AiTool, DATE, type JsonSchema, schema } from "@/lib/ai/tools";
import { AMOUNTS_MODE, DOCUMENT_LINES, ID, IDEMPOTENCY, idempotencyKey, SALES_DOCUMENT_LINES } from "@/lib/ai/write-tools";
import { approvalNeededForAi } from "@/lib/approvals/requests";
import { createBudget, getBudget, listBudgets, setBudgetAmounts } from "@/lib/budgets/service";
import { applyCreditNote } from "@/lib/credit-notes/applications";
import { refundCreditNote } from "@/lib/credit-notes/refunds";
import { approveCreditNote, createCreditNote, getCreditNote, listCreditNotes, updateCreditNote } from "@/lib/credit-notes/service";
import { approveExpenseClaim, EXPENSE_CLAIM_STATUSES, getExpenseClaim, listExpenseClaims, recordExpenseClaimPayment } from "@/lib/expense-claims/service";
import { DEPRECIATION_METHODS } from "@/lib/fixed-assets/depreciation";
import { previewDepreciationRun, runDepreciation } from "@/lib/fixed-assets/runs";
import { createFixedAsset, getFixedAsset, listFixedAssets, listFixedAssetTypes, updateFixedAsset } from "@/lib/fixed-assets/service";
import { applyOverpayment, listOverpayments, refundOverpayment } from "@/lib/invoices/overpayments";
import { ITEM_TYPES } from "@/lib/items/pricing";
import { createItem, getItem, listItems, updateItem } from "@/lib/items/service";
import { approvePurchaseOrder, PURCHASE_ORDER_STATUSES, createPurchaseOrder, getPurchaseOrder, listPurchaseOrders, updatePurchaseOrder } from "@/lib/purchase-orders/service";
import { createQuote, finaliseQuote, getQuote, listQuotes, QUOTE_FILTERS, updateQuote } from "@/lib/quotes/service";
import { BILL_DUE_RULES } from "@/lib/repeating/bill-rules";
import { REPEATING_STATUSES, SAVE_AS } from "@/lib/repeating/runner";
import { REPEAT_PERIODS } from "@/lib/repeating/schedule";
import { createRepeatingBill, getRepeatingBill, listRepeatingBills, updateRepeatingBill } from "@/lib/repeating/bills";
import { createRepeatingInvoice, DUE_RULES, getRepeatingInvoice, listRepeatingInvoices, updateRepeatingInvoice } from "@/lib/repeating/service";
import { approveSalesOrder, SALES_ORDER_STATUSES, createSalesOrder, getSalesOrder, listSalesOrders, updateSalesOrder } from "@/lib/sales-orders/service";
import { applySupplierCreditNote } from "@/lib/supplier-credit-notes/applications";
import { refundSupplierCreditNote } from "@/lib/supplier-credit-notes/refunds";
import {
  approveSupplierCreditNote,
  createSupplierCreditNote,
  getSupplierCreditNote,
  listSupplierCreditNotes,
  updateSupplierCreditNote,
} from "@/lib/supplier-credit-notes/service";
import { createTrackingCategory, createTrackingValue, getTrackingSetup, updateTrackingCategory, updateTrackingValue } from "@/lib/tracking/service";
import { ConflictError } from "@/lib/errors";
import { requireId } from "@/lib/validation";

/**
 * Full access, outside banking (#205 section 4, decision 489, examples
 * AIF1-AIF6): the day-to-day accounting a key's Owner can do, through the
 * same services as the screens. Never: deleting, voiding, archiving or
 * switching anything off (no tool takes `isActive`), rolling back a
 * depreciation run or disposing of an asset, payroll, lock dates, GST
 * filing, users, roles or settings. A bill, purchase order or expense claim
 * an approval rule covers is approved by people only (AW13; Jess, 9 Oct
 * 2026). Lists are capped; ask with filters for more.
 */

const MAX_LIST = 200;
const LIMIT: JsonSchema = { type: "integer", minimum: 1, maximum: MAX_LIST, description: `Default 50, at most ${MAX_LIST}.` };
const MONEY = (what: string): JsonSchema => ({ type: "string", description: `${what}, a decimal, e.g. "115.00".` });
const BANK_CODE: JsonSchema = { type: "string", description: "A bank or credit card account's code from list_accounts." };
const EXCHANGE_RATE: JsonSchema = { type: "string", description: "Only for another currency: base currency per 1 unit. Left out, the last rate used." };

function first<T>(rows: readonly T[], limit: unknown): { rows: T[]; more: boolean } {
  const max = boundedLimit(limit, 50, MAX_LIST);
  return { rows: rows.slice(0, max), more: rows.length > max };
}

/** Just the named fields, so nothing else (such as isActive) reaches the service. */
function pick(args: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const name of names) if (args[name] !== undefined) picked[name] = args[name];
  return picked;
}

const APPLICATIONS = (document: "invoice" | "bill"): JsonSchema => ({
  type: "array",
  minItems: 1,
  maxItems: 100,
  items: {
    type: "object",
    properties: { [`${document}Id`]: { type: "string" }, amount: { type: "string" } },
    required: [`${document}Id`, "amount"],
  },
  description: `The ${document}s to apply it to and how much to each.`,
});
const REFUND_FIELDS: Record<string, JsonSchema> = {
  refundDate: DATE,
  amount: MONEY("How much"),
  bankAccountCode: BANK_CODE,
  reference: { type: "string" },
  exchangeRate: EXCHANGE_RATE,
  idempotencyKey: IDEMPOTENCY,
};
const REFUND_NAMES = ["refundDate", "amount", "bankAccountCode", "reference", "exchangeRate"] as const;

// Documents. Each field is passed to the screen's service, which checks it.
const QUOTE_FIELDS: Record<string, JsonSchema> = {
  contactId: ID("customer"),
  quoteDate: DATE,
  expiryDate: DATE,
  reference: { type: "string" },
  terms: { type: "string" },
  amountsMode: AMOUNTS_MODE,
  lines: SALES_DOCUMENT_LINES,
};
const SALES_ORDER_FIELDS: Record<string, JsonSchema> = {
  contactId: ID("customer"),
  orderDate: DATE,
  expectedDate: DATE,
  reference: { type: "string" },
  memo: { type: "string" },
  amountsMode: AMOUNTS_MODE,
  lines: SALES_DOCUMENT_LINES,
};
const PURCHASE_ORDER_FIELDS: Record<string, JsonSchema> = {
  contactId: ID("supplier"),
  orderDate: DATE,
  deliveryDate: DATE,
  deliveryAddress: { type: "string" },
  deliveryInstructions: { type: "string" },
  reference: { type: "string" },
  amountsMode: AMOUNTS_MODE,
  lines: DOCUMENT_LINES,
};
const CREDIT_NOTE_FIELDS: Record<string, JsonSchema> = {
  contactId: ID("customer"),
  creditNoteDate: DATE,
  reference: { type: "string" },
  amountsMode: AMOUNTS_MODE,
  lines: SALES_DOCUMENT_LINES,
  exchangeRate: EXCHANGE_RATE,
};
const SUPPLIER_CREDIT_NOTE_FIELDS: Record<string, JsonSchema> = {
  contactId: ID("supplier"),
  creditNoteDate: DATE,
  supplierCreditNoteNumber: { type: "string", description: "The supplier's own credit note number." },
  reference: { type: "string" },
  amountsMode: AMOUNTS_MODE,
  lines: DOCUMENT_LINES,
  exchangeRate: EXCHANGE_RATE,
};
const SCHEDULE_FIELDS: Record<string, JsonSchema> = {
  period: { type: "string", enum: [...REPEAT_PERIODS], description: "Repeats every `every` weeks or months." },
  every: { type: "integer", minimum: 1 },
  startDate: { ...DATE, description: "The first one's date." },
  endDate: { ...DATE, description: "Left out, it repeats until stopped." },
  dueDays: { type: "integer", minimum: 0 },
  saveAs: { type: "string", enum: [...SAVE_AS], description: "Whether each one is saved as a draft or approved." },
};
const REPEATING_INVOICE_FIELDS: Record<string, JsonSchema> = {
  contactId: ID("customer"),
  reference: { type: "string" },
  amountsMode: AMOUNTS_MODE,
  lines: DOCUMENT_LINES,
  ...SCHEDULE_FIELDS,
  dueRule: { type: "string", enum: [...DUE_RULES], description: "The customer's payment terms, or dueDays after each invoice's date." },
};
const REPEATING_BILL_FIELDS: Record<string, JsonSchema> = {
  contactId: ID("supplier"),
  supplierInvoiceNumber: { type: "string" },
  amountsMode: AMOUNTS_MODE,
  lines: DOCUMENT_LINES,
  ...SCHEDULE_FIELDS,
  dueRule: { type: "string", enum: [...BILL_DUE_RULES], description: "How each bill's due date is worked out, as on the repeating bill screen." },
};
const ITEM_FIELDS: Record<string, JsonSchema> = {
  code: { type: "string" },
  name: { type: "string" },
  description: { type: "string" },
  itemType: { type: "string", enum: [...ITEM_TYPES] },
  salePrice: MONEY("The sale price"),
  purchasePrice: MONEY("The purchase price"),
  incomeAccountCode: { type: "string" },
  purchaseAccountCode: { type: "string" },
  salesTaxCode: { type: ["string", "null"] },
  purchaseTaxCode: { type: ["string", "null"] },
};
const ACCOUNT_FIELDS: Record<string, JsonSchema> = {
  code: { type: "string" },
  name: { type: "string" },
  accountType: { type: "string", description: "As in list_accounts, e.g. expense, revenue, current_asset, bank." },
  description: { type: "string" },
  currencyCode: { type: ["string", "null"], description: "Only for a bank or credit card account in another currency." },
  defaultTaxCode: { type: ["string", "null"] },
};
const ASSET_FIELDS: Record<string, JsonSchema> = {
  name: { type: "string" },
  description: { type: "string" },
  typeId: ID("fixed asset type (list_fixed_asset_types)"),
  purchaseDate: DATE,
  cost: MONEY("Its cost"),
  billLineId: { type: "string", description: "The bill line it was bought on, when there is one." },
  method: { type: "string", enum: [...DEPRECIATION_METHODS], description: "Diminishing value, straight line or none; left out, the type's." },
  rate: { type: "string", description: "A yearly percentage, e.g. \"20\"; left out, the type's." },
  residualValue: MONEY("Its residual value"),
  openingDate: { ...DATE, description: "Only for an asset brought in part way through its life." },
  openingAccumulatedDepreciation: MONEY("Depreciation already taken before the opening date"),
};

/** Tools that only look: read-level ones any key sees, and expense claims for Full access (they're people's own spending). */
export const FULL_READ_TOOLS: readonly AiTool[] = [
  {
    name: "list_credit_notes",
    title: "Credit notes",
    level: "read",
    description: "Sales credit notes, newest first, with what's left to apply or refund. Filter by status (draft, approved, voided) or customer.",
    inputSchema: schema({ status: { type: "string", enum: ["draft", "approved", "voided"] }, contactId: ID("customer"), hasRemainingCredit: { type: "boolean" }, limit: LIMIT }),
    async run(tx, args) {
      const result = await listCreditNotes(tx, { status: args.status, contactId: args.contactId, hasRemainingCredit: args.hasRemainingCredit, limit: boundedLimit(args.limit, 50, MAX_LIST) });
      return { creditNotes: result.creditNotes, more: result.nextBeforeId !== null };
    },
  },
  {
    name: "get_credit_note",
    title: "One credit note",
    level: "read",
    description: "One sales credit note with its lines.",
    inputSchema: schema({ creditNoteId: ID("credit note") }, ["creditNoteId"]),
    run: (tx, args) => getCreditNote(tx, args.creditNoteId),
  },
  {
    name: "list_supplier_credit_notes",
    title: "Supplier credit notes",
    level: "read",
    description: "Credit notes from suppliers, newest first. Filter by status or supplier.",
    inputSchema: schema({ status: { type: "string", enum: ["draft", "approved", "voided"] }, contactId: ID("supplier"), hasRemainingCredit: { type: "boolean" }, limit: LIMIT }),
    async run(tx, args) {
      const result = await listSupplierCreditNotes(tx, { status: args.status, contactId: args.contactId, hasRemainingCredit: args.hasRemainingCredit, limit: boundedLimit(args.limit, 50, MAX_LIST) });
      return { creditNotes: result.creditNotes, more: result.nextBeforeId !== null };
    },
  },
  {
    name: "get_supplier_credit_note",
    title: "One supplier credit note",
    level: "read",
    description: "One supplier credit note with its lines.",
    inputSchema: schema({ creditNoteId: ID("supplier credit note") }, ["creditNoteId"]),
    run: (tx, args) => getSupplierCreditNote(tx, args.creditNoteId),
  },
  {
    name: "list_overpayments",
    title: "Customer overpayments",
    level: "read",
    description: "Customer payments that paid more than was due, with what's left to apply or refund.",
    inputSchema: schema({ contactId: ID("customer"), hasRemainingCredit: { type: "boolean" }, limit: LIMIT }),
    async run(tx, args) {
      const { rows, more } = first(await listOverpayments(tx, { contactId: args.contactId, hasRemainingCredit: args.hasRemainingCredit }), args.limit);
      return { overpayments: rows, more };
    },
  },
  {
    name: "list_quotes",
    title: "Quotes",
    level: "read",
    description: "Quotes, newest first. Filter by status or customer.",
    inputSchema: schema({ status: { type: "string", enum: [...QUOTE_FILTERS] }, contactId: ID("customer"), limit: LIMIT }),
    async run(tx, args) {
      const { rows, more } = first((await listQuotes(tx, { status: args.status, contactId: args.contactId })).quotes, args.limit);
      return { quotes: rows, more };
    },
  },
  {
    name: "get_quote",
    title: "One quote",
    level: "read",
    description: "One quote with its lines.",
    inputSchema: schema({ quoteId: ID("quote") }, ["quoteId"]),
    run: (tx, args) => getQuote(tx, args.quoteId),
  },
  {
    name: "list_sales_orders",
    title: "Sales orders",
    level: "read",
    description: "Sales orders, newest first. Filter by status or customer.",
    inputSchema: schema({ status: { type: "string", enum: [...SALES_ORDER_STATUSES] }, contactId: ID("customer"), limit: LIMIT }),
    async run(tx, args) {
      const { rows, more } = first((await listSalesOrders(tx, { status: args.status, contactId: args.contactId })).salesOrders, args.limit);
      return { salesOrders: rows, more };
    },
  },
  {
    name: "get_sales_order",
    title: "One sales order",
    level: "read",
    description: "One sales order with its lines.",
    inputSchema: schema({ salesOrderId: ID("sales order") }, ["salesOrderId"]),
    run: (tx, args) => getSalesOrder(tx, args.salesOrderId),
  },
  {
    name: "list_purchase_orders",
    title: "Purchase orders",
    level: "read",
    description: "Purchase orders, newest first. Filter by status or supplier.",
    inputSchema: schema({ status: { type: "string", enum: [...PURCHASE_ORDER_STATUSES] }, contactId: ID("supplier"), limit: LIMIT }),
    async run(tx, args) {
      const { rows, more } = first((await listPurchaseOrders(tx, { status: args.status, contactId: args.contactId })).purchaseOrders, args.limit);
      return { purchaseOrders: rows, more };
    },
  },
  {
    name: "get_purchase_order",
    title: "One purchase order",
    level: "read",
    description: "One purchase order with its lines.",
    inputSchema: schema({ purchaseOrderId: ID("purchase order") }, ["purchaseOrderId"]),
    run: (tx, args) => getPurchaseOrder(tx, args.purchaseOrderId),
  },
  {
    name: "list_repeating_invoices",
    title: "Repeating invoices",
    level: "read",
    description: "Repeating invoice templates and when each next runs.",
    inputSchema: schema({ status: { type: "string", enum: [...REPEATING_STATUSES] }, contactId: ID("customer") }),
    run: (tx, args) => listRepeatingInvoices(tx, { status: args.status, contactId: args.contactId }),
  },
  {
    name: "get_repeating_invoice",
    title: "One repeating invoice",
    level: "read",
    description: "One repeating invoice template with its lines and schedule.",
    inputSchema: schema({ repeatingInvoiceId: ID("repeating invoice") }, ["repeatingInvoiceId"]),
    run: (tx, args) => getRepeatingInvoice(tx, args.repeatingInvoiceId),
  },
  {
    name: "list_repeating_bills",
    title: "Repeating bills",
    level: "read",
    description: "Repeating bill templates and when each next runs.",
    inputSchema: schema({ status: { type: "string", enum: [...REPEATING_STATUSES] }, contactId: ID("supplier") }),
    run: (tx, args) => listRepeatingBills(tx, { status: args.status, contactId: args.contactId }),
  },
  {
    name: "get_repeating_bill",
    title: "One repeating bill",
    level: "read",
    description: "One repeating bill template with its lines and schedule.",
    inputSchema: schema({ repeatingBillId: ID("repeating bill") }, ["repeatingBillId"]),
    run: (tx, args) => getRepeatingBill(tx, args.repeatingBillId),
  },
  {
    name: "list_items",
    title: "Items",
    level: "read",
    description: "Products and services with their prices, accounts and GST codes.",
    inputSchema: schema({ search: { type: "string" }, includeArchived: { type: "boolean" }, limit: LIMIT }),
    async run(tx, args) {
      const list = await listItems(tx, { search: args.search, includeArchived: args.includeArchived === true });
      const { rows, more } = first(list.items, args.limit);
      return { items: rows, more };
    },
  },
  {
    name: "get_item",
    title: "One item",
    level: "read",
    description: "One product or service.",
    inputSchema: schema({ itemId: ID("item") }, ["itemId"]),
    run: (tx, args) => getItem(tx, args.itemId),
  },
  {
    name: "list_tracking",
    title: "Tracking categories",
    level: "read",
    description: "Tracking categories (e.g. Region) and their options.",
    inputSchema: schema(),
    run: (tx) => getTrackingSetup(tx),
  },
  {
    name: "list_fixed_assets",
    title: "Fixed assets",
    level: "read",
    description: "The fixed asset register: each asset's cost, depreciation so far and book value.",
    inputSchema: schema({ status: { type: "string", enum: ["registered", "disposed", "archived", "all"], description: "Default registered." }, limit: LIMIT }),
    async run(tx, args) {
      const { rows, more } = first(await listFixedAssets(tx, { status: args.status }), args.limit);
      return { assets: rows, more };
    },
  },
  {
    name: "get_fixed_asset",
    title: "One fixed asset",
    level: "read",
    description: "One fixed asset with its depreciation.",
    inputSchema: schema({ assetId: ID("fixed asset") }, ["assetId"]),
    run: (tx, args) => getFixedAsset(tx, args.assetId),
  },
  {
    name: "list_fixed_asset_types",
    title: "Fixed asset types",
    level: "read",
    description: "Fixed asset types with their accounts and default depreciation.",
    inputSchema: schema(),
    async run(tx) {
      return { types: await listFixedAssetTypes(tx) };
    },
  },
  {
    name: "preview_depreciation",
    title: "Preview a depreciation run",
    level: "read",
    description: "What a depreciation run up to a month end would post, without posting it.",
    inputSchema: schema({ periodEnd: { ...DATE, description: "A month end." } }, ["periodEnd"]),
    run: (tx, args) => previewDepreciationRun(tx, args.periodEnd),
  },
  {
    name: "list_budgets",
    title: "Budgets",
    level: "read",
    description: "Budgets (not archived ones).",
    inputSchema: schema(),
    async run(tx) {
      return { budgets: await listBudgets(tx) };
    },
  },
  {
    name: "get_budget",
    title: "One budget",
    level: "read",
    description: "A budget's amounts by account and month, and budget.version (send it back with set_budget_amounts).",
    inputSchema: schema({ budgetId: ID("budget"), from: { type: "string", description: "First month, YYYY-MM." }, months: { type: "integer", minimum: 1, maximum: 24 } }, ["budgetId"]),
    run: (tx, args) => getBudget(tx, args.budgetId, { from: args.from, months: args.months }),
  },
  {
    name: "list_expense_claims",
    title: "Expense claims",
    level: "full",
    readOnly: true,
    description: "Expense claims, filtered by status.",
    inputSchema: schema({ status: { type: "string", enum: [...EXPENSE_CLAIM_STATUSES] }, limit: LIMIT }),
    async run(tx, args) {
      const { rows, more } = first(await listExpenseClaims(tx, { status: args.status }), args.limit);
      return { claims: rows, more };
    },
  },
  {
    name: "get_expense_claim",
    title: "One expense claim",
    level: "full",
    readOnly: true,
    description: "One expense claim with its lines.",
    inputSchema: schema({ claimId: ID("expense claim") }, ["claimId"]),
    run: (tx, args) => getExpenseClaim(tx, args.claimId),
  },
];

export const FULL_WRITE_TOOLS: readonly AiTool[] = [
  // Sales.
  {
    name: "create_quote",
    title: "Make a quote",
    level: "full",
    description: "Makes a draft quote. Nothing is posted by quotes.",
    inputSchema: schema({ ...QUOTE_FIELDS, idempotencyKey: IDEMPOTENCY }, ["contactId", "quoteDate", "amountsMode", "lines"]),
    run: (tx, args, context) => createQuote(tx, { ...pick(args, Object.keys(QUOTE_FIELDS)), source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) }),
  },
  {
    name: "update_quote",
    title: "Edit a quote",
    level: "full",
    description: "Edits a draft quote. The lines given replace every line.",
    inputSchema: schema({ quoteId: ID("quote"), ...QUOTE_FIELDS }, ["quoteId"]),
    run: (tx, args) => updateQuote(tx, args.quoteId, pick(args, Object.keys(QUOTE_FIELDS))),
  },
  {
    name: "finalise_quote",
    title: "Finalise a quote",
    level: "full",
    description: "Gives a draft quote its number so it can be sent. Posts nothing.",
    inputSchema: schema({ quoteId: ID("quote"), idempotencyKey: IDEMPOTENCY }, ["quoteId"]),
    run: (tx, args, context) => finaliseQuote(tx, args.quoteId, { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) }),
  },
  {
    name: "create_sales_order",
    title: "Make a sales order",
    level: "full",
    description: "Makes a draft sales order. Posts nothing.",
    inputSchema: schema({ ...SALES_ORDER_FIELDS, idempotencyKey: IDEMPOTENCY }, ["contactId", "orderDate", "amountsMode", "lines"]),
    run: (tx, args, context) => createSalesOrder(tx, { ...pick(args, Object.keys(SALES_ORDER_FIELDS)), source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) }),
  },
  {
    name: "update_sales_order",
    title: "Edit a sales order",
    level: "full",
    description: "Edits a draft sales order. The lines given replace every line.",
    inputSchema: schema({ salesOrderId: ID("sales order"), ...SALES_ORDER_FIELDS }, ["salesOrderId"]),
    run: (tx, args) => updateSalesOrder(tx, args.salesOrderId, pick(args, Object.keys(SALES_ORDER_FIELDS))),
  },
  {
    name: "approve_sales_order",
    title: "Approve a sales order",
    level: "full",
    description: "Approves a draft sales order. Posts nothing.",
    inputSchema: schema({ salesOrderId: ID("sales order"), idempotencyKey: IDEMPOTENCY }, ["salesOrderId"]),
    run: (tx, args, context) => approveSalesOrder(tx, args.salesOrderId, { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) }),
  },
  {
    name: "create_credit_note",
    title: "Make a credit note",
    level: "full",
    description: "Makes a draft sales credit note for a customer. Posts nothing until approved.",
    inputSchema: schema({ ...CREDIT_NOTE_FIELDS, idempotencyKey: IDEMPOTENCY }, ["contactId", "creditNoteDate", "amountsMode", "lines"]),
    run: (tx, args, context) => createCreditNote(tx, { ...pick(args, Object.keys(CREDIT_NOTE_FIELDS)), source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) }),
  },
  {
    name: "update_credit_note",
    title: "Edit a credit note",
    level: "full",
    description: "Edits a draft sales credit note. The lines given replace every line.",
    inputSchema: schema({ creditNoteId: ID("credit note"), ...CREDIT_NOTE_FIELDS }, ["creditNoteId"]),
    run: (tx, args) => updateCreditNote(tx, args.creditNoteId, pick(args, Object.keys(CREDIT_NOTE_FIELDS))),
  },
  {
    name: "approve_credit_note",
    title: "Approve a credit note",
    level: "full",
    description: "Approves a draft sales credit note: it's numbered and posted (Dr sales and GST / Cr accounts receivable).",
    inputSchema: schema({ creditNoteId: ID("credit note"), idempotencyKey: IDEMPOTENCY }, ["creditNoteId"]),
    run: (tx, args, context) => approveCreditNote(tx, args.creditNoteId, { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) }),
  },
  {
    name: "apply_credit_note",
    title: "Apply a credit note",
    level: "full",
    description: "Applies an approved credit note's credit to the customer's invoices, reducing what they owe.",
    inputSchema: schema({ creditNoteId: ID("credit note"), applicationDate: DATE, applications: APPLICATIONS("invoice"), idempotencyKey: IDEMPOTENCY }, ["creditNoteId", "applicationDate", "applications"]),
    run: (tx, args, context) =>
      applyCreditNote(tx, args.creditNoteId, { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey), applicationDate: args.applicationDate, applications: args.applications }),
  },
  {
    name: "refund_credit_note",
    title: "Refund a credit note",
    level: "full",
    description: "Records money paid back to a customer for an approved credit note, from a bank account.",
    inputSchema: schema({ creditNoteId: ID("credit note"), ...REFUND_FIELDS }, ["creditNoteId", "refundDate", "amount", "bankAccountCode"]),
    run: (tx, args, context) =>
      refundCreditNote(tx, args.creditNoteId, { ...pick(args, REFUND_NAMES), source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey), refundDate: args.refundDate, amount: args.amount, bankAccountCode: args.bankAccountCode }),
  },
  {
    name: "apply_overpayment",
    title: "Apply an overpayment",
    level: "full",
    description: "Applies what's left of a customer's overpayment (list_overpayments) to their invoices.",
    inputSchema: schema({ paymentId: ID("overpayment"), applicationDate: DATE, applications: APPLICATIONS("invoice"), idempotencyKey: IDEMPOTENCY }, ["paymentId", "applicationDate", "applications"]),
    run: (tx, args, context) =>
      applyOverpayment(tx, args.paymentId, { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey), applicationDate: args.applicationDate, applications: args.applications }),
  },
  {
    name: "refund_overpayment",
    title: "Refund an overpayment",
    level: "full",
    description: "Records money paid back to a customer for their overpayment, from a bank account.",
    inputSchema: schema({ paymentId: ID("overpayment"), ...REFUND_FIELDS }, ["paymentId", "refundDate", "amount", "bankAccountCode"]),
    run: (tx, args, context) =>
      refundOverpayment(tx, args.paymentId, { ...pick(args, REFUND_NAMES), source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey), refundDate: args.refundDate, amount: args.amount, bankAccountCode: args.bankAccountCode }),
  },
  {
    name: "create_repeating_invoice",
    title: "Make a repeating invoice",
    level: "full",
    description: "Makes a repeating invoice template. Each invoice it makes is saved as saveAs says.",
    inputSchema: schema({ ...REPEATING_INVOICE_FIELDS, idempotencyKey: IDEMPOTENCY }, ["contactId", "amountsMode", "lines", "period", "every", "startDate"]),
    run: (tx, args, context) =>
      createRepeatingInvoice(tx, { ...pick(args, Object.keys(REPEATING_INVOICE_FIELDS)), source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) }),
  },
  {
    name: "update_repeating_invoice",
    title: "Edit a repeating invoice",
    level: "full",
    description: "Edits a repeating invoice template (not pause or stop it; that's for people).",
    inputSchema: schema({ repeatingInvoiceId: ID("repeating invoice"), ...REPEATING_INVOICE_FIELDS }, ["repeatingInvoiceId"]),
    run: (tx, args) => updateRepeatingInvoice(tx, args.repeatingInvoiceId, pick(args, Object.keys(REPEATING_INVOICE_FIELDS))),
  },

  // Purchases.
  {
    name: "create_purchase_order",
    title: "Make a purchase order",
    level: "full",
    description: "Makes a draft purchase order. Posts nothing.",
    inputSchema: schema({ ...PURCHASE_ORDER_FIELDS, idempotencyKey: IDEMPOTENCY }, ["contactId", "orderDate", "amountsMode", "lines"]),
    run: (tx, args, context) =>
      createPurchaseOrder(tx, { ...pick(args, Object.keys(PURCHASE_ORDER_FIELDS)), source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) }),
  },
  {
    name: "update_purchase_order",
    title: "Edit a purchase order",
    level: "full",
    description: "Edits a draft purchase order. The lines given replace every line.",
    inputSchema: schema({ purchaseOrderId: ID("purchase order"), ...PURCHASE_ORDER_FIELDS }, ["purchaseOrderId"]),
    run: (tx, args) => updatePurchaseOrder(tx, args.purchaseOrderId, pick(args, Object.keys(PURCHASE_ORDER_FIELDS))),
  },
  {
    name: "approve_purchase_order",
    title: "Approve a purchase order",
    level: "full",
    description: "Approves a draft purchase order. One an approval rule covers is for people to approve (submit_for_approval instead).",
    inputSchema: schema({ purchaseOrderId: ID("purchase order"), idempotencyKey: IDEMPOTENCY }, ["purchaseOrderId"]),
    async run(tx, args, context) {
      const needed = await approvalNeededForAi(tx, "purchase_order", requireId(args.purchaseOrderId, "purchaseOrderId"));
      if (needed) throw new ConflictError(needed);
      return approvePurchaseOrder(tx, args.purchaseOrderId, { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) });
    },
  },
  {
    name: "create_supplier_credit_note",
    title: "Make a supplier credit note",
    level: "full",
    description: "Makes a draft credit note from a supplier. Posts nothing until approved.",
    inputSchema: schema({ ...SUPPLIER_CREDIT_NOTE_FIELDS, idempotencyKey: IDEMPOTENCY }, ["contactId", "creditNoteDate", "amountsMode", "lines"]),
    run: (tx, args, context) =>
      createSupplierCreditNote(tx, { ...pick(args, Object.keys(SUPPLIER_CREDIT_NOTE_FIELDS)), source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) }),
  },
  {
    name: "update_supplier_credit_note",
    title: "Edit a supplier credit note",
    level: "full",
    description: "Edits a draft supplier credit note. The lines given replace every line.",
    inputSchema: schema({ creditNoteId: ID("supplier credit note"), ...SUPPLIER_CREDIT_NOTE_FIELDS }, ["creditNoteId"]),
    run: (tx, args) => updateSupplierCreditNote(tx, args.creditNoteId, pick(args, Object.keys(SUPPLIER_CREDIT_NOTE_FIELDS))),
  },
  {
    name: "approve_supplier_credit_note",
    title: "Approve a supplier credit note",
    level: "full",
    description: "Approves a draft supplier credit note: it's posted (Dr accounts payable / Cr expense and GST).",
    inputSchema: schema({ creditNoteId: ID("supplier credit note"), idempotencyKey: IDEMPOTENCY }, ["creditNoteId"]),
    run: (tx, args, context) => approveSupplierCreditNote(tx, args.creditNoteId, { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) }),
  },
  {
    name: "apply_supplier_credit_note",
    title: "Apply a supplier credit note",
    level: "full",
    description: "Applies an approved supplier credit note to that supplier's bills, reducing what you owe.",
    inputSchema: schema({ creditNoteId: ID("supplier credit note"), applicationDate: DATE, applications: APPLICATIONS("bill"), idempotencyKey: IDEMPOTENCY }, ["creditNoteId", "applicationDate", "applications"]),
    run: (tx, args, context) =>
      applySupplierCreditNote(tx, args.creditNoteId, { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey), applicationDate: args.applicationDate, applications: args.applications }),
  },
  {
    name: "refund_supplier_credit_note",
    title: "Record a supplier refund",
    level: "full",
    description: "Records money a supplier paid back for an approved supplier credit note, into a bank account.",
    inputSchema: schema({ creditNoteId: ID("supplier credit note"), ...REFUND_FIELDS }, ["creditNoteId", "refundDate", "amount", "bankAccountCode"]),
    run: (tx, args, context) =>
      refundSupplierCreditNote(tx, args.creditNoteId, { ...pick(args, REFUND_NAMES), source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey), refundDate: args.refundDate, amount: args.amount, bankAccountCode: args.bankAccountCode }),
  },
  {
    name: "create_repeating_bill",
    title: "Make a repeating bill",
    level: "full",
    description: "Makes a repeating bill template. Each bill it makes is saved as saveAs says; one an approval rule covers is submitted for people to approve (AW14).",
    inputSchema: schema({ ...REPEATING_BILL_FIELDS, idempotencyKey: IDEMPOTENCY }, ["contactId", "amountsMode", "lines", "period", "every", "startDate"]),
    run: (tx, args, context) =>
      createRepeatingBill(tx, { ...pick(args, Object.keys(REPEATING_BILL_FIELDS)), source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) }),
  },
  {
    name: "update_repeating_bill",
    title: "Edit a repeating bill",
    level: "full",
    description: "Edits a repeating bill template (not pause or stop it; that's for people).",
    inputSchema: schema({ repeatingBillId: ID("repeating bill"), ...REPEATING_BILL_FIELDS }, ["repeatingBillId"]),
    run: (tx, args) => updateRepeatingBill(tx, args.repeatingBillId, pick(args, Object.keys(REPEATING_BILL_FIELDS))),
  },
  {
    name: "approve_expense_claim",
    title: "Approve an expense claim",
    level: "full",
    description: "Approves a submitted expense claim, which posts it. One an approval rule covers is for people to approve.",
    inputSchema: schema({ claimId: ID("expense claim"), claimDate: { ...DATE, description: "The date it's posted on, as on the screen." }, idempotencyKey: IDEMPOTENCY }, ["claimId", "claimDate"]),
    async run(tx, args, context) {
      const needed = await approvalNeededForAi(tx, "expense_claim", requireId(args.claimId, "claimId"));
      if (needed) throw new ConflictError(needed);
      return approveExpenseClaim(tx, context.role, args.claimId, { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey), claimDate: args.claimDate });
    },
  },
  {
    name: "record_expense_claim_payment",
    title: "Pay an expense claim",
    level: "full",
    description: "Records paying back an approved expense claim, from a bank account.",
    inputSchema: schema(
      { claimId: ID("expense claim"), paymentDate: DATE, amount: MONEY("How much"), bankAccountCode: BANK_CODE, reference: { type: "string" }, idempotencyKey: IDEMPOTENCY },
      ["claimId", "paymentDate", "amount", "bankAccountCode"],
    ),
    run: (tx, args, context) =>
      recordExpenseClaimPayment(tx, context.role, args.claimId, {
        source: context.source,
        idempotencyKey: idempotencyKey(args.idempotencyKey),
        paymentDate: args.paymentDate,
        amount: args.amount,
        bankAccountCode: args.bankAccountCode,
        reference: args.reference,
      }),
  },

  // Set-up.
  {
    name: "create_item",
    title: "Add an item",
    level: "full",
    description: "Adds a product or service with its prices, accounts and GST codes.",
    inputSchema: schema({ ...ITEM_FIELDS, idempotencyKey: IDEMPOTENCY }, ["code", "name"]),
    run: (tx, args, context) => createItem(tx, { ...pick(args, Object.keys(ITEM_FIELDS)), source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) }),
  },
  {
    name: "update_item",
    title: "Edit an item",
    level: "full",
    description: "Edits a product or service (not archive it).",
    inputSchema: schema({ itemId: ID("item"), ...ITEM_FIELDS }, ["itemId"]),
    run: (tx, args) => updateItem(tx, args.itemId, pick(args, Object.keys(ITEM_FIELDS))),
  },
  {
    name: "create_tracking_category",
    title: "Add a tracking category",
    level: "full",
    description: "Adds a tracking category, e.g. Region.",
    inputSchema: schema({ name: { type: "string" }, isRequired: { type: "boolean" } }, ["name"]),
    run: (tx, args) => createTrackingCategory(tx, { name: args.name, isRequired: args.isRequired }),
  },
  {
    name: "update_tracking_category",
    title: "Rename a tracking category",
    level: "full",
    description: "Renames a tracking category or changes whether it's required (not switch it off).",
    inputSchema: schema({ categoryId: ID("tracking category"), name: { type: "string" }, isRequired: { type: "boolean" } }, ["categoryId"]),
    run: (tx, args) => updateTrackingCategory(tx, args.categoryId, { name: args.name, isRequired: args.isRequired }),
  },
  {
    name: "create_tracking_option",
    title: "Add a tracking option",
    level: "full",
    description: "Adds an option to a tracking category, e.g. Otago under Region.",
    inputSchema: schema({ categoryId: ID("tracking category"), name: { type: "string" }, parentId: ID("parent option") }, ["categoryId", "name"]),
    run: (tx, args) => createTrackingValue(tx, { categoryId: args.categoryId, name: args.name, parentId: args.parentId }),
  },
  {
    name: "update_tracking_option",
    title: "Rename a tracking option",
    level: "full",
    description: "Renames or moves a tracking option (not switch it off).",
    inputSchema: schema({ optionId: ID("tracking option"), name: { type: "string" }, parentId: ID("parent option") }, ["optionId"]),
    run: (tx, args) => updateTrackingValue(tx, args.optionId, { name: args.name, parentId: args.parentId }),
  },
  {
    name: "create_account",
    title: "Add an account",
    level: "full",
    description: "Adds an account to the chart of accounts. Check list_accounts first: codes must be new.",
    inputSchema: schema(ACCOUNT_FIELDS, ["code", "name", "accountType"]),
    run: (tx, args) => createAccount(tx, { code: args.code, name: args.name, accountType: args.accountType, ...pick(args, ["description", "currencyCode", "defaultTaxCode"]) }),
  },
  {
    name: "update_account",
    title: "Edit an account",
    level: "full",
    description: "Edits an account's code, name, type, description or default GST code (not archive it).",
    inputSchema: schema({ accountId: ID("account"), ...ACCOUNT_FIELDS }, ["accountId"]),
    run: (tx, args) => updateAccount(tx, args.accountId, pick(args, Object.keys(ACCOUNT_FIELDS))),
  },
  {
    name: "create_budget",
    title: "Make a budget",
    level: "full",
    description: "Makes an empty budget, optionally for one tracking option. Fill it with set_budget_amounts.",
    inputSchema: schema({ name: { type: "string" }, trackingValueId: ID("tracking option"), idempotencyKey: IDEMPOTENCY }, ["name"]),
    run: (tx, args, context) =>
      createBudget(tx, { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey), name: args.name, trackingValueId: args.trackingValueId }),
  },
  {
    name: "set_budget_amounts",
    title: "Set budget amounts",
    level: "full",
    description: "Sets a budget's amounts by account and month. Send budget.version from get_budget; if someone changed it since, it's refused.",
    inputSchema: schema(
      {
        budgetId: ID("budget"),
        version: { type: "integer", description: "budget.version from get_budget." },
        amounts: {
          type: "array",
          maxItems: 2000,
          items: { type: "object", properties: { accountCode: { type: "string" }, month: { type: "string", description: "YYYY-MM" }, amount: { type: "string" } }, required: ["accountCode", "month", "amount"] },
        },
      },
      ["budgetId", "version", "amounts"],
    ),
    run: (tx, args) => setBudgetAmounts(tx, args.budgetId, { version: args.version, amounts: args.amounts }),
  },
  {
    name: "register_fixed_asset",
    title: "Register a fixed asset",
    level: "full",
    description: "Adds an asset to the fixed asset register. Posts nothing (its cost is already in the books).",
    inputSchema: schema({ ...ASSET_FIELDS, idempotencyKey: IDEMPOTENCY }, ["name", "typeId", "purchaseDate", "cost"]),
    run: (tx, args, context) => createFixedAsset(tx, { ...pick(args, Object.keys(ASSET_FIELDS)), source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey) }),
  },
  {
    name: "update_fixed_asset",
    title: "Edit a fixed asset",
    level: "full",
    description: "Edits a registered asset's details or depreciation settings (not dispose of or archive it).",
    inputSchema: schema({ assetId: ID("fixed asset"), ...ASSET_FIELDS }, ["assetId"]),
    run: (tx, args) => updateFixedAsset(tx, args.assetId, pick(args, Object.keys(ASSET_FIELDS))),
  },
  {
    name: "run_depreciation",
    title: "Run depreciation",
    level: "full",
    description: "Posts depreciation for every registered asset up to a month end (check preview_depreciation first). Refused in a locked period.",
    inputSchema: schema({ periodEnd: { ...DATE, description: "A month end." }, idempotencyKey: IDEMPOTENCY }, ["periodEnd"]),
    run: (tx, args, context) => runDepreciation(tx, { source: context.source, idempotencyKey: idempotencyKey(args.idempotencyKey), periodEnd: args.periodEnd }),
  },
];

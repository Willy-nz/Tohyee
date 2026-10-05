import { createTransfer, createBankTransaction } from "@/lib/bank/transactions";
import { createContact } from "@/lib/contacts/service";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import { refundCreditNote } from "@/lib/credit-notes/refunds";
import type { OrgTx } from "@/lib/db/org-transaction";
import { HttpError } from "@/lib/errors";
import { recordPayment } from "@/lib/invoices/payments";
import { approveInvoice } from "@/lib/invoices/service";
import { cmp, dec } from "@/lib/money/decimal";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { approveSalesOrder, cancelSalesOrder, createSalesOrder, invoiceSalesOrder } from "@/lib/sales-orders/service";
import type { PlatformCustomer, PlatformOrder, PlatformPayout } from "@/lib/sales-platforms/connector";
import { type LogInput, writeLog } from "@/lib/sales-platforms/log";
import {
  type LinkedItem,
  type PostingRules,
  PAID_STATUSES,
  localDate,
  money,
  orderPayments,
  planOrder,
  type PayoutLine,
  planPayout,
  planRefund,
} from "@/lib/sales-platforms/orders";
import { SALES_PLATFORM_LABELS, type SalesPlatform, type SyncResult } from "@/lib/sales-platforms/types";
import { isOverseas } from "@/lib/tax/exports";

/**
 * Posting a platform's orders, refunds and payouts (examples SPC11-SPC23,
 * decisions 52-55) through Tohyee's own documents: sales orders, invoices,
 * customer payments, credit notes and their refunds, transfers and spend
 * money. Each goes through the same service as a person's would, so period
 * locks, stock and every other rule apply. What each Shopify record became is
 * remembered in sales_platform_documents (by store and Shopify ID), so
 * nothing is posted twice. Runs inside the caller's transaction: no network.
 */

const SOURCE = "sales-platform";

/** The connection's posting settings plus the organisation's, ready for planning. */
export type Posting = PostingRules & {
  connectionId: string;
  platform: SalesPlatform;
  storeDomain: string;
  startDate: string;
  /** The instant the start date begins in New Zealand. */
  startInstant: string;
  clearingAccountId: string;
  clearingAccountCode: string;
  payoutAccountCode: string;
  feesAccountCode: string;
  /** Where disputed amounts go, and the bank account Shopify's reserve sits in (SPC25-SPC31); null until chosen. */
  chargebacksAccountCode: string | null;
  reserveAccountCode: string | null;
  /** The contact guest checkouts go to (decision 317), or null to refuse them. */
  guestContactId: string | null;
};

export type PostingContext = {
  posting: Posting;
  source: "sync" | "webhook";
  counts: SyncResult;
  /** Brings the order's customer in as a contact (stage 1's rules) and returns the linked contact, or null if it couldn't be. */
  contactFor: (customer: PlatformCustomer) => Promise<string | null>;
};

type ConnectionSettingsRow = {
  id: string;
  platform: SalesPlatform;
  store_domain: string;
  post_to_accounts: boolean;
  start_date: string | null;
  clearing_account_id: string | null;
  clearing_code: string | null;
  payout_code: string | null;
  fees_code: string | null;
  sales_code: string | null;
  shipping_code: string | null;
  untaxed_code: string | null;
  chargebacks_code: string | null;
  reserve_code: string | null;
  guest_contact_id: string | null;
};

/**
 * The posting settings, or null when posting is off (nothing is fetched or
 * posted then, SPC21). `startInstant` is when the start date begins in the
 * business time zone.
 */
export async function loadPosting(tx: OrgTx, connectionId: string, startInstant: (date: string) => string): Promise<Posting | null> {
  const found = await tx.query<ConnectionSettingsRow>(
    `select c.id, c.platform, c.store_domain, c.post_to_accounts, c.start_date::text as start_date, c.clearing_account_id,
            clearing.code as clearing_code, payout.code as payout_code, fees.code as fees_code, sales.code as sales_code,
            shipping.code as shipping_code, untaxed.code as untaxed_code, c.guest_contact_id::text,
            chargebacks.code as chargebacks_code, reserve.code as reserve_code
       from sales_platform_connections c
       left join accounts clearing on clearing.id = c.clearing_account_id
       left join accounts payout on payout.id = c.payout_account_id
       left join accounts fees on fees.id = c.fees_account_id
       left join accounts sales on sales.id = c.sales_account_id
       left join accounts shipping on shipping.id = c.shipping_account_id
       left join accounts chargebacks on chargebacks.id = c.chargebacks_account_id
       left join accounts reserve on reserve.id = c.reserve_account_id
       left join tax_codes untaxed on untaxed.id = c.untaxed_tax_code_id
      where c.id = $1`,
    [connectionId],
  );
  const row = found.rows[0];
  if (!row || !row.post_to_accounts || !row.start_date || !row.clearing_account_id) return null;
  const mapped = await tx.query<{ rate: string; code: string; code_rate: string }>(
    `select m.rate::text as rate, t.code, t.rate::text as code_rate
       from sales_platform_tax_codes m join tax_codes t on t.id = m.tax_code_id
      where m.connection_id = $1 order by m.rate`,
    [connectionId],
  );
  const settings = await getOrganisationSettings(tx);
  return {
    connectionId: row.id,
    platform: row.platform,
    storeDomain: row.store_domain,
    startDate: row.start_date,
    startInstant: startInstant(row.start_date),
    clearingAccountId: row.clearing_account_id,
    clearingAccountCode: row.clearing_code!,
    payoutAccountCode: row.payout_code!,
    feesAccountCode: row.fees_code!,
    chargebacksAccountCode: row.chargebacks_code,
    reserveAccountCode: row.reserve_code,
    guestContactId: row.guest_contact_id,
    baseCurrency: tx.baseCurrency,
    gstRegistered: Boolean(settings.gstNumber),
    foreignTrade: settings.foreignTrade,
    exportTaxCode: settings.exportTaxCode,
    untaxedTaxCode: row.untaxed_code,
    taxCodes: mapped.rows.map((entry) => ({ rate: entry.rate, code: entry.code, codeRate: entry.code_rate })),
    salesAccountCode: row.sales_code!,
    shippingAccountCode: row.shipping_code!,
  };
}

// ---------------------------------------------------------------------------
// What each record became

type DocumentRow = {
  id: string;
  state: "open" | "done" | "cancelled";
  retry: boolean;
  contact_id: string | null;
  sales_order_id: string | null;
  invoice_id: string | null;
};

type RecordKind = "order" | "refund" | "payout";

async function findDocument(tx: OrgTx, posting: Posting, kind: RecordKind, externalId: string): Promise<DocumentRow | null> {
  const result = await tx.query<DocumentRow>(
    `select id, state, retry, contact_id, sales_order_id, invoice_id from sales_platform_documents
      where platform = $1 and store_domain = $2 and record_kind = $3 and external_id = $4 for update`,
    [posting.platform, posting.storeDomain, kind, externalId],
  );
  return result.rows[0] ?? null;
}

type DocumentValues = Partial<{
  state: "open" | "done" | "cancelled";
  retry: boolean;
  name: string;
  order_external_id: string;
  contact_id: string;
  sales_order_id: string;
  invoice_id: string;
  customer_payment_id: string;
  credit_note_id: string;
  credit_note_refund_id: string;
  transfer_id: string;
  bank_transaction_id: string;
  receipt_bank_transaction_id: string;
  reserve_held_transfer_id: string;
  reserve_released_transfer_id: string;
  external_updated_at: string | null;
}>;

const DOCUMENT_COLUMNS = [
  "state",
  "retry",
  "name",
  "order_external_id",
  "contact_id",
  "sales_order_id",
  "invoice_id",
  "customer_payment_id",
  "credit_note_id",
  "credit_note_refund_id",
  "transfer_id",
  "bank_transaction_id",
  "receipt_bank_transaction_id",
  "reserve_held_transfer_id",
  "reserve_released_transfer_id",
  "external_updated_at",
] as const;

/** Records (or updates) what a Shopify record became. Columns not given keep their values. */
async function saveDocument(tx: OrgTx, posting: Posting, kind: RecordKind, externalId: string, values: DocumentValues): Promise<void> {
  const given = DOCUMENT_COLUMNS.filter((column) => values[column] !== undefined);
  const params: unknown[] = [posting.platform, posting.storeDomain, kind, externalId, posting.connectionId, values.state ?? "open"];
  const columns = given.filter((column) => column !== "state");
  for (const column of columns) params.push(values[column]);
  const placeholders = columns.map((_, index) => `$${index + 7}`);
  const updates = given.map((column) =>
    column === "external_updated_at"
      ? "external_updated_at = greatest(sales_platform_documents.external_updated_at, excluded.external_updated_at)"
      : `${column} = excluded.${column}`,
  );
  await tx.query(
    `insert into sales_platform_documents (platform, store_domain, record_kind, external_id, connection_id, state${columns.map((c) => `, ${c}`).join("")})
     values ($1, $2, $3, $4, $5, $6${placeholders.map((p) => `, ${p}`).join("")})
     on conflict (platform, store_domain, record_kind, external_id) do update
        set connection_id = excluded.connection_id, ${[...updates, "updated_at = now()"].join(", ")}`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Helpers

type Attempt<T> = { ok: true; value: T } | { ok: false; error: Error };

/**
 * Runs one step in a savepoint: a refusal from Tohyee's own rules (a locked
 * period, not enough stock, an archived contact...) undoes just that step
 * and is reported, so what came before it stays (SPC17, SPC21).
 */
async function attempt<T>(tx: OrgTx, work: () => Promise<T>): Promise<Attempt<T>> {
  await tx.query("savepoint sales_platform_step");
  try {
    const value = await work();
    await tx.query("release savepoint sales_platform_step");
    return { ok: true, value };
  } catch (error) {
    await tx.query("rollback to savepoint sales_platform_step");
    await tx.query("release savepoint sales_platform_step");
    if (error instanceof HttpError || typeof (error as { code?: unknown }).code === "string") return { ok: false, error: error as Error };
    throw error;
  }
}

/** An idempotency key for a document made from a platform record: the same record always gives the same key. */
function keyFor(posting: Posting, kind: string, externalId: string, step: string): string {
  return `sp:${posting.storeDomain}:${kind}:${externalId}:${step}`.slice(0, 120);
}

async function log(tx: OrgTx, context: PostingContext, entry: Omit<LogInput, "source">): Promise<boolean> {
  return writeLog(tx, context.posting.connectionId, { source: context.source, ...entry });
}

async function refused(tx: OrgTx, context: PostingContext, kind: RecordKind, externalId: string, message: string): Promise<void> {
  if (await log(tx, context, { action: "failed", recordKind: kind, externalId, message })) context.counts.failed += 1;
}

const platformLabel = (posting: Posting) => SALES_PLATFORM_LABELS[posting.platform];

/** The items linked to the order's variants (SPC17). */
async function linkedItems(tx: OrgTx, posting: Posting, variantIds: string[]): Promise<Map<string, LinkedItem>> {
  if (variantIds.length === 0) return new Map();
  const result = await tx.query<{ external_id: string; id: string; code: string; item_type: string; income_code: string | null }>(
    `select m.external_id, i.id, i.code, i.item_type, a.code as income_code
       from sales_platform_mappings m
       join items i on i.id = m.item_id
       left join accounts a on a.id = i.income_account_id
      where m.connection_id = $1 and m.record_kind = 'product_variant' and m.external_id = any($2::text[])`,
    [posting.connectionId, variantIds],
  );
  return new Map(result.rows.map((row) => [row.external_id, { id: row.id, code: row.code, itemType: row.item_type, incomeAccountCode: row.income_code }]));
}

async function contactIsOverseas(tx: OrgTx, contactId: string): Promise<boolean> {
  const result = await tx.query<{ billing_country: string; delivery_country: string | null }>(
    "select billing_country, delivery_country from contacts where id = $1",
    [contactId],
  );
  const row = result.rows[0];
  return isOverseas(row ? { billingCountry: row.billing_country, deliveryCountry: row.delivery_country } : null);
}

const errorText = (error: Error) => error.message.replace(/\s+$/, "");

// ---------------------------------------------------------------------------
// Orders and refunds (SPC11-SPC14, SPC16-SPC18, SPC20, SPC21, SPC23)

/**
 * Brings one order in, as far as it can go: the approved sales order, then
 * (paid) the invoice and its payment into the clearing account, then each
 * refund as a credit note refunded from the clearing account; or cancels
 * the sales order when Shopify cancelled it before it was paid. Safe to run
 * any number of times for the same order.
 */
export async function postOrder(tx: OrgTx, context: PostingContext, order: PlatformOrder): Promise<void> {
  const posting = context.posting;
  const shop = platformLabel(posting);
  const kind = "order";
  const id = order.externalId;
  let doc = await findDocument(tx, posting, kind, id);
  const paid = order.financialStatus !== null && PAID_STATUSES.includes(order.financialStatus);

  // Something stopped it on Tohyee's side: tried again next sync (SPC17, SPC21).
  const wait = async (message: string, action: "failed" | "waiting" = "failed") => {
    await saveDocument(tx, posting, kind, id, { name: order.name, retry: true, ...(doc ? {} : { state: "open" }) });
    if (await log(tx, context, { action, recordKind: kind, externalId: id, message: `${message} It's tried again at the next sync.` })) {
      if (action === "failed") context.counts.failed += 1;
      else context.counts.waiting = (context.counts.waiting ?? 0) + 1;
    }
  };
  // Nothing more will happen to it unless Shopify changes it: it no longer holds a retry place.
  const settle = async () => {
    if (doc?.retry) await saveDocument(tx, posting, kind, id, { retry: false });
  };

  // Refused because of what the order is: tried again only if Shopify changes it.
  const refuse = async (message: string) => {
    await settle();
    await refused(tx, context, kind, id, message);
  };

  if (!doc || doc.sales_order_id === null) {
    if (Date.parse(order.processedAt) < Date.parse(posting.startInstant)) {
      await settle();
      await log(tx, context, {
        action: "skipped",
        recordKind: kind,
        externalId: id,
        message: `${order.name} was processed before the start date (${posting.startDate}), so it isn't brought in.`,
      });
      return;
    }
    if (order.cancelledAt && !paid) {
      await settle();
      await log(tx, context, {
        action: "skipped",
        recordKind: kind,
        externalId: id,
        message: `${order.name} was cancelled in ${shop} before it was paid or brought in, so there's nothing to post.`,
      });
      return;
    }
    let contactId: string | null;
    let overseas: boolean;
    if (!order.customer) {
      // A guest checkout goes to the contact chosen for them (decision 317); whether it's an export comes from the order itself.
      if (!posting.guestContactId) {
        await refuse(`${order.name} has no ${shop} customer (a guest checkout). Choose a contact for guest checkouts in the connection's settings to bring it in.`);
        return;
      }
      contactId = posting.guestContactId;
      overseas = order.billingCountry !== null && isOverseas({ billingCountry: order.billingCountry, deliveryCountry: null });
    } else {
      const customer: PlatformCustomer = { ...order.customer, country: order.customer.country ?? order.billingCountry };
      contactId = await context.contactFor(customer);
      if (!contactId) {
        await wait(`${order.name}'s customer couldn't be linked to a contact (see the customer's line in this log), so the order waits.`, "waiting");
        return;
      }
      overseas = await contactIsOverseas(tx, contactId);
    }
    const items = await linkedItems(tx, posting, order.lines.flatMap((line) => (line.variantId ? [line.variantId] : [])));
    // A stock item the variant isn't linked to yet would sell without moving stock: wait for the product sync to link it.
    for (const line of order.lines) {
      if (!line.sku || (line.variantId && items.has(line.variantId))) continue;
      const stock = await tx.query<{ code: string }>("select code from items where lower(code) = lower($1) and item_type = 'stock' limit 1", [line.sku]);
      if (stock.rows[0]) {
        await wait(`${order.name} sells ${line.name} (SKU ${line.sku}), which isn't linked to stock item ${stock.rows[0].code} yet, so the order waits for the product sync.`, "waiting");
        return;
      }
    }
    const plan = planOrder(order, posting, items, overseas);
    if (!plan.ok) {
      await refuse(plan.reason);
      return;
    }
    const made = await attempt(tx, async () => {
      const { salesOrder } = await createSalesOrder(tx, {
        source: SOURCE,
        idempotencyKey: keyFor(posting, "order", id, "so"),
        contactId,
        orderDate: localDate(order.processedAt),
        reference: order.name,
        memo: `${shop} order ${order.name}`,
        amountsMode: plan.amountsMode,
        lines: plan.lines,
      });
      const approved = await approveSalesOrder(tx, salesOrder.id, { source: SOURCE, idempotencyKey: keyFor(posting, "order", id, "so-approve") });
      return approved.salesOrder;
    });
    if (!made.ok) {
      await wait(`${order.name} couldn't be added as a sales order: ${errorText(made.error)}`);
      return;
    }
    await saveDocument(tx, posting, kind, id, {
      state: "open",
      retry: false,
      name: order.name,
      contact_id: contactId,
      sales_order_id: made.value.id,
      external_updated_at: order.updatedAt,
    });
    context.counts.posted = (context.counts.posted ?? 0) + 1;
    await log(tx, context, {
      action: "posted",
      recordKind: kind,
      externalId: id,
      contactId,
      documentType: "sales_order",
      documentId: made.value.id,
      message: [`Added approved sales order ${made.value.soNumber} for ${order.name} (${money(made.value.total)}).`, ...plan.notes].join(" "),
    });
    doc = await findDocument(tx, posting, kind, id);
  }
  if (!doc || doc.sales_order_id === null || doc.contact_id === null) return;
  if (doc.state === "cancelled") return;

  // Cancelled before it was paid (SPC20).
  if (doc.invoice_id === null && order.cancelledAt && !paid) {
    const cancelled = await attempt(tx, () =>
      cancelSalesOrder(tx, doc!.sales_order_id, { source: SOURCE, idempotencyKey: keyFor(posting, "order", id, "so-cancel") }),
    );
    if (!cancelled.ok) {
      await wait(`${order.name} was cancelled in ${shop}, but its sales order couldn't be cancelled: ${errorText(cancelled.error)}`);
      return;
    }
    await saveDocument(tx, posting, kind, id, { state: "cancelled", retry: false, external_updated_at: order.updatedAt });
    await log(tx, context, {
      action: "cancelled",
      recordKind: kind,
      externalId: id,
      documentType: "sales_order",
      documentId: doc.sales_order_id,
      message: `${order.name} was cancelled in ${shop} before it was paid, so sales order ${cancelled.value.salesOrder.soNumber} was cancelled.`,
    });
    return;
  }

  // Paid: invoiced from the sales order, and the payment into the clearing account (SPC11-SPC13, SPC16, SPC17).
  if (doc.invoice_id === null) {
    if (!paid) {
      const status = (order.financialStatus ?? "unknown").toLowerCase().replace(/_/g, " ");
      if (await log(tx, context, { action: "waiting", recordKind: kind, externalId: id, message: `${order.name} isn't paid yet (${shop} says ${status}), so it isn't invoiced.` })) {
        context.counts.waiting = (context.counts.waiting ?? 0) + 1;
      }
      if (doc.retry) await saveDocument(tx, posting, kind, id, { retry: false });
      return;
    }
    const payments = orderPayments(order);
    if (payments.giftCard) {
      await refuse(`${order.name} was paid (at least partly) with a gift card; gift cards aren't supported yet, so it isn't invoiced.`);
      return;
    }
    if (cmp(payments.amount, dec(order.total)) !== 0) {
      await refuse(`${order.name}'s payments come to ${money(payments.amount)} but its total is ${money(order.total)}, so it isn't invoiced.`);
      return;
    }
    const salesOrder = await tx.query<{ total: string; order_date: string }>("select total::text, order_date::text from sales_orders where id = $1", [
      doc.sales_order_id,
    ]);
    if (cmp(dec(salesOrder.rows[0].total), dec(order.total)) !== 0) {
      await refuse(
        `${order.name}'s total in ${shop} is now ${money(order.total)} but its sales order is ${money(salesOrder.rows[0].total)} (edited orders aren't supported yet), so it isn't invoiced.`,
      );
      return;
    }
    let invoiceDate = localDate(payments.lastAt ?? order.processedAt);
    if (invoiceDate < salesOrder.rows[0].order_date) invoiceDate = salesOrder.rows[0].order_date;
    const invoiced = await attempt(tx, async () => {
      const { invoice } = await invoiceSalesOrder(tx, doc!.sales_order_id, {
        source: SOURCE,
        idempotencyKey: keyFor(posting, "order", id, "invoice"),
        invoiceDate,
        dueDate: invoiceDate,
      });
      const approved = await approveInvoice(tx, invoice.id, { source: SOURCE, idempotencyKey: keyFor(posting, "order", id, "invoice-approve") });
      const { payment } = await recordPayment(tx, invoice.id, {
        source: SOURCE,
        idempotencyKey: keyFor(posting, "order", id, "payment"),
        paymentDate: invoiceDate,
        amount: money(order.total),
        bankAccountCode: posting.clearingAccountCode,
        reference: `${shop} ${order.name}`,
      });
      return { invoice: approved.invoice, payment };
    });
    if (!invoiced.ok) {
      await wait(`${order.name} couldn't be invoiced: ${errorText(invoiced.error)}`);
      return;
    }
    await saveDocument(tx, posting, kind, id, {
      state: "done",
      retry: false,
      invoice_id: invoiced.value.invoice.id,
      customer_payment_id: invoiced.value.payment.id,
      external_updated_at: order.updatedAt,
    });
    context.counts.posted = (context.counts.posted ?? 0) + 1;
    await log(tx, context, {
      action: "posted",
      recordKind: kind,
      externalId: id,
      contactId: doc.contact_id,
      documentType: "invoice",
      documentId: invoiced.value.invoice.id,
      message: `Invoiced ${order.name} as ${invoiced.value.invoice.invoiceNumber} (${money(invoiced.value.invoice.total)}) and recorded its payment into ${posting.clearingAccountCode} on ${invoiceDate}.`,
    });
    doc = await findDocument(tx, posting, kind, id);
    if (!doc || doc.invoice_id === null) return;
  }

  // Refunds (SPC14).
  let failedRefund = false;
  const overseas = await contactIsOverseas(tx, doc.contact_id!);
  const items = await linkedItems(tx, posting, order.lines.flatMap((line) => (line.variantId ? [line.variantId] : [])));
  for (const refund of order.refunds) {
    if (await findDocument(tx, posting, "refund", refund.externalId)) continue;
    const plan = planRefund(order, refund, posting, items, overseas);
    if (plan.ok === "nothing") {
      await saveDocument(tx, posting, "refund", refund.externalId, { state: "done", order_external_id: id, name: order.name });
      await log(tx, context, { action: "skipped", recordKind: "refund", externalId: refund.externalId, message: plan.reason });
      continue;
    }
    if (!plan.ok) {
      await refused(tx, context, "refund", refund.externalId, plan.reason);
      continue;
    }
    const invoice = await tx.query<{ invoice_date: string; amounts_mode: string }>("select invoice_date::text, amounts_mode from sales_invoices where id = $1", [
      doc.invoice_id,
    ]);
    const date = plan.date < invoice.rows[0].invoice_date ? invoice.rows[0].invoice_date : plan.date;
    const credited = await attempt(tx, async () => {
      const { creditNote } = await createCreditNote(tx, {
        source: SOURCE,
        idempotencyKey: keyFor(posting, "refund", refund.externalId, "credit-note"),
        contactId: doc!.contact_id,
        creditNoteDate: date,
        reference: `${order.name} refund`,
        amountsMode: invoice.rows[0].amounts_mode,
        lines: plan.lines,
        returnInvoiceId: doc!.invoice_id,
      });
      const approved = await approveCreditNote(tx, creditNote.id, { source: SOURCE, idempotencyKey: keyFor(posting, "refund", refund.externalId, "approve") });
      const { refund: paidBack } = await refundCreditNote(tx, creditNote.id, {
        source: SOURCE,
        idempotencyKey: keyFor(posting, "refund", refund.externalId, "refund"),
        refundDate: date,
        amount: plan.total,
        bankAccountCode: posting.clearingAccountCode,
        reference: `${shop} ${order.name} refund`,
      });
      return { creditNote: approved.creditNote, refund: paidBack };
    });
    if (!credited.ok) {
      failedRefund = true;
      await log(tx, context, {
        action: "failed",
        recordKind: "refund",
        externalId: refund.externalId,
        message: `${order.name}'s refund of ${plan.refunded} couldn't be posted: ${errorText(credited.error)} It's tried again at the next sync.`,
      });
      continue;
    }
    await saveDocument(tx, posting, "refund", refund.externalId, {
      state: "done",
      order_external_id: id,
      name: order.name,
      contact_id: doc.contact_id!,
      credit_note_id: credited.value.creditNote.id,
      credit_note_refund_id: credited.value.refund.id,
    });
    context.counts.posted = (context.counts.posted ?? 0) + 1;
    await log(tx, context, {
      action: "posted",
      recordKind: "refund",
      externalId: refund.externalId,
      contactId: doc.contact_id,
      documentType: "credit_note",
      documentId: credited.value.creditNote.id,
      message: `Credited ${order.name}'s refund as ${credited.value.creditNote.creditNoteNumber} (${money(credited.value.creditNote.total)}) and paid it from ${posting.clearingAccountCode} on ${date}.`,
    });
  }
  await saveDocument(tx, posting, kind, id, { retry: failedRefund, external_updated_at: order.updatedAt });
}

// ---------------------------------------------------------------------------
// Payouts (SPC15)

/** The contact spend money for Shopify's fees is with: "Shopify", added if there isn't one. */
async function platformContact(tx: OrgTx, posting: Posting): Promise<string> {
  const name = platformLabel(posting);
  const found = await tx.query<{ id: string }>("select id from contacts where not is_archived and lower(name) = lower($1) order by id limit 1", [name]);
  if (found.rows[0]) return found.rows[0].id;
  const { contact } = await createContact(tx, {
    idempotencyKey: `sp-${posting.platform}-contact-${posting.storeDomain}`.slice(0, 120),
    source: SOURCE,
    name,
    isSupplier: true,
  });
  return contact.id;
}

/** "refused": its data can't be posted (logged; record it by hand). "failed": stopped on Tohyee's side, tried again. */
export type PayoutOutcome = "posted" | "done" | "waiting" | "refused" | "failed";

/**
 * Posts a paid payout: a transfer from the clearing account to the bank for
 * its net, and spend money from the clearing account for the fees and
 * adjustments (no GST). "done" means there's nothing more to do with it.
 */
export async function postPayout(tx: OrgTx, context: PostingContext, payout: PlatformPayout): Promise<PayoutOutcome> {
  const posting = context.posting;
  const id = payout.externalId;
  if (await findDocument(tx, posting, "payout", id)) return "done";
  if (Date.parse(payout.issuedAt) < Date.parse(posting.startInstant)) return "done";
  if (payout.status === "CANCELED" || payout.status === "FAILED") {
    await log(tx, context, { action: "skipped", recordKind: "payout", externalId: id, message: `Payout ${id} ${payout.status === "FAILED" ? "failed" : "was cancelled"} in ${platformLabel(posting)}, so there's nothing to post.` });
    return "done";
  }
  if (payout.status !== "PAID") return "waiting";
  const plan = planPayout(payout, posting.baseCurrency);
  if (!plan.ok) {
    await refused(tx, context, "payout", id, plan.reason);
    return "refused";
  }
  // Chargebacks and reserves need their accounts chosen first (SPC30). That's
  // fixed on Tohyee's side, so the payout is tried again at each sync ("failed").
  const needsChargebacks = [...plan.charges, ...plan.receipts].some((line) => line.account === "chargebacks");
  const missing = needsChargebacks && !posting.chargebacksAccountCode ? "chargebacks" : (plan.reserveHeld || plan.reserveReleased) && !posting.reserveAccountCode ? "reserve" : null;
  if (missing) {
    const what = missing === "chargebacks" ? "a chargeback" : "a reserve";
    await refused(tx, context, "payout", id, `Payout ${id} has ${what}. Choose a ${missing} account in the ${platformLabel(posting)} settings.`);
    return "failed";
  }
  const accountFor = (line: PayoutLine) => (line.account === "chargebacks" ? posting.chargebacksAccountCode! : posting.feesAccountCode);
  const reference = `${platformLabel(posting)} payout ${id}`;
  const made = await attempt(tx, async () => {
    const moveReserve = async (step: string, amount: string | null, from: string, to: string, what: string) =>
      amount === null
        ? null
        : (
            await createTransfer(tx, {
              source: SOURCE,
              idempotencyKey: keyFor(posting, "payout", id, step),
              fromAccountCode: from,
              toAccountCode: to,
              date: plan.date,
              amount,
              reference: `${platformLabel(posting)} reserve ${what}, payout ${id}`,
            })
          ).transfer.id;
    // Money coming back into the clearing account first (won disputes, a released reserve), so it's there to pay out.
    let receiptId: string | null = null;
    if (plan.receipts.length > 0) {
      const { bankTransaction } = await createBankTransaction(tx, {
        source: SOURCE,
        idempotencyKey: keyFor(posting, "payout", id, "receipts"),
        kind: "receive",
        accountId: posting.clearingAccountId,
        contactId: await platformContact(tx, posting),
        date: plan.date,
        reference,
        amountsMode: "no_tax",
        lines: plan.receipts.map((line) => ({ description: line.description, accountCode: accountFor(line), taxCode: null, amount: line.amount })),
      });
      receiptId = bankTransaction.id;
    }
    const releasedId = await moveReserve("reserve-released", plan.reserveReleased, posting.reserveAccountCode!, posting.clearingAccountCode, "released");
    const heldId = await moveReserve("reserve-held", plan.reserveHeld, posting.clearingAccountCode, posting.reserveAccountCode!, "held");
    let bankTransactionId: string | null = null;
    if (plan.charges.length > 0) {
      const { bankTransaction } = await createBankTransaction(tx, {
        source: SOURCE,
        idempotencyKey: keyFor(posting, "payout", id, "fees"),
        kind: "spend",
        accountId: posting.clearingAccountId,
        contactId: await platformContact(tx, posting),
        date: plan.date,
        reference,
        amountsMode: "no_tax",
        lines: plan.charges.map((line) => ({ description: line.description, accountCode: accountFor(line), taxCode: null, amount: line.amount })),
      });
      bankTransactionId = bankTransaction.id;
    }
    const { transfer } = await createTransfer(tx, {
      source: SOURCE,
      idempotencyKey: keyFor(posting, "payout", id, "transfer"),
      fromAccountCode: posting.clearingAccountCode,
      toAccountCode: posting.payoutAccountCode,
      date: plan.date,
      amount: plan.net,
      reference,
    });
    return { transferId: transfer.id, bankTransactionId, receiptId, heldId, releasedId };
  });
  if (!made.ok) {
    await log(tx, context, {
      action: "failed",
      recordKind: "payout",
      externalId: id,
      message: `Payout ${id} (${plan.net}) couldn't be posted: ${errorText(made.error)} It's tried again at the next sync.`,
    });
    context.counts.failed += 1;
    return "failed";
  }
  const value = made.value;
  await saveDocument(tx, posting, "payout", id, {
    state: "done",
    name: `Payout ${id}`,
    transfer_id: value.transferId,
    ...(value.bankTransactionId ? { bank_transaction_id: value.bankTransactionId } : {}),
    ...(value.receiptId ? { receipt_bank_transaction_id: value.receiptId } : {}),
    ...(value.heldId ? { reserve_held_transfer_id: value.heldId } : {}),
    ...(value.releasedId ? { reserve_released_transfer_id: value.releasedId } : {}),
  });
  context.counts.posted = (context.counts.posted ?? 0) + 1;
  const parts = [`${plan.net} from ${posting.clearingAccountCode} to ${posting.payoutAccountCode}`];
  if (plan.charges.length > 0) parts.push(`${plan.charges.map((line) => `${line.amount} to ${accountFor(line)}`).join(", ")} paid out of ${posting.clearingAccountCode}`);
  if (plan.receipts.length > 0) parts.push(`${plan.receipts.map((line) => `${line.amount} from ${accountFor(line)}`).join(", ")} back into ${posting.clearingAccountCode}`);
  if (plan.reserveHeld) parts.push(`${plan.reserveHeld} held in ${posting.reserveAccountCode}`);
  if (plan.reserveReleased) parts.push(`${plan.reserveReleased} released from ${posting.reserveAccountCode}`);
  await log(tx, context, {
    action: "posted",
    recordKind: "payout",
    externalId: id,
    documentType: "transfer",
    documentId: value.transferId,
    message: `Posted payout ${id} on ${plan.date}: ${parts.join("; ")}.`,
  });
  return "posted";
}

/** Payouts already posted for this store (so their transactions aren't fetched again). */
export async function postedPayoutIds(tx: OrgTx, platform: SalesPlatform, storeDomain: string): Promise<Set<string>> {
  const result = await tx.query<{ external_id: string }>(
    "select external_id from sales_platform_documents where platform = $1 and store_domain = $2 and record_kind = 'payout'",
    [platform, storeDomain],
  );
  return new Set(result.rows.map((row) => row.external_id));
}

/** Orders a sync should fetch again because something stopped them on Tohyee's side. */
export async function ordersToRetry(tx: OrgTx, connectionId: string, limit = 25): Promise<string[]> {
  const result = await tx.query<{ external_id: string }>(
    "select external_id from sales_platform_documents where connection_id = $1 and record_kind = 'order' and retry order by updated_at limit $2",
    [connectionId, limit],
  );
  return result.rows.map((row) => row.external_id);
}

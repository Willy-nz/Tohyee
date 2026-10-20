import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { ValidationError } from "@/lib/errors";
import { add, cmp, dec, divide, isNegative, isPositive, isZero, sub, sum, toFixedString, toPlainString } from "@/lib/money/decimal";
import {
  type AccessToken,
  type ConnectInput,
  PlatformError,
  type PlatformBalanceTransaction,
  type PlatformCustomer,
  type PlatformOrder,
  type PlatformOrderLine,
  type PlatformPayout,
  type PlatformRefund,
  type PlatformTaxLine,
  type PlatformTransaction,
  type SalesPlatformConnector,
  type StoreInfo,
  type WebhookRecords,
} from "@/lib/sales-platforms/connector";
import { platformFetch } from "@/lib/sales-platforms/http";
import { ORDER_SCOPE } from "@/lib/sales-platforms/types";
import { requireString } from "@/lib/validation";

/**
 * The Square connector (examples SQ1-SQ10, decisions 667-669). Not tried
 * against a real Square account: the tests use Square-shaped responses
 * written from Square's API reference.
 *
 * - Square's own developer docs list payment processing in Australia,
 *   Canada, France, Ireland, Japan, Spain, the UK and the US, not New
 *   Zealand (https://developer.squareup.com/docs/international-development).
 *   Orders in another currency than the organisation's are refused, as for
 *   the other platforms.
 * - Access: the seller's own app's personal access token, which "provides
 *   unrestricted Square API access" to the seller's own account and is
 *   "suitable for production use" there; the Webhook Subscriptions API needs
 *   it too (https://developer.squareup.com/docs/build-basics/access-tokens).
 *   Tohyee only reads, and says so: the token itself can't be limited.
 * - The API at https://connect.squareup.com/v2 with Square-Version
 *   2026-09-16, the version in Square's API reference on 20 Oct 2026
 *   (https://developer.squareup.com/reference/square/orders-api/search-orders).
 * - Orders: SearchOrders (POST /v2/orders/search, up to 10 locations, sorted
 *   by updated_at); payments (GET /v2/payments/{id}); refunds (GET
 *   /v2/refunds?updated_at_begin_time=..., GET /v2/refunds/{id}); the return
 *   orders refunds' lines are on; customers (GET /v2/customers/{id}); SKUs
 *   from the catalog (POST /v2/catalog/batch-retrieve).
 * - Payouts: ListPayouts and ListPayoutEntries per location; a CHARGE
 *   entry's net is its gross less its fee
 *   (https://developer.squareup.com/docs/payouts-api/list-payout-entries).
 * - Webhooks: subscribed with POST /v2/webhooks/subscriptions, whose answer
 *   has the signature key
 *   (https://developer.squareup.com/docs/webhooks/webhook-subscriptions-api);
 *   `x-square-hmacsha256-signature` is the base64 HMAC-SHA256, with that
 *   key, of the notification URL followed by the raw body
 *   (https://developer.squareup.com/docs/webhooks/step3validate,
 *   https://webhookrelay.com/verify-square-webhook-signature/). Each event
 *   has its own event_id.
 * - Amounts are whole numbers of the currency's smallest unit (cents).
 */

export const SQUARE_API_VERSION = "2026-09-16";
const BASE = "https://connect.squareup.com/v2";
const TIMEOUT_MS = 30_000;
const ORDERS_PER_PAGE = 50;
const MAX_ORDER_PAGES = 4;
const REFUNDS_PER_PAGE = 100;
const MAX_REFUND_PAGES = 4;
const PAYOUTS_PER_PAGE = 100;
const MAX_PAYOUT_PAGES = 4;
const ENTRIES_PER_PAGE = 100;
const MAX_ENTRY_PAGES = 5;
const LOCATIONS_PER_SEARCH = 10;
/** Orders that are real sales or were: drafts aren't (https://developer.squareup.com/docs/orders-api/manage-orders/search-orders). */
const ORDER_STATES = ["OPEN", "COMPLETED", "CANCELED"];
const WEBHOOK_EVENTS = ["order.created", "order.updated", "payment.created", "payment.updated", "refund.created", "refund.updated"] as const;

/** Tender types whose money lands in the Square balance and comes out in a payout (SQ2). Gift cards too, so they're refused as gift cards. */
const PAID_OUT_BY_SQUARE = new Set(["CARD", "WALLET", "BUY_NOW_PAY_LATER", "SQUARE_ACCOUNT", "BANK_ACCOUNT", "SQUARE_GIFT_CARD"]);
const TENDER_TITLES: Record<string, string> = {
  CASH: "Cash",
  OTHER: "Other",
  THIRD_PARTY_CARD: "Card on another terminal (e.g. EFTPOS)",
  NO_SALE: "No sale",
};
/** Currencies with no minor unit. Every other currency Square uses has two places. */
const NO_CENTS = new Set(["JPY"]);

type Json = Record<string, unknown>;

const record = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const records = (value: unknown): Json[] => list(value).map(record);
const text = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};
const timestamp = (value: unknown): string | null => {
  const raw = text(value);
  if (!raw) return null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
};
const latest = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);

/** Square's Money ({ amount: 4600, currency: "NZD" }) as a two-place decimal string ("46.00"); no amount is 0.00. */
export function squareMoney(value: unknown): string {
  const money = record(value);
  const amount = money.amount;
  const raw = typeof amount === "number" && Number.isSafeInteger(amount) ? String(amount) : typeof amount === "string" && /^-?\d{1,18}$/.test(amount) ? amount : null;
  if (raw === null) {
    if (amount === undefined || amount === null) return "0.00";
    throw new ValidationError(`Square sent an amount that isn't a whole number of cents: ${String(amount).slice(0, 30)}`);
  }
  const places = NO_CENTS.has(text(money.currency) ?? "") ? 0 : 2;
  return toFixedString(divide(dec(raw), dec(places === 0 ? "1" : "100"), 2), 2);
}

const currencyOf = (value: unknown): string | null => text(record(value).currency);
const isNothing = (value: string) => isZero(dec(value));

// ---------------------------------------------------------------------------
// Checking what an admin typed

/** What a connection is called before Square says which account the token is for (its merchant ID replaces it). */
const UNKNOWN_ACCOUNT = "square";

// ---------------------------------------------------------------------------
// Webhook signatures

/**
 * Whether `signature` is the base64 HMAC-SHA256, with the subscription's
 * signature key, of the notification URL followed by the raw body (SQ8),
 * compared in constant time.
 */
export function verifySquareWebhook(rawBody: string | Buffer, signature: string | null, signatureKey: string, notificationUrl: string): boolean {
  if (!signature || !signatureKey || !notificationUrl) return false;
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", signatureKey).update(Buffer.concat([Buffer.from(notificationUrl, "utf8"), body])).digest();
  const given = Buffer.from(signature.trim(), "base64");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------------------
// Square's records in Tohyee's shape (pure, so they're tested on their own)

/** A Square customer (https://developer.squareup.com/reference/square/objects/Customer). */
export function squareCustomerFrom(raw: unknown): PlatformCustomer | null {
  const c = record(raw);
  const id = text(c.id);
  if (!id) return null;
  const email = text(c.email_address);
  const phone = text(c.phone_number);
  const person = [text(c.given_name), text(c.family_name)].filter(Boolean).join(" ");
  const country = text(record(c.address).country)?.toUpperCase() ?? null;
  return {
    externalId: id,
    name: person || text(c.company_name) || text(c.nickname) || email || phone,
    email,
    phone,
    country: country && /^[A-Z]{2}$/.test(country) ? country : null,
    updatedAt: timestamp(c.updated_at),
  };
}

/** A return order (made by an itemised refund): it has returns and no line items of its own. */
export function isReturnOrder(raw: unknown): boolean {
  const order = record(raw);
  return list(order.returns).length > 0 && list(order.line_items).length === 0;
}

/** The sale orders a return order returns items from. */
export function returnedFrom(raw: unknown): string[] {
  return [...new Set(records(record(raw).returns).flatMap((entry) => (text(entry.source_order_id) ? [text(entry.source_order_id)!] : [])))];
}

/** What else an order needs, read separately: its customer, its lines' SKUs, its payments, their refunds and the refunds' return orders. */
export type SquareOrderExtras = {
  customer: unknown | null;
  /** Catalog object (item variation) ID -> SKU. */
  skus: ReadonlyMap<string, string>;
  /** Payment ID -> Payment. */
  payments: ReadonlyMap<string, unknown>;
  /** The PaymentRefunds of the order's payments. */
  refunds: readonly unknown[];
  /** Order ID -> the return order a refund's lines are on. */
  returnOrders: ReadonlyMap<string, unknown>;
};

const NO_EXTRAS: SquareOrderExtras = { customer: null, skus: new Map(), payments: new Map(), refunds: [], returnOrders: new Map() };

/** "15" or "15.0" (Square's percentage) as the fraction "0.15". */
function rateOf(percentage: unknown): string {
  const raw = text(percentage);
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return "0";
  return toPlainString(divide(dec(raw), dec("100"), 6));
}

function taxLinesOf(applied: unknown, taxes: ReadonlyMap<string, Json>): PlatformTaxLine[] {
  return records(applied).map((entry) => {
    const tax = taxes.get(text(entry.tax_uid) ?? "") ?? {};
    return { title: text(tax.name), rate: rateOf(tax.percentage), amount: squareMoney(entry.applied_money) };
  });
}

/**
 * A Square order as a platform order (SQ2-SQ7, SQ10). Amounts: a line's
 * total_money is what's collected for it after its discounts; with
 * inclusive taxes that includes the tax, with additive taxes the tax
 * (total_tax_money) is taken off to give the amount before tax. Square's
 * gross_sales_money isn't used: whether it includes tax differs by country
 * (https://developer.squareup.com/reference/square/objects/OrderLineItem).
 */
export function squareOrderFrom(raw: unknown, extras: SquareOrderExtras = NO_EXTRAS): PlatformOrder {
  const order = record(raw);
  const id = text(order.id);
  if (!id) throw new ValidationError("Square sent an order without an ID.");
  const createdAt = timestamp(order.created_at);
  if (!createdAt) throw new ValidationError(`Square sent order ${id} without a date.`);
  const state = text(order.state) ?? "OPEN";
  const currency = currencyOf(order.total_money) ?? "";
  const total = squareMoney(order.total_money);
  const problems: string[] = [];

  const taxes = new Map(records(order.taxes).map((tax) => [text(tax.uid) ?? "", tax]));
  const kinds = new Set([...taxes.values()].map((tax) => text(tax.type) ?? "UNKNOWN_TAX"));
  if (kinds.has("ADDITIVE") && kinds.has("INCLUSIVE")) problems.push("has both inclusive and added-on taxes; Tohyee handles one or the other on an order.");
  if ([...kinds].some((kind) => kind !== "ADDITIVE" && kind !== "INCLUSIVE")) problems.push("has a tax Square doesn't say is inclusive or added on.");
  const inclusive = !kinds.has("ADDITIVE");
  const beforeTax = (totalMoney: unknown, taxMoney: unknown) => (inclusive ? squareMoney(totalMoney) : toFixedString(sub(dec(squareMoney(totalMoney)), dec(squareMoney(taxMoney))), 2));

  const lines: PlatformOrderLine[] = records(order.line_items).map((line, index) => {
    const quantity = text(line.quantity) ?? "0";
    if (!/^\d+$/.test(quantity) || record(line.quantity_unit).measurement_unit) problems.push(`sells ${text(line.name) ?? "an item"} by measure (${quantity}); only whole quantities are supported.`);
    const discount = squareMoney(line.total_discount_money);
    const net = beforeTax(line.total_money, line.total_tax_money);
    const sku = extras.skus.get(text(line.catalog_object_id) ?? "") ?? null;
    const variation = text(line.variation_name);
    const name = [text(line.name) ?? "Item", variation && variation !== "Regular" ? variation : null].filter(Boolean).join(" - ");
    return {
      externalId: text(line.uid) ?? `line-${index}`,
      // Lines are matched to items by SKU, as WooCommerce's are (SQ4), so the SKU stands in for the variant.
      variantId: sku,
      sku,
      name,
      quantity,
      originalTotal: toFixedString(add(dec(net), dec(discount)), 2),
      discount,
      taxLines: taxLinesOf(line.applied_taxes, taxes),
      isGiftCard: text(line.item_type) === "GIFT_CARD",
    };
  });
  if (list(order.service_charges).length > 0) problems.push("has a service charge; service charges aren't supported yet, so record it by hand.");
  if (isPositive(dec(squareMoney(order.total_tip_money)))) problems.push("has a tip; tips aren't supported yet, so record it by hand.");
  if (!isNothing(squareMoney(record(order.rounding_adjustment).amount_money))) problems.push("has a cash rounding adjustment; that isn't supported yet.");
  if (list(order.returns).length > 0) problems.push("is an exchange (it returns items too); exchanges aren't supported yet.");
  if (lines.length > 0 && isNothing(total)) problems.push("comes to 0.00, so there's nothing to post.");

  // Payments: each tender's payment, as Square says now (SQ2, SQ5).
  const tenders = records(order.tenders);
  const transactions: PlatformTransaction[] = tenders.map((tender, index) => {
    const paymentId = text(tender.payment_id);
    const payment = paymentId ? record(extras.payments.get(paymentId)) : {};
    const type = text(tender.type) ?? "OTHER";
    const status = text(payment.status);
    return {
      externalId: paymentId ?? text(tender.id) ?? `tender-${index}`,
      kind: "SALE",
      // A payment Square has completed; a tender without a payment record only when the order itself is completed.
      status: status ? (status === "COMPLETED" ? "SUCCESS" : status) : state === "COMPLETED" ? "SUCCESS" : "PENDING",
      gateway: type === "SQUARE_GIFT_CARD" ? "gift_card" : type.toLowerCase(),
      amount: squareMoney(payment.total_money ?? tender.amount_money),
      currency: currencyOf(payment.total_money ?? tender.amount_money),
      processedAt: timestamp(payment.created_at) ?? timestamp(tender.created_at),
      test: false,
    };
  });
  const received = sum(transactions.filter((t) => t.status === "SUCCESS").map((t) => dec(t.amount)));
  const paid = isPositive(dec(total)) && cmp(received, dec(total)) >= 0;

  // Where the money went: card payments into the Square balance (the clearing account), cash and other tenders
  // where the admin maps them, as WooCommerce's payment methods (SQ5). A split between the two isn't supported.
  const types = [...new Set(tenders.map((tender) => text(tender.type) ?? "OTHER"))];
  let paymentMethod: PlatformOrder["paymentMethod"] = null;
  if (types.length > 0 && types.every((type) => PAID_OUT_BY_SQUARE.has(type))) {
    paymentMethod = { id: "square", title: "Paid through Square (card)", clearing: true };
  } else if (types.length === 1) {
    paymentMethod = { id: types[0].toLowerCase(), title: TENDER_TITLES[types[0]] ?? types[0].toLowerCase().replace(/_/g, " ") };
  } else if (types.length > 1) {
    problems.push(`was paid in more than one way (${types.map((type) => type.toLowerCase().replace(/_/g, " ")).join(", ")}); split payments like that aren't supported yet.`);
  }

  // Refunds (SQ6): each refund of the order's payments that Square has completed. One return order's refunds (a
  // return paid back to a card and cash, say) are one refund, with the return order's lines.
  const groups = new Map<string, { refunds: Json[]; returnOrder: Json | null }>();
  for (const refund of records(extras.refunds)) {
    if (text(refund.status) !== "COMPLETED") continue;
    const refundId = text(refund.id);
    if (!refundId) continue;
    const onOrder = text(refund.order_id);
    const returnOrder = onOrder && onOrder !== id ? record(extras.returnOrders.get(onOrder)) : null;
    const key = returnOrder && text(returnOrder.id) ? text(returnOrder.id)! : refundId;
    const group = groups.get(key) ?? { refunds: [], returnOrder: returnOrder && text(returnOrder.id) ? returnOrder : null };
    group.refunds.push(refund);
    groups.set(key, group);
  }
  const refunds: PlatformRefund[] = [...groups.entries()].map(([key, group]) => {
    const returns = group.returnOrder ? records(group.returnOrder.returns).filter((entry) => text(entry.source_order_id) === id) : [];
    const at = group.refunds.map((refund) => timestamp(refund.created_at)).reduce<string | null>((first, next) => (!first ? next : next && Date.parse(next) < Date.parse(first) ? next : first), null);
    const tenderType = (paymentId: string | null) => text(tenders.find((tender) => text(tender.payment_id) === paymentId)?.type) ?? "CARD";
    return {
      externalId: key,
      createdAt: at,
      processedAt: at,
      lines: returns.flatMap((entry) =>
        records(entry.return_line_items).map((line) => ({
          lineItemId: text(line.source_line_item_uid) ?? `missing-${text(line.uid) ?? "?"}`,
          quantity: text(line.quantity) ?? "0",
          restocked: false,
          subtotal: beforeTax(line.total_money, line.total_tax_money),
          tax: squareMoney(line.total_tax_money),
        })),
      ),
      shipping: [],
      adjustments: 0,
      transactions: group.refunds.map((refund) => {
        const type = tenderType(text(refund.payment_id));
        return {
          externalId: text(refund.id)!,
          kind: "REFUND",
          status: "SUCCESS",
          gateway: type === "SQUARE_GIFT_CARD" ? "gift_card" : type.toLowerCase(),
          amount: squareMoney(refund.amount_money),
          currency: currencyOf(refund.amount_money),
          processedAt: timestamp(refund.created_at),
          test: false,
        };
      }),
      // A return with service charges or tips back isn't supported yet.
      incomplete: returns.some((entry) => list(entry.return_service_charges).length > 0),
    };
  });

  const firstPayment = tenders.map((tender) => record(extras.payments.get(text(tender.payment_id) ?? ""))).find((payment) => text(payment.receipt_number));
  const receipt = text(firstPayment?.receipt_number);
  const name = receipt ? `#${receipt}` : text(order.reference_id) ? `#${text(order.reference_id)}` : `order ${id}`;
  const customer = squareCustomerFrom(extras.customer);
  return {
    externalId: id,
    name,
    processedAt: createdAt,
    updatedAt: timestamp(order.updated_at),
    cancelledAt: state === "CANCELED" ? (timestamp(order.closed_at) ?? timestamp(order.updated_at) ?? createdAt) : null,
    test: false,
    taxesIncluded: inclusive,
    currency,
    presentmentCurrency: null,
    financialStatus: state === "CANCELED" ? "VOIDED" : paid ? "PAID" : "PENDING",
    total,
    customer,
    billingCountry: customer?.country ?? null,
    lines,
    shipping: [],
    transactions,
    refunds,
    incomplete: problems[0] ?? null,
    paymentMethod,
    sourceName: text(record(order.source).name),
  };
}

/**
 * A payout entry as a balance transaction (SQ7). CHARGE and REFUND keep
 * their names; Square's fee entries (FEE, PROCESSING_FEE, DEPOSIT_FEE) are
 * adjustments, which go to the fees account; every other type keeps its
 * Square name, so the payout is refused for you to record by hand.
 */
export function squarePayoutEntryFrom(raw: unknown): PlatformBalanceTransaction {
  const entry = record(raw);
  const type = text(entry.type) ?? "OTHER";
  const fee = ["FEE", "PROCESSING_FEE", "DEPOSIT_FEE"].includes(type);
  const paymentId = text(record(entry.type_charge_details).payment_id) ?? text(record(entry.type_refund_details).payment_id);
  return {
    externalId: text(entry.id) ?? "",
    type: fee ? "ADJUSTMENT" : type,
    amount: squareMoney(entry.gross_amount_money),
    fee: squareMoney(entry.fee_amount_money),
    net: squareMoney(entry.net_amount_money),
    currency: currencyOf(entry.gross_amount_money),
    orderName: paymentId ? `payment ${paymentId}` : null,
    adjustmentReason: fee ? `Square ${type.toLowerCase().replace(/_/g, " ")}` : null,
    test: false,
  };
}

/** A payout (https://developer.squareup.com/docs/payouts-api/overview): SENT is on its way, PAID deposited, FAILED failed. */
export function squarePayoutFrom(raw: unknown, entries: readonly unknown[] = [], incomplete = false): PlatformPayout {
  const payout = record(raw);
  const id = text(payout.id);
  if (!id) throw new ValidationError("Square sent a payout without an ID.");
  const issuedAt = timestamp(payout.created_at);
  if (!issuedAt) throw new ValidationError(`Square sent payout ${id} without a date.`);
  const amount = dec(squareMoney(payout.amount_money));
  const status = text(payout.status);
  return {
    externalId: id,
    issuedAt,
    status: status === "PAID" ? "PAID" : status === "FAILED" ? "FAILED" : "IN_TRANSIT",
    direction: isNegative(amount) ? "WITHDRAWAL" : "DEPOSIT",
    net: toFixedString(isNegative(amount) ? sub(dec("0"), amount) : amount, 2),
    currency: currencyOf(payout.amount_money) ?? "",
    transactions: entries.map(squarePayoutEntryFrom),
    incomplete,
  };
}

// ---------------------------------------------------------------------------
// Talking to Square (never inside a database transaction)

async function call(token: AccessToken, path: string, init: { method?: string; body?: unknown } = {}): Promise<Json | null> {
  let response: Response;
  try {
    // Redirects aren't followed: the token would go with them.
    response = await platformFetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token.token}`,
        "square-version": SQUARE_API_VERSION,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new PlatformError(0, `Couldn't reach Square: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = await response.text();
  let body: Json = {};
  try {
    body = record(raw ? JSON.parse(raw) : null);
  } catch {
    body = {};
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = records(body.errors).map((error) => text(error.detail) ?? text(error.code)).filter(Boolean).join("; ") || raw.slice(0, 200);
    throw new PlatformError(response.status, `Square said ${response.status}: ${detail || "no details"}`);
  }
  return body;
}

const encode = (value: string) => encodeURIComponent(value);
const query = (params: Record<string, string | null | undefined>) =>
  new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")).toString();

async function activeLocations(token: AccessToken): Promise<Json[]> {
  const body = await call(token, "/locations");
  return records(body?.locations).filter((location) => text(location.status) === "ACTIVE" && text(location.id));
}

/** Reads one order and what posting it needs, remembering what's been read in this sync. */
class OrderReader {
  private readonly orders = new Map<string, Json | null>();
  private readonly payments = new Map<string, Json | null>();
  private readonly refunds = new Map<string, Json | null>();
  private readonly customers = new Map<string, Json | null>();
  constructor(private readonly token: AccessToken) {}

  remember(order: Json): void {
    const id = text(order.id);
    if (id) this.orders.set(id, order);
  }

  async order(id: string): Promise<Json | null> {
    if (!this.orders.has(id)) this.orders.set(id, record((await call(this.token, `/orders/${encode(id)}`))?.order));
    const found = this.orders.get(id);
    return found && text(found.id) ? found : null;
  }

  async payment(id: string): Promise<Json | null> {
    if (!this.payments.has(id)) this.payments.set(id, record((await call(this.token, `/payments/${encode(id)}`))?.payment));
    const found = this.payments.get(id);
    return found && text(found.id) ? found : null;
  }

  private async refund(id: string): Promise<Json | null> {
    if (!this.refunds.has(id)) this.refunds.set(id, record((await call(this.token, `/refunds/${encode(id)}`))?.refund));
    const found = this.refunds.get(id);
    return found && text(found.id) ? found : null;
  }

  private async customer(id: string): Promise<Json | null> {
    if (!this.customers.has(id)) this.customers.set(id, record((await call(this.token, `/customers/${encode(id)}`))?.customer));
    const found = this.customers.get(id);
    return found && text(found.id) ? found : null;
  }

  /** The SKUs of the order's item variations, from the catalog. */
  private async skus(order: Json): Promise<Map<string, string>> {
    const ids = [...new Set(records(order.line_items).flatMap((line) => (text(line.catalog_object_id) ? [text(line.catalog_object_id)!] : [])))];
    const skus = new Map<string, string>();
    if (ids.length === 0) return skus;
    const body = await call(this.token, "/catalog/batch-retrieve", { method: "POST", body: { object_ids: ids, include_related_objects: false } });
    for (const object of records(body?.objects)) {
      const sku = text(record(object.item_variation_data).sku);
      if (sku && text(object.id)) skus.set(text(object.id)!, sku);
    }
    return skus;
  }

  /** A sale order with its extras; a return order is followed to the order it returns from. */
  async read(id: string): Promise<PlatformOrder | null> {
    let order = await this.order(id);
    if (order && isReturnOrder(order)) {
      const source = returnedFrom(order)[0];
      order = source ? await this.order(source) : null;
    }
    if (!order) return null;
    const orderId = text(order.id)!;
    const payments = new Map<string, unknown>();
    const refunds: Json[] = [];
    const returnOrders = new Map<string, unknown>();
    for (const tender of records(order.tenders)) {
      const paymentId = text(tender.payment_id);
      if (!paymentId) continue;
      const payment = await this.payment(paymentId);
      if (!payment) continue;
      payments.set(paymentId, payment);
      for (const refundId of list(payment.refund_ids)) {
        const refund = text(refundId) ? await this.refund(text(refundId)!) : null;
        if (!refund) continue;
        refunds.push(refund);
        const onOrder = text(refund.order_id);
        if (onOrder && onOrder !== orderId && !returnOrders.has(onOrder)) {
          const returnOrder = await this.order(onOrder);
          if (returnOrder) returnOrders.set(onOrder, returnOrder);
        }
      }
    }
    const customerId = text(order.customer_id);
    return squareOrderFrom(order, {
      customer: customerId ? await this.customer(customerId) : null,
      skus: await this.skus(order),
      payments,
      refunds,
      returnOrders,
    });
  }
}

const rfc3339 = (instant: string) => new Date(instant).toISOString().replace(/\.\d{3}Z$/, "Z");

export const squareConnector: SalesPlatformConnector = {
  platform: "square",
  hasPayouts: true,
  payoutScopes: [],
  usesPaymentMethods: true,
  syncsRecords: false,

  parseConnectInput(body): ConnectInput {
    const accessToken = requireString(body.accessToken, "accessToken", {
      maxLength: 500,
      pattern: /^\S+$/,
      patternHint: "The access token can't contain spaces.",
    });
    // The account is known once Square says whose token it is (checkStore).
    return { storeDomain: UNKNOWN_ACCOUNT, authMethod: "personal_access_token", credentials: { accessToken } };
  },

  async accessToken(context) {
    return { token: { token: context.credentials.accessToken ?? "", expiresAt: null }, renewed: false };
  },

  async checkStore(_context, token): Promise<StoreInfo> {
    const merchant = record((await call(token, "/merchants/me"))?.merchant);
    const merchantId = text(merchant.id);
    const currency = text(merchant.currency);
    if (!merchantId || !currency || !/^[A-Z]{3}$/.test(currency)) throw new PlatformError(200, "Square didn't say which account this is or its currency.");
    const locations = await activeLocations(token);
    if (locations.length === 0) throw new PlatformError(200, "This Square account has no active locations, so there are no orders to bring in.");
    // Reading one order checks the token can read orders.
    await call(token, "/orders/search", { method: "POST", body: { location_ids: [text(locations[0].id)], limit: 1, return_entries: true } });
    const country = text(merchant.country) ?? "";
    return {
      storeName: text(merchant.business_name) ?? `Square account ${merchantId}`,
      currency,
      // Square sets tax per tax (inclusive or added on), not per store; each order's taxes decide how it's posted (SQ3).
      // This is only what's shown: prices usually include tax outside the US and Canada.
      pricesIncludeTax: !["US", "CA"].includes(country),
      scopes: [ORDER_SCOPE],
      storeId: merchantId.toLowerCase(),
    };
  },

  async fetchChanges() {
    return { customers: [], variants: [], customersUntil: null, productsUntil: null, notes: [] };
  },

  async fetchOrders(_context, token, request) {
    const since = request.updatedSince && Date.parse(request.updatedSince) > Date.parse(request.processedFrom) ? request.updatedSince : request.processedFrom;
    const reader = new OrderReader(token);
    const notes: string[] = [];
    const ids = new Set<string>();
    let until: string | null = null;
    const locations = (await activeLocations(token)).map((location) => text(location.id)!);
    for (let start = 0; start < locations.length; start += LOCATIONS_PER_SEARCH) {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_ORDER_PAGES; page += 1) {
        const body: Json | null = await call(token, "/orders/search", {
          method: "POST",
          body: {
            location_ids: locations.slice(start, start + LOCATIONS_PER_SEARCH),
            ...(cursor ? { cursor } : {}),
            limit: ORDERS_PER_PAGE,
            query: {
              filter: { state_filter: { states: ORDER_STATES }, date_time_filter: { updated_at: { start_at: rfc3339(since) } } },
              sort: { sort_field: "UPDATED_AT", sort_order: "ASC" },
            },
          },
        });
        for (const order of records(body?.orders)) {
          const id = text(order.id);
          if (!id) continue;
          reader.remember(order);
          until = latest(until, timestamp(order.updated_at));
          // A return order (an itemised refund) brings its sale order in again, with the refund.
          for (const source of isReturnOrder(order) ? returnedFrom(order) : [id]) ids.add(source);
        }
        cursor = text(body?.cursor);
        if (!cursor) break;
        // Sorted by when they changed, so the next sync carries on from the last one read.
        if (page === MAX_ORDER_PAGES - 1) notes.push(`More than ${ORDERS_PER_PAGE * MAX_ORDER_PAGES} orders changed; the rest come with the next sync.`);
      }
    }
    // Refunds changed since: their payments' orders come in again (a refund doesn't always change its sale order).
    let refundsCapped = false;
    let refundCursor: string | null = null;
    for (let page = 0; page < MAX_REFUND_PAGES; page += 1) {
      const body: Json | null = await call(token, `/refunds?${query({ updated_at_begin_time: rfc3339(since), sort_order: "ASC", limit: String(REFUNDS_PER_PAGE), cursor: refundCursor })}`);
      for (const refund of records(body?.refunds)) {
        const paymentId = text(refund.payment_id);
        const payment = paymentId ? await reader.payment(paymentId) : null;
        const orderId = text(payment?.order_id);
        if (orderId) ids.add(orderId);
      }
      refundCursor = text(body?.cursor);
      if (!refundCursor) break;
      if (page === MAX_REFUND_PAGES - 1) {
        refundsCapped = true;
        notes.push(`More than ${REFUNDS_PER_PAGE * MAX_REFUND_PAGES} refunds changed; the rest come with the next sync.`);
      }
    }
    for (const id of request.retryIds) ids.add(id);
    const orders: PlatformOrder[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      try {
        const order = await reader.read(id);
        if (order && !seen.has(order.externalId)) {
          seen.add(order.externalId);
          orders.push(order);
        }
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        notes.push(`Order ${id} couldn't be read: ${error.message}`);
      }
    }
    // With refunds left unread, the next sync starts from the same point again (posting is idempotent).
    return { orders, until: refundsCapped ? null : until, notes };
  },

  async fetchOrder(_context, token, orderId) {
    return new OrderReader(token).read(orderId);
  },

  async fetchPayouts(_context, token, request) {
    const payouts: PlatformPayout[] = [];
    const notes: string[] = [];
    for (const location of await activeLocations(token)) {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAYOUT_PAGES; page += 1) {
        const body: Json | null = await call(
          token,
          `/payouts?${query({ location_id: text(location.id), begin_time: rfc3339(request.issuedFrom), sort_order: "ASC", limit: String(PAYOUTS_PER_PAGE), cursor })}`,
        );
        for (const raw of records(body?.payouts)) {
          const payout = squarePayoutFrom(raw);
          if (payout.status !== "PAID" || request.alreadyPosted(payout.externalId)) {
            payouts.push(payout);
            continue;
          }
          const entries: unknown[] = [];
          let entryCursor: string | null = null;
          let incomplete = true;
          for (let entryPage = 0; entryPage < MAX_ENTRY_PAGES; entryPage += 1) {
            const found: Json | null = await call(
              token,
              `/payouts/${encode(payout.externalId)}/payout-entries?${query({ sort_order: "ASC", limit: String(ENTRIES_PER_PAGE), cursor: entryCursor })}`,
            );
            entries.push(...list(found?.payout_entries));
            entryCursor = text(found?.cursor);
            if (!entryCursor) {
              incomplete = false;
              break;
            }
          }
          payouts.push(squarePayoutFrom(raw, entries, incomplete));
        }
        cursor = text(body?.cursor);
        if (!cursor) break;
      }
    }
    return { payouts, notes };
  },

  async registerWebhooks(_context, token, callbackUrl) {
    const body = await call(token, "/webhooks/subscriptions", {
      method: "POST",
      body: {
        idempotency_key: randomUUID(),
        subscription: { name: "Tohyee", event_types: [...WEBHOOK_EVENTS], notification_url: callbackUrl, api_version: SQUARE_API_VERSION },
      },
    });
    const subscription = record(body?.subscription);
    const id = text(subscription.id);
    const signingKey = text(subscription.signature_key);
    if (!id || !signingKey) {
      if (id) await squareConnector.removeWebhooks(_context, token, [id]).catch(() => undefined);
      throw new PlatformError(200, "Square didn't send the webhook's signature key.");
    }
    return { ids: [id], signingKey };
  },

  async removeWebhooks(_context, token, ids) {
    for (const id of ids) await call(token, `/webhooks/subscriptions/${encode(id)}`, { method: "DELETE" });
  },

  webhookSecret(credentials) {
    return credentials.webhookSigningKey ?? "";
  },

  checkWebhook(headers, rawBody, secret, storeDomain, options = {}) {
    if (!verifySquareWebhook(rawBody, headers.get("x-square-hmacsha256-signature"), secret, options.webhookUrl ?? "")) return null;
    let body: Json;
    try {
      body = record(JSON.parse(rawBody.toString("utf8")));
    } catch {
      return null;
    }
    // Only this seller's events (the subscription is the app's).
    if (text(body.merchant_id)?.toLowerCase() !== storeDomain.toLowerCase()) return null;
    const deliveryId = text(body.event_id);
    const topic = text(body.type);
    if (!deliveryId || deliveryId.length > 200 || !topic || topic.length > 100) return null;
    return { deliveryId, topic };
  },

  webhookRecords(topic, body): WebhookRecords | null {
    const object = record(record(record(body).data).object);
    const orderId =
      topic === "order.created"
        ? text(record(object.order_created).order_id)
        : topic === "order.updated"
          ? text(record(object.order_updated).order_id)
          : topic === "payment.created" || topic === "payment.updated"
            ? text(record(object.payment).order_id)
            : topic === "refund.created" || topic === "refund.updated"
              ? // Possibly a return order: fetching it brings in the order it returns from.
                text(record(object.refund).order_id)
              : null;
    if (!(WEBHOOK_EVENTS as readonly string[]).includes(topic)) return null;
    if (!orderId) return null;
    return { kind: "order", orderId };
  },
};

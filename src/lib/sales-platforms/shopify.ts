import { createHmac, timingSafeEqual } from "node:crypto";
import { ValidationError } from "@/lib/errors";
import { dec, sum, toPlainString } from "@/lib/money/decimal";
import {
  type AccessToken,
  type Changes,
  type ChangesRequest,
  type ConnectInput,
  type OrdersRequest,
  type OrdersResult,
  PlatformError,
  type PlatformBalanceTransaction,
  type PlatformCustomer,
  type PlatformOrder,
  type PlatformPayout,
  type PlatformRefund,
  type PlatformTaxLine,
  type PlatformTransaction,
  type PlatformVariant,
  type PayoutsRequest,
  type PayoutsResult,
  type SalesPlatformConnector,
  type StoreInfo,
  type WebhookRecords,
} from "@/lib/sales-platforms/connector";
import { SHOPIFY_AUTH_METHODS } from "@/lib/sales-platforms/types";
import { requireOneOf, requireString } from "@/lib/validation";

/**
 * The Shopify connector (examples SPC1-SPC23). Not tried against a real
 * store: the tests use recorded Shopify-shaped responses.
 *
 * - Access: a custom app's Admin API access token (apps made in the store
 *   admin before 1 Jan 2026), or a Dev Dashboard app's client ID and
 *   secret, exchanged for a token that lasts 24 hours with a form-encoded
 *   POST to /admin/oauth/access_token (the client credentials grant, which
 *   only works for a store in the app's own Shopify organisation):
 *   https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant
 * - The Admin GraphQL API, version 2026-07:
 *   https://shopify.dev/docs/api/admin-graphql/2026-07
 * - Read-only scopes (https://shopify.dev/docs/api/usage/access-scopes):
 *   read_customers and read_products always; read_orders for orders, their
 *   transactions and refunds (the last 60 days only, without
 *   read_all_orders); read_shopify_payments_payouts and
 *   read_shopify_payments_accounts for payouts and balance transactions.
 * - Webhooks are signed with the app's secret: X-Shopify-Hmac-SHA256 is the
 *   base64 HMAC-SHA256 of the raw body
 *   (https://shopify.dev/docs/apps/build/webhooks/subscribe/https).
 */
export const SHOPIFY_API_VERSION = "2026-07";
export const SHOPIFY_SCOPES = ["read_customers", "read_products"] as const;
/** Needed to bring orders into the accounts (decision 52). */
export const SHOPIFY_ORDER_SCOPES = ["read_orders"] as const;
/** Needed for Shopify Payments payouts; without them payouts are left out and the log says so. */
export const SHOPIFY_PAYOUT_SCOPES = ["read_shopify_payments_payouts", "read_shopify_payments_accounts"] as const;
const WEBHOOK_TOPICS = ["CUSTOMERS_CREATE", "CUSTOMERS_UPDATE", "PRODUCTS_CREATE", "PRODUCTS_UPDATE"] as const;
// https://shopify.dev/docs/api/admin-graphql/2026-07/enums/WebhookSubscriptionTopic (all need read_orders).
const ORDER_WEBHOOK_TOPICS = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_PAID", "ORDERS_CANCELLED", "REFUNDS_CREATE"] as const;
const ORDER_TOPICS = ["orders/create", "orders/updated", "orders/paid", "orders/cancelled"];

const TIMEOUT_MS = 30_000;
const CUSTOMERS_PER_PAGE = 100;
const MAX_CUSTOMER_PAGES = 20;
// Each product asks for up to 100 variants, each with its inventory item (about 2 points a variant), so few
// products per page keeps the query under Shopify's cost limit: 4 x (2 + 100 x 2) is about 810.
const PRODUCTS_PER_PAGE = 4;
const MAX_PRODUCT_PAGES = 100;
const VARIANTS_PER_PRODUCT = 100;
// Shopify refuses a query whose requested cost is over 1,000 (each object 1, each connection sized by `first`:
// https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits). An order with 50 lines (about 10 each),
// 10 shipping lines and 50 transactions asks for about 730; each refund is asked for on its own (about 370).
const LINES_PER_ORDER = 50;
const SHIPPING_LINES_PER_ORDER = 10;
const TRANSACTIONS_PER_ORDER = 50;
const REFUNDS_PER_ORDER = 10;
const LINES_PER_REFUND = 50;
const ORDERS_PER_PAGE = 50;
const MAX_ORDER_PAGES = 4;
const PAYOUTS_PER_PAGE = 50;
const MAX_PAYOUT_PAGES = 4;
const BALANCE_TRANSACTIONS_PER_PAGE = 100;
const MAX_BALANCE_TRANSACTION_PAGES = 5;
/** A cached token this close to expiring is renewed first. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;

/** Lets tests swap the network for canned responses. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetcher: FetchLike = (input, init) => fetch(input, init);
export function setSalesPlatformFetchForTests(replacement: FetchLike | null): void {
  fetcher = replacement ?? ((input, init) => fetch(input, init));
}

/** Waiting for Shopify's rate limit to refill; tests swap it so they don't wait. */
let sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export function setSalesPlatformSleepForTests(replacement: ((ms: number) => Promise<void>) | null): void {
  sleep = replacement ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

/**
 * Shopify's GraphQL rate limit is a bucket of query cost points that refills
 * each second; a query that asks for more than is left is answered
 * "THROTTLED" (or 429). Tohyee waits for the bucket to refill and asks again,
 * a few times, rather than failing the whole sync (a big store's first sync
 * needs more points than one bucket holds).
 * https://shopify.dev/docs/api/usage/limits#graphql-admin-api-rate-limits
 */
const THROTTLE_RETRIES = 6;
const MAX_THROTTLE_WAIT_MS = 30_000;

// ---------------------------------------------------------------------------
// Checking what an admin typed

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;

/** Shopify answers shop_not_permitted when the app and the store aren't in the same Shopify organisation. */
export const SHOP_NOT_PERMITTED =
  "This app and store aren't in the same Shopify organisation. Tohyee can only connect a store with a Dev Dashboard app from the store's own organisation (connecting someone else's store needs Shopify's authorization code grant, which Tohyee doesn't do yet).";

/** The store's permanent address, e.g. "glimmers.myshopify.com" (a bare "glimmers" is accepted). */
export function normaliseShopDomain(input: unknown): string {
  const raw = requireString(input, "storeDomain", { maxLength: 255 }).trim().toLowerCase();
  let host = raw.replace(/^https?:\/\//, "").split(/[/?#]/)[0];
  if (/^[a-z0-9][a-z0-9-]*$/.test(host)) host = `${host}.myshopify.com`;
  if (!SHOP_DOMAIN.test(host)) {
    throw new ValidationError("Enter the store's myshopify.com address, like glimmers.myshopify.com (it's in the store's admin address).");
  }
  return host;
}

function secretField(input: unknown, field: string, label: string): string {
  return requireString(input, field, {
    maxLength: 500,
    pattern: /^\S+$/,
    patternHint: `The ${label} can't contain spaces.`,
  });
}

// ---------------------------------------------------------------------------
// Webhook signatures

/** Whether `signature` is the base64 HMAC-SHA256 of the raw body with `secret`, compared in constant time. */
export function verifyShopifyWebhook(rawBody: string | Buffer, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody).digest();
  const given = Buffer.from(signature.trim(), "base64");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------------------
// Record shapes

function text(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** "gid://shopify/Customer/1001", 1001 or "1001" -> "1001". */
function shopifyId(value: unknown, what: string): string {
  const raw = text(value);
  const id = raw?.match(/^(?:gid:\/\/shopify\/[A-Za-z]+\/)?(\d{1,30})$/)?.[1];
  if (!id) throw new ValidationError(`Shopify sent a ${what} without an ID.`);
  return id;
}

function timestamp(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const time = Date.parse(raw);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function joinName(first: unknown, last: unknown): string | null {
  return text([text(first), text(last)].filter(Boolean).join(" "));
}

/** A customer from the Admin GraphQL API. `email` and `phone` are deprecated there, so the default ones are read. */
export function shopifyCustomerFromGraphql(node: unknown): PlatformCustomer {
  const n = record(node);
  const email = text(record(n.defaultEmailAddress).emailAddress);
  const phone = text(record(n.defaultPhoneNumber).phoneNumber);
  return {
    externalId: shopifyId(n.id, "customer"),
    name: joinName(n.firstName, n.lastName) ?? text(n.displayName) ?? email ?? phone,
    email,
    phone,
    country: countryCode(record(n.defaultAddress).countryCodeV2),
    updatedAt: timestamp(n.updatedAt),
  };
}

/** A two-letter country code ("AU"), or null. */
function countryCode(value: unknown): string | null {
  const code = text(value)?.toUpperCase() ?? null;
  return code && /^[A-Z]{2}$/.test(code) ? code : null;
}

/** A customer from a customers/create or customers/update webhook (REST-shaped JSON). */
export function shopifyCustomerFromWebhook(body: unknown): PlatformCustomer {
  const b = record(body);
  const email = text(b.email) ?? text(record(b.default_email_address).email_address);
  const phone = text(b.phone) ?? text(record(b.default_phone_number).phone_number);
  return {
    externalId: shopifyId(b.id, "customer"),
    name: joinName(b.first_name, b.last_name) ?? email ?? phone,
    email,
    phone,
    country: countryCode(record(b.default_address).country_code),
    updatedAt: timestamp(b.updated_at),
  };
}

function variant(
  product: { id: string; title: string; updatedAt: string | null },
  raw: Record<string, unknown>,
  updatedAt: unknown,
  tracked: boolean | null,
): PlatformVariant {
  return {
    externalId: shopifyId(raw.id, "product variant"),
    productId: product.id,
    productTitle: product.title,
    variantTitle: text(raw.title),
    sku: text(raw.sku),
    price: text(raw.price),
    tracked,
    updatedAt: later(product.updatedAt, timestamp(updatedAt)),
  };
}

/** A product's variants from the Admin GraphQL API, and whether it has more than were asked for. */
export function shopifyVariantsFromGraphql(node: unknown): { records: PlatformVariant[]; moreVariants: boolean } {
  const n = record(node);
  const product = { id: shopifyId(n.id, "product"), title: text(n.title) ?? "Untitled product", updatedAt: timestamp(n.updatedAt) };
  const variants = record(n.variants);
  const nodes = Array.isArray(variants.nodes) ? variants.nodes : [];
  return {
    // InventoryItem.tracked: "Whether inventory levels are tracked for the item" (SPC17).
    records: nodes.map((raw) => variant(product, record(raw), record(raw).updatedAt, record(record(raw).inventoryItem).tracked === true)),
    moreVariants: record(variants.pageInfo).hasNextPage === true,
  };
}

/** A product's variants from a products/create or products/update webhook. */
export function shopifyVariantsFromWebhook(body: unknown): PlatformVariant[] {
  const b = record(body);
  const product = { id: shopifyId(b.id, "product"), title: text(b.title) ?? "Untitled product", updatedAt: timestamp(b.updated_at) };
  const variants = Array.isArray(b.variants) ? b.variants : [];
  // The webhook doesn't say whether Shopify tracks the variant's stock.
  return variants.map((raw) => variant(product, record(raw), record(raw).updated_at, null));
}

const amountOf = (bag: unknown): string => {
  const raw = text(record(record(bag).shopMoney).amount);
  if (raw === null || !/^-?\d+(\.\d+)?$/.test(raw)) return "0";
  return toPlainString(dec(raw));
};
const currencyOf = (bag: unknown): string | null => text(record(record(bag).shopMoney).currencyCode);
const nodesOf = (connection: unknown): Record<string, unknown>[] => {
  const c = record(connection);
  const list = Array.isArray(c.nodes) ? c.nodes : Array.isArray(connection) ? (connection as unknown[]) : [];
  return list.map(record);
};
const hasMore = (connection: unknown): boolean => record(record(connection).pageInfo).hasNextPage === true;

function taxLines(value: unknown): PlatformTaxLine[] {
  return (Array.isArray(value) ? value : []).map((raw) => {
    const t = record(raw);
    const rate = typeof t.rate === "number" && Number.isFinite(t.rate) ? toPlainString(dec(t.rate.toFixed(6))) : "0";
    return { title: text(t.title), rate, amount: amountOf(t.priceSet) };
  });
}

function transaction(raw: Record<string, unknown>): PlatformTransaction {
  return {
    externalId: shopifyId(raw.id, "transaction"),
    kind: text(raw.kind) ?? "UNKNOWN",
    status: text(raw.status) ?? "UNKNOWN",
    gateway: text(raw.gateway),
    amount: amountOf(raw.amountSet),
    currency: currencyOf(raw.amountSet),
    processedAt: timestamp(raw.processedAt),
    test: raw.test === true,
  };
}

function refund(raw: Record<string, unknown>): PlatformRefund {
  return {
    externalId: shopifyId(raw.id, "refund"),
    createdAt: timestamp(raw.createdAt),
    processedAt: timestamp(raw.processedAt),
    lines: nodesOf(raw.refundLineItems).map((line) => ({
      lineItemId: shopifyId(record(line.lineItem).id, "refunded line"),
      quantity: String(typeof line.quantity === "number" ? line.quantity : 0),
      restocked: line.restocked === true,
      subtotal: amountOf(line.subtotalSet),
      tax: amountOf(line.totalTaxSet),
    })),
    shipping: nodesOf(raw.refundShippingLines).map((line) => ({
      shippingLineId: text(record(line.shippingLine).id) ? shopifyId(record(line.shippingLine).id, "shipping line") : null,
      subtotal: amountOf(line.subtotalAmountSet),
      tax: amountOf(line.taxAmountSet),
    })),
    adjustments: nodesOf(raw.orderAdjustments).length,
    transactions: nodesOf(raw.transactions).map(transaction),
    incomplete: hasMore(raw.refundLineItems) || hasMore(raw.refundShippingLines) || hasMore(raw.transactions),
  };
}

/**
 * An order from the Admin GraphQL API (Order, LineItem, ShippingLine,
 * OrderTransaction, Refund: https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order).
 */
export function shopifyOrderFromGraphql(node: unknown): PlatformOrder {
  const n = record(node);
  const lineItems = record(n.lineItems);
  const shippingLines = record(n.shippingLines);
  const transactions = Array.isArray(n.transactions) ? n.transactions.map(record) : [];
  const refunds = Array.isArray(n.refunds) ? n.refunds.map(record) : [];
  const processedAt = timestamp(n.processedAt) ?? timestamp(n.createdAt);
  if (!processedAt) throw new ValidationError("Shopify sent an order without a date.");
  const incomplete = hasMore(lineItems)
    ? `has more than ${LINES_PER_ORDER} lines; orders that big aren't supported yet.`
    : hasMore(shippingLines)
      ? `has more than ${SHIPPING_LINES_PER_ORDER} shipping lines; that isn't supported yet.`
      : transactions.length >= TRANSACTIONS_PER_ORDER
        ? `has ${TRANSACTIONS_PER_ORDER} or more payment transactions; that isn't supported yet.`
        : refunds.length >= REFUNDS_PER_ORDER
          ? `has ${REFUNDS_PER_ORDER} or more refunds; that isn't supported yet.`
          : null;
  return {
    externalId: shopifyId(n.id, "order"),
    name: text(n.name) ?? `order ${shopifyId(n.id, "order")}`,
    processedAt,
    updatedAt: timestamp(n.updatedAt),
    cancelledAt: timestamp(n.cancelledAt),
    test: n.test === true,
    taxesIncluded: n.taxesIncluded === true,
    currency: text(n.currencyCode) ?? currencyOf(n.totalPriceSet) ?? "",
    presentmentCurrency: text(n.presentmentCurrencyCode),
    financialStatus: text(n.displayFinancialStatus),
    total: amountOf(n.totalPriceSet),
    customer: n.customer && typeof n.customer === "object" ? shopifyCustomerFromGraphql(n.customer) : null,
    billingCountry: countryCode(record(n.billingAddress).countryCodeV2),
    lines: nodesOf(lineItems).map((line) => ({
      externalId: shopifyId(line.id, "order line"),
      variantId: text(record(line.variant).id) ? shopifyId(record(line.variant).id, "variant") : null,
      sku: text(line.sku),
      name: text(line.name) ?? "Item",
      quantity: String(typeof line.quantity === "number" ? line.quantity : 0),
      originalTotal: amountOf(line.originalTotalSet),
      discount: toPlainString(sum((Array.isArray(line.discountAllocations) ? line.discountAllocations : []).map((a) => dec(amountOf(record(a).allocatedAmountSet))))),
      taxLines: taxLines(line.taxLines),
      isGiftCard: line.isGiftCard === true,
    })),
    shipping: nodesOf(shippingLines).map((line) => ({
      externalId: shopifyId(line.id, "shipping line"),
      title: text(line.title) ?? "Shipping",
      amount: amountOf(line.discountedPriceSet),
      taxLines: taxLines(line.taxLines),
      removed: line.isRemoved === true,
    })),
    transactions: transactions.map(transaction),
    refunds: refunds.map(refund),
    incomplete,
  };
}

const moneyOf = (value: unknown): string => {
  const raw = text(record(value).amount);
  return raw !== null && /^-?\d+(\.\d+)?$/.test(raw) ? toPlainString(dec(raw)) : "0";
};

/** A balance transaction (https://shopify.dev/docs/api/admin-graphql/2026-07/objects/ShopifyPaymentsBalanceTransaction). */
export function shopifyBalanceTransactionFromGraphql(node: unknown): PlatformBalanceTransaction {
  const n = record(node);
  return {
    externalId: shopifyId(n.id, "balance transaction"),
    type: text(n.type) ?? "UNKNOWN",
    amount: moneyOf(n.amount),
    fee: moneyOf(n.fee),
    net: moneyOf(n.net),
    currency: text(record(n.amount).currencyCode),
    orderName: text(record(n.associatedOrder).name),
    adjustmentReason: text(n.adjustmentReason),
    test: n.test === true,
  };
}

/** A payout (https://shopify.dev/docs/api/admin-graphql/2026-07/objects/ShopifyPaymentsPayout), without its transactions. */
export function shopifyPayoutFromGraphql(node: unknown): PlatformPayout {
  const n = record(node);
  const issuedAt = timestamp(n.issuedAt);
  if (!issuedAt) throw new ValidationError("Shopify sent a payout without a date.");
  return {
    externalId: text(n.legacyResourceId) ?? shopifyId(n.id, "payout"),
    issuedAt,
    status: text(n.status) ?? "UNKNOWN",
    direction: text(n.transactionType) ?? "DEPOSIT",
    net: moneyOf(n.net),
    currency: text(record(n.net).currencyCode) ?? "",
    transactions: [],
    incomplete: false,
  };
}

// ---------------------------------------------------------------------------
// Talking to Shopify (never inside a database transaction)

async function call(url: string, init: RequestInit): Promise<unknown> {
  const host = new URL(url).host;
  let response: Response;
  try {
    // Redirects aren't followed: the access token header would go with them, to wherever they point.
    response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new PlatformError(0, `Couldn't reach ${host}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await response.text();
  let parsed: unknown = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const b = record(parsed);
    const errors = b.errors;
    const detail =
      text(b.error_description) ??
      (typeof errors === "string" ? errors : Array.isArray(errors) ? errors.map((e) => text(record(e).message)).filter(Boolean).join("; ") : null) ??
      text(b.error) ??
      body.slice(0, 200);
    const error = new PlatformError(response.status, `${host} said ${response.status}: ${detail || "no details"}`);
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      throw Object.assign(error, { retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000 });
    }
    throw error;
  }
  return parsed;
}

/** How long to wait before asking again, when Shopify said the query was throttled (null: it wasn't). */
function throttleWait(body: Record<string, unknown>): number | null {
  const errors = Array.isArray(body.errors) ? body.errors : [];
  if (!errors.some((e) => record(record(e).extensions).code === "THROTTLED")) return null;
  const cost = record(record(body.extensions).cost);
  const status = record(cost.throttleStatus);
  const requested = typeof cost.requestedQueryCost === "number" ? cost.requestedQueryCost : null;
  const available = typeof status.currentlyAvailable === "number" ? status.currentlyAvailable : null;
  const restoreRate = typeof status.restoreRate === "number" && status.restoreRate > 0 ? status.restoreRate : null;
  if (requested === null || available === null || restoreRate === null) return 2000;
  return Math.max(1000, Math.ceil(((requested - available) / restoreRate) * 1000));
}

async function graphql(storeDomain: string, token: AccessToken, query: string, variables: Record<string, unknown> = {}) {
  const url = `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  for (let attempt = 0; ; attempt += 1) {
    let body: Record<string, unknown>;
    let wait: number | null;
    try {
      body = record(
        await call(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "X-Shopify-Access-Token": token.token },
          body: JSON.stringify({ query, variables }),
        }),
      );
      wait = throttleWait(body);
    } catch (error) {
      const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
      if (typeof retryAfterMs !== "number" || attempt >= THROTTLE_RETRIES) throw error;
      await sleep(Math.min(retryAfterMs, MAX_THROTTLE_WAIT_MS));
      continue;
    }
    if (wait !== null && attempt < THROTTLE_RETRIES) {
      await sleep(Math.min(wait, MAX_THROTTLE_WAIT_MS));
      continue;
    }
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const messages = body.errors.map((e) => text(record(e).message) ?? "unknown error").join("; ");
      throw new PlatformError(200, `${storeDomain} said: ${messages}`);
    }
    return record(body.data);
  }
}

function userErrors(result: Record<string, unknown>): string | null {
  const errors = Array.isArray(result.userErrors) ? result.userErrors : [];
  return errors.length === 0 ? null : errors.map((e) => text(record(e).message) ?? "unknown error").join("; ");
}

const SHOP_QUERY = `query TohyeeShop {
  shop { name myshopifyDomain currencyCode taxesIncluded }
  currentAppInstallation { accessScopes { handle } }
}`;

const CUSTOMER_FIELDS = `id displayName firstName lastName updatedAt
      defaultEmailAddress { emailAddress }
      defaultPhoneNumber { phoneNumber }
      defaultAddress { countryCodeV2 }`;

const CUSTOMERS_QUERY = `query TohyeeCustomers($first: Int!, $after: String, $query: String) {
  customers(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    nodes {
      ${CUSTOMER_FIELDS}
    }
    pageInfo { hasNextPage endCursor }
  }
}`;


const PRODUCTS_QUERY = `query TohyeeProducts($first: Int!, $after: String, $query: String) {
  products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    nodes {
      id title updatedAt
      variants(first: ${VARIANTS_PER_PRODUCT}) {
        nodes { id title sku price updatedAt inventoryItem { tracked } }
        pageInfo { hasNextPage }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const MONEY = "shopMoney { amount currencyCode }";
const TAX_LINES = `taxLines { title rate priceSet { ${MONEY} } }`;
const TRANSACTION_FIELDS = `id kind status gateway test processedAt amountSet { ${MONEY} }`;

const ORDER_QUERY = `query TohyeeOrder($id: ID!) {
  order(id: $id) {
    id name createdAt processedAt updatedAt cancelledAt test taxesIncluded currencyCode presentmentCurrencyCode displayFinancialStatus
    totalPriceSet { ${MONEY} }
    customer { ${CUSTOMER_FIELDS} }
    billingAddress { countryCodeV2 }
    lineItems(first: ${LINES_PER_ORDER}) {
      nodes {
        id name sku quantity isGiftCard
        variant { id }
        originalTotalSet { ${MONEY} }
        discountAllocations { allocatedAmountSet { ${MONEY} } }
        ${TAX_LINES}
      }
      pageInfo { hasNextPage }
    }
    shippingLines(first: ${SHIPPING_LINES_PER_ORDER}, includeRemovals: true) {
      nodes { id title isRemoved discountedPriceSet { ${MONEY} } ${TAX_LINES} }
      pageInfo { hasNextPage }
    }
    transactions(first: ${TRANSACTIONS_PER_ORDER}) { ${TRANSACTION_FIELDS} }
    refunds(first: ${REFUNDS_PER_ORDER}) { id }
  }
}`;

const REFUND_QUERY = `query TohyeeRefund($id: ID!) {
  refund(id: $id) {
    id createdAt processedAt
    refundLineItems(first: ${LINES_PER_REFUND}) {
      nodes { lineItem { id } quantity restocked subtotalSet { ${MONEY} } totalTaxSet { ${MONEY} } }
      pageInfo { hasNextPage }
    }
    refundShippingLines(first: 5) {
      nodes { shippingLine { id } subtotalAmountSet { ${MONEY} } taxAmountSet { ${MONEY} } }
      pageInfo { hasNextPage }
    }
    orderAdjustments(first: 5) { nodes { id } }
    transactions(first: 10) { nodes { ${TRANSACTION_FIELDS} } pageInfo { hasNextPage } }
  }
}`;

const ORDERS_QUERY = `query TohyeeOrders($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    nodes { id updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}`;

const PAYOUTS_QUERY = `query TohyeePayouts($first: Int!, $after: String, $query: String) {
  shopifyPaymentsAccount {
    payouts(first: $first, after: $after, query: $query, sortKey: ISSUED_AT) {
      nodes { id legacyResourceId issuedAt status transactionType net { amount currencyCode } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const BALANCE_TRANSACTIONS_QUERY = `query TohyeePayoutTransactions($first: Int!, $after: String, $query: String) {
  shopifyPaymentsAccount {
    balanceTransactions(first: $first, after: $after, query: $query) {
      nodes { id type test adjustmentReason amount { amount currencyCode } fee { amount } net { amount } associatedOrder { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const WEBHOOK_CREATE = `mutation TohyeeWebhookCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;

const WEBHOOK_DELETE = `mutation TohyeeWebhookDelete($id: ID!) {
  webhookSubscriptionDelete(id: $id) {
    deletedWebhookSubscriptionId
    userErrors { field message }
  }
}`;

const searchTime = (instant: string) => new Date(instant).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Shopify's search syntax for "changed since". */
function changedSince(since: string | null): string | null {
  return since ? `updated_at:>='${searchTime(since)}'` : null;
}

/** An order by its ID with each of its refunds (asked for one at a time, to keep each query's cost down), or null if Shopify doesn't have it. */
async function fetchOneOrder(storeDomain: string, token: AccessToken, orderId: string): Promise<PlatformOrder | null> {
  const data = await graphql(storeDomain, token, ORDER_QUERY, { id: `gid://shopify/Order/${orderId}` });
  if (!data.order || typeof data.order !== "object") return null;
  const order = record(data.order);
  const refunds: unknown[] = [];
  for (const summary of Array.isArray(order.refunds) ? order.refunds.map(record) : []) {
    const found = await graphql(storeDomain, token, REFUND_QUERY, { id: summary.id });
    refunds.push(found.refund && typeof found.refund === "object" ? found.refund : summary);
  }
  return shopifyOrderFromGraphql({ ...order, refunds });
}

/** All of a payout's balance transactions (payments_transfer_id is the payout's ID). */
async function payoutTransactions(storeDomain: string, token: AccessToken, payout: PlatformPayout): Promise<PlatformPayout> {
  const transactions: PlatformBalanceTransaction[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_BALANCE_TRANSACTION_PAGES; page += 1) {
    const data = await graphql(storeDomain, token, BALANCE_TRANSACTIONS_QUERY, {
      first: BALANCE_TRANSACTIONS_PER_PAGE,
      after,
      query: `payments_transfer_id:${payout.externalId}`,
    });
    const connection = record(record(data.shopifyPaymentsAccount).balanceTransactions);
    transactions.push(...nodesOf(connection).map(shopifyBalanceTransactionFromGraphql));
    const info = record(connection.pageInfo);
    if (info.hasNextPage !== true || !text(info.endCursor)) return { ...payout, transactions };
    after = text(info.endCursor);
  }
  return { ...payout, transactions, incomplete: true };
}

async function pages(
  storeDomain: string,
  token: AccessToken,
  query: string,
  field: "customers" | "products",
  perPage: number,
  maxPages: number,
  since: string | null,
): Promise<unknown[]> {
  const nodes: unknown[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const data = await graphql(storeDomain, token, query, { first: perPage, after, query: changedSince(since) });
    const connection = record(data[field]);
    if (Array.isArray(connection.nodes)) nodes.push(...connection.nodes);
    const info = record(connection.pageInfo);
    if (info.hasNextPage !== true || !text(info.endCursor)) break;
    after = text(info.endCursor);
  }
  return nodes;
}

export const shopifyConnector: SalesPlatformConnector = {
  platform: "shopify",

  parseConnectInput(body): ConnectInput {
    const storeDomain = normaliseShopDomain(body.storeDomain);
    const authMethod = requireOneOf(body.authMethod ?? "access_token", "authMethod", SHOPIFY_AUTH_METHODS);
    if (authMethod === "access_token") {
      return {
        storeDomain,
        authMethod,
        credentials: {
          accessToken: secretField(body.accessToken, "accessToken", "access token"),
          apiSecret: secretField(body.apiSecret, "apiSecret", "API secret key"),
        },
      };
    }
    return {
      storeDomain,
      authMethod,
      credentials: {
        clientId: secretField(body.clientId, "clientId", "client ID"),
        clientSecret: secretField(body.clientSecret, "clientSecret", "client secret"),
      },
    };
  },

  async accessToken(context) {
    const { credentials, cachedToken, now } = context;
    if (credentials.accessToken) return { token: { token: credentials.accessToken, expiresAt: null }, renewed: false };
    if (cachedToken?.expiresAt && Date.parse(cachedToken.expiresAt) - RENEW_BEFORE_MS > now.getTime()) {
      return { token: cachedToken, renewed: false };
    }
    // Shopify's client credentials grant: a form-encoded body (SPC19).
    let body: Record<string, unknown>;
    try {
      body = record(
        await call(`https://${context.storeDomain}/admin/oauth/access_token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: credentials.clientId ?? "", client_secret: credentials.clientSecret ?? "" }).toString(),
        }),
      );
    } catch (error) {
      if (error instanceof PlatformError && /shop_not_permitted|cannot be performed on this shop/i.test(error.message)) {
        throw new ValidationError(SHOP_NOT_PERMITTED);
      }
      throw error;
    }
    const token = text(body.access_token);
    if (!token) throw new PlatformError(200, `${context.storeDomain} didn't send an access token.`);
    const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    return { token: { token, expiresAt: new Date(now.getTime() + seconds * 1000).toISOString() }, renewed: true };
  },

  async checkStore(context, token): Promise<StoreInfo> {
    const data = await graphql(context.storeDomain, token, SHOP_QUERY);
    const shop = record(data.shop);
    const scopes = (Array.isArray(record(data.currentAppInstallation).accessScopes) ? (record(data.currentAppInstallation).accessScopes as unknown[]) : [])
      .map((scope) => text(record(scope).handle))
      .filter((handle): handle is string => handle !== null);
    const writes = scopes.filter((scope) => scope.startsWith("write_"));
    if (writes.length > 0) {
      throw new ValidationError(
        `This app can change the store (${writes.join(", ")}). Tohyee only reads, so give the app only read access: ${[...SHOPIFY_SCOPES, ...SHOPIFY_ORDER_SCOPES, ...SHOPIFY_PAYOUT_SCOPES].join(", ")}.`,
      );
    }
    const missing = SHOPIFY_SCOPES.filter((scope) => !scopes.includes(scope));
    if (missing.length > 0) {
      throw new ValidationError(`This app doesn't have ${missing.join(" or ")}. Give it ${SHOPIFY_SCOPES.join(" and ")}.`);
    }
    const currency = text(shop.currencyCode);
    if (!currency || !/^[A-Z]{3}$/.test(currency) || typeof shop.taxesIncluded !== "boolean") {
      throw new PlatformError(200, `${context.storeDomain} didn't say its currency and tax setting.`);
    }
    return { storeName: text(shop.name) ?? context.storeDomain, currency, pricesIncludeTax: shop.taxesIncluded, scopes: [...new Set(scopes)].sort() };
  },

  async fetchChanges(context, token, request: ChangesRequest): Promise<Changes> {
    const changes: Changes = { customers: [], variants: [], customersUntil: null, productsUntil: null, notes: [] };
    if (request.customers) {
      const nodes = await pages(context.storeDomain, token, CUSTOMERS_QUERY, "customers", CUSTOMERS_PER_PAGE, MAX_CUSTOMER_PAGES, request.customersSince);
      for (const node of nodes) {
        const customer = shopifyCustomerFromGraphql(node);
        changes.customers.push(customer);
        changes.customersUntil = later(changes.customersUntil, customer.updatedAt);
      }
    }
    if (request.products) {
      const nodes = await pages(context.storeDomain, token, PRODUCTS_QUERY, "products", PRODUCTS_PER_PAGE, MAX_PRODUCT_PAGES, request.productsSince);
      for (const node of nodes) {
        const product = shopifyVariantsFromGraphql(node);
        changes.variants.push(...product.records);
        changes.productsUntil = later(changes.productsUntil, timestamp(record(node).updatedAt));
        if (product.moreVariants) {
          changes.notes.push(
            `Product ${shopifyId(record(node).id, "product")} "${text(record(node).title) ?? ""}" has more than ${VARIANTS_PER_PRODUCT} variants; only the first ${VARIANTS_PER_PRODUCT} were synced.`,
          );
        }
      }
    }
    return changes;
  },

  async fetchOrders(context, token, request: OrdersRequest): Promise<OrdersResult> {
    const result: OrdersResult = { orders: [], until: null, notes: [] };
    const ids: string[] = [];
    let after: string | null = null;
    const filters = [`processed_at:>='${searchTime(request.processedFrom)}'`, changedSince(request.updatedSince)].filter(Boolean).join(" ");
    for (let page = 0; page < MAX_ORDER_PAGES; page += 1) {
      const data = await graphql(context.storeDomain, token, ORDERS_QUERY, { first: ORDERS_PER_PAGE, after, query: filters });
      const connection = record(data.orders);
      for (const node of nodesOf(connection)) {
        ids.push(shopifyId(node.id, "order"));
        result.until = later(result.until, timestamp(node.updatedAt));
      }
      const info = record(connection.pageInfo);
      if (info.hasNextPage !== true || !text(info.endCursor)) break;
      after = text(info.endCursor);
      if (page === MAX_ORDER_PAGES - 1) result.notes.push(`More than ${ORDERS_PER_PAGE * MAX_ORDER_PAGES} orders changed; the rest come with the next sync.`);
    }
    for (const id of [...new Set([...ids, ...request.retryIds])]) {
      const order = await fetchOneOrder(context.storeDomain, token, id);
      if (order) result.orders.push(order);
    }
    return result;
  },

  fetchOrder(context, token, orderId) {
    return fetchOneOrder(context.storeDomain, token, orderId);
  },

  async fetchPayouts(context, token, request: PayoutsRequest): Promise<PayoutsResult> {
    const result: PayoutsResult = { payouts: [], notes: [] };
    let after: string | null = null;
    for (let page = 0; page < MAX_PAYOUT_PAGES; page += 1) {
      const data = await graphql(context.storeDomain, token, PAYOUTS_QUERY, {
        first: PAYOUTS_PER_PAGE,
        after,
        query: `issued_at:>='${searchTime(request.issuedFrom)}'`,
      });
      const account = data.shopifyPaymentsAccount;
      if (!account || typeof account !== "object") {
        result.notes.push("The store has no Shopify Payments account, so there are no payouts to bring in.");
        return result;
      }
      const connection = record(record(account).payouts);
      for (const node of nodesOf(connection)) {
        const payout = shopifyPayoutFromGraphql(node);
        if (payout.status !== "PAID" || request.alreadyPosted(payout.externalId)) {
          result.payouts.push(payout);
          continue;
        }
        result.payouts.push(await payoutTransactions(context.storeDomain, token, payout));
      }
      const info = record(connection.pageInfo);
      if (info.hasNextPage !== true || !text(info.endCursor)) break;
      after = text(info.endCursor);
    }
    return result;
  },

  async registerWebhooks(context, token, callbackUrl, options = {}) {
    const ids: string[] = [];
    try {
      for (const topic of [...WEBHOOK_TOPICS, ...(options.orders ? ORDER_WEBHOOK_TOPICS : [])]) {
        const data = await graphql(context.storeDomain, token, WEBHOOK_CREATE, { topic, webhookSubscription: { callbackUrl, format: "JSON" } });
        const result = record(data.webhookSubscriptionCreate);
        const problem = userErrors(result);
        if (problem) throw new PlatformError(200, `${context.storeDomain} didn't accept the ${topic} webhook: ${problem}`);
        const id = text(record(result.webhookSubscription).id);
        if (id) ids.push(id);
      }
    } catch (error) {
      // All or nothing: the ones already made are removed again (best effort), so none are left behind unrecorded.
      await shopifyConnector.removeWebhooks(context, token, ids).catch(() => undefined);
      throw error;
    }
    return ids;
  },

  async removeWebhooks(context, token, ids) {
    for (const id of ids) {
      const data = await graphql(context.storeDomain, token, WEBHOOK_DELETE, { id });
      const problem = userErrors(record(data.webhookSubscriptionDelete));
      if (problem) throw new PlatformError(200, `${context.storeDomain} didn't remove a webhook: ${problem}`);
    }
  },

  webhookSecret(credentials) {
    return credentials.apiSecret ?? credentials.clientSecret ?? "";
  },

  checkWebhook(headers, rawBody, secret, storeDomain) {
    if (!verifyShopifyWebhook(rawBody, headers.get("x-shopify-hmac-sha256"), secret)) return null;
    if (headers.get("x-shopify-shop-domain")?.trim().toLowerCase() !== storeDomain.toLowerCase()) return null;
    const deliveryId = text(headers.get("x-shopify-webhook-id"));
    const topic = text(headers.get("x-shopify-topic"));
    if (!deliveryId || deliveryId.length > 200 || !topic || topic.length > 100) return null;
    return { deliveryId, topic };
  },

  webhookRecords(topic, body): WebhookRecords | null {
    if (topic === "customers/create" || topic === "customers/update") {
      return { kind: "customers", records: [shopifyCustomerFromWebhook(body)] };
    }
    if (topic === "products/create" || topic === "products/update") {
      return { kind: "variants", records: shopifyVariantsFromWebhook(body) };
    }
    // The order is fetched again with GraphQL, so only its ID is read from the body.
    if (ORDER_TOPICS.includes(topic)) return { kind: "order", orderId: shopifyId(record(body).id, "order") };
    if (topic === "refunds/create") return { kind: "order", orderId: shopifyId(record(body).order_id, "order") };
    return null;
  },
};

import { randomBytes } from "node:crypto";
import { ValidationError } from "@/lib/errors";
import { dec, divide, sub, toFixedString, toPlainString } from "@/lib/money/decimal";
import {
  type AccessToken,
  type ConnectInput,
  PlatformError,
  type PlatformCustomer,
  type PlatformOrder,
  type PlatformOrderLine,
  type PlatformRefund,
  type PlatformShippingLine,
  type PlatformTaxLine,
  type SalesPlatformConnector,
  type WebhookRecords,
} from "@/lib/sales-platforms/connector";
import { platformFetch } from "@/lib/sales-platforms/http";
import { verifyShopifyWebhook } from "@/lib/sales-platforms/shopify";
import { ORDER_SCOPE } from "@/lib/sales-platforms/types";
import { requireString } from "@/lib/validation";

/**
 * The WooCommerce connector (examples WC1-WC10). Not tried against a real
 * store: the tests use WooCommerce-shaped responses.
 *
 * - The REST API v3 under /wp-json/wc/v3, with a key made in the store
 *   (WooCommerce › Settings › Advanced › REST API) sent with HTTP Basic Auth
 *   over https (https://woocommerce.github.io/woocommerce-rest-api-docs/).
 * - Orders' line, shipping and tax amounts are before tax, with the tax
 *   beside them, so orders come to Tohyee as tax exclusive (WC2).
 * - No payouts: the money comes through the payment method the customer
 *   chose, mapped to an account in the settings (WC2-WC8).
 * - No customer or product sync: customers are matched by email, lines by
 *   SKU (Jess, 5 Oct 2026).
 * - Webhooks (order.created, order.updated) are signed with a secret Tohyee
 *   makes: X-WC-Webhook-Signature is the base64 HMAC-SHA256 of the body.
 *   Making them needs a key with write access; with a read key Tohyee says
 *   so and the catch-up sync brings orders in.
 */

const API = "/wp-json/wc/v3";
const TIMEOUT_MS = 30_000;
const ORDERS_PER_PAGE = 50;
const MAX_ORDER_PAGES = 4;
const REFUNDS_PER_ORDER = 20;
const WEBHOOK_TOPICS = ["order.created", "order.updated"] as const;

type Json = Record<string, unknown>;

const record = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};
/** WooCommerce's money ("46.00", sometimes "" or a number) as a two-place string. */
const money = (value: unknown): string => {
  const raw = text(value);
  if (raw === null) return "0.00";
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new ValidationError(`WooCommerce sent an amount that isn't a number: ${raw.slice(0, 30)}`);
  return toFixedString(dec(raw), 2);
};
const absolute = (value: string) => (value.startsWith("-") ? value.slice(1) : value);
/** WooCommerce's `_gmt` dates have no zone: they're UTC. */
const gmt = (value: unknown): string | null => {
  const raw = text(value);
  if (!raw) return null;
  const at = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

// ---------------------------------------------------------------------------
// Checking what an admin typed

/** The store's address without https:// or a trailing slash, e.g. "shop.glimmers.nz" or "example.com/shop". */
export function normaliseStoreAddress(input: unknown): string {
  const raw = requireString(input, "storeDomain", { maxLength: 255 }).trim();
  if (/^http:\/\//i.test(raw)) throw new ValidationError("Use the store's https:// address; WooCommerce keys can only be sent safely over https.");
  let url: URL;
  try {
    url = new URL(/^https:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ValidationError("Enter the store's address, like https://shop.example.nz.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname.includes(".")) {
    throw new ValidationError("Enter the store's address, like https://shop.example.nz.");
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/wp-json.*$/i, "");
  return `${url.host.toLowerCase()}${path}`;
}

function keyField(input: unknown, field: string, prefix: string, label: string): string {
  const value = requireString(input, field, { maxLength: 200, pattern: /^\S+$/, patternHint: `The ${label} can't contain spaces.` });
  if (!value.startsWith(prefix)) throw new ValidationError(`The ${label} starts with ${prefix} (WooCommerce › Settings › Advanced › REST API).`);
  return value;
}

// ---------------------------------------------------------------------------
// Talking to WooCommerce (never inside a database transaction)

type Answer = { body: unknown; headers: Headers };

async function call(storeDomain: string, token: AccessToken | null, path: string, init: RequestInit = {}): Promise<Answer> {
  const url = `https://${storeDomain}${path}`;
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (token) headers.set("authorization", `Basic ${token.token}`);
  let response: Response;
  try {
    // Redirects aren't followed: the key would go with them, to wherever they point.
    response = await platformFetch(url, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new PlatformError(0, `Couldn't reach ${storeDomain}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail = text(record(body).message) ?? raw.slice(0, 200);
    throw new PlatformError(response.status, `${storeDomain} said ${response.status}: ${detail || "no details"}`);
  }
  return { body, headers: response.headers };
}

const get = (storeDomain: string, token: AccessToken, path: string) => call(storeDomain, token, `${API}${path}`);

// ---------------------------------------------------------------------------
// WooCommerce's records in Tohyee's shape

/** Tax rate id -> rate as a fraction ("0.15"), from the order's tax lines. */
function ratesOf(order: Json): Map<string, string> {
  const rates = new Map<string, string>();
  for (const line of list(order.tax_lines)) {
    const entry = record(line);
    const id = text(entry.rate_id);
    const percentText = text(entry.rate_percent);
    if (id && percentText && /^\d+(\.\d+)?$/.test(percentText)) rates.set(id, toPlainString(divide(dec(percentText), dec("100"), 6)));
  }
  return rates;
}

function taxLinesOf(taxes: unknown, rates: Map<string, string>, field: "total" | "subtotal" = "total"): PlatformTaxLine[] {
  const lines: PlatformTaxLine[] = [];
  for (const raw of list(taxes)) {
    const entry = record(raw);
    const amount = text(entry[field]);
    if (amount === null) continue;
    const id = text(entry.id);
    const rate = id ? rates.get(id) : undefined;
    if (rate === undefined) throw new ValidationError(`WooCommerce sent a tax (rate ${id ?? "?"}) that isn't in the order's tax lines.`);
    lines.push({ title: "Tax", rate, amount: money(amount) });
  }
  return lines;
}

function customerOf(order: Json): PlatformCustomer | null {
  const id = text(order.customer_id);
  if (!id || id === "0") return null;
  const billing = record(order.billing);
  const name = [text(billing.first_name), text(billing.last_name)].filter(Boolean).join(" ") || text(billing.company);
  return {
    externalId: id,
    name: name || null,
    email: text(billing.email),
    phone: text(billing.phone),
    country: text(billing.country)?.toUpperCase() ?? null,
    updatedAt: null,
  };
}

/** A WooCommerce order (and its refunds, read separately) as a platform order (WC2-WC10). */
export function wooOrderFrom(raw: unknown, refundsRaw: unknown[] = []): PlatformOrder {
  const order = record(raw);
  const id = text(order.id);
  if (!id) throw new ValidationError("WooCommerce sent an order without an id.");
  const name = `#${text(order.number) ?? id}`;
  const status = text(order.status) ?? "pending";
  const rates = ratesOf(order);
  const createdAt = gmt(order.date_created_gmt);
  if (!createdAt) throw new ValidationError(`WooCommerce sent ${name} without a date.`);
  const paidAt = gmt(order.date_paid_gmt);
  const updatedAt = gmt(order.date_modified_gmt);
  const lines: PlatformOrderLine[] = list(order.line_items).map((rawLine) => {
    const line = record(rawLine);
    const subtotal = money(line.subtotal);
    const total = money(line.total);
    return {
      externalId: text(line.id) ?? "",
      // Lines are matched to items by SKU (Jess, 5 Oct 2026), so the SKU stands in for the variant.
      variantId: text(line.sku),
      sku: text(line.sku),
      name: text(line.name) ?? "Item",
      quantity: text(line.quantity) ?? "0",
      originalTotal: subtotal,
      discount: toFixedString(sub(dec(subtotal), dec(total)), 2),
      taxLines: taxLinesOf(line.taxes, rates),
      isGiftCard: false,
    };
  });
  const shipping: PlatformShippingLine[] = list(order.shipping_lines).map((rawLine) => {
    const line = record(rawLine);
    return { externalId: text(line.id) ?? "", title: text(line.method_title) ?? "Shipping", amount: money(line.total), taxLines: taxLinesOf(line.taxes, rates), removed: false };
  });
  const paid = paidAt !== null && ["processing", "completed", "refunded"].includes(status);
  const method = text(order.payment_method);
  const refunds: PlatformRefund[] = refundsRaw.map((refundRaw) => {
    const refund = record(refundRaw);
    const at = gmt(refund.date_created_gmt);
    const refundLines: PlatformRefund["lines"] = [];
    for (const rawLine of list(refund.line_items)) {
      const line = record(rawLine);
      // Refund lines say which product they are, not which order line: the order line with the same product and variation.
      const match = list(order.line_items)
        .map(record)
        .find((candidate) => text(candidate.product_id) === text(line.product_id) && text(candidate.variation_id) === text(line.variation_id));
      refundLines.push({
        lineItemId: match ? (text(match.id) ?? "") : `missing-${text(line.id) ?? "?"}`,
        quantity: absolute(text(line.quantity) ?? "0"),
        restocked: false,
        subtotal: absolute(money(line.total)),
        tax: absolute(money(line.total_tax)),
      });
    }
    const refundShipping = list(refund.shipping_lines).map((rawLine) => {
      const line = record(rawLine);
      return { shippingLineId: null, subtotal: absolute(money(line.total)), tax: absolute(money(line.total_tax)) };
    });
    return {
      externalId: text(refund.id) ?? "",
      createdAt: at,
      processedAt: at,
      lines: refundLines,
      shipping: refundShipping,
      adjustments: 0,
      transactions: [
        { externalId: `refund-${text(refund.id) ?? "?"}`, kind: "REFUND", status: "SUCCESS", gateway: method, amount: absolute(money(refund.amount)), currency: text(order.currency), processedAt: at, test: false },
      ],
      incomplete: false,
    };
  });
  const surcharges = list(order.fee_lines).length > 0;
  return {
    externalId: id,
    name,
    processedAt: createdAt,
    updatedAt,
    cancelledAt: status === "cancelled" || status === "failed" ? (updatedAt ?? createdAt) : null,
    test: false,
    // The amounts given are before tax (WooCommerce's line totals), whatever the store's prices.
    taxesIncluded: false,
    currency: text(order.currency)?.toUpperCase() ?? "",
    presentmentCurrency: null,
    financialStatus: paid ? "PAID" : status.toUpperCase().replace(/-/g, "_"),
    total: money(order.total),
    customer: customerOf(order),
    billingCountry: text(record(order.billing).country)?.toUpperCase() ?? null,
    lines,
    shipping,
    transactions: paid
      ? [{ externalId: text(order.transaction_id) ?? `paid-${id}`, kind: "SALE", status: "SUCCESS", gateway: method, amount: money(order.total), currency: text(order.currency), processedAt: paidAt, test: false }]
      : [],
    refunds,
    incomplete: surcharges ? "has a surcharge (a fee line); surcharges aren't supported yet, so record it by hand." : refundsRaw.length >= REFUNDS_PER_ORDER ? "has more refunds than Tohyee reads." : null,
    paymentMethod: method ? { id: method, title: text(order.payment_method_title) } : null,
  };
}

async function refundsOf(storeDomain: string, token: AccessToken, order: Json): Promise<unknown[]> {
  if (list(order.refunds).length === 0) return [];
  const { body } = await get(storeDomain, token, `/orders/${encodeURIComponent(text(order.id) ?? "")}/refunds?per_page=${REFUNDS_PER_ORDER}`);
  return list(body);
}

// ---------------------------------------------------------------------------
// The connector

export const woocommerceConnector: SalesPlatformConnector = {
  platform: "woocommerce",
  hasPayouts: false,
  usesPaymentMethods: true,
  syncsRecords: false,

  parseConnectInput(body): ConnectInput {
    return {
      storeDomain: normaliseStoreAddress(body.storeDomain),
      authMethod: "api_key",
      credentials: {
        consumerKey: keyField(body.consumerKey, "consumerKey", "ck_", "consumer key"),
        consumerSecret: keyField(body.consumerSecret, "consumerSecret", "cs_", "consumer secret"),
        // Tohyee's own secret for the webhooks it makes (WC9).
        webhookSecret: randomBytes(32).toString("base64url"),
      },
    };
  },

  async accessToken(context) {
    const { consumerKey, consumerSecret } = context.credentials;
    return { token: { token: Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64"), expiresAt: null }, renewed: false };
  },

  async checkStore(context, token) {
    // Reading one order checks the key (WC1); a refused key is a 401.
    await get(context.storeDomain, token, "/orders?per_page=1");
    const currency = text(record((await get(context.storeDomain, token, "/settings/general/woocommerce_currency")).body).value);
    const included = text(record((await get(context.storeDomain, token, "/settings/tax/woocommerce_prices_include_tax")).body).value);
    let storeName = context.storeDomain;
    try {
      storeName = text(record((await call(context.storeDomain, null, "/wp-json/")).body).name) ?? storeName;
    } catch {
      // The site's name is only for showing; the address does.
    }
    if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new PlatformError(200, `${context.storeDomain} didn't say its currency.`);
    // A key that reads orders can bring them in; WooCommerce has no scopes to grant.
    return { storeName, currency, pricesIncludeTax: included === "yes", scopes: [ORDER_SCOPE] };
  },

  async fetchChanges() {
    return { customers: [], variants: [], customersUntil: null, productsUntil: null, notes: [] };
  },

  async fetchOrders(context, token, request) {
    const since = request.updatedSince && Date.parse(request.updatedSince) > Date.parse(request.processedFrom) ? request.updatedSince : request.processedFrom;
    const orders: PlatformOrder[] = [];
    const notes: string[] = [];
    const seen = new Set<string>();
    let until: string | null = null;
    for (let page = 1; page <= MAX_ORDER_PAGES; page += 1) {
      const query = new URLSearchParams({
        modified_after: since.replace(/\.\d+Z$/, "").replace(/Z$/, ""),
        dates_are_gmt: "true",
        orderby: "modified",
        order: "asc",
        per_page: String(ORDERS_PER_PAGE),
        page: String(page),
      });
      const { body, headers } = await get(context.storeDomain, token, `/orders?${query}`);
      for (const raw of list(body)) {
        const entry = record(raw);
        try {
          orders.push(wooOrderFrom(entry, await refundsOf(context.storeDomain, token, entry)));
          seen.add(text(entry.id) ?? "");
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          notes.push(`Order ${text(entry.number) ?? text(entry.id) ?? "?"} couldn't be read: ${error.message}`);
        }
        const modified = gmt(entry.date_modified_gmt);
        if (modified && (!until || Date.parse(modified) > Date.parse(until))) until = modified;
      }
      const pages = Number(headers.get("x-wp-totalpages") ?? "1");
      if (!Number.isFinite(pages) || page >= pages) break;
      if (page === MAX_ORDER_PAGES) notes.push("More orders changed than one sync reads; the rest come in at the next sync.");
    }
    for (const id of request.retryIds) {
      if (seen.has(id)) continue;
      const order = await woocommerceConnector.fetchOrder(context, token, id);
      if (order) orders.push(order);
    }
    return { orders, until, notes };
  },

  async fetchOrder(context, token, orderId) {
    let body: unknown;
    try {
      body = (await get(context.storeDomain, token, `/orders/${encodeURIComponent(orderId)}`)).body;
    } catch (error) {
      if (error instanceof PlatformError && error.platformStatus === 404) return null;
      throw error;
    }
    return wooOrderFrom(body, await refundsOf(context.storeDomain, token, record(body)));
  },

  async fetchPayouts() {
    return { payouts: [], notes: [] };
  },

  async registerWebhooks(context, token, callbackUrl) {
    const ids: string[] = [];
    try {
      for (const topic of WEBHOOK_TOPICS) {
        const { body } = await call(context.storeDomain, token, `${API}/webhooks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: `Tohyee ${topic}`, topic, delivery_url: callbackUrl, secret: context.credentials.webhookSecret, status: "active" }),
        });
        const id = text(record(body).id);
        if (id) ids.push(id);
      }
    } catch (error) {
      await woocommerceConnector.removeWebhooks(context, token, ids).catch(() => undefined);
      if (error instanceof PlatformError && error.refused) {
        throw new PlatformError(error.platformStatus, `${error.message}. Webhooks need a key with write access; with a read key the catch-up sync brings orders in`);
      }
      throw error;
    }
    return ids;
  },

  async removeWebhooks(context, token, ids) {
    for (const id of ids) {
      await call(context.storeDomain, token, `${API}/webhooks/${encodeURIComponent(id)}?force=true`, { method: "DELETE" });
    }
  },

  webhookSecret(credentials) {
    return credentials.webhookSecret ?? "";
  },

  isPing(headers, rawBody) {
    // WooCommerce pings a new webhook's address with `webhook_id=N` (form-encoded, unsigned).
    return !headers.get("x-wc-webhook-signature") && /^webhook_id=\d+$/.test(rawBody.toString("utf8").trim());
  },

  checkWebhook(headers, rawBody, secret, storeDomain) {
    if (!verifyShopifyWebhook(rawBody, headers.get("x-wc-webhook-signature"), secret)) return null;
    const source = headers.get("x-wc-webhook-source");
    if (source) {
      try {
        if (normaliseStoreAddress(source) !== storeDomain.toLowerCase()) return null;
      } catch {
        return null;
      }
    }
    const deliveryId = text(headers.get("x-wc-webhook-delivery-id"));
    const topic = text(headers.get("x-wc-webhook-topic"));
    if (!deliveryId || deliveryId.length > 200 || !topic || topic.length > 100) return null;
    return { deliveryId: `${text(headers.get("x-wc-webhook-id")) ?? "0"}:${deliveryId}`, topic };
  },

  webhookRecords(topic, body): WebhookRecords | null {
    if (!(WEBHOOK_TOPICS as readonly string[]).includes(topic)) return null;
    const id = text(record(body).id);
    if (!id) throw new ValidationError("The webhook's order has no id.");
    return { kind: "order", orderId: id };
  },
};

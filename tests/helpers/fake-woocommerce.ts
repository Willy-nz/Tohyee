import { createHmac } from "node:crypto";

/**
 * A pretend WooCommerce store for the WooCommerce examples (WC1-WC10 in
 * docs/ACCOUNTING-EXAMPLES.md), answering the REST API v3 calls Tohyee makes
 * in the shapes WooCommerce's docs give
 * (https://woocommerce.github.io/woocommerce-rest-api-docs/). None of it was
 * recorded from a real store.
 */

export const STORE = "shop.glimmers.nz";
export const CONSUMER_KEY = "ck_test_glimmers_0123456789";
export const CONSUMER_SECRET = "cs_test_glimmers_0123456789";

type Json = Record<string, unknown>;

export type WooTax = { rateId?: number; total: string };
export type WooLine = { id: number; productId: number; sku: string; name: string; quantity: number; subtotal: string; total: string; tax: string };
export type WooOrderFixture = {
  id: number;
  status: string;
  createdAt: string;
  modifiedAt?: string;
  paidAt?: string | null;
  method: string;
  methodTitle: string;
  customerId?: number;
  email?: string;
  first?: string;
  last?: string;
  country?: string;
  currency?: string;
  lines: WooLine[];
  shipping?: { id: number; title: string; total: string; tax: string };
  fees?: Array<{ name: string; total: string }>;
  total: string;
  refunds?: WooRefundFixture[];
};
export type WooRefundFixture = { id: number; createdAt: string; amount: string; lines: Array<{ productId: number; quantity: number; total: string; tax: string }> };

const gmt = (iso: string) => iso.replace(/\.\d+Z$/, "").replace(/Z$/, "");
const taxes = (amount: string) => (amount === "0.00" ? [] : [{ id: 1, total: amount, subtotal: amount }]);

export function wooOrderNode(o: WooOrderFixture): Json {
  return {
    id: o.id,
    number: String(o.id),
    status: o.status,
    currency: o.currency ?? "NZD",
    prices_include_tax: true,
    date_created_gmt: gmt(o.createdAt),
    date_modified_gmt: gmt(o.modifiedAt ?? o.createdAt),
    date_paid_gmt: o.paidAt ? gmt(o.paidAt) : null,
    customer_id: o.customerId ?? 0,
    billing: { first_name: o.first ?? "", last_name: o.last ?? "", company: "", email: o.email ?? "", phone: "", country: o.country ?? "NZ" },
    payment_method: o.method,
    payment_method_title: o.methodTitle,
    transaction_id: o.paidAt ? `pi_${o.id}` : "",
    line_items: o.lines.map((line) => ({
      id: line.id,
      name: line.name,
      product_id: line.productId,
      variation_id: 0,
      quantity: line.quantity,
      subtotal: line.subtotal,
      subtotal_tax: line.tax,
      total: line.total,
      total_tax: line.tax,
      taxes: taxes(line.tax),
      sku: line.sku,
    })),
    shipping_lines: o.shipping ? [{ id: o.shipping.id, method_title: o.shipping.title, total: o.shipping.total, total_tax: o.shipping.tax, taxes: taxes(o.shipping.tax) }] : [],
    fee_lines: (o.fees ?? []).map((fee, index) => ({ id: 900 + index, name: fee.name, total: fee.total, total_tax: "0.00", taxes: [] })),
    coupon_lines: [],
    tax_lines: [{ id: 50, rate_code: "NZ-GST-1", rate_id: 1, label: "GST", compound: false, tax_total: "0.00", shipping_tax_total: "0.00", rate_percent: 15 }],
    total: o.total,
    refunds: (o.refunds ?? []).map((refund) => ({ id: refund.id, reason: "", total: `-${refund.amount}` })),
  };
}

export function wooRefundNode(refund: WooRefundFixture): Json {
  return {
    id: refund.id,
    date_created_gmt: gmt(refund.createdAt),
    amount: refund.amount,
    reason: "",
    api_refund: true,
    line_items: refund.lines.map((line, index) => ({
      id: 9500 + index,
      product_id: line.productId,
      variation_id: 0,
      quantity: -line.quantity,
      total: `-${line.total}`,
      total_tax: `-${line.tax}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// The examples' orders (setup: Glimmers Ltd, prices include tax, GST 15%)

const CANDLE = (id: number, quantity: number, total: string, tax: string): WooLine => ({ id, productId: 301, sku: "CANDLE-L", name: "Large candle", quantity, subtotal: total, total, tax });

/** WC2: #2001, paid by card through Stripe, 46.00. */
export function order2001(overrides: Partial<WooOrderFixture> = {}): WooOrderFixture {
  return {
    id: 2001,
    status: "processing",
    createdAt: "2026-10-02T01:29:00Z",
    paidAt: "2026-10-02T01:30:00Z",
    method: "stripe",
    methodTitle: "Credit card (Stripe)",
    customerId: 11,
    email: "aroha@manukavets.nz",
    first: "Aroha",
    last: "Ngata",
    lines: [CANDLE(1, 2, "40.00", "6.00")],
    total: "46.00",
    ...overrides,
  };
}

/** WC3: #2002, a coupon and shipping, 28.90, by Stripe. */
export function order2002(overrides: Partial<WooOrderFixture> = {}): WooOrderFixture {
  return {
    id: 2002,
    status: "processing",
    createdAt: "2026-10-03T01:00:00Z",
    paidAt: "2026-10-03T01:00:30Z",
    method: "stripe",
    methodTitle: "Credit card (Stripe)",
    customerId: 11,
    email: "aroha@manukavets.nz",
    first: "Aroha",
    last: "Ngata",
    lines: [{ id: 2, productId: 302, sku: "MELT-VAN", name: "Wax melts - Vanilla", quantity: 3, subtotal: "23.48", total: "19.13", tax: "2.87" }],
    shipping: { id: 3, title: "NZ Post standard", total: "6.00", tax: "0.90" },
    total: "28.90",
    ...overrides,
  };
}

/** WC4: #2003, direct bank transfer, on hold, 23.00. */
export function order2003(overrides: Partial<WooOrderFixture> = {}): WooOrderFixture {
  return {
    id: 2003,
    status: "on-hold",
    createdAt: "2026-10-04T02:00:00Z",
    paidAt: null,
    method: "bacs",
    methodTitle: "Direct bank transfer",
    customerId: 11,
    email: "aroha@manukavets.nz",
    first: "Aroha",
    last: "Ngata",
    lines: [CANDLE(4, 1, "20.00", "3.00")],
    total: "23.00",
    ...overrides,
  };
}

/** WC5: refund 7001 of #2001, one candle, 23.00. */
export const refund7001: WooRefundFixture = { id: 7001, createdAt: "2026-10-05T22:00:00Z", amount: "23.00", lines: [{ productId: 301, quantity: 1, total: "20.00", tax: "3.00" }] };

// ---------------------------------------------------------------------------
// The pretend store

export type WooState = {
  orders: WooOrderFixture[];
  /** Whether the key may make webhooks (a read key can't). */
  writable: boolean;
  webhooks: Array<{ id: number; topic: string; deliveryUrl: string; secret: string }>;
  calls: string[];
};

export function wooState(overrides: Partial<WooState> = {}): WooState {
  return { orders: [], writable: true, webhooks: [], calls: [], ...overrides };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function fakeWooStore(state: WooState) {
  const auth = `Basic ${Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64")}`;
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.host !== STORE) throw new Error(`fake WooCommerce: unexpected host ${url.host}`);
    if (url.pathname === "/wp-json/" || url.pathname === "/wp-json") return json({ name: "Glimmers", url: `https://${STORE}` });
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== auth) return json({ code: "woocommerce_rest_cannot_view", message: "Sorry, you cannot list resources." }, 401);
    const path = url.pathname.replace(/^\/wp-json\/wc\/v3/, "");
    state.calls.push(`${method} ${path}`);
    if (path === "/settings/general/woocommerce_currency") return json({ id: "woocommerce_currency", value: "NZD" });
    if (path === "/settings/tax/woocommerce_prices_include_tax") return json({ id: "woocommerce_prices_include_tax", value: "yes" });
    if (path === "/orders" && method === "GET") {
      const since = url.searchParams.get("modified_after");
      const perPage = Number(url.searchParams.get("per_page") ?? "10");
      const rows = state.orders
        .filter((o) => !since || Date.parse(o.modifiedAt ?? o.createdAt) > Date.parse(`${since}Z`))
        .sort((a, b) => Date.parse(a.modifiedAt ?? a.createdAt) - Date.parse(b.modifiedAt ?? b.createdAt))
        .slice(0, perPage);
      return json(rows.map(wooOrderNode), 200, { "x-wp-total": String(rows.length), "x-wp-totalpages": "1" });
    }
    const refunds = path.match(/^\/orders\/(\d+)\/refunds$/);
    if (refunds) return json((state.orders.find((o) => o.id === Number(refunds[1]))?.refunds ?? []).map(wooRefundNode));
    const one = path.match(/^\/orders\/(\d+)$/);
    if (one) {
      const order = state.orders.find((o) => o.id === Number(one[1]));
      return order ? json(wooOrderNode(order)) : json({ code: "woocommerce_rest_shop_order_invalid_id", message: "Invalid ID." }, 404);
    }
    if (path === "/webhooks" && method === "POST") {
      if (!state.writable) return json({ code: "woocommerce_rest_cannot_create", message: "Sorry, you are not allowed to create resources." }, 401);
      const body = JSON.parse(String(init?.body)) as { topic: string; delivery_url: string; secret: string };
      const id = 100 + state.webhooks.length;
      state.webhooks.push({ id, topic: body.topic, deliveryUrl: body.delivery_url, secret: body.secret });
      return json({ id, topic: body.topic, status: "active" }, 201);
    }
    const hook = path.match(/^\/webhooks\/(\d+)$/);
    if (hook && method === "DELETE") {
      state.webhooks = state.webhooks.filter((w) => w.id !== Number(hook[1]));
      return json({ id: Number(hook[1]) });
    }
    throw new Error(`fake WooCommerce: unexpected ${method} ${path}`);
  };
}

/** A webhook delivery as WooCommerce sends it, signed with `secret` (WC9). */
export function wooWebhook(path: { organisationId: string; webhookKey: string }, topic: string, payload: unknown, options: { secret: string; deliveryId: string }): Request {
  const body = JSON.stringify(payload);
  return new Request(`https://tohyee.example.nz/api/sales-platforms/webhooks/${path.organisationId}/${path.webhookKey}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wc-webhook-source": `https://${STORE}/`,
      "x-wc-webhook-topic": topic,
      "x-wc-webhook-resource": "order",
      "x-wc-webhook-event": topic.split(".")[1] ?? "",
      "x-wc-webhook-id": "100",
      "x-wc-webhook-delivery-id": options.deliveryId,
      "x-wc-webhook-signature": createHmac("sha256", options.secret).update(body, "utf8").digest("base64"),
    },
    body,
  });
}

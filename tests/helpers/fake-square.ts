import { createHmac } from "node:crypto";

/**
 * A pretend Square account for the Square examples (SQ1-SQ10 in
 * docs/ACCOUNTING-EXAMPLES.md), answering the API calls Tohyee makes in the
 * shapes Square's API reference gives (developer.squareup.com/reference/square).
 * None of it was recorded from a real Square account. Amounts are in cents,
 * as Square sends them.
 */

export const ACCESS_TOKEN = "EAAAtest_glimmers_square_token_0123456789";
export const MERCHANT_ID = "MLGLIMMERS01";
export const LOCATION_ID = "L0TAGOMARKET";
export const SIGNATURE_KEY = "test-signature-key-glimmers";

type Json = Record<string, unknown>;

export type SqLine = { uid: string; name: string; catalogId?: string; quantity: string; total: number; tax: number; discount?: number; giftCard?: boolean };
export type SqTender = { id: string; type: string; paymentId: string; amount: number };
export type SqOrder = {
  id: string;
  createdAt: string;
  updatedAt?: string;
  state?: "OPEN" | "COMPLETED" | "CANCELED";
  customerId?: string;
  lines: SqLine[];
  /** The order's one tax, or none. */
  taxType?: "INCLUSIVE" | "ADDITIVE" | null;
  tenders: SqTender[];
  total: number;
  tip?: number;
  serviceCharge?: number;
  source?: string;
  currency?: string;
  /** A return order (an itemised refund): the lines it returns from another order. */
  returns?: { sourceOrderId: string; lines: Array<{ uid: string; sourceUid: string; quantity: string; total: number; tax: number }> };
};
export type SqPayment = { id: string; orderId: string; status: string; total: number; createdAt: string; receipt: string; refundIds?: string[]; sourceType?: string };
export type SqRefund = { id: string; paymentId: string; orderId: string; status: string; amount: number; createdAt: string; updatedAt?: string };
export type SqCustomer = { id: string; given: string; family: string; email: string | null; country?: string; updatedAt: string };
export type SqEntry = { id: string; type: string; gross: number; fee: number; net: number; paymentId?: string };
export type SqPayout = { id: string; status: "SENT" | "PAID" | "FAILED"; createdAt: string; amount: number; currency?: string; entries: SqEntry[] };

export type SquareState = {
  orders: SqOrder[];
  payments: SqPayment[];
  refunds: SqRefund[];
  customers: SqCustomer[];
  payouts: SqPayout[];
  /** Catalog item variation ID -> SKU. */
  catalog: Record<string, string>;
  currency: string;
  subscriptions: Array<{ id: string; url: string; events: string[] }>;
  calls: string[];
};

export function squareState(overrides: Partial<SquareState> = {}): SquareState {
  return {
    orders: [],
    payments: [],
    refunds: [],
    customers: [AROHA],
    payouts: [],
    catalog: { "VAR-CANDLE": "CANDLE-L", "VAR-MELT": "MELT-VAN" },
    currency: "NZD",
    subscriptions: [],
    calls: [],
    ...overrides,
  };
}

export const AROHA: SqCustomer = { id: "CUST-AROHA", given: "Aroha", family: "Ngata", email: "aroha@manukavets.nz", country: "NZ", updatedAt: "2026-09-20T00:00:00Z" };

const money = (amount: number, currency = "NZD") => ({ amount, currency });

export function orderNode(o: SqOrder): Json {
  const currency = o.currency ?? "NZD";
  const taxUid = "TAX-GST";
  return {
    id: o.id,
    location_id: LOCATION_ID,
    state: o.state ?? "COMPLETED",
    created_at: o.createdAt,
    updated_at: o.updatedAt ?? o.createdAt,
    ...(o.state === "CANCELED" ? { closed_at: o.updatedAt ?? o.createdAt } : {}),
    ...(o.customerId ? { customer_id: o.customerId } : {}),
    ...(o.source ? { source: { name: o.source } } : {}),
    taxes: o.taxType ? [{ uid: taxUid, name: "GST", percentage: "15", type: o.taxType, scope: "LINE_ITEM" }] : [],
    line_items: o.lines.map((line) => ({
      uid: line.uid,
      name: line.name,
      quantity: line.quantity,
      ...(line.catalogId ? { catalog_object_id: line.catalogId } : {}),
      variation_name: "Regular",
      item_type: line.giftCard ? "GIFT_CARD" : "ITEM",
      total_money: money(line.total, currency),
      total_tax_money: money(line.tax, currency),
      total_discount_money: money(line.discount ?? 0, currency),
      applied_taxes: o.taxType && line.tax > 0 ? [{ uid: `${line.uid}-tax`, tax_uid: taxUid, applied_money: money(line.tax, currency) }] : [],
    })),
    ...(o.serviceCharge ? { service_charges: [{ uid: "SC1", name: "Card surcharge", applied_money: money(o.serviceCharge, currency) }] } : {}),
    tenders: o.tenders.map((tender) => ({ id: tender.id, type: tender.type, payment_id: tender.paymentId, amount_money: money(tender.amount, currency) })),
    ...(o.returns
      ? {
          returns: [
            {
              uid: "RET1",
              source_order_id: o.returns.sourceOrderId,
              return_line_items: o.returns.lines.map((line) => ({
                uid: line.uid,
                source_line_item_uid: line.sourceUid,
                quantity: line.quantity,
                total_money: money(line.total, currency),
                total_tax_money: money(line.tax, currency),
              })),
            },
          ],
        }
      : {}),
    total_money: money(o.total, currency),
    total_tip_money: money(o.tip ?? 0, currency),
  };
}

export function paymentNode(p: SqPayment, currency = "NZD"): Json {
  return {
    id: p.id,
    order_id: p.orderId,
    status: p.status,
    source_type: p.sourceType ?? "CARD",
    amount_money: money(p.total, currency),
    total_money: money(p.total, currency),
    created_at: p.createdAt,
    updated_at: p.createdAt,
    receipt_number: p.receipt,
    refund_ids: p.refundIds ?? [],
  };
}

export function refundNode(r: SqRefund, currency = "NZD"): Json {
  return {
    id: r.id,
    payment_id: r.paymentId,
    order_id: r.orderId,
    status: r.status,
    location_id: LOCATION_ID,
    amount_money: money(r.amount, currency),
    created_at: r.createdAt,
    updated_at: r.updatedAt ?? r.createdAt,
  };
}

export function payoutNode(p: SqPayout): Json {
  return { id: p.id, status: p.status, location_id: LOCATION_ID, created_at: p.createdAt, updated_at: p.createdAt, amount_money: money(p.amount, p.currency ?? "NZD"), type: "BATCH" };
}

export function entryNode(e: SqEntry, payoutId: string): Json {
  return {
    id: e.id,
    payout_id: payoutId,
    effective_at: "2026-10-06T00:00:00Z",
    type: e.type,
    gross_amount_money: money(e.gross),
    fee_amount_money: money(e.fee),
    net_amount_money: money(e.net),
    ...(e.type === "CHARGE" && e.paymentId ? { type_charge_details: { payment_id: e.paymentId } } : {}),
    ...(e.type === "REFUND" && e.paymentId ? { type_refund_details: { payment_id: e.paymentId, refund_id: "R" } } : {}),
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notFound = () => json({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND", detail: "Not found." }] }, 404);

/** The fetch Tohyee's Square connector uses, answering like Square. */
export function fakeSquare(state: SquareState) {
  let subscriptionCount = 0;
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.host !== "connect.squareup.com") throw new Error(`fake Square: unexpected host ${url.host}`);
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `Bearer ${ACCESS_TOKEN}`) {
      return json({ errors: [{ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED", detail: "This request could not be authorized." }] }, 401);
    }
    if (!headers.get("square-version")) throw new Error("fake Square: no Square-Version header");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/v2/, "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : {};
    state.calls.push(`${method} ${path}`);
    if (path === "/merchants/me") return json({ merchant: { id: MERCHANT_ID, business_name: "Glimmers markets", country: "NZ", currency: state.currency, status: "ACTIVE" } });
    if (path === "/locations") return json({ locations: [{ id: LOCATION_ID, name: "Otago Farmers Market", status: "ACTIVE", currency: state.currency }] });
    if (path === "/orders/search") {
      const since = (((body.query as Json)?.filter as Json)?.date_time_filter as Json)?.updated_at as Json | undefined;
      const start = since?.start_at ? Date.parse(String(since.start_at)) : 0;
      const rows = state.orders
        .filter((o) => Date.parse(o.updatedAt ?? o.createdAt) >= start)
        .sort((a, b) => Date.parse(a.updatedAt ?? a.createdAt) - Date.parse(b.updatedAt ?? b.createdAt));
      if (body.return_entries) return json({ order_entries: rows.slice(0, Number(body.limit ?? 500)).map((o) => ({ order_id: o.id, location_id: LOCATION_ID })) });
      return json({ orders: rows.slice(0, Number(body.limit ?? 500)).map(orderNode) });
    }
    const order = path.match(/^\/orders\/([^/]+)$/);
    if (order && method === "GET") {
      const found = state.orders.find((o) => o.id === decodeURIComponent(order[1]));
      return found ? json({ order: orderNode(found) }) : notFound();
    }
    const payment = path.match(/^\/payments\/([^/]+)$/);
    if (payment) {
      const found = state.payments.find((p) => p.id === decodeURIComponent(payment[1]));
      return found ? json({ payment: paymentNode(found, state.currency) }) : notFound();
    }
    if (path === "/refunds" && method === "GET") {
      const since = url.searchParams.get("updated_at_begin_time");
      const rows = state.refunds.filter((r) => !since || Date.parse(r.updatedAt ?? r.createdAt) >= Date.parse(since));
      return json({ refunds: rows.map((r) => refundNode(r, state.currency)) });
    }
    const refund = path.match(/^\/refunds\/([^/]+)$/);
    if (refund) {
      const found = state.refunds.find((r) => r.id === decodeURIComponent(refund[1]));
      return found ? json({ refund: refundNode(found, state.currency) }) : notFound();
    }
    const customer = path.match(/^\/customers\/([^/]+)$/);
    if (customer) {
      const found = state.customers.find((c) => c.id === decodeURIComponent(customer[1]));
      return found
        ? json({ customer: { id: found.id, given_name: found.given, family_name: found.family, email_address: found.email, address: found.country ? { country: found.country } : undefined, updated_at: found.updatedAt } })
        : notFound();
    }
    if (path === "/catalog/batch-retrieve" && method === "POST") {
      const ids = (body.object_ids as string[]) ?? [];
      return json({ objects: ids.filter((id) => state.catalog[id]).map((id) => ({ type: "ITEM_VARIATION", id, item_variation_data: { sku: state.catalog[id], name: "Regular" } })) });
    }
    if (path === "/payouts" && method === "GET") {
      const begin = url.searchParams.get("begin_time");
      const rows = state.payouts.filter((p) => !begin || Date.parse(p.createdAt) >= Date.parse(begin)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      return json({ payouts: rows.map(payoutNode) });
    }
    const entries = path.match(/^\/payouts\/([^/]+)\/payout-entries$/);
    if (entries) {
      const found = state.payouts.find((p) => p.id === decodeURIComponent(entries[1]));
      return found ? json({ payout_entries: found.entries.map((e) => entryNode(e, found.id)) }) : notFound();
    }
    if (path === "/webhooks/subscriptions" && method === "POST") {
      subscriptionCount += 1;
      const subscription = body.subscription as { notification_url: string; event_types: string[]; api_version: string };
      const id = `wbhk_${subscriptionCount}`;
      state.subscriptions.push({ id, url: subscription.notification_url, events: subscription.event_types });
      return json({ subscription: { id, name: "Tohyee", enabled: true, ...subscription, signature_key: SIGNATURE_KEY } });
    }
    const subscription = path.match(/^\/webhooks\/subscriptions\/([^/]+)$/);
    if (subscription && method === "DELETE") {
      state.subscriptions = state.subscriptions.filter((s) => s.id !== decodeURIComponent(subscription[1]));
      return json({});
    }
    throw new Error(`fake Square: unexpected ${method} ${path}`);
  };
}

/** An event notification as Square sends it: signed over the notification URL and the raw body (SQ8). */
export function squareWebhook(
  path: { organisationId: string; webhookKey: string },
  type: string,
  object: Json,
  options: { eventId: string; key?: string; merchantId?: string; signedUrl?: string },
): Request {
  const url = `https://tohyee.example.nz/api/sales-platforms/webhooks/${path.organisationId}/${path.webhookKey}`;
  const body = JSON.stringify({
    merchant_id: options.merchantId ?? MERCHANT_ID,
    type,
    event_id: options.eventId,
    created_at: "2026-10-03T01:01:00Z",
    data: { type: type.split(".")[0], id: "x", object },
  });
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "square-version": "2026-09-16",
      "x-square-hmacsha256-signature": createHmac("sha256", options.key ?? SIGNATURE_KEY)
        .update((options.signedUrl ?? url) + body)
        .digest("base64"),
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// The examples' orders (setup: Glimmers Ltd, GST 15% included in Square's prices)

/** SQ2: O-2001, 2 x Large candle 46.00 incl. GST 6.00, paid by card. */
export function cardSale(overrides: Partial<SqOrder> = {}): SqOrder {
  return {
    id: "O-2001",
    createdAt: "2026-10-03T01:00:00Z",
    customerId: AROHA.id,
    taxType: "INCLUSIVE",
    lines: [{ uid: "LI-1", name: "Large candle", catalogId: "VAR-CANDLE", quantity: "2", total: 4600, tax: 600 }],
    tenders: [{ id: "T-2001", type: "CARD", paymentId: "P-2001", amount: 4600 }],
    total: 4600,
    ...overrides,
  };
}

export const cardPayment: SqPayment = { id: "P-2001", orderId: "O-2001", status: "COMPLETED", total: 4600, createdAt: "2026-10-03T01:00:30Z", receipt: "R2001" };

import { createHmac } from "node:crypto";

/**
 * Shopify-shaped records for examples SPC11-SPC23, and a pretend store that
 * serves them the way the Admin GraphQL API (2026-07) and the client
 * credentials grant do. The shapes follow shopify.dev's reference pages
 * (Order, LineItem, ShippingLine, OrderTransaction, Refund,
 * ShopifyPaymentsPayout, ShopifyPaymentsBalanceTransaction); none of it was
 * recorded from a real store.
 */

export const DOMAIN = "glimmers.myshopify.com";
export const CLIENT_ID = "client-glimmers";
export const CLIENT_SECRET = "shpss_test_client_secret_glimmers";
export const ACCESS_TOKEN = "shpat_test_token_glimmers";

export type TaxFixture = { rate: number; amount: string; title?: string };
export type CustomerFixture = { id: number; first: string; last: string; email: string | null; country?: string | null; updatedAt: string };
export type VariantFixture = { id: number; title: string; sku: string | null; price: string; tracked?: boolean };
export type ProductFixture = { id: number; title: string; updatedAt: string; variants: VariantFixture[] };
export type LineFixture = {
  id: number;
  name: string;
  sku: string | null;
  quantity: number;
  variantId: number | null;
  originalTotal: string;
  discount?: string;
  tax?: TaxFixture[];
  giftCard?: boolean;
};
export type ShippingFixture = { id: number; title: string; amount: string; tax?: TaxFixture[]; removed?: boolean };
export type TransactionFixture = { id: number; kind: string; status?: string; gateway?: string; amount: string; processedAt: string; test?: boolean };
export type RefundFixture = {
  id: number;
  processedAt: string;
  lines: Array<{ lineId: number; quantity: number; restocked?: boolean; subtotal: string; tax: string }>;
  shipping?: Array<{ shippingLineId: number; subtotal: string; tax: string }>;
  adjustments?: number;
  transactions: TransactionFixture[];
};
export type OrderFixture = {
  id: number;
  name: string;
  processedAt: string;
  updatedAt: string;
  cancelledAt?: string | null;
  financialStatus: string;
  taxesIncluded: boolean;
  currency?: string;
  presentmentCurrency?: string;
  total: string;
  customer: CustomerFixture | null;
  billingCountry?: string | null;
  lines: LineFixture[];
  shipping?: ShippingFixture[];
  transactions: TransactionFixture[];
  refunds?: RefundFixture[];
  test?: boolean;
};
export type BalanceTransactionFixture = { id: number; type: string; amount: string; fee: string; net: string; orderName?: string | null; adjustmentReason?: string | null };
export type PayoutFixture = {
  id: number;
  issuedAt: string;
  status: string;
  net: string;
  currency?: string;
  direction?: string;
  transactions: BalanceTransactionFixture[];
};

const gid = (type: string, id: number) => `gid://shopify/${type}/${id}`;
const bag = (amount: string, currency = "NZD") => ({ shopMoney: { amount, currencyCode: currency } });
const taxLines = (lines: TaxFixture[] = [], currency = "NZD") =>
  lines.map((line) => ({ title: line.title ?? "GST", rate: line.rate, priceSet: bag(line.amount, currency) }));

export function customerNode(c: CustomerFixture) {
  return {
    id: gid("Customer", c.id),
    displayName: `${c.first} ${c.last}`.trim() || c.email,
    firstName: c.first,
    lastName: c.last,
    updatedAt: c.updatedAt,
    defaultEmailAddress: c.email ? { emailAddress: c.email } : null,
    defaultPhoneNumber: null,
    defaultAddress: c.country === undefined ? null : { countryCodeV2: c.country },
  };
}

function transactionNode(t: TransactionFixture, currency = "NZD") {
  return {
    id: gid("OrderTransaction", t.id),
    kind: t.kind,
    status: t.status ?? "SUCCESS",
    gateway: t.gateway ?? "shopify_payments",
    test: t.test === true,
    processedAt: t.processedAt,
    amountSet: bag(t.amount, currency),
  };
}

/** An order as the `order(id:)` query returns it: refunds are only their IDs (each is asked for on its own). */
export function orderNode(o: OrderFixture) {
  const currency = o.currency ?? "NZD";
  return {
    id: gid("Order", o.id),
    name: o.name,
    createdAt: o.processedAt,
    processedAt: o.processedAt,
    updatedAt: o.updatedAt,
    cancelledAt: o.cancelledAt ?? null,
    test: o.test === true,
    taxesIncluded: o.taxesIncluded,
    currencyCode: currency,
    presentmentCurrencyCode: o.presentmentCurrency ?? currency,
    displayFinancialStatus: o.financialStatus,
    totalPriceSet: bag(o.total, currency),
    customer: o.customer ? customerNode(o.customer) : null,
    billingAddress: o.billingCountry === undefined ? null : { countryCodeV2: o.billingCountry },
    lineItems: {
      nodes: o.lines.map((line) => ({
        id: gid("LineItem", line.id),
        name: line.name,
        sku: line.sku,
        quantity: line.quantity,
        isGiftCard: line.giftCard === true,
        variant: line.variantId === null ? null : { id: gid("ProductVariant", line.variantId) },
        originalTotalSet: bag(line.originalTotal, currency),
        discountAllocations: line.discount ? [{ allocatedAmountSet: bag(line.discount, currency) }] : [],
        taxLines: taxLines(line.tax, currency),
      })),
      pageInfo: { hasNextPage: false },
    },
    shippingLines: {
      nodes: (o.shipping ?? []).map((line) => ({
        id: gid("ShippingLine", line.id),
        title: line.title,
        isRemoved: line.removed === true,
        discountedPriceSet: bag(line.amount, currency),
        taxLines: taxLines(line.tax, currency),
      })),
      pageInfo: { hasNextPage: false },
    },
    transactions: o.transactions.map((t) => transactionNode(t, currency)),
    refunds: (o.refunds ?? []).map((r) => ({ id: gid("Refund", r.id) })),
  };
}

/** A refund as the `refund(id:)` query returns it. */
export function refundNode(r: RefundFixture, currency = "NZD") {
  return {
    id: gid("Refund", r.id),
    createdAt: r.processedAt,
    processedAt: r.processedAt,
    refundLineItems: {
      nodes: r.lines.map((line) => ({
        lineItem: { id: gid("LineItem", line.lineId) },
        quantity: line.quantity,
        restocked: line.restocked === true,
        subtotalSet: bag(line.subtotal, currency),
        totalTaxSet: bag(line.tax, currency),
      })),
      pageInfo: { hasNextPage: false },
    },
    refundShippingLines: {
      nodes: (r.shipping ?? []).map((line) => ({
        shippingLine: { id: gid("ShippingLine", line.shippingLineId) },
        subtotalAmountSet: bag(line.subtotal, currency),
        taxAmountSet: bag(line.tax, currency),
      })),
      pageInfo: { hasNextPage: false },
    },
    orderAdjustments: { nodes: Array.from({ length: r.adjustments ?? 0 }, (_, index) => ({ id: gid("OrderAdjustment", r.id * 10 + index) })) },
    transactions: { nodes: r.transactions.map((t) => transactionNode(t, currency)), pageInfo: { hasNextPage: false } },
  };
}

export function payoutNode(p: PayoutFixture) {
  return {
    id: gid("ShopifyPaymentsPayout", p.id),
    legacyResourceId: String(p.id),
    issuedAt: p.issuedAt,
    status: p.status,
    transactionType: p.direction ?? "DEPOSIT",
    net: { amount: p.net, currencyCode: p.currency ?? "NZD" },
  };
}

export function balanceTransactionNode(t: BalanceTransactionFixture, currency = "NZD") {
  return {
    id: gid("ShopifyPaymentsBalanceTransaction", t.id),
    type: t.type,
    test: false,
    adjustmentReason: t.adjustmentReason ?? null,
    amount: { amount: t.amount, currencyCode: currency },
    fee: { amount: t.fee },
    net: { amount: t.net },
    associatedOrder: t.orderName ? { name: t.orderName } : null,
  };
}

// ---------------------------------------------------------------------------
// The examples' records (docs/ACCOUNTING-EXAMPLES.md, SPC11-SPC23)

export const AROHA: CustomerFixture = { id: 1001, first: "Aroha", last: "Ngata", email: "aroha@manukavets.nz", country: "NZ", updatedAt: "2026-09-30T01:00:00Z" };
export const TAMA: CustomerFixture = { id: 1002, first: "Tama", last: "Rewi", email: "tama@example.co.nz", country: "NZ", updatedAt: "2026-09-30T02:00:00Z" };
export const EMMA: CustomerFixture = { id: 1005, first: "Emma", last: "Clarke", email: "emma@example.com.au", country: "AU", updatedAt: "2026-10-07T00:00:00Z" };

export const PRODUCTS: ProductFixture[] = [
  { id: 2001, title: "Large candle", updatedAt: "2026-09-30T01:00:00Z", variants: [{ id: 3001, title: "Default Title", sku: "CANDLE-L", price: "23.00" }] },
  { id: 2002, title: "Wax melts", updatedAt: "2026-09-30T02:00:00Z", variants: [{ id: 3002, title: "Vanilla", sku: "MELT-VAN", price: "9.00" }] },
  { id: 2004, title: "Gift box", updatedAt: "2026-09-30T04:00:00Z", variants: [{ id: 3004, title: "Default Title", sku: "GIFTBOX", price: "34.50", tracked: true }] },
];

const GST = (amount: string): TaxFixture[] => [{ title: "GST", rate: 0.15, amount }];
const sale = (id: number, amount: string, processedAt: string): TransactionFixture => ({ id, kind: "SALE", amount, processedAt });

/** SPC11: 2 x Large candle at 23.00, taxes included, GST 6.00, paid. */
export function order1001(overrides: Partial<OrderFixture> = {}): OrderFixture {
  return {
    id: 5001,
    name: "#1001",
    processedAt: "2026-10-02T01:30:00Z",
    updatedAt: "2026-10-02T01:31:00Z",
    financialStatus: "PAID",
    taxesIncluded: true,
    total: "46.00",
    customer: AROHA,
    billingCountry: "NZ",
    lines: [{ id: 4001, name: "Large candle", sku: "CANDLE-L", quantity: 2, variantId: 3001, originalTotal: "46.00", tax: GST("6.00") }],
    transactions: [sale(9001, "46.00", "2026-10-02T01:30:00Z")],
    ...overrides,
  };
}

/** SPC14: 1 of #1001's 2 candles refunded on 6 Oct (NZ), not restocked. */
export function refund6001(overrides: Partial<RefundFixture> = {}): RefundFixture {
  return {
    id: 6001,
    processedAt: "2026-10-05T22:00:00Z",
    lines: [{ lineId: 4001, quantity: 1, subtotal: "23.00", tax: "3.00" }],
    transactions: [{ id: 9101, kind: "REFUND", amount: "23.00", processedAt: "2026-10-05T22:00:00Z" }],
    ...overrides,
  };
}

/** SPC13: 3 x Wax melts - Vanilla at 9.00 less WELCOME5 5.00, plus NZ Post standard 6.90. */
export function order1002(overrides: Partial<OrderFixture> = {}): OrderFixture {
  return {
    id: 5002,
    name: "#1002",
    processedAt: "2026-10-03T00:15:00Z",
    updatedAt: "2026-10-03T00:16:00Z",
    financialStatus: "PAID",
    taxesIncluded: true,
    total: "28.90",
    customer: TAMA,
    billingCountry: "NZ",
    lines: [{ id: 4002, name: "Wax melts - Vanilla", sku: "MELT-VAN", quantity: 3, variantId: 3002, originalTotal: "27.00", discount: "5.00", tax: GST("2.87") }],
    shipping: [{ id: 4102, title: "NZ Post standard", amount: "6.90", tax: GST("0.90") }],
    transactions: [sale(9002, "28.90", "2026-10-03T00:15:00Z")],
    ...overrides,
  };
}

/** SPC16: Emma Clarke (AU), 1 x Large candle 23.00 with no tax lines. */
export function order1003(overrides: Partial<OrderFixture> = {}): OrderFixture {
  return {
    id: 5003,
    name: "#1003",
    processedAt: "2026-10-08T02:00:00Z",
    updatedAt: "2026-10-08T02:01:00Z",
    financialStatus: "PAID",
    taxesIncluded: true,
    total: "23.00",
    customer: EMMA,
    billingCountry: "AU",
    lines: [{ id: 4003, name: "Large candle", sku: "CANDLE-L", quantity: 1, variantId: 3001, originalTotal: "23.00" }],
    transactions: [sale(9003, "23.00", "2026-10-08T02:00:00Z")],
    ...overrides,
  };
}

/** SPC17: 1 x Gift box (tracked) at 34.50, tax 4.50. */
export function order1004(overrides: Partial<OrderFixture> = {}): OrderFixture {
  return {
    id: 5004,
    name: "#1004",
    processedAt: "2026-10-09T01:00:00Z",
    updatedAt: "2026-10-09T01:01:00Z",
    financialStatus: "PAID",
    taxesIncluded: true,
    total: "34.50",
    customer: AROHA,
    billingCountry: "NZ",
    lines: [{ id: 4004, name: "Gift box", sku: "GIFTBOX", quantity: 1, variantId: 3004, originalTotal: "34.50", tax: GST("4.50") }],
    transactions: [sale(9004, "34.50", "2026-10-09T01:00:00Z")],
    ...overrides,
  };
}

/** SPC20: pending (bank deposit), 1 x Large candle 23.00. */
export function order1005(overrides: Partial<OrderFixture> = {}): OrderFixture {
  return {
    id: 5005,
    name: "#1005",
    processedAt: "2026-10-10T00:00:00Z",
    updatedAt: "2026-10-10T00:01:00Z",
    financialStatus: "PENDING",
    taxesIncluded: true,
    total: "23.00",
    customer: TAMA,
    billingCountry: "NZ",
    lines: [{ id: 4005, name: "Large candle", sku: "CANDLE-L", quantity: 1, variantId: 3001, originalTotal: "23.00", tax: GST("3.00") }],
    transactions: [{ id: 9005, kind: "SALE", status: "PENDING", gateway: "Bank Deposit", amount: "23.00", processedAt: "2026-10-10T00:00:00Z" }],
    ...overrides,
  };
}

/** SPC15: payout 70001 (net 49.38) for #1001, #1002 and #1001's refund. */
export function payout70001(overrides: Partial<PayoutFixture> = {}): PayoutFixture {
  return {
    id: 70001,
    issuedAt: "2026-10-07T03:00:00Z",
    status: "PAID",
    net: "49.38",
    transactions: [
      { id: 80001, type: "CHARGE", amount: "46.00", fee: "1.38", net: "44.62", orderName: "#1001" },
      { id: 80002, type: "CHARGE", amount: "28.90", fee: "1.14", net: "27.76", orderName: "#1002" },
      { id: 80003, type: "REFUND", amount: "-23.00", fee: "0.00", net: "-23.00", orderName: "#1001" },
    ],
    ...overrides,
  };
}

/** SPC15: payout 70002 (net 17.33): a charge and an adjustment. */
export function payout70002(overrides: Partial<PayoutFixture> = {}): PayoutFixture {
  return {
    id: 70002,
    issuedAt: "2026-10-14T03:00:00Z",
    status: "PAID",
    net: "17.33",
    transactions: [
      { id: 80004, type: "CHARGE", amount: "23.00", fee: "0.67", net: "22.33", orderName: "#1003" },
      { id: 80005, type: "ADJUSTMENT", amount: "-5.00", fee: "0.00", net: "-5.00", adjustmentReason: "Shopify adjustment" },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The pretend store

export type StoreState = {
  scopes: string[];
  customers: CustomerFixture[];
  products: ProductFixture[];
  orders: OrderFixture[];
  payouts: PayoutFixture[];
  /** Whether the store has Shopify Payments. */
  payments: boolean;
  webhooks: Array<{ id: string; topic: string; callbackUrl: string }>;
  /** Tokens the store accepts; the client credentials grant adds one. */
  tokens: string[];
  issued: number;
  /** Answer the client credentials grant with shop_not_permitted. */
  notPermitted: boolean;
  /** Every call, in order ("token", "shop", "orders", "order:5001", "refund:6001", "payouts", "balance:70001"...). */
  calls: string[];
};

export function storeState(overrides: Partial<StoreState> = {}): StoreState {
  return {
    scopes: ["read_customers", "read_products", "read_orders", "read_shopify_payments_payouts", "read_shopify_payments_accounts"],
    customers: [AROHA, TAMA],
    products: PRODUCTS,
    orders: [],
    payouts: [],
    payments: true,
    webhooks: [],
    tokens: [ACCESS_TOKEN],
    issued: 0,
    notPermitted: false,
    calls: [],
    ...overrides,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const numeric = (value: unknown) => Number(String(value).split("/").pop());

/** The fetch Tohyee's Shopify connector uses, answering like the store. */
export function fakeShopifyStore(state: StoreState) {
  let webhookCounter = 0;
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.host !== DOMAIN) return json({ errors: "Not Found" }, 404);
    const raw = init?.body ? String(init.body) : "";
    if (url.pathname === "/admin/oauth/access_token") {
      state.calls.push("token");
      // https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
      if (init?.method !== "POST" || new Headers(init?.headers).get("content-type") !== "application/x-www-form-urlencoded") {
        return json({ error: "invalid_request" }, 400);
      }
      const form = new URLSearchParams(raw);
      if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET || form.get("grant_type") !== "client_credentials") {
        return json({ error: "invalid_client", error_description: "Client authentication failed" }, 400);
      }
      if (state.notPermitted) {
        return json({ error: "shop_not_permitted", error_description: "Client credentials cannot be performed on this shop." }, 400);
      }
      state.issued += 1;
      const token = `shpat_cc_${state.issued}`;
      state.tokens.push(token);
      return json({ access_token: token, scope: state.scopes.join(","), expires_in: 86399 });
    }
    if (url.pathname !== "/admin/api/2026-07/graphql.json" || init?.method !== "POST") return json({ errors: "Not Found" }, 404);
    if (!state.tokens.includes(new Headers(init?.headers).get("x-shopify-access-token") ?? "")) {
      return json({ errors: "[API] Invalid API key or access token (unrecognized login or wrong password)" }, 401);
    }
    const body = JSON.parse(raw);
    const query: string = body.query;
    const variables = body.variables ?? {};
    const filter: string = variables.query ?? "";
    const after = (name: string) => filter.match(new RegExp(`${name}:>='([^']+)'`))?.[1];
    const page = <T>(rows: T[]) => {
      const start = variables.after ? Number(variables.after) : 0;
      const nodes = rows.slice(start, start + variables.first);
      const end = start + nodes.length;
      return { nodes, pageInfo: { hasNextPage: end < rows.length, endCursor: String(end) } };
    };
    if (query.includes("webhookSubscriptionCreate")) {
      webhookCounter += 1;
      const id = `gid://shopify/WebhookSubscription/${webhookCounter}`;
      state.webhooks.push({ id, topic: variables.topic, callbackUrl: variables.webhookSubscription.callbackUrl });
      return json({ data: { webhookSubscriptionCreate: { webhookSubscription: { id }, userErrors: [] } } });
    }
    if (query.includes("webhookSubscriptionDelete")) {
      state.webhooks = state.webhooks.filter((hook) => hook.id !== variables.id);
      return json({ data: { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: variables.id, userErrors: [] } } });
    }
    if (query.includes("shop {")) {
      state.calls.push("shop");
      return json({
        data: {
          shop: { name: "Glimmers", myshopifyDomain: DOMAIN, currencyCode: "NZD", taxesIncluded: true },
          currentAppInstallation: { accessScopes: state.scopes.map((handle) => ({ handle })) },
        },
      });
    }
    const since = after("updated_at");
    const recent = <T extends { updatedAt: string }>(rows: T[]) =>
      rows.filter((row) => !since || Date.parse(row.updatedAt) >= Date.parse(since)).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    if (query.includes("customers(first")) {
      state.calls.push("customers");
      const result = page(recent(state.customers));
      return json({ data: { customers: { nodes: result.nodes.map(customerNode), pageInfo: result.pageInfo } } });
    }
    if (query.includes("products(first")) {
      state.calls.push("products");
      const result = page(recent(state.products));
      return json({
        data: {
          products: {
            nodes: result.nodes.map((p) => ({
              id: gid("Product", p.id),
              title: p.title,
              updatedAt: p.updatedAt,
              variants: {
                nodes: p.variants.map((v) => ({
                  id: gid("ProductVariant", v.id),
                  title: v.title,
                  sku: v.sku ?? "",
                  price: v.price,
                  updatedAt: p.updatedAt,
                  inventoryItem: { tracked: v.tracked === true },
                })),
                pageInfo: { hasNextPage: false },
              },
            })),
            pageInfo: result.pageInfo,
          },
        },
      });
    }
    if (query.includes("orders(first")) {
      state.calls.push("orders");
      const processed = after("processed_at");
      const rows = recent(state.orders).filter((o) => !processed || Date.parse(o.processedAt) >= Date.parse(processed));
      const result = page(rows);
      return json({ data: { orders: { nodes: result.nodes.map((o) => ({ id: gid("Order", o.id), updatedAt: o.updatedAt })), pageInfo: result.pageInfo } } });
    }
    if (query.includes("order(id: $id)")) {
      const id = numeric(variables.id);
      state.calls.push(`order:${id}`);
      const found = state.orders.find((o) => o.id === id);
      return json({ data: { order: found ? orderNode(found) : null } });
    }
    if (query.includes("refund(id: $id)")) {
      const id = numeric(variables.id);
      state.calls.push(`refund:${id}`);
      const found = state.orders.flatMap((o) => o.refunds ?? []).find((r) => r.id === id);
      return json({ data: { refund: found ? refundNode(found) : null } });
    }
    if (query.includes("payouts(first")) {
      state.calls.push("payouts");
      if (!state.payments) return json({ data: { shopifyPaymentsAccount: null } });
      const issued = after("issued_at");
      const rows = state.payouts.filter((p) => !issued || Date.parse(p.issuedAt) >= Date.parse(issued)).sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt));
      const result = page(rows);
      return json({ data: { shopifyPaymentsAccount: { payouts: { nodes: result.nodes.map(payoutNode), pageInfo: result.pageInfo } } } });
    }
    if (query.includes("balanceTransactions(first")) {
      const id = Number(filter.match(/payments_transfer_id:(\d+)/)?.[1]);
      state.calls.push(`balance:${id}`);
      const payout = state.payouts.find((p) => p.id === id);
      const result = page(payout?.transactions ?? []);
      return json({
        data: { shopifyPaymentsAccount: { balanceTransactions: { nodes: result.nodes.map((t) => balanceTransactionNode(t)), pageInfo: result.pageInfo } } },
      });
    }
    return json({ errors: [{ message: `unexpected query ${query.slice(0, 60)}` }] });
  };
}

/** A webhook as Shopify sends it (REST-shaped JSON, signed with the app's secret). */
export function signedWebhook(
  path: { organisationId: string; webhookKey: string },
  topic: string,
  payload: unknown,
  options: { secret?: string; id: string },
): Request {
  const body = JSON.stringify(payload);
  return new Request(`https://tohyee.example.nz/api/sales-platforms/webhooks/${path.organisationId}/${path.webhookKey}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": DOMAIN,
      "x-shopify-api-version": "2026-07",
      "x-shopify-webhook-id": options.id,
      "x-shopify-triggered-at": "2026-10-02T01:31:00Z",
      "x-shopify-hmac-sha256": createHmac("sha256", options.secret ?? CLIENT_SECRET).update(body, "utf8").digest("base64"),
    },
    body,
  });
}

/** The REST-shaped order webhook body (orders/create, orders/updated, orders/paid, orders/cancelled): only the ID is used. */
export const orderWebhookBody = (o: OrderFixture) => ({
  id: o.id,
  admin_graphql_api_id: gid("Order", o.id),
  name: o.name,
  financial_status: o.financialStatus.toLowerCase(),
  total_price: o.total,
  currency: o.currency ?? "NZD",
  updated_at: o.updatedAt,
});

/** The refunds/create webhook body: the order it belongs to is fetched again. */
export const refundWebhookBody = (orderId: number, r: RefundFixture) => ({
  id: r.id,
  order_id: orderId,
  admin_graphql_api_id: gid("Refund", r.id),
  created_at: r.processedAt,
  processed_at: r.processedAt,
  restock: false,
});

import { type StoreState, fakeShopifyStore } from "./fake-shopify-orders";

/**
 * Shopify-shaped answers for the read-only extras (examples SPD1-SPD10):
 * locations and inventory levels, ShopifyQL shop reports, discounts, gift
 * cards, and the discounts, shipments and shipping on an order. Made-up
 * data in the shapes of shopify.dev's 2026-10 reference (InventoryLevel,
 * Location, shopifyqlQuery, DiscountCodeBasic, GiftCard,
 * GiftCardTransaction, Order.discountApplications, Fulfillment); none of it
 * was recorded from a real store. Refusals use Shopify's documented error
 * shape (`errors[].extensions.code` "ACCESS_DENIED", `data` null).
 */

const gid = (type: string, id: number) => `gid://shopify/${type}/${id}`;
const nzd = (amount: string) => ({ amount, currencyCode: "NZD" });
const bag = (amount: string) => ({ shopMoney: nzd(amount) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const accessDenied = (field: string, required: string) =>
  json({
    errors: [
      {
        message: `Access denied for ${field} field. Required access: ${required}`,
        extensions: { code: "ACCESS_DENIED", documentation: "https://shopify.dev/api/usage/access-scopes" },
        path: [field],
      },
    ],
    data: null,
  });

export type ExtrasState = {
  locations: Array<{ id: number; name: string; active: boolean }>;
  /** Each inventory item: its variant, SKU and quantities per location. */
  inventory: Array<{ id: number; variantId: number; sku: string | null; product: string; variant: string; tracked?: boolean; levels: Array<{ location: number; available: number; onHand: number }> }>;
  /** ShopifyQL answers, as rows keyed by column name. */
  sessions: Array<{ day: string; sessions: string; conversion_rate: string }>;
  sales: Array<{ day: string; orders: string; gross_sales: string; net_sales: string }>;
  byProduct: Array<{ day: string; product_title: string; orders: string; gross_sales: string; net_sales: string }>;
  byChannel: Array<{ day: string; sales_channel: string; orders: string; gross_sales: string; net_sales: string }>;
  /** Shopify hasn't approved shop reports (level 2 protected customer data). */
  statsDenied: boolean;
  /** Shopify hasn't approved fulfilment orders. */
  fulfilmentOrdersDenied: boolean;
  discounts: unknown[];
  giftCards: unknown[];
  /** The full gift card codes Shopify holds (never asked for: the test checks they don't reach Tohyee). */
  fullCodes: string[];
  /** Extras for an order's GraphQL node, by order ID. */
  orders: Record<number, Record<string, unknown>>;
  /** The extras queries asked, in order. */
  calls: string[];
};

/** SPD setup: Glimmers' two locations, the gift box and candle stock, a week of stats, a code and an automatic discount, two gift cards. */
export function extrasState(overrides: Partial<ExtrasState> = {}): ExtrasState {
  return {
    locations: [
      { id: 61, name: "Dunedin workshop", active: true },
      { id: 62, name: "Otago Farmers Market", active: true },
    ],
    inventory: [
      { id: 7004, variantId: 3004, sku: "GIFTBOX", product: "Gift box", variant: "Default Title", tracked: true, levels: [{ location: 61, available: 5, onHand: 7 }, { location: 62, available: 2, onHand: 2 }] },
      { id: 7001, variantId: 3001, sku: "CANDLE-L", product: "Large candle", variant: "Default Title", tracked: true, levels: [{ location: 61, available: 12, onHand: 12 }] },
      { id: 7009, variantId: 3009, sku: null, product: "Mystery bundle", variant: "Default Title", tracked: true, levels: [{ location: 61, available: 1, onHand: 1 }] },
      { id: 7010, variantId: 3010, sku: "STICKER", product: "Sticker", variant: "Default Title", tracked: false, levels: [] },
    ],
    sessions: [
      { day: "2026-10-01", sessions: "120", conversion_rate: "2.5" },
      { day: "2026-10-02", sessions: "80", conversion_rate: "1.25" },
    ],
    sales: [
      { day: "2026-10-01", orders: "3", gross_sales: "120.00", net_sales: "110.00" },
      { day: "2026-10-02", orders: "1", gross_sales: "40.00", net_sales: "40.00" },
    ],
    byProduct: [
      { day: "2026-10-01", product_title: "Large candle", orders: "2", gross_sales: "80.00", net_sales: "75.00" },
      { day: "2026-10-01", product_title: "Wax melts", orders: "1", gross_sales: "40.00", net_sales: "35.00" },
    ],
    byChannel: [
      { day: "2026-10-01", sales_channel: "Online Store", orders: "2", gross_sales: "80.00", net_sales: "70.00" },
      { day: "2026-10-01", sales_channel: "Point of Sale", orders: "1", gross_sales: "40.00", net_sales: "40.00" },
    ],
    statsDenied: false,
    fulfilmentOrdersDenied: false,
    discounts: [
      {
        id: gid("DiscountCodeNode", 801),
        discount: {
          __typename: "DiscountCodeBasic",
          title: "MELT5",
          status: "ACTIVE",
          startsAt: "2026-09-25T00:00:00Z",
          endsAt: null,
          asyncUsageCount: 14,
          customerGets: { value: { __typename: "DiscountAmount", amount: nzd("5.0") } },
        },
      },
      {
        id: gid("DiscountAutomaticNode", 802),
        discount: {
          __typename: "DiscountAutomaticBasic",
          title: "Spring 10% off",
          status: "EXPIRED",
          startsAt: "2026-09-01T00:00:00Z",
          endsAt: "2026-09-30T11:00:00Z",
          asyncUsageCount: 31,
          customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.1 } },
        },
      },
      {
        id: gid("DiscountCodeNode", 803),
        discount: { __typename: "DiscountCodeFreeShipping", title: "FREESHIP", status: "SCHEDULED", startsAt: "2026-11-01T00:00:00Z", endsAt: null, asyncUsageCount: 0 },
      },
    ],
    giftCards: [
      {
        id: gid("GiftCard", 901),
        lastCharacters: "7XQ2",
        enabled: true,
        expiresOn: "2027-10-01",
        createdAt: "2026-10-01T02:00:00Z",
        deactivatedAt: null,
        initialValue: nzd("50.0"),
        balance: nzd("30.0"),
        transactions: {
          nodes: [
            { __typename: "GiftCardDebitTransaction", id: gid("GiftCardDebitTransaction", 9501), processedAt: "2026-10-05T03:00:00Z", amount: nzd("-20.0") },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
      {
        id: gid("GiftCard", 902),
        lastCharacters: "K9MD",
        enabled: false,
        expiresOn: null,
        createdAt: "2026-10-03T02:00:00Z",
        deactivatedAt: "2026-10-04T00:00:00Z",
        initialValue: nzd("25.0"),
        balance: nzd("25.0"),
        transactions: { nodes: [], pageInfo: { hasNextPage: false } },
      },
    ],
    fullCodes: ["GLIM-WXYZ-ABCD-7XQ2", "GLIM-PPPP-QQQQ-K9MD"],
    orders: {
      // #1002 (SPC12): the MELT5 code took 5.00 off the wax melts; shipped by NZ Post.
      5002: {
        discountCode: "MELT5",
        discountAmount: "5.00",
        shipping: "6.90",
        fulfilment: { id: 9801, status: "SUCCESS", createdAt: "2026-10-03T20:00:00Z", deliveredAt: "2026-10-05T01:00:00Z", company: "NZ Post", number: "NZ123456789" },
      },
    },
    calls: [],
    ...overrides,
  };
}

function page<T>(rows: T[], variables: Record<string, unknown>) {
  const start = variables.after ? Number(variables.after) : 0;
  const nodes = rows.slice(start, start + Number(variables.first));
  const end = start + nodes.length;
  return { nodes, pageInfo: { hasNextPage: end < rows.length, endCursor: String(end) } };
}

/** The orders fake, answering the extras queries too; an order query asking for extras gets them added. */
export function fakeShopifyStoreWithExtras(state: StoreState, extras: ExtrasState) {
  const base = fakeShopifyStore(state);
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (!url.pathname.endsWith("/graphql.json") || !init?.body) return base(input, init);
    const body = JSON.parse(String(init.body));
    const query: string = body.query;
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    // The orders fake checks the token; the extras answer only after the same check.
    const checked = state.tokens.includes(new Headers(init.headers).get("x-shopify-access-token") ?? "");
    if (!checked) return base(input, init);
    if (query.includes("locations(first")) {
      extras.calls.push("locations");
      const result = page(extras.locations, variables);
      return json({ data: { locations: { nodes: result.nodes.map((l) => ({ id: gid("Location", l.id), name: l.name, isActive: l.active })), pageInfo: result.pageInfo } } });
    }
    if (query.includes("inventoryItems(first")) {
      extras.calls.push("inventory");
      const result = page(extras.inventory, variables);
      return json({
        data: {
          inventoryItems: {
            nodes: result.nodes.map((item) => ({
              id: gid("InventoryItem", item.id),
              sku: item.sku ?? "",
              tracked: item.tracked !== false,
              variant: { id: gid("ProductVariant", item.variantId), title: item.variant, product: { title: item.product } },
              inventoryLevels: {
                nodes: item.levels.map((level) => ({
                  location: { id: gid("Location", level.location) },
                  quantities: [
                    { name: "available", quantity: level.available },
                    { name: "on_hand", quantity: level.onHand },
                  ],
                })),
                pageInfo: { hasNextPage: false },
              },
            })),
            pageInfo: result.pageInfo,
          },
        },
      });
    }
    if (query.includes("shopifyqlQuery(")) {
      const ql = String(variables.query);
      extras.calls.push(`shopifyql:${ql}`);
      if (extras.statsDenied) {
        return accessDenied("shopifyqlQuery", "`read_reports` access scope. Also: Level 2 access to Customer data including name, address, phone, and email fields.");
      }
      const table = (columns: Array<[string, string]>, rows: unknown[]) => ({
        data: { shopifyqlQuery: { tableData: { columns: columns.map(([name, dataType]) => ({ name, dataType, displayName: name })), rows }, parseErrors: [] } },
      });
      const sales: Array<[string, string]> = [["orders", "INTEGER"], ["gross_sales", "MONEY"], ["net_sales", "MONEY"]];
      if (ql.startsWith("FROM sessions")) return json(table([["day", "DAY_TIMESTAMP"], ["sessions", "INTEGER"], ["conversion_rate", "PERCENT"]], extras.sessions));
      if (ql.includes("product_title")) return json(table([["day", "DAY_TIMESTAMP"], ["product_title", "STRING"], ...sales], extras.byProduct));
      if (ql.includes("sales_channel")) return json(table([["day", "DAY_TIMESTAMP"], ["sales_channel", "STRING"], ...sales], extras.byChannel));
      return json(table([["day", "DAY_TIMESTAMP"], ...sales], extras.sales));
    }
    if (query.includes("discountNodes(first")) {
      extras.calls.push("discounts");
      const result = page(extras.discounts, variables);
      return json({ data: { discountNodes: result } });
    }
    if (query.includes("giftCards(first")) {
      extras.calls.push("giftCards");
      // Tohyee must never ask for the code itself.
      if (/\bcode\b|maskedCode/.test(query)) return json({ errors: [{ message: "The test store refuses to give out gift card codes." }] });
      const result = page(extras.giftCards, variables);
      return json({ data: { giftCards: result } });
    }
    if (query.includes("order(id: $id)")) {
      if (query.includes("fulfillmentOrders")) {
        extras.calls.push("order-with-fulfillment-orders");
        if (extras.fulfilmentOrdersDenied) return accessDenied("fulfillmentOrders", "`read_merchant_managed_fulfillment_orders` access scope.");
      }
      const answer = await base(input, init);
      const parsed = (await answer.json()) as { data?: { order?: Record<string, unknown> | null } };
      const order = parsed.data?.order;
      if (!order) return json(parsed);
      const id = Number(String(order.id).split("/").pop());
      const extra = extras.orders[id] as
        | { discountCode?: string; discountAmount?: string; shipping?: string; fulfilment?: { id: number; status: string; createdAt: string; deliveredAt: string | null; company: string; number: string } }
        | undefined;
      if (query.includes("discountApplications")) {
        const lines = (order.lineItems as { nodes: Array<{ discountAllocations: Array<Record<string, unknown>> }> }).nodes;
        for (const line of lines) for (const allocation of line.discountAllocations) allocation.discountApplication = { index: 0 };
        for (const line of (order.shippingLines as { nodes: Array<Record<string, unknown>> }).nodes) line.discountAllocations = [];
        order.totalDiscountsSet = bag(extra?.discountAmount ?? "0.0");
        order.discountApplications = {
          nodes: extra?.discountCode
            ? [{ __typename: "DiscountCodeApplication", index: 0, code: extra.discountCode, value: { __typename: "MoneyV2", amount: "5.0", currencyCode: "NZD" } }]
            : [],
          pageInfo: { hasNextPage: false },
        };
      }
      if (query.includes("fulfillments(first")) {
        const f = extra?.fulfilment;
        order.displayFulfillmentStatus = f ? "FULFILLED" : "UNFULFILLED";
        order.totalShippingPriceSet = bag(extra?.shipping ?? "0.0");
        order.fulfillments = f
          ? [{ id: gid("Fulfillment", f.id), status: f.status, createdAt: f.createdAt, deliveredAt: f.deliveredAt, trackingInfo: [{ company: f.company, number: f.number }] }]
          : [];
      }
      if (query.includes("fulfillmentOrders")) order.fulfillmentOrders = { nodes: extra?.fulfilment ? [{ id: gid("FulfillmentOrder", 9901), status: "CLOSED" }] : [{ id: gid("FulfillmentOrder", 9902), status: "OPEN" }] };
      return json(parsed);
    }
    return base(input, init);
  };
}

import { describe, expect, it } from "vitest";
import { loadKeyOf } from "@/lib/analytics/freshness";
import { tableLabel } from "@/lib/analytics/labels";
import { SHOPIFY_TABLES, isShopifyTable } from "@/lib/analytics/shopify-tables";
import { PlatformError } from "@/lib/sales-platforms/connector";
import {
  SHOPIFY_ALL_SCOPES,
  SHOPIFY_PARTS,
  SHOPIFY_SCOPES_LINE,
  STATS_NOT_APPROVED,
  partOffMessage,
  partOn,
  shopifyPartStates,
} from "@/lib/sales-platforms/parts";
import {
  dailyStats,
  decimalText,
  isAccessDenied,
  lastCharacters,
  orderExtraFields,
  salesBreakdown,
  shopifyDiscountFromGraphql,
  shopifyGiftCardFromGraphql,
  shopifyLocationFromGraphql,
  shopifyOrderExtrasFromGraphql,
  shopifyqlRows,
  shopifyStockFromGraphql,
  statsQueries,
} from "@/lib/sales-platforms/shopify-data";

/** Examples SPD1-SPD11: the pure parts, with made-up Shopify-shaped nodes (2026-10 reference shapes). */
describe("Shopify parts and scopes (decisions 1237, 1245)", () => {
  it("lists every scope once, in one comma-separated line, with no write scopes", () => {
    expect(SHOPIFY_SCOPES_LINE).toBe(
      "read_customers,read_products,read_orders,read_shopify_payments_payouts,read_shopify_payments_accounts,read_inventory,read_locations,read_reports,read_discounts,read_gift_cards,read_gift_card_transactions,read_merchant_managed_fulfillment_orders",
    );
    expect(SHOPIFY_ALL_SCOPES.every((scope) => scope.startsWith("read_"))).toBe(true);
    expect(new Set(SHOPIFY_ALL_SCOPES).size).toBe(SHOPIFY_ALL_SCOPES.length);
    expect(SHOPIFY_SCOPES_LINE).not.toMatch(/\s/);
  });

  it("says which parts are on from the scopes the store gave, each with and without its scopes", () => {
    const none = shopifyPartStates(["read_customers", "read_products"]);
    expect(none.filter((p) => p.on).map((p) => p.key)).toEqual(["records"]);
    const all = shopifyPartStates([...SHOPIFY_ALL_SCOPES]);
    expect(all.every((p) => p.on && p.missing.length === 0 && p.optionalMissing.length === 0)).toBe(true);
    for (const part of SHOPIFY_PARTS) {
      expect(partOn([...part.scopes], part.key)).toBe(true);
      for (const scope of part.scopes) expect(partOn(part.scopes.filter((s) => s !== scope), part.key)).toBe(false);
    }
    // Fulfilments work without the approval-only scope; it's only optional.
    const fulfilments = shopifyPartStates(["read_orders"]).find((p) => p.key === "fulfilments")!;
    expect(fulfilments).toMatchObject({ on: true, optionalMissing: ["read_merchant_managed_fulfillment_orders"] });
    expect(shopifyPartStates(["read_gift_cards"]).find((p) => p.key === "giftCards")).toMatchObject({ on: false, missing: ["read_gift_card_transactions"] });
  });

  it("logs the missing scope the way payouts do", () => {
    expect(partOffMessage("stock", ["read_inventory"])).toBe(
      "Stock levels aren't brought in: the app hasn't been given read_locations. Add it to the app's access scopes in Shopify, then test the connection.",
    );
    expect(STATS_NOT_APPROVED).toMatch(/^Shopify hasn't approved shop reports for this app yet\./);
  });
});

describe("SPD1: stock levels", () => {
  const item = (overrides: Record<string, unknown> = {}) => ({
    id: "gid://shopify/InventoryItem/7004",
    sku: "GIFTBOX",
    tracked: true,
    variant: { id: "gid://shopify/ProductVariant/3004", title: "Default Title", product: { title: "Gift box" } },
    inventoryLevels: {
      nodes: [
        { location: { id: "gid://shopify/Location/61" }, quantities: [{ name: "available", quantity: 5 }, { name: "on_hand", quantity: 7 }] },
        { location: { id: "gid://shopify/Location/62" }, quantities: [{ name: "on_hand", quantity: -1 }] },
      ],
      pageInfo: { hasNextPage: false },
    },
    ...overrides,
  });
  it("reads available and on hand per location", () => {
    expect(shopifyStockFromGraphql(item()).levels).toEqual([
      { variantId: "3004", inventoryItemId: "7004", locationId: "61", sku: "GIFTBOX", productTitle: "Gift box", variantTitle: "Default Title", available: "5", onHand: "7" },
      // A quantity Shopify left out is 0; a negative one is kept.
      { variantId: "3004", inventoryItemId: "7004", locationId: "62", sku: "GIFTBOX", productTitle: "Gift box", variantTitle: "Default Title", available: "0", onHand: "-1" },
    ]);
  });
  it("leaves out untracked items and items without a variant, and says when there are more locations", () => {
    expect(shopifyStockFromGraphql(item({ tracked: false })).levels).toEqual([]);
    expect(shopifyStockFromGraphql(item({ variant: null })).levels).toEqual([]);
    expect(shopifyStockFromGraphql(item({ inventoryLevels: { nodes: [], pageInfo: { hasNextPage: true } } })).moreLevels).toBe(true);
    expect(shopifyLocationFromGraphql({ id: "gid://shopify/Location/9", name: " Shop ", isActive: false })).toEqual({ externalId: "9", name: "Shop", active: false });
    expect(shopifyLocationFromGraphql({ id: "nope" })).toBeNull();
  });
});

describe("SPD3: shop stats (ShopifyQL)", () => {
  it("asks for the last N days with documented datasets and fields", () => {
    expect(statsQueries(30)).toEqual({
      sessions: "FROM sessions SHOW sessions, conversion_rate TIMESERIES day SINCE -30d ORDER BY day ASC",
      sales: "FROM sales SHOW orders, gross_sales, net_sales TIMESERIES day SINCE -30d ORDER BY day ASC",
      byProduct: "FROM sales SHOW orders, gross_sales, net_sales GROUP BY day, product_title SINCE -30d ORDER BY day ASC LIMIT 1000",
      byChannel: "FROM sales SHOW orders, gross_sales, net_sales GROUP BY day, sales_channel SINCE -30d ORDER BY day ASC LIMIT 1000",
    });
  });
  it("reads rows as objects or arrays, and refuses parse errors", () => {
    const columns = [{ name: "day" }, { name: "orders" }];
    expect(shopifyqlRows({ tableData: { columns, rows: [{ day: "2026-10-01", orders: "3" }] }, parseErrors: [] })).toEqual([{ day: "2026-10-01", orders: "3" }]);
    expect(shopifyqlRows({ tableData: { columns, rows: [["2026-10-01", "3"]] }, parseErrors: [] })).toEqual([{ day: "2026-10-01", orders: "3" }]);
    expect(() => shopifyqlRows({ tableData: null, parseErrors: ["Column Not Found: Column 'total_sale' not found."] })).toThrow("Column 'total_sale' not found");
  });
  it("merges sessions and sales by day, and adds up a breakdown's repeated values", () => {
    expect(dailyStats([{ day: "2026-10-02T00:00:00", sessions: "80", conversion_rate: "1.25" }], [{ day: "2026-10-01", orders: "3", gross_sales: "120.10", net_sales: "110" }, { day: "bad" }])).toEqual([
      { day: "2026-10-01", sessions: null, conversionRate: null, orders: "3", grossSales: "120.1", netSales: "110" },
      { day: "2026-10-02", sessions: "80", conversionRate: "1.25", orders: null, grossSales: null, netSales: null },
    ]);
    expect(salesBreakdown([
      { day: "2026-10-01", product_title: "Candle", orders: "1", gross_sales: "10.10", net_sales: "10" },
      { day: "2026-10-01", product_title: "Candle ", orders: "2", gross_sales: "0.20", net_sales: null },
      { day: "2026-10-01", product_title: null, orders: "1", gross_sales: "5", net_sales: "5" },
    ], "product")).toEqual([
      { day: "2026-10-01", dimension: "product", value: "Candle", orders: "3", grossSales: "10.3", netSales: "10" },
      { day: "2026-10-01", dimension: "product", value: "(none)", orders: "1", grossSales: "5", netSales: "5" },
    ]);
  });
  it("tells a refusal (access or approval) from a failure", () => {
    expect(isAccessDenied(Object.assign(new PlatformError(200, "x said: Access denied for shopifyqlQuery field."), { accessDenied: true }))).toBe(true);
    expect(isAccessDenied(new PlatformError(200, "This app is not approved to access the Customer object"))).toBe(true);
    expect(isAccessDenied(new PlatformError(0, "Couldn't reach x: timeout"))).toBe(false);
    expect(isAccessDenied(new Error("Access denied"))).toBe(false);
  });
  it("reads numbers exactly, never through floats", () => {
    expect(decimalText("0.1")).toBe("0.1");
    expect(decimalText(0.1)).toBe("0.1");
    expect(decimalText("1e5")).toBeNull();
    expect(decimalText("12.50")).toBe("12.5");
  });
});

describe("SPD5-SPD6: discounts", () => {
  it("reads a code discount's amount and an automatic discount's percentage", () => {
    expect(shopifyDiscountFromGraphql({
      id: "gid://shopify/DiscountCodeNode/801",
      discount: { __typename: "DiscountCodeBasic", title: "MELT5", status: "ACTIVE", startsAt: "2026-09-25T00:00:00Z", endsAt: null, asyncUsageCount: 14, customerGets: { value: { __typename: "DiscountAmount", amount: { amount: "5.0", currencyCode: "NZD" } } } },
    })).toEqual({ externalId: "801", method: "code", title: "MELT5", discountType: "amount_off", valueType: "amount", value: "5", startsAt: "2026-09-25T00:00:00.000Z", endsAt: null, status: "ACTIVE", timesUsed: 14 });
    expect(shopifyDiscountFromGraphql({
      id: "gid://shopify/DiscountAutomaticNode/802",
      discount: { __typename: "DiscountAutomaticBasic", title: "Spring", status: "EXPIRED", startsAt: "2026-09-01T00:00:00Z", customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.125 } } },
    })).toMatchObject({ method: "automatic", valueType: "percentage", value: "12.5", timesUsed: null });
    expect(shopifyDiscountFromGraphql({ id: "gid://shopify/DiscountNode/1", discount: { __typename: "SomethingNew" } })).toBeNull();
  });
  it("works out each discount's amount on an order from what Shopify allocated", () => {
    const parts = { discounts: true, fulfilments: false, fulfilmentOrders: false };
    const money = (amount: string) => ({ shopMoney: { amount, currencyCode: "NZD" } });
    const extras = shopifyOrderExtrasFromGraphql({
      totalDiscountsSet: money("7.5"),
      lineItems: { nodes: [
        { discountAllocations: [{ allocatedAmountSet: money("2.5"), discountApplication: { index: 0 } }, { allocatedAmountSet: money("1.0"), discountApplication: { index: 1 } }] },
        { discountAllocations: [{ allocatedAmountSet: money("2.5"), discountApplication: { index: 0 } }] },
      ] },
      shippingLines: { nodes: [{ discountAllocations: [{ allocatedAmountSet: money("1.5"), discountApplication: { index: 1 } }] }] },
      discountApplications: { nodes: [
        { __typename: "DiscountCodeApplication", index: 0, code: "MELT5", value: { __typename: "MoneyV2", amount: "5.0" } },
        { __typename: "AutomaticDiscountApplication", index: 1, title: "Free-ish shipping", value: { __typename: "PricingPercentageValue", percentage: 10.0 } },
      ] },
    }, parts);
    expect(extras.discountApplications).toEqual([
      { index: 0, kind: "code", code: "MELT5", title: null, valueType: "amount", value: "5", amount: "5" },
      { index: 1, kind: "automatic", code: null, title: "Free-ish shipping", valueType: "percentage", value: "10", amount: "2.5" },
    ]);
    expect(extras).toMatchObject({ discountsTotal: "7.5", fulfilments: null, shippingCharged: null });
  });
  it("only asks for the extra order fields whose parts are on", () => {
    expect(orderExtraFields({ discounts: false, fulfilments: false, fulfilmentOrders: false })).toEqual({ order: "", allocation: "", shippingAllocations: "" });
    const all = orderExtraFields({ discounts: true, fulfilments: true, fulfilmentOrders: true });
    expect(all.order).toContain("discountApplications(first: 10)");
    expect(all.order).toContain("fulfillments(first: 10)");
    expect(all.order).toContain("fulfillmentOrders(first: 5)");
    expect(orderExtraFields({ discounts: false, fulfilments: true, fulfilmentOrders: false }).order).not.toContain("fulfillmentOrders");
  });
});

describe("SPD7-SPD8: gift cards", () => {
  it("keeps at most the last 4 characters, and debits as money off the card", () => {
    expect(lastCharacters("7XQ2")).toBe("7XQ2");
    // Even if Shopify ever sent more, only the last 4 are kept.
    expect(lastCharacters("GLIM-WXYZ-ABCD-7XQ2")).toBe("7XQ2");
    expect(lastCharacters(null)).toBe("????");
    const card = shopifyGiftCardFromGraphql({
      id: "gid://shopify/GiftCard/901",
      lastCharacters: "7XQ2",
      code: "GLIM-WXYZ-ABCD-7XQ2",
      enabled: true,
      expiresOn: "2027-10-01",
      createdAt: "2026-10-01T02:00:00Z",
      initialValue: { amount: "50.0", currencyCode: "NZD" },
      balance: { amount: "30.0", currencyCode: "NZD" },
      transactions: { nodes: [
        { __typename: "GiftCardCreditTransaction", id: "gid://shopify/GiftCardCreditTransaction/1", processedAt: "2026-10-02T00:00:00Z", amount: { amount: "-10.0" } },
        { __typename: "GiftCardDebitTransaction", id: "gid://shopify/GiftCardDebitTransaction/2", processedAt: "2026-10-05T03:00:00Z", amount: { amount: "20.0" } },
        { __typename: "GiftCardCashOutTransaction", id: "gid://shopify/GiftCardCashOutTransaction/3", processedAt: "2026-10-06T03:00:00Z", amount: { amount: "-5" } },
      ], pageInfo: { hasNextPage: false } },
    })!;
    expect(JSON.stringify(card)).not.toContain("GLIM-");
    expect(card).toMatchObject({ externalId: "901", lastCharacters: "7XQ2", initialValue: "50", balance: "30", currency: "NZD", expiresOn: "2027-10-01", enabled: true });
    expect(card.transactions.map((t) => [t.kind, t.amount])).toEqual([["credit", "10"], ["debit", "-20"], ["cash_out", "-5"]]);
  });
});

describe("SPD9: shipments and shipping charged", () => {
  it("reads fulfilments with their first tracking number, and the shipping charged", () => {
    const extras = shopifyOrderExtrasFromGraphql({
      displayFulfillmentStatus: "PARTIALLY_FULFILLED",
      totalShippingPriceSet: { shopMoney: { amount: "6.90", currencyCode: "NZD" } },
      fulfillments: [
        { id: "gid://shopify/Fulfillment/9801", status: "SUCCESS", createdAt: "2026-10-03T20:00:00Z", deliveredAt: null, trackingInfo: [{ company: "NZ Post", number: "NZ123" }, { company: "Other", number: "X" }] },
        { id: "gid://shopify/Fulfillment/9802", status: "CANCELLED", createdAt: "2026-10-03T21:00:00Z", trackingInfo: [] },
      ],
      fulfillmentOrders: { nodes: [{ status: "IN_PROGRESS" }] },
    }, { discounts: false, fulfilments: true, fulfilmentOrders: true });
    expect(extras).toMatchObject({ fulfilmentStatus: "PARTIALLY_FULFILLED", shippingCharged: "6.9", fulfilmentOrderStatuses: ["IN_PROGRESS"], discountApplications: null });
    expect(extras.fulfilments).toEqual([
      { externalId: "9801", status: "SUCCESS", createdAt: "2026-10-03T20:00:00.000Z", deliveredAt: null, carrier: "NZ Post", trackingNumber: "NZ123" },
      { externalId: "9802", status: "CANCELLED", createdAt: "2026-10-03T21:00:00.000Z", deliveredAt: null, carrier: null, trackingNumber: null },
    ]);
  });
});

describe("SPD11: Shopify in Analytics", () => {
  it("has its own prefix, load key and plain names", () => {
    expect(SHOPIFY_TABLES.every((t) => isShopifyTable(t.table))).toBe(true);
    expect(loadKeyOf("shopify_orders")).toEqual({ tableName: "shopify_*", sourceless: true });
    expect(tableLabel("shopify_gift_cards")).toBe("Shopify gift cards");
    expect(isShopifyTable("tohyee_invoices")).toBe(false);
  });
});

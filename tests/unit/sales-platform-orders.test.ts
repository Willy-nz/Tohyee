import { describe, expect, it } from "vitest";
import { toPlainString } from "@/lib/money/decimal";
import type { PlatformOrder } from "@/lib/sales-platforms/connector";
import {
  type LinkedItem,
  type PostingRules,
  localDate,
  orderPayments,
  planOrder,
  planPayout,
  planRefund,
  splitAmount,
  startOfLocalDate,
  taxCodeFor,
} from "@/lib/sales-platforms/orders";
import {
  shopifyBalanceTransactionFromGraphql,
  shopifyOrderFromGraphql,
  shopifyConnector,
  shopifyPayoutFromGraphql,
} from "@/lib/sales-platforms/shopify";
import {
  balanceTransactionNode,
  order1001,
  order1002,
  order1003,
  order1004,
  orderNode,
  payout70001,
  payout70002,
  type OrderFixture,
  type PayoutFixture,
  payoutNode,
  refund6001,
  type RefundFixture,
  refundNode,
} from "../helpers/fake-shopify-orders";

/** Examples SPC11-SPC17 and SPC23 (docs/ACCOUNTING-EXAMPLES.md): Shopify's records worked out into Tohyee's lines. */

const RULES: PostingRules = {
  baseCurrency: "NZD",
  gstRegistered: true,
  foreignTrade: false,
  exportTaxCode: "EXPORT",
  untaxedTaxCode: "ZERO",
  taxCodes: [{ rate: "0.15", code: "GST", codeRate: "0.15" }],
  salesAccountCode: "4000",
  shippingAccountCode: "4000",
};

/** An order as Tohyee reads it: through the GraphQL parser, with its refunds filled in as fetchOrder does. */
function read(o: OrderFixture, refunds: RefundFixture[] = o.refunds ?? []): PlatformOrder {
  return shopifyOrderFromGraphql({ ...orderNode(o), refunds: refunds.map((r) => refundNode(r)) });
}

function payout(p: PayoutFixture) {
  return { ...shopifyPayoutFromGraphql(payoutNode(p)), transactions: p.transactions.map((t) => shopifyBalanceTransactionFromGraphql(balanceTransactionNode(t))) };
}

const items = (entries: Array<[string, LinkedItem]>) => new Map(entries);
const CANDLE: LinkedItem = { id: "11", code: "CANDLE-L", itemType: "non_stock", incomeAccountCode: null };
const MELTS: LinkedItem = { id: "12", code: "MELT-VAN", itemType: "non_stock", incomeAccountCode: null };
const GIFTBOX: LinkedItem = { id: "13", code: "GIFTBOX", itemType: "stock", incomeAccountCode: "4000" };

describe("New Zealand dates from Shopify's times", () => {
  it("dates instants in NZ time and starts dates at NZ midnight", () => {
    expect(localDate("2026-10-05T22:00:00Z", "Pacific/Auckland")).toBe("2026-10-06");
    expect(localDate("2026-09-30T10:00:00Z", "Pacific/Auckland")).toBe("2026-09-30");
    expect(startOfLocalDate("2026-10-01", "Pacific/Auckland")).toBe("2026-09-30T11:00:00.000Z");
    // Before daylight saving starts (27 Sep 2026), NZST is UTC+12.
    expect(startOfLocalDate("2026-09-01", "Pacific/Auckland")).toBe("2026-08-31T12:00:00.000Z");
  });
});

describe("splitting a line so quantity x price is exact (SPC13)", () => {
  it("splits 22.00 for 3 into 2 x 7.33 and 1 x 7.34", () => {
    expect(splitAmount("22.00", "3")).toEqual([
      { quantity: "2", unitPrice: "7.33" },
      { quantity: "1", unitPrice: "7.34" },
    ]);
    expect(splitAmount("46.00", "2")).toEqual([{ quantity: "2", unitPrice: "23.00" }]);
  });
});

describe("tax codes from Shopify's tax lines (decision 53)", () => {
  it("maps the rate, falls back to the untaxed or export code, and records no GST when not registered", () => {
    expect(taxCodeFor([{ title: "GST", rate: "0.15", amount: "6.00" }], RULES, false, "line")).toEqual({ ok: true, code: "GST", rate: "0.15" });
    expect(taxCodeFor([], RULES, false, "line")).toEqual({ ok: true, code: "ZERO", rate: "0" });
    expect(taxCodeFor([], RULES, true, "line")).toEqual({ ok: true, code: "ZERO", rate: "0" });
    expect(taxCodeFor([], { ...RULES, foreignTrade: true }, true, "line")).toEqual({ ok: true, code: "EXPORT", rate: "0" });
    expect(taxCodeFor([{ title: "GST", rate: "0.15", amount: "6.00" }], { ...RULES, gstRegistered: false }, false, "line")).toEqual({ ok: true, code: null, rate: null });
    expect(taxCodeFor([{ title: "VAT", rate: "0.2", amount: "1.00" }], RULES, false, "line")).toMatchObject({
      ok: false,
      reason: "line has Shopify's 20% tax, which isn't matched to a Tohyee tax code in the connection's settings.",
    });
  });
});

describe("orders (SPC11-SPC13, SPC16, SPC17, SPC23)", () => {
  it("SPC11: a taxes-included order is 2 x 23.00 GST, tax inclusive", () => {
    const order = read(order1001());
    expect(order).toMatchObject({ externalId: "5001", name: "#1001", taxesIncluded: true, total: "46", financialStatus: "PAID", billingCountry: "NZ" });
    expect(order.customer).toMatchObject({ externalId: "1001", country: "NZ" });
    const plan = planOrder(order, RULES, items([["3001", CANDLE]]), false);
    expect(plan).toEqual({
      ok: true,
      amountsMode: "inclusive",
      total: "46.00",
      notes: [],
      lines: [{ description: "Large candle", quantity: "2", unitPrice: "23.00", accountCode: "4000", taxCode: "GST", itemId: "11" }],
    });
    expect(orderPayments(order)).toMatchObject({ lastAt: "2026-10-02T01:30:00.000Z", giftCard: false });
    expect(toPlainString(orderPayments(order).amount)).toBe("46");
  });

  it("SPC12: a non-GST-registered organisation records no tax, and says so when Shopify charged some", () => {
    const rules = { ...RULES, gstRegistered: false };
    const untaxed = planOrder(read(order1001({ lines: [{ ...order1001().lines[0], tax: [] }] })), rules, items([]), false);
    expect(untaxed).toMatchObject({ ok: true, amountsMode: "no_tax", total: "46.00", notes: [] });
    expect(untaxed.ok && untaxed.lines).toEqual([{ description: "Large candle", quantity: "2", unitPrice: "23.00", accountCode: "4000", taxCode: null, itemId: null }]);
    const taxed = planOrder(read(order1001()), rules, items([]), false);
    expect(taxed).toMatchObject({
      ok: true,
      total: "46.00",
      notes: ['#1001 line "Large candle": Shopify charged 6.00 tax; it\'s part of the sale because the organisation isn\'t GST registered.'],
    });
  });

  it("SPC13: a discount splits the line, and shipping is its own line", () => {
    const plan = planOrder(read(order1002()), RULES, items([["3002", MELTS]]), false);
    expect(plan).toEqual({
      ok: true,
      amountsMode: "inclusive",
      total: "28.90",
      notes: [],
      lines: [
        { description: "Wax melts - Vanilla", quantity: "2", unitPrice: "7.33", accountCode: "4000", taxCode: "GST", itemId: "12" },
        { description: "Wax melts - Vanilla", quantity: "1", unitPrice: "7.34", accountCode: "4000", taxCode: "GST", itemId: "12" },
        { description: "Shipping: NZ Post standard", quantity: "1", unitPrice: "6.90", accountCode: "4000", taxCode: "GST", itemId: null },
      ],
    });
  });

  it("logs Tohyee's GST when it differs from Shopify's tax line", () => {
    const order = order1002({ lines: [{ ...order1002().lines[0], tax: [{ title: "GST", rate: 0.15, amount: "2.86" }] }], total: "28.90" });
    const plan = planOrder(read(order), RULES, items([]), false);
    expect(plan).toMatchObject({
      ok: true,
      notes: ['#1002 line "Wax melts - Vanilla": Tohyee works out GST of 2.87 (per line, as on every invoice); Shopify\'s tax line says 2.86.'],
    });
  });

  it("SPC16: an overseas customer's untaxed line is ZERO, or EXPORT with Foreign trade on", () => {
    const order = read(order1003());
    expect(order.customer).toMatchObject({ externalId: "1005", country: "AU" });
    expect(planOrder(order, RULES, items([]), true)).toMatchObject({ ok: true, total: "23.00", lines: [{ taxCode: "ZERO", unitPrice: "23.00" }] });
    expect(planOrder(order, { ...RULES, foreignTrade: true }, items([]), true)).toMatchObject({ ok: true, total: "23.00", lines: [{ taxCode: "EXPORT" }] });
  });

  it("SPC17: a linked stock item is carried on the line, at its income account", () => {
    expect(planOrder(read(order1004()), RULES, items([["3004", GIFTBOX]]), false)).toMatchObject({
      ok: true,
      total: "34.50",
      lines: [{ description: "Gift box", quantity: "1", unitPrice: "34.50", accountCode: "4000", taxCode: "GST", itemId: "13" }],
    });
  });

  it("SPC23: refuses what it can't post exactly", () => {
    const refusal = (order: OrderFixture, rules = RULES) => {
      const plan = planOrder(read(order), rules, items([]), false);
      return plan.ok ? null : plan.reason;
    };
    expect(refusal(order1001({ test: true }))).toBe("#1001 is a test order, so it isn't brought in.");
    expect(refusal(order1001({ currency: "AUD" }))).toBe("#1001 is in AUD; Tohyee only brings in orders in NZD.");
    expect(refusal(order1001({ presentmentCurrency: "USD" }))).toBe("#1001 was paid in USD; Tohyee only brings in orders in NZD.");
    expect(refusal(order1001({ lines: [{ ...order1001().lines[0], giftCard: true }] }))).toBe("#1001 sells a gift card; gift cards aren't supported yet.");
    expect(refusal(order1001({ total: "50.00" }))).toBe(
      "#1001's lines come to 46.00 in Tohyee but Shopify's order total is 50.00 (tips, duties or other charges aren't supported yet), so it isn't brought in.",
    );
    expect(refusal(order1001(), { ...RULES, taxCodes: [] })).toBe(
      "#1001 line \"Large candle\" has Shopify's 15% tax, which isn't matched to a Tohyee tax code in the connection's settings.",
    );
    const big = shopifyOrderFromGraphql({ ...orderNode(order1001()), lineItems: { ...orderNode(order1001()).lineItems, pageInfo: { hasNextPage: true } } });
    expect(planOrder(big, RULES, items([]), false)).toEqual({ ok: false, reason: "#1001 has more than 50 lines; orders that big aren't supported yet." });
    // A gift card payment.
    const giftCard = read(order1001({ transactions: [{ id: 1, kind: "SALE", gateway: "gift_card", amount: "46.00", processedAt: "2026-10-02T01:30:00Z" }] }));
    expect(orderPayments(giftCard).giftCard).toBe(true);
  });
});

describe("refunds (SPC14)", () => {
  it("credits 1 x 23.00 GST on 6 Oct for a 23.00 refund", () => {
    const order = read(order1001({ financialStatus: "PARTIALLY_REFUNDED", refunds: [refund6001()] }));
    expect(order.refunds).toHaveLength(1);
    const plan = planRefund(order, order.refunds[0], RULES, items([["3001", CANDLE]]), false);
    expect(plan).toEqual({
      ok: true,
      date: "2026-10-06",
      total: "23.00",
      refunded: "23.00",
      lines: [{ description: "Large candle", quantity: "1", unitPrice: "23.00", accountCode: "4000", taxCode: "GST", itemId: "11" }],
    });
  });

  it("refuses a refund whose lines don't add up to the money returned, or with an order adjustment", () => {
    const short = read(order1001({ refunds: [refund6001({ transactions: [{ id: 9102, kind: "REFUND", amount: "20.00", processedAt: "2026-10-05T22:00:00Z" }] })] }));
    expect(planRefund(short, short.refunds[0], RULES, items([]), false)).toEqual({
      ok: false,
      reason: "#1001's refund 6001's lines come to 23.00 but Shopify refunded 20.00, so nothing was posted.",
    });
    const adjusted = read(order1001({ refunds: [refund6001({ adjustments: 1 })] }));
    expect(planRefund(adjusted, adjusted.refunds[0], RULES, items([]), false)).toMatchObject({ ok: false });
    const nothing = read(order1001({ refunds: [refund6001({ transactions: [] })] }));
    expect(planRefund(nothing, nothing.refunds[0], RULES, items([]), false)).toEqual({ ok: "nothing", reason: "#1001's refund 6001 returned no money, so there's nothing to post." });
  });

  it("a stock item not restocked is credited without the item; restocked, with it", () => {
    const order = read(order1004({ refunds: [{ id: 6004, processedAt: "2026-10-10T00:00:00Z", lines: [{ lineId: 4004, quantity: 1, subtotal: "34.50", tax: "4.50" }], transactions: [{ id: 9104, kind: "REFUND", amount: "34.50", processedAt: "2026-10-10T00:00:00Z" }] }] }));
    expect(planRefund(order, order.refunds[0], RULES, items([["3004", GIFTBOX]]), false)).toMatchObject({ ok: true, lines: [{ itemId: null }] });
    const restocked = read(order1004({ refunds: [{ id: 6004, processedAt: "2026-10-10T00:00:00Z", lines: [{ lineId: 4004, quantity: 1, restocked: true, subtotal: "34.50", tax: "4.50" }], transactions: [{ id: 9104, kind: "REFUND", amount: "34.50", processedAt: "2026-10-10T00:00:00Z" }] }] }));
    expect(planRefund(restocked, restocked.refunds[0], RULES, items([["3004", GIFTBOX]]), false)).toMatchObject({ ok: true, lines: [{ itemId: "13" }] });
  });
});

describe("payouts (SPC15)", () => {
  it("70001: transfer 49.38, fees 2.52, on 7 Oct", () => {
    expect(planPayout(payout(payout70001()), "NZD")).toEqual({
      ok: true,
      date: "2026-10-07",
      net: "49.38",
      charges: [{ description: "Shopify Payments fees, payout 70001", amount: "2.52" }],
    });
  });

  it("70002: transfer 17.33, fees 0.67 and the adjustment 5.00 as their own lines", () => {
    expect(planPayout(payout(payout70002()), "NZD")).toEqual({
      ok: true,
      date: "2026-10-14",
      net: "17.33",
      charges: [
        { description: "Shopify Payments fees, payout 70002", amount: "0.67" },
        { description: "Shopify adjustment: Shopify adjustment, payout 70002", amount: "5.00" },
      ],
    });
  });

  it("refuses chargebacks, withdrawals and transactions that don't add up", () => {
    const chargeback = payout70001({ transactions: [...payout70001().transactions, { id: 80009, type: "CHARGEBACK", amount: "-10.00", fee: "0.00", net: "-10.00" }], net: "39.38" });
    expect(planPayout(payout(chargeback), "NZD")).toEqual({
      ok: false,
      reason: "Payout 70001 has chargeback transactions; only charges, refunds and adjustments are posted, so record this payout by hand.",
    });
    expect(planPayout(payout(payout70001({ net: "50.00" })), "NZD")).toEqual({
      ok: false,
      reason: "Payout 70001's transactions come to 49.38 but the payout is 50.00, so nothing was posted.",
    });
    expect(planPayout(payout(payout70001({ direction: "WITHDRAWAL" })), "NZD")).toMatchObject({ ok: false });
  });
});

describe("order webhooks (SPC18)", () => {
  it("only says which order changed", () => {
    expect(shopifyConnector.webhookRecords("orders/paid", { id: 5001, name: "#1001" })).toEqual({ kind: "order", orderId: "5001" });
    expect(shopifyConnector.webhookRecords("refunds/create", { id: 6001, order_id: 5001 })).toEqual({ kind: "order", orderId: "5001" });
  });
});

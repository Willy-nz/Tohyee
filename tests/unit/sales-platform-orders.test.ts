import { describe, expect, it } from "vitest";
import { dec, toPlainString } from "@/lib/money/decimal";
import type { PlatformOrder } from "@/lib/sales-platforms/connector";
import {
  type LinkedItem,
  type PostingRules,
  localDate,
  oldestFirst,
  orderPayments,
  paymentGateway,
  planOrder,
  planPayout,
  planRefund,
  splitAmount,
  startOfLocalDate,
  SHOPIFY_PAYMENTS_GATEWAY,
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
  payout70003,
  payout70004,
  payout70005,
  payout70006,
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
      direction: "deposit",
      charges: [{ description: "Shopify Payments fees, payout 70001", amount: "2.52", account: "fees" }],
      receipts: [],
      reserveHeld: null,
      reserveReleased: null,
    });
  });

  it("70002: transfer 17.33, fees 0.67 and the adjustment 5.00 as their own lines", () => {
    expect(planPayout(payout(payout70002()), "NZD")).toEqual({
      ok: true,
      date: "2026-10-14",
      net: "17.33",
      direction: "deposit",
      charges: [
        { description: "Shopify Payments fees, payout 70002", amount: "0.67", account: "fees" },
        { description: "Shopify adjustment: Shopify adjustment, payout 70002", amount: "5.00", account: "fees" },
      ],
      receipts: [],
      reserveHeld: null,
      reserveReleased: null,
    });
  });

  it("refuses other types, withdrawals and transactions that don't add up", () => {
    const hold = payout70001({ transactions: [...payout70001().transactions, { id: 80009, type: "CHARGEBACK_HOLD", amount: "-10.00", fee: "0.00", net: "-10.00" }], net: "39.38" });
    expect(planPayout(payout(hold), "NZD")).toEqual({
      ok: false,
      reason:
        "Payout 70001 has transactions of a type Tohyee doesn't post (CHARGEBACK_HOLD); only charges, refunds, adjustments, chargebacks, reserves and the payout's own transfer are posted, so record this payout by hand.",
    });
    expect(planPayout(payout(payout70001({ net: "50.00" })), "NZD")).toEqual({
      ok: false,
      reason: "Payout 70001's transactions come to 49.38 but the payout is 50.00, so nothing was posted.",
    });
    // A withdrawal whose transactions add up to money paid out doesn't add up.
    expect(planPayout(payout(payout70001({ direction: "WITHDRAWAL" })), "NZD")).toEqual({
      ok: false,
      reason: "Payout 70001's transactions come to 49.38 but the payout is -49.38, so nothing was posted.",
    });
  });
});

describe("the payout's own transfer and withdrawals (SPC38-SPC40)", () => {
  /** As a live store sends it: the payout's own TRANSFER row, the payout the other way round. */
  const withTransfer = (fixture: PayoutFixture, amount: string, fee = "0.00") => ({
    ...fixture,
    transactions: [...fixture.transactions, { id: 89999, type: "TRANSFER", amount, fee, net: toPlainString(dec(amount)) }],
  });

  it("SPC38: the TRANSFER row is the payout itself, not a line: 70001 posts as before", () => {
    const plan = planPayout(payout(withTransfer(payout70001(), "-49.38")), "NZD");
    expect(plan).toEqual(planPayout(payout(payout70001()), "NZD"));
    expect(plan).toMatchObject({ ok: true, net: "49.38", direction: "deposit", charges: [{ amount: "2.52", account: "fees" }] });
    // With a chargeback and a reserve too.
    expect(planPayout(payout(withTransfer(payout70005(), "-87.10")), "NZD")).toMatchObject({ ok: true, net: "87.10", reserveHeld: "10.00" });
  });

  it("SPC38: a transfer row that isn't the payout, two of them, or one with a fee, stops the payout with the reason", () => {
    expect(planPayout(payout(withTransfer(payout70001(), "-40.00")), "NZD")).toEqual({
      ok: false,
      reason: "Payout 70001's transfer rows come to -40.00, but Tohyee expects one transfer of -49.38 for this payout, so record this payout by hand.",
    });
    const twice = withTransfer(withTransfer(payout70001(), "-20.00"), "-29.38");
    expect(planPayout(payout(twice), "NZD")).toMatchObject({ ok: false, reason: expect.stringContaining("expects one transfer of -49.38") });
    expect(planPayout(payout(withTransfer(payout70001(), "-49.38", "0.50")), "NZD")).toMatchObject({ ok: false, reason: expect.stringContaining("transfer has a fee of 0.50") });
    // A genuinely unknown type still stops it.
    const unknown = withTransfer(payout70001({ net: "39.38", transactions: [...payout70001().transactions, { id: 80020, type: "SHOP_CASH_CREDIT", amount: "-10.00", fee: "0.00", net: "-10.00" }] }), "-39.38");
    expect(planPayout(payout(unknown), "NZD")).toMatchObject({ ok: false, reason: expect.stringContaining("(SHOP_CASH_CREDIT)") });
  });

  it("SPC40: a withdrawal takes 30.80 from the bank: a refund of 50.00 less a charge of 20.00 with its 0.80 fee", () => {
    const withdrawal: PayoutFixture = {
      id: 70010,
      issuedAt: "2026-10-28T03:00:00Z",
      status: "PAID",
      direction: "WITHDRAWAL",
      net: "30.80",
      transactions: [
        { id: 80030, type: "REFUND", amount: "-50.00", fee: "0.00", net: "-50.00", orderName: "#1020" },
        { id: 80031, type: "CHARGE", amount: "20.00", fee: "0.80", net: "19.20", orderName: "#1021" },
        { id: 80032, type: "TRANSFER", amount: "30.80", fee: "0.00", net: "30.80" },
      ],
    };
    expect(planPayout(payout(withdrawal), "NZD")).toEqual({
      ok: true,
      date: "2026-10-28",
      net: "30.80",
      direction: "withdrawal",
      charges: [{ description: "Shopify Payments fees, payout 70010", amount: "0.80", account: "fees" }],
      receipts: [],
      reserveHeld: null,
      reserveReleased: null,
    });
    // Shopify may give a withdrawal's net as negative: the same plan.
    expect(planPayout(payout({ ...withdrawal, net: "-30.80" }), "NZD")).toMatchObject({ ok: true, net: "30.80", direction: "withdrawal" });
    // Its transfer must be money into the balance.
    expect(planPayout(payout({ ...withdrawal, transactions: [...withdrawal.transactions.slice(0, 2), { id: 80032, type: "TRANSFER", amount: "-30.80", fee: "0.00", net: "-30.80" }] }), "NZD")).toMatchObject({ ok: false });
  });
});

describe("payment gateways (SPC42-SPC46)", () => {
  const paid = (gateway: string, id = 9001) => ({ id, kind: "SALE", gateway, amount: "46.00", processedAt: "2026-10-02T01:30:00Z" });
  it("the gateway of the order's successful payments; split payments are refused; nothing paid is null", () => {
    expect(paymentGateway(read(order1001({ transactions: [paid("afterpay")] })))).toEqual({ ok: true, gateway: "afterpay" });
    expect(paymentGateway(read(order1001()))).toEqual({ ok: true, gateway: SHOPIFY_PAYMENTS_GATEWAY });
    expect(paymentGateway(read(order1001({ transactions: [{ ...paid("paypal"), status: "FAILURE" }, paid("manual", 9002)] })))).toEqual({ ok: true, gateway: "manual" });
    expect(paymentGateway(read(order1001({ transactions: [{ ...paid("paypal"), amount: "20.00" }, { ...paid("afterpay", 9002), amount: "26.00" }] })))).toEqual({
      ok: false,
      reason: "#1001 was paid through more than one payment method (paypal, afterpay); split payments aren't supported yet, so it isn't invoiced.",
    });
    expect(paymentGateway(read(order1001({ transactions: [] })))).toEqual({ ok: true, gateway: null });
  });
});

describe("chargebacks and reserves (SPC25-SPC31)", () => {
  it("SPC25 70003: the chargeback to the chargebacks account, its fee to fees, 13.03 paid out", () => {
    expect(planPayout(payout(payout70003()), "NZD")).toEqual({
      ok: true,
      date: "2026-10-21",
      net: "13.03",
      direction: "deposit",
      charges: [
        { description: "Shopify Payments fees, payout 70003", amount: "2.07", account: "fees" },
        { description: "Chargeback on #1002, payout 70003", amount: "28.90", account: "chargebacks" },
        { description: "Chargeback fee on #1002, payout 70003", amount: "25.00", account: "fees" },
      ],
      receipts: [],
      reserveHeld: null,
      reserveReleased: null,
    });
  });

  it("SPC26 70004: the won dispute and the fee given back come in; 76.23 paid out", () => {
    expect(planPayout(payout(payout70004()), "NZD")).toEqual({
      ok: true,
      date: "2026-11-04",
      net: "76.23",
      direction: "deposit",
      charges: [{ description: "Shopify Payments fees, payout 70004", amount: "0.67", account: "fees" }],
      receipts: [
        { description: "Chargeback won on #1002, payout 70004", amount: "28.90", account: "chargebacks" },
        { description: "Chargeback fee given back on #1002, payout 70004", amount: "25.00", account: "fees" },
      ],
      reserveHeld: null,
      reserveReleased: null,
    });
  });

  it("SPC28 and SPC29: 10.00 held in reserve, then released", () => {
    expect(planPayout(payout(payout70005()), "NZD")).toMatchObject({ ok: true, net: "87.10", reserveHeld: "10.00", reserveReleased: null, receipts: [] });
    expect(planPayout(payout(payout70006()), "NZD")).toMatchObject({ ok: true, date: "2027-03-11", net: "54.62", reserveHeld: null, reserveReleased: "10.00" });
  });

  it("SPC31: refuses a chargeback or reserve with the sign the other way, and types Shopify doesn't explain", () => {
    const positive = payout70003({ transactions: [payout70003().transactions[0], { id: 80007, type: "DISPUTE_WITHDRAWAL", amount: "28.90", fee: "0.00", net: "28.90" }], net: "95.83" });
    expect(planPayout(payout(positive), "NZD")).toEqual({
      ok: false,
      reason: "Payout 70003 has a dispute_withdrawal transaction of 28.90; Tohyee expects it to be negative, so record this payout by hand.",
    });
    const released = payout70006({ transactions: [{ id: 80014, type: "RESERVED_FUNDS_REVERSAL", amount: "-10.00", fee: "0.00", net: "-10.00" }, payout70006().transactions[1]], net: "34.62" });
    expect(planPayout(payout(released), "NZD")).toMatchObject({ ok: false });
    for (const type of ["CHARGEBACK_HOLD_RELEASE", "RESERVED_FUNDS_WITHDRAWAL"]) {
      const other = payout70005({ transactions: [payout70005().transactions[0], { id: 80013, type, amount: "-10.00", fee: "0.00", net: "-10.00" }] });
      expect(planPayout(payout(other), "NZD")).toMatchObject({ ok: false });
    }
  });
});

describe("order webhooks (SPC18)", () => {
  it("only says which order changed", () => {
    expect(shopifyConnector.webhookRecords("orders/paid", { id: 5001, name: "#1001" })).toEqual({ kind: "order", orderId: "5001" });
    expect(shopifyConnector.webhookRecords("refunds/create", { id: 6001, order_id: 5001 })).toEqual({ kind: "order", orderId: "5001" });
  });
});

describe("Shopify Admin API 2026-10 checks (decision 665)", () => {
  it("leaves out a balance transaction that says it belongs to another payout", async () => {
    const { setSalesPlatformFetchForTests } = await import("@/lib/sales-platforms/http");
    const answers = [
      { data: { shopifyPaymentsAccount: { payouts: { nodes: [payoutNode({ id: 70001, issuedAt: "2026-10-07T03:00:00Z", status: "PAID", net: "44.62", transactions: [] })], pageInfo: { hasNextPage: false } } } } },
      {
        data: {
          shopifyPaymentsAccount: {
            balanceTransactions: {
              nodes: [
                balanceTransactionNode({ id: 1, type: "CHARGE", amount: "46.00", fee: "1.38", net: "44.62", orderName: "#1001" }, "NZD", 70001),
                balanceTransactionNode({ id: 2, type: "CHARGE", amount: "23.00", fee: "0.67", net: "22.33", orderName: "#1003" }, "NZD", 70002),
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    ];
    setSalesPlatformFetchForTests(async () => new Response(JSON.stringify(answers.shift()), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const context = { storeDomain: "glimmers.myshopify.com", credentials: { accessToken: "shpat_x" }, cachedToken: null, now: new Date() };
      const result = await shopifyConnector.fetchPayouts(context, { token: "shpat_x", expiresAt: null }, { issuedFrom: "2026-10-01T00:00:00Z", alreadyPosted: () => false });
      expect(result.payouts[0].transactions.map((t) => t.externalId)).toEqual(["1"]);
    } finally {
      setSalesPlatformFetchForTests(null);
    }
  });

  it("says what to turn on when Shopify withholds protected customer data", async () => {
    const { setSalesPlatformFetchForTests } = await import("@/lib/sales-platforms/http");
    setSalesPlatformFetchForTests(
      async () =>
        new Response(JSON.stringify({ data: { customers: { nodes: [{ id: "gid://shopify/Customer/1", defaultEmailAddress: null }] } }, errors: [{ message: "This app is not approved to access the Customer object." }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      const context = { storeDomain: "glimmers.myshopify.com", credentials: { accessToken: "shpat_x" }, cachedToken: null, now: new Date() };
      await expect(
        shopifyConnector.fetchChanges(context, { token: "shpat_x", expiresAt: null }, { customers: true, products: false, customersSince: null, productsSince: null }),
      ).rejects.toThrow("turn on access to protected customer data for name, email, phone and address");
    } finally {
      setSalesPlatformFetchForTests(null);
    }
  });

  it("subscribes webhooks with uri, not the deprecated callbackUrl", async () => {
    const { setSalesPlatformFetchForTests } = await import("@/lib/sales-platforms/http");
    const sent: Array<Record<string, unknown>> = [];
    setSalesPlatformFetchForTests(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)).variables.webhookSubscription);
      return new Response(JSON.stringify({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: `gid://shopify/WebhookSubscription/${sent.length}` }, userErrors: [] } } }), { status: 200 });
    });
    try {
      const context = { storeDomain: "glimmers.myshopify.com", credentials: { accessToken: "shpat_x" }, cachedToken: null, now: new Date() };
      const ids = await shopifyConnector.registerWebhooks(context, { token: "shpat_x", expiresAt: null }, "https://books.example.nz/hook");
      expect(ids).toHaveLength(4);
      expect(sent[0]).toEqual({ uri: "https://books.example.nz/hook", format: "JSON" });
    } finally {
      setSalesPlatformFetchForTests(null);
    }
  });
});

describe("posting order (decision 1341)", () => {
  it("posts orders oldest first, whatever order the store listed them in", () => {
    const order = (externalId: string, name: string, processedAt: string) => ({ externalId, name, processedAt });
    const listed = [
      order("5003", "#1003", "2026-09-20T01:00:00Z"),
      order("5001", "#1001", "2026-09-11T01:00:00Z"),
      order("5010", "#1010", "2026-09-25T01:00:00Z"),
      order("5002", "#1002", "2026-09-11T01:00:00Z"),
      order("5009", "#999", "2026-09-11T01:00:00Z"),
    ];
    expect(oldestFirst(listed).map((o) => o.name)).toEqual(["#999", "#1001", "#1002", "#1003", "#1010"]);
    // A copy: what the store sent is left as it was.
    expect(listed[0].name).toBe("#1003");
  });
});

describe("an order's customer with no name (decision 1336)", () => {
  const nameless = { id: 1301, first: "", last: "", email: "pip@made-up.test", updatedAt: "2026-10-01T00:00:00Z" };
  it("uses the billing name, then the shipping name, before the email", () => {
    expect(read(order1001({ customer: nameless, billingName: { first: " Pip ", last: "Rua  Rua" } })).customer).toMatchObject({
      externalId: "1301",
      name: "Pip Rua Rua",
      nameIsFallback: false,
      email: "pip@made-up.test",
    });
    expect(read(order1001({ customer: nameless, billingName: { first: null, last: null }, shippingName: { first: "Pip", last: null } })).customer).toMatchObject({
      name: "Pip",
      nameIsFallback: false,
    });
    expect(read(order1001({ customer: nameless })).customer).toMatchObject({ name: "pip@made-up.test", nameIsFallback: true });
  });
  it("keeps the customer's own name over the address's", () => {
    expect(read(order1001({ customer: { ...nameless, first: "Pippa", last: "Rua" }, billingName: { first: "Someone", last: "Else" } })).customer).toMatchObject({
      name: "Pippa Rua",
    });
  });
});

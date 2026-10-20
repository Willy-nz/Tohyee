import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planPayout } from "@/lib/sales-platforms/orders";
import {
  SQUARE_API_VERSION,
  isReturnOrder,
  squareConnector,
  squareMoney,
  squareOrderFrom,
  squarePayoutFrom,
  verifySquareWebhook,
} from "@/lib/sales-platforms/square";
import { AROHA, cardPayment, cardSale, entryNode, orderNode, paymentNode, payoutNode, refundNode } from "../helpers/fake-square";

/** The Square connector's pure parts (SQ1-SQ10). Square-shaped data written from Square's API reference, not recorded. */
describe("Square amounts", () => {
  it("turns cents into two-place amounts without floating point", () => {
    expect(squareMoney({ amount: 4600, currency: "NZD" })).toBe("46.00");
    expect(squareMoney({ amount: -2300, currency: "NZD" })).toBe("-23.00");
    expect(squareMoney({ amount: 1, currency: "NZD" })).toBe("0.01");
    expect(squareMoney({ amount: 500, currency: "JPY" })).toBe("500.00");
    expect(squareMoney(undefined)).toBe("0.00");
    expect(() => squareMoney({ amount: 4.6, currency: "NZD" })).toThrow("whole number of cents");
  });

  it("uses Square-Version 2026-09-16", () => {
    expect(SQUARE_API_VERSION).toBe("2026-09-16");
  });
});

describe("Square orders (SQ2-SQ6, SQ10)", () => {
  const extras = (payments = [cardPayment]) => ({
    customer: { id: AROHA.id, given_name: "Aroha", family_name: "Ngata", email_address: AROHA.email, address: { country: "NZ" } },
    skus: new Map([["VAR-CANDLE", "CANDLE-L"]]),
    payments: new Map(payments.map((p) => [p.id, paymentNode(p)])),
    refunds: [] as unknown[],
    returnOrders: new Map<string, unknown>(),
  });

  it("reads an inclusive-tax card sale: paid through Square, its line by SKU (SQ2)", () => {
    const order = squareOrderFrom(orderNode(cardSale()), extras());
    expect(order).toMatchObject({
      externalId: "O-2001",
      name: "#R2001",
      taxesIncluded: true,
      currency: "NZD",
      total: "46.00",
      financialStatus: "PAID",
      paymentMethod: { id: "square", clearing: true },
      customer: { name: "Aroha Ngata", email: AROHA.email, country: "NZ" },
      incomplete: null,
    });
    expect(order.lines).toEqual([
      { externalId: "LI-1", variantId: "CANDLE-L", sku: "CANDLE-L", name: "Large candle", quantity: "2", originalTotal: "46.00", discount: "0.00", taxLines: [{ title: "GST", rate: "0.15", amount: "6.00" }], isGiftCard: false },
    ]);
    expect(order.transactions).toEqual([{ externalId: "P-2001", kind: "SALE", status: "SUCCESS", gateway: "card", amount: "46.00", currency: "NZD", processedAt: "2026-10-03T01:00:30.000Z", test: false }]);
  });

  it("takes added-on tax off a line's total (SQ3) and keeps a discount beside it (SQ4)", () => {
    const additive = squareOrderFrom(orderNode(cardSale({ taxType: "ADDITIVE", lines: [{ uid: "L", name: "Large candle", quantity: "1", total: 2300, tax: 300, discount: 200 }], total: 2300 })), extras());
    expect(additive.taxesIncluded).toBe(false);
    expect(additive.lines[0]).toMatchObject({ originalTotal: "22.00", discount: "2.00", sku: null });
  });

  it("isn't paid until Square has completed its payments, and a cancelled order is voided", () => {
    expect(squareOrderFrom(orderNode(cardSale({ state: "OPEN" })), extras([{ ...cardPayment, status: "APPROVED" }])).financialStatus).toBe("PENDING");
    const cancelled = squareOrderFrom(orderNode(cardSale({ state: "CANCELED", updatedAt: "2026-10-03T05:00:00Z" })), extras());
    expect(cancelled).toMatchObject({ financialStatus: "VOIDED", cancelledAt: "2026-10-03T05:00:00.000Z" });
  });

  it("maps cash to its own payment method and refuses a split (SQ5)", () => {
    const cash = squareOrderFrom(orderNode(cardSale({ tenders: [{ id: "T", type: "CASH", paymentId: "P-2001", amount: 4600 }] })), extras());
    expect(cash.paymentMethod).toEqual({ id: "cash", title: "Cash" });
    const split = squareOrderFrom(
      orderNode(cardSale({ tenders: [{ id: "T1", type: "CARD", paymentId: "P-2001", amount: 2000 }, { id: "T2", type: "THIRD_PARTY_CARD", paymentId: "P-2", amount: 2600 }] })),
      extras(),
    );
    expect(split.incomplete).toBe("was paid in more than one way (card, third party card); split payments like that aren't supported yet.");
  });

  it("reads an itemised refund's lines from its return order, and one return order's refunds as one refund (SQ6)", () => {
    const returnOrder = orderNode({
      id: "RO-1",
      createdAt: "2026-10-05T22:00:00Z",
      lines: [],
      taxType: "INCLUSIVE",
      tenders: [],
      total: 0,
      returns: { sourceOrderId: "O-2001", lines: [{ uid: "RL-1", sourceUid: "LI-1", quantity: "1", total: 2300, tax: 300 }] },
    });
    expect(isReturnOrder(returnOrder)).toBe(true);
    const order = squareOrderFrom(orderNode(cardSale()), {
      ...extras(),
      refunds: [
        refundNode({ id: "R-1", paymentId: "P-2001", orderId: "RO-1", status: "COMPLETED", amount: 2000, createdAt: "2026-10-05T22:00:00Z" }),
        refundNode({ id: "R-2", paymentId: "P-2001", orderId: "RO-1", status: "COMPLETED", amount: 300, createdAt: "2026-10-05T22:01:00Z" }),
        // Not finished yet: left for a later sync.
        refundNode({ id: "R-3", paymentId: "P-2001", orderId: "RO-2", status: "PENDING", amount: 100, createdAt: "2026-10-05T22:02:00Z" }),
      ],
      returnOrders: new Map([["RO-1", returnOrder]]),
    });
    expect(order.refunds).toHaveLength(1);
    expect(order.refunds[0]).toMatchObject({
      externalId: "RO-1",
      processedAt: "2026-10-05T22:00:00.000Z",
      lines: [{ lineItemId: "LI-1", quantity: "1", subtotal: "23.00", tax: "3.00", restocked: false }],
      incomplete: false,
    });
    expect(order.refunds[0].transactions.map((t) => [t.externalId, t.amount])).toEqual([
      ["R-1", "20.00"],
      ["R-2", "3.00"],
    ]);
  });

  it("names what it can't post yet (SQ10)", () => {
    const problem = (overrides: Parameters<typeof cardSale>[0]) => squareOrderFrom(orderNode(cardSale(overrides)), extras()).incomplete;
    expect(problem({ tip: 200, total: 4800 })).toBe("has a tip; tips aren't supported yet, so record it by hand.");
    expect(problem({ serviceCharge: 100, total: 4700 })).toBe("has a service charge; service charges aren't supported yet, so record it by hand.");
    expect(problem({ lines: [{ uid: "L", name: "Beeswax", quantity: "0.5", total: 4600, tax: 600 }] })).toContain("by measure");
    const mixed = orderNode(cardSale());
    (mixed.taxes as unknown[]).push({ uid: "T2", name: "Other", percentage: "5", type: "ADDITIVE" });
    expect(squareOrderFrom(mixed, extras()).incomplete).toBe("has both inclusive and added-on taxes; Tohyee handles one or the other on an order.");
    expect(squareOrderFrom(orderNode(cardSale({ lines: [{ uid: "G", name: "Gift card", quantity: "1", total: 4600, tax: 0, giftCard: true }] })), extras()).lines[0].isGiftCard).toBe(true);
  });
});

describe("Square payouts (SQ7)", () => {
  it("posts charges' fees and refunds like Shopify's, with fee entries as adjustments", () => {
    const payout = squarePayoutFrom(payoutNode({ id: "PO-1", status: "PAID", createdAt: "2026-10-07T03:00:00Z", amount: 4159, entries: [] }), [
      entryNode({ id: "E1", type: "CHARGE", gross: 4600, fee: 81, net: 4519, paymentId: "P-2001" }, "PO-1"),
      entryNode({ id: "E2", type: "FEE", gross: -60, fee: 0, net: -60 }, "PO-1"),
      entryNode({ id: "E3", type: "REFUND", gross: -300, fee: 0, net: -300, paymentId: "P-2001" }, "PO-1"),
    ]);
    expect(payout).toMatchObject({ externalId: "PO-1", status: "PAID", direction: "DEPOSIT", net: "41.59", currency: "NZD" });
    const plan = planPayout(payout, "NZD", "Square");
    expect(plan).toMatchObject({
      ok: true,
      date: "2026-10-07",
      net: "41.59",
      charges: [
        { description: "Square fees, payout PO-1", amount: "0.81", account: "fees" },
        { description: "Square adjustment: Square fee, payout PO-1", amount: "0.60", account: "fees" },
      ],
    });
  });

  it("waits for a payout that's on its way and refuses one with entries Tohyee doesn't post", () => {
    expect(squarePayoutFrom(payoutNode({ id: "PO-2", status: "SENT", createdAt: "2026-10-08T03:00:00Z", amount: 100, entries: [] })).status).toBe("IN_TRANSIT");
    const disputed = squarePayoutFrom(payoutNode({ id: "PO-3", status: "PAID", createdAt: "2026-10-08T03:00:00Z", amount: 0, entries: [] }), [
      entryNode({ id: "E1", type: "CHARGE", gross: 2200, fee: 0, net: 2200 }, "PO-3"),
      entryNode({ id: "E2", type: "DISPUTE", gross: -2200, fee: 0, net: -2200 }, "PO-3"),
    ]);
    const plan = planPayout(disputed, "NZD", "Square");
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toContain("dispute");
    const withdrawal = squarePayoutFrom(payoutNode({ id: "PO-4", status: "PAID", createdAt: "2026-10-08T03:00:00Z", amount: -500, entries: [] }));
    expect(withdrawal).toMatchObject({ direction: "WITHDRAWAL", net: "5.00" });
  });
});

describe("Square webhooks (SQ8)", () => {
  const url = "https://tohyee.example.nz/api/sales-platforms/webhooks/org/key";
  const body = JSON.stringify({ merchant_id: "MLGLIMMERS01", type: "order.updated", event_id: "E-1", data: { object: { order_updated: { order_id: "O-2001" } } } });
  const sign = (text: string, key = "sig-key", address = url) => createHmac("sha256", key).update(address + text).digest("base64");
  const headers = (signature: string) => new Headers({ "x-square-hmacsha256-signature": signature });

  it("checks the signature over the address and the body", () => {
    expect(verifySquareWebhook(body, sign(body), "sig-key", url)).toBe(true);
    expect(verifySquareWebhook(body, sign(body, "other"), "sig-key", url)).toBe(false);
    expect(verifySquareWebhook(body, sign(body, "sig-key", "https://elsewhere.nz/"), "sig-key", url)).toBe(false);
    expect(verifySquareWebhook(body.replace("O-2001", "O-2002"), sign(body), "sig-key", url)).toBe(false);
    expect(verifySquareWebhook(body, null, "sig-key", url)).toBe(false);
    expect(verifySquareWebhook(body, sign(body), "", url)).toBe(false);
  });

  it("takes only this seller's events, by event ID", () => {
    expect(squareConnector.checkWebhook(headers(sign(body)), Buffer.from(body), "sig-key", "mlglimmers01", { webhookUrl: url })).toEqual({ deliveryId: "E-1", topic: "order.updated" });
    expect(squareConnector.checkWebhook(headers(sign(body)), Buffer.from(body), "sig-key", "mlsomeoneelse", { webhookUrl: url })).toBeNull();
    expect(squareConnector.checkWebhook(headers(sign(body)), Buffer.from(body), "sig-key", "mlglimmers01", {})).toBeNull();
  });

  it("finds the order an event is about", () => {
    expect(squareConnector.webhookRecords("order.updated", JSON.parse(body))).toEqual({ kind: "order", orderId: "O-2001" });
    expect(squareConnector.webhookRecords("order.created", { data: { object: { order_created: { order_id: "O-2" } } } })).toEqual({ kind: "order", orderId: "O-2" });
    expect(squareConnector.webhookRecords("payment.updated", { data: { object: { payment: { id: "P", order_id: "O-3" } } } })).toEqual({ kind: "order", orderId: "O-3" });
    expect(squareConnector.webhookRecords("refund.created", { data: { object: { refund: { id: "R", order_id: "RO-1" } } } })).toEqual({ kind: "order", orderId: "RO-1" });
    expect(squareConnector.webhookRecords("customer.created", { data: {} })).toBeNull();
  });
});

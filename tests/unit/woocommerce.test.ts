import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normaliseStoreAddress, woocommerceConnector, wooOrderFrom } from "@/lib/sales-platforms/woocommerce";
import { order2002, wooOrderNode } from "../helpers/fake-woocommerce";

describe("WooCommerce connector (WC1, WC3, WC9)", () => {
  it("takes the store's https address, with or without the scheme or a trailing slash, and refuses http", () => {
    expect(normaliseStoreAddress("https://Shop.Glimmers.nz/")).toBe("shop.glimmers.nz");
    expect(normaliseStoreAddress("shop.glimmers.nz")).toBe("shop.glimmers.nz");
    expect(normaliseStoreAddress("https://example.nz/shop/")).toBe("example.nz/shop");
    expect(() => normaliseStoreAddress("http://shop.glimmers.nz")).toThrow("Use the store's https:// address");
    // Decision 534: only stores on the internet, on the usual port.
    for (const local of ["https://127.0.0.1:8443", "https://192.168.1.1", "10.0.0.1", "https://[::1]/shop", "shop.local", "intranet.internal", "https://169.254.169.254"]) {
      expect(() => normaliseStoreAddress(local)).toThrow(/internet|address, like/);
    }
    expect(() => normaliseStoreAddress("https://shop.glimmers.nz:5432")).toThrow("without a port number");
    expect(normaliseStoreAddress("https://shop.glimmers.nz:8443/")).toBe("shop.glimmers.nz:8443");
    expect(() => woocommerceConnector.parseConnectInput({ storeDomain: "shop.glimmers.nz", consumerKey: "abc", consumerSecret: "cs_x" })).toThrow("The consumer key starts with ck_");
  });

  it("reads an order's amounts before tax, with the coupon in the line and shipping on its own (WC3)", () => {
    const order = wooOrderFrom(wooOrderNode(order2002()));
    expect(order).toMatchObject({ name: "#2002", taxesIncluded: false, total: "28.90", financialStatus: "PAID", paymentMethod: { id: "stripe" } });
    expect(order.lines[0]).toMatchObject({ sku: "MELT-VAN", variantId: "MELT-VAN", originalTotal: "23.48", discount: "4.35", taxLines: [{ rate: "0.15", amount: "2.87" }] });
    expect(order.shipping[0]).toMatchObject({ title: "NZ Post standard", amount: "6.00", taxLines: [{ amount: "0.90" }] });
  });

  it("checks a delivery's signature and store, and answers a ping without one (WC9)", () => {
    const body = Buffer.from(JSON.stringify({ id: 2001 }));
    const headers = (signature: string, source = "https://shop.glimmers.nz/") =>
      new Headers({ "x-wc-webhook-signature": signature, "x-wc-webhook-source": source, "x-wc-webhook-topic": "order.updated", "x-wc-webhook-id": "100", "x-wc-webhook-delivery-id": "7" });
    const good = createHmac("sha256", "secret").update(body).digest("base64");
    expect(woocommerceConnector.checkWebhook(headers(good), body, "secret", "shop.glimmers.nz")).toEqual({ deliveryId: "100:7", topic: "order.updated" });
    expect(woocommerceConnector.checkWebhook(headers(good), body, "other", "shop.glimmers.nz")).toBeNull();
    expect(woocommerceConnector.checkWebhook(headers(good, "https://elsewhere.nz/"), body, "secret", "shop.glimmers.nz")).toBeNull();
    expect(woocommerceConnector.isPing!(new Headers(), Buffer.from("webhook_id=100"))).toBe(true);
    expect(woocommerceConnector.isPing!(headers(good), body)).toBe(false);
  });
});

describe("WooCommerce refunds' lines (decision 666)", () => {
  // The same product on two lines (say, one at full price and one on a coupon): only _refunded_item_id says which was refunded.
  const order = {
    id: 2020,
    number: "2020",
    status: "completed",
    currency: "NZD",
    date_created_gmt: "2026-10-02T01:00:00",
    date_paid_gmt: "2026-10-02T01:00:00",
    payment_method: "stripe",
    customer_id: 11,
    billing: { email: "aroha@manukavets.nz", country: "NZ" },
    line_items: [
      { id: 11, product_id: 301, variation_id: 0, sku: "CANDLE-L", name: "Large candle", quantity: 1, subtotal: "20.00", total: "20.00", taxes: [{ id: 1, total: "3.00" }] },
      { id: 12, product_id: 301, variation_id: 0, sku: "CANDLE-L", name: "Large candle", quantity: 1, subtotal: "20.00", total: "15.00", taxes: [{ id: 1, total: "2.25" }] },
    ],
    shipping_lines: [{ id: 13, method_title: "NZ Post", total: "6.00", taxes: [{ id: 1, total: "0.90" }] }],
    tax_lines: [{ rate_id: 1, rate_percent: 15 }],
    total: "47.15",
    refunds: [{ id: 7100, total: "-24.15" }],
  };
  const refund = {
    id: 7100,
    date_created_gmt: "2026-10-05T22:00:00",
    amount: "24.15",
    line_items: [{ id: 95, product_id: 301, variation_id: 0, quantity: -1, total: "-15.00", total_tax: "-2.25", meta_data: [{ id: 1, key: "_refunded_item_id", value: "12" }] }],
    shipping_lines: [{ id: 96, total: "-6.00", total_tax: "-0.90", meta_data: [{ id: 2, key: "_refunded_item_id", value: "13" }] }],
  };

  it("matches each refund line to the order line WooCommerce says it refunds", () => {
    const parsed = wooOrderFrom(order, [refund]);
    expect(parsed.refunds[0].lines).toEqual([{ lineItemId: "12", quantity: "1", restocked: false, subtotal: "15.00", tax: "2.25" }]);
    expect(parsed.refunds[0].shipping).toEqual([{ shippingLineId: "13", subtotal: "6.00", tax: "0.90" }]);
  });

  it("falls back to the product when a refund line doesn't say (older refunds)", () => {
    const parsed = wooOrderFrom(order, [{ ...refund, line_items: [{ ...refund.line_items[0], meta_data: [] }] }]);
    expect(parsed.refunds[0].lines[0].lineItemId).toBe("11");
  });
});

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

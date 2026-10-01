import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { itemNameFor, mergeField, priceCopyable } from "@/lib/sales-platforms/merge";
import {
  normaliseShopDomain,
  SHOPIFY_API_VERSION,
  setSalesPlatformFetchForTests,
  setSalesPlatformSleepForTests,
  shopifyConnector,
  SHOPIFY_SCOPES,
  shopifyCustomerFromGraphql,
  shopifyCustomerFromWebhook,
  shopifyVariantsFromGraphql,
  shopifyVariantsFromWebhook,
  verifyShopifyWebhook,
} from "@/lib/sales-platforms/shopify";

const SECRET = "shpss_test_secret_for_signing";
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body, "utf8").digest("base64");

describe("Shopify webhook signatures (SPC8)", () => {
  const body = JSON.stringify({ id: 1004, email: "mere@example.co.nz", first_name: "Mere", last_name: "Tane" });

  it("accepts the base64 HMAC-SHA256 of the raw body made with the connection's secret", () => {
    expect(verifyShopifyWebhook(body, sign(body), SECRET)).toBe(true);
  });

  it("refuses another secret, a changed body, a missing or malformed signature", () => {
    expect(verifyShopifyWebhook(body, sign(body, "another-secret"), SECRET)).toBe(false);
    expect(verifyShopifyWebhook(body.replace("Mere", "Merv"), sign(body), SECRET)).toBe(false);
    expect(verifyShopifyWebhook(body, null, SECRET)).toBe(false);
    expect(verifyShopifyWebhook(body, "", SECRET)).toBe(false);
    expect(verifyShopifyWebhook(body, "not base64 at all!", SECRET)).toBe(false);
    expect(verifyShopifyWebhook(body, sign(body), "")).toBe(false);
  });

  it("is checked against the bytes as sent (non-ASCII names)", () => {
    const maori = JSON.stringify({ id: 1, first_name: "Mānuka" });
    expect(verifyShopifyWebhook(maori, sign(maori), SECRET)).toBe(true);
  });
});

describe("Shopify settings", () => {
  it("uses Admin GraphQL API 2026-07 and read-only scopes", () => {
    expect(SHOPIFY_API_VERSION).toBe("2026-07");
    expect(SHOPIFY_SCOPES).toEqual(["read_customers", "read_products"]);
  });

  it("takes a store as its myshopify.com address", () => {
    expect(normaliseShopDomain("glimmers")).toBe("glimmers.myshopify.com");
    expect(normaliseShopDomain(" Glimmers.myshopify.com ")).toBe("glimmers.myshopify.com");
    expect(normaliseShopDomain("https://glimmers.myshopify.com/admin")).toBe("glimmers.myshopify.com");
    expect(() => normaliseShopDomain("glimmers.example.com")).toThrow("myshopify.com");
    expect(() => normaliseShopDomain("")).toThrow();
    expect(() => normaliseShopDomain("bad_name!.myshopify.com")).toThrow("myshopify.com");
  });
});

describe("Shopify record shapes (SPC2, SPC3)", () => {
  it("reads a GraphQL customer", () => {
    expect(
      shopifyCustomerFromGraphql({
        id: "gid://shopify/Customer/1001",
        displayName: "Aroha Ngata",
        firstName: "Aroha",
        lastName: "Ngata",
        updatedAt: "2026-09-30T01:00:00Z",
        defaultEmailAddress: { emailAddress: "AROHA@manukavets.nz" },
        defaultPhoneNumber: { phoneNumber: "+64 21 555 0101" },
      }),
    ).toEqual({
      externalId: "1001",
      name: "Aroha Ngata",
      email: "AROHA@manukavets.nz",
      phone: "+64 21 555 0101",
      updatedAt: "2026-09-30T01:00:00.000Z",
    });
    // No names: Shopify's display name (often the email) is used.
    expect(
      shopifyCustomerFromGraphql({
        id: "gid://shopify/Customer/7",
        displayName: "kim@example.co.nz",
        firstName: null,
        lastName: "",
        updatedAt: "2026-09-30T01:00:00Z",
        defaultEmailAddress: null,
        defaultPhoneNumber: null,
      }),
    ).toMatchObject({ externalId: "7", name: "kim@example.co.nz", email: null, phone: null });
  });

  it("reads a customer webhook", () => {
    expect(
      shopifyCustomerFromWebhook({
        id: 1004,
        email: "mere@example.co.nz",
        first_name: "Mere",
        last_name: "Tane",
        phone: null,
        updated_at: "2026-10-01T09:00:00+13:00",
        admin_graphql_api_id: "gid://shopify/Customer/1004",
      }),
    ).toEqual({ externalId: "1004", name: "Mere Tane", email: "mere@example.co.nz", phone: null, updatedAt: "2026-09-30T20:00:00.000Z" });
    expect(() => shopifyCustomerFromWebhook({ email: "x@example.co.nz" })).toThrow();
  });

  it("reads a GraphQL product's variants", () => {
    const variants = shopifyVariantsFromGraphql({
      id: "gid://shopify/Product/2002",
      title: "Wax melts",
      updatedAt: "2026-09-30T02:00:00Z",
      variants: {
        nodes: [
          { id: "gid://shopify/ProductVariant/3002", title: "Vanilla", sku: "MELT-VAN", price: "8.50", updatedAt: "2026-09-30T01:00:00Z" },
          { id: "gid://shopify/ProductVariant/3003", title: "Lavender", sku: "", price: "8.50", updatedAt: "2026-09-30T03:00:00Z" },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    expect(variants.records).toEqual([
      { externalId: "3002", productId: "2002", productTitle: "Wax melts", variantTitle: "Vanilla", sku: "MELT-VAN", price: "8.50", updatedAt: "2026-09-30T02:00:00.000Z" },
      { externalId: "3003", productId: "2002", productTitle: "Wax melts", variantTitle: "Lavender", sku: null, price: "8.50", updatedAt: "2026-09-30T03:00:00.000Z" },
    ]);
    expect(variants.moreVariants).toBe(false);
  });

  it("reads a product webhook", () => {
    expect(
      shopifyVariantsFromWebhook({
        id: 2001,
        title: "Large candle",
        updated_at: "2026-10-01T00:00:00Z",
        variants: [{ id: 3001, product_id: 2001, title: "Default Title", sku: "candle-l", price: "22.00", updated_at: "2026-09-01T00:00:00Z" }],
      }),
    ).toEqual([
      { externalId: "3001", productId: "2001", productTitle: "Large candle", variantTitle: "Default Title", sku: "candle-l", price: "22.00", updatedAt: "2026-10-01T00:00:00.000Z" },
    ]);
  });

  it("names a new item from the product and variant (SPC3)", () => {
    expect(itemNameFor("Large candle", "Default Title")).toBe("Large candle");
    expect(itemNameFor("Wax melts", "Vanilla")).toBe("Wax melts - Vanilla");
    expect(itemNameFor("Wax melts", null)).toBe("Wax melts");
    expect(itemNameFor("x".repeat(200), "Big")).toHaveLength(150);
  });
});

describe("which value is kept (SPC2, SPC3, SPC5)", () => {
  it("when first linked, fills blanks and keeps different Tohyee values", () => {
    expect(mergeField({ tohyee: null, last: undefined, incoming: "+64 21 555 0101" })).toEqual({ kind: "apply", value: "+64 21 555 0101" });
    expect(mergeField({ tohyee: "Large soy candle", last: undefined, incoming: "Large candle" })).toEqual({ kind: "keep", changedInTohyee: false });
    expect(mergeField({ tohyee: "Aroha Ngata", last: undefined, incoming: "Aroha Ngata" })).toEqual({ kind: "same" });
    // Shopify having nothing never blanks a Tohyee value.
    expect(mergeField({ tohyee: "021 555", last: undefined, incoming: null })).toEqual({ kind: "same" });
  });

  it("later, applies Shopify's change unless someone changed it in Tohyee", () => {
    // Nothing changed in Shopify: nothing happens, whatever Tohyee has.
    expect(mergeField({ tohyee: "Tama Rewi (wholesale)", last: "Tama Rewi", incoming: "Tama Rewi" })).toEqual({ kind: "same" });
    // Changed in Shopify only: applied.
    expect(mergeField({ tohyee: "20", last: "20", incoming: "22" })).toEqual({ kind: "apply", value: "22" });
    expect(mergeField({ tohyee: "+64 21 1", last: "+64 21 1", incoming: null })).toEqual({ kind: "apply", value: null });
    // Changed on both sides: Tohyee's is kept.
    expect(mergeField({ tohyee: "Tama Rewi (wholesale)", last: "Tama Rewi", incoming: "Tama Rewi-Smith" })).toEqual({ kind: "keep", changedInTohyee: true });
    // Both changed to the same value: nothing to do.
    expect(mergeField({ tohyee: "Tama R", last: "Tama Rewi", incoming: "Tama R" })).toEqual({ kind: "same" });
  });

  it("can compare ignoring case, for emails", () => {
    const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    expect(mergeField({ tohyee: "aroha@manukavets.nz", last: undefined, incoming: "AROHA@manukavets.nz", same: sameEmail })).toEqual({ kind: "same" });
  });

  it("copies sale prices only from a store in the base currency whose prices exclude tax (SPC6)", () => {
    expect(priceCopyable({ storeCurrency: "NZD", pricesIncludeTax: false, baseCurrency: "NZD" })).toEqual({ copy: true });
    expect(priceCopyable({ storeCurrency: "NZD", pricesIncludeTax: true, baseCurrency: "NZD" })).toEqual({
      copy: false,
      reason: "the store's prices include tax and Tohyee's item prices exclude GST",
    });
    expect(priceCopyable({ storeCurrency: "AUD", pricesIncludeTax: false, baseCurrency: "NZD" })).toEqual({
      copy: false,
      reason: "the store's currency is AUD, not NZD",
    });
    expect(priceCopyable({ storeCurrency: null, pricesIncludeTax: null, baseCurrency: "NZD" }).copy).toBe(false);
  });
});

describe("calling Shopify: rate limits and redirects", () => {
  const context = { storeDomain: "glimmers.myshopify.com", credentials: { accessToken: "shpat_x", apiSecret: "s" }, cachedToken: null, now: new Date() };
  const token = { token: "shpat_x", expiresAt: null };
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const throttled = () =>
    json({
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      extensions: { cost: { requestedQueryCost: 302, actualQueryCost: null, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 52, restoreRate: 100 } } },
    });
  const page = json({
    data: {
      customers: {
        nodes: [{ id: "gid://shopify/Customer/1001", firstName: "Aroha", lastName: "Ngata", updatedAt: "2026-10-01T00:00:00Z" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  });
  const request = { customers: true, products: false, customersSince: null, productsSince: null };

  afterEach(() => {
    setSalesPlatformFetchForTests(null);
    setSalesPlatformSleepForTests(null);
  });

  it("waits for the cost bucket to refill and asks again when a query is throttled, instead of failing the sync", async () => {
    const answers = [throttled(), json({ errors: "Exceeded 2 calls per second" }, 429, { "retry-after": "2" }), page];
    const inits: RequestInit[] = [];
    const waits: number[] = [];
    setSalesPlatformFetchForTests(async (_url, init) => {
      inits.push(init ?? {});
      return answers.shift()!;
    });
    setSalesPlatformSleepForTests(async (ms) => {
      waits.push(ms);
    });
    const changes = await shopifyConnector.fetchChanges(context, token, request);
    expect(changes.customers.map((c) => c.name)).toEqual(["Aroha Ngata"]);
    // (302 - 52) points at 100 a second is 2.5 seconds; then the 429's Retry-After.
    expect(waits).toEqual([2500, 2000]);
    // Redirects aren't followed, so the access token can't be sent anywhere else.
    expect(inits.every((init) => init.redirect === "error")).toBe(true);
  });

  it("gives up after a few throttled answers", async () => {
    let calls = 0;
    setSalesPlatformFetchForTests(async () => {
      calls += 1;
      return throttled();
    });
    setSalesPlatformSleepForTests(async () => undefined);
    await expect(shopifyConnector.fetchChanges(context, token, request)).rejects.toThrow(/Throttled/);
    expect(calls).toBe(7);
  });
});

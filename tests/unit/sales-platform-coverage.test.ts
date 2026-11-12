import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CoverageList } from "@/components/sales-platforms";
import { type CoverageFacts, coverageFor, coverageKinds, groupReasons, reasonFor } from "@/lib/sales-platforms/coverage-status";
import type { SalesPlatformConnection } from "@/lib/sales-platforms/types";

/** #532 part 2: what each part of a connection has brought in, from made-up records. */
const connection = (overrides: Partial<SalesPlatformConnection> = {}): SalesPlatformConnection => ({
  id: "1",
  platform: "shopify",
  storeDomain: "example-shop.myshopify.com",
  storeName: "Example shop",
  storeCurrency: "NZD",
  pricesIncludeTax: true,
  authMethod: "client_credentials",
  syncCustomers: true,
  customerScope: "all",
  syncProducts: true,
  productVariants: { linked: 0, withoutSku: 0 },
  status: "active",
  lastSyncAt: "2026-11-01T01:00:00.000Z",
  lastSuccessfulSyncAt: "2026-11-01T01:00:00.000Z",
  needsReconnect: false,
  lastError: null,
  failures: 0,
  webhooksActive: true,
  webhooksNote: null,
  connectedByEmail: "owner@example.nz",
  connectedAt: "2026-10-30T01:00:00.000Z",
  disconnectedByEmail: null,
  disconnectedAt: null,
  postToAccounts: false,
  stockItems: true,
  startDate: null,
  clearingAccountCode: null,
  payoutAccountCode: null,
  feesAccountCode: null,
  salesAccountCode: null,
  shippingAccountCode: null,
  chargebacksAccountCode: null,
  reserveAccountCode: null,
  salesWhenSentAccountCode: null,
  giftCardAccountCode: null,
  giftCardItems: [],
  giftCardItemSuggestions: [],
  paymentMethods: [],
  guestContactId: null,
  guestContactName: null,
  untaxedTaxCode: null,
  taxCodes: [],
  grantedScopes: ["read_customers", "read_products", "read_orders", "read_shopify_payments_payouts", "read_shopify_payments_accounts"],
  ...overrides,
});

const facts = (overrides: Partial<CoverageFacts> = {}): CoverageFacts => ({
  linkedCustomers: 0,
  linkedVariants: 0,
  postedOrders: 0,
  postedRefunds: 0,
  postedPayouts: 0,
  outstanding: [],
  outstandingCapped: false,
  ...overrides,
});

const noSku = (n: number) => ({ recordKind: "product_variant" as const, action: "skipped" as const, message: `Shopify variant Mug ${n} has no SKU, so it wasn't matched to an item or added.` });

describe("connection coverage", () => {
  it("customers imported but products skipped shows products partly brought in, with the reason", () => {
    const f = facts({
      linkedCustomers: 412,
      linkedVariants: 30,
      outstanding: [...Array.from({ length: 12 }, (_, n) => noSku(n)), { recordKind: "product_variant", action: "skipped", message: "Shopify variant Cup wasn't linked: item CUP is already linked to Shopify variant 9 with the same SKU." }],
    });
    const customers = coverageFor("customers", connection(), f);
    expect(customers).toMatchObject({ state: "up_to_date", summary: "Up to date: 412 contacts linked", action: null });
    const products = coverageFor("products", connection(), f);
    expect(products.state).toBe("partly");
    expect(products.summary).toBe("30 items linked, 13 records not brought in");
    expect(products.reasons).toEqual([
      { text: "no SKU", count: 12, outcome: "skipped" },
      { text: "SKU already linked to another variant", count: 1, outcome: "skipped" },
    ]);
    expect(products.action).toEqual({ kind: "log", text: "See why" });
  });

  it("posting never set up says so, rather than implying there are no sales", () => {
    const orders = coverageFor("orders", connection(), facts());
    expect(orders).toMatchObject({ state: "needs_setup", summary: "Posting not set up: nothing is brought in", action: { kind: "setup", text: "Set up" } });
    expect(coverageFor("payouts", connection(), facts()).state).toBe("needs_setup");
  });

  it("posting set up but switched off offers to turn it on", () => {
    const off = connection({ startDate: "2026-11-01", salesAccountCode: "4000", clearingAccountCode: "1010", payoutAccountCode: "1000", feesAccountCode: "6020" });
    expect(coverageFor("orders", off, facts())).toMatchObject({ state: "off", action: { kind: "turn_on" } });
  });

  it("orders posted with some waiting, and skipped-on-purpose ones not counted as problems", () => {
    const on = connection({ postToAccounts: true, startDate: "2026-11-01", salesAccountCode: "4000", clearingAccountCode: "1010", payoutAccountCode: "1000", feesAccountCode: "6020" });
    const f = facts({
      postedOrders: 1204,
      postedRefunds: 3,
      postedPayouts: 40,
      outstanding: [
        { recordKind: "order", action: "skipped", message: "#1001 was processed before the start date (2026-11-01), so it isn't brought in." },
        { recordKind: "order", action: "failed", message: "#1500 has no Shopify customer (a guest checkout). Choose a contact for guest checkouts in the connection's settings to bring it in." },
        { recordKind: "order", action: "waiting", message: "#1501 isn't paid yet (Shopify says PENDING), so it isn't invoiced." },
      ],
    });
    const orders = coverageFor("orders", on, f);
    expect(orders.state).toBe("partly");
    expect(orders.summary).toBe("1,204 orders and 3 refunds posted since 2026-11-01; 2 orders or refunds not posted yet");
    expect(orders.reasons.map((reason) => reason.text).sort()).toEqual(["guest checkout, no contact chosen", "not paid yet"]);
    expect(coverageFor("payouts", on, f)).toMatchObject({ state: "up_to_date", summary: "Up to date: 40 payouts posted since 2026-11-01" });
    expect(coverageFor("payouts", on, f).retry).toBeUndefined();
    // SPC39: payouts not posted offer "Try again" (orders don't).
    const refused = coverageFor("payouts", on, { ...f, postedPayouts: 0, outstanding: [{ recordKind: "payout", action: "failed", message: "Payout 7 has transactions of a type Tohyee doesn't post (X)" }] });
    expect(refused).toMatchObject({ state: "failed", retry: true, reasons: [{ text: "a payout line Tohyee doesn't post", count: 1, outcome: "failed" }] });
    expect(orders.retry).toBeUndefined();
  });

  it("missing scopes need setting up", () => {
    const on = connection({ postToAccounts: true, startDate: "2026-11-01", salesAccountCode: "4000", clearingAccountCode: "1010", payoutAccountCode: "1000", feesAccountCode: "6020", grantedScopes: ["read_orders"] });
    expect(coverageFor("payouts", on, facts())).toMatchObject({ state: "needs_setup", action: { kind: "scopes" } });
    expect(coverageFor("orders", on, facts()).state).toBe("up_to_date");
  });

  it("off, not synced and failed", () => {
    expect(coverageFor("customers", connection({ syncCustomers: false }), facts({ linkedCustomers: 5 }))).toMatchObject({ state: "off", summary: "Off: not brought in (5 contacts linked earlier)" });
    expect(coverageFor("products", connection({ lastSyncAt: null }), facts()).state).toBe("not_synced");
    const failed = coverageFor("customers", connection(), facts({ outstanding: [{ recordKind: "customer", action: "failed", message: "Shopify customer 7 couldn't be copied: name is too long." }] }));
    expect(failed.state).toBe("failed");
  });

  it("a sync that failed outright isn't shown as up to date", () => {
    expect(coverageFor("customers", connection({ lastError: "Shopify refused the credentials." }), facts({ linkedCustomers: 3 }))).toMatchObject({
      state: "failed",
      summary: "3 contacts linked; the last sync failed",
    });
  });

  it("says when there were more outstanding records than were read", () => {
    expect(coverageFor("products", connection(), facts({ linkedVariants: 1, outstanding: [noSku(1)], outstandingCapped: true })).summary).toContain("(at least)");
  });

  it("WooCommerce has orders only", () => {
    expect(coverageKinds("woocommerce")).toEqual(["orders"]);
    expect(coverageKinds("shopify")).toEqual(["customers", "products", "orders", "payouts"]);
  });

  it("names reasons in plain words and groups them", () => {
    expect(reasonFor("Shopify variant X has no SKU, so it wasn't matched")).toBe("no SKU");
    expect(reasonFor("Something new happened")).toBe("other reasons");
    expect(reasonFor("Choose where afterpay payments go in the Shopify settings.")).toBe("payment method not chosen");
    expect(reasonFor("Payout 7 can't be posted: no fees account is chosen.")).toBe("payout account not chosen");
    expect(reasonFor("Payout 7 has transactions of a type Tohyee doesn't post (X)")).toBe("a payout line Tohyee doesn't post");
    expect(groupReasons([noSku(1), noSku(2), { recordKind: "order", action: "waiting", message: "#1 isn't paid yet" }])).toEqual([
      { text: "no SKU", count: 2, outcome: "skipped" },
      { text: "not paid yet", count: 1, outcome: "waiting" },
    ]);
  });

  it("renders each part with its badge, reasons and action", () => {
    const f = facts({ linkedCustomers: 412, linkedVariants: 30, outstanding: Array.from({ length: 12 }, (_, n) => noSku(n)) });
    const parts = coverageKinds("shopify").map((kind) => coverageFor(kind, connection(), f));
    const html = renderToStaticMarkup(createElement(CoverageList, { parts, onAction: () => undefined }));
    expect(html).toContain("Customers");
    expect(html).toContain("Up to date: 412 contacts linked");
    expect(html).toContain("Partly brought in");
    expect(html).toContain("12 skipped: no SKU");
    expect(html).toContain("Posting not set up: nothing is brought in");
    expect(html).toContain("Set up");
    expect(html).toContain("See why");
  });
});

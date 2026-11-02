import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { closeAnalytics, listTables, queryAnalytics } from "@/lib/analytics/engine";
import { refreshShopify } from "@/lib/analytics/shopify";
import * as stockRoute from "@/app/api/sales-platforms/connections/[connectionId]/stock/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { FULFILMENT_ORDERS_NOT_APPROVED, SHOPIFY_ALL_SCOPES, STATS_NOT_APPROVED } from "@/lib/sales-platforms/parts";
import { connectStore, connectionStock, listConnections, listSyncLog, syncConnection, updateConnectionSettings } from "@/lib/sales-platforms/service";
import { setSalesPlatformFetchForTests } from "@/lib/sales-platforms/shopify";
import { CLIENT_ID, CLIENT_SECRET, type StoreState, order1001, order1002, storeState } from "../helpers/fake-shopify-orders";
import { type ExtrasState, extrasState, fakeShopifyStoreWithExtras } from "../helpers/fake-shopify-extras";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
const CONNECTED_AT = new Date("2026-10-01T00:03:01Z");
const BASE_SCOPES = ["read_customers", "read_products", "read_orders", "read_shopify_payments_payouts", "read_shopify_payments_accounts"];

/** Examples SPD1-SPD11 in docs/ACCOUNTING-EXAMPLES.md (Shopify's read-only extras). Made-up Shopify-shaped data; not tried against a real store. */
describeWithDatabase("Shopify's read-only extras: stock, shop stats, discounts, gift cards, fulfilments (#530)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("jess@glimmers-extras.nz", { serverAdmin: true, displayName: "Jess" });
    viewer = await createTestUser("viewer@glimmers-extras.nz");
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });

  afterEach(() => {
    setSalesPlatformFetchForTests(null);
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  type Options = { scopes?: string[]; post?: boolean; store?: Partial<StoreState>; extras?: Partial<ExtrasState> };

  async function setup(options: Options = {}) {
    organisations += 1;
    const org = `spd-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const actor = { userId: owner.id, email: owner.email };
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, actor, work);
    await as((tx) => updateOrganisationSettings(tx, { gstNumber: "123-456-789", gstRegistered: true }));
    const state = storeState({ scopes: options.scopes ?? [...SHOPIFY_ALL_SCOPES], ...options.store });
    const extras = extrasState(options.extras);
    setSalesPlatformFetchForTests(fakeShopifyStoreWithExtras(state, extras));
    const record = (await getOrganisation(org))!;
    const connection = await connectStore(
      record,
      actor,
      { platform: "shopify", storeDomain: "glimmers", authMethod: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      { webhookOrigin: null, now: CONNECTED_AT },
    );
    if (options.post !== false) {
      await as((tx) =>
        updateConnectionSettings(tx, connection.id, {
          postToAccounts: true,
          startDate: "2026-10-01",
          newClearingAccount: { code: "1010", name: "Shopify clearing" },
          payoutAccountCode: "1000",
          feesAccountCode: "6020",
          salesAccountCode: "4000",
          shippingAccountCode: "4000",
          taxCodes: [{ rate: "15", taxCode: "GST" }],
          untaxedTaxCode: "ZERO",
        }),
      );
    }
    return {
      org,
      as,
      actor,
      record,
      state,
      extras,
      connectionId: connection.id,
      /** The 15-minute sync. */
      sync: (at: string) => syncConnection(record, connection.id, undefined, new Date(at)),
      /** "Sync now" by Jess: reads the extras whenever. */
      syncNow: (at: string) => syncConnection(record, connection.id, actor, new Date(at)),
    };
  }
  type World = Awaited<ReturnType<typeof setup>>;

  const rows = async <T extends Record<string, unknown>>(w: World, sql: string) => (await w.as((tx) => tx.query<T>(sql))).rows;
  const messages = async (w: World) => (await w.as((tx) => listSyncLog(tx, w.connectionId))).entries.map((entry) => entry.message);
  const ledger = async (w: World) =>
    (await rows<{ n: string; total: string }>(w, "select count(*)::text as n, coalesce(sum(debit_amount), 0)::text as total from ledger_journal_lines"))[0];

  it("SPD1-SPD9 without their scopes: nothing extra is asked for, and the log says which scopes are missing", async () => {
    const w = await setup({ scopes: BASE_SCOPES });
    w.state.orders.push(order1002());
    await w.sync("2026-10-03T01:00:00Z");
    expect(w.extras.calls).toEqual([]);
    const log = await messages(w);
    expect(log).toContain("Stock levels aren't brought in: the app hasn't been given read_inventory and read_locations. Add them to the app's access scopes in Shopify, then test the connection.");
    expect(log).toContain("Shop stats aren't brought in: the app hasn't been given read_reports. Add it to the app's access scopes in Shopify, then test the connection.");
    expect(log.some((m) => m.startsWith("Discounts aren't brought in") && m.includes("read_discounts"))).toBe(true);
    expect(log.some((m) => m.startsWith("Gift cards aren't brought in") && m.includes("read_gift_cards and read_gift_card_transactions"))).toBe(true);
    for (const table of ["sales_platform_stock_levels", "sales_platform_shop_stats", "sales_platform_discounts", "sales_platform_gift_cards", "sales_platform_order_discounts"]) {
      expect((await rows<{ n: string }>(w, `select count(*)::text as n from ${table}`))[0].n).toBe("0");
    }
    // Fulfilments come with read_orders (Shopify's Fulfillment needs only that), so they're on here.
    expect(await rows(w, "select order_external_id, shipping_charged::text, fulfilment_status from sales_platform_order_details")).toEqual([
      { order_external_id: "5002", shipping_charged: "6.9", fulfilment_status: "FULFILLED" },
    ]);
    // Only one gift card scope: still off.
    const half = await setup({ scopes: [...BASE_SCOPES, "read_gift_cards"] });
    await half.sync("2026-10-03T01:00:00Z");
    expect(half.extras.calls).not.toContain("giftCards");
    const parts = (await half.as((tx) => listConnections(tx)))[0].grantedScopes;
    expect(parts).toContain("read_gift_cards");
  });

  it("SPD1-SPD2: stock levels by location, and the difference view against Tohyee's stock, which never changes", async () => {
    const w = await setup();
    await w.sync("2026-10-01T01:00:00Z");
    expect(w.extras.calls.slice(0, 2)).toEqual(["locations", "inventory"]);
    expect(await rows(w, "select external_id, name, is_active from sales_platform_locations order by external_id")).toEqual([
      { external_id: "61", name: "Dunedin workshop", is_active: true },
      { external_id: "62", name: "Otago Farmers Market", is_active: true },
    ]);
    // The untracked sticker isn't kept.
    expect(await rows(w, "select variant_external_id, location_external_id, sku, available::text, on_hand::text from sales_platform_stock_levels order by 1, 2")).toEqual([
      { variant_external_id: "3001", location_external_id: "61", sku: "CANDLE-L", available: "12", on_hand: "12" },
      { variant_external_id: "3004", location_external_id: "61", sku: "GIFTBOX", available: "5", on_hand: "7" },
      { variant_external_id: "3004", location_external_id: "62", sku: "GIFTBOX", available: "2", on_hand: "2" },
      { variant_external_id: "3009", location_external_id: "61", sku: null, available: "1", on_hand: "1" },
    ]);

    // Tohyee bought 10 gift boxes (ST1's way).
    const giftBox = (await rows<{ id: string }>(w, "select id::text from items where code = 'GIFTBOX'"))[0];
    const supplier = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Box Co", isSupplier: true }))).contact;
    const draft = await w.as((tx) =>
      createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: supplier.id,
        billDate: "2026-10-01",
        dueDate: "2026-10-20",
        supplierInvoiceNumber: "B-1",
        amountsMode: "exclusive",
        lines: [{ itemId: giftBox.id, description: "Gift boxes", quantity: "10", unitPrice: "12.00", accountCode: "1400", taxCode: "GST" }],
      }),
    );
    await w.as((tx) => approveBill(tx, draft.bill.id, { idempotencyKey: key("a") }));
    const balancesBefore = await rows(w, "select item_code, on_hand_quantity::text, carrying_value::text from inventory_item_balances order by item_code");
    const ledgerBefore = await ledger(w);

    // Shopify says 9 on hand across two locations; Tohyee has 10. Reading it again changes neither Tohyee's stock nor its books.
    await w.syncNow("2026-10-01T02:00:00Z");
    expect(await rows(w, "select item_code, on_hand_quantity::text, carrying_value::text from inventory_item_balances order by item_code")).toEqual(balancesBefore);
    expect(await ledger(w)).toEqual(ledgerBefore);

    const view = await w.as((tx) => connectionStock(tx, w.connectionId));
    expect(view.stockPartOn).toBe(true);
    expect(view.rows.map((r) => [r.itemCode, r.matchedBy, r.shopifyOnHand, r.shopifyAvailable, r.tohyeeOnHand, r.difference])).toEqual([
      // CANDLE-L is a non-stock item in Tohyee (Shopify didn't track it when it was added): nothing to compare.
      ["CANDLE-L", "link", "12", "12", null, null],
      ["GIFTBOX", "link", "9", "7", "10", "-1"],
      // No SKU and no link: shown, unmatched.
      [null, null, "1", "1", null, null],
    ]);
    expect(view.rows[1].locations).toEqual([
      { name: "Dunedin workshop", onHand: "7", available: "5" },
      { name: "Otago Farmers Market", onHand: "2", available: "2" },
    ]);

    // Viewers can read it through the API.
    const cookie = await sessionCookieFor(viewer);
    const response = await stockRoute.GET(
      apiRequest(`/api/sales-platforms/connections/${w.connectionId}/stock?organisationId=${w.org}`, { cookie }),
      { params: Promise.resolve({ connectionId: w.connectionId }) },
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { rows: unknown[] }).rows).toHaveLength(3);

    // Within the hour the 15-minute sync doesn't ask again; "Sync now" does.
    w.extras.calls = [];
    await w.sync("2026-10-01T02:30:00Z");
    expect(w.extras.calls).not.toContain("inventory");
    await w.sync("2026-10-01T03:01:00Z");
    expect(w.extras.calls).toContain("inventory");
  });

  it("SPD3: shop stats by day, product and channel from ShopifyQL", async () => {
    const w = await setup();
    await w.sync("2026-10-03T01:00:00Z");
    const asked = w.extras.calls.filter((call) => call.startsWith("shopifyql:"));
    expect(asked).toEqual([
      "shopifyql:FROM sessions SHOW sessions, conversion_rate TIMESERIES day SINCE -90d ORDER BY day ASC",
      "shopifyql:FROM sales SHOW orders, gross_sales, net_sales TIMESERIES day SINCE -90d ORDER BY day ASC",
      "shopifyql:FROM sales SHOW orders, gross_sales, net_sales GROUP BY day, product_title SINCE -90d ORDER BY day ASC LIMIT 1000",
      "shopifyql:FROM sales SHOW orders, gross_sales, net_sales GROUP BY day, sales_channel SINCE -90d ORDER BY day ASC LIMIT 1000",
    ]);
    expect(await rows(w, "select day::text, sessions::text, conversion_rate::text, orders::text, gross_sales::text, net_sales::text from sales_platform_shop_stats order by day")).toEqual([
      { day: "2026-10-01", sessions: "120", conversion_rate: "2.5", orders: "3", gross_sales: "120", net_sales: "110" },
      { day: "2026-10-02", sessions: "80", conversion_rate: "1.25", orders: "1", gross_sales: "40", net_sales: "40" },
    ]);
    expect(await rows(w, "select dimension, value, net_sales::text from sales_platform_shop_sales order by dimension, value")).toEqual([
      { dimension: "channel", value: "Online Store", net_sales: "70" },
      { dimension: "channel", value: "Point of Sale", net_sales: "40" },
      { dimension: "product", value: "Large candle", net_sales: "75" },
      { dimension: "product", value: "Wax melts", net_sales: "35" },
    ]);
    // Next time (6 hours on) only the last 30 days are asked, and a changed day replaces the old figure.
    w.extras.calls = [];
    w.extras.sales = [{ day: "2026-10-02", orders: "2", gross_sales: "63.00", net_sales: "63.00" }];
    await w.sync("2026-10-03T07:01:00Z");
    expect(w.extras.calls.filter((call) => call.startsWith("shopifyql:"))[0]).toContain("SINCE -30d");
    expect(await rows(w, "select day::text, orders::text, net_sales::text from sales_platform_shop_stats order by day")).toEqual([
      { day: "2026-10-01", orders: null, net_sales: null },
      { day: "2026-10-02", orders: "2", net_sales: "63" },
    ]);
  });

  it("SPD4: Shopify refusing shop reports (protected customer data) is logged, and the rest of the sync carries on", async () => {
    const w = await setup({ extras: { statsDenied: true } });
    w.state.orders.push(order1002());
    const result = await w.sync("2026-10-03T01:00:00Z");
    expect(result.failed).toBe(0);
    expect(await messages(w)).toContain(STATS_NOT_APPROVED);
    expect(STATS_NOT_APPROVED.startsWith("Shopify hasn't approved shop reports for this app yet")).toBe(true);
    expect((await w.as((tx) => listConnections(tx)))[0]).toMatchObject({ lastError: null, failures: 0, status: "active" });
    expect((await rows<{ n: string }>(w, "select count(*)::text as n from sales_platform_shop_stats"))[0].n).toBe("0");
    // Everything else still came in: the order was posted, stock, discounts and gift cards saved.
    expect((await rows<{ state: string }>(w, "select state from sales_platform_documents where external_id = '5002'"))[0].state).toBe("done");
    expect((await rows<{ n: string }>(w, "select count(*)::text as n from sales_platform_stock_levels"))[0].n).toBe("4");
    expect((await rows<{ n: string }>(w, "select count(*)::text as n from sales_platform_discounts"))[0].n).toBe("3");
    expect((await rows<{ n: string }>(w, "select count(*)::text as n from sales_platform_gift_cards"))[0].n).toBe("2");
    // Not asked again for 6 hours.
    w.extras.calls = [];
    await w.sync("2026-10-03T02:00:00Z");
    expect(w.extras.calls.some((call) => call.startsWith("shopifyql:"))).toBe(false);
  });

  it("SPD5-SPD6: discounts, and the discount used on an order, with nothing new posted", async () => {
    // Each world's fake store is in place only from its setup to the next.
    const without = await setup({ scopes: BASE_SCOPES });
    without.state.orders.push(order1002());
    await without.sync("2026-10-03T01:00:00Z");
    expect((await ledger(without)).n).not.toBe("0");
    const w = await setup();
    w.state.orders.push(order1002());
    await w.sync("2026-10-03T01:00:00Z");
    expect(await rows(w, "select external_id, method, title, discount_type, value_type, value::text, status, times_used, ends_at from sales_platform_discounts order by external_id")).toEqual([
      { external_id: "801", method: "code", title: "MELT5", discount_type: "amount_off", value_type: "amount", value: "5", status: "ACTIVE", times_used: 14, ends_at: null },
      { external_id: "802", method: "automatic", title: "Spring 10% off", discount_type: "amount_off", value_type: "percentage", value: "10", status: "EXPIRED", times_used: 31, ends_at: "2026-09-30T11:00:00.000Z" },
      { external_id: "803", method: "code", title: "FREESHIP", discount_type: "free_shipping", value_type: null, value: null, status: "SCHEDULED", times_used: 0, ends_at: null },
    ]);
    expect(await rows(w, "select order_external_id, application_index, kind, code, value_type, value::text, amount::text from sales_platform_order_discounts")).toEqual([
      { order_external_id: "5002", application_index: 0, kind: "code", code: "MELT5", value_type: "amount", value: "5", amount: "5" },
    ]);
    expect((await rows<{ d: string }>(w, "select discounts_total::text as d from sales_platform_order_details"))[0].d).toBe("5");
    // The books are the same with or without the extras: nothing new is posted (decision 1237).
    expect(await ledger(w)).toEqual(await ledger(without));
  });

  it("SPD7-SPD8: gift cards keep only their last characters, never the code", async () => {
    const w = await setup();
    await w.sync("2026-10-05T04:00:00Z");
    expect(await rows(w, "select external_id, last_characters, initial_value::text, balance::text, currency, expires_on::text, enabled from sales_platform_gift_cards order by external_id")).toEqual([
      { external_id: "901", last_characters: "7XQ2", initial_value: "50", balance: "30", currency: "NZD", expires_on: "2027-10-01", enabled: true },
      { external_id: "902", last_characters: "K9MD", initial_value: "25", balance: "25", currency: "NZD", expires_on: null, enabled: false },
    ]);
    expect(await rows(w, "select gift_card_external_id, kind, amount::text from sales_platform_gift_card_transactions")).toEqual([
      { gift_card_external_id: "901", kind: "debit", amount: "-20" },
    ]);
    // No full code anywhere in the organisation's Shopify tables or the sync log.
    const everything = JSON.stringify([
      await rows(w, "select * from sales_platform_gift_cards"),
      await rows(w, "select * from sales_platform_gift_card_transactions"),
      await rows(w, "select message from sales_platform_sync_log"),
    ]);
    for (const code of w.extras.fullCodes) expect(everything).not.toContain(code);
    await expect(w.as((tx) => tx.query("update sales_platform_gift_cards set last_characters = 'GLIM-WXYZ-ABCD-7XQ2'"))).rejects.toThrow();
  });

  it("SPD9: shipments and shipping charged on an order; SPD10: refused fulfilment orders are logged and left out", async () => {
    const w = await setup();
    w.state.orders.push(order1002());
    await w.sync("2026-10-03T01:00:00Z");
    expect(await rows(w, "select order_external_id, status, carrier, tracking_number, delivered_at from sales_platform_fulfilments")).toEqual([
      { order_external_id: "5002", status: "SUCCESS", carrier: "NZ Post", tracking_number: "NZ123456789", delivered_at: "2026-10-05T01:00:00.000Z" },
    ]);
    expect(await rows(w, "select order_name, shipping_charged::text, fulfilment_status, fulfilment_order_statuses from sales_platform_order_details")).toEqual([
      { order_name: "#1002", shipping_charged: "6.9", fulfilment_status: "FULFILLED", fulfilment_order_statuses: ["CLOSED"] },
    ]);

    const refused = await setup({ extras: { fulfilmentOrdersDenied: true } });
    refused.state.orders.push(order1001(), order1002());
    const result = await refused.sync("2026-10-09T02:00:00Z");
    expect(result.failed).toBe(0);
    expect(await messages(refused)).toContain(FULFILMENT_ORDERS_NOT_APPROVED);
    // Asked with fulfilment orders once, then without for the rest.
    expect(refused.extras.calls.filter((call) => call === "order-with-fulfillment-orders")).toHaveLength(1);
    expect(await rows(refused, "select order_external_id, shipping_charged::text, fulfilment_order_statuses from sales_platform_order_details order by 1")).toEqual([
      { order_external_id: "5001", shipping_charged: "0", fulfilment_order_statuses: null },
      { order_external_id: "5002", shipping_charged: "6.9", fulfilment_order_statuses: null },
    ]);
    expect((await rows<{ n: string }>(refused, "select count(*)::text as n from sales_platform_documents where record_kind = 'order' and state = 'done'"))[0].n).toBe("2");
  });

  it("SPD11: Shopify in Analytics is Tohyee's own copy, and never calls Shopify", async () => {
    const w = await setup();
    w.state.orders.push(order1002());
    await w.sync("2026-10-03T01:00:00Z");
    const savedDir = process.env.TOHYEE_ANALYTICS_DIR;
    const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tohyee-spd11-"));
    process.env.TOHYEE_ANALYTICS_DIR = folder;
    try {
      await w.as((tx) => updateOrganisationSettings(tx, { analyticsEnabled: true }));
      const calls = w.state.calls.length + w.extras.calls.length;
      // Shopify isn't reachable from here: the copy reads only Tohyee's database.
      setSalesPlatformFetchForTests(async () => {
        throw new Error("Analytics called Shopify");
      });
      const run = await refreshShopify(w.record, w.actor, "manual");
      expect(run).toMatchObject({ status: "ok", sourceName: "Shopify", tableName: "shopify_*" });
      expect(w.state.calls.length + w.extras.calls.length).toBe(calls);
      const tables = await listTables(w.org);
      expect([...tables.keys()].filter((name) => name.startsWith("shopify_")).sort()).toEqual([
        "shopify_discounts",
        "shopify_fulfilments",
        "shopify_gift_card_transactions",
        "shopify_gift_cards",
        "shopify_locations",
        "shopify_order_discounts",
        "shopify_order_lines",
        "shopify_orders",
        "shopify_payouts",
        "shopify_refunds",
        "shopify_sales_by_channel",
        "shopify_sales_by_product",
        "shopify_shop_stats",
        "shopify_stock",
      ]);
      // No names, emails or phones: customers are contact IDs.
      for (const [name, columns] of tables) {
        if (!name.startsWith("shopify_")) continue;
        expect(columns.map((c) => c.name).filter((c) => /email|phone|address|customer_name|^contact$/.test(c))).toEqual([]);
      }
      expect(await queryAnalytics(w.org, "select order_name, invoice_number, cast(total as varchar) as total, cast(discounts as varchar) as discounts, cast(shipping_charged as varchar) as shipping, fulfilment_status from shopify_orders")).toEqual([
        { order_name: "#1002", invoice_number: "INV-0001", total: "28.90", discounts: "5.00", shipping: "6.90", fulfilment_status: "FULFILLED" },
      ]);
      expect(await queryAnalytics(w.org, "select ends_with from shopify_gift_cards order by ends_with")).toEqual([{ ends_with: "7XQ2" }, { ends_with: "K9MD" }]);
      // Tohyee's on hand and the difference sit on one row per variant, so adding up doesn't double them.
      expect(await queryAnalytics(w.org, "select sku, cast(sum(shopify_on_hand) as varchar) as shopify, count(tohyee_on_hand) as tohyee_rows from shopify_stock where sku = 'GIFTBOX' group by sku")).toEqual([
        { sku: "GIFTBOX", shopify: "9.0000", tohyee_rows: "1" },
      ]);
    } finally {
      await closeAnalytics(w.org);
      process.env.TOHYEE_ANALYTICS_DIR = savedDir;
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("refuses a Shopify load when no store was ever connected", async () => {
    organisations += 1;
    const org = `spd-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const actor = { userId: owner.id, email: owner.email };
    await inOrganisation(org, actor, (tx) => updateOrganisationSettings(tx, { analyticsEnabled: true }));
    await expect(refreshShopify((await getOrganisation(org))!, actor, "manual")).rejects.toThrow("No Shopify store is connected");
  });
});

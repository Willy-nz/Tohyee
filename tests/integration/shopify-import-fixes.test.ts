import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { getInvoice } from "@/lib/invoices/service";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { listCustomerMatches, rememberCustomerMatch } from "@/lib/sales-platforms/customer-matches";
import { salesPlatformDiagnostics } from "@/lib/sales-platforms/diagnostics";
import { connectStore, listConnections, listSyncLog, syncConnection, updateConnectionSettings } from "@/lib/sales-platforms/service";
import { setSalesPlatformFetchForTests } from "@/lib/sales-platforms/shopify";
import { createTaxCode } from "@/lib/tax/codes";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  type CustomerFixture,
  DOMAIN,
  type OrderFixture,
  type ProductFixture,
  type StoreState,
  fakeShopifyStore,
  storeState,
} from "../helpers/fake-shopify-orders";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
const CONNECTED_AT = new Date("2026-10-01T00:03:01Z");

/**
 * Fixes from a first live Shopify sync (decisions 1334-1341, examples
 * SPC38-SPC42), with Shopify-shaped responses of made-up people and
 * products. Not recorded from a real store.
 */
describeWithDatabase("Shopify import fixes (products without SKUs, buyers only, weak names, numbering)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@kowhai-fixes.test", { serverAdmin: true, displayName: "Owner" });
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });

  afterEach(() => {
    setSalesPlatformFetchForTests(null);
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  const PENDANT: ProductFixture = {
    id: 2101,
    title: "Paw print pendant",
    updatedAt: "2026-09-30T05:00:00Z",
    variants: [
      { id: 3101, title: "Silver", sku: null, price: "89.00" },
      { id: 3102, title: "Gold", sku: "", price: "129.00" },
    ],
  };
  const CANDLE: ProductFixture = { id: 2001, title: "Large candle", updatedAt: "2026-09-30T01:00:00Z", variants: [{ id: 3001, title: "Default Title", sku: "CANDLE-L", price: "23.00" }] };

  type Options = { store?: Partial<StoreState>; body?: Record<string, unknown> };

  async function setup(options: Options = {}) {
    organisations += 1;
    const org = `fixes-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const actor = { userId: owner.id, email: owner.email };
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, actor, work);
    await as(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "EXPORT", label: "Exports", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01" });
      await updateOrganisationSettings(tx, { gstNumber: "123-456-789", gstRegistered: true, exportTaxCode: "EXPORT" });
    });
    const state = storeState({ customers: [], products: [CANDLE, PENDANT], ...options.store });
    setSalesPlatformFetchForTests(fakeShopifyStore(state));
    const record = (await getOrganisation(org))!;
    const connection = await connectStore(
      record,
      actor,
      { platform: "shopify", storeDomain: DOMAIN, authMethod: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, ...options.body },
      { webhookOrigin: null, now: CONNECTED_AT },
    );
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
    return {
      as,
      state,
      connectionId: connection.id,
      initialScope: connection.customerScope,
      sync: (at: string) => syncConnection(record, connection.id, undefined, new Date(at)),
      connection: async () => (await as((tx) => listConnections(tx))).find((entry) => entry.id === connection.id)!,
      log: async () => (await as((tx) => listSyncLog(tx, connection.id))).entries,
      items: async () =>
        (await as((tx) => tx.query<{ id: string; code: string; name: string }>("select id::text, code, name from items order by items.id"))).rows,
      contacts: async () =>
        (await as((tx) => tx.query<{ id: string; name: string; email: string | null }>("select id::text, name, email from contacts where is_customer order by contacts.id"))).rows,
      doc: async (externalId: string) =>
        (
          await as((tx) =>
            tx.query<{ state: string; retry: boolean; contact_id: string | null; invoice_id: string | null }>(
              "select state, retry, contact_id::text, invoice_id::text from sales_platform_documents where record_kind = 'order' and external_id = $1",
              [externalId],
            ),
          )
        ).rows[0] ?? null,
    };
  }

  const GST = (amount: string) => [{ title: "GST", rate: 0.15, amount }];
  const customer = (id: number, first: string, last: string, email: string | null, extra: Partial<CustomerFixture> = {}): CustomerFixture => ({
    id,
    first,
    last,
    email,
    country: "NZ",
    updatedAt: "2026-09-30T00:00:00Z",
    ...extra,
  });
  /** A paid order for one Large candle (23.00 incl. 3.00 GST). */
  const candleOrder = (id: number, number: number, who: CustomerFixture | null, processedAt: string, extra: Partial<OrderFixture> = {}): OrderFixture => ({
    id,
    name: `#${number}`,
    processedAt,
    updatedAt: processedAt,
    financialStatus: "PAID",
    taxesIncluded: true,
    total: "23.00",
    customer: who,
    billingCountry: "NZ",
    lines: [{ id: id * 10, name: "Large candle", sku: "CANDLE-L", quantity: 1, variantId: 3001, originalTotal: "23.00", tax: GST("3.00") }],
    transactions: [{ id: id * 10 + 1, kind: "SALE", amount: "23.00", processedAt }],
    ...extra,
  });

  it("SPC38: variants without a SKU come in by their Shopify ID, once, and take a SKU added later", async () => {
    const w = await setup();
    await w.sync("2026-10-01T01:00:00Z");
    const first = await w.items();
    expect(first.map((item) => [item.code, item.name])).toEqual([
      ["CANDLE-L", "Large candle"],
      ["SHOPIFY-3101", "Paw print pendant - Silver"],
      ["SHOPIFY-3102", "Paw print pendant - Gold"],
    ]);
    expect((await w.log()).some((entry) => /has no SKU, so it wasn't/.test(entry.message))).toBe(false);
    expect((await w.connection()).productVariants).toEqual({ linked: 3, withoutSku: 2 });

    // Read again in full (as after the update): nothing new.
    await w.as((tx) => tx.query("update sales_platform_connections set products_synced_until = null where id = $1", [w.connectionId]));
    await w.sync("2026-10-01T02:00:00Z");
    expect(await w.items()).toEqual(first);

    // A SKU added in Shopify: the same item, now with the SKU as its code.
    w.state.products = [
      CANDLE,
      { ...PENDANT, updatedAt: "2026-10-01T03:00:00Z", variants: [{ ...PENDANT.variants[0], sku: "PAW-SILVER" }, PENDANT.variants[1]] },
    ];
    await w.sync("2026-10-01T04:00:00Z");
    const after = await w.items();
    expect(after.map((item) => [item.id, item.code])).toEqual([
      [first[0].id, "CANDLE-L"],
      [first[1].id, "PAW-SILVER"],
      [first[2].id, "SHOPIFY-3102"],
    ]);
    expect((await w.connection()).productVariants).toEqual({ linked: 3, withoutSku: 1 });

    // An order for the variant without a SKU sells the linked item.
    const buyer = customer(1301, "Ana", "Rangi", "ana@made-up.test");
    w.state.orders.push({
      ...candleOrder(5301, 1301, buyer, "2026-10-02T01:00:00Z"),
      total: "129.00",
      lines: [{ id: 53011, name: "Paw print pendant - Gold", sku: null, quantity: 1, variantId: 3102, originalTotal: "129.00", tax: GST("16.83") }],
      transactions: [{ id: 53012, kind: "SALE", amount: "129.00", processedAt: "2026-10-02T01:00:00Z" }],
    });
    await w.sync("2026-10-02T02:00:00Z");
    const invoice = await w.as(async (tx) => getInvoice(tx, (await w.doc("5301"))!.invoice_id));
    expect(invoice.lines.map((line) => line.itemId)).toEqual([first[2].id]);
  });

  it("SPC39: only customers who have ordered by default; test customers are left out; contacts already in stay", async () => {
    const kept = customer(1401, "Tui", "Waaka", "tui@made-up.test");
    const nameless = customer(1402, "", "", "pip@made-up.test");
    const test = customer(1403, "Shop", "Tester", "shop.tester@made-up.test", { tags: ["test"] });
    const example = customer(1404, "Example", "Person", "person@example.com");
    const w = await setup({ store: { customers: [kept, nameless, test, example] } });
    expect(w.initialScope).toBe("buyers");
    await w.sync("2026-10-01T01:00:00Z");
    expect(await w.contacts()).toEqual([]);

    // Pip's first order brings them in, named from the billing address (Shopify has no name for them).
    w.state.orders.push(candleOrder(5401, 1401, nameless, "2026-10-02T01:00:00Z", { billingName: { first: "Pip", last: "Rua  Rua" } }));
    await w.sync("2026-10-02T02:00:00Z");
    expect((await w.contacts()).map((c) => [c.name, c.email])).toEqual([["Pip Rua Rua", "pip@made-up.test"]]);
    expect((await w.doc("5401"))!.state).toBe("done");

    // A later change to Pip in Shopify is copied, but the email standing in for their name doesn't rename them.
    w.state.customers = [kept, { ...nameless, email: "pip.new@made-up.test", updatedAt: "2026-10-03T00:00:00Z" }, test, example];
    await w.sync("2026-10-03T01:00:00Z");
    expect((await w.contacts()).map((c) => [c.name, c.email])).toEqual([["Pip Rua Rua", "pip.new@made-up.test"]]);

    // All customers: everyone is read again; the test customers aren't added.
    await w.as((tx) => updateConnectionSettings(tx, w.connectionId, { customerScope: "all" }));
    await w.sync("2026-10-03T02:00:00Z");
    expect((await w.contacts()).map((c) => c.name)).toEqual(["Pip Rua Rua", "Tui Waaka"]);
    const skipped = (await w.log()).filter((entry) => entry.action === "skipped" && entry.recordKind === "customer").map((entry) => entry.message);
    expect(skipped.sort()).toEqual([
      'Shopify customer Example Person is a test customer (its email is at example.com, a made-up address), so no contact was added.',
      'Shopify customer Shop Tester is a test customer (it\'s tagged "test"), so no contact was added.',
    ]);

    // Back to buyers only: nothing already brought in is removed.
    await w.as((tx) => updateConnectionSettings(tx, w.connectionId, { customerScope: "buyers" }));
    await w.sync("2026-10-03T03:00:00Z");
    expect((await w.contacts()).map((c) => c.name)).toEqual(["Pip Rua Rua", "Tui Waaka"]);
    expect((await w.log())[0].message).not.toMatch(/removed|deleted/i);
    const settings = (await w.log()).find((entry) => entry.action === "settings")!;
    expect(settings.message).toBe("Customers: only those who have ordered (contacts already brought in stay).");

    // The AI's read-only diagnostics say what buyers only means, and count the test customers by reason.
    const report = await w.as((tx) => salesPlatformDiagnostics(tx, {}, new Date("2026-10-03T03:01:00Z")));
    const customers = (report as unknown as { connections: Array<{ imports: { customers: Record<string, unknown> } }> }).connections[0].imports.customers;
    expect(customers).toMatchObject({ scope: "buyers", problems: { test_customer: { count: 2 } } });
  });

  it("SPC40: a single first name is weak evidence: the buyer gets their own contact and the order posts", async () => {
    const w = await setup();
    await w.as(async (tx) => {
      await createContact(tx, { idempotencyKey: key("c"), name: "Kiri", email: "kiri.a@made-up.test", isCustomer: true });
      await createContact(tx, { idempotencyKey: key("c"), name: "Mere Tane", email: "mere.a@made-up.test", isCustomer: true });
    });
    const kiri = customer(1501, "Kiri", "", "kiri.b@made-up.test");
    const mere = customer(1502, "Mere", "Tane", "mere.b@made-up.test");
    w.state.orders.push(candleOrder(5501, 1501, kiri, "2026-10-02T01:00:00Z"), candleOrder(5502, 1502, mere, "2026-10-02T02:00:00Z"));
    await w.sync("2026-10-02T03:00:00Z");

    expect((await w.contacts()).map((c) => [c.name, c.email])).toEqual([
      ["Kiri", "kiri.a@made-up.test"],
      ["Mere Tane", "mere.a@made-up.test"],
      ["Kiri (kiri.b@made-up.test)", "kiri.b@made-up.test"],
    ]);
    expect((await w.doc("5501"))!.state).toBe("done");
    const added = (await w.log()).find((entry) => entry.action === "created" && entry.externalId === "1501")!;
    expect(added.message).toBe("Added contact Kiri (kiri.b@made-up.test) from Shopify customer 1501 (billing country NZ): contact Kiri has the same name, but a single name doesn't show they're the same person.");

    // A full name still waits for a person to check (#539), and its order waits with a reason the AI can count.
    expect((await w.doc("5502"))!).toMatchObject({ state: "open", retry: true, invoice_id: null });
    expect((await w.as((tx) => listCustomerMatches(tx, w.connectionId))).matches.map((m) => m.name)).toEqual(["Mere Tane"]);
    const report = await w.as((tx) => salesPlatformDiagnostics(tx, {}, new Date("2026-10-02T03:01:00Z")));
    const orders = (report as unknown as { connections: Array<{ imports: { orders: Record<string, unknown> } }> }).connections[0].imports.orders;
    expect(orders).toMatchObject({ problems: { customer_not_linked: { count: 1 } } });

    // Syncing again adds no second Kiri.
    await w.sync("2026-10-02T04:00:00Z");
    expect((await w.contacts()).length).toBe(3);
  });

  it("SPC41: customers left waiting under the old rule are looked at again, and their orders post", async () => {
    const w = await setup({ body: { customerScope: "all" } });
    const hemi = customer(1601, "Hemi", "", "hemi.b@made-up.test");
    const ana = customer(1602, "Ana", "", null, { email: null });
    const existing = await w.as(async (tx) => {
      const one = await createContact(tx, { idempotencyKey: key("c"), name: "Hemi", email: "hemi.a@made-up.test", isCustomer: true });
      const two = await createContact(tx, { idempotencyKey: key("c"), name: "Ana", email: null, isCustomer: true });
      return [one.contact.id, two.contact.id];
    });
    // What the earlier version left: both remembered to check, and Hemi's order waiting for them.
    w.state.orders.push(candleOrder(5601, 1601, hemi, "2026-10-02T01:00:00Z"));
    await w.as(async (tx) => {
      for (const [who, contactId] of [
        [hemi, existing[0]],
        [ana, existing[1]],
      ] as const) {
        await rememberCustomerMatch(tx, w.connectionId, { externalId: String(who.id), name: who.first, email: who.email, phone: null, country: "NZ", updatedAt: who.updatedAt, contactId });
      }
      await tx.query(
        "insert into sales_platform_documents (platform, store_domain, record_kind, external_id, connection_id, name, state, retry) values ('shopify', $1, 'order', '5601', $2, '#1601', 'open', true)",
        [DOMAIN, w.connectionId],
      );
      // The order was seen already: only the retry brings it back.
      await tx.query("update sales_platform_connections set orders_synced_until = '2026-10-02T05:00:00Z' where id = $1", [w.connectionId]);
    });
    await w.sync("2026-10-03T01:00:00Z");
    expect((await w.contacts()).map((c) => c.name).sort()).toEqual(["Ana", "Ana (Shopify)", "Hemi", "Hemi (hemi.b@made-up.test)"]);
    expect((await w.as((tx) => listCustomerMatches(tx, w.connectionId))).total).toBe(0);
    expect((await w.doc("5601"))!).toMatchObject({ state: "done", retry: false });
  });

  it("SPC42: the first sync posts orders oldest first, so invoice numbers run in date order", async () => {
    const w = await setup();
    const buyer = customer(1701, "Rua", "Kaha", "rua@made-up.test");
    // Shopify lists by when each order last changed, which isn't when it was placed.
    w.state.orders.push(
      candleOrder(5703, 1703, buyer, "2026-10-20T01:00:00Z", { updatedAt: "2026-10-21T00:00:00Z" }),
      candleOrder(5701, 1701, buyer, "2026-10-11T01:00:00Z", { updatedAt: "2026-10-30T00:00:00Z" }),
      candleOrder(5702, 1702, buyer, "2026-10-15T01:00:00Z", { updatedAt: "2026-10-22T00:00:00Z" }),
    );
    await w.sync("2026-11-01T00:00:00Z");
    const numbers = [];
    for (const id of ["5701", "5702", "5703"]) {
      const invoice = await w.as(async (tx) => getInvoice(tx, (await w.doc(id))!.invoice_id));
      numbers.push([invoice.invoiceNumber, invoice.invoiceDate]);
    }
    expect(numbers).toEqual([
      ["INV-0001", "2026-10-11"],
      ["INV-0002", "2026-10-15"],
      ["INV-0003", "2026-10-20"],
    ]);
    // A later sync carries on from there.
    w.state.orders.push(candleOrder(5704, 1704, buyer, "2026-11-02T01:00:00Z"));
    await w.sync("2026-11-02T02:00:00Z");
    expect((await w.as(async (tx) => getInvoice(tx, (await w.doc("5704"))!.invoice_id))).invoiceNumber).toBe("INV-0004");
  });
});

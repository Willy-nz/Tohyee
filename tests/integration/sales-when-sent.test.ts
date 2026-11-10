import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { getInvoice } from "@/lib/invoices/service";
import { correctJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { getOrganisation } from "@/lib/organisations/registry";
import { connectStore, syncConnection, updateConnectionSettings } from "@/lib/sales-platforms/service";
import { listOrdersToSend } from "@/lib/sales-platforms/to-send";
import { listHeldOrders, markHeldOrderSent } from "@/lib/sales-platforms/when-sent";
import { setSalesPlatformFetchForTests } from "@/lib/sales-platforms/shopify";
import { createTaxCode } from "@/lib/tax/codes";
import { AROHA, CLIENT_ID, CLIENT_SECRET, type OrderFixture, fakeShopifyStore, storeState } from "../helpers/fake-shopify-orders";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
const GST = (amount: string) => [{ title: "GST", rate: 0.15, amount }];

/**
 * #1001 as in SWS1 (made-up): Paw pendant (GIFTBOX, a stock item) 115.00,
 * Impression kit (CANDLE-L, not stock) 23.00, shipping 11.50, paid 1 Nov.
 */
function order(overrides: Partial<OrderFixture> = {}): OrderFixture {
  return {
    id: 7001,
    name: "#1001",
    processedAt: "2026-10-31T20:00:00Z",
    updatedAt: "2026-10-31T20:01:00Z",
    financialStatus: "PAID",
    taxesIncluded: true,
    total: "149.50",
    customer: AROHA,
    billingCountry: "NZ",
    lines: [
      { id: 8001, name: "Paw pendant", sku: "GIFTBOX", quantity: 1, variantId: 3004, originalTotal: "115.00", tax: GST("15.00") },
      { id: 8002, name: "Impression kit", sku: "CANDLE-L", quantity: 1, variantId: 3001, originalTotal: "23.00", tax: GST("3.00") },
    ],
    shipping: [{ id: 8101, title: "NZ Post", amount: "11.50", tax: GST("1.50") }],
    transactions: [{ id: 9701, kind: "SALE", amount: "149.50", processedAt: "2026-10-31T20:00:00Z" }],
    ...overrides,
  };
}

/** Shopify sales when sent (SWS1-SWS9; not yet reviewed). Not tried against a real store. */
describeWithDatabase("Shopify sales when sent", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("jess@sales-when-sent.nz", { serverAdmin: true, displayName: "Jess" });
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });
  afterEach(() => setSalesPlatformFetchForTests(null));
  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  /** Glimmers Ltd as in SPC11, posting from 1 Oct, with sales when sent on (Income in advance 2350) unless `whenSent` is false. */
  async function setup(options: { whenSent?: boolean; pendants?: number } = {}) {
    organisations += 1;
    const org = `when-sent-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const actor = { userId: owner.id, email: owner.email };
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, actor, work);
    await as(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "EXPORT", label: "Exports", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01" });
      await updateOrganisationSettings(tx, { gstNumber: "123-456-789", gstRegistered: true, exportTaxCode: "EXPORT" });
    });
    const state = storeState();
    setSalesPlatformFetchForTests(fakeShopifyStore(state));
    const record = (await getOrganisation(org))!;
    const connection = await connectStore(
      record,
      actor,
      { platform: "shopify", storeDomain: "glimmers", authMethod: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      { webhookOrigin: null, now: new Date("2026-10-01T00:03:01Z") },
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
        ...(options.whenSent === false ? {} : { newSalesWhenSentAccount: { code: "2350", name: "Income in advance" } }),
      }),
    );
    const sync = (at: string) => syncConnection(record, connection.id, undefined, new Date(at));
    // The products come in (GIFTBOX is a stock item), then pendants are bought at 20.00 each.
    await sync("2026-10-01T01:00:00Z");
    const giftBox = (await as((tx) => tx.query<{ id: string }>("select id from items where code = 'GIFTBOX'"))).rows[0];
    const supplier = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Silver Co", isSupplier: true }))).contact;
    const bill = await as((tx) =>
      createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: supplier.id,
        billDate: "2026-10-01",
        dueDate: "2026-10-20",
        supplierInvoiceNumber: "S-1",
        amountsMode: "exclusive",
        lines: [{ itemId: giftBox.id, description: "Pendants", quantity: String(options.pendants ?? 1), unitPrice: "20.00", accountCode: "1400", taxCode: "GST" }],
      }),
    );
    await as((tx) => approveBill(tx, bill.bill.id, { idempotencyKey: key("a") }));
    return { org, as, state, connectionId: connection.id, sync };
  }
  type World = Awaited<ReturnType<typeof setup>>;

  const balance = async (w: World, code: string) =>
    (
      await w.as((tx) =>
        tx.query<{ net: string }>(
          `select to_char(coalesce(sum(l.debit_amount - l.credit_amount), 0), 'FM999999990.00') as net
             from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = $1`,
          [code],
        ),
      )
    ).rows[0].net;
  /** Income in advance, sales, cost of goods sold and inventory. */
  const books = async (w: World) => ({ held: await balance(w, "2350"), sales: await balance(w, "4000"), cogs: await balance(w, "5000"), stock: await balance(w, "1400") });
  const sentJournals = async (w: World) =>
    (
      await w.as((tx) =>
        tx.query<{ id: string; posting_date: string; reference: string }>(
          "select id::text, posting_date::text, reference from ledger_journals where origin = 'sales_when_sent' order by id",
        ),
      )
    ).rows;
  const invoiceOf = async (w: World, orderId: string) => {
    const row = (await w.as((tx) => tx.query<{ invoice_id: string }>("select invoice_id::text from sales_platform_documents where external_id = $1", [orderId]))).rows[0];
    return w.as((tx) => getInvoice(tx, row.invoice_id));
  };

  it("SWS1-SWS3: invoiced when paid (GST then), held until sent, then sales and stock line by line", async () => {
    const w = await setup();
    w.state.orders.push(order());
    await w.sync("2026-11-01T02:00:00Z");
    const invoice = await invoiceOf(w, "7001");
    expect(invoice).toMatchObject({ invoiceDate: "2026-11-01", total: "149.50", taxTotal: "19.50" });
    expect(invoice.lines.map((line) => [line.description, line.accountCode, line.itemId])).toEqual([
      ["Paw pendant", "2350", null],
      ["Impression kit", "2350", null],
      ["Shipping: NZ Post", "2350", null],
    ]);
    expect(await books(w)).toEqual({ held: "-130.00", sales: "0.00", cogs: "0.00", stock: "20.00" });

    // SWS2: the kit is sent on 3 Nov (no change to the order's update time: held orders are read every sync).
    w.state.orders[0].fulfilments = [{ id: 9901, createdAt: "2026-11-02T22:00:00Z", lines: [{ lineId: 8002, quantity: 1 }] }];
    await w.sync("2026-11-03T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-100.00", sales: "-30.00", cogs: "0.00", stock: "20.00" });
    expect((await sentJournals(w)).map((j) => [j.posting_date, j.reference])).toEqual([["2026-11-03", "#1001 sent"]]);

    // SWS3: the pendant on 20 Nov: sales and one out of stock at 20.00.
    w.state.orders[0].fulfilments.push({ id: 9902, createdAt: "2026-11-19T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }] });
    await w.sync("2026-11-20T02:00:00Z");
    expect(await books(w)).toEqual({ held: "0.00", sales: "-130.00", cogs: "20.00", stock: "0.00" });
    const movement = (await w.as((tx) => tx.query<{ movement_date: string }>("select movement_date::text from inventory_movements where movement_type = 'issue'"))).rows;
    expect(movement).toEqual([{ movement_date: "2026-11-20" }]);
    // Counted once (SWS8), and nothing more is held, so the order isn't read again.
    await w.sync("2026-11-21T02:00:00Z");
    expect(await books(w)).toEqual({ held: "0.00", sales: "-130.00", cogs: "20.00", stock: "0.00" });
    expect(await sentJournals(w)).toHaveLength(2);

    // SWS9: these journals can't be corrected by hand.
    const first = (await sentJournals(w))[0];
    await expect(
      w.as((tx) => correctJournal(tx, { idempotencyKey: key("fix"), originalJournalId: first.id, postingDate: "2026-11-03", reference: "x", lines: [] })),
    ).rejects.toThrow("can't be corrected in the ledger (SWS9)");
  });

  it("SWS4: part of a line, and a line that isn't sent", async () => {
    const w = await setup({ pendants: 2 });
    w.state.orders.push(
      order({
        total: "253.00",
        lines: [
          { id: 8001, name: "Paw pendant", sku: "GIFTBOX", quantity: 2, variantId: 3004, originalTotal: "230.00", tax: GST("30.00") },
          { id: 8002, name: "Digital proof", sku: "CANDLE-L", quantity: 1, variantId: 3001, originalTotal: "23.00", tax: GST("3.00"), requiresShipping: false },
        ],
        shipping: [],
        transactions: [{ id: 9701, kind: "SALE", amount: "253.00", processedAt: "2026-10-31T20:00:00Z" }],
      }),
    );
    await w.sync("2026-11-01T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-200.00", sales: "-20.00", cogs: "0.00", stock: "40.00" });
    w.state.orders[0].fulfilments = [{ id: 9901, createdAt: "2026-11-04T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }] }];
    await w.sync("2026-11-05T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-100.00", sales: "-120.00", cogs: "20.00", stock: "20.00" });
    w.state.orders[0].fulfilments.push({ id: 9902, createdAt: "2026-11-09T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }] });
    await w.sync("2026-11-10T02:00:00Z");
    expect(await books(w)).toEqual({ held: "0.00", sales: "-220.00", cogs: "40.00", stock: "0.00" });
  });

  it("SWS5: refunded before it's sent comes out of Income in advance, with nothing from stock", async () => {
    const w = await setup();
    w.state.orders.push(order());
    await w.sync("2026-11-01T02:00:00Z");
    Object.assign(w.state.orders[0], {
      updatedAt: "2026-11-02T01:00:00Z",
      refunds: [
        {
          id: 6701,
          processedAt: "2026-11-02T01:00:00Z",
          lines: [{ lineId: 8001, quantity: 1, subtotal: "115.00", tax: "15.00" }],
          transactions: [{ id: 9801, kind: "REFUND", amount: "115.00", processedAt: "2026-11-02T01:00:00Z" }],
        },
      ],
    });
    await w.sync("2026-11-02T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-30.00", sales: "0.00", cogs: "0.00", stock: "20.00" });
    const note = (await w.as((tx) => tx.query<{ code: string; item_id: string | null }>(
      "select a.code, l.item_id::text from sales_credit_note_lines l join accounts a on a.id = l.account_id",
    ))).rows;
    expect(note).toEqual([{ code: "2350", item_id: null }]);
    // The kit is sent: kit and shipping to sales; the pendant has nothing left to send.
    w.state.orders[0].fulfilments = [{ id: 9901, createdAt: "2026-11-03T22:00:00Z", lines: [{ lineId: 8002, quantity: 1 }] }];
    await w.sync("2026-11-04T02:00:00Z");
    expect(await books(w)).toEqual({ held: "0.00", sales: "-30.00", cogs: "0.00", stock: "20.00" });
    const open = (await w.as((tx) => tx.query<{ n: string }>("select count(*)::text as n from sales_platform_held_lines where not closed"))).rows[0].n;
    expect(open).toBe("0");
  });

  it("SWS6-SWS7: an amount refunded off an unsent line; the rest counts when it's sent", async () => {
    const w = await setup();
    w.state.orders.push(order());
    await w.sync("2026-11-01T02:00:00Z");
    Object.assign(w.state.orders[0], {
      updatedAt: "2026-11-02T01:00:00Z",
      refunds: [
        {
          id: 6702,
          processedAt: "2026-11-02T01:00:00Z",
          lines: [{ lineId: 8001, quantity: 0, subtotal: "57.50", tax: "7.50" }],
          transactions: [{ id: 9802, kind: "REFUND", amount: "57.50", processedAt: "2026-11-02T01:00:00Z" }],
        },
      ],
    });
    await w.sync("2026-11-02T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-80.00", sales: "0.00", cogs: "0.00", stock: "20.00" });
    w.state.orders[0].fulfilments = [{ id: 9901, createdAt: "2026-11-03T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }, { lineId: 8002, quantity: 1 }] }];
    await w.sync("2026-11-04T02:00:00Z");
    expect(await books(w)).toEqual({ held: "0.00", sales: "-80.00", cogs: "20.00", stock: "0.00" });
  });

  it("SWS8: sent before it was paid counts on the invoice date; a cancelled fulfilment counts for nothing", async () => {
    const w = await setup();
    w.state.orders.push(
      order({
        fulfilments: [
          { id: 9901, createdAt: "2026-10-30T22:00:00Z", lines: [{ lineId: 8002, quantity: 1 }] },
          { id: 9902, createdAt: "2026-10-30T23:00:00Z", status: "CANCELLED", lines: [{ lineId: 8001, quantity: 1 }] },
        ],
      }),
    );
    await w.sync("2026-11-01T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-100.00", sales: "-30.00", cogs: "0.00", stock: "20.00" });
    expect((await sentJournals(w)).map((j) => j.posting_date)).toEqual(["2026-11-01"]);
  });

  it("SWS9: only orders brought in while it's on are held", async () => {
    const w = await setup({ whenSent: false, pendants: 2 });
    w.state.orders.push(order());
    await w.sync("2026-11-01T02:00:00Z");
    expect(await books(w)).toEqual({ held: "0.00", sales: "-130.00", cogs: "20.00", stock: "20.00" });
    await w.as((tx) => updateConnectionSettings(tx, w.connectionId, { newSalesWhenSentAccount: { code: "2350", name: "Income in advance" } }));
    w.state.orders.push(
      order({ id: 7002, name: "#1002", processedAt: "2026-11-01T20:00:00Z", updatedAt: "2026-11-01T20:01:00Z", transactions: [{ id: 9702, kind: "SALE", amount: "149.50", processedAt: "2026-11-01T20:00:00Z" }] }),
    );
    await w.sync("2026-11-02T02:00:00Z");
    expect(await books(w)).toEqual({ held: "-130.00", sales: "-130.00", cogs: "20.00", stock: "20.00" });
    // Turned off: #1002 is still counted when it's sent.
    await w.as((tx) => updateConnectionSettings(tx, w.connectionId, { salesWhenSentAccountCode: null }));
    w.state.orders[1].fulfilments = [{ id: 9903, createdAt: "2026-11-02T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }, { lineId: 8002, quantity: 1 }] }];
    await w.sync("2026-11-03T02:00:00Z");
    expect(await books(w)).toEqual({ held: "0.00", sales: "-260.00", cogs: "40.00", stock: "0.00" });
    // Not a liability account, or a WooCommerce store: refused.
    await expect(w.as((tx) => updateConnectionSettings(tx, w.connectionId, { salesWhenSentAccountCode: "4000" }))).rejects.toThrow("isn't a liability account");
  });

  it("SWS10: an order Shopify never marked sent can be marked sent in Tohyee", async () => {
    const w = await setup();
    w.state.orders.push(order());
    await w.sync("2026-11-01T02:00:00Z");
    expect(await w.as((tx) => listHeldOrders(tx, w.connectionId))).toEqual([
      { orderId: "7001", name: "#1001", invoiceDate: "2026-11-01", held: "130.00", lines: ["Paw pendant", "Impression kit", "Shipping: NZ Post"] },
    ]);
    await expect(w.as((tx) => markHeldOrderSent(tx, w.connectionId, "7001", "2026-10-30"))).rejects.toThrow("can't be before its invoice (1 Nov 2026)");
    await w.as((tx) => markHeldOrderSent(tx, w.connectionId, "7001", "2026-11-15"));
    expect(await books(w)).toEqual({ held: "0.00", sales: "-130.00", cogs: "20.00", stock: "0.00" });
    expect((await sentJournals(w)).map((j) => [j.posting_date, j.reference])).toEqual([["2026-11-15", "#1001 marked sent"]]);
    expect(await w.as((tx) => listHeldOrders(tx, w.connectionId))).toEqual([]);
    const said = (await w.as((tx) => tx.query<{ message: string }>("select message from sales_platform_sync_log where message like '%marked as sent%'"))).rows;
    expect(said[0].message).toContain("#1001 marked as sent on 15 Nov 2026 by jess@sales-when-sent.nz");
    // Nothing left: marking again is refused, and Shopify's fulfilment later counts for nothing.
    await expect(w.as((tx) => markHeldOrderSent(tx, w.connectionId, "7001", "2026-11-16"))).rejects.toThrow("has nothing left to send");
    w.state.orders[0].fulfilments = [{ id: 9901, createdAt: "2026-11-19T22:00:00Z", lines: [{ lineId: 8001, quantity: 1 }, { lineId: 8002, quantity: 1 }] }];
    await w.sync("2026-11-20T02:00:00Z");
    expect(await books(w)).toEqual({ held: "0.00", sales: "-130.00", cogs: "20.00", stock: "0.00" });
  });

  it("SWS11: Sales › To send lists orders not yet fully sent, from Shopify's status or what's held", async () => {
    const w = await setup({ whenSent: false, pendants: 3 });
    const paid = (id: number, at: string) => [{ id, kind: "SALE", amount: "149.50", processedAt: at }];
    w.state.orders.push(order({ fulfilmentStatus: "UNFULFILLED" }));
    w.state.orders.push(order({ id: 7002, name: "#1002", processedAt: "2026-10-31T21:00:00Z", updatedAt: "2026-10-31T21:01:00Z", fulfilmentStatus: "FULFILLED", transactions: paid(9702, "2026-10-31T21:00:00Z") }));
    await w.sync("2026-11-01T02:00:00Z");
    expect(await w.as((tx) => listOrdersToSend(tx))).toMatchObject({
      held: "0.00",
      orders: [{ name: "#1001", customer: "Aroha Ngata", total: "149.50", status: "not_sent", held: null, date: "2026-11-01" }],
    });
    // On: #1003 is held, and part sent.
    await w.as((tx) => updateConnectionSettings(tx, w.connectionId, { newSalesWhenSentAccount: { code: "2350", name: "Income in advance" } }));
    w.state.orders.push(
      order({
        id: 7003,
        name: "#1003",
        processedAt: "2026-11-01T20:00:00Z",
        updatedAt: "2026-11-01T20:01:00Z",
        fulfilmentStatus: "PARTIALLY_FULFILLED",
        transactions: paid(9703, "2026-11-01T20:00:00Z"),
        fulfilments: [{ id: 9911, createdAt: "2026-11-01T21:00:00Z", lines: [{ lineId: 8002, quantity: 1 }] }],
      }),
    );
    await w.sync("2026-11-02T02:00:00Z");
    const list = await w.as((tx) => listOrdersToSend(tx));
    expect(list.held).toBe("100.00");
    expect(list.orders.map((o) => [o.name, o.status, o.held, o.toSend])).toEqual([
      ["#1001", "not_sent", null, []],
      ["#1003", "part_sent", "100.00", ["Paw pendant"]],
    ]);
    await w.as((tx) => markHeldOrderSent(tx, w.connectionId, "7003", "2026-11-05"));
    expect((await w.as((tx) => listOrdersToSend(tx))).orders.map((o) => o.name)).toEqual(["#1001"]);
  });
});

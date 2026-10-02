import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import * as connectionRoute from "@/app/api/sales-platforms/connections/[connectionId]/route";
import * as logRoute from "@/app/api/sales-platforms/connections/[connectionId]/log/route";
import * as webhookRoute from "@/app/api/sales-platforms/webhooks/[organisationId]/[webhookKey]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { suggestionsForLine } from "@/lib/bank/reconcile";
import { approveBill, createBill } from "@/lib/bills/service";
import { createContact, getContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getInvoice } from "@/lib/invoices/service";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { dec, toFixedString } from "@/lib/money/decimal";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { getSalesOrder } from "@/lib/sales-orders/service";
import { connectStore, listSyncLog, syncConnection, updateConnectionSettings } from "@/lib/sales-platforms/service";
import { SHOP_NOT_PERMITTED, setSalesPlatformFetchForTests } from "@/lib/sales-platforms/shopify";
import { createTaxCode } from "@/lib/tax/codes";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  type OrderFixture,
  type StoreState,
  fakeShopifyStore,
  order1001,
  order1002,
  order1003,
  order1004,
  order1005,
  orderWebhookBody,
  payout70001,
  payout70002,
  refund6001,
  refundWebhookBody,
  signedWebhook,
  storeState,
} from "../helpers/fake-shopify-orders";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
/** Connected a minute before the examples' first order, so the first token lasts until 2026-10-02T00:03Z (SPC19). */
const CONNECTED_AT = new Date("2026-10-01T00:03:01Z");

/** Examples SPC11-SPC23 in docs/ACCOUNTING-EXAMPLES.md ("Sales platform connections, stage 2"). Not tried against a real store. */
describeWithDatabase("Shopify orders into the accounts (stage 2)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let bookkeeper: SessionUser;
  let organisations = 0;
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("jess@glimmers-orders.nz", { serverAdmin: true, displayName: "Jess" });
    viewer = await createTestUser("viewer@glimmers-orders.nz");
    bookkeeper = await createTestUser("books@glimmers-orders.nz");
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });

  afterEach(() => {
    setSalesPlatformFetchForTests(null);
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  type Options = { gst?: boolean; foreignTrade?: boolean; post?: boolean; store?: Partial<StoreState> };

  /** Glimmers Ltd as in the examples' setup: GST registered, prices include tax, posting on from 1 Oct 2026. */
  async function setup(options: Options = {}) {
    organisations += 1;
    const org = `orders-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer'), ($1, $3, 'bookkeeper')", [
      org,
      viewer.id,
      bookkeeper.id,
    ]);
    const actor = { userId: owner.id, email: owner.email };
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, actor, work);
    await as(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "EXPORT", label: "Exports", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01" });
      await updateOrganisationSettings(tx, {
        gstNumber: options.gst === false ? null : "123-456-789",
        foreignTrade: options.foreignTrade === true,
        exportTaxCode: "EXPORT",
      });
    });
    const state = storeState(options.store);
    setSalesPlatformFetchForTests(fakeShopifyStore(state));
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
    const webhookKey = (await as((tx) => tx.query<{ k: string }>("select webhook_key as k from sales_platform_connections where id = $1", [connection.id])))
      .rows[0].k;
    const path = { organisationId: org, webhookKey };
    let deliveries = 0;
    return {
      org,
      as,
      actor,
      record,
      state,
      connectionId: connection.id,
      path,
      sync: (at: string) => syncConnection(record, connection.id, undefined, new Date(at)),
      /** A signed order webhook (SPC18). */
      orderHook: async (topic: string, order: OrderFixture, id = `D-${(deliveries += 1)}`) => {
        const response = await webhookRoute.POST(signedWebhook(path, topic, orderWebhookBody(order), { id }), params(path));
        return { status: response.status, message: (await response.json()).message as string };
      },
      refundHook: async (order: OrderFixture, id = `D-${(deliveries += 1)}`) => {
        const refund = order.refunds![order.refunds!.length - 1];
        const response = await webhookRoute.POST(signedWebhook(path, "refunds/create", refundWebhookBody(order.id, refund), { id }), params(path));
        return { status: response.status, message: (await response.json()).message as string };
      },
    };
  }

  type World = Awaited<ReturnType<typeof setup>>;

  const count = async (w: World, table: string) => Number((await w.as((tx) => tx.query<{ n: string }>(`select count(*)::text as n from ${table}`))).rows[0].n);
  /** A journal as each account's net (debit positive), e.g. { 1100: "46.00", 4000: "-40.00", 2100: "-6.00" }. */
  const journal = async (w: World, journalId: string | null) =>
    Object.fromEntries(
      (
        await w.as((tx) =>
          tx.query<{ code: string; net: string }>(
            `select a.code, to_char(sum(l.debit_amount - l.credit_amount), 'FM999999990.00') as net
               from ledger_journal_lines l join accounts a on a.id = l.account_id
              where l.journal_id = $1 group by a.code order by a.code`,
            [journalId],
          ),
        )
      ).rows.map((row) => [row.code, row.net]),
    );
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
  type Doc = {
    state: string;
    retry: boolean;
    contact_id: string | null;
    sales_order_id: string | null;
    invoice_id: string | null;
    customer_payment_id: string | null;
    credit_note_id: string | null;
    credit_note_refund_id: string | null;
    transfer_id: string | null;
    bank_transaction_id: string | null;
  };
  const doc = async (w: World, kind: string, externalId: string) =>
    (
      await w.as((tx) =>
        tx.query<Doc>(
          `select state, retry, contact_id::text, sales_order_id::text, invoice_id::text, customer_payment_id::text, credit_note_id::text,
                  credit_note_refund_id::text, transfer_id::text, bank_transaction_id::text
             from sales_platform_documents where record_kind = $1 and external_id = $2`,
          [kind, externalId],
        ),
      )
    ).rows[0] ?? null;
  const journalIdOf = async (w: World, table: string, column: string, id: string | null) =>
    (await w.as((tx) => tx.query<{ j: string }>(`select ${column}::text as j from ${table} where id = $1`, [id]))).rows[0]?.j ?? null;
  const log = async (w: World) => (await w.as((tx) => listSyncLog(tx, w.connectionId))).entries;
  /** A record's log lines, oldest first. */
  const logFor = async (w: World, externalId: string) => (await log(w)).filter((entry) => entry.externalId === externalId).reverse();
  const invoiceLines = async (w: World, invoiceId: string | null) =>
    (await w.as((tx) => getInvoice(tx, invoiceId))).lines.map((line) => [line.description, line.quantity, toFixedString(dec(line.unitPrice), 2), line.taxCode, line.taxAmount]);

  it("SPC11, SPC13, SPC14, SPC15, SPC18: orders, a refund and payouts through to a bank line that matches", async () => {
    const w = await setup();
    // The product sync links the variants to items first.
    await w.sync("2026-10-01T01:00:00Z");
    w.state.orders.push(order1001());

    // SPC18: an orders/paid webhook brings #1001 in as SPC11.
    expect(await w.orderHook("orders/paid", order1001(), "W-1")).toEqual({ status: 200, message: "Done." });
    const first = (await doc(w, "order", "5001"))!;
    expect(first).toMatchObject({ state: "done", retry: false });
    const salesOrder = await w.as((tx) => getSalesOrder(tx, first.sales_order_id));
    expect(salesOrder).toMatchObject({ soNumber: "SO-0001", status: "billed", orderDate: "2026-10-02", reference: "#1001", amountsMode: "inclusive", total: "46.00" });
    const invoice = await w.as((tx) => getInvoice(tx, first.invoice_id));
    expect(invoice).toMatchObject({ invoiceNumber: "INV-0001", status: "approved", invoiceDate: "2026-10-02", total: "46.00", taxTotal: "6.00", amountDue: "0.00" });
    expect(await invoiceLines(w, first.invoice_id)).toEqual([["Large candle", "2", "23.00", "GST", "6.00"]]);
    expect(await journal(w, await journalIdOf(w, "sales_invoices", "approval_journal_id", first.invoice_id))).toEqual({ "1100": "46.00", "2100": "-6.00", "4000": "-40.00" });
    expect(await journal(w, await journalIdOf(w, "customer_payments", "journal_id", first.customer_payment_id))).toEqual({ "1010": "46.00", "1100": "-46.00" });
    expect((await logFor(w, "5001")).map((entry) => entry.action)).toEqual(["posted", "posted"]);
    expect((await logFor(w, "5001")).at(-1)).toMatchObject({ documentType: "invoice", documentId: first.invoice_id });

    // The same delivery again, an orders/updated for the unchanged order, and a catch-up sync post nothing more.
    const journals = await count(w, "ledger_journals");
    const calls = w.state.calls.length;
    expect(await w.orderHook("orders/paid", order1001(), "W-1")).toEqual({ status: 200, message: "Already handled." });
    expect(w.state.calls.length).toBe(calls);
    expect(await w.orderHook("orders/updated", order1001(), "W-2")).toEqual({ status: 200, message: "Done." });
    await w.sync("2026-10-02T02:00:00Z");
    expect(await count(w, "ledger_journals")).toBe(journals);
    expect(await count(w, "sales_orders")).toBe(1);
    expect(await count(w, "sales_invoices")).toBe(1);
    expect(await count(w, "customer_payments")).toBe(1);

    // SPC13: shipping and a discount, by the catch-up sync.
    w.state.orders.push(order1002());
    const synced = await w.sync("2026-10-03T01:00:00Z");
    expect(synced).toMatchObject({ posted: 2, failed: 0 });
    const second = (await doc(w, "order", "5002"))!;
    expect(await invoiceLines(w, second.invoice_id)).toEqual([
      ["Wax melts - Vanilla", "2", "7.33", "GST", "1.91"],
      ["Wax melts - Vanilla", "1", "7.34", "GST", "0.96"],
      ["Shipping: NZ Post standard", "1", "6.90", "GST", "0.90"],
    ]);
    expect(await journal(w, await journalIdOf(w, "sales_invoices", "approval_journal_id", second.invoice_id))).toEqual({
      "1100": "28.90",
      "2100": "-3.77",
      "4000": "-25.13",
    });

    // SPC14: a partial refund, by the refunds/create webhook; once only.
    const refunded = order1001({ financialStatus: "PARTIALLY_REFUNDED", updatedAt: "2026-10-05T22:00:30Z", refunds: [refund6001()] });
    w.state.orders[0] = refunded;
    expect(await w.refundHook(refunded, "R-1")).toEqual({ status: 200, message: "Done." });
    expect(await w.refundHook(refunded, "R-1")).toEqual({ status: 200, message: "Already handled." });
    expect(await w.refundHook(refunded, "R-2")).toEqual({ status: 200, message: "Done." });
    expect(await count(w, "sales_credit_notes")).toBe(1);
    const refund = (await doc(w, "refund", "6001"))!;
    const creditNote = (await w.as((tx) => tx.query<{ n: string; d: string; j: string }>("select credit_note_number as n, credit_note_date::text as d, approval_journal_id::text as j from sales_credit_notes where id = $1", [refund.credit_note_id]))).rows[0];
    expect(creditNote).toMatchObject({ n: "CN-0001", d: "2026-10-06" });
    expect(await journal(w, creditNote.j)).toEqual({ "1100": "-23.00", "2100": "3.00", "4000": "20.00" });
    expect(await journal(w, await journalIdOf(w, "sales_credit_note_refunds", "journal_id", refund.credit_note_refund_id))).toEqual({ "1010": "-23.00", "1100": "23.00" });

    // SPC15: payout 70001 (fees 2.52) leaves the clearing account at 0.00.
    w.state.payouts.push(payout70001());
    await w.sync("2026-10-07T04:00:00Z");
    const payout = (await doc(w, "payout", "70001"))!;
    expect(payout.state).toBe("done");
    const transferJournal = await journalIdOf(w, "bank_transfers", "journal_id", payout.transfer_id);
    expect(await journal(w, transferJournal)).toEqual({ "1000": "49.38", "1010": "-49.38" });
    expect(await journal(w, await journalIdOf(w, "bank_transactions", "journal_id", payout.bank_transaction_id))).toEqual({ "1010": "-2.52", "6020": "2.52" });
    expect(await balance(w, "1010")).toBe("0.00");
    const shopifyContact = (await w.as((tx) => tx.query<{ name: string }>("select c.name from bank_transactions t join contacts c on c.id = t.contact_id where t.id = $1", [payout.bank_transaction_id]))).rows[0];
    expect(shopifyContact.name).toBe("Shopify");

    // The bank statement line on 8 Oct is offered the transfer as its exact match.
    const bank = (await w.as((tx) => tx.query<{ id: string }>("select id from accounts where code = '1000'"))).rows[0].id;
    await w.as((tx) =>
      importStatementFile(tx, bank, { idempotencyKey: key("import"), fileName: "statement.csv", fileBase64: Buffer.from("Date,Amount,Payee\n08/10/2026,49.38,SHOPIFY PAYOUT\n").toString("base64") }),
    );
    const line = (await w.as((tx) => listStatementLines(tx, bank, { status: "unreconciled" }))).lines.find((entry) => entry.amount === "49.38")!;
    const { matches } = await w.as((tx) => suggestionsForLine(tx, line.id));
    expect(matches[0]).toMatchObject({ journalId: transferJournal, amount: "49.38", exact: true });

    // SPC16 (Foreign trade off) and the second payout: an adjustment is its own line.
    w.state.orders.push(order1003());
    w.state.payouts.push(payout70002());
    await w.sync("2026-10-14T04:00:00Z");
    const emma = (await doc(w, "order", "5003"))!;
    expect(await w.as((tx) => getContact(tx, emma.contact_id!))).toMatchObject({ name: "Emma Clarke", billingCountry: "AU" });
    expect(await invoiceLines(w, emma.invoice_id)).toEqual([["Large candle", "1", "23.00", "ZERO", "0.00"]]);
    const second70002 = (await doc(w, "payout", "70002"))!;
    expect(await journal(w, await journalIdOf(w, "bank_transfers", "journal_id", second70002.transfer_id))).toEqual({ "1000": "17.33", "1010": "-17.33" });
    const spend = await w.as((tx) => tx.query<{ amount: string }>("select to_char(sum(l.debit_amount), 'FM990.00') as amount from ledger_journal_lines l join accounts a on a.id = l.account_id join bank_transactions t on t.journal_id = l.journal_id where t.id = $1 and a.code = '6020' group by l.id order by l.id", [second70002.bank_transaction_id]));
    expect(spend.rows.map((row) => row.amount)).toEqual(["0.67", "5.00"]);
    expect(await balance(w, "1010")).toBe("0.00");
    // The payouts already posted aren't fetched or posted again.
    const before = await count(w, "ledger_journals");
    w.state.calls.length = 0;
    await w.sync("2026-10-15T04:00:00Z");
    expect(w.state.calls.filter((call) => call.startsWith("balance:"))).toEqual([]);
    expect(await count(w, "ledger_journals")).toBe(before);
  });

  it("SPC12: a non-GST-registered organisation's order has no tax, and the log says why", async () => {
    const w = await setup({ gst: false });
    await w.sync("2026-10-01T01:00:00Z");
    w.state.orders.push(order1001({ lines: [{ ...order1001().lines[0], tax: [] }] }));
    await w.sync("2026-10-02T02:00:00Z");
    const plain = (await doc(w, "order", "5001"))!;
    expect(await w.as((tx) => getInvoice(tx, plain.invoice_id))).toMatchObject({ amountsMode: "no_tax", total: "46.00", taxTotal: "0.00" });
    expect(await journal(w, await journalIdOf(w, "sales_invoices", "approval_journal_id", plain.invoice_id))).toEqual({ "1100": "46.00", "4000": "-46.00" });
    expect(await journal(w, await journalIdOf(w, "customer_payments", "journal_id", plain.customer_payment_id))).toEqual({ "1010": "46.00", "1100": "-46.00" });

    // Had Shopify charged 6.00, the amounts are the same and the log says so.
    w.state.orders.push({ ...order1001(), id: 5011, name: "#1011", updatedAt: "2026-10-02T03:00:00Z", transactions: [{ id: 9011, kind: "SALE", amount: "46.00", processedAt: "2026-10-02T01:30:00Z" }] });
    await w.sync("2026-10-02T04:00:00Z");
    const taxed = (await doc(w, "order", "5011"))!;
    expect(await w.as((tx) => getInvoice(tx, taxed.invoice_id))).toMatchObject({ total: "46.00", taxTotal: "0.00" });
    expect((await logFor(w, "5011")).find((entry) => entry.documentType === "sales_order")?.message).toContain(
      "Shopify charged 6.00 tax; it's part of the sale because the organisation isn't GST registered.",
    );
  });

  it("SPC16: with Foreign trade on, an overseas customer's untaxed line takes the export code", async () => {
    const w = await setup({ foreignTrade: true });
    await w.sync("2026-10-01T01:00:00Z");
    w.state.orders.push(order1003());
    await w.sync("2026-10-08T03:00:00Z");
    const emma = (await doc(w, "order", "5003"))!;
    expect(await invoiceLines(w, emma.invoice_id)).toEqual([["Large candle", "1", "23.00", "EXPORT", "0.00"]]);
    expect(await journal(w, await journalIdOf(w, "sales_invoices", "approval_journal_id", emma.invoice_id))).toEqual({ "1100": "23.00", "4000": "-23.00" });
  });

  it("SPC17: a tracked product is a stock item, sold through the invoice at its cost", async () => {
    const w = await setup();
    await w.sync("2026-10-01T01:00:00Z");
    const giftBox = (await w.as((tx) => tx.query<{ id: string; item_type: string }>("select id, item_type from items where code = 'GIFTBOX'"))).rows[0];
    expect(giftBox.item_type).toBe("stock");
    expect((await w.as((tx) => tx.query<{ item_type: string }>("select item_type from items where code = 'CANDLE-L'"))).rows[0].item_type).toBe("non_stock");
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
    expect(await balance(w, "1400")).toBe("120.00");

    w.state.orders.push(order1004());
    await w.sync("2026-10-09T02:00:00Z");
    const sold = (await doc(w, "order", "5004"))!;
    expect(await journal(w, await journalIdOf(w, "sales_invoices", "approval_journal_id", sold.invoice_id))).toMatchObject({ "1100": "34.50", "2100": "-4.50", "4000": "-30.00" });
    expect(await balance(w, "5000")).toBe("12.00");
    expect(await balance(w, "1400")).toBe("108.00");

    // 20 more than is in stock: the sales order stays approved, the invoice is refused and logged, nothing is posted.
    const journals = await count(w, "ledger_journals");
    w.state.orders.push(order1004({ id: 5006, name: "#1006", updatedAt: "2026-10-09T03:00:00Z", total: "690.00", lines: [{ ...order1004().lines[0], id: 4006, quantity: 20, originalTotal: "690.00", tax: [{ title: "GST", rate: 0.15, amount: "90.00" }] }], transactions: [{ id: 9006, kind: "SALE", amount: "690.00", processedAt: "2026-10-09T03:00:00Z" }] }));
    const result = await w.sync("2026-10-09T04:00:00Z");
    expect(result).toMatchObject({ posted: 1, failed: 1 });
    const big = (await doc(w, "order", "5006"))!;
    expect(big).toMatchObject({ state: "open", retry: true, invoice_id: null });
    expect((await w.as((tx) => getSalesOrder(tx, big.sales_order_id))).status).toBe("pending_billing");
    expect(await count(w, "ledger_journals")).toBe(journals);
    expect((await logFor(w, "5006")).at(-1)).toMatchObject({ action: "failed" });
    expect((await logFor(w, "5006")).at(-1)!.message).toContain("#1006 couldn't be invoiced:");
    // Tried again at the next sync (and logged once, not every time).
    await w.sync("2026-10-09T05:00:00Z");
    expect((await logFor(w, "5006")).filter((entry) => entry.action === "failed")).toHaveLength(1);
  });

  it("SPC19: a client-credentials token is renewed near expiry, stored encrypted, and never shown", async () => {
    const w = await setup();
    // Connecting asked for the first token (expires 2026-10-02T00:03:00Z).
    expect(w.state.issued).toBe(1);
    const stored = async () =>
      (await w.as((tx) => tx.query<{ c: string | null; e: string }>("select access_token_ciphertext as c, access_token_expires_at as e from sales_platform_connections"))).rows[0];
    expect(new Date((await stored()).e).toISOString()).toBe("2026-10-02T00:03:00.000Z");
    await w.sync("2026-10-01T12:00:00Z");
    expect(w.state.issued).toBe(1);
    await w.sync("2026-10-02T00:00:00Z");
    expect(w.state.issued).toBe(2);
    const renewed = await stored();
    expect(new Date(renewed.e).toISOString()).toBe("2026-10-02T23:59:59.000Z");
    expect(renewed.c).not.toContain("shpat_cc_2");
    await w.sync("2026-10-02T01:00:00Z");
    expect(w.state.issued).toBe(2);
    const everything = JSON.stringify([
      await log(w),
      (await w.as((tx) => tx.query("select * from sales_platform_connections"))).rows,
      (await w.as((tx) => tx.query("select details from audit_events"))).rows,
    ]);
    for (const secret of ["shpat_cc_1", "shpat_cc_2", CLIENT_SECRET]) expect(everything).not.toContain(secret);

    // shop_not_permitted: refused with the "same Shopify organisation" message, nothing saved.
    organisations += 1;
    const other = `orders-${organisations}-co`;
    await createTestOrganisation(owner, other);
    setSalesPlatformFetchForTests(fakeShopifyStore(storeState({ notPermitted: true })));
    await expect(
      connectStore((await getOrganisation(other))!, w.actor, { platform: "shopify", storeDomain: "glimmers", authMethod: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, { webhookOrigin: null }),
    ).rejects.toThrow(SHOP_NOT_PERMITTED);
    expect((await inOrganisation(other, w.actor, (tx) => tx.query("select 1 from sales_platform_connections"))).rowCount).toBe(0);
  });

  it("SPC20: cancelled before payment cancels the sales order, with no journals", async () => {
    const w = await setup();
    await w.sync("2026-10-01T01:00:00Z");
    const journals = await count(w, "ledger_journals");
    w.state.orders.push(order1005());
    await w.sync("2026-10-10T01:00:00Z");
    const pending = (await doc(w, "order", "5005"))!;
    expect(pending).toMatchObject({ state: "open", invoice_id: null });
    expect((await w.as((tx) => getSalesOrder(tx, pending.sales_order_id))).status).toBe("pending_billing");
    expect((await logFor(w, "5005")).map((entry) => entry.action)).toEqual(["posted", "waiting"]);
    // Waiting isn't logged again while nothing changes.
    await w.sync("2026-10-10T02:00:00Z");
    expect((await logFor(w, "5005")).map((entry) => entry.action)).toEqual(["posted", "waiting"]);
    const cancelled = order1005({ financialStatus: "VOIDED", cancelledAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" });
    w.state.orders[0] = cancelled;
    expect(await w.orderHook("orders/cancelled", cancelled)).toEqual({ status: 200, message: "Done." });
    expect((await w.as((tx) => getSalesOrder(tx, pending.sales_order_id))).status).toBe("cancelled");
    expect((await doc(w, "order", "5005"))!.state).toBe("cancelled");
    expect(await count(w, "ledger_journals")).toBe(journals);
    // An order cancelled before it was ever brought in is skipped.
    w.state.orders.push(order1005({ id: 5015, name: "#1015", financialStatus: "VOIDED", cancelledAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T01:00:00Z" }));
    await w.sync("2026-10-11T02:00:00Z");
    expect(await count(w, "sales_orders")).toBe(1);
    expect((await logFor(w, "5015"))[0]).toMatchObject({ action: "skipped" });
  });

  it("SPC20: a waiting order that's then cancelled before payment stops being fetched again", async () => {
    const w = await setup();
    // Two contacts share Tama's email, so her order can't be linked to a contact and waits.
    await w.as(async (tx) => {
      await createContact(tx, { idempotencyKey: key("tama-1"), name: "Tama Rewi", email: "tama@example.co.nz", isCustomer: true });
      await createContact(tx, { idempotencyKey: key("tama-2"), name: "T Rewi", email: "tama@example.co.nz", isCustomer: true });
    });
    w.state.orders.push(order1005());
    await w.sync("2026-10-10T01:00:00Z");
    expect(await doc(w, "order", "5005")).toMatchObject({ retry: true, sales_order_id: null });
    w.state.orders[0] = order1005({ financialStatus: "VOIDED", cancelledAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" });
    await w.sync("2026-10-11T01:00:00Z");
    expect((await logFor(w, "5005")).at(-1)).toMatchObject({ action: "skipped" });
    expect(await doc(w, "order", "5005")).toMatchObject({ retry: false, sales_order_id: null });
    // It no longer holds one of the sync's retry places (it would have for good), and nothing is posted.
    await w.sync("2026-10-11T02:00:00Z");
    const retrying = await w.as((tx) => tx.query("select 1 from sales_platform_documents where retry"));
    expect(retrying.rowCount).toBe(0);
    expect(await count(w, "sales_orders")).toBe(0);
  });

  it("SPC21: the start date, the switch and the period lock", async () => {
    const w = await setup({ post: false });
    await w.sync("2026-10-01T01:00:00Z");
    w.state.orders.push(order1001());
    // Switched off: a sync and an order webhook fetch and post nothing.
    w.state.calls.length = 0;
    await w.sync("2026-10-02T02:00:00Z");
    expect(w.state.calls.filter((call) => call.startsWith("order") || call === "payouts")).toEqual([]);
    expect(await w.orderHook("orders/paid", order1001())).toEqual({ status: 200, message: "Posting to the accounts is switched off." });
    expect(w.state.calls.filter((call) => call.startsWith("order"))).toEqual([]);
    expect(await count(w, "sales_orders")).toBe(0);

    // Turning it on without a clearing account, or without read_orders, is refused.
    const turnOn = { postToAccounts: true, startDate: "2026-10-01", payoutAccountCode: "1000", feesAccountCode: "6020", salesAccountCode: "4000", shippingAccountCode: "4000", untaxedTaxCode: "ZERO", taxCodes: [{ rate: "15", taxCode: "GST" }] };
    await expect(w.as((tx) => updateConnectionSettings(tx, w.connectionId, turnOn))).rejects.toThrow("Posting to the accounts needs a clearing account.");
    await w.as((tx) => tx.query("update sales_platform_connections set granted_scopes = '{read_customers,read_products}'"));
    await expect(w.as((tx) => updateConnectionSettings(tx, w.connectionId, { ...turnOn, newClearingAccount: { code: "1010" } }))).rejects.toThrow(
      "Shopify hasn't given the app the read_orders scope",
    );
    await w.as((tx) => tx.query("update sales_platform_connections set granted_scopes = '{read_customers,read_products,read_orders}'"));
    // October locked: the order's sales order comes in, its invoice is refused and logged.
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-10-31" }));
    const on = await w.as((tx) => updateConnectionSettings(tx, w.connectionId, { ...turnOn, newClearingAccount: { code: "1010" } }));
    expect(on).toMatchObject({ postToAccounts: true, startDate: "2026-10-01", clearingAccountCode: "1010" });
    w.state.orders.push(order1001({ id: 5000, name: "#1000", processedAt: "2026-09-30T10:00:00Z", updatedAt: "2026-09-30T10:01:00Z" }));
    const journals = await count(w, "ledger_journals");
    await w.sync("2026-10-02T03:00:00Z");
    expect(await count(w, "ledger_journals")).toBe(journals);
    expect((await doc(w, "order", "5001"))).toMatchObject({ retry: true, invoice_id: null });
    expect((await logFor(w, "5001")).at(-1)!.message).toContain("#1001 couldn't be invoiced:");
    // Payouts aren't read without the scopes; the log says so once.
    expect((await log(w)).filter((entry) => entry.message.startsWith("Payouts aren't brought in"))).toHaveLength(1);
    // Before the start date (30 Sep NZ): never brought in. The order list asks only from the start date.
    expect(await doc(w, "order", "5000")).toBeNull();

    // Unlocked, the next sync posts it once.
    await w.as((tx) => updatePeriodControls(tx, { lockDate: null, reason: "Shopify orders" }));
    await w.sync("2026-10-02T04:00:00Z");
    expect((await doc(w, "order", "5001"))).toMatchObject({ state: "done", retry: false });
    await w.sync("2026-10-02T05:00:00Z");
    expect(await count(w, "sales_invoices")).toBe(1);
    expect(await count(w, "customer_payments")).toBe(1);

    // Switched off again: nothing more is posted, even for a new paid order.
    await w.as((tx) => updateConnectionSettings(tx, w.connectionId, { postToAccounts: false }));
    w.state.orders.push(order1002());
    await w.sync("2026-10-03T01:00:00Z");
    expect(await doc(w, "order", "5002")).toBeNull();
  });

  it("SPC22: only admins change the posting settings; everyone can read the log; the webhook takes only signed deliveries", async () => {
    const w = await setup();
    const id = { connectionId: w.connectionId };
    const body = { organisationId: w.org, startDate: "2026-10-02" };
    for (const user of [viewer, bookkeeper]) {
      const cookie = await sessionCookieFor(user);
      expect((await connectionRoute.PATCH(apiRequest("/x", { method: "PATCH", cookie, body }), params(id))).status).toBe(403);
    }
    const ownerCookie = await sessionCookieFor(owner);
    const changed = await connectionRoute.PATCH(apiRequest("/x", { method: "PATCH", cookie: ownerCookie, body }), params(id));
    expect(changed.status).toBe(200);
    expect((await changed.json()).connection).toMatchObject({ startDate: "2026-10-02", postToAccounts: true, feesAccountCode: "6020", untaxedTaxCode: "ZERO" });
    const read = await logRoute.GET(apiRequest(`/x?organisationId=${w.org}`, { cookie: await sessionCookieFor(viewer) }), params(id));
    expect(read.status).toBe(200);
    // A delivery signed with the wrong secret is refused and does nothing.
    w.state.orders.push(order1001());
    const forged = await webhookRoute.POST(signedWebhook(w.path, "orders/paid", orderWebhookBody(order1001()), { id: "W-9", secret: "not-the-secret" }), params(w.path));
    expect(forged.status).toBe(401);
    expect(await count(w, "sales_orders")).toBe(0);
  });

  it("SPC24: guest checkouts go to the contact chosen for them (decision 317)", async () => {
    const w = await setup();
    const guests = (await w.as((tx) => createContact(tx, { idempotencyKey: key("guests"), name: "Shopify customers", isCustomer: true }))).contact;
    const supplier = (await w.as((tx) => createContact(tx, { idempotencyKey: key("box"), name: "Box Co", isSupplier: true }))).contact;
    await expect(w.as((tx) => updateConnectionSettings(tx, w.connectionId, { guestContactId: supplier.id }))).rejects.toThrow(
      "Box Co isn't an active customer, so guest checkouts can't go to it.",
    );
    const changed = await w.as((tx) => updateConnectionSettings(tx, w.connectionId, { guestContactId: guests.id }));
    expect([changed.guestContactId, changed.guestContactName]).toEqual([String(guests.id), "Shopify customers"]);
    w.state.orders.push(order1001({ id: 5201, name: "#1201", customer: null }));
    await w.sync("2026-10-02T02:00:00Z");
    const posted = (await doc(w, "order", "5201"))!;
    expect(posted.contact_id).toBe(String(guests.id));
    expect(posted.invoice_id).not.toBeNull();
    expect((await w.as((tx) => getInvoice(tx, posted.invoice_id!))).contactId).toBe(guests.id);
    // Cleared: guest checkouts are refused again, saying how to bring them in.
    await w.as((tx) => updateConnectionSettings(tx, w.connectionId, { guestContactId: null }));
    w.state.orders.push(order1001({ id: 5202, name: "#1202", customer: null }));
    await w.sync("2026-10-02T03:00:00Z");
    expect((await logFor(w, "5202")).at(-1)!.message).toBe(
      "#1202 has no Shopify customer (a guest checkout). Choose a contact for guest checkouts in the connection's settings to bring it in.",
    );
  });

  it("SPC23: refused rather than guessed, logged, nothing posted", async () => {
    const w = await setup();
    await w.sync("2026-10-01T01:00:00Z");
    const journals = await count(w, "ledger_journals");
    w.state.orders.push(
      order1001({ id: 5101, name: "#1101", test: true }),
      order1001({ id: 5102, name: "#1102", customer: null }),
      order1001({ id: 5103, name: "#1103", currency: "AUD" }),
      order1001({ id: 5104, name: "#1104", total: "50.00", transactions: [{ id: 9104, kind: "SALE", amount: "50.00", processedAt: "2026-10-02T01:30:00Z" }] }),
      order1001({ id: 5105, name: "#1105", transactions: [{ id: 9105, kind: "SALE", gateway: "gift_card", amount: "46.00", processedAt: "2026-10-02T01:30:00Z" }] }),
      order1001({ id: 5106, name: "#1106", financialStatus: "PARTIALLY_PAID", transactions: [{ id: 9106, kind: "SALE", amount: "20.00", processedAt: "2026-10-02T01:30:00Z" }] }),
    );
    await w.sync("2026-10-02T02:00:00Z");
    const last = async (id: string) => (await logFor(w, id)).at(-1)!;
    expect(await last("5101")).toMatchObject({ action: "failed", message: "#1101 is a test order, so it isn't brought in." });
    expect((await last("5102")).message).toContain("guest checkout");
    expect(await last("5103")).toMatchObject({ action: "failed", message: "#1103 is in AUD; Tohyee only brings in orders in NZD." });
    expect((await last("5104")).message).toContain("Shopify's order total is 50.00");
    expect((await last("5105")).message).toContain("gift card");
    expect(await last("5106")).toMatchObject({ action: "waiting" });
    expect(await count(w, "sales_invoices")).toBe(0);
    // Only the gift-card-paid and partly paid orders have sales orders (they're approved, not invoiced); nothing is in the ledger.
    expect(await count(w, "sales_orders")).toBe(2);
    expect(await count(w, "ledger_journals")).toBe(journals);
    // A refund with an order adjustment, on an invoiced order, is refused too.
    w.state.orders.push(order1001({ updatedAt: "2026-10-05T22:00:30Z", financialStatus: "PARTIALLY_REFUNDED", refunds: [refund6001({ adjustments: 1 })] }));
    await w.sync("2026-10-06T00:00:00Z");
    expect((await doc(w, "order", "5001"))!.state).toBe("done");
    expect(await count(w, "sales_credit_notes")).toBe(0);
    expect((await last("6001")).message).toContain("order adjustment");
    // A withdrawal payout.
    w.state.payouts.push(payout70001({ direction: "WITHDRAWAL" }));
    await w.sync("2026-10-07T04:00:00Z");
    expect((await last("70001")).message).toContain("withdrawal");
    expect(await doc(w, "payout", "70001")).toBeNull();
  });
});

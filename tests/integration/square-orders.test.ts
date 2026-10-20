import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import * as webhookRoute from "@/app/api/sales-platforms/webhooks/[organisationId]/[webhookKey]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount } from "@/lib/bank/accounts";
import type { OrgTx } from "@/lib/db/org-transaction";
import { getInvoice } from "@/lib/invoices/service";
import { createItem } from "@/lib/items/service";
import { dec, toFixedString } from "@/lib/money/decimal";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { setSalesPlatformFetchForTests } from "@/lib/sales-platforms/http";
import { connectStore, listSyncLog, syncConnection, updateConnectionSettings } from "@/lib/sales-platforms/service";
import { decryptSecret } from "@/lib/secrets";
import {
  ACCESS_TOKEN,
  AROHA,
  type SquareState,
  cardPayment,
  cardSale,
  fakeSquare,
  squareState,
  squareWebhook,
} from "../helpers/fake-square";
import { CONSUMER_KEY, CONSUMER_SECRET, fakeWooStore, wooState } from "../helpers/fake-woocommerce";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, startTestServer, type TestServer } from "../helpers/test-server";

const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
const CONNECTED_AT = new Date("2026-10-01T00:00:00Z");
const ORIGIN = "https://tohyee.example.nz";

/**
 * Examples SQ1-SQ10 in docs/ACCOUNTING-EXAMPLES.md ("Square orders into the
 * accounts"). Not tried against a real Square account: the answers come
 * from a pretend Square written from Square's API reference.
 */
describeWithDatabase("Square orders into the accounts (SQ1-SQ10)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("jess@glimmers-square.nz", { serverAdmin: true, displayName: "Jess" });
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });

  afterEach(() => {
    setSalesPlatformFetchForTests(null);
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  /** Glimmers Ltd as in the examples' setup: GST registered, 1070 Square clearing, 1090 Cash till, items CANDLE-L and MELT-VAN. */
  async function setup(account: Partial<SquareState> = {}, options: { webhookOrigin?: string | null; woo?: boolean } = {}) {
    organisations += 1;
    const org = `square-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const actor = { userId: owner.id, email: owner.email };
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, actor, work);
    await as(async (tx) => {
      await updateOrganisationSettings(tx, { gstNumber: "123-456-789" });
      await createBankAccount(tx, { code: "1090", name: "Cash till", accountType: "bank" });
      await createItem(tx, { idempotencyKey: key("item"), code: "CANDLE-L", name: "Large candle", itemType: "non_stock" });
      await createItem(tx, { idempotencyKey: key("item"), code: "MELT-VAN", name: "Wax melts - Vanilla", itemType: "non_stock" });
    });
    const state = squareState(account);
    const square = fakeSquare(state);
    const woo = fakeWooStore(wooState());
    setSalesPlatformFetchForTests((input, init) => (new URL(input).host === "connect.squareup.com" ? square(input, init) : woo(input, init)));
    const record = (await getOrganisation(org))!;
    if (options.woo) {
      await connectStore(record, actor, { platform: "woocommerce", storeDomain: "shop.glimmers.nz", consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET }, { webhookOrigin: null, now: CONNECTED_AT });
    }
    const connection = await connectStore(
      record,
      actor,
      { platform: "square", accessToken: ACCESS_TOKEN },
      { webhookOrigin: options.webhookOrigin === undefined ? ORIGIN : options.webhookOrigin, now: CONNECTED_AT },
    );
    await as((tx) =>
      updateConnectionSettings(tx, connection.id, {
        postToAccounts: true,
        startDate: "2026-10-01",
        newClearingAccount: { code: "1070", name: "Square clearing" },
        payoutAccountCode: "1000",
        feesAccountCode: "6020",
        salesAccountCode: "4000",
        shippingAccountCode: "4000",
        taxCodes: [{ rate: "15", taxCode: "GST" }],
        untaxedTaxCode: "ZERO",
      }),
    );
    const secrets = await as((tx) =>
      tx.query<{ c: string; k: string }>("select credentials_ciphertext as c, webhook_key as k from sales_platform_connections where id = $1", [connection.id]),
    );
    return {
      org,
      as,
      state,
      record,
      actor,
      connection,
      connectionId: connection.id,
      path: { organisationId: org, webhookKey: secrets.rows[0].k },
      credentials: JSON.parse(decryptSecret(secrets.rows[0].c)) as Record<string, string>,
      sync: (at: string) => syncConnection(record, connection.id, undefined, new Date(at)),
      map: (methods: Array<{ method: string; accountCode?: string; leftOwing?: boolean }>) => as((tx) => updateConnectionSettings(tx, connection.id, { paymentMethods: methods })),
    };
  }
  type World = Awaited<ReturnType<typeof setup>>;

  const count = async (w: World, table: string) => Number((await w.as((tx) => tx.query<{ n: string }>(`select count(*)::text as n from ${table}`))).rows[0].n);
  const doc = async (w: World, kind: string, externalId: string) =>
    (
      await w.as((tx) =>
        tx.query<{ state: string; invoice_id: string | null; customer_payment_id: string | null; credit_note_id: string | null; credit_note_refund_id: string | null; transfer_id: string | null; bank_transaction_id: string | null }>(
          `select state, invoice_id::text, customer_payment_id::text, credit_note_id::text, credit_note_refund_id::text, transfer_id::text, bank_transaction_id::text
             from sales_platform_documents where record_kind = $1 and external_id = $2`,
          [kind, externalId],
        ),
      )
    ).rows[0] ?? null;
  const journal = async (w: World, table: string, column: string, id: string | null) =>
    Object.fromEntries(
      (
        await w.as((tx) =>
          tx.query<{ code: string; net: string }>(
            `select a.code, to_char(sum(l.debit_amount - l.credit_amount), 'FM999999990.00') as net
               from ledger_journal_lines l join accounts a on a.id = l.account_id
              where l.journal_id = (select ${column} from ${table} where id = $1) group by a.code order by a.code`,
            [id],
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
  const logFor = async (w: World, externalId: string) => (await w.as((tx) => listSyncLog(tx, w.connectionId))).entries.filter((entry) => entry.externalId === externalId).reverse();
  const invoiceLines = async (w: World, invoiceId: string | null) =>
    (await w.as((tx) => getInvoice(tx, invoiceId))).lines.map((line) => [line.description, line.quantity, toFixedString(dec(line.unitPrice), 2), line.taxCode, line.taxAmount]);

  it("SQ1: the token is checked, the account is kept by its merchant ID, and the webhook's signature key is stored encrypted", async () => {
    await createTestOrganisation(owner, "square-connect-co");
    const record = (await getOrganisation("square-connect-co"))!;
    const actor = { userId: owner.id, email: owner.email };
    setSalesPlatformFetchForTests(fakeSquare(squareState()));
    await expect(connectStore(record, actor, { platform: "square", accessToken: "EAAAwrong" }, { webhookOrigin: null })).rejects.toThrow("Square refused these credentials");

    const w = await setup();
    expect(w.connection).toMatchObject({
      platform: "square",
      storeDomain: "mlglimmers01",
      storeName: "Glimmers markets",
      storeCurrency: "NZD",
      authMethod: "personal_access_token",
      syncCustomers: false,
      syncProducts: false,
      webhooksActive: true,
    });
    expect(w.state.subscriptions).toEqual([
      {
        id: "wbhk_1",
        url: `${ORIGIN}/api/sales-platforms/webhooks/${w.org}/${w.path.webhookKey}`,
        events: ["order.created", "order.updated", "payment.created", "payment.updated", "refund.created", "refund.updated"],
      },
    ]);
    expect(w.credentials).toMatchObject({ accessToken: ACCESS_TOKEN, webhookSigningKey: "test-signature-key-glimmers", webhookUrl: w.state.subscriptions[0].url });
    // The same Square account again is refused.
    await expect(connectStore(w.record, w.actor, { platform: "square", accessToken: ACCESS_TOKEN }, { webhookOrigin: null })).rejects.toThrow("mlglimmers01 is already connected.");
  });

  it("SQ2, SQ3, SQ4, SQ6, SQ7: card sales into the clearing account, an itemised refund, and a payout that empties it", async () => {
    const w = await setup({}, { webhookOrigin: null });
    // SQ2: tax included; SQ4: a discount and SKUs; SQ3: tax added on.
    w.state.orders.push(
      cardSale(),
      cardSale({
        id: "O-2002",
        createdAt: "2026-10-04T01:00:00Z",
        lines: [{ uid: "LI-2", name: "Wax melts", catalogId: "VAR-MELT", quantity: "3", total: 2200, tax: 287, discount: 500 }],
        tenders: [{ id: "T-2002", type: "CARD", paymentId: "P-2002", amount: 2200 }],
        total: 2200,
      }),
      cardSale({
        id: "O-2003",
        createdAt: "2026-10-04T02:00:00Z",
        taxType: "ADDITIVE",
        lines: [{ uid: "LI-3", name: "Large candle", catalogId: "VAR-CANDLE", quantity: "1", total: 2300, tax: 300 }],
        tenders: [{ id: "T-2003", type: "CARD", paymentId: "P-2003", amount: 2300 }],
        total: 2300,
      }),
    );
    w.state.payments.push(
      cardPayment,
      { id: "P-2002", orderId: "O-2002", status: "COMPLETED", total: 2200, createdAt: "2026-10-04T01:00:20Z", receipt: "R2002" },
      { id: "P-2003", orderId: "O-2003", status: "COMPLETED", total: 2300, createdAt: "2026-10-04T02:00:20Z", receipt: "R2003" },
    );
    expect(await w.sync("2026-10-04T03:00:00Z")).toMatchObject({ failed: 0 });

    const first = (await doc(w, "order", "O-2001"))!;
    expect(await w.as((tx) => getInvoice(tx, first.invoice_id))).toMatchObject({ invoiceDate: "2026-10-03", reference: "#R2001", total: "46.00", taxTotal: "6.00", amountDue: "0.00", amountsMode: "inclusive" });
    expect(await invoiceLines(w, first.invoice_id)).toEqual([["Large candle", "2", "23.00", "GST", "6.00"]]);
    expect(await journal(w, "sales_invoices", "approval_journal_id", first.invoice_id)).toEqual({ "1100": "46.00", "2100": "-6.00", "4000": "-40.00" });
    expect(await journal(w, "customer_payments", "journal_id", first.customer_payment_id)).toEqual({ "1070": "46.00", "1100": "-46.00" });
    // The customer came across by email.
    expect((await w.as((tx) => tx.query<{ name: string; email: string }>("select name, email from contacts where lower(email) = $1", [AROHA.email]))).rows).toEqual([
      { name: "Aroha Ngata", email: AROHA.email },
    ]);

    const second = (await doc(w, "order", "O-2002"))!;
    expect(await invoiceLines(w, second.invoice_id)).toEqual([
      ["Wax melts", "2", "7.33", "GST", "1.91"],
      ["Wax melts", "1", "7.34", "GST", "0.96"],
    ]);
    expect(await journal(w, "sales_invoices", "approval_journal_id", second.invoice_id)).toEqual({ "1100": "22.00", "2100": "-2.87", "4000": "-19.13" });

    const third = (await doc(w, "order", "O-2003"))!;
    expect(await w.as((tx) => getInvoice(tx, third.invoice_id))).toMatchObject({ amountsMode: "exclusive", total: "23.00", taxTotal: "3.00" });
    expect(await journal(w, "sales_invoices", "approval_journal_id", third.invoice_id)).toEqual({ "1100": "23.00", "2100": "-3.00", "4000": "-20.00" });

    // SQ6: one candle back, refunded to the card; the refund's lines are on its return order.
    w.state.orders.push({
      id: "RO-1",
      createdAt: "2026-10-05T22:00:00Z",
      lines: [],
      taxType: "INCLUSIVE",
      tenders: [],
      total: 0,
      returns: { sourceOrderId: "O-2001", lines: [{ uid: "RL-1", sourceUid: "LI-1", quantity: "1", total: 2300, tax: 300 }] },
    });
    w.state.refunds.push({ id: "R-1", paymentId: "P-2001", orderId: "RO-1", status: "COMPLETED", amount: 2300, createdAt: "2026-10-05T22:00:00Z" });
    w.state.payments[0] = { ...cardPayment, refundIds: ["R-1"] };
    await w.sync("2026-10-05T23:00:00Z");
    const refund = (await doc(w, "refund", "RO-1"))!;
    expect(await journal(w, "sales_credit_notes", "approval_journal_id", refund.credit_note_id)).toEqual({ "1100": "-23.00", "2100": "3.00", "4000": "20.00" });
    expect(await journal(w, "sales_credit_note_refunds", "journal_id", refund.credit_note_refund_id)).toEqual({ "1070": "-23.00", "1100": "23.00" });
    expect(await count(w, "sales_orders")).toBe(3);

    // SQ7: the payout with its fees; one still on its way waits; one with a dispute is refused.
    w.state.payouts.push(
      {
        id: "PO-1",
        status: "PAID",
        createdAt: "2026-10-07T03:00:00Z",
        amount: 6640,
        entries: [
          { id: "E1", type: "CHARGE", gross: 4600, fee: 81, net: 4519, paymentId: "P-2001" },
          { id: "E2", type: "CHARGE", gross: 2200, fee: 39, net: 2161, paymentId: "P-2002" },
          { id: "E3", type: "CHARGE", gross: 2300, fee: 40, net: 2260, paymentId: "P-2003" },
          { id: "E4", type: "REFUND", gross: -2300, fee: 0, net: -2300, paymentId: "P-2001" },
        ],
      },
      { id: "PO-2", status: "SENT", createdAt: "2026-10-08T03:00:00Z", amount: 1000, entries: [] },
    );
    await w.sync("2026-10-08T04:00:00Z");
    const payout = (await doc(w, "payout", "PO-1"))!;
    expect(await journal(w, "bank_transfers", "journal_id", payout.transfer_id)).toEqual({ "1000": "66.40", "1070": "-66.40" });
    expect(await journal(w, "bank_transactions", "journal_id", payout.bank_transaction_id)).toEqual({ "1070": "-1.60", "6020": "1.60" });
    expect(await balance(w, "1070")).toBe("0.00");
    expect(await doc(w, "payout", "PO-2")).toBeNull();

    w.state.payouts.push({
      id: "PO-3",
      status: "PAID",
      createdAt: "2026-10-09T03:00:00Z",
      amount: 0,
      entries: [{ id: "E5", type: "DISPUTE", gross: -2200, fee: 0, net: -2200 }, { id: "E6", type: "CHARGE", gross: 2200, fee: 0, net: 2200 }],
    });
    await w.sync("2026-10-09T04:00:00Z");
    expect((await logFor(w, "PO-3")).at(-1)?.message).toContain("dispute");
    expect(await doc(w, "payout", "PO-3")).toBeNull();

    // Syncing again posts nothing more.
    const journals = await count(w, "ledger_journals");
    await w.sync("2026-10-10T04:00:00Z");
    expect(await count(w, "ledger_journals")).toBe(journals);
  });

  it("SQ5: cash waits until an admin chooses where it goes; a split between card and cash is refused", async () => {
    const w = await setup({}, { webhookOrigin: null });
    w.state.orders.push(
      cardSale({
        id: "O-2004",
        createdAt: "2026-10-08T01:00:00Z",
        lines: [{ uid: "LI-4", name: "Large candle", catalogId: "VAR-CANDLE", quantity: "1", total: 2300, tax: 300 }],
        tenders: [{ id: "T-2004", type: "CASH", paymentId: "P-2004", amount: 2300 }],
        total: 2300,
      }),
      cardSale({
        id: "O-2005",
        createdAt: "2026-10-08T02:00:00Z",
        lines: [{ uid: "LI-5", name: "Large candle", catalogId: "VAR-CANDLE", quantity: "1", total: 2300, tax: 300 }],
        tenders: [
          { id: "T-2005a", type: "CARD", paymentId: "P-2005a", amount: 1000 },
          { id: "T-2005b", type: "CASH", paymentId: "P-2005b", amount: 1300 },
        ],
        total: 2300,
      }),
    );
    w.state.payments.push(
      { id: "P-2004", orderId: "O-2004", status: "COMPLETED", total: 2300, createdAt: "2026-10-08T01:00:10Z", receipt: "R2004", sourceType: "CASH" },
      { id: "P-2005a", orderId: "O-2005", status: "COMPLETED", total: 1000, createdAt: "2026-10-08T02:00:10Z", receipt: "R2005" },
      { id: "P-2005b", orderId: "O-2005", status: "COMPLETED", total: 1300, createdAt: "2026-10-08T02:00:20Z", receipt: "R2005", sourceType: "CASH" },
    );
    await w.sync("2026-10-08T03:00:00Z");
    expect((await doc(w, "order", "O-2004"))?.invoice_id ?? null).toBeNull();
    expect((await logFor(w, "O-2004")).at(-1)?.message).toContain("Choose where cash (Cash) payments go in the Square settings.");
    expect((await logFor(w, "O-2005")).at(-1)?.message).toBe("#R2005 was paid in more than one way (card, cash); split payments like that aren't supported yet.");

    await w.map([{ method: "cash", accountCode: "1090" }]);
    await w.sync("2026-10-08T04:00:00Z");
    const cash = (await doc(w, "order", "O-2004"))!;
    expect(await journal(w, "customer_payments", "journal_id", cash.customer_payment_id)).toEqual({ "1090": "23.00", "1100": "-23.00" });
    expect(await doc(w, "order", "O-2005")).toBeNull();
  });

  it("SQ8: a signed event brings an order in once; a wrong key, another seller or another address is refused", async () => {
    const w = await setup();
    w.state.orders.push(cardSale());
    w.state.payments.push(cardPayment);
    const deliver = (eventId: string, options: { key?: string; merchantId?: string; signedUrl?: string } = {}) =>
      webhookRoute.POST(squareWebhook(w.path, "order.updated", { order_updated: { order_id: "O-2001", state: "COMPLETED" } }, { eventId, ...options }), params(w.path));
    expect((await deliver("E-0", { key: "another-key" })).status).toBe(401);
    expect((await deliver("E-0", { merchantId: "MLSOMEONEELSE" })).status).toBe(401);
    expect((await deliver("E-0", { signedUrl: "https://elsewhere.example.nz/hook" })).status).toBe(401);
    expect(await count(w, "sales_orders")).toBe(0);
    const first = await deliver("E-1");
    expect(await first.json()).toMatchObject({ message: "Done." });
    expect((await doc(w, "order", "O-2001"))!.customer_payment_id).not.toBeNull();
    expect(await (await deliver("E-1")).json()).toMatchObject({ message: "Already handled." });
    // A payment event for the same order, and a catch-up sync, add nothing.
    const journals = await count(w, "ledger_journals");
    const payment = await webhookRoute.POST(squareWebhook(w.path, "payment.updated", { payment: { id: "P-2001", order_id: "O-2001" } }, { eventId: "E-2" }), params(w.path));
    expect(payment.status).toBe(200);
    await w.sync("2026-10-03T03:00:00Z");
    expect(await count(w, "ledger_journals")).toBe(journals);
    expect(await count(w, "sales_invoices")).toBe(1);
  });

  it("SQ9: an order another connected platform sent to Square isn't posted twice", async () => {
    const w = await setup({}, { webhookOrigin: null, woo: true });
    w.state.orders.push(cardSale({ source: "WooCommerce" }));
    w.state.payments.push(cardPayment);
    await w.sync("2026-10-03T03:00:00Z");
    expect(await count(w, "sales_orders")).toBe(0);
    expect((await logFor(w, "O-2001")).at(-1)?.message).toBe("#R2001 came from WooCommerce, which is connected too; it's brought in from there, so it isn't posted twice.");

    // Without WooCommerce connected, the same kind of order is Square's to post.
    const alone = await setup({}, { webhookOrigin: null });
    alone.state.orders.push(cardSale({ source: "WooCommerce" }));
    alone.state.payments.push(cardPayment);
    await alone.sync("2026-10-03T03:00:00Z");
    expect(await count(alone, "sales_invoices")).toBe(1);
  });

  it("SQ10: another currency, a tip, a service charge, a gift card and a refund without lines are refused and logged", async () => {
    const w = await setup({}, { webhookOrigin: null });
    const sale = (id: string, overrides: Parameters<typeof cardSale>[0] = {}) => cardSale({ id, tenders: [{ id: `T-${id}`, type: "CARD", paymentId: `P-${id}`, amount: 4600 }], ...overrides });
    w.state.orders.push(
      sale("O-2010", { currency: "AUD" }),
      sale("O-2011", { tip: 200, total: 4800 }),
      sale("O-2012", { serviceCharge: 100, total: 4700 }),
      sale("O-2013", { tenders: [{ id: "T-2013", type: "SQUARE_GIFT_CARD", paymentId: "P-O-2013", amount: 4600 }] }),
      sale("O-2014"),
    );
    for (const id of ["O-2010", "O-2011", "O-2012", "O-2013", "O-2014"]) {
      w.state.payments.push({ id: `P-${id}`, orderId: id, status: "COMPLETED", total: 4600, createdAt: "2026-10-03T01:00:30Z", receipt: id.replace("O-", "R") });
    }
    // O-2014: refunded by amount only (no items returned).
    w.state.refunds.push({ id: "R-9", paymentId: "P-O-2014", orderId: "O-2014", status: "COMPLETED", amount: 1000, createdAt: "2026-10-04T00:00:00Z" });
    w.state.payments[4] = { ...w.state.payments[4], refundIds: ["R-9"] };
    await w.sync("2026-10-04T02:00:00Z");
    expect((await logFor(w, "O-2010")).at(-1)?.message).toBe("#R2010 is in AUD; Tohyee only brings in orders in NZD.");
    expect((await logFor(w, "O-2011")).at(-1)?.message).toBe("#R2011 has a tip; tips aren't supported yet, so record it by hand.");
    expect((await logFor(w, "O-2012")).at(-1)?.message).toBe("#R2012 has a service charge; service charges aren't supported yet, so record it by hand.");
    expect((await logFor(w, "O-2013")).at(-1)?.message).toContain("gift card");
    expect((await logFor(w, "R-9")).at(-1)?.message).toContain("has no refunded lines");
    expect(await count(w, "sales_invoices")).toBe(1);
    expect(await count(w, "sales_credit_notes")).toBe(0);
  });
});

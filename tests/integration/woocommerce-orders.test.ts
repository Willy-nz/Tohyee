import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import * as webhookRoute from "@/app/api/sales-platforms/webhooks/[organisationId]/[webhookKey]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { suggestionsForLine } from "@/lib/bank/reconcile";
import type { OrgTx } from "@/lib/db/org-transaction";
import { getInvoice } from "@/lib/invoices/service";
import { createItem } from "@/lib/items/service";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { setSalesPlatformFetchForTests } from "@/lib/sales-platforms/http";
import { connectStore, listSyncLog, syncConnection, updateConnectionSettings } from "@/lib/sales-platforms/service";
import { decryptSecret } from "@/lib/secrets";
import {
  CONSUMER_KEY,
  CONSUMER_SECRET,
  type WooState,
  fakeWooStore,
  order2001,
  order2002,
  order2003,
  refund7001,
  wooOrderNode,
  wooState,
  wooWebhook,
} from "../helpers/fake-woocommerce";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, startTestServer, type TestServer } from "../helpers/test-server";

const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
const CONNECTED_AT = new Date("2026-10-01T00:00:00Z");

/** Examples WC1-WC10 in docs/ACCOUNTING-EXAMPLES.md ("WooCommerce orders into the accounts"). Not tried against a real store. */
describeWithDatabase("WooCommerce orders into the accounts (WC1-WC10)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("jess@glimmers-woo.nz", { serverAdmin: true, displayName: "Jess" });
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });

  afterEach(() => {
    setSalesPlatformFetchForTests(null);
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  /** Glimmers Ltd as in the examples' setup: GST registered, 1050 Stripe and 1060 WooPayments clearing, items CANDLE-L and MELT-VAN. */
  async function setup(store: Partial<WooState> = {}, options: { webhookOrigin?: string | null } = {}) {
    organisations += 1;
    const org = `woo-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const actor = { userId: owner.id, email: owner.email };
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, actor, work);
    await as(async (tx) => {
      await updateOrganisationSettings(tx, { gstNumber: "123-456-789" });
      await createBankAccount(tx, { code: "1050", name: "Stripe", accountType: "bank" });
      await createBankAccount(tx, { code: "1060", name: "WooPayments clearing", accountType: "bank" });
      await createItem(tx, { idempotencyKey: key("item"), code: "CANDLE-L", name: "Large candle", itemType: "non_stock" });
      await createItem(tx, { idempotencyKey: key("item"), code: "MELT-VAN", name: "Wax melts - Vanilla", itemType: "non_stock" });
    });
    const state = wooState(store);
    setSalesPlatformFetchForTests(fakeWooStore(state));
    const record = (await getOrganisation(org))!;
    const connection = await connectStore(
      record,
      actor,
      { platform: "woocommerce", storeDomain: "https://shop.glimmers.nz/", consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET },
      { webhookOrigin: options.webhookOrigin ?? null, now: CONNECTED_AT },
    );
    await as((tx) =>
      updateConnectionSettings(tx, connection.id, {
        postToAccounts: true,
        startDate: "2026-10-01",
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
      connection,
      connectionId: connection.id,
      path: { organisationId: org, webhookKey: secrets.rows[0].k },
      webhookSecret: (JSON.parse(decryptSecret(secrets.rows[0].c)) as { webhookSecret: string }).webhookSecret,
      sync: (at: string) => syncConnection(record, connection.id, undefined, new Date(at)),
      map: (methods: Array<{ method: string; accountCode?: string; leftOwing?: boolean }>) => as((tx) => updateConnectionSettings(tx, connection.id, { paymentMethods: methods })),
    };
  }
  type World = Awaited<ReturnType<typeof setup>>;

  const doc = async (w: World, kind: string, externalId: string) =>
    (
      await w.as((tx) =>
        tx.query<{ state: string; invoice_id: string | null; customer_payment_id: string | null; credit_note_id: string | null; credit_note_refund_id: string | null }>(
          `select state, invoice_id::text, customer_payment_id::text, credit_note_id::text, credit_note_refund_id::text
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
  const logFor = async (w: World, externalId: string) => (await w.as((tx) => listSyncLog(tx, w.connectionId))).entries.filter((entry) => entry.externalId === externalId).reverse();

  it("WC1: https only, the key is checked, and webhooks need a key with write access", async () => {
    await createTestOrganisation(owner, "woo-connect-co");
    const record = (await getOrganisation("woo-connect-co"))!;
    const actor = { userId: owner.id, email: owner.email };
    setSalesPlatformFetchForTests(fakeWooStore(wooState()));
    await expect(
      connectStore(record, actor, { platform: "woocommerce", storeDomain: "http://shop.glimmers.nz", consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET }, { webhookOrigin: null }),
    ).rejects.toThrow("Use the store's https:// address");
    await expect(
      connectStore(record, actor, { platform: "woocommerce", storeDomain: "shop.glimmers.nz", consumerKey: "ck_wrong", consumerSecret: CONSUMER_SECRET }, { webhookOrigin: null }),
    ).rejects.toThrow("WooCommerce refused these credentials");

    // A read key: connected, but WooCommerce refuses the webhooks and the note says why.
    const readOnly = await setup({ writable: false }, { webhookOrigin: "https://books.example.nz" });
    expect(readOnly.connection).toMatchObject({ platform: "woocommerce", storeDomain: "shop.glimmers.nz", storeName: "Glimmers", storeCurrency: "NZD", pricesIncludeTax: true, webhooksActive: false });
    expect(readOnly.connection.webhooksNote).toContain("Webhooks need a key with write access");
    expect(readOnly.connection.syncCustomers).toBe(false);

    // A key with write access: the two order webhooks, with Tohyee's own secret.
    const writable = await setup({}, { webhookOrigin: "https://books.example.nz" });
    expect(writable.connection.webhooksActive).toBe(true);
    expect(writable.state.webhooks.map((hook) => hook.topic)).toEqual(["order.created", "order.updated"]);
    expect(writable.state.webhooks[0].secret).toBe(writable.webhookSecret);
  });

  it("WC2, WC3, WC5, WC8: an unmapped method waits; once mapped, card orders are paid into 1050 and match the Stripe feed; a refund is paid back from 1050", async () => {
    const w = await setup();
    w.state.orders.push(order2001(), order2002());
    await w.sync("2026-10-03T02:00:00Z");
    // WC8: stripe isn't mapped yet, so nothing is invoiced, and the method is listed for an admin to choose.
    expect((await doc(w, "order", "2001"))?.invoice_id ?? null).toBeNull();
    expect((await logFor(w, "2001")).at(-1)?.message).toContain("Choose where stripe (Credit card (Stripe)) payments go in the WooCommerce settings.");
    expect(await w.as((tx) => tx.query("select method, title from sales_platform_payment_methods").then((r) => r.rows))).toEqual([{ method: "stripe", title: "Credit card (Stripe)" }]);
    await expect(w.map([{ method: "cod", leftOwing: true }])).rejects.toThrow("WooCommerce hasn't sent an order paid by cod yet.");
    await expect(w.map([{ method: "stripe", accountCode: "4000" }])).rejects.toThrow("it isn't a bank account.");
    expect((await w.map([{ method: "stripe", accountCode: "1050" }])).paymentMethods).toEqual([{ method: "stripe", title: "Credit card (Stripe)", accountCode: "1050", leftOwing: false }]);

    await w.sync("2026-10-03T03:00:00Z");
    // WC2.
    const first = (await doc(w, "order", "2001"))!;
    const invoice = await w.as((tx) => getInvoice(tx, first.invoice_id));
    expect(invoice).toMatchObject({ invoiceDate: "2026-10-02", total: "46.00", taxTotal: "6.00", amountDue: "0.00", amountsMode: "exclusive" });
    expect(await journal(w, "sales_invoices", "approval_journal_id", first.invoice_id)).toEqual({ "1100": "46.00", "2100": "-6.00", "4000": "-40.00" });
    expect(await journal(w, "customer_payments", "journal_id", first.customer_payment_id)).toEqual({ "1050": "46.00", "1100": "-46.00" });
    // WC3: the coupon is in the line's total; shipping its own line.
    const second = (await doc(w, "order", "2002"))!;
    expect(await journal(w, "sales_invoices", "approval_journal_id", second.invoice_id)).toEqual({ "1100": "28.90", "2100": "-3.77", "4000": "-25.13" });
    // The Stripe feed's +46.00 line on 1050 is offered the payment as its exact match.
    const stripe = (await w.as((tx) => tx.query<{ id: string }>("select id from accounts where code = '1050'"))).rows[0].id;
    await w.as((tx) =>
      importStatementFile(tx, stripe, { idempotencyKey: key("import"), fileName: "stripe.csv", fileBase64: Buffer.from("Date,Amount,Payee\n02/10/2026,46.00,Payment for 2001\n").toString("base64") }),
    );
    const line = (await w.as((tx) => listStatementLines(tx, stripe, { status: "unreconciled" }))).lines.find((entry) => entry.amount === "46.00")!;
    const paymentJournal = (await w.as((tx) => tx.query<{ j: string }>("select journal_id::text as j from customer_payments where id = $1", [first.customer_payment_id]))).rows[0].j;
    expect((await w.as((tx) => suggestionsForLine(tx, line.id))).matches[0]).toMatchObject({ journalId: paymentJournal, amount: "46.00", exact: true });

    // WC5: a partial refund, paid back from 1050.
    w.state.orders[0] = order2001({ modifiedAt: "2026-10-05T22:00:10Z", refunds: [refund7001] });
    await w.sync("2026-10-05T23:00:00Z");
    const refund = (await doc(w, "refund", "7001"))!;
    expect(await journal(w, "sales_credit_notes", "approval_journal_id", refund.credit_note_id)).toEqual({ "1100": "-23.00", "2100": "3.00", "4000": "20.00" });
    expect(await journal(w, "sales_credit_note_refunds", "journal_id", refund.credit_note_refund_id)).toEqual({ "1050": "-23.00", "1100": "23.00" });
    // Syncing again posts nothing more.
    const journals = (await w.as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n;
    await w.sync("2026-10-06T23:00:00Z");
    expect((await w.as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n).toBe(journals);
  });

  it("WC4, WC6, WC7: bank transfer invoiced and left owing; WooPayments into its clearing account; a cancelled owing order is voided", async () => {
    const w = await setup();
    w.state.orders.push(order2003(), order2001({ id: 2004, createdAt: "2026-10-07T00:00:00Z", paidAt: "2026-10-07T00:01:00Z", method: "woocommerce_payments", methodTitle: "WooPayments" }));
    w.state.orders.push(order2003({ id: 2005, createdAt: "2026-10-07T03:00:00Z" }), order2003({ id: 2006, status: "pending", createdAt: "2026-10-07T04:00:00Z", method: "stripe", methodTitle: "Card" }));
    await w.sync("2026-10-07T05:00:00Z");
    await w.map([
      { method: "bacs", leftOwing: true },
      { method: "woocommerce_payments", accountCode: "1060" },
      { method: "stripe", accountCode: "1050" },
    ]);
    await w.sync("2026-10-07T06:00:00Z");
    // WC4: owing, dated the order's day, nothing paid.
    const owing = (await doc(w, "order", "2003"))!;
    expect(owing.customer_payment_id).toBeNull();
    expect(await w.as((tx) => getInvoice(tx, owing.invoice_id))).toMatchObject({ invoiceDate: "2026-10-04", total: "23.00", amountDue: "23.00" });
    // WC6: WooPayments into 1060.
    const woo = (await doc(w, "order", "2004"))!;
    expect(await journal(w, "customer_payments", "journal_id", woo.customer_payment_id)).toEqual({ "1060": "46.00", "1100": "-46.00" });
    // The pending card order isn't invoiced.
    expect((await doc(w, "order", "2006"))?.invoice_id ?? null).toBeNull();

    // WC4: marked paid in WooCommerce later: nothing more is posted (the bank feed's line is matched to the invoice).
    const before = (await w.as((tx) => tx.query<{ n: string }>("select count(*)::text as n from customer_payments"))).rows[0].n;
    w.state.orders[0] = order2003({ status: "processing", paidAt: "2026-10-08T00:00:00Z", modifiedAt: "2026-10-08T00:00:00Z" });
    // WC7: #2005 cancelled with nothing paid; #2006 failed.
    w.state.orders[2] = order2003({ id: 2005, createdAt: "2026-10-07T03:00:00Z", status: "cancelled", modifiedAt: "2026-10-08T01:00:00Z" });
    w.state.orders[3] = order2003({ id: 2006, status: "failed", createdAt: "2026-10-07T04:00:00Z", modifiedAt: "2026-10-08T02:00:00Z", method: "stripe", methodTitle: "Card" });
    await w.sync("2026-10-08T03:00:00Z");
    expect((await w.as((tx) => tx.query<{ n: string }>("select count(*)::text as n from customer_payments"))).rows[0].n).toBe(before);
    const cancelled = (await doc(w, "order", "2005"))!;
    expect(cancelled.state).toBe("cancelled");
    expect(await w.as((tx) => getInvoice(tx, cancelled.invoice_id))).toMatchObject({ status: "voided" });
    expect((await logFor(w, "2005")).at(-1)?.message).toMatch(/was cancelled in WooCommerce before it was paid, so INV-\d+ was voided\./);
    expect((await doc(w, "order", "2006"))?.state).toBe("cancelled");
  });

  it("WC9: a signed webhook brings an order in once; a wrong signature is refused; a ping is answered", async () => {
    const w = await setup();
    w.state.orders.push(order2001());
    await w.sync("2026-10-01T00:30:00Z");
    // Seen once by the sync, so stripe can be mapped before the order arrives.
    w.state.orders.length = 0;
    await w.as((tx) => tx.query("insert into sales_platform_payment_methods (connection_id, method, title) values ($1, 'stripe', 'Card') on conflict do nothing", [w.connectionId]));
    await w.map([{ method: "stripe", accountCode: "1050" }]);
    w.state.orders.push(order2001());
    const deliver = (id: string, secret = w.webhookSecret) => webhookRoute.POST(wooWebhook(w.path, "order.updated", wooOrderNode(order2001()), { secret, deliveryId: id }), params(w.path));
    const first = await deliver("D-1");
    expect(await first.json()).toMatchObject({ message: "Done." });
    expect((await doc(w, "order", "2001"))!.customer_payment_id).not.toBeNull();
    expect(await (await deliver("D-1")).json()).toMatchObject({ message: "Already handled." });
    expect((await deliver("D-2", "wrong-secret")).status).toBe(401);
    const ping = await webhookRoute.POST(
      new Request(`https://tohyee.example.nz/api/sales-platforms/webhooks/${w.path.organisationId}/${w.path.webhookKey}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "webhook_id=100",
      }),
      params(w.path),
    );
    expect(ping.status).toBe(200);
  });

  it("WC10: another currency, a surcharge and a total that doesn't add up are refused and logged", async () => {
    const w = await setup();
    w.state.orders.push(
      order2001({ id: 2010, currency: "AUD" }),
      order2001({ id: 2011, fees: [{ name: "Card surcharge", total: "1.00" }], total: "47.00" }),
      order2001({ id: 2012, total: "45.00" }),
    );
    await w.sync("2026-10-03T02:00:00Z");
    expect((await logFor(w, "2010")).at(-1)?.message).toBe("#2010 is in AUD; Tohyee only brings in orders in NZD.");
    expect((await logFor(w, "2011")).at(-1)?.message).toBe("#2011 has a surcharge (a fee line); surcharges aren't supported yet, so record it by hand.");
    expect((await logFor(w, "2012")).at(-1)?.message).toContain("WooCommerce's order total is 45.00");
    expect(await w.as((tx) => tx.query("select 1 from sales_orders"))).toMatchObject({ rowCount: 0 });
  });
});

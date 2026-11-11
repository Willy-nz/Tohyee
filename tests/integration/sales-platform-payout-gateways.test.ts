import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine, unreconcileStatementLine } from "@/lib/bank/reconcile";
import type { OrgTx } from "@/lib/db/org-transaction";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import { getInvoice } from "@/lib/invoices/service";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { salesPlatformDiagnostics } from "@/lib/sales-platforms/diagnostics";
import { settleGatewayDeposit, settlementGuidanceForLine } from "@/lib/sales-platforms/gateway-settlements";
import { payoutGuidanceForLine, payoutMatchReport } from "@/lib/sales-platforms/payout-reconcile";
import { loadPosting, postPayout } from "@/lib/sales-platforms/posting";
import { startOfLocalDate } from "@/lib/sales-platforms/orders";
import { connectStore, listConnections, listSyncLog, retryPayouts, syncConnection, updateConnectionSettings } from "@/lib/sales-platforms/service";
import { setSalesPlatformFetchForTests } from "@/lib/sales-platforms/shopify";
import { createTaxCode } from "@/lib/tax/codes";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  type BalanceTransactionFixture,
  type PayoutFixture,
  fakeShopifyStore,
  order1001,
  order1002,
  payout70001,
  refund6001,
  storeState,
} from "../helpers/fake-shopify-orders";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
const CONNECTED_AT = new Date("2026-10-01T00:03:01Z");

/** The payout's own transfer row, as a live store sends it (Shopify's TRANSFER type: the payout the other way round). */
const transferRow = (id: number, amount: string): BalanceTransactionFixture => ({ id, type: "TRANSFER", amount, fee: "0.00", net: amount });

/**
 * Examples SPC38-SPC46 in docs/ACCOUNTING-EXAMPLES.md (as Xero/A2X do, not
 * yet reviewed), with made-up Shopify-shaped responses: payouts with their
 * own TRANSFER row, a withdrawal, a missing account, payouts read again
 * after they were refused, and orders paid through Afterpay, PayPal and a
 * manual bank deposit.
 */
describeWithDatabase("Shopify payouts with transfer rows and withdrawals, and payment gateways", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@payout-gateways.test", { serverAdmin: true, displayName: "Owner" });
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });

  afterEach(() => {
    setSalesPlatformFetchForTests(null);
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `payout-gateways-${organisations}-co`;
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
      { webhookOrigin: null, now: CONNECTED_AT },
    );
    await as((tx) =>
      updateConnectionSettings(tx, connection.id, {
        postToAccounts: true,
        startDate: "2026-10-01",
        newClearingAccount: { code: "1010", name: "Money held by Shopify" },
        payoutAccountCode: "1000",
        feesAccountCode: "6020",
        salesAccountCode: "4000",
        shippingAccountCode: "4000",
        taxCodes: [{ rate: "15", taxCode: "GST" }],
        untaxedTaxCode: "ZERO",
      }),
    );
    const bank = (await as((tx) => tx.query<{ id: string }>("select id from accounts where code = '1000'"))).rows[0].id;
    let imports = 0;
    return {
      as,
      actor,
      record,
      state,
      connectionId: connection.id,
      sync: (at: string) => syncConnection(record, connection.id, undefined, new Date(at)),
      bankLines: async (...rows: string[]) => {
        imports += 1;
        const csv = `Date,Amount,Payee\n${rows.join("\n")}\n`;
        await as((tx) => importStatementFile(tx, bank, { idempotencyKey: key(`import-${imports}`), fileName: `statement-${imports}.csv`, fileBase64: Buffer.from(csv).toString("base64") }));
        return (await as((tx) => listStatementLines(tx, bank, { status: "unreconciled" }))).lines;
      },
      balance: async (code: string) =>
        (
          await as((tx) =>
            tx.query<{ net: string }>(
              `select to_char(coalesce(sum(l.debit_amount - l.credit_amount), 0), 'FM999999990.00') as net
                 from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = $1`,
              [code],
            ),
          )
        ).rows[0].net,
      count: async (table: string) => Number((await as((tx) => tx.query<{ n: string }>(`select count(*)::text as n from ${table}`))).rows[0].n),
      payoutDoc: async (id: string) =>
        (await as((tx) => tx.query<{ transfer_id: string }>("select transfer_id::text from sales_platform_documents where record_kind = 'payout' and external_id = $1", [id]))).rows[0] ?? null,
      lastLog: async (id: string) => (await as((tx) => listSyncLog(tx, connection.id))).entries.find((entry) => entry.externalId === id) ?? null,
      orderDoc: async (id: string) =>
        (
          await as((tx) =>
            tx.query<{ state: string; invoice_id: string | null; customer_payment_id: string | null }>(
              "select state, invoice_id::text, customer_payment_id::text from sales_platform_documents where record_kind = 'order' and external_id = $1",
              [id],
            ),
          )
        ).rows[0] ?? null,
      paymentAccount: async (paymentId: string | null) =>
        (await as((tx) => tx.query<{ code: string }>("select a.code from customer_payments p join accounts a on a.id = p.bank_account_id where p.id = $1", [paymentId]))).rows[0]?.code ??
        null,
    };
  }
  type World = Awaited<ReturnType<typeof setup>>;

  /** #1001 (with its refund) and #1002, paid by Shopify Payments, into 1010. */
  async function orders(w: World) {
    await w.sync("2026-10-01T01:00:00Z");
    w.state.orders.push(order1001({ financialStatus: "PARTIALLY_REFUNDED", updatedAt: "2026-10-05T22:00:30Z", refunds: [refund6001()] }), order1002());
    await w.sync("2026-10-06T04:00:00Z");
    expect(await w.balance("1010")).toBe("51.90");
  }

  it("SPC38: a payout with its own TRANSFER row posts the fees and the net; 1010 is back to 0.00; never twice", async () => {
    const w = await setup();
    await orders(w);
    const live = payout70001();
    w.state.payouts.push({ ...live, transactions: [...live.transactions, transferRow(80099, "-49.38")] });
    await w.sync("2026-10-07T04:00:00Z");
    expect(await w.payoutDoc("70001")).not.toBeNull();
    expect(await w.balance("1010")).toBe("0.00");
    expect(await w.balance("6020")).toBe("2.52");
    expect(await w.balance("1000")).toBe("49.38");
    // The settlement kept for the bank match leaves the transfer row out and adds up.
    const kept = (await w.as((tx) => tx.query("select gross_sales::text, fees::text, other_amounts::text, net::text, transaction_count from sales_platform_payouts"))).rows;
    expect(kept).toEqual([{ gross_sales: "74.90", fees: "-2.52", other_amounts: "0.00", net: "49.38", transaction_count: 3 }]);
    const journals = await w.count("ledger_journals");
    await w.sync("2026-10-08T04:00:00Z");
    expect(await w.count("ledger_journals")).toBe(journals);
    // The deposit matches the posted transfer.
    const [line] = await w.bankLines("08/10/2026,49.38,SHOPIFY PAYOUT 70001");
    expect(await w.as((tx) => payoutGuidanceForLine(tx, line.id))).toMatchObject({ status: "matched", evidence: "payout_id", payouts: [{ settlement: { addsUp: true } }] });
  });

  it("SPC39: payouts refused before the fix are read again (once, by the migration's flag, or by Try again) and posted exactly once", async () => {
    const w = await setup();
    await orders(w);
    // A payout with a type Tohyee doesn't post: refused, and the sync moves past it (as the first live sync did).
    const odd: PayoutFixture = { ...payout70001(), transactions: [...payout70001().transactions, { id: 80098, type: "SHOP_CASH_CREDIT", amount: "1.00", fee: "0.00", net: "1.00" }], net: "50.38" };
    w.state.payouts.push(odd);
    await w.sync("2026-10-07T04:00:00Z");
    expect(await w.payoutDoc("70001")).toBeNull();
    expect(await w.lastLog("70001")).toMatchObject({ action: "skipped", message: expect.stringContaining("(SHOP_CASH_CREDIT)") });
    const status = async () => (await w.as((tx) => salesPlatformDiagnostics(tx, { connectionId: w.connectionId }))).connections[0].imports.payouts;
    expect(await status()).toMatchObject({ toReadAgain: 0, problems: { unknown_payout_transaction: { count: 1 } } });
    // A later payout moves the cursor on.
    w.state.payouts.push({ id: 70009, issuedAt: "2026-10-14T03:00:00Z", status: "PAID", net: "0.00", transactions: [] });
    await w.sync("2026-10-14T04:00:00Z");
    expect((await w.as((tx) => tx.query<{ c: string }>("select payouts_synced_until::text as c from sales_platform_connections"))).rows[0].c).not.toBeNull();

    // The store's real data turns out to be postable (here the fixture changes; live, the code did): the migration's flag reads it again.
    w.state.payouts[0] = { ...payout70001(), transactions: [...payout70001().transactions, transferRow(80099, "-49.38")] };
    const migration = tenantMigrations.find((entry) => entry.version === "0222")!;
    const update = migration.sql.split(";").find((part) => part.includes("update sales_platform_payouts"))!;
    await w.as((tx) => tx.query(update));
    // Both refused payouts are flagged (70009 too): each is looked at once more.
    expect(await status()).toMatchObject({ toReadAgain: 2 });
    w.state.calls.length = 0;
    await w.sync("2026-10-15T04:00:00Z");
    expect(w.state.calls).toContain("balance:70001");
    expect(await w.payoutDoc("70001")).not.toBeNull();
    expect(await w.balance("1010")).toBe("0.00");
    expect(await w.lastLog("70001")).toMatchObject({ action: "posted" });
    expect(await status()).toMatchObject({ toReadAgain: 0, notBroughtIn: 1 });
    const transfers = await w.count("bank_transfers");
    // Try again reads every paid payout not in the accounts (70009, still refused) and never posts 70001 twice.
    w.state.calls.length = 0;
    const retried = await retryPayouts(w.record, w.connectionId, w.actor, new Date("2026-10-16T04:00:00Z"));
    expect(retried.payoutsToReadAgain).toBe(1);
    expect(w.state.calls).toContain("balance:70009");
    expect(w.state.calls).not.toContain("balance:70001");
    expect(await w.count("bank_transfers")).toBe(transfers);
    expect(await w.lastLog("70009")).toMatchObject({ action: "skipped", message: "Payout 70009 is 0.00; only payouts of more than nothing are posted." });
    expect(await status()).toMatchObject({ toReadAgain: 0 });
  });

  it("SPC40: a withdrawal takes the money from the bank into 1010, the fee comes out, and the bank line matches", async () => {
    const w = await setup();
    await orders(w);
    w.state.payouts.push({ ...payout70001(), transactions: [...payout70001().transactions, transferRow(80099, "-49.38")] });
    await w.sync("2026-10-07T04:00:00Z");
    // The other candle is refunded (23.00 out of 1010), and a 10.00 order paid with a 0.40 fee: the balance is short, so Shopify takes 13.40.
    const refunded = order1001({
      financialStatus: "REFUNDED",
      updatedAt: "2026-10-20T00:00:00Z",
      refunds: [refund6001(), { id: 6002, processedAt: "2026-10-19T22:00:00Z", lines: [{ lineId: 4001, quantity: 1, subtotal: "23.00", tax: "3.00" }], transactions: [{ id: 9102, kind: "REFUND", amount: "23.00", processedAt: "2026-10-19T22:00:00Z" }] }],
    });
    w.state.orders[0] = refunded;
    await w.sync("2026-10-20T01:00:00Z");
    expect(await w.balance("1010")).toBe("-23.00");
    w.state.payouts.push({
      id: 70010,
      issuedAt: "2026-10-21T03:00:00Z",
      status: "PAID",
      direction: "WITHDRAWAL",
      net: "13.40",
      transactions: [
        { id: 80100, type: "REFUND", amount: "-23.00", fee: "0.00", net: "-23.00", orderName: "#1001" },
        { id: 80101, type: "ADJUSTMENT", amount: "10.00", fee: "0.40", net: "9.60", adjustmentReason: null },
        transferRow(80102, "13.40"),
      ],
    });
    // A positive adjustment isn't posted: the withdrawal is refused with the reason, nothing moves.
    await w.sync("2026-10-21T04:00:00Z");
    expect(await w.payoutDoc("70010")).toBeNull();
    expect(await w.lastLog("70010")).toMatchObject({ action: "skipped", message: expect.stringContaining("adjustments in Tohyee's favour") });
    // As a plain refund and fee: 23.00 + 0.40 - 10.00 = 13.40 taken from the bank, the 0.40 fee to 6020.
    w.state.payouts[1] = {
      ...w.state.payouts[1],
      transactions: [
        { id: 80100, type: "REFUND", amount: "-23.00", fee: "0.00", net: "-23.00", orderName: "#1001" },
        { id: 80101, type: "CHARGE", amount: "10.00", fee: "0.40", net: "9.60", orderName: "#1030" },
        transferRow(80102, "13.40"),
      ],
    };
    await w.as((tx) => tx.query("update sales_platform_payouts set recheck = true where external_id = '70010'"));
    await w.sync("2026-10-21T05:00:00Z");
    const doc = (await w.payoutDoc("70010"))!;
    const transfer = (await w.as((tx) => tx.query<{ f: string; t: string; amount: string }>("select f.code as f, t2.code as t, b.amount::text from bank_transfers b join accounts f on f.id = b.from_account_id join accounts t2 on t2.id = b.to_account_id where b.id = $1", [doc.transfer_id]))).rows[0];
    expect(transfer).toEqual({ f: "1000", t: "1010", amount: "13.40" });
    // 1010: -23.00 + 13.40 - 0.40 = -10.00, the charge for #1030 that isn't in the books (no order here), so 0.00 once it is.
    expect(await w.balance("1010")).toBe("-10.00");
    expect(await w.balance("6020")).toBe("2.92");
    expect((await w.lastLog("70010"))!.message).toBe("Posted payout 70010 on 2026-10-21: 13.40 taken from 1000 into 1010 (a withdrawal); 0.40 to 6020 paid out of 1010.");
    // The money out of the bank matches it.
    const lines = await w.bankLines("22/10/2026,-13.40,SHOPIFY 70010");
    const line = lines.find((entry) => entry.amount === "-13.40")!;
    const guidance = (await w.as((tx) => payoutGuidanceForLine(tx, line.id)))!;
    expect(guidance).toMatchObject({ status: "matched", evidence: "payout_id", action: { kind: "match" }, payouts: [{ settlement: { net: "-13.40", addsUp: true } }] });
    const journals = await w.count("ledger_journals");
    await w.as((tx) => reconcileStatementLine(tx, line.id, { idempotencyKey: key("reconcile"), ...guidance.action! }));
    expect(await w.count("ledger_journals")).toBe(journals);
  });

  it("SPC41: a payout whose account isn't set waits and is tried again, rather than being passed over", async () => {
    const w = await setup();
    await orders(w);
    const outcome = await w.as(async (tx) => {
      const posting = (await loadPosting(tx, w.connectionId, startOfLocalDate))!;
      const counts = { created: 0, linked: 0, updated: 0, kept: 0, skipped: 0, failed: 0 };
      const payout = { externalId: "70001", issuedAt: "2026-10-07T03:00:00Z", status: "PAID", direction: "DEPOSIT", net: "49.38", currency: "NZD", transactions: [], incomplete: false };
      const result = await postPayout(tx, { posting: { ...posting, feesAccountCode: null }, source: "sync", counts, contactFor: async () => null }, payout);
      return { result, counts };
    });
    expect(outcome).toMatchObject({ result: "failed", counts: { failed: 1 } });
    expect(await w.lastLog("70001")).toMatchObject({
      action: "failed",
      message: "Payout 70001 can't be posted: no fees account is chosen. Choose it in the Shopify settings; the payout is tried again at the next sync.",
    });
    expect(await w.payoutDoc("70001")).toBeNull();
  });

  it("SPC42-SPC46: each gateway's money goes to its own account; unmapped ones wait; refunds go back where the money went", async () => {
    const w = await setup();
    await w.sync("2026-10-01T01:00:00Z");
    const paidBy = (gateway: string, id: number, name: string, processedAt: string) =>
      order1001({ id, name, processedAt, updatedAt: processedAt, transactions: [{ id: id + 4000, kind: "SALE", gateway, amount: "46.00", processedAt }], lines: [{ ...order1001().lines[0], id: id + 100 }] });
    w.state.orders.push(
      paidBy("shopify_payments", 5101, "#1101", "2026-10-02T01:00:00Z"),
      paidBy("afterpay", 5102, "#1102", "2026-10-02T02:00:00Z"),
      paidBy("paypal", 5103, "#1103", "2026-10-02T03:00:00Z"),
      paidBy("manual", 5104, "#1104", "2026-10-02T04:00:00Z"),
    );
    await w.sync("2026-10-02T05:00:00Z");
    // Shopify Payments into 1010; the others wait (sales order made, not invoiced) with a clear reason.
    expect(await w.paymentAccount((await w.orderDoc("5101"))!.customer_payment_id)).toBe("1010");
    for (const id of ["5102", "5103", "5104"]) expect(await w.orderDoc(id)).toMatchObject({ state: "open", invoice_id: null });
    expect(await w.lastLog("5102")).toMatchObject({ action: "waiting", message: "Choose where afterpay payments go in the Shopify settings. It's tried again at the next sync." });
    expect(await w.balance("1010")).toBe("46.00");
    const connection = (await w.as((tx) => listConnections(tx))).find((entry) => entry.id === w.connectionId)!;
    expect(connection.paymentMethods.map((entry) => entry.method)).toEqual(["afterpay", "manual", "paypal", "shopify_payments"]);

    // Choosing: Shopify Payments is fixed; another gateway can't use 1010.
    await w.as(async (tx) => {
      await createBankAccount(tx, { code: "1020", name: "Afterpay clearing", accountType: "bank" });
      await createBankAccount(tx, { code: "1025", name: "PayPal clearing", accountType: "bank" });
    });
    await expect(w.as((tx) => updateConnectionSettings(tx, w.connectionId, { paymentMethods: [{ method: "afterpay", accountCode: "1010" }] }))).rejects.toThrow(
      "can't go into the Shopify clearing account",
    );
    await expect(w.as((tx) => updateConnectionSettings(tx, w.connectionId, { paymentMethods: [{ method: "shopify_payments", accountCode: "1020" }] }))).rejects.toThrow(
      "Shopify Payments money always goes into the clearing account",
    );
    await w.as((tx) =>
      updateConnectionSettings(tx, w.connectionId, {
        paymentMethods: [
          { method: "afterpay", accountCode: "1020" },
          { method: "paypal", accountCode: "1025" },
          { method: "manual", leftOwing: true },
        ],
      }),
    );
    await w.sync("2026-10-02T06:00:00Z");
    expect(await w.paymentAccount((await w.orderDoc("5102"))!.customer_payment_id)).toBe("1020");
    expect(await w.paymentAccount((await w.orderDoc("5103"))!.customer_payment_id)).toBe("1025");
    // Manual (bank deposit): invoiced and left owing, with its GST, for the bank feed to match.
    const manual = (await w.orderDoc("5104"))!;
    expect(manual.customer_payment_id).toBeNull();
    expect(await w.as((tx) => getInvoice(tx, manual.invoice_id))).toMatchObject({ total: "46.00", taxTotal: "6.00", amountDue: "46.00" });
    expect(await w.balance("1010")).toBe("46.00");
    expect(await w.balance("1020")).toBe("46.00");
    expect(await w.balance("1025")).toBe("46.00");

    // SPC46: PayPal now goes to 1020, but #1103's refund is paid back from 1025, where its money went.
    await w.as((tx) => updateConnectionSettings(tx, w.connectionId, { paymentMethods: [{ method: "paypal", accountCode: "1020" }] }));
    const refunded = paidBy("paypal", 5103, "#1103", "2026-10-02T03:00:00Z");
    w.state.orders[2] = {
      ...refunded,
      financialStatus: "PARTIALLY_REFUNDED",
      updatedAt: "2026-10-05T00:00:00Z",
      refunds: [{ id: 6103, processedAt: "2026-10-04T22:00:00Z", lines: [{ lineId: 5203, quantity: 1, subtotal: "23.00", tax: "3.00" }], transactions: [{ id: 9203, kind: "REFUND", gateway: "paypal", amount: "23.00", processedAt: "2026-10-04T22:00:00Z" }] }],
    };
    await w.sync("2026-10-05T01:00:00Z");
    expect(await w.balance("1025")).toBe("23.00");
    expect(await w.balance("1020")).toBe("46.00");

    // A gateway never seen before waits: it doesn't go to 1010.
    w.state.orders.push(paidBy("laybuy", 5105, "#1105", "2026-10-06T01:00:00Z"));
    await w.sync("2026-10-06T02:00:00Z");
    expect(await w.orderDoc("5105")).toMatchObject({ invoice_id: null });
    expect(await w.balance("1010")).toBe("46.00");
    const diagnostics = (await w.as((tx) => salesPlatformDiagnostics(tx, { connectionId: w.connectionId }))).connections[0];
    expect(diagnostics.posting.paymentMethods).toContainEqual({ method: "laybuy", title: null, goesTo: "not chosen (its orders wait)" });
    expect(diagnostics.posting.paymentMethods).toContainEqual({ method: "shopify_payments", title: null, goesTo: "1010 (always)" });
    expect(diagnostics.imports.orders.problems).toMatchObject({ payment_method_not_mapped: { count: 1 } });
  });
  it("GS1-GS6: an Afterpay deposit settles its order in 1020, with the fee; never by amount alone", async () => {
    const w = await setup();
    await w.sync("2026-10-01T01:00:00Z");
    await w.as((tx) => createBankAccount(tx, { code: "1020", name: "Afterpay clearing", accountType: "bank" }));
    const afterpay = (id: number, name: string, processedAt: string, total: string, quantity: number, tax: string) =>
      order1001({
        id,
        name,
        processedAt,
        updatedAt: processedAt,
        total,
        lines: [{ ...order1001().lines[0], id: id + 100, quantity, originalTotal: total, tax: [{ title: "GST", rate: 0.15, amount: tax }] }],
        transactions: [{ id: id + 4000, kind: "SALE", gateway: "afterpay", amount: total, processedAt }],
      });
    w.state.orders.push(afterpay(5102, "#1102", "2026-10-02T02:00:00Z", "46.00", 2, "6.00"), afterpay(5106, "#1106", "2026-10-03T02:00:00Z", "23.00", 1, "3.00"));
    await w.sync("2026-10-03T05:00:00Z");
    await w.as((tx) => updateConnectionSettings(tx, w.connectionId, { paymentMethods: [{ method: "afterpay", accountCode: "1020" }] }));
    await w.sync("2026-10-03T06:00:00Z");
    expect(await w.balance("1020")).toBe("69.00");

    const lines = await w.bankLines("2026-10-04,42.94,Afterpay Nz Limited 935893", "2026-10-04,42.94,Countdown", "2026-10-05,99.00,AFTERPAY NZ");
    const first = lines.find((line) => line.description.includes("Afterpay"))!;
    // GS1: the gateway's name on the line, then the amounts; a line without the name isn't one.
    expect(await w.as((tx) => settlementGuidanceForLine(tx, lines.find((line) => line.description === "Countdown")!.id))).toBeNull();
    const guidance = (await w.as((tx) => settlementGuidanceForLine(tx, first.id)))!;
    expect(guidance).toMatchObject({
      status: "matched",
      gateway: { method: "afterpay", accountCode: "1020" },
      reason: "afterpay settling #1102 (46.00), less a fee of 3.06.",
      feesAccountCode: "6020",
    });
    expect(guidance.choices).toHaveLength(1);
    // GS3: 99.00 is more than either order and both together: nothing fits.
    const tooMuch = (await w.as((tx) => settlementGuidanceForLine(tx, lines.find((line) => line.amount === "99.00")!.id)))!;
    expect(tooMuch.status).toBe("unmatched");

    // GS4: the line is a transfer from 1020; the fee comes out of 1020 to 6020 with no GST.
    const settleKey = key("settle");
    const done = await w.as((tx) => settleGatewayDeposit(tx, first.id, { paymentIds: guidance.choices[0].payments.map((payment) => payment.paymentId), idempotencyKey: settleKey }));
    expect(done).toMatchObject({ settled: "46.00", fee: "3.06" });
    expect(await w.balance("1020")).toBe("23.00");
    expect(await w.balance("6020")).toBe("3.06");
    expect(await w.balance("2100")).toBe("-9.00");
    const journals = await w.count("ledger_journals");
    expect(await w.as((tx) => settleGatewayDeposit(tx, first.id, { paymentIds: guidance.choices[0].payments.map((payment) => payment.paymentId), idempotencyKey: settleKey }))).toEqual(done);
    expect(await w.count("ledger_journals")).toBe(journals);
    await expect(
      w.as((tx) => settleGatewayDeposit(tx, lines.find((line) => line.amount === "99.00")!.id, { paymentIds: guidance.choices[0].payments.map((payment) => payment.paymentId), idempotencyKey: key("again") })),
    ).rejects.toThrow("already settled");

    // The second order's deposit (21.32): #1102 isn't offered again.
    const second = (await w.bankLines("2026-10-05,21.32,AFTERPAY NZ LIMITED")).find((line) => line.amount === "21.32")!;
    const next = (await w.as((tx) => settlementGuidanceForLine(tx, second.id)))!;
    expect(next).toMatchObject({ status: "matched", reason: "afterpay settling #1106 (23.00), less a fee of 1.68." });
    await w.as((tx) => settleGatewayDeposit(tx, second.id, { paymentIds: [next.choices[0].payments[0].paymentId], idempotencyKey: key("settle-2") }));
    expect(await w.balance("1020")).toBe("0.00");

    // GS5: the payout report lists it as a gateway settlement.
    const report = await w.as((tx) => payoutMatchReport(tx, { from: "2026-10-01", to: "2026-10-31" }, "2026-10-31"));
    expect(report.deposits.find((deposit) => deposit.amount === "99.00")).toMatchObject({ status: "gateway_settlement", match: "unmatched" });

    // GS6: unmatching the first deposit frees #1102 to be settled again (the fee stays until it's voided).
    await w.as((tx) => unreconcileStatementLine(tx, first.id, { idempotencyKey: key("undo") }));
    expect((await w.as((tx) => settlementGuidanceForLine(tx, first.id)))!.status).toBe("matched");
  });
});

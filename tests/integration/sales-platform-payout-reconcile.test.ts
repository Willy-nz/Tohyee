import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import type { OrgTx } from "@/lib/db/org-transaction";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { payoutGuidanceForLine, payoutMatchReport } from "@/lib/sales-platforms/payout-reconcile";
import { connectStore, disconnectStore, reconnectStore, syncConnection, updateConnectionSettings } from "@/lib/sales-platforms/service";
import { salesPlatformDiagnostics } from "@/lib/sales-platforms/diagnostics";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import { AI_TOOLS } from "@/lib/ai/catalogue";
import type { ToolContext } from "@/lib/ai/tools";
import { setSalesPlatformFetchForTests } from "@/lib/sales-platforms/shopify";
import { createTaxCode } from "@/lib/tax/codes";
import { CLIENT_ID, CLIENT_SECRET, fakeShopifyStore, order1001, order1002, order1003, payout70001, payout70002, refund6001, storeState } from "../helpers/fake-shopify-orders";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
const CONNECTED_AT = new Date("2026-10-01T00:03:01Z");

/** Examples SPR1-SPR10 in docs/ACCOUNTING-EXAMPLES.md, end to end with a made-up store (as Xero/A2X do, not yet reviewed). */
describeWithDatabase("Shopify payout deposits reconciled against the clearing account (#548)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("jess@payout-match.nz", { serverAdmin: true, displayName: "Jess" });
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });

  afterEach(() => {
    setSalesPlatformFetchForTests(null);
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  async function setup(options: { gst?: boolean } = {}) {
    organisations += 1;
    const org = `payout-match-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const actor = { userId: owner.id, email: owner.email };
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, actor, work);
    await as(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "EXPORT", label: "Exports", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01" });
      await updateOrganisationSettings(tx, { gstNumber: options.gst === false ? null : "123-456-789", gstRegistered: options.gst !== false, exportTaxCode: "EXPORT" });
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
        ...(options.gst === false ? {} : { taxCodes: [{ rate: "15", taxCode: "GST" }], untaxedTaxCode: "ZERO" }),
      }),
    );
    const bank = (await as((tx) => tx.query<{ id: string }>("select id from accounts where code = '1000'"))).rows[0].id;
    let imports = 0;
    return {
      as,
      state,
      record,
      actor,
      connectionId: connection.id,
      sync: (at: string) => syncConnection(record, connection.id, undefined, new Date(at)),
      /** Imports bank lines ("08/10/2026,49.38,SHOPIFY PAYOUT") and returns their ids in order. */
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
      journals: async () => Number((await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n),
    };
  }

  type World = Awaited<ReturnType<typeof setup>>;

  /** Orders #1001 and #1002, the refund on #1001 and payout 70001 (SPC11-SPC15). */
  async function firstPayout(w: World) {
    await w.sync("2026-10-01T01:00:00Z");
    w.state.orders.push(order1001({ financialStatus: "PARTIALLY_REFUNDED", updatedAt: "2026-10-05T22:00:30Z", refunds: [refund6001()] }), order1002());
    w.state.payouts.push(payout70001());
    await w.sync("2026-10-07T04:00:00Z");
  }

  const guide = (w: World, lineId: string) => w.as((tx) => payoutGuidanceForLine(tx, lineId));
  const reconcile = (w: World, lineId: string, action: Record<string, unknown>) =>
    w.as((tx) => reconcileStatementLine(tx, lineId, { idempotencyKey: key("reconcile"), ...action }));

  it("SPR1-SPR3, SPR6: the deposit matches the posted payout; sales and fees once; a duplicate import isn't matched again", async () => {
    const w = await setup();
    await firstPayout(w);
    // SPR1: the settlement is kept.
    const kept = (await w.as((tx) => tx.query("select gross_sales::text, refunds::text, fees::text, net::text, detail_read, order_names from sales_platform_payouts")))
      .rows;
    expect(kept).toEqual([{ gross_sales: "74.90", refunds: "-23.00", fees: "-2.52", net: "49.38", detail_read: true, order_names: ["#1001", "#1002"] }]);
    const sales = await w.balance("4000");
    const gst = await w.balance("2100");
    expect(await w.balance("1010")).toBe("0.00");

    const [line] = await w.bankLines("08/10/2026,49.38,SHOPIFY PAYOUT");
    const guidance = (await guide(w, line.id))!;
    expect(guidance).toMatchObject({ status: "matched", evidence: "platform_amount_date", gst: { status: "registered" } });
    expect(guidance.payouts[0].settlement).toMatchObject({ grossSales: "74.90", refunds: "-23.00", fees: "-2.52", net: "49.38", addsUp: true });
    expect(guidance.action).toMatchObject({ kind: "match" });

    // Matching posts nothing: sales, GST and fees stay as the orders and payout posted them.
    const journals = await w.journals();
    await reconcile(w, line.id, guidance.action!);
    expect(await w.journals()).toBe(journals);
    expect(await w.balance("4000")).toBe(sales);
    expect(await w.balance("2100")).toBe(gst);
    expect(await w.balance("1010")).toBe("0.00");
    expect(await w.balance("6020")).toBe("2.52");
    expect(await guide(w, line.id)).toBeNull();

    // SPR6: the same deposit imported again.
    const lines = await w.bankLines("08/10/2026,49.38,SHOPIFY PAYOUT 70001");
    const again = (await guide(w, lines[0].id))!;
    expect(again).toMatchObject({ status: "already_matched", action: null });

    // The same payout read again keeps one row and its settlement.
    await w.sync("2026-10-08T04:00:00Z");
    expect((await w.as((tx) => tx.query("select count(*)::int as n, bool_and(detail_read) as d from sales_platform_payouts"))).rows[0]).toEqual({ n: 1, d: true });
  });

  it("SPR7: two payouts in one deposit; SPR10 for MCP: statuses, suggestions and the clearing balance", async () => {
    const w = await setup();
    await firstPayout(w);
    w.state.orders.push(order1003());
    w.state.payouts.push(payout70002());
    await w.sync("2026-10-14T04:00:00Z");
    const lines = await w.bankLines("15/10/2026,66.71,SHOPIFY", "16/10/2026,12.00,SHOPIFY", "16/10/2026,20.00,KOBE CAFE");
    const combined = lines.find((entry) => entry.amount === "66.71")!;
    const guidance = (await guide(w, combined.id))!;
    expect(guidance).toMatchObject({ status: "combined" });
    expect(guidance.payouts.map((payout) => payout.externalId)).toEqual(["70001", "70002"]);

    const report = await w.as((tx) => payoutMatchReport(tx, { from: "2026-10-01", to: "2026-10-31" }, "2026-10-31"));
    expect(report.payouts.map((payout) => [payout.payoutId, payout.inAccounts, payout.bankLine])).toEqual([
      ["70001", true, null],
      ["70002", true, null],
    ]);
    expect(report.deposits.map((deposit) => [deposit.amount, deposit.status])).toEqual([
      ["66.71", "combined"],
      ["12.00", "unmatched"],
      ["20.00", "not_a_payout"],
    ]);
    expect(report.deposits[0]).toMatchObject({ suggestion: { kind: "match" } });
    expect(report.clearingBalances).toEqual([expect.objectContaining({ accountCode: "1010", balance: "0.00" })]);
    // The report changed nothing.
    expect((await w.as((tx) => listStatementLines(tx, combined.accountId, { status: "unreconciled" }))).lines).toHaveLength(3);

    await reconcile(w, combined.id, guidance.action!);
    const after = await w.as((tx) => payoutMatchReport(tx, { from: "2026-10-01", to: "2026-10-31" }, "2026-10-31"));
    expect(after.payouts.map((payout) => payout.bankLine?.date)).toEqual(["2026-10-15", "2026-10-15"]);
  });

  it("#570: a store connected again lists each payout once, a lone payout isn't a choice, and the clearing balance is the ledger's", async () => {
    const w = await setup();
    await firstPayout(w);
    w.state.orders.push(order1003());
    await w.sync("2026-10-09T04:00:00Z");
    // Its login stopped working, so it was disconnected and connected again as a new connection with the same accounts.
    await disconnectStore(w.record, w.actor, w.connectionId);
    const again = await connectStore(
      w.record,
      w.actor,
      { platform: "shopify", storeDomain: "glimmers", authMethod: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      { webhookOrigin: null, now: new Date("2026-10-10T00:00:00Z") },
    );
    await w.as((tx) =>
      updateConnectionSettings(tx, again.id, {
        postToAccounts: true,
        startDate: "2026-10-01",
        clearingAccountCode: "1010",
        payoutAccountCode: "1000",
        feesAccountCode: "6020",
        salesAccountCode: "4000",
        shippingAccountCode: "4000",
        taxCodes: [{ rate: "15", taxCode: "GST" }],
        untaxedTaxCode: "ZERO",
      }),
    );
    const [line] = await w.bankLines("08/10/2026,49.38,SHOPIFY");
    const report = await w.as((tx) => payoutMatchReport(tx, { from: "2026-10-01", to: "2026-10-31" }, "2026-10-31"));
    expect(report.payouts.map((payout) => [payout.payoutId, payout.connectionId])).toEqual([["70001", again.id]]);
    expect(report.deposits.map((deposit) => [deposit.lineId, deposit.status, "payoutIds" in deposit ? deposit.payoutIds : null])).toEqual([[line.id, "matched", ["70001"]]]);
    // The order not yet paid out is still in the clearing account: once, as the ledger has it.
    const ledger = await w.balance("1010");
    expect(ledger).not.toBe("0.00");
    expect(report.clearingBalances).toEqual([expect.objectContaining({ accountCode: "1010", balance: ledger })]);
    // #571: get_bank_line shows the same payout for the line, with the posted transfer among its matches.
    const tool = AI_TOOLS.find((entry) => entry.name === "get_bank_line")!;
    const got = (await w.as((tx) => tool.run(tx, { lineId: line.id }, {} as ToolContext))) as {
      suggestions: { platformPayout: unknown; matches: Array<{ exact: boolean; voided: boolean }>; voidedLeftOut: number };
    };
    expect(got.suggestions.platformPayout).toMatchObject({ status: "matched", platform: "Shopify", payoutIds: ["70001"], suggestion: { kind: "match" } });
    expect(got.suggestions.matches[0]).toMatchObject({ exact: true, voided: false });
    // Asked about the new connection only, it's the same.
    const one = await w.as((tx) => payoutMatchReport(tx, { connectionId: again.id, from: "2026-10-01", to: "2026-10-31" }, "2026-10-31"));
    expect(one.payouts).toHaveLength(1);
    expect(one.deposits).toMatchObject([{ status: "matched" }]);
  });

  it("SPC38: the payout's own TRANSFER row isn't in its settlement; settlements kept before that are corrected by migration 0226", async () => {
    const w = await setup();
    await w.sync("2026-10-01T01:00:00Z");
    w.state.orders.push(order1001({ financialStatus: "PARTIALLY_REFUNDED", updatedAt: "2026-10-05T22:00:30Z", refunds: [refund6001()] }), order1002());
    const plain = payout70001();
    w.state.payouts.push(payout70001({ transactions: [...plain.transactions, { id: 80009, type: "TRANSFER", amount: "-49.38", fee: "0.00", net: "-49.38", orderName: null }] }));
    await w.sync("2026-10-07T04:00:00Z");
    const settlement = async () => {
      const report = await w.as((tx) => payoutMatchReport(tx, { from: "2026-10-01", to: "2026-10-31" }, "2026-10-31"));
      return report.payouts[0].settlement;
    };
    expect(await settlement()).toMatchObject({ grossSales: "74.90", refunds: "-23.00", fees: "-2.52", other: "0.00", net: "49.38", transactionCount: 3, addsUp: true });
    expect(await w.balance("1010")).toBe("0.00");

    // As an earlier version kept it: the TRANSFER row under other, so other is minus the net and it doesn't add up.
    await w.as((tx) => tx.query("update sales_platform_payouts set other_amounts = -49.38, transaction_count = 4"));
    expect(await settlement()).toMatchObject({ other: "-49.38", addsUp: false });
    const migration = tenantMigrations.find((entry) => entry.version === "0226")!;
    const correction = migration.sql.slice(migration.sql.indexOf("update sales_platform_payouts"));
    await w.as((tx) => tx.query(correction));
    expect(await settlement()).toMatchObject({ other: "0.00", net: "49.38", transactionCount: 3, addsUp: true });
    // A settlement with a real unknown amount is left as it is.
    await w.as((tx) => tx.query("update sales_platform_payouts set other_amounts = -5.00"));
    await w.as((tx) => tx.query(correction));
    expect(await settlement()).toMatchObject({ other: "-5.00", addsUp: false });
  });

  it("#572: a store that refuses the login is behind and needs reconnecting; Reconnect on the same connection brings it back", async () => {
    const w = await setup();
    await w.sync("2026-10-01T01:00:00Z");
    // The app's access was taken away in Shopify: every token Tohyee holds is refused (401).
    w.state.tokens = [];
    for (const at of ["2026-10-01T01:15:00Z", "2026-10-01T01:30:00Z", "2026-10-01T01:45:00Z", "2026-10-01T02:00:00Z"]) {
      await expect(w.sync(at)).rejects.toThrow(/said 401/);
    }
    const status = async (now: string) => (await w.as((tx) => salesPlatformDiagnostics(tx, { connectionId: w.connectionId }, new Date(now)))).connections[0];
    const failing = await status("2026-10-01T02:10:00Z");
    expect(failing.status).toBe("paused");
    expect(failing.freshness).toMatchObject({
      lastSyncAt: "2026-10-01T02:00:00.000Z",
      lastSuccessfulSyncAt: "2026-10-01T01:00:00.000Z",
      behind: true,
      needsReconnect: true,
      failuresInARow: 4,
    });

    // Wrong credentials are refused and change nothing.
    await expect(
      reconnectStore(w.record, w.actor, w.connectionId, { authMethod: "client_credentials", clientId: CLIENT_ID, clientSecret: "shpss_wrong_secret_made_up" }),
    ).rejects.toThrow(/refused these credentials/);
    expect((await status("2026-10-01T02:10:00Z")).status).toBe("paused");

    const reconnected = await reconnectStore(w.record, w.actor, w.connectionId, { authMethod: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, storeDomain: "another-shop" });
    expect(reconnected).toMatchObject({ id: w.connectionId, status: "active", failures: 0, lastError: null, needsReconnect: false, storeDomain: "glimmers.myshopify.com" });
    await w.sync("2026-10-01T03:00:00Z");
    expect((await status("2026-10-01T03:05:00Z")).freshness).toMatchObject({ lastSuccessfulSyncAt: "2026-10-01T03:00:00.000Z", behind: false, needsReconnect: false });
    // Still one connection for the store.
    expect((await w.as((tx) => tx.query("select count(*)::int as n from sales_platform_connections"))).rows[0].n).toBe(1);
  });

  it("SPR9: a payout posted before #548 has no settlement but still matches; deposits before the start date stay unresolved", async () => {
    const w = await setup();
    await firstPayout(w);
    await w.as((tx) => tx.query("delete from sales_platform_payouts"));
    const lines = await w.bankLines("08/10/2026,49.38,SHOPIFY", "20/09/2026,80.00,SHOPIFY");
    const posted = (await guide(w, lines.find((entry) => entry.amount === "49.38")!.id))!;
    expect(posted).toMatchObject({ status: "matched" });
    expect(posted.payouts[0].settlement).toBeNull();
    const early = (await guide(w, lines.find((entry) => entry.amount === "80.00")!.id))!;
    expect(early).toMatchObject({ status: "missing_settlement_data", action: null });
  });

  it("SPR10: not registered: no GST anywhere, and the payout still reconciles", async () => {
    const w = await setup({ gst: false });
    await firstPayout(w);
    expect(await w.balance("2100")).toBe("0.00");
    const [line] = await w.bankLines("08/10/2026,49.38,SHOPIFY");
    const guidance = (await guide(w, line.id))!;
    expect(guidance).toMatchObject({ status: "matched", gst: { status: "not_registered" } });
    await reconcile(w, line.id, guidance.action!);
    expect(await w.balance("2100")).toBe("0.00");
    expect(await w.balance("1010")).toBe("0.00");
    // Sales at the full amount (74.90 - 23.00 refunded), once.
    expect(await w.balance("4000")).toBe("-51.90");
  });

  it("SPR10: registration not confirmed: the orders wait, so the payout's sales aren't in the books and it says so", async () => {
    const w = await setup();
    await w.as((tx) => tx.query("update organisation_settings set gst_registration_confirmed_at = null, gst_registration_confirmed_by = null"));
    await firstPayout(w);
    expect(await w.balance("2100")).toBe("0.00");
    expect(await w.balance("4000")).toBe("0.00");
    const [line] = await w.bankLines("08/10/2026,49.38,SHOPIFY");
    const guidance = (await guide(w, line.id))!;
    expect(guidance.gst.status).toBe("unconfirmed");
    expect(guidance.payouts[0].ordersNotInBooks).toEqual(["#1001", "#1002"]);
    const report = await w.as((tx) => payoutMatchReport(tx, { from: "2026-10-01", to: "2026-10-31" }, "2026-10-31"));
    expect(report.payouts[0]).toMatchObject({ ordersNotInBooks: ["#1001", "#1002"], gst: { status: "unconfirmed" } });
  });
});

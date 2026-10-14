import { afterAll, beforeAll, expect, it } from "vitest";
import { createAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postJournalBody } from "@/lib/ledger/journals";
import { add, dec, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { balanceSheet, profitAndLoss } from "@/lib/reports/financial";
import { cashFlowStatement, changesInEquity } from "@/lib/reports/statements";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

type Origin = Parameters<typeof postJournalBody>[4]["origin"];

/** The statement of changes in equity and the statement of cash flows (#259). */
describeWithDatabase("statement of changes in equity and statement of cash flows", () => {
  let server: TestServer;
  let owner: SessionUser;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("statements-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  /** A fresh organisation with the SCE1/SCF1 books, depreciation posted with `depreciationOrigin`. */
  async function books(slug: string, depreciationOrigin: Origin) {
    await createTestOrganisation(owner, slug);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(slug, { userId: owner.id, email: owner.email }, work);
    const post = (postingDate: string, origin: Origin, lines: Array<[string, string, string]>) =>
      as((tx) =>
        postJournalBody(
          tx,
          "test",
          key("journal"),
          {
            postingDate,
            reference: "Books",
            description: null,
            currencyCode: tx.baseCurrency,
            lines: lines.map(([accountCode, debit, credit]) => ({ accountCode, debit, credit, description: null, tracking: {}, customInput: undefined, foreign: null })),
            total: toFixedString(lines.reduce((sum, [, debit]) => add(sum, dec(debit)), ZERO_DECIMAL), 2),
            customInput: undefined,
          },
          { origin },
        ),
      );
    const pair = (date: string, debit: string, credit: string, amount: string, origin: Origin = "manual") =>
      post(date, origin, [
        [debit, amount, "0"],
        [credit, "0", amount],
      ]);
    await pair("2026-04-01", "1000", "3000", "5000.00");
    await pair("2026-04-05", "1000", "2800", "1500.00");
    await pair("2026-04-10", "1620", "1000", "2000.00");
    await pair("2026-06-01", "1100", "4000", "3000.00");
    await pair("2026-07-01", "1000", "1100", "2200.00");
    await pair("2026-08-01", "6010", "2000", "1350.00");
    await pair("2026-09-01", "2000", "1000", "1050.00");
    await pair("2027-03-31", "6300", "1630", "400.00", depreciationOrigin);
    await pair("2026-10-01", "3100", "1000", "300.00");
    return { as, post, pair };
  }

  const year = { from: "2026-04-01", to: "2027-03-31" };

  it("SCE1, SCE2: opening equity, profit, each equity account's movement, closing equity", async () => {
    const { as } = await books("sce-co", "manual");
    const sce = await as((tx) => changesInEquity(tx, year));
    expect(sce.openingEquity).toBe("0.00");
    expect(sce.profit).toBe("1250.00");
    expect(sce.movements.map((row) => [row.label, row.amount])).toEqual([
      ["Owner funds introduced", "5000.00"],
      ["Owner drawings", "-300.00"],
    ]);
    expect(sce.closingEquity).toBe("5950.00");
    expect(sce.reconciles).toBe(true);
    expect((await as((tx) => balanceSheet(tx, { asAt: "2027-03-31" }))).equity.total).toBe("5950.00");

    const next = await as((tx) => changesInEquity(tx, { from: "2027-04-01", to: "2028-03-31" }));
    expect([next.openingEquity, next.profit, next.movements.length, next.closingEquity, next.reconciles]).toEqual(["5950.00", "0.00", 0, "5950.00", true]);
  });

  it("SCF1, SCF2: indirect method; depreciation added back however it was posted", async () => {
    for (const [slug, origin] of [
      ["scf-hand", "manual"],
      ["scf-run", "fixed_asset_depreciation"],
    ] as const) {
      const { as } = await books(slug, origin);
      const cf = await as((tx) => cashFlowStatement(tx, year));
      expect(cf.operating.profit).toBe("1250.00");
      expect(cf.operating.adjustments).toEqual([{ accountId: null, code: null, label: "Depreciation", amount: "400.00" }]);
      expect(cf.operating.workingCapital.map((row) => [row.code, row.amount])).toEqual([
        ["1100", "-800.00"],
        ["2000", "300.00"],
      ]);
      expect(cf.operating.total).toBe("1150.00");
      expect(cf.investing.lines.map((row) => [row.code, row.amount])).toEqual([["1620", "-2000.00"]]);
      expect(cf.investing.total).toBe("-2000.00");
      expect(cf.financing.lines.map((row) => [row.code, row.amount])).toEqual([
        ["2800", "1500.00"],
        ["3000", "5000.00"],
        ["3100", "-300.00"],
      ]);
      expect(cf.financing.total).toBe("6200.00");
      expect([cf.netChange, cf.openingCash, cf.closingCash, cf.reconciles]).toEqual(["5350.00", "0.00", "5350.00", true]);
      // The statement's profit is the P&L's.
      expect((await as((tx) => profitAndLoss(tx, year))).netProfit).toBe(cf.operating.profit);
    }
  });

  it("SCF3: a disposal's gain moves from operating to investing as proceeds", async () => {
    const { as, post } = await books("scf-disposal", "fixed_asset_depreciation");
    await post("2027-03-31", "fixed_asset_disposal", [
      ["1000", "1800.00", "0"],
      ["1630", "400.00", "0"],
      ["1620", "0", "2000.00"],
      ["7030", "0", "200.00"],
    ]);
    const cf = await as((tx) => cashFlowStatement(tx, year));
    expect(cf.operating.profit).toBe("1450.00");
    expect(cf.operating.adjustments.map((row) => [row.label, row.amount])).toEqual([
      ["Depreciation", "400.00"],
      ["Gain or loss on disposal of fixed assets", "-200.00"],
    ]);
    expect(cf.operating.total).toBe("1150.00");
    expect(cf.investing.lines.map((row) => [row.code, row.amount])).toEqual([["1620", "-2000.00"]]);
    expect(cf.investing.disposalProceeds).toBe("1800.00");
    expect(cf.investing.total).toBe("-200.00");
    expect([cf.netChange, cf.closingCash, cf.reconciles]).toEqual(["7150.00", "7150.00", true]);
  });

  it("SCF4: a livestock revaluation is non-cash; opening balances count as cash at the start", async () => {
    const { as, post, pair } = await books("scf-livestock", "fixed_asset_depreciation");
    await as(async (tx) => {
      await createAccount(tx, { code: "1500", name: "Livestock on hand", accountType: "non_current_asset" });
      await createAccount(tx, { code: "5210", name: "Change in livestock value", accountType: "direct_costs" });
    });
    await pair("2027-03-31", "1500", "5210", "1000.00", "livestock_valuation");
    let cf = await as((tx) => cashFlowStatement(tx, year));
    expect(cf.operating.profit).toBe("2250.00");
    expect(cf.operating.adjustments.map((row) => [row.label, row.amount])).toEqual([
      ["Depreciation", "400.00"],
      ["Change in livestock value", "-1000.00"],
    ]);
    expect([cf.operating.total, cf.investing.total, cf.financing.total, cf.netChange, cf.reconciles]).toEqual(["1150.00", "-2000.00", "6200.00", "5350.00", true]);

    // Opening balances brought in during the period: their bank part is cash at the start.
    await post("2026-04-01", "opening_balance", [
      ["1000", "250.00", "0"],
      ["3900", "0", "250.00"],
    ]);
    cf = await as((tx) => cashFlowStatement(tx, year));
    expect([cf.openingCash, cf.netChange, cf.closingCash, cf.reconciles]).toEqual(["250.00", "5350.00", "5600.00", true]);
  });
});

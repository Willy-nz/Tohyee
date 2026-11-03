import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBudgets, createBudget } from "@/lib/budgets/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { accountTransactions } from "@/lib/reports/account-transactions";
import { budgetVsActual } from "@/lib/reports/budget-vs-actual";
import { computeCustomReport, createCustomReport } from "@/lib/reports/custom";
import type { CustomReportLayout } from "@/lib/reports/custom-layout";
import { balanceSheet, profitAndLoss, trialBalance } from "@/lib/reports/financial";
import { balanceSheetCompare, type MultiColumnStatement, profitAndLossCompare } from "@/lib/reports/statement-compare";
import { createTrackingValue, getTrackingSetup } from "@/lib/tracking/service";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * Examples RX1-RX6 and ATX6 in docs/ACCOUNTING-EXAMPLES.md: the standard
 * profit and loss and balance sheet compared with earlier periods, % of
 * trading income, tracking filters on every financial report, and income
 * and expense accounts opening at the start of the financial year. The
 * setup is the custom-report journals (CR1-CR10), 31 March year end.
 */
describeWithDatabase("comparing reports and tracking filters", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("rx-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `report-compare-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const journal = (postingDate: string, debit: string, credit: string, amount: string, tracking?: Record<string, string>) =>
      as((tx) =>
        postJournal(tx, {
          idempotencyKey: key("journal"),
          postingDate,
          reference: "Setup",
          lines: [
            { accountCode: debit, debitAmount: amount, creditAmount: "0", ...(tracking ? { tracking } : {}) },
            { accountCode: credit, debitAmount: "0", creditAmount: amount, ...(tracking ? { tracking } : {}) },
          ],
        }),
      );
    await journal("2026-03-01", "1000", "3000", "5000.00");
    await journal("2026-03-20", "1000", "4000", "500.00");
    await journal("2026-04-10", "1000", "4000", "1000.00");
    await journal("2026-04-15", "6010", "1000", "100.00");
    await journal("2026-05-12", "1000", "4000", "1500.00");
    await journal("2026-05-13", "5000", "1000", "400.00");
    await journal("2026-06-08", "1000", "4000", "1200.00");
    await journal("2026-06-09", "5000", "1000", "300.00");
    await journal("2026-06-20", "6010", "1000", "250.00");
    await journal("2026-06-30", "1000", "4200", "20.00");
    return { org, as, journal };
  }

  /** label -> values in column order. */
  const table = (report: MultiColumnStatement) =>
    Object.fromEntries(
      report.rows.filter((row) => row.kind !== "heading" && row.kind !== "subheading").map((row) => [row.label, report.columns.map((column) => row.values[column.key])]),
    );

  it("RX1: compares June with two earlier months, with a total, and with quarters and years", async () => {
    const w = await setup();
    const report = await w.as((tx) => profitAndLossCompare(tx, { from: "2026-06-01", to: "2026-06-30" }, { periods: 2, periodLength: "month", total: true, order: "newest_first" }));
    expect(report.columns.map((column) => column.label)).toEqual(["Jun 2026", "May 2026", "Apr 2026", "Total"]);
    const rows = table(report);
    expect(rows["4000 · Sales"]).toEqual(["1200.00", "1500.00", "1000.00", "3700.00"]);
    expect(rows["Total cost of sales"]).toEqual(["300.00", "400.00", "0.00", "700.00"]);
    expect(rows["Gross profit"]).toEqual(["900.00", "1100.00", "1000.00", "3000.00"]);
    expect(rows["Total other income"]).toEqual(["20.00", "0.00", "0.00", "20.00"]);
    expect(rows["Total operating expenses"]).toEqual(["250.00", "0.00", "100.00", "350.00"]);
    expect(rows["Net profit"]).toEqual(["670.00", "1100.00", "900.00", "2670.00"]);
    // Each column is the standard report for its dates (CR9).
    const may = await w.as((tx) => profitAndLoss(tx, { from: "2026-05-01", to: "2026-05-31" }));
    expect(may.netProfit).toBe("1100.00");

    const quarters = await w.as((tx) => profitAndLossCompare(tx, { from: "2026-04-01", to: "2026-06-30" }, { periods: 1, periodLength: "quarter", order: "newest_first" }));
    expect(table(quarters)["Net profit"]).toEqual(["2670.00", "500.00"]);
    const years = await w.as((tx) => profitAndLossCompare(tx, { from: "2026-04-01", to: "2026-06-30" }, { periods: 1, periodLength: "year", order: "newest_first" }));
    expect(table(years)["Net profit"]).toEqual(["2670.00", "0.00"]);
  });

  it("RX2: moves part months back with the same days, and adds the year to date", async () => {
    const w = await setup();
    const part = await w.as((tx) => profitAndLossCompare(tx, { from: "2026-06-01", to: "2026-06-20" }, { periods: 1, periodLength: "month", order: "newest_first" }));
    expect(part.columns.map((column) => [column.from, column.to])).toEqual([
      ["2026-06-01", "2026-06-20"],
      ["2026-05-01", "2026-05-20"],
    ]);
    expect(table(part)["Net profit"]).toEqual(["650.00", "1100.00"]);
    const ytd = await w.as((tx) => profitAndLossCompare(tx, { from: "2026-06-01", to: "2026-06-30" }, { periods: 1, periodLength: "month", yearToDate: true, order: "newest_first" }));
    expect(ytd.columns.map((column) => column.label)).toEqual(["Jun 2026", "May 2026", "Year to date"]);
    expect(table(ytd)["Net profit"]).toEqual(["670.00", "1100.00", "2670.00"]);
  });

  it("RX3: compares balance sheet dates; total, year to date and too many periods are refused", async () => {
    const w = await setup();
    const report = await w.as((tx) => balanceSheetCompare(tx, { asAt: "2026-06-30" }, { periods: 1, periodLength: "month", order: "newest_first" }));
    expect(report.columns.map((column) => column.label)).toEqual(["30 Jun 2026", "31 May 2026"]);
    const rows = table(report);
    expect(rows["Net assets"]).toEqual(["8170.00", "7500.00"]);
    expect(rows["Current year earnings"]).toEqual(["2670.00", "2000.00"]);
    expect(rows["Total equity"]).toEqual(["8170.00", "7500.00"]);
    expect(report.balanced).toEqual({ p0: true, p1: true });
    await expect(w.as((tx) => balanceSheetCompare(tx, { asAt: "2026-06-30" }, { periods: 1, periodLength: "month", total: true }))).rejects.toThrow(
      "no total, year to date",
    );
    const { parseCompare } = await import("@/lib/reports/statement-compare");
    expect(() => parseCompare({ compare: "12" })).toThrow("0 to 11");
    expect(parseCompare({ compare: "0" })).toBeNull();
  });

  it("RX7: the periods run oldest first by default, with Total, Year to date and % after them", async () => {
    const w = await setup();
    const report = await w.as((tx) =>
      profitAndLossCompare(tx, { from: "2026-06-01", to: "2026-06-30" }, { periods: 2, periodLength: "month", total: true, yearToDate: true, percentOfIncome: true }),
    );
    expect(report.columns.map((column) => column.label)).toEqual(["Apr 2026", "%", "May 2026", "%", "Jun 2026", "%", "Total", "%", "Year to date", "%"]);
    expect(report.from).toBe("2026-06-01");
    const rows = table(report);
    expect(rows["4000 · Sales"]).toEqual(["1000.00", "100.0", "1500.00", "100.0", "1200.00", "100.0", "3700.00", "100.0", "3700.00", "100.0"]);
    expect(rows["Net profit"]).toEqual(["900.00", "90.0", "1100.00", "73.3", "670.00", "55.8", "2670.00", "72.2", "2670.00", "72.2"]);
    // The rows are the same, in the same order, whichever way the columns run.
    const newest = await w.as((tx) =>
      profitAndLossCompare(tx, { from: "2026-06-01", to: "2026-06-30" }, { periods: 2, periodLength: "month", total: true, yearToDate: true, percentOfIncome: true, order: "newest_first" }),
    );
    expect(newest.rows.map((row) => row.label)).toEqual(report.rows.map((row) => row.label));
    expect(newest.rows.map((row) => row.values)).toEqual(report.rows.map((row) => row.values));

    const sheet = await w.as((tx) => balanceSheetCompare(tx, { asAt: "2026-06-30" }, { periods: 1, periodLength: "month" }));
    expect(sheet.columns.map((column) => column.label)).toEqual(["31 May 2026", "30 Jun 2026"]);
    expect(table(sheet)["Net assets"]).toEqual(["7500.00", "8170.00"]);
    expect(sheet.to).toBe("2026-06-30");
  });

  it("RX4: % of trading income, rounded to 1 place, blank with no trading income", async () => {
    const w = await setup();
    const june = await w.as((tx) => profitAndLossCompare(tx, { from: "2026-06-01", to: "2026-06-30" }, { periods: 0, periodLength: "month", percentOfIncome: true }));
    expect(june.columns.map((column) => column.key)).toEqual(["p0", "p0_pct"]);
    const rows = table(june);
    expect(rows["4000 · Sales"]).toEqual(["1200.00", "100.0"]);
    expect(rows["Total cost of sales"]).toEqual(["300.00", "25.0"]);
    expect(rows["Gross profit"]).toEqual(["900.00", "75.0"]);
    expect(rows["4200 · Interest income"]).toEqual(["20.00", "1.7"]);
    expect(rows["6010 · Accounting fees"]).toEqual(["250.00", "20.8"]);
    expect(rows["Net profit"]).toEqual(["670.00", "55.8"]);
    const february = await w.as((tx) => profitAndLossCompare(tx, { from: "2026-02-01", to: "2026-02-28" }, { periods: 0, periodLength: "month", percentOfIncome: true }));
    expect(table(february)["Net profit"]).toEqual(["0.00", null]);
  });

  async function withOtago() {
    const w = await setup();
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const location = (await w.as((tx) => getTrackingSetup(tx))).categories.find((category) => category.kind === "location")!;
    await w.as((tx) => createTrackingValue(tx, { categoryId: location.id, name: "Otago" }));
    const setupNow = await w.as((tx) => createTrackingValue(tx, { categoryId: location.id, name: "Canterbury" }));
    const values = setupNow.categories.find((category) => category.id === location.id)!.values;
    const otago = values.find((value) => value.name === "Otago")!;
    await w.journal("2026-06-15", "1000", "4000", "300.00", { [location.id]: otago.id });
    return { ...w, location, otago };
  }

  it("RX5: filters the profit and loss, balance sheet and trial balance to a tracking value or Not set", async () => {
    const w = await withOtago();
    const otago = { trackingCategoryId: w.location.id, trackingValueId: w.otago.id };
    const pnl = await w.as((tx) => profitAndLoss(tx, { from: "2026-06-01", to: "2026-06-30", ...otago }));
    expect(pnl.revenue.total).toBe("300.00");
    expect(pnl.netProfit).toBe("300.00");
    expect(pnl.filter?.label).toBe("Location: Otago");
    const sheet = await w.as((tx) => balanceSheet(tx, { asAt: "2026-06-30", ...otago }));
    expect(sheet.assets.total).toBe("300.00");
    expect(sheet.equity.currentYearEarnings).toBe("300.00");
    expect(sheet.netAssets).toBe("300.00");
    expect(sheet.equity.total).toBe("300.00");
    expect(sheet.balanced).toBe(true);
    const tb = await w.as((tx) => trialBalance(tx, { asAt: "2026-06-30", ...otago }));
    expect(tb.rows.map((row) => [row.code, row.debit, row.credit])).toEqual([
      ["1000", "300.00", "0.00"],
      ["4000", "0.00", "300.00"],
    ]);
    const notSet = await w.as((tx) => profitAndLoss(tx, { from: "2026-06-01", to: "2026-06-30", trackingCategoryId: w.location.id, trackingValueId: "unassigned" }));
    expect(notSet.revenue.total).toBe("1200.00");
    expect(notSet.netProfit).toBe("670.00");
    const all = await w.as((tx) => profitAndLoss(tx, { from: "2026-06-01", to: "2026-06-30" }));
    expect(all.netProfit).toBe("970.00");
    // Filters work with compare too.
    const compared = await w.as((tx) => profitAndLossCompare(tx, { from: "2026-06-01", to: "2026-06-30", ...otago }, { periods: 1, periodLength: "month", order: "newest_first" }));
    expect(table(compared)["Net profit"]).toEqual(["300.00", "0.00"]);
    // A value from another category is refused.
    await expect(w.as((tx) => profitAndLoss(tx, { to: "2026-06-30", trackingCategoryId: "999999", trackingValueId: w.otago.id }))).rejects.toThrow();
  });

  it("RX6: budget vs actual filters an overall budget's actuals, and refuses another value for a tracking budget", async () => {
    const w = await withOtago();
    const overall = (await w.as((tx) => listBudgets(tx)))[0];
    const filtered = await w.as((tx) =>
      budgetVsActual(tx, { budgetId: overall.id, from: "2026-06", to: "2026-06", trackingCategoryId: w.location.id, trackingValueId: w.otago.id }),
    );
    expect(filtered.revenue.total.actual).toBe("300.00");
    expect(filtered.filter?.label).toBe("Location: Otago");
    const canterbury = (await w.as((tx) => getTrackingSetup(tx))).categories.find((c) => c.id === w.location.id)!.values.find((v) => v.name === "Canterbury")!;
    const plan = (await w.as((tx) => createBudget(tx, { idempotencyKey: key("b"), name: "Otago plan", trackingValueId: w.otago.id }))).budget;
    const same = await w.as((tx) => budgetVsActual(tx, { budgetId: plan.id, from: "2026-06", to: "2026-06", trackingCategoryId: w.location.id, trackingValueId: w.otago.id }));
    expect(same.revenue.total.actual).toBe("300.00");
    expect(same.filter).toBeNull();
    await expect(
      w.as((tx) => budgetVsActual(tx, { budgetId: plan.id, from: "2026-06", to: "2026-06", trackingCategoryId: w.location.id, trackingValueId: canterbury.id })),
    ).rejects.toThrow("already only lines tagged");
  });

  it("ATX6: income and expense accounts open at the start of the financial year", async () => {
    const w = await setup();
    const accountId = async (code: string) => (await w.as((tx) => tx.query<{ id: string }>("select id::text from accounts where code = $1", [code]))).rows[0].id;
    const sales = await accountId("4000");
    const april = await w.as((tx) => accountTransactions(tx, { accountId: sales, from: "2026-04-01", to: "2026-04-30" }));
    expect(april.accounts[0]).toMatchObject({ opening: "0.00", closing: "-1000.00" });
    const may = await w.as((tx) => accountTransactions(tx, { accountId: sales, from: "2026-05-01", to: "2026-05-31" }));
    expect(may.accounts[0]).toMatchObject({ opening: "-1000.00", closing: "-2500.00" });
    const tb = await w.as((tx) => trialBalance(tx, { asAt: "2026-05-31" }));
    expect(tb.rows.find((row) => row.code === "4000")!.credit).toBe("2500.00");
    const bankId = await accountId("1000");
    const bank = await w.as((tx) => accountTransactions(tx, { accountId: bankId, from: "2026-05-01", to: "2026-05-31" }));
    expect(bank.accounts[0].opening).toBe("6400.00");
    const across = await w.as((tx) => accountTransactions(tx, { accountId: sales, from: "2026-03-01", to: "2026-04-30" }));
    expect(across.accounts[0]).toMatchObject({ opening: "0.00", closing: "-1500.00" });
    expect(across.crossesYearEnd).toBe(true);
    expect(may.crossesYearEnd).toBe(false);
    // Several accounts at once (a custom report group's total, decision 1356).
    const interest = await accountId("4200");
    const both = await w.as((tx) => accountTransactions(tx, { accountIds: `${sales},${interest}`, from: "2026-06-01", to: "2026-06-30" }));
    expect(both.accounts.map((account) => account.code)).toEqual(["4000", "4200"]);
  });

  it("custom report cells carry their accounts and dates for drill-down (decision 1356)", async () => {
    const w = await setup();
    const report = (await w.as((tx) => createCustomReport(tx, { idempotencyKey: key("cr"), base: "profit_and_loss", periodEnd: "2026-06-30" }))).report;
    const figures = await w.as((tx) => computeCustomReport(tx, "profit_and_loss", report.layout as CustomReportLayout));
    expect(figures.columns[0]).toMatchObject({ from: "2026-06-01", to: "2026-06-30", drillFrom: "2026-06-01" });
    const block = figures.blocks[0];
    if (block.kind !== "table") throw new Error("expected a table");
    const revenue = block.rows.find((row) => row.id === "revenue")!;
    expect(revenue.accountIds).toHaveLength(1);
    expect(revenue.lines[0].accountId).toBe(revenue.accountIds![0]);
  });
});

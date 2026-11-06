import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBudget } from "@/lib/budgets/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postJournal } from "@/lib/ledger/journals";
import { createCustomReport, getCustomReport } from "@/lib/reports/custom";
import type { TransactionCustomReportFigures, TransactionReportBase } from "@/lib/reports/custom-layout";
import { trialBalance } from "@/lib/reports/financial";
import { changesInEquity } from "@/lib/reports/statements";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "custom-report-starts";

/** CRS1: every standard report as a custom report starting point (not yet reviewed). Made-up figures. */
describeWithDatabase("custom report starting points", () => {
  let server: TestServer;
  let owner: SessionUser;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const start = async (base: TransactionReportBase, layout?: unknown) => {
    const made = (await run((tx) => createCustomReport(tx, { idempotencyKey: key("r"), base, periodEnd: "2026-05-31", ...(layout ? { layout } : {}) }))).report;
    const opened = await run((tx) => getCustomReport(tx, made.id));
    return { report: opened.report, figures: opened.figures as TransactionCustomReportFigures };
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("custom-report-starts-owner@example.com");
    await createTestOrganisation(owner, ORG);
    const pair = (date: string, debit: string, credit: string, amount: string) =>
      run((tx) =>
        postJournal(tx, {
          idempotencyKey: key("j"),
          postingDate: date,
          reference: "CRS",
          lines: [
            { accountCode: debit, debitAmount: amount, creditAmount: "0" },
            { accountCode: credit, debitAmount: "0", creditAmount: amount },
          ],
        }),
      );
    await pair("2026-04-01", "1000", "3000", "1000.00");
    await pair("2026-05-05", "6010", "1000", "230.00");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("CRS1: a trial balance custom report has the trial balance's own figures", async () => {
    const { report, figures } = await start("trial_balance");
    expect(report.layout).toMatchObject({ title: "Trial balance", filters: { asAt: "2026-05-31" }, columns: ["code", "name", "debit", "credit"] });
    const data = figures.data as Awaited<ReturnType<typeof trialBalance>>;
    expect(data.rows.map((row) => [row.code, row.debit, row.credit])).toEqual([
      ["1000", "770.00", "0.00"],
      ["3000", "0.00", "1000.00"],
      ["6010", "230.00", "0.00"],
    ]);
    expect(data).toEqual({ ...(await run((tx) => trialBalance(tx, { asAt: "2026-05-31" }))), columnValues: undefined, ...{} } as never);
    // No contact or document columns on a report of accounts.
    expect(figures.columnOptions.some((column) => column.key.startsWith("contact."))).toBe(false);
  });

  it("changes in equity, stock valuation and the first bank account", async () => {
    const equity = await start("changes_in_equity");
    expect((equity.figures.data as { closingEquity: string }).closingEquity).toBe((await run((tx) => changesInEquity(tx, { from: null, to: "2026-05-31" }))).closingEquity);
    const stock = await start("inventory_valuation");
    expect(stock.report.layout).toMatchObject({ filters: { asAt: null } });
    expect((stock.figures.data as { items: unknown[] }).items).toEqual([]);
    const bank = await start("bank_reconciliation");
    expect((bank.figures.data as { account: { code: string }; ledgerBalance: string })).toMatchObject({ account: { code: "1000" }, ledgerBalance: "770.00" });
  });

  it("budget vs actual: the budget chosen, or the latest", async () => {
    const plan = (await run((tx) => createBudget(tx, { idempotencyKey: key("b"), name: "Made-up plan" }))).budget;
    const latest = await start("budget_vs_actual");
    expect((latest.figures.data as { budget: { id: string } }).budget.id).toBe(plan.id);
    const chosen = await start("budget_vs_actual", { title: "Plan check", filters: { budgetId: plan.id, from: "2026-04-01", to: "2026-05-31" }, columns: ["code", "name", "actual", "budget", "variance"] });
    expect(chosen.report.layout).toMatchObject({ filters: { budgetId: plan.id } });
    expect((chosen.figures.data as { from: string; to: string })).toMatchObject({ from: "2026-04-01", to: "2026-05-31" });
  });
});

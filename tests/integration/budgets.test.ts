import { afterAll, beforeAll, expect, it } from "vitest";
import * as budgetAmountsRoute from "@/app/api/budgets/[budgetId]/amounts/route";
import * as budgetArchiveRoute from "@/app/api/budgets/[budgetId]/archive/route";
import * as budgetFillRoute from "@/app/api/budgets/[budgetId]/fill/route";
import * as budgetRoute from "@/app/api/budgets/[budgetId]/route";
import * as budgetsRoute from "@/app/api/budgets/route";
import * as budgetVsActualRoute from "@/app/api/reports/budget-vs-actual/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { fillSameAmount } from "@/lib/budgets/fill";
import {
  type Budget,
  createBudget,
  fillBudget,
  getBudget,
  listBudgets,
  renameBudget,
  setBudgetAmounts,
  setBudgetArchived,
} from "@/lib/budgets/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { postJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { budgetVsActual, type BudgetVsActual } from "@/lib/reports/budget-vs-actual";
import { createCustomReport, getCustomReport, publishCustomReport, updateCustomReport } from "@/lib/reports/custom";
import type { CustomReportFigures } from "@/lib/reports/custom-layout";
import { createTrackingValue, getTrackingSetup, updateTrackingValue } from "@/lib/tracking/service";
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

const noContext = undefined as unknown;

/** Examples BU1-BU8 in docs/ACCOUNTING-EXAMPLES.md ("Budgets"). Each test gets its own organisation with the setup journals. */
describeWithDatabase("budgets", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("budget-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("budget-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup(options: { journals?: boolean } = {}) {
    organisations += 1;
    const org = `budgets-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const department = (await as((tx) => getTrackingSetup(tx))).categories.find((c) => c.kind === "department")!.id;
    const value = async (name: string) =>
      (await as((tx) => createTrackingValue(tx, { categoryId: department, name }))).categories
        .find((c) => c.id === department)!
        .values.find((v) => v.name === name)!.id;
    const retail = await value("Retail");
    const wholesale = await value("Wholesale");
    const tag = (valueId: string) => ({ [department]: valueId });
    const journal = (postingDate: string, lines: Array<{ accountCode: string; debitAmount?: string; creditAmount?: string; tracking?: Record<string, string> }>) =>
      as((tx) => postJournal(tx, { idempotencyKey: key("journal"), postingDate, reference: "Setup", lines }));
    const simple = (postingDate: string, debit: string, credit: string, amount: string) =>
      journal(postingDate, [
        { accountCode: debit, debitAmount: amount },
        { accountCode: credit, creditAmount: amount },
      ]);
    if (options.journals !== false) {
      for (const year of ["2025", "2026"]) {
        for (const month of ["04", "05", "06"]) await simple(`${year}-${month}-01`, "6150", "1000", "500.00");
      }
      await journal("2025-04-10", [
        { accountCode: "1000", debitAmount: "1000.00" },
        { accountCode: "4000", creditAmount: "700.00", tracking: tag(retail) },
        { accountCode: "4000", creditAmount: "300.00", tracking: tag(wholesale) },
      ]);
      await journal("2025-05-12", [
        { accountCode: "1000", debitAmount: "1200.00" },
        { accountCode: "4000", creditAmount: "1200.00", tracking: tag(retail) },
      ]);
      await journal("2025-06-09", [
        { accountCode: "1000", debitAmount: "800.00" },
        { accountCode: "4000", creditAmount: "800.00", tracking: tag(wholesale) },
      ]);
      await journal("2026-04-10", [
        { accountCode: "1000", debitAmount: "1100.00" },
        { accountCode: "4000", creditAmount: "800.00", tracking: tag(retail) },
        { accountCode: "4000", creditAmount: "300.00", tracking: tag(wholesale) },
      ]);
      await journal("2026-05-12", [
        { accountCode: "1000", debitAmount: "1000.00" },
        { accountCode: "4000", creditAmount: "1000.00", tracking: tag(retail) },
      ]);
      await journal("2026-06-08", [
        { accountCode: "1000", debitAmount: "1300.00" },
        { accountCode: "4000", creditAmount: "1000.00", tracking: tag(retail) },
        { accountCode: "4000", creditAmount: "300.00", tracking: tag(wholesale) },
      ]);
      await simple("2026-06-20", "6010", "1000", "250.00");
    }
    const overall = (await as((tx) => listBudgets(tx)))[0];
    const fresh = async (id: string): Promise<Budget> => (await as((tx) => getBudget(tx, id))).budget;
    const set = async (budgetId: string, amounts: Array<[string, string, string]>) =>
      as(async (tx) =>
        setBudgetAmounts(tx, budgetId, {
          version: (await getBudget(tx, budgetId)).budget.version,
          amounts: amounts.map(([accountCode, month, amount]) => ({ accountCode, month, amount })),
        }),
      );
    const typeOverall = () =>
      set(overall.id, [
        ["4000", "2026-04", "1000.00"],
        ["4000", "2026-05", "1000.00"],
        ["4000", "2026-06", "1200.00"],
        ["6150", "2026-04", "500.00"],
        ["6150", "2026-05", "500.00"],
        ["6150", "2026-06", "500.00"],
        ["6010", "2026-06", "200.00"],
      ]);
    const fill = async (budgetId: string, command: Record<string, unknown>) =>
      as(async (tx) => fillBudget(tx, budgetId, { version: (await getBudget(tx, budgetId)).budget.version, ...command } as Parameters<typeof fillBudget>[2]));
    const row = async (budgetId: string, code: string, from = "2026-04", months = 3) =>
      (await as((tx) => getBudget(tx, budgetId, { from, months }))).accounts.find((a) => a.code === code)!.amounts;
    const journals = async () => Number((await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
    const retailPlan = async () => (await as((tx) => createBudget(tx, { idempotencyKey: key("b"), name: "Retail plan", trackingValueId: retail }))).budget;
    return { org, as, department, retail, wholesale, overall, fresh, set, typeOverall, fill, row, journals, retailPlan };
  }

  const figures = (report: BudgetVsActual) => {
    const out: Record<string, string[]> = {};
    for (const group of [report.revenue, report.costOfSales, report.otherIncome, report.expenses]) {
      for (const section of group.sections) {
        for (const line of section.lines) out[line.code] = [line.actual, line.budget, line.variance, line.variancePercent ?? ""];
      }
    }
    const f = (v: { actual: string; budget: string; variance: string; variancePercent: string | null }) => [v.actual, v.budget, v.variance, v.variancePercent ?? ""];
    out.Revenue = f(report.revenue.total);
    out["Gross profit"] = f(report.grossProfit);
    out.Expenses = f(report.expenses.total);
    out["Net profit"] = f(report.netProfit);
    return out;
  };

  it("BU1: every organisation has an overall budget; named budgets are unique, archived not deleted, and post nothing", async () => {
    const w = await setup({ journals: false });
    expect(await w.as((tx) => listBudgets(tx))).toMatchObject([{ name: "Overall budget", isOverall: true, trackingValueId: null }]);
    await expect(w.as((tx) => setBudgetArchived(tx, w.overall.id, true))).rejects.toThrow("overall budget can't be archived");
    await expect(w.as((tx) => tx.query("update budgets set archived_at = now(), archived_by_email = 'x' where is_overall"))).rejects.toThrow();

    const plan = await w.retailPlan();
    expect([plan.name, plan.trackingLabel, plan.isOverall]).toEqual(["Retail plan", "Department: Retail", false]);
    await expect(w.as((tx) => createBudget(tx, { idempotencyKey: key("b"), name: "retail plan" }))).rejects.toThrow("already a budget called retail plan");
    // Retried with the same key: the same budget.
    const k = key("same");
    const first = await w.as((tx) => createBudget(tx, { idempotencyKey: k, name: "Grants" }));
    const again = await w.as((tx) => createBudget(tx, { idempotencyKey: k, name: "Grants" }));
    expect([first.created, again.created, again.budget.id]).toEqual([true, false, first.budget.id]);
    await expect(w.as((tx) => createBudget(tx, { idempotencyKey: k, name: "Other" }))).rejects.toThrow("idempotency key");

    // Tracking values need Advanced reporting, and not an archived value.
    await w.as((tx) => updateTrackingValue(tx, w.wholesale, { isActive: false }));
    await expect(w.as((tx) => createBudget(tx, { idempotencyKey: key("b"), name: "Wholesale plan", trackingValueId: w.wholesale }))).rejects.toThrow(
      "Wholesale is archived",
    );
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: false }));
    await expect(w.as((tx) => createBudget(tx, { idempotencyKey: key("b"), name: "Retail two", trackingValueId: w.retail }))).rejects.toThrow(
      "Advanced reporting is off",
    );

    const archived = await w.as((tx) => setBudgetArchived(tx, plan.id, true));
    expect(archived.archivedAt).not.toBeNull();
    expect((await w.as((tx) => listBudgets(tx, { archived: true }))).map((b) => b.name)).toEqual(["Retail plan"]);
    expect((await w.as((tx) => listBudgets(tx))).map((b) => b.name)).toEqual(["Overall budget", "Grants"]);
    await expect(w.set(plan.id, [["4000", "2026-04", "1.00"]])).rejects.toThrow("archived");
    await expect(w.as((tx) => tx.query("insert into budget_amounts (budget_id, account_id, month, amount) select $1, id, '2026-04-01', 1 from accounts where code = '4000'", [plan.id]))).rejects.toThrow(
      "archived",
    );
    const back = await w.as((tx) => setBudgetArchived(tx, plan.id, false));
    expect(back.archivedAt).toBeNull();
    const renamed = await w.as((tx) => renameBudget(tx, plan.id, { name: "Shop plan", version: back.version }));
    expect(renamed.name).toBe("Shop plan");

    await expect(w.as((tx) => tx.query("delete from budgets where id = $1", [plan.id]))).rejects.toThrow("can't be deleted");
    await expect(w.as((tx) => tx.query("update budgets set tracking_value_id = null where id = $1", [plan.id]))).rejects.toThrow("never change");
    expect(await w.journals()).toBe(0);
  });

  it("BU2: typed amounts per account and month, with their history and the rules", async () => {
    const w = await setup();
    const before = await w.journals();
    const result = await w.typeOverall();
    expect(result.changed).toBe(7);
    const grid = await w.as((tx) => getBudget(tx, w.overall.id, { from: "2026-04", months: 12 }));
    expect(grid.months.slice(0, 3)).toEqual(["2026-04", "2026-05", "2026-06"]);
    const sales = grid.accounts.find((a) => a.code === "4000")!;
    expect([sales.amounts.slice(0, 3), sales.total]).toEqual([["1000.00", "1000.00", "1200.00"], "3200.00"]);
    expect(grid.totals[0]).toBe("1500.00");
    // Only profit and loss accounts are in the grid.
    expect(grid.accounts.some((a) => a.code === "1000")).toBe(false);

    const history = await w.as((tx) =>
      tx.query<{ actor_email: string; details: { changes: Array<{ account: string; month: string; from: string; to: string }> } }>(
        "select actor_email, details from audit_events where event_type = 'budget.amounts_changed' and entity_id = $1",
        [w.overall.id],
      ),
    );
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0].actor_email).toBe(owner.email);
    expect(history.rows[0].details.changes[0]).toEqual({ account: "4000", month: "2026-04", from: "0.00", to: "1000.00" });

    // Setting the same amounts again changes nothing and records nothing.
    expect((await w.typeOverall()).changed).toBe(0);

    await expect(w.set(w.overall.id, [["1000", "2026-04", "5.00"]])).rejects.toThrow("isn't a profit and loss account");
    await expect(
      w.as((tx) => tx.query("insert into budget_amounts (budget_id, account_id, month, amount) select $1, id, '2026-04-01', 1 from accounts where code = '1000'", [w.overall.id])),
    ).rejects.toThrow("profit and loss accounts only");
    await expect(w.set(w.overall.id, [["4000", "2026-04", "10.005"]])).rejects.toThrow("at most 2 decimal places");
    await expect(w.set(w.overall.id, [["4000", "2026-13", "10.00"]])).rejects.toThrow("month like 2026-04");
    await expect(
      w.set(w.overall.id, [
        ["4000", "2026-04", "1.00"],
        ["4000", "2026-04", "2.00"],
      ]),
    ).rejects.toThrow("two amounts for 2026-04");
    await expect(
      w.as((tx) => setBudgetAmounts(tx, w.overall.id, { version: 1, amounts: [{ accountCode: "4000", month: "2026-04", amount: "1.00" }] })),
    ).rejects.toThrow("Someone else has changed this budget");
    expect(await w.row(w.overall.id, "4000")).toEqual(["1000.00", "1000.00", "1200.00"]);
    await expect(w.as((tx) => tx.query("delete from budget_amounts where budget_id = $1", [w.overall.id]))).rejects.toThrow("can't be deleted");
    expect(await w.journals()).toBe(before);
  });

  it("BU3: quick fill with the same amount each month, optionally changing by a % each month", async () => {
    expect(fillSameAmount("500.00", 6, "2", 2)).toEqual(["500.00", "510.00", "520.20", "530.60", "541.22", "552.04"]);
    const w = await setup({ journals: false });
    await w.fill(w.overall.id, { accountCodes: ["6150"], from: "2026-04", months: 12, method: "same", amount: "500.00" });
    const grid = await w.as((tx) => getBudget(tx, w.overall.id, { from: "2026-04", months: 12 }));
    const rent = grid.accounts.find((a) => a.code === "6150")!;
    expect(new Set(rent.amounts)).toEqual(new Set(["500.00"]));
    expect(rent.total).toBe("6000.00");
    await w.fill(w.overall.id, { accountCodes: ["6150"], from: "2026-04", months: 12, method: "same", amount: "500.00", percent: "2" });
    expect(await w.row(w.overall.id, "6150", "2026-04", 6)).toEqual(["500.00", "510.00", "520.20", "530.60", "541.22", "552.04"]);
    await expect(w.fill(w.overall.id, { accountCodes: ["6150"], from: "2026-04", months: 25, method: "same", amount: "1" })).rejects.toThrow("1 to 24 months");
    await expect(w.fill(w.overall.id, { accountCodes: ["2100"], from: "2026-04", months: 1, method: "same", amount: "1" })).rejects.toThrow(
      "isn't a profit and loss account",
    );
  });

  it("BU4: quick fill from last year's actuals, optionally changed by a %, filtered to the budget's tracking value", async () => {
    const w = await setup();
    await w.fill(w.overall.id, { accountCodes: ["4000"], from: "2026-04", months: 3, method: "actuals" });
    expect(await w.row(w.overall.id, "4000")).toEqual(["1000.00", "1200.00", "800.00"]);
    await w.fill(w.overall.id, { accountCodes: ["4000"], from: "2026-04", months: 3, method: "actuals", percent: "10" });
    expect(await w.row(w.overall.id, "4000")).toEqual(["1100.00", "1320.00", "880.00"]);
    await w.fill(w.overall.id, { accountCodes: ["6150"], from: "2026-04", months: 3, method: "actuals", percent: "-5" });
    expect(await w.row(w.overall.id, "6150")).toEqual(["475.00", "475.00", "475.00"]);
    const plan = await w.retailPlan();
    await w.fill(plan.id, { accountCodes: ["4000"], from: "2026-04", months: 3, method: "actuals" });
    expect(await w.row(plan.id, "4000")).toEqual(["700.00", "1200.00", "0.00"]);
  });

  it("BU5: budget vs actual for the overall budget", async () => {
    const w = await setup();
    await w.typeOverall();
    const quarter = await w.as((tx) => budgetVsActual(tx, { budgetId: w.overall.id, from: "2026-04", to: "2026-06" }));
    expect([quarter.from, quarter.to]).toEqual(["2026-04-01", "2026-06-30"]);
    expect(figures(quarter)).toEqual({
      "4000": ["3400.00", "3200.00", "200.00", "6.3"],
      Revenue: ["3400.00", "3200.00", "200.00", "6.3"],
      "Gross profit": ["3400.00", "3200.00", "200.00", "6.3"],
      "6010": ["250.00", "200.00", "50.00", "25.0"],
      "6150": ["1500.00", "1500.00", "0.00", "0.0"],
      Expenses: ["1750.00", "1700.00", "50.00", "2.9"],
      "Net profit": ["1650.00", "1500.00", "150.00", "10.0"],
    });
    const june = figures(await w.as((tx) => budgetVsActual(tx, { budgetId: w.overall.id, from: "2026-06", to: "2026-06" })));
    expect([june.Revenue, june.Expenses, june["Net profit"]]).toEqual([
      ["1300.00", "1200.00", "100.00", "8.3"],
      ["750.00", "700.00", "50.00", "7.1"],
      ["550.00", "500.00", "50.00", "10.0"],
    ]);
    await expect(w.as((tx) => budgetVsActual(tx, { budgetId: w.overall.id, from: "2026-07", to: "2026-06" }))).rejects.toThrow("on or before");
  });

  it("BU6: budget vs actual for a budget with a tracking value counts only that value's lines", async () => {
    const w = await setup();
    const plan = await w.retailPlan();
    const empty = figures(await w.as((tx) => budgetVsActual(tx, { budgetId: plan.id, from: "2026-04", to: "2026-06" })));
    expect(empty["4000"]).toEqual(["2800.00", "0.00", "2800.00", ""]);
    await w.set(plan.id, [
      ["4000", "2026-04", "900.00"],
      ["4000", "2026-05", "900.00"],
      ["4000", "2026-06", "900.00"],
    ]);
    const report = figures(await w.as((tx) => budgetVsActual(tx, { budgetId: plan.id, from: "2026-04", to: "2026-06" })));
    expect(report).toEqual({
      "4000": ["2800.00", "2700.00", "100.00", "3.7"],
      Revenue: ["2800.00", "2700.00", "100.00", "3.7"],
      "Gross profit": ["2800.00", "2700.00", "100.00", "3.7"],
      Expenses: ["0.00", "0.00", "0.00", ""],
      "Net profit": ["2800.00", "2700.00", "100.00", "3.7"],
    });
  });

  it("BU7: a budget column and actual less budget in a custom profit and loss, frozen when published", async () => {
    const w = await setup();
    await w.typeOverall();
    const report = (await w.as((tx) => createCustomReport(tx, { idempotencyKey: key("cr"), base: "profit_and_loss", periodEnd: "2026-06-30" }))).report;
    const save = (columns: Record<string, unknown>, version: number, base = report) =>
      w.as((tx) => updateCustomReport(tx, base.id, { layout: { ...base.layout, columns: { ...base.layout.columns, ...columns } }, version }));
    const rowsOf = (figures: CustomReportFigures) => {
      const table = figures.blocks[0] as Extract<CustomReportFigures["blocks"][number], { kind: "table" }>;
      return Object.fromEntries(table.rows.map((row) => [row.label, figures.columns.map((column) => row.values[column.key])]));
    };
    const saved = await save({ budgetId: w.overall.id, budgetDifference: true }, 1);
    expect(saved.figures.columns.map((c) => c.label)).toEqual(["Jun 2026", "Budget (Overall budget)", "Actual less budget"]);
    const rows = rowsOf(saved.figures);
    expect([rows.Revenue, rows.Expenses, rows["Net profit"]]).toEqual([
      ["1300.00", "1200.00", "100.00"],
      ["750.00", "700.00", "50.00"],
      ["550.00", "500.00", "50.00"],
    ]);
    const quarterly = rowsOf((await save({ periodLength: "quarter", budgetId: w.overall.id, budgetDifference: true }, 2)).figures);
    expect([quarterly.Revenue[1], quarterly["Net profit"]]).toEqual(["3200.00", ["1650.00", "1500.00", "150.00"]]);

    const monthly = await save({ budgetId: w.overall.id, budgetDifference: true }, 3);
    const published = (await w.as((tx) => publishCustomReport(tx, report.id, { idempotencyKey: key("pub") }))).report;
    await w.set(w.overall.id, [["4000", "2026-06", "1250.00"]]);
    expect(rowsOf((await w.as((tx) => getCustomReport(tx, report.id))).figures).Revenue).toEqual(["1300.00", "1250.00", "50.00"]);
    expect(rowsOf((await w.as((tx) => getCustomReport(tx, published.id))).figures).Revenue).toEqual(["1300.00", "1200.00", "100.00"]);

    await expect(save({ budgetDifference: true, budgetId: null }, monthly.report.version)).rejects.toThrow("needs a budget column");
    await expect(save({ budgetId: "999999" }, monthly.report.version)).rejects.toThrow("no such budget");
    const sheet = (await w.as((tx) => createCustomReport(tx, { idempotencyKey: key("bs"), base: "balance_sheet", periodEnd: "2026-06-30" }))).report;
    await expect(save({ budgetId: w.overall.id }, 1, sheet)).rejects.toThrow("balance sheet has no budget column");
  });

  it("BU8: viewers can read budgets and budget vs actual; only bookkeepers and admins change them", async () => {
    const w = await setup();
    const before = await w.journals();
    const cookie = await sessionCookieFor(owner);
    const viewerCookie = await sessionCookieFor(viewer);
    const createBody = { organisationId: w.org, idempotencyKey: key("http"), name: "Board budget" };
    expect((await budgetsRoute.POST(apiRequest("/api/budgets", { method: "POST", cookie: viewerCookie, body: createBody }), noContext)).status).toBe(403);
    const created = await budgetsRoute.POST(apiRequest("/api/budgets", { method: "POST", cookie, body: createBody }), noContext);
    expect(created.status).toBe(201);
    const { budget } = (await created.json()) as { budget: Budget };
    const context = params({ budgetId: budget.id });
    const listed = await budgetsRoute.GET(apiRequest(`/api/budgets?organisationId=${w.org}`, { cookie: viewerCookie }), noContext);
    expect(((await listed.json()) as { budgets: Budget[] }).budgets.map((b) => b.name)).toEqual(["Overall budget", "Board budget"]);
    expect((await budgetRoute.GET(apiRequest(`/api/budgets/${budget.id}?organisationId=${w.org}&from=2026-04`, { cookie: viewerCookie }), context)).status).toBe(200);
    const amounts = (c: string) =>
      budgetAmountsRoute.PUT(
        apiRequest(`/api/budgets/${budget.id}/amounts`, {
          method: "PUT",
          cookie: c,
          body: { organisationId: w.org, version: 1, amounts: [{ accountCode: "4000", month: "2026-06", amount: "1200.00" }] },
        }),
        context,
      );
    expect((await amounts(viewerCookie)).status).toBe(403);
    expect((await amounts(cookie)).status).toBe(200);
    const fillBody = { organisationId: w.org, version: 2, accountCodes: ["6150"], from: "2026-04", months: 3, method: "same", amount: "500.00" };
    expect((await budgetFillRoute.POST(apiRequest(`/api/budgets/${budget.id}/fill`, { method: "POST", cookie: viewerCookie, body: fillBody }), context)).status).toBe(403);
    expect((await budgetFillRoute.POST(apiRequest(`/api/budgets/${budget.id}/fill`, { method: "POST", cookie, body: fillBody }), context)).status).toBe(200);
    const archiveBody = { organisationId: w.org, archived: true };
    expect((await budgetArchiveRoute.POST(apiRequest(`/api/budgets/${budget.id}/archive`, { method: "POST", cookie: viewerCookie, body: archiveBody }), context)).status).toBe(403);
    const report = await budgetVsActualRoute.GET(
      apiRequest(`/api/reports/budget-vs-actual?organisationId=${w.org}&budgetId=${budget.id}&from=2026-06&to=2026-06`, { cookie: viewerCookie }),
      noContext,
    );
    expect(report.status).toBe(200);
    expect(figures((await report.json()) as BudgetVsActual).Revenue).toEqual(["1300.00", "1200.00", "100.00", "8.3"]);
    expect((await budgetArchiveRoute.POST(apiRequest(`/api/budgets/${budget.id}/archive`, { method: "POST", cookie, body: archiveBody }), context)).status).toBe(200);
    expect(await w.journals()).toBe(before);
  });
});

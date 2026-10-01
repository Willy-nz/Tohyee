import { afterAll, beforeAll, expect, it } from "vitest";
import * as budgetRoute from "@/app/api/budgets/[budgetId]/route";
import * as linesRoute from "@/app/api/payroll/workforce-budgets/[workforceBudgetId]/lines/route";
import * as workforceRoute from "@/app/api/payroll/workforce-budgets/[workforceBudgetId]/route";
import * as vsActualRoute from "@/app/api/payroll/workforce-budgets/[workforceBudgetId]/vs-actual/route";
import * as workforceListRoute from "@/app/api/payroll/workforce-budgets/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBudget, fillBudget, getBudget, listBudgets, setBudgetAmounts, setBudgetArchived } from "@/lib/budgets/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { setPayrollAccess } from "@/lib/payroll/access";
import { addAllocation } from "@/lib/payroll/allocations";
import { createEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import { approvePayRun, createPayRun } from "@/lib/payroll/pay-runs";
import {
  createWorkforceBudget,
  getWorkforceBudget,
  saveWorkforceLines,
  updateFedBudgets,
  updateWorkforceBudget,
  type WorkforceBudget,
  workforceBudgetVsActual,
} from "@/lib/payroll/workforce-budgets";
import { createTrackingCategory, createTrackingValue, getTrackingSetup } from "@/lib/tracking/service";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const ORG = "payroll-workforce-harbour";
const noContext = undefined as never;

/**
 * Workforce budgets, payroll stage P11: examples WB1-WB7 in
 * docs/ACCOUNTING-EXAMPLES.md ("Workforce budgets"). Harbour Cafe Ltd,
 * October 2026 to March 2027.
 */
describeWithDatabase("workforce budgets (WB1-WB7)", () => {
  let server: TestServer;
  let jess: SessionUser; // first owner, payroll access
  let ben: SessionUser; // bookkeeper, payroll access
  let noah: SessionUser; // bookkeeper, no payroll access
  let ana: SessionUser; // admin, no payroll access
  let vic: SessionUser; // viewer
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const v: Record<string, string> = {};
  const people: Record<string, string> = {};
  const budgets: Record<string, string> = {};
  let fortnightly = "";
  let projectId: string | null = null;
  let wb: WorkforceBudget;

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);

  const employee = async (overrides: Record<string, unknown>) =>
    (
      await asUser(jess, (tx) =>
        createEmployee(tx, {
          idempotencyKey: key("employee"),
          taxCode: "M",
          irdNumber: "123456789",
          kiwiSaverStatus: "not_enrolled",
          kiwiSaverEmployeeRate: "3.5",
          kiwiSaverEmployerRate: "3.5",
          studentLoan: false,
          payBasis: "salary",
          startDate: "2026-04-01",
          bankAccount: "03-1234-0123456-00",
          ...overrides,
        }),
      )
    ).employee.id;

  const allocate = (employeeId: string, effectiveFrom: string, lines: unknown[]) =>
    asUser(jess, (tx) => addAllocation(tx, employeeId, { idempotencyKey: key("allocation"), effectiveFrom, lines }));

  /** The amount in a budget for account `code` and month. */
  const cell = async (budgetId: string, code: string, month: string) => {
    const grid = await asUser(jess, (tx) => getBudget(tx, budgetId, { from: "2026-09", months: 8 }));
    const account = grid.accounts.find((row) => row.code === code);
    const index = grid.months.indexOf(month);
    return { amount: account?.amounts[index] ?? "0.00", from: account?.fromWorkforce[index] ?? null };
  };

  const lines = (barista = "2027-01") => [
    { employeeId: people.hemi, rates: [{ fromMonth: "2026-10", rate: "70000.00" }, { fromMonth: "2027-01", rate: "73500.00" }] },
    { employeeId: people.kiri },
    { employeeId: people.sione },
    {
      positionName: "Barista (to be hired)",
      payBasis: "hourly",
      hoursPerWeek: "25",
      kiwiSaverRate: "3.5",
      startMonth: barista,
      endMonth: "2027-03",
      rates: [{ fromMonth: barista, rate: "24.00" }],
      splits: [
        { percentage: "50", departmentId: v.Sales },
        { percentage: "50", departmentId: v.Operations },
      ],
    },
  ];

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    jess = await createTestUser("jess@workforce.test");
    await createTestOrganisation(jess, ORG);
    ben = await createTestUser("ben@workforce.test");
    noah = await createTestUser("noah@workforce.test");
    ana = await createTestUser("ana@workforce.test");
    vic = await createTestUser("vic@workforce.test");
    const members = [
      [ben, "bookkeeper"],
      [noah, "bookkeeper"],
      [ana, "admin"],
      [vic, "viewer"],
    ] as const;
    for (const [user, role] of members) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, user.id, role]);
    }
    const memberList = [
      { userId: jess.id, email: jess.email, displayName: "Jess", role: "owner" as const, isActive: true },
      ...members.map(([user, role]) => ({ userId: user.id, email: user.email, displayName: user.email, role, isActive: true })),
    ];
    await asUser(jess, (tx) => setPayrollAccess(tx, memberList, { userId: ben.id, hasPayrollAccess: true }));
    await asUser(jess, (tx) => updateOrganisationSettings(tx, { advancedFeatures: true, displayName: "Harbour Cafe Ltd" }));
    const department = (await asUser(jess, (tx) => getTrackingSetup(tx))).categories.find((category) => category.kind === "department")!.id;
    for (const name of ["Sales", "Operations"]) {
      const setup = await asUser(jess, (tx) => createTrackingValue(tx, { categoryId: department, name }));
      v[name] = setup.categories.find((category) => category.id === department)!.values.find((value) => value.name === name)!.id;
    }
    const withGrant = await asUser(jess, (tx) => createTrackingCategory(tx, { name: "Grant" }));
    const grantCategory = withGrant.categories.find((category) => category.name === "Grant")!.id;
    const withValue = await asUser(jess, (tx) => createTrackingValue(tx, { categoryId: grantCategory, name: "Lotteries" }));
    v.Lotteries = withValue.categories.find((category) => category.id === grantCategory)!.values.find((value) => value.name === "Lotteries")!.id;

    fortnightly = (await asUser(jess, (tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Fortnightly salaries", payFrequency: "fortnightly" }))).group.id;
    people.hemi = await employee({
      firstName: "Hemi",
      lastName: "Walker",
      payFrequency: "fortnightly",
      annualSalary: "70000.00",
      kiwiSaverStatus: "enrolled",
      esctRate: "30",
      payGroupId: fortnightly,
    });
    people.kiri = await employee({ firstName: "Kiri", lastName: "Tane", irdNumber: "87654321", payFrequency: "fortnightly", annualSalary: "52000.00", payGroupId: fortnightly });
    people.sione = await employee({
      firstName: "Sione",
      lastName: "Fifita",
      payFrequency: "weekly",
      payBasis: "hourly",
      hourlyRate: "22.50",
      ordinaryHoursPerWeek: "32",
      kiwiSaverStatus: "enrolled",
      kiwiSaverEmployeeRate: "4",
      esctRate: "17.5",
    });
    people.old = await employee({ firstName: "Old", lastName: "Hand", payFrequency: "weekly", annualSalary: "40000.00" });
    await allocate(people.hemi, "2026-04-01", [
      { percentage: "60", departmentId: v.Sales },
      { percentage: "40", departmentId: v.Operations },
    ]);
    await allocate(people.kiri, "2026-04-01", [{ percentage: "100", departmentId: v.Sales }]);
    await allocate(people.sione, "2026-04-01", [{ percentage: "100", departmentId: v.Operations, projectId }]);
    await asUser(jess, (tx) => tx.query("update payroll_employees set is_archived = true where id = $1", [people.old]));

    budgets.overall = (await asUser(jess, (tx) => listBudgets(tx)))[0].id;
    budgets.sales = (await asUser(jess, (tx) => createBudget(tx, { idempotencyKey: key("b"), name: "Sales plan", trackingValueId: v.Sales }))).budget.id;
    budgets.operations = (await asUser(jess, (tx) => createBudget(tx, { idempotencyKey: key("b"), name: "Operations plan", trackingValueId: v.Operations }))).budget.id;
    budgets.grant = (await asUser(jess, (tx) => createBudget(tx, { idempotencyKey: key("b"), name: "Lotteries grant", trackingValueId: v.Lotteries }))).budget.id;
    budgets.archived = (await asUser(jess, (tx) => createBudget(tx, { idempotencyKey: key("b"), name: "Old plan" }))).budget.id;
    await asUser(jess, (tx) => setBudgetArchived(tx, budgets.archived, true));
    const overall = await asUser(jess, (tx) => getBudget(tx, budgets.overall));
    await asUser(jess, (tx) => setBudgetAmounts(tx, budgets.overall, { version: overall.budget.version, amounts: [{ accountCode: "6200", month: "2026-10", amount: "10000.00" }] }));
  }, 120_000);

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  it("WB1: lines by employee and position, with each month's wages and KiwiSaver", async () => {
    const created = await asUser(ben, (tx) => createWorkforceBudget(tx, { idempotencyKey: key("wb"), name: "Wages Oct 2026 - Mar 2027", firstMonth: "2026-10", months: 6 }));
    expect(created.created).toBe(true);
    wb = await asUser(ben, (tx) => saveWorkforceLines(tx, created.workforceBudget.id, { version: created.workforceBudget.version, lines: lines() }));
    expect(wb.months).toEqual(["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
    expect(wb.wagesAccount.code).toBe("6200");
    expect(wb.kiwiSaverAccount.code).toBe("6210");
    const [hemi, kiri, sione, barista] = wb.lines;
    expect(hemi).toMatchObject({ employeeName: "Hemi Walker", payBasis: "salary", fte: "1", kiwiSaverRate: "3.5", startMonth: "2026-10", endMonth: null });
    expect(hemi.figures.map((month) => [month.wages, month.kiwiSaver])).toEqual([
      ["5833.33", "204.16"],
      ["5833.33", "204.16"],
      ["5833.33", "204.16"],
      ["6125.00", "214.37"],
      ["6125.00", "214.37"],
      ["6125.00", "214.37"],
    ]);
    // Kiri's pay and KiwiSaver come from her records (decision 116).
    expect(kiri).toMatchObject({ rates: [{ fromMonth: "2026-10", rate: "52000.00" }], kiwiSaverRate: "0" });
    expect(kiri.figures[0]).toEqual({ month: "2026-10", wages: "4333.33", kiwiSaver: "0.00" });
    expect(sione).toMatchObject({ payBasis: "hourly", hoursPerWeek: "32", rates: [{ fromMonth: "2026-10", rate: "22.50" }], kiwiSaverRate: "3.5" });
    expect(sione.figures[0]).toEqual({ month: "2026-10", wages: "3120.00", kiwiSaver: "109.20" });
    expect(barista.figures.map((month) => month.wages)).toEqual(["0.00", "0.00", "0.00", "2600.00", "2600.00", "2600.00"]);
    expect(barista.figures[3].kiwiSaver).toBe("91.00");
    expect(wb.totals.wages).toEqual(["13286.66", "13286.66", "13286.66", "16178.33", "16178.33", "16178.33"]);
    expect(wb.totals.kiwiSaver).toEqual(["313.36", "313.36", "313.36", "414.57", "414.57", "414.57"]);
    expect(wb.totals.total).toBe("90578.76"); // 88,394.97 + 2,183.79
    const journals = await asUser(jess, (tx) => tx.query<{ count: string }>("select count(*)::text as count from ledger_journals"));
    expect(journals.rows[0].count).toBe("0");
  });

  it("WB2: split by Department and fed into the budgets; fed amounts can't be typed", async () => {
    wb = await asUser(ben, (tx) => updateWorkforceBudget(tx, wb.id, { version: wb.version, budgetIds: [budgets.overall, budgets.sales, budgets.operations] }));
    expect(wb.targets.map((target) => [target.name, target.upToDate])).toEqual([
      ["Overall budget", true],
      ["Operations plan", true],
      ["Sales plan", true],
    ]);
    expect(wb.departments.map((row) => [row.label, row.wages[0], row.kiwiSaver[0], row.wages[3], row.kiwiSaver[3]])).toEqual([
      ["Operations", "5453.33", "190.86", "6870.00", "240.45"],
      ["Sales", "7833.33", "122.50", "9308.33", "174.12"],
    ]);
    const expected: Array<[string, string, string, string]> = [
      [budgets.sales, "6200", "2026-10", "7833.33"],
      [budgets.sales, "6210", "2026-10", "122.50"],
      [budgets.sales, "6200", "2027-01", "9308.33"],
      [budgets.sales, "6210", "2027-03", "174.12"],
      [budgets.operations, "6200", "2026-12", "5453.33"],
      [budgets.operations, "6210", "2026-10", "190.86"],
      [budgets.operations, "6200", "2027-01", "6870.00"],
      [budgets.operations, "6210", "2027-01", "240.45"],
      [budgets.overall, "6200", "2026-10", "13286.66"],
      [budgets.overall, "6210", "2026-11", "313.36"],
      [budgets.overall, "6200", "2027-02", "16178.33"],
      [budgets.overall, "6210", "2027-01", "414.57"],
    ];
    for (const [budgetId, code, month, amount] of expected) {
      expect(await cell(budgetId, code, month), `${code} ${month}`).toEqual({ amount, from: "Wages Oct 2026 - Mar 2027" });
    }
    const history = await asUser(jess, (tx) =>
      tx.query<{ details: { how: string; changes: Array<{ account: string; month: string; from: string; to: string }> } }>(
        "select details from audit_events where event_type = 'budget.amounts_changed' and entity_id = $1 order by id desc limit 1",
        [budgets.overall],
      ),
    );
    expect(history.rows[0].details.how).toBe("workforce budget Wages Oct 2026 - Mar 2027");
    expect(history.rows[0].details.changes).toContainEqual({ account: "6200", month: "2026-10", from: "10000.00", to: "13286.66" });

    const sales = await asUser(jess, (tx) => getBudget(tx, budgets.sales));
    await expect(
      asUser(jess, (tx) => setBudgetAmounts(tx, budgets.sales, { version: sales.budget.version, amounts: [{ accountCode: "6200", month: "2026-10", amount: "8000.00" }] })),
    ).rejects.toThrow("comes from the workforce budget Wages Oct 2026 - Mar 2027");
    await expect(
      asUser(jess, (tx) => fillBudget(tx, budgets.sales, { version: sales.budget.version, accountCodes: ["6210"], from: "2026-10", months: 12, method: "same", amount: "100.00" })),
    ).rejects.toThrow("comes from the workforce budget");
    // The database refuses too.
    await expect(
      asUser(jess, (tx) => tx.query("update budget_amounts set amount = 1 where budget_id = $1 and workforce_budget_id is not null", [budgets.sales])),
    ).rejects.toThrow("comes from a workforce budget");
    await expect(
      asUser(jess, (tx) =>
        tx.query(
          "insert into budget_amounts (budget_id, account_id, month, amount, workforce_budget_id) select $1, id, '2026-10-01', 1, $2 from accounts where code = '6150'",
          [budgets.overall, wb.id],
        ),
      ),
    ).rejects.toThrow("Only the workforce budget itself");
    // Outside its months and accounts, typing still works.
    const saved = await asUser(jess, (tx) =>
      setBudgetAmounts(tx, budgets.sales, {
        version: sales.budget.version,
        amounts: [
          { accountCode: "6200", month: "2026-09", amount: "7000.00" },
          { accountCode: "6200", month: "2027-04", amount: "9000.00" },
          { accountCode: "6150", month: "2026-10", amount: "500.00" },
        ],
      }),
    );
    expect(saved.changed).toBe(3);
  });

  it("WB3: saving rewrites the fed amounts; an allocation change shows out of date until Update budgets", async () => {
    wb = await asUser(ben, (tx) => saveWorkforceLines(tx, wb.id, { version: wb.version, lines: lines("2027-02") }));
    expect(await cell(budgets.overall, "6200", "2027-01")).toMatchObject({ amount: "13578.33" });
    expect(await cell(budgets.overall, "6210", "2027-01")).toMatchObject({ amount: "323.57" });
    expect(await cell(budgets.sales, "6200", "2027-01")).toMatchObject({ amount: "8008.33" });
    expect(await cell(budgets.sales, "6210", "2027-01")).toMatchObject({ amount: "128.62" });
    expect(await cell(budgets.operations, "6200", "2027-01")).toMatchObject({ amount: "5570.00" });
    expect(await cell(budgets.operations, "6210", "2027-01")).toMatchObject({ amount: "194.95" });
    expect(await cell(budgets.overall, "6200", "2027-02")).toMatchObject({ amount: "16178.33" });

    await allocate(people.kiri, "2027-02-01", [{ percentage: "100", departmentId: v.Operations }]);
    wb = await asUser(ben, (tx) => getWorkforceBudget(tx, wb.id));
    expect(wb.targets.map((target) => [target.name, target.upToDate])).toEqual([
      ["Overall budget", true],
      ["Operations plan", false],
      ["Sales plan", false],
    ]);
    expect(await cell(budgets.sales, "6200", "2027-02")).toMatchObject({ amount: "9308.33" });
    const updated = await asUser(ben, (tx) => updateFedBudgets(tx, wb.id));
    expect(updated.changed).toBe(4);
    expect(await cell(budgets.sales, "6200", "2027-02")).toMatchObject({ amount: "4975.00" });
    expect(await cell(budgets.operations, "6200", "2027-02")).toMatchObject({ amount: "11203.33" });
    expect(await cell(budgets.overall, "6200", "2027-02")).toMatchObject({ amount: "16178.33" });
    expect(updated.workforceBudget.targets.every((target) => target.upToDate)).toBe(true);
    wb = updated.workforceBudget;
  });

  it("WB4: taking a budget off releases its amounts; refused budgets", async () => {
    await expect(asUser(ben, (tx) => updateWorkforceBudget(tx, wb.id, { version: wb.version, budgetIds: [budgets.overall, budgets.sales, budgets.operations, budgets.archived] }))).rejects.toThrow(
      "Old plan is archived",
    );
    await expect(asUser(ben, (tx) => updateWorkforceBudget(tx, wb.id, { version: wb.version, budgetIds: [budgets.overall, budgets.sales, budgets.operations, budgets.grant] }))).rejects.toThrow(
      "Payroll is split by Department, Class and Location only",
    );
    const other = await asUser(ben, (tx) => createWorkforceBudget(tx, { idempotencyKey: key("wb"), name: "Stretch plan", firstMonth: "2026-10", months: 6 }));
    await expect(asUser(ben, (tx) => updateWorkforceBudget(tx, other.workforceBudget.id, { version: other.workforceBudget.version, budgetIds: [budgets.sales] }))).rejects.toThrow(
      "already fed by the workforce budget Wages Oct 2026 - Mar 2027",
    );
    wb = await asUser(ben, (tx) => updateWorkforceBudget(tx, wb.id, { version: wb.version, budgetIds: [budgets.overall, budgets.sales] }));
    expect(wb.targets.map((target) => target.name)).toEqual(["Overall budget", "Sales plan"]);
    expect(await cell(budgets.operations, "6200", "2026-10")).toEqual({ amount: "5453.33", from: null });
    const operations = await asUser(jess, (tx) => getBudget(tx, budgets.operations));
    const saved = await asUser(jess, (tx) =>
      setBudgetAmounts(tx, budgets.operations, { version: operations.budget.version, amounts: [{ accountCode: "6200", month: "2026-10", amount: "5500.00" }] }),
    );
    expect(saved.changed).toBe(1);
    expect(await cell(budgets.sales, "6200", "2026-10")).toEqual({ amount: "7833.33", from: "Wages Oct 2026 - Mar 2027" });
  });

  it("WB5: budget vs actual for wages against labour cost by Department", async () => {
    const draft = (await asUser(ben, (tx) => createPayRun(tx, { idempotencyKey: key("payrun"), payGroupId: fortnightly, periodStart: "2026-09-28", payDate: "2026-10-14" }))).payRun;
    await asUser(ben, (tx) => approvePayRun(tx, draft.id, { idempotencyKey: key("approve") }));
    const result = await asUser(ben, (tx) => workforceBudgetVsActual(tx, wb.id));
    expect(result.months[0]).toEqual({
      month: "2026-10",
      rows: [
        { departmentId: v.Operations, label: "Operations", budget: "5644.19", actual: "1114.61", variance: "-4529.58" },
        { departmentId: v.Sales, label: "Sales", budget: "7955.83", actual: "3671.93", variance: "-4283.90" },
      ],
      total: { budget: "13600.02", actual: "4786.54", variance: "-8813.48" },
    });
    expect(result.months[1].rows.map((row) => [row.label, row.budget, row.actual])).toEqual([
      ["Operations", "5644.19", "0.00"],
      ["Sales", "7955.83", "0.00"],
    ]);
    const response = await vsActualRoute.GET(
      apiRequest(`/api/payroll/workforce-budgets/${wb.id}/vs-actual?organisationId=${ORG}`, { cookie: await sessionCookieFor(ben) }),
      { params: Promise.resolve({ workforceBudgetId: wb.id }) },
    );
    expect(response.status).toBe(200);
  });

  it("WB6: payroll access for workforce budgets; fed amounts are ordinary budgets", async () => {
    const params = { params: Promise.resolve({ workforceBudgetId: wb.id }) };
    for (const user of [noah, ana]) {
      const list = await workforceListRoute.GET(apiRequest(`/api/payroll/workforce-budgets?organisationId=${ORG}`, { cookie: await sessionCookieFor(user) }), noContext);
      expect(list.status).toBe(403);
      const one = await workforceRoute.GET(apiRequest(`/api/payroll/workforce-budgets/${wb.id}?organisationId=${ORG}`, { cookie: await sessionCookieFor(user) }), params);
      expect(one.status).toBe(403);
      const save = await linesRoute.PUT(
        apiRequest(`/api/payroll/workforce-budgets/${wb.id}/lines`, { method: "PUT", cookie: await sessionCookieFor(user), body: { organisationId: ORG, version: wb.version, lines: [] } }),
        params,
      );
      expect(save.status).toBe(403);
    }
    const list = await workforceListRoute.GET(apiRequest(`/api/payroll/workforce-budgets?organisationId=${ORG}`, { cookie: await sessionCookieFor(ben) }), noContext);
    expect(list.status).toBe(200);
    for (const user of [noah, vic]) {
      const response = await budgetRoute.GET(
        apiRequest(`/api/budgets/${budgets.sales}?organisationId=${ORG}&from=2026-10&months=1`, { cookie: await sessionCookieFor(user) }),
        { params: Promise.resolve({ budgetId: budgets.sales }) },
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("7833.33");
      expect(text).toContain("Wages Oct 2026 - Mar 2027");
      expect(text).not.toContain("Hemi");
      expect(text).not.toContain("Barista");
    }
    const events = await asUser(jess, (tx) =>
      tx.query<{ details: Record<string, unknown> }>("select details from audit_events where event_type like 'payroll_workforce_budget.%'"),
    );
    expect(events.rows.length).toBeGreaterThan(3);
    const text = JSON.stringify(events.rows);
    for (const forbidden of ["Hemi", "Kiri", "Barista", "5833", "70000", "13286"]) expect(text).not.toContain(forbidden);
  });

  it("WB7: refused, with nothing saved", async () => {
    const before = await asUser(ben, (tx) => getWorkforceBudget(tx, wb.id));
    const refuse = (badLines: unknown[], message: string) =>
      expect(asUser(ben, (tx) => saveWorkforceLines(tx, wb.id, { version: before.version, lines: badLines }))).rejects.toThrow(message);
    const position = { positionName: "Cook", payBasis: "salary", rates: [{ rate: "60000.00" }], splits: [{ percentage: "100", departmentId: v.Sales }] };
    await refuse([{ ...position, startMonth: "2026-12", endMonth: "2026-11" }], "must end on or after its start month");
    await refuse([{ ...position, startMonth: "2026-09" }], "starts outside the workforce budget's months");
    await refuse([{ ...position, endMonth: "2027-04" }], "must end on or after its start month and by 2027-03");
    await refuse([{ ...position, rates: [{ rate: "60000.00" }, { fromMonth: "2027-05", rate: "65000.00" }] }], "after the line ends");
    await refuse([{ ...position, rates: [{ fromMonth: "2026-11", rate: "60000.00" }] }], "first pay must be from its start month");
    await refuse([{ ...position, fte: "0" }], "must not be zero");
    await refuse([{ ...position, fte: "1.5" }], "FTE can be at most 1");
    await refuse([{ ...position, payBasis: "hourly", rates: [{ rate: "25" }] }], "needs hours a week");
    await refuse([{ ...position, kiwiSaverRate: "101" }], "KiwiSaver rate can be at most 100%");
    await refuse([{ ...position, splits: [{ percentage: "60", departmentId: v.Sales }] }], "must total exactly 100.00%");
    await refuse([{ employeeId: people.kiri }, { employeeId: people.kiri }], "An employee can only have one line");
    await refuse([{ employeeId: people.old }], "the employee is archived");
    await expect(asUser(ben, (tx) => saveWorkforceLines(tx, wb.id, { version: before.version - 1, lines: [] }))).rejects.toThrow("Someone else has changed");
    await expect(asUser(ben, (tx) => createWorkforceBudget(tx, { idempotencyKey: key("wb"), name: "Too long", firstMonth: "2026-10", months: 25 }))).rejects.toThrow(
      "1 to 24 months",
    );
    const after = await asUser(ben, (tx) => getWorkforceBudget(tx, wb.id));
    expect(after.version).toBe(before.version);
    expect(after.lines).toHaveLength(4);
    expect(await cell(budgets.sales, "6200", "2026-10")).toMatchObject({ amount: "7833.33" });
  });
});

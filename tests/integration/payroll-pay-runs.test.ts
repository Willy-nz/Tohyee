import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as accessRoute from "@/app/api/payroll/access/route";
import * as payItemRoute from "@/app/api/payroll/pay-items/[payItemId]/route";
import * as payItemsRoute from "@/app/api/payroll/pay-items/route";
import * as approveRoute from "@/app/api/payroll/pay-runs/[payRunId]/approve/route";
import * as payRunEmployeeRoute from "@/app/api/payroll/pay-runs/[payRunId]/employees/[employeeId]/route";
import * as postingsRoute from "@/app/api/payroll/pay-runs/[payRunId]/postings/route";
import * as payRunRoute from "@/app/api/payroll/pay-runs/[payRunId]/route";
import * as voidRoute from "@/app/api/payroll/pay-runs/[payRunId]/void/route";
import * as payRunsRoute from "@/app/api/payroll/pay-runs/route";
import * as settingsRoute from "@/app/api/payroll/settings/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import { coreQuery } from "@/lib/db/transactions";
import { correctJournal, getJournal, type JournalWithLines } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { addAllocation } from "@/lib/payroll/allocations";
import { createEmployee, updateEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import { addPayRate } from "@/lib/payroll/pay-rates";
import type { PayItem } from "@/lib/payroll/pay-items";
import { createPayRun, getPayRun, type PayRun } from "@/lib/payroll/pay-runs";
import { createProject } from "@/lib/projects/service";
import { createTrackingValue, getTrackingSetup } from "@/lib/tracking/service";
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
  testDatabaseUrl,
  type TestServer,
  withDb,
} from "../helpers/test-server";

const ORG = "payroll-pay-runs-co";
const noContext = undefined as unknown;
const NOT_SUPPORTED = "Not supported yet (refused rather than guessed)";

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Examples PRUN1-PRUN11 in docs/ACCOUNTING-EXAMPLES.md ("NZ payroll — pay
 * runs (examples not yet approved by Jess)"). The tests run in order: the
 * first pay run is PAYRUN-1.
 */
describeWithDatabase("payroll pay items and pay runs (PRUN1-PRUN11)", () => {
  let server: TestServer;
  let jess: SessionUser; // first owner, payroll access
  let mere: SessionUser; // admin, payroll access
  let ben: SessionUser; // bookkeeper, payroll access
  let noah: SessionUser; // bookkeeper, no payroll access
  let vic: SessionUser; // viewer
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const v: Record<string, string> = {};
  let department = "";
  let projectId = "";
  const groups: Record<string, string> = {};
  const people: Record<string, string> = {};
  let items: Record<string, PayItem> = {};

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) =>
    inOrganisation(ORG, { userId: user.id, email: user.email }, work);

  const call = async (
    handler: (request: Request, context: never) => Promise<Response>,
    user: SessionUser,
    path: string,
    options: { method?: string; body?: Record<string, unknown>; context?: unknown } = {},
  ) => {
    const method = options.method ?? "GET";
    const url = method === "GET" || method === "DELETE" ? `${path}${path.includes("?") ? "&" : "?"}organisationId=${ORG}` : path;
    const response = await handler(
      apiRequest(url, {
        method,
        cookie: await sessionCookieFor(user),
        body: options.body === undefined ? undefined : { organisationId: ORG, ...options.body },
      }),
      (options.context ?? noContext) as never,
    );
    return { status: response.status, body: await body(response) };
  };

  const giveAccess = async (to: SessionUser) => {
    const response = await accessRoute.PUT(
      apiRequest("/api/payroll/access", {
        method: "PUT",
        cookie: await sessionCookieFor(jess),
        body: { organisationId: ORG, userId: to.id, hasPayrollAccess: true },
      }),
      noContext,
    );
    expect(response.status).toBe(200);
  };

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

  const allocate = (employeeId: string, lines: unknown[], effectiveFrom = "2026-04-01") =>
    asUser(jess, (tx) => addAllocation(tx, employeeId, { idempotencyKey: key("allocation"), effectiveFrom, lines }));

  const group = async (name: string, payFrequency: string) =>
    (await asUser(jess, (tx) => createPayGroup(tx, { idempotencyKey: key("group"), name, payFrequency }))).group.id;

  const createRun = (user: SessionUser, input: Record<string, unknown>) =>
    call(payRunsRoute.POST, user, "/api/payroll/pay-runs", { method: "POST", body: { idempotencyKey: key("payrun"), ...input } });

  const approve = (user: SessionUser, payRunId: string) =>
    call(approveRoute.POST, user, `/api/payroll/pay-runs/${payRunId}/approve`, {
      method: "POST",
      body: { idempotencyKey: key("approve") },
      context: params({ payRunId }),
    });

  const setLines = (user: SessionUser, payRunId: string, employeeId: string, lines: unknown[]) =>
    call(payRunEmployeeRoute.PUT, user, `/api/payroll/pay-runs/${payRunId}/employees/${employeeId}`, {
      method: "PUT",
      body: { lines },
      context: params({ payRunId, employeeId }),
    });

  const journal = (id: string) => asUser(jess, (tx) => getJournal(tx, id));

  const lineSummary = (posted: JournalWithLines) =>
    posted.lines.map((line) => [line.accountCode, line.description, line.debitAmount, line.creditAmount, line.tracking[department] ?? null]);

  const pay = (run: PayRun, employeeId: string) => run.employees.find((entry) => entry.employeeId === employeeId)!;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    jess = await createTestUser("jess@payruns.test");
    await createTestOrganisation(jess, ORG);
    mere = await createTestUser("mere@payruns.test");
    ben = await createTestUser("ben@payruns.test");
    noah = await createTestUser("noah@payruns.test");
    vic = await createTestUser("vic@payruns.test");
    for (const [user, role] of [
      [mere, "admin"],
      [ben, "bookkeeper"],
      [noah, "bookkeeper"],
      [vic, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, user.id, role]);
    }
    await giveAccess(mere);
    await giveAccess(ben);
    await asUser(jess, (tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const categories = (await asUser(jess, (tx) => getTrackingSetup(tx))).categories;
    department = categories.find((c) => c.kind === "department")!.id;
    for (const name of ["Sales", "Operations"]) {
      const setup = await asUser(jess, (tx) => createTrackingValue(tx, { categoryId: department, name }));
      v[name] = setup.categories.find((c) => c.id === department)!.values.find((value) => value.name === name)!.id;
    }
    const contact = (await asUser(jess, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Cafe", isCustomer: true }))).contact;
    projectId = (await asUser(jess, (tx) => createProject(tx, { idempotencyKey: key("p"), name: "Cafe rebrand", contactId: contact.id }))).project.id;

    groups.fortnightly = await group("Fortnightly salaries", "fortnightly");
    groups.weekly = await group("Weekly wages", "weekly");
    groups.fourWeekly = await group("Four-weekly", "four_weekly");
    people.hemi = await employee({
      firstName: "Hemi",
      lastName: "Walker",
      payFrequency: "fortnightly",
      annualSalary: "70000.00",
      kiwiSaverStatus: "enrolled",
      esctRate: "30",
      payGroupId: groups.fortnightly,
    });
    people.kiri = await employee({ firstName: "Kiri", lastName: "Tane", payFrequency: "fortnightly", annualSalary: "52000.00", payGroupId: groups.fortnightly });
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
      payGroupId: groups.weekly,
    });
    people.aroha = await employee({
      firstName: "Aroha",
      lastName: "Ngata",
      taxCode: "M SL",
      studentLoan: true,
      payFrequency: "four_weekly",
      annualSalary: "45500.00",
      kiwiSaverStatus: "enrolled",
      esctRate: "17.5",
      payGroupId: groups.fourWeekly,
    });
    await allocate(people.hemi, [
      { percentage: "60", departmentId: v.Sales },
      { percentage: "40", departmentId: v.Operations },
    ]);
    await allocate(people.kiri, [{ percentage: "100", departmentId: v.Sales }]);
    await allocate(people.sione, [{ percentage: "100", departmentId: v.Operations, projectId }]);
    await allocate(people.aroha, [{ percentage: "100", departmentId: v.Sales }]);
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  describe("pay items (PRUN10)", () => {
    it("starts every organisation with the default pay items, mapped to the starting chart", async () => {
      const { status, body: listed } = await call(payItemsRoute.GET, ben, "/api/payroll/pay-items");
      expect(status).toBe(200);
      const payItems = listed.payItems as PayItem[];
      expect(payItems.map((item) => [item.name, item.category, item.kind, item.accountCode, item.subjectToPaye, item.subjectToKiwiSaver, item.subjectToEsct])).toEqual([
        ["Ordinary time", "earnings", "ordinary_time", "6200", true, true, false],
        ["Overtime", "earnings", "overtime", "6200", true, true, false],
        ["Allowance (taxable)", "earnings", "allowance", "6200", true, true, false],
        ["Holiday pay", "earnings", "holiday_pay", "6200", true, true, false],
        // The leave pay items Tohyee works out (P8, decision 138).
        ["Annual leave", "earnings", "annual_leave", "6200", true, true, false],
        ["Sick leave", "earnings", "sick_leave", "6200", true, true, false],
        ["Bereavement leave", "earnings", "bereavement_leave", "6200", true, true, false],
        ["Special leave", "earnings", "family_violence_leave", "6200", true, true, false],
        ["Public holiday", "earnings", "public_holiday", "6200", true, true, false],
        ["Public holiday worked", "earnings", "public_holiday_worked", "6200", true, true, false],
        ["Alternative holiday", "earnings", "alternative_holiday", "6200", true, true, false],
        ["Annual leave cashed up", "earnings", "annual_leave_cash_up", "6200", true, true, false],
        ["Alternative holiday paid out", "earnings", "alternative_holiday_payout", "6200", true, true, false],
        ["Holiday pay owed on finishing", "earnings", "termination_holiday_pay", "6200", true, true, false],
        ["Reimbursement", "earnings", "reimbursement", "6070", false, false, false],
        ["Union fees", "deduction", "after_tax_deduction", "2250", false, false, false],
        ["KiwiSaver employer contribution", "employer_contribution", "kiwisaver_employer", "6210", false, false, true],
      ]);
      expect(payItems.find((item) => item.kind === "overtime")!.rateMultiplier).toBe("1.5");
      expect(payItems.every((item) => item.subjectToAccLevy === item.subjectToPaye && item.subjectToStudentLoan === item.subjectToPaye)).toBe(true);
      items = Object.fromEntries(payItems.map((item) => [item.name, item]));

      const accounts = await asUser(jess, (tx) =>
        tx.query<{ code: string; name: string; system_key: string }>(
          "select code, name, system_key from accounts where system_key like '%payable' and code between '2200' and '2299' order by code",
        ),
      );
      expect(accounts.rows).toEqual([
        { code: "2200", name: "PAYE payable", system_key: "paye_payable" },
        { code: "2210", name: "KiwiSaver payable", system_key: "kiwisaver_payable" },
        { code: "2220", name: "ESCT payable", system_key: "esct_payable" },
        { code: "2230", name: "Student loan payable", system_key: "student_loan_payable" },
        { code: "2240", name: "Wages payable", system_key: "wages_payable" },
        { code: "2250", name: "Payroll deductions payable", system_key: "payroll_deductions_payable" },
      ]);
    });

    it("applies tenant migration 0058 last", () => {
      expect(tenantMigrations.filter((entry) => entry.version === "0058")).toHaveLength(1);
    });

    it("migration 0058 gives an existing organisation the payroll accounts, at the next free code, and the pay items", async () => {
      const databaseName = `${server.coreDatabase}_org_upgrade_payroll`;
      const admin = new pg.Client({ connectionString: testDatabaseUrl! });
      await admin.connect();
      await admin.query(`create database "${databaseName}"`);
      await admin.end();
      const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, databaseName) });
      await client.connect();
      try {
        await applyMigrations(client, tenantMigrations.filter((migration) => migration.version < "0058"), "test:upgrade");
        await client.query("insert into organisation_settings (organisation_id, display_name, base_currency) values ('payroll-co', 'Payroll Co', 'NZD')");
        await client.query(
          `insert into accounts (code, name, account_class, account_type) values
             ('2200', 'PAYE payable', 'liability', 'current_liability'),
             ('2210', 'Loan from shareholder', 'liability', 'current_liability'),
             ('6200', 'Wages and salaries', 'expense', 'expense'),
             ('6210', 'KiwiSaver employer contributions', 'expense', 'expense'),
             ('6070', 'General expenses', 'expense', 'expense')`,
        );
        expect((await applyMigrations(client, tenantMigrations, "test:upgrade")).applied).toContain("0058");
        expect((await client.query("select code, name, system_key from accounts where code like '22%' order by code")).rows).toEqual([
          { code: "2200", name: "PAYE payable", system_key: "paye_payable" },
          { code: "2210", name: "Loan from shareholder", system_key: null },
          { code: "2211", name: "KiwiSaver payable", system_key: "kiwisaver_payable" },
          { code: "2220", name: "ESCT payable", system_key: "esct_payable" },
          { code: "2230", name: "Student loan payable", system_key: "student_loan_payable" },
          { code: "2240", name: "Wages payable", system_key: "wages_payable" },
          { code: "2250", name: "Payroll deductions payable", system_key: "payroll_deductions_payable" },
        ]);
        const seeded = await client.query<{ name: string; code: string | null }>(
          "select p.name, a.code from payroll_pay_items p left join accounts a on a.id = p.account_id order by p.name",
        );
        // The 7 starting items (0058) and the 10 leave items (0070, decision 138).
        expect(seeded.rows).toHaveLength(17);
        expect(seeded.rows.find((row) => row.name === "Ordinary time")!.code).toBe("6200");
        expect(seeded.rows.find((row) => row.name === "Annual leave")!.code).toBe("6200");
        expect(seeded.rows.find((row) => row.name === "Union fees")!.code).toBe("2250");
        expect((await client.query("select payroll_approver_must_differ from organisation_settings")).rows).toEqual([{ payroll_approver_must_differ: false }]);
      } finally {
        await client.end();
      }
    });

    it("admins add allowances; bookkeepers can read but not add; names are unique", async () => {
      const add = (user: SessionUser, input: Record<string, unknown>) =>
        call(payItemsRoute.POST, user, "/api/payroll/pay-items", { method: "POST", body: { idempotencyKey: key("item"), ...input } });
      const tool = await add(mere, { name: "Tool allowance", kind: "allowance", accountCode: "6200", taxable: true, countsForKiwiSaver: true });
      expect(tool.status).toBe(201);
      expect(tool.body.payItem).toMatchObject({ name: "Tool allowance", subjectToPaye: true, subjectToKiwiSaver: true, accountCode: "6200" });
      const meal = await add(mere, { name: "Meal allowance (non-taxable)", kind: "allowance", accountCode: "6200", taxable: false });
      expect(meal.body.payItem).toMatchObject({ subjectToPaye: false, subjectToAccLevy: false, subjectToStudentLoan: false, subjectToKiwiSaver: false });
      expect((await add(mere, { name: "Odd", kind: "allowance", accountCode: "6200", taxable: false, countsForKiwiSaver: true })).body.error).toBe("An allowance that isn't taxable doesn't count for KiwiSaver either (spec 4.5.1).");
      const byBen = await add(ben, { name: "Ben's allowance", kind: "allowance", accountCode: "6200" });
      expect(byBen.status).toBe(403);
      expect((await add(mere, { name: "tool ALLOWANCE", kind: "allowance", accountCode: "6200" })).status).toBe(409);
      expect((await add(mere, { name: "Union dues", kind: "after_tax_deduction", accountCode: "6200" })).body.error).toContain("isn't a liability account");
      expect((await add(mere, { name: "Bad wages", kind: "overtime", accountCode: "2250" })).body.error).toContain("isn't an expense account");
      const listed = (await call(payItemsRoute.GET, ben, "/api/payroll/pay-items")).body.payItems as PayItem[];
      items = Object.fromEntries(listed.map((item) => [item.name, item]));
      expect(items["Tool allowance"]).toBeDefined();
    });

    it("system items can only be renamed or re-pointed; others can be archived", async () => {
      const patch = (id: string, input: Record<string, unknown>, user = mere) =>
        call(payItemRoute.PATCH, user, `/api/payroll/pay-items/${id}`, { method: "PATCH", body: input, context: params({ payItemId: id }) });
      expect((await patch(items["Ordinary time"].id, { isArchived: true })).body.error).toBe("Ordinary time is needed for every pay run, so it can't be archived.");
      expect((await patch(items["Ordinary time"].id, { taxable: false })).status).toBe(400);
      expect((await patch(items["Holiday pay"].id, { name: "Holiday pay" }, ben)).status).toBe(403);
      const archived = await patch(items["Meal allowance (non-taxable)"].id, { isArchived: true });
      expect(archived.body.payItem).toMatchObject({ isArchived: true });
      const listed = (await call(payItemsRoute.GET, ben, "/api/payroll/pay-items")).body.payItems as PayItem[];
      expect(listed.some((item) => item.name === "Meal allowance (non-taxable)")).toBe(false);
    });
  });

  describe("PRUN11 and PRUN1: a fortnightly salaried pay run split 60/40", () => {
    let runId = "";

    it("PRUN11: a draft gets Ordinary time per employee from their pay rate", async () => {
      const created = await createRun(ben, { payGroupId: groups.fortnightly, periodStart: "2026-09-28", payDate: "2026-10-14" });
      expect(created.status).toBe(201);
      const run = created.body.payRun as PayRun;
      runId = run.id;
      expect(run).toMatchObject({
        reference: "PAYRUN-1",
        status: "draft",
        periodStart: "2026-09-28",
        periodEnd: "2026-10-11",
        payDate: "2026-10-14",
        payGroupName: "Fortnightly salaries",
        employeeCount: 2,
        preparedByMe: true,
        problemCount: 0,
      });
      expect(run.employees.map((entry) => entry.name)).toEqual(["Kiri Tane", "Hemi Walker"]);
      expect(pay(run, people.hemi).lines).toEqual([
        expect.objectContaining({ lineNumber: 1, payItemName: "Ordinary time", quantity: null, rate: null, amount: "2692.31" }),
      ]);
      expect(pay(run, people.kiri).lines[0].amount).toBe("2000.00");

      const again = await createRun(jess, { payGroupId: groups.fortnightly, periodStart: "2026-09-28", payDate: "2026-10-14" });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe(
        "PAYRUN-1 already pays Fortnightly salaries for 2026-09-28 to 2026-10-11. Void it first to run that pay again.",
      );
    });

    it("PRUN1: shows each employee's pay and the totals", async () => {
      const { body: got } = await call(payRunRoute.GET, ben, `/api/payroll/pay-runs/${runId}`, { context: params({ payRunId: runId }) });
      const run = got.payRun as PayRun;
      expect(pay(run, people.hemi).pay).toEqual({
        gross: "2692.31",
        taxableEarnings: "2692.31",
        nonTaxableEarnings: "0.00",
        kiwiSaverEarnings: "2692.31",
        paye: "555.58",
        studentLoan: "0.00",
        kiwiSaverEmployee: "94.23",
        deductions: "0.00",
        netPay: "2042.50",
        kiwiSaverEmployer: "94.23",
        esct: "28.20",
        kiwiSaverEmployerNet: "66.03",
        employerCost: "2786.54",
        extraPay: "0.00",
        extraPayTax: "0.00",
        extraPayTaxRate: null,
        lumpSumLowestRate: false,
      });
      expect(pay(run, people.kiri).pay).toMatchObject({ paye: "343.00", netPay: "1657.00", employerCost: "2000.00" });
      expect(run.totals).toEqual({
        gross: "4692.31",
        paye: "898.58",
        studentLoan: "0.00",
        kiwiSaverEmployee: "94.23",
        deductions: "0.00",
        netPay: "3699.50",
        kiwiSaverEmployer: "94.23",
        esct: "28.20",
        employerCost: "4786.54",
      });
    });

    it("PRUN1: approving posts one journal split by allocation, with no employee names", async () => {
      const approved = await approve(ben, runId);
      expect(approved.status).toBe(201);
      const run = approved.body.payRun as PayRun;
      expect(run.status).toBe("approved");
      const posted = await journal(run.approvalJournalId!);
      expect(posted).toMatchObject({
        origin: "payroll",
        postingDate: "2026-10-14",
        reference: "PAYRUN-1",
        description: "Pay run PAYRUN-1: Fortnightly salaries, 2026-09-28 to 2026-10-11",
        totalDebit: "4786.54",
      });
      expect(lineSummary(posted)).toEqual([
        ["6200", "Ordinary time", "3615.39", "0.00", v.Sales],
        ["6200", "Ordinary time", "1076.92", "0.00", v.Operations],
        ["6210", "KiwiSaver employer contribution", "56.54", "0.00", v.Sales],
        ["6210", "KiwiSaver employer contribution", "37.69", "0.00", v.Operations],
        ["2200", "PAYE", "0.00", "898.58", null],
        ["2210", "KiwiSaver", "0.00", "160.26", null],
        ["2220", "ESCT", "0.00", "28.20", null],
        ["2240", "Net pay", "0.00", "3699.50", null],
      ]);
      const text = JSON.stringify(posted);
      for (const name of ["Hemi", "Walker", "Kiri", "Tane"]) expect(text).not.toContain(name);

      const postings = (await call(postingsRoute.GET, ben, `/api/payroll/pay-runs/${runId}/postings`, { context: params({ payRunId: runId }) })).body
        .postings as Array<Record<string, unknown>>;
      expect(postings.map((p) => [p.employeeName, p.payItemName, p.percentage, p.amount, p.journalLineOrder])).toEqual([
        ["Kiri Tane", "Ordinary time", "100.00", "2000.00", 1],
        ["Hemi Walker", "Ordinary time", "60.00", "1615.39", 1],
        ["Hemi Walker", "Ordinary time", "40.00", "1076.92", 2],
        ["Hemi Walker", "KiwiSaver employer contribution", "60.00", "56.54", 3],
        ["Hemi Walker", "KiwiSaver employer contribution", "40.00", "37.69", 4],
      ]);

      // The copy kept on approval doesn't follow later changes to the employee.
      await asUser(jess, (tx) => updateEmployee(tx, people.kiri, { taxCode: "S" }));
      const after = await asUser(ben, (tx) => getPayRun(tx, runId));
      expect(pay(after, people.kiri)).toMatchObject({ taxCode: "M", pay: { paye: "343.00" } });
      await asUser(jess, (tx) => updateEmployee(tx, people.kiri, { taxCode: "M" }));

      const audit = await asUser(jess, (tx) =>
        tx.query<{ event_type: string; details: unknown }>(
          "select event_type, details from audit_events where entity_id = $1 or (entity_type = 'ledger_journal' and entity_id = $2) order by id",
          [runId, run.approvalJournalId],
        ),
      );
      expect(audit.rows.map((row) => row.event_type)).toEqual(["payroll_pay_run.created", "ledger.journal_posted", "payroll_pay_run.approved"]);
      const details = JSON.stringify(audit.rows.map((row) => row.details));
      for (const amount of ["4786.54", "2692.31", "898.58", "3699.50", "2000"]) expect(details).not.toContain(amount);
    });

    it("PRUN6: approved pay runs can't be changed, deleted, approved again or corrected in the ledger", async () => {
      const changed = await setLines(ben, runId, people.kiri, [{ payItemId: items["Ordinary time"].id, amount: "1.00" }]);
      expect(changed.status).toBe(409);
      expect(changed.body.error).toBe("PAYRUN-1 is approved, so it can't be changed. Void it and run the pay again.");
      expect((await call(payRunRoute.DELETE, ben, `/api/payroll/pay-runs/${runId}`, { method: "DELETE", context: params({ payRunId: runId }) })).status).toBe(409);
      expect((await approve(jess, runId)).status).toBe(409);
      await expect(asUser(jess, (tx) => tx.query("update payroll_pay_runs set pay_date = '2026-10-15' where id = $1", [runId]))).rejects.toThrow(
        /can't be changed/,
      );
      await expect(
        asUser(jess, (tx) => tx.query("update payroll_pay_run_lines set amount = 1 where pay_run_id = $1", [runId])),
      ).rejects.toThrow(/can't be changed/);
      await expect(asUser(jess, (tx) => tx.query("delete from payroll_pay_run_postings where pay_run_id = $1", [runId]))).rejects.toThrow();
      const run = await asUser(ben, (tx) => getPayRun(tx, runId));
      await expect(
        asUser(jess, (tx) =>
          correctJournal(tx, {
            idempotencyKey: key("correct"),
            originalJournalId: run.approvalJournalId,
            postingDate: "2026-10-20",
            reference: "FIX",
            lines: [],
          }),
        ),
      ).rejects.toThrow("was posted by a pay run (PAYRUN-1), so it can't be corrected in the ledger. To undo it, void the pay run.");
    });

    it("PRUN6: voiding posts the exact reversal; then the period can be paid again", async () => {
      const voidIt = (voidDate: string, idempotencyKey = key("void")) =>
        call(voidRoute.POST, ben, `/api/payroll/pay-runs/${runId}/void`, { method: "POST", body: { idempotencyKey, voidDate }, context: params({ payRunId: runId }) });
      const early = await voidIt("2026-10-13");
      expect(early.body.error).toBe("The void date can't be before the pay date (2026-10-14).");
      const voidKey = key("void");
      const voided = await voidIt("2026-10-20", voidKey);
      expect(voided.status).toBe(201);
      const run = voided.body.payRun as PayRun;
      expect(run).toMatchObject({ status: "voided", voidDate: "2026-10-20" });
      expect((await voidIt("2026-10-20", voidKey)).status).toBe(200);
      const original = await journal(run.approvalJournalId!);
      const reversal = await journal(run.voidJournalId!);
      expect(reversal).toMatchObject({
        origin: "payroll",
        postingDate: "2026-10-20",
        reference: "VOID-PAYRUN-1",
        relatedJournalId: original.id,
        correctionKind: "reversal",
        totalDebit: "4786.54",
      });
      expect(lineSummary(reversal)).toEqual(lineSummary(original).map(([code, description, debit, credit, tag]) => [code, description, credit, debit, tag]));
      expect((await voidIt("2026-10-21")).status).toBe(409);
      await expect(asUser(jess, (tx) => tx.query("update payroll_pay_runs set void_date = '2026-10-21' where id = $1", [runId]))).rejects.toThrow(
        /can't be changed/,
      );

      const rerun = await createRun(ben, { payGroupId: groups.fortnightly, periodStart: "2026-09-28", payDate: "2026-10-14" });
      expect(rerun.status).toBe(201);
      expect((rerun.body.payRun as PayRun).reference).toBe("PAYRUN-2");
      const rerunId = (rerun.body.payRun as PayRun).id;
      expect(
        (await call(payRunRoute.DELETE, ben, `/api/payroll/pay-runs/${rerunId}`, { method: "DELETE", context: params({ payRunId: rerunId }) })).status,
      ).toBe(200);
      const list = (await call(payRunsRoute.GET, ben, "/api/payroll/pay-runs")).body.payRuns as PayRun[];
      expect(list.map((entry) => [entry.reference, entry.status])).toEqual([["PAYRUN-1", "voided"]]);
    });
  });

  describe("PRUN2: hourly, overtime, an allowance, a deduction and a reimbursement", () => {
    it("calculates and posts with the project in the line descriptions", async () => {
      const created = await createRun(ben, { payGroupId: groups.weekly, periodStart: "2026-10-05", payDate: "2026-10-14" });
      const run = created.body.payRun as PayRun;
      expect(pay(run, people.sione).lines).toEqual([
        expect.objectContaining({ payItemName: "Ordinary time", quantity: "32.00", rate: "22.50", amount: "720.00" }),
      ]);
      expect(pay(run, people.sione).hourlyRate).toBe("22.50");

      const odd = await setLines(ben, run.id, people.sione, [{ payItemId: items.Overtime.id, quantity: "3.3" }]);
      expect(pay(odd.body.payRun as PayRun, people.sione).lines[0]).toMatchObject({ rate: "33.75", amount: "111.38" });

      const updated = await setLines(ben, run.id, people.sione, [
        { payItemId: items["Ordinary time"].id, quantity: "32" },
        { payItemId: items.Overtime.id, quantity: "4" },
        { payItemId: items["Tool allowance"].id, amount: "25" },
        { payItemId: items.Reimbursement.id, amount: "42.60", description: "Fuel receipt" },
        { payItemId: items["Union fees"].id, amount: "8.50" },
      ]);
      expect(updated.status).toBe(200);
      const sione = pay(updated.body.payRun as PayRun, people.sione);
      expect(sione.lines.map((line) => [line.payItemName, line.quantity, line.rate, line.amount, line.description])).toEqual([
        ["Ordinary time", "32.00", "22.50", "720.00", null],
        ["Overtime", "4.00", "33.75", "135.00", null],
        ["Tool allowance", null, null, "25.00", null],
        ["Reimbursement", null, null, "42.60", "Fuel receipt"],
        ["Union fees", null, null, "8.50", null],
      ]);
      expect(sione.pay).toEqual({
        gross: "922.60",
        taxableEarnings: "880.00",
        nonTaxableEarnings: "42.60",
        kiwiSaverEarnings: "880.00",
        paye: "148.40",
        studentLoan: "0.00",
        kiwiSaverEmployee: "35.20",
        deductions: "8.50",
        netPay: "730.50",
        kiwiSaverEmployer: "30.80",
        esct: "5.25",
        kiwiSaverEmployerNet: "25.55",
        employerCost: "953.40",
        extraPay: "0.00",
        extraPayTax: "0.00",
        extraPayTaxRate: null,
        lumpSumLowestRate: false,
      });

      const approved = await approve(jess, run.id);
      expect(approved.status).toBe(201);
      const posted = await journal((approved.body.payRun as PayRun).approvalJournalId!);
      expect(posted.totalDebit).toBe("953.40");
      expect(lineSummary(posted)).toEqual([
        ["6200", "Ordinary time (project Cafe rebrand)", "720.00", "0.00", v.Operations],
        ["6200", "Overtime (project Cafe rebrand)", "135.00", "0.00", v.Operations],
        ["6200", "Tool allowance (project Cafe rebrand)", "25.00", "0.00", v.Operations],
        ["6070", "Reimbursement (project Cafe rebrand)", "42.60", "0.00", v.Operations],
        ["6210", "KiwiSaver employer contribution (project Cafe rebrand)", "30.80", "0.00", v.Operations],
        ["2200", "PAYE", "0.00", "148.40", null],
        ["2210", "KiwiSaver", "0.00", "60.75", null],
        ["2220", "ESCT", "0.00", "5.25", null],
        ["2250", "Union fees", "0.00", "8.50", null],
        ["2240", "Net pay", "0.00", "730.50", null],
      ]);
      const postings = await asUser(ben, (tx) => tx.query<{ project_id: string }>("select project_id::text from payroll_pay_run_postings where pay_run_id = $1", [run.id]));
      expect(postings.rows.every((row) => row.project_id === projectId)).toBe(true);
    });
  });

  describe("PRUN3 and PRUN7: student loan, KiwiSaver with ESCT, and approver must differ", () => {
    let runId = "";

    it("PRUN8: a student loan that disagrees with the tax code is shown and refused", async () => {
      const created = await createRun(ben, { payGroupId: groups.fourWeekly, periodStart: "2026-09-14", payDate: "2026-10-14" });
      const run = created.body.payRun as PayRun;
      runId = run.id;
      expect(run.periodEnd).toBe("2026-10-11");
      // Mere, not Jess: Jess approves in PRUN7, and changing an employee counts as preparing (PRUN7b).
      await asUser(mere, (tx) => updateEmployee(tx, people.aroha, { taxCode: "M" }));
      const broken = await asUser(ben, (tx) => getPayRun(tx, runId));
      expect(pay(broken, people.aroha)).toMatchObject({
        pay: null,
        problem: "Aroha Ngata has a student loan but tax code M has no SL. Fix their tax code or student loan under Employees.",
      });
      expect(broken.problemCount).toBe(1);
      const refused = await approve(jess, runId);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toContain("Aroha Ngata has a student loan but tax code M has no SL.");
      await asUser(mere, (tx) => updateEmployee(tx, people.aroha, { taxCode: "M SL" }));
    });

    it("PRUN3: IRD's ESS example 4 figures", async () => {
      const run = await asUser(ben, (tx) => getPayRun(tx, runId));
      expect(pay(run, people.aroha).pay).toEqual({
        gross: "3500.00",
        taxableEarnings: "3500.00",
        nonTaxableEarnings: "0.00",
        kiwiSaverEarnings: "3500.00",
        paye: "589.72",
        studentLoan: "197.28",
        kiwiSaverEmployee: "122.50",
        deductions: "0.00",
        netPay: "2590.50",
        kiwiSaverEmployer: "122.50",
        esct: "21.35",
        kiwiSaverEmployerNet: "101.15",
        employerCost: "3622.50",
        extraPay: "0.00",
        extraPayTax: "0.00",
        extraPayTaxRate: null,
        lumpSumLowestRate: false,
      });
    });

    it("PRUN7: with the setting on, whoever prepared the pay run can't approve it", async () => {
      const put = (user: SessionUser, approverMustDiffer: boolean) =>
        call(settingsRoute.PUT, user, "/api/payroll/settings", { method: "PUT", body: { approverMustDiffer } });
      expect((await put(ben, true)).status).toBe(403);
      expect((await put(mere, true)).body.settings).toEqual({ approverMustDiffer: true, irdPaymentFrequency: "monthly", leaveExpenseAccountCode: null, leaveLiabilityAccountCode: null, timesheetFirstDay: 1, standardWeek: "40.00" });
      expect((await call(settingsRoute.GET, ben, "/api/payroll/settings")).body.settings).toEqual({ approverMustDiffer: true, irdPaymentFrequency: "monthly", leaveExpenseAccountCode: null, leaveLiabilityAccountCode: null, timesheetFirstDay: 1, standardWeek: "40.00" });

      const byBen = await approve(ben, runId);
      expect(byBen.status).toBe(403);
      expect(byBen.body.error).toBe("You prepared this pay run, so someone else has to approve it.");

      const byJess = await approve(jess, runId);
      expect(byJess.status).toBe(201);
      const run = byJess.body.payRun as PayRun;
      expect(run.approvedByEmail).toBe("jess@payruns.test");
      const posted = await journal(run.approvalJournalId!);
      expect(lineSummary(posted)).toEqual([
        ["6200", "Ordinary time", "3500.00", "0.00", v.Sales],
        ["6210", "KiwiSaver employer contribution", "122.50", "0.00", v.Sales],
        ["2200", "PAYE", "0.00", "589.72", null],
        ["2230", "Student loan", "0.00", "197.28", null],
        ["2210", "KiwiSaver", "0.00", "223.65", null],
        ["2220", "ESCT", "0.00", "21.35", null],
        ["2240", "Net pay", "0.00", "2590.50", null],
      ]);
      expect(posted.totalDebit).toBe("3622.50");
      await put(mere, false);
    });
  });

  describe("PRUN4: pay date 1 April 2026, across the KiwiSaver change", () => {
    it("uses the pay date's rates for the whole pay", async () => {
      const march = await group("Fortnightly salaries (March)", "fortnightly");
      const hemi = await employee({
        firstName: "Hemi",
        lastName: "Walker",
        payFrequency: "fortnightly",
        annualSalary: "70000.00",
        kiwiSaverStatus: "enrolled",
        kiwiSaverEmployeeRate: "3",
        kiwiSaverEmployerRate: "3",
        esctRate: "30",
        startDate: "2026-03-01",
        payGroupId: march,
      });
      const april = (await createRun(ben, { payGroupId: march, periodStart: "2026-03-19", payDate: "2026-04-01" })).body.payRun as PayRun;
      expect(april.periodEnd).toBe("2026-04-01");
      expect(pay(april, hemi).problem).toBe("3% isn't a KiwiSaver employee rate on 2026-04-01: use 3.5%, 4%, 6%, 8%, 10%.");
      expect((await approve(jess, april.id)).status).toBe(400);
      await asUser(jess, (tx) => updateEmployee(tx, hemi, { kiwiSaverEmployeeRate: "3.5" }));
      expect(pay(await asUser(ben, (tx) => getPayRun(tx, april.id)), hemi).problem).toBe(
        "The compulsory KiwiSaver employer contribution on 2026-04-01 is at least 3.5%.",
      );
      await asUser(jess, (tx) => updateEmployee(tx, hemi, { kiwiSaverEmployeeRate: "3" }));
      await call(payRunRoute.DELETE, ben, `/api/payroll/pay-runs/${april.id}`, { method: "DELETE", context: params({ payRunId: april.id }) });

      const marchRun = (await createRun(ben, { payGroupId: march, periodStart: "2026-03-19", payDate: "2026-03-31" })).body.payRun as PayRun;
      expect(pay(marchRun, hemi).pay).toMatchObject({
        gross: "2692.31",
        paye: "553.44",
        kiwiSaverEmployee: "80.76",
        kiwiSaverEmployer: "80.76",
        esct: "24.00",
        kiwiSaverEmployerNet: "56.76",
        netPay: "2058.11",
      });
      await call(payRunRoute.DELETE, ben, `/api/payroll/pay-runs/${marchRun.id}`, { method: "DELETE", context: params({ payRunId: marchRun.id }) });

      await asUser(jess, (tx) => updateEmployee(tx, hemi, { kiwiSaverEmployeeRate: "3.5", kiwiSaverEmployerRate: "3.5" }));
      const fixed = (await createRun(ben, { payGroupId: march, periodStart: "2026-03-19", payDate: "2026-04-01" })).body.payRun as PayRun;
      expect(pay(fixed, hemi).pay).toMatchObject({ paye: "555.58", kiwiSaverEmployee: "94.23", kiwiSaverEmployer: "94.23", esct: "28.20", netPay: "2042.50" });
      await call(payRunRoute.DELETE, ben, `/api/payroll/pay-runs/${fixed.id}`, { method: "DELETE", context: params({ payRunId: fixed.id }) });
    });
  });

  describe("PRUN5: approving in a locked period", () => {
    it("is refused and the pay run stays a draft", async () => {
      const run = (await createRun(ben, { payGroupId: groups.weekly, periodStart: "2026-10-19", payDate: "2026-10-28" })).body.payRun as PayRun;
      await asUser(jess, (tx) => updatePeriodControls(tx, { lockDate: "2026-10-31" }));
      const refused = await approve(jess, run.id);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe(
        "2026-10-28 is in a locked period (locked up to 2026-10-31). Use a later date, or ask an owner or admin to reopen the period on Period close.",
      );
      const after = await asUser(ben, (tx) => getPayRun(tx, run.id));
      expect(after).toMatchObject({ status: "draft", approvalJournalId: null });
      await asUser(jess, (tx) => updatePeriodControls(tx, { lockDate: null, reason: "PRUN5 test" }));
      await call(payRunRoute.DELETE, ben, `/api/payroll/pay-runs/${run.id}`, { method: "DELETE", context: params({ payRunId: run.id }) });
    });
  });

  describe("PRUN8: refused rather than guessed", () => {
    it("refuses pay items Tohyee doesn't support yet", async () => {
      for (const kind of ["child_support", "payroll_giving", "employer_contribution"]) {
        const refused = await call(payItemsRoute.POST, mere, "/api/payroll/pay-items", {
          method: "POST",
          body: { idempotencyKey: key("item"), name: `Refused ${kind}`, kind, accountCode: "6200" },
        });
        expect(refused.status).toBe(400);
        expect(refused.body.error).toContain(NOT_SUPPORTED);
      }
      // Leave pay items come with the organisation since P8 (decision 138).
      for (const kind of ["leave", "annual_leave", "sick_leave"]) {
        const refused = await call(payItemsRoute.POST, mere, "/api/payroll/pay-items", {
          method: "POST",
          body: { idempotencyKey: key("item"), name: `Refused ${kind}`, kind, accountCode: "6200" },
        });
        expect(refused.status).toBe(400);
        expect(refused.body.error).toContain("Leave pay items come with the organisation");
      }
      const taxedReimbursement = await call(payItemsRoute.POST, mere, "/api/payroll/pay-items", {
        method: "POST",
        body: { idempotencyKey: key("item"), name: "Taxed reimbursement", kind: "reimbursement", accountCode: "6070", taxable: true },
      });
      expect(taxedReimbursement.body.error).toContain(`${NOT_SUPPORTED}: a reimbursement that is taxed`);
      const levyApart = await call(payItemsRoute.POST, mere, "/api/payroll/pay-items", {
        method: "POST",
        body: { idempotencyKey: key("item"), name: "No levy", kind: "allowance", accountCode: "6200", subjectToAccLevy: false },
      });
      expect(levyApart.body.error).toContain(NOT_SUPPORTED);
      // Bonuses are the Extra pay kind (P12); its treatment is fixed.
      const bonus = await call(payItemsRoute.POST, mere, "/api/payroll/pay-items", {
        method: "POST",
        body: { idempotencyKey: key("item"), name: "Refused bonus", kind: "bonus", accountCode: "6200" },
      });
      expect(bonus.body.error).toContain("(bonuses and lump sums are extra_pay)");
      const untaxedRedundancy = await call(payItemsRoute.POST, mere, "/api/payroll/pay-items", {
        method: "POST",
        body: { idempotencyKey: key("item"), name: "Redundancy KS", kind: "redundancy", accountCode: "6200", countsForKiwiSaver: true },
      });
      expect(untaxedRedundancy.body.error).toBe("Redundancy pay items are taxable and don't count for KiwiSaver (decision 125).");
    });

    it("refuses part periods on a salary (starting or finishing), pay rate changes in a period and odd monthly periods", async () => {
      const leavers = await group("Leavers", "weekly");
      await employee({ firstName: "Tama", lastName: "Leaving", payFrequency: "weekly", annualSalary: "52000", finishDate: "2026-10-07", payGroupId: leavers });
      const final = await createRun(ben, { payGroupId: leavers, periodStart: "2026-10-05", payDate: "2026-10-14" });
      expect(final.body.error).toBe(
        `${NOT_SUPPORTED}: part of a pay period on a salary. Tama Leaving finishes on 2026-10-07, before the period ends.`,
      );

      const starters = await group("Starters", "weekly");
      await employee({ firstName: "Nia", lastName: "Starting", payFrequency: "weekly", annualSalary: "52000", startDate: "2026-10-07", payGroupId: starters });
      const part = await createRun(ben, { payGroupId: starters, periodStart: "2026-10-05", payDate: "2026-10-14" });
      expect(part.body.error).toBe(
        `${NOT_SUPPORTED}: part of a pay period on a salary. Nia Starting starts on 2026-10-07, after the period starts.`,
      );

      const raises = await group("Raises", "weekly");
      const raised = await employee({ firstName: "Ana", lastName: "Raised", payFrequency: "weekly", annualSalary: "52000", payGroupId: raises });
      await asUser(jess, (tx) =>
        addPayRate(tx, raised, { idempotencyKey: key("rate"), effectiveFrom: "2026-10-08", payBasis: "salary", annualSalary: "56000" }),
      );
      const changed = await createRun(ben, { payGroupId: raises, periodStart: "2026-10-05", payDate: "2026-10-14" });
      expect(changed.body.error).toBe(
        `${NOT_SUPPORTED}: a pay rate that changes part-way through a pay period. Ana Raised's pay rate changes on 2026-10-08.`,
      );

      const monthly = await group("Monthly", "monthly");
      await employee({ firstName: "Rawiri", lastName: "Monthly", payFrequency: "monthly", annualSalary: "60000", payGroupId: monthly });
      const odd = await createRun(ben, { payGroupId: monthly, periodStart: "2026-10-15", payDate: "2026-10-31" });
      expect(odd.body.error).toBe(`${NOT_SUPPORTED}: a monthly pay period that doesn't start on the 1st of a month.`);
      const calendar = await createRun(ben, { payGroupId: monthly, periodStart: "2026-10-01", payDate: "2026-10-31" });
      expect(calendar.body.payRun).toMatchObject({ periodEnd: "2026-10-31" });
      const runId = (calendar.body.payRun as PayRun).id;
      expect(pay(calendar.body.payRun as PayRun, (calendar.body.payRun as PayRun).employees[0].employeeId).lines[0].amount).toBe("5000.00");

      const negative = await setLines(ben, runId, (calendar.body.payRun as PayRun).employees[0].employeeId, [
        { payItemId: items["Ordinary time"].id, amount: "-5" },
      ]);
      expect(negative.body.error).toBe(`${NOT_SUPPORTED}: amounts below zero (corrections and back pay).`);
      const employer = await setLines(ben, runId, (calendar.body.payRun as PayRun).employees[0].employeeId, [
        { payItemId: items["KiwiSaver employer contribution"].id, amount: "5" },
      ]);
      expect(employer.body.error).toBe("Line 1: KiwiSaver employer contribution is calculated by Tohyee, not entered.");
    });

    it("refuses a finish date or pay rate change entered inside the period after the draft was made", async () => {
      const late = await group("Late changes", "weekly");
      const lou = await employee({ firstName: "Lou", lastName: "Leaver", payFrequency: "weekly", annualSalary: "52000", payGroupId: late });
      const rai = await employee({ firstName: "Rai", lastName: "Riser", payFrequency: "weekly", annualSalary: "52000", payGroupId: late });
      const created = await createRun(ben, { payGroupId: late, periodStart: "2026-10-05", payDate: "2026-10-14" });
      const runId = (created.body.payRun as PayRun).id;
      expect((created.body.payRun as PayRun).problemCount).toBe(0);

      await asUser(jess, (tx) => updateEmployee(tx, lou, { finishDate: "2026-10-07" }));
      await asUser(jess, (tx) =>
        addPayRate(tx, rai, { idempotencyKey: key("rate"), effectiveFrom: "2026-10-08", payBasis: "salary", annualSalary: "56000" }),
      );
      const draft = await asUser(ben, (tx) => getPayRun(tx, runId));
      expect(pay(draft, lou)).toMatchObject({
        pay: null,
        problem: `${NOT_SUPPORTED}: part of a pay period on a salary. Lou Leaver finishes on 2026-10-07, before the period ends.`,
      });
      expect(pay(draft, rai)).toMatchObject({
        pay: null,
        problem: `${NOT_SUPPORTED}: a pay rate that changes part-way through a pay period. Rai Riser's pay rate changes on 2026-10-08.`,
      });
      const refused = await approve(ben, runId);
      expect(refused.status).toBe(400);
      expect((await asUser(ben, (tx) => getPayRun(tx, runId))).status).toBe("draft");
    });

    it("refuses paying someone moved between pay groups twice for the same days", async () => {
      const first = await group("Mover first", "weekly");
      const second = await group("Mover second", "weekly");
      const moe = await employee({ firstName: "Moe", lastName: "Mover", payFrequency: "weekly", annualSalary: "52000", payGroupId: first });
      const firstRun = await createRun(ben, { payGroupId: first, periodStart: "2026-10-05", payDate: "2026-10-14" });
      expect(firstRun.status).toBe(201);
      await asUser(jess, (tx) => updateEmployee(tx, moe, { payGroupId: second }));
      const reference = (firstRun.body.payRun as PayRun).reference;
      const again = await createRun(ben, { payGroupId: second, periodStart: "2026-10-05", payDate: "2026-10-14" });
      expect(again.body.error).toBe(
        `Moe Mover is already paid for 2026-10-05 to 2026-10-11 on ${reference}. Take them off one of the pay runs (or void it).`,
      );
      const nextWeek = await createRun(ben, { payGroupId: second, periodStart: "2026-10-12", payDate: "2026-10-21" });
      expect(nextWeek.status).toBe(201);
    });

    it("shows an employer contribution with no ESCT rate as a problem, and net pay below zero", async () => {
      const noEsct = await group("No ESCT", "weekly");
      const tui = await employee({
        firstName: "Tui",
        lastName: "Noesct",
        payFrequency: "weekly",
        annualSalary: "52000",
        kiwiSaverStatus: "enrolled",
        payGroupId: noEsct,
      });
      const run = (await createRun(ben, { payGroupId: noEsct, periodStart: "2026-10-05", payDate: "2026-10-14" })).body.payRun as PayRun;
      expect(pay(run, tui).problem).toBe("Tui Noesct has employer KiwiSaver contributions but no ESCT rate. Set it under Employees.");
      const big = await setLines(ben, run.id, tui, [
        { payItemId: items["Ordinary time"].id, amount: "100" },
        { payItemId: items["Union fees"].id, amount: "500" },
      ]);
      await asUser(jess, (tx) => updateEmployee(tx, tui, { esctRate: "17.5" }));
      const after = await asUser(ben, (tx) => getPayRun(tx, run.id));
      expect(big.status).toBe(200);
      expect(pay(after, tui).problem).toMatch(new RegExp(`^${NOT_SUPPORTED.replace(/[()]/g, "\\$&")}: Tui Noesct's net pay would be below zero`));
      const left = await call(payRunEmployeeRoute.DELETE, ben, `/api/payroll/pay-runs/${run.id}/employees/${tui}`, {
        method: "DELETE",
        context: params({ payRunId: run.id, employeeId: tui }),
      });
      expect((left.body.payRun as PayRun).employees).toEqual([]);
      expect((await approve(jess, run.id)).body.error).toContain("has nobody on it");
    });
  });

  describe("PRUN7b: changing an employee counts as preparing", () => {
    it("whoever changes someone's payroll details while they're on a draft can't approve it", async () => {
      const put = (approverMustDiffer: boolean) => call(settingsRoute.PUT, mere, "/api/payroll/settings", { method: "PUT", body: { approverMustDiffer } });
      expect((await put(true)).status).toBe(200);
      const fortnightly = await group("Fortnightly (PRUN7b)", "fortnightly");
      const hemi = await employee({ firstName: "Hemi", lastName: "Walker", payFrequency: "fortnightly", annualSalary: "70000.00", payGroupId: fortnightly });
      const kiri = await employee({ firstName: "Kiri", lastName: "Walker", payFrequency: "fortnightly", annualSalary: "52000.00", payGroupId: fortnightly });
      const off = await employee({ firstName: "Pita", lastName: "Offrun", payFrequency: "weekly", annualSalary: "50000.00" });
      const changedBy = async (runId: string) =>
        (await asUser(jess, (tx) => tx.query<{ changed: unknown[] }>("select details_changed_by as changed from payroll_pay_runs where id = $1", [runId]))).rows[0].changed;

      // Made before the draft was created: doesn't count.
      await asUser(ben, (tx) => updateEmployee(tx, hemi, { taxCode: "ME" }));
      const created = await createRun(mere, { payGroupId: fortnightly, periodStart: "2026-10-05", payDate: "2026-10-21" });
      expect(created.status).toBe(201);
      const run = created.body.payRun as PayRun;
      expect(run.employees.map((entry) => entry.employeeId).sort()).toEqual([hemi, kiri].sort());

      // Someone not on the draft, or a change that changes nothing: doesn't count.
      await asUser(ben, (tx) => updateEmployee(tx, off, { bankAccount: "12-3456-7654321-00" }));
      await asUser(ben, (tx) => updateEmployee(tx, hemi, { kiwiSaverEmployeeRate: "3.50", bankAccount: "03-1234-0123456-00", firstName: "Hemi" }));
      expect(await changedBy(run.id)).toEqual([]);

      // Ben changes Hemi's bank account, then adds Kiri a pay rate.
      await asUser(ben, (tx) => updateEmployee(tx, hemi, { bankAccount: "12-3456-7654321-00" }));
      await asUser(ben, (tx) =>
        addPayRate(tx, kiri, { idempotencyKey: key("rate"), effectiveFrom: "2026-10-05", payBasis: "salary", annualSalary: "54000.00" }),
      );
      expect(await changedBy(run.id)).toEqual([
        { userId: ben.id, employeeId: hemi, name: "Hemi Walker" },
        { userId: ben.id, employeeId: kiri, name: "Kiri Walker" },
      ]);

      const byBen = await approve(ben, run.id);
      expect(byBen.status).toBe(403);
      expect(byBen.body.error).toBe(`You changed Hemi Walker's payroll details while ${run.reference} was a draft, so someone else has to approve it.`);
      const byMere = await approve(mere, run.id);
      expect(byMere.status).toBe(403);
      expect(byMere.body.error).toBe("You prepared this pay run, so someone else has to approve it.");
      const byJess = await approve(jess, run.id);
      expect(byJess.status).toBe(201);

      // Once it's approved, changes don't touch it.
      await asUser(ben, (tx) => updateEmployee(tx, hemi, { taxCode: "M" }));
      expect(await changedBy(run.id)).toHaveLength(2);
      await put(false);
    });

    it("with the setting off, a change doesn't stop the person approving", async () => {
      const weekly = await group("Weekly (PRUN7b)", "weekly");
      const tui = await employee({ firstName: "Tui", lastName: "Settingoff", payFrequency: "weekly", annualSalary: "52000.00", payGroupId: weekly });
      const run = (await createRun(mere, { payGroupId: weekly, periodStart: "2026-10-05", payDate: "2026-10-14" })).body.payRun as PayRun;
      await asUser(ben, (tx) => updateEmployee(tx, tui, { studentLoan: true, taxCode: "M SL" }));
      expect((await approve(ben, run.id)).status).toBe(201);
    });
  });

  describe("PRUN9: payroll access", () => {
    it("everything about pay items and pay runs needs payroll access and the bookkeeper role", async () => {
      for (const user of [noah, vic]) {
        expect((await call(payRunsRoute.GET, user, "/api/payroll/pay-runs")).status).toBe(403);
        expect((await call(payItemsRoute.GET, user, "/api/payroll/pay-items")).status).toBe(403);
        expect((await call(settingsRoute.GET, user, "/api/payroll/settings")).status).toBe(403);
        expect((await createRun(user, { payGroupId: groups.weekly, periodStart: "2026-11-02", payDate: "2026-11-04" })).status).toBe(403);
      }
      const noAccess = await call(payRunsRoute.GET, noah, "/api/payroll/pay-runs");
      expect(noAccess.body.error).toMatch(/^You need payroll access to see payroll/);
      await expect(asUser(noah, (tx) => createPayRun(tx, { idempotencyKey: key("x"), payGroupId: groups.weekly, periodStart: "2026-11-02", payDate: "2026-11-04" }))).rejects.toThrow(
        /payroll access/,
      );
    });

    it("audit events never contain IRD numbers, bank accounts or pay amounts", async () => {
      const audit = await asUser(jess, (tx) =>
        tx.query<{ details: unknown }>("select details from audit_events where event_type like 'payroll_pay_run.%' or event_type like 'payroll_pay_item.%'"),
      );
      expect(audit.rows.length).toBeGreaterThan(5);
      const text = JSON.stringify(audit.rows);
      for (const secret of ["123456789", "03-1234-0123456-00", "2692.31", "720.00", "953.40", "8.50", "42.60"]) expect(text).not.toContain(secret);
      const posted = await asUser(jess, (tx) =>
        tx.query<{ details: Record<string, unknown> }>("select details from audit_events where event_type = 'ledger.journal_posted' and details->>'origin' = 'payroll'"),
      );
      expect(posted.rows.length).toBeGreaterThan(0);
      for (const row of posted.rows) expect(row.details.total).toBeUndefined();
    });
  });
});

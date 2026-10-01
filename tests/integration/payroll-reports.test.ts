import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as exportRoute from "@/app/api/payroll/reports/export/route";
import * as reportsRoute from "@/app/api/payroll/reports/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { postJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { setPayrollAccess } from "@/lib/payroll/access";
import { addAllocation } from "@/lib/payroll/allocations";
import { createEmployee, updateEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import { recordIrdPayment } from "@/lib/payroll/ird-payments";
import { createPayItem, listPayItems, type PayItem } from "@/lib/payroll/pay-items";
import { approvePayRun, createPayRun, type PayRun, setPayRunEmployeeLines, voidPayRun } from "@/lib/payroll/pay-runs";
import { makePayRunPaydayFilingFile, updatePaydayFilingSettings } from "@/lib/payroll/payday-filing-service";
import type {
  EarningsHistoryReport,
  HeadcountReport,
  IrdDeductionsReport,
  LabourCostReport,
  PayrollReconciliation,
  PayrollSummaryReport,
} from "@/lib/payroll/reports";
import { approveTimesheet, openTimesheet, saveTimesheetEntries, submitTimesheet } from "@/lib/payroll/timesheets";
import { recordWagePayment } from "@/lib/payroll/wage-payments";
import { createProject } from "@/lib/projects/service";
import { createActivity, createApproval } from "@/lib/rd/register";
import { createTrackingValue, getTrackingSetup } from "@/lib/tracking/service";
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

const ORG = "payroll-reports-harbour";
const KEA = "payroll-reports-kea";
const noContext = undefined as never;

/**
 * Payroll reports, payroll stage P10: examples PREP1-PREP8 in
 * docs/ACCOUNTING-EXAMPLES.md ("Payroll reports"). Harbour Cafe Ltd's
 * October 2026: PAYRUN-1 (PRUN1, voided 20 Oct), PAYRUN-2 (PRUN2),
 * PAYRUN-3 (PRUN3), PAYRUN-4 (PRUN1 run again), their wages paid, a manual
 * accrual; IRD paid on 20 Nov. PREP2 uses Kea Sensors Ltd's TS5 pay run.
 */
describeWithDatabase("payroll reports (PREP1-PREP8)", () => {
  let server: TestServer;
  let jess: SessionUser; // first owner, payroll access
  let mere: SessionUser; // admin, payroll access
  let ben: SessionUser; // bookkeeper, payroll access
  let noah: SessionUser; // bookkeeper, no payroll access
  let ana: SessionUser; // admin, no payroll access
  let vic: SessionUser; // viewer
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const v: Record<string, string> = {};
  const people: Record<string, string> = {};
  const groups: Record<string, string> = {};
  const runs: Record<string, PayRun> = {};
  let items: Record<string, PayItem> = {};
  let projectId = "";

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>, org = ORG) => inOrganisation(org, { userId: user.id, email: user.email }, work);

  const report = async <T>(user: SessionUser, query: Record<string, string>, org = ORG) => {
    const search = new URLSearchParams({ organisationId: org, ...query });
    const response = await reportsRoute.GET(apiRequest(`/api/payroll/reports?${search.toString()}`, { cookie: await sessionCookieFor(user) }), noContext);
    const body = (await response.json()) as { report?: T; error?: string };
    return { status: response.status, report: body.report as T, error: body.error };
  };

  const exportCsv = async (user: SessionUser, body: Record<string, string>) => {
    const response = await exportRoute.POST(
      apiRequest("/api/payroll/reports/export", { method: "POST", cookie: await sessionCookieFor(user), body: { organisationId: ORG, ...body } }),
      noContext,
    );
    return { status: response.status, headers: response.headers, text: await response.text() };
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

  const allocate = (employeeId: string, lines: unknown[]) =>
    asUser(jess, (tx) => addAllocation(tx, employeeId, { idempotencyKey: key("allocation"), effectiveFrom: "2026-04-01", lines }));

  const approvedRun = async (payGroupId: string, periodStart: string, lines: Record<string, unknown[]> = {}) => {
    const draft = (await asUser(ben, (tx) => createPayRun(tx, { idempotencyKey: key("payrun"), payGroupId, periodStart, payDate: "2026-10-14" }))).payRun;
    for (const [employeeId, employeeLines] of Object.entries(lines)) {
      await asUser(ben, (tx) => setPayRunEmployeeLines(tx, draft.id, employeeId, { lines: employeeLines }));
    }
    return (await asUser(ben, (tx) => approvePayRun(tx, draft.id, { idempotencyKey: key("approve") }))).payRun;
  };

  const auditEvents = (eventType: string) =>
    asUser(jess, (tx) => tx.query<{ details: Record<string, unknown> }>("select details from audit_events where event_type = $1 order by id", [eventType]));
  const journalCount = async () =>
    Number((await asUser(jess, (tx) => tx.query<{ count: string }>("select count(*)::text as count from ledger_journals"))).rows[0].count);

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    jess = await createTestUser("jess@payrollreports.test");
    await createTestOrganisation(jess, ORG);
    mere = await createTestUser("mere@payrollreports.test");
    ben = await createTestUser("ben@payrollreports.test");
    noah = await createTestUser("noah@payrollreports.test");
    ana = await createTestUser("ana@payrollreports.test");
    vic = await createTestUser("vic@payrollreports.test");
    const members = [
      [mere, "admin"],
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
    for (const user of [mere, ben]) await asUser(jess, (tx) => setPayrollAccess(tx, memberList, { userId: user.id, hasPayrollAccess: true }));

    await asUser(jess, (tx) => updateOrganisationSettings(tx, { advancedFeatures: true, displayName: "Harbour Cafe Ltd" }));
    const department = (await asUser(jess, (tx) => getTrackingSetup(tx))).categories.find((category) => category.kind === "department")!.id;
    for (const name of ["Sales", "Operations"]) {
      const setup = await asUser(jess, (tx) => createTrackingValue(tx, { categoryId: department, name }));
      v[name] = setup.categories.find((category) => category.id === department)!.values.find((value) => value.name === name)!.id;
    }
    const contact = (await asUser(jess, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Cafe", isCustomer: true }))).contact;
    projectId = (await asUser(jess, (tx) => createProject(tx, { idempotencyKey: key("p"), name: "Cafe rebrand", contactId: contact.id }))).project.id;
    await asUser(jess, (tx) =>
      createPayItem(tx, { idempotencyKey: key("item"), name: "Tool allowance", kind: "allowance", accountCode: "6200", taxable: true, countsForKiwiSaver: true }),
    );
    items = Object.fromEntries((await asUser(jess, (tx) => listPayItems(tx))).map((item) => [item.name, item]));

    for (const [name, frequency, label] of [
      ["fortnightly", "fortnightly", "Fortnightly salaries"],
      ["weekly", "weekly", "Weekly wages"],
      ["fourWeekly", "four_weekly", "Four-weekly"],
    ] as const) {
      groups[name] = (await asUser(jess, (tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: label, payFrequency: frequency }))).group.id;
    }
    people.hemi = await employee({
      firstName: "Hemi",
      lastName: "Walker",
      payFrequency: "fortnightly",
      annualSalary: "70000.00",
      kiwiSaverStatus: "enrolled",
      esctRate: "30",
      payGroupId: groups.fortnightly,
    });
    people.kiri = await employee({ firstName: "Kiri", lastName: "Tane", irdNumber: "87654321", payFrequency: "fortnightly", annualSalary: "52000.00", payGroupId: groups.fortnightly });
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
    await asUser(jess, (tx) =>
      updatePaydayFilingSettings(tx, {
        employerIrdNumber: "123123123",
        contactName: "Mere Tipene",
        contactPhone: "03 477 1234",
        contactEmail: "payroll@harbourcafe.co.nz",
      }),
    );

    runs.one = await approvedRun(groups.fortnightly, "2026-09-28");
    runs.two = await approvedRun(groups.weekly, "2026-10-05", {
      [people.sione]: [
        { payItemId: items["Ordinary time"].id, quantity: "32" },
        { payItemId: items.Overtime.id, quantity: "4" },
        { payItemId: items["Tool allowance"].id, amount: "25" },
        { payItemId: items.Reimbursement.id, amount: "42.60", description: "Fuel receipt" },
        { payItemId: items["Union fees"].id, amount: "8.50" },
      ],
    });
    runs.three = await approvedRun(groups.fourWeekly, "2026-09-14");
    for (const run of [runs.one, runs.two, runs.three]) await asUser(ben, (tx) => makePayRunPaydayFilingFile(tx, run.id));
    await asUser(ben, (tx) => voidPayRun(tx, runs.one.id, { idempotencyKey: key("void"), voidDate: "2026-10-20" }));
    runs.four = await approvedRun(groups.fortnightly, "2026-09-28");
    for (const [run, amount, paymentDate] of [
      [runs.two, "730.50", "2026-10-14"],
      [runs.three, "2590.50", "2026-10-14"],
      [runs.four, "3699.50", "2026-10-21"],
    ] as const) {
      await asUser(ben, (tx) => recordWagePayment(tx, run.id, { idempotencyKey: key("wages"), paymentDate, amount, bankAccountCode: "1000" }));
    }
    await asUser(jess, (tx) =>
      postJournal(tx, {
        idempotencyKey: key("accrual"),
        postingDate: "2026-10-31",
        reference: "ACCRUAL-OCT",
        description: "Wages accrued 26-31 Oct",
        lines: [
          { accountCode: "6200", debitAmount: "500.00" },
          { accountCode: "2240", creditAmount: "500.00" },
        ],
      }),
    );
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  const OCT = { from: "2026-10-01", to: "2026-10-31" };
  const PAYRUN = (run: PayRun) => run.reference;

  describe("labour cost (PREP1)", () => {
    it("PREP1: by Department, from the counted pay runs' postings, reimbursements apart", async () => {
      const { status, report: labour } = await report<LabourCostReport>(ben, { report: "labour-cost", ...OCT, groupBy: "department" });
      expect(status).toBe(200);
      const names = Object.fromEntries(labour.payItems.map((item) => [item.id, item.name]));
      expect(labour.payItems.map((item) => item.name)).toEqual(["Ordinary time", "Overtime", "Tool allowance", "KiwiSaver employer contribution"]);
      expect(
        labour.groups.map((group) => [group.label, Object.fromEntries(Object.entries(group.amounts).map(([id, amount]) => [names[id], amount])), group.total]),
      ).toEqual([
        ["Operations", { "Ordinary time": "1796.92", Overtime: "135.00", "Tool allowance": "25.00", "KiwiSaver employer contribution": "68.49" }, "2025.41"],
        ["Sales", { "Ordinary time": "7115.39", "KiwiSaver employer contribution": "179.04" }, "7294.43"],
      ]);
      expect(labour.total).toBe("9319.84");
      expect(labour.reimbursements).toBe("42.60");
      expect(labour.payRuns.map((run) => run.reference)).toEqual([PAYRUN(runs.two), PAYRUN(runs.three), PAYRUN(runs.four)]);
      expect(labour.voided).toEqual([expect.objectContaining({ reference: PAYRUN(runs.one), payDate: "2026-10-14", voidDate: "2026-10-20" })]);
    });

    it("PREP1: by project, pay item and employee", async () => {
      const by = async (groupBy: string) =>
        (await report<LabourCostReport>(ben, { report: "labour-cost", ...OCT, groupBy })).report.groups.map((group) => [group.label, group.total]);
      expect(await by("project")).toEqual([
        ["Cafe rebrand", "910.80"],
        ["No project", "8409.04"],
      ]);
      expect(await by("pay_item")).toEqual([
        ["KiwiSaver employer contribution", "247.53"],
        ["Ordinary time", "8912.31"],
        ["Overtime", "135.00"],
        ["Tool allowance", "25.00"],
      ]);
      expect(await by("employee")).toEqual([
        ["Aroha Ngata", "3622.50"],
        ["Hemi Walker", "2786.54"],
        ["Kiri Tane", "2000.00"],
        ["Sione Fifita", "910.80"],
      ]);
    });

    it("PREP1: filters work together", async () => {
      const filtered = async (query: Record<string, string>) => (await report<LabourCostReport>(ben, { report: "labour-cost", ...OCT, ...query })).report;
      expect((await filtered({ departmentId: v.Operations, payItemId: items["Ordinary time"].id })).total).toBe("1796.92");
      const hemi = await filtered({ employeeId: people.hemi, groupBy: "department" });
      expect(hemi.groups.map((group) => [group.label, group.total])).toEqual([
        ["Operations", "1114.61"],
        ["Sales", "1671.93"],
      ]);
      expect(hemi.total).toBe("2786.54");
      const none = await filtered({ departmentId: v.Sales, projectId });
      expect(none.groups).toEqual([]);
      expect(none.total).toBe("0.00");
      const unknown = await report<LabourCostReport>(ben, { report: "labour-cost", ...OCT, employeeId: "00000000-0000-0000-0000-000000000000" });
      expect(unknown.status).toBe(404);
    });
  });

  describe("payroll summary (PREP3)", () => {
    it("PREP3: each pay run gross to net with totals and pay items", async () => {
      const { report: summary } = await report<PayrollSummaryReport>(ben, { report: "summary", ...OCT });
      expect(summary.payRuns.map((run) => [run.reference, run.payGroupName, run.employeeCount, run.figures.gross, run.figures.netPay, run.figures.employerCost])).toEqual([
        [PAYRUN(runs.two), "Weekly wages", 1, "922.60", "730.50", "953.40"],
        [PAYRUN(runs.three), "Four-weekly", 1, "3500.00", "2590.50", "3622.50"],
        [PAYRUN(runs.four), "Fortnightly salaries", 2, "4692.31", "3699.50", "4786.54"],
      ]);
      expect(summary.totals).toEqual({
        employeeCount: 4,
        gross: "9114.91",
        taxableEarnings: "9072.31",
        nonTaxableEarnings: "42.60",
        paye: "1636.70",
        studentLoan: "197.28",
        kiwiSaverEmployee: "251.93",
        deductions: "8.50",
        netPay: "7020.50",
        kiwiSaverEmployer: "247.53",
        esct: "54.80",
        kiwiSaverEmployerNet: "192.73",
        employerCost: "9362.44",
      });
      expect(summary.payItems.map((item) => [item.name, item.hours, item.amount])).toEqual([
        ["Ordinary time", "32.00", "8912.31"],
        ["Overtime", "4.00", "135.00"],
        ["Tool allowance", null, "25.00"],
        ["Reimbursement", null, "42.60"],
        ["Union fees", null, "8.50"],
        ["KiwiSaver employer contribution", null, "247.53"],
      ]);
      expect(summary.voided.map((run) => [run.reference, run.voidDate])).toEqual([[PAYRUN(runs.one), "2026-10-20"]]);

      const sione = (await report<PayrollSummaryReport>(ben, { report: "summary", ...OCT, employeeId: people.sione })).report;
      expect(sione.payRuns.map((run) => run.reference)).toEqual([PAYRUN(runs.two)]);
      expect(sione.totals).toMatchObject({ employeeCount: 1, gross: "922.60", paye: "148.40", netPay: "730.50" });
    });
  });

  describe("reconciliation to the ledger (PREP4)", () => {
    it("PREP4: October, each payroll account against the ledger with the journals that explain it", async () => {
      const { report: rec } = await report<PayrollReconciliation>(ben, { report: "reconciliation", ...OCT });
      expect(rec.accounts.map((account) => [account.code, account.payroll, account.ledger, account.difference, account.unexplained])).toEqual([
        ["6070", "42.60", "42.60", "0.00", "0.00"],
        ["6200", "9072.31", "9572.31", "500.00", "0.00"],
        ["6210", "247.53", "247.53", "0.00", "0.00"],
        ["2200", "1636.70", "1636.70", "0.00", "0.00"],
        ["2210", "444.66", "444.66", "0.00", "0.00"],
        ["2220", "54.80", "54.80", "0.00", "0.00"],
        ["2230", "197.28", "197.28", "0.00", "0.00"],
        ["2240", "0.00", "500.00", "500.00", "0.00"],
        ["2250", "8.50", "8.50", "0.00", "0.00"],
      ]);
      const journals = (code: string) => rec.accounts.find((account) => account.code === code)!.journals.map((journal) => [journal.reference, journal.kind, journal.amount]);
      expect(journals("6200")).toEqual([
        [PAYRUN(runs.one), "voided_pay_run", "4692.31"],
        [`VOID-${PAYRUN(runs.one)}`, "voided_pay_run", "-4692.31"],
        ["ACCRUAL-OCT", "other", "500.00"],
      ]);
      expect(journals("2240")).toEqual([
        [PAYRUN(runs.one), "voided_pay_run", "3699.50"],
        [`VOID-${PAYRUN(runs.one)}`, "voided_pay_run", "-3699.50"],
        ["ACCRUAL-OCT", "other", "500.00"],
      ]);
      expect(journals("2230")).toEqual([]);
      expect(rec.accounts.find((account) => account.code === "6200")!.journals[2].label).toBe("Manual journal ACCRUAL-OCT");
    });
  });

  describe("PAYE, KiwiSaver and student loan (PREP7) and IRD paid", () => {
    it("PREP7: October before and after IRD is paid, with each pay run's file", async () => {
      const before = (await report<IrdDeductionsReport>(ben, { report: "ird", ...OCT })).report;
      const october = before.months[0];
      expect(october.deducted).toEqual({
        taxableEarnings: "9072.31",
        paye: "1636.70",
        studentLoan: "197.28",
        kiwiSaverEmployee: "251.93",
        kiwiSaverEmployerNet: "192.73",
        kiwiSaver: "444.66",
        esct: "54.80",
        total: "2333.44",
      });
      expect(october.paid).toEqual({ paye: "0.00", studentLoan: "0.00", kiwiSaver: "0.00", esct: "0.00", total: "0.00" });
      expect(october.owing).toEqual({ paye: "1636.70", studentLoan: "197.28", kiwiSaver: "444.66", esct: "54.80", total: "2333.44" });
      expect(october.periods.map((period) => [period.start, period.end, period.dueDate])).toEqual([["2026-10-01", "2026-10-31", "2026-11-20"]]);
      expect(october.payRuns.map((run) => [run.reference, run.status, run.file])).toEqual([
        [PAYRUN(runs.one), "voided", "voided_after_file"],
        [PAYRUN(runs.two), "approved", "made"],
        [PAYRUN(runs.three), "approved", "made"],
        [PAYRUN(runs.four), "approved", "not_made"],
      ]);

      await asUser(ben, (tx) =>
        recordIrdPayment(tx, {
          idempotencyKey: key("ird"),
          periodStart: "2026-10-01",
          paymentDate: "2026-11-20",
          bankAccountCode: "1000",
          lines: [
            { liability: "paye", amount: "1636.70" },
            { liability: "student_loan", amount: "197.28" },
            { liability: "kiwisaver", amount: "444.66" },
            { liability: "esct", amount: "54.80" },
          ],
        }),
      );
      const after = (await report<IrdDeductionsReport>(ben, { report: "ird", from: "2026-10-01", to: "2026-11-30" })).report;
      expect(after.months.map((month) => [month.month, month.deducted.total, month.paid?.total, month.owing?.total])).toEqual([
        ["2026-10", "2333.44", "2333.44", "0.00"],
        ["2026-11", "0.00", "0.00", "0.00"],
      ]);
      expect(after.months[0].paid).toEqual({ paye: "1636.70", studentLoan: "197.28", kiwiSaver: "444.66", esct: "54.80", total: "2333.44" });

      const sione = (await report<IrdDeductionsReport>(ben, { report: "ird", ...OCT, employeeId: people.sione })).report;
      expect(sione.months[0].deducted).toMatchObject({ paye: "148.40", kiwiSaverEmployee: "35.20", kiwiSaverEmployerNet: "25.55", esct: "5.25", total: "214.40" });
      expect(sione.months[0].paid).toBeNull();
    });

    it("PREP4: across October and November the IRD payment counts on the IRD liabilities", async () => {
      const { report: rec } = await report<PayrollReconciliation>(ben, { report: "reconciliation", from: "2026-10-01", to: "2026-11-30" });
      expect(rec.accounts.filter((account) => ["2200", "2210", "2220", "2230"].includes(account.code)).map((account) => [account.code, account.payroll, account.ledger])).toEqual([
        ["2200", "0.00", "0.00"],
        ["2210", "0.00", "0.00"],
        ["2220", "0.00", "0.00"],
        ["2230", "0.00", "0.00"],
      ]);
      expect(rec.accounts.every((account) => account.unexplained === "0.00")).toBe(true);
    });
  });

  describe("earnings history (PREP6)", () => {
    it("PREP6: each pay with its stored lines and totals; voided pay runs listed", async () => {
      const { report: history } = await report<EarningsHistoryReport>(ben, { report: "earnings", ...OCT, employeeId: people.sione });
      expect(history.employees).toHaveLength(1);
      const sione = history.employees[0];
      expect(sione.name).toBe("Sione Fifita");
      expect(sione.pays.map((pay) => [pay.reference, pay.payDate, pay.periodStart, pay.periodEnd])).toEqual([[PAYRUN(runs.two), "2026-10-14", "2026-10-05", "2026-10-11"]]);
      expect(sione.pays[0].lines.map((line) => [line.name, line.category, line.quantity, line.rate, line.amount, line.description])).toEqual([
        ["Ordinary time", "earnings", "32.00", "22.50", "720.00", null],
        ["Overtime", "earnings", "4.00", "33.75", "135.00", null],
        ["Tool allowance", "earnings", null, null, "25.00", null],
        ["Reimbursement", "earnings", null, null, "42.60", "Fuel receipt"],
        ["Union fees", "deduction", null, null, "8.50", null],
      ]);
      expect(sione.totals).toEqual({
        gross: "922.60",
        taxableEarnings: "880.00",
        nonTaxableEarnings: "42.60",
        paye: "148.40",
        studentLoan: "0.00",
        kiwiSaverEmployee: "35.20",
        deductions: "8.50",
        netPay: "730.50",
        kiwiSaverEmployer: "30.80",
        esct: "5.25",
        kiwiSaverEmployerNet: "25.55",
        employerCost: "953.40",
      });

      const all = (await report<EarningsHistoryReport>(ben, { report: "earnings", ...OCT })).report;
      expect(all.employees.map((entry) => entry.name)).toEqual(["Aroha Ngata", "Hemi Walker", "Kiri Tane", "Sione Fifita"]);
      const hemi = all.employees.find((entry) => entry.employeeId === people.hemi)!;
      expect(hemi.pays.map((pay) => pay.reference)).toEqual([PAYRUN(runs.four)]);
      expect(hemi.totals).toMatchObject({ gross: "2692.31", paye: "555.58", kiwiSaverEmployee: "94.23", netPay: "2042.50", esct: "28.20", employerCost: "2786.54" });
      expect(hemi.voided.map((run) => run.reference)).toEqual([PAYRUN(runs.one)]);

      const overtime = (await report<EarningsHistoryReport>(ben, { report: "earnings", ...OCT, payItemId: items.Overtime.id })).report;
      expect(overtime.employees.map((entry) => [entry.name, entry.pays[0].lines.map((line) => line.amount), entry.totals.gross])).toEqual([["Sione Fifita", ["135.00"], "922.60"]]);
    });
  });

  describe("headcount and FTE (PREP5)", () => {
    it("PREP5: at a date, by Department, a different standard week, and by month", async () => {
      const at = (await report<HeadcountReport>(ben, { report: "headcount", date: "2026-10-14", from: "2026-10-01", to: "2026-10-31" })).report;
      expect(at.employees.map((entry) => [entry.name, entry.payBasis, entry.usualHours, entry.fte, entry.assumed])).toEqual([
        ["Aroha Ngata", "salary", null, "1.0000", true],
        ["Hemi Walker", "salary", null, "1.0000", true],
        ["Kiri Tane", "salary", null, "1.0000", true],
        ["Sione Fifita", "hourly", "32.00", "0.8000", false],
      ]);
      expect([at.headcount, at.fte]).toEqual([4, "3.8000"]);
      expect(at.departments.map((entry) => [entry.name, entry.headcount, entry.fte])).toEqual([
        ["Operations", 1, "1.2000"],
        ["Sales", 3, "2.6000"],
      ]);
      const shorter = (await report<HeadcountReport>(ben, { report: "headcount", date: "2026-10-14", standardWeek: "37.5" })).report;
      expect(shorter.employees.find((entry) => entry.employeeId === people.sione)!.fte).toBe("0.8533");
      expect(shorter.fte).toBe("3.8533");
      expect(shorter.standardWeek).toBe("37.50");

      await asUser(jess, (tx) => updateEmployee(tx, people.sione, { finishDate: "2026-11-15" }));
      people.tama = await employee({
        firstName: "Tama",
        lastName: "Rangi",
        payFrequency: "weekly",
        payBasis: "hourly",
        hourlyRate: "24.00",
        ordinaryHoursPerWeek: "20",
        startDate: "2026-11-02",
        payGroupId: groups.weekly,
      });
      await asUser(jess, (tx) => addAllocation(tx, people.tama, { idempotencyKey: key("allocation"), effectiveFrom: "2026-11-02", lines: [{ percentage: "100", departmentId: v.Operations }] }));
      const months = (await report<HeadcountReport>(ben, { report: "headcount", date: "2026-11-30", from: "2026-10-01", to: "2026-11-30" })).report;
      expect(months.months.map((month) => [month.month, month.headcount, month.fte, month.started, month.finished, month.paid])).toEqual([
        ["2026-10", 4, "3.8000", [], [], 4],
        ["2026-11", 4, "3.5000", ["Tama Rangi"], ["Sione Fifita"], 0],
      ]);
      const sales = (await report<HeadcountReport>(ben, { report: "headcount", date: "2026-10-14", departmentId: v.Sales })).report;
      expect(sales.employees.map((entry) => entry.name)).toEqual(["Aroha Ngata", "Hemi Walker", "Kiri Tane"]);
    });
  });

  describe("access, exports and refusals (PREP8)", () => {
    it("PREP8: payroll access and the bookkeeper role are needed for every report and export", async () => {
      for (const user of [noah, ana, vic]) {
        const refused = await report<LabourCostReport>(user, { report: "labour-cost", ...OCT });
        expect(refused.status).toBe(403);
        expect((await exportCsv(user, { report: "labour-cost", ...OCT })).status).toBe(403);
      }
      expect((await report<LabourCostReport>(noah, { report: "summary", ...OCT })).error).toContain("You need payroll access");
      expect((await report<LabourCostReport>(mere, { report: "labour-cost", ...OCT })).status).toBe(200);
    });

    it("PREP8: an export is a CSV, audited without figures, and posts nothing", async () => {
      const journals = await journalCount();
      const exported = await exportCsv(ben, { report: "labour-cost", ...OCT, groupBy: "department" });
      expect(exported.status).toBe(200);
      expect(exported.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(exported.headers.get("content-disposition")).toBe('attachment; filename="payroll-labour-cost-2026-10-01-to-2026-10-31.csv"');
      const lines = exported.text.split("\r\n");
      expect(lines[0]).toBe("Department,Ordinary time,Overtime,Tool allowance,KiwiSaver employer contribution,Labour cost");
      expect(lines.slice(1, 5)).toEqual([
        "Operations,1796.92,135.00,25.00,68.49,2025.41",
        "Sales,7115.39,,,179.04,7294.43",
        "Total,8912.31,135.00,25.00,247.53,9319.84",
        "Reimbursements (not labour cost),,,,,42.60",
      ]);
      expect(await journalCount()).toBe(journals);
      const events = (await auditEvents("payroll_report.exported")).rows;
      expect(events).toHaveLength(1);
      expect(events[0].details).toEqual({
        report: "labour-cost",
        from: "2026-10-01",
        to: "2026-10-31",
        filters: { groupBy: "department" },
        rows: 4,
        sha256: createHash("sha256").update(exported.text, "utf8").digest("hex"),
      });
      expect(JSON.stringify(events[0].details)).not.toMatch(/9319|Hemi|Sione/);

      for (const name of ["summary", "reconciliation", "headcount", "earnings", "ird"]) {
        const file = await exportCsv(ben, { report: name, ...OCT, date: "2026-10-14" });
        expect(file.status).toBe(200);
        expect(file.text.endsWith("\r\n")).toBe(true);
      }
      expect((await auditEvents("payroll_report.exported")).rows).toHaveLength(6);
    });

    it("PREP8: refused with a reason", async () => {
      expect((await report(ben, { report: "labour-cost", from: "2026-10-31", to: "2026-10-01" })).error).toBe("The start date must be on or before the end date.");
      expect((await report(ben, { report: "labour-cost", from: "2020-01-01", to: "2026-10-01" })).error).toBe("Choose 5 years or less.");
      expect((await report(ben, { report: "headcount", date: "2026-10-14", standardWeek: "0" })).error).toBe("Standard week must not be zero.");
      expect((await report(ben, { report: "headcount", date: "2026-10-14", standardWeek: "200" })).error).toBe("Standard week can't be more than 168 hours.");
      expect((await report(ben, { report: "leave", ...OCT })).status).toBe(400);
      expect((await report(ben, { report: "labour-cost", ...OCT, departmentId: "999999" })).status).toBe(404);
      expect((await report(ben, { report: "labour-cost", ...OCT, payItemId: "not-a-uuid" })).status).toBe(400);
    });
  });

  describe("labour cost from timesheet shares (PREP2)", () => {
    it("PREP2: Kea Sensors' TS5 pay run by R&D activity, Department and project", async () => {
      await createTestOrganisation(jess, KEA);
      const as = <T>(work: (tx: OrgTx) => Promise<T>) => asUser(jess, work, KEA);
      await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
      const department = (await as((tx) => getTrackingSetup(tx))).categories.find((category) => category.kind === "department")!.id;
      const operations = (await as((tx) => createTrackingValue(tx, { categoryId: department, name: "Operations" })))
        .categories.find((category) => category.id === department)!
        .values.find((value) => value.name === "Operations")!.id;
      const c1 = (
        await as((tx) =>
          createActivity(tx, {
            idempotencyKey: key("activity"),
            projectName: "Low-power soil sensor",
            firstIncomeYear: 2027,
            code: "C1",
            name: "Prototype and field-test a low-power soil-moisture sensor",
            kind: "core",
            place: "nz",
          }),
        )
      ).activity;
      await as((tx) =>
        createApproval(tx, {
          idempotencyKey: key("approval"),
          kind: "general",
          reference: "RDGA-12345",
          letterDate: todayIsoDate(),
          firstIncomeYear: "2027",
          lastIncomeYear: "2029",
          activityIds: c1.id,
          note: undefined,
          letter: { fileName: "IRD letter.pdf", content: new Uint8Array(Buffer.from("%PDF-1.7\n%âãÏÓ\n" + "A".repeat(300), "latin1")) },
        }),
      );
      const customer = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Taieri Growers Ltd", isCustomer: true }))).contact;
      const taieri = (await as((tx) => createProject(tx, { idempotencyKey: key("project"), name: "Taieri soil survey", contactId: customer.id }))).project;
      const group = (await as((tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Fortnightly salaries", payFrequency: "fortnightly" }))).group.id;
      const staff = async (firstName: string, lastName: string, extra: Record<string, unknown>) =>
        (
          await as((tx) =>
            createEmployee(tx, {
              idempotencyKey: key("employee"),
              firstName,
              lastName,
              taxCode: "M",
              irdNumber: "123456789",
              kiwiSaverStatus: "not_enrolled",
              kiwiSaverEmployeeRate: "3.5",
              kiwiSaverEmployerRate: "3.5",
              studentLoan: false,
              payBasis: "salary",
              payFrequency: "fortnightly",
              startDate: "2026-04-01",
              bankAccount: "03-1234-0123456-00",
              payGroupId: group,
              ...extra,
            }),
          )
        ).employee.id;
      const hana = await staff("Hana", "Rewi", { annualSalary: "62400.00", kiwiSaverStatus: "enrolled", esctRate: "30" });
      const benTait = await staff("Ben", "Tait", { annualSalary: "52000.00" });
      await as((tx) => addAllocation(tx, hana, { idempotencyKey: key("a"), effectiveFrom: "2026-04-01", lines: [{ percentage: "100", rdActivityId: c1.id }] }));
      await as((tx) =>
        addAllocation(tx, benTait, {
          idempotencyKey: key("a"),
          effectiveFrom: "2026-04-01",
          lines: [
            { percentage: "60", rdActivityId: c1.id },
            { percentage: "40", departmentId: operations },
          ],
        }),
      );
      const day = (weekStart: string, hours: Array<number | null>) =>
        Object.fromEntries(
          hours.flatMap((value, index) =>
            value === null ? [] : [[new Date(Date.parse(`${weekStart}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10), String(value)]],
          ),
        );
      const week = async (weekStart: string, rows: unknown[]) => {
        const sheet = (await as((tx) => openTimesheet(tx, "owner", { idempotencyKey: key("sheet"), employeeId: benTait, weekStart }))).timesheet;
        const saved = (await as((tx) => saveTimesheetEntries(tx, "owner", sheet.id, { version: sheet.version, rows }))).timesheet;
        await as((tx) => submitTimesheet(tx, "owner", saved.id));
        await as((tx) => approveTimesheet(tx, "owner", saved.id));
      };
      await week("2026-07-06", [
        { rdActivityId: c1.id, hours: day("2026-07-06", [8, 8, 4]) },
        { departmentId: operations, hours: day("2026-07-06", [null, null, 4, 8, 8]) },
      ]);
      await week("2026-07-13", [
        { rdActivityId: c1.id, hours: day("2026-07-13", [8, 8]) },
        { departmentId: operations, hours: day("2026-07-13", [null, null, 8, 4]) },
        { projectId: taieri.id, hours: day("2026-07-13", [null, null, null, 4, 8]) },
      ]);
      const draft = (await as((tx) => createPayRun(tx, { idempotencyKey: key("payrun"), payGroupId: group, periodStart: "2026-07-06", payDate: "2026-07-22" }))).payRun;
      await as((tx) => approvePayRun(tx, draft.id, { idempotencyKey: key("approve") }));

      const JUL = { from: "2026-07-01", to: "2026-07-31" };
      const by = async (groupBy: string, extra: Record<string, string> = {}) =>
        (await report<LabourCostReport>(jess, { report: "labour-cost", ...JUL, groupBy, ...extra }, KEA)).report;
      const rd = await by("rd_activity");
      const names = Object.fromEntries(rd.payItems.map((item) => [item.id, item.name]));
      expect(rd.groups.map((group) => [group.label, Object.fromEntries(Object.entries(group.amounts).map(([id, amount]) => [names[id], amount])), group.total])).toEqual([
        ["C1 Prototype and field-test a low-power soil-moisture sensor", { "Ordinary time": "3300.00", "KiwiSaver employer contribution": "84.00" }, "3384.00"],
        ["No R&D activity", { "Ordinary time": "1100.00" }, "1100.00"],
      ]);
      expect(rd.total).toBe("4484.00");
      expect((await by("department")).groups.map((group) => [group.label, group.total])).toEqual([
        ["Operations", "800.00"],
        ["No Department", "3684.00"],
      ]);
      expect((await by("project")).groups.map((group) => [group.label, group.total])).toEqual([
        ["Taieri soil survey", "300.00"],
        ["No project", "4184.00"],
      ]);
      expect((await by("employee", { rdActivityId: c1.id, employeeId: benTait })).total).toBe("900.00");
    });
  });
});

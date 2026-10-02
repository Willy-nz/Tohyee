import { afterAll, beforeAll, expect, it } from "vitest";
import { createAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { setPayrollAccess } from "@/lib/payroll/access";
import { addAllocation } from "@/lib/payroll/allocations";
import { createEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import { type LeaveLiabilityPosting, leaveLiabilityReminders, postLeaveLiability } from "@/lib/payroll/leave-liability";
import { kiwiSaverOnLiability, leaveLiabilityReport } from "@/lib/payroll/leave-reports";
import { addLeaveSettings, updateOrganisationLeaveSettings } from "@/lib/payroll/leave-settings";
import { updatePayrollSettings } from "@/lib/payroll/pay-items";
import { approvePayRun, createPayRun } from "@/lib/payroll/pay-runs";
import { createTrackingValue, getTrackingSetup } from "@/lib/tracking/service";
import * as remindersRoute from "@/app/api/payroll/leave/liability/reminders/route";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "payroll-leave-liability-ks-co";

/**
 * Examples HL58-HL61 in docs/ACCOUNTING-EXAMPLES.md (decisions 189-191):
 * Tama starts Mon 28 Sep 2026, hourly at 30.50 for 8 hours Monday to
 * Friday, 100% to Office, enrolled in KiwiSaver at 3.5% employer; his last
 * day is Fri 16 Oct 2026, paid in the 12-18 Oct pay run (pay date 21 Oct).
 */
describeWithDatabase("Leave liability: finished employees, employer KiwiSaver and the reminder (HL58-HL61)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let wiremu: SessionUser;
  let rangi: SessionUser;
  let vic: SessionUser;
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  let group = "";
  let office = "";
  let departmentCategory = "";
  let tama = "";
  let finalPayRun = "";
  const postings: Record<string, LeaveLiabilityPosting> = {};

  const asJess = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: jess.id, email: jess.email }, work);
  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const fixedWeek = { kind: "fixed", days: Array.from({ length: 7 }, (_, index) => ({ ordinaryHours: index < 5 ? "8" : "0", extras: [] })) };
  const journalLines = async (journalId: string) =>
    (await asJess((tx) => getJournal(tx, journalId))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount, line.description, line.tracking]);
  const officeTag = () => ({ [departmentCategory]: office });
  const reminderRoute = async (user: SessionUser) => {
    const response = await remindersRoute.GET(apiRequest(`/api/payroll/leave/liability/reminders?organisationId=${ORG}`, { cookie: await sessionCookieFor(user) }), undefined as never);
    return { status: response.status, body: (await response.json()) as { reminders?: unknown[] } };
  };

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    jess = await createTestUser("jess@payrollliabilityks.test");
    wiremu = await createTestUser("wiremu@payrollliabilityks.test");
    rangi = await createTestUser("rangi@payrollliabilityks.test");
    vic = await createTestUser("vic@payrollliabilityks.test");
    await createTestOrganisation(jess, ORG);
    for (const [user, role] of [
      [wiremu, "bookkeeper"],
      [rangi, "bookkeeper"],
      [vic, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, user.id, role]);
    }
    // Rangi is a bookkeeper with payroll access; Wiremu is a bookkeeper without.
    await asJess((tx) =>
      setPayrollAccess(tx, [{ userId: rangi.id, email: rangi.email, displayName: "Rangi", role: "bookkeeper", isActive: true }], { userId: rangi.id, hasPayrollAccess: true }),
    );
    await asJess((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    departmentCategory = (await asJess((tx) => getTrackingSetup(tx))).categories.find((category) => category.kind === "department")!.id;
    const setup = await asJess((tx) => createTrackingValue(tx, { categoryId: departmentCategory, name: "Office" }));
    office = setup.categories.find((category) => category.id === departmentCategory)!.values.find((value) => value.name === "Office")!.id;
    await asJess((tx) => createAccount(tx, { code: "6220", name: "Leave expense", accountType: "expense" }));
    await asJess((tx) => createAccount(tx, { code: "2260", name: "Employee entitlements", accountType: "current_liability" }));
    await asJess((tx) => updatePayrollSettings(tx, { leaveExpenseAccountCode: "6220", leaveLiabilityAccountCode: "2260" }));
    await asJess((tx) => updateOrganisationLeaveSettings(tx, { anniversaryRegion: "otago" }));
    group = (await asJess((tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Weekly", payFrequency: "weekly" }))).group.id;
    tama = (
      await asJess((tx) =>
        createEmployee(tx, {
          idempotencyKey: key("employee"),
          firstName: "Tama",
          lastName: "Liability",
          taxCode: "M",
          irdNumber: "123456789",
          kiwiSaverStatus: "enrolled",
          kiwiSaverEmployeeRate: "3.5",
          kiwiSaverEmployerRate: "3.5",
          esctRate: "17.5",
          studentLoan: false,
          payBasis: "hourly",
          hourlyRate: "30.50",
          ordinaryHoursPerWeek: "40",
          payFrequency: "weekly",
          bankAccount: "03-1234-0123456-00",
          startDate: "2026-09-28",
          payGroupId: group,
        }),
      )
    ).employee.id;
    await asJess((tx) => addAllocation(tx, tama, { idempotencyKey: key("allocation"), effectiveFrom: "2026-09-28", lines: [{ percentage: "100", departmentId: office }] }));
    await asJess((tx) => addLeaveSettings(tx, tama, { idempotencyKey: key("settings"), pattern: fixedWeek, annualPaidInPeriod: true }));
    for (const [periodStart, payDate] of [
      ["2026-09-28", "2026-10-07"],
      ["2026-10-05", "2026-10-14"],
    ]) {
      const run = (await asJess((tx) => createPayRun(tx, { idempotencyKey: key("run"), payGroupId: group, periodStart, payDate }))).payRun;
      await asJess((tx) => approvePayRun(tx, run.id, { idempotencyKey: key("approve") }));
    }
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  it("decision 190: employer KiwiSaver is truncated to cents, like each pay's contribution", () => {
    expect(kiwiSaverOnLiability("195.20", "3.5")).toBe("6.83");
    expect(kiwiSaverOnLiability("292.80", "3.50")).toBe("10.24");
    expect(kiwiSaverOnLiability("0.00", "3.5")).toBe("0.00");
  });

  it("HL61: before any posting, no reminder on 15 Oct (30 Sep has no pay run); one for 31 Oct on 1 Nov; never without payroll access", async () => {
    expect(await asJess((tx) => leaveLiabilityReminders(tx, "2026-10-15"))).toEqual([]);
    expect(await as(rangi, (tx) => leaveLiabilityReminders(tx, "2026-11-01"))).toEqual([
      { monthEnd: "2026-10-31", lastPosting: null, text: "Post the leave liability at 31 Oct 2026: pay runs have been approved since nothing was posted" },
    ]);
    expect(await as(wiremu, (tx) => leaveLiabilityReminders(tx, "2026-11-01"))).toEqual([]);
    expect((await reminderRoute(wiremu)).body).toEqual({ reminders: [] });
    expect((await reminderRoute(vic)).status).toBe(403);
  });

  it("HL59: at Sun 11 Oct, running 8% 195.20 and employer KiwiSaver 6.83, posted as two line pairs (Office)", async () => {
    const liability = await asJess((tx) => leaveLiabilityReport(tx, { asAt: "2026-10-11" }));
    expect(liability.rows.map((row) => [row.name, row.annualValue, row.runningEightPercent, row.alternativeValue, row.total, row.kiwiSaverRate, row.kiwiSaver])).toEqual([
      ["Tama Liability", "0.00", "195.20", "0.00", "195.20", "3.50", "6.83"],
    ]);
    expect([liability.totals.total, liability.totals.kiwiSaver, liability.totals.withKiwiSaver]).toEqual(["195.20", "6.83", "202.03"]);
    postings.first = (await asJess((tx) => postLeaveLiability(tx, { idempotencyKey: key("post"), asAt: "2026-10-11" }))).posting;
    expect(postings.first).toMatchObject({ reference: "LEAVELIAB-1", liability: "195.20", kiwiSaver: "6.83", total: "202.03", change: "202.03" });
    expect(postings.first.departments).toEqual([{ departmentId: office, department: "Office", liability: "195.20", kiwiSaver: "6.83" }]);
    expect(await journalLines(postings.first.journalId)).toEqual([
      ["6220", "195.20", "0.00", "Leave expense", officeTag()],
      ["2260", "0.00", "195.20", "Employee entitlements", officeTag()],
      ["6220", "6.83", "0.00", "Employer KiwiSaver on leave", officeTag()],
      ["2260", "0.00", "6.83", "Employer KiwiSaver on leave", officeTag()],
    ]);
  });

  it("HL58: Tama finished on Fri 16 Oct with no final pay approved: a problem, and posting is refused naming him", async () => {
    await asJess((tx) => tx.query("update payroll_employees set finish_date = '2026-10-16' where id = $1", [tama]));
    finalPayRun = (await asJess((tx) => createPayRun(tx, { idempotencyKey: key("run"), payGroupId: group, periodStart: "2026-10-12", payDate: "2026-10-21" }))).payRun.id;
    const liability = await asJess((tx) => leaveLiabilityReport(tx, { asAt: "2026-10-18" }));
    expect(liability.rows.map((row) => [row.name, row.finishDate, row.finalPayDate, row.total, row.problem])).toEqual([
      [
        "Tama Liability",
        "2026-10-16",
        null,
        "0.00",
        "Tama Liability finished on 16 Oct 2026 and their final pay isn't approved yet. Approve the pay run that includes 16 Oct 2026 (their final pay) first.",
      ],
    ]);
    await expect(asJess((tx) => postLeaveLiability(tx, { idempotencyKey: key("post"), asAt: "2026-10-18" }))).rejects.toThrow(
      "The leave liability at 18 Oct 2026 can't be posted while the liability report has problems: Tama Liability: Tama Liability finished on 16 Oct 2026",
    );
  });

  it("HL60: with the final pay approved, 292.80 holiday pay on finishing and 10.24 KiwiSaver at 18 Oct; out at 21 Oct", async () => {
    await asJess((tx) => approvePayRun(tx, finalPayRun, { idempotencyKey: key("approve") }));
    const liability = await asJess((tx) => leaveLiabilityReport(tx, { asAt: "2026-10-18" }));
    expect(liability.rows.map((row) => [row.finishDate, row.finalPayDate, row.holidayPayOnFinishing, row.total, row.kiwiSaver, row.problem])).toEqual([
      ["2026-10-16", "2026-10-21", "292.80", "292.80", "10.24", null],
    ]);
    postings.second = (await asJess((tx) => postLeaveLiability(tx, { idempotencyKey: key("post"), asAt: "2026-10-18" }))).posting;
    expect(postings.second).toMatchObject({ reference: "LEAVELIAB-2", liability: "292.80", kiwiSaver: "10.24", total: "303.04", change: "101.01", previousReference: "LEAVELIAB-1" });
    expect(await journalLines(postings.second.journalId)).toEqual([
      ["6220", "97.60", "0.00", "Leave expense", officeTag()],
      ["2260", "0.00", "97.60", "Employee entitlements", officeTag()],
      ["6220", "3.41", "0.00", "Employer KiwiSaver on leave", officeTag()],
      ["2260", "0.00", "3.41", "Employer KiwiSaver on leave", officeTag()],
    ]);
    // Paid on Wed 21 Oct: he drops out.
    expect((await asJess((tx) => leaveLiabilityReport(tx, { asAt: "2026-10-21" }))).rows).toEqual([]);
    postings.third = (await asJess((tx) => postLeaveLiability(tx, { idempotencyKey: key("post"), asAt: "2026-10-21" }))).posting;
    expect(postings.third).toMatchObject({ reference: "LEAVELIAB-3", liability: "0.00", kiwiSaver: "0.00", total: "0.00", change: "-303.04", departments: [] });
    expect(await journalLines(postings.third.journalId)).toEqual([
      ["2260", "292.80", "0.00", "Employee entitlements", officeTag()],
      ["6220", "0.00", "292.80", "Leave expense", officeTag()],
      ["2260", "10.24", "0.00", "Employer KiwiSaver on leave", officeTag()],
      ["6220", "0.00", "10.24", "Employer KiwiSaver on leave", officeTag()],
    ]);
    const balance = await asJess((tx) =>
      tx.query<{ total: string }>(
        `select coalesce(sum(l.credit_amount - l.debit_amount), 0)::text as total from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = '2260'`,
      ),
    );
    expect(Number(balance.rows[0].total)).toBe(0);
  });

  it("HL61: after LEAVELIAB-3 at 21 Oct, no reminder on 1 Nov (no pay run since)", async () => {
    expect(await as(rangi, (tx) => leaveLiabilityReminders(tx, "2026-11-01"))).toEqual([]);
    expect((await reminderRoute(rangi)).status).toBe(200);
  });
});

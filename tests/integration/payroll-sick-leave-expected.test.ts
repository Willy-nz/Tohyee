import { afterAll, beforeAll, expect, it } from "vitest";
import { createAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getJournal } from "@/lib/ledger/journals";
import { createEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import { addDays } from "@/lib/payroll/leave/dates";
import { postLeaveLiability } from "@/lib/payroll/leave-liability";
import { saveOpeningBalances } from "@/lib/payroll/leave-opening";
import { createLeaveBooking } from "@/lib/payroll/leave-records";
import { exportLeaveLiability, leaveLiabilityReport } from "@/lib/payroll/leave-reports";
import { addLeaveSettings, updateOrganisationLeaveSettings } from "@/lib/payroll/leave-settings";
import { updatePayrollSettings } from "@/lib/payroll/pay-items";
import { approvePayRun, createPayRun } from "@/lib/payroll/pay-runs";
import { listSickLeaveExpectations, setSickLeaveExpectation } from "@/lib/payroll/sick-leave-expectations";
import * as route from "@/app/api/payroll/leave/liability/sick-expectations/route";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "payroll-sick-expected-co";

/**
 * Example HL62 in docs/ACCOUNTING-EXAMPLES.md (decision 564; #310 item 4):
 * Hemi from HL43 (opening balances at Sun 4 Oct 2026 with 14 days' sick
 * leave; OWP 1,200.00 over 5 days) and his first pay run, 5-11 Oct 2026.
 */
describeWithDatabase("Expected sick leave in the leave liability (HL62)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let wiremu: SessionUser;
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  let group = "";
  let hemi = "";

  const asJess = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: jess.id, email: jess.email }, work);
  const report = { fileName: "previous-payroll-leave-report.pdf", content: new TextEncoder().encode("%PDF-1.4\nleave and earnings at 4 Oct 2026\n%%EOF") };
  const fixedWeek = { kind: "fixed", days: Array.from({ length: 7 }, (_, index) => ({ ordinaryHours: index < 5 ? "8" : "0", extras: [] })) };
  const rows = (from: string, to: string) => {
    const result: Array<Record<string, unknown>> = [];
    for (let monday = from; monday <= to; monday = addDays(monday, 7)) {
      const gross = monday === "2025-10-27" ? "1320.00" : monday === "2025-12-15" ? "2200.00" : "1200.00";
      result.push({ periodStart: monday, periodEnd: addDays(monday, 6), gross, irregular: monday === "2025-12-15" ? "1000.00" : "0", days: 5 });
    }
    return result;
  };
  const payWeek = async (periodStart: string) => {
    const run = (await asJess((tx) => createPayRun(tx, { idempotencyKey: key("run"), payGroupId: group, periodStart, payDate: addDays(periodStart, 9) }))).payRun;
    await asJess((tx) => approvePayRun(tx, run.id, { idempotencyKey: key("approve") }));
  };
  const expect_ = (command: { effectiveFrom: string; days: string; reason?: string }) => asJess((tx) => setSickLeaveExpectation(tx, { idempotencyKey: key("sick"), employeeId: hemi, ...command }));
  const hemiRow = async (asAt: string) => (await asJess((tx) => leaveLiabilityReport(tx, { asAt }))).rows.find((row) => row.employeeId === hemi)!;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    jess = await createTestUser("jess@payrollsick.test");
    wiremu = await createTestUser("wiremu@payrollsick.test");
    await createTestOrganisation(jess, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, wiremu.id]);
    await asJess((tx) => createAccount(tx, { code: "6220", name: "Leave expense", accountType: "expense" }));
    await asJess((tx) => createAccount(tx, { code: "2260", name: "Employee entitlements", accountType: "current_liability" }));
    await asJess((tx) => updatePayrollSettings(tx, { leaveExpenseAccountCode: "6220", leaveLiabilityAccountCode: "2260" }));
    await asJess((tx) => updateOrganisationLeaveSettings(tx, { anniversaryRegion: "otago" }));
    group = (await asJess((tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Weekly", payFrequency: "weekly" }))).group.id;
    hemi = (
      await asJess((tx) =>
        createEmployee(tx, {
          idempotencyKey: key("employee"),
          firstName: "Hemi",
          lastName: "Sick",
          taxCode: "M",
          irdNumber: "123456789",
          kiwiSaverStatus: "not_enrolled",
          kiwiSaverEmployeeRate: "3.5",
          kiwiSaverEmployerRate: "3.5",
          studentLoan: false,
          payBasis: "hourly",
          hourlyRate: "30",
          ordinaryHoursPerWeek: "40",
          payFrequency: "weekly",
          bankAccount: "03-1234-0123456-00",
          startDate: "2024-03-04",
          payGroupId: group,
        }),
      )
    ).employee.id;
    await asJess((tx) => addLeaveSettings(tx, hemi, { idempotencyKey: key("settings"), pattern: fixedWeek, annualPaidInPeriod: true }));
    await asJess((tx) =>
      saveOpeningBalances(tx, {
        idempotencyKey: key("opening"),
        employeeId: hemi,
        asAt: "2026-10-04",
        annualWeeks: "2.5",
        annualLastEntitled: "2026-03-04",
        annualCashedUpWeeks: "0.5",
        sickDays: "14",
        familyViolenceDays: "10",
        alternativeHolidays: ["2025-10-27"],
        earnings: rows("2025-10-06", "2026-09-28"),
        source: "Previous payroll's leave and earnings reports at 4 Oct 2026",
        report,
      }),
    );
    await payWeek("2026-10-05");
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  it("HL62: without an assessment, carried-over sick leave isn't in it", async () => {
    const row = await hemiRow("2026-10-11");
    expect([row.sickExpected, row.sickDays, row.sickValue, row.total]).toEqual([null, "0.00", "0.00", "6327.45"]);
  });

  it("HL62: refused for more days than he has, without a reason, or without payroll access", async () => {
    await expect(expect_({ effectiveFrom: "2026-10-11", days: "14.5", reason: "Past years" })).rejects.toThrow(
      "Hemi Sick has 14 days' sick leave at 11 Oct 2026, so at most that many can be expected to be used from it.",
    );
    await expect(expect_({ effectiveFrom: "2026-10-11", days: "2" })).rejects.toThrow("Say why these days are expected");
    await expect(expect_({ effectiveFrom: "2026-10-11", days: "-1", reason: "x" })).rejects.toThrow("can't be negative");
    const response = await route.POST(
      apiRequest("/api/payroll/leave/liability/sick-expectations", {
        method: "POST",
        cookie: await sessionCookieFor(wiremu),
        body: { organisationId: ORG, idempotencyKey: key("sick"), employeeId: hemi, effectiveFrom: "2026-10-11", days: "2", reason: "x" },
      }),
      undefined as never,
    );
    expect(response.status).toBe(403);
  });

  it("HL62: 2 days expected from 5 Oct at 240.00 a day add 480.00, and are posted with the rest", async () => {
    const saved = await expect_({ effectiveFrom: "2026-10-05", days: "2", reason: "Took 12 days in each of the last two years" });
    expect(saved.expectation).toMatchObject({ effectiveFrom: "2026-10-05", days: "2.00", createdByEmail: jess.email });
    const row = await hemiRow("2026-10-11");
    expect([row.sickExpected, row.sickDays, row.sickValue, row.total]).toEqual([
      { days: "2.00", effectiveFrom: "2026-10-05", reason: "Took 12 days in each of the last two years" },
      "2.00",
      "480.00",
      "6807.45",
    ]);
    const liability = await asJess((tx) => leaveLiabilityReport(tx, { asAt: "2026-10-11" }));
    expect([liability.totals.sickValue, liability.totals.total]).toEqual(["480.00", "6807.45"]);
    // Before the assessment's date it isn't in.
    expect((await hemiRow("2026-10-04")).sickValue).toBe("0.00");
    const csv = (await asJess((tx) => exportLeaveLiability(tx, { asAt: "2026-10-11" }))).csv;
    expect(csv.split("\n")[0]).toContain("Expected sick days,Expected sick leave value");
    const { posting } = await asJess((tx) => postLeaveLiability(tx, { idempotencyKey: key("post"), asAt: "2026-10-11" }));
    expect(posting).toMatchObject({ reference: "LEAVELIAB-1", liability: "6807.45", change: "6807.45" });
    const journal = await asJess((tx) => getJournal(tx, posting.journalId));
    expect(journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["6220", "6807.45", "0.00"],
      ["2260", "0.00", "6807.45"],
    ]);
  });

  it("HL62: never more than the sick leave he has at the date; 0 days takes it out", async () => {
    await expect_({ effectiveFrom: "2026-10-12", days: "14", reason: "Surgery booked for November" });
    await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: hemi, leaveType: "sick", startDate: "2026-10-14" }));
    await payWeek("2026-10-12");
    const row = await hemiRow("2026-10-18");
    expect([row.sickExpected?.days, row.sickDays, row.sickValue]).toEqual(["14.00", "13.00", "3120.00"]);
    await expect_({ effectiveFrom: "2026-10-19", days: "0" });
    expect((await hemiRow("2026-10-19")).sickExpected).toBeNull();
    // The earlier dates still show what was assessed then.
    expect((await hemiRow("2026-10-11")).sickValue).toBe("480.00");
    expect((await asJess((tx) => listSickLeaveExpectations(tx, hemi))).map((entry) => [entry.effectiveFrom, entry.days])).toEqual([
      ["2026-10-19", "0.00"],
      ["2026-10-12", "14.00"],
      ["2026-10-05", "2.00"],
    ]);
  });
});

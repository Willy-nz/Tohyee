import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { createEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import { getPayrollSettings, updatePayrollSettings } from "@/lib/payroll/pay-items";
import { listTimesheetWeek, openTimesheet } from "@/lib/payroll/timesheets";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "payroll-week-settings-co";

/** Example TS12 in docs/ACCOUNTING-EXAMPLES.md (decision 192): timesheet weeks starting on Sunday. */
describeWithDatabase("Timesheet weeks starting on another day (TS12)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let ana = "";
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const asJess = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: jess.id, email: jess.email }, work);

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    jess = await createTestUser("jess@payrollweeks.test");
    await createTestOrganisation(jess, ORG);
    const group = (await asJess((tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Weekly", payFrequency: "weekly" }))).group.id;
    ana = (
      await asJess((tx) =>
        createEmployee(tx, {
          idempotencyKey: key("employee"),
          firstName: "Ana",
          lastName: "Weeks",
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
          startDate: "2026-09-01",
          payGroupId: group,
        }),
      )
    ).employee.id;
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  it("TS12: Monday by default; Sunday once saved; refused to change once there are timesheets", async () => {
    expect((await asJess((tx) => getPayrollSettings(tx))).timesheetFirstDay).toBe(1);
    await expect(asJess((tx) => updatePayrollSettings(tx, { timesheetFirstDay: 8 }))).rejects.toThrow(
      "The first day of the timesheet week is 1 (Monday) to 7 (Sunday).",
    );
    await asJess((tx) => updatePayrollSettings(tx, { timesheetFirstDay: 7 }));
    // Any date opens the week it's in.
    const week = await asJess((tx) => listTimesheetWeek(tx, "owner", "2026-10-07"));
    expect([week.weekStart, week.firstDay]).toEqual(["2026-10-04", 7]);
    await expect(asJess((tx) => openTimesheet(tx, "owner", { idempotencyKey: key("sheet"), employeeId: ana, weekStart: "2026-10-05" }))).rejects.toThrow(
      "A timesheet week starts on a Sunday.",
    );
    const sheet = (await asJess((tx) => openTimesheet(tx, "owner", { idempotencyKey: key("sheet"), employeeId: ana, weekStart: "2026-10-04" }))).timesheet;
    expect([sheet.weekStart, sheet.weekEnd]).toEqual(["2026-10-04", "2026-10-10"]);
    await expect(asJess((tx) => updatePayrollSettings(tx, { timesheetFirstDay: 1 }))).rejects.toThrow(
      "Timesheets already start on a Sunday, so the first day of the week can't change",
    );
    // The database refuses it too.
    await expect(asJess((tx) => tx.query("update organisation_settings set payroll_timesheet_first_day = 1 where id = true"))).rejects.toThrow(
      "The first day of the timesheet week can't change once there are timesheets",
    );
    await expect(
      asJess((tx) => tx.query("insert into payroll_timesheets (idempotency_key, request_hash, employee_id, week_start, created_by_email) values ('x', 'x', $1, '2026-10-12', 'x')", [ana])),
    ).rejects.toThrow("A timesheet week starts on the organisation's first day of the week");
  });
});

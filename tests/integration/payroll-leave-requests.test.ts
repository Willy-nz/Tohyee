import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { Role } from "@/lib/auth/roles";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { createEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import { addDays } from "@/lib/payroll/leave/dates";
import { saveOpeningBalances } from "@/lib/payroll/leave-opening";
import { getLeaveBooking } from "@/lib/payroll/leave-records";
import {
  approveLeaveRequest,
  createLeaveRequest,
  getLeaveRequest,
  listLeaveRequests,
  rejectLeaveRequest,
  updateLeaveRequest,
  withdrawLeaveRequest,
} from "@/lib/payroll/leave-requests";
import { addLeaveSettings, updateOrganisationLeaveSettings } from "@/lib/payroll/leave-settings";
import { approvePayRun, createPayRun, type PayRun } from "@/lib/payroll/pay-runs";
import { setTimesheetPeople } from "@/lib/payroll/timesheets";
import * as approveRoute from "@/app/api/payroll/leave/requests/[requestId]/approve/route";
import * as requestsRoute from "@/app/api/payroll/leave/requests/route";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "payroll-leave-requests-co";

/**
 * Examples HL49-HL51 in docs/ACCOUNTING-EXAMPLES.md (employees' own leave
 * requests, decision 169). Aroha (paid 1,200.00 a week, Monday to Friday,
 * 8 hours a day) has a viewer login linked to her employee record; Wiremu,
 * a bookkeeper without payroll access, approves her timesheets and leave;
 * Vic is another viewer. Tohyee keeps Aroha's leave from opening balances
 * as at Sun 31 Jan 2027 (decision 168).
 */
describeWithDatabase("Employees' own leave requests (HL49-HL51)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let aroha: SessionUser;
  let wiremu: SessionUser;
  let vic: SessionUser;
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const roles = new Map<string, Role>();
  let group = "";
  let arohaId = "";

  const as = <T>(user: SessionUser, work: (tx: OrgTx, role: Role) => Promise<T>) =>
    inOrganisation(ORG, { userId: user.id, email: user.email }, (tx) => work(tx, roles.get(user.id)!));
  const draft = (periodStart: string) =>
    as(jess, (tx) => createPayRun(tx, { idempotencyKey: key("run"), payGroupId: group, periodStart, payDate: addDays(periodStart, 9) })).then((result) => result.payRun);
  const approveRun = (runId: string) => as(jess, (tx) => approvePayRun(tx, runId, { idempotencyKey: key("approve") })).then((result) => result.payRun);
  const ask = (user: SessionUser, input: Record<string, unknown>) => as(user, (tx, role) => createLeaveRequest(tx, role, { idempotencyKey: key("request"), employeeId: arohaId, ...input }));

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    jess = await createTestUser("jess@payrollrequests.test");
    aroha = await createTestUser("aroha@payrollrequests.test");
    wiremu = await createTestUser("wiremu@payrollrequests.test");
    vic = await createTestUser("vic@payrollrequests.test");
    await createTestOrganisation(jess, ORG);
    for (const [user, role] of [
      [aroha, "viewer"],
      [wiremu, "bookkeeper"],
      [vic, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, user.id, role]);
    }
    roles.set(jess.id, "owner").set(aroha.id, "viewer").set(wiremu.id, "bookkeeper").set(vic.id, "viewer");
    await as(jess, (tx) => updateOrganisationLeaveSettings(tx, { anniversaryRegion: "wellington" }));
    group = (await as(jess, (tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Weekly", payFrequency: "weekly" }))).group.id;
    arohaId = (
      await as(jess, (tx) =>
        createEmployee(tx, {
          idempotencyKey: key("employee"),
          firstName: "Aroha",
          lastName: "Requests",
          taxCode: "M",
          irdNumber: "123456789",
          kiwiSaverStatus: "not_enrolled",
          kiwiSaverEmployeeRate: "3.5",
          kiwiSaverEmployerRate: "3.5",
          studentLoan: false,
          payBasis: "salary",
          annualSalary: "62400",
          payFrequency: "weekly",
          bankAccount: "03-1234-0123456-00",
          startDate: "2025-04-01",
          payGroupId: group,
        }),
      )
    ).employee.id;
    await as(jess, (tx) =>
      addLeaveSettings(tx, arohaId, {
        idempotencyKey: key("settings"),
        pattern: { kind: "fixed", days: Array.from({ length: 7 }, (_, index) => ({ ordinaryHours: index < 5 ? "8" : "0", extras: [] })) },
        annualPaidInPeriod: true,
      }),
    );
    await as(jess, (tx) => setTimesheetPeople(tx, arohaId, { userId: aroha.id, approverUserId: wiremu.id }));
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  it("HL51: without opening balances (decision 143) Aroha can't ask for leave yet", async () => {
    await expect(ask(aroha, { leaveType: "annual", startDate: "2027-03-01", endDate: "2027-03-05" })).rejects.toThrow("Leave can't be asked for here yet");
  });

  it("HL49: Aroha asks for Mon 1-Fri 5 Mar 2027 and sees days, hours and her balance in weeks, never money", async () => {
    const earnings: Array<Record<string, unknown>> = [];
    for (let monday = "2026-02-02"; monday <= "2027-01-25"; monday = addDays(monday, 7)) {
      earnings.push({ periodStart: monday, periodEnd: addDays(monday, 6), gross: "1200.00", irregular: "0", days: 5 });
    }
    await as(jess, (tx) =>
      saveOpeningBalances(tx, {
        idempotencyKey: key("opening"),
        employeeId: arohaId,
        asAt: "2027-01-31",
        annualWeeks: "2",
        annualLastEntitled: "2026-04-01",
        sickDays: "17",
        familyViolenceDays: "8",
        earnings,
        source: "Previous payroll at 31 Jan 2027",
        report: { fileName: "report.pdf", content: new TextEncoder().encode("%PDF-1.4\nreport\n%%EOF") },
      }),
    );
    const { request } = await ask(aroha, { leaveType: "annual", startDate: "2027-03-01", endDate: "2027-03-05", note: "Family trip" });
    expect(request).toMatchObject({ status: "pending", days: 5, hours: "40", isOwn: true, canChange: true, canDecide: false, leaveType: "annual" });
    const mine = await as(aroha, (tx, role) => listLeaveRequests(tx, role, { asAt: "2027-02-01" }));
    expect(mine.mine).toEqual([{ employeeId: arohaId, name: "Aroha Requests", annual: { weeks: "2.0000", hours: "80.00" }, sickDays: "17.00", problem: null }]);
    expect(JSON.stringify(mine)).not.toMatch(/amount|gross|rate|1200/i);
    // Wiremu sees it to approve; Vic sees nothing and can't open it.
    const forWiremu = await as(wiremu, (tx, role) => listLeaveRequests(tx, role));
    expect(forWiremu.requests.map((each) => [each.employeeName, each.status, each.canDecide])).toEqual([["Aroha Requests", "pending", true]]);
    expect((await as(vic, (tx, role) => listLeaveRequests(tx, role))).requests).toEqual([]);
    await expect(as(vic, (tx, role) => getLeaveRequest(tx, role, request.id))).rejects.toThrow("You can only see your own leave requests");
  });

  it("HL50: changing and withdrawing before it's decided; a rejection needs a reason she sees", async () => {
    const { request } = await ask(aroha, { leaveType: "annual", startDate: "2027-03-15", endDate: "2027-03-19" });
    const changed = await as(aroha, (tx, role) => updateLeaveRequest(tx, role, request.id, { leaveType: "annual", startDate: "2027-03-15", endDate: "2027-03-17" }));
    expect([changed.request.days, changed.request.hours]).toEqual([3, "24"]);
    await expect(as(wiremu, (tx, role) => updateLeaveRequest(tx, role, request.id, { leaveType: "annual", startDate: "2027-03-15" }))).rejects.toThrow(
      "Only the employee can change their leave request.",
    );
    await expect(as(wiremu, (tx, role) => rejectLeaveRequest(tx, role, request.id, { reason: "" }))).rejects.toThrow("Give a reason; the employee sees it.");
    const rejected = await as(wiremu, (tx, role) => rejectLeaveRequest(tx, role, request.id, { reason: "Stocktake that week" }));
    expect(rejected.request).toMatchObject({ status: "rejected", rejectionReason: "Stocktake that week", decidedByEmail: wiremu.email });
    await expect(as(aroha, (tx, role) => withdrawLeaveRequest(tx, role, request.id))).rejects.toThrow("This request is already rejected, so it can't be withdrawn.");
    const { request: sick } = await ask(aroha, { leaveType: "sick", startDate: "2027-03-22" });
    expect((await as(aroha, (tx, role) => withdrawLeaveRequest(tx, role, sick.id))).request.status).toBe("withdrawn");
  });

  it("HL49, HL51: Wiremu approves through the API and Tohyee books the leave as him; Aroha can't approve her own", async () => {
    const pending = (await as(aroha, (tx, role) => listLeaveRequests(tx, role, { status: "pending" }))).requests;
    expect(pending).toHaveLength(1);
    await expect(as(aroha, (tx, role) => approveLeaveRequest(tx, role, pending[0].id))).rejects.toThrow("Someone else approves your leave.");
    const response = await approveRoute.POST(
      apiRequest(`/api/payroll/leave/requests/${pending[0].id}/approve`, { method: "POST", cookie: await sessionCookieFor(wiremu), body: { organisationId: ORG } }),
      params({ requestId: pending[0].id }) as never,
    );
    expect(response.status).toBe(200);
    const approved = (await response.json()) as { request: { status: string; booking: string } };
    expect(approved.request.status).toBe("approved");
    const bookingId = (await as(jess, (tx) => tx.query<{ booking_id: string }>("select booking_id::text from payroll_leave_requests where id = $1", [pending[0].id]))).rows[0].booking_id;
    const booking = await as(jess, (tx) => getLeaveBooking(tx, bookingId));
    expect(booking).toMatchObject({ reference: approved.request.booking, leaveType: "annual", startDate: "2027-03-01", endDate: "2027-03-05", createdByEmail: wiremu.email });
    await expect(as(aroha, (tx, role) => updateLeaveRequest(tx, role, pending[0].id, { leaveType: "annual", startDate: "2027-03-01" }))).rejects.toThrow(
      "This request is already approved, so it can't be changed.",
    );
  });

  it("HL51: an approval the booking refuses is refused with its reason, and the request stays waiting", async () => {
    await expect(ask(aroha, { leaveType: "annual", startDate: "2027-03-06", endDate: "2027-03-07" })).rejects.toThrow("None of those days is a working day for Aroha Requests.");
    const { request } = await ask(aroha, { leaveType: "alternative", startDate: "2027-03-03" });
    await expect(as(wiremu, (tx, role) => approveLeaveRequest(tx, role, request.id))).rejects.toThrow("already has LEAVE-");
    expect((await as(aroha, (tx, role) => getLeaveRequest(tx, role, request.id))).status).toBe("pending");
  });

  it("HL51: family violence leave is 'Special leave' to her approver, and its own type to her and to payroll access", async () => {
    const { request } = await ask(aroha, { leaveType: "family_violence", startDate: "2027-03-23" });
    expect(request.leaveType).toBe("family_violence");
    expect((await as(wiremu, (tx, role) => getLeaveRequest(tx, role, request.id))).leaveType).toBe("special");
    expect((await as(jess, (tx, role) => getLeaveRequest(tx, role, request.id))).leaveType).toBe("family_violence");
  });

  it("HL49: the pay run for 1-7 Mar 2027 pays the approved leave at the s 21(2) rate", async () => {
    let last: PayRun | null = null;
    for (let monday = "2027-02-01"; monday <= "2027-02-22"; monday = addDays(monday, 7)) last = await approveRun((await draft(monday)).id);
    expect(last?.status).toBe("approved");
    const run = await draft("2027-03-01");
    const leave = run.employees.find((entry) => entry.employeeId === arohaId)!.lines.filter((line) => line.source === "leave");
    expect(leave.map((line) => [line.payItemName, line.amount])).toEqual([["Annual leave", "1200.00"]]);
  });

  it("asking through the API needs a login linked to the employee", async () => {
    const response = await requestsRoute.POST(
      apiRequest("/api/payroll/leave/requests", {
        method: "POST",
        cookie: await sessionCookieFor(vic),
        body: { organisationId: ORG, idempotencyKey: key("request"), employeeId: arohaId, leaveType: "annual", startDate: "2027-03-29" },
      }),
      undefined as never,
    );
    expect(response.status).toBe(403);
  });
});

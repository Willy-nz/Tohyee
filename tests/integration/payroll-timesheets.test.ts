import { afterAll, beforeAll, expect, it } from "vitest";
import * as approveRoute from "@/app/api/payroll/timesheets/[timesheetId]/approve/route";
import * as projectTimeRoute from "@/app/api/payroll/timesheets/[timesheetId]/project-time/route";
import * as rejectRoute from "@/app/api/payroll/timesheets/[timesheetId]/reject/route";
import * as reopenRoute from "@/app/api/payroll/timesheets/[timesheetId]/reopen/route";
import * as sheetRoute from "@/app/api/payroll/timesheets/[timesheetId]/route";
import * as submitRoute from "@/app/api/payroll/timesheets/[timesheetId]/submit/route";
import * as peopleRoute from "@/app/api/payroll/timesheets/people/route";
import * as weekRoute from "@/app/api/payroll/timesheets/route";
import * as targetsRoute from "@/app/api/payroll/timesheets/targets/route";
import type { Role } from "@/lib/auth/roles";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { addAllocation } from "@/lib/payroll/allocations";
import { createEmployee, updateEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import { listPayItems } from "@/lib/payroll/pay-items";
import { approvePayRun, createPayRun, listPayRunPostings, voidPayRun, type PayRun } from "@/lib/payroll/pay-runs";
import { weekStartOf } from "@/lib/payroll/timesheet-split";
import {
  approveTimesheet,
  getTimesheet,
  openTimesheet,
  saveTimesheetEntries,
  setTimesheetPeople,
  submitTimesheet,
  type Timesheet,
  type TimesheetWeek,
} from "@/lib/payroll/timesheets";
import { createProject, createTask, createTimeEntry } from "@/lib/projects/service";
import { buildClaimReport } from "@/lib/rd/claim";
import { createActivity, createApproval } from "@/lib/rd/register";
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
  type TestServer,
} from "../helpers/test-server";

const PDF_HEAD = "%PDF-1.7\n%âãÏÓ\n";
function pdfBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size).fill(0x41);
  bytes.set(Buffer.from(PDF_HEAD, "latin1"));
  return bytes;
}

const noContext = undefined as never;
const WEEK1 = "2026-07-06";
const WEEK2 = "2026-07-13";

/** Hours for the days of a week, Monday first: [8, 8, 4] is Mon 8, Tue 8, Wed 4. */
function days(weekStart: string, hours: Array<string | number | null>): Record<string, string> {
  const result: Record<string, string> = {};
  hours.forEach((value, index) => {
    if (value === null) return;
    const date = new Date(Date.parse(`${weekStart}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10);
    result[date] = String(value);
  });
  return result;
}

/**
 * Timesheets, payroll stage P9: examples TS1-TS11 in
 * docs/ACCOUNTING-EXAMPLES.md ("Timesheets"). Kea Sensors Ltd with Hana and
 * Ben (RD28's payroll), Jess (owner, payroll access), Sam (bookkeeper), Ana
 * (admin), Ben (viewer, his own login) and Vic (viewer). Each test gets its
 * own organisation.
 */
describeWithDatabase("Timesheets (TS1-TS11)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let sam: SessionUser;
  let ana: SessionUser;
  let benUser: SessionUser;
  let vic: SessionUser;
  const cookies = new Map<string, string>();
  let organisations = 0;
  const previousSecret = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "timesheets-integration-test-secret-key-at-least-32";
    server = await startTestServer();
    jess = await createTestUser("ts-jess@example.com", { serverAdmin: true, displayName: "Jess Kelly" });
    sam = await createTestUser("ts-sam@example.com", { displayName: "Sam Bookkeeper" });
    ana = await createTestUser("ts-ana@example.com", { displayName: "Ana Admin" });
    benUser = await createTestUser("ts-ben@example.com", { displayName: "Ben" });
    vic = await createTestUser("ts-vic@example.com", { displayName: "Vic Viewer" });
    for (const user of [jess, sam, ana, benUser, vic]) cookies.set(user.email, await sessionCookieFor(user));
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  const ROLES = new Map<string, Role>();

  async function setup() {
    organisations += 1;
    const org = `ts-${organisations}-kea`;
    await createTestOrganisation(jess, org);
    for (const [user, role] of [
      [sam, "bookkeeper"],
      [ana, "admin"],
      [benUser, "viewer"],
      [vic, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    ROLES.set(jess.id, "owner").set(sam.id, "bookkeeper").set(ana.id, "admin").set(benUser.id, "viewer").set(vic.id, "viewer");
    const asUser = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
    const as = asUser(jess);
    const role = (user: SessionUser) => ROLES.get(user.id)!;

    const call = async (
      user: SessionUser,
      handler: (request: Request, context: never) => Promise<Response>,
      path: string,
      routeParams: Record<string, string> | null,
      options: { method?: string; body?: unknown } = {},
    ) => {
      const response = await handler(apiRequest(path, { cookie: cookies.get(user.email), ...options }), (routeParams ? params(routeParams) : noContext) as never);
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const department = (await as((tx) => getTrackingSetup(tx))).categories.find((category) => category.kind === "department")!.id;
    const setupAfter = await as((tx) => createTrackingValue(tx, { categoryId: department, name: "Operations" }));
    const operations = setupAfter.categories.find((category) => category.id === department)!.values.find((value) => value.name === "Operations")!.id;

    const activity = async (fields: Record<string, unknown>) =>
      (await as((tx) => createActivity(tx, { idempotencyKey: key("activity"), projectName: "Low-power soil sensor", firstIncomeYear: 2027, ...fields }))).activity;
    const c1 = await activity({ code: "C1", name: "Prototype and field-test a low-power soil-moisture sensor", kind: "core", place: "nz" });
    const s1 = await activity({ code: "S1", name: "Literature and patent search", kind: "supporting", place: "nz", supports: [c1.id] });
    await as((tx) =>
      createApproval(tx, {
        idempotencyKey: key("approval"),
        kind: "general",
        reference: "RDGA-12345",
        letterDate: todayIsoDate(),
        firstIncomeYear: "2027",
        lastIncomeYear: "2029",
        activityIds: [c1.id, s1.id].join(","),
        note: undefined,
        letter: { fileName: "IRD letter.pdf", content: pdfBytes(300) },
      }),
    );
    const customer = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Taieri Growers Ltd", isCustomer: true }))).contact;
    const project = (await as((tx) => createProject(tx, { idempotencyKey: key("project"), name: "Taieri soil survey", contactId: customer.id }))).project;

    const group = (await as((tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Fortnightly salaries", payFrequency: "fortnightly" }))).group.id;
    const employee = async (firstName: string, lastName: string, extra: Record<string, unknown>) =>
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
    const hana = await employee("Hana", "Rewi", { annualSalary: "62400.00", kiwiSaverStatus: "enrolled", esctRate: "30" });
    const ben = await employee("Ben", "Tait", { annualSalary: "52000.00" });
    const allocate = (employeeId: string, lines: unknown[]) =>
      as((tx) => addAllocation(tx, employeeId, { idempotencyKey: key("allocation"), effectiveFrom: "2026-04-01", lines }));
    await allocate(hana, [{ percentage: "100", rdActivityId: c1.id }]);
    await allocate(ben, [
      { percentage: "60", rdActivityId: c1.id },
      { percentage: "40", departmentId: operations },
    ]);
    await as((tx) => setTimesheetPeople(tx, ben, { userId: benUser.id, approverUserId: sam.id }));

    const open = async (user: SessionUser, employeeId: string, weekStart: string) =>
      (await asUser(user)((tx) => openTimesheet(tx, role(user), { idempotencyKey: key("sheet"), employeeId, weekStart }))).timesheet;
    const save = async (user: SessionUser, sheet: Timesheet, rows: unknown[]) =>
      (await asUser(user)((tx) => saveTimesheetEntries(tx, role(user), sheet.id, { version: sheet.version, rows }))).timesheet;
    const submit = async (user: SessionUser, sheet: Timesheet) => (await asUser(user)((tx) => submitTimesheet(tx, role(user), sheet.id))).timesheet;
    const approve = async (user: SessionUser, sheet: Timesheet) => (await asUser(user)((tx) => approveTimesheet(tx, role(user), sheet.id))).timesheet;
    /** A whole week entered, submitted and approved. */
    const approvedWeek = async (employeeId: string, weekStart: string, rows: unknown[]) =>
      approve(jess, await submit(jess, await save(jess, await open(jess, employeeId, weekStart), rows)));
    const getSheet = (user: SessionUser, id: string) => asUser(user)((tx) => getTimesheet(tx, role(user), id));
    // Ben's TS2 weeks.
    const benWeek1 = [
      { rdActivityId: c1.id, hours: days(WEEK1, [8, 8, 4]) },
      { departmentId: operations, hours: days(WEEK1, [null, null, 4, 8, 8]) },
    ];
    const benWeek2 = [
      { rdActivityId: c1.id, hours: days(WEEK2, [8, 8]) },
      { departmentId: operations, hours: days(WEEK2, [null, null, 8, 4]) },
      { projectId: project.id, hours: days(WEEK2, [null, null, null, 4, 8]) },
    ];

    const items = await as((tx) => listPayItems(tx));
    const item = (kind: string) => items.find((entry) => entry.kind === kind)!.id;
    const payRun = async (fields: { payGroupId?: string; periodStart?: string; payDate?: string } = {}) => {
      const run = (
        await as((tx) => createPayRun(tx, { idempotencyKey: key("payrun"), payGroupId: group, periodStart: WEEK1, payDate: "2026-07-22", ...fields }))
      ).payRun;
      return run;
    };
    const approveRun = async (run: PayRun) => (await as((tx) => approvePayRun(tx, run.id, { idempotencyKey: key("approve") }))).payRun;
    const journalLines = async (run: PayRun) => {
      const journal = await as((tx) => getJournal(tx, run.approvalJournalId!));
      return journal.lines.filter((line) => line.debitAmount !== "0.00").map((line) => [line.description, line.debitAmount, line.tracking[department] ?? null]);
    };
    const postings = (run: PayRun) => as((tx) => listPayRunPostings(tx, run.id));
    const report = (payrollDetail = true) => as((tx) => buildClaimReport(tx, 2027, { payrollDetail, showReminders: false }));

    return {
      org, as, asUser, role, call, operations, department, c1, s1, project, group, hana, ben, open, save, submit, approve, approvedWeek, getSheet,
      benWeek1, benWeek2, item, payRun, approveRun, journalLines, postings, report, employee, allocate,
    };
  }

  it("TS1: payroll access links an employee to a login and names the approver; others can't", async () => {
    const w = await setup();
    // Done in setup through the service; through the route as Jess, and refused for Sam.
    const ok = await w.call(jess, peopleRoute.PUT, "/api/payroll/timesheets/people", null, {
      method: "PUT",
      body: { organisationId: w.org, employeeId: w.ben, userId: benUser.id, approverUserId: sam.id },
    });
    expect(ok.status).toBe(200);
    expect((ok.body.people as Array<Record<string, unknown>>).find((person) => person.employeeId === w.ben)).toMatchObject({
      userEmail: benUser.email,
      approverEmail: sam.email,
    });
    for (const user of [sam, benUser]) {
      const refused = await w.call(user, peopleRoute.PUT, "/api/payroll/timesheets/people", null, {
        method: "PUT",
        body: { organisationId: w.org, employeeId: w.ben, userId: null, approverUserId: null },
      });
      expect(refused.status).toBe(403);
    }
    await expect(w.as((tx) => setTimesheetPeople(tx, w.hana, { userId: benUser.id, approverUserId: null }))).rejects.toThrow("Ben is already linked to Ben Tait.");
    await expect(w.as((tx) => setTimesheetPeople(tx, w.hana, { userId: null, approverUserId: vic.id }))).rejects.toThrow(
      "A timesheet approver needs the bookkeeper role or higher.",
    );
    await expect(w.as((tx) => setTimesheetPeople(tx, w.hana, { userId: "00000000-0000-4000-8000-000000000000", approverUserId: null }))).rejects.toThrow(
      "must be a member of the organisation",
    );
    await expect(w.as((tx) => setTimesheetPeople(tx, w.ben, { userId: sam.id, approverUserId: sam.id }))).rejects.toThrow("can't approve their own");

    // Ben (a viewer) opens and fills in his own week; he can't open Hana's.
    const sheet = await w.open(benUser, w.ben, WEEK1);
    expect(sheet).toMatchObject({ employeeName: "Ben Tait", weekStart: WEEK1, weekEnd: "2026-07-12", status: "draft", isOwn: true, canEnter: true, canApprove: false });
    await expect(w.open(benUser, w.hana, WEEK1)).rejects.toThrow("You can only see your own timesheets");
    // Sam (approver) can read it but not change hours.
    const samView = await w.getSheet(sam, sheet.id);
    expect(samView).toMatchObject({ isOwn: false, canEnter: false });
    await expect(w.save(sam, samView, w.benWeek1)).rejects.toThrow("Approvers can't change hours. Reject the timesheet with a reason instead.");

    // With no approver, the member linked to the reports-to manager approves (NetSuite's supervisor).
    const samEmployee = await w.employee("Sam", "Manager", { annualSalary: "60000.00" });
    await w.as((tx) => setTimesheetPeople(tx, samEmployee, { userId: sam.id, approverUserId: null }));
    await w.as((tx) => setTimesheetPeople(tx, w.ben, { approverUserId: null, userId: undefined }));
    await expect(w.getSheet(sam, sheet.id)).rejects.toThrow("You can only see your own timesheets");
    await w.as((tx) => updateEmployee(tx, w.ben, { reportsToId: samEmployee }));
    expect((await w.getSheet(sam, sheet.id)).employeeName).toBe("Ben Tait");
    // Ana (admin without payroll access) and Vic see nothing.
    for (const user of [ana, vic]) await expect(w.getSheet(user, sheet.id)).rejects.toThrow("You can only see your own timesheets");
  });

  it("TS2, TS3: the database stamps every entry; changes replace, clearing removes, nothing is deleted", async () => {
    const w = await setup();
    const created = await w.call(benUser, weekRoute.POST, "/api/payroll/timesheets", null, {
      method: "POST",
      body: { organisationId: w.org, idempotencyKey: key("open"), employeeId: w.ben, weekStart: WEEK1 },
    });
    expect(created.status).toBe(201);
    const sheet = created.body.timesheet as Timesheet;
    // A second open for the same week returns the first (TS11).
    const again = await w.call(jess, weekRoute.POST, "/api/payroll/timesheets", null, {
      method: "POST",
      body: { organisationId: w.org, idempotencyKey: key("open"), employeeId: w.ben, weekStart: WEEK1 },
    });
    expect(again.status).toBe(200);
    expect((again.body.timesheet as Timesheet).id).toBe(sheet.id);

    const saved = await w.call(benUser, sheetRoute.PUT, `/api/payroll/timesheets/${sheet.id}`, { timesheetId: sheet.id }, {
      method: "PUT",
      body: { organisationId: w.org, version: sheet.version, rows: w.benWeek1.map((row) => ({ ...row, enteredAt: "2026-07-06T09:00:00Z" })) },
    });
    expect(saved.status).toBe(200);
    const filled = saved.body.timesheet as Timesheet;
    expect(filled.total).toBe("40.00");
    expect(filled.dayTotals).toMatchObject({ "2026-07-06": "8.00", "2026-07-08": "8.00", "2026-07-10": "8.00", "2026-07-11": "0.00" });
    expect(filled.rows.map((row) => [row.label, row.total])).toEqual([
      ["C1 Prototype and field-test a low-power soil-moisture sensor", "20.00"],
      ["Department Operations", "20.00"],
    ]);
    const monday = filled.rows[0].entries["2026-07-06"];
    const today = todayIsoDate();
    // Stamped by the database today, whatever the request said.
    expect(monday).toMatchObject({ hours: "8.00", enteredByEmail: benUser.email, enteredOn: today });
    expect(monday.daysAfterWork).toBe(Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse("2026-07-06T00:00:00Z")) / 86_400_000));
    expect(monday.enteredLate).toBe(monday.daysAfterWork > 14);
    expect(filled.lateCount).toBe(monday.enteredLate ? 6 : 0);

    // TS3: Wed C1 4.00 -> 3.50, and 0.50 more Operations on Wed.
    const changed = await w.save(benUser, filled, [
      { rdActivityId: w.c1.id, hours: days(WEEK1, [8, 8, "3.5"]) },
      { departmentId: w.operations, hours: days(WEEK1, [null, null, "4.5", 8, 8]) },
    ]);
    expect(changed.version).toBe(filled.version + 1);
    expect(changed.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workDate: "2026-07-08", hours: "4.00", outcome: "replaced", newHours: "3.50", enteredByEmail: benUser.email, endedByEmail: benUser.email }),
        expect.objectContaining({ workDate: "2026-07-08", hours: "4.00", outcome: "replaced", newHours: "4.50", label: "Department Operations" }),
      ]),
    );
    // Clearing a cell removes its entry.
    const cleared = await w.save(benUser, changed, [
      { rdActivityId: w.c1.id, hours: days(WEEK1, [8, 8, "3.5"]) },
      { departmentId: w.operations, hours: days(WEEK1, [null, null, "4.5", 8]) },
    ]);
    expect(cleared.changes.filter((change) => change.outcome === "removed")).toMatchObject([{ workDate: "2026-07-10", hours: "8.00" }]);
    expect(cleared.total).toBe("32.00");
    // Saving the same grid again changes nothing.
    expect((await w.save(benUser, cleared, cleared.rows.map((row) => ({ rdActivityId: row.rdActivityId, departmentId: row.departmentId, hours: row.hours })))).version).toBe(cleared.version);
    // An old version is refused.
    await expect(w.save(benUser, filled, w.benWeek1)).rejects.toThrow("Ben Tait's timesheet was changed by someone else. Reload it.");

    // The database keeps every entry and refuses deleting or overwriting one.
    const counts = await w.as((tx) => tx.query<{ status: string; count: string }>("select status, count(*)::text as count from payroll_timesheet_entries group by status order by status"));
    expect(counts.rows).toEqual([
      { status: "active", count: "5" },
      { status: "removed", count: "1" },
      { status: "replaced", count: "2" },
    ]);
    await expect(w.as((tx) => tx.query("delete from payroll_timesheet_entries"))).rejects.toThrow("can't be deleted");
    await expect(w.as((tx) => tx.query("update payroll_timesheet_entries set hours = 1 where status = 'active'"))).rejects.toThrow("kept as entered");
    await w.as((tx) =>
      tx.query(
        `insert into payroll_timesheet_entries (timesheet_id, work_date, hours, entered_at, entered_by_email) values ($1, '2026-07-12', 1, '2020-01-01', 'x@example.com')`,
        [sheet.id],
      ),
    );
    const stamped = await w.as((tx) => tx.query<{ entered_at: Date }>("select entered_at from payroll_timesheet_entries where work_date = '2026-07-12'"));
    expect(new Date(stamped.rows[0].entered_at).getUTCFullYear()).toBeGreaterThan(2020);

    // An entry for today is "entered on the day of the work".
    const thisWeek = await w.open(benUser, w.ben, weekStartOf(today));
    const now = await w.save(benUser, thisWeek, [{ rdActivityId: w.c1.id, hours: { [today]: "2" } }]);
    expect(now.rows[0].entries[today]).toMatchObject({ daysAfterWork: 0, enteredLate: false, timelinessText: "entered on the day of the work" });
  });

  it("TS2: 'Fill from project time' suggests the linked member's project hours and saves nothing", async () => {
    const w = await setup();
    const taskId = (await w.as((tx) => createTask(tx, w.project.id, { idempotencyKey: key("task"), name: "Field work", chargeType: "non_chargeable" }))).taskId;
    for (const [entryDate, minutes] of [
      ["2026-07-09", "240"],
      ["2026-07-10", "200"],
    ] as const) {
      await w.as((tx) => createTimeEntry(tx, "owner", w.project.id, { idempotencyKey: key("time"), userId: benUser.id, taskId, entryDate, hours: "0", minutes }));
    }
    const sheet = await w.open(benUser, w.ben, WEEK1);
    const response = await w.call(benUser, projectTimeRoute.GET, `/api/payroll/timesheets/${sheet.id}/project-time?organisationId=${w.org}`, { timesheetId: sheet.id });
    expect(response.status).toBe(200);
    expect(response.body.suggestions).toEqual([{ projectId: w.project.id, projectName: "Taieri soil survey", hours: { "2026-07-09": "4.00", "2026-07-10": "3.33" } }]);
    expect((await w.getSheet(benUser, sheet.id)).rows).toEqual([]);
    const targets = await w.call(benUser, targetsRoute.GET, `/api/payroll/timesheets/targets?organisationId=${w.org}`, null);
    expect(targets.body.targets).toMatchObject({
      departments: [{ name: "Operations" }],
      projects: [{ id: w.project.id, name: "Taieri soil survey" }],
      rdActivities: [{ code: "C1" }, { code: "S1" }],
    });
  });

  it("TS4: submit, reject with a reason, approve; approval locks; only payroll access reopens", async () => {
    const w = await setup();
    let sheet = await w.open(benUser, w.ben, WEEK1);
    await expect(w.submit(benUser, sheet)).rejects.toThrow("There are no hours to submit.");
    sheet = await w.save(benUser, sheet, w.benWeek1);
    const submitted = await w.call(benUser, submitRoute.POST, `/api/payroll/timesheets/${sheet.id}/submit`, { timesheetId: sheet.id }, { method: "POST", body: { organisationId: w.org } });
    expect(submitted.status).toBe(200);
    sheet = submitted.body.timesheet as Timesheet;
    expect(sheet).toMatchObject({ status: "submitted", submittedByEmail: benUser.email, canEnter: false });
    await expect(w.save(benUser, sheet, w.benWeek1)).rejects.toThrow("This timesheet is submitted, so its hours can't change.");

    // Sam sees it waiting for him; Ben can't approve his own; Vic and Ana can't see it.
    const week = await w.call(sam, weekRoute.GET, `/api/payroll/timesheets?organisationId=${w.org}&weekStart=${WEEK1}`, null);
    expect((week.body.week as TimesheetWeek).toApprove.map((entry) => entry.id)).toEqual([sheet.id]);
    const own = await w.call(benUser, approveRoute.POST, `/api/payroll/timesheets/${sheet.id}/approve`, { timesheetId: sheet.id }, { method: "POST", body: { organisationId: w.org } });
    expect(own).toMatchObject({ status: 403, body: { error: "Someone else approves your timesheet." } });
    for (const user of [vic, ana]) {
      const refused = await w.call(user, approveRoute.POST, `/api/payroll/timesheets/${sheet.id}/approve`, { timesheetId: sheet.id }, { method: "POST", body: { organisationId: w.org } });
      expect(refused.status).toBe(403);
    }

    const noReason = await w.call(sam, rejectRoute.POST, `/api/payroll/timesheets/${sheet.id}/reject`, { timesheetId: sheet.id }, { method: "POST", body: { organisationId: w.org } });
    expect(noReason.status).toBe(400);
    const rejected = await w.call(sam, rejectRoute.POST, `/api/payroll/timesheets/${sheet.id}/reject`, { timesheetId: sheet.id }, {
      method: "POST",
      body: { organisationId: w.org, reason: "Wednesday's Operations hours look short" },
    });
    expect(rejected.status).toBe(200);
    sheet = rejected.body.timesheet as Timesheet;
    expect(sheet.status).toBe("draft");
    sheet = await w.save(benUser, sheet, [w.benWeek1[0], { departmentId: w.operations, hours: days(WEEK1, [null, null, 5, 8, 8]) }]);
    sheet = await w.submit(benUser, sheet);
    await expect(w.approve(jess, { ...sheet, id: sheet.id })).resolves.toMatchObject({ status: "approved" });
    sheet = await w.getSheet(sam, sheet.id);
    expect(sheet).toMatchObject({ status: "approved", approvedByEmail: jess.email, canApprove: false, canReopen: false });
    expect(sheet.history.map((event) => [event.action, event.actorEmail, event.reason])).toEqual([
      ["created", benUser.email, null],
      ["submitted", benUser.email, null],
      ["rejected", sam.email, "Wednesday's Operations hours look short"],
      ["submitted", benUser.email, null],
      ["approved", jess.email, null],
    ]);
    // Locked: no new, changed or removed entries, even straight in the database.
    await expect(w.as((tx) => tx.query("insert into payroll_timesheet_entries (timesheet_id, work_date, hours, entered_by_email) values ($1, $2, 1, 'x')", [sheet.id, WEEK1]))).rejects.toThrow(
      "This timesheet is approved",
    );
    await expect(w.as((tx) => tx.query("update payroll_timesheet_entries set status = 'removed', ended_by_email = 'x' where timesheet_id = $1", [sheet.id]))).rejects.toThrow(
      "This timesheet is approved",
    );
    await expect(w.as((tx) => tx.query("delete from payroll_timesheets"))).rejects.toThrow("can't be deleted");

    // Reopening: Sam (no payroll access) can't; Jess can, with a reason.
    const samReopen = await w.call(sam, reopenRoute.POST, `/api/payroll/timesheets/${sheet.id}/reopen`, { timesheetId: sheet.id }, { method: "POST", body: { organisationId: w.org, reason: "x" } });
    expect(samReopen.status).toBe(403);
    expect((await w.getSheet(jess, sheet.id)).canReopen).toBe(true);
    const reopened = await w.call(jess, reopenRoute.POST, `/api/payroll/timesheets/${sheet.id}/reopen`, { timesheetId: sheet.id }, {
      method: "POST",
      body: { organisationId: w.org, reason: "Ben forgot Friday's training" },
    });
    expect(reopened.status).toBe(200);
    expect(reopened.body.timesheet).toMatchObject({ status: "draft", approvedAt: null });
    // Approving a draft is refused.
    await expect(w.approve(jess, reopened.body.timesheet as Timesheet)).rejects.toThrow("Only a submitted timesheet can be approved.");
    // The audit log records the steps without hours.
    const audit = await w.as((tx) => tx.query<{ event_type: string; details: unknown }>("select event_type, details from audit_events where entity_type = 'payroll_timesheet' order by id"));
    expect(audit.rows.map((row) => row.event_type)).toContain("payroll_timesheet.approved");
    expect(JSON.stringify(audit.rows)).not.toMatch(/"hours"|8\.00/);
  });

  it("TS5: fully covered, Ben's pay is split by his timesheets and C1's 900.00 counts for R&D", async () => {
    const w = await setup();
    await w.approvedWeek(w.ben, WEEK1, w.benWeek1);
    await w.approvedWeek(w.ben, WEEK2, w.benWeek2);
    const draft = await w.payRun();
    expect(draft.employees.find((entry) => entry.employeeId === w.ben)!.timesheets).toEqual({ count: 2, coveredDays: 14, periodDays: 14, hours: "80.00", allDaysCovered: true });
    // Salaried pay doesn't change (TS8).
    expect(draft.employees.find((entry) => entry.employeeId === w.ben)!.lines).toMatchObject([{ amount: "2000.00", description: null }]);
    const run = await w.approveRun(draft);
    const lines = await w.journalLines(run);
    expect(lines).toEqual(
      expect.arrayContaining([
        // Ben's C1 900.00 shares the untagged line with Hana's 2,400.00.
        ["Ordinary time", "3300.00", null],
        ["Ordinary time", "800.00", w.operations],
        ["Ordinary time (project Taieri soil survey)", "300.00", null],
      ]),
    );
    const benPostings = (await w.postings(run)).filter((posting) => posting.employeeName === "Ben Tait");
    expect(benPostings.map((posting) => [posting.percentage, posting.amount])).toEqual([
      ["45.00", "900.00"],
      ["40.00", "800.00"],
      ["15.00", "300.00"],
    ]);
    const shares = await w.as((tx) =>
      tx.query<{ source: string; hours: string; weight: string; percentage: string }>(
        "select source, hours::text, weight::text, percentage::text from payroll_pay_run_shares where pay_run_id = $1 and employee_id = $2 order by share_number",
        [run.id, w.ben],
      ),
    );
    expect(shares.rows).toEqual([
      { source: "timesheet", hours: "36.00", weight: "50400", percentage: "45.0000" },
      { source: "timesheet", hours: "32.00", weight: "44800", percentage: "40.0000" },
      { source: "timesheet", hours: "12.00", weight: "16800", percentage: "15.0000" },
    ]);
    expect(run.employees.find((entry) => entry.employeeId === w.ben)!.timesheets).toMatchObject({ count: 2, hours: "80.00" });

    const r = await w.report();
    const benPay = r.payroll.pays!.find((pay) => pay.employeeId === w.ben)!;
    expect(benPay).toMatchObject({ cost: "2000.00", usesTimesheets: true, notRd: "1100.00" });
    expect(benPay.shares).toMatchObject([{ activityId: w.c1.id, source: "timesheet", hours: "36.00", amount: "900.00", percentage: "45.00", counts: true }]);
    // Hana (100% C1 allocation, no timesheet) still counts 2,484.00 (RD28).
    expect(r.activities.find((row) => row.activity.code === "C1")!.categories.employee).toBe("3384.00");
    expect(r.payroll).toMatchObject({ counted: "3384.00", defaultSplit: "0.00" });
    expect(r.notCounted.find((group) => group.reason === "default_split")).toBeUndefined();
  });

  it("TS6, TS9: half covered, the allocation takes the other days; late approval isn't used; used timesheets are locked", async () => {
    const w = await setup();
    const week1 = await w.approvedWeek(w.ben, WEEK1, w.benWeek1);
    const week2 = await w.submit(jess, await w.save(jess, await w.open(jess, w.ben, WEEK2), w.benWeek2));
    const run = await w.approveRun(await w.payRun());
    expect(await w.journalLines(run)).toEqual(
      expect.arrayContaining([
        // Ben's 500.00 + 600.00 with Hana's 2,400.00.
        ["Ordinary time", "3500.00", null],
        ["Ordinary time", "900.00", w.operations],
      ]),
    );
    const benPostings = (await w.postings(run)).filter((posting) => posting.employeeName === "Ben Tait");
    expect(benPostings.map((posting) => [posting.percentage, posting.amount])).toEqual([
      ["25.00", "500.00"],
      ["25.00", "500.00"],
      ["30.00", "600.00"],
      ["20.00", "400.00"],
    ]);

    let r = await w.report();
    const benPay = r.payroll.pays!.find((pay) => pay.employeeId === w.ben)!;
    expect(benPay.shares).toMatchObject([
      { source: "timesheet", amount: "500.00", counts: true },
      { source: "allocation", amount: "600.00", counts: false },
    ]);
    expect(r.notCounted.find((group) => group.reason === "default_split")).toMatchObject({ amount: "600.00" });
    expect(r.payroll).toMatchObject({ counted: "2984.00", defaultSplit: "600.00" });

    // TS9: week 2 approved after the pay run isn't used, and the report says so.
    await w.approve(sam, week2);
    r = await w.report();
    expect(r.payroll.counted).toBe("2984.00");
    expect(r.notes).toContain(`Ben Tait: the timesheet for the week of Monday 13 Jul 2026 was approved after ${run.reference}, so its 16.00 R&D hours aren't used (decision 37).`);
    const others = await w.report(false);
    expect(others.notes).toContain("1 timesheet was approved after its pay run, so its R&D hours aren't used (decision 37).");
    expect(JSON.stringify(others)).not.toContain("Ben Tait");

    // Week 1 was used, so it can't be reopened (nor in the database) until the pay run is voided.
    const reopen = (id: string) =>
      w.call(jess, reopenRoute.POST, `/api/payroll/timesheets/${id}/reopen`, { timesheetId: id }, { method: "POST", body: { organisationId: w.org, reason: "Correction" } });
    expect(await reopen(week1.id)).toMatchObject({ status: 409, body: { error: `${run.reference} used this timesheet, so it can't be reopened. Void ${run.reference} first.` } });
    await expect(w.as((tx) => tx.query("update payroll_timesheets set status = 'draft', submitted_at = null, approved_at = null where id = $1", [week1.id]))).rejects.toThrow(
      "can't be reopened",
    );
    expect((await reopen(week2.id)).status).toBe(200);
    await w.as((tx) => voidPayRun(tx, run.id, { idempotencyKey: key("void"), voidDate: "2026-07-23" }));
    expect((await reopen(week1.id)).status).toBe(200);
  });

  it("TS7: 77 hours share the cents by largest remainder; R&D rounds down to 1,548.46 and 129.03", async () => {
    const w = await setup();
    const rows = (weekStart: string) => [
      { rdActivityId: w.c1.id, hours: days(weekStart, [8, 8, 8]) },
      { rdActivityId: w.s1.id, hours: days(weekStart, [null, null, null, 2]) },
      { departmentId: w.operations, hours: days(weekStart, [null, null, null, 6, "6.5"]) },
    ];
    await w.approvedWeek(w.hana, WEEK1, rows(WEEK1));
    await w.approvedWeek(w.hana, WEEK2, rows(WEEK2));
    const run = await w.approveRun(await w.payRun());
    const hana = run.employees.find((entry) => entry.employeeId === w.hana)!;
    expect(hana.pay).toMatchObject({ gross: "2400.00", kiwiSaverEmployer: "84.00" });
    const hanaPostings = (await w.postings(run)).filter((posting) => posting.employeeName === "Hana Rewi");
    expect(hanaPostings.map((posting) => [posting.payItemName, posting.amount])).toEqual([
      ["Ordinary time", "1496.10"],
      ["Ordinary time", "124.68"],
      ["Ordinary time", "779.22"],
      ["KiwiSaver employer contribution", "52.37"],
      ["KiwiSaver employer contribution", "4.36"],
      ["KiwiSaver employer contribution", "27.27"],
    ]);
    expect(hanaPostings[0].percentage).toBe("62.3377");
    const r = await w.report();
    const hanaPay = r.payroll.pays!.find((pay) => pay.employeeId === w.hana)!;
    expect(hanaPay).toMatchObject({ cost: "2484.00", notRd: "806.51" });
    expect(hanaPay.shares.map((share) => [share.source, share.hours, share.amount, share.counts])).toEqual([
      ["timesheet", "48.00", "1548.46", true],
      ["timesheet", "4.00", "129.03", true],
    ]);
  });

  it("TS8: an hourly employee fully covered by approved timesheets is paid their hours", async () => {
    const w = await setup();
    const weekly = (await w.as((tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Weekly wages", payFrequency: "weekly" }))).group.id;
    const sione = await w.employee("Sione", "Fifita", { payBasis: "hourly", payFrequency: "weekly", hourlyRate: "22.50", ordinaryHoursPerWeek: "32", payGroupId: weekly });
    await w.allocate(sione, [{ percentage: "100", departmentId: w.operations }]);
    await w.approvedWeek(sione, WEEK1, [
      { departmentId: w.operations, hours: days(WEEK1, ["7.5", "7.5", "7.5", "7.5"]) },
      { rdActivityId: w.c1.id, hours: days(WEEK1, [null, null, null, null, "6.5"]) },
    ]);
    const draft = await w.payRun({ payGroupId: weekly, periodStart: WEEK1, payDate: "2026-07-15" });
    const line = draft.employees[0].lines[0];
    expect(line).toMatchObject({ payItemName: "Ordinary time", quantity: "36.50", rate: "22.50", amount: "821.25", description: "From approved timesheets" });
    const run = await w.approveRun(draft);
    expect(run.employees[0].pay).toMatchObject({ gross: "821.25" });
    const sionePostings = await w.postings(run);
    expect(sionePostings.map((posting) => [posting.amount, posting.percentage])).toEqual([
      ["146.25", "17.8082"],
      ["675.00", "82.1918"],
    ]);
    const r = await w.report();
    expect(r.payroll.pays!.find((pay) => pay.employeeId === sione)!.shares).toMatchObject([{ amount: "146.25", counts: true, hours: "6.50" }]);

    // The next week isn't approved: the usual 32 hours (PRUN11).
    const next = await w.payRun({ payGroupId: weekly, periodStart: WEEK2, payDate: "2026-07-22" });
    expect(next.employees[0].lines[0]).toMatchObject({ quantity: "32.00", amount: "720.00", description: null });
  });

  it("TS10: timesheets show hours, never pay; each person sees only what they may", async () => {
    const w = await setup();
    const sheet = await w.save(benUser, await w.open(benUser, w.ben, WEEK1), w.benWeek1);
    const mine = await w.call(benUser, sheetRoute.GET, `/api/payroll/timesheets/${sheet.id}?organisationId=${w.org}`, { timesheetId: sheet.id });
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).not.toMatch(/"(amount|annualSalary|hourlyRate|rate|gross|netPay|cost)":/);
    for (const user of [vic, ana]) {
      const refused = await w.call(user, sheetRoute.GET, `/api/payroll/timesheets/${sheet.id}?organisationId=${w.org}`, { timesheetId: sheet.id });
      expect(refused).toMatchObject({ status: 403, body: { error: "You can only see your own timesheets, the ones you approve, or everyone's with payroll access." } });
    }
    const weekFor = async (user: SessionUser) =>
      ((await w.call(user, weekRoute.GET, `/api/payroll/timesheets?organisationId=${w.org}&weekStart=${WEEK1}`, null)).body.week as TimesheetWeek).employees.map(
        (employee) => [employee.name, employee.relation],
      );
    expect(await weekFor(benUser)).toEqual([["Ben Tait", "own"]]);
    expect(await weekFor(sam)).toEqual([["Ben Tait", "approver"]]);
    expect(await weekFor(vic)).toEqual([]);
    expect(await weekFor(jess)).toEqual([
      ["Hana Rewi", "payroll"],
      ["Ben Tait", "payroll"],
    ]);
  });

  it("TS11: refused, and nothing saved", async () => {
    const w = await setup();
    const sheet = await w.open(jess, w.ben, WEEK1);
    const refuse = (rows: unknown[], message: string | RegExp) => expect(w.save(jess, sheet, rows)).rejects.toThrow(message);
    await refuse([{ rdActivityId: w.c1.id, hours: { [WEEK1]: "0" } }], "hours must not be zero");
    await refuse([{ rdActivityId: w.c1.id, hours: { [WEEK1]: "24.01" } }], "hours can't be more than 24");
    await refuse([{ rdActivityId: w.c1.id, hours: { [WEEK1]: "7.333" } }], "at most 2 decimal places");
    await refuse([{ rdActivityId: w.c1.id, hours: { [WEEK1]: "abc" } }], "must be a plain number");
    await refuse(
      [
        { rdActivityId: w.c1.id, hours: { [WEEK1]: "16" } },
        { departmentId: w.operations, hours: { [WEEK1]: "8.5" } },
      ],
      "2026-07-06 has 24.50 hours. A day can't have more than 24.",
    );
    await refuse([{ rdActivityId: w.c1.id, hours: { "2026-07-13": "8" } }], "2026-07-13 isn't in the week starting 2026-07-06");
    await refuse(
      [
        { rdActivityId: w.c1.id, hours: { [WEEK1]: "4" } },
        { rdActivityId: w.c1.id, hours: { "2026-07-07": "4" } },
      ],
      "Row 2 is the same as row 1",
    );
    const location = (await w.as((tx) => getTrackingSetup(tx))).categories.find((category) => category.kind === "location")!.id;
    const wellington = (await w.as((tx) => createTrackingValue(tx, { categoryId: location, name: "Wellington" })))
      .categories.find((category) => category.id === location)!.values.find((value) => value.name === "Wellington")!.id;
    await refuse([{ departmentId: wellington, hours: { [WEEK1]: "1" } }], "That isn't a Department.");
    await w.as((tx) => tx.query("update rd_activities set status = 'archived', archived_at = now(), archived_by_email = 'x' where id = $1", [w.s1.id]));
    await refuse([{ rdActivityId: w.s1.id, hours: { [WEEK1]: "1" } }], "S1 is archived");
    await w.as((tx) => tx.query("update projects set status = 'closed', closed_at = now() where id = $1", [w.project.id]));
    await refuse([{ projectId: w.project.id, hours: { [WEEK1]: "1" } }], "Taieri soil survey is closed");
    expect((await w.getSheet(jess, sheet.id)).rows).toEqual([]);

    // Before the start date, a week not starting on Monday, an archived employee.
    const early = await w.open(jess, w.ben, "2026-03-30");
    await expect(w.save(jess, early, [{ rdActivityId: w.c1.id, hours: { "2026-03-31": "8" } }])).rejects.toThrow("2026-03-31 is before Ben Tait started (2026-04-01).");
    await expect(w.open(jess, w.ben, "2026-07-07")).rejects.toThrow("A timesheet week starts on a Monday.");
    await expect(w.open(jess, w.ben, "2026-03-23")).rejects.toThrow("doesn't work for you in the week starting 2026-03-23");
  });
});

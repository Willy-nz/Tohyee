import { writeAuditEvent } from "@/lib/audit";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { addDays } from "@/lib/financial-year";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { add, cmp, dec, divide, type Decimal, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { listMembers } from "@/lib/organisations/members";
import { hasPayrollAccess, PAYROLL_MINIMUM_ROLE, requirePayrollAccess } from "@/lib/payroll/access";
import { timesheetFirstDay } from "@/lib/payroll/pay-items";
import { isWeekStart, parseTimesheetHours, timesheetLateness, WEEKDAY_NAMES, weekDays, weekStartOf } from "@/lib/payroll/timesheet-split";
import { timeZone } from "@/lib/rd/common";
import { advancedFeaturesOn } from "@/lib/tracking/service";
import { asRecord, optionalString, requireArray, requireIdempotencyKey } from "@/lib/validation";

/**
 * Timesheets (payroll stage P9; examples TS1-TS11; decisions 91-101). One
 * timesheet per employee per week (Monday to Sunday) of hours per day by R&D
 * activity, Department, project, a combination, or "other work". Every entry
 * is stamped by the database; changes replace entries, never overwrite them.
 * Approval locks a timesheet; pay runs approved afterwards split the
 * employee's cost by it for the days it covers, and the R&D claim takes
 * their R&D share from it. Timesheets show hours only, never pay, so the
 * employee and their approver needn't have payroll access (decision 95).
 */

export type TimesheetStatus = "draft" | "submitted" | "approved";

export const TIMESHEET_ACCESS_MESSAGE =
  "You can only see your own timesheets, the ones you approve, or everyone's with payroll access.";

export type TimesheetEntry = {
  id: string;
  workDate: string;
  hours: string;
  enteredAt: string;
  enteredByEmail: string;
  enteredOn: string;
  daysAfterWork: number;
  enteredLate: boolean;
  timelinessText: string;
};

export type TimesheetRow = {
  key: string;
  label: string;
  departmentId: string | null;
  departmentName: string | null;
  projectId: string | null;
  projectName: string | null;
  rdActivityId: string | null;
  rdActivityCode: string | null;
  rdActivityName: string | null;
  description: string | null;
  /** Hours by date, as entered (2 decimal places). */
  hours: Record<string, string>;
  entries: Record<string, TimesheetEntry>;
  total: string;
};

export type TimesheetChange = {
  workDate: string;
  label: string;
  hours: string;
  enteredAt: string;
  enteredByEmail: string;
  outcome: "replaced" | "removed";
  newHours: string | null;
  endedAt: string;
  endedByEmail: string;
};

export type TimesheetEvent = {
  action: "created" | "submitted" | "approved" | "rejected" | "reopened";
  reason: string | null;
  actorEmail: string;
  at: string;
};

export type TimesheetSummary = {
  id: string;
  employeeId: string;
  employeeName: string;
  weekStart: string;
  status: TimesheetStatus;
  total: string;
  lateCount: number;
};

export type Timesheet = TimesheetSummary & {
  weekEnd: string;
  days: string[];
  version: number;
  rows: TimesheetRow[];
  dayTotals: Record<string, string>;
  submittedAt: string | null;
  submittedByEmail: string | null;
  approvedAt: string | null;
  approvedByEmail: string | null;
  changes: TimesheetChange[];
  history: TimesheetEvent[];
  /** Approved pay runs that used this timesheet (TS9). */
  usedBy: string[];
  isOwn: boolean;
  canEnter: boolean;
  canSubmit: boolean;
  canApprove: boolean;
  canReopen: boolean;
  employeeStartDate: string;
  employeeFinishDate: string | null;
};

type EmployeeRow = {
  id: string;
  name: string;
  start_date: string;
  finish_date: string | null;
  is_archived: boolean;
  user_id: string | null;
  timesheet_approver_user_id: string | null;
  manager_user_id: string | null;
};

type SheetRow = {
  id: string;
  idempotency_key: string;
  request_hash: string;
  employee_id: string;
  week_start: string;
  status: TimesheetStatus;
  version: number;
  submitted_at: string | null;
  submitted_by_email: string | null;
  approved_at: string | null;
  approved_by_email: string | null;
};

type EntryRow = {
  id: string;
  work_date: string;
  department_id: string | null;
  department_name: string | null;
  project_id: string | null;
  project_name: string | null;
  rd_activity_id: string | null;
  rd_activity_code: string | null;
  rd_activity_name: string | null;
  hours: string;
  description: string | null;
  status: "active" | "replaced" | "removed";
  replaces_id: string | null;
  entered_at: string;
  entered_by_email: string;
  entered_on: string;
  ended_at: string | null;
  ended_by_email: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BIGINT_ID = /^[1-9][0-9]{0,18}$/;

const EMPLOYEE_SELECT = `select e.id, e.first_name || ' ' || e.last_name as name, e.start_date::text, e.finish_date::text, e.is_archived,
       e.user_id::text, e.timesheet_approver_user_id::text, m.user_id::text as manager_user_id
  from payroll_employees e left join payroll_employees m on m.id = e.reports_to_id`;

const SHEET_COLUMNS = `id, idempotency_key, request_hash, employee_id, week_start::text, status, version,
  submitted_at::text, submitted_by_email, approved_at::text, approved_by_email`;

function parseUuid(input: unknown, what: string): string {
  if (typeof input !== "string" || !UUID.test(input)) throw new NotFoundError(`That ${what} wasn't found.`);
  return input.toLowerCase();
}

/** PAYRUN-n (as `payRunReference` in pay-runs.ts, which imports this module). */
function payRunReference(runNumber: string): string {
  return `PAYRUN-${runNumber}`;
}

function money2(value: Decimal): string {
  return toFixedString(value, 2);
}

/** Who the signed-in person is to an employee's timesheets (decisions 95, 96). */
export type Access = { payroll: boolean; own: boolean; approver: boolean };

async function payrollFor(tx: OrgTx, role: Role): Promise<boolean> {
  return roleAtLeast(role, PAYROLL_MINIMUM_ROLE) && (await hasPayrollAccess(tx));
}

function accessTo(employee: EmployeeRow, actorUserId: string | null, role: Role, payroll: boolean): Access {
  const own = actorUserId !== null && employee.user_id === actorUserId;
  // NetSuite: the time approver, or the supervisor when no approver is set.
  const named = employee.timesheet_approver_user_id ?? employee.manager_user_id;
  const approver = !own && actorUserId !== null && named === actorUserId && roleAtLeast(role, PAYROLL_MINIMUM_ROLE);
  return { payroll, own, approver };
}

function canRead(access: Access): boolean {
  return access.payroll || access.own || access.approver;
}

async function findEmployee(tx: OrgTx, idInput: unknown, forUpdate = false): Promise<EmployeeRow> {
  const id = parseUuid(idInput, "employee");
  if (forUpdate) await tx.query("select 1 from payroll_employees where id = $1 for update", [id]);
  const result = await tx.query<EmployeeRow>(`${EMPLOYEE_SELECT} where e.id = $1`, [id]);
  if (!result.rows[0]) throw new NotFoundError("That employee wasn't found.");
  return result.rows[0];
}

/**
 * Who the signed-in person is to an employee (decisions 95, 96): the
 * employee themselves, their timesheet approver (else their reports-to
 * manager's login, bookkeeper or higher), or someone with payroll access.
 * Leave requests use the same rules (decision 169).
 */
export async function employeeAccess(
  tx: OrgTx,
  role: Role,
  employeeIdInput: unknown,
  forUpdate = false,
): Promise<{ employee: { id: string; name: string; startDate: string; finishDate: string | null; isArchived: boolean }; access: Access }> {
  const employee = await findEmployee(tx, employeeIdInput, forUpdate);
  const access = accessTo(employee, tx.actor.userId, role, await payrollFor(tx, role));
  return {
    employee: { id: employee.id, name: employee.name, startDate: employee.start_date, finishDate: employee.finish_date, isArchived: employee.is_archived },
    access,
  };
}

/** The employees the signed-in person is linked to, or approves for (decision 96). */
export async function employeesForActor(tx: OrgTx): Promise<{ own: string[]; approves: string[] }> {
  if (!tx.actor.userId) return { own: [], approves: [] };
  const result = await tx.query<{ id: string; own: boolean }>(
    `select e.id::text, e.user_id = $1 as own
       from payroll_employees e left join payroll_employees m on m.id = e.reports_to_id
      where e.user_id = $1 or coalesce(e.timesheet_approver_user_id, m.user_id) = $1`,
    [tx.actor.userId],
  );
  return { own: result.rows.filter((row) => row.own).map((row) => row.id), approves: result.rows.filter((row) => !row.own).map((row) => row.id) };
}

async function findSheet(tx: OrgTx, idInput: unknown, forUpdate = false): Promise<SheetRow> {
  const id = parseUuid(idInput, "timesheet");
  const result = await tx.query<SheetRow>(`select ${SHEET_COLUMNS} from payroll_timesheets where id = $1${forUpdate ? " for update" : ""}`, [id]);
  if (!result.rows[0]) throw new NotFoundError("That timesheet wasn't found.");
  return result.rows[0];
}

async function loadEntries(tx: OrgTx, sheetIds: readonly string[]): Promise<Array<EntryRow & { timesheet_id: string }>> {
  if (sheetIds.length === 0) return [];
  const result = await tx.query<EntryRow & { timesheet_id: string }>(
    `select en.id, en.timesheet_id, en.work_date::text, en.department_id::text, d.name as department_name, en.project_id::text,
            p.name as project_name, en.rd_activity_id::text, r.code as rd_activity_code, r.name as rd_activity_name,
            en.hours::text, en.description, en.status, en.replaces_id::text, en.entered_at::text, en.entered_by_email,
            to_char((en.entered_at at time zone $2)::date, 'YYYY-MM-DD') as entered_on, en.ended_at::text, en.ended_by_email
       from payroll_timesheet_entries en
       left join tracking_values d on d.id = en.department_id
       left join projects p on p.id = en.project_id
       left join rd_activities r on r.id = en.rd_activity_id
      where en.timesheet_id = any($1::uuid[])
      order by en.work_date, en.entered_at, en.id`,
    [sheetIds, timeZone()],
  );
  return result.rows;
}

/** A row's identity: its R&D activity, Department and project (any may be empty). */
function rowKey(target: { departmentId: string | null; projectId: string | null; rdActivityId: string | null }): string {
  return `${target.rdActivityId ?? ""}|${target.departmentId ?? ""}|${target.projectId ?? ""}`;
}

function rowLabel(row: { rdActivityCode: string | null; rdActivityName: string | null; departmentName: string | null; projectName: string | null }): string {
  const parts = [
    row.rdActivityCode ? `${row.rdActivityCode}${row.rdActivityName ? ` ${row.rdActivityName}` : ""}` : null,
    row.departmentName ? `Department ${row.departmentName}` : null,
    row.projectName ? `project ${row.projectName}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(", ") : "Other work (default split)";
}

function entryTarget(entry: EntryRow) {
  return {
    departmentId: entry.department_id,
    departmentName: entry.department_name,
    projectId: entry.project_id,
    projectName: entry.project_name,
    rdActivityId: entry.rd_activity_id,
    rdActivityCode: entry.rd_activity_code,
    rdActivityName: entry.rd_activity_name,
  };
}

function toEntry(entry: EntryRow): TimesheetEntry {
  const lateness = timesheetLateness(entry.work_date, entry.entered_on);
  return {
    id: entry.id,
    workDate: entry.work_date,
    hours: money2(dec(entry.hours)),
    enteredAt: entry.entered_at,
    enteredByEmail: entry.entered_by_email,
    enteredOn: entry.entered_on,
    daysAfterWork: lateness.days,
    enteredLate: lateness.late,
    timelinessText: lateness.text,
  };
}

/** Rows ordered by R&D activity code, then Department, then project; "other work" last (decision 98). */
function compareRows(
  a: { rdActivityCode: string | null; departmentName: string | null; projectName: string | null },
  b: { rdActivityCode: string | null; departmentName: string | null; projectName: string | null },
): number {
  const nullsLast = (x: string | null, y: string | null) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x.localeCompare(y));
  return nullsLast(a.rdActivityCode, b.rdActivityCode) || nullsLast(a.departmentName, b.departmentName) || nullsLast(a.projectName, b.projectName);
}

function buildRows(entries: EntryRow[]): TimesheetRow[] {
  const rows = new Map<string, TimesheetRow>();
  for (const entry of entries.filter((each) => each.status === "active")) {
    const target = entryTarget(entry);
    const key = rowKey(target);
    let row = rows.get(key);
    if (!row) {
      row = { key, label: rowLabel(target), ...target, description: entry.description, hours: {}, entries: {}, total: "0.00" };
      rows.set(key, row);
    }
    row.hours[entry.work_date] = money2(dec(entry.hours));
    row.entries[entry.work_date] = toEntry(entry);
    row.description = row.description ?? entry.description;
    row.total = money2(add(dec(row.total), dec(entry.hours)));
  }
  return [...rows.values()].sort(compareRows);
}

async function sheetEvents(tx: OrgTx, sheetId: string): Promise<TimesheetEvent[]> {
  const result = await tx.query<{ action: TimesheetEvent["action"]; reason: string | null; actor_email: string; created_at: string }>(
    "select action, reason, actor_email, created_at::text from payroll_timesheet_history where timesheet_id = $1 order by id",
    [sheetId],
  );
  return result.rows.map((row) => ({ action: row.action, reason: row.reason, actorEmail: row.actor_email, at: row.created_at }));
}

async function usedBy(tx: OrgTx, sheetId: string): Promise<string[]> {
  const result = await tx.query<{ run_number: string }>(
    `select r.run_number::text from payroll_pay_run_timesheets l join payroll_pay_runs r on r.id = l.pay_run_id
      where l.timesheet_id = $1 and r.status = 'approved' order by r.run_number`,
    [sheetId],
  );
  return result.rows.map((row) => payRunReference(row.run_number));
}

async function record(tx: OrgTx, sheetId: string, action: TimesheetEvent["action"], reason: string | null, employeeId: string, weekStart: string) {
  await tx.query("insert into payroll_timesheet_history (timesheet_id, action, reason, actor_user_id, actor_email) values ($1, $2, $3, $4, $5)", [
    sheetId,
    action,
    reason,
    tx.actor.userId,
    tx.actor.email,
  ]);
  // The audit log names the employee, the week and the step, never hours (TS10).
  await writeAuditEvent(tx, {
    eventType: `payroll_timesheet.${action}`,
    entityType: "payroll_timesheet",
    entityId: sheetId,
    details: { employeeId, weekStart },
  });
}

async function buildTimesheet(tx: OrgTx, sheet: SheetRow, employee: EmployeeRow, access: Access): Promise<Timesheet> {
  const entries = await loadEntries(tx, [sheet.id]);
  const rows = buildRows(entries);
  const days = weekDays(sheet.week_start);
  const dayTotals: Record<string, string> = {};
  for (const day of days) dayTotals[day] = money2(sum(rows.map((row) => dec(row.hours[day] ?? "0"))));
  const replacement = new Map(entries.filter((entry) => entry.replaces_id).map((entry) => [entry.replaces_id!, entry]));
  const changes: TimesheetChange[] = entries
    .filter((entry) => entry.status !== "active")
    .map((entry) => ({
      workDate: entry.work_date,
      label: rowLabel(entryTarget(entry)),
      hours: money2(dec(entry.hours)),
      enteredAt: entry.entered_at,
      enteredByEmail: entry.entered_by_email,
      outcome: entry.status === "replaced" ? ("replaced" as const) : ("removed" as const),
      newHours: entry.status === "replaced" && replacement.get(entry.id) ? money2(dec(replacement.get(entry.id)!.hours)) : null,
      endedAt: entry.ended_at!,
      endedByEmail: entry.ended_by_email!,
    }));
  const used = await usedBy(tx, sheet.id);
  const active = rows.flatMap((row) => Object.values(row.entries));
  const enter = (access.own || access.payroll) && sheet.status === "draft" && !employee.is_archived;
  return {
    id: sheet.id,
    employeeId: employee.id,
    employeeName: employee.name,
    weekStart: sheet.week_start,
    weekEnd: addDays(sheet.week_start, 6),
    days,
    status: sheet.status,
    version: sheet.version,
    rows,
    dayTotals,
    total: money2(sum(rows.map((row) => dec(row.total)))),
    lateCount: active.filter((entry) => entry.enteredLate).length,
    submittedAt: sheet.submitted_at,
    submittedByEmail: sheet.submitted_by_email,
    approvedAt: sheet.approved_at,
    approvedByEmail: sheet.approved_by_email,
    changes,
    history: await sheetEvents(tx, sheet.id),
    usedBy: used,
    isOwn: access.own,
    canEnter: enter,
    canSubmit: enter && rows.length > 0,
    canApprove: (access.payroll || access.approver) && !access.own && sheet.status === "submitted",
    canReopen: access.payroll && sheet.status === "approved" && used.length === 0,
    employeeStartDate: employee.start_date,
    employeeFinishDate: employee.finish_date,
  };
}

async function readable(tx: OrgTx, role: Role, sheetIdInput: unknown, forUpdate = false) {
  const sheet = await findSheet(tx, sheetIdInput, forUpdate);
  const employee = await findEmployee(tx, sheet.employee_id);
  const access = accessTo(employee, tx.actor.userId, role, await payrollFor(tx, role));
  if (!canRead(access)) throw new ForbiddenError(TIMESHEET_ACCESS_MESSAGE);
  return { sheet, employee, access };
}

/** One timesheet, with its rows, changes and history (TS2-TS4, TS10). */
export async function getTimesheet(tx: OrgTx, role: Role, sheetIdInput: unknown): Promise<Timesheet> {
  const { sheet, employee, access } = await readable(tx, role, sheetIdInput);
  return buildTimesheet(tx, sheet, employee, access);
}

export type TimesheetWeekEmployee = {
  employeeId: string;
  name: string;
  relation: "own" | "approver" | "payroll";
  timesheet: TimesheetSummary | null;
};

export type TimesheetWeek = {
  weekStart: string;
  /** The organisation's first day of the week, ISO 1 = Monday to 7 = Sunday (decision 192). */
  firstDay: number;
  /** The employee linked to the signed-in person's login, if any. */
  ownEmployeeId: string | null;
  hasPayrollAccess: boolean;
  employees: TimesheetWeekEmployee[];
  /** Submitted timesheets (any week) the signed-in person can approve. */
  toApprove: TimesheetSummary[];
};

async function summaries(tx: OrgTx, sheetIds: readonly string[]): Promise<Map<string, TimesheetSummary>> {
  if (sheetIds.length === 0) return new Map();
  const sheets = await tx.query<Pick<SheetRow, "id" | "employee_id" | "week_start" | "status"> & { employee_name: string }>(
    `select t.id, t.employee_id, t.week_start::text, t.status, e.first_name || ' ' || e.last_name as employee_name
       from payroll_timesheets t join payroll_employees e on e.id = t.employee_id
      where t.id = any($1::uuid[])`,
    [sheetIds],
  );
  const entries = await loadEntries(tx, sheetIds);
  return new Map(
    sheets.rows.map((sheet) => {
      const mine = entries.filter((entry) => entry.timesheet_id === sheet.id && entry.status === "active");
      return [
        sheet.id,
        {
          id: sheet.id,
          employeeId: sheet.employee_id,
          employeeName: sheet.employee_name,
          weekStart: sheet.week_start,
          status: sheet.status,
          total: money2(sum(mine.map((entry) => dec(entry.hours)))),
          lateCount: mine.filter((entry) => timesheetLateness(entry.work_date, entry.entered_on).late).length,
        },
      ];
    }),
  );
}

/** A timesheet's week start: the organisation's first day of the week (decision 192; Monday unless changed). */
async function parseWeekStart(tx: OrgTx, input: unknown): Promise<string> {
  const weekStart = parseIsoDate(input, "Week starting");
  const firstDay = await timesheetFirstDay(tx);
  if (!isWeekStart(weekStart, firstDay)) throw new ValidationError(`A timesheet week starts on a ${WEEKDAY_NAMES[firstDay - 1]}.`);
  return weekStart;
}

/**
 * Payroll › Timesheets for a week (TS1, TS4, TS10): the signed-in person's
 * own timesheet, the employees whose timesheets they approve, and everyone
 * for people with payroll access; plus everything waiting for their approval.
 */
export async function listTimesheetWeek(tx: OrgTx, role: Role, weekStartInput: unknown): Promise<TimesheetWeek> {
  // Any date opens the week it's in, so the screen needn't know the organisation's first day (decision 192).
  const firstDay = await timesheetFirstDay(tx);
  const weekStart = weekStartOf(parseIsoDate(weekStartInput, "Week starting"), firstDay);
  const payroll = await payrollFor(tx, role);
  const employees = (
    await tx.query<EmployeeRow>(
      `${EMPLOYEE_SELECT}
        where not e.is_archived and e.start_date <= $1::date + 6 and (e.finish_date is null or e.finish_date >= $1::date)
        order by lower(e.last_name), lower(e.first_name), e.id`,
      [weekStart],
    )
  ).rows;
  const visible = employees
    .map((employee) => ({ employee, access: accessTo(employee, tx.actor.userId, role, payroll) }))
    .filter(({ access }) => canRead(access));
  const sheets = await tx.query<{ id: string; employee_id: string }>(
    "select id, employee_id from payroll_timesheets where week_start = $1 and employee_id = any($2::uuid[])",
    [weekStart, visible.map(({ employee }) => employee.id)],
  );
  const byEmployee = new Map(sheets.rows.map((row) => [row.employee_id, row.id]));

  const all = (await tx.query<EmployeeRow>(EMPLOYEE_SELECT)).rows;
  const approvable = all.filter((employee) => {
    const access = accessTo(employee, tx.actor.userId, role, payroll);
    return (access.payroll || access.approver) && !access.own;
  });
  const waiting = await tx.query<{ id: string }>(
    "select id from payroll_timesheets where status = 'submitted' and employee_id = any($1::uuid[]) order by week_start, id limit 200",
    [approvable.map((employee) => employee.id)],
  );
  const found = await summaries(tx, [...byEmployee.values(), ...waiting.rows.map((row) => row.id)]);
  const own = all.find((employee) => tx.actor.userId !== null && employee.user_id === tx.actor.userId && !employee.is_archived);
  return {
    weekStart,
    firstDay,
    ownEmployeeId: own?.id ?? null,
    hasPayrollAccess: payroll,
    employees: visible.map(({ employee, access }) => ({
      employeeId: employee.id,
      name: employee.name,
      relation: access.own ? "own" : access.approver ? "approver" : "payroll",
      timesheet: byEmployee.has(employee.id) ? found.get(byEmployee.get(employee.id)!) ?? null : null,
    })),
    toApprove: waiting.rows.map((row) => found.get(row.id)!).filter(Boolean),
  };
}

/**
 * Opens an employee's timesheet for a week, making it if there isn't one
 * (TS2, TS11): the employee themselves (linked to their login) or someone
 * with payroll access. A second one for the same week is never made.
 */
export async function openTimesheet(
  tx: OrgTx,
  role: Role,
  input: { idempotencyKey: unknown; employeeId: unknown; weekStart: unknown },
): Promise<{ created: boolean; timesheet: Timesheet }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const hash = requestHash("payroll_timesheet", { employeeId: input.employeeId, weekStart: input.weekStart });
  const earlier = await tx.query<SheetRow>(`select ${SHEET_COLUMNS} from payroll_timesheets where idempotency_key = $1`, [idempotencyKey]);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "timesheet");
    return { created: false, timesheet: await getTimesheet(tx, role, earlier.rows[0].id) };
  }
  const employee = await findEmployee(tx, input.employeeId, true);
  const access = accessTo(employee, tx.actor.userId, role, await payrollFor(tx, role));
  if (!canRead(access)) throw new ForbiddenError(TIMESHEET_ACCESS_MESSAGE);
  const weekStart = await parseWeekStart(tx, input.weekStart);
  const existing = await tx.query<{ id: string }>("select id from payroll_timesheets where employee_id = $1 and week_start = $2", [employee.id, weekStart]);
  if (existing.rows[0]) return { created: false, timesheet: await getTimesheet(tx, role, existing.rows[0].id) };
  if (!access.own && !access.payroll) {
    throw new ForbiddenError(`${employee.name} hasn't started a timesheet for that week. Only they, or someone with payroll access, can.`);
  }
  if (employee.is_archived) throw new ValidationError(`${employee.name} is archived, so they can't have new timesheets.`);
  if (employee.start_date > addDays(weekStart, 6) || (employee.finish_date !== null && employee.finish_date < weekStart)) {
    throw new ValidationError(`${employee.name} doesn't work for you in the week starting ${weekStart}.`);
  }
  const inserted = await tx.query<{ id: string }>(
    `insert into payroll_timesheets (idempotency_key, request_hash, employee_id, week_start, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [idempotencyKey, hash, employee.id, weekStart, tx.actor.userId, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  await record(tx, id, "created", null, employee.id, weekStart);
  return { created: true, timesheet: await getTimesheet(tx, role, id) };
}

type DesiredCell = {
  workDate: string;
  departmentId: string | null;
  projectId: string | null;
  rdActivityId: string | null;
  hours: string;
  description: string | null;
};

function optionalBigintId(input: unknown, label: string): string | null {
  if (input === undefined || input === null || input === "") return null;
  const text = typeof input === "number" && Number.isSafeInteger(input) ? String(input) : input;
  if (typeof text !== "string" || !BIGINT_ID.test(text.trim())) throw new ValidationError(`${label} isn't valid.`);
  return text.trim();
}

function optionalActivityId(input: unknown, label: string): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || !UUID.test(input)) throw new ValidationError(`${label}: that isn't an R&D activity.`);
  return input.toLowerCase();
}

/** Checks the rows' R&D activities, Departments and projects (TS11), for cells being entered. */
async function checkTargets(tx: OrgTx, cells: DesiredCell[]): Promise<void> {
  const departments = [...new Set(cells.map((cell) => cell.departmentId).filter((id): id is string => id !== null))];
  if (departments.length > 0) {
    if (!(await advancedFeaturesOn(tx))) throw new ValidationError("Advanced reporting is off, so timesheet rows can't have a Department.");
    const values = await tx.query<{ id: string; name: string; is_active: boolean; kind: string }>(
      `select v.id::text, v.name, v.is_active, c.kind from tracking_values v join tracking_categories c on c.id = v.category_id
        where v.id = any($1::bigint[])`,
      [departments],
    );
    const found = new Map(values.rows.map((row) => [row.id, row]));
    for (const id of departments) {
      const value = found.get(id);
      if (!value || value.kind !== "department") throw new ValidationError("That isn't a Department.");
      if (!value.is_active) throw new ValidationError(`Department ${value.name} is archived.`);
    }
  }
  const projects = [...new Set(cells.map((cell) => cell.projectId).filter((id): id is string => id !== null))];
  if (projects.length > 0) {
    const rows = await tx.query<{ id: string; name: string; status: string }>("select id::text, name, status from projects where id = any($1::bigint[])", [projects]);
    const found = new Map(rows.rows.map((row) => [row.id, row]));
    for (const id of projects) {
      const project = found.get(id);
      if (!project) throw new ValidationError("That project wasn't found.");
      if (project.status !== "in_progress") throw new ValidationError(`${project.name} is closed.`);
    }
  }
  const activities = [...new Set(cells.map((cell) => cell.rdActivityId).filter((id): id is string => id !== null))];
  if (activities.length > 0) {
    const rows = await tx.query<{ id: string; code: string; status: string }>("select id::text, code, status from rd_activities where id = any($1::uuid[]) for share", [activities]);
    const found = new Map(rows.rows.map((row) => [row.id, row]));
    for (const id of activities) {
      const activity = found.get(id);
      if (!activity) throw new ValidationError("That R&D activity wasn't found.");
      if (activity.status !== "active") throw new ValidationError(`${activity.code} is archived.`);
    }
  }
}

function cellKey(cell: { workDate: string; departmentId: string | null; projectId: string | null; rdActivityId: string | null }): string {
  return `${cell.workDate}|${rowKey(cell)}`;
}

/**
 * Saves the week's grid (TS2, TS3, TS11): rows of hours by day. Cells that
 * changed replace their entry, cleared cells are removed, new cells are
 * entered; each new entry is stamped by the database. `version` must be the
 * timesheet's current version, so two people can't overwrite each other.
 */
export async function saveTimesheetEntries(
  tx: OrgTx,
  role: Role,
  sheetIdInput: unknown,
  input: { version: unknown; rows: unknown },
): Promise<{ timesheet: Timesheet }> {
  const { sheet, employee, access } = await readable(tx, role, sheetIdInput, true);
  if (!access.own && !access.payroll) {
    throw new ForbiddenError(
      access.approver
        ? "Approvers can't change hours. Reject the timesheet with a reason instead."
        : TIMESHEET_ACCESS_MESSAGE,
    );
  }
  if (sheet.status !== "draft") {
    throw new ConflictError(`This timesheet is ${sheet.status}, so its hours can't change.${sheet.status === "submitted" ? " Ask the approver to reject it first." : ""}`);
  }
  if (typeof input.version !== "number" || input.version !== sheet.version) {
    throw new ConflictError(`${employee.name}'s timesheet was changed by someone else. Reload it.`);
  }
  const days = new Set(weekDays(sheet.week_start));
  const rawRows = requireArray(input.rows, "rows", 50);
  const desired = new Map<string, DesiredCell>();
  const seenRows = new Map<string, number>();
  rawRows.forEach((raw, index) => {
    const label = `Row ${index + 1}`;
    const row = asRecord(raw, label);
    const target = {
      departmentId: optionalBigintId(row.departmentId, `${label} Department`),
      projectId: optionalBigintId(row.projectId, `${label} project`),
      rdActivityId: optionalActivityId(row.rdActivityId, label),
    };
    const key = rowKey(target);
    const earlier = seenRows.get(key);
    if (earlier !== undefined) throw new ValidationError(`${label} is the same as row ${earlier + 1}. Put those hours in one row.`);
    seenRows.set(key, index);
    const description = optionalString(row.description, `${label} description`, { maxLength: 500 });
    const hours = row.hours === undefined || row.hours === null ? {} : asRecord(row.hours, `${label} hours`);
    for (const [date, value] of Object.entries(hours)) {
      if (value === undefined || value === null || value === "") continue;
      if (!days.has(date)) throw new ValidationError(`${label}: ${date} isn't in the week starting ${sheet.week_start}.`);
      const cell = { workDate: date, ...target, hours: parseTimesheetHours(value, `${label} ${date}`), description };
      desired.set(cellKey(cell), cell);
    }
  });
  const perDay = new Map<string, Decimal>();
  for (const cell of desired.values()) perDay.set(cell.workDate, add(perDay.get(cell.workDate) ?? ZERO_DECIMAL, dec(cell.hours)));
  for (const [date, total] of [...perDay.entries()].sort()) {
    if (cmp(total, dec("24")) > 0) throw new ValidationError(`${date} has ${money2(total)} hours. A day can't have more than 24.`);
  }

  const current = (await loadEntries(tx, [sheet.id])).filter((entry) => entry.status === "active");
  const currentByKey = new Map(
    current.map((entry) => [cellKey({ workDate: entry.work_date, departmentId: entry.department_id, projectId: entry.project_id, rdActivityId: entry.rd_activity_id }), entry]),
  );
  const toEnter: Array<{ cell: DesiredCell; replaces: string | null }> = [];
  const toEnd: Array<{ id: string; status: "replaced" | "removed" }> = [];
  for (const [key, entry] of currentByKey) {
    const cell = desired.get(key);
    if (!cell) toEnd.push({ id: entry.id, status: "removed" });
    else if (cmp(dec(cell.hours), dec(entry.hours)) !== 0 || cell.description !== entry.description) {
      toEnd.push({ id: entry.id, status: "replaced" });
      toEnter.push({ cell, replaces: entry.id });
    }
  }
  for (const [key, cell] of desired) if (!currentByKey.has(key)) toEnter.push({ cell, replaces: null });

  if (toEnter.length > 0) {
    await checkTargets(tx, toEnter.map((each) => each.cell));
    for (const { cell } of toEnter) {
      if (cell.workDate < employee.start_date) {
        throw new ValidationError(`${cell.workDate} is before ${employee.name} started (${employee.start_date}).`);
      }
      if (employee.finish_date !== null && cell.workDate > employee.finish_date) {
        throw new ValidationError(`${cell.workDate} is after ${employee.name} finished (${employee.finish_date}).`);
      }
    }
  }
  if (toEnter.length === 0 && toEnd.length === 0) return { timesheet: await buildTimesheet(tx, sheet, employee, access) };

  for (const end of toEnd) {
    await tx.query("update payroll_timesheet_entries set status = $2, ended_by_user_id = $3, ended_by_email = $4, ended_at = now() where id = $1", [
      end.id,
      end.status,
      tx.actor.userId,
      tx.actor.email,
    ]);
  }
  for (const { cell, replaces } of toEnter) {
    await tx.query(
      `insert into payroll_timesheet_entries (timesheet_id, work_date, department_id, project_id, rd_activity_id, hours, description, replaces_id,
                                              entered_by_user_id, entered_by_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [sheet.id, cell.workDate, cell.departmentId, cell.projectId, cell.rdActivityId, cell.hours, cell.description, replaces, tx.actor.userId, tx.actor.email],
    );
  }
  await tx.query("update payroll_timesheets set version = version + 1, updated_at = now() where id = $1", [sheet.id]);
  await writeAuditEvent(tx, {
    eventType: "payroll_timesheet.hours_saved",
    entityType: "payroll_timesheet",
    entityId: sheet.id,
    details: { employeeId: employee.id, weekStart: sheet.week_start, entered: toEnter.length, ended: toEnd.length },
  });
  return { timesheet: await getTimesheet(tx, role, sheet.id) };
}

/** Submits a draft for approval (TS4): the employee themselves or someone with payroll access. */
export async function submitTimesheet(tx: OrgTx, role: Role, sheetIdInput: unknown): Promise<{ timesheet: Timesheet }> {
  const { sheet, employee, access } = await readable(tx, role, sheetIdInput, true);
  if (!access.own && !access.payroll) throw new ForbiddenError("Only the employee, or someone with payroll access, can submit this timesheet.");
  if (sheet.status !== "draft") throw new ConflictError(`This timesheet is already ${sheet.status}.`);
  const hours = await tx.query<{ count: string }>("select count(*)::text as count from payroll_timesheet_entries where timesheet_id = $1 and status = 'active'", [sheet.id]);
  if (hours.rows[0].count === "0") throw new ValidationError("There are no hours to submit.");
  await tx.query(
    "update payroll_timesheets set status = 'submitted', submitted_at = now(), submitted_by_user_id = $2, submitted_by_email = $3, updated_at = now() where id = $1",
    [sheet.id, tx.actor.userId, tx.actor.email],
  );
  await record(tx, sheet.id, "submitted", null, employee.id, sheet.week_start);
  return { timesheet: await getTimesheet(tx, role, sheet.id) };
}

function assertCanApprove(access: Access): void {
  if (access.own) throw new ForbiddenError("Someone else approves your timesheet.");
  if (!access.payroll && !access.approver) throw new ForbiddenError("Only the employee's timesheet approver, or someone with payroll access, can do that.");
}

/** Approves a submitted timesheet (TS4): it's locked and used by pay runs approved from now on. Posts nothing. */
export async function approveTimesheet(tx: OrgTx, role: Role, sheetIdInput: unknown): Promise<{ timesheet: Timesheet }> {
  const { sheet, employee, access } = await readable(tx, role, sheetIdInput, true);
  assertCanApprove(access);
  if (sheet.status !== "submitted") {
    throw new ConflictError(sheet.status === "approved" ? "This timesheet is already approved." : "Only a submitted timesheet can be approved. Submit it first.");
  }
  await tx.query(
    "update payroll_timesheets set status = 'approved', approved_at = now(), approved_by_user_id = $2, approved_by_email = $3, updated_at = now() where id = $1",
    [sheet.id, tx.actor.userId, tx.actor.email],
  );
  await record(tx, sheet.id, "approved", null, employee.id, sheet.week_start);
  return { timesheet: await getTimesheet(tx, role, sheet.id) };
}

function requireReason(input: unknown): string {
  const reason = optionalString(input, "Reason", { maxLength: 500 });
  if (!reason) throw new ValidationError("Give a reason.");
  return reason;
}

/** Sends a submitted timesheet back to draft with a reason (TS4). */
export async function rejectTimesheet(tx: OrgTx, role: Role, sheetIdInput: unknown, input: { reason: unknown }): Promise<{ timesheet: Timesheet }> {
  const { sheet, employee, access } = await readable(tx, role, sheetIdInput, true);
  assertCanApprove(access);
  if (sheet.status !== "submitted") throw new ConflictError("Only a submitted timesheet can be rejected.");
  const reason = requireReason(input.reason);
  await tx.query(
    `update payroll_timesheets set status = 'draft', submitted_at = null, submitted_by_user_id = null, submitted_by_email = null,
            version = version + 1, updated_at = now() where id = $1`,
    [sheet.id],
  );
  await record(tx, sheet.id, "rejected", reason, employee.id, sheet.week_start);
  return { timesheet: await getTimesheet(tx, role, sheet.id) };
}

/** Reopens an approved timesheet (TS4, TS9): payroll access only, never once an approved pay run has used it. */
export async function reopenTimesheet(tx: OrgTx, role: Role, sheetIdInput: unknown, input: { reason: unknown }): Promise<{ timesheet: Timesheet }> {
  const { sheet, employee, access } = await readable(tx, role, sheetIdInput, true);
  if (!access.payroll) throw new ForbiddenError("Only someone with payroll access can reopen an approved timesheet.");
  if (sheet.status !== "approved") throw new ConflictError("Only an approved timesheet can be reopened.");
  const used = await usedBy(tx, sheet.id);
  if (used.length > 0) {
    throw new ConflictError(`${used.join(", ")} used this timesheet, so it can't be reopened. Void ${used.join(" and ")} first.`);
  }
  const reason = requireReason(input.reason);
  await tx.query(
    `update payroll_timesheets set status = 'draft', submitted_at = null, submitted_by_user_id = null, submitted_by_email = null,
            approved_at = null, approved_by_user_id = null, approved_by_email = null, version = version + 1, updated_at = now()
      where id = $1`,
    [sheet.id],
  );
  await record(tx, sheet.id, "reopened", reason, employee.id, sheet.week_start);
  return { timesheet: await getTimesheet(tx, role, sheet.id) };
}

export type ProjectTimeSuggestion = { projectId: string; projectName: string; hours: Record<string, string> };

/**
 * "Fill from project time" (TS2, decision 91): the linked member's project
 * time for the week, by project and day, minutes ÷ 60 to 2 places. Nothing is
 * saved; the person adds the rows and saves them.
 */
export async function projectTimeSuggestions(tx: OrgTx, role: Role, sheetIdInput: unknown): Promise<ProjectTimeSuggestion[]> {
  const { sheet, employee } = await readable(tx, role, sheetIdInput);
  if (!employee.user_id) return [];
  const result = await tx.query<{ project_id: string; project_name: string; entry_date: string; minutes: string }>(
    `select e.project_id::text, p.name as project_name, e.entry_date::text, sum(e.minutes)::text as minutes
       from project_time_entries e join projects p on p.id = e.project_id
      where e.user_id = $1 and e.status = 'active' and e.entry_date between $2 and $2::date + 6 and p.status = 'in_progress'
      group by e.project_id, p.name, e.entry_date
      order by p.name, e.project_id, e.entry_date`,
    [employee.user_id, sheet.week_start],
  );
  const byProject = new Map<string, ProjectTimeSuggestion>();
  for (const row of result.rows) {
    const suggestion = byProject.get(row.project_id) ?? { projectId: row.project_id, projectName: row.project_name, hours: {} };
    const hours = divide(dec(row.minutes), dec("60"), 2);
    if (cmp(hours, ZERO_DECIMAL) > 0) suggestion.hours[row.entry_date] = money2(hours);
    byProject.set(row.project_id, suggestion);
  }
  return [...byProject.values()];
}

export type TimesheetTargets = {
  departments: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string }>;
  rdActivities: Array<{ id: string; code: string; name: string }>;
};

/** What timesheet rows can name (TS2): active Departments, open projects and active R&D activities. */
export async function timesheetTargets(tx: OrgTx): Promise<TimesheetTargets> {
  const departments = (await advancedFeaturesOn(tx))
    ? (
        await tx.query<{ id: string; name: string }>(
          `select v.id::text, v.name from tracking_values v join tracking_categories c on c.id = v.category_id
            where c.kind = 'department' and v.is_active order by lower(v.name), v.id`,
        )
      ).rows
    : [];
  const projects = (await tx.query<{ id: string; name: string }>("select id::text, name from projects where status = 'in_progress' order by lower(name), projects.id")).rows;
  const rdActivities = (await tx.query<{ id: string; code: string; name: string }>("select id::text, code, name from rd_activities where status = 'active' order by lower(code)")).rows;
  return { departments, projects, rdActivities };
}

export type TimesheetPerson = {
  employeeId: string;
  name: string;
  userId: string | null;
  userEmail: string | null;
  approverUserId: string | null;
  approverEmail: string | null;
  /** Who approves when no approver is set: the reports-to manager's login. */
  managerUserId: string | null;
};

/** Who each employee is in Tohyee and who approves their timesheets (TS1). Payroll access only. */
export async function listTimesheetPeople(tx: OrgTx): Promise<TimesheetPerson[]> {
  await requirePayrollAccess(tx);
  const members = await listMembers(tx.organisationId);
  const email = (userId: string | null) => (userId ? members.find((member) => member.userId === userId)?.email ?? null : null);
  const rows = (await tx.query<EmployeeRow>(`${EMPLOYEE_SELECT} where not e.is_archived order by lower(e.last_name), lower(e.first_name), e.id`)).rows;
  return rows.map((row) => ({
    employeeId: row.id,
    name: row.name,
    userId: row.user_id,
    userEmail: email(row.user_id),
    approverUserId: row.timesheet_approver_user_id,
    approverEmail: email(row.timesheet_approver_user_id),
    managerUserId: row.manager_user_id,
  }));
}

/**
 * Links an employee to a member's login and sets their timesheet approver
 * (TS1; decisions 95, 96). Payroll access only. An approver needs the
 * bookkeeper role or higher; one login is one employee.
 */
export async function setTimesheetPeople(
  tx: OrgTx,
  employeeIdInput: unknown,
  input: { userId: unknown; approverUserId: unknown },
): Promise<TimesheetPerson[]> {
  await requirePayrollAccess(tx);
  const employee = await findEmployee(tx, employeeIdInput, true);
  const members = await listMembers(tx.organisationId);
  const member = (value: unknown, what: string) => {
    if (value === undefined || value === null || value === "") return null;
    const found = typeof value === "string" ? members.find((each) => each.userId === value) : undefined;
    if (!found) throw new ValidationError(`${what} must be a member of the organisation.`);
    return found;
  };
  const user = input.userId === undefined ? members.find((each) => each.userId === employee.user_id) ?? null : member(input.userId, "The employee's login");
  const approver =
    input.approverUserId === undefined
      ? members.find((each) => each.userId === employee.timesheet_approver_user_id) ?? null
      : member(input.approverUserId, "The timesheet approver");
  if (approver && !roleAtLeast(approver.role, PAYROLL_MINIMUM_ROLE)) {
    throw new ValidationError("A timesheet approver needs the bookkeeper role or higher.");
  }
  if (approver && user && approver.userId === user.userId) throw new ValidationError("An employee can't approve their own timesheets.");
  if (user) {
    const other = await tx.query<{ name: string }>(
      "select first_name || ' ' || last_name as name from payroll_employees where user_id = $1 and id <> $2 and not is_archived",
      [user.userId, employee.id],
    );
    if (other.rows[0]) throw new ValidationError(`${user.displayName || user.email} is already linked to ${other.rows[0].name}.`);
  }
  await tx.query("update payroll_employees set user_id = $2, timesheet_approver_user_id = $3, updated_at = now() where id = $1", [
    employee.id,
    user?.userId ?? null,
    approver?.userId ?? null,
  ]);
  await writeAuditEvent(tx, {
    eventType: "payroll_employee.timesheet_people_set",
    entityType: "payroll_employee",
    entityId: employee.id,
    details: { userEmail: user?.email ?? null, approverEmail: approver?.email ?? null },
  });
  return listTimesheetPeople(tx);
}

export type CoverageRow = {
  departmentId: string | null;
  departmentName: string | null;
  projectId: string | null;
  projectName: string | null;
  rdActivityId: string | null;
  rdActivityCode: string | null;
  hours: string;
};

export type TimesheetCoverage = {
  timesheetIds: string[];
  periodDays: number;
  coveredDays: number;
  /** Every day of the period is in an approved timesheet's week (TS8). */
  allDaysCovered: boolean;
  /** Covered hours in the period, on every row including "other work". */
  totalHours: string;
  otherHours: string;
  /** Rows with a target, ordered as decision 98 splits them. */
  rows: CoverageRow[];
};

/**
 * The approved timesheets covering an employee's pay period (decision 98):
 * which days are covered and the hours on them by row. With `timesheetIds`
 * (an approved pay run's), only those timesheets. Callers check payroll
 * access (pay runs do).
 */
export async function timesheetCoverage(
  tx: OrgTx,
  employeeId: string,
  periodStart: string,
  periodEnd: string,
  options: { timesheetIds?: readonly string[] } = {},
): Promise<TimesheetCoverage> {
  const sheets = await tx.query<{ id: string; week_start: string }>(
    options.timesheetIds
      ? "select id, week_start::text from payroll_timesheets where id = any($1::uuid[]) order by week_start"
      : `select id, week_start::text from payroll_timesheets
          where employee_id = $1 and status = 'approved' and week_start <= $3 and week_start + 6 >= $2 order by week_start`,
    options.timesheetIds ? [options.timesheetIds] : [employeeId, periodStart, periodEnd],
  );
  const entries = (await loadEntries(tx, sheets.rows.map((row) => row.id))).filter(
    (entry) => entry.status === "active" && entry.work_date >= periodStart && entry.work_date <= periodEnd,
  );
  const withHours = sheets.rows.filter((sheet) => entries.some((entry) => entry.timesheet_id === sheet.id));
  const covered = new Set<string>();
  for (const sheet of withHours) for (const day of weekDays(sheet.week_start)) if (day >= periodStart && day <= periodEnd) covered.add(day);
  let periodDays = 0;
  for (let day = periodStart; day <= periodEnd; day = addDays(day, 1)) periodDays += 1;

  const rows = new Map<string, CoverageRow & { name: { rdActivityCode: string | null; departmentName: string | null; projectName: string | null } }>();
  let other: Decimal = ZERO_DECIMAL;
  for (const entry of entries) {
    if (!entry.department_id && !entry.project_id && !entry.rd_activity_id) {
      other = add(other, dec(entry.hours));
      continue;
    }
    const key = rowKey({ departmentId: entry.department_id, projectId: entry.project_id, rdActivityId: entry.rd_activity_id });
    const row = rows.get(key) ?? {
      departmentId: entry.department_id,
      departmentName: entry.department_name,
      projectId: entry.project_id,
      projectName: entry.project_name,
      rdActivityId: entry.rd_activity_id,
      rdActivityCode: entry.rd_activity_code,
      hours: "0.00",
      name: { rdActivityCode: entry.rd_activity_code, departmentName: entry.department_name, projectName: entry.project_name },
    };
    row.hours = money2(add(dec(row.hours), dec(entry.hours)));
    rows.set(key, row);
  }
  const ordered: CoverageRow[] = [...rows.values()]
    .sort((a, b) => compareRows(a.name, b.name))
    .map((row) => ({
      departmentId: row.departmentId,
      departmentName: row.departmentName,
      projectId: row.projectId,
      projectName: row.projectName,
      rdActivityId: row.rdActivityId,
      rdActivityCode: row.rdActivityCode,
      hours: row.hours,
    }));
  const total = add(sum(ordered.map((row) => dec(row.hours))), other);
  return {
    timesheetIds: withHours.map((sheet) => sheet.id),
    periodDays,
    coveredDays: covered.size,
    allDaysCovered: periodDays > 0 && withHours.length > 0 && covered.size === periodDays,
    totalHours: money2(total),
    otherHours: money2(other),
    rows: ordered,
  };
}

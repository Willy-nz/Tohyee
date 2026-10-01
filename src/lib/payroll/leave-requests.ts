import { writeAuditEvent } from "@/lib/audit";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { cmp, dec, isPositive, parseDecimalInput, sum, toFixedString, toPlainString } from "@/lib/money/decimal";
import { hasPayrollAccess, PAYROLL_MINIMUM_ROLE } from "@/lib/payroll/access";
import { daysInclusive, eachDay } from "@/lib/payroll/leave/dates";
import { EMPLOYMENT_LEAVE_ACT_STARTS, LEAVE_TYPES, type LeaveType, NOT_SUPPORTED } from "@/lib/payroll/leave/rules";
import { BEREAVEMENT_KINDS, type BereavementKind } from "@/lib/payroll/leave/sick";
import { hoursAt, unitsOf } from "@/lib/payroll/leave/quantity";
import { isUsualWorkingDay, usualHoursOn, weekHours } from "@/lib/payroll/leave/work-pattern";
import { annualBalance, dayLeaveBalanceOf, loadEmployeeFacts, recordsStartWith, settingsOn, whyLeaveNotKept } from "@/lib/payroll/leave-facts";
import { createLeaveBooking, leaveBookingReference, loadSettingsList } from "@/lib/payroll/leave-records";
import { type Access, employeeAccess, employeesForActor } from "@/lib/payroll/timesheets";
import { optionalString, requireIdempotencyKey, requireOneOf } from "@/lib/validation";

/**
 * Employees' own leave requests (decision 169; examples HL49-HL51), like
 * P9's timesheets: an employee linked to their login asks for leave; their
 * timesheet approver (else their reports-to manager's login), or anyone with
 * payroll access, approves or rejects it, never the employee. Approving
 * books the leave (decision 141) as the approver, so the next pay run pays
 * it. Requests show days and hours, never pay; family violence leave is
 * "Special leave" to anyone but the employee and payroll access (decision
 * 27).
 */

export type LeaveRequestStatus = "pending" | "approved" | "rejected" | "withdrawn";

export type LeaveRequest = {
  id: string;
  reference: string;
  employeeId: string;
  employeeName: string;
  /** "special" stands for family violence leave to an approver without payroll access (decision 27). */
  leaveType: LeaveType | "special";
  startDate: string;
  endDate: string;
  /** Hours each working day in the request (from the usual week, or as asked for where hours vary). */
  dayHours: Record<string, string>;
  days: number;
  hours: string;
  bereavementKind: BereavementKind | null;
  note: string | null;
  status: LeaveRequestStatus;
  createdAt: string;
  createdByEmail: string;
  decidedAt: string | null;
  decidedByEmail: string | null;
  rejectionReason: string | null;
  booking: string | null;
  isOwn: boolean;
  canChange: boolean;
  canDecide: boolean;
};

type RequestRow = {
  id: string;
  request_number: string;
  employee_id: string;
  employee_name: string;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  day_hours: Record<string, string> | null;
  bereavement_kind: BereavementKind | null;
  note: string | null;
  status: LeaveRequestStatus;
  created_at: string;
  created_by_email: string;
  decided_at: string | null;
  decided_by_email: string | null;
  rejection_reason: string | null;
  booking_number: string | null;
  request_hash: string;
};

const SELECT = `select q.id::text, q.request_number::text, q.employee_id::text, e.first_name || ' ' || e.last_name as employee_name, q.leave_type,
    q.start_date::text, q.end_date::text, q.day_hours, q.bereavement_kind, q.note, q.status, q.created_at::text, q.created_by_email,
    q.decided_at::text, q.decided_by_email, q.rejection_reason, b.booking_number::text, q.request_hash
  from payroll_leave_requests q join payroll_employees e on e.id = q.employee_id
  left join payroll_leave_bookings b on b.id = q.booking_id`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(input: unknown, what: string): string {
  if (typeof input !== "string" || !UUID.test(input)) throw new NotFoundError(`That ${what} wasn't found.`);
  return input.toLowerCase();
}

export const LEAVE_REQUEST_ACCESS_MESSAGE = "You can only see your own leave requests, the ones you approve, or everyone's with payroll access.";

/** The working days and their hours for a request (decision 166 for hours that vary). */
async function workingDays(
  tx: OrgTx,
  employeeId: string,
  input: { startDate: string; endDate: string; dayHours: Record<string, string> | null },
): Promise<{ dayHours: Record<string, string>; asked: Record<string, string> | null; name: string }> {
  const facts = await loadEmployeeFacts(tx, employeeId, await loadSettingsList(tx, employeeId));
  const why = whyLeaveNotKept(facts, recordsStartWith(facts, null));
  if (why) throw new ValidationError(`Leave can't be asked for here yet: ${why}`);
  const settings = settingsOn(facts, input.startDate);
  if (!settings) throw new ValidationError(`${facts.name} has no usual week on ${formatDate(input.startDate)}.`);
  const dayHours: Record<string, string> = {};
  if (settings.pattern.kind === "fixed") {
    if (input.dayHours) throw new ValidationError("Your usual week gives the hours each day, so don't give them.");
    for (const date of eachDay(input.startDate, input.endDate)) {
      if (isUsualWorkingDay(settings.pattern, date)) dayHours[date] = toPlainString(usualHoursOn(settings.pattern, date));
    }
  } else {
    if (!input.dayHours) throw new ValidationError("Your hours vary, so give the hours you'd have worked each day of the leave.");
    Object.assign(dayHours, input.dayHours);
  }
  if (Object.keys(dayHours).length === 0) throw new ValidationError(`None of those days is a working day for ${facts.name}.`);
  return { dayHours, asked: settings.pattern.kind === "fixed" ? null : input.dayHours, name: facts.name };
}

function readDayHours(input: unknown, startDate: string, endDate: string): Record<string, string> | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new ValidationError("Hours each day must be an object of dates and hours.");
  const result: Record<string, string> = {};
  for (const [date, value] of Object.entries(input as Record<string, unknown>)) {
    const day = parseIsoDate(date, "Day");
    if (day < startDate || day > endDate) throw new ValidationError(`${formatDate(day)} isn't inside the leave.`);
    const hours = parseDecimalInput(value, `Hours on ${formatDate(day)}`, { maxScale: 2, allowZero: true });
    if (cmp(dec(hours), dec("24")) > 0) throw new ValidationError(`Hours on ${formatDate(day)} can't be more than 24.`);
    if (isPositive(dec(hours))) result[day] = hours;
  }
  return Object.keys(result).length ? result : null;
}

type Fields = { leaveType: LeaveType; startDate: string; endDate: string; dayHours: Record<string, string> | null; bereavementKind: BereavementKind | null; note: string | null };

function readFields(input: Record<string, unknown>, employee: { startDate: string; finishDate: string | null }): Fields {
  const leaveType = requireOneOf(input.leaveType, "Leave type", LEAVE_TYPES);
  const startDate = parseIsoDate(input.startDate, "Start date");
  const endDate = input.endDate === undefined || input.endDate === null || input.endDate === "" ? startDate : parseIsoDate(input.endDate, "End date");
  if (endDate < startDate) throw new ValidationError("The leave can't end before it starts.");
  if (daysInclusive(startDate, endDate) > 366) throw new ValidationError("Ask for a year or less at a time.");
  if (startDate >= EMPLOYMENT_LEAVE_ACT_STARTS) throw new ValidationError(`${NOT_SUPPORTED}: leave from 6 Aug 2028, under the Employment Leave Act 2026 (decision 7).`);
  if (startDate < employee.startDate) throw new ValidationError("The leave can't start before your employment does.");
  if (employee.finishDate && endDate > employee.finishDate) throw new ValidationError("The leave can't end after your last day.");
  if (leaveType === "alternative" && endDate !== startDate) throw new ValidationError("An alternative holiday is one whole working day (s 57(1)(c)); ask for each on its own.");
  const bereavementKind = leaveType === "bereavement" ? requireOneOf(input.bereavementKind, "Bereavement", BEREAVEMENT_KINDS) : null;
  return { leaveType, startDate, endDate, dayHours: readDayHours(input.dayHours, startDate, endDate), bereavementKind, note: optionalString(input.note, "Note", { maxLength: 1000 }) };
}

async function toRequest(tx: OrgTx, row: RequestRow, access: Access): Promise<LeaveRequest> {
  // Days and hours from the usual week (or as asked for); nothing about pay.
  let dayHours: Record<string, string> = row.day_hours ?? {};
  if (!row.day_hours) {
    const settings = await loadSettingsList(tx, row.employee_id);
    const pattern = (settings.find((entry) => entry.effectiveFrom <= row.start_date) ?? settings.at(-1))?.pattern;
    dayHours = {};
    if (pattern && pattern.kind === "fixed") {
      for (const date of eachDay(row.start_date, row.end_date)) if (isUsualWorkingDay(pattern, date)) dayHours[date] = toPlainString(usualHoursOn(pattern, date));
    }
  }
  const showType = access.own || access.payroll || row.leave_type !== "family_violence";
  return {
    id: row.id,
    reference: `LEAVEREQ-${row.request_number}`,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    leaveType: showType ? row.leave_type : "special",
    startDate: row.start_date,
    endDate: row.end_date,
    dayHours,
    days: Object.keys(dayHours).length,
    hours: toPlainString(sum(Object.values(dayHours).map((hours) => dec(hours)))),
    bereavementKind: showType ? row.bereavement_kind : null,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    createdByEmail: row.created_by_email,
    decidedAt: row.decided_at,
    decidedByEmail: row.decided_by_email,
    rejectionReason: row.rejection_reason,
    booking: row.booking_number ? leaveBookingReference(row.booking_number) : null,
    isOwn: access.own,
    canChange: access.own && row.status === "pending",
    canDecide: !access.own && (access.payroll || access.approver) && row.status === "pending",
  };
}

async function findRequest(tx: OrgTx, role: Role, idInput: unknown, forUpdate = false): Promise<{ row: RequestRow; access: Access }> {
  const id = uuid(idInput, "leave request");
  const result = await tx.query<RequestRow>(`${SELECT} where q.id = $1${forUpdate ? " for update of q" : ""}`, [id]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError("That leave request wasn't found.");
  const { access } = await employeeAccess(tx, role, row.employee_id);
  if (!access.own && !access.payroll && !access.approver) throw new ForbiddenError(LEAVE_REQUEST_ACCESS_MESSAGE);
  return { row, access };
}

export async function getLeaveRequest(tx: OrgTx, role: Role, idInput: unknown): Promise<LeaveRequest> {
  const { row, access } = await findRequest(tx, role, idInput);
  return toRequest(tx, row, access);
}

export type MyLeave = {
  employeeId: string;
  name: string;
  /** Balances in weeks, hours and days only (HL49); never amounts of money, never family violence leave. */
  annual: { weeks: string; hours: string } | null;
  sickDays: string | null;
  problem: string | null;
};

/**
 * Leave requests the signed-in person can see (decision 169): their own,
 * the ones they approve, or everyone's with payroll access; and their own
 * balances in weeks and days.
 */
export async function listLeaveRequests(
  tx: OrgTx,
  role: Role,
  filters: { status?: unknown; asAt?: unknown } = {},
): Promise<{ requests: LeaveRequest[]; mine: MyLeave[]; approves: number; asAt: string }> {
  const status = filters.status === undefined || filters.status === null || filters.status === "" ? null : requireOneOf(filters.status, "Status", ["pending", "approved", "rejected", "withdrawn"] as const);
  const { own, approves } = await employeesForActor(tx);
  const payroll = roleAtLeast(role, PAYROLL_MINIMUM_ROLE) && (await hasPayrollAccess(tx));
  const visible = payroll ? null : [...own, ...approves];
  const result = await tx.query<RequestRow>(
    `${SELECT} where ($1::uuid[] is null or q.employee_id = any($1::uuid[])) and ($2::text is null or q.status = $2)
      order by (q.status = 'pending') desc, q.start_date desc, q.request_number desc limit 500`,
    [visible, status],
  );
  const requests: LeaveRequest[] = [];
  for (const row of result.rows) {
    const { access } = await employeeAccess(tx, role, row.employee_id);
    requests.push(await toRequest(tx, row, access));
  }
  const mine: MyLeave[] = [];
  for (const employeeId of own) {
    const facts = await loadEmployeeFacts(tx, employeeId, await loadSettingsList(tx, employeeId));
    const why = whyLeaveNotKept(facts, recordsStartWith(facts, null));
    const today = filters.asAt ? parseIsoDate(filters.asAt, "As at") : todayIsoDate();
    if (why) {
      mine.push({ employeeId, name: facts.name, annual: null, sickDays: null, problem: why });
      continue;
    }
    const settings = settingsOn(facts, today) ?? facts.settings.at(-1)!;
    const annual = annualBalance(facts, today).balance;
    mine.push({
      employeeId,
      name: facts.name,
      annual: { weeks: toFixedString(unitsOf(annual, 8), 4), hours: toFixedString(hoursAt(annual, toPlainString(weekHours(settings.pattern)), 8), 2) },
      sickDays: toFixedString(unitsOf(dayLeaveBalanceOf(facts, "sick", today).balance, 8), 2),
      problem: null,
    });
  }
  return { requests, mine, approves: approves.length, asAt: filters.asAt ? parseIsoDate(filters.asAt, "As at") : todayIsoDate() };
}

/** Asks for leave (HL49): the employee themselves only. */
export async function createLeaveRequest(tx: OrgTx, role: Role, input: Record<string, unknown>): Promise<{ created: boolean; request: LeaveRequest }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const hash = requestHash("payroll_leave_request", input);
  const earlier = await tx.query<RequestRow>(`${SELECT} where q.idempotency_key = $1`, [idempotencyKey]);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "leave request");
    return { created: false, request: await getLeaveRequest(tx, role, earlier.rows[0].id) };
  }
  const { employee, access } = await employeeAccess(tx, role, input.employeeId, true);
  if (!access.own) throw new ForbiddenError("Only the employee can ask for their own leave; with payroll access, book it under Payroll › Leave.");
  if (employee.isArchived) throw new ValidationError("This employee is archived.");
  const fields = readFields(input, employee);
  const { asked } = await workingDays(tx, employee.id, fields);
  const inserted = await tx.query<{ id: string }>(
    `insert into payroll_leave_requests (idempotency_key, request_hash, employee_id, leave_type, start_date, end_date, day_hours, bereavement_kind, note,
                                         created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11) returning id::text`,
    [idempotencyKey, hash, employee.id, fields.leaveType, fields.startDate, fields.endDate, asked ? JSON.stringify(asked) : null, fields.bereavementKind, fields.note, tx.actor.userId, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "payroll_leave_request.created",
    entityType: "payroll_leave_request",
    entityId: id,
    details: { employeeId: employee.id, leaveType: fields.leaveType === "family_violence" ? "special" : fields.leaveType, startDate: fields.startDate, endDate: fields.endDate },
  });
  return { created: true, request: await getLeaveRequest(tx, role, id) };
}

/** Changes a request before it's decided (HL50): the employee only. */
export async function updateLeaveRequest(tx: OrgTx, role: Role, idInput: unknown, input: Record<string, unknown>): Promise<{ request: LeaveRequest }> {
  const { row, access } = await findRequest(tx, role, idInput, true);
  if (!access.own) throw new ForbiddenError("Only the employee can change their leave request.");
  if (row.status !== "pending") throw new ConflictError(`This request is already ${row.status}, so it can't be changed.`);
  const { employee } = await employeeAccess(tx, role, row.employee_id);
  const fields = readFields(input, employee);
  const { asked } = await workingDays(tx, employee.id, fields);
  await tx.query(
    `update payroll_leave_requests set leave_type = $2, start_date = $3, end_date = $4, day_hours = $5::jsonb, bereavement_kind = $6, note = $7, updated_at = now()
      where id = $1`,
    [row.id, fields.leaveType, fields.startDate, fields.endDate, asked ? JSON.stringify(asked) : null, fields.bereavementKind, fields.note],
  );
  await writeAuditEvent(tx, { eventType: "payroll_leave_request.changed", entityType: "payroll_leave_request", entityId: row.id, details: { startDate: fields.startDate, endDate: fields.endDate } });
  return { request: await getLeaveRequest(tx, role, row.id) };
}

/** Withdraws a request before it's decided (HL50): the employee only. */
export async function withdrawLeaveRequest(tx: OrgTx, role: Role, idInput: unknown): Promise<{ request: LeaveRequest }> {
  const { row, access } = await findRequest(tx, role, idInput, true);
  if (!access.own) throw new ForbiddenError("Only the employee can withdraw their leave request.");
  if (row.status !== "pending") throw new ConflictError(`This request is already ${row.status}, so it can't be withdrawn.`);
  await tx.query("update payroll_leave_requests set status = 'withdrawn', updated_at = now() where id = $1", [row.id]);
  await writeAuditEvent(tx, { eventType: "payroll_leave_request.withdrawn", entityType: "payroll_leave_request", entityId: row.id, details: {} });
  return { request: await getLeaveRequest(tx, role, row.id) };
}

function assertCanDecide(access: Access): void {
  if (access.own) throw new ForbiddenError("Someone else approves your leave.");
  if (!access.payroll && !access.approver) throw new ForbiddenError("Only the employee's approver, or someone with payroll access, can do that.");
}

/**
 * Approves a request (HL49): books the leave as the approver, linked to the
 * request. Anything the booking refuses refuses the approval with the same
 * reason, and the request stays waiting (HL51).
 */
export async function approveLeaveRequest(tx: OrgTx, role: Role, idInput: unknown): Promise<{ request: LeaveRequest; warnings: string[]; payRuns: string[] }> {
  const { row, access } = await findRequest(tx, role, idInput, true);
  assertCanDecide(access);
  if (row.status !== "pending") throw new ConflictError(`This request is already ${row.status}.`);
  const booked = await createLeaveBooking(
    tx,
    {
      idempotencyKey: `leave-request:${row.id}`,
      employeeId: row.employee_id,
      leaveType: row.leave_type,
      startDate: row.start_date,
      endDate: row.end_date,
      ...(row.day_hours ? { dayHours: row.day_hours } : {}),
      ...(row.bereavement_kind ? { bereavementKind: row.bereavement_kind } : {}),
      note: `From leave request LEAVEREQ-${row.request_number}${row.note ? `: ${row.note}` : ""}`.slice(0, 1000),
    },
    { fromApprovedRequest: true },
  );
  await tx.query(
    `update payroll_leave_requests set status = 'approved', decided_at = now(), decided_by_user_id = $2, decided_by_email = $3, booking_id = $4, updated_at = now()
      where id = $1`,
    [row.id, tx.actor.userId, tx.actor.email, booked.booking.id],
  );
  await writeAuditEvent(tx, { eventType: "payroll_leave_request.approved", entityType: "payroll_leave_request", entityId: row.id, details: { booking: booked.booking.reference } });
  // An approver without payroll access sees the warnings without amounts (they're in weeks).
  return { request: await getLeaveRequest(tx, role, row.id), warnings: booked.warnings, payRuns: access.payroll ? booked.payRuns : [] };
}

/** Rejects a request with a reason the employee sees (HL50). */
export async function rejectLeaveRequest(tx: OrgTx, role: Role, idInput: unknown, input: { reason: unknown }): Promise<{ request: LeaveRequest }> {
  const { row, access } = await findRequest(tx, role, idInput, true);
  assertCanDecide(access);
  if (row.status !== "pending") throw new ConflictError(`This request is already ${row.status}.`);
  const reason = optionalString(input.reason, "Reason", { maxLength: 1000 });
  if (!reason) throw new ValidationError("Give a reason; the employee sees it.");
  await tx.query(
    `update payroll_leave_requests set status = 'rejected', decided_at = now(), decided_by_user_id = $2, decided_by_email = $3, rejection_reason = $4, updated_at = now()
      where id = $1`,
    [row.id, tx.actor.userId, tx.actor.email, reason],
  );
  await writeAuditEvent(tx, { eventType: "payroll_leave_request.rejected", entityType: "payroll_leave_request", entityId: row.id, details: {} });
  return { request: await getLeaveRequest(tx, role, row.id) };
}

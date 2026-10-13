import { writeAuditEvent } from "@/lib/audit";
import { businessTimeZone, isoDateAt, parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { splitAddresses } from "@/lib/email/addresses";
import { readSendingAccount } from "@/lib/email/settings";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { addDays } from "@/lib/financial-year";
import { add, dec, type Decimal, divide, mul, parseDecimalInput, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { hasPayrollAccess, requirePayrollAccess } from "@/lib/payroll/access";
import { timesheetFirstDay } from "@/lib/payroll/pay-items";
import { payRateOn } from "@/lib/payroll/pay-rates";
import { isoWeekday, WEEKDAY_NAMES, weekStartOf } from "@/lib/payroll/timesheet-split";
import { optionalString, requireId, requireString } from "@/lib/validation";

/*
 * Rosters inside Payroll (examples RS1-RS4, decision 511; Deputy). An area
 * (such as the shop) has a weekly roster budget. Each week's roster has
 * shifts; their cost is the hours (less unpaid breaks) at the employee's
 * hourly rate plus the employer's KiwiSaver (Jess, 12 Oct 2026: wages and
 * KiwiSaver only). A shift on a day the employee is unavailable needs a
 * reason (RS2); one in approved leave is warned about and not counted
 * (RS3). Publishing keeps a copy of the shifts: that's what employees see,
 * and later changes are listed against it until published again (RS4).
 * Managing rosters needs payroll access, as they show pay. Nothing posts.
 */

export type RosterArea = { id: string; name: string; weeklyBudget: string | null; isActive: boolean };

export type RosterShift = {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  /** Paid minutes: start to end less the break. */
  minutes: number;
  hours: string;
  /** Null for a salaried employee (their pay doesn't change with the roster) or one with no pay rate yet. */
  hourlyRate: string | null;
  wages: string | null;
  kiwiSaver: string | null;
  cost: string | null;
  onLeave: boolean;
  unavailable: boolean;
  unavailableReason: string | null;
  warnings: string[];
};

export type RosterChange = { kind: "added" | "changed" | "removed"; employeeName: string; text: string };

export type RosterWeek = {
  area: RosterArea;
  weekStart: string;
  days: string[];
  rosterId: string | null;
  publishedAt: string | null;
  publishedByEmail: string | null;
  shifts: RosterShift[];
  /** Shifts in leave aren't counted (RS3). */
  totals: { hours: string; wages: string; kiwiSaver: string; cost: string };
  budget: string | null;
  /** Budget less cost; negative is over budget. */
  remaining: string | null;
  /** Shifts that aren't costed: salaried or without a pay rate. */
  notCosted: number;
  changes: RosterChange[];
  /** Rostered against clocked time (RS7), for each person on the roster; clocked time counts every area. */
  actuals: RosterActual[];
};

export type RosterActual = {
  employeeId: string;
  employeeName: string;
  rosteredHours: string;
  clockedHours: string;
  /** Clocked less rostered. */
  differenceHours: string;
  /** The difference at the hourly rate; null when not costed. */
  differenceCost: string | null;
  /** Shifts clocked in but not out yet. */
  stillOpen: number;
};

export type Unavailability = {
  id: string;
  employeeId: string;
  employeeName: string;
  weekday: number | null;
  fromDate: string | null;
  toDate: string | null;
  note: string | null;
  text: string;
};

export type MyShift = { areaName: string; date: string; startsAt: string; endsAt: string; breakMinutes: number; hours: string; publishedAt: string };

export type PublishedShift = { id: string; employeeId: string; startsAt: string; endsAt: string; breakMinutes: number };

const money = (value: Decimal) => toFixedString(value, 2);

function timeText(value: string): string {
  return new Date(value).toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Pacific/Auckland" });
}

function parseInstant(input: unknown, fieldName: string): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)) || !/T\d{2}:\d{2}/.test(input)) {
    throw new ValidationError(`${fieldName} must be a date and time, like 2026-10-24T09:00:00+13:00.`);
  }
  return new Date(input).toISOString();
}

function parseEmployeeId(input: unknown): string {
  if (typeof input !== "string" || !/^[0-9a-f-]{36}$/i.test(input)) throw new ValidationError("Choose an employee.");
  return input.toLowerCase();
}

function parseBreak(input: unknown): number {
  if (input === undefined || input === null || input === "") return 0;
  const minutes = Number(parseDecimalInput(input, "Break (minutes)", { maxScale: 0, allowZero: true }));
  if (minutes > 600) throw new ValidationError("A break can be at most 600 minutes.");
  return minutes;
}

// Areas -------------------------------------------------------------------------------

export async function listRosterAreas(tx: OrgTx): Promise<RosterArea[]> {
  await requirePayrollAccess(tx);
  const rows = await tx.query<{ id: string; name: string; weekly_budget: string | null; is_active: boolean }>(
    "select id::text, name, weekly_budget::text, is_active from payroll_roster_areas order by not is_active, lower(name), payroll_roster_areas.id",
  );
  return rows.rows.map((row) => ({ id: row.id, name: row.name, weeklyBudget: row.weekly_budget === null ? null : money(dec(row.weekly_budget)), isActive: row.is_active }));
}

/** Adds an area, or changes one's name, weekly budget or whether it's in use. */
export async function saveRosterArea(tx: OrgTx, input: { id?: unknown; name: unknown; weeklyBudget?: unknown; isActive?: unknown }): Promise<RosterArea[]> {
  await requirePayrollAccess(tx);
  const name = requireString(input.name, "Area name", { maxLength: 100 });
  const weeklyBudget =
    input.weeklyBudget === undefined || input.weeklyBudget === null || input.weeklyBudget === "" ? null : parseDecimalInput(input.weeklyBudget, "Weekly budget", { maxScale: 2, allowZero: true });
  const isActive = input.isActive === undefined ? true : input.isActive === true;
  const clash = await tx.query("select 1 from payroll_roster_areas where lower(name) = lower($1) and ($2::bigint is null or id <> $2)", [name, input.id ?? null]);
  if (clash.rowCount) throw new ValidationError(`There's already an area called ${name}.`);
  if (input.id) {
    const id = requireId(input.id, "areaId");
    const updated = await tx.query("update payroll_roster_areas set name = $2, weekly_budget = $3, is_active = $4 where id = $1", [id, name, weeklyBudget, isActive]);
    if (!updated.rowCount) throw new NotFoundError("Area not found.");
    await writeAuditEvent(tx, { eventType: "payroll_roster.area_changed", entityType: "payroll_roster_area", entityId: id, details: { name, isActive } });
  } else {
    const row = await tx.query<{ id: string }>("insert into payroll_roster_areas (name, weekly_budget, created_by_email) values ($1, $2, $3) returning id::text", [
      name,
      weeklyBudget,
      tx.actor.email,
    ]);
    await writeAuditEvent(tx, { eventType: "payroll_roster.area_added", entityType: "payroll_roster_area", entityId: row.rows[0].id, details: { name } });
  }
  return listRosterAreas(tx);
}

async function findArea(tx: OrgTx, areaIdInput: unknown): Promise<RosterArea> {
  const areaId = requireId(areaIdInput, "areaId");
  const area = (await listRosterAreas(tx)).find((entry) => entry.id === areaId);
  if (!area) throw new NotFoundError("Area not found.");
  return area;
}

async function rosterWeekStart(tx: OrgTx, input: unknown): Promise<string> {
  return weekStartOf(parseIsoDate(input, "Week starting"), await timesheetFirstDay(tx));
}

// Unavailability and leave -------------------------------------------------------------

type Employee = { id: string; name: string; start_date: string; finish_date: string | null; is_archived: boolean; user_id: string | null };

async function findEmployee(tx: OrgTx, employeeId: string): Promise<Employee> {
  const row = await tx.query<Employee>(
    "select id::text, first_name || ' ' || last_name as name, start_date::text, finish_date::text, is_archived, user_id::text from payroll_employees where id = $1",
    [employeeId],
  );
  if (!row.rows[0]) throw new NotFoundError("That employee wasn't found.");
  return row.rows[0];
}

/** The employee themselves (linked to their login) or someone with payroll access. */
async function assertOwnOrPayroll(tx: OrgTx, employee: Employee): Promise<void> {
  if (employee.user_id && employee.user_id === tx.actor.userId) return;
  if (await hasPayrollAccess(tx)) return;
  throw new ForbiddenError("Only the employee, or someone with payroll access, can see or change their availability.");
}

function unavailabilityText(row: { weekday: number | null; from_date: string | null; to_date: string | null }): string {
  if (row.weekday !== null) return `Every ${WEEKDAY_NAMES[row.weekday - 1]}`;
  return row.from_date === row.to_date ? `On ${row.from_date}` : `${row.from_date} to ${row.to_date}`;
}

type UnavailabilityRow = { id: string; employee_id: string; employee_name: string; weekday: number | null; from_date: string | null; to_date: string | null; note: string | null };

async function loadUnavailability(tx: OrgTx, employeeIds: string[]): Promise<UnavailabilityRow[]> {
  if (employeeIds.length === 0) return [];
  return (
    await tx.query<UnavailabilityRow>(
      `select u.id::text, u.employee_id::text, e.first_name || ' ' || e.last_name as employee_name, u.weekday, u.from_date::text, u.to_date::text, u.note
         from payroll_unavailability u join payroll_employees e on e.id = u.employee_id
        where u.status = 'active' and u.employee_id = any($1::uuid[]) order by u.employee_id, u.id`,
      [employeeIds],
    )
  ).rows;
}

/** The employee record linked to the signed-in person's login, if any. */
export async function ownEmployeeId(tx: OrgTx): Promise<string | null> {
  if (!tx.actor.userId) return null;
  const row = await tx.query<{ id: string }>("select id::text from payroll_employees where user_id = $1 and not is_archived order by start_date desc limit 1", [tx.actor.userId]);
  return row.rows[0]?.id ?? null;
}

async function employeeOrOwn(tx: OrgTx, input: unknown): Promise<Employee> {
  if (input === undefined || input === null || input === "") {
    const own = await ownEmployeeId(tx);
    if (!own) throw new NotFoundError("Your login isn't linked to an employee record. Ask whoever runs payroll to link it.");
    return findEmployee(tx, own);
  }
  return findEmployee(tx, parseEmployeeId(input));
}

/** An employee's unavailability; left out, the signed-in person's own. */
export async function listUnavailability(tx: OrgTx, input: { employeeId?: unknown }): Promise<Unavailability[]> {
  const employee = await employeeOrOwn(tx, input.employeeId);
  await assertOwnOrPayroll(tx, employee);
  return (await loadUnavailability(tx, [employee.id])).map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    weekday: row.weekday,
    fromDate: row.from_date,
    toDate: row.to_date,
    note: row.note,
    text: unavailabilityText(row),
  }));
}

/** Marks when an employee can't work (RS2): a weekday every week, or a date range. */
export async function addUnavailability(
  tx: OrgTx,
  input: { employeeId?: unknown; weekday?: unknown; fromDate?: unknown; toDate?: unknown; note?: unknown },
): Promise<Unavailability[]> {
  const employee = await employeeOrOwn(tx, input.employeeId);
  await assertOwnOrPayroll(tx, employee);
  const note = optionalString(input.note, "Note", { maxLength: 500 });
  let weekday: number | null = null;
  let fromDate: string | null = null;
  let toDate: string | null = null;
  if (input.weekday !== undefined && input.weekday !== null && input.weekday !== "") {
    weekday = Number(input.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new ValidationError("Choose a day of the week.");
  } else {
    fromDate = parseIsoDate(input.fromDate, "From");
    toDate = input.toDate ? parseIsoDate(input.toDate, "To") : fromDate;
    if (toDate < fromDate) throw new ValidationError("The end date can't be before the start date.");
  }
  await tx.query("insert into payroll_unavailability (employee_id, weekday, from_date, to_date, note, created_by_email) values ($1, $2, $3, $4, $5, $6)", [
    employee.id,
    weekday,
    fromDate,
    toDate,
    note,
    tx.actor.email,
  ]);
  await writeAuditEvent(tx, { eventType: "payroll_roster.unavailability_added", entityType: "payroll_employee", entityId: employee.id, details: { weekday, fromDate, toDate } });
  return listUnavailability(tx, { employeeId: employee.id });
}

export async function removeUnavailability(tx: OrgTx, idInput: unknown): Promise<Unavailability[]> {
  const id = requireId(idInput, "unavailabilityId");
  const row = await tx.query<{ employee_id: string }>("select employee_id::text from payroll_unavailability where id = $1 and status = 'active'", [id]);
  if (!row.rows[0]) throw new NotFoundError("That wasn't found.");
  const employee = await findEmployee(tx, row.rows[0].employee_id);
  await assertOwnOrPayroll(tx, employee);
  await tx.query("update payroll_unavailability set status = 'removed' where id = $1", [id]);
  await writeAuditEvent(tx, { eventType: "payroll_roster.unavailability_removed", entityType: "payroll_employee", entityId: employee.id, details: { unavailabilityId: id } });
  return listUnavailability(tx, { employeeId: employee.id });
}

function isUnavailable(rows: UnavailabilityRow[], employeeId: string, date: string): boolean {
  return rows.some(
    (row) => row.employee_id === employeeId && (row.weekday !== null ? isoWeekday(date) === row.weekday : row.from_date! <= date && date <= row.to_date!),
  );
}

/** Booked leave covering a day (RS3): approved requests and leave recorded directly. The kind of leave isn't shown: a roster only needs to know they're away. */
async function leaveDays(tx: OrgTx, employeeIds: string[], from: string, to: string): Promise<Array<{ employee_id: string; start_date: string; end_date: string }>> {
  if (employeeIds.length === 0) return [];
  return (
    await tx.query<{ employee_id: string; start_date: string; end_date: string }>(
      `select employee_id::text, start_date::text, end_date::text from payroll_leave_bookings
        where status = 'booked' and employee_id = any($1::uuid[]) and start_date <= $3 and end_date >= $2`,
      [employeeIds, from, to],
    )
  ).rows;
}

// Shifts ------------------------------------------------------------------------------

type ShiftRow = {
  id: string;
  employee_id: string;
  employee_name: string;
  starts_at: string;
  ends_at: string;
  break_minutes: number;
  unavailable_reason: string | null;
  kiwisaver_status: string;
  kiwisaver_employer_rate: string;
};

/** A shift's paid minutes, wages and employer KiwiSaver (RS1: 7.5 h x 25.00 = 187.50; 3% = 5.63). */
async function costShift(tx: OrgTx, row: ShiftRow, date: string) {
  const minutes = Math.round((Date.parse(row.ends_at) - Date.parse(row.starts_at)) / 60_000) - row.break_minutes;
  const rate = await payRateOn(tx, row.employee_id, date);
  const hourlyRate = rate && rate.payBasis === "hourly" && rate.hourlyRate ? rate.hourlyRate : null;
  if (!hourlyRate) return { minutes, hourlyRate: null, wages: null, kiwiSaver: null, cost: null };
  const wages = divide(mul(dec(hourlyRate), dec(String(minutes))), dec("60"), 2);
  // Rounded half up, as RS1 shows; pay runs work the real contribution out by IRD's rules.
  const kiwiSaver = row.kiwisaver_status === "enrolled" ? divide(mul(wages, dec(row.kiwisaver_employer_rate)), dec("100"), 2) : ZERO_DECIMAL;
  return { minutes, hourlyRate: money(dec(hourlyRate)), wages: money(wages), kiwiSaver: money(kiwiSaver), cost: money(add(wages, kiwiSaver)) };
}

async function loadShifts(tx: OrgTx, rosterId: string): Promise<ShiftRow[]> {
  return (
    await tx.query<ShiftRow>(
      `select s.id::text, s.employee_id::text, e.first_name || ' ' || e.last_name as employee_name, s.starts_at::text, s.ends_at::text, s.break_minutes,
              s.unavailable_reason, e.kiwisaver_status, e.kiwisaver_employer_rate::text
         from payroll_roster_shifts s join payroll_employees e on e.id = s.employee_id
        where s.roster_id = $1 and s.status = 'active' order by s.starts_at, employee_name, s.id`,
      [rosterId],
    )
  ).rows;
}

function hoursText(minutes: number): string {
  return money(divide(dec(String(minutes)), dec("60"), 2));
}

/** A week of an area's roster (RS1-RS4), with each shift's warnings and cost, and changes since it was published. */
export async function getRosterWeek(tx: OrgTx, input: { areaId: unknown; weekStart: unknown }): Promise<RosterWeek> {
  const area = await findArea(tx, input.areaId);
  const weekStart = await rosterWeekStart(tx, input.weekStart);
  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const roster = (
    await tx.query<{ id: string; published_at: string | null; published_by_email: string | null; published_shifts: PublishedShift[] | null }>(
      `select id::text, to_char(published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as published_at, published_by_email, published_shifts
       from payroll_rosters where area_id = $1 and week_start = $2`,
      [area.id, weekStart],
    )
  ).rows[0];
  const rows = roster ? await loadShifts(tx, roster.id) : [];
  const employeeIds = [...new Set(rows.map((row) => row.employee_id))];
  const unavailable = await loadUnavailability(tx, employeeIds);
  const leave = await leaveDays(tx, employeeIds, days[0], days[6]);
  const shifts: RosterShift[] = [];
  let hours = ZERO_DECIMAL;
  let wages = ZERO_DECIMAL;
  let kiwiSaver = ZERO_DECIMAL;
  let notCosted = 0;
  for (const row of rows) {
    const date = isoDateAt(new Date(row.starts_at));
    const costed = await costShift(tx, row, date);
    const onLeave = leave.some((entry) => entry.employee_id === row.employee_id && entry.start_date <= date && date <= entry.end_date);
    const isOff = isUnavailable(unavailable, row.employee_id, date);
    const first = row.employee_name.split(" ")[0];
    const warnings: string[] = [];
    if (onLeave) warnings.push(`${first} is on leave`);
    if (isOff) warnings.push(`${first} is unavailable${row.unavailable_reason ? ` (rostered anyway: ${row.unavailable_reason})` : ""}`);
    const clash = rows.find((other) => other.id !== row.id && other.employee_id === row.employee_id && other.starts_at < row.ends_at && other.ends_at > row.starts_at);
    if (clash) warnings.push(`${first} has two shifts at once`);
    if (!onLeave) {
      hours = add(hours, dec(String(costed.minutes)));
      if (costed.wages === null) notCosted += 1;
      else {
        wages = add(wages, dec(costed.wages));
        kiwiSaver = add(kiwiSaver, dec(costed.kiwiSaver!));
      }
    }
    shifts.push({
      id: row.id,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      date,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      breakMinutes: row.break_minutes,
      minutes: costed.minutes,
      hours: hoursText(costed.minutes),
      hourlyRate: costed.hourlyRate,
      wages: costed.wages,
      kiwiSaver: costed.kiwiSaver,
      cost: costed.cost,
      onLeave,
      unavailable: isOff,
      unavailableReason: row.unavailable_reason,
      warnings,
    });
  }
  const cost = add(wages, kiwiSaver);
  const actuals: RosterActual[] = [];
  const clocked = employeeIds.length
    ? (
        await tx.query<{ employee_id: string; clock_in_at: string; clock_out_at: string | null; break_minutes: number }>(
          `select employee_id::text, clock_in_at::text, clock_out_at::text, break_minutes from payroll_clock_records
            where employee_id = any($1::uuid[]) and clock_in_at >= $2::timestamp at time zone 'Pacific/Auckland'
              and clock_in_at < ($3::date + 1)::timestamp at time zone 'Pacific/Auckland'`,
          [employeeIds, days[0], days[6]],
        )
      ).rows
    : [];
  for (const employeeId of employeeIds) {
    const mine = shifts.filter((shift) => shift.employeeId === employeeId && !shift.onLeave);
    const rostered = mine.reduce((total, shift) => total + shift.minutes, 0);
    const records = clocked.filter((row) => row.employee_id === employeeId);
    const done = records.filter((row) => row.clock_out_at !== null);
    const clockedMinutes = done.reduce((total, row) => total + Math.floor((Date.parse(row.clock_out_at!) - Date.parse(row.clock_in_at)) / 60_000) - row.break_minutes, 0);
    const difference = divide(dec(String(clockedMinutes - rostered)), dec("60"), 2);
    const rate = mine.find((shift) => shift.hourlyRate !== null)?.hourlyRate ?? null;
    actuals.push({
      employeeId,
      employeeName: shifts.find((shift) => shift.employeeId === employeeId)!.employeeName,
      rosteredHours: hoursText(rostered),
      clockedHours: hoursText(clockedMinutes),
      differenceHours: money(difference),
      differenceCost: rate === null ? null : money(divide(mul(dec(String(clockedMinutes - rostered)), dec(rate)), dec("60"), 2)),
      stillOpen: records.length - done.length,
    });
  }
  return {
    area,
    weekStart,
    days,
    rosterId: roster?.id ?? null,
    publishedAt: roster?.published_at ?? null,
    publishedByEmail: roster?.published_by_email ?? null,
    shifts,
    totals: { hours: money(divide(hours, dec("60"), 2)), wages: money(wages), kiwiSaver: money(kiwiSaver), cost: money(cost) },
    budget: area.weeklyBudget,
    remaining: area.weeklyBudget === null ? null : money(sub(dec(area.weeklyBudget), cost)),
    notCosted,
    actuals,
    changes: roster?.published_shifts ? changesSince(roster.published_shifts, shifts, await employeeNames(tx, roster.published_shifts)) : [],
  };
}

function shiftText(shift: { startsAt: string; endsAt: string; breakMinutes: number }): string {
  const date = isoDateAt(new Date(shift.startsAt));
  return `${WEEKDAY_NAMES[isoWeekday(date) - 1].slice(0, 3)} ${date.slice(8)}/${date.slice(5, 7)} ${timeText(shift.startsAt)}-${timeText(shift.endsAt)}${shift.breakMinutes ? `, ${shift.breakMinutes} min break` : ""}`;
}

/** Shifts added, changed or removed since publishing (RS4). */
async function employeeNames(tx: OrgTx, shifts: PublishedShift[]): Promise<Map<string, string>> {
  const ids = [...new Set(shifts.map((shift) => shift.employeeId))];
  const rows = await tx.query<{ id: string; name: string }>("select id::text, first_name || ' ' || last_name as name from payroll_employees where id = any($1::uuid[])", [ids]);
  return new Map(rows.rows.map((row) => [row.id, row.name]));
}

function changesSince(published: PublishedShift[], current: RosterShift[], names: Map<string, string>): RosterChange[] {
  const changes: RosterChange[] = [];
  for (const shift of current) {
    const before = published.find((entry) => entry.id === shift.id);
    if (!before) changes.push({ kind: "added", employeeName: shift.employeeName, text: `Added ${shiftText(shift)}` });
    else if (Date.parse(before.startsAt) !== Date.parse(shift.startsAt) || Date.parse(before.endsAt) !== Date.parse(shift.endsAt) || before.breakMinutes !== shift.breakMinutes || before.employeeId !== shift.employeeId) {
      changes.push({ kind: "changed", employeeName: shift.employeeName, text: `${shiftText(before)} is now ${shiftText(shift)}` });
    }
  }
  for (const before of published) {
    if (!current.some((shift) => shift.id === before.id)) {
      changes.push({ kind: "removed", employeeName: names.get(before.employeeId) ?? "", text: `Removed ${shiftText(before)}` });
    }
  }
  return changes;
}

async function rosterFor(tx: OrgTx, areaId: string, weekStart: string): Promise<string> {
  const existing = await tx.query<{ id: string }>("select id::text from payroll_rosters where area_id = $1 and week_start = $2", [areaId, weekStart]);
  if (existing.rows[0]) return existing.rows[0].id;
  const row = await tx.query<{ id: string }>(
    "insert into payroll_rosters (area_id, week_start) values ($1, $2) on conflict (area_id, week_start) do update set week_start = excluded.week_start returning id::text",
    [areaId, weekStart],
  );
  return row.rows[0].id;
}

type ShiftInput = { employeeId: unknown; startsAt: unknown; endsAt: unknown; breakMinutes?: unknown; unavailableReason?: unknown };

/** Checks a shift: the employee works here then, and a day they're unavailable has a reason (RS2). Leave only warns (RS3). */
async function checkShift(tx: OrgTx, input: ShiftInput) {
  const employee = await findEmployee(tx, parseEmployeeId(input.employeeId));
  const startsAt = parseInstant(input.startsAt, "The start");
  const endsAt = parseInstant(input.endsAt, "The end");
  if (endsAt <= startsAt) throw new ValidationError("A shift has to end after it starts.");
  if (Date.parse(endsAt) - Date.parse(startsAt) > 24 * 3_600_000) throw new ValidationError("A shift can be at most 24 hours.");
  const breakMinutes = parseBreak(input.breakMinutes);
  if ((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000 <= breakMinutes) throw new ValidationError("The break is as long as the shift.");
  const date = isoDateAt(new Date(startsAt));
  if (employee.is_archived) throw new ValidationError(`${employee.name} is archived.`);
  if (date < employee.start_date) throw new ValidationError(`${employee.name} starts on ${employee.start_date}.`);
  if (employee.finish_date && date > employee.finish_date) throw new ValidationError(`${employee.name} finished on ${employee.finish_date}.`);
  const reason = optionalString(input.unavailableReason, "Reason", { maxLength: 500 });
  const unavailable = isUnavailable(await loadUnavailability(tx, [employee.id]), employee.id, date);
  if (unavailable && !reason) {
    throw new ConflictError(`${employee.name.split(" ")[0]} is unavailable. Give a reason to roster them anyway.`);
  }
  return { employee, startsAt, endsAt, breakMinutes, date, reason: unavailable ? reason : null };
}

/** Adds a shift to an area's roster for the week it's in (RS1-RS3). */
export async function addShift(tx: OrgTx, input: ShiftInput & { areaId: unknown }): Promise<RosterWeek> {
  const area = await findArea(tx, input.areaId);
  if (!area.isActive) throw new ValidationError(`${area.name} isn't in use.`);
  const shift = await checkShift(tx, input);
  const weekStart = weekStartOf(shift.date, await timesheetFirstDay(tx));
  const rosterId = await rosterFor(tx, area.id, weekStart);
  const row = await tx.query<{ id: string }>(
    `insert into payroll_roster_shifts (roster_id, employee_id, starts_at, ends_at, break_minutes, unavailable_reason, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7) returning id::text`,
    [rosterId, shift.employee.id, shift.startsAt, shift.endsAt, shift.breakMinutes, shift.reason, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "payroll_roster.shift_added", entityType: "payroll_roster", entityId: rosterId, details: { shiftId: row.rows[0].id, employeeId: shift.employee.id } });
  return getRosterWeek(tx, { areaId: area.id, weekStart });
}

async function findShift(tx: OrgTx, idInput: unknown) {
  const id = requireId(idInput, "shiftId");
  const row = await tx.query<{ roster_id: string; area_id: string; week_start: string }>(
    `select s.roster_id::text, r.area_id::text, r.week_start::text from payroll_roster_shifts s join payroll_rosters r on r.id = s.roster_id
      where s.id = $1 and s.status = 'active'`,
    [id],
  );
  if (!row.rows[0]) throw new NotFoundError("Shift not found.");
  return { id, ...row.rows[0] };
}

/** Changes a shift; it stays in the week it was rostered in. */
export async function updateShift(tx: OrgTx, idInput: unknown, input: ShiftInput): Promise<RosterWeek> {
  await requirePayrollAccess(tx);
  const found = await findShift(tx, idInput);
  const shift = await checkShift(tx, input);
  if (weekStartOf(shift.date, await timesheetFirstDay(tx)) !== found.week_start) {
    throw new ValidationError("Move a shift to another week by removing it and adding it there.");
  }
  await tx.query(
    "update payroll_roster_shifts set employee_id = $2, starts_at = $3, ends_at = $4, break_minutes = $5, unavailable_reason = $6, updated_at = now() where id = $1",
    [found.id, shift.employee.id, shift.startsAt, shift.endsAt, shift.breakMinutes, shift.reason],
  );
  await writeAuditEvent(tx, { eventType: "payroll_roster.shift_changed", entityType: "payroll_roster", entityId: found.roster_id, details: { shiftId: found.id, employeeId: shift.employee.id } });
  return getRosterWeek(tx, { areaId: found.area_id, weekStart: found.week_start });
}

export async function removeShift(tx: OrgTx, idInput: unknown): Promise<RosterWeek> {
  await requirePayrollAccess(tx);
  const found = await findShift(tx, idInput);
  await tx.query("update payroll_roster_shifts set status = 'removed', updated_at = now() where id = $1", [found.id]);
  await writeAuditEvent(tx, { eventType: "payroll_roster.shift_removed", entityType: "payroll_roster", entityId: found.roster_id, details: { shiftId: found.id } });
  return getRosterWeek(tx, { areaId: found.area_id, weekStart: found.week_start });
}

export type RosterEmailResult = {
  /** Who was emailed their shifts. */
  emailed: string[];
  /** Who wasn't, and why (no email address, or email isn't set up). */
  notEmailed: Array<{ name: string; reason: string }>;
};

const SHIFT_DAY = new Intl.DateTimeFormat("en-NZ", { timeZone: businessTimeZone(), weekday: "long", day: "numeric", month: "long" });
const SHIFT_TIME = new Intl.DateTimeFormat("en-NZ", { timeZone: businessTimeZone(), hour: "numeric", minute: "2-digit", hour12: true });

function shiftLine(shift: PublishedShift): string {
  const time = (iso: string) => SHIFT_TIME.format(new Date(iso)).replace(/\s/g, "").toLowerCase();
  const breakText = shift.breakMinutes > 0 ? ` (${shift.breakMinutes} min unpaid break)` : "";
  return `- ${SHIFT_DAY.format(new Date(shift.startsAt))}, ${time(shift.startsAt)} to ${time(shift.endsAt)}${breakText}`;
}

/**
 * The email telling an employee their shifts for the week (RS4): their own
 * shifts only, in the business time zone, and never any pay figures.
 */
export function rosterEmailText(input: {
  firstName: string;
  employer: string;
  areaName: string;
  weekStart: string;
  shifts: PublishedShift[];
  changed: boolean;
  hasLogin: boolean;
}): { subject: string; body: string } {
  const week = new Intl.DateTimeFormat("en-NZ", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${input.weekStart}T00:00:00Z`));
  const subject = `${input.changed ? "Your shifts have changed" : "Your shifts"}: ${input.areaName}, week starting ${week}`.slice(0, 250);
  const lines = [`Kia ora ${input.firstName},`, ""];
  if (input.shifts.length === 0) {
    lines.push(`You no longer have any shifts at ${input.areaName} in the week starting ${week}.`);
  } else {
    lines.push(`${input.changed ? "Your shifts have changed. They are now" : "Your shifts"} at ${input.areaName} for the week starting ${week}:`, "", ...input.shifts.map(shiftLine));
  }
  if (input.hasLogin) lines.push("", "You can also see them in Tohyee under Payroll > My shifts.");
  lines.push("", input.employer);
  return { subject, body: lines.join("\n").slice(0, 5000) };
}

function sameShifts(a: PublishedShift[], b: PublishedShift[]): boolean {
  const key = (list: PublishedShift[]) => JSON.stringify(list.map((shift) => [shift.startsAt, shift.endsAt, shift.breakMinutes]).sort());
  return key(a) === key(b);
}

/**
 * Publishes the week (RS4): employees see these shifts; later changes are
 * listed until it's published again. With `emailStaff`, each employee whose
 * shifts are new or changed by this publish is emailed them (the first
 * publish emails everyone on it; a later one only those whose shifts
 * changed, including anyone taken off). Sent by the email job.
 */
export async function publishRoster(tx: OrgTx, input: { areaId: unknown; weekStart: unknown; emailStaff?: unknown }): Promise<RosterWeek & { emails: RosterEmailResult | null }> {
  const area = await findArea(tx, input.areaId);
  const weekStart = await rosterWeekStart(tx, input.weekStart);
  const rosterId = await rosterFor(tx, area.id, weekStart);
  if (input.emailStaff !== undefined && typeof input.emailStaff !== "boolean") throw new ValidationError("emailStaff must be true or false.");
  const before = await tx.query<{ published_shifts: PublishedShift[] | null }>("select published_shifts from payroll_rosters where id = $1 for update", [rosterId]);
  const previous = before.rows[0].published_shifts;
  const shifts: PublishedShift[] = (await loadShifts(tx, rosterId)).map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    breakMinutes: row.break_minutes,
  }));
  if (shifts.length === 0 && !previous) throw new ValidationError("Add shifts before publishing.");
  const published = await tx.query<{ published_at: string }>(
    "update payroll_rosters set published_at = now(), published_by_email = $2, published_shifts = $3::jsonb where id = $1 returning published_at::text",
    [rosterId, tx.actor.email, JSON.stringify(shifts)],
  );
  let emails: RosterEmailResult | null = null;
  if (input.emailStaff === true) {
    const ids = [...new Set([...shifts, ...(previous ?? [])].map((shift) => shift.employeeId))];
    const mine = (list: PublishedShift[] | null, id: string) => (list ?? []).filter((shift) => shift.employeeId === id);
    const changed = ids.filter((id) => !previous || !sameShifts(mine(previous, id), mine(shifts, id)));
    emails = { emailed: [], notEmailed: [] };
    if (changed.length > 0) {
      const people = await tx.query<{ id: string; first_name: string; name: string; email: string | null; user_id: string | null }>(
        "select id::text, first_name, first_name || ' ' || last_name as name, email, user_id::text from payroll_employees where id = any($1::uuid[]) order by first_name, last_name",
        [changed],
      );
      let emailReady = true;
      try {
        await readSendingAccount(tx);
      } catch {
        emailReady = false;
      }
      const employer = (await getOrganisationSettings(tx)).displayName;
      for (const person of people.rows) {
        const to = splitAddresses([person.email ?? ""]).addresses[0];
        if (!emailReady) {
          emails.notEmailed.push({ name: person.name, reason: "Email isn't set up for this organisation (Settings > Email)." });
          continue;
        }
        if (!to) {
          emails.notEmailed.push({ name: person.name, reason: "No email address. Add it under Payroll > Employees." });
          continue;
        }
        const text = rosterEmailText({
          firstName: person.first_name,
          employer,
          areaName: area.name,
          weekStart,
          shifts: mine(shifts, person.id),
          changed: Boolean(previous),
          hasLogin: person.user_id !== null,
        });
        await tx.query(
          "insert into roster_emails (roster_id, published_at, employee_id, to_email, subject, body) values ($1, $2, $3, $4, $5, $6) on conflict do nothing",
          [rosterId, published.rows[0].published_at, person.id, to, text.subject, text.body],
        );
        emails.emailed.push(person.name);
      }
    }
  }
  await writeAuditEvent(tx, {
    eventType: "payroll_roster.published",
    entityType: "payroll_roster",
    entityId: rosterId,
    details: { areaId: area.id, weekStart, shifts: shifts.length, emailed: emails?.emailed.length ?? 0 },
  });
  return { ...(await getRosterWeek(tx, { areaId: area.id, weekStart })), emails };
}

/** The signed-in person's published shifts (RS4), from the employee record linked to their login. No payroll access needed. */
export async function myShifts(tx: OrgTx, input: { from: unknown; to: unknown }): Promise<MyShift[]> {
  const from = parseIsoDate(input.from, "from");
  const to = parseIsoDate(input.to, "to");
  if (!tx.actor.userId) return [];
  const rows = await tx.query<{ area_name: string; published_at: string; shift: PublishedShift }>(
    `select a.name as area_name, r.published_at::text, s.shift
       from payroll_rosters r join payroll_roster_areas a on a.id = r.area_id
       cross join lateral jsonb_array_elements(r.published_shifts) as s(shift)
       join payroll_employees e on e.id = (s.shift->>'employeeId')::uuid
      where r.published_shifts is not null and e.user_id = $1 and r.week_start between $2::date - 6 and $3::date`,
    [tx.actor.userId, from, to],
  );
  return rows.rows
    .map((row) => {
      const date = isoDateAt(new Date(row.shift.startsAt));
      const minutes = Math.round((Date.parse(row.shift.endsAt) - Date.parse(row.shift.startsAt)) / 60_000) - row.shift.breakMinutes;
      return { areaName: row.area_name, date, startsAt: row.shift.startsAt, endsAt: row.shift.endsAt, breakMinutes: row.shift.breakMinutes, hours: hoursText(minutes), publishedAt: row.published_at };
    })
    .filter((shift) => shift.date >= from && shift.date <= to)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { isoDateAt, parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { add, cmp, dec, divide, toFixedString } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { timesheetFirstDay } from "@/lib/payroll/pay-items";
import { weekStartOf } from "@/lib/payroll/timesheet-split";
import { requireId, requireString } from "@/lib/validation";

/*
 * Clocking in (examples RS5-RS8, decision 512; Deputy). Employees clock in
 * and out with a PIN on a shared device at the shop, login or not (Jess,
 * 12 Oct 2026), with no location recorded (8 Oct). The device is set up by
 * someone with payroll access and holds a secret in a cookie; it can only
 * clock people in and out. Clocked time goes onto the employee's timesheet
 * as "other work", marked from clock-in, unrounded (8 Oct: exact minutes),
 * for their approver to approve as any timesheet. One not clocked out by
 * midnight needs attention: nothing goes to the timesheet until a manager
 * enters the out time.
 */

export type ClockDevice = { id: string; name: string; createdAt: string; createdByEmail: string; lastUsedAt: string | null; revokedAt: string | null };

export type ClockStatus = "out" | "in" | "on_break";

export type ClockBoardEmployee = { employeeId: string; name: string; status: ClockStatus; since: string | null };

export type ClockRecordStatus = "open" | "needs_attention" | "closed";

export type ClockRecord = {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  clockInAt: string;
  clockOutAt: string | null;
  breakMinutes: number;
  onBreakSince: string | null;
  /** Clock-in to clock-out less breaks, once clocked out. */
  minutes: number | null;
  hours: string | null;
  status: ClockRecordStatus;
  outEnteredByEmail: string | null;
  outReason: string | null;
  onTimesheet: boolean;
  timesheetProblem: string | null;
  deviceName: string | null;
};

export type ClockPinState = { employeeId: string; name: string; hasPin: boolean; lockedUntil: string | null };

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const NZ = "Pacific/Auckland";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseEmployeeId(input: unknown): string {
  if (typeof input !== "string" || !/^[0-9a-f-]{36}$/i.test(input)) throw new ValidationError("Choose an employee.");
  return input.toLowerCase();
}

function parseAt(input: unknown, fieldName: string): string {
  if (input === undefined || input === null || input === "") return new Date().toISOString();
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)) || !/T\d{2}:\d{2}/.test(input)) {
    throw new ValidationError(`${fieldName} must be a date and time, like 2026-10-24T17:06:00+13:00.`);
  }
  return new Date(input).toISOString();
}

function timeText(value: string): string {
  return new Date(value).toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: NZ });
}

// Devices --------------------------------------------------------------------------------

export async function listClockDevices(tx: OrgTx): Promise<ClockDevice[]> {
  await requirePayrollAccess(tx);
  const rows = await tx.query<{ id: string; name: string; created_at: string; created_by_email: string; last_used_at: string | null; revoked_at: string | null }>(
    "select id::text, name, created_at::text, created_by_email, last_used_at::text, revoked_at::text from payroll_clock_devices order by revoked_at is not null, payroll_clock_devices.id",
  );
  return rows.rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, createdByEmail: row.created_by_email, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at }));
}

/**
 * Sets up a shared clock-in device (RS5). The token is returned once, for the
 * device's cookie; only its hash is kept.
 */
export async function addClockDevice(tx: OrgTx, input: { name: unknown }): Promise<{ device: ClockDevice; token: string }> {
  await requirePayrollAccess(tx);
  const name = requireString(input.name, "Device name", { maxLength: 100 });
  const secret = randomBytes(32).toString("base64url");
  const row = await tx.query<{ id: string }>("insert into payroll_clock_devices (name, token_hash, created_by_email) values ($1, $2, $3) returning id::text", [
    name,
    sha256(secret),
    tx.actor.email,
  ]);
  await writeAuditEvent(tx, { eventType: "payroll_clock.device_added", entityType: "payroll_clock_device", entityId: row.rows[0].id, details: { name } });
  const device = (await listClockDevices(tx)).find((entry) => entry.id === row.rows[0].id)!;
  return { device, token: `${tx.organisationId}.${row.rows[0].id}.${secret}` };
}

export async function revokeClockDevice(tx: OrgTx, idInput: unknown): Promise<ClockDevice[]> {
  await requirePayrollAccess(tx);
  const id = requireId(idInput, "deviceId");
  const updated = await tx.query("update payroll_clock_devices set revoked_at = now(), revoked_by_email = $2 where id = $1 and revoked_at is null", [id, tx.actor.email]);
  if (!updated.rowCount) throw new NotFoundError("That device wasn't found, or is already stopped.");
  await writeAuditEvent(tx, { eventType: "payroll_clock.device_revoked", entityType: "payroll_clock_device", entityId: id, details: {} });
  return listClockDevices(tx);
}

/** A device token's parts, checked for shape only: `organisationId.deviceId.secret`. */
export function parseDeviceToken(token: string | null): { organisationId: string; deviceId: string; secret: string } | null {
  if (!token) return null;
  const match = /^([a-z0-9][a-z0-9-]{0,31})\.([1-9][0-9]{0,18})\.([A-Za-z0-9_-]{43})$/.exec(token);
  return match ? { organisationId: match[1], deviceId: match[2], secret: match[3] } : null;
}

/** The device a token belongs to, if it's still in use. */
export async function deviceFromToken(tx: OrgTx, token: { deviceId: string; secret: string }): Promise<{ id: string; name: string }> {
  const row = await tx.query<{ id: string; name: string; token_hash: string; revoked_at: string | null }>(
    "select id::text, name, token_hash, revoked_at::text from payroll_clock_devices where id = $1",
    [token.deviceId],
  );
  const device = row.rows[0];
  if (!device || device.revoked_at || !sameHash(device.token_hash, sha256(token.secret))) {
    throw new UnauthorizedError("This device isn't set up for clocking in, or has been stopped. Someone with payroll access can set it up again.");
  }
  await tx.query("update payroll_clock_devices set last_used_at = now() where id = $1", [device.id]);
  return { id: device.id, name: device.name };
}

// PINs ----------------------------------------------------------------------------------

export async function listClockPins(tx: OrgTx): Promise<ClockPinState[]> {
  await requirePayrollAccess(tx);
  const rows = await tx.query<{ id: string; name: string; has_pin: boolean; locked_until: string | null }>(
    `select id::text, first_name || ' ' || last_name as name, clock_pin_hash is not null as has_pin,
            case when clock_pin_locked_until > now() then clock_pin_locked_until::text end as locked_until
       from payroll_employees where not is_archived order by first_name, last_name, payroll_employees.id`,
  );
  return rows.rows.map((row) => ({ employeeId: row.id, name: row.name, hasPin: row.has_pin, lockedUntil: row.locked_until }));
}

/** Sets an employee's clock-in PIN (4 to 8 digits), or clears it with `pin: null`. Payroll access. */
export async function setClockPin(tx: OrgTx, input: { employeeId: unknown; pin: unknown }): Promise<ClockPinState[]> {
  await requirePayrollAccess(tx);
  const employeeId = parseEmployeeId(input.employeeId);
  let hash: string | null = null;
  if (input.pin !== null) {
    if (typeof input.pin !== "string" || !/^[0-9]{4,8}$/.test(input.pin)) throw new ValidationError("A PIN is 4 to 8 digits.");
    hash = await hashPassword(input.pin);
  }
  const updated = await tx.query("update payroll_employees set clock_pin_hash = $2, clock_pin_failures = 0, clock_pin_locked_until = null where id = $1", [employeeId, hash]);
  if (!updated.rowCount) throw new NotFoundError("That employee wasn't found.");
  await writeAuditEvent(tx, { eventType: hash ? "payroll_clock.pin_set" : "payroll_clock.pin_cleared", entityType: "payroll_employee", entityId: employeeId, details: {} });
  return listClockPins(tx);
}

// Records -------------------------------------------------------------------------------

type RecordRow = {
  id: string;
  employee_id: string;
  employee_name: string;
  clock_in_at: string;
  clock_out_at: string | null;
  break_started_at: string | null;
  break_minutes: number;
  out_entered_by_email: string | null;
  out_reason: string | null;
  timesheet_entry_id: string | null;
  timesheet_problem: string | null;
  device_name: string | null;
};

const RECORD_SELECT = `select c.id::text, c.employee_id::text, e.first_name || ' ' || e.last_name as employee_name, c.clock_in_at::text, c.clock_out_at::text,
    c.break_started_at::text, c.break_minutes, c.out_entered_by_email, c.out_reason, c.timesheet_entry_id::text, c.timesheet_problem, d.name as device_name
  from payroll_clock_records c join payroll_employees e on e.id = c.employee_id left join payroll_clock_devices d on d.id = c.device_id`;

function workedMinutes(row: { clock_in_at: string; clock_out_at: string | null; break_minutes: number }): number | null {
  if (!row.clock_out_at) return null;
  return Math.floor((Date.parse(row.clock_out_at) - Date.parse(row.clock_in_at)) / 60_000) - row.break_minutes;
}

function hoursOf(minutes: number): string {
  return toFixedString(divide(dec(String(minutes)), dec("60"), 2), 2);
}

/** Open past midnight (in New Zealand) on the day it started: it needs a manager (RS8). */
function isStale(row: { clock_in_at: string; clock_out_at: string | null }, now: Date): boolean {
  return row.clock_out_at === null && isoDateAt(new Date(row.clock_in_at)) < isoDateAt(now);
}

function toRecord(row: RecordRow, now: Date): ClockRecord {
  const minutes = workedMinutes(row);
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    date: isoDateAt(new Date(row.clock_in_at)),
    clockInAt: row.clock_in_at,
    clockOutAt: row.clock_out_at,
    breakMinutes: row.break_minutes,
    onBreakSince: row.break_started_at,
    minutes,
    hours: minutes === null ? null : hoursOf(Math.max(minutes, 0)),
    status: row.clock_out_at ? "closed" : isStale(row, now) ? "needs_attention" : "open",
    outEnteredByEmail: row.out_entered_by_email,
    outReason: row.out_reason,
    onTimesheet: row.timesheet_entry_id !== null,
    timesheetProblem: row.timesheet_problem,
    deviceName: row.device_name,
  };
}

/** Clock records between two dates, and every one that needs attention whenever it was (RS5, RS8). Payroll access. */
export async function listClockRecords(tx: OrgTx, input: { from: unknown; to: unknown; now?: Date }): Promise<{ records: ClockRecord[]; needsAttention: ClockRecord[] }> {
  await requirePayrollAccess(tx);
  const from = parseIsoDate(input.from, "from");
  const to = parseIsoDate(input.to, "to");
  const now = input.now ?? new Date();
  const rows = await tx.query<RecordRow>(
    `${RECORD_SELECT}
      where (c.clock_in_at >= $1::timestamp at time zone '${NZ}' and c.clock_in_at < ($2::date + 1)::timestamp at time zone '${NZ}')
         or c.clock_out_at is null or c.timesheet_problem is not null
      order by c.clock_in_at, c.id limit 2000`,
    [from, to],
  );
  const records = rows.rows.map((row) => toRecord(row, now));
  return {
    records: records.filter((record) => record.date >= from && record.date <= to),
    needsAttention: records.filter((record) => record.status === "needs_attention" || (record.status === "closed" && record.timesheetProblem !== null)),
  };
}

async function getRecord(tx: OrgTx, id: string, now: Date): Promise<ClockRecord> {
  const row = await tx.query<RecordRow>(`${RECORD_SELECT} where c.id = $1`, [id]);
  if (!row.rows[0]) throw new NotFoundError("That clock-in wasn't found.");
  return toRecord(row.rows[0], now);
}

/**
 * Puts a clocked shift onto the employee's timesheet (RS6): its exact
 * minutes as hours to 2 places, added to the day's "other work" and marked
 * from clock-in. A week already submitted or approved is left alone and the
 * record says why.
 */
async function fillTimesheet(tx: OrgTx, recordId: string): Promise<void> {
  const row = (await tx.query<RecordRow>(`${RECORD_SELECT} where c.id = $1 for update of c`, [recordId])).rows[0];
  if (!row || !row.clock_out_at || row.timesheet_entry_id) return;
  const minutes = workedMinutes(row)!;
  const problem = async (text: string) => {
    await tx.query("update payroll_clock_records set timesheet_problem = $2 where id = $1", [recordId, text]);
  };
  if (minutes <= 0) return problem("No time worked once breaks are taken off.");
  if (minutes > 24 * 60) return problem("More than 24 hours: check the times and enter them on the timesheet by hand.");
  const date = isoDateAt(new Date(row.clock_in_at));
  const employee = (
    await tx.query<{ start_date: string; finish_date: string | null }>("select start_date::text, finish_date::text from payroll_employees where id = $1", [row.employee_id])
  ).rows[0];
  if (date < employee.start_date || (employee.finish_date && date > employee.finish_date)) return problem(`${row.employee_name} doesn't work for you on ${date}.`);
  const weekStart = weekStartOf(date, await timesheetFirstDay(tx));
  let sheet = (
    await tx.query<{ id: string; status: string }>("select id::text, status from payroll_timesheets where employee_id = $1 and week_start = $2 for update", [row.employee_id, weekStart])
  ).rows[0];
  if (!sheet) {
    sheet = (
      await tx.query<{ id: string; status: string }>(
        `insert into payroll_timesheets (idempotency_key, request_hash, employee_id, week_start, created_by_user_id, created_by_email)
         values ($1, $2, $3, $4, $5, $6) returning id::text, status`,
        [`clock-${recordId}`, sha256(`clock|${row.employee_id}|${weekStart}`), row.employee_id, weekStart, tx.actor.userId, tx.actor.email],
      )
    ).rows[0];
    await tx.query("insert into payroll_timesheet_history (timesheet_id, action, actor_user_id, actor_email) values ($1, 'created', $2, $3)", [sheet.id, tx.actor.userId, tx.actor.email]);
  }
  if (sheet.status !== "draft") {
    return problem(`The timesheet for the week starting ${weekStart} is ${sheet.status}: add ${hoursOf(minutes)} hours on ${date} once it's back to draft.`);
  }
  const hours = hoursOf(minutes);
  const existing = (
    await tx.query<{ id: string; hours: string; description: string | null }>(
      `select id::text, hours::text, description from payroll_timesheet_entries
        where timesheet_id = $1 and work_date = $2 and status = 'active' and department_id is null and project_id is null and rd_activity_id is null for update`,
      [sheet.id, date],
    )
  ).rows[0];
  const total = existing ? toFixedString(add(dec(existing.hours), dec(hours)), 2) : hours;
  if (cmp(dec(total), dec("24")) > 0) return problem(`${date} would have ${total} hours. Enter them on the timesheet by hand.`);
  if (existing) {
    await tx.query("update payroll_timesheet_entries set status = 'replaced', ended_by_user_id = $2, ended_by_email = $3, ended_at = now() where id = $1", [
      existing.id,
      tx.actor.userId,
      tx.actor.email,
    ]);
  }
  const entry = await tx.query<{ id: string }>(
    `insert into payroll_timesheet_entries (timesheet_id, work_date, hours, description, replaces_id, entered_by_user_id, entered_by_email, from_clock_in)
     values ($1, $2, $3, $4, $5, $6, $7, true) returning id::text`,
    [sheet.id, date, total, existing?.description ?? null, existing?.id ?? null, tx.actor.userId, tx.actor.email],
  );
  await tx.query("update payroll_timesheets set version = version + 1, updated_at = now() where id = $1", [sheet.id]);
  await tx.query("update payroll_clock_records set timesheet_entry_id = $2, timesheet_problem = null where id = $1", [recordId, entry.rows[0].id]);
  await writeAuditEvent(tx, {
    eventType: "payroll_timesheet.hours_from_clock_in",
    entityType: "payroll_timesheet",
    entityId: sheet.id,
    details: { employeeId: row.employee_id, weekStart, clockRecordId: recordId },
  });
}

/**
 * Enters the out time for a shift not clocked out (RS8), with a reason; its
 * time then goes to the timesheet. Also tries again for one whose week wasn't
 * a draft (`retry: true`, no out time). Payroll access.
 */
export async function enterClockOut(tx: OrgTx, idInput: unknown, input: { clockOutAt?: unknown; breakMinutes?: unknown; reason?: unknown; retry?: unknown }): Promise<ClockRecord> {
  await requirePayrollAccess(tx);
  const id = requireId(idInput, "recordId");
  const now = new Date();
  const record = await getRecord(tx, id, now);
  if (input.retry === true) {
    if (record.status !== "closed") throw new ConflictError("Enter the out time first.");
    await tx.query("update payroll_clock_records set timesheet_problem = null where id = $1", [id]);
    await fillTimesheet(tx, id);
    return getRecord(tx, id, now);
  }
  if (record.status === "closed") throw new ConflictError(`${record.employeeName} has already clocked out.`);
  const clockOutAt = parseAt(input.clockOutAt, "The out time");
  if (clockOutAt <= record.clockInAt) throw new ValidationError("The out time has to be after the clock-in.");
  if (clockOutAt > now.toISOString()) throw new ValidationError("The out time can't be in the future.");
  const reason = requireString(input.reason, "Reason", { maxLength: 500 });
  let breakMinutes = record.breakMinutes;
  if (input.breakMinutes !== undefined && input.breakMinutes !== null && input.breakMinutes !== "") {
    breakMinutes = Number(input.breakMinutes);
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 600) throw new ValidationError("A break is 0 to 600 minutes.");
  }
  await tx.query(
    "update payroll_clock_records set clock_out_at = $2, break_started_at = null, break_minutes = $3, out_entered_by_email = $4, out_reason = $5 where id = $1",
    [id, clockOutAt, breakMinutes, tx.actor.email, reason],
  );
  await writeAuditEvent(tx, { eventType: "payroll_clock.out_entered", entityType: "payroll_employee", entityId: record.employeeId, details: { clockRecordId: id } });
  await fillTimesheet(tx, id);
  return getRecord(tx, id, now);
}

// The device ------------------------------------------------------------------------------

/** Who can clock in on a device: employees with a PIN, working for you today, and whether each is in, on a break or out. */
export async function clockBoard(tx: OrgTx, input: { now?: Date } = {}): Promise<ClockBoardEmployee[]> {
  const now = input.now ?? new Date();
  const today = isoDateAt(now);
  const rows = await tx.query<{ id: string; name: string; clock_in_at: string | null; clock_out_at: string | null; break_started_at: string | null }>(
    `select e.id::text, e.first_name || ' ' || e.last_name as name, c.clock_in_at::text, c.clock_out_at::text, c.break_started_at::text
       from payroll_employees e left join payroll_clock_records c on c.employee_id = e.id and c.clock_out_at is null
      where e.clock_pin_hash is not null and not e.is_archived and e.start_date <= $1 and (e.finish_date is null or e.finish_date >= $1)
      order by e.first_name, e.last_name, e.id`,
    [today],
  );
  return rows.rows.map((row) => {
    const open = row.clock_in_at !== null && !isStale({ clock_in_at: row.clock_in_at, clock_out_at: null }, now);
    return {
      employeeId: row.id,
      name: row.name,
      status: !open ? "out" : row.break_started_at ? "on_break" : "in",
      since: !open ? null : (row.break_started_at ?? row.clock_in_at),
    };
  });
}

/**
 * Clocks an employee in or out, or starts or ends a break, on a device with
 * their PIN (RS5). Five wrong PINs lock clocking in for that employee for 15
 * minutes. `at` is for tests; devices use the server's time.
 */
export async function clockPunch(
  tx: OrgTx,
  device: { id: string; name: string },
  input: { employeeId: unknown; pin: unknown; action: unknown; at?: unknown },
): Promise<{ ok: true; status: ClockStatus; message: string } | { ok: false; message: string }> {
  const employeeId = parseEmployeeId(input.employeeId);
  const at = parseAt(input.at, "The time");
  const now = new Date(at);
  const employee = (
    await tx.query<{ name: string; first_name: string; clock_pin_hash: string | null; clock_pin_failures: number; locked: boolean; is_archived: boolean }>(
      `select first_name || ' ' || last_name as name, first_name, clock_pin_hash, clock_pin_failures, coalesce(clock_pin_locked_until > now(), false) as locked, is_archived
         from payroll_employees where id = $1 for update`,
      [employeeId],
    )
  ).rows[0];
  if (!employee || !employee.clock_pin_hash || employee.is_archived) throw new ValidationError("That person can't clock in here.");
  if (employee.locked) throw new ConflictError(`Too many wrong PINs. ${employee.first_name} can try again in ${LOCK_MINUTES} minutes, or ask a manager.`);
  if (typeof input.pin !== "string" || !(await verifyPassword(input.pin, employee.clock_pin_hash))) {
    const failures = employee.clock_pin_failures + 1;
    const lock = failures >= MAX_FAILURES;
    await tx.query(
      `update payroll_employees set clock_pin_failures = $2, clock_pin_locked_until = case when $3 then now() + interval '${LOCK_MINUTES} minutes' end where id = $1`,
      [employeeId, lock ? 0 : failures, lock],
    );
    // Returned, not thrown, so the count is saved: the route answers 403 after the transaction commits.
    return { ok: false, message: lock ? `Too many wrong PINs. ${employee.first_name} can try again in ${LOCK_MINUTES} minutes.` : "That PIN isn't right." };
  }
  if (employee.clock_pin_failures > 0) await tx.query("update payroll_employees set clock_pin_failures = 0 where id = $1", [employeeId]);
  const open = (
    await tx.query<{ id: string; clock_in_at: string; break_started_at: string | null; break_minutes: number }>(
      "select id::text, clock_in_at::text, break_started_at::text, break_minutes from payroll_clock_records where employee_id = $1 and clock_out_at is null for update",
      [employeeId],
    )
  ).rows[0];
  const stale = open && isStale({ clock_in_at: open.clock_in_at, clock_out_at: null }, now);
  const first = employee.first_name;
  switch (input.action) {
    case "in": {
      if (open && !stale) throw new ConflictError(`${first} is already clocked in.`);
      if (open && stale) {
        throw new ConflictError(`${first}'s clock-in on ${isoDateAt(new Date(open.clock_in_at))} wasn't clocked out. A manager needs to enter the out time first.`);
      }
      await tx.query("insert into payroll_clock_records (employee_id, device_id, clock_in_at) values ($1, $2, $3)", [employeeId, device.id, at]);
      await writeAuditEvent(tx, { eventType: "payroll_clock.in", entityType: "payroll_employee", entityId: employeeId, details: { deviceId: device.id } });
      return { ok: true, status: "in", message: `${first} clocked in at ${timeText(at)}.` };
    }
    case "break_start":
    case "break_end":
    case "out": {
      if (!open) throw new ConflictError(`${first} isn't clocked in.`);
      if (stale) throw new ConflictError(`${first}'s clock-in on ${isoDateAt(new Date(open.clock_in_at))} wasn't clocked out. A manager needs to enter the out time.`);
      if (at <= new Date(open.clock_in_at).toISOString()) throw new ValidationError("That's before the clock-in.");
      if (input.action === "break_start") {
        if (open.break_started_at) throw new ConflictError(`${first} is already on a break.`);
        await tx.query("update payroll_clock_records set break_started_at = $2 where id = $1", [open.id, at]);
        return { ok: true, status: "on_break", message: `${first}'s break started at ${timeText(at)}.` };
      }
      const breakSoFar = open.break_started_at ? Math.floor((Date.parse(at) - Date.parse(open.break_started_at)) / 60_000) : 0;
      if (input.action === "break_end") {
        if (!open.break_started_at) throw new ConflictError(`${first} isn't on a break.`);
        await tx.query("update payroll_clock_records set break_started_at = null, break_minutes = break_minutes + $2 where id = $1", [open.id, breakSoFar]);
        return { ok: true, status: "in", message: `${first}'s break ended at ${timeText(at)} (${breakSoFar} min).` };
      }
      await tx.query("update payroll_clock_records set clock_out_at = $2, break_started_at = null, break_minutes = break_minutes + $3 where id = $1", [open.id, at, breakSoFar]);
      await writeAuditEvent(tx, { eventType: "payroll_clock.out", entityType: "payroll_employee", entityId: employeeId, details: { deviceId: device.id, clockRecordId: open.id } });
      await fillTimesheet(tx, open.id);
      const record = await getRecord(tx, open.id, now);
      return { ok: true, status: "out", message: `${first} clocked out at ${timeText(at)}: ${record.hours} hours.` };
    }
    default:
      throw new ValidationError("action must be in, out, break_start or break_end.");
  }
}

export function deviceActor(name: string): { userId: null; email: string } {
  return { userId: null, email: `Clock device "${name}"` };
}

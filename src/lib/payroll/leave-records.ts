import { createHash } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { add, cmp, dec, divide, isPositive, mul, parseDecimalInput, sum, toFixedString, toPlainString } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { checkCashUp, earnedTowardsNext } from "@/lib/payroll/leave/annual";
import { addDays, addMonths, daysInclusive, eachDay } from "@/lib/payroll/leave/dates";
import { observedHolidays } from "@/lib/payroll/leave/public-holidays";
import type { AnniversaryRegion } from "@/lib/payroll/leave/public-holiday-dates";
import { leaveHours, signOfLeave, subtractLeave, unitsOf } from "@/lib/payroll/leave/quantity";
import { EMPLOYMENT_LEAVE_ACT_STARTS, LEAVE_TYPES, type LeaveType, NOT_SUPPORTED } from "@/lib/payroll/leave/rules";
import { BEREAVEMENT_DAYS, BEREAVEMENT_KINDS, type BereavementKind } from "@/lib/payroll/leave/sick";
import { isUsualWorkingDay, usualHoursOn, weekHours } from "@/lib/payroll/leave/work-pattern";
import {
  alternativeHolidays,
  annualBalance,
  annualDates,
  dailyRateOn,
  type EmployeeFacts,
  loadEmployeeFacts,
  recordsStartWith,
  settingsOn,
  whyLeaveNotKept,
} from "@/lib/payroll/leave-facts";
import { updateDraftsCovering } from "@/lib/payroll/leave-pay-runs";
import { leaveSettingsOn, type LeaveSettings } from "@/lib/payroll/leave-settings";
import { checkAttachment } from "@/lib/records/file-types";
import { optionalString, requireBoolean, requireIdempotencyKey, requireOneOf } from "@/lib/validation";

/**
 * Leave records (payroll stage P8): bookings, unpaid leave, public holiday
 * decisions, cash-ups, exchanged alternative holidays and the files kept
 * with them. Each change works out leave again on the drafts it touches.
 * Payroll access only; family violence leave is in these records, which
 * only people with payroll access see (decision 27).
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(input: unknown, what: string): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) throw new NotFoundError(`That ${what} wasn't found.`);
  return input.toLowerCase();
}

export type UploadedFile = { fileName: string; content: Uint8Array };

export async function loadSettingsList(tx: OrgTx, employeeId: string): Promise<LeaveSettings[]> {
  const dates = await tx.query<{ effective_from: string }>(
    "select distinct effective_from::text from payroll_leave_settings where employee_id::text = $1 order by effective_from desc",
    [employeeId],
  );
  const list: LeaveSettings[] = [];
  for (const row of dates.rows) {
    const settings = await leaveSettingsOn(tx, employeeId, row.effective_from);
    if (settings) list.push(settings);
  }
  return list;
}

/** An employee's facts, refusing when Tohyee doesn't keep their leave (decision 143). */
async function keptFacts(tx: OrgTx, employeeIdInput: unknown): Promise<EmployeeFacts> {
  const employeeId = uuid(employeeIdInput, "employee");
  const exists = await tx.query("select 1 from payroll_employees where id = $1", [employeeId]);
  if (!exists.rows[0]) throw new NotFoundError("Employee not found.");
  const facts = await loadEmployeeFacts(tx, employeeId, await loadSettingsList(tx, employeeId));
  const why = whyLeaveNotKept(facts, recordsStartWith(facts, null));
  if (why) throw new ValidationError(why);
  return facts;
}

/** Stores a file kept with a leave record (s 81(4): kept at least 6 years; never deleted). */
export async function storeFile(tx: OrgTx, employeeId: string, purpose: string, file: UploadedFile): Promise<string> {
  const checked = checkAttachment(file.fileName, file.content);
  const inserted = await tx.query<{ id: string }>(
    `insert into payroll_leave_files (employee_id, purpose, file_name, content_type, byte_size, sha256, content, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id::text`,
    [
      employeeId,
      purpose,
      checked.fileName,
      checked.contentType,
      file.content.length,
      createHash("sha256").update(file.content).digest("hex"),
      Buffer.from(file.content),
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  return inserted.rows[0].id;
}

export function fileHash(file: UploadedFile | null | undefined): string | null {
  return file ? `${file.fileName}:${createHash("sha256").update(file.content).digest("hex")}` : null;
}

/** A file kept with a leave record, for download (payroll access). */
export async function getLeaveFile(tx: OrgTx, fileIdInput: unknown): Promise<{ fileName: string; contentType: string; content: Uint8Array }> {
  await requirePayrollAccess(tx);
  const id = uuid(fileIdInput, "file");
  const result = await tx.query<{ file_name: string; content_type: string; content: Buffer }>(
    "select file_name, content_type, content from payroll_leave_files where id = $1",
    [id],
  );
  if (!result.rows[0]) throw new NotFoundError("That file wasn't found.");
  return { fileName: result.rows[0].file_name, contentType: result.rows[0].content_type, content: new Uint8Array(result.rows[0].content) };
}

// Bookings

export type LeaveBooking = {
  id: string;
  reference: string;
  employeeId: string;
  employeeName: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  dayHours: Record<string, string> | null;
  hoursWorked: string | null;
  bereavementKind: BereavementKind | null;
  inAdvanceAgreed: boolean;
  advanceAgreementFileId: string | null;
  note: string | null;
  status: "booked" | "cancelled";
  /** Pay runs that pay it, with their status. */
  payRuns: Array<{ reference: string; status: string }>;
  createdAt: string;
  createdByEmail: string;
  cancelledAt: string | null;
};

type BookingRow = {
  id: string;
  booking_number: string;
  employee_id: string;
  employee_name: string;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  day_hours: Record<string, string> | null;
  hours_worked: string | null;
  bereavement_kind: BereavementKind | null;
  in_advance_agreed: boolean;
  advance_agreement_file_id: string | null;
  note: string | null;
  status: "booked" | "cancelled";
  pay_runs: Array<{ reference: string; status: string }> | null;
  created_at: string;
  created_by_email: string;
  cancelled_at: string | null;
  request_hash: string;
};

const BOOKING_SELECT = `select b.id::text, b.booking_number::text, b.employee_id::text, e.first_name || ' ' || e.last_name as employee_name, b.leave_type,
    b.start_date::text, b.end_date::text, b.day_hours, b.hours_worked::text, b.bereavement_kind, b.in_advance_agreed,
    b.advance_agreement_file_id::text, b.note, b.status, b.created_at::text, b.created_by_email, b.cancelled_at::text, b.request_hash,
    (select jsonb_agg(distinct jsonb_build_object('reference', 'PAYRUN-' || r.run_number, 'status', r.status))
       from payroll_pay_run_lines l join payroll_pay_runs r on r.id = l.pay_run_id where l.leave_booking_id = b.id) as pay_runs
  from payroll_leave_bookings b join payroll_employees e on e.id = b.employee_id`;

export function leaveBookingReference(number: string | number): string {
  return `LEAVE-${number}`;
}

function toBooking(row: BookingRow): LeaveBooking {
  return {
    id: row.id,
    reference: leaveBookingReference(row.booking_number),
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    leaveType: row.leave_type,
    startDate: row.start_date,
    endDate: row.end_date,
    dayHours: row.day_hours,
    hoursWorked: row.hours_worked === null ? null : toPlainString(dec(row.hours_worked)),
    bereavementKind: row.bereavement_kind,
    inAdvanceAgreed: row.in_advance_agreed,
    advanceAgreementFileId: row.advance_agreement_file_id,
    note: row.note,
    status: row.status,
    payRuns: row.pay_runs ?? [],
    createdAt: row.created_at,
    createdByEmail: row.created_by_email,
    cancelledAt: row.cancelled_at,
  };
}

export async function getLeaveBooking(tx: OrgTx, idInput: unknown): Promise<LeaveBooking> {
  await requirePayrollAccess(tx);
  const result = await tx.query<BookingRow>(`${BOOKING_SELECT} where b.id = $1`, [uuid(idInput, "leave booking")]);
  if (!result.rows[0]) throw new NotFoundError("That leave booking wasn't found.");
  return toBooking(result.rows[0]);
}

export async function listLeaveBookings(tx: OrgTx, filters: { employeeId?: unknown; from?: unknown; to?: unknown; includeCancelled?: boolean } = {}): Promise<LeaveBooking[]> {
  await requirePayrollAccess(tx);
  const employeeId = filters.employeeId ? uuid(filters.employeeId, "employee") : null;
  const from = filters.from ? parseIsoDate(filters.from, "From") : null;
  const to = filters.to ? parseIsoDate(filters.to, "To") : null;
  const result = await tx.query<BookingRow>(
    `${BOOKING_SELECT}
      where ($1::uuid is null or b.employee_id = $1) and ($2::date is null or b.end_date >= $2) and ($3::date is null or b.start_date <= $3)
        and ($4::boolean or b.status = 'booked')
      order by b.start_date desc, b.booking_number desc limit 500`,
    [employeeId, from, to, filters.includeCancelled ?? false],
  );
  return result.rows.map(toBooking);
}

export type BookingWarnings = string[];

/**
 * Books leave for an employee (payroll access). Sick, bereavement and
 * family violence leave can be booked over annual holidays (s 36-s 38);
 * other overlaps are refused. Annual holidays in advance give a warning
 * and a prompt for the written agreement (decision 15). The pay runs for
 * the days covered pay it.
 */
export async function createLeaveBooking(
  tx: OrgTx,
  input: Record<string, unknown> & { advanceAgreement?: UploadedFile | null },
): Promise<{ created: boolean; booking: LeaveBooking; warnings: BookingWarnings; payRuns: string[] }> {
  await requirePayrollAccess(tx);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const { advanceAgreement, ...fields } = input;
  const hash = requestHash("payroll_leave_booking", { ...fields, advanceAgreement: fileHash(advanceAgreement) });
  const earlier = await tx.query<BookingRow>(`${BOOKING_SELECT} where b.idempotency_key = $1`, [idempotencyKey]);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "leave booking");
    return { created: false, booking: toBooking(earlier.rows[0]), warnings: [], payRuns: [] };
  }
  const facts = await keptFacts(tx, input.employeeId);
  await tx.query("select 1 from payroll_employees where id = $1 for update", [facts.id]);
  const leaveType = requireOneOf(input.leaveType, "Leave type", LEAVE_TYPES);
  const startDate = parseIsoDate(input.startDate, "Start date");
  const endDate = input.endDate === undefined || input.endDate === null || input.endDate === "" ? startDate : parseIsoDate(input.endDate, "End date");
  if (endDate < startDate) throw new ValidationError("The leave can't end before it starts.");
  if (daysInclusive(startDate, endDate) > 366) throw new ValidationError("Book leave a year or less at a time.");
  if (startDate >= EMPLOYMENT_LEAVE_ACT_STARTS) {
    throw new ValidationError(`${NOT_SUPPORTED}: leave from 6 Aug 2028, under the Employment Leave Act 2026 (decision 7).`);
  }
  if (startDate < facts.startDate) throw new ValidationError(`${facts.name} starts on ${formatDate(facts.startDate)}, after the leave would start.`);
  if (facts.finishDate && endDate > facts.finishDate) throw new ValidationError(`${facts.name} finishes on ${formatDate(facts.finishDate)}, before the leave would end.`);
  if (leaveType === "alternative" && endDate !== startDate) throw new ValidationError("An alternative holiday is one whole working day (s 57(1)(c)); book each on its own.");
  const settings = settingsOn(facts, startDate);
  if (!settings) throw new ValidationError(`${facts.name} has no usual week on ${formatDate(startDate)}. Set it under Employees › Leave.`);
  const pattern = settings.pattern;

  // Hours each day for someone whose hours vary; a fixed week gives them.
  let dayHours: Record<string, string> | null = null;
  if (pattern.kind === "varies") {
    if (!input.dayHours || typeof input.dayHours !== "object") {
      throw new ValidationError(`${facts.name}'s hours vary, so give the hours they'd have worked each day of the leave.`);
    }
    dayHours = {};
    for (const [date, value] of Object.entries(input.dayHours as Record<string, unknown>)) {
      const day = parseIsoDate(date, "Day");
      if (day < startDate || day > endDate) throw new ValidationError(`${formatDate(day)} isn't inside the leave.`);
      const hours = parseDecimalInput(value, `Hours on ${formatDate(day)}`, { maxScale: 2, allowZero: true });
      if (cmp(dec(hours), dec("24")) > 0) throw new ValidationError(`Hours on ${formatDate(day)} can't be more than 24.`);
      if (isPositive(dec(hours))) dayHours[day] = hours;
    }
    if (Object.keys(dayHours).length === 0) throw new ValidationError("Give the hours for at least one day of the leave.");
  } else if (input.dayHours !== undefined && input.dayHours !== null) {
    throw new ValidationError(`${facts.name} has a usual week, so the hours each day come from it.`);
  }
  const workingDays = eachDay(startDate, endDate).filter((date) => (pattern.kind === "fixed" ? isUsualWorkingDay(pattern, date) : Boolean(dayHours?.[date])));
  if (workingDays.length === 0) throw new ValidationError(`None of those days is a working day for ${facts.name}.`);

  let hoursWorked: string | null = null;
  if (input.hoursWorked !== undefined && input.hoursWorked !== null && input.hoursWorked !== "") {
    if (leaveType !== "sick" && leaveType !== "family_violence") throw new ValidationError("Only sick and family violence leave can be part of a day (decision 19).");
    if (endDate !== startDate) throw new ValidationError("A part day is one day: book it on its own.");
    hoursWorked = parseDecimalInput(input.hoursWorked, "Hours worked that day", { maxScale: 2 });
    const usual = pattern.kind === "fixed" ? usualHoursOn(pattern, startDate) : dec(dayHours![startDate] ?? "0");
    if (cmp(dec(hoursWorked), usual) >= 0) throw new ValidationError(`That's a whole day's work (${toPlainString(usual)} usual hours), so it isn't leave.`);
  }
  const bereavementKind = leaveType === "bereavement" ? requireOneOf(input.bereavementKind, "Bereavement", BEREAVEMENT_KINDS) : null;
  if (bereavementKind && workingDays.length > BEREAVEMENT_DAYS[bereavementKind]) {
    throw new ValidationError(`That bereavement gives ${BEREAVEMENT_DAYS[bereavementKind]} day${BEREAVEMENT_DAYS[bereavementKind] === 1 ? "" : "s"} of bereavement leave (s 70(1)); book another bereavement on its own.`);
  }
  const inAdvanceAgreed = input.inAdvanceAgreed === undefined ? false : requireBoolean(input.inAdvanceAgreed, "Leave in advance agreed");
  if (inAdvanceAgreed && leaveType === "annual") throw new ValidationError("Annual holidays in advance don't need this: they're taken in advance when the balance runs out (s 20).");
  const note = optionalString(input.note, "Note", { maxLength: 1000 });

  // Overlaps (s 36-s 38): sick, bereavement and family violence leave over annual holidays only.
  const overlapping = await tx.query<{ booking_number: string; leave_type: LeaveType }>(
    `select booking_number::text, leave_type from payroll_leave_bookings
      where employee_id = $1 and status = 'booked' and start_date <= $3 and end_date >= $2`,
    [facts.id, startDate, endDate],
  );
  const dayLeave = (type: LeaveType) => type === "sick" || type === "bereavement" || type === "family_violence";
  for (const other of overlapping.rows) {
    const allowed = (dayLeave(leaveType) && other.leave_type === "annual") || (leaveType === "annual" && dayLeave(other.leave_type));
    if (!allowed) throw new ConflictError(`${facts.name} already has ${leaveBookingReference(other.booking_number)} on some of those days. Cancel it first.`);
  }
  if (leaveType === "alternative") {
    const region = (settings.anniversaryRegion ?? facts.organisationRegion) as AnniversaryRegion | null;
    const holiday = observedHolidays({ from: startDate, to: startDate, region, wouldWork: () => true }).holidays[0];
    if (holiday) throw new ValidationError(`An alternative holiday can't be taken on a public holiday (${holiday.name}, s 57(1)(d)).`);
    // Alternative holidays already booked and not yet paid by an approved pay run use theirs up first.
    const booked = await tx.query<{ count: string }>(
      `select count(*)::text from payroll_leave_bookings b
        where b.employee_id = $1 and b.status = 'booked' and b.leave_type = 'alternative'
          and not exists (select 1 from payroll_pay_run_lines l join payroll_pay_runs r on r.id = l.pay_run_id
                           where l.leave_booking_id = b.id and r.status = 'approved')`,
      [facts.id],
    );
    const untaken = alternativeHolidays(facts, startDate).filter((each) => each.status === "untaken").length;
    if (untaken - Number(booked.rows[0].count) <= 0) {
      throw new ValidationError(`${facts.name} has no alternative holiday to take on ${formatDate(startDate)}${untaken > 0 ? " that isn't already booked" : ""}.`);
    }
  }

  const warnings: string[] = [];
  if (leaveType === "annual") {
    const weekly = toPlainString(weekHours(pattern));
    const region = (settings.anniversaryRegion ?? facts.organisationRegion) as AnniversaryRegion | null;
    const holidays = region
      ? new Set(observedHolidays({ from: startDate, to: endDate, region, wouldWork: (date) => (pattern.kind === "fixed" ? isUsualWorkingDay(pattern, date) : true) }).holidays.map((holiday) => holiday.date))
      : new Set<string>();
    const total = sum(workingDays.filter((date) => !holidays.has(date)).map((date) => (pattern.kind === "fixed" ? usualHoursOn(pattern, date) : dec(dayHours![date]))));
    const quantity = leaveHours(total, weekly);
    const balance = annualBalance(facts, startDate).balance;
    const after = subtractLeave(balance, quantity);
    if (signOfLeave(after) < 0) {
      const since = annualDates(facts, startDate).at(-1) ?? facts.startDate;
      const earned = earnedTowardsNext(since, startDate);
      const owing = mul(unitsOf(after, 8), dec("-1"));
      warnings.push(
        `This takes ${facts.name} ${toFixedString(owing, 2)} weeks into annual holidays in advance (s 20). Keep a written agreement that lets you recover it if they leave (decision 15)${advanceAgreement ? "; it's attached" : ""}.`,
      );
      if (cmp(owing, earned) > 0) warnings.push(`That's more than the ${toFixedString(earned, 2)} weeks earned since ${formatDate(since)} (decision 15).`);
    }
  } else if (advanceAgreement) {
    throw new ValidationError("A written agreement to recover holidays taken in advance goes with annual holidays.");
  }

  const advanceFileId = advanceAgreement ? await storeFile(tx, facts.id, "advance_agreement", advanceAgreement) : null;
  const inserted = await tx.query<{ id: string }>(
    `insert into payroll_leave_bookings (idempotency_key, request_hash, employee_id, leave_type, start_date, end_date, day_hours, hours_worked,
                                         bereavement_kind, in_advance_agreed, advance_agreement_file_id, note, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14) returning id::text`,
    [idempotencyKey, hash, facts.id, leaveType, startDate, endDate, dayHours ? JSON.stringify(dayHours) : null, hoursWorked, bereavementKind, inAdvanceAgreed, advanceFileId, note, tx.actor.userId, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "payroll_leave_booking.created",
    entityType: "payroll_leave_booking",
    entityId: id,
    // Never the type for family violence leave: its records are private (decision 27).
    details: { employeeId: facts.id, leaveType: leaveType === "family_violence" ? "special" : leaveType, startDate, endDate },
  });
  const payRuns = await updateDraftsCovering(tx, facts.id, startDate, endDate);
  return { created: true, booking: await getLeaveBooking(tx, id), warnings, payRuns };
}

/** Cancels a booking no approved pay run has paid (payroll access). Drafts that paid it are worked out again. */
export async function cancelLeaveBooking(tx: OrgTx, idInput: unknown): Promise<{ booking: LeaveBooking; payRuns: string[] }> {
  await requirePayrollAccess(tx);
  const id = uuid(idInput, "leave booking");
  const row = await tx.query<{ status: string; employee_id: string; start_date: string; end_date: string; booking_number: string }>(
    "select status, employee_id::text, start_date::text, end_date::text, booking_number::text from payroll_leave_bookings where id = $1 for update",
    [id],
  );
  if (!row.rows[0]) throw new NotFoundError("That leave booking wasn't found.");
  const booking = row.rows[0];
  if (booking.status === "cancelled") throw new ConflictError(`${leaveBookingReference(booking.booking_number)} is already cancelled.`);
  const paid = await tx.query<{ run_number: string }>(
    `select distinct r.run_number::text from payroll_pay_run_lines l join payroll_pay_runs r on r.id = l.pay_run_id
      where l.leave_booking_id = $1 and r.status = 'approved' order by 1`,
    [id],
  );
  if (paid.rows.length > 0) {
    throw new ConflictError(
      `${leaveBookingReference(booking.booking_number)} was paid on ${paid.rows.map((each) => `PAYRUN-${each.run_number}`).join(", ")}, so it can't be cancelled. Void the pay run first.`,
    );
  }
  await tx.query("update payroll_leave_bookings set status = 'cancelled', cancelled_at = now(), cancelled_by_email = $2 where id = $1", [id, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "payroll_leave_booking.cancelled", entityType: "payroll_leave_booking", entityId: id, details: { employeeId: booking.employee_id } });
  const payRuns = await updateDraftsCovering(tx, booking.employee_id, booking.start_date, booking.end_date);
  return { booking: await getLeaveBooking(tx, id), payRuns };
}

// Unpaid leave (s 16(2), s 16(3); decision 14)

export const UNPAID_LEAVE_REASONS = ["other", "sick", "bereavement", "family_violence", "parental", "volunteers", "acc"] as const;

export type UnpaidLeaveRecord = {
  id: string;
  employeeId: string;
  startDate: string;
  endDate: string;
  reason: (typeof UNPAID_LEAVE_REASONS)[number];
  agreedToCount: boolean;
  agreementFileId: string | null;
  /** Whether it moves the anniversary (decision 14). */
  movesAnniversary: boolean;
  note: string | null;
  status: "active" | "cancelled";
  createdByEmail: string;
  createdAt: string;
};

type UnpaidRow = {
  id: string;
  employee_id: string;
  start_date: string;
  end_date: string;
  reason: UnpaidLeaveRecord["reason"];
  agreed_to_count: boolean;
  agreement_file_id: string | null;
  note: string | null;
  status: "active" | "cancelled";
  created_by_email: string;
  created_at: string;
  request_hash: string;
};

const UNPAID_COLUMNS = `id::text, employee_id::text, start_date::text, end_date::text, reason, agreed_to_count, agreement_file_id::text, note, status,
  created_by_email, created_at::text, request_hash`;

function toUnpaid(row: UnpaidRow): UnpaidLeaveRecord {
  return {
    id: row.id,
    employeeId: row.employee_id,
    startDate: row.start_date,
    endDate: row.end_date,
    reason: row.reason,
    agreedToCount: row.agreed_to_count,
    agreementFileId: row.agreement_file_id,
    movesAnniversary: row.reason === "other" && daysInclusive(row.start_date, row.end_date) > 7 && !row.agreed_to_count,
    note: row.note,
    status: row.status,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

export async function listUnpaidLeave(tx: OrgTx, employeeIdInput: unknown): Promise<UnpaidLeaveRecord[]> {
  await requirePayrollAccess(tx);
  const result = await tx.query<UnpaidRow>(`select ${UNPAID_COLUMNS} from payroll_unpaid_leave where employee_id = $1 order by start_date desc`, [
    uuid(employeeIdInput, "employee"),
  ]);
  return result.rows.map(toUnpaid);
}

/**
 * Records unpaid leave (decision 14; HL10): a single period of other unpaid
 * leave longer than a week moves the anniversary by its whole length, unless
 * a written agreement to count it is attached, which cuts the AWE divisor
 * instead (s 16(3)).
 */
export async function addUnpaidLeave(
  tx: OrgTx,
  input: Record<string, unknown> & { agreement?: UploadedFile | null },
): Promise<{ created: boolean; unpaidLeave: UnpaidLeaveRecord; payRuns: string[] }> {
  await requirePayrollAccess(tx);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const { agreement, ...fields } = input;
  const hash = requestHash("payroll_unpaid_leave", { ...fields, agreement: fileHash(agreement) });
  const earlier = await tx.query<UnpaidRow>(`select ${UNPAID_COLUMNS} from payroll_unpaid_leave where idempotency_key = $1`, [idempotencyKey]);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "unpaid leave");
    return { created: false, unpaidLeave: toUnpaid(earlier.rows[0]), payRuns: [] };
  }
  const facts = await keptFacts(tx, input.employeeId);
  const startDate = parseIsoDate(input.startDate, "Start date");
  const endDate = parseIsoDate(input.endDate ?? input.startDate, "End date");
  if (endDate < startDate) throw new ValidationError("The unpaid leave can't end before it starts.");
  if (startDate < facts.startDate) throw new ValidationError(`${facts.name} starts on ${formatDate(facts.startDate)}.`);
  const reason = requireOneOf(input.reason ?? "other", "Reason", UNPAID_LEAVE_REASONS);
  const agreedToCount = input.agreedToCount === undefined ? false : requireBoolean(input.agreedToCount, "Agreed to count");
  if (agreedToCount && reason !== "other") throw new ValidationError("Unpaid sick, bereavement, family violence, parental, volunteers and ACC leave always count (s 16(2)(a)).");
  if (agreedToCount && !agreement) throw new ValidationError("Attach the written agreement to count the unpaid leave (s 16(2)(b)).");
  const overlapping = await tx.query("select 1 from payroll_unpaid_leave where employee_id = $1 and status = 'active' and start_date <= $3 and end_date >= $2", [
    facts.id,
    startDate,
    endDate,
  ]);
  if (overlapping.rows[0]) throw new ConflictError(`${facts.name} already has unpaid leave on some of those days.`);
  const fileId = agreement ? await storeFile(tx, facts.id, "unpaid_leave_agreement", agreement) : null;
  const inserted = await tx.query<UnpaidRow>(
    `insert into payroll_unpaid_leave (idempotency_key, request_hash, employee_id, start_date, end_date, reason, agreed_to_count, agreement_file_id, note,
                                       created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning ${UNPAID_COLUMNS}`,
    [idempotencyKey, hash, facts.id, startDate, endDate, reason, agreedToCount, fileId, optionalString(input.note, "Note", { maxLength: 1000 }), tx.actor.userId, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "payroll_unpaid_leave.added",
    entityType: "payroll_employee",
    entityId: facts.id,
    details: { startDate, endDate, reason: reason === "family_violence" ? "special" : reason, agreedToCount },
  });
  const payRuns = await updateDraftsCovering(tx, facts.id, startDate, "9999-12-31");
  return { created: true, unpaidLeave: toUnpaid(inserted.rows[0]), payRuns };
}

export async function cancelUnpaidLeave(tx: OrgTx, idInput: unknown): Promise<{ unpaidLeave: UnpaidLeaveRecord; payRuns: string[] }> {
  await requirePayrollAccess(tx);
  const id = uuid(idInput, "unpaid leave");
  const result = await tx.query<UnpaidRow>(
    `update payroll_unpaid_leave set status = 'cancelled', cancelled_at = now(), cancelled_by_email = $2 where id = $1 and status = 'active'
     returning ${UNPAID_COLUMNS}`,
    [id, tx.actor.email],
  );
  if (!result.rows[0]) throw new NotFoundError("That unpaid leave wasn't found (or is already cancelled).");
  await writeAuditEvent(tx, { eventType: "payroll_unpaid_leave.cancelled", entityType: "payroll_employee", entityId: result.rows[0].employee_id, details: { id } });
  const payRuns = await updateDraftsCovering(tx, result.rows[0].employee_id, result.rows[0].start_date, "9999-12-31");
  return { unpaidLeave: toUnpaid(result.rows[0]), payRuns };
}

// Public holiday decisions (decisions 21, 23)

export type PublicHolidayDecision = {
  employeeId: string;
  holidayDate: string;
  holidayName: string;
  otherwiseWorking: boolean;
  suggestion: string | null;
  hoursWorked: string | null;
  penalHourlyRate: string | null;
  extraAmount: string | null;
  note: string | null;
  decidedAt: string;
  decidedByEmail: string;
};

type DecisionRow = {
  employee_id: string;
  holiday_date: string;
  holiday_name: string;
  otherwise_working: boolean;
  suggestion: string | null;
  hours_worked: string | null;
  penal_hourly_rate: string | null;
  extra_amount: string | null;
  note: string | null;
  decided_at: string;
  decided_by_email: string;
};

const DECISION_COLUMNS = `employee_id::text, holiday_date::text, holiday_name, otherwise_working, suggestion, hours_worked::text, penal_hourly_rate::text,
  extra_amount::text, note, decided_at::text, decided_by_email`;

function toDecision(row: DecisionRow): PublicHolidayDecision {
  const plain = (value: string | null) => (value === null ? null : toPlainString(dec(value)));
  return {
    employeeId: row.employee_id,
    holidayDate: row.holiday_date,
    holidayName: row.holiday_name,
    otherwiseWorking: row.otherwise_working,
    suggestion: row.suggestion,
    hoursWorked: plain(row.hours_worked),
    penalHourlyRate: plain(row.penal_hourly_rate),
    extraAmount: row.extra_amount === null ? null : toFixedString(dec(row.extra_amount), 2),
    note: row.note,
    decidedAt: row.decided_at,
    decidedByEmail: row.decided_by_email,
  };
}

export async function listPublicHolidayDecisions(tx: OrgTx, filters: { employeeId?: unknown; from?: unknown; to?: unknown } = {}): Promise<PublicHolidayDecision[]> {
  await requirePayrollAccess(tx);
  const result = await tx.query<DecisionRow>(
    `select ${DECISION_COLUMNS} from payroll_public_holiday_decisions
      where status = 'current' and ($1::uuid is null or employee_id = $1) and ($2::date is null or holiday_date >= $2) and ($3::date is null or holiday_date <= $3)
      order by holiday_date desc limit 500`,
    [filters.employeeId ? uuid(filters.employeeId, "employee") : null, filters.from ? parseIsoDate(filters.from, "From") : null, filters.to ? parseIsoDate(filters.to, "To") : null],
  );
  return result.rows.map(toDecision);
}

/**
 * Records whether a public holiday would otherwise have been a working day
 * for an employee, and any hours worked on it (decisions 21, 23; HL30,
 * HL32), with a penal rate or typed extra the agreement gives. A decision an
 * approved pay run used can't change.
 */
export async function decidePublicHoliday(tx: OrgTx, input: Record<string, unknown>): Promise<{ decision: PublicHolidayDecision; payRuns: string[] }> {
  await requirePayrollAccess(tx);
  const facts = await keptFacts(tx, input.employeeId);
  const holidayDate = parseIsoDate(input.holidayDate, "Holiday date");
  const settings = settingsOn(facts, holidayDate);
  if (!settings) throw new ValidationError(`${facts.name} has no usual week on ${formatDate(holidayDate)}.`);
  const region = (settings.anniversaryRegion ?? facts.organisationRegion) as AnniversaryRegion | null;
  // The day is a public holiday whether or not it moves for this employee.
  const candidates = [
    ...observedHolidays({ from: holidayDate, to: holidayDate, region, wouldWork: () => true }).holidays,
    ...observedHolidays({ from: holidayDate, to: holidayDate, region, wouldWork: () => false }).holidays,
  ];
  const holiday = candidates[0];
  if (!holiday) throw new ValidationError(`${formatDate(holidayDate)} isn't a public holiday for ${facts.name}.`);
  const otherwiseWorking = requireBoolean(input.otherwiseWorking, "Would otherwise have been a working day");
  const hoursWorked = input.hoursWorked === undefined || input.hoursWorked === null || input.hoursWorked === "" ? null : parseDecimalInput(input.hoursWorked, "Hours worked", { maxScale: 2 });
  if (hoursWorked && cmp(dec(hoursWorked), dec("24")) > 0) throw new ValidationError("Hours worked can't be more than 24.");
  const penal = input.penalHourlyRate === undefined || input.penalHourlyRate === null || input.penalHourlyRate === "" ? null : parseDecimalInput(input.penalHourlyRate, "Penal rate an hour", { maxScale: 4 });
  if (penal && !hoursWorked) throw new ValidationError("A penal rate is only for hours worked on the holiday (s 50(1)(b)).");
  const extra = input.extraAmount === undefined || input.extraAmount === null || input.extraAmount === "" ? null : parseDecimalInput(input.extraAmount, "Extra under the agreement", { maxScale: 2 });
  if (extra && !hoursWorked) throw new ValidationError("A typed extra is for working part of the holiday under an agreement that gives more (decision 23).");
  // An approved pay run for the day (or the weekday it moved to) has already paid it, or not.
  const used = await tx.query<{ run_number: string }>(
    `select r.run_number::text from payroll_pay_run_employees pe join payroll_pay_runs r on r.id = pe.pay_run_id
      where pe.employee_id = $1 and r.status = 'approved' and r.period_start <= $3 and r.period_end >= $2
      order by r.run_number limit 1`,
    [facts.id, holidayDate, addDays(holidayDate, 2)],
  );
  if (used.rows[0]) {
    throw new ConflictError(`PAYRUN-${used.rows[0].run_number} is approved for ${holiday.name} (${formatDate(holidayDate)}) for ${facts.name}, so the decision can't change. Void it first.`);
  }
  const suggestion = optionalString(input.suggestion, "Suggestion", { maxLength: 200 });
  await tx.query("update payroll_public_holiday_decisions set status = 'replaced' where employee_id = $1 and holiday_date = $2 and status = 'current'", [facts.id, holidayDate]);
  const inserted = await tx.query<DecisionRow>(
    `insert into payroll_public_holiday_decisions (employee_id, holiday_date, holiday_name, otherwise_working, suggestion, hours_worked, penal_hourly_rate,
                                                   extra_amount, note, decided_by_user_id, decided_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning ${DECISION_COLUMNS}`,
    [facts.id, holidayDate, holiday.name, otherwiseWorking, suggestion, hoursWorked, penal, extra, optionalString(input.note, "Note", { maxLength: 1000 }), tx.actor.userId, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "payroll_public_holiday.decided",
    entityType: "payroll_employee",
    entityId: facts.id,
    details: { holidayDate, otherwiseWorking, hoursWorked },
  });
  // A weekend holiday decided "not a working day" moves to the Monday or Tuesday after, maybe in the next pay period.
  const payRuns = await updateDraftsCovering(tx, facts.id, holidayDate, addDays(holidayDate, 3));
  return { decision: toDecision(inserted.rows[0]), payRuns };
}

// Cash-ups (s 28A-s 28F; decision 29; HL12)

export type CashUp = {
  id: string;
  reference: string;
  employeeId: string;
  employeeName: string;
  requestedOn: string;
  agreedOn: string;
  weeks: string;
  hours: string;
  requestFileId: string;
  answerFileId: string;
  status: "agreed" | "cancelled";
  paidOn: { reference: string; status: string; amount: string } | null;
  createdByEmail: string;
  createdAt: string;
};

type CashUpRow = {
  id: string;
  cash_up_number: string;
  employee_id: string;
  employee_name: string;
  requested_on: string;
  agreed_on: string;
  weeks: string;
  hours: string;
  request_file_id: string;
  answer_file_id: string;
  status: "agreed" | "cancelled";
  paid_on: { reference: string; status: string; amount: string } | null;
  created_by_email: string;
  created_at: string;
  request_hash: string;
};

const CASH_UP_SELECT = `select c.id::text, c.cash_up_number::text, c.employee_id::text, e.first_name || ' ' || e.last_name as employee_name,
    c.requested_on::text, c.agreed_on::text, c.weeks::text, c.hours::text, c.request_file_id::text, c.answer_file_id::text, c.status,
    c.created_by_email, c.created_at::text, c.request_hash,
    (select jsonb_build_object('reference', 'PAYRUN-' || r.run_number, 'status', r.status, 'amount', l.amount::text)
       from payroll_pay_run_lines l join payroll_pay_runs r on r.id = l.pay_run_id
      where l.cash_up_id = c.id and r.status <> 'voided' order by r.run_number desc limit 1) as paid_on
  from payroll_cash_ups c join payroll_employees e on e.id = c.employee_id`;

function toCashUp(row: CashUpRow): CashUp {
  return {
    id: row.id,
    reference: `CASHUP-${row.cash_up_number}`,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    requestedOn: row.requested_on,
    agreedOn: row.agreed_on,
    weeks: toPlainString(dec(row.weeks)),
    hours: toPlainString(dec(row.hours)),
    requestFileId: row.request_file_id,
    answerFileId: row.answer_file_id,
    status: row.status,
    paidOn: row.paid_on,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

export async function listCashUps(tx: OrgTx, filters: { employeeId?: unknown } = {}): Promise<CashUp[]> {
  await requirePayrollAccess(tx);
  const result = await tx.query<CashUpRow>(`${CASH_UP_SELECT} where ($1::uuid is null or c.employee_id = $1) order by c.agreed_on desc, c.cash_up_number desc limit 500`, [
    filters.employeeId ? uuid(filters.employeeId, "employee") : null,
  ]);
  return result.rows.map(toCashUp);
}

/**
 * Records an agreed cash-up (decision 29; HL12): only with the employee's
 * written request and the employer's written answer attached; the portion
 * in weeks or hours, at most 1 week an entitlement year, never in advance,
 * never against a policy (s 28E). It's paid in the next pay run (s 28B(1)(b)).
 */
export async function createCashUp(
  tx: OrgTx,
  input: Record<string, unknown> & { request?: UploadedFile | null; answer?: UploadedFile | null },
): Promise<{ created: boolean; cashUp: CashUp; payRuns: string[] }> {
  await requirePayrollAccess(tx);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const { request, answer, ...fields } = input;
  const hash = requestHash("payroll_cash_up", { ...fields, request: fileHash(request), answer: fileHash(answer) });
  const earlier = await tx.query<CashUpRow>(`${CASH_UP_SELECT} where c.idempotency_key = $1`, [idempotencyKey]);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "cash-up");
    return { created: false, cashUp: toCashUp(earlier.rows[0]), payRuns: [] };
  }
  if (!request) throw new ValidationError("Attach the employee's written request to cash up (s 28A(2)(a)). A cash-up isn't saved without it.");
  if (!answer) throw new ValidationError("Attach the written answer agreeing to the cash-up (s 28A(3)(b)). A cash-up isn't saved without it.");
  const facts = await keptFacts(tx, input.employeeId);
  await tx.query("select 1 from payroll_employees where id = $1 for update", [facts.id]);
  const requestedOn = parseIsoDate(input.requestedOn, "Date of the request");
  const agreedOn = parseIsoDate(input.agreedOn ?? input.requestedOn, "Date agreed");
  if (agreedOn < requestedOn) throw new ValidationError("The cash-up can't be agreed before it was asked for.");
  if (agreedOn >= EMPLOYMENT_LEAVE_ACT_STARTS) throw new ValidationError(`${NOT_SUPPORTED}: cash-ups from 6 Aug 2028, under the Employment Leave Act 2026.`);
  const settings = settingsOn(facts, agreedOn);
  if (!settings) throw new ValidationError(`${facts.name} has no usual week on ${formatDate(agreedOn)}.`);
  const week = weekHours(settings.pattern);
  let weeks: string;
  let hours: string;
  if (input.hours !== undefined && input.hours !== null && input.hours !== "") {
    hours = parseDecimalInput(input.hours, "Hours", { maxScale: 2 });
    weeks = toPlainString(divide(dec(hours), week, 8));
  } else {
    weeks = parseDecimalInput(input.weeks, "Weeks", { maxScale: 4 });
    hours = toPlainString(mul(dec(weeks), week));
  }
  const balance = annualBalance(facts, agreedOn);
  const pending = await tx.query<{ weeks: string }>(
    `select coalesce(sum(c.weeks), 0)::text as weeks from payroll_cash_ups c
      where c.employee_id = $1 and c.status = 'agreed' and c.agreed_on between $2 and $3
        and not exists (select 1 from payroll_pay_run_lines l join payroll_pay_runs r on r.id = l.pay_run_id where l.cash_up_id = c.id and r.status = 'approved')`,
    [facts.id, balance.entitlementYear?.from ?? agreedOn, balance.entitlementYear?.to ?? agreedOn],
  );
  checkCashUp({
    weeks,
    cashedUpThisYear: toPlainString(add(balance.cashedUpThisYear, dec(pending.rows[0].weeks))),
    entitledBalance: subtractLeave(balance.balance, leaveHours(mul(dec(pending.rows[0].weeks), week), week)),
    weekHours: toPlainString(week),
    noCashUpPolicy: facts.noCashUps,
    hasEntitlement: balance.entitlementDates.length > 0,
  });
  const requestFileId = await storeFile(tx, facts.id, "cash_up_request", request);
  const answerFileId = await storeFile(tx, facts.id, "cash_up_answer", answer);
  const inserted = await tx.query<{ id: string }>(
    `insert into payroll_cash_ups (idempotency_key, request_hash, employee_id, requested_on, agreed_on, weeks, hours, week_hours, request_file_id,
                                   answer_file_id, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id::text`,
    [idempotencyKey, hash, facts.id, requestedOn, agreedOn, weeks, hours, toPlainString(week), requestFileId, answerFileId, tx.actor.userId, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "payroll_cash_up.agreed", entityType: "payroll_cash_up", entityId: id, details: { employeeId: facts.id, agreedOn, weeks } });
  const payRuns = await updateDraftsCovering(tx, facts.id, agreedOn, "9999-12-31");
  const created = await tx.query<CashUpRow>(`${CASH_UP_SELECT} where c.id = $1`, [id]);
  return { created: true, cashUp: toCashUp(created.rows[0]), payRuns };
}

export async function cancelCashUp(tx: OrgTx, idInput: unknown): Promise<{ cashUp: CashUp; payRuns: string[] }> {
  await requirePayrollAccess(tx);
  const id = uuid(idInput, "cash-up");
  const paid = await tx.query<{ run_number: string }>(
    "select r.run_number::text from payroll_pay_run_lines l join payroll_pay_runs r on r.id = l.pay_run_id where l.cash_up_id = $1 and r.status = 'approved' limit 1",
    [id],
  );
  if (paid.rows[0]) throw new ConflictError(`That cash-up was paid on PAYRUN-${paid.rows[0].run_number}, so it can't be cancelled. Void the pay run first.`);
  const result = await tx.query<{ employee_id: string; agreed_on: string }>(
    "update payroll_cash_ups set status = 'cancelled', cancelled_at = now(), cancelled_by_email = $2 where id = $1 and status = 'agreed' returning employee_id::text, agreed_on::text",
    [id, tx.actor.email],
  );
  if (!result.rows[0]) throw new NotFoundError("That cash-up wasn't found (or is already cancelled).");
  await writeAuditEvent(tx, { eventType: "payroll_cash_up.cancelled", entityType: "payroll_cash_up", entityId: id, details: {} });
  const payRuns = await updateDraftsCovering(tx, result.rows[0].employee_id, result.rows[0].agreed_on, "9999-12-31");
  const after = await tx.query<CashUpRow>(`${CASH_UP_SELECT} where c.id = $1`, [id]);
  return { cashUp: toCashUp(after.rows[0]), payRuns };
}

// Exchanging an alternative holiday (s 61; decision 24; HL33)

export type AlternativeExchange = {
  id: string;
  employeeId: string;
  aroseOn: string;
  requestedOn: string;
  agreedOn: string;
  defaultAmount: string;
  amount: string;
  agreementNote: string;
  agreementFileId: string | null;
  status: "agreed" | "cancelled";
};

/**
 * Records an agreed exchange of an alternative holiday for money (s 61;
 * decision 24): only once 12 months have passed since it arose, at RDP (or
 * ADP) for the exchange date unless another amount was agreed, with the
 * agreement recorded. Paid in the next pay run.
 */
export async function exchangeAlternativeHoliday(
  tx: OrgTx,
  input: Record<string, unknown> & { agreement?: UploadedFile | null },
): Promise<{ created: boolean; exchange: AlternativeExchange; payRuns: string[] }> {
  await requirePayrollAccess(tx);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const { agreement, ...fields } = input;
  const hash = requestHash("payroll_alternative_exchange", { ...fields, agreement: fileHash(agreement) });
  const earlier = await tx.query<{ id: string; request_hash: string }>("select id::text, request_hash from payroll_alternative_exchanges where idempotency_key = $1", [idempotencyKey]);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "exchange");
    return { created: false, exchange: await getExchange(tx, earlier.rows[0].id), payRuns: [] };
  }
  const facts = await keptFacts(tx, input.employeeId);
  const aroseOn = parseIsoDate(input.aroseOn, "Date the alternative holiday arose");
  const requestedOn = parseIsoDate(input.requestedOn, "Date of the request");
  const agreedOn = parseIsoDate(input.agreedOn ?? input.requestedOn, "Date agreed");
  if (requestedOn < addMonths(aroseOn, 12)) {
    throw new ValidationError(`An alternative holiday can be exchanged only once 12 months have passed since it arose (s 61(2)(a)): from ${formatDate(addMonths(aroseOn, 12))}.`);
  }
  if (agreedOn < requestedOn) throw new ValidationError("The exchange can't be agreed before it was asked for.");
  const untaken = alternativeHolidays(facts, agreedOn).find((holiday) => holiday.status === "untaken" && holiday.arose === aroseOn);
  if (!untaken) throw new ValidationError(`${facts.name} has no untaken alternative holiday that arose on ${formatDate(aroseOn)}.`);
  const anchor = await tx.query<{ period_start: string }>(
    "select r.period_start::text from payroll_pay_runs r join payroll_pay_run_employees pe on pe.pay_run_id = r.id where pe.employee_id = $1 order by r.period_start desc limit 1",
    [facts.id],
  );
  const daily = await dailyRateOn(tx, facts, {
    date: agreedOn,
    anchorPeriodStart: anchor.rows[0]?.period_start ?? agreedOn,
    recordsStart: recordsStartWith(facts, null),
    what: "The default for an exchanged alternative holiday",
  });
  const defaultAmount = daily ? toFixedString(daily.rate, 2) : "0.00";
  const amountInput = input.amount === undefined || input.amount === null || input.amount === "" ? null : parseDecimalInput(input.amount, "Amount agreed", { maxScale: 2 });
  const amount = amountInput ?? defaultAmount;
  if (!isPositive(dec(amount))) throw new ValidationError(`${formatDate(agreedOn)} isn't a working day for ${facts.name}, so there's no default; type the amount agreed (s 61(3)).`);
  const agreementNote = optionalString(input.agreementNote, "The agreement", { maxLength: 1000 });
  if (!agreementNote) throw new ValidationError("Record the agreement: what was asked and agreed, and when (decision 24).");
  const fileId = agreement ? await storeFile(tx, facts.id, "exchange_agreement", agreement) : null;
  const inserted = await tx.query<{ id: string }>(
    `insert into payroll_alternative_exchanges (idempotency_key, request_hash, employee_id, arose_on, requested_on, agreed_on, default_amount, amount,
                                                agreement_note, agreement_file_id, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id::text`,
    [idempotencyKey, hash, facts.id, aroseOn, requestedOn, agreedOn, defaultAmount, amount, agreementNote, fileId, tx.actor.userId, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "payroll_alternative_holiday.exchanged", entityType: "payroll_employee", entityId: facts.id, details: { aroseOn, agreedOn } });
  const payRuns = await updateDraftsCovering(tx, facts.id, agreedOn, "9999-12-31");
  return { created: true, exchange: await getExchange(tx, inserted.rows[0].id), payRuns };
}

async function getExchange(tx: OrgTx, id: string): Promise<AlternativeExchange> {
  const result = await tx.query<{
    id: string;
    employee_id: string;
    arose_on: string;
    requested_on: string;
    agreed_on: string;
    default_amount: string;
    amount: string;
    agreement_note: string;
    agreement_file_id: string | null;
    status: "agreed" | "cancelled";
  }>(
    `select id::text, employee_id::text, arose_on::text, requested_on::text, agreed_on::text, default_amount::text, amount::text, agreement_note,
            agreement_file_id::text, status from payroll_alternative_exchanges where id = $1`,
    [id],
  );
  const row = result.rows[0];
  return {
    id: row.id,
    employeeId: row.employee_id,
    aroseOn: row.arose_on,
    requestedOn: row.requested_on,
    agreedOn: row.agreed_on,
    defaultAmount: toFixedString(dec(row.default_amount), 2),
    amount: toFixedString(dec(row.amount), 2),
    agreementNote: row.agreement_note,
    agreementFileId: row.agreement_file_id,
    status: row.status,
  };
}

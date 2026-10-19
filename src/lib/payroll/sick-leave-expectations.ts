import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { dec, isNegative, isZero, parseDecimalInput, sub, toFixedString, toPlainString } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { getLeaveSummary } from "@/lib/payroll/leave-reports";
import { optionalSource, optionalString, requireIdempotencyKey } from "@/lib/validation";

/**
 * Sick leave expected to be used from carried-over leave (#310 item 4;
 * HL62, decision 564). NZ IAS 19 and PBE IPSAS 39 paras 16-17 measure
 * accumulating paid absences at the additional amount expected to be paid
 * because of the unused entitlement carried over: not every unused day,
 * only the days people are expected to take beyond their new entitlements.
 * Tohyee can't know that, so someone with payroll access types the days
 * for an employee from a date, with the reason; the leave liability report
 * values them at a usual day's pay (decision 153) and they're posted with
 * the rest. Never edited: a later assessment replaces it, and 0 days ends
 * it.
 */

export type SickLeaveExpectation = {
  id: string;
  employeeId: string;
  effectiveFrom: string;
  days: string;
  reason: string | null;
  createdByEmail: string;
  createdAt: string;
};

type Row = { id: string; employee_id: string; effective_from: string; days: string; reason: string | null; created_by_email: string; created_at: string };

const SELECT = `select id::text, employee_id::text, effective_from::text, days::text, reason, created_by_email, created_at::text from payroll_sick_leave_expectations`;

const toExpectation = (row: Row): SickLeaveExpectation => ({
  id: row.id,
  employeeId: row.employee_id,
  effectiveFrom: row.effective_from,
  days: toFixedString(dec(row.days), 2),
  reason: row.reason,
  createdByEmail: row.created_by_email,
  createdAt: row.created_at,
});

/** Every assessment, newest first (optionally one employee's). Payroll access. */
export async function listSickLeaveExpectations(tx: OrgTx, employeeId?: string): Promise<SickLeaveExpectation[]> {
  await requirePayrollAccess(tx);
  const rows = employeeId
    ? await tx.query<Row>(`${SELECT} where employee_id::text = $1 order by effective_from desc, entry_number desc`, [employeeId])
    : await tx.query<Row>(`${SELECT} order by effective_from desc, entry_number desc limit 500`);
  return rows.rows.map(toExpectation);
}

/**
 * Records an assessment (HL62): refused for an employee whose leave Tohyee
 * doesn't keep, for more days than their sick leave balance on the date,
 * and without a reason (unless 0 days).
 */
export async function setSickLeaveExpectation(
  tx: OrgTx,
  command: { source?: unknown; idempotencyKey: unknown; employeeId: unknown; effectiveFrom: unknown; days: unknown; reason?: unknown },
): Promise<{ created: boolean; expectation: SickLeaveExpectation }> {
  await requirePayrollAccess(tx);
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const effectiveFrom = parseIsoDate(command.effectiveFrom, "From");
  const days = parseDecimalInput(command.days, "Expected sick days", { maxScale: 2, allowNegative: false, allowZero: true });
  const reason = optionalString(command.reason, "Reason", { maxLength: 500 });
  const hash = requestHash("payroll_sick_leave_expectation", { employeeId: command.employeeId, effectiveFrom, days: toPlainString(dec(days)), reason });
  const earlier = await tx.query<Row & { request_hash: string }>(`${SELECT.replace("created_at::text", "created_at::text, request_hash")} where command_source = $1 and idempotency_key = $2`, [source, idempotencyKey]);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "expected sick leave");
    return { created: false, expectation: toExpectation(earlier.rows[0]) };
  }
  const summary = await getLeaveSummary(tx, command.employeeId, effectiveFrom);
  if (!summary.kept || !summary.sick) {
    throw new ValidationError(summary.notKeptReason ?? `Tohyee doesn't keep ${summary.name}'s sick leave at ${formatDate(effectiveFrom)}.`);
  }
  if (!isZero(dec(days)) && !reason) throw new ValidationError("Say why these days are expected (for example, the sick leave taken in past years).");
  if (isNegative(sub(dec(summary.sick.days), dec(days)))) {
    throw new ValidationError(
      `${summary.name} has ${toPlainString(dec(summary.sick.days))} days' sick leave at ${formatDate(effectiveFrom)}, so at most that many can be expected to be used from it.`,
    );
  }
  const inserted = await tx.query<Row>(
    `insert into payroll_sick_leave_expectations (command_source, idempotency_key, request_hash, employee_id, effective_from, days, reason, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id::text, employee_id::text, effective_from::text, days::text, reason, created_by_email, created_at::text`,
    [source, idempotencyKey, hash, summary.employeeId, effectiveFrom, days, reason, tx.actor.email],
  );
  const expectation = toExpectation(inserted.rows[0]);
  await writeAuditEvent(tx, { eventType: "payroll_sick_leave_expectation.recorded", entityType: "payroll_employee", entityId: summary.employeeId, details: { effectiveFrom, days: expectation.days } });
  return { created: true, expectation };
}

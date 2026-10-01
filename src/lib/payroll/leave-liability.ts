import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { formatDate, formatMoney } from "@/lib/format";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { getJournal, parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { dec, isZero, sub, toFixedString } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { type DepartmentLiability, liabilityChanges, postingLines } from "@/lib/payroll/leave/liability-posting";
import { leaveLiabilityReport } from "@/lib/payroll/leave-reports";
import { leaveLiabilityAccountIds } from "@/lib/payroll/pay-items";
import { loadTrackingContext, missingRequired, sortedTags, trackingKey, type TrackingTags } from "@/lib/tracking/service";
import { optionalSource, requireIdempotencyKey } from "@/lib/validation";

/**
 * Posting the leave liability to the ledger (decision 177; decisions
 * 182-187; examples HL52-HL56). "Post leave liability" at a date makes one
 * journal for the change since the last posting not voided: the liability
 * report's total at that date (annual holidays entitled to, the running 8%
 * and untaken alternative holidays; decision 153) less what that posting
 * left, Dr leave expense / Cr employee entitlements (or the other way for a
 * fall), by the report's Departments, never naming employees. Sick,
 * bereavement and family violence leave are never in it. A posting is
 * never edited: voiding the latest posts the reversing journal. Payroll
 * access only (the routes need the bookkeeper role too); audited without
 * figures.
 */

export type LeaveLiabilityPostingStatus = "active" | "voided";

export type LeaveLiabilityPosting = {
  id: string;
  /** LEAVELIAB-n: the journal reference. */
  reference: string;
  asAt: string;
  liability: string;
  change: string;
  previousReference: string | null;
  expenseAccountCode: string;
  liabilityAccountCode: string;
  departments: Array<{ departmentId: string | null; department: string | null; liability: string }>;
  journalId: string;
  status: LeaveLiabilityPostingStatus;
  createdByEmail: string;
  createdAt: string;
  voidDate: string | null;
  voidJournalId: string | null;
  voidedByEmail: string | null;
};

export function leaveLiabilityReference(postingNumber: string | number): string {
  return `LEAVELIAB-${postingNumber}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PostingRow = {
  id: string;
  posting_number: string;
  as_at: string;
  liability: string;
  change: string;
  previous_number: string | null;
  expense_code: string;
  liability_code: string;
  liability_account_id: string;
  journal_id: string;
  status: LeaveLiabilityPostingStatus;
  created_by_email: string;
  created_at: string;
  void_date: string | null;
  void_journal_id: string | null;
  voided_by_email: string | null;
};

const POSTING_SELECT = `select p.id, p.posting_number::text, p.as_at::text, p.liability::text, p.change::text, prev.posting_number::text as previous_number,
         e.code as expense_code, l.code as liability_code, p.liability_account_id::text, p.journal_id::text, p.status,
         p.created_by_email, p.created_at::text, p.void_date::text, p.void_journal_id::text, p.voided_by_email
    from payroll_leave_liability_postings p
    join accounts e on e.id = p.expense_account_id
    join accounts l on l.id = p.liability_account_id
    left join payroll_leave_liability_postings prev on prev.id = p.previous_posting_id`;

async function departmentsOf(tx: OrgTx, postingIds: string[]): Promise<Map<string, LeaveLiabilityPosting["departments"]>> {
  const result = new Map<string, LeaveLiabilityPosting["departments"]>();
  if (postingIds.length === 0) return result;
  const rows = await tx.query<{ posting_id: string; department_id: string | null; department: string | null; liability: string }>(
    `select d.posting_id::text, d.department_id::text, v.name as department, d.liability::text
       from payroll_leave_liability_departments d left join tracking_values v on v.id = d.department_id
      where d.posting_id = any($1::uuid[]) order by d.posting_id, d.line_number`,
    [postingIds],
  );
  for (const row of rows.rows) {
    const list = result.get(row.posting_id) ?? [];
    list.push({ departmentId: row.department_id, department: row.department, liability: toFixedString(dec(row.liability), 2) });
    result.set(row.posting_id, list);
  }
  return result;
}

function toPosting(row: PostingRow, departments: LeaveLiabilityPosting["departments"]): LeaveLiabilityPosting {
  return {
    id: row.id,
    reference: leaveLiabilityReference(row.posting_number),
    asAt: row.as_at,
    liability: toFixedString(dec(row.liability), 2),
    change: toFixedString(dec(row.change), 2),
    previousReference: row.previous_number ? leaveLiabilityReference(row.previous_number) : null,
    expenseAccountCode: row.expense_code,
    liabilityAccountCode: row.liability_code,
    departments,
    journalId: row.journal_id,
    status: row.status,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    voidDate: row.void_date,
    voidJournalId: row.void_journal_id,
    voidedByEmail: row.voided_by_email,
  };
}

async function findPosting(tx: OrgTx, id: string): Promise<LeaveLiabilityPosting> {
  const result = await tx.query<PostingRow>(`${POSTING_SELECT} where p.id = $1`, [id]);
  if (!result.rows[0]) throw new NotFoundError("That leave liability posting wasn't found.");
  return toPosting(result.rows[0], (await departmentsOf(tx, [id])).get(id) ?? []);
}

/** Every posting, newest first, voided ones included (Payroll › Leave › Liability). */
export async function listLeaveLiabilityPostings(tx: OrgTx): Promise<LeaveLiabilityPosting[]> {
  await requirePayrollAccess(tx);
  const rows = (await tx.query<PostingRow>(`${POSTING_SELECT} order by p.posting_number desc limit 200`)).rows;
  const departments = await departmentsOf(tx, rows.map((row) => row.id));
  return rows.map((row) => toPosting(row, departments.get(row.id) ?? []));
}

/** The last posting not voided, which the next one measures from (HL54). */
async function lastActive(tx: OrgTx): Promise<PostingRow | null> {
  const result = await tx.query<PostingRow>(`${POSTING_SELECT} where p.status = 'active' order by p.posting_number desc limit 1`);
  return result.rows[0] ?? null;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

const LOCK = "select pg_advisory_xact_lock(hashtext('payroll_leave_liability_postings'))";

/**
 * Posts the leave liability at a date (HL52, HL53, HL55): refused before the
 * last posting not voided, in a locked period, without the two accounts, while
 * any employee's row in the liability report has a problem (naming them), or
 * when nothing has changed (HL54, decision 182).
 */
export async function postLeaveLiability(
  tx: OrgTx,
  command: { source?: unknown; idempotencyKey: unknown; asAt: unknown },
): Promise<{ created: boolean; posting: LeaveLiabilityPosting }> {
  await requirePayrollAccess(tx);
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const asAt = parseIsoDate(command.asAt, "As at");
  const hash = requestHash("payroll_leave_liability_posting", { asAt });
  const replay = async () => {
    const earlier = await tx.query<{ id: string; request_hash: string }>(
      "select id, request_hash from payroll_leave_liability_postings where command_source = $1 and idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].request_hash, hash, "leave liability posting");
    return { created: false, posting: await findPosting(tx, earlier.rows[0].id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  await tx.query(LOCK);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;

  const accounts = await leaveLiabilityAccountIds(tx);
  if (!accounts.expenseAccountId || !accounts.liabilityAccountId) {
    throw new ValidationError(
      "Choose the leave expense account and the employee entitlements account under Payroll › Pay items before posting the leave liability.",
    );
  }
  const last = await lastActive(tx);
  if (last && asAt < last.as_at) {
    throw new ValidationError(
      `${leaveLiabilityReference(last.posting_number)} posted the leave liability at ${formatDate(last.as_at)}, so a posting can't be dated before it. Void it first to post an earlier date.`,
    );
  }
  if (last && last.liability_account_id !== accounts.liabilityAccountId && !isZero(dec(last.liability))) {
    throw new ConflictError(
      `${leaveLiabilityReference(last.posting_number)} left the leave liability in account ${last.liability_code}, which isn't the employee entitlements account any more. Void the postings or change the account back.`,
    );
  }
  await assertPostingDateAllowed(tx, asAt);

  const report = await leaveLiabilityReport(tx, { asAt });
  const problems = report.rows.filter((row) => row.problem !== null);
  if (problems.length > 0) {
    throw new ValidationError(
      `The leave liability at ${formatDate(asAt)} can't be posted while the liability report has problems: ${problems.map((row) => `${row.name}: ${row.problem}`).join(" ")}`,
    );
  }
  const current: DepartmentLiability[] = report.departments
    .filter((department) => !isZero(dec(department.total)))
    .map((department) => ({ departmentId: department.departmentId, liability: department.total }));
  const previous: DepartmentLiability[] = last
    ? (await departmentsOf(tx, [last.id])).get(last.id)?.map((entry) => ({ departmentId: entry.departmentId, liability: entry.liability })) ?? []
    : [];
  const changes = liabilityChanges(current, previous);

  const ctx = await loadTrackingContext(tx);
  const tagsOf = (departmentId: string | null): TrackingTags => {
    if (!ctx.advancedFeatures || !departmentId) return {};
    const value = ctx.values.get(departmentId);
    return value ? sortedTags({ [value.categoryId]: value.id }) : {};
  };
  const groups = new Map<string, TrackingTags>();
  const grouped = changes.map((change) => {
    const tags = tagsOf(change.departmentId);
    const group = trackingKey(tags);
    groups.set(group, tags);
    return { group, change: change.change };
  });
  for (const [, tags] of groups) {
    const missing = missingRequired(ctx, tags, "expense");
    if (missing) {
      const without = report.rows.filter((row) => !row.departmentId && !isZero(dec(row.total))).map((row) => row.name);
      throw new ValidationError(
        without.length > 0
          ? `Expense lines need a ${missing}, and ${without.join(", ")} ${without.length === 1 ? "has" : "have"} none in their cost allocation at ${formatDate(asAt)}. Fix it under Employees › Cost allocation.`
          : `Expense lines need a ${missing}, and part of the leave liability last posted had none. Void that posting first.`,
      );
    }
  }
  const lines = postingLines(grouped);
  if (lines.length === 0) {
    throw new ConflictError(
      last
        ? `Nothing to post: the leave liability at ${formatDate(asAt)} is the ${formatMoney(report.totals.total)} ${leaveLiabilityReference(last.posting_number)} left.`
        : `Nothing to post: the leave liability at ${formatDate(asAt)} is 0.00.`,
    );
  }

  const codes = await tx.query<{ id: string; code: string }>("select id::text, code from accounts where id = any($1::bigint[])", [
    [accounts.expenseAccountId, accounts.liabilityAccountId],
  ]);
  const codeOf = new Map(codes.rows.map((row) => [row.id, row.code]));
  const next = await tx.query<{ posting_number: string }>(
    "select nextval(pg_get_serial_sequence('payroll_leave_liability_postings', 'posting_number'))::text as posting_number",
  );
  const postingNumber = next.rows[0].posting_number;
  const reference = leaveLiabilityReference(postingNumber);
  const posted = await postJournalBody(
    tx,
    "payroll:leave_liability",
    postingNumber,
    parseJournalBody(
      tx,
      {
        postingDate: asAt,
        reference,
        description: `Leave liability at ${formatDate(asAt)}`,
        lines: lines.map((line) => ({
          accountCode: codeOf.get(line.account === "expense" ? accounts.expenseAccountId! : accounts.liabilityAccountId!)!,
          debitAmount: line.debit,
          creditAmount: line.credit,
          description: line.account === "expense" ? "Leave expense" : "Employee entitlements",
          tracking: groups.get(line.group) ?? {},
        })),
      },
      { internal: true },
    ),
    { origin: "payroll" },
  );
  const change = toFixedString(sub(dec(report.totals.total), dec(last?.liability ?? "0")), 2);
  let postingId: string;
  try {
    const inserted = await tx.query<{ id: string }>(
      `insert into payroll_leave_liability_postings (posting_number, command_source, idempotency_key, request_hash, as_at, expense_account_id,
                                                     liability_account_id, liability, change, previous_posting_id, journal_id,
                                                     created_by_user_id, created_by_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10, $11, $12, $13) returning id`,
      [
        postingNumber,
        source,
        idempotencyKey,
        hash,
        asAt,
        accounts.expenseAccountId,
        accounts.liabilityAccountId,
        report.totals.total,
        change,
        last?.id ?? null,
        posted.journal.id,
        tx.actor.userId,
        tx.actor.email,
      ],
    );
    postingId = inserted.rows[0].id;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different leave liability posting. Use a new key.");
    throw error;
  }
  for (const [index, department] of current.entries()) {
    await tx.query(
      "insert into payroll_leave_liability_departments (posting_id, line_number, department_id, liability) values ($1, $2, $3, $4::numeric)",
      [postingId, index + 1, department.departmentId, department.liability],
    );
  }
  await writeAuditEvent(tx, {
    eventType: "payroll_leave_liability.posted",
    entityType: "payroll_leave_liability_posting",
    entityId: postingId,
    // Never the amounts: with one employee in a Department they're that person's (decision 186).
    details: { reference, asAt, journalId: posted.journal.id, previous: last ? leaveLiabilityReference(last.posting_number) : null, departments: current.length },
  });
  return { created: true, posting: await findPosting(tx, postingId) };
}

/**
 * Voids the latest posting not voided (HL54, decision 183): the exact
 * reversal of its journal on the void date (on or after its date, in an
 * open period). The next posting then measures from the one before it.
 */
export async function voidLeaveLiabilityPosting(
  tx: OrgTx,
  idInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<{ created: boolean; posting: LeaveLiabilityPosting }> {
  await requirePayrollAccess(tx);
  if (typeof idInput !== "string" || !UUID_PATTERN.test(idInput)) throw new NotFoundError("That leave liability posting wasn't found.");
  const id = idInput;
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "Void date");
  const hash = requestHash("payroll_leave_liability_void", { id, voidDate });
  const replay = async () => {
    const earlier = await tx.query<{ id: string; void_request_hash: string }>(
      "select id, void_request_hash from payroll_leave_liability_postings where void_command_source = $1 and void_idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].void_request_hash, hash, "leave liability void");
    return { created: false, posting: await findPosting(tx, earlier.rows[0].id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  await tx.query(LOCK);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  const posting = await findPosting(tx, id);
  if (posting.status === "voided") throw new ConflictError(`${posting.reference} has already been voided.`);
  const last = await lastActive(tx);
  if (last && last.id !== posting.id) {
    throw new ConflictError(`${leaveLiabilityReference(last.posting_number)} measured from ${posting.reference}. Void it first (the latest posting is voided first).`);
  }
  if (voidDate < posting.asAt) throw new ValidationError(`The void date can't be before ${posting.reference}'s date (${posting.asAt}).`);
  await assertPostingDateAllowed(tx, voidDate);
  const original = await getJournal(tx, posting.journalId);
  const posted = await postJournalBody(
    tx,
    "payroll:leave_liability_void",
    posting.id,
    parseJournalBody(
      tx,
      {
        postingDate: voidDate,
        reference: `VOID-${original.reference}`.slice(0, 100),
        description: `Void of ${original.description ?? posting.reference}`.slice(0, 500),
        lines: original.lines.map((line) => ({
          accountCode: line.accountCode,
          debitAmount: line.creditAmount,
          creditAmount: line.debitAmount,
          description: line.description,
          tracking: line.tracking,
        })),
      },
      { internal: true },
    ),
    { origin: "payroll", relatedJournalId: original.id, correctionKind: "reversal" },
  );
  try {
    await tx.query(
      `update payroll_leave_liability_postings
          set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = $4, void_idempotency_key = $5,
              void_request_hash = $6, voided_by_user_id = $7, voided_by_email = $8, voided_at = now()
        where id = $1`,
      [posting.id, voidDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different leave liability void. Use a new key.");
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "payroll_leave_liability.voided",
    entityType: "payroll_leave_liability_posting",
    entityId: posting.id,
    details: { reference: posting.reference, voidDate, journalId: posted.journal.id },
  });
  return { created: true, posting: await findPosting(tx, posting.id) };
}

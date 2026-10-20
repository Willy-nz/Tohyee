import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { financialYearEnd, financialYearStart } from "@/lib/financial-year";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { dec, isPositive, parseDecimalInput, toFixedString } from "@/lib/money/decimal";
import { getGstRegistration, isRegisteredOn } from "@/lib/tax/registration";
import { requireId, requireIdempotencyKey, requireString } from "@/lib/validation";
import { requireLivestock, requireRationsAccounts } from "./movements";
import { rationsAdjustmentPosting } from "./rations-rules";

/*
 * The owner's rations (homekill) as one adjustment a year (examples RAT1,
 * RAT3-RAT10, decisions 624-627; Jess, 20 October 2026: "Home kill the
 * accountant just does a jnl adjustment like 500 bucks", and "One yearly
 * adjustment" rather than assessing each animal). The accountant enters the
 * amount, its basis and whether GST applies (GST-registered on the date only,
 * and whether the amount includes it). It posts Dr owner drawings or current
 * account, Cr rations income (and Cr GST), on the balance date or a date in
 * the year, and with GST counts in that date's GST return. The year's
 * homekill head count is shown beside it, for information. One a year: a
 * different amount means voiding this one (with a reason; reversed on its
 * date) and entering another. Bookkeepers and above (the routes check).
 */

export type RationsAdjustment = {
  id: string;
  yearEnd: string;
  adjustmentDate: string;
  amount: string;
  reason: string;
  gstApplies: boolean;
  amountIncludesGst: boolean | null;
  netAmount: string;
  gstAmount: string;
  journalId: string;
  createdByEmail: string | null;
  createdAt: string;
  voided: { at: string; byEmail: string | null; reason: string } | null;
};

export type RationsYear = {
  yearStart: string;
  yearEnd: string;
  /** Head killed for the owner's household this year (not voided): for information only. */
  ownerHead: number;
  staffHead: number;
  /** Rations income posted per event before 20 Oct 2026 for this year, still standing (RAT9). */
  postedPerEvent: string;
  /** GST-registered on the balance date. */
  gstRegistered: boolean;
  current: RationsAdjustment | null;
  voided: RationsAdjustment[];
};

type Row = {
  id: string;
  request_hash: string;
  year_end: string;
  adjustment_date: string;
  amount: string;
  reason: string;
  gst_applies: boolean;
  amount_includes_gst: boolean | null;
  net_amount: string;
  gst_amount: string;
  journal_id: string;
  created_by_email: string | null;
  created_at: string;
  voided_at: string | null;
  voided_by_email: string | null;
  void_reason: string | null;
};

const COLUMNS = `id::text, request_hash, year_end::text, adjustment_date::text, amount::text, reason, gst_applies, amount_includes_gst,
  net_amount::text, gst_amount::text, journal_id::text, created_by_email, created_at::text, voided_at::text, voided_by_email, void_reason`;

function toAdjustment(row: Row): RationsAdjustment {
  return {
    id: row.id,
    yearEnd: row.year_end,
    adjustmentDate: row.adjustment_date,
    amount: row.amount,
    reason: row.reason,
    gstApplies: row.gst_applies,
    amountIncludesGst: row.amount_includes_gst,
    netAmount: row.net_amount,
    gstAmount: row.gst_amount,
    journalId: row.journal_id,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    voided: row.voided_at ? { at: row.voided_at, byEmail: row.voided_by_email, reason: row.void_reason! } : null,
  };
}

/** The financial year ending on this date, which must be a balance date. */
function yearOf(yearEndInput: unknown, endMonth: number): { yearStart: string; yearEnd: string } {
  const yearEnd = parseIsoDate(yearEndInput, "yearEnd");
  if (financialYearEnd(yearEnd, endMonth) !== yearEnd) throw new ValidationError(`${yearEnd} isn't a balance date.`);
  return { yearStart: financialYearStart(yearEnd, endMonth), yearEnd };
}

/** The year's homekill head count, what was posted per event before, and the adjustment (RAT5, RAT9). */
export async function getRationsYear(tx: OrgTx, input: { yearEnd: unknown }): Promise<RationsYear> {
  const settings = await requireLivestock(tx);
  const { yearStart, yearEnd } = yearOf(input.yearEnd, settings.financialYearEndMonth);
  const heads = await tx.query<{ owner: number; staff: number; posted: string }>(
    `select coalesce(sum(head) filter (where rations_for = 'owner'), 0)::integer as owner,
            coalesce(sum(head) filter (where rations_for = 'staff'), 0)::integer as staff,
            coalesce(sum(amount) filter (where rations_for = 'owner' and journal_id is not null), 0)::text as posted
       from livestock_movements
      where movement_type = 'rations' and voided_at is null and movement_date between $1 and $2`,
    [yearStart, yearEnd],
  );
  const rows = await tx.query<Row>(`select ${COLUMNS} from livestock_rations_adjustments where year_end = $1 order by livestock_rations_adjustments.id`, [yearEnd]);
  const all = rows.rows.map(toAdjustment);
  return {
    yearStart,
    yearEnd,
    ownerHead: heads.rows[0].owner,
    staffHead: heads.rows[0].staff,
    postedPerEvent: toFixedString(dec(heads.rows[0].posted), 2),
    gstRegistered: isRegisteredOn(await getGstRegistration(tx), yearEnd),
    current: all.find((entry) => !entry.voided) ?? null,
    voided: all.filter((entry) => entry.voided),
  };
}

async function gstAccountCode(tx: OrgTx): Promise<string> {
  const account = await tx.query<{ code: string }>("select code from accounts where system_key = 'gst'");
  if (!account.rows[0]) throw new ValidationError("The GST account isn't set up, so the GST can't be posted.");
  return account.rows[0].code;
}

async function standardSalesCode(tx: OrgTx): Promise<string> {
  const code = await tx.query<{ id: string }>(
    "select tax_codes.id::text as id from tax_codes where category = 'standard' and rate = 0.15 and is_active order by (code = 'GST') desc, tax_codes.id limit 1",
  );
  if (!code.rows[0]) throw new ValidationError("There's no active 15% GST tax code to count it under. Add one under Settings › Tax codes.");
  return code.rows[0].id;
}

/** Enters the year's homekill adjustment and posts it (RAT5-RAT8, RAT10). */
export async function addRationsAdjustment(
  tx: OrgTx,
  input: { idempotencyKey: unknown; yearEnd: unknown; adjustmentDate?: unknown; amount: unknown; reason: unknown; gstApplies?: unknown; amountIncludesGst?: unknown },
): Promise<{ created: boolean; adjustment: RationsAdjustment }> {
  const settings = await requireLivestock(tx);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const { yearStart, yearEnd } = yearOf(input.yearEnd, settings.financialYearEndMonth);
  const adjustmentDate = input.adjustmentDate == null || input.adjustmentDate === "" ? yearEnd : parseIsoDate(input.adjustmentDate, "The date");
  if (adjustmentDate < yearStart || adjustmentDate > yearEnd) throw new ValidationError(`The date must be in the year, ${yearStart} to ${yearEnd}.`);
  const amount = parseDecimalInput(input.amount, "The amount", { maxScale: 2 });
  if (!isPositive(dec(amount))) throw new ValidationError("The amount must be more than nil.");
  const reason = requireString(input.reason, "The basis", { maxLength: 500 });
  if (input.gstApplies !== undefined && input.gstApplies !== null && typeof input.gstApplies !== "boolean") throw new ValidationError("Say whether GST applies (true or false).");
  const gstApplies = input.gstApplies === true;
  if (!gstApplies && input.amountIncludesGst !== undefined && input.amountIncludesGst !== null) throw new ValidationError("Only say whether the amount includes GST when GST applies.");
  if (gstApplies && typeof input.amountIncludesGst !== "boolean") throw new ValidationError("Say whether the amount includes GST.");
  const amountIncludesGst = gstApplies ? (input.amountIncludesGst as boolean) : null;
  const hash = requestHash("livestock_rations_adjustment", { yearEnd, adjustmentDate, amount, reason, gstApplies, amountIncludesGst });
  const earlier = await tx.query<Row>(`select ${COLUMNS} from livestock_rations_adjustments where idempotency_key = $1`, [key]);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "homekill adjustment");
    return { created: false, adjustment: toAdjustment(earlier.rows[0]) };
  }
  if (gstApplies && !isRegisteredOn(await getGstRegistration(tx), adjustmentDate)) {
    throw new ValidationError(`This organisation wasn't GST-registered on ${adjustmentDate}, so GST can't apply.`);
  }
  await tx.query("select pg_advisory_xact_lock(hashtext('livestock_rations_adjustments'))");
  const existing = await tx.query<{ id: string }>("select id::text from livestock_rations_adjustments where year_end = $1 and voided_at is null", [yearEnd]);
  if (existing.rows[0]) throw new ConflictError("There's already a homekill adjustment for this year. Void it, with a reason, to enter a different one.");
  const accounts = await requireRationsAccounts(tx);
  const posting = rationsAdjustmentPosting({ amount: dec(amount), gstApplies, includesGst: amountIncludesGst === true });
  const lines = [
    { accountCode: accounts.drawings, debitAmount: posting.drawings, creditAmount: "0" },
    { accountCode: accounts.income, debitAmount: "0", creditAmount: posting.income },
  ];
  if (gstApplies) lines.push({ accountCode: await gstAccountCode(tx), debitAmount: "0", creditAmount: posting.gst });
  const taxCodeId = gstApplies ? await standardSalesCode(tx) : null;
  const journal = await postJournalBody(
    tx,
    "livestock_rations:year",
    key,
    parseJournalBody(tx, {
      postingDate: adjustmentDate,
      reference: `HOMEKILL-${yearEnd}`,
      description: `Owner's rations (homekill) for the year ended ${yearEnd}: ${reason}`.slice(0, 500),
      lines,
    }),
    { origin: "livestock_rations" },
  );
  const inserted = await tx.query<Row>(
    `insert into livestock_rations_adjustments (idempotency_key, request_hash, year_end, adjustment_date, amount, reason, gst_applies, amount_includes_gst,
       net_amount, gst_amount, tax_code_id, journal_id, created_by_email)
     values ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9::numeric, $10::numeric, $11, $12, $13) returning ${COLUMNS}`,
    [key, hash, yearEnd, adjustmentDate, amount, reason, gstApplies, amountIncludesGst, posting.income, posting.gst, taxCodeId, journal.journal.id, tx.actor.email],
  );
  const adjustment = toAdjustment(inserted.rows[0]);
  await writeAuditEvent(tx, {
    eventType: "livestock.rations_adjustment_added",
    entityType: "livestock_rations_adjustment",
    entityId: adjustment.id,
    details: { yearEnd, adjustmentDate, amount, reason, gstApplies, amountIncludesGst, gst: posting.gst, journalId: journal.journal.id },
  });
  return { created: true, adjustment };
}

/** Voids the year's adjustment with a reason: its journal is reversed on its own date (RAT8). */
export async function voidRationsAdjustment(tx: OrgTx, idInput: unknown, input: { reason: unknown }): Promise<RationsAdjustment> {
  await requireLivestock(tx);
  const id = requireId(idInput, "adjustmentId");
  const reason = requireString(input.reason, "A reason", { maxLength: 500 });
  const found = await tx.query<Row>(`select ${COLUMNS} from livestock_rations_adjustments where id = $1 for update`, [id]);
  const row = found.rows[0];
  if (!row) throw new NotFoundError("Homekill adjustment not found.");
  if (row.voided_at) throw new ConflictError("That adjustment is already voided.");
  const original = await tx.query<{ account_code: string; debit: string; credit: string }>(
    `select a.code as account_code, l.debit_amount::text as debit, l.credit_amount::text as credit
       from ledger_journal_lines l join accounts a on a.id = l.account_id where l.journal_id = $1 order by l.id`,
    [row.journal_id],
  );
  const reversal = await postJournalBody(
    tx,
    "livestock_rations:year-void",
    id,
    parseJournalBody(tx, {
      postingDate: row.adjustment_date,
      reference: `HOMEKILL-${row.year_end}`,
      description: `Voided: ${reason}`.slice(0, 500),
      lines: original.rows.map((line) => ({ accountCode: line.account_code, debitAmount: line.credit, creditAmount: line.debit })),
    }),
    { origin: "livestock_rations", relatedJournalId: row.journal_id, correctionKind: "reversal" },
  );
  const updated = await tx.query<Row>(
    `update livestock_rations_adjustments set voided_at = now(), voided_by_email = $2, void_reason = $3, void_journal_id = $4 where id = $1 returning ${COLUMNS}`,
    [id, tx.actor.email, reason, reversal.journal.id],
  );
  await writeAuditEvent(tx, { eventType: "livestock.rations_adjustment_voided", entityType: "livestock_rations_adjustment", entityId: id, details: { reason, voidJournalId: reversal.journal.id } });
  return toAdjustment(updated.rows[0]);
}

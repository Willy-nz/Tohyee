import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { dec, isPositive, parseDecimalInput, toFixedString } from "@/lib/money/decimal";
import type { GstAdjustment } from "@/lib/reports/gst-boxes";
import { getGstRegistration, isRegisteredOn } from "@/lib/tax/registration";
import { requireOneOf, requireString } from "@/lib/validation";
import { className } from "./classes";
import type { LivestockKind } from "./classes";
import { RATIONS_GST_OUTCOMES, type RationsGstOutcome, type RationsGstStatus, rationsPosting, type RationsPosting, supplyGst } from "./rations-gst-rules";

/*
 * GST on the owner's rations (examples RAT1, RAT5-RAT10, decisions 624-627;
 * Codex, delegated by owner (via Will), 20 October 2026). Each owner's
 * rations event on a GST-registered date is assessed on its own: a
 * confirmed taxable supply, a confirmed change-in-use adjustment (a reviewed
 * GST amount), or no adjustment with evidence. Until then it's unresolved,
 * and GST return preparation lists it rather than showing nil. A new
 * assessment replaces the last (kept, with the reason), and when the
 * amounts change the rations journal is reversed and posted again on the
 * event's date. Taxable supplies count in the GST return as sales lines on
 * the event's date; change-in-use adjustments go in Box 9 (gst-return.ts
 * calls `rationsForGstReturn`). Filed returns are never changed: what
 * changes after filing is caught up in the next return. There's no input
 * GST claim, and no bank movement. Staff rations (RAT2) aren't assessed:
 * they need their own analysis.
 */

export type RationsGst = {
  status: RationsGstStatus;
  /** The current assessment, when there is one. */
  assessmentId: string | null;
  gstAmount: string | null;
  basis: string | null;
  assessedByEmail: string | null;
  assessedAt: string | null;
};

type MovementForGst = {
  id: string;
  movement_date: string;
  movement_type: string;
  rations_for: string | null;
  kind: LivestockKind;
  class_code: string;
  head: number;
  amount: string | null;
  amount_includes_gst: boolean | null;
  rations_recipient: string | null;
  journal_id: string | null;
  voided: boolean;
};

type AssessmentRow = { id: string; outcome: RationsGstOutcome; gst_amount: string | null; journal_id: string | null; basis: string; assessed_by_email: string | null; assessed_at: string };

/** The standard-rated (15%) tax code a taxable supply's GST return line uses, preferring GST. */
async function standardSalesCode(tx: OrgTx): Promise<string> {
  const code = await tx.query<{ id: string }>(
    "select id::text from tax_codes where category = 'standard' and rate = 0.15 and is_active order by (code = 'GST') desc, id limit 1",
  );
  if (!code.rows[0]) throw new ValidationError("There's no active 15% GST tax code to count the supply under. Add one under Settings › Tax codes.");
  return code.rows[0].id;
}

async function gstAccountCode(tx: OrgTx): Promise<string> {
  const account = await tx.query<{ code: string }>("select code from accounts where system_key = 'gst'");
  if (!account.rows[0]) throw new ValidationError("The GST account isn't set up, so the rations GST can't be posted.");
  return account.rows[0].code;
}

/** The journal lines for a rations posting (RAT1, RAT5-RAT8): never a debit to GST (no input tax claim) and no bank line. */
export async function rationsJournalLines(
  tx: OrgTx,
  accounts: { drawings: string; income: string },
  posting: RationsPosting,
): Promise<Array<{ accountCode: string; debitAmount: string; creditAmount: string }>> {
  const lines = [
    { accountCode: accounts.drawings, debitAmount: posting.drawings, creditAmount: "0" },
    { accountCode: accounts.income, debitAmount: "0", creditAmount: posting.income },
  ];
  if (isPositive(dec(posting.gst))) lines.push({ accountCode: await gstAccountCode(tx), debitAmount: "0", creditAmount: posting.gst });
  return lines;
}

/** Whether the organisation was GST-registered on the event's date. */
export async function registeredOn(tx: OrgTx, date: string): Promise<boolean> {
  return isRegisteredOn(await getGstRegistration(tx), date);
}

/** Checks and works out a new assessment's amounts, without saving it. */
export async function parseAssessment(
  tx: OrgTx,
  input: { outcome: unknown; basis: unknown; gstAmount?: unknown },
  value: string,
  includesGst: boolean,
): Promise<{ outcome: RationsGstOutcome; basis: string; netAmount: string | null; gstAmount: string | null; taxCodeId: string | null; posting: RationsPosting }> {
  const outcome = requireOneOf(input.outcome, "The GST assessment", RATIONS_GST_OUTCOMES);
  const basis = requireString(input.basis, outcome === "no_adjustment" ? "The evidence for no adjustment" : "The basis", { maxLength: 500 });
  const given = input.gstAmount !== undefined && input.gstAmount !== null && input.gstAmount !== "";
  if (outcome === "change_in_use") {
    if (!given) throw new ValidationError("Enter the reviewed GST adjustment for the change in use.");
    const reviewed = dec(parseDecimalInput(input.gstAmount, "The GST adjustment", { maxScale: 2 }));
    const posting = rationsPosting({ value: dec(value), includesGst, status: outcome, reviewedGst: reviewed });
    return { outcome, basis, netAmount: posting.income, gstAmount: posting.gst, taxCodeId: null, posting };
  }
  if (given) throw new ValidationError(outcome === "taxable_supply" ? "A taxable supply's GST is worked out from its value; don't type it." : "No adjustment has no GST amount.");
  if (outcome === "taxable_supply") {
    const posting = rationsPosting({ value: dec(value), includesGst, status: outcome });
    return { outcome, basis, netAmount: posting.income, gstAmount: posting.gst, taxCodeId: await standardSalesCode(tx), posting };
  }
  return { outcome, basis, netAmount: null, gstAmount: null, taxCodeId: null, posting: rationsPosting({ value: dec(value), includesGst, status: outcome }) };
}

/** Saves an assessment that's already posted (or needs no journal of its own). */
export async function insertAssessment(
  tx: OrgTx,
  movementId: string,
  parsed: { outcome: RationsGstOutcome; basis: string; netAmount: string | null; gstAmount: string | null; taxCodeId: string | null },
  journalId: string | null,
): Promise<string> {
  const row = await tx.query<{ id: string }>(
    `insert into livestock_rations_gst (movement_id, outcome, basis, net_amount, gst_amount, tax_code_id, journal_id, assessed_by_email)
     values ($1, $2, $3, $4::numeric, $5::numeric, $6, $7, $8) returning id::text`,
    [movementId, parsed.outcome, parsed.basis, parsed.netAmount, parsed.gstAmount, parsed.taxCodeId, journalId, tx.actor.email],
  );
  return row.rows[0].id;
}

async function movementForGst(tx: OrgTx, movementId: string): Promise<MovementForGst> {
  const row = await tx.query<MovementForGst>(
    `select id::text, movement_date::text, movement_type, rations_for, kind, class_code, head, amount::text, amount_includes_gst, rations_recipient,
            journal_id::text, voided_at is not null as voided
       from livestock_movements where id = $1 for update`,
    [movementId],
  );
  if (!row.rows[0]) throw new NotFoundError("Livestock movement not found.");
  return row.rows[0];
}

async function currentAssessment(tx: OrgTx, movementId: string): Promise<AssessmentRow | null> {
  const row = await tx.query<AssessmentRow>(
    `select id::text, outcome, gst_amount::text, journal_id::text, basis, assessed_by_email, assessed_at::text
       from livestock_rations_gst where movement_id = $1 and replaced_at is null for update`,
    [movementId],
  );
  return row.rows[0] ?? null;
}

/** The journal that holds the rations event's posting now: the latest assessment's, or the event's own. */
export async function currentPostingJournal(tx: OrgTx, movementId: string, ownJournalId: string | null): Promise<string | null> {
  const row = await tx.query<{ journal_id: string }>(
    "select journal_id::text from livestock_rations_gst where movement_id = $1 and journal_id is not null order by id desc limit 1",
    [movementId],
  );
  return row.rows[0]?.journal_id ?? ownJournalId;
}

/** Reverses a rations journal on the event's date (RAT3, RAT8). */
export async function reverseRationsJournal(tx: OrgTx, movementId: string, journalId: string, date: string, description: string, source: string, key: string): Promise<string> {
  const original = await tx.query<{ account_code: string; debit: string; credit: string }>(
    `select a.code as account_code, l.debit_amount::text as debit, l.credit_amount::text as credit
       from ledger_journal_lines l join accounts a on a.id = l.account_id where l.journal_id = $1 order by l.id`,
    [journalId],
  );
  const reversal = await postJournalBody(
    tx,
    source,
    key,
    parseJournalBody(tx, {
      postingDate: date,
      reference: `RATIONS-${movementId}`,
      description,
      lines: original.rows.map((line) => ({ accountCode: line.account_code, debitAmount: line.credit, creditAmount: line.debit })),
    }),
    { origin: "livestock_rations", relatedJournalId: journalId, correctionKind: "reversal" },
  );
  return reversal.journal.id;
}

function postingFor(movement: MovementForGst, current: AssessmentRow | null, registered: boolean): RationsPosting {
  const status: RationsGstStatus = !registered ? "not_registered" : current ? current.outcome : "unresolved";
  return rationsPosting({ value: dec(movement.amount!), includesGst: movement.amount_includes_gst === true, status, reviewedGst: current?.gst_amount ? dec(current.gst_amount) : null });
}

/**
 * Assesses (or assesses again) an owner's rations event for GST (RAT5-RAT9).
 * Changing an existing assessment needs a reason. When the amounts change,
 * the rations journal is reversed and posted again on the event's date.
 */
export async function assessRationsGst(
  tx: OrgTx,
  input: { movementId: string; outcome: unknown; basis: unknown; gstAmount?: unknown; reason?: unknown },
  accounts: { drawings: string; income: string },
): Promise<RationsGst> {
  const movement = await movementForGst(tx, input.movementId);
  if (movement.movement_type !== "rations" || movement.rations_for !== "owner") {
    throw new ValidationError("Only the owner's rations are assessed for GST. Staff rations need their own analysis.");
  }
  if (movement.voided) throw new ConflictError("That rations event is voided.");
  if (!(await registeredOn(tx, movement.movement_date))) {
    throw new ValidationError(`This organisation wasn't GST-registered on ${movement.movement_date}, so there's no GST to assess.`);
  }
  const current = await currentAssessment(tx, movement.id);
  const reason = input.reason === undefined || input.reason === null || input.reason === "" ? null : requireString(input.reason, "The reason", { maxLength: 500 });
  if (current && !reason) throw new ValidationError("Say why the GST assessment is changing.");
  const parsed = await parseAssessment(tx, input, movement.amount!, movement.amount_includes_gst === true);
  const before = postingFor(movement, current, true);
  let journalId: string | null = null;
  const same = before.drawings === parsed.posting.drawings && before.income === parsed.posting.income && before.gst === parsed.posting.gst;
  if (!same) {
    const posted = await currentPostingJournal(tx, movement.id, movement.journal_id);
    const count = await tx.query<{ n: number }>("select count(*)::integer as n from livestock_rations_gst where movement_id = $1", [movement.id]);
    const step = `${movement.id}:${count.rows[0].n + 1}`;
    if (posted) await reverseRationsJournal(tx, movement.id, posted, movement.movement_date, "GST assessed: replaced by the next journal", "livestock_rations:gst-reverse", step);
    const definition = className(movement.kind, movement.class_code).toLowerCase();
    const journal = await postJournalBody(
      tx,
      "livestock_rations:gst",
      step,
      parseJournalBody(tx, {
        postingDate: movement.movement_date,
        reference: `RATIONS-${movement.id}`,
        description: `${movement.head} ${definition} killed for the owner's rations, at market value (${parsed.outcome === "taxable_supply" ? "taxable supply" : parsed.outcome === "change_in_use" ? "change-in-use GST adjustment" : "no GST adjustment"})`,
        lines: await rationsJournalLines(tx, accounts, parsed.posting),
      }),
      { origin: "livestock_rations" },
    );
    journalId = journal.journal.id;
  }
  if (current) {
    await tx.query("update livestock_rations_gst set replaced_at = now(), replaced_by_email = $2, replaced_reason = $3 where id = $1", [current.id, tx.actor.email, reason]);
  }
  const id = await insertAssessment(tx, movement.id, parsed, journalId);
  await writeAuditEvent(tx, {
    eventType: "livestock.rations_gst_assessed",
    entityType: "livestock_movement",
    entityId: movement.id,
    details: { assessmentId: id, outcome: parsed.outcome, gstAmount: parsed.gstAmount, basis: parsed.basis, reason, replaced: current ? { id: current.id, outcome: current.outcome, gstAmount: current.gst_amount } : null, journalId },
  });
  return { status: parsed.outcome, assessmentId: id, gstAmount: parsed.gstAmount, basis: parsed.basis, assessedByEmail: tx.actor.email, assessedAt: new Date().toISOString() };
}

// --- The GST return ---------------------------------------------------------------

export type RationsGstEvent = {
  movementId: string;
  date: string;
  head: number;
  className: string;
  recipient: string | null;
  value: string;
  includesGst: boolean;
  /** Dated in this return's period (otherwise earlier, still outstanding). */
  inPeriod: boolean;
  basis: string | null;
};

export type RationsForGstReturn = {
  /** Box 9 adjustments: change-in-use adjustments not in a filed return yet, and ones to take back off (RAT7, RAT9). */
  adjustments: GstAdjustment[];
  include: string[];
  reverse: string[];
  /** Owner's rations on GST-registered dates with no assessment yet, up to the period's end (RAT10). */
  unresolved: RationsGstEvent[];
  /** Assessed as no adjustment, in the period, with the evidence. */
  noAdjustment: RationsGstEvent[];
};

type EventRow = { movement_id: string; movement_date: string; head: number; kind: LivestockKind; class_code: string; rations_recipient: string | null; amount: string; amount_includes_gst: boolean | null; basis: string | null };

const money = (value: string) => toFixedString(dec(value), 2);

function toEvent(row: EventRow, periodStart: string): RationsGstEvent {
  return {
    movementId: row.movement_id,
    date: row.movement_date,
    head: row.head,
    className: className(row.kind, row.class_code),
    recipient: row.rations_recipient,
    value: money(row.amount),
    includesGst: row.amount_includes_gst === true,
    inPeriod: row.movement_date >= periodStart,
    basis: row.basis,
  };
}

/** What the owner's rations add to a GST return for this period, and what's still unresolved (RAT7, RAT9, RAT10). */
export async function rationsForGstReturn(tx: OrgTx, periodStart: string, periodEnd: string): Promise<RationsForGstReturn> {
  const registration = await getGstRegistration(tx);
  const describe = (row: { movement_date: string; head: number; kind: LivestockKind; class_code: string; movement_id: string }) =>
    `Livestock rations change in use: ${row.head} ${className(row.kind, row.class_code).toLowerCase()}, ${row.movement_date} (RATIONS-${row.movement_id})`;
  type AdjustmentRow = { id: string; movement_id: string; movement_date: string; head: number; kind: LivestockKind; class_code: string; gst_amount: string };
  // In this period, or dated in a period whose return was filed before it was assessed (caught up here, not changed there).
  const include = await tx.query<AdjustmentRow>(
    `select g.id::text, m.id::text as movement_id, m.movement_date::text, m.head, m.kind, m.class_code, g.gst_amount::text
       from livestock_rations_gst g join livestock_movements m on m.id = g.movement_id
      where g.outcome = 'change_in_use' and g.replaced_at is null and m.voided_at is null and g.included_in_gst_return_id is null
        and (m.movement_date between $1 and $2
             or (m.movement_date < $1 and exists (select 1 from gst_returns r where m.movement_date between r.period_start and r.period_end)))
      order by m.movement_date, g.id`,
    [periodStart, periodEnd],
  );
  // In an earlier filed return, then replaced or voided: taken back off once.
  const reverse = await tx.query<AdjustmentRow>(
    `select g.id::text, m.id::text as movement_id, m.movement_date::text, m.head, m.kind, m.class_code, g.gst_amount::text
       from livestock_rations_gst g join livestock_movements m on m.id = g.movement_id join gst_returns r on r.id = g.included_in_gst_return_id
      where g.reversal_in_gst_return_id is null and (g.replaced_at is not null or m.voided_at is not null) and r.period_end < $1
      order by m.movement_date, g.id`,
    [periodStart],
  );
  const adjustments: GstAdjustment[] = [
    ...include.rows.map((row) => ({ box: "9" as const, description: `${describe(row)}${row.movement_date < periodStart ? ", from an earlier filed period" : ""}`, amount: money(row.gst_amount) })),
    ...reverse.rows.map((row) => ({ box: "9" as const, description: `Taken back off (changed after filing): ${describe(row)}`, amount: money(`-${row.gst_amount}`) })),
  ];
  const unresolved = await tx.query<EventRow>(
    `select m.id::text as movement_id, m.movement_date::text, m.head, m.kind, m.class_code, m.rations_recipient, m.amount::text, m.amount_includes_gst, null as basis
       from livestock_movements m
      where m.movement_type = 'rations' and m.rations_for = 'owner' and m.voided_at is null and m.movement_date <= $1
        and not exists (select 1 from livestock_rations_gst g where g.movement_id = m.id and g.replaced_at is null)
      order by m.movement_date, m.id`,
    [periodEnd],
  );
  const noAdjustment = await tx.query<EventRow>(
    `select m.id::text as movement_id, m.movement_date::text, m.head, m.kind, m.class_code, m.rations_recipient, m.amount::text, m.amount_includes_gst, g.basis
       from livestock_rations_gst g join livestock_movements m on m.id = g.movement_id
      where g.outcome = 'no_adjustment' and g.replaced_at is null and m.voided_at is null and m.movement_date between $1 and $2
      order by m.movement_date, m.id`,
    [periodStart, periodEnd],
  );
  return {
    adjustments,
    include: include.rows.map((row) => row.id),
    reverse: reverse.rows.map((row) => row.id),
    unresolved: unresolved.rows.filter((row) => isRegisteredOn(registration, row.movement_date)).map((row) => toEvent(row, periodStart)),
    noAdjustment: noAdjustment.rows.map((row) => toEvent(row, periodStart)),
  };
}

/** Marks the change-in-use adjustments a filed return included or took back off, so no later return repeats them. */
export async function markRationsAdjustmentsFiled(tx: OrgTx, gstReturnId: string, rations: Pick<RationsForGstReturn, "include" | "reverse">): Promise<void> {
  if (rations.include.length > 0) {
    await tx.query("update livestock_rations_gst set included_in_gst_return_id = $1 where id = any($2::bigint[]) and included_in_gst_return_id is null", [gstReturnId, rations.include]);
  }
  if (rations.reverse.length > 0) {
    await tx.query("update livestock_rations_gst set reversal_in_gst_return_id = $1 where id = any($2::bigint[]) and reversal_in_gst_return_id is null", [gstReturnId, rations.reverse]);
  }
}

/** The GST at a supply's value, for showing before it's assessed. */
export function previewSupplyGst(value: string, includesGst: boolean): string {
  return toFixedString(supplyGst(dec(value), includesGst).gst, 2);
}

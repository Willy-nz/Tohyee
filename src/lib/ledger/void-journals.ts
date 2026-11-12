import type { OrgTx } from "@/lib/db/org-transaction";
import { writeAuditEvent } from "@/lib/audit";
import { ConflictError, ValidationError } from "@/lib/errors";
import { requestHash } from "@/lib/idempotency";
import { getJournal, type JournalWithLines, parseJournalBody, postJournalBody, sameForeign } from "@/lib/ledger/journals";
import { getPeriodControls } from "@/lib/ledger/period-controls";
import { add, dec, type Decimal, isNegative, isZero, neg, sub, toFixedString } from "@/lib/money/decimal";
import { optionalString, requireArray, requireId, requireIdempotencyKey } from "@/lib/validation";
import { parseIsoDate } from "@/lib/dates";

/**
 * Void for posted manual journals (VJ1-VJ5, decision 1585, Jess's issue 9):
 * cancels one that shouldn't exist, with no replacement. Posts only the
 * exact reversal (as a correction's), linked to the original, dated the
 * original's day unless another is chosen, with who and why; nothing is
 * deleted. A manual journal or a correction's replacement only; refused in a
 * locked period, when a line is reconciled with a bank statement line, and
 * when it's already been voided or corrected. Several at once, after a
 * preview of the effect by account.
 */

export const MAX_VOID_JOURNALS = 100;

export type VoidJournalItem = { journalId: string; postingDate: string; reference: string; total: string; blocked: string | null };
export type VoidJournalsPlan = {
  items: VoidJournalItem[];
  /** What the voids do to each account: the reversal of the journals' net amounts. */
  effect: Array<{ accountCode: string; accountName: string; debit: string; credit: string }>;
  voidDate: string | null;
  hash: string;
};

async function blocked(tx: OrgTx, journal: JournalWithLines, date: string, lock: string | null): Promise<string | null> {
  const voidable = journal.origin === "manual" ? journal.correctionKind === null : journal.origin === "correction" && journal.correctionKind === "replacement";
  if (!voidable) return "Only manual journals can be voided here: void or undo the record that posted it.";
  const reversed = await tx.query("select 1 from ledger_journals where related_journal_id = $1 and correction_kind = 'reversal'", [journal.id]);
  if (reversed.rowCount !== 0) return "It's already been voided or corrected.";
  if (lock && date <= lock) return `${date} is in a locked period (locked to ${lock}).`;
  const reconciled = await tx.query(
    "select 1 from bank_reconciliation_items i join ledger_journal_lines l on l.id = i.journal_line_id where i.active and l.journal_id = $1 limit 1",
    [journal.id],
  );
  if (reconciled.rowCount !== 0) return "It's reconciled with a bank statement line: unreconcile that first.";
  return null;
}

/** The preview (VJ2): each journal, whether it can be voided, and the effect by account. Changes nothing. */
export async function planVoidJournals(tx: OrgTx, input: { journalIds: unknown; voidDate?: unknown }): Promise<VoidJournalsPlan> {
  const ids = [...new Set(requireArray(input.journalIds, "journalIds", MAX_VOID_JOURNALS).map((id, index) => requireId(id, `journalIds[${index}]`)))];
  if (ids.length === 0) throw new ValidationError("Choose at least one journal.");
  const voidDate = input.voidDate == null || input.voidDate === "" ? null : parseIsoDate(input.voidDate, "The void date");
  const lock = (await getPeriodControls(tx)).lockDate;
  const items: VoidJournalItem[] = [];
  const byAccount = new Map<string, { name: string; net: Decimal }>();
  for (const id of ids) {
    const journal = await getJournal(tx, id);
    const why = await blocked(tx, journal, voidDate ?? journal.postingDate, lock);
    items.push({ journalId: journal.id, postingDate: journal.postingDate, reference: journal.reference, total: journal.totalDebit, blocked: why });
    if (why) continue;
    for (const line of journal.lines) {
      const was = byAccount.get(line.accountCode) ?? { name: line.accountName, net: dec("0") };
      // The void reverses the line: a debit becomes a credit.
      byAccount.set(line.accountCode, { name: was.name, net: add(was.net, sub(dec(line.creditAmount), dec(line.debitAmount))) });
    }
  }
  const effect = [...byAccount.entries()]
    .filter(([, entry]) => !isZero(entry.net))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([accountCode, entry]) => {
      const positive = !isNegative(entry.net);
      return { accountCode, accountName: entry.name, debit: positive ? toFixedString(entry.net, 2) : "0.00", credit: positive ? "0.00" : toFixedString(neg(entry.net), 2) };
    });
  return { items, effect, voidDate, hash: requestHash("void-journals", { items: items.map((item) => [item.journalId, item.total, item.blocked]), voidDate }) };
}

/** Voids them (VJ3), all or none: needs the preview's hash. A retry with the same key does nothing more. */
export async function voidJournals(
  tx: OrgTx,
  input: { journalIds: unknown; voidDate?: unknown; reason?: unknown; previewHash: unknown; idempotencyKey: unknown; source?: string },
): Promise<{ created: boolean; voided: Array<{ journalId: string; reversalJournalId: string }> }> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const reason = optionalString(input.reason, "reason", { maxLength: 300 });
  const commandSource = `void:${input.source ?? "ui"}`;
  const earlier = await tx.query<{ id: string; related_journal_id: string }>(
    "select ledger_journals.id::text as id, related_journal_id::text as related_journal_id from ledger_journals where command_source = $1 and idempotency_key like $2 order by ledger_journals.id",
    [commandSource, `${key}:%`],
  );
  if (earlier.rows.length > 0) return { created: false, voided: earlier.rows.map((row) => ({ journalId: row.related_journal_id, reversalJournalId: row.id })) };
  const ids = requireArray(input.journalIds, "journalIds", MAX_VOID_JOURNALS).map((id, index) => requireId(id, `journalIds[${index}]`));
  // Advisory locks, not FOR UPDATE: the runtime login has no UPDATE on posted journals.
  for (const id of [...ids].sort((a, b) => Number(a) - Number(b))) await tx.query("select pg_advisory_xact_lock(hashtext('ledger_journal_void:' || $1))", [id]);
  const plan = await planVoidJournals(tx, { journalIds: ids, voidDate: input.voidDate });
  if (input.previewHash !== plan.hash) throw new ConflictError("Something has changed since the preview. Preview it again.");
  const stuck = plan.items.filter((item) => item.blocked);
  if (stuck.length > 0) throw new ConflictError(`Journal #${stuck[0].journalId} can't be voided: ${stuck[0].blocked}`);
  const voided: Array<{ journalId: string; reversalJournalId: string }> = [];
  for (const item of plan.items) {
    const journal = await getJournal(tx, item.journalId);
    const body = parseJournalBody(
      tx,
      {
        postingDate: plan.voidDate ?? journal.postingDate,
        reference: `VOID-${journal.reference}`.slice(0, 100),
        description: `Void of journal #${journal.id}${reason ? `: ${reason}` : ""}`.slice(0, 500),
        currencyCode: journal.currencyCode,
        lines: journal.lines.map((line) => ({
          accountCode: line.accountCode,
          debitAmount: line.creditAmount,
          creditAmount: line.debitAmount,
          description: line.description,
          tracking: line.tracking,
          ...sameForeign(line),
        })),
      },
      { internal: true },
    );
    const reversal = await postJournalBody(tx, commandSource, `${key}:${journal.id}`, body, { origin: "correction", relatedJournalId: journal.id, correctionKind: "reversal" });
    voided.push({ journalId: journal.id, reversalJournalId: reversal.journal.id });
    await writeAuditEvent(tx, {
      eventType: "ledger.journal_voided",
      entityType: "ledger_journal",
      entityId: journal.id,
      details: { reversalJournalId: reversal.journal.id, postingDate: body.postingDate, ...(reason ? { reason } : {}) },
    });
  }
  return { created: true, voided };
}

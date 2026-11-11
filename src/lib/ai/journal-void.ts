import type { OrgTx } from "@/lib/db/org-transaction";
import { writeAuditEvent } from "@/lib/audit";
import { ConflictError, ValidationError } from "@/lib/errors";
import { requestHash } from "@/lib/idempotency";
import { getJournal, type JournalWithLines, parseJournalBody, postJournalBody, sameForeign } from "@/lib/ledger/journals";
import { getPeriodControls } from "@/lib/ledger/period-controls";
import { requireId } from "@/lib/validation";

/**
 * The AI voiding its own manual journals (AJV1-AJV6, decision 1581, Jess
 * 11 Nov 2026). Only a manual journal posted from a draft by the same AI key
 * or app (the draft records which), never one a person posted or anything an
 * invoice, bill, payment or other record made. A preview first; then, with
 * its hash, an exact reversal dated the original's day, so the original is
 * kept and shows as voided by the AI. Refused in a locked period, when a
 * line is reconciled with a bank statement line, when it's already been
 * reversed, and (if the organisation set one) after the time limit.
 */

export type AiJournalVoidSettings = { maxDays: number | null };

export async function getAiJournalVoidSettings(tx: OrgTx): Promise<AiJournalVoidSettings> {
  const row = await tx.query<{ max_days: number | null }>("select max_days from ai_journal_void_settings where id = true");
  return { maxDays: row.rows[0]?.max_days ?? null };
}

/** Admins and owners set how many days after posting the AI may void (null: no limit), AJV5. */
export async function saveAiJournalVoidSettings(tx: OrgTx, input: { maxDays: unknown }): Promise<AiJournalVoidSettings> {
  const raw = input.maxDays;
  let maxDays: number | null = null;
  if (raw !== null && raw !== undefined && raw !== "") {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 3650) throw new ValidationError("The limit is a whole number of days from 1 to 3650, or blank for none.");
    maxDays = raw;
  }
  await tx.query(
    `insert into ai_journal_void_settings (id, max_days, updated_by_email) values (true, $1, $2)
     on conflict (id) do update set max_days = excluded.max_days, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [maxDays, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "ai.journal_void_limit_set", entityType: "organisation", entityId: tx.organisationId, details: { maxDays } });
  return { maxDays };
}

export type AiJournalVoidPreview = {
  journalId: string;
  postingDate: string;
  reference: string;
  description: string | null;
  total: string;
  lines: Array<{ accountCode: string; accountName: string; debit: string; credit: string; description: string | null }>;
  previewHash: string;
};

/** Why the AI can't void this journal, or null when it can (AJV1-AJV5). */
async function refusal(tx: OrgTx, journal: JournalWithLines, now: Date): Promise<string | null> {
  const person = "A person can correct it in Tohyee.";
  if (journal.origin !== "manual" || journal.correctionKind !== null) {
    return `Journal #${journal.id} isn't a manual journal, so the AI can't void it. ${person}`;
  }
  const via = tx.actor.via;
  const draft = await tx.query<{ posted_via: string | null }>("select posted_via from ledger_journal_drafts where posted_journal_id = $1", [journal.id]);
  if (!via || !draft.rows[0] || draft.rows[0].posted_via !== via) {
    return `Journal #${journal.id} wasn't posted by this AI, so it can't void it. ${person}`;
  }
  const reversed = await tx.query("select 1 from ledger_journals where related_journal_id = $1 and correction_kind = 'reversal'", [journal.id]);
  if (reversed.rowCount !== 0) return `Journal #${journal.id} has already been voided or corrected.`;
  const lock = (await getPeriodControls(tx)).lockDate;
  if (lock && journal.postingDate <= lock) return `Journal #${journal.id} is dated ${journal.postingDate}, in a locked period (locked to ${lock}). ${person}`;
  const reconciled = await tx.query(
    "select 1 from bank_reconciliation_items i join ledger_journal_lines l on l.id = i.journal_line_id where i.active and l.journal_id = $1 limit 1",
    [journal.id],
  );
  if (reconciled.rowCount !== 0) return `Journal #${journal.id} is matched to a bank statement line, so the AI can't void it. ${person}`;
  const { maxDays } = await getAiJournalVoidSettings(tx);
  if (maxDays !== null) {
    const old = await tx.query("select 1 from ledger_journals where id = $1 and created_at < $3::timestamptz - make_interval(days => $2)", [journal.id, maxDays, now.toISOString()]);
    if (old.rowCount !== 0) return `Journal #${journal.id} was posted more than ${maxDays} days ago, past this organisation's limit for the AI. ${person}`;
  }
  return null;
}

function previewOf(journal: JournalWithLines): AiJournalVoidPreview {
  const lines = journal.lines.map((line) => ({
    accountCode: line.accountCode,
    accountName: line.accountName,
    debit: line.debitAmount,
    credit: line.creditAmount,
    description: line.description ?? null,
  }));
  return {
    journalId: journal.id,
    postingDate: journal.postingDate,
    reference: journal.reference,
    description: journal.description ?? null,
    total: journal.totalDebit,
    lines,
    previewHash: requestHash("ai-journal-void", { journalId: journal.id, postingDate: journal.postingDate, lines }),
  };
}

/** What voiding would reverse (AJV2); refused as above. Changes nothing. */
export async function previewAiJournalVoid(tx: OrgTx, journalIdInput: unknown, now = new Date()): Promise<AiJournalVoidPreview> {
  const journal = await getJournal(tx, requireId(journalIdInput, "journalId"));
  const why = await refusal(tx, journal, now);
  if (why) throw new ConflictError(why);
  return previewOf(journal);
}

/** Voids it (AJV3): an exact reversal on the original's date. Needs the preview's hash; a retry with the same key returns the same reversal. */
export async function aiVoidJournal(
  tx: OrgTx,
  input: { journalId: unknown; previewHash: unknown; idempotencyKey: string; source: string },
): Promise<{ created: boolean; journalId: string; reversalJournalId: string }> {
  const journalId = requireId(input.journalId, "journalId");
  await tx.query("select id from ledger_journals where id = $1 for update", [journalId]);
  const journal = await getJournal(tx, journalId);
  const commandSource = `ai-void:${input.source}`;
  const earlier = await tx.query<{ id: string }>("select id from ledger_journals where command_source = $1 and idempotency_key = $2", [commandSource, input.idempotencyKey]);
  if (earlier.rows[0]) return { created: false, journalId, reversalJournalId: earlier.rows[0].id };
  const why = await refusal(tx, journal, new Date());
  if (why) throw new ConflictError(why);
  if (input.previewHash !== previewOf(journal).previewHash) throw new ConflictError("The journal has changed since the preview. Preview it again.");
  const body = parseJournalBody(
    tx,
    {
      postingDate: journal.postingDate,
      reference: `VOID-${journal.reference}`.slice(0, 100),
      description: `Voided by the AI (${tx.actor.via}): journal #${journal.id}`,
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
  const reversal = await postJournalBody(tx, commandSource, input.idempotencyKey, body, { origin: "correction", relatedJournalId: journal.id, correctionKind: "reversal" });
  await writeAuditEvent(tx, {
    eventType: "ledger.journal_voided_by_ai",
    entityType: "ledger_journal",
    entityId: journal.id,
    details: { reversalJournalId: reversal.journal.id, postingDate: journal.postingDate },
  });
  return { created: reversal.created, journalId, reversalJournalId: reversal.journal.id };
}

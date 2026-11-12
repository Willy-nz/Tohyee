import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError } from "@/lib/errors";
import { requestHash } from "@/lib/idempotency";
import { isAiVia } from "@/lib/ai/journal-void";
import { correctJournal, getJournal, type JournalWithLines, parseJournalBody } from "@/lib/ledger/journals";
import { getPeriodControls } from "@/lib/ledger/period-controls";
import { add, dec, isZero, sub, toFixedString } from "@/lib/money/decimal";
import { requireId } from "@/lib/validation";

/**
 * The AI correcting a manual journal (AJC1-AJC5; Will, 12 Nov 2026; decision
 * 1598): what Edit this journal does on the Journals page, through an AI
 * connection. A manual journal, or a correction's replacement, whoever posted
 * it; never an invoice's, a bill's, a payment's or anything else a record
 * made (those are corrected at their source). A preview first: the original,
 * the new version and the effect by account. Then, with its hash, a reversal
 * and the new version, both on the original's date unless another is given,
 * like a person's correction. Refused in a locked period, when a line is
 * matched to a bank statement line, and when it's already been voided or
 * corrected.
 */

type PreviewLine = { accountCode: string; accountName: string | null; debit: string; credit: string; description: string | null };

export type AiJournalCorrectionPreview = {
  journalId: string;
  postingDate: string;
  reference: string;
  description: string | null;
  original: PreviewLine[];
  replacement: PreviewLine[];
  effect: Array<{ accountCode: string; amount: string }>;
  previewHash: string;
};

type CorrectionInput = {
  journalId: unknown;
  postingDate?: unknown;
  reference?: unknown;
  description?: unknown;
  lines: unknown;
};

async function refusal(tx: OrgTx, journal: JournalWithLines, postingDate: string): Promise<string | null> {
  const person = "A person can correct it in Tohyee.";
  if (!isAiVia(tx.actor.via)) return "Only an AI connection corrects journals this way.";
  const manual = journal.origin === "manual" && journal.correctionKind === null;
  const replacement = journal.origin === "correction" && journal.correctionKind === "replacement";
  if (!manual && !replacement) {
    return `Journal #${journal.id} isn't a manual journal or a correction's replacement, so it's corrected at its source, not here.`;
  }
  const reversed = await tx.query("select 1 from ledger_journals where related_journal_id = $1 and correction_kind = 'reversal'", [journal.id]);
  if (reversed.rowCount !== 0) return `Journal #${journal.id} has already been voided or corrected. Correct its replacement instead.`;
  const lock = (await getPeriodControls(tx)).lockDate;
  if (lock && journal.postingDate <= lock) return `Journal #${journal.id} is dated ${journal.postingDate}, in a locked period (locked to ${lock}). ${person}`;
  if (lock && postingDate <= lock) return `${postingDate} is in a locked period (locked to ${lock}). Choose a later date.`;
  const reconciled = await tx.query(
    "select 1 from bank_reconciliation_items i join ledger_journal_lines l on l.id = i.journal_line_id where i.active and l.journal_id = $1 limit 1",
    [journal.id],
  );
  if (reconciled.rowCount !== 0) return `Journal #${journal.id} is matched to a bank statement line, so the AI can't correct it. ${person}`;
  return null;
}

async function accountNames(tx: OrgTx, codes: string[]): Promise<Map<string, string>> {
  const rows = await tx.query<{ code: string; name: string }>("select code, name from accounts where code = any($1::text[])", [codes]);
  return new Map(rows.rows.map((row) => [row.code, row.name]));
}

async function build(tx: OrgTx, input: CorrectionInput) {
  const journal = await getJournal(tx, requireId(input.journalId, "journalId"));
  const postingDate = input.postingDate == null || input.postingDate === "" ? journal.postingDate : input.postingDate;
  const reference = input.reference == null || input.reference === "" ? journal.reference : input.reference;
  const description = input.description === undefined ? journal.description : input.description;
  // Checks the new version as a manual journal would be checked (balanced, accounts that take journals).
  const body = parseJournalBody(tx, { postingDate, reference, description, currencyCode: journal.currencyCode, lines: input.lines });
  const why = await refusal(tx, journal, body.postingDate);
  if (why) throw new ConflictError(why);

  const original: PreviewLine[] = journal.lines.map((line) => ({
    accountCode: line.accountCode,
    accountName: line.accountName,
    debit: line.debitAmount,
    credit: line.creditAmount,
    description: line.description ?? null,
  }));
  const names = await accountNames(tx, body.lines.map((line) => line.accountCode));
  const replacement: PreviewLine[] = body.lines.map((line) => ({
    accountCode: line.accountCode,
    accountName: names.get(line.accountCode) ?? null,
    debit: line.debit,
    credit: line.credit,
    description: line.description,
  }));

  const net = new Map<string, ReturnType<typeof dec>>();
  const move = (code: string, amount: ReturnType<typeof dec>) => net.set(code, add(net.get(code) ?? dec("0"), amount));
  for (const line of original) move(line.accountCode, sub(dec(line.credit), dec(line.debit)));
  for (const line of replacement) move(line.accountCode, sub(dec(line.debit), dec(line.credit)));
  const effect = [...net.entries()]
    .filter(([, amount]) => !isZero(amount))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([accountCode, amount]) => ({ accountCode, amount: toFixedString(amount, 2) }));

  const previewHash = requestHash("ai-journal-correct", {
    journalId: journal.id,
    original,
    postingDate: body.postingDate,
    reference: body.reference,
    description: body.description,
    replacement,
  });
  return { journal, body, original, replacement, effect, previewHash };
}

/** What the correction would post (AJC2); refused as above. Changes nothing. */
export async function previewAiJournalCorrection(tx: OrgTx, input: CorrectionInput): Promise<AiJournalCorrectionPreview> {
  const built = await build(tx, input);
  return {
    journalId: built.journal.id,
    postingDate: built.body.postingDate,
    reference: built.body.reference,
    description: built.body.description,
    original: built.original,
    replacement: built.replacement,
    effect: built.effect,
    previewHash: built.previewHash,
  };
}

/** Corrects it (AJC3): a reversal and the new version, as Edit this journal does. Needs the preview's hash; a retry with the same key posts nothing more. */
export async function aiCorrectJournal(
  tx: OrgTx,
  input: CorrectionInput & { previewHash: unknown; idempotencyKey: string; source: string },
): Promise<{ created: boolean; journalId: string; reversalJournalId: string; replacementJournalId: string }> {
  const journalId = requireId(input.journalId, "journalId");
  // An advisory lock, not FOR UPDATE: the runtime login has no UPDATE on posted journals.
  await tx.query("select pg_advisory_xact_lock(hashtext('ledger_journal_void:' || $1))", [journalId]);
  const source = input.source; // "ai-<key id>", a valid correction source
  const earlier = await tx.query<{ id: string; correction_kind: string }>(
    "select id::text, correction_kind from ledger_journals where related_journal_id = $1 and command_source = $2 and idempotency_key in ($3, $4)",
    [journalId, `correction:${source}`, `${input.idempotencyKey}:reversal`, `${input.idempotencyKey}:replacement`],
  );
  if (earlier.rowCount === 2) {
    const byKind = new Map(earlier.rows.map((row) => [row.correction_kind, row.id]));
    return { created: false, journalId, reversalJournalId: byKind.get("reversal")!, replacementJournalId: byKind.get("replacement")! };
  }
  const built = await build(tx, input);
  if (input.previewHash !== built.previewHash) throw new ConflictError("The journal or the new version has changed since the preview. Preview it again.");
  const result = await correctJournal(tx, {
    source,
    idempotencyKey: input.idempotencyKey,
    originalJournalId: journalId,
    postingDate: built.body.postingDate,
    reference: built.body.reference,
    description: built.body.description,
    lines: input.lines,
  });
  return { created: result.created, journalId, reversalJournalId: result.reversalJournal.id, replacementJournalId: result.replacementJournal.id };
}

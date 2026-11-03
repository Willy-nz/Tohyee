import { assertAiGstTreatment } from "@/lib/ai/gst-evidence";
import { getStatementLine, type StatementLine } from "@/lib/bank/accounts";
import { lineErrorText } from "@/lib/bank/bulk";
import { approvalWork } from "@/lib/bank/coding-proposals";
import { reconcileStatementLine, suggestionsForLine, unreconcileStatementLine } from "@/lib/bank/reconcile";
import { type BankRule, getBankRule, ruleAmountsMode, ruleContact, ruleLinesFor, ruleMatches } from "@/lib/bank/rules";
import { voidBankTransaction, voidTransfer } from "@/lib/bank/transactions";
import {
  type ActionWork,
  type Batch,
  type BatchAction,
  createBatch,
  getBatch,
  type NewBatchAction,
  runBatch,
  type RunOptions,
  type RunOutcome,
} from "@/lib/batches/service";
import type { OrgRunner, OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ValidationError } from "@/lib/errors";
import { formatDate, formatMoney } from "@/lib/format";
import { requestHash } from "@/lib/idempotency";
import { getPeriodControls } from "@/lib/ledger/period-controls";
import { dec, neg, toFixedString } from "@/lib/money/decimal";
import { asRecord, requireArray, requireId, requireOneOf, requireString } from "@/lib/validation";

/**
 * Bank batches (#547, decisions 1273-1279), on the generic batches in
 * src/lib/batches/service.ts:
 *
 * - bank_reconcile: an AI's bulk_reconcile. Each action is the same command
 *   the reconcile screen sends (BK4-BK10), with the key `<batch key>:<line>`.
 * - bank_unreconcile: "Unreconcile selected" (a person on the Statement
 *   lines tab, or a Full access AI, decision 1277). Each line is
 *   unreconciled as BK11 does: nothing is posted or voided.
 * - bank_undo: a person undoing a bank_reconcile batch after reviewing what
 *   it will do: each line it reconciled is unreconciled and what it posted
 *   (spend or receive money, a transfer) is voided on the line's date, as
 *   unmatch_bank_line does for one line (AIB7). Payments stay.
 */

export const RECONCILE_ACTIONS = ["match", "create_and_match", "transfer_and_match", "apply_bank_rule"] as const;
export type ReconcileAction = (typeof RECONCILE_ACTIONS)[number];
/** At most this many actions or lines in one batch. */
export const MAX_BATCH_ACTIONS = 100;

/** Runs `work` in a savepoint, so a refused step rolls back on its own and the rest carries on. */
export async function inSavepoint<T>(tx: OrgTx, work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  await tx.query("savepoint bank_line_step");
  try {
    const value = await work();
    await tx.query("release savepoint bank_line_step");
    return { ok: true, value };
  } catch (error) {
    await tx.query("rollback to savepoint bank_line_step");
    return { ok: false, error: lineErrorText(error) };
  }
}

export type Reconciled = { created: boolean; line: StatementLine };

export async function matchLine(tx: OrgTx, args: Record<string, unknown>, source: string, key: string): Promise<Reconciled> {
  const hasMatches = args.journalLineIds != null;
  const hasAllocations = args.allocations != null;
  if (hasMatches === hasAllocations) {
    throw new ValidationError("Give either journalLineIds (things already posted) or allocations (invoices or bills to pay), not both.");
  }
  return reconcileStatementLine(tx, args.lineId, {
    source,
    idempotencyKey: key,
    ...(hasMatches ? { kind: "match", journalLineIds: args.journalLineIds } : { kind: "payments", allocations: args.allocations }),
    ...(args.exchangeRate != null ? { exchangeRate: args.exchangeRate } : {}),
  });
}

/** An AI's spend or receive money (create_and_match, also in bulk_reconcile batches). */
export async function createAndMatch(tx: OrgTx, args: Record<string, unknown>, source: string, key: string): Promise<Reconciled> {
  // #546 (GSR10): no GST treatment invented from a merchant's name.
  await assertAiGstTreatment(tx, args);
  return reconcileStatementLine(tx, args.lineId, {
    source,
    idempotencyKey: key,
    kind: "bank_transaction",
    contactId: args.contactId,
    amountsMode: args.amountsMode,
    lines: args.lines,
    ...(args.reference != null ? { reference: args.reference } : {}),
    ...(args.exchangeRate != null ? { exchangeRate: args.exchangeRate } : {}),
  });
}

export type OtherSide = { lineId: string; matched: true } | { matched: false; reason: string };
export type TransferResult = Reconciled & { otherSide: OtherSide };

/**
 * A transfer from the line (BK8), then the other account's own line for it
 * when there's exactly one unreconciled line there for the opposite amount on
 * the same day (AIB3). That second match is left for later if it's refused.
 */
export async function transferAndMatch(tx: OrgTx, args: Record<string, unknown>, source: string, key: string): Promise<TransferResult> {
  const result = await reconcileStatementLine(tx, args.lineId, {
    source,
    idempotencyKey: key,
    kind: "transfer",
    otherAccountCode: args.otherAccountCode,
    ...(args.otherAmount != null ? { otherAmount: args.otherAmount } : {}),
    ...(args.reference != null ? { reference: args.reference } : {}),
  });
  const line = result.line;
  const journalId = line.reconciliation?.items[0]?.journalId;
  if (!journalId) return { ...result, otherSide: { matched: false, reason: "The transfer wasn't found." } };
  const other = await tx.query<{ journal_line_id: string; account_id: string }>(
    `select l.id::text as journal_line_id, l.account_id::text
       from ledger_journal_lines l join accounts a on a.id = l.account_id
      where l.journal_id = $1 and l.account_id <> $2 and a.account_type in ('bank', 'credit_card')
      order by l.id`,
    [journalId, line.accountId],
  );
  if (other.rows.length !== 1) return { ...result, otherSide: { matched: false, reason: "The transfer has no single line on the other account." } };
  const { journal_line_id: otherJournalLineId, account_id: otherAccountId } = other.rows[0];
  const already = await tx.query<{ statement_line_id: string }>(
    `select r.statement_line_id::text from bank_reconciliation_items i join bank_reconciliations r on r.id = i.reconciliation_id
      where i.journal_line_id = $1 and i.active`,
    [otherJournalLineId],
  );
  if (already.rows[0]) return { ...result, otherSide: { lineId: already.rows[0].statement_line_id, matched: true } };
  const opposite = toFixedString(neg(dec(line.amount)), 2);
  const candidates = await tx.query<{ id: string }>(
    `select b.id::text from bank_statement_lines b
      where b.account_id = $1 and b.status = 'unreconciled' and b.line_date = $2::date and b.amount = $3::numeric
      order by b.id limit 2`,
    [otherAccountId, line.date, opposite],
  );
  if (candidates.rows.length !== 1) {
    return {
      ...result,
      otherSide: {
        matched: false,
        reason:
          candidates.rows.length === 0
            ? `No unreconciled ${opposite} line on the other account on ${line.date} yet; match it to the transfer when it arrives.`
            : `More than one ${opposite} line on the other account on ${line.date}; choose which with match_bank_line.`,
      },
    };
  }
  const otherLineId = candidates.rows[0].id;
  const matched = await inSavepoint(tx, () =>
    reconcileStatementLine(tx, otherLineId, { source, idempotencyKey: `${key}:other`, kind: "match", journalLineIds: [otherJournalLineId] }),
  );
  return { ...result, otherSide: matched.ok ? { lineId: otherLineId, matched: true } : { matched: false, reason: matched.error } };
}

/** A rule's spend or receive money for a line, as OKing its suggestion does (BK10, BK18). */
export async function applyRule(tx: OrgTx, lineId: string, ruleIdInput: unknown, source: string, key: string): Promise<Reconciled> {
  const line = await getStatementLine(tx, lineId);
  if (line.status !== "unreconciled") {
    // A retry of the same call finds the line reconciled with this key: the same answer as before.
    const replay = await tx.query("select 1 from bank_reconciliations where command_source = $1 and idempotency_key = $2 and statement_line_id = $3", [
      source,
      key,
      lineId,
    ]);
    if ((replay.rowCount ?? 0) > 0) return { created: false, line };
    throw new ConflictError(`This line is ${line.status}.`);
  }
  let rule: BankRule;
  if (ruleIdInput == null || ruleIdInput === "") {
    const fitting = (await suggestionsForLine(tx, lineId)).rule;
    if (!fitting) throw new ConflictError("No bank rule applies to this line.");
    rule = fitting;
  } else {
    rule = await getBankRule(tx, ruleIdInput);
    if (!ruleMatches(rule, line)) throw new ConflictError(`Bank rule "${rule.name}" doesn't apply to this line${rule.isActive ? "" : " (it's switched off)"}.`);
  }
  const lines = ruleLinesFor(rule, line);
  if (!lines) throw new ConflictError(`Bank rule "${rule.name}" can't split this line's amount.`);
  const contact = await ruleContact(tx, rule, line);
  if (!contact) throw new ConflictError(`No contact called "${line.payee ?? line.description}" for bank rule "${rule.name}". Use create_and_match with a contact.`);
  return reconcileStatementLine(tx, lineId, {
    source,
    idempotencyKey: key,
    kind: "bank_transaction",
    contactId: contact.id,
    amountsMode: ruleAmountsMode(lines),
    lines: lines.map((entry) => ({
      description: entry.description,
      accountCode: entry.accountCode,
      ...(entry.taxCode ? { taxCode: entry.taxCode } : {}),
      amount: entry.amount,
      ...(Object.keys(entry.tracking).length > 0 ? { tracking: entry.tracking } : {}),
    })),
  });
}

// ---------------------------------------------------------------------------
// Reconcile batches (bulk_reconcile)
// ---------------------------------------------------------------------------

/**
 * The batch's actions from what was asked: each well-formed action with its
 * key `<key>:<line>`; a malformed one, or a line already in the batch, is
 * recorded as refused with the reason (AIB4: each is done or refused on its
 * own). Pure, for tests too.
 */
export function reconcileBatchActions(rawActions: readonly unknown[], key: string): NewBatchAction[] {
  const seen = new Set<string>();
  return rawActions.map((raw, index) => {
    const label = `Action ${index + 1}`;
    const payload = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { value: raw };
    try {
      const fields = asRecord(raw, label);
      const action = requireOneOf(fields.action, `${label} action`, RECONCILE_ACTIONS);
      const lineId = requireId(fields.lineId, `${label} lineId`);
      if (seen.has(lineId)) throw new ValidationError(`${label}: line ${lineId} is already in this call.`);
      seen.add(lineId);
      return { action, targetId: lineId, payload: fields, idempotencyKey: `${key}:${lineId}` };
    } catch (error) {
      const lineId = typeof payload.lineId === "string" && /^[1-9]\d{0,17}$/.test(payload.lineId) ? payload.lineId : null;
      return { action: typeof payload.action === "string" ? payload.action.slice(0, 50) || "unknown" : "unknown", targetId: lineId, payload, idempotencyKey: `${key}:#${index}`, refused: lineErrorText(error) };
    }
  });
}

/** The work for one reconcile action, with the batch's own command source (so a resume by anyone finds the same results). */
function reconcileWork(source: string): ActionWork {
  return async (tx, action) => {
    const fields: Record<string, unknown> = { ...action.payload, lineId: action.targetId };
    const kind = action.action as ReconcileAction;
    let done: Reconciled & { otherSide?: OtherSide };
    if (kind === "match") done = await matchLine(tx, fields, source, action.idempotencyKey);
    else if (kind === "create_and_match") done = await createAndMatch(tx, fields, source, action.idempotencyKey);
    else if (kind === "transfer_and_match") done = await transferAndMatch(tx, fields, source, action.idempotencyKey);
    else if (kind === "apply_bank_rule") done = await applyRule(tx, requireId(action.targetId, "lineId"), fields.ruleId, source, action.idempotencyKey);
    else throw new ValidationError(`Unknown action ${action.action}.`);
    return { lineId: done.line.id, created: done.created, ...(done.otherSide ? { otherSide: done.otherSide } : {}) };
  };
}

/**
 * Starts (or, for the same source and key with the same actions, resumes) a
 * bulk_reconcile batch: the batch and its actions are committed first, then
 * each action in its own transaction.
 */
export async function startReconcileBatch(
  run: OrgRunner,
  input: { actions: unknown; idempotencyKey: string; source: string },
  options: RunOptions = {},
): Promise<RunOutcome & { created: boolean }> {
  const raw = requireArray(input.actions, "actions", MAX_BATCH_ACTIONS);
  if (raw.length === 0) throw new ValidationError("Give at least one action.");
  const actions = reconcileBatchActions(raw, input.idempotencyKey);
  const { batch, created } = await run((tx) =>
    createBatch(tx, {
      kind: "bank_reconcile",
      source: input.source,
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash("bulk_reconcile", { actions: raw }),
      actions,
    }),
  );
  return { ...(await runBatch(run, batch.id, reconcileWork(batch.source), options)), created };
}

// ---------------------------------------------------------------------------
// Unreconciling lines, and undoing a reconcile batch: the plan a person (or a
// Full access AI) reviews first
// ---------------------------------------------------------------------------

export type PlanLine = { lineId: string; accountId: string; accountCode: string; accountName: string; date: string; amount: string; description: string };

export type PlanItem = PlanLine & {
  /** The reconciliation that will be removed, or null when there's none to remove (undo: already unreconciled). */
  reconciliationId: string | null;
  /** match, payments, bank_transaction, transfer or split. */
  reconciliationKind: string | null;
  /** What it's reconciled with, e.g. "Spend money #12 (INV-1)". */
  reconciledWith: string[];
  /** Lines unreconciled with it: the rest of its split (BK28), or (undo) the other side of its transfer. */
  alsoLines: Array<PlanLine & { why: "split" | "transfer"; reconciliationId: string }>;
  /** Undo only: what's voided, on the line's date (AIB7). */
  voids: { kind: "bank_transaction" | "transfer"; id: string; date: string; label: string } | null;
  notes: string[];
  /** Why it can't be done; it's left as it is. */
  blocked: string | null;
};

export type Plan = { mode: "unreconcile" | "undo"; batchId: string | null; items: PlanItem[]; lockDate: string | null; hash: string; counts: { items: number; lines: number; blocked: number; voids: number } };

type LineRow = { id: string; account_id: string; code: string; name: string; line_date: string; amount: string; description: string; status: string };

async function planLines(tx: OrgTx, ids: readonly string[]): Promise<Map<string, LineRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.query<LineRow>(
    `select b.id::text, b.account_id::text, a.code, a.name, b.line_date::text, b.amount::text, b.description, b.status
       from bank_statement_lines b join accounts a on a.id = b.account_id
      where b.id = any($1::bigint[])`,
    [ids],
  );
  return new Map(rows.rows.map((row) => [row.id, row]));
}

function planLine(row: LineRow): PlanLine {
  return { lineId: row.id, accountId: row.account_id, accountCode: row.code, accountName: row.name, date: row.line_date, amount: toFixedString(dec(row.amount), 2), description: row.description };
}

const ORIGIN_WORDS: Record<string, string> = {
  bank_transaction: "Spend or receive money",
  bank_transfer: "Transfer",
  customer_payment: "Customer payment",
  supplier_payment: "Supplier payment",
  manual: "Journal",
};

/** Other bank lines actively reconciled to the same journal(s) as this reconciliation: a transfer's other side. */
async function otherSides(tx: OrgTx, reconciliationId: string, lineId: string): Promise<Array<{ lineId: string; reconciliationId: string }>> {
  const rows = await tx.query<{ statement_line_id: string; id: string }>(
    `select distinct r.statement_line_id::text, r.id::text
       from bank_reconciliation_items mine
       join ledger_journal_lines ml on ml.id = mine.journal_line_id
       join ledger_journal_lines ol on ol.journal_id = ml.journal_id and ol.id <> ml.id
       join bank_reconciliation_items theirs on theirs.journal_line_id = ol.id and theirs.active
       join bank_reconciliations r on r.id = theirs.reconciliation_id and r.status = 'active'
      where mine.reconciliation_id = $1 and r.statement_line_id <> $2 and r.split_id is null
      order by 1`,
    [reconciliationId, lineId],
  );
  return rows.rows.map((row) => ({ lineId: row.statement_line_id, reconciliationId: row.id }));
}

function lockedReason(dates: readonly string[], lockDate: string | null): string | null {
  if (!lockDate) return null;
  const locked = dates.filter((date) => date <= lockDate).sort();
  return locked.length > 0 ? `${formatDate(locked[0])} is in a locked period (locked up to ${formatDate(lockDate)}). An owner or admin can reopen it on Period close.` : null;
}

function finishPlan(mode: Plan["mode"], batchId: string | null, items: PlanItem[], lockDate: string | null): Plan {
  const hash = requestHash(`bank_${mode}_plan`, {
    batchId,
    lockDate,
    items: items.map((item) => ({
      lineId: item.lineId,
      reconciliationId: item.reconciliationId,
      also: item.alsoLines.map((line) => [line.lineId, line.reconciliationId]),
      voids: item.voids ? [item.voids.kind, item.voids.id] : null,
      blocked: item.blocked,
    })),
  });
  return {
    mode,
    batchId,
    items,
    lockDate,
    hash,
    counts: {
      items: items.length,
      lines: items.filter((item) => !item.blocked).reduce((total, item) => total + (item.reconciliationId ? 1 : 0) + item.alsoLines.length, 0),
      blocked: items.filter((item) => item.blocked).length,
      voids: items.filter((item) => !item.blocked && item.voids).length,
    },
  };
}

/** Distinct ids, at most MAX_BATCH_ACTIONS. */
export function parseBatchLineIds(input: unknown): string[] {
  const ids = [...new Set(requireArray(input, "lineIds", MAX_BATCH_ACTIONS).map((id, index) => requireId(id, `lineIds[${index}]`)))];
  if (ids.length === 0) throw new ValidationError("Choose at least one statement line.");
  return ids;
}

/**
 * What "Unreconcile selected" will do (BK11, BK13, BK28): each chosen line
 * goes back to be reconciled, with the rest of its split; nothing is posted
 * or voided. A transfer's other side stays reconciled (as Xero's
 * Unreconcile does) and the plan says so. Lines in a locked period, or not
 * reconciled, are shown as blocked and left alone.
 */
export async function planUnreconcile(tx: OrgTx, lineIdsInput: unknown): Promise<Plan> {
  const lineIds = parseBatchLineIds(lineIdsInput);
  const { lockDate } = await getPeriodControls(tx);
  const rows = await planLines(tx, lineIds);
  const covered = new Set<string>();
  const items: PlanItem[] = [];
  for (const lineId of lineIds) {
    if (covered.has(lineId)) continue;
    const row = rows.get(lineId);
    if (!row) throw new ValidationError(`Statement line ${lineId} wasn't found.`);
    const line = await getStatementLine(tx, lineId);
    const base: PlanItem = { ...planLine(row), reconciliationId: null, reconciliationKind: null, reconciledWith: [], alsoLines: [], voids: null, notes: [], blocked: null };
    if (line.status !== "reconciled" || !line.reconciliation) {
      items.push({ ...base, blocked: `This line is ${line.status}, not reconciled.` });
      continue;
    }
    const reconciliation = line.reconciliation;
    const item: PlanItem = {
      ...base,
      reconciliationId: reconciliation.id,
      reconciliationKind: reconciliation.split ? "split" : reconciliation.kind,
      reconciledWith: reconciliation.items.map((entry) => `${ORIGIN_WORDS[entry.origin] ?? entry.origin} #${entry.journalId}${entry.reference ? ` (${entry.reference})` : ""}`),
    };
    if (reconciliation.split) {
      const partners = reconciliation.split.lines.filter((other) => other.id !== lineId).map((other) => other.id);
      const partnerRows = await planLines(tx, partners);
      const partnerRecs = await tx.query<{ statement_line_id: string; id: string }>(
        "select statement_line_id::text, id::text from bank_reconciliations where split_id = $1 and status = 'active'",
        [reconciliation.split.id],
      );
      const recOf = new Map(partnerRecs.rows.map((entry) => [entry.statement_line_id, entry.id]));
      for (const partner of partners) {
        const partnerRow = partnerRows.get(partner);
        if (!partnerRow) continue;
        item.alsoLines.push({ ...planLine(partnerRow), why: "split", reconciliationId: recOf.get(partner) ?? "" });
        covered.add(partner);
      }
      item.notes.push("It's one of a split, so the whole split is unreconciled together.");
    } else {
      for (const other of await otherSides(tx, reconciliation.id, lineId)) {
        if (lineIds.includes(other.lineId)) continue; // chosen too: its own item
        const otherRow = (await planLines(tx, [other.lineId])).get(other.lineId);
        if (otherRow) {
          item.notes.push(
            `The other side of this transfer (${otherRow.code} ${otherRow.name}, ${formatDate(otherRow.line_date)}, ${formatMoney(toFixedString(dec(otherRow.amount), 2))}) stays reconciled. Choose it too to unreconcile both.`,
          );
        }
      }
    }
    item.notes.push("Nothing is posted or voided. What it was reconciled with stays in the books.");
    item.blocked = lockedReason([item.date, ...item.alsoLines.map((other) => other.date)], lockDate);
    items.push(item);
  }
  return finishPlan("unreconcile", null, items, lockDate);
}

/**
 * What undoing a bulk_reconcile batch will do (AIB7 for each line, decision
 * 1276): each line the batch reconciled that's still reconciled the way the
 * batch did it is unreconciled, with the other side of its transfer, and
 * what the batch posted for it (spend or receive money, a transfer) is
 * voided on the line's date. Matches to things already posted, and
 * payments, are only unreconciled: the payments stay for a person to void.
 * A line reconciled again since, or in a locked period, is left alone.
 */
export async function planBatchUndo(tx: OrgTx, batchIdInput: unknown): Promise<Plan> {
  const batch = await getBatch(tx, batchIdInput);
  if (batch.kind !== "bank_reconcile") throw new ValidationError("Only a batch of reconciliations can be undone this way.");
  const { lockDate } = await getPeriodControls(tx);
  const items: PlanItem[] = [];
  const committed = batch.actions.filter((action) => action.status === "committed" && action.targetId);
  const rows = await planLines(
    tx,
    committed.map((action) => action.targetId!),
  );
  for (const action of committed) {
    const lineId = action.targetId!;
    const row = rows.get(lineId);
    if (!row) continue;
    const base: PlanItem = { ...planLine(row), reconciliationId: null, reconciliationKind: null, reconciledWith: [], alsoLines: [], voids: null, notes: [], blocked: null };
    const made = (
      await tx.query<{ id: string; status: string; kind: string; journal_id: string | null }>(
        `select r.id::text, r.status, r.kind,
                (select l.journal_id::text from bank_reconciliation_items i join ledger_journal_lines l on l.id = i.journal_line_id
                  where i.reconciliation_id = r.id order by i.id limit 1) as journal_id
           from bank_reconciliations r where r.command_source = $1 and r.idempotency_key = $2 and r.statement_line_id = $3`,
        [batch.source, action.idempotencyKey, lineId],
      )
    ).rows[0];
    if (!made) {
      items.push({ ...base, blocked: "The reconciliation this batch made wasn't found." });
      continue;
    }
    const item: PlanItem = { ...base, reconciliationKind: made.kind };
    if (made.status === "active") {
      item.reconciliationId = made.id;
      for (const other of await otherSides(tx, made.id, lineId)) {
        const otherRow = (await planLines(tx, [other.lineId])).get(other.lineId);
        if (otherRow) item.alsoLines.push({ ...planLine(otherRow), why: "transfer", reconciliationId: other.reconciliationId });
      }
    } else {
      const now = await tx.query("select 1 from bank_reconciliations where statement_line_id = $1 and status = 'active'", [lineId]);
      item.notes.push(now.rowCount ? "Someone has already unreconciled it and reconciled it again; that's left as it is." : "It's already unreconciled.");
    }
    if ((made.kind === "bank_transaction" || made.kind === "transfer") && made.journal_id) {
      const table = made.kind === "bank_transaction" ? "bank_transactions" : "bank_transfers";
      const found = (await tx.query<{ id: string; status: string; reference: string | null }>(`select id::text, status, reference from ${table} where journal_id = $1`, [made.journal_id])).rows[0];
      if (found?.status === "posted") {
        item.voids = {
          kind: made.kind,
          id: found.id,
          date: item.date,
          label: `${made.kind === "bank_transaction" ? "Spend or receive money" : "Transfer"} #${found.id}${found.reference ? ` (${found.reference})` : ""}`,
        };
      } else if (found) {
        item.notes.push("What it posted has already been voided.");
      }
    } else if (made.kind === "payments") {
      item.notes.push("The payments it recorded stay. Void them on the invoice or bill if they were wrong.");
    } else if (made.kind === "match") {
      item.notes.push("It was matched to something already posted, so nothing is voided.");
    }
    if (!item.reconciliationId && !item.voids) {
      item.blocked = item.notes[0] ?? "Nothing to undo.";
    } else {
      item.blocked = lockedReason([item.date, ...item.alsoLines.map((other) => other.date)], lockDate);
    }
    items.push(item);
  }
  return finishPlan("undo", batch.id, items, lockDate);
}

/** Unreconciles one reconciliation if it's still the one the plan showed; a retry with the same key finds the earlier result. */
async function unreconcileExpected(tx: OrgTx, lineId: string, reconciliationId: string, source: string, key: string): Promise<boolean> {
  const replay = await tx.query("select 1 from bank_reconciliations where removal_command_source = $1 and removal_idempotency_key = $2", [source, key]);
  if ((replay.rowCount ?? 0) > 0) return false;
  const current = await tx.query<{ id: string }>("select id::text from bank_reconciliations where statement_line_id = $1 and status = 'active' for update", [lineId]);
  if (current.rows[0]?.id !== reconciliationId) {
    // Unreconciled as part of a split by this same action already, or changed by someone since the preview.
    const removedHere = await tx.query(
      "select 1 from bank_reconciliations where id = $1 and status = 'removed' and removal_command_source = $2 and removal_idempotency_key like $3",
      [reconciliationId, source, `${key.replace(/[\\%_]/g, "\\$&")}%`],
    );
    if ((removedHere.rowCount ?? 0) > 0) return false;
    throw new ConflictError(`Line ${lineId} has changed since the preview. Preview it again.`);
  }
  return (await unreconcileStatementLine(tx, lineId, { source, idempotencyKey: key })).created;
}

function unreconcileWork(source: string): ActionWork {
  return async (tx, action) => {
    const lineId = requireId(action.targetId, "lineId");
    const reconciliationId = requireString(action.payload.reconciliationId, "reconciliationId", { maxLength: 20 });
    const created = await unreconcileExpected(tx, lineId, reconciliationId, source, action.idempotencyKey);
    const lines = Array.isArray(action.payload.lineIds) ? (action.payload.lineIds as string[]) : [lineId];
    return { lineId, created, unreconciled: lines };
  };
}

function undoWork(source: string): ActionWork {
  return async (tx, action) => {
    const lineId = requireId(action.targetId, "lineId");
    const payload = action.payload as {
      reconciliationId: string | null;
      also: Array<{ lineId: string; reconciliationId: string }>;
      voids: { kind: "bank_transaction" | "transfer"; id: string; date: string } | null;
    };
    const unreconciled: string[] = [];
    // The other side first, so the transfer can be voided (it can't be while either side is reconciled).
    for (const [index, other] of (payload.also ?? []).entries()) {
      await unreconcileExpected(tx, other.lineId, other.reconciliationId, source, `${action.idempotencyKey}:o${index}`);
      unreconciled.push(other.lineId);
    }
    if (payload.reconciliationId) {
      await unreconcileExpected(tx, lineId, payload.reconciliationId, source, action.idempotencyKey);
      unreconciled.unshift(lineId);
    }
    let voided: { kind: string; id: string; date: string } | null = null;
    if (payload.voids) {
      const command = { source, idempotencyKey: `${action.idempotencyKey}:void`, voidDate: payload.voids.date };
      if (payload.voids.kind === "bank_transaction") await voidBankTransaction(tx, payload.voids.id, command);
      else await voidTransfer(tx, payload.voids.id, command);
      voided = payload.voids;
    }
    return { lineId, unreconciled, voided };
  };
}

function planActions(plan: Plan, key: string): NewBatchAction[] {
  return plan.items.map((item) => ({
    action: plan.mode,
    targetId: item.lineId,
    payload:
      plan.mode === "unreconcile"
        ? { reconciliationId: item.reconciliationId, lineIds: [item.lineId, ...item.alsoLines.map((line) => line.lineId)] }
        : {
            reconciliationId: item.reconciliationId,
            also: item.alsoLines.map((line) => ({ lineId: line.lineId, reconciliationId: line.reconciliationId })),
            voids: item.voids ? { kind: item.voids.kind, id: item.voids.id, date: item.voids.date } : null,
          },
    idempotencyKey: `${key}:${item.lineId}`,
    ...(item.blocked ? { refused: item.blocked } : {}),
  }));
}

function assertPlanSeen(plan: Plan, previewHash: unknown): void {
  if (typeof previewHash !== "string" || previewHash !== plan.hash) {
    throw new ConflictError("These lines have changed since the preview (or there was no preview). Preview them again and check it.");
  }
}

/**
 * Runs "Unreconcile selected" after its preview (decision 1275): refused
 * unless `previewHash` is the hash of the plan as it is now, so what's done
 * is what was shown. The same key again finds the same batch.
 */
export async function startUnreconcileBatch(
  run: OrgRunner,
  input: { lineIds: unknown; previewHash: unknown; idempotencyKey: string; source: string },
  options: RunOptions = {},
): Promise<RunOutcome & { created: boolean }> {
  const { batch, created } = await run(async (tx) => {
    const earlier = await tx.query<{ id: string }>("select id::text from batches where command_source = $1 and idempotency_key = $2 and kind = 'bank_unreconcile'", [
      input.source,
      input.idempotencyKey,
    ]);
    if (earlier.rows[0]) {
      // A retry: the lines have changed since (that was this batch), so the plan isn't checked again; the request must be the same.
      const lineIds = parseBatchLineIds(input.lineIds);
      return createBatch(tx, { kind: "bank_unreconcile", source: input.source, idempotencyKey: input.idempotencyKey, requestHash: requestHash("bank_unreconcile", { lineIds, previewHash: input.previewHash }), actions: [] });
    }
    const plan = await planUnreconcile(tx, input.lineIds);
    assertPlanSeen(plan, input.previewHash);
    return createBatch(tx, {
      kind: "bank_unreconcile",
      source: input.source,
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash("bank_unreconcile", { lineIds: parseBatchLineIds(input.lineIds), previewHash: input.previewHash }),
      actions: planActions(plan, input.idempotencyKey),
    });
  });
  return { ...(await runBatch(run, batch.id, unreconcileWork(batch.source), options)), created };
}

/** Undoes a bulk_reconcile batch after its preview (decision 1276), as a batch of its own. */
export async function startBatchUndo(
  run: OrgRunner,
  batchIdInput: unknown,
  input: { previewHash: unknown; idempotencyKey: string; source: string },
  options: RunOptions = {},
): Promise<RunOutcome & { created: boolean }> {
  const batchId = requireId(batchIdInput, "batchId");
  const { batch, created } = await run(async (tx) => {
    const request = requestHash("bank_undo", { batchId, previewHash: input.previewHash });
    const earlier = await tx.query("select 1 from batches where command_source = $1 and idempotency_key = $2", [input.source, input.idempotencyKey]);
    if (earlier.rowCount) return createBatch(tx, { kind: "bank_undo", source: input.source, idempotencyKey: input.idempotencyKey, requestHash: request, undoesBatchId: batchId, actions: [] });
    const plan = await planBatchUndo(tx, batchId);
    assertPlanSeen(plan, input.previewHash);
    return createBatch(tx, { kind: "bank_undo", source: input.source, idempotencyKey: input.idempotencyKey, requestHash: request, undoesBatchId: batchId, actions: planActions(plan, input.idempotencyKey) });
  });
  return { ...(await runBatch(run, batch.id, undoWork(batch.source), options)), created };
}

/** The work for a batch's own kind, with its own command source. */
export function workFor(batch: Pick<Batch, "kind" | "source">): ActionWork {
  if (batch.kind === "bank_reconcile") return reconcileWork(batch.source);
  if (batch.kind === "bank_unreconcile") return unreconcileWork(batch.source);
  // Approved bank coding proposals (#544): posted as they were approved, checked again first.
  if (batch.kind === "bank_coding") return approvalWork(batch.source);
  return undoWork(batch.source);
}

/**
 * Resumes a batch: its pending and outcome-unknown actions (and, with
 * `retryFailed`, its failed ones), each with its original key and payload,
 * as the batch's own command source. Resuming a finished batch changes
 * nothing. `onlySource`, for an AI: only its own batches.
 */
export async function resumeBankBatch(
  run: OrgRunner,
  batchIdInput: unknown,
  options: RunOptions & { onlySource?: string } = {},
): Promise<RunOutcome> {
  const batch = await run((tx) => getBatch(tx, batchIdInput));
  if (options.onlySource && batch.source !== options.onlySource) {
    throw new ConflictError("This batch was made by someone else. Only they, or a person in Tohyee, can resume it.");
  }
  return runBatch(run, batch.id, workFor(batch), options);
}

/** The statement lines a batch's actions name, for showing them by date, description and amount. */
export async function batchLines(tx: OrgTx, batch: Pick<Batch, "actions">): Promise<Record<string, PlanLine>> {
  const ids = [...new Set(batch.actions.map((action) => action.targetId).filter((id): id is string => Boolean(id)))];
  const rows = await planLines(tx, ids);
  return Object.fromEntries([...rows.values()].map((row) => [row.id, planLine(row)]));
}

/** The batches that touched an account's lines, newest first. */
export async function accountBatchIds(tx: OrgTx, accountIdInput: unknown, limit = 50): Promise<string[]> {
  const accountId = requireId(accountIdInput, "accountId");
  const rows = await tx.query<{ id: string }>(
    `select b.id::text from batches b
      where exists (select 1 from batch_actions a join bank_statement_lines l on l.id::text = a.target_id
                     where a.batch_id = b.id and l.account_id = $1)
      order by b.created_at desc, b.id desc limit $2`,
    [accountId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.rows.map((row) => row.id);
}

export type { BatchAction };

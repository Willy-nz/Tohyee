import type { OrgTx } from "@/lib/db/org-transaction";
import { writeAuditEvent } from "@/lib/audit";
import { ConflictError, ValidationError } from "@/lib/errors";
import { requestHash } from "@/lib/idempotency";
import { getPeriodControls } from "@/lib/ledger/period-controls";
import { add, dec, type Decimal, isZero, neg, sub, toFixedString } from "@/lib/money/decimal";
import { createBankTransaction, getBankTransaction, voidBankTransaction, type BankTransaction } from "@/lib/bank/transactions";
import { reconcileStatementLine, unreconcileStatementLine } from "@/lib/bank/reconcile";
import { optionalId, optionalString, requireArray, requireId, requireIdempotencyKey } from "@/lib/validation";
import { parseOptionalIsoDate } from "@/lib/dates";

/**
 * Recode spend and receive money in place (RC1-RC6, decision 1587, Jess's
 * issue 11): change the account (and the GST code, contact or description)
 * of bank transactions, one or many, instead of posting recoding journals.
 * Each is corrected as a whole, on its own date: the old one is voided and
 * the new one posted, linked to it (bank_transaction_recodes), and a statement line it
 * was reconciled with is reconciled with the new one. A preview first, by
 * account and month. Refused in a locked period, for one that's part of a
 * split reconciliation, and when the change would alter its total (a GST
 * code change on amounts entered without GST).
 */

export const MAX_RECODE = 100;

export type RecodeChange = { fromAccountCode: string | null; accountCode: string | null; taxCode: string | null; contactId: string | null; description: string | null };

export type RecodeItem = { bankTransactionId: string; date: string; contactName: string; total: string; lines: number; blocked: string | null };
export type RecodePlan = {
  items: RecodeItem[];
  /** What moves, by account and month: net amounts out of the old accounts and into the new. */
  effect: Array<{ month: string; accountCode: string; amount: string }>;
  hash: string;
};

function parseChange(input: unknown): RecodeChange {
  const raw = (input ?? {}) as Record<string, unknown>;
  const change: RecodeChange = {
    fromAccountCode: optionalString(raw.fromAccountCode, "fromAccountCode", { maxLength: 20 }),
    accountCode: optionalString(raw.accountCode, "accountCode", { maxLength: 20 }),
    taxCode: optionalString(raw.taxCode, "taxCode", { maxLength: 20 }),
    contactId: optionalId(raw.contactId, "contactId"),
    description: optionalString(raw.description, "description", { maxLength: 500 }),
  };
  if (!change.accountCode && !change.taxCode && !change.contactId && !change.description) throw new ValidationError("Choose what to change: the account, GST code, contact or description.");
  return change;
}

/** The statement line a bank transaction is reconciled with, or a reason it can't be recoded. */
async function reconciledLine(tx: OrgTx, transaction: BankTransaction): Promise<{ lineId: string | null; blocked: string | null }> {
  const found = await tx.query<{ statement_line_id: string; split_id: string | null; kind: string }>(
    `select r.statement_line_id::text, r.split_id::text, r.kind from bank_reconciliation_items i
       join bank_reconciliations r on r.id = i.reconciliation_id
       join ledger_journal_lines l on l.id = i.journal_line_id
      where i.active and l.journal_id = $1`,
    [transaction.journalId],
  );
  if (found.rows.length === 0) return { lineId: null, blocked: null };
  const row = found.rows[0];
  if (found.rows.length > 1 || row.split_id) return { lineId: null, blocked: "It's part of a split reconciliation: use Remove & redo." };
  if (row.kind !== "bank_transaction") return { lineId: null, blocked: "Its statement line is matched to it rather than coded: use Remove & redo." };
  return { lineId: row.statement_line_id, blocked: null };
}

const linesChanged = (transaction: BankTransaction, change: RecodeChange) =>
  transaction.lines.map((line) => {
    const hit = !change.fromAccountCode || line.accountCode.toLowerCase() === change.fromAccountCode.toLowerCase();
    return {
      description: hit && change.description ? change.description : line.description,
      accountCode: hit && change.accountCode ? change.accountCode : line.accountCode,
      taxCode: transaction.amountsMode === "no_tax" ? null : hit && change.taxCode ? change.taxCode : line.taxCode,
      amount: line.lineAmount,
      tracking: line.tracking,
      customFields: line.customFields,
      hit,
      was: line,
    };
  });

/** The preview (RC2): each transaction, whether it can be recoded, and the effect by account and month. Changes nothing. */
export async function planRecode(tx: OrgTx, input: { bankTransactionIds: unknown; change: unknown }): Promise<RecodePlan> {
  const ids = [...new Set(requireArray(input.bankTransactionIds, "bankTransactionIds", MAX_RECODE).map((id, index) => requireId(id, `bankTransactionIds[${index}]`)))];
  if (ids.length === 0) throw new ValidationError("Choose at least one transaction.");
  const change = parseChange(input.change);
  const lock = (await getPeriodControls(tx)).lockDate;
  const items: RecodeItem[] = [];
  const effect = new Map<string, Decimal>();
  for (const id of ids) {
    const transaction = await getBankTransaction(tx, id);
    const lines = linesChanged(transaction, change);
    let blocked: string | null = null;
    if (transaction.status !== "posted") blocked = "It's voided.";
    else if (lock && transaction.date <= lock) blocked = `${transaction.date} is in a locked period (locked to ${lock}).`;
    else if (!lines.some((line) => line.hit)) blocked = `None of its lines is on ${change.fromAccountCode}.`;
    else if (change.contactId === null && lines.every((line) => line.accountCode === line.was.accountCode && line.taxCode === line.was.taxCode && line.description === line.was.description)) {
      blocked = "Nothing would change.";
    } else if (change.taxCode && transaction.amountsMode === "exclusive") blocked = "Its amounts were entered without GST, so a new GST code would change its total.";
    else blocked = (await reconciledLine(tx, transaction)).blocked;
    items.push({ bankTransactionId: id, date: transaction.date, contactName: transaction.contactName, total: transaction.total, lines: transaction.lines.length, blocked });
    if (blocked) continue;
    const month = transaction.date.slice(0, 7);
    // Net amounts move between accounts; a GST change moves only the GST part, which shows on the GST return.
    for (const line of lines) {
      if (line.accountCode === line.was.accountCode) continue;
      const net = dec(line.was.netAmount);
      const signed = transaction.kind === "spend" ? net : neg(net);
      effect.set(`${month}|${line.was.accountCode}`, sub(effect.get(`${month}|${line.was.accountCode}`) ?? dec("0"), signed));
      effect.set(`${month}|${line.accountCode}`, add(effect.get(`${month}|${line.accountCode}`) ?? dec("0"), signed));
    }
  }
  const rows = [...effect.entries()]
    .filter(([, amount]) => !isZero(amount))
    .map(([keyText, amount]) => {
      const [month, accountCode] = keyText.split("|");
      return { month, accountCode, amount: toFixedString(amount, 2) };
    })
    .sort((a, b) => a.month.localeCompare(b.month) || a.accountCode.localeCompare(b.accountCode));
  return { items, effect: rows, hash: requestHash("recode-bank-transactions", { items: items.map((item) => [item.bankTransactionId, item.total, item.blocked]), change }) };
}

/** Recodes them (RC3-RC5), all or none, after the preview. A retry with the same key does nothing more. */
export async function recodeBankTransactions(
  tx: OrgTx,
  input: { bankTransactionIds: unknown; change: unknown; previewHash: unknown; idempotencyKey: unknown; source?: string },
): Promise<{ created: boolean; recoded: Array<{ from: string; to: string }> }> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const source = input.source ?? "ui";
  const earlier = await tx.query<{ from_id: string; to_id: string }>(
    "select from_id::text, to_id::text from bank_transaction_recodes where command_source = $1 and idempotency_key = $2 order by bank_transaction_recodes.from_id",
    [source, key],
  );
  if (earlier.rows.length > 0) return { created: false, recoded: earlier.rows.map((row) => ({ from: row.from_id, to: row.to_id })) };
  const ids = requireArray(input.bankTransactionIds, "bankTransactionIds", MAX_RECODE).map((id, index) => requireId(id, `bankTransactionIds[${index}]`));
  for (const id of ids) await tx.query("select id from bank_transactions where id = $1 for update", [id]);
  const plan = await planRecode(tx, { bankTransactionIds: ids, change: input.change });
  if (input.previewHash !== plan.hash) throw new ConflictError("Something has changed since the preview. Preview it again.");
  const stuck = plan.items.find((item) => item.blocked);
  if (stuck) throw new ConflictError(`Bank transaction #${stuck.bankTransactionId} can't be recoded: ${stuck.blocked}`);
  const change = parseChange(input.change);
  const recoded: Array<{ from: string; to: string }> = [];
  for (const item of plan.items) {
    const transaction = await getBankTransaction(tx, item.bankTransactionId);
    const { lineId } = await reconciledLine(tx, transaction);
    const sub = (what: string) => `recode:${key}:${transaction.id}:${what}`;
    if (lineId) await unreconcileStatementLine(tx, lineId, { source, idempotencyKey: sub("unreconcile") });
    await voidBankTransaction(tx, transaction.id, { source, idempotencyKey: sub("void"), voidDate: transaction.date });
    const lines = linesChanged(transaction, change).map((line) => ({
      description: line.description,
      accountCode: line.accountCode,
      taxCode: line.taxCode,
      amount: line.amount,
      tracking: line.tracking,
      customFields: line.customFields,
    }));
    const body = {
      contactId: change.contactId ?? transaction.contactId,
      reference: transaction.reference ?? undefined,
      amountsMode: transaction.amountsMode,
      lines,
      customFields: transaction.customFields,
      ...(transaction.exchangeRate ? { exchangeRate: transaction.exchangeRate } : {}),
    };
    let newId: string;
    if (lineId) {
      await reconcileStatementLine(tx, lineId, { source, idempotencyKey: sub("reconcile"), kind: "bank_transaction", ...body });
      newId = (
        await tx.query<{ id: string }>("select bank_transactions.id::text as id from bank_transactions where command_source = $1 and idempotency_key = $2", [source, `${sub("reconcile")}:bank_transaction`])
      ).rows[0].id;
    } else {
      const created = await createBankTransaction(tx, {
        source,
        idempotencyKey: sub("new"),
        kind: transaction.kind,
        accountId: transaction.accountId,
        date: transaction.date,
        ...body,
      });
      newId = created.bankTransaction.id;
    }
    await tx.query("insert into bank_transaction_recodes (from_id, to_id, command_source, idempotency_key, created_by_email) values ($1, $2, $3, $4, $5)", [
      transaction.id,
      newId,
      source,
      key,
      tx.actor.email,
    ]);
    await writeAuditEvent(tx, { eventType: "bank_transaction.recoded", entityType: "bank_transaction", entityId: transaction.id, details: { to: newId, change } });
    recoded.push({ from: transaction.id, to: newId });
  }
  return { created: true, recoded };
}

/** Bank transactions to choose from (RC6): posted, by bank account, coding account, contact, text and dates. */
export async function findRecodable(
  tx: OrgTx,
  filters: { bankAccountId?: unknown; accountCode?: unknown; contactId?: unknown; text?: unknown; from?: unknown; to?: unknown },
): Promise<BankTransaction[]> {
  const from = parseOptionalIsoDate(filters.from, "from");
  const to = parseOptionalIsoDate(filters.to, "to");
  const text = optionalString(filters.text, "text", { maxLength: 100 });
  const accountCode = optionalString(filters.accountCode, "accountCode", { maxLength: 20 });
  const rows = await tx.query<{ id: string }>(
    `select distinct t.id, t.transaction_date from bank_transactions t
       join bank_transaction_lines l on l.bank_transaction_id = t.id
       join accounts a on a.id = l.account_id
       join contacts c on c.id = t.contact_id
      where t.status = 'posted'
        and ($1::bigint is null or t.account_id = $1)
        and ($2::text is null or lower(a.code) = lower($2))
        and ($3::bigint is null or t.contact_id = $3)
        and ($4::text is null or l.description ilike '%' || $4 || '%' or c.name ilike '%' || $4 || '%' or coalesce(t.reference, '') ilike '%' || $4 || '%')
        and ($5::date is null or t.transaction_date >= $5) and ($6::date is null or t.transaction_date <= $6)
      order by t.transaction_date desc, t.id desc limit 200`,
    [optionalId(filters.bankAccountId, "bankAccountId"), accountCode, optionalId(filters.contactId, "contactId"), text, from, to],
  );
  const out: BankTransaction[] = [];
  for (const row of rows.rows) out.push(await getBankTransaction(tx, String(row.id)));
  return out;
}

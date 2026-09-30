import { writeAuditEvent } from "@/lib/audit";
import { getStatementLine, lockStatementLine, type StatementLine } from "@/lib/bank/accounts";
import { listBankRules, ruleMatches, type BankRule } from "@/lib/bank/rules";
import { createBankTransaction, createTransfer } from "@/lib/bank/transactions";
import { recordSupplierPayment } from "@/lib/bills/payments";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { recordPayment } from "@/lib/invoices/payments";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { dec, parseDecimalInput, toFixedString } from "@/lib/money/decimal";
import {
  asRecord,
  optionalId,
  optionalSource,
  optionalString,
  requireArray,
  requireId,
  requireIdempotencyKey,
  requireOneOf,
  requireString,
} from "@/lib/validation";

/**
 * Reconciling statement lines (examples BK4-BK13): a line is tied to journal
 * lines on its account that add up to it, either by matching what's already
 * posted or by posting it from the line (payments against invoices or bills,
 * a bank transaction, or a transfer). Everything happens in one transaction,
 * so a line is never half reconciled. The database checks the result again.
 */
export const MATCH_WINDOW_DAYS = 60;

type ReconcileResult = { created: boolean; line: StatementLine };

function cents(amount: string): bigint {
  return BigInt(toFixedString(dec(amount), 2).replace(".", ""));
}

function formatCents(value: bigint): string {
  const negative = value < BigInt(0);
  const text = (negative ? -value : value).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${text.slice(0, -2)}.${text.slice(-2)}`;
}

/** An adjustment needs a difference and an account (examples BK24, BK25). */
function assertAdjustable(adjustment: Adjustment, difference: bigint, what: string): void {
  if (difference === BigInt(0)) {
    throw new ValidationError(`${what} already add up to the line, so there's no difference for an adjustment.`);
  }
  if (!adjustment.accountCode) {
    throw new ValidationError(`Choose the account for the ${formatCents(difference < BigInt(0) ? -difference : difference)} difference.`);
  }
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

async function journalLineOn(tx: OrgTx, journalId: string, accountId: string): Promise<string> {
  const result = await tx.query<{ id: string }>(
    "select id from ledger_journal_lines where journal_id = $1 and account_id = $2 order by line_order",
    [journalId, accountId],
  );
  if (result.rows.length !== 1) {
    throw new ValidationError(`Journal #${journalId} doesn't have exactly one line on this account, so it can't be matched automatically.`);
  }
  return result.rows[0].id;
}

type Adjustment = {
  accountCode: string | null;
  taxCode: string | null;
  contactId: string | null;
  description: string | null;
  tracking: unknown;
};

function parseAdjustment(input: unknown): Adjustment | null {
  if (input == null) return null;
  const entry = asRecord(input, "adjustment");
  const accountCode = optionalString(entry.accountCode, "adjustment accountCode", { maxLength: 20 });
  return {
    accountCode,
    taxCode: optionalString(entry.taxCode, "adjustment taxCode", { maxLength: 20 }),
    contactId: optionalId(entry.contactId, "adjustment contactId"),
    description: optionalString(entry.description, "adjustment description", { maxLength: 500 }),
    tracking: entry.tracking,
  };
}

/**
 * The difference between a statement line and what it's matched with or pays
 * (examples BK24, BK25), posted as spend money (money out, `difference`
 * negative) or receive money (money in) for the difference, dated the line
 * date, to the chosen account: like Xero's adjustment. Returns its journal
 * line on the line's account, to reconcile with the rest.
 */
async function postAdjustment(
  tx: OrgTx,
  line: StatementLine,
  adjustment: Adjustment,
  difference: bigint,
  defaultContactId: string | null,
  command: { source: string; idempotencyKey: string },
): Promise<string> {
  const unsigned = formatCents(difference < BigInt(0) ? -difference : difference);
  const contactId = adjustment.contactId ?? defaultContactId;
  if (!contactId) throw new ValidationError(`Choose a contact for the ${unsigned} adjustment.`);
  const { bankTransaction } = await createBankTransaction(
    tx,
    {
      source: command.source,
      idempotencyKey: command.idempotencyKey,
      kind: difference > BigInt(0) ? "receive" : "spend",
      accountId: line.accountId,
      contactId,
      date: line.date,
      reference: (line.reference ?? line.particulars ?? undefined)?.slice(0, 100),
      amountsMode: adjustment.taxCode ? "inclusive" : "no_tax",
      lines: [
        {
          description: adjustment.description ?? "Adjustment",
          accountCode: adjustment.accountCode,
          taxCode: adjustment.taxCode ?? undefined,
          amount: unsigned,
          tracking: adjustment.tracking,
        },
      ],
    },
    { expectedTotal: unsigned },
  );
  return journalLineOn(tx, bankTransaction.journalId, line.accountId);
}

type CandidateRow = {
  id: string;
  journal_id: string;
  account_id: string;
  amount: string;
  posting_date: string;
  origin: string;
  reference: string;
  description: string | null;
  line_description: string | null;
  reconciled: boolean;
};

async function loadJournalLines(tx: OrgTx, ids: string[]): Promise<CandidateRow[]> {
  const result = await tx.query<CandidateRow>(
    `select l.id, l.journal_id, l.account_id, (l.debit_amount - l.credit_amount)::text as amount, j.posting_date::text,
            j.origin, j.reference, j.description, l.description as line_description,
            exists (select 1 from bank_reconciliation_items i where i.journal_line_id = l.id and i.active) as reconciled
       from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
      where l.id = any($1::bigint[])`,
    [ids],
  );
  return result.rows;
}

/**
 * Reconciles an unreconciled statement line. `command.kind`:
 * - "match": `journalLineIds` already posted on the line's account (BK4);
 * - "payments": `allocations` of `{ invoiceId | billId, amount }` paid from the line (BK5);
 * - "bank_transaction": a spend or receive money for the line (BK6, BK7, BK9);
 * - "transfer": `otherAccountCode`, the other bank or credit card account (BK8, BK9).
 *
 * For "match" and "payments", an `adjustment` (`accountCode`, optional
 * `taxCode`, `contactId`, `description`, `tracking`) records a difference
 * between the line and what it's matched with or pays as spend or receive
 * money, reconciled with the rest (BK24, BK25).
 */
export async function reconcileStatementLine(
  tx: OrgTx,
  lineIdInput: unknown,
  command: Record<string, unknown>,
): Promise<ReconcileResult> {
  const lineId = requireId(lineIdInput, "lineId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const kind = requireOneOf(command.kind, "kind", ["match", "payments", "bank_transaction", "transfer"] as const);
  const adjustment = parseAdjustment(command.adjustment);
  if (adjustment && kind !== "match" && kind !== "payments") {
    throw new ValidationError("An adjustment is only for a difference when matching, or paying invoices or bills.");
  }
  const hash = requestHash("bank_reconciliation", { lineId, command: { ...command, idempotencyKey: null, source: null, organisationId: null } });
  const replay = async (): Promise<ReconcileResult | null> => {
    const earlier = await tx.query<{ statement_line_id: string; request_hash: string }>(
      "select statement_line_id, request_hash from bank_reconciliations where command_source = $1 and idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].request_hash, hash, "reconciliation");
    return { created: false, line: await getStatementLine(tx, earlier.rows[0].statement_line_id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const line = await lockStatementLine(tx, lineId);
  const committedMeanwhile = await replay();
  if (committedMeanwhile) return committedMeanwhile;
  if (line.status === "reconciled") throw new ConflictError("This line is already reconciled.");
  if (line.status === "excluded") throw new ConflictError("This line is excluded. Include it again before reconciling it.");
  if (line.status === "deleted") throw new ConflictError("This line's import was deleted.");
  await assertPostingDateAllowed(tx, line.date);
  const account = (await tx.query<{ code: string }>("select code from accounts where id = $1", [line.accountId])).rows[0];
  const moneyIn = !line.amount.startsWith("-");
  const unsigned = line.amount.replace(/^-/, "");
  const subKey = (suffix: string) => `${idempotencyKey}:${suffix}`;

  let journalLineIds: string[];
  if (kind === "match") {
    journalLineIds = [...new Set(requireArray(command.journalLineIds, "journalLineIds", 50).map((id, index) => requireId(id, `journalLineIds[${index}]`)))];
    if (journalLineIds.length === 0) throw new ValidationError("Choose at least one transaction to match.");
    const rows = await loadJournalLines(tx, journalLineIds);
    if (rows.length !== journalLineIds.length) throw new ValidationError("One of the chosen transactions doesn't exist.");
    for (const row of rows) {
      if (row.account_id !== line.accountId) throw new ValidationError(`Journal #${row.journal_id} isn't on this account.`);
      if (row.reconciled) throw new ConflictError(`Journal #${row.journal_id} is already reconciled with another statement line.`);
      if (daysBetween(row.posting_date, line.date) > MATCH_WINDOW_DAYS) {
        throw new ValidationError(`Journal #${row.journal_id} (${row.posting_date}) is more than ${MATCH_WINDOW_DAYS} days from the line's date.`);
      }
    }
    const total = rows.reduce((sum, row) => sum + cents(row.amount), BigInt(0));
    const difference = cents(line.amount) - total;
    if (adjustment) {
      assertAdjustable(adjustment, difference, "The chosen transactions");
      journalLineIds.push(await postAdjustment(tx, line, adjustment, difference, null, { source, idempotencyKey: subKey("adjustment") }));
    } else if (difference !== BigInt(0)) {
      throw new ValidationError(`The chosen transactions add up to ${formatCents(total)}, but the line is ${line.amount}.`);
    }
  } else if (kind === "payments") {
    const allocations = requireArray(command.allocations, "allocations", 100).map((raw, index) => {
      const entry = asRecord(raw, `Allocation ${index + 1}`);
      const amount = parseDecimalInput(entry.amount, `Allocation ${index + 1} amount`, { maxScale: 2 });
      if (moneyIn) return { invoiceId: requireId(entry.invoiceId, `Allocation ${index + 1} invoiceId`), amount };
      return { billId: requireId(entry.billId, `Allocation ${index + 1} billId`), amount };
    });
    if (allocations.length === 0) throw new ValidationError(`Choose at least one ${moneyIn ? "invoice" : "bill"} to pay.`);
    const total = allocations.reduce((sum, entry) => sum + cents(entry.amount), BigInt(0));
    // Signed like the line: money in pays invoices, money out pays bills.
    const difference = cents(line.amount) - (moneyIn ? total : -total);
    if (adjustment) {
      assertAdjustable(adjustment, difference, "The payments");
    } else if (difference !== BigInt(0)) {
      throw new ValidationError(`The payments add up to ${formatCents(total)}, but the line is ${unsigned}. They must add up to the line.`);
    }
    const reference = (line.reference ?? line.particulars ?? line.payee ?? undefined)?.slice(0, 100);
    journalLineIds = [];
    for (const [index, allocation] of allocations.entries()) {
      const payment =
        "invoiceId" in allocation
          ? (
              await recordPayment(tx, allocation.invoiceId, {
                source,
                idempotencyKey: subKey(`payment:${index}`),
                paymentDate: line.date,
                amount: allocation.amount,
                bankAccountCode: account.code,
                reference,
              })
            ).payment
          : (
              await recordSupplierPayment(tx, allocation.billId, {
                source,
                idempotencyKey: subKey(`payment:${index}`),
                paymentDate: line.date,
                amount: allocation.amount,
                bankAccountCode: account.code,
                reference,
              })
            ).payment;
      journalLineIds.push(await journalLineOn(tx, payment.journalId, line.accountId));
    }
    if (adjustment) {
      const first = allocations[0];
      const contact = await tx.query<{ contact_id: string }>(
        "invoiceId" in first ? "select contact_id from sales_invoices where id = $1" : "select contact_id from bills where id = $1",
        ["invoiceId" in first ? first.invoiceId : first.billId],
      );
      journalLineIds.push(
        await postAdjustment(tx, line, adjustment, difference, contact.rows[0]?.contact_id ?? null, { source, idempotencyKey: subKey("adjustment") }),
      );
    }
  } else if (kind === "bank_transaction") {
    const { bankTransaction } = await createBankTransaction(
      tx,
      {
        source,
        idempotencyKey: subKey("bank_transaction"),
        kind: moneyIn ? "receive" : "spend",
        accountId: line.accountId,
        contactId: command.contactId,
        date: line.date,
        reference: command.reference ?? (line.reference ?? line.particulars ?? undefined),
        amountsMode: command.amountsMode,
        lines: command.lines,
        customFields: command.customFields,
      },
      { expectedTotal: unsigned },
    );
    journalLineIds = [await journalLineOn(tx, bankTransaction.journalId, line.accountId)];
  } else {
    const other = requireString(command.otherAccountCode, "otherAccountCode", { maxLength: 20 });
    const { transfer } = await createTransfer(tx, {
      source,
      idempotencyKey: subKey("transfer"),
      fromAccountCode: moneyIn ? other : account.code,
      toAccountCode: moneyIn ? account.code : other,
      date: line.date,
      amount: unsigned,
      reference: command.reference ?? line.reference ?? undefined,
    });
    journalLineIds = [await journalLineOn(tx, transfer.journalId, line.accountId)];
  }

  let inserted;
  try {
    inserted = await tx.query<{ id: string }>(
      `insert into bank_reconciliations (command_source, idempotency_key, request_hash, statement_line_id, kind,
                                         created_by_user_id, created_by_email)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [source, idempotencyKey, hash, lineId, kind, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ConflictError("That idempotency key was already used for a different reconciliation.");
    }
    throw error;
  }
  const reconciliationId = inserted.rows[0].id;
  await tx.query(
    `insert into bank_reconciliation_items (reconciliation_id, journal_line_id, amount)
     select $1, l.id, l.debit_amount - l.credit_amount from ledger_journal_lines l where l.id = any($2::bigint[])`,
    [reconciliationId, journalLineIds],
  );
  await tx.query("update bank_statement_lines set status = 'reconciled', updated_at = now() where id = $1", [lineId]);
  await writeAuditEvent(tx, {
    eventType: "statement_line.reconciled",
    entityType: "bank_statement_line",
    entityId: lineId,
    details: { kind, reconciliationId, journalLineIds, amount: line.amount, date: line.date, adjusted: adjustment !== null },
  });
  return { created: true, line: await getStatementLine(tx, lineId) };
}

/**
 * Unreconciles a line (example BK11): the line is unreconciled again and
 * nothing is posted or voided. Refused in a locked period (BK13).
 */
export async function unreconcileStatementLine(
  tx: OrgTx,
  lineIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown },
): Promise<ReconcileResult> {
  const lineId = requireId(lineIdInput, "lineId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const hash = requestHash("bank_unreconciliation", { lineId });
  const replay = async (): Promise<ReconcileResult | null> => {
    const earlier = await tx.query<{ statement_line_id: string; removal_request_hash: string }>(
      "select statement_line_id, removal_request_hash from bank_reconciliations where removal_command_source = $1 and removal_idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].removal_request_hash, hash, "unreconciliation");
    return { created: false, line: await getStatementLine(tx, earlier.rows[0].statement_line_id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const line = await lockStatementLine(tx, lineId);
  const committedMeanwhile = await replay();
  if (committedMeanwhile) return committedMeanwhile;
  if (line.status !== "reconciled" || !line.reconciliation) throw new ConflictError("This line isn't reconciled.");
  await assertPostingDateAllowed(tx, line.date);
  try {
    await tx.query(
      `update bank_reconciliations
          set status = 'removed', removal_command_source = $2, removal_idempotency_key = $3, removal_request_hash = $4,
              removed_by_user_id = $5, removed_by_email = $6, removed_at = now()
        where id = $1`,
      [line.reconciliation.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ConflictError("That idempotency key was already used for a different unreconciliation.");
    }
    throw error;
  }
  await tx.query("update bank_statement_lines set status = 'unreconciled', updated_at = now() where id = $1", [lineId]);
  await writeAuditEvent(tx, {
    eventType: "statement_line.unreconciled",
    entityType: "bank_statement_line",
    entityId: lineId,
    details: { reconciliationId: line.reconciliation.id },
  });
  return { created: true, line: await getStatementLine(tx, lineId) };
}

export type MatchCandidate = {
  journalLineId: string;
  journalId: string;
  amount: string;
  postingDate: string;
  origin: string;
  reference: string;
  description: string | null;
  exact: boolean;
};

export type LineSuggestions = {
  matches: MatchCandidate[];
  documents: Array<{ kind: "invoice" | "bill"; id: string; number: string; contactName: string; amountDue: string; date: string }>;
  rule: (BankRule & { suggestedLine: { description: string; accountCode: string; taxCode: string | null; amount: string } }) | null;
};

/**
 * What a line could be reconciled with: unreconciled journal lines on its
 * account within the match window (same amount first), open invoices or bills
 * for its exact amount, and the first bank rule that applies.
 */
export async function suggestionsForLine(tx: OrgTx, lineIdInput: unknown, rules?: BankRule[]): Promise<LineSuggestions> {
  const line = await getStatementLine(tx, lineIdInput);
  const moneyIn = !line.amount.startsWith("-");
  const candidates = await tx.query<CandidateRow>(
    `select l.id, l.journal_id, l.account_id, (l.debit_amount - l.credit_amount)::text as amount, j.posting_date::text,
            j.origin, j.reference, j.description, l.description as line_description, false as reconciled
       from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
      where l.account_id = $1
        and ((l.debit_amount > 0) = $2)
        and j.posting_date between $3::date - $4::integer and $3::date + $4::integer
        and not exists (select 1 from bank_reconciliation_items i where i.journal_line_id = l.id and i.active)
      order by (l.debit_amount - l.credit_amount) = $5::numeric desc, abs(j.posting_date - $3::date), l.id
      limit 25`,
    [line.accountId, moneyIn, line.date, MATCH_WINDOW_DAYS, line.amount],
  );
  const documents = moneyIn
    ? await tx.query<{ id: string; number: string; contact_name: string; amount_due: string; date: string }>(
        `select i.id, i.invoice_number as number, c.name as contact_name, i.invoice_date::text as date,
                (i.total - coalesce((select sum(p.amount - p.overpayment_amount) from customer_payments p where p.invoice_id = i.id and p.status = 'active'), 0)
                         - coalesce((select sum(a.amount) from sales_credit_note_applications a where a.invoice_id = i.id and a.status = 'active'), 0)
                         - coalesce((select sum(o.amount) from customer_overpayment_applications o where o.invoice_id = i.id and o.status = 'active'), 0))::text as amount_due
           from sales_invoices i join contacts c on c.id = i.contact_id
          where i.status = 'approved'
          order by i.invoice_date, i.id`,
      )
    : await tx.query<{ id: string; number: string; contact_name: string; amount_due: string; date: string }>(
        `select b.id, b.supplier_invoice_number as number, c.name as contact_name, b.bill_date::text as date,
                (b.total - coalesce((select sum(p.amount) from supplier_payments p where p.bill_id = b.id and p.status = 'active'), 0)
                         - coalesce((select sum(a.amount) from supplier_credit_note_applications a where a.bill_id = b.id and a.status = 'active'), 0))::text as amount_due
           from bills b join contacts c on c.id = b.contact_id
          where b.status = 'approved'
          order by b.bill_date, b.id`,
      );
  const unsigned = line.amount.replace(/^-/, "");
  const exactDocuments = documents.rows
    .filter((row) => toFixedString(dec(row.amount_due), 2) === unsigned)
    .slice(0, 10)
    .map((row) => ({
      kind: moneyIn ? ("invoice" as const) : ("bill" as const),
      id: row.id,
      number: row.number,
      contactName: row.contact_name,
      amountDue: toFixedString(dec(row.amount_due), 2),
      date: row.date,
    }));
  const allRules = rules ?? (await listBankRules(tx, { activeOnly: true }));
  const rule = allRules.find((candidate) => ruleMatches(candidate, line)) ?? null;
  return {
    matches: candidates.rows.map((row) => ({
      journalLineId: row.id,
      journalId: row.journal_id,
      amount: toFixedString(dec(row.amount), 2),
      postingDate: row.posting_date,
      origin: row.origin,
      reference: row.reference,
      description: row.line_description ?? row.description,
      exact: toFixedString(dec(row.amount), 2) === line.amount,
    })),
    documents: exactDocuments,
    rule: rule
      ? {
          ...rule,
          suggestedLine: {
            description: rule.lineDescription ?? line.description,
            accountCode: rule.targetAccountCode,
            taxCode: rule.amountsMode === "no_tax" ? null : rule.taxCode,
            amount: unsigned,
          },
        }
      : null,
  };
}

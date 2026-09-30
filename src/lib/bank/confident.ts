import { getStatementLine, lockStatementLine, type StatementLine } from "@/lib/bank/accounts";
import { assertBulkKey, eachLine, type BulkResult } from "@/lib/bank/bulk";
import { MATCH_WINDOW_DAYS, reconcileStatementLine } from "@/lib/bank/reconcile";
import { listBankRules, ruleMatches } from "@/lib/bank/rules";
import type { OrgRunner, OrgTx } from "@/lib/db/org-transaction";
import { ConflictError } from "@/lib/errors";
import { defaultRates, lastRateOnOrBefore } from "@/lib/ledger/foreign";
import { dec, toFixedString } from "@/lib/money/decimal";
import { asRecord, optionalSource, optionalString, requireArray, requireId, requireIdempotencyKey } from "@/lib/validation";

/**
 * One-click matching (examples BK17-BK19), like Xero's "OK". For each
 * unreconciled line on an account, a suggestion is **confident** when:
 *
 * - exactly one candidate has the line's exact amount: a posted journal line
 *   on the account (same sign, not reconciled, within 60 days of the line,
 *   not a reversal and not reversed), or an approved invoice (money in) or
 *   bill (money out) whose amount due is the line's amount and which is dated
 *   on or before the line; and
 * - no other unreconciled line on the account has that same candidate (two
 *   lines competing for one candidate show no one-click match), or
 * - there's no candidate at all and a bank rule applies to the line.
 *
 * Two or more candidates for a line (a tie) show no one-click match either;
 * they're listed on the line to choose from. "OK" posts through the same
 * reconcile command as choosing it by hand.
 */
export type ConfidentSuggestion =
  | {
      kind: "match";
      key: string;
      journalLineId: string;
      journalId: string;
      postingDate: string;
      origin: string;
      reference: string;
      description: string | null;
      amount: string;
    }
  | {
      kind: "payment";
      key: string;
      documentKind: "invoice" | "bill";
      documentId: string;
      number: string;
      contactName: string;
      date: string;
      amountDue: string;
    }
  | {
      kind: "rule";
      key: string;
      ruleId: string;
      ruleName: string;
      contactId: string;
      contactName: string;
      accountCode: string;
      accountName: string;
      taxCode: string | null;
      amountsMode: string;
      description: string;
      /** For a foreign-currency line: the rate it'll be converted at (the last one used, D4). */
      exchangeRate: string | null;
    };

export type LineConfidence = {
  lineId: string;
  /** The one-click suggestion, or null. */
  suggestion: ConfidentSuggestion | null;
  /** How many exact-amount candidates the line has. */
  candidateCount: number;
  /** True when the line's only candidate is also another line's candidate. */
  competing: boolean;
};

type LineRow = {
  id: string;
  account_id: string;
  line_date: string;
  amount: string;
  description: string;
  payee: string | null;
  particulars: string | null;
  code: string | null;
  reference: string | null;
  currency_code: string | null;
};

const money = (value: string) => toFixedString(dec(value), 2);

/** Every unreconciled line on the account with its confident suggestion (or why there's none), oldest first. */
export async function confidentMatches(tx: OrgTx, accountIdInput: unknown): Promise<LineConfidence[]> {
  const accountId = requireId(accountIdInput, "accountId");
  const lines = (
    await tx.query<LineRow>(
      `select id, account_id, line_date::text, amount::text, description, payee, particulars, code, reference, currency_code
         from bank_statement_lines where account_id = $1 and status = 'unreconciled' order by line_date, id`,
      [accountId],
    )
  ).rows;
  if (lines.length === 0) return [];

  const journalCandidates = await tx.query<{
    line_id: string;
    journal_line_id: string;
    journal_id: string;
    posting_date: string;
    origin: string;
    reference: string;
    description: string | null;
    amount: string;
  }>(
    `select b.id as line_id, l.id as journal_line_id, l.journal_id, j.posting_date::text, j.origin, j.reference,
            coalesce(l.description, j.description) as description, l.account_amount::text as amount
       from bank_statement_lines b
       -- In the account's currency (FXB6); lines kept only in the base currency never match a foreign-currency line.
       join ledger_journal_lines l on l.account_id = b.account_id and l.account_amount = b.amount
        and (l.foreign_amount is not null or coalesce(b.currency_code, $3) = $3)
       join ledger_journals j on j.id = l.journal_id
      where b.account_id = $1 and b.status = 'unreconciled'
        and j.posting_date between b.line_date - $2::integer and b.line_date + $2::integer
        and j.correction_kind is distinct from 'reversal'
        and j.origin <> 'opening_balance'
        and not exists (select 1 from ledger_journals r where r.related_journal_id = j.id and r.correction_kind = 'reversal')
        and not exists (select 1 from bank_reconciliation_items i where i.journal_line_id = l.id and i.active)
      order by b.id, j.posting_date, l.id`,
    [accountId, MATCH_WINDOW_DAYS, tx.baseCurrency],
  );
  const documentCandidates = await tx.query<{
    line_id: string;
    document_kind: "invoice" | "bill";
    id: string;
    number: string;
    contact_name: string;
    date: string;
    amount_due: string;
  }>(
    // Invoices and bills are in the base currency, so never for a foreign-currency line (FXB9).
    `with lines as (
       select id, amount, line_date from bank_statement_lines
        where account_id = $1 and status = 'unreconciled' and coalesce(currency_code, $2) = $2
     ),
     invoices_due as (
       select i.id, i.invoice_number as number, c.name as contact_name, i.invoice_date as date,
              i.total - coalesce((select sum(p.amount - p.overpayment_amount) from customer_payments p where p.invoice_id = i.id and p.status = 'active'), 0)
                      - coalesce((select sum(a.amount) from sales_credit_note_applications a where a.invoice_id = i.id and a.status = 'active'), 0)
                      - coalesce((select sum(o.amount) from customer_overpayment_applications o where o.invoice_id = i.id and o.status = 'active'), 0)
                as amount_due
         from sales_invoices i join contacts c on c.id = i.contact_id
        where i.status = 'approved' and i.currency_code = $2
     ),
     bills_due as (
       select b.id, b.supplier_invoice_number as number, c.name as contact_name, b.bill_date as date,
              b.total - coalesce((select sum(p.amount) from supplier_payments p where p.bill_id = b.id and p.status = 'active'), 0)
                      - coalesce((select sum(a.amount) from supplier_credit_note_applications a where a.bill_id = b.id and a.status = 'active'), 0)
                as amount_due
         from bills b join contacts c on c.id = b.contact_id
        where b.status = 'approved' and b.currency_code = $2
     )
     select l.id as line_id, 'invoice' as document_kind, d.id, d.number, d.contact_name, d.date::text, d.amount_due::text
       from lines l join invoices_due d on l.amount > 0 and d.amount_due = l.amount and d.date <= l.line_date
     union all
     select l.id, 'bill', d.id, d.number, d.contact_name, d.date::text, d.amount_due::text
       from lines l join bills_due d on l.amount < 0 and d.amount_due = -l.amount and d.date <= l.line_date
     order by 1, 6, 3`,
    [accountId, tx.baseCurrency],
  );

  const candidates = new Map<string, ConfidentSuggestion[]>();
  const add = (lineId: string, suggestion: ConfidentSuggestion) => candidates.set(lineId, [...(candidates.get(lineId) ?? []), suggestion]);
  for (const row of journalCandidates.rows) {
    add(row.line_id, {
      kind: "match",
      key: `match:${row.journal_line_id}`,
      journalLineId: row.journal_line_id,
      journalId: row.journal_id,
      postingDate: row.posting_date,
      origin: row.origin,
      reference: row.reference,
      description: row.description,
      amount: money(row.amount),
    });
  }
  for (const row of documentCandidates.rows) {
    add(row.line_id, {
      kind: "payment",
      key: `${row.document_kind}:${row.id}`,
      documentKind: row.document_kind,
      documentId: row.id,
      number: row.number,
      contactName: row.contact_name,
      date: row.date,
      amountDue: money(row.amount_due),
    });
  }
  const uses = new Map<string, number>();
  for (const list of candidates.values()) {
    for (const candidate of list) uses.set(candidate.key, (uses.get(candidate.key) ?? 0) + 1);
  }
  const rules = await listBankRules(tx, { activeOnly: true });
  const rates = await defaultRates(tx, lines.map((row) => row.currency_code ?? tx.baseCurrency));
  return lines.map((row): LineConfidence => {
    const list = candidates.get(row.id) ?? [];
    if (list.length === 1) {
      const competing = (uses.get(list[0].key) ?? 0) > 1;
      return { lineId: row.id, suggestion: competing ? null : list[0], candidateCount: 1, competing };
    }
    if (list.length > 1) return { lineId: row.id, suggestion: null, candidateCount: list.length, competing: false };
    const line = { accountId: row.account_id, amount: money(row.amount), description: row.description, payee: row.payee, particulars: row.particulars, code: row.code, reference: row.reference };
    const matched = rules.find((candidate) => ruleMatches(candidate, line));
    // A foreign-currency line is converted at the last rate used (D4); with none, a rule isn't confident.
    const foreign = row.currency_code !== null && row.currency_code !== tx.baseCurrency;
    const rate = foreign ? lastRateOnOrBefore(rates.get(row.currency_code!), row.line_date)?.rate ?? null : null;
    const rule = foreign && rate === null ? undefined : matched;
    return {
      lineId: row.id,
      suggestion: rule
        ? {
            kind: "rule",
            key: rate === null ? `rule:${rule.id}` : `rule:${rule.id}@${rate}`,
            ruleId: rule.id,
            ruleName: rule.name,
            contactId: rule.contactId,
            contactName: rule.contactName,
            accountCode: rule.targetAccountCode,
            accountName: rule.targetAccountName,
            taxCode: rule.amountsMode === "no_tax" ? null : rule.taxCode,
            amountsMode: rule.amountsMode,
            description: rule.lineDescription ?? row.description,
            exchangeRate: rate,
          }
        : null,
      candidateCount: 0,
      competing: false,
    };
  });
}

/** The reconcile command a confident suggestion stands for. */
function commandFor(suggestion: ConfidentSuggestion, line: StatementLine): Record<string, unknown> {
  const unsigned = line.amount.replace(/^-/, "");
  if (suggestion.kind === "match") return { kind: "match", journalLineIds: [suggestion.journalLineId] };
  if (suggestion.kind === "payment") {
    const key = suggestion.documentKind === "invoice" ? "invoiceId" : "billId";
    return { kind: "payments", allocations: [{ [key]: suggestion.documentId, amount: unsigned }] };
  }
  return {
    kind: "bank_transaction",
    ...(suggestion.exchangeRate ? { exchangeRate: suggestion.exchangeRate } : {}),
    contactId: suggestion.contactId,
    amountsMode: suggestion.amountsMode,
    lines: [{ description: suggestion.description, accountCode: suggestion.accountCode, taxCode: suggestion.taxCode ?? undefined, amount: unsigned }],
  };
}

type OkResult = { created: boolean; line: StatementLine };

/**
 * "OK" on one line (example BK18): reconciles it with its confident
 * suggestion, worked out again now. `expect` is the suggestion's key as it
 * was shown; if the suggestion has changed since, nothing is done. A retry
 * with the same idempotency key returns the line as reconciled then.
 */
export async function okStatementLine(
  tx: OrgTx,
  lineIdInput: unknown,
  command: { source?: unknown; idempotencyKey?: unknown; expect?: unknown },
): Promise<OkResult> {
  const lineId = requireId(lineIdInput, "lineId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const expect = optionalString(command.expect, "expect", { maxLength: 100 });
  const replay = async (): Promise<OkResult | null> => {
    const earlier = await tx.query<{ statement_line_id: string }>(
      "select statement_line_id from bank_reconciliations where command_source = $1 and idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    if (earlier.rows[0].statement_line_id !== lineId) {
      throw new ConflictError("That idempotency key was already used for a different reconciliation.");
    }
    return { created: false, line: await getStatementLine(tx, lineId) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const line = await lockStatementLine(tx, lineId);
  const committedMeanwhile = await replay();
  if (committedMeanwhile) return committedMeanwhile;
  if (line.status !== "unreconciled") throw new ConflictError(`This line is ${line.status}, so there's nothing to OK.`);
  const suggestion = (await confidentMatches(tx, line.accountId)).find((entry) => entry.lineId === lineId)?.suggestion ?? null;
  if (!suggestion) throw new ConflictError("There's no confident match for this line now. Open it to choose what it is.");
  if (expect && expect !== suggestion.key) {
    throw new ConflictError("The suggestion for this line has changed since it was shown. Reload the list to see the new one.");
  }
  const result = await reconcileStatementLine(tx, lineId, { ...commandFor(suggestion, line), source, idempotencyKey });
  if (suggestion.kind === "payment" && suggestion.documentKind === "invoice") {
    // The invoice was checked before its payment locked it; if it was paid meanwhile, don't leave an overpayment.
    const journalIds = (result.line.reconciliation?.items ?? []).map((item) => item.journalId);
    const overpaid = await tx.query("select 1 from customer_payments where journal_id = any($1::bigint[]) and overpayment_amount <> 0", [
      journalIds,
    ]);
    if ((overpaid.rowCount ?? 0) > 0) {
      throw new ConflictError("The invoice was paid meanwhile, so this line no longer matches it. Reload the list.");
    }
  }
  return result;
}

/**
 * "OK all confident matches" (example BK19): OKs each line in its own
 * transaction. `items` are the lines and suggestion keys as shown; without
 * them, every line confident now is OKed. Each line's idempotency key is the
 * request's key and the line id, so retrying the request replays the lines
 * already done.
 */
export async function okConfidentMatches(
  run: OrgRunner,
  accountIdInput: unknown,
  command: { source?: unknown; idempotencyKey?: unknown; items?: unknown },
): Promise<BulkResult> {
  const accountId = requireId(accountIdInput, "accountId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  assertBulkKey(idempotencyKey);
  const items =
    command.items == null
      ? (await run((tx) => confidentMatches(tx, accountId)))
          .filter((entry) => entry.suggestion)
          .map((entry) => ({ lineId: entry.lineId, expect: entry.suggestion!.key }))
      : requireArray(command.items, "items", 500).map((raw, index) => {
          const entry = asRecord(raw, `Item ${index + 1}`);
          return {
            lineId: requireId(entry.lineId, `Item ${index + 1} lineId`),
            expect: optionalString(entry.expect, `Item ${index + 1} expect`, { maxLength: 100 }),
          };
        });
  const unique = [...new Map(items.map((item) => [item.lineId, item])).values()];
  return eachLine(run, unique, async (tx, item) => {
    const line = await getStatementLine(tx, item.lineId);
    if (line.accountId !== accountId) throw new ConflictError("This line is on another account.");
    return okStatementLine(tx, item.lineId, { source, idempotencyKey: `${idempotencyKey}:${item.lineId}`, expect: item.expect });
  });
}

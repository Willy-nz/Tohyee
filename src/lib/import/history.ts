import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import type { ImportRecord } from "@/lib/import/fields";
import { MAX_HISTORY_ROWS } from "@/lib/import/read";
import { isRowProblem, parseOptions, parseRecords, problemMessage, type RowProblem, saveMapping } from "@/lib/import/service";
import { date, money } from "@/lib/import/values";
import { parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { getPeriodControls } from "@/lib/ledger/period-controls";
import { add, cmp, dec, type Decimal, isNegative, isZero, neg, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { optionalString, requireIdempotencyKey, requireString } from "@/lib/validation";

/*
 * A general ledger from another system brought in as history (examples
 * IM22-IM28; as NetSuite's journal import does, not yet reviewed). Rows
 * with the same date and ID# are one journal, posted with origin "history"
 * (left out of the journal list unless asked for). Every journal must
 * balance, every account exist, and every date be after the opening
 * balances and outside locked periods, or nothing is posted. Lines have no
 * GST codes: GST returns for those periods were filed from the old system.
 */

const MAX_JOURNAL_LINES = 500;

export type HistorySummary = {
  journals: number;
  lines: number;
  from: string | null;
  to: string | null;
  debits: string;
  credits: string;
  /** Rows with no date that aren't account headings: beginning balances, totals (IM24). */
  skipped: number;
};

export type HistoryResult = {
  ok: boolean;
  committed: boolean;
  problems: RowProblem[];
  summary: HistorySummary;
  importId: string | null;
};

type HistoryLine = { row: number; accountCode: string; amount: Decimal; memo: string | null };
type HistoryJournal = { date: string; reference: string; lines: HistoryLine[] };

const val = (record: ImportRecord, field: string) => (record.values[field] ?? "").trim();

/** "6400", "6400 Feed", "Feed (6400)" or MYOB's "6-1100 Feed" -> the code. */
function codeOf(record: ImportRecord): string | null {
  const code = val(record, "accountCode");
  if (code) return code;
  const text = val(record, "account");
  if (!text) return null;
  const bracketed = /\(([A-Za-z0-9][A-Za-z0-9._-]{0,19})\)\s*$/.exec(text);
  if (bracketed) return bracketed[1];
  const leading = /^([A-Za-z0-9][A-Za-z0-9._-]{0,19})(?:\s|$)/.exec(text);
  return leading ? leading[1] : text;
}

function amountOf(record: ImportRecord): Decimal | null {
  const debit = val(record, "debit");
  const credit = val(record, "credit");
  const amount = val(record, "amount");
  if (!debit && !credit && !amount) return null;
  if (amount && !debit && !credit) return dec(money(amount, "Amount") ?? "0");
  return sub(dec(debit ? (money(debit, "Debit") ?? "0") : "0"), dec(credit ? (money(credit, "Credit") ?? "0") : "0"));
}

const cents = (value: Decimal) => toFixedString(value, 2);

function rowsText(lines: HistoryLine[]): string {
  const first = Math.min(...lines.map((line) => line.row));
  const last = Math.max(...lines.map((line) => line.row));
  return first === last ? `row ${first}` : `rows ${first}-${last}`;
}

function parseInput(input: Record<string, unknown>) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const fileName = requireString(input.fileName, "fileName", { maxLength: 255 });
  const records = parseRecords(input.records, "records", MAX_HISTORY_ROWS);
  const options = parseOptions(input.options);
  return { idempotencyKey, fileName, records, options, hash: requestHash("history_import", { fileName, records, options }) };
}

/** Reads the rows into journals, with every problem found (IM22-IM25). */
async function plan(tx: OrgTx, parsed: ReturnType<typeof parseInput>): Promise<{ journals: HistoryJournal[]; problems: RowProblem[]; summary: HistorySummary }> {
  const problems: RowProblem[] = [];
  const problem = (row: number, message: string) => problems.push({ row, message, kind: "general_ledger" });
  const groups = new Map<string, HistoryJournal>();
  let heading: string | null = null;
  let skipped = 0;
  for (const record of parsed.records) {
    const dateText = val(record, "date");
    if (!dateText) {
      // A row with only an account is a heading for the rows under it (MYOB's layout, IM24).
      const code = codeOf(record);
      if (code && amountOf(record) === null) heading = code;
      else skipped += 1;
      continue;
    }
    try {
      const posting = date(dateText, "Date", parsed.options.dateOrder);
      // Two columns can make the reference (MYOB's Src and ID#): joined with a space.
      const reference = val(record, "reference").split(/\s*\n\s*/).filter(Boolean).join(" ");
      if (!reference) throw new ValidationError(`Row ${record.row} needs an ID# or reference: rows with the same date and ID# are one transaction.`);
      if (reference.length > 100) throw new ValidationError(`Row ${record.row} has an ID# longer than 100 characters.`);
      const amount = amountOf(record);
      if (amount === null || isZero(amount)) {
        skipped += 1;
        continue;
      }
      const accountCode = codeOf(record) ?? heading;
      if (!accountCode) throw new ValidationError(`Row ${record.row} has no account: map the account column, or put the account in a heading row above it.`);
      const groupKey = `${posting}|${reference.toLowerCase()}`;
      const group = groups.get(groupKey) ?? { date: posting, reference, lines: [] };
      group.lines.push({ row: record.row, accountCode, amount, memo: val(record, "memo") || null });
      groups.set(groupKey, group);
    } catch (error) {
      if (!isRowProblem(error)) throw error;
      problem(record.row, problemMessage(error));
    }
  }
  const journals = [...groups.values()];

  // Accounts must exist; history doesn't create them (IM25).
  const codes = [...new Set(journals.flatMap((journal) => journal.lines.map((line) => line.accountCode.toLowerCase())))];
  const known = new Map(
    (await tx.query<{ code: string }>("select code from accounts where lower(code) = any($1::text[])", [codes])).rows.map((row) => [row.code.toLowerCase(), row.code]),
  );
  for (const journal of journals) {
    for (const line of journal.lines) {
      const found = known.get(line.accountCode.toLowerCase());
      if (found) line.accountCode = found;
      else problem(line.row, `There's no account ${line.accountCode}. Bring in the chart of accounts first.`);
    }
  }

  const conversion = (await tx.query<{ conversion_date: string }>("select conversion_date::text from conversion_balances where id = true")).rows[0]?.conversion_date ?? null;
  const { lockDate } = await getPeriodControls(tx);
  const already = await tx.query<{ posting_date: string; reference_key: string; file_name: string }>(
    `select j.posting_date::text, j.reference_key, i.file_name from history_import_journals j join history_imports i on i.id = j.history_import_id
      where (j.posting_date, j.reference_key) in (select * from unnest($1::date[], $2::text[]))`,
    [journals.map((journal) => journal.date), journals.map((journal) => journal.reference.toLowerCase())],
  );
  const imported = new Map(already.rows.map((row) => [`${row.posting_date}|${row.reference_key}`, row.file_name]));

  let debits = ZERO_DECIMAL;
  let credits = ZERO_DECIMAL;
  let lineCount = 0;
  for (const journal of journals) {
    const firstRow = Math.min(...journal.lines.map((line) => line.row));
    const named = `${journal.reference} on ${formatDate(journal.date)}`;
    const debit = journal.lines.filter((line) => !isNegative(line.amount)).reduce((total, line) => add(total, line.amount), ZERO_DECIMAL);
    const credit = journal.lines.filter((line) => isNegative(line.amount)).reduce((total, line) => add(total, neg(line.amount)), ZERO_DECIMAL);
    debits = add(debits, debit);
    credits = add(credits, credit);
    lineCount += journal.lines.length;
    if (cmp(debit, credit) !== 0) {
      const gap = sub(debit, credit);
      problem(firstRow, `${named} (${rowsText(journal.lines)}) is out by ${cents(isNegative(gap) ? neg(gap) : gap)}: debits ${cents(debit)}, credits ${cents(credit)}.`);
    } else if (journal.lines.length < 2) {
      problem(firstRow, `${named} has only one line.`);
    }
    if (journal.lines.length > MAX_JOURNAL_LINES) problem(firstRow, `${named} has more than ${MAX_JOURNAL_LINES} lines.`);
    if (conversion && journal.date <= conversion) {
      problem(firstRow, `${journal.reference} is dated ${formatDate(journal.date)}, on or before the opening balances (${formatDate(conversion)}): it's in them already.`);
    } else if (lockDate && journal.date <= lockDate) {
      problem(firstRow, `${named} is in a locked period (locked up to ${formatDate(lockDate)}).`);
    }
    const before = imported.get(`${journal.date}|${journal.reference.toLowerCase()}`);
    if (before) problem(firstRow, `${named} was already imported (${before}).`);
  }
  problems.sort((a, b) => a.row - b.row);
  const dates = journals.map((journal) => journal.date).sort();
  return {
    journals,
    problems,
    summary: { journals: journals.length, lines: lineCount, from: dates[0] ?? null, to: dates[dates.length - 1] ?? null, debits: cents(debits), credits: cents(credits), skipped },
  };
}

/**
 * Checks (`commit` false) or posts (`commit` true) a general ledger file as
 * history, all or nothing. A retry with the same key and rows returns the
 * first result; the same key with other rows is refused (IM26).
 */
export async function importHistory(tx: OrgTx, input: Record<string, unknown>, commit: boolean): Promise<HistoryResult> {
  const parsed = parseInput(input);
  const done = (
    await tx.query<{ id: string; request_hash: string; journal_count: number; line_count: number; from_date: string; to_date: string; total_debit: string; skipped_rows: number }>(
      "select id::text, request_hash, journal_count, line_count, from_date::text, to_date::text, total_debit::text, skipped_rows from history_imports where idempotency_key = $1",
      [parsed.idempotencyKey],
    )
  ).rows[0];
  if (done) {
    assertSameRequest(done.request_hash, parsed.hash, "general ledger import");
    return {
      ok: true,
      committed: true,
      problems: [],
      summary: { journals: done.journal_count, lines: done.line_count, from: done.from_date, to: done.to_date, debits: done.total_debit, credits: done.total_debit, skipped: done.skipped_rows },
      importId: done.id,
    };
  }
  const planned = await plan(tx, parsed);
  if (planned.journals.length === 0 && planned.problems.length === 0) {
    planned.problems.push({ row: 0, message: "There are no transactions in the file: check the date and amount columns are mapped.", kind: "general_ledger" });
  }
  if (planned.problems.length > 0 || !commit) {
    return { ok: planned.problems.length === 0, committed: false, problems: planned.problems, summary: planned.summary, importId: null };
  }

  await tx.query("savepoint history_import");
  const problems: RowProblem[] = [];
  let importId: string | null = null;
  try {
    importId = (
      await tx.query<{ id: string }>(
        `insert into history_imports (idempotency_key, request_hash, file_name, from_date, to_date, journal_count, line_count, total_debit, skipped_rows, created_by_email)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id::text`,
        [
          parsed.idempotencyKey,
          parsed.hash,
          parsed.fileName,
          planned.summary.from,
          planned.summary.to,
          planned.summary.journals,
          planned.summary.lines,
          planned.summary.debits,
          planned.summary.skipped,
          tx.actor.email,
        ],
      )
    ).rows[0].id;
    for (const [index, journal] of planned.journals.entries()) {
      try {
        const body = parseJournalBody(tx, {
          postingDate: journal.date,
          reference: journal.reference,
          description: optionalString(journal.lines.find((line) => line.memo)?.memo?.slice(0, 500), "description", { maxLength: 500 }),
          lines: journal.lines.map((line) => ({
            accountCode: line.accountCode,
            debitAmount: isNegative(line.amount) ? "0" : cents(line.amount),
            creditAmount: isNegative(line.amount) ? cents(neg(line.amount)) : "0",
            description: line.memo?.slice(0, 500) ?? null,
          })),
        });
        const posted = await postJournalBody(tx, "import", `history-${importId}-${index + 1}`, body, { origin: "history" });
        await tx.query("insert into history_import_journals (journal_id, history_import_id, posting_date, reference_key) values ($1, $2, $3, $4)", [
          posted.journal.id,
          importId,
          journal.date,
          journal.reference.toLowerCase(),
        ]);
      } catch (error) {
        if (!isRowProblem(error)) throw error;
        const firstRow = Math.min(...journal.lines.map((line) => line.row));
        problems.push({ row: firstRow, message: `${journal.reference} on ${formatDate(journal.date)}: ${problemMessage(error)}`, kind: "general_ledger" });
        break;
      }
    }
  } catch (error) {
    if (!isRowProblem(error)) throw error;
    problems.push({ row: 0, message: problemMessage(error), kind: "general_ledger" });
  }
  if (problems.length > 0) {
    await tx.query("rollback to savepoint history_import");
    await tx.query("release savepoint history_import");
    return { ok: false, committed: false, problems, summary: planned.summary, importId: null };
  }
  await tx.query("release savepoint history_import");
  if (input.mapping !== undefined) await saveMapping(tx, "general_ledger", input.mapping);
  await writeAuditEvent(tx, {
    eventType: "import.history",
    entityType: "history_import",
    entityId: importId!,
    details: { fileName: parsed.fileName, journals: planned.summary.journals, lines: planned.summary.lines, from: planned.summary.from, to: planned.summary.to },
  });
  return { ok: true, committed: true, problems: [], summary: planned.summary, importId };
}

/** Earlier general ledger imports, newest first. */
export async function listHistoryImports(tx: OrgTx) {
  const rows = await tx.query<{
    id: string;
    file_name: string;
    from_date: string;
    to_date: string;
    journal_count: number;
    line_count: number;
    total_debit: string;
    created_by_email: string | null;
    created_at: string;
  }>(
    "select id::text, file_name, from_date::text, to_date::text, journal_count, line_count, total_debit::text, created_by_email, created_at::text from history_imports order by id desc",
  );
  return rows.rows.map((row) => ({
    id: row.id,
    fileName: row.file_name,
    from: row.from_date,
    to: row.to_date,
    journals: row.journal_count,
    lines: row.line_count,
    total: row.total_debit,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  }));
}

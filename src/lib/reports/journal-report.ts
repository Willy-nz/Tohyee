import type { OrgTx } from "@/lib/db/org-transaction";
import { currencyMinorUnits } from "@/lib/money/currency";
import { dec, type Decimal, sum, toFixedString } from "@/lib/money/decimal";
import { parseReportPeriod } from "@/lib/reports/account-transactions";
import type { CustomValues } from "@/lib/custom-fields/values";
import { JOURNAL_SOURCES_SQL, type JournalSource, journalSource, SOURCE_COLUMNS, SOURCE_JOINS, type SourceRow } from "@/lib/reports/journal-sources";
import type { TrackingTags } from "@/lib/tracking/service";

/**
 * The journal report (examples JR1-JR3): every journal posted in a date
 * range, oldest first, with its lines, where it came from and who posted it
 * and when. Who posted it is stored on the journal when it's posted (the
 * signed-in user, the same person as its "ledger.journal_posted" audit
 * event). Each journal balances, so the report's debits equal its credits.
 */

export type JournalReportLine = {
  lineOrder: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  description: string | null;
  debit: string;
  credit: string;
  tracking: TrackingTags;
  customFields: CustomValues;
};

export type JournalReportEntry = {
  journalId: string;
  date: string;
  reference: string;
  description: string | null;
  origin: string;
  correctionKind: string | null;
  source: JournalSource;
  postedByEmail: string | null;
  postedAt: string;
  lines: JournalReportLine[];
  totalDebit: string;
  totalCredit: string;
};

export type JournalReport = {
  from: string;
  to: string;
  currencyCode: string;
  journals: JournalReportEntry[];
  totalDebit: string;
  totalCredit: string;
};

/** The most journals one report lists; narrow the dates for more. */
export const JOURNAL_REPORT_LIMIT = 2000;

type Row = SourceRow & {
  id: string;
  posting_date: string;
  reference: string;
  description: string | null;
  origin: string;
  correction_kind: string | null;
  created_by_email: string | null;
  created_at: string;
};

export async function journalReport(tx: OrgTx, input: { from?: unknown; to?: unknown }): Promise<JournalReport & { truncated: boolean }> {
  const { from, to } = await parseReportPeriod(tx, input.from, input.to);
  const scale = currencyMinorUnits(tx.baseCurrency);
  const money = (value: Decimal) => toFixedString(value, scale);
  const journals = await tx.query<Row>(
    `with ${JOURNAL_SOURCES_SQL}
     select j.id::text, j.posting_date, j.reference, j.description, j.origin, j.correction_kind,
            j.created_by_email, j.created_at, ${SOURCE_COLUMNS}
       from ledger_journals j
       ${SOURCE_JOINS}
      where j.posting_date between $1 and $2
      order by j.posting_date, j.id
      limit ${JOURNAL_REPORT_LIMIT + 1}`,
    [from, to],
  );
  const truncated = journals.rows.length > JOURNAL_REPORT_LIMIT;
  const shown = journals.rows.slice(0, JOURNAL_REPORT_LIMIT);
  const lineRows = await tx.query<{
    journal_id: string;
    line_order: number;
    account_id: string;
    code: string;
    name: string;
    description: string | null;
    debit_amount: string;
    credit_amount: string;
    tracking: TrackingTags;
    custom_fields: CustomValues;
  }>(
    `select l.journal_id::text, l.line_order, a.id::text as account_id, a.code, a.name, l.description,
            l.debit_amount::text, l.credit_amount::text, l.tracking, l.custom_fields
       from ledger_journal_lines l join accounts a on a.id = l.account_id
      where l.journal_id = any($1::bigint[])
      order by l.journal_id, l.line_order`,
    [shown.map((row) => row.id)],
  );
  const linesOf = new Map<string, JournalReportLine[]>();
  for (const row of lineRows.rows) {
    linesOf.set(row.journal_id, [
      ...(linesOf.get(row.journal_id) ?? []),
      {
        lineOrder: row.line_order,
        accountId: row.account_id,
        accountCode: row.code,
        accountName: row.name,
        description: row.description,
        debit: money(dec(row.debit_amount)),
        credit: money(dec(row.credit_amount)),
        tracking: row.tracking ?? {},
        customFields: row.custom_fields ?? {},
      },
    ]);
  }
  const entries = shown.map((row): JournalReportEntry => {
    const lines = linesOf.get(row.id) ?? [];
    return {
      journalId: row.id,
      date: row.posting_date,
      reference: row.reference,
      description: row.description,
      origin: row.origin,
      correctionKind: row.correction_kind,
      source: journalSource({ id: row.id, origin: row.origin, reference: row.reference, correctionKind: row.correction_kind }, row),
      postedByEmail: row.created_by_email,
      postedAt: row.created_at,
      lines,
      totalDebit: money(sum(lines.map((line) => dec(line.debit)))),
      totalCredit: money(sum(lines.map((line) => dec(line.credit)))),
    };
  });
  return {
    from,
    to,
    currencyCode: tx.baseCurrency,
    journals: entries,
    totalDebit: money(sum(entries.map((entry) => dec(entry.totalDebit)))),
    totalCredit: money(sum(entries.map((entry) => dec(entry.totalCredit)))),
    truncated,
  };
}

import type { AccountClass } from "@/lib/accounts/types";
import type { OrgTx } from "@/lib/db/org-transaction";
import { formatDate } from "@/lib/format";
import { add, cmp, dec, type Decimal, neg, sub, sum, ZERO_DECIMAL } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { irdPaymentReference } from "@/lib/payroll/ird-payments";
import { payRunReference } from "@/lib/payroll/pay-runs";
import { money, parseReportDates, type ReportInput } from "@/lib/payroll/report-common";
import { wagePaymentReference } from "@/lib/payroll/wage-payments";
import { JOURNAL_SOURCES_SQL, journalSource, SOURCE_COLUMNS, SOURCE_JOINS, type SourceRow } from "@/lib/reports/journal-sources";

/**
 * Payroll reconciled to the ledger (PREP4, decision 106): for each payroll
 * account, what the approved pay runs paid in the dates (and the payments
 * recorded against them) say its movement should be, against the ledger's
 * movement in the same dates, and every other journal on the account that
 * explains the difference. Read-only.
 */

export type ReconciliationJournalKind = "voided_pay_run" | "voided_payment" | "other";

export type ReconciliationJournal = {
  journalId: string;
  date: string;
  reference: string;
  kind: ReconciliationJournalKind;
  label: string;
  href: string;
  /** Its amount on the account, in the account's own sign. */
  amount: string;
};

export type ReconciliationAccount = {
  accountId: string;
  code: string;
  name: string;
  accountClass: AccountClass;
  /** Expenses (and assets) are debits less credits; liabilities credits less debits. */
  side: "debit" | "credit";
  payroll: string;
  ledger: string;
  difference: string;
  explained: string;
  unexplained: string;
  journals: ReconciliationJournal[];
};

export type PayrollReconciliation = {
  from: string;
  to: string;
  accounts: ReconciliationAccount[];
  /** What the payroll figures are made of. */
  counted: { payRuns: string[]; wagePayments: string[]; irdPayments: string[] };
  allExplained: boolean;
};

const CONTROL_KEYS = ["paye_payable", "student_loan_payable", "kiwisaver_payable", "esct_payable", "wages_payable"] as const;

type LinkRow = { journal_id: string; kind: "run" | "run_void" | "wages" | "wages_void" | "ird" | "ird_void"; number: string; status: string; void_date: string | null };

export async function payrollReconciliation(tx: OrgTx, input: ReportInput): Promise<PayrollReconciliation> {
  await requirePayrollAccess(tx);
  const { from, to } = await parseReportDates(tx, input);
  const payroll = new Map<string, Decimal>();
  const addTo = (accountId: string | null, amount: Decimal) => {
    if (!accountId) return;
    payroll.set(accountId, add(payroll.get(accountId) ?? ZERO_DECIMAL, amount));
  };

  const controls = new Map(
    (await tx.query<{ system_key: string; id: string }>("select system_key, id::text from accounts where system_key = any($1::text[])", [[...CONTROL_KEYS]])).rows.map(
      (row) => [row.system_key, row.id],
    ),
  );
  for (const id of controls.values()) addTo(id, ZERO_DECIMAL);

  // Expenses: the counted pay runs' postings.
  const postings = await tx.query<{ account_id: string; amount: string }>(
    `select p.account_id::text, sum(p.amount)::text as amount
       from payroll_pay_run_postings p join payroll_pay_runs r on r.id = p.pay_run_id
      where r.status = 'approved' and r.pay_date between $1 and $2
      group by p.account_id`,
    [from, to],
  );
  for (const row of postings.rows) addTo(row.account_id, dec(row.amount));
  // Deductions: to each deduction pay item's account.
  const deductions = await tx.query<{ account_id: string | null; amount: string }>(
    `select i.account_id::text, sum(l.amount)::text as amount
       from payroll_pay_run_lines l
       join payroll_pay_runs r on r.id = l.pay_run_id
       join payroll_pay_items i on i.id = l.pay_item_id
      where r.status = 'approved' and r.pay_date between $1 and $2 and i.category = 'deduction'
      group by i.account_id`,
    [from, to],
  );
  for (const row of deductions.rows) addTo(row.account_id, dec(row.amount));
  // IRD liabilities and net pay: what the pay runs credited.
  const credited = (
    await tx.query<{ paye: string; student_loan: string; kiwisaver: string; esct: string; net_pay: string }>(
      `select coalesce(sum(pe.paye), 0)::text as paye, coalesce(sum(pe.student_loan_deduction), 0)::text as student_loan,
              coalesce(sum(pe.kiwisaver_employee + pe.kiwisaver_employer_net), 0)::text as kiwisaver,
              coalesce(sum(pe.esct), 0)::text as esct, coalesce(sum(pe.net_pay), 0)::text as net_pay
         from payroll_pay_run_employees pe join payroll_pay_runs r on r.id = pe.pay_run_id
        where r.status = 'approved' and r.pay_date between $1 and $2`,
      [from, to],
    )
  ).rows[0];
  addTo(controls.get("paye_payable") ?? null, dec(credited.paye));
  addTo(controls.get("student_loan_payable") ?? null, dec(credited.student_loan));
  addTo(controls.get("kiwisaver_payable") ?? null, dec(credited.kiwisaver));
  addTo(controls.get("esct_payable") ?? null, dec(credited.esct));
  addTo(controls.get("wages_payable") ?? null, dec(credited.net_pay));
  // Less the payments recorded in the dates.
  const irdPaid = await tx.query<{ account_id: string; amount: string }>(
    `select l.account_id::text, sum(l.amount)::text as amount
       from payroll_ird_payment_lines l join payroll_ird_payments p on p.id = l.ird_payment_id
      where p.status = 'active' and p.payment_date between $1 and $2
      group by l.account_id`,
    [from, to],
  );
  for (const row of irdPaid.rows) addTo(row.account_id, neg(dec(row.amount)));
  const wagesPaid = (
    await tx.query<{ amount: string }>(
      "select coalesce(sum(amount), 0)::text as amount from payroll_wage_payments where status = 'active' and payment_date between $1 and $2",
      [from, to],
    )
  ).rows[0];
  addTo(controls.get("wages_payable") ?? null, neg(dec(wagesPaid.amount)));
  // Every pay item's account is a payroll account, even with nothing in the dates.
  for (const row of (await tx.query<{ account_id: string }>("select distinct account_id::text from payroll_pay_items where account_id is not null")).rows) {
    addTo(row.account_id, ZERO_DECIMAL);
  }

  const accountIds = [...payroll.keys()];
  const accounts = (
    await tx.query<{ id: string; code: string; name: string; account_class: AccountClass }>(
      "select id::text, code, name, account_class from accounts where id = any($1::bigint[])",
      [accountIds],
    )
  ).rows;
  const ledger = new Map(
    (
      await tx.query<{ account_id: string; movement: string }>(
        `select l.account_id::text, sum(l.debit_amount - l.credit_amount)::text as movement
           from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
          where j.posting_date between $1 and $2 and l.account_id = any($3::bigint[])
          group by l.account_id`,
        [from, to, accountIds],
      )
    ).rows.map((row) => [row.account_id, dec(row.movement)]),
  );

  // The journals the payroll figures are made of; every other journal on these accounts explains a difference.
  const expected = `select approval_journal_id as id from payroll_pay_runs where status = 'approved' and pay_date between $1 and $2
    union select journal_id from payroll_wage_payments where status = 'active' and payment_date between $1 and $2
    union select journal_id from payroll_ird_payments where status = 'active' and payment_date between $1 and $2`;
  const others = (
    await tx.query<
      SourceRow & {
        journal_id: string;
        account_id: string;
        posting_date: string;
        reference: string;
        origin: string;
        correction_kind: string | null;
        movement: string;
      }
    >(
      `with ${JOURNAL_SOURCES_SQL},
       moved as (
         select l.journal_id, l.account_id, sum(l.debit_amount - l.credit_amount) as movement
           from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
          where j.posting_date between $1 and $2 and l.account_id = any($3::bigint[])
            and j.id not in (${expected})
          group by l.journal_id, l.account_id
       )
       select m.journal_id::text, m.account_id::text, j.posting_date::text, j.reference, j.origin, j.correction_kind,
              m.movement::text as movement, ${SOURCE_COLUMNS}
         from moved m
         join ledger_journals j on j.id = m.journal_id
         ${SOURCE_JOINS}
        order by j.posting_date, j.id`,
      [from, to, accountIds],
    )
  ).rows;
  const links = new Map(
    (
      await tx.query<LinkRow>(
        `select approval_journal_id::text as journal_id, 'run' as kind, run_number::text as number, status, void_date::text
           from payroll_pay_runs where approval_journal_id = any($1::bigint[])
         union all
         select void_journal_id::text, 'run_void', run_number::text, status, void_date::text from payroll_pay_runs where void_journal_id = any($1::bigint[])
         union all
         select journal_id::text, 'wages', payment_number::text, status, void_date::text from payroll_wage_payments where journal_id = any($1::bigint[])
         union all
         select void_journal_id::text, 'wages_void', payment_number::text, status, void_date::text from payroll_wage_payments where void_journal_id = any($1::bigint[])
         union all
         select journal_id::text, 'ird', payment_number::text, status, void_date::text from payroll_ird_payments where journal_id = any($1::bigint[])
         union all
         select void_journal_id::text, 'ird_void', payment_number::text, status, void_date::text from payroll_ird_payments where void_journal_id = any($1::bigint[])`,
        [[...new Set(others.map((row) => row.journal_id))]],
      )
    ).rows.map((row) => [row.journal_id, row]),
  );

  const describe = (row: (typeof others)[number]): { kind: ReconciliationJournalKind; label: string; href: string } => {
    const link = links.get(row.journal_id);
    const href = `/operations/ledger-journals?journal=${row.journal_id}`;
    if (link) {
      const voided = link.void_date ? `, voided ${formatDate(link.void_date)}` : "";
      switch (link.kind) {
        case "run":
          return { kind: "voided_pay_run", label: `Pay run ${payRunReference(link.number)}${voided}`, href };
        case "run_void":
          return { kind: "voided_pay_run", label: `Void of pay run ${payRunReference(link.number)}`, href };
        case "wages":
          return { kind: "voided_payment", label: `Wage payment ${wagePaymentReference(link.number)}${voided}`, href };
        case "wages_void":
          return { kind: "voided_payment", label: `Void of wage payment ${wagePaymentReference(link.number)}`, href };
        case "ird":
          return { kind: "voided_payment", label: `IRD payment ${irdPaymentReference(link.number)}${voided}`, href };
        case "ird_void":
          return { kind: "voided_payment", label: `Void of IRD payment ${irdPaymentReference(link.number)}`, href };
      }
    }
    const source = journalSource({ id: row.journal_id, origin: row.origin, reference: row.reference, correctionKind: row.correction_kind }, row);
    return { kind: "other", label: source.label, href: source.href };
  };

  const debitSide = (accountClass: AccountClass) => accountClass === "asset" || accountClass === "expense";
  const result: ReconciliationAccount[] = accounts.map((account) => {
    const side = debitSide(account.account_class) ? "debit" : "credit";
    const own = (movement: Decimal) => (side === "debit" ? movement : neg(movement));
    const payrollFigure = payroll.get(account.id) ?? ZERO_DECIMAL;
    const ledgerFigure = own(ledger.get(account.id) ?? ZERO_DECIMAL);
    const journals = others
      .filter((row) => row.account_id === account.id)
      .map((row) => ({ journalId: row.journal_id, date: row.posting_date, reference: row.reference, ...describe(row), amount: money(own(dec(row.movement))) }));
    const difference = sub(ledgerFigure, payrollFigure);
    const explained = sum(journals.map((journal) => dec(journal.amount)));
    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      accountClass: account.account_class,
      side,
      payroll: money(payrollFigure),
      ledger: money(ledgerFigure),
      difference: money(difference),
      explained: money(explained),
      unexplained: money(sub(difference, explained)),
      journals,
    };
  });
  const isControl = new Set(controls.values());
  const shown = result
    .filter(
      (account) =>
        isControl.has(account.accountId) ||
        cmp(dec(account.payroll), ZERO_DECIMAL) !== 0 ||
        cmp(dec(account.ledger), ZERO_DECIMAL) !== 0 ||
        account.journals.length > 0,
    )
    .sort((a, b) => (a.side === b.side ? a.code.localeCompare(b.code, "en", { numeric: true }) : a.side === "debit" ? -1 : 1));

  const counted = await tx.query<{ kind: string; number: string }>(
    `select 'run' as kind, run_number::text as number from payroll_pay_runs where status = 'approved' and pay_date between $1 and $2
     union all select 'wages', payment_number::text from payroll_wage_payments where status = 'active' and payment_date between $1 and $2
     union all select 'ird', payment_number::text from payroll_ird_payments where status = 'active' and payment_date between $1 and $2
     order by 1, 2`,
    [from, to],
  );
  const numbers = (kind: string) =>
    counted.rows
      .filter((row) => row.kind === kind)
      .map((row) => Number(row.number))
      .sort((a, b) => a - b);
  return {
    from,
    to,
    accounts: shown,
    counted: {
      payRuns: numbers("run").map(payRunReference),
      wagePayments: numbers("wages").map(wagePaymentReference),
      irdPayments: numbers("ird").map(irdPaymentReference),
    },
    allExplained: shown.every((account) => account.unexplained === "0.00"),
  };
}

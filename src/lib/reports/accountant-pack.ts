import { listBankAccounts } from "@/lib/bank/accounts";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { financialYearStart } from "@/lib/financial-year";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { accountTransactions } from "@/lib/reports/account-transactions";
import { bankReconciliationReport } from "@/lib/reports/bank-reconciliation";
import { reportCsv, reportPdf } from "@/lib/reports/export-files";
import type { ReportExportCell, ReportExportData, ReportExportName, ReportExportRow, ReportExportTable } from "@/lib/reports/export-types";
import { balanceSheet, financialYearEndMonth, profitAndLoss, trialBalance } from "@/lib/reports/financial";
import { createZip, type ZipEntry } from "@/lib/zip/write";

/*
 * The year-end accountant pack (#258): one ZIP with the reports an
 * accountant asks for at a year end, made from the same report functions as
 * the screens, so every figure matches them:
 * - Trial balance as at the year end (CSV)
 * - Profit and loss for the year (CSV)
 * - Balance sheet as at the year end (CSV)
 * - General ledger: every account's transactions for the year (CSV)
 * - Bank reconciliation as at the year end, one PDF per bank and card account
 * - A read-me listing them
 * Nothing is posted or changed.
 */

const text = (value: string): ReportExportCell => ({ text: value });
const amount = (value: string): ReportExportCell => ({ text: value, value, numeric: true });
const row = (cells: ReportExportCell[], kind?: ReportExportRow["kind"]): ReportExportRow => ({ cells, ...(kind ? { kind } : {}) });

function nzDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
}

type Section = { label: string; lines: Array<{ code: string; name: string; amount: string }>; total: string };

function sectionRows(heading: string, sections: Section[], total: string): ReportExportRow[] {
  const rows: ReportExportRow[] = [row([text(heading), text(""), text("")], "section")];
  for (const section of sections) {
    for (const line of section.lines) rows.push(row([text(line.code), text(line.name), amount(line.amount)]));
  }
  rows.push(row([text(""), text(`Total ${heading.toLowerCase()}`), amount(total)], "total"));
  return rows;
}

export type AccountantPack = { fileName: string; bytes: Buffer; files: string[] };

/** Builds the pack for the financial year ending `yearEnd` (YYYY-MM-DD). */
export async function buildAccountantPack(tx: OrgTx, input: { yearEnd: unknown }, now = new Date()): Promise<AccountantPack> {
  const yearEnd = parseIsoDate(input.yearEnd, "Year end");
  const yearStart = financialYearStart(yearEnd, await financialYearEndMonth(tx));
  const settings = await getOrganisationSettings(tx);
  const organisationName = settings.displayName;
  const producedAt = now.toISOString();
  const period = `${nzDate(yearStart)} to ${nzDate(yearEnd)}`;
  const data = (report: ReportExportName, title: string, periodText: string, tables: ReportExportTable[], filters: string[] = []): ReportExportData => ({
    report,
    organisationName,
    title,
    period: periodText,
    basis: null,
    filters,
    producedAt,
    tables,
  });
  const entries: ZipEntry[] = [];
  const add = (name: string, content: string | Uint8Array) => entries.push({ name, data: content, modified: now });

  const tb = await trialBalance(tx, { asAt: yearEnd });
  add(
    "Trial balance.csv",
    reportCsv(
      data("trial-balance", "Trial balance", `As at ${nzDate(yearEnd)}`, [
        {
          columns: ["Code", "Account", "Debit", "Credit"],
          rows: [
            ...tb.rows.map((entry) => row([text(entry.code), text(entry.name), amount(entry.debit), amount(entry.credit)])),
            row([text(""), text("Total"), amount(tb.totalDebit), amount(tb.totalCredit)], "total"),
          ],
        },
      ]),
    ),
  );

  const pl = await profitAndLoss(tx, { from: yearStart, to: yearEnd });
  add(
    "Profit and loss.csv",
    reportCsv(
      data("profit-and-loss", "Profit and loss", period, [
        {
          columns: ["Code", "Account", "Amount"],
          rows: [
            ...sectionRows("Revenue", pl.revenue.sections, pl.revenue.total),
            ...sectionRows("Cost of sales", pl.costOfSales.sections, pl.costOfSales.total),
            row([text(""), text("Gross profit"), amount(pl.grossProfit)], "total"),
            ...sectionRows("Other income", pl.otherIncome.sections, pl.otherIncome.total),
            ...sectionRows("Expenses", pl.expenses.sections, pl.expenses.total),
            row([text(""), text("Net profit"), amount(pl.netProfit)], "total"),
          ],
        },
      ]),
    ),
  );

  const bs = await balanceSheet(tx, { asAt: yearEnd });
  add(
    "Balance sheet.csv",
    reportCsv(
      data("balance-sheet", "Balance sheet", `As at ${nzDate(yearEnd)}`, [
        {
          columns: ["Code", "Account", "Amount"],
          rows: [
            ...sectionRows("Assets", bs.assets.sections, bs.assets.total),
            ...sectionRows("Liabilities", bs.liabilities.sections, bs.liabilities.total),
            row([text("Equity"), text(""), text("")], "section"),
            ...bs.equity.sections.flatMap((section) => section.lines.map((line) => row([text(line.code), text(line.name), amount(line.amount)]))),
            row([text(bs.equity.retainedEarnings.account?.code ?? ""), text("Retained earnings"), amount(bs.equity.retainedEarnings.total)]),
            row([text(""), text("Current year earnings"), amount(bs.equity.currentYearEarnings)]),
            row([text(""), text("Total equity"), amount(bs.equity.total)], "total"),
            row([text(""), text("Total liabilities and equity"), amount(bs.liabilitiesAndEquity)], "total"),
          ],
        },
      ]),
    ),
  );

  const gl = await accountTransactions(tx, { from: yearStart, to: yearEnd });
  const glRows: ReportExportRow[] = [];
  for (const account of gl.accounts) {
    glRows.push(row([text(account.code), text(account.name), text(""), text("Opening balance"), text(""), text(""), text(""), amount(account.opening)], "section"));
    for (const line of account.lines) {
      glRows.push(
        row([
          text(account.code),
          text(account.name),
          text(nzDate(line.date)),
          text(line.source.label),
          text(line.description),
          text(line.source.contactName ?? ""),
          amount(line.debit),
          amount(line.credit),
          amount(line.balance),
        ]),
      );
    }
    glRows.push(row([text(account.code), text(account.name), text(""), text("Closing balance"), text(""), text(""), amount(account.totalDebit), amount(account.totalCredit), amount(account.closing)], "total"));
  }
  add(
    "General ledger.csv",
    reportCsv(
      data("account-transactions", "General ledger", period, [
        { columns: ["Code", "Account", "Date", "Source", "Description", "Contact", "Debit", "Credit", "Balance"], rows: glRows },
      ]),
    ),
  );

  const banks = (await listBankAccounts(tx)).filter((account) => account.isActive);
  const bankFiles: string[] = [];
  for (const bank of banks) {
    const rec = await bankReconciliationReport(tx, { accountId: bank.id, asAt: yearEnd });
    const items = (heading: string, list: Array<{ date: string; description: string | null; reference: string | null; amount: string }>, total: string): ReportExportTable => ({
      title: heading,
      columns: ["Date", "Description", "Reference", "Amount"],
      rows: [
        ...list.map((item) => row([text(nzDate(item.date)), text(item.description ?? ""), text(item.reference ?? ""), amount(item.amount)])),
        row([text(""), text("Total"), text(""), amount(total)], "total"),
      ],
    });
    const name = `Bank reconciliation ${safeName(`${bank.code} ${bank.name}`)}.pdf`;
    bankFiles.push(name);
    add(
      name,
      await reportPdf(
        data(
          "bank-reconciliation",
          `Bank reconciliation: ${bank.code} ${bank.name}`,
          `As at ${nzDate(yearEnd)}`,
          [
            {
              columns: ["", rec.currencyCode],
              rows: [
                row([text("Statement balance"), rec.statementBalance === null ? text("Not known") : amount(rec.statementBalance)]),
                row([text("Balance in Tohyee"), amount(rec.ledgerBalance)]),
                row([text("In the bank, not in Tohyee"), amount(rec.bankNotInTohyee.total)]),
                row([text("In Tohyee, not in the bank"), amount(rec.tohyeeNotInBank.total)]),
                row([text("Expected statement balance"), amount(rec.expectedStatementBalance)], "total"),
                row([text("Not explained"), rec.notExplained === null ? text("Statement balance not known") : amount(rec.notExplained)], "total"),
              ],
            },
            items(
              "In the bank, not in Tohyee",
              rec.bankNotInTohyee.items.map((item) => ({ date: item.date, description: item.description, reference: item.reference, amount: item.amount })),
              rec.bankNotInTohyee.total,
            ),
            items(
              "In Tohyee, not in the bank",
              rec.tohyeeNotInBank.items.map((item) => ({ date: item.date, description: item.description, reference: item.reference, amount: item.amount })),
              rec.tohyeeNotInBank.total,
            ),
          ],
          [bank.isForeign ? `In ${rec.currencyCode}` : ""].filter(Boolean),
        ),
      ),
    );
  }

  const files = ["Trial balance.csv", "Profit and loss.csv", "Balance sheet.csv", "General ledger.csv", ...bankFiles];
  add(
    "Read me.txt",
    [
      `${organisationName}: year-end accountant pack`,
      `Financial year ${period}. Made by Tohyee on ${now.toISOString().slice(0, 10)} (UTC).`,
      "",
      "Every figure comes from the same reports as Tohyee's screens:",
      "- Trial balance.csv: as at the year end. Income and expense accounts show this year only; earlier years' profit is in retained earnings.",
      "- Profit and loss.csv: for the year.",
      "- Balance sheet.csv: as at the year end.",
      "- General ledger.csv: every account's transactions for the year, with opening and closing balances.",
      ...(bankFiles.length > 0
        ? ["- Bank reconciliation PDFs: for each bank and credit card account as at the year end."]
        : ["- No bank or credit card accounts, so no bank reconciliations."]),
      "",
      "Amounts are in the organisation's currency unless a file says otherwise.",
    ].join("\r\n"),
  );
  if (entries.length !== files.length + 1) throw new ValidationError("The pack is missing a report.");
  return { fileName: `${safeName(organisationName)} year-end pack ${yearEnd}.zip`, bytes: createZip(entries), files: ["Read me.txt", ...files] };
}

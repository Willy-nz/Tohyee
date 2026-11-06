"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { MoreMenu } from "@/components/more-menu";
import { useYearEndMonth } from "@/components/reports/report-frame";
import { useReportLayout } from "@/components/reports/report-layout";
import { NotesEditor } from "@/components/reports/statement-notes";
import { Button, Field, Notice, ui } from "@/components/ui";
import { todayInBrowser } from "@/lib/format";
import type { FinancialStatement, FinancialStatements, StatementLine } from "@/lib/reports/financial-statements";
import { statementValue } from "@/lib/reports/statement-format";

/** The end of the last financial year that has finished, for a year ending in `endMonth`. */
function lastYearEnd(endMonth: number, today: string): string {
  const [year, month] = today.split("-").map(Number);
  const endYear = month > endMonth ? year : year - 1;
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return `${endYear}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function rowClass(line: StatementLine): string | undefined {
  if (line.kind === "section") return ui.reportHeading;
  if (line.kind === "total") return ui.reportGrand;
  if (line.kind === "subtotal") return ui.reportTotal;
  return ui.reportSection;
}

function StatementTable({ statement, columns, action }: { statement: FinancialStatement; columns: FinancialStatements["columns"]; action: React.ReactNode }) {
  return (
    <section className={ui.annualStatement} aria-label={statement.title}>
      <header className={ui.statementHeading}>
        <h3 className={ui.statementTitle}>{statement.title}</h3>
        <p>{statement.subtitle}</p>
        {statement.layout ? <p className={ui.muted}>In the layout {statement.layout.title}</p> : null}
        {action ? (
          <div data-print="hide" style={{ marginTop: 8 }}>
            {action}
          </div>
        ) : null}
      </header>
      <div className={ui.statementWrap}>
        <table id={`annual-${statement.key}`} className={`${ui.table} ${ui.statement}`}>
          <thead>
            <tr>
              <th>
                <span className={ui.srOnly}>Item</span>
              </th>
              <th className={ui.num}>{columns.current}</th>
              <th className={ui.num}>{columns.prior}</th>
            </tr>
          </thead>
          <tbody>
            {statement.lines.map((line) =>
              line.kind === "section" ? (
                <tr key={line.key} className={rowClass(line)}>
                  <td colSpan={3}>{line.label}</td>
                </tr>
              ) : (
                <tr key={line.key} className={rowClass(line)}>
                  <td>
                    {line.label}
                    {line.note ? <div className={ui.muted}>{line.note}</div> : null}
                  </td>
                  <td className={ui.num}>{statementValue(line, line.current)}</td>
                  <td className={ui.num}>{statementValue(line, line.prior)}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {statement.paragraphs.map((paragraph, index) => (
        <p key={index} className={ui.reportNote}>
          {paragraph}
        </p>
      ))}
    </section>
  );
}

/**
 * Annual financial statements as a report (FS4-FS7, decisions 1559-1561):
 * the four statements and the notes on screen, the same as the PDF. The
 * statements of financial performance and position follow the default
 * profit and loss and balance sheet layouts, with Edit layout beside them.
 */
export function AnnualStatementsReport({ organisationId }: { organisationId: string }) {
  const params = useSearchParams();
  const yearEndMonth = useYearEndMonth(organisationId);
  const fallback = lastYearEnd(yearEndMonth, todayInBrowser());
  const [chosen, setChosen] = useState<string | null>(params.get("yearEnd"));
  const yearEnd = chosen ?? fallback;
  const [typed, setTyped] = useState(yearEnd);
  const report = useApiData<FinancialStatements>("/api/reports/annual-statements", { organisationId, yearEnd });
  const plLayout = useReportLayout(organisationId, "profit_and_loss");
  const bsLayout = useReportLayout(organisationId, "balance_sheet");
  const cfLayout = useReportLayout(organisationId, "cash_flows");
  const data = report.data;
  const pdf = `/api/reports/financial-statements?organisationId=${encodeURIComponent(organisationId)}&yearEnd=${encodeURIComponent(yearEnd)}&kind=statements`;
  const layoutFor = (statement: FinancialStatement) => (statement.base === "profit_and_loss" ? plLayout : statement.base === "balance_sheet" ? bsLayout : statement.base === "cash_flows" ? cfLayout : null);
  return (
    <section className={ui.reportFrame} aria-label="Annual financial statements">
      <div className={ui.reportToolbar} data-print="hide" role="group" aria-label="Report options">
        <Field label="Financial year ending" hint="The last day of the year">
          <DateInput value={typed} onChange={(event) => setTyped(event.target.value)} />
        </Field>
        <Button onClick={() => setChosen(typed || fallback)} disabled={report.loading}>
          Update
        </Button>
        <div className={ui.reportToolbarEnd}>
          <InfoTip label="About this report">
            Special purpose statements, with last year beside this year. The statements of financial performance and position follow your default profit and loss and balance sheet
            layouts, if you&apos;ve set them. The PDF is the same as what&apos;s shown here.
          </InfoTip>
          <a className={`${ui.button} ${ui.secondary}`} href={pdf} download>
            Download PDF
          </a>
          <MoreMenu label="More report options" items={[{ label: "Print", onSelect: () => window.print() }]} />
        </div>
      </div>
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {plLayout.error ? <Notice tone="error">{plLayout.error}</Notice> : null}
      {bsLayout.error ? <Notice tone="error">{bsLayout.error}</Notice> : null}
      {cfLayout.error ? <Notice tone="error">{cfLayout.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {data ? (
        <>
          <header className={ui.statementHeading}>
            <h2 className={ui.statementTitle}>{data.heading}</h2>
            <p className={ui.statementOrg}>{data.name}</p>
            <p>{data.period}</p>
            <p className={ui.muted}>Amounts are in {data.currencyCode}.</p>
          </header>
          {data.statements.map((statement) => (
            <StatementTable key={statement.key} statement={statement} columns={data.columns} action={layoutFor(statement)?.button(data.yearEnd)} />
          ))}
          <section className={ui.annualStatement} aria-label="Notes to the financial statements">
            <header className={ui.statementHeading}>
              <h3 className={ui.statementTitle}>Notes to the financial statements</h3>
              <p>{data.period}</p>
            </header>
            <NotesEditor key={`${data.yearEnd}-${data.notes.saved}`} organisationId={organisationId} loaded={data.notes} onSaved={report.reload} />
          </section>
        </>
      ) : null}
    </section>
  );
}

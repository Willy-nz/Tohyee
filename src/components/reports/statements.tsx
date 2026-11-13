"use client";

import { useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { ReportFrame, type ReportDates, ReportToolbar, StatementHeading, useYearEndMonth } from "@/components/reports/report-frame";
import { CashFlowTable } from "@/components/reports/cash-flow-custom-report";
import { EquityTable } from "@/components/reports/equity-custom-report";
import { useReportLayout } from "@/components/reports/report-layout";
import { Notice, ui } from "@/components/ui";
import type { CashFlowFigures } from "@/lib/reports/cash-flow-layout";
import type { EquityFigures } from "@/lib/reports/equity-layout";
import { formatDate, todayInBrowser } from "@/lib/format";
import { columnHeading, statementPeriod } from "@/lib/reports/report-dates";
import type { cashFlowStatement, changesInEquity, StatementRow } from "@/lib/reports/statements";

type ChangesInEquity = Awaited<ReturnType<typeof changesInEquity>>;
type CashFlowStatement = Awaited<ReturnType<typeof cashFlowStatement>>;

/** From and to dates; no "from" means the financial year to date (the server works it out). */
function usePeriod() {
  return useState<ReportDates>(() => ({ from: null, to: todayInBrowser() }));
}

function Row({ label, amount, total, grand, indent }: { label: string; amount: string; total?: boolean; grand?: boolean; indent?: boolean }) {
  return (
    <tr className={grand ? ui.reportGrand : total ? ui.reportTotal : indent ? ui.reportSection : undefined}>
      <td>{label}</td>
      <td className={ui.num}>
        <Money value={amount} />
      </td>
    </tr>
  );
}

function Heading({ children }: { children: string }) {
  return (
    <tr className={ui.reportHeading}>
      <td colSpan={2}>{children}</td>
    </tr>
  );
}

function Lines({ rows }: { rows: StatementRow[] }) {
  return (
    <>
      {rows.map((row) => (
        <Row key={`${row.accountId ?? row.label}`} label={row.label} amount={row.amount} indent />
      ))}
    </>
  );
}

function Head({ from, to }: { from: string; to: string }) {
  return (
    <thead>
      <tr>
        <th>
          <span className={ui.srOnly}>Item</span>
        </th>
        <th className={ui.num}>{columnHeading(from, to)}</th>
      </tr>
    </thead>
  );
}

const isZeroText = (amount: string) => /^-?0(\.0+)?$/.test(amount);
const print = { label: "Print", onSelect: () => window.print() };

/** Statement of changes in equity (examples SCE1, SCE2). */
export function ChangesInEquityReport({ organisationId }: { organisationId: string }) {
  const yearEndMonth = useYearEndMonth(organisationId);
  const [dates, setDates] = usePeriod();
  const layout = useReportLayout(organisationId, "changes_in_equity");
  const [standard, setStandard] = useState(false);
  const report = useApiData<ChangesInEquity & { layout: { report: { id: string; title: string }; figures: EquityFigures } | null }>("/api/reports/changes-in-equity", {
    organisationId,
    from: dates.from,
    to: dates.to,
    ...(standard ? { standard: "1" } : {}),
  });
  const data = report.data;
  const shownLayout = data?.layout ?? null;
  const title = "Statement of changes in equity";
  const period = data ? statementPeriod(data.from, data.to, yearEndMonth) : "";
  return (
    <ReportFrame
      label={title}
      toolbar={
        <ReportToolbar
          mode="range"
          dates={dates}
          shownFrom={data?.from}
          yearEndMonth={yearEndMonth}
          onUpdate={setDates}
          busy={report.loading}
          more={[
            print,
            ...(layout.chosen ? [standard ? { label: `Show in ${layout.chosen.title}`, onSelect: () => setStandard(false) } : { label: "Show the standard layout", onSelect: () => setStandard(true) }] : []),
          ]}
          actions={data ? layout.button(data.to) : null}
          exportProps={data ? { organisationId, report: "changes-in-equity", title, period, style: "statement", tables: [{ id: "changes-in-equity-report" }] } : null}
        />
      }
    >
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {layout.error ? <Notice tone="error">{layout.error}</Notice> : null}
      {data ? <StatementHeading title={title} period={period} lines={shownLayout ? [`In the layout ${shownLayout.report.title}`] : []} /> : null}
      {data && !data.reconciles ? <Notice tone="warning">Equity at {formatDate(data.to)} doesn&apos;t match the balance sheet.</Notice> : null}
      {shownLayout ? <EquityTable id="changes-in-equity-report" figures={shownLayout.figures} showHidden={false} /> : null}
      {data && !shownLayout ? (
        <div className={ui.statementWrap}>
          <table id="changes-in-equity-report" className={`${ui.table} ${ui.statement}`}>
            <Head from={data.from} to={data.to} />
            <tbody>
              <Row label={`Equity at ${formatDate(data.from)}`} amount={data.openingEquity} total />
              <Row label="Net profit for the period" amount={data.profit} indent />
              <Lines rows={data.movements} />
            </tbody>
            <tfoot>
              <Row label={`Equity at ${formatDate(data.to)}`} amount={data.closingEquity} grand />
            </tfoot>
          </table>
        </div>
      ) : null}
    </ReportFrame>
  );
}

/** Statement of cash flows, indirect method (examples SCF1-SCF4). */
export function CashFlowStatementReport({ organisationId }: { organisationId: string }) {
  const yearEndMonth = useYearEndMonth(organisationId);
  const [dates, setDates] = usePeriod();
  const layout = useReportLayout(organisationId, "cash_flows");
  const [standard, setStandard] = useState(false);
  const report = useApiData<CashFlowStatement & { layout: { report: { id: string; title: string }; figures: CashFlowFigures } | null }>("/api/reports/cash-flow-statement", {
    organisationId,
    from: dates.from,
    to: dates.to,
    ...(standard ? { standard: "1" } : {}),
  });
  const data = report.data;
  const shownLayout = data?.layout ?? null;
  const title = "Statement of cash flows";
  const period = data ? statementPeriod(data.from, data.to, yearEndMonth) : "";
  return (
    <ReportFrame
      label={title}
      toolbar={
        <ReportToolbar
          mode="range"
          dates={dates}
          shownFrom={data?.from}
          yearEndMonth={yearEndMonth}
          onUpdate={setDates}
          busy={report.loading}
          more={[
            print,
            ...(layout.chosen ? [standard ? { label: `Show in ${layout.chosen.title}`, onSelect: () => setStandard(false) } : { label: "Show the standard layout", onSelect: () => setStandard(true) }] : []),
          ]}
          actions={data ? layout.button(data.to) : null}
          info={
            <>
              Cash is the bank accounts. Interest paid and received are in operating activities. Depreciation, livestock revaluations and unrealised
              exchange are added back because no cash moved.
            </>
          }
          exportProps={data ? { organisationId, report: "cash-flow-statement", title, period, style: "statement", tables: [{ id: "cash-flow-statement-report" }] } : null}
        />
      }
    >
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {layout.error ? <Notice tone="error">{layout.error}</Notice> : null}
      {data ? <StatementHeading title={title} period={period} lines={shownLayout ? [`In the layout ${shownLayout.report.title}`] : []} /> : null}
      {shownLayout ? <CashFlowTable figures={shownLayout.figures} showHidden={false} /> : null}
      {data && !data.reconciles ? (
        <Notice tone="warning">
          Cash at {formatDate(data.to)} doesn&apos;t match the bank accounts.
        </Notice>
      ) : null}
      {data && !shownLayout ? (
        <div className={ui.statementWrap}>
          <table id="cash-flow-statement-report" className={`${ui.table} ${ui.statement}`}>
            <Head from={data.from} to={data.to} />
            <tbody>
              <Heading>Operating activities</Heading>
              <Row label="Net profit" amount={data.operating.profit} indent />
              {data.operating.adjustments.length > 0 ? <Lines rows={data.operating.adjustments} /> : null}
              {data.operating.workingCapital.length > 0 ? (
                <>
                  <tr className={ui.reportSubheading}>
                    <td colSpan={2}>Movements in current assets and liabilities</td>
                  </tr>
                  <Lines rows={data.operating.workingCapital} />
                </>
              ) : null}
              <Row label="Net cash from operating activities" amount={data.operating.total} total />
              <Heading>Investing activities</Heading>
              <Lines rows={data.investing.lines} />
              {!isZeroText(data.investing.disposalProceeds) ? (
                <Row label="Proceeds from disposals of fixed assets" amount={data.investing.disposalProceeds} indent />
              ) : null}
              <Row label="Net cash from investing activities" amount={data.investing.total} total />
              <Heading>Financing activities</Heading>
              <Lines rows={data.financing.lines} />
              <Row label="Net cash from financing activities" amount={data.financing.total} total />
              <Row label="Net increase (decrease) in cash" amount={data.netChange} total />
              {!isZeroText(data.exchangeOnCash) ? <Row label="Effect of exchange rates on cash" amount={data.exchangeOnCash} indent /> : null}
              <Row label={`Cash at ${formatDate(data.from)}`} amount={data.openingCash} indent />
            </tbody>
            <tfoot>
              <Row label={`Cash at ${formatDate(data.to)}`} amount={data.closingCash} grand />
            </tfoot>
          </table>
        </div>
      ) : null}
    </ReportFrame>
  );
}

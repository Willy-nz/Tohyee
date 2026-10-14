"use client";

import { useState } from "react";
import { Money } from "@/components/books";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { ReportExport } from "@/components/reports/report-export";
import { Badge, Card, Field, Notice, ui } from "@/components/ui";
import { formatDate, todayInBrowser } from "@/lib/format";
import type { cashFlowStatement, changesInEquity, StatementRow } from "@/lib/reports/statements";

type ChangesInEquity = Awaited<ReturnType<typeof changesInEquity>>;
type CashFlowStatement = Awaited<ReturnType<typeof cashFlowStatement>>;

/** From and to dates; no "from" means the financial year to date (the server works it out). */
function usePeriod() {
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState(todayInBrowser);
  return { from, setFrom, to, setTo };
}

function PeriodFields({ period, shownFrom }: { period: ReturnType<typeof usePeriod>; shownFrom: string | undefined }) {
  return (
    <div className={ui.inlineForm}>
      <Field label="From">
        <DateInput value={period.from ?? shownFrom ?? ""} onChange={(event) => period.setFrom(event.target.value || null)} />
      </Field>
      <Field label="To">
        <DateInput value={period.to} onChange={(event) => period.setTo(event.target.value)} />
      </Field>
    </div>
  );
}

function Row({ label, amount, total, indent }: { label: string; amount: string; total?: boolean; indent?: boolean }) {
  return (
    <tr className={total ? ui.reportTotal : ui.reportSection}>
      <td style={indent ? { paddingLeft: 24 } : undefined}>{label}</td>
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
        <Row key={`${row.accountId ?? row.label}`} label={row.code ? `${row.code} · ${row.label}` : row.label} amount={row.amount} indent />
      ))}
    </>
  );
}

const isZeroText = (amount: string) => /^-?0(\.0+)?$/.test(amount);
const periodText = (from: string, to: string) => `${formatDate(from)} to ${formatDate(to)}`;

/** Statement of changes in equity (examples SCE1, SCE2). */
export function ChangesInEquityReport({ organisationId }: { organisationId: string }) {
  const period = usePeriod();
  const report = useApiData<ChangesInEquity>("/api/reports/changes-in-equity", { organisationId, from: period.from, to: period.to });
  const data = report.data;
  return (
    <Card title="Statement of changes in equity" actions={<PeriodFields period={period} shownFrom={data?.from} />}>
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {data ? (
        <>
          <ReportExport
            organisationId={organisationId}
            report="changes-in-equity"
            title="Statement of changes in equity"
            period={periodText(data.from, data.to)}
            tables={[{ id: "changes-in-equity-report", columns: ["Item", "Amount"] }]}
          />
          <div className={ui.tableWrap}>
            <table id="changes-in-equity-report" className={ui.table}>
              <tbody>
                <Row label={`Equity at ${formatDate(data.from)}`} amount={data.openingEquity} total />
                <Row label="Net profit for the period" amount={data.profit} indent />
                <Lines rows={data.movements} />
              </tbody>
              <tfoot>
                <tr>
                  <td>
                    Equity at {formatDate(data.to)} ({data.currencyCode}){" "}
                    {data.reconciles ? <Badge tone="green">Matches the balance sheet</Badge> : <Badge tone="red">Doesn&apos;t match the balance sheet</Badge>}
                  </td>
                  <td className={ui.num}>
                    <Money value={data.closingEquity} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      ) : null}
    </Card>
  );
}

/** Statement of cash flows, indirect method (examples SCF1-SCF4). */
export function CashFlowStatementReport({ organisationId }: { organisationId: string }) {
  const period = usePeriod();
  const report = useApiData<CashFlowStatement>("/api/reports/cash-flow-statement", { organisationId, from: period.from, to: period.to });
  const data = report.data;
  return (
    <Card title="Statement of cash flows" actions={<PeriodFields period={period} shownFrom={data?.from} />}>
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {data ? (
        <>
          <ReportExport
            organisationId={organisationId}
            report="cash-flow-statement"
            title="Statement of cash flows"
            period={periodText(data.from, data.to)}
            tables={[{ id: "cash-flow-statement-report", columns: ["Item", "Amount"] }]}
          />
          <div className={ui.tableWrap}>
            <table id="cash-flow-statement-report" className={ui.table}>
              <tbody>
                <Heading>Operating activities</Heading>
                <Row label="Net profit" amount={data.operating.profit} indent />
                {data.operating.adjustments.length > 0 ? <Lines rows={data.operating.adjustments} /> : null}
                {data.operating.workingCapital.length > 0 ? (
                  <>
                    <tr>
                      <td className={ui.muted} colSpan={2}>
                        Movements in current assets and liabilities
                      </td>
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
                <tr>
                  <td>
                    Cash at {formatDate(data.to)} ({data.currencyCode}){" "}
                    {data.reconciles ? <Badge tone="green">Matches the bank accounts</Badge> : <Badge tone="red">Doesn&apos;t match the bank accounts</Badge>}
                  </td>
                  <td className={ui.num}>
                    <Money value={data.closingCash} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className={ui.muted}>
            Cash is the bank accounts. Interest paid and received are in operating activities. Depreciation, livestock revaluations and unrealised
            exchange are added back because no cash moved.
          </p>
        </>
      ) : null}
    </Card>
  );
}

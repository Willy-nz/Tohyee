"use client";

import Link from "next/link";
import { useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { PrintButton } from "@/components/reports/ledger-reports";
import { Card, Empty, Field, Notice, ui } from "@/components/ui";
import { formatDate, todayInBrowser } from "@/lib/format";
import type { GstAuditBox, GstAuditEntry, GstAuditReport } from "@/lib/reports/gst-audit";
import { GST_BOX_KEYS, GST_BOX_LABELS, GST_RETURN_PERIOD_MONTHS, gstBoxNumber, gstPeriodEnd } from "@/lib/reports/gst-boxes";
import type { FiledGstReturnSummary } from "@/lib/reports/gst-return";
import { GST_BASIS_LABELS } from "@/lib/tax/categories";

/**
 * Tax › GST audit report (examples GA1-GA4): the documents behind each GST
 * return box for a period on the organisation's basis, or a filed return as
 * it was filed. Each list adds up to its box.
 */

const EVENT_LABELS: Record<GstAuditEntry["eventType"], string> = {
  invoice_approved: "Invoice",
  invoice_voided: "Invoice voided",
  credit_note_approved: "Credit note",
  credit_note_voided: "Credit note voided",
  bill_approved: "Bill",
  bill_voided: "Bill voided",
  supplier_credit_note_approved: "Supplier credit note",
  supplier_credit_note_voided: "Supplier credit note voided",
  bank_transaction_posted: "Bank transaction",
  bank_transaction_voided: "Bank transaction voided",
  customer_payment: "Customer payment",
  customer_payment_voided: "Customer payment voided",
  credit_note_applied: "Credit applied",
  credit_note_application_removed: "Credit removed",
  credit_note_refunded: "Credit note refunded",
  credit_note_refund_voided: "Credit note refund voided",
  overpayment_applied: "Overpayment applied",
  overpayment_application_removed: "Overpayment removed",
  supplier_payment: "Supplier payment",
  supplier_payment_voided: "Supplier payment voided",
  supplier_credit_note_applied: "Supplier credit applied",
  supplier_credit_note_application_removed: "Supplier credit removed",
  supplier_credit_note_refunded: "Supplier refund received",
  supplier_credit_note_refund_voided: "Supplier refund voided",
};

function EntriesTable({ title, entries, total, gst }: { title: string; entries: GstAuditEntry[]; total: string; gst?: string }) {
  return (
    <section className={ui.reportPaperBlock}>
      <h3 className={ui.reportBlockTitle}>{title}</h3>
      {entries.length === 0 ? (
        <p className={ui.muted}>Nothing in this box.</p>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>What</th>
                <th>Document</th>
                <th>Contact</th>
                <th className={ui.num}>Settled of total</th>
                <th className={ui.num}>GST</th>
                <th className={ui.num}>Amount incl. GST</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={index}>
                  <td>{formatDate(entry.eventDate)}</td>
                  <td>{EVENT_LABELS[entry.eventType]}</td>
                  <td>
                    <Link href={entry.href}>{entry.documentNumber}</Link>
                    {entry.lineCount > 1 ? <span className={ui.muted}> · {entry.lineCount} lines</span> : null}
                  </td>
                  <td>{entry.contactName}</td>
                  <td className={ui.num}>
                    {entry.settledAmount ? (
                      <>
                        <Money value={entry.settledAmount} /> of <Money value={entry.documentTotal} />
                      </>
                    ) : null}
                  </td>
                  <td className={ui.num}>
                    <Money value={entry.gst} />
                  </td>
                  <td className={ui.num}>
                    <Money value={entry.amount} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5}>Total</td>
                <td className={ui.num}>{gst !== undefined ? <Money value={gst} /> : null}</td>
                <td className={ui.num}>
                  <Money value={total} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function boxTitle(box: GstAuditBox): string {
  return `Box ${box.box}: ${GST_BOX_LABELS[`box${box.box}`]}`;
}

function AuditPaper({ report }: { report: GstAuditReport }) {
  return (
    <article className={ui.reportPaper}>
      <header className={ui.reportPaperHeader}>
        <h2 className={ui.reportPaperTitle}>GST audit report</h2>
        <p className={ui.reportPaperMeta}>
          {formatDate(report.periodStart)} to {formatDate(report.periodEnd)} · {GST_BASIS_LABELS[report.basis]} · {report.currencyCode}
          {report.gstReturnId ? " · as filed" : " · worked out now"}
        </p>
      </header>
      <section className={ui.reportPaperBlock}>
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <tbody>
              {GST_BOX_KEYS.map((box) => (
                <tr key={box}>
                  <td>
                    Box {gstBoxNumber(box)} · {GST_BOX_LABELS[box]}
                  </td>
                  <td className={ui.num}>
                    <Money value={report.boxes[box]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <EntriesTable title={boxTitle(report.box5)} entries={report.box5.entries} total={report.box5.total} gst={report.box5.gst} />
      <EntriesTable title={boxTitle(report.box6)} entries={report.box6.entries} total={report.box6.total} gst={report.box6.gst} />
      <p className={ui.muted}>
        Box 7 = Box 5 less Box 6 = <Money value={report.boxes.box7} />. Box 8 = Box 7 x 3 / 23 = <Money value={report.boxes.box8} /> (the sales
        lines&apos; own GST is <Money value={report.gstOnTransactions.sales} />; the difference is rounding).
      </p>
      <EntriesTable title={boxTitle(report.box11)} entries={report.box11.entries} total={report.box11.total} gst={report.box11.gst} />
      <p className={ui.muted}>
        Box 12 = Box 11 x 3 / 23 = <Money value={report.boxes.box12} /> (the purchase lines&apos; own GST is{" "}
        <Money value={report.gstOnTransactions.purchases} />
        ).
      </p>
      <section className={ui.reportPaperBlock}>
        <h3 className={ui.reportBlockTitle}>Adjustments (Box 9 and Box 13)</h3>
        {report.adjustments.length === 0 ? (
          <p className={ui.muted}>No adjustments.</p>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <tbody>
                {report.adjustments.map((adjustment, index) => (
                  <tr key={index}>
                    <td>Box {adjustment.box}</td>
                    <td>{adjustment.description}</td>
                    <td className={ui.num}>
                      <Money value={adjustment.amount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <EntriesTable title="Left out of every box (no tax, exempt, out of scope, zero-rated purchases)" entries={report.leftOut.entries} total={report.leftOut.total} />
    </article>
  );
}

function monthStart(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

export function GstAuditView({ organisationId }: { organisationId: string }) {
  const [start, setStart] = useState(() => monthStart(todayInBrowser()));
  const [months, setMonths] = useState<number>(2);
  const [filedId, setFiledId] = useState("");
  const periodEnd = gstPeriodEnd(start, months);
  const filed = useApiData<{ gstReturns: FiledGstReturnSummary[] }>("/api/gst-returns", { organisationId });
  const report = useApiData<GstAuditReport>(
    "/api/reports/gst-audit",
    filedId ? { organisationId, gstReturnId: filedId } : { organisationId, periodStart: start, periodEnd },
  );
  return (
    <>
      <Card
        title="GST audit report"
        description="Every document behind each box of the GST return, adding up to the box to the cent."
        actions={report.data ? <PrintButton /> : null}
      >
        <div className={ui.inlineForm} data-print="hide">
          <Field label="Filed return">
            <select value={filedId} onChange={(event) => setFiledId(event.target.value)}>
              <option value="">None: work it out now</option>
              {(filed.data?.gstReturns ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {formatDate(entry.periodStart)} to {formatDate(entry.periodEnd)}
                </option>
              ))}
            </select>
          </Field>
          {filedId ? null : (
            <>
              <Field label="Start month">
                <input
                  type="month"
                  value={start.slice(0, 7)}
                  onChange={(event) => {
                    if (/^\d{4}-\d{2}$/.test(event.target.value)) setStart(`${event.target.value}-01`);
                  }}
                />
              </Field>
              <Field label="Length">
                <select value={months} onChange={(event) => setMonths(Number(event.target.value))}>
                  {GST_RETURN_PERIOD_MONTHS.map((length) => (
                    <option key={length} value={length}>
                      {length === 1 ? "1 month" : `${length} months`}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
        </div>
        <p className={ui.muted}>
          Adjustments typed on the <Link href="/operations/gst-return">GST return</Link> aren&apos;t kept until it&apos;s filed, so a return worked out
          now is audited without them; choose the filed return to see its adjustments.
        </p>
        {report.error ? <Notice tone="error">{report.error}</Notice> : null}
        {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      </Card>
      {report.data ? (
        report.data.box5.entries.length + report.data.box11.entries.length + report.data.leftOut.entries.length === 0 &&
        report.data.adjustments.length === 0 ? (
          <Empty>Nothing counts in this period.</Empty>
        ) : (
          <AuditPaper report={report.data} />
        )
      ) : null}
    </>
  );
}

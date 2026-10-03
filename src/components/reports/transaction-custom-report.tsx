"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Money } from "@/components/books";
import { ReportExport } from "@/components/reports/report-export";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, personName } from "@/lib/format";
import type { CustomReport } from "@/lib/reports/custom";
import type { AnyCustomReportFigures } from "@/lib/reports/custom";
import type {
  TransactionCustomReportFigures,
  TransactionReportBase,
  TransactionReportColumn,
  TransactionReportLayout,
} from "@/lib/reports/custom-layout";

type Loaded = { report: CustomReport; figures: AnyCustomReportFigures };
type TableRow = { kind?: "section" | "total"; values: Record<string, unknown> };

function displayValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "";
  return "";
}

function reportRows(figures: TransactionCustomReportFigures): TableRow[] {
  const data = figures.data as Record<string, unknown>;
  const rows: TableRow[] = [];
  const push = (values: Record<string, unknown>, kind?: TableRow["kind"]) => rows.push({ values, kind });
  if (figures.base === "account_transactions") {
    const accounts = (data.accounts ?? []) as Array<Record<string, unknown>>;
    for (const account of accounts) {
      const lines = (account.lines ?? []) as Array<Record<string, unknown>>;
      push({ date: `${account.code} · ${account.name}` }, "section");
      push({ description: "Opening balance", balance: account.opening });
      for (const line of lines) {
        const source = line.source as Record<string, unknown> | null;
        push({
          ...line,
          source: source?.label,
          "contact.name": source?.contactName,
          columnValues: line.columnValues,
        });
      }
      push(
        {
          description: `Closing balance ${account.code}`,
          debit: account.totalDebit,
          credit: account.totalCredit,
          balance: account.closing,
        },
        "total",
      );
    }
    push({ description: "Total", debit: data.totalDebit, credit: data.totalCredit }, "total");
  } else if (figures.base === "aged_receivables" || figures.base === "aged_payables") {
    const aged = (data.rows ?? []) as Array<Record<string, unknown>>;
    for (const row of aged) {
      const amounts = row.amounts as Record<string, unknown>;
      push({
        ...amounts,
        "contact.name": row.name,
        "contact.email": row.contactEmail,
        "contact.address": row.contactAddress,
        "contact.group": row.contactGroup,
        total: amounts.total,
        columnValues: row.columnValues,
      });
      const detailRows =
        figures.base === "aged_receivables"
          ? ((row.invoices ?? []) as Array<Record<string, unknown>>).map((invoice) => ({
              "contact.name": row.name,
              "document.date": invoice.invoiceDate,
              "document.reference": invoice.invoiceNumber,
              "document.amount": invoice.amountDueBase,
              columnValues: invoice.columnValues,
            }))
          : [
              ...((row.bills ?? []) as Array<Record<string, unknown>>).map((bill) => ({
                "contact.name": row.name,
                "document.date": bill.billDate,
                "document.reference": bill.supplierInvoiceNumber,
                "document.amount": bill.amountDueBase,
                columnValues: bill.columnValues,
              })),
              ...((row.credits ?? []) as Array<Record<string, unknown>>).map((credit) => ({
                "contact.name": row.name,
                "document.date": credit.creditNoteDate,
                "document.reference": credit.supplierCreditNoteNumber,
                "document.amount": `-${credit.unusedBase}`,
                columnValues: credit.columnValues,
              })),
            ];
      detailRows.forEach((detail) => push(detail));
    }
    const total = data.total as Record<string, unknown> | undefined;
    if (total) push({ ...total, total: total.total }, "total");
  } else if (figures.base === "sales_by_salesperson") {
    const salesRows = (data.rows ?? []) as Array<Record<string, unknown>>;
    for (const row of salesRows) {
      push({
        ...row,
        salesperson: row.name,
        "contact.name": row.contactName,
        columnValues: row.columnValues,
      });
      for (const document of (row.documents ?? []) as Array<Record<string, unknown>>) {
        push({
          "document.date": document.date,
          "document.reference": document.number,
          "document.amount": document.amount,
          "contact.name": document.contactName,
          columnValues: document.columnValues,
        });
      }
    }
    const total = data.total as Record<string, unknown> | undefined;
    if (total) push({ ...total, salesperson: "Total" }, "total");
  } else {
    const journals = (data.journals ?? []) as Array<Record<string, unknown>>;
    for (const journal of journals) {
      const source = journal.source as Record<string, unknown>;
      push({
        date: journal.date,
        source: source?.label,
        description: journal.description,
        "contact.name": source?.contactName,
        postedBy: personName(journal, "postedBy"),
        postedAt: journal.postedAt,
        columnValues: journal.columnValues,
      }, "section");
      for (const line of (journal.lines ?? []) as Array<Record<string, unknown>>) {
        push({
          ...line,
          account: `${line.accountCode} · ${line.accountName}`,
          debit: line.debit,
          credit: line.credit,
          columnValues: line.columnValues,
        });
      }
      push({ account: "Journal total", debit: journal.totalDebit, credit: journal.totalCredit }, "total");
    }
    push({ account: "Total", debit: data.totalDebit, credit: data.totalCredit }, "total");
  }
  return rows;
}

function cellValue(row: TableRow, column: TransactionReportColumn): unknown {
  const values = row.values;
  const custom = values.columnValues as Record<string, unknown> | undefined;
  return custom?.[column.key] ?? values[column.key];
}

export function TransactionCustomReportPage({ organisationId, loaded }: { organisationId: string; loaded: Loaded }) {
  const router = useRouter();
  const { can, current } = useWorkspace();
  const [saved, setSaved] = useState(loaded);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editingColumns, setEditingColumns] = useState(false);
  const [title, setTitle] = useState(saved.report.title);
  const [columns, setColumns] = useState<string[]>([]);
  const [addColumn, setAddColumn] = useState("");
  const [publishKey, setPublishKey] = useState(() => newIdempotencyKey("custom-report-publish"));
  const report = saved.report as CustomReport & { base: TransactionReportBase; layout: TransactionReportLayout };
  const figures = saved.figures as TransactionCustomReportFigures;
  const editable = report.kind === "draft" && !report.archivedAt && can("bookkeeper");

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await work();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveLayout(next: TransactionReportLayout) {
    const result = await api<Loaded>(`/api/custom-reports/${report.id}`, {
      method: "PUT",
      body: { organisationId, layout: next, version: report.version },
    });
    setSaved(result);
    setTitle(result.report.title);
    setColumns([]);
    setEditingColumns(false);
  }

  const exportId = `custom-report-${report.id}`;
  const exportName = {
    account_transactions: "account-transactions",
    aged_receivables: "aged-receivables",
    aged_payables: "aged-payables",
    sales_by_salesperson: "sales-by-salesperson",
    journal_report: "journal-report",
  }[report.base] as "account-transactions" | "aged-receivables" | "aged-payables" | "sales-by-salesperson" | "journal-report";
  const options = figures.columnOptions;
  const selectedColumns = report.layout.columns
    .map((key) => options.find((option) => option.key === key))
    .filter((column): column is TransactionReportColumn => Boolean(column));
  const rows = reportRows(figures);
  const period = report.base === "aged_receivables" || report.base === "aged_payables"
    ? `As at ${formatDate(report.layout.filters.asAt)}`
    : `${report.layout.filters.from ? formatDate(report.layout.filters.from) : "Start of financial year"} to ${formatDate(report.layout.filters.to)}`;

  return (
    <>
      <div className={ui.actions} data-print="hide">
        <Link href={`/operations/reports?view=${report.archivedAt ? "archived" : report.kind === "published" ? "published" : "drafts"}`}>← Reports</Link>
        {report.kind === "published" ? <Badge tone="blue">Published</Badge> : <Badge>Draft</Badge>}
        {report.archivedAt ? <Badge tone="amber">Archived</Badge> : null}
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {report.kind === "published" ? (
        <Notice tone="info">
          A frozen copy, published {formatDateTime(report.publishedAt)} by {personName(report, "publishedBy")}.{" "}
          {report.publishedFromId ? <Link href={`/operations/reports/custom/${report.publishedFromId}`}>Open its draft</Link> : null}
        </Notice>
      ) : null}
      <div className={ui.toolbar} data-print="hide">
        {editable ? (
          <>
            <Button size="small" variant="secondary" disabled={busy} onClick={() => { setColumns([...report.layout.columns]); setEditingColumns(true); }}>
              Columns…
            </Button>
            <Button size="small" disabled={busy} onClick={() => void run(async () => {
              const result = await api<{ report: CustomReport }>(`/api/custom-reports/${report.id}/publish`, {
                method: "POST",
                body: { organisationId, source: "ui", idempotencyKey: publishKey },
              });
              setPublishKey(newIdempotencyKey("custom-report-publish"));
              router.push(`/operations/reports/custom/${result.report.id}`);
            })}>
              Publish
            </Button>
          </>
        ) : null}
        <Button size="small" variant="secondary" onClick={() => window.print()}>Print or save as PDF</Button>
        {can("bookkeeper") ? (
          <Button size="small" variant="secondary" disabled={busy} onClick={() => void run(async () => {
            const result = await api<{ report: CustomReport }>(`/api/custom-reports/${report.id}/archive`, {
              method: "POST",
              body: { organisationId, archived: !report.archivedAt },
            });
            setSaved({ ...saved, report: result.report });
          })}>
            {report.archivedAt ? "Bring back" : "Archive"}
          </Button>
        ) : null}
      </div>
      {editingColumns ? (
        <Card title="Report columns" description="Add, remove or reorder columns. The report figures stay the same.">
          <div className={ui.actions}>
            <Field label="Add a column">
              <select value={addColumn} onChange={(event) => setAddColumn(event.target.value)}>
                <option value="">Choose a column</option>
                {options.filter((option) => !columns.includes(option.key)).map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
            </Field>
            <Button variant="secondary" disabled={!addColumn} onClick={() => {
              if (addColumn) setColumns([...columns, addColumn]);
              setAddColumn("");
            }}>Add</Button>
          </div>
          <ol>
            {columns.map((key, index) => (
              <li key={key} className={ui.actions}>
                <span>{options.find((option) => option.key === key)?.label ?? key}</span>
                <Button size="small" variant="secondary" disabled={index === 0} onClick={() => setColumns(columns.map((entry, i) => i === index - 1 ? key : i === index ? columns[index - 1] : entry))}>Move up</Button>
                <Button size="small" variant="secondary" disabled={index === columns.length - 1} onClick={() => setColumns(columns.map((entry, i) => i === index ? columns[index + 1] : i === index + 1 ? key : entry))}>Move down</Button>
                <Button size="small" variant="secondary" onClick={() => setColumns(columns.filter((entry) => entry !== key))}>Remove</Button>
              </li>
            ))}
          </ol>
          <div className={ui.actions}>
            <Button disabled={busy || columns.length === 0} onClick={() => void run(() => saveLayout({ ...report.layout, columns }))}>
              {busy ? "Saving…" : "Save columns"}
            </Button>
            <Button variant="secondary" onClick={() => setEditingColumns(false)}>Cancel</Button>
          </div>
        </Card>
      ) : null}
      <article className={ui.reportPaper}>
        <header className={ui.reportPaperHeader}>
          {editable ? (
            <input
              data-print="hide"
              className={ui.reportTitleInput}
              aria-label="Report title"
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => {
                const nextTitle = title.trim();
                if (nextTitle && nextTitle !== report.title) void run(() => saveLayout({ ...report.layout, title: nextTitle }));
                else setTitle(report.title);
              }}
            />
          ) : null}
          <h2 className={`${ui.reportPaperTitle} ${editable ? ui.printOnly : ""}`}>{report.title}</h2>
          <p className={ui.reportPaperMeta}>{current?.displayName}<br />{selectedColumns.length} columns · {period} · {figures.currencyCode}</p>
        </header>
        <ReportExport organisationId={organisationId} report={exportName} title={report.title} period={period} tables={[{ id: exportId }]} />
        <div className={ui.tableWrap}>
          <table id={exportId} className={ui.table}>
            <thead><tr>{selectedColumns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index} className={row.kind === "section" ? ui.reportHeading : row.kind === "total" ? ui.reportTotal : undefined}>
                  {selectedColumns.map((column) => {
                    const value = cellValue(row, column);
                    return                     <td key={column.key} className={["debit", "credit", "balance", "total", "current", "days1to30", "days31to60", "days61to90", "over90", "sales", "creditNotes", "netSales", "document.amount"].includes(column.key) ? ui.num : undefined}>
                      {typeof value === "string" && /^-?\d+\.\d{2}$/.test(value) ? <Money value={value} blankZero /> : displayValue(value)}
                    </td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
      {busy ? <p className={ui.muted}>Saving…</p> : null}
    </>
  );
}

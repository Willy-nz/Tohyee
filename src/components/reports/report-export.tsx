"use client";

import { useMemo, useState } from "react";
import { Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { apiDownload, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import type { ReportExportData, ReportExportName, ReportExportRow, ReportExportTable } from "@/lib/reports/export-types";

export type ReportExportTableTarget = { id: string; title?: string; columns?: string[] };

function cellValue(cell: HTMLTableCellElement) {
  const text = cell.innerText.replace(/\s+/g, " ").trim();
  const candidates = [...cell.querySelectorAll<HTMLElement>("[data-export-value]")];
  const valueNode = candidates.find((candidate) => !candidate.parentElement?.closest("[data-export-value]"));
  const value = valueNode?.dataset.exportValue;
  if (value && text === valueNode?.innerText.replace(/\s+/g, " ").trim() && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    return { text, value, numeric: true };
  }
  return { text };
}

function tableData(target: ReportExportTableTarget): ReportExportTable {
  const table = document.getElementById(target.id);
  if (!(table instanceof HTMLTableElement)) throw new Error("The report table isn't available to export.");
  const headers = target.columns ?? [...table.querySelectorAll<HTMLTableRowElement>("thead tr")].flatMap((row) =>
    [...row.cells].flatMap((cell) => [cell.innerText.replace(/\s+/g, " ").trim(), ...Array.from({ length: cell.colSpan - 1 }, () => "")]),
  );
  if (headers.length === 0) throw new Error("The report has no column headings to export.");
  const rows: ReportExportRow[] = [];
  const bodyRows = [...table.tBodies].flatMap((body) => [...body.rows]);
  const footerRows = table.tFoot ? [...table.tFoot.rows] : [];
  for (const row of [...bodyRows, ...footerRows]) {
    const cells = [...row.cells].flatMap((cell) => [cellValue(cell), ...Array.from({ length: cell.colSpan - 1 }, () => ({ text: "" }))]);
    const kind = row.classList.contains(ui.reportHeading) ? "section" : row.classList.contains(ui.reportTotal) ? "total" : undefined;
    rows.push({ cells, kind });
  }
  return { title: target.title, columns: headers, rows };
}

export function ReportExport({
  organisationId,
  report,
  title,
  period,
  basis = null,
  filters = [],
  tables,
}: {
  organisationId: string;
  report: ReportExportName;
  title: string;
  period: string;
  basis?: string | null;
  filters?: string[];
  tables: ReportExportTableTarget[];
}) {
  const { current } = useWorkspace();
  const organisationName = current?.id === organisationId ? current.displayName : "Organisation";
  const filterText = filters.join(" · ");
  const producedAt = useMemo(() => new Date().toISOString(), [title, period, basis, filterText]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download(format: "csv" | "xlsx" | "pdf") {
    setBusy(true);
    setError(null);
    try {
      const data: ReportExportData = {
        report,
        organisationName,
        title,
        period,
        basis,
        filters,
        producedAt,
        tables: tables.map(tableData),
      };
      const blob = await apiDownload("/api/reports/export", { organisationId, format, data });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `tohyee-${report}.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={ui.reportMeta}>
        <div className={ui.reportMetaText}>
          <strong>{organisationName}</strong>
          <span className={ui.reportMetaTitle}>{title}</span>
          <span>{period}</span>
          {basis ? <span>Basis: {basis}</span> : null}
          {filterText ? <span>Filters: {filterText}</span> : null}
          {producedAt ? <span>Produced: {formatDateTime(producedAt)}</span> : null}
        </div>
        <details className={ui.reportExport} data-print="hide">
          <summary className={`${ui.button} ${ui.secondary}`}>Export</summary>
          <div className={ui.reportExportMenu}>
            {(["csv", "xlsx", "pdf"] as const).map((format) => (
              <button key={format} type="button" disabled={busy} onClick={() => void download(format)}>
                {format === "csv" ? "CSV" : format === "xlsx" ? "Excel (.xlsx)" : "PDF"}
              </button>
            ))}
          </div>
        </details>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </>
  );
}

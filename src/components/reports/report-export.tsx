"use client";

import { useState } from "react";
import { MoreMenu } from "@/components/more-menu";
import { ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { apiDownload, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import type { ReportExportData, ReportExportName, ReportExportRow, ReportExportTable } from "@/lib/reports/export-types";

export type ReportExportTableTarget = { id: string; title?: string; columns?: string[] };

/** A cell's text, leaving out what's marked data-export-ignore (an (i) button, a badge). */
function cellText(cell: HTMLTableCellElement): string {
  if (!cell.querySelector("[data-export-ignore]")) return cell.innerText;
  const copy = cell.cloneNode(true) as HTMLElement;
  for (const ignored of copy.querySelectorAll("[data-export-ignore]")) ignored.remove();
  return copy.textContent ?? "";
}

function cellValue(cell: HTMLTableCellElement) {
  const text = cellText(cell).replace(/\s+/g, " ").trim();
  const candidates = [...cell.querySelectorAll<HTMLElement>("[data-export-value]")];
  const valueNodes = candidates.filter((candidate) => !candidate.parentElement?.closest("[data-export-value]"));
  const valueNode = valueNodes.length === 1 ? valueNodes[0] : undefined;
  const value = valueNode?.dataset.exportValue;
  if (value && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    return { text, value, numeric: true };
  }
  const numericText = text.replaceAll(",", "");
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(numericText)) return { text, value: numericText, numeric: true };
  return { text };
}

function tableData(target: ReportExportTableTarget): ReportExportTable | null {
  const table = document.getElementById(target.id);
  if (!(table instanceof HTMLTableElement)) return null;
  const headers = target.columns ?? [...table.querySelectorAll<HTMLTableRowElement>("thead tr")].flatMap((row) =>
    [...row.cells].filter((cell) => !cell.dataset.exportIgnore).flatMap((cell) => [cell.innerText.replace(/\s+/g, " ").trim(), ...Array.from({ length: cell.colSpan - 1 }, () => "")]),
  );
  if (headers.length === 0) throw new Error("The report has no column headings to export.");
  const rows: ReportExportRow[] = [];
  const bodyRows = [...table.tBodies].flatMap((body) => [...body.rows]);
  const footerRows = table.tFoot ? [...table.tFoot.rows] : [];
  for (const row of [...bodyRows, ...footerRows]) {
    const cells = [...row.cells].filter((cell) => !cell.dataset.exportIgnore).flatMap((cell) => [cellValue(cell), ...Array.from({ length: cell.colSpan - 1 }, () => ({ text: "" }))]);
    const kind = row.classList.contains(ui.reportHeading)
      ? "section"
      : row.classList.contains(ui.reportGrand)
        ? "grand"
        : row.classList.contains(ui.reportTotal)
          ? "total"
          : row.classList.contains(ui.reportSection)
            ? "account"
            : undefined;
    rows.push({ cells, kind });
  }
  return { title: target.title, columns: headers, rows };
}

export type ReportExportProps = {
  organisationId: string;
  report: ReportExportName;
  title: string;
  period: string;
  basis?: string | null;
  filters?: string[];
  tables: ReportExportTableTarget[];
  /** Statements export without grid lines, with lines above totals (decision 1351). */
  style?: "statement" | "table";
  /** Which files to offer; all three by default. */
  formats?: Array<"pdf" | "csv" | "xlsx">;
};

const FORMAT_LABELS = { pdf: "PDF", csv: "CSV", xlsx: "Excel (.xlsx)" } as const;

/**
 * Downloads the report as shown, as a PDF, CSV or Excel file (decision
 * 1352): the tables are read from the page, so the file has the same rows,
 * labels and totals as the screen. Returns when it's done, with an error
 * message or null.
 */
function useReportDownload(props: ReportExportProps) {
  const { current } = useWorkspace();
  const organisationName = current?.id === props.organisationId ? current.displayName : "Organisation";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [producedAt, setProducedAt] = useState(() => new Date().toISOString());

  async function download(format: "csv" | "xlsx" | "pdf") {
    setBusy(true);
    setError(null);
    try {
      const exportProducedAt = new Date().toISOString();
      setProducedAt(exportProducedAt);
      const data: ReportExportData = {
        report: props.report,
        organisationName,
        title: props.title,
        period: props.period,
        basis: props.basis ?? null,
        filters: props.filters ?? [],
        producedAt: exportProducedAt,
        style: props.style ?? "table",
        tables: props.tables.map(tableData).filter((table): table is ReportExportTable => table !== null),
      };
      const blob = await apiDownload("/api/reports/export", { organisationId: props.organisationId, format, data });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `tohyee-${props.report}.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return { organisationName, busy, error, producedAt, download };
}

/** The Export menu button (PDF, CSV, Excel), the same on every report (decision 1352). */
export function ExportMenu(props: ReportExportProps) {
  const { busy, error, download } = useReportDownload(props);
  const formats = props.formats ?? ["pdf", "csv", "xlsx"];
  return (
    <span className={ui.reportExport} data-print="hide">
      <MoreMenu
        text={busy ? "Exporting…" : "Export"}
        label="Export"
        items={formats.map((format) => ({ label: FORMAT_LABELS[format], disabled: busy, onSelect: () => void download(format) }))}
      />
      {error ? (
        <span role="alert" className={ui.reportExportError}>
          {error}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A report's printed heading (organisation, title, period, filters, when
 * it was produced) with the Export menu beside it, for reports that don't
 * use the statement layout of `report-frame.tsx`.
 */
export function ReportExport(props: ReportExportProps) {
  const { organisationName, producedAt } = useReportDownload(props);
  const filterText = (props.filters ?? []).join(" · ");
  return (
    <>
      <div className={ui.reportMeta}>
        <div className={ui.reportMetaText}>
          <strong>{organisationName}</strong>
          <span className={ui.reportMetaTitle}>{props.title}</span>
          <span>{props.period}</span>
          {props.basis ? <span>Basis: {props.basis}</span> : null}
          {filterText ? <span>Filters: {filterText}</span> : null}
          {producedAt ? <span>Produced: {formatDateTime(producedAt)}</span> : null}
        </div>
        <ExportMenu {...props} />
      </div>
    </>
  );
}

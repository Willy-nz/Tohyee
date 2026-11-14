"use client";

import { useApiData } from "@/components/hooks";
import { CashFlowTable } from "@/components/reports/cash-flow-custom-report";
import { CustomFiguresTable } from "@/components/reports/custom-report-table";
import { EquityTable } from "@/components/reports/equity-custom-report";
import { Field, Notice, ui } from "@/components/ui";
import type { ReportItem } from "@/lib/analytics/items";
import { formatDate } from "@/lib/format";
import type { CashFlowFigures } from "@/lib/reports/cash-flow-layout";
import { CUSTOM_REPORT_BASES, type CustomReportBase, type CustomReportFigures } from "@/lib/reports/custom-layout";
import type { EquityFigures } from "@/lib/reports/equity-layout";
import styles from "./items.module.css";

/**
 * An accounting report on an Analytics page (#710): a custom report from
 * Reports, drawn in statement style as it prints. A draft is worked out when
 * the page is read; a published one is its frozen copy.
 */

type Placed =
  | { gone: true }
  | {
      gone?: undefined;
      report: { id: string; title: string; kind: "draft" | "published"; base: CustomReportBase; publishedAt: string | null };
      figures: CustomReportFigures | CashFlowFigures | EquityFigures | { base: string };
    };

/** A custom report's tables, by what kind of report it is. Lists of transactions aren't drawn here yet. */
function Statement({ tileId, figures }: { tileId: string; figures: Exclude<Placed, { gone: true }>["figures"] }) {
  if (figures.base === "cash_flows") return <CashFlowTable figures={figures as CashFlowFigures} showHidden={false} />;
  if (figures.base === "changes_in_equity" && "opening" in figures) return <EquityTable figures={figures as EquityFigures} showHidden={false} id={`placed-report-${tileId}`} />;
  if (figures.base === "profit_and_loss" || figures.base === "balance_sheet") {
    const statement = figures as CustomReportFigures;
    return (
      <>
        {statement.blocks.map((block) =>
          block.kind === "text" ? (
            <p key={block.id} className={styles.reportNote}>
              {block.text}
            </p>
          ) : (
            <div key={block.id}>
              {block.title ? <h3 className={ui.reportBlockTitle}>{block.title}</h3> : null}
              <CustomFiguresTable id={`placed-report-${tileId}-${block.id}`} block={block} figures={statement} filter={null} />
            </div>
          ),
        )}
      </>
    );
  }
  return <Notice tone="info">This kind of report (a list) can&apos;t be shown on an Analytics page yet. Open it under Reports.</Notice>;
}

export function ReportItemView({ organisationId, dashboardId, tileId, saved }: { organisationId: string; dashboardId: string; tileId: string; saved: boolean }) {
  const placed = useApiData<Placed>(saved ? `/api/analytics/dashboards/${encodeURIComponent(dashboardId)}/reports/${encodeURIComponent(tileId)}` : null, { organisationId });
  if (!saved) return <p className={ui.muted}>The report shows here once this change is saved.</p>;
  if (placed.error) return <Notice tone="warning">{placed.error}</Notice>;
  if (!placed.data) return <p className={ui.muted}>Loading the report…</p>;
  if (placed.data.gone) return <Notice tone="warning">This report has been archived or deleted in Reports. Choose Edit to pick another, or remove this tile.</Notice>;
  const { report, figures } = placed.data;
  return (
    <div className={styles.placedReport}>
      <p className={styles.placedReportKind}>
        {report.kind === "published" && report.publishedAt ? `Published ${formatDate(report.publishedAt.slice(0, 10))}: a frozen copy.` : "Draft: worked out from the books just now."}
      </p>
      <Statement tileId={tileId} figures={figures} />
    </div>
  );
}

type Listed = { id: string; title: string; base: CustomReportBase; kind: "draft" | "published"; publishedAt: string | null };

/** Chooses the report a tile shows, from Reports › Published and Drafts. */
export function ReportPicker({ organisationId, value, onChange }: { organisationId: string; value: ReportItem | null; onChange: (report: ReportItem, title: string) => void }) {
  const drafts = useApiData<{ reports: Listed[] }>("/api/custom-reports", { organisationId, view: "drafts" });
  const published = useApiData<{ reports: Listed[] }>("/api/custom-reports", { organisationId, view: "published" });
  const error = drafts.error ?? published.error;
  if (error) return <Notice tone="error">{error}</Notice>;
  const all = [...(published.data?.reports ?? []), ...(drafts.data?.reports ?? [])];
  const option = (report: Listed) => (
    <option key={report.id} value={report.id}>
      {report.title} ({CUSTOM_REPORT_BASES[report.base]}
      {report.kind === "published" && report.publishedAt ? `, published ${formatDate(report.publishedAt.slice(0, 10))}` : ""})
    </option>
  );
  return (
    <Field label="Report" hint="A published report is a frozen copy, and the only kind a client you share this with can see. A draft is worked out from the books each time.">
      <select
        value={value?.id ?? ""}
        onChange={(event) => {
          const chosen = all.find((report) => report.id === event.target.value);
          if (chosen) onChange({ id: chosen.id }, chosen.title);
        }}
      >
        <option value="">{drafts.data && published.data ? (all.length ? "Choose a report…" : "No custom reports yet: make one under Reports") : "Loading…"}</option>
        {published.data?.reports.length ? <optgroup label="Published">{published.data.reports.map(option)}</optgroup> : null}
        {drafts.data?.reports.length ? <optgroup label="Drafts">{drafts.data.reports.map(option)}</optgroup> : null}
      </select>
    </Field>
  );
}

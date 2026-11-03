"use client";

import { type ReactNode, useState } from "react";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { MoreMenu, type MoreMenuItem } from "@/components/more-menu";
import { ExportMenu, type ReportExportProps } from "@/components/reports/report-export";
import { Button, Field, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { todayInBrowser } from "@/lib/format";
import { REPORT_DATE_PRESETS, type ReportDatePreset, reportPresetFor, reportPresetRange } from "@/lib/reports/report-dates";

/**
 * The frame every standard report shares (decisions 1350-1352), like Xero's:
 * a toolbar (date presets or your own dates, the report's filters, Update,
 * "⋯ More" and Export), then the statement's heading (title, organisation and
 * period) and the report. Nothing changes until Update is pressed, so you
 * can set dates and filters together.
 */

/** The organisation's balance month (31 March unless it's been changed), for the date presets. */
export function useYearEndMonth(organisationId: string): number {
  const settings = useApiData<{ settings: { financialYearEndMonth: number } }>(`/api/organisations/${organisationId}/settings`);
  return settings.data?.settings.financialYearEndMonth ?? 3;
}

export type ReportDates = { from: string | null; to: string };

export function ReportToolbar({
  mode,
  dates,
  shownFrom,
  yearEndMonth,
  onUpdate,
  filters,
  more = [],
  exportProps,
  info,
  actions,
  busy = false,
}: {
  /** Buttons beside ⋯ and Export, e.g. Edit layout. */
  actions?: ReactNode;
  /** "range" for a from and to date, "asAt" for one date, "none" for no dates. */
  mode: "range" | "asAt" | "none";
  /** The dates the report shows now. */
  dates: ReportDates;
  /** The from date the server worked out when `dates.from` is null (the start of the financial year). */
  shownFrom?: string | null;
  yearEndMonth: number;
  /** Called by Update with the dates in the toolbar; also apply the filters' choices here. */
  onUpdate: (dates: ReportDates) => void;
  /** The report's own filters (compare, tracking and so on), as Fields. */
  filters?: ReactNode;
  more?: MoreMenuItem[];
  /** Null while the report loads: Export waits for it. */
  exportProps?: ReportExportProps | null;
  /** What the report shows and how, behind an (i). */
  info?: ReactNode;
  busy?: boolean;
}) {
  const today = todayInBrowser();
  const [from, setFrom] = useState(dates.from ?? shownFrom ?? "");
  const [to, setTo] = useState(dates.to);
  const [preset, setPreset] = useState<ReportDatePreset>(() => reportPresetFor({ from: dates.from ?? shownFrom ?? null, to: dates.to }, today, yearEndMonth, mode === "asAt"));

  // Follow the report's dates when they change (Update, or the server's default
  // from date arriving); not while the from date is still loading.
  const shown = dates.from ?? shownFrom ?? null;
  const syncKey = `${shown ?? ""}|${dates.to}|${yearEndMonth}`;
  const [synced, setSynced] = useState(syncKey);
  if (synced !== syncKey && !(mode === "range" && shown == null)) {
    setSynced(syncKey);
    setFrom(shown ?? "");
    setTo(dates.to);
    setPreset(reportPresetFor({ from: shown, to: dates.to }, today, yearEndMonth, mode === "asAt"));
  }

  function choosePreset(value: ReportDatePreset) {
    setPreset(value);
    if (value === "custom") return;
    const range = reportPresetRange(value, today, yearEndMonth);
    setFrom(range.from);
    setTo(range.to);
  }

  function update() {
    if (mode === "range") onUpdate({ from: from || null, to: to || dates.to });
    else onUpdate({ from: null, to: to || dates.to });
  }

  return (
    <div className={ui.reportToolbar} data-print="hide" role="group" aria-label="Report options">
      {mode !== "none" ? (
        <Field label={mode === "asAt" ? "Date" : "Date range"}>
          <select value={preset} onChange={(event) => choosePreset(event.target.value as ReportDatePreset)}>
            {REPORT_DATE_PRESETS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {mode === "asAt" ? entry.asAtLabel : entry.label}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {mode === "range" ? (
        <Field label="From">
          <DateInput
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setPreset(reportPresetFor({ from: event.target.value, to }, today, yearEndMonth));
            }}
          />
        </Field>
      ) : null}
      {mode !== "none" ? (
        <Field label={mode === "asAt" ? "As at" : "To"}>
          <DateInput
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              setPreset(reportPresetFor({ from, to: event.target.value }, today, yearEndMonth, mode === "asAt"));
            }}
          />
        </Field>
      ) : null}
      {filters}
      <Button onClick={update} disabled={busy}>
        Update
      </Button>
      <div className={ui.reportToolbarEnd}>
        {info ? <InfoTip label="About this report">{info}</InfoTip> : null}
        {actions}
        <MoreMenu label="More report options" items={more} />
        {exportProps ? <ExportMenu {...exportProps} /> : null}
      </div>
    </div>
  );
}

/** The statement's heading: title, organisation and period, on screen and on paper. */
export function StatementHeading({ title, period, lines = [], children }: { title: string; period: string; lines?: string[]; children?: ReactNode }) {
  const { current } = useWorkspace();
  return (
    <header className={ui.statementHeading}>
      <h2 className={ui.statementTitle}>{title}</h2>
      {current?.displayName ? <p className={ui.statementOrg}>{current.displayName}</p> : null}
      <p>{period}</p>
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {children}
    </header>
  );
}

/** A standard report: the toolbar, the heading once the figures are in, and the report. */
export function ReportFrame({ label, toolbar, children }: { label: string; toolbar: ReactNode; children: ReactNode }) {
  return (
    <section className={ui.reportFrame} aria-label={label}>
      {toolbar}
      {children}
    </section>
  );
}

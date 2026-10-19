"use client";

import { Field, Notice, ui } from "@/components/ui";
import type { ChartFormat, KpiFormat } from "@/lib/analytics/chart-format";
import type { TileQuery } from "@/lib/analytics/query";
import styles from "./chart-format-panel.module.css";

type Compare = "none" | "previous_period" | "previous_year" | "target";

/**
 * A key figure's comparison and trend (#334). The previous period and last
 * year are part of the question (the first value's compare); a target is
 * part of the format.
 */
export function KeyFigureSettings({
  query,
  onQuery,
  format,
  onFormat,
}: {
  query: TileQuery;
  onQuery: (query: TileQuery) => void;
  format: ChartFormat | undefined;
  onFormat: (format: ChartFormat | undefined) => void;
}) {
  const first = query.measures[0];
  const kpi = format?.kpi ?? {};
  const grouped = Boolean(query.groupBy);
  const compare: Compare = first?.compare ?? (kpi.target !== undefined ? "target" : "none");
  const setKpi = (patch: Partial<KpiFormat>) => {
    const next = { ...kpi, ...patch };
    const tidy = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== ""));
    const rest = { ...format };
    delete rest.kpi;
    const merged = Object.keys(tidy).length ? { ...rest, kpi: tidy } : rest;
    onFormat(Object.keys(merged).length ? merged : undefined);
  };
  const choose = (next: Compare) => {
    const measures = query.measures.map((measure, index) =>
      index === 0 ? { ...measure, compare: next === "previous_period" || next === "previous_year" ? next : undefined } : measure,
    );
    onQuery({ ...query, measures });
    if (next === "target") setKpi({ target: kpi.target ?? "0" });
    else if (kpi.target !== undefined) setKpi({ target: undefined });
  };
  return (
    <fieldset className={styles.group}>
      <legend>Key figure</legend>
      {grouped ? <Notice tone="info">A key figure shows one total: set Group by to Nothing (one total) to compare it or show a trend.</Notice> : null}
      <Field label="Compare to" hint={compare === "previous_period" ? "The same length just before the dashboard's dates (a whole month or year moves back by months)." : undefined}>
        <select value={compare} disabled={grouped} onChange={(event) => choose(event.target.value as Compare)}>
          <option value="none">Nothing</option>
          <option value="previous_period" disabled={!query.dateField}>Previous period</option>
          <option value="previous_year" disabled={!query.dateField}>Same period last year</option>
          <option value="target">A target</option>
        </select>
      </Field>
      {compare === "target" ? (
        <Field label="Target">
          <input inputMode="decimal" value={kpi.target ?? ""} onChange={(event) => setKpi({ target: event.target.value.trim() || "0" })} />
        </Field>
      ) : null}
      {compare !== "none" ? (
        <>
          <Field label="Show the change as">
            <select value={kpi.change ?? "both"} onChange={(event) => setKpi({ change: event.target.value === "both" ? undefined : (event.target.value as "amount" | "percent") })}>
              <option value="both">Amount and %</option>
              <option value="amount">Amount</option>
              <option value="percent">%</option>
            </select>
          </Field>
          <label className={ui.checkbox}>
            <input type="checkbox" checked={kpi.downIsGood === true} onChange={(event) => setKpi({ downIsGood: event.target.checked || undefined })} /> Down is good (e.g. expenses)
          </label>
        </>
      ) : null}
      <label className={ui.checkbox}>
        <input
          type="checkbox"
          disabled={grouped || !query.dateField}
          checked={query.sparkline === true}
          onChange={(event) => onQuery({ ...query, sparkline: event.target.checked || undefined })}
        />{" "}
        Trend by month underneath
      </label>
      {!query.dateField && !grouped ? <p className={ui.muted}>Choose what the date range applies to for a comparison or trend.</p> : null}
    </fieldset>
  );
}

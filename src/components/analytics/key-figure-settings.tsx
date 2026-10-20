"use client";

import { ColourInput } from "@/components/analytics/colour-input";
import { Button, Field, Notice, ui } from "@/components/ui";
import type { ChartFormat, KpiFormat, KpiRule } from "@/lib/analytics/chart-format";
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
    const tidy = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0)));
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
      {query.sparkline ? (
        <>
          <Field label="Trend style">
            <select value={kpi.sparkline ?? "line"} onChange={(event) => setKpi({ sparkline: event.target.value === "line" ? undefined : (event.target.value as "area" | "column") })}>
              <option value="line">Line</option>
              <option value="area">Area</option>
              <option value="column">Columns</option>
            </select>
          </Field>
          <ColourInput label="Trend colour" value={kpi.sparkColor} onChange={(sparkColor) => setKpi({ sparkColor })} />
        </>
      ) : null}
      <KeyFigureLook kpi={kpi} setKpi={setKpi} compare={compare !== "none"} several={query.measures.length > 1} />
    </fieldset>
  );
}

const RULE_OPS: Array<{ value: KpiRule["op"]; label: string }> = [
  { value: ">=", label: "at least" },
  { value: ">", label: "more than" },
  { value: "<=", label: "at most" },
  { value: "<", label: "less than" },
  { value: "=", label: "exactly" },
];

/** How the number looks (#376): size, colour (fixed, by rules or by the comparison), alignment, weight, name, icon, several numbers. */
function KeyFigureLook({ kpi, setKpi, compare, several }: { kpi: KpiFormat; setKpi: (patch: Partial<KpiFormat>) => void; compare: boolean; several: boolean }) {
  const rules = kpi.rules ?? [];
  const setRule = (index: number, patch: Partial<KpiRule>) => setKpi({ rules: rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)) });
  return (
    <details className={styles.inner}>
      <summary>Number style</summary>
      <div className={styles.pair}>
        <Field label="Number size">
          <select value={kpi.size ?? "m"} onChange={(event) => setKpi({ size: event.target.value === "m" ? undefined : (event.target.value as KpiFormat["size"]) })}>
            <option value="s">Small</option>
            <option value="m">Medium</option>
            <option value="l">Large</option>
            <option value="xl">Extra large</option>
          </select>
        </Field>
        <Field label="Or exact size" hint="16 to 96 pixels">
          <input
            type="number"
            min={16}
            max={96}
            placeholder="Automatic"
            value={kpi.sizePx ?? ""}
            onChange={(event) => {
              const number = Number(event.target.value);
              setKpi({ sizePx: event.target.value === "" ? undefined : Number.isInteger(number) && number >= 16 && number <= 96 ? number : kpi.sizePx });
            }}
          />
        </Field>
        <Field label="Alignment">
          <select value={kpi.align ?? "left"} onChange={(event) => setKpi({ align: event.target.value === "left" ? undefined : (event.target.value as "center" | "right") })}>
            <option value="left">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
          </select>
        </Field>
        <Field label="Value name">
          <select value={kpi.label ?? "none"} onChange={(event) => setKpi({ label: event.target.value === "none" ? undefined : (event.target.value as "above" | "below") })}>
            <option value="none">Not shown (the title names it)</option>
            <option value="above">Above the number</option>
            <option value="below">Below the number</option>
          </select>
        </Field>
        <Field label="Icon">
          <select value={kpi.icon ?? "none"} onChange={(event) => setKpi({ icon: event.target.value === "none" ? undefined : (event.target.value as "arrow" | "dot") })}>
            <option value="none">None</option>
            <option value="arrow" disabled={!compare}>Arrow (up or down)</option>
            <option value="dot">Dot in the number&apos;s colour</option>
          </select>
        </Field>
        <label className={ui.checkbox}>
          <input type="checkbox" checked={kpi.bold !== false} onChange={(event) => setKpi({ bold: event.target.checked ? undefined : false })} /> Bold
        </label>
        {several ? (
          <label className={ui.checkbox}>
            <input type="checkbox" checked={kpi.multi === true} onChange={(event) => setKpi({ multi: event.target.checked || undefined })} /> Every value as its own number
          </label>
        ) : null}
      </div>
      <Field label="Colour the number">
        <select value={kpi.colorBy ?? "none"} onChange={(event) => setKpi({ colorBy: event.target.value === "none" ? undefined : (event.target.value as "rules" | "change"), ...(event.target.value === "rules" && !rules.length ? { rules: [{ op: ">=", value: "0", color: "#057836" }] } : {}) })}>
          <option value="none">One colour</option>
          <option value="rules">By rules on its value</option>
          <option value="change" disabled={!compare}>Green when good news, red when not</option>
        </select>
      </Field>
      {(kpi.colorBy ?? "none") === "none" ? <ColourInput label="Number colour" value={kpi.color} onChange={(color) => setKpi({ color })} /> : null}
      {kpi.colorBy === "rules" ? (
        <>
          <p className={styles.note}>The first rule that matches sets the colour; none matching, it&apos;s the usual text colour.</p>
          {rules.map((rule, index) => (
            <fieldset key={index} className={styles.group}>
              <legend>Rule {index + 1}</legend>
              <div className={styles.pair}>
                <Field label="When the value is">
                  <select aria-label={`Rule ${index + 1} comparison`} value={rule.op} onChange={(event) => setRule(index, { op: event.target.value as KpiRule["op"] })}>
                    {RULE_OPS.map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}
                  </select>
                </Field>
                <Field label="Number">
                  <input aria-label={`Rule ${index + 1} number`} inputMode="decimal" value={rule.value} onChange={(event) => setRule(index, { value: event.target.value.trim() })} />
                </Field>
              </div>
              <ColourInput label={`Rule ${index + 1} colour`} value={rule.color} resetLabel="Use the first rule colour" onChange={(color) => setRule(index, { color: color ?? "#057836" })} />
              <div>
                <Button size="small" variant="danger" onClick={() => setKpi({ rules: rules.filter((_rule, at) => at !== index) })}>Remove rule {index + 1}</Button>
              </div>
            </fieldset>
          ))}
          <div>
            <Button size="small" variant="secondary" disabled={rules.length >= 6} onClick={() => setKpi({ rules: [...rules, { op: "<", value: "0", color: "#ba3e3c" }] })}>Add a rule</Button>
          </div>
        </>
      ) : null}
    </details>
  );
}

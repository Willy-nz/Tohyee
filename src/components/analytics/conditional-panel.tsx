"use client";

import { ColourInput } from "@/components/analytics/colour-input";
import { Button, Field, ui } from "@/components/ui";
import type { ChartFormat, ConditionalFormat, IconSet, KpiRule, TableStyle } from "@/lib/analytics/chart-format";
import styles from "./chart-format-panel.module.css";

/** Conditional formatting, table styles and chart colour rules in the Format section (#376). */

const OPS: Array<{ value: KpiRule["op"]; label: string }> = [
  { value: ">=", label: "at least" },
  { value: ">", label: "more than" },
  { value: "<=", label: "at most" },
  { value: "<", label: "less than" },
  { value: "=", label: "exactly" },
];

type SetFormat = (patch: Partial<ChartFormat>) => void;

/** A list of "when the value is ... colour it ..." rules; the first match wins. */
export function RuleList<T extends KpiRule>({ name, rules, onChange, make, extra }: { name: string; rules: T[]; onChange: (rules: T[]) => void; make: () => T; extra?: (rule: T, update: (patch: Partial<T>) => void) => React.ReactNode }) {
  const update = (index: number, patch: Partial<T>) => onChange(rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)));
  return (
    <>
      {rules.map((rule, index) => (
        <fieldset key={index} className={styles.group}>
          <legend>{name} {index + 1}</legend>
          <div className={styles.pair}>
            {extra ? extra(rule, (patch) => update(index, patch)) : null}
            <Field label="When the value is">
              <select aria-label={`${name} ${index + 1} comparison`} value={rule.op} onChange={(event) => update(index, { op: event.target.value as KpiRule["op"] } as Partial<T>)}>
                {OPS.map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}
              </select>
            </Field>
            <Field label="Number">
              <input aria-label={`${name} ${index + 1} number`} inputMode="decimal" value={rule.value} onChange={(event) => update(index, { value: event.target.value.trim() } as Partial<T>)} />
            </Field>
          </div>
          <ColourInput label={`${name} ${index + 1} colour`} value={rule.color} onChange={(color) => update(index, { color: color ?? rule.color } as Partial<T>)} />
          <div>
            <Button size="small" variant="danger" onClick={() => onChange(rules.filter((_rule, at) => at !== index))}>Remove {name.toLowerCase()} {index + 1}</Button>
          </div>
        </fieldset>
      ))}
      <div>
        <Button size="small" variant="secondary" disabled={rules.length >= 6} onClick={() => onChange([...rules, make()])}>Add a {name.toLowerCase()}</Button>
      </div>
    </>
  );
}

/** Columns, bars and dots coloured by rules, e.g. red below a target. */
export function ChartRuleFields({ values, format, set }: { values: string[]; format: ChartFormat; set: SetFormat }) {
  type ChartRule = NonNullable<ChartFormat["chartRules"]>[number];
  return (
    <>
      <p className={styles.note}>The first rule that matches a column or dot sets its colour, e.g. red when below a target.</p>
      <RuleList<ChartRule>
        name="Rule"
        rules={format.chartRules ?? []}
        onChange={(chartRules) => set({ chartRules: chartRules.length ? chartRules : undefined })}
        make={() => ({ op: "<", value: "0", color: "#ba3e3c" })}
        extra={values.length > 1 ? (rule, update) => (
          <Field label="For">
            <select value={rule.series ?? ""} onChange={(event) => update({ series: event.target.value === "" ? undefined : Number(event.target.value) })}>
              <option value="">Every value</option>
              {values.map((name, index) => <option key={index} value={index}>{name || `Value ${index + 1}`}</option>)}
            </select>
          </Field>
        ) : undefined}
      />
    </>
  );
}

const ICON_SETS: Array<{ value: IconSet; label: string }> = [
  { value: "arrows", label: "Arrows ▲ ▶ ▼" },
  { value: "shapes", label: "Shapes ● ◆ ■ (green, grey, red)" },
];

/** Background or font colour by a scale, rules or a field; data bars and icons, for one value of a table or pivot. */
export function ConditionalFields({ values, format, set, groupName }: { values: string[]; format: ChartFormat; set: SetFormat; groupName: string | null }) {
  const list = format.conditional ?? [];
  const update = (index: number, patch: Partial<ConditionalFormat>) => set({ conditional: list.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)) });
  const bars = format.dataBars ?? [];
  const icons = format.icons ?? [];
  const valueName = (index: number) => values[index] || `Value ${index + 1}`;
  return (
    <>
      {list.map((entry, index) => (
        <fieldset key={index} className={styles.group}>
          <legend>Colour {index + 1}</legend>
          <div className={styles.pair}>
            <Field label="Value">
              <select aria-label={`Colour ${index + 1} value`} value={entry.value} onChange={(event) => update(index, { value: Number(event.target.value) })}>
                {values.map((_name, at) => <option key={at} value={at}>{valueName(at)}</option>)}
              </select>
            </Field>
            <Field label="Colour the">
              <select aria-label={`Colour ${index + 1} applies to`} value={entry.apply} onChange={(event) => update(index, { apply: event.target.value as "background" | "font" })}>
                <option value="background">Background</option>
                <option value="font">Text</option>
              </select>
            </Field>
            <Field label="By">
              <select
                aria-label={`Colour ${index + 1} by`}
                value={entry.by}
                onChange={(event) => {
                  const by = event.target.value as ConditionalFormat["by"];
                  update(index, {
                    by,
                    low: by === "scale" ? entry.low ?? "#ffffff" : undefined,
                    high: by === "scale" ? entry.high ?? "#057836" : undefined,
                    mid: by === "scale" ? entry.mid : undefined,
                    rules: by === "rules" ? entry.rules ?? [{ op: "<", value: "0", color: "#ba3e3c" }] : undefined,
                    field: by === "field" ? entry.field ?? "category" : undefined,
                  });
                }}
              >
                <option value="scale">A colour scale</option>
                <option value="rules">Rules</option>
                <option value="field">A field&apos;s colours</option>
              </select>
            </Field>
          </div>
          {entry.by === "scale" ? (
            <>
              <ColourInput label="Lowest" value={entry.low} resetLabel="White" onChange={(low) => update(index, { low: low ?? "#ffffff" })} />
              <ColourInput label="Middle (optional)" value={entry.mid} resetLabel="No middle colour" emptyText="None" onChange={(mid) => update(index, { mid })} />
              <ColourInput label="Highest" value={entry.high} resetLabel="Green" onChange={(high) => update(index, { high: high ?? "#057836" })} />
            </>
          ) : entry.by === "rules" ? (
            <RuleList name="Rule" rules={entry.rules ?? []} onChange={(rules) => update(index, { rules })} make={() => ({ op: ">=", value: "0", color: "#057836" })} />
          ) : (
            <Field label="Colours from" hint="A column holding colours such as #1f5fae or red; other values aren't coloured.">
              <select value={String(entry.field ?? "category")} onChange={(event) => update(index, { field: event.target.value === "category" ? "category" : Number(event.target.value) })}>
                <option value="category">{groupName ?? "The group"}</option>
              </select>
            </Field>
          )}
          <div>
            <Button size="small" variant="danger" onClick={() => set({ conditional: list.filter((_entry, at) => at !== index) })}>Remove colour {index + 1}</Button>
          </div>
        </fieldset>
      ))}
      <div>
        <Button size="small" variant="secondary" disabled={list.length >= 10} onClick={() => set({ conditional: [...list, { value: 0, apply: "background", by: "scale", low: "#ffffff", high: "#057836" }] })}>
          Add a colour
        </Button>
      </div>
      <fieldset className={styles.group}>
        <legend>Data bars and icons</legend>
        {values.map((_name, index) => {
          const bar = bars.find((entry) => entry.value === index);
          const icon = icons.find((entry) => entry.value === index);
          return (
            <div key={index} className={styles.pair}>
              <label className={ui.checkbox}>
                <input
                  type="checkbox"
                  checked={Boolean(bar)}
                  onChange={(event) => {
                    const others = bars.filter((entry) => entry.value !== index);
                    const next = event.target.checked ? [...others, { value: index }] : others;
                    set({ dataBars: next.length ? next : undefined });
                  }}
                />{" "}
                Data bars on {valueName(index)}
              </label>
              <Field label={`Icons on ${valueName(index)}`}>
                <select
                  value={icon?.set ?? ""}
                  onChange={(event) => {
                    const others = icons.filter((entry) => entry.value !== index);
                    const next = event.target.value ? [...others, { value: index, set: event.target.value as IconSet }] : others;
                    set({ icons: next.length ? next : undefined });
                  }}
                >
                  <option value="">None</option>
                  {ICON_SETS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                </select>
              </Field>
              {bar ? (
                <ColourInput
                  label={`Bar colour for ${valueName(index)}`}
                  value={bar.color}
                  onChange={(color) => set({ dataBars: bars.map((entry) => (entry.value === index ? { value: index, ...(color ? { color } : {}) } : entry)) })}
                />
              ) : null}
            </div>
          );
        })}
        <p className={styles.note}>Icons split each column into its highest, middle and lowest thirds.</p>
      </fieldset>
    </>
  );
}

/** Header colours, bands, gridlines, text size, column width, word wrap, totals and subtotals. */
export function TableStyleFields({ format, set, pivot, rowFields }: { format: ChartFormat; set: SetFormat; pivot: boolean; rowFields: string[] }) {
  const table = format.table ?? {};
  const setTable = (patch: Partial<TableStyle>) => set({ table: { ...table, ...patch } });
  const off = table.subtotalsOff ?? [];
  return (
    <>
      <ColourInput label="Header background" value={table.headerBackground} onChange={(headerBackground) => setTable({ headerBackground })} />
      <ColourInput label="Header text" value={table.headerColor} onChange={(headerColor) => setTable({ headerColor })} />
      <div className={styles.pair}>
        <label className={ui.checkbox}>
          <input type="checkbox" checked={table.banded === true} onChange={(event) => setTable({ banded: event.target.checked || undefined })} /> Banded rows
        </label>
        <Field label="Gridlines">
          <select value={table.gridlines ?? ""} onChange={(event) => setTable({ gridlines: (event.target.value || undefined) as TableStyle["gridlines"] })}>
            <option value="">Automatic</option>
            <option value="all">Rows and columns</option>
            <option value="rows">Rows only</option>
            <option value="none">None</option>
          </select>
        </Field>
        <Field label="Text size" hint="10 to 18">
          <input type="number" min={10} max={18} placeholder="Automatic" value={table.fontSize ?? ""} onChange={(event) => {
            const number = Number(event.target.value);
            setTable({ fontSize: event.target.value === "" ? undefined : Number.isInteger(number) && number >= 10 && number <= 18 ? number : table.fontSize });
          }} />
        </Field>
        <Field label="Column width" hint="Narrowest, 60 to 400 pixels">
          <input type="number" min={60} max={400} placeholder="Automatic" value={table.columnWidth ?? ""} onChange={(event) => {
            const number = Number(event.target.value);
            setTable({ columnWidth: event.target.value === "" ? undefined : Number.isInteger(number) && number >= 60 && number <= 400 ? number : table.columnWidth });
          }} />
        </Field>
        <label className={ui.checkbox}>
          <input type="checkbox" checked={table.wrap === true} onChange={(event) => setTable({ wrap: event.target.checked || undefined })} /> Wrap long text
        </label>
      </div>
      {table.banded ? <ColourInput label="Band colour" value={table.bandColor} onChange={(bandColor) => setTable({ bandColor })} /> : null}
      <div className={styles.pair}>
        <label className={ui.checkbox}>
          <input
            type="checkbox"
            checked={pivot ? table.totals !== false : table.totals === true}
            onChange={(event) => setTable({ totals: pivot ? (event.target.checked ? undefined : false) : event.target.checked || undefined })}
          />{" "}
          {pivot ? "Grand total" : "Totals row"}
        </label>
        <Field label="Totals style">
          <select value={table.totalsStyle ?? "bold"} onChange={(event) => setTable({ totalsStyle: event.target.value === "bold" ? undefined : "shaded" })}>
            <option value="bold">Bold</option>
            <option value="shaded">Shaded</option>
          </select>
        </Field>
      </div>
      {!pivot ? <p className={styles.note}>The totals row adds up totals and counts exactly; averages, smallest, largest and calculated values are left blank.</p> : null}
      {pivot && rowFields.length > 1 ? (
        <fieldset className={styles.group}>
          <legend>Subtotals</legend>
          {rowFields.slice(0, -1).map((name, index) => (
            <label key={index} className={ui.checkbox}>
              <input
                type="checkbox"
                checked={!off.includes(index + 1)}
                onChange={(event) => {
                  const next = event.target.checked ? off.filter((level) => level !== index + 1) : [...off, index + 1].sort();
                  setTable({ subtotalsOff: next.length ? next : undefined });
                }}
              />{" "}
              Subtotal for each {name}
            </label>
          ))}
        </fieldset>
      ) : null}
    </>
  );
}

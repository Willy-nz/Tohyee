"use client";

import type { ReactNode } from "react";
import { SettingSection, SourceProvider, SourceTag } from "@/components/analytics/setting-source";
import { usesAdvanced, withoutSettings } from "@/lib/analytics/editor-panels";
import { ColourInput } from "@/components/analytics/colour-input";
import { ChartRuleFields, ConditionalFields, TableStyleFields } from "@/components/analytics/conditional-panel";
import { Button, Field, Notice, ui } from "@/components/ui";
import {
  HUE_LABELS,
  HUES,
  LEGEND_POSITIONS,
  PALETTES,
  REFERENCE_KINDS,
  formatOptionsFor,
  mergeFormats,
  painterFormat,
  VISUAL_NAMES,
  type AxisFormat,
  type CardFormat,
  type CategoryAxisFormat,
  type ChartFormat,
  type Hue,
  type LegendPosition,
  type LineStyle,
  type NumberFormat,
  type PaletteId,
  type ReferenceKind,
  type ReferenceLine,
  type SeriesFormat,
  type TextStyle,
} from "@/lib/analytics/chart-format";
import type { Visual } from "@/lib/analytics/query";
import { BUILT_IN_THEMES, chosenColourWarnings, type ReportTheme } from "@/lib/charts/report-themes";
import { VisualSettings } from "@/components/analytics/visual-settings";
import styles from "./chart-format-panel.module.css";

type Props = {
  visual: Visual;
  /** The tile's values, in their saved order. */
  values: string[];
  format: ChartFormat | undefined;
  onChange: (format: ChartFormat | undefined) => void;
  /** The report's default for this chart type (#376); the tile's own settings go over it. */
  inherited?: ChartFormat;
  /** Keeps this look as the report's default for the chart type (undefined clears it). */
  onSetDefault?: (format: ChartFormat | undefined) => void;
  /** The report's theme, for checking chosen colours against its cards and colours. */
  theme?: ReportTheme;
  /** The groups the chart shows now (as named on it), for colouring them one by one. */
  groups?: string[];
  /** Whether the groups are dates (for limiting the axis to a date range). */
  datedGroups?: boolean;
  /** A table's group column, or a pivot's row fields, by name. */
  groupName?: string | null;
  rowFields?: string[];
  /** The tile shows small multiples (a column, bar or line chart with a second grouping). */
  smallMultiples?: boolean;
  /** Which tab of the chart's panel this is (#387, decision 750): its look, or what happens when people point at it. */
  part?: "style" | "interactions";
  /** Show advanced settings (statistics, colour rules, gridlines); ones the chart uses always show. */
  advanced?: boolean;
  /** More settings shown first in the Style tab (a key figure's look). */
  extra?: ReactNode;
};

/** Removes settings left at their default, so Reset and "nothing changed" are the same thing. */
export function tidyFormat(format: ChartFormat | undefined): ChartFormat | undefined {
  if (!format) return undefined;
  const prune = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const list = value.map((entry) => prune(entry) ?? {});
      while (list.length && Object.keys(list[list.length - 1] as object).length === 0) list.pop();
      return list.length ? list : undefined;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value).map(([key, entry]) => [key, prune(entry)] as const).filter(([, entry]) => entry !== undefined && entry !== "");
      return entries.length ? Object.fromEntries(entries) : undefined;
    }
    return value;
  };
  return prune(format) as ChartFormat | undefined;
}

const Section = SettingSection;

function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string }) {
  return (
    <label className={ui.checkbox} title={hint}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /> {label}
    </label>
  );
}

function Swatch({ hue, hex }: { hue: Hue | undefined; hex?: string }) {
  if (hex) return <span className={styles.swatch} style={{ background: hex }} aria-hidden="true" />;
  if (!hue) return <span className={`${styles.swatch} ${styles.auto}`} aria-hidden="true" />;
  return <span className={styles.swatch} style={{ background: `var(--chart-${HUES.indexOf(hue) + 1})` }} aria-hidden="true" />;
}

/** A whole number box; blank means automatic. */
function NumberBox({ label, value, min, max, onChange, hint, placeholder = "Automatic" }: { label: string; value: number | undefined; min: number; max: number; onChange: (value: number | undefined) => void; hint?: string; placeholder?: string }) {
  return (
    <Field label={label} hint={hint ?? `${min} to ${max}`}>
      <input
        type="number"
        min={min}
        max={max}
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(event) => {
          const text = event.target.value;
          if (text === "") return onChange(undefined);
          const number = Number(text);
          if (Number.isInteger(number) && number >= min && number <= max) onChange(number);
        }}
      />
    </Field>
  );
}

function StyleSelect({ label, value, onChange }: { label: string; value: LineStyle | undefined; onChange: (value: LineStyle | undefined) => void }) {
  return (
    <Field label={label}>
      <select value={value ?? ""} onChange={(event) => onChange((event.target.value || undefined) as LineStyle | undefined)}>
        <option value="">Automatic</option>
        <option value="solid">Solid</option>
        <option value="dashed">Dashed</option>
        <option value="dotted">Dotted</option>
      </select>
    </Field>
  );
}

function NumberFields({ name, value, onChange, labels }: { name: string; value: NumberFormat | undefined; onChange: (value: NumberFormat) => void; labels: boolean }) {
  const current = value ?? {};
  return (
    <div className={styles.pair}>
      <Field label="Number format">
        <select aria-label={`${name} number format`} value={current.style ?? "auto"} onChange={(event) => onChange({ ...current, style: event.target.value as NumberFormat["style"] })}>
          <option value="auto">Automatic</option>
          <option value="currency">Dollars</option>
          <option value="percent">Percentage (0.25 shows as 25%)</option>
          <option value="plain">Plain number</option>
        </select>
      </Field>
      <Field label="Decimal places">
        <select
          aria-label={`${name} decimal places`}
          value={current.decimals ?? ""}
          onChange={(event) => onChange({ ...current, decimals: event.target.value === "" ? undefined : Number(event.target.value) })}
        >
          <option value="">Automatic</option>
          {[0, 1, 2, 3, 4].map((places) => <option key={places} value={places}>{places}</option>)}
        </select>
      </Field>
      <Check label="Short ($1.5K)" checked={current.compact === true} onChange={(checked) => onChange({ ...current, compact: checked || undefined })} />
      <Check label="Thousands separator" checked={current.thousands !== false} onChange={(checked) => onChange({ ...current, thousands: checked ? undefined : false })} />
      {labels ? (
        <>
          <Field label="Before the number">
            <input aria-label={`${name} text before`} maxLength={20} value={current.prefix ?? ""} onChange={(event) => onChange({ ...current, prefix: event.target.value || undefined })} />
          </Field>
          <Field label="After the number" hint='e.g. "customers"'>
            <input aria-label={`${name} text after`} maxLength={20} value={current.suffix ?? ""} onChange={(event) => onChange({ ...current, suffix: event.target.value || undefined })} />
          </Field>
        </>
      ) : null}
    </div>
  );
}

/** Text size, bold, italic, colour and alignment (#376). */
function TextFields({ name, value, onChange, align = true, maxSize = 32 }: { name: string; value: TextStyle | undefined; onChange: (value: TextStyle) => void; align?: boolean; maxSize?: number }) {
  const current = value ?? {};
  return (
    <div className={styles.pair}>
      <NumberBox label={`${name} size`} value={current.size} min={8} max={maxSize} onChange={(size) => onChange({ ...current, size })} />
      {align ? (
        <Field label={`${name} alignment`}>
          <select value={current.align ?? ""} onChange={(event) => onChange({ ...current, align: (event.target.value || undefined) as TextStyle["align"] })}>
            <option value="">Automatic</option>
            <option value="left">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
          </select>
        </Field>
      ) : null}
      <Field label={`${name} weight`}>
        <select value={current.bold === undefined ? "" : current.bold ? "bold" : "normal"} onChange={(event) => onChange({ ...current, bold: event.target.value === "" ? undefined : event.target.value === "bold" })}>
          <option value="">Automatic</option>
          <option value="bold">Bold</option>
          <option value="normal">Normal</option>
        </select>
      </Field>
      <Check label="Italic" checked={current.italic === true} onChange={(checked) => onChange({ ...current, italic: checked || undefined })} />
      <ColourInput label={`${name} colour`} value={current.color} onChange={(color) => onChange({ ...current, color })} />
    </div>
  );
}

/** How an axis's labels look: shown or not, size, colour, angle and direction (#376). */
function AxisLookFields({ name, value, onChange }: { name: string; value: AxisFormat | CategoryAxisFormat | undefined; onChange: (patch: Partial<AxisFormat & CategoryAxisFormat>) => void }) {
  const current = value ?? {};
  return (
    <>
      <div className={styles.pair}>
        <Check label="Show the axis" checked={current.show !== false} onChange={(checked) => onChange({ show: checked ? undefined : false })} />
        <Check label="Reverse the order" checked={current.reverse === true} onChange={(checked) => onChange({ reverse: checked || undefined })} />
        <NumberBox label="Text size" value={current.size} min={8} max={20} placeholder="12" onChange={(size) => onChange({ size })} />
        <NumberBox label="Label angle" value={current.rotate} min={-90} max={90} placeholder="0" hint="-90 to 90 degrees" onChange={(rotate) => onChange({ rotate })} />
      </div>
      <ColourInput label={`${name} text colour`} value={current.color} onChange={(color) => onChange({ color })} />
    </>
  );
}

function AxisFields({ name, value, onChange, defaultGridlines, advanced = true }: { name: string; value: AxisFormat | undefined; onChange: (value: AxisFormat) => void; defaultGridlines: boolean; advanced?: boolean }) {
  const current = value ?? {};
  return (
    <fieldset className={styles.group}>
      <legend>{name}</legend>
      <Field label="Title">
        <input aria-label={`${name} title`} maxLength={60} value={current.title ?? ""} onChange={(event) => onChange({ ...current, title: event.target.value || undefined })} />
      </Field>
      <div className={styles.pair}>
        <Field label="Lowest">
          <input aria-label={`${name} lowest`} inputMode="decimal" placeholder="Automatic" value={current.min ?? ""} onChange={(event) => onChange({ ...current, min: event.target.value.trim() || undefined })} />
        </Field>
        <Field label="Highest">
          <input aria-label={`${name} highest`} inputMode="decimal" placeholder="Automatic" value={current.max ?? ""} onChange={(event) => onChange({ ...current, max: event.target.value.trim() || undefined })} />
        </Field>
        <Field label="Step" hint="The gap between labels, e.g. 500">
          <input aria-label={`${name} step`} inputMode="decimal" placeholder="Automatic" value={current.step ?? ""} onChange={(event) => onChange({ ...current, step: event.target.value.trim() || undefined })} />
        </Field>
      </div>
      <Check label="Gridlines" checked={current.gridlines ?? defaultGridlines} onChange={(checked) => onChange({ ...current, gridlines: checked === defaultGridlines ? undefined : checked })} />
      <Check label="Start at zero" checked={current.zero !== false} onChange={(checked) => onChange({ ...current, zero: checked ? undefined : false })} />
      {advanced || current.log ? <Check label="Log scale" hint="For values above zero that range from small to very large" checked={current.log === true} onChange={(checked) => onChange({ ...current, log: checked || undefined })} /> : null}
      <AxisLookFields name={name} value={current} onChange={(patch) => onChange({ ...current, ...patch })} />
      <details className={styles.inner}>
        <summary>Number format on this axis</summary>
        <NumberFields name={`${name} axis`} value={current.number} labels={false} onChange={(number) => onChange({ ...current, number })} />
      </details>
    </fieldset>
  );
}

const REFERENCE_LABELS: Record<ReferenceKind, string> = {
  constant: "A fixed value",
  target: "Target",
  average: "Average",
  median: "Median",
  min: "Lowest",
  max: "Highest",
  percentile: "Percentile",
  band: "Shaded band",
};

function ReferenceLines({ values, lines, onChange }: { values: string[]; lines: ReferenceLine[]; onChange: (lines: ReferenceLine[] | undefined) => void }) {
  const update = (index: number, patch: Partial<ReferenceLine>) => onChange(lines.map((line, at) => (at === index ? { ...line, ...patch } : line)));
  return (
    <>
      {lines.map((line, index) => {
        const fixed = line.kind === "constant" || line.kind === "target" || line.kind === "band";
        return (
          <fieldset key={index} className={styles.group}>
            <legend>Line {index + 1}</legend>
            <div className={styles.pair}>
              <Field label="Kind">
                <select
                  aria-label={`Reference line ${index + 1} kind`}
                  value={line.kind}
                  onChange={(event) => {
                    const kind = event.target.value as ReferenceKind;
                    update(index, { kind, value: kind === "constant" || kind === "target" || kind === "band" ? line.value ?? "0" : undefined, to: kind === "band" ? line.to ?? String(Number(line.value ?? "0") + 1) : undefined, percentile: kind === "percentile" ? line.percentile ?? 90 : undefined });
                  }}
                >
                  {REFERENCE_KINDS.map((kind) => <option key={kind} value={kind}>{REFERENCE_LABELS[kind]}</option>)}
                </select>
              </Field>
              {fixed ? (
                <Field label={line.kind === "band" ? "From" : "Value"}>
                  <input aria-label={`Reference line ${index + 1} value`} inputMode="decimal" value={line.value ?? ""} onChange={(event) => update(index, { value: event.target.value.trim() })} />
                </Field>
              ) : (
                <Field label="Of">
                  <select aria-label={`Reference line ${index + 1} of`} value={line.series ?? 0} onChange={(event) => update(index, { series: Number(event.target.value) || undefined })}>
                    {values.map((name, at) => <option key={at} value={at}>{name || `Value ${at + 1}`}</option>)}
                  </select>
                </Field>
              )}
              {line.kind === "band" ? (
                <Field label="To">
                  <input aria-label={`Reference line ${index + 1} to`} inputMode="decimal" value={line.to ?? ""} onChange={(event) => update(index, { to: event.target.value.trim() })} />
                </Field>
              ) : null}
              {line.kind === "percentile" ? (
                <NumberBox label="Percentile" value={line.percentile} min={1} max={99} onChange={(percentile) => update(index, { percentile: percentile ?? 90 })} />
              ) : null}
              <Field label="Label" hint="Left blank, it says what it is">
                <input aria-label={`Reference line ${index + 1} label`} maxLength={60} value={line.label ?? ""} onChange={(event) => update(index, { label: event.target.value || undefined })} />
              </Field>
              {line.kind !== "band" ? <StyleSelect label="Line style" value={line.style} onChange={(style) => update(index, { style })} /> : null}
            </div>
            <ColourInput label={`Line ${index + 1} colour`} value={line.color} onChange={(color) => update(index, { color })} />
            <div>
              <Button size="small" variant="danger" onClick={() => onChange(lines.filter((_line, at) => at !== index))}>Remove line {index + 1}</Button>
            </div>
          </fieldset>
        );
      })}
      <div>
        <Button size="small" variant="secondary" disabled={lines.length >= 8} onClick={() => onChange([...lines, { kind: "average" }])}>Add a reference line</Button>
      </div>
    </>
  );
}

/** The Format section of the chart panel (#331, #333, #376): every change shows in the preview straight away. */
export function ChartFormatPanel({ visual, values, format, onChange, inherited, onSetDefault, theme = BUILT_IN_THEMES.tohyee, groups = [], datedGroups = false, groupName = null, rowFields = [], smallMultiples = false, part = "style", advanced: showAdvanced = false, extra }: Props) {
  // What the chart shows: the report's default for its type with the tile's own settings over it.
  const current = mergeFormats(inherited, format) ?? {};
  const can = formatOptionsFor(visual);
  const set = (patch: Partial<ChartFormat>) => onChange(tidyFormat({ ...format, ...patch }));
  const seriesAt = (index: number): SeriesFormat => current.series?.[index] ?? {};
  const setSeries = (index: number, patch: Partial<SeriesFormat>) => {
    const list = values.map((_name, at) => current.series?.[at] ?? {});
    list[index] = { ...list[index], ...patch };
    set({ series: list });
  };
  const usesRight = can.secondAxis && values.some((_name, index) => seriesAt(index).axis === "right");
  const tooManyForBlues = current.palette === "blues" && (current.colorByCategory ? false : values.length > 4);
  const warnings = chosenColourWarnings(values.map((_name, index) => current.series?.[index]?.hex), theme);
  // Advanced settings show when asked for, or when the chart (or its default) already uses one (decision 751).
  const advanced = showAdvanced || usesAdvanced(current);
  const chartTypeName = VISUAL_NAMES[visual as keyof typeof VISUAL_NAMES] ?? "Chart";
  const sourceInfo = {
    own: format,
    inherited,
    chartTypeName,
    themeName: theme.name,
    resetOwn: (paths: Array<Array<string | number>>) => onChange(tidyFormat(withoutSettings(format, paths))),
    resetDefault: onSetDefault && inherited ? (paths: Array<Array<string | number>>) => onSetDefault(withoutSettings(inherited, paths)) : undefined,
  };
  const heading = (
    <>
      <div className={styles.heading}>
        <h3>Style</h3>
        <Button size="small" variant="secondary" disabled={!format} onClick={() => onChange(undefined)} title={inherited ? "Every setting changed on this chart goes back to this report's default for the chart type" : "Every setting changed on this chart goes back to the theme"}>Reset all of this chart&apos;s style</Button>
      </div>
      <DefaultButtons visual={visual} current={current} inherited={inherited} onSetDefault={onSetDefault} />
    </>
  );

  if (part === "interactions") {
    if (can.kpi || visual === "table" || visual === "pivot") return null;
    return (
      <SourceProvider value={sourceInfo}>
        <div className={styles.panel}>
          <Section title="Tooltip" open paths={["tooltip"]}>
            <Check label="Show tooltips" checked={current.tooltip?.show !== false} onChange={(checked) => set({ tooltip: { ...current.tooltip, show: checked ? undefined : false } })} />
            {can.cartesian && values.length > 1 ? (
              <Check label="Total of the values" checked={current.tooltip?.total === true} onChange={(checked) => set({ tooltip: { ...current.tooltip, total: checked || undefined } })} />
            ) : null}
            {can.cartesian ? (
              values.map((name, index) => (
                <Field key={index} label={`${name || `Value ${index + 1}`} in the tooltip`}>
                  <select aria-label={`${name} in the tooltip`} value={seriesAt(index).tooltip ?? "show"} onChange={(event) => setSeries(index, { tooltip: event.target.value === "show" ? undefined : (event.target.value as "hide" | "only") })}>
                    <option value="show">Shown</option>
                    <option value="hide">Left out</option>
                    <option value="only">Only in the tooltip (not drawn)</option>
                  </select>
                </Field>
              ))
            ) : null}
          </Section>
          {["column", "line", "area", "combo"].includes(visual) ? (
            <Section title="Zoom" open paths={["zoom"]}>
              <Check label="Zoom along the bottom axis" hint="A slider under the chart, and the mouse wheel or a pinch, to look at part of a long run of dates" checked={current.zoom === true} onChange={(checked) => set({ zoom: checked || undefined })} />
              <p className={styles.note}>Best for charts grouped by dates. Zooming only changes what the chart shows; the other tiles and the totals stay the same.</p>
            </Section>
          ) : null}
        </div>
      </SourceProvider>
    );
  }

  if (visual === "table" || visual === "pivot") {
    return (
      <SourceProvider value={sourceInfo}>
      <div className={styles.panel}>
        {heading}
        {extra}
        <Section title="Table style" paths={["table"]}>
          <TableStyleFields format={current} set={set} pivot={visual === "pivot"} rowFields={rowFields} />
        </Section>
        <Section title="Conditional formatting" paths={[["conditional"], ["dataBars"], ["icons"]]}>
          <ConditionalFields values={values} format={current} set={set} groupName={visual === "pivot" ? rowFields[0] ?? null : groupName} />
        </Section>
        <Section title="Title and card" paths={["card"]}>
          <CardFields format={current} set={set} />
        </Section>
      </div>
      </SourceProvider>
    );
  }

  const groupColour = (name: string) => current.categoryColors?.find((entry) => entry.name === name)?.color;
  const setGroupColour = (name: string, color: string | undefined) => {
    const others = (current.categoryColors ?? []).filter((entry) => entry.name !== name);
    set({ categoryColors: color ? [...others, { name, color }] : others.length ? others : undefined });
  };
  const groupColoursAllowed = (can.round || can.funnel || can.waterfall || can.bullet || can.treemap || can.sankey || can.pointmap || ((visual === "column" || visual === "bar") && values.length === 1)) && groups.length > 0;
  // Funnels show their labels unless turned off, like pies.
  const labelsByDefault = can.round || can.funnel;

  return (
    <SourceProvider value={sourceInfo}>
    <div className={styles.panel}>
      {heading}
      {extra}
      {!can.kpi ? (
        <Section title="Colours" paths={[["palette"], ["colorByCategory"], ["categoryColors"], ["negativeRed"]]}>
          <Field label="Colours" hint={tooManyForBlues ? "Tohyee blues has 4 shades, so this chart uses the full colours." : undefined}>
            <select value={current.palette ?? "tohyee"} onChange={(event) => set({ palette: event.target.value === "tohyee" ? undefined : (event.target.value as PaletteId) })}>
              {(Object.keys(PALETTES) as PaletteId[]).map((id) => <option key={id} value={id}>{PALETTES[id].label}</option>)}
            </select>
          </Field>
          {can.colorByCategory && values.length === 1 ? (
            <Check label="A colour for each group (up to 8)" checked={current.colorByCategory === true} onChange={(checked) => set({ colorByCategory: checked || undefined })} />
          ) : null}
          {can.bars ? (
            <Check label="Red when below zero" checked={current.negativeRed === true} onChange={(checked) => set({ negativeRed: checked || undefined })} />
          ) : null}
          {groupColoursAllowed ? (
            <details className={styles.inner}>
              <summary>Colour a group</summary>
              {groups.slice(0, 20).map((name) => (
                <ColourInput key={name} label={name || "(blank)"} value={groupColour(name)} onChange={(color) => setGroupColour(name, color)} />
              ))}
              {groups.length > 20 ? <p className={styles.note}>The first 20 groups are listed.</p> : null}
            </details>
          ) : null}
          {warnings.length ? (
            <Notice tone="warning">
              <ul className={styles.list}>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </Notice>
          ) : null}
        </Section>
      ) : null}
      <Section title={values.length > 1 ? "Values" : "Value"} open={can.secondAxis && values.length > 1} paths={["series"]}>
        {values.map((name, index) => {
          const series = seriesAt(index);
          const label = name || `Value ${index + 1}`;
          const isLine = can.lines && (visual !== "combo" || (series.as ?? (index === 0 ? "bar" : "line")) === "line");
          return (
            <fieldset key={index} className={styles.group}>
              <legend>{label}</legend>
              {values.length > 1 ? <SourceTag paths={["series", index]} what={label} /> : null}
              {can.columnOrLine ? (
                <Field label="Show as">
                  <select aria-label={`${name} show as`} value={series.as ?? (index === 0 ? "bar" : "line")} onChange={(event) => setSeries(index, { as: event.target.value as "bar" | "line" })}>
                    <option value="bar">Columns</option>
                    <option value="line">Line</option>
                  </select>
                </Field>
              ) : null}
              {can.secondAxis ? (
                <Field label="Axis">
                  <select aria-label={`${name} axis`} value={series.axis ?? "left"} onChange={(event) => setSeries(index, { axis: event.target.value === "right" ? "right" : undefined })}>
                    <option value="left">Left</option>
                    <option value="right">Right (its own scale)</option>
                  </select>
                </Field>
              ) : null}
              {!can.round && !can.kpi && !can.scale && !can.treemap && !can.sankey && !(current.colorByCategory && values.length === 1) ? (
                <>
                  <div className={styles.colourRow}>
                    <Swatch hue={series.color} hex={series.hex} />
                    <Field label="Colour">
                      <select aria-label={`${name} colour`} value={series.color ?? ""} disabled={Boolean(series.hex)} onChange={(event) => setSeries(index, { color: (event.target.value || undefined) as Hue | undefined })}>
                        <option value="">Automatic</option>
                        {HUES.map((hue) => <option key={hue} value={hue}>{HUE_LABELS[hue]}</option>)}
                      </select>
                    </Field>
                  </div>
                  <ColourInput label={`${label}: any colour`} value={series.hex} onChange={(hex) => setSeries(index, { hex })} />
                </>
              ) : null}
              {isLine ? (
                <div className={styles.pair}>
                  <NumberBox label="Line width" value={series.lineWidth} min={1} max={6} placeholder="2" onChange={(lineWidth) => setSeries(index, { lineWidth })} />
                  <StyleSelect label="Line style" value={series.lineStyle} onChange={(lineStyle) => setSeries(index, { lineStyle })} />
                  <Check label="Step line" checked={series.step === true} onChange={(checked) => setSeries(index, { step: checked || undefined })} />
                  <Field label="Dots">
                    <select value={series.markers === undefined ? "" : series.markers ? "on" : "off"} onChange={(event) => setSeries(index, { markers: event.target.value === "" ? undefined : event.target.value === "on" })}>
                      <option value="">As the chart</option>
                      <option value="on">Show</option>
                      <option value="off">Hide</option>
                    </select>
                  </Field>
                </div>
              ) : null}
              {can.cartesian && current.stack !== "percent" && (advanced || series.trend || series.forecast) ? (
                <div className={styles.pair}>
                  <Check label="Trend line" checked={series.trend === true} onChange={(checked) => setSeries(index, { trend: checked || undefined })} />
                  <NumberBox label="Forecast" hint="Groups to carry the trend on (1 to 12)" value={series.forecast} min={1} max={12} placeholder="None" onChange={(forecast) => setSeries(index, { forecast })} />
                </div>
              ) : null}
              <div className={styles.group}>
                <SourceTag paths={["series", index, "number"]} what={`${label} number format`} name="Number format" />
                <NumberFields name={name} value={series.number} labels={can.kpi} onChange={(number) => setSeries(index, { number })} />
              </div>
            </fieldset>
          );
        })}
      </Section>
      <VisualSettings visual={visual} values={values} format={current} set={set} smallMultiples={smallMultiples} />
      {!can.kpi ? (
        <>
          {can.labels ? (
          <Section title="Data labels" paths={["labels"]}>
            <Check label="Show values on the chart" checked={current.labels?.show ?? labelsByDefault} onChange={(checked) => set({ labels: { ...current.labels, show: checked === labelsByDefault ? undefined : checked } })} />
            <div className={styles.pair}>
              {can.round || can.funnel || can.cartesian ? (
              <Field label="Label position">
                <select value={current.labels?.position ?? "auto"} onChange={(event) => set({ labels: { ...current.labels, position: event.target.value === "auto" ? undefined : (event.target.value as "inside" | "outside") } })}>
                  <option value="auto">Automatic</option>
                  <option value="inside">Inside</option>
                  <option value="outside">Outside</option>
                </select>
              </Field>
              ) : null}
              {!can.round && !can.funnel ? (
                <Field label="Which labels">
                  <select value={current.labels?.density ?? "all"} onChange={(event) => set({ labels: { ...current.labels, density: event.target.value === "all" ? undefined : (event.target.value as "auto" | "ends") } })}>
                    <option value="all">All</option>
                    <option value="auto">Only where they fit</option>
                    <option value="ends">First and last</option>
                  </select>
                </Field>
              ) : null}
              <NumberBox label="Label size" value={current.labels?.size} min={8} max={24} placeholder="12" onChange={(size) => set({ labels: { ...current.labels, size } })} />
            </div>
            {can.round ? (
              <div className={styles.pair}>
                <Check label="Group name" checked={current.labels?.content?.category ?? true} onChange={(checked) => set({ labels: { ...current.labels, content: { ...current.labels?.content, category: checked ? undefined : false } } })} />
                <Check label="Value" checked={current.labels?.content?.value ?? current.labels?.show === true} onChange={(checked) => set({ labels: { ...current.labels, content: { ...current.labels?.content, value: checked } } })} />
                <Check label="Percentage" checked={current.labels?.content?.percent ?? true} onChange={(checked) => set({ labels: { ...current.labels, content: { ...current.labels?.content, percent: checked ? undefined : false } } })} />
              </div>
            ) : null}
            <ColourInput label="Label colour" value={current.labels?.color} onChange={(color) => set({ labels: { ...current.labels, color } })} />
            <details className={styles.inner}>
              <summary>Number format on the labels</summary>
              <p className={styles.note}>Left automatic, labels use each value&apos;s own format.</p>
              <NumberFields name="Data label" value={current.labels?.number} labels={false} onChange={(number) => set({ labels: { ...current.labels, number } })} />
            </details>
          </Section>
          ) : null}
          {can.legend ? (
          <Section title="Legend" paths={["legend"]}>
            <div className={styles.pair}>
              <Field label="Legend">
                <select value={current.legend?.show ?? "auto"} onChange={(event) => set({ legend: { ...current.legend, show: event.target.value === "auto" ? undefined : (event.target.value as "show" | "hide") } })}>
                  <option value="auto">Automatic</option>
                  <option value="show">Show</option>
                  <option value="hide">Hide</option>
                </select>
              </Field>
              <Field label="Legend position">
                <select value={current.legend?.position ?? "top"} onChange={(event) => set({ legend: { ...current.legend, position: event.target.value === "top" ? undefined : (event.target.value as LegendPosition) } })}>
                  {LEGEND_POSITIONS.map((position) => <option key={position} value={position}>{LEGEND_LABELS[position]}</option>)}
                </select>
              </Field>
              <NumberBox label="Legend text size" value={current.legend?.size} min={8} max={20} placeholder="12" onChange={(size) => set({ legend: { ...current.legend, size } })} />
              <Field label="Legend title">
                <input maxLength={60} value={current.legend?.title ?? ""} onChange={(event) => set({ legend: { ...current.legend, title: event.target.value || undefined } })} />
              </Field>
            </div>
          </Section>
          ) : null}
          {can.axes ? (
            <Section title="Axes" paths={[["categoryAxis"], ["valueAxis"], ["rightAxis"], ["xAxis"]]}>
              {can.groupAxis ? (
              <fieldset className={styles.group}>
                <legend>{visual === "bar" || visual === "bullet" ? "Group axis (down the side)" : "Group axis (along the bottom)"}</legend>
                <Field label="Title">
                  <input aria-label="Group axis title" maxLength={60} value={current.categoryAxis?.title ?? ""} onChange={(event) => set({ categoryAxis: { ...current.categoryAxis, title: event.target.value || undefined } })} />
                </Field>
                <Check label="Gridlines" checked={current.categoryAxis?.gridlines === true} onChange={(checked) => set({ categoryAxis: { ...current.categoryAxis, gridlines: checked || undefined } })} />
                <NumberBox label="Show every" hint="0 shows every label, 1 every second, and so on" value={current.categoryAxis?.interval} min={0} max={50} onChange={(interval) => set({ categoryAxis: { ...current.categoryAxis, interval } })} />
                <AxisLookFields name="Group axis" value={current.categoryAxis} onChange={(patch) => set({ categoryAxis: { ...current.categoryAxis, ...patch } })} />
                {datedGroups ? (
                  <div className={styles.pair}>
                    <Field label="From date" hint="Only groups from this date">
                      <input type="date" value={current.categoryAxis?.from ?? ""} onChange={(event) => set({ categoryAxis: { ...current.categoryAxis, from: event.target.value || undefined } })} />
                    </Field>
                    <Field label="To date">
                      <input type="date" value={current.categoryAxis?.to ?? ""} onChange={(event) => set({ categoryAxis: { ...current.categoryAxis, to: event.target.value || undefined } })} />
                    </Field>
                  </div>
                ) : null}
              </fieldset>
              ) : (
                <AxisFields name="Across axis" value={current.xAxis} defaultGridlines advanced={advanced} onChange={(xAxis) => set({ xAxis })} />
              )}
              <AxisFields name={usesRight ? "Left axis" : can.scatter ? "Up axis" : can.histogram ? "Count axis" : "Value axis"} value={current.valueAxis} defaultGridlines advanced={advanced} onChange={(valueAxis) => set({ valueAxis })} />
              {usesRight ? <AxisFields name="Right axis" value={current.rightAxis} defaultGridlines={false} advanced={advanced} onChange={(rightAxis) => set({ rightAxis })} /> : null}
            </Section>
          ) : null}
          {can.axes && advanced ? (
            <Section title="Gridlines and plot area" paths={[["gridlines"], ["plot"]]}>
              <StyleSelect label="Gridline style" value={current.gridlines?.style} onChange={(style) => set({ gridlines: { ...current.gridlines, style } })} />
              <ColourInput label="Gridline colour" value={current.gridlines?.color} onChange={(color) => set({ gridlines: { ...current.gridlines, color } })} />
              <ColourInput label="Plot area background" value={current.plot?.background} onChange={(background) => set({ plot: { background } })} />
            </Section>
          ) : null}
          {can.rules && advanced ? (
            <Section title="Colour rules" paths={["chartRules"]}>
              <ChartRuleFields values={values} format={current} set={set} />
            </Section>
          ) : null}
          {can.cartesian && advanced ? (
            <Section title="Reference lines" paths={["referenceLines"]}>
              <p className={styles.note}>Lines across the {visual === "bar" ? "bottom" : "left"} axis: a fixed value or target, the average, median, lowest, highest or a percentile of a value, or a shaded band.</p>
              <ReferenceLines values={values} lines={current.referenceLines ?? []} onChange={(referenceLines) => set({ referenceLines: referenceLines?.length ? referenceLines : undefined })} />
            </Section>
          ) : null}
          {can.stack || can.lines || can.donutTotal || can.thickness ? (
            <Section title="Chart options" paths={[["stack"], ["bars"], ["smooth"], ["markers"], ["donutTotal"]]}>
              {can.stack ? (
                <Field label="Stacking">
                  <select value={current.stack ?? "none"} onChange={(event) => set({ stack: event.target.value === "none" ? undefined : (event.target.value as "stacked" | "percent") })}>
                    <option value="none">Side by side</option>
                    <option value="stacked">Stacked</option>
                    <option value="percent">100% stacked</option>
                  </select>
                </Field>
              ) : null}
              {can.thickness ? (
                <div className={styles.pair}>
                  <NumberBox label="Column thickness" hint="Most pixels wide, 4 to 80" value={current.bars?.thickness} min={4} max={80} placeholder="24" onChange={(thickness) => set({ bars: { ...current.bars, thickness } })} />
                  {can.bars ? <NumberBox label="Gap between groups" hint="% of each group's space, 0 to 90" value={current.bars?.gap} min={0} max={90} placeholder="40" onChange={(gap) => set({ bars: { ...current.bars, gap } })} /> : null}
                  <Check label="Rounded ends" checked={current.bars?.rounded !== false} onChange={(checked) => set({ bars: { ...current.bars, rounded: checked ? undefined : false } })} />
                </div>
              ) : null}
              {can.lines ? (
                <>
                  <Check label="Smooth lines" checked={current.smooth === true} onChange={(checked) => set({ smooth: checked || undefined })} />
                  <Check label="Dots on lines" checked={current.markers !== false} onChange={(checked) => set({ markers: checked ? undefined : false })} />
                </>
              ) : null}
              {can.donutTotal ? <Check label="Total in the middle" checked={current.donutTotal === true} onChange={(checked) => set({ donutTotal: checked || undefined })} /> : null}
            </Section>
          ) : null}
        </>
      ) : null}
      <Section title="Title and card" paths={["card"]}>
        <CardFields format={current} set={set} />
      </Section>
    </div>
    </SourceProvider>
  );
}

const LEGEND_LABELS: Record<LegendPosition, string> = {
  top: "Top, centred",
  "top-left": "Top left",
  "top-right": "Top right",
  bottom: "Bottom, centred",
  "bottom-left": "Bottom left",
  "bottom-right": "Bottom right",
  left: "Left",
  right: "Right",
};

function CardFields({ format, set }: { format: ChartFormat; set: (patch: Partial<ChartFormat>) => void }) {
  const card = format.card ?? {};
  const setCard = (patch: Partial<CardFormat>) => set({ card: { ...card, ...patch } });
  return (
    <>
      <Check label="Show the title" checked={card.showTitle !== false} onChange={(checked) => setCard({ showTitle: checked ? undefined : false })} />
      {card.showTitle !== false ? (
        <details className={styles.inner}>
          <summary>Title style</summary>
          <TextFields name="Title" value={card.title} onChange={(title) => setCard({ title: { ...card.title, ...title } })} />
          <ColourInput label="Behind the title" value={card.title?.background} resetLabel="No colour" onChange={(background) => setCard({ title: { ...card.title, background } })} />
        </details>
      ) : null}
      <Field label="Subtitle or note">
        <textarea rows={2} maxLength={200} value={card.subtitle ?? ""} onChange={(event) => setCard({ subtitle: event.target.value || undefined })} />
      </Field>
      {card.subtitle ? (
        <details className={styles.inner}>
          <summary>Subtitle style</summary>
          <TextFields name="Subtitle" value={card.subtitleStyle} maxSize={24} onChange={(subtitleStyle) => setCard({ subtitleStyle })} />
        </details>
      ) : null}
      <div className={styles.pair}>
        <Field label="Background">
          <select value={card.background ?? "plain"} onChange={(event) => setCard({ background: event.target.value === "plain" ? undefined : (event.target.value as "tinted" | "none") })}>
            <option value="plain">Plain</option>
            <option value="tinted">Shaded</option>
            <option value="none">None (sits on the page)</option>
          </select>
        </Field>
        <Check label="Border" checked={card.border !== false} onChange={(checked) => setCard({ border: checked ? undefined : false })} />
      </div>
      <details className={styles.inner}>
        <summary>Card colour, border, corners and shadow</summary>
        <ColourInput label="Card colour" value={card.fill} onChange={(fill) => setCard({ fill })} />
        <div className={styles.pair}>
          <NumberBox label="Background opacity" hint="% solid, 0 to 100" value={card.opacity} min={0} max={100} placeholder="100" onChange={(opacity) => setCard({ opacity })} />
          <NumberBox label="Border width" hint="0 to 6 pixels" value={card.borderWidth} min={0} max={6} onChange={(borderWidth) => setCard({ borderWidth })} />
          <NumberBox label="Corner radius" hint="0 to 24 pixels" value={card.radius} min={0} max={24} onChange={(radius) => setCard({ radius })} />
          <NumberBox label="Padding" hint="0 to 32 pixels" value={card.padding} min={0} max={32} onChange={(padding) => setCard({ padding })} />
          <Field label="Shadow">
            <select value={card.shadow ?? ""} onChange={(event) => setCard({ shadow: (event.target.value || undefined) as CardFormat["shadow"] })}>
              <option value="">As the theme</option>
              <option value="none">None</option>
              <option value="soft">Soft</option>
              <option value="strong">Strong</option>
            </select>
          </Field>
        </div>
        <ColourInput label="Border colour" value={card.borderColor} onChange={(borderColor) => setCard({ borderColor })} />
      </details>
    </>
  );
}

/** "Set as default for this chart type in this report" (Power BI's visual defaults, #376). */
function DefaultButtons({ visual, current, inherited, onSetDefault }: { visual: Visual; current: ChartFormat; inherited?: ChartFormat; onSetDefault?: (format: ChartFormat | undefined) => void }) {
  if (!onSetDefault) return null;
  const name = VISUAL_NAMES[visual].toLowerCase();
  const look = painterFormat(tidyFormat(current));
  return (
    <div className={styles.defaults}>
      <Button size="small" variant="secondary" disabled={!look || JSON.stringify(look) === JSON.stringify(inherited)} onClick={() => onSetDefault(look)}>
        Set as default for {name} in this report
      </Button>
      {inherited ? (
        <Button size="small" variant="secondary" onClick={() => onSetDefault(undefined)}>
          Clear the {name} default
        </Button>
      ) : null}
      {inherited ? <p className={styles.note}>This report has a default look for {name} charts; settings here go over it.</p> : null}
    </div>
  );
}

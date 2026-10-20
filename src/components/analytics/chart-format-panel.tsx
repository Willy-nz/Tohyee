"use client";

import type { ReactNode } from "react";
import { Button, Field, ui } from "@/components/ui";
import {
  HUE_LABELS,
  HUES,
  PALETTES,
  formatOptionsFor,
  mergeFormats,
  painterFormat,
  VISUAL_NAMES,
  type AxisFormat,
  type ChartFormat,
  type Hue,
  type NumberFormat,
  type PaletteId,
  type SeriesFormat,
} from "@/lib/analytics/chart-format";
import type { Visual } from "@/lib/analytics/query";
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

function Section({ title, children, open }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className={styles.section} open={open}>
      <summary>{title}</summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}

function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string }) {
  return (
    <label className={ui.checkbox} title={hint}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /> {label}
    </label>
  );
}

function Swatch({ hue }: { hue: Hue | undefined }) {
  if (!hue) return <span className={`${styles.swatch} ${styles.auto}`} aria-hidden="true" />;
  return <span className={styles.swatch} style={{ background: `var(--chart-${HUES.indexOf(hue) + 1})` }} aria-hidden="true" />;
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

function AxisFields({ name, value, onChange, defaultGridlines }: { name: string; value: AxisFormat | undefined; onChange: (value: AxisFormat) => void; defaultGridlines: boolean }) {
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
      </div>
      <Check label="Gridlines" checked={current.gridlines ?? defaultGridlines} onChange={(checked) => onChange({ ...current, gridlines: checked === defaultGridlines ? undefined : checked })} />
      <Check label="Start at zero" checked={current.zero !== false} onChange={(checked) => onChange({ ...current, zero: checked ? undefined : false })} />
      <Check label="Log scale" hint="For values above zero that range from small to very large" checked={current.log === true} onChange={(checked) => onChange({ ...current, log: checked || undefined })} />
    </fieldset>
  );
}

/** The Format section of the chart panel (#331, #333): every change shows in the preview straight away. */
export function ChartFormatPanel({ visual, values, format, onChange, inherited, onSetDefault }: Props) {
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

  if (visual === "table" || visual === "pivot") {
    return (
      <div className={styles.panel}>
        <div className={styles.heading}>
          <h3>Format</h3>
          <Button size="small" variant="secondary" disabled={!format} onClick={() => onChange(undefined)} title={inherited ? "Back to this report's default for the chart type" : undefined}>Reset to default</Button>
        </div>
        <DefaultButtons visual={visual} current={current} inherited={inherited} onSetDefault={onSetDefault} />
        <Section title="Card">
          <CardFields format={current} set={set} />
        </Section>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.heading}>
        <h3>Format</h3>
        <Button size="small" variant="secondary" disabled={!format} onClick={() => onChange(undefined)} title={inherited ? "Back to this report's default for the chart type" : undefined}>Reset to default</Button>
      </div>
      <DefaultButtons visual={visual} current={current} inherited={inherited} onSetDefault={onSetDefault} />
      {!can.kpi ? (
        <Section title="Colours">
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
        </Section>
      ) : null}
      <Section title={values.length > 1 ? "Values" : "Value"} open={can.secondAxis && values.length > 1}>
        {values.map((name, index) => {
          const series = seriesAt(index);
          return (
            <fieldset key={index} className={styles.group}>
              <legend>{name || `Value ${index + 1}`}</legend>
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
              {!can.round && !can.kpi && !(current.colorByCategory && values.length === 1) ? (
                <div className={styles.colourRow}>
                  <Swatch hue={series.color} />
                  <Field label="Colour">
                    <select aria-label={`${name} colour`} value={series.color ?? ""} onChange={(event) => setSeries(index, { color: (event.target.value || undefined) as Hue | undefined })}>
                      <option value="">Automatic</option>
                      {HUES.map((hue) => <option key={hue} value={hue}>{HUE_LABELS[hue]}</option>)}
                    </select>
                  </Field>
                </div>
              ) : null}
              <NumberFields name={name} value={series.number} labels={can.kpi} onChange={(number) => setSeries(index, { number })} />
            </fieldset>
          );
        })}
      </Section>
      {!can.kpi ? (
        <>
          <Section title="Data labels and legend">
            <Check label="Show values on the chart" checked={current.labels?.show ?? can.round} onChange={(checked) => set({ labels: { ...current.labels, show: checked === can.round ? undefined : checked } })} />
            <Field label="Label position">
              <select value={current.labels?.position ?? "auto"} onChange={(event) => set({ labels: { ...current.labels, position: event.target.value === "auto" ? undefined : (event.target.value as "inside" | "outside") } })}>
                <option value="auto">Automatic</option>
                <option value="inside">Inside</option>
                <option value="outside">Outside</option>
              </select>
            </Field>
            <div className={styles.pair}>
              <Field label="Legend">
                <select value={current.legend?.show ?? "auto"} onChange={(event) => set({ legend: { ...current.legend, show: event.target.value === "auto" ? undefined : (event.target.value as "show" | "hide") } })}>
                  <option value="auto">Automatic</option>
                  <option value="show">Show</option>
                  <option value="hide">Hide</option>
                </select>
              </Field>
              <Field label="Legend position">
                <select value={current.legend?.position ?? "top"} onChange={(event) => set({ legend: { ...current.legend, position: event.target.value === "top" ? undefined : (event.target.value as "bottom" | "right") } })}>
                  <option value="top">Top</option>
                  <option value="bottom">Bottom</option>
                  <option value="right">Right</option>
                </select>
              </Field>
            </div>
          </Section>
          {can.cartesian ? (
            <Section title="Axes">
              <fieldset className={styles.group}>
                <legend>{visual === "bar" ? "Group axis (down the side)" : "Group axis (along the bottom)"}</legend>
                <Field label="Title">
                  <input aria-label="Group axis title" maxLength={60} value={current.categoryAxis?.title ?? ""} onChange={(event) => set({ categoryAxis: { ...current.categoryAxis, title: event.target.value || undefined } })} />
                </Field>
                <Check label="Gridlines" checked={current.categoryAxis?.gridlines === true} onChange={(checked) => set({ categoryAxis: { ...current.categoryAxis, gridlines: checked || undefined } })} />
              </fieldset>
              <AxisFields name={usesRight ? "Left axis" : "Value axis"} value={current.valueAxis} defaultGridlines onChange={(valueAxis) => set({ valueAxis })} />
              {usesRight ? <AxisFields name="Right axis" value={current.rightAxis} defaultGridlines={false} onChange={(rightAxis) => set({ rightAxis })} /> : null}
            </Section>
          ) : null}
          {can.stack || can.lines || can.donutTotal ? (
            <Section title="Chart options">
              {can.stack ? (
                <Field label="Stacking">
                  <select value={current.stack ?? "none"} onChange={(event) => set({ stack: event.target.value === "none" ? undefined : (event.target.value as "stacked" | "percent") })}>
                    <option value="none">Side by side</option>
                    <option value="stacked">Stacked</option>
                    <option value="percent">100% stacked</option>
                  </select>
                </Field>
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
      <Section title="Card">
        <CardFields format={current} set={set} />
      </Section>
    </div>
  );
}

function CardFields({ format, set }: { format: ChartFormat; set: (patch: Partial<ChartFormat>) => void }) {
  const card = format.card ?? {};
  return (
    <>
      <Check label="Show the title" checked={card.showTitle !== false} onChange={(checked) => set({ card: { ...card, showTitle: checked ? undefined : false } })} />
      <Field label="Subtitle or note">
        <textarea rows={2} maxLength={200} value={card.subtitle ?? ""} onChange={(event) => set({ card: { ...card, subtitle: event.target.value || undefined } })} />
      </Field>
      <div className={styles.pair}>
        <Field label="Background">
          <select value={card.background ?? "plain"} onChange={(event) => set({ card: { ...card, background: event.target.value === "plain" ? undefined : (event.target.value as "tinted" | "none") } })}>
            <option value="plain">Plain</option>
            <option value="tinted">Shaded</option>
            <option value="none">None (sits on the page)</option>
          </select>
        </Field>
        <Check label="Border" checked={card.border !== false} onChange={(checked) => set({ card: { ...card, border: checked ? undefined : false } })} />
      </div>
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

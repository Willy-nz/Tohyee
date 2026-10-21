"use client";

import { useState, type ReactNode } from "react";
import { ColourInput } from "@/components/analytics/colour-input";
import { Field, ui } from "@/components/ui";
import type { BulletFormat, ChartFormat, FunnelFormat, GaugeFormat, WaterfallFormat } from "@/lib/analytics/chart-format";
import type { Visual } from "@/lib/analytics/query";
import styles from "./chart-format-panel.module.css";

/**
 * Settings that belong to one of the #376 phase 2 visuals (waterfall,
 * funnel, gauge, bullet chart), shown in the Format panel above the shared
 * sections. Everything is saved through `parseChartFormat` like the rest.
 */

type Props = { visual: Visual; values: string[]; format: ChartFormat; set: (patch: Partial<ChartFormat>) => void };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className={styles.section} open>
      <summary>{title}</summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className={ui.checkbox}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /> {label}
    </label>
  );
}

const NUMBER = /^-?\d{1,15}(\.\d{1,6})?$/;

/** A typed number (kept as text so it stays exact); only saved once it's a number, blank clears it. */
function NumberText({ label, hint, value, onChange }: { label: string; hint?: string; value: string | undefined; onChange: (value: string | undefined) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value ?? "";
  const bad = shown.trim() !== "" && !NUMBER.test(shown.trim());
  return (
    <Field label={label} hint={bad ? "Enter a number, e.g. 1500 or -2.5." : hint}>
      <input
        inputMode="decimal"
        value={shown}
        aria-invalid={bad || undefined}
        placeholder="Automatic"
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          if (text.trim() === "") onChange(undefined);
          else if (NUMBER.test(text.trim())) onChange(text.trim());
        }}
        onBlur={() => setDraft(null)}
      />
    </Field>
  );
}

export function VisualSettings({ visual, values, format, set }: Props) {
  if (visual === "waterfall") {
    const current: WaterfallFormat = format.waterfall ?? {};
    const update = (patch: Partial<WaterfallFormat>) => set({ waterfall: { ...current, ...patch } });
    return (
      <Section title="Waterfall">
        <p className={styles.note}>Each group moves the running total up or down from where the last one ended; the total bar shows where it finished. Running totals are added exactly.</p>
        <Check label="Total bar at the end" checked={current.total !== false} onChange={(checked) => update({ total: checked ? undefined : false })} />
        {current.total !== false ? (
          <Field label="Total bar name">
            <input maxLength={40} placeholder="Total" value={current.totalLabel ?? ""} onChange={(event) => update({ totalLabel: event.target.value || undefined })} />
          </Field>
        ) : null}
        <Check label="Lines joining the bars" checked={current.connectors !== false} onChange={(checked) => update({ connectors: checked ? undefined : false })} />
        <ColourInput label="Rise colour" value={current.increase} onChange={(increase) => update({ increase })} />
        <ColourInput label="Fall colour" value={current.decrease} onChange={(decrease) => update({ decrease })} />
        <ColourInput label="Total colour" value={current.totalColor} onChange={(totalColor) => update({ totalColor })} />
      </Section>
    );
  }
  if (visual === "funnel") {
    const current: FunnelFormat = format.funnel ?? {};
    return (
      <Section title="Funnel">
        <p className={styles.note}>Stages are drawn in the tile&apos;s order (Order by), widest first if you order by the value, largest first.</p>
        <Field label="Percentage on each stage">
          <select value={current.percent ?? "first"} onChange={(event) => set({ funnel: { percent: event.target.value === "first" ? undefined : (event.target.value as FunnelFormat["percent"]) } })}>
            <option value="first">Share of the first stage</option>
            <option value="previous">Share of the stage before</option>
            <option value="none">None</option>
          </select>
        </Field>
      </Section>
    );
  }
  if (visual === "gauge") {
    const current: GaugeFormat = format.gauge ?? {};
    const update = (patch: Partial<GaugeFormat>) => set({ gauge: { ...current, ...patch } });
    return (
      <Section title="Gauge">
        <div className={styles.pair}>
          <NumberText label="Minimum" hint="Left blank: 0" value={current.min} onChange={(min) => update({ min })} />
          <NumberText label="Maximum" hint="Left blank: twice the value, or the target if that's further" value={current.max} onChange={(max) => update({ max })} />
        </div>
        {values.length > 1 ? (
          <p className={styles.note}>The target is the second value, {values[1] || "Value 2"}.</p>
        ) : (
          <NumberText label="Target" hint="Or add a second value to use as the target." value={current.target} onChange={(target) => update({ target })} />
        )}
      </Section>
    );
  }
  if (visual === "bullet") {
    const current: BulletFormat = format.bullet ?? {};
    const update = (patch: Partial<BulletFormat>) => set({ bullet: { ...current, ...patch } });
    return (
      <Section title="Bullet chart">
        <p className={styles.note}>Each bar is the first value; the upright line is the target; the grey bands behind show how far along it is.</p>
        {values.length > 1 ? (
          <p className={styles.note}>The target is the second value, {values[1] || "Value 2"}.</p>
        ) : (
          <NumberText label="Target" hint="The same for every group. Or add a second value to use as each group's target." value={current.target} onChange={(target) => update({ target })} />
        )}
        <BandsField bands={current.bands} onChange={(bands) => update({ bands })} />
      </Section>
    );
  }
  return null;
}

/** Where the bullet chart's bands change, typed as "60, 80" and kept when it makes sense (on leaving the box). */
export function parseBands(text: string): number[] | null | undefined {
  const parts = text.split(/[,\s]+/).filter(Boolean);
  if (!parts.length) return undefined;
  const numbers = parts.map(Number);
  if (parts.length > 3 || numbers.some((number) => !Number.isInteger(number) || number < 1 || number > 300)) return null;
  if (numbers.some((number, index) => index > 0 && number <= numbers[index - 1])) return null;
  return numbers;
}

function BandsField({ bands, onChange }: { bands: number[] | undefined; onChange: (bands: number[] | undefined) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (bands ?? [60, 80]).join(", ");
  const parsed = parseBands(shown);
  return (
    <Field label="Bands change at (% of the target)" hint={parsed === null ? "Up to three whole numbers going up, e.g. 60, 80." : "Up to three, e.g. 60, 80. The last band runs on to 120% of the target, or the value if that's further."}>
      <input
        value={shown}
        aria-invalid={parsed === null || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (parsed !== null) onChange(parsed && parsed.join(",") === "60,80" ? undefined : parsed);
          setDraft(null);
        }}
      />
    </Field>
  );
}

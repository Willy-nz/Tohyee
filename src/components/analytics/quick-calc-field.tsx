"use client";

import { ui } from "@/components/ui";
import type { Measure } from "@/lib/analytics/query";
import { TIME_PERIODS, type TimePeriod } from "@/lib/analytics/time-intelligence";
import { DEFAULT_MOVING_PERIODS, MAX_MOVING_PERIODS, MIN_MOVING_PERIODS, QUICK_KINDS, type QuickCalc, type QuickKind } from "@/lib/analytics/quick-calcs";

/** The words added to a value's name for each quick calculation, so a chart never shows a running total as plain "Sales". */
export const QUICK_SUFFIXES: Record<QuickKind, string> = {
  running_total: "running total",
  percent_of_total: "% of total",
  percent_of_row: "% of row",
  percent_of_column: "% of column",
  rank: "rank",
  difference: "change",
  percent_change: "% change",
  moving_average: "moving average",
};

const SUFFIX = new RegExp(` \\((${[...Object.values(QUICK_SUFFIXES), ...TIME_PERIODS.map((entry) => entry.suffix)].map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\)$`);

/** A value's name with the quick calculation's words in brackets (any earlier ones taken off). */
export function quickLabel(label: string, quick: QuickCalc | undefined): string {
  const base = label.replace(SUFFIX, "");
  return quick ? `${base} (${QUICK_SUFFIXES[quick.kind]})`.slice(0, 80) : base;
}

/** Which quick calculations a value can have where it is (the server checks again). */
export function quickChoices(place: { grouped: boolean; breakdown: boolean; pivot: boolean; pivotColumn: boolean }): QuickKind[] {
  if (place.pivot) return ["percent_of_total", ...(place.pivotColumn ? (["percent_of_row"] as const) : []), "percent_of_column"];
  if (!place.grouped) return [];
  return QUICK_KINDS.map((entry) => entry.value).filter((kind) => place.breakdown || (kind !== "percent_of_row" && kind !== "percent_of_column"));
}

/**
 * "Show as" for one value (decision 770): the value itself, or a quick
 * calculation of it. Choosing one adds its words to the value's name.
 */
export function QuickCalcField({
  index,
  measure,
  choices,
  onChange,
}: {
  index: number;
  measure: Measure;
  choices: QuickKind[];
  onChange: (patch: Partial<Measure>) => void;
}) {
  if (!choices.length) return null;
  const quick = measure.quick;
  const choose = (kind: string) => {
    const next: QuickCalc | undefined = !kind ? undefined : kind === "moving_average" ? { kind, periods: DEFAULT_MOVING_PERIODS } : { kind: kind as QuickKind };
    onChange({ quick: next, label: quickLabel(measure.label, next), ...(next ? { period: undefined } : {}) });
  };
  return (
    <>
      <label className={ui.checkbox} style={{ whiteSpace: "nowrap" }}>
        Show as{" "}
        <select aria-label={`Value ${index + 1} show as`} value={quick?.kind ?? ""} disabled={Boolean(measure.compare) && !quick} onChange={(event) => choose(event.target.value)}>
          <option value="">The value</option>
          {QUICK_KINDS.filter((entry) => choices.includes(entry.value) || entry.value === quick?.kind).map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      {quick?.kind === "moving_average" ? (
        <label className={ui.checkbox}>
          over{" "}
          <input
            aria-label={`Value ${index + 1} moving average periods`}
            type="number"
            min={MIN_MOVING_PERIODS}
            max={MAX_MOVING_PERIODS}
            value={quick.periods ?? DEFAULT_MOVING_PERIODS}
            onChange={(event) => onChange({ quick: { ...quick, periods: Number(event.target.value) || DEFAULT_MOVING_PERIODS } })}
            style={{ width: "4rem" }}
          />{" "}
          groups
        </label>
      ) : null}
      {quick?.kind === "rank" ? (
        <label className={ui.checkbox}>
          <input type="checkbox" checked={quick.smallestFirst === true} onChange={(event) => onChange({ quick: { kind: "rank", ...(event.target.checked ? { smallestFirst: true as const } : {}) } })} /> smallest is 1
        </label>
      ) : null}
    </>
  );
}

/** A value's name with its period's words (decision 771), any earlier quick or period words taken off. */
export function periodLabel(label: string, period: TimePeriod | undefined): string {
  const base = label.replace(SUFFIX, "");
  const words = TIME_PERIODS.find((entry) => entry.value === period)?.suffix;
  return words ? `${base} (${words})`.slice(0, 80) : base;
}

/**
 * "Over" for one value (decision 771): the dashboard's dates, or the
 * financial year, quarter or month to date, or the last 12 months.
 */
export function PeriodField({ index, measure, dated, onChange }: { index: number; measure: Measure; dated: boolean; onChange: (patch: Partial<Measure>) => void }) {
  if (!dated) return null;
  return (
    <label className={ui.checkbox} style={{ whiteSpace: "nowrap" }}>
      Over{" "}
      <select
        aria-label={`Value ${index + 1} over`}
        value={measure.period ?? ""}
        onChange={(event) => {
          const period = (event.target.value || undefined) as TimePeriod | undefined;
          onChange({ period, label: periodLabel(measure.label, period), ...(period ? { quick: undefined } : {}) });
        }}
      >
        <option value="">The dates chosen</option>
        {TIME_PERIODS.map((entry) => (
          <option key={entry.value} value={entry.value}>
            {entry.label}
          </option>
        ))}
      </select>
    </label>
  );
}
